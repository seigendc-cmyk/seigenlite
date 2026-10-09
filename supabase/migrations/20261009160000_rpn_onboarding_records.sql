-- =====================================================================
-- RPN Field Guide — full vendor onboarding record. Approved 2026-10-09
-- (decisions D1: new table; D2: the RPN logs the subscription amount from
-- the features the vendor takes, the office confirms it).
-- Rollback: supabase/rollbacks/20261009160000_rpn_onboarding_records.rollback.sql
-- Tested in PGlite: supabase/tests/onboarding-records-test.js
--
-- An onboarding record is the RPN's account of onboarding one vendor:
--   1 vendor & plan, 2 installation & activation, 3 implementation &
--   stocktake, 4 training & handover (with the vendor's acceptance),
-- then 5 office verification, done by Console staff.
--
-- Unlike rpn_onboarding_notes (a first-visit note, insert-only), a record is
-- worked on over several visits, so it can change until the RPN submits it:
--
--   draft --submit--> submitted --office--> approved
--                         |                 rejected
--                         +---------------> returned --submit--> submitted …
--
-- Built only on pieces that already exist (checked in the repo's baseline
-- and the approved notes migration):
--   * identity: the cl_login JWT, read with cl_jwt_user_type() / cl_jwt_sub()
--   * staff permission: cl_has_module_access('vendors') or sysadmin — the
--     same rule as the onboarding notes RPCs
--   * audit: cl_activity_log, written by the staff action
--   * payment: an existing cl_ledger_entries row with entry_type 'payment';
--     nothing here records money, charges, or commission.
--
--   1. public.rpn_onboarding_records
--        id is made on the phone (v4 UUID). Everything the Console lists
--        or checks has its own column; the detail of sections 1–4 is one
--        jsonb object (the Field Guide's form), shown by the Console as is.
--   2. RLS: an RPN reads only their own records. Nobody inserts, updates or
--      deletes through the table API; all writes go through the two
--      functions below.
--   3. cl_rpn_save_onboarding(): the RPN's only write. Creates or updates
--      their own record while it is a draft or returned; optionally submits
--      it. A retried or older copy from the phone never overwrites a newer
--      one (client_saved_at), and a submitted record can't be changed.
--   4. cl_list_onboarding_records(): the staff read path, with names.
--   5. cl_verify_onboarding(): the office decision (Section 5). Approve,
--      return to the RPN, or reject. Logged to cl_activity_log.
--
-- Not changed: cl_vendors (including its status — verifying does NOT move
-- a vendor to active), cl_rpn, cl_login, cl_ledger_entries, billing,
-- commission, activation, rpn_onboarding_notes and every existing policy.
-- Additive, one transaction; the preflight stops on a missing dependency
-- or a name clash.
-- =====================================================================

do $$
declare
  missing text;
  conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'table cl_rpn' n where to_regclass('public.cl_rpn') is null
    union all select 'table cl_vendors' where to_regclass('public.cl_vendors') is null
    union all select 'table cl_staff' where to_regclass('public.cl_staff') is null
    union all select 'table cl_activity_log' where to_regclass('public.cl_activity_log') is null
    union all select 'table cl_ledger_entries' where to_regclass('public.cl_ledger_entries') is null
    union all select 'table rpn_onboarding_notes' where to_regclass('public.rpn_onboarding_notes') is null
    union all select 'function cl_jwt_sub()' where to_regprocedure('public.cl_jwt_sub()') is null
    union all select 'function cl_jwt_user_type()' where to_regprocedure('public.cl_jwt_user_type()') is null
    union all select 'function cl_jwt_is_sysadmin()' where to_regprocedure('public.cl_jwt_is_sysadmin()') is null
    union all select 'function cl_has_module_access(text)' where to_regprocedure('public.cl_has_module_access(text)') is null
  ) x;
  if missing is not null then
    raise exception 'rpn_onboarding_records aborted: missing %. Nothing was changed.', missing;
  end if;
  select string_agg(n, ', ') into conflicts from (
    select 'table rpn_onboarding_records' n where to_regclass('public.rpn_onboarding_records') is not null
    union all select 'function cl_rpn_save_onboarding' where exists (select 1 from pg_proc where proname = 'cl_rpn_save_onboarding' and pronamespace = 'public'::regnamespace)
    union all select 'function cl_list_onboarding_records' where exists (select 1 from pg_proc where proname = 'cl_list_onboarding_records' and pronamespace = 'public'::regnamespace)
    union all select 'function cl_verify_onboarding' where exists (select 1 from pg_proc where proname = 'cl_verify_onboarding' and pronamespace = 'public'::regnamespace)
  ) x;
  if conflicts is not null then
    raise exception 'rpn_onboarding_records aborted: already exists: %. Nothing was changed.', conflicts;
  end if;
end $$;


-- 1. The table ----------------------------------------------------------
create table public.rpn_onboarding_records (
  id                    uuid primary key,  -- made on the phone; no default on purpose
  rpn_id                uuid not null references public.cl_rpn(id),
  note_id               uuid references public.rpn_onboarding_notes(id) on delete set null,

  -- Section 1, the parts the Console lists and checks
  business_name         text not null check (length(btrim(business_name)) between 1 and 120),
  owner_name            text not null check (length(btrim(owner_name)) between 1 and 120),
  phone                 text not null check (phone ~ '^\+?[0-9][0-9 ]{6,19}$'),
  city                  text not null check (length(btrim(city)) between 1 and 80),
  plan                  text check (plan is null or plan in ('business', 'lite')),
  branches              integer check (branches is null or branches between 1 and 200),
  tills                 integer check (tills is null or tills between 1 and 1000),
  subscription_amount   numeric(10,2) check (subscription_amount is null or subscription_amount between 0 and 100000),
  subscription_currency text not null default 'USD' check (subscription_currency ~ '^[A-Z]{3}$'),
  features_taken        text check (features_taken is null or length(features_taken) <= 1000),
  constraint rpn_onboarding_records_lite_one_branch check (plan is distinct from 'lite' or branches is null or branches = 1),
  constraint rpn_onboarding_records_tills_cover_branches check (tills is null or branches is null or tills >= branches),

  -- Sections 1–4 as the Field Guide's form keeps them
  sections              jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(sections) = 'object' and octet_length(sections::text) <= 65536),

  status                text not null default 'draft'
                        check (status in ('draft', 'submitted', 'returned', 'approved', 'rejected')),
  client_saved_at       timestamptz not null,               -- the phone's clock, for this version
  first_received_at     timestamptz not null default now(),
  last_received_at      timestamptz not null default now(),
  submitted_at          timestamptz,

  -- Section 5, set only by cl_verify_onboarding (staff)
  vendor_id             uuid references public.cl_vendors(id) on delete set null,
  payment_entry_id      uuid references public.cl_ledger_entries(id) on delete set null,
  office_checks         jsonb check (office_checks is null or jsonb_typeof(office_checks) = 'object'),
  office_reason         text check (office_reason is null or length(office_reason) <= 1000),
  verified_by           uuid references public.cl_staff(id),
  verified_at           timestamptz
);

