-- Rollback for supabase/migrations/20261010120000_activation_licences.sql.
-- Drops the licence tables and RPCs. Nothing else was changed by the
-- migration, so nothing else is restored. Ledger charges written by
-- cl_licence_attach stay in cl_ledger_entries (they are real charges);
-- their link column goes with cl_licences.
-- Apps keep any licence they already hold (it is checked offline); they
-- just can't redeem short codes or fetch new licences until it is re-applied.
-- Also remove the row from supabase_migrations.schema_migrations
-- (tools/db/apply-migration.js --rollback does both in one transaction).
begin;

drop function if exists public.cl_licence_pending(text, text, text, integer);
drop function if exists public.cl_licence_redeem(text, text, text, text);
drop function if exists public.cl_vendor_repeat_installs(integer);
drop function if exists public.cl_licence_revoke(integer, text);
drop function if exists public.cl_licence_list(text, uuid, integer);
drop function if exists public.cl_licence_attach(integer, text);
drop function if exists public.cl_licence_prepare(text, uuid, integer, integer, integer, text);
drop function if exists public.cl_licence_b64url(bytea);
drop function if exists public.cl_licence_new_code();
drop function if exists public.cl_licence_binding_ok(bytea, boolean, text);
drop function if exists public.cl_licence_tag(bytea);
drop function if exists public.cl_licence_hash(text);
drop function if exists public.cl_licence_staff_ok();
drop table if exists public.cl_licence_redeem_failures;
drop table if exists public.cl_licences;

commit;
