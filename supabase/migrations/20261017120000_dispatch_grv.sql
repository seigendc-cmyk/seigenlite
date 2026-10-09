-- =====================================================================
-- Dispatch & GRV through Supabase, B1 (owner: "go Dispatch-B", 2026-10-09,
-- with the recommendations of the Stage A design accepted). Applied live
-- only after the owner has seen this file and said "apply".
-- Design: docs/dispatch/dispatch-grv-supabase-design.md
-- Rollback: supabase/rollbacks/20261017120000_dispatch_grv.rollback.sql
-- Tested in PGlite: supabase/tests/dispatch-grv-test.js
--
-- The server holds the documents; it never moves stock. Each device moves
-- its own stock once per document uid (src/dispatch-srv.js checks its own
-- item ledger), so a retry, a double tap, a reinstall or a restore never
-- counts twice.
--
-- 1. cl_dispatches (+ lines): a dispatch between two branches of the SAME
--    business (joined with join codes), sent by the till that made it.
--    Idempotent by the dispatch uid; (sending till, DN number) unique.
--    Unit cost travels here (the app shows it only where costs are shown
--    today: main-branch tills and the Console). Delivery cost: amount,
--    currency, carrier, reference.
-- 2. The GRV: posted by a till of the receiving branch, counting each line
--    as received / damaged (short = the rest) / extra. One GRV per dispatch:
--    the first wins, a second till is refused before it moves any stock.
--    Idempotent by the GRV uid; (receiving till, GRV number) unique.
-- 3. Differences become cl_dispatch_issues: short and damaged go back to
--    the sender (its dispatching till returns them to its stock) and are
--    written off (ADJ, Admin passcode on the device) or re-dispatched (a new
--    dispatch linked to the issue); extras come into the receiver's stock and
--    the sender confirms them (taking them off its stock) or disputes them.
-- 4. Cancel: only the dispatching till, only before the GRV.
-- 5. Delivery cost: landed on the received goods by the receiving device,
--    and recorded here as an inter-branch charge (the receiving branch owes
--    the sending branch), not split on a short delivery.
-- 6. Console: read-only list and detail (module "dispatches").
-- 7. The business delete guard also counts dispatches.
-- Every device call is install ID + phrase + device key (cl_catalogue_caller)
-- and answers refusals as data ({ error: CODE, message }).
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_dispatches' n where to_regclass('public.cl_dispatches') is not null
    union all select 'table cl_dispatch_issues' where to_regclass('public.cl_dispatch_issues') is not null
    union all select 'table cl_interbranch_charges' where to_regclass('public.cl_interbranch_charges') is not null
    union all select 'module dispatches' where exists (select 1 from cl_modules where key = 'dispatches')
  ) x;
  if conflicts is not null then raise exception 'dispatch_grv aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'function cl_catalogue_caller (20261006120000)' n where to_regprocedure('public.cl_catalogue_caller(text,text,text)') is null
    union all select 'function cl_rpn_staff (20261015120000)' where to_regprocedure('public.cl_rpn_staff(text[])') is null
    union all select 'table cl_market_packs (20261016120000)' where to_regclass('public.cl_market_packs') is null
    union all select 'column cl_branches.stock_mode (20261007120000)' where not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cl_branches' and column_name = 'stock_mode')
  ) x;
  if missing is not null then raise exception 'dispatch_grv aborted: missing %. Nothing was changed.', missing; end if;
end $$;

-- 1. Tables ---------------------------------------------------------------
create table public.cl_dispatches (
  id                    uuid primary key,                       -- made on the sending device
  business_id           uuid not null references public.cl_businesses(id),
  from_branch_id        uuid not null references public.cl_branches(id),
  to_branch_id          uuid not null references public.cl_branches(id),
  from_terminal_id      uuid not null references public.cl_terminals(id),
  from_legacy_branch_id text check (from_legacy_branch_id is null or length(from_legacy_branch_id) <= 40),   -- the device's branch key (DN files)
  dn_no                 integer not null check (dn_no > 0),
  dn_display            text not null check (length(dn_display) between 1 and 40),
  created_iso           text check (created_iso is null or length(created_iso) <= 40),
  internal_ref          text check (internal_ref is null or length(internal_ref) <= 60),
  sent_by               text check (sent_by is null or length(sent_by) <= 80),
  delivery_cost         numeric(12,2) not null default 0 check (delivery_cost >= 0 and delivery_cost <= 10000000),
  delivery_currency     text check (delivery_currency is null or delivery_currency ~ '^[A-Z]{3}$'),
  carrier               text check (carrier is null or length(carrier) <= 80),
  delivery_ref          text check (delivery_ref is null or length(delivery_ref) <= 80),
  replaces_issue_id     uuid,                                   -- a re-dispatch of a shortage
  status                text not null default 'sent' check (status in ('sent', 'received', 'received_diff', 'cancelled')),
  sent_at               timestamptz not null default now(),
  cancelled_at          timestamptz,
  cancelled_by          text,
  cancel_reason         text,
  grv_id                uuid unique,
  grv_no                integer check (grv_no is null or grv_no > 0),
  grv_display           text,
  grv_terminal_id       uuid references public.cl_terminals(id),
  grv_by                text,
  grv_internal_ref      text,
  grv_note              text,
  received_at           timestamptz,
  unique (from_terminal_id, dn_no),
  check (from_branch_id <> to_branch_id),
  check ((delivery_cost = 0) or delivery_currency is not null)
);
create unique index cl_dispatches_grv_no_uidx on public.cl_dispatches (grv_terminal_id, grv_no) where grv_no is not null;
create index cl_dispatches_to_idx on public.cl_dispatches (to_branch_id, status);
create index cl_dispatches_from_idx on public.cl_dispatches (from_branch_id, status);
create index cl_dispatches_legacy_idx on public.cl_dispatches (business_id, from_legacy_branch_id, dn_no);

