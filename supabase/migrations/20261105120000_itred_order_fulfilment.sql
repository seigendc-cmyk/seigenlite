-- =====================================================================
-- iTred orders: fulfilled by the vendor's tills, confirmed or disputed by
-- the customer, and one message thread per order (owner's answers to the
-- iTred design, 2026-10-14, "go iTred-B"). Applied live only after the
-- owner has seen this file and said "apply".
-- Design: docs/itred/itred-upgrade-design.md (Parts B, C)
-- Rollback: supabase/rollbacks/20261105120000_itred_order_fulfilment.rollback.sql
-- Tested in PGlite: supabase/tests/itred-order-fulfilment-test.js
--
-- 1. Only the vendor sets quantity_fulfilled now (Q2): the customer's
--    column grant and policy from 20260925120000 are removed. The customer
--    confirms or disputes a line the vendor has answered
--    (itred_line_respond). The order status still follows the lines
--    (purchase_order_items_sync_po_status, unchanged).
-- 2. New columns: lines get vendor_note / vendor_updated_at /
--    customer_confirmed_at / customer_dispute; orders get completed_at
--    (the vendor marked it complete; the status is not changed by it),
--    updated_at and change_seq (bumped by triggers whenever the order, a
--    line or a message changes: the tills' pull cursor).
-- 3. itred_po_updates: one row per vendor action, keyed by the till's own
--    uid, so a resend changes nothing (no duplicates), and the history of
--    who changed what from which till.
-- 4. itred_order_messages: one thread per order (customer and vendor);
--    customers read and write their own orders' threads (RLS), vendors
--    through the device calls.
-- 5. Device calls (install ID + phrase + device key, like every till
--    call): every till of the business reaches its business's iTred
--    orders (Q4) and no other's. The vendor sees the customer's name and
--    phone, never the email or the customer id (Q6). Nothing here touches
--    stock or sales (Q1).
-- Additive except the customer's fulfilment right (1). No IF NOT EXISTS /
-- OR REPLACE; the preflight stops on any name clash.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'table itred_po_updates' n where to_regclass('public.itred_po_updates') is not null
    union all select 'table itred_order_messages' where to_regclass('public.itred_order_messages') is not null
    union all select 'sequence itred_po_change_seq' where to_regclass('public.itred_po_change_seq') is not null
    union all select 'column purchase_orders.change_seq' where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'purchase_orders' and column_name = 'change_seq')
    union all select 'column purchase_order_items.vendor_note' where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'purchase_order_items' and column_name = 'vendor_note')
    union all select 'function ' || p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in
      ('itred_vendor_of_device', 'itred_po_bump', 'itred_po_touch', 'itred_order_json', 'itred_line_respond', 'itred_messages_read',
       'cl_device_itred_orders_pull', 'cl_device_itred_line_update', 'cl_device_itred_order_complete', 'cl_device_itred_message_send', 'cl_device_itred_messages_read')
  ) x;
  if conflicts is not null then raise exception 'itred_order_fulfilment aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'table purchase_orders' n where to_regclass('public.purchase_orders') is null
    union all select 'trigger purchase_order_items_sync_po_status (20260925120000)' where not exists (
      select 1 from pg_trigger where tgname = 'purchase_order_items_sync_po_status' and tgrelid = 'public.purchase_order_items'::regclass)
    union all select 'policy "Customers can record fulfilment on own purchase orders"' where not exists (
      select 1 from pg_policy where polname = 'Customers can record fulfilment on own purchase orders' and polrelid = 'public.purchase_order_items'::regclass)
    union all select 'function cl_account_identity (20261016120000)' where to_regprocedure('public.cl_account_identity(uuid,uuid)') is null
    union all select 'function cl_install_vendor' where to_regprocedure('public.cl_install_vendor(text,text,text,boolean,text,text)') is null
  ) x;
  if missing is not null then raise exception 'itred_order_fulfilment aborted: missing %. Nothing was changed.', missing; end if;
end $$;

