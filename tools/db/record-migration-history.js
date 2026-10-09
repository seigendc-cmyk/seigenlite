// node tools/db/record-migration-history.js            print the SQL, change nothing
// node tools/db/record-migration-history.js check      read-only: what is recorded, what `supabase db push` would run
// node tools/db/record-migration-history.js dry        read-only: snapshot the whole catalogue twice and compare
// node tools/db/record-migration-history.js apply      run the SQL (one transaction), then verify
//
// Records on live which migration files are already applied, in the table
// the Supabase CLI reads (supabase_migrations.schema_migrations), so that
// `supabase db push` only runs files that are really missing.
//
// RECORDED is the explicit list of applied versions. 20260926160000 was
// never applied; it was retired to supabase/parked/ on 2026-10-09 (replaced
// by ledger-based RPN commissions, 20261015120000). Never run `db push`:
// migrations are applied one at a time with tools/db/apply-migration.js.
//
// "apply" takes a catalogue snapshot of the whole database (every schema)
// before and after, and fails loudly if anything other than the new schema,
// table and its index changed. SUPABASE_DB_URL is read from .env and never printed.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const RECORDED = ['20260923000000', '20260924120000', '20260925120000', '20260925150000', '20260926120000',
  '20261003120000', '20261004120000', '20261004180000', '20261006120000', '20261007120000',
  '20261008120000', '20261008140000', '20261009120000'];
const NOT_APPLIED = ['20260926160000'];
// Applied later, one at a time, with tools/db/apply-migration.js (which records each itself).
const APPLIED_LATER = ['20261010120000', '20261011120000', '20261012120000', '20261013120000', '20261014120000', '20261015120000'];

const files = fs.readdirSync(MIG).filter((f) => /^\d{14}_\w+\.sql$/.test(f)).sort();
const nameOf = Object.fromEntries(files.map((f) => [f.slice(0, 14), f.slice(15, -4)]));
for (const v of RECORDED) if (!nameOf[v]) throw new Error('no migration file for ' + v);
for (const v of Object.keys(nameOf)) if (!RECORDED.includes(v) && !NOT_APPLIED.includes(v) && !APPLIED_LATER.includes(v)) throw new Error('unclassified migration file ' + v);

const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const SQL = `begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
insert into supabase_migrations.schema_migrations (version, name) values
${RECORDED.map((v) => `  (${lit(v)}, ${lit(nameOf[v])})`).join(',\n')}
on conflict (version) do nothing;
commit;
`;

// Every object in every schema, for "nothing else changed".
const WHOLE_DB = `select json_build_object(
  'namespaces', (select json_agg(json_build_object('n', nspname, 'acl', nspacl::text) order by nspname) from pg_namespace),
  'relations', (select json_agg(json_build_object('n', n.nspname || '.' || c.relname, 'k', c.relkind, 'acl', c.relacl::text,
      'rls', c.relrowsecurity, 'cols', (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, ',' order by a.attnum)
        from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)) order by n.nspname, c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast%'),   -- a new table's TOAST table is expected
  'functions', (select json_agg(json_build_object('n', p.oid::regprocedure::text, 'md5', md5(coalesce(p.prosrc, '')), 'acl', p.proacl::text,
      'sd', p.prosecdef, 'cfg', p.proconfig::text) order by p.oid::regprocedure::text) from pg_proc p),
  'constraints', (select json_agg(c.conrelid::regclass::text || '.' || c.conname || ':' || md5(pg_get_constraintdef(c.oid)) order by 1) from pg_constraint c where c.conrelid <> 0),
  'triggers', (select json_agg(t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text order by 1) from pg_trigger t),
  'policies', (select json_agg(schemaname || '.' || tablename || '.' || policyname || ':' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '') || '|' || roles::text) order by 1) from pg_policies),
  'extensions', (select json_agg(extname || ' ' || extversion order by 1) from pg_extension),
  'publications', (select json_agg(pubname || ':' || schemaname || '.' || tablename order by 1) from pg_publication_tables),
  'default_acl', (select json_agg(defaclrole::regrole::text || ':' || defaclnamespace::text || ':' || defaclobjtype::text || ':' || defaclacl::text order by 1) from pg_default_acl)
) j`;

