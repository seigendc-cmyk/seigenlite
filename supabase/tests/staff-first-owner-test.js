// node supabase/tests/staff-first-owner-test.js
//
// Tests supabase/migrations/20261110120000_staff_first_owner.sql (and its
// rollback) in an in-memory PGlite built from the repo (the live shape), never
// the live database (owner, 2026-10-21: v33 items 2 and 4, Decision 2):
//   - as on live for Romana Books: a main till registered after the roles
//     migration with an old local Admin (Cathy): before, "not_needed"; after,
//     it sends its old list once while the business has 0 staff and Cathy's
//     old PIN works on that till; logged;
//   - a remote, or a second main till once the business has staff: still
//     "not_needed" (pull and upload);
//   - a till registered before the roles migration: unchanged (it may send its
//     list even when the business has staff);
//   - the first Owner: only on a main till while the business has no Owner
//     (a signed-in Admin at a remote is refused); with the Admin passcode only
//     as the business's first person; after that only an Owner gives it;
//     logged with the till and how;
//   - the Console reads the log (Vendors module) without names; devices and
//     anon can't; grants; a second run is refused; the rollback restores the
//     whole catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ, v21AdminSeed } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261110120000_staff_first_owner.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261110120000_staff_first_owner.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = (n) => crypto.randomBytes(n || 16).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const legacy = (pin) => { const salt = hex(4); return { pin_salt: salt, pin_hash: sha(salt + ':' + pin) }; };
const check = () => ({ pin_salt: hex(16), pin_check: hex(32), pin_rounds: 150000 });
const J = (x) => JSON.stringify(x);

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261113180000_removed_devices.sql', '20261114120000_roles_everywhere.sql']) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const PHRASE = { RO: 'Romana Phrase', BB: 'Bata Phrase', CC: 'Chiko Phrase', EE: 'Elder Phrase' };
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
    await pg.exec('set role anon');
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  const auth = (iid) => ({ p_install_id: iid, p_secret_phrase: PHRASE[iid.slice(0, 2)], p_device_key: key(iid) });
  const call = async (iid, fn, args) => { const r = await anon(fn, { ...auth(iid), ...(args || {}) }); return r.e ? { raised: r.e } : r.j; };
  const register = async (iid, biz, branch) => (await anon('cl_branch_register', { ...auth(iid), p_business_name: biz, p_branch_name: branch })).j;
  const code = async (iid, o) => { const s = v21AdminSeed('admin-pass-1'); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j.code; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 33 })).j;
  const pull = (iid) => call(iid, 'cl_device_staff_pull');
  const upload = (iid, staff) => call(iid, 'cl_device_staff_upload', { p_staff: staff });
  const save = (iid, tok, p) => call(iid, 'cl_device_staff_save', { p_staff_token: tok, p_staff: p });
  const signin = async (iid, id, pin) => call(iid, 'cl_device_staff_signin', { p_staff_id: id, p_pin: pin });
  const events = async (biz) => q(`select kind, till_code, via, people from cl_shop_staff_events where business_id = $1 order by id`, [biz]);

  // ---- before: Romana Books as on live (main T1 registered after the roles migration, an old local Admin) ----
  const RO = await register('RO01', 'Romana Books', 'Harare');
  let p = await pull('RO01');
  ok('before: the main till is told "not_needed" (registered after the cutoff)', p.upload === 'not_needed' && p.roles.length === 5, J(p.upload));
  let r = await upload('RO01', [{ name: 'Cathy', role: 'Admin', active: true, ...legacy('2468') }]);
  ok('before: its old list is refused (NOT_NEEDED): Cathy would never reach seiGEN', r.error === 'NOT_NEEDED', J(r));
  const before = fingerprint(await snapshot(q));

  // ---- the migration ----
  r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('the migration applies', r.ok, r.e);

  // ---- 1. the old list: a main till, while the business has 0 staff, once ----
  const NORTON = (await join('RO03', await code('RO01', { p_new_branch_name: 'Norton' }))).branch_id;
  await join('RO02', await code('RO01', { p_branch_id: RO.branch_id }));
  ok('a remote is still told "not_needed"', (await pull('RO03')).upload === 'not_needed');
  r = await upload('RO03', [{ name: 'Tino', role: 'Cashier', active: true, ...legacy('1357') }]);
  ok('... and its old list is refused (NOT_NEEDED)', r.error === 'NOT_NEEDED', J(r));
  ok('the main till T1, with 0 staff on seiGEN: "ready"', (await pull('RO01')).upload === 'ready');
  r = await upload('RO01', [{ name: 'Cathy', role: 'Admin', active: true, ...legacy('2468') }]);
  ok('T1 sends its old list: Cathy added', r.ok === true && r.added === 1, J(r));
  ok('... logged: old_staff_moved by T1, 1 person', J(await events(RO.business_id)) === J([{ kind: 'old_staff_moved', till_code: 'T1', via: null, people: 1 }]), J(await events(RO.business_id)));
  p = await pull('RO01');
  const CATHY = p.staff.find((s) => s.name === 'Cathy');
  ok('... once: T1 is now "done"; Cathy is an Admin', p.upload === 'done' && p.roles.find((x) => x.id === CATHY.role_id).builtin === 'admin', J(p.upload));
  ok('... T1 has Cathy\'s old PIN check (its own) and the first-manager rule is closed', CATHY.legacy.length === 1 && p.bootstrap === false);
  ok('a second main till (T2), now that the business has staff: "not_needed"', (await pull('RO02')).upload === 'not_needed');
  r = await upload('RO02', [{ name: 'Mary', role: 'Admin', active: true, ...legacy('1111') }]);
  ok('... and its old list is refused', r.error === 'NOT_NEEDED', J(r));
  r = await upload('RO01', [{ name: 'Cathy', role: 'Admin', active: true, ...legacy('2468') }]);
  ok('T1 sending again: "already" (once)', r.ok === true && r.already === true, J(r));
  r = await signin('RO01', CATHY.id, '2468');
  ok('Cathy signs in on T1 with her old PIN (it carried over)', !!r.token, J(r));
  const cathyT1 = r.token;
  ok('... not on T2 (an old PIN works on its own till only)', !(await signin('RO02', CATHY.id, '2468')).token);

  // ---- 2. the first Owner (Decision 2): main till only while there is no Owner; then only an Owner ----
  const roles = Object.fromEntries(p.roles.map((x) => [x.builtin || x.name, x.id]));
  r = await save('RO01', cathyT1, { name: 'Zed', role_id: roles.admin, home_branch_id: NORTON, pin: '5555', ...check() });
  ok('(Cathy adds Zed, an Admin of Norton)', r.ok === true, J(r));
  const ZED = r.staff.id;
  const zedNorton = (await signin('RO03', ZED, '5555')).token;
  ok('(Zed signs in at the Norton remote)', !!zedNorton);
  r = await save('RO03', zedNorton, { name: 'Lovemore', role_id: roles.owner, home_branch_id: NORTON, pin: '7777', ...check() });
  ok('an Admin at a remote can\'t make the first Owner (FIRST_OWNER_MAIN)', r.error === 'FIRST_OWNER_MAIN', J(r));
  r = await save('RO03', zedNorton, { id: ZED, role_id: roles.owner });
  ok('... nor make themselves Owner there', r.error === 'FIRST_OWNER_MAIN', J(r));
  r = await save('RO03', zedNorton, { name: 'Rumbi', role_id: roles.cashier, home_branch_id: NORTON, pin: '8888', ...check() });
  ok('... other roles at the remote: as before', r.ok === true, J(r));
  r = await save('RO01', cathyT1, { name: 'Lovemore', role_id: roles.owner, home_branch_id: RO.branch_id, pin: '7777', ...check() });
  ok('a signed-in Admin on the main till makes the first Owner', r.ok === true, J(r));
  const OWNER = r.staff.id;
  ok('... logged: first_owner by T1, signed_in', J((await events(RO.business_id)).slice(-1)) === J([{ kind: 'first_owner', till_code: 'T1', via: 'signed_in', people: null }]), J(await events(RO.business_id)));
  r = await save('RO01', cathyT1, { name: 'Second', role_id: roles.owner, home_branch_id: RO.branch_id, pin: '7788', ...check() });
  ok('now there is an Owner, an Admin can\'t give Owner (OWNER_ONLY, as before)', r.error === 'OWNER_ONLY', J(r));
  const ownerNorton = (await signin('RO03', OWNER, '7777')).token;
  r = await save('RO03', ownerNorton, { id: ZED, role_id: roles.owner });
  ok('the Owner gives Owner at any till (Zed at Norton), as before; not logged as a first Owner', r.ok === true && (await events(RO.business_id)).length === 2, J(r));

  // ---- 3. the Admin passcode route (nobody signed in) ----
  const BB = await register('BB01', 'Bata Shoes', 'Mutare');
  await join('BB02', await code('BB01', { p_new_branch_name: 'Rusape' }));
  let pb = await pull('BB01');
  ok('a new business: 0 staff, the first-manager rule is open', pb.bootstrap === true && pb.staff.length === 0);
  const broles = Object.fromEntries(pb.roles.map((x) => [x.builtin || x.name, x.id]));
  r = await save('BB02', null, { name: 'Remote', role_id: broles.owner, pin: '1212', ...check() });
  ok('... not at a remote (as before: NO_RIGHT)', r.error === 'NO_RIGHT', J(r));
  r = await save('BB01', null, { name: 'Tsitsi', role_id: broles.owner, pin: '1212', ...check() });
  ok('the first person, as Owner, with the Admin passcode on the main till', r.ok === true, J(r));
  ok('... logged: first_owner by T1, admin_passcode', J(await events(BB.business_id)) === J([{ kind: 'first_owner', till_code: 'T1', via: 'admin_passcode', people: null }]));
  r = await save('BB01', null, { name: 'Again', role_id: broles.cashier, pin: '1313', ...check() });
  ok('... and the Admin passcode route is closed after that (as before)', r.error === 'NO_RIGHT', J(r));

  const CC = await register('CC01', 'Chiko Hardware', 'Gweru');
  r = await upload('CC01', [{ name: 'Tari', role: 'Cashier', active: true, ...legacy('4545') }]);
  ok('(a new business\'s main till sends a Cashier-only old list)', r.ok === true && r.added === 1, J(r));
  const pc = await pull('CC01');
  const croles = Object.fromEntries(pc.roles.map((x) => [x.builtin || x.name, x.id]));
  ok('nobody holds Staff yet: the first-manager rule is open (as before)', pc.bootstrap === true);
  r = await save('CC01', null, { name: 'Boss', role_id: croles.owner, pin: '9090', ...check() });
  ok('with staff on seiGEN the Admin passcode can\'t make an Owner (FIRST_OWNER_NOT_EMPTY)', r.error === 'FIRST_OWNER_NOT_EMPTY', J(r));
  r = await save('CC01', null, { name: 'Boss', role_id: croles.admin, pin: '9090', ...check() });
  ok('... it can still add the first Admin (as before)', r.ok === true, J(r));
  ok('... nothing logged for Chiko but the old list', J((await events(CC.business_id)).map((e) => e.kind)) === J(['old_staff_moved']));

  // ---- 4. a till registered before the roles migration: unchanged ----
  await register('EE01', 'Elder Stores', 'Kadoma');
  await join('EE02', await code('EE01', { p_branch_id: (await pull('EE01')).branch_id }));
  await q(`update cl_shop_meta set v = now() + interval '1 day' where k = 'legacy_cutoff'`);
  r = await upload('EE01', [{ name: 'Old', role: 'Admin', active: true, ...legacy('1122') }]);
  ok('(an older main till sends its list)', r.ok === true && r.added === 1, J(r));
  ok('an older second main till is still "ready" although the business has staff (unchanged)', (await pull('EE02')).upload === 'ready');
  r = await upload('EE02', [{ name: 'Old', role: 'Admin', active: true, ...legacy('3344') }]);
  ok('... and its list is merged as before', r.ok === true && r.merged === 1, J(r));
  await q(`update cl_shop_meta set v = now() - interval '1 day' where k = 'legacy_cutoff'`);

  // ---- 5. the Console ----
  const staff = {};
  for (const k of ['VEN', 'NONE']) staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', false, true, now()) returning id`, ['Staff ' + k]))[0].id;
  const modId = async (k) => ((await q(`select id from cl_modules where key = $1`, [k]))[0] || {}).id ||
    (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [k]))[0].id;
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff.VEN, await modId('vendors')]);
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff.NONE, await modId('cashbook')]);
  async function as(claims, sql, prm) {
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, prm) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: false });
  const vendorRO = (await q(`select id from cl_vendors where install_id = 'RO01'`))[0].id;
  r = await as(tok('VEN'), `select public.cl_vendor_staff_events($1) j`, [vendorRO]);
  const ev = r.r && r.r[0].j;
  ok('Console staff with Vendors read Romana\'s log: the old list and the first Owner, by T1', !!ev && J(ev.map((e) => [e.kind, e.till_code, e.via, e.people])) === J([['old_staff_moved', 'T1', null, 1], ['first_owner', 'T1', 'signed_in', null]]), J(r));
  ok('... with a time and no names', !!ev && ev.every((e) => e.at && !('name' in e) && !('staff_id' in e)));
  r = await as(tok('NONE'), `select public.cl_vendor_staff_events($1) j`, [vendorRO]);
  ok('Console staff without Vendors are refused', /Not authorized/.test(r.e || ''), J(r));
  r = await as(null, `select public.cl_vendor_staff_events($1) j`, [vendorRO]);
  ok('anon (a device) can\'t call it', /permission denied/.test(r.e || ''), J(r));
  r = await as(tok('VEN'), `select count(*) from public.cl_shop_staff_events`);
  ok('nobody reads the table directly', /permission denied/.test(r.e || ''), J(r));

  // ---- second run, rollback ----
  r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('a second run is refused and changes nothing', /already exists/.test(r.e || ''), r.e);
  r = await (async () => { try { await pg.exec(RB); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('the rollback applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  ok('... and a new main till with 0 staff is again "not_needed"', (await pull((await register('BB09', 'Bata Two', 'Chipinge')) && 'BB09')).upload === 'not_needed');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
