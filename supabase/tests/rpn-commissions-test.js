// node supabase/tests/rpn-commissions-test.js
//
// Tests supabase/migrations/20261015120000_rpn_commissions.sql (and its
// rollback) in an in-memory PGlite built from the repo in the live shape,
// never the live database: the two security fixes (RPNs can't read vendor
// phrases / device keys, can't change their own row), field force numbers,
// PINs and suspend, linking from the app (match, wrong PIN, unknown number,
// suspended, rate limit, conflicts on a business), staff reassignment and
// its history, rates (SysAdmin only, effective dates, snapshots), commission
// on payments (onboarding / recurring across a business's tills, 0% "no
// rate", reversals and onboarding again, no RPN / inactive RPN, credits,
// duplicate taps, reassignment), payouts (never above due, Cashbook out,
// double taps, reversal), who may do what, the delete guards, and the
// rollback.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261015120000_rpn_commissions.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE]) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const tryQ = async (sql, p) => { try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; } };
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p) {
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }
  const j = (x) => (x.e ? { e: x.e } : x.r[0].j);

  // ---- staff ----
  const staff = {};
  for (const [k, sys, active] of [['SYS', true, true], ['DIR', false, true], ['VEN', false, true], ['COM', false, true], ['PAY', false, true], ['LED', false, true], ['NONE', false, true], ['GONE', false, false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, $3, now()) returning id`, ['Staff ' + k, sys, active]))[0].id;
  const modId = async (k) => ((await q(`select id from cl_modules where key = $1`, [k]))[0] || {}).id ||
    (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [k]))[0].id;
  const grant = async (s, m) => q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff[s], await modId(m)]);
  await grant('DIR', 'rpn_directory'); await grant('VEN', 'vendors'); await grant('LED', 'collections_ledger'); await grant('NONE', 'cashbook'); await grant('GONE', 'rpn_directory');
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });
  const coa = {};
  for (const [code, name, t] of [['1000', 'Cash on Hand', 'asset'], ['5100', 'Commissions Paid', 'expense']])
    coa[code] = (await q(`insert into cl_chart_of_accounts (id, code, name, account_type, active, created_at) values (gen_random_uuid(), $1, $2, $3, true, now()) returning id`, [code, name, t]))[0].id;

  // ---- RPNs ----
  const rpn = {};
  for (const n of ['Tendai', 'Rudo', 'Chipo']) rpn[n] = (await q(`insert into cl_rpn (full_name, phone, city, passcode_hash, verification_code) values ($1, '0770000000', 'Harare', 'x', $2) returning id`, [n, 'V-' + n]))[0].id;
  const rpnTok = (n) => ({ role: 'authenticated', sub: rpn[n], user_type: 'rpn' });

  // ---- devices: two single devices, one business with two tills ----
  const KEY = {}; const key = (iid) => (KEY[iid] = KEY[iid] || crypto.randomBytes(16).toString('hex'));
  const single = async (iid, name) => (await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status) values ($1, $2, 'Shop Phrase', $3, 'onboarding') returning id`, [name, iid, key(iid)]))[0].id;
  const sd1 = await single('SD01', 'Single One'), sd2 = await single('SD02', 'Single Two'), sd3 = await single('SD03', 'Single Three'), sd4 = await single('SD04', 'Single Four');
  const dev = async (sql, p) => { const x = await as(null, sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };
  const AP = 'Acme Phrase';
  const acme = await dev(`select public.cl_branch_register($1, $2, $3, 'Acme', 'Harare') j`, ['AC01', AP, key('AC01')]);
  const code = await dev(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>$4::uuid, p_new_branch_name=>null) j`, ['AC01', AP, key('AC01'), acme.branch_id]);
  await dev(`select public.cl_terminal_join($1, $2, $3, $4) j`, ['AC02', AP, key('AC02'), code.code]);
  const ac1 = (await q(`select id from cl_vendors where install_id = 'AC01'`))[0].id, ac2 = (await q(`select id from cl_vendors where install_id = 'AC02'`))[0].id;

  // before: an RPN can read the phrase of "their" vendor (the hole being closed)
  await q(`update cl_vendors set rpn_id = $1 where id = $2`, [rpn.Tendai, sd4]);
  const leakBefore = await as(rpnTok('Tendai'), `select shop_secret_phrase, device_key from cl_vendors where id = $1`, [sd4]);
  ok('before the migration an RPN could read their vendor\'s phrase and device key (the hole)', leakBefore.r && leakBefore.r.length === 1 && leakBefore.r[0].shop_secret_phrase === 'Shop Phrase', JSON.stringify(leakBefore));
  await q(`update cl_vendors set rpn_id = null where id = $1`, [sd4]);

  // ---- apply ----
  let e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('the migration applies', !e, e);
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /rpn_commissions aborted: already there/.test(e || ''), e);
  ok('the new modules exist', (await q(`select count(*)::int c from cl_modules where key in ('rpn_commissions', 'rpn_payouts')`))[0].c === 2);
  await grant('COM', 'rpn_commissions'); await grant('PAY', 'rpn_payouts');
  ok('the history from before the migration is clean (setting rpn_id back to null was before the trigger)', (await q(`select count(*)::int c from cl_rpn_assignments`))[0].c === 0);

  // ---- 1. security fixes ----
  await q(`update cl_vendors set rpn_id = $1 where id = $2`, [rpn.Tendai, sd4]);
  const leak = await as(rpnTok('Tendai'), `select shop_secret_phrase, device_key from cl_vendors where id = $1`, [sd4]);
  ok('SECURITY: an RPN can no longer read their vendor\'s shop_secret_phrase or device_key (no rows)', leak.r && leak.r.length === 0, JSON.stringify(leak));
  const leakAll = await as(rpnTok('Tendai'), `select count(*)::int c from cl_vendors`);
  ok('SECURITY: an RPN reads no vendor rows at all', leakAll.r && leakAll.r[0].c === 0, JSON.stringify(leakAll));
  ok('... staff with the Vendors Register still read vendors', (await as(tok('VEN'), `select count(*)::int c from cl_vendors`)).r[0].c > 0);
  await q(`update cl_vendors set rpn_id = null where id = $1`, [sd4]);
  await q(`update cl_rpn set active = false where id = $1`, [rpn.Chipo]);
  for (const [col, val] of [['active', 'true'], ['verification_code', "'HACKED'"], ['verification_used', 'false'], ['full_name', "'Someone Else'"], ['field_force_no', "'RPN-999'"]]) {
    const up = await as(rpnTok('Chipo'), `update cl_rpn set ${col} = ${val} where id = $1 returning id`, [rpn.Chipo]);
    ok('SECURITY: an RPN can\'t change their own ' + col, (up.r && up.r.length === 0) || !!up.e, JSON.stringify(up));
  }
  ok('... and nothing changed on their row', JSON.stringify((await q(`select active, verification_code, full_name, field_force_no from cl_rpn where id = $1`, [rpn.Chipo]))[0]) ===
    JSON.stringify({ active: false, verification_code: 'V-Chipo', full_name: 'Chipo', field_force_no: null }));
  await q(`update cl_rpn set active = true where id = $1`, [rpn.Chipo]);
  ok('SECURITY: nobody reads PIN hashes through the API (staff included)', /permission denied/.test((await as(tok('SYS'), `select * from cl_rpn_pins`)).e || ''));

  // ---- 2. RPN Directory: field force numbers, PINs, suspend ----
  const setFF = (k, id, ff) => as(tok(k), `select public.cl_rpn_set_field_force_no($1, $2) j`, [id, ff]).then(j);
  ok('field force number: RPN Directory sets it (upper-cased)', (await setFF('DIR', rpn.Tendai, 'rpn-014')).field_force_no === 'RPN-014');
  ok('field force number: wrong shape refused', /Use the form RPN-014/.test((await setFF('DIR', rpn.Rudo, '14')).e || ''));
  ok('field force number: one per RPN', /RPN-014 is already used by another RPN/.test((await setFF('DIR', rpn.Rudo, 'RPN-014')).e || ''));
  ok('field force number: Vendors Register alone can\'t set it', /Not authorized/.test((await setFF('VEN', rpn.Rudo, 'RPN-015')).e || ''));
  ok('field force number: inactive staff refused', /Not authorized/.test((await setFF('GONE', rpn.Rudo, 'RPN-015')).e || ''));
  await setFF('SYS', rpn.Rudo, 'RPN-015'); await setFF('DIR', rpn.Chipo, 'RPN-016');
  const pins = {};
  for (const n of ['Tendai', 'Rudo', 'Chipo']) pins[n] = j(await as(tok('DIR'), `select public.cl_rpn_set_pin($1) j`, [rpn[n]])).pin;
  ok('Set PIN gives a 6-digit PIN once; only its hash is kept', /^\d{6}$/.test(pins.Tendai) && (await q(`select pin_hash from cl_rpn_pins where rpn_id = $1`, [rpn.Tendai]))[0].pin_hash.startsWith('$2'));
  ok('the PIN never reaches the activity log', !JSON.stringify(await q(`select detail from cl_activity_log where action = 'rpn_set_pin'`)).includes(pins.Tendai));
  ok('suspend needs a reason', /Give a reason/.test(j(await as(tok('DIR'), `select public.cl_rpn_set_active($1, false, '') j`, [rpn.Chipo])).e || ''));
  ok('suspend: RPN Directory', j(await as(tok('DIR'), `select public.cl_rpn_set_active($1, false, 'TEST: suspended') j`, [rpn.Chipo])).active === false);

  // ---- 3. linking from the app ----
  const link = (iid, ff, pin, phrase) => as(null, `select public.cl_device_link_rpn($1, $2, $3, $4, $5) j`, [iid, phrase || 'Shop Phrase', key(iid), ff, pin]).then(j);
  const s1 = await link('SD01', 'rpn-014', pins.Tendai);
  ok('a single device links with field force number + PIN', s1.ok === true && s1.status === 'linked' && s1.rpn_name === 'Tendai' && s1.field_force_no === 'RPN-014', JSON.stringify(s1));
  const h1 = (await q(`select source, status, by_install, rpn_id, by_staff from cl_rpn_assignments where vendor_id = $1`, [sd1]))[0];
  ok('... it reaches the Console: rpn_id set and a history row (source app, by the install)', (await q(`select rpn_id from cl_vendors where id = $1`, [sd1]))[0].rpn_id === rpn.Tendai &&
    h1 && h1.source === 'app' && h1.status === 'applied' && h1.by_install === 'SD01' && h1.by_staff === null, JSON.stringify(h1));
  ok('sending it again (offline queue retry) answers "already", no second history row', (await link('SD01', 'RPN-014', pins.Tendai)).status === 'already' &&
    (await q(`select count(*)::int c from cl_rpn_assignments where vendor_id = $1`, [sd1]))[0].c === 1);
  const st1 = j(await as(null, `select public.cl_device_rpn_status('SD01', 'Shop Phrase', $1) j`, [key('SD01')]));
  ok('More → About reads "Onboarded by" from the server', st1.linked && st1.rpn_name === 'Tendai' && st1.field_force_no === 'RPN-014', JSON.stringify(st1));
  const wrong = await link('SD02', 'RPN-014', pins.Tendai === '000000' ? '111111' : '000000');
  const unknown = await link('SD02', 'RPN-777', pins.Tendai);
  ok('wrong PIN and unknown number get the same plain answer', wrong.ok === false && wrong.code === 'RPN_NO_MATCH' && unknown.code === 'RPN_NO_MATCH' &&
    wrong.message === 'That field force number and PIN don\'t match. Check them with your RPN.' && unknown.message === wrong.message, JSON.stringify([wrong, unknown]));
  ok('suspended RPN refused', (await link('SD02', 'RPN-016', pins.Chipo)).code === 'RPN_SUSPENDED');
  ok('a wrong phrase is refused before anything', /Shop secret phrase does not match/.test((await as(null, `select public.cl_device_link_rpn('SD02', 'Nope', $1, 'RPN-014', $2) j`, [key('SD02'), pins.Tendai])).e || ''));
  ok('an unregistered device is refused', /not registered/.test((await as(null, `select public.cl_device_link_rpn('ZZ99', 'Shop Phrase', 'k', 'RPN-014', $1) j`, [pins.Tendai])).e || ''));
  for (let i = 0; i < 3; i++) await link('SD02', 'RPN-014', 'x' + i);
  const limited = await link('SD02', 'RPN-014', pins.Tendai);
  ok('5 failed tries in an hour: the right PIN is refused too (rate limit)', limited.code === 'RPN_TOO_MANY_TRIES' && /Wait an hour/.test(limited.message), JSON.stringify(limited));
  ok('the failed tries are kept (refusals are answers, not rolled-back errors)', (await q(`select count(*)::int c from cl_rpn_link_failures where install_id = 'SD02'`))[0].c === 5);
  await q(`delete from cl_rpn_link_failures where install_id = 'SD02'`);
  ok('SD02 links to Rudo after the hour', (await link('SD02', 'RPN-015', pins.Rudo)).status === 'linked');

  // business: the first till sets the business's RPN; another RPN from a second till is a conflict
  const b1 = await link('AC02', 'RPN-014', pins.Tendai, AP);
  ok('a till links its business (the business carries the RPN)', b1.status === 'linked' && b1.business === 'Acme' &&
    (await q(`select rpn_id from cl_businesses where id = $1`, [acme.business_id]))[0].rpn_id === rpn.Tendai &&
    (await q(`select rpn_id from cl_vendors where id = $1`, [ac2]))[0].rpn_id === null, JSON.stringify(b1));
  ok('another till of the same business with the same RPN: already', (await link('AC01', 'RPN-014', pins.Tendai, AP)).status === 'already');
  const cf = await link('AC01', 'RPN-015', pins.Rudo, AP);
  ok('another till entering a DIFFERENT RPN: a conflict for staff, the business keeps its RPN', cf.code === 'RPN_CONFLICT' && /This business already has an RPN/.test(cf.message) &&
    (await q(`select rpn_id from cl_businesses where id = $1`, [acme.business_id]))[0].rpn_id === rpn.Tendai, JSON.stringify(cf));
  await link('AC01', 'RPN-015', pins.Rudo, AP);
  const port = j(await as(tok('VEN'), `select public.cl_rpn_portfolio() j`));
  ok('the conflict is listed once, with names', port.conflicts.length === 1 && port.conflicts[0].name === 'Acme' && port.conflicts[0].current_rpn === 'Tendai' && port.conflicts[0].wanted_rpn === 'Rudo', JSON.stringify(port.conflicts));
  ok('the portfolio: Tendai has Acme (business) and Single One (device)', JSON.stringify(port.rpns.find((r) => r.full_name === 'Tendai')) .includes('"businesses":[{"id":"' + acme.business_id + '","name":"Acme"}]') &&
    port.rpns.find((r) => r.full_name === 'Tendai').vendors.some((v) => v.name === 'Single One') && !port.rpns.find((r) => r.full_name === 'Tendai').vendors.some((v) => v.name === 'Acme'));
  ok('the device status shows the open conflict', j(await as(null, `select public.cl_device_rpn_status('AC01', $1, $2) j`, [AP, key('AC01')])).open_conflict === true);
  const rej = j(await as(tok('VEN'), `select public.cl_resolve_rpn_conflict($1, false, 'TEST: Tendai signed them up') j`, [port.conflicts[0].id]));
  ok('staff reject the conflict: nothing changes, it closes', rej.accepted === false && (await q(`select status from cl_rpn_assignments where id = $1`, [port.conflicts[0].id]))[0].status === 'rejected' &&
    (await q(`select rpn_id from cl_businesses where id = $1`, [acme.business_id]))[0].rpn_id === rpn.Tendai);
  ok('a closed conflict can\'t be resolved again', /no longer open/.test(j(await as(tok('VEN'), `select public.cl_resolve_rpn_conflict($1, true, 'again') j`, [port.conflicts[0].id])).e || ''));

  // ---- 4. staff assignment ----
  const assign = (k, biz, ven, r, reason) => as(k ? tok(k) : null, `select public.cl_assign_rpn($1, $2, $3, $4) j`, [biz, ven, r, reason]).then(j);
  ok('assign: a till of a business is refused (set it on the business)', /This device is a till of "Acme"\. Set the RPN on the business instead\./.test((await assign('VEN', null, ac1, rpn.Rudo, 'TEST: x')).e || ''));
  ok('assign: reason required', /Give a reason/.test((await assign('VEN', null, sd3, rpn.Rudo, '')).e || ''));
  ok('assign: a suspended RPN is refused', /Chipo is suspended/.test((await assign('VEN', null, sd3, rpn.Chipo, 'TEST: x')).e || ''));
  ok('assign: staff without Vendors Register / RPN Directory refused', /Not authorized/.test((await assign('NONE', null, sd3, rpn.Rudo, 'TEST: x')).e || ''));
  ok('assign: anonymous refused', /permission denied/.test((await assign(null, null, sd3, rpn.Rudo, 'TEST: x')).e || ''));
  ok('assign: the RPN Directory assigns a device', (await assign('DIR', null, sd3, rpn.Rudo, 'TEST: signed up by Rudo')).rpn_id === rpn.Rudo);
  ok('assign: the same again is a plain error', /"Single Three" already has Rudo\./.test((await assign('DIR', null, sd3, rpn.Rudo, 'TEST: again')).e || ''));
  const hist = j(await as(tok('VEN'), `select public.cl_rpn_history(null, $1) j`, [sd3]));
  ok('history names who, how and why', hist.length === 1 && hist[0].source === 'console' && hist[0].by_staff === 'Staff DIR' && hist[0].reason === 'TEST: signed up by Rudo' && hist[0].rpn === 'Rudo', JSON.stringify(hist));
  await as(tok('VEN'), `update cl_vendors set rpn_id = $1 where id = $2`, [rpn.Tendai, sd4]);
  const formHist = (await q(`select source, by_staff from cl_rpn_assignments where vendor_id = $1 order by id desc limit 1`, [sd4]))[0];
  ok('a change through the Console\'s vendor form is in the history too (register_form, staff named)', formHist && formHist.source === 'register_form' && formHist.by_staff === staff.VEN, JSON.stringify(formHist));
  await q(`update cl_vendors set rpn_id = null where id = $1`, [sd4]);

  // ---- 5. rates ----
  const setRate = (k, on, re, from, note) => as(tok(k), `select public.cl_rpn_rate_set($1, $2, $3, $4) j`, [on, re, from || null, note || null]).then(j);
  ok('rates: SysAdmin only', /only a SysAdmin/.test((await setRate('COM', 10, 5)).e || ''));
  ok('rates: 0 to 100', /from 0 to 100/.test((await setRate('SYS', 120, 5)).e || ''));
  ok('rates: not back-dated', /can't start in the past/.test((await setRate('SYS', 10, 5, new Date(Date.now() - 86400000).toISOString())).e || ''));
  ok('rates: seeded empty', (await q(`select count(*)::int c from cl_rpn_commission_rates`))[0].c === 0);

  // ---- 6. commission ----
  const pay = (vendor, amount, notes) => as(tok('LED'), `select public.cl_record_ledger_payment($1, $2, 'USD', 'cash', null, $3, $4) j`, [vendor, amount, notes || null, coa['1000']]).then(j);
  const lineOf = async (entry) => (await q(`select rpn_id, kind, rate_pct::text, no_rate, amount::text, base_amount::text, business_id from cl_rpn_commissions where ledger_entry_id = $1`, [entry]))[0];
  const p0 = await pay(sd1, 20, 'TEST p0');
  const l0 = await lineOf(p0.ledger_entry.id);
  ok('no rate set yet: the payment still makes a 0% "no rate" onboarding line', l0 && l0.kind === 'onboarding' && l0.no_rate === true && Number(l0.rate_pct) === 0 && Number(l0.amount) === 0 && l0.rpn_id === rpn.Tendai, JSON.stringify(l0));
  const r1 = await setRate('SYS', 10, 5, null, 'TEST rates');
  ok('SysAdmin sets 10% onboarding, 5% recurring', r1.rate && Number(r1.rate.onboarding_pct) === 10, JSON.stringify(r1));
  ok('a double tap sets it once', (await setRate('SYS', 10, 5)).duplicate === true && (await q(`select count(*)::int c from cl_rpn_commission_rates`))[0].c === 1);
  const rl = j(await as(tok('COM'), `select public.cl_rpn_rates_list() j`));
  ok('the rate history is readable by RPN Commissions staff', rl.rates.length === 1 && rl.current_id === r1.rate.id && rl.rates[0].set_by === 'Staff SYS');
  const p1 = await pay(sd1, 40, 'TEST p1');
  ok('the next payment of the same device: recurring at 5%', JSON.stringify(await lineOf(p1.ledger_entry.id)).includes('"kind":"recurring","rate_pct":"5.00","no_rate":false,"amount":"2.00"'));
  const a1 = await pay(ac2, 100, 'TEST a1');
  ok('a business\'s first payment (any till): onboarding at 10%, to the business\'s RPN', JSON.stringify(await lineOf(a1.ledger_entry.id)) ===
    JSON.stringify({ rpn_id: rpn.Tendai, kind: 'onboarding', rate_pct: '10.00', no_rate: false, amount: '10.00', base_amount: '100.00', business_id: acme.business_id }));
  const a2 = await pay(ac1, 60, 'TEST a2');
  ok('... a payment on its OTHER till is recurring (the business is one account)', (await lineOf(a2.ledger_entry.id)).kind === 'recurring' && Number((await lineOf(a2.ledger_entry.id)).amount) === 3);
  const dup1 = await pay(sd2, 30, 'TEST dup'), dup2 = await pay(sd2, 30, 'TEST dup');
  ok('a double tap on a payment makes ONE commission line', dup2.duplicate === true && (await q(`select count(*)::int c from cl_rpn_commissions where vendor_id = $1`, [sd2]))[0].c === 1 &&
    (await lineOf(dup1.ledger_entry.id)).rpn_id === rpn.Rudo && Number((await lineOf(dup1.ledger_entry.id)).amount) === 3);
  // reversal of the onboarding payment, then onboarding again
  const rv = j(await as(tok('LED'), `select public.cl_reverse_ledger_payment($1, 'TEST: wrong vendor') j`, [dup1.ledger_entry.id]));
  const neg = (await q(`select kind, amount::text, reverses_commission_id from cl_rpn_commissions where ledger_entry_id = $1`, [rv.ledger_entry.id]))[0];
  ok('a payment reversal makes the matching negative line', neg && neg.kind === 'onboarding' && Number(neg.amount) === -3 && neg.reverses_commission_id !== null, JSON.stringify(neg || rv));
  const again = await pay(sd2, 50, 'TEST again');
  ok('after the onboarding payment is reversed, the next payment is onboarding again', (await lineOf(again.ledger_entry.id)).kind === 'onboarding' && Number((await lineOf(again.ledger_entry.id)).amount) === 5);
  // no RPN, inactive RPN, credits, charges
  const none = await pay(sd4, 10, 'TEST none');
  ok('no RPN: no line', !(await lineOf(none.ledger_entry.id)));
  await q(`update cl_vendors set rpn_id = $1 where id = $2`, [rpn.Chipo, sd4]);
  const inact = await pay(sd4, 10, 'TEST inactive');
  ok('a suspended RPN earns nothing', !(await lineOf(inact.ledger_entry.id)));
  const cr = j(await as(tok('LED'), `select public.cl_record_ledger_credit($1, 5, 'USD', 'TEST credit', null) j`, [sd1]));
  ok('credits don\'t affect commission', !cr.e && !(await lineOf(cr.ledger_entry.id)), JSON.stringify(cr));
  const ch = (await q(`insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, recorded_by) values ($1, 'charge', 15, 'USD', $2) returning id`, [sd1, staff.SYS]))[0].id;
  ok('charges earn nothing (commission is on money received only)', !(await lineOf(ch)));
  // a future rate applies only from its date; old lines unchanged
  const oldLines = JSON.stringify(await q(`select id, rate_pct, amount from cl_rpn_commissions order by id`));
  const r2 = await setRate('SYS', 20, 8, new Date(Date.now() + 1500).toISOString(), 'TEST later');
  const beforeR2 = await pay(sd1, 100, 'TEST before r2');
  ok('a payment before the new rate\'s date still uses the old rate', Number((await lineOf(beforeR2.ledger_entry.id)).rate_pct) === 5, JSON.stringify(r2));
  await new Promise((res) => setTimeout(res, 1700));
  const afterR2 = await pay(sd1, 100, 'TEST after r2');
  ok('a payment after it uses the new rate (8%)', Number((await lineOf(afterR2.ledger_entry.id)).rate_pct) === 8 && Number((await lineOf(afterR2.ledger_entry.id)).amount) === 8);
  ok('earlier lines are unchanged by the rate change', JSON.stringify(await q(`select id, rate_pct, amount from cl_rpn_commissions where id <= (select max(id) from cl_rpn_commissions) - 2 order by id`)) === oldLines);
  // reassignment: later payments go to the new RPN, earlier lines stay
  await assign('VEN', null, sd1, rpn.Rudo, 'TEST: moved to Rudo');
  const moved = await pay(sd1, 10, 'TEST moved');
  ok('after a reassignment, commission goes to the RPN linked at the time of the payment', (await lineOf(moved.ledger_entry.id)).rpn_id === rpn.Rudo &&
    (await lineOf(p1.ledger_entry.id)).rpn_id === rpn.Tendai);

  // ---- 7. payouts ----
  const dueOf = async (n) => Number((await q(`select public.cl_rpn_due($1, 'USD') d`, [rpn[n]]))[0].d);
  const dueT = await dueOf('Tendai');   // 0 + 2 + 10 + 3 + 5 + 8 = 28
  ok('due to Tendai is the sum of their lines', dueT === 28, dueT);
  const payout = (k, n, amt, ref) => as(tok(k), `select public.cl_pay_rpn_commission($1, $2, 'usd', $3, $4, 'TEST payout') j`, [rpn[n], amt, coa['1000'], ref || null]).then(j);
  ok('pay: RPN Commissions (see only) can\'t pay', /Not authorized/.test((await payout('COM', 'Tendai', 5)).e || ''));
  ok('pay: anonymous refused', /permission denied/.test(j(await as(null, `select public.cl_pay_rpn_commission($1, 1, 'USD', $2) j`, [rpn.Tendai, coa['1000']])).e || ''));
  ok('pay: more than due is refused, saying what is due', /That's more than is due to Tendai: USD 28\.00 is due\./.test((await payout('PAY', 'Tendai', 30)).e || ''));
  ok('pay: from an expense account is refused', /Pay from a cash, bank or mobile-money account/.test(j(await as(tok('PAY'), `select public.cl_pay_rpn_commission($1, 1, 'USD', $2) j`, [rpn.Tendai, coa['5100']])).e || ''));
  const po = await payout('PAY', 'Tendai', 20, 'TEST-REF');
  const cb = (await q(`select direction, amount::text, source_type, coa_account_id from cl_cashbook_entries where id = $1`, [po.cashbook_entry && po.cashbook_entry.id]))[0];
  ok('a payout posts a Cashbook OUT on the paying account and lowers what is due', po.payout && Number(po.due_after) === 8 && cb && cb.direction === 'out' && Number(cb.amount) === 20 &&
    cb.source_type === 'rpn_commission_payout' && cb.coa_account_id === coa['1000'] && po.payout.expense_account_id === coa['5100'], JSON.stringify([po, cb]));
  ok('a double tap pays once', (await payout('PAY', 'Tendai', 20, 'TEST-REF')).duplicate === true && (await q(`select count(*)::int c from cl_rpn_payouts where kind = 'payout'`))[0].c === 1 && await dueOf('Tendai') === 8);
  const rpo = j(await as(tok('PAY'), `select public.cl_reverse_rpn_payout($1, 'TEST: paid the wrong RPN') j`, [po.payout.id]));
  const cbIn = (await q(`select direction, source_type from cl_cashbook_entries where id = $1`, [rpo.cashbook_entry && rpo.cashbook_entry.id]))[0];
  ok('reversing a payout puts the cash back (Cashbook IN) and what is due goes back up', cbIn && cbIn.direction === 'in' && cbIn.source_type === 'rpn_commission_payout_reversal' && await dueOf('Tendai') === 28, JSON.stringify(rpo));
  ok('a payout can be reversed only once', /already reversed/.test(j(await as(tok('PAY'), `select public.cl_reverse_rpn_payout($1, 'again') j`, [po.payout.id])).e || ''));
  await payout('PAY', 'Tendai', 10);

  // ---- 8. reading ----
  const sum = j(await as(tok('COM'), `select public.cl_rpn_commission_summary(null, null) j`));
  const t = sum.find((x) => x.full_name === 'Tendai');
  ok('summary per RPN: accounts, earned onboarding / recurring, paid, due', t && Number(t.earned_onboarding) === 10 && Number(t.earned_recurring) === 18 && Number(t.paid) === 10 && Number(t.due) === 18 && Number(t.accounts) === 1 && Number(t.no_rate_lines) === 1, JSON.stringify(t));
  const ru = sum.find((x) => x.full_name === 'Rudo');
  ok('... Rudo: reversed shows separately', ru && Number(ru.reversed) === -3 && Number(ru.earned_onboarding) === 8, JSON.stringify(ru));
  const lines = j(await as(tok('PAY'), `select public.cl_rpn_commission_lines($1, null, null) j`, [rpn.Tendai]));
  ok('lines show account names (not codes), payment, rate and amount; payouts with the account and who paid', lines.lines.some((l) => l.account === 'Acme' && Number(l.payment_amount) === 100 && Number(l.rate_pct) === 10) &&
    lines.payouts.length === 3 && lines.payouts.some((p) => p.kind === 'reversal') && lines.payouts[0].account === '1000 Cash on Hand' && lines.payouts[0].paid_by === 'Staff PAY', JSON.stringify(lines).slice(0, 400));
  ok('reading: other staff refused', /Not authorized/.test(j(await as(tok('NONE'), `select public.cl_rpn_commission_summary(null, null) j`)).e || ''));
  ok('reading: an RPN token refused (self-service comes later)', /Not authorized/.test(j(await as(rpnTok('Tendai'), `select public.cl_rpn_commission_summary(null, null) j`)).e || ''));
  ok('reading: anonymous refused', /permission denied/.test(j(await as(null, `select public.cl_rpn_commission_summary(null, null) j`)).e || ''));
  ok('the tables themselves can\'t be read through the API', /permission denied/.test((await as(tok('SYS'), `select * from cl_rpn_commissions`)).e || ''));

  // ---- 9. delete guards ----
  const dv = await tryQ(`delete from cl_vendors where id = $1`, [sd3]);
  ok('a vendor with RPN history can\'t be deleted: plain message', /Can't delete "Single Three": it has 1 RPN history entry/.test(dv.e || ''), dv.e);
  const dv1 = await tryQ(`delete from cl_vendors where id = $1`, [sd1]);
  ok('... with commission lines: listed', /RPN commission lines/.test(dv1.e || ''), dv1.e);
  ok('an RPN with commission lines can\'t be deleted', !!(await tryQ(`delete from cl_rpn where id = $1`, [rpn.Tendai])).e && (await q(`select count(*)::int c from cl_rpn where id = $1`, [rpn.Tendai]))[0].c === 1);

  // ---- 10. rollback ----
  e = null; try { await pg.exec(RB); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('the rollback refuses while commission lines or payouts exist, changing nothing', /rollback aborted: commission lines or payouts exist/.test(e || '') &&
    (await q(`select count(*)::int c from cl_rpn_commissions`))[0].c > 0, e);
  await q(`delete from cl_rpn_payouts where kind = 'reversal'`); await q(`delete from cl_rpn_payouts`);
  await q(`delete from cl_cashbook_entries where source_type in ('rpn_commission_payout', 'rpn_commission_payout_reversal')`);
  await q(`delete from cl_rpn_commissions where reverses_commission_id is not null`); await q(`delete from cl_rpn_commissions`);
  await q(`update cl_businesses set rpn_id = null`); await q(`update cl_vendors set rpn_id = null`);
  await pg.exec(RB);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('with none, the rollback restores the exact pre-migration catalogue (policies, guards, grants, constraints)', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('and the migration applies again after a rollback', !e, e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
