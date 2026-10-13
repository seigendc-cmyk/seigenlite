-- One-off DATA fix (no schema change): UNDO 20261021_chipo_merge.sql, only
-- if the owner decides the merge was wrong. Run only after the owner has
-- seen this file and said "apply":
--   node tools/db/run-data-fix.js apply supabase/data-fixes/20261021_chipo_merge_undo.sql
-- Puts back what the merge moved: Sothleapark's branch (main again), its till
-- and its device row go back to the archived business (7c47d0ea...), which is
-- unarchived; its 3 catalogue products (KDS003, LMD001, MB005) go back too,
-- with new change numbers. History never moved, so nothing else changes.
-- Not put back: Sothleapark's old join code (it was unused and stays expired).
-- Checks itself first and raises (changing nothing) unless the merge is
-- there exactly as it left things, and nothing has been written since that
-- ties Sothleapark to Harare CBD's business: dispatches, customers,
-- suppliers, supplier GRVs, shared stock, or other catalogue products.
-- Design: docs/billing/chipo-merge-design.md ("Undo").
begin;

do $$
declare
  v_into constant uuid := '95f0ba44-4041-4e6e-ac52-3516902d20e0';   -- Chipo Clothing: Harare CBD (stays)
  v_from constant uuid := '7c47d0ea-ced3-4297-9c38-1c15fb24ac07';   -- Chipo Clothing: Sothleapark (archived by the merge; comes back)
  v_sbr  constant uuid := '07930efd-f41f-461d-a227-897c58956b46';   -- branch Sothleapark
  v_hbr  constant uuid := 'f1a153a3-9e3c-4021-a41d-a0ba46b235b1';   -- branch Harare CBD
  v_codes constant text[] := array['KDS003', 'LMD001', 'MB005'];     -- Sothleapark's products before the merge
  n int; v_why text; p_after jsonb;
begin
  -- the merge is there, as it left things
  if (select archived_at from cl_businesses where id = v_from) is null
     or (select archive_reason from cl_businesses where id = v_from) not like 'Merged into Chipo Clothing (' || v_into || ')%' then
    raise exception 'chipo_merge_undo aborted: the duplicate business isn''t archived by the merge. Nothing was changed.';
  end if;
  if (select archived_at from cl_businesses where id = v_into) is not null then
    raise exception 'chipo_merge_undo aborted: Harare CBD''s business is archived. Nothing was changed.';
  end if;
  if (select count(*) from cl_branches where business_id = v_into) <> 2
     or not exists (select 1 from cl_branches where id = v_hbr and business_id = v_into and is_main)
     or not exists (select 1 from cl_branches where id = v_sbr and business_id = v_into and not is_main)
     or exists (select 1 from cl_branches where business_id = v_from) then
    raise exception 'chipo_merge_undo aborted: expected Harare CBD (main) and Sothleapark (branch) in one business, and no branch left in the archived one. Nothing was changed.';
  end if;
  if (select count(*) from cl_terminals where business_id = v_into and branch_id = v_sbr) <> 1 then
    raise exception 'chipo_merge_undo aborted: expected one till at Sothleapark (found %). Nothing was changed.',
      (select count(*) from cl_terminals where business_id = v_into and branch_id = v_sbr);
  end if;
  select count(*) into n from cl_catalogue_products where business_id = v_into and upper(btrim(code)) = any(v_codes);
  if n <> 3 then raise exception 'chipo_merge_undo aborted: expected Sothleapark''s 3 products (KDS003, LMD001, MB005) in the catalogue (found %). Nothing was changed.', n; end if;
  if (select count(*) from cl_catalogue_products where business_id = v_into) <> 4 then
    raise exception 'chipo_merge_undo aborted: the catalogue has products added since the merge (% now, 4 after it); which side they belong to is the owner''s call. Nothing was changed.',
      (select count(*) from cl_catalogue_products where business_id = v_into);
  end if;
  -- nothing since the merge that ties the two together
  select string_agg(x, '; ') into v_why from (
    select count(*) || ' dispatches' x from cl_dispatches where business_id = v_into having count(*) > 0
    union all select count(*) || ' customers' from cl_customers where business_id = v_into having count(*) > 0
    union all select count(*) || ' suppliers' from cl_suppliers where business_id = v_into having count(*) > 0
    union all select count(*) || ' supplier GRVs' from cl_supplier_grvs where business_id = v_into having count(*) > 0
    union all select 'shared stock' from cl_branches where business_id = v_into and stock_mode = 'shared'
    union all select 'branch stock' from cl_branch_stock s join cl_branches b on b.id = s.branch_id where b.business_id = v_into having count(*) > 0) q;
  if v_why is not null then
    raise exception 'chipo_merge_undo aborted: since the merge, Chipo Clothing has %. Splitting it now needs its own plan. Nothing was changed.', v_why;
  end if;

  -- put back
  update cl_businesses set archived_at = null, archived_by = null, archive_reason = null where id = v_from;
  update cl_branches set business_id = v_from, is_main = true where id = v_sbr;
  update cl_vendors set business_id = v_from where id in (select vendor_id from cl_terminals where business_id = v_into and branch_id = v_sbr);
  update cl_terminals set business_id = v_from where business_id = v_into and branch_id = v_sbr;
  -- new change numbers: Sothleapark's till pulls them again
  update cl_catalogue_products set business_id = v_from, change_seq = nextval('cl_catalogue_seq')
   where business_id = v_into and upper(btrim(code)) = any(v_codes);
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'business_unmerged', 'cl_businesses', v_from,
          jsonb_build_object('from', v_into, 'back_to', v_from, 'branch', v_sbr, 'catalogue_products', 3,
                             'reason', 'Owner: undo 20261021_chipo_merge', 'db_role', current_user));

  -- after: as before the merge
  p_after := (select cl_plan_price(null, (select install_id from cl_terminals where branch_id = v_sbr), 30));
  if (select count(*) from cl_branches where business_id = v_from and is_main) <> 1
     or (select count(*) from cl_branches where business_id = v_into) <> 1
     or (select count(*) from cl_terminals where business_id = v_from) <> 1
     or (select count(*) from cl_catalogue_products where business_id = v_from) <> 3
     or (select count(*) from cl_catalogue_products where business_id = v_into) <> 1
     or p_after->>'till_role' <> 'main' then
    raise exception 'chipo_merge_undo aborted: the result isn''t as before the merge. Nothing was changed.';
  end if;
  raise notice 'AFTER UNDO: two businesses again; Sothleapark main, its till priced as % (USD %), its catalogue 3, Harare CBD''s 1',
    p_after->>'till_role', p_after->>'unit_fee';
end $$;

commit;
