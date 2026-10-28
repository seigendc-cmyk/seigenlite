// node supabase/tests/stock-control-test.js
//
// Tests supabase/migrations/20261115120000_stock_control.sql (v37: decisions
// 48, 52-55) and its rollback in an in-memory PGlite built from the repo (the
// live shape), never the live database:
//   rights: the four new keys, on the built-in roles as the prompt's table
//     says (existing businesses too, pulled again by tills), never on custom
//     roles; seiGEN refuses each call made by someone without the right.
//   counts: a 0 difference closes at once, any other waits; blind (the system
//     figure and difference go only to approve_counts); approve / recount /
//     reject once; only the counting till marks it applied; a recount by the
//     same person is refused.
//   requests: branch -> main, part-approved, linked to main's DN, received
//     with the GRV; a cancelled DN puts it back to approved; main can't
//     request; a reject needs a reason.
//   recalls: only main; the branch sends back with short lines (partly sent),
//     received with main's GRV; overdue in the pull; cancel (decision 56): the maker or an
//     Owner/Admin, with a reason, before any DN; anyone else refused.
//   shelves per branch; idempotent by uid; the pull cursor; a Guest seat gets
//   the market feed only; the Console's market feed needs its module.
//   Only the two listed functions change; a second run is refused; the
//   rollback is refused while data exists, then restores the catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261115120000_stock_control.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261115120000_stock_control.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = (n) => crypto.randomBytes(n || 16).toString('hex');
const uuid = () => crypto.randomUUID();
const staffCheck = () => ({ pin_salt: hex(16), pin_check: hex(32), pin_rounds: 150000 });
const exec = async (pg, sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };
const J = (x) => JSON.stringify(x);
const NEW = ['request_stock', 'recall_stock', 'count_stock', 'approve_counts'];

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE]) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const anon = async (fn, args, claims) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? J(args[n]) : args[n]);
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? J(claims) : '']);
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  };
  const auth = (iid, tok) => ({ p_install_id: iid, p_secret_phrase: 'Mandie Phrase' + (tok ? '|' + tok : ''), p_device_key: key(iid) });
  const call = async (iid, fn, args, tok) => { const r = await anon(fn, { ...auth(iid, tok), ...(args || {}) }); return r.e ? { raised: r.e } : r.j; };
  const seed = () => ({ salt: hex(16), check: hex(32), rounds: 150000 });
  const code = async (iid, o) => { const s = seed(); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 37 })).j;

  // ---- the live shape: Harare (main) T1 + T2, Murehwa T1; Boss (Admin), Rudo (Cashier), Tafara (Stores), Chipo (custom "Shelf clerk") ----
  let r = await anon('cl_branch_register', { ...auth('HA01'), p_business_name: 'Mandie Babyware', p_branch_name: 'Harare' });
  const HARARE = r.j.branch_id, BIZ = r.j.business_id;
  const MUREHWA = (await join('MU01', (await code('HA01', { p_new_branch_name: 'Murehwa' })).code)).branch_id;
  await join('HA02', (await code('HA01', { p_branch_id: HARARE })).code);
  let roles = Object.fromEntries((await call('HA01', 'cl_device_staff_pull')).roles.map((x) => [x.builtin || x.name, x]));
  const ID = {};
  r = await call('HA01', 'cl_device_staff_save', { p_staff_token: null, p_staff: { name: 'Boss', role_id: roles.admin.id, home_branch_id: HARARE, pin: '1234', ...staffCheck() } });
  ID.Boss = r.staff.id;
  const signin = async (iid, name, pin) => (await call(iid, 'cl_device_staff_signin', { p_staff_id: ID[name], p_pin: pin })).token;
  const bossT = await signin('HA01', 'Boss', '1234');
  r = await call('HA01', 'cl_device_role_save', { p_staff_token: bossT, p_role: { name: 'Shelf clerk', rights: ['m.stocktake', 'm.productlist'] } });
  const CUSTOM = r.role.id;
  for (const [n, role, pin, home] of [['Rudo', roles.cashier.id, '3333', HARARE], ['Tafara', roles.stores.id, '4444', MUREHWA], ['Chipo', CUSTOM, '5555', HARARE]]) {
    r = await call('HA01', 'cl_device_staff_save', { p_staff_token: bossT, p_staff: { name: n, role_id: role, home_branch_id: home, pin, ...staffCheck() } });
    ID[n] = r.staff.id;
  }
  const seqBefore = Object.fromEntries((await q(`select builtin, change_seq from cl_shop_roles where business_id = $1 and builtin is not null`, [BIZ])).map((x) => [x.builtin, Number(x.change_seq)]));
  const before = fingerprint(await snapshot(q));
  ok('(setup: Harare T1+T2, Murehwa T1; Boss, Rudo, Tafara, Chipo)', !!(HARARE && MUREHWA && ID.Chipo && ID.Tafara));

  // ---- the migration ----
  r = await exec(pg, MIG);
  ok('it applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  const changedNames = [...new Set(d.changed.map((c) => (/(cl_\w+)\(/.exec(c.key) || [])[1]).filter(Boolean))];
  ok('changed functions: exactly cl_shop_rights_all and cl_shop_default_rights', J(changedNames.sort()) === J(['cl_shop_default_rights', 'cl_shop_rights_all']), J(changedNames));
  ok('nothing removed', d.onlyA.length === 0, J(d.onlyA));
  ok('the dispatch and GRV functions are unchanged', !changedNames.some((n) => /dispatch|grv/.test(n)));
  ok('a second run is refused, changing nothing', /already there/.test((await exec(pg, MIG)).e || ''));

  // ---- rights ----
  const has = async (builtin) => (await q(`select rights from cl_shop_roles where business_id = $1 and builtin = $2`, [BIZ, builtin]))[0].rights;
  const holds = (rights, keys) => keys.every((k) => rights.includes(k));
  ok('Owner and Admin: all four', holds(await has('owner'), NEW) && holds(await has('admin'), NEW));
  ok('Manager: all four', holds(await has('manager'), NEW));
  const st = await has('stores'), ca = await has('cashier'), gu = await has('guest');
  ok('Stores: Request stock and Count stock only', holds(st, ['request_stock', 'count_stock']) && !st.includes('recall_stock') && !st.includes('approve_counts'), J(st));
  ok('Cashier: Request stock only', ca.includes('request_stock') && !ca.some((x) => ['recall_stock', 'count_stock', 'approve_counts'].includes(x)), J(ca));
  ok('Guest: none of them', !gu.some((x) => NEW.includes(x)));
  ok('a custom role gets none', !(await q(`select rights from cl_shop_roles where id = $1`, [CUSTOM]))[0].rights.some((x) => NEW.includes(x)));
  const seqAfter = Object.fromEntries((await q(`select builtin, change_seq from cl_shop_roles where business_id = $1 and builtin is not null`, [BIZ])).map((x) => [x.builtin, Number(x.change_seq)]));
  ok('changed built-in roles are pulled again (change_seq up); Guest untouched',
    ['owner', 'admin', 'manager', 'stores', 'cashier'].every((b) => seqAfter[b] > seqBefore[b]) && seqAfter.guest === seqBefore.guest, J([seqBefore, seqAfter]));
  r = await call('HA01', 'cl_device_role_save', { p_staff_token: bossT, p_role: { id: CUSTOM, name: 'Shelf clerk', rights: ['m.stocktake', 'count_stock'] } });
  ok('the roles editor can give a new right to a custom role', r.ok && r.role.rights.includes('count_stock'), J(r));
  ok('a new business gets them too', holds(((await q(`select cl_shop_default_rights('manager') r`))[0].r), NEW));

  const push = (iid, events, tok) => call(iid, 'cl_device_stock_ctl_push', { p_events: events }, tok);
  const one = async (iid, ev, tok) => { const x = await push(iid, [Object.assign({ uid: 'u-' + hex(6) }, ev)], tok); return x.results ? x.results[0] : x; };
  const pull = (iid, cur, tok) => call(iid, 'cl_device_stock_ctl_pull', { p_cursor: cur || 0 }, tok);

  // ---- cycle counts (decision 52) ----
  const C0 = uuid(), C1 = uuid();
  const count = (id, qty, sys, by, extra) => ({ type: 'count', id, product_key: 'cat-sugar', code: 'SUG2', name: 'Sugar 2kg', shelf: 'A3', reason: 'Class A, due',
    counted_qty: qty, system_qty: sys, counted_ts: '2026-10-28T08:00:00Z', counted_by: by, ...(extra || {}) });
  r = await one('MU01', count(C0, 7, 7, 'Tafara'));
  ok('a count with no difference is stored', r.status === 'stored', J(r));
  ok('... and closed at once', (await q(`select status from cl_cycle_counts where id = $1`, [C0]))[0].status === 'closed');
  r = await one('MU01', count(C1, 8, 10, 'Tafara'));
  ok('a count with a difference waits for approval', r.status === 'stored' && (await q(`select status, diff from cl_cycle_counts where id = $1`, [C1]))[0].diff === -2);
  r = await one('MU01', count(C1, 8, 10, 'Tafara'));
  ok('the same count again: duplicate, stored once', r.status === 'duplicate' && (await q(`select count(*)::int n from cl_cycle_counts`))[0].n === 2);
  r = await one('HA01', count(uuid(), 1, 1, 'X'), null);
  ok('a count at Harare is Harare\'s (the counting till\'s branch)', r.status === 'stored');
  let p = await pull('MU01');
  ok('the pull: this branch\'s counts only', p.counts.length === 2 && p.counts.every((c) => c.branch_id === MUREHWA), J(p.counts));
  ok('single operator till: sees the difference (approvals take the Admin passcode there)', p.sees_diff === true && p.counts.find((c) => c.id === C1).diff === -2);

  // Murehwa in staff sign-in mode; Tafara (Stores: count_stock, no approve_counts)
  await call('MU01', 'cl_device_staff_mode', { p_mode: 'roles' });
  const tafT = await signin('MU01', 'Tafara', '4444');
  p = await pull('MU01', 0, tafT);
  const c1 = p.counts.find((c) => c.id === C1);
  ok('blind: a counter without approve_counts gets no system figure or difference', p.sees_diff === false && c1 && c1.system_qty === undefined && c1.diff === undefined, J(c1));
  r = await one('MU01', { type: 'count_decide', id: C1, action: 'approve', by: 'Tafara' }, tafT);
  ok('seiGEN refuses an approval by someone without approve_counts', r.status === 'refused' && r.code === 'STAFF_NO_RIGHT', J(r));
  r = await one('MU01', { type: 'count_decide', id: C1, action: 'approve', by: 'Nobody' });
  ok('a till in sign-in mode, nobody signed in: refused (sign in)', r.status === 'refused' && r.code === 'STAFF_SIGN_IN', J(r));
  ok('no decision recorded', (await q(`select status from cl_cycle_counts where id = $1`, [C1]))[0].status === 'waiting');
  r = await one('HA01', { type: 'count_decide', id: C1, action: 'recount', by: 'Boss', note: 'look behind the boxes' }, bossT);
  ok('Boss (Admin, on main) sends it back for a recount', r.status === 'stored', J(r));
  r = await one('HA01', { type: 'count_decide', id: C1, action: 'approve', by: 'Boss' }, bossT);
  ok('decided once: a second, different decision is refused', r.status === 'refused' && r.code === 'ALREADY_DECIDED', J(r));
  r = await one('MU01', count(uuid(), 9, 10, 'Tafara', { recount_of: C1 }), tafT);
  ok('the recount by the same person is refused', r.status === 'refused' && r.code === 'SAME_COUNTER', J(r));
  // (test setup: Murehwa back to single operator mode; going back needs someone with Settings, tested in roles-everywhere-test)
  await q(`update cl_terminals set staff_mode = 'single' where branch_id = $1`, [MUREHWA]);
  const C2 = uuid();
  r = await one('MU01', count(C2, 9, 10, 'Shingi', { recount_of: C1 }), tafT);
  ok('the recount by someone else is stored', r.status === 'stored', J(r));
  r = await one('HA01', { type: 'count_decide', id: C2, action: 'approve', by: 'Boss' }, bossT);
  ok('approved', r.status === 'stored');
  r = await one('HA01', { type: 'count_applied', id: C2, adj_display: 'ADJ-T1-0001', unit_cost: 1.5 }, bossT);
  ok('only the counting till marks it applied', r.status === 'refused' && r.code === 'WRONG_DEVICE', J(r));
  r = await one('MU01', { type: 'count_applied', id: C2, adj_display: 'ADJ-T1-0001', unit_cost: 1.5, by: 'Tafara' }, tafT);
  ok('the counting till marks it applied, once', r.status === 'stored' && (await one('MU01', { type: 'count_applied', id: C2 }, tafT)).status === 'duplicate', J(r));
  r = await one('MU01', { type: 'count_decide', id: C0, action: 'approve', by: 'Boss' });
  ok('a closed count (no difference) can\'t be decided', r.code === 'ALREADY_DECIDED', J(r));

  // ---- shelves ----
  r = await push('MU01', [{ uid: 'sh-' + hex(6), type: 'shelf', product_key: 'cat-sugar', shelf: 'B2', ts: '2026-10-28T09:00:00Z' },
                          { uid: 'sh-' + hex(6), type: 'shelf', product_key: 'cat-sugar', shelf: 'OLD', ts: '2026-10-28T08:00:00Z' }]);
  ok('shelves: an older change never overwrites a newer one', r.results.every((x) => x.status === 'stored') &&
    (await q(`select shelf from cl_branch_shelves where branch_id = $1`, [MUREHWA]))[0].shelf === 'B2');
  await one('HA01', { type: 'shelf', product_key: 'cat-sugar', shelf: 'H9', ts: '2026-10-28T09:00:00Z' });
  p = await pull('MU01');
  ok('shelves are per branch: Murehwa pulls B2 only', p.shelves.length === 1 && p.shelves[0].shelf === 'B2', J(p.shelves));

  // ---- stock requests (decision 53) ----
  const R1 = uuid();
  const req = { type: 'request_create', id: R1, req_no: 'SRQ-T1-0001', reason: 'Weekend promotion', needed_by: '2026-10-31', by: 'Tafara',
    lines: [{ product_key: 'cat-sugar', code: 'SUG2', name: 'Sugar 2kg', qty: 10 }, { product_key: 'cat-oil', code: 'OIL2', name: 'Cooking oil 2L', qty: 4 }] };
  r = await one('MU01', req);
  ok('Murehwa requests stock from main', r.status === 'stored', J(r));
  ok('... once (idempotent by id)', (await one('MU01', req)).status === 'duplicate');
  const row = (await q(`select * from cl_stock_requests where id = $1`, [R1]))[0];
  ok('... to main, pending', row.to_branch_id === HARARE && row.from_branch_id === MUREHWA && row.status === 'pending');
  r = await one('HA01', Object.assign({}, req, { id: uuid(), req_no: 'SRQ-T1-0009' }));
  ok('main can\'t request from itself', r.code === 'IS_MAIN', J(r));
  const rudoT = await signin('HA01', 'Rudo', '3333');
  await call('HA01', 'cl_device_staff_mode', { p_mode: 'roles' });
  r = await one('HA01', { type: 'request_decide', id: R1, action: 'approve', by: 'Rudo' }, rudoT);
  ok('seiGEN refuses a review by a Cashier (no Review stock requests)', r.code === 'STAFF_NO_RIGHT', J(r));
  r = await one('HA01', { type: 'request_decide', id: R1, action: 'reject', by: 'Boss' }, bossT);
  ok('a reject needs a reason', r.code === 'BAD_EVENT', J(r));
  r = await one('HA01', { type: 'request_decide', id: R1, action: 'part', by: 'Boss', note: 'Oil is short', lines: [{ line_no: 1, approved_qty: 10 }, { line_no: 2, approved_qty: 2 }] }, bossT);
  ok('Boss part-approves (10 sugar, 2 oil)', r.status === 'stored' && (await q(`select status from cl_stock_requests where id = $1`, [R1]))[0].status === 'part_approved', J(r));
  p = await pull('MU01');
  const pr = p.requests.find((x) => x.id === R1);
  ok('the requesting branch sees the status, the reason and each approved quantity',
    pr.status === 'part_approved' && pr.decision_note === 'Oil is short' && pr.lines[1].approved_qty === 2 && pr.log.length === 2, J(pr));
  // main's DN for the approved quantities
  const send = (iid, dd, tok) => call(iid, 'cl_device_dispatch_send', { p_dispatch: J(dd) }, tok);
  const grv = (iid, id, g, tok) => call(iid, 'cl_device_grv_post', { p_dispatch_id: id, p_grv: J(g) }, tok);
  const D1 = uuid();
  r = await one('HA01', { type: 'request_link', id: R1, dispatch_id: D1, by: 'Boss' }, bossT);
  ok('a link before the DN is on seiGEN: NO_DISPATCH (tried again later)', r.code === 'NO_DISPATCH', J(r));
  r = await send('HA01', { id: D1, to_branch_id: MUREHWA, dn_no: 1, dn_display: 'DN-T1-0001', sent_by: 'Boss',
    lines: [{ cat_uid: 'cat-sugar', code: 'SUG2', name: 'Sugar 2kg', qty: 10 }, { cat_uid: 'cat-oil', code: 'OIL2', name: 'Cooking oil 2L', qty: 2 }] }, bossT);
  ok('(main sends the DN)', r && !r.error && !r.raised, J(r));
  r = await one('HA01', { type: 'request_link', id: R1, dispatch_id: D1, by: 'Boss' }, bossT);
  ok('the request is linked to the DN: dispatched', r.status === 'stored' && (await q(`select status from cl_stock_requests where id = $1`, [R1]))[0].status === 'dispatched', J(r));
  r = await call('HA01', 'cl_device_dispatch_cancel', { p_dispatch_id: D1, p_reason: 'wrong truck', p_by: 'Boss' }, bossT);
  const afterCancel = (await q(`select status, dispatch_id from cl_stock_requests where id = $1`, [R1]))[0];
  ok('a cancelled DN puts the request back to part-approved', afterCancel.status === 'part_approved' && afterCancel.dispatch_id === null, J([r, afterCancel]));
  const D2 = uuid();
  await send('HA01', { id: D2, to_branch_id: MUREHWA, dn_no: 2, dn_display: 'DN-T1-0002', sent_by: 'Boss',
    lines: [{ cat_uid: 'cat-sugar', code: 'SUG2', name: 'Sugar 2kg', qty: 10 }, { cat_uid: 'cat-oil', code: 'OIL2', name: 'Cooking oil 2L', qty: 2 }] }, bossT);
  await one('HA01', { type: 'request_link', id: R1, dispatch_id: D2, by: 'Boss' }, bossT);
  r = await grv('MU01', D2, { grv_id: uuid(), grv_no: 1, grv_display: 'GRV-T1-0001', by: 'Tafara', lines: [{ line_no: 1, received: 10 }, { line_no: 2, received: 2 }] });
  const rec = (await q(`select cl_stock_request_json($1) j`, [R1]))[0].j;
  ok('the GRV at Murehwa marks it received, with the DN and GRV numbers', !r.error && rec.status === 'received' && rec.dn_display === 'DN-T1-0002' && rec.grv_display === 'GRV-T1-0001', J([r, rec]));
  ok('... and the history has every step', J(rec.log.map((x) => x.action)) === J(['requested', 'part_approved', 'dispatched', 'dn_cancelled', 'dispatched', 'received']), J(rec.log.map((x) => x.action)));

  // ---- recalls (decision 54) ----
  const K1 = uuid();
  const rcl = { type: 'recall_create', id: K1, rcl_no: 'RCL-T1-0001', branch_id: MUREHWA, reason_kind: 'expiring', due_date: '2026-10-01', by: 'Boss',
    lines: [{ product_key: 'cat-sugar', code: 'SUG2', name: 'Sugar 2kg', qty: 6 }, { product_key: 'cat-oil', code: 'OIL2', name: 'Cooking oil 2L', qty: 0, all_on_hand: true }] };
  r = await one('HA01', rcl, rudoT);
  ok('seiGEN refuses a recall by a Cashier', r.code === 'STAFF_NO_RIGHT', J(r));
  r = await one('MU01', Object.assign({}, rcl, { id: uuid(), branch_id: HARARE }));
  ok('a recall is made at main only', r.code === 'NOT_MAIN', J(r));
  r = await one('HA01', rcl, bossT);
  ok('Boss recalls stock from Murehwa', r.status === 'stored', J(r));
  ok('a recall alone moves no stock (seiGEN never moves stock; no DN yet)', (await q(`select count(*)::int n from cl_dispatches where from_branch_id = $1`, [MUREHWA]))[0].n === 0);
  p = await pull('MU01');
  const pk = p.recalls.find((x) => x.id === K1);
  ok('Murehwa sees it, flagged overdue (past the due date, not sent)', pk && pk.overdue === true && pk.status === 'open', J(pk));
  const D3 = uuid();
  await send('MU01', { id: D3, to_branch_id: HARARE, dn_no: 1, dn_display: 'DN-T1-0001', sent_by: 'Tafara',
    delivery: { cost: 5, currency: 'usd', carrier: 'Kombi', ref: 'K-1' }, lines: [{ cat_uid: 'cat-sugar', code: 'SUG2', name: 'Sugar 2kg', qty: 4 }, { cat_uid: 'cat-oil', code: 'OIL2', name: 'Cooking oil 2L', qty: 3 }] });
  r = await one('MU01', { type: 'recall_link', id: K1, dispatch_id: D3, by: 'Tafara', lines: [{ line_no: 1, sent_qty: 4, short_qty: 2 }, { line_no: 2, sent_qty: 3, short_qty: 0 }] });
  ok('a short line needs a reason', r.code === 'BAD_EVENT', J(r));
  r = await one('MU01', { type: 'recall_link', id: K1, dispatch_id: D3, by: 'Tafara', lines: [{ line_no: 1, sent_qty: 4, short_qty: 2, short_reason: '2 sold before the recall' }, { line_no: 2, sent_qty: 3, short_qty: 0 }] });
  ok('Murehwa sends back with a short line: partly sent', r.status === 'stored' && (await q(`select status from cl_stock_recalls where id = $1`, [K1]))[0].status === 'partly_sent', J(r));
  r = await grv('HA01', D3, { grv_id: uuid(), grv_no: 1, grv_display: 'GRV-T1-0001', by: 'Boss', lines: [{ line_no: 1, received: 4 }, { line_no: 2, received: 3 }] }, bossT);
  p = await pull('MU01');
  ok('the bell\'s movements: Murehwa\'s DNs in and out, numbers and status only', p.dispatches.length === 3 &&
    p.dispatches.some((x) => x.id === D3 && x.status === 'received' && x.from_branch_id === MUREHWA) && p.dispatches.every((x) => x.lines === undefined), J(p.dispatches));
  ok('no iTred shop: no iTred list', p.itred === null);
  const rk = (await q(`select cl_stock_recall_json($1) j`, [K1]))[0].j;
  ok('main\'s GRV marks the recall received; the short line and reason are kept', !r.error && rk.status === 'received' && rk.lines[0].short_qty === 2 && rk.lines[0].short_reason, J([r, rk]));
  const charge = (await q(`select owed_by_branch_id from cl_interbranch_charges where dispatch_id = $1`, [D3]))[0];
  ok('transport on the recall DN is owed by main (the receiver), as every DN today', charge && charge.owed_by_branch_id === HARARE, J(charge));
  // cancelling a recall (decision 56): its maker, or an Owner or Admin; a reason; only before a DN for it is sent
  for (const [n, role, pin] of [['Nyasha', roles.manager.id, '6666'], ['Kuda', roles.manager.id, '7777'], ['Ama', roles.owner.id, '8888']]) {
    r = await call('HA01', 'cl_device_staff_save', { p_staff_token: bossT, p_staff: { name: n, role_id: role, home_branch_id: HARARE, pin, ...staffCheck() } });
    ID[n] = r.staff && r.staff.id;
  }
  ok('(setup: Nyasha and Kuda, Managers; Ama, the Owner)', !!(ID.Nyasha && ID.Kuda && ID.Ama), J(r));
  const nyaT = await signin('HA01', 'Nyasha', '6666'), kudaT = await signin('HA01', 'Kuda', '7777'), amaT = await signin('HA01', 'Ama', '8888');
  const recall = async (no, tok) => { const id = uuid(); await one('HA01', Object.assign({}, rcl, { id, rcl_no: no, due_date: '2099-01-01', by: 'Nyasha' }), tok); return id; };
  const cancel = (id, tok, by, note) => one('HA01', { type: 'recall_cancel', id, by, ...(note === undefined ? {} : { note }) }, tok);
  const status = async (id) => (await q(`select status from cl_stock_recalls where id = $1`, [id]))[0].status;
  const K2 = await recall('RCL-T1-0002', nyaT);
  ok('the recall keeps its maker (the signed-in person, from seiGEN\'s sign-in)', (await q(`select created_staff_id from cl_stock_recalls where id = $1`, [K2]))[0].created_staff_id === ID.Nyasha);
  r = await cancel(K2, kudaT, 'Kuda', 'not needed');
  ok('another Manager (Recall stock, not the maker) is refused by seiGEN', r.code === 'NOT_MAKER' && await status(K2) === 'open', J(r));
  r = await cancel(K2, rudoT, 'Rudo', 'not needed');
  ok('a Cashier is refused by seiGEN', r.code === 'STAFF_NO_RIGHT' && await status(K2) === 'open', J(r));
  r = await cancel(K2, nyaT, 'Nyasha');
  ok('no reason: refused', r.code === 'BAD_EVENT' && await status(K2) === 'open', J(r));
  r = await cancel(K2, nyaT, 'Nyasha', '   ');
  ok('a blank reason: refused', r.code === 'BAD_EVENT' && await status(K2) === 'open', J(r));
  r = await cancel(K2, nyaT, 'Nyasha', 'sold out at main');
  ok('the maker cancels, with a reason', r.status === 'stored' && await status(K2) === 'cancelled', J(r));
  const lg = (await q(`select by_name, action, detail, at from cl_stock_ctl_log where doc_id = $1 and action = 'cancelled'`, [K2]))[0];
  ok('... logged: who, when and the reason', lg && lg.by_name === 'Nyasha' && lg.at && lg.detail.note === 'sold out at main' && lg.detail.staff_id === ID.Nyasha, J(lg));
  r = await cancel(K2, nyaT, 'Nyasha', 'sold out at main');
  ok('... the same cancel again: duplicate', r.status === 'duplicate');
  const K3 = await recall('RCL-T1-0003', nyaT), K4 = await recall('RCL-T1-0004', nyaT);
  r = await cancel(K3, bossT, 'Boss', 'wrong branch');
  ok('an Admin cancels someone else\'s recall', r.status === 'stored' && await status(K3) === 'cancelled', J(r));
  r = await cancel(K4, amaT, 'Ama', 'stock is fine');
  ok('the Owner cancels someone else\'s recall', r.status === 'stored' && await status(K4) === 'cancelled', J(r));
  r = await cancel(K1, bossT, 'Boss', 'too late');
  ok('after its DN is sent (linked): refused', r.code === 'DN_SENT' && await status(K1) === 'received', J(r));
  const K5 = await recall('RCL-T1-0005', nyaT);
  await send('MU01', { id: uuid(), to_branch_id: HARARE, dn_no: 2, dn_display: 'DN-T1-0002', internal_ref: 'RCL-T1-0005', sent_by: 'Tafara',
    lines: [{ cat_uid: 'cat-sugar', code: 'SUG2', name: 'Sugar 2kg', qty: 1 }] });
  r = await cancel(K5, nyaT, 'Nyasha', 'changed my mind');
  ok('after its DN is sent but before the link reaches seiGEN: refused', r.code === 'DN_SENT' && await status(K5) === 'open', J(r));

  // ---- the pull cursor ----
  const p1 = await pull('MU01');
  await pg.exec(`update cl_stock_requests set updated_at = now() - interval '1 hour'; update cl_stock_recalls set updated_at = now() - interval '1 hour';
           update cl_cycle_counts set updated_at = now() - interval '1 hour'; update cl_branch_shelves set updated_at = now() - interval '1 hour'`);
  const p2 = await pull('MU01', p1.cursor);
  ok('the pull after the cursor: nothing again once older than two minutes', p2.requests.length === 0 && p2.recalls.length === 0 && p2.counts.length === 0 && p2.shelves.length === 0, J(p2));
  await one('HA01', { type: 'request_decide', id: uuid(), action: 'approve', by: 'Boss' }, bossT);
  const R2 = uuid();
  await one('MU01', Object.assign({}, req, { id: R2, req_no: 'SRQ-T1-0002' }));
  const p3 = await pull('MU01', p1.cursor);
  ok('... and a new request after it', p3.requests.length === 1 && p3.requests[0].id === R2 && p3.cursor > p1.cursor, J(p3.requests));

  // ---- Guest seat and the market feed ----
  r = await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), 'Console MF', 'x', false, true, now()) returning id`);
  const MF = r[0].id;
  const r0 = await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), 'Console none', 'x', false, true, now()) returning id`);
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) select $1, id, now() from cl_modules where key = 'market_feed'`, [MF]);
  const tok = (id) => ({ role: 'authenticated', sub: id, user_type: 'staff', is_sysadmin: false });
  r = await anon('cl_market_feed_save', { p_id: null, p_title: 'Prices up', p_body: 'x', p_active: true, p_starts_at: null, p_ends_at: null }, tok(r0[0].id));
  ok('Console staff without the Market feed module: not authorized', /Not authorized/.test(r.e || ''), J(r));
  r = await anon('cl_market_feed_save', { p_id: null, p_title: 'New: school shoes week', p_body: 'All week.', p_active: true, p_starts_at: null, p_ends_at: null }, tok(MF));
  ok('with the module: a broadcast is saved', r.j && r.j.ok, J(r));
  ok('... and logged', (await q(`select count(*)::int n from cl_activity_log where action = 'market_feed_added'`))[0].n === 1);
  p = await pull('MU01');
  ok('every till gets the market feed', p.market.length === 1 && p.market[0].title === 'New: school shoes week');
  await q(`update cl_market_feed set active = false`);
  ok('a switched-off broadcast is gone from the pull', (await pull('MU01')).market.length === 0);
  await q(`update cl_market_feed set active = true`);
  // a Guest's seat: cl_install_vendor sets cl.seat_guest for an invited Guest's seat (tested in roles-everywhere-test);
  // here cl_guest_seat() answers true for a moment, then is put back exactly as 20261114120000 made it
  const guestPull = await (async () => {
    await pg.exec(`create or replace function public.cl_guest_seat() returns boolean language sql stable as $$ select true $$`);
    try { return { pull: await pull('MU01'), push: await one('MU01', req) }; }
    finally { await pg.exec(`create or replace function public.cl_guest_seat() returns boolean
