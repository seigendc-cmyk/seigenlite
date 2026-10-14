-- =====================================================================
-- Branches B1: stock by branch (owner, 2026-10-13: "go Branches-B, phase B1
-- only"; multi-till branches: "option 1. Add up the tills, show each till's
-- own figure under the branch total on main"). Applied live only after the
-- owner has seen this file and said "apply".
-- Design: docs/branches/multi-branch-visibility-design.md (§1, §2, §6)
-- Rollback: supabase/rollbacks/20261024120000_branch_stock.rollback.sql
-- Tested in PGlite: supabase/tests/branch-stock-test.js (and the app's
-- test/branch-stock.test.js against this SQL)
--
-- Each till sends its OWN stock levels (absolute figures, never movements),
-- so a retry, a reinstall or an old backup can't count anything twice: the
-- next push simply overwrites. Only for a business with 2 or more active
-- tills (owner: "businesses with 2 or more TILLS"); otherwise nothing is
-- stored. A shared-stock branch already has its figure (cl_branch_stock).
--
-- A branch's stock = the SUM of its active tills' figures (owner's option 1).
-- Main-branch tills also get each till's own figure. NO COST is stored or
-- returned here, to anyone (main values stock with its own catalogue costs).
--
-- Rows hang off the till and the branch only (no business_id), so a business
-- merge (cl_business_merge_core moves branches and tills) carries them.
--
-- Adds:
--   cl_till_stock_levels   one row per till and product: qty, name, code, low
--   cl_till_stock_push     one row per till: when its figures are from
--   cl_bs_enabled          internal: does this business have 2+ active tills?
--   cl_device_stock_levels_push   a till sends its figures (all, or changes)
--   cl_device_branch_stock        any till: every branch's stock (quantities only)
--   cl_device_business_dispatches any till: the business's dispatches, no costs
-- RLS on every new table; no table grants to anon/authenticated.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'function cl_dispatch_caller (20261017120000)' n where to_regprocedure('public.cl_dispatch_caller(text,text,text)') is null
    union all select 'table cl_dispatches (20261017120000)' where to_regclass('public.cl_dispatches') is null
    union all select 'table cl_branch_stock (20261007120000)' where to_regclass('public.cl_branch_stock') is null
    union all select 'table cl_terminal_admin_seeds (20261023120000)' where to_regclass('public.cl_terminal_admin_seeds') is null
  ) x;
  if missing is not null then raise exception 'branch_stock aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'table ' || t n from unnest(array['cl_till_stock_levels', 'cl_till_stock_push']) t where to_regclass('public.' || t) is not null
    union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cl_bs_enabled', 'cl_device_stock_levels_push', 'cl_device_branch_stock', 'cl_device_business_dispatches')
  ) x;
  if conflicts is not null then raise exception 'branch_stock aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;

-- 1. Tables ---------------------------------------------------------------
create table public.cl_till_stock_levels (
  terminal_id   uuid not null references public.cl_terminals(id) on delete cascade,
  product_key   text not null check (product_key ~ '^[A-Za-z0-9:_-]{1,80}$'),   -- the catalogue uid, or 'local:' || the till's own product uid
  branch_id     uuid not null references public.cl_branches(id),
  cat_uid       text check (cat_uid is null or cat_uid ~ '^[0-9a-f]{32}$'),
  code          text not null default '' check (length(code) <= 64),
  name          text not null check (length(btrim(name)) between 1 and 120),
  qty           integer not null check (qty between -1000000000 and 1000000000),
  low_threshold integer not null default 0 check (low_threshold between 0 and 1000000),
  as_of         timestamptz not null,                                       -- the till's time of the figure
  pushed_at     timestamptz not null default now(),
  primary key (terminal_id, product_key)
);
create index cl_till_stock_levels_branch_idx on public.cl_till_stock_levels (branch_id, product_key);

create table public.cl_till_stock_push (
  terminal_id uuid primary key references public.cl_terminals(id) on delete cascade,
  branch_id   uuid not null references public.cl_branches(id),
  as_of       timestamptz not null,
  pushed_at   timestamptz not null default now(),
  full_at     timestamptz,
  products    integer not null default 0
);
create index cl_till_stock_push_branch_idx on public.cl_till_stock_push (branch_id);

-- 2. Helpers (not callable by devices or staff) ---------------------------
create function public.cl_bs_enabled(p_business uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from cl_terminals t where t.business_id = p_business and t.active) >= 2
$$;

