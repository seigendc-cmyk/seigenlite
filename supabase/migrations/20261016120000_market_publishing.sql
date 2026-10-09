-- =====================================================================
-- Market data packs sent to the Console + token-paid publishing (owner's
-- decisions, 2026-10-09, "go Publish-B"). Applied live only after the owner
-- has seen this file and said "apply".
-- Design: docs/marketing/market-publishing-design.md
-- Rollback: supabase/rollbacks/20261016120000_market_publishing.rollback.sql
-- Tested in PGlite: supabase/tests/market-publishing-test.js
--
-- 1. Tokens buy days of listing: cl_token_prices (price per token, days
--    per token, currency, welcome days, effective from; SysAdmin only),
--    seeded with the owner's first version: 1 token = 1 day, USD 1.00,
--    0 welcome days. cl_sell_tokens writes ONE Collections Ledger charge
--    (qty x price) and a cl_token_purchases row with the price snapshot.
--    A purchase is usable once paid: the account's money (payments - payment
--    reversals + untargeted credits) covers its charges OLDEST FIRST; a
--    credit against a charge reduces that charge (a fully credited token
--    sale is cancelled). An unpaid older licence holds up newer tokens.
--    Paying for tokens is an ordinary ledger payment, so the RPN commission
--    trigger (20261015120000) earns on it with no new code.
-- 2. Packs: the vendor's app sends a pack with phone-checked calls
--    (cl_device_pack_submit / _image / _status: install ID + phrase +
--    device key), resumable, one photo per call, never twice (pack_uid);
--    staff can also hand-upload a .scl (cl_market_upload_pack / _image).
--    Photos stay in cl_market_pack_images (no API access) until published.
-- 3. Publishing (the publish-pack Edge Function, with the staff member's own
--    token): cl_market_publish_prepare checks permission and paid days;
--    the function copies the ticked photos to the public listing-images
--    bucket; cl_market_publish_attach, in one transaction, uses the days,
--    replaces the account's live iTred listing (one iTred vendor per
--    business: its main till's install ID) with expires_at = the paid
--    expiry, and logs it. Republishing while live keeps the expiry (unused
--    days carry over); Extend adds days; Unpublish gives back unused whole
--    days. itred_set_listing_expiry now sets 7 days only when no expiry was
--    given (the old portal keeps its 7 days).
-- 4. Modules: market_review (queue, review, reject), market_publish
--    (publish, extend, unpublish), token_sales (sell tokens). Token prices:
--    SysAdmin only.
-- 5. The delete guards also count packs and token purchases.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_market_packs' n where to_regclass('public.cl_market_packs') is not null
    union all select 'table cl_token_prices' where to_regclass('public.cl_token_prices') is not null
    union all select 'column vendor_listings.thumb_url' where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendor_listings' and column_name = 'thumb_url')
    union all select 'module ' || k from unnest(array['market_review', 'market_publish', 'token_sales']) k where k in (select key from cl_modules)
  ) x;
  if conflicts is not null then raise exception 'market_publishing aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'function cl_rpn_staff (20261015120000)' n where to_regprocedure('public.cl_rpn_staff(text[])') is null
    union all select 'function cl_vendor_business (20261015120000)' where to_regprocedure('public.cl_vendor_business(uuid)') is null
    union all select 'function itred_set_listing_expiry' where to_regprocedure('public.itred_set_listing_expiry()') is null
    union all select 'table vendor_listings' where to_regclass('public.vendor_listings') is null
    union all select 'function extensions.digest' where to_regprocedure('extensions.digest(text,text)') is null
  ) x;
  if missing is not null then raise exception 'market_publishing aborted: missing %. Nothing was changed.', missing; end if;
end $$;

-- 1. Accounts ------------------------------------------------------------
-- The account of a device: its business (all its tills), else the device.
-- Every vendor row of an account:
create function public.cl_account_vendor_ids(p_business_id uuid, p_vendor_id uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select v.id from cl_vendors v
   where (p_business_id is not null and (v.business_id = p_business_id
            or exists (select 1 from cl_terminals t where t.install_id = v.install_id and t.business_id = p_business_id)))
      or (p_business_id is null and v.id = p_vendor_id)
$$;
-- The account's iTred identity: a business's main till (the device that
-- registered it), else the device itself.
create function public.cl_account_identity(p_business_id uuid, p_vendor_id uuid) returns public.cl_vendors
language sql stable security definer set search_path = public as $$
  select v.* from cl_vendors v
   where v.id = coalesce((select b.created_by_vendor_id from cl_businesses b where b.id = p_business_id), p_vendor_id)
$$;
create function public.cl_account_name(p_business_id uuid, p_vendor_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select b.name from cl_businesses b where b.id = p_business_id), (select v.business_name from cl_vendors v where v.id = p_vendor_id))
$$;

-- 2. Token prices --------------------------------------------------------
create table public.cl_token_prices (
  id              bigint generated always as identity primary key,
  price_per_token numeric(14,2) not null check (price_per_token > 0),
  days_per_token  integer not null check (days_per_token between 1 and 365),
  currency        text not null check (currency ~ '^[A-Z]{3}$'),
  welcome_days    integer not null default 0 check (welcome_days between 0 and 90),
  effective_from  timestamptz not null default now(),
  set_by          uuid references public.cl_staff(id),
  note            text,
  created_at      timestamptz not null default now()
);
insert into public.cl_token_prices (price_per_token, days_per_token, currency, welcome_days, effective_from, note)
values (1.00, 1, 'USD', 0, now(), 'Owner decision 2026-10-09: 1 token = 1 day of listing, USD 1.00; no welcome days');

create function public.cl_token_price_at(p_at timestamptz) returns public.cl_token_prices
language sql stable security definer set search_path = public as $$
  select * from cl_token_prices where effective_from <= p_at order by effective_from desc, id desc limit 1
$$;

-- 3. Token purchases and uses ----------------------------------------------
create table public.cl_token_purchases (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid references public.cl_businesses(id) on delete restrict,
  vendor_id        uuid references public.cl_vendors(id) on delete restrict,   -- the account, when it's a single device
  charge_vendor_id uuid not null references public.cl_vendors(id) on delete restrict,
  qty              integer not null check (qty between 1 and 10000),
  price_id         bigint not null references public.cl_token_prices(id) on delete restrict,
  unit_price       numeric(14,2) not null,
  days_per_token   integer not null,
  currency         text not null,
  amount           numeric(14,2) not null,
  ledger_entry_id  uuid not null unique references public.cl_ledger_entries(id) on delete restrict,
  note             text,
  sold_by          uuid references public.cl_staff(id),
  created_at       timestamptz not null default now(),
  constraint cl_token_purchases_account check ((business_id is null) <> (vendor_id is null))
);
create table public.cl_token_uses (
  id              bigint generated always as identity primary key,
  business_id     uuid references public.cl_businesses(id) on delete restrict,
  vendor_id       uuid references public.cl_vendors(id) on delete restrict,
  days            integer not null,            -- used (+) or given back / granted (-)
  kind            text not null check (kind in ('publish', 'extend', 'refund', 'welcome')),
  pack_id         uuid,
  itred_vendor_id uuid,
  note            text,
  created_by      uuid references public.cl_staff(id),
  created_at      timestamptz not null default now(),
  constraint cl_token_uses_account check ((business_id is null) <> (vendor_id is null))
);

