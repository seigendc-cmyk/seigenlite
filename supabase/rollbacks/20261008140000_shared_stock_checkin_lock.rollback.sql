-- =====================================================================
-- Rollback for supabase/migrations/20261008140000_shared_stock_checkin_lock.sql.
-- Puts back the build guard's cl_device_checkin (same signature, grants
-- kept): no shared stock lock in the reply. Nothing is stored by the lock,
-- so nothing else changes; a locked till unlocks at its next check-in.
-- =====================================================================
begin;

-- build guard body (supabase/migrations/20261008120000_till_build_guard.sql)
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
    returning id, active into v_terminal_id, v_terminal_active;      -- Phase 2: + active

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
    'lock_cart', v_vendor.lock_cart,
    'lock_add_product', v_vendor.lock_add_product,
    'lock_reason', v_vendor.lock_reason,
    'cycle_start_date', v_vendor.cycle_start_date,
    'messages', v_messages,
    'business_id', v_vendor.business_id,        -- Phase 1, additive
    'terminal_id', v_terminal_id,               -- Phase 1, additive
    'terminal_active', v_terminal_active        -- Phase 2, additive
  );
end;
$function$;

commit;
