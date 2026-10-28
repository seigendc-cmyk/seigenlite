-- =====================================================================
-- v37 Stock control + notification bell (owner decisions 8, 12, 48,
-- 52-55; docs/stock-control/v37-design.md). Applied on live only after the
-- owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261115120000_stock_control.rollback.sql
-- Tested in PGlite: supabase/tests/stock-control-test.js
--
-- 1. Four new rights (decision 52-54): request_stock, recall_stock,
--    count_stock, approve_counts. The built-in roles get them as the
--    prompt's table says (existing businesses too); custom roles don't.
--    Changed: cl_shop_rights_all, cl_shop_default_rights (nothing else).
-- 2. Shelf per product per branch (decision 52): cl_branch_shelves.
-- 3. Cycle counts (decision 52): cl_cycle_counts. Blind: a count's system
--    figure and difference are given only to someone with approve_counts
--    (or a till in single operator mode). No approval, no stock change:
--    seiGEN only records the decision; the counting till moves its own stock
--    once, by the difference fixed at the count.
-- 4. Stock requests (decision 53, B3): cl_stock_requests (+ lines), from a
--    branch to main; approved all / part / rejected with a reason; linked to
--    the DN main sends; received with its GRV.
-- 5. Recalls (decision 54): cl_stock_recalls (+ lines), from main to a
--    branch; the branch sends back with a normal DN (short lines with a
--    reason); received with main's GRV. A recall never moves stock.
-- 6. A DN's GRV or cancel moves its request / recall on (a trigger on
--    cl_dispatches; the dispatch and GRV functions are unchanged).
-- 7. Market feed (decisions 12, 55): seiGEN's broadcasts, kept from the
--    Console (module "market_feed", every change logged), read by every
--    device of every business, Guest seats included.
-- Devices: one push (cl_device_stock_ctl_push: events, one answer per uid,
-- idempotent; seiGEN checks the right of each with cl_seat_need, decision
-- 48) and one pull (cl_device_stock_ctl_pull: a cursor, plus the last two
-- minutes again so a late commit is never skipped). No customer data, no
-- prices; costs only as an approved count's unit cost.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_cycle_counts' n where to_regclass('public.cl_cycle_counts') is not null
    union all select 'table cl_stock_requests' where to_regclass('public.cl_stock_requests') is not null
    union all select 'table cl_stock_recalls' where to_regclass('public.cl_stock_recalls') is not null
    union all select 'table cl_branch_shelves' where to_regclass('public.cl_branch_shelves') is not null
    union all select 'table cl_market_feed' where to_regclass('public.cl_market_feed') is not null
    union all select 'module market_feed' where exists (select 1 from public.cl_modules where key = 'market_feed')
    union all select 'right count_stock' where 'count_stock' = any(public.cl_shop_rights_all())
  ) x;
  if conflicts is not null then raise exception 'stock_control aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'table cl_dispatches (20261017120000)' n where to_regclass('public.cl_dispatches') is null
    union all select 'function cl_seat_need (20261109120000)' where to_regprocedure('public.cl_seat_need(text)') is null
    union all select 'function cl_caller_rights (20261114120000)' where to_regprocedure('public.cl_caller_rights()') is null
    union all select 'function cl_guest_seat (20261114120000)' where to_regprocedure('public.cl_guest_seat()') is null
    union all select 'sequence cl_shop_seq (20261107120000)' where to_regclass('public.cl_shop_seq') is null
    union all select 'function cl_rpn_staff (20261015120000)' where to_regprocedure('public.cl_rpn_staff(text[])') is null
  ) x;
  if missing is not null then raise exception 'stock_control aborted: missing %. Nothing was changed.', missing; end if;
end $$;

