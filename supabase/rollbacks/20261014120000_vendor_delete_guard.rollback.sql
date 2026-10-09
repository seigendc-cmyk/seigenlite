-- Rollback of 20261014120000_vendor_delete_guard.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Restores the six foreign keys exactly as they were (CASCADE / SET NULL),
-- drops the triggers, functions and archive columns, and gives anon and
-- authenticated back TRUNCATE, TRIGGER and REFERENCES on the 15 cl_ tables
-- that had them on 2026-10-09 (read from live). Archive state is lost; the
-- activity log keeps every archive / unarchive / delete it recorded.

begin;

drop trigger if exists cl_vendors_delete_guard on public.cl_vendors;
drop trigger if exists cl_businesses_delete_guard on public.cl_businesses;
drop trigger if exists cl_vendors_log_delete on public.cl_vendors;
drop trigger if exists cl_vendors_log_archive on public.cl_vendors;
drop trigger if exists cl_businesses_log_delete on public.cl_businesses;
drop trigger if exists cl_businesses_log_archive on public.cl_businesses;

drop function if exists public.cl_archive_state();
drop function if exists public.cl_vendor_archive(uuid, text);
drop function if exists public.cl_vendor_unarchive(uuid, text);
drop function if exists public.cl_business_archive(uuid, text);
drop function if exists public.cl_business_unarchive(uuid, text);
drop function if exists public.cl_archive_staff();
drop function if exists public.cl_archive_reason(text);
drop function if exists public.cl_log_vendor_change();
drop function if exists public.cl_log_business_change();
drop function if exists public.cl_vendor_delete_guard();
drop function if exists public.cl_business_delete_guard();
drop function if exists public.cl_acting_staff();

alter table public.cl_vendors drop constraint cl_vendors_archive_shape,
  drop column archived_at, drop column archived_by, drop column archive_reason;
alter table public.cl_businesses drop constraint cl_businesses_archive_shape,
  drop column archived_at, drop column archived_by, drop column archive_reason;

alter table public.cl_ledger_entries drop constraint cl_ledger_entries_vendor_id_fkey;
alter table public.cl_ledger_entries add constraint cl_ledger_entries_vendor_id_fkey
  foreign key (vendor_id) references public.cl_vendors(id) on delete cascade;
alter table public.cl_activation_codes drop constraint cl_activation_codes_vendor_id_fkey;
alter table public.cl_activation_codes add constraint cl_activation_codes_vendor_id_fkey
  foreign key (vendor_id) references public.cl_vendors(id) on delete cascade;
alter table public.cl_vendor_messages drop constraint cl_vendor_messages_vendor_id_fkey;
alter table public.cl_vendor_messages add constraint cl_vendor_messages_vendor_id_fkey
  foreign key (vendor_id) references public.cl_vendors(id) on delete cascade;
alter table public.cl_licences drop constraint cl_licences_vendor_id_fkey;
alter table public.cl_licences add constraint cl_licences_vendor_id_fkey
  foreign key (vendor_id) references public.cl_vendors(id) on delete set null;
alter table public.cl_licences drop constraint cl_licences_business_id_fkey;
alter table public.cl_licences add constraint cl_licences_business_id_fkey
  foreign key (business_id) references public.cl_businesses(id) on delete set null;
alter table public.cl_licences drop constraint cl_licences_terminal_id_fkey;
alter table public.cl_licences add constraint cl_licences_terminal_id_fkey
  foreign key (terminal_id) references public.cl_terminals(id) on delete set null;

grant truncate, trigger, references on table
  public.cl_activation_codes, public.cl_activation_pricing, public.cl_activity_log, public.cl_app_settings,
  public.cl_cashbook_entries, public.cl_chart_of_accounts, public.cl_ledger_entries, public.cl_modules,
  public.cl_payment_voucher_lines, public.cl_payment_vouchers, public.cl_rpn, public.cl_staff,
  public.cl_staff_module_access, public.cl_vendor_messages, public.cl_vendors
  to anon, authenticated;

commit;
