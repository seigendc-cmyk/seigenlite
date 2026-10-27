-- Rollback of 20261114120000_roles_everywhere (v36 Fix-A: A11, A12, A13).
-- Puts back every changed function exactly as before, removes the new
-- functions, the triggers, the Console permission, the Guest roles (only when
-- nobody has them), the columns and the log. The log's rows are lost with it.
begin;

do $$
begin
  if exists (select 1 from public.cl_shop_staff s join public.cl_shop_roles r on r.id = s.role_id where r.builtin = 'guest') then
    raise exception 'Rollback aborted: some staff have the Guest role. Give them another role first. Nothing was changed.';
  end if;
end $$;

drop trigger if exists cl_vendors_rpn_change_guard on public.cl_vendors;
drop trigger if exists cl_businesses_rpn_change_guard on public.cl_businesses;
drop function if exists public.cl_rpn_change_guard();
delete from public.cl_staff_module_access where module_id in (select id from public.cl_modules where key = 'change_vendor_rpn');
delete from public.cl_modules where key = 'change_vendor_rpn';
drop function if exists public.cl_device_staff_mode(text, text, text, text, text);

-- cl_install_vendor as in 20261113180000_removed_devices.sql
create or replace function public.cl_install_vendor(
  p_install_id text, p_phrase text, p_device_key text, p_create boolean,
  p_business_name text default null, p_device_code text default null)
returns public.cl_vendors
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype;
        st cl_terminals%rowtype; v_tok text; v_staff uuid;                -- office seats
begin
  perform set_config('cl.seat_terminal', '', true);                     -- office seats: who the caller is, for cl_seat_need
  perform set_config('cl.seat_staff', '', true);                        -- office seats
  if p_install_id is null or length(trim(p_install_id)) = 0 then raise exception 'install_id is required'; end if;
  if cl_norm_phrase(p_phrase) = '' then raise exception 'shop_secret_phrase is required'; end if;
  -- removed devices (v36 A1, decision 34): a device whose business was deleted gets nothing, and is never made a new vendor
  if exists (select 1 from cl_removed_devices r where r.install_id = p_install_id) then   -- removed devices
    raise exception 'DEVICE_REMOVED: This device belongs to a business that no longer exists on seiGEN. Reset this device.' using errcode = 'P0001';   -- removed devices
  end if;                                                                                -- removed devices

  select * into v from cl_vendors where install_id = p_install_id for update;
  if not found then
    if not p_create then raise exception 'This device is not registered yet' using errcode = 'P0002'; end if;
    insert into cl_vendors (business_name, install_id, device_code, shop_secret_phrase, device_key,
                            status, app_registered_at, last_checkin_at)
    values (coalesce(nullif(trim(coalesce(p_business_name,'')), ''), 'Unnamed vendor'), p_install_id,
            nullif(trim(coalesce(p_device_code,'')), ''), p_phrase, nullif(p_device_key, ''),
            'onboarding', now(), now())
    returning * into v;
    return v;
  end if;

  -- office seats: a seat sends its own phrase, then "|" and the signed-in person's token
  select * into st from cl_terminals where vendor_id = v.id and device_kind = 'seat';
  if st.id is not null then
    v_tok := nullif(split_part(coalesce(p_phrase, ''), '|', 2), '');
    p_phrase := split_part(coalesce(p_phrase, ''), '|', 1);
  end if;
  if v.shop_secret_phrase is not null and cl_norm_phrase(v.shop_secret_phrase) <> cl_norm_phrase(p_phrase) then
    raise exception 'Shop secret phrase does not match this install';
  end if;
  if v.device_key is not null and v.device_key is distinct from nullif(p_device_key, '') then
    raise exception 'This install ID is already registered to another device';
  end if;
  if v.device_key is null and nullif(p_device_key, '') is not null then
    update cl_vendors set device_key = p_device_key where id = v.id returning * into v;
  end if;
  -- office seats: an unapproved seat gets nothing (cl_seat_status / cl_seat_set_pin excepted)
  if st.id is not null then
    if st.approval_status <> 'approved' and coalesce(current_setting('cl.allow_pending_seat', true), '') <> '1' then
      raise exception 'SEAT_NOT_APPROVED: This Office seat is waiting for approval by the Owner or an Admin.' using errcode = 'P0001';
    end if;
    perform set_config('cl.seat_terminal', st.id::text, true);
    if v_tok is not null then
      select x.staff_id into v_staff from cl_shop_session(v_tok, st.id) x limit 1;
      if v_staff is not null then perform set_config('cl.seat_staff', v_staff::text, true); end if;
    end if;
  end if;
  return v;
end $fn$;

-- cl_seat_need as in 20261109120000_office_seats.sql
create or replace function public.cl_seat_need(p_right text) returns void
language plpgsql stable security definer set search_path = public as $fn$
declare v_seat text := coalesce(current_setting('cl.seat_terminal', true), '');
        v_staff text := coalesce(current_setting('cl.seat_staff', true), ''); v_rights text[]; v_name text;
begin
  if v_seat = '' then return; end if;
  if p_right = any(array['m.sell', 'm.credit', 'm.eod', 'void_return', 'credit_over_limit']) then
    raise exception 'SEAT_NO_SELLING: An Office seat can''t sell, take payments or run End of Day.' using errcode = 'P0001';
  end if;
  if v_staff = '' then
    raise exception 'SEAT_SIGN_IN: Sign in on this Office seat first (online).' using errcode = 'P0001';
  end if;
  select cl_shop_effective_rights(r), s.name into v_rights, v_name
    from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id where s.id = v_staff::uuid and s.active;
  if v_rights is null or not (p_right = any(v_rights)) then
    raise exception 'SEAT_NO_RIGHT: % doesn''t have the right for this (%).', coalesce(v_name, 'This person'), p_right using errcode = 'P0001';
  end if;
end $fn$;

-- cl_shop_session as in 20261108120000_shop_managers_everywhere.sql
create or replace function public.cl_shop_session(p_token text, p_terminal uuid)
returns table (staff_id uuid, business_id uuid, name text, builtin text, rights text[])
language sql stable security definer set search_path = public as $$
  select s.id, s.business_id, s.name, r.builtin, cl_shop_effective_rights(r)
    from cl_shop_staff_sessions x
    join cl_shop_staff s on s.id = x.staff_id
    join cl_shop_roles r on r.id = s.role_id
    join cl_terminals t on t.id = x.terminal_id
   where p_token is not null and length(p_token) between 32 and 128
     and x.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
     and x.terminal_id = p_terminal and x.revoked_at is null and x.expires_at > now()
     and s.active and t.active and t.business_id = s.business_id
     and cl_shop_staff_at(s, t.branch_id)
$$;

-- cl_shop_staff_json as in 20261108120000_shop_managers_everywhere.sql
create or replace function public.cl_shop_staff_json(s public.cl_shop_staff, p_branch uuid, p_terminal uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'role_id', s.role_id, 'home_branch_id', s.home_branch_id,
           'home_branch', (select b.name from cl_branches b where b.id = s.home_branch_id),
           'other_branches', to_jsonb(s.other_branches), 'active', s.active, 'seq', s.change_seq,
           'has_pin', s.pin_check is not null or jsonb_array_length(s.legacy_pins) > 0,
           'pins_from_tills', jsonb_array_length(s.legacy_pins),
           'here', s.active and cl_shop_staff_at(s, p_branch),
           'everywhere', cl_shop_staff_everywhere(s.role_id))
      || case when s.active and cl_shop_staff_at(s, p_branch) then
           jsonb_build_object('pin_salt', s.pin_salt, 'pin_check', s.pin_check, 'pin_rounds', s.pin_rounds,
             'legacy', (select coalesce(jsonb_agg(jsonb_build_object('salt', e->>'salt', 'hash', e->>'hash')), '[]'::jsonb)
                          from jsonb_array_elements(s.legacy_pins) e where e->>'terminal_id' = p_terminal::text))
         else '{}'::jsonb end
$$;

