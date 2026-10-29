// node supabase/tests/roles-everywhere-test.js
//
// Tests supabase/migrations/20261114120000_roles_everywhere.sql (v36 Fix-A:
// A11 decision 48, A12 decision 49, A13 decision 50) and its rollback in an
// in-memory PGlite built from the repo (the live shape plus 20261113180000),
// never the live database:
//   A11 a till's calls carry the signed-in person's token; seiGEN refuses a
//       call made directly by someone without the right (not just a hidden
//       button); an ended token, or a till in sign-in mode without one, is
//       refused; single operator mode is as before and logged; selling is
//       never checked on a till; seats are unchanged; the mode goes back to
//       single only with the Settings right.
//   A12 the Guest role: built in, can't be changed or deleted; only the
//       Owner or an Admin gives it; main branch; never signs in on a till
//       (no PIN check value there); a Guest's seat reads stock and selling
//       prices only; refused after the end date; billed as a seat.
//   A13 an RPN that is set changes only with "Change vendor RPN" (and is
//       logged); a direct table update is refused; the first RPN as before;
//       the app's link never changes it.
//   Only the listed functions change; a second run is refused; the rollback
//   is refused while a Guest exists, then restores the catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261114120000_roles_everywhere.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261114120000_roles_everywhere.rollback.sql'));

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

