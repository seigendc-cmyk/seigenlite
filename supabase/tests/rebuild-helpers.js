// Shared by the PGlite tests that start from "the live database, rebuilt
// from the repo": Supabase's own objects stubbed, then the baseline and
// every migration file in order.
//
//   const { SUPABASE_STUB, migrationFiles, NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require('./rebuild-helpers');
//   const pg = await newPglite();
//   await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES });   // the live shape
'use strict';
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'migrations');
const READ = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');   // the live applies normalised line endings the same way
const migrationFiles = () => fs.readdirSync(MIG).filter((f) => /^\d{14}_\w+\.sql$/.test(f)).sort();

// Files in the repo that are NOT applied on live (and so not recorded in
// supabase_migrations.schema_migrations there).
const NOT_ON_LIVE_FILES = [
];

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

async function newPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');
  const pg = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await pg.exec(SUPABASE_STUB);
  return pg;
}

// Applies the migration files in order; opts.skip: file names to leave out,
// opts.only: stop after this file. Returns the files applied.
async function buildFromRepo(pg, opts = {}) {
  const skip = new Set(opts.skip || []);
  const applied = [];
  for (const f of migrationFiles()) {
    if (skip.has(f)) continue;
    await pg.exec(READ(path.join(MIG, f)));
    applied.push(f);
    if (opts.only && f === opts.only) break;
  }
  return applied;
}

// App v21 sends the new device's Admin check value with a join code request,
// and its build with a join (20261023120000_admin_passcode_from_main). A suite
// that pins an OLDER server chain (one that never had those arguments) drops
// them before the call; the v21 rules themselves are tested against the real
// migration (test/admin-passcode-from-main.test.js and its database test).
const V21_JOIN_ARGS = ['p_admin_salt', 'p_admin_check', 'p_admin_rounds', 'p_app_build'];
function preV21Args(fn, body) {
  if (fn !== 'cl_branch_issue_join_code' && fn !== 'cl_terminal_join') return body;
  const out = Object.assign({}, body);
  V21_JOIN_ARGS.forEach((k) => { delete out[k]; });
  return out;
}

// The Admin check value a v21 server hands a joining device (PBKDF2-HMAC-SHA-256,
// as src/passcode-check.js). A suite pinned to an older server adds it to the
// join answer itself, standing in for the main till that set it.
function v21AdminSeed(passcode) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, check: crypto.pbkdf2Sync(String(passcode).trim(), Buffer.from(salt, 'hex'), 150000, 32, 'sha256').toString('hex'), rounds: 150000 };
}
function withV21JoinSeed(fn, answer, passcode) {
  if (fn !== 'cl_terminal_join' || !answer || answer.error || answer.admin_seed) return answer;
  return Object.assign({}, answer, { admin_seed: v21AdminSeed(passcode) });
}

module.exports = { SUPABASE_STUB, migrationFiles, NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ, MIG, preV21Args, v21AdminSeed, withV21JoinSeed };
