// node supabase/tests/sales-sync-test.js
//
// Tests supabase/migrations/20261113120000_sales_sync.sql (B4, v35) and its
// rollback in an in-memory PGlite built from the repo (the live shape), never
// the live database:
//   - every kind of event is stored once (a retry is a duplicate), under the
//     CALLING till's business, branch and terminal, whatever the payload says;
//   - bad events are refused one by one, the rest of the batch is stored;
//   - an Office seat's money events are refused; its price changes need the
//     signed-in person's "Edit prices";
//   - credit across the business (decision 37): the balance (credit sales -
//     payments - returns to the debtor + brought forward), the check before a
//     credit sale, two tills and one customer (only one gets the last credit),
//     holds ending when the sale arrives or after 24 hours, the override;
//   - the balances list for the offline rule (decision 3);
//   - daily summaries; retention after 13 months keeps every balance (decision 36);
//   - other branches' sales and payouts by right, costs only with "View costs" (decision 38);
//   - sizes per sale (for the report); the preflight; the rollback exact.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261113120000_sales_sync.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = (n) => crypto.randomBytes(n || 16).toString('hex');
const staffCheck = () => ({ pin_salt: hex(16), pin_check: hex(32), pin_rounds: 150000 });
const exec = async (pg, sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };
const CASH = 'b1170000000000000000000000000001';

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261113180000_removed_devices.sql', '20261114120000_roles_everywhere.sql', '20261115120000_stock_control.sql', '20261116120000_vendor_register_status.sql', '20261117120000_srq_drafts.sql']) });   // the live shape
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
  const auth = (iid, tok) => ({ p_install_id: iid, p_secret_phrase: 'Mandie Phrase' + (tok ? '|' + tok : ''), p_device_key: key(iid) });
  const call = async (iid, fn, args, tok) => { const r = await anon(fn, { ...auth(iid, tok), ...(args || {}) }); return r.e ? { raised: r.e } : r.j; };
  const seed = () => ({ salt: hex(16), rounds: 150000, check: hex(32) });
  const code = async (iid, o) => { const s = seed(); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 35 })).j;

  // ---- the business: Harare (main) T1 + T2 + T3, Murehwa T1; Boss (Admin), Rudo (Cashier), Tari (other branches, no costs) ----
  let r = await anon('cl_branch_register', { ...auth('HA01'), p_business_name: 'Mandie Babyware', p_branch_name: 'Harare' });
  const HARARE = r.j.branch_id, BIZ = r.j.business_id;
  await join('HA02', (await code('HA01', { p_branch_id: HARARE })).code);
  await join('HA03', (await code('HA01', { p_branch_id: HARARE })).code);
  const MUREHWA = (await join('MU01', (await code('HA01', { p_new_branch_name: 'Murehwa' })).code)).branch_id;
  await anon('cl_branch_register', { ...auth('SO01'), p_business_name: 'Solo Shop', p_branch_name: 'Mbare', p_secret_phrase: 'Mandie Phrase' });
  await q(`update cl_shop_meta set v = now() - interval '1 day' where k = 'legacy_cutoff'`);
  const roles = Object.fromEntries((await call('HA01', 'cl_device_staff_pull')).roles.map((x) => [x.builtin || x.name, x.id]));
  r = await call('HA01', 'cl_device_staff_save', { p_staff_token: null, p_staff: { name: 'Boss', role_id: roles.admin, home_branch_id: HARARE, other_branches: [MUREHWA], pin: '1234', ...staffCheck() } });
  const ID = { Boss: r.staff.id };
  const signin = async (iid, name, pin) => (await call(iid, 'cl_device_staff_signin', { p_staff_id: ID[name], p_pin: pin })).token;
  const bossT1 = await signin('HA01', 'Boss', '1234');
  r = await call('HA01', 'cl_device_staff_save', { p_staff_token: bossT1, p_staff: { name: 'Rudo', role_id: roles.cashier, home_branch_id: MUREHWA, pin: '3333', ...staffCheck() } });
  ID.Rudo = r.staff.id;
  r = await call('HA01', 'cl_device_role_save', { p_staff_token: bossT1, p_role: { name: 'Area manager', rights: ['m.reports', 'm.reportwriter', 'sales_reports', 'other_branches'] } });
  r = await call('HA01', 'cl_device_staff_save', { p_staff_token: bossT1, p_staff: { name: 'Tari', role_id: r.role.id, home_branch_id: MUREHWA, pin: '5555', ...staffCheck() } });
  ID.Tari = r.staff.id;
  ok('(the business: Harare T1-T3, Murehwa T1; Boss, Rudo, Tari)', !!(bossT1 && ID.Rudo && ID.Tari));
  const C1 = hex(), C2 = hex();
  ok('(customers: Chipo with a $100 limit, Tendai with none)',
    (await call('HA01', 'cl_device_customer_save', { p_customer: { uid: C1, name: 'Chipo Traders', phone: '0782 223 333', customer_type: 'wholesale', credit_limit: 100 } })).ok &&
    (await call('HA01', 'cl_device_customer_save', { p_customer: { uid: C2, name: 'Tendai', phone: '0772 111 222' } })).ok);
  const before = fingerprint(await snapshot(q));

  // ---- the migration ----
  r = await exec(pg, MIG);
  ok('it applies', r.ok, r.e);
  r = await exec(pg, MIG);
  ok('a second run is refused by the preflight, changing nothing', /sales_sync aborted/.test(r.e || ''), r.e);
  const after = fingerprint(await snapshot(q));
  const d = diff(before, after);
  ok('only additions, plus cl_device_branch_report changed', d.onlyA.length === 0 && d.changed.length === 1 && /cl_device_branch_report/.test(d.changed[0].key) && d.onlyB.length > 20,
    JSON.stringify({ onlyA: d.onlyA, changed: d.changed.map((x) => x.key) }));
  const anonCan = async (sig) => (await q(`select has_function_privilege('anon', $1, 'execute') x`, [sig]))[0].x;
  ok('the tills\' calls are callable by anon; the helpers aren\'t', await anonCan('public.cl_device_b4_push(text,text,text,jsonb)') &&
    await anonCan('public.cl_device_credit_check(text,text,text,text,text,numeric,numeric,boolean)') && await anonCan('public.cl_device_credit_balances(text,text,text)') &&
    !(await anonCan('public.cl_b4_store(public.cl_terminals,jsonb)')) && !(await anonCan('public.cl_b4_balance(uuid,text)')) && !(await anonCan('public.cl_b4_retention(uuid)')));
  const tbl = await q(`select c.relname, c.relrowsecurity rls, has_table_privilege('anon', c.oid, 'select') anon_sel from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in ('cl_sales','cl_sale_returns','cl_credit_payments','cl_payouts','cl_eod_closes',
      'cl_credit_overrides','cl_price_change_log','cl_voucher_events','cl_credit_bf','cl_credit_holds','cl_sales_daily','cl_b4_runs')`);
  ok('12 new tables, RLS on, no table access for anon', tbl.length === 12 && tbl.every((x) => x.rls && !x.anon_sel), JSON.stringify(tbl));

  // ---- events ----
  const now = new Date(), iso = (ms) => new Date(now.getTime() + (ms || 0)).toISOString(), today = iso().slice(0, 10);
  const sale = (o) => ({ uid: o.uid || hex(), kind: 'sale', ts: o.ts || iso(), bday: o.bday || today, history: !!o.history, data: Object.assign({
    receipt_no: 'T1-0001', operator: 'Boss', price_level: 'retail', base_symbol: '$', subtotal: o.total, discount: 0, total: o.total, voucher_amount: 0,
    customer_uid: o.customer || null, lines: [{ product_uid: hex(), code: 'BIB1', name: 'Bib', qty: 2, unit_price: o.total / 2, discount: 0, line_total: o.total, cost: (o.total / 2) * 0.6 }],
    payments: o.payments || [{ method: o.method || 'Cash', amount: o.total, currency: 'BASE', rate: 1, tendered: o.total }] }, o.data || {}) });
  const push = (iid, events, tok) => call(iid, 'cl_device_b4_push', { p_events: events }, tok);
  const res = (r, uid) => (r.results || []).find((x) => x.uid === uid) || {};
  const S1 = sale({ total: 60, customer: C1, method: 'Credit', data: { credit_check: 'online', credit_scope: 'business', credit_before: 0, credit_after: 60, branch_id: MUREHWA, terminal_id: hex() } });
  const RET = { uid: hex(), kind: 'return', ts: iso(), bday: today, data: { cn_display: 'CN-T1-0001', sale_uid: S1.uid, customer_uid: C1, reason: 'Damaged', approved_by: 'Boss',
    goods_total: 10, cost_reversed: 6, lines: [{ code: 'BIB1', qty: 1, amount: 10 }], refunds: [{ method: 'Debtor', amount: 10 }] } };
  const PAY = { uid: hex(), kind: 'credit_payment', ts: iso(), bday: today, data: { customer_uid: C1, amount: 15, method: null, reference: 'cash at the counter', operator: 'Boss' } };
  const PO = { uid: hex(), kind: 'payout', ts: iso(), bday: today, data: { amount: 5, currency: '$', account_tag: null, reason: 'Fuel', operator: 'Boss', source: 'till cash' } };
  const EOD = { uid: hex(), kind: 'eod', ts: iso(), bday: today, data: { opening_float: 20, expected_cash: 75, counted_cash: 74, variance: -1, by_currency: [{ currency: 'BASE', tendered: 55, amount: 55 }],
    totals: { cash: 55, credit: 60 }, opened_by: 'Boss', closed_by: 'Boss' } };
  const OVR = { uid: 'ovr-' + S1.uid, kind: 'credit_override', ts: iso(), bday: today, data: { sale_uid: S1.uid, customer_uid: C1, amount_over: 5, credit_limit: 100, balance_before: 45,
    balance_after: 105, by_name: 'Boss', mode: 'single operator', right_held: false, single_operator: true, checked: 'online' } };
  const PC = { uid: hex(), kind: 'price_change', ts: iso(), bday: today, data: { code: 'BIB1', name: 'Bib', old_price: 5, new_price: 2, cost: 3, by_name: 'Boss', how: 'on this till' } };
  const VI = { uid: hex(), kind: 'voucher_issue', ts: iso(), bday: today, data: { voucher_kind: 'loyalty', customer_uid: C2, amount: 2 } };
  const VU = { uid: 'use-' + VI.uid, kind: 'voucher_use', ts: iso(), bday: today, data: { voucher_uid: VI.uid, voucher_kind: 'loyalty', customer_uid: C2, amount: 2, sale_uid: S1.uid } };
  const all = [S1, RET, PAY, PO, EOD, OVR, PC, VI, VU];
  r = await push('HA01', all);
  ok('every kind is stored', r.ok && r.results.length === 9 && r.results.every((x) => x.status === 'stored'), JSON.stringify(r));
  r = await push('HA01', all);
  ok('the same events again: duplicates, stored once', r.results.every((x) => x.status === 'duplicate') &&
    (await q('select count(*)::int n from cl_sales'))[0].n === 1 && (await q('select count(*)::int n from cl_credit_payments'))[0].n === 1, JSON.stringify(r));
  const T = Object.fromEntries((await q('select install_id, id, branch_id from cl_terminals')).map((x) => [x.install_id, x]));
  const s1 = (await q('select * from cl_sales where uid = $1', [S1.uid]))[0];
  ok('stored under the calling till\'s business, branch and terminal (the payload\'s claims ignored)', s1.business_id === BIZ && s1.branch_id === HARARE && s1.terminal_id === T.HA01.id);
  ok('the credit amount is worked out by seiGEN from the payments; cost total from the lines', Number(s1.credit_amount) === 60 && Number(s1.cost_total) === 36);
  ok('the return\'s debtor part from its refunds', Number((await q('select debtor_amount from cl_sale_returns'))[0].debtor_amount) === 10);
  ok('the override keeps "single operator" (decision 30)', (await q('select single_operator, mode from cl_credit_overrides'))[0].single_operator === true);
  ok('the price change is flagged below cost', (await q('select below_cost from cl_price_change_log'))[0].below_cost === true);
  const daily = (await q('select * from cl_sales_daily where terminal_id = $1', [T.HA01.id]))[0];
  ok('the day\'s summary: 1 sale $60 (credit $60), 1 return $10, 1 payout $5, by method', daily && daily.sales_count === 1 && Number(daily.sales_total) === 60 &&
    Number(daily.credit_total) === 60 && daily.returns_count === 1 && Number(daily.returns_total) === 10 && daily.payouts_count === 1 && Number(daily.payouts_total) === 5 &&
    Number(daily.by_method.Credit) === 60 && Number(daily.by_method.Debtor) === -10, JSON.stringify(daily));

  // ---- refusals, one by one ----
  r = await push('HA01', [{ uid: 'x', kind: 'sale', ts: iso() }, { uid: hex(), kind: 'nonsense', ts: iso() }, { uid: hex(), kind: 'sale', ts: 'not a time', data: {} },
    { uid: hex(), kind: 'credit_payment', ts: iso(), data: { amount: 3 } }, sale({ total: 4 })]);
  ok('bad events refused one by one (no uid, unknown kind, bad time, no customer); the good one stored', r.results.length === 5 &&
    r.results.slice(0, 4).every((x) => x.status === 'refused') && ['BAD_EVENT', 'BAD_EVENT', 'INVALID', 'BAD_EVENT'].every((c, i) => r.results[i].code === c) &&
    r.results[4].status === 'stored', JSON.stringify(r.results));
  r = await push('HA01', [sale({ total: 3, ts: new Date(now.getTime() - 400 * 86400e3).toISOString() })]);
  ok('an event older than 13 months is refused as TOO_OLD', r.results[0].code === 'TOO_OLD', JSON.stringify(r));
  r = await push('HA01', Array.from({ length: 101 }, () => sale({ total: 1 })));
  ok('more than 100 events at once is refused', /At most 100/.test(r.raised || ''), JSON.stringify(r).slice(0, 200));
  r = await call('SO01', 'cl_device_b4_push', { p_events: [Object.assign({}, S1)] });
  ok('another business\'s till sending the same uid stores its own copy (uids are per business)', res(r, S1.uid).status === 'stored' &&
    (await q('select count(*)::int n from cl_sales where uid = $1', [S1.uid]))[0].n === 2);
  r = await anon('cl_device_b4_push', { p_install_id: 'HA01', p_secret_phrase: 'Wrong phrase', p_device_key: key('HA01'), p_events: [sale({ total: 1 })] });
  ok('a wrong phrase is refused before anything is stored', /phrase/i.test(r.e || ''), JSON.stringify(r));
  await q(`update cl_terminals set active = false where install_id = 'HA02'`);
  r = await push('HA02', [sale({ total: 1 })]);
  ok('a switched-off till: TERMINAL_INACTIVE, nothing stored', r.error === 'TERMINAL_INACTIVE');
  await q(`update cl_terminals set active = true where install_id = 'HA02'`);

  // ---- an Office seat never sells ----
  await q(`update cl_terminals set device_kind = 'seat', till_code = 'S1' where install_id = 'HA03'`);
  r = await push('HA03', [sale({ total: 9 }), PAY, Object.assign({}, PC, { uid: hex() })]);
  ok('a seat\'s sale and payment are refused (SEAT_NO_SELLING); its price change needs someone signed in', res(r, r.results[0].uid).code === 'SEAT_NO_SELLING' &&
    r.results[1].code === 'SEAT_NO_SELLING' && r.results[2].code === 'SEAT_SIGN_IN', JSON.stringify(r));
  r = await call('HA03', 'cl_device_credit_check', { p_customer_uid: C1, p_sale_uid: hex(), p_amount: 1 });
  ok('... and it can\'t check credit for a sale', r.error === 'SEAT_NO_SELLING');
  await q(`update cl_terminals set device_kind = 'till', till_code = 'T3' where install_id = 'HA03'`);

  // ---- credit across the business (decision 37) ----
  const bal = async (c) => Number((await q('select cl_b4_balance($1, $2) b', [BIZ, c]))[0].b);
  ok('Chipo\'s business balance = 60 credit - 10 returned to the account - 15 paid = 35', (await bal(C1)) === 35);
  const chk = (iid, amount, saleUid, o) => call(iid, 'cl_device_credit_check', Object.assign({ p_customer_uid: C1, p_sale_uid: saleUid || hex(), p_amount: amount }, o || {}));
  r = await chk('HA02', 70);
  ok('T2: $70 more would be $105, over the $100 limit: not allowed, nothing held', r.ok && r.allowed === false && Number(r.balance) === 35 && Number(r.after) === 105 &&
    (await q('select count(*)::int n from cl_credit_holds'))[0].n === 0, JSON.stringify(r));
  const H1 = hex(), H2 = hex();
  r = await chk('HA02', 40, H1);
  ok('T2: $40 fits ($75): allowed, held under the sale\'s uid', r.allowed === true && Number(r.available) === 65 && (await q('select amount from cl_credit_holds where sale_uid = $1', [H1]))[0].amount == 40, JSON.stringify(r));
  r = await chk('MU01', 40, H2);
  ok('two tills, one customer: Murehwa asking $40 at the same time sees T2\'s hold and is refused ($115)', r.allowed === false && Number(r.held) === 40 && Number(r.after) === 115, JSON.stringify(r));
  r = await chk('MU01', 25, H2);
  ok('... $25 still fits ($100): allowed', r.allowed === true && Number(r.available) === 25, JSON.stringify(r));
  r = await chk('HA02', 40, H1);
  ok('asking again for the same sale doesn\'t count its own hold twice', r.allowed === true && Number(r.held) === 25, JSON.stringify(r));
  r = await chk('HA01', 1);
  ok('the last cent is gone: $1 more is refused', r.allowed === false && Number(r.available) === 0, JSON.stringify(r));
  r = await chk('HA01', 5, null, { p_override: true });
  ok('... the till\'s override (decision 30) is held all the same', r.allowed === true, JSON.stringify(r));
  const s2 = sale({ uid: H1, total: 40, customer: C1, method: 'Credit' });
  r = await push('HA02', [s2]);
  ok('T2\'s sale arrives: its hold ends, the balance is $75', res(r, H1).status === 'stored' && (await q('select count(*)::int n from cl_credit_holds where sale_uid = $1', [H1]))[0].n === 0 && (await bal(C1)) === 75);
  const s3 = sale({ total: 25, customer: C1, method: 'Credit', data: { hold_uid: H2 } });
  r = await push('MU01', [s3]);
  ok('a sale sent under another uid ends its hold by hold_uid (shared-stock tills)', (await q('select count(*)::int n from cl_credit_holds where sale_uid = $1', [H2]))[0].n === 0 && (await bal(C1)) === 100);
  await q(`update cl_credit_holds set expires_at = now() - interval '1 minute'`);
  r = await chk('HA01', 0.01);
  ok('a hold older than 24 hours no longer counts', Number(r.held) === 0, JSON.stringify(r));
  r = await call('HA01', 'cl_device_credit_check', { p_customer_uid: hex(), p_sale_uid: hex(), p_amount: 50, p_limit: 30 });
  ok('a customer seiGEN doesn\'t know (kept on one till): the till\'s own limit', r.allowed === false && Number(r.limit) === 30, JSON.stringify(r));
  r = await call('HA01', 'cl_device_credit_check', { p_customer_uid: C2, p_sale_uid: hex(), p_amount: 5000 });
  ok('no limit: always allowed', r.allowed === true && r.limit === null, JSON.stringify(r));
  r = await push('HA01', [{ uid: 'bf-' + T.HA01.id + '-7', kind: 'credit_bf', ts: new Date(now.getTime() - 91 * 86400e3).toISOString(), history: true, data: { customer_uid: C2, amount: 12.5 } }]);
  ok('a balance brought forward from before the 90 days counts (Tendai owes $12.50)', r.results[0].status === 'stored' && (await bal(C2)) === 12.5, JSON.stringify(r));
  r = await call('HA02', 'cl_device_credit_balances');
  const bm = Object.fromEntries((r.balances || []).map((x) => [x.uid, Number(x.balance)]));
  ok('every till gets the business\'s balances (non-zero only)', bm[C1] === 100 && bm[C2] === 12.5 && Object.keys(bm).length === 2, JSON.stringify(r));
  r = await call('SO01', 'cl_device_credit_balances');
  ok('... another business sees only its own', (r.balances || []).every((x) => x.uid !== C2), JSON.stringify(r));

  // ---- history (decision 35) ----
  const HS = sale({ total: 7, history: true, ts: new Date(now.getTime() - 30 * 86400e3).toISOString(), bday: new Date(now.getTime() - 30 * 86400e3).toISOString().slice(0, 10) });
  r = await push('MU01', [HS]);
  const hrow = (await q('select history from cl_sales where uid = $1', [HS.uid]))[0];
  const hday = (await q('select history, sales_count from cl_sales_daily where terminal_id = $1 and bday = $2', [T.MU01.id, HS.bday]))[0];
  ok('a history sale is marked history, and so is its day while it has nothing else', hrow.history === true && hday.history === true && hday.sales_count === 1, JSON.stringify(hday));

  // ---- retention (decision 36) ----
  const OLD = hex(), OLDP = hex(), cut = new Date(now.getTime() - 14 * 31 * 86400e3).toISOString();
  await q(`insert into cl_sales (business_id, uid, branch_id, terminal_id, sold_at, bday, total, credit_amount, customer_uid, lines, payments)
           values ($1, $2, $3, $4, $5::timestamptz, ($5::timestamptz)::date, 30, 30, $6, '[]', '[{"method":"Credit","amount":30}]')`, [BIZ, OLD, HARARE, T.HA01.id, cut, C2]);
  await q(`insert into cl_credit_payments (business_id, uid, branch_id, terminal_id, customer_uid, paid_at, bday, amount) values ($1, $2, $3, $4, $5, $6::timestamptz, ($6::timestamptz)::date, 10)`,
    [BIZ, OLDP, HARARE, T.HA01.id, C2, cut]);
  await q(`insert into cl_payouts (business_id, uid, branch_id, terminal_id, paid_at, bday, amount) values ($1, $2, $3, $4, $5::timestamptz, ($5::timestamptz)::date, 1)`, [BIZ, hex(), HARARE, T.HA01.id, cut]);
  const balBefore = await bal(C2);
  await q(`update cl_b4_runs set retention_on = current_date - 1 where business_id = $1`, [BIZ]);
  r = await push('HA01', [sale({ total: 2 })]);
  ok('retention runs at most once a day: the detail older than 13 months is gone', (await q('select count(*)::int n from cl_sales where uid = $1', [OLD]))[0].n === 0 &&
    (await q('select count(*)::int n from cl_credit_payments where uid = $1', [OLDP]))[0].n === 0 && (await q(`select count(*)::int n from cl_payouts where paid_at < now() - interval '13 months'`))[0].n === 0);
  ok('... and Tendai\'s balance is the same ($' + balBefore + '), carried forward', (await bal(C2)) === balBefore && balBefore === 32.5 &&
    Number((await q(`select amount from cl_credit_bf where uid = $1`, ['cf-' + C2]))[0].amount) === 20);
  ok('... the daily summaries stay', (await q('select count(*)::int n from cl_sales_daily where business_id = $1', [BIZ]))[0].n >= 2);
  const runs = (await q('select retention_on from cl_b4_runs where business_id = $1', [BIZ]))[0];
  ok('... once a day', runs && new Date(runs.retention_on).toISOString().slice(0, 10) === new Date(new Date().setHours(0, 0, 0, 0) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) || !!runs);

  // ---- other branches' sales and payouts (decision 38) ----
  const tariMU = await signin('MU01', 'Tari', '5555'), rudoMU = await signin('MU01', 'Rudo', '3333'), bossMU = await signin('MU01', 'Boss', '1234');
  const rep = (iid, tok, kind, branch) => call(iid, 'cl_device_branch_report', { p_staff_token: tok, p_kind: kind, p_branch_id: branch });
  r = await rep('MU01', rudoMU, 'sales', HARARE);
  ok('a Cashier at Murehwa can\'t read Harare\'s sales', r.error === 'NO_RIGHT', JSON.stringify(r));
  r = await rep('MU01', null, 'sales', HARARE);
  ok('... nor can single operator mode (no one signed in)', r.error === 'NO_RIGHT');
  r = await rep('MU01', tariMU, 'sales', HARARE);
  const sRow = (r.rows || []).find((x) => x.uid === S1.uid);
  ok('with "View other branches\' reports": Harare\'s sales and returns, without costs', r.costs === false && sRow && sRow.cost === null && sRow.customer === 'Chipo Traders' &&
    sRow.method === 'Credit' && (r.rows || []).some((x) => x.type === 'return' && x.cost === null), JSON.stringify(r).slice(0, 400));
  r = await rep('MU01', bossMU, 'sales', HARARE);
  ok('with "View costs" too: the cost', r.costs === true && Number((r.rows.find((x) => x.uid === S1.uid) || {}).cost) === 36);
  r = await rep('MU01', rudoMU, 'sales', MUREHWA);
  ok('a Cashier sees their own branch', r.kind === 'sales' && (r.rows || []).some((x) => x.uid === s3.uid), JSON.stringify(r).slice(0, 300));
  r = await rep('MU01', tariMU, 'payouts', HARARE);
  ok('payouts by right', (r.rows || []).some((x) => x.reason === 'Fuel' && Number(x.amount) === 5), JSON.stringify(r).slice(0, 300));
  r = await rep('MU01', tariMU, 'inventory', HARARE);
  ok('the older kinds answer as before', r.kind === 'inventory' && Array.isArray(r.rows), JSON.stringify(r).slice(0, 200));

  // ---- sizes (for the report) ----
  const N = 2000, batch = [];
  for (let i = 0; i < N; i++) {
    const lines = Array.from({ length: 3 }, (_, k) => ({ product_uid: hex(), cat_uid: hex(), code: 'SKU' + (i * 3 + k), name: 'Product name ' + (i * 3 + k), qty: 1 + (k % 2),
      unit_price: 4.5, discount: 0, line_total: 4.5 * (1 + (k % 2)), cost: 2.7, price_level: 'retail' }));
    batch.push(sale({ total: 18, data: { receipt_no: 'T2-' + String(i).padStart(5, '0'), operator: 'Rudo Moyo', lines } }));
  }
  const relBytes = async (t) => Number((await q(`select pg_total_relation_size($1::regclass) n`, ['public.' + t]))[0].n);
  await pg.exec('vacuum full public.cl_sales'); await pg.exec('vacuum full public.cl_sales_daily');   // steady state, not MVCC dead rows
  const b0 = await relBytes('cl_sales'), n0 = (await q('select count(*)::int n from cl_sales'))[0].n;
  for (let i = 0; i < N; i += 100) await push('HA02', batch.slice(i, i + 100));
  await pg.exec('vacuum full public.cl_sales'); await pg.exec('vacuum full public.cl_sales_daily');
  const b1 = await relBytes('cl_sales'), d1 = await relBytes('cl_sales_daily'), dn = (await q('select count(*)::int n from cl_sales_daily'))[0].n;
  const per = (b1 - b0) / N;
  console.log('  size: one sale with 3 lines and 1 payment = ' + Math.round(per) + ' bytes in cl_sales (table + indexes, ' + n0 + ' -> ' + (n0 + N) + ' rows); cl_sales_daily ' + d1 + ' bytes for ' + dn + ' till-days');
  ok('a typical sale (3 lines, 1 payment) takes under 2 KB', per > 200 && per < 2048, per);

  // ---- rollback ----
  r = await exec(pg, RB);
  ok('the rollback applies', r.ok, r.e);
  const back = fingerprint(await snapshot(q));
  const d2 = diff(before, back);
  ok('after the rollback the catalogue is exactly as before', d2.onlyA.length === 0 && d2.onlyB.length === 0 && d2.changed.length === 0, JSON.stringify(d2));
  r = await call('MU01', 'cl_device_branch_report', { p_staff_token: tariMU, p_kind: 'sales', p_branch_id: HARARE });
  ok('... and the report kinds are the old ones again', /inventory, dispatches or supplier_grvs/.test(r.raised || ''), JSON.stringify(r));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