-- cl_device_staff_signin as in 20261108120000_shop_managers_everywhere.sql
create or replace function public.cl_device_staff_signin(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_id uuid, p_pin text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; s cl_shop_staff%rowtype; r cl_shop_roles%rowtype; n_fail int; v_ok boolean := false; v_legacy boolean := false; v_token text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into s from cl_shop_staff where id = p_staff_id and business_id = me.business_id for update;
  if not found or not s.active then return json_build_object('error', 'NOT_FOUND', 'message', 'That person isn''t active at this business.'); end if;
  if not cl_shop_staff_at(s, me.branch_id) then
    return json_build_object('error', 'NOT_HERE', 'message', 'That person doesn''t work at this branch.');
  end if;
  select count(*) into n_fail from cl_shop_staff_signin_fails where staff_id = s.id and at > now() - interval '15 minutes';
  if n_fail >= 5 then return json_build_object('error', 'LOCKED', 'message', 'Too many incorrect PINs. Try again in 15 minutes.'); end if;
  if coalesce(p_pin, '') ~ '^\d{4,6}$' then
    if s.pin_bcrypt is not null and s.pin_bcrypt = extensions.crypt(p_pin, s.pin_bcrypt) then v_ok := true;
    elsif exists (select 1 from jsonb_array_elements(s.legacy_pins) e
                   where e->>'terminal_id' = me.id::text and e->>'hash' = encode(extensions.digest((e->>'salt') || ':' || p_pin, 'sha256'), 'hex')) then
      v_ok := true; v_legacy := true;
    end if;
  end if;
  if not v_ok then
    insert into cl_shop_staff_signin_fails (staff_id, terminal_id) values (s.id, me.id);
    return json_build_object('error', 'BAD_PIN', 'message', 'Incorrect PIN.', 'left', greatest(0, 4 - n_fail));
  end if;
  delete from cl_shop_staff_signin_fails where staff_id = s.id;
  delete from cl_shop_staff_sessions where expires_at < now() - interval '1 day';
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into cl_shop_staff_sessions (token_hash, staff_id, terminal_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), s.id, me.id, now() + interval '12 hours');
  select * into r from cl_shop_roles where id = s.role_id;
  return json_build_object('ok', true, 'token', v_token, 'expires_at', now() + interval '12 hours', 'staff_id', s.id, 'name', s.name,
    'role', r.name, 'builtin', r.builtin, 'rights', to_json(cl_shop_effective_rights(r)), 'legacy', v_legacy);
end $fn$;

