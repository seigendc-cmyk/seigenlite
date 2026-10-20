-- Rollback of 20261108120000_shop_managers_everywhere.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Puts cl_shop_session, cl_shop_staff_json and cl_device_staff_signin back
-- exactly as 20261107120000_shop_roles left them and drops the two helpers.
-- Owners, Admins and Staff holders are then again allowed at their home branch
-- and "also works at" only: their tokens at other branches stop working and
-- the next pull there drops their PIN data. No data is lost.

begin;

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
     and (t.branch_id = s.home_branch_id or t.branch_id = any(s.other_branches))
$$;

create or replace function public.cl_shop_staff_json(s public.cl_shop_staff, p_branch uuid, p_terminal uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'role_id', s.role_id, 'home_branch_id', s.home_branch_id,
           'home_branch', (select b.name from cl_branches b where b.id = s.home_branch_id),
           'other_branches', to_jsonb(s.other_branches), 'active', s.active, 'seq', s.change_seq,
           'has_pin', s.pin_check is not null or jsonb_array_length(s.legacy_pins) > 0,
           'pins_from_tills', jsonb_array_length(s.legacy_pins),
           'here', s.active and (p_branch = s.home_branch_id or p_branch = any(s.other_branches)))
      || case when s.active and (p_branch = s.home_branch_id or p_branch = any(s.other_branches)) then
           jsonb_build_object('pin_salt', s.pin_salt, 'pin_check', s.pin_check, 'pin_rounds', s.pin_rounds,
             'legacy', (select coalesce(jsonb_agg(jsonb_build_object('salt', e->>'salt', 'hash', e->>'hash')), '[]'::jsonb)
                          from jsonb_array_elements(s.legacy_pins) e where e->>'terminal_id' = p_terminal::text))
         else '{}'::jsonb end
$$;

create or replace function public.cl_device_staff_signin(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_id uuid, p_pin text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; s cl_shop_staff%rowtype; r cl_shop_roles%rowtype; n_fail int; v_ok boolean := false; v_legacy boolean := false; v_token text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into s from cl_shop_staff where id = p_staff_id and business_id = me.business_id for update;
  if not found or not s.active then return json_build_object('error', 'NOT_FOUND', 'message', 'That person isn''t active at this business.'); end if;
  if not (me.branch_id = s.home_branch_id or me.branch_id = any(s.other_branches)) then
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

drop function public.cl_shop_staff_at(public.cl_shop_staff, uuid);
drop function public.cl_shop_staff_everywhere(uuid);

commit;
