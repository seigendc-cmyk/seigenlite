-- =====================================================================
-- RPN <-> vendor link and RPN commissions (owner's decisions, 2026-10-09,
-- "go RPN-B"). Applied live only after the owner has seen this file and
-- said "apply".
-- Design: docs/rpn/rpn-commissions-design.md
-- Rollback: supabase/rollbacks/20261015120000_rpn_commissions.rollback.sql
-- Tested in PGlite: supabase/tests/rpn-commissions-test.js
--
-- 1. RPN identity: cl_rpn.field_force_no ("RPN-014", typed by staff) and a
--    6-digit RPN PIN (bcrypt, in cl_rpn_pins, which nobody can read through
--    the API). Staff set both, and suspend / reactivate, in the RPN
--    Directory (rpn_directory module or SysAdmin).
-- 2. The link: a business's RPN on cl_businesses.rpn_id; a single device's
--    on cl_vendors.rpn_id (as today). The vendor's app links with
--    cl_device_link_rpn (install ID + phrase + device key, field force
--    number + PIN; 5 failed tries per install per hour); a till entering a
--    different RPN for its business makes a conflict for staff. Every change
--    of either column, by any path, is written to cl_rpn_assignments.
-- 3. Commission rates (onboarding %, recurring %), effective from, with
--    history: SysAdmin only. Seeded empty.
-- 4. Accrual: an AFTER INSERT trigger on cl_ledger_entries. Each payment
--    earns its account's RPN (the business's, else the device's) a line at
--    the rate in effect: onboarding if the account has no other payment that
--    still stands, else recurring; 0% "no rate" while no rate is set; no
--    line without an active RPN. A payment reversal makes the matching
--    negative line. Charges and credits earn nothing. No payment function
--    is changed.
-- 5. Payouts: cl_pay_rpn_commission (never above what is due) posts a
--    Cashbook OUT on the paying account (source 'rpn_commission_payout');
--    cl_reverse_rpn_payout puts it back. 30-second duplicate guard.
-- 6. New modules: rpn_commissions (see), rpn_payouts (pay). Reassigning
--    an RPN: Vendors Register or RPN Directory. Rates: SysAdmin.
-- 7. Security: RPNs can no longer read cl_vendors rows (they could read
--    every column of their vendors, shop_secret_phrase and device_key
--    included) and can no longer update their own cl_rpn row (they could
--    change active, verification_code, ...).
-- 8. The vendor and business delete guards also count commission lines and
--    RPN history; the new tables refuse deletes (RESTRICT).
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_rpn_commissions' n where to_regclass('public.cl_rpn_commissions') is not null
    union all select 'column cl_rpn.field_force_no' where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cl_rpn' and column_name = 'field_force_no')
    union all select 'column cl_businesses.rpn_id' where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cl_businesses' and column_name = 'rpn_id')
    union all select 'module ' || k from unnest(array['rpn_commissions', 'rpn_payouts']) k where k in (select key from cl_modules)
  ) x;
  if conflicts is not null then raise exception 'rpn_commissions aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'function cl_acting_staff (20261014120000)' n where to_regprocedure('public.cl_acting_staff()') is null
    union all select 'function cl_install_vendor' where to_regprocedure('public.cl_install_vendor(text,text,text,boolean,text,text)') is null
    union all select 'policy ' || p from unnest(array['cl_vendors_select', 'cl_rpn_update_self']) p
      where p not in (select polname from pg_policy where polrelid in ('public.cl_vendors'::regclass, 'public.cl_rpn'::regclass))
    union all select 'constraint cl_cashbook_entries_source_type_check (20261012120000)'
      where not exists (select 1 from pg_constraint where conname = 'cl_cashbook_entries_source_type_check'
                          and pg_get_constraintdef(oid) = 'CHECK ((source_type = ANY (ARRAY[''ledger_payment''::text, ''voucher''::text, ''manual''::text, ''ledger_payment_reversal''::text])))')
  ) x;
  if missing is not null then raise exception 'rpn_commissions aborted: missing %. Nothing was changed.', missing; end if;
end $$;

-- 1. RPN identity --------------------------------------------------------
alter table public.cl_rpn add column field_force_no text,
  add constraint cl_rpn_field_force_no_shape check (field_force_no is null or field_force_no ~ '^RPN-[0-9]{2,6}$');
create unique index cl_rpn_field_force_no_uidx on public.cl_rpn (field_force_no);

-- The PIN hash lives apart from cl_rpn, so nobody reads it through the API
-- (not even staff who can read cl_rpn).
create table public.cl_rpn_pins (
  rpn_id   uuid primary key references public.cl_rpn(id) on delete restrict,
  pin_hash text not null,
  set_by   uuid references public.cl_staff(id),
  set_at   timestamptz not null default now()
);
create table public.cl_rpn_link_failures (
  id             bigint generated always as identity primary key,
  install_id     text not null,
  field_force_no text,
  created_at     timestamptz not null default now()
);
create index cl_rpn_link_failures_recent_idx on public.cl_rpn_link_failures (install_id, created_at);

-- 2. The link and its history --------------------------------------------
alter table public.cl_businesses add column rpn_id uuid references public.cl_rpn(id) on delete restrict;

