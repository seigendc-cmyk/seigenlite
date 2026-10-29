-- =====================================================================
-- v37.1: stock-request drafts on seiGEN and the dispatch reminder (owner
-- decisions 63 and 64, 28 Oct 2026), plus what the till needs for the
-- branch-figures fix. Builds on 20261115120000_stock_control (applied on
-- live 28 Oct), which is not edited. Applied on live only after the owner
-- has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261117120000_srq_drafts.rollback.sql
-- Tested in PGlite: supabase/tests/srq-drafts-test.js, test/srq-drafts-v371.test.js
--
-- 1. A draft DN per approved request (decision 63): cl_srq_drafts. Made by
--    seiGEN when a request is approved or part-approved, whichever device
--    approved it. A draft moves no stock and reserves nothing: it is the
--    approved quantities waiting at main. It is only ever sent (the normal DN,
--    through seiGEN) or closed with a reason; it is never deleted.
--      open    -> sent    (cl_device_srq_draft_claim: the first sender only;
--                          the quantities sent, never more than approved)
--      sent    -> open    (that DN was cancelled, as v37 puts the request back
--                          to approved; or the sending till's DN never got made)
--      open    -> closed  (event draft_close: Review stock requests, or an
--                          Owner/Admin; a reason) and the request becomes
--                          'not_dispatched' ("Approved, not dispatched").
--    Each line keeps approved_qty and the sent_qty; the request's log says who
--    changed what.
-- 2. The reminder timers (decision 64): cl_srq_settings, one row per business
--    (no row = the defaults: 8 hours, repeat every 24), set by an Owner/Admin
--    (or a till in single operator mode, where the Admin passcode is the owner),
--    every change in cl_srq_settings_log (who, when, old -> new). Devices get
--    them with the stock-control pull and work out the reminders themselves.
-- 3. The stock-control pull also says whether seiGEN takes branch figures
--    (bs_enabled = cl_bs_enabled, unchanged), so a till that registered alone
--    learns within a minute that a branch has joined.
-- 4. Requests approved before v37.1 with no DN: those whose DN was sent but
--    never linked (v37's Dispatch screen didn't pass the link) are linked to
--    it; the rest get their draft, once.
-- Changed: cl_stock_requests (status 'not_dispatched'; who decided, on which
-- device), cl_stock_request_lines (sent_qty), cl_stock_request_json,
-- cl_device_stock_ctl_pull (two more answers), cl_stock_ctl_event (now
-- cl_stock_ctl_event_v37 behind a new one that adds draft_close and checks
-- request_link against the draft). Nothing else.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_srq_drafts' n where to_regclass('public.cl_srq_drafts') is not null
    union all select 'table cl_srq_settings' where to_regclass('public.cl_srq_settings') is not null
    union all select 'function cl_stock_ctl_event_v37' where to_regprocedure('public.cl_stock_ctl_event_v37(public.cl_terminals, jsonb)') is not null
    union all select 'function cl_device_srq_draft_claim' where exists (select 1 from pg_proc where proname = 'cl_device_srq_draft_claim')
  ) x;
  if conflicts is not null then raise exception 'srq_drafts aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'table cl_stock_requests (20261115120000)' n where to_regclass('public.cl_stock_requests') is null
    union all select 'function cl_stock_ctl_event (20261115120000)' where to_regprocedure('public.cl_stock_ctl_event(public.cl_terminals, jsonb)') is null
    union all select 'function cl_device_stock_ctl_pull (20261115120000)' where to_regprocedure('public.cl_device_stock_ctl_pull(text, text, text, bigint, bigint)') is null
    union all select 'function cl_bs_enabled (20261024120000)' where to_regprocedure('public.cl_bs_enabled(uuid)') is null
    union all select 'function cl_seat_need (20261109120000)' where to_regprocedure('public.cl_seat_need(text)') is null
    union all select 'function cl_guest_seat_refuse (20261114120000)' where to_regprocedure('public.cl_guest_seat_refuse()') is null
  ) x;
  if missing is not null then raise exception 'srq_drafts aborted: missing %. Nothing was changed.', missing; end if;
end $$;

-- 1. Requests and their lines -------------------------------------------------
alter table public.cl_stock_requests drop constraint cl_stock_requests_status_check;
alter table public.cl_stock_requests add constraint cl_stock_requests_status_check
  check (status in ('pending', 'approved', 'part_approved', 'rejected', 'dispatched', 'received', 'not_dispatched'));
