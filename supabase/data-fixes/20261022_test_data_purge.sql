-- One-off DATA fix (no schema change): the purge of the test data on live.
-- Owner's decision 2026-10-22 (roadmap item 1, "keep only Sysadmin"): every
-- business, vendor, till and iTred account on live is test data.
-- Run only after the owner has seen this file and said "apply":
--   node tools/db/run-data-fix.js apply supabase/data-fixes/20261022_test_data_purge.sql
-- then the Storage files: node tools/db/purge-storage.js apply
-- (Storage refuses deletes in SQL: storage.protect_delete).
--
-- KEPT (platform, unchanged; checked before and after): the Console staff
-- (cl_staff: the SysAdmin and the other account, listed in the report, not
-- deleted) and their module rights, the iTred portal staff (portal_staff:
-- listed, not deleted), the RPNs (cl_rpn) and their PINs, the RPN commission
-- rates, the platform settings (cl_app_settings, cl_app_build_rule,
-- cl_activation_pricing, cl_price_plans and versions, cl_chart_of_accounts,
-- cl_token_prices, cl_modules, cl_shop_meta's legacy cutoff).
-- EMPTIED (every row): the 65 other tables in public: businesses, branches,
-- tills, vendors, licences, trials, the catalogue and stock, staff and roles
-- of the shops, dispatches, GRVs, transfers, customers and suppliers, the
-- Console's records (ledger, cashbook, vouchers, activation codes, plan
-- settings, vendor messages, token sales, the activity log), the RPN links
-- and commissions, and iTred (vendors, listings, orders, messages); and every
-- auth.users row (all are iTred customer sign-ups; their profiles go with them).
-- One activity-log line records the purge (table names and counts only).
-- TRUNCATE skips the per-row delete guards and log triggers on purpose: they
-- protect single deletes of records with history; here everything goes.
-- Sequences (licence serials, document numbers) are NOT restarted.
-- It rolls itself back, changing nothing, if a kept table's count differs
-- from what the owner was shown, or if anything is left behind.
begin;

create temp table _purge_before on commit drop as
select t.relname::text tbl, 0::bigint rows_n
from pg_class t join pg_namespace s on s.oid = t.relnamespace
where s.nspname = 'public' and t.relkind = 'r' and t.relname = any (array[
  'cl_activation_codes','cl_activity_log','cl_branch_join_codes','cl_branch_local_products','cl_branch_prices','cl_branch_stock',
  'cl_branches','cl_businesses','cl_cashbook_entries','cl_catalogue_images','cl_catalogue_products','cl_customers','cl_dispatch_issues',
  'cl_dispatch_lines','cl_dispatch_log','cl_dispatches','cl_interbranch_charges','cl_internal_transfer_lines','cl_internal_transfers',
  'cl_join_failures','cl_ledger_entries','cl_licence_redeem_failures','cl_licences','cl_listing_photo_trash','cl_market_pack_images',
  'cl_market_packs','cl_payment_voucher_lines','cl_payment_vouchers','cl_plan_assignments','cl_rpn_assignments','cl_rpn_commissions',
  'cl_rpn_link_failures','cl_rpn_payouts','cl_shop_legacy_uploads','cl_shop_roles','cl_shop_staff','cl_shop_staff_events',
  'cl_shop_staff_sessions','cl_shop_staff_signin_fails','cl_stock_events','cl_supplier_grv_lines','cl_supplier_grvs','cl_suppliers',
  'cl_terminal_admin_seeds','cl_terminals','cl_till_allowance','cl_till_stock_levels','cl_till_stock_push','cl_till_stock_state',
  'cl_token_purchases','cl_token_uses','cl_trial_exceptions','cl_trial_refusals','cl_trials','cl_vendor_messages','cl_vendors',
  'customers','itred_order_messages','itred_po_updates','purchase_order_items','purchase_orders','rpn_onboarding_notes',
  'vendor_listings','vendor_tokens','vendors']);

do $$
declare
  -- EXPECT_KEEP: the kept tables' counts the owner was shown (inventory 2026-10-22)
  v_expect jsonb := '{"cl_staff":2,"cl_staff_module_access":6,"cl_modules":16,"portal_staff":2,"cl_rpn":2,"cl_rpn_pins":2,"cl_rpn_commission_rates":2,"cl_app_settings":6,"cl_app_build_rule":1,"cl_activation_pricing":3,"cl_price_plans":2,"cl_price_plan_versions":5,"cl_chart_of_accounts":8,"cl_token_prices":4,"cl_shop_meta":1}';
  v_have jsonb := '{}'; k text; n bigint; r record; total bigint := 0; users bigint;
  v_public int; v_listed int;
