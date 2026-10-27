// node supabase/tests/removed-devices-test.js
//
// Tests supabase/migrations/20261113180000_removed_devices.sql (v36 Fix-A:
// A1, decision 34; A5) and its rollback in an in-memory PGlite built from the
// repo (the live shape), never the live database:
//   - a vendor row deleted before the list existed (the purge) is listed from
//     the activity log; one whose install has a vendor row again is not;
//   - a listed device's check-in is refused (DEVICE_REMOVED) and no vendor row
//     is made; its other device calls (register) are refused too;
//   - a device whose last vendor id is gone is refused, nothing created;
//   - a new install registers as before; a registered device is answered as
//     before, with or without its last vendor id;
//   - every later vendor delete adds the device (with the reason given);
//   - devices can't read the list; cl_company_info answers anon with the
//     Console's company name, address and website;
//   - only the two functions change; a second run is refused; the rollback
//     restores the whole catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261113180000_removed_devices.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261113180000_removed_devices.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 500) : '')); }
}
const run = async (pg, sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE]) });   // the live shape
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || crypto.randomBytes(16).toString('hex'));
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    await pg.exec('set role anon');
    try { return { j: (await q(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) j`, names.map((n) => args[n])))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  // p_last_vendor_id only when given: a till before v36 doesn't send it
  const checkin = (iid, last) => anon('cl_device_checkin', Object.assign({ p_install_id: iid, p_shop_secret_phrase: 'Seed Phrase', p_device_code: iid + '-C1',
    p_business_name: 'Shop ' + iid, p_device_key: key(iid), p_app_build: 36 }, last === undefined ? {} : { p_last_vendor_id: last }));
  const vendors = async (iid) => Number((await q(`select count(*) n from cl_vendors where install_id = $1`, [iid]))[0].n);
  const listed = async (iid) => (await q(`select * from cl_removed_devices where install_id = $1`, [iid]))[0] || null;

  // the live shape: a registered main till, a new install that only checked in, and one deleted (the purge)
  let r = await anon('cl_branch_register', { p_install_id: 'MAIN', p_secret_phrase: 'Seed Phrase', p_device_key: key('MAIN'), p_business_name: 'Seed Shop', p_branch_name: 'Harare' });
  ok('setup: a main till registers', r.j && !r.j.error, JSON.stringify(r));
  const r0 = await checkin('MAIN');
  const mainVendor = r0.j && r0.j.vendor_id;
  await checkin('GONE'); await checkin('BACK');
  await q(`delete from cl_vendors where install_id in ('GONE', 'BACK')`);
  await checkin('BACK');                                       // an old device came back after the purge (a stray row)
  ok('setup: GONE has no vendor row, BACK has one again', (await vendors('GONE')) === 0 && (await vendors('BACK')) === 1);
  const before = fingerprint(await snapshot(q));

  r = await run(pg, MIG);
  ok('it applies', r.ok, r.e);
  const d1 = diff(before, fingerprint(await snapshot(q)));
  const changed = d1.changed.map((c) => c.key);
  ok('changed: only cl_install_vendor; cl_device_checkin swapped for the one with p_last_vendor_id; the rest is new',
    changed.length === 1 && /cl_install_vendor/.test(changed[0]) && d1.onlyA.length > 0 && d1.onlyA.every((k) => /cl_device_checkin\(.*p_app_build integer\)/.test(k)) &&
    d1.onlyB.some((k) => /cl_device_checkin/.test(k)) && d1.onlyB.every((k) => /cl_device_checkin|cl_removed_devices|cl_vendor_removed_device|cl_vendors_removed_device|cl_company_info/.test(k)),
    JSON.stringify({ changed, onlyA: d1.onlyA, onlyB: d1.onlyB }).slice(0, 900));

  let g = await listed('GONE');
  ok('backfill: GONE (deleted, no vendor row now) is on the list, from the activity log', g && /activity log/.test(g.reason), JSON.stringify(g));
  ok('backfill: BACK (has a vendor row again) is not on the list; left for the data fix', !(await listed('BACK')));
  ok('backfill: MAIN is not on the list', !(await listed('MAIN')));

  r = await checkin('GONE');
  ok('a removed device\'s check-in (a till before v36) is refused: DEVICE_REMOVED', /DEVICE_REMOVED: This device belongs to a business that no longer exists on seiGEN\. Reset this device\./.test(r.e || ''), JSON.stringify(r));
  ok('... and no vendor row is made', (await vendors('GONE')) === 0);
  r = await anon('cl_branch_register', { p_install_id: 'GONE', p_secret_phrase: 'Seed Phrase', p_device_key: key('GONE'), p_business_name: 'New Shop', p_branch_name: 'Mutare' });
  ok('a removed device can\'t register a business either (it must be reset first)', /DEVICE_REMOVED/.test(r.e || (r.j && JSON.stringify(r.j)) || ''), JSON.stringify(r));
  ok('... nothing created', (await vendors('GONE')) === 0 && Number((await q(`select count(*) n from cl_businesses where name = 'New Shop'`))[0].n) === 0);

  const ghost = crypto.randomUUID();
  r = await checkin('ODD1', ghost);
  ok('a device whose last vendor no longer exists (not on the list) is refused: DEVICE_REMOVED', /DEVICE_REMOVED/.test(r.e || ''), JSON.stringify(r));
  ok('... and no vendor row is made', (await vendors('ODD1')) === 0);

  r = await checkin('NEW1');
  ok('a new install (no last vendor id) registers as before: a vendor row, onboarding', r.j && r.j.vendor_id && r.j.status === 'onboarding' && (await vendors('NEW1')) === 1, JSON.stringify(r));
  r = await checkin('NEW1', r.j.vendor_id);
  ok('... and checks in with its vendor id from then on', r.j && r.j.vendor_id && !r.e, JSON.stringify(r));

  r = await checkin('MAIN', mainVendor);
  ok('a registered till sending its last vendor id: answered as before (same fields, same vendor, terminal active)', r.j && r.j.vendor_id === mainVendor && r.j.terminal_active === true &&
    JSON.stringify(Object.keys(r.j).sort()) === JSON.stringify(Object.keys(r0.j).sort()), JSON.stringify(r));
  r = await checkin('MAIN');
  ok('a registered till before v36 (no last vendor id): answered as before', r.j && r.j.vendor_id === mainVendor, JSON.stringify(r));
  r = await checkin('BACK');
  ok('the stray row\'s device still checks in until the data fix lists it (A8)', r.j && r.j.vendor_id, JSON.stringify(r));

  // a business deleted later (Console / data fix): the trigger lists the device, with the reason given
  const newVendor = (await q(`select id from cl_vendors where install_id = 'NEW1'`))[0].id;
  await pg.exec(`begin; select set_config('cl.removed_reason', 'business deleted on seiGEN (test)', true); delete from cl_vendors where install_id = 'NEW1'; commit;`);
  g = await listed('NEW1');
  ok('a later vendor delete lists the device: vendor id, name, device code, reason', g && g.vendor_id === newVendor && g.business_name === 'Shop NEW1' && g.device_code === 'NEW1-C1' &&
    g.reason === 'business deleted on seiGEN (test)' && !!g.device_key, JSON.stringify(g));
  r = await checkin('NEW1', newVendor);
  ok('... its next check-in is refused, nothing created', /DEVICE_REMOVED/.test(r.e || '') && (await vendors('NEW1')) === 0, JSON.stringify(r));
  await q(`delete from cl_vendors where install_id = 'BACK'`);
  ok('a delete without a reason: "vendor row deleted"', ((await listed('BACK')) || {}).reason === 'vendor row deleted');

  const can = async (role, priv) => (await q(`select has_table_privilege($1, 'public.cl_removed_devices', $2) x`, [role, priv]))[0].x;
  ok('devices (anon, authenticated) can\'t read or change the list', !(await can('anon', 'select')) && !(await can('anon', 'insert')) && !(await can('authenticated', 'select')) && !(await can('authenticated', 'delete')));
  ok('the list has RLS on', (await q(`select relrowsecurity r from pg_class where oid = 'public.cl_removed_devices'::regclass`))[0].r);
  ok('check-in keeps its grants (PUBLIC, anon, authenticated)', (await q(`select has_function_privilege('anon', 'public.cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text,integer,uuid)', 'execute') a,
    has_function_privilege('authenticated', 'public.cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text,integer,uuid)', 'execute') b`)).every((x) => x.a && x.b));
  ok('devices can\'t call the trigger function', !(await q(`select has_function_privilege('anon', 'public.cl_vendor_removed_device()', 'execute') x`))[0].x);

  // A5: the About page's company details (Console → Settings)
  await q(`insert into cl_app_settings (key, value, label) values ('company_name', 'Digital Commerce', 'Company name'), ('company_address', 'Commerce Valley, Marirangwe, Mhondoro, Zimbabwe', 'Company address')
           on conflict (key) do nothing`);
  r = await anon('cl_company_info', {});
  ok('cl_company_info (anon): name, address and website from the Console settings', r.j && r.j.name === 'Digital Commerce' && r.j.address === 'Commerce Valley, Marirangwe, Mhondoro, Zimbabwe' && r.j.website === 'digitalcommerce.com' && !!r.j.updated_at, JSON.stringify(r));
  await q(`update cl_app_settings set value = 'seigen.example', updated_at = now() where key = 'company_website'`);
  r = await anon('cl_company_info', {});
  ok('... a change in the Console shows at once', r.j && r.j.website === 'seigen.example', JSON.stringify(r));
  ok('... and gives nothing else from the settings', r.j && JSON.stringify(Object.keys(r.j).sort()) === JSON.stringify(['address', 'name', 'updated_at', 'website']));

  r = await run(pg, MIG);
  ok('a second run is refused and changes nothing', /already there/.test(r.e || ''), r.e);

  r = await run(pg, RB);
  ok('the rollback applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  ok('after the rollback the company_website setting is gone', Number((await q(`select count(*) n from cl_app_settings where key = 'company_website'`))[0].n) === 0);
  r = await checkin('GONE');
  ok('after the rollback: an unknown install is made a vendor row again (as before)', r.j && r.j.vendor_id && (await vendors('GONE')) === 1, JSON.stringify(r));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
