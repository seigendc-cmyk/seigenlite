-- =====================================================================
-- RPN Field Guide, Phase 4 — approved on 2026-10-03 ("go 4b").
-- Rollback: supabase/rollbacks/20261003120000_rpn_onboarding_notes.rollback.sql
-- Tested in PGlite: supabase/tests/onboarding-notes-test.js
--
-- RPN onboarding notes: what an RPN writes down about a prospective vendor
-- on a first visit, sent from the Field Guide (dist-rpn) when the RPN is
-- online and signed in with cl_login.
--
-- Built on the project's existing pieces, checked read-only against the
-- live database on 2026-10-03:
--   * identity: the cl_login JWT (role 'authenticated', user_type 'rpn',
--     sub = cl_rpn.id), read with cl_jwt_user_type() / cl_jwt_sub()
--   * staff permission: Console module access, cl_has_module_access('vendors')
--     (the Vendors Register module), sysadmins included — no new access system
--   * audit: cl_activity_log, written by the staff action (RPNs can't
--     insert there: cl_activity_log_insert is staff-only)
--
--   1. public.rpn_onboarding_notes
--        id is made on the phone (a v4 UUID), so sending the same note
--        twice can't create two rows: the second insert hits the primary
--        key and the app treats that as "already sent".
--   2. RLS: an RPN inserts and reads only their own notes; no UPDATE or
--      DELETE for anyone through the API (a sent note is a record).
--      Grants are SELECT + INSERT to authenticated only — narrower than
--      the cl_ tables, which grant everything to anon and authenticated.
--   3. cl_list_onboarding_notes(): the staff read path for the Console,
--      SECURITY DEFINER, refused unless staff with the vendors module.
--      Returns the RPN's and the vendor's names, not just ids.
--   4. cl_onboarding_note_to_vendor(): the one staff action. Either links
--      the note to an existing Vendors Register row (filling only blank
--      owner/phone/city/location/RPN) or creates a new one with status
--      'onboarding', exactly the columns the Console's "New vendor" form
--      writes. Logged to cl_activity_log. Nothing becomes a vendor
--      automatically.
--
-- cl_vendors, cl_rpn, cl_login and every existing policy are untouched.
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
    union all select 'function cl_jwt_sub()' where to_regprocedure('public.cl_jwt_sub()') is null
    union all select 'function cl_jwt_user_type()' where to_regprocedure('public.cl_jwt_user_type()') is null
    union all select 'function cl_jwt_is_sysadmin()' where to_regprocedure('public.cl_jwt_is_sysadmin()') is null
    union all select 'function cl_has_module_access(text)' where to_regprocedure('public.cl_has_module_access(text)') is null
  ) x;
  if missing is not null then
    raise exception 'rpn_onboarding_notes aborted: missing %. Nothing was changed.', missing;
  end if;
  select string_agg(n, ', ') into conflicts from (
    select 'table rpn_onboarding_notes' n where to_regclass('public.rpn_onboarding_notes') is not null
    union all select 'function cl_list_onboarding_notes' where exists (select 1 from pg_proc where proname = 'cl_list_onboarding_notes' and pronamespace = 'public'::regnamespace)
    union all select 'function cl_onboarding_note_to_vendor' where exists (select 1 from pg_proc where proname = 'cl_onboarding_note_to_vendor' and pronamespace = 'public'::regnamespace)
  ) x;
  if conflicts is not null then
    raise exception 'rpn_onboarding_notes aborted: already exists: %. Nothing was changed.', conflicts;
  end if;
end $$;


-- 1. The table ----------------------------------------------------------
create table public.rpn_onboarding_notes (
  id               uuid primary key,  -- made on the phone; no default on purpose
  rpn_id           uuid not null default public.cl_jwt_sub()
                   references public.cl_rpn(id),

  -- what becomes the Vendors Register row (cl_vendors columns)
  business_name    text not null check (length(btrim(business_name)) between 1 and 120),
  owner_name       text not null check (length(btrim(owner_name)) between 1 and 120),
  phone            text not null check (phone ~ '^\+?[0-9][0-9 ]{6,19}$'),
  city             text not null check (length(btrim(city)) between 1 and 80),
  location         text check (location is null or length(location) <= 200),
  notes            text check (notes is null or length(notes) <= 4000),

  -- preliminary notes, shown with the note in the Console
  business_type    text check (business_type is null or length(business_type) <= 80),
  record_keeping   text check (record_keeping is null or length(record_keeping) <= 200),
  approx_products  integer check (approx_products is null or approx_products between 0 and 1000000),
  devices          text check (devices is null or length(devices) <= 200),
  plan_interest    text check (plan_interest is null or length(plan_interest) <= 200),
  stocktake_needed text check (stocktake_needed is null or stocktake_needed in ('yes', 'no', 'not_sure')),

  visit_date       date not null,
  captured_at      timestamptz not null,               -- the phone's clock, when saved on the phone
  received_at      timestamptz not null default now(), -- the server's clock, when it arrived

  -- set only by cl_onboarding_note_to_vendor (staff)
  vendor_id        uuid references public.cl_vendors(id) on delete set null,
  handled_by       uuid references public.cl_staff(id),
  handled_at       timestamptz
);

comment on table public.rpn_onboarding_notes is
  'First-visit notes an RPN sends from the RPN Field Guide. Insert/read own rows only (cl_login JWT). Staff read via cl_list_onboarding_notes() and act via cl_onboarding_note_to_vendor(). Never updated or deleted through the API.';
comment on column public.rpn_onboarding_notes.id is
  'Made on the phone (v4 UUID) when the note is saved, so a retried upload of the same note is refused by the primary key instead of duplicated.';

