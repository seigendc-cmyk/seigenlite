-- Rollback of 20261024120000_branch_stock.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- The two tables hold only copies of the tills' own stock figures (every
-- till keeps its real stock on the device and sends it again), so nothing is
-- lost for good. Apps from B1 on see the functions gone and stop showing
-- other branches' stock ("not on seiGEN yet"); selling never depends on them.

begin;

drop function if exists public.cl_device_business_dispatches(text, text, text, integer);
drop function if exists public.cl_device_branch_stock(text, text, text, uuid);
drop function if exists public.cl_device_stock_levels_push(text, text, text, text, boolean, jsonb);
drop function if exists public.cl_bs_enabled(uuid);
drop table if exists public.cl_till_stock_push;
drop table if exists public.cl_till_stock_levels;

commit;