-- The account's tokens: bought, paid (oldest charges first), used, available.
create function public.cl_token_balance_of(p_business_id uuid, p_vendor_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_pool numeric; v_cum numeric := 0; c record; v_paid uuid[] := '{}'; v_block text; v_purch jsonb := '[]';
        v_bought_t int := 0; v_bought_d int := 0; v_paid_t int := 0; v_paid_d int := 0; v_used int; p record; v_net numeric;
begin
  select coalesce(sum(case when entry_type = 'payment' then amount when entry_type = 'payment_reversal' then -amount
                           when entry_type = 'credit' and reverses_entry_id is null then amount else 0 end), 0)
    into v_pool from cl_ledger_entries where vendor_id in (select cl_account_vendor_ids(p_business_id, p_vendor_id));
  for c in
    select e.id, e.amount - coalesce((select sum(x.amount) from cl_ledger_entries x where x.entry_type = 'credit' and x.reverses_entry_id = e.id), 0) net,
           e.currency, e.notes, e.created_at
      from cl_ledger_entries e
     where e.entry_type = 'charge' and e.vendor_id in (select cl_account_vendor_ids(p_business_id, p_vendor_id))
     order by e.created_at, e.id
  loop
    continue when c.net <= 0;
    v_cum := v_cum + c.net;
    if v_cum <= v_pool + 0.005 then v_paid := v_paid || c.id;
    elsif v_block is null then
      v_block := c.currency || ' ' || to_char(c.net, 'FM999999990.00') || ' ' ||
        case when c.notes like 'Tokens:%' then 'for tokens' when c.notes like 'Auto-charged: licence%' then 'licence'
             when c.notes like 'Auto-charged: activation%' then 'activation code' else 'charge' end || ' unpaid';
    end if;
  end loop;
  for p in select * from cl_token_purchases t
            where (p_business_id is not null and t.business_id = p_business_id) or (p_business_id is null and t.vendor_id = p_vendor_id)
            order by t.created_at
  loop
    select p.amount - coalesce(sum(x.amount), 0) into v_net from cl_ledger_entries x where x.entry_type = 'credit' and x.reverses_entry_id = p.ledger_entry_id;
    v_purch := v_purch || jsonb_build_object('id', p.id, 'created_at', p.created_at, 'qty', p.qty, 'days', p.qty * p.days_per_token,
      'unit_price', p.unit_price, 'amount', p.amount, 'currency', p.currency,
      'state', case when v_net <= 0 then 'cancelled' when p.ledger_entry_id = any (v_paid) then 'paid' else 'unpaid' end);
    if v_net > 0 then
      v_bought_t := v_bought_t + p.qty; v_bought_d := v_bought_d + p.qty * p.days_per_token;
      if p.ledger_entry_id = any (v_paid) then v_paid_t := v_paid_t + p.qty; v_paid_d := v_paid_d + p.qty * p.days_per_token; end if;
    end if;
  end loop;
  select coalesce(sum(days), 0) into v_used from cl_token_uses u
   where (p_business_id is not null and u.business_id = p_business_id) or (p_business_id is null and u.vendor_id = p_vendor_id);
  return jsonb_build_object('bought_tokens', v_bought_t, 'bought_days', v_bought_d, 'paid_tokens', v_paid_t, 'paid_days', v_paid_d,
    'used_days', v_used, 'available_days', v_paid_d - v_used,
    'unpaid_tokens', v_bought_t - v_paid_t, 'blocked_by', case when v_bought_t > v_paid_t then v_block end, 'purchases', v_purch);
end $fn$;

-- 4. Packs ---------------------------------------------------------------
create table public.cl_market_packs (
  id               uuid primary key,              -- the pack_uid made on the device (or by the Console for a hand upload)
  business_id      uuid references public.cl_businesses(id) on delete restrict,
  vendor_id        uuid references public.cl_vendors(id) on delete restrict,   -- the account, when it's a single device
  device_vendor_id uuid not null references public.cl_vendors(id) on delete restrict,
  install_id       text not null,
  source           text not null check (source in ('app', 'console')),
  format_version   integer not null,
  export_no        text,
  header           jsonb not null,
  image_expected   integer not null default 0,
  image_received   integer not null default 0,
  status           text not null check (status in ('receiving', 'received', 'in_review', 'published', 'rejected', 'replaced', 'unpublished')),
  reason           text,
  created_by       uuid references public.cl_staff(id),
  created_at       timestamptz not null default now(),
  received_at      timestamptz,
  opened_by        uuid references public.cl_staff(id),
  opened_at        timestamptz,
  decided_by       uuid references public.cl_staff(id),
  decided_at       timestamptz,
  published_count  integer,
  itred_vendor_id  uuid,
  expires_at       timestamptz,
  constraint cl_market_packs_account check ((business_id is null) <> (vendor_id is null))
);
create index cl_market_packs_status_idx on public.cl_market_packs (status, created_at);
create table public.cl_market_pack_images (
  pack_id           uuid not null references public.cl_market_packs(id) on delete cascade,
  source_product_id text not null,
  sha256            text not null,
  image_webp        text not null,
  thumb_webp        text,
  created_at        timestamptz not null default now(),
  primary key (pack_id, source_product_id)
);

alter table public.vendor_listings add column thumb_url text, add column pack_id uuid;

-- Checks a pack header (JSON text, photos replaced by their sha256) and
-- answers it as jsonb, or raises a plain error.
create function public.cl_market_check_header(p_header text, p_header_sha256 text, p_install_id text) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare h jsonb; l jsonb; n integer; ids text[] := '{}'; sid text;
begin
  if p_header is null or length(p_header) > 600000 then raise exception 'The pack is too large or empty'; end if;
  if lower(coalesce(p_header_sha256, '')) <> encode(extensions.digest(p_header, 'sha256'), 'hex') then
    raise exception 'The pack arrived damaged. It will be sent again.';
  end if;
  begin h := p_header::jsonb; exception when others then raise exception 'The pack isn''t a seiGEN market pack'; end;
  if h->>'format' is distinct from 'seigen.market_export' or (h->>'format_version') not in ('1', '2') then
    raise exception 'The pack isn''t a seiGEN market pack';
  end if;
  if jsonb_typeof(h->'vendor') <> 'object' or btrim(coalesce(h->'vendor'->>'install_id', '')) <> p_install_id then
    raise exception 'The pack belongs to another device';
  end if;
  if jsonb_typeof(h->'listings') <> 'array' then raise exception 'The pack has no products'; end if;
  n := jsonb_array_length(h->'listings');
  if n = 0 then raise exception 'The pack has no products'; end if;
  if n > 200 then raise exception 'A pack holds at most 200 products (this one has %)', n; end if;
  for l in select * from jsonb_array_elements(h->'listings') loop
    sid := btrim(coalesce(l->>'source_product_id', ''));
    if sid = '' or length(sid) > 100 then raise exception 'A product has no ID'; end if;
    if sid = any (ids) then raise exception 'A product appears twice (%)', sid; end if;
    ids := ids || sid;
    if l->>'image_sha256' is not null and l->>'image_sha256' !~ '^[0-9a-f]{64}$' then raise exception 'The pack is damaged (photo list)'; end if;
  end loop;
  return h;
end $fn$;

-- What a listing would be refused for at publish (shown in review).
create function public.cl_market_listing_problem(l jsonb) returns text
language sql immutable as $$
  select case
    when btrim(coalesce(l->>'product_name', '')) = '' then 'no name'
    when length(l->>'product_name') > 200 then 'name too long'
    when (l->>'price') is null or (l->>'price') !~ '^[0-9]+(\.[0-9]+)?$' then 'bad price'
    when coalesce(l->>'currency', '') !~ '^[A-Z]{3}$' then 'bad currency'
    when (l->>'stock_quantity') is not null and (l->>'stock_quantity') !~ '^[0-9]+(\.[0-9]+)?$' then 'bad stock'
    else null end
$$;

-- Creates (or answers) a pack. Shared by the device and the hand upload.
create function public.cl_market_pack_open(p_pack_uid uuid, p_device cl_vendors, p_header jsonb, p_source text, p_staff uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare k cl_market_packs%rowtype; v_biz uuid := cl_vendor_business(p_device.id); v_exp integer;
begin
  perform pg_advisory_xact_lock(hashtext('cl_market_pack:' || p_pack_uid::text));
  select * into k from cl_market_packs where id = p_pack_uid;
  if found then
    if k.device_vendor_id <> p_device.id then raise exception 'That pack ID belongs to another device'; end if;
  else
    select count(*) into v_exp from jsonb_array_elements(p_header->'listings') l where l->>'image_sha256' is not null;
    -- a newer pack replaces the account's undecided ones
    update cl_market_packs set status = 'replaced', decided_at = now()
     where status in ('receiving', 'received', 'in_review')
       and ((v_biz is not null and business_id = v_biz) or (v_biz is null and vendor_id = p_device.id));
    insert into cl_market_packs (id, business_id, vendor_id, device_vendor_id, install_id, source, format_version, export_no, header,
                                 image_expected, status, created_by, received_at)
    values (p_pack_uid, v_biz, case when v_biz is null then p_device.id end, p_device.id, p_device.install_id, p_source,
            (p_header->>'format_version')::int, left(p_header->>'export_no', 40), p_header, v_exp,
            case when v_exp = 0 then 'received' else 'receiving' end, p_staff, case when v_exp = 0 then now() end)
    returning * into k;
  end if;
  return jsonb_build_object('pack_uid', k.id, 'status', k.status,
    'missing', coalesce((select jsonb_agg(l->>'source_product_id') from jsonb_array_elements(k.header->'listings') l
                          where l->>'image_sha256' is not null
                            and not exists (select 1 from cl_market_pack_images i where i.pack_id = k.id and i.source_product_id = l->>'source_product_id')), '[]'::jsonb));
end $fn$;

create function public.cl_market_pack_put_image(p_pack_uid uuid, p_device_vendor uuid, p_source_product_id text, p_image text, p_thumb text) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare k cl_market_packs%rowtype; v_sha text; v_head bytea;
begin
  perform pg_advisory_xact_lock(hashtext('cl_market_pack:' || p_pack_uid::text));
  select * into k from cl_market_packs where id = p_pack_uid for update;
  if not found or (p_device_vendor is not null and k.device_vendor_id <> p_device_vendor) then raise exception 'No such pack on this device'; end if;
  if k.status not in ('receiving', 'received') then raise exception 'That pack was already %', k.status; end if;
  select l->>'image_sha256' into v_sha from jsonb_array_elements(k.header->'listings') l where l->>'source_product_id' = p_source_product_id;
  if v_sha is null then raise exception 'That product has no photo in the pack'; end if;
  if p_image is null or left(p_image, 23) <> 'data:image/webp;base64,' or length(p_image) > 150000 then raise exception 'A photo is too large or isn''t a WebP image'; end if;
  if encode(extensions.digest(p_image, 'sha256'), 'hex') <> v_sha then raise exception 'A photo arrived damaged. It will be sent again.'; end if;
  begin v_head := decode(substr(p_image, 24, 24), 'base64'); exception when others then raise exception 'A photo isn''t a WebP image'; end;
  if length(v_head) < 12 or substring(v_head from 1 for 4) <> 'RIFF'::bytea or substring(v_head from 9 for 4) <> 'WEBP'::bytea then
    raise exception 'A photo isn''t a WebP image';
  end if;
  if p_thumb is not null and (left(p_thumb, 23) <> 'data:image/webp;base64,' or length(p_thumb) > 20000) then raise exception 'A thumbnail is too large or isn''t a WebP image'; end if;
  insert into cl_market_pack_images (pack_id, source_product_id, sha256, image_webp, thumb_webp)
  values (p_pack_uid, p_source_product_id, v_sha, p_image, p_thumb)
  on conflict (pack_id, source_product_id) do nothing;
  update cl_market_packs set image_received = (select count(*) from cl_market_pack_images where pack_id = p_pack_uid) where id = p_pack_uid returning * into k;
  if k.status = 'receiving' and k.image_received >= k.image_expected then
    update cl_market_packs set status = 'received', received_at = now() where id = p_pack_uid returning * into k;
  end if;
  return jsonb_build_object('pack_uid', k.id, 'status', k.status, 'received', k.image_received, 'expected', k.image_expected);
end $fn$;

-- 5. Device calls (install ID + phrase + device key) --------------------------
create function public.cl_device_pack_submit(p_install_id text, p_secret_phrase text, p_device_key text,
                                             p_pack_uid uuid, p_header text, p_header_sha256 text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  return cl_market_pack_open(p_pack_uid, v, cl_market_check_header(p_header, p_header_sha256, p_install_id), 'app', null)::json;
end $fn$;

create function public.cl_device_pack_image(p_install_id text, p_secret_phrase text, p_device_key text,
                                            p_pack_uid uuid, p_source_product_id text, p_image_webp text, p_thumb_webp text default null) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  return cl_market_pack_put_image(p_pack_uid, v.id, p_source_product_id, p_image_webp, p_thumb_webp)::json;
end $fn$;

-- The account's packs, newest first, as the app shows them.
create function public.cl_device_pack_status(p_install_id text, p_secret_phrase text, p_device_key text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; v_biz uuid;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  v_biz := cl_vendor_business(v.id);
  return coalesce((select json_agg(json_build_object('pack_uid', k.id, 'export_no', k.export_no, 'from_this_device', k.device_vendor_id = v.id,
            'status', case when k.status = 'published' and k.expires_at <= now() then 'expired' else k.status end,
            'reason', k.reason, 'received', k.image_received, 'expected', k.image_expected,
            'published_count', k.published_count, 'expires_at', k.expires_at, 'created_at', k.created_at) order by k.created_at desc)
          from (select * from cl_market_packs k where (v_biz is not null and k.business_id = v_biz) or (v_biz is null and k.vendor_id = v.id)
                 order by k.created_at desc limit 10) k), '[]'::json);
end $fn$;

-- 6. Staff: tokens --------------------------------------------------------
create function public.cl_token_price_set(p_price_per_token numeric, p_days_per_token integer, p_currency text,
                                          p_welcome_days integer default 0, p_effective_from timestamptz default null, p_note text default null) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_acting_staff(); v_from timestamptz := coalesce(p_effective_from, now()); r cl_token_prices%rowtype;
begin
  if v_staff is null or not exists (select 1 from cl_staff where id = v_staff and active) or not cl_jwt_is_sysadmin() then
    raise exception 'Not authorized: only a SysAdmin can set the token price' using errcode = '42501';
  end if;
  if p_price_per_token is null or p_price_per_token <= 0 then raise exception 'The token price must be more than 0'; end if;
  if p_days_per_token is null or p_days_per_token < 1 or p_days_per_token > 365 then raise exception 'Days per token: 1 to 365'; end if;
  if coalesce(p_welcome_days, 0) < 0 or coalesce(p_welcome_days, 0) > 90 then raise exception 'Welcome days: 0 to 90'; end if;
  if upper(btrim(coalesce(p_currency, ''))) !~ '^[A-Z]{3}$' then raise exception 'Give a 3-letter currency, e.g. USD'; end if;
  if v_from < now() - interval '5 minutes' then raise exception 'A price can''t start in the past: tokens already sold keep their price'; end if;
  perform pg_advisory_xact_lock(hashtext('cl_token_price_set'));
  select * into r from cl_token_prices where price_per_token = p_price_per_token and days_per_token = p_days_per_token and welcome_days = coalesce(p_welcome_days, 0)
     and set_by = v_staff and created_at > now() - interval '30 seconds' order by id desc limit 1;
  if found then return json_build_object('price', row_to_json(r), 'duplicate', true); end if;
  insert into cl_token_prices (price_per_token, days_per_token, currency, welcome_days, effective_from, set_by, note)
  values (round(p_price_per_token, 2), p_days_per_token, upper(btrim(p_currency)), coalesce(p_welcome_days, 0), v_from, v_staff, nullif(btrim(coalesce(p_note, '')), ''))
  returning * into r;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'token_price_set', 'cl_token_prices', null, jsonb_build_object('price_id', r.id, 'price_per_token', r.price_per_token,
          'days_per_token', r.days_per_token, 'currency', r.currency, 'welcome_days', r.welcome_days, 'effective_from', r.effective_from));
  return json_build_object('price', row_to_json(r));
end $fn$;

create function public.cl_token_prices_list() returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['token_sales', 'market_review', 'market_publish', 'collections_ledger']);
  return json_build_object('current_id', (cl_token_price_at(now())).id,
    'prices', coalesce((select json_agg(json_build_object('id', p.id, 'price_per_token', p.price_per_token, 'days_per_token', p.days_per_token,
               'currency', p.currency, 'welcome_days', p.welcome_days, 'effective_from', p.effective_from, 'set_by', coalesce(s.full_name, 'set up'),
               'note', p.note, 'upcoming', p.effective_from > now()) order by p.effective_from desc, p.id desc)
             from cl_token_prices p left join cl_staff s on s.id = p.set_by), '[]'::json));
end $fn$;

-- Resolves (business | device) for a staff call; a till of a business is refused.
create function public.cl_market_account(p_business_id uuid, p_vendor_id uuid) returns uuid
language plpgsql stable security definer set search_path = public as $fn$
declare v_biz uuid;
begin
  if (p_business_id is null) = (p_vendor_id is null) then raise exception 'Give either a business or a device'; end if;
  if p_business_id is not null then
    if not exists (select 1 from cl_businesses where id = p_business_id) then raise exception 'No such business'; end if;
    return p_business_id;
  end if;
  if not exists (select 1 from cl_vendors where id = p_vendor_id) then raise exception 'No such vendor'; end if;
  v_biz := cl_vendor_business(p_vendor_id);
  if v_biz is not null then raise exception 'This device is a till of "%". Use the business.', (select name from cl_businesses where id = v_biz); end if;
  return null;
end $fn$;

create function public.cl_sell_tokens(p_business_id uuid, p_vendor_id uuid, p_qty integer, p_note text default null) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['token_sales']); v_price cl_token_prices%rowtype; v_charge_vendor uuid; v_amount numeric;
        e cl_ledger_entries%rowtype; p cl_token_purchases%rowtype; v_name text;
begin
  perform cl_market_account(p_business_id, p_vendor_id);
  if p_qty is null or p_qty < 1 or p_qty > 10000 then raise exception 'Sell 1 to 10000 tokens'; end if;
  v_price := cl_token_price_at(now());
  if v_price.id is null then raise exception 'Token price not set yet'; end if;
  v_charge_vendor := coalesce((select created_by_vendor_id from cl_businesses where id = p_business_id), p_vendor_id);
  v_name := cl_account_name(p_business_id, p_vendor_id);
  perform pg_advisory_xact_lock(hashtext('cl_sell_tokens:' || coalesce(p_business_id, p_vendor_id)::text));
  select * into p from cl_token_purchases where business_id is not distinct from p_business_id and vendor_id is not distinct from (case when p_business_id is null then p_vendor_id end)
     and qty = p_qty and sold_by = v_staff and created_at > now() - interval '30 seconds' order by created_at desc limit 1;
  if found then return json_build_object('purchase', row_to_json(p), 'duplicate', true); end if;
  v_amount := round(p_qty * v_price.price_per_token, 2);
  insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes, recorded_by)
  values (v_charge_vendor, 'charge', v_amount, v_price.currency,
          'Tokens: ' || p_qty || ' × ' || v_price.currency || ' ' || to_char(v_price.price_per_token, 'FM999999990.00') || ' (' || (p_qty * v_price.days_per_token) || ' days of listing)'
            || coalesce(' — ' || nullif(btrim(coalesce(p_note, '')), ''), ''), v_staff)
  returning * into e;
  insert into cl_token_purchases (business_id, vendor_id, charge_vendor_id, qty, price_id, unit_price, days_per_token, currency, amount, ledger_entry_id, note, sold_by)
  values (p_business_id, case when p_business_id is null then p_vendor_id end, v_charge_vendor, p_qty, v_price.id, v_price.price_per_token, v_price.days_per_token,
          v_price.currency, v_amount, e.id, nullif(btrim(coalesce(p_note, '')), ''), v_staff)
  returning * into p;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'sell_tokens', 'cl_token_purchases', null, jsonb_build_object('purchase_id', p.id, 'account', v_name, 'qty', p_qty,
          'amount', v_amount, 'currency', v_price.currency, 'days', p_qty * v_price.days_per_token, 'ledger_entry_id', e.id));
  return json_build_object('purchase', row_to_json(p), 'ledger_entry', row_to_json(e));