create table public.cl_rpn_assignments (
  id                bigint generated always as identity primary key,
  vendor_id         uuid references public.cl_vendors(id) on delete restrict,
  business_id       uuid references public.cl_businesses(id) on delete restrict,
  rpn_id            uuid references public.cl_rpn(id) on delete restrict,
  previous_rpn_id   uuid references public.cl_rpn(id) on delete restrict,
  source            text not null check (source in ('app', 'console', 'conflict', 'register_form', 'onboarding_note', 'database')),
  status            text not null check (status in ('applied', 'conflict', 'accepted', 'rejected')),
  reason            text,
  by_staff          uuid references public.cl_staff(id),
  by_install        text,
  created_at        timestamptz not null default now(),
  resolved_by       uuid references public.cl_staff(id),
  resolved_at       timestamptz,
  resolution_reason text,
  constraint cl_rpn_assignments_target check ((vendor_id is null) <> (business_id is null))
);
create index cl_rpn_assignments_vendor_idx on public.cl_rpn_assignments (vendor_id);
create index cl_rpn_assignments_business_idx on public.cl_rpn_assignments (business_id);

-- The business a vendor row belongs to: its till's business, else its own.
create function public.cl_vendor_business(p_vendor_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce((select te.business_id from cl_terminals te join cl_vendors v on v.install_id = te.install_id
                    where v.id = p_vendor_id and te.business_id is not null limit 1),
                  (select v.business_id from cl_vendors v where v.id = p_vendor_id))
$$;
-- The RPN of a vendor row: its business's, else its own.
create function public.cl_rpn_of_vendor(p_vendor_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce((select b.rpn_id from cl_businesses b where b.id = cl_vendor_business(p_vendor_id)),
                  (select v.rpn_id from cl_vendors v where v.id = p_vendor_id))
$$;

-- Every change of cl_vendors.rpn_id / cl_businesses.rpn_id, by any path.
-- The path sets cl.rpn_source / cl.rpn_note / cl.rpn_install for the
-- transaction; a plain table write from the Console is 'register_form'.
create function public.cl_log_rpn_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_acting_staff();
        v_source text := nullif(current_setting('cl.rpn_source', true), '');
begin
  if v_source is null then v_source := case when v_staff is not null then 'register_form' else 'database' end; end if;
  insert into cl_rpn_assignments (vendor_id, business_id, rpn_id, previous_rpn_id, source, status, reason, by_staff, by_install)
  values (case when tg_table_name = 'cl_vendors' then new.id end, case when tg_table_name = 'cl_businesses' then new.id end,
          new.rpn_id, case when tg_op = 'UPDATE' then old.rpn_id end, v_source, 'applied',
          nullif(current_setting('cl.rpn_note', true), ''), v_staff, nullif(current_setting('cl.rpn_install', true), ''));
  return new;
end $fn$;
create trigger cl_vendors_log_rpn_insert after insert on public.cl_vendors
  for each row when (new.rpn_id is not null) execute function public.cl_log_rpn_change();
create trigger cl_vendors_log_rpn_update after update of rpn_id on public.cl_vendors
  for each row when (old.rpn_id is distinct from new.rpn_id) execute function public.cl_log_rpn_change();
create trigger cl_businesses_log_rpn_update after update of rpn_id on public.cl_businesses
  for each row when (old.rpn_id is distinct from new.rpn_id) execute function public.cl_log_rpn_change();

-- Sets the next rpn_id change's source, reason and install for this transaction.
create function public.cl_rpn_change_context(p_source text, p_note text, p_install text) returns void
language sql security definer set search_path = public as $$
  select set_config('cl.rpn_source', coalesce(p_source, ''), true), set_config('cl.rpn_note', coalesce(p_note, ''), true),
         set_config('cl.rpn_install', coalesce(p_install, ''), true);
$$;

-- 3. The vendor's app links its RPN ----------------------------------------
-- Answers with {ok, ...}; refusals are answers, not errors, so the failed
-- try is kept for the rate limit. An unknown number and a wrong PIN get the
-- same answer.
create function public.cl_device_link_rpn(p_install_id text, p_secret_phrase text, p_device_key text,
                                          p_field_force_no text, p_pin text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; r cl_rpn%rowtype; v_biz uuid; v_cur uuid; v_fails integer; v_bname text;
        v_ff text := upper(btrim(coalesce(p_field_force_no, '')));
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  perform pg_advisory_xact_lock(hashtext('cl_device_link_rpn:' || p_install_id));
  select count(*) into v_fails from cl_rpn_link_failures where install_id = p_install_id and created_at > now() - interval '1 hour';
  if v_fails >= 5 then
    return json_build_object('ok', false, 'code', 'RPN_TOO_MANY_TRIES', 'message', 'Too many tries. Wait an hour, or ask Digital Commerce.');
  end if;
  select * into r from cl_rpn where field_force_no = v_ff;
  if not found or not exists (select 1 from cl_rpn_pins p where p.rpn_id = r.id
                                and p.pin_hash = extensions.crypt(coalesce(p_pin, ''), p.pin_hash)) then
    insert into cl_rpn_link_failures (install_id, field_force_no) values (p_install_id, left(v_ff, 20));
    return json_build_object('ok', false, 'code', 'RPN_NO_MATCH', 'message', 'That field force number and PIN don''t match. Check them with your RPN.');
  end if;
  if not r.active then
    return json_build_object('ok', false, 'code', 'RPN_SUSPENDED', 'message', 'That RPN isn''t active at the moment. Ask Digital Commerce.');
  end if;

  v_biz := cl_vendor_business(v.id);
  if v_biz is not null then select b.rpn_id, b.name into v_cur, v_bname from cl_businesses b where b.id = v_biz for update;
  else v_cur := v.rpn_id; end if;
  if v_cur = r.id then
    return json_build_object('ok', true, 'status', 'already', 'rpn_name', r.full_name, 'field_force_no', r.field_force_no, 'business', v_bname);
  end if;
  if v_cur is not null then
    if not exists (select 1 from cl_rpn_assignments a where a.status = 'conflict' and a.rpn_id = r.id
                     and a.vendor_id is not distinct from (case when v_biz is null then v.id end) and a.business_id is not distinct from v_biz) then
      insert into cl_rpn_assignments (vendor_id, business_id, rpn_id, previous_rpn_id, source, status, by_install)
      values (case when v_biz is null then v.id end, v_biz, r.id, v_cur, 'app', 'conflict', p_install_id);
    end if;
    return json_build_object('ok', false, 'code', 'RPN_CONFLICT',
      'message', case when v_biz is not null then 'This business already has an RPN. Digital Commerce will check it.'
                      else 'This device already has an RPN. Digital Commerce will check it.' end);
  end if;
  perform cl_rpn_change_context('app', null, p_install_id);
  if v_biz is not null then update cl_businesses set rpn_id = r.id where id = v_biz;
  else update cl_vendors set rpn_id = r.id where id = v.id; end if;
  perform cl_rpn_change_context(null, null, null);
  return json_build_object('ok', true, 'status', 'linked', 'rpn_name', r.full_name, 'field_force_no', r.field_force_no, 'business', v_bname);
end $fn$;

-- The device's RPN as the server has it (for More → About).
create function public.cl_device_rpn_status(p_install_id text, p_secret_phrase text, p_device_key text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; v_rpn uuid; r cl_rpn%rowtype;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  v_rpn := cl_rpn_of_vendor(v.id);
  select * into r from cl_rpn where id = v_rpn;
  return json_build_object('linked', v_rpn is not null, 'rpn_name', r.full_name, 'field_force_no', r.field_force_no,
    'on_business', cl_vendor_business(v.id) is not null,
    'open_conflict', exists (select 1 from cl_rpn_assignments a where a.status = 'conflict'
                               and (a.vendor_id = v.id or a.business_id = cl_vendor_business(v.id))));
end $fn$;

-- 4. Staff: RPN Directory and assignments ----------------------------------
create function public.cl_rpn_staff(p_modules text[]) returns uuid
language plpgsql stable security definer set search_path = public as $fn$
declare v_staff uuid := cl_acting_staff();
begin
  if v_staff is null or not exists (select 1 from cl_staff where id = v_staff and active)
     or not (cl_jwt_is_sysadmin() or exists (select 1 from unnest(p_modules) m where cl_has_module_access(m))) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return v_staff;
end $fn$;

create function public.cl_rpn_reason(p_reason text) returns text
language plpgsql immutable as $fn$
declare v text := btrim(coalesce(p_reason, ''));
begin
  if length(v) < 3 then raise exception 'Give a reason (at least 3 characters)'; end if;
  if length(v) > 300 then raise exception 'Keep the reason under 300 characters'; end if;
  return v;
end $fn$;

create function public.cl_rpn_set_field_force_no(p_rpn_id uuid, p_field_force_no text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['rpn_directory']); v_ff text := upper(btrim(coalesce(p_field_force_no, ''))); r cl_rpn%rowtype;
begin
  if v_ff !~ '^RPN-[0-9]{2,6}$' then raise exception 'Use the form RPN-014 (RPN, a dash, then 2 to 6 digits)'; end if;
  select * into r from cl_rpn where id = p_rpn_id for update;
  if not found then raise exception 'No such RPN'; end if;
  if exists (select 1 from cl_rpn where field_force_no = v_ff and id <> p_rpn_id) then
    raise exception '% is already used by another RPN', v_ff;
  end if;
  update cl_rpn set field_force_no = v_ff where id = p_rpn_id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'rpn_set_field_force_no', 'cl_rpn', p_rpn_id, jsonb_build_object('rpn', r.full_name, 'from', r.field_force_no, 'to', v_ff));
  return json_build_object('id', p_rpn_id, 'field_force_no', v_ff);
end $fn$;

-- A new random 6-digit PIN, shown once to the staff member; only its hash is kept.
create function public.cl_rpn_set_pin(p_rpn_id uuid) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['rpn_directory']); r cl_rpn%rowtype; v_pin text;
begin
  select * into r from cl_rpn where id = p_rpn_id for update;
  if not found then raise exception 'No such RPN'; end if;
  v_pin := lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
  insert into cl_rpn_pins (rpn_id, pin_hash, set_by, set_at) values (p_rpn_id, extensions.crypt(v_pin, extensions.gen_salt('bf')), v_staff, now())
  on conflict (rpn_id) do update set pin_hash = excluded.pin_hash, set_by = excluded.set_by, set_at = excluded.set_at;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'rpn_set_pin', 'cl_rpn', p_rpn_id, jsonb_build_object('rpn', r.full_name));
  return json_build_object('id', p_rpn_id, 'pin', v_pin);
end $fn$;

create function public.cl_rpn_set_active(p_rpn_id uuid, p_active boolean, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['rpn_directory']); v_reason text := cl_rpn_reason(p_reason); r cl_rpn%rowtype;
begin
  select * into r from cl_rpn where id = p_rpn_id for update;
  if not found then raise exception 'No such RPN'; end if;
  if r.active = p_active then raise exception '% is already %', r.full_name, case when p_active then 'active' else 'suspended' end; end if;
  update cl_rpn set active = p_active where id = p_rpn_id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, case when p_active then 'rpn_reactivated' else 'rpn_suspended' end, 'cl_rpn', p_rpn_id,
          jsonb_build_object('rpn', r.full_name, 'reason', v_reason));
  return json_build_object('id', p_rpn_id, 'active', p_active);
