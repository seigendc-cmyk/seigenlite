-- Rollback of supabase/migrations/20261115120000_stock_control.sql (v37).
-- Refused while any stock request, recall, cycle count or broadcast exists
-- (they would be lost); then puts back cl_shop_rights_all and
-- cl_shop_default_rights exactly as before, takes the four v37 rights off
-- every role, and drops everything v37 added.
begin;

do $$
declare n integer;
begin
  select (select count(*) from public.cl_stock_requests) + (select count(*) from public.cl_stock_recalls)
       + (select count(*) from public.cl_cycle_counts) + (select count(*) from public.cl_market_feed) into n;
  if n > 0 then raise exception 'stock_control rollback refused: % stock requests, recalls, cycle counts or broadcasts exist. Nothing was changed.', n; end if;
end $$;

drop trigger cl_dispatches_stock_ctl on public.cl_dispatches;
drop function public.cl_device_stock_ctl_push(text, text, text, jsonb);
drop function public.cl_device_stock_ctl_pull(text, text, text, bigint, bigint);
drop function public.cl_market_feed_all();
drop function public.cl_market_feed_save(bigint, text, text, boolean, timestamptz, timestamptz);
drop function public.cl_stock_ctl_on_dispatch();
drop function public.cl_stock_ctl_event(public.cl_terminals, jsonb);
drop function public.cl_market_feed_now();
drop function public.cl_cycle_count_json(public.cl_cycle_counts, boolean);
drop function public.cl_stock_recall_json(uuid);
drop function public.cl_stock_request_json(uuid);
drop function public.cl_stock_ctl_sees_diff(public.cl_terminals);
drop function public.cl_stock_ctl_date(text);
drop function public.cl_stock_ctl_text(text, integer);
drop function public.cl_stock_ctl_main(uuid);
drop function public.cl_stock_ctl_log_add(text, uuid, uuid, text, text, jsonb);
delete from public.cl_staff_module_access where module_id in (select id from public.cl_modules where key = 'market_feed');
delete from public.cl_modules where key = 'market_feed';
drop table public.cl_market_feed;
drop table public.cl_stock_ctl_log;
drop table public.cl_stock_recall_lines;
drop table public.cl_stock_recalls;
drop table public.cl_stock_request_lines;
drop table public.cl_stock_requests;
drop table public.cl_cycle_counts;
drop table public.cl_branch_shelves;
drop sequence public.cl_stock_ctl_seq;

-- the four rights off every role (built-in and custom), so no role holds a right the list doesn't know
update public.cl_shop_roles
   set rights = array(select x from unnest(rights) x where not (x = any(array['request_stock', 'recall_stock', 'count_stock', 'approve_counts']))),
       change_seq = nextval('public.cl_shop_seq'), updated_at = now(), updated_by = 'seiGEN'
 where rights && array['request_stock', 'recall_stock', 'count_stock', 'approve_counts'];

-- cl_shop_rights_all as in 20261107120000_shop_roles.sql
create or replace function public.cl_shop_rights_all() returns text[]
language sql immutable as $$
  select array['m.sell', 'm.products', 'm.credit', 'm.reports', 'm.marketing',
               'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming',
               'm.productlist', 'm.stocktake', 'm.requests', 'm.purchasing', 'm.reportwriter', 'm.directory',
               'm.settings', 'm.staff', 'm.terminals', 'm.eod',
               'costs', 'edit_prices', 'create_customers', 'review_requisitions', 'other_branches',
               'approve_writeoffs', 'void_return', 'credit_over_limit', 'sales_reports',
               'owner']::text[]
$$;
-- cl_shop_default_rights as in 20261114120000_roles_everywhere.sql
create or replace function public.cl_shop_default_rights(p_builtin text) returns text[]
language sql immutable as $$
  select case p_builtin
    when 'owner' then public.cl_shop_rights_all()
    when 'admin' then array_remove(public.cl_shop_rights_all(), 'owner')
    when 'manager' then array['m.sell', 'm.products', 'm.credit', 'm.reports', 'm.marketing', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming',
                              'm.productlist', 'm.stocktake', 'm.requests', 'm.purchasing', 'm.reportwriter', 'm.directory', 'm.eod',
                              'costs', 'edit_prices', 'create_customers', 'review_requisitions', 'other_branches',
                              'approve_writeoffs', 'void_return', 'credit_over_limit', 'sales_reports']::text[]
    when 'stores' then array['m.products', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming', 'm.productlist', 'm.stocktake',
                             'm.purchasing', 'm.reports', 'm.reportwriter']::text[]
    when 'cashier' then array['m.sell', 'm.credit', 'm.productlist', 'm.directory', 'm.requests', 'm.reports', 'm.eod', 'sales_reports']::text[]
    when 'guest' then array['m.productlist', 'branch_prices']::text[]   -- v36 (decision 49): stock and selling prices, view only
  end
$$;
revoke all on function public.cl_shop_rights_all(), public.cl_shop_default_rights(text) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
