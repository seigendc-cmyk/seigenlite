// node supabase/tests/activation-licences-test.js
//
// Tests supabase/migrations/20261010120000_activation_licences.sql (and its
// rollback) in an in-memory PGlite built from the repo (Supabase stub +
// baseline + every applied migration), never the live database. Signs with
// a throwaway test key (never seiGEN's real key) through the Edge Function's
// own signing code (supabase/functions/issue-licence/sign.mjs), and checks the
// licences in the REAL app code (test/harness.js), so the database's payload,
// the signer and the app's verifier are proven to agree.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { makeApp } = require('../../test/harness');

const ROOT = path.join(__dirname, '..');
const FILE = '20261010120000_activation_licences.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261010120000_activation_licences.rollback.sql'));
const KID = 7;   // test key ID; the real key is 1

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = () => crypto.randomBytes(16).toString('hex');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const tagOf = (deviceKey) => {
  const h = crypto.createHash('sha512').update(deviceKey, 'utf8').digest();
  const bits = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4);
  return [0, 1, 2, 3].map((i) => ALPHA[(bits >> (15 - 5 * i)) & 31]).join('');
};
const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

(async () => {
  const { importSigningKey, signPayloadHex } = await import('../functions/issue-licence/sign.mjs');
  const pg = await newPglite();
  const skip = NOT_ON_LIVE_FILES.concat([FILE, '20261011120000_ledger_credits.sql', '20261012120000_payment_reversal_and_duplicate_guards.sql']);   // the shape just before this migration (it and the later ones are on live now)
  await buildFromRepo(pg, { skip });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));

  // ---- as a role, with JWT claims (what PostgREST does with a token) ----
  async function as(role, claims, sql, p) {
    await pg.exec('set role ' + role);
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }
  const anonJ = async (sql, p) => { const x = await as('anon', null, sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };

  // ---- live-like state ----
  await pg.exec(MIG);
  ok('migration applies to the live shape', true);
  let again = null; try { await pg.exec(MIG); } catch (e) { again = e.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /activation_licences aborted: already exists/.test(again || ''), again);

  const staff = {};
  for (const [k, sys, active] of [['A', false, true], ['B', false, true], ['S', true, true], ['D', false, false]]) {
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, $3, now()) returning id`,
      ['Staff ' + k, sys, active]))[0].id;
  }
  const mod = (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), 'activation_codes', 'Activation Codes', 3) returning id`))[0].id;
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now()), ($3, $2, now())`, [staff.A, mod, staff.D]);
  await q(`insert into cl_activation_pricing (id, amount, currency, effective_from, created_at) values (gen_random_uuid(), 10, 'USD', now(), now())`);
  const tok = (who, extra) => Object.assign({ role: 'authenticated', sub: staff[who], user_type: 'staff', is_sysadmin: who === 'S' }, extra || {});

  const K1 = hex(), K2 = hex(), KS = hex(), KW = hex();
  const reg = await anonJ(`select public.cl_branch_register('MAIN0001','Biz Phrase',$1,'Gentronix','Harare','B-ABCD2345','Front') j`, [K1]);
  const jc = (await anonJ(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN0001',p_secret_phrase=>'Biz Phrase',p_device_key=>$1,p_branch_id=>$2::uuid,p_new_branch_name=>null) j`, [K1, reg.branch_id])).code;
  await anonJ(`select public.cl_terminal_join('TILL0002','Biz Phrase',$1,$2) j`, [K2, jc]);
  await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status) values ('Solo Shop','SOLO','Solo Phrase',$1,'onboarding')`, [KS]);
  await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status) values ('Weak Shop','WEAK','Weak Phrase',null,'onboarding')`);
  await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status) values ('Solo Again','SOL2','solo phrase ',$1,'onboarding')`, [hex()]);

  // ---- test signing key (throwaway) ----
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const testPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const signer = await importSigningKey(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
  ok('the Edge Function signer derives the right public key from the PKCS#8 secret', signer.publicKeyB64 === testPub);

  // What the Edge Function does, with a given token: prepare, sign, attach.
  async function issue(claims, args) {
    const p = await as('authenticated', claims, `select public.cl_licence_prepare(p_device_code=>$1, p_business_id=>$2::uuid, p_days=>$3, p_key_id=>${KID}, p_note=>$4) j`,
      [args.device_code || null, args.business_id || null, args.days || 30, args.note || null]);
    if (p.e) return { e: p.e };
    const out = [];
    for (const l of p.r[0].j.licences) {
      const sig = await signPayloadHex(signer.key, l.payload_hex);
      const a = await as('authenticated', claims, `select public.cl_licence_attach($1, $2) j`, [l.serial, sig]);
      if (a.e) return { e: a.e };
      out.push(Object.assign({}, l, a.r[0].j));
    }
    return { licences: out, skipped: p.r[0].j.skipped };
  }

  console.log('who may issue');
  let r = await as('anon', null, `select public.cl_licence_prepare(p_device_code=>'SOLO-${tagOf(KS)}') j`);
  ok('anonymous (anon key): refused by the grants', /permission denied/i.test(r.e || ''), r.e);
  r = await as('authenticated', { role: 'authenticated' }, `select public.cl_licence_prepare(p_device_code=>'SOLO-${tagOf(KS)}') j`);
  ok('a token that is not a staff token: Not authorized', /Not authorized/.test(r.e || ''), r.e);
  r = await issue(tok('B'), { device_code: 'SOLO-' + tagOf(KS) });
  ok('staff WITHOUT the Activation Codes permission: Not authorized', /Not authorized/.test(r.e || ''), r.e);
  r = await issue(tok('D'), { device_code: 'SOLO-' + tagOf(KS) });
  ok('a deactivated staff member (token still unexpired) with the permission: Not authorized', /Not authorized/.test(r.e || ''), r.e);
  r = await issue({ role: 'authenticated', sub: staff.A, user_type: 'rpn' }, { device_code: 'SOLO-' + tagOf(KS) });
  ok('an RPN token: Not authorized', /Not authorized/.test(r.e || ''), r.e);
  r = await as('anon', null, `select * from public.cl_licences`);
  ok('the licence table is not readable with the anon key', /permission denied/i.test(r.e || ''), r.e);
  r = await as('authenticated', tok('A'), `select * from public.cl_licences`);
  ok('... nor with a staff token (only through the RPCs)', /permission denied/i.test(r.e || ''), r.e);

  console.log('issuing');
  const solo = await issue(tok('A'), { device_code: 'solo-' + tagOf(KS).toLowerCase(), note: 'first' });
  ok('staff WITH the permission issues for a device code', !solo.e && solo.licences.length === 1, solo.e);
  const L = solo.licences[0];
  ok('strong binding (the server knew the device key)', L.strong_binding === true);
  ok('the short code looks like XXXX-XXXX-XX', /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/.test(L.short_code), L.short_code);
  const raw = b64url(L.licence.slice(4));
  const payload = raw.subarray(0, raw.length - 64), sig = raw.subarray(raw.length - 64);
  ok('the licence verifies with the test public key (Node crypto)', crypto.verify(null, payload, publicKey, sig));
  ok('payload: version 2, key ID, serial, install ID, binding = sha512(device key)',
    payload[0] === 2 && payload[1] === KID && payload.readUInt32BE(2) === L.serial && payload.subarray(6, 14).toString('latin1') === 'SOLO\0\0\0\0'
    && payload.subarray(14, 22).equals(crypto.createHash('sha512').update(KS, 'utf8').digest().subarray(0, 8)) && payload.length === 30);
  const days = (d) => Math.round((Date.parse(d) - Date.UTC(2026, 0, 1)) / 86400000);
  ok('payload: issued / valid-until days match the row, 30 days apart', payload.readUInt16BE(22) === days(L.valid_from) && payload.readUInt16BE(24) === days(L.valid_to)
    && payload.readUInt16BE(24) - payload.readUInt16BE(22) === 30);
  const row = (await q(`select * from cl_licences where serial = $1`, [L.serial]))[0];
  ok('the short code itself is stored nowhere (only its sha256)', !JSON.stringify(row).includes(L.short_code.replace(/-/g, ''))
    && row.short_code_hash === crypto.createHash('sha256').update(L.short_code.replace(/-/g, '')).digest('hex'));
  ok('row: issued, by staff A, signed', row.status === 'issued' && row.issued_by === staff.A && row.signed_at);
  const charge = (await q(`select amount, currency, notes from cl_ledger_entries where id = $1`, [row.ledger_entry_id]))[0];
  ok('the automatic ledger charge is written (rate per 30 days)', charge && Number(charge.amount) === 10 && /licence #/.test(charge.notes), JSON.stringify(charge));
  const log = (await q(`select staff_id, action, detail from cl_activity_log where action = 'issue_licence' order by created_at desc limit 1`))[0];
  ok('the activity log records who issued it', log && log.staff_id === staff.A && log.detail.serial === L.serial, JSON.stringify(log));

  r = await issue(tok('A'), { device_code: 'SOLO-AAAA', days: 30 });
  ok('a mistyped device tag (server knows the key) is refused: DEVICE_CODE_MISMATCH', /DEVICE_CODE_MISMATCH/.test(r.e || ''), r.e);
  r = await issue(tok('A'), { device_code: 'SOLO', days: 30 });
  ok('a device code without the tag is refused', /must look like/.test(r.e || ''), r.e);
  r = await issue(tok('A'), { device_code: 'SOLO-' + tagOf(KS), days: 45 });
  ok('days other than 30 / 90 / 365 are refused', /30, 90 or 365/.test(r.e || ''), r.e);
  const s365 = await issue(tok('S'), { device_code: 'SOLO-' + tagOf(KS), days: 365 });
  ok('a sysadmin (no module) may issue; 365 days', !s365.e && s365.licences[0].days === 365, s365.e);
  const charge365 = (await q(`select l.amount from cl_ledger_entries l join cl_licences c on c.ledger_entry_id = l.id where c.serial = $1`, [s365.licences[0].serial]))[0];
  ok('... charged 365/30 of the rate', Number(charge365.amount) === Math.round(10 * 365 / 30 * 100) / 100, JSON.stringify(charge365));

  const weakTag = tagOf(KW);
  const weak = await issue(tok('A'), { device_code: 'WEAK-' + weakTag });
  ok('a device the server has no key for: weak binding from the typed tag', !weak.e && weak.licences[0].strong_binding === false, weak.e);

  const biz = await issue(tok('A'), { business_id: reg.business_id, days: 90 });
  ok('per business: one licence per active till (T1, T2), 90 days', !biz.e && biz.licences.length === 2
    && biz.licences.map((x) => x.till_code).sort().join() === 'T1,T2' && biz.licences.every((x) => x.days === 90 && x.business_id === reg.business_id), biz.e || JSON.stringify(biz.skipped));
  const bp = b64url(biz.licences[0].licence.slice(4));
  ok('a registered till\'s payload carries the business ID (46 bytes)', bp.length === 46 + 64 && (bp[27] & 2) === 2
    && bp.subarray(30, 46).toString('hex') === reg.business_id.replace(/-/g, ''));

  // attach rules
  const p2 = await as('authenticated', tok('A'), `select public.cl_licence_prepare(p_device_code=>$1, p_key_id=>${KID}) j`, ['SOLO-' + tagOf(KS)]);
  const ser = p2.r[0].j.licences[0].serial;
  r = await as('authenticated', tok('S'), `select public.cl_licence_attach($1, $2) j`, [ser, '00'.repeat(64)]);
  ok('only the staff member who prepared a licence may attach its signature', /Only the staff member/.test(r.e || ''), r.e);
  r = await as('authenticated', tok('A'), `select public.cl_licence_attach($1, $2) j`, [ser, 'abcd']);
  ok('a signature must be 64 bytes', /64 bytes/.test(r.e || ''), r.e);
  r = await as('authenticated', tok('A'), `select public.cl_licence_attach($1, $2) j`, [L.serial, '00'.repeat(64)]);
  ok('an issued licence can\'t be re-signed', /already issued/.test(r.e || ''), r.e);

  console.log('the app accepts what the server issued');
  const app = (installId, deviceKey) => {
    const A = makeApp({ install_id: installId, device_key: deviceKey, install_date: '2026-09-01T08:00:00Z', secret_phrase: 'x' });
    A.api.LICENCE_PUBLIC_KEYS[KID] = testPub;
    return A;
  };
  const now = new Date();
  let A = app('SOLO', KS); await A.api.establishTrustedTime(now);
  let res = await A.api.applyLicence(L.licence, 'paste');
  ok('SOLO device: the licence activates', res.ok && res.serial === L.serial, JSON.stringify(res));
  ok('... licenceDeviceCode() is what staff typed', A.api.licenceDeviceCode() === 'SOLO-' + tagOf(KS));
  A = app('SOLO', hex()); await A.api.establishTrustedTime(now);
  res = await A.api.applyLicence(L.licence, 'paste');
  ok('another device with the same install ID: other_device', !res.ok && res.reason === 'other_device', JSON.stringify(res));
  A = app('WEAK', KW); await A.api.establishTrustedTime(now);
  res = await A.api.applyLicence(weak.licences[0].licence, 'paste');
  ok('WEAK device (weak binding): activates', res.ok, JSON.stringify(res));
  A = app('TILL0002', K2); await A.api.establishTrustedTime(now);
  res = await A.api.applyLicence(biz.licences.find((x) => x.till_code === 'T2').licence, 'link');
  ok('registered T2: its own licence activates', res.ok, JSON.stringify(res));
  res = await A.api.applyLicence(biz.licences.find((x) => x.till_code === 'T1').licence, 'link');
  ok('registered T2: T1\'s licence is refused (per till)', !res.ok && res.reason === 'other_device', JSON.stringify(res));

  console.log('redeeming a short code (device-authenticated, single use, rate-limited)');
  const redeem = (inst, phrase, key, code) => as('anon', null, `select public.cl_licence_redeem($1,$2,$3,$4) j`, [inst, phrase, key, code]);
  const w = await issue(tok('A'), { device_code: 'SOLO-' + tagOf(KS) });
  const W = w.licences[0];
  r = await redeem('SOLO', 'wrong phrase', KS, W.short_code);
  ok('wrong phrase: refused', /phrase does not match/.test(r.e || ''), r.e);
  r = await redeem('SOLO', 'Solo Phrase', hex(), W.short_code);
  ok('right install + phrase but another device key: refused', /another device/.test(r.e || ''), r.e);
  r = await redeem('SOL2', 'solo phrase', (await q(`select device_key from cl_vendors where install_id='SOL2'`))[0].device_key, W.short_code);
  ok('a real, registered OTHER device using this code: WRONG_DEVICE', r.r && r.r[0].j.error === 'WRONG_DEVICE', JSON.stringify(r));
  r = await redeem('SOLO', 'Solo Phrase', KS, 'AAAA-BBBB-CC');
  ok('a code that doesn\'t exist: INVALID_CODE', r.r && r.r[0].j.error === 'INVALID_CODE', JSON.stringify(r));
  r = await redeem('SOLO', 'Solo Phrase', KS, W.short_code.toLowerCase().replace(/-/g, ' '));
  ok('the right device redeems it (case and separators don\'t matter)', r.r && r.r[0].j.licence === W.licence, JSON.stringify(r));
  A = app('SOLO', KS); await A.api.establishTrustedTime(now);
  ok('... and the app accepts the returned licence', (await A.api.applyLicence(r.r[0].j.licence, 'code')).ok);
  r = await redeem('SOLO', 'Solo Phrase', KS, W.short_code);
  ok('the same device retrying within 10 minutes gets it again (a dropped answer)', r.r && r.r[0].j.again === true);
  await q(`update cl_licences set redeemed_at = now() - interval '11 minutes' where serial = $1`, [W.serial]);
  r = await redeem('SOLO', 'Solo Phrase', KS, W.short_code);
  ok('after that: ALREADY_USED (single use)', r.r && r.r[0].j.error === 'ALREADY_USED', JSON.stringify(r));
  const x = (await issue(tok('A'), { device_code: 'SOLO-' + tagOf(KS) })).licences[0];
  await as('authenticated', tok('A'), `select public.cl_licence_revoke($1, 'leaked') j`, [x.serial]);
  r = await redeem('SOLO', 'Solo Phrase', KS, x.short_code);
  ok('a revoked licence: REVOKED', r.r && r.r[0].j.error === 'REVOKED', JSON.stringify(r));
  const y = (await issue(tok('A'), { device_code: 'SOLO-' + tagOf(KS) })).licences[0];
  await q(`update cl_licences set valid_from = current_date - 40, valid_to = current_date - 10 where serial = $1`, [y.serial]);
  r = await redeem('SOLO', 'Solo Phrase', KS, y.short_code);
  ok('an expired licence: EXPIRED', r.r && r.r[0].j.error === 'EXPIRED', JSON.stringify(r));
  // rate limit: SOLO has 1 failure so far (INVALID_CODE); 4 more, then a good code is refused too
  for (let i = 0; i < 4; i++) await redeem('SOLO', 'Solo Phrase', KS, 'ZZZZ-ZZZZ-Z' + 'ABCD'[i]);
  const z = (await issue(tok('A'), { device_code: 'SOLO-' + tagOf(KS) })).licences[0];
  r = await redeem('SOLO', 'Solo Phrase', KS, z.short_code);
  ok('after 5 failures in 15 minutes: TOO_MANY_TRIES, even for a good code', r.r && r.r[0].j.error === 'TOO_MANY_TRIES', JSON.stringify(r));
  await q(`update cl_licence_redeem_failures set ts = ts - interval '16 minutes' where install_id = 'SOLO'`);
  r = await redeem('SOLO', 'Solo Phrase', KS, z.short_code);
  ok('... and after 15 minutes the good code works', r.r && r.r[0].j.licence === z.licence, JSON.stringify(r));

  console.log('automatic delivery to a registered till (check-in)');
  const pend = (inst, phrase, key, after) => as('anon', null, `select public.cl_licence_pending($1,$2,$3,$4) j`, [inst, phrase, key, after]);
  const t2 = biz.licences.find((x) => x.till_code === 'T2');
  r = await pend('TILL0002', 'Biz Phrase', K2, 0);
  ok('T2 receives its newest licence', r.r && r.r[0].j.serial === t2.serial && r.r[0].j.licence === t2.licence, JSON.stringify(r));
  r = await pend('TILL0002', 'Biz Phrase', K2, t2.serial);
  ok('nothing newer than the one it has: null', r.r && r.r[0].j.licence === null, JSON.stringify(r));
  r = await pend('TILL0002', 'Biz Phrase', hex(), 0);
  ok('another device key: refused', /another device/.test(r.e || ''), r.e);
  ok('the delivered licence is marked redeemed via check-in', (await q(`select status, redeemed_via from cl_licences where serial = $1`, [t2.serial]))[0].redeemed_via === 'checkin');

  console.log('staff tools');
  r = await as('authenticated', tok('A'), `select public.cl_licence_list(p_install_id=>'solo') j`);
  ok('list by install ID (newest first, with who issued)', r.r && r.r[0].j.length >= 5 && r.r[0].j[0].issued_by === 'Staff A', r.e);
  r = await as('authenticated', tok('B'), `select public.cl_licence_list() j`);
  ok('list needs the permission too', /Not authorized/.test(r.e || ''), r.e);
  r = await as('authenticated', tok('A'), `select public.cl_vendor_repeat_installs(90) j`);
  const grp = r.r && r.r[0].j.find((g) => g.install_ids.includes('SOLO'));
  ok('repeat installs: SOLO and SOL2 share a phrase (case/space-insensitive), labelled by a hash, not the phrase',
    grp && grp.installs === 2 && grp.install_ids.includes('SOL2') && !JSON.stringify(r.r[0].j).toLowerCase().includes('solo phrase'), JSON.stringify(r));
  r = await as('anon', null, `select public.cl_vendor_repeat_installs(90) j`);
  ok('repeat installs: anonymous refused', /permission denied/i.test(r.e || ''), r.e);

  console.log('rollback');
  await pg.exec(RB);
  const after = fingerprint(await snapshot(q));
  const d = diff(before, after);
  ok('the rollback restores the exact pre-migration catalogue', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 800));
  await pg.exec(MIG);
  ok('and the migration applies again after a rollback', true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
