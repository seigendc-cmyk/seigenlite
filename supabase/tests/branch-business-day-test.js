// node supabase/tests/branch-business-day-test.js
//
// Tests supabase/migrations/20261009120000_branch_business_day.sql (and its
// rollback) in an in-memory PGlite — never against the live database. The
// database is first brought to the live state: the shared live stub, then
// Phase 1, 2, 3a, 3b, the build guard and the check-in lock.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LIVE_STUB } = require('./live-stub');

const ROOT = path.join(__dirname, '..');
const READ = (f) => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const BEFORE = ['migrations/20261004120000_multi_terminal_identity.sql', 'migrations/20261004180000_multi_terminal_phase2.sql',
  'migrations/20261006120000_catalogue_sync.sql', 'migrations/20261007120000_shared_stock.sql',
  'migrations/20261008120000_till_build_guard.sql', 'migrations/20261008140000_shared_stock_checkin_lock.sql'].map(READ);
const MIG = READ('migrations/20261009120000_branch_business_day.sql');
const RB = READ('rollbacks/20261009120000_branch_business_day.rollback.sql');
const PULL_3A_MD5 = 'a14390d89155c1286a028d56845194fd';   // read from the live database (read-only), 2026-10-07

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}
const hex = () => crypto.randomBytes(16).toString('hex');

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec(LIVE_STUB);
  for (const m of BEFORE) await pg.exec(m);
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  async function anon(sql, p) {
    await pg.exec('set role anon');
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  }
  const dev = async (sql, p) => { const x = await anon(sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };
  const pullMd5 = async () => (await q(`select md5(prosrc) m from pg_proc where proname='cl_catalogue_pull'`))[0].m;

  // ---- live-like state: Harare (main) T1, T2; Murehwa T1 ----
  const reg = await dev(`select public.cl_branch_register('MAIN0001','Biz Phrase','K-1','Gentronix','Harare','B-ABCD2345','Front') j`);
  const code = async (newName) => (await dev(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN0001',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-1',p_branch_id=>$1::uuid,p_new_branch_name=>$2) j`,
    [newName ? null : reg.branch_id, newName || null])).code;
  await dev(`select public.cl_terminal_join('TILL0002','Biz Phrase','K-2',$1) j`, [await code()]);
  const rm = await dev(`select public.cl_terminal_join('REMOTE01','Biz Phrase','K-R',$1) j`, [await code('Murehwa')]);
  await dev(`select public.cl_catalogue_push('MAIN0001','Biz Phrase','K-1',$1::jsonb) j`, [JSON.stringify([{ uid: hex(), op_id: hex(), code: 'RICE', name: 'Rice', price: 1 }])]);
  const pull = (who, key) => dev(`select public.cl_catalogue_pull('${who}','Biz Phrase','${key}',0,500) j`);
  const setDay = (who, key, branch, h) => anon(`select public.cl_branch_set_business_day('${who}','Biz Phrase','${key}',$1::uuid,$2) j`, [branch, h]);

  ok('the repo\'s Phase 3a cl_catalogue_pull has the live body (md5)', await pullMd5() === PULL_3A_MD5, await pullMd5());
  const before = await pull('TILL0002', 'K-2');

  await pg.exec(MIG);
  ok('migration applies', true);
  const after = await pull('TILL0002', 'K-2');
  const strip = (o) => { const c = Object.assign({}, o); delete c.business_day_cutoff; return JSON.stringify(c); };
  ok('pull answer unchanged apart from the new key (null = not set)', strip(after) === JSON.stringify(before) && after.business_day_cutoff === null, JSON.stringify(after));

  let r = await setDay('MAIN0001', 'K-1', rm.branch_id, 3);
  ok('main sets Murehwa to 03:00', !r.e && r.r[0].j.business_day_cutoff === 3, JSON.stringify(r));
  ok('a Murehwa till pulls 3', (await pull('REMOTE01', 'K-R')).business_day_cutoff === 3);
  ok('Harare tills still pull null', (await pull('TILL0002', 'K-2')).business_day_cutoff === null);
  r = await setDay('MAIN0001', 'K-1', rm.branch_id, 3);
  ok('same value again: unchanged', r.r[0].j.unchanged === true);
  r = await setDay('MAIN0001', 'K-1', reg.branch_id, 0);
  ok('main sets its own branch to 00:00 (0, not null)', r.r[0].j.business_day_cutoff === 0 && (await pull('TILL0002', 'K-2')).business_day_cutoff === 0);
  r = await setDay('REMOTE01', 'K-R', rm.branch_id, 5);
  ok('a non-main till is refused (NOT_MAIN)', r.r[0].j.error === 'NOT_MAIN');
  r = await setDay('MAIN0001', 'K-1', rm.branch_id, 7);
  ok('07:00 is refused', !!r.e && /00:00 to 06:00/.test(r.e), JSON.stringify(r));
  r = await setDay('MAIN0001', 'K-1', '00000000-0000-0000-0000-000000000000', 2);
  ok('a branch of another business / unknown: UNKNOWN_BRANCH', r.r[0].j.error === 'UNKNOWN_BRANCH');
  r = await setDay('MAIN0001', 'K-1', rm.branch_id, null);
  ok('null clears it', r.r[0].j.business_day_cutoff === null && (await pull('REMOTE01', 'K-R')).business_day_cutoff === null);
  r = await anon(`select public.cl_branch_set_business_day('MAIN0001','Wrong','K-1',$1::uuid,2) j`, [rm.branch_id]);
  ok('wrong phrase is refused', !!r.e);
  ok('no table grants to anon on cl_branches', !!(await anon(`select * from public.cl_branches`)).e);

  let again = null; try { await pg.exec(MIG); } catch (e) { again = e.message; await pg.exec("rollback"); }
  ok('applying twice is refused by the preflight, nothing changed', /already exists/.test(again || ''), again);

  await pg.exec(RB);
  ok('rollback restores the Phase 3a body exactly', await pullMd5() === PULL_3A_MD5);
  const col = await q(`select 1 from information_schema.columns where table_name='cl_branches' and column_name='business_day_cutoff'`);
  const fn = await q(`select 1 from pg_proc where proname='cl_branch_set_business_day'`);
  ok('rollback drops the column and the RPC', col.length === 0 && fn.length === 0);
  ok('pull after rollback = pull before the migration', JSON.stringify(await pull('TILL0002', 'K-2')) === JSON.stringify(before));

  await pg.exec(`create or replace function public.cl_catalogue_pull(p_install_id text, p_secret_phrase text, p_device_key text, p_cursor bigint, p_limit integer default 500)
    returns json language sql as $$ select '{}'::json $$`);
  let refused = null; try { await pg.exec(MIG); } catch (e) { refused = e.message; await pg.exec("rollback"); }
  ok('the preflight refuses a cl_catalogue_pull that isn\'t the 3a definition', /not the Phase 3a definition/.test(refused || ''), refused);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
