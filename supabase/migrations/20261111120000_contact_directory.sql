-- =====================================================================
-- Contact directory (owner decision 10, 20 Oct 2026; Batch 6A Part 1).
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261111120000_contact_directory.rollback.sql
-- Tested in PGlite: supabase/tests/contact-directory-test.js
--
-- seiGEN's numbers are not hard-coded: they live here and are managed from
-- the Console ("Contact directory" page, the new "Manage contact directory"
-- module; every change logged in cl_activity_log). Desks can be added; each
-- desk has several numbers, each with a label, Call on/off, WhatsApp on/off,
-- an order and active/inactive. Nothing is deleted: a desk or number is
-- switched off instead. iTred Contact Us reads the active ones
-- (cl_contact_directory, anyone) and keeps a copy for offline use.
-- Starting data: Queries Desk +263 774 479 121; Sales +263 789 487 287;
-- Support +263 789 487 287; each with Call + WhatsApp.
-- No other function, grant or data changes.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'function cl_rpn_staff (20261015120000)' n where to_regprocedure('public.cl_rpn_staff(text[])') is null
    union all select 'table cl_modules' where to_regclass('public.cl_modules') is null
    union all select 'table cl_activity_log' where to_regclass('public.cl_activity_log') is null
  ) x;
  if missing is not null then raise exception 'contact_directory aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_contact_desks' n where to_regclass('public.cl_contact_desks') is not null
    union all select 'table cl_contact_numbers' where to_regclass('public.cl_contact_numbers') is not null
    union all select 'module contact_directory' where exists (select 1 from public.cl_modules where key = 'contact_directory')
    union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cl_contact_directory', 'cl_contact_directory_all', 'cl_contact_desk_save', 'cl_contact_number_save', 'cl_contact_phone')
  ) x;
  if conflicts is not null then raise exception 'contact_directory aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;

-- 1. Tables ----------------------------------------------------------------
create table public.cl_contact_desks (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 60),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.cl_staff(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.cl_staff(id) on delete set null
);
create unique index cl_contact_desks_name on public.cl_contact_desks (lower(btrim(name)));

create table public.cl_contact_numbers (
  id uuid primary key default gen_random_uuid(),
  desk_id uuid not null references public.cl_contact_desks(id) on delete restrict,
  label text not null check (length(btrim(label)) between 1 and 40),
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  call_on boolean not null default true,
  whatsapp_on boolean not null default true,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.cl_staff(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.cl_staff(id) on delete set null,
  check (call_on or whatsapp_on)
);
create index cl_contact_numbers_desk on public.cl_contact_numbers (desk_id, sort_order);

-- 2. The Console's right ------------------------------------------------------
insert into public.cl_modules (id, key, label, description, sort_order)
select gen_random_uuid(), 'contact_directory', 'Contact directory', 'Manage contact directory: the desks and numbers shown on iTred Contact Us', 60;

-- 3. Starting data ------------------------------------------------------------
with d as (
  insert into public.cl_contact_desks (name, sort_order) values ('Queries Desk', 10), ('Sales', 20), ('Support', 30)
  returning id, name
)
insert into public.cl_contact_numbers (desk_id, label, phone, sort_order)
select d.id, 'Main line', case d.name when 'Queries Desk' then '+263774479121' else '+263789487287' end, 10 from d;

-- 4. Functions ----------------------------------------------------------------
-- A number as typed ("+263 77 447 9121", "+263-774-479121") -> "+263774479121", or an error.
create function public.cl_contact_phone(p_phone text) returns text
language plpgsql immutable as $fn$
declare v text := regexp_replace(coalesce(p_phone, ''), '[\s\-().]', '', 'g');
begin
  if v !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Give the number with its country code, like +263 77 447 9121';
  end if;
  return v;
end $fn$;

-- Anyone (iTred Contact Us): the active desks that have active numbers, in order.
create function public.cl_contact_directory() returns json
language sql stable security definer set search_path = public as $fn$
  select coalesce(json_agg(json_build_object('desk', d.name, 'numbers', n.numbers) order by d.sort_order, lower(d.name)), '[]'::json)
    from cl_contact_desks d
    cross join lateral (
      select json_agg(json_build_object('label', x.label, 'phone', x.phone, 'call', x.call_on, 'whatsapp', x.whatsapp_on) order by x.sort_order, lower(x.label)) numbers
        from cl_contact_numbers x where x.desk_id = d.id and x.active
    ) n
   where d.active and n.numbers is not null;
$fn$;

-- The Console (Contact directory module): every desk and number, with ids.
create function public.cl_contact_directory_all() returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['contact_directory']);
  return coalesce((select json_agg(json_build_object('id', d.id, 'name', d.name, 'sort_order', d.sort_order, 'active', d.active, 'updated_at', d.updated_at,
      'numbers', coalesce((select json_agg(json_build_object('id', x.id, 'label', x.label, 'phone', x.phone, 'call', x.call_on, 'whatsapp', x.whatsapp_on,
                                                             'sort_order', x.sort_order, 'active', x.active, 'updated_at', x.updated_at) order by x.sort_order, lower(x.label))
                             from cl_contact_numbers x where x.desk_id = d.id), '[]'::json))
      order by d.sort_order, lower(d.name)) from cl_contact_desks d), '[]'::json);
end $fn$;

