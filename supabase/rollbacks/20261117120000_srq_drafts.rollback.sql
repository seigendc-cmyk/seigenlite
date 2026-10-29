-- Rollback of 20261117120000_srq_drafts (v37.1: stock-request drafts and the
-- dispatch reminder). Puts back v37's request JSON, pull and event function,
-- and removes the drafts, the reminder timers and their log. Refuses while a
-- request is 'not_dispatched' (a closed draft): that status didn't exist in
-- v37, so those requests would have nowhere to go. Requests linked by the
-- one-off repair keep their link (it is what v37 would have done).
begin;

do $$
begin
  if exists (select 1 from public.cl_stock_requests where status = 'not_dispatched') then
    raise exception 'srq_drafts rollback refused: % request(s) are "Approved, not dispatched" (a closed draft). Nothing was changed.',
      (select count(*) from public.cl_stock_requests where status = 'not_dispatched');
  end if;
end $$;

drop trigger if exists cl_stock_requests_srq_draft on public.cl_stock_requests;
drop function if exists public.cl_srq_on_request();
drop function if exists public.cl_device_srq_draft_claim(text, text, text, uuid, uuid, text, jsonb);
drop function if exists public.cl_device_srq_draft_release(text, text, text, uuid, uuid);
drop function if exists public.cl_device_srq_settings_set(text, text, text, integer, integer, text);
drop function if exists public.cl_stock_ctl_event(public.cl_terminals, jsonb);
alter function public.cl_stock_ctl_event_v37(public.cl_terminals, jsonb) rename to cl_stock_ctl_event;

-- v37's request JSON and pull (20261115120000_stock_control.sql)
create or replace function public.cl_stock_request_json(p_id uuid) returns jsonb
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

drop function if exists public.cl_srq_touch(uuid);
drop function if exists public.cl_srq_owner_admin(uuid, uuid);
drop function if exists public.cl_srq_staff();
drop function if exists public.cl_srq_settings_of(uuid);
drop table if exists public.cl_srq_settings_log;
drop table if exists public.cl_srq_settings;
drop table if exists public.cl_srq_drafts;
alter table public.cl_stock_request_lines drop constraint if exists cl_stock_request_lines_sent_check;
alter table public.cl_stock_request_lines drop column if exists sent_qty;
alter table public.cl_stock_requests drop column if exists decided_terminal_id, drop column if exists decided_staff_id;
alter table public.cl_stock_requests drop constraint cl_stock_requests_status_check;
alter table public.cl_stock_requests add constraint cl_stock_requests_status_check
  check (status in ('pending', 'approved', 'part_approved', 'rejected', 'dispatched', 'received'));
revoke all on function public.cl_stock_ctl_event(public.cl_terminals, jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
