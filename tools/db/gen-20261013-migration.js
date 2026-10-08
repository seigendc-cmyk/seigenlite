// node tools/db/gen-20261013-migration.js
// One-off generator for supabase/migrations/20261013120000_price_plans.sql
// and its rollback (docs/billing/price-plans-design.md, owner's answers
// 2026-10-08: plans edited by sysadmin only; plans set by staff only; a
// business's tills are billed together). It copies the CURRENT bodies of
// the functions it changes (all proven equal to live by
// supabase/tests/baseline-rebuild-test.js), so each changed function differs
// only by the marked lines, and the rollback restores them byte for byte.
// SQL chunks are String.raw so backslashes (regexp \s) reach the file as is.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const READ = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const BASE = READ('supabase/migrations/20260923000000_baseline.sql');
const IDENT = READ('supabase/migrations/20261004120000_multi_terminal_identity.sql');
const PHASE2 = READ('supabase/migrations/20261004180000_multi_terminal_phase2.sql');
const LIC = READ('supabase/migrations/20261010120000_activation_licences.sql');
const GUARDS = READ('supabase/migrations/20261012120000_payment_reversal_and_duplicate_guards.sql');

function cut(src, start, endMarker) {
  const i = src.indexOf(start); if (i < 0) throw new Error('not found: ' + start.slice(0, 60));
  if (src.indexOf(start, i + 1) >= 0) throw new Error('start not unique: ' + start.slice(0, 60));
  const j = src.indexOf(endMarker, i); if (j < 0) throw new Error('end not found for ' + start.slice(0, 60));
  return src.slice(i, j + endMarker.length);
}
function rep(src, anchor, text) { if (src.split(anchor).length !== 2) throw new Error('anchor not unique: ' + anchor.slice(0, 70)); return src.replace(anchor, () => text); }
const ins = (src, anchor, text) => rep(src, anchor, anchor + text);
const insBefore = (src, anchor, text) => rep(src, anchor, text + anchor);
const orReplace = (s) => s.replace(/^create function/, 'create or replace function');

// ---- the current bodies ----
const ISSUE_OLD = cut(GUARDS, 'CREATE OR REPLACE FUNCTION public.cl_issue_activation_code(', '$function$;');
const PREP_OLD = cut(GUARDS, 'create or replace function public.cl_licence_prepare(', 'end $fn$;');
const ATTACH_OLD = orReplace(cut(LIC, 'create function public.cl_licence_attach(', 'end $fn$;'));
const LIST_OLD = orReplace(cut(LIC, 'create function public.cl_licence_list(', 'end $fn$;'));
const RATE_OLD = cut(BASE, 'CREATE OR REPLACE FUNCTION public.cl_set_activation_rate(', '$function$;');
const JOINCODE_OLD = orReplace(cut(IDENT, 'create function public.cl_branch_issue_join_code(', 'end $fn$;'));
const JOIN_OLD = cut(PHASE2, 'create or replace function public.cl_terminal_join(', 'end $fn$;');

// ---- the priced versions ----
// Old-style codes: the plan price for the vendor's till, x days / 30.
let ISSUE_NEW = rep(ISSUE_OLD, `  v_ledger   cl_ledger_entries%rowtype;
begin`, `  v_ledger   cl_ledger_entries%rowtype;
  v_price    jsonb;   -- Price plans (20261013120000)
begin`);
ISSUE_NEW = rep(ISSUE_NEW, String.raw`  select * into v_rate from cl_activation_pricing order by effective_from desc limit 1;

  if found then
    insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, activation_code_id, recorded_by, notes)
    values (p_vendor_id, 'charge', v_rate.amount, v_rate.currency, v_code.id, v_staff_id, 'Auto-charged: activation code issued')
    returning * into v_ledger;
  end if;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff_id, 'issue_activation_code', 'cl_activation_codes', v_code.id,
    json_build_object('vendor_id', p_vendor_id, 'computed_code', p_computed_code, 'charged', v_rate.amount, 'currency', v_rate.currency));`,
String.raw`  -- Price plans (20261013120000): the same plan and till-role price as a v2
  -- licence for this vendor's till, x the code's days / 30 (the flat
  -- cl_activation_pricing rate is no longer used).
  v_price := cl_plan_price(p_vendor_id, (select vd.install_id from cl_vendors vd where vd.id = p_vendor_id),
                           greatest(1, least(366, coalesce(p_valid_to - p_valid_from, 30))));
  if (v_price->>'amount')::numeric > 0 then
    insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, activation_code_id, recorded_by, notes)
    values (p_vendor_id, 'charge', (v_price->>'amount')::numeric, v_price->>'currency', v_code.id, v_staff_id, 'Auto-charged: activation code issued')
    returning * into v_ledger;
  end if;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff_id, 'issue_activation_code', 'cl_activation_codes', v_code.id,
    json_build_object('vendor_id', p_vendor_id, 'computed_code', p_computed_code, 'charged', v_ledger.amount, 'currency', v_price->>'currency',
                      'price_plan', v_price->>'plan_code', 'till_role', v_price->>'till_role', 'unit_fee', v_price->'unit_fee', 'days', v_price->'days'));`);