end $fn$;

-- Assign, reassign or remove (p_rpn_id null) the RPN of a business or a single device.
create function public.cl_assign_rpn(p_business_id uuid, p_vendor_id uuid, p_rpn_id uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['vendors', 'rpn_directory']); v_reason text := cl_rpn_reason(p_reason);
        v_cur uuid; v_biz uuid; v_name text; r cl_rpn%rowtype;
begin
  if (p_business_id is null) = (p_vendor_id is null) then raise exception 'Give either a business or a vendor'; end if;
  if p_rpn_id is not null then
    select * into r from cl_rpn where id = p_rpn_id;
    if not found then raise exception 'No such RPN'; end if;
    if not r.active then raise exception '% is suspended. Reactivate them first.', r.full_name; end if;
  end if;
  if p_vendor_id is not null then
    select v.rpn_id, v.business_name into v_cur, v_name from cl_vendors v where v.id = p_vendor_id for update;
    if not found then raise exception 'No such vendor'; end if;
    v_biz := cl_vendor_business(p_vendor_id);
    if v_biz is not null then
      raise exception 'This device is a till of "%". Set the RPN on the business instead.', (select name from cl_businesses where id = v_biz);
    end if;
  else
    select b.rpn_id, b.name into v_cur, v_name from cl_businesses b where b.id = p_business_id for update;
    if not found then raise exception 'No such business'; end if;
  end if;
  if v_cur is not distinct from p_rpn_id then
    raise exception '"%" already has %.', v_name, coalesce(r.full_name, 'no RPN');
  end if;
  perform cl_rpn_change_context('console', v_reason, null);
  if p_vendor_id is not null then update cl_vendors set rpn_id = p_rpn_id where id = p_vendor_id;
  else update cl_businesses set rpn_id = p_rpn_id where id = p_business_id; end if;
  perform cl_rpn_change_context(null, null, null);
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'assign_rpn', case when p_vendor_id is not null then 'cl_vendors' else 'cl_businesses' end, coalesce(p_vendor_id, p_business_id),
          jsonb_build_object('name', v_name, 'from_rpn_id', v_cur, 'to_rpn_id', p_rpn_id, 'reason', v_reason));
  return json_build_object('name', v_name, 'rpn_id', p_rpn_id);
