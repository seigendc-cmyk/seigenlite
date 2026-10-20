-- =====================================================================
-- Staff managers sign in on every till (owner, 2026-10-16: "Owner and Admin
-- (and any role with the Staff right) must sign in on EVERY till of the
-- business, all branches. Other roles may stay limited to their branch").
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261108120000_shop_managers_everywhere.rollback.sql
-- Tested in PGlite: supabase/tests/shop-managers-everywhere-test.js (and the
-- app's test/staff-deadlock.test.js against this SQL)
--
-- Until now (20261107120000_shop_roles) a person could sign in only at their
-- home branch and the branches ticked under "also works at", whatever their
-- role, in three places: the pull (who gets the PIN check value), the
-- sign-in (NOT_HERE) and every token check (cl_shop_session).
-- From here a person whose role is Owner or Admin, or holds the Staff right
-- (m.staff), is allowed at every branch of the business; everyone else keeps
-- their home branch + "also works at". Taking Staff away from a role (or
-- moving the person to another role) takes the other branches away at once:
-- their tokens there stop working and the next pull drops their PIN data.
--   cl_shop_staff_everywhere(role)   the role rule above
--   cl_shop_staff_at(staff, branch)  home, "also works at", or everywhere
--   cl_shop_session                  the token check uses cl_shop_staff_at
--   cl_shop_staff_json               'here' (and so the PIN check value) uses
--                                    it; new key 'everywhere' (the apps from
--                                    v30 word their guidance by it)
--   cl_device_staff_signin           NOT_HERE uses it
-- An old PIN from a till's list still works on that till only. No table, no
-- data and no grant to devices changes.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'function cl_shop_session (20261107120000)' n where to_regprocedure('public.cl_shop_session(text,uuid)') is null
    union all select 'function cl_shop_staff_json (20261107120000)' where to_regprocedure('public.cl_shop_staff_json(public.cl_shop_staff,uuid,uuid)') is null
    union all select 'function cl_device_staff_signin (20261107120000)' where to_regprocedure('public.cl_device_staff_signin(text,text,text,uuid,text)') is null
  ) x;
  if missing is not null then raise exception 'shop_managers_everywhere aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'function ' || proname n from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cl_shop_staff_everywhere', 'cl_shop_staff_at')
  ) x;
  if conflicts is not null then raise exception 'shop_managers_everywhere aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;

-- 1. The rule ------------------------------------------------------------
create function public.cl_shop_staff_everywhere(p_role uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from cl_shop_roles r where r.id = p_role and (r.builtin in ('owner', 'admin') or 'm.staff' = any(r.rights)))
$$;
create function public.cl_shop_staff_at(p_staff public.cl_shop_staff, p_branch uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_branch is not null and (p_branch = p_staff.home_branch_id or p_branch = any(p_staff.other_branches) or cl_shop_staff_everywhere(p_staff.role_id))
$$;

-- 2. Sessions --------------------------------------------------------------
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

-- 3. The pull's person ------------------------------------------------------
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

-- 4. Sign-in -----------------------------------------------------------------
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

-- 5. Who may call what (the helpers are internal; the device grant is unchanged) ----
revoke all on function public.cl_shop_staff_everywhere(uuid), public.cl_shop_staff_at(public.cl_shop_staff, uuid) from public, anon, authenticated;

commit;