// Licences: price each till at prepare, snapshot it, put the plan's byte in the payload.
let PREP_NEW = rep(PREP_OLD, `  v_biz_bytes bytea; v_vendor cl_vendors%rowtype;
begin`, `  v_biz_bytes bytea; v_vendor cl_vendors%rowtype;
  v_price jsonb;   -- Price plans (20261013120000)
begin`);
PREP_NEW = rep(PREP_NEW, `    v_code := cl_licence_new_code();
    insert into cl_licences (key_id, install_id, device_tag, binding, strong_binding, vendor_id, business_id, terminal_id,
                             plan, days, valid_from, valid_to, payload, short_code_hash, note, issued_by)
    values (p_key_id, v_install, v_tag, v_binding, v_strong, t.vendor_id, t.business_id, t.terminal_id,
            p_plan, p_days, v_from, v_to, '\\x'::bytea, encode(extensions.digest(v_code, 'sha256'), 'hex'), p_note, v_staff)
    returning serial into v_serial;`.replace('\\\\x', '\\x'), `    -- Price plans (20261013120000): this till's plan, role and price, worked
    -- out now and kept on the licence (the charge at attach uses exactly
    -- this). Refuses a deactivated till and a branch over the plan's limit.
    -- The payload's plan byte is the plan's (p_plan is no longer used).
    v_price := cl_plan_price(t.vendor_id, v_install, p_days);
    v_code := cl_licence_new_code();
    insert into cl_licences (key_id, install_id, device_tag, binding, strong_binding, vendor_id, business_id, terminal_id,
                             plan, days, valid_from, valid_to, payload, short_code_hash, note, issued_by,
                             price_plan_code, plan_version_id, plan_source, till_role, unit_fee, amount, currency)
    values (p_key_id, v_install, v_tag, v_binding, v_strong, t.vendor_id, t.business_id, t.terminal_id,
            (v_price->>'plan_byte')::smallint, p_days, v_from, v_to, '\\x'::bytea, encode(extensions.digest(v_code, 'sha256'), 'hex'), p_note, v_staff,
            v_price->>'plan_code', (v_price->>'plan_version_id')::uuid, v_price->>'plan_source', v_price->>'till_role',
            (v_price->>'unit_fee')::numeric, (v_price->>'amount')::numeric, v_price->>'currency')
    returning serial into v_serial;`.replace('\\\\x', '\\x'));
PREP_NEW = rep(PREP_NEW, `      || set_byte('\\x00'::bytea, 0, p_plan) || set_byte('\\x00'::bytea, 0, v_flags)`.replace(/\\\\x/g, '\\x'),
                         `      || set_byte('\\x00'::bytea, 0, (v_price->>'plan_byte')::int) || set_byte('\\x00'::bytea, 0, v_flags)`.replace(/\\\\x/g, '\\x'));
PREP_NEW = rep(PREP_NEW, `      'valid_from', v_from, 'valid_to', v_to, 'days', p_days);
  end loop;`, `      'valid_from', v_from, 'valid_to', v_to, 'days', p_days,
      'plan_code', v_price->>'plan_code', 'plan_name', v_price->>'plan_name', 'plan_source', v_price->>'plan_source',
      'till_role', v_price->>'till_role', 'unit_fee', v_price->'unit_fee', 'amount', v_price->'amount', 'currency', v_price->>'currency',
      'charged', t.vendor_id is not null);
  end loop;`);

let ATTACH_NEW = rep(ATTACH_OLD, `  l cl_licences%rowtype; v_sig bytea; v_rate cl_activation_pricing%rowtype; v_ledger uuid; v_amount numeric;
begin`, `  l cl_licences%rowtype; v_sig bytea; v_rate cl_activation_pricing%rowtype; v_ledger uuid; v_amount numeric;
  v_price jsonb;   -- Price plans (20261013120000)
begin`);
ATTACH_NEW = rep(ATTACH_NEW, `  -- the same automatic charge cl_issue_activation_code writes, per 30 days
  if l.vendor_id is not null then
    select * into v_rate from cl_activation_pricing order by effective_from desc limit 1;
    if found then
      v_amount := round(v_rate.amount * l.days / 30.0, 2);
      insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, recorded_by, notes)
      values (l.vendor_id, 'charge', v_amount, v_rate.currency, cl_jwt_sub(),
              'Auto-charged: licence #' || l.serial || ' (' || l.days || ' days)')
      returning id into v_ledger;
    end if;
  end if;`, `  -- Price plans (20261013120000): charge exactly the price snapshotted at
  -- prepare. A licence prepared before price plans is priced now (and keeps
  -- that snapshot). The note text is unchanged (the Console looks it up).
  if l.till_role is null then
    v_price := cl_plan_price(l.vendor_id, l.install_id, l.days);
    update cl_licences set price_plan_code = v_price->>'plan_code', plan_version_id = (v_price->>'plan_version_id')::uuid,
           plan_source = v_price->>'plan_source', till_role = v_price->>'till_role', unit_fee = (v_price->>'unit_fee')::numeric,
           amount = (v_price->>'amount')::numeric, currency = v_price->>'currency'
     where serial = p_serial returning * into l;
  end if;
  if l.vendor_id is not null and l.amount > 0 then
    v_amount := l.amount;
    insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, recorded_by, notes)
    values (l.vendor_id, 'charge', v_amount, l.currency, cl_jwt_sub(),
            'Auto-charged: licence #' || l.serial || ' (' || l.days || ' days)')
    returning id into v_ledger;
  end if;`);
ATTACH_NEW = rep(ATTACH_NEW, `'plan', l.plan, 'key_id', l.key_id, 'charged', v_amount, 'note', l.note));`,
  `'plan', l.plan, 'key_id', l.key_id, 'charged', v_amount, 'note', l.note,
                             'price_plan', l.price_plan_code, 'till_role', l.till_role, 'unit_fee', l.unit_fee, 'currency', l.currency));`);
ATTACH_NEW = rep(ATTACH_NEW, `  return json_build_object('serial', l.serial, 'licence', l.licence, 'valid_to', l.valid_to);`,
  `  return json_build_object('serial', l.serial, 'licence', l.licence, 'valid_to', l.valid_to,
                           'amount', l.amount, 'currency', l.currency, 'charged', v_ledger is not null);`);

const LIST_NEW = rep(LIST_OLD, `           l.redeemed_at, l.redeemed_via, l.revoked_at, l.revoke_reason, l.note, l.licence`,
  `           l.redeemed_at, l.redeemed_via, l.revoked_at, l.revoke_reason, l.note, l.licence,
           l.price_plan_code, l.plan_source, l.till_role, l.unit_fee, l.amount, l.currency, l.ledger_entry_id   -- Price plans (20261013120000)`);

const RATE_NEW = rep(RATE_OLD, `  if p_amount is null or p_amount <= 0 then`, `  -- Price plans (20261013120000) replaced the flat activation rate.
  raise exception 'The activation rate is replaced by Price plans (Console → Price plans).';
  if p_amount is null or p_amount <= 0 then`);