comment on table public.rpn_onboarding_records is
  'Full vendor onboarding record from the RPN Field Guide (sections 1-4) plus the office verification (section 5). RPNs read own rows; all writes via cl_rpn_save_onboarding() (RPN) and cl_verify_onboarding() (staff). Never changes cl_vendors.';
comment on column public.rpn_onboarding_records.client_saved_at is
  'When the phone saved this version. An older or repeated upload never overwrites a newer one.';
comment on column public.rpn_onboarding_records.subscription_amount is
  'Monthly amount the RPN logged from the features the vendor took. Not a charge: the office confirms it; billing is unchanged.';

create index rpn_onboarding_records_rpn_idx on public.rpn_onboarding_records (rpn_id, last_received_at desc);
create index rpn_onboarding_records_status_idx on public.rpn_onboarding_records (status, last_received_at desc);
create index rpn_onboarding_records_vendor_idx on public.rpn_onboarding_records (vendor_id) where vendor_id is not null;


-- 2. RLS + grants ------------------------------------------------------
alter table public.rpn_onboarding_records enable row level security;

revoke all on table public.rpn_onboarding_records from public, anon, authenticated;
grant select on table public.rpn_onboarding_records to authenticated;

create policy rpn_onboarding_records_select_own on public.rpn_onboarding_records
  for select to authenticated
  using (public.cl_jwt_user_type() = 'rpn' and rpn_id = public.cl_jwt_sub());
