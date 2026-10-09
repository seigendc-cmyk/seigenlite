// node supabase/tests/baseline-rebuild-test.js                       (PGlite + the committed live fingerprint)
// node supabase/tests/baseline-rebuild-test.js live                  (also re-reads live, read-only)
// node supabase/tests/baseline-rebuild-test.js live --write-fixture  (re-reads live, read-only, and rewrites the fixture)
//
// Proves supabase/migrations/20260923000000_baseline.sql: an EMPTY database
// (PGlite, with Supabase's roles, schemas and default privileges stubbed)
// built from the baseline followed by every later migration file has the
// same catalogue as the live project: tables, columns, constraints, indexes,
// functions (hash of the body), triggers, policies, RLS, comments and grants.
//
// Two builds: ALL files (every file must apply), and the LIVE SHAPE, which
// leaves out the files that aren't applied on live (NOT_ON_LIVE_FILES in
// rebuild-helpers.js: a migration waiting for "apply"; 20260926160000 was
// retired to supabase/parked/ on 2026-10-09). The live shape must equal live exactly.
//
// Live fingerprint: supabase/tests/fixtures/live-catalog-fingerprint.json,
// made by tools/db/catalog.js from a read-only snapshot (schema only, no rows).
// "live" mode reads live again (BEGIN READ ONLY ... ROLLBACK; SUPABASE_DB_URL
// from .env, never printed) and compares against that too.
'use strict';
const fs = require('fs');
const path = require('path');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { migrationFiles, NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ, MIG } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILES = migrationFiles();
const BASELINE = '20260923000000_baseline.sql';
const FIXTURE = path.join(__dirname, 'fixtures', 'live-catalog-fingerprint.json');

// Known drift in an APPLIED file, not in the baseline: 20260925150000 revokes
// only delete/truncate from service_role, so a rebuild keeps the default
// references/trigger on these two tables; live has neither (stricter than the
// file; removed outside any migration). Harmless; recorded, not hidden.
const KNOWN_DRIFT = {
  'grant rel portal_staff': ['service_role:REFERENCES', 'service_role:TRIGGER'],
  'grant rel vendor_tokens': ['service_role:REFERENCES', 'service_role:TRIGGER'],
};
const onlyKnownDrift = (c) => {
  const extra = KNOWN_DRIFT[c.key];
  if (!extra) return false;
  const a = JSON.parse(c.a), b = JSON.parse(c.b);
  return JSON.stringify(a.filter((x) => !extra.includes(x))) === JSON.stringify(b);
};

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n         ' + extra : '')); }
}
const show = (d) => JSON.stringify(d, null, 1).slice(0, 4000);

async function liveSnapshot() {
  const { Client } = require('pg');
  let url = null;
  for (const line of fs.readFileSync(path.join(ROOT, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*SUPABASE_DB_URL\s*=\s*(.*)\s*$/.exec(line); if (m) url = m[1].replace(/^["']|["']$/g, '');
  }
  const c = new Client({ connectionString: url, ssl: { ca: fs.readFileSync(path.join(ROOT, 'prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
    connectionTimeoutMillis: 20000, statement_timeout: 60000, query_timeout: 90000 });
  try {
    await c.connect();
    await c.query('begin read only');
    const snap = await snapshot(async (sql) => (await c.query(sql)).rows);
    await c.query('rollback');
    return snap;
  } catch (e) { throw new Error(String(e.message).split(url).join('[SUPABASE_DB_URL]')); }
  finally { await c.end().catch(() => {}); }
}

(async () => {
  const pg = await newPglite();
  const q = async (sql) => (await pg.query(sql)).rows;

  const base = READ(path.join(MIG, BASELINE));
  console.log('baseline file');
  ok('is the first migration file', FILES[0] === BASELINE, FILES[0]);
  ok('has no data rows (no INSERT / UPDATE / DELETE / COPY)', !/^\s*(insert|update|delete|copy)\s/im.test(base.replace(/\$function\$[\s\S]*?\$function\$/g, '')));
  ok('has nothing secret-looking (JWT, long hex/base64, bcrypt hash, key prefix, phone, e-mail)',
    !/eyJ[\w-]{10,}\.|\b[0-9a-f]{32,}\b|[A-Za-z0-9+/]{40,}={0,2}|\$2[aby]\$\d\d\$|\b(sbp_|sk_live|sk_test)|(\+263|\b0)7\d[\s-]?\d{3}[\s-]?\d{4}\b|[\w.%+-]+@[\w.-]+\.[a-z]{2,}/i.test(base));

  console.log('rebuild an empty database: baseline + every migration');
  for (const f of FILES) {
    try { await pg.exec(READ(path.join(MIG, f))); ok('applies: ' + f, true); }
    catch (e) { ok('applies: ' + f, false, e.message); }
  }

  console.log('baseline refuses a database that already has the schema');
  const full = fingerprint(await snapshot(q));
  let refused = null;
  try { await pg.exec(base); } catch (e) { refused = e.message; }
  await pg.exec('rollback').catch(() => {});
  ok('a second run raises "baseline aborted"', /baseline aborted/.test(refused || ''), refused);
  ok('... and changes nothing', JSON.stringify(fingerprint(await snapshot(q))) === JSON.stringify(full));

  console.log('the live shape (leaving out ' + NOT_ON_LIVE_FILES.join(', ') + ')');
  const pgLive = await newPglite();
  await buildFromRepo(pgLive, { skip: NOT_ON_LIVE_FILES });
  const rebuilt = fingerprint(await snapshot(async (sql) => (await pgLive.query(sql)).rows));
  const extras = diff(full, rebuilt);
  ok(NOT_ON_LIVE_FILES.length ? `the files not on live add ${extras.onlyA.length} objects (and drop ${extras.onlyB.length})` : 'every migration file is on live: the two builds are the same',
    NOT_ON_LIVE_FILES.length ? extras.onlyA.length > 0 : (extras.onlyA.length === 0 && extras.onlyB.length === 0), show(extras));

  const targets = [['committed live fingerprint', JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).objects]];
  if (process.argv[2] === 'live') {
    const snap = await liveSnapshot();
    const live = fingerprint(snap);
    targets.push(['live database, read now', live]);
    if (process.argv.includes('--write-fixture')) {
      fs.writeFileSync(FIXTURE, JSON.stringify({ taken_at: new Date().toISOString().replace(/[:.]/g, '-'),
        source: 'live, read-only (tools/db/catalog.js)', server: snap.server, objects: live }, null, 1) + '\n');
      console.log('  (fixture rewritten from live)');
    }
  }
  for (const [label, live] of targets) {
    const d = diff(rebuilt, live);
    ok(`${label}: ${Object.keys(live).length} objects, nothing on live is missing from the live-shape rebuild`, d.onlyB.length === 0, show(d.onlyB));
    ok(`${label}: the live-shape rebuild has nothing extra`, d.onlyA.length === 0, show(d.onlyA));
    const changed = d.changed.filter((c) => !onlyKnownDrift(c));
    ok(`${label}: every shared object is identical (except the ${d.changed.length - changed.length} known grant drifts of 20260925150000)`, changed.length === 0, show(changed));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