-- 3. A till sends its stock levels --------------------------------------------
-- p_rows: [{ k, cat_uid?, code?, name, qty, low? }], at most 5000.
-- p_full: these are ALL of this till's products: the till's other rows go.
-- An older figure never overwrites a newer one (as_of), so a retry that
-- arrives late changes nothing.
create function public.cl_device_stock_levels_push(p_install_id text, p_secret_phrase text, p_device_key text,
                                                   p_as_of text, p_full boolean, p_rows jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; r jsonb; n integer := 0; v_as timestamptz; v_key text; v_keys text[] := '{}';
        v_name text; v_qty integer; v_low integer; v_cat text; v_last timestamptz;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if not cl_bs_enabled(me.business_id) then return json_build_object('ok', true, 'enabled', false); end if;
  select * into b from cl_branches where id = me.branch_id;
  if b.stock_mode = 'shared' then return json_build_object('ok', true, 'enabled', false, 'shared', true); end if;
  if coalesce(p_as_of, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}' then v_as := null;                  -- an ISO time only ('yesterday' is a valid timestamptz)
  else begin v_as := p_as_of::timestamptz; exception when others then v_as := null; end; end if;
  if v_as is null then raise exception 'Send the time of the stock figures' using errcode = 'P0001'; end if;
  if v_as > now() + interval '1 day' then v_as := now(); end if;                     -- a till clock far ahead can't lock out later figures
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Send the products as a list of at most 5000' using errcode = 'P0001';
  end if;
  select as_of into v_last from cl_till_stock_push where terminal_id = me.id;
  if v_last is not null and v_as < v_last then
    return json_build_object('ok', true, 'enabled', true, 'stale', true, 'received', 0);   -- a newer figure is already here
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    n := n + 1;
    v_key := btrim(coalesce(r->>'k', ''));
    if v_key !~ '^[A-Za-z0-9:_-]{1,80}$' then raise exception 'Product %: its key is missing or malformed', n using errcode = 'P0001'; end if;
    if coalesce(r->>'qty', '') !~ '^-?[0-9]{1,9}$' then raise exception 'Product %: the quantity must be a whole number', n using errcode = 'P0001'; end if;
    v_qty := (r->>'qty')::integer;
    v_name := left(btrim(coalesce(r->>'name', '')), 120);
    if v_name = '' then raise exception 'Product %: the name is missing', n using errcode = 'P0001'; end if;
    v_low := case when coalesce(r->>'low', '') ~ '^[0-9]{1,7}$' then least((r->>'low')::integer, 1000000) else 0 end;
    v_cat := nullif(lower(btrim(coalesce(r->>'cat_uid', ''))), '');
    if v_cat is not null and v_cat !~ '^[0-9a-f]{32}$' then v_cat := null; end if;
    insert into cl_till_stock_levels as l (terminal_id, product_key, branch_id, cat_uid, code, name, qty, low_threshold, as_of, pushed_at)
    values (me.id, v_key, me.branch_id, v_cat, left(btrim(coalesce(r->>'code', '')), 64), v_name, v_qty, v_low, v_as, now())
    on conflict (terminal_id, product_key) do update
      set branch_id = excluded.branch_id, cat_uid = excluded.cat_uid, code = excluded.code, name = excluded.name, qty = excluded.qty,
          low_threshold = excluded.low_threshold, as_of = excluded.as_of, pushed_at = excluded.pushed_at
      where l.as_of <= excluded.as_of;
    v_keys := v_keys || v_key;
  end loop;

  if p_full then delete from cl_till_stock_levels where terminal_id = me.id and not (product_key = any (v_keys)); end if;
  insert into cl_till_stock_push as p (terminal_id, branch_id, as_of, pushed_at, full_at, products)
  values (me.id, me.branch_id, v_as, now(), case when p_full then now() end, (select count(*) from cl_till_stock_levels where terminal_id = me.id))
  on conflict (terminal_id) do update
    set branch_id = excluded.branch_id, as_of = excluded.as_of, pushed_at = excluded.pushed_at,
        full_at = coalesce(excluded.full_at, p.full_at), products = excluded.products;
  return json_build_object('ok', true, 'enabled', true, 'received', n,
    'products', (select count(*) from cl_till_stock_levels where terminal_id = me.id));
end $fn$;

-- 4. Every branch's stock (any till of the business) ------------------------------
-- A local branch: the SUM of its active tills' figures; a shared-stock branch:
-- its seiGEN figure. Main-branch callers also get each till's own figure
-- ('t': { till_code: qty }) and each till's times. Never any cost.
create function public.cl_device_branch_stock(p_install_id text, p_secret_phrase text, p_device_key text, p_branch_id uuid default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; caller_main boolean;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select is_main into caller_main from cl_branches where id = me.branch_id;
  return json_build_object(
    'server_time', now(), 'branch_id', me.branch_id, 'terminal_id', me.id, 'is_main', caller_main,
    'enabled', cl_bs_enabled(me.business_id),
    'branches', coalesce((select json_agg(x order by x.is_main desc, x.name) from (
      select b.id, b.name, b.is_main, b.stock_mode,
        case when b.stock_mode = 'shared'
          then (select max(s.last_sync_ts) from cl_till_stock_state s where s.branch_id = b.id)
          else (select max(p.pushed_at) from cl_till_stock_push p join cl_terminals t on t.id = p.terminal_id where p.branch_id = b.id and t.active) end as updated_at,
        (select count(*) from cl_terminals t where t.branch_id = b.id and t.active) as active_tills,
        case when caller_main then coalesce((select json_agg(json_build_object('terminal_id', t.id, 'till_code', t.till_code, 'label', t.label, 'active', t.active,
            'as_of', p.as_of, 'pushed_at', p.pushed_at, 'products', coalesce(p.products, 0)) order by t.till_code)
          from cl_terminals t left join cl_till_stock_push p on p.terminal_id = t.id where t.branch_id = b.id), '[]'::json) end as tills,
        case when b.stock_mode = 'shared' then
          coalesce((select json_agg(json_build_object('k', s.product_uid, 'cat_uid', s.product_uid, 'code', c.code, 'name', c.name, 'qty', s.total, 'low', c.low_threshold) order by c.name)
            from cl_branch_stock s join cl_catalogue_products c on c.business_id = s.business_id and c.product_uid = s.product_uid
           where s.branch_id = b.id), '[]'::json)
        else
          coalesce((select json_agg(json_build_object('k', g.product_key, 'cat_uid', g.cat_uid, 'code', g.code, 'name', g.name, 'qty', g.qty, 'low', g.low,
                     't', case when caller_main then g.t end) order by g.name)
            from (select l.product_key, max(l.cat_uid) cat_uid, max(l.code) code, max(l.name) name, sum(l.qty)::bigint qty, max(l.low_threshold) low,
                         json_object_agg(t.till_code, l.qty) t
                    from cl_till_stock_levels l join cl_terminals t on t.id = l.terminal_id
                   where l.branch_id = b.id and t.active and t.branch_id = b.id
                   group by l.product_key) g), '[]'::json)
        end as rows
      from cl_branches b
     where b.business_id = me.business_id and (p_branch_id is null or b.id = p_branch_id)) x), '[]'::json));
end $fn$;

-- 5. The business's dispatches, without costs (any till of the business) ------------
-- For "Other branches": what's in transit, received, received with
-- differences, cancelled; open differences. No unit cost, no delivery
-- cost, no charge, for any caller (main has its own seiGEN screen).
create function public.cl_device_business_dispatches(p_install_id text, p_secret_phrase text, p_device_key text, p_days integer default 30)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_days integer := least(greatest(coalesce(p_days, 30), 1), 180);
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  return json_build_object('server_time', now(), 'days', v_days,
    'dispatches', coalesce((select json_agg(x order by x.sent_at desc) from (
      select d.id, d.dn_display, fb.name from_branch, d.from_branch_id, tb.name to_branch, d.to_branch_id, ft.till_code from_till,
             d.status, d.sent_at, d.sent_by, d.grv_display, d.received_at, d.grv_by, d.cancelled_at,
             (select coalesce(json_agg(json_build_object('line_no', l.line_no, 'code', l.code, 'name', l.name, 'qty', l.qty,
                 'received', l.received, 'damaged', l.damaged, 'short', l.short, 'extra', l.extra) order by l.line_no), '[]'::json)
                from cl_dispatch_lines l where l.dispatch_id = d.id) lines,
             (select count(*) from cl_dispatch_issues i where i.dispatch_id = d.id and i.status in ('open', 'disputed')) open_issues
        from cl_dispatches d
        join cl_branches fb on fb.id = d.from_branch_id
        join cl_branches tb on tb.id = d.to_branch_id
        join cl_terminals ft on ft.id = d.from_terminal_id
       where d.business_id = me.business_id
         and (d.status = 'sent' or d.sent_at > now() - make_interval(days => v_days)
              or exists (select 1 from cl_dispatch_issues i where i.dispatch_id = d.id and i.status in ('open', 'disputed')))
       order by d.sent_at desc
       limit 300) x), '[]'::json));
end $fn$;

-- 6. Grants ----------------------------------------------------------------------
alter table public.cl_till_stock_levels enable row level security;
alter table public.cl_till_stock_push enable row level security;
revoke all on table public.cl_till_stock_levels, public.cl_till_stock_push from public, anon, authenticated;
revoke all on function public.cl_bs_enabled(uuid) from public, anon, authenticated;
revoke all on function public.cl_device_stock_levels_push(text, text, text, text, boolean, jsonb),
  public.cl_device_branch_stock(text, text, text, uuid),
  public.cl_device_business_dispatches(text, text, text, integer) from public;
grant execute on function public.cl_device_stock_levels_push(text, text, text, text, boolean, jsonb),
  public.cl_device_branch_stock(text, text, text, uuid),
  public.cl_device_business_dispatches(text, text, text, integer) to anon, authenticated;

commit;
