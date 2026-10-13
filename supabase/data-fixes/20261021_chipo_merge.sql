-- One-off DATA fix (no schema change): merge Chipo Clothing's duplicate
-- business (Sothleapark, registered 0.55 s after Harare CBD on 2026-10-09)
-- into Harare CBD's, so Sothleapark is a remote branch of one business:
-- priced as a branch (USD 7, not 15 as a main till), and dispatches
-- Harare CBD <-> Sothleapark go through seiGEN.
-- Owner's decision 2026-10-13: "Sothleapark as a remote branch" of Chipo Clothing.
-- Design: docs/billing/chipo-merge-design.md
-- Needs 20261021120000_billing_b.sql applied first (cl_business_merge_core).
-- Run only after the owner has seen this file and said "apply":
--   node tools/db/run-data-fix.js apply supabase/data-fixes/20261021_chipo_merge.sql
-- Checks itself first and raises (changing nothing) if live isn't what the
-- design was made from (live backup 2026-10-13T04-48-42-797Z): two businesses
-- named Chipo Clothing with these ids, one branch and one active till each,
-- both on the Business plan, Sothleapark with 3 catalogue products whose codes
-- Harare CBD doesn't use, no customers, suppliers, dispatches or shared stock.
begin;

do $$
declare
  v_into constant uuid := '95f0ba44-4041-4e6e-ac52-3516902d20e0';   -- Chipo Clothing: Harare CBD (main; kept)
  v_from constant uuid := '7c47d0ea-ced3-4297-9c38-1c15fb24ac07';   -- Chipo Clothing: Sothleapark (the duplicate; archived)
  v_sbr  constant uuid := '07930efd-f41f-461d-a227-897c58956b46';   -- branch Sothleapark (keeps its id)
  v_hbr  constant uuid := 'f1a153a3-9e3c-4021-a41d-a0ba46b235b1';   -- branch Harare CBD
  n int; r json; p_before jsonb; p_after jsonb;
begin
  if to_regprocedure('public.cl_business_merge_core(uuid, uuid, text, boolean, uuid)') is null then
    raise exception 'chipo_merge aborted: 20261021120000_billing_b is not applied. Nothing was changed.';
  end if;
  -- what the design was made from
  select count(*) into n from cl_businesses where id in (v_into, v_from) and name = 'Chipo Clothing' and archived_at is null;
  if n <> 2 then raise exception 'chipo_merge aborted: expected both Chipo Clothing businesses, not archived (found %). Nothing was changed.', n; end if;
  select count(*) into n from cl_branches where (business_id = v_into and id = v_hbr and is_main) or (business_id = v_from and id = v_sbr and is_main);
  if n <> 2 or (select count(*) from cl_branches where business_id in (v_into, v_from)) <> 2 then
    raise exception 'chipo_merge aborted: expected one main branch each (Harare CBD, Sothleapark). Nothing was changed.';
  end if;
  if (select count(*) from cl_terminals where business_id = v_from) <> 1 or (select count(*) from cl_terminals where business_id = v_into) <> 1 then
    raise exception 'chipo_merge aborted: expected one till in each business. Nothing was changed.';
  end if;
  if (select string_agg(plan_code, ',' order by business_id) from (select distinct on (business_id) business_id, plan_code from cl_plan_assignments
        where business_id in (v_into, v_from) order by business_id, created_at desc) x) is distinct from 'business,business' then
    raise exception 'chipo_merge aborted: expected both on the Business plan. Nothing was changed.';
  end if;
  select count(*) into n from cl_catalogue_products where business_id = v_from;
  if n <> 3 then raise exception 'chipo_merge aborted: expected 3 catalogue products at Sothleapark (found %). Nothing was changed.', n; end if;

  p_before := (select cl_plan_price(null, (select install_id from cl_terminals where business_id = v_from), 30));
  raise notice 'BEFORE: Sothleapark till priced as % (USD %); Harare CBD catalogue %, Sothleapark catalogue %',
    p_before->>'till_role', p_before->>'unit_fee',
    (select count(*) from cl_catalogue_products where business_id = v_into), (select count(*) from cl_catalogue_products where business_id = v_from);

  -- the merge itself (all its own refusals apply: customers, dispatches, code clashes, plan limit ...)
  r := cl_business_merge_core(v_from, v_into, 'Owner 2026-10-13: Sothleapark is a remote branch of Chipo Clothing (registered twice on 2026-10-09)', true, null);

  -- after: exactly what the design says
  p_after := (select cl_plan_price(null, (select install_id from cl_terminals where business_id = v_into and branch_id = v_sbr), 30));
  if (select business_id from cl_branches where id = v_sbr) <> v_into or (select is_main from cl_branches where id = v_sbr)
     or not (select is_main from cl_branches where id = v_hbr)
     or (select count(*) from cl_terminals where business_id = v_into) <> 2
     or (select count(*) from cl_catalogue_products where business_id = v_into) <> 4
     or (select archived_at from cl_businesses where id = v_from) is null
     or p_after->>'till_role' <> 'branch' then
    raise exception 'chipo_merge aborted: the result isn''t what the design says (%). Nothing was changed.', r;
  end if;
  raise notice 'AFTER: %', r;
  raise notice 'AFTER: Sothleapark till priced as % (USD %); Chipo Clothing catalogue %; the duplicate archived',
    p_after->>'till_role', p_after->>'unit_fee', (select count(*) from cl_catalogue_products where business_id = v_into);
end $$;

commit;