-- 1. The customer no longer sets quantity_fulfilled -----------------------
drop policy "Customers can record fulfilment on own purchase orders" on public.purchase_order_items;
revoke update (quantity_fulfilled) on public.purchase_order_items from authenticated;

-- 2. Columns ----------------------------------------------------------------
create sequence public.itred_po_change_seq;
revoke all on sequence public.itred_po_change_seq from anon, authenticated;

alter table public.purchase_orders
  add column completed_at timestamptz,
  add column updated_at   timestamptz not null default now(),
  add column change_seq   bigint not null default nextval('public.itred_po_change_seq');   -- numbers the existing orders
-- New orders get theirs from the trigger below (security definer): customers
-- have no right on the sequence, so a column default would refuse their insert.
alter table public.purchase_orders alter column change_seq drop default;
create index purchase_orders_vendor_change_idx on public.purchase_orders (vendor_id, change_seq);
comment on column public.purchase_orders.completed_at is 'Set by the vendor''s till ("Mark complete"); the status still follows the lines.';
comment on column public.purchase_orders.change_seq is 'Bumped whenever the order, a line or a message changes: the tills'' pull cursor (cl_device_itred_orders_pull).';

alter table public.purchase_order_items
  add column vendor_note           text check (vendor_note is null or length(vendor_note) <= 300),
  add column vendor_updated_at     timestamptz,
  add column customer_confirmed_at timestamptz,
  add column customer_dispute      text check (customer_dispute is null or length(customer_dispute) between 1 and 300);

