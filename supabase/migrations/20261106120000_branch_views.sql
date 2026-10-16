-- =====================================================================
-- Branches step 2: branch views (owner, 2026-10-16: "Go Branches step 2 as
-- approved in the design addendum"). Applied live only after the owner has
-- seen this file and said "apply".
-- Design: docs/branches/multi-branch-visibility-design.md, addendum §R2,
-- §R3, §R5, §R6, §R11 row 1 (named 20261026120000 there; it runs after the
-- applied 20261105120000_itred_order_fulfilment, so it takes the next date).
-- Rollback: supabase/rollbacks/20261106120000_branch_views.rollback.sql
-- Tested in PGlite: supabase/tests/branch-views-test.js (and the app's
-- test/branch-views.test.js against this SQL)
--
-- Read-only views for every till of a business. Quantities only: no unit
-- cost, no landed cost, no inter-branch charge, to anyone (costs by person
-- come with the Roles step). Nothing here changes stock or sales.
--
--   cl_device_branch_stock         each till's own figure ('t') and the till
--                                  list now go to EVERY caller (§R5), not
--                                  only main-branch tills
--   cl_device_business_dispatches  + internal_ref, grv_internal_ref, and the
--                                  transport: delivery_cost, delivery_currency,
--                                  carrier, delivery_ref (§R2: the DN search)
--   cl_device_dispatch_card        NEW: one DN's full card (§R3): header,
--                                  transport, every line, the differences and
--                                  how each was settled, the linked DNs, and
--                                  the history from cl_dispatch_log
--   cl_device_item_ledger          NEW: one product's movements on seiGEN
--                                  (§R3): dispatched, cancelled, differences
--                                  back, written off, extra confirmed,
--                                  received, supplier GRVs. Sales and
--                                  adjustments are not on seiGEN yet (B4/B5)
--   cl_customers / cl_suppliers    + created_branch_id: the branch that added
--                                  them (§R6), backfilled from created_terminal
--                                  and set on every insert by a trigger; the
--                                  JSON the tills get adds source_branch_id
--                                  and source_branch
--
-- The backfilled customers get a new change_seq, so every till pulls them
-- once more with their source branch (the tills' pull cursor). Nothing else
-- in them changes.
-- A business merge (cl_business_merge_core) refuses a business that has
-- customers, suppliers or dispatches, and moves branches with their ids, so
-- nothing here needs to move.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'function cl_device_branch_stock (20261024120000)' n where to_regprocedure('public.cl_device_branch_stock(text,text,text,uuid)') is null
    union all select 'function cl_device_business_dispatches (20261024120000)' where to_regprocedure('public.cl_device_business_dispatches(text,text,text,integer)') is null
    union all select 'function cl_dispatch_caller (20261017120000)' where to_regprocedure('public.cl_dispatch_caller(text,text,text)') is null
    union all select 'table cl_dispatch_log (20261017120000)' where to_regclass('public.cl_dispatch_log') is null
    union all select 'table cl_supplier_grvs (20261018120000)' where to_regclass('public.cl_supplier_grvs') is null
    union all select 'function cl_supplier_json (20261018120000)' where to_regprocedure('public.cl_supplier_json(public.cl_suppliers)') is null
    union all select 'function cl_customer_json (20261018180000)' where to_regprocedure('public.cl_customer_json(public.cl_customers)') is null
    union all select 'sequence cl_customers_seq (20261018180000)' where to_regclass('public.cl_customers_seq') is null
  ) x;
  if missing is not null then raise exception 'branch_views aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'column ' || table_name || '.created_branch_id' n from information_schema.columns
     where table_schema = 'public' and table_name in ('cl_customers', 'cl_suppliers') and column_name = 'created_branch_id'
    union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cl_device_dispatch_card', 'cl_device_item_ledger', 'cl_source_branch_fill', 'cl_ledger_line_match')
  ) x;
  if conflicts is not null then raise exception 'branch_views aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;

-- 1. The source branch of a customer or a supplier (§R6) --------------------
alter table public.cl_customers add column created_branch_id uuid references public.cl_branches(id) on delete set null;
alter table public.cl_suppliers add column created_branch_id uuid references public.cl_branches(id) on delete set null;

