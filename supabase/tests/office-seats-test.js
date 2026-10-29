// node supabase/tests/office-seats-test.js
//
// Tests supabase/migrations/20261109120000_office_seats.sql (and its
// rollback) in an in-memory PGlite built from the repo (the live shape),
// never the live database:
//   - invites: Owner/Admin only, on a main-branch device; not for a Cashier;
//     one use, 24 h, revocable; a seat code never makes a till (and back);
//   - joining without the business phrase; 5 wrong codes per install lock it,
//     20 per caller address when seiGEN sees one (only its hash is kept);
//   - the PIN before approval (set, or the person's own, counted like a
//     sign-in); approval by the Owner/an Admin with the device check; refusal;
//   - an unapproved seat gets nothing; on a seat the changing calls need the
//     signed-in person's right; selling and iTred orders are always refused;
//     tills unchanged;
//   - billing: seats at the extra-till fee, never ranked as a till; the
//     licence's seat bit; the business bill; the Console's accounts;
//   - internal transfers seat <-> till: send, receive with a shortage, write
//     off / keep, cancel, the rules;
//   - grants, RLS, audit without secrets; a second run is refused; the
//     rollback is refused while seats exist and restores the catalogue.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261109120000_office_seats.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261109120000_office_seats.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = (n) => crypto.randomBytes(n || 16).toString('hex');
const check = () => ({ p_pin_salt: hex(16), p_pin_check: hex(32), p_pin_rounds: 150000 });
const staffCheck = () => ({ pin_salt: hex(16), pin_check: hex(32), pin_rounds: 150000 });
const seatCheckOf = (k) => { const h = crypto.createHash('sha256').update(k, 'utf8').digest('hex').toUpperCase(); return h.slice(0, 2) + '-' + h.slice(2, 4); };
const exec = async (pg, sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261110120000_staff_first_owner.sql', '20261112120000_builtin_customers.sql', '20261113120000_sales_sync.sql', '20261113180000_removed_devices.sql', '20261114120000_roles_everywhere.sql', '20261115120000_stock_control.sql', '20261116120000_vendor_register_status.sql', '20261117120000_srq_drafts.sql']) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const PHRASE = {};                                    // a seat's own phrase, from cl_seat_join
  let HEADERS = null;                                   // request.headers as PostgREST would set them
  const anon = async (fn, args, claims) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false), set_config('request.headers', $2, false)`,
      [claims ? JSON.stringify(claims) : '', HEADERS ? JSON.stringify(HEADERS) : '']);
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false), set_config('request.headers', '', false)`); }
  };
  const auth = (iid, tok) => ({ p_install_id: iid, p_secret_phrase: (PHRASE[iid] || 'Mandie Phrase') + (tok ? '|' + tok : ''), p_device_key: key(iid) });
  const call = async (iid, fn, args, tok) => { const r = await anon(fn, { ...auth(iid, tok), ...(args || {}) }); return r.e ? { raised: r.e } : r.j; };
  const seed = () => { const s = { salt: hex(16), rounds: 150000 }; s.check = hex(32); return s; };
  const code = async (iid, o) => { const s = seed(); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 32 })).j;

  // ---- the business: Harare (main) T1 + T2, Murehwa T1; Boss (Admin) and Rudo (Cashier) ----
  let r = await anon('cl_branch_register', { ...auth('HA01'), p_business_name: 'Mandie Babyware', p_branch_name: 'Harare' });
  const HARARE = r.j.branch_id, BIZ = r.j.business_id;
  await join('HA02', (await code('HA01', { p_branch_id: HARARE })).code);
  const MUREHWA = (await join('MU01', (await code('HA01', { p_new_branch_name: 'Murehwa' })).code)).branch_id;
  await q(`update cl_shop_meta set v = now() - interval '1 day' where k = 'legacy_cutoff'`);
  const roles = Object.fromEntries((await call('HA01', 'cl_device_staff_pull')).roles.map((x) => [x.builtin || x.name, x.id]));
  r = await call('HA01', 'cl_device_staff_save', { p_staff_token: null, p_staff: { name: 'Boss', role_id: roles.admin, home_branch_id: HARARE, pin: '1234', ...staffCheck() } });
  ok('(main T1 adds the first manager, Boss (Admin), with the Admin passcode path)', r.ok, JSON.stringify(r));
  const ID = { Boss: r.staff.id };
  const signin = async (iid, name, pin) => call(iid, 'cl_device_staff_signin', { p_staff_id: ID[name], p_pin: pin });
  const bossT1 = (await signin('HA01', 'Boss', '1234')).token;
  r = await call('HA01', 'cl_device_staff_save', { p_staff_token: bossT1, p_staff: { name: 'Rudo', role_id: roles.cashier, home_branch_id: HARARE, pin: '3333', ...staffCheck() } });
  ID.Rudo = r.staff.id;
  r = await call('HA01', 'cl_device_role_save', { p_staff_token: bossT1, p_role: { name: 'Bookkeeper', rights: ['m.reports', 'm.reportwriter', 'sales_reports', 'm.productlist'] } });
  ok('(a custom role "Bookkeeper": reports only)', r.ok, JSON.stringify(r));
  roles.Bookkeeper = r.role.id;
  const rudoT1 = (await signin('HA01', 'Rudo', '3333')).token;
  const before = fingerprint(await snapshot(q));

  // ---- the migration ----
  r = await exec(pg, MIG);
  ok('it applies', r.ok, r.e);
  ok('existing devices are tills and approved', (await q(`select count(*)::int n from cl_terminals where device_kind = 'till' and approval_status = 'approved'`))[0].n === 3);
  r = await code('HA01', { p_branch_id: HARARE });
  ok('a till join code still works (T3 of Harare)', (await join('HA03', r.code)).till_code === 'T3');

  // ---- invites ----
  const invite = (iid, tok, o) => call(iid, 'cl_device_seat_invite_create', { p_staff_token: tok, ...o });
  ok('no invite without someone signed in', (await invite('HA01', null, { p_name: 'Tendai', p_role_id: roles.manager })).error === 'NO_RIGHT');
  ok('... nor by a Cashier', (await invite('HA01', rudoT1, { p_name: 'Tendai', p_role_id: roles.manager })).error === 'NO_RIGHT');
  const bossMU = (await signin('MU01', 'Boss', '1234')).token;
  ok('... nor from a remote branch (even by the Admin)', bossMU && (await invite('MU01', bossMU, { p_name: 'Tendai', p_role_id: roles.manager })).error === 'NO_RIGHT');
  ok('... nor for the Cashier role', (await invite('HA01', bossT1, { p_name: 'Tendai', p_role_id: roles.cashier })).error === 'CASHIER_ROLE');
  ok('... nor Owner by an Admin once there is an Owner? (no Owner yet: an Admin keeps the Owner items)',
    (await invite('HA01', bossT1, { p_name: 'Nobody', p_role_id: roles.owner })).ok === true);
  const inv1 = await invite('HA01', bossT1, { p_name: 'Tendai', p_role_id: roles.manager });
  ok('the Admin invites Tendai (Manager): an 8-character code, 24 hours', inv1.ok && /^[A-HJKMNP-Z2-9]{8}$/.test(inv1.code) &&
    Math.abs(Date.parse(inv1.expires_ts) - Date.now() - 24 * 3600e3) < 120e3, JSON.stringify(inv1));
  ok('seiGEN keeps only the code\'s hash', (await q(`select count(*)::int n from cl_branch_join_codes where code_hash = encode(extensions.digest($1, 'sha256'), 'hex') and code_kind = 'seat'`, [inv1.code]))[0].n === 1 &&
    !JSON.stringify(await q(`select * from cl_branch_join_codes`)).includes(inv1.code));
  ok('a seat code never makes a till', (await join('XX01', inv1.code)).error === 'JOIN_CODE_INVALID');
  ok('... and a till code never makes a seat', (await anon('cl_seat_join', { p_install_id: 'XX02', p_device_key: key('XX02'), p_code: (await code('HA01', { p_branch_id: HARARE })).code, p_app_build: 32 })).j.error === 'JOIN_CODE_INVALID');
  let list = await call('HA01', 'cl_device_seat_invites', { p_staff_token: bossT1 });
  ok('the invite list shows Tendai, open', list.invites.some((x) => x.person === 'Tendai' && x.status === 'open' && x.role === 'Manager'), JSON.stringify(list));

  // ---- joining ----
  const seatJoin = (iid, c, build, hint) => anon('cl_seat_join', { p_install_id: iid, p_device_key: key(iid), p_code: c, p_app_build: build == null ? 32 : build, p_join_hint: hint || 'Android · Chrome' }).then((x) => x.j || { raised: x.e });
  for (let i = 0; i < 5; i++) await seatJoin('SE01', 'AAAA-BBB' + i);
  r = await seatJoin('SE01', inv1.code);
  ok('5 wrong codes lock joining on that device for an hour (even the right code)', r.error === 'SEAT_JOIN_LOCKED', JSON.stringify(r));
  await q(`update cl_join_failures set ts = ts - interval '2 hours' where install_id = 'SE01'`);
  r = await seatJoin('SE01', inv1.code, 31);
  ok('an app before v32 is asked to update first (the code stays valid)', r.error === 'APP_UPDATE_NEEDED');
  r = await seatJoin('SE01', inv1.code.slice(0, 4) + '-' + inv1.code.slice(4));
  ok('joining: no business phrase; a pending seat S1 of the main branch with its own phrase', r.ok && r.till_code === 'S1' && r.approval === 'pending' &&
    r.is_main === true && /^[0-9a-f]{48}$/.test(r.device_phrase) && r.person_name === 'Tendai' && r.role_name === 'Manager', JSON.stringify(r));
  ok('... the device check is the first 2 bytes of SHA-256(device key)', r.check === seatCheckOf(key('SE01')), r.check);
  ok('... the business phrase is never sent', !JSON.stringify(r).includes('Mandie Phrase'));
  PHRASE.SE01 = r.device_phrase;
  const S1 = r.terminal_id;
  r = await seatJoin('SE01', inv1.code);
  ok('a retried join from the same device answers the same', r.ok && r.terminal_id === S1 && r.device_phrase === PHRASE.SE01);
  ok('the code is single use', (await seatJoin('SE09', inv1.code)).error === 'JOIN_CODE_USED');
  HEADERS = { 'x-forwarded-for': '196.27.10.5, 10.0.0.1' };
  for (let i = 0; i < 20; i++) await seatJoin('IP' + String(i).padStart(2, '0'), 'ZZZZ-ZZZ' + (i % 9));
  r = await seatJoin('IP99', 'ZZZZ-ZZZ1');
  ok('20 wrong codes from one address lock that address (hashed, never stored as is)', r.error === 'SEAT_JOIN_LOCKED' &&
    (await q(`select count(*)::int n from cl_join_failures where ip_hash is not null`))[0].n === 20 &&
    !JSON.stringify(await q(`select * from cl_join_failures`)).includes('196.27'), JSON.stringify(r));
  HEADERS = null;
  const inv2 = await invite('HA01', bossT1, { p_name: 'Late', p_role_id: roles.manager });
  await q(`update cl_branch_join_codes set expires_ts = now() - interval '1 minute' where code_hash = encode(extensions.digest($1, 'sha256'), 'hex')`, [inv2.code]);
  ok('an expired invite is refused', (await seatJoin('SE08', inv2.code)).error === 'JOIN_CODE_EXPIRED');
  const inv3 = await invite('HA01', bossT1, { p_name: 'Gone', p_role_id: roles.manager });
  ok('the Admin revokes an unused invite', (await call('HA01', 'cl_device_seat_invite_revoke', { p_staff_token: bossT1, p_invite_id: inv3.invite_id })).ok === true);
  ok('... a revoked invite is refused', (await seatJoin('SE07', inv3.code)).error === 'INVITE_REVOKED');
  ok('... a used one can\'t be revoked (refuse the seat instead)', (await call('HA01', 'cl_device_seat_invite_revoke', { p_staff_token: bossT1, p_invite_id: inv1.invite_id })).error === 'ALREADY_USED');

  // ---- waiting: nothing for the seat until approved ----
  ok('a pending seat gets nothing: staff pull refused', /SEAT_NOT_APPROVED/.test((await call('SE01', 'cl_device_staff_pull')).raised || ''));
  ok('... catalogue pull refused', /SEAT_NOT_APPROVED/.test((await call('SE01', 'cl_catalogue_pull', { p_cursor: 0 })).raised || ''));
  r = await call('SE01', 'cl_seat_status');
  ok('... but it can ask where it stands', r.ok && r.approval === 'pending' && r.pin_ok === false && r.check === seatCheckOf(key('SE01')), JSON.stringify(r));
  list = await call('HA01', 'cl_device_seat_invites', { p_staff_token: bossT1 });
  let seat = list.seats.find((x) => x.id === S1);
  ok('the Admin sees the waiting seat: person, role, device hint, the same check', seat && seat.approval === 'pending' && seat.person === 'Tendai' &&
    seat.join_hint === 'Android · Chrome' && seat.check === seatCheckOf(key('SE01')), JSON.stringify(seat));
  ok('approval waits for the PIN', (await call('HA01', 'cl_device_seat_approve', { p_staff_token: bossT1, p_terminal_id: S1, p_check: seat.check })).error === 'PIN_NOT_SET');
  ok('a PIN that isn\'t 4-6 digits is refused', (await call('SE01', 'cl_seat_set_pin', { p_pin: '12', ...check() })).error === 'BAD_PIN_FORMAT');
  ok('Tendai sets a PIN on the seat', (await call('SE01', 'cl_seat_set_pin', { p_pin: '5151', ...check() })).ok === true);
  ok('... not yet a person on seiGEN (made at approval)', (await q(`select count(*)::int n from cl_shop_staff where name = 'Tendai'`))[0].n === 0);
  ok('a wrong device check: not approved', (await call('HA01', 'cl_device_seat_approve', { p_staff_token: bossT1, p_terminal_id: S1, p_check: '00-00' })).error === 'CHECK_MISMATCH');
  ok('a Cashier can\'t approve', (await call('HA01', 'cl_device_seat_approve', { p_staff_token: rudoT1, p_terminal_id: S1, p_check: seat.check })).error === 'NO_RIGHT');
  r = await call('HA01', 'cl_device_seat_approve', { p_staff_token: bossT1, p_terminal_id: S1, p_check: seat.check });
  ok('the Admin approves with the matching check', r.ok && r.till_code === 'S1' && r.person === 'Tendai', JSON.stringify(r));
  ok('... Tendai is a Manager at Harare now, with the PIN set on the seat',
    (await q(`select count(*)::int n from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id where s.name = 'Tendai' and r.builtin = 'manager' and s.home_branch_id = $1 and s.pin_bcrypt is not null`, [HARARE]))[0].n === 1);
  ok('... and the invite no longer holds the PIN', (await q(`select count(*)::int n from cl_branch_join_codes where code_kind = 'seat' and pin_bcrypt is not null and used_by_terminal = $1`, [S1]))[0].n === 0);
  ok('(approving again answers already)', (await call('HA01', 'cl_device_seat_approve', { p_staff_token: bossT1, p_terminal_id: S1, p_check: seat.check })).already === true);

  // ---- on the seat ----
  let pull = await call('SE01', 'cl_device_staff_pull');
  ID.Tendai = pull.staff.find((s) => s.name === 'Tendai').id;
  ok('the approved seat pulls the staff: Tendai and Boss may sign in, Rudo (Cashier, Harare) too by branch', pull.staff.find((s) => s.name === 'Tendai').here && pull.staff.find((s) => s.name === 'Boss').here);
  r = await signin('SE01', 'Tendai', '5151');
  ok('Tendai signs in on the seat', r.ok && r.token, JSON.stringify(r));
  const tenS1 = r.token;
  ok('selling is refused on a seat, signed in or not', /SEAT_NO_SELLING/.test((await call('SE01', 'cl_stock_sale', { p_sale_uid: hex(), p_lines: [] }, tenS1)).raised || '') &&
    /SEAT_NO_SELLING/.test((await call('SE01', 'cl_stock_sale', { p_sale_uid: hex(), p_lines: [] })).raised || ''));
  ok('... iTred orders too', /SEAT_NO_SELLING/.test((await call('SE01', 'cl_device_itred_order_complete', { p_uid: crypto.randomUUID(), p_order_id: crypto.randomUUID() }, tenS1)).raised || ''));
  const supplier = () => ({ p_supplier: { id: crypto.randomUUID(), name: 'Supplier ' + hex(3) } });
  ok('a change needs someone signed in on the seat', /SEAT_SIGN_IN/.test((await call('SE01', 'cl_device_supplier_save', supplier())).raised || ''));
  r = await call('SE01', 'cl_device_supplier_save', supplier(), tenS1);
  ok('... Tendai (Manager: Purchasing) saves a supplier on the seat', r.ok === true || !!r.supplier, JSON.stringify(r));
  ok('... a token from another device doesn\'t count', /SEAT_SIGN_IN/.test((await call('SE01', 'cl_device_supplier_save', supplier(), bossT1)).raised || ''));
  r = await call('SE01', 'cl_catalogue_push', { p_rows: [{ uid: hex(), op_id: hex(), code: 'BW-1', name: 'Bottle warmer', price: 12, cost: 7 }] }, tenS1);
  ok('... and a product (Products right)', r.results && r.results[0].status === 'applied', JSON.stringify(r));
  ok('tills are unchanged: T1 saves a supplier with nobody signed in', ((x) => x.ok === true || !!x.supplier)(await call('HA01', 'cl_device_supplier_save', supplier())));
  ok('... and T1 can\'t sell? (not a shared-stock branch: the same answer as before)', !/SEAT_/.test(JSON.stringify(await call('HA01', 'cl_stock_sale', { p_sale_uid: hex(), p_lines: [] }))));

  // a second seat: a new person with the custom Bookkeeper role (no Purchasing)
  const inv4 = await invite('HA01', bossT1, { p_name: 'Chipo', p_role_id: roles.Bookkeeper });
  r = await seatJoin('SE02', inv4.code, 32, 'Windows · Edge'); PHRASE.SE02 = r.device_phrase; const S2 = r.terminal_id;
  ok('a second seat is S2', r.till_code === 'S2');
  await call('SE02', 'cl_seat_set_pin', { p_pin: '7272', ...check() });
  await call('HA01', 'cl_device_seat_approve', { p_staff_token: bossT1, p_terminal_id: S2, p_check: seatCheckOf(key('SE02')) });
  ID.Chipo = (await call('SE02', 'cl_device_staff_pull')).staff.find((s) => s.name === 'Chipo').id;
  const chiS2 = (await signin('SE02', 'Chipo', '7272')).token;
  ok('Chipo (Bookkeeper) can\'t save a supplier on a seat: no right', /SEAT_NO_RIGHT/.test((await call('SE02', 'cl_device_supplier_save', supplier(), chiS2)).raised || ''));

  // an existing person with a PIN: they enter their own PIN
  const inv5 = await invite('HA01', bossT1, { p_staff_id: ID.Boss });
  ok('an invite for an existing person (Boss)', inv5.ok && inv5.existing_person === true && inv5.person_name === 'Boss');
  r = await seatJoin('SE03', inv5.code); PHRASE.SE03 = r.device_phrase; const S3 = r.terminal_id;
  ok('... the seat knows Boss already has a PIN', r.person_has_pin === true);
  r = await call('SE03', 'cl_seat_set_pin', { p_pin: '9999' });
  ok('... a wrong PIN is counted like a sign-in', r.error === 'BAD_PIN' && (await q(`select count(*)::int n from cl_shop_staff_signin_fails where staff_id = $1`, [ID.Boss]))[0].n === 1);
  r = await call('SE03', 'cl_seat_set_pin', { p_pin: '1234' });
  ok('... his own PIN is accepted and stays his PIN', r.ok && r.existing_pin === true);
  await call('HA01', 'cl_device_seat_approve', { p_staff_token: bossT1, p_terminal_id: S3, p_check: seatCheckOf(key('SE03')) });
  ok('... after approval Boss still signs in on T1 with 1234', (await signin('HA01', 'Boss', '1234')).ok === true);

  // refused
  const inv6 = await invite('HA01', bossT1, { p_name: 'Stranger', p_role_id: roles.stores });
  r = await seatJoin('SE04', inv6.code); PHRASE.SE04 = r.device_phrase; const S4 = r.terminal_id;
  r = await call('HA01', 'cl_device_seat_refuse', { p_staff_token: bossT1, p_terminal_id: S4, p_reason: 'Not ours' });
  ok('the Admin refuses a waiting seat', r.ok === true);
  r = await call('SE04', 'cl_seat_status');
  ok('... it sees "refused" and stays shut out', r.approval === 'refused' && r.active === false && /SEAT_NOT_APPROVED/.test((await call('SE04', 'cl_device_staff_pull')).raised || ''), JSON.stringify(r));
  ok('... the same install can\'t join again', (await seatJoin('SE04', (await invite('HA01', bossT1, { p_name: 'Again', p_role_id: roles.stores })).code)).error === 'ALREADY_JOINED');

  // ---- billing ----
  r = await call('HA02', 'cl_business_bill');
  const fee = (tc) => (r.devices.find((d) => d.till_code === tc) || {}).unit_fee;
  ok('the business bill: T1 main 15, T2 and T3 3 each, Murehwa 7, each approved seat 3 -> 37',
    fee('T1') === 15 && fee('T2') === 3 && fee('T3') === 3 && fee('S1') === 3 && fee('S2') === 3 && fee('S3') === 3 && r.total === 37 &&
    r.devices.find((d) => d.branch === 'Murehwa').unit_fee === 7 && r.devices[0].till_code === 'T1' &&
    r.devices.find((d) => d.till_code === 'S1').role === 'seat', JSON.stringify(r));
  const inv7 = await invite('HA01', bossT1, { p_name: 'Pending', p_role_id: roles.manager });
  r = await seatJoin('SE05', inv7.code); PHRASE.SE05 = r.device_phrase;
  r = await call('HA02', 'cl_business_bill');
  ok('... a waiting seat is listed but not billed', r.total === 37 && r.devices.find((d) => d.till_code === 'S5').problem === 'Waiting for approval', JSON.stringify(r.devices));
  const T1 = (await q(`select id from cl_terminals where install_id = 'HA01'`))[0].id;
  await call('HA02', 'cl_terminal_set_active', { p_terminal_id: T1, p_active: false });
  r = await call('HA02', 'cl_business_bill');
  ok('a seat is never ranked as the main till: T1 off -> T2 is main (15), the seats stay 3',
    fee('T2') === 15 && fee('S1') === 3 && !r.devices.some((d) => d.till_code === 'T1' && d.branch === 'Harare'), JSON.stringify(r.devices));
  await call('HA02', 'cl_terminal_set_active', { p_terminal_id: T1, p_active: true });
  // the Console (staff)
  const staffId = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), 'Staff SYS', 'x', true, true, now()) returning id`))[0].id;
  const tok = { role: 'authenticated', sub: staffId, user_type: 'staff', is_sysadmin: true };
  r = await anon('cl_plan_accounts', {}, tok);
  const acct = (r.j || []).find ? r.j.find((a) => a.business_id === BIZ) : null;
  ok('the Console\'s accounts count the seats at 3 (role "seat") in the business total',
    acct && acct.tills.filter((t) => t.role === 'seat').length === 3 && acct.tills.filter((t) => t.role === 'seat').every((t) => t.unit_fee === 3), JSON.stringify(acct || r).slice(0, 500));
  // Lite (one branch): a shop with its main till and a seat -> 6 + 3
  r = await anon('cl_branch_register', { ...auth('TU01'), p_business_name: 'Tuck', p_branch_name: 'Canteen' });
  const TUCK = r.j.business_id, CANTEEN = r.j.branch_id;
  ok('(Tuck goes on Lite)', ((x) => !x.e)(await anon('cl_set_plan', { p_business_id: TUCK, p_vendor_id: null, p_plan_code: 'lite', p_reason: 'test' }, tok)));
  const tRoles = Object.fromEntries((await call('TU01', 'cl_device_staff_pull')).roles.map((x) => [x.builtin || x.name, x.id]));
  r = await call('TU01', 'cl_device_staff_save', { p_staff_token: null, p_staff: { name: 'Mai Tuck', role_id: tRoles.owner, home_branch_id: CANTEEN, pin: '4444', ...staffCheck() } });
  ID['Mai Tuck'] = r.staff.id;
  const tuckTok = (await signin('TU01', 'Mai Tuck', '4444')).token;
  const invT = await invite('TU01', tuckTok, { p_name: 'Clerk', p_role_id: tRoles.stores });
  r = await seatJoin('TS01', invT.code); PHRASE.TS01 = r.device_phrase;
  await call('TS01', 'cl_seat_set_pin', { p_pin: '8080', ...check() });
  await call('TU01', 'cl_device_seat_approve', { p_staff_token: tuckTok, p_terminal_id: r.terminal_id, p_check: seatCheckOf(key('TS01')) });
  r = await call('TU01', 'cl_business_bill');
  ok('on Lite a seat is allowed and costs 3 too: 6 + 3 = 9', /Lite/i.test(r.plan_name || '') && fee('T1') === 6 && fee('S1') === 3 && r.total === 9, JSON.stringify(r).slice(0, 400));
  // the licence's seat bit
  const tagOf = async (iid) => (await q(`select public.cl_licence_tag(public.cl_licence_hash($1)) t`, [key(iid)]))[0].t;
  const prep = async (iid) => anon('cl_licence_prepare', { p_device_code: iid + '-' + await tagOf(iid), p_days: 30 }, tok);
  r = await prep('SE01');
  const lic = r.j && r.j.licences && r.j.licences[0];
  const pay = lic ? Buffer.from(lic.payload_hex, 'hex') : null;
  ok('a seat\'s licence: role seat at 3, features bit 1 in the signed payload', lic && lic.till_role === 'seat' && Number(lic.unit_fee) === 3 && pay[28] === 0 && pay[29] === 1 &&
    (await q(`select features from cl_licences where serial = $1`, [lic.serial]))[0].features === 1, JSON.stringify(r).slice(0, 400));
  r = await prep('HA02');
  ok('... a till\'s: features 0', r.j && Buffer.from(r.j.licences[0].payload_hex, 'hex')[29] === 0);
  r = await prep('SE05');
  ok('... a waiting seat gets no licence', /SEAT_NOT_APPROVED/.test(r.e || JSON.stringify(r.j)), JSON.stringify(r).slice(0, 300));

  // ---- internal transfers ----
  const T1id = T1, T2 = (await q(`select id from cl_terminals where install_id = 'HA02'`))[0].id, MU1 = (await q(`select id from cl_terminals where install_id = 'MU01'`))[0].id;
  const tr = (to, no, lines) => ({ p_transfer: { id: crypto.randomUUID(), it_no: no, it_display: 'IT-S1-' + no, to_terminal_id: to, created_iso: new Date().toISOString(), sent_by: 'Tendai',
    lines: lines || [{ line_no: 1, cat_uid: hex(), code: 'BW-1', name: 'Bottle warmer', qty: 10 }, { line_no: 2, code: 'NP-2', name: 'Nappies', qty: 4 }] } });
  ok('a transfer from the seat needs someone signed in', /SEAT_SIGN_IN/.test((await call('SE01', 'cl_device_transfer_send', tr(T1id, 1))).raised || ''));
  ok('... never to another branch', (await call('SE01', 'cl_device_transfer_send', tr(MU1, 1), tenS1)).error === 'BAD_DESTINATION');
  ok('... never till to till', (await call('HA02', 'cl_device_transfer_send', tr(T1id, 1))).error === 'SEAT_AND_TILL');
  ok('... never seat to seat', (await call('SE01', 'cl_device_transfer_send', tr(S2, 1), tenS1)).error === 'SEAT_AND_TILL');
  ok('... never to a waiting seat', (await call('HA01', 'cl_device_transfer_send', tr((await q(`select id from cl_terminals where install_id = 'SE05'`))[0].id, 1))).error === 'DESTINATION_OFF');
  const t1 = tr(T1id, 1);
  r = await call('SE01', 'cl_device_transfer_send', t1, tenS1);
  ok('the seat sends IT-S1-1 to T1 (store room -> shop floor)', r.ok && r.transfer.status === 'sent' && r.transfer.from_kind === 'seat' && r.transfer.to_till === 'T1', JSON.stringify(r));
  ok('... sending it again answers the same', (await call('SE01', 'cl_device_transfer_send', t1, tenS1)).already === true);
  ok('... no cost travels with it', !JSON.stringify(r).includes('cost'));
  r = await call('HA01', 'cl_device_transfers_pull');
  ok('T1 sees it incoming', r.incoming.length === 1 && r.incoming[0].it_display === 'IT-S1-1');
  ok('T1 can\'t receive more than was sent', /received must be/.test((await call('HA01', 'cl_device_transfer_receive', { p_transfer_id: t1.p_transfer.id, p_by: 'Rudo', p_lines: [{ line_no: 1, received: 11 }, { line_no: 2, received: 4 }] })).raised || ''));
  ok('... or leave a line out', /received must be/.test((await call('HA01', 'cl_device_transfer_receive', { p_transfer_id: t1.p_transfer.id, p_by: 'Rudo', p_lines: [{ line_no: 1, received: 10 }] })).raised || ''));
  ok('only the receiving device confirms', (await call('HA02', 'cl_device_transfer_receive', { p_transfer_id: t1.p_transfer.id, p_by: 'x', p_lines: [] })).error === 'NOT_YOURS');
  r = await call('HA01', 'cl_device_transfer_receive', { p_transfer_id: t1.p_transfer.id, p_by: 'Rudo', p_lines: [{ line_no: 1, received: 8 }, { line_no: 2, received: 4 }] });
  ok('T1 confirms 8 of 10 and 4 of 4: received short, line 1 short 2 (open)', r.ok && r.transfer.status === 'received_short' &&
    r.transfer.lines[0].short === 2 && r.transfer.lines[0].short_status === 'open' && r.transfer.lines[1].short_status === null, JSON.stringify(r));
  ok('... the first answer counts', (await call('HA01', 'cl_device_transfer_receive', { p_transfer_id: t1.p_transfer.id, p_by: 'Rudo', p_lines: [{ line_no: 1, received: 10 }, { line_no: 2, received: 4 }] })).already === true);
  ok('the sender sees the shortage', (await call('SE01', 'cl_device_transfers_pull')).outgoing.find((x) => x.id === t1.p_transfer.id).lines[0].short === 2);
  ok('only the sender settles it', (await call('HA01', 'cl_device_transfer_resolve', { p_transfer_id: t1.p_transfer.id, p_line_no: 1, p_action: 'keep', p_by: 'x', p_note: null, p_adj_display: null })).error === 'NOT_SENDER');
  ok('Chipo (no write-off right) can\'t write it off on her seat... (not her transfer either)', /SEAT_NO_RIGHT/.test((await call('SE02', 'cl_device_transfer_resolve', { p_transfer_id: t1.p_transfer.id, p_line_no: 1, p_action: 'write_off', p_by: 'Chipo', p_note: 'lost', p_adj_display: 'ADJ-1' }, chiS2)).raised || ''));
  ok('a write-off needs its ADJ number', /ADJ number/.test((await call('SE01', 'cl_device_transfer_resolve', { p_transfer_id: t1.p_transfer.id, p_line_no: 1, p_action: 'write_off', p_by: 'Tendai', p_note: 'Lost on the way', p_adj_display: null }, tenS1)).raised || ''));
  r = await call('SE01', 'cl_device_transfer_resolve', { p_transfer_id: t1.p_transfer.id, p_line_no: 1, p_action: 'write_off', p_by: 'Tendai', p_note: 'Lost on the way', p_adj_display: 'ADJ-S1-1' }, tenS1);
  ok('Tendai writes off the 2 (ADJ-S1-1)', r.ok && r.transfer.lines[0].short_status === 'written_off' && r.transfer.lines[0].adj_display === 'ADJ-S1-1', JSON.stringify(r));
  ok('... no line without a shortage to settle', (await call('SE01', 'cl_device_transfer_resolve', { p_transfer_id: t1.p_transfer.id, p_line_no: 2, p_action: 'keep', p_by: 'Tendai', p_note: null, p_adj_display: null }, tenS1)).error === 'NO_SHORTAGE');
  ok('a received transfer can\'t be cancelled', (await call('SE01', 'cl_device_transfer_cancel', { p_transfer_id: t1.p_transfer.id, p_by: 'Tendai', p_reason: 'oops' }, tenS1)).error === 'ALREADY_RECEIVED');
  const t2 = tr(S1, 7, [{ line_no: 1, code: 'NP-2', name: 'Nappies', qty: 3 }]);
  r = await call('HA02', 'cl_device_transfer_send', t2);
  ok('T2 sends back to the seat (shop floor -> store room)', r.ok && r.transfer.to_kind === 'seat');
  ok('... T2 cancels it before it is received (a reason is needed)', /reason/.test((await call('HA02', 'cl_device_transfer_cancel', { p_transfer_id: t2.p_transfer.id, p_by: 'Rudo', p_reason: '' })).raised || '') &&
    (await call('HA02', 'cl_device_transfer_cancel', { p_transfer_id: t2.p_transfer.id, p_by: 'Rudo', p_reason: 'Wrong items' })).transfer.status === 'cancelled');
  ok('... the seat can\'t receive a cancelled one', (await call('SE01', 'cl_device_transfer_receive', { p_transfer_id: t2.p_transfer.id, p_by: 'Tendai', p_lines: [{ line_no: 1, received: 3 }] }, tenS1)).error === 'CANCELLED');
  const t3 = tr(S1, 8, [{ line_no: 1, code: 'NP-2', name: 'Nappies', qty: 3 }]);
  await call('HA02', 'cl_device_transfer_send', t3);
  ok('receiving on the seat needs someone with Receive', /SEAT_SIGN_IN/.test((await call('SE01', 'cl_device_transfer_receive', { p_transfer_id: t3.p_transfer.id, p_by: 'x', p_lines: [{ line_no: 1, received: 3 }] })).raised || '') &&
    (await call('SE01', 'cl_device_transfer_receive', { p_transfer_id: t3.p_transfer.id, p_by: 'Tendai', p_lines: [{ line_no: 1, received: 3 }] }, tenS1)).transfer.status === 'received');
  ok('(T2\'s numbers are T2\'s own: IT 7 and 8 next to the seat\'s IT 1)', (await call('HA02', 'cl_device_transfers_pull')).max_it_no === 8);

  // ---- shared stock and the main branch ----
  r = await call('HA01', 'cl_stock_start_shared', { p_op_id: hex(), p_rows: [] });
  ok('a main branch with an Office seat can\'t switch to shared stock', r.error === 'SEATS_HERE', JSON.stringify(r));
  await q(`update cl_branches set stock_mode = 'shared' where id = $1`, [HARARE]);
  ok('... and a shared-stock main can\'t invite a seat', (await invite('HA01', bossT1, { p_name: 'X', p_role_id: roles.manager })).error === 'SHARED_STOCK');
  await q(`update cl_branches set stock_mode = 'own' where id = $1`, [HARARE]).catch(async () => q(`update cl_branches set stock_mode = default where id = $1`, [HARARE]));
  ok('per-device figures count approved devices only', (await q(`select cl_bs_enabled($1) x`, [BIZ]))[0].x === true);
  r = await call('HA01', 'cl_branch_list');
  const hb = r.branches.find((b) => b.is_main);
  ok('the device list shows each device\'s kind and approval', hb.terminals.find((t) => t.till_code === 'S1').kind === 'seat' && hb.terminals.find((t) => t.till_code === 'S5').approval === 'pending' &&
    hb.terminals.find((t) => t.till_code === 'T1').kind === 'till');

  // ---- grants, RLS, audit ----
  const can = async (role, fn) => (await q(`select has_function_privilege($1, $2, 'execute') x`, [role, fn]))[0].x;
  ok('the helpers are internal', !(await can('anon', 'public.cl_seat_need(text)')) && !(await can('anon', 'public.cl_seat_features(uuid)')) &&
    !(await can('anon', 'public.cl_seat_check(text)')) && !(await can('anon', 'public.cl_seat_ip_hash()')) && !(await can('anon', 'public.cl_transfer_json(uuid)')) &&
    !(await can('anon', 'public.cl_seat_admin(public.cl_terminals,text)')));
  ok('the device functions are open to the devices', await can('anon', 'public.cl_seat_join(text,text,text,integer,text,text)') &&
    await can('anon', 'public.cl_device_transfer_send(text,text,text,jsonb)') && await can('anon', 'public.cl_business_bill(text,text,text)'));
  r = await q(`select relname, relrowsecurity from pg_class where relname in ('cl_internal_transfers', 'cl_internal_transfer_lines')`);
  ok('RLS on the new tables, no grants to the devices', r.length === 2 && r.every((x) => x.relrowsecurity) &&
    !(await q(`select has_table_privilege('anon', 'public.cl_internal_transfers', 'select') x`))[0].x);
  const audit = await q(`select action, detail::text d from cl_activity_log where action like 'seat_%'`);
  const acts = new Set(audit.map((x) => x.action));
  ok('every step is in the audit log', ['seat_invite_created', 'seat_invite_revoked', 'seat_joined', 'seat_pin_set', 'seat_approved', 'seat_refused'].every((a) => acts.has(a)), [...acts].join(','));
  const all = JSON.stringify(audit);
  ok('... with no code, PIN or phrase in it', ![inv1.code, inv4.code, inv5.code, '5151', '7272', '1234', PHRASE.SE01, 'Mandie Phrase'].some((s) => all.includes(s)));

  r = await exec(pg, MIG);
  ok('a second run is refused and changes nothing', /already exists/.test(r.e || ''), r.e);
  r = await exec(pg, RB);
  ok('the rollback is refused while seats exist', /rollback refused/.test(r.e || ''), r.e);

  // the rollback on a database without seats
  const pg2 = await newPglite();
  await buildFromRepo(pg2, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261110120000_staff_first_owner.sql', '20261112120000_builtin_customers.sql', '20261113120000_sales_sync.sql', '20261113180000_removed_devices.sql', '20261114120000_roles_everywhere.sql', '20261115120000_stock_control.sql', '20261116120000_vendor_register_status.sql', '20261117120000_srq_drafts.sql']) });
  const q2 = async (sql, p) => (await pg2.query(sql, p)).rows;
  const b2 = fingerprint(await snapshot(q2));
  ok('(a second database: the migration applies)', (await exec(pg2, MIG)).ok);
  r = await exec(pg2, RB);
  ok('the rollback applies', r.ok, r.e);
  const d = diff(b2, fingerprint(await snapshot(q2)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  void before;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
