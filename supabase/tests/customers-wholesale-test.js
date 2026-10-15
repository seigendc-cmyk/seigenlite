// node supabase/tests/customers-wholesale-test.js
//
// Tests supabase/migrations/20261018180000_customers_wholesale.sql (and its
// rollback) in an in-memory PGlite built from the repo, never the live
// database: cl_norm_phone, the business's customer list (any till adds, one
// phone per business, idempotent by uid, another business can't touch it,
// the pull and its cursor, inactive tills), no API or Console access to the
// table (national ID), wholesale prices through catalogue push / pull (an
// older till's row without the key keeps it), the delete guard and the
// rollback.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261018180000_customers_wholesale.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = () => crypto.randomBytes(16).toString('hex');

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261019120000_trial_rules.sql', '20261020120000_server_time.sql', '20261021120000_billing_b.sql', '20261022120000_catalogue_merge_links.sql', '20261023120000_admin_passcode_from_main.sql', '20261023180000_update_app_first_message.sql', '20261024120000_branch_stock.sql', '20261025120000_min_app_build.sql', '20261105120000_itred_order_fulfilment.sql']) });   // the shape just before this migration (it is on live now)
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p) {
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }
  const sys = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), 'Sys', 'x', true, true, now()) returning id`))[0].id;
  const SYS = { role: 'authenticated', sub: sys, user_type: 'staff', is_sysadmin: true };

  const KEY = {}; const key = (iid) => (KEY[iid] = KEY[iid] || hex());
  const PH = {};
  const devRaw = async (sql, p) => { const x = await as(null, sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };
  PH.AC01 = PH.AC02 = PH.MU01 = 'Acme Phrase'; PH.BE01 = 'Beta Phrase';
  const acme = await devRaw(`select public.cl_branch_register($1, $2, $3, 'Acme', 'Harare', 'B-HARARE01') j`, ['AC01', PH.AC01, key('AC01')]);
  const jc = await devRaw(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>$4::uuid, p_new_branch_name=>null) j`, ['AC01', PH.AC01, key('AC01'), acme.branch_id]);
  await devRaw(`select public.cl_terminal_join($1, $2, $3, $4) j`, ['AC02', PH.AC02, key('AC02'), jc.code]);
  const jm = await devRaw(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>null, p_new_branch_name=>'Murehwa') j`, ['AC01', PH.AC01, key('AC01')]);
  await devRaw(`select public.cl_terminal_join($1, $2, $3, $4) j`, ['MU01', PH.MU01, key('MU01'), jm.code]);
  await devRaw(`select public.cl_branch_register($1, $2, $3, 'Beta', 'Gweru', 'B-GWERU001') j`, ['BE01', PH.BE01, key('BE01')]);
  // a catalogue product pushed before the migration
  const P1 = hex();
  await devRaw(`select public.cl_catalogue_push($1, $2, $3, $4::jsonb) j`, ['AC01', PH.AC01, key('AC01'), JSON.stringify([{ uid: P1, op_id: hex(), code: 'SUG2', name: 'Sugar 2kg', price: 3 }])]);

  let e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('the migration applies', !e, e);
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /customers_wholesale aborted: already there/.test(e || ''), e);

  // ---- phone numbers ----
  const norm = async (p) => (await q(`select public.cl_norm_phone($1) n`, [p]))[0].n;
  const got = await Promise.all(['0772 123 456', '+263 772 123 456', '263772123456', '00263772123456', '772123456', '(0772) 123-456'].map(norm));
  ok('07…, +263…, 263…, 00263… and 9 digits are the same number', got.every((g) => g === '263772123456'), JSON.stringify(got));
  ok('landlines, short numbers, letters and a foreign number without + are refused; +44… is accepted',
    (await norm('0242123456')) === null && (await norm('07721234')) === null && (await norm('0772x23456')) === null &&
    (await norm('447700900123')) === null && (await norm('+44 7700 900123')) === '447700900123');

  // ---- customers ----
  const call = async (iid, fn, args) => {
    const names = Object.keys(args);
    const sql = `select public.${fn}(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3${names.map((n, i) => `, ${n}=>$${i + 4}`).join('')}) j`;
    const x = await as(null, sql, [iid, PH[iid], key(iid), ...names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n])]);
    return x.e ? { raised: x.e } : x.r[0].j;
  };
  const save = (iid, c) => call(iid, 'cl_device_customer_save', { p_customer: c });
  const pull = (iid, cur) => call(iid, 'cl_device_customers_pull', { p_cursor: cur || 0 });
  const C1 = hex();
  let r = await save('MU01', { uid: C1, name: 'Tendai Moyo', phone: '0772 123 456', customer_type: 'wholesale', credit_limit: 500, address: '12 Baker St', national_id: '63-123456A12' });
  ok('any till of the business (here a remote branch) adds a customer', r.ok && r.created && r.customer.phone_norm === '263772123456' &&
    r.customer.customer_type === 'wholesale' && Number(r.customer.credit_limit) === 500 && r.customer.national_id === '63-123456A12', JSON.stringify(r));
  r = await save('AC01', { uid: C1, name: 'Tendai Moyo', phone: '+263772123456', customer_type: 'retail', credit_limit: null });
  ok('saving the same uid again updates it (no second row), and an empty limit means none', r.ok && !r.created && r.customer.customer_type === 'retail' &&
    r.customer.credit_limit === null && (await q(`select count(*)::int c from cl_customers`))[0].c === 1, JSON.stringify(r));
  r = await save('AC02', { uid: hex(), name: 'T. Moyo', phone: '00263 77 212 3456' });
  ok('the same phone again (another spelling, another till) is refused with the existing customer, to select instead', r.ok === false && r.error === 'DUPLICATE_PHONE' &&
    r.message === 'A customer with this phone already exists: Tendai Moyo.' && r.existing.uid === C1, JSON.stringify(r));
  r = await save('BE01', { uid: hex(), name: 'Tendai Moyo', phone: '0772123456' });
  ok('another business may have a customer with the same phone', r.ok === true, JSON.stringify(r));
  r = await save('BE01', { uid: C1, name: 'Stolen', phone: '0773000000' });
  ok('another business can\'t change this business\'s customer (it gets its own row)', r.ok && (await q(`select name from cl_customers where business_id = $1 and customer_uid = $2`, [acme.business_id, C1]))[0].name === 'Tendai Moyo');
  r = await save('AC01', { uid: hex(), name: 'No Phone' });
  ok('a customer needs a valid phone', /valid phone number/.test(r.raised || ''), JSON.stringify(r));
  r = await save('AC01', { uid: hex(), name: '', phone: '0771000000' });
  ok('…and a name', /needs a name/.test(r.raised || ''));
  r = await save('AC01', { uid: hex(), name: 'X', phone: '0771000001', customer_type: 'vip' });
  ok('…and type retail or wholesale', /retail or wholesale/.test(r.raised || ''));
  r = await as(null, `select public.cl_device_customer_save('NOPE', 'x', 'y', '{}'::jsonb) j`);
  ok('an unregistered device can\'t save customers', /not registered/.test(r.e || ''), r.e);

  r = await pull('AC02');
  ok('every till of the business pulls the list, its own business only, national ID included', r.customers.length === 1 && r.customers[0].uid === C1 &&
    r.customers[0].address === null && r.more === false, JSON.stringify(r));
  const cur1 = r.cursor;
  r = await pull('AC02', cur1);
  ok('the cursor gives only what changed since', r.customers.length === 0 && r.cursor === cur1);
  await save('AC01', { uid: C1, name: 'Tendai Moyo', phone: '0772123456', national_id: '63-123456A12' });
  r = await pull('AC02', cur1);
  ok('…an update comes again', r.customers.length === 1 && r.customers[0].national_id === '63-123456A12');

  const term = (await q(`select id from cl_terminals where install_id = 'AC02'`))[0].id;
  await q(`update cl_terminals set active = false where id = $1`, [term]);
  r = await pull('AC02');
  ok('a deactivated till gets nothing', r.error === 'TERMINAL_INACTIVE');
  await q(`update cl_terminals set active = true where id = $1`, [term]);

  // ---- privacy: no API, no Console ----
  for (const c of [null, SYS]) {
    const x = await as(c, `select count(*) from cl_customers`);
    ok((c ? 'staff (SysAdmin)' : 'anon') + ' can\'t read cl_customers through the API', /permission denied/.test(x.e || ''), x.e);
  }
  const fns = (await q(`select p.proname, pg_get_functiondef(p.oid) d from pg_proc p where p.pronamespace = 'public'::regnamespace`))
    .filter((f) => /cl_customers/.test(f.d)).map((f) => f.proname).sort();
  ok('only the tills\' own functions (and the delete guard) read cl_customers: no Console function returns the national ID',
    JSON.stringify(fns) === JSON.stringify(['cl_business_delete_guard', 'cl_customer_json', 'cl_device_customer_save', 'cl_device_customers_pull']), JSON.stringify(fns));

  // ---- wholesale prices through the catalogue ----
  const push = (iid, rows) => call(iid, 'cl_catalogue_push', { p_rows: rows });
  const pullCat = (iid) => call(iid, 'cl_catalogue_pull', { p_cursor: 0, p_limit: 500 });
  r = await push('AC01', [{ uid: P1, op_id: hex(), code: 'SUG2', name: 'Sugar 2kg', price: 3, wholesale_price: 2.6 }]);
  ok('main pushes a wholesale price', r.results[0].status === 'applied', JSON.stringify(r));
  r = await pullCat('MU01');
  ok('every till pulls it with the product', r.products.find((p) => p.uid === P1).wholesale_price === 2.6, JSON.stringify(r.products));
  r = await push('AC01', [{ uid: P1, op_id: hex(), code: 'SUG2', name: 'Sugar 2kg', price: 3.1 }]);
  ok('an older till\'s row without the key keeps the stored wholesale price', r.results[0].status === 'applied' &&
    Number((await q(`select wholesale_price from cl_catalogue_products where product_uid = $1`, [P1]))[0].wholesale_price) === 2.6);
  r = await push('AC01', [{ uid: P1, op_id: hex(), code: 'SUG2', name: 'Sugar 2kg', price: 3.1, wholesale_price: null }]);
  ok('an explicit null clears it (retail applies again)', (await q(`select wholesale_price from cl_catalogue_products where product_uid = $1`, [P1]))[0].wholesale_price === null);
  r = await push('AC01', [{ uid: P1, op_id: hex(), code: 'SUG2', name: 'Sugar 2kg', price: 3.1, wholesale_price: -1 }]);
  ok('a negative wholesale price is refused', r.results[0].status === 'refused', JSON.stringify(r));
  r = await push('MU01', [{ uid: P1, op_id: hex(), code: 'SUG2', name: 'Sugar 2kg', price: 1, wholesale_price: 0.5 }]);
  ok('only the main branch pushes the catalogue (unchanged)', r.error === 'NOT_MAIN');
  await push('AC01', [{ uid: P1, op_id: hex(), code: 'SUG2', name: 'Sugar 2kg', price: 3.1, wholesale_price: 2.75 }]);

  // ---- delete guard ----
  e = null; try { await q(`delete from cl_businesses where id = $1`, [acme.business_id]); } catch (y) { e = y.message; }
  ok('the business delete guard counts customers', /customer/.test(e || ''), e);

  // ---- rollback ----
  e = null; try { await pg.exec(RB); } catch (y) { e = y.message; } await pg.exec('rollback').catch(() => {});
  ok('the rollback refuses while customers or wholesale prices exist', /customers or wholesale prices exist/.test(e || ''), e);
  await q(`delete from cl_customers`); await q(`update cl_catalogue_products set wholesale_price = null`);
  e = null; try { await pg.exec(RB); } catch (y) { e = y.message; }
  ok('without them the rollback runs', !e, e);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('…and restores the exact catalogue', d.onlyA.length === 0 && d.onlyB.length === 0 && d.changed.length === 0, JSON.stringify(d).slice(0, 800));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
