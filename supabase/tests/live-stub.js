// The live project's shape that the multi-terminal migrations depend on,
// for PGlite tests (never the live database). Taken from a read-only look
// at the live project on 2026-10-04; see multi-terminal-identity-test.js.
// The live cl_device_checkin from before Phase 1 comes from the Phase 1
// rollback, which restores it verbatim.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RB = fs.readFileSync(`${ROOT}/rollbacks/20261004120000_multi_terminal_identity.rollback.sql`, 'utf8');
const OLD_CHECKIN = RB.slice(RB.indexOf('CREATE OR REPLACE FUNCTION public.cl_device_checkin'),
                             RB.indexOf('grant execute on function public.cl_device_checkin'));

const STAFF_VENDORS = '33333333-3333-4333-8333-333333333333';
const STAFF_OTHER = '44444444-4444-4444-8444-444444444444';

const LIVE_STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create schema auth; grant usage on schema auth to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create schema extensions; create extension pgcrypto schema extensions;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create function public.cl_jwt_sub() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub','')::uuid $$;
create function public.cl_jwt_user_type() returns text language sql stable as $$ select auth.jwt() ->> 'user_type' $$;
create function public.cl_jwt_is_sysadmin() returns boolean language sql stable as $$ select coalesce((auth.jwt() ->> 'is_sysadmin')::boolean, false) $$;
create table public.cl_staff (id uuid primary key default gen_random_uuid(), full_name text not null, is_sysadmin boolean not null default false, active boolean not null default true);
create table public.cl_modules (id uuid primary key default gen_random_uuid(), key text not null unique, label text not null);
create table public.cl_staff_module_access (staff_id uuid not null references public.cl_staff(id), module_id uuid not null references public.cl_modules(id), primary key (staff_id, module_id));
create function public.cl_has_module_access(p_module_key text) returns boolean language sql stable as $$
  select cl_jwt_is_sysadmin() or exists (select 1 from cl_staff_module_access sma join cl_modules m on m.id = sma.module_id where sma.staff_id = cl_jwt_sub() and m.key = p_module_key)
$$;
create table public.cl_vendors (
  id uuid primary key default gen_random_uuid(), business_name text not null, owner_name text, phone text, city text,
  rpn_id uuid, device_code text, shop_secret_phrase text, cycle_start_date date,
  status text not null default 'onboarding' check (status = any (array['onboarding','active','overdue','suspended','cancelled'])),
  onboarded_at timestamptz default now(), notes text, created_by uuid references public.cl_staff(id), created_at timestamptz not null default now(),
  install_id text, location text, app_registered_at timestamptz, last_checkin_at timestamptz,
  lock_cart boolean not null default false, lock_add_product boolean not null default false, lock_reason text,
  constraint cl_vendors_install_id_key unique (install_id));
create table public.cl_vendor_messages (id uuid primary key default gen_random_uuid(), vendor_id uuid not null references public.cl_vendors(id) on delete cascade,
  title text not null, body text not null, channel text not null, status text not null default 'pending', created_by uuid,
  created_at timestamptz not null default now(), delivered_at timestamptz);
create table public.cl_activity_log (id uuid primary key default gen_random_uuid(), staff_id uuid references public.cl_staff(id), action text not null,
  target_table text, target_id uuid, detail jsonb, created_at timestamptz not null default now());
alter table public.cl_vendors enable row level security;
alter table public.cl_vendor_messages enable row level security;
alter table public.cl_activity_log enable row level security;
create policy cl_vendors_select on public.cl_vendors for select using ((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors')));
insert into public.cl_staff (id, full_name) values ('${STAFF_VENDORS}', 'Vendors Clerk'), ('${STAFF_OTHER}', 'Cashbook Clerk');
insert into public.cl_modules (key, label) values ('vendors', 'Vendors Register'), ('cashbook', 'Cashbook');
insert into public.cl_staff_module_access select '${STAFF_VENDORS}', id from public.cl_modules where key = 'vendors';
insert into public.cl_staff_module_access select '${STAFF_OTHER}', id from public.cl_modules where key = 'cashbook';
` + OLD_CHECKIN + `
grant execute on function public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid) to public, anon, authenticated, service_role;
`;

module.exports = { LIVE_STUB, STAFF_VENDORS, STAFF_OTHER, RB };
