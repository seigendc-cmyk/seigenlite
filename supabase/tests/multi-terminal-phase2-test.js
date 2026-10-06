// node supabase/tests/multi-terminal-phase2-test.js
//
// Tests supabase/migrations/20261004180000_multi_terminal_phase2.sql (and
// its rollback) in an in-memory PGlite — never against the live database.
// The database is first brought to the live state: the shared live stub,
// then the Phase 1 migration (live since 2026-10-04).
'use strict';
const fs = require('fs');
const path = require('path');
const { LIVE_STUB } = require('./live-stub');

const ROOT = path.join(__dirname, '..');
const P1 = fs.readFileSync(`${ROOT}/migrations/20261004120000_multi_terminal_identity.sql`, 'utf8');
const MIG = fs.readFileSync(`${ROOT}/migrations/20261004180000_multi_terminal_phase2.sql`, 'utf8');
const RB = fs.readFileSync(`${ROOT}/rollbacks/20261004180000_multi_terminal_phase2.rollback.sql`, 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const q0 = async (pg, sql, p) => (await pg.query(sql, p)).rows;
  async function freshDb() {
    const pg = new PGlite({ extensions: { pgcrypto } });
    await pg.exec(LIVE_STUB); await pg.exec(P1);
    return pg;
  }
  const pg = await freshDb();
  const q = (sql, p) => q0(pg, sql, p);
  async function anon(sql, p) {
    await pg.exec('set role anon');
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  }
  const dev = async (sql, p) => { const x = await anon(sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };
  const ci = (iid, ph, key) => dev(`select public.cl_device_checkin(p_install_id=>$1, p_shop_secret_phrase=>$2, p_device_code=>$1||'-C1', p_business_name=>'X', p_device_key=>$3) j`, [iid, ph, key]);

  // ---- live-like state before the migration: main T1, T2, a remote branch with T1 ----
  const reg = await dev(`select public.cl_branch_register('MAIN1234','Biz Phrase','K-MAIN','Gentronix','Harare CBD','B-ABCD2345','Front till') j`);
  const code = await dev(`select public.cl_branch_issue_join_code('MAIN1234','Biz Phrase','K-MAIN',$1::uuid) j`, [reg.branch_id]);
  const t2 = await dev(`select public.cl_terminal_join('TERM0002','Biz Phrase','K-T2',$1,'Back till') j`, [code.code]);
  const rc = await dev(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN1234',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-MAIN',p_new_branch_name=>'Zürich Café') j`);
  const rt = await dev(`select public.cl_terminal_join('REMOTE01','Biz Phrase','K-R',$1) j`, [rc.code]);
  ok('setup: main T1, main T2, remote T1', reg.till_code === 'T1' && t2.till_code === 'T2' && rt.till_code === 'T1');

  // ---- preflight ----
  {
    const other = await freshDb();
    await q0(other, `select public.cl_branch_register('M2','P','K','Biz','Main')`);
    const biz = (await q0(other, `select id from cl_businesses`))[0].id;
    // 'Zurich' and 'Zürich' are different branches under the Phase 1 key but one under the new key
    await q0(other, `insert into cl_branches (business_id, name) values ($1, 'Zurich'), ($1, 'Zürich')`, [biz]);
    let e = null; try { await other.exec(MIG); } catch (x) { e = x.message; await other.exec("rollback"); }
    ok('preflight aborts on names the new key makes equal, naming them', /new key makes equal: .*'Zurich' = 'Zürich'/.test(e || ''), e);
    ok('... and nothing was changed', (await q0(other, `select count(*)::int n from pg_proc where proname='cl_terminal_set_active'`))[0].n === 0
      && (await q0(other, `select cl_branch_key('Zürich') k`))[0].k === 'zrich');
    await other.close();
  }

  await pg.exec(MIG);
  ok('migration applies to the live (Phase 1) state', true);

  // ---- branch key ----
  ok('key folds accents like the app', (await q(`select cl_branch_key('Zürich Café – Ünit L') k`))[0].k === 'zurichcafeunitl');
  ok('key caps at 24 characters like the app', (await q(`select cl_branch_key('Chitungwiza Unit L Shopping Centre') k`))[0].k === 'chitungwizaunitlshopping');
  ok("a name of symbols only keys as 'branch' (app: \"Branch\")", (await q(`select cl_branch_key(' – ') k`))[0].k === 'branch');
  ok('existing names unchanged: Harare CBD', (await q(`select cl_branch_key('Harare CBD') k`))[0].k === 'hararecbd');
  ok("'Zurich Cafe' is now the same branch as 'Zürich Café' (no duplicate)",
    (await dev(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN1234',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-MAIN',p_new_branch_name=>'Zurich Cafe') j`)).branch_id === rc.branch_id);
  ok('the unique index refuses the folded duplicate',
    /duplicate key|unique/.test(await (async () => { try { await q(`insert into cl_branches (business_id, name) values ($1, 'ZURICH-CAFE')`, [reg.business_id]); return ''; } catch (e) { return e.message; } })()));
  ok('anon still cannot call cl_branch_key', /permission denied/.test((await anon(`select cl_branch_key('x')`)).e || ''));

  // ---- check-in reply ----
  ok('check-in reports terminal_active true for an active till', (await ci('TERM0002', 'Biz Phrase', 'K-T2')).terminal_active === true);
  const fresh = await ci('FRESH001', 'Any', 'K-F');
  ok('check-in reports terminal_active null for an install that is no till', fresh.terminal_active === null && fresh.vendor_id);

  // ---- cl_terminal_set_active ----
  const setA = (iid, ph, key, tid, a) => anon(`select public.cl_terminal_set_active($1,$2,$3,$4::uuid,$5) j`, [iid, ph, key, tid, a]);
  ok('a remote till cannot change terminals', /Only a main-branch terminal/.test((await setA('REMOTE01', 'Biz Phrase', 'K-R', t2.terminal_id, false)).e || ''));
  ok('a wrong phrase is refused', /does not match/.test((await setA('MAIN1234', 'nope', 'K-MAIN', t2.terminal_id, false)).e || ''));
  ok('a wrong device key is refused', /another device/.test((await setA('MAIN1234', 'Biz Phrase', 'K-OTHER', t2.terminal_id, false)).e || ''));
  ok('main cannot deactivate itself', /cannot deactivate itself/.test((await setA('MAIN1234', 'Biz Phrase', 'K-MAIN', reg.terminal_id, false)).e || ''));
  {
    const other = await dev(`select public.cl_branch_register('MAIN9999','Other Phrase','K-M9','Other Biz','Mutare') j`);
    ok("main cannot touch another business's till", /not found in this business/.test((await setA('MAIN1234', 'Biz Phrase', 'K-MAIN', other.terminal_id, false)).e || ''));
  }
  const off = await setA('MAIN1234', 'Biz Phrase', 'K-MAIN', t2.terminal_id, false);
  ok('main deactivates T2', off.r && off.r[0].j.active === false && off.r[0].j.till_code === 'T2', off.e);
  ok('T2 is inactive in the table', (await q(`select active from cl_terminals where id=$1`, [t2.terminal_id]))[0].active === false);
  const log = await q(`select staff_id, detail from cl_activity_log where action='terminal_deactivated' and target_id=$1`, [t2.terminal_id]);
  ok('logged with staff_id null and the acting till', log.length === 1 && log[0].staff_id === null && log[0].detail.by_till === 'T1' && log[0].detail.till_code === 'T2');
  ok('deactivating again writes no second log row',
    !(await setA('MAIN1234', 'Biz Phrase', 'K-MAIN', t2.terminal_id, false)).e
    && (await q(`select count(*)::int n from cl_activity_log where action='terminal_deactivated' and target_id=$1`, [t2.terminal_id]))[0].n === 1);
  ok('other tills unaffected', (await q(`select count(*)::int n from cl_terminals where active`))[0].n === 3);

  // ---- an inactive till ----
  const ci2 = await ci('TERM0002', 'Biz Phrase', 'K-T2');
  ok('an inactive till still checks in (licensing is per install), told terminal_active false', ci2.vendor_id && ci2.terminal_active === false);
  const code2 = await dev(`select public.cl_branch_issue_join_code('MAIN1234','Biz Phrase','K-MAIN',$1::uuid) j`, [reg.branch_id]);
  ok('it cannot join again: TERMINAL_INACTIVE', (await dev(`select public.cl_terminal_join('TERM0002','Biz Phrase','K-T2',$1) j`, [code2.code])).error === 'TERMINAL_INACTIVE');
  ok('... and the code is not used up', (await q(`select used_by_terminal from cl_branch_join_codes where code_hash=encode(extensions.digest($1,'sha256'),'hex')`, [code2.code.replace('-', '')]))[0].used_by_terminal === null);
  ok('it cannot join another branch either', (await dev(`select public.cl_terminal_join('TERM0002','Biz Phrase','K-T2',$1) j`,
    [(await dev(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN1234',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-MAIN',p_new_branch_name=>'Mutare') j`)).code])).error === 'TERMINAL_INACTIVE');
  ok('it cannot register a branch: TERMINAL_INACTIVE', (await dev(`select public.cl_branch_register('TERM0002','Biz Phrase','K-T2','Gentronix','Harare CBD') j`)).error === 'TERMINAL_INACTIVE');
  ok('it cannot list branches (Phase 1 rule)', /not a registered terminal/.test((await anon(`select public.cl_branch_list('TERM0002','Biz Phrase','K-T2')`)).e || ''));
  ok('active tills still register/join as before',
    (await dev(`select public.cl_branch_register('MAIN1234','Biz Phrase','K-MAIN','Gentronix','Harare CBD') j`)).terminal_id === reg.terminal_id);
  const list = await dev(`select public.cl_branch_list('MAIN1234','Biz Phrase','K-MAIN') j`);
  ok("main's list shows T2 inactive", list.branches[0].terminals.find(t => t.till_code === 'T2').active === false);

  // ---- reactivate ----
  const on = await setA('MAIN1234', 'Biz Phrase', 'K-MAIN', t2.terminal_id, true);
  ok('main reactivates T2 (logged)', on.r && on.r[0].j.active === true
    && (await q(`select count(*)::int n from cl_activity_log where action='terminal_reactivated' and target_id=$1`, [t2.terminal_id]))[0].n === 1);
  ok('reactivated T2 checks in active and can retry its join', (await ci('TERM0002', 'Biz Phrase', 'K-T2')).terminal_active === true
    && (await dev(`select public.cl_terminal_join('TERM0002','Biz Phrase','K-T2',$1) j`, [code2.code])).terminal_id === t2.terminal_id);

  // ---- rollback ----
  await setA('MAIN1234', 'Biz Phrase', 'K-MAIN', rt.terminal_id, false);       // left deactivated by the RPC
  await q(`update cl_terminals set active = false where id = $1`, [t2.terminal_id]);  // made inactive some other way: not ours to undo
  await q(`insert into cl_activity_log (action, target_table, target_id) values ('terminal_reactivated', 'cl_terminals', $1)`, [t2.terminal_id]);
  await pg.exec(RB);
  ok('rollback applies', true);
  ok('rollback: the till the RPC deactivated is active again', (await q(`select active from cl_terminals where id=$1`, [rt.terminal_id]))[0].active === true);
  ok("rollback: a till whose latest log entry isn't a deactivation is left alone", (await q(`select active from cl_terminals where id=$1`, [t2.terminal_id]))[0].active === false);
  ok('rollback: cl_terminal_set_active gone', (await q(`select count(*)::int n from pg_proc where proname='cl_terminal_set_active'`))[0].n === 0);
  ok('rollback: Phase 1 key again', (await q(`select cl_branch_key('Zürich Café') k`))[0].k === 'zrichcaf');
  ok('rollback: check-in reply has no terminal_active key', !('terminal_active' in (await ci('MAIN1234', 'Biz Phrase', 'K-MAIN'))));
  ok('rollback: register works as in Phase 1', (await dev(`select public.cl_branch_register('MAIN1234','Biz Phrase','K-MAIN','Gentronix','Harare CBD') j`)).terminal_id === reg.terminal_id);
  ok('rollback: activity-log history kept', (await q(`select count(*)::int n from cl_activity_log where action like 'terminal_%'`))[0].n >= 3);
  {
    // rollback preflight: names distinct under the new key but equal under the old one
    const other = await freshDb();
    await other.exec(MIG);
    await q0(other, `select public.cl_branch_register('M2','P','K','Biz','Main')`);
    const biz = (await q0(other, `select id from cl_businesses`))[0].id;
    await q0(other, `insert into cl_branches (business_id, name) values ($1, 'Zürich'), ($1, 'Zrich')`, [biz]);
    let e = null; try { await other.exec(RB); } catch (x) { e = x.message; await other.exec("rollback"); }
    ok('rollback aborts, changing nothing, on names the old key makes equal', /old key makes equal/.test(e || '')
      && (await q0(other, `select count(*)::int n from pg_proc where proname='cl_terminal_set_active'`))[0].n === 1, e);
    await other.close();
  }

  await pg.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
