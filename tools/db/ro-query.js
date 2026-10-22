// node tools/db/ro-query.js "<one SQL statement>" [params as JSON]
//
// READ-ONLY: runs one statement against live inside BEGIN READ ONLY ...
// ROLLBACK and prints the rows as JSON. For inventories and post-checks
// (counts and ids, never secrets). SUPABASE_DB_URL is read from .env and
// never printed.
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
const [sql, params] = process.argv.slice(2);
if (!sql) { console.error('usage: see the top of this file'); process.exit(2); }

(async () => {
  const c = new Client({ connectionString: URL, ssl: { ca: fs.readFileSync(path.join(ROOT, 'supabase', 'prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
    connectionTimeoutMillis: 20000, statement_timeout: 120000, query_timeout: 180000 });
  c.on('error', (e) => { console.error('ERROR: ' + redact(e.message)); process.exit(1); });
  await c.connect();
  try {
    await c.query('begin isolation level repeatable read read only');
    if ((await c.query(`select current_setting('transaction_read_only') v`)).rows[0].v !== 'on') throw new Error('not read-only; stopping');
    const r = await c.query(sql, params ? JSON.parse(params) : []);
    console.log(JSON.stringify(r.rows, null, 1));
  } finally {
    await c.query('rollback').catch(() => {});
    await c.end();
  }
})().catch((e) => { console.error('ERROR: ' + redact(e && e.message || e)); process.exit(1); });
