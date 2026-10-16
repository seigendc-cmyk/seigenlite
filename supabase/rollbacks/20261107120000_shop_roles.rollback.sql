-- Rollback of 20261107120000_shop_roles.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Puts cl_business_merge_core and cl_business_delete_guard back exactly as
-- 20261021120000_billing_b and 20261019120000_trial_rules left them, and drops
-- every shop roles object. Lost for good: the shop roles and staff on seiGEN
-- (the tills keep their own copies and their old local staff lists). Apps from
-- v28 on then sign in with their last copy and say that seiGEN's staff isn't
-- reachable; selling never depends on it.

begin;

create or replace function public.cl_business_merge_core(p_from uuid, p_into uuid, p_reason text, p_move_catalogue boolean, p_by_staff uuid)
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
  -- Market publishing (20261016120000)
  select count(*) into n from cl_market_packs where business_id = old.id;
  if n > 0 then parts := parts || (n || ' market pack' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_token_purchases where business_id = old.id;
  if n > 0 then parts := parts || (n || ' token purchase' || case when n = 1 then '' else 's' end); end if;
  -- Dispatch & GRV (20261017120000)
  select count(*) into n from cl_dispatches where business_id = old.id;
  if n > 0 then parts := parts || (n || ' dispatch' || case when n = 1 then '' else 'es' end); end if;
  -- Suppliers (20261018120000)
  select count(*) into n from cl_suppliers where business_id = old.id;
  if n > 0 then parts := parts || (n || ' supplier' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_supplier_grvs where business_id = old.id;
  if n > 0 then parts := parts || (n || ' supplier GRV' || case when n = 1 then '' else 's' end); end if;
  -- Customers (20261018180000)
  select count(*) into n from cl_customers where business_id = old.id;
  if n > 0 then parts := parts || (n || ' customer' || case when n = 1 then '' else 's' end); end if;
  -- Trial rules (20261019120000)
  select count(*) into n from cl_trials where business_id = old.id;
  if n > 0 then parts := parts || (n || ' free trial' || case when n = 1 then '' else 's' end); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

drop function if exists public.cl_device_dispatch_costs(text, text, text, text, uuid);
drop function if exists public.cl_device_branch_report(text, text, text, text, text, uuid, timestamptz, timestamptz);
drop function if exists public.cl_device_role_save(text, text, text, text, jsonb);
drop function if exists public.cl_device_staff_save(text, text, text, text, jsonb);
drop function if exists public.cl_device_staff_set_pin(text, text, text, text, uuid, text, text, text, integer);
drop function if exists public.cl_device_staff_signout(text, text, text, text);
drop function if exists public.cl_device_staff_signin(text, text, text, uuid, text);
drop function if exists public.cl_device_staff_upload(text, text, text, jsonb);
drop function if exists public.cl_device_staff_pull(text, text, text);
drop function if exists public.cl_shop_pin_problem(text, text, text, integer);
drop function if exists public.cl_shop_staff_json(public.cl_shop_staff, uuid, uuid);
drop function if exists public.cl_shop_role_json(public.cl_shop_roles);
drop function if exists public.cl_staff_has(text, uuid, text);
drop function if exists public.cl_shop_session(text, uuid);
drop function if exists public.cl_shop_effective_rights(public.cl_shop_roles);
drop function if exists public.cl_shop_owner_ok(uuid, text);
drop function if exists public.cl_shop_ensure_roles(uuid);
drop function if exists public.cl_shop_default_rights(text);
drop function if exists public.cl_shop_rights_all();

drop table if exists public.cl_shop_meta;
drop table if exists public.cl_shop_legacy_uploads;
drop table if exists public.cl_shop_staff_signin_fails;
drop table if exists public.cl_shop_staff_sessions;
drop table if exists public.cl_shop_staff;
drop table if exists public.cl_shop_roles;
drop sequence if exists public.cl_shop_seq;

commit;