-- 1. Rights (prompt's rights table; decisions 52-54) ---------------------
-- cl_shop_rights_all (current body: 20261107120000_shop_roles.sql) + the four new keys
create or replace function public.cl_shop_rights_all() returns text[]
language sql immutable as $$
  select array['m.sell', 'm.products', 'm.credit', 'm.reports', 'm.marketing',
               'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming',
               'm.productlist', 'm.stocktake', 'm.requests', 'm.purchasing', 'm.reportwriter', 'm.directory',
               'm.settings', 'm.staff', 'm.terminals', 'm.eod',
               'costs', 'edit_prices', 'create_customers', 'review_requisitions', 'other_branches',
               'approve_writeoffs', 'void_return', 'credit_over_limit', 'sales_reports',
               'request_stock', 'recall_stock', 'count_stock', 'approve_counts',   -- v37
               'owner']::text[]
$$;
-- cl_shop_default_rights (current body: 20261114120000_roles_everywhere.sql) + the new keys per built-in role
create or replace function public.cl_shop_default_rights(p_builtin text) returns text[]
language sql immutable as $$
  select case p_builtin
    when 'owner' then public.cl_shop_rights_all()
    when 'admin' then array_remove(public.cl_shop_rights_all(), 'owner')
    when 'manager' then array['m.sell', 'm.products', 'm.credit', 'm.reports', 'm.marketing', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming',
                              'm.productlist', 'm.stocktake', 'm.requests', 'm.purchasing', 'm.reportwriter', 'm.directory', 'm.eod',
                              'costs', 'edit_prices', 'create_customers', 'review_requisitions', 'other_branches',
                              'approve_writeoffs', 'void_return', 'credit_over_limit', 'sales_reports',
                              'request_stock', 'recall_stock', 'count_stock', 'approve_counts']::text[]   -- v37
    when 'stores' then array['m.products', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming', 'm.productlist', 'm.stocktake',
                             'm.purchasing', 'm.reports', 'm.reportwriter',
                             'request_stock', 'count_stock']::text[]   -- v37
    when 'cashier' then array['m.sell', 'm.credit', 'm.productlist', 'm.directory', 'm.requests', 'm.reports', 'm.eod', 'sales_reports',
                              'request_stock']::text[]   -- v37
    when 'guest' then array['m.productlist', 'branch_prices']::text[]   -- v36 (decision 49): stock and selling prices, view only
  end
$$;
-- The built-in roles of every business get their new rights now (a changed role keeps its other choices); tills pull them.
update public.cl_shop_roles r
   set rights = r.rights || array(select x from unnest(public.cl_shop_default_rights(r.builtin)) x
                                   where x = any(array['request_stock', 'recall_stock', 'count_stock', 'approve_counts']) and not (x = any(r.rights))),
       change_seq = nextval('public.cl_shop_seq'), updated_at = now(), updated_by = 'seiGEN'
 where r.builtin in ('owner', 'admin', 'manager', 'stores', 'cashier')
   and exists (select 1 from unnest(public.cl_shop_default_rights(r.builtin)) x
                where x = any(array['request_stock', 'recall_stock', 'count_stock', 'approve_counts']) and not (x = any(r.rights)));

-- 2. Tables ---------------------------------------------------------------
create sequence public.cl_stock_ctl_seq;

-- A product's shelf or location at one branch (decision 52). product_key: the catalogue uid, or a branch-only product's own uid.
create table public.cl_branch_shelves (
  business_id uuid not null references public.cl_businesses(id),
  branch_id   uuid not null references public.cl_branches(id),
  product_key text not null check (length(product_key) between 1 and 64),
  shelf       text not null default '' check (length(shelf) <= 20),
  set_ts      timestamptz not null,
  set_by      text check (set_by is null or length(set_by) <= 80),
  change_seq  bigint not null default nextval('public.cl_stock_ctl_seq'),
  updated_at  timestamptz not null default now(),
  primary key (branch_id, product_key)
);
create index cl_branch_shelves_seq_idx on public.cl_branch_shelves (branch_id, change_seq);

-- One cycle count (decision 52): made on the counting till (its uid), decided by someone with approve_counts.
create table public.cl_cycle_counts (
  id                  uuid primary key,
  business_id         uuid not null references public.cl_businesses(id),
  branch_id           uuid not null references public.cl_branches(id),
  terminal_id         uuid not null references public.cl_terminals(id),        -- the counting till or Office seat (decision 16): it alone moves its stock
  product_key         text not null check (length(product_key) between 1 and 64),
  code                text check (code is null or length(code) <= 64),
  name                text not null check (length(btrim(name)) between 1 and 120),
  shelf               text check (shelf is null or length(shelf) <= 20),
  reason              text check (reason is null or length(reason) <= 160),    -- why it was on the list
  recount_of          uuid references public.cl_cycle_counts(id),
  counted_qty         integer not null check (counted_qty between 0 and 10000000),
  system_qty          integer not null check (system_qty between -10000000 and 10000000),   -- at the moment of the count (hidden from the counter)
  diff                integer not null,
  counted_ts          timestamptz not null,
  counted_by          text check (counted_by is null or length(counted_by) <= 80),
  counted_staff_id    uuid,
  status              text not null check (status in ('closed', 'waiting', 'approved', 'recount', 'rejected')),
  decided_by          text check (decided_by is null or length(decided_by) <= 80),
  decided_at          timestamptz,
  decided_terminal_id uuid references public.cl_terminals(id),
  decision_note       text check (decision_note is null or length(decision_note) <= 200),
  applied_at          timestamptz,                                             -- the counting till moved its stock
  adj_display         text check (adj_display is null or length(adj_display) <= 40),
  unit_cost           numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  created_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('public.cl_stock_ctl_seq'),
  updated_at          timestamptz not null default now(),
  check (diff = counted_qty - system_qty)
);
create index cl_cycle_counts_branch_idx on public.cl_cycle_counts (branch_id, change_seq);
create index cl_cycle_counts_waiting_idx on public.cl_cycle_counts (business_id, status);

-- A branch asks main for stock (decision 53; Branches design B3, §R9).
create table public.cl_stock_requests (
  id                 uuid primary key,                                         -- made on the requesting device
  business_id        uuid not null references public.cl_businesses(id),
  req_no             text not null check (length(req_no) between 1 and 40),
  from_branch_id     uuid not null references public.cl_branches(id),          -- the requester
  to_branch_id       uuid not null references public.cl_branches(id),          -- main
  terminal_id        uuid not null references public.cl_terminals(id),
  requested_by       text check (requested_by is null or length(requested_by) <= 80),
  requested_staff_id uuid,
  reason             text not null check (length(btrim(reason)) between 1 and 200),
  needed_by          date,
  status             text not null default 'pending' check (status in ('pending', 'approved', 'part_approved', 'rejected', 'dispatched', 'received')),
  decided_by         text check (decided_by is null or length(decided_by) <= 80),
  decided_at         timestamptz,
  decision_note      text check (decision_note is null or length(decision_note) <= 200),
  dispatch_id        uuid references public.cl_dispatches(id),
  created_ts         timestamptz not null,                                     -- on the device
  created_at         timestamptz not null default now(),
  change_seq         bigint not null default nextval('public.cl_stock_ctl_seq'),
  updated_at         timestamptz not null default now(),
  check (from_branch_id <> to_branch_id),
  unique (terminal_id, req_no)
);
create index cl_stock_requests_biz_idx on public.cl_stock_requests (business_id, change_seq);
create index cl_stock_requests_dispatch_idx on public.cl_stock_requests (dispatch_id) where dispatch_id is not null;
create table public.cl_stock_request_lines (
  request_id   uuid not null references public.cl_stock_requests(id) on delete cascade,
  line_no      integer not null check (line_no between 1 and 200),
  product_key  text check (product_key is null or length(product_key) <= 64),
  code         text check (code is null or length(code) <= 64),
  name         text not null check (length(btrim(name)) between 1 and 120),
  qty          integer not null check (qty between 1 and 1000000),
  approved_qty integer check (approved_qty is null or approved_qty between 0 and qty),
  primary key (request_id, line_no)
);

-- Main recalls stock from a branch (decision 54).
create table public.cl_stock_recalls (
  id            uuid primary key,                                              -- made on main's device
  business_id   uuid not null references public.cl_businesses(id),
  rcl_no        text not null check (length(rcl_no) between 1 and 40),
  branch_id     uuid not null references public.cl_branches(id),               -- recalled from
  to_branch_id  uuid not null references public.cl_branches(id),               -- main
  terminal_id   uuid not null references public.cl_terminals(id),
  created_by    text check (created_by is null or length(created_by) <= 80),
  created_staff_id uuid,
  reason_kind   text not null check (reason_kind in ('expiring', 'overstock', 'move', 'quality', 'other')),
  reason        text check (reason is null or length(reason) <= 200),
  due_date      date not null,
  status        text not null default 'open' check (status in ('open', 'partly_sent', 'sent', 'received', 'cancelled')),
  dispatch_id   uuid references public.cl_dispatches(id),
  sent_by       text check (sent_by is null or length(sent_by) <= 80),
  cancelled_by  text,
  cancel_note   text check (cancel_note is null or length(cancel_note) <= 200),
  created_ts    timestamptz not null,
  created_at    timestamptz not null default now(),
  change_seq    bigint not null default nextval('public.cl_stock_ctl_seq'),
  updated_at    timestamptz not null default now(),
  check (branch_id <> to_branch_id),
  check (reason_kind <> 'other' or length(btrim(coalesce(reason, ''))) > 0),
  unique (terminal_id, rcl_no)
);
create index cl_stock_recalls_biz_idx on public.cl_stock_recalls (business_id, change_seq);
create index cl_stock_recalls_dispatch_idx on public.cl_stock_recalls (dispatch_id) where dispatch_id is not null;
create table public.cl_stock_recall_lines (
  recall_id    uuid not null references public.cl_stock_recalls(id) on delete cascade,
  line_no      integer not null check (line_no between 1 and 200),
  product_key  text check (product_key is null or length(product_key) <= 64),
  code         text check (code is null or length(code) <= 64),
  name         text not null check (length(btrim(name)) between 1 and 120),
  qty          integer not null check (qty between 0 and 1000000),            -- 0 with all_on_hand: whatever the branch holds
  all_on_hand  boolean not null default false,
  sent_qty     integer check (sent_qty is null or sent_qty >= 0),
  short_qty    integer check (short_qty is null or short_qty >= 0),
  short_reason text check (short_reason is null or length(short_reason) <= 200),
  primary key (recall_id, line_no),
  check (qty > 0 or all_on_hand)
);

-- Who did what to a request, recall or count.
create table public.cl_stock_ctl_log (
  id          bigserial primary key,
  doc_kind    text not null check (doc_kind in ('request', 'recall', 'count')),
  doc_id      uuid not null,
  at          timestamptz not null default now(),
  terminal_id uuid references public.cl_terminals(id),
  by_name     text,
  action      text not null,
  detail      jsonb
);
create index cl_stock_ctl_log_doc_idx on public.cl_stock_ctl_log (doc_id, id);

-- seiGEN's broadcasts to every shop (decisions 12, 55): titles in the bell, the message when opened.
create table public.cl_market_feed (
  id         bigserial primary key,
  title      text not null check (length(btrim(title)) between 3 and 120),
  body       text not null default '' check (length(body) <= 2000),
  active     boolean not null default true,
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.cl_staff(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.cl_staff(id) on delete set null,
  check (ends_at is null or ends_at > starts_at)
);
insert into public.cl_modules (id, key, label, description, sort_order)
select gen_random_uuid(), 'market_feed', 'Market feed', 'Market feed: broadcasts from seiGEN shown in every shop''s notification bell', 70;

-- 3. Helpers (not callable by devices or staff) ---------------------------
create function public.cl_stock_ctl_log_add(p_kind text, p_doc uuid, p_terminal uuid, p_by text, p_action text, p_detail jsonb) returns void
language sql security definer set search_path = public as $$
  insert into cl_stock_ctl_log (doc_kind, doc_id, terminal_id, by_name, action, detail) values (p_kind, p_doc, p_terminal, cl_dispatch_name(p_by, 80), p_action, p_detail)
$$;
create function public.cl_stock_ctl_main(p_business uuid) returns uuid
language sql stable security definer set search_path = public as $$ select id from cl_branches where business_id = p_business and is_main $$;
create function public.cl_stock_ctl_text(p_value text, p_max integer) returns text
language sql immutable as $$ select nullif(left(btrim(coalesce(p_value, '')), p_max), '') $$;
create function public.cl_stock_ctl_date(p_value text) returns date
language plpgsql immutable as $fn$
begin
  if coalesce(p_value, '') !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p_value::date;
exception when others then return null;
end $fn$;
-- May the caller see a count's system figure and difference? (blind counts, decision 52)
create function public.cl_stock_ctl_sees_diff(me public.cl_terminals) returns boolean
language plpgsql stable security definer set search_path = public as $fn$
declare v_rights text[] := cl_caller_rights();
begin
  if v_rights is not null then return 'approve_counts' = any(v_rights); end if;
  -- nobody signed in: an Office seat never; a till in single operator mode as every approval there (Admin passcode on the device)
  return me.device_kind <> 'seat' and coalesce(me.staff_mode, 'single') <> 'roles';
end $fn$;

create function public.cl_stock_request_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'req_no', r.req_no, 'from_branch_id', r.from_branch_id, 'from_branch', fb.name,
    'to_branch_id', r.to_branch_id, 'to_branch', tb.name, 'terminal_id', r.terminal_id, 'requested_by', r.requested_by,
    'reason', r.reason, 'needed_by', r.needed_by, 'status', r.status, 'decided_by', r.decided_by, 'decided_at', r.decided_at,
    'decision_note', r.decision_note, 'dispatch_id', r.dispatch_id, 'dn_display', d.dn_display, 'dn_status', d.status,
    'grv_display', d.grv_display, 'received_at', d.received_at, 'created_ts', r.created_ts, 'created_at', r.created_at, 'change_seq', r.change_seq,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'product_key', l.product_key, 'code', l.code, 'name', l.name,
        'qty', l.qty, 'approved_qty', l.approved_qty) order by l.line_no) from cl_stock_request_lines l where l.request_id = r.id), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', g.at, 'by', g.by_name, 'action', g.action, 'detail', g.detail) order by g.id)
        from cl_stock_ctl_log g where g.doc_id = r.id and g.doc_kind = 'request'), '[]'::jsonb))
  from cl_stock_requests r join cl_branches fb on fb.id = r.from_branch_id join cl_branches tb on tb.id = r.to_branch_id
  left join cl_dispatches d on d.id = r.dispatch_id
  where r.id = p_id
