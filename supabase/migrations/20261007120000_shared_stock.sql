-- =====================================================================
-- Multi-terminal sync, Phase 3b: shared branch stock + offline allowance.
-- Design: docs/multi-terminal/phase3b-design.md (approved 2026-10-06, §11).
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261007120000_shared_stock.rollback.sql
-- Tested in PGlite: supabase/tests/shared-stock-test.js
--
-- Adds:
--   * cl_branches.stock_mode ('local' | 'shared') + stock_shared_ts. A branch
--     becomes 'shared' once, by an explicit start on its stock holder (the
--     earliest-registered active till), and never goes back.
--   * cl_branch_stock: per branch and catalogue product, total and available.
--     Invariant: total = available + the sum of the tills' allowances.
--   * cl_till_allowance: what each till may sell while offline.
--   * cl_till_stock_state: each till's last stock sync (72 h stale rule).
--   * cl_stock_events: every change exactly once (uid = <movement uid>:<product>),
--     so a retried request never counts twice.
--   * cl_branch_local_products: products a till sells that aren't in main's
--     catalogue, so main can see and add them.
--   * a trigger on cl_terminals: deactivating a till returns its allowance.
--   * RPCs (phrase + install + device key via cl_catalogue_caller):
--     cl_stock_sync, cl_stock_start_shared, cl_stock_sale, cl_stock_move,
--     cl_stock_report (also for deactivated tills), cl_stock_stocktake,
--     cl_stock_balance, cl_stock_local_products_report, cl_stock_local_products_list.
-- Never below zero: check constraints on every quantity, and every write
-- refuses or records a 'discrepancy' event instead of going negative.
-- Ordering: every write locks the business row first (as Phase 3a), so two
-- tills can never both take the last unit.
-- RLS on every new table; no table grants to anon/authenticated.
-- Apply by hand in one transaction (no migrations table).
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'table cl_catalogue_products (Phase 3a)' n where to_regclass('public.cl_catalogue_products') is null
    union all select 'sequence cl_catalogue_seq (Phase 3a)' where to_regclass('public.cl_catalogue_seq') is null
    union all select 'function cl_catalogue_caller (Phase 3a)' where to_regprocedure('public.cl_catalogue_caller(text,text,text)') is null
    union all select 'table cl_terminals' where to_regclass('public.cl_terminals') is null
  ) x;
  if missing is not null then raise exception 'shared_stock aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'table '||t n from unnest(array['cl_branch_stock','cl_till_allowance','cl_till_stock_state','cl_stock_events','cl_branch_local_products']) t
      where to_regclass('public.'||t) is not null
    union all select 'column cl_branches.stock_mode' where exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cl_branches' and column_name in ('stock_mode', 'stock_shared_ts'))
    union all select 'function '||proname from pg_proc where pronamespace = 'public'::regnamespace and proname like 'cl\_stock\_%'
  ) x;
  if conflicts is not null then raise exception 'shared_stock aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;


-- 1. Tables -------------------------------------------------------------
alter table public.cl_branches add column stock_mode text not null default 'local' check (stock_mode in ('local', 'shared'));
alter table public.cl_branches add column stock_shared_ts timestamptz;

create table public.cl_branch_stock (
  branch_id   uuid not null references public.cl_branches(id),
  product_uid text not null,
  business_id uuid not null,
  total       integer not null check (total >= 0),
  available   integer not null check (available >= 0 and available <= total),
  change_seq  bigint not null,
  primary key (branch_id, product_uid),
  foreign key (business_id, product_uid) references public.cl_catalogue_products (business_id, product_uid)
);
create index cl_branch_stock_seq_idx on public.cl_branch_stock (branch_id, change_seq);

create table public.cl_till_allowance (
  terminal_id uuid not null references public.cl_terminals(id),
  branch_id   uuid not null,
  product_uid text not null,
  qty         integer not null check (qty >= 0),
  change_seq  bigint not null,
  primary key (terminal_id, product_uid),
  foreign key (branch_id, product_uid) references public.cl_branch_stock (branch_id, product_uid)
);
create index cl_till_allowance_branch_idx on public.cl_till_allowance (branch_id, product_uid);

create table public.cl_till_stock_state (
  terminal_id  uuid primary key references public.cl_terminals(id),
  branch_id    uuid not null,
  last_sync_ts timestamptz not null default now()
);

create table public.cl_stock_events (
  uid            text primary key,
  ref_uid        text not null,                      -- the sale / movement / operation it belongs to
  business_id    uuid not null,
  branch_id      uuid not null,
  terminal_id    uuid,
  product_uid    text not null,
  kind           text not null check (kind in ('opening','sale','offline_sale','move','stocktake','allowance_take',
                                              'allowance_return','discrepancy')),
  qty_delta      integer not null,                   -- change to total
  from_available integer not null default 0,
  from_allowance integer not null default 0,
  seq            bigint not null,
  ts             timestamptz not null default now(),
  detail         jsonb not null default '{}'::jsonb
);
create index cl_stock_events_ref_idx on public.cl_stock_events (ref_uid);
create index cl_stock_events_product_idx on public.cl_stock_events (branch_id, product_uid);

