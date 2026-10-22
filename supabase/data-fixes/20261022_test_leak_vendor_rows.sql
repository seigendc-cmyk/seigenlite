-- One-off DATA fix (no schema change): the 2 "Gentronix" vendor rows that
-- test/returns-e2e.test.js put on live during the full suite run of
-- 2026-10-22 (13:40 UTC, phone and desktop scenarios, install IDs LM88 and
-- DDG3). The test was meant to run with no server; fixed in 819a5c6.
-- Run only after the owner has seen this file and said "apply":
--   node tools/db/run-data-fix.js apply supabase/data-fixes/20261022_test_leak_vendor_rows.sql
-- Backup first: node tools/db/live-backup.js
--
-- A plain DELETE, so the normal guards run: cl_vendors_delete_guard refuses a
-- vendor with history, and cl_vendors_log_delete writes one 'vendor_deleted'
-- line per row to cl_activity_log (activity log 3 -> 5 rows).
-- It rolls itself back, changing nothing, if cl_vendors holds anything but
-- these 2 ids, if any other purged table or auth.users is no longer empty,
-- if the activity log isn't the purge line plus the 2 deletes of
-- 20261022_post_purge_vendor_rows.sql, or if a kept table's count differs
-- from the purge plan.
begin;

do $$
declare
  v_ids uuid[] := array['1c30d371-001b-4c23-850a-79aee50f6930', 'c181f736-b4e4-452a-9c8e-214472371fee']::uuid[];
  -- the kept tables' counts from the purge plan
  v_expect jsonb := '{"cl_staff":2,"cl_staff_module_access":6,"cl_modules":16,"portal_staff":2,"cl_rpn":2,"cl_rpn_pins":2,"cl_rpn_commission_rates":2,"cl_app_settings":6,"cl_app_build_rule":1,"cl_activation_pricing":3,"cl_price_plans":2,"cl_price_plan_versions":5,"cl_chart_of_accounts":8,"cl_token_prices":4,"cl_shop_meta":1}';
  v_have jsonb := '{}'; k text; n bigint; r record; v_other text := ''; v_deleted int;
begin
  -- 1. cl_vendors holds exactly these 2 rows, both from the test
  if (select count(*) from public.cl_vendors) <> 2
     or (select count(*) from public.cl_vendors where id = any (v_ids) and business_name = 'Gentronix' and business_id is null) <> 2 then
    raise exception 'test-leak vendor fix aborted: cl_vendors is not exactly the 2 Gentronix rows shown (% rows). Nothing was changed.',
      (select count(*) from public.cl_vendors);
  end if;
  -- 2. kept tables as planned
  for k in select jsonb_object_keys(v_expect) loop
    execute format('select count(*) from public.%I', k) into n;
    v_have := v_have || jsonb_build_object(k, n);
  end loop;
  raise notice 'KEPT BEFORE: %', v_have;
  if v_have <> v_expect then
    raise exception 'test-leak vendor fix aborted: a kept table changed (% vs %). Nothing was changed.', v_have, v_expect;
  end if;
  -- 3. every other public table is empty, apart from the 3 known log lines
  for r in select t.relname::text tbl from pg_class t join pg_namespace s on s.oid = t.relnamespace
           where s.nspname = 'public' and t.relkind = 'r' and t.relname <> 'cl_vendors'
             and not (v_expect ? t.relname::text) order by 1 loop
    execute format('select count(*) from public.%I', r.tbl) into n;
    if r.tbl = 'cl_activity_log' then
      if n <> 3 or (select count(*) from public.cl_activity_log where action = 'test_data_purge') <> 1
         or (select count(*) from public.cl_activity_log where action = 'vendor_deleted'
              and target_id in ('4a229719-97d6-4f88-9408-84349267c5c8', '3bdfc5dd-6599-4777-912a-0bcc20d24445')) <> 2 then
        v_other := v_other || ' cl_activity_log=' || n;
      end if;
    elsif n <> 0 then v_other := v_other || ' ' || r.tbl || '=' || n;
    end if;
  end loop;
  select count(*) into n from auth.users;
  if n <> 0 then v_other := v_other || ' auth.users=' || n; end if;
  if v_other <> '' then
    raise exception 'test-leak vendor fix aborted: something else appeared:%. Nothing was changed.', v_other;
  end if;
  raise notice 'BEFORE: cl_vendors 2 (the 2 Gentronix ids), every other purged table empty, auth.users 0, activity log 3';

  delete from public.cl_vendors where id = any (v_ids);
  get diagnostics v_deleted = row_count;

  if v_deleted <> 2 or (select count(*) from public.cl_vendors) <> 0 then
    raise exception 'test-leak vendor fix aborted: deleted % rows. Nothing was changed.', v_deleted;
  end if;
  if (select count(*) from public.cl_activity_log where action = 'vendor_deleted' and target_id = any (v_ids)) <> 2 then
    raise exception 'test-leak vendor fix aborted: the 2 delete log lines are missing. Nothing was changed.';
  end if;
  v_have := '{}';
  for k in select jsonb_object_keys(v_expect) loop
    execute format('select count(*) from public.%I', k) into n;
    v_have := v_have || jsonb_build_object(k, n);
  end loop;
  raise notice 'KEPT AFTER: %', v_have;
  if v_have <> v_expect then
    raise exception 'test-leak vendor fix aborted: a kept table changed during the fix. Nothing was changed.';
  end if;
  raise notice 'AFTER: cl_vendors 0, activity log % (2 more vendor_deleted lines)', (select count(*) from public.cl_activity_log);
end $$;

commit;