create table public.cl_dispatch_lines (
  dispatch_id uuid not null references public.cl_dispatches(id) on delete cascade,
  line_no     integer not null check (line_no between 1 and 500),
  cat_uid     text check (cat_uid is null or length(cat_uid) <= 64),
  code        text check (code is null or length(code) <= 64),
  name        text not null check (length(btrim(name)) between 1 and 120),
  unit        text check (unit is null or length(unit) <= 20),
  qty         integer not null check (qty between 1 and 1000000),
  unit_cost   numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  received    integer check (received >= 0),
  damaged     integer check (damaged >= 0),
  short       integer check (short >= 0),
  extra       integer check (extra >= 0),
  note        text check (note is null or length(note) <= 200),
  primary key (dispatch_id, line_no)
);

create table public.cl_dispatch_issues (
  id                   uuid primary key default gen_random_uuid(),
  dispatch_id          uuid not null references public.cl_dispatches(id),
  line_no              integer not null,
  kind                 text not null check (kind in ('short', 'damaged', 'extra')),
  qty                  integer not null check (qty > 0),
  status               text not null default 'open' check (status in ('open', 'written_off', 'redispatched', 'confirmed', 'disputed')),
  created_at           timestamptz not null default now(),
  resolved_at          timestamptz,
  resolved_by          text,
  resolved_terminal_id uuid references public.cl_terminals(id),
  resolution_note      text,
  adj_display          text,
  redispatch_id        uuid references public.cl_dispatches(id),
  unique (dispatch_id, line_no, kind),
  foreign key (dispatch_id, line_no) references public.cl_dispatch_lines(dispatch_id, line_no)
);
alter table public.cl_dispatches add constraint cl_dispatches_replaces_issue_fk foreign key (replaces_issue_id) references public.cl_dispatch_issues(id);

create table public.cl_interbranch_charges (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.cl_businesses(id),
  dispatch_id       uuid not null unique references public.cl_dispatches(id),
  owed_by_branch_id uuid not null references public.cl_branches(id),   -- the receiving branch
  owed_to_branch_id uuid not null references public.cl_branches(id),   -- the sending branch
  amount            numeric(12,2) not null check (amount > 0),
  currency          text not null check (currency ~ '^[A-Z]{3}$'),
  created_at        timestamptz not null default now()
);

create table public.cl_dispatch_log (
  id          bigserial primary key,
  dispatch_id uuid not null references public.cl_dispatches(id),
  at          timestamptz not null default now(),
  terminal_id uuid references public.cl_terminals(id),
  by_name     text,
  action      text not null,
  detail      jsonb
);
create index cl_dispatch_log_dispatch_idx on public.cl_dispatch_log (dispatch_id, id);

-- 2. Helpers (not callable by devices or staff) ---------------------------
-- The calling till; refusals as data are made by the callers.
create function public.cl_dispatch_caller(p_install_id text, p_secret_phrase text, p_device_key text)
returns public.cl_terminals
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  update cl_terminals set last_seen_ts = now() where id = me.id;
  return me;
end $fn$;

create function public.cl_dispatch_name(p_name text, p_max integer) returns text
language sql immutable as $$ select nullif(left(btrim(coalesce(p_name, '')), p_max), '') $$;

