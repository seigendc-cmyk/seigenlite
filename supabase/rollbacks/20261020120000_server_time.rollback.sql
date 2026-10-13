-- Rollback of 20261020120000_server_time.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Apps still asking for the time get a 404 and fall back to the device's
-- clock and its high-water mark, as before.

begin;

drop function if exists public.cl_server_time();

commit;
