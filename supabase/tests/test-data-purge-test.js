// node supabase/tests/test-data-purge-test.js
//
// Tests supabase/data-fixes/20261022_test_data_purge.sql in PGlite (the live
// shape, never the live database): two test businesses (main + remote, staff
// on seiGEN), an iTred vendor and customer sign-up; then the purge:
//   - every one of the 65 tables is empty, auth.users is empty;
//   - the 15 kept tables are exactly as before (Console staff, RPNs, settings);
//   - one activity-log line records it (counts only);
//   - when a kept table's count isn't what the owner was shown, it refuses and
//     changes nothing;
//   - afterwards a new business registers from scratch.
// The kept counts in the file are live's (2026-10-22 inventory); this test
// puts in its own database's counts, the same way.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newPglite, buildFromRepo, v21AdminSeed } = require('./rebuild-helpers');

const FIX = fs.readFileSync(path.join(__dirname, '..', 'data-fixes', '20261022_test_data_purge.sql'), 'utf8').replace(/\r\n/g, '\n');
const KEEP = ['cl_staff', 'cl_staff_module_access', 'cl_modules', 'portal_staff', 'cl_rpn', 'cl_rpn_pins', 'cl_rpn_commission_rates', 'cl_app_settings',
  'cl_app_build_rule', 'cl_activation_pricing', 'cl_price_plans', 'cl_price_plan_versions', 'cl_chart_of_accounts', 'cl_token_prices', 'cl_shop_meta'];
const PURGE = JSON.parse(/array\[([\s\S]*?)\]\);/.exec(FIX)[1].replace(/'/g, '"').replace(/\s+/g, '').replace(/^/, '[').replace(/$/, ']'));

let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); } };
const hex = (n = 32) => crypto.randomBytes(n / 2).toString('hex');
const J = (x) => JSON.stringify(x);

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: ['20261111120000_contact_directory.sql', '20261112120000_builtin_customers.sql', '20261113120000_sales_sync.sql',
    '20261113180000_removed_devices.sql', '20261114120000_roles_everywhere.sql', '20261115120000_stock_control.sql', '20261116120000_vendor_register_status.sql'] });   // the live shape the purge ran on (22 Oct 05:42, before 6A)
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const PHRASE = { AA: 'Alpha Phrase', BB: 'Beta Phrase', NN: 'New Phrase' };
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
    await pg.exec('set role anon');
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  const auth = (iid) => ({ p_install_id: iid, p_secret_phrase: PHRASE[iid.slice(0, 2)], p_device_key: key(iid) });
  const register = async (iid, biz, branch) => (await anon('cl_branch_register', { ...auth(iid), p_business_name: biz, p_branch_name: branch })).j;
  const code = async (iid, o) => { const s = v21AdminSeed('admin-pass-1'); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j.code; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 33 })).j;
  const pull = (iid) => anon('cl_device_staff_pull', auth(iid));
  const counts = async (tables) => { const o = {}; for (const t of tables) o[t] = Number((await q(`select count(*) n from public.${t}`))[0].n); return o; };
  const withExpect = (sql, keep) => sql.replace(/v_expect jsonb := '\{[^']*\}'/g, `v_expect jsonb := '${J(keep)}'`);
  const run = async (sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };

  // ---- the test data ----
  const A = await register('AA01', 'Alpha Shop', 'Harare');
  ok('(seed: Alpha registers its main branch)', !!(A && A.business_id), J(A));
  ok('(seed: a remote joins Alpha)', !!(await join('AA02', await code('AA01', { p_new_branch_name: 'Norton' }))).branch_id);
  ok('(seed: Alpha\'s roles on seiGEN)', !(await pull('AA01')).e);
  ok('(seed: Beta registers)', !!(await register('BB01', 'Beta Shop', 'Mutare')).business_id);
  const uid = '00000000-0000-4000-8000-000000000001';
  await q(`insert into auth.users (id, email) values ($1, 'test@example.com'), ('00000000-0000-4000-8000-000000000002', 'half@example.com')`, [uid]);
  await q(`insert into public.customers (id, email, full_name) values ($1, 'test@example.com', 'Test Buyer')`, [uid]);
  await q(`insert into public.vendors (install_id, business_name) values ('AA01', 'Alpha Shop')`);
  const keep0 = await counts(KEEP);
  const purge0 = await counts(PURGE);
  ok('the file names 65 tables to empty, and the database has 65 + 15 tables', PURGE.length === 65
    && Number((await q(`select count(*) n from pg_class t join pg_namespace s on s.oid = t.relnamespace where s.nspname = 'public' and t.relkind = 'r'`))[0].n) === 80);
  ok('(seed: the business tables have rows)', purge0.cl_businesses === 2 && purge0.cl_terminals === 3 && purge0.cl_vendors >= 3 && purge0.cl_shop_roles > 0 && purge0.vendors === 1, J(purge0));

  // ---- a kept table not as shown: refused, nothing changed ----
  let r = await run(withExpect(FIX, Object.assign({}, keep0, { cl_staff: keep0.cl_staff + 1 })));
  ok('a kept count not as shown: refused', !!r.e && /a kept table changed since it was shown/.test(r.e), r.e);
  ok('... and nothing was changed', J(await counts(PURGE)) === J(purge0) && Number((await q(`select count(*) n from auth.users`))[0].n) === 2);

  // ---- the purge ----
  r = await run(withExpect(FIX, keep0));
  ok('the purge runs', r.ok, r.e);
  const after = await counts(PURGE);
  const left = Object.entries(after).filter(([t, n]) => n && !(t === 'cl_activity_log' && n === 1));
  ok('every one of the 65 tables is empty (the activity log holds only the purge line)', left.length === 0, J(left));
  ok('auth.users is empty (the iTred sign-ups, with their profiles)', Number((await q(`select count(*) n from auth.users`))[0].n) === 0);
  ok('the 15 kept tables are exactly as before', J(await counts(KEEP)) === J(keep0), J(await counts(KEEP)) + ' vs ' + J(keep0));
  const log = await q(`select action, detail from public.cl_activity_log`);
  ok('one activity-log line: test_data_purge with the counts by table', log.length === 1 && log[0].action === 'test_data_purge'
    && log[0].detail.rows_by_table.cl_businesses === 2 && Number(log[0].detail.rows) === Object.values(purge0).reduce((a, b) => a + b, 0), J(log));
  ok('... names and phrases are not in it', !/Alpha|Beta|Phrase|example\.com/.test(J(log)));

  // ---- afterwards: a new business from scratch ----
  const N = await register('NN01', 'New Shop', 'Harare');
  ok('a new business registers its main branch afterwards', !!(N && N.business_id) && N.till_code === 'T1', J(N));
  const np = await pull('NN01');
  ok('... and gets its five built-in roles', !np.e && np.j && np.j.roles.length === 5, J(np));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
