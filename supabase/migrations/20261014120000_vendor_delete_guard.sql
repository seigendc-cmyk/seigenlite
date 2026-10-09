-- =====================================================================
-- Vendor-delete guard (owner's decisions, 2026-10-09, "go Guard-B"):
-- deleting a vendor, business or till can no longer take its money or
-- licence history with it; archive instead. Applied live only after the
-- owner has seen this file and said "apply".
-- Design: docs/database/vendor-delete-guard.md
-- Rollback: supabase/rollbacks/20261014120000_vendor_delete_guard.rollback.sql
-- Tested in PGlite: supabase/tests/vendor-delete-guard-test.js
--
-- 1. Six foreign keys now REFUSE the delete instead of deleting or
--    unlinking the child rows:
--      cl_ledger_entries.vendor_id, cl_activation_codes.vendor_id,
--      cl_vendor_messages.vendor_id          (were ON DELETE CASCADE)
--      cl_licences.vendor_id / business_id / terminal_id   (were SET NULL)
-- 2. A plain message first: BEFORE DELETE triggers on cl_vendors and
--    cl_businesses say what the row still has and to archive it instead
--    (also in the Supabase dashboard). A vendor or business with no
--    history can still be deleted.
-- 3. Archive: archived_at / archived_by / archive_reason on cl_vendors and
--    cl_businesses; staff RPCs cl_vendor_archive / cl_vendor_unarchive /
--    cl_business_archive / cl_business_unarchive (Vendors Register or
--    SysAdmin, reason required) and cl_archive_state (read). Archiving
--    changes nothing else: an archived vendor's device keeps checking in,
--    its ledger and licences stay as they are.
-- 4. Every delete and every archive / unarchive is written to
--    cl_activity_log by triggers: who (the staff member, or the database
--    role when deleted in the dashboard) and a snapshot (never the shop
--    secret phrase).
-- 5. anon and authenticated lose TRUNCATE, TRIGGER and REFERENCES on every
--    cl_ table (TRUNCATE skips row-level security). SELECT, INSERT, UPDATE
--    and DELETE are unchanged, still behind row-level security.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare conflicts text; missing text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'column cl_vendors.archived_at' n where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cl_vendors' and column_name = 'archived_at')
    union all select 'column cl_businesses.archived_at' where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cl_businesses' and column_name = 'archived_at')
    union all select 'function cl_vendor_archive' where exists (select 1 from pg_proc where proname = 'cl_vendor_archive' and pronamespace = 'public'::regnamespace)
  ) x;
  if conflicts is not null then raise exception 'vendor_delete_guard aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'table cl_plan_assignments (20261013120000)' n where to_regclass('public.cl_plan_assignments') is null
    union all select 'constraint ' || c from unnest(array['cl_ledger_entries_vendor_id_fkey', 'cl_activation_codes_vendor_id_fkey', 'cl_vendor_messages_vendor_id_fkey',
                        'cl_licences_vendor_id_fkey', 'cl_licences_business_id_fkey', 'cl_licences_terminal_id_fkey']) c
      where c not in (select conname from pg_constraint where connamespace = 'public'::regnamespace)
  ) x;
  if missing is not null then raise exception 'vendor_delete_guard aborted: missing: %. Nothing was changed.', missing; end if;
end $$;

-- 1. Refuse instead of delete / unlink -----------------------------------
alter table public.cl_ledger_entries drop constraint cl_ledger_entries_vendor_id_fkey;
alter table public.cl_ledger_entries add constraint cl_ledger_entries_vendor_id_fkey
  foreign key (vendor_id) references public.cl_vendors(id) on delete restrict;
alter table public.cl_activation_codes drop constraint cl_activation_codes_vendor_id_fkey;
alter table public.cl_activation_codes add constraint cl_activation_codes_vendor_id_fkey
  foreign key (vendor_id) references public.cl_vendors(id) on delete restrict;
alter table public.cl_vendor_messages drop constraint cl_vendor_messages_vendor_id_fkey;
alter table public.cl_vendor_messages add constraint cl_vendor_messages_vendor_id_fkey
  foreign key (vendor_id) references public.cl_vendors(id) on delete restrict;
