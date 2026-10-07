-- =====================================================================
-- Multi-terminal Phase 3c add-on: "Business day ends at", set per branch by main.
-- Design: docs/multi-terminal/phase3c-returns-design.md §2.14 (approved 2026-10-07).
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261009120000_branch_business_day.rollback.sql
-- Tested in PGlite: supabase/tests/branch-business-day-test.js
--
-- Mirrors the branch price policy (Phase 3a):
--   * cl_branches.business_day_cutoff smallint, 0..6 hours after local
--     midnight; NULL = main hasn't set one (tills keep their own setting).
--   * cl_branch_set_business_day: main-branch tills only; NULL clears it.
--   * cl_catalogue_pull: the same function as Phase 3a, with one more key in
--     its answer, 'business_day_cutoff'. Nothing else in it changes.
-- The preflight refuses unless cl_catalogue_pull is exactly the Phase 3a
-- definition (md5 of its body), so no other change to it can be overwritten.
-- Apply by hand in one transaction (no migrations table).
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text; pull_md5 text;
begin
  select string_agg(n, ', ') into missing from (
    select 'table cl_branches' n where to_regclass('public.cl_branches') is null
    union all select 'function cl_catalogue_caller' where to_regprocedure('public.cl_catalogue_caller(text,text,text)') is null
    union all select 'function cl_catalogue_pull' where to_regprocedure('public.cl_catalogue_pull(text,text,text,bigint,integer)') is null
  ) x;
  if missing is not null then raise exception 'branch_business_day aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'column cl_branches.business_day_cutoff' n where exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cl_branches' and column_name = 'business_day_cutoff')
    union all select 'function cl_branch_set_business_day' where exists (select 1 from pg_proc
      where pronamespace = 'public'::regnamespace and proname = 'cl_branch_set_business_day')
  ) x;
  if conflicts is not null then raise exception 'branch_business_day aborted: already exists: %. Nothing was changed.', conflicts; end if;
  select md5(prosrc) into pull_md5 from pg_proc where oid = 'public.cl_catalogue_pull(text,text,text,bigint,integer)'::regprocedure;
  if pull_md5 <> 'a14390d89155c1286a028d56845194fd' then
    raise exception 'branch_business_day aborted: cl_catalogue_pull is not the Phase 3a definition (md5 %). Nothing was changed.', pull_md5;
  end if;
end $$;


-- 1. The column -----------------------------------------------------------
alter table public.cl_branches add column business_day_cutoff smallint
  check (business_day_cutoff is null or business_day_cutoff between 0 and 6);


-- 2. Main sets a branch's business day ------------------------------------
create function public.cl_branch_set_business_day(p_install_id text, p_secret_phrase text, p_device_key text,
                                                  p_branch_id uuid, p_hours integer)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  if not (select is_main from cl_branches where id = me.branch_id) then return json_build_object('error', 'NOT_MAIN'); end if;
  if p_hours is not null and p_hours not between 0 and 6 then
    raise exception 'The business day can end from 00:00 to 06:00' using errcode = 'P0001';
  end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  if not exists (select 1 from cl_branches where id = p_branch_id and business_id = me.business_id) then
    return json_build_object('error', 'UNKNOWN_BRANCH');
  end if;
  if (select business_day_cutoff from cl_branches where id = p_branch_id) is not distinct from p_hours then
    return json_build_object('branch_id', p_branch_id, 'business_day_cutoff', p_hours, 'unchanged', true);
  end if;
  update cl_branches set business_day_cutoff = p_hours where id = p_branch_id;
  return json_build_object('branch_id', p_branch_id, 'business_day_cutoff', p_hours);
end $fn$;


-- 3. Pull: as Phase 3a, plus 'business_day_cutoff' ------------------------
create or replace function public.cl_catalogue_pull(p_install_id text, p_secret_phrase text, p_device_key text,
                                         p_cursor bigint, p_limit integer default 500)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; caller_main boolean; lim integer; cur0 bigint; nxt bigint; more boolean;
        prods json; prices json; br cl_branches%rowtype;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  select * into br from cl_branches where id = me.branch_id;
  caller_main := br.is_main;
  lim := least(greatest(coalesce(p_limit, 500), 1), 500);
  cur0 := greatest(coalesce(p_cursor, 0), 0);

  with page as (
    select * from (
      select change_seq as seq, 'p' as kind, product_uid from cl_catalogue_products where business_id = me.business_id and change_seq > cur0
      union all
      select change_seq, 'b', product_uid from cl_branch_prices where branch_id = me.branch_id and change_seq > cur0
    ) x order by seq limit lim
  )
  select coalesce((select max(seq) from page), cur0),
         (select coalesce(json_agg(json_build_object(
            'uid', c.product_uid, 'code', c.code, 'name', c.name, 'description', c.description, 'category', c.category,
            'shelf', c.shelf, 'price', c.price, 'cost', case when caller_main then c.cost end, 'low_threshold', c.low_threshold,
            'active', c.active, 'image_hash', c.image_hash, 'image_bytes', c.image_bytes, 'seq', c.change_seq) order by c.change_seq), '[]'::json)
            from cl_catalogue_products c join page p on p.kind = 'p' and p.product_uid = c.product_uid
           where c.business_id = me.business_id),
         (select coalesce(json_agg(json_build_object('uid', bp.product_uid, 'price', bp.price, 'seq', bp.change_seq) order by bp.change_seq), '[]'::json)
            from cl_branch_prices bp join page p on p.kind = 'b' and p.product_uid = bp.product_uid
           where bp.branch_id = me.branch_id)
    into nxt, prods, prices;
  more := exists (select 1 from cl_catalogue_products where business_id = me.business_id and change_seq > nxt)
       or exists (select 1 from cl_branch_prices where branch_id = me.branch_id and change_seq > nxt);

  return json_build_object('products', prods, 'prices', prices, 'cursor', nxt, 'more', more,
    'price_mode', br.price_mode, 'price_mode_seq', br.price_mode_seq, 'branch_id', br.id, 'is_main', caller_main,
    'business_day_cutoff', br.business_day_cutoff);
end $fn$;


-- 4. Grants: devices call the RPCs with the anon key, like every other till RPC
revoke execute on function public.cl_branch_set_business_day(text, text, text, uuid, integer) from public;
grant execute on function public.cl_branch_set_business_day(text, text, text, uuid, integer) to anon, authenticated;
revoke execute on function public.cl_catalogue_pull(text, text, text, bigint, integer) from public;
grant execute on function public.cl_catalogue_pull(text, text, text, bigint, integer) to anon, authenticated;

commit;
