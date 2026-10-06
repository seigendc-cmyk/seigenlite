-- =====================================================================
-- Rollback for supabase/migrations/20261007120000_shared_stock.sql.
-- Drops the trigger, the RPCs and helpers, the 5 tables and the two
-- cl_branches columns. LOSES the shared stock figures, allowances and the
-- stock event history: before rolling back a branch that runs shared stock,
-- do a stocktake on its tills (each till keeps its local allowance as its
-- local stock).
-- =====================================================================
begin;

drop trigger if exists cl_stock_till_deactivated on public.cl_terminals;
drop function if exists public.cl_stock_on_till_deactivated();

drop function if exists public.cl_stock_local_products_list(text, text, text);
drop function if exists public.cl_stock_local_products_report(text, text, text, jsonb);
drop function if exists public.cl_stock_balance(text, text, text);
drop function if exists public.cl_stock_stocktake(text, text, text, text, jsonb);
drop function if exists public.cl_stock_report(text, text, text, jsonb, jsonb);
drop function if exists public.cl_stock_move(text, text, text, jsonb);
drop function if exists public.cl_stock_sale(text, text, text, text, jsonb);
drop function if exists public.cl_stock_start_shared(text, text, text, text, jsonb);
drop function if exists public.cl_stock_sync(text, text, text, bigint);
drop function if exists public.cl_stock_rows(public.cl_terminals, text[], bigint);
drop function if exists public.cl_stock_check(uuid);
drop function if exists public.cl_stock_rebalance(public.cl_terminals, text[]);
drop function if exists public.cl_stock_return(uuid, uuid, uuid, text, text);
drop function if exists public.cl_stock_add(uuid, uuid, text, integer);
drop function if exists public.cl_stock_take(uuid, text, uuid, integer, boolean);
drop function if exists public.cl_stock_event(text, text, uuid, uuid, uuid, text, text, integer, integer, integer, jsonb);
drop function if exists public.cl_stock_target(integer, integer);
drop function if exists public.cl_stock_holder(uuid);
drop function if exists public.cl_stock_active_tills(uuid);

drop table if exists public.cl_branch_local_products;
drop table if exists public.cl_stock_events;
drop table if exists public.cl_till_stock_state;
drop table if exists public.cl_till_allowance;
drop table if exists public.cl_branch_stock;

alter table public.cl_branches drop column if exists stock_shared_ts;
alter table public.cl_branches drop column if exists stock_mode;

commit;