-- No INSERT/UPDATE/DELETE grants or policies: writes only through the
-- SECURITY DEFINER functions below.


-- 3. The RPN's write -----------------------------------------------------
-- Returns {id, status, result, office_reason, verified_at, client_saved_at}
-- result: 'saved' (created or updated), 'submitted', 'unchanged' (this copy
-- was already there, or an older one arrived after a newer one).
create function public.cl_rpn_save_onboarding(
  p_id uuid,
  p_note_id uuid,
  p_business_name text,
  p_owner_name text,
  p_phone text,
  p_city text,
  p_plan text,
  p_branches integer,
  p_tills integer,
  p_subscription_amount numeric,
  p_features_taken text,
  p_sections jsonb,
  p_client_saved_at timestamptz,
  p_submit boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_rpn  uuid := cl_jwt_sub();
  v_row  rpn_onboarding_records%rowtype;
  v_result text;
  t jsonb;
begin
  if not (cl_jwt_user_type() = 'rpn' and v_rpn is not null) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_id is null or p_client_saved_at is null then
    raise exception 'id and client_saved_at are required' using errcode = '22023';
  end if;
  if p_sections is null or jsonb_typeof(p_sections) <> 'object' then
    raise exception 'sections must be an object' using errcode = '22023';
  end if;
  if p_note_id is not null and not exists (select 1 from rpn_onboarding_notes where id = p_note_id and rpn_id = v_rpn) then
    raise exception 'That onboarding note is not one of yours' using errcode = '42501';
  end if;

  select * into v_row from rpn_onboarding_records where id = p_id for update;

  if found then
    if v_row.rpn_id <> v_rpn then
      raise exception 'Not authorized' using errcode = '42501';
    end if;
    -- The same copy again (a retry whose answer was lost), or an older copy:
    -- nothing changes, the current state goes back to the phone.
    if p_client_saved_at <= v_row.client_saved_at then
      return json_build_object('id', v_row.id, 'status', v_row.status, 'result', 'unchanged',
        'office_reason', v_row.office_reason, 'verified_at', v_row.verified_at, 'client_saved_at', v_row.client_saved_at);
    end if;
    if v_row.status not in ('draft', 'returned') then
      raise exception 'This onboarding is % and can no longer be changed', v_row.status using errcode = '55000';
    end if;
  end if;

  if p_submit then
    t := p_sections -> 'training';
    if p_plan is null or p_branches is null or p_tills is null or p_subscription_amount is null then
      raise exception 'To submit, the plan, branches, tills and monthly amount are needed' using errcode = '23514';
    end if;
    if not (p_sections ? 'vendor' and p_sections ? 'installation' and p_sections ? 'implementation' and p_sections ? 'training') then
      raise exception 'To submit, all four sections are needed' using errcode = '23514';
    end if;
    if coalesce(t ->> 'vendor_confirms', '') <> 'true' or coalesce(t ->> 'rpn_declares', '') <> 'true'
       or length(btrim(coalesce(t ->> 'vendor_full_name', ''))) = 0 then
      raise exception 'To submit, the vendor''s acceptance and your declaration are needed' using errcode = '23514';
    end if;
  end if;

  if not found then
    insert into rpn_onboarding_records (id, rpn_id, note_id, business_name, owner_name, phone, city, plan, branches, tills,
      subscription_amount, features_taken, sections, status, client_saved_at, submitted_at)
    values (p_id, v_rpn, p_note_id, btrim(p_business_name), btrim(p_owner_name), p_phone, btrim(p_city), p_plan, p_branches, p_tills,
      p_subscription_amount, nullif(btrim(coalesce(p_features_taken, '')), ''), p_sections,
      case when p_submit then 'submitted' else 'draft' end, p_client_saved_at,
      case when p_submit then now() end)
    returning * into v_row;
  else
    update rpn_onboarding_records set
      note_id = p_note_id, business_name = btrim(p_business_name), owner_name = btrim(p_owner_name), phone = p_phone,
      city = btrim(p_city), plan = p_plan, branches = p_branches, tills = p_tills,
      subscription_amount = p_subscription_amount, features_taken = nullif(btrim(coalesce(p_features_taken, '')), ''),
      sections = p_sections, client_saved_at = p_client_saved_at, last_received_at = now(),
      status = case when p_submit then 'submitted' else status end,
      submitted_at = case when p_submit then now() else submitted_at end
    where id = p_id
    returning * into v_row;
  end if;

  v_result := case when p_submit then 'submitted' else 'saved' end;
  return json_build_object('id', v_row.id, 'status', v_row.status, 'result', v_result,
    'office_reason', v_row.office_reason, 'verified_at', v_row.verified_at, 'client_saved_at', v_row.client_saved_at);
end;
$fn$;

revoke execute on function public.cl_rpn_save_onboarding(uuid, uuid, text, text, text, text, text, integer, integer, numeric, text, jsonb, timestamptz, boolean) from public, anon;
grant execute on function public.cl_rpn_save_onboarding(uuid, uuid, text, text, text, text, text, integer, integer, numeric, text, jsonb, timestamptz, boolean) to authenticated;


-- 4. Staff read path (Console) -----------------------------------------
create function public.cl_list_onboarding_records(p_status text default null)
returns table (
  id uuid, status text, rpn_id uuid, rpn_name text, note_id uuid,
  business_name text, owner_name text, phone text, city text,
  plan text, branches integer, tills integer, subscription_amount numeric, subscription_currency text, features_taken text,
  sections jsonb, client_saved_at timestamptz, first_received_at timestamptz, last_received_at timestamptz, submitted_at timestamptz,
  note_vendor_id uuid,
  vendor_id uuid, vendor_business_name text, vendor_status text,
  payment_entry_id uuid, payment_amount numeric, payment_currency text, payment_date timestamptz,
  office_checks jsonb, office_reason text, verified_at timestamptz, verified_by_name text,
  commission_eligible boolean
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not (cl_jwt_user_type() = 'staff' and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors'))) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select o.id, o.status, o.rpn_id, r.full_name, o.note_id,
           o.business_name, o.owner_name, o.phone, o.city,
           o.plan, o.branches, o.tills, o.subscription_amount, o.subscription_currency, o.features_taken,
           o.sections, o.client_saved_at, o.first_received_at, o.last_received_at, o.submitted_at,
           n.vendor_id,
           o.vendor_id, v.business_name, v.status,
           o.payment_entry_id, l.amount, l.currency, l.created_at,
           o.office_checks, o.office_reason, o.verified_at, s.full_name,
           (o.payment_entry_id is not null)
      from rpn_onboarding_records o
      join cl_rpn r on r.id = o.rpn_id
      left join rpn_onboarding_notes n on n.id = o.note_id
      left join cl_vendors v on v.id = o.vendor_id
      left join cl_ledger_entries l on l.id = o.payment_entry_id
      left join cl_staff s on s.id = o.verified_by
     -- no filter: everything except drafts (work the RPN hasn't submitted);
     -- a status, including 'draft': just that status
     where (p_status is null and o.status <> 'draft') or o.status = p_status
     order by coalesce(o.submitted_at, o.last_received_at) desc;
end;
$fn$;

revoke execute on function public.cl_list_onboarding_records(text) from public, anon;
grant execute on function public.cl_list_onboarding_records(text) to authenticated;


-- 5. The office decision (Section 5) ------------------------------------
-- p_outcome: 'approved' | 'returned' | 'rejected'
--   approved: needs a Vendors Register row (p_vendor_id, or the one the
--             record already has, or the one its onboarding note was linked
--             to). A first payment may be linked: it must be a 'payment'
--             entry of that same vendor. Display only — no commission is
--             calculated or posted here.
--   returned / rejected: need a reason, which the RPN sees.
-- p_checks: the office's ticks, e.g. {"vendor_contacted":true,
--   "details_match":true,"plan_confirmed":true}
create function public.cl_verify_onboarding(
  p_id uuid,
  p_outcome text,
  p_reason text default null,
  p_checks jsonb default '{}'::jsonb,
  p_vendor_id uuid default null,
  p_payment_entry_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_staff uuid := cl_jwt_sub();
  v_row   rpn_onboarding_records%rowtype;
  v_vendor uuid;
  v_pay   cl_ledger_entries%rowtype;
begin
  if not (cl_jwt_user_type() = 'staff' and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors'))) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('approved', 'returned', 'rejected') then
    raise exception 'Outcome must be approved, returned or rejected' using errcode = '22023';
  end if;
  if p_checks is not null and jsonb_typeof(p_checks) <> 'object' then
    raise exception 'checks must be an object' using errcode = '22023';
  end if;

  select * into v_row from rpn_onboarding_records where id = p_id for update;
  if not found then
    raise exception 'Onboarding record not found';
  end if;
  if v_row.status <> 'submitted' then
    raise exception 'Only a submitted onboarding can be verified (this one is %)', v_row.status using errcode = '55000';
  end if;
  if p_outcome in ('returned', 'rejected') and length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is needed to return or reject an onboarding' using errcode = '23514';
  end if;

  v_vendor := coalesce(p_vendor_id, v_row.vendor_id,
                       (select n.vendor_id from rpn_onboarding_notes n where n.id = v_row.note_id));
  if v_vendor is not null and not exists (select 1 from cl_vendors where id = v_vendor) then
    raise exception 'Vendor not found';
  end if;
  if p_outcome = 'approved' and v_vendor is null then
    raise exception 'To approve, link the onboarding to a vendor in the Vendors Register' using errcode = '23514';
  end if;
  if p_payment_entry_id is not null then
    if p_outcome <> 'approved' then
      raise exception 'A payment is linked only when approving' using errcode = '22023';
    end if;
    select * into v_pay from cl_ledger_entries where id = p_payment_entry_id;
    if not found or v_pay.entry_type <> 'payment' or v_pay.vendor_id <> v_vendor then
      raise exception 'That is not a payment by this vendor' using errcode = '23514';
    end if;
  end if;

  update rpn_onboarding_records set
    status = p_outcome,
    vendor_id = v_vendor,
    payment_entry_id = p_payment_entry_id,
    office_checks = coalesce(p_checks, '{}'::jsonb),
    office_reason = nullif(btrim(coalesce(p_reason, '')), ''),
    verified_by = v_staff,
    verified_at = now()
  where id = p_id
  returning * into v_row;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'onboarding_record_' || p_outcome, 'rpn_onboarding_records', v_row.id,
          json_build_object('rpn_id', v_row.rpn_id, 'vendor_id', v_row.vendor_id, 'business_name', v_row.business_name,
                            'payment_entry_id', v_row.payment_entry_id, 'reason', v_row.office_reason)::jsonb);

  return json_build_object('id', v_row.id, 'status', v_row.status, 'vendor_id', v_row.vendor_id,
    'payment_entry_id', v_row.payment_entry_id, 'commission_eligible', v_row.payment_entry_id is not null);
end;
$fn$;

revoke execute on function public.cl_verify_onboarding(uuid, text, text, jsonb, uuid, uuid) from public, anon;
grant execute on function public.cl_verify_onboarding(uuid, text, text, jsonb, uuid, uuid) to authenticated;
