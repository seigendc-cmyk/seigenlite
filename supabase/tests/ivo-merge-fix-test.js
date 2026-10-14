// node supabase/tests/ivo-merge-fix-test.js
//
// Tests supabase/data-fixes/20261025_ivo_merge.sql and its undo in an
// in-memory PGlite (the live shape), never the live database: IVO Dist and
// IVO Motor Spares are rebuilt as on live (IVO Dist: one branch Warehouse,
// one till last seen 7 Oct, two device rows, nothing else; IVO Motor Spares:
// Warehouse + Norton), the files' ids are swapped for this database's, and
// each file is run exactly as tools/db/run-data-fix.js runs it.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FIX = READ(path.join(ROOT, 'data-fixes', '20261025_ivo_merge.sql'));
const UNDO = READ(path.join(ROOT, 'data-fixes', '20261025_ivo_merge_undo.sql'));
const LIVE = { keep: '32f8d976-d651-439a-b45e-15d7251b1bb8', dist: 'c8d4116c-d88d-426e-aa25-b2aff24c33c7',
  dbr: 'dbeba305-1b5a-4674-b29d-67442a28c77b', dt1: '3c1d5016-9bc2-4ac6-8f02-f290c3ff5bca',
  v1: 'faa5d2ea-a722-4e42-ab04-30ed8d3847df', v2: 'e8e4438f-2e4b-444e-92a6-e1ee957272ae' };

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES });   // the live shape
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const run = async (sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || crypto.randomBytes(16).toString('hex'));
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    await pg.exec('set role anon');
    try { return { j: (await q(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) j`, names.map((n) => args[n])))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };

  // as on live
  const d = (await anon('cl_branch_register', { p_install_id: 'DIST', p_secret_phrase: 'Dist Phrase', p_device_key: key('DIST'), p_business_name: 'IVO Dist', p_branch_name: 'Warehouse' })).j;
  const k = (await anon('cl_branch_register', { p_install_id: 'IVOM', p_secret_phrase: 'Ivo Phrase', p_device_key: key('IVOM'), p_business_name: 'IVO Motor Spares', p_branch_name: 'Warehouse' })).j;
  ok('set-up: both businesses registered', d && d.business_id && k && k.business_id, JSON.stringify({ d, k }));
  await q(`insert into cl_branches (id, business_id, name, is_main, created_ts, price_mode, price_mode_seq, stock_mode)
           values (gen_random_uuid(), $1, 'Norton', false, now(), 'follow_main', 0, 'local')`, [k.business_id]);
  await q(`update cl_terminals set last_seen_ts = '2026-10-07 10:55+00' where business_id = $1`, [d.business_id]);
  const dt1 = (await q(`select id, vendor_id from cl_terminals where business_id = $1`, [d.business_id]))[0];
  const v2 = (await q(`insert into cl_vendors (business_name, status, created_at, install_id, location, lock_cart, lock_add_product)
                       values ('IVO Dist', 'onboarding', '2026-09-28', 'OLDDIST', 'WAREHOUSE', false, false) returning id`))[0].id;
  const local = (sql) => sql.split(LIVE.keep).join(k.business_id).split(LIVE.dist).join(d.business_id).split(LIVE.dbr).join(d.branch_id)
    .split(LIVE.dt1).join(dt1.id).split(LIVE.v1).join(dt1.vendor_id).split(LIVE.v2).join(v2);
  const FIXL = local(FIX), UNDOL = local(UNDO);
  ok('the files name exactly the 6 live ids they were written for', Object.values(LIVE).every((id) => FIX.includes(id)) &&
    Object.values(LIVE).filter((id) => id !== LIVE.keep && id !== LIVE.dbr && id !== LIVE.dt1).every((id) => UNDO.includes(id)));

  const keepRows = async () => JSON.stringify(await q(`select (select row_to_json(b) from cl_businesses b where id = $1) b,
      (select json_agg(row_to_json(x) order by id) from cl_branches x where business_id = $1) br,
      (select json_agg(row_to_json(t) order by id) from cl_terminals t where business_id = $1) t,
      (select json_agg(row_to_json(v) order by id) from cl_vendors v where business_id = $1) v`, [k.business_id]));
  const keep0 = await keepRows();
  const archived = async () => (await q(`select (select archived_at is not null from cl_businesses where id = $1) b,
      (select count(*)::int from cl_vendors where id in ($2, $3) and archived_at is not null) v`, [d.business_id, dt1.vendor_id, v2]))[0];

  // live differs -> refused, nothing changed
  await q(`update cl_terminals set last_seen_ts = now() where id = $1`, [dt1.id]);
  let r = await run(FIXL);
  ok('IVO Dist\'s till checked in since 7 Oct: refused, nothing changed', /checked in since 7 Oct/.test(r.e || '') && (await archived()).b === false, r.e);
  await q(`update cl_terminals set last_seen_ts = '2026-10-07 10:55+00' where id = $1`, [dt1.id]);
  await q(`insert into cl_catalogue_products (business_id, product_uid, code, name, price, cost, low_threshold, active, change_seq, last_op_id, updated_ts)
           values ($1, replace(gen_random_uuid()::text, '-', ''), 'BP1', 'Brake pads', 5, 2, 0, true, nextval('cl_catalogue_seq'), 'test-op', now())`, [d.business_id]);
  r = await run(FIXL);
  ok('IVO Dist has a catalogue product: refused ("needs a real merge plan"), nothing changed', /1 catalogue products on seiGEN; that needs a real merge plan/.test(r.e || '') && (await archived()).b === false, r.e);
  await q(`delete from cl_catalogue_products where business_id = $1`, [d.business_id]);

  r = await run(UNDOL);
  ok('the undo before the merge: refused, nothing changed', /isn't archived by the IVO merge/.test(r.e || ''), r.e);

  // as designed
  const log0 = (await q(`select count(*)::int c from cl_activity_log`))[0].c;
  r = await run(FIXL);
  ok('as designed: it runs', r.ok, r.e);
  ok('IVO Dist and its two device rows are archived', JSON.stringify(await archived()) === JSON.stringify({ b: true, v: 2 }), JSON.stringify(await archived()));
  ok('IVO Motor Spares (business, branches, tills, device rows) is exactly as before', (await keepRows()) === keep0);
  ok('nothing was deleted or moved: IVO Dist still has its branch and till',
    (await q(`select count(*)::int c from cl_branches where business_id = $1`, [d.business_id]))[0].c === 1 &&
    (await q(`select count(*)::int c from cl_terminals where business_id = $1`, [d.business_id]))[0].c === 1);
  const logs = await q(`select action, detail->>'reason' reason from cl_activity_log order by id desc limit 3`).catch(async () => q(`select action, detail->>'reason' reason from cl_activity_log order by created_at desc limit 3`));
  ok('the archive is logged: the business and both device rows, with the reason',
    (await q(`select count(*)::int c from cl_activity_log`))[0].c === log0 + 3 && logs.every((l) => /IVO merge \(owner, 2026-10-14\)/.test(l.reason || '')), JSON.stringify(logs));
  const ci = await anon('cl_device_checkin', { p_install_id: 'DIST', p_shop_secret_phrase: 'Dist Phrase', p_device_code: null, p_business_name: 'IVO Dist', p_device_key: key('DIST'), p_app_build: 22 });
  ok('if IVO Dist\'s old device ever opens again, its check-in still works (archive is only a label)', ci.j && ci.j.business_id === d.business_id, JSON.stringify(ci));
  await q(`update cl_terminals set last_seen_ts = '2026-10-07 10:55+00' where id = $1`, [dt1.id]);

  r = await run(FIXL);
  ok('a second run is refused', /already archived/.test(r.e || ''), r.e);

  // undo
  r = await run(UNDOL);
  ok('the undo runs', r.ok, r.e);
  ok('after the undo nothing is archived', JSON.stringify(await archived()) === JSON.stringify({ b: false, v: 0 }));
  ok('after the undo IVO Motor Spares is still exactly as before', (await keepRows()) === keep0);
  r = await run(UNDOL);
  ok('a second undo is refused', /isn't archived by the IVO merge/.test(r.e || ''), r.e);
  r = await run(FIXL);
  ok('and the merge can be run again after an undo', r.ok && (await archived()).b === true, r.e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
