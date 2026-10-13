-- =====================================================================
-- Billing-B (owner: go on 2026-10-09, scope 2026-10-13): a branch of a
-- business must be IN that business on the server, or it is priced and
-- treated as a shop of its own (the Chipo Clothing case: Harare CBD and
-- Sothleapark were registered as two businesses, 0.55 s apart).
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261021120000_billing_b.rollback.sql
-- Tested in PGlite: supabase/tests/billing-b-test.js (with the Chipo merge)
--
-- 1. cl_branch_register refuses a duplicate business: a business that isn't
--    archived with the same name (cl_branch_key) AND the same secret phrase.
--    The answer is DUPLICATE_BUSINESS with the business's name and main
--    branch, so the app can say "join with a code from that device". The
--    phrase alone is never enough (one common phrase is shared by many
--    shops). An advisory lock on the name closes the 0.5-second race the two
--    Chipo devices hit. Otherwise the body is 20261004180000's, unchanged.
-- 2. cl_licence_link_warnings (staff, Activation Codes): for the Console's
--    issue form, next to cl_licence_quote (unchanged): a device that is T1 of
--    a business whose name another business also has, or a device that isn't
--    a till while a business with its shop's name exists.
-- 3. Merging a duplicate business into another:
--    cl_business_merge_core (no grants: the owner's data-fix files only) and
--    cl_business_merge (SysAdmin, for the Console later). The duplicate's
--    branches become non-main branches of the other business, with their
--    tills (same till codes, same branch ids) and vendors. Its catalogue
--    moves only when asked (p_move_catalogue), and never over a product code
--    the other business already uses; moved products get new change_seq
--    numbers so every till pulls them. Refused while the duplicate has
--    customers, suppliers, supplier GRVs, dispatches, shared stock, or a
--    branch name the other business already has, or when the other
--    business's plan doesn't allow the branches. History stays where it is:
--    licences (their signed payload names the old business), trials, RPN
--    assignments and commissions, tokens, market packs, plan assignments.
--    The duplicate is then archived ("Merged into ..."), never deleted.
--    Unused join codes of the moved branches are expired.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; there text;
begin
  select string_agg(f, ', ') into there from (
    select 'function cl_licence_link_warnings' f where to_regprocedure('public.cl_licence_link_warnings(text)') is not null
    union all select 'function cl_business_merge_core' where to_regprocedure('public.cl_business_merge_core(uuid, uuid, text, boolean, uuid)') is not null
    union all select 'function cl_business_merge' where to_regprocedure('public.cl_business_merge(uuid, uuid, text, boolean)') is not null
    union all select 'function cl_business_name_twins' where to_regprocedure('public.cl_business_name_twins(uuid)') is not null) x;
  if there is not null then raise exception 'billing_b aborted: already there: %. Nothing was changed.', there; end if;
  select string_agg(f, ', ') into missing from (
    select 'function cl_branch_register' f where to_regprocedure('public.cl_branch_register(text, text, text, text, text, text, text, text)') is null
    union all select 'function cl_branch_key' where to_regprocedure('public.cl_branch_key(text)') is null
    union all select 'function cl_licence_staff_ok' where to_regprocedure('public.cl_licence_staff_ok()') is null
    union all select 'function cl_acting_staff' where to_regprocedure('public.cl_acting_staff()') is null
    union all select 'function cl_archive_reason' where to_regprocedure('public.cl_archive_reason(text)') is null
    union all select 'function cl_plan_of' where to_regprocedure('public.cl_plan_of(uuid, uuid)') is null
    union all select 'function cl_plan_version' where to_regprocedure('public.cl_plan_version(text)') is null
    union all select 'function cl_plan_branch_limit_text' where to_regprocedure('public.cl_plan_branch_limit_text(integer)') is null
    union all select 'function cl_plan_branch_allowed' where to_regprocedure('public.cl_plan_branch_allowed(uuid, integer)') is null
    union all select 'sequence cl_catalogue_seq' where to_regclass('public.cl_catalogue_seq') is null
    union all select 'table cl_trials (20261019120000)' where to_regclass('public.cl_trials') is null) x;
  if missing is not null then raise exception 'billing_b aborted: missing: %. Nothing was changed.', missing; end if;
end $$;

-- 1. Same-name businesses ---------------------------------------------------
-- The other businesses (not archived) whose name has the same key as this one's.
create function public.cl_business_name_twins(p_business_id uuid) returns setof public.cl_businesses
language sql stable security definer set search_path = public as $$
  select o.* from cl_businesses b join cl_businesses o
    on o.id <> b.id and o.archived_at is null and cl_branch_key(o.name) = cl_branch_key(b.name)
  where b.id = p_business_id order by o.created_ts
$$;
revoke all on function public.cl_business_name_twins(uuid) from public, anon, authenticated, service_role;

-- 2. Register refuses a duplicate business --------------------------------
-- 20261004180000's body; the only change is the marked DUPLICATE_BUSINESS block.
create or replace function public.cl_branch_register(
  p_install_id text, p_secret_phrase text, p_device_key text,
  p_business_name text, p_branch_name text, p_legacy_branch_id text default null,
  p_label text default null, p_device_code text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; t cl_terminals%rowtype; biz uuid; br uuid;
        v_name text; dup cl_businesses%rowtype;                                          -- Billing-B
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

  -- Billing-B: one business per name and phrase. Another device of the same
  -- business joins it with a join code instead of registering a second one.
  v_name := coalesce(nullif(btrim(coalesce(p_business_name,'')), ''), v.business_name);
  perform pg_advisory_xact_lock(hashtext('cl_branch_register:' || cl_branch_key(v_name)));
  select b.* into dup from cl_businesses b
   where b.archived_at is null and cl_branch_key(b.name) = cl_branch_key(v_name)
     and b.secret_phrase_hash = extensions.crypt(cl_norm_phrase(p_secret_phrase), b.secret_phrase_hash)
   order by b.created_ts limit 1;
  if found then
    return json_build_object('error', 'DUPLICATE_BUSINESS', 'business_name', dup.name,
      'main_branch', (select name from cl_branches where business_id = dup.id and is_main),
      'message', dup.name || ' is already registered from another device. If this is another branch or till of it, join with a join code from that device.');
  end if;

  insert into cl_businesses (name, secret_phrase_hash, created_by_vendor_id)
  values (v_name,
          extensions.crypt(cl_norm_phrase(p_secret_phrase), extensions.gen_salt('bf')), v.id)
  returning id into biz;
  insert into cl_branches (business_id, name, is_main, legacy_branch_id)
  values (biz, btrim(p_branch_name), true, nullif(p_legacy_branch_id, '')) returning id into br;
  update cl_vendors set business_id = biz where id = v.id;
  insert into cl_terminals (business_id, branch_id, vendor_id, install_id, till_code, label, last_seen_ts)
  values (biz, br, v.id, v.install_id, 'T1', nullif(btrim(coalesce(p_label,'')), ''), now()) returning * into t;
  return cl_terminal_json(t.id);
end $fn$;

-- 3. Console: warnings for the issue form ----------------------------------
-- [{ kind: 'duplicate_business' | 'not_linked', install_id, business_name?,
--    shop_name?, others: [{ id, name, main_branch, tills }] }]
create function public.cl_licence_link_warnings(p_device_code text) returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_install text := upper(split_part(regexp_replace(coalesce(p_device_code, ''), '\s', '', 'g'), '-', 1));
        vd cl_vendors%rowtype; te cl_terminals%rowtype; out jsonb := '[]';
begin
  if not cl_licence_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into vd from cl_vendors where install_id = v_install;
  select * into te from cl_terminals where install_id = v_install;
  if te.id is not null then
    if te.till_code = 'T1' and (select is_main from cl_branches where id = te.branch_id) and exists (select 1 from cl_business_name_twins(te.business_id)) then
      out := out || jsonb_build_array(jsonb_build_object('kind', 'duplicate_business', 'install_id', v_install,
        'business_name', (select name from cl_businesses where id = te.business_id),
        'others', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name,
                     'main_branch', (select name from cl_branches where business_id = o.id and is_main),
                     'tills', (select count(*) from cl_terminals where business_id = o.id and active))), '[]') from cl_business_name_twins(te.business_id) o)));
    end if;
  elsif vd.id is not null and nullif(btrim(coalesce(vd.business_name, '')), '') is not null then
    if exists (select 1 from cl_businesses b where b.archived_at is null and cl_branch_key(b.name) = cl_branch_key(vd.business_name)) then
      out := out || jsonb_build_array(jsonb_build_object('kind', 'not_linked', 'install_id', v_install, 'shop_name', vd.business_name,
        'others', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name,
                     'main_branch', (select name from cl_branches where business_id = b.id and is_main),
                     'tills', (select count(*) from cl_terminals where business_id = b.id and active)) order by b.created_ts), '[]')
                   from cl_businesses b where b.archived_at is null and cl_branch_key(b.name) = cl_branch_key(vd.business_name))));
    end if;
  end if;
  return out;
