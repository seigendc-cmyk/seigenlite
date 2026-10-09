-- =====================================================================
-- Rollback for supabase/migrations/20261009150000_rpn_self_update_guard.sql.
-- Removes the trigger and its function. cl_rpn rows are not touched.
-- After this, an RPN can again change every column of their own row
-- (the hole the migration closed).
-- =====================================================================
begin;
drop trigger if exists cl_rpn_self_update_guard on public.cl_rpn;
drop function if exists public.cl_rpn_self_update_guard();
commit;