let JOINCODE_NEW = rep(JOINCODE_OLD, `declare v cl_vendors%rowtype; me cl_terminals%rowtype; target cl_branches%rowtype; code text; exp timestamptz;
begin`, `declare v cl_vendors%rowtype; me cl_terminals%rowtype; target cl_branches%rowtype; code text; exp timestamptz;
        v_max integer;   -- Price plans (20261013120000)
begin`);
JOINCODE_NEW = rep(JOINCODE_NEW, `  if p_branch_id is not null then
    select * into target from cl_branches where id = p_branch_id and business_id = me.business_id;
    if not found then raise exception 'Branch not found in this business'; end if;
  else
    select * into target from cl_branches where business_id = me.business_id and cl_branch_key(name) = cl_branch_key(p_new_branch_name);
    if not found then
      insert into cl_branches`, `  -- Price plans (20261013120000): the business's plan may limit its branches (Lite: one).
  v_max := (cl_plan_version((select pl.plan_code from cl_plan_of(me.business_id, null) pl))).max_branches;
  if p_branch_id is not null then
    select * into target from cl_branches where id = p_branch_id and business_id = me.business_id;
    if not found then raise exception 'Branch not found in this business'; end if;
    if not target.is_main and not cl_plan_branch_allowed(target.id, v_max) then raise exception '%', cl_plan_branch_limit_text(v_max); end if;
  else
    select * into target from cl_branches where business_id = me.business_id and cl_branch_key(name) = cl_branch_key(p_new_branch_name);
    if found and not target.is_main and not cl_plan_branch_allowed(target.id, v_max) then raise exception '%', cl_plan_branch_limit_text(v_max); end if;
    if not found then
      if v_max is not null and (select count(*) from cl_branches cb where cb.business_id = me.business_id) >= v_max then
        raise exception '%', cl_plan_branch_limit_text(v_max);
      end if;
      insert into cl_branches`);

const JOIN_NEW = rep(JOIN_OLD, `  if exists (select 1 from cl_vendors where install_id = p_install_id and business_id is not null and business_id <> biz.id) then
    return json_build_object('error', 'OTHER_BUSINESS');
  end if;
`, `  if exists (select 1 from cl_vendors where install_id = p_install_id and business_id is not null and business_id <> biz.id) then
    return json_build_object('error', 'OTHER_BUSINESS');
  end if;
  -- Price plans (20261013120000): a branch beyond the plan's limit (Lite: one) takes no tills.
  if not br.is_main and not cl_plan_branch_allowed(br.id, (cl_plan_version((select pl.plan_code from cl_plan_of(biz.id, null) pl))).max_branches) then
    raise exception '%', cl_plan_branch_limit_text((cl_plan_version((select pl.plan_code from cl_plan_of(biz.id, null) pl))).max_branches);
  end if;
`);

const HEADER = `-- =====================================================================
-- Price plans (Business / Lite), priced per till licence.
-- Design: docs/billing/price-plans-design.md. Owner's decisions 2026-10-08:
-- the plans and fees below; price plans edited by sysadmin only; a shop's
-- plan set by staff only (Vendors Register or sysadmin); the tills of one
-- business are billed together (the Console adds them up). Applied live
-- only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261013120000_price_plans.rollback.sql
-- Tested in PGlite: supabase/tests/price-plans-test.js
-- Generated by tools/db/gen-20261013-migration.js from the live function
-- bodies, so each changed function differs only by its marked lines.
--
-- 1. cl_price_plans (business = licence byte 1, lite = 2) and
--    cl_price_plan_versions (fees per 30 days, currency, branch limit,
--    effective from; never edited, a change is a new version).
--    Seeded: Business 15 / 7 / 3 USD, no branch limit; Lite 6 / - / 3 USD,
--    one branch.
-- 2. cl_plan_assignments: which plan a business (or an unregistered
--    device's vendor) is on, with who, when and why. No assignment means
--    Business, flagged "not set".
-- 3. cl_licences: the price snapshot (plan, version, role, fee, amount,
--    currency), which can't be changed once set.
-- 4. A till's role when its licence is issued: main (the lowest active till
--    of the main branch, or a device with no till), branch (the lowest
--    active till of another branch), till (any other). Price = role fee x
--    days / 30, rounded to cents. A deactivated till is refused.
-- 5. Changed: cl_licence_prepare / cl_licence_attach (price, snapshot,
--    charge the snapshot), cl_issue_activation_code (old codes: plan price),
--    cl_licence_list (shows the snapshot), cl_set_activation_rate (refuses:
--    replaced), cl_branch_issue_join_code / cl_terminal_join (the branch
--    limit). New staff RPCs: cl_licence_quote, cl_price_plans_list,
--    cl_price_plan_set (sysadmin), cl_set_plan, cl_plan_accounts. New device
--    RPC: cl_licence_terms. Grants of changed functions are unchanged.
--    Licences, codes and charges already issued are not touched.
-- =====================================================================
`;