$$;
create function public.cl_stock_recall_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', c.id, 'rcl_no', c.rcl_no, 'branch_id', c.branch_id, 'branch', fb.name, 'to_branch_id', c.to_branch_id, 'to_branch', tb.name,
    'terminal_id', c.terminal_id, 'created_by', c.created_by, 'created_staff_id', c.created_staff_id, 'reason_kind', c.reason_kind, 'reason', c.reason, 'due_date', c.due_date,
    'status', c.status, 'overdue', c.status = 'open' and c.due_date < (now() at time zone 'Africa/Harare')::date,
    'dispatch_id', c.dispatch_id, 'dn_display', d.dn_display, 'dn_status', d.status, 'grv_display', d.grv_display, 'received_at', d.received_at,
    'sent_by', c.sent_by, 'cancelled_by', c.cancelled_by, 'cancel_note', c.cancel_note,
    'created_ts', c.created_ts, 'created_at', c.created_at, 'change_seq', c.change_seq,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'product_key', l.product_key, 'code', l.code, 'name', l.name,
        'qty', l.qty, 'all_on_hand', l.all_on_hand, 'sent_qty', l.sent_qty, 'short_qty', l.short_qty, 'short_reason', l.short_reason) order by l.line_no)
        from cl_stock_recall_lines l where l.recall_id = c.id), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', g.at, 'by', g.by_name, 'action', g.action, 'detail', g.detail) order by g.id)
        from cl_stock_ctl_log g where g.doc_id = c.id and g.doc_kind = 'recall'), '[]'::jsonb))
  from cl_stock_recalls c join cl_branches fb on fb.id = c.branch_id join cl_branches tb on tb.id = c.to_branch_id
  left join cl_dispatches d on d.id = c.dispatch_id
  where c.id = p_id
$$;
create function public.cl_cycle_count_json(c public.cl_cycle_counts, p_sees boolean) returns jsonb
language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object('id', c.id, 'branch_id', c.branch_id, 'terminal_id', c.terminal_id, 'product_key', c.product_key,
    'code', c.code, 'name', c.name, 'shelf', c.shelf, 'reason', c.reason, 'recount_of', c.recount_of, 'counted_qty', c.counted_qty,
    'system_qty', case when p_sees then c.system_qty end, 'diff', case when p_sees then c.diff end,
    'counted_ts', c.counted_ts, 'counted_by', c.counted_by, 'status', c.status, 'decided_by', c.decided_by, 'decided_at', c.decided_at,
    'decision_note', c.decision_note, 'applied_at', c.applied_at, 'adj_display', c.adj_display,
    'unit_cost', case when p_sees then c.unit_cost end, 'change_seq', c.change_seq))