end $fn$;

create function public.cl_resolve_rpn_conflict(p_assignment_id bigint, p_accept boolean, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['vendors', 'rpn_directory']); v_reason text := cl_rpn_reason(p_reason); a cl_rpn_assignments%rowtype;
begin
  select * into a from cl_rpn_assignments where id = p_assignment_id for update;
  if not found or a.status <> 'conflict' then raise exception 'That conflict is no longer open'; end if;
  if p_accept then
    if not exists (select 1 from cl_rpn where id = a.rpn_id and active) then raise exception 'That RPN is suspended. Reactivate them first.'; end if;
    perform cl_rpn_change_context('conflict', v_reason, a.by_install);
    if a.vendor_id is not null then update cl_vendors set rpn_id = a.rpn_id where id = a.vendor_id;
    else update cl_businesses set rpn_id = a.rpn_id where id = a.business_id; end if;
    perform cl_rpn_change_context(null, null, null);
  end if;
  update cl_rpn_assignments set status = case when p_accept then 'accepted' else 'rejected' end,
         resolved_by = v_staff, resolved_at = now(), resolution_reason = v_reason
   where id = p_assignment_id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, case when p_accept then 'rpn_conflict_accepted' else 'rpn_conflict_rejected' end, 'cl_rpn_assignments', null,
          jsonb_build_object('assignment_id', p_assignment_id, 'reason', v_reason));
  return json_build_object('id', p_assignment_id, 'accepted', p_accept);
end $fn$;

-- Each RPN with its portfolio, and the open conflicts.
create function public.cl_rpn_portfolio() returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['rpn_directory', 'vendors', 'rpn_commissions', 'rpn_payouts']);
  return json_build_object(
    'rpns', coalesce((select json_agg(json_build_object('id', r.id, 'full_name', r.full_name, 'field_force_no', r.field_force_no, 'active', r.active,
                       'has_pin', exists (select 1 from cl_rpn_pins p where p.rpn_id = r.id),
                       'businesses', coalesce((select json_agg(json_build_object('id', b.id, 'name', b.name) order by b.name) from cl_businesses b where b.rpn_id = r.id), '[]'::json),
                       'vendors', coalesce((select json_agg(json_build_object('id', v.id, 'name', v.business_name) order by v.business_name)
                                             from cl_vendors v where v.rpn_id = r.id and cl_vendor_business(v.id) is null), '[]'::json))
                     order by r.full_name) from cl_rpn r), '[]'::json),
    'conflicts', coalesce((select json_agg(json_build_object('id', a.id, 'vendor_id', a.vendor_id, 'business_id', a.business_id,
                       'name', coalesce(b.name, v.business_name), 'current_rpn', pr.full_name, 'wanted_rpn', r.full_name, 'by_install', a.by_install,
                       'created_at', a.created_at) order by a.created_at)
                   from cl_rpn_assignments a left join cl_businesses b on b.id = a.business_id left join cl_vendors v on v.id = a.vendor_id
                   left join cl_rpn r on r.id = a.rpn_id left join cl_rpn pr on pr.id = a.previous_rpn_id
                   where a.status = 'conflict'), '[]'::json));
end $fn$;

create function public.cl_rpn_history(p_business_id uuid, p_vendor_id uuid) returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['rpn_directory', 'vendors', 'rpn_commissions', 'rpn_payouts']);
  return coalesce((select json_agg(json_build_object('id', a.id, 'rpn', r.full_name, 'previous_rpn', pr.full_name, 'source', a.source, 'status', a.status,
                    'reason', a.reason, 'by_staff', s.full_name, 'by_install', a.by_install, 'created_at', a.created_at,
                    'resolved_by', rs.full_name, 'resolution_reason', a.resolution_reason) order by a.created_at desc)
                   from cl_rpn_assignments a left join cl_rpn r on r.id = a.rpn_id left join cl_rpn pr on pr.id = a.previous_rpn_id
                   left join cl_staff s on s.id = a.by_staff left join cl_staff rs on rs.id = a.resolved_by
                   where (p_business_id is not null and a.business_id = p_business_id) or (p_vendor_id is not null and a.vendor_id = p_vendor_id)), '[]'::json);
