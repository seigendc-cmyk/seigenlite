// node supabase/tests/supplier-grv-test.js
//
// Tests supabase/migrations/20261018120000_supplier_grv.sql (and its
// rollback) in an in-memory PGlite built from the repo (20261017120000
// included), never the live database: the supplier list (main-branch tills
// only, one name per business, idempotent), the supplier GRV (main branch
// only, invoice required, the same invoice twice refused whatever its
// spelling, never twice by uid, GRV numbers per till, delivery cost, price
// changes recorded), the invoice check, the pull (suppliers + this till's own
// GRVs + its highest GRV number), the read-only Console list, grants, the
// delete guard, and the rollback.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261018120000_supplier_grv.sql';
const B1 = '20261017120000_dispatch_grv.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const uuid = () => crypto.randomUUID();

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f) => f !== B1).concat([FILE]) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p) {
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }
  const staff = {};
  for (const [k, sys] of [['SYS', true], ['DSP', false], ['NONE', false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, true, now()) returning id`, ['Staff ' + k, sys]))[0].id;
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) select $1, id, now() from cl_modules where key = 'dispatches'`, [staff.DSP]);

  const KEY = {}; const key = (iid) => (KEY[iid] = KEY[iid] || crypto.randomBytes(16).toString('hex'));
  const devRaw = async (sql, p) => { const x = await as(null, sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };
  const AP = 'Acme Phrase', BP = 'Beta Phrase';
  const acme = await devRaw(`select public.cl_branch_register($1, $2, $3, 'Acme', 'Harare', 'B-HARARE01') j`, ['AC01', AP, key('AC01')]);
  const c2 = await devRaw(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>$4::uuid, p_new_branch_name=>null) j`, ['AC01', AP, key('AC01'), acme.branch_id]);
  await devRaw(`select public.cl_terminal_join($1, $2, $3, $4) j`, ['AC02', AP, key('AC02'), c2.code]);
  const c3 = await devRaw(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>null, p_new_branch_name=>'Murehwa') j`, ['AC01', AP, key('AC01')]);
  await devRaw(`select public.cl_terminal_join($1, $2, $3, $4) j`, ['MU01', AP, key('MU01'), c3.code]);
  await devRaw(`select public.cl_branch_register($1, $2, $3, 'Beta', 'Gweru', 'B-GWERU001') j`, ['BE01', BP, key('BE01')]);
  const PH = { AC01: AP, AC02: AP, MU01: AP, BE01: BP };

  let e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('the migration applies (after 20261017120000)', !e, e);
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /supplier_grv aborted: already there/.test(e || ''), e);

  const call = async (iid, fn, args) => {
    const names = Object.keys(args);
    const sql = `select public.${fn}(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3${names.map((n, i) => `, ${n}=>$${i + 4}`).join('')}) j`;
    const x = await as(null, sql, [iid, PH[iid], key(iid), ...names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n])]);
    return x.e ? { raised: x.e } : x.r[0].j;
  };
  const save = (iid, s) => call(iid, 'cl_device_supplier_save', { p_supplier: s });
  const post = (iid, g) => call(iid, 'cl_device_supplier_grv_post', { p_grv: g });

  // ---- suppliers ----
  const S1 = uuid();
  let r = await save('AC01', { id: S1, name: 'Metro Wholesalers', phone: '0771 000 111' });
  ok('a main-branch till adds a supplier', r.ok && r.supplier.name === 'Metro Wholesalers', JSON.stringify(r));
  r = await save('AC01', { id: S1, name: 'Metro Wholesalers', phone: '0771 000 222' });
  ok('saving it again updates it (idempotent by id)', r.ok && r.supplier.phone === '0771 000 222' && (await q(`select count(*)::int c from cl_suppliers`))[0].c === 1);
  r = await save('AC02', { id: uuid(), name: ' metro wholesalers ' });
  ok('the same name twice in a business is refused (case and spaces ignored)', r.error === 'DUPLICATE_SUPPLIER' && /already in the supplier list/.test(r.message), JSON.stringify(r));
  r = await save('MU01', { id: uuid(), name: 'Local Farm' });
  ok('a remote branch can\'t keep suppliers', r.error === 'MAIN_ONLY', JSON.stringify(r));
  r = await save('BE01', { id: uuid(), name: 'Metro Wholesalers' });
  ok('another business may have its own "Metro Wholesalers"', r.ok === true, JSON.stringify(r));
  r = await save('BE01', { id: S1, name: 'Stolen' });
  ok('another business can\'t change this business\'s supplier', /belongs to another business/.test(r.raised || ''), JSON.stringify(r));
  r = await call('MU01', 'cl_device_suppliers_pull', {});
  ok('every till of the business pulls the list (only its business\'s)', r.suppliers.length === 1 && r.suppliers[0].id === S1, JSON.stringify(r));

  // ---- supplier GRV ----
  const G1 = uuid();
  const g1 = { id: G1, supplier_id: S1, invoice_no: 'INV-123', grv_no: 4, grv_display: 'GRV-T1-0004', received_by: 'Rudo', created_iso: '2026-10-09T10:00:00+02:00',
    delivery: { cost: 10, currency: 'usd' }, note: 'two boxes',
    lines: [{ cat_uid: 'cat-sugar', code: 'SUG2', name: 'Sugar 2kg', qty: 20, unit_cost: 1.4, landed_cost: 1.6, old_price: 3, new_price: 3.2, price_by: 'Boss' },
            { code: 'RIC5', name: 'Rice 5kg', qty: 10, unit_cost: 4, landed_cost: 4.6 }] };
  r = await post('MU01', g1);
  ok('a remote branch can\'t receive from a supplier', r.error === 'MAIN_ONLY', JSON.stringify(r));
  r = await post('AC01', Object.assign({}, g1, { invoice_no: '  ' }));
  ok('the invoice number is required', /invoice number/.test(r.raised || ''), JSON.stringify(r));
  r = await post('AC01', Object.assign({}, g1, { supplier_id: uuid() }));
  ok('a supplier not in the list is refused', r.error === 'NO_SUCH_SUPPLIER', JSON.stringify(r));
  r = await post('AC01', Object.assign({}, g1, { delivery: { cost: 10 } }));
  ok('a delivery cost without its currency is refused', /needs its currency/.test(r.raised || ''), JSON.stringify(r));
  r = await post('AC01', Object.assign({}, g1, { lines: [{ name: 'X', qty: 1 }] }));
  ok('a line without its unit cost is refused', /give the unit cost/.test(r.raised || ''), JSON.stringify(r));
  r = await post('AC01', g1);
  ok('the main branch posts the supplier GRV: lines, landed cost, the price change and who made it', r.ok && r.grv.supplier === 'Metro Wholesalers' && r.grv.lines.length === 2 &&
    Number(r.grv.lines[0].landed_cost) === 1.6 && Number(r.grv.lines[0].new_price) === 3.2 && r.grv.lines[0].price_by === 'Boss' && r.grv.lines[1].price_by === null &&
    r.grv.delivery_currency === 'USD' && r.grv.till === 'T1', JSON.stringify(r).slice(0, 400));
  r = await post('AC01', g1);
  ok('posting it again answers "already"', r.ok && r.already === true && (await q(`select count(*)::int c from cl_supplier_grvs`))[0].c === 1);
  r = await post('AC02', Object.assign({}, g1, { id: uuid(), invoice_no: 'inv 123', grv_no: 1, grv_display: 'GRV-T2-0001' }));
  ok('the same invoice again (another till, another spelling) is refused with the plain message', r.error === 'DUPLICATE_INVOICE' &&
    /^Invoice INV-123 from Metro Wholesalers was already received as GRV-T1-0004 on \d\d \w{3} 2026\. Nothing was added\.$/.test(r.message), JSON.stringify(r));
  r = await post('AC02', g1);
  ok('another till sending the same GRV id is refused', /belongs to another till/.test(r.raised || ''), JSON.stringify(r));
  r = await post('AC01', Object.assign({}, g1, { id: uuid(), invoice_no: 'INV-124' }));
  ok('a GRV number already used by this till is refused', r.error === 'GRV_NUMBER_USED', JSON.stringify(r));
  r = await post('AC01', Object.assign({}, g1, { id: uuid(), invoice_no: 'INV-124', grv_no: 5, grv_display: 'GRV-T1-0005', delivery: {} }));
  ok('a new invoice from the same supplier is fine', r.ok === true, JSON.stringify(r));
  r = await call('AC02', 'cl_device_supplier_invoice_check', { p_supplier_id: S1, p_invoice_no: 'INV/123' });
  ok('the invoice check finds an invoice already received', r.found === true && r.grv_display === 'GRV-T1-0004' && r.till === 'T1', JSON.stringify(r));
  r = await call('AC02', 'cl_device_supplier_invoice_check', { p_supplier_id: S1, p_invoice_no: 'INV-999' });
  ok('…and not one that isn\'t', r.found === false);
  r = await call('AC01', 'cl_device_suppliers_pull', {});
  ok('the pull gives the till its own supplier GRVs and its highest GRV number', r.my_grvs.length === 2 && r.max_grv_no === 5, JSON.stringify(r).slice(0, 300));
  r = await call('AC02', 'cl_device_suppliers_pull', {});
  ok('…and not another till\'s', r.my_grvs.length === 0);

  // ---- Console ----
  let x = await as(tok('NONE'), `select public.cl_supplier_grvs_list(null, null) j`);
  ok('staff without the Dispatches module can\'t list supplier GRVs', /Not authorized/.test(x.e || ''), x.e);
  x = await as(tok('DSP'), `select public.cl_supplier_grvs_list(null, null) j`);
  ok('staff with it see them, with the value at cost', x.r && x.r[0].j.length === 2 && Number(x.r[0].j.find((g) => g.id === G1).value) === 68 && x.r[0].j[0].business === 'Acme', JSON.stringify(x).slice(0, 300));

  // ---- grants ----
  for (const t of ['cl_suppliers', 'cl_supplier_grvs', 'cl_supplier_grv_lines']) {
    const a = await as(null, `select count(*) from ${t}`), b = await as(tok('SYS'), `select count(*) from ${t}`);
    ok(t + ': no API access', /permission denied/.test(a.e || '') && /permission denied/.test(b.e || ''));
  }
  x = await as(null, `select public.cl_supplier_grv_json($1) j`, [G1]);
  ok('the helpers can\'t be called from the API', /permission denied/.test(x.e || ''), x.e);

  // ---- delete guard ----
  e = null; try { await q(`delete from cl_businesses where name = 'Acme'`); } catch (y) { e = y.message; }
  ok('the business delete guard counts suppliers and supplier GRVs', /1 supplier, 2 supplier GRVs/.test(e || ''), e);

  // ---- rollback ----
  e = null; try { await pg.exec(RB); } catch (y) { e = y.message; } await pg.exec('rollback').catch(() => {});
  ok('the rollback refuses while supplier GRVs exist', /rollback aborted: supplier GRVs exist/.test(e || ''), e);
  await q(`delete from cl_supplier_grvs`);
  await pg.exec(RB);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('with none, the rollback restores the exact pre-migration catalogue', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  e = null; try { await pg.exec(MIG); } catch (y) { e = y.message; }
  ok('and the migration applies again after a rollback', !e, e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