create table public.cl_branch_local_products (
  terminal_id uuid not null references public.cl_terminals(id),
  branch_id   uuid not null,
  business_id uuid not null,
  code        text not null default '',
  name        text not null,
  reported_ts timestamptz not null default now(),
  primary key (terminal_id, name, code)
);

do $$
declare t text;
begin
  foreach t in array array['cl_branch_stock','cl_till_allowance','cl_till_stock_state','cl_stock_events','cl_branch_local_products'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;


-- 2. Private helpers (not callable by devices) ----------------------------
create function public.cl_stock_active_tills(p_branch uuid) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int from cl_terminals where branch_id = p_branch and active
$$;

-- The branch's stock holder: its earliest-registered active till.
create function public.cl_stock_holder(p_branch uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from cl_terminals where branch_id = p_branch and active order by registered_ts, id limit 1
$$;

-- Offline allowance per till and product (owner, Q1): 10% of the branch
-- total, at least 1, at most 10; none at all when the total is below
-- 2 x the active tills (online-only), so allowances never lock up all stock.
create function public.cl_stock_target(p_total integer, p_active integer) returns integer
language sql immutable as $$
  select case when p_total < 2 * greatest(p_active, 1) then 0
              else least(10, greatest(1, ceil(p_total * 0.10)::int)) end
$$;

create function public.cl_stock_event(p_uid text, p_ref text, p_business uuid, p_branch uuid, p_terminal uuid, p_product text,
                                      p_kind text, p_delta integer, p_from_available integer, p_from_allowance integer, p_detail jsonb)
returns void language sql security definer set search_path = public as $$
  insert into cl_stock_events (uid, ref_uid, business_id, branch_id, terminal_id, product_uid, kind, qty_delta,
                               from_available, from_allowance, seq, detail)
  values (p_uid, p_ref, p_business, p_branch, p_terminal, p_product, p_kind, p_delta,
          p_from_available, p_from_allowance, nextval('cl_catalogue_seq'), coalesce(p_detail, '{}'::jsonb))
$$;

-- Take p_qty of a product for a till: from available first (online sale /
-- move), or from the till's allowance first (offline report). Never below
-- zero: what can't be covered comes back as shortfall.
create function public.cl_stock_take(p_branch uuid, p_product text, p_terminal uuid, p_qty integer, p_allowance_first boolean,
                                     out from_available integer, out from_allowance integer, out shortfall integer)
language plpgsql security definer set search_path = public as $fn$
declare bs cl_branch_stock%rowtype; al integer; need integer := p_qty;
begin
  from_available := 0; from_allowance := 0; shortfall := 0;
  select * into bs from cl_branch_stock where branch_id = p_branch and product_uid = p_product for update;
  if not found then shortfall := p_qty; return; end if;
  select qty into al from cl_till_allowance where terminal_id = p_terminal and product_uid = p_product for update;
  al := coalesce(al, 0);
  if p_allowance_first then
    from_allowance := least(al, need); need := need - from_allowance;
    from_available := least(bs.available, need); need := need - from_available;
  else
    from_available := least(bs.available, need); need := need - from_available;
    from_allowance := least(al, need); need := need - from_allowance;
  end if;
  shortfall := need;
  update cl_branch_stock set available = available - from_available, total = total - from_available - from_allowance,
         change_seq = nextval('cl_catalogue_seq') where branch_id = p_branch and product_uid = p_product;
  if from_allowance > 0 then
    update cl_till_allowance set qty = qty - from_allowance, change_seq = nextval('cl_catalogue_seq')
     where terminal_id = p_terminal and product_uid = p_product;
  end if;
end $fn$;

-- Add stock to a branch (receipt, positive adjustment, merge...). Creates the row if needed.
create function public.cl_stock_add(p_business uuid, p_branch uuid, p_product text, p_qty integer) returns void
language plpgsql security definer set search_path = public as $fn$
begin
  insert into cl_branch_stock (branch_id, product_uid, business_id, total, available, change_seq)
  values (p_branch, p_product, p_business, p_qty, p_qty, nextval('cl_catalogue_seq'))
  on conflict (branch_id, product_uid) do update set total = cl_branch_stock.total + p_qty,
    available = cl_branch_stock.available + p_qty, change_seq = excluded.change_seq;
end $fn$;

-- Return one till's allowance for a product to available.
create function public.cl_stock_return(p_business uuid, p_branch uuid, p_terminal uuid, p_product text, p_why text) returns integer
language plpgsql security definer set search_path = public as $fn$
declare q integer;
begin
  select qty into q from cl_till_allowance where terminal_id = p_terminal and product_uid = p_product for update;
  if coalesce(q, 0) = 0 then return 0; end if;
  update cl_till_allowance set qty = 0, change_seq = nextval('cl_catalogue_seq') where terminal_id = p_terminal and product_uid = p_product;
  update cl_branch_stock set available = available + q, change_seq = nextval('cl_catalogue_seq') where branch_id = p_branch and product_uid = p_product;
  perform cl_stock_event(gen_random_uuid()::text, 'allowance:'||p_terminal, p_business, p_branch, p_terminal, p_product,
                         'allowance_return', 0, 0, q, jsonb_build_object('why', p_why));
  return q;
end $fn$;

-- Bring a till's allowance to target for some (or all) products, and first
-- return the allowance of any till of the branch that hasn't synced for 72 h.
create function public.cl_stock_rebalance(p_me public.cl_terminals, p_products text[]) returns void
language plpgsql security definer set search_path = public as $fn$
declare act integer := cl_stock_active_tills(p_me.branch_id); r record; tgt integer; give integer;
begin
  for r in select a.terminal_id, a.product_uid from cl_till_allowance a join cl_till_stock_state s on s.terminal_id = a.terminal_id
            where a.branch_id = p_me.branch_id and a.terminal_id <> p_me.id and a.qty > 0
              and s.last_sync_ts < now() - interval '72 hours' order by a.product_uid loop
    perform cl_stock_return(p_me.business_id, p_me.branch_id, r.terminal_id, r.product_uid, 'stale_72h');
  end loop;
  for r in select bs.product_uid, bs.total, bs.available, coalesce(a.qty, 0) cur
             from cl_branch_stock bs left join cl_till_allowance a on a.terminal_id = p_me.id and a.product_uid = bs.product_uid
            where bs.branch_id = p_me.branch_id and (p_products is null or bs.product_uid = any (p_products))
            order by bs.product_uid for update of bs loop
    tgt := cl_stock_target(r.total, act);
    if r.cur > tgt then
      give := r.cur - tgt;
      update cl_till_allowance set qty = qty - give, change_seq = nextval('cl_catalogue_seq') where terminal_id = p_me.id and product_uid = r.product_uid;
      update cl_branch_stock set available = available + give, change_seq = nextval('cl_catalogue_seq') where branch_id = p_me.branch_id and product_uid = r.product_uid;
      perform cl_stock_event(gen_random_uuid()::text, 'allowance:'||p_me.id, p_me.business_id, p_me.branch_id, p_me.id, r.product_uid,
                             'allowance_return', 0, 0, give, jsonb_build_object('why', 'target'));
    elsif r.cur < tgt and r.available > 0 then
      give := least(tgt - r.cur, r.available);
      insert into cl_till_allowance (terminal_id, branch_id, product_uid, qty, change_seq)
      values (p_me.id, p_me.branch_id, r.product_uid, give, nextval('cl_catalogue_seq'))
      on conflict (terminal_id, product_uid) do update set qty = cl_till_allowance.qty + give, change_seq = excluded.change_seq;
      update cl_branch_stock set available = available - give, change_seq = nextval('cl_catalogue_seq') where branch_id = p_me.branch_id and product_uid = r.product_uid;
      perform cl_stock_event(gen_random_uuid()::text, 'allowance:'||p_me.id, p_me.business_id, p_me.branch_id, p_me.id, r.product_uid,
                             'allowance_take', 0, give, 0, '{}'::jsonb);
    end if;
  end loop;
end $fn$;

-- The invariant, checked at the end of every write: total = available + allowances.
create function public.cl_stock_check(p_branch uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare bad text;
begin
  select string_agg(bs.product_uid, ', ') into bad from cl_branch_stock bs
   where bs.branch_id = p_branch
     and bs.total <> bs.available + coalesce((select sum(qty) from cl_till_allowance a where a.branch_id = bs.branch_id and a.product_uid = bs.product_uid), 0);
  if bad is not null then raise exception 'Branch stock out of balance for %', bad using errcode = 'P0001'; end if;
end $fn$;

-- Rows for the till: total, available and its own allowance.
create function public.cl_stock_rows(p_me public.cl_terminals, p_products text[], p_cursor bigint) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('product_uid', bs.product_uid, 'total', bs.total, 'available', bs.available,
           'allowance', coalesce(a.qty, 0), 'seq', greatest(bs.change_seq, coalesce(a.change_seq, 0))) order by bs.product_uid), '[]'::json)
    from cl_branch_stock bs left join cl_till_allowance a on a.terminal_id = p_me.id and a.product_uid = bs.product_uid
   where bs.branch_id = p_me.branch_id
     and (p_products is null or bs.product_uid = any (p_products))
     and (p_cursor is null or greatest(bs.change_seq, coalesce(a.change_seq, 0)) > p_cursor)
$$;

do $$
declare f text;
begin
  foreach f in array array['cl_stock_active_tills(uuid)','cl_stock_holder(uuid)','cl_stock_target(integer,integer)',
    'cl_stock_event(text,text,uuid,uuid,uuid,text,text,integer,integer,integer,jsonb)',
    'cl_stock_take(uuid,text,uuid,integer,boolean)','cl_stock_add(uuid,uuid,text,integer)','cl_stock_return(uuid,uuid,uuid,text,text)',
    'cl_stock_rebalance(public.cl_terminals,text[])','cl_stock_check(uuid)','cl_stock_rows(public.cl_terminals,text[],bigint)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;


-- 3. Deactivating a till returns its allowance (owner decision §13) --------
create function public.cl_stock_on_till_deactivated() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare r record;
begin
  if old.active and not new.active then
    for r in select product_uid from cl_till_allowance where terminal_id = new.id and qty > 0 order by product_uid loop
      perform cl_stock_return(new.business_id, new.branch_id, new.id, r.product_uid, 'deactivated');
    end loop;
  end if;
  return new;
end $fn$;
revoke execute on function public.cl_stock_on_till_deactivated() from public, anon, authenticated;
create trigger cl_stock_till_deactivated after update of active on public.cl_terminals
  for each row execute function public.cl_stock_on_till_deactivated();


-- 4. Sync: mode, holder, and (shared branches) stock + this till's allowance
create function public.cl_stock_sync(p_install_id text, p_secret_phrase text, p_device_key text, p_cursor bigint)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; holder uuid; nxt bigint; rows json;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  select * into b from cl_branches where id = me.branch_id;
  holder := cl_stock_holder(b.id);
  if b.stock_mode <> 'shared' then
    return json_build_object('stock_mode', b.stock_mode, 'holder_terminal_id', holder, 'is_holder', holder = me.id,
                             'active_tills', cl_stock_active_tills(b.id));
  end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  insert into cl_till_stock_state (terminal_id, branch_id, last_sync_ts) values (me.id, b.id, now())
  on conflict (terminal_id) do update set last_sync_ts = now(), branch_id = excluded.branch_id;
  perform cl_stock_rebalance(me, null);
  perform cl_stock_check(b.id);
  rows := cl_stock_rows(me, null, case when coalesce(p_cursor, 0) > 0 then p_cursor else null end);
  select coalesce(max(greatest(bs.change_seq, coalesce(a.change_seq, 0))), coalesce(p_cursor, 0)) into nxt
    from cl_branch_stock bs left join cl_till_allowance a on a.terminal_id = me.id and a.product_uid = bs.product_uid
   where bs.branch_id = b.id;
  return json_build_object('stock_mode', 'shared', 'holder_terminal_id', holder, 'is_holder', holder = me.id,
    'active_tills', cl_stock_active_tills(b.id), 'stock', rows, 'cursor', nxt, 'server_ts', now());
end $fn$;


-- 5. Start shared stock (once, by the stock holder of a multi-till branch)
-- p_rows: [{ product_uid, qty }] = the holder's local stock of linked products.
create function public.cl_stock_start_shared(p_install_id text, p_secret_phrase text, p_device_key text, p_op_id text, p_rows jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; r jsonb; v_p text; v_q integer; n integer := 0;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  if p_op_id is null or p_op_id !~ '^[0-9a-f]{32}$' then raise exception 'A start needs an operation id' using errcode = 'P0001'; end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  select * into b from cl_branches where id = me.branch_id for update;
  if exists (select 1 from cl_stock_events where ref_uid = 'start:'||p_op_id) then
    return json_build_object('stock_mode', 'shared', 'already', true);
  end if;
  if b.stock_mode = 'shared' then return json_build_object('error', 'ALREADY_SHARED'); end if;
  if cl_stock_holder(b.id) <> me.id then return json_build_object('error', 'NOT_HOLDER'); end if;
  if cl_stock_active_tills(b.id) < 2 then return json_build_object('error', 'SINGLE_TILL'); end if;
  if (case when jsonb_typeof(p_rows) = 'array' then jsonb_array_length(p_rows) > 20000 else true end) then
    raise exception 'Send the stock as a list of at most 20000 products' using errcode = 'P0001';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_p := r->>'product_uid'; v_q := (r->>'qty')::integer;
    if v_q is null or v_q < 0 then raise exception 'Stock for % must be zero or more', v_p using errcode = 'P0001'; end if;
    if not exists (select 1 from cl_catalogue_products where business_id = me.business_id and product_uid = v_p) then
      raise exception 'Product % is not in the catalogue', v_p using errcode = 'P0001';
    end if;
    perform cl_stock_add(me.business_id, b.id, v_p, v_q);
    perform cl_stock_event('start:'||p_op_id||':'||v_p, 'start:'||p_op_id, me.business_id, b.id, me.id, v_p, 'opening', v_q, 0, 0, '{}'::jsonb);
    n := n + 1;
  end loop;
  update cl_branches set stock_mode = 'shared', stock_shared_ts = now() where id = b.id;
  insert into cl_till_stock_state (terminal_id, branch_id, last_sync_ts) values (me.id, b.id, now())
  on conflict (terminal_id) do update set last_sync_ts = now();
  perform cl_stock_check(b.id);
  return json_build_object('stock_mode', 'shared', 'products', n);
end $fn$;


-- 6. Online sale: the whole cart at once; all or nothing; never below zero.
-- p_lines: [{ product_uid, qty }]. From available first, then this till's allowance.
create function public.cl_stock_sale(p_install_id text, p_secret_phrase text, p_device_key text, p_sale_uid text, p_lines jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; r record; refused jsonb := '[]'::jsonb; out_lines jsonb := '[]'::jsonb;
        t record; prods text[]; have integer;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  select * into b from cl_branches where id = me.branch_id;
  if b.stock_mode <> 'shared' then return json_build_object('error', 'NOT_SHARED'); end if;
  if p_sale_uid is null or p_sale_uid !~ '^[0-9a-f]{32}$' then raise exception 'A sale needs its uid' using errcode = 'P0001'; end if;
  if (case when jsonb_typeof(p_lines) = 'array' then jsonb_array_length(p_lines) not between 1 and 500 else true end) then
    raise exception 'Send between 1 and 500 lines' using errcode = 'P0001';
  end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  -- a retried request (e.g. after a timeout): the first answer, nothing changes
  if exists (select 1 from cl_stock_events where ref_uid = 'sale:'||p_sale_uid) then
    select coalesce(jsonb_agg(jsonb_build_object('product_uid', product_uid, 'from_available', from_available, 'from_allowance', from_allowance)), '[]'::jsonb)
      into out_lines from cl_stock_events where ref_uid = 'sale:'||p_sale_uid and kind in ('sale', 'offline_sale');
    select array_agg(product_uid) into prods from cl_stock_events where ref_uid = 'sale:'||p_sale_uid;
    return json_build_object('ok', true, 'already', true, 'lines', out_lines, 'stock', cl_stock_rows(me, prods, null));
  end if;
  -- check every line first (rows locked in product order)
  for r in select x.p, sum(x.q)::int q from (select value->>'product_uid' p, (value->>'qty')::int q from jsonb_array_elements(p_lines)) x
            group by x.p order by x.p loop
    if r.q is null or r.q <= 0 then raise exception 'Quantities must be whole numbers above zero' using errcode = 'P0001'; end if;
    select coalesce((select available from cl_branch_stock where branch_id = b.id and product_uid = r.p for update), 0)
         + coalesce((select qty from cl_till_allowance where terminal_id = me.id and product_uid = r.p for update), 0) into have;
    if have < r.q then refused := refused || jsonb_build_object('product_uid', r.p, 'left', have, 'wanted', r.q); end if;
  end loop;
  if jsonb_array_length(refused) > 0 then return json_build_object('ok', false, 'refused', refused); end if;
  for r in select x.p, sum(x.q)::int q from (select value->>'product_uid' p, (value->>'qty')::int q from jsonb_array_elements(p_lines)) x
            group by x.p order by x.p loop
    select * into t from cl_stock_take(b.id, r.p, me.id, r.q, false);
    perform cl_stock_event('sale:'||p_sale_uid||':'||r.p, 'sale:'||p_sale_uid, me.business_id, b.id, me.id, r.p, 'sale',
                           -r.q, t.from_available, t.from_allowance, '{}'::jsonb);
    out_lines := out_lines || jsonb_build_object('product_uid', r.p, 'from_available', t.from_available, 'from_allowance', t.from_allowance);
    prods := array_append(prods, r.p);
  end loop;
  perform cl_stock_rebalance(me, prods);
  perform cl_stock_check(b.id);
  return json_build_object('ok', true, 'lines', out_lines, 'stock', cl_stock_rows(me, prods, null));
end $fn$;


-- 7. Online movement (receive, purchase, adjustment, restock, dispatch, merge...)
-- p_moves: [{ uid, product_uid, delta, kind }]. All or nothing for decreases.
create function public.cl_stock_move(p_install_id text, p_secret_phrase text, p_device_key text, p_moves jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; r jsonb; v_uid text; v_p text; v_d integer; t record; have integer;
        refused jsonb := '[]'::jsonb; out_rows jsonb := '[]'::jsonb; prods text[];
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  select * into b from cl_branches where id = me.branch_id;
  if b.stock_mode <> 'shared' then return json_build_object('error', 'NOT_SHARED'); end if;
  if (case when jsonb_typeof(p_moves) = 'array' then jsonb_array_length(p_moves) not between 1 and 500 else true end) then
    raise exception 'Send between 1 and 500 movements' using errcode = 'P0001';
  end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  -- decreases: check all first
  for r in select value from jsonb_array_elements(p_moves) loop
    v_uid := r->>'uid'; v_p := r->>'product_uid'; v_d := (r->>'delta')::integer;
    if v_uid is null or v_uid !~ '^[0-9a-f]{32}$' or v_d is null or v_d = 0 then raise exception 'Each movement needs a uid and a change' using errcode = 'P0001'; end if;
    if not exists (select 1 from cl_catalogue_products where business_id = me.business_id and product_uid = v_p) then
      refused := refused || jsonb_build_object('uid', v_uid, 'product_uid', v_p, 'reason', 'UNKNOWN_PRODUCT'); continue;
    end if;
    if v_d < 0 and not exists (select 1 from cl_stock_events where ref_uid = 'move:'||v_uid) then
      select coalesce((select available from cl_branch_stock where branch_id = b.id and product_uid = v_p for update), 0)
           + coalesce((select qty from cl_till_allowance where terminal_id = me.id and product_uid = v_p for update), 0) into have;
      if have < -v_d then refused := refused || jsonb_build_object('uid', v_uid, 'product_uid', v_p, 'reason', 'NOT_ENOUGH', 'left', have); end if;
    end if;
  end loop;
  if jsonb_array_length(refused) > 0 then return json_build_object('ok', false, 'refused', refused); end if;
  for r in select value from jsonb_array_elements(p_moves) loop
    v_uid := r->>'uid'; v_p := r->>'product_uid'; v_d := (r->>'delta')::integer;
    if exists (select 1 from cl_stock_events where ref_uid = 'move:'||v_uid) then
      out_rows := out_rows || jsonb_build_object('uid', v_uid, 'already', true,
        'from_allowance', (select coalesce(sum(from_allowance), 0) from cl_stock_events where ref_uid = 'move:'||v_uid));
      continue;
    end if;
    if v_d > 0 then
      perform cl_stock_add(me.business_id, b.id, v_p, v_d);
      perform cl_stock_event('move:'||v_uid||':'||v_p, 'move:'||v_uid, me.business_id, b.id, me.id, v_p, 'move', v_d, 0, 0,
                             jsonb_build_object('kind', r->>'kind'));
      out_rows := out_rows || jsonb_build_object('uid', v_uid, 'from_allowance', 0);
    else
      select * into t from cl_stock_take(b.id, v_p, me.id, -v_d, false);
      perform cl_stock_event('move:'||v_uid||':'||v_p, 'move:'||v_uid, me.business_id, b.id, me.id, v_p, 'move', v_d,
                             t.from_available, t.from_allowance, jsonb_build_object('kind', r->>'kind'));
      out_rows := out_rows || jsonb_build_object('uid', v_uid, 'from_allowance', t.from_allowance);
    end if;
    prods := array_append(prods, v_p);
  end loop;
  perform cl_stock_rebalance(me, prods);
  perform cl_stock_check(b.id);
  return json_build_object('ok', true, 'moves', out_rows, 'stock', cl_stock_rows(me, prods, null));
end $fn$;


-- 8. Report what happened offline (also accepted from a deactivated till).
-- p_sales: [{ sale_uid, lines:[{ product_uid, qty }] }]   offline sales: from this till's allowance first
-- p_moves: [{ uid, product_uid, delta, kind }]              recorded offline: increases add, decreases take allowance first
-- Anything that can't be covered becomes a 'discrepancy' event; stock never goes negative.
create function public.cl_stock_report(p_install_id text, p_secret_phrase text, p_device_key text, p_sales jsonb, p_moves jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; s jsonb; l jsonb; v_sale text; v_p text; v_q integer; v_uid text; v_d integer;
        t record; sales_out jsonb := '[]'::jsonb; moves_out jsonb := '[]'::jsonb; lines_out jsonb; short integer := 0;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);      -- no active check: a deactivated till may still report
  select * into b from cl_branches where id = me.branch_id;
  if b.stock_mode <> 'shared' then return json_build_object('error', 'NOT_SHARED'); end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  for s in select value from jsonb_array_elements(coalesce(p_sales, '[]'::jsonb)) loop
    v_sale := s->>'sale_uid';
    if v_sale is null or v_sale !~ '^[0-9a-f]{32}$' then raise exception 'Each sale needs its uid' using errcode = 'P0001'; end if;
    lines_out := '[]'::jsonb;
    if exists (select 1 from cl_stock_events where ref_uid = 'sale:'||v_sale) then
      select coalesce(jsonb_agg(jsonb_build_object('product_uid', product_uid, 'from_allowance', from_allowance, 'from_available', from_available)), '[]'::jsonb)
        into lines_out from cl_stock_events where ref_uid = 'sale:'||v_sale and kind in ('sale', 'offline_sale');
      sales_out := sales_out || jsonb_build_object('sale_uid', v_sale, 'already', true, 'lines', lines_out);
      continue;
    end if;
    for l in select value from jsonb_array_elements(s->'lines') loop
      v_p := l->>'product_uid'; v_q := (l->>'qty')::integer;
      if v_q is null or v_q <= 0 then continue; end if;
      select * into t from cl_stock_take(b.id, v_p, me.id, v_q, true);
      perform cl_stock_event('sale:'||v_sale||':'||v_p, 'sale:'||v_sale, me.business_id, b.id, me.id, v_p, 'offline_sale',
                             -(t.from_available + t.from_allowance), t.from_available, t.from_allowance, '{}'::jsonb);
      if t.shortfall > 0 then
        perform cl_stock_event('sale:'||v_sale||':'||v_p||':short', 'sale:'||v_sale, me.business_id, b.id, me.id, v_p, 'discrepancy', 0, 0, 0,
                               jsonb_build_object('shortfall', t.shortfall, 'what', 'offline sale not covered'));
        short := short + t.shortfall;
      end if;
      lines_out := lines_out || jsonb_build_object('product_uid', v_p, 'from_allowance', t.from_allowance, 'from_available', t.from_available, 'shortfall', t.shortfall);
    end loop;
    sales_out := sales_out || jsonb_build_object('sale_uid', v_sale, 'lines', lines_out);
  end loop;
  for l in select value from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb)) loop
    v_uid := l->>'uid'; v_p := l->>'product_uid'; v_d := (l->>'delta')::integer;
    if v_uid is null or v_uid !~ '^[0-9a-f]{32}$' or v_d is null or v_d = 0 then raise exception 'Each movement needs a uid and a change' using errcode = 'P0001'; end if;
    if exists (select 1 from cl_stock_events where ref_uid = 'move:'||v_uid) then
      moves_out := moves_out || jsonb_build_object('uid', v_uid, 'already', true); continue;
    end if;
    if not exists (select 1 from cl_catalogue_products where business_id = me.business_id and product_uid = v_p) then
      moves_out := moves_out || jsonb_build_object('uid', v_uid, 'reason', 'UNKNOWN_PRODUCT'); continue;
    end if;
    if v_d > 0 then
      perform cl_stock_add(me.business_id, b.id, v_p, v_d);
      perform cl_stock_event('move:'||v_uid||':'||v_p, 'move:'||v_uid, me.business_id, b.id, me.id, v_p, 'move', v_d, 0, 0,
                             jsonb_build_object('kind', l->>'kind', 'offline', true));
      moves_out := moves_out || jsonb_build_object('uid', v_uid, 'ok', true);
    else
      select * into t from cl_stock_take(b.id, v_p, me.id, -v_d, true);
      perform cl_stock_event('move:'||v_uid||':'||v_p, 'move:'||v_uid, me.business_id, b.id, me.id, v_p, 'move',
                             -(t.from_available + t.from_allowance), t.from_available, t.from_allowance,
                             jsonb_build_object('kind', l->>'kind', 'offline', true));
      if t.shortfall > 0 then
        perform cl_stock_event('move:'||v_uid||':'||v_p||':short', 'move:'||v_uid, me.business_id, b.id, me.id, v_p, 'discrepancy', 0, 0, 0,
                               jsonb_build_object('shortfall', t.shortfall, 'what', coalesce(l->>'kind', 'movement')||' not covered'));
        short := short + t.shortfall;
      end if;
      moves_out := moves_out || jsonb_build_object('uid', v_uid, 'ok', true, 'from_allowance', t.from_allowance, 'shortfall', t.shortfall);
    end if;
  end loop;
  perform cl_stock_check(b.id);
  return json_build_object('sales', sales_out, 'moves', moves_out, 'shortfall', short);
end $fn$;


-- 9. Stocktake at a shared branch (owner, Q4): only when no OTHER till holds
-- allowance for the counted products. Sets total to the count.
-- p_counts: [{ product_uid, counted }]
create function public.cl_stock_stocktake(p_install_id text, p_secret_phrase text, p_device_key text, p_op_id text, p_counts jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; r jsonb; v_p text; v_c integer; old_total integer; held jsonb; prods text[];
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  select * into b from cl_branches where id = me.branch_id;
  if b.stock_mode <> 'shared' then return json_build_object('error', 'NOT_SHARED'); end if;
  if p_op_id is null or p_op_id !~ '^[0-9a-f]{32}$' then raise exception 'A stocktake needs an operation id' using errcode = 'P0001'; end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  if exists (select 1 from cl_stock_events where ref_uid = 'stocktake:'||p_op_id) then
    return json_build_object('ok', true, 'already', true);
  end if;
  select array_agg(value->>'product_uid') into prods from jsonb_array_elements(p_counts);
  select jsonb_agg(distinct t.till_code) into held from cl_till_allowance a join cl_terminals t on t.id = a.terminal_id
   where a.branch_id = b.id and a.terminal_id <> me.id and a.qty > 0 and a.product_uid = any (prods);
  if held is not null then return json_build_object('error', 'ALLOWANCE_HELD', 'tills', held); end if;
  for r in select value from jsonb_array_elements(p_counts) loop
    v_p := r->>'product_uid'; v_c := (r->>'counted')::integer;
    if v_c is null or v_c < 0 then raise exception 'Counts must be zero or more' using errcode = 'P0001'; end if;
    if not exists (select 1 from cl_catalogue_products where business_id = me.business_id and product_uid = v_p) then continue; end if;
    perform cl_stock_return(me.business_id, b.id, me.id, v_p, 'stocktake');
    select total into old_total from cl_branch_stock where branch_id = b.id and product_uid = v_p for update;
    if not found then
      perform cl_stock_add(me.business_id, b.id, v_p, v_c); old_total := 0;
    else
      update cl_branch_stock set total = v_c, available = v_c, change_seq = nextval('cl_catalogue_seq') where branch_id = b.id and product_uid = v_p;
    end if;
    perform cl_stock_event('stocktake:'||p_op_id||':'||v_p, 'stocktake:'||p_op_id, me.business_id, b.id, me.id, v_p, 'stocktake',
                           v_c - coalesce(old_total, 0), 0, 0, jsonb_build_object('counted', v_c, 'was', coalesce(old_total, 0)));
  end loop;
  perform cl_stock_check(b.id);
  return json_build_object('ok', true, 'stock', cl_stock_rows(me, prods, null));
end $fn$;


-- 10. Diagnostics: does every product balance? Recent discrepancies.
create function public.cl_stock_balance(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; rows json; disc json; n integer;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  select * into b from cl_branches where id = me.branch_id;
  select count(*)::int into n from cl_branch_stock where branch_id = b.id;
  select coalesce(json_agg(x order by x.product_uid), '[]'::json) into rows from (
    select bs.product_uid, c.name, c.code, bs.total, bs.available,
           coalesce((select sum(qty) from cl_till_allowance a where a.branch_id = bs.branch_id and a.product_uid = bs.product_uid), 0)::int allowances,
           coalesce((select sum(qty_delta) from cl_stock_events e where e.branch_id = bs.branch_id and e.product_uid = bs.product_uid), 0)::int events
      from cl_branch_stock bs join cl_catalogue_products c on c.business_id = bs.business_id and c.product_uid = bs.product_uid
     where bs.branch_id = b.id) x
   where x.total <> x.available + x.allowances or x.total <> x.events;
  select coalesce(json_agg(json_build_object('ts', e.ts, 'till', t.till_code, 'product', c.name, 'shortfall', e.detail->'shortfall', 'what', e.detail->>'what') order by e.ts desc), '[]'::json)
    into disc from (select * from cl_stock_events where branch_id = b.id and kind = 'discrepancy' order by ts desc limit 50) e
    left join cl_terminals t on t.id = e.terminal_id left join cl_catalogue_products c on c.business_id = e.business_id and c.product_uid = e.product_uid;
  return json_build_object('stock_mode', b.stock_mode, 'products', n, 'mismatches', rows, 'discrepancies', disc);
end $fn$;


-- 11. Branch-only products (owner, Q8): each till reports its products that
-- aren't in main's catalogue; main-branch tills see them all.
create function public.cl_stock_local_products_report(p_install_id text, p_secret_phrase text, p_device_key text, p_rows jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; n integer := 0; r jsonb;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  if (case when jsonb_typeof(p_rows) = 'array' then jsonb_array_length(p_rows) > 5000 else true end) then
    raise exception 'Send at most 5000 products' using errcode = 'P0001';
  end if;
  delete from cl_branch_local_products where terminal_id = me.id;
  for r in select value from jsonb_array_elements(p_rows) loop
    if length(btrim(coalesce(r->>'name', ''))) = 0 then continue; end if;
    insert into cl_branch_local_products (terminal_id, branch_id, business_id, code, name)
    values (me.id, me.branch_id, me.business_id, left(btrim(coalesce(r->>'code', '')), 64), left(btrim(r->>'name'), 200))
    on conflict do nothing;
    n := n + 1;
  end loop;
  return json_build_object('ok', true, 'products', n);
end $fn$;

create function public.cl_stock_local_products_list(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; res json;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  if not (select is_main from cl_branches where id = me.branch_id) then return json_build_object('error', 'NOT_MAIN'); end if;
  select coalesce(json_agg(json_build_object('branch', b.name, 'till', t.till_code, 'code', lp.code, 'name', lp.name, 'reported_ts', lp.reported_ts)
           order by b.name, lp.name), '[]'::json) into res
    from cl_branch_local_products lp join cl_branches b on b.id = lp.branch_id join cl_terminals t on t.id = lp.terminal_id
   where lp.business_id = me.business_id and t.active;
  return json_build_object('products', res);
end $fn$;


-- 12. Grants: devices call the RPCs with the anon key, like every other till RPC
do $$
declare f text;
begin
  foreach f in array array[
    'cl_stock_sync(text,text,text,bigint)', 'cl_stock_start_shared(text,text,text,text,jsonb)',
    'cl_stock_sale(text,text,text,text,jsonb)', 'cl_stock_move(text,text,text,jsonb)',
    'cl_stock_report(text,text,text,jsonb,jsonb)', 'cl_stock_stocktake(text,text,text,text,jsonb)',
    'cl_stock_balance(text,text,text)', 'cl_stock_local_products_report(text,text,text,jsonb)',
    'cl_stock_local_products_list(text,text,text)'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

commit;