end $fn$;

-- 5. Commission rates ------------------------------------------------------
create table public.cl_rpn_commission_rates (
  id             bigint generated always as identity primary key,
  onboarding_pct numeric(5,2) not null check (onboarding_pct between 0 and 100),
  recurring_pct  numeric(5,2) not null check (recurring_pct between 0 and 100),
  effective_from timestamptz not null default now(),
  set_by         uuid references public.cl_staff(id),
  note           text,
  created_at     timestamptz not null default now()
);

create function public.cl_rpn_rate_at(p_at timestamptz) returns public.cl_rpn_commission_rates
language sql stable security definer set search_path = public as $$
  select * from cl_rpn_commission_rates where effective_from <= p_at order by effective_from desc, id desc limit 1
$$;

create function public.cl_rpn_rate_set(p_onboarding_pct numeric, p_recurring_pct numeric, p_effective_from timestamptz default null, p_note text default null) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_acting_staff(); v_from timestamptz := coalesce(p_effective_from, now()); r cl_rpn_commission_rates%rowtype;
begin
  if v_staff is null or not exists (select 1 from cl_staff where id = v_staff and active) or not cl_jwt_is_sysadmin() then
    raise exception 'Not authorized: only a SysAdmin can set commission rates' using errcode = '42501';
  end if;
  if p_onboarding_pct is null or p_recurring_pct is null or p_onboarding_pct < 0 or p_onboarding_pct > 100 or p_recurring_pct < 0 or p_recurring_pct > 100 then
    raise exception 'Rates are percentages from 0 to 100';
  end if;
  if v_from < now() - interval '5 minutes' then raise exception 'A rate can''t start in the past: commission already earned keeps its rate'; end if;
  perform pg_advisory_xact_lock(hashtext('cl_rpn_rate_set'));
  select * into r from cl_rpn_commission_rates where onboarding_pct = p_onboarding_pct and recurring_pct = p_recurring_pct
     and set_by = v_staff and created_at > now() - interval '30 seconds' order by id desc limit 1;
  if found then return json_build_object('rate', row_to_json(r), 'duplicate', true); end if;
  insert into cl_rpn_commission_rates (onboarding_pct, recurring_pct, effective_from, set_by, note)
  values (round(p_onboarding_pct, 2), round(p_recurring_pct, 2), v_from, v_staff, nullif(btrim(coalesce(p_note, '')), '')) returning * into r;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'rpn_rate_set', 'cl_rpn_commission_rates', null,
          jsonb_build_object('rate_id', r.id, 'onboarding_pct', r.onboarding_pct, 'recurring_pct', r.recurring_pct, 'effective_from', r.effective_from));
  return json_build_object('rate', row_to_json(r));
end $fn$;

create function public.cl_rpn_rates_list() returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['rpn_commissions', 'rpn_payouts']);
  return json_build_object('current_id', (cl_rpn_rate_at(now())).id,
    'rates', coalesce((select json_agg(json_build_object('id', r.id, 'onboarding_pct', r.onboarding_pct, 'recurring_pct', r.recurring_pct,
               'effective_from', r.effective_from, 'set_by', s.full_name, 'note', r.note, 'upcoming', r.effective_from > now()) order by r.effective_from desc, r.id desc)
             from cl_rpn_commission_rates r left join cl_staff s on s.id = r.set_by), '[]'::json));
end $fn$;

-- 6. Commission lines, earned on money received ----------------------------
create table public.cl_rpn_commissions (
  id                     bigint generated always as identity primary key,
  rpn_id                 uuid not null references public.cl_rpn(id) on delete restrict,
  vendor_id              uuid not null references public.cl_vendors(id) on delete restrict,
  business_id            uuid references public.cl_businesses(id) on delete restrict,
  ledger_entry_id        uuid not null unique references public.cl_ledger_entries(id) on delete restrict,
  kind                   text not null check (kind in ('onboarding', 'recurring')),
  base_amount            numeric(14,2) not null,
  currency               text not null,
  rate_id                bigint references public.cl_rpn_commission_rates(id) on delete restrict,
  rate_pct               numeric(5,2) not null,
  no_rate                boolean not null default false,
  amount                 numeric(14,2) not null,
  reverses_commission_id bigint unique references public.cl_rpn_commissions(id) on delete restrict,
  created_at             timestamptz not null default now()
);
create index cl_rpn_commissions_rpn_idx on public.cl_rpn_commissions (rpn_id, created_at);

