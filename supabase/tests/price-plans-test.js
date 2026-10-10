// node supabase/tests/price-plans-test.js
//
// Tests supabase/migrations/20261013120000_price_plans.sql (and its
// rollback) in an in-memory PGlite built from the repo in the live shape,
// never the live database: every role and plan price, 30/90/365 days,
// the price snapshot (unchanged by a later price edit, can't be edited),
// the Lite branch limit (join codes, joins, licences), upgrade and
// downgrade, "not set" = Business, one price everywhere (quote = licence =
// charge = accounts list), old-style codes, the duplicate guards, who may
// do what, records issued before plans left alone, and the rollback.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261013120000_price_plans.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261014120000_vendor_delete_guard.sql', '20261015120000_rpn_commissions.sql', '20261016120000_market_publishing.sql', '20261017120000_dispatch_grv.sql', '20261018120000_supplier_grv.sql']) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p) {
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }
  const j = (r) => (r.e ? { e: r.e } : r.r[0].j);

  // ---- staff, modules ----
  const staff = {};
  for (const [k, sys, active] of [['SYS', true, true], ['VEN', false, true], ['ACT', false, true], ['LED', false, true], ['NONE', false, true], ['GONE', false, false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, $3, now()) returning id`, ['Staff ' + k, sys, active]))[0].id;
  const mod = {};
  for (const k of ['vendors', 'activation_codes', 'collections_ledger', 'cashbook']) mod[k] = (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [k]))[0].id;
  const grant = (s, m) => q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff[s], mod[m]]);
  await grant('VEN', 'vendors'); await grant('ACT', 'activation_codes'); await grant('LED', 'collections_ledger'); await grant('NONE', 'cashbook'); await grant('GONE', 'vendors');
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });
  await q(`insert into cl_activation_pricing (id, amount, currency, effective_from, created_at) values (gen_random_uuid(), 20, 'USD', now(), now())`);

  // ---- devices and businesses, through the device RPCs ----
  const KEY = {}; const key = (iid) => (KEY[iid] = KEY[iid] || crypto.randomBytes(16).toString('hex'));
  const dev = async (sql, p) => { const x = await as(null, sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };
  const devTry = (sql, p) => as(null, sql, p).then(j);
  const register = (iid, ph, biz, branch) => dev(`select public.cl_branch_register($1, $2, $3, $4, $5) j`, [iid, ph, key(iid), biz, branch]);
  const codeFor = (mainIid, ph, o) => devTry(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>$4::uuid, p_new_branch_name=>$5) j`,
    [mainIid, ph, key(mainIid), o.branchId || null, o.newName || null]);
  const join = (iid, ph, code) => devTry(`select public.cl_terminal_join($1, $2, $3, $4) j`, [iid, ph, key(iid), code]);
  const setActive = (byIid, ph, terminalId, active) => dev(`select public.cl_terminal_set_active($1, $2, $3, $4::uuid, $5) j`, [byIid, ph, key(byIid), terminalId, active]);
  async function joinNew(mainIid, ph, iid, o) { const c = await codeFor(mainIid, ph, o); if (c.e) throw new Error(c.e); const r = await join(iid, ph, c.code); if (r.e || r.error) throw new Error(r.e || r.error); return r; }
  const tagOf = async (iid) => (await q(`select public.cl_licence_tag(public.cl_licence_hash($1)) t`, [key(iid)]))[0].t;
  const vendorOf = async (iid) => (await q(`select id from cl_vendors where install_id = $1`, [iid]))[0].id;

  // Acme (Business): main Harare T1, T2; branch Mutare T1; branch Gweru T1, T2  -> 15 + 3 + 7 + 7 + 3 = 35
  const AP = 'Acme Phrase';
  const acme = await register('AC01', AP, 'Acme', 'Harare');
  await joinNew('AC01', AP, 'AC02', { branchId: acme.branch_id });
  await joinNew('AC01', AP, 'AC03', { newName: 'Mutare' });
  const gw = await joinNew('AC01', AP, 'AC04', { newName: 'Gweru' });
  await joinNew('AC01', AP, 'AC05', { branchId: gw.branch_id });
  // Knix: main T1 (deactivated), T2, T3, T4  -> T2 is the main till: 15 + 3 + 3 = 21
  const KP = 'Knix Phrase';
  const knix = await register('KN01', KP, 'Knix', 'Harare');
  for (const i of ['KN02', 'KN03', 'KN04']) await joinNew('KN01', KP, i, { branchId: knix.branch_id });
  await setActive('KN02', KP, knix.terminal_id, false);
  // Tuck (to be Lite): main T1, T2  -> 6 + 3 = 9
  const TP = 'Tuck Phrase';
  const tuck = await register('TU01', TP, 'Tuck', 'Canteen');
  await joinNew('TU01', TP, 'TU02', { branchId: tuck.branch_id });
  // Solo: one unregistered device; Pre: unregistered, will be put on Lite and then register
  for (const [iid, name, ph] of [['SO01', 'Solo', 'Solo Phrase'], ['PRE1', 'Pre', 'Pre Phrase']])
    await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status) values ($1, $2, $3, $4, 'onboarding')`, [name, iid, ph, key(iid)]);

  // ---- before the migration: a licence and an old code at the flat USD 20, and a licence prepared but not signed ----
  const SIG = 'ab'.repeat(64);
  const prepare = (k, code, days, business) => as(tok(k), `select public.cl_licence_prepare(p_device_code=>$1, p_business_id=>$2::uuid, p_days=>$3) j`, [code || null, business || null, days || 30]).then(j);
  const attach = (k, serial) => as(tok(k), `select public.cl_licence_attach($1, $2) j`, [serial, SIG]).then(j);
  const issueOld = (k, vendor, code, from, to) => as(tok(k), `select public.cl_issue_activation_code($1::uuid, 'X-C1', $2, 1, $3::date, $4::date) j`,
    [vendor, code || 'ABC123', from || '2026-10-08', to || '2026-11-07']).then(j);
  let r = await prepare('ACT', 'SO01-' + await tagOf('SO01'));
  const preSolo = r.licences[0].serial; await attach('ACT', preSolo);
  r = await issueOld('ACT', await vendorOf('SO01'), 'OLD001');
  const preOldCharge = r.ledger_charge.id;
  r = await prepare('ACT', 'AC01-' + await tagOf('AC01'));
  const pendingAC01 = r.licences[0].serial;
  const age = () => pg.exec(`update cl_activation_codes set issued_at = issued_at - interval '1 minute'; update cl_licences set issued_at = issued_at - interval '1 minute';
                             update cl_ledger_entries set created_at = created_at - interval '1 minute'`);
  await age();
  const preRows = await q(`select id, amount::text, notes from cl_ledger_entries order by created_at, id`);
  ok('before plans: the flat USD 20 charged a licence and an old code', preRows.length === 2 && preRows.every((x) => x.amount === '20.00'), JSON.stringify(preRows));

  await pg.exec(MIG);
  ok('the migration applies to the live shape', true);
  let again = null; try { await pg.exec(MIG); } catch (e) { again = e.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /price_plans aborted: already exists/.test(again || ''), again);
  ok('seeded: Business 15/7/3 no limit, Lite 6/-/3 one branch, USD',
    JSON.stringify(await q(`select plan_code, name, main_fee::text, branch_fee::text, till_fee::text, currency, max_branches from cl_price_plan_versions order by plan_code`)) ===
    JSON.stringify([{ plan_code: 'business', name: 'Business', main_fee: '15.00', branch_fee: '7.00', till_fee: '3.00', currency: 'USD', max_branches: null },
                    { plan_code: 'lite', name: 'Lite', main_fee: '6.00', branch_fee: null, till_fee: '3.00', currency: 'USD', max_branches: 1 }]));

  const quote = (k, code, days, business) => as(tok(k), `select public.cl_licence_quote(p_device_code=>$1, p_business_id=>$2::uuid, p_days=>$3) j`, [code || null, business || null, days || 30]).then(j);
  const roles = (qt) => qt.lines.map((l) => (l.branch || '-') + '/' + (l.till_code || '-') + ':' + l.till_role + ':' + l.amount).join(' ');

  console.log('roles and prices (Business, plan not set)');
  r = await quote('ACT', null, 30, acme.business_id);
  ok('Acme (main + 2 branches + 2 extra tills): main 15, till 3, branch 7, branch 7, till 3 = USD 35 per 30 days',
    roles(r) === 'Gweru/T1:branch:7 Gweru/T2:till:3 Harare/T1:main:15 Harare/T2:till:3 Mutare/T1:branch:7' && Number(r.total) === 35 && r.currency === 'USD', roles(r) + ' total ' + r.total);
  ok('... every line says Business, not set (priced as Business)', r.lines.every((l) => l.plan_code === 'business' && l.plan_source === 'default' && l.plan_name === 'Business'));
  r = await quote('ACT', null, 90, acme.business_id);
  ok('90 days: 21, 9, 45, 9, 21 = 105', roles(r) === 'Gweru/T1:branch:21 Gweru/T2:till:9 Harare/T1:main:45 Harare/T2:till:9 Mutare/T1:branch:21' && Number(r.total) === 105, roles(r));
  r = await quote('ACT', null, 365, acme.business_id);
  ok('365 days: 85.17, 36.50, 182.50, 36.50, 85.17 (each rounded to cents) = 425.84',
    roles(r) === 'Gweru/T1:branch:85.17 Gweru/T2:till:36.5 Harare/T1:main:182.5 Harare/T2:till:36.5 Mutare/T1:branch:85.17' && Number(r.total) === 425.84, roles(r) + ' ' + r.total);
  r = await quote('ACT', null, 30, knix.business_id);
  ok('Knix (main T1 deactivated): T2 is the main till, 15 + 3 + 3 = 21', roles(r) === 'Harare/T2:main:15 Harare/T3:till:3 Harare/T4:till:3' && Number(r.total) === 21, roles(r));
  r = await quote('ACT', 'KN01-' + await tagOf('KN01'));
  ok('... a licence for the deactivated T1 is refused (TILL_INACTIVE)', r.lines.length === 0 && /TILL_INACTIVE: Till T1 of this business is deactivated/.test(r.refused[0].message), JSON.stringify(r.refused));
  r = await prepare('ACT', 'KN01-' + await tagOf('KN01'));
  ok('... and so is preparing one', /TILL_INACTIVE/.test(r.e || ''), r.e);
  r = await quote('ACT', 'SO01-' + await tagOf('SO01'));
  ok('Solo (one device, no business): main till 15', r.lines.length === 1 && r.lines[0].till_role === 'main' && Number(r.lines[0].amount) === 15 && r.lines[0].till_code === null, JSON.stringify(r.lines));

  console.log('setting plans: who may, and the rules');
  const setPlan = (k, o, plan, reason) => as(k ? tok(k) : null, `select public.cl_set_plan($1::uuid, $2::uuid, $3, $4) j`,
    [o.business || null, o.vendor || null, plan, reason == null ? 'TEST: plan set by test' : reason]).then(j);
  r = await setPlan(null, { business: tuck.business_id }, 'lite'); ok('anonymous: refused by the grants', /permission denied/i.test(r.e || ''), r.e);
  for (const k of ['ACT', 'LED', 'NONE', 'GONE']) { r = await setPlan(k, { business: tuck.business_id }, 'lite'); ok('staff ' + k + ': refused (needs Vendors Register, active)', /Not authorized/.test(r.e || ''), r.e); }
  r = await setPlan('VEN', { business: tuck.business_id }, 'lite', ' '); ok('a reason is required', /reason is required/.test(r.e || ''), r.e);
  r = await setPlan('VEN', { vendor: await vendorOf('TU02') }, 'lite'); ok('a till of a business: set the plan on the business instead', /Set the plan on the business instead/.test(r.e || ''), r.e);
  r = await setPlan('VEN', { business: tuck.business_id }, 'lite', 'TEST: canteen');
  ok('Vendors Register staff put Tuck on Lite', !r.e && r.assignment.plan_code === 'lite' && r.previous_plan === 'business' && r.previous_source === 'default', r.e);
  const r2 = await setPlan('VEN', { business: tuck.business_id }, 'lite', 'TEST: canteen');
  ok('... the same tap again within 30 s: the same assignment (duplicate), one row', r2.duplicate === true && r2.assignment.id === r.assignment.id &&
    Number((await q(`select count(*) n from cl_plan_assignments`))[0].n) === 1);
  ok('... logged with who, from what, to what, why', JSON.stringify((await q(`select staff_id, detail->>'plan' p, detail->>'previous_plan' pp, detail->>'reason' re from cl_activity_log where action = 'set_plan'`))) ===
    JSON.stringify([{ staff_id: staff.VEN, p: 'lite', pp: 'business', re: 'TEST: canteen' }]));
  r = await quote('ACT', null, 30, tuck.business_id);
  ok('Tuck on Lite (2 tills): main 6 + till 3 = USD 9', roles(r) === 'Canteen/T1:main:6 Canteen/T2:till:3' && Number(r.total) === 9 && r.lines[0].plan_source === 'assigned', roles(r));
  r = await quote('ACT', null, 365, tuck.business_id);
  ok('... 365 days: 73.00 + 36.50', roles(r) === 'Canteen/T1:main:73 Canteen/T2:till:36.5', roles(r));
  r = await setPlan('SYS', { vendor: await vendorOf('SO01') }, 'lite', 'TEST: tuckshop');
  ok('a sysadmin may set plans too; Solo (no business) on Lite', !r.e, r.e);
  r = await quote('ACT', 'SO01-' + await tagOf('SO01'));
  ok('... Solo now 6', Number(r.lines[0].amount) === 6 && r.lines[0].plan_code === 'lite', JSON.stringify(r.lines[0]));

  console.log('Lite: one branch, enforced by the server');
  const LIMIT = 'PLAN_BRANCH_LIMIT: Your plan allows one branch. Ask seiGEN to upgrade you to the Business plan.';
  r = await codeFor('TU01', TP, { newName: 'Second' });
  ok('a Lite business can\'t open a second branch (join code for a new branch refused, with the owner\'s sentence)', (r.e || '').includes(LIMIT), r.e);
  ok('... and no branch row was made', Number((await q(`select count(*) n from cl_branches where business_id = $1`, [tuck.business_id]))[0].n) === 1);
  await joinNew('TU01', TP, 'TU03', { branchId: tuck.branch_id });
  r = await quote('ACT', null, 30, tuck.business_id);
  ok('... more tills on the main branch are fine: 6 + 3 + 3 = 12', Number(r.total) === 12, roles(r));
  r = await setPlan('VEN', { business: tuck.business_id }, 'business', 'TEST: opening a second shop');
  ok('upgrade to Business: allowed', !r.e, r.e);
  const secondCode = await codeFor('TU01', TP, { newName: 'Second' });
  ok('... now a second branch is allowed', !secondCode.e && secondCode.code, secondCode.e);
  const spareCode = await codeFor('TU01', TP, { branchId: secondCode.branch_id });   // kept for later
  const tu04 = await join('TU04', TP, secondCode.code);
  ok('... and a till joins it', !tu04.e && tu04.till_code === 'T1', tu04.e);
  r = await quote('ACT', null, 30, tuck.business_id);
  ok('... priced as Business: 15 + 3 + 3 + branch 7 = 28', Number(r.total) === 28, roles(r));
  r = await setPlan('VEN', { business: tuck.business_id }, 'lite', 'TEST: back to one shop');
  ok('downgrade to Lite refused while 2 branches have active tills', /PLAN_BRANCH_LIMIT: This business has 2 branches with active tills; Lite allows 1/.test(r.e || ''), r.e);
  r = await setPlan('VEN', { business: acme.business_id }, 'lite', 'TEST');
  ok('... Acme too (3 branches)', /has 3 branches with active tills/.test(r.e || ''), r.e);
  await setActive('TU01', TP, tu04.terminal_id, false);
  r = await setPlan('VEN', { business: tuck.business_id }, 'lite', 'TEST: back to one shop');
  ok('... allowed once the other branch\'s till is deactivated', !r.e, r.e);
  r = await codeFor('TU01', TP, { branchId: secondCode.branch_id });
  ok('a Lite business can\'t issue a join code for its old second branch', (r.e || '').includes(LIMIT), r.e);
  r = await join('TU05', TP, spareCode.code);
  ok('... and a code issued while it was Business can\'t be used to join it now (cl_terminal_join backstop)', (r.e || '').includes(LIMIT), JSON.stringify(r));
  ok('... nothing written for that device', Number((await q(`select count(*) n from cl_vendors where install_id = 'TU05'`))[0].n) === 0);
  await setActive('TU01', TP, tu04.terminal_id, true);   // reactivated by the shop
  r = await prepare('ACT', 'TU04-' + await tagOf('TU04'));
  ok('a licence for a till of a branch Lite doesn\'t allow is refused', (r.e || '').includes(LIMIT), r.e);
  r = await quote('ACT', null, 30, tuck.business_id);
  ok('... the quote names it and prices the rest (6 + 3 + 3)', Number(r.total) === 12 && r.refused.length === 1 && r.refused[0].message.includes(LIMIT), JSON.stringify(r.refused));
  r = await setPlan('VEN', { business: tuck.business_id }, 'business', 'TEST: second shop for real');
  r = await prepare('ACT', 'TU04-' + await tagOf('TU04'));
  ok('... back on Business, it is issued as a branch till (7)', !r.e && r.licences[0].till_role === 'branch' && Number(r.licences[0].amount) === 7, r.e);

  console.log('plan resolution');
  r = await setPlan('VEN', { vendor: await vendorOf('PRE1') }, 'lite', 'TEST: market stall');
  const pre = await register('PRE1', 'Pre Phrase', 'Pre', 'Stall');
  r = await quote('ACT', null, 30, pre.business_id);
  ok('a device on Lite that then registers its business: the business is Lite (its creator\'s plan)', r.lines[0].plan_code === 'lite' && r.lines[0].plan_source === 'assigned', JSON.stringify(r.lines[0]));
  await setPlan('VEN', { business: pre.business_id }, 'business', 'TEST: grew');
  r = await quote('ACT', null, 30, pre.business_id);
  ok('... a plan set on the business wins', r.lines[0].plan_code === 'business', JSON.stringify(r.lines[0]));

  console.log('issuing: the snapshot, the charge, one price everywhere');
  const q2 = await quote('ACT', 'AC02-' + await tagOf('AC02'));
  r = await prepare('ACT', 'AC02-' + await tagOf('AC02'));
  const L = r.licences[0];
  ok('prepare answers with plan, role and price (Business, till, 3.00)', L.plan_code === 'business' && L.till_role === 'till' && Number(L.unit_fee) === 3 && Number(L.amount) === 3 && L.currency === 'USD' && L.charged === true, JSON.stringify(L));
  ok('... the signed payload\'s plan byte is Business (1)', parseInt(L.payload_hex.slice(52, 54), 16) === 1, L.payload_hex.slice(52, 54));
  const a = await attach('ACT', L.serial);
  const charge = (await q(`select e.amount::text, e.currency, e.notes, e.vendor_id from cl_licences l join cl_ledger_entries e on e.id = l.ledger_entry_id where l.serial = $1`, [L.serial]))[0];
  ok('attach charges exactly the snapshot, to the till\'s own vendor row, with the usual note', !a.e && charge.amount === '3.00' && charge.notes === 'Auto-charged: licence #' + L.serial + ' (30 days)' && charge.vendor_id === await vendorOf('AC02'), JSON.stringify(charge));
  ok('quote = licence = charge (the CLI and the Console read the quote)', Number(q2.lines[0].amount) === Number(L.amount) && Number(charge.amount) === Number(L.amount));
  const snap = (await q(`select price_plan_code, plan_source, till_role, unit_fee::text, amount::text, currency, plan_version_id from cl_licences where serial = $1`, [L.serial]))[0];
  ok('the snapshot is on the licence', snap.price_plan_code === 'business' && snap.till_role === 'till' && snap.unit_fee === '3.00' && snap.amount === '3.00', JSON.stringify(snap));
  let e = null; try { await q(`update cl_licences set amount = 1 where serial = $1`, [L.serial]); } catch (x) { e = x.message; }
  ok('... and can\'t be edited, even directly', /price snapshot can't be changed/.test(e || ''), e);
  r = await prepare('ACT', 'AC02-' + await tagOf('AC02'));
  ok('the duplicate guard still holds (same device twice within 30 s)', /DUPLICATE_ISSUE/.test(r.e || ''), r.e);
  await age();
  r = await as(tok('ACT'), `select public.cl_licence_list(p_install_id=>'AC02') j`).then(j);
  ok('the licence list shows plan, role and price', r[0].till_role === 'till' && Number(r[0].amount) === 3 && r[0].ledger_entry_id, JSON.stringify(r[0]).slice(0, 300));
  const pend = await attach('ACT', pendingAC01);
  const pendRow = (await q(`select till_role, amount::text, (select amount::text from cl_ledger_entries where id = ledger_entry_id) charged from cl_licences where serial = $1`, [pendingAC01]))[0];
  ok('a licence prepared before plans and signed after: priced at signing (main, 15) and snapshotted', !pend.e && pendRow.till_role === 'main' && pendRow.amount === '15.00' && pendRow.charged === '15.00', JSON.stringify(pendRow));

  console.log('price edits: sysadmin only, with history; old records keep their price');
  const setPrice = (k, o) => as(tok(k), `select public.cl_price_plan_set($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9) j`,
    [o.plan || 'business', o.name || 'Business', o.main ?? 15, o.branch === undefined ? 7 : o.branch, o.till ?? 4, o.cur || 'USD', o.max === undefined ? null : o.max, o.from || null, o.note || 'TEST']).then(j);
  for (const k of ['VEN', 'ACT', 'LED']) { r = await setPrice(k, {}); ok('staff ' + k + ' can\'t change prices', /only a SysAdmin/.test(r.e || ''), r.e); }
  r = await setPrice('SYS', { from: new Date(Date.now() - 86400000).toISOString() }); ok('backdating is refused', /can't be in the past/.test(r.e || ''), r.e);
  r = await setPrice('SYS', { branch: null }); ok('no branch fee needs a one-branch limit', /Set a branch fee/.test(r.e || ''), r.e);
  r = await setPrice('SYS', { till: 3.555 }); ok('at most 2 decimals', /2 decimals/.test(r.e || ''), r.e);
  r = await setPrice('SYS', { till: 4, note: 'TEST: extra till 4' });
  ok('a sysadmin sets Business extra tills to 4, from now', !r.e && Number(r.version.till_fee) === 4, r.e);
  const fut = await setPrice('SYS', { till: 9, from: new Date(Date.now() + 86400000).toISOString(), note: 'TEST: future' });
  ok('... and a future price (9, from tomorrow)', !fut.e && fut.version, fut.e);
  r = await quote('ACT', 'AC02-' + await tagOf('AC02'));
  ok('the new price applies to the next licence (4), the future one not yet', Number(r.lines[0].unit_fee) === 4, JSON.stringify(r.lines[0]));
  ok('the earlier licence and its charge still say 3.00', (await q(`select l.amount::text a, e.amount::text c from cl_licences l join cl_ledger_entries e on e.id = l.ledger_entry_id where l.serial = $1`, [L.serial]))[0].a === '3.00');
  r = await as(tok('ACT'), `select public.cl_price_plans_list() j`).then(j);
  const biz = r.find((p) => p.code === 'business');
  ok('the plans list: Business has 3 versions, the future one marked upcoming, the current one is the 4', biz.versions.length === 3 && biz.versions[0].upcoming === true &&
    biz.versions.find((v) => v.id === biz.current_id).till_fee === 4, JSON.stringify(biz).slice(0, 400));
  r = await as(tok('NONE'), `select public.cl_price_plans_list() j`).then(j); ok('... staff without a vendor/money module can\'t read it', /Not authorized/.test(r.e || ''), r.e);
  r = await as(null, `select public.cl_price_plans_list() j`).then(j); ok('... nor anonymous', /permission denied/i.test(r.e || ''), r.e);
  r = await as(tok('SYS'), `select public.cl_set_activation_rate(25, 'USD') j`).then(j);
  ok('the old flat rate can\'t be set any more', /replaced by Price plans/.test(r.e || ''), r.e);
  await setPrice('SYS', { till: 3, note: 'TEST: back to 3' });

  console.log('old-style codes (production Console until the cutoff)');
  r = await issueOld('ACT', await vendorOf('SO01'), 'OLD002');
  ok('an old code for Solo (Lite, main) charges 6.00', Number(r.ledger_charge.amount) === 6, JSON.stringify(r.ledger_charge));
  const r3 = await issueOld('ACT', await vendorOf('SO01'), 'OLD002');
  ok('... repeated within 30 s: the same charge back, no second one', r3.duplicate === true && r3.ledger_charge.id === r.ledger_charge.id);
  r = await issueOld('ACT', await vendorOf('KN03'), 'OLD003');
  ok('an old code for an extra till (Knix T3) charges 3.00', Number(r.ledger_charge.amount) === 3, JSON.stringify(r.ledger_charge));
  r = await issueOld('ACT', await vendorOf('KN01'), 'OLD004');
  ok('an old code for a deactivated till is refused, nothing written', /TILL_INACTIVE/.test(r.e || '') &&
    Number((await q(`select count(*) n from cl_activation_codes where computed_code = 'OLD004'`))[0].n) === 0, r.e);
  r = await issueOld('ACT', await vendorOf('AC01'), 'OLD005', '2026-10-08', '2026-11-22');
  ok('an old code\'s days count (45 days, main 15 -> 22.50)', Number(r.ledger_charge.amount) === 22.5, JSON.stringify(r.ledger_charge));

  console.log('the accounts list (Console: vendor card, "Plan not set")');
  r = await as(tok('ACT'), `select public.cl_plan_accounts() j`).then(j);
  const acc = (n) => r.find((x) => x.name === n);
  ok('Acme: Business (not set), 5 tills, USD 35 per 30 days, all 5 vendor rows billed together', acc('Acme').plan_source === 'default' && Number(acc('Acme').monthly_total) === 35 &&
    acc('Acme').tills.length === 5 && acc('Acme').vendor_ids.length === 5, JSON.stringify(acc('Acme')).slice(0, 400));
  ok('Knix: 21, and T1 listed with its problem (deactivated)', Number(acc('Knix').monthly_total) === 21 && /TILL_INACTIVE/.test(acc('Knix').tills.find((t) => t.till_code === 'T1').problem || ''));
  ok('Tuck: Business (set), history newest first with who', acc('Tuck').plan_source === 'assigned' && acc('Tuck').plan_code === 'business' && acc('Tuck').history[0].set_by === 'Staff VEN' && acc('Tuck').history.length === 4);
  ok('Solo: an unregistered device, Lite, 6', acc('Solo').kind === 'vendor' && Number(acc('Solo').monthly_total) === 6 && acc('Solo').plan_code === 'lite');
  r = await as(tok('NONE'), `select public.cl_plan_accounts() j`).then(j); ok('... refused to staff without a vendor/money module', /Not authorized/.test(r.e || ''), r.e);

  console.log('the device: More -> About');
  const terms = (iid, ph) => devTry(`select public.cl_licence_terms($1, $2, $3) j`, [iid, ph, key(iid)]);
  r = await terms('AC02', AP);
  ok('a till sees its own licence terms: Business, extra till, 3.00 per 30 days', r.plan_name === 'Business' && r.till_role === 'till' && Number(r.unit_fee) === 3 && Number(r.amount) === 3 && r.serial === L.serial && r.current_plan_name === 'Business', JSON.stringify(r));
  r = await devTry(`select public.cl_licence_terms('AC02', 'wrong phrase', $1) j`, [key('AC02')]);
  ok('... only with its own phrase and device key', /does not match/.test(r.e || ''), r.e);
  r = await terms('SO01', 'Solo Phrase');
  ok('a licence from before plans: no plan line (nulls), but the current plan is known', r.serial === preSolo && r.till_role === null && r.current_plan_name === 'Lite', JSON.stringify(r));

  console.log('records from before plans are untouched');
  const after = await q(`select id, amount::text, notes from cl_ledger_entries where id = any($1) order by created_at, id`, [preRows.map((x) => x.id)]);
  ok('the 20.00 licence charge and the 20.00 old-code charge are unchanged', JSON.stringify(after) === JSON.stringify(preRows), JSON.stringify(after));
  ok('... and that licence has no snapshot', (await q(`select till_role from cl_licences where serial = $1`, [preSolo]))[0].till_role === null);

  console.log('rollback');
  let rb = null; try { await pg.exec(RB); } catch (x) { rb = x.message; } await pg.exec('rollback').catch(() => {});
  ok('the rollback refuses while priced licences or plan assignments exist, changing nothing', /rollback aborted: priced licences or plan assignments exist/.test(rb || '') &&
    Number((await q(`select count(*) n from cl_plan_assignments`))[0].n) > 0, rb);
  await pg.exec(`delete from cl_licences where till_role is not null; delete from cl_plan_assignments;`);
  await pg.exec(RB);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('with none, the rollback restores the exact pre-migration catalogue (seven functions byte for byte)', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  await pg.exec(MIG);
  ok('and the migration applies again after a rollback', true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
