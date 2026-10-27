// node supabase/tests/min-app-build-test.js
//
// Tests supabase/migrations/20261025120000_min_app_build.sql (and its
// rollback) in an in-memory PGlite built from the repo (the live shape),
// never the live database:
//   - the check-in answer carries min_build (21 to start) and update_required
//     (this till's build is below it); a till that sends no build is never told;
//   - the rest of the answer is as before; raising the rule is seen at once;
//   - devices can't read or change the rule; only the check-in and the new
//     table change; a second run is refused;
//   - the rollback restores the whole catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261025120000_min_app_build.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261025120000_min_app_build.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 500) : '')); }
}
const run = async (pg, sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261109120000_office_seats.sql', '20261110120000_staff_first_owner.sql', '20261112120000_builtin_customers.sql', '20261113120000_sales_sync.sql', '20261113180000_removed_devices.sql', '20261114120000_roles_everywhere.sql']) });   // the live shape
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || crypto.randomBytes(16).toString('hex'));
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    await pg.exec('set role anon');
    try { return { j: (await q(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) j`, names.map((n) => args[n])))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  const checkin = (iid, build) => anon('cl_device_checkin', { p_install_id: iid, p_shop_secret_phrase: 'Seed Phrase', p_device_code: null, p_business_name: 'Seed Shop', p_device_key: key(iid), p_app_build: build });

  await anon('cl_branch_register', { p_install_id: 'MAIN', p_secret_phrase: 'Seed Phrase', p_device_key: key('MAIN'), p_business_name: 'Seed Shop', p_branch_name: 'Harare' });
  let r0 = await checkin('MAIN', 22);
  ok('before: no min_build in the answer', r0.j && !('min_build' in r0.j), JSON.stringify(r0));

  let r = await run(pg, MIG);
  ok('it applies', r.ok, r.e);
  const d1 = diff(before, fingerprint(await snapshot(q)));
  const changedKeys = d1.changed.map((c) => c.key);
  ok('only cl_device_checkin changed; the rest added is the rule table', !d1.onlyA.length && changedKeys.length === 1 && /cl_device_checkin/.test(changedKeys[0]) &&
    d1.onlyB.length > 0 && d1.onlyB.every((k) => /cl_app_build_rule/.test(k)), JSON.stringify({ changedKeys, onlyA: d1.onlyA, onlyB: d1.onlyB }).slice(0, 800));

  r = await checkin('MAIN', 20);
  ok('a v20 till: min_build 21, update_required true', r.j && r.j.min_build === 21 && r.j.update_required === true, JSON.stringify(r));
  r = await checkin('MAIN', 21);
  ok('a v21 till: not required', r.j && r.j.update_required === false, JSON.stringify(r));
  r = await checkin('MAIN', 23);
  ok('a v23 till: not required', r.j && r.j.update_required === false && r.j.min_build === 21, JSON.stringify(r));
  r = await checkin('MAIN', null);
  ok('a till that sends no build is never told', r.j && r.j.update_required === false, JSON.stringify(r));
  const keysBefore = Object.keys(r0.j).sort(), keysAfter = Object.keys(r.j).filter((k) => k !== 'min_build' && k !== 'update_required').sort();
  ok('the rest of the answer has the same fields as before', JSON.stringify(keysBefore) === JSON.stringify(keysAfter) && r.j.terminal_active === true && r.j.business_id === r0.j.business_id,
    JSON.stringify({ keysBefore, keysAfter }));

  await q(`update cl_app_build_rule set min_build = 24, updated_ts = now()`);
  r = await checkin('MAIN', 23);
  ok('raising the rule to 24: a v23 till is told at its next check-in', r.j && r.j.min_build === 24 && r.j.update_required === true, JSON.stringify(r));
  await q(`delete from cl_app_build_rule`);
  r = await checkin('MAIN', 5);
  ok('no rule row: min_build 0, never required', r.j && r.j.min_build === 0 && r.j.update_required === false, JSON.stringify(r));
  await q(`insert into cl_app_build_rule (id, min_build, note) values (true, 21, 'back')`);
  const two = await run(pg, `insert into cl_app_build_rule (id, min_build) values (false, 1)`);
  ok('only one rule row can exist', !!two.e, JSON.stringify(two));

  const can = async (role, priv) => (await q(`select has_table_privilege($1, 'public.cl_app_build_rule', $2) x`, [role, priv]))[0].x;
  ok('devices (anon, authenticated) can\'t read or change the rule', !(await can('anon', 'select')) && !(await can('anon', 'update')) && !(await can('authenticated', 'select')));
  ok('the rule table has RLS on', (await q(`select relrowsecurity r from pg_class where oid = 'public.cl_app_build_rule'::regclass`))[0].r);
  ok('devices may still call check-in', (await q(`select has_function_privilege('anon', 'public.cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text,integer)', 'execute') x`))[0].x);

  r = await run(pg, MIG);
  ok('a second run is refused and changes nothing', /already there/.test(r.e || ''), r.e);

  r = await run(pg, RB);
  ok('the rollback applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  r = await checkin('MAIN', 20);
  ok('after the rollback: the answer as before', r.j && !('min_build' in r.j) && r.j.terminal_active === true, JSON.stringify(r));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
