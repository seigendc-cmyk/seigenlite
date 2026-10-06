-- =====================================================================
-- Multi-terminal sync, Phase 3a: product catalogue sync (main -> every till).
-- Design: docs/multi-terminal/phase3a-design.md (approved 2026-10-06).
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261006120000_catalogue_sync.rollback.sql
-- Tested in PGlite: supabase/tests/catalogue-sync-test.js
--
-- Adds:
--   * cl_catalogue_products: a business's catalogue, keyed by main's product
--     uid, carrying the shared product code. Soft delete only (active).
--   * cl_catalogue_images: one thumbnail per product (data URI), pulled
--     separately and lazily by the tills.
--   * cl_branch_prices: a price for one product at one branch (branch uuid).
--     price null = removed (main's price applies again).
--   * cl_branches.price_mode (+ price_mode_seq): follow_main | main_sets |
--     branch_edits, as the app's price policy.
--   * cl_catalogue_seq: one server sequence orders every change; it is the
--     tills' pull cursor. Every write takes the business row lock first, so
--     within a business changes commit in sequence order and a pull can never
--     skip one.
--   * RPCs (phrase + install + device key, refuse an inactive till):
--     cl_catalogue_push, cl_branch_price_push, cl_branch_set_price_mode,
--     cl_catalogue_pull, cl_catalogue_images_pull.
-- Nothing existing is changed except the two added cl_branches columns.
-- RLS on every new table; no table grants to anon/authenticated.
-- Apply by hand in one transaction (no migrations table).
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'table cl_businesses' n where to_regclass('public.cl_businesses') is null
    union all select 'table cl_branches' where to_regclass('public.cl_branches') is null
    union all select 'table cl_terminals' where to_regclass('public.cl_terminals') is null
    union all select 'function cl_install_vendor' where to_regprocedure('public.cl_install_vendor(text,text,text,boolean,text,text)') is null
    union all select 'function cl_terminal_set_active (Phase 2)' where to_regprocedure('public.cl_terminal_set_active(text,text,text,uuid,boolean)') is null
    union all select 'function extensions.digest' where to_regprocedure('extensions.digest(text,text)') is null
  ) x;
  if missing is not null then raise exception 'catalogue_sync aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_catalogue_products' n where to_regclass('public.cl_catalogue_products') is not null
    union all select 'table cl_catalogue_images' where to_regclass('public.cl_catalogue_images') is not null
    union all select 'table cl_branch_prices' where to_regclass('public.cl_branch_prices') is not null
    union all select 'sequence cl_catalogue_seq' where to_regclass('public.cl_catalogue_seq') is not null
    union all select 'column cl_branches.price_mode' where exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cl_branches' and column_name in ('price_mode', 'price_mode_seq'))
    union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cl_catalogue_caller', 'cl_catalogue_push', 'cl_branch_price_push', 'cl_branch_set_price_mode',
                      'cl_catalogue_pull', 'cl_catalogue_images_pull')
  ) x;
  if conflicts is not null then raise exception 'catalogue_sync aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;


-- 1. Tables -------------------------------------------------------------
create sequence public.cl_catalogue_seq;

create table public.cl_catalogue_products (
  business_id   uuid not null references public.cl_businesses(id),
  product_uid   text not null check (product_uid ~ '^[0-9a-f]{32}$'),
  code          text not null default '' check (length(code) <= 64),
  name          text not null check (length(btrim(name)) between 1 and 200),
  description   text not null default '' check (length(description) <= 2000),
  category      text not null default '' check (length(category) <= 100),
  shelf         text not null default '' check (length(shelf) <= 100),
  price         numeric(14,2) not null check (price >= 0 and price <= 1000000000),
  cost          numeric(14,2) not null default 0 check (cost >= 0 and cost <= 1000000000),
  low_threshold integer not null default 5 check (low_threshold between 0 and 1000000),
  active        boolean not null default true,
  image_hash    text check (image_hash is null or image_hash ~ '^[0-9a-f]{64}$'),
  image_bytes   integer not null default 0,
  change_seq    bigint not null,
  last_op_id    text not null,
  updated_by    uuid references public.cl_terminals(id),
  updated_ts    timestamptz not null default now(),
  primary key (business_id, product_uid)
);
-- One ACTIVE product per code per business, compared like the app's catCode()
-- (src/catalogue.js: trimmed, lower case). Uncoded products are allowed.
create unique index cl_catalogue_code_uidx on public.cl_catalogue_products (business_id, lower(btrim(code)))
  where active and btrim(code) <> '';