const MIGRATION = HEADER + String.raw`
begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'table ' || t n from unnest(array['cl_price_plans', 'cl_price_plan_versions', 'cl_plan_assignments']) t where to_regclass('public.' || t) is not null
    union all select 'column cl_licences.' || c from unnest(array['price_plan_code', 'plan_version_id', 'plan_source', 'till_role', 'unit_fee', 'amount', 'currency']) c
      where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cl_licences' and column_name = c)
    union all select 'function ' || f from unnest(array['cl_plan_of', 'cl_plan_version', 'cl_plan_branch_allowed', 'cl_plan_branch_limit_text', 'cl_plan_price',
        'cl_plan_staff_ok', 'cl_licence_quote', 'cl_price_plans_list', 'cl_price_plan_set', 'cl_set_plan', 'cl_plan_accounts', 'cl_licence_terms',
        'cl_licences_snapshot_guard']) f
      where exists (select 1 from pg_proc where proname = f and pronamespace = 'public'::regnamespace)
  ) x;
  if conflicts is not null then raise exception 'price_plans aborted: already exists: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'function ' || f n from unnest(array['public.cl_licence_prepare(text,uuid,integer,integer,integer,text)', 'public.cl_licence_attach(integer,text)',
        'public.cl_licence_list(text,uuid,integer)', 'public.cl_issue_activation_code(uuid,text,text,integer,date,date)',
        'public.cl_set_activation_rate(numeric,text)', 'public.cl_branch_issue_join_code(text,text,text,uuid,text,integer)',
        'public.cl_terminal_join(text,text,text,text,text,text,text,text,text,text)', 'public.cl_install_vendor(text,text,text,boolean,text,text)',
        'public.cl_licence_staff_ok()', 'public.cl_reverse_ledger_payment(uuid,text)']) f
      where to_regprocedure(f) is null
    union all select 'table cl_licences' where to_regclass('public.cl_licences') is null
  ) x;
  if missing is not null then raise exception 'price_plans aborted: missing: %. Nothing was changed.', missing; end if;
end $$;


-- 1. Plans and their prices ---------------------------------------------
create table public.cl_price_plans (
  code         text primary key check (code ~ '^[a-z][a-z0-9_]{1,23}$'),
  licence_byte smallint not null unique check (licence_byte between 1 and 255),   -- the plan byte in the signed licence
  created_at   timestamptz not null default now()
);
comment on table public.cl_price_plans is 'Price plans (Business, Lite). Prices live in cl_price_plan_versions. Access only through cl_ RPCs.';

create table public.cl_price_plan_versions (
  id             uuid primary key default gen_random_uuid(),
  plan_code      text not null references public.cl_price_plans(code),
  name           text not null check (length(btrim(name)) between 1 and 40),
  main_fee       numeric(10,2) not null check (main_fee >= 0),     -- per 30 days: the main till
  branch_fee     numeric(10,2) check (branch_fee >= 0),            -- per 30 days: the first till of another branch
  till_fee       numeric(10,2) not null check (till_fee >= 0),     -- per 30 days: any other till
  currency       text not null check (currency ~ '^[A-Z]{3}$'),
  max_branches   integer check (max_branches >= 1),                -- null: no limit
  effective_from timestamptz not null,
  created_by     uuid references public.cl_staff(id),              -- null: seeded by this migration
  created_at     timestamptz not null default now(),
  note           text check (length(note) <= 500),
  check (branch_fee is not null or max_branches = 1)
);
create index cl_price_plan_versions_current_idx on public.cl_price_plan_versions (plan_code, effective_from desc, created_at desc);
comment on table public.cl_price_plan_versions is 'Price plan prices with history: the current one is the latest effective_from <= now(). Never edited; a change is a new row (cl_price_plan_set).';

insert into public.cl_price_plans (code, licence_byte) values ('business', 1), ('lite', 2);
insert into public.cl_price_plan_versions (plan_code, name, main_fee, branch_fee, till_fee, currency, max_branches, effective_from, note) values
  ('business', 'Business', 15, 7, 3, 'USD', null, now(), 'Owner decision 2026-10-08: retail and wholesale'),
  ('lite', 'Lite', 6, null, 3, 'USD', 1, now(), 'Owner decision 2026-10-08: flea markets, tuckshops, canteens; one branch');

create table public.cl_plan_assignments (
  id          bigint generated always as identity primary key,
  business_id uuid references public.cl_businesses(id) on delete restrict,
  vendor_id   uuid references public.cl_vendors(id) on delete restrict,   -- only for a device with no business
  plan_code   text not null references public.cl_price_plans(code),
  reason      text not null check (length(btrim(reason)) between 1 and 500),
  set_by      uuid not null references public.cl_staff(id),
  created_at  timestamptz not null default now(),
  check ((business_id is null) <> (vendor_id is null))
);
create index cl_plan_assignments_business_idx on public.cl_plan_assignments (business_id, created_at desc) where business_id is not null;
create index cl_plan_assignments_vendor_idx on public.cl_plan_assignments (vendor_id, created_at desc) where vendor_id is not null;
comment on table public.cl_plan_assignments is 'Which price plan a business (or an unregistered device''s vendor) is on; the latest row counts. History is kept; set only with cl_set_plan.';

alter table public.cl_price_plans enable row level security;
alter table public.cl_price_plan_versions enable row level security;
alter table public.cl_plan_assignments enable row level security;
revoke all on table public.cl_price_plans, public.cl_price_plan_versions, public.cl_plan_assignments from public, anon, authenticated;


-- 2. The price snapshot on each licence ---------------------------------
alter table public.cl_licences
  add column price_plan_code text references public.cl_price_plans(code),
  add column plan_version_id uuid references public.cl_price_plan_versions(id),
  add column plan_source     text check (plan_source in ('assigned', 'default')),
  add column till_role       text check (till_role in ('main', 'branch', 'till')),
  add column unit_fee        numeric(10,2),
  add column amount          numeric(10,2),
  add column currency        text;
alter table public.cl_licences add constraint cl_licences_price_shape check (
  (price_plan_code is null and plan_version_id is null and plan_source is null and till_role is null and unit_fee is null and amount is null and currency is null)
  or (price_plan_code is not null and plan_version_id is not null and plan_source is not null and till_role is not null and unit_fee is not null and amount is not null and currency is not null));
comment on column public.cl_licences.till_role is 'Price plans: the till''s role when the licence was issued (main / branch / till); with price_plan_code, plan_version_id, plan_source, unit_fee, amount and currency, the price snapshot. Null: issued before price plans.';

create function public.cl_licences_snapshot_guard() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if old.till_role is not null and (new.price_plan_code, new.plan_version_id, new.plan_source, new.till_role, new.unit_fee, new.amount, new.currency, new.days)
       is distinct from (old.price_plan_code, old.plan_version_id, old.plan_source, old.till_role, old.unit_fee, old.amount, old.currency, old.days) then
    raise exception 'A licence''s price snapshot can''t be changed (licence #%)', old.serial;
  end if;
  return new;
end $fn$;
create trigger cl_licences_snapshot_guard before update on public.cl_licences
  for each row execute function public.cl_licences_snapshot_guard();


-- 3. Internal helpers (not callable by anon / authenticated) -------------
-- The plan of a business (its own assignment, else its creator device's),
-- or of a device with no business. No assignment: Business, 'default'.
create function public.cl_plan_of(p_business_id uuid, p_vendor_id uuid)
returns table (plan_code text, plan_source text, assignment_id bigint)
language sql stable set search_path = public as $$
  select coalesce(a.plan_code, 'business'), case when a.id is null then 'default' else 'assigned' end, a.id
  from (select 1) one
  left join lateral (
    select x.id, x.plan_code from cl_plan_assignments x
    where (p_business_id is not null and (x.business_id = p_business_id
             or x.vendor_id = (select b.created_by_vendor_id from cl_businesses b where b.id = p_business_id)))
       or (p_business_id is null and p_vendor_id is not null and x.vendor_id = p_vendor_id)
    order by (x.business_id is not null) desc, x.created_at desc, x.id desc
    limit 1) a on true
$$;

-- A plan's prices in effect now.
create function public.cl_plan_version(p_plan_code text) returns public.cl_price_plan_versions
language sql stable set search_path = public as $$
  select * from cl_price_plan_versions where plan_code = p_plan_code and effective_from <= now()
  order by effective_from desc, created_at desc limit 1
$$;

-- Is this branch within the plan's branch limit? Branches count main first,
-- then oldest first.
create function public.cl_plan_branch_allowed(p_branch_id uuid, p_max integer) returns boolean
language sql stable set search_path = public as $$
  select p_max is null or (
    select count(*) from cl_branches o join cl_branches b on b.id = p_branch_id and o.business_id = b.business_id
    where (o.is_main and not b.is_main) or (o.is_main = b.is_main and (o.created_ts, o.id) <= (b.created_ts, b.id))
  ) <= p_max
$$;

create function public.cl_plan_branch_limit_text(p_max integer) returns text
language sql immutable as $$
  select case when coalesce(p_max, 1) = 1
    then 'PLAN_BRANCH_LIMIT: Your plan allows one branch. Ask seiGEN to upgrade you to the Business plan.'
    else 'PLAN_BRANCH_LIMIT: Your plan allows ' || p_max || ' branches. Ask seiGEN to upgrade you to the Business plan.' end
$$;

-- THE price of a licence (or an old-style code) for one device: its plan,
-- its role when issued, the role's fee and fee x days / 30. Used by
-- prepare, attach, old codes, the quote, the accounts list: one answer.
create function public.cl_plan_price(p_vendor_id uuid, p_install_id text, p_days integer) returns jsonb
language plpgsql stable set search_path = public as $fn$
declare
  te cl_terminals%rowtype; br cl_branches%rowtype; v_biz uuid; v_role text; v_rank integer;
  v_plan record; v_ver cl_price_plan_versions%rowtype; v_byte smallint; v_fee numeric;
begin
  if p_days is null or p_days < 1 or p_days > 366 then raise exception 'Days must be 1..366'; end if;
  if nullif(p_install_id, '') is not null then
    select * into te from cl_terminals where install_id = upper(p_install_id);
  elsif p_vendor_id is not null then
    select * into te from cl_terminals where vendor_id = p_vendor_id;
  end if;
  if te.id is not null then
    if not te.active then
      raise exception 'TILL_INACTIVE: Till % of this business is deactivated. Reactivate it from a main-branch till first.', te.till_code;
    end if;
    select * into br from cl_branches where id = te.branch_id;
    select count(*) + 1 into v_rank from cl_terminals o
     where o.branch_id = te.branch_id and o.active and substr(o.till_code, 2)::int < substr(te.till_code, 2)::int;
    v_role := case when v_rank > 1 then 'till' when br.is_main then 'main' else 'branch' end;
    v_biz := te.business_id;
  else
    v_role := 'main';   -- a device that isn't a till of a business is its shop's main till
    v_biz := (select vd.business_id from cl_vendors vd where vd.id = p_vendor_id);
  end if;
  select * into v_plan from cl_plan_of(v_biz, p_vendor_id);
  v_ver := cl_plan_version(v_plan.plan_code);
  if v_ver.id is null then raise exception 'No price is in effect for plan %', v_plan.plan_code; end if;
  if br.id is not null and not br.is_main and not cl_plan_branch_allowed(br.id, v_ver.max_branches) then
    raise exception '%', cl_plan_branch_limit_text(v_ver.max_branches);
  end if;
  v_fee := case v_role when 'main' then v_ver.main_fee when 'branch' then v_ver.branch_fee else v_ver.till_fee end;
  if v_fee is null then raise exception '%', cl_plan_branch_limit_text(v_ver.max_branches); end if;
  select p.licence_byte into v_byte from cl_price_plans p where p.code = v_plan.plan_code;
  return jsonb_build_object('plan_code', v_plan.plan_code, 'plan_name', v_ver.name, 'plan_version_id', v_ver.id, 'plan_byte', v_byte,
    'plan_source', v_plan.plan_source, 'business_id', v_biz, 'terminal_id', te.id, 'till_code', te.till_code,
    'till_role', v_role, 'unit_fee', v_fee, 'days', p_days, 'amount', round(v_fee * p_days / 30.0, 2), 'currency', v_ver.currency);
end $fn$;

-- Staff who may see plans and prices: active, and sysadmin or one of the
-- modules that deal with vendors and their money.
create function public.cl_plan_staff_ok() returns boolean
language sql stable set search_path = public as $$
  select coalesce(cl_jwt_user_type() = 'staff', false)
     and exists (select 1 from cl_staff s where s.id = cl_jwt_sub() and s.active)
     and (cl_jwt_is_sysadmin() or cl_has_module_access('activation_codes') or cl_has_module_access('vendors')
          or cl_has_module_access('collections_ledger') or cl_has_module_access('billing_reminders'))
$$;

revoke all on function public.cl_plan_of(uuid, uuid), public.cl_plan_version(text), public.cl_plan_branch_allowed(uuid, integer),
  public.cl_plan_branch_limit_text(integer), public.cl_plan_price(uuid, text, integer), public.cl_plan_staff_ok(),
  public.cl_licences_snapshot_guard() from public, anon, authenticated;


-- 4. Staff RPCs ----------------------------------------------------------
-- The price before issuing: same devices as cl_licence_prepare (one device
-- by code, or every active till of a business), same price function.
create function public.cl_licence_quote(p_device_code text default null, p_business_id uuid default null, p_days integer default 30)
returns json
language plpgsql security definer set search_path = public as $fn$
declare r record; v jsonb; lines jsonb := '[]'; refused jsonb := '[]'; v_total numeric := 0; v_cur text;
begin
  if not cl_licence_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_days not in (30, 90, 365) then raise exception 'Days must be 30, 90 or 365'; end if;
  if (p_device_code is null) = (p_business_id is null) then raise exception 'Give either a device code or a business'; end if;
  for r in
    select x.* from (
      select upper(split_part(regexp_replace(p_device_code, '\s', '', 'g'), '-', 1)) install_id, vd.id vendor_id,
             te.till_code, br.name branch_name, bz.name business_name, coalesce(bz.name, vd.business_name) shop_name
      from (select 1) one
      left join cl_vendors vd on vd.install_id = upper(split_part(regexp_replace(p_device_code, '\s', '', 'g'), '-', 1))
      left join cl_terminals te on te.install_id = upper(split_part(regexp_replace(p_device_code, '\s', '', 'g'), '-', 1))
      left join cl_branches br on br.id = te.branch_id
      left join cl_businesses bz on bz.id = te.business_id
      where p_device_code is not null
      union all
      select te.install_id, te.vendor_id, te.till_code, br.name, bz.name, bz.name
      from cl_terminals te join cl_branches br on br.id = te.branch_id join cl_businesses bz on bz.id = te.business_id
      where p_business_id is not null and te.business_id = p_business_id and te.active
    ) x
    order by x.branch_name nulls first, substr(x.till_code, 2)::int nulls first
  loop
    begin
      v := cl_plan_price(r.vendor_id, r.install_id, p_days);
      lines := lines || jsonb_build_array(v || jsonb_build_object('install_id', r.install_id, 'vendor_id', r.vendor_id, 'branch', r.branch_name,
                 'business_name', r.business_name, 'shop_name', r.shop_name, 'charged', r.vendor_id is not null));
      if r.vendor_id is not null then v_total := v_total + (v->>'amount')::numeric; v_cur := v->>'currency'; end if;
    exception when others then
      refused := refused || jsonb_build_array(jsonb_build_object('install_id', r.install_id, 'till_code', r.till_code, 'branch', r.branch_name, 'message', sqlerrm));
    end;
  end loop;
  return json_build_object('lines', lines, 'refused', refused, 'total', v_total, 'currency', v_cur, 'days', p_days);
end $fn$;

-- Plans with their current prices and full history.
create function public.cl_price_plans_list() returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not cl_plan_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('code', p.code, 'licence_byte', p.licence_byte,
      'current_id', (cl_plan_version(p.code)).id,
      'versions', (select json_agg(json_build_object('id', v.id, 'name', v.name, 'main_fee', v.main_fee, 'branch_fee', v.branch_fee,
                     'till_fee', v.till_fee, 'currency', v.currency, 'max_branches', v.max_branches, 'effective_from', v.effective_from,
                     'upcoming', v.effective_from > now(), 'created_at', v.created_at, 'created_by', s.full_name, 'note', v.note)
                   order by v.effective_from desc, v.created_at desc)
                   from cl_price_plan_versions v left join cl_staff s on s.id = v.created_by where v.plan_code = p.code))
    order by p.licence_byte) from cl_price_plans p), '[]'::json);
end $fn$;

-- A plan's new prices, from now or a later date. Sysadmin only.
create function public.cl_price_plan_set(p_plan_code text, p_name text, p_main_fee numeric, p_branch_fee numeric, p_till_fee numeric,
                                         p_currency text, p_max_branches integer, p_effective_from timestamptz default null, p_note text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_staff uuid := cl_jwt_sub(); v_cur text := upper(btrim(coalesce(p_currency, ''))); v_name text := btrim(coalesce(p_name, ''));
  v_from timestamptz := coalesce(p_effective_from, now()); v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_row cl_price_plan_versions%rowtype;
begin
  if not (coalesce(cl_jwt_user_type() = 'staff', false) and cl_jwt_is_sysadmin()
          and exists (select 1 from cl_staff s where s.id = v_staff and s.active)) then
    raise exception 'Not authorized: only a SysAdmin can change price plans' using errcode = '42501';
  end if;
  if not exists (select 1 from cl_price_plans where code = p_plan_code) then raise exception 'No such plan'; end if;
  if v_name = '' or length(v_name) > 40 then raise exception 'A plan name is 1 to 40 characters'; end if;
  if v_cur !~ '^[A-Z]{3}$' then raise exception 'Currency is a 3-letter code (e.g. USD)'; end if;
  if p_main_fee is null or p_till_fee is null then raise exception 'The main till and extra till fees are required'; end if;
  if p_main_fee < 0 or p_till_fee < 0 or coalesce(p_branch_fee, 0) < 0 then raise exception 'Fees can''t be negative'; end if;
  if p_main_fee <> round(p_main_fee, 2) or p_till_fee <> round(p_till_fee, 2) or coalesce(p_branch_fee, 0) <> round(coalesce(p_branch_fee, 0), 2) then
    raise exception 'Fees have at most 2 decimals';
  end if;
  if p_max_branches is not null and p_max_branches < 1 then raise exception 'The branch limit is at least 1 (or none)'; end if;
  if p_branch_fee is null and coalesce(p_max_branches, 0) <> 1 then raise exception 'Set a branch fee, or limit the plan to one branch'; end if;
  if v_from < now() - interval '5 minutes' then raise exception 'The effective date can''t be in the past'; end if;
  if length(v_note) > 500 then raise exception 'Keep the note under 500 characters'; end if;

  perform pg_advisory_xact_lock(hashtext('cl_price_plan_set:' || p_plan_code));
  select * into v_row from cl_price_plan_versions
   where plan_code = p_plan_code and created_by = v_staff and created_at > now() - interval '30 seconds'
     and name = v_name and main_fee = p_main_fee and branch_fee is not distinct from p_branch_fee and till_fee = p_till_fee
     and currency = v_cur and max_branches is not distinct from p_max_branches
   order by created_at desc limit 1;
  if found then return json_build_object('version', row_to_json(v_row), 'duplicate', true); end if;

  insert into cl_price_plan_versions (plan_code, name, main_fee, branch_fee, till_fee, currency, max_branches, effective_from, created_by, note)
  values (p_plan_code, v_name, p_main_fee, p_branch_fee, p_till_fee, v_cur, p_max_branches, v_from, v_staff, v_note)
  returning * into v_row;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'set_price_plan', 'cl_price_plan_versions', v_row.id,
          jsonb_build_object('plan', p_plan_code, 'name', v_name, 'main_fee', p_main_fee, 'branch_fee', p_branch_fee, 'till_fee', p_till_fee,
                             'currency', v_cur, 'max_branches', p_max_branches, 'effective_from', v_from, 'note', v_note));
  return json_build_object('version', row_to_json(v_row));
end $fn$;

-- Put a business (or a device with no business) on a plan, from the next
-- licence issued. Staff with Vendors Register, or sysadmin.
create function public.cl_set_plan(p_business_id uuid, p_vendor_id uuid, p_plan_code text, p_reason text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_staff uuid := cl_jwt_sub(); v_reason text := btrim(coalesce(p_reason, ''));
  v_ver cl_price_plan_versions%rowtype; v_prev record; v_row cl_plan_assignments%rowtype; v_branches integer;
begin
  if not (coalesce(cl_jwt_user_type() = 'staff', false)
          and exists (select 1 from cl_staff s where s.id = v_staff and s.active)
          and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors'))) then
    raise exception 'Not authorized: needs the Vendors Register permission' using errcode = '42501';
  end if;
  if (p_business_id is null) = (p_vendor_id is null) then raise exception 'Give either a business or a vendor'; end if;
  if not exists (select 1 from cl_price_plans where code = p_plan_code) then raise exception 'No such plan'; end if;
  if v_reason = '' then raise exception 'A reason is required'; end if;
  if length(v_reason) > 500 then raise exception 'Keep the reason under 500 characters'; end if;
  if p_vendor_id is not null then
    if not exists (select 1 from cl_vendors where id = p_vendor_id) then raise exception 'No such vendor'; end if;
    if exists (select 1 from cl_vendors where id = p_vendor_id and business_id is not null)
       or exists (select 1 from cl_terminals where vendor_id = p_vendor_id) then
      raise exception 'This device is a till of a business. Set the plan on the business instead.';
    end if;
  elsif not exists (select 1 from cl_businesses where id = p_business_id) then
    raise exception 'No such business';
  end if;

  perform pg_advisory_xact_lock(hashtext('cl_set_plan:' || coalesce(p_business_id, p_vendor_id)::text));
  v_ver := cl_plan_version(p_plan_code);
  if v_ver.id is null then raise exception 'No price is in effect for plan %', p_plan_code; end if;
  if p_business_id is not null and v_ver.max_branches is not null then
    select count(distinct t.branch_id) into v_branches from cl_terminals t where t.business_id = p_business_id and t.active;
    if v_branches > v_ver.max_branches then
      raise exception 'PLAN_BRANCH_LIMIT: This business has % branches with active tills; % allows %. Deactivate the other branches'' tills first.',
        v_branches, v_ver.name, v_ver.max_branches;
    end if;
  end if;

  select * into v_row from cl_plan_assignments
   where business_id is not distinct from p_business_id and vendor_id is not distinct from p_vendor_id and plan_code = p_plan_code
     and reason = v_reason and set_by = v_staff and created_at > now() - interval '30 seconds'
   order by created_at desc limit 1;
  if found then return json_build_object('assignment', row_to_json(v_row), 'duplicate', true); end if;

  select * into v_prev from cl_plan_of(p_business_id, p_vendor_id);
  insert into cl_plan_assignments (business_id, vendor_id, plan_code, reason, set_by)
  values (p_business_id, p_vendor_id, p_plan_code, v_reason, v_staff) returning * into v_row;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'set_plan', 'cl_plan_assignments', null,
          jsonb_build_object('assignment_id', v_row.id, 'business_id', p_business_id, 'vendor_id', p_vendor_id, 'plan', p_plan_code,
                             'previous_plan', v_prev.plan_code, 'previous_source', v_prev.plan_source, 'reason', v_reason));
  return json_build_object('assignment', row_to_json(v_row), 'previous_plan', v_prev.plan_code, 'previous_source', v_prev.plan_source);
end $fn$;

-- Every account the Console bills: each business (its tills billed
-- together) and each device with no business. Plan, its history, each
-- till's role and fee (or why it can't be priced), the 30-day total.
create function public.cl_plan_accounts() returns json
language plpgsql security definer set search_path = public as $fn$
declare a record; t record; v jsonb; tills jsonb; v_total numeric; v_cur text; v_plan record; out_rows jsonb := '[]'; v_flags jsonb;
begin
  if not cl_plan_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  for a in
    select 'business' kind, b.id business_id, null::uuid vendor_id, b.name, b.created_by_vendor_id creator, b.created_ts created
    from cl_businesses b
    union all
    select 'vendor', null, vd.id, vd.business_name, vd.id, vd.created_at
    from cl_vendors vd where vd.business_id is null and not exists (select 1 from cl_terminals te where te.vendor_id = vd.id)
    order by 4, 6
  loop
    tills := '[]'; v_total := 0; v_cur := null; v_flags := '[]';
    for t in
      select u.* from (
        select te.vendor_id, te.install_id, br.name branch, br.is_main, te.till_code, te.active
        from cl_terminals te join cl_branches br on br.id = te.branch_id
        where a.kind = 'business' and te.business_id = a.business_id
        union all
        select a.vendor_id, vd.install_id, null, true, null, true from cl_vendors vd where a.kind = 'vendor' and vd.id = a.vendor_id
      ) u
      order by u.is_main desc, u.branch nulls first, substr(u.till_code, 2)::int nulls first
    loop
      begin
        v := cl_plan_price(t.vendor_id, t.install_id, 30);
        tills := tills || jsonb_build_array(jsonb_build_object('vendor_id', t.vendor_id, 'install_id', t.install_id, 'branch', t.branch,
                   'is_main', t.is_main, 'till_code', t.till_code, 'active', t.active, 'role', v->>'till_role', 'unit_fee', v->'unit_fee'));
        v_total := v_total + (v->>'unit_fee')::numeric; v_cur := v->>'currency';
      exception when others then
        tills := tills || jsonb_build_array(jsonb_build_object('vendor_id', t.vendor_id, 'install_id', t.install_id, 'branch', t.branch,
                   'is_main', t.is_main, 'till_code', t.till_code, 'active', t.active, 'role', null, 'unit_fee', null, 'problem', sqlerrm));
      end;
    end loop;
    select * into v_plan from cl_plan_of(a.business_id, a.vendor_id);
    if a.kind = 'business' and exists (select 1 from cl_businesses o where o.id <> a.business_id and lower(btrim(o.name)) = lower(btrim(a.name))) then
      v_flags := v_flags || '["same_name_as_another_business"]'::jsonb;
    end if;
    if a.kind = 'vendor' and exists (select 1 from cl_vendors o join cl_vendors me on me.id = a.vendor_id
                                      where o.business_id is not null and cl_norm_phrase(o.shop_secret_phrase) <> ''
                                        and cl_norm_phrase(o.shop_secret_phrase) = cl_norm_phrase(me.shop_secret_phrase)) then
      v_flags := v_flags || '["shares_phrase_with_a_business"]'::jsonb;
    end if;
    out_rows := out_rows || jsonb_build_array(jsonb_build_object(
      'kind', a.kind, 'business_id', a.business_id, 'vendor_id', a.vendor_id, 'name', a.name, 'creator_vendor_id', a.creator,
      'plan_code', v_plan.plan_code, 'plan_source', v_plan.plan_source, 'plan_name', (cl_plan_version(v_plan.plan_code)).name,
      'vendor_ids', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from (
          select te.vendor_id x from cl_terminals te where a.kind = 'business' and te.business_id = a.business_id
          union select a.creator) y where x is not null),
      'branches', (select count(*) from cl_branches br where br.business_id = a.business_id),
      'tills', tills, 'monthly_total', v_total, 'currency', v_cur, 'flags', v_flags,
      'history', (select coalesce(jsonb_agg(jsonb_build_object('plan_code', h.plan_code, 'reason', h.reason, 'set_by', s.full_name,
                     'created_at', h.created_at, 'on', case when h.business_id is not null then 'business' else 'device' end)
                   order by h.created_at desc, h.id desc), '[]'::jsonb)
                  from cl_plan_assignments h left join cl_staff s on s.id = h.set_by
                  where (a.business_id is not null and (h.business_id = a.business_id or h.vendor_id = a.creator))
                     or (a.vendor_id is not null and h.vendor_id = a.vendor_id))));
  end loop;
  return out_rows::json;
end $fn$;

revoke all on function public.cl_licence_quote(text, uuid, integer), public.cl_price_plans_list(),
  public.cl_price_plan_set(text, text, numeric, numeric, numeric, text, integer, timestamptz, text),
  public.cl_set_plan(uuid, uuid, text, text), public.cl_plan_accounts() from public, anon, authenticated;
grant execute on function public.cl_licence_quote(text, uuid, integer), public.cl_price_plans_list(),
  public.cl_price_plan_set(text, text, numeric, numeric, numeric, text, integer, timestamptz, text),
  public.cl_set_plan(uuid, uuid, text, text), public.cl_plan_accounts() to authenticated;


-- 5. Device RPC: this device's licence terms (More -> About) -------------
create function public.cl_licence_terms(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; l cl_licences%rowtype; v_now record;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  select * into l from cl_licences
   where install_id = p_install_id and status in ('issued', 'redeemed') and licence is not null
   order by serial desc limit 1;
  select x.plan_code, (cl_plan_version(x.plan_code)).name plan_name into v_now
  from cl_plan_of(coalesce((select te.business_id from cl_terminals te where te.install_id = p_install_id), v.business_id), v.id) x;
  return json_build_object('serial', l.serial, 'valid_to', l.valid_to, 'days', l.days,
    'plan_code', l.price_plan_code, 'plan_name', (select pv.name from cl_price_plan_versions pv where pv.id = l.plan_version_id),
    'till_role', l.till_role, 'unit_fee', l.unit_fee, 'amount', l.amount, 'currency', l.currency,
    'current_plan_code', v_now.plan_code, 'current_plan_name', v_now.plan_name);
end $fn$;
revoke all on function public.cl_licence_terms(text, text, text) from public;
grant execute on function public.cl_licence_terms(text, text, text) to anon, authenticated;


-- 6. Changed functions (marked "Price plans (20261013120000)") ------------
-- 6a. Licences: price at prepare, charge the snapshot at attach
${PREP_NEW}

${ATTACH_NEW}

${LIST_NEW}

-- 6b. Old-style codes (production Console until the old-code cutoff)
${ISSUE_NEW}

-- 6c. The flat rate is replaced
${RATE_NEW}

-- 6d. The branch limit (Lite: one branch)
${JOINCODE_NEW}

${JOIN_NEW}

commit;
`;