end $fn$;

create function public.cl_token_balance(p_business_id uuid, p_vendor_id uuid) returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['token_sales', 'market_review', 'market_publish', 'collections_ledger']);
  perform cl_market_account(p_business_id, p_vendor_id);
  return (cl_token_balance_of(p_business_id, case when p_business_id is null then p_vendor_id end)
          || jsonb_build_object('account', cl_account_name(p_business_id, p_vendor_id)))::json;
end $fn$;

-- 7. Staff: the queue, review, reject, hand upload ---------------------------------
create function public.cl_market_queue(p_status text default null) returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['market_review', 'market_publish', 'token_sales']);
  return coalesce((select json_agg(x order by x.created_at desc) from (
    select k.id, k.status, k.export_no, k.source, k.format_version, k.install_id, k.business_id, k.vendor_id,
           cl_account_name(k.business_id, k.vendor_id) account, (k.header->'vendor'->>'city') city,
           (select r.full_name from cl_rpn r where r.id = cl_rpn_of_vendor(k.device_vendor_id)) rpn,
           (select r.id from cl_rpn r where r.id = cl_rpn_of_vendor(k.device_vendor_id)) rpn_id,
           jsonb_array_length(k.header->'listings') products, k.image_received, k.image_expected, k.reason,
           k.created_at, k.received_at, k.decided_at, k.expires_at, k.published_count,
           (cl_token_balance_of(k.business_id, k.vendor_id)->>'available_days')::int available_days
      from cl_market_packs k
     where (p_status is null and k.status in ('receiving', 'received', 'in_review')) or k.status = p_status
     order by k.created_at desc limit 300) x), '[]'::json);