end $fn$;

-- 4. Merge a duplicate business into another --------------------------------
create function public.cl_business_merge_core(p_from uuid, p_into uuid, p_reason text, p_move_catalogue boolean, p_by_staff uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare f cl_businesses%rowtype; i cl_businesses%rowtype; v_reason text := cl_archive_reason(p_reason);
        v_max integer; b record; n_br int; n_te int; n_ve int; n_cat int := 0; n_codes int; v_clash text; v_names text; v_moved uuid[];
begin
  if p_from is null or p_into is null or p_from = p_into then raise exception 'MERGE_SAME: Give two different businesses' using errcode = 'P0001'; end if;
  -- lock both, in id order (two merges at once can't deadlock)
  perform 1 from cl_businesses where id in (p_from, p_into) order by id for update;
  select * into f from cl_businesses where id = p_from;
  select * into i from cl_businesses where id = p_into;
  if f.id is null or i.id is null then raise exception 'MERGE_NOT_FOUND: No such business' using errcode = 'P0001'; end if;
  if f.archived_at is not null or i.archived_at is not null then raise exception 'MERGE_ARCHIVED: An archived business can''t be merged' using errcode = 'P0001'; end if;

  -- what can't move (yet): say exactly what is in the way
  select string_agg(x, '; ') into v_clash from (
    select 'it has ' || count(*) || ' customers' x from cl_customers where business_id = f.id having count(*) > 0
    union all select 'it has ' || count(*) || ' suppliers' from cl_suppliers where business_id = f.id having count(*) > 0
    union all select 'it has ' || count(*) || ' supplier GRVs' from cl_supplier_grvs where business_id = f.id having count(*) > 0
    union all select 'it has ' || count(*) || ' dispatches' from cl_dispatches where business_id = f.id having count(*) > 0
    union all select 'branch ' || name || ' uses shared stock' from cl_branches where business_id = f.id and stock_mode = 'shared'
    union all select 'it has branch stock' from cl_branch_stock s join cl_branches br on br.id = s.branch_id where br.business_id = f.id having count(*) > 0
    union all select 'both have a branch called ' || a.name from cl_branches a join cl_branches c on c.business_id = i.id and cl_branch_key(c.name) = cl_branch_key(a.name)
      where a.business_id = f.id) q;
  if v_clash is not null then raise exception 'MERGE_BLOCKED: % can''t be merged yet: %', f.name, v_clash using errcode = 'P0001'; end if;

  select count(*) into n_codes from cl_catalogue_products where business_id = f.id;
  if n_codes > 0 and not coalesce(p_move_catalogue, false) then
    raise exception 'MERGE_CATALOGUE: % has % catalogue products. Merge with "move the catalogue", or the other way round.', f.name, n_codes using errcode = 'P0001';
  end if;
  if n_codes > 0 then
    select string_agg(distinct a.code, ', ') into v_clash from cl_catalogue_products a join cl_catalogue_products c
      on c.business_id = i.id and c.active and a.active and btrim(a.code) <> '' and lower(btrim(c.code)) = lower(btrim(a.code))
     where a.business_id = f.id;
    if v_clash is not null then raise exception 'MERGE_CATALOGUE_CODES: Both catalogues use the code(s) %. Change them on one side first.', v_clash using errcode = 'P0001'; end if;
  end if;

  -- the move (branch ids, till codes and product uids don't change)
  v_moved := array(select id from cl_branches where business_id = f.id);
  update cl_branches set business_id = i.id, is_main = false where business_id = f.id;
  get diagnostics n_br = row_count;
  update cl_terminals set business_id = i.id where business_id = f.id;
  get diagnostics n_te = row_count;
  update cl_vendors set business_id = i.id where business_id = f.id;
  get diagnostics n_ve = row_count;
  if n_codes > 0 then
    -- new change_seq numbers: every till of either side pulls them as new
    update cl_catalogue_products set business_id = i.id, change_seq = nextval('cl_catalogue_seq') where business_id = f.id;
    get diagnostics n_cat = row_count;
  end if;
  update cl_branch_join_codes set expires_ts = now()
   where used_ts is null and expires_ts > now() and branch_id = any(v_moved);

  -- the other business's plan must allow every branch it now has
  v_max := (cl_plan_version((select pl.plan_code from cl_plan_of(i.id, null) pl))).max_branches;
  for b in select id from cl_branches where business_id = i.id loop
    if not cl_plan_branch_allowed(b.id, v_max) then raise exception '%', cl_plan_branch_limit_text(v_max); end if;
  end loop;

  update cl_businesses set archived_at = now(), archived_by = p_by_staff,
         archive_reason = left('Merged into ' || i.name || ' (' || i.id || '): ' || v_reason, 300)
   where id = f.id;
  select string_agg(name, ', ' order by is_main desc, name) into v_names from cl_branches where business_id = i.id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (p_by_staff, 'business_merged', 'cl_businesses', f.id,
          jsonb_build_object('from', f.id, 'from_name', f.name, 'into', i.id, 'into_name', i.name, 'reason', v_reason,
                             'branches', n_br, 'tills', n_te, 'vendors', n_ve, 'catalogue_products', n_cat, 'db_role', current_user));
  return json_build_object('ok', true, 'from', f.id, 'into', i.id, 'into_name', i.name, 'branches_now', v_names,
                           'moved', json_build_object('branches', n_br, 'tills', n_te, 'vendors', n_ve, 'catalogue_products', n_cat));
end $fn$;
revoke all on function public.cl_business_merge_core(uuid, uuid, text, boolean, uuid) from public, anon, authenticated, service_role;

create function public.cl_business_merge(p_from uuid, p_into uuid, p_reason text, p_move_catalogue boolean default false)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_acting_staff();
begin
  if v_staff is null or not cl_jwt_is_sysadmin() or not exists (select 1 from cl_staff where id = v_staff and active) then
    raise exception 'Not authorized: only a SysAdmin can merge businesses' using errcode = '42501';
  end if;
  return cl_business_merge_core(p_from, p_into, p_reason, p_move_catalogue, v_staff);
end $fn$;

-- 5. Who may call what -----------------------------------------------------
revoke all on function public.cl_licence_link_warnings(text) from public, anon;
grant execute on function public.cl_licence_link_warnings(text) to authenticated;
revoke all on function public.cl_business_merge(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.cl_business_merge(uuid, uuid, text, boolean) to authenticated;

commit;
