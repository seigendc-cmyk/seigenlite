-- Rollback of 20261023180000_update_app_first_message.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Puts back the 20261023120000 wording of the UPDATE_MAIN_FIRST refusal
-- ("Update the main branch till first. ..."). Only that text changes.

begin;

create or replace function public.cl_branch_issue_join_code(
  p_install_id text, p_secret_phrase text, p_device_key text,
  p_branch_id uuid default null, p_new_branch_name text default null, p_valid_hours int default 24,
  p_admin_salt text default null, p_admin_check text default null, p_admin_rounds int default null)   -- admin passcode from main
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; me cl_terminals%rowtype; target cl_branches%rowtype; code text; exp timestamptz;
        v_max integer;   -- Price plans (20261013120000)
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  -- admin passcode from main: a code without the new device's Admin check value comes from an older main build
  if not cl_admin_seed_ok(p_admin_salt, p_admin_check, p_admin_rounds) then
    raise exception 'UPDATE_MAIN_FIRST: Update the main branch till first. It sets the new device''s Admin passcode when it issues the code.' using errcode = 'P0001';
  end if;
  select t.* into me from cl_terminals t join cl_branches b on b.id = t.branch_id
   where t.vendor_id = v.id and t.active and b.is_main;
  if not found then raise exception 'Only a main-branch terminal can add terminals' using errcode = 'P0001'; end if;

  if (p_branch_id is null) = (nullif(btrim(coalesce(p_new_branch_name,'')), '') is null) then
    raise exception 'Give either a branch or a new branch name';
  end if;
  -- Price plans (20261013120000): the business's plan may limit its branches (Lite: one).
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
      insert into cl_branches (business_id, name, is_main) values (me.business_id, btrim(p_new_branch_name), false)
      returning * into target;
    end if;
  end if;

  exp := now() + make_interval(hours => greatest(1, least(coalesce(p_valid_hours, 24), 72)));
  loop
    code := cl_new_join_code();
    begin
      insert into cl_branch_join_codes (branch_id, code_hash, issued_by_terminal, expires_ts,
                                        admin_salt, admin_check, admin_rounds)                  -- admin passcode from main
      values (target.id, encode(extensions.digest(code, 'sha256'), 'hex'), me.id, exp,
              p_admin_salt, p_admin_check, p_admin_rounds);
      exit;
    exception when unique_violation then -- astronomically rare: draw again
    end;
  end loop;
  return json_build_object('code', substr(code,1,4) || '-' || substr(code,5,4),
    'branch_id', target.id, 'branch_name', target.name, 'expires_ts', exp);
end $fn$;

commit;
