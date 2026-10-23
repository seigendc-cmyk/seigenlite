// node tools/db/gen-20261113-migration.js <main.sql>
//
// Writes supabase/migrations/20261113120000_sales_sync.sql and its rollback
// (B4, v35). The new objects come from <main.sql>; cl_device_branch_report is
// taken from its current body (20261107120000_shop_roles.sql) so the new
// version differs only by the "-- B4" lines, and the rollback puts back the
// exact current body.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const READ = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const main = READ(path.resolve(process.argv[2] || ''));
const roles = READ(path.join(ROOT, 'supabase', 'migrations', '20261107120000_shop_roles.sql'));

const start = roles.indexOf('create function public.cl_device_branch_report(');
const end = roles.indexOf('end $fn$;', start) + 'end $fn$;'.length;
if (start < 0 || end < start) throw new Error('cl_device_branch_report not found in 20261107120000_shop_roles.sql');
const current = roles.slice(start, end);

const ELSE = "  else\n    raise exception 'Say which report: inventory, dispatches or supplier_grvs' using errcode = 'P0001';";
if (!current.includes(ELSE)) throw new Error('the else branch of cl_device_branch_report changed');
const CASH = 'b1170000000000000000000000000001', WHOLESALE = 'b1170000000000000000000000000002';
const ADDED = `  elsif p_kind = 'sales' then                                                  -- B4 (decision 38): sales and returns, costs only with "View costs"
    v_rows := coalesce((select json_agg(x.j order by x.at) from (                 -- B4
      select s.sold_at as at, json_build_object('type', 'sale', 'uid', s.uid, 'doc', s.receipt_no, 'at', s.sold_at, 'till', t.till_code, 'operator', s.operator,   -- B4
             'customer_uid', s.customer_uid, 'customer', case s.customer_uid when '${CASH}' then 'Cash Sale' when '${WHOLESALE}' then 'Wholesale' else c.name end,   -- B4
             'customer_type', case when s.customer_uid in ('${CASH}', '${WHOLESALE}') then 'builtin_' || case s.customer_uid when '${CASH}' then 'cash_sale' else 'wholesale' end else c.customer_type end,   -- B4
             'price_level', s.price_level, 'subtotal', s.subtotal, 'discount', s.discount, 'total', s.total, 'voucher_amount', s.voucher_amount,   -- B4
             'method', (select string_agg(distinct p->>'method', '+') from jsonb_array_elements(s.payments) p), 'doc_ref', s.doc_ref,   -- B4
             'credit_amount', s.credit_amount, 'credit_check', s.credit_check, 'credit_scope', s.credit_scope, 'credit_before', s.credit_before,   -- B4
             'credit_after', s.credit_after, 'credit_limit_at', s.credit_limit_at, 'credit_override', s.credit_override, 'credit_override_mode', s.credit_override_mode,   -- B4
             'cost', case when v_costs then s.cost_total end, 'history', s.history) as j   -- B4
        from cl_sales s left join cl_customers c on c.business_id = s.business_id and c.customer_uid = s.customer_uid left join cl_terminals t on t.id = s.terminal_id   -- B4
       where s.business_id = me.business_id and s.branch_id = b.id and s.sold_at between v_from and v_to   -- B4
      union all   -- B4
      select r.returned_at, json_build_object('type', 'return', 'uid', r.uid, 'doc', r.cn_display, 'at', r.returned_at, 'till', t.till_code, 'sale_receipt', r.sale_receipt,   -- B4
             'customer_uid', r.customer_uid, 'customer', c.name, 'reason', r.reason, 'approved_by', r.approved_by, 'total', r.goods_total, 'debtor_amount', r.debtor_amount,   -- B4
             'cost', case when v_costs then r.cost_reversed end, 'history', r.history)   -- B4
        from cl_sale_returns r left join cl_customers c on c.business_id = r.business_id and c.customer_uid = r.customer_uid left join cl_terminals t on t.id = r.terminal_id   -- B4
       where r.business_id = me.business_id and r.branch_id = b.id and r.returned_at between v_from and v_to   -- B4
       order by 1 desc limit 3000) x), '[]'::json);   -- B4
  elsif p_kind = 'payouts' then   -- B4
    v_rows := coalesce((select json_agg(x order by x.at) from (   -- B4
      select p.uid, p.paid_at as at, t.till_code as till, p.reason, p.amount, p.currency, p.account_tag, p.operator, p.history   -- B4
        from cl_payouts p left join cl_terminals t on t.id = p.terminal_id   -- B4
       where p.business_id = me.business_id and p.branch_id = b.id and p.paid_at between v_from and v_to   -- B4
       order by p.paid_at desc limit 2000) x), '[]'::json);   -- B4
  else
    raise exception 'Say which report: inventory, dispatches, supplier_grvs, sales or payouts' using errcode = 'P0001';   -- B4`;
const replaced = current.replace('create function public.cl_device_branch_report(', 'create or replace function public.cl_device_branch_report(')
  .replace("-- p_kind: 'inventory' | 'dispatches' | 'supplier_grvs'.", "-- p_kind: 'inventory' | 'dispatches' | 'supplier_grvs' | 'sales' | 'payouts' (B4).")
  .replace(ELSE, ADDED);
const commentStart = roles.lastIndexOf('-- 11. Other branches', start);
const header = roles.slice(commentStart, start).replace("-- p_kind: 'inventory' | 'dispatches' | 'supplier_grvs'.", "-- p_kind: 'inventory' | 'dispatches' | 'supplier_grvs' | 'sales' | 'payouts' (B4).")
  .replace('-- 11. Other branches\' reports, by right (§R4)', '-- 4. Other branches\' reports, by right (§R4); B4 adds sales and payouts (decision 38)');

const SIG = 'public.cl_device_b4_push(text, text, text, jsonb), public.cl_device_credit_check(text, text, text, text, text, numeric, numeric, boolean), public.cl_device_credit_balances(text, text, text)';
const migration = main.trimEnd() + '\n\n' + header + replaced + `

-- 5. Grants ------------------------------------------------------------------------
revoke all on function public.cl_b4_txt(jsonb, text, integer), public.cl_b4_num(jsonb, text), public.cl_b4_uid_ok(text),
  public.cl_b4_methods_add(jsonb, jsonb, numeric), public.cl_b4_daily(public.cl_terminals, date, boolean, text, numeric, numeric, numeric, numeric, jsonb),
  public.cl_b4_balance(uuid, text), public.cl_b4_store(public.cl_terminals, jsonb), public.cl_b4_retention(uuid) from public, anon, authenticated;
revoke all on function ${SIG} from public;
grant execute on function ${SIG} to anon, authenticated;

commit;
`;

const rollback = `-- Rollback of 20261113120000_sales_sync (B4, v35).
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

${current.replace('create function public.cl_device_branch_report(', 'create or replace function public.cl_device_branch_report(')}

commit;
`;

fs.writeFileSync(path.join(ROOT, 'supabase', 'migrations', '20261113120000_sales_sync.sql'), migration);
fs.writeFileSync(path.join(ROOT, 'supabase', 'rollbacks', '20261113120000_sales_sync.rollback.sql'), rollback);
console.log('wrote 20261113120000_sales_sync.sql (' + migration.length + ' bytes) and its rollback (' + rollback.length + ' bytes)');
