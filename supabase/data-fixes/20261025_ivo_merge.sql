-- One-off DATA fix (no schema change): "IVO merge". IVO Motor Spares stays
-- the business (main branch Warehouse, its till T1, with Norton and Harare);
-- the earlier registration, IVO Dist, is RETIRED: the business and its two
-- device rows are archived (a Console label; nothing is deleted or moved).
-- Why not a full merge (cl_business_merge_core): IVO Dist has nothing on
-- seiGEN to move (no catalogue, stock, customers, suppliers, dispatches,
-- licences, plan, trial or join codes), and its one till (T1, last seen
-- 7 Oct on a build before v8) would come over as a 4th, dead branch. The
-- merge would also be refused as is: both mains are called "Warehouse".
-- Design: docs/billing/ivo-merge-design.md
-- Run only after the owner has seen the design and said "apply ivo merge":
--   node tools/db/run-data-fix.js apply supabase/data-fixes/20261025_ivo_merge.sql
-- Undo: supabase/data-fixes/20261025_ivo_merge_undo.sql
-- Checks itself first and raises (changing nothing) if live isn't what the
-- design was made from (read-only look at live, 2026-10-14 02:30 UTC).
begin;

do $$
declare
  v_keep constant uuid := '32f8d976-d651-439a-b45e-15d7251b1bb8';   -- IVO Motor Spares (stays; untouched)
  v_dist constant uuid := 'c8d4116c-d88d-426e-aa25-b2aff24c33c7';   -- IVO Dist (archived)
  v_dbr  constant uuid := 'dbeba305-1b5a-4674-b29d-67442a28c77b';   -- IVO Dist's branch Warehouse
  v_dt1  constant uuid := '3c1d5016-9bc2-4ac6-8f02-f290c3ff5bca';   -- IVO Dist's till T1
  v_ven  constant uuid[] := array['faa5d2ea-a722-4e42-ab04-30ed8d3847df',   -- IVO Dist's T1 device row
                                  'e8e4438f-2e4b-444e-92a6-e1ee957272ae']::uuid[];   -- an earlier IVO Dist device row (28 Sep, no business)
  c_reason constant text := 'IVO merge (owner, 2026-10-14): IVO Dist was an earlier registration of IVO Motor Spares; IVO Motor Spares stays.';
  n int; v_why text;
begin
  -- what the design was made from
  if (select count(*) from cl_businesses where id = v_dist and name = 'IVO Dist' and archived_at is null) <> 1 then
    raise exception 'ivo_merge aborted: IVO Dist (c8d4116c...) is missing, renamed or already archived. Nothing was changed.';
  end if;
  if (select count(*) from cl_businesses where id = v_keep and name = 'IVO Motor Spares' and archived_at is null) <> 1 then
    raise exception 'ivo_merge aborted: IVO Motor Spares (32f8d976...) is missing, renamed or archived. Nothing was changed.';
  end if;
  if (select count(*) from cl_branches where business_id = v_dist) <> 1 or not exists (select 1 from cl_branches where id = v_dbr and business_id = v_dist and is_main) then
    raise exception 'ivo_merge aborted: expected IVO Dist to have one branch (Warehouse, main). Nothing was changed.';
  end if;
  if (select count(*) from cl_terminals where business_id = v_dist) <> 1 or not exists (select 1 from cl_terminals where id = v_dt1 and business_id = v_dist) then
    raise exception 'ivo_merge aborted: expected IVO Dist to have one till (T1). Nothing was changed.';
  end if;
  if (select last_seen_ts from cl_terminals where id = v_dt1) >= '2026-10-08' then
    raise exception 'ivo_merge aborted: IVO Dist''s till has checked in since 7 Oct, so someone is using it again: the owner''s call. Nothing was changed.';
  end if;
  select count(*) into n from cl_vendors where id = any(v_ven) and archived_at is null and business_name = 'IVO Dist' and (business_id = v_dist or business_id is null);
  if n <> 2 or exists (select 1 from cl_vendors where business_id = v_dist and not (id = any(v_ven))) then
    raise exception 'ivo_merge aborted: expected exactly IVO Dist''s two device rows, not archived. Nothing was changed.';
  end if;
  -- nothing on seiGEN that would be left behind by archiving
  select string_agg(x, '; ') into v_why from (
    select count(*) || ' catalogue products' x from cl_catalogue_products where business_id = v_dist having count(*) > 0
    union all select count(*) || ' customers' from cl_customers where business_id = v_dist having count(*) > 0
    union all select count(*) || ' suppliers' from cl_suppliers where business_id = v_dist having count(*) > 0
    union all select count(*) || ' supplier GRVs' from cl_supplier_grvs where business_id = v_dist having count(*) > 0
    union all select count(*) || ' dispatches' from cl_dispatches where business_id = v_dist having count(*) > 0
    union all select count(*) || ' branch stock rows' from cl_branch_stock where business_id = v_dist having count(*) > 0
    union all select count(*) || ' stock events' from cl_stock_events where business_id = v_dist having count(*) > 0
    union all select count(*) || ' licences' from cl_licences where business_id = v_dist or vendor_id = any(v_ven) having count(*) > 0
    union all select count(*) || ' plan assignments' from cl_plan_assignments where business_id = v_dist having count(*) > 0
    union all select count(*) || ' trials' from cl_trials where business_id = v_dist or vendor_id = any(v_ven) having count(*) > 0
    union all select count(*) || ' join codes' from cl_branch_join_codes where branch_id = v_dbr having count(*) > 0) q;
  if v_why is not null then
    raise exception 'ivo_merge aborted: IVO Dist now has % on seiGEN; that needs a real merge plan. Nothing was changed.', v_why;
  end if;

  raise notice 'BEFORE: IVO Dist archived: no; its device rows archived: 0 of 2; IVO Motor Spares: % branches, % tills, % catalogue products',
    (select count(*) from cl_branches where business_id = v_keep), (select count(*) from cl_terminals where business_id = v_keep),
    (select count(*) from cl_catalogue_products where business_id = v_keep);

  -- the change: three labels (the archive triggers log each one, with c_reason)
  update cl_businesses set archived_at = now(), archived_by = null, archive_reason = c_reason where id = v_dist;
  update cl_vendors set archived_at = now(), archived_by = null, archive_reason = c_reason where id = any(v_ven);

  if (select archived_at from cl_businesses where id = v_dist) is null
     or (select count(*) from cl_vendors where id = any(v_ven) and archived_at is not null) <> 2
     or (select archived_at from cl_businesses where id = v_keep) is not null then
    raise exception 'ivo_merge aborted: the result isn''t what the design says. Nothing was changed.';
  end if;
  raise notice 'AFTER: IVO Dist archived; its 2 device rows archived; IVO Motor Spares unchanged (% branches, % tills)',
    (select count(*) from cl_branches where business_id = v_keep), (select count(*) from cl_terminals where business_id = v_keep);
end $$;

commit;