end $fn$;

-- One pack for review (no photos; thumbnails come page by page). Opening a
-- received pack puts it in review.
create function public.cl_market_pack_detail(p_pack_id uuid) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['market_review', 'market_publish']); k cl_market_packs%rowtype; v_live record;
begin
  select * into k from cl_market_packs where id = p_pack_id;
  if not found then raise exception 'No such pack'; end if;
  if k.status = 'received' then
    update cl_market_packs set status = 'in_review', opened_by = v_staff, opened_at = now() where id = k.id returning * into k;
  end if;
  select count(*) n, max(l.expires_at) exp into v_live from vendor_listings l join vendors iv on iv.id = l.vendor_id
   where iv.install_id = (cl_account_identity(k.business_id, k.vendor_id)).install_id and l.status = 'published' and l.expires_at > now();
  return json_build_object('pack', json_build_object('id', k.id, 'status', k.status, 'reason', k.reason, 'export_no', k.export_no, 'source', k.source,
      'format_version', k.format_version, 'install_id', k.install_id, 'created_at', k.created_at, 'received_at', k.received_at,
      'image_received', k.image_received, 'image_expected', k.image_expected, 'business_id', k.business_id, 'vendor_id', k.vendor_id,
      'account', cl_account_name(k.business_id, k.vendor_id), 'vendor', k.header->'vendor', 'expires_at', k.expires_at),
    'items', coalesce((select json_agg(json_build_object('source_product_id', l->>'source_product_id', 'product_name', l->>'product_name',
               'price', l->'price', 'currency', l->>'currency', 'category', l->>'category', 'stock_quantity', l->'stock_quantity',
               'has_image', i.pack_id is not null, 'has_thumb', i.thumb_webp is not null,
               'problem', coalesce(cl_market_listing_problem(l), case when l->>'image_sha256' is not null and i.pack_id is null then 'photo missing' end)) order by o.n)
             from jsonb_array_elements(k.header->'listings') with ordinality o(l, n)
             left join cl_market_pack_images i on i.pack_id = k.id and i.source_product_id = l->>'source_product_id'), '[]'::json),
    'balance', cl_token_balance_of(k.business_id, k.vendor_id),
    'live', json_build_object('products', v_live.n, 'expires_at', v_live.exp));
