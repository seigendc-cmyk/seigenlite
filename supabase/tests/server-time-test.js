// node supabase/tests/server-time-test.js
//
// Tests supabase/migrations/20261020120000_server_time.sql (and its rollback)
// in an in-memory PGlite built from the repo (the live shape), never the live
// database: anon can call it, it answers now() as ISO UTC in the body, it
// reads and writes nothing, the preflight refuses a second run, and the
// rollback restores the exact catalogue.
'use strict';
const path = require('path');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261020120000_server_time.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261021120000_billing_b.sql', '20261022120000_catalogue_merge_links.sql']) });   // the shape just before this migration (it is on live now)
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  const as = async (role, sql) => {
    await pg.exec('set role ' + role);
    try { return { r: await q(sql) }; } catch (e) { return { e: e.message }; } finally { await pg.exec('reset role'); }
  };

  let e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('the migration applies on the live shape (it needs nothing from 20261019120000)', !e, e);
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /server_time aborted: already there/.test(e || ''), e);

  for (const role of ['anon', 'authenticated', 'service_role']) {
    const t0 = Date.now();
    const x = await as(role, 'select public.cl_server_time() j');
    const iso = x.r && x.r[0].j && x.r[0].j.now;
    ok(role + ' gets the time as ISO UTC in the body', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso || '') && Math.abs(Date.parse(iso) - t0) < 60000, JSON.stringify(x));
  }
  const fn = (await q(`select prosecdef, provolatile from pg_proc where oid = 'public.cl_server_time()'::regprocedure`))[0];
  ok('security invoker and stable (reads and writes nothing)', fn.prosecdef === false && fn.provolatile === 's', JSON.stringify(fn));
  const pub = await q(`select has_function_privilege('public', 'public.cl_server_time()', 'execute') p`);
  ok('PUBLIC has no execute grant of its own', pub[0].p === false);

  const afterApply = fingerprint(await snapshot(q));
  const d1 = diff(before, afterApply);
  ok('it adds only the function and its grants', !d1.onlyA.length && !d1.changed.length && d1.onlyB.every((k) => /cl_server_time/.test(k)), JSON.stringify(d1).slice(0, 600));

  await pg.exec(RB);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('the rollback restores the exact pre-migration catalogue', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('and the migration applies again after a rollback', !e, e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
