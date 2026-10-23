-- Rollback of 20261113120000_sales_sync (B4, v35).
-- Removes the synced sales and money events, their tables and functions, and
-- puts back cl_device_branch_report exactly as 20261107120000_shop_roles made it.
-- The rows the tills sent are lost with the tables (the tills keep their own).
begin;

drop function if exists public.cl_device_credit_balances(text, text, text);
drop function if exists public.cl_device_credit_check(text, text, text, text, text, numeric, numeric, boolean);
drop function if exists public.cl_device_b4_push(text, text, text, jsonb);
drop function if exists public.cl_b4_retention(uuid);
drop function if exists public.cl_b4_store(public.cl_terminals, jsonb);
drop function if exists public.cl_b4_balance(uuid, text);
drop function if exists public.cl_b4_daily(public.cl_terminals, date, boolean, text, numeric, numeric, numeric, numeric, jsonb);
drop function if exists public.cl_b4_methods_add(jsonb, jsonb, numeric);
drop function if exists public.cl_b4_uid_ok(text);
drop function if exists public.cl_b4_num(jsonb, text);
drop function if exists public.cl_b4_txt(jsonb, text, integer);
drop table if exists public.cl_b4_runs;
drop table if exists public.cl_sales_daily;
drop table if exists public.cl_credit_holds;
drop table if exists public.cl_credit_bf;
drop table if exists public.cl_voucher_events;
drop table if exists public.cl_price_change_log;
drop table if exists public.cl_credit_overrides;
drop table if exists public.cl_eod_closes;
drop table if exists public.cl_payouts;
drop table if exists public.cl_credit_payments;
drop table if exists public.cl_sale_returns;
drop table if exists public.cl_sales;

create or replace function public.cl_device_branch_report(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text,
                                               p_kind text, p_branch_id uuid, p_from timestamptz default null, p_to timestamptz default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; v_costs boolean; v_from timestamptz := coalesce(p_from, '-infinity'); v_to timestamptz := coalesce(p_to, 'infinity');
        v_rows json;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into b from cl_branches where id = p_branch_id and business_id = me.business_id;
  if b.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That branch isn''t in this business.'); end if;
  if b.id <> me.branch_id and not cl_staff_has(p_staff_token, me.id, 'other_branches') then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Other branches'' reports need a signed-in person with "View other branches'' reports".');
  end if;
  v_costs := cl_staff_has(p_staff_token, me.id, 'costs');
  if p_kind = 'inventory' then
    v_rows := coalesce((select json_agg(x order by x.name) from (
      select g.k, g.cat_uid, g.code, g.name, g.qty, g.low,
             case when v_costs then c.cost end as cost, case when v_costs then round((g.qty * c.cost)::numeric, 2) end as value
        from (select l.product_key k, max(l.cat_uid) cat_uid, max(l.code) code, max(l.name) name, sum(l.qty)::bigint qty, max(l.low_threshold) low
                from cl_till_stock_levels l join cl_terminals t on t.id = l.terminal_id
               where b.stock_mode <> 'shared' and l.branch_id = b.id and t.active and t.branch_id = b.id
               group by l.product_key
              union all
              select s.product_uid, s.product_uid, c2.code, c2.name, s.total::bigint, c2.low_threshold
                from cl_branch_stock s join cl_catalogue_products c2 on c2.business_id = s.business_id and c2.product_uid = s.product_uid
               where b.stock_mode = 'shared' and s.branch_id = b.id) g
        left join cl_catalogue_products c on c.business_id = me.business_id and c.product_uid = coalesce(g.cat_uid, g.k)) x), '[]'::json);
  elsif p_kind = 'dispatches' then
    v_rows := coalesce((select json_agg(x order by x.sent_at desc) from (
      select d.id, d.dn_display, case when d.from_branch_id = b.id then 'out' else 'in' end as direction,
             (select name from cl_branches where id = case when d.from_branch_id = b.id then d.to_branch_id else d.from_branch_id end) as other_branch,
             d.status, d.sent_at, d.sent_by, d.received_at, d.grv_display, d.grv_by, d.internal_ref,
             d.delivery_cost, d.delivery_currency,
             case when v_costs then (select json_build_object('amount', ch.amount, 'currency', ch.currency) from cl_interbranch_charges ch where ch.dispatch_id = d.id limit 1) end as charge,
             (select coalesce(json_agg(json_build_object('line_no', l.line_no, 'code', l.code, 'name', l.name, 'qty', l.qty, 'received', l.received,
                 'short', l.short, 'damaged', l.damaged, 'extra', l.extra, 'unit_cost', case when v_costs then l.unit_cost end) order by l.line_no), '[]'::json)
                from cl_dispatch_lines l where l.dispatch_id = d.id) as lines
        from cl_dispatches d
       where d.business_id = me.business_id and (d.from_branch_id = b.id or d.to_branch_id = b.id) and d.sent_at between v_from and v_to
       order by d.sent_at desc limit 500) x), '[]'::json);
  elsif p_kind = 'supplier_grvs' then
    v_rows := coalesce((select json_agg(x order by x.posted_at desc) from (
      select g.id, g.grv_display, g.posted_at, g.received_by, g.invoice_no, sp.name as supplier, t.till_code as till,
             case when v_costs then g.delivery_cost end as delivery_cost, g.delivery_currency,
             (select coalesce(json_agg(json_build_object('line_no', l.line_no, 'code', l.code, 'name', l.name, 'qty', l.qty,
                 'unit_cost', case when v_costs then l.unit_cost end, 'landed_cost', case when v_costs then l.landed_cost end) order by l.line_no), '[]'::json)
                from cl_supplier_grv_lines l where l.grv_id = g.id) as lines
        from cl_supplier_grvs g join cl_suppliers sp on sp.id = g.supplier_id left join cl_terminals t on t.id = g.terminal_id
       where g.business_id = me.business_id and g.branch_id = b.id and g.posted_at between v_from and v_to
       order by g.posted_at desc limit 500) x), '[]'::json);
  else
    raise exception 'Say which report: inventory, dispatches or supplier_grvs' using errcode = 'P0001';
  end if;
  return json_build_object('server_time', now(), 'kind', p_kind, 'branch_id', b.id, 'branch', b.name, 'costs', v_costs, 'rows', v_rows);
end $fn$;

commit;