-- One dispatch as the devices and the Console see it.
create function public.cl_dispatch_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', d.id, 'business_id', d.business_id,
    'from_branch_id', d.from_branch_id, 'from_branch', fb.name, 'from_legacy_branch_id', d.from_legacy_branch_id,
    'to_branch_id', d.to_branch_id, 'to_branch', tb.name,
    'from_terminal_id', d.from_terminal_id, 'from_till', ft.till_code,
    'dn_no', d.dn_no, 'dn_display', d.dn_display, 'created_iso', d.created_iso, 'internal_ref', d.internal_ref, 'sent_by', d.sent_by, 'sent_at', d.sent_at,
    'delivery_cost', d.delivery_cost, 'delivery_currency', d.delivery_currency, 'carrier', d.carrier, 'delivery_ref', d.delivery_ref,
    'replaces_issue_id', d.replaces_issue_id,
    'status', d.status, 'cancelled_at', d.cancelled_at, 'cancelled_by', d.cancelled_by, 'cancel_reason', d.cancel_reason,
    'grv_id', d.grv_id, 'grv_no', d.grv_no, 'grv_display', d.grv_display, 'grv_terminal_id', d.grv_terminal_id, 'grv_till', gt.till_code,
    'grv_by', d.grv_by, 'grv_internal_ref', d.grv_internal_ref, 'grv_note', d.grv_note, 'received_at', d.received_at,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'cat_uid', l.cat_uid, 'code', l.code, 'name', l.name, 'unit', l.unit,
        'qty', l.qty, 'unit_cost', l.unit_cost, 'received', l.received, 'damaged', l.damaged, 'short', l.short, 'extra', l.extra, 'note', l.note) order by l.line_no)
      from cl_dispatch_lines l where l.dispatch_id = d.id), '[]'::jsonb),
    'issues', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'line_no', i.line_no, 'kind', i.kind, 'qty', i.qty, 'status', i.status,
        'created_at', i.created_at, 'resolved_at', i.resolved_at, 'resolved_by', i.resolved_by, 'resolution_note', i.resolution_note,
        'adj_display', i.adj_display, 'redispatch_id', i.redispatch_id) order by i.line_no, i.kind)
      from cl_dispatch_issues i where i.dispatch_id = d.id), '[]'::jsonb),
    'charge', (select jsonb_build_object('amount', c.amount, 'currency', c.currency) from cl_interbranch_charges c where c.dispatch_id = d.id))
  from cl_dispatches d
  join cl_branches fb on fb.id = d.from_branch_id
  join cl_branches tb on tb.id = d.to_branch_id
  join cl_terminals ft on ft.id = d.from_terminal_id
  left join cl_terminals gt on gt.id = d.grv_terminal_id
  where d.id = p_id
$$;

create function public.cl_dispatch_log_add(p_dispatch uuid, p_terminal uuid, p_by text, p_action text, p_detail jsonb) returns void
language sql security definer set search_path = public as $$
  insert into cl_dispatch_log (dispatch_id, terminal_id, by_name, action, detail) values (p_dispatch, p_terminal, cl_dispatch_name(p_by, 80), p_action, p_detail)
$$;

