-- Rollback of 20261018180000_customers_wholesale.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Refuses while any customer or wholesale price exists on the server.
-- Restores cl_catalogue_push (20261006120000), cl_catalogue_pull
-- (20261009120000) and the business delete guard (20261018120000).

begin;

do $$
begin
  if exists (select 1 from public.cl_customers) or exists (select 1 from public.cl_catalogue_products where wholesale_price is not null) then
    raise exception 'customers_wholesale rollback aborted: customers or wholesale prices exist. Nothing was changed.';
  end if;
end $$;

drop function if exists public.cl_device_customers_pull(text, text, text, bigint);
drop function if exists public.cl_device_customer_save(text, text, text, jsonb);
drop function if exists public.cl_customer_json(public.cl_customers);
drop function if exists public.cl_customer_till(text, text, text);
drop table if exists public.cl_customers;
drop sequence if exists public.cl_customers_seq;
drop function if exists public.cl_norm_phone(text);

create or replace function public.cl_catalogue_push(p_install_id text, p_secret_phrase text, p_device_key text, p_rows jsonb)
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
    'price_mode', br.price_mode, 'price_mode_seq', br.price_mode_seq, 'branch_id', br.id, 'is_main', caller_main,
    'business_day_cutoff', br.business_day_cutoff);
end $fn$;

alter table public.cl_catalogue_products drop column wholesale_price;

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
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

revoke execute on function public.cl_catalogue_push(text, text, text, jsonb), public.cl_catalogue_pull(text, text, text, bigint, integer) from public;
grant execute on function public.cl_catalogue_push(text, text, text, jsonb), public.cl_catalogue_pull(text, text, text, bigint, integer) to anon, authenticated;

commit;