end $fn$;

create function public.cl_market_pack_thumbs(p_pack_id uuid, p_offset integer default 0, p_limit integer default 50) returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['market_review', 'market_publish']);
  return coalesce((select json_agg(json_build_object('source_product_id', x.source_product_id, 'thumb', coalesce(x.thumb_webp, x.image_webp))) from (
    select i.* from cl_market_pack_images i where i.pack_id = p_pack_id order by i.source_product_id
     offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 50), 1), 100)) x), '[]'::json);
end $fn$;

create function public.cl_market_reject(p_pack_id uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['market_review', 'market_publish']); v_reason text := cl_rpn_reason(p_reason); k cl_market_packs%rowtype;
begin
  select * into k from cl_market_packs where id = p_pack_id for update;
  if not found then raise exception 'No such pack'; end if;
  if k.status not in ('receiving', 'received', 'in_review') then raise exception 'That pack was already %', k.status; end if;
  update cl_market_packs set status = 'rejected', reason = v_reason, decided_by = v_staff, decided_at = now() where id = p_pack_id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'market_pack_rejected', 'cl_market_packs', null, jsonb_build_object('pack_id', p_pack_id, 'account', cl_account_name(k.business_id, k.vendor_id), 'reason', v_reason));
  return json_build_object('id', p_pack_id, 'status', 'rejected');
end $fn$;

