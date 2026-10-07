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
  '20260926160000_vendor_tokens_rpn_and_payment.sql',   // parked for the Console billing work
  '20261010120000_activation_licences.sql',             // activation v2: until the owner says "apply"
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

module.exports = { SUPABASE_STUB, migrationFiles, NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ, MIG };
