// node supabase/tests/payment-reversal-test.js
//
// Tests supabase/migrations/20261012120000_payment_reversal_and_duplicate_guards.sql
// (and its rollback) in an in-memory PGlite built from the repo in the live
// shape, never the live database: payment reversals (who, checks, the cash
// out on the same account, one per payment, the audit trail), the Weldone
// Ent clean-up end to end (balance 0, no fake cash), the duplicate guards
// on old-style codes, payments, credits and licences, and the rollback.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261012120000_payment_reversal_and_duplicate_guards.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261013120000_price_plans.sql', '20261014120000_vendor_delete_guard.sql', '20261015120000_rpn_commissions.sql', '20261016120000_market_publishing.sql', '20261017120000_dispatch_grv.sql', '20261018120000_supplier_grv.sql']) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p) {
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }

  // ---- live-like data ----
  const staff = {};
  for (const [k, sys, active] of [['LED', false, true], ['LED2', false, true], ['ACT', false, true], ['NONE', false, true], ['GONE', false, false], ['SYS', true, true]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, $3, now()) returning id`, ['Staff ' + k, sys, active]))[0].id;
  const mod = {};
  for (const k of ['collections_ledger', 'activation_codes', 'vendors']) mod[k] = (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [k]))[0].id;
  const grant = (s, m) => q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff[s], mod[m]]);
  await grant('LED', 'collections_ledger'); await grant('LED2', 'collections_ledger'); await grant('GONE', 'collections_ledger');
  await grant('ACT', 'activation_codes'); await grant('NONE', 'vendors');
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });
  await q(`insert into cl_activation_pricing (id, amount, currency, effective_from, created_at) values (gen_random_uuid(), 20, 'USD', now(), now())`);
  const cashAcc = (await q(`insert into cl_chart_of_accounts (id, code, name, account_type, active, created_at) values (gen_random_uuid(), '1000', 'Cash on Hand', 'asset', true, now()) returning id`))[0].id;
  const DK = crypto.randomBytes(16).toString('hex');
  const W = (await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status) values ('Weldone Ent', 'EM6P', 'p', $1, 'onboarding') returning id`, [DK]))[0].id;
  const TAG = (await q(`select public.cl_licence_tag(public.cl_licence_hash($1)) t`, [DK]))[0].t;

  // Weldone Ent as live has it: a licence charge, 7 old-style code charges, a 120 payment with its cash in
  const j = (r) => (r.e ? { e: r.e } : r.r[0].j);
  const issueOld = (k, code) => as(tok(k), `select public.cl_issue_activation_code($1::uuid, 'EM6P-C1', $2) j`, [W, code || 'ABC123']).then(j);
  const pay = (k, amount, coa) => as(tok(k), `select public.cl_record_ledger_payment(p_vendor_id=>$1::uuid, p_amount=>$2::numeric, p_currency=>'USD', p_coa_account_id=>$3::uuid) j`, [W, amount, coa || cashAcc]).then(j);
  const credit = (k, amount, reason, rev) => as(tok(k), `select public.cl_record_ledger_credit($1::uuid, $2::numeric, 'USD', $3, $4::uuid) j`, [W, amount, reason, rev || null]).then(j);
  const reverse = (k, id, reason) => as(k ? tok(k) : null, `select public.cl_reverse_ledger_payment($1::uuid, $2) j`, [id, reason == null ? 'Reversal of test payment (no cash received)' : reason]).then(j);
  const age = () => pg.exec(`update cl_ledger_entries set created_at = created_at - interval '1 minute'; update cl_activation_codes set issued_at = issued_at - interval '1 minute'; update cl_licences set issued_at = issued_at - interval '1 minute'`);
  const balance = async () => Number((await q(`select coalesce(sum(case when entry_type in ('charge','payment_reversal') then amount else -amount end), 0) b from cl_ledger_entries where vendor_id = $1`, [W]))[0].b);
  const cashNet = async () => Number((await q(`select coalesce(sum(case when direction = 'in' then amount else -amount end), 0) n from cl_cashbook_entries where coa_account_id = $1`, [cashAcc]))[0].n);

  const L1001 = (await q(`insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes) values ($1, 'charge', 20, 'USD', 'Auto-charged: licence #1001 (30 days)') returning id`, [W]))[0].id;
  console.log('before the migration: the 8 Oct bug, reproduced');
  for (let i = 0; i < 3; i++) await issueOld('ACT');          // three taps on "Log this issuance"
  ok('three identical calls today write three charges', Number((await q(`select count(*) n from cl_ledger_entries where notes = 'Auto-charged: activation code issued'`))[0].n) === 3);
  await age();
  for (let i = 0; i < 4; i++) { await issueOld('ACT', 'ABC12' + i); }
  const P = (await pay('LED', 120)).ledger_entry;
  ok('Weldone Ent as on live: 8 charges (160), a 120 payment, balance 40.00, 120 cash in', await balance() === 40 && await cashNet() === 120, [await balance(), await cashNet()]);

  await pg.exec(MIG);
  ok('the migration applies to the live shape', true);
  let again = null; try { await pg.exec(MIG); } catch (e) { again = e.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /payment_reversal aborted: already exists/.test(again || ''), again);

  console.log('reversing a payment: who may');
  let r = await reverse(null, P.id);
  ok('anonymous: refused by the grants', /permission denied/i.test(r.e || ''), r.e);
  for (const k of ['NONE', 'ACT', 'GONE']) { r = await reverse(k, P.id); ok('staff ' + k + ': Not authorized', /Not authorized/.test(r.e || ''), r.e); }
  console.log('reversing a payment: the checks');
  r = await reverse('LED', P.id, '  '); ok('no reason: refused', /reason is required/.test(r.e || ''), r.e);
  r = await reverse('LED', L1001); ok('a charge can\'t be reversed this way (use a credit)', /Only a payment/.test(r.e || ''), r.e);
  r = await reverse('LED', '00000000-0000-0000-0000-000000000000'); ok('unknown entry: refused', /No such ledger entry/.test(r.e || ''), r.e);

  console.log('the Weldone Ent clean-up, as proposed');
  const cashRows = Number((await q(`select count(*) n from cl_cashbook_entries`))[0].n);
  r = await reverse('LED', P.id);
  ok('1. reverse the 120 payment', !r.e, r.e);
  const rev = r.ledger_entry, out = r.cashbook_entry;
  ok('... a payment_reversal of 120.00 naming the payment, with the reason and who', rev && rev.entry_type === 'payment_reversal' && Number(rev.amount) === 120 && rev.reverses_entry_id === P.id && rev.recorded_by === staff.LED && /no cash received/.test(rev.notes), JSON.stringify(rev));
  ok('... 120.00 cash OUT on the account the payment\'s cash came in on (Cash on Hand)', out && out.direction === 'out' && Number(out.amount) === 120 && out.coa_account_id === cashAcc && out.source_type === 'ledger_payment_reversal' && out.source_id === rev.id, JSON.stringify(out));
  ok('... one new cash row; the Cash on Hand net for this payment is back to 0', Number((await q(`select count(*) n from cl_cashbook_entries`))[0].n) === cashRows + 1 && await cashNet() === 0, await cashNet());
  const log = (await q(`select staff_id, detail from cl_activity_log where action = 'reverse_ledger_payment'`))[0];
  ok('... logged with who, the payment, amount and reason', log && log.staff_id === staff.LED && log.detail.payment_id === P.id && Number(log.detail.amount) === 120, JSON.stringify(log));
  ok('... balance 160.00 (all 8 charges open again)', await balance() === 160, await balance());
  r = await reverse('LED', P.id);
  ok('a repeated tap by the same person within 30 s gets the same reversal back, nothing new', r.duplicate === true && r.ledger_entry.id === rev.id && Number((await q(`select count(*) n from cl_ledger_entries where entry_type = 'payment_reversal'`))[0].n) === 1, JSON.stringify(r).slice(0, 200));
  r = await reverse('LED2', P.id);
  ok('anyone else: "already reversed"', /already reversed/.test(r.e || ''), r.e);
  const charges = await q(`select id, notes from cl_ledger_entries where vendor_id = $1 and entry_type = 'charge' order by created_at`, [W]);
  for (const c of charges) {
    const isLic = c.id === L1001;
    r = await credit('LED', 20, isLic ? 'Reversal of test licence #1001 charge' : 'Reversal of test activation code charge (EM6P-C1)', c.id);
    if (r.e) ok('credit ' + c.id, false, r.e);
  }
  ok('2. a credit against each of the 8 charges (20.00 each)', Number((await q(`select count(*) n from cl_ledger_entries where entry_type = 'credit'`))[0].n) === 8);
  ok('Weldone Ent balance 0.00 and Cash on Hand shows no fake 120', await balance() === 0 && await cashNet() === 0, [await balance(), await cashNet()]);
  ok('nothing was deleted: 8 charges, 1 payment, 1 reversal, 8 credits', JSON.stringify(await q(`select entry_type, count(*)::int n from cl_ledger_entries group by 1 order by 1`)) ===
    JSON.stringify([{ entry_type: 'charge', n: 8 }, { entry_type: 'credit', n: 8 }, { entry_type: 'payment', n: 1 }, { entry_type: 'payment_reversal', n: 1 }]));

  console.log('table rules');
  r = await as(null, `select 1`); // reset
  let e = null; try { await q(`insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes) values ($1, 'payment_reversal', 1, 'USD', 'x')`, [W]); } catch (x) { e = x.message; }
  ok('a payment_reversal must name its payment', /credit_shape/.test(e || ''), e);
  e = null; try { await q(`insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes, reverses_entry_id) values ($1, 'payment_reversal', 120, 'USD', 'x', $2)`, [W, P.id]); } catch (x) { e = x.message; }
  ok('a payment can be reversed only once (unique index)', /one_reversal|duplicate key/.test(e || ''), e);

  console.log('duplicate guards (one tap = one charge)');
  await age();
  const n = async (sql, p) => Number((await q(sql, p))[0].n);
  const charges0 = await n(`select count(*) n from cl_ledger_entries where entry_type = 'charge'`);
  const a1 = await issueOld('ACT', 'ZZZ999'), a2 = await issueOld('ACT', 'ZZZ999'), a3 = await issueOld('ACT', 'ZZZ999');
  ok('old-style code: three identical calls -> one code, one charge; the repeats answer with it (duplicate: true)',
    await n(`select count(*) n from cl_ledger_entries where entry_type = 'charge'`) === charges0 + 1 && a2.duplicate === true && a3.duplicate === true &&
    a2.activation_code.id === a1.activation_code.id && a2.ledger_charge.id === a1.ledger_charge.id, JSON.stringify([a1.e, a2.e]));
  await issueOld('SYS', 'ZZZ999');
  ok('... another staff member is not a repeat (a new code and charge)', await n(`select count(*) n from cl_ledger_entries where entry_type = 'charge'`) === charges0 + 2);
  await age(); await issueOld('ACT', 'ZZZ999');
  ok('... after 30 seconds the same call is a new issuance again', await n(`select count(*) n from cl_ledger_entries where entry_type = 'charge'`) === charges0 + 3);
  const cash0 = await n(`select count(*) n from cl_cashbook_entries`);
  const p1 = await pay('LED', 50), p2 = await pay('LED', 50);
  ok('payment: two identical calls -> one ledger entry, one cash entry; the repeat answers with it',
    p2.duplicate === true && p2.ledger_entry.id === p1.ledger_entry.id && p2.cashbook_entry.id === p1.cashbook_entry.id && await n(`select count(*) n from cl_cashbook_entries`) === cash0 + 1, JSON.stringify(p2).slice(0, 200));
  await pay('LED', 51);
  ok('... a different amount is a new payment', await n(`select count(*) n from cl_cashbook_entries`) === cash0 + 2);
  const c1 = await credit('LED', 5, 'goodwill'), c2 = await credit('LED', 5, 'goodwill');
  ok('credit: two identical calls -> one credit', c2.duplicate === true && c2.ledger_entry.id === c1.ledger_entry.id && await n(`select count(*) n from cl_ledger_entries where entry_type = 'credit'`) === 9);
  const prep = (k) => as(tok(k), `select public.cl_licence_prepare(p_device_code=>$1, p_days=>30) j`, ['EM6P-' + TAG]).then(j);
  r = await prep('ACT'); ok('licence: the first issue for EM6P is prepared', !r.e && r.licences.length === 1, r.e);
  const firstSerial = r.licences && r.licences[0].serial;
  r = await prep('ACT'); ok('... a second issue for the same device within 30 s is refused: DUPLICATE_ISSUE, naming the licence', new RegExp('DUPLICATE_ISSUE: licence #' + firstSerial + ' was issued for this device').test(r.e || ''), r.e);
  r = await prep('SYS'); ok('... another staff member may (a deliberate second licence)', !r.e, r.e);
  await age(); r = await prep('ACT'); ok('... and so may the first, after 30 seconds', !r.e, r.e);

  // one business, three tills: the guard is per device, not per business
  const tills = [];
  for (let i = 1; i <= 3; i++) {
    const dk = crypto.randomBytes(16).toString('hex'), inst = 'TT0' + i;
    const v = (await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status) values ('Test Multi-till', $1, 'p', $2, 'onboarding') returning id`, [inst, dk]))[0].id;
    tills.push({ inst, v, code: inst + '-' + (await q(`select public.cl_licence_tag(public.cl_licence_hash($1)) t`, [dk]))[0].t });
  }
  const BIZ = (await q(`insert into cl_businesses (name, secret_phrase_hash, created_by_vendor_id) values ('Test Multi-till', 'x', $1) returning id`, [tills[0].v]))[0].id;
  const BR = (await q(`insert into cl_branches (business_id, name, is_main) values ($1, 'Main', true) returning id`, [BIZ]))[0].id;
  for (let i = 0; i < 3; i++) await q(`insert into cl_terminals (business_id, branch_id, vendor_id, install_id, till_code) values ($1, $2, $3, $4, $5)`, [BIZ, BR, tills[i].v, tills[i].inst, 'T' + (i + 1)]);
  const prepCode = (k, code) => as(tok(k), `select public.cl_licence_prepare(p_device_code=>$1, p_days=>30) j`, [code]).then(j);
  const prepBiz = (k) => as(tok(k), `select public.cl_licence_prepare(p_business_id=>$1::uuid, p_days=>30) j`, [BIZ]).then(j);
  const tillSerial = {};
  for (let i = 0; i < 3; i++) {
    r = await prepCode('ACT', tills[i].code);
    ok('business with three tills: T' + (i + 1) + ' (' + tills[i].inst + ') issued straight after the one before', !r.e && r.licences.length === 1 && r.licences[0].install_id === tills[i].inst, r.e);
    tillSerial[tills[i].inst] = r.licences && r.licences[0].serial;
  }
  ok('... three licences, all issued within 30 s by the same staff member', await n(`select count(*) n from cl_licences where business_id = $1 and issued_at > now() - interval '30 seconds'`, [BIZ]) === 3);
  r = await prepCode('ACT', tills[1].code);
  ok('... T2 again within 30 s is refused: DUPLICATE_ISSUE naming T2\'s licence and install', new RegExp('DUPLICATE_ISSUE: licence #' + tillSerial.TT02 + ' was issued for this device \\(TT02\\)').test(r.e || ''), r.e);
  r = await prepBiz('ACT');
  ok('... "every till of the business" within 30 s is refused too (it would sign T1 a second time), nothing written', /DUPLICATE_ISSUE: licence #\d+ was issued for this device \(TT0\d\)/.test(r.e || '') && await n(`select count(*) n from cl_licences where business_id = $1`, [BIZ]) === 3, r.e);
  await age();
  r = await prepBiz('ACT');
  ok('... after 30 s, "every till" issues all three in one call', !r.e && r.licences.length === 3, r.e);
  r = await prepCode('ACT', tills[2].code);
  ok('... and T3 straight after that is refused (same device twice)', /DUPLICATE_ISSUE: .*\(TT03\)/.test(r.e || ''), r.e);

  console.log('rollback');
  let rb = null; try { await pg.exec(RB); } catch (x) { rb = x.message; } await pg.exec('rollback').catch(() => {});
  ok('the rollback refuses while payment reversals exist, changing nothing', /rollback aborted: payment reversals exist/.test(rb || ''), rb);
  await pg.exec(`delete from cl_activity_log; delete from cl_cashbook_entries; update cl_ledger_entries set reverses_entry_id = null where entry_type = 'credit'; delete from cl_ledger_entries where entry_type in ('payment_reversal', 'credit');
           delete from cl_ledger_entries; delete from cl_licences; delete from cl_activation_codes; delete from cl_terminals; delete from cl_branches; delete from cl_businesses; delete from cl_vendors; delete from cl_activation_pricing; delete from cl_chart_of_accounts;
           delete from cl_staff_module_access; delete from cl_modules; delete from cl_staff;`);
  await pg.exec(RB);
  const after = fingerprint(await snapshot(q));
  const d = diff(before, after);
  ok('with none, the rollback restores the exact pre-migration catalogue (all four functions byte for byte)', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 500));
  await pg.exec(MIG);
  ok('and the migration applies again after a rollback', true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