const ROLLBACK = String.raw`-- Rollback for supabase/migrations/20261013120000_price_plans.sql.
-- Refuses (changing nothing) while any licence carries a price snapshot or
-- any shop has been put on a plan: those are real priced records.
-- Restores the seven changed functions exactly as they were, and drops the
-- plan tables, the snapshot columns and the new functions.
-- Also remove the row from supabase_migrations.schema_migrations
-- (tools/db/apply-migration.js apply <file> --rollback does both in one transaction).
begin;

do $$
begin
  if exists (select 1 from public.cl_licences where till_role is not null)
     or exists (select 1 from public.cl_plan_assignments) then
    raise exception 'price_plans rollback aborted: priced licences or plan assignments exist. Nothing was changed.';
  end if;
end $$;

${PREP_OLD}

${ATTACH_OLD}

${LIST_OLD}

${ISSUE_OLD}

${RATE_OLD}

${JOINCODE_OLD}

${JOIN_OLD}

drop function public.cl_licence_terms(text, text, text);
drop function public.cl_plan_accounts();
drop function public.cl_set_plan(uuid, uuid, text, text);
drop function public.cl_price_plan_set(text, text, numeric, numeric, numeric, text, integer, timestamptz, text);
drop function public.cl_price_plans_list();
drop function public.cl_licence_quote(text, uuid, integer);
drop function public.cl_plan_staff_ok();
drop function public.cl_plan_price(uuid, text, integer);
drop function public.cl_plan_branch_limit_text(integer);
drop function public.cl_plan_branch_allowed(uuid, integer);
drop function public.cl_plan_version(text);
drop function public.cl_plan_of(uuid, uuid);
drop trigger cl_licences_snapshot_guard on public.cl_licences;
drop function public.cl_licences_snapshot_guard();
alter table public.cl_licences drop constraint cl_licences_price_shape;
alter table public.cl_licences drop column price_plan_code, drop column plan_version_id, drop column plan_source,
  drop column till_role, drop column unit_fee, drop column amount, drop column currency;
drop table public.cl_plan_assignments;
drop table public.cl_price_plan_versions;
drop table public.cl_price_plans;

commit;
`;

fs.writeFileSync(path.join(ROOT, 'supabase/migrations/20261013120000_price_plans.sql'), MIGRATION);
fs.writeFileSync(path.join(ROOT, 'supabase/rollbacks/20261013120000_price_plans.rollback.sql'), ROLLBACK);
console.log('wrote migration (' + MIGRATION.length + ' chars) and rollback (' + ROLLBACK.length + ' chars)');
