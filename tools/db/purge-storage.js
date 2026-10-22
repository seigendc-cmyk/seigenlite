// node tools/db/purge-storage.js check                 read-only: the files in each bucket (count and size)
// node tools/db/purge-storage.js backup <folder>       read-only: download every file into <folder>/<bucket>/<name>
// node tools/db/purge-storage.js apply                 delete every file in every bucket (the test-data purge,
//                                                      only after the owner's "apply"); the buckets stay
//
// Storage refuses deletes made in SQL (storage.protect_delete), so files go
// through the Storage API with the service role key. The list of names comes
// from storage.objects, read in a READ ONLY transaction. SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY and SUPABASE_DB_URL are read from .env and never
// printed. The backup folder holds shop photos: keep it out of git.
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const ENV = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const [mode, dirArg] = process.argv.slice(2);
if (!['check', 'backup', 'apply'].includes(mode) || (mode === 'backup' && !dirArg)) { console.error('usage: see the top of this file'); process.exit(2); }
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL']) if (!ENV[k]) { console.error(k + ' missing in .env'); process.exit(2); }
const SECRETS = [ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_DB_URL];
const redact = (s) => { let t = String(s); for (const x of SECRETS) t = t.split(x).join('[redacted]'); return t; };
const API = ENV.SUPABASE_URL.replace(/\/$/, '') + '/storage/v1';
const H = { Authorization: 'Bearer ' + ENV.SUPABASE_SERVICE_ROLE_KEY, apikey: ENV.SUPABASE_SERVICE_ROLE_KEY };

async function objects() {
  const c = new Client({ connectionString: ENV.SUPABASE_DB_URL, ssl: { ca: fs.readFileSync(path.join(ROOT, 'supabase', 'prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true } });
  await c.connect();
  try {
    await c.query('begin read only');
    return (await c.query(`select bucket_id, name, coalesce((metadata->>'size')::bigint, 0) size from storage.objects order by bucket_id, name`)).rows;
  } finally { await c.query('rollback').catch(() => {}); await c.end(); }
}
const summary = (rows) => { const s = {}; for (const r of rows) { s[r.bucket_id] = s[r.bucket_id] || { files: 0, bytes: 0 }; s[r.bucket_id].files++; s[r.bucket_id].bytes += Number(r.size); } return s; };

(async () => {
  const rows = await objects();
  console.log('files now: ' + JSON.stringify(summary(rows)));
  if (mode === 'check') return;
  if (mode === 'backup') {
    let n = 0;
    for (const r of rows) {
      const res = await fetch(API + '/object/' + encodeURIComponent(r.bucket_id) + '/' + r.name.split('/').map(encodeURIComponent).join('/'), { headers: H });
      if (!res.ok) throw new Error('download failed (' + res.status + '): ' + r.bucket_id + '/' + r.name);
      const out = path.join(path.resolve(dirArg), r.bucket_id, ...r.name.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(out, buf);
      if (buf.length !== Number(r.size) && Number(r.size)) throw new Error('size differs for ' + r.bucket_id + '/' + r.name);
      n++;
    }
    fs.writeFileSync(path.join(path.resolve(dirArg), 'storage-manifest.json'), JSON.stringify({ at: new Date().toISOString(), files: rows }, null, 1));
    console.log('backed up ' + n + ' of ' + rows.length + ' files');
    return;
  }
  // apply: per bucket, 100 names per call
  const byBucket = {};
  for (const r of rows) (byBucket[r.bucket_id] = byBucket[r.bucket_id] || []).push(r.name);
  for (const [b, names] of Object.entries(byBucket)) {
    for (let i = 0; i < names.length; i += 100) {
      const res = await fetch(API + '/object/' + encodeURIComponent(b), { method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ prefixes: names.slice(i, i + 100) }) });
      if (!res.ok) throw new Error('delete failed (' + res.status + ') in ' + b + ': ' + (await res.text()).slice(0, 200));
    }
  }
  const left = await objects();
  console.log('files after: ' + JSON.stringify(summary(left)) + (left.length ? '  NOT EMPTY' : '  (none)'));
  if (left.length) process.exitCode = 1;
})().catch((e) => { console.error('ERROR: ' + redact(e && e.message || e)); process.exit(1); });
