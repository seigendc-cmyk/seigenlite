-- One-off DATA fix (no schema change): clear every test financial record on
-- live, so billing starts from zero for real onboarding.
-- Owner's decision 2026-10-09: no money has ever been received; every ledger
-- entry, payment, credit, cashbook entry and voucher on live is a test.
-- Run only after the owner has seen this file and said "apply":
--   node tools/db/run-data-fix.js apply supabase/data-fixes/20261009_financial_reset.sql
-- Prints the counts before and after; rolls itself back (changing nothing)
-- if any count or sum differs from what the owner was shown (A1 report,
-- 2026-10-09), or if anything is left behind.
-- Kept: vendors, businesses, branches, terminals, catalogue, stock, staff,
-- permissions, price plans, plan assignments, licences (#1001, #1002: note set to TEST),
-- cl_activation_pricing (configuration), the chart of accounts (balances
-- become 0.00), the activity log (audit history; this reset is logged).
begin;

do $$
declare
  b_ledger int; b_ledger_sum numeric; b_cash int; b_cash_in numeric; b_cash_out numeric;
  b_vouch int; b_vlines int; b_codes int; b_rfail int; b_assign int;
  k_lic int; k_price int; k_coa int; k_plans int; k_versions int;
  a_ledger int; a_cash int; a_vouch int; a_vlines int; a_codes int; a_rfail int; a_assign int;
  a_lic int; a_price int; a_coa int; a_plans int; a_versions int; a_linked int; a_bal numeric;
begin
  select count(*), coalesce(sum(amount), 0) into b_ledger, b_ledger_sum from public.cl_ledger_entries;
  select count(*), coalesce(sum(amount) filter (where direction = 'in'), 0), coalesce(sum(amount) filter (where direction = 'out'), 0)
    into b_cash, b_cash_in, b_cash_out from public.cl_cashbook_entries;
  select count(*) into b_vouch from public.cl_payment_vouchers;
  select count(*) into b_vlines from public.cl_payment_voucher_lines;
  select count(*) into b_codes from public.cl_activation_codes;
  select count(*) into b_rfail from public.cl_licence_redeem_failures;
  select count(*) into b_assign from public.cl_plan_assignments;
  select count(*) into k_lic from public.cl_licences;
  select count(*) into k_price from public.cl_activation_pricing;
  select count(*) into k_coa from public.cl_chart_of_accounts;
  select count(*) into k_plans from public.cl_price_plans;
  select count(*) into k_versions from public.cl_price_plan_versions;
  raise notice 'BEFORE: ledger % (sum %), cashbook % (in %, out %), vouchers %, voucher lines %, activation codes %, redeem failures %, plan assignments %',
    b_ledger, b_ledger_sum, b_cash, b_cash_in, b_cash_out, b_vouch, b_vlines, b_codes, b_rfail, b_assign;
  raise notice 'KEPT BEFORE: licences %, activation pricing %, chart of accounts %, price plans %, plan versions %', k_lic, k_price, k_coa, k_plans, k_versions;

  -- exactly what the owner was shown (A1 report); anything else: stop, change nothing
  if (b_ledger, b_ledger_sum, b_cash, b_cash_in, b_cash_out, b_vouch, b_vlines, b_codes, b_rfail, b_assign)
     is distinct from (4, 95.00, 6, 220.00, 5.00, 1, 1, 0, 0, 1) then
    raise exception 'financial reset aborted: the records changed since they were shown. Nothing was changed.';
  end if;
  if (k_lic, k_price, k_coa, k_plans, k_versions) is distinct from (2, 3, 8, 2, 2) then
    raise exception 'financial reset aborted: kept tables changed since they were shown. Nothing was changed.';
  end if;

  -- order: credits/reversals (they name other ledger rows) first, then the
  -- rest (licence #1002's link is cleared by its ON DELETE SET NULL), then the
  -- cashbook (no FK; source_id only), vouchers (lines go with them), the rest
  delete from public.cl_ledger_entries where reverses_entry_id is not null;
  delete from public.cl_ledger_entries;
  delete from public.cl_cashbook_entries;
  delete from public.cl_payment_vouchers;
  delete from public.cl_activation_codes;
  delete from public.cl_licence_redeem_failures;
  -- cl_plan_assignments is KEPT (configuration, not money): Brechin Nursery
  -- was set to Lite ("Tuckshop") by Lovemore on 2026-10-09 00:59
  update public.cl_licences set note = 'TEST' where serial in (1001, 1002) and note is null;

  select count(*) into a_ledger from public.cl_ledger_entries;
  select count(*) into a_cash from public.cl_cashbook_entries;
  select count(*) into a_vouch from public.cl_payment_vouchers;
  select count(*) into a_vlines from public.cl_payment_voucher_lines;
  select count(*) into a_codes from public.cl_activation_codes;
  select count(*) into a_rfail from public.cl_licence_redeem_failures;
  select count(*) into a_assign from public.cl_plan_assignments;
  select count(*) into a_lic from public.cl_licences;
  select count(*) filter (where ledger_entry_id is not null) into a_linked from public.cl_licences;
  select count(*) into a_price from public.cl_activation_pricing;
  select count(*) into a_coa from public.cl_chart_of_accounts;
  select count(*) into a_plans from public.cl_price_plans;
  select count(*) into a_versions from public.cl_price_plan_versions;
  select coalesce(sum(case when direction = 'in' then amount else -amount end), 0) into a_bal from public.cl_cashbook_entries;
  raise notice 'AFTER: ledger %, cashbook %, vouchers %, voucher lines %, activation codes %, redeem failures %, plan assignments %, cashbook net %',
    a_ledger, a_cash, a_vouch, a_vlines, a_codes, a_rfail, a_assign, a_bal;
  raise notice 'KEPT AFTER: licences % (linked to a charge: %), activation pricing %, chart of accounts %, price plans %, plan versions %',
    a_lic, a_linked, a_price, a_coa, a_plans, a_versions;
  if (a_ledger, a_cash, a_vouch, a_vlines, a_codes, a_rfail, a_linked) is distinct from (0, 0, 0, 0, 0, 0, 0)
     or a_assign is distinct from b_assign or (a_lic, a_price, a_coa, a_plans, a_versions) is distinct from (k_lic, k_price, k_coa, k_plans, k_versions) then
    raise exception 'financial reset aborted: the result is not what was shown. Nothing was changed.';
  end if;

  insert into public.cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'financial_reset', 'cl_ledger_entries', null,
          jsonb_build_object('reason', 'Owner decision 2026-10-09: all financial records on live were tests; billing starts from zero',
                             'ledger_rows', b_ledger, 'ledger_sum', b_ledger_sum, 'cashbook_rows', b_cash, 'cashbook_in', b_cash_in,
                             'cashbook_out', b_cash_out, 'vouchers', b_vouch, 'voucher_lines', b_vlines));
end $$;

-- the next voucher is PV-00001 again (the only voucher was a test draft)
select setval('public.cl_voucher_no_seq', 1, false);

commit;
