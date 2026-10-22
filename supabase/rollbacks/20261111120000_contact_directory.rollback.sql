-- Rollback of 20261111120000_contact_directory (Batch 6A Part 1).
-- Removes the contact directory, its functions and the Console module (with
-- the staff rights granted to it). The activity-log lines of its changes stay.
begin;

drop function if exists public.cl_contact_number_save(uuid, uuid, text, text, boolean, boolean, integer, boolean);
drop function if exists public.cl_contact_desk_save(uuid, text, integer, boolean);
drop function if exists public.cl_contact_directory_all();
drop function if exists public.cl_contact_directory();
drop function if exists public.cl_contact_phone(text);
drop table if exists public.cl_contact_numbers;
drop table if exists public.cl_contact_desks;
delete from public.cl_staff_module_access where module_id in (select id from public.cl_modules where key = 'contact_directory');
delete from public.cl_modules where key = 'contact_directory';

commit;