-- 3. Vendor actions (one row each; the uid comes from the till) -------------
create table public.itred_po_updates (
  uid               uuid primary key,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  item_id           uuid references public.purchase_order_items(id) on delete cascade,
  kind              text not null check (kind in ('line', 'complete')),
  qty_fulfilled     numeric(12,3),
  note              text,
  vendor_id         uuid references public.cl_vendors(id) on delete set null,   -- the till (its install's row)
  till_code         text,
  created_at        timestamptz not null default now()
);
create index itred_po_updates_order_idx on public.itred_po_updates (purchase_order_id, created_at);
alter table public.itred_po_updates enable row level security;
revoke all on table public.itred_po_updates from anon, authenticated;

-- 4. One message thread per order -------------------------------------------
create table public.itred_order_messages (
  id                uuid primary key,                       -- made by the sender (a resend is refused, not doubled)
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  author            text not null default 'customer' check (author in ('customer', 'vendor')),
  body              text not null check (length(btrim(body)) between 1 and 1000),
  vendor_id         uuid references public.cl_vendors(id) on delete set null,   -- the till, for a vendor message
  till_code         text,
  created_at        timestamptz not null default now(),
  vendor_read_at    timestamptz,
  customer_read_at  timestamptz
);
create index itred_order_messages_order_idx on public.itred_order_messages (purchase_order_id, created_at);
alter table public.itred_order_messages enable row level security;
revoke all on table public.itred_order_messages from anon, authenticated;
grant select on public.itred_order_messages to authenticated;
grant insert (id, purchase_order_id, body) on public.itred_order_messages to authenticated;
create policy "Customers can read messages on own purchase orders"
  on public.itred_order_messages for select to authenticated
  using (exists (select 1 from public.purchase_orders po where po.id = itred_order_messages.purchase_order_id and po.customer_id = (select auth.uid())));
create policy "Customers can write on own purchase orders"
  on public.itred_order_messages for insert to authenticated
  with check (author = 'customer' and exists (select 1 from public.purchase_orders po
    where po.id = itred_order_messages.purchase_order_id and po.customer_id = (select auth.uid())));

-- 5. change_seq: bumped on every change -------------------------------------
create function public.itred_po_bump() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.change_seq := nextval('public.itred_po_change_seq');
  new.updated_at := now();
  return new;
end $$;
create trigger purchase_orders_bump before insert or update on public.purchase_orders
  for each row execute function public.itred_po_bump();

create function public.itred_po_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.purchase_orders set updated_at = now() where id = new.purchase_order_id;
  return null;
end $$;
create trigger purchase_order_items_touch_po after insert or update on public.purchase_order_items
  for each row execute function public.itred_po_touch();
create trigger itred_order_messages_touch_po after insert or update on public.itred_order_messages
  for each row execute function public.itred_po_touch();
revoke execute on function public.itred_po_bump(), public.itred_po_touch() from public, anon, authenticated;

-- 6. The customer answers the vendor -----------------------------------------
-- p_confirm true: "received as the vendor says" (clears a dispute);
-- false with p_dispute: what's wrong. Only on a line the vendor has answered.
create function public.itred_line_respond(p_item_id uuid, p_confirm boolean, p_dispute text default null) returns json
language plpgsql security definer set search_path = public as $fn$
declare i purchase_order_items%rowtype; v_reason text := nullif(btrim(coalesce(p_dispute, '')), '');
begin
  select it.* into i from purchase_order_items it join purchase_orders po on po.id = it.purchase_order_id
   where it.id = p_item_id and po.customer_id = auth.uid();
  if not found then return json_build_object('error', 'NOT_FOUND'); end if;
  if i.vendor_updated_at is null then return json_build_object('error', 'NOT_ANSWERED', 'message', 'The vendor hasn''t updated this item yet.'); end if;
  if p_confirm then
    update purchase_order_items set customer_confirmed_at = now(), customer_dispute = null where id = i.id;
  else
    if v_reason is null then return json_build_object('error', 'REASON_REQUIRED', 'message', 'Say what is wrong.'); end if;
    update purchase_order_items set customer_dispute = left(v_reason, 300), customer_confirmed_at = null where id = i.id;
  end if;
  return json_build_object('ok', true);
end $fn$;

create function public.itred_messages_read(p_order_id uuid) returns json
language plpgsql security definer set search_path = public as $fn$
begin
  if not exists (select 1 from purchase_orders where id = p_order_id and customer_id = auth.uid()) then return json_build_object('error', 'NOT_FOUND'); end if;
  update itred_order_messages set customer_read_at = now() where purchase_order_id = p_order_id and author = 'vendor' and customer_read_at is null;
  return json_build_object('ok', true);
end $fn$;

-- 7. Device calls --------------------------------------------------------------
-- The calling till's iTred vendor: its business's (the main till's install ID,
-- as market publishing names it), else its own. Null: not on iTred.
create function public.itred_vendor_of_device(v cl_vendors) returns uuid
language sql stable security definer set search_path = public as $$
  select iv.id from vendors iv where iv.install_id = (cl_account_identity(cl_vendor_business(v.id), v.id)).install_id
$$;

-- One order as a till sees it: no customer email, no customer id.
create function public.itred_order_json(p_order_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', po.id, 'created_at', po.created_at, 'status', po.status, 'completed_at', po.completed_at,
    'updated_at', po.updated_at, 'change_seq', po.change_seq,
    'customer', jsonb_build_object('name', c.full_name, 'phone', c.phone),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.item_name, 'unit_price', i.unit_price, 'currency', i.currency,
        'qty', i.quantity_requested, 'fulfilled', i.quantity_fulfilled, 'status', i.fulfillment_status, 'custom', i.is_custom_request,
        'note', i.vendor_note, 'vendor_updated_at', i.vendor_updated_at, 'confirmed_at', i.customer_confirmed_at, 'dispute', i.customer_dispute)
        order by i.is_custom_request, i.item_name) from purchase_order_items i where i.purchase_order_id = po.id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'author', m.author, 'body', m.body, 'created_at', m.created_at,
        'till_code', m.till_code, 'vendor_read_at', m.vendor_read_at, 'customer_read_at', m.customer_read_at) order by m.created_at)
        from itred_order_messages m where m.purchase_order_id = po.id), '[]'::jsonb))
  from purchase_orders po left join customers c on c.id = po.customer_id
  where po.id = p_order_id
