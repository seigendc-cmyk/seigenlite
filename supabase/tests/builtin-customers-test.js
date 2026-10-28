// node supabase/tests/builtin-customers-test.js
//
// Tests supabase/migrations/20261112120000_builtin_customers.sql (and its
// rollback) in an in-memory PGlite built from the repo, never the live
// database: cl_device_customer_save refuses the built-in uids (Cash Sale,
// Wholesale; owner decision 4) with BUILTIN_LOCKED and saves nothing; every
// other customer saves exactly as before; the preflight refuses a second run;
// the rollback brings back the previous function exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261112120000_builtin_customers.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = () => crypto.randomBytes(16).toString('hex');
const CASH = 'b1170000000000000000000000000001', WHOLESALE = 'b1170000000000000000000000000002';   // src/db.js BUILTIN_CUSTOMERS

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261113180000_removed_devices.sql', '20261114120000_roles_everywhere.sql', '20261115120000_stock_control.sql']) });   // live's shape, without this file
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  async function as(sql, p) {
    await pg.exec('set role anon');
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  }
  const KEY = {}; const key = (iid) => (KEY[iid] = KEY[iid] || hex());
  const PH = { AC01: 'Acme Phrase' };
  const devRaw = async (sql, p) => { const x = await as(sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };
  await devRaw(`select public.cl_branch_register($1, $2, $3, 'Acme', 'Harare', 'B-HARARE01') j`, ['AC01', PH.AC01, key('AC01')]);
  const save = async (c) => {
    const x = await as(`select public.cl_device_customer_save(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_customer=>$4::jsonb) j`,
      ['AC01', PH.AC01, key('AC01'), JSON.stringify(c)]);
    return x.e ? { raised: x.e } : x.r[0].j;
  };
  const count = async () => Number((await q('select count(*) n from cl_customers'))[0].n);

  // before: the old function would take a built-in uid like any other
  let e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('the migration applies', !e, e);
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /builtin_customers aborted: already there/.test(e || ''), e);
  const after = fingerprint(await snapshot(q));
  const d = diff(before, after);
  ok('only cl_device_customer_save changed', d.onlyA.length === 0 && d.onlyB.length === 0 && d.changed.length === 1 && /cl_device_customer_save/.test(d.changed[0].key), JSON.stringify(d));

  let r = await save({ uid: CASH, name: 'Cash Sale', phone: '0772 000 001', customer_type: 'retail' });
  ok('Cash Sale (its fixed uid) is refused: BUILTIN_LOCKED', r && r.ok === false && r.error === 'BUILTIN_LOCKED', JSON.stringify(r));
  r = await save({ uid: WHOLESALE, name: 'Wholesale', phone: '0772 000 002', customer_type: 'wholesale', credit_limit: 100 });
  ok('Wholesale (its fixed uid) is refused: BUILTIN_LOCKED', r && r.ok === false && r.error === 'BUILTIN_LOCKED', JSON.stringify(r));
  r = await save({ uid: 'b1170000000000000000000000000003', name: 'X', phone: '0772 000 003' });
  ok('a neighbouring uid is an ordinary customer', r && r.ok === true, JSON.stringify(r));
  ok('nothing of the built-in ones was saved', (await count()) === 1 && Number((await q('select count(*) n from cl_customers where customer_uid in ($1, $2)', [CASH, WHOLESALE]))[0].n) === 0);
  const C1 = hex();
  r = await save({ uid: C1, name: 'Tendai Moyo', phone: '0772 123 456', customer_type: 'wholesale', credit_limit: 500 });
  ok('an ordinary customer saves as before', r && r.ok === true && r.created === true && r.customer.uid === C1 && r.customer.phone_norm === '263772123456', JSON.stringify(r));
  r = await save({ uid: hex(), name: 'Other', phone: '0772 123 456' });
  ok('the duplicate-phone answer is unchanged', r && r.ok === false && r.error === 'DUPLICATE_PHONE', JSON.stringify(r));
  r = await save({ uid: 'short', name: 'Bad', phone: '0772 999 999' });
  ok('a bad uid still raises as before', r && /A customer needs its uid/.test(r.raised || ''), JSON.stringify(r));

  e = null; try { await pg.exec(RB); } catch (x) { e = x.message; }
  ok('the rollback applies', !e, e);
  const back = fingerprint(await snapshot(q));
  const d2 = diff(before, back);
  ok('after the rollback the catalogue is exactly as before', d2.onlyA.length === 0 && d2.onlyB.length === 0 && d2.changed.length === 0, JSON.stringify(d2));
  r = await save({ uid: CASH, name: 'Cash Sale', phone: '0772 000 001' });
  ok('after the rollback a built-in uid saves again (the old behaviour)', r && r.ok === true, JSON.stringify(r));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
