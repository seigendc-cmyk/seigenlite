// The Console's live shape that the RPN migrations of 2026-10-09 depend on,
// for PGlite tests only (never the live database).
//
// Copied from supabase/tests/onboarding-notes-test.js (a read-only look at
// the live project on 2026-10-03) plus, from the baseline migration
// (20260923000000_baseline.sql): the cl_rpn update policies
// (cl_rpn_update_self, cl_rpn_write_staff) and cl_ledger_entries with its
// entry_type check. Then the already-approved onboarding notes migration is
// applied, as it is on the live project.
//
// Used by: rpn-self-update-guard-test.js, onboarding-records-test.js
//   npm install --no-save @electric-sql/pglite
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NOTES_MIGRATION = fs.readFileSync(`${ROOT}/migrations/20261003120000_rpn_onboarding_notes.sql`, 'utf8');

const STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;

create function public.cl_jwt_sub() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub','')::uuid $$;
create function public.cl_jwt_user_type() returns text language sql stable as $$ select auth.jwt() ->> 'user_type' $$;
create function public.cl_jwt_is_sysadmin() returns boolean language sql stable as $$ select coalesce((auth.jwt() ->> 'is_sysadmin')::boolean, false) $$;

create table public.cl_staff (id uuid primary key default gen_random_uuid(), full_name text not null, passcode_hash text not null default 'x', is_sysadmin boolean not null default false, active boolean not null default true, created_at timestamptz not null default now());
create table public.cl_modules (id uuid primary key default gen_random_uuid(), key text not null unique, label text not null, sort_order integer not null default 0);
create table public.cl_staff_module_access (staff_id uuid not null references public.cl_staff(id) on delete cascade, module_id uuid not null references public.cl_modules(id) on delete cascade, granted_at timestamptz not null default now(), primary key (staff_id, module_id));
create function public.cl_has_module_access(p_module_key text) returns boolean language sql stable as $$
  select cl_jwt_is_sysadmin() or exists (select 1 from cl_staff_module_access sma join cl_modules m on m.id = sma.module_id where sma.staff_id = cl_jwt_sub() and m.key = p_module_key)
$$;
create table public.cl_rpn (id uuid primary key default gen_random_uuid(), full_name text not null, phone text, city text, passcode_hash text not null default 'x', verification_code text not null default 'x', verification_used boolean not null default false, active boolean not null default true, created_at timestamptz not null default now(), created_by uuid);
create table public.cl_vendors (
  id uuid primary key default gen_random_uuid(), business_name text not null, owner_name text, phone text, city text,
  rpn_id uuid references public.cl_rpn(id), device_code text, shop_secret_phrase text, cycle_start_date date,
  status text not null default 'onboarding' check (status = any (array['onboarding','active','overdue','suspended','cancelled'])),
  onboarded_at timestamptz default now(), notes text, created_by uuid references public.cl_staff(id), created_at timestamptz not null default now(),
  install_id text unique, location text, app_registered_at timestamptz, last_checkin_at timestamptz,
  lock_cart boolean not null default false, lock_add_product boolean not null default false, lock_reason text);
create table public.cl_activity_log (id uuid primary key default gen_random_uuid(), staff_id uuid references public.cl_staff(id), action text not null, target_table text, target_id uuid, detail jsonb, created_at timestamptz not null default now());
create table public.cl_ledger_entries (
  id uuid primary key default gen_random_uuid(), vendor_id uuid not null references public.cl_vendors(id),
  entry_type text not null check (entry_type = any (array['charge','payment'])),
  amount numeric(14,2) not null, currency text not null default 'USD', method text, reference text, notes text,
  activation_code_id uuid, recorded_by uuid, created_at timestamptz not null default now());

