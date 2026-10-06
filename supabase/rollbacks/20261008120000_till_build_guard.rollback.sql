-- =====================================================================
-- Rollback for supabase/migrations/20261008120000_till_build_guard.sql.
-- Puts back the Phase 2 cl_device_checkin (10 arguments) and the Phase 3b
-- cl_stock_start_shared (no build guard), then drops cl_terminals.app_build
-- and app_build_ts. Loses only the reported builds; tills keep working
-- (newer builds send p_app_build, which PostgREST then rejects as an
-- unknown argument, so roll back the app to a build that doesn't send it
-- or apply this only together with that).
-- =====================================================================
begin;

drop function if exists public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid, text, integer);

-- Phase 2 body (supabase/migrations/20261004180000_multi_terminal_phase2.sql)
create function public.cl_device_checkin(
  p_install_id text, p_shop_secret_phrase text, p_device_code text, p_business_name text,
  p_owner_name text default null, p_phone text default null, p_city text default null,
  p_location text default null, p_rpn_hint_id uuid default null, p_device_key text default null)
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

  update cl_terminals set last_seen_ts = now() where vendor_id = v_vendor.id
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

-- same grants as live before the guard (PUBLIC, anon, authenticated, service_role)
grant execute on function public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid, text)
  to public, anon, authenticated, service_role;

-- Phase 3b body (supabase/migrations/20261007120000_shared_stock.sql)
create or replace function public.cl_stock_start_shared(p_install_id text, p_secret_phrase text, p_device_key text, p_op_id text, p_rows jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; r jsonb; v_p text; v_q integer; n integer := 0;
begin
  me := cl_catalogue_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  if p_op_id is null or p_op_id !~ '^[0-9a-f]{32}$' then raise exception 'A start needs an operation id' using errcode = 'P0001'; end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  select * into b from cl_branches where id = me.branch_id for update;
  if exists (select 1 from cl_stock_events where ref_uid = 'start:'||p_op_id) then
    return json_build_object('stock_mode', 'shared', 'already', true);
  end if;
  if b.stock_mode = 'shared' then return json_build_object('error', 'ALREADY_SHARED'); end if;
  if cl_stock_holder(b.id) <> me.id then return json_build_object('error', 'NOT_HOLDER'); end if;
  if cl_stock_active_tills(b.id) < 2 then return json_build_object('error', 'SINGLE_TILL'); end if;
  if (case when jsonb_typeof(p_rows) = 'array' then jsonb_array_length(p_rows) > 20000 else true end) then
    raise exception 'Send the stock as a list of at most 20000 products' using errcode = 'P0001';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_p := r->>'product_uid'; v_q := (r->>'qty')::integer;
    if v_q is null or v_q < 0 then raise exception 'Stock for % must be zero or more', v_p using errcode = 'P0001'; end if;
    if not exists (select 1 from cl_catalogue_products where business_id = me.business_id and product_uid = v_p) then
      raise exception 'Product % is not in the catalogue', v_p using errcode = 'P0001';
    end if;
    perform cl_stock_add(me.business_id, b.id, v_p, v_q);
    perform cl_stock_event('start:'||p_op_id||':'||v_p, 'start:'||p_op_id, me.business_id, b.id, me.id, v_p, 'opening', v_q, 0, 0, '{}'::jsonb);
    n := n + 1;
  end loop;
  update cl_branches set stock_mode = 'shared', stock_shared_ts = now() where id = b.id;
  insert into cl_till_stock_state (terminal_id, branch_id, last_sync_ts) values (me.id, b.id, now())
  on conflict (terminal_id) do update set last_sync_ts = now();
  perform cl_stock_check(b.id);
  return json_build_object('stock_mode', 'shared', 'products', n);
end $fn$;

alter table public.cl_terminals drop column if exists app_build_ts;
alter table public.cl_terminals drop column if exists app_build;

notify pgrst, 'reload schema';

commit;
