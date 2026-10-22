// node supabase/tests/admin-passcode-from-main-test.js
//
// Tests supabase/migrations/20261023120000_admin_passcode_from_main.sql (and
// its rollback) in an in-memory PGlite built from the repo (the live shape),
// never the live database:
//   - issuing a join code needs the new device's Admin check value (an older
//     main build is told "Update the main branch till first");
//   - joining from an app before v21 is refused ("Update this app first");
//     a code without a check value (issued before) answers ADMIN_SEED_MISSING;
//     the join answer carries the code's check value, also on a retried join;
//   - cl_terminal_admin_set: main-branch tills only, same business, not itself;
//     the check-in answer carries it ONCE; a newer one replaces it;
//   - no passcode is stored anywhere, the log carries no check value;
//   - grants; the rollback restores the whole catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261023120000_admin_passcode_from_main.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261023120000_admin_passcode_from_main.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 500) : '')); }
}
const seedOf = (passcode, rounds = 150000) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, check: crypto.pbkdf2Sync(passcode, Buffer.from(salt, 'hex'), rounds, 32, 'sha256').toString('hex'), rounds };
};

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261023180000_update_app_first_message.sql', '20261024120000_branch_stock.sql', '20261025120000_min_app_build.sql', '20261105120000_itred_order_fulfilment.sql', '20261106120000_branch_views.sql', '20261107120000_shop_roles.sql', '20261108120000_shop_managers_everywhere.sql', '20261109120000_office_seats.sql', '20261110120000_staff_first_owner.sql', '20261112120000_builtin_customers.sql']) });   // the shape just before it (it and the later ones are on live now)
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || crypto.randomBytes(16).toString('hex'));
  // a device RPC, as anon (the app's key): { j } or { e }
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    await pg.exec('set role anon');
    try { return { j: (await q(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) j`, names.map((n) => args[n])))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  const auth = (iid) => ({ p_install_id: iid, p_secret_phrase: 'Seed Phrase', p_device_key: key(iid) });

  let r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('it applies', r.ok, r.e);

  // the main branch registers (T1)
  r = await anon('cl_branch_register', { ...auth('MAIN'), p_business_name: 'Seed Shop', p_branch_name: 'Harare' });
  ok('main registers (T1)', r.j && r.j.till_code === 'T1', JSON.stringify(r));
  const BIZ = r.j.business_id;

  // ---- issuing ----
  r = await anon('cl_branch_issue_join_code', { ...auth('MAIN'), p_new_branch_name: 'Mbare' });
  ok('an older main build (no check value): "Update the main branch till first", no code', /UPDATE_MAIN_FIRST: Update the main branch till first\./.test(r.e || ''), JSON.stringify(r));
  ok('... and no branch or code was made', (await q(`select count(*)::int c from cl_branches where name = 'Mbare'`))[0].c === 0 && (await q(`select count(*)::int c from cl_branch_join_codes`))[0].c === 0);
  const bad = seedOf('abcdef'); bad.rounds = 10;
  r = await anon('cl_branch_issue_join_code', { ...auth('MAIN'), p_new_branch_name: 'Mbare', p_admin_salt: bad.salt, p_admin_check: bad.check, p_admin_rounds: bad.rounds });
  ok('a check value with too few rounds is refused', /UPDATE_MAIN_FIRST/.test(r.e || ''), JSON.stringify(r));
  const S1 = seedOf('mbare-123');
  r = await anon('cl_branch_issue_join_code', { ...auth('MAIN'), p_new_branch_name: 'Mbare', p_admin_salt: S1.salt, p_admin_check: S1.check, p_admin_rounds: S1.rounds });
  ok('with the check value: a code', r.j && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.j.code), JSON.stringify(r));
  const CODE1 = r.j && r.j.code;
  ok('the code row holds the check value (and no passcode)', (await q(`select admin_salt, admin_check, admin_rounds from cl_branch_join_codes`))[0].admin_check === S1.check);

  // ---- joining ----
  const joinArgs = (iid, code, build) => ({ ...auth(iid), p_join_code: code, p_app_build: build === undefined ? null : build });
  r = await anon('cl_terminal_join', { ...auth('MB01'), p_join_code: CODE1 });
  ok('an app before v21 (no build sent): "Update this app first", nothing written', /APP_UPDATE_NEEDED: Update this app first, then join again\. Your join code is still valid\./.test(r.e || '') &&
    (await q(`select count(*)::int c from cl_terminals where install_id = 'MB01'`))[0].c === 0, JSON.stringify(r));
  r = await anon('cl_terminal_join', joinArgs('MB01', CODE1, 20));
  ok('... and v20: the same', /APP_UPDATE_NEEDED/.test(r.e || ''), JSON.stringify(r));
  r = await anon('cl_terminal_join', joinArgs('MB01', CODE1, 21));
  ok('v21 joins; the answer carries the check value', r.j && r.j.till_code === 'T1' && r.j.admin_seed && r.j.admin_seed.check === S1.check && r.j.admin_seed.salt === S1.salt && r.j.admin_seed.rounds === 150000, JSON.stringify(r));
  const MB01 = r.j.terminal_id;
  r = await anon('cl_terminal_join', joinArgs('MB01', CODE1, 21));
  ok('a retried join (lost answer) gets the same check value', r.j && r.j.terminal_id === MB01 && r.j.admin_seed && r.j.admin_seed.check === S1.check, JSON.stringify(r));

  // a code issued before the migration (no check value)
  const br = (await q(`select id from cl_branches where name = 'Harare'`))[0].id;
  const main = (await q(`select id from cl_terminals where install_id = 'MAIN'`))[0].id;
  await q(`insert into cl_branch_join_codes (branch_id, code_hash, issued_by_terminal, expires_ts) values ($1, encode(extensions.digest('OLDCODE1', 'sha256'), 'hex'), $2, now() + interval '1 day')`, [br, main]);
  r = await anon('cl_terminal_join', joinArgs('HR02', 'OLDC-ODE1', 21));
  ok('a code from an older main build: ADMIN_SEED_MISSING, nothing written', r.j && r.j.error === 'ADMIN_SEED_MISSING' && (await q(`select count(*)::int c from cl_terminals where install_id = 'HR02'`))[0].c === 0, JSON.stringify(r));

  // an extra till of the main branch, with a check value
  const S2 = seedOf('harare-t2');
  r = await anon('cl_branch_issue_join_code', { ...auth('MAIN'), p_branch_id: br, p_admin_salt: S2.salt, p_admin_check: S2.check, p_admin_rounds: S2.rounds });
  r = await anon('cl_terminal_join', joinArgs('HR02', r.j.code, 21));
  ok('an extra till of the main branch joins with its check value too', r.j && r.j.till_code === 'T2' && r.j.admin_seed.check === S2.check, JSON.stringify(r));
  const HR02 = r.j.terminal_id;

  // ---- setting a till's Admin passcode later ----
  const S3 = seedOf('new-pass-9');
  const setArgs = (iid, t, s) => ({ ...auth(iid), p_terminal_id: t, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds });
  r = await anon('cl_terminal_admin_set', setArgs('MB01', HR02, S3));
  ok('a till of another branch can\'t set it', /Only a main-branch terminal/.test(r.e || ''), JSON.stringify(r));
  r = await anon('cl_terminal_admin_set', setArgs('MAIN', main, S3));
  ok('main can\'t set its own this way', /sets its own Admin passcode in Settings/.test(r.e || ''), JSON.stringify(r));
  await anon('cl_branch_register', { ...auth('OTH1'), p_business_name: 'Other Shop', p_branch_name: 'Elsewhere' });
  const oth = (await q(`select id from cl_terminals where install_id = 'OTH1'`))[0].id;
  r = await anon('cl_terminal_admin_set', setArgs('MAIN', oth, S3));
  ok('not for another business\'s till', /Terminal not found in this business/.test(r.e || ''), JSON.stringify(r));
  r = await anon('cl_terminal_admin_set', setArgs('MAIN', MB01, { ...S3, check: 'xyz' }));
  ok('a malformed check value is refused', /ADMIN_SEED_INVALID/.test(r.e || ''), JSON.stringify(r));
  r = await anon('cl_terminal_admin_set', setArgs('MAIN', MB01, S3));
  ok('main sets Mbare T1\'s Admin passcode', r.j && r.j.admin_set === true && r.j.till_code === 'T1', JSON.stringify(r));
  const checkin = (iid) => anon('cl_device_checkin', { p_install_id: iid, p_shop_secret_phrase: 'Seed Phrase', p_device_code: null, p_business_name: null, p_device_key: key(iid), p_app_build: 21 });
  r = await checkin('MB01');
  ok('Mbare T1\'s next check-in carries it', r.j && r.j.admin_seed && r.j.admin_seed.check === S3.check && r.j.admin_seed.salt === S3.salt && r.j.admin_seed.rounds === 150000, JSON.stringify(r));
  r = await checkin('MB01');
  ok('... only once', r.j && r.j.admin_seed === null && r.j.terminal_id === MB01, JSON.stringify(r));
  const S4 = seedOf('newer-pass');
  await anon('cl_terminal_admin_set', setArgs('MAIN', MB01, S3));
  await anon('cl_terminal_admin_set', setArgs('MAIN', MB01, S4));
  r = await checkin('MB01');
  ok('a newer one replaces a pending one', r.j && r.j.admin_seed && r.j.admin_seed.check === S4.check, JSON.stringify(r));
  r = await checkin('MAIN');
  ok('a till with nothing pending: admin_seed null, the rest of the answer as before', r.j && r.j.admin_seed === null && r.j.terminal_active === true && r.j.business_id === BIZ && 'lock_cart' in r.j, JSON.stringify(r));
  await anon('cl_device_checkin', { p_install_id: 'NOTILL', p_shop_secret_phrase: 'Seed Phrase', p_device_code: null, p_business_name: 'Solo', p_device_key: key('NOTILL') });
  r = await checkin('NOTILL');
  ok('a device that isn\'t a till: admin_seed null', r.j && r.j.admin_seed === null && r.j.terminal_id === null, JSON.stringify(r));

  // ---- nothing holds a passcode; the log holds no check value ----
  const logs = await q(`select detail::text d from cl_activity_log where action = 'terminal_admin_set'`);
  ok('logged as terminal_admin_set, without the check value', logs.length === 3 && logs.every((l) => !l.d.includes(S3.check) && !l.d.includes(S4.check) && !l.d.includes(S3.salt)), JSON.stringify(logs));
  const dump = JSON.stringify(await q(`select * from cl_branch_join_codes`)) + JSON.stringify(await q(`select * from cl_terminal_admin_seeds`)) + JSON.stringify(await q(`select * from cl_activity_log`));
  ok('no passcode in any of these tables', !['mbare-123', 'harare-t2', 'new-pass-9', 'newer-pass'].some((p) => dump.includes(p)));

  // ---- grants ----
  const can = async (role, fn) => (await q(`select has_function_privilege($1, $2, 'execute') x`, [role, fn]))[0].x;
  ok('devices (anon) may call issue, join, admin_set and check-in',
    await can('anon', 'public.cl_branch_issue_join_code(text,text,text,uuid,text,int,text,text,int)') && await can('anon', 'public.cl_terminal_join(text,text,text,text,text,text,text,text,text,text,integer)') &&
    await can('anon', 'public.cl_terminal_admin_set(text,text,text,uuid,text,text,integer)') && await can('anon', 'public.cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text,integer)'));
  ok('the helpers are internal (anon and authenticated can\'t call them)',
    !(await can('anon', 'public.cl_admin_seed_ok(text,text,integer)')) && !(await can('authenticated', 'public.cl_terminal_join_json(uuid,uuid)')));
  ok('the seeds table: RLS on, nothing granted to anon or authenticated',
    (await q(`select relrowsecurity r from pg_class where oid = 'public.cl_terminal_admin_seeds'::regclass`))[0].r &&
    !(await q(`select has_table_privilege('anon', 'public.cl_terminal_admin_seeds', 'select') x`))[0].x &&
    !(await q(`select has_table_privilege('authenticated', 'public.cl_terminal_admin_seeds', 'select') x`))[0].x);
  ok('the old signatures are gone (no second overload)',
    (await q(`select count(*)::int c from pg_proc where proname in ('cl_branch_issue_join_code', 'cl_terminal_join')`))[0].c === 2);

  r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('a second run is refused and changes nothing', /already there/.test(r.e || ''), r.e);

  // ---- rollback ----
  await q(`delete from cl_terminal_admin_seeds`);
  r = await (async () => { try { await pg.exec(RB); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('the rollback applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  r = await anon('cl_branch_issue_join_code', { ...auth('MAIN'), p_new_branch_name: 'Avondale' });
  ok('after the rollback an older main build issues codes again', r.j && r.j.code, JSON.stringify(r));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