begin
  if (select count(*) from _purge_before) <> 65 then
    raise exception 'test data purge aborted: % of the 65 tables found. Nothing was changed.', (select count(*) from _purge_before);
  end if;
  -- every public table is either kept or emptied: nothing new since the inventory
  select count(*) into v_public from pg_class t join pg_namespace s on s.oid = t.relnamespace where s.nspname = 'public' and t.relkind = 'r';
  if v_public <> 65 + 15 then
    raise exception 'test data purge aborted: public has % tables, the inventory had 80. Nothing was changed.', v_public;
  end if;
  for k in select jsonb_object_keys(v_expect) loop
    execute format('select count(*) from public.%I', k) into n;
    v_have := v_have || jsonb_build_object(k, n);
  end loop;
  raise notice 'KEPT BEFORE: %', v_have;
  if v_have <> v_expect then
    raise exception 'test data purge aborted: a kept table changed since it was shown (% vs %). Nothing was changed.', v_have, v_expect;
  end if;
  for r in select tbl from _purge_before loop
    execute format('select count(*) from public.%I', r.tbl) into n;
    execute format('update _purge_before set rows_n = %s where tbl = %L', n, r.tbl);
    total := total + n;
  end loop;
  select count(*) into users from auth.users;
  raise notice 'BEFORE: % rows in the 65 tables; auth.users %', total, users;
  raise notice 'BEFORE by table: %', (select jsonb_object_agg(tbl, rows_n) from _purge_before where rows_n > 0);
end $$;

truncate table
  public.cl_activation_codes, public.cl_activity_log, public.cl_branch_join_codes, public.cl_branch_local_products, public.cl_branch_prices,
  public.cl_branch_stock, public.cl_branches, public.cl_businesses, public.cl_cashbook_entries, public.cl_catalogue_images,
  public.cl_catalogue_products, public.cl_customers, public.cl_dispatch_issues, public.cl_dispatch_lines, public.cl_dispatch_log,
  public.cl_dispatches, public.cl_interbranch_charges, public.cl_internal_transfer_lines, public.cl_internal_transfers, public.cl_join_failures,
  public.cl_ledger_entries, public.cl_licence_redeem_failures, public.cl_licences, public.cl_listing_photo_trash, public.cl_market_pack_images,
  public.cl_market_packs, public.cl_payment_voucher_lines, public.cl_payment_vouchers, public.cl_plan_assignments, public.cl_rpn_assignments,
  public.cl_rpn_commissions, public.cl_rpn_link_failures, public.cl_rpn_payouts, public.cl_shop_legacy_uploads, public.cl_shop_roles,
  public.cl_shop_staff, public.cl_shop_staff_events, public.cl_shop_staff_sessions, public.cl_shop_staff_signin_fails, public.cl_stock_events,
  public.cl_supplier_grv_lines, public.cl_supplier_grvs, public.cl_suppliers, public.cl_terminal_admin_seeds, public.cl_terminals,
  public.cl_till_allowance, public.cl_till_stock_levels, public.cl_till_stock_push, public.cl_till_stock_state, public.cl_token_purchases,
  public.cl_token_uses, public.cl_trial_exceptions, public.cl_trial_refusals, public.cl_trials, public.cl_vendor_messages, public.cl_vendors,
  public.customers, public.itred_order_messages, public.itred_po_updates, public.purchase_order_items, public.purchase_orders,
  public.rpn_onboarding_notes, public.vendor_listings, public.vendor_tokens, public.vendors;

delete from auth.users;

do $$
declare
  v_expect jsonb := '{"cl_staff":2,"cl_staff_module_access":6,"cl_modules":16,"portal_staff":2,"cl_rpn":2,"cl_rpn_pins":2,"cl_rpn_commission_rates":2,"cl_app_settings":6,"cl_app_build_rule":1,"cl_activation_pricing":3,"cl_price_plans":2,"cl_price_plan_versions":5,"cl_chart_of_accounts":8,"cl_token_prices":4,"cl_shop_meta":1}';
  v_have jsonb := '{}'; k text; n bigint; r record; left_over text := ''; users bigint;
begin
  for r in select tbl from _purge_before loop
    execute format('select count(*) from public.%I', r.tbl) into n;
    if n <> 0 then left_over := left_over || r.tbl || ' ' || n || '; '; end if;
  end loop;
  select count(*) into users from auth.users;
  for k in select jsonb_object_keys(v_expect) loop
    execute format('select count(*) from public.%I', k) into n;
    v_have := v_have || jsonb_build_object(k, n);
  end loop;
  raise notice 'AFTER: left over: %; auth.users %', coalesce(nullif(left_over, ''), 'none'), users;
  raise notice 'KEPT AFTER: %', v_have;
  if left_over <> '' or users <> 0 or v_have <> v_expect then
    raise exception 'test data purge aborted: the result is not what was shown. Nothing was changed.';
  end if;
  insert into public.cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'test_data_purge', 'public', null,
          jsonb_build_object('reason', 'Owner decision 2026-10-22: all businesses, vendors, tills and iTred accounts on live were test data; kept: SysAdmin and Console staff, portal staff, RPNs, platform settings',
                             'rows_by_table', (select jsonb_object_agg(tbl, rows_n) from _purge_before where rows_n > 0),
                             'rows', (select sum(rows_n) from _purge_before)));
end $$;

commit;
