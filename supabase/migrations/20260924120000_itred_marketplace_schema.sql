-- =====================================================================
-- iTred Market Place — vendors, published listings, customers, purchase orders
--
-- Additive only: creates five new tables in `public`, three itred_* functions
-- and their triggers. The one touch on an existing object is a UNIQUE
-- constraint on public.cl_vendors(install_id) (section 1) so vendors can
-- reference it; nothing is replaced or dropped (no IF NOT EXISTS / OR REPLACE
-- anywhere — a name clash errors out instead of silently reusing or
-- overwriting the existing object).
--
-- Run as ONE transaction (Supabase CLI does this per migration file; the SQL
-- editor does it for a multi-statement run). If the preflight below finds a
-- conflicting name, it raises and nothing in this file is applied.
--
-- Write model for this phase:
--   * vendors / vendor_listings — written only by Digital Commerce's internal
--     review process using the service_role key (bypasses RLS). No policy
--     grants anon/authenticated any write. Vendors have no login.
--   * customers — Supabase Auth email sign-up (auth.users); the app inserts
--     the customer's own profile row after sign-up.
--   * purchase_orders / purchase_order_items — created by the signed-in
--     customer; fulfilment quantities, pdf_url and status progress are set by
--     Digital Commerce / the vendor workflow via service_role.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. Preflight: stop if any name this migration creates is already taken.
-- ---------------------------------------------------------------------
do $$
declare
  conflicts text;
begin
  select string_agg(n, ', ') into conflicts
  from (
    select n
    from unnest(array[
      'public.vendors', 'public.vendor_listings', 'public.customers',
      'public.purchase_orders', 'public.purchase_order_items'
    ]) as n
    where to_regclass(n) is not null
    union all
    select 'public.' || p.proname || '()'
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public'
      and p.proname in ('itred_set_listing_expiry', 'itred_poi_snapshot_listing',
                        'itred_expire_vendor_listings')
  ) c;

  if conflicts is not null then
    raise exception 'iTred migration aborted: these objects already exist: %. '
      'Nothing was changed. Decide whether the new tables should reference them '
      'instead (see supabase/inspect/itred_existing_schema_check.sql).', conflicts;
  end if;

  -- vendors references the device registry cl_device_checkin maintains.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cl_vendors'
       and column_name = 'install_id'
  ) then
    raise exception 'iTred migration aborted: public.cl_vendors.install_id not found. '
      'Nothing was changed.';
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 1. vendors
-- The public marketplace profile of a Commerce Lite shop that publishes to
-- the marketplace. The shop itself already exists in public.cl_vendors (one
-- row per install, created by cl_device_checkin); vendors hangs off it by
-- install_id, so a marketplace vendor is always a registered install and the
-- .scl file's install_id maps straight to it. cl_vendors is not exposed
-- publicly (it holds shop_secret_phrase, lock flags, billing cycle), hence a
-- separate table rather than an anon policy on cl_vendors.
-- ---------------------------------------------------------------------

-- A foreign key needs a non-partial unique index. cl_vendors already has
-- cl_vendors_install_id_uidx (unique where install_id is not null); a plain
-- UNIQUE constraint enforces the same rule (NULLs stay distinct) and can back
-- the FK. Fails, and so aborts the whole migration, if duplicates exist.
alter table public.cl_vendors
  add constraint cl_vendors_install_id_key unique (install_id);

create table public.vendors (
  id               uuid primary key default gen_random_uuid(),
  install_id       text not null unique
                   references public.cl_vendors(install_id)
                   on update cascade on delete restrict,
  business_name    text not null check (length(trim(business_name)) > 0),
  whatsapp_number  text,
  city             text,
  created_at       timestamptz not null default now()
);

comment on table public.vendors is
  'iTred marketplace profile of a Commerce Lite shop (public.cl_vendors). Written by Digital Commerce via service_role only; no vendor login in this phase.';
comment on column public.vendors.install_id is
  'public.cl_vendors.install_id of the shop (Commerce Lite settings.install_id, sent to cl_device_checkin as p_install_id and carried in the .scl export).';