alter table public.cl_stock_requests
  add column decided_staff_id    uuid,                                            -- who approved (the reminder goes to them too)
  add column decided_terminal_id uuid references public.cl_terminals(id);
alter table public.cl_stock_request_lines
  add column sent_qty integer check (sent_qty is null or sent_qty >= 0);           -- what the DN sent (never more than approved_qty)
alter table public.cl_stock_request_lines add constraint cl_stock_request_lines_sent_check check (sent_qty is null or sent_qty <= coalesce(approved_qty, 0));

-- 2. Drafts -----------------------------------------------------------------
create table public.cl_srq_drafts (
  request_id        uuid primary key references public.cl_stock_requests(id),
  business_id       uuid not null references public.cl_businesses(id),
  status            text not null default 'open' check (status in ('open', 'sent', 'closed')),
  approved_at       timestamptz not null,                                       -- the reminder counts from here
  approved_by       text,
  approved_staff_id uuid,
  approved_terminal_id uuid references public.cl_terminals(id),
  dispatch_id       uuid,                                                       -- the DN sent from it (its id; the DN may still be on its way)
  sent_by           text,
  sent_terminal_id  uuid references public.cl_terminals(id),
  sent_at           timestamptz,
  closed_by         text,
  closed_staff_id   uuid,
  close_reason      text check (close_reason is null or length(btrim(close_reason)) between 1 and 200),
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (status <> 'closed' or close_reason is not null),
  check (status <> 'sent' or dispatch_id is not null)
);
create index cl_srq_drafts_biz_idx on public.cl_srq_drafts (business_id, status);

-- 3. The reminder timers -------------------------------------------------------
create table public.cl_srq_settings (
  business_id   uuid primary key references public.cl_businesses(id),
  delay_hours   integer not null default 8 check (delay_hours between 1 and 72),
  repeat_hours  integer default 24 check (repeat_hours is null or repeat_hours between 4 and 72),   -- null: don't repeat
  updated_at    timestamptz not null default now(),
  updated_by    text,
  updated_staff_id uuid,
  updated_terminal_id uuid references public.cl_terminals(id)
);
create table public.cl_srq_settings_log (
  id          bigserial primary key,
  business_id uuid not null references public.cl_businesses(id),
  at          timestamptz not null default now(),
  terminal_id uuid references public.cl_terminals(id),
  staff_id    uuid,
  by_name     text,
  old_value   jsonb not null,
  new_value   jsonb not null
);
create index cl_srq_settings_log_biz_idx on public.cl_srq_settings_log (business_id, id);

-- 4. Helpers ------------------------------------------------------------------
create function public.cl_srq_settings_of(p_business uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('delay_hours', s.delay_hours, 'repeat_hours', s.repeat_hours, 'updated_at', s.updated_at, 'updated_by', s.updated_by)
                     from cl_srq_settings s where s.business_id = p_business),
                  jsonb_build_object('delay_hours', 8, 'repeat_hours', 24, 'updated_at', null, 'updated_by', null))
$$;
-- The person signed in on the calling seat or till (cl_install_vendor sets it), or null.
create function public.cl_srq_staff() returns uuid
language sql stable as $$
  select nullif(coalesce(nullif(current_setting('cl.seat_staff', true), ''), current_setting('cl.till_staff', true)), '')::uuid
