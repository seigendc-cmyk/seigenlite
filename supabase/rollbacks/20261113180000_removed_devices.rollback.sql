-- Rollback of 20261113180000_removed_devices (v36 Fix-A).
-- Puts back cl_install_vendor (20261109120000) and cl_device_checkin
-- (20261025120000) exactly, and removes the list, its trigger, cl_company_info
-- and the 'company_website' setting. The list's rows are lost with it.
begin;

drop function if exists public.cl_company_info();
delete from public.cl_app_settings where key = 'company_website';

drop function if exists public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid, text, integer, uuid);
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
  v_admin_seed json;                                                 -- admin passcode seed
  v_min_build integer := coalesce((select r.min_build from cl_app_build_rule r where r.id), 0);   -- minimum build
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

  -- admin passcode seed: a check value the main branch set for this till, delivered once
  if v_terminal_id is not null then
    update cl_terminal_admin_seeds set delivered_ts = now()
     where terminal_id = v_terminal_id and delivered_ts is null
    returning json_build_object('salt', salt, 'check', check_value, 'rounds', rounds, 'set_ts', created_ts) into v_admin_seed;
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
    'terminal_active', v_terminal_active,       -- Phase 2, additive
    'admin_seed', v_admin_seed,                 -- admin passcode seed, additive
    'min_build', v_min_build,                   -- minimum build, additive
    'update_required', coalesce(p_app_build, 0) > 0 and p_app_build < v_min_build   -- minimum build, additive
  );
end;
$function$;

-- same grants as live (PUBLIC, anon, authenticated, service_role)
grant execute on function public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid, text, integer)
  to public, anon, authenticated, service_role;

create or replace function public.cl_install_vendor(
  p_install_id text, p_phrase text, p_device_key text, p_create boolean,
  p_business_name text default null, p_device_code text default null)
returns public.cl_vendors
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype;
        st cl_terminals%rowtype; v_tok text; v_staff uuid;                -- office seats
begin
  perform set_config('cl.seat_terminal', '', true);                     -- office seats: who the caller is, for cl_seat_need
  perform set_config('cl.seat_staff', '', true);                        -- office seats
  if p_install_id is null or length(trim(p_install_id)) = 0 then raise exception 'install_id is required'; end if;
  if cl_norm_phrase(p_phrase) = '' then raise exception 'shop_secret_phrase is required'; end if;

  select * into v from cl_vendors where install_id = p_install_id for update;
  if not found then
    if not p_create then raise exception 'This device is not registered yet' using errcode = 'P0002'; end if;
    insert into cl_vendors (business_name, install_id, device_code, shop_secret_phrase, device_key,
                            status, app_registered_at, last_checkin_at)
    values (coalesce(nullif(trim(coalesce(p_business_name,'')), ''), 'Unnamed vendor'), p_install_id,
            nullif(trim(coalesce(p_device_code,'')), ''), p_phrase, nullif(p_device_key, ''),
            'onboarding', now(), now())
    returning * into v;
    return v;
  end if;

  -- office seats: a seat sends its own phrase, then "|" and the signed-in person's token
  select * into st from cl_terminals where vendor_id = v.id and device_kind = 'seat';
  if st.id is not null then
    v_tok := nullif(split_part(coalesce(p_phrase, ''), '|', 2), '');
    p_phrase := split_part(coalesce(p_phrase, ''), '|', 1);
  end if;
  if v.shop_secret_phrase is not null and cl_norm_phrase(v.shop_secret_phrase) <> cl_norm_phrase(p_phrase) then
    raise exception 'Shop secret phrase does not match this install';
  end if;
  if v.device_key is not null and v.device_key is distinct from nullif(p_device_key, '') then
    raise exception 'This install ID is already registered to another device';
  end if;
  if v.device_key is null and nullif(p_device_key, '') is not null then
    update cl_vendors set device_key = p_device_key where id = v.id returning * into v;
  end if;
  -- office seats: an unapproved seat gets nothing (cl_seat_status / cl_seat_set_pin excepted)
  if st.id is not null then
    if st.approval_status <> 'approved' and coalesce(current_setting('cl.allow_pending_seat', true), '') <> '1' then
      raise exception 'SEAT_NOT_APPROVED: This Office seat is waiting for approval by the Owner or an Admin.' using errcode = 'P0001';
    end if;
    perform set_config('cl.seat_terminal', st.id::text, true);
    if v_tok is not null then
      select x.staff_id into v_staff from cl_shop_session(v_tok, st.id) x limit 1;
      if v_staff is not null then perform set_config('cl.seat_staff', v_staff::text, true); end if;
    end if;
  end if;
  return v;
end $fn$;

drop trigger if exists cl_vendors_removed_device on public.cl_vendors;
drop function if exists public.cl_vendor_removed_device();
drop table if exists public.cl_removed_devices;

notify pgrst, 'reload schema';

commit;