$$;
-- The market feed as devices see it: what is on now, newest first.
create function public.cl_market_feed_now() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'title', f.title, 'body', f.body, 'starts_at', f.starts_at) order by f.starts_at desc, f.id desc), '[]'::jsonb)
    from (select * from cl_market_feed where active and starts_at <= now() and (ends_at is null or ends_at > now())
           order by starts_at desc, id desc limit 30) f
$$;

-- 4. One event from a device (cl_device_stock_ctl_push) ------------------------
-- -> 'stored' | 'duplicate'; refusals raise "CODE: message".
create function public.cl_stock_ctl_event(me public.cl_terminals, e jsonb) returns text
language plpgsql security definer set search_path = public as $fn$
declare v_type text := coalesce(e->>'type', ''); v_id uuid; v_main uuid := cl_stock_ctl_main(me.business_id);
        v_by text := cl_stock_ctl_text(e->>'by', 80); v_note text := cl_stock_ctl_text(e->>'note', 200);
        c cl_cycle_counts%rowtype; old cl_cycle_counts%rowtype; rq cl_stock_requests%rowtype; rc cl_stock_recalls%rowtype; d cl_dispatches%rowtype;
        l jsonb; n integer := 0; v_short boolean := false; v_action text; v_status text; v_part boolean := false; v_any boolean := false;
        v_qty integer; v_line record; v_ts timestamptz;
        -- the person signed in on the calling seat or till (set by cl_install_vendor), or null in single operator mode
        v_staff uuid := nullif(coalesce(nullif(current_setting('cl.seat_staff', true), ''), current_setting('cl.till_staff', true)), '')::uuid;