create function public.cl_market_upload_pack(p_pack_uid uuid, p_header text, p_header_sha256 text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['market_review', 'market_publish']); h jsonb; v cl_vendors%rowtype; r jsonb;
begin
  begin h := p_header::jsonb; exception when others then raise exception 'That file isn''t a seiGEN market pack'; end;
  select * into v from cl_vendors where install_id = btrim(coalesce(h->'vendor'->>'install_id', ''));
  if not found then raise exception 'The pack''s install ID (%) isn''t a registered device. Nothing was uploaded.', coalesce(h->'vendor'->>'install_id', '—'); end if;
  r := cl_market_pack_open(p_pack_uid, v, cl_market_check_header(p_header, p_header_sha256, v.install_id), 'console', v_staff);
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'market_pack_uploaded', 'cl_market_packs', null, jsonb_build_object('pack_id', p_pack_uid, 'install_id', v.install_id, 'export_no', h->>'export_no'));
  return r::json;
end $fn$;

create function public.cl_market_upload_image(p_pack_uid uuid, p_source_product_id text, p_image_webp text, p_thumb_webp text default null) returns json
language plpgsql security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['market_review', 'market_publish']);
  if not exists (select 1 from cl_market_packs where id = p_pack_uid and source = 'console') then raise exception 'No such uploaded pack'; end if;
  return cl_market_pack_put_image(p_pack_uid, null, p_source_product_id, p_image_webp, p_thumb_webp)::json;
end $fn$;

-- 8. Staff: publishing (called by the publish-pack Edge Function with the staff token) --
-- The days a publish needs, and what the listing would expire on.
create function public.cl_market_plan(k cl_market_packs, p_days integer) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_ident cl_vendors%rowtype := cl_account_identity(k.business_id, k.vendor_id); v_exp timestamptz; v_bal jsonb; v_welcome int := 0; v_price cl_token_prices%rowtype;
begin
  if p_days is null or p_days < 0 or p_days > 3650 then raise exception 'Days: 0 to 3650'; end if;
  select max(l.expires_at) into v_exp from vendor_listings l join vendors iv on iv.id = l.vendor_id
   where iv.install_id = v_ident.install_id and l.status = 'published' and l.expires_at > now();
  if v_exp is null and p_days < 1 then raise exception 'Choose how many days to list for (at least 1)'; end if;
  v_bal := cl_token_balance_of(k.business_id, k.vendor_id);
  v_price := cl_token_price_at(now());
  if coalesce(v_price.welcome_days, 0) > 0 and not exists (select 1 from cl_token_uses u where u.kind = 'welcome'
       and ((k.business_id is not null and u.business_id = k.business_id) or (k.business_id is null and u.vendor_id = k.vendor_id))) then
    v_welcome := v_price.welcome_days;
  end if;
  return jsonb_build_object('itred_install_id', v_ident.install_id, 'live_until', v_exp, 'days', p_days,
    'available_days', (v_bal->>'available_days')::int + v_welcome, 'welcome_days', v_welcome,
    'expires_at', coalesce(v_exp, now()) + make_interval(days => p_days), 'balance', v_bal);
end $fn$;

create function public.cl_market_publish_prepare(p_pack_id uuid, p_days integer, p_items text[]) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['market_publish']); k cl_market_packs%rowtype; v_plan jsonb; v_bad text; v_items jsonb;
begin
  select * into k from cl_market_packs where id = p_pack_id;
  if not found then raise exception 'No such pack'; end if;
  if k.status not in ('received', 'in_review') then
    raise exception '%', case when k.status = 'receiving' then 'That pack is still arriving (' || k.image_received || ' of ' || k.image_expected || ' photos)' else 'That pack was already ' || k.status end;
  end if;
  if p_items is null or cardinality(p_items) = 0 then raise exception 'Tick at least one product'; end if;
  select string_agg(i, ', ') into v_bad from unnest(p_items) i
   where not exists (select 1 from jsonb_array_elements(k.header->'listings') l where l->>'source_product_id' = i);
  if v_bad is not null then raise exception 'Not in this pack: %', v_bad; end if;
  select string_agg((l->>'product_name') || ' (' || cl_market_listing_problem(l) || ')', ', ') into v_bad
    from jsonb_array_elements(k.header->'listings') l where l->>'source_product_id' = any (p_items) and cl_market_listing_problem(l) is not null;
  if v_bad is not null then raise exception 'Untick the products with problems: %', v_bad; end if;
  v_plan := cl_market_plan(k, p_days);
  if (v_plan->>'available_days')::int < p_days then
    raise exception 'Not enough paid listing days: % paid and unused, % needed.%', greatest((v_plan->>'available_days')::int, 0), p_days,
      coalesce(' ' || (v_plan->'balance'->>'blocked_by') || '.', ' Sell tokens and record the payment first.');
  end if;
  select jsonb_agg(jsonb_build_object('source_product_id', l->>'source_product_id', 'sha256', i.sha256, 'has_thumb', i.thumb_webp is not null))
    into v_items from jsonb_array_elements(k.header->'listings') l
    join cl_market_pack_images i on i.pack_id = k.id and i.source_product_id = l->>'source_product_id'
   where l->>'source_product_id' = any (p_items);
  return (v_plan || jsonb_build_object('pack_id', k.id, 'photos', coalesce(v_items, '[]'::jsonb)))::json;
end $fn$;

create function public.cl_market_pack_image_data(p_pack_id uuid, p_source_product_id text) returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['market_publish']);
  return (select json_build_object('sha256', i.sha256, 'image', i.image_webp, 'thumb', i.thumb_webp)
            from cl_market_pack_images i where i.pack_id = p_pack_id and i.source_product_id = p_source_product_id);
end $fn$;

create function public.cl_market_publish_attach(p_pack_id uuid, p_days integer, p_items text[], p_urls jsonb) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['market_publish']); k cl_market_packs%rowtype; v_plan jsonb; v_ident cl_vendors%rowtype;
        v_iv uuid; v_exp timestamptz; v_n integer; l jsonb; u jsonb; v_old integer;