$$;
create function public.cl_srq_owner_admin(p_business uuid, p_staff uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_staff is not null and exists (select 1 from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id
                                          where s.id = p_staff and s.active and s.business_id = p_business and r.builtin in ('owner', 'admin'))
$$;
-- A request's change reaches every device with the next pull.
create function public.cl_srq_touch(p_request uuid) returns void
language sql security definer set search_path = public as $$
  update cl_stock_requests set change_seq = nextval('cl_stock_ctl_seq'), updated_at = now() where id = p_request
$$;

-- The draft follows the request (whichever function changed its status):
--   approved / part-approved      -> a draft, open
--   dispatched / received (a DN)  -> the draft is sent with that DN
--   back to approved (DN cancelled)-> open again, nothing sent
create function public.cl_srq_on_request() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status in ('approved', 'part_approved') and old.status = 'pending' then
    insert into cl_srq_drafts (request_id, business_id, approved_at, approved_by, approved_staff_id)
    values (new.id, new.business_id, coalesce(new.decided_at, now()), new.decided_by, cl_srq_staff())
    on conflict (request_id) do nothing;
  elsif new.status in ('dispatched', 'received') and new.dispatch_id is not null then
    update cl_srq_drafts set status = 'sent', dispatch_id = new.dispatch_id, sent_at = coalesce(sent_at, now()), updated_at = now()
     where request_id = new.id and status <> 'closed';
  elsif new.status in ('approved', 'part_approved') and old.status = 'dispatched' then
    update cl_srq_drafts set status = 'open', dispatch_id = null, sent_by = null, sent_terminal_id = null, sent_at = null, updated_at = now()
     where request_id = new.id and status = 'sent';
    update cl_stock_request_lines set sent_qty = null where request_id = new.id;
  end if;
  return null;
end $fn$;
create trigger cl_stock_requests_srq_draft after update of status on public.cl_stock_requests
  for each row when (old.status is distinct from new.status) execute function public.cl_srq_on_request();

-- 5. A request as devices see it (as 20261115120000, plus who decided, the draft and each line's sent quantity)
create or replace function public.cl_stock_request_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'req_no', r.req_no, 'from_branch_id', r.from_branch_id, 'from_branch', fb.name,
    'to_branch_id', r.to_branch_id, 'to_branch', tb.name, 'terminal_id', r.terminal_id, 'requested_by', r.requested_by,
    'reason', r.reason, 'needed_by', r.needed_by, 'status', r.status, 'decided_by', r.decided_by, 'decided_at', r.decided_at,
    'decided_staff_id', r.decided_staff_id, 'decided_terminal_id', r.decided_terminal_id,   -- v37.1
    'decision_note', r.decision_note, 'dispatch_id', r.dispatch_id, 'dn_display', d.dn_display, 'dn_status', d.status,
    'grv_display', d.grv_display, 'received_at', d.received_at, 'created_ts', r.created_ts, 'created_at', r.created_at, 'change_seq', r.change_seq,
    'draft', (select jsonb_build_object('status', x.status, 'approved_at', x.approved_at, 'approved_by', x.approved_by,   -- v37.1 (decision 63)
                'approved_staff_id', x.approved_staff_id, 'approved_terminal_id', x.approved_terminal_id, 'dispatch_id', x.dispatch_id,
                'sent_by', x.sent_by, 'sent_at', x.sent_at, 'closed_by', x.closed_by, 'close_reason', x.close_reason, 'closed_at', x.closed_at)
              from cl_srq_drafts x where x.request_id = r.id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'product_key', l.product_key, 'code', l.code, 'name', l.name,
        'qty', l.qty, 'approved_qty', l.approved_qty, 'sent_qty', l.sent_qty) order by l.line_no) from cl_stock_request_lines l where l.request_id = r.id), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', g.at, 'by', g.by_name, 'action', g.action, 'detail', g.detail) order by g.id)
        from cl_stock_ctl_log g where g.doc_id = r.id and g.doc_kind = 'request'), '[]'::jsonb))
  from cl_stock_requests r join cl_branches fb on fb.id = r.from_branch_id join cl_branches tb on tb.id = r.to_branch_id
  left join cl_dispatches d on d.id = r.dispatch_id
  where r.id = p_id
$$;

-- 6. Events: v37's function, behind one that knows the drafts ---------------------
alter function public.cl_stock_ctl_event(public.cl_terminals, jsonb) rename to cl_stock_ctl_event_v37;
create function public.cl_stock_ctl_event(me public.cl_terminals, e jsonb) returns text
language plpgsql security definer set search_path = public as $fn$
declare v_type text := coalesce(e->>'type', ''); v_id uuid; v_res text; dr cl_srq_drafts%rowtype; rq cl_stock_requests%rowtype;
        v_by text := cl_stock_ctl_text(e->>'by', 80); v_note text := cl_stock_ctl_text(e->>'note', 200); v_staff uuid := cl_srq_staff();
        v_disp uuid; l jsonb; v_line record; v_changes jsonb := '[]'::jsonb;
