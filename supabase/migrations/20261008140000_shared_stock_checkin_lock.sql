-- =====================================================================
-- Shared stock: lock the cart on an outdated till of a shared-stock branch.
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261008140000_shared_stock_checkin_lock.rollback.sql
-- Tested in PGlite: supabase/tests/till-build-guard-test.js
--
-- Why: a till on a build before v7 has no shared-stock code. At a branch
-- that already shares its stock it would sell from its own local stock and
-- the server would never hear of it. The build guard
-- (20261008120000_till_build_guard.sql) only stops a branch from STARTING
-- shared stock; this stops outdated tills at a branch that already has.
--
-- Change: cl_device_checkin() only (same signature, so CREATE OR REPLACE
-- keeps the live grants). When the till's branch has stock_mode = 'shared'
-- and the till's build is unknown or below 7 (as reported in this same
-- check-in), the reply says lock_cart = true with the shared-stock
-- lock_reason, unless Digital Commerce already locks the cart (its own
-- reason then stays). Computed on every check-in, never stored: cl_vendors'
-- own locks are untouched, and the lock lifts at the first check-in from
-- an up-to-date build. Tills at local-stock branches and installs that
-- aren't tills get exactly the reply they got before.
-- Every build honours lock_cart / lock_reason (devicecheckin.js since
-- before v4: router.js cart button + drawer, desktop sales-desktop.js).
-- Apply by hand in one transaction (no migrations table).
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text;
begin
  if exists (select 1 from pg_proc where proname = 'cl_device_checkin' and prosrc like '%shared stock lock%') then
    raise exception 'shared_stock_checkin_lock aborted: already exists: the shared stock lock in cl_device_checkin. Nothing was changed.';
  end if;
  select string_agg(n, ', ') into missing from (
    select 'function cl_device_checkin (11 args, build guard)' n where to_regprocedure(
      'public.cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text,integer)') is null
    union all select 'column cl_terminals.app_build (build guard)' where not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cl_terminals' and column_name = 'app_build')
    union all select 'column cl_branches.stock_mode (Phase 3b)' where not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cl_branches' and column_name = 'stock_mode')
  ) x;
  if missing is not null then raise exception 'shared_stock_checkin_lock aborted: missing %. Nothing was changed.', missing; end if;
end $$;


-- 1. Check-in: build guard body; the only changes are marked "shared stock lock"
create or replace function public.cl_device_checkin(
  p_install_id text, p_shop_secret_phrase text, p_device_code text, p_business_name text,
  p_owner_name text default null, p_phone text default null, p_city text default null,
  p_location text default null, p_rpn_hint_id uuid default null, p_device_key text default null,
  p_app_build integer default null)                                  -- build guard
returns json
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_vendor cl_vendors%rowtype;
  v_messages json;
  v_terminal_id uuid;
  v_terminal_active boolean;                                         -- Phase 2
  v_branch_id uuid;                                                  -- shared stock lock
  v_app_build integer;                                               -- shared stock lock
  v_shared_lock boolean := false;                                    -- shared stock lock
  v_business_name text := nullif(trim(coalesce(p_business_name,'')), '');
  v_owner_name    text := nullif(trim(coalesce(p_owner_name,'')), '');
  v_phone         text := nullif(trim(coalesce(p_phone,'')), '');
  v_city          text := nullif(trim(coalesce(p_city,'')), '');
  v_location      text := nullif(trim(coalesce(p_location,'')), '');
  v_device_code   text := nullif(trim(coalesce(p_device_code,'')), '');
begin
  -- was: inline install/phrase checks + "insert if not found"
  v_vendor := cl_install_vendor(p_install_id, p_shop_secret_phrase, p_device_key, true, v_business_name, v_device_code);

  update cl_vendors set
    business_name       = coalesce(v_business_name, business_name),
    owner_name          = coalesce(v_owner_name, owner_name),
    phone               = coalesce(v_phone, phone),
    city                = coalesce(v_city, city),
    location            = coalesce(v_location, location),
    device_code         = coalesce(v_device_code, device_code),
    shop_secret_phrase  = coalesce(v_vendor.shop_secret_phrase, p_shop_secret_phrase),
    rpn_id              = coalesce(v_vendor.rpn_id, p_rpn_hint_id),
    last_checkin_at     = now()
  where id = v_vendor.id
  returning * into v_vendor;

  update cl_terminals set last_seen_ts = now(),
         app_build = case when p_app_build > 0 then p_app_build end, app_build_ts = now()   -- build guard
   where vendor_id = v_vendor.id
    returning id, active, branch_id, app_build                       -- shared stock lock: + branch_id, app_build
         into v_terminal_id, v_terminal_active, v_branch_id, v_app_build;   -- Phase 2: + active

  -- shared stock lock: a till at a shared-stock branch on a build before v7 must not sell
  if v_terminal_id is not null then
    v_shared_lock := coalesce((select stock_mode = 'shared' from cl_branches where id = v_branch_id), false)
                     and coalesce(v_app_build, 0) < 7;
  end if;

  select coalesce(json_agg(json_build_object('id', id, 'title', title, 'body', body, 'created_at', created_at)), '[]'::json)
    into v_messages
    from cl_vendor_messages
    where vendor_id = v_vendor.id and channel = 'in_app' and status = 'pending';

  update cl_vendor_messages
    set status = 'delivered', delivered_at = now()
    where vendor_id = v_vendor.id and channel = 'in_app' and status = 'pending';

  return json_build_object(
    'vendor_id', v_vendor.id,
    'status', v_vendor.status,
    'lock_cart', case when v_shared_lock then true else v_vendor.lock_cart end,                 -- shared stock lock
    'lock_add_product', v_vendor.lock_add_product,
    'lock_reason', case when v_shared_lock and not coalesce(v_vendor.lock_cart, false)         -- shared stock lock
                        then 'This branch uses shared stock. Update the app before selling: tap Reload on the update banner, or reopen the app while online.'
                        else v_vendor.lock_reason end,
    'cycle_start_date', v_vendor.cycle_start_date,
    'messages', v_messages,
    'business_id', v_vendor.business_id,        -- Phase 1, additive
    'terminal_id', v_terminal_id,               -- Phase 1, additive
    'terminal_active', v_terminal_active        -- Phase 2, additive
  );
end;
$function$;

commit;
