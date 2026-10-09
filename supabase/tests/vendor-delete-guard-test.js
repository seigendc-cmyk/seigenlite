// node supabase/tests/vendor-delete-guard-test.js
//
// Tests supabase/migrations/20261014120000_vendor_delete_guard.sql (and its
// rollback) in an in-memory PGlite built from the repo in the live shape,
// never the live database: a vendor or business with history can't be
// deleted (plain message, nothing deleted), one with none can (and it's
// logged, without the phrase), the six foreign keys refuse, archive and
// unarchive (who may, reasons, plain errors, logging), an archived vendor
// still checks in, the public roles lose TRUNCATE / TRIGGER / REFERENCES,
// and the rollback restores the exact catalogue.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261014120000_vendor_delete_guard.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261015120000_rpn_commissions.sql']) });
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
  for (const [k, sys, active] of [['SYS', true, true], ['VEN', false, true], ['NONE', false, true], ['GONE', false, false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, $3, now()) returning id`, ['Staff ' + k, sys, active]))[0].id;
  const mod = {};
  for (const k of ['vendors', 'cashbook']) mod[k] = (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [k]))[0].id;
  const grant = (s, m) => q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff[s], mod[m]]);
  await grant('VEN', 'vendors'); await grant('NONE', 'cashbook'); await grant('GONE', 'vendors');
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });

  // ---- a registered business (vendor + business + branch + till), through the device RPC ----
  const KEY = crypto.randomBytes(16).toString('hex');
  const reg = (await as(null, `select public.cl_branch_register('AC01', 'Acme Phrase', $1, 'Acme', 'Harare') j`, [KEY]));
  if (reg.e) throw new Error(reg.e);
  const acme = reg.r[0].j;
  const acmeVendor = (await q(`select id from cl_vendors where install_id = 'AC01'`))[0].id;
  const vend = async (n, i) => (await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, status) values ($1, $2, 'secret phrase', 'onboarding') returning id`, [n, i]))[0].id;

  // ---- apply ----
  let e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('the migration applies', !e, e);
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /vendor_delete_guard aborted: already there/.test(e || ''), e);

  ok('the six foreign keys now refuse the delete', (await q(`select conname, confdeltype from pg_constraint where conname = any($1) order by 1`,
    [['cl_ledger_entries_vendor_id_fkey', 'cl_activation_codes_vendor_id_fkey', 'cl_vendor_messages_vendor_id_fkey', 'cl_licences_vendor_id_fkey', 'cl_licences_business_id_fkey', 'cl_licences_terminal_id_fkey']]))
    .every((r) => r.confdeltype === 'r'));

  // ---- 1. a vendor with history can't be deleted, for each kind of history ----
  const kinds = {
    'ledger entry': async (v) => q(`insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, recorded_by) values ($1, 'payment', 5, 'USD', $2)`, [v, staff.SYS]),
    'activation code': async (v) => q(`insert into cl_activation_codes (vendor_id, device_code, computed_code, issued_by) values ($1, 'X-C1', 'ABCDEF', $2)`, [v, staff.SYS]),
    'billing message': async (v) => q(`insert into cl_vendor_messages (vendor_id, title, body, channel, created_by) values ($1, 'Reminder', 'pay up', 'in_app', $2)`, [v, staff.SYS]),
    'licence': async (v, i) => q(`insert into cl_licences (key_id, install_id, device_tag, binding, strong_binding, vendor_id, days, valid_from, valid_to, payload, licence, short_code_hash, status, issued_by)
      values (1, $2, 'PTF5', '\\x0000000000000000', true, $1, 30, current_date, current_date + 30, '\\x00', 'SL2.x', md5($2), 'issued', $3)`, [v, i, staff.SYS]),
    'price-plan setting': async (v) => q(`insert into cl_plan_assignments (vendor_id, plan_code, reason, set_by) values ($1, 'lite', 'TEST', $2)`, [v, staff.SYS]),
  };
  let n = 0;
  for (const [kind, add] of Object.entries(kinds)) {
    const iid = 'H' + (++n) + 'XX';
    const v = await vend('Shop ' + n, iid);
    try { await add(v, iid); } catch (x) { ok('seed ' + kind, false, x.message); continue; }
    const del = await tryQ(`delete from cl_vendors where id = $1`, [v]);
    ok('a vendor with a ' + kind + ' can\'t be deleted: plain message, nothing deleted',
      new RegExp('Can\'t delete "Shop ' + n + '": it has 1 ' + kind + '.*Archive it instead').test(del.e || '') &&
      (await q(`select count(*)::int c from cl_vendors where id = $1`, [v]))[0].c === 1, del.e);
  }
  const acmeDel = await tryQ(`delete from cl_vendors where id = $1`, [acmeVendor]);
  ok('a business\'s main vendor: lists its till and the business it created', /it has 1 till, 1 business it created/.test(acmeDel.e || ''), acmeDel.e);

  // ---- 2. a vendor with no history can be deleted, and it's logged without the phrase ----
  const lone = await vend('Duplicate Check-in', 'DUP1');
  const d1 = await tryQ(`delete from cl_vendors where id = $1`, [lone]);
  const log1 = (await q(`select staff_id, detail from cl_activity_log where action = 'vendor_deleted' and target_id = $1`, [lone]))[0];
  ok('a vendor with no history can be deleted (dashboard: no staff member)', !d1.e && log1 && log1.staff_id === null && log1.detail.business_name === 'Duplicate Check-in' && log1.detail.install_id === 'DUP1' && !!log1.detail.db_role, JSON.stringify(log1 || d1.e));
  ok('... and the log has no secret phrase', log1 && !JSON.stringify(log1.detail).includes('secret phrase') && !('shop_secret_phrase' in log1.detail));
  const lone2 = await vend('Test Install', 'TST1');
  const d2 = await as(tok('VEN'), `delete from cl_vendors where id = $1 returning id`, [lone2]);
  const log2 = (await q(`select staff_id from cl_activity_log where action = 'vendor_deleted' and target_id = $1`, [lone2]))[0];
  ok('deleted by a staff member in the Console: the log names them', !d2.e && d2.r.length === 1 && log2 && log2.staff_id === staff.VEN, JSON.stringify(d2.e || log2));

  // ---- 3. businesses ----
  const bizDel = await tryQ(`delete from cl_businesses where id = $1`, [acme.business_id]);
  ok('a business with branches and tills can\'t be deleted: plain message', /Can't delete "Acme": it has 1 branch, 1 till\. Archive it instead/.test(bizDel.e || ''), bizDel.e);
  const bv = await vend('Empty Biz Owner', 'EB01');
  const emptyBiz = (await q(`insert into cl_businesses (name, secret_phrase_hash, created_by_vendor_id) values ('Empty Biz', 'x', $1) returning id`, [bv]))[0].id;
  const bd = await tryQ(`delete from cl_businesses where id = $1`, [emptyBiz]);
  const blog = (await q(`select detail from cl_activity_log where action = 'business_deleted' and target_id = $1`, [emptyBiz]))[0];
  ok('a business with nothing in it can be deleted, and it\'s logged', !bd.e && blog && blog.detail.name === 'Empty Biz', JSON.stringify(bd.e || blog));
  const licBiz = await tryQ(`update cl_licences set business_id = $1, terminal_id = $2 where install_id = 'H4XX' returning serial`, [acme.business_id, acme.terminal_id]);
  const termDel = await tryQ(`delete from cl_terminals where id = $1`, [acme.terminal_id]);
  ok('a till with a licence can\'t be deleted', !licBiz.e && !!termDel.e && (await q(`select count(*)::int c from cl_terminals where id = $1`, [acme.terminal_id]))[0].c === 1, termDel.e);

  // ---- 4. archive / unarchive ----
  const shop1 = (await q(`select id from cl_vendors where install_id = 'H1XX'`))[0].id;
  const arch = (k, id, reason) => as(k ? tok(k) : null, `select public.cl_vendor_archive($1, $2) j`, [id, reason]).then(j);
  const unarch = (k, id, reason) => as(tok(k), `select public.cl_vendor_unarchive($1, $2) j`, [id, reason]).then(j);
  ok('staff without the Vendors Register permission are refused', /Not authorized: needs the Vendors Register permission/.test((await arch('NONE', shop1, 'Closed down')).e || ''));
  ok('inactive staff are refused', /Not authorized/.test((await arch('GONE', shop1, 'Closed down')).e || ''));
  ok('anonymous calls are refused', /permission denied/.test((await arch(null, shop1, 'Closed down')).e || ''));
  ok('a reason is required', /Give a reason \(at least 3 characters\)/.test((await arch('VEN', shop1, ' x ')).e || ''));
  ok('no such vendor', /No such vendor/.test((await arch('VEN', crypto.randomUUID(), 'Closed down')).e || ''));
  const a1 = await arch('VEN', shop1, 'Closed down');
  const row1 = (await q(`select archived_at, archived_by, archive_reason from cl_vendors where id = $1`, [shop1]))[0];
  ok('the Vendors Register permission archives, with who and why', !a1.e && row1.archived_at && row1.archived_by === staff.VEN && row1.archive_reason === 'Closed down', JSON.stringify(a1));
  ok('archiving twice: a plain error', /"Shop 1" is already archived \(since /.test((await arch('VEN', shop1, 'Closed down')).e || ''));
  const alog = (await q(`select staff_id, detail from cl_activity_log where action = 'vendor_archived' and target_id = $1`, [shop1]));
  ok('the archive is logged once, with the reason and who', alog.length === 1 && alog[0].staff_id === staff.VEN && alog[0].detail.reason === 'Closed down');
  ok('archiving leaves its ledger alone', (await q(`select count(*)::int c from cl_ledger_entries where vendor_id = $1`, [shop1]))[0].c === 1);
  const st = j(await as(tok('VEN'), `select public.cl_archive_state() j`));
  ok('cl_archive_state lists it, with the staff name', st.vendors && st.vendors.length === 1 && st.vendors[0].id === shop1 && st.vendors[0].archived_by_name === 'Staff VEN', JSON.stringify(st));
  ok('cl_archive_state: other staff are refused', /Not authorized/.test(j(await as(tok('NONE'), `select public.cl_archive_state() j`)).e || ''));
  ok('unarchive needs a reason too', /Give a reason/.test((await unarch('VEN', shop1, '')).e || ''));
  const u1 = await unarch('SYS', shop1, 'Reopened');
  const row1b = (await q(`select archived_at, archived_by, archive_reason from cl_vendors where id = $1`, [shop1]))[0];
  const ulog = (await q(`select staff_id, detail from cl_activity_log where action = 'vendor_unarchived' and target_id = $1`, [shop1]))[0];
  ok('SysAdmin unarchives: fields cleared, logged with the reason and what it was', !u1.e && row1b.archived_at === null && row1b.archive_reason === null &&
    ulog && ulog.staff_id === staff.SYS && ulog.detail.reason === 'Reopened' && ulog.detail.was_reason === 'Closed down', JSON.stringify(ulog || u1));
  ok('unarchiving one that isn\'t archived: a plain error', /"Shop 1" is not archived/.test((await unarch('VEN', shop1, 'Again')).e || ''));
  ok('the reason note doesn\'t leak into a later change', ((await q(`select current_setting('cl.archive_note', true) s`))[0].s || '') === '');

  // businesses
  const ba = j(await as(tok('VEN'), `select public.cl_business_archive($1, $2) j`, [acme.business_id, 'Moved away']));
  const blog2 = (await q(`select detail from cl_activity_log where action = 'business_archived' and target_id = $1`, [acme.business_id]))[0];
  ok('a business is archived and logged', !ba.e && blog2 && blog2.detail.reason === 'Moved away', JSON.stringify(ba));
  ok('archiving a business twice: a plain error', /"Acme" is already archived/.test(j(await as(tok('VEN'), `select public.cl_business_archive($1, $2) j`, [acme.business_id, 'Moved away'])).e || ''));
  const st2 = j(await as(tok('VEN'), `select public.cl_archive_state() j`));
  ok('cl_archive_state lists the archived business by name', st2.businesses.length === 1 && st2.businesses[0].name === 'Acme');

  // ---- 5. an archived vendor's device still checks in ----
  await arch('VEN', acmeVendor, 'Archived for the test');
  const ci = await as(null, `select public.cl_device_checkin(p_install_id=>'AC01', p_shop_secret_phrase=>'Acme Phrase', p_device_code=>'AC01-C1', p_business_name=>'Acme', p_device_key=>$1) j`, [KEY]);
  const after = (await q(`select archived_at is not null a, last_checkin_at from cl_vendors where id = $1`, [acmeVendor]))[0];
  ok('an archived vendor\'s device still checks in, and it stays archived', !ci.e && ci.r[0].j && !ci.r[0].j.error && after.a && !!after.last_checkin_at, JSON.stringify(ci.e || ci.r[0].j));

  // ---- 6. grants ----
  const tr = await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and table_name like 'cl\\_%' and grantee in ('anon', 'authenticated') and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')`);
  ok('anon and authenticated have no TRUNCATE, TRIGGER or REFERENCES on any cl_ table', tr.length === 0, JSON.stringify(tr.slice(0, 5)));
  const sel = await q(`select count(*)::int c from information_schema.role_table_grants where table_schema = 'public' and table_name = 'cl_vendors' and grantee = 'authenticated' and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')`);
  ok('... SELECT, INSERT, UPDATE and DELETE are unchanged', sel[0].c === 4);

  // ---- 7. rollback ----
  // the rollback brings back CASCADE: clear the seeded rows so the catalogue compare is about the schema only
  await pg.exec(RB);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('the rollback restores the exact pre-migration catalogue (keys, grants, no new objects)', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('and the migration applies again after a rollback', !e, e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
