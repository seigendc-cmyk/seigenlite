-- Rollback of 20261105120000_itred_order_fulfilment.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Drops the device calls, the message thread, the vendor action log and
-- the new columns (their data goes with them: vendor notes, confirmations,
-- disputes, messages), and gives the customer back "Record delivery"
-- (the 20260925120000 policy and column grant). quantity_fulfilled values
-- the vendors set stay, and the status still follows them.

begin;

drop function public.cl_device_itred_orders_pull(text, text, text, bigint, integer);
drop function public.cl_device_itred_line_update(text, text, text, uuid, uuid, numeric, text);
drop function public.cl_device_itred_order_complete(text, text, text, uuid, uuid);
drop function public.cl_device_itred_message_send(text, text, text, uuid, uuid, text);
drop function public.cl_device_itred_messages_read(text, text, text, uuid);
drop function public.itred_order_json(uuid);
drop function public.itred_vendor_of_device(cl_vendors);
drop function public.itred_line_respond(uuid, boolean, text);
drop function public.itred_messages_read(uuid);

drop trigger purchase_orders_bump on public.purchase_orders;
drop trigger purchase_order_items_touch_po on public.purchase_order_items;
drop table public.itred_order_messages;
drop table public.itred_po_updates;
drop function public.itred_po_bump();
drop function public.itred_po_touch();

drop index public.purchase_orders_vendor_change_idx;
alter table public.purchase_orders drop column completed_at, drop column updated_at, drop column change_seq;
alter table public.purchase_order_items drop column vendor_note, drop column vendor_updated_at,
  drop column customer_confirmed_at, drop column customer_dispute;
drop sequence public.itred_po_change_seq;

grant update (quantity_fulfilled) on public.purchase_order_items to authenticated;
create policy "Customers can record fulfilment on own purchase orders"
  on public.purchase_order_items for update
  to authenticated
  using (exists (
    select 1 from public.purchase_orders po
     where po.id = purchase_order_items.purchase_order_id
       and po.customer_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.purchase_orders po
     where po.id = purchase_order_items.purchase_order_id
       and po.customer_id = (select auth.uid())
  ));

commit;
