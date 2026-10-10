// node supabase/tests/trial-rules-test.js
//
// Tests supabase/migrations/20261019120000_trial_rules.sql (and its rollback)
// in an in-memory PGlite built from the repo, never the live database:
// phone numbers, the refusals (no RPN, wrong PIN, suspended RPN, rate limits,
// phone already used in any spelling, Q8 old sales, one per business), the
// trial and its licence payload, idempotency, cover for joined tills, the
// SysAdmin exception, no ledger entry and no commission, the Console lists,
// grants, the delete guards and the rollback.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261019120000_trial_rules.sql';
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
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p, role) {
    await pg.exec('set role ' + (role || (claims ? 'authenticated' : 'anon')));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }
  const staff = {};
  for (const [k, sys] of [['SYS', true], ['ACT', false], ['RPND', false], ['NONE', false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, true, now()) returning id`, ['Staff ' + k, sys]))[0].id;
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });
  const modId = async (k) => ((await q(`select id from cl_modules where key = $1`, [k]))[0] || {}).id ||
    (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [k]))[0].id;
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff.ACT, await modId('activation_codes')]);
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff.RPND, await modId('rpn_directory')]);

  // RPNs: RPN-014 (active, PIN 123456), RPN-020 (suspended, PIN 222222)
  const rpn = {};
  for (const [ff, active, pin] of [['RPN-014', true, '123456'], ['RPN-020', false, '222222']]) {
    rpn[ff] = (await q(`insert into cl_rpn (id, full_name, passcode_hash, verification_code, verification_used, active, created_at, field_force_no)
      values (gen_random_uuid(), $1, 'x', $3 || '-v', false, $2, now(), $3) returning id`, ['Agent ' + ff, active, ff]))[0].id;
    await q(`insert into cl_rpn_pins (rpn_id, pin_hash) values ($1, extensions.crypt($2, extensions.gen_salt('bf')))`, [rpn[ff], pin]);
  }

  const KEY = {}; const key = (iid) => (KEY[iid] = KEY[iid] || crypto.randomBytes(16).toString('hex'));
  const PH = {};
  const devRaw = async (sql, p) => { const x = await as(null, sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };
  const checkin = (iid, phrase, name) => { PH[iid] = phrase; return devRaw(`select public.cl_device_checkin(p_install_id=>$1, p_shop_secret_phrase=>$2, p_device_code=>$1, p_business_name=>$3, p_device_key=>$4) j`, [iid, phrase, name, key(iid)]); };

  // Before the migration: shops that exist already
  await checkin('SHP1', 'Shop One Phrase', 'Mandie Babyware');
  const acme = await devRaw(`select public.cl_branch_register($1, $2, $3, 'Acme', 'Harare', 'B-HARARE01') j`, ['AC01', 'Acme Phrase', key('AC01')]); PH.AC01 = 'Acme Phrase';
  const jc = await devRaw(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>$4::uuid, p_new_branch_name=>null) j`, ['AC01', 'Acme Phrase', key('AC01'), acme.branch_id]);
  await devRaw(`select public.cl_terminal_join($1, $2, $3, $4) j`, ['AC02', 'Acme Phrase', key('AC02'), jc.code]); PH.AC02 = 'Acme Phrase';

  let e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('the migration applies', !e, e);
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /trial_rules aborted: already there/.test(e || ''), e);
  ok('existing licences and their rows are untouched (no trial rows yet)', (await q(`select count(*)::int c from cl_licences where kind <> 'paid'`))[0].c === 0);

  // ---- phone numbers ----
  const norm = async (p) => (await q(`select public.cl_norm_phone($1) n`, [p]))[0].n;
  const same = ['0772 123 456', '+263 772 123 456', '263772123456', '00263772123456', '772123456', '+263-77-212-3456', '(0772) 123456'];
  const got = await Promise.all(same.map(norm));
  ok('07…, +263…, 263…, 00263… and 9 digits are the same number', got.every((g) => g === '263772123456'), JSON.stringify(got));
  ok('other Zimbabwe mobiles (071, 073, 078) are accepted', (await norm('0712345678')) === '263712345678' && (await norm('0732345678')) === '263732345678' && (await norm('0782345678')) === '263782345678');
  ok('a landline, a short number, letters and an unknown country without + are refused',
    (await norm('0242123456')) === null && (await norm('07721234')) === null && (await norm('07721234ab')) === null && (await norm('447700900123')) === null && (await norm('')) === null);
  ok('another country with its code is accepted', (await norm('+44 7700 900123')) === '447700900123');

  // ---- requests ----
  const req = async (iid, o) => {
    o = o || {};
    const x = await as(null, `select public.cl_trial_request(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_phone=>$4, p_field_force_no=>$5, p_pin=>$6, p_earliest_sale=>$7::date, p_key_id=>$8) j`,
      [iid, PH[iid], o.key || key(iid), o.phone === undefined ? '0772 123 456' : o.phone, o.ff === undefined ? 'RPN-014' : o.ff, o.pin === undefined ? '123456' : o.pin, o.sale || null, o.kid || 1]);
    return x.e ? { raised: x.e } : x.r[0].j;
  };
  let r = await as(null, `select public.cl_trial_request('NOPE', 'x', 'y', '0772123456', 'RPN-014', '123456', null, 1) j`);
  ok('an unregistered device gets nothing', /not registered/.test(r.e || ''), r.e);
  r = await req('SHP1', { key: 'another-device' });
  ok('the wrong device key gets nothing', /registered to another device/.test(r.raised || ''), JSON.stringify(r));
  r = await req('SHP1', { phone: '0242 123 456' });
  ok('a phone number that isn\'t a mobile is refused with the plain message', r.ok === false && r.code === 'PHONE_INVALID' && /owner's phone number/.test(r.message), JSON.stringify(r));
  r = await req('SHP1', { ff: '', pin: '' });
  ok('no RPN: no trial', r.ok === false && r.code === 'RPN_MISSING', JSON.stringify(r));
  r = await req('SHP1', { pin: '999999' });
  ok('a wrong PIN: no trial (the existing message)', r.ok === false && r.code === 'RPN_NO_MATCH' && /don't match/.test(r.message), JSON.stringify(r));
  r = await req('SHP1', { ff: 'RPN-020', pin: '222222' });
  ok('a suspended RPN: no trial', r.ok === false && r.code === 'RPN_SUSPENDED' && /isn't active/.test(r.message), JSON.stringify(r));
  r = await req('SHP1', { sale: '2026-01-01' });
  ok('Q8: sales older than 30 days, no trial (the date in the message)', r.ok === false && r.code === 'TRIAL_OLD_DATA' && /sales from 1 Jan 2026/.test(r.message), JSON.stringify(r));
  ok('nothing was linked or recorded by the refusals', (await q(`select count(*)::int c from cl_trials`))[0].c === 0 && (await q(`select rpn_id from cl_vendors where install_id = 'SHP1'`))[0].rpn_id === null);
  ok('every refusal is kept', (await q(`select count(*)::int c from cl_trial_refusals where install_id = 'SHP1'`))[0].c === 5);

  const today = (await q(`select (now() at time zone 'Africa/Harare')::date::text d`))[0].d;
  r = await req('SHP1', { phone: '+263 772 123 456', sale: today });
  ok('online + RPN + a new phone: the trial is granted, 30 days, with its payload to sign', r.ok === true && r.kind === 'standard' && r.licence === null &&
    /^[0-9a-f]+$/.test(r.payload_hex) && r.payload_hex.length === 60, JSON.stringify(r));
  const T1 = r;
  const lrow = (await q(`select * from cl_licences where serial = $1`, [T1.serial]))[0];
  const pay = Buffer.from(T1.payload_hex, 'hex');
  ok('the payload: version 2, key 1, the serial, the install ID, strong binding to the device key, the trial bit (4)',
    pay[0] === 2 && pay[1] === 1 && pay.readUInt32BE(2) === T1.serial && pay.subarray(6, 10).toString() === 'SHP1' &&
    pay.subarray(14, 22).equals(crypto.createHash('sha512').update(key('SHP1')).digest().subarray(0, 8)) && pay[27] === (1 | 4), T1.payload_hex);
  ok('…ending 30 days from today', pay.readUInt16BE(24) - pay.readUInt16BE(22) === 30);
  ok('the licence row: kind trial, no staff, no price, no ledger entry', lrow.kind === 'trial' && lrow.issued_by === null && lrow.amount === null && lrow.ledger_entry_id === null && lrow.status === 'pending');
  ok('the RPN is linked to the shop', (await q(`select rpn_id from cl_vendors where install_id = 'SHP1'`))[0].rpn_id === rpn['RPN-014']);
  ok('the trial records the normalised phone, the RPN and the shop', (await q(`select phone_norm, rpn_id, shop_name, kind from cl_trials`))
    .every((t) => t.phone_norm === '263772123456' && t.rpn_id === rpn['RPN-014'] && t.shop_name === 'Mandie Babyware' && t.kind === 'standard'));
  ok('no ledger entry and no commission line', (await q(`select count(*)::int c from cl_ledger_entries`))[0].c === 0 && (await q(`select count(*)::int c from cl_rpn_commissions`))[0].c === 0);

  r = await req('SHP1', { phone: '0772 999 999', ff: '', pin: '' });
  ok('the same install asking again gets the SAME trial (idempotent, even with other details)', r.ok && r.serial === T1.serial && r.payload_hex === T1.payload_hex &&
    (await q(`select count(*)::int c from cl_trials`))[0].c === 1 && (await q(`select count(*)::int c from cl_licences where kind = 'trial'`))[0].c === 1, JSON.stringify(r));

  // signing: only the service role stores the signature
  const sig = 'ab'.repeat(64);
  r = await as(null, `select public.cl_trial_attach($1, $2) j`, [T1.serial, sig]);
  ok('a device (anon) can\'t store a signature', /permission denied/.test(r.e || ''), r.e);
  r = await as(tok('SYS'), `select public.cl_trial_attach($1, $2) j`, [T1.serial, sig]);
  ok('staff (even SysAdmin) can\'t either', /permission denied/.test(r.e || ''), r.e);
  r = await as(null, `select public.cl_trial_attach($1, $2) j`, [T1.serial, sig], 'service_role');
  const L1 = r.r && r.r[0].j;
  ok('the service role (the Edge Function) stores it: the licence is issued', L1 && /^SL2\./.test(L1.licence) &&
    (await q(`select status from cl_licences where serial = $1`, [T1.serial]))[0].status === 'issued', JSON.stringify(r));
  r = await as(null, `select public.cl_trial_attach($1, $2) j`, [T1.serial, 'cd'.repeat(64)], 'service_role');
  ok('attaching again changes nothing (answers the stored licence)', r.r && r.r[0].j.again === true && r.r[0].j.licence === L1.licence);
  r = await req('SHP1');
  ok('asking again now answers the signed licence', r.ok && r.licence === L1.licence && !r.payload_hex);
  r = await as(null, `select public.cl_licence_pending($1, $2, $3, 0) j`, ['SHP1', PH.SHP1, key('SHP1')]);
  ok('a lost answer reaches the till at check-in (cl_licence_pending)', r.r && r.r[0].j.licence === L1.licence, JSON.stringify(r));

  // ---- the same phone again, in any spelling ----
  await q();   // the refusals above count towards this phone's hourly limit
  await q(`delete from cl_trial_refusals`);   // the refusals above count towards this phone's hourly limit
  await checkin('SHP2', 'Shop One Phrase', 'Mandie Babyware');   // a reinstall: new install ID, same phrase
  r = await req('SHP2', { phone: '0772123456' });
  ok('a reinstall with the same phone (07… against +263…) is refused with the plain message', r.ok === false && r.code === 'PHONE_USED' &&
    r.message === 'This phone number has already used its free trial. Ask your RPN about a licence.', JSON.stringify(r));
  r = await req('SHP2', { phone: '00263 77 212 3456' });
  ok('…and in another spelling', r.code === 'PHONE_USED');

  // ---- rate limits ----
  for (let i = 0; i < 3; i++) await req('SHP2', { phone: '0772123456' });
  r = await req('SHP2', { phone: '0772123456' });
  ok('5 refusals for one phone in an hour: "too many tries"', r.code === 'TOO_MANY_TRIES', JSON.stringify(r));
  for (let i = 0; i < 10; i++) { await checkin('PN' + String(i).padStart(2, '0'), 'P' + i, 'Prober ' + i); await req('PN' + String(i).padStart(2, '0'), { phone: '07733300' + String(i).padStart(2, '0'), pin: '000000' }); }
  await checkin('PN99', 'P99', 'Prober 99');
  r = await req('PN99', { phone: '0773330099' });
  ok('10 wrong PINs for one field force number in an hour (across installs): refused even with the right PIN', r.code === 'RPN_TOO_MANY_TRIES', JSON.stringify(r));
  await q(`delete from cl_rpn_link_failures`); await q(`delete from cl_trial_refusals where install_id like 'PN%'`);

  // ---- businesses: the main's trial covers the tills that join ----
  r = await req('AC02', { phone: '0712000001' });
  ok('a joined till of a business with no trial: refused, plain message', r.ok === false && r.code === 'NO_BUSINESS_TRIAL', JSON.stringify(r));
  r = await req('AC01', { phone: '0712000001', sale: null });
  ok('the main till (it created the business) starts the business\'s trial', r.ok && r.kind === 'standard', JSON.stringify(r));
  const TA = r;
  ok('…bound to the business (payload carries the business ID)', Buffer.from(TA.payload_hex, 'hex')[27] === (1 | 2 | 4) && TA.payload_hex.length === 92);
  r = await req('AC02', { phone: '', ff: '', pin: '' });
  ok('the joined till gets a cover licence to the SAME end date, with no phone or RPN', r.ok && r.kind === 'cover' && r.valid_to === TA.valid_to && r.trial_id === TA.trial_id, JSON.stringify(r));
  r = await req('AC02');
  ok('…once (asking again answers the same cover)', r.ok && r.kind === 'cover' && (await q(`select count(*)::int c from cl_licences where install_id = 'AC02' and kind = 'trial'`))[0].c === 1);
  const c3 = await devRaw(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>null, p_new_branch_name=>'Murehwa') j`, ['AC01', 'Acme Phrase', key('AC01')]);
  await devRaw(`select public.cl_terminal_join($1, $2, $3, $4) j`, ['MU01', 'Acme Phrase', key('MU01'), c3.code]); PH.MU01 = 'Acme Phrase';
  await q(`update cl_trials set started_on = started_on - 40, ends_on = (now() at time zone 'Africa/Harare')::date where id = $1`, [TA.trial_id]);
  r = await req('MU01');
  ok('a till joining on the trial\'s last day is refused', r.code === 'TRIAL_ENDS_TODAY', JSON.stringify(r));
  await q(`update cl_trials set ends_on = (now() at time zone 'Africa/Harare')::date - 1 where id = $1`, [TA.trial_id]);
  r = await req('MU01');
  ok('a till added after the trial ended needs a paid licence (plain message with the date)', r.code === 'BUSINESS_TRIAL_ENDED' && /trial ended on \d+ \w{3} 2026/.test(r.message), JSON.stringify(r));
  ok('the RPN was linked to the business, not just the device', (await q(`select rpn_id from cl_businesses where id = $1`, [acme.business_id]))[0].rpn_id === rpn['RPN-014']);

  // a second main for the same business can't happen; another business with the same owner phone can't get a trial
  await devRaw(`select public.cl_branch_register($1, $2, $3, 'Beta', 'Gweru', 'B-GWERU001') j`, ['BE01', 'Beta Phrase', key('BE01')]); PH.BE01 = 'Beta Phrase';
  r = await req('BE01', { phone: '+263712000001' });
  ok('another business with an owner phone that already had a trial is refused', r.code === 'PHONE_USED');

  // ---- SysAdmin exception ----
  let x = await as(tok('ACT'), `select public.cl_trial_exception_grant('0712000001', null, 30, 'Lost phone, new install') j`);
  ok('only a SysAdmin can grant an exception trial', /only a SysAdmin/.test(x.e || ''), x.e);
  x = await as(tok('SYS'), `select public.cl_trial_exception_grant('0712000001', null, 30, '') j`);
  ok('…with a reason', /Give a reason/.test(x.e || ''), x.e);
  x = await as(tok('SYS'), `select public.cl_trial_exception_grant(null, 'be01', 14, 'Genuine new shop, owner shares a phone') j`);
  ok('a SysAdmin grants an allowance for an install (logged)', x.r && x.r[0].j.install_id === 'BE01' &&
    (await q(`select count(*)::int c from cl_activity_log where action = 'trial_exception_granted'`))[0].c === 1, JSON.stringify(x));
  r = await req('BE01', { phone: '+263712000001' });
  ok('the device\'s next request uses it: an exception trial of its days', r.ok && Buffer.from(r.payload_hex, 'hex').readUInt16BE(24) - Buffer.from(r.payload_hex, 'hex').readUInt16BE(22) === 14 &&
    (await q(`select kind from cl_trials where install_id = 'BE01'`))[0].kind === 'exception' &&
    (await q(`select used_at is not null u from cl_trial_exceptions`))[0].u === true, JSON.stringify(r));
  await checkin('BE09', 'Beta Nine', 'Beta Nine');
  r = await req('BE09', { phone: '+263712000001' });
  ok('…once: the next one is refused again', r.code === 'PHONE_USED');

  // ---- Console ----
  x = await as(tok('NONE'), `select public.cl_trials_list(null) j`);
  ok('staff without Activation Codes can\'t list trials', /Not authorized/.test(x.e || ''), x.e);
  x = await as(tok('ACT'), `select public.cl_trials_list(null) j`);
  const list = x.r && x.r[0].j;
  const shp = list && list.find((t) => t.install_id === 'SHP1'), ac = list && list.find((t) => t.install_id === 'AC01');
  ok('the Trials list: shop, phone, RPN, dates, status, tills covered, not converted', list && list.length === 3 && shp.shop === 'Mandie Babyware' &&
    shp.phone_norm === '263772123456' && shp.rpn_ff === 'RPN-014' && shp.status === 'running' && shp.converted === false &&
    ac.tills === 2 && ac.status === 'ended' && ac.shop === 'Acme', JSON.stringify(x).slice(0, 700));
  ok('…the exception\'s reason shows; flags: busy RPN (3 trials in a week), not a shared phrase', list && shp.flags.join() === 'busy_rpn' && list.find((t) => t.install_id === 'BE01').exception_reason === 'Genuine new shop, owner shares a phone');
  x = await as(tok('ACT'), `select public.cl_trial_refusals_list(null) j`);
  const rf = x.r && x.r[0].j;
  ok('the refused attempts, with counts per RPN by reason', rf && rf.refusals.length > 5 && rf.per_rpn.some((p) => p.rpn_ff === 'RPN-014' && p.by_code.PHONE_USED >= 2), JSON.stringify(rf && rf.per_rpn));
  x = await as(tok('RPND'), `select public.cl_rpn_trial_stats() j`);
  ok('RPN Directory: trials per RPN', x.r && x.r[0].j[rpn['RPN-014']].trials === 3 && x.r[0].j[rpn['RPN-014']].running === 2 && x.r[0].j[rpn['RPN-020']].trials === 0, JSON.stringify(x));
  x = await as(tok('ACT'), `select public.cl_trial_exceptions_list() j`);
  ok('the exceptions list shows who granted what, and when it was used', x.r && x.r[0].j[0].granted_by === 'Staff SYS' && x.r[0].j[0].used_at, JSON.stringify(x));
  // converted to paid: a ledger payment after the trial
  const shpVendor = (await q(`select id from cl_vendors where install_id = 'SHP1'`))[0].id;
  await q(`insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, recorded_by, notes) values ($1, 'payment', 10, 'USD', $2, 'test')`, [shpVendor, staff.SYS]);
  x = await as(tok('ACT'), `select public.cl_trials_list(null) j`);
  ok('a payment after the trial marks it converted', x.r[0].j.find((t) => t.install_id === 'SHP1').converted === true);

  // ---- grants ----
  for (const t of ['cl_trials', 'cl_trial_refusals', 'cl_trial_exceptions']) {
    const a = await as(null, `select count(*) from ${t}`), b = await as(tok('SYS'), `select count(*) from ${t}`);
    ok(t + ': no API access', /permission denied/.test(a.e || '') && /permission denied/.test(b.e || ''));
  }
  x = await as(null, `select public.cl_trials_list(null) j`);
  ok('anon can\'t list trials', /permission denied/.test(x.e || ''));
  x = await as(null, `select public.cl_norm_phone('0772123456') j`);
  ok('internal helpers aren\'t callable through the API', /permission denied/.test(x.e || ''));

  // ---- the staff path is unchanged: a paid licence still needs staff, still charges ----
  e = null; try { await q(`insert into cl_licences (key_id, install_id, device_tag, binding, strong_binding, days, valid_from, valid_to, payload, short_code_hash, issued_by)
    values (1, 'SHP1', 'AAAA', '\\x0000000000000000', true, 30, current_date, current_date + 30, '\\x', 'h1', null)`); } catch (y) { e = y.message; }
  ok('a paid licence without a staff member is refused', /cl_licences_kind_shape/.test(e || ''), e);

  // ---- delete guards ----
  e = null; try { await q(`delete from cl_vendors where install_id = 'SHP2'`); } catch (y) { e = y.message; }
  ok('a vendor with no trial can still be deleted (guard passes)', e === null || !/free trial/.test(e), e);
  e = null; try { await q(`delete from cl_vendors where install_id = 'SHP1'`); } catch (y) { e = y.message; }
  ok('the vendor delete guard counts trials', /free trial/.test(e || ''), e);
  e = null; try { await q(`delete from cl_businesses where id = $1`, [acme.business_id]); } catch (y) { e = y.message; }
  ok('the business delete guard counts trials', /free trial/.test(e || ''), e);

  // ---- rollback ----
  e = null; try { await pg.exec(RB); } catch (y) { e = y.message; } await pg.exec('rollback').catch(() => {});
  ok('the rollback refuses while trials exist', /trials exist/.test(e || ''), e);
  await q(`delete from cl_licences where kind = 'trial'`);
  await q(`update cl_trial_exceptions set used_by_trial = null`);
  await q(`delete from cl_trials`); await q(`delete from cl_trial_exceptions`); await q(`delete from cl_trial_refusals`);
  e = null; try { await pg.exec(RB); } catch (y) { e = y.message; }
  ok('without trials the rollback runs', !e, e);
  const after = fingerprint(await snapshot(q));
  const d = diff(before, after);
  ok('…and restores the exact catalogue', d.onlyA.length === 0 && d.onlyB.length === 0 && d.changed.length === 0, JSON.stringify(d).slice(0, 600));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
