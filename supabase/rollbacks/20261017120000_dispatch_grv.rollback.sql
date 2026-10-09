-- Rollback of 20261017120000_dispatch_grv.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Refuses while any dispatch exists (stock history on the devices points at
-- them). Restores the business delete guard as 20261016120000 made it and
-- removes the rest. The app keeps the file flow throughout.

begin;

do $$
begin
  if exists (select 1 from public.cl_dispatches) then
    raise exception 'dispatch_grv rollback aborted: dispatches exist. Nothing was changed.';
  end if;
end $$;

drop function if exists public.cl_dispatch_detail(uuid);
drop function if exists public.cl_dispatches_list(uuid, text, integer);
drop function if exists public.cl_device_dispatch_lookup(text, text, text, uuid, text, integer);
drop function if exists public.cl_device_dispatch_resolve(text, text, text, uuid, text, text, text, text);
drop function if exists public.cl_device_dispatch_cancel(text, text, text, uuid, text, text);
drop function if exists public.cl_device_grv_post(text, text, text, uuid, jsonb);
drop function if exists public.cl_device_dispatch_pull(text, text, text);
drop function if exists public.cl_device_dispatch_send(text, text, text, jsonb);
drop function if exists public.cl_dispatch_log_add(uuid, uuid, text, text, jsonb);
drop function if exists public.cl_dispatch_json(uuid);
drop function if exists public.cl_dispatch_name(text, integer);
drop function if exists public.cl_dispatch_caller(text, text, text);

drop table if exists public.cl_dispatch_log;
drop table if exists public.cl_interbranch_charges;
alter table if exists public.cl_dispatches drop constraint if exists cl_dispatches_replaces_issue_fk;
drop table if exists public.cl_dispatch_issues;
drop table if exists public.cl_dispatch_lines;
drop table if exists public.cl_dispatches;

delete from public.cl_staff_module_access where module_id in (select id from public.cl_modules where key = 'dispatches');
delete from public.cl_modules where key = 'dispatches';

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
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

commit;