$$;

create function public.cl_device_itred_orders_pull(p_install_id text, p_secret_phrase text, p_device_key text,
                                                   p_cursor bigint default 0, p_limit integer default 50) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; v_itred uuid; v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_rows jsonb; v_more boolean;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  v_itred := itred_vendor_of_device(v);
  if v_itred is null then return json_build_object('error', 'NOT_ON_ITRED'); end if;
  select coalesce(jsonb_agg(itred_order_json(x.id) order by x.change_seq), '[]'::jsonb) into v_rows
    from (select id, change_seq from purchase_orders where vendor_id = v_itred and change_seq > coalesce(p_cursor, 0)
           and exists (select 1 from purchase_order_items i where i.purchase_order_id = purchase_orders.id)   -- an order whose lines were refused is never shown
          order by change_seq limit v_lim) x;
  v_more := jsonb_array_length(v_rows) = v_lim;
  return json_build_object('orders', v_rows, 'more', v_more,
    'cursor', coalesce((select max((o->>'change_seq')::bigint) from jsonb_array_elements(v_rows) o), coalesce(p_cursor, 0)));
end $fn$;

-- A line: fulfilled quantity (0 = outstanding) and an optional note. Once per p_uid.
create function public.cl_device_itred_line_update(p_install_id text, p_secret_phrase text, p_device_key text,
                                                   p_uid uuid, p_item_id uuid, p_qty_fulfilled numeric, p_note text default null) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; v_itred uuid; i purchase_order_items%rowtype; po purchase_orders%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  v_itred := itred_vendor_of_device(v);
  if v_itred is null then return json_build_object('error', 'NOT_ON_ITRED'); end if;
  if p_uid is null then return json_build_object('error', 'UID_REQUIRED'); end if;
  if exists (select 1 from itred_po_updates where uid = p_uid) then return json_build_object('ok', true, 'duplicate', true); end if;
  select * into i from purchase_order_items where id = p_item_id;
  select * into po from purchase_orders where id = i.purchase_order_id;
  if i.id is null or po.vendor_id is distinct from v_itred then return json_build_object('error', 'NOT_FOUND'); end if;
  if po.status = 'closed' then return json_build_object('error', 'CLOSED', 'message', 'The customer closed this order.'); end if;
  if p_qty_fulfilled is null or p_qty_fulfilled < 0 or p_qty_fulfilled > i.quantity_requested then
    return json_build_object('error', 'BAD_QTY', 'message', 'Fulfilled must be 0 to ' || i.quantity_requested::text || '.');
  end if;
  if v_note is not null and length(v_note) > 300 then return json_build_object('error', 'NOTE_TOO_LONG'); end if;
  insert into itred_po_updates (uid, purchase_order_id, item_id, kind, qty_fulfilled, note, vendor_id, till_code)
  values (p_uid, po.id, i.id, 'line', p_qty_fulfilled, v_note, v.id, (select t.till_code from cl_terminals t where t.install_id = v.install_id));
  update purchase_order_items set quantity_fulfilled = p_qty_fulfilled, vendor_note = v_note, vendor_updated_at = now(),
         customer_confirmed_at = case when quantity_fulfilled = p_qty_fulfilled then customer_confirmed_at end,   -- a changed quantity needs a new confirmation
         customer_dispute = case when quantity_fulfilled = p_qty_fulfilled then customer_dispute end
   where id = i.id;
  return json_build_object('ok', true, 'order', itred_order_json(po.id));
end $fn$;

