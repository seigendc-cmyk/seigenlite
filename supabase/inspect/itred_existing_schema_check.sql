-- =====================================================================
-- iTred Market Place — READ-ONLY pre-migration inspection
-- Run this in the SQL editor of the target project BEFORE applying
-- supabase/migrations/20260924120000_itred_marketplace_schema.sql.
-- Nothing below writes anything.
-- =====================================================================

-- 1. Would any of the new objects collide with something that already exists?
--    (The migration also checks this itself and aborts, but see it up front.)
select n as conflicting_name
from unnest(array[
  'public.vendors', 'public.vendor_listings', 'public.customers',
  'public.purchase_orders', 'public.purchase_order_items'
]) as n
where to_regclass(n) is not null
union all
select p.proname
from pg_proc p join pg_namespace s on s.oid = p.pronamespace
where s.nspname = 'public'
  and p.proname in ('itred_set_listing_expiry', 'itred_poi_snapshot_listing',
                    'itred_expire_vendor_listings');

-- 2. Every non-system table, to see what Commerce Lite / Digital Commerce
--    already has in this project.
select table_schema, table_name
from information_schema.tables
where table_schema not in ('pg_catalog', 'information_schema')
  and table_schema not like 'pg\_%'
  and table_schema not in ('auth', 'storage', 'realtime', 'supabase_functions',
                           'extensions', 'graphql', 'graphql_public', 'vault',
                           'pgsodium', 'pgsodium_masks', 'net', 'cron')
order by 1, 2;

-- 3. Existing tables that look like a vendor/shop/tenant identity (the thing
--    `vendors` might need to reference or be replaced by).
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and (table_name ~* 'vendor|shop|tenant|device|store|merchant|business|install'
       or column_name ~* '^(install_id|tenant_id|device_code|business_name|shop_name|phone|whatsapp.*|city)$')
order by table_name, ordinal_position;

-- 4. The device check-in RPC the app already calls on Digital Commerce's
--    project (src/devicecheckin.js). Its body shows which table holds each
--    Commerce Lite install's business_name / phone / city / vendor status.
select pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace s on s.oid = p.pronamespace
where s.nspname = 'public' and p.proname = 'cl_device_checkin';

-- 5. Anything already hooked onto auth.users (e.g. a handle_new_user trigger
--    for Digital Commerce console logins) — relevant to how customers sign up.
select tgname, pg_get_triggerdef(t.oid)
from pg_trigger t
where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal;
