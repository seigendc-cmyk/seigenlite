-- One-off DATA fix (no schema change): Purge 2 (owner, 27 Oct 2026). It
-- supersedes A8. Same rules as the 22 Oct purge (20261022_test_data_purge.sql):
-- every business, vendor, till and iTred account on live is test data, all
-- 19 vendors go, IVO Motor Spares (U5VZ-C1) included.
-- Run only after the owner has seen this file and said "apply"; the owner runs it:
--   node tools/db/run-data-fix.js apply supabase/data-fixes/20261027_purge_2.sql
-- Storage: bucket listing-images holds 0 files (checked 27 Oct), so there is
-- no Storage step.
-- Backup first: docs/database/live-backup-2026-10-27T13-10-46-743Z/ (gitignored;
-- every public table, auth.users and auth.identities).
--
-- KEPT (unchanged; checked before and after): Console staff and their module
-- rights, iTred portal staff, the RPNs, their PINs and commission rates, the
-- price plans and versions, the company and platform settings
-- (cl_app_settings, cl_app_build_rule, cl_activation_pricing, cl_token_prices,
-- cl_modules, cl_shop_meta), the Contact directory, the chart of accounts.
-- KEPT AND ADDED TO: cl_removed_devices. Every install of the 19 vendor rows
-- (their tills and seats are among them), and the 148 installs purged on
-- 22 Oct (A8's list, from the offline backup). An install already listed
-- is left as it is. Their check-ins are then refused (DEVICE_REMOVED) until
-- the device is reset.
-- EMPTIED (every row): the 78 other tables in public (the 65 of 22 Oct and
-- the 13 added since: the 12 sales-sync tables and cl_till_rights_log), and
-- every auth.users row (iTred customer sign-ups; their profiles go with them).
-- One activity-log line records the purge (table names and counts only).
-- TRUNCATE skips the per-row delete guards and log triggers on purpose, as on
-- 22 Oct (so the removed-devices trigger doesn't run either: step 2 lists the
-- installs itself). The guards themselves are unchanged.
-- Sequences (licence serials, document numbers) are NOT restarted.
-- It rolls itself back, changing nothing, if public isn't the 96 tables of
-- the inventory, a kept table's count differs from what the owner was shown,
-- cl_vendors isn't 19 rows, or anything is left behind.
begin;

create temp table _purge_before on commit drop as
select t.relname::text tbl, 0::bigint rows_n
from pg_class t join pg_namespace s on s.oid = t.relnamespace
where s.nspname = 'public' and t.relkind = 'r' and t.relname = any (array[
  'cl_activation_codes', 'cl_activity_log', 'cl_b4_runs', 'cl_branch_join_codes', 'cl_branch_local_products', 'cl_branch_prices',
  'cl_branch_stock', 'cl_branches', 'cl_businesses', 'cl_cashbook_entries', 'cl_catalogue_images', 'cl_catalogue_products',
  'cl_credit_bf', 'cl_credit_holds', 'cl_credit_overrides', 'cl_credit_payments', 'cl_customers', 'cl_dispatch_issues',
  'cl_dispatch_lines', 'cl_dispatch_log', 'cl_dispatches', 'cl_eod_closes', 'cl_interbranch_charges', 'cl_internal_transfer_lines',
  'cl_internal_transfers', 'cl_join_failures', 'cl_ledger_entries', 'cl_licence_redeem_failures', 'cl_licences', 'cl_listing_photo_trash',
  'cl_market_pack_images', 'cl_market_packs', 'cl_payment_voucher_lines', 'cl_payment_vouchers', 'cl_payouts', 'cl_plan_assignments',
  'cl_price_change_log', 'cl_rpn_assignments', 'cl_rpn_commissions', 'cl_rpn_link_failures', 'cl_rpn_payouts', 'cl_sale_returns',
  'cl_sales', 'cl_sales_daily', 'cl_shop_legacy_uploads', 'cl_shop_roles', 'cl_shop_staff', 'cl_shop_staff_events',
  'cl_shop_staff_sessions', 'cl_shop_staff_signin_fails', 'cl_stock_events', 'cl_supplier_grv_lines', 'cl_supplier_grvs', 'cl_suppliers',
  'cl_terminal_admin_seeds', 'cl_terminals', 'cl_till_allowance', 'cl_till_rights_log', 'cl_till_stock_levels', 'cl_till_stock_push',
  'cl_till_stock_state', 'cl_token_purchases', 'cl_token_uses', 'cl_trial_exceptions', 'cl_trial_refusals', 'cl_trials',
  'cl_vendor_messages', 'cl_vendors', 'cl_voucher_events', 'customers', 'itred_order_messages', 'itred_po_updates',
  'purchase_order_items', 'purchase_orders', 'rpn_onboarding_notes', 'vendor_listings', 'vendor_tokens', 'vendors']);

do $$
declare
  -- the kept tables' counts the owner was shown (inventory 27 Oct)
  v_expect jsonb := '{"cl_staff":2,"cl_staff_module_access":6,"portal_staff":2,"cl_rpn":2,"cl_rpn_pins":2,"cl_rpn_commission_rates":2,"cl_price_plans":2,"cl_price_plan_versions":8,"cl_app_settings":7,"cl_contact_desks":3,"cl_contact_numbers":5,"cl_chart_of_accounts":8,"cl_app_build_rule":1,"cl_activation_pricing":3,"cl_token_prices":4,"cl_modules":18,"cl_shop_meta":1}';
  v_have jsonb := '{}'; k text; n bigint; r record; total bigint := 0; users bigint; v_public int;
begin
  if (select count(*) from _purge_before) <> 78 then
    raise exception 'Purge 2 aborted: % of the 78 tables found. Nothing was changed.', (select count(*) from _purge_before);
  end if;
  select count(*) into v_public from pg_class t join pg_namespace s on s.oid = t.relnamespace where s.nspname = 'public' and t.relkind = 'r';
  if v_public <> 78 + 18 then
    raise exception 'Purge 2 aborted: public has % tables, the inventory had 96. Nothing was changed.', v_public;
  end if;
  for k in select jsonb_object_keys(v_expect) loop
    execute format('select count(*) from public.%I', k) into n;
    v_have := v_have || jsonb_build_object(k, n);
  end loop;
  raise notice 'KEPT BEFORE: %', v_have;
  if v_have <> v_expect then
    raise exception 'Purge 2 aborted: a kept table changed since it was shown (% vs %). Nothing was changed.', v_have, v_expect;
  end if;
  if (select count(*) from public.cl_vendors) <> 19 then
    raise exception 'Purge 2 aborted: cl_vendors has % rows, not the 19 shown. Nothing was changed.', (select count(*) from public.cl_vendors);
  end if;
  for r in select tbl from _purge_before loop
    execute format('select count(*) from public.%I', r.tbl) into n;
    execute format('update _purge_before set rows_n = %s where tbl = %L', n, r.tbl);
    total := total + n;
  end loop;
  select count(*) into users from auth.users;
  raise notice 'BEFORE: % rows in the 78 tables; auth.users %; cl_removed_devices %', total, users, (select count(*) from public.cl_removed_devices);
  raise notice 'BEFORE by table: %', (select jsonb_object_agg(tbl, rows_n) from _purge_before where rows_n > 0);
end $$;

-- 1. the installs to list (before the vendor rows go)
create temp table _purge_installs on commit drop as
select v.install_id inst, v.device_key dkey, v.id vid, v.business_id bid, v.business_name bname, v.device_code code,
       'Purge 2 (27 Oct): test vendor row deleted'::text reason, now() ts
  from public.cl_vendors v where nullif(btrim(coalesce(v.install_id, '')), '') is not null;
insert into _purge_installs (inst, vid, bname, code, reason, ts)
select x.inst, x.vid, x.name, x.code, 'purged 22 Oct (test-data purge; from the offline backup)', '2026-10-22T03:30:00Z'
  from (values
  ('8FJM', '7e16b58e-49b6-4d43-8ea0-2c61206c15b2'::uuid, 'Gara Bolts', '8FJM-C1'),
  ('DNPB', 'a8ce206f-d011-448e-b7dd-633a4d51c8a9'::uuid, 'Brechin Nursery', 'DNPB-C1'),
  ('LEXE', 'e8e4438f-2e4b-444e-92a6-e1ee957272ae'::uuid, 'IVO Dist', 'LEXE-C1'),
  ('H35R', 'faa5d2ea-a722-4e42-ab04-30ed8d3847df'::uuid, 'IVO Dist', 'H35R-C1'),
  ('SSMP', 'd2064509-da07-42c6-a30a-50c94f399695'::uuid, 'Spares Haven', 'SSMP-C1'),
  ('6BJ3', '66110f66-be42-4b44-a108-9044bdb1997f'::uuid, 'Warehouse', '6BJ3-C1'),
  ('SCBX', 'b631b40d-5651-4e49-86c1-9eecc77db246'::uuid, 'TnT', 'SCBX-C1'),
  ('B8ZU', 'dfca2388-a403-472d-b656-d6839cc5fa18'::uuid, 'Regis Auto', 'B8ZU-C1'),
  ('MSKR', 'cc5e1f88-9c9a-44c7-8ae9-7372ab9ca20a'::uuid, 'Malawi', 'MSKR-C1'),
  ('UES3', 'f4b48807-a2b8-4d8d-a244-eb2f29391b2d'::uuid, 'Haven', 'UES3-C1'),
  ('AFLU', '23e8314d-b580-4d7d-a6c2-564e16b838b3'::uuid, 'Temitope', 'AFLU-C1'),
  ('FD8R', 'b6268408-f7ee-4c30-a2ab-e0b73df721af'::uuid, 'Lazy One Shoes', 'FD8R-C1'),
  ('S7BP', '08161b7b-2d94-463b-a5e4-7927426651d8'::uuid, 'Lazy One Shoes', 'S7BP-C1'),
  ('KUFP', 'a82c3ee2-c5a9-4ba8-971f-6f5c23a2dbc2'::uuid, 'Mandie Babyware', 'KUFP-C1'),
  ('X5TR', 'e7cc1119-1e73-4045-9496-9ae63a59381c'::uuid, 'Mandie Babyware', 'X5TR-C1'),
  ('43AL', 'c25b0c89-ae58-41a8-b726-691c3a18d51e'::uuid, 'Mandie Babyware', '43AL-C1'),
  ('D838', 'f5c23bf5-78db-4659-94d6-e13b0c898428'::uuid, 'Mandie Babyware', 'D838-C1'),
  ('AYYB', '8d5917ef-8df8-4361-bf7a-a37c1a96da82'::uuid, 'KNIX Phones', 'AYYB-C1'),
  ('5NGB', 'af88e375-1da6-4bd5-b03b-1fc3d4bc11a8'::uuid, 'KNIX Phones', '5NGB-C1'),
  ('LFQ3', '05c4a0bb-a7f3-4d97-bb7b-668640acee68'::uuid, 'KNIX Phones', 'LFQ3-C1'),
  ('ZAY6', '6784b2a9-408c-4dcf-9dc9-670f0fdee4e4'::uuid, 'KNIX Phones', 'ZAY6-C1'),
  ('VYZ4', '0348fd71-9b75-43c7-b1a5-395bb9afa16d'::uuid, 'KNIX Phones', 'VYZ4-C1'),
  ('UVJL', 'dd6e77c8-1344-4064-a6f1-0b0df2c65726'::uuid, 'KNIX Phones', 'UVJL-C1'),
  ('DLXR', 'd1494341-42d3-4dc1-81d7-b7f73c45a205'::uuid, 'Digital Commerce', 'DLXR-C1'),
  ('XPJ3', '25e3b3cd-812c-4a82-9f61-34df5450e40c'::uuid, 'Dixie Shoes', 'XPJ3-C1'),
  ('C3DP', '93c6bda5-de0d-4527-8e7a-62795d4be2f6'::uuid, 'Gentronix', 'C3DP-C1'),
  ('3XUX', 'f7c0e660-e5a6-40b9-b019-887aba94b096'::uuid, 'Gentronix', '3XUX-C1'),
  ('K4A8', '015548cf-ff0b-41bf-8309-4251216cf000'::uuid, 'Gentronix', 'K4A8-C1'),
  ('YMXJ', '5e537467-53cd-4e63-82f4-1059487c64e8'::uuid, 'Gentronix', 'YMXJ-C1'),
  ('FZD5', '4017ce03-1b25-4e39-b443-e4c34d5e8f2c'::uuid, 'Gentronix', 'FZD5-C1'),
  ('8PKX', '840b0fd3-1513-498a-a141-e75257a94f42'::uuid, 'Gentronix', '8PKX-C1'),
  ('HDMZ', 'fec450d8-75b1-4b6b-ac50-1d873dd24015'::uuid, 'John Hardware', 'HDMZ-C1'),
  ('9XCT', 'cc2f0de2-012c-4d7f-baa5-194eca6aa857'::uuid, 'Gentronix', '9XCT-C1'),
  ('6Y8L', 'ee289a5d-0d7a-44b5-86ed-f2e52868128f'::uuid, 'Gentronix', '6Y8L-C1'),
  ('EM6P', '0768d3b3-d4f9-474c-8b8c-e61418407731'::uuid, 'Weldone Ent', 'EM6P-C1'),
  ('ZEYS', '75615a7b-63de-4bf2-8c87-fbfcf4898de2'::uuid, 'AMA Wholesale', 'ZEYS-C1'),
  ('2KBZ', '77979d29-b2d7-4f47-826e-b9f11181d94d'::uuid, 'Chipo Clothing', '2KBZ-C1'),
  ('HG58', 'bb8d2468-3e57-4596-8a8a-26f9849abce3'::uuid, 'Chipo Clothing', 'HG58-C1'),
  ('DMWU', '9d4cb3df-bf25-4754-abb0-3979102c25e1'::uuid, 'Today & Tomorrow', 'DMWU-C1'),
  ('ESUS', '810c46fe-25f9-43fd-9361-0b95cf4e6db0'::uuid, 'Soko Tradings', 'ESUS-C1'),
  ('S2EZ', 'ff590f67-41ce-42af-ac60-eec74dd399df'::uuid, 'Gentronix', 'S2EZ-C1'),
  ('5TYX', '5d73c7ad-c28e-477d-a7df-ddcefb8f6616'::uuid, 'Gentronix', '5TYX-C1'),
  ('QM4Y', '8a7132e4-b26f-4ab4-8769-0f321f4d85f8'::uuid, 'Gentronix', 'QM4Y-C1'),
  ('THST', 'd13e1a58-42e5-462d-b569-567091d74731'::uuid, 'Gentronix', 'THST-C1'),
  ('2NGB', 'c99bfa41-8236-4877-912c-bc29f1419177'::uuid, 'Gentronix', '2NGB-C1'),
  ('V5RB', 'd62fcb10-f9c9-4896-97ca-4104cfe45c7a'::uuid, 'Gentronix', 'V5RB-C1'),
  ('PQRV', 'dc7b5ce5-1da4-4e46-94c2-7d7579500bd8'::uuid, 'Gentronix', 'PQRV-C1'),
  ('M4FG', 'fc3161ca-cd4e-4a67-86b3-33f91f64ff01'::uuid, 'Gentronix', 'M4FG-C1'),
  ('J4SN', '808c98df-abc8-4be0-8dde-41f500cdf02e'::uuid, 'Gentronix', 'J4SN-C1'),
  ('ZA5X', 'ea859554-e06d-4c6e-a630-287c26d1e5af'::uuid, 'Gentronix', 'ZA5X-C1'),
  ('QM7X', 'f576710c-8dc2-410c-be15-9667234a5b56'::uuid, 'Gentronix', 'QM7X-C1'),
  ('MAYQ', '0327222e-2532-40d6-b60d-a293883ecd4f'::uuid, 'Today & Tomorrow Parts', 'MAYQ-C1'),
  ('837D', 'f702be0b-6cbf-4e5d-9833-6aa9e69952a2'::uuid, 'Million Styles', '837D-C1'),
  ('5DJA', '68388cd5-f5ab-4bf1-a1e2-4ed4075b553e'::uuid, 'DEMO Company', '5DJA-C1'),
  ('WLK2', '637bde25-3038-4238-b3ad-26c19b872c91'::uuid, 'DEMO Shop', 'WLK2-C1'),
  ('7Y33', '9ebb6412-510d-430c-97a2-b4fb0b72ce82'::uuid, 'DEMO Shop', '7Y33-C1'),
  ('JCU7', '2d6c3fd5-c99d-4edd-a956-027017c7a1dc'::uuid, 'Horus', 'JCU7-C1'),
  ('MNWA', '9e1dfe3c-3057-444a-b74e-28f930ff6cb1'::uuid, 'Gentronix', 'MNWA-C1'),
  ('NSFF', 'ab6a673c-66ae-4759-b2cf-356f802d2af0'::uuid, 'Gentronix', 'NSFF-C1'),
  ('9VQR', 'bd37a545-1d93-4e1f-94ae-f4816301ad86'::uuid, 'Gentronix', '9VQR-C1'),
  ('PACF', '245c0bf7-7dd7-4f9c-8d88-4cdd92327405'::uuid, 'Gentronix', 'PACF-C1'),
  ('66YX', 'baaae095-9723-4cb8-a459-303449d0d180'::uuid, 'Gentronix', '66YX-C1'),
  ('D9MM', '8999d4cc-ae71-4fa0-8c73-a5107b8f76f1'::uuid, 'Gentronix', 'D9MM-C1'),
  ('R9SR', 'c12e7141-c883-4b7d-8de2-c35bd65181f5'::uuid, 'Gentronix', 'R9SR-C1'),
  ('JA97', '21b2ceac-c8fb-4e2c-bcaf-719d9b6b1195'::uuid, 'Gentronix', 'JA97-C1'),
  ('SDWD', '66f114c8-ecbe-4073-9ff0-d92a9fc44e69'::uuid, 'Gentronix', 'SDWD-C1'),
  ('GWK3', 'add6bf7b-a738-4697-a8a0-de7c134a5627'::uuid, 'Gentronix', 'GWK3-C1'),
  ('CBQP', '8cdf6133-58f9-408a-9d68-d0a50b1522b1'::uuid, 'Gentronix', 'CBQP-C1'),
  ('NEKF', '64c06d60-38c3-4e26-8ee0-e1137e45743b'::uuid, 'DEMO Shop', 'NEKF-C1'),
  ('B44P', '96e73ba0-7346-4c17-b739-e3f1580ba09d'::uuid, 'Gentronix', 'B44P-C1'),
  ('4P9M', 'b77b01a9-4d8f-4dbb-968f-10b8e8bad2bf'::uuid, 'Gentronix', '4P9M-C1'),
  ('NFXF', '8c661bdf-a541-487a-9ad7-9858b0084e4f'::uuid, 'Gentronix', 'NFXF-C1'),
  ('VPQX', '7bd25399-aa6b-4181-b812-3efe44fed697'::uuid, 'Gentronix', 'VPQX-C1'),
  ('AYUD', 'b0b9649e-4021-43ed-9107-1b81fb7e1488'::uuid, 'Gentronix', 'AYUD-C1'),
  ('GBY7', '96315590-adbf-4824-aa9e-6e1eca7c7f3a'::uuid, 'Gentronix', 'GBY7-C1'),
  ('AP7X', 'c311af53-7838-4b54-8e51-c970e5b3b0ef'::uuid, 'Gentronix', 'AP7X-C1'),
  ('PEXE', '3c4493ac-3803-475e-ba55-12df6d3d54c7'::uuid, 'Gentronix', 'PEXE-C1'),
  ('NJJF', 'a59dcff0-b176-4ed3-bb4e-b14c7106ed18'::uuid, 'IVO Motor Spares', 'NJJF-C1'),
  ('Q3AJ', 'eb3d17b7-4d99-46b3-91c4-c1b3629afca4'::uuid, 'Gentronix', 'Q3AJ-C1'),
  ('VNKT', '6b337217-ee0e-4509-9e6d-da3f90e7393a'::uuid, 'Gentronix', 'VNKT-C1'),
  ('ZS9Z', '786218e5-0d1e-42ac-810d-709bd38cc101'::uuid, 'IVO Motor Spares', 'ZS9Z-C1'),
  ('5T9D', 'd3b50864-5257-4c07-bf08-eecc5354a1d3'::uuid, 'IVO Motor Spares', '5T9D-C1'),
  ('BEW9', '735bcb0c-4123-4c94-b994-b0b6924f0e37'::uuid, 'Gentronix', 'BEW9-C1'),
  ('UTWK', '2636beff-6d12-4550-a83a-8b411afb71f8'::uuid, 'Gentronix', 'UTWK-C1'),
  ('76VK', 'd1253867-ede7-4934-ad5c-7a4a1544b217'::uuid, 'Gentronix', '76VK-C1'),
  ('JL3N', 'c9843f39-5d85-4637-8044-27b63690fb8e'::uuid, 'Gentronix', 'JL3N-C1'),
  ('WACE', '5242f746-daab-4b21-9580-1a877a2191dd'::uuid, 'Gentronix', 'WACE-C1'),
  ('QYEK', 'f62b04e4-5fa0-4361-9f5e-b9699dee8850'::uuid, 'Gentronix', 'QYEK-C1'),
  ('CDYT', 'b3cb0834-719b-479c-872a-19e55350c4c8'::uuid, 'Gentronix', 'CDYT-C1'),
  ('NJ4R', 'a97629ff-0cd7-48e5-a337-f7490ac4953c'::uuid, 'Gentronix', 'NJ4R-C1'),
  ('DSFS', 'c40aa0f8-d177-4609-a0db-84e4893b43c4'::uuid, 'Gentronix', 'DSFS-C1'),
  ('7SLJ', '1d1df660-78fa-44b4-8dd6-1286f0ea68e4'::uuid, 'Gentronix', '7SLJ-C1'),
  ('YVYR', '36d18cf1-0e5d-4657-82ee-357da89a81d2'::uuid, 'Gentronix', 'YVYR-C1'),
  ('T2BS', 'd14dc5a2-4000-4f73-bc78-26b07b06a1be'::uuid, 'Gentronix', 'T2BS-C1'),
  ('X8KS', 'ba02ccf7-2436-443c-acab-787d2352f97a'::uuid, 'Gentronix', 'X8KS-C1'),
  ('JJVF', '5df23ae0-6a4f-4553-b047-c0be9cdfd226'::uuid, 'Gentronix', 'JJVF-C1'),
  ('N7WE', 'bcea0a70-d5f7-494a-a443-4c4f58f2e4c8'::uuid, 'Gentronix', 'N7WE-C1'),
  ('B8W7', '53045ac8-eb46-40c4-8fd0-748d61e37624'::uuid, 'Gentronix', 'B8W7-C1'),
  ('VEZG', '8ad65f2c-77c9-4ecc-8485-1f59d4318e1d'::uuid, 'Gentronix', 'VEZG-C1'),
  ('9JGN', 'c39f5b2a-7f73-4906-8954-0de8cad31742'::uuid, 'Gentronix', '9JGN-C1'),
  ('EZ96', '66839930-beb7-4888-af5c-4100f3f137d4'::uuid, 'IVO Motor Spares', 'EZ96-C1'),
  ('9H8F', '8b636d3b-c80f-4929-a648-9d893f4b778c'::uuid, 'INI SHONS', '9H8F-C1'),
  ('BHB5', '4fe4861f-3bfc-4835-9890-dc89876883b9'::uuid, 'IVO Motor Spares', 'BHB5-C1'),
  ('PFL8', '0ace6b02-97b7-43d9-9e92-065a3d3d6b2e'::uuid, 'NOBSTAR RADIATORS', 'PFL8-C1'),
  ('BBVK', 'e8139057-6305-4842-b1eb-ffa684cf1fda'::uuid, 'Gentronix', 'BBVK-C1'),
  ('JU5F', 'dc852e79-29c4-42af-9065-581903e4dd31'::uuid, 'Gentronix', 'JU5F-C1'),
  ('9GA2', '4ef4b924-6eb9-4137-b21a-75adf153d922'::uuid, 'Gentronix', '9GA2-C1'),
  ('HH3N', 'b857ef9c-f81b-45ab-9a33-6288f0dd62f9'::uuid, 'Gentronix', 'HH3N-C1'),
  ('J25C', 'bdebf042-7f54-48b4-b5a9-e886008d5ae0'::uuid, 'Gentronix', 'J25C-C1'),
  ('ZF8V', '930de4f6-ae8e-40f3-8c9c-fa4abb7f05b7'::uuid, 'Gentronix', 'ZF8V-C1'),
  ('FSB6', '90f49670-6d99-4311-b650-e8c9dc8755e3'::uuid, 'Gentronix', 'FSB6-C1'),
  ('L9CZ', 'a68da156-5f57-4cd5-ba1c-4cb394152b16'::uuid, 'Gentronix', 'L9CZ-C1'),
  ('EFWF', 'ca599771-cd01-4e9d-97cf-0f65515789d4'::uuid, 'Gentronix', 'EFWF-C1'),
  ('7F4N', 'a8de5fc4-1d79-4778-acee-656cd0666848'::uuid, 'Gentronix', '7F4N-C1'),
  ('KU2N', 'bb31a6cc-7391-4a70-9c49-f855a90005dd'::uuid, 'Gentronix', 'KU2N-C1'),
  ('2PU4', '936a649f-074d-4d45-a1c5-dd99c890f618'::uuid, 'Gentronix', '2PU4-C1'),
  ('G8MG', '716010f5-41e0-4342-9ee4-6d689cca3b05'::uuid, 'Gentronix', 'G8MG-C1'),
  ('B8F6', '61881079-9e5a-4326-965f-dc7ec4498739'::uuid, 'Gentronix', 'B8F6-C1'),
  ('3XE5', '0f82a9e1-19ad-485d-bf70-ae5350439ca5'::uuid, 'Gentronix', '3XE5-C1'),
  ('U8DA', '099cb2ba-dec9-4213-afa9-79c85a266326'::uuid, 'Gentronix', 'U8DA-C1'),
  ('P6JH', '9fa510a7-a19d-4665-8c64-c1585dede2e7'::uuid, 'Gentronix', 'P6JH-C1'),
  ('6CVC', '640f8cc8-2c2e-4ae0-baaf-3b11f26bae32'::uuid, 'Gentronix', '6CVC-C1'),
  ('6RQZ', '2ac580a5-fce8-48e9-8790-72d44087f68d'::uuid, 'Gentronix', '6RQZ-C1'),
  ('FDB9', '1fad2ee3-1b1a-43ab-90b8-06ccb3578ef6'::uuid, 'Gentronix', 'FDB9-C1'),
  ('8FH3', 'a36a66ed-e837-401e-a93f-d27f7bcaf3f8'::uuid, 'NOBSTAR RADIATORS', '8FH3-C1'),
  ('RGBP', '86d2c1e1-9afc-45a7-bd8b-a45e422e7d57'::uuid, 'Claremont Nursery', 'RGBP-C1'),
  ('3FSF', '2e500371-2ae8-4b11-9209-a4c67e563b03'::uuid, 'Gentronix', '3FSF-C1'),
  ('6ZRF', '2e422e94-6c49-472e-b978-e421eba67d7e'::uuid, 'Gentronix', '6ZRF-C1'),
  ('QD3Y', 'eb9a9196-8ebe-498c-b778-d1b314f80f66'::uuid, 'Gentronix', 'QD3Y-C1'),
  ('YHWE', '5d7daae9-8bd1-456d-906f-ef4feca4ec16'::uuid, 'Gentronix', 'YHWE-C1'),
  ('C7KL', 'df935103-f30b-46bc-a12c-3183923ece92'::uuid, 'Gentronix', 'C7KL-C1'),
  ('UQN5', 'dca39001-cb80-4ba9-af1e-3949a87ea33b'::uuid, 'Gentronix', 'UQN5-C1'),
  ('5RBW', '8048a277-fb5d-459f-a943-86a97f6f77f8'::uuid, 'Gentronix', '5RBW-C1'),
  ('EMQH', '21be4e38-18e4-4d7b-b0b7-fa86e21429ea'::uuid, 'Gentronix', 'EMQH-C1'),
  ('T3SW', 'ce6ef4b9-c71f-48d8-9209-165fc7f13034'::uuid, 'Gentronix', 'T3SW-C1'),
  ('59NU', '50640bf5-4be8-4895-8daa-e5c6bd679ab2'::uuid, 'Gentronix', '59NU-C1'),
  ('AMTM', 'd71fb9fb-23fc-4cb3-b3ff-0de759102f51'::uuid, 'Gentronix', 'AMTM-C1'),
  ('CZFF', 'ec9d62db-1371-4644-b973-c6baa4aba0f9'::uuid, 'Gentronix', 'CZFF-C1'),
  ('PKGM', '1fb5fdfa-e620-4576-ad41-ffdd9f3bd562'::uuid, 'Gentronix', 'PKGM-C1'),
  ('37ZN', '1050829a-b89f-4bae-afa5-f2cecbd9d3fe'::uuid, 'Gentronix', '37ZN-C1'),
  ('67XR', '0e65ed5f-be12-4049-a35c-0f6b8949e3e2'::uuid, 'Gentronix', '67XR-C1'),
  ('Z8WV', '231cba0d-eb54-401e-b9c0-0178a804835f'::uuid, 'Gentronix', 'Z8WV-C1'),
  ('S22Z', 'e902a90b-8dff-4d5d-8aea-2eaabd17d2d3'::uuid, 'Gentronix', 'S22Z-C1'),
  ('96XJ', 'dc51c610-7564-4a8e-82e7-a59b74a64634'::uuid, 'Gentronix', '96XJ-C1'),
  ('ZUYK', '856e98f9-6ce6-4001-95e5-d6d515cd583e'::uuid, 'Gentronix', 'ZUYK-C1'),
  ('ABHB', '89c13a61-a409-4a67-9301-e166394422de'::uuid, 'Gentronix', 'ABHB-C1'),
  ('4VXX', '4f7a08f6-c5e2-4b01-9b1e-0786a7df39c0'::uuid, 'Gentronix', '4VXX-C1'),
  ('B9D8', '4f5dd552-a763-4c47-9f9f-18f5a47be3ad'::uuid, 'Gentronix', 'B9D8-C1')
  ) x(inst, vid, name, code)
 where not exists (select 1 from _purge_installs p where p.inst = x.inst);

-- 2. the purge
truncate table
  public.cl_activation_codes, public.cl_activity_log, public.cl_b4_runs, public.cl_branch_join_codes, public.cl_branch_local_products,
  public.cl_branch_prices, public.cl_branch_stock, public.cl_branches, public.cl_businesses, public.cl_cashbook_entries,
  public.cl_catalogue_images, public.cl_catalogue_products, public.cl_credit_bf, public.cl_credit_holds, public.cl_credit_overrides,
  public.cl_credit_payments, public.cl_customers, public.cl_dispatch_issues, public.cl_dispatch_lines, public.cl_dispatch_log,
  public.cl_dispatches, public.cl_eod_closes, public.cl_interbranch_charges, public.cl_internal_transfer_lines, public.cl_internal_transfers,
  public.cl_join_failures, public.cl_ledger_entries, public.cl_licence_redeem_failures, public.cl_licences, public.cl_listing_photo_trash,
  public.cl_market_pack_images, public.cl_market_packs, public.cl_payment_voucher_lines, public.cl_payment_vouchers, public.cl_payouts,
  public.cl_plan_assignments, public.cl_price_change_log, public.cl_rpn_assignments, public.cl_rpn_commissions, public.cl_rpn_link_failures,
  public.cl_rpn_payouts, public.cl_sale_returns, public.cl_sales, public.cl_sales_daily, public.cl_shop_legacy_uploads,
  public.cl_shop_roles, public.cl_shop_staff, public.cl_shop_staff_events, public.cl_shop_staff_sessions, public.cl_shop_staff_signin_fails,
  public.cl_stock_events, public.cl_supplier_grv_lines, public.cl_supplier_grvs, public.cl_suppliers, public.cl_terminal_admin_seeds,
  public.cl_terminals, public.cl_till_allowance, public.cl_till_rights_log, public.cl_till_stock_levels, public.cl_till_stock_push,
  public.cl_till_stock_state, public.cl_token_purchases, public.cl_token_uses, public.cl_trial_exceptions, public.cl_trial_refusals,
  public.cl_trials, public.cl_vendor_messages, public.cl_vendors, public.cl_voucher_events, public.customers,
  public.itred_order_messages, public.itred_po_updates, public.purchase_order_items, public.purchase_orders, public.rpn_onboarding_notes,
  public.vendor_listings, public.vendor_tokens, public.vendors;

delete from auth.users;

-- 3. the removed-devices list
insert into public.cl_removed_devices (install_id, device_key, vendor_id, business_id, business_name, device_code, reason, removed_ts)
select inst, dkey, vid, bid, bname, code, reason, ts from _purge_installs
on conflict (install_id) do nothing;

do $$
declare
  v_expect jsonb := '{"cl_staff":2,"cl_staff_module_access":6,"portal_staff":2,"cl_rpn":2,"cl_rpn_pins":2,"cl_rpn_commission_rates":2,"cl_price_plans":2,"cl_price_plan_versions":8,"cl_app_settings":7,"cl_contact_desks":3,"cl_contact_numbers":5,"cl_chart_of_accounts":8,"cl_app_build_rule":1,"cl_activation_pricing":3,"cl_token_prices":4,"cl_modules":18,"cl_shop_meta":1}';
  v_have jsonb := '{}'; k text; n bigint; r record; left_over text := ''; users bigint; v_missing bigint;
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
  select count(*) into v_missing from _purge_installs p where not exists (select 1 from public.cl_removed_devices d where d.install_id = p.inst);
  raise notice 'AFTER: left over: %; auth.users %', coalesce(nullif(left_over, ''), 'none'), users;
  raise notice 'KEPT AFTER: %', v_have;
  raise notice 'REMOVED LIST: % rows; installs to list % (from the vendor rows %, purged 22 Oct %), not listed %',
    (select count(*) from public.cl_removed_devices), (select count(*) from _purge_installs),
    (select count(*) from _purge_installs where reason like 'Purge 2%'), (select count(*) from _purge_installs where reason like 'purged 22 Oct%'), v_missing;
  if left_over <> '' or users <> 0 or v_have <> v_expect or v_missing <> 0
     or (select count(*) from _purge_installs where reason like 'Purge 2%') <> 19 then
    raise exception 'Purge 2 aborted: the result is not what was shown. Nothing was changed.';
  end if;
  insert into public.cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'test_data_purge', 'public', null,
          jsonb_build_object('reason', 'Purge 2, owner 2026-10-27: all businesses, vendors, tills and iTred accounts on live were test data; kept: Console staff, portal staff, RPNs, price plans, company and platform settings, Contact directory, chart of accounts; their devices added to cl_removed_devices',
                             'rows_by_table', (select jsonb_object_agg(tbl, rows_n) from _purge_before where rows_n > 0),
                             'rows', (select sum(rows_n) from _purge_before),
                             'removed_devices', (select count(*) from public.cl_removed_devices)));
end $$;

commit;