begin
  if v_type in ('draft_close', 'request_link', 'request_decide') then
    begin v_id := (e->>'id')::uuid; exception when others then raise exception 'BAD_EVENT: The event has no id.'; end;
  end if;

  -- closing a draft without sending it (decision 63): Review stock requests, or an Owner/Admin; a reason
  if v_type = 'draft_close' then
    if not cl_srq_owner_admin(me.business_id, v_staff) then perform cl_seat_need('review_requisitions'); end if;
    select * into rq from cl_stock_requests where id = v_id and business_id = me.business_id for update;
    if rq.id is null then raise exception 'NOT_FOUND: That request isn''t on seiGEN yet.'; end if;
    select * into dr from cl_srq_drafts where request_id = v_id for update;
    if dr.request_id is null then raise exception 'NO_DRAFT: That request has no draft Delivery Note.'; end if;
    if dr.status = 'closed' then return 'duplicate'; end if;
    if dr.status = 'sent' then raise exception 'DRAFT_SENT: % already sent it, so it can''t be closed.', coalesce(dr.sent_by, 'Someone'); end if;
    if v_note is null then raise exception 'BAD_EVENT: Give the reason for closing the draft.'; end if;
    update cl_srq_drafts set status = 'closed', closed_by = v_by, closed_staff_id = v_staff, close_reason = v_note,
           closed_at = coalesce(nullif(e->>'ts', '')::timestamptz, now()), updated_at = now() where request_id = v_id;
    update cl_stock_requests set status = 'not_dispatched', change_seq = nextval('cl_stock_ctl_seq'), updated_at = now() where id = v_id;
    perform cl_stock_ctl_log_add('request', v_id, me.id, v_by, 'not_dispatched', jsonb_build_object('note', v_note));
    return 'stored';
  end if;

  -- main's DN for a request: as v37, but never past its draft (sent by another DN, or closed), and never above what was approved
  if v_type = 'request_link' then
    v_disp := nullif(e->>'dispatch_id', '')::uuid;
    select * into dr from cl_srq_drafts where request_id = v_id;
    if dr.status = 'closed' then raise exception 'DRAFT_CLOSED: The draft was closed (%), so the request takes no Delivery Note.', dr.close_reason; end if;
    if dr.status = 'sent' and dr.dispatch_id is distinct from v_disp
       and exists (select 1 from cl_dispatches x where x.id = dr.dispatch_id and x.status <> 'cancelled') then
      raise exception 'DRAFT_SENT: % already sent this request''s Delivery Note.', coalesce(dr.sent_by, 'Someone');
    end if;
    for l in select x from jsonb_array_elements(coalesce(e->'lines', '[]'::jsonb)) x loop
      select * into v_line from cl_stock_request_lines where request_id = v_id and line_no = (l->>'line_no')::integer;
      if v_line.line_no is null then raise exception 'BAD_EVENT: Line % isn''t on the request.', l->>'line_no'; end if;
      if coalesce((l->>'sent_qty')::integer, -1) not between 0 and coalesce(v_line.approved_qty, 0) then
        raise exception 'OVER_APPROVED: % can be sent for 0 to % (approved).', v_line.name, coalesce(v_line.approved_qty, 0);
      end if;
    end loop;
    v_res := cl_stock_ctl_event_v37(me, e);
    if v_res = 'stored' then
      for l in select x from jsonb_array_elements(coalesce(e->'lines', '[]'::jsonb)) x loop
        update cl_stock_request_lines set sent_qty = (l->>'sent_qty')::integer where request_id = v_id and line_no = (l->>'line_no')::integer and sent_qty is null;
      end loop;
      update cl_srq_drafts set sent_by = coalesce(sent_by, v_by), sent_terminal_id = coalesce(sent_terminal_id, me.id), updated_at = now()
       where request_id = v_id;
    end if;
    return v_res;
  end if;

  v_res := cl_stock_ctl_event_v37(me, e);
  -- who approved, on which device (the reminder goes to them, decision 64)
  if v_type = 'request_decide' and v_res = 'stored' then
    update cl_stock_requests set decided_staff_id = v_staff, decided_terminal_id = me.id where id = v_id;
    update cl_srq_drafts set approved_staff_id = coalesce(v_staff, approved_staff_id), approved_terminal_id = me.id where request_id = v_id;
  end if;
  return v_res;
end $fn$;