create function public.cl_rpn_commission_accrue() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_biz uuid; v_rpn uuid; v_other boolean; v_rate cl_rpn_commission_rates%rowtype; c cl_rpn_commissions%rowtype;
begin
  if new.entry_type = 'payment' then
    v_biz := cl_vendor_business(new.vendor_id);
    v_rpn := cl_rpn_of_vendor(new.vendor_id);
    if v_rpn is null or not exists (select 1 from cl_rpn where id = v_rpn and active) then return new; end if;
    -- another payment of the same account that still stands (not reversed)?
    select exists (
      select 1 from cl_ledger_entries p
       where p.entry_type = 'payment' and p.id <> new.id
         and (p.vendor_id = new.vendor_id or (v_biz is not null and cl_vendor_business(p.vendor_id) = v_biz))
         and not exists (select 1 from cl_ledger_entries x where x.entry_type = 'payment_reversal' and x.reverses_entry_id = p.id)) into v_other;
    v_rate := cl_rpn_rate_at(new.created_at);
    insert into cl_rpn_commissions (rpn_id, vendor_id, business_id, ledger_entry_id, kind, base_amount, currency, rate_id, rate_pct, no_rate, amount)
    values (v_rpn, new.vendor_id, v_biz, new.id, case when v_other then 'recurring' else 'onboarding' end, new.amount, new.currency, v_rate.id,
            coalesce(case when v_other then v_rate.recurring_pct else v_rate.onboarding_pct end, 0), v_rate.id is null,
            round(new.amount * coalesce(case when v_other then v_rate.recurring_pct else v_rate.onboarding_pct end, 0) / 100, 2));
  elsif new.entry_type = 'payment_reversal' and new.reverses_entry_id is not null then
    select * into c from cl_rpn_commissions where ledger_entry_id = new.reverses_entry_id;
    if found then
      insert into cl_rpn_commissions (rpn_id, vendor_id, business_id, ledger_entry_id, kind, base_amount, currency, rate_id, rate_pct, no_rate, amount, reverses_commission_id)
      values (c.rpn_id, c.vendor_id, c.business_id, new.id, c.kind, -c.base_amount, c.currency, c.rate_id, c.rate_pct, c.no_rate, -c.amount, c.id);
    end if;
  end if;
  return new;
end $fn$;
create trigger cl_ledger_entries_rpn_commission after insert on public.cl_ledger_entries
  for each row when (new.entry_type in ('payment', 'payment_reversal')) execute function public.cl_rpn_commission_accrue();

-- 7. Payouts -------------------------------------------------------------
alter table public.cl_cashbook_entries drop constraint cl_cashbook_entries_source_type_check;
alter table public.cl_cashbook_entries add constraint cl_cashbook_entries_source_type_check
  check (source_type = any (array['ledger_payment'::text, 'voucher'::text, 'manual'::text, 'ledger_payment_reversal'::text,
                                  'rpn_commission_payout'::text, 'rpn_commission_payout_reversal'::text]));

create table public.cl_rpn_payouts (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('payout', 'reversal')),
  rpn_id             uuid not null references public.cl_rpn(id) on delete restrict,
  amount             numeric(14,2) not null check (amount > 0),
  currency           text not null,
  paying_account_id  uuid not null references public.cl_chart_of_accounts(id) on delete restrict,
  expense_account_id uuid references public.cl_chart_of_accounts(id) on delete restrict,
  cashbook_entry_id  uuid references public.cl_cashbook_entries(id) on delete restrict,
  reference          text,
  notes              text,
  reverses_payout_id uuid unique references public.cl_rpn_payouts(id) on delete restrict,
  paid_by            uuid references public.cl_staff(id),
  created_at         timestamptz not null default now(),
  constraint cl_rpn_payouts_shape check ((kind = 'reversal') = (reverses_payout_id is not null))
);

-- What is due to an RPN in a currency: earned - paid + payouts reversed.
create function public.cl_rpn_due(p_rpn_id uuid, p_currency text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount) from cl_rpn_commissions where rpn_id = p_rpn_id and currency = p_currency), 0)
       - coalesce((select sum(case when kind = 'payout' then amount else -amount end) from cl_rpn_payouts where rpn_id = p_rpn_id and currency = p_currency), 0)
$$;

create function public.cl_pay_rpn_commission(p_rpn_id uuid, p_amount numeric, p_currency text, p_paying_account_id uuid,
                                             p_reference text default null, p_notes text default null) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['rpn_payouts']); v_cur text := upper(btrim(coalesce(p_currency, '')));
        r cl_rpn%rowtype; acc cl_chart_of_accounts%rowtype; v_due numeric; p cl_rpn_payouts%rowtype; v_cash cl_cashbook_entries%rowtype;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if v_cur !~ '^[A-Z]{3}$' then raise exception 'Give a 3-letter currency, e.g. USD'; end if;
  select * into r from cl_rpn where id = p_rpn_id;
  if not found then raise exception 'No such RPN'; end if;
  select * into acc from cl_chart_of_accounts where id = p_paying_account_id;
  if not found or acc.account_type <> 'asset' then raise exception 'Pay from a cash, bank or mobile-money account'; end if;
  perform pg_advisory_xact_lock(hashtext('cl_pay_rpn_commission:' || p_rpn_id::text));
  select * into p from cl_rpn_payouts where kind = 'payout' and rpn_id = p_rpn_id and amount = p_amount and currency = v_cur
     and paying_account_id = p_paying_account_id and reference is not distinct from nullif(btrim(coalesce(p_reference, '')), '')
     and paid_by = v_staff and created_at > now() - interval '30 seconds' order by created_at desc limit 1;
  if found then return json_build_object('payout', row_to_json(p), 'duplicate', true); end if;
  v_due := cl_rpn_due(p_rpn_id, v_cur);
  if p_amount > v_due then
    raise exception 'That''s more than is due to %: % % is due.', r.full_name, v_cur, to_char(greatest(v_due, 0), 'FM999999990.00');
  end if;
  insert into cl_rpn_payouts (kind, rpn_id, amount, currency, paying_account_id, expense_account_id, reference, notes, paid_by)
  values ('payout', p_rpn_id, p_amount, v_cur, p_paying_account_id, (select id from cl_chart_of_accounts where code = '5100'),
          nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), v_staff) returning * into p;
  insert into cl_cashbook_entries (direction, amount, currency, coa_account_id, description, source_type, source_id, recorded_by)
  values ('out', p_amount, v_cur, p_paying_account_id, 'RPN commission: ' || r.full_name || coalesce(' (' || r.field_force_no || ')', ''),
          'rpn_commission_payout', p.id, v_staff) returning * into v_cash;
  update cl_rpn_payouts set cashbook_entry_id = v_cash.id where id = p.id returning * into p;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'pay_rpn_commission', 'cl_rpn_payouts', p.id, jsonb_build_object('rpn', r.full_name, 'amount', p_amount, 'currency', v_cur));
  return json_build_object('payout', row_to_json(p), 'cashbook_entry', row_to_json(v_cash), 'due_after', cl_rpn_due(p_rpn_id, v_cur));
