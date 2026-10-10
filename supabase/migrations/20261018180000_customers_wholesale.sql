-- =====================================================================
-- POS fixes: one customer list per business, and wholesale prices through
-- the catalogue (owner: "go POS-fixes-B", 2026-10-10, with the Stage A
-- recommendations accepted). Applied live only after the owner has seen
-- this file and said "apply". Comes before 20261019120000_trial_rules.
-- Design: docs/pos/pos-fixes-design.md §2.3 and §3.2
-- Rollback: supabase/rollbacks/20261018180000_customers_wholesale.rollback.sql
-- Tested in PGlite: supabase/tests/customers-wholesale-test.js
--
-- 1. cl_norm_phone: one phone number, one spelling (07x / +2637x / 2637x /
--    002637x are the same Zimbabwe mobile; other countries need +country).
--    The app's normPhone (src/utils.js) is the same rule.
-- 2. cl_customers: ONE list per business, kept by any till of the business
--    (the app's customers.uid is the key). A phone number is unique within
--    the business; a second customer with the same phone is refused with the
--    existing one, so the till can take that record instead. Type (retail |
--    wholesale), credit limit, address and national ID travel with it. The
--    national ID is readable only by the business's own tills through
--    cl_device_customers_pull: no Console function returns it.
-- 3. Device RPCs (install ID + phrase + device key): cl_device_customer_save,
--    cl_device_customers_pull (rows changed since a cursor).
-- 4. Catalogue: cl_catalogue_products.wholesale_price (null = retail applies).
--    cl_catalogue_push stores it (a row WITHOUT the key keeps the stored
--    value, so an older till never clears it; an explicit null clears it);
--    cl_catalogue_pull returns it. The changes to both bodies are marked
--    "POS fixes (20261018180000)"; everything else is as before.
-- 5. The business delete guard also counts customers.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_customers' n where to_regclass('public.cl_customers') is not null
    union all select 'function cl_norm_phone' where to_regprocedure('public.cl_norm_phone(text)') is not null
    union all select 'column cl_catalogue_products.wholesale_price' where exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cl_catalogue_products' and column_name = 'wholesale_price')
  ) x;
  if conflicts is not null then raise exception 'customers_wholesale aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'table cl_suppliers (20261018120000)' n where to_regclass('public.cl_suppliers') is null
    union all select 'function ' || f from unnest(array['public.cl_catalogue_caller(text,text,text)',
        'public.cl_catalogue_push(text,text,text,jsonb)', 'public.cl_catalogue_pull(text,text,text,bigint,integer)',
        'public.cl_install_vendor(text,text,text,boolean,text,text)']) f
      where to_regprocedure(f) is null
  ) x;
  if missing is not null then raise exception 'customers_wholesale aborted: missing %. Nothing was changed.', missing; end if;
end $$;


-- 1. Phone numbers ----------------------------------------------------------
-- Digits only, country code first, no "+": 263771234567. Null = not a phone
-- number we accept. Zimbabwe mobiles (071, 073, 077, 078) in any common
-- spelling; another country only with its code typed (+ or 00).
create function public.cl_norm_phone(p text) returns text
language plpgsql immutable as $fn$
declare raw text := btrim(coalesce(p, '')); d text; intl boolean;
begin
  if raw = '' or raw ~ '[^0-9+() .\-]' then return null; end if;
  intl := raw ~ '^(\+|00)';
  d := regexp_replace(raw, '[^0-9]', '', 'g');
  if raw ~ '^00' then d := substr(d, 3); end if;
  if not intl then
    if d ~ '^0[0-9]{9}$' then d := '263' || substr(d, 2);
    elsif d ~ '^7[0-9]{8}$' then d := '263' || d;
    elsif d !~ '^263[0-9]{9}$' then return null;
    end if;
  end if;
  if d ~ '^263' then return case when d ~ '^2637[1378][0-9]{7}$' then d end; end if;
  return case when d ~ '^[1-9][0-9]{7,14}$' then d end;
end $fn$;