const CHANGED = ['cl_install_vendor', 'cl_seat_need', 'cl_shop_session', 'cl_shop_staff_json', 'cl_device_staff_signin', 'cl_device_staff_pull',
  'cl_device_staff_save', 'cl_device_role_save', 'cl_device_seat_invite_create', 'cl_device_branch_stock', 'cl_device_customers_pull',
  'cl_device_suppliers_pull', 'cl_device_supplier_invoice_check', 'cl_device_dispatch_pull', 'cl_device_dispatch_lookup', 'cl_device_business_dispatches',
  'cl_device_dispatch_card', 'cl_device_item_ledger', 'cl_device_transfers_pull', 'cl_device_credit_balances', 'cl_device_itred_orders_pull',
  'cl_device_itred_messages_read', 'cl_catalogue_pull', 'cl_catalogue_images_pull', 'cl_device_stock_levels_push', 'cl_device_b4_push',
  'cl_device_dispatch_costs', 'cl_device_branch_report', 'cl_assign_rpn', 'cl_resolve_rpn_conflict', 'cl_device_rpn_status', 'cl_shop_default_rights', 'cl_shop_ensure_roles'];

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f) => f !== '20261113180000_removed_devices.sql').concat([FILE, '20261115120000_stock_control.sql', '20261116120000_vendor_register_status.sql', '20261117120000_srq_drafts.sql']) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const PHRASE = {};
  const anon = async (fn, args, claims) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  };
  const auth = (iid, tok) => ({ p_install_id: iid, p_secret_phrase: (PHRASE[iid] || 'Mandie Phrase') + (tok ? '|' + tok : ''), p_device_key: key(iid) });
  const call = async (iid, fn, args, tok) => { const r = await anon(fn, { ...auth(iid, tok), ...(args || {}) }); return r.e ? { raised: r.e } : r.j; };
  const seed = () => ({ salt: hex(16), check: hex(32), rounds: 150000 });
  const code = async (iid, o) => { const s = seed(); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 36 })).j;
  const raised = (x, re) => re.test((x && x.raised) || '');

  // ---- the live shape: Harare (main) T1, Murehwa T1; Boss (Admin), Rudo (Cashier), Tafara (Stores); seat S1 for Tendai (Manager) ----
  let r = await anon('cl_branch_register', { ...auth('HA01'), p_business_name: 'Mandie Babyware', p_branch_name: 'Harare' });
  const HARARE = r.j.branch_id, BIZ = r.j.business_id;
  const MUREHWA = (await join('MU01', (await code('HA01', { p_new_branch_name: 'Murehwa' })).code)).branch_id;
  const roles = Object.fromEntries((await call('HA01', 'cl_device_staff_pull')).roles.map((x) => [x.builtin || x.name, x.id]));
  const ID = {};
  r = await call('HA01', 'cl_device_staff_save', { p_staff_token: null, p_staff: { name: 'Boss', role_id: roles.admin, home_branch_id: HARARE, pin: '1234', ...staffCheck() } });
  ID.Boss = r.staff.id;
  const signin = async (iid, name, pin) => call(iid, 'cl_device_staff_signin', { p_staff_id: ID[name], p_pin: pin });
  let bossT1 = (await signin('HA01', 'Boss', '1234')).token;
  for (const [n, role, pin] of [['Rudo', 'cashier', '3333'], ['Tafara', 'stores', '4444']]) {
    r = await call('HA01', 'cl_device_staff_save', { p_staff_token: bossT1, p_staff: { name: n, role_id: roles[role], home_branch_id: HARARE, pin, ...staffCheck() } });
    ID[n] = r.staff.id;
  }
  r = await call('HA01', 'cl_device_role_save', { p_staff_token: bossT1, p_role: { name: 'Staff officer', rights: ['m.staff', 'm.productlist'] } });
  roles.officer = r.role.id;
  r = await call('HA01', 'cl_device_staff_save', { p_staff_token: bossT1, p_staff: { name: 'Nyasha', role_id: roles.officer, home_branch_id: HARARE, pin: '6666', ...staffCheck() } });
  ID.Nyasha = r.staff.id;
  const invite = (iid, tok, o) => call(iid, 'cl_device_seat_invite_create', { p_staff_token: tok, ...o });
  const seatJoin = (iid, c) => anon('cl_seat_join', { p_install_id: iid, p_device_key: key(iid), p_code: c, p_app_build: 36, p_join_hint: 'Windows · Edge' }).then((x) => x.j || { raised: x.e });
  const inv1 = await invite('HA01', bossT1, { p_name: 'Tendai', p_role_id: roles.manager });
  r = await seatJoin('SE01', inv1.code); PHRASE.SE01 = r.device_phrase; const S1 = r.terminal_id;
  await call('SE01', 'cl_seat_set_pin', { p_pin: '5151', ...check() });
  await call('HA01', 'cl_device_seat_approve', { p_staff_token: bossT1, p_terminal_id: S1, p_check: seatCheckOf(key('SE01')) });
  ID.Tendai = (await q(`select id from cl_shop_staff where name = 'Tendai'`))[0].id;
  // a product in the catalogue (retail 12, wholesale 10, cost 7); Murehwa sets its own prices (14)
  const P1 = hex();
  await call('HA01', 'cl_catalogue_push', { p_rows: [{ uid: P1, op_id: hex(), code: 'BW-1', name: 'Bottle warmer', price: 12, cost: 7, wholesale_price: 10 }] });
  await q(`update cl_branches set price_mode = 'branch_edits' where id = $1`, [MUREHWA]);
  await q(`insert into cl_branch_prices (business_id, branch_id, product_uid, price, change_seq, last_op_id) values ($1, $2, $3, 14, 1, 'x')`, [BIZ, MUREHWA, P1]);
  const before = fingerprint(await snapshot(q));
  ok('(setup: Harare T1, Murehwa T1, seat S1; Boss, Rudo, Tafara, Nyasha, Tendai)', !!(HARARE && MUREHWA && S1 && ID.Tendai && ID.Nyasha));

  // ---- the migration ----
  r = await exec(pg, MIG);
  ok('it applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  const changedNames = [...new Set(d.changed.map((c) => (/(cl_\w+)\(/.exec(c.key) || [])[1]).filter(Boolean))];
  ok('changed functions: exactly the listed ones', changedNames.length && changedNames.every((n) => CHANGED.includes(n)) &&
    CHANGED.every((n) => changedNames.includes(n)), JSON.stringify(changedNames.filter((n) => !CHANGED.includes(n)).concat(['missing:'], CHANGED.filter((n) => !changedNames.includes(n)))));
  ok('nothing removed', d.onlyA.length === 0, JSON.stringify(d.onlyA));
  ok('every till starts in single operator mode on seiGEN', (await q(`select count(*)::int n from cl_terminals where staff_mode <> 'single'`))[0].n === 0);

  // ---- A11: tills ----
  const supplier = () => ({ p_supplier: { id: crypto.randomUUID(), name: 'Supplier ' + hex(3) } });
  const saved = (x) => !!(x && (x.ok === true || x.supplier));
  r = await call('HA01', 'cl_device_supplier_save', supplier());
  ok('single operator till, nobody signed in: a supplier is saved as before', saved(r), JSON.stringify(r));
  ok('... logged "single operator"', (await q(`select count(*)::int n from cl_till_rights_log where how = 'single operator' and right_key = 'm.purchasing'`))[0].n === 1);
  const rudoT1 = (await signin('HA01', 'Rudo', '3333')).token;
  r = await call('HA01', 'cl_device_supplier_save', supplier(), rudoT1);
  ok('Rudo (Cashier) signed in, calling seiGEN directly: refused (STAFF_NO_RIGHT), not just a hidden button', raised(r, /STAFF_NO_RIGHT: Rudo doesn't have the right for this \(m\.purchasing\)/), JSON.stringify(r));
  r = await call('HA01', 'cl_device_supplier_save', supplier(), bossT1);
  ok('Boss (Admin) signed in: saved, logged "signed in"', saved(r) && (await q(`select count(*)::int n from cl_till_rights_log where how = 'signed in' and staff_id = $1`, [ID.Boss]))[0].n >= 1, JSON.stringify(r));
  const tafT1 = (await signin('HA01', 'Tafara', '4444')).token;
  ok('Tafara (Stores) saves a supplier (Purchasing)', saved(await call('HA01', 'cl_device_supplier_save', supplier(), tafT1)));
  r = await call('HA01', 'cl_device_customer_save', { p_customer: { uid: hex(), name: 'Chipo M', phone: '0771234567' } }, rudoT1);
  ok('a Cashier without "Create customers": the customer save is refused by seiGEN', raised(r, /STAFF_NO_RIGHT.*create_customers/), JSON.stringify(r));
  r = await call('HA01', 'cl_device_dispatch_send', { p_dispatch: { id: crypto.randomUUID(), to_branch_id: MUREHWA, dn_no: 1, dn_display: 'DN-1', lines: [] } }, rudoT1);
  ok('... dispatch refused (m.dispatch)', raised(r, /STAFF_NO_RIGHT.*m\.dispatch/), JSON.stringify(r));
  r = await call('HA01', 'cl_device_grv_post', { p_dispatch_id: crypto.randomUUID(), p_grv: {} }, rudoT1);
  ok('... GRV refused (m.receive)', raised(r, /STAFF_NO_RIGHT.*m\.receive/), JSON.stringify(r));
  r = await call('HA01', 'cl_branch_price_push', { p_rows: [{ branch_id: HARARE, product_uid: P1, price: 1, op_id: hex() }] }, rudoT1);
  ok('... a branch price change refused (edit_prices)', raised(r, /STAFF_NO_RIGHT.*edit_prices/), JSON.stringify(r));
  r = await call('HA01', 'cl_catalogue_push', { p_rows: [{ uid: hex(), op_id: hex(), code: 'X', name: 'X', price: 1, cost: 1 }] }, rudoT1);
  ok('... a product change refused (m.products)', raised(r, /STAFF_NO_RIGHT.*m\.products/), JSON.stringify(r));
  const s0 = seed();
  r = await anon('cl_branch_issue_join_code', { ...auth('HA01', rudoT1), p_branch_id: HARARE, p_admin_salt: s0.salt, p_admin_check: s0.check, p_admin_rounds: s0.rounds });
  ok('... a till join code refused (m.terminals)', /STAFF_NO_RIGHT.*m\.terminals/.test(r.e || ''), JSON.stringify(r));
  r = await call('HA01', 'cl_device_branch_report', { p_staff_token: rudoT1, p_kind: 'inventory', p_branch_id: MUREHWA });
  ok('... another branch\'s report refused (as before, by its own check)', r && (r.error === 'NO_RIGHT' || raised(r, /NO_RIGHT/)), JSON.stringify(r));
  r = await call('HA01', 'cl_stock_sale', { p_sale_uid: hex(), p_lines: [] }, rudoT1);
  ok('selling is never checked on a till (cl_stock_sale answers as before)', !/STAFF_/.test(JSON.stringify(r)), JSON.stringify(r));
  r = await call('HA01', 'cl_device_itred_order_complete', { p_uid: crypto.randomUUID(), p_order_id: crypto.randomUUID() }, rudoT1);
  ok('... nor iTred order handling (m.sell)', !/STAFF_/.test(JSON.stringify(r)), JSON.stringify(r));
  await q(`update cl_shop_staff_sessions set revoked_at = now() where staff_id = $1`, [ID.Rudo]);
  r = await call('HA01', 'cl_device_supplier_save', supplier(), rudoT1);
  ok('a token that has ended: STAFF_SIGN_IN (sign in again)', raised(r, /STAFF_SIGN_IN: Your seiGEN sign-in on this till has ended/), JSON.stringify(r));
  ok('a bad token tail is not read as a token (the phrase doesn\'t match)', raised(await call('HA01', 'cl_device_supplier_save', supplier(), 'nothex'), /secret phrase does not match/i));

  // the till turns staff sign-in on (stricter: no token needed); back to single only with Settings
  ok('staff pull tells the till its mode on seiGEN', (await call('HA01', 'cl_device_staff_pull')).staff_mode === 'single');
  r = await call('HA01', 'cl_device_staff_mode', { p_mode: 'roles' });
  ok('T1 reports staff sign-in mode (no token needed)', r.ok && r.staff_mode === 'roles', JSON.stringify(r));
  r = await call('HA01', 'cl_device_supplier_save', supplier());
  ok('... then a call with nobody signed in is refused: STAFF_SIGN_IN', raised(r, /STAFF_SIGN_IN: This till uses staff sign-in/), JSON.stringify(r));
  ok('... Boss still saves', saved(await call('HA01', 'cl_device_supplier_save', supplier(), bossT1)));
  const rudo2 = (await signin('HA01', 'Rudo', '3333')).token;
  ok('back to single operator mode: refused without anyone signed in', (await call('HA01', 'cl_device_staff_mode', { p_mode: 'single' })).error === 'NO_RIGHT');
  ok('... refused for Rudo (no Settings)', (await call('HA01', 'cl_device_staff_mode', { p_mode: 'single', p_staff_token: rudo2 })).error === 'NO_RIGHT');
  r = await call('HA01', 'cl_device_staff_mode', { p_mode: 'single', p_staff_token: bossT1 });
  ok('... Boss (Settings) turns it back: logged', r.ok && r.staff_mode === 'single' &&
    (await q(`select count(*)::int n from cl_till_rights_log where how in ('mode roles', 'mode single')`))[0].n === 2, JSON.stringify(r));
  ok('a seat can\'t be single operator', (await call('SE01', 'cl_device_staff_mode', { p_mode: 'single' })).error === 'SEAT_NO_SINGLE');

  // seats unchanged
  const tenS1 = (await signin('SE01', 'Tendai', '5151')).token;
  ok('seat: Tendai (Manager) saves a supplier as before', saved(await call('SE01', 'cl_device_supplier_save', supplier(), tenS1)));
  ok('seat: nobody signed in: SEAT_SIGN_IN as before', raised(await call('SE01', 'cl_device_supplier_save', supplier()), /SEAT_SIGN_IN/));
  ok('seat: selling refused as before', raised(await call('SE01', 'cl_stock_sale', { p_sale_uid: hex(), p_lines: [] }, tenS1), /SEAT_NO_SELLING/));
  // a business phrase with "|" in it keeps working
  r = await anon('cl_branch_register', { p_install_id: 'PI01', p_secret_phrase: 'Pipe|Phrase', p_device_key: key('PI01'), p_business_name: 'Pipe Shop', p_branch_name: 'Gweru' });
  ok('a till whose phrase has a "|" registers and saves as before', r.j && !r.j.error &&
    saved((await anon('cl_device_supplier_save', { p_install_id: 'PI01', p_secret_phrase: 'Pipe|Phrase', p_device_key: key('PI01'), ...supplier() })).j), JSON.stringify(r));

  // ---- A12: Guest ----
  const pulled = await call('HA01', 'cl_device_staff_pull');
  const guestRole = pulled.roles.find((x) => x.builtin === 'guest');
  ok('every business has the built-in Guest: Product List + branch prices only', guestRole && guestRole.name === 'Guest' &&
    JSON.stringify(guestRole.rights.slice().sort()) === JSON.stringify(['branch_prices', 'm.productlist']), JSON.stringify(guestRole));
  ok('... in the role order after Cashier', pulled.roles.map((x) => x.builtin).filter(Boolean).join(',') === 'owner,admin,manager,stores,cashier,guest');
  ok('the Guest role can\'t be changed', (await call('HA01', 'cl_device_role_save', { p_staff_token: bossT1, p_role: { id: guestRole.id, name: 'Guest', rights: ['m.productlist', 'costs'] } })).error === 'GUEST_FIXED');
  ok('... nor deleted', (await call('HA01', 'cl_device_role_save', { p_staff_token: bossT1, p_role: { id: guestRole.id, delete: true } })).error === 'GUEST_FIXED');
  ok('"branch_prices" can\'t be given to another role', !(await call('HA01', 'cl_device_role_save', { p_staff_token: bossT1, p_role: { id: roles.officer, rights: ['m.staff', 'branch_prices'] } })).role.rights.includes('branch_prices'));
  const nyaT1 = (await signin('HA01', 'Nyasha', '6666')).token;
  const until = new Date(Date.now() + 2 * 86400e3).toISOString();
  ok('only the Owner or an Admin adds a Guest (Nyasha has Staff, not Admin)', (await call('HA01', 'cl_device_staff_save', { p_staff_token: nyaT1,
    p_staff: { name: 'Grace', role_id: guestRole.id, home_branch_id: HARARE, pin: '7777', ...staffCheck() } })).error === 'GUEST_OWNER_ADMIN');
  ok('a Guest\'s home branch is main', (await call('HA01', 'cl_device_staff_save', { p_staff_token: bossT1,
    p_staff: { name: 'Grace', role_id: guestRole.id, home_branch_id: MUREHWA, pin: '7777', ...staffCheck() } })).error === 'GUEST_MAIN');
  r = await call('HA01', 'cl_device_staff_save', { p_staff_token: bossT1,
    p_staff: { name: 'Grace', role_id: guestRole.id, home_branch_id: HARARE, other_branches: [MUREHWA], pin: '7777', guest_until: until, ...staffCheck() } });
  ok('Boss adds Grace (Guest) with an end date; no other branches', r.ok && Date.parse(r.staff.guest_until) === Date.parse(until) && r.staff.other_branches.length === 0, JSON.stringify(r));
  ID.Grace = r.staff.id;
  r = await signin('HA01', 'Grace', '7777');
  ok('a Guest can\'t sign in on a till (seiGEN refuses)', r.error === 'GUEST_SEAT_ONLY', JSON.stringify(r));
  const g1 = (await call('HA01', 'cl_device_staff_pull')).staff.find((s) => s.name === 'Grace');
  ok('... and a till never gets her PIN check value', g1 && g1.here === false && !g1.pin_check && !g1.pin_salt, JSON.stringify(g1));
  ok('a new person can\'t be invited as a Guest (add them in Staff first)', (await invite('HA01', bossT1, { p_name: 'Visitor', p_role_id: guestRole.id })).error === 'GUEST_ADD_FIRST');
  const inv2 = await invite('HA01', bossT1, { p_staff_id: ID.Grace });
  ok('Grace (existing) is invited to an Office seat', inv2.ok, JSON.stringify(inv2));
  r = await seatJoin('SE02', inv2.code); PHRASE.SE02 = r.device_phrase; const S2 = r.terminal_id;
  await call('SE02', 'cl_seat_set_pin', { p_pin: '7777' });
  r = await call('HA01', 'cl_device_seat_approve', { p_staff_token: bossT1, p_terminal_id: S2, p_check: seatCheckOf(key('SE02')) });
  ok('... joins with her PIN and is approved: seat S2', r.ok && r.till_code === 'S2', JSON.stringify(r));
  const gp = await call('SE02', 'cl_device_staff_pull');
  ok('her seat is a Guest seat: its staff list holds only Grace', gp.guest_seat === true && gp.staff.length === 1 && gp.staff[0].name === 'Grace' && gp.staff[0].here === true, JSON.stringify(gp.staff));
  for (const [fn, args] of [['cl_device_customers_pull', {}], ['cl_device_suppliers_pull', {}], ['cl_catalogue_pull', { p_cursor: 0 }], ['cl_device_dispatch_pull', {}],
    ['cl_device_transfers_pull', {}], ['cl_device_credit_balances', {}], ['cl_device_b4_push', { p_events: [] }],
    ['cl_device_dispatch_costs', { p_staff_token: null, p_dispatch_id: crypto.randomUUID() }], ['cl_device_branch_report', { p_staff_token: null, p_kind: 'inventory', p_branch_id: MUREHWA }],
    ['cl_device_stock_levels_push', { p_as_of: new Date().toISOString(), p_full: true, p_rows: [] }], ['cl_device_business_dispatches', {}]]) {
    r = await call('SE02', fn, args);
    ok('a Guest seat can\'t read or send: ' + fn, raised(r, /GUEST_SEAT/), JSON.stringify(r));
  }
  ok('Tendai\'s (Manager) seat still pulls the customers', !raised(await call('SE01', 'cl_device_customers_pull', {}), /GUEST_SEAT/));
  r = await signin('SE02', 'Grace', '7777');
  ok('Grace signs in on her seat', r.ok && r.token, JSON.stringify(r));
  const graceS2 = r.token;
  r = await call('SE02', 'cl_device_branch_stock', {}, graceS2);
  ok('Grace sees every branch\'s selling prices: Harare 12 (wholesale 10), Murehwa 14 (its own)', r.prices && r.prices[HARARE][P1].price == 12 &&
    r.prices[HARARE][P1].wholesale == 10 && r.prices[MUREHWA][P1].price == 14 && r.branches.length === 2, JSON.stringify(r.prices));
  ok('... and never a cost', !/"cost"/.test(JSON.stringify(r)));
  ok('without her token: no prices', !('prices' in (await call('SE02', 'cl_device_branch_stock', {}))));
  ok('Tendai (Manager) gets the stock as before, no prices block', !('prices' in (await call('SE01', 'cl_device_branch_stock', {}, tenS1))));
  ok('Grace can\'t change anything (a supplier: SEAT_NO_RIGHT)', raised(await call('SE02', 'cl_device_supplier_save', supplier(), graceS2), /SEAT_NO_RIGHT/));
  ok('... nor see costs, signed in or not', raised(await call('SE02', 'cl_device_dispatch_costs', { p_staff_token: graceS2, p_dispatch_id: crypto.randomUUID() }, graceS2), /GUEST_SEAT/));
  r = await call('HA01', 'cl_business_bill');
  ok('her seat is billed as an Office seat', r && JSON.stringify(r).includes('S2') && (r.devices || []).some((x) => x.till_code === 'S2' && x.role === 'seat'), JSON.stringify(r).slice(0, 400));
  await q(`update cl_shop_staff set guest_until = now() - interval '1 minute' where id = $1`, [ID.Grace]);
  ok('after the end date her session ends at once (no prices)', !('prices' in (await call('SE02', 'cl_device_branch_stock', {}, graceS2))));
  r = await signin('SE02', 'Grace', '7777');
  ok('... and sign-in is refused: GUEST_ENDED', r.error === 'GUEST_ENDED', JSON.stringify(r));

  // ---- A13: the RPN ----
  ok('the Console permission "Change vendor RPN" exists', (await q(`select label from cl_modules where key = 'change_vendor_rpn'`))[0].label === 'Change vendor RPN');
  const staff = {};
  for (const k of ['VEN', 'CHG']) staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', false, true, now()) returning id`, ['Staff ' + k]))[0].id;
  const modId = async (k) => ((await q(`select id from cl_modules where key = $1`, [k]))[0] || {}).id ||
    (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [k]))[0].id;
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff.VEN, await modId('vendors')]);
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff.CHG, await modId('change_vendor_rpn')]);
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: false });
  const rpn = {};
  for (const n of ['Tino', 'Ruva']) rpn[n] = (await q(`insert into cl_rpn (full_name, phone, city, passcode_hash, verification_code) values ($1, '0770000000', 'Harare', 'x', $2) returning id`, [n, 'V-' + n]))[0].id;
  r = await anon('cl_assign_rpn', { p_business_id: BIZ, p_vendor_id: null, p_rpn_id: rpn.Tino, p_reason: 'onboarding' }, tok('VEN'));
  ok('the first RPN: set as before (Vendors)', r.j && r.j.rpn_id === rpn.Tino, JSON.stringify(r));
  r = await anon('cl_assign_rpn', { p_business_id: BIZ, p_vendor_id: null, p_rpn_id: rpn.Ruva, p_reason: 'moved area' }, tok('VEN'));
  ok('changing it with Vendors only: refused', /Not authorized/.test(r.e || ''), JSON.stringify(r));
  r = await anon('cl_assign_rpn', { p_business_id: BIZ, p_vendor_id: null, p_rpn_id: null, p_reason: 'left' }, tok('VEN'));
  ok('... removing it too', /Not authorized/.test(r.e || ''), JSON.stringify(r));
  r = await anon('cl_assign_rpn', { p_business_id: BIZ, p_vendor_id: null, p_rpn_id: rpn.Ruva, p_reason: 'moved area' }, tok('CHG'));
  ok('with "Change vendor RPN": changed', r.j && r.j.rpn_id === rpn.Ruva, JSON.stringify(r));
  const log = await q(`select previous_rpn_id, rpn_id, source, status from cl_rpn_assignments where business_id = $1 order by id`, [BIZ]);
  ok('... logged: old and new RPN, from the Console', log.length >= 2 && log[log.length - 1].previous_rpn_id === rpn.Tino && log[log.length - 1].rpn_id === rpn.Ruva, JSON.stringify(log));
  ok('... and in the activity log (who, when, old, new)', (await q(`select count(*)::int n from cl_activity_log where action = 'assign_rpn' and staff_id = $1 and detail->>'from_rpn_id' = $2`, [staff.CHG, rpn.Tino]))[0].n === 1);
  r = await exec(pg, `update cl_businesses set rpn_id = '${rpn.Tino}' where id = '${BIZ}'`);
  ok('a direct table update of a set RPN is refused (RPN_LOCKED)', /RPN_LOCKED/.test(r.e || ''), JSON.stringify(r));
  ok('... nothing changed', (await q(`select rpn_id from cl_businesses where id = $1`, [BIZ]))[0].rpn_id === rpn.Ruva);
  await q(`insert into cl_rpn_pins (rpn_id, pin_hash) values ($1, extensions.crypt('123456', extensions.gen_salt('bf', 4)))`, [rpn.Tino]);
  await q(`update cl_rpn set field_force_no = 'RPN-014' where id = $1`, [rpn.Tino]);
  r = await call('HA01', 'cl_device_link_rpn', { p_field_force_no: 'RPN-014', p_pin: '123456' }, bossT1);
  ok('the shop app entering another RPN: not changed (a conflict for Digital Commerce)', r.ok === false && r.code === 'RPN_CONFLICT' &&
    (await q(`select rpn_id from cl_businesses where id = $1`, [BIZ]))[0].rpn_id === rpn.Ruva, JSON.stringify(r));
  const conflict = (await q(`select id from cl_rpn_assignments where status = 'conflict' and business_id = $1`, [BIZ]))[0].id;
  r = await anon('cl_resolve_rpn_conflict', { p_assignment_id: conflict, p_accept: true, p_reason: 'shop asked' }, tok('VEN'));
  ok('accepting the conflict needs "Change vendor RPN"', /Not authorized/.test(r.e || ''), JSON.stringify(r));
  r = await anon('cl_resolve_rpn_conflict', { p_assignment_id: conflict, p_accept: true, p_reason: 'shop asked' }, tok('CHG'));
  ok('... with it: accepted, the RPN changed', r.j && r.j.accepted === true && (await q(`select rpn_id from cl_businesses where id = $1`, [BIZ]))[0].rpn_id === rpn.Tino, JSON.stringify(r));
  r = await call('HA01', 'cl_device_rpn_status');
  ok('the shop app reads the RPN\'s details to show them read-only: name, field force number, phone', r.linked === true && r.rpn_name === 'Tino' &&
    r.field_force_no === 'RPN-014' && r.phone === '0770000000', JSON.stringify(r));

  // ---- grants ----
  const can = async (role, fn) => (await q(`select has_function_privilege($1, $2, 'execute') x`, [role, fn]))[0].x;
  ok('devices can call cl_device_staff_mode', await can('anon', 'public.cl_device_staff_mode(text,text,text,text,text)'));
  ok('devices can\'t call the helpers', !(await can('anon', 'public.cl_till_rights_note(public.cl_terminals,uuid,text,text)')) && !(await can('anon', 'public.cl_caller_rights()')) &&
    !(await can('anon', 'public.cl_shop_guest_ok(public.cl_shop_staff,uuid)')) && !(await can('anon', 'public.cl_seat_is_guest(uuid)')) && !(await can('anon', 'public.cl_rpn_change_guard()')));
  ok('devices can\'t read the rights log', /permission denied/.test((await (async () => { await pg.exec('set role anon'); try { await q('select * from cl_till_rights_log'); return {}; } catch (e) { return { e: e.message }; } finally { await pg.exec('reset role'); } })()).e || ''));
  ok('the rights log has RLS on', (await q(`select relrowsecurity x from pg_class where relname = 'cl_till_rights_log'`))[0].x === true);

  // ---- second run, rollback ----
  r = await exec(pg, MIG);
  ok('a second run is refused and changes nothing', /roles_everywhere aborted: already there/.test(r.e || ''), r.e);
  r = await exec(pg, RB);
  ok('the rollback is refused while someone has the Guest role', /Rollback aborted: some staff have the Guest role/.test(r.e || ''), r.e);
  await q(`update cl_shop_staff set role_id = $1 where id = $2`, [roles.cashier, ID.Grace]);
  // data the new columns and tables held go with the rollback; put the test's own RPN rows back as they were before
  r = await exec(pg, RB);
  ok('the rollback applies', r.ok, r.e);
  const d2 = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', d2.changed.length === 0 && d2.onlyA.length === 0 && d2.onlyB.length === 0, JSON.stringify(d2).slice(0, 900));
  ok('after the rollback: no Guest roles, no permission', (await q(`select count(*)::int n from cl_shop_roles where builtin = 'guest'`))[0].n === 0 &&
    (await q(`select count(*)::int n from cl_modules where key = 'change_vendor_rpn'`))[0].n === 0);
  ok('after the rollback: a till\'s call is answered as before', saved(await call('HA01', 'cl_device_supplier_save', supplier())));
  ok('... and a till must not send its token to a seiGEN without this (the phrase would not match: the app waits for staff_mode)',
    raised(await call('HA01', 'cl_device_supplier_save', supplier(), rudo2), /secret phrase does not match/i));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
