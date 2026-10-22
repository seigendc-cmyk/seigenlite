// node tools/db/purge-inventory.js [--json <file>]
//
// READ-ONLY inventory of the live database for the test-data purge (owner,
// 2026-10-22): every table in public (and auth.users, storage) with its row
// count, the foreign keys between them, and the Storage buckets with their
// object counts and sizes. One BEGIN READ ONLY transaction that ends in
// ROLLBACK. SUPABASE_DB_URL is read from .env and never printed. Counts and
// names of tables only: no row contents (the repo is public).
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
let URL = null;
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*SUPABASE_DB_URL\s*=\s*(.*)\s*$/.exec(line);
  if (m) URL = m[1].replace(/^["']|["']$/g, '');
}
if (!URL) { console.error('SUPABASE_DB_URL missing in .env'); process.exit(2); }
const redact = (s) => String(s).split(URL).join('[SUPABASE_DB_URL]').replace(/postgres(ql)?:\/\/\S+/g, '[db url]');

(async () => {
  const c = new Client({ connectionString: URL, ssl: { ca: fs.readFileSync(path.join(ROOT, 'supabase', 'prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
    connectionTimeoutMillis: 20000, statement_timeout: 120000, query_timeout: 180000 });
  c.on('error', (e) => { console.error('ERROR: ' + redact(e.message)); process.exit(1); });
  await c.connect();
  try {
    await c.query('begin isolation level repeatable read read only');
    const q = async (sql, p) => (await c.query(sql, p)).rows;
    if ((await q(`select current_setting('transaction_read_only') v`))[0].v !== 'on') throw new Error('not read-only; stopping');
    const tables = await q(`select table_schema s, table_name t from information_schema.tables
      where table_type = 'BASE TABLE' and (table_schema = 'public' or (table_schema, table_name) in (('auth','users'),('storage','objects'),('storage','buckets')))
      order by 1, 2`);
    const counts = {};
    for (const { s, t } of tables) counts[s + '.' + t] = Number((await q(`select count(*) n from "${s}"."${t}"`))[0].n);
    const fks = await q(`select con.conrelid::regclass::text child, con.confrelid::regclass::text parent, con.confdeltype del,
        (select string_agg(a.attname, ',') from unnest(con.conkey) k join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k) cols
      from pg_constraint con join pg_namespace n on n.oid = con.connamespace
      where con.contype = 'f' and n.nspname = 'public' order by 1, 2`);
    const buckets = await q(`select b.id, b.public, count(o.id)::int objects, coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint bytes
      from storage.buckets b left join storage.objects o on o.bucket_id = b.id group by b.id, b.public order by b.id`);
    const out = { at: new Date().toISOString(), counts, fks, buckets };
    const j = process.argv.indexOf('--json');
    if (j !== -1) fs.writeFileSync(process.argv[j + 1], JSON.stringify(out, null, 1));
    for (const [k, n] of Object.entries(counts)) if (n) console.log(String(n).padStart(7) + '  ' + k);
    console.log('-- empty: ' + Object.entries(counts).filter(([, n]) => !n).map(([k]) => k).join(', '));
    console.log('-- buckets: ' + JSON.stringify(buckets));
  } finally {
    await c.query('rollback').catch(() => {});
    await c.end();
  }
})().catch((e) => { console.error('ERROR: ' + redact(e && e.message || e)); process.exit(1); });