-- cl_device_staff_pull as in 20261110120000_staff_first_owner.sql
create or replace function public.cl_device_staff_pull(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_main boolean; v_upload text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select is_main into v_main from cl_branches where id = me.branch_id;
  if coalesce(v_main, false) then perform cl_shop_ensure_roles(me.business_id); end if;   -- a main-branch till makes the built-in roles
  v_upload := case
    when exists (select 1 from cl_shop_legacy_uploads u where u.terminal_id = me.id) then 'done'
    when me.registered_ts > (select v from cl_shop_meta where k = 'legacy_cutoff') and coalesce(v_main, false) and coalesce(me.device_kind, 'till') = 'till'   -- v33: a main till
         and not exists (select 1 from cl_shop_staff x where x.business_id = me.business_id) then 'ready'   -- v33: while the business has 0 staff on seiGEN
    when me.registered_ts > (select v from cl_shop_meta where k = 'legacy_cutoff') then 'not_needed'
    when not exists (select 1 from cl_shop_roles r where r.business_id = me.business_id) and not coalesce(v_main, false) then 'wait_main'
    else 'ready' end;
  return json_build_object('server_time', now(), 'branch_id', me.branch_id, 'terminal_id', me.id, 'is_main', v_main, 'upload', v_upload,
    'branches', coalesce((select json_agg(json_build_object('id', b.id, 'name', b.name, 'is_main', b.is_main) order by b.is_main desc, b.name)
                          from cl_branches b where b.business_id = me.business_id), '[]'::json),
    'roles', coalesce((select json_agg(cl_shop_role_json(r) order by case r.builtin when 'owner' then 1 when 'admin' then 2 when 'manager' then 3
                         when 'stores' then 4 when 'cashier' then 5 else 6 end, lower(r.name))
                       from cl_shop_roles r where r.business_id = me.business_id), '[]'::json),
    'staff', coalesce((select json_agg(cl_shop_staff_json(s, me.branch_id, me.id) order by lower(s.name))
                       from cl_shop_staff s where s.business_id = me.business_id), '[]'::json),
    'has_owner', exists (select 1 from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id
                          where s.business_id = me.business_id and s.active and r.builtin = 'owner'),
    -- nobody can manage staff yet: the first one may be added on a main-branch till (with its Admin passcode)
    'bootstrap', not exists (select 1 from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id
                              where s.business_id = me.business_id and s.active and 'm.staff' = any(r.rights)));
end $fn$;

-- cl_device_staff_save as in 20261110120000_staff_first_owner.sql
create or replace function public.cl_device_staff_save(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text, p_staff jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; v_boot boolean; v_main boolean; v_owner_ok boolean; cur cl_shop_staff%rowtype; v_cur_tb text;
        v_role cl_shop_roles%rowtype; v_name text; v_home uuid; v_others uuid[]; v_active boolean; v_id uuid; v_problem text; v_pin text; s cl_shop_staff%rowtype; v_by text;
        v_had_owner boolean;   -- v33
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  perform cl_shop_ensure_roles(me.business_id);
  select is_main into v_main from cl_branches where id = me.branch_id;
  select * into ses from cl_shop_session(p_staff_token, me.id) limit 1;
  v_boot := ses.staff_id is null and coalesce(v_main, false) and not exists (
    select 1 from cl_shop_staff st join cl_shop_roles ro on ro.id = st.role_id where st.business_id = me.business_id and st.active and 'm.staff' = any(ro.rights));
  if not v_boot and (ses.staff_id is null or not ('m.staff' = any(ses.rights))) then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Sign in (online) as someone with the Staff right to add or change staff.');
  end if;
  v_owner_ok := v_boot or cl_shop_owner_ok(me.business_id, ses.builtin);
  v_by := coalesce(ses.name, 'Admin passcode on till ' || me.till_code);
  if nullif(p_staff->>'id', '') is not null then
    select * into cur from cl_shop_staff where id = (p_staff->>'id')::uuid and business_id = me.business_id for update;
    if cur.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That person isn''t in this business.'); end if;
    select builtin into v_cur_tb from cl_shop_roles where id = cur.role_id;
  end if;
  v_name := left(btrim(regexp_replace(coalesce(p_staff->>'name', cur.name, ''), '\s+', ' ', 'g')), 60);
  if v_name = '' then raise exception 'Enter the person''s name.' using errcode = 'P0001'; end if;
  select * into v_role from cl_shop_roles where id = coalesce(nullif(p_staff->>'role_id', '')::uuid, cur.role_id) and business_id = me.business_id;
  if v_role.id is null then raise exception 'Choose a role of this business.' using errcode = 'P0001'; end if;
  v_home := coalesce(nullif(p_staff->>'home_branch_id', '')::uuid, cur.home_branch_id, me.branch_id);
  if not exists (select 1 from cl_branches where id = v_home and business_id = me.business_id) then raise exception 'Choose a branch of this business.' using errcode = 'P0001'; end if;
  v_others := case when p_staff ? 'other_branches' then
      array(select distinct b.id from jsonb_array_elements_text(coalesce(p_staff->'other_branches', '[]'::jsonb)) x join cl_branches b on b.id::text = x
             where b.business_id = me.business_id and b.id <> v_home)
    else coalesce(cur.other_branches, '{}') end;
  v_active := coalesce((p_staff->>'active')::boolean, cur.active, true);
  -- Owner-only (Q2): giving or taking the Owner role; changing an Owner
  if (v_role.builtin = 'owner' or v_cur_tb = 'owner') and not v_owner_ok then
    return json_build_object('error', 'OWNER_ONLY', 'message', 'Only an Owner may give, change or take away the Owner role.');
  end if;
  -- v33: while the business has no active Owner, the first one is made on a main-branch till only (whoever saves);
  -- with the Admin passcode (nobody signed in) only as the business's first person. After that only an Owner gives it (above).
  v_had_owner := exists (select 1 from cl_shop_staff st join cl_shop_roles ro on ro.id = st.role_id
                          where st.business_id = me.business_id and st.active and ro.builtin = 'owner');   -- v33
  if v_role.builtin = 'owner' and coalesce(v_cur_tb, '') <> 'owner' and not v_had_owner then   -- v33
    if not (coalesce(v_main, false) and coalesce(me.device_kind, 'till') = 'till') then   -- v33
      return json_build_object('error', 'FIRST_OWNER_MAIN', 'message', 'The business''s first Owner is set on a main-branch till.');   -- v33
    end if;   -- v33
    if v_boot and exists (select 1 from cl_shop_staff x where x.business_id = me.business_id) then   -- v33
      return json_build_object('error', 'FIRST_OWNER_NOT_EMPTY', 'message', 'With the Admin passcode the Owner can only be the business''s first person. Sign in as an Admin to make someone Owner.');   -- v33
    end if;   -- v33
  end if;   -- v33
  if v_cur_tb = 'owner' and (coalesce(v_role.builtin, '') <> 'owner' or not v_active) and not exists (
       select 1 from cl_shop_staff st join cl_shop_roles ro on ro.id = st.role_id
        where st.business_id = me.business_id and st.active and ro.builtin = 'owner' and st.id <> cur.id) then
    return json_build_object('error', 'LAST_OWNER', 'message', 'The business''s last Owner stays an Owner. Make someone else Owner first.');
  end if;
  v_pin := nullif(p_staff->>'pin', '');
  if cur.id is null and v_pin is null then raise exception 'Give the new person a PIN (4 to 6 digits).' using errcode = 'P0001'; end if;
  if v_pin is not null then
    v_problem := cl_shop_pin_problem(v_pin, p_staff->>'pin_salt', p_staff->>'pin_check', (p_staff->>'pin_rounds')::integer);
    if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;
  end if;
  if cur.id is null then
    insert into cl_shop_staff (business_id, name, role_id, home_branch_id, other_branches, active, pin_bcrypt, pin_salt, pin_check, pin_rounds, pin_changed_at,
                               created_terminal, updated_by)
    values (me.business_id, v_name, v_role.id, v_home, v_others, v_active, extensions.crypt(v_pin, extensions.gen_salt('bf', 8)),
            p_staff->>'pin_salt', p_staff->>'pin_check', (p_staff->>'pin_rounds')::integer, now(), me.id, v_by)
    returning * into s;
  else
    update cl_shop_staff set name = v_name, role_id = v_role.id, home_branch_id = v_home, other_branches = v_others, active = v_active,
           pin_bcrypt = case when v_pin is null then pin_bcrypt else extensions.crypt(v_pin, extensions.gen_salt('bf', 8)) end,
           pin_salt = case when v_pin is null then pin_salt else p_staff->>'pin_salt' end,
           pin_check = case when v_pin is null then pin_check else p_staff->>'pin_check' end,
           pin_rounds = case when v_pin is null then pin_rounds else (p_staff->>'pin_rounds')::integer end,
           pin_changed_at = case when v_pin is null then pin_changed_at else now() end,
           legacy_pins = case when v_pin is null then legacy_pins else '[]'::jsonb end,
           change_seq = nextval('cl_shop_seq'), updated_at = now(), updated_by = v_by
     where id = cur.id returning * into s;
    -- switched off: their sessions end at once (server data stops)
    if not v_active then update cl_shop_staff_sessions set revoked_at = now() where staff_id = s.id and revoked_at is null; end if;
  end if;
  if v_role.builtin = 'owner' and coalesce(v_cur_tb, '') <> 'owner' and not v_had_owner then   -- v33: logged (Console vendor record)
    insert into cl_shop_staff_events (business_id, kind, terminal_id, till_code, staff_id, via)
    values (me.business_id, 'first_owner', me.id, me.till_code, s.id, case when v_boot then 'admin_passcode' else 'signed_in' end);
  end if;
  return json_build_object('ok', true, 'staff', cl_shop_staff_json(s, me.branch_id, me.id));
end $fn$;

-- cl_device_role_save as in 20261107120000_shop_roles.sql
create or replace function public.cl_device_role_save(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text, p_role jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; cur cl_shop_roles%rowtype; v_name text; v_rights text[]; r cl_shop_roles%rowtype; v_mine uuid;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into ses from cl_shop_session(p_staff_token, me.id) limit 1;
  if ses.staff_id is null or not ('m.staff' = any(ses.rights)) then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Sign in (online) as someone with the Staff right to change roles.');
  end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  perform cl_shop_ensure_roles(me.business_id);
  if nullif(p_role->>'id', '') is not null then
    select * into cur from cl_shop_roles where id = (p_role->>'id')::uuid and business_id = me.business_id for update;
    if cur.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That role isn''t in this business.'); end if;
    if cur.builtin = 'owner' then return json_build_object('error', 'OWNER_FIXED', 'message', 'The Owner role always has every right.'); end if;
  end if;
  if coalesce((p_role->>'delete')::boolean, false) then
    if cur.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'Say which role to delete.'); end if;
    if not cl_shop_owner_ok(me.business_id, ses.builtin) then return json_build_object('error', 'OWNER_ONLY', 'message', 'Only an Owner may delete a role.'); end if;
    if cur.builtin is not null then return json_build_object('error', 'BUILTIN', 'message', 'A built-in role can be changed but not deleted.'); end if;
    if exists (select 1 from cl_shop_staff where role_id = cur.id) then
      return json_build_object('error', 'IN_USE', 'message', 'Give its staff another role first.');
    end if;
    delete from cl_shop_roles where id = cur.id;
    return json_build_object('ok', true, 'deleted', cur.id);
  end if;
  v_name := left(btrim(regexp_replace(coalesce(p_role->>'name', cur.name, ''), '\s+', ' ', 'g')), 40);
  if v_name = '' then raise exception 'Give the role a name.' using errcode = 'P0001'; end if;
  v_rights := array(select distinct x from jsonb_array_elements_text(coalesce(p_role->'rights', to_jsonb(cur.rights), '[]'::jsonb)) x
                     where x = any(cl_shop_rights_all()) and x <> 'owner' order by x);
  select role_id into v_mine from cl_shop_staff where id = ses.staff_id;
  if cur.id = v_mine and not ('m.staff' = any(v_rights)) then
    return json_build_object('error', 'OWN_ROLE', 'message', 'You''d lose the Staff right yourself. Ask another person with it.');
  end if;
  begin
    if cur.id is null then
      insert into cl_shop_roles (business_id, name, rights, updated_by) values (me.business_id, v_name, v_rights, ses.name) returning * into r;
    else
      update cl_shop_roles set name = v_name, rights = v_rights, change_seq = nextval('cl_shop_seq'), updated_at = now(), updated_by = ses.name
       where id = cur.id returning * into r;
    end if;
  exception when unique_violation then
    return json_build_object('error', 'NAME_TAKEN', 'message', 'Another role already has that name.');
  end;
  return json_build_object('ok', true, 'role', cl_shop_role_json(r));
end $fn$;

-- cl_device_seat_invite_create as in 20261109120000_office_seats.sql
create or replace function public.cl_device_seat_invite_create(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text,
                                                    p_staff_id uuid default null, p_name text default null, p_role_id uuid default null,
                                                    p_valid_hours integer default 24)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; br cl_branches%rowtype; s cl_shop_staff%rowtype; r cl_shop_roles%rowtype;
        v_name text; v_code text; v_exp timestamptz; v_id uuid; tries integer := 0;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into ses from cl_seat_admin(me, p_staff_token) limit 1;
  if ses.staff_id is null then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Sign in (online) as the Owner or an Admin on a main-branch device to invite an Office seat.');
  end if;
  select * into br from cl_branches where id = me.branch_id;
  if br.stock_mode = 'shared' then
    return json_build_object('error', 'SHARED_STOCK', 'message', 'The main branch uses shared stock, so it can''t have an Office seat.');
  end if;
  if (select count(*) from cl_branch_join_codes j join cl_branches b on b.id = j.branch_id
       where b.business_id = me.business_id and j.code_kind = 'seat' and j.used_by_terminal is null and j.revoked_ts is null and j.expires_ts > now()) >= 10 then
    return json_build_object('error', 'TOO_MANY_INVITES', 'message', 'There are already 10 open invites. Revoke one, or wait until they are used or expire.');
  end if;
  perform cl_shop_ensure_roles(me.business_id);
  if p_staff_id is not null then
    select * into s from cl_shop_staff where id = p_staff_id and business_id = me.business_id and active;
    if s.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That person isn''t active in this business.'); end if;
    select * into r from cl_shop_roles where id = s.role_id;
    v_name := s.name;
  else
    v_name := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 60);
    if v_name = '' then return json_build_object('error', 'NO_NAME', 'message', 'Enter the person''s name.'); end if;
    select * into r from cl_shop_roles where id = p_role_id and business_id = me.business_id;
    if r.id is null then return json_build_object('error', 'NO_ROLE', 'message', 'Choose a role of this business.'); end if;
    if r.builtin = 'owner' and not cl_shop_owner_ok(me.business_id, ses.builtin) then
      return json_build_object('error', 'OWNER_ONLY', 'message', 'Only an Owner may give the Owner role.');
    end if;
  end if;
  if r.builtin = 'cashier' then
    return json_build_object('error', 'CASHIER_ROLE', 'message', 'A Cashier can''t use an Office seat (it can''t sell). Choose another role.');
  end if;
  v_exp := now() + make_interval(hours => greatest(1, least(coalesce(p_valid_hours, 24), 24)));
  loop
    tries := tries + 1;
    v_code := cl_new_join_code();
    begin
      insert into cl_branch_join_codes (branch_id, code_hash, issued_by_terminal, expires_ts, code_kind, staff_id, person_name, role_id, issued_by_staff)
      values (br.id, encode(extensions.digest(v_code, 'sha256'), 'hex'), me.id, v_exp, 'seat', s.id, case when s.id is null then v_name end,
              case when s.id is null then r.id end, ses.staff_id)
      returning id into v_id;
      exit;
    exception when unique_violation then
      if tries >= 5 then raise; end if;
    end;
  end loop;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'seat_invite_created', 'cl_branch_join_codes', v_id,
          jsonb_build_object('business_id', me.business_id, 'by_staff', ses.staff_id, 'by_till', me.till_code, 'person', v_name, 'role', r.name, 'expires_ts', v_exp));
  return json_build_object('ok', true, 'invite_id', v_id, 'code', v_code, 'expires_ts', v_exp, 'person_name', v_name, 'role_name', r.name,
                           'existing_person', s.id is not null, 'business_name', (select name from cl_businesses where id = me.business_id));
end $fn$;