create index cl_catalogue_seq_idx on public.cl_catalogue_products (business_id, change_seq);

create table public.cl_catalogue_images (
  business_id uuid not null,
  product_uid text not null,
  image_hash  text not null check (image_hash ~ '^[0-9a-f]{64}$'),
  data        text not null check (data like 'data:image/%' and length(data) <= 120000),
  primary key (business_id, product_uid),
  foreign key (business_id, product_uid) references public.cl_catalogue_products (business_id, product_uid)
);

create table public.cl_branch_prices (
  business_id uuid not null,
  branch_id   uuid not null references public.cl_branches(id),
  product_uid text not null,
  price       numeric(14,2) check (price is null or (price >= 0 and price <= 1000000000)),
  change_seq  bigint not null,
  last_op_id  text not null,
  updated_by  uuid references public.cl_terminals(id),
  updated_ts  timestamptz not null default now(),
  primary key (branch_id, product_uid),
  foreign key (business_id, product_uid) references public.cl_catalogue_products (business_id, product_uid)
);
create index cl_branch_prices_seq_idx on public.cl_branch_prices (branch_id, change_seq);

alter table public.cl_branches add column price_mode text not null default 'follow_main'
  check (price_mode in ('follow_main', 'main_sets', 'branch_edits'));
alter table public.cl_branches add column price_mode_seq bigint not null default 0;

