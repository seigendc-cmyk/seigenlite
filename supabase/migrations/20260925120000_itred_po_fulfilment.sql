-- =====================================================================
-- iTred — customer-recorded fulfilment on purchase orders
--
-- Vendors have no login and never touch Supabase: they reply to an order
-- informally on WhatsApp, and the CUSTOMER records what was fulfilled on
-- their own order. This replaces the earlier plan (in
-- 20260924120000_itred_marketplace_schema.sql's header) of fulfilment being
-- set by Digital Commerce via service_role; service_role can still do it.
--
--   * authenticated may UPDATE purchase_order_items.quantity_fulfilled —
--     that column only — on lines of their own orders (RLS below).
--   * 0 <= quantity_fulfilled <= quantity_requested is already enforced by
--     the existing checks on that column and
--     purchase_order_items_not_overfulfilled; nothing to add.
--   * purchase_orders.status follows the lines automatically (trigger):
--       no line fulfilled at all      -> sent
--       some fulfilled, not every one -> partially_fulfilled
--       every line fully fulfilled    -> fulfilled
--     The customer still can't set any status but 'closed' (existing
--     policy), and a closed order stays closed whatever the lines say.
--
-- Additive, one transaction, same rules as the schema migration: no
-- IF NOT EXISTS / OR REPLACE; the preflight stops on any name clash.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------
do $$
declare
  conflicts text;
begin
  if to_regclass('public.purchase_order_items') is null
     or to_regclass('public.purchase_orders') is null then
    raise exception 'iTred fulfilment migration aborted: apply '
      '20260924120000_itred_marketplace_schema.sql first. Nothing was changed.';
  end if;

  select string_agg(n, ', ') into conflicts
  from (
    select 'public.' || p.proname || '()' as n
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname = 'itred_po_sync_status'
    union all
    select 'trigger ' || t.tgname
      from pg_trigger t
     where t.tgrelid = 'public.purchase_order_items'::regclass
       and t.tgname = 'purchase_order_items_sync_po_status'
    union all
    select 'policy "' || pol.polname || '"'
      from pg_policy pol
     where pol.polrelid = 'public.purchase_order_items'::regclass
       and pol.polname = 'Customers can record fulfilment on own purchase orders'
  ) c;

  if conflicts is not null then
    raise exception 'iTred fulfilment migration aborted: these objects already exist: %. '
      'Nothing was changed.', conflicts;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 1. Column grant: quantity_fulfilled only
-- ---------------------------------------------------------------------
grant update (quantity_fulfilled) on public.purchase_order_items to authenticated;


-- ---------------------------------------------------------------------
-- 2. RLS: only lines on the customer's own orders
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- 3. purchase_orders.status derived from its lines
-- security definer: the customer's own update rights on purchase_orders
-- only allow 'closed', so the derived statuses are written as the owner.
-- It only ever touches the order of the line that changed.
-- ---------------------------------------------------------------------
create function public.itred_po_sync_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  derived text;
begin
  select case
           when count(*) > 0 and bool_and(i.quantity_fulfilled >= i.quantity_requested) then 'fulfilled'
           when bool_or(i.quantity_fulfilled > 0) then 'partially_fulfilled'
           else 'sent'
         end
    into derived
    from public.purchase_order_items i
   where i.purchase_order_id = new.purchase_order_id;

  update public.purchase_orders po
     set status = derived
   where po.id = new.purchase_order_id
     and po.status <> 'closed'
     and po.status is distinct from derived;

  return null;
end;
$$;

revoke execute on function public.itred_po_sync_status() from public, anon, authenticated;

create trigger purchase_order_items_sync_po_status
  after update of quantity_fulfilled on public.purchase_order_items
  for each row
  when (old.quantity_fulfilled is distinct from new.quantity_fulfilled)
  execute function public.itred_po_sync_status();