-- set from the till that adds them (the save functions stay as they are)
create function public.cl_source_branch_fill() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.created_branch_id is null and new.created_terminal is not null then
    select branch_id into new.created_branch_id from cl_terminals where id = new.created_terminal;
  end if;
  return new;
end $fn$;
create trigger cl_customers_source_branch before insert on public.cl_customers
  for each row execute function public.cl_source_branch_fill();
create trigger cl_suppliers_source_branch before insert on public.cl_suppliers
  for each row execute function public.cl_source_branch_fill();

-- the rows already there: from their till's branch; customers get a new
-- change_seq so the tills pull them again (in their old order)
update public.cl_suppliers s set created_branch_id = t.branch_id
  from public.cl_terminals t where t.id = s.created_terminal and s.created_branch_id is null;
update public.cl_customers c set created_branch_id = x.branch_id, change_seq = x.seq
  from (select c2.business_id, c2.customer_uid, t.branch_id, nextval('public.cl_customers_seq') seq
          from (select * from public.cl_customers order by change_seq) c2
          join public.cl_terminals t on t.id = c2.created_terminal
         where c2.created_branch_id is null) x
 where c.business_id = x.business_id and c.customer_uid = x.customer_uid;

create or replace function public.cl_customer_json(c public.cl_customers) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('uid', c.customer_uid, 'name', c.name, 'phone', c.phone, 'phone_norm', c.phone_norm,
    'customer_type', c.customer_type, 'credit_limit', c.credit_limit, 'address', c.address, 'national_id', c.national_id,
    'active', c.active, 'seq', c.change_seq, 'updated_at', c.updated_at,
    'source_branch_id', c.created_branch_id, 'source_branch', (select b.name from cl_branches b where b.id = c.created_branch_id))   -- branch views (20261106120000)
$$;
create or replace function public.cl_supplier_json(s public.cl_suppliers) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'phone', s.phone, 'notes', s.notes, 'active', s.active, 'updated_at', s.updated_at,
    'source_branch_id', s.created_branch_id, 'source_branch', (select b.name from cl_branches b where b.id = s.created_branch_id))   -- branch views (20261106120000)
$$;

-- 2. Every branch's stock: each till's own figure for every caller (§R5) -------
-- As 20261024120000, except that 'tills' and each row's 't' no longer depend
-- on the caller being a main-branch till. Quantities only; never any cost.
create or replace function public.cl_device_branch_stock(p_install_id text, p_secret_phrase text, p_device_key text, p_branch_id uuid default null)
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
        coalesce((select json_agg(json_build_object('terminal_id', t.id, 'till_code', t.till_code, 'label', t.label, 'active', t.active,
            'as_of', p.as_of, 'pushed_at', p.pushed_at, 'products', coalesce(p.products, 0)) order by t.till_code)
          from cl_terminals t left join cl_till_stock_push p on p.terminal_id = t.id where t.branch_id = b.id), '[]'::json) as tills,
        case when b.stock_mode = 'shared' then
          coalesce((select json_agg(json_build_object('k', s.product_uid, 'cat_uid', s.product_uid, 'code', c.code, 'name', c.name, 'qty', s.total, 'low', c.low_threshold) order by c.name)
            from cl_branch_stock s join cl_catalogue_products c on c.business_id = s.business_id and c.product_uid = s.product_uid
           where s.branch_id = b.id), '[]'::json)
        else
          coalesce((select json_agg(json_build_object('k', g.product_key, 'cat_uid', g.cat_uid, 'code', g.code, 'name', g.name, 'qty', g.qty, 'low', g.low,
                     't', g.t) order by g.name)
            from (select l.product_key, max(l.cat_uid) cat_uid, max(l.code) code, max(l.name) name, sum(l.qty)::bigint qty, max(l.low_threshold) low,
                         json_object_agg(t.till_code, l.qty) t
                    from cl_till_stock_levels l join cl_terminals t on t.id = l.terminal_id
                   where l.branch_id = b.id and t.active and t.branch_id = b.id
                   group by l.product_key) g), '[]'::json)
        end as rows
      from cl_branches b
     where b.business_id = me.business_id and (p_branch_id is null or b.id = p_branch_id)) x), '[]'::json));
end $fn$;

