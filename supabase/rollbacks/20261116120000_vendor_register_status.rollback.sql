-- Rollback of 20261116120000_vendor_register_status (Vendors Register:
-- Registration and Licence). Removes the one read-only function; no data
-- was written by the migration, so nothing else changes.
begin;

drop function if exists public.cl_vendor_register_status();

commit;
