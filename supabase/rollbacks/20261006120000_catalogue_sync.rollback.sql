-- =====================================================================
-- Rollback for supabase/migrations/20261006120000_catalogue_sync.sql.
-- Drops the 6 functions, the 3 tables, the sequence and the two
-- cl_branches columns. LOSES the server's copy of the catalogue, branch
-- prices and pictures; every product still exists on the devices (the
-- tills keep what they pulled, stock untouched).
-- =====================================================================
begin;

drop function if exists public.cl_catalogue_images_pull(text, text, text, text[]);
drop function if exists public.cl_catalogue_pull(text, text, text, bigint, integer);
drop function if exists public.cl_branch_set_price_mode(text, text, text, uuid, text);
drop function if exists public.cl_branch_price_push(text, text, text, jsonb);
drop function if exists public.cl_catalogue_push(text, text, text, jsonb);
drop function if exists public.cl_catalogue_caller(text, text, text);

drop table if exists public.cl_branch_prices;
drop table if exists public.cl_catalogue_images;
drop table if exists public.cl_catalogue_products;
drop sequence if exists public.cl_catalogue_seq;

alter table public.cl_branches drop column if exists price_mode_seq;
alter table public.cl_branches drop column if exists price_mode;

commit;
