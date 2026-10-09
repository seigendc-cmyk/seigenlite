-- =====================================================================
-- Rollback for supabase/migrations/20261009160000_rpn_onboarding_records.sql.
--
-- Removes the three functions and the table, with every onboarding record
-- in it. Nothing else is touched: cl_vendors, cl_ledger_entries,
-- rpn_onboarding_notes stay as they are, and the cl_activity_log entries
-- of office decisions stay as the audit trail. Export the records first if
-- they are wanted:
--   select * from public.rpn_onboarding_records;
-- =====================================================================
begin;
drop function if exists public.cl_verify_onboarding(uuid, text, text, jsonb, uuid, uuid);
drop function if exists public.cl_list_onboarding_records(text);
drop function if exists public.cl_rpn_save_onboarding(uuid, uuid, text, text, text, text, text, integer, integer, numeric, text, jsonb, timestamptz, boolean);
drop table if exists public.rpn_onboarding_records;
commit;