begin
  if v_type <> 'shelf' then
    begin v_id := (e->>'id')::uuid; exception when others then raise exception 'BAD_EVENT: The event has no id.'; end;
    if v_id is null then raise exception 'BAD_EVENT: The event has no id.'; end if;
  end if;

  -- a shelf at this branch (Products right)
  if v_type = 'shelf' then
    perform cl_seat_need('m.products');
    if coalesce(e->>'product_key', '') !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'BAD_EVENT: Which product?'; end if;
    v_ts := coalesce(nullif(e->>'ts', '')::timestamptz, now());
    insert into cl_branch_shelves (business_id, branch_id, product_key, shelf, set_ts, set_by)
    values (me.business_id, me.branch_id, e->>'product_key', coalesce(left(btrim(coalesce(e->>'shelf', '')), 20), ''), v_ts, v_by)
    on conflict (branch_id, product_key) do update set shelf = excluded.shelf, set_ts = excluded.set_ts, set_by = excluded.set_by,
           change_seq = nextval('cl_stock_ctl_seq'), updated_at = now()
     where cl_branch_shelves.set_ts <= excluded.set_ts and cl_branch_shelves.shelf is distinct from excluded.shelf;
    return 'stored';
  end if;

  -- a cycle count, made on this till (count_stock)
  if v_type = 'count' then
    perform cl_seat_need('count_stock');
    if exists (select 1 from cl_cycle_counts where id = v_id) then return 'duplicate'; end if;
    if coalesce(e->>'product_key', '') !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'BAD_EVENT: Which product?'; end if;
    if e->>'recount_of' is not null then
      select * into old from cl_cycle_counts where id = (e->>'recount_of')::uuid and business_id = me.business_id;
      if old.id is null then raise exception 'NOT_FOUND: The count to recount isn''t on seiGEN.'; end if;
      if old.status <> 'recount' then raise exception 'WRONG_STATUS: That count wasn''t sent back for a recount.'; end if;
      if old.counted_by is not null and lower(btrim(old.counted_by)) not in ('', 'single operator') and lower(btrim(old.counted_by)) = lower(btrim(coalesce(e->>'counted_by', ''))) then
        raise exception 'SAME_COUNTER: The recount must be by someone other than %.', old.counted_by;
      end if;
    end if;
    insert into cl_cycle_counts (id, business_id, branch_id, terminal_id, product_key, code, name, shelf, reason, recount_of,
                                 counted_qty, system_qty, diff, counted_ts, counted_by, counted_staff_id, status)
    values (v_id, me.business_id, me.branch_id, me.id, e->>'product_key', cl_stock_ctl_text(e->>'code', 64), coalesce(cl_stock_ctl_text(e->>'name', 120), '?'),
            cl_stock_ctl_text(e->>'shelf', 20), cl_stock_ctl_text(e->>'reason', 160), nullif(e->>'recount_of', '')::uuid,
            (e->>'counted_qty')::integer, (e->>'system_qty')::integer, (e->>'counted_qty')::integer - (e->>'system_qty')::integer,
            coalesce(nullif(e->>'counted_ts', '')::timestamptz, now()), cl_stock_ctl_text(e->>'counted_by', 80), nullif(e->>'staff_id', '')::uuid,
            case when (e->>'counted_qty')::integer = (e->>'system_qty')::integer then 'closed' else 'waiting' end);
    perform cl_stock_ctl_log_add('count', v_id, me.id, e->>'counted_by', 'counted', null);
    return 'stored';
  end if;

  -- a decision on a count (approve_counts), on any device of the business
  if v_type = 'count_decide' then
    perform cl_seat_need('approve_counts');
    v_action := coalesce(e->>'action', '');
    if v_action not in ('approve', 'recount', 'reject') then raise exception 'BAD_EVENT: Approve, recount or reject.'; end if;
    select * into c from cl_cycle_counts where id = v_id and business_id = me.business_id for update;
    if c.id is null then raise exception 'NOT_FOUND: That count isn''t on seiGEN yet.'; end if;
    v_status := case v_action when 'approve' then 'approved' when 'recount' then 'recount' else 'rejected' end;
    if c.status = v_status and c.decided_by is not distinct from v_by then return 'duplicate'; end if;
    if c.status <> 'waiting' then raise exception 'ALREADY_DECIDED: % already decided it (%).', coalesce(c.decided_by, 'Someone'), c.status; end if;
    if v_by is null then raise exception 'BAD_EVENT: Who decided?'; end if;
    update cl_cycle_counts set status = v_status, decided_by = v_by, decided_at = coalesce(nullif(e->>'ts', '')::timestamptz, now()),
           decided_terminal_id = me.id, decision_note = v_note, change_seq = nextval('cl_stock_ctl_seq'), updated_at = now() where id = c.id;
    perform cl_stock_ctl_log_add('count', c.id, me.id, v_by, v_status, jsonb_strip_nulls(jsonb_build_object('note', v_note)));
    return 'stored';
  end if;

  -- the counting till moved its stock for an approved count
  if v_type = 'count_applied' then
    select * into c from cl_cycle_counts where id = v_id and business_id = me.business_id for update;
    if c.id is null then raise exception 'NOT_FOUND: That count isn''t on seiGEN.'; end if;
    if c.terminal_id <> me.id then raise exception 'WRONG_DEVICE: Only the till that counted moves its stock.'; end if;
    if c.status <> 'approved' then raise exception 'WRONG_STATUS: That count isn''t approved.'; end if;
    if c.applied_at is not null then return 'duplicate'; end if;
    update cl_cycle_counts set applied_at = coalesce(nullif(e->>'ts', '')::timestamptz, now()), adj_display = cl_stock_ctl_text(e->>'adj_display', 40),
           unit_cost = nullif(e->>'unit_cost', '')::numeric, change_seq = nextval('cl_stock_ctl_seq'), updated_at = now() where id = c.id;
    perform cl_stock_ctl_log_add('count', c.id, me.id, v_by, 'applied', jsonb_strip_nulls(jsonb_build_object('adj', e->>'adj_display')));
    return 'stored';
  end if;

  -- a stock request from this branch to main (request_stock)
  if v_type = 'request_create' then
    perform cl_seat_need('request_stock');
    if exists (select 1 from cl_stock_requests where id = v_id) then return 'duplicate'; end if;
    if v_main is null then raise exception 'NO_MAIN: The business has no main branch on seiGEN.'; end if;
    if me.branch_id = v_main then raise exception 'IS_MAIN: Main doesn''t request stock from itself.'; end if;
    if jsonb_typeof(e->'lines') <> 'array' or jsonb_array_length(e->'lines') not between 1 and 200 then raise exception 'BAD_EVENT: Add 1 to 200 lines.'; end if;
    if cl_stock_ctl_text(e->>'reason', 200) is null then raise exception 'BAD_EVENT: Give a reason.'; end if;
    insert into cl_stock_requests (id, business_id, req_no, from_branch_id, to_branch_id, terminal_id, requested_by, requested_staff_id, reason, needed_by, created_ts)
    values (v_id, me.business_id, coalesce(cl_stock_ctl_text(e->>'req_no', 40), 'SRQ'), me.branch_id, v_main, me.id, v_by, nullif(e->>'staff_id', '')::uuid,
            cl_stock_ctl_text(e->>'reason', 200), cl_stock_ctl_date(e->>'needed_by'), coalesce(nullif(e->>'ts', '')::timestamptz, now()));
    for l in select x from jsonb_array_elements(e->'lines') x loop
      n := n + 1;
      insert into cl_stock_request_lines (request_id, line_no, product_key, code, name, qty)
      values (v_id, n, cl_stock_ctl_text(l->>'product_key', 64), cl_stock_ctl_text(l->>'code', 64), coalesce(cl_stock_ctl_text(l->>'name', 120), '?'), (l->>'qty')::integer);
    end loop;
    perform cl_stock_ctl_log_add('request', v_id, me.id, v_by, 'requested', jsonb_build_object('lines', n));
    return 'stored';
  end if;

  -- a reviewer's decision (review_requisitions), on any device of the business
  if v_type = 'request_decide' then
    perform cl_seat_need('review_requisitions');
    v_action := coalesce(e->>'action', '');
    if v_action not in ('approve', 'part', 'reject') then raise exception 'BAD_EVENT: Approve, part or reject.'; end if;
    select * into rq from cl_stock_requests where id = v_id and business_id = me.business_id for update;
    if rq.id is null then raise exception 'NOT_FOUND: That request isn''t on seiGEN yet.'; end if;
    v_status := case v_action when 'approve' then 'approved' when 'part' then 'part_approved' else 'rejected' end;
    if rq.status = v_status and rq.decided_by is not distinct from v_by then return 'duplicate'; end if;
    if rq.status <> 'pending' then raise exception 'ALREADY_DECIDED: % already decided it (%).', coalesce(rq.decided_by, 'Someone'), rq.status; end if;
    if v_by is null then raise exception 'BAD_EVENT: Who decided?'; end if;
    if v_action = 'reject' and v_note is null then raise exception 'BAD_EVENT: Give the reason for rejecting.'; end if;
    if v_action = 'approve' then
      update cl_stock_request_lines set approved_qty = qty where request_id = rq.id;
    elsif v_action = 'part' then
      if jsonb_typeof(e->'lines') <> 'array' then raise exception 'BAD_EVENT: Give each line''s approved quantity.'; end if;
      for v_line in select l.line_no, l.qty, (select (x->>'approved_qty')::integer from jsonb_array_elements(e->'lines') x where (x->>'line_no')::integer = l.line_no limit 1) aq
                      from cl_stock_request_lines l where l.request_id = rq.id loop
        v_qty := coalesce(v_line.aq, 0);
        if v_qty < 0 or v_qty > v_line.qty then raise exception 'BAD_EVENT: Line % can be approved for 0 to %.', v_line.line_no, v_line.qty; end if;
        if v_qty > 0 then v_any := true; end if;
        if v_qty < v_line.qty then v_part := true; end if;
        update cl_stock_request_lines set approved_qty = v_qty where request_id = rq.id and line_no = v_line.line_no;
      end loop;
      if not v_any then raise exception 'BAD_EVENT: Nothing approved: reject it with a reason instead.'; end if;
      if not v_part then v_status := 'approved'; end if;
    else
      update cl_stock_request_lines set approved_qty = 0 where request_id = rq.id;
    end if;
    update cl_stock_requests set status = v_status, decided_by = v_by, decided_at = coalesce(nullif(e->>'ts', '')::timestamptz, now()), decision_note = v_note,
           change_seq = nextval('cl_stock_ctl_seq'), updated_at = now() where id = rq.id;
    perform cl_stock_ctl_log_add('request', rq.id, me.id, v_by, v_status, jsonb_strip_nulls(jsonb_build_object('note', v_note)));
    return 'stored';
  end if;

  -- main's DN for an approved request (Dispatch right): the request is then "dispatched"
  if v_type = 'request_link' then
    perform cl_seat_need('m.dispatch');
    select * into rq from cl_stock_requests where id = v_id and business_id = me.business_id for update;
    if rq.id is null then raise exception 'NOT_FOUND: That request isn''t on seiGEN yet.'; end if;
    select * into d from cl_dispatches where id = nullif(e->>'dispatch_id', '')::uuid and business_id = me.business_id;
    if d.id is null then raise exception 'NO_DISPATCH: The DN isn''t on seiGEN yet.'; end if;
    if rq.dispatch_id = d.id then return 'duplicate'; end if;
    if rq.status not in ('approved', 'part_approved') then raise exception 'WRONG_STATUS: The request is %, not approved.', rq.status; end if;
    if d.from_branch_id <> rq.to_branch_id or d.to_branch_id <> rq.from_branch_id then raise exception 'WRONG_BRANCH: That DN doesn''t go from main to the requesting branch.'; end if;
    if d.status = 'cancelled' then raise exception 'WRONG_STATUS: That DN was cancelled.'; end if;
    update cl_stock_requests set status = case when d.status in ('received', 'received_diff') then 'received' else 'dispatched' end, dispatch_id = d.id,
           change_seq = nextval('cl_stock_ctl_seq'), updated_at = now() where id = rq.id;
    perform cl_stock_ctl_log_add('request', rq.id, me.id, v_by, 'dispatched', jsonb_build_object('dn', d.dn_display));
    return 'stored';
  end if;

  -- a recall from main to a branch (recall_stock)
  if v_type = 'recall_create' then
    perform cl_seat_need('recall_stock');
    if exists (select 1 from cl_stock_recalls where id = v_id) then return 'duplicate'; end if;
    if v_main is null or me.branch_id <> v_main then raise exception 'NOT_MAIN: Recalls are made at the main branch.'; end if;
    if not exists (select 1 from cl_branches where id = nullif(e->>'branch_id', '')::uuid and business_id = me.business_id and id <> v_main) then
      raise exception 'WRONG_BRANCH: Choose one of the business''s other branches.';
    end if;
    if jsonb_typeof(e->'lines') <> 'array' or jsonb_array_length(e->'lines') not between 1 and 200 then raise exception 'BAD_EVENT: Add 1 to 200 lines.'; end if;
    if cl_stock_ctl_date(e->>'due_date') is null then raise exception 'BAD_EVENT: Give a due date.'; end if;
    insert into cl_stock_recalls (id, business_id, rcl_no, branch_id, to_branch_id, terminal_id, created_by, created_staff_id, reason_kind, reason, due_date, created_ts)
    values (v_id, me.business_id, coalesce(cl_stock_ctl_text(e->>'rcl_no', 40), 'RCL'), (e->>'branch_id')::uuid, v_main, me.id, v_by, coalesce(v_staff, nullif(e->>'staff_id', '')::uuid),
            coalesce(e->>'reason_kind', ''), cl_stock_ctl_text(e->>'reason', 200), cl_stock_ctl_date(e->>'due_date'), coalesce(nullif(e->>'ts', '')::timestamptz, now()));
    for l in select x from jsonb_array_elements(e->'lines') x loop
      n := n + 1;
      insert into cl_stock_recall_lines (recall_id, line_no, product_key, code, name, qty, all_on_hand)
      values (v_id, n, cl_stock_ctl_text(l->>'product_key', 64), cl_stock_ctl_text(l->>'code', 64), coalesce(cl_stock_ctl_text(l->>'name', 120), '?'),
              coalesce((l->>'qty')::integer, 0), coalesce((l->>'all_on_hand')::boolean, false));
    end loop;
    perform cl_stock_ctl_log_add('recall', v_id, me.id, v_by, 'recalled', jsonb_build_object('lines', n));
    return 'stored';
  end if;

  -- the recalled branch's DN back to main (Dispatch right), short lines with a reason
  if v_type = 'recall_link' then
    perform cl_seat_need('m.dispatch');
    select * into rc from cl_stock_recalls where id = v_id and business_id = me.business_id for update;
    if rc.id is null then raise exception 'NOT_FOUND: That recall isn''t on seiGEN.'; end if;
    select * into d from cl_dispatches where id = nullif(e->>'dispatch_id', '')::uuid and business_id = me.business_id;
    if d.id is null then raise exception 'NO_DISPATCH: The DN isn''t on seiGEN yet.'; end if;
    if rc.dispatch_id = d.id then return 'duplicate'; end if;
    if rc.status <> 'open' then raise exception 'WRONG_STATUS: The recall is %.', rc.status; end if;
    if me.branch_id <> rc.branch_id or d.from_branch_id <> rc.branch_id or d.to_branch_id <> rc.to_branch_id then
      raise exception 'WRONG_BRANCH: That DN doesn''t go from the recalled branch to main.';
    end if;
    if d.status = 'cancelled' then raise exception 'WRONG_STATUS: That DN was cancelled.'; end if;
    for l in select x from jsonb_array_elements(coalesce(e->'lines', '[]'::jsonb)) x loop
      if coalesce((l->>'short_qty')::integer, 0) > 0 then
        v_short := true;
        if cl_stock_ctl_text(l->>'short_reason', 200) is null then raise exception 'BAD_EVENT: Give the reason a line is short.'; end if;
      end if;
      update cl_stock_recall_lines set sent_qty = greatest(0, coalesce((l->>'sent_qty')::integer, 0)), short_qty = greatest(0, coalesce((l->>'short_qty')::integer, 0)),
             short_reason = cl_stock_ctl_text(l->>'short_reason', 200)
       where recall_id = rc.id and line_no = (l->>'line_no')::integer;
    end loop;
    update cl_stock_recalls set status = case when d.status in ('received', 'received_diff') then 'received' when v_short then 'partly_sent' else 'sent' end,
           dispatch_id = d.id, sent_by = v_by, change_seq = nextval('cl_stock_ctl_seq'), updated_at = now() where id = rc.id;
    perform cl_stock_ctl_log_add('recall', rc.id, me.id, v_by, case when v_short then 'partly_sent' else 'sent' end, jsonb_build_object('dn', d.dn_display));
    return 'stored';
  end if;

  -- cancelling an open recall (decision 56): its maker, or an Owner or Admin; a reason; only before any DN for it is sent
  if v_type = 'recall_cancel' then
    select * into rc from cl_stock_recalls where id = v_id and business_id = me.business_id for update;
    if rc.id is null then raise exception 'NOT_FOUND: That recall isn''t on seiGEN.'; end if;
    if rc.status = 'cancelled' then return 'duplicate'; end if;
    -- an Owner or Admin signed in on this seat or till may cancel any open recall; anyone else needs Recall stock and to be its maker
    if not (v_staff is not null and exists (select 1 from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id
                                             where s.id = v_staff and s.active and s.business_id = me.business_id and r.builtin in ('owner', 'admin'))) then
      perform cl_seat_need('recall_stock');
      -- the maker: the same person, or (single operator mode, no one signed in) the till that made it
      if not (case when v_staff is not null then rc.created_staff_id is not distinct from v_staff
                   else rc.created_staff_id is null and rc.terminal_id = me.id end) then
        raise exception 'NOT_MAKER: Only the person who made this recall, an Owner or an Admin can cancel it.';
      end if;
    end if;
    if v_note is null then raise exception 'BAD_EVENT: Give the reason for cancelling the recall.'; end if;
    if rc.status <> 'open' or rc.dispatch_id is not null
       or exists (select 1 from cl_dispatches x where x.business_id = me.business_id and x.from_branch_id = rc.branch_id and x.to_branch_id = rc.to_branch_id
                     and x.internal_ref = rc.rcl_no and x.status <> 'cancelled') then
      raise exception 'DN_SENT: A Delivery Note for this recall has been sent, so it can''t be cancelled now.';
    end if;
    update cl_stock_recalls set status = 'cancelled', cancelled_by = v_by, cancel_note = v_note, change_seq = nextval('cl_stock_ctl_seq'), updated_at = now() where id = rc.id;
    perform cl_stock_ctl_log_add('recall', rc.id, me.id, v_by, 'cancelled', jsonb_strip_nulls(jsonb_build_object('note', v_note, 'staff_id', v_staff)));
    return 'stored';
  end if;

  raise exception 'BAD_EVENT: Unknown kind of event.';