end $fn$;

create function public.cl_reverse_rpn_payout(p_payout_id uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['rpn_payouts']); v_reason text := cl_rpn_reason(p_reason);
        p cl_rpn_payouts%rowtype; rv cl_rpn_payouts%rowtype; v_cash cl_cashbook_entries%rowtype; r cl_rpn%rowtype;
begin
  select * into p from cl_rpn_payouts where id = p_payout_id for update;
  if not found or p.kind <> 'payout' then raise exception 'No such payout'; end if;
  select * into rv from cl_rpn_payouts where reverses_payout_id = p.id;
  if found then raise exception 'That payout was already reversed on %', to_char(rv.created_at at time zone 'Africa/Harare', 'DD Mon YYYY HH24:MI'); end if;
  select * into r from cl_rpn where id = p.rpn_id;
  insert into cl_rpn_payouts (kind, rpn_id, amount, currency, paying_account_id, expense_account_id, notes, reverses_payout_id, paid_by)
  values ('reversal', p.rpn_id, p.amount, p.currency, p.paying_account_id, p.expense_account_id, v_reason, p.id, v_staff) returning * into rv;
  insert into cl_cashbook_entries (direction, amount, currency, coa_account_id, description, source_type, source_id, recorded_by)
  values ('in', p.amount, p.currency, p.paying_account_id, 'Reversed RPN commission payout: ' || r.full_name || ': ' || v_reason,
          'rpn_commission_payout_reversal', rv.id, v_staff) returning * into v_cash;
  update cl_rpn_payouts set cashbook_entry_id = v_cash.id where id = rv.id returning * into rv;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'reverse_rpn_payout', 'cl_rpn_payouts', p.id, jsonb_build_object('rpn', r.full_name, 'amount', p.amount, 'currency', p.currency, 'reason', v_reason));
  return json_build_object('reversal', row_to_json(rv), 'cashbook_entry', row_to_json(v_cash));
end $fn$;

-- 8. Reading commissions ---------------------------------------------------
-- Per RPN and currency: vendors, earned in the period (onboarding,
-- recurring, reversed), paid in the period, and what is due now.
create function public.cl_rpn_commission_summary(p_from date default null, p_to date default null) returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_from timestamptz := coalesce(p_from, date '2000-01-01')::timestamp at time zone 'Africa/Harare';
        v_to timestamptz := (coalesce(p_to, date '2999-12-31') + 1)::timestamp at time zone 'Africa/Harare';
begin
  perform cl_rpn_staff(array['rpn_commissions', 'rpn_payouts']);
  return coalesce((select json_agg(x order by x.full_name, x.currency) from (
    select r.id rpn_id, r.full_name, r.field_force_no, r.city, r.active, cur.currency,
           (select count(*) from cl_businesses b where b.rpn_id = r.id) + (select count(*) from cl_vendors v where v.rpn_id = r.id and cl_vendor_business(v.id) is null) accounts,
           coalesce((select sum(amount) from cl_rpn_commissions c where c.rpn_id = r.id and c.currency = cur.currency and c.kind = 'onboarding' and c.reverses_commission_id is null and c.created_at >= v_from and c.created_at < v_to), 0) earned_onboarding,
           coalesce((select sum(amount) from cl_rpn_commissions c where c.rpn_id = r.id and c.currency = cur.currency and c.kind = 'recurring' and c.reverses_commission_id is null and c.created_at >= v_from and c.created_at < v_to), 0) earned_recurring,
           coalesce((select sum(amount) from cl_rpn_commissions c where c.rpn_id = r.id and c.currency = cur.currency and c.reverses_commission_id is not null and c.created_at >= v_from and c.created_at < v_to), 0) reversed,
           coalesce((select sum(case when kind = 'payout' then amount else -amount end) from cl_rpn_payouts p where p.rpn_id = r.id and p.currency = cur.currency and p.created_at >= v_from and p.created_at < v_to), 0) paid,
           cl_rpn_due(r.id, cur.currency) due,
           (select count(*) from cl_rpn_commissions c where c.rpn_id = r.id and c.currency = cur.currency and c.no_rate) no_rate_lines
      from cl_rpn r
      cross join lateral (select c.currency from cl_rpn_commissions c where c.rpn_id = r.id
                          union select p.currency from cl_rpn_payouts p where p.rpn_id = r.id
                          union select 'USD' where not exists (select 1 from cl_rpn_commissions c where c.rpn_id = r.id)
                                             and not exists (select 1 from cl_rpn_payouts p where p.rpn_id = r.id)) cur
  ) x), '[]'::json);
end $fn$;

create function public.cl_rpn_commission_lines(p_rpn_id uuid, p_from date default null, p_to date default null) returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_from timestamptz := coalesce(p_from, date '2000-01-01')::timestamp at time zone 'Africa/Harare';
        v_to timestamptz := (coalesce(p_to, date '2999-12-31') + 1)::timestamp at time zone 'Africa/Harare';
