-- Rollback for supabase/migrations/20261011120000_ledger_credits.sql.
-- Refuses (changing nothing) while any credit exists: credits are real
-- ledger entries and would break the old charge/payment rule. Remove or
-- account for them deliberately first.
-- Also remove the row from supabase_migrations.schema_migrations
-- (tools/db/apply-migration.js apply <file> --rollback does both in one transaction).
begin;

do $$
begin
  if exists (select 1 from public.cl_ledger_entries where entry_type = 'credit') then
    raise exception 'ledger_credits rollback aborted: % credit entr(ies) exist. Nothing was changed.',
      (select count(*) from public.cl_ledger_entries where entry_type = 'credit');
  end if;
end $$;

drop function if exists public.cl_record_ledger_credit(uuid, numeric, text, text, uuid);
drop index if exists public.cl_ledger_entries_reverses_idx;
alter table public.cl_ledger_entries drop constraint if exists cl_ledger_entries_credit_shape;
alter table public.cl_ledger_entries drop column if exists reverses_entry_id;
alter table public.cl_ledger_entries drop constraint cl_ledger_entries_entry_type_check;
alter table public.cl_ledger_entries add constraint cl_ledger_entries_entry_type_check
  check (entry_type = any (array['charge'::text, 'payment'::text]));

commit;
