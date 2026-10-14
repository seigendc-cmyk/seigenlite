-- =====================================================================
-- A clearer refusal when an app too old to send the Admin check value asks
-- for a join code (owner, 2026-10-14: IVO Motor Spares' main till on v20 was
-- told "Update the main branch till first" while it WAS the main till).
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261023180000_update_app_first_message.rollback.sql
-- Tested in PGlite: supabase/tests/update-app-first-message-test.js
--
-- Changes:
--   cl_branch_issue_join_code   only the message text (same signature, same
--                               grants, same code UPDATE_MAIN_FIRST so apps
--                               that know the code still recognise it):
--     was: "Update the main branch till first. It sets the new device's Admin passcode when it issues the code."
--     now: "This version of the app is too old to add terminals. Update this app, then try again."
-- Nothing else changes; no data is touched.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
begin
  if to_regprocedure('public.cl_branch_issue_join_code(text,text,text,uuid,text,integer,text,text,integer)') is null then
    raise exception 'update_app_first_message aborted: cl_branch_issue_join_code (9 args, from 20261023120000) is missing. Nothing was changed.';
  end if;
  if exists (select 1 from pg_proc where oid = to_regprocedure('public.cl_branch_issue_join_code(text,text,text,uuid,text,integer,text,text,integer)') and prosrc like '%too old to add terminals%') then
    raise exception 'update_app_first_message aborted: already there. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_proc where oid = to_regprocedure('public.cl_branch_issue_join_code(text,text,text,uuid,text,integer,text,text,integer)') and prosrc like '%UPDATE_MAIN_FIRST: Update the main branch till first.%') then
    raise exception 'update_app_first_message aborted: cl_branch_issue_join_code is not the 20261023120000 version. Nothing was changed.';
  end if;
end $$;

-- 1. Issuing a join code (20261023120000 body; only the marked line changes) --
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
    raise exception 'UPDATE_MAIN_FIRST: This version of the app is too old to add terminals. Update this app, then try again.' using errcode = 'P0001';   -- clearer message (20261023180000)
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
