-- Rollback of 20261110120000_staff_first_owner.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Puts cl_device_staff_pull, cl_device_staff_upload, cl_device_staff_save back exactly as 20261107120000_shop_roles left
-- them and drops cl_vendor_staff_events and cl_shop_staff_events (the log
-- lines are lost; no staff, role or PIN changes).

begin;

drop function public.cl_vendor_staff_events(uuid);

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

create or replace function public.cl_device_staff_upload(p_install_id text, p_secret_phrase text, p_device_key text, p_staff jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_main boolean; e jsonb; v_name text; v_key text; v_role uuid; v_kind text; v_id uuid;
        v_admin uuid; v_cashier uuid; v_custrole uuid; v_pin jsonb; v_active boolean; n_add int := 0; n_merge int := 0; cur cl_shop_staff%rowtype;
        v_cur_builtin text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  perform 1 from cl_businesses where id = me.business_id for update;   -- one upload at a time per business
  if exists (select 1 from cl_shop_legacy_uploads where terminal_id = me.id) then return json_build_object('ok', true, 'already', true); end if;
  if me.registered_ts > (select v from cl_shop_meta where k = 'legacy_cutoff') then
    return json_build_object('error', 'NOT_NEEDED', 'message', 'This till joined after the staff moved to seiGEN, so it has no old staff list to send.');
  end if;
  select is_main into v_main from cl_branches where id = me.branch_id;
  if not exists (select 1 from cl_shop_roles where business_id = me.business_id) then
    if not coalesce(v_main, false) then
      return json_build_object('error', 'ROLES_NOT_READY', 'message', 'The main branch sends its staff first. This till tries again at its next check-in.');
    end if;
    perform cl_shop_ensure_roles(me.business_id);
  end if;
  if p_staff is null or jsonb_typeof(p_staff) <> 'array' or jsonb_array_length(p_staff) > 200 then
    raise exception 'Send the staff as a list (at most 200)' using errcode = 'P0001';
  end if;
  select id into v_admin from cl_shop_roles where business_id = me.business_id and builtin = 'admin';
  select id into v_cashier from cl_shop_roles where business_id = me.business_id and builtin = 'cashier';
  for e in select * from jsonb_array_elements(p_staff) loop
    v_name := left(btrim(regexp_replace(coalesce(e->>'name', ''), '\s+', ' ', 'g')), 60);
    continue when v_name = '';
    v_key := lower(replace(v_name, ' ', ''));
    v_kind := case when e->>'role' = 'Admin' then 'admin' when coalesce((e->>'can_create_customers')::boolean, false) then 'cust' else 'cashier' end;
    if v_kind = 'cust' then
      select id into v_custrole from cl_shop_roles where business_id = me.business_id and builtin is null and lower(name) = 'cashier + customers';
      if v_custrole is null then
        insert into cl_shop_roles (business_id, name, rights, updated_by)
        values (me.business_id, 'Cashier + customers', cl_shop_default_rights('cashier') || 'create_customers'::text, 'seiGEN')
        returning id into v_custrole;
      end if;
    end if;
    v_role := case v_kind when 'admin' then v_admin when 'cust' then v_custrole else v_cashier end;
    v_active := coalesce((e->>'active')::boolean, true);
    v_pin := case when coalesce(e->>'pin_hash', '') ~ '^[0-9a-f]{64}$' and coalesce(e->>'pin_salt', '') <> '' and length(e->>'pin_salt') <= 64
                  then jsonb_build_object('terminal_id', me.id, 'salt', e->>'pin_salt', 'hash', e->>'pin_hash') end;
    select * into cur from cl_shop_staff
     where business_id = me.business_id and home_branch_id = me.branch_id and lower(replace(name, ' ', '')) = v_key
     order by created_at limit 1;
    if cur.id is null then
      insert into cl_shop_staff (business_id, name, role_id, home_branch_id, active, legacy_pins, created_terminal, updated_by)
      values (me.business_id, v_name, v_role, me.branch_id, v_active, case when v_pin is null then '[]'::jsonb else jsonb_build_array(v_pin) end,
              me.id, 'moved from till ' || me.till_code);
      n_add := n_add + 1;
    else
      -- the same person from another till: both PINs keep working on their own tills; nobody loses access
      select builtin into v_cur_builtin from cl_shop_roles where id = cur.role_id;
      update cl_shop_staff set
        legacy_pins = case when v_pin is null or legacy_pins @> jsonb_build_array(v_pin) then legacy_pins else legacy_pins || jsonb_build_array(v_pin) end,
        active = active or v_active,
        role_id = case when v_kind = 'admin' and coalesce(v_cur_builtin, '') not in ('owner', 'admin') then v_admin
                       when v_kind = 'cust' and v_cur_builtin = 'cashier' then v_custrole else role_id end,
        change_seq = nextval('cl_shop_seq'), updated_at = now(), updated_by = 'moved from till ' || me.till_code
       where id = cur.id;
      n_merge := n_merge + 1;
    end if;
    v_custrole := null;
  end loop;
  insert into cl_shop_legacy_uploads (terminal_id, staff) values (me.id, n_add + n_merge);
  return json_build_object('ok', true, 'added', n_add, 'merged', n_merge);
end $fn$;

create or replace function public.cl_device_staff_save(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text, p_staff jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; v_boot boolean; v_main boolean; v_owner_ok boolean; cur cl_shop_staff%rowtype; v_cur_tb text;
        v_role cl_shop_roles%rowtype; v_name text; v_home uuid; v_others uuid[]; v_active boolean; v_id uuid; v_problem text; v_pin text; s cl_shop_staff%rowtype; v_by text;
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
  return json_build_object('ok', true, 'staff', cl_shop_staff_json(s, me.branch_id, me.id));
end $fn$;

drop table public.cl_shop_staff_events;

commit;
