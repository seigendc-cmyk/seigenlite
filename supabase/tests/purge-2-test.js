// node supabase/tests/purge-2-test.js
//
// Tests supabase/data-fixes/20261027_purge_2.sql in PGlite (the live shape,
// never the live database): two test businesses (main + remote, staff on
// seiGEN), an iTred vendor and customer sign-up, one install already on the
// removed list; then Purge 2:
//   - every one of the 78 tables is empty, auth.users is empty;
//   - the 17 kept tables are exactly as before (Console staff, RPNs, price
//     plans, settings, Contact directory, chart of accounts);
//   - every install of the vendor rows and the 148 installs purged on 22 Oct
//     are on the removed list, and the one already there is left as it was;
//   - one activity-log line records it (counts only);
//   - when a kept table's count isn't what the owner was shown, it refuses and
//     changes nothing;
//   - afterwards a removed device is refused (DEVICE_REMOVED) and a new
//     install registers a business from scratch.
// The kept counts and the vendor count in the file are live's (27 Oct
// inventory); this test puts in its own database's counts, the same way.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newPglite, buildFromRepo, v21AdminSeed, NOT_ON_LIVE_FILES } = require('./rebuild-helpers');

const FIX = fs.readFileSync(path.join(__dirname, '..', 'data-fixes', '20261027_purge_2.sql'), 'utf8').replace(/\r\n/g, '\n');
const KEEP = ['cl_staff', 'cl_staff_module_access', 'portal_staff', 'cl_rpn', 'cl_rpn_pins', 'cl_rpn_commission_rates', 'cl_price_plans',
  'cl_price_plan_versions', 'cl_app_settings', 'cl_contact_desks', 'cl_contact_numbers', 'cl_chart_of_accounts', 'cl_app_build_rule',
  'cl_activation_pricing', 'cl_token_prices', 'cl_modules', 'cl_shop_meta'];