-- 2. The customer list ----------------------------------------------------------
create sequence public.cl_customers_seq;
create table public.cl_customers (
  business_id   uuid not null references public.cl_businesses(id) on delete restrict,
  customer_uid  text not null check (customer_uid ~ '^[A-Za-z0-9-]{8,64}$'),
  name          text not null check (length(btrim(name)) between 1 and 80),
  phone         text not null check (length(phone) <= 40),
  phone_norm    text not null,
  customer_type text not null default 'retail' check (customer_type in ('retail', 'wholesale')),
  credit_limit  numeric(14,2) check (credit_limit is null or (credit_limit >= 0 and credit_limit <= 1000000000)),
  address       text check (address is null or length(address) <= 200),
  national_id   text check (national_id is null or length(national_id) <= 40),
  active        boolean not null default true,
  change_seq    bigint not null,
  created_terminal uuid references public.cl_terminals(id) on delete set null,
  updated_terminal uuid references public.cl_terminals(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (business_id, customer_uid)
);
create unique index cl_customers_phone_uidx on public.cl_customers (business_id, phone_norm);
create index cl_customers_seq_idx on public.cl_customers (business_id, change_seq);
comment on table public.cl_customers is 'POS fixes (20261018180000): one customer list per business, kept by its tills. national_id is returned only to the business''s own tills (cl_device_customers_pull), never to the Console.';

-- The till calling (any active till of a business).
create function public.cl_customer_till(p_install_id text, p_secret_phrase text, p_device_key text) returns public.cl_terminals
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; me cl_terminals%rowtype;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  select * into me from cl_terminals where vendor_id = v.id;
  if not found then raise exception 'This device is not a registered till' using errcode = 'P0001'; end if;
  return me;
end $fn$;

create function public.cl_customer_json(c public.cl_customers) returns jsonb
language sql immutable as $$
  select jsonb_build_object('uid', c.customer_uid, 'name', c.name, 'phone', c.phone, 'phone_norm', c.phone_norm,
    'customer_type', c.customer_type, 'credit_limit', c.credit_limit, 'address', c.address, 'national_id', c.national_id,
    'active', c.active, 'seq', c.change_seq, 'updated_at', c.updated_at)
$$;

-- Add or update one customer. p_customer: { uid, name, phone, customer_type,
-- credit_limit (null = none), address, national_id, active }.
-- {ok, customer} | {ok:false, error:'DUPLICATE_PHONE', existing:{...}} | {error:'TERMINAL_INACTIVE'}
create function public.cl_device_customer_save(p_install_id text, p_secret_phrase text, p_device_key text, p_customer jsonb) returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; cur cl_customers%rowtype; dup cl_customers%rowtype; c cl_customers%rowtype;
        v_uid text := btrim(coalesce(p_customer->>'uid', '')); v_name text := btrim(coalesce(p_customer->>'name', ''));
        v_phone text := btrim(coalesce(p_customer->>'phone', '')); v_norm text; v_type text := coalesce(nullif(p_customer->>'customer_type', ''), 'retail');
        v_limit numeric;
begin
  me := cl_customer_till(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  perform 1 from cl_businesses where id = me.business_id for update;      -- one save at a time per business: phones stay unique, seq ordered
  if v_uid !~ '^[A-Za-z0-9-]{8,64}$' then raise exception 'A customer needs its uid' using errcode = 'P0001'; end if;
  if v_name = '' then raise exception 'A customer needs a name' using errcode = 'P0001'; end if;
  v_norm := cl_norm_phone(v_phone);
  if v_norm is null then raise exception 'A customer needs a valid phone number (e.g. 07x xxx xxxx)' using errcode = 'P0001'; end if;
  if v_type not in ('retail', 'wholesale') then raise exception 'Customer type is retail or wholesale' using errcode = 'P0001'; end if;
  v_limit := nullif(p_customer->>'credit_limit', '')::numeric;
  select * into dup from cl_customers where business_id = me.business_id and phone_norm = v_norm and customer_uid <> v_uid;
  if found then
    return json_build_object('ok', false, 'error', 'DUPLICATE_PHONE',
      'message', 'A customer with this phone already exists: ' || dup.name || '.', 'existing', cl_customer_json(dup));
  end if;
  select * into cur from cl_customers where business_id = me.business_id and customer_uid = v_uid for update;
  insert into cl_customers as x (business_id, customer_uid, name, phone, phone_norm, customer_type, credit_limit, address, national_id,
                                 active, change_seq, created_terminal, updated_terminal)
  values (me.business_id, v_uid, v_name, v_phone, v_norm, v_type, v_limit, nullif(btrim(coalesce(p_customer->>'address', '')), ''),
          nullif(btrim(coalesce(p_customer->>'national_id', '')), ''), coalesce((p_customer->>'active')::boolean, true),
          nextval('cl_customers_seq'), me.id, me.id)
  on conflict (business_id, customer_uid) do update set
    name = excluded.name, phone = excluded.phone, phone_norm = excluded.phone_norm, customer_type = excluded.customer_type,
    credit_limit = excluded.credit_limit, address = excluded.address, national_id = excluded.national_id, active = excluded.active,
    change_seq = excluded.change_seq, updated_terminal = excluded.updated_terminal, updated_at = now()
  returning * into c;
  return json_build_object('ok', true, 'customer', cl_customer_json(c), 'created', cur.customer_uid is null);
end $fn$;

-- Customers changed since p_cursor (500 at a time).
create function public.cl_device_customers_pull(p_install_id text, p_secret_phrase text, p_device_key text, p_cursor bigint default 0) returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; rows jsonb; nxt bigint;
begin
  me := cl_customer_till(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  select coalesce(jsonb_agg(cl_customer_json(c) order by c.change_seq), '[]'::jsonb), coalesce(max(c.change_seq), greatest(coalesce(p_cursor, 0), 0))
    into rows, nxt
    from (select * from cl_customers where business_id = me.business_id and change_seq > greatest(coalesce(p_cursor, 0), 0)
          order by change_seq limit 500) c;
  return json_build_object('customers', rows, 'cursor', nxt,
    'more', exists (select 1 from cl_customers where business_id = me.business_id and change_seq > nxt));
end $fn$;


-- 3. Wholesale prices in the catalogue -------------------------------------------
alter table public.cl_catalogue_products add column wholesale_price numeric(14,2)
  check (wholesale_price is null or (wholesale_price >= 0 and wholesale_price <= 1000000000));

create or replace function public.cl_catalogue_push(p_install_id text, p_secret_phrase text, p_device_key text, p_rows jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; r jsonb; cur cl_catalogue_products%rowtype; had boolean;
        out_rows jsonb := '[]'::jsonb; s bigint; v_uid text; v_op text; v_code text; v_name text; v_active boolean;
        v_hash text; v_img text; v_price numeric; v_cost numeric; v_low integer; v_base bigint; v_bytes integer;
        v_wholesale numeric;   -- POS fixes (20261018180000)
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
      -- POS fixes (20261018180000): no key = keep what's stored; null = none
      v_wholesale := case when r ? 'wholesale_price' then (r->>'wholesale_price')::numeric else cur.wholesale_price end;
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
                                              low_threshold, active, image_hash, image_bytes, change_seq, last_op_id, updated_by, updated_ts,
                                              wholesale_price)   -- POS fixes (20261018180000)
      values (me.business_id, v_uid, v_code, v_name, coalesce(r->>'description', ''), coalesce(r->>'category', ''),
              coalesce(r->>'shelf', ''), v_price, v_cost, v_low, v_active, v_hash, v_bytes, s, v_op, me.id, now(),
              v_wholesale)   -- POS fixes (20261018180000)
      on conflict (business_id, product_uid) do update set
        code = excluded.code, name = excluded.name, description = excluded.description, category = excluded.category,
        shelf = excluded.shelf, price = excluded.price, cost = excluded.cost, low_threshold = excluded.low_threshold,
        active = excluded.active, image_hash = excluded.image_hash, image_bytes = excluded.image_bytes,
        change_seq = excluded.change_seq, last_op_id = excluded.last_op_id, updated_by = excluded.updated_by, updated_ts = now(),
        wholesale_price = excluded.wholesale_price;   -- POS fixes (20261018180000)
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

create or replace function public.cl_catalogue_pull(p_install_id text, p_secret_phrase text, p_device_key text,
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
            'active', c.active, 'image_hash', c.image_hash, 'image_bytes', c.image_bytes, 'seq', c.change_seq,
            'wholesale_price', c.wholesale_price) order by c.change_seq), '[]'::json)   -- POS fixes (20261018180000)
            from cl_catalogue_products c join page p on p.kind = 'p' and p.product_uid = c.product_uid
           where c.business_id = me.business_id),
         (select coalesce(json_agg(json_build_object('uid', bp.product_uid, 'price', bp.price, 'seq', bp.change_seq) order by bp.change_seq), '[]'::json)
            from cl_branch_prices bp join page p on p.kind = 'b' and p.product_uid = bp.product_uid
           where bp.branch_id = me.branch_id)
    into nxt, prods, prices;
  more := exists (select 1 from cl_catalogue_products where business_id = me.business_id and change_seq > nxt)
       or exists (select 1 from cl_branch_prices where branch_id = me.branch_id and change_seq > nxt);

  return json_build_object('products', prods, 'prices', prices, 'cursor', nxt, 'more', more,
    'price_mode', br.price_mode, 'price_mode_seq', br.price_mode_seq, 'branch_id', br.id, 'is_main', caller_main,
    'business_day_cutoff', br.business_day_cutoff);