end $fn$;

-- 5. A DN's GRV or cancel moves its request or recall on (the dispatch functions are unchanged) ----
create function public.cl_stock_ctl_on_dispatch() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare r record;
begin
  if new.status in ('received', 'received_diff') then
    for r in update cl_stock_requests set status = 'received', change_seq = nextval('cl_stock_ctl_seq'), updated_at = now()
              where dispatch_id = new.id and status = 'dispatched' returning id loop
      perform cl_stock_ctl_log_add('request', r.id, new.grv_terminal_id, new.grv_by, 'received', jsonb_build_object('grv', new.grv_display));
    end loop;
    for r in update cl_stock_recalls set status = 'received', change_seq = nextval('cl_stock_ctl_seq'), updated_at = now()
              where dispatch_id = new.id and status in ('sent', 'partly_sent') returning id loop
      perform cl_stock_ctl_log_add('recall', r.id, new.grv_terminal_id, new.grv_by, 'received', jsonb_build_object('grv', new.grv_display));
    end loop;
  elsif new.status = 'cancelled' then
    -- back to approved, so main can send another DN
    for r in update cl_stock_requests q set status = case when exists (select 1 from cl_stock_request_lines l where l.request_id = q.id and l.approved_qty < l.qty)
                                                          then 'part_approved' else 'approved' end,
                    dispatch_id = null, change_seq = nextval('cl_stock_ctl_seq'), updated_at = now()
              where q.dispatch_id = new.id and q.status = 'dispatched' returning q.id loop
      perform cl_stock_ctl_log_add('request', r.id, new.from_terminal_id, new.cancelled_by, 'dn_cancelled', jsonb_build_object('dn', new.dn_display));
    end loop;
    for r in update cl_stock_recalls set status = 'open', dispatch_id = null, sent_by = null, change_seq = nextval('cl_stock_ctl_seq'), updated_at = now()
              where dispatch_id = new.id and status in ('sent', 'partly_sent') returning id loop
      update cl_stock_recall_lines set sent_qty = null, short_qty = null, short_reason = null where recall_id = r.id;
      perform cl_stock_ctl_log_add('recall', r.id, new.from_terminal_id, new.cancelled_by, 'dn_cancelled', jsonb_build_object('dn', new.dn_display));
    end loop;
  end if;
  return null;