-- ---------------------------------------------------------------------
-- 2. vendor_listings
-- The curated, published product set, loaded after Digital Commerce reviews
-- an incoming .scl marketing export. Each re-export produces new rows; old
-- ones simply expire.
-- ---------------------------------------------------------------------
create table public.vendor_listings (
  id                 uuid primary key default gen_random_uuid(),
  vendor_id          uuid not null references public.vendors(id) on delete cascade,
  source_product_id  text,
  product_name       text not null check (length(trim(product_name)) > 0),
  price              numeric(12,2) not null check (price >= 0),
  currency           char(3) not null default 'USD',
  category           text,
  stock_quantity     numeric(12,3) not null default 0 check (stock_quantity >= 0),
  image_url          text,
  exported_at        timestamptz not null,
  published_at       timestamptz,
  expires_at         timestamptz,
  status             text not null default 'pending_review'
                     check (status in ('pending_review', 'published', 'expired')),
  created_at         timestamptz not null default now(),

  constraint vendor_listings_published_has_dates
    check (status = 'pending_review' or (published_at is not null and expires_at is not null))
);

comment on column public.vendor_listings.source_product_id is
  'Product id from the vendor''s Commerce Lite database, as carried in the .scl export — for matching re-exports back to the same product.';
comment on column public.vendor_listings.currency is
  'ISO 4217 code. Commerce Lite is multi-currency, so a bare price is ambiguous.';
comment on column public.vendor_listings.stock_quantity is
  'numeric, not integer: Commerce Lite allows fractional (weighed/measured) stock.';
comment on column public.vendor_listings.image_url is
  '200x200 WebP product image.';
comment on column public.vendor_listings.expires_at is
  'Set to published_at + 7 days by trigger whenever published_at is set or changed; can be overridden afterwards by updating expires_at alone.';

-- expires_at can't be a generated column: timestamptz + interval is only
-- STABLE (DST-dependent), and generated columns require IMMUTABLE.
create function public.itred_set_listing_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.published_at is not null
     and (tg_op = 'INSERT' or new.published_at is distinct from old.published_at) then
    new.expires_at := new.published_at + interval '7 days';
  end if;
  return new;
end;
$$;

create trigger vendor_listings_set_expiry
  before insert or update of published_at on public.vendor_listings
  for each row execute function public.itred_set_listing_expiry();

-- 7-day expiry sweep + the public "published and not expired" read both
-- filter on status = 'published' and expires_at.
create index vendor_listings_expires_at_idx
  on public.vendor_listings (expires_at)
  where status = 'published';

create index vendor_listings_vendor_status_idx
  on public.vendor_listings (vendor_id, status);

-- Expiry sweep. Not scheduled here (pg_cron may not be enabled on this
-- project). Public reads already hide rows past expires_at regardless of
-- whether this has run; it just keeps `status` honest. Callable only by
-- service_role / postgres, e.g. from pg_cron or a scheduled Edge Function.
create function public.itred_expire_vendor_listings()
returns integer
language sql
security definer
set search_path = ''
as $$
  with expired as (
    update public.vendor_listings
       set status = 'expired'
     where status = 'published'
       and expires_at <= now()
    returning 1
  )
  select count(*)::integer from expired;
$$;

revoke execute on function public.itred_expire_vendor_listings() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. customers
-- Profile row keyed 1:1 to Supabase Auth's auth.users. Deliberately NOT
-- auto-created by a trigger on auth.users: this project's auth.users may
-- also hold Digital Commerce console users, who must not become customers.
-- The iTred app inserts the row itself right after email sign-up (RLS below
-- only allows id = auth.uid() and the email from the caller's own JWT).
-- ---------------------------------------------------------------------
create table public.customers (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  phone       text,
  created_at  timestamptz not null default now()
);

comment on table public.customers is
  'iTred customer profiles, 1:1 with auth.users (email sign-up).';
comment on column public.customers.full_name is
  'Optional; printed on the generated Sales Order PDF.';


-- ---------------------------------------------------------------------
-- 4. purchase_orders
-- on delete restrict for both parents: an order is a business record the
-- vendor relies on. Deleting a customer who has orders (or their auth user)
-- errors until the orders are dealt with explicitly.
-- ---------------------------------------------------------------------
create table public.purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete restrict,
  vendor_id    uuid not null references public.vendors(id) on delete restrict,
  status       text not null default 'sent'
               check (status in ('sent', 'partially_fulfilled', 'fulfilled', 'closed')),
  pdf_url      text,
  created_at   timestamptz not null default now()
);