-- 3. Send (the dispatching till) ------------------------------------------
-- p_dispatch: { id, to_branch_id, dn_no, dn_display, created_iso, internal_ref, sent_by, from_legacy_branch_id,
--               delivery: { cost, currency, carrier, ref }, replaces_issue_id?,
--               lines: [{ line_no, cat_uid, code, name, unit, qty, unit_cost }] }
create function public.cl_device_dispatch_send(p_install_id text, p_secret_phrase text, p_device_key text, p_dispatch jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; d cl_dispatches%rowtype; v_id uuid; v_to cl_branches%rowtype; l jsonb; n integer := 0;
        v_cost numeric; v_cur text; v_issue cl_dispatch_issues%rowtype; v_idata cl_dispatches%rowtype; v_ucost numeric;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if jsonb_typeof(p_dispatch) is distinct from 'object' then raise exception 'Send the dispatch as an object' using errcode = 'P0001'; end if;
  begin v_id := (p_dispatch->>'id')::uuid; exception when others then v_id := null; end;
  if v_id is null then raise exception 'The dispatch needs its id' using errcode = 'P0001'; end if;

  select * into d from cl_dispatches where id = v_id;
  if found then
    if d.from_terminal_id <> me.id then raise exception 'That dispatch id belongs to another till' using errcode = 'P0001'; end if;
    return json_build_object('ok', true, 'already', true, 'id', d.id, 'status', d.status);
  end if;
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;

  begin select * into v_to from cl_branches where id = (p_dispatch->>'to_branch_id')::uuid; exception when others then v_to := null; end;
  if v_to.id is null or v_to.business_id <> me.business_id then
    return json_build_object('error', 'NOT_OWN_BUSINESS', 'message', 'You can only dispatch to branches of your own business. Ask that branch to join with a join code.');
  end if;
  if v_to.id = me.branch_id then return json_build_object('error', 'OWN_BRANCH', 'message', 'You can''t dispatch to your own branch.'); end if;

  if (p_dispatch->>'dn_no') !~ '^[0-9]{1,9}$' or (p_dispatch->>'dn_no')::integer < 1 then raise exception 'The dispatch needs its DN number' using errcode = 'P0001'; end if;
  if exists (select 1 from cl_dispatches where from_terminal_id = me.id and dn_no = (p_dispatch->>'dn_no')::integer) then
    return json_build_object('error', 'DN_NUMBER_USED', 'message', 'This till already sent ' || (p_dispatch->>'dn_display') || ' as another dispatch. Check the date and time on this device, and its backups.');
  end if;
  if jsonb_typeof(p_dispatch->'lines') is distinct from 'array' or jsonb_array_length(p_dispatch->'lines') not between 1 and 500 then
    raise exception 'Send between 1 and 500 lines' using errcode = 'P0001';
  end if;

  v_cost := coalesce(nullif(p_dispatch->'delivery'->>'cost', '')::numeric, 0);
  v_cur := upper(nullif(btrim(coalesce(p_dispatch->'delivery'->>'currency', '')), ''));
  if v_cost < 0 or v_cost > 10000000 then raise exception 'The delivery cost must be between 0 and 10 000 000' using errcode = 'P0001'; end if;
  if v_cost > 0 and (v_cur is null or v_cur !~ '^[A-Z]{3}$') then raise exception 'The delivery cost needs its currency (3 letters, e.g. USD)' using errcode = 'P0001'; end if;

  if nullif(p_dispatch->>'replaces_issue_id', '') is not null then
    select i.* into v_issue from cl_dispatch_issues i where i.id = (p_dispatch->>'replaces_issue_id')::uuid for update;
    if not found then return json_build_object('error', 'NO_SUCH_ISSUE', 'message', 'That shortage isn''t on the server.'); end if;
    select * into v_idata from cl_dispatches where id = v_issue.dispatch_id;
    if v_idata.from_terminal_id <> me.id then return json_build_object('error', 'NOT_SENDER', 'message', 'Only the till that dispatched it (' || (select till_code from cl_terminals where id = v_idata.from_terminal_id) || ') can re-dispatch it.'); end if;
    if v_issue.kind not in ('short', 'damaged') or v_issue.status <> 'open' then
      return json_build_object('error', 'ALREADY_RESOLVED', 'message', 'That difference is already ' || replace(v_issue.status, '_', ' ') || '.');
    end if;
  end if;

  insert into cl_dispatches (id, business_id, from_branch_id, to_branch_id, from_terminal_id, from_legacy_branch_id, dn_no, dn_display, created_iso,
                             internal_ref, sent_by, delivery_cost, delivery_currency, carrier, delivery_ref, replaces_issue_id)
  values (v_id, me.business_id, me.branch_id, v_to.id, me.id, cl_dispatch_name(p_dispatch->>'from_legacy_branch_id', 40), (p_dispatch->>'dn_no')::integer,
          coalesce(cl_dispatch_name(p_dispatch->>'dn_display', 40), 'DN-' || (p_dispatch->>'dn_no')), cl_dispatch_name(p_dispatch->>'created_iso', 40),
          cl_dispatch_name(p_dispatch->>'internal_ref', 60), cl_dispatch_name(p_dispatch->>'sent_by', 80), v_cost, case when v_cost > 0 then v_cur end,
          cl_dispatch_name(p_dispatch->'delivery'->>'carrier', 80), cl_dispatch_name(p_dispatch->'delivery'->>'ref', 80), v_issue.id);

  for l in select value from jsonb_array_elements(p_dispatch->'lines') loop
    n := n + 1;
    if coalesce(l->>'qty', '') !~ '^[0-9]{1,7}$' or (l->>'qty')::integer not between 1 and 1000000 then
      raise exception 'Line %: the quantity must be a whole number of 1 or more', n using errcode = 'P0001';
    end if;
    if cl_dispatch_name(l->>'name', 120) is null then raise exception 'Line %: the product name is missing', n using errcode = 'P0001'; end if;
    v_ucost := nullif(l->>'unit_cost', '')::numeric;
    if v_ucost is not null and (v_ucost < 0 or v_ucost > 100000000) then raise exception 'Line %: the unit cost is out of range', n using errcode = 'P0001'; end if;
    insert into cl_dispatch_lines (dispatch_id, line_no, cat_uid, code, name, unit, qty, unit_cost)
    values (v_id, n, cl_dispatch_name(l->>'cat_uid', 64), cl_dispatch_name(l->>'code', 64), cl_dispatch_name(l->>'name', 120),
            cl_dispatch_name(l->>'unit', 20), (l->>'qty')::integer, v_ucost);
  end loop;

  if v_issue.id is not null then
    update cl_dispatch_issues set status = 'redispatched', resolved_at = now(), resolved_by = cl_dispatch_name(p_dispatch->>'sent_by', 80),
           resolved_terminal_id = me.id, redispatch_id = v_id, resolution_note = 'Re-dispatched as ' || (p_dispatch->>'dn_display')
     where id = v_issue.id;
    perform cl_dispatch_log_add(v_issue.dispatch_id, me.id, p_dispatch->>'sent_by', 'issue_redispatched', jsonb_build_object('issue_id', v_issue.id, 'dispatch_id', v_id));
  end if;
  perform cl_dispatch_log_add(v_id, me.id, p_dispatch->>'sent_by', 'sent', jsonb_build_object('lines', n, 'delivery_cost', v_cost));
  return json_build_object('ok', true, 'id', v_id, 'status', 'sent');
exception when unique_violation then
  return json_build_object('error', 'DN_NUMBER_USED', 'message', 'This till already sent that DN number as another dispatch.');
end $fn$;

-- 4. Pull: what this branch sends and receives ------------------------------
-- incoming: dispatches to this branch still waiting (any age) or recent (60 days)
-- outgoing: dispatches from this branch still open, with open differences, or recent
create function public.cl_device_dispatch_pull(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into b from cl_branches where id = me.branch_id;
  return json_build_object(
    'terminal_id', me.id, 'branch_id', me.branch_id, 'is_main', b.is_main, 'active', me.active, 'server_time', now(),
    'max_dn_no', (select max(dn_no) from cl_dispatches where from_terminal_id = me.id),
    'max_grv_no', (select max(grv_no) from cl_dispatches where grv_terminal_id = me.id),
    'incoming', coalesce((select json_agg(cl_dispatch_json(d.id) order by d.sent_at) from cl_dispatches d
       where d.to_branch_id = me.branch_id and (d.status = 'sent' or d.sent_at > now() - interval '60 days')), '[]'::json),
    'outgoing', coalesce((select json_agg(cl_dispatch_json(d.id) order by d.sent_at) from cl_dispatches d
       where d.from_branch_id = me.branch_id and (d.status = 'sent' or d.sent_at > now() - interval '60 days'
             or exists (select 1 from cl_dispatch_issues i where i.dispatch_id = d.id and i.status in ('open', 'disputed')))), '[]'::json));
end $fn$;

-- 5. The GRV (a till of the receiving branch) -------------------------------
-- p_grv: { grv_id, grv_no, grv_display, by, internal_ref, note, via_file?,
--          lines: [{ line_no, received, damaged, extra, note }] }  (every line once)
create function public.cl_device_grv_post(p_install_id text, p_secret_phrase text, p_device_key text, p_dispatch_id uuid, p_grv jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; d cl_dispatches%rowtype; v_grv uuid; l record; g jsonb; v_r integer; v_dm integer; v_x integer;
        v_diff boolean := false; v_status text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into d from cl_dispatches where id = p_dispatch_id for update;
  if not found or d.business_id <> me.business_id then return json_build_object('error', 'NO_SUCH_DISPATCH', 'message', 'That dispatch isn''t on the server.'); end if;
  if d.to_branch_id <> me.branch_id then return json_build_object('error', 'NOT_YOUR_BRANCH', 'message', 'This dispatch is for ' || (select name from cl_branches where id = d.to_branch_id) || ', not this branch.'); end if;
  begin v_grv := (p_grv->>'grv_id')::uuid; exception when others then v_grv := null; end;
  if v_grv is null then raise exception 'The GRV needs its id' using errcode = 'P0001'; end if;
  if d.grv_id = v_grv then return json_build_object('ok', true, 'already', true, 'dispatch', cl_dispatch_json(d.id)); end if;
  if d.status = 'cancelled' then
    return json_build_object('error', 'CANCELLED', 'message', d.dn_display || ' was cancelled by ' || (select name from cl_branches where id = d.from_branch_id) || '. Nothing was received.');
  end if;
  if d.grv_id is not null then
    return json_build_object('error', 'ALREADY_RECEIVED', 'grv_display', d.grv_display,
      'message', d.dn_display || ' was already received as ' || d.grv_display || ' on till ' || coalesce((select till_code from cl_terminals where id = d.grv_terminal_id), '?')
                 || coalesce(' by ' || d.grv_by, '') || '. Nothing was added here.');
  end if;
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if coalesce(p_grv->>'grv_no', '') !~ '^[0-9]{1,9}$' or (p_grv->>'grv_no')::integer < 1 then raise exception 'The GRV needs its number' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_grv->'lines') is distinct from 'array'
     or jsonb_array_length(p_grv->'lines') <> (select count(*) from cl_dispatch_lines where dispatch_id = d.id)
     or (select count(distinct x->>'line_no') from jsonb_array_elements(p_grv->'lines') x) <> jsonb_array_length(p_grv->'lines') then
    raise exception 'Count every line of the dispatch once' using errcode = 'P0001';
  end if;

  for l in select * from cl_dispatch_lines where dispatch_id = d.id order by line_no for update loop
    select x into g from jsonb_array_elements(p_grv->'lines') x where (x->>'line_no') = l.line_no::text;
    if g is null then raise exception 'Count every line of the dispatch once (line % is missing)', l.line_no using errcode = 'P0001'; end if;
    if coalesce(g->>'received', '') !~ '^[0-9]{1,7}$' or coalesce(g->>'damaged', '0') !~ '^[0-9]{1,7}$' or coalesce(g->>'extra', '0') !~ '^[0-9]{1,7}$' then
      raise exception '%: the counts must be whole numbers of 0 or more', l.name using errcode = 'P0001';
    end if;
    v_r := (g->>'received')::integer; v_dm := coalesce((g->>'damaged')::integer, 0); v_x := coalesce((g->>'extra')::integer, 0);
    if v_r + v_dm > l.qty then raise exception '%: received and damaged add up to more than the % sent; count the rest as extra', l.name, l.qty using errcode = 'P0001'; end if;
    if v_x > 0 and v_r + v_dm < l.qty then raise exception '%: extra only when the full % sent arrived', l.name, l.qty using errcode = 'P0001'; end if;
    update cl_dispatch_lines set received = v_r, damaged = v_dm, short = l.qty - v_r - v_dm, extra = v_x, note = cl_dispatch_name(g->>'note', 200)
     where dispatch_id = d.id and line_no = l.line_no;
    if l.qty - v_r - v_dm > 0 then insert into cl_dispatch_issues (dispatch_id, line_no, kind, qty) values (d.id, l.line_no, 'short', l.qty - v_r - v_dm); v_diff := true; end if;
    if v_dm > 0 then insert into cl_dispatch_issues (dispatch_id, line_no, kind, qty) values (d.id, l.line_no, 'damaged', v_dm); v_diff := true; end if;
    if v_x > 0 then insert into cl_dispatch_issues (dispatch_id, line_no, kind, qty) values (d.id, l.line_no, 'extra', v_x); v_diff := true; end if;
  end loop;

  v_status := case when v_diff then 'received_diff' else 'received' end;
  update cl_dispatches set status = v_status, grv_id = v_grv, grv_no = (p_grv->>'grv_no')::integer,
         grv_display = coalesce(cl_dispatch_name(p_grv->>'grv_display', 40), 'GRV-' || (p_grv->>'grv_no')), grv_terminal_id = me.id,
         grv_by = cl_dispatch_name(p_grv->>'by', 80), grv_internal_ref = cl_dispatch_name(p_grv->>'internal_ref', 60),
         grv_note = cl_dispatch_name(p_grv->>'note', 200), received_at = now()
   where id = d.id;
  if d.delivery_cost > 0 then
    insert into cl_interbranch_charges (business_id, dispatch_id, owed_by_branch_id, owed_to_branch_id, amount, currency)
    values (d.business_id, d.id, d.to_branch_id, d.from_branch_id, d.delivery_cost, d.delivery_currency);
  end if;
  perform cl_dispatch_log_add(d.id, me.id, p_grv->>'by', 'received', jsonb_build_object('grv_id', v_grv, 'status', v_status,
    'via_file', coalesce((p_grv->>'via_file')::boolean, false)));
  return json_build_object('ok', true, 'dispatch', cl_dispatch_json(d.id));
exception when unique_violation then
  return json_build_object('error', 'GRV_NUMBER_USED', 'message', 'This till already used that GRV number. Check the date and time on this device, and its backups.');
end $fn$;

-- 6. Cancel (the dispatching till, before the GRV) -------------------------
create function public.cl_device_dispatch_cancel(p_install_id text, p_secret_phrase text, p_device_key text, p_dispatch_id uuid, p_reason text, p_by text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; d cl_dispatches%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into d from cl_dispatches where id = p_dispatch_id for update;
  if not found or d.business_id <> me.business_id then return json_build_object('error', 'NO_SUCH_DISPATCH', 'message', 'That dispatch isn''t on the server.'); end if;
  if d.from_terminal_id <> me.id then
    return json_build_object('error', 'NOT_SENDER', 'message', 'Only the till that dispatched it (' || (select till_code from cl_terminals where id = d.from_terminal_id) || ') can cancel it.');
  end if;
  if d.status = 'cancelled' then return json_build_object('ok', true, 'already', true, 'dispatch', cl_dispatch_json(d.id)); end if;
  if d.grv_id is not null then
    return json_build_object('error', 'ALREADY_RECEIVED', 'grv_display', d.grv_display,
      'message', 'Already received as ' || d.grv_display || '. It can''t be cancelled now: send the goods back with a return dispatch.');
  end if;
  if length(v_reason) < 3 or length(v_reason) > 200 then raise exception 'Give a reason (3 to 200 characters)' using errcode = 'P0001'; end if;
  update cl_dispatches set status = 'cancelled', cancelled_at = now(), cancelled_by = cl_dispatch_name(p_by, 80), cancel_reason = v_reason where id = d.id;
  -- a cancelled re-dispatch opens its shortage again
  if d.replaces_issue_id is not null then
    update cl_dispatch_issues set status = 'open', resolved_at = null, resolved_by = null, resolved_terminal_id = null, redispatch_id = null, resolution_note = null
     where id = d.replaces_issue_id and redispatch_id = d.id;
    if found then
      perform cl_dispatch_log_add((select dispatch_id from cl_dispatch_issues where id = d.replaces_issue_id), me.id, p_by, 'issue_reopened',
        jsonb_build_object('issue_id', d.replaces_issue_id, 'cancelled_dispatch_id', d.id));
    end if;
  end if;
  perform cl_dispatch_log_add(d.id, me.id, p_by, 'cancelled', jsonb_build_object('reason', v_reason));
  return json_build_object('ok', true, 'dispatch', cl_dispatch_json(d.id));
end $fn$;

-- 7. Resolve a difference (the dispatching till) ----------------------------
-- short / damaged: write_off (p_adj_display = the device's ADJ number)
-- extra: confirm (taken off the sender's stock) | dispute (stays open for the managers)
create function public.cl_device_dispatch_resolve(p_install_id text, p_secret_phrase text, p_device_key text, p_issue_id uuid,
                                                  p_action text, p_by text, p_note text, p_adj_display text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; i cl_dispatch_issues%rowtype; d cl_dispatches%rowtype; v_to text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into i from cl_dispatch_issues where id = p_issue_id for update;
  if found then select * into d from cl_dispatches where id = i.dispatch_id; end if;
  if i.id is null or d.business_id <> me.business_id then return json_build_object('error', 'NO_SUCH_ISSUE', 'message', 'That difference isn''t on the server.'); end if;
  if d.from_terminal_id <> me.id then
    return json_build_object('error', 'NOT_SENDER', 'message', 'Only the till that dispatched it (' || (select till_code from cl_terminals where id = d.from_terminal_id) || ') can resolve it.');
  end if;
  v_to := case p_action when 'write_off' then 'written_off' when 'confirm' then 'confirmed' when 'dispute' then 'disputed' end;
  if v_to is null or (p_action = 'write_off' and i.kind = 'extra') or (p_action in ('confirm', 'dispute') and i.kind <> 'extra') then
    raise exception 'That action doesn''t fit a % difference', i.kind using errcode = 'P0001';
  end if;
  if i.status = v_to then return json_build_object('ok', true, 'already', true, 'dispatch', cl_dispatch_json(d.id)); end if;
  if not (i.status = 'open' or (i.status = 'disputed' and p_action = 'confirm')) then
    return json_build_object('error', 'ALREADY_RESOLVED', 'message', 'That difference is already ' || replace(i.status, '_', ' ') || '.');
  end if;
  if p_action = 'write_off' and cl_dispatch_name(p_adj_display, 40) is null then raise exception 'A write-off needs its ADJ number' using errcode = 'P0001'; end if;
  if p_action in ('write_off', 'dispute') and length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Give a reason (at least 3 characters)' using errcode = 'P0001'; end if;
  update cl_dispatch_issues set status = v_to, resolved_at = now(), resolved_by = cl_dispatch_name(p_by, 80), resolved_terminal_id = me.id,
         resolution_note = cl_dispatch_name(p_note, 200), adj_display = case when p_action = 'write_off' then cl_dispatch_name(p_adj_display, 40) end
   where id = i.id;
  perform cl_dispatch_log_add(d.id, me.id, p_by, 'issue_' || v_to, jsonb_build_object('issue_id', i.id, 'kind', i.kind, 'qty', i.qty, 'adj', p_adj_display));
  return json_build_object('ok', true, 'dispatch', cl_dispatch_json(d.id));
end $fn$;

-- 8. Lookup for a DN file being imported (same business only) ---------------
create function public.cl_device_dispatch_lookup(p_install_id text, p_secret_phrase text, p_device_key text,
                                                 p_dispatch_id uuid, p_from_legacy_branch_id text, p_dn_no integer)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; d cl_dispatches%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if p_dispatch_id is not null then select * into d from cl_dispatches where id = p_dispatch_id and business_id = me.business_id; end if;
  if d.id is null and p_from_legacy_branch_id is not null and p_dn_no is not null then
    select * into d from cl_dispatches where business_id = me.business_id and from_legacy_branch_id = p_from_legacy_branch_id and dn_no = p_dn_no
     order by sent_at desc limit 1;
  end if;
  if d.id is null then return json_build_object('found', false); end if;
  return json_build_object('found', true, 'id', d.id, 'status', d.status, 'dn_display', d.dn_display, 'grv_display', d.grv_display,
    'to_branch_id', d.to_branch_id, 'to_branch', (select name from cl_branches where id = d.to_branch_id));
end $fn$;

-- 9. Console: read-only -------------------------------------------------------
insert into public.cl_modules (id, key, label, description, sort_order)
select gen_random_uuid(), 'dispatches', 'Dispatches', 'See branch-to-branch dispatches, GRVs and differences (read-only)', 50;

create function public.cl_dispatches_list(p_business_id uuid, p_status text, p_limit integer)
returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['dispatches']);
  return coalesce((select json_agg(x order by x.sent_at desc) from (
    select d.id, d.business_id, bz.name business, fb.name from_branch, tb.name to_branch, ft.till_code from_till, d.dn_display, d.sent_at, d.sent_by,
           d.status, d.grv_display, d.received_at, d.delivery_cost, d.delivery_currency,
           (select count(*) from cl_dispatch_lines l where l.dispatch_id = d.id) lines,
           (select coalesce(sum(qty), 0) from cl_dispatch_lines l where l.dispatch_id = d.id) units,
           (select count(*) from cl_dispatch_issues i where i.dispatch_id = d.id and i.status in ('open', 'disputed')) open_issues
      from cl_dispatches d
      join cl_businesses bz on bz.id = d.business_id
      join cl_branches fb on fb.id = d.from_branch_id
      join cl_branches tb on tb.id = d.to_branch_id
      join cl_terminals ft on ft.id = d.from_terminal_id
     where (p_business_id is null or d.business_id = p_business_id)
       and (p_status is null or p_status = '' or d.status = p_status
            or (p_status = 'open_issues' and exists (select 1 from cl_dispatch_issues i where i.dispatch_id = d.id and i.status in ('open', 'disputed'))))
     order by d.sent_at desc
     limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x), '[]'::json);
end $fn$;

create function public.cl_dispatch_detail(p_id uuid)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare j jsonb;
begin
  perform cl_rpn_staff(array['dispatches']);
  j := cl_dispatch_json(p_id);
  if j is null then raise exception 'That dispatch doesn''t exist' using errcode = 'P0002'; end if;
  return (j || jsonb_build_object('business', (select name from cl_businesses where id = (j->>'business_id')::uuid),
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', g.at, 'by', g.by_name, 'till', t.till_code, 'action', g.action, 'detail', g.detail) order by g.id)
      from cl_dispatch_log g left join cl_terminals t on t.id = g.terminal_id where g.dispatch_id = p_id), '[]'::jsonb)))::json;
end $fn$;

-- 10. The business delete guard also counts dispatches ------------------------
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
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

-- 11. Grants -------------------------------------------------------------------
alter table public.cl_dispatches enable row level security;
alter table public.cl_dispatch_lines enable row level security;
alter table public.cl_dispatch_issues enable row level security;
alter table public.cl_interbranch_charges enable row level security;
alter table public.cl_dispatch_log enable row level security;
revoke all on table public.cl_dispatches, public.cl_dispatch_lines, public.cl_dispatch_issues, public.cl_interbranch_charges, public.cl_dispatch_log
  from public, anon, authenticated;
revoke all on sequence public.cl_dispatch_log_id_seq from public, anon, authenticated;

revoke all on function public.cl_dispatch_caller(text, text, text), public.cl_dispatch_name(text, integer), public.cl_dispatch_json(uuid),
  public.cl_dispatch_log_add(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.cl_device_dispatch_send(text, text, text, jsonb), public.cl_device_dispatch_pull(text, text, text),
  public.cl_device_grv_post(text, text, text, uuid, jsonb), public.cl_device_dispatch_cancel(text, text, text, uuid, text, text),
  public.cl_device_dispatch_resolve(text, text, text, uuid, text, text, text, text),
  public.cl_device_dispatch_lookup(text, text, text, uuid, text, integer) from public;
grant execute on function public.cl_device_dispatch_send(text, text, text, jsonb), public.cl_device_dispatch_pull(text, text, text),
  public.cl_device_grv_post(text, text, text, uuid, jsonb), public.cl_device_dispatch_cancel(text, text, text, uuid, text, text),
  public.cl_device_dispatch_resolve(text, text, text, uuid, text, text, text, text),
  public.cl_device_dispatch_lookup(text, text, text, uuid, text, integer) to anon, authenticated;
revoke all on function public.cl_dispatches_list(uuid, text, integer), public.cl_dispatch_detail(uuid) from public, anon, authenticated;
grant execute on function public.cl_dispatches_list(uuid, text, integer), public.cl_dispatch_detail(uuid) to authenticated;

commit;
