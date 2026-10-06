-- =====================================================================
-- Multi-terminal sync, Phase 2 (server part): deactivate a till, and the
-- server's branch-name key made equal to the app's rule.
-- Design: docs/multi-terminal/phase2-design.md §4 (D11, §4.1, §4.2),
-- approved 2026-10-04 ("go Phase 2B"). Applied live only after the owner
-- has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261004180000_multi_terminal_phase2.rollback.sql
-- Tested in PGlite: supabase/tests/multi-terminal-phase2-test.js
--
-- Changes:
--   1. cl_branch_key(): accents folded (NFKD), letters/digits only, lower
--      case, first 24 characters, 'branch' if nothing is left: the same as
--      the app's sanitizeBranchName() (src/docnum.js) lowercased. The
--      unique index on (business_id, cl_branch_key(name)) is dropped and
--      created again.
--   2. New cl_terminal_set_active(): a main-branch till deactivates or
--      reactivates another till of its business (never itself). Logged to
--      cl_activity_log with staff_id null and the acting till in detail.
--   3. cl_branch_register() / cl_terminal_join(): an inactive till's
--      install gets { error: 'TERMINAL_INACTIVE' } and can't register or
--      join anywhere. Nothing else in either body changes.
--   4. cl_device_checkin(): one more reply key, terminal_active (boolean,
--      null when the install isn't a terminal). Check-in is NOT refused
--      for an inactive till: licensing stays per install.
--
-- Checked read-only against the live project on 2026-10-04:
--   * the four functions above are byte-for-byte (whitespace aside) the
--     Phase 1 migration's bodies, so the bodies below are those plus the
--     marked changes (backup: docs/multi-terminal/live-backup-phase2-*/);
--   * normalize() is immutable, the database encoding is UTF8;
--   * 3 branches, 0 collisions under the new key; 5 tills, all active;
--   * cl_activity_log.staff_id is nullable.
-- Apply by hand in the SQL editor, in one transaction (no migrations table).
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text; dupes text;
begin
  select string_agg(n, ', ') into missing from (
    select 'table cl_terminals' n where to_regclass('public.cl_terminals') is null
    union all select 'table cl_branches' where to_regclass('public.cl_branches') is null
    union all select 'table cl_activity_log' where to_regclass('public.cl_activity_log') is null
    union all select 'index cl_branches_name_uidx' where to_regclass('public.cl_branches_name_uidx') is null
    union all select 'function cl_branch_key(text)' where to_regprocedure('public.cl_branch_key(text)') is null
    union all select 'function cl_install_vendor' where to_regprocedure('public.cl_install_vendor(text,text,text,boolean,text,text)') is null
    union all select 'function cl_terminal_json(uuid)' where to_regprocedure('public.cl_terminal_json(uuid)') is null
    union all select 'function cl_branch_register (8 args)' where to_regprocedure(
      'public.cl_branch_register(text,text,text,text,text,text,text,text)') is null
    union all select 'function cl_terminal_join (10 args)' where to_regprocedure(
      'public.cl_terminal_join(text,text,text,text,text,text,text,text,text,text)') is null
    union all select 'function cl_device_checkin (10 args)' where to_regprocedure(
      'public.cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text)') is null
  ) x;
  if missing is not null then raise exception 'multi_terminal_phase2 aborted: missing %. Nothing was changed.', missing; end if;

  select string_agg(n, ', ') into conflicts from (
    select 'function cl_terminal_set_active' n where exists (select 1 from pg_proc
      where pronamespace = 'public'::regnamespace and proname = 'cl_terminal_set_active')
  ) x;
  if conflicts is not null then raise exception 'multi_terminal_phase2 aborted: already exists: %. Nothing was changed.', conflicts; end if;

  -- two branch names of one business that the new key would make equal
  select string_agg(format('%s: %s', business_id, names), '; ') into dupes from (
    select business_id, string_agg(quote_literal(name), ' = ' order by name) names
      from public.cl_branches
     group by business_id,
              coalesce(nullif(lower(left(regexp_replace(normalize(coalesce(name, ''), NFKD), '[^A-Za-z0-9]', '', 'g'), 24)), ''), 'branch')
    having count(*) > 1
  ) d;
  if dupes is not null then raise exception 'multi_terminal_phase2 aborted: branch names that the new key makes equal: %. Nothing was changed.', dupes; end if;
end $$;


-- 1. Branch-name key = the app's rule ------------------------------------
-- The index is dropped and created again rather than REINDEXed: a session
-- caches an index's expression with this SQL function's body inlined, so a
-- REINDEX in the same session would rebuild it with the OLD body (found in
-- the PGlite test). A newly created index reads the new body.
drop index public.cl_branches_name_uidx;
create or replace function public.cl_branch_key(p text) returns text
language sql immutable as $$
  select coalesce(nullif(lower(left(regexp_replace(normalize(coalesce(p, ''), NFKD), '[^A-Za-z0-9]', '', 'g'), 24)), ''), 'branch')
$$;
revoke execute on function public.cl_branch_key(text) from public, anon, authenticated;
create unique index cl_branches_name_uidx on public.cl_branches (business_id, public.cl_branch_key(name));


-- 2. Deactivate / reactivate a till -------------------------------------
create function public.cl_terminal_set_active(
  p_install_id text, p_secret_phrase text, p_device_key text, p_terminal_id uuid, p_active boolean)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; me cl_terminals%rowtype; t cl_terminals%rowtype;
begin
  if p_active is null then raise exception 'Say whether the till is active' using errcode = 'P0001'; end if;
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  select tt.* into me from cl_terminals tt join cl_branches b on b.id = tt.branch_id
   where tt.vendor_id = v.id and tt.active and b.is_main;
  if not found then raise exception 'Only a main-branch terminal can change terminals' using errcode = 'P0001'; end if;
  select * into t from cl_terminals where id = p_terminal_id and business_id = me.business_id for update;
  if not found then raise exception 'Terminal not found in this business' using errcode = 'P0001'; end if;
  if t.id = me.id and not p_active then raise exception 'A till cannot deactivate itself' using errcode = 'P0001'; end if;
  if t.active is distinct from p_active then
    update cl_terminals set active = p_active where id = t.id;
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (null, case when p_active then 'terminal_reactivated' else 'terminal_deactivated' end, 'cl_terminals', t.id,
            jsonb_build_object('till_code', t.till_code, 'branch_id', t.branch_id, 'by_terminal', me.id, 'by_till', me.till_code));
  end if;
  return (cl_terminal_json(t.id)::jsonb || jsonb_build_object('active', p_active))::json;
end $fn$;
grant execute on function public.cl_terminal_set_active(text, text, text, uuid, boolean) to anon, authenticated;


-- 3. Register / join refuse an inactive till ------------------------------
-- Phase 1 bodies; the only change is the marked TERMINAL_INACTIVE check.
create or replace function public.cl_branch_register(
  p_install_id text, p_secret_phrase text, p_device_key text,
  p_business_name text, p_branch_name text, p_legacy_branch_id text default null,
  p_label text default null, p_device_code text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; t cl_terminals%rowtype; biz uuid; br uuid;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, true, p_business_name, p_device_code);

  select * into t from cl_terminals where vendor_id = v.id;
  if found then
    if not t.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;   -- Phase 2
    if not (select is_main from cl_branches where id = t.branch_id) then
      raise exception 'This device already belongs to a branch that is not the main branch' using errcode = 'P0001';
    end if;
    return cl_terminal_json(t.id);
  end if;
  if v.business_id is not null then
    raise exception 'This device is already linked to a business' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_branch_name,''))) = 0 then raise exception 'Branch name is required'; end if;

  insert into cl_businesses (name, secret_phrase_hash, created_by_vendor_id)
  values (coalesce(nullif(btrim(coalesce(p_business_name,'')), ''), v.business_name),
          extensions.crypt(cl_norm_phrase(p_secret_phrase), extensions.gen_salt('bf')), v.id)
  returning id into biz;
  insert into cl_branches (business_id, name, is_main, legacy_branch_id)
  values (biz, btrim(p_branch_name), true, nullif(p_legacy_branch_id, '')) returning id into br;
  update cl_vendors set business_id = biz where id = v.id;
  insert into cl_terminals (business_id, branch_id, vendor_id, install_id, till_code, label, last_seen_ts)
  values (biz, br, v.id, v.install_id, 'T1', nullif(btrim(coalesce(p_label,'')), ''), now()) returning * into t;
  return cl_terminal_json(t.id);