do $$
declare t text;
begin
  foreach t in array array['cl_catalogue_products', 'cl_catalogue_images', 'cl_branch_prices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.cl_catalogue_seq from public, anon, authenticated;


-- 2. The caller: which till is this (not callable by devices) -------------
create function public.cl_catalogue_caller(p_install_id text, p_secret_phrase text, p_device_key text)
returns public.cl_terminals
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; me cl_terminals%rowtype;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  select * into me from cl_terminals where vendor_id = v.id;
  if not found then raise exception 'This device is not a registered till' using errcode = 'P0001'; end if;
  return me;
end $fn$;
revoke execute on function public.cl_catalogue_caller(text, text, text) from public, anon, authenticated;


-- 3. Push catalogue (main-branch tills only) ------------------------------
-- p_rows: [{ uid, op_id, code, name, description, category, shelf, price, cost,
--            low_threshold, active, image_hash, image?, base_seq? }], at most 100.
-- Per row: applied | duplicate (replay of the same op_id) | refused (reason).
-- The last change to reach the server wins; overwrote=true when the row had
-- changed since the till last saw it (base_seq) by another till.
create function public.cl_catalogue_push(p_install_id text, p_secret_phrase text, p_device_key text, p_rows jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; r jsonb; cur cl_catalogue_products%rowtype; had boolean;
        out_rows jsonb := '[]'::jsonb; s bigint; v_uid text; v_op text; v_code text; v_name text; v_active boolean;
        v_hash text; v_img text; v_price numeric; v_cost numeric; v_low integer; v_base bigint; v_bytes integer;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  if not (select is_main from cl_branches where id = me.branch_id) then return json_build_object('error', 'NOT_MAIN'); end if;
  if (case when jsonb_typeof(p_rows) = 'array' then jsonb_array_length(p_rows) not between 1 and 100 else true end) then
    raise exception 'Send between 1 and 100 products at a time' using errcode = 'P0001';
  end if;
  perform 1 from cl_businesses where id = me.business_id for update;            -- orders change_seq within the business

  for r in select value from jsonb_array_elements(p_rows) loop
    v_uid := r->>'uid'; v_op := r->>'op_id';
    begin
      if v_uid is null or v_uid !~ '^[0-9a-f]{32}$' or v_op is null or v_op !~ '^[0-9a-f]{32}$' then
        out_rows := out_rows || jsonb_build_object('uid', v_uid, 'status', 'refused', 'reason', 'BAD_ROW'); continue;
      end if;
      select * into cur from cl_catalogue_products where business_id = me.business_id and product_uid = v_uid for update;
      had := found;
      if had and cur.last_op_id = v_op then
        out_rows := out_rows || jsonb_build_object('uid', v_uid, 'status', 'duplicate', 'seq', cur.change_seq); continue;
      end if;
      v_code := btrim(coalesce(r->>'code', '')); v_name := btrim(coalesce(r->>'name', ''));
      v_active := coalesce((r->>'active')::boolean, true);
      v_price := (r->>'price')::numeric; v_cost := coalesce((r->>'cost')::numeric, 0);
      v_low := coalesce((r->>'low_threshold')::integer, 5);
      v_hash := nullif(r->>'image_hash', ''); v_img := r->>'image'; v_base := (r->>'base_seq')::bigint;
      if v_name = '' or v_price is null then
        out_rows := out_rows || jsonb_build_object('uid', v_uid, 'status', 'refused', 'reason', 'BAD_ROW'); continue;
      end if;
      if v_active and v_code <> '' and exists (select 1 from cl_catalogue_products
          where business_id = me.business_id and active and lower(btrim(code)) = lower(v_code) and product_uid <> v_uid) then
        out_rows := out_rows || jsonb_build_object('uid', v_uid, 'status', 'refused', 'reason', 'DUPLICATE_CODE'); continue;
      end if;
      -- picture: the till sends the data only when the server may not have it
      if v_hash is not null and v_img is not null then
        if encode(extensions.digest(v_img, 'sha256'), 'hex') <> v_hash then
          out_rows := out_rows || jsonb_build_object('uid', v_uid, 'status', 'refused', 'reason', 'BAD_IMAGE'); continue;
        end if;
      elsif v_hash is not null and not exists (select 1 from cl_catalogue_images
          where business_id = me.business_id and product_uid = v_uid and image_hash = v_hash) then
        out_rows := out_rows || jsonb_build_object('uid', v_uid, 'status', 'refused', 'reason', 'NEED_IMAGE'); continue;
      end if;
      v_bytes := case when v_hash is null then 0 when v_img is not null then length(v_img) else coalesce(cur.image_bytes, 0) end;

      s := nextval('cl_catalogue_seq');
      insert into cl_catalogue_products as c (business_id, product_uid, code, name, description, category, shelf, price, cost,
                                              low_threshold, active, image_hash, image_bytes, change_seq, last_op_id, updated_by, updated_ts)
      values (me.business_id, v_uid, v_code, v_name, coalesce(r->>'description', ''), coalesce(r->>'category', ''),
              coalesce(r->>'shelf', ''), v_price, v_cost, v_low, v_active, v_hash, v_bytes, s, v_op, me.id, now())
      on conflict (business_id, product_uid) do update set
        code = excluded.code, name = excluded.name, description = excluded.description, category = excluded.category,
        shelf = excluded.shelf, price = excluded.price, cost = excluded.cost, low_threshold = excluded.low_threshold,
        active = excluded.active, image_hash = excluded.image_hash, image_bytes = excluded.image_bytes,
        change_seq = excluded.change_seq, last_op_id = excluded.last_op_id, updated_by = excluded.updated_by, updated_ts = now();
      if v_hash is null then
        delete from cl_catalogue_images where business_id = me.business_id and product_uid = v_uid;
      elsif v_img is not null then
        insert into cl_catalogue_images (business_id, product_uid, image_hash, data) values (me.business_id, v_uid, v_hash, v_img)
        on conflict (business_id, product_uid) do update set image_hash = excluded.image_hash, data = excluded.data;
      end if;
      out_rows := out_rows || jsonb_build_object('uid', v_uid, 'status', 'applied', 'seq', s,
        'overwrote', had and v_base is not null and cur.change_seq > v_base and cur.updated_by is distinct from me.id);
    exception when others then
      out_rows := out_rows || jsonb_build_object('uid', v_uid, 'status', 'refused', 'reason', 'BAD_ROW', 'message', left(sqlerrm, 120));
    end;
  end loop;
  return json_build_object('results', out_rows);
end $fn$;


-- 4. Push branch prices ----------------------------------------------------
-- Main-branch tills: any branch of the business. Any other till: only its own
-- branch, and only while that branch's policy is branch_edits (the Admin
-- passcode is checked on the till, which the server can't see).
-- p_rows: [{ branch_id, product_uid, price (number | null = removed), op_id }], at most 200.
create function public.cl_branch_price_push(p_install_id text, p_secret_phrase text, p_device_key text, p_rows jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; caller_main boolean; r jsonb; out_rows jsonb := '[]'::jsonb; b cl_branches%rowtype;
        cur cl_branch_prices%rowtype; s bigint; v_uid text; v_op text; v_branch uuid; v_price numeric;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  caller_main := (select is_main from cl_branches where id = me.branch_id);
  if (case when jsonb_typeof(p_rows) = 'array' then jsonb_array_length(p_rows) not between 1 and 200 else true end) then
    raise exception 'Send between 1 and 200 prices at a time' using errcode = 'P0001';
  end if;
  perform 1 from cl_businesses where id = me.business_id for update;

  for r in select value from jsonb_array_elements(p_rows) loop
    v_uid := r->>'product_uid'; v_op := r->>'op_id';
    begin
      v_branch := (r->>'branch_id')::uuid;
      v_price := case when r->'price' is null or jsonb_typeof(r->'price') = 'null' then null else (r->>'price')::numeric end;
      if v_uid is null or v_op is null or v_op !~ '^[0-9a-f]{32}$' then
        out_rows := out_rows || jsonb_build_object('product_uid', v_uid, 'branch_id', v_branch, 'status', 'refused', 'reason', 'BAD_ROW'); continue;
      end if;
      select * into b from cl_branches where id = v_branch and business_id = me.business_id;
      if not found then
        out_rows := out_rows || jsonb_build_object('product_uid', v_uid, 'branch_id', v_branch, 'status', 'refused', 'reason', 'UNKNOWN_BRANCH'); continue;
      end if;
      if not caller_main and (b.id <> me.branch_id or b.price_mode <> 'branch_edits') then
        out_rows := out_rows || jsonb_build_object('product_uid', v_uid, 'branch_id', v_branch, 'status', 'refused', 'reason', 'NOT_ALLOWED'); continue;
      end if;
      if not exists (select 1 from cl_catalogue_products where business_id = me.business_id and product_uid = v_uid) then
        out_rows := out_rows || jsonb_build_object('product_uid', v_uid, 'branch_id', v_branch, 'status', 'refused', 'reason', 'UNKNOWN_PRODUCT'); continue;
      end if;
      select * into cur from cl_branch_prices where branch_id = v_branch and product_uid = v_uid for update;
      if found and cur.last_op_id = v_op then
        out_rows := out_rows || jsonb_build_object('product_uid', v_uid, 'branch_id', v_branch, 'status', 'duplicate', 'seq', cur.change_seq); continue;
      end if;
      s := nextval('cl_catalogue_seq');
      insert into cl_branch_prices (business_id, branch_id, product_uid, price, change_seq, last_op_id, updated_by, updated_ts)
      values (me.business_id, v_branch, v_uid, v_price, s, v_op, me.id, now())
      on conflict (branch_id, product_uid) do update set price = excluded.price, change_seq = excluded.change_seq,
        last_op_id = excluded.last_op_id, updated_by = excluded.updated_by, updated_ts = now();
      out_rows := out_rows || jsonb_build_object('product_uid', v_uid, 'branch_id', v_branch, 'status', 'applied', 'seq', s);
    exception when others then
      out_rows := out_rows || jsonb_build_object('product_uid', v_uid, 'branch_id', v_branch, 'status', 'refused', 'reason', 'BAD_ROW', 'message', left(sqlerrm, 120));
    end;
  end loop;
  return json_build_object('results', out_rows);
end $fn$;


-- 5. A branch's price policy (main-branch tills only) -----------------------
create function public.cl_branch_set_price_mode(p_install_id text, p_secret_phrase text, p_device_key text,
                                                p_branch_id uuid, p_mode text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; s bigint;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  if not (select is_main from cl_branches where id = me.branch_id) then return json_build_object('error', 'NOT_MAIN'); end if;
  if p_mode is null or p_mode not in ('follow_main', 'main_sets', 'branch_edits') then
    raise exception 'Unknown price policy' using errcode = 'P0001';
  end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  if not exists (select 1 from cl_branches where id = p_branch_id and business_id = me.business_id) then
    return json_build_object('error', 'UNKNOWN_BRANCH');
  end if;
  if (select price_mode from cl_branches where id = p_branch_id) = p_mode then
    return json_build_object('branch_id', p_branch_id, 'price_mode', p_mode, 'unchanged', true);
  end if;
  s := nextval('cl_catalogue_seq');
  update cl_branches set price_mode = p_mode, price_mode_seq = s where id = p_branch_id;
  return json_build_object('branch_id', p_branch_id, 'price_mode', p_mode, 'seq', s);
end $fn$;


-- 6. Pull: catalogue + this branch's prices changed since a cursor ---------
-- One cursor (cl_catalogue_seq) covers products and this branch's prices.
-- cost only for main-branch tills. Pictures are pulled separately (7).
create function public.cl_catalogue_pull(p_install_id text, p_secret_phrase text, p_device_key text,
                                         p_cursor bigint, p_limit integer default 500)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; caller_main boolean; lim integer; cur0 bigint; nxt bigint; more boolean;
        prods json; prices json; br cl_branches%rowtype;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  select * into br from cl_branches where id = me.branch_id;
  caller_main := br.is_main;
  lim := least(greatest(coalesce(p_limit, 500), 1), 500);
  cur0 := greatest(coalesce(p_cursor, 0), 0);

  with page as (
    select * from (
      select change_seq as seq, 'p' as kind, product_uid from cl_catalogue_products where business_id = me.business_id and change_seq > cur0
      union all
      select change_seq, 'b', product_uid from cl_branch_prices where branch_id = me.branch_id and change_seq > cur0
    ) x order by seq limit lim
  )
  select coalesce((select max(seq) from page), cur0),
         (select coalesce(json_agg(json_build_object(
            'uid', c.product_uid, 'code', c.code, 'name', c.name, 'description', c.description, 'category', c.category,
            'shelf', c.shelf, 'price', c.price, 'cost', case when caller_main then c.cost end, 'low_threshold', c.low_threshold,
            'active', c.active, 'image_hash', c.image_hash, 'image_bytes', c.image_bytes, 'seq', c.change_seq) order by c.change_seq), '[]'::json)
            from cl_catalogue_products c join page p on p.kind = 'p' and p.product_uid = c.product_uid
           where c.business_id = me.business_id),
         (select coalesce(json_agg(json_build_object('uid', bp.product_uid, 'price', bp.price, 'seq', bp.change_seq) order by bp.change_seq), '[]'::json)
            from cl_branch_prices bp join page p on p.kind = 'b' and p.product_uid = bp.product_uid
           where bp.branch_id = me.branch_id)
    into nxt, prods, prices;
  more := exists (select 1 from cl_catalogue_products where business_id = me.business_id and change_seq > nxt)
       or exists (select 1 from cl_branch_prices where branch_id = me.branch_id and change_seq > nxt);

  return json_build_object('products', prods, 'prices', prices, 'cursor', nxt, 'more', more,
    'price_mode', br.price_mode, 'price_mode_seq', br.price_mode_seq, 'branch_id', br.id, 'is_main', caller_main);
end $fn$;


-- 7. Pull pictures (at most 50 per call) ----------------------------------
create function public.cl_catalogue_images_pull(p_install_id text, p_secret_phrase text, p_device_key text, p_uids text[])
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; res json;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  if p_uids is null or cardinality(p_uids) not between 1 and 50 then
    raise exception 'Ask for between 1 and 50 pictures at a time' using errcode = 'P0001';
  end if;
  select coalesce(json_agg(json_build_object('uid', i.product_uid, 'image_hash', i.image_hash, 'data', i.data)), '[]'::json) into res
    from cl_catalogue_images i where i.business_id = me.business_id and i.product_uid = any (p_uids);
  return json_build_object('images', res);
end $fn$;


-- 8. Grants: devices call the RPCs with the anon key, like every other till RPC
revoke execute on function public.cl_catalogue_push(text, text, text, jsonb) from public;
revoke execute on function public.cl_branch_price_push(text, text, text, jsonb) from public;
revoke execute on function public.cl_branch_set_price_mode(text, text, text, uuid, text) from public;
revoke execute on function public.cl_catalogue_pull(text, text, text, bigint, integer) from public;
revoke execute on function public.cl_catalogue_images_pull(text, text, text, text[]) from public;
grant execute on function public.cl_catalogue_push(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.cl_branch_price_push(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.cl_branch_set_price_mode(text, text, text, uuid, text) to anon, authenticated;
grant execute on function public.cl_catalogue_pull(text, text, text, bigint, integer) to anon, authenticated;
grant execute on function public.cl_catalogue_images_pull(text, text, text, text[]) to anon, authenticated;

commit;