create index rpn_onboarding_notes_rpn_idx on public.rpn_onboarding_notes (rpn_id, received_at desc);
create index rpn_onboarding_notes_open_idx on public.rpn_onboarding_notes (received_at desc) where vendor_id is null;
create index rpn_onboarding_notes_vendor_idx on public.rpn_onboarding_notes (vendor_id) where vendor_id is not null;


-- 2. RLS + grants ------------------------------------------------------
alter table public.rpn_onboarding_notes enable row level security;

revoke all on table public.rpn_onboarding_notes from public, anon, authenticated;
grant select, insert on table public.rpn_onboarding_notes to authenticated;

create policy rpn_onboarding_notes_insert_own on public.rpn_onboarding_notes
  for insert to authenticated
  with check (
    public.cl_jwt_user_type() = 'rpn'
    and rpn_id = public.cl_jwt_sub()
    and vendor_id is null and handled_by is null and handled_at is null
  );

create policy rpn_onboarding_notes_select_own on public.rpn_onboarding_notes
  for select to authenticated
  using (public.cl_jwt_user_type() = 'rpn' and rpn_id = public.cl_jwt_sub());

-- No UPDATE or DELETE policy: with RLS on, both are refused for every
-- API caller. Staff changes go through cl_onboarding_note_to_vendor().


-- 3. Staff read path (Console) -----------------------------------------
create function public.cl_list_onboarding_notes(p_include_handled boolean default false)
returns table (
  id uuid, received_at timestamptz, captured_at timestamptz, visit_date date,
  rpn_id uuid, rpn_name text,
  business_name text, owner_name text, phone text, city text, location text, notes text,
  business_type text, record_keeping text, approx_products integer, devices text,
  plan_interest text, stocktake_needed text,
  vendor_id uuid, vendor_business_name text, vendor_status text,
  handled_at timestamptz, handled_by_name text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not (cl_jwt_user_type() = 'staff' and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors'))) then
    raise exception 'Not authorized';
  end if;
  return query
    select n.id, n.received_at, n.captured_at, n.visit_date,
           n.rpn_id, r.full_name,
           n.business_name, n.owner_name, n.phone, n.city, n.location, n.notes,
           n.business_type, n.record_keeping, n.approx_products, n.devices,
           n.plan_interest, n.stocktake_needed,
           n.vendor_id, v.business_name, v.status,
           n.handled_at, s.full_name
      from rpn_onboarding_notes n
      join cl_rpn r on r.id = n.rpn_id
      left join cl_vendors v on v.id = n.vendor_id
      left join cl_staff s on s.id = n.handled_by
     where p_include_handled or n.vendor_id is null
     order by n.received_at desc;
end;
$fn$;

revoke execute on function public.cl_list_onboarding_notes(boolean) from public, anon;
grant execute on function public.cl_list_onboarding_notes(boolean) to authenticated;


-- 4. The one staff action: note -> Vendors Register ---------------------
-- p_vendor_id null: create a vendor with status 'onboarding' from the note
--   (the same columns the Console's "New vendor" form fills).
-- p_vendor_id set: link to that existing vendor (e.g. the row the shop's
--   own app created at check-in), filling only its blank owner, phone,
--   city, location and RPN — never overwriting what is there.
create function public.cl_onboarding_note_to_vendor(p_note_id uuid, p_vendor_id uuid default null)
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_staff_id uuid := cl_jwt_sub();
  v_note     rpn_onboarding_notes%rowtype;
  v_vendor   cl_vendors%rowtype;
begin
  if not (cl_jwt_user_type() = 'staff' and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors'))) then
    raise exception 'Not authorized';
  end if;

  select * into v_note from rpn_onboarding_notes where id = p_note_id for update;
  if not found then
    raise exception 'Onboarding note not found';
  end if;
  if v_note.vendor_id is not null then
    raise exception 'This note is already linked to a vendor';
  end if;

  if p_vendor_id is null then
    insert into cl_vendors (business_name, owner_name, phone, city, location, rpn_id, notes, status, created_by)
    values (btrim(v_note.business_name), btrim(v_note.owner_name), v_note.phone, btrim(v_note.city),
            v_note.location, v_note.rpn_id, v_note.notes, 'onboarding', v_staff_id)
    returning * into v_vendor;
  else
    update cl_vendors set
      owner_name = coalesce(owner_name, btrim(v_note.owner_name)),
      phone      = coalesce(phone, v_note.phone),
      city       = coalesce(city, btrim(v_note.city)),
      location   = coalesce(location, v_note.location),
      rpn_id     = coalesce(rpn_id, v_note.rpn_id)
    where id = p_vendor_id
    returning * into v_vendor;
    if not found then
      raise exception 'Vendor not found';
    end if;
  end if;

  update rpn_onboarding_notes
     set vendor_id = v_vendor.id, handled_by = v_staff_id, handled_at = now()
   where id = p_note_id;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff_id, case when p_vendor_id is null then 'onboarding_note_new_vendor' else 'onboarding_note_link_vendor' end,
          'cl_vendors', v_vendor.id,
          json_build_object('note_id', p_note_id, 'rpn_id', v_note.rpn_id, 'business_name', v_note.business_name));

  return json_build_object('vendor_id', v_vendor.id, 'business_name', v_vendor.business_name, 'status', v_vendor.status);
end;
$fn$;

revoke execute on function public.cl_onboarding_note_to_vendor(uuid, uuid) from public, anon;
grant execute on function public.cl_onboarding_note_to_vendor(uuid, uuid) to authenticated;
