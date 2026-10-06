// node supabase/tests/till-build-guard-test.js
//
// Tests supabase/migrations/20261008120000_till_build_guard.sql (and its
// rollback) in an in-memory PGlite — never against the live database. The
// database is first brought to the live state: the shared live stub, then
// Phase 1, Phase 2, Phase 3a and Phase 3b.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LIVE_STUB } = require('./live-stub');

const ROOT = path.join(__dirname, '..');
const READ = (f) => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const BEFORE = ['migrations/20261004120000_multi_terminal_identity.sql', 'migrations/20261004180000_multi_terminal_phase2.sql',
  'migrations/20261006120000_catalogue_sync.sql', 'migrations/20261007120000_shared_stock.sql'].map(READ);
const MIG = READ('migrations/20261008120000_till_build_guard.sql');
const RB = READ('rollbacks/20261008120000_till_build_guard.rollback.sql');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}
const hex = () => crypto.randomBytes(16).toString('hex');

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  async function liveDb(upTo) {
    const pg = new PGlite({ extensions: { pgcrypto } });
    await pg.exec(LIVE_STUB);
    for (const m of BEFORE.slice(0, upTo == null ? BEFORE.length : upTo)) await pg.exec(m);
    return pg;
  }
  const pg = await liveDb();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  async function anon(sql, p) {
    await pg.exec('set role anon');
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  }
  const dev = async (sql, p) => { const x = await anon(sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };

  // ---- live-like state: Harare with T1, T2, T3, T4; the catalogue ----
  const reg = await dev(`select public.cl_branch_register('MAIN0001','Biz Phrase','K-1','Gentronix','Harare','B-ABCD2345','Front') j`);
  const code = async () => (await dev(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN0001',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-1',p_branch_id=>$1::uuid,p_new_branch_name=>null) j`, [reg.branch_id])).code;
  const t2 = await dev(`select public.cl_terminal_join('TILL0002','Biz Phrase','K-2',$1) j`, [await code()]);
  const t3 = await dev(`select public.cl_terminal_join('TILL0003','Biz Phrase','K-3',$1) j`, [await code()]);
  const t4 = await dev(`select public.cl_terminal_join('TILL0004','Biz Phrase','K-4',$1) j`, [await code()]);
  const RICE = hex();
  await dev(`select public.cl_catalogue_push('MAIN0001','Biz Phrase','K-1',$1::jsonb) j`, [JSON.stringify([{ uid: RICE, op_id: hex(), code: 'RICE', name: 'Rice', price: 1 }])]);
  ok('setup: Harare T1..T4, 1 catalogue product', t4.till_code === 'T4');

  // a check-in exactly as PostgREST makes it: named arguments; p_app_build only when the build sends it
  const checkin = (inst, key, build) => dev(`select public.cl_device_checkin(p_install_id=>$1,p_shop_secret_phrase=>'Biz Phrase',p_device_code=>'DC',p_business_name=>'Gentronix',
      p_owner_name=>'',p_phone=>'',p_city=>'',p_location=>'Harare',p_rpn_hint_id=>null,p_device_key=>$2${build === undefined ? '' : ',p_app_build=>$3'})::json j`,
    build === undefined ? [inst, key] : [inst, key, build]);
  const buildOf = async (term) => (await q(`select app_build from cl_terminals where id=$1`, [term]))[0].app_build;
  const start = (op) => dev(`select public.cl_stock_start_shared('MAIN0001','Biz Phrase','K-1',$1,$2::jsonb) j`, [op, JSON.stringify([{ product_uid: RICE, qty: 20 }])]);
  const branchMode = async () => (await q(`select stock_mode from cl_branches where id=$1`, [reg.branch_id]))[0].stock_mode;

  // ---- preflight ----
  {
    const other = await liveDb();
    await other.exec(MIG);
    let e = null; try { await other.exec(MIG); } catch (x) { e = x.message; await other.exec('rollback'); }
    ok('applying twice aborts in the preflight', /already exists: .*app_build/.test(e || ''), e);
    await other.close();
    const bare = await liveDb(3);
    e = null; try { await bare.exec(MIG); } catch (x) { e = x.message; await bare.exec('rollback'); }
    ok('without Phase 3b it aborts in the preflight', /missing .*cl_stock_start_shared/.test(e || ''), e);
    await bare.close();
  }
  const aclBefore = (await q(`select array_to_string(proacl,' ') a from pg_proc where proname='cl_device_checkin'`))[0].a;
  await pg.exec(MIG);
  ok('migration applies to the live (Phase 3b) state', true);
  ok('one cl_device_checkin, with p_app_build', (await q(`select oid::regprocedure::text f from pg_proc where proname='cl_device_checkin'`)).map(r => r.f).join()
    === 'cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text,integer)');
  ok('check-in keeps its grants', (await q(`select array_to_string(proacl,' ') a from pg_proc where proname='cl_device_checkin'`))[0].a === aclBefore, aclBefore);
  ok('every till starts with no build reported', (await q(`select count(*)::int n from cl_terminals where app_build is not null`))[0].n === 0);

  // ---- check-in ----
  let r = await checkin('TILL0002', 'K-2');
  ok('an older build (10 named arguments) still checks in', r.terminal_id === t2.terminal_id && r.terminal_active === true);
  ok('... and its build stays unknown', (await buildOf(t2.terminal_id)) === null);
  await checkin('TILL0002', 'K-2', 8);
  ok('a new build reports its build', (await buildOf(t2.terminal_id)) === 8);
  await checkin('TILL0002', 'K-2');
  ok('the same till back on an older build: unknown again (never looks up to date)', (await buildOf(t2.terminal_id)) === null);
  await checkin('TILL0002', 'K-2', 0);
  ok('a nonsense build (0) is stored as unknown', (await buildOf(t2.terminal_id)) === null);
  ok('anon cannot read cl_terminals', /permission denied/.test((await anon(`select app_build from public.cl_terminals`)).e || ''));

  // ---- the guard ----
  r = await start(hex());
  ok('start refused: T2 has not reported a build (names T2)', r.error === 'TILL_NEEDS_UPDATE' && r.till_code === 'T2' && r.app_build === null && r.min_build === 7, JSON.stringify(r));
  ok('... and nothing changed', (await branchMode()) === 'local' && (await q(`select count(*)::int n from cl_stock_events`))[0].n === 0
    && (await q(`select count(*)::int n from cl_branch_stock`))[0].n === 0);
  await checkin('TILL0002', 'K-2', 8);
  await checkin('TILL0003', 'K-3', 6);
  r = await start(hex());
  ok('T2 on v8, T3 on v6: refused, names T3 and its build', r.error === 'TILL_NEEDS_UPDATE' && r.till_code === 'T3' && r.app_build === 6, JSON.stringify(r));
  await checkin('TILL0003', 'K-3', 7);
  r = await start(hex());
  ok('T4 never reported: refused, names T4', r.error === 'TILL_NEEDS_UPDATE' && r.till_code === 'T4', JSON.stringify(r));
  await dev(`select public.cl_terminal_set_active('MAIN0001','Biz Phrase','K-1',$1::uuid,false) j`, [t4.terminal_id]);
  ok('the other checks still come first (T2 may not start: not the holder)',
    (await dev(`select public.cl_stock_start_shared('TILL0002','Biz Phrase','K-2',$1,'[]'::jsonb) j`, [hex()])).error === 'NOT_HOLDER');
  ok('T1 itself never reported: the caller counts as v7+ (the RPC exists only in v7+)', (await buildOf(reg.terminal_id)) === null);
  r = await start(hex());
  ok('T2 v8, T3 v7, T4 inactive: start succeeds', r.stock_mode === 'shared' && r.products === 1, JSON.stringify(r));
  ok('the branch is shared with T1\'s stock', (await branchMode()) === 'shared'
    && (await q(`select total from cl_branch_stock where branch_id=$1`, [reg.branch_id]))[0].total === 20);

  // ---- rollback ----
  await pg.exec(RB);
  ok('rollback: cl_device_checkin back to 10 arguments with its grants',
    (await q(`select oid::regprocedure::text f, array_to_string(proacl,' ') a from pg_proc where proname='cl_device_checkin'`)).map(x => x.f + ' ' + x.a).join()
    === 'cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text) ' + aclBefore);
  ok('rollback: the build columns are gone', (await q(`select count(*)::int n from information_schema.columns where table_name='cl_terminals' and column_name like 'app_build%'`))[0].n === 0);
  ok('rollback: check-in works', (await checkin('TILL0003', 'K-3')).terminal_id === t3.terminal_id);
  const fn = (await q(`select prosrc from pg_proc where proname='cl_stock_start_shared'`))[0].prosrc;
  ok('rollback: start shared stock is the Phase 3b body again', !/build guard|TILL_NEEDS_UPDATE/.test(fn) && /SINGLE_TILL/.test(fn));
  ok('rollback: shared stock data kept', (await branchMode()) === 'shared');
  await pg.exec(MIG);
  ok('the migration applies again after the rollback', (await checkin('TILL0003', 'K-3', 8)).terminal_id === t3.terminal_id && (await buildOf(t3.terminal_id)) === 8);

  await pg.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
