// node supabase/tests/ledger-credits-test.js
//
// Tests supabase/migrations/20261011120000_ledger_credits.sql (and its
// rollback) in an in-memory PGlite built from the repo (the live shape:
// Supabase stub + baseline + every applied migration), never the live
// database. Covers who may post a credit, the checks on amount, reason and
// the reversed charge, that no Cashbook entry is written, the activity log,
// the balance arithmetic the Console uses, and the rollback.
'use strict';
const path = require('path');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const MIG = READ(path.join(ROOT, 'migrations', '20261011120000_ledger_credits.sql'));
const RB = READ(path.join(ROOT, 'rollbacks', '20261011120000_ledger_credits.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat(['20261011120000_ledger_credits.sql', '20261012120000_payment_reversal_and_duplicate_guards.sql', '20261013120000_price_plans.sql', '20261014120000_vendor_delete_guard.sql', '20261015120000_rpn_commissions.sql']) });   // the shape just before this migration (it is on live now)
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));

  async function as(role, claims, sql, p) {
    await pg.exec('set role ' + role);
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }

  // ---- data, as live has it ----
  const staff = {};
  for (const [k, sys, active] of [['LED', false, true], ['BIL', false, true], ['NONE', false, true], ['SYS', true, true], ['GONE', false, false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, $3, now()) returning id`, ['Staff ' + k, sys, active]))[0].id;
  const mod = {};
  for (const k of ['collections_ledger', 'billing_reminders', 'activation_codes'])
    mod[k] = (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [k]))[0].id;
  const grant = (s, m) => q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff[s], mod[m]]);
  await grant('LED', 'collections_ledger'); await grant('BIL', 'billing_reminders'); await grant('NONE', 'activation_codes'); await grant('GONE', 'collections_ledger');
  const tok = (k, extra) => Object.assign({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' }, extra || {});
  const vendor = async (name) => (await q(`insert into cl_vendors (business_name, status) values ($1, 'onboarding') returning id`, [name]))[0].id;
  const W = await vendor('Weldone Ent'), O = await vendor('Other Shop');
  const charge = async (v, amount, cur, notes) => (await q(`insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes) values ($1, 'charge', $2, $3, $4) returning id`, [v, amount, cur || 'USD', notes || 'Auto-charged: licence #1001 (30 days)']))[0].id;
  const C1 = await charge(W, 20), C2 = await charge(O, 20), PAYW = (await q(`insert into cl_ledger_entries (vendor_id, entry_type, amount, currency) values ($1, 'payment', 5, 'USD') returning id`, [W]))[0].id;
  const credit = (k, args, claims) => as('authenticated', claims || tok(k),
    `select public.cl_record_ledger_credit(p_vendor_id=>$1::uuid, p_amount=>$2::numeric, p_currency=>$3, p_reason=>$4, p_reverses_entry_id=>$5::uuid) j`,
    [args.vendor || W, args.amount == null ? 20 : args.amount, args.currency || 'USD', args.reason == null ? 'Reversal of test licence #1001 charge' : args.reason, args.reverses || null]);
  const cash = async () => Number((await q(`select count(*) n from cl_cashbook_entries`))[0].n);
  // the Console's rule (vendorBalancesByCurrency): charge adds, anything else subtracts
  const balance = async (v) => Number((await q(`select coalesce(sum(case when entry_type = 'charge' then amount else -amount end), 0) b from cl_ledger_entries where vendor_id = $1 and currency = 'USD'`, [v]))[0].b);

  console.log('before the migration');
  let r = await as('postgres', null, `insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes) values ('${W}', 'credit', 1, 'USD', 'x')`);
  ok("a 'credit' entry is refused today", /entry_type_check/.test(r.e || ''), r.e);

  await pg.exec(MIG);
  ok('the migration applies to the live shape', true);
  let again = null; try { await pg.exec(MIG); } catch (e) { again = e.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /ledger_credits aborted: already exists/.test(again || ''), again);

  console.log('who may post a credit');
  r = await as('anon', null, `select public.cl_record_ledger_credit('${W}', 20, 'USD', 'x') j`);
  ok('anonymous (anon key): refused by the grants', /permission denied/i.test(r.e || ''), r.e);
  r = await credit('NONE', {});
  ok('staff without Collections Ledger / Billing (only Activation Codes): Not authorized', /Not authorized/.test(r.e || ''), r.e);
  r = await credit('GONE', {});
  ok('a deactivated staff member with Collections Ledger (token still unexpired): Not authorized', /Not authorized/.test(r.e || ''), r.e);
  r = await credit('LED', {}, { role: 'authenticated', sub: staff.LED, user_type: 'rpn' });
  ok('an RPN token: Not authorized', /Not authorized/.test(r.e || ''), r.e);
  r = await as('authenticated', tok('LED'), `insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes) values ('${W}', 'credit', 20, 'USD', 'sneaky')`);
  ok('nobody can insert a credit directly (row-level security; only the function writes)', /row-level security|permission denied/i.test(r.e || ''), r.e);

  console.log('the checks');
  for (const [name, args, re] of [
    ['amount 0', { amount: 0 }, /greater than zero/], ['negative amount', { amount: -5 }, /greater than zero/],
    ['3 decimals', { amount: 1.005 }, /at most 2 decimals/], ['no reason', { reason: '  ' }, /reason is required/],
    ['bad currency', { currency: 'dollars' }, /3-letter/], ['unknown vendor', { vendor: '00000000-0000-0000-0000-000000000000' }, /No such vendor/],
    ['reverse a payment', { reverses: PAYW, amount: 5 }, /Only a charge/], ['reverse another vendor\'s charge', { reverses: C2 }, /another vendor/],
    ['reverse in another currency', { reverses: C1, currency: 'ZWG' }, /is in USD, not ZWG/], ['more than the charge', { reverses: C1, amount: 20.01 }, /more than the charge/],
  ]) { r = await credit('LED', args); ok('refused: ' + name, re.test(r.e || ''), r.e); }
  ok('... and nothing was written', Number((await q(`select count(*) n from cl_ledger_entries where entry_type = 'credit'`))[0].n) === 0);

  console.log('posting');
  const cashBefore = await cash();
  ok('Weldone Ent owes USD 15.00 before (charge 20, payment 5)', await balance(W) === 15, await balance(W));
  r = await credit('LED', { reverses: C1, amount: 15, reason: '  Reversal of test licence #1001 charge  ' });
  ok('staff WITH Collections Ledger posts a credit against the charge', !r.e, r.e);
  const e = r.r && r.r[0].j.ledger_entry;
  ok('... entry_type credit, the amount, currency, trimmed reason, who, and the charge it reverses',
    e && e.entry_type === 'credit' && Number(e.amount) === 15 && e.currency === 'USD' && e.notes === 'Reversal of test licence #1001 charge' && e.recorded_by === staff.LED && e.reverses_entry_id === C1, JSON.stringify(e));
  ok('... no Cashbook entry (no cash moved)', await cash() === cashBefore);
  const log = (await q(`select staff_id, action, target_id, detail from cl_activity_log where action = 'record_ledger_credit'`))[0];
  ok('... logged with who posted it, the vendor, amount, reason and the reversed charge',
    log && log.staff_id === staff.LED && log.target_id === e.id && log.detail.vendor_id === W && Number(log.detail.amount) === 15 && log.detail.reverses_entry_id === C1, JSON.stringify(log));
  ok('the Console\'s balance rule now gives 0.00', await balance(W) === 0, await balance(W));
  r = await credit('BIL', { reverses: C1, amount: 5.01 });
  ok('credits against one charge can\'t exceed it (15 + 5.01 > 20)', /more than the charge/.test(r.e || ''), r.e);
  r = await credit('BIL', { reverses: C1, amount: 5, reason: 'rest of it' });
  ok('staff with Billing & Reminders may post too (15 + 5 = 20 is fine)', !r.e, r.e);
  r = await credit('SYS', { vendor: O, amount: 2.5, reason: 'goodwill, no charge referenced' });
  ok('sysadmin may post a credit that references no charge', !r.e, r.e);
  ok('balances: Weldone Ent -5.00 (in credit), Other Shop 17.50', await balance(W) === -5 && await balance(O) === 17.5, [await balance(W), await balance(O)]);

  console.log('the table rules');
  r = await as('postgres', null, `insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes) values ('${W}', 'credit', 1, 'USD', '')`);
  ok('a credit without a reason breaks the table rule', /credit_shape/.test(r.e || ''), r.e);
  r = await as('postgres', null, `insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, reverses_entry_id) values ('${W}', 'payment', 1, 'USD', '${C1}')`);
  ok('only a credit may point at a charge', /credit_shape/.test(r.e || ''), r.e);
  r = await as('postgres', null, `delete from cl_ledger_entries where id = '${C1}'`);
  ok('a charge with credits against it can\'t be deleted', /foreign key|violates/i.test(r.e || ''), r.e);
  ok('existing payments and charges are untouched by the new rules', Number((await q(`select count(*) n from cl_ledger_entries where entry_type in ('charge','payment')`))[0].n) === 3);

  console.log('rollback');
  let rb = null; try { await pg.exec(RB); } catch (x) { rb = x.message; } await pg.exec('rollback').catch(() => {});
  ok('the rollback refuses while credits exist, changing nothing', /rollback aborted: 3 credit/.test(rb || ''), rb);
  await q(`delete from cl_activity_log where action = 'record_ledger_credit'`);
  await q(`delete from cl_ledger_entries`);
  await q(`delete from cl_vendors`); await q(`delete from cl_staff_module_access`); await q(`delete from cl_modules`); await q(`delete from cl_staff`);
  await pg.exec(RB);
  const after = fingerprint(await snapshot(q));
  const d = diff(before, after);
  ok('with no credits, the rollback restores the exact pre-migration catalogue', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 500));
  await pg.exec(MIG);
  ok('and the migration applies again after a rollback', true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