alter table public.cl_licences drop constraint cl_licences_vendor_id_fkey;
alter table public.cl_licences add constraint cl_licences_vendor_id_fkey
  foreign key (vendor_id) references public.cl_vendors(id) on delete restrict;
alter table public.cl_licences drop constraint cl_licences_business_id_fkey;
alter table public.cl_licences add constraint cl_licences_business_id_fkey
  foreign key (business_id) references public.cl_businesses(id) on delete restrict;
alter table public.cl_licences drop constraint cl_licences_terminal_id_fkey;
alter table public.cl_licences add constraint cl_licences_terminal_id_fkey
  foreign key (terminal_id) references public.cl_terminals(id) on delete restrict;

-- 2. Archive columns -----------------------------------------------------
alter table public.cl_vendors
  add column archived_at timestamptz,
  add column archived_by uuid references public.cl_staff(id),
  add column archive_reason text,
  add constraint cl_vendors_archive_shape check ((archived_at is null) = (archive_reason is null));
alter table public.cl_businesses
  add column archived_at timestamptz,
  add column archived_by uuid references public.cl_staff(id),
  add column archive_reason text,
  add constraint cl_businesses_archive_shape check ((archived_at is null) = (archive_reason is null));

-- 3. Who is acting: the signed-in staff member, if any ------------------
create function public.cl_acting_staff() returns uuid
language sql stable security definer set search_path = public as $$
  select s.id from cl_staff s where coalesce(cl_jwt_user_type() = 'staff', false) and s.id = cl_jwt_sub()
$$;

-- 4. Plain refusals before the foreign keys -------------------------------
create function public.cl_vendor_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare parts text[] := '{}'; n integer;
begin
  select count(*) into n from cl_ledger_entries where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' ledger entr' || case when n = 1 then 'y' else 'ies' end); end if;
  select count(*) into n from cl_licences where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' licence' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_activation_codes where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' activation code' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_vendor_messages where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' billing message' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_terminals where vendor_id = old.id or install_id = old.install_id;
  if n > 0 then parts := parts || (n || ' till' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_plan_assignments where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' price-plan setting' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_businesses where created_by_vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' business' || case when n = 1 then '' else 'es' end || ' it created'); end if;
  select count(*) into n from vendors where install_id = old.install_id;
  if n > 0 then parts := parts || ('an iTred Market Place listing account'::text); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead (Console → Vendors → Archive). Nothing was deleted.',
      old.business_name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

create function public.cl_business_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare parts text[] := '{}'; n integer;
begin
  select count(*) into n from cl_branches where business_id = old.id;
  if n > 0 then parts := parts || (n || ' branch' || case when n = 1 then '' else 'es' end); end if;
  select count(*) into n from cl_terminals where business_id = old.id;
  if n > 0 then parts := parts || (n || ' till' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_licences where business_id = old.id;
  if n > 0 then parts := parts || (n || ' licence' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_plan_assignments where business_id = old.id;
  if n > 0 then parts := parts || (n || ' price-plan setting' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_catalogue_products where business_id = old.id;
  if n > 0 then parts := parts || (n || ' catalogue product' || case when n = 1 then '' else 's' end); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

create trigger cl_vendors_delete_guard before delete on public.cl_vendors
  for each row execute function public.cl_vendor_delete_guard();
create trigger cl_businesses_delete_guard before delete on public.cl_businesses
  for each row execute function public.cl_business_delete_guard();

-- 5. Log every delete and every archive change ----------------------------
-- A snapshot of what was deleted; never shop_secret_phrase.
create function public.cl_log_vendor_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_acting_staff(); v_note text := nullif(current_setting('cl.archive_note', true), '');
begin
  if tg_op = 'DELETE' then
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'vendor_deleted', 'cl_vendors', old.id,
            jsonb_build_object('business_name', old.business_name, 'owner_name', old.owner_name, 'install_id', old.install_id,
                               'status', old.status, 'business_id', old.business_id, 'city', old.city, 'created_at', old.created_at,
                               'archived_at', old.archived_at, 'db_role', current_user));
    return old;
  end if;
  if old.archived_at is null and new.archived_at is not null then
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'vendor_archived', 'cl_vendors', new.id,
            jsonb_build_object('business_name', new.business_name, 'install_id', new.install_id, 'reason', new.archive_reason, 'db_role', current_user));
  elsif old.archived_at is not null and new.archived_at is null then
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'vendor_unarchived', 'cl_vendors', new.id,
            jsonb_build_object('business_name', new.business_name, 'install_id', new.install_id, 'reason', v_note,
                               'was_archived_at', old.archived_at, 'was_reason', old.archive_reason, 'db_role', current_user));
  end if;
  return new;
