// node supabase/tests/baseline-rebuild-test.js          (PGlite + the committed live fingerprint)
// node supabase/tests/baseline-rebuild-test.js live     (also re-reads live, read-only)
//
// Proves supabase/migrations/20260923000000_baseline.sql: an EMPTY database
// (PGlite, with Supabase's roles, schemas and default privileges stubbed)
// built from the baseline followed by every later migration file has the
// same catalogue as the live project: tables, columns, constraints, indexes,
// functions (hash of the body), triggers, policies, RLS, comments and grants.
// The only expected difference is 20260926160000_vendor_tokens_rpn_and_payment,
// which is in the repo but deliberately not applied on live.
//
// Live fingerprint: supabase/tests/fixtures/live-catalog-fingerprint.json,
// made by tools/db/catalog.js from a read-only snapshot (schema only, no rows).
// "live" mode reads live again (BEGIN READ ONLY ... ROLLBACK; SUPABASE_DB_URL
// from .env, never printed) and compares against that too.
'use strict';
const fs = require('fs');
const path = require('path');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'migrations');
const READ = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');   // the live applies normalised line endings the same way
const FILES = fs.readdirSync(MIG).filter((f) => /^\d{14}_\w+\.sql$/.test(f)).sort();
const BASELINE = '20260923000000_baseline.sql';
const FIXTURE = path.join(__dirname, 'fixtures', 'live-catalog-fingerprint.json');
const NOT_ON_LIVE = new Set([   // 20260926160000_vendor_tokens_rpn_and_payment (parked; not applied on live)
  'col vendor_tokens.rpn_id', 'con vendor_tokens.vendor_tokens_rpn_id_fkey', 'idx vendor_tokens_rpn_id_idx',
  'fn vendor_tokens_require_payment()', 'grant fn vendor_tokens_require_payment()',
  'trg public.vendor_tokens.vendor_tokens_require_payment']);

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

// Supabase's own objects that the schema depends on (never part of a migration).
const SUPABASE_STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create schema auth; grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create schema extensions; grant usage on schema extensions to anon, authenticated, service_role;
create schema vault;
create view vault.decrypted_secrets as select null::uuid id, null::text name, null::text decrypted_secret, null::timestamptz created_at where false;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n         ' + extra : '')); }
}
const show = (d) => JSON.stringify(d, null, 1).slice(0, 4000);

async function liveFingerprint() {
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
    return fingerprint(snap);
  } catch (e) { throw new Error(String(e.message).split(url).join('[SUPABASE_DB_URL]')); }
  finally { await c.end().catch(() => {}); }
}

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');
  const pg = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  const q = async (sql) => (await pg.query(sql)).rows;
  await pg.exec(SUPABASE_STUB);

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
  const before = JSON.stringify(fingerprint(await snapshot(q)));
  let refused = null;
  try { await pg.exec(base); } catch (e) { refused = e.message; }
  await pg.exec('rollback').catch(() => {});
  ok('a second run raises "baseline aborted"', /baseline aborted/.test(refused || ''), refused);
  ok('... and changes nothing', JSON.stringify(fingerprint(await snapshot(q))) === before);

  console.log('rebuilt catalogue vs live');
  const rebuilt = fingerprint(await snapshot(q));
  const targets = [['committed live fingerprint', JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).objects]];
  if (process.argv[2] === 'live') targets.push(['live database, read now', await liveFingerprint()]);
  for (const [label, live] of targets) {
    const d = diff(rebuilt, live);
    const unexpectedOnlyRebuilt = d.onlyA.filter((k) => !NOT_ON_LIVE.has(k));
    ok(`${label}: ${Object.keys(live).length} objects, nothing on live is missing from the rebuild`, d.onlyB.length === 0, show(d.onlyB));
    ok(`${label}: the rebuild has nothing extra except 20260926160000's objects`, unexpectedOnlyRebuilt.length === 0, show(unexpectedOnlyRebuilt));
    ok(`${label}: all 6 objects of 20260926160000 are the extra ones`, [...NOT_ON_LIVE].every((k) => d.onlyA.includes(k)), show(d.onlyA));
    const changed = d.changed.filter((c) => !onlyKnownDrift(c));
    ok(`${label}: every shared object is identical (except the ${d.changed.length - changed.length} known grant drifts of 20260925150000)`, changed.length === 0, show(changed));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
