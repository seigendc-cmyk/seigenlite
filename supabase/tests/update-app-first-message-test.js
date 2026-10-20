// node supabase/tests/update-app-first-message-test.js
//
// Tests supabase/migrations/20261023180000_update_app_first_message.sql (and
// its rollback) in an in-memory PGlite built from the repo (the live shape),
// never the live database:
//   - an app too old to send the Admin check value is told "This version of
//     the app is too old to add terminals. Update this app, then try again."
//     (the code UPDATE_MAIN_FIRST stays, so v21 still recognises it);
//   - a v21 request (with a check value) still gets a code;
//   - only that one function changes; grants stay; a second run is refused;
//   - B1 (20261024120000_branch_stock) still applies on top of it;
//   - the rollback restores the whole catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261023180000_update_app_first_message.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261023180000_update_app_first_message.rollback.sql'));
const B1 = READ(path.join(ROOT, 'migrations', '20261024120000_branch_stock.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 500) : '')); }
}
const seedOf = (passcode, rounds = 150000) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, check: crypto.pbkdf2Sync(passcode, Buffer.from(salt, 'hex'), rounds, 32, 'sha256').toString('hex'), rounds };
};
const run = async (pg, sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261024120000_branch_stock.sql', '20261106120000_branch_views.sql', '20261107120000_shop_roles.sql', '20261108120000_shop_managers_everywhere.sql']) });   // the shape just before it (all are on live now)
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
  const auth = (iid) => ({ p_install_id: iid, p_secret_phrase: 'Seed Phrase', p_device_key: key(iid) });

  await anon('cl_branch_register', { ...auth('MAIN'), p_business_name: 'Seed Shop', p_branch_name: 'Harare' });
  let r = await anon('cl_branch_issue_join_code', { ...auth('MAIN'), p_new_branch_name: 'Mbare' });
  ok('before: the old wording', /UPDATE_MAIN_FIRST: Update the main branch till first\./.test(r.e || ''), JSON.stringify(r));

  r = await run(pg, MIG);
  ok('it applies', r.ok, r.e);
  const d1 = diff(before, fingerprint(await snapshot(q)));
  ok('only cl_branch_issue_join_code changed (nothing added or dropped)',
    !d1.onlyA.length && !d1.onlyB.length && d1.changed.length === 1 && /cl_branch_issue_join_code/.test(d1.changed[0].key), JSON.stringify(d1).slice(0, 600));

  r = await anon('cl_branch_issue_join_code', { ...auth('MAIN'), p_new_branch_name: 'Mbare' });
  ok('an app too old to send the check value: the new wording, with the same code',
    /UPDATE_MAIN_FIRST: This version of the app is too old to add terminals\. Update this app, then try again\./.test(r.e || ''), JSON.stringify(r));
  ok('... and no branch or code was made',
    (await q(`select count(*)::int c from cl_branches where name = 'Mbare'`))[0].c === 0 && (await q(`select count(*)::int c from cl_branch_join_codes`))[0].c === 0);
  const S = seedOf('mbare-123');
  r = await anon('cl_branch_issue_join_code', { ...auth('MAIN'), p_new_branch_name: 'Mbare', p_admin_salt: S.salt, p_admin_check: S.check, p_admin_rounds: S.rounds });
  ok('v21 (with the check value): a code, as before', r.j && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.j.code), JSON.stringify(r));
  r = await anon('cl_branch_issue_join_code', { ...auth('NOBODY'), p_new_branch_name: 'X', p_admin_salt: S.salt, p_admin_check: S.check, p_admin_rounds: S.rounds });
  ok('a device that isn\'t a till is still refused as before', !!r.e && !/too old/.test(r.e), JSON.stringify(r));

  const can = async (role, fn) => (await q(`select has_function_privilege($1, $2, 'execute') x`, [role, fn]))[0].x;
  ok('devices (anon) may still call it', await can('anon', 'public.cl_branch_issue_join_code(text,text,text,uuid,text,int,text,text,int)'));

  r = await run(pg, MIG);
  ok('a second run is refused and changes nothing', /already there/.test(r.e || ''), r.e);

  // B1 comes after it
  const pg2 = await newPglite();
  await buildFromRepo(pg2, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261024120000_branch_stock.sql', '20261106120000_branch_views.sql', '20261107120000_shop_roles.sql', '20261108120000_shop_managers_everywhere.sql']) });
  r = await run(pg2, MIG);
  const r2 = await run(pg2, B1);
  ok('then 20261024120000_branch_stock applies on top of it', r.ok && r2.ok, (r.e || '') + (r2.e || ''));

  // ---- rollback ----
  r = await run(pg, RB);
  ok('the rollback applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  r = await anon('cl_branch_issue_join_code', { ...auth('MAIN'), p_new_branch_name: 'Avondale' });
  ok('after the rollback: the old wording again', /UPDATE_MAIN_FIRST: Update the main branch till first\./.test(r.e || ''), JSON.stringify(r));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
