// node tools/db/apply-migration.js show <file.sql>             print exactly what would run, change nothing
// node tools/db/apply-migration.js check <file.sql>            read-only: is it recorded? do its objects exist?
// node tools/db/apply-migration.js apply <file.sql>            run it AND record it, in ONE transaction
// node tools/db/apply-migration.js apply <file.sql> --rollback run supabase/rollbacks/<same>.rollback.sql and
//                                                               delete the record, in ONE transaction
//
// For one migration file at a time, after the owner has seen it and said
// "apply". The file's own begin/commit are replaced by this script's one
// transaction, which also inserts (or, for --rollback, deletes) its row in
// supabase_migrations.schema_migrations, so `supabase db push` (never used
// here) would not run it again. Before and after, a read-only catalogue
// snapshot of the whole database (record-migration-history.js's WHOLE_DB)
// is compared: the report lists what was added, and anything removed or
// changed. SUPABASE_DB_URL is read from .env and never printed.
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const [mode, fileArg] = process.argv.slice(2);
const ROLLBACK = process.argv.includes('--rollback');
if (!['show', 'check', 'apply'].includes(mode) || !fileArg) { console.error('usage: see the top of this file'); process.exit(2); }
const file = path.resolve(fileArg);
const base = path.basename(file);
const m = /^(\d{14})_(\w+)\.sql$/.exec(base);
if (!m || path.dirname(file) !== path.join(ROOT, 'supabase', 'migrations')) { console.error('give a file in supabase/migrations/'); process.exit(2); }
const [, VERSION, NAME] = m;
if (VERSION === '20260926160000') { console.error('20260926160000 stays unapplied.'); process.exit(2); }
const READ = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const sqlFile = ROLLBACK ? path.join(ROOT, 'supabase', 'rollbacks', VERSION + '_' + NAME + '.rollback.sql') : file;

// The file's own outer begin; ... commit; is replaced by ours.
function body(sql) {
  const b = /^begin;[ \t]*$/m.exec(sql), all = [...sql.matchAll(/^commit;[ \t]*$/gm)];
  if (!b || !all.length) throw new Error(path.basename(sqlFile) + ': expected an outer "begin;" and "commit;" on their own lines');
  const c = all[all.length - 1];
  return sql.slice(0, b.index) + sql.slice(b.index + b[0].length, c.index) + sql.slice(c.index + c[0].length);
}
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const RECORD = ROLLBACK
  ? `delete from supabase_migrations.schema_migrations where version = ${lit(VERSION)};`
  : `insert into supabase_migrations.schema_migrations (version, name) values (${lit(VERSION)}, ${lit(NAME)});`;
const TX = 'begin;\n' + body(READ(sqlFile)) + '\n-- record it (supabase_migrations.schema_migrations)\n' + RECORD + '\ncommit;\n';

// Same whole-database snapshot as tools/db/record-migration-history.js.
const WHOLE_DB = fs.readFileSync(path.join(__dirname, 'record-migration-history.js'), 'utf8').match(/const WHOLE_DB = `([\s\S]*?)`;/)[1];

let URL = null;
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const x = /^\s*SUPABASE_DB_URL\s*=\s*(.*)\s*$/.exec(line);
  if (x) URL = x[1].replace(/^["']|["']$/g, '');
}
const redact = (s) => String(s).split(URL || '\u0000').join('[SUPABASE_DB_URL]').replace(/postgres(ql)?:\/\/\S+/g, '[db url]');

async function connect() {
  if (!URL) throw new Error('SUPABASE_DB_URL missing in .env');
  const c = new Client({ connectionString: URL, ssl: { ca: fs.readFileSync(path.join(ROOT, 'supabase', 'prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
    connectionTimeoutMillis: 20000, statement_timeout: 120000, query_timeout: 150000 });
  c.on('error', (e) => { console.error('ERROR: ' + redact(e.message)); process.exit(1); });
  await c.connect();
  return c;
}
async function readOnly(c, fn) {
  await c.query('begin read only');
  try {
    if ((await c.query(`select current_setting('transaction_read_only') v`)).rows[0].v !== 'on') throw new Error('not read-only; stopping');
    return await fn((sql, p) => c.query(sql, p).then((r) => r.rows));
  } finally { await c.query('rollback'); }
}
function flatten(j) {
  const out = new Map();
  for (const [k, list] of Object.entries(j)) for (const x of list || []) {
    if (typeof x === 'string') out.set(k + ' ' + x, x); else out.set(k + ' ' + x.n, JSON.stringify(x));
  }
  return out;
}
function compare(a, b) {
  const A = flatten(a), B = flatten(b), out = { added: [], removed: [], changed: [] };
  for (const [k, v] of B) if (!A.has(k)) out.added.push(k); else if (A.get(k) !== v) out.changed.push(k);
  for (const k of A.keys()) if (!B.has(k)) out.removed.push(k);
  return out;
}
const recorded = (q) => q(`select version, name from supabase_migrations.schema_migrations where version = $1`, [VERSION]);

(async () => {
  if (mode === 'show') { process.stdout.write(TX); return; }
  const c = await connect();
  try {
    if (mode === 'check') {
      const r = await readOnly(c, async (q) => ({ recorded: await recorded(q),
        all_versions: (await q(`select version from supabase_migrations.schema_migrations order by version`)).map((x) => x.version) }));
      console.log(JSON.stringify(r, null, 1));
      return;
    }
    const before = await readOnly(c, async (q) => ({ snap: (await q(WHOLE_DB))[0].j, rec: await recorded(q) }));
    if (!ROLLBACK && before.rec.length) throw new Error(VERSION + ' is already recorded; nothing done');
    if (ROLLBACK && !before.rec.length) throw new Error(VERSION + ' is not recorded; nothing done');
    try { await c.query(TX); }
    catch (e) { await c.query('rollback').catch(() => {}); throw new Error('the transaction failed and was rolled back, nothing changed: ' + e.message); }
    const after = await readOnly(c, async (q) => ({ snap: (await q(WHOLE_DB))[0].j, rec: await recorded(q) }));
    const d = compare(before.snap, after.snap);
    console.log(JSON.stringify({ file: path.relative(ROOT, sqlFile), recorded_after: after.rec, added: d.added, removed: d.removed, changed: d.changed,
      objects_before: flatten(before.snap).size, objects_after: flatten(after.snap).size }, null, 1));
  } finally { await c.end().catch(() => {}); }
})().catch((e) => { console.error('ERROR: ' + redact(e.message)); process.exitCode = 1; });