const PURGE = JSON.parse(/array\[([\s\S]*?)\]\);/.exec(FIX)[1].replace(/'/g, '"').replace(/\s+/g, '').replace(/^/, '[').replace(/$/, ']'));
const OLD = [...FIX.matchAll(/^  \('([^']+)', '[0-9a-f-]{36}'::uuid, /gm)].map((m) => m[1]);

let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); } };
const hex = (n = 32) => crypto.randomBytes(n / 2).toString('hex');
const J = (x) => JSON.stringify(x);

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat(['20261115120000_stock_control.sql']) });   // the live shape on 27 Oct, before v37
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
  const register = (iid, biz, branch) => anon('cl_branch_register', { ...auth(iid), p_business_name: biz, p_branch_name: branch });
  const code = async (iid, o) => { const s = v21AdminSeed('admin-pass-1'); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j.code; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 36 })).j;
  const pull = (iid) => anon('cl_device_staff_pull', auth(iid));
  const counts = async (tables) => { const o = {}; for (const t of tables) o[t] = Number((await q(`select count(*) n from public.${t}`))[0].n); return o; };
  const one = async (sql, p) => Number((await q(sql, p))[0].n);
  const prep = (sql, keep, vendors) => sql.replace(/v_expect jsonb := '\{[^']*\}'/g, `v_expect jsonb := '${J(keep)}'`)
    .replace(/(from public\.cl_vendors\) <> )\d+/g, '$1' + vendors).replace(/(like 'Purge 2%'\) <> )\d+/g, '$1' + vendors);
  const run = async (sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };

  // ---- the test data ----
  const A = (await register('AA01', 'Alpha Shop', 'Harare')).j;
  ok('(seed: Alpha registers its main branch)', !!(A && A.business_id), J(A));
  ok('(seed: a remote joins Alpha)', !!(await join('AA02', await code('AA01', { p_new_branch_name: 'Norton' }))).branch_id);
  ok('(seed: Alpha\'s roles on seiGEN)', !(await pull('AA01')).e);
  ok('(seed: Beta registers)', !!(await register('BB01', 'Beta Shop', 'Mutare')).j.business_id);
  const uid = '00000000-0000-4000-8000-000000000001';
  await q(`insert into auth.users (id, email) values ($1, 'test@example.com'), ('00000000-0000-4000-8000-000000000002', 'half@example.com')`, [uid]);
  await q(`insert into public.customers (id, email, full_name) values ($1, 'test@example.com', 'Test Buyer')`, [uid]);
  await q(`insert into public.vendors (install_id, business_name) values ('AA01', 'Alpha Shop')`);
  await q(`insert into public.cl_removed_devices (install_id, reason, removed_ts) values ($1, 'already listed', '2026-10-22T16:12:09Z')`, [OLD[0]]);
  const installs = (await q(`select install_id from public.cl_vendors order by 1`)).map((r) => r.install_id);
  const keep0 = await counts(KEEP);
  const purge0 = await counts(PURGE);
  ok('the file names 78 tables to empty, and the database has 78 + 17 + the removed list', PURGE.length === 78
    && await one(`select count(*) n from pg_class t join pg_namespace s on s.oid = t.relnamespace where s.nspname = 'public' and t.relkind = 'r'`) === 96);
  ok('the file holds the 148 installs purged on 22 Oct', OLD.length === 148 && new Set(OLD).size === 148);
  ok('(seed: the business tables have rows)', purge0.cl_businesses === 2 && purge0.cl_terminals === 3 && installs.length === 3 && purge0.cl_shop_roles > 0 && purge0.vendors === 1, J(purge0));

  // ---- not as shown: refused, nothing changed ----
  let r = await run(prep(FIX, Object.assign({}, keep0, { cl_staff: keep0.cl_staff + 1 }), installs.length));
  ok('a kept count not as shown: refused', !!r.e && /a kept table changed since it was shown/.test(r.e), r.e);
  ok('... and nothing was changed', J(await counts(PURGE)) === J(purge0) && await one(`select count(*) n from auth.users`) === 2
    && await one(`select count(*) n from public.cl_removed_devices`) === 1);
  r = await run(prep(FIX, keep0, installs.length + 1));
  ok('a vendor count not as shown: refused', !!r.e && /cl_vendors has 3 rows/.test(r.e), r.e);

  // ---- Purge 2 ----
  r = await run(prep(FIX, keep0, installs.length));
  ok('Purge 2 runs', r.ok, r.e);
  const after = await counts(PURGE);
  const left = Object.entries(after).filter(([t, n]) => n && !(t === 'cl_activity_log' && n === 1));
  ok('every one of the 78 tables is empty (the activity log holds only the purge line)', left.length === 0, J(left));
  ok('auth.users is empty (the iTred sign-ups, with their profiles)', await one(`select count(*) n from auth.users`) === 0);
  ok('the 17 kept tables are exactly as before', J(await counts(KEEP)) === J(keep0), J(await counts(KEEP)) + ' vs ' + J(keep0));
  const listed = (await q(`select install_id, reason from public.cl_removed_devices`));
  const L = new Map(listed.map((x) => [x.install_id, x.reason]));
  ok('every install of the vendor rows is on the removed list', installs.every((i) => /^Purge 2/.test(L.get(i) || '')), J(listed.filter((x) => installs.includes(x.install_id))));
  ok('... and the 148 installs purged on 22 Oct', OLD.every((i) => L.has(i)) && listed.length === 148 + installs.length, String(listed.length));   // the one already listed is among the 148
  ok('... the one already listed is left as it was', L.get(OLD[0]) === 'already listed');
  const log = await q(`select action, detail from public.cl_activity_log`);
  ok('one activity-log line: test_data_purge with the counts by table', log.length === 1 && log[0].action === 'test_data_purge'
    && log[0].detail.rows_by_table.cl_businesses === 2 && Number(log[0].detail.rows) === Object.values(purge0).reduce((a, b) => a + b, 0), J(log));
  ok('... names and phrases are not in it', !/Alpha|Beta|Phrase|example\.com/.test(J(log)));

  // ---- afterwards ----
  const back = await register('AA01', 'Alpha Shop', 'Harare');
  ok('a removed device is refused (DEVICE_REMOVED)', !!back.e && /DEVICE_REMOVED/.test(back.e), J(back));
  const N = (await register('NN01', 'New Shop', 'Harare')).j;
  ok('a new install registers its main branch afterwards', !!(N && N.business_id) && N.till_code === 'T1', J(N));
  const np = await pull('NN01');
  ok('... and gets its six built-in roles (Guest included)', !np.e && np.j && np.j.roles.length === 6, J(np));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