-- 7. Sending a draft: the first sender takes it (decision 63) ----------------------------
-- Before the DN is made on the till (online): the quantities it will send, never above
-- what was approved (a line left out is removed: 0). p_dispatch_id is this sending's own id
-- (the DN's id comes with its request_link a moment later, and replaces it). Answers ok, or
-- DRAFT_SENT / DRAFT_CLOSED for a second sender. The same id again is ok (a retry).
create function public.cl_device_srq_draft_claim(p_install_id text, p_secret_phrase text, p_device_key text,
                                                p_request_id uuid, p_dispatch_id uuid, p_by text, p_lines jsonb) returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; rq cl_stock_requests%rowtype; dr cl_srq_drafts%rowtype; v_by text := cl_stock_ctl_text(p_by, 80);
        v_line record; v_sent integer; v_any boolean := false; v_changes jsonb := '[]'::jsonb;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  perform cl_guest_seat_refuse();
  perform cl_seat_need('m.dispatch');
  if me.branch_id is distinct from cl_stock_ctl_main(me.business_id) then
    return json_build_object('error', 'NOT_MAIN', 'message', 'Drafts from stock requests are sent from the main branch.');
  end if;
  select * into rq from cl_stock_requests where id = p_request_id and business_id = me.business_id for update;
  if rq.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That request isn''t on seiGEN.'); end if;
  select * into dr from cl_srq_drafts where request_id = p_request_id for update;
  if dr.request_id is null then return json_build_object('error', 'NO_DRAFT', 'message', 'That request has no draft Delivery Note.'); end if;
  if dr.status = 'closed' then
    return json_build_object('error', 'DRAFT_CLOSED', 'message', 'This draft was closed by ' || coalesce(dr.closed_by, 'someone') || ': ' || coalesce(dr.close_reason, '') || '.');
  end if;
  if dr.status = 'sent' then
    if dr.dispatch_id = p_dispatch_id then return json_build_object('ok', true, 'already', true); end if;
    -- the same till's earlier try whose DN was never made (its stock check failed): it may try again
    if not (dr.sent_terminal_id = me.id and not exists (select 1 from cl_dispatches x where x.id = dr.dispatch_id)) then
      return json_build_object('error', 'DRAFT_SENT', 'message', 'This draft has already been sent by ' || coalesce(dr.sent_by, 'someone')
        || coalesce(' at ' || to_char(dr.sent_at at time zone 'Africa/Harare', 'DD Mon HH24:MI'), '') || '.', 'sent_by', dr.sent_by, 'sent_at', dr.sent_at);
    end if;
  end if;
  if rq.status not in ('approved', 'part_approved') then
    return json_build_object('error', 'WRONG_STATUS', 'message', 'The request is ' || rq.status || ', not waiting for dispatch.');
  end if;
  if p_dispatch_id is null then return json_build_object('error', 'BAD_EVENT', 'message', 'Which Delivery Note?'); end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then return json_build_object('error', 'BAD_EVENT', 'message', 'Give each line''s quantity.'); end if;
  for v_line in select l.line_no, l.name, coalesce(l.approved_qty, 0) approved,
                       (select (x->>'sent_qty')::integer from jsonb_array_elements(p_lines) x where (x->>'line_no')::integer = l.line_no limit 1) sent
                  from cl_stock_request_lines l where l.request_id = p_request_id order by l.line_no loop
    v_sent := coalesce(v_line.sent, 0);
    if v_sent < 0 or v_sent > v_line.approved then
      return json_build_object('error', 'OVER_APPROVED', 'message', v_line.name || ': send 0 to ' || v_line.approved || ' (approved).');
    end if;
    if v_sent > 0 then v_any := true; end if;
    if v_sent <> v_line.approved then
      v_changes := v_changes || jsonb_build_array(jsonb_build_object('line_no', v_line.line_no, 'name', v_line.name, 'approved', v_line.approved, 'sent', v_sent));
    end if;
  end loop;
  if not v_any then return json_build_object('error', 'BAD_EVENT', 'message', 'Nothing to send: close the draft with a reason instead.'); end if;
  for v_line in select l.line_no from cl_stock_request_lines l where l.request_id = p_request_id loop
    update cl_stock_request_lines set sent_qty = coalesce((select (x->>'sent_qty')::integer from jsonb_array_elements(p_lines) x where (x->>'line_no')::integer = v_line.line_no limit 1), 0)
     where request_id = p_request_id and line_no = v_line.line_no;
  end loop;
  update cl_srq_drafts set status = 'sent', dispatch_id = p_dispatch_id, sent_by = v_by, sent_terminal_id = me.id, sent_at = now(), updated_at = now()
   where request_id = p_request_id;
  if jsonb_array_length(v_changes) > 0 then
    perform cl_stock_ctl_log_add('request', p_request_id, me.id, v_by, 'draft_changed', jsonb_build_object('lines', v_changes));
  end if;
  perform cl_srq_touch(p_request_id);
  return json_build_object('ok', true, 'changes', v_changes);
end $fn$;

-- The till's DN for a claimed draft could not be made (its stock check failed): the draft is open again.
create function public.cl_device_srq_draft_release(p_install_id text, p_secret_phrase text, p_device_key text,
                                                  p_request_id uuid, p_dispatch_id uuid) returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; dr cl_srq_drafts%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  perform cl_guest_seat_refuse();
  select * into dr from cl_srq_drafts where request_id = p_request_id and business_id = me.business_id for update;
  if dr.request_id is null or dr.status <> 'sent' or dr.dispatch_id is distinct from p_dispatch_id or dr.sent_terminal_id is distinct from me.id then
    return json_build_object('ok', true, 'released', false);
  end if;
  if exists (select 1 from cl_dispatches x where x.id = p_dispatch_id) then return json_build_object('ok', true, 'released', false); end if;
  update cl_srq_drafts set status = 'open', dispatch_id = null, sent_by = null, sent_terminal_id = null, sent_at = null, updated_at = now() where request_id = p_request_id;
  update cl_stock_request_lines set sent_qty = null where request_id = p_request_id;
  perform cl_srq_touch(p_request_id);
  return json_build_object('ok', true, 'released', true);
end $fn$;

-- 8. The reminder timers: an Owner/Admin (decision 64) -----------------------------------
-- p_repeat_hours null = don't repeat. Answers the values now in force.
create function public.cl_device_srq_settings_set(p_install_id text, p_secret_phrase text, p_device_key text,
                                                 p_delay_hours integer, p_repeat_hours integer, p_by text) returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_staff uuid; v_old jsonb; v_new jsonb;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  perform cl_guest_seat_refuse();
  v_staff := cl_srq_staff();
  -- an Owner or Admin signed in; or, nobody signed in, a till in single operator mode (its Admin passcode is the owner's)
  if not (cl_srq_owner_admin(me.business_id, v_staff)
          or (v_staff is null and me.device_kind = 'till' and coalesce(me.staff_mode, 'single') <> 'roles')) then
    return json_build_object('error', 'NOT_OWNER_ADMIN', 'message', 'Only an Owner or Admin can change the dispatch reminder.');
  end if;
  if p_delay_hours is null or p_delay_hours not between 1 and 72 then
    return json_build_object('error', 'BAD_VALUE', 'message', 'Remind after 1 to 72 hours.');
  end if;
  if p_repeat_hours is not null and p_repeat_hours not between 4 and 72 then
    return json_build_object('error', 'BAD_VALUE', 'message', 'Repeat every 4 to 72 hours, or don''t repeat.');
  end if;
  v_old := cl_srq_settings_of(me.business_id) - 'updated_at' - 'updated_by';
  v_new := jsonb_build_object('delay_hours', p_delay_hours, 'repeat_hours', p_repeat_hours);
  if v_old = v_new then return json_build_object('ok', true, 'unchanged', true, 'settings', cl_srq_settings_of(me.business_id)); end if;
  insert into cl_srq_settings (business_id, delay_hours, repeat_hours, updated_at, updated_by, updated_staff_id, updated_terminal_id)
  values (me.business_id, p_delay_hours, p_repeat_hours, now(), cl_stock_ctl_text(p_by, 80), v_staff, me.id)
  on conflict (business_id) do update set delay_hours = excluded.delay_hours, repeat_hours = excluded.repeat_hours, updated_at = now(),
         updated_by = excluded.updated_by, updated_staff_id = excluded.updated_staff_id, updated_terminal_id = excluded.updated_terminal_id;
  insert into cl_srq_settings_log (business_id, terminal_id, staff_id, by_name, old_value, new_value)
  values (me.business_id, me.id, v_staff, cl_stock_ctl_text(p_by, 80), v_old, v_new);
  return json_build_object('ok', true, 'settings', cl_srq_settings_of(me.business_id));
end $fn$;

-- 9. The pull (as 20261115120000, plus the reminder timers and whether seiGEN takes branch figures)
create or replace function public.cl_device_stock_ctl_pull(p_install_id text, p_secret_phrase text, p_device_key text, p_cursor bigint, p_itred_after bigint default 0)
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
    'srq_settings', cl_srq_settings_of(me.business_id),   -- v37.1 (decision 64)
    'bs_enabled', cl_bs_enabled(me.business_id),           -- v37.1 (branch-figures fix)
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
                              and (not v_first or r.created_at > v_old or r.status not in ('rejected', 'received', 'not_dispatched'))), '[]'::json),
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