comment on column public.purchase_orders.pdf_url is
  'Generated Sales Order PDF. Set server-side only.';

create index purchase_orders_customer_idx on public.purchase_orders (customer_id, created_at desc);
create index purchase_orders_vendor_idx   on public.purchase_orders (vendor_id, status);


-- ---------------------------------------------------------------------
-- 5. purchase_order_items
-- A line is either against a published listing (vendor_listing_id set) or a
-- custom "please source this" request (vendor_listing_id null). Listings are
-- expired, never deleted, so on delete restrict keeps that rule intact.
-- item_name / unit_price / currency are snapshotted from the listing at
-- insert time (trigger below) so the order survives the listing expiring and
-- the customer can't choose their own price.
-- fulfillment_status is derived from the quantities, so it can never
-- disagree with them.
-- ---------------------------------------------------------------------
create table public.purchase_order_items (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references public.purchase_orders(id) on delete cascade,
  vendor_listing_id   uuid references public.vendor_listings(id) on delete restrict,
  item_name           text not null check (length(trim(item_name)) > 0),
  unit_price          numeric(12,2),
  currency            char(3),
  quantity_requested  numeric(12,3) not null check (quantity_requested > 0),
  quantity_fulfilled  numeric(12,3) not null default 0 check (quantity_fulfilled >= 0),
  is_custom_request   boolean not null default false,
  fulfillment_status  text generated always as (
                        case
                          when quantity_fulfilled = 0 then 'outstanding'
                          when quantity_fulfilled >= quantity_requested then 'fulfilled'
                          else 'partially_fulfilled'
                        end
                      ) stored,
  created_at          timestamptz not null default now(),

  constraint purchase_order_items_custom_xor_listing
    check (is_custom_request = (vendor_listing_id is null)),
  constraint purchase_order_items_not_overfulfilled
    check (quantity_fulfilled <= quantity_requested)
);

comment on column public.purchase_order_items.vendor_listing_id is
  'Null when the customer is requesting an item not currently listed (is_custom_request = true).';
comment on column public.purchase_order_items.fulfillment_status is
  'Derived: outstanding / partially_fulfilled / fulfilled from quantity_fulfilled vs quantity_requested.';

create function public.itred_poi_snapshot_listing()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  l record;
begin
  if new.is_custom_request then
    new.unit_price := null;
    new.currency := null;
    return new;
  end if;

  select vl.product_name, vl.price, vl.currency
    into l
    from public.vendor_listings vl
   where vl.id = new.vendor_listing_id;

  if not found then
    raise exception 'vendor_listing % not found or not published', new.vendor_listing_id;
  end if;

  new.item_name  := l.product_name;
  new.unit_price := l.price;
  new.currency   := l.currency;
  return new;
end;
$$;

create trigger purchase_order_items_snapshot_listing
  before insert on public.purchase_order_items
  for each row execute function public.itred_poi_snapshot_listing();

create index purchase_order_items_fulfillment_status_idx
  on public.purchase_order_items (fulfillment_status);

create index purchase_order_items_order_idx
  on public.purchase_order_items (purchase_order_id);

create index purchase_order_items_listing_idx
  on public.purchase_order_items (vendor_listing_id)
  where vendor_listing_id is not null;