-- 3. The business's dispatches: + refs and transport (§R2) -----------------------
-- As 20261024120000, plus the internal refs and the transport charge (its
-- amount, currency, carrier and reference: the receiving branch pays it and
-- may already see it, decision 1d). Still no unit cost and no inter-branch charge.
create or replace function public.cl_device_business_dispatches(p_install_id text, p_secret_phrase text, p_device_key text, p_days integer default 30)
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
             d.internal_ref, d.grv_internal_ref, d.delivery_cost, d.delivery_currency, d.carrier, d.delivery_ref,   -- branch views (20261106120000)
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

-- 4. One DN's card (any till of the business; §R3) -------------------------------
-- Quantities only: no unit cost, no inter-branch charge. The transport is
-- paid by the receiving branch until B2 adds a payer. The history is the
-- dispatch's own log (sent, received, cancelled, each difference settled),
-- with only the fields a person reads (who, when, which till, the reason).
create function public.cl_device_dispatch_card(p_install_id text, p_secret_phrase text, p_device_key text, p_dispatch_id uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; d cl_dispatches%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into d from cl_dispatches where id = p_dispatch_id and business_id = me.business_id;
  if not found then return json_build_object('error', 'NOT_FOUND', 'message', 'That Delivery Note isn''t on seiGEN for this business.'); end if;
  return (select json_build_object(
    'id', d.id, 'dn_display', d.dn_display, 'status', d.status, 'mine', d.from_terminal_id = me.id,
    'from_branch_id', d.from_branch_id, 'from_branch', fb.name, 'from_till', ft.till_code,
    'to_branch_id', d.to_branch_id, 'to_branch', tb.name,
    'created_iso', d.created_iso, 'internal_ref', d.internal_ref, 'sent_by', d.sent_by, 'sent_at', d.sent_at,
    'received_at', d.received_at, 'grv_display', d.grv_display, 'grv_till', gt.till_code, 'grv_by', d.grv_by,
    'grv_internal_ref', d.grv_internal_ref, 'grv_note', d.grv_note,
    'cancelled_at', d.cancelled_at, 'cancelled_by', d.cancelled_by, 'cancel_reason', d.cancel_reason,
    'transport', json_build_object('cost', d.delivery_cost, 'currency', d.delivery_currency, 'carrier', d.carrier, 'ref', d.delivery_ref, 'paid_by', 'receiving'),
    'lines', coalesce((select json_agg(json_build_object('line_no', l.line_no, 'cat_uid', l.cat_uid, 'code', l.code, 'name', l.name, 'unit', l.unit,
        'qty', l.qty, 'received', l.received, 'damaged', l.damaged, 'short', l.short, 'extra', l.extra, 'note', l.note) order by l.line_no)
      from cl_dispatch_lines l where l.dispatch_id = d.id), '[]'::json),
    'issues', coalesce((select json_agg(json_build_object('id', i.id, 'line_no', i.line_no, 'name', l.name, 'kind', i.kind, 'qty', i.qty, 'status', i.status,
        'created_at', i.created_at, 'resolved_at', i.resolved_at, 'resolved_by', i.resolved_by, 'resolved_till', rt.till_code,
        'note', i.resolution_note, 'adj_display', i.adj_display,
        'redispatch', case when r.id is not null then json_build_object('id', r.id, 'dn_display', r.dn_display, 'status', r.status) end) order by i.line_no, i.kind)
      from cl_dispatch_issues i
      join cl_dispatch_lines l on l.dispatch_id = i.dispatch_id and l.line_no = i.line_no
      left join cl_terminals rt on rt.id = i.resolved_terminal_id
      left join cl_dispatches r on r.id = i.redispatch_id
      where i.dispatch_id = d.id), '[]'::json),
    'replaces', (select json_build_object('id', o.id, 'dn_display', o.dn_display, 'kind', i.kind, 'qty', i.qty, 'name', l.name)
      from cl_dispatch_issues i join cl_dispatches o on o.id = i.dispatch_id
      join cl_dispatch_lines l on l.dispatch_id = i.dispatch_id and l.line_no = i.line_no
      where i.id = d.replaces_issue_id),
    'history', coalesce((select json_agg(json_build_object('at', g.at, 'action', g.action, 'by', g.by_name, 'till', t.till_code, 'branch', tb2.name,
        'kind', g.detail->>'kind', 'qty', g.detail->'qty', 'adj', g.detail->>'adj', 'reason', g.detail->>'reason', 'status', g.detail->>'status') order by g.at, g.id)
      from cl_dispatch_log g
      left join cl_terminals t on t.id = g.terminal_id
      left join cl_branches tb2 on tb2.id = t.branch_id
      where g.dispatch_id = d.id), '[]'::json))
    from cl_branches fb, cl_branches tb, cl_terminals ft left join cl_terminals gt on gt.id = d.grv_terminal_id
   where fb.id = d.from_branch_id and tb.id = d.to_branch_id and ft.id = d.from_terminal_id);
end $fn$;

-- 5. One product's movements on seiGEN (any till of the business; §R3) ------------
-- The product: its catalogue uid, else its code, else its name (as the tills
-- match products across branches). A line with another catalogue uid is
-- another product. Each movement as the tills book it (dispatch-srv.js):
--   the sending branch: dispatch_out (-sent), dispatch_cancel (+sent back),
--     dispatch_return (+short or damaged, back when the GRV reported it),
--     write_off (-that quantity, when written off), dispatch_extra (-extra confirmed);
--   the receiving branch: receive (+received + extra);
--   a main branch: supplier_grv (+qty).
-- p_branch_id: one branch, or null for all. No costs. At most 1000, newest first.
create function public.cl_ledger_line_match(l_cat text, l_code text, l_name text, p_cat text, p_code text, p_name text) returns boolean
language sql immutable as $$
  select (p_cat <> '' and lower(coalesce(l_cat, '')) = p_cat)
      or ((p_cat = '' or coalesce(l_cat, '') = '')
          and case when p_code <> '' then lower(btrim(coalesce(l_code, ''))) = p_code else lower(btrim(coalesce(l_name, ''))) = p_name end)
$$;

create function public.cl_device_item_ledger(p_install_id text, p_secret_phrase text, p_device_key text,
                                             p_cat_uid text default null, p_code text default null, p_name text default null,
                                             p_branch_id uuid default null, p_from timestamptz default null, p_to timestamptz default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_cat text := lower(btrim(coalesce(p_cat_uid, ''))); v_code text := lower(btrim(coalesce(p_code, '')));
        v_name text := lower(btrim(coalesce(p_name, ''))); v_from timestamptz := coalesce(p_from, '-infinity'); v_to timestamptz := coalesce(p_to, 'infinity');
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if v_cat = '' and v_code = '' and v_name = '' then raise exception 'Say which product (its catalogue id, code or name)' using errcode = 'P0001'; end if;
  if length(v_cat) > 64 or length(v_code) > 64 or length(v_name) > 120 then raise exception 'That product key is too long' using errcode = 'P0001'; end if;
  if p_branch_id is not null and not exists (select 1 from cl_branches where id = p_branch_id and business_id = me.business_id) then
    return json_build_object('error', 'NOT_FOUND', 'message', 'That branch isn''t in this business.');
  end if;
  return json_build_object('server_time', now(), 'kinds', json_build_array('dispatch', 'grv', 'differences', 'supplier_grv'),
    'rows', coalesce((select json_agg(m order by m.at desc, m.doc) from (
      select * from (
        -- the sending branch
        select d.sent_at at, 'dispatch_out' kind, d.from_branch_id branch_id, d.from_terminal_id terminal_id, d.dn_display doc, d.id dispatch_id,
               d.to_branch_id other_branch_id, d.sent_by by_name, 0 qty_in, l.qty qty_out, d.internal_ref note
          from cl_dispatches d join cl_dispatch_lines l on l.dispatch_id = d.id
         where d.business_id = me.business_id and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        union all
        select d.cancelled_at, 'dispatch_cancel', d.from_branch_id, d.from_terminal_id, d.dn_display, d.id, d.to_branch_id, d.cancelled_by, l.qty, 0, d.cancel_reason
          from cl_dispatches d join cl_dispatch_lines l on l.dispatch_id = d.id
         where d.business_id = me.business_id and d.status = 'cancelled' and d.cancelled_at is not null
           and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        union all
        select i.created_at, 'dispatch_return', d.from_branch_id, d.from_terminal_id, d.dn_display, d.id, d.to_branch_id, null, i.qty, 0,
               i.kind || ' at the receiving branch (' || coalesce(d.grv_display, '') || ')'
          from cl_dispatch_issues i join cl_dispatches d on d.id = i.dispatch_id
          join cl_dispatch_lines l on l.dispatch_id = i.dispatch_id and l.line_no = i.line_no
         where d.business_id = me.business_id and i.kind in ('short', 'damaged') and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        union all
        select i.resolved_at, 'write_off', d.from_branch_id, coalesce(i.resolved_terminal_id, d.from_terminal_id), coalesce(i.adj_display, d.dn_display), d.id,
               d.to_branch_id, i.resolved_by, 0, i.qty, i.kind || ' on ' || d.dn_display || coalesce(': ' || i.resolution_note, '')
          from cl_dispatch_issues i join cl_dispatches d on d.id = i.dispatch_id
          join cl_dispatch_lines l on l.dispatch_id = i.dispatch_id and l.line_no = i.line_no
         where d.business_id = me.business_id and i.kind in ('short', 'damaged') and i.status = 'written_off' and i.resolved_at is not null
           and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        union all
        select i.resolved_at, 'dispatch_extra', d.from_branch_id, coalesce(i.resolved_terminal_id, d.from_terminal_id), d.dn_display, d.id, d.to_branch_id,
               i.resolved_by, 0, i.qty, 'extra confirmed at the receiving branch (' || coalesce(d.grv_display, '') || ')'
          from cl_dispatch_issues i join cl_dispatches d on d.id = i.dispatch_id
          join cl_dispatch_lines l on l.dispatch_id = i.dispatch_id and l.line_no = i.line_no
         where d.business_id = me.business_id and i.kind = 'extra' and i.status = 'confirmed' and i.resolved_at is not null
           and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        -- the receiving branch
        union all
        select d.received_at, 'receive', d.to_branch_id, d.grv_terminal_id, coalesce(d.grv_display, d.dn_display), d.id, d.from_branch_id, d.grv_by,
               coalesce(l.received, 0) + coalesce(l.extra, 0), 0, 'from ' || d.dn_display || coalesce(' · ' || d.grv_internal_ref, '')
          from cl_dispatches d join cl_dispatch_lines l on l.dispatch_id = d.id
         where d.business_id = me.business_id and d.received_at is not null and d.grv_terminal_id is not null
           and coalesce(l.received, 0) + coalesce(l.extra, 0) > 0 and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
        -- goods from suppliers
        union all
        select g.posted_at, 'supplier_grv', g.branch_id, g.terminal_id, g.grv_display, null, null, g.received_by, l.qty, 0,
               s.name || ', invoice ' || g.invoice_no
          from cl_supplier_grvs g join cl_supplier_grv_lines l on l.grv_id = g.id join cl_suppliers s on s.id = g.supplier_id
         where g.business_id = me.business_id and cl_ledger_line_match(l.cat_uid, l.code, l.name, v_cat, v_code, v_name)
      ) u
      where u.at >= v_from and u.at <= v_to and (p_branch_id is null or u.branch_id = p_branch_id)
      order by u.at desc
      limit 1000) r0
    cross join lateral (select r0.at, r0.kind, r0.branch_id, b.name branch, t.till_code till, r0.terminal_id = me.id mine, r0.doc, r0.dispatch_id,
                               ob.name other_branch, r0.by_name "by", r0.qty_in, r0.qty_out, r0.note
                          from cl_branches b left join cl_terminals t on t.id = r0.terminal_id left join cl_branches ob on ob.id = r0.other_branch_id
                         where b.id = r0.branch_id) m), '[]'::json));
end $fn$;

-- 6. Grants ----------------------------------------------------------------------
revoke all on function public.cl_source_branch_fill(), public.cl_ledger_line_match(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.cl_device_dispatch_card(text, text, text, uuid),
  public.cl_device_item_ledger(text, text, text, text, text, text, uuid, timestamptz, timestamptz) from public;
grant execute on function public.cl_device_dispatch_card(text, text, text, uuid),
  public.cl_device_item_ledger(text, text, text, text, text, text, uuid, timestamptz, timestamptz) to anon, authenticated;

commit;