create function public.cl_device_itred_order_complete(p_install_id text, p_secret_phrase text, p_device_key text,
                                                      p_uid uuid, p_order_id uuid) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; v_itred uuid; po purchase_orders%rowtype;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  v_itred := itred_vendor_of_device(v);
  if v_itred is null then return json_build_object('error', 'NOT_ON_ITRED'); end if;
  if p_uid is null then return json_build_object('error', 'UID_REQUIRED'); end if;
  if exists (select 1 from itred_po_updates where uid = p_uid) then return json_build_object('ok', true, 'duplicate', true); end if;
  select * into po from purchase_orders where id = p_order_id;
  if po.id is null or po.vendor_id is distinct from v_itred then return json_build_object('error', 'NOT_FOUND'); end if;
  insert into itred_po_updates (uid, purchase_order_id, kind, vendor_id, till_code)
  values (p_uid, po.id, 'complete', v.id, (select t.till_code from cl_terminals t where t.install_id = v.install_id));
  update purchase_orders set completed_at = coalesce(completed_at, now()) where id = po.id;
  return json_build_object('ok', true, 'order', itred_order_json(po.id));
end $fn$;

create function public.cl_device_itred_message_send(p_install_id text, p_secret_phrase text, p_device_key text,
                                                    p_id uuid, p_order_id uuid, p_body text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; v_itred uuid; v_body text := btrim(coalesce(p_body, ''));
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  v_itred := itred_vendor_of_device(v);
  if v_itred is null then return json_build_object('error', 'NOT_ON_ITRED'); end if;
  if p_id is null then return json_build_object('error', 'UID_REQUIRED'); end if;
  if exists (select 1 from itred_order_messages where id = p_id) then return json_build_object('ok', true, 'duplicate', true); end if;
  if not exists (select 1 from purchase_orders where id = p_order_id and vendor_id = v_itred) then return json_build_object('error', 'NOT_FOUND'); end if;
  if length(v_body) not between 1 and 1000 then return json_build_object('error', 'BAD_BODY', 'message', 'Write 1 to 1000 characters.'); end if;
  insert into itred_order_messages (id, purchase_order_id, author, body, vendor_id, till_code, vendor_read_at)
  values (p_id, p_order_id, 'vendor', v_body, v.id, (select t.till_code from cl_terminals t where t.install_id = v.install_id), now());
  update itred_order_messages set vendor_read_at = now() where purchase_order_id = p_order_id and author = 'customer' and vendor_read_at is null;
  return json_build_object('ok', true);
end $fn$;

create function public.cl_device_itred_messages_read(p_install_id text, p_secret_phrase text, p_device_key text, p_order_id uuid) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; v_itred uuid;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  v_itred := itred_vendor_of_device(v);
  if v_itred is null then return json_build_object('error', 'NOT_ON_ITRED'); end if;
  if not exists (select 1 from purchase_orders where id = p_order_id and vendor_id = v_itred) then return json_build_object('error', 'NOT_FOUND'); end if;
  update itred_order_messages set vendor_read_at = now() where purchase_order_id = p_order_id and author = 'customer' and vendor_read_at is null;
  return json_build_object('ok', true);
end $fn$;

-- 8. Who may call what ---------------------------------------------------------
revoke all on function public.itred_vendor_of_device(cl_vendors), public.itred_order_json(uuid) from public, anon, authenticated;
revoke all on function public.itred_line_respond(uuid, boolean, text), public.itred_messages_read(uuid) from public, anon;
grant execute on function public.itred_line_respond(uuid, boolean, text), public.itred_messages_read(uuid) to authenticated;
revoke all on function public.cl_device_itred_orders_pull(text, text, text, bigint, integer), public.cl_device_itred_line_update(text, text, text, uuid, uuid, numeric, text),
  public.cl_device_itred_order_complete(text, text, text, uuid, uuid), public.cl_device_itred_message_send(text, text, text, uuid, uuid, text),
  public.cl_device_itred_messages_read(text, text, text, uuid) from public;
grant execute on function public.cl_device_itred_orders_pull(text, text, text, bigint, integer), public.cl_device_itred_line_update(text, text, text, uuid, uuid, numeric, text),
  public.cl_device_itred_order_complete(text, text, text, uuid, uuid), public.cl_device_itred_message_send(text, text, text, uuid, uuid, text),
  public.cl_device_itred_messages_read(text, text, text, uuid) to anon, authenticated;

commit;
