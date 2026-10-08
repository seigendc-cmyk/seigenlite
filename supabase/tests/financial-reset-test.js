// node supabase/tests/financial-reset-test.js
//
// Tests supabase/data-fixes/20261009_financial_reset.sql in an in-memory
// PGlite built from the repo in the live shape, seeded with records like
// live's (4 ledger rows summing 95.00, 6 cashbook rows: 220.00 in, 5.00 out,
// one draft voucher with one line, licences #1001/#1002, 3 rate rows):
// it refuses (changing nothing) when the records differ from what was shown,
// and otherwise clears exactly the financial records and keeps the rest.
'use strict';
const path = require('path');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const SQL = READ(path.join(__dirname, '..', 'data-fixes', '20261009_financial_reset.sql'));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 500) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const one = async (sql, p) => Object.values((await q(sql, p))[0])[0];

  const staff = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), 'Staff', 'x', true, true, now()) returning id`))[0].id;
  for (const a of [60, 20, 15]) await q(`insert into cl_activation_pricing (id, amount, currency, effective_from, created_at, set_by) values (gen_random_uuid(), $1, 'USD', now(), now(), $2)`, [a, staff]);
  const coa = {};
  for (const [code, name, t] of [['1000', 'Cash on Hand', 'asset'], ['1100', 'Bank Account', 'asset'], ['1200', 'Ecocash LN', 'asset'], ['4000', 'Activation Fee Income', 'income'],
    ['4100', 'Other Income', 'income'], ['5000', 'Operating Expenses', 'expense'], ['5100', 'Commissions Paid', 'expense'], ['6000', 'Subs Refund', 'expense']])
    coa[code] = (await q(`insert into cl_chart_of_accounts (id, code, name, account_type, active, created_at) values (gen_random_uuid(), $1, $2, $3, true, now()) returning id`, [code, name, t]))[0].id;
  const vend = async (n, i) => (await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, status) values ($1, $2, 'p', 'onboarding') returning id`, [n, i]))[0].id;
  const brechin = await vend('Brechin Nursery', 'BRCH'), dixie = await vend('Dixie Shoes', 'DIXI');
  const led = async (v, t, a, notes) => (await q(`insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes, recorded_by) values ($1, $2, $3, 'USD', $4, $5) returning id`, [v, t, a, notes, staff]))[0].id;
  const p1 = await led(brechin, 'payment', 40, 'Sep 2026'), p2 = await led(brechin, 'payment', 25, null);
  const ch = await led(dixie, 'charge', 15, 'Auto-charged: licence #1002 (30 days)'), p3 = await led(dixie, 'payment', 15, null);
  const cash = (dir, a, acc, src, st) => q(`insert into cl_cashbook_entries (direction, amount, currency, coa_account_id, description, source_type, source_id, recorded_by) values ($1, $2, 'USD', $3, 'x', $4, $5, $6)`,
    [dir, a, coa[acc], st || 'ledger_payment', src, staff]);
  await cash('in', 40, '1000', p1); await cash('out', 5, '5100', null, 'manual'); await cash('in', 25, '1000', p2);
  await cash('in', 20, '1000', '00000000-0000-0000-0000-000000000001'); await cash('in', 120, '1000', '00000000-0000-0000-0000-000000000002'); await cash('in', 15, '1100', p3);
  const v = (await q(`insert into cl_payment_vouchers (voucher_date, payee, currency, status, prepared_by, paying_account_id, total_amount) values (current_date, 'Mukumba Stores', 'USD', 'draft', $1, $2, 3.20) returning id, voucher_no`, [staff, coa['1000']]))[0];
  await q(`insert into cl_payment_voucher_lines (voucher_id, coa_account_id, amount, description, line_order) values ($1, $2, 3.20, 'Overpayment', 0)`, [v.id, coa['6000']]);
  const lic = async (serial, vendor, ledger) => q(`insert into cl_licences (serial, key_id, install_id, device_tag, binding, strong_binding, vendor_id, days, valid_from, valid_to, payload, licence, short_code_hash, status, issued_by, ledger_entry_id) overriding system value
    values ($1, 1, 'EM6P', 'PTF5', '\\x0000000000000000', true, $2, 30, current_date, current_date + 30, '\\x00', 'SL2.x', md5($5), 'issued', $3, $4)`, [serial, vendor, staff, ledger, String(serial)]);
  await lic(1001, null, null); await lic(1002, dixie, ch);
  await q(`select setval('cl_licences_serial_seq', 1002)`);
  const counts = () => q(`select (select count(*)::int from cl_ledger_entries) ledger, (select count(*)::int from cl_cashbook_entries) cash, (select count(*)::int from cl_payment_vouchers) vouchers,
    (select count(*)::int from cl_payment_voucher_lines) vlines, (select count(*)::int from cl_licences) lic, (select count(*)::int from cl_activation_pricing) price,
    (select count(*)::int from cl_chart_of_accounts) coa, (select count(*)::int from cl_vendors) vendors, (select count(*)::int from cl_price_plan_versions) versions`).then((r) => r[0]);
  const before = await counts();
  ok('seeded like live: 4 ledger (95.00), 6 cashbook (220 in / 5 out), 1 voucher + 1 line, 2 licences, 3 rates, 8 accounts',
    before.ledger === 4 && before.cash === 6 && before.vouchers === 1 && before.vlines === 1 && before.lic === 2 && before.price === 3 && before.coa === 8 && v.voucher_no === 'PV-00001', JSON.stringify(before));

  // 1. records differ from what was shown: refused, nothing changed
  await led(dixie, 'charge', 1, 'extra');
  let e = null; try { await pg.exec(SQL); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('records differ from what was shown: refused', /financial reset aborted: the records changed/.test(e || ''), e);
  await q(`delete from cl_ledger_entries where notes = 'extra'`);
  ok('... and nothing was changed', JSON.stringify(await counts()) === JSON.stringify(before));

  // 2. as shown: cleared
  const notices = [];
  pg.onNotice ? pg.onNotice((n) => notices.push(n.message)) : null;
  e = null; try { await pg.exec(SQL); } catch (x) { e = x.message; }
  ok('as shown: it runs', !e, e);
  const after = await counts();
  ok('ledger, cashbook, vouchers and lines are empty', after.ledger === 0 && after.cash === 0 && after.vouchers === 0 && after.vlines === 0, JSON.stringify(after));
  ok('kept: licences 2, rates 3, accounts 8, vendors, plan versions', after.lic === 2 && after.price === 3 && after.coa === 8 && after.vendors === before.vendors && after.versions === before.versions, JSON.stringify(after));
  ok('every account balance is 0.00', (await q(`select a.code, coalesce(sum(case when c.direction='in' then c.amount else -c.amount end), 0)::text b from cl_chart_of_accounts a left join cl_cashbook_entries c on c.coa_account_id = a.id group by 1`)).every((r) => Number(r.b) === 0));
  ok('licences kept, unlinked from the deleted charge, noted TEST, serial not restarted',
    JSON.stringify(await q(`select serial, note, ledger_entry_id from cl_licences order by serial`)) === JSON.stringify([{ serial: 1001, note: 'TEST', ledger_entry_id: null }, { serial: 1002, note: 'TEST', ledger_entry_id: null }]) &&
    Number(await one(`select last_value from cl_licences_serial_seq`)) === 1002);
  ok('the next voucher is PV-00001 again', (await q(`insert into cl_payment_vouchers (voucher_date, payee, currency, status, prepared_by, paying_account_id, total_amount) values (current_date, 'x', 'USD', 'draft', $1, $2, 1) returning voucher_no`, [staff, coa['1000']]))[0].voucher_no === 'PV-00001');
  await q(`delete from cl_payment_vouchers`); await q(`select setval('cl_voucher_no_seq', 1, false)`);
  const logRow = (await q(`select staff_id, detail from cl_activity_log where action = 'financial_reset'`))[0];
  ok('the reset is in the activity log, with what was cleared', logRow && logRow.staff_id === null && Number(logRow.detail.ledger_rows) === 4 && Number(logRow.detail.cashbook_rows) === 6 && Number(logRow.detail.vouchers) === 1, JSON.stringify(logRow));

  // 3. a second run: the records now differ (all zero): refused, nothing changed
  e = null; try { await pg.exec(SQL); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused (nothing left to clear), changing nothing', /financial reset aborted/.test(e || '') && Number(await one(`select count(*) from cl_activity_log where action = 'financial_reset'`)) === 1, e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