let URL = null;
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*SUPABASE_DB_URL\s*=\s*(.*)\s*$/.exec(line);
  if (m) URL = m[1].replace(/^["']|["']$/g, '');
}
const redact = (s) => String(s).split(URL || '\u0000').join('[SUPABASE_DB_URL]').replace(/postgres(ql)?:\/\/\S+/g, '[db url]');

async function connect() {
  if (!URL) throw new Error('SUPABASE_DB_URL missing in .env');
  const c = new Client({ connectionString: URL, ssl: { ca: fs.readFileSync(path.join(ROOT, 'supabase', 'prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
    connectionTimeoutMillis: 20000, statement_timeout: 60000, query_timeout: 90000 });
  c.on('error', (e) => { console.error('ERROR: ' + redact(e.message)); process.exit(1); });
  await c.connect();
  return c;
}

async function readOnly(c, fn) {
  await c.query('begin read only');
  try {
    if ((await c.query(`select current_setting('transaction_read_only') v`)).rows[0].v !== 'on') throw new Error('not read-only; stopping');
    return await fn((sql) => c.query(sql).then((r) => r.rows));
  } finally { await c.query('rollback'); }
}

async function state(q) {
  const exists = (await q(`select to_regclass('supabase_migrations.schema_migrations') is not null e`))[0].e;
  const rows = exists ? await q(`select version, name, statements is null as no_statements from supabase_migrations.schema_migrations order by version`) : [];
  return { exists, rows };
}

function pushPlan(st) {
  const have = new Set(st.rows.map((r) => r.version));
  return { wouldRun: files.filter((f) => !have.has(f.slice(0, 14))), recordedWithoutFile: [...have].filter((v) => !nameOf[v]) };
}

function flatten(j) {   // whole-db snapshot -> Map(key -> value)
  const m = new Map();
  for (const [k, list] of Object.entries(j)) for (const x of list || []) {
    if (typeof x === 'string') m.set(k + ' ' + x, x);
    else m.set(k + ' ' + x.n, JSON.stringify(x));
  }
  return m;
}

function compare(a, b) {
  const A = flatten(a), B = flatten(b), out = { added: [], removed: [], changed: [] };
  for (const [k, v] of B) if (!A.has(k)) out.added.push(k); else if (A.get(k) !== v) out.changed.push(k);
  for (const k of A.keys()) if (!B.has(k)) out.removed.push(k);
  return out;
}

(async () => {
  const mode = process.argv[2] || 'show';
  if (mode === 'show') { process.stdout.write(SQL); return; }
  const c = await connect();
  try {
    if (mode === 'check') {
      const st = await readOnly(c, state);
      console.log(JSON.stringify({ table_exists: st.exists, recorded: st.rows, db_push_would_run: pushPlan(st) }, null, 1));
      return;
    }
    if (mode === 'dry') {   // read-only: snapshot twice and compare (proves the "nothing else changed" check)
      const a = await readOnly(c, async (q) => (await q(WHOLE_DB))[0].j);
      const b = await readOnly(c, async (q) => (await q(WHOLE_DB))[0].j);
      console.log(JSON.stringify({ objects_compared: flatten(a).size, diff: compare(a, b) }, null, 1));
      return;
    }
    if (mode !== 'apply') throw new Error('unknown mode ' + mode);

    const before = await readOnly(c, async (q) => (await q(WHOLE_DB))[0].j);
    await c.query(SQL);   // begin ... commit
    const [after, st] = await readOnly(c, async (q) => [(await q(WHOLE_DB))[0].j, await state(q)]);

    const d = compare(before, after);
    const EXPECTED_ADDED = new Set(['namespaces supabase_migrations', 'relations supabase_migrations.schema_migrations',
      'relations supabase_migrations.schema_migrations_pkey']);
    const EXPECTED_CON = /^constraints supabase_migrations\.schema_migrations\.schema_migrations_pkey:/;
    const unexpected = {
      added: d.added.filter((k) => !EXPECTED_ADDED.has(k) && !EXPECTED_CON.test(k)),
      removed: d.removed, changed: d.changed,
    };
    const versions = st.rows.map((r) => r.version);
    const plan = pushPlan(st);
    const checks = {
      'table holds exactly the 13 expected rows': JSON.stringify(versions) === JSON.stringify([...RECORDED].sort()),
      'no row for 20260926160000': !versions.includes('20260926160000'),
      'every expected new object is there': [...EXPECTED_ADDED].every((k) => d.added.includes(k)),
      'nothing else in the database changed': !unexpected.added.length && !unexpected.removed.length && !unexpected.changed.length,
      'db push would run only 20260926160000': JSON.stringify(plan.wouldRun) === JSON.stringify(['20260926160000_vendor_tokens_rpn_and_payment.sql']),
    };
    console.log(JSON.stringify({ added: d.added, unexpected, recorded: st.rows, db_push_would_run: plan, checks,
      objects_compared: flatten(before).size }, null, 1));
    process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
  } finally { await c.end().catch(() => {}); }
})().catch((e) => { console.error('ERROR: ' + redact(e.message)); process.exit(1); });
