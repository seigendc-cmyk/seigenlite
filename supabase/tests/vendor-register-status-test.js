// node supabase/tests/vendor-register-status-test.js
//
// Tests supabase/migrations/20261116120000_vendor_register_status.sql (and
// its rollback) in PGlite built in the live shape, never the live database:
// the Vendors Register's Registration facts (no till; active tills, with
// deactivated ones and Office seats counted apart; every till deactivated)
// and Licence facts (paid licence current to its last day, Harare; the
// earliest of several; an expired one; revoked ignored; a running trial; a
// trial that ended today; nothing yet; overdue = a positive Collections
// Ledger balance in any currency, the business's rows together), who may
// call it, that it returns facts only (no amounts or names), that it writes
// nothing (cl_vendors.status untouched), and the rollback.
'use strict';
const path = require('path');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261116120000_vendor_register_status.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const J = (x) => JSON.stringify(x);

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE]) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p) {
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }

  let e = null; try { await pg.exec(MIG); } catch (y) { e = y.message; }
  ok('the migration applies on the live shape', !e, e);
  e = null; try { await pg.exec(MIG); } catch (y) { e = y.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run stops in the preflight, changing nothing', /already there: function cl_vendor_register_status/.test(e || ''), e);

  // ---- staff ----
  const staff = {};
  for (const [k, sys, active] of [['SYS', true, true], ['VEN', false, true], ['ACT', false, true], ['LED', false, true], ['BIL', false, true], ['NONE', false, true], ['GONE', false, false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, $3, now()) returning id`, ['Staff ' + k, sys, active]))[0].id;
  const mod = {};
  for (const k of ['vendors', 'activation_codes', 'collections_ledger', 'billing_reminders', 'cashbook'])
    mod[k] = (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) on conflict (key) do update set label = excluded.label returning id`, [k]))[0].id;
  const grant = (s, m) => q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff[s], mod[m]]);
  await grant('VEN', 'vendors'); await grant('ACT', 'activation_codes'); await grant('LED', 'collections_ledger');
  await grant('BIL', 'billing_reminders'); await grant('NONE', 'cashbook'); await grant('GONE', 'vendors');
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });

  // ---- records, written straight into the tables (no triggers: fixtures only) ----
  await q(`set session_replication_role = replica`);
  const T = `(now() at time zone 'Africa/Harare')::date`;
  const V = {};
  const vendor = async (k, iid) => { V[k] = (await q(`insert into cl_vendors (id, business_name, status, created_at, install_id, lock_cart, lock_add_product)
      values (gen_random_uuid(), $1, 'onboarding', now(), $2, false, false) returning id`, ['Shop ' + k, iid]))[0].id; return V[k]; };
  const B = {}, BR = {};
  const business = async (k, creator) => {
    B[k] = (await q(`insert into cl_businesses (name, secret_phrase_hash, created_by_vendor_id) values ($1, 'x', $2) returning id`, ['Biz ' + k, V[creator]]))[0].id;
    BR[k] = (await q(`insert into cl_branches (business_id, name, is_main) values ($1, 'Main', true) returning id`, [B[k]]))[0].id;
    await q(`update cl_vendors set business_id = $1 where id = $2`, [B[k], V[creator]]);
  };
  let n = 0;
  const device = async (bk, vk, iid, active, kind, approval) => {
    n++;
    await q(`insert into cl_terminals (business_id, branch_id, vendor_id, install_id, till_code, active, device_kind, approval_status)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`, [B[bk], BR[bk], V[vk], iid, (kind === 'seat' ? 'S' : 'T') + n, active, kind || 'till', approval || 'approved']);
    await q(`update cl_vendors set business_id = $1 where id = $2`, [B[bk], V[vk]]);
  };
  let h = 0;
  const licence = (vk, iid, bk, validTo, status, kind) => q(`insert into cl_licences (key_id, install_id, device_tag, binding, strong_binding, days, valid_from, valid_to, payload,
      short_code_hash, issued_by, status, vendor_id, business_id, kind) values (1, $1, 'AAAA', '\\x0000000000000000', true, 30, ${T} + $2::int - 30, ${T} + $2::int, '\\x', $3, $4, $5, $6, $7, $8)`,
    [iid, validTo, 'h' + (++h), staff.SYS, status || 'redeemed', V[vk], bk ? B[bk] : null, kind || 'paid']);
  const trial = (vk, iid, bk, endsIn) => q(`insert into cl_trials (kind, phone_norm, vendor_id, install_id, business_id, started_on, ends_on)
      values ('standard', $1, $2, $3, $4, ${T} + $5::int - 30, ${T} + $5::int)`, ['26377' + (++h), V[vk], iid, bk ? B[bk] : null, endsIn]);
  const ledger = async (vk, type, amount, cur, reverses) => (await q(`insert into cl_ledger_entries (id, vendor_id, entry_type, amount, currency, created_at, notes, reverses_entry_id)
      values (gen_random_uuid(), $1, $2, $3, $4, now(), 'test', $5) returning id`, [V[vk], type, amount, cur || 'USD', reverses || null]))[0].id;

  // "+ New vendor" in the Console: no install, no device yet
  await vendor('NEW', null);
  // a device that checked in but never registered on seiGEN, on a running trial
  await vendor('SOLO', 'SOLO1'); await trial('SOLO', 'SOLO1', null, 10);
  // a business: 3 active tills, 1 deactivated, an approved seat and a pending one
  for (const [k, iid] of [['A1', 'AAA1'], ['A2', 'AAA2'], ['A3', 'AAA3'], ['A4', 'AAA4'], ['AS', 'AAS1'], ['AP', 'AAP1']]) await vendor(k, iid);
  await business('A', 'A1');
  await device('A', 'A1', 'AAA1', true); await device('A', 'A2', 'AAA2', true); await device('A', 'A3', 'AAA3', true); await device('A', 'A4', 'AAA4', false);
  await device('A', 'AS', 'AAS1', true, 'seat'); await device('A', 'AP', 'AAP1', true, 'seat', 'pending');
  await licence('A1', 'AAA1', 'A', 20); await licence('A1', 'AAA1', 'A', -40);        // its latest counts
  await licence('A2', 'AAA2', 'A', 5, 'issued');
  await licence('A3', 'AAA3', 'A', -3);                                                // this till's licence ran out
  await licence('A4', 'AAA4', 'A', 100);                                               // a deactivated till's: not judged
  await trial('A1', 'AAA1', 'A', -60);
  await ledger('A1', 'charge', 20); await ledger('A2', 'payment', 20);               // paid up across the business
  // a business whose every till is deactivated, with an old licence and money owed
  await vendor('B1', 'BBB1'); await vendor('B2', 'BBB2'); await business('B', 'B1');
  await device('B', 'B1', 'BBB1', false); await device('B', 'B2', 'BBB2', false);
  await licence('B1', 'BBB1', 'B', -10);
  await ledger('B2', 'charge', 5, 'ZWG');
  // a business on a trial that ended today, with a revoked paid licence and a trial-kind licence
  await vendor('C1', 'CCC1'); await business('C', 'C1'); await device('C', 'C1', 'CCC1', true);
  await trial('C1', 'CCC1', 'C', 0);
  await licence('C1', 'CCC1', 'C', 30, 'revoked');
  await q(`insert into cl_licences (key_id, install_id, device_tag, binding, strong_binding, days, valid_from, valid_to, payload, short_code_hash, status, vendor_id, business_id, kind, trial_id)
    select 1, 'CCC1', 'AAAA', '\\x0000000000000000', true, 30, ${T} - 10, ${T} + 20, '\\x', 'htrial', 'redeemed', $1, $2, 'trial', t.id from cl_trials t where t.install_id = 'CCC1'`, [V.C1, B.C]);
  await ledger('C1', 'charge', 10); await ledger('C1', 'credit', 10);
  // a business whose licence's last day is today; a payment later reversed
  await vendor('D1', 'DDD1'); await business('D', 'D1'); await device('D', 'D1', 'DDD1', true);
  await licence('D1', 'DDD1', 'D', 0);
  await ledger('D1', 'charge', 5); await ledger('D1', 'payment_reversal', 5, 'USD', await ledger('D1', 'payment', 5));
  // registered, nothing yet
  await vendor('E1', 'EEE1'); await business('E', 'E1'); await device('E', 'E1', 'EEE1', true);
  await q(`set session_replication_role = origin`);
  const statusBefore = J(await q(`select id, status from cl_vendors order by id`));

  // ---- who may call it ----
  for (const k of ['SYS', 'VEN', 'ACT', 'LED', 'BIL']) {
    const x = await as(tok(k), `select public.cl_vendor_register_status() j`);
    ok(k + ' may read it', !x.e && Array.isArray(x.r[0].j), x.e);
  }
  for (const [name, claims] of [['staff without an account module', tok('NONE')], ['switched-off staff', tok('GONE')],
    ['an RPN', { role: 'authenticated', sub: staff.VEN, user_type: 'rpn' }], ['a device (anon)', null]]) {
    const x = await as(claims, `select public.cl_vendor_register_status() j`);
    ok(name + ' is refused', /Not authorized|permission denied/.test(x.e || ''), x.e || 'allowed');
  }
  const x = await as(tok('VEN'), `select public.cl_vendor_register_status() j`);
  const rows = x.r[0].j, by = {};
  rows.forEach((r) => { by[r.vendor_id] = r; });
  const of = (k) => by[V[k]] || {};
  ok('one row per vendor row', rows.length === Object.keys(V).length, rows.length);
  const KEYS = ['vendor_id', 'created_at', 'business_id', 'tills_active', 'tills_deactivated', 'seats_active', 'licence_units', 'licence_current',
    'paid_valid_to', 'paid_last_valid_to', 'trial_ends_on', 'trial_running', 'overdue'];
  ok('facts only: exactly these fields (no amounts, names or phrases)', rows.every((r) => J(Object.keys(r).sort()) === J(KEYS.slice().sort())), J(Object.keys(rows[0])));
  const today = (await q(`select ${T}::text d`))[0].d;
  const day = async (k) => (await q(`select (${T} + $1::int)::text d`, [k]))[0].d;

  // ---- Registration ----
  const reg = (r) => [r.tills_active, r.tills_deactivated, r.seats_active].join('/');
  ok('"+ New vendor", no device: no till (Not registered)', reg(of('NEW')) === '0/0/0' && of('NEW').business_id === null, J(of('NEW')));
  ok('checked in, never registered: no till (Not registered)', reg(of('SOLO')) === '0/0/0', J(of('SOLO')));
  ok('mixed: 3 active tills, 1 deactivated, 1 approved seat (the pending one not counted)', reg(of('A1')) === '3/1/1', reg(of('A1')));
  ok('every row of the business gives the same answer (a deactivated till\'s row and a seat\'s too)',
    ['A2', 'A3', 'A4', 'AS', 'AP'].every((k) => reg(of(k)) === '3/1/1' && of(k).business_id === B.A));
  ok('every till deactivated', reg(of('B1')) === '0/2/0' && reg(of('B2')) === '0/2/0', reg(of('B1')));

  // ---- Licence ----
  const A = of('A1');
  ok('judged on the active tills: 3 units, 2 current (one ran out; the deactivated till\'s is ignored)', A.licence_units === 3 && A.licence_current === 2, J(A));
  ok('valid to = the earliest of the current ones (the next to run out)', A.paid_valid_to === await day(5), A.paid_valid_to);
  ok('the latest paid licence of the business, the deactivated till\'s too', A.paid_last_valid_to === await day(100), A.paid_last_valid_to);
  ok('an old trial of the business is there, ended', A.trial_ends_on === await day(-60) && A.trial_running === false, J(A));
  ok('paid up across the business: not overdue (a charge on one till, the payment on another)', A.overdue === false);
  const Bz = of('B2');
  ok('every till deactivated: judged on all tills, none current, the last licence ended 10 days ago', Bz.licence_units === 2 && Bz.licence_current === 0 && Bz.paid_last_valid_to === await day(-10), J(Bz));
  ok('money owed in ZiG on another till of the business: overdue', Bz.overdue === true && of('B1').overdue === true);
  const C = of('C1');
  ok('a trial whose ends_on is today has ended (as the Trials list: ends_on > today)', C.trial_ends_on === today && C.trial_running === false, J(C));
  ok('a revoked paid licence and a trial licence don\'t count as paid', C.licence_current === 0 && C.paid_last_valid_to === null, J(C));
  ok('a charge fully credited: not overdue', C.overdue === false);
  const D = of('D1');
  ok('a licence whose last day is today is still current', D.licence_current === 1 && D.paid_valid_to === today, J(D));
  ok('a reversed payment brings the charge back: overdue', D.overdue === true);
  ok('a running trial, not registered: judged on its own install', of('SOLO').trial_running === true && of('SOLO').trial_ends_on === await day(10) && of('SOLO').licence_units === 1, J(of('SOLO')));
  ok('"+ New vendor": nothing at all', of('NEW').licence_units === 0 && of('NEW').licence_current === 0 && of('NEW').paid_last_valid_to === null && of('NEW').trial_ends_on === null && of('NEW').overdue === false, J(of('NEW')));
  ok('registered, nothing yet', of('E1').licence_units === 1 && of('E1').licence_current === 0 && of('E1').paid_last_valid_to === null && of('E1').trial_ends_on === null, J(of('E1')));

  // ---- writes nothing ----
  ok('cl_vendors.status is untouched (every row still as it was)', J(await q(`select id, status from cl_vendors order by id`)) === statusBefore);
  const fn = (await q(`select provolatile v, prosecdef s from pg_proc where proname = 'cl_vendor_register_status'`))[0];
  ok('the function is STABLE (can\'t write) and security definer', fn.v === 's' && fn.s === true, J(fn));
  const grants = (await q(`select grantee, privilege_type from information_schema.routine_privileges where routine_name = 'cl_vendor_register_status' order by grantee`)).map((r) => r.grantee);
  ok('callable by authenticated only (not anon or public)', grants.includes('authenticated') && !grants.includes('anon') && !grants.includes('PUBLIC'), J(grants));
  const after = fingerprint(await snapshot(q));
  const d1 = diff(before, after);
  ok('the migration adds exactly the function and its grant', !d1.onlyA.length && !d1.changed.length && d1.onlyB.every((k) => /cl_vendor_register_status/.test(k)) && d1.onlyB.length >= 1, J(d1).slice(0, 600));

  // ---- rollback ----
  await pg.exec(RB);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('the rollback restores the exact pre-migration catalogue', !d.onlyA.length && !d.onlyB.length && !d.changed.length, J(d).slice(0, 600));
  e = null; try { await pg.exec(MIG); } catch (y) { e = y.message; }
  ok('the migration applies again after a rollback', !e, e);

  console.log((fail ? 'FAILED ' : 'PASSED ') + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
