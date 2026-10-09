-- Rollback of 20261016120000_market_publishing.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Refuses while token purchases or published packs exist (money and
-- listing history). Restores itred_set_listing_expiry, the two delete
-- guards (as 20261015120000 made them), and removes the rest.

begin;

do $$
begin
  if exists (select 1 from public.cl_token_purchases) or exists (select 1 from public.cl_market_packs where status in ('published', 'unpublished'))
     or exists (select 1 from public.vendor_listings where pack_id is not null) then
    raise exception 'market_publishing rollback aborted: token purchases or published packs exist. Nothing was changed.';
  end if;
end $$;

drop function if exists public.cl_market_photo_trash_done(bigint[]);
drop function if exists public.cl_market_photo_trash(integer);
drop function if exists public.cl_market_published();
drop function if exists public.cl_market_unpublish(uuid, text);
drop function if exists public.cl_market_extend(uuid, integer, text);
drop function if exists public.cl_market_live_pack(uuid);
drop function if exists public.cl_market_publish_attach(uuid, integer, text[], jsonb);
drop function if exists public.cl_market_pack_image_data(uuid, text);
drop function if exists public.cl_market_publish_prepare(uuid, integer, text[]);
drop function if exists public.cl_market_plan(cl_market_packs, integer);
drop function if exists public.cl_market_upload_image(uuid, text, text, text);
drop function if exists public.cl_market_upload_pack(uuid, text, text);
drop function if exists public.cl_market_reject(uuid, text);
drop function if exists public.cl_market_pack_thumbs(uuid, integer, integer);
drop function if exists public.cl_market_pack_detail(uuid);
drop function if exists public.cl_market_queue(text);
drop function if exists public.cl_token_balance(uuid, uuid);
drop function if exists public.cl_sell_tokens(uuid, uuid, integer, text);
drop function if exists public.cl_market_account(uuid, uuid);
drop function if exists public.cl_token_prices_list();
drop function if exists public.cl_token_price_set(numeric, integer, text, integer, timestamptz, text);
drop function if exists public.cl_device_pack_status(text, text, text);
drop function if exists public.cl_device_pack_image(text, text, text, uuid, text, text, text);
drop function if exists public.cl_device_pack_submit(text, text, text, uuid, text, text);
drop function if exists public.cl_market_pack_put_image(uuid, uuid, text, text, text);
drop function if exists public.cl_market_pack_open(uuid, cl_vendors, jsonb, text, uuid);
drop function if exists public.cl_market_listing_problem(jsonb);
drop function if exists public.cl_market_check_header(text, text, text);
drop function if exists public.cl_listing_photos_to_trash(uuid[], text);
drop function if exists public.cl_market_purge_photos();
drop function if exists public.cl_token_balance_of(uuid, uuid);

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
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

drop table public.cl_listing_photo_trash;
drop table public.cl_market_pack_images;
drop table public.cl_market_packs;
drop table public.cl_token_uses;
drop table public.cl_token_purchases;
drop function if exists public.cl_token_price_at(timestamptz);
drop table public.cl_token_prices;
drop function if exists public.cl_account_name(uuid, uuid);
drop function if exists public.cl_account_identity(uuid, uuid);
drop function if exists public.cl_account_vendor_ids(uuid, uuid);

alter table public.vendor_listings drop column thumb_url, drop column pack_id;

create or replace function public.itred_set_listing_expiry()
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

delete from public.cl_modules where key in ('market_review', 'market_publish', 'token_sales');

commit;
