// node supabase/tests/shop-roles-test.js
//
// Tests supabase/migrations/20261107120000_shop_roles.sql (and its rollback)
// in an in-memory PGlite built from the repo (the live shape), never the live
// database:
//   - existing staff move in from each till once: Admin -> Admin, Cashier ->
//     Cashier, Cashier + "create customers" -> "Cashier + customers"; the main
//     branch first; the same name at the same branch from two tills is one
//     person whose old PINs each work on their own till only;
//   - sign-in: the PIN against seiGEN's copy, 5 tries in 15 minutes, a token
//     valid on that till only; setting a PIN ends the old ones;
//   - the pull: check values only for staff allowed at the caller's branch;
//   - adding and changing people and roles needs Staff; the first manager of
//     a new business on a main till; Owner-only items (Admins keep them until
//     there is an Owner); the last Owner stays; switching someone off ends
//     their sessions at once;
//   - other branches' reports only with the right; costs only with View
//     costs; a DN's costs only with View costs;
//   - another business sees nothing; the merge moves staff; the delete guard
//     counts them; grants; a second run is refused; the rollback restores
//     the whole catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ, v21AdminSeed } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261107120000_shop_roles.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261107120000_shop_roles.rollback.sql'));

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
  const before = fingerprint(await snapshot(q));
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const PH = { SO01: 'Solo Phrase', NB01: 'New Phrase' };
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
    await pg.exec('set role anon');
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  const auth = (iid) => ({ p_install_id: iid, p_secret_phrase: PH[iid] || 'Mandie Phrase', p_device_key: key(iid) });
  const call = async (iid, fn, args) => { const r = await anon(fn, { ...auth(iid), ...(args || {}) }); return r.e ? { raised: r.e } : r.j; };
  const code = async (iid, o) => { const s = v21AdminSeed('admin-pass-1'); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j.code; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 28 })).j;

  // ---- the business as it is on live before the migration ----
  let r = await anon('cl_branch_register', { ...auth('HA01'), p_business_name: 'Mandie Babyware', p_branch_name: 'Harare' });
  const HARARE = r.j.branch_id, BIZ = (await q('select business_id from cl_branches where id = $1', [HARARE]))[0].business_id;
  ok('(Harare T1, T2 and Murehwa T1)', (await join('HA02', await code('HA01', { p_branch_id: HARARE }))).till_code === 'T2');
  const MUREHWA = (await join('MU01', await code('HA01', { p_new_branch_name: 'Murehwa' }))).branch_id;
  await anon('cl_branch_register', { ...auth('SO01'), p_business_name: 'Solo Shop', p_branch_name: 'Mbare' });
  const CAT = hex();
  await q(`insert into cl_catalogue_products (business_id, product_uid, code, name, price, cost, change_seq, last_op_id) values ($1, $2, 'BIB1', 'Bib', 5, 3.21, 1, 'op1')`, [BIZ, CAT]);
  await q(`insert into cl_till_stock_levels (terminal_id, product_key, branch_id, cat_uid, code, name, qty, as_of)
           select t.id, $1, t.branch_id, $1, 'BIB1', 'Bib', v.qty, now() from cl_terminals t join (values ('HA01', 6), ('HA02', 3), ('MU01', 4)) v(iid, qty) on v.iid = t.install_id`, [CAT]);
  const D1 = crypto.randomUUID();
  r = await call('HA01', 'cl_device_dispatch_send', { p_dispatch: { id: D1, to_branch_id: MUREHWA, dn_no: 1, dn_display: 'DN-T1-0001', sent_by: 'Boss',
    lines: [{ line_no: 1, cat_uid: CAT, code: 'BIB1', name: 'Bib', qty: 5, unit_cost: 3.21 }], delivery: { cost: 4.56, currency: 'USD' } } });
  ok('(Harare sends DN-T1-0001 to Murehwa: 5 bibs at 3.21)', r.ok, JSON.stringify(r));

  // ---- the migration ----
  r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('it applies', r.ok, r.e);
  ok('no roles yet: they are made when the main branch sends its staff', (await q('select count(*)::int n from cl_shop_roles'))[0].n === 0);
  ok('the tills are older than the migration (as on live)', (await q(`update cl_shop_meta set v = now() + interval '1 day' where k = 'legacy_cutoff' returning k`)).length === 1);

  // ---- moving the existing staff (§R8) ----
  r = await call('MU01', 'cl_device_staff_pull');
  ok('a remote waits for the main branch', r.upload === 'wait_main' && r.roles.length === 0 && r.bootstrap === true, JSON.stringify(r));
  r = await call('MU01', 'cl_device_staff_upload', { p_staff: [{ name: 'Farai', role: 'Admin' }] });
  ok('... and its upload is refused until then', r.error === 'ROLES_NOT_READY', JSON.stringify(r));
  const PIN = { bossH1: '1111', bossH2: '2222', rudo: '3333', chipo: '4444', tari: '5555', farai: '6666' };
  r = await call('HA01', 'cl_device_staff_upload', { p_staff: [
    { name: 'Boss', role: 'Admin', active: true, ...legacy(PIN.bossH1) },
    { name: 'Rudo', role: 'Cashier', active: true, ...legacy(PIN.rudo) },
    { name: 'Chipo', role: 'Cashier', can_create_customers: true, active: true, ...legacy(PIN.chipo) },
    { name: '  ', role: 'Cashier' }] });
  ok('main sends 3 people (a blank name is skipped)', r.ok && r.added === 3 && r.merged === 0, JSON.stringify(r));
  const roles = Object.fromEntries((await q('select name, builtin, rights from cl_shop_roles where business_id = $1', [BIZ])).map((x) => [x.name, x]));
  ok('the 5 built-in roles and "Cashier + customers" exist', ['Owner', 'Admin', 'Manager', 'Stores', 'Cashier', 'Cashier + customers'].every((n) => roles[n]) && Object.keys(roles).length === 6, JSON.stringify(Object.keys(roles)));
  ok('"Cashier + customers" = Cashier + Create customers', JSON.stringify(roles['Cashier + customers'].rights.slice().sort()) === JSON.stringify(roles.Cashier.rights.concat('create_customers').sort()));
  const roleOf = async (name) => (await q('select r.name from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id where s.name = $1', [name]))[0].name;
  ok('Admin -> Admin, Cashier -> Cashier, Cashier with "Create customers" -> Cashier + customers',
    await roleOf('Boss') === 'Admin' && await roleOf('Rudo') === 'Cashier' && await roleOf('Chipo') === 'Cashier + customers');
  r = await call('HA02', 'cl_device_staff_upload', { p_staff: [{ name: 'boss ', role: 'Cashier', active: true, ...legacy(PIN.bossH2) }, { name: 'Tari', role: 'Cashier', ...legacy(PIN.tari) }] });
  ok('Harare T2: "boss" is the same person (merged), Tari is new', r.ok && r.merged === 1 && r.added === 1, JSON.stringify(r));
  ok('... Boss stays Admin (nobody loses access) and has 2 old PINs', await roleOf('Boss') === 'Admin' &&
    (await q(`select jsonb_array_length(legacy_pins) n from cl_shop_staff where name = 'Boss'`))[0].n === 2);
  r = await call('MU01', 'cl_device_staff_upload', { p_staff: [{ name: 'Farai', role: 'Admin', ...legacy(PIN.farai) }] });
  ok('Murehwa now sends Farai', r.ok && r.added === 1, JSON.stringify(r));
  r = await call('HA01', 'cl_device_staff_upload', { p_staff: [{ name: 'Extra', role: 'Admin' }] });
  ok('a till sends its list once', r.ok && r.already === true && !(await q(`select 1 from cl_shop_staff where name = 'Extra'`)).length);

  // ---- the pull ----
  const pull = async (iid) => call(iid, 'cl_device_staff_pull');
  let p1 = await pull('HA01'), p2 = await pull('HA02'), pm = await pull('MU01');
  const sOf = (p, n) => p.staff.find((s) => s.name === n);
  ok('every till gets the roles and the staff', p1.roles.length === 6 && p1.roles[0].builtin === 'owner' && p1.staff.length === 5 && pm.staff.length === 5);
  ok('Harare T1 gets Boss\'s old PIN from T1 only; T2 gets T2\'s', sOf(p1, 'Boss').legacy.length === 1 && sOf(p2, 'Boss').legacy.length === 1 &&
    sOf(p1, 'Boss').legacy[0].hash !== sOf(p2, 'Boss').legacy[0].hash && sOf(p1, 'Boss').pins_from_tills === 2, JSON.stringify(sOf(p1, 'Boss')));
  ok('Murehwa gets Harare\'s people without any PIN data', sOf(pm, 'Boss').here === false && !('legacy' in sOf(pm, 'Boss')) && !('pin_check' in sOf(pm, 'Boss')) &&
    sOf(pm, 'Farai').here === true, JSON.stringify(sOf(pm, 'Boss')));
  ok('the upload is done; Boss holds Staff, so the first-manager door is shut', p1.upload === 'done' && p1.bootstrap === false && p1.has_owner === false);

  // ---- sign-in ----
  const signin = async (iid, name, pin) => call(iid, 'cl_device_staff_signin', { p_staff_id: sOf(p1, name).id, p_pin: pin });
  r = await signin('HA01', 'Boss', PIN.bossH1);
  ok('Boss signs in on T1 with T1\'s old PIN: a token and the Admin rights (+ Owner items while there is no Owner)', r.ok && r.token.length === 64 && r.legacy === true &&
    r.rights.includes('m.staff') && r.rights.includes('owner'), JSON.stringify(r));
  let bossT1 = r.token;
  ok('... T2\'s old PIN doesn\'t work on T1', (await signin('HA01', 'Boss', PIN.bossH2)).error === 'BAD_PIN');
  ok('... it does on T2', (await signin('HA02', 'Boss', PIN.bossH2)).ok === true);
  ok('Farai (Murehwa) can\'t sign in on a Harare till', (await signin('HA01', 'Farai', PIN.farai)).error === 'NOT_HERE');
  ok('only the token\'s hash is kept', (await q('select count(*)::int n from cl_shop_staff_sessions where token_hash = $1', [sha(bossT1)]))[0].n === 1 &&
    (await q('select count(*)::int n from cl_shop_staff_sessions where token_hash = $1', [bossT1]))[0].n === 0);
  for (let i = 0; i < 4; i++) await signin('HA01', 'Tari', '0000');
  r = await signin('HA01', 'Tari', '0001');
  ok('5 wrong PINs: the 5th says none left', r.error === 'BAD_PIN' && r.left === 0, JSON.stringify(r));
  ok('... then even the right one waits 15 minutes', (await signin('HA02', 'Tari', PIN.tari)).error === 'LOCKED');
  await q(`update cl_shop_staff_signin_fails set at = at - interval '16 minutes'`);
  ok('... and works after', (await signin('HA02', 'Tari', PIN.tari)).ok === true);
  const has = async (tok, iid, right) => (await q(`select cl_staff_has($1, (select id from cl_terminals where install_id = $2), $3) x`, [tok, iid, right]))[0].x;
  ok('a token works on its own till only', await has(bossT1, 'HA01', 'costs') && !(await has(bossT1, 'HA02', 'costs')));

  // ---- setting a PIN ----
  const newPin = { ...check() };
  r = await call('HA01', 'cl_device_staff_set_pin', { p_staff_token: bossT1, p_staff_id: sOf(p1, 'Boss').id, p_pin: '9090', p_pin_salt: newPin.pin_salt, p_pin_check: newPin.pin_check, p_pin_rounds: 150000 });
  ok('Boss sets one PIN: the old ones go, the check value travels', r.ok && r.staff.legacy.length === 0 && r.staff.pin_check === newPin.pin_check, JSON.stringify(r));
  ok('... it works on T2 now (seiGEN\'s bcrypt), the old T2 PIN doesn\'t', (await signin('HA02', 'Boss', '9090')).ok && (await signin('HA02', 'Boss', PIN.bossH2)).error === 'BAD_PIN');
  ok('... bcrypt, never the PIN', /^\$2a\$08\$/.test((await q(`select pin_bcrypt from cl_shop_staff where name = 'Boss'`))[0].pin_bcrypt));
  const rudoTok = (await signin('HA01', 'Rudo', PIN.rudo)).token;
  r = await call('HA01', 'cl_device_staff_set_pin', { p_staff_token: rudoTok, p_staff_id: sOf(p1, 'Chipo').id, p_pin: '1234', ...{ p_pin_salt: newPin.pin_salt, p_pin_check: newPin.pin_check, p_pin_rounds: 150000 } });
  ok('a Cashier can\'t set someone else\'s PIN', r.error === 'NO_RIGHT', JSON.stringify(r));
  r = await call('HA01', 'cl_device_staff_set_pin', { p_staff_token: rudoTok, p_staff_id: sOf(p1, 'Rudo').id, p_pin: '12a4', p_pin_salt: newPin.pin_salt, p_pin_check: newPin.pin_check, p_pin_rounds: 150000 });
  ok('a malformed PIN is refused', /4 to 6 digits/.test(r.raised || ''), JSON.stringify(r));

  // ---- people and roles ----
  const save = (iid, tok, s) => call(iid, 'cl_device_staff_save', { p_staff_token: tok, p_staff: s });
  const roleId = (n) => p1.roles.find((x) => x.name === n).id;
  r = await save('HA01', rudoTok, { name: 'Nobody', role_id: roleId('Admin'), pin: '4321', ...check() });
  ok('a Cashier can\'t add people', r.error === 'NO_RIGHT', JSON.stringify(r));
  r = await save('HA01', null, { name: 'Nobody', role_id: roleId('Admin'), pin: '4321', ...check() });
  ok('no token: refused once someone holds Staff', r.error === 'NO_RIGHT', JSON.stringify(r));
  r = await save('HA01', bossT1, { name: 'Mpho', role_id: roleId('Stores'), home_branch_id: MUREHWA, other_branches: [HARARE], pin: '7777', ...check() });
  ok('Boss adds Mpho (Stores) at Murehwa, also allowed at Harare', r.ok && r.staff.home_branch === 'Murehwa' && r.staff.here === true, JSON.stringify(r));
  const MPHO = r.staff.id;
  r = await save('HA01', bossT1, { name: 'NoPin', role_id: roleId('Cashier') });
  ok('a new person needs a PIN', /PIN/.test(r.raised || ''), JSON.stringify(r));
  r = await save('HA01', bossT1, { name: 'Tendai', role_id: roleId('Owner'), pin: '8888', ...check() });
  ok('an Admin may make the first Owner (no Owner yet)', r.ok, JSON.stringify(r));
  const TENDAI = r.staff.id;
  const ownTok = (await call('HA01', 'cl_device_staff_signin', { p_staff_id: TENDAI, p_pin: '8888' })).token;
  bossT1 = (await signin('HA01', 'Boss', '9090')).token;
  ok('... now Admins no longer have the Owner items', !(await has(bossT1, 'HA01', 'owner')) && await has(ownTok, 'HA01', 'owner'));
  r = await save('HA01', bossT1, { id: TENDAI, name: 'Tendai M' });
  ok('an Admin can\'t change an Owner', r.error === 'OWNER_ONLY', JSON.stringify(r));
  r = await save('HA01', ownTok, { id: TENDAI, role_id: roleId('Admin') });
  ok('the last Owner stays an Owner', r.error === 'LAST_OWNER', JSON.stringify(r));
  const role = (iid, tok, o) => call(iid, 'cl_device_role_save', { p_staff_token: tok, p_role: o });
  r = await role('HA01', bossT1, { name: 'Supervisor', rights: ['m.sell', 'm.reportwriter', 'other_branches', 'owner', 'nonsense'] });
  ok('a custom role: unknown rights and "owner" are dropped', r.ok && JSON.stringify(r.role.rights) === JSON.stringify(['m.reportwriter', 'm.sell', 'other_branches']), JSON.stringify(r));
  const SUP = r.role.id;
  ok('... the name is unique', (await role('HA01', bossT1, { name: 'supervisor', rights: [] })).error === 'NAME_TAKEN');
  ok('... the Owner role is fixed', (await role('HA01', bossT1, { id: roleId('Owner'), rights: [] })).error === 'OWNER_FIXED');
  ok('... an Admin can\'t delete a role once there is an Owner', (await role('HA01', bossT1, { id: SUP, delete: true })).error === 'OWNER_ONLY');
  ok('... a built-in role can\'t be deleted', (await role('HA01', ownTok, { id: roleId('Stores'), delete: true })).error === 'BUILTIN');
  ok('... Boss can\'t take Staff away from his own role', (await role('HA01', bossT1, { id: roleId('Admin'), rights: ['m.sell'] })).error === 'OWN_ROLE');
  r = await save('HA01', bossT1, { name: 'Kuda', role_id: SUP, home_branch_id: MUREHWA, pin: '5151', ...check() });
  ok('Kuda (Supervisor: other branches, no costs) at Murehwa', r.ok, JSON.stringify(r));
  const KUDA = r.staff.id;
  ok('... a role in use can\'t be deleted', (await role('HA01', ownTok, { id: SUP, delete: true })).error === 'IN_USE');

  // ---- other branches' reports (§R4) and costs (Q7) ----
  const rep = (iid, tok, kind, branch) => call(iid, 'cl_device_branch_report', { p_staff_token: tok, p_kind: kind, p_branch_id: branch });
  r = await rep('MU01', null, 'inventory', HARARE);
  ok('Murehwa, nobody signed in: Harare\'s report is refused', r.error === 'NO_RIGHT', JSON.stringify(r));
  r = await rep('MU01', null, 'inventory', MUREHWA);
  ok('... its own branch is fine, without costs', r.rows.length === 1 && r.rows[0].qty === 4 && r.rows[0].cost === null && r.costs === false, JSON.stringify(r));
  const sin = async (iid, id, pin) => (await call(iid, 'cl_device_staff_signin', { p_staff_id: id, p_pin: pin })).token;
  const mphoTok = await sin('MU01', MPHO, '7777'), kudaTok = await sin('MU01', KUDA, '5151');
  const faraiTok = (await call('MU01', 'cl_device_staff_signin', { p_staff_id: sOf(pm, 'Farai').id, p_pin: PIN.farai })).token;
  ok('Mpho (Stores) at Murehwa: refused', (await rep('MU01', mphoTok, 'inventory', HARARE)).error === 'NO_RIGHT');
  r = await rep('MU01', kudaTok, 'inventory', HARARE);
  ok('Kuda (other branches, no View costs): Harare 9 bibs, no cost', r.rows.length === 1 && r.rows[0].qty === 9 && r.rows[0].cost === null && r.rows[0].value === null, JSON.stringify(r));
  r = await rep('MU01', faraiTok, 'inventory', HARARE);
  ok('Farai (Admin): with the cost and the value', r.costs === true && Number(r.rows[0].cost) === 3.21 && Number(r.rows[0].value) === 28.89, JSON.stringify(r));
  r = await rep('MU01', kudaTok, 'dispatches', HARARE);
  ok('Harare\'s dispatches for Kuda: the lines, no unit cost', r.rows.length === 1 && r.rows[0].direction === 'out' && r.rows[0].other_branch === 'Murehwa' && r.rows[0].lines[0].unit_cost === null, JSON.stringify(r));
  r = await rep('MU01', faraiTok, 'dispatches', HARARE);
  ok('... for Farai with the unit cost', Number(r.rows[0].lines[0].unit_cost) === 3.21, JSON.stringify(r.rows[0].lines));
  ok('a token from another till doesn\'t count', (await rep('HA01', faraiTok, 'inventory', MUREHWA)).error === 'NO_RIGHT');
  r = await call('MU01', 'cl_device_dispatch_costs', { p_staff_token: kudaTok, p_dispatch_id: D1 });
  ok('a DN\'s costs: refused without View costs', r.error === 'NO_RIGHT', JSON.stringify(r));
  r = await call('MU01', 'cl_device_dispatch_costs', { p_staff_token: faraiTok, p_dispatch_id: D1 });
  ok('... given with it', Number(r.lines[0].unit_cost) === 3.21, JSON.stringify(r));
  const kinds = JSON.stringify([await rep('MU01', null, 'inventory', MUREHWA), await rep('MU01', kudaTok, 'dispatches', HARARE), await rep('MU01', kudaTok, 'supplier_grvs', HARARE), await rep('MU01', kudaTok, 'inventory', HARARE)]);
  ok('nothing without View costs carries a cost', !/3\.21|28\.89/.test(kinds), kinds.slice(0, 300));

  // ---- switching someone off ----
  r = await save('HA01', bossT1, { id: KUDA, active: false });
  ok('Kuda switched off: his session ends at once', r.ok && !(await has(kudaTok, 'MU01', 'other_branches')) && (await rep('MU01', kudaTok, 'inventory', HARARE)).error === 'NO_RIGHT');
  ok('... and he can\'t sign in', (await call('MU01', 'cl_device_staff_signin', { p_staff_id: KUDA, p_pin: '5151' })).error === 'NOT_FOUND');
  await call('HA01', 'cl_device_staff_signout', { p_staff_token: bossT1 });
  ok('sign-out ends the token', !(await has(bossT1, 'HA01', 'costs')));

  // ---- another business; the first manager of a new business ----
  r = await call('SO01', 'cl_device_staff_pull');
  ok('another business sees none of it (its main till gets its own 5 built-in roles)', r.roles.length === 5 && !r.roles.some((x) => p1.roles.some((y) => y.id === x.id)) &&
    r.staff.length === 0 && r.bootstrap === true, JSON.stringify(r).slice(0, 200));
  ok('... and can\'t sign anyone in', (await call('SO01', 'cl_device_staff_signin', { p_staff_id: TENDAI, p_pin: '8888' })).error === 'NOT_FOUND');
  const soloRoles = async () => (await call('SO01', 'cl_device_staff_pull')).roles;
  r = await save('SO01', null, { name: 'Solo Admin', role_id: null, pin: '2468', ...check() });
  ok('a new business: a role must be chosen', /Choose a role/.test(r.raised || ''), JSON.stringify(r));
  const soloAdmin = (await soloRoles()).find((x) => x.builtin === 'admin');
  r = await save('SO01', null, { name: 'Solo Admin', role_id: soloAdmin.id, pin: '2468', ...check() });
  ok('... its first manager is added on its main till without a token', r.ok, JSON.stringify(r));
  ok('... once only', (await save('SO01', null, { name: 'Second', role_id: soloAdmin.id, pin: '2468', ...check() })).error === 'NO_RIGHT');

  // ---- the delete guard and the merge ----
  r = await (async () => { try { await q('delete from cl_businesses where id = (select business_id from cl_branches where name = $1)', ['Mbare']); return {}; } catch (e) { return { e: e.message }; } })();
  ok('the delete guard counts shop staff', /shop staff/.test(r.e || ''), r.e);
  const SOLO = (await q(`select business_id from cl_branches where name = 'Mbare'`))[0].business_id;
  r = await (async () => { try { return (await q(`select cl_business_merge_core($1, $2, 'test merge', false, null) j`, [SOLO, BIZ]))[0].j; } catch (e) { return { e: e.message }; } })();
  ok('a merge moves the staff onto the other business\'s Admin role', r.ok && r.moved.shop_staff === 1 &&
    (await q(`select r.business_id = $1 and r.builtin = 'admin' x from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id where s.name = 'Solo Admin'`, [BIZ]))[0].x &&
    (await q('select count(*)::int n from cl_shop_roles where business_id = $1', [SOLO]))[0].n === 0, JSON.stringify(r));

  // grants
  const can = async (role, fn) => (await q(`select has_function_privilege($1, $2, 'execute') x`, [role, fn]))[0].x;
  ok('devices may call the staff functions and the reports',
    await can('anon', 'public.cl_device_staff_pull(text,text,text)') && await can('anon', 'public.cl_device_staff_signin(text,text,text,uuid,text)') &&
    await can('anon', 'public.cl_device_branch_report(text,text,text,text,text,uuid,timestamptz,timestamptz)'));
  ok('the helpers and the tables are internal', !(await can('anon', 'public.cl_staff_has(text,uuid,text)')) && !(await can('anon', 'public.cl_shop_ensure_roles(uuid)')) &&
    !(await q(`select has_table_privilege('anon', 'public.cl_shop_staff', 'select') x`))[0].x && !(await q(`select has_table_privilege('authenticated', 'public.cl_shop_staff_sessions', 'select') x`))[0].x);

  r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('a second run is refused and changes nothing', /already exists/.test(r.e || ''), r.e);

  r = await (async () => { try { await pg.exec(RB); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('the rollback applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
