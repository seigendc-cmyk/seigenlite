// node supabase/tests/multi-terminal-identity-test.js
//
// Tests supabase/migrations/20261004120000_multi_terminal_identity.sql (and
// its rollback) in an in-memory PGlite — never against the live database.
//
// The stub copies, from a read-only look at the live project on 2026-10-04,
// what the migration depends on: cl_vendors and cl_vendor_messages (live
// columns), cl_activity_log, the cl_jwt_* helpers and cl_has_module_access
// (same bodies), the live grants (everything to anon and authenticated, as
// the project's default privileges do), pgcrypto in schema "extensions",
// and the live cl_device_checkin body (taken from the rollback, which
// restores it verbatim). Callers are "signed in" by setting
// request.jwt.claims, as PostgREST does from a cl_login token.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG = fs.readFileSync(`${ROOT}/migrations/20261004120000_multi_terminal_identity.sql`, 'utf8');
const { LIVE_STUB, STAFF_VENDORS, STAFF_OTHER, RB } = require('./live-stub');

const claims = {
  vendorsClerk: { role: 'authenticated', sub: STAFF_VENDORS, user_type: 'staff', is_sysadmin: false },
  otherClerk: { role: 'authenticated', sub: STAFF_OTHER, user_type: 'staff', is_sysadmin: false },
};

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const pg = new PGlite({ extensions: { pgcrypto } });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const err = async (sql, p) => { try { await pg.query(sql, p); return null; } catch (e) { return e.message; } };
  // Run as anon (a device) or as a signed-in caller; always resets.
  async function as(who, sql, p) {
    await q(`select set_config('request.jwt.claims', $1, false)`, [who === 'anon' ? '' : JSON.stringify(claims[who])]);
    await pg.exec(`set role ${who === 'anon' ? 'anon' : 'authenticated'}`);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await q(`select set_config('request.jwt.claims', '', false)`); }
  }
  const dev = async (sql, p) => { const x = await as('anon', sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };

  await pg.exec(LIVE_STUB);
  // a single-device shop registered before the migration
  await q(`select public.cl_device_checkin('OLD1','Shop Phrase','OLD1-C3','Old Shop')`);
  await pg.exec(MIG);
  ok('migration applies to a database shaped like the live one', true);

  // ---- cl_device_checkin ----
  const ci = (iid, ph, key) => dev(`select public.cl_device_checkin(p_install_id=>$1, p_shop_secret_phrase=>$2, p_device_code=>$1||'-C1', p_business_name=>'X', p_device_key=>$3) j`, [iid, ph, key]);
  ok('old shop still checks in without a key (old app version)', (await ci('OLD1', 'Shop Phrase', null)).vendor_id);
  ok('old 9-argument call shape still works', (await dev(`select public.cl_device_checkin('OLD1','Shop Phrase','OLD1-C3','Old Shop') j`)).vendor_id);
  ok('phrase compared with upper(btrim())', (await ci('OLD1', '  shop PHRASE ', null)).vendor_id);
  ok('wrong phrase still refused', /does not match/.test((await as('anon', `select public.cl_device_checkin('OLD1','nope','OLD1-C3','Old Shop')`)).e || ''));
  await ci('OLD1', 'Shop Phrase', 'KEY-OLD1');
  ok('device_key recorded on first use', (await q(`select device_key from cl_vendors where install_id='OLD1'`))[0].device_key === 'KEY-OLD1');
  ok('another device with the same install_id is refused',
    /another device/.test((await as('anon', `select public.cl_device_checkin(p_install_id=>'OLD1',p_shop_secret_phrase=>'Shop Phrase',p_device_code=>'OLD1-C1',p_business_name=>'X',p_device_key=>'KEY-OTHER')`)).e || ''));
  ok('a keyless call is refused once a key is recorded',
    /another device/.test((await as('anon', `select public.cl_device_checkin('OLD1','Shop Phrase','OLD1-C3','Old Shop')`)).e || ''));
  ok('same device at its next cycle (device code changed) accepted',
    (await dev(`select public.cl_device_checkin(p_install_id=>'OLD1',p_shop_secret_phrase=>'Shop Phrase',p_device_code=>'OLD1-C4',p_business_name=>'X',p_device_key=>'KEY-OLD1') j`)).vendor_id);
  ok('a brand-new install still registers itself', (await ci('FRESH001', 'Any', 'K-F')).status === 'onboarding');
  ok('check-in reply has the new keys (null before registration)', (await ci('FRESH001', 'Any', 'K-F')).terminal_id === null);

  // ---- staff: clear a lost device key ----
  const oldId = (await q(`select id from cl_vendors where install_id='OLD1'`))[0].id;
  ok('anon cannot clear a device key', /permission denied/.test((await as('anon', `select public.cl_vendor_clear_device_key($1::uuid)`, [oldId])).e || ''));
  ok('staff without the Vendors module cannot', /Not authorized/.test((await as('otherClerk', `select public.cl_vendor_clear_device_key($1::uuid)`, [oldId])).e || ''));
  const cleared = await as('vendorsClerk', `select public.cl_vendor_clear_device_key($1::uuid, 'phone reset') j`, [oldId]);
  ok('Vendors-module staff can clear it', cleared.r && cleared.r[0].j.device_key_cleared === true, cleared.e);
  ok('the clear is logged', (await q(`select count(*)::int n from cl_activity_log where action='vendor_device_key_cleared' and target_id=$1 and staff_id=$2`, [oldId, STAFF_VENDORS]))[0].n === 1);
  ok('the device is re-admitted with its new key',
    (await ci('OLD1', 'Shop Phrase', 'KEY-NEW')).vendor_id && (await q(`select device_key from cl_vendors where id=$1`, [oldId]))[0].device_key === 'KEY-NEW');

  // ---- main registers ----
  const reg = await dev(`select public.cl_branch_register('MAIN1234','Biz Phrase','K-MAIN','Gentronix','Harare CBD','B-ABCD2345','Front till') j`);
  ok('main registers: business, main branch, T1', reg.till_code === 'T1' && reg.is_main === true && reg.business_name === 'Gentronix');
  ok('register is idempotent', (await dev(`select public.cl_branch_register('MAIN1234','biz phrase','K-MAIN','Gentronix','Harare CBD') j`)).terminal_id === reg.terminal_id);
  ok('main install keeps one cl_vendors row, now linked to the business',
    (await q(`select count(*)::int n from cl_vendors where install_id='MAIN1234' and business_id=$1`, [reg.business_id]))[0].n === 1);
  ok('business phrase is stored hashed, not in plain text',
    (await q(`select secret_phrase_hash h from cl_businesses`))[0].h.startsWith('$2'));
  for (const t of ['cl_businesses', 'cl_branches', 'cl_terminals', 'cl_branch_join_codes', 'cl_join_failures'])
    ok(`anon can't read ${t}`, /permission denied/.test((await as('anon', `select * from ${t}`)).e || ''));
  ok("anon can't call an internal helper", /permission denied/.test((await as('anon', `select cl_new_join_code()`)).e || ''));
  ok("anon can't call cl_install_vendor directly", /permission denied/.test((await as('anon', `select cl_install_vendor('MAIN1234','Biz Phrase','K-MAIN',false)`)).e || ''));

  // ---- another till for main ----
  const code = await dev(`select public.cl_branch_issue_join_code('MAIN1234','Biz Phrase','K-MAIN',$1::uuid) j`, [reg.branch_id]);
  ok('code looks like XXXX-XXXX with no ambiguous letters', /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(code.code), code.code);
  ok('only the hash of the code is stored', (await q(`select count(*)::int n from cl_branch_join_codes where code_hash=$1`, [code.code.replace('-', '')]))[0].n === 0);
  const j1 = await dev(`select public.cl_terminal_join('NEWTERM1','biz phrase','K-T2',$1,'Back till') j`, [code.code.toLowerCase()]);
  ok('terminal joins the existing business as T2', j1.till_code === 'T2' && j1.business_id === reg.business_id, JSON.stringify(j1));
  ok('joined install has its own cl_vendors row linked to the business',
    (await q(`select count(*)::int n from cl_vendors where install_id='NEWTERM1' and business_id=$1`, [reg.business_id]))[0].n === 1);
  ok('still exactly one business', (await q(`select count(*)::int n from cl_businesses`))[0].n === 1);
  ok('a retried join returns the same terminal',
    (await dev(`select public.cl_terminal_join('NEWTERM1','biz phrase','K-T2',$1,'Back till') j`, [code.code])).terminal_id === j1.terminal_id);
  ok('a used code is refused for another device',
    (await dev(`select public.cl_terminal_join('NEWTERM2','biz phrase','K-T3',$1) j`, [code.code])).error === 'JOIN_CODE_USED');
  ok('a refused join creates no vendor row', (await q(`select count(*)::int n from cl_vendors where install_id='NEWTERM2'`))[0].n === 0);
  const c2 = await dev(`select public.cl_branch_issue_join_code('MAIN1234','Biz Phrase','K-MAIN',$1::uuid) j`, [reg.branch_id]);
  await q(`update cl_branch_join_codes set expires_ts = now() - interval '1 minute' where expires_ts = $1::timestamptz`, [c2.expires_ts]);
  ok('an expired code is refused and nothing is created',
    (await dev(`select public.cl_terminal_join('NEWTERM3','biz phrase','K-T4',$1) j`, [c2.code])).error === 'JOIN_CODE_EXPIRED'
    && (await q(`select count(*)::int n from cl_vendors where install_id='NEWTERM3'`))[0].n === 0);
  ok('joined terminal checks in to its own row: no new vendor, terminal id returned',
    (await ci('NEWTERM1', 'biz phrase', 'K-T2')).terminal_id === j1.terminal_id);
  ok('check-in updates last_seen_ts', (await q(`select last_seen_ts is not null s from cl_terminals where id=$1`, [j1.terminal_id]))[0].s);

  // ---- an existing remote device joins a new remote branch ----
  await ci('REMOTE01', 'Remote Own Phrase', 'K-R');
  const rcode = await dev(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN1234',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-MAIN',p_new_branch_name=>'Bulawayo') j`);
  ok('main can create a remote branch while issuing a code', rcode.branch_name === 'Bulawayo');
  ok("'Bula wayo' is the same branch as 'Bulawayo' (no duplicate)",
    (await dev(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN1234',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-MAIN',p_new_branch_name=>'Bula wayo') j`)).branch_id === rcode.branch_id);
  const mism = await dev(`select public.cl_terminal_join(p_install_id=>'REMOTE01',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-R',p_join_code=>$1,p_device_phrase=>'Remote Own Phrase',p_expected_branch_name=>'Mutare') j`, [rcode.code]);
  ok('branch-name mismatch refused with the branch name, nothing written',
    mism.error === 'BRANCH_NAME_MISMATCH' && mism.branch_name === 'Bulawayo'
    && (await q(`select business_id from cl_vendors where install_id='REMOTE01'`))[0].business_id === null);
  ok('the code stays usable after a mismatch', (await q(`select used_by_terminal from cl_branch_join_codes where code_hash=encode(extensions.digest($1,'sha256'),'hex')`, [rcode.code.replace('-', '')]))[0].used_by_terminal === null);
  ok('wrong business phrase refused', (await dev(`select public.cl_terminal_join('REMOTE01','wrong','K-R',$1) j`, [rcode.code])).error === 'PHRASE_MISMATCH');
  const rj = await dev(`select public.cl_terminal_join(p_install_id=>'REMOTE01',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-R',p_join_code=>$1,p_legacy_branch_id=>'B-WXYZ6789',p_device_phrase=>'Remote Own Phrase',p_expected_branch_name=>'BULAWAYO') j`, [rcode.code]);
  ok('existing remote joins as T1 of its branch', rj.till_code === 'T1' && rj.is_main === false && rj.branch_name === 'Bulawayo', JSON.stringify(rj));
  ok("remote's own vendor row and phrase are kept",
    (await q(`select shop_secret_phrase p, business_id b from cl_vendors where install_id='REMOTE01'`))[0].p === 'Remote Own Phrase');
  ok('legacy branch id recorded on the branch', (await q(`select legacy_branch_id l from cl_branches where id=$1`, [rj.branch_id]))[0].l === 'B-WXYZ6789');
  ok('a remote terminal cannot issue codes', /main-branch/.test((await as('anon', `select public.cl_branch_issue_join_code('REMOTE01','Remote Own Phrase','K-R',$1::uuid)`, [rj.branch_id])).e || ''));
  ok('a remote device cannot register as a second main', /not the main branch/.test((await as('anon', `select public.cl_branch_register('REMOTE01','Remote Own Phrase','K-R','X','Bulawayo')`)).e || ''));
  ok('joining a second business is refused', await (async () => {
    const other = await dev(`select public.cl_branch_register('MAIN9999','Other Phrase','K-M9','Other Biz','Mutare') j`);
    const oc = await dev(`select public.cl_branch_issue_join_code('MAIN9999','Other Phrase','K-M9',$1::uuid) j`, [other.branch_id]);
    return (await dev(`select public.cl_terminal_join(p_install_id=>'NEWTERM1',p_secret_phrase=>'Other Phrase',p_device_key=>'K-T2',p_join_code=>$1,p_device_phrase=>'biz phrase') j`, [oc.code])).error === 'ALREADY_JOINED';
  })());

  // ---- branch list ----
  const list = await dev(`select public.cl_branch_list('MAIN1234','Biz Phrase','K-MAIN') j`);
  ok("main's list: 2 branches, main first, with terminals", list.branches.length === 2 && list.branches[0].is_main && list.branches[0].terminals.length === 2);
  const rlist = await dev(`select public.cl_branch_list('REMOTE01','Remote Own Phrase','K-R') j`);
  ok("a remote's list shows branches but no terminals", rlist.branches.length === 2 && rlist.branches.every(b => b.terminals === null));
  ok('an unregistered device cannot list', /not a registered terminal/.test((await as('anon', `select public.cl_branch_list('FRESH001','Any','K-F')`)).e || ''));

  // ---- failure limit ----
  ok('an invalid code is counted', (await dev(`select public.cl_terminal_join('ZZZZZZZZ','x','k','AAAA-AAAA') j`)).error === 'JOIN_CODE_INVALID'
    && (await q(`select count(*)::int n from cl_join_failures where install_id='ZZZZZZZZ'`))[0].n === 1);
  for (let i = 0; i < 9; i++) await as('anon', `select public.cl_terminal_join('ZZZZZZZZ','x','k','AAAA-AAAA')`);
  ok('the 11th wrong code in an hour is locked out', /JOIN_LOCKED/.test((await as('anon', `select public.cl_terminal_join('ZZZZZZZZ','x','k','AAAA-AAAA')`)).e || ''));

  // ---- rollback ----
  const vendorsBefore = (await q(`select count(*)::int n from cl_vendors`))[0].n;
  await pg.exec(RB);
  ok('rollback applies', true);
  ok('rollback: new tables gone', (await q(`select to_regclass('public.cl_terminals') t, to_regclass('public.cl_businesses') b`)).every(r => r.t === null && r.b === null));
  ok('rollback: every cl_vendors row kept', (await q(`select count(*)::int n from cl_vendors`))[0].n === vendorsBefore);
  ok('rollback: business_id / device_key columns gone',
    (await q(`select count(*)::int n from information_schema.columns where table_name='cl_vendors' and column_name in ('business_id','device_key')`))[0].n === 0);
  ok('rollback: the original check-in works again', (await dev(`select public.cl_device_checkin('OLD1','Shop Phrase','OLD1-C3','Old Shop') j`)).vendor_id);
  ok('rollback: original check-in is case-sensitive again', /does not match/.test((await as('anon', `select public.cl_device_checkin('OLD1','shop phrase','OLD1-C3','Old Shop')`)).e || ''));

  await pg.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