begin
  perform pg_advisory_xact_lock(hashtext('cl_market_pack:' || p_pack_id::text));
  select * into k from cl_market_packs where id = p_pack_id for update;
  if not found then raise exception 'No such pack'; end if;
  if k.status = 'published' then return json_build_object('pack_id', k.id, 'status', 'published', 'expires_at', k.expires_at, 'published', k.published_count, 'duplicate', true); end if;
  perform cl_market_publish_prepare(p_pack_id, p_days, p_items);
  perform pg_advisory_xact_lock(hashtext('cl_market_account:' || coalesce(k.business_id, k.vendor_id)::text));
  v_plan := cl_market_plan(k, p_days);
  v_ident := cl_account_identity(k.business_id, k.vendor_id);
  v_exp := (v_plan->>'expires_at')::timestamptz;
  if (v_plan->>'welcome_days')::int > 0 then
    insert into cl_token_uses (business_id, vendor_id, days, kind, pack_id, note, created_by)
    values (k.business_id, k.vendor_id, -(v_plan->>'welcome_days')::int, 'welcome', k.id, 'Welcome days', v_staff);
  end if;
  if p_days > 0 then
    insert into cl_token_uses (business_id, vendor_id, days, kind, pack_id, note, created_by)
    values (k.business_id, k.vendor_id, p_days, 'publish', k.id, 'Published ' || coalesce(k.export_no, 'pack'), v_staff);
  end if;
  -- the iTred vendor: one per business (its main till's install ID)
  insert into vendors (install_id, business_name, whatsapp_number, city)
  values (v_ident.install_id, cl_account_name(k.business_id, k.vendor_id), nullif(btrim(coalesce(k.header->'vendor'->>'whatsapp_number', '')), ''),
          nullif(btrim(coalesce(k.header->'vendor'->>'city', '')), ''))
  on conflict (install_id) do update set business_name = excluded.business_name,
    whatsapp_number = coalesce(excluded.whatsapp_number, vendors.whatsapp_number), city = coalesce(excluded.city, vendors.city)
  returning id into v_iv;
  -- replace the whole live listing
  update vendor_listings set status = 'expired', expires_at = least(expires_at, now())
   where vendor_id = v_iv and status = 'published' and expires_at > now();
  get diagnostics v_old = row_count;
  update cl_market_packs set status = 'replaced', decided_at = coalesce(decided_at, now())
   where status = 'published' and id <> k.id and ((k.business_id is not null and business_id = k.business_id) or (k.business_id is null and vendor_id = k.vendor_id));
  v_n := 0;
  for l in select x from jsonb_array_elements(k.header->'listings') x where x->>'source_product_id' = any (p_items) loop
    u := p_urls->(l->>'source_product_id');
    insert into vendor_listings (vendor_id, source_product_id, product_name, price, currency, category, stock_quantity, image_url, thumb_url,
                                 exported_at, published_at, expires_at, status, pack_id)
    values (v_iv, l->>'source_product_id', btrim(l->>'product_name'), (l->>'price')::numeric, l->>'currency', nullif(btrim(coalesce(l->>'category', '')), ''),
            coalesce((l->>'stock_quantity')::numeric, 0), u->>'image_url', u->>'thumb_url',
            coalesce((l->>'exported_at')::timestamptz, k.created_at), now(), v_exp, 'published', k.id);
    v_n := v_n + 1;
  end loop;
  update cl_market_packs set status = 'published', decided_by = v_staff, decided_at = now(), published_count = v_n, itred_vendor_id = v_iv, expires_at = v_exp
   where id = k.id returning * into k;
  -- photos of packs decided over 30 days ago are no longer needed
  delete from cl_market_pack_images i using cl_market_packs d
   where d.id = i.pack_id and d.status in ('rejected', 'replaced', 'unpublished', 'published') and d.decided_at < now() - interval '30 days';
  perform itred_expire_vendor_listings();
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'market_published', 'cl_market_packs', null, jsonb_build_object('pack_id', k.id, 'account', cl_account_name(k.business_id, k.vendor_id),
          'products', v_n, 'days_used', p_days, 'expires_at', v_exp, 'replaced_live', v_old));
  return json_build_object('pack_id', k.id, 'status', 'published', 'published', v_n, 'days_used', p_days, 'expires_at', v_exp,
    'available_after', (cl_token_balance_of(k.business_id, k.vendor_id)->>'available_days')::int);
end $fn$;

-- The live listing of an account (its latest published pack).
create function public.cl_market_live_pack(p_itred_vendor_id uuid) returns public.cl_market_packs
language sql stable security definer set search_path = public as $$
  select * from cl_market_packs where itred_vendor_id = p_itred_vendor_id and status = 'published' and expires_at > now()
   order by decided_at desc limit 1
$$;

create function public.cl_market_extend(p_itred_vendor_id uuid, p_days integer, p_note text default null) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['market_publish']); k cl_market_packs%rowtype; v_plan jsonb; v_exp timestamptz;
begin
  if p_days is null or p_days < 1 or p_days > 3650 then raise exception 'Extend by 1 to 3650 days'; end if;
  k := cl_market_live_pack(p_itred_vendor_id);
  if k.id is null then raise exception 'That vendor has no live listing. Publish a pack instead.'; end if;
  perform pg_advisory_xact_lock(hashtext('cl_market_account:' || coalesce(k.business_id, k.vendor_id)::text));
  v_plan := cl_market_plan(k, p_days);
  if (v_plan->>'available_days')::int < p_days then
    raise exception 'Not enough paid listing days: % paid and unused, % needed.%', greatest((v_plan->>'available_days')::int, 0), p_days,
      coalesce(' ' || (v_plan->'balance'->>'blocked_by') || '.', ' Sell tokens and record the payment first.');
  end if;
  if (v_plan->>'welcome_days')::int > 0 then
    insert into cl_token_uses (business_id, vendor_id, days, kind, pack_id, note, created_by)
    values (k.business_id, k.vendor_id, -(v_plan->>'welcome_days')::int, 'welcome', k.id, 'Welcome days', v_staff);
  end if;
  v_exp := (v_plan->>'expires_at')::timestamptz;
  insert into cl_token_uses (business_id, vendor_id, days, kind, pack_id, itred_vendor_id, note, created_by)
  values (k.business_id, k.vendor_id, p_days, 'extend', k.id, p_itred_vendor_id, nullif(btrim(coalesce(p_note, '')), ''), v_staff);
  update vendor_listings set expires_at = v_exp where vendor_id = p_itred_vendor_id and status = 'published' and expires_at > now();
  update cl_market_packs set expires_at = v_exp where id = k.id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'market_extended', 'cl_market_packs', null, jsonb_build_object('pack_id', k.id, 'account', cl_account_name(k.business_id, k.vendor_id), 'days', p_days, 'expires_at', v_exp));
  return json_build_object('pack_id', k.id, 'expires_at', v_exp, 'days_used', p_days);
end $fn$;

-- Takes the listing off now and gives back the unused whole days.
create function public.cl_market_unpublish(p_itred_vendor_id uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_rpn_staff(array['market_publish']); v_reason text := cl_rpn_reason(p_reason); k cl_market_packs%rowtype; v_back integer;
begin
  k := cl_market_live_pack(p_itred_vendor_id);
  if k.id is null then raise exception 'That vendor has no live listing'; end if;
  perform pg_advisory_xact_lock(hashtext('cl_market_account:' || coalesce(k.business_id, k.vendor_id)::text));
  v_back := greatest(floor(extract(epoch from (k.expires_at - now())) / 86400)::int, 0);
  update vendor_listings set status = 'expired', expires_at = now() where vendor_id = p_itred_vendor_id and status = 'published' and expires_at > now();
  update cl_market_packs set status = 'unpublished', reason = v_reason, expires_at = now() where id = k.id;
  if v_back > 0 then
    insert into cl_token_uses (business_id, vendor_id, days, kind, pack_id, itred_vendor_id, note, created_by)
    values (k.business_id, k.vendor_id, -v_back, 'refund', k.id, p_itred_vendor_id, v_reason, v_staff);
  end if;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'market_unpublished', 'cl_market_packs', null, jsonb_build_object('pack_id', k.id, 'account', cl_account_name(k.business_id, k.vendor_id), 'days_back', v_back, 'reason', v_reason));
  return json_build_object('pack_id', k.id, 'days_back', v_back);