end $fn$;

create function public.cl_log_business_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_acting_staff(); v_note text := nullif(current_setting('cl.archive_note', true), '');
begin
  if tg_op = 'DELETE' then
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'business_deleted', 'cl_businesses', old.id,
            jsonb_build_object('name', old.name, 'created_by_vendor_id', old.created_by_vendor_id, 'created_ts', old.created_ts,
                               'archived_at', old.archived_at, 'db_role', current_user));
    return old;
  end if;
  if old.archived_at is null and new.archived_at is not null then
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'business_archived', 'cl_businesses', new.id,
            jsonb_build_object('name', new.name, 'reason', new.archive_reason, 'db_role', current_user));
  elsif old.archived_at is not null and new.archived_at is null then
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'business_unarchived', 'cl_businesses', new.id,
            jsonb_build_object('name', new.name, 'reason', v_note, 'was_archived_at', old.archived_at,
                               'was_reason', old.archive_reason, 'db_role', current_user));
  end if;
  return new;
end $fn$;

create trigger cl_vendors_log_delete after delete on public.cl_vendors
  for each row execute function public.cl_log_vendor_change();
create trigger cl_vendors_log_archive after update of archived_at on public.cl_vendors
  for each row when (old.archived_at is distinct from new.archived_at) execute function public.cl_log_vendor_change();
create trigger cl_businesses_log_delete after delete on public.cl_businesses
  for each row execute function public.cl_log_business_change();
create trigger cl_businesses_log_archive after update of archived_at on public.cl_businesses
  for each row when (old.archived_at is distinct from new.archived_at) execute function public.cl_log_business_change();

-- 6. Staff RPCs: archive / unarchive / read --------------------------------
create function public.cl_archive_staff() returns uuid
language plpgsql stable security definer set search_path = public as $fn$
declare v_staff uuid := cl_acting_staff();
begin
  if v_staff is null or not exists (select 1 from cl_staff where id = v_staff and active)
     or not (cl_jwt_is_sysadmin() or cl_has_module_access('vendors')) then
    raise exception 'Not authorized: needs the Vendors Register permission' using errcode = '42501';
  end if;
  return v_staff;
end $fn$;

create function public.cl_archive_reason(p_reason text) returns text
language plpgsql immutable as $fn$
declare v text := btrim(coalesce(p_reason, ''));
begin
  if length(v) < 3 then raise exception 'Give a reason (at least 3 characters)'; end if;
  if length(v) > 300 then raise exception 'Keep the reason under 300 characters'; end if;
  return v;
end $fn$;