-- =====================================================================
-- 6. Privileges
-- Supabase's default privileges grant ALL on every new public table to anon
-- and authenticated, leaving RLS as the only guard. Revoke that and grant
-- back only the columns each role may touch, so column-level rules (e.g. a
-- customer can't set quantity_fulfilled or pdf_url) hold even though RLS is
-- row-level only. service_role keeps full access for Digital Commerce.
-- =====================================================================
revoke all on table
  public.vendors, public.vendor_listings, public.customers,
  public.purchase_orders, public.purchase_order_items
from anon, authenticated;

-- Public marketplace reads. vendors.install_id is deliberately not exposed.
-- (Column-level grants mean API clients must name columns: select=id,business_name,...)
grant select (id, business_name, whatsapp_number, city, created_at)
  on public.vendors to anon, authenticated;
grant select on public.vendor_listings to anon, authenticated;

-- Customers: own profile.
grant select on public.customers to authenticated;
grant insert (id, email, full_name, phone) on public.customers to authenticated;
grant update (full_name, phone) on public.customers to authenticated;

-- Customers: own orders. Only `status` is updatable, and RLS limits that to
-- closing the order.
grant select on public.purchase_orders to authenticated;
grant insert (customer_id, vendor_id) on public.purchase_orders to authenticated;
grant update (status) on public.purchase_orders to authenticated;

-- Customers: lines on their own open orders. unit_price/currency come from
-- the trigger; quantity_fulfilled stays at its default.
grant select on public.purchase_order_items to authenticated;
grant insert (purchase_order_id, vendor_listing_id, item_name, quantity_requested, is_custom_request)
  on public.purchase_order_items to authenticated;


-- =====================================================================
-- 7. Row-level security
-- =====================================================================
alter table public.vendors              enable row level security;
alter table public.vendor_listings      enable row level security;
alter table public.customers            enable row level security;
alter table public.purchase_orders      enable row level security;
alter table public.purchase_order_items enable row level security;

-- ---- vendor_listings: public read of live listings only; no public writes ----
create policy "Public can read published, unexpired listings"
  on public.vendor_listings for select
  to anon, authenticated
  using (status = 'published' and expires_at > now());

-- ---- vendors: visible while they have a live listing, or to a customer
-- who has ordered from them (so old orders still show who the vendor is) ----
create policy "Public can read vendors with live listings"
  on public.vendors for select
  to anon, authenticated
  using (exists (
    select 1 from public.vendor_listings vl
     where vl.vendor_id = vendors.id
       and vl.status = 'published'
       and vl.expires_at > now()
  ));

create policy "Customers can read vendors they have ordered from"
  on public.vendors for select
  to authenticated
  using (exists (
    select 1 from public.purchase_orders po
     where po.vendor_id = vendors.id
       and po.customer_id = (select auth.uid())
  ));

-- ---- customers: own row only ----
create policy "Customers can read own profile"
  on public.customers for select
  to authenticated
  using (id = (select auth.uid()));

create policy "Customers can create own profile"
  on public.customers for insert
  to authenticated
  with check (
    id = (select auth.uid())
    and lower(email) = lower((select auth.jwt() ->> 'email'))
  );

create policy "Customers can update own profile"
  on public.customers for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---- purchase_orders: own orders only ----
create policy "Customers can read own purchase orders"
  on public.purchase_orders for select
  to authenticated
  using (customer_id = (select auth.uid()));

create policy "Customers can create own purchase orders"
  on public.purchase_orders for insert
  to authenticated
  with check (customer_id = (select auth.uid()) and status = 'sent');

create policy "Customers can close own purchase orders"
  on public.purchase_orders for update
  to authenticated
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()) and status = 'closed');

-- ---- purchase_order_items: lines on own orders only ----
create policy "Customers can read items on own purchase orders"
  on public.purchase_order_items for select
  to authenticated
  using (exists (
    select 1 from public.purchase_orders po
     where po.id = purchase_order_items.purchase_order_id
       and po.customer_id = (select auth.uid())
  ));

-- A listed line must point at a live listing from the SAME vendor the order
-- is addressed to; custom requests have no listing. Lines can only be added
-- while the order is still 'sent'.
create policy "Customers can add items to own open purchase orders"
  on public.purchase_order_items for insert
  to authenticated
  with check (
    exists (
      select 1 from public.purchase_orders po
       where po.id = purchase_order_items.purchase_order_id
         and po.customer_id = (select auth.uid())
         and po.status = 'sent'
    )
    and (
      purchase_order_items.is_custom_request
      or exists (
        select 1
          from public.vendor_listings vl
          join public.purchase_orders po on po.vendor_id = vl.vendor_id
         where vl.id = purchase_order_items.vendor_listing_id
           and po.id = purchase_order_items.purchase_order_id
           and vl.status = 'published'
           and vl.expires_at > now()
      )
    )
  );
