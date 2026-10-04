-- =====================================================================
-- Rollback for supabase/migrations/20261003120000_rpn_onboarding_notes.sql.
--
-- Removes the two functions and the table, with every onboarding note in
-- it. Vendors Register rows that cl_onboarding_note_to_vendor() created or
-- filled in are NOT touched: they are ordinary cl_vendors rows by then,
-- and the cl_activity_log entries that record it stay as the audit trail.
-- Export the notes first if they are wanted:
--   select * from public.rpn_onboarding_notes;
-- =====================================================================
begin;
drop function if exists public.cl_onboarding_note_to_vendor(uuid, uuid);
drop function if exists public.cl_list_onboarding_notes(boolean);
drop table if exists public.rpn_onboarding_notes;
commit;