end $fn$;
create trigger cl_dispatches_stock_ctl after update of status on public.cl_dispatches
  for each row when (old.status is distinct from new.status) execute function public.cl_stock_ctl_on_dispatch();

-- 6. Device calls ----------------------------------------------------------------
create function public.cl_device_stock_ctl_push(p_install_id text, p_secret_phrase text, p_device_key text, p_events jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; e jsonb; v_res jsonb := '[]'::jsonb; v_uid text; v_status text; v_code text; v_msg text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  perform cl_guest_seat_refuse();
  if p_events is null or jsonb_typeof(p_events) <> 'array' then raise exception 'Send a list of events' using errcode = 'P0001'; end if;
  if jsonb_array_length(p_events) > 50 then raise exception 'At most 50 events at a time' using errcode = 'P0001'; end if;
  for e in select x from jsonb_array_elements(p_events) x loop
    v_uid := btrim(coalesce(e->>'uid', '')); v_code := null; v_msg := null;
    begin
      if v_uid !~ '^[A-Za-z0-9:_-]{8,160}$' then raise exception 'BAD_EVENT: The event has no uid.'; end if;
      v_status := cl_stock_ctl_event(me, e);
    exception when others then
      v_status := 'refused';
      v_code := coalesce(substring(sqlerrm from '^([A-Z_]+):'), 'INVALID');
      v_msg := left(regexp_replace(sqlerrm, '^[A-Z_]+: ', ''), 200);
    end;
    v_res := v_res || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('uid', v_uid, 'status', v_status, 'code', v_code, 'message', v_msg)));
  end loop;
  return json_build_object('ok', true, 'server_time', now(), 'results', v_res);
end $fn$;

-- Everything new for this device since p_cursor (and the last two minutes again).
-- For the bell (decision 55), titles only: this branch's DNs in and out of the
-- last 14 days (numbers and status) and the business's new iTred orders since
-- p_itred_after (id and time; the orders themselves come with the iTred pull).
-- A Guest's seat gets the market feed only.
create function public.cl_device_stock_ctl_pull(p_install_id text, p_secret_phrase text, p_device_key text, p_cursor bigint, p_itred_after bigint default 0)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_cur bigint := greatest(coalesce(p_cursor, 0), 0); v_since timestamptz := now() - interval '2 minutes';
        v_first boolean := coalesce(p_cursor, 0) <= 0; v_old timestamptz := now() - interval '180 days'; v_sees boolean; v_main uuid;
        v cl_vendors%rowtype; v_itred uuid; v_orders json; v_icur bigint := greatest(coalesce(p_itred_after, 0), 0);
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if cl_guest_seat() then
    return json_build_object('ok', true, 'server_time', now(), 'cursor', v_cur, 'guest', true, 'market', cl_market_feed_now());
  end if;
  v_sees := cl_stock_ctl_sees_diff(me);
  v_main := cl_stock_ctl_main(me.business_id);
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  v_itred := itred_vendor_of_device(v);
  if v_itred is not null then
    select json_agg(json_build_object('id', po.id, 'created_at', po.created_at) order by po.change_seq), max(po.change_seq) into v_orders, v_icur
      from (select * from purchase_orders where vendor_id = v_itred and change_seq > v_icur and created_at > now() - interval '7 days'
              and exists (select 1 from purchase_order_items i where i.purchase_order_id = purchase_orders.id) order by change_seq limit 100) po;
    v_icur := greatest(coalesce(v_icur, 0), coalesce(p_itred_after, 0));
  end if;
  return json_build_object('ok', true, 'server_time', now(), 'branch_id', me.branch_id, 'main_branch_id', v_main, 'is_main', me.branch_id = v_main,
    'sees_diff', v_sees,
    'cursor', greatest(v_cur,
       coalesce((select max(change_seq) from cl_branch_shelves where branch_id = me.branch_id), 0),
       coalesce((select max(change_seq) from cl_cycle_counts where business_id = me.business_id), 0),
       coalesce((select max(change_seq) from cl_stock_requests where business_id = me.business_id), 0),
       coalesce((select max(change_seq) from cl_stock_recalls where business_id = me.business_id), 0)),
    'branches', coalesce((select json_agg(json_build_object('id', b.id, 'name', b.name, 'is_main', b.is_main) order by b.is_main desc, b.name)
                           from cl_branches b where b.business_id = me.business_id), '[]'::json),
    'shelves', coalesce((select json_agg(json_build_object('product_key', s.product_key, 'shelf', s.shelf, 'set_ts', s.set_ts) order by s.change_seq)
                           from cl_branch_shelves s where s.branch_id = me.branch_id and (s.change_seq > v_cur or s.updated_at > v_since)), '[]'::json),
    -- counts: this branch's (a seat is at main, so main's)
    'counts', coalesce((select json_agg(cl_cycle_count_json(c, v_sees) order by c.change_seq) from cl_cycle_counts c
                          where c.branch_id = me.branch_id and (c.change_seq > v_cur or c.updated_at > v_since)
                            and (not v_first or c.created_at > v_old or c.status = 'waiting')), '[]'::json),
    'requests', coalesce((select json_agg(cl_stock_request_json(r.id) order by r.change_seq) from cl_stock_requests r
                            where r.business_id = me.business_id and (r.change_seq > v_cur or r.updated_at > v_since)
                              and (not v_first or r.created_at > v_old or r.status not in ('rejected', 'received'))), '[]'::json),
    'recalls', coalesce((select json_agg(cl_stock_recall_json(c.id) order by c.change_seq) from cl_stock_recalls c
                           where c.business_id = me.business_id and (c.branch_id = me.branch_id or me.branch_id = v_main)
                             and (c.change_seq > v_cur or c.updated_at > v_since)
                             and (not v_first or c.created_at > v_old or c.status not in ('received', 'cancelled'))), '[]'::json),
    'dispatches', coalesce((select json_agg(json_build_object('id', d.id, 'dn_display', d.dn_display, 'grv_display', d.grv_display, 'status', d.status,
                               'from_branch_id', d.from_branch_id, 'from_branch', fb.name, 'to_branch_id', d.to_branch_id, 'to_branch', tb.name,
                               'sent_at', d.sent_at, 'received_at', d.received_at) order by d.sent_at)
                              from cl_dispatches d join cl_branches fb on fb.id = d.from_branch_id join cl_branches tb on tb.id = d.to_branch_id
                             where (d.to_branch_id = me.branch_id or d.from_branch_id = me.branch_id)
                               and greatest(d.sent_at, coalesce(d.received_at, d.sent_at)) > now() - interval '14 days'), '[]'::json),
    'itred', case when v_itred is null then null else coalesce(v_orders, '[]'::json) end, 'itred_cursor', v_icur,
    'market', cl_market_feed_now());
