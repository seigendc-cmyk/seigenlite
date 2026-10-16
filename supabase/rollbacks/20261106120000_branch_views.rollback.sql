-- Rollback of 20261106120000_branch_views.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Puts back the functions exactly as 20261024120000_branch_stock,
-- 20261018120000_supplier_grv and 20261018180000_customers_wholesale left
-- them, and drops the source-branch columns. Lost for good: only the source
-- branch of customers and suppliers added after the apply (it can be derived
-- again from created_terminal). The customers' new change_seq numbers stay
-- (harmless: the tills just pulled them once more). Apps from v27 on see the
-- new functions gone and show "not on seiGEN yet" in the DN card and the item
-- ledger; selling never depends on them.

begin;

drop function if exists public.cl_device_item_ledger(text, text, text, text, text, text, uuid, timestamptz, timestamptz);
drop function if exists public.cl_ledger_line_match(text, text, text, text, text, text);
drop function if exists public.cl_device_dispatch_card(text, text, text, uuid);

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

create or replace function public.cl_supplier_json(s public.cl_suppliers) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'phone', s.phone, 'notes', s.notes, 'active', s.active, 'updated_at', s.updated_at)
$$;
alter function public.cl_supplier_json(public.cl_suppliers) reset all;
create or replace function public.cl_customer_json(c public.cl_customers) returns jsonb
language sql immutable as $$
  select jsonb_build_object('uid', c.customer_uid, 'name', c.name, 'phone', c.phone, 'phone_norm', c.phone_norm,
    'customer_type', c.customer_type, 'credit_limit', c.credit_limit, 'address', c.address, 'national_id', c.national_id,
    'active', c.active, 'seq', c.change_seq, 'updated_at', c.updated_at)
$$;
alter function public.cl_customer_json(public.cl_customers) reset all;

drop trigger if exists cl_suppliers_source_branch on public.cl_suppliers;
drop trigger if exists cl_customers_source_branch on public.cl_customers;
drop function if exists public.cl_source_branch_fill();
alter table public.cl_suppliers drop column if exists created_branch_id;
alter table public.cl_customers drop column if exists created_branch_id;

commit;
