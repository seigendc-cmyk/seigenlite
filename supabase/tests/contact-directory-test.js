// node supabase/tests/contact-directory-test.js
//
// Tests supabase/migrations/20261111120000_contact_directory.sql (and its
// rollback) in PGlite built in the live shape, never the live database:
// the starting data, the public list iTred reads (active desks and numbers,
// in order), the Console's list and saves for staff with "Manage contact
// directory" (or a SysAdmin) only, adding desks and several numbers, the
// checks (names, numbers with a country code, Call or WhatsApp), switching
// off instead of deleting, every change logged with what it was, grants
// (nobody reads the tables directly), and the rollback.
'use strict';
const path = require('path');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261111120000_contact_directory.sql';
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
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261113180000_removed_devices.sql', '20261114120000_roles_everywhere.sql', '20261115120000_stock_control.sql', '20261116120000_vendor_register_status.sql']) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p) {
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }
  const one = async (claims, sql, p) => { const x = await as(claims, sql, p); return x.e ? { raised: x.e } : x.r[0].j; };

  let e = null; try { await pg.exec(MIG); } catch (y) { e = y.message; }
  ok('the migration applies to the live shape', !e, e);

  const staff = {};
  for (const [k, sys] of [['SYS', true], ['CD', false], ['NONE', false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, true, now()) returning id`, ['Staff ' + k, sys]))[0].id;
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) select $1, id, now() from cl_modules where key = 'contact_directory'`, [staff.CD]);
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });
  const pub = () => one(null, `select public.cl_contact_directory() j`);
  const all = (k) => one(tok(k), `select public.cl_contact_directory_all() j`);
  const desk = (k, id, name, sort, active) => one(tok(k), `select public.cl_contact_desk_save($1, $2, $3, $4) j`, [id, name, sort, active]);
  const num = (k, id, deskId, label, phone, call, wa, sort, active) =>
    one(tok(k), `select public.cl_contact_number_save($1, $2, $3, $4, $5, $6, $7, $8) j`, [id, deskId, label, phone, call, wa, sort, active]);
  const log = async () => q(`select action, detail from cl_activity_log where action like 'contact_%' order by created_at, id`);

  // ---- starting data, public ----
  let p = await pub();
  ok('anyone (iTred) gets the starting directory: Queries Desk, Sales, Support, in that order', J(p.map((d) => d.desk)) === J(['Queries Desk', 'Sales', 'Support']), J(p));
  ok('... Queries Desk +263774479121, Sales and Support +263789487287, each with Call and WhatsApp',
    J(p.map((d) => [d.numbers.length, d.numbers[0].phone, d.numbers[0].call, d.numbers[0].whatsapp]))
      === J([[1, '+263774479121', true, true], [1, '+263789487287', true, true], [1, '+263789487287', true, true]]), J(p));
  ok('... the public list has no ids or staff', !/"id"|staff|created/.test(J(p)));
  ok('the module "Contact directory" exists', (await q(`select label from cl_modules where key = 'contact_directory'`))[0].label === 'Contact directory');

  // ---- grants ----
  let r = await as(null, `select * from cl_contact_desks`);
  ok('anon can\'t read the tables directly', !!r.e && /permission denied/.test(r.e), J(r));
  r = await as(tok('CD'), `select * from cl_contact_numbers`);
  ok('... nor can staff (only through the functions)', !!r.e && /permission denied/.test(r.e), J(r));
  ok('anon can\'t list everything or save', /permission denied|Not authorized/.test((await one(null, `select public.cl_contact_directory_all() j`)).raised || '')
    && /permission denied|Not authorized/.test((await one(null, `select public.cl_contact_desk_save(null, 'X Desk', 1, true) j`)).raised || ''));
  ok('staff without the module: not authorized', /Not authorized/.test((await all('NONE')).raised || '') && /Not authorized/.test((await desk('NONE', null, 'Billing', 40, true)).raised || ''));

  // ---- the Console: desks ----
  const A = await all('CD');
  ok('with the module: every desk with ids and numbers', A.length === 3 && A[0].numbers[0].id && A[0].active === true, J(A));
  r = await desk('CD', null, 'Billing', 40, true);
  ok('a new desk "Billing"', r.ok === true && !!r.id, J(r));
  const BILL = r.id;
  ok('... a desk with no active numbers isn\'t shown publicly yet', !(await pub()).some((d) => d.desk === 'Billing'));
  ok('a second desk of the same name (any case) is refused', /already a desk called "billing"/.test((await desk('CD', null, ' billing ', 50, true)).raised || ''));
  ok('a one-letter name is refused', /2 to 60 characters/.test((await desk('CD', null, 'B', 50, true)).raised || ''));

  // ---- numbers ----
  r = await num('CD', null, BILL, 'Accounts', '+263 77 123-4567', true, false, 10, true);
  ok('a number typed with spaces and dashes is kept as +263771234567', r.ok === true, J(r));
  const N1 = r.id;
  r = await num('CD', null, BILL, 'WhatsApp only', '+263 71 999 0000', false, true, 20, true);
  ok('several numbers per desk', r.ok === true, J(r));
  const N2 = r.id;
  p = await pub();
  const bill = p.find((d) => d.desk === 'Billing');
  ok('Billing now shows publicly with both numbers, in order, Call/WhatsApp as set',
    J(bill && bill.numbers) === J([{ label: 'Accounts', phone: '+263771234567', call: true, whatsapp: false }, { label: 'WhatsApp only', phone: '+263719990000', call: false, whatsapp: true }]), J(bill));
  ok('a number without its country code is refused', /country code/.test((await num('CD', null, BILL, 'Local', '0771234567', true, true, 30, true)).raised || ''));
  ok('Call and WhatsApp both off is refused', /Call, WhatsApp or both/.test((await num('CD', null, BILL, 'Off', '+263771234568', false, false, 30, true)).raised || ''));
  ok('a missing label is refused', /label/.test((await num('CD', null, BILL, '  ', '+263771234568', true, true, 30, true)).raised || ''));

  // ---- switching off, order ----
  r = await num('CD', N1, BILL, 'Accounts', '+263771234567', true, false, 10, false);
  ok('a number switched off', r.ok === true);
  ok('... is gone from the public list (the desk keeps its other one)', J((await pub()).find((d) => d.desk === 'Billing').numbers.map((n) => n.label)) === J(['WhatsApp only']));
  ok('... and still in the Console\'s list, as inactive', (await all('CD')).find((d) => d.id === BILL).numbers.find((n) => n.id === N1).active === false);
  r = await desk('CD', BILL, 'Billing', 5, true);
  ok('desk order: Billing moved first', (await pub())[0].desk === 'Billing', J(await pub()));
  r = await desk('SYS', BILL, 'Billing', 5, false);
  ok('a SysAdmin switches the desk off: gone publicly', r.ok === true && !(await pub()).some((d) => d.desk === 'Billing'));
  ok('nothing is ever deleted: Billing and both numbers are still there', (await q(`select count(*)::int c from cl_contact_numbers where desk_id = $1`, [BILL]))[0].c === 2);
  r = await as(tok('CD'), `delete from cl_contact_desks`);
  ok('... and staff can\'t delete rows directly', !!r.e);

  // ---- the log ----
  const L = await log();
  ok('every change is logged: 1 desk added and 2 desk changes; 2 numbers added and 1 change',
    J(L.map((x) => x.action)) === J(['contact_desk_added', 'contact_number_added', 'contact_number_added', 'contact_number_changed', 'contact_desk_changed', 'contact_desk_changed']), J(L.map((x) => x.action)));
  const ch = L.find((x) => x.action === 'contact_number_changed');
  ok('... a change says what it was (active true -> false)', ch.detail.active === false && ch.detail.was.active === true && ch.detail.phone === '+263771234567', J(ch));
  ok('... and who did it', (await q(`select count(*)::int c from cl_activity_log where action like 'contact_%' and staff_id = $1`, [staff.SYS]))[0].c === 1);

  // ---- rollback ----
  await pg.exec(RB);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('the rollback restores the exact pre-migration catalogue', !d.onlyA.length && !d.onlyB.length && !d.changed.length, J(d).slice(0, 600));
  ok('... and the module is gone (with its grants)', (await q(`select count(*)::int c from cl_modules where key = 'contact_directory'`))[0].c === 0);
  e = null; try { await pg.exec(MIG); } catch (y) { e = y.message; }
  ok('the migration applies again after a rollback', !e, e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