create function public.cl_vendor_archive(p_vendor_id uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_archive_staff(); v_reason text := cl_archive_reason(p_reason); v cl_vendors%rowtype;
begin
  select * into v from cl_vendors where id = p_vendor_id for update;
  if not found then raise exception 'No such vendor'; end if;
  if v.archived_at is not null then
    raise exception '"%" is already archived (since %).', v.business_name, to_char(v.archived_at at time zone 'Africa/Harare', 'DD Mon YYYY HH24:MI');
  end if;
  update cl_vendors set archived_at = now(), archived_by = v_staff, archive_reason = v_reason where id = p_vendor_id returning * into v;
  return json_build_object('id', v.id, 'business_name', v.business_name, 'archived_at', v.archived_at, 'archive_reason', v.archive_reason);
end $fn$;

create function public.cl_vendor_unarchive(p_vendor_id uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_archive_staff(); v_reason text := cl_archive_reason(p_reason); v cl_vendors%rowtype;
begin
  select * into v from cl_vendors where id = p_vendor_id for update;
  if not found then raise exception 'No such vendor'; end if;
  if v.archived_at is null then raise exception '"%" is not archived.', v.business_name; end if;
  perform set_config('cl.archive_note', v_reason, true);
  update cl_vendors set archived_at = null, archived_by = null, archive_reason = null where id = p_vendor_id returning * into v;
  perform set_config('cl.archive_note', '', true);
  return json_build_object('id', v.id, 'business_name', v.business_name, 'archived_at', null);
end $fn$;

create function public.cl_business_archive(p_business_id uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_archive_staff(); v_reason text := cl_archive_reason(p_reason); b cl_businesses%rowtype;
begin
  select * into b from cl_businesses where id = p_business_id for update;
  if not found then raise exception 'No such business'; end if;
  if b.archived_at is not null then
    raise exception '"%" is already archived (since %).', b.name, to_char(b.archived_at at time zone 'Africa/Harare', 'DD Mon YYYY HH24:MI');
  end if;
  update cl_businesses set archived_at = now(), archived_by = v_staff, archive_reason = v_reason where id = p_business_id returning * into b;
  return json_build_object('id', b.id, 'name', b.name, 'archived_at', b.archived_at, 'archive_reason', b.archive_reason);
end $fn$;

create function public.cl_business_unarchive(p_business_id uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_archive_staff(); v_reason text := cl_archive_reason(p_reason); b cl_businesses%rowtype;
begin
  select * into b from cl_businesses where id = p_business_id for update;
  if not found then raise exception 'No such business'; end if;
  if b.archived_at is null then raise exception '"%" is not archived.', b.name; end if;
  perform set_config('cl.archive_note', v_reason, true);
  update cl_businesses set archived_at = null, archived_by = null, archive_reason = null where id = p_business_id returning * into b;
  perform set_config('cl.archive_note', '', true);
  return json_build_object('id', b.id, 'name', b.name, 'archived_at', null);
end $fn$;

-- Archived vendors and businesses, for the Console (which can't read
-- cl_businesses directly). Same people who can see the price-plan accounts.
create function public.cl_archive_state() returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not cl_plan_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return json_build_object(
    'vendors', coalesce((select json_agg(json_build_object('id', v.id, 'archived_at', v.archived_at, 'archive_reason', v.archive_reason,
                                                           'archived_by_name', s.full_name) order by v.archived_at desc)
                         from cl_vendors v left join cl_staff s on s.id = v.archived_by where v.archived_at is not null), '[]'::json),
    'businesses', coalesce((select json_agg(json_build_object('id', b.id, 'name', b.name, 'archived_at', b.archived_at, 'archive_reason', b.archive_reason,
                                                              'archived_by_name', s.full_name) order by b.archived_at desc)
                            from cl_businesses b left join cl_staff s on s.id = b.archived_by where b.archived_at is not null), '[]'::json));
end $fn$;

revoke all on function public.cl_acting_staff(), public.cl_vendor_delete_guard(), public.cl_business_delete_guard(),
  public.cl_log_vendor_change(), public.cl_log_business_change(), public.cl_archive_staff(), public.cl_archive_reason(text)
  from public, anon, authenticated;
revoke all on function public.cl_vendor_archive(uuid, text), public.cl_vendor_unarchive(uuid, text),
  public.cl_business_archive(uuid, text), public.cl_business_unarchive(uuid, text), public.cl_archive_state()
  from public, anon, authenticated;
grant execute on function public.cl_vendor_archive(uuid, text), public.cl_vendor_unarchive(uuid, text),
  public.cl_business_archive(uuid, text), public.cl_business_unarchive(uuid, text), public.cl_archive_state()
  to authenticated;

-- 7. No TRUNCATE / TRIGGER / REFERENCES for the public roles on cl_ tables --
do $$
declare t text;
begin
  for t in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname like 'cl\_%' order by 1 loop
    execute format('revoke truncate, trigger, references on table public.%I from anon, authenticated', t);
  end loop;
end $$;

commit;
