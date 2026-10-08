// node tools/db/run-data-fix.js show  <supabase/data-fixes/file.sql>   print exactly what would run
// node tools/db/run-data-fix.js apply <supabase/data-fixes/file.sql>   run it on live (only after the owner's "apply")
//
// One-off DATA fixes (no schema change, so not a migration and not recorded
// in schema_migrations). The file is its own transaction (begin ... commit)
// and checks itself: it raises, and so changes nothing, if what it finds is
// not what the owner was shown. The database's notices (the before/after
// counts) are printed. SUPABASE_DB_URL is read from .env and never printed.
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const [mode, fileArg] = process.argv.slice(2);
if (!['show', 'apply'].includes(mode) || !fileArg) { console.error('usage: see the top of this file'); process.exit(2); }
const file = path.resolve(fileArg);
if (path.dirname(file) !== path.join(ROOT, 'supabase', 'data-fixes')) { console.error('give a file in supabase/data-fixes/'); process.exit(2); }
const sql = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
if (mode === 'show') { process.stdout.write(sql); process.exit(0); }

const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const m = /^SUPABASE_DB_URL=(.*)$/m.exec(env);
if (!m) { console.error('SUPABASE_DB_URL is missing in .env'); process.exit(2); }
const url = m[1].trim().replace(/^["']|["']$/g, '');

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  c.on('notice', (n) => console.log('NOTICE: ' + n.message));
  await c.connect();
  try {
    await c.query(sql);
    console.log('done: ' + path.basename(file) + ' committed');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    console.error('refused, nothing changed: ' + e.message);
    process.exitCode = 1;
  } finally { await c.end(); }
})();