grant all on public.cl_staff, public.cl_modules, public.cl_staff_module_access, public.cl_rpn, public.cl_vendors, public.cl_activity_log, public.cl_ledger_entries to anon, authenticated;
alter table public.cl_vendors enable row level security;
alter table public.cl_rpn enable row level security;
alter table public.cl_activity_log enable row level security;
alter table public.cl_staff enable row level security;
alter table public.cl_modules enable row level security;
alter table public.cl_staff_module_access enable row level security;
alter table public.cl_ledger_entries enable row level security;
create policy cl_vendors_select on public.cl_vendors for select using (((cl_jwt_user_type() = 'rpn') and (rpn_id = cl_jwt_sub())) or ((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors'))));
create policy cl_vendors_write_staff on public.cl_vendors for all using ((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors'))) with check ((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors')));
create policy cl_rpn_select on public.cl_rpn for select using (((cl_jwt_user_type() = 'rpn') and (id = cl_jwt_sub())) or ((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('rpn_directory'))));
create policy cl_rpn_update_self on public.cl_rpn for update using (((cl_jwt_user_type() = 'rpn') and (id = cl_jwt_sub()))) with check (((cl_jwt_user_type() = 'rpn') and (id = cl_jwt_sub())));
create policy cl_rpn_write_staff on public.cl_rpn for all using (((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('rpn_directory')))) with check (((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('rpn_directory'))));
create policy cl_activity_log_insert on public.cl_activity_log for insert with check ((cl_jwt_user_type() = 'staff') and (staff_id = cl_jwt_sub()));
create policy cl_activity_log_select on public.cl_activity_log for select using ((cl_jwt_user_type() = 'staff') and cl_jwt_is_sysadmin());
create policy cl_staff_select_self on public.cl_staff for select using ((cl_jwt_user_type() = 'staff') and ((id = cl_jwt_sub()) or cl_jwt_is_sysadmin()));
create policy cl_modules_select on public.cl_modules for select using (cl_jwt_user_type() = any (array['staff','rpn']));
create policy cl_sma_select_self on public.cl_staff_module_access for select using ((cl_jwt_user_type() = 'staff') and ((staff_id = cl_jwt_sub()) or cl_jwt_is_sysadmin()));
create policy cl_ledger_select_staff on public.cl_ledger_entries for select using ((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors')));

-- Stand-in for the live cl_rpn_activate (SECURITY DEFINER, called before an
-- RPN has a token): it must keep working after the guard.
create function public.cl_rpn_activate(p_name text, p_verification_code text, p_new_passcode text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update cl_rpn set passcode_hash = 'hash:' || p_new_passcode, verification_used = true
   where full_name = p_name and verification_code = p_verification_code and not verification_used;
  return found;
end $$;
grant execute on function public.cl_rpn_activate(text, text, text) to anon, authenticated;
`;

const RPN_A = '11111111-1111-4111-8111-111111111111';
const RPN_B = '22222222-2222-4222-8222-222222222222';
const STAFF_VENDORS = '33333333-3333-4333-8333-333333333333';
const STAFF_OTHER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const STAFF_RPNDIR = '66666666-6666-4666-8666-666666666666';
const SEED = `
insert into public.cl_rpn (id, full_name, verification_code) values ('${RPN_A}', 'Tendai Moyo', 'V-A'), ('${RPN_B}', 'Rudo Banda', 'V-B');
insert into public.cl_staff (id, full_name, is_sysadmin) values ('${STAFF_VENDORS}', 'Vendors Clerk', false), ('${STAFF_OTHER}', 'Cashbook Clerk', false), ('${ADMIN}', 'Admin', true), ('${STAFF_RPNDIR}', 'RPN Desk', false);
insert into public.cl_modules (key, label) values ('vendors', 'Vendors Register'), ('cashbook', 'Cashbook'), ('rpn_directory', 'RPN Directory');
insert into public.cl_staff_module_access (staff_id, module_id) select '${STAFF_VENDORS}', id from public.cl_modules where key = 'vendors';
insert into public.cl_staff_module_access (staff_id, module_id) select '${STAFF_OTHER}', id from public.cl_modules where key = 'cashbook';
insert into public.cl_staff_module_access (staff_id, module_id) select '${STAFF_RPNDIR}', id from public.cl_modules where key = 'rpn_directory';
`;

const CLAIMS = {
  anon: null,
  rpnA: { role: 'authenticated', sub: RPN_A, user_type: 'rpn', full_name: 'Tendai Moyo' },
  rpnB: { role: 'authenticated', sub: RPN_B, user_type: 'rpn', full_name: 'Rudo Banda' },
  vendorsClerk: { role: 'authenticated', sub: STAFF_VENDORS, user_type: 'staff', is_sysadmin: false },
  otherClerk: { role: 'authenticated', sub: STAFF_OTHER, user_type: 'staff', is_sysadmin: false },
  rpnDesk: { role: 'authenticated', sub: STAFF_RPNDIR, user_type: 'staff', is_sysadmin: false },
  admin: { role: 'authenticated', sub: ADMIN, user_type: 'staff', is_sysadmin: true },
};

// -> { pg, q, as(who, fn, keep) }: a fresh PGlite shaped like the live
// Console, with the onboarding notes migration applied.
async function freshConsole() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  await pg.exec(STUB);
  await pg.exec(SEED);
  await pg.exec(NOTES_MIGRATION);
  let sp = 0;
  // Run fn as a caller (role + JWT claims) inside a transaction that is
  // rolled back unless keep is true. -> {r} or {e}
  async function as(who, fn, keep) {
    const name = 'sp' + (++sp);
    await q('begin');
    await q(`savepoint ${name}`);
    try {
      const c = CLAIMS[who];
      await q(`set local role ${c ? 'authenticated' : 'anon'}`);
      await q(`select set_config('request.jwt.claims', $1, true)`, [c ? JSON.stringify(c) : '']);
      const r = await fn();
      await q('reset role');
      await q(keep ? 'commit' : 'rollback');
      return { r };
    } catch (e) {
      await q('rollback');
      return { e };
    }
  }
  return { pg, q, as };
}

function counter() {
  const c = { pass: 0, fail: 0 };
  c.ok = (name, cond, extra) => {
    if (cond) { c.pass++; console.log('  ok   ' + name); }
    else { c.fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
  };
  c.done = () => { console.log(`${c.pass} passed, ${c.fail} failed`); process.exit(c.fail ? 1 : 0); };
  return c;
}

module.exports = { freshConsole, counter, CLAIMS, RPN_A, RPN_B, STAFF_VENDORS, STAFF_OTHER, ADMIN, STAFF_RPNDIR, ROOT };
