-- Rollback of 20261018120000_supplier_grv.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Refuses while any supplier GRV exists (stock history on the tills points
-- at them). Restores the business delete guard as 20261017120000 made it.

begin;

do $$
begin
  if exists (select 1 from public.cl_supplier_grvs) then
    raise exception 'supplier_grv rollback aborted: supplier GRVs exist. Nothing was changed.';
  end if;
end $$;

drop function if exists public.cl_supplier_grvs_list(uuid, integer);
drop function if exists public.cl_device_supplier_grv_post(text, text, text, jsonb);
drop function if exists public.cl_device_supplier_invoice_check(text, text, text, uuid, text);
drop function if exists public.cl_device_supplier_save(text, text, text, jsonb);
drop function if exists public.cl_device_suppliers_pull(text, text, text);
drop function if exists public.cl_supplier_till(text, text, text);
drop function if exists public.cl_supplier_grv_json(uuid);
drop function if exists public.cl_supplier_json(public.cl_suppliers);
drop table if exists public.cl_supplier_grv_lines;
drop table if exists public.cl_supplier_grvs;
drop table if exists public.cl_suppliers;
drop function if exists public.cl_invoice_key(text);

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
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

commit;