language sql stable as $$ select coalesce(current_setting('cl.seat_guest', true), '') = '1' $$`); }
  })();
  ok('a Guest\'s seat pulls the market feed only', guestPull.pull.guest === true && guestPull.pull.market.length === 1 && guestPull.pull.requests === undefined, J(guestPull.pull));
  ok('... and can push nothing', /GUEST_SEAT/.test(guestPull.push.raised || ''), J(guestPull.push));

  // ---- rollback ----
  r = await exec(pg, RB);
  ok('the rollback is refused while data exists', /rollback refused/.test(r.e || ''), r.e);
  await pg.exec(`delete from cl_stock_ctl_log; delete from cl_stock_request_lines; delete from cl_stock_requests; delete from cl_stock_recall_lines; delete from cl_stock_recalls;
           delete from cl_cycle_counts; delete from cl_market_feed`);
  await q(`delete from cl_activity_log where action like 'market_feed%'`);
  r = await exec(pg, RB);
  ok('then it applies', r.ok, r.e);
  const back = diff(before, fingerprint(await snapshot(q)));
  const backFns = [...new Set(back.changed.map((c) => (/(cl_\w+)\(/.exec(c.key) || [])[1]).filter(Boolean))];
  ok('the catalogue is exactly as before', back.onlyA.length === 0 && back.onlyB.length === 0 && backFns.length === 0, J([back.onlyA, back.onlyB, backFns]));
  const rights = (await q(`select rights from cl_shop_roles where business_id = $1`, [BIZ])).flatMap((x) => x.rights);
  ok('no role holds a v37 right any more', !rights.some((x) => NEW.includes(x)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
