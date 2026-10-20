// node supabase/tests/shop-managers-everywhere-test.js
//
// Tests supabase/migrations/20261108120000_shop_managers_everywhere.sql (and
// its rollback) in an in-memory PGlite built from the repo (the live shape),
// never the live database:
//   - Owner, Admin and any role with the Staff right sign in on every till of
//     the business (the pull gives their PIN check value everywhere, the
//     sign-in and the token work there); everyone else only at their home
//     branch and "also works at";
//   - an old PIN from a till's list still works on that till only;
//   - a manager signed in at a remote adds that remote's people;
//   - taking Staff away from a role, or moving the person to another role,
//     takes the other branches away at once (token and pull);
//   - grants; a second run is refused; the rollback restores the whole
//     catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ, v21AdminSeed } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261108120000_shop_managers_everywhere.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261108120000_shop_managers_everywhere.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = (n) => crypto.randomBytes(n || 16).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const legacy = (pin) => { const salt = hex(4); return { pin_salt: salt, pin_hash: sha(salt + ':' + pin) }; };
const check = () => ({ pin_salt: hex(16), pin_check: hex(32), pin_rounds: 150000 });

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE]) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
    await pg.exec('set role anon');
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  const auth = (iid) => ({ p_install_id: iid, p_secret_phrase: 'Mandie Phrase', p_device_key: key(iid) });
  const call = async (iid, fn, args) => { const r = await anon(fn, { ...auth(iid), ...(args || {}) }); return r.e ? { raised: r.e } : r.j; };
  const code = async (iid, o) => { const s = v21AdminSeed('admin-pass-1'); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j.code; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 30 })).j;

  // ---- the business as on live: Harare T1 + T2, Murehwa T1; staff moved in from the old lists ----
  let r = await anon('cl_branch_register', { ...auth('HA01'), p_business_name: 'Mandie Babyware', p_branch_name: 'Harare' });
  const HARARE = r.j.branch_id;
  await join('HA02', await code('HA01', { p_branch_id: HARARE }));
  const MUREHWA = (await join('MU01', await code('HA01', { p_new_branch_name: 'Murehwa' }))).branch_id;
  await q(`update cl_shop_meta set v = now() + interval '1 day' where k = 'legacy_cutoff'`);
  r = await call('HA01', 'cl_device_staff_upload', { p_staff: [
    { name: 'Boss', role: 'Admin', active: true, ...legacy('1234') },
    { name: 'Rudo', role: 'Cashier', active: true, ...legacy('3333') }] });
  ok('(main T1 moves Boss (Admin) and Rudo (Cashier) in)', r.ok && r.added === 2, JSON.stringify(r));
  await call('MU01', 'cl_device_staff_upload', { p_staff: [] });
  const pull = async (iid) => call(iid, 'cl_device_staff_pull');
  const sOf = (p, n) => p.staff.find((s) => s.name === n);
  const ID = Object.fromEntries((await pull('HA01')).staff.map((s) => [s.name, s.id]));
  const roles = Object.fromEntries((await pull('HA01')).roles.map((x) => [x.builtin || x.name, x.id]));
  const signin = async (iid, name, pin) => call(iid, 'cl_device_staff_signin', { p_staff_id: ID[name], p_pin: pin });
  ok('before: Boss (Admin) can\'t sign in at Murehwa (the v28 rule)', (await signin('MU01', 'Boss', '1234')).error === 'NOT_HERE');
  const before = fingerprint(await snapshot(q));

  // ---- the migration ----
  r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('it applies', r.ok, r.e);

  let pm = await pull('MU01');
  ok('Murehwa\'s pull: Boss (Admin, home Harare) is here and everywhere, Rudo (Cashier) is not',
    sOf(pm, 'Boss').here === true && sOf(pm, 'Boss').everywhere === true && sOf(pm, 'Rudo').here === false && sOf(pm, 'Rudo').everywhere === false, JSON.stringify(pm.staff));
  ok('... Boss\'s old PIN isn\'t sent to Murehwa (it is T1\'s only); Rudo gets no PIN data at all',
    Array.isArray(sOf(pm, 'Boss').legacy) && sOf(pm, 'Boss').legacy.length === 0 && !('legacy' in sOf(pm, 'Rudo')) && !('pin_check' in sOf(pm, 'Rudo')));
  ok('Boss\'s old PIN still works on main T1 only', (await signin('MU01', 'Boss', '1234')).error === 'BAD_PIN' &&
    (await signin('HA02', 'Boss', '1234')).error === 'BAD_PIN');
  r = await signin('HA01', 'Boss', '1234');
  ok('... on T1 it does (legacy)', r.ok && r.legacy === true, JSON.stringify(r));
  const c = check();
  r = await call('HA01', 'cl_device_staff_set_pin', { p_staff_token: r.token, p_staff_id: ID.Boss, p_pin: '1111', p_pin_salt: c.pin_salt, p_pin_check: c.pin_check, p_pin_rounds: c.pin_rounds });
  ok('Boss sets his seiGEN PIN on T1', r.ok, JSON.stringify(r));
  pm = await pull('MU01');
  ok('Murehwa now gets Boss\'s check value (offline sign-in there)', sOf(pm, 'Boss').pin_check === c.pin_check);
  r = await signin('MU01', 'Boss', '1111');
  ok('Boss signs in at Murehwa with it', r.ok && r.legacy === false, JSON.stringify(r));
  const bossMU = r.token;
  const has = async (tok, iid, right) => (await q(`select cl_staff_has($1, (select id from cl_terminals where install_id = $2), $3) x`, [tok, iid, right]))[0].x;
  ok('... his token works there (Staff right)', await has(bossMU, 'MU01', 'm.staff'));
  r = await call('MU01', 'cl_device_staff_save', { p_staff_token: bossMU, p_staff: { name: 'Farai', role_id: roles.cashier, home_branch_id: MUREHWA, pin: '6666', ...check() } });
  ok('signed in at Murehwa, Boss adds Murehwa\'s Cashier there', r.ok && r.staff.here === true && r.staff.everywhere === false, JSON.stringify(r));
  ID.Farai = r.staff.id;
  ok('Farai (Cashier, Murehwa) can\'t sign in at Harare; Rudo (Cashier, Harare) can\'t at Murehwa',
    (await signin('HA01', 'Farai', '6666')).error === 'NOT_HERE' && (await signin('MU01', 'Rudo', '3333')).error === 'NOT_HERE');
  ok('... Farai can at Murehwa', (await signin('MU01', 'Farai', '6666')).ok === true);

  // an Owner, a Manager (no Staff by default), a custom role with Staff
  const add = async (name, role, home) => { const x = await call('MU01', 'cl_device_staff_save', { p_staff_token: bossMU, p_staff: { name, role_id: role, home_branch_id: home, pin: '2468', ...check() } }); ID[name] = x.staff && x.staff.id; return x; };
  r = await call('MU01', 'cl_device_role_save', { p_staff_token: bossMU, p_role: { name: 'Supervisor', rights: ['m.sell', 'm.staff'] } });
  ok('(a custom role "Supervisor" with the Staff right)', r.ok, JSON.stringify(r));
  const SUP = r.role.id;
  await add('Tendai', roles.owner, HARARE); await add('Mandla', roles.manager, HARARE); await add('Sipho', SUP, HARARE);
  ok('an Owner (home Harare) signs in at Murehwa', (await signin('MU01', 'Tendai', '2468')).ok === true);
  ok('a Manager (no Staff right by default) stays at Harare', (await signin('MU01', 'Mandla', '2468')).error === 'NOT_HERE' && (await signin('HA02', 'Mandla', '2468')).ok === true);
  r = await signin('MU01', 'Sipho', '2468');
  ok('a custom role with the Staff right signs in at Murehwa', r.ok === true, JSON.stringify(r));
  const siphoMU = r.token;

  // taking it away
  r = await call('MU01', 'cl_device_role_save', { p_staff_token: bossMU, p_role: { id: SUP, name: 'Supervisor', rights: ['m.sell'] } });
  ok('(Staff taken off "Supervisor")', r.ok, JSON.stringify(r));
  ok('... Sipho\'s token at Murehwa stops at once, and the pull there drops his PIN data',
    !(await has(siphoMU, 'MU01', 'm.sell')) && sOf(await pull('MU01'), 'Sipho').here === false && !('pin_check' in sOf(await pull('MU01'), 'Sipho')));
  await add('Grace', roles.admin, HARARE);
  r = await signin('MU01', 'Grace', '2468');
  ok('(a second Admin, Grace, home Harare, signs in at Murehwa)', r.ok === true, JSON.stringify(r));
  const graceMU = r.token;
  r = await call('MU01', 'cl_device_staff_save', { p_staff_token: bossMU, p_staff: { id: ID.Grace, name: 'Grace', role_id: roles.cashier, home_branch_id: HARARE } });
  ok('an Admin moved to Cashier: her token at Murehwa stops and she can\'t sign in there again', r.ok === true && !(await has(graceMU, 'MU01', 'm.sell')) &&
    (await signin('MU01', 'Grace', '2468')).error === 'NOT_HERE' && (await signin('HA02', 'Grace', '2468')).ok === true, JSON.stringify(r));
  ok('another business still sees none of it', (await anon('cl_branch_register', { ...auth('SO01'), p_business_name: 'Solo', p_branch_name: 'Mbare' })).j &&
    (await call('SO01', 'cl_device_staff_signin', { p_staff_id: ID.Boss, p_pin: '1111' })).error === 'NOT_FOUND');

  // grants
  const can = async (role, fn) => (await q(`select has_function_privilege($1, $2, 'execute') x`, [role, fn]))[0].x;
  ok('the helpers are internal; the devices still call sign-in', !(await can('anon', 'public.cl_shop_staff_at(public.cl_shop_staff,uuid)')) &&
    !(await can('anon', 'public.cl_shop_staff_everywhere(uuid)')) && await can('anon', 'public.cl_device_staff_signin(text,text,text,uuid,text)') &&
    !(await can('anon', 'public.cl_shop_session(text,uuid)')));

  r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('a second run is refused and changes nothing', /already exists/.test(r.e || ''), r.e);

  r = await (async () => { try { await pg.exec(RB); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('the rollback applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  ok('... and Boss (Admin, home Harare) is again refused at Murehwa', (await signin('MU01', 'Boss', '1111')).error === 'NOT_HERE');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