end $fn$;

-- 7. Console: the market feed (module "market_feed") ------------------------------
create function public.cl_market_feed_all() returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['market_feed']);
  return coalesce((select json_agg(json_build_object('id', f.id, 'title', f.title, 'body', f.body, 'active', f.active, 'starts_at', f.starts_at,
      'ends_at', f.ends_at, 'created_at', f.created_at, 'updated_at', f.updated_at,
      'live', f.active and f.starts_at <= now() and (f.ends_at is null or f.ends_at > now())) order by f.starts_at desc, f.id desc)
    from cl_market_feed f), '[]'::json);
end $fn$;
-- Add (p_id null) or change a broadcast. Titles only in the bell: never amounts, prices or names of people (decision 8).
create function public.cl_market_feed_save(p_id bigint, p_title text, p_body text, p_active boolean, p_starts_at timestamptz, p_ends_at timestamptz) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['market_feed']); v_title text := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
        v_body text := btrim(coalesce(p_body, '')); old cl_market_feed%rowtype; r cl_market_feed%rowtype;
begin
  if length(v_title) < 3 or length(v_title) > 120 then raise exception 'Give a title of 3 to 120 characters'; end if;
  if length(v_body) > 2000 then raise exception 'Keep the message to 2,000 characters'; end if;
  if p_ends_at is not null and p_ends_at <= coalesce(p_starts_at, now()) then raise exception 'The end must be after the start'; end if;
  if p_id is null then
    insert into cl_market_feed (title, body, active, starts_at, ends_at, created_by, updated_by)
    values (v_title, v_body, coalesce(p_active, true), coalesce(p_starts_at, now()), p_ends_at, v_staff, v_staff) returning * into r;
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'market_feed_added', 'cl_market_feed', null, jsonb_build_object('id', r.id, 'title', r.title, 'active', r.active, 'starts_at', r.starts_at, 'ends_at', r.ends_at));
  else
    select * into old from cl_market_feed where id = p_id for update;
    if old.id is null then raise exception 'That broadcast doesn''t exist'; end if;
    update cl_market_feed set title = v_title, body = v_body, active = coalesce(p_active, old.active), starts_at = coalesce(p_starts_at, old.starts_at),
           ends_at = p_ends_at, updated_at = now(), updated_by = v_staff where id = p_id returning * into r;
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (v_staff, 'market_feed_changed', 'cl_market_feed', null,
            jsonb_build_object('id', r.id, 'title', r.title, 'active', r.active, 'starts_at', r.starts_at, 'ends_at', r.ends_at,
                               'was', jsonb_build_object('title', old.title, 'active', old.active, 'starts_at', old.starts_at, 'ends_at', old.ends_at)));
  end if;
  return json_build_object('ok', true, 'id', r.id);
end $fn$;

-- 8. Who may call what ----------------------------------------------------------
alter table public.cl_branch_shelves enable row level security;
alter table public.cl_cycle_counts enable row level security;
alter table public.cl_stock_requests enable row level security;
alter table public.cl_stock_request_lines enable row level security;
alter table public.cl_stock_recalls enable row level security;
alter table public.cl_stock_recall_lines enable row level security;
alter table public.cl_stock_ctl_log enable row level security;
alter table public.cl_market_feed enable row level security;
revoke all on table public.cl_branch_shelves, public.cl_cycle_counts, public.cl_stock_requests, public.cl_stock_request_lines,
  public.cl_stock_recalls, public.cl_stock_recall_lines, public.cl_stock_ctl_log, public.cl_market_feed from public, anon, authenticated;
revoke all on sequence public.cl_stock_ctl_seq, public.cl_stock_ctl_log_id_seq, public.cl_market_feed_id_seq from public, anon, authenticated;
revoke all on function public.cl_stock_ctl_log_add(text, uuid, uuid, text, text, jsonb), public.cl_stock_ctl_main(uuid), public.cl_stock_ctl_text(text, integer),
  public.cl_stock_ctl_date(text), public.cl_stock_ctl_sees_diff(public.cl_terminals), public.cl_stock_request_json(uuid), public.cl_stock_recall_json(uuid),
  public.cl_cycle_count_json(public.cl_cycle_counts, boolean), public.cl_market_feed_now(), public.cl_stock_ctl_event(public.cl_terminals, jsonb),
  public.cl_stock_ctl_on_dispatch(),
  public.cl_device_stock_ctl_push(text, text, text, jsonb), public.cl_device_stock_ctl_pull(text, text, text, bigint, bigint),
  public.cl_market_feed_all(), public.cl_market_feed_save(bigint, text, text, boolean, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.cl_device_stock_ctl_push(text, text, text, jsonb), public.cl_device_stock_ctl_pull(text, text, text, bigint, bigint) to anon, authenticated;
grant execute on function public.cl_market_feed_all(), public.cl_market_feed_save(bigint, text, text, boolean, timestamptz, timestamptz) to authenticated;
revoke all on function public.cl_shop_rights_all(), public.cl_shop_default_rights(text) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