-- cl_device_branch_stock as in 20261106120000_branch_views.sql
create or replace function public.cl_device_branch_stock(p_install_id text, p_secret_phrase text, p_device_key text, p_branch_id uuid default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; caller_main boolean;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select is_main into caller_main from cl_branches where id = me.branch_id;
  return json_build_object(
    'server_time', now(), 'branch_id', me.branch_id, 'terminal_id', me.id, 'is_main', caller_main,
    'enabled', cl_bs_enabled(me.business_id),
    'branches', coalesce((select json_agg(x order by x.is_main desc, x.name) from (
      select b.id, b.name, b.is_main, b.stock_mode,
        case when b.stock_mode = 'shared'
          then (select max(s.last_sync_ts) from cl_till_stock_state s where s.branch_id = b.id)
          else (select max(p.pushed_at) from cl_till_stock_push p join cl_terminals t on t.id = p.terminal_id where p.branch_id = b.id and t.active) end as updated_at,
        (select count(*) from cl_terminals t where t.branch_id = b.id and t.active) as active_tills,
        coalesce((select json_agg(json_build_object('terminal_id', t.id, 'till_code', t.till_code, 'label', t.label, 'active', t.active,
            'as_of', p.as_of, 'pushed_at', p.pushed_at, 'products', coalesce(p.products, 0)) order by t.till_code)
          from cl_terminals t left join cl_till_stock_push p on p.terminal_id = t.id where t.branch_id = b.id), '[]'::json) as tills,
        case when b.stock_mode = 'shared' then
          coalesce((select json_agg(json_build_object('k', s.product_uid, 'cat_uid', s.product_uid, 'code', c.code, 'name', c.name, 'qty', s.total, 'low', c.low_threshold) order by c.name)
            from cl_branch_stock s join cl_catalogue_products c on c.business_id = s.business_id and c.product_uid = s.product_uid
           where s.branch_id = b.id), '[]'::json)
        else
          coalesce((select json_agg(json_build_object('k', g.product_key, 'cat_uid', g.cat_uid, 'code', g.code, 'name', g.name, 'qty', g.qty, 'low', g.low,
                     't', g.t) order by g.name)
            from (select l.product_key, max(l.cat_uid) cat_uid, max(l.code) code, max(l.name) name, sum(l.qty)::bigint qty, max(l.low_threshold) low,
                         json_object_agg(t.till_code, l.qty) t
                    from cl_till_stock_levels l join cl_terminals t on t.id = l.terminal_id
                   where l.branch_id = b.id and t.active and t.branch_id = b.id
                   group by l.product_key) g), '[]'::json)
        end as rows
      from cl_branches b
     where b.business_id = me.business_id and (p_branch_id is null or b.id = p_branch_id)) x), '[]'::json));
end $fn$;

-- cl_device_customers_pull as in 20261018180000_customers_wholesale.sql
create or replace function public.cl_device_customers_pull(p_install_id text, p_secret_phrase text, p_device_key text, p_cursor bigint default 0) returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; rows jsonb; nxt bigint;
begin
  me := cl_customer_till(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  select coalesce(jsonb_agg(cl_customer_json(c) order by c.change_seq), '[]'::jsonb), coalesce(max(c.change_seq), greatest(coalesce(p_cursor, 0), 0))
    into rows, nxt
    from (select * from cl_customers where business_id = me.business_id and change_seq > greatest(coalesce(p_cursor, 0), 0)
          order by change_seq limit 500) c;
  return json_build_object('customers', rows, 'cursor', nxt,
    'more', exists (select 1 from cl_customers where business_id = me.business_id and change_seq > nxt));
end $fn$;

-- cl_device_suppliers_pull as in 20261018120000_supplier_grv.sql
create or replace function public.cl_device_suppliers_pull(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  return json_build_object(
    'suppliers', coalesce((select json_agg(cl_supplier_json(s) order by lower(s.name)) from cl_suppliers s where s.business_id = me.business_id), '[]'::json),
    'my_grvs', coalesce((select json_agg(cl_supplier_grv_json(g.id) order by g.posted_at) from cl_supplier_grvs g
       where g.terminal_id = me.id and g.posted_at > now() - interval '60 days'), '[]'::json),
    'max_grv_no', (select max(n) from (select max(grv_no) n from cl_supplier_grvs where terminal_id = me.id
                                       union all select max(grv_no) from cl_dispatches where grv_terminal_id = me.id) x));
end $fn$;

-- cl_device_supplier_invoice_check as in 20261018120000_supplier_grv.sql
create or replace function public.cl_device_supplier_invoice_check(p_install_id text, p_secret_phrase text, p_device_key text, p_supplier_id uuid, p_invoice_no text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; g cl_supplier_grvs%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into g from cl_supplier_grvs where business_id = me.business_id and supplier_id = p_supplier_id and invoice_key = cl_invoice_key(p_invoice_no);
  if not found then return json_build_object('found', false); end if;
  return json_build_object('found', true, 'id', g.id, 'grv_display', g.grv_display, 'posted_at', g.posted_at, 'till', (select till_code from cl_terminals where id = g.terminal_id));
end $fn$;

-- cl_device_dispatch_pull as in 20261017120000_dispatch_grv.sql
create or replace function public.cl_device_dispatch_pull(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into b from cl_branches where id = me.branch_id;
  return json_build_object(
    'terminal_id', me.id, 'branch_id', me.branch_id, 'is_main', b.is_main, 'active', me.active, 'server_time', now(),
    'max_dn_no', (select max(dn_no) from cl_dispatches where from_terminal_id = me.id),
    'max_grv_no', (select max(grv_no) from cl_dispatches where grv_terminal_id = me.id),
    'incoming', coalesce((select json_agg(cl_dispatch_json(d.id) order by d.sent_at) from cl_dispatches d
       where d.to_branch_id = me.branch_id and (d.status = 'sent' or d.sent_at > now() - interval '60 days')), '[]'::json),
    'outgoing', coalesce((select json_agg(cl_dispatch_json(d.id) order by d.sent_at) from cl_dispatches d
       where d.from_branch_id = me.branch_id and (d.status = 'sent' or d.sent_at > now() - interval '60 days'
             or exists (select 1 from cl_dispatch_issues i where i.dispatch_id = d.id and i.status in ('open', 'disputed')))), '[]'::json));
end $fn$;

-- cl_device_dispatch_lookup as in 20261017120000_dispatch_grv.sql
create or replace function public.cl_device_dispatch_lookup(p_install_id text, p_secret_phrase text, p_device_key text,
                                                 p_dispatch_id uuid, p_from_legacy_branch_id text, p_dn_no integer)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; d cl_dispatches%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if p_dispatch_id is not null then select * into d from cl_dispatches where id = p_dispatch_id and business_id = me.business_id; end if;
  if d.id is null and p_from_legacy_branch_id is not null and p_dn_no is not null then
    select * into d from cl_dispatches where business_id = me.business_id and from_legacy_branch_id = p_from_legacy_branch_id and dn_no = p_dn_no
     order by sent_at desc limit 1;
  end if;
  if d.id is null then return json_build_object('found', false); end if;
  return json_build_object('found', true, 'id', d.id, 'status', d.status, 'dn_display', d.dn_display, 'grv_display', d.grv_display,
    'to_branch_id', d.to_branch_id, 'to_branch', (select name from cl_branches where id = d.to_branch_id));
end $fn$;

-- cl_device_business_dispatches as in 20261106120000_branch_views.sql
create or replace function public.cl_device_business_dispatches(p_install_id text, p_secret_phrase text, p_device_key text, p_days integer default 30)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_days integer := least(greatest(coalesce(p_days, 30), 1), 180);
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  return json_build_object('server_time', now(), 'days', v_days,
    'dispatches', coalesce((select json_agg(x order by x.sent_at desc) from (
      select d.id, d.dn_display, fb.name from_branch, d.from_branch_id, tb.name to_branch, d.to_branch_id, ft.till_code from_till,
             d.status, d.sent_at, d.sent_by, d.grv_display, d.received_at, d.grv_by, d.cancelled_at,
             d.internal_ref, d.grv_internal_ref, d.delivery_cost, d.delivery_currency, d.carrier, d.delivery_ref,   -- branch views (20261106120000)
             (select coalesce(json_agg(json_build_object('line_no', l.line_no, 'code', l.code, 'name', l.name, 'qty', l.qty,
                 'received', l.received, 'damaged', l.damaged, 'short', l.short, 'extra', l.extra) order by l.line_no), '[]'::json)
                from cl_dispatch_lines l where l.dispatch_id = d.id) lines,
             (select count(*) from cl_dispatch_issues i where i.dispatch_id = d.id and i.status in ('open', 'disputed')) open_issues
        from cl_dispatches d
        join cl_branches fb on fb.id = d.from_branch_id
        join cl_branches tb on tb.id = d.to_branch_id
        join cl_terminals ft on ft.id = d.from_terminal_id
       where d.business_id = me.business_id
         and (d.status = 'sent' or d.sent_at > now() - make_interval(days => v_days)
              or exists (select 1 from cl_dispatch_issues i where i.dispatch_id = d.id and i.status in ('open', 'disputed')))
       order by d.sent_at desc
       limit 300) x), '[]'::json));
end $fn$;

-- cl_device_dispatch_card as in 20261106120000_branch_views.sql
create or replace function public.cl_device_dispatch_card(p_install_id text, p_secret_phrase text, p_device_key text, p_dispatch_id uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; d cl_dispatches%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into d from cl_dispatches where id = p_dispatch_id and business_id = me.business_id;
  if not found then return json_build_object('error', 'NOT_FOUND', 'message', 'That Delivery Note isn''t on seiGEN for this business.'); end if;
  return (select json_build_object(
    'id', d.id, 'dn_display', d.dn_display, 'status', d.status, 'mine', d.from_terminal_id = me.id,
    'from_branch_id', d.from_branch_id, 'from_branch', fb.name, 'from_till', ft.till_code,
    'to_branch_id', d.to_branch_id, 'to_branch', tb.name,
    'created_iso', d.created_iso, 'internal_ref', d.internal_ref, 'sent_by', d.sent_by, 'sent_at', d.sent_at,
    'received_at', d.received_at, 'grv_display', d.grv_display, 'grv_till', gt.till_code, 'grv_by', d.grv_by,
    'grv_internal_ref', d.grv_internal_ref, 'grv_note', d.grv_note,
    'cancelled_at', d.cancelled_at, 'cancelled_by', d.cancelled_by, 'cancel_reason', d.cancel_reason,
    'transport', json_build_object('cost', d.delivery_cost, 'currency', d.delivery_currency, 'carrier', d.carrier, 'ref', d.delivery_ref, 'paid_by', 'receiving'),
    'lines', coalesce((select json_agg(json_build_object('line_no', l.line_no, 'cat_uid', l.cat_uid, 'code', l.code, 'name', l.name, 'unit', l.unit,
        'qty', l.qty, 'received', l.received, 'damaged', l.damaged, 'short', l.short, 'extra', l.extra, 'note', l.note) order by l.line_no)
      from cl_dispatch_lines l where l.dispatch_id = d.id), '[]'::json),
    'issues', coalesce((select json_agg(json_build_object('id', i.id, 'line_no', i.line_no, 'name', l.name, 'kind', i.kind, 'qty', i.qty, 'status', i.status,
        'created_at', i.created_at, 'resolved_at', i.resolved_at, 'resolved_by', i.resolved_by, 'resolved_till', rt.till_code,
        'note', i.resolution_note, 'adj_display', i.adj_display,
        'redispatch', case when r.id is not null then json_build_object('id', r.id, 'dn_display', r.dn_display, 'status', r.status) end) order by i.line_no, i.kind)
      from cl_dispatch_issues i
      join cl_dispatch_lines l on l.dispatch_id = i.dispatch_id and l.line_no = i.line_no
      left join cl_terminals rt on rt.id = i.resolved_terminal_id
      left join cl_dispatches r on r.id = i.redispatch_id
      where i.dispatch_id = d.id), '[]'::json),
    'replaces', (select json_build_object('id', o.id, 'dn_display', o.dn_display, 'kind', i.kind, 'qty', i.qty, 'name', l.name)
      from cl_dispatch_issues i join cl_dispatches o on o.id = i.dispatch_id
      join cl_dispatch_lines l on l.dispatch_id = i.dispatch_id and l.line_no = i.line_no
      where i.id = d.replaces_issue_id),
    'history', coalesce((select json_agg(json_build_object('at', g.at, 'action', g.action, 'by', g.by_name, 'till', t.till_code, 'branch', tb2.name,
        'kind', g.detail->>'kind', 'qty', g.detail->'qty', 'adj', g.detail->>'adj', 'reason', g.detail->>'reason', 'status', g.detail->>'status') order by g.at, g.id)
      from cl_dispatch_log g
      left join cl_terminals t on t.id = g.terminal_id
      left join cl_branches tb2 on tb2.id = t.branch_id
      where g.dispatch_id = d.id), '[]'::json))
    from cl_branches fb, cl_branches tb, cl_terminals ft left join cl_terminals gt on gt.id = d.grv_terminal_id
   where fb.id = d.from_branch_id and tb.id = d.to_branch_id and ft.id = d.from_terminal_id);
end $fn$;

-- cl_device_item_ledger as in 20261106120000_branch_views.sql
create or replace function public.cl_device_item_ledger(p_install_id text, p_secret_phrase text, p_device_key text,
                                             p_cat_uid text default null, p_code text default null, p_name text default null,
                                             p_branch_id uuid default null, p_from timestamptz default null, p_to timestamptz default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_cat text := lower(btrim(coalesce(p_cat_uid, ''))); v_code text := lower(btrim(coalesce(p_code, '')));
        v_name text := lower(btrim(coalesce(p_name, ''))); v_from timestamptz := coalesce(p_from, '-infinity'); v_to timestamptz := coalesce(p_to, 'infinity');
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if v_cat = '' and v_code = '' and v_name = '' then raise exception 'Say which product (its catalogue id, code or name)' using errcode = 'P0001'; end if;
  if length(v_cat) > 64 or length(v_code) > 64 or length(v_name) > 120 then raise exception 'That product key is too long' using errcode = 'P0001'; end if;
  if p_branch_id is not null and not exists (select 1 from cl_branches where id = p_branch_id and business_id = me.business_id) then
    return json_build_object('error', 'NOT_FOUND', 'message', 'That branch isn''t in this business.');
  end if;
  return json_build_object('server_time', now(), 'kinds', json_build_array('dispatch', 'grv', 'differences', 'supplier_grv'),
    'rows', coalesce((select json_agg(m order by m.at desc, m.doc) from (
      select * from (
        -- the sending branch
        select d.sent_at at, 'dispatch_out' kind, d.from_branch_id branch_id, d.from_terminal_id terminal_id, d.dn_display doc, d.id dispatch_id,
               d.to_branch_id other_branch_id, d.sent_by by_name, 0 qty_in, l.qty qty_out, d.internal_ref note
          from cl_dispatches d join cl_dispatch_lines l on l.dispatch_id = d.id
         where d.business_id = me.business_id and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        union all
        select d.cancelled_at, 'dispatch_cancel', d.from_branch_id, d.from_terminal_id, d.dn_display, d.id, d.to_branch_id, d.cancelled_by, l.qty, 0, d.cancel_reason
          from cl_dispatches d join cl_dispatch_lines l on l.dispatch_id = d.id
         where d.business_id = me.business_id and d.status = 'cancelled' and d.cancelled_at is not null
           and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        union all
        select i.created_at, 'dispatch_return', d.from_branch_id, d.from_terminal_id, d.dn_display, d.id, d.to_branch_id, null, i.qty, 0,
               i.kind || ' at the receiving branch (' || coalesce(d.grv_display, '') || ')'
          from cl_dispatch_issues i join cl_dispatches d on d.id = i.dispatch_id
          join cl_dispatch_lines l on l.dispatch_id = i.dispatch_id and l.line_no = i.line_no
         where d.business_id = me.business_id and i.kind in ('short', 'damaged') and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        union all
        select i.resolved_at, 'write_off', d.from_branch_id, coalesce(i.resolved_terminal_id, d.from_terminal_id), coalesce(i.adj_display, d.dn_display), d.id,
               d.to_branch_id, i.resolved_by, 0, i.qty, i.kind || ' on ' || d.dn_display || coalesce(': ' || i.resolution_note, '')
          from cl_dispatch_issues i join cl_dispatches d on d.id = i.dispatch_id
          join cl_dispatch_lines l on l.dispatch_id = i.dispatch_id and l.line_no = i.line_no
         where d.business_id = me.business_id and i.kind in ('short', 'damaged') and i.status = 'written_off' and i.resolved_at is not null
           and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        union all
        select i.resolved_at, 'dispatch_extra', d.from_branch_id, coalesce(i.resolved_terminal_id, d.from_terminal_id), d.dn_display, d.id, d.to_branch_id,
               i.resolved_by, 0, i.qty, 'extra confirmed at the receiving branch (' || coalesce(d.grv_display, '') || ')'
          from cl_dispatch_issues i join cl_dispatches d on d.id = i.dispatch_id
          join cl_dispatch_lines l on l.dispatch_id = i.dispatch_id and l.line_no = i.line_no
         where d.business_id = me.business_id and i.kind = 'extra' and i.status = 'confirmed' and i.resolved_at is not null
           and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        -- the receiving branch
        union all
        select d.received_at, 'receive', d.to_branch_id, d.grv_terminal_id, coalesce(d.grv_display, d.dn_display), d.id, d.from_branch_id, d.grv_by,
               coalesce(l.received, 0) + coalesce(l.extra, 0), 0, 'from ' || d.dn_display || coalesce(' · ' || d.grv_internal_ref, '')
          from cl_dispatches d join cl_dispatch_lines l on l.dispatch_id = d.id
         where d.business_id = me.business_id and d.received_at is not null and d.grv_terminal_id is not null
           and coalesce(l.received, 0) + coalesce(l.extra, 0) > 0 and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        -- goods from suppliers
        union all
        select g.posted_at, 'supplier_grv', g.branch_id, g.terminal_id, g.grv_display, null, null, g.received_by, l.qty, 0,
               s.name || ', invoice ' || g.invoice_no
          from cl_supplier_grvs g join cl_supplier_grv_lines l on l.grv_id = g.id join cl_suppliers s on s.id = g.supplier_id
         where g.business_id = me.business_id and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
      ) u
      where u.at >= v_from and u.at <= v_to and (p_branch_id is null or u.branch_id = p_branch_id)
      order by u.at desc
      limit 1000) r0
    cross join lateral (select r0.at, r0.kind, r0.branch_id, b.name branch, t.till_code till, r0.terminal_id = me.id mine, r0.doc, r0.dispatch_id,
                               ob.name other_branch, r0.by_name "by", r0.qty_in, r0.qty_out, r0.note
                          from cl_branches b left join cl_terminals t on t.id = r0.terminal_id left join cl_branches ob on ob.id = r0.other_branch_id
                         where b.id = r0.branch_id) m), '[]'::json));
end $fn$;

-- cl_device_transfers_pull as in 20261109120000_office_seats.sql
create or replace function public.cl_device_transfers_pull(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  return json_build_object(
    'incoming', coalesce((select json_agg(cl_transfer_json(x.id) order by x.sent_at) from cl_internal_transfers x
       where x.to_terminal_id = me.id and (x.status = 'sent' or x.sent_at > now() - interval '60 days')), '[]'::json),
    'outgoing', coalesce((select json_agg(cl_transfer_json(x.id) order by x.sent_at) from cl_internal_transfers x
       where x.from_terminal_id = me.id and (x.status = 'sent' or x.sent_at > now() - interval '60 days'
          or exists (select 1 from cl_internal_transfer_lines l where l.transfer_id = x.id and l.short_status = 'open'))), '[]'::json),
    'max_it_no', (select max(it_no) from cl_internal_transfers where from_terminal_id = me.id));
end $fn$;

-- cl_device_credit_balances as in 20261113120000_sales_sync.sql
create or replace function public.cl_device_credit_balances(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if me.device_kind = 'seat' then return json_build_object('error', 'SEAT_NO_SELLING', 'message', 'An Office seat can''t sell, take payments or run End of Day.'); end if;
  return json_build_object('server_time', now(), 'balances', coalesce((select json_agg(json_build_object('uid', y.k, 'balance', y.b) order by y.k) from (select k, round(sum(a), 2) b from (
      select customer_uid k, credit_amount a from cl_sales where business_id = me.business_id and credit_amount <> 0 and customer_uid is not null
      union all select customer_uid, -amount from cl_credit_payments where business_id = me.business_id
      union all select customer_uid, -debtor_amount from cl_sale_returns where business_id = me.business_id and debtor_amount <> 0 and customer_uid is not null
      union all select customer_uid, amount from cl_credit_bf where business_id = me.business_id) x group by k having round(sum(a), 2) <> 0) y), '[]'::json));
end $fn$;

-- cl_device_itred_orders_pull as in 20261105120000_itred_order_fulfilment.sql
create or replace function public.cl_device_itred_orders_pull(p_install_id text, p_secret_phrase text, p_device_key text,
                                                   p_cursor bigint default 0, p_limit integer default 50) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; v_itred uuid; v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_rows jsonb; v_more boolean;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  v_itred := itred_vendor_of_device(v);
  if v_itred is null then return json_build_object('error', 'NOT_ON_ITRED'); end if;
  select coalesce(jsonb_agg(itred_order_json(x.id) order by x.change_seq), '[]'::jsonb) into v_rows
    from (select id, change_seq from purchase_orders where vendor_id = v_itred and change_seq > coalesce(p_cursor, 0)
           and exists (select 1 from purchase_order_items i where i.purchase_order_id = purchase_orders.id)   -- an order whose lines were refused is never shown
          order by change_seq limit v_lim) x;
  v_more := jsonb_array_length(v_rows) = v_lim;
  return json_build_object('orders', v_rows, 'more', v_more,
    'cursor', coalesce((select max((o->>'change_seq')::bigint) from jsonb_array_elements(v_rows) o), coalesce(p_cursor, 0)));
end $fn$;

-- cl_device_itred_messages_read as in 20261105120000_itred_order_fulfilment.sql
create or replace function public.cl_device_itred_messages_read(p_install_id text, p_secret_phrase text, p_device_key text, p_order_id uuid) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; v_itred uuid;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  v_itred := itred_vendor_of_device(v);
  if v_itred is null then return json_build_object('error', 'NOT_ON_ITRED'); end if;
  if not exists (select 1 from purchase_orders where id = p_order_id and vendor_id = v_itred) then return json_build_object('error', 'NOT_FOUND'); end if;
  update itred_order_messages set vendor_read_at = now() where purchase_order_id = p_order_id and author = 'customer' and vendor_read_at is null;
  return json_build_object('ok', true);
end $fn$;

-- cl_catalogue_pull as in 20261018180000_customers_wholesale.sql
create or replace function public.cl_catalogue_pull(p_install_id text, p_secret_phrase text, p_device_key text,
                                         p_cursor bigint, p_limit integer default 500)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; caller_main boolean; lim integer; cur0 bigint; nxt bigint; more boolean;
        prods json; prices json; br cl_branches%rowtype;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  select * into br from cl_branches where id = me.branch_id;
  caller_main := br.is_main;
  lim := least(greatest(coalesce(p_limit, 500), 1), 500);
  cur0 := greatest(coalesce(p_cursor, 0), 0);

  with page as (
    select * from (
      select change_seq as seq, 'p' as kind, product_uid from cl_catalogue_products where business_id = me.business_id and change_seq > cur0
      union all
      select change_seq, 'b', product_uid from cl_branch_prices where branch_id = me.branch_id and change_seq > cur0
    ) x order by seq limit lim
  )
  select coalesce((select max(seq) from page), cur0),
         (select coalesce(json_agg(json_build_object(
            'uid', c.product_uid, 'code', c.code, 'name', c.name, 'description', c.description, 'category', c.category,
            'shelf', c.shelf, 'price', c.price, 'cost', case when caller_main then c.cost end, 'low_threshold', c.low_threshold,
            'active', c.active, 'image_hash', c.image_hash, 'image_bytes', c.image_bytes, 'seq', c.change_seq,
            'wholesale_price', c.wholesale_price) order by c.change_seq), '[]'::json)   -- POS fixes (20261018180000)
            from cl_catalogue_products c join page p on p.kind = 'p' and p.product_uid = c.product_uid
           where c.business_id = me.business_id),
         (select coalesce(json_agg(json_build_object('uid', bp.product_uid, 'price', bp.price, 'seq', bp.change_seq) order by bp.change_seq), '[]'::json)
            from cl_branch_prices bp join page p on p.kind = 'b' and p.product_uid = bp.product_uid
           where bp.branch_id = me.branch_id)
    into nxt, prods, prices;
  more := exists (select 1 from cl_catalogue_products where business_id = me.business_id and change_seq > nxt)
       or exists (select 1 from cl_branch_prices where branch_id = me.branch_id and change_seq > nxt);

  return json_build_object('products', prods, 'prices', prices, 'cursor', nxt, 'more', more,
    'price_mode', br.price_mode, 'price_mode_seq', br.price_mode_seq, 'branch_id', br.id, 'is_main', caller_main,
    'business_day_cutoff', br.business_day_cutoff);
end $fn$;

-- cl_catalogue_images_pull as in 20261006120000_catalogue_sync.sql
create or replace function public.cl_catalogue_images_pull(p_install_id text, p_secret_phrase text, p_device_key text, p_uids text[])
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; res json;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  if p_uids is null or cardinality(p_uids) not between 1 and 50 then
    raise exception 'Ask for between 1 and 50 pictures at a time' using errcode = 'P0001';
  end if;
  select coalesce(json_agg(json_build_object('uid', i.product_uid, 'image_hash', i.image_hash, 'data', i.data)), '[]'::json) into res
    from cl_catalogue_images i where i.business_id = me.business_id and i.product_uid = any (p_uids);
  return json_build_object('images', res);
end $fn$;

-- cl_device_stock_levels_push as in 20261024120000_branch_stock.sql
create or replace function public.cl_device_stock_levels_push(p_install_id text, p_secret_phrase text, p_device_key text,
                                                   p_as_of text, p_full boolean, p_rows jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; r jsonb; n integer := 0; v_as timestamptz; v_key text; v_keys text[] := '{}';
        v_name text; v_qty integer; v_low integer; v_cat text; v_last timestamptz;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if not cl_bs_enabled(me.business_id) then return json_build_object('ok', true, 'enabled', false); end if;
  select * into b from cl_branches where id = me.branch_id;
  if b.stock_mode = 'shared' then return json_build_object('ok', true, 'enabled', false, 'shared', true); end if;
  if coalesce(p_as_of, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}' then v_as := null;                  -- an ISO time only ('yesterday' is a valid timestamptz)
  else begin v_as := p_as_of::timestamptz; exception when others then v_as := null; end; end if;
  if v_as is null then raise exception 'Send the time of the stock figures' using errcode = 'P0001'; end if;
  if v_as > now() + interval '1 day' then v_as := now(); end if;                     -- a till clock far ahead can't lock out later figures
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Send the products as a list of at most 5000' using errcode = 'P0001';
  end if;
  select as_of into v_last from cl_till_stock_push where terminal_id = me.id;
  if v_last is not null and v_as < v_last then
    return json_build_object('ok', true, 'enabled', true, 'stale', true, 'received', 0);   -- a newer figure is already here
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    n := n + 1;
    v_key := btrim(coalesce(r->>'k', ''));
    if v_key !~ '^[A-Za-z0-9:_-]{1,80}$' then raise exception 'Product %: its key is missing or malformed', n using errcode = 'P0001'; end if;
    if coalesce(r->>'qty', '') !~ '^-?[0-9]{1,9}$' then raise exception 'Product %: the quantity must be a whole number', n using errcode = 'P0001'; end if;
    v_qty := (r->>'qty')::integer;
    v_name := left(btrim(coalesce(r->>'name', '')), 120);
    if v_name = '' then raise exception 'Product %: the name is missing', n using errcode = 'P0001'; end if;
    v_low := case when coalesce(r->>'low', '') ~ '^[0-9]{1,7}$' then least((r->>'low')::integer, 1000000) else 0 end;
    v_cat := nullif(lower(btrim(coalesce(r->>'cat_uid', ''))), '');
    if v_cat is not null and v_cat !~ '^[0-9a-f]{32}$' then v_cat := null; end if;
    insert into cl_till_stock_levels as l (terminal_id, product_key, branch_id, cat_uid, code, name, qty, low_threshold, as_of, pushed_at)
    values (me.id, v_key, me.branch_id, v_cat, left(btrim(coalesce(r->>'code', '')), 64), v_name, v_qty, v_low, v_as, now())
    on conflict (terminal_id, product_key) do update
      set branch_id = excluded.branch_id, cat_uid = excluded.cat_uid, code = excluded.code, name = excluded.name, qty = excluded.qty,
          low_threshold = excluded.low_threshold, as_of = excluded.as_of, pushed_at = excluded.pushed_at
      where l.as_of <= excluded.as_of;
    v_keys := v_keys || v_key;
  end loop;

  if p_full then delete from cl_till_stock_levels where terminal_id = me.id and not (product_key = any (v_keys)); end if;
  insert into cl_till_stock_push as p (terminal_id, branch_id, as_of, pushed_at, full_at, products)
  values (me.id, me.branch_id, v_as, now(), case when p_full then now() end, (select count(*) from cl_till_stock_levels where terminal_id = me.id))
  on conflict (terminal_id) do update
    set branch_id = excluded.branch_id, as_of = excluded.as_of, pushed_at = excluded.pushed_at,
        full_at = coalesce(excluded.full_at, p.full_at), products = excluded.products;
  return json_build_object('ok', true, 'enabled', true, 'received', n,
    'products', (select count(*) from cl_till_stock_levels where terminal_id = me.id));
end $fn$;

-- cl_device_b4_push as in 20261113120000_sales_sync.sql
create or replace function public.cl_device_b4_push(p_install_id text, p_secret_phrase text, p_device_key text, p_events jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; e jsonb; v_res jsonb := '[]'::jsonb; v_uid text; v_kind text; v_status text; v_code text; v_msg text;
        v_cut timestamptz := now() - interval '13 months'; v_ts timestamptz;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then raise exception 'Send a list of events' using errcode = 'P0001'; end if;
  if jsonb_array_length(p_events) > 100 then raise exception 'At most 100 events at a time' using errcode = 'P0001'; end if;
  for e in select x from jsonb_array_elements(p_events) x loop
    v_uid := btrim(coalesce(e->>'uid', '')); v_kind := coalesce(e->>'kind', ''); v_code := null; v_msg := null;
    begin
      if v_uid !~ '^[A-Za-z0-9-]{8,160}$' then
        v_status := 'refused'; v_code := 'BAD_EVENT'; v_msg := 'The event has no uid.';
      elsif v_kind not in ('sale', 'return', 'credit_payment', 'payout', 'eod', 'credit_override', 'price_change', 'voucher_issue', 'voucher_use', 'credit_bf') then
        v_status := 'refused'; v_code := 'BAD_EVENT'; v_msg := 'Unknown kind of event.';
      elsif me.device_kind = 'seat' and v_kind <> 'price_change' then
        v_status := 'refused'; v_code := 'SEAT_NO_SELLING'; v_msg := 'An Office seat can''t sell, take payments or run End of Day.';
      else
        v_ts := nullif(e->>'ts', '')::timestamptz;
        if v_kind <> 'credit_bf' and v_ts is not null and v_ts < v_cut then
          v_status := 'refused'; v_code := 'TOO_OLD'; v_msg := 'Older than the 13 months seiGEN keeps.';
        else
          if me.device_kind = 'seat' then perform cl_seat_need('edit_prices'); end if;   -- a seat's price change needs the signed-in person's right
          v_status := cl_b4_store(me, e);
        end if;
      end if;
    exception when others then
      v_status := 'refused';
      v_code := case when sqlerrm like 'SEAT_NO_RIGHT%' then 'SEAT_NO_RIGHT' when sqlerrm like 'SEAT_SIGN_IN%' then 'SEAT_SIGN_IN' when sqlerrm like 'BAD_EVENT%' then 'BAD_EVENT' else 'INVALID' end;
      v_msg := left(regexp_replace(sqlerrm, '^[A-Z_]+: ', ''), 200);
    end;
    v_res := v_res || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('uid', v_uid, 'kind', v_kind, 'status', v_status, 'code', v_code, 'message', v_msg)));
  end loop;
  perform cl_b4_retention(me.business_id);
  return json_build_object('ok', true, 'server_time', now(), 'results', v_res);
end $fn$;

-- cl_device_dispatch_costs as in 20261107120000_shop_roles.sql
create or replace function public.cl_device_dispatch_costs(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text, p_dispatch_id uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; d cl_dispatches%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into d from cl_dispatches where id = p_dispatch_id and business_id = me.business_id;
  if not found then return json_build_object('error', 'NOT_FOUND', 'message', 'That Delivery Note isn''t on seiGEN for this business.'); end if;
  if not cl_staff_has(p_staff_token, me.id, 'costs') then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Costs need a signed-in person with "View costs".');
  end if;
  return json_build_object('id', d.id,
    'lines', coalesce((select json_agg(json_build_object('line_no', l.line_no, 'unit_cost', l.unit_cost) order by l.line_no) from cl_dispatch_lines l where l.dispatch_id = d.id), '[]'::json),
    'charge', (select json_build_object('amount', ch.amount, 'currency', ch.currency) from cl_interbranch_charges ch where ch.dispatch_id = d.id limit 1));
end $fn$;

-- cl_device_branch_report as in 20261113120000_sales_sync.sql
create or replace function public.cl_device_branch_report(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text,
                                               p_kind text, p_branch_id uuid, p_from timestamptz default null, p_to timestamptz default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; v_costs boolean; v_from timestamptz := coalesce(p_from, '-infinity'); v_to timestamptz := coalesce(p_to, 'infinity');
        v_rows json;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into b from cl_branches where id = p_branch_id and business_id = me.business_id;
  if b.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That branch isn''t in this business.'); end if;
  if b.id <> me.branch_id and not cl_staff_has(p_staff_token, me.id, 'other_branches') then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Other branches'' reports need a signed-in person with "View other branches'' reports".');
  end if;
  v_costs := cl_staff_has(p_staff_token, me.id, 'costs');
  if p_kind = 'inventory' then
    v_rows := coalesce((select json_agg(x order by x.name) from (
      select g.k, g.cat_uid, g.code, g.name, g.qty, g.low,
             case when v_costs then c.cost end as cost, case when v_costs then round((g.qty * c.cost)::numeric, 2) end as value
        from (select l.product_key k, max(l.cat_uid) cat_uid, max(l.code) code, max(l.name) name, sum(l.qty)::bigint qty, max(l.low_threshold) low
                from cl_till_stock_levels l join cl_terminals t on t.id = l.terminal_id
               where b.stock_mode <> 'shared' and l.branch_id = b.id and t.active and t.branch_id = b.id
               group by l.product_key
              union all
              select s.product_uid, s.product_uid, c2.code, c2.name, s.total::bigint, c2.low_threshold
                from cl_branch_stock s join cl_catalogue_products c2 on c2.business_id = s.business_id and c2.product_uid = s.product_uid
               where b.stock_mode = 'shared' and s.branch_id = b.id) g
        left join cl_catalogue_products c on c.business_id = me.business_id and c.product_uid = coalesce(g.cat_uid, g.k)) x), '[]'::json);
  elsif p_kind = 'dispatches' then
    v_rows := coalesce((select json_agg(x order by x.sent_at desc) from (
      select d.id, d.dn_display, case when d.from_branch_id = b.id then 'out' else 'in' end as direction,
             (select name from cl_branches where id = case when d.from_branch_id = b.id then d.to_branch_id else d.from_branch_id end) as other_branch,
             d.status, d.sent_at, d.sent_by, d.received_at, d.grv_display, d.grv_by, d.internal_ref,
             d.delivery_cost, d.delivery_currency,
             case when v_costs then (select json_build_object('amount', ch.amount, 'currency', ch.currency) from cl_interbranch_charges ch where ch.dispatch_id = d.id limit 1) end as charge,
             (select coalesce(json_agg(json_build_object('line_no', l.line_no, 'code', l.code, 'name', l.name, 'qty', l.qty, 'received', l.received,
                 'short', l.short, 'damaged', l.damaged, 'extra', l.extra, 'unit_cost', case when v_costs then l.unit_cost end) order by l.line_no), '[]'::json)
                from cl_dispatch_lines l where l.dispatch_id = d.id) as lines
        from cl_dispatches d
       where d.business_id = me.business_id and (d.from_branch_id = b.id or d.to_branch_id = b.id) and d.sent_at between v_from and v_to
       order by d.sent_at desc limit 500) x), '[]'::json);
  elsif p_kind = 'supplier_grvs' then
    v_rows := coalesce((select json_agg(x order by x.posted_at desc) from (
      select g.id, g.grv_display, g.posted_at, g.received_by, g.invoice_no, sp.name as supplier, t.till_code as till,
             case when v_costs then g.delivery_cost end as delivery_cost, g.delivery_currency,
             (select coalesce(json_agg(json_build_object('line_no', l.line_no, 'code', l.code, 'name', l.name, 'qty', l.qty,
                 'unit_cost', case when v_costs then l.unit_cost end, 'landed_cost', case when v_costs then l.landed_cost end) order by l.line_no), '[]'::json)
                from cl_supplier_grv_lines l where l.grv_id = g.id) as lines
        from cl_supplier_grvs g join cl_suppliers sp on sp.id = g.supplier_id left join cl_terminals t on t.id = g.terminal_id
       where g.business_id = me.business_id and g.branch_id = b.id and g.posted_at between v_from and v_to
       order by g.posted_at desc limit 500) x), '[]'::json);
  elsif p_kind = 'sales' then                                                  -- B4 (decision 38): sales and returns, costs only with "View costs"
    v_rows := coalesce((select json_agg(x.j order by x.at) from (                 -- B4
      select s.sold_at as at, json_build_object('type', 'sale', 'uid', s.uid, 'doc', s.receipt_no, 'at', s.sold_at, 'till', t.till_code, 'operator', s.operator,   -- B4
             'customer_uid', s.customer_uid, 'customer', case s.customer_uid when 'b1170000000000000000000000000001' then 'Cash Sale' when 'b1170000000000000000000000000002' then 'Wholesale' else c.name end,   -- B4
             'customer_type', case when s.customer_uid in ('b1170000000000000000000000000001', 'b1170000000000000000000000000002') then 'builtin_' || case s.customer_uid when 'b1170000000000000000000000000001' then 'cash_sale' else 'wholesale' end else c.customer_type end,   -- B4
             'price_level', s.price_level, 'subtotal', s.subtotal, 'discount', s.discount, 'total', s.total, 'voucher_amount', s.voucher_amount,   -- B4
             'method', (select string_agg(distinct p->>'method', '+') from jsonb_array_elements(s.payments) p), 'doc_ref', s.doc_ref,   -- B4
             'credit_amount', s.credit_amount, 'credit_check', s.credit_check, 'credit_scope', s.credit_scope, 'credit_before', s.credit_before,   -- B4
             'credit_after', s.credit_after, 'credit_limit_at', s.credit_limit_at, 'credit_override', s.credit_override, 'credit_override_mode', s.credit_override_mode,   -- B4
             'cost', case when v_costs then s.cost_total end, 'history', s.history) as j   -- B4
        from cl_sales s left join cl_customers c on c.business_id = s.business_id and c.customer_uid = s.customer_uid left join cl_terminals t on t.id = s.terminal_id   -- B4
       where s.business_id = me.business_id and s.branch_id = b.id and s.sold_at between v_from and v_to   -- B4
      union all   -- B4
      select r.returned_at, json_build_object('type', 'return', 'uid', r.uid, 'doc', r.cn_display, 'at', r.returned_at, 'till', t.till_code, 'sale_receipt', r.sale_receipt,   -- B4
             'customer_uid', r.customer_uid, 'customer', c.name, 'reason', r.reason, 'approved_by', r.approved_by, 'total', r.goods_total, 'debtor_amount', r.debtor_amount,   -- B4
             'cost', case when v_costs then r.cost_reversed end, 'history', r.history)   -- B4
        from cl_sale_returns r left join cl_customers c on c.business_id = r.business_id and c.customer_uid = r.customer_uid left join cl_terminals t on t.id = r.terminal_id   -- B4
       where r.business_id = me.business_id and r.branch_id = b.id and r.returned_at between v_from and v_to   -- B4
       order by 1 desc limit 3000) x), '[]'::json);   -- B4
  elsif p_kind = 'payouts' then   -- B4
    v_rows := coalesce((select json_agg(x order by x.at) from (   -- B4
      select p.uid, p.paid_at as at, t.till_code as till, p.reason, p.amount, p.currency, p.account_tag, p.operator, p.history   -- B4
        from cl_payouts p left join cl_terminals t on t.id = p.terminal_id   -- B4
       where p.business_id = me.business_id and p.branch_id = b.id and p.paid_at between v_from and v_to   -- B4
       order by p.paid_at desc limit 2000) x), '[]'::json);   -- B4
  else
    raise exception 'Say which report: inventory, dispatches, supplier_grvs, sales or payouts' using errcode = 'P0001';   -- B4
  end if;
  return json_build_object('server_time', now(), 'kind', p_kind, 'branch_id', b.id, 'branch', b.name, 'costs', v_costs, 'rows', v_rows);
end $fn$;

-- cl_assign_rpn as in 20261015120000_rpn_commissions.sql
create or replace function public.cl_assign_rpn(p_business_id uuid, p_vendor_id uuid, p_rpn_id uuid, p_reason text) returns json
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

-- cl_resolve_rpn_conflict as in 20261015120000_rpn_commissions.sql
create or replace function public.cl_resolve_rpn_conflict(p_assignment_id bigint, p_accept boolean, p_reason text) returns json
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

-- cl_device_rpn_status as in 20261015120000_rpn_commissions.sql
create or replace function public.cl_device_rpn_status(p_install_id text, p_secret_phrase text, p_device_key text) returns json
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

create or replace function public.cl_shop_default_rights(p_builtin text) returns text[]
language sql immutable as $$
  select case p_builtin
    when 'owner' then public.cl_shop_rights_all()
    when 'admin' then array_remove(public.cl_shop_rights_all(), 'owner')
    when 'manager' then array['m.sell', 'm.products', 'm.credit', 'm.reports', 'm.marketing', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming',
                              'm.productlist', 'm.stocktake', 'm.requests', 'm.purchasing', 'm.reportwriter', 'm.directory', 'm.eod',
                              'costs', 'edit_prices', 'create_customers', 'review_requisitions', 'other_branches',
                              'approve_writeoffs', 'void_return', 'credit_over_limit', 'sales_reports']::text[]
    when 'stores' then array['m.products', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming', 'm.productlist', 'm.stocktake',
                             'm.purchasing', 'm.reports', 'm.reportwriter']::text[]
    when 'cashier' then array['m.sell', 'm.credit', 'm.productlist', 'm.directory', 'm.requests', 'm.reports', 'm.eod', 'sales_reports']::text[]
  end
$$;
create or replace function public.cl_shop_ensure_roles(p_business uuid) returns void
language sql security definer set search_path = public as $$
  insert into cl_shop_roles (business_id, name, builtin, rights, updated_by)
  select p_business, v.n, v.b, cl_shop_default_rights(v.b), 'seiGEN'
    from (values ('Owner', 'owner', 1), ('Admin', 'admin', 2), ('Manager', 'manager', 3), ('Stores', 'stores', 4), ('Cashier', 'cashier', 5)) v(n, b, o)
   where not exists (select 1 from cl_shop_roles r where r.business_id = p_business and r.builtin = v.b)
   order by v.o
  on conflict do nothing
$$;

drop function if exists public.cl_caller_rights();
drop function if exists public.cl_guest_seat_refuse();
drop function if exists public.cl_guest_seat();
drop function if exists public.cl_seat_is_guest(uuid);
drop function if exists public.cl_seat_person(uuid);
drop function if exists public.cl_shop_guest_ok(public.cl_shop_staff, uuid);
drop function if exists public.cl_till_rights_note(public.cl_terminals, uuid, text, text);

delete from public.cl_shop_roles where builtin = 'guest';
alter table public.cl_shop_roles drop constraint cl_shop_roles_builtin_check;
alter table public.cl_shop_roles add constraint cl_shop_roles_builtin_check
  check (builtin in ('owner', 'admin', 'manager', 'stores', 'cashier'));
alter table public.cl_shop_staff drop column guest_until;
drop table if exists public.cl_till_rights_log;
alter table public.cl_terminals drop column staff_mode, drop column staff_mode_ts, drop column staff_mode_by;

notify pgrst, 'reload schema';

commit;