-- 10. Requests approved before v37.1 (once) ------------------------------------------------
do $$
declare r record; d cl_dispatches%rowtype; n_linked integer := 0; n_drafts integer := 0;
begin
  for r in select q.* from cl_stock_requests q
            where q.status in ('approved', 'part_approved') and q.dispatch_id is null
              and not exists (select 1 from cl_srq_drafts x where x.request_id = q.id) order by q.created_at loop
    -- its DN was sent but never linked (v37's Dispatch screen lost the link): link it, as the request_link event would have
    select * into d from cl_dispatches x
     where x.business_id = r.business_id and x.from_branch_id = r.to_branch_id and x.to_branch_id = r.from_branch_id
       and x.internal_ref = r.req_no and x.status <> 'cancelled'
     order by x.sent_at limit 1;
    insert into cl_srq_drafts (request_id, business_id, approved_at, approved_by) values (r.id, r.business_id, coalesce(r.decided_at, r.created_at), r.decided_by);
    if d.id is not null then
      update cl_stock_requests set status = case when d.status in ('received', 'received_diff') then 'received' else 'dispatched' end, dispatch_id = d.id,
             change_seq = nextval('cl_stock_ctl_seq'), updated_at = now() where id = r.id;
      update cl_srq_drafts set sent_by = d.sent_by where request_id = r.id;
      perform cl_stock_ctl_log_add('request', r.id, d.from_terminal_id, d.sent_by, 'dispatched', jsonb_build_object('dn', d.dn_display, 'linked_at', 'v37.1'));
      if d.status in ('received', 'received_diff') then
        perform cl_stock_ctl_log_add('request', r.id, d.grv_terminal_id, d.grv_by, 'received', jsonb_build_object('grv', d.grv_display, 'linked_at', 'v37.1'));
      end if;
      n_linked := n_linked + 1;
    else
      perform cl_srq_touch(r.id);
      n_drafts := n_drafts + 1;
    end if;
  end loop;
  raise notice 'srq_drafts: % older approved request(s) got a draft; % linked to the DN already sent for them', n_drafts, n_linked;
end $$;

-- 11. Who may call what ----------------------------------------------------------------
alter table public.cl_srq_drafts enable row level security;
alter table public.cl_srq_settings enable row level security;
alter table public.cl_srq_settings_log enable row level security;
revoke all on table public.cl_srq_drafts, public.cl_srq_settings, public.cl_srq_settings_log from public, anon, authenticated;
revoke all on sequence public.cl_srq_settings_log_id_seq from public, anon, authenticated;
revoke all on function public.cl_srq_settings_of(uuid), public.cl_srq_staff(), public.cl_srq_owner_admin(uuid, uuid), public.cl_srq_touch(uuid),
  public.cl_srq_on_request(), public.cl_stock_ctl_event(public.cl_terminals, jsonb), public.cl_stock_ctl_event_v37(public.cl_terminals, jsonb),
  public.cl_device_srq_draft_claim(text, text, text, uuid, uuid, text, jsonb), public.cl_device_srq_draft_release(text, text, text, uuid, uuid),
  public.cl_device_srq_settings_set(text, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.cl_device_srq_draft_claim(text, text, text, uuid, uuid, text, jsonb), public.cl_device_srq_draft_release(text, text, text, uuid, uuid),
  public.cl_device_srq_settings_set(text, text, text, integer, integer, text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