end $fn$;

create function public.cl_market_published() returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['market_review', 'market_publish', 'token_sales']);
  return coalesce((select json_agg(x order by x.expires_at) from (
    select k.itred_vendor_id, k.id pack_id, k.business_id, k.vendor_id, cl_account_name(k.business_id, k.vendor_id) account, k.export_no,
           (select count(*) from vendor_listings l where l.vendor_id = k.itred_vendor_id and l.status = 'published' and l.expires_at > now()) products,
           k.decided_at published_at, k.expires_at,
           (cl_token_balance_of(k.business_id, k.vendor_id)->>'available_days')::int available_days
      from cl_market_packs k where k.status = 'published' and k.expires_at > now()) x), '[]'::json);
end $fn$;

-- 9. The 7-day default only when no expiry was given --------------------------
create or replace function public.itred_set_listing_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- 20261016120000: a publish from the Console sets expires_at itself (the
  -- paid days); anything that doesn't (the old portal) still gets 7 days.
  if new.published_at is not null and new.expires_at is null
     and (tg_op = 'INSERT' or new.published_at is distinct from old.published_at) then
    new.expires_at := new.published_at + interval '7 days';
  end if;
  return new;
end;
$$;

-- 10. Modules --------------------------------------------------------------
insert into public.cl_modules (key, label, description, sort_order) values
  ('market_review', 'Market Review', 'See market packs sent by vendors, review them, reject with a reason', 47),
  ('market_publish', 'Market Publishing', 'Publish packs to the iTred Market Place, extend and unpublish listings', 48),
  ('token_sales', 'Token Sales', 'Sell listing tokens to vendors (a Collections Ledger charge)', 49);

-- 11. Delete guards ---------------------------------------------------------
create or replace function public.cl_vendor_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare parts text[] := '{}'; n integer;
begin
  select count(*) into n from cl_ledger_entries where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' ledger entr' || case when n = 1 then 'y' else 'ies' end); end if;
  select count(*) into n from cl_licences where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' licence' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_activation_codes where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' activation code' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_vendor_messages where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' billing message' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_terminals where vendor_id = old.id or install_id = old.install_id;
  if n > 0 then parts := parts || (n || ' till' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_plan_assignments where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' price-plan setting' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_businesses where created_by_vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' business' || case when n = 1 then '' else 'es' end || ' it created'); end if;
  select count(*) into n from vendors where install_id = old.install_id;
  if n > 0 then parts := parts || ('an iTred Market Place listing account'::text); end if;
  -- RPN commissions (20261015120000)
  select count(*) into n from cl_rpn_commissions where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN commission line' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_rpn_assignments where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN history entr' || case when n = 1 then 'y' else 'ies' end); end if;
  -- Market publishing (20261016120000)
  select count(*) into n from cl_market_packs where device_vendor_id = old.id or vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' market pack' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_token_purchases where vendor_id = old.id or charge_vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' token purchase' || case when n = 1 then '' else 's' end); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead (Console → Vendors → Archive). Nothing was deleted.',
      old.business_name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

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
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

-- 12. Grants -------------------------------------------------------------
alter table public.cl_token_prices enable row level security;
alter table public.cl_token_purchases enable row level security;
alter table public.cl_token_uses enable row level security;
alter table public.cl_market_packs enable row level security;
alter table public.cl_market_pack_images enable row level security;
revoke all on table public.cl_token_prices, public.cl_token_purchases, public.cl_token_uses, public.cl_market_packs, public.cl_market_pack_images
  from public, anon, authenticated;

revoke all on function public.cl_account_vendor_ids(uuid, uuid), public.cl_account_identity(uuid, uuid), public.cl_account_name(uuid, uuid),
  public.cl_token_price_at(timestamptz), public.cl_token_balance_of(uuid, uuid), public.cl_market_check_header(text, text, text),
  public.cl_market_listing_problem(jsonb), public.cl_market_pack_open(uuid, cl_vendors, jsonb, text, uuid),
  public.cl_market_pack_put_image(uuid, uuid, text, text, text), public.cl_market_account(uuid, uuid),
  public.cl_market_plan(cl_market_packs, integer), public.cl_market_live_pack(uuid)
  from public, anon, authenticated;
revoke all on function public.cl_device_pack_submit(text, text, text, uuid, text, text), public.cl_device_pack_image(text, text, text, uuid, text, text, text),
  public.cl_device_pack_status(text, text, text) from public;
grant execute on function public.cl_device_pack_submit(text, text, text, uuid, text, text), public.cl_device_pack_image(text, text, text, uuid, text, text, text),
  public.cl_device_pack_status(text, text, text) to anon, authenticated;
revoke all on function public.cl_token_price_set(numeric, integer, text, integer, timestamptz, text), public.cl_token_prices_list(),
  public.cl_sell_tokens(uuid, uuid, integer, text), public.cl_token_balance(uuid, uuid), public.cl_market_queue(text),
  public.cl_market_pack_detail(uuid), public.cl_market_pack_thumbs(uuid, integer, integer), public.cl_market_reject(uuid, text),
  public.cl_market_upload_pack(uuid, text, text), public.cl_market_upload_image(uuid, text, text, text),
  public.cl_market_publish_prepare(uuid, integer, text[]), public.cl_market_pack_image_data(uuid, text),
  public.cl_market_publish_attach(uuid, integer, text[], jsonb), public.cl_market_extend(uuid, integer, text),
  public.cl_market_unpublish(uuid, text), public.cl_market_published()
  from public, anon, authenticated;
grant execute on function public.cl_token_price_set(numeric, integer, text, integer, timestamptz, text), public.cl_token_prices_list(),
  public.cl_sell_tokens(uuid, uuid, integer, text), public.cl_token_balance(uuid, uuid), public.cl_market_queue(text),
  public.cl_market_pack_detail(uuid), public.cl_market_pack_thumbs(uuid, integer, integer), public.cl_market_reject(uuid, text),
  public.cl_market_upload_pack(uuid, text, text), public.cl_market_upload_image(uuid, text, text, text),
  public.cl_market_publish_prepare(uuid, integer, text[]), public.cl_market_pack_image_data(uuid, text),
  public.cl_market_publish_attach(uuid, integer, text[], jsonb), public.cl_market_extend(uuid, integer, text),
  public.cl_market_unpublish(uuid, text), public.cl_market_published()
  to authenticated;

commit;