end $fn$;

create or replace function public.cl_terminal_join(
  p_install_id text, p_secret_phrase text, p_device_key text, p_join_code text,
  p_label text default null, p_legacy_branch_id text default null,
  p_device_phrase text default null, p_device_code text default null, p_business_name text default null,
  p_expected_branch_name text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; jc cl_branch_join_codes%rowtype; br cl_branches%rowtype; biz cl_businesses%rowtype;
        t cl_terminals%rowtype; norm text := cl_norm_join_code(p_join_code);
begin
  if (select count(*) from cl_join_failures where install_id = p_install_id and ts > now() - interval '1 hour') >= 10 then
    raise exception 'JOIN_LOCKED: Too many wrong codes. Try again in an hour.' using errcode = 'P0001';
  end if;

  select * into jc from cl_branch_join_codes where code_hash = encode(extensions.digest(norm, 'sha256'), 'hex') for update;
  if not found then
    insert into cl_join_failures (install_id) values (p_install_id);
    -- the failure row must survive the exception, so return an error object
    -- instead of raising (a raise would roll the insert back)
    return json_build_object('error', 'JOIN_CODE_INVALID');
  end if;
  select * into br from cl_branches where id = jc.branch_id;
  select * into biz from cl_businesses where id = br.business_id;

  if extensions.crypt(cl_norm_phrase(p_secret_phrase), biz.secret_phrase_hash) <> biz.secret_phrase_hash then
    insert into cl_join_failures (install_id) values (p_install_id);
    return json_build_object('error', 'PHRASE_MISMATCH');
  end if;

  -- Already a terminal? A retried join answers the same; nothing is created.
  select * into t from cl_terminals where install_id = p_install_id;
  if found then
    if not t.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;   -- Phase 2
    v := cl_install_vendor(p_install_id, coalesce(nullif(p_device_phrase, ''), p_secret_phrase), p_device_key, false);
    if t.branch_id = br.id then return cl_terminal_json(t.id); end if;
    return json_build_object('error', 'ALREADY_JOINED', 'branch_id', t.branch_id);
  end if;
  -- Every refusal comes before anything is written for this install.
  if jc.used_by_terminal is not null then return json_build_object('error', 'JOIN_CODE_USED'); end if;
  if jc.expires_ts < now() then return json_build_object('error', 'JOIN_CODE_EXPIRED'); end if;
  -- An existing device's branch name is locked (DN keys carry it), so it
  -- may only join a branch of the same name.
  if nullif(btrim(coalesce(p_expected_branch_name,'')), '') is not null
     and cl_branch_key(p_expected_branch_name) <> cl_branch_key(br.name) then
    return json_build_object('error', 'BRANCH_NAME_MISMATCH', 'branch_name', br.name);
  end if;
  if exists (select 1 from cl_vendors where install_id = p_install_id and business_id is not null and business_id <> biz.id) then
    return json_build_object('error', 'OTHER_BUSINESS');
  end if;

  v := cl_install_vendor(p_install_id, coalesce(nullif(p_device_phrase, ''), p_secret_phrase), p_device_key, true,
                         coalesce(p_business_name, biz.name), p_device_code);

  perform 1 from cl_branches where id = br.id for update;            -- serialise till numbering
  insert into cl_terminals (business_id, branch_id, vendor_id, install_id, till_code, label, last_seen_ts)
  values (biz.id, br.id, v.id, v.install_id, cl_next_till_code(br.id), nullif(btrim(coalesce(p_label,'')), ''), now())
  returning * into t;
  update cl_branch_join_codes set used_by_terminal = t.id, used_ts = now() where id = jc.id;
  update cl_vendors set business_id = biz.id where id = v.id;
  if not br.is_main and br.legacy_branch_id is null and nullif(p_legacy_branch_id, '') is not null then
    update cl_branches set legacy_branch_id = p_legacy_branch_id where id = br.id;
  end if;
  return cl_terminal_json(t.id);
end $fn$;


-- 4. Check-in reports terminal_active -------------------------------------
-- Phase 1 body; the only changes are v_terminal_active and its reply key.
-- Same signature, so CREATE OR REPLACE keeps the live grants.
create or replace function public.cl_device_checkin(
  p_install_id text, p_shop_secret_phrase text, p_device_code text, p_business_name text,
  p_owner_name text default null, p_phone text default null, p_city text default null,
  p_location text default null, p_rpn_hint_id uuid default null, p_device_key text default null)
returns json
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_vendor cl_vendors%rowtype;
  v_messages json;
  v_terminal_id uuid;
  v_terminal_active boolean;                                         -- Phase 2
  v_business_name text := nullif(trim(coalesce(p_business_name,'')), '');
  v_owner_name    text := nullif(trim(coalesce(p_owner_name,'')), '');
  v_phone         text := nullif(trim(coalesce(p_phone,'')), '');
  v_city          text := nullif(trim(coalesce(p_city,'')), '');
  v_location      text := nullif(trim(coalesce(p_location,'')), '');
  v_device_code   text := nullif(trim(coalesce(p_device_code,'')), '');
begin
  -- was: inline install/phrase checks + "insert if not found"
  v_vendor := cl_install_vendor(p_install_id, p_shop_secret_phrase, p_device_key, true, v_business_name, v_device_code);

  update cl_vendors set
    business_name       = coalesce(v_business_name, business_name),
    owner_name          = coalesce(v_owner_name, owner_name),
    phone               = coalesce(v_phone, phone),
    city                = coalesce(v_city, city),
    location            = coalesce(v_location, location),
    device_code         = coalesce(v_device_code, device_code),
    shop_secret_phrase  = coalesce(v_vendor.shop_secret_phrase, p_shop_secret_phrase),
    rpn_id              = coalesce(v_vendor.rpn_id, p_rpn_hint_id),
    last_checkin_at     = now()
  where id = v_vendor.id
  returning * into v_vendor;

  update cl_terminals set last_seen_ts = now() where vendor_id = v_vendor.id
    returning id, active into v_terminal_id, v_terminal_active;      -- Phase 2: + active

  select coalesce(json_agg(json_build_object('id', id, 'title', title, 'body', body, 'created_at', created_at)), '[]'::json)
    into v_messages
    from cl_vendor_messages
    where vendor_id = v_vendor.id and channel = 'in_app' and status = 'pending';

  update cl_vendor_messages
    set status = 'delivered', delivered_at = now()
    where vendor_id = v_vendor.id and channel = 'in_app' and status = 'pending';

  return json_build_object(
    'vendor_id', v_vendor.id,
    'status', v_vendor.status,
    'lock_cart', v_vendor.lock_cart,
    'lock_add_product', v_vendor.lock_add_product,
    'lock_reason', v_vendor.lock_reason,
    'cycle_start_date', v_vendor.cycle_start_date,
    'messages', v_messages,
    'business_id', v_vendor.business_id,        -- Phase 1, additive
    'terminal_id', v_terminal_id,               -- Phase 1, additive
    'terminal_active', v_terminal_active        -- Phase 2, additive
  );
end;
$function$;

commit;