-- Add (p_desk_id null) or change a desk. Logged with what it was.
create function public.cl_contact_desk_save(p_desk_id uuid, p_name text, p_sort_order integer, p_active boolean) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['contact_directory']); v_name text := btrim(coalesce(p_name, '')); old cl_contact_desks%rowtype; r cl_contact_desks%rowtype;
begin
  if length(v_name) < 2 or length(v_name) > 60 then raise exception 'Give the desk a name of 2 to 60 characters'; end if;
  if exists (select 1 from cl_contact_desks where lower(btrim(name)) = lower(v_name) and id is distinct from p_desk_id) then
    raise exception 'There is already a desk called "%"', v_name;
  end if;
  if p_desk_id is null then
    insert into cl_contact_desks (name, sort_order, active, created_by, updated_by)
    values (v_name, coalesce(p_sort_order, 0), coalesce(p_active, true), v_staff, v_staff) returning * into r;
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'contact_desk_added', 'cl_contact_desks', r.id, jsonb_build_object('name', r.name, 'sort_order', r.sort_order, 'active', r.active));
  else
    select * into old from cl_contact_desks where id = p_desk_id for update;
    if old.id is null then raise exception 'That desk doesn''t exist'; end if;
    update cl_contact_desks set name = v_name, sort_order = coalesce(p_sort_order, old.sort_order), active = coalesce(p_active, old.active),
           updated_at = now(), updated_by = v_staff where id = p_desk_id returning * into r;
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'contact_desk_changed', 'cl_contact_desks', r.id,
            jsonb_build_object('name', r.name, 'sort_order', r.sort_order, 'active', r.active,
                               'was', jsonb_build_object('name', old.name, 'sort_order', old.sort_order, 'active', old.active)));
  end if;
  return json_build_object('ok', true, 'id', r.id);
end $fn$;

-- Add (p_number_id null) or change a number of a desk. Logged with what it was.
create function public.cl_contact_number_save(p_number_id uuid, p_desk_id uuid, p_label text, p_phone text, p_call boolean, p_whatsapp boolean,
                                              p_sort_order integer, p_active boolean) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['contact_directory']); v_label text := btrim(coalesce(p_label, '')); v_phone text;
        old cl_contact_numbers%rowtype; r cl_contact_numbers%rowtype;
begin
  if length(v_label) < 1 or length(v_label) > 40 then raise exception 'Give the number a label of up to 40 characters (e.g. Main line)'; end if;
  v_phone := cl_contact_phone(p_phone);
  if not (coalesce(p_call, false) or coalesce(p_whatsapp, false)) then raise exception 'Switch on Call, WhatsApp or both'; end if;
  if not exists (select 1 from cl_contact_desks where id = p_desk_id) then raise exception 'That desk doesn''t exist'; end if;
  if p_number_id is null then
    insert into cl_contact_numbers (desk_id, label, phone, call_on, whatsapp_on, sort_order, active, created_by, updated_by)
    values (p_desk_id, v_label, v_phone, p_call, p_whatsapp, coalesce(p_sort_order, 0), coalesce(p_active, true), v_staff, v_staff) returning * into r;
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'contact_number_added', 'cl_contact_numbers', r.id,
            jsonb_build_object('desk_id', r.desk_id, 'label', r.label, 'phone', r.phone, 'call', r.call_on, 'whatsapp', r.whatsapp_on, 'sort_order', r.sort_order, 'active', r.active));
  else
    select * into old from cl_contact_numbers where id = p_number_id for update;
    if old.id is null then raise exception 'That number doesn''t exist'; end if;
    update cl_contact_numbers set desk_id = p_desk_id, label = v_label, phone = v_phone, call_on = p_call, whatsapp_on = p_whatsapp,
           sort_order = coalesce(p_sort_order, old.sort_order), active = coalesce(p_active, old.active), updated_at = now(), updated_by = v_staff
     where id = p_number_id returning * into r;
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'contact_number_changed', 'cl_contact_numbers', r.id,
            jsonb_build_object('desk_id', r.desk_id, 'label', r.label, 'phone', r.phone, 'call', r.call_on, 'whatsapp', r.whatsapp_on, 'sort_order', r.sort_order, 'active', r.active,
                               'was', jsonb_build_object('desk_id', old.desk_id, 'label', old.label, 'phone', old.phone, 'call', old.call_on, 'whatsapp', old.whatsapp_on,
                                                         'sort_order', old.sort_order, 'active', old.active)));
  end if;
  return json_build_object('ok', true, 'id', r.id);
end $fn$;

-- 5. Who may call what ----------------------------------------------------------
alter table public.cl_contact_desks enable row level security;
alter table public.cl_contact_numbers enable row level security;
revoke all on table public.cl_contact_desks, public.cl_contact_numbers from public, anon, authenticated;
revoke all on function public.cl_contact_phone(text), public.cl_contact_directory(), public.cl_contact_directory_all(),
  public.cl_contact_desk_save(uuid, text, integer, boolean),
  public.cl_contact_number_save(uuid, uuid, text, text, boolean, boolean, integer, boolean) from public, anon, authenticated;
grant execute on function public.cl_contact_directory() to anon, authenticated;
grant execute on function public.cl_contact_directory_all(), public.cl_contact_desk_save(uuid, text, integer, boolean),
  public.cl_contact_number_save(uuid, uuid, text, text, boolean, boolean, integer, boolean) to authenticated;

commit;