end $fn$;


-- 4. The business delete guard also counts customers ------------------------------
create or replace function public.cl_business_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare parts text[] := '{}'; n integer;
begin
  select count(*) into n from cl_branches where business_id = old.id;
  if n > 0 then parts := parts || (n || ' branch' || case when n = 1 then '' else 'es' end); end if;
  select count(*) into n from cl_terminals where business_id = old.id;
  if n > 0 then parts := parts || (n || ' till' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_licences where business_id = old.id;
  if n > 0 then parts := parts || (n || ' licence' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_plan_assignments where business_id = old.id;
  if n > 0 then parts := parts || (n || ' price-plan setting' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_catalogue_products where business_id = old.id;
  if n > 0 then parts := parts || (n || ' catalogue product' || case when n = 1 then '' else 's' end); end if;
  -- RPN commissions (20261015120000)
  select count(*) into n from cl_rpn_commissions where business_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN commission line' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_rpn_assignments where business_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN history entr' || case when n = 1 then 'y' else 'ies' end); end if;
  -- Market publishing (20261016120000)
  select count(*) into n from cl_market_packs where business_id = old.id;
  if n > 0 then parts := parts || (n || ' market pack' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_token_purchases where business_id = old.id;
  if n > 0 then parts := parts || (n || ' token purchase' || case when n = 1 then '' else 's' end); end if;
  -- Dispatch & GRV (20261017120000)
  select count(*) into n from cl_dispatches where business_id = old.id;
  if n > 0 then parts := parts || (n || ' dispatch' || case when n = 1 then '' else 'es' end); end if;
  -- Suppliers (20261018120000)
  select count(*) into n from cl_suppliers where business_id = old.id;
  if n > 0 then parts := parts || (n || ' supplier' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_supplier_grvs where business_id = old.id;
  if n > 0 then parts := parts || (n || ' supplier GRV' || case when n = 1 then '' else 's' end); end if;
  -- Customers (20261018180000)
  select count(*) into n from cl_customers where business_id = old.id;
  if n > 0 then parts := parts || (n || ' customer' || case when n = 1 then '' else 's' end); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;


-- 5. Who may call what ----------------------------------------------------------
alter table public.cl_customers enable row level security;
revoke all on table public.cl_customers from public, anon, authenticated;
revoke all on sequence public.cl_customers_seq from public, anon, authenticated;
revoke all on function public.cl_norm_phone(text), public.cl_customer_till(text, text, text), public.cl_customer_json(public.cl_customers)
  from public, anon, authenticated;
revoke all on function public.cl_device_customer_save(text, text, text, jsonb), public.cl_device_customers_pull(text, text, text, bigint) from public;
grant execute on function public.cl_device_customer_save(text, text, text, jsonb), public.cl_device_customers_pull(text, text, text, bigint) to anon, authenticated;
revoke execute on function public.cl_catalogue_push(text, text, text, jsonb), public.cl_catalogue_pull(text, text, text, bigint, integer) from public;
grant execute on function public.cl_catalogue_push(text, text, text, jsonb), public.cl_catalogue_pull(text, text, text, bigint, integer) to anon, authenticated;

commit;