begin
  perform cl_rpn_staff(array['rpn_commissions', 'rpn_payouts']);
  return json_build_object(
    'lines', coalesce((select json_agg(json_build_object('id', c.id, 'created_at', c.created_at, 'kind', c.kind,
               'account', coalesce(b.name, v.business_name), 'business_id', c.business_id, 'vendor_id', c.vendor_id,
               'payment_amount', c.base_amount, 'currency', c.currency, 'rate_pct', c.rate_pct, 'no_rate', c.no_rate, 'amount', c.amount,
               'is_reversal', c.reverses_commission_id is not null,
               'reversed', exists (select 1 from cl_rpn_commissions z where z.reverses_commission_id = c.id),
               'payment_ref', l.reference, 'payment_method', l.method) order by c.created_at, c.id)
             from cl_rpn_commissions c join cl_vendors v on v.id = c.vendor_id left join cl_businesses b on b.id = c.business_id
             join cl_ledger_entries l on l.id = c.ledger_entry_id
             where c.rpn_id = p_rpn_id and c.created_at >= v_from and c.created_at < v_to), '[]'::json),
    'payouts', coalesce((select json_agg(json_build_object('id', p.id, 'kind', p.kind, 'created_at', p.created_at, 'amount', p.amount, 'currency', p.currency,
               'account', a.code || ' ' || a.name, 'reference', p.reference, 'notes', p.notes, 'paid_by', s.full_name,
               'reverses_payout_id', p.reverses_payout_id,
               'reversed', exists (select 1 from cl_rpn_payouts z where z.reverses_payout_id = p.id)) order by p.created_at)
             from cl_rpn_payouts p join cl_chart_of_accounts a on a.id = p.paying_account_id left join cl_staff s on s.id = p.paid_by
             where p.rpn_id = p_rpn_id and p.created_at >= v_from and p.created_at < v_to), '[]'::json));
end $fn$;

-- 9. Modules -------------------------------------------------------------
insert into public.cl_modules (key, label, description, sort_order) values
  ('rpn_commissions', 'RPN Commissions', 'See RPN commissions earned, paid and due, and statements', 45),
  ('rpn_payouts', 'RPN Payouts', 'Pay RPN commission out of the Cashbook, and reverse payouts', 46);

-- 10. Security: RPNs read no vendor rows and can't change their own row ----
drop policy cl_vendors_select on public.cl_vendors;
create policy cl_vendors_select on public.cl_vendors as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('vendors'::text))));
drop policy cl_rpn_update_self on public.cl_rpn;

-- 11. Delete guards count commission lines and RPN history ----------------
create or replace function public.cl_vendor_delete_guard() returns trigger
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
  -- RPN commissions (20261015120000)
  select count(*) into n from cl_rpn_commissions where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN commission line' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_rpn_assignments where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN history entr' || case when n = 1 then 'y' else 'ies' end); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead (Console → Vendors → Archive). Nothing was deleted.',
      old.business_name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

create or replace function public.cl_business_delete_guard() returns trigger
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
  -- RPN commissions (20261015120000)
  select count(*) into n from cl_rpn_commissions where business_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN commission line' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_rpn_assignments where business_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN history entr' || case when n = 1 then 'y' else 'ies' end); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

-- 12. Grants -------------------------------------------------------------
alter table public.cl_rpn_pins enable row level security;
alter table public.cl_rpn_link_failures enable row level security;
alter table public.cl_rpn_assignments enable row level security;
alter table public.cl_rpn_commission_rates enable row level security;
alter table public.cl_rpn_commissions enable row level security;
alter table public.cl_rpn_payouts enable row level security;
revoke all on table public.cl_rpn_pins, public.cl_rpn_link_failures, public.cl_rpn_assignments, public.cl_rpn_commission_rates,
  public.cl_rpn_commissions, public.cl_rpn_payouts from public, anon, authenticated;

revoke all on function public.cl_vendor_business(uuid), public.cl_rpn_of_vendor(uuid), public.cl_log_rpn_change(),
  public.cl_rpn_change_context(text, text, text), public.cl_rpn_staff(text[]), public.cl_rpn_reason(text),
  public.cl_rpn_rate_at(timestamptz), public.cl_rpn_commission_accrue(), public.cl_rpn_due(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cl_device_link_rpn(text, text, text, text, text), public.cl_device_rpn_status(text, text, text) from public;
grant execute on function public.cl_device_link_rpn(text, text, text, text, text), public.cl_device_rpn_status(text, text, text) to anon, authenticated;
revoke all on function public.cl_rpn_set_field_force_no(uuid, text), public.cl_rpn_set_pin(uuid), public.cl_rpn_set_active(uuid, boolean, text),
  public.cl_assign_rpn(uuid, uuid, uuid, text), public.cl_resolve_rpn_conflict(bigint, boolean, text), public.cl_rpn_portfolio(),
  public.cl_rpn_history(uuid, uuid), public.cl_rpn_rate_set(numeric, numeric, timestamptz, text), public.cl_rpn_rates_list(),
  public.cl_pay_rpn_commission(uuid, numeric, text, uuid, text, text), public.cl_reverse_rpn_payout(uuid, text),
  public.cl_rpn_commission_summary(date, date), public.cl_rpn_commission_lines(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.cl_rpn_set_field_force_no(uuid, text), public.cl_rpn_set_pin(uuid), public.cl_rpn_set_active(uuid, boolean, text),
  public.cl_assign_rpn(uuid, uuid, uuid, text), public.cl_resolve_rpn_conflict(bigint, boolean, text), public.cl_rpn_portfolio(),
  public.cl_rpn_history(uuid, uuid), public.cl_rpn_rate_set(numeric, numeric, timestamptz, text), public.cl_rpn_rates_list(),
  public.cl_pay_rpn_commission(uuid, numeric, text, uuid, text, text), public.cl_reverse_rpn_payout(uuid, text),
  public.cl_rpn_commission_summary(date, date), public.cl_rpn_commission_lines(uuid, date, date)
  to authenticated;

commit;
