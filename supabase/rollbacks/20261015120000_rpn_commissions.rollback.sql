-- Rollback of 20261015120000_rpn_commissions.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Refuses while commission lines or payouts exist (money history). Field
-- force numbers, PIN hashes, rates and RPN history are dropped; the
-- activity log keeps what was done. Restores the two policies, the two
-- delete guards (as 20261014120000 made them) and the Cashbook source types.

begin;

do $$
begin
  if exists (select 1 from public.cl_rpn_commissions) or exists (select 1 from public.cl_rpn_payouts)
     or exists (select 1 from public.cl_cashbook_entries where source_type in ('rpn_commission_payout', 'rpn_commission_payout_reversal')) then
    raise exception 'rpn_commissions rollback aborted: commission lines or payouts exist. Nothing was changed.';
  end if;
end $$;

drop trigger if exists cl_ledger_entries_rpn_commission on public.cl_ledger_entries;
drop trigger if exists cl_vendors_log_rpn_insert on public.cl_vendors;
drop trigger if exists cl_vendors_log_rpn_update on public.cl_vendors;
drop trigger if exists cl_businesses_log_rpn_update on public.cl_businesses;

drop function if exists public.cl_rpn_commission_lines(uuid, date, date);
drop function if exists public.cl_rpn_commission_summary(date, date);
drop function if exists public.cl_reverse_rpn_payout(uuid, text);
drop function if exists public.cl_pay_rpn_commission(uuid, numeric, text, uuid, text, text);
drop function if exists public.cl_rpn_due(uuid, text);
drop function if exists public.cl_rpn_commission_accrue();
drop function if exists public.cl_rpn_rates_list();
drop function if exists public.cl_rpn_rate_set(numeric, numeric, timestamptz, text);
drop function if exists public.cl_rpn_rate_at(timestamptz);
drop function if exists public.cl_rpn_history(uuid, uuid);
drop function if exists public.cl_rpn_portfolio();
drop function if exists public.cl_resolve_rpn_conflict(bigint, boolean, text);
drop function if exists public.cl_assign_rpn(uuid, uuid, uuid, text);
drop function if exists public.cl_rpn_set_active(uuid, boolean, text);
drop function if exists public.cl_rpn_set_pin(uuid);
drop function if exists public.cl_rpn_set_field_force_no(uuid, text);
drop function if exists public.cl_rpn_reason(text);
drop function if exists public.cl_rpn_staff(text[]);
drop function if exists public.cl_device_rpn_status(text, text, text);
drop function if exists public.cl_device_link_rpn(text, text, text, text, text);
drop function if exists public.cl_rpn_change_context(text, text, text);
drop function if exists public.cl_log_rpn_change();

create or replace function public.cl_vendor_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare parts text[] := '{}'; n integer;
begin
  select count(*) into n from cl_ledger_entries where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' ledger entr' || case when n = 1 then 'y' else 'ies' end); end if;
  select count(*) into n from cl_licences where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' licence' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_activation_codes where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' activation code' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_vendor_messages where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' billing message' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_terminals where vendor_id = old.id or install_id = old.install_id;
  if n > 0 then parts := parts || (n || ' till' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_plan_assignments where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' price-plan setting' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_businesses where created_by_vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' business' || case when n = 1 then '' else 'es' end || ' it created'); end if;
  select count(*) into n from vendors where install_id = old.install_id;
  if n > 0 then parts := parts || ('an iTred Market Place listing account'::text); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead (Console → Vendors → Archive). Nothing was deleted.',
      old.business_name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

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
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

drop table public.cl_rpn_payouts;
drop table public.cl_rpn_commissions;
drop table public.cl_rpn_commission_rates;
drop table public.cl_rpn_assignments;
drop table public.cl_rpn_link_failures;
drop table public.cl_rpn_pins;
drop function if exists public.cl_rpn_of_vendor(uuid);
drop function if exists public.cl_vendor_business(uuid);

alter table public.cl_cashbook_entries drop constraint cl_cashbook_entries_source_type_check;
alter table public.cl_cashbook_entries add constraint cl_cashbook_entries_source_type_check
  check (source_type = any (array['ledger_payment'::text, 'voucher'::text, 'manual'::text, 'ledger_payment_reversal'::text]));

alter table public.cl_businesses drop column rpn_id;
drop index if exists public.cl_rpn_field_force_no_uidx;
alter table public.cl_rpn drop constraint cl_rpn_field_force_no_shape, drop column field_force_no;

delete from public.cl_modules where key in ('rpn_commissions', 'rpn_payouts');

drop policy cl_vendors_select on public.cl_vendors;
create policy cl_vendors_select on public.cl_vendors as permissive for select to public
  using ((((cl_jwt_user_type() = 'rpn'::text) AND (rpn_id = cl_jwt_sub())) OR ((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('vendors'::text)))));
create policy cl_rpn_update_self on public.cl_rpn as permissive for update to public
  using (((cl_jwt_user_type() = 'rpn'::text) AND (id = cl_jwt_sub())))
  with check (((cl_jwt_user_type() = 'rpn'::text) AND (id = cl_jwt_sub())));

commit;
