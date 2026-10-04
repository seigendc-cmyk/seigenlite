-- =====================================================================
-- DRAFT FOR REVIEW. Rollback for docs/multi-terminal/phase1-migration-draft.sql.
-- On approval: supabase/rollbacks/2026100X120000_multi_terminal_identity.rollback.sql
--
-- Restores cl_device_checkin to its live body of 2026-10-04 (verbatim,
-- from docs/multi-terminal/phase0-report.md §3.1), then removes the new
-- functions, tables and the two cl_vendors columns.
--
-- LOSES: every business, branch, terminal and join code, and the
-- device_key recorded per install. cl_vendors rows themselves (one per
-- install, with billing and activation history) are NOT touched; rows
-- that join created for brand-new terminals stay as ordinary vendors.
-- Export first if wanted:
--   select * from public.cl_businesses; select * from public.cl_branches;
--   select * from public.cl_terminals;
-- =====================================================================
begin;

drop function if exists public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid, text);

CREATE OR REPLACE FUNCTION public.cl_device_checkin(p_install_id text, p_shop_secret_phrase text, p_device_code text, p_business_name text, p_owner_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_location text DEFAULT NULL::text, p_rpn_hint_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_vendor cl_vendors%rowtype;
  v_messages json;
  v_business_name text := nullif(trim(coalesce(p_business_name,'')), '');
  v_owner_name    text := nullif(trim(coalesce(p_owner_name,'')), '');
  v_phone         text := nullif(trim(coalesce(p_phone,'')), '');
  v_city          text := nullif(trim(coalesce(p_city,'')), '');
  v_location      text := nullif(trim(coalesce(p_location,'')), '');
  v_device_code   text := nullif(trim(coalesce(p_device_code,'')), '');
begin
  if p_install_id is null or length(trim(p_install_id)) = 0 then
    raise exception 'install_id is required';
  end if;
  if p_shop_secret_phrase is null or length(trim(p_shop_secret_phrase)) = 0 then
    raise exception 'shop_secret_phrase is required';
  end if;

  select * into v_vendor from cl_vendors where install_id = p_install_id;

  if not found then
    insert into cl_vendors (
      business_name, owner_name, phone, city, location, install_id, device_code,
      shop_secret_phrase, rpn_id, status, app_registered_at, last_checkin_at
    ) values (
      coalesce(v_business_name, 'Unnamed vendor'), v_owner_name, v_phone, v_city, v_location,
      p_install_id, v_device_code, p_shop_secret_phrase, p_rpn_hint_id, 'onboarding', now(), now()
    )
    returning * into v_vendor;
  else
    if v_vendor.shop_secret_phrase is not null
       and v_vendor.shop_secret_phrase <> p_shop_secret_phrase then
      raise exception 'Shop secret phrase does not match this install';
    end if;

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
    'lock_cart', v_vendor.lock_cart,
    'lock_add_product', v_vendor.lock_add_product,
    'lock_reason', v_vendor.lock_reason,
    'cycle_start_date', v_vendor.cycle_start_date,
    'messages', v_messages
  );
end;
$function$;
grant execute on function public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid)
  to public, anon, authenticated, service_role;

drop function if exists public.cl_branch_list(text, text, text);
drop function if exists public.cl_terminal_join(text, text, text, text, text, text, text, text, text, text);
drop function if exists public.cl_branch_issue_join_code(text, text, text, uuid, text, int);
drop function if exists public.cl_branch_register(text, text, text, text, text, text, text, text);
drop function if exists public.cl_terminal_json(uuid);
drop function if exists public.cl_next_till_code(uuid);
drop function if exists public.cl_new_join_code();
drop function if exists public.cl_norm_join_code(text);
drop function if exists public.cl_install_vendor(text, text, text, boolean, text, text);
drop function if exists public.cl_norm_phrase(text);

drop table if exists public.cl_join_failures;
drop table if exists public.cl_branch_join_codes;
drop table if exists public.cl_terminals;
drop table if exists public.cl_branches;
alter table public.cl_vendors drop column if exists business_id, drop column if exists device_key;
drop table if exists public.cl_businesses;
drop function if exists public.cl_branch_key(text);   -- after cl_branches: its name index uses it

commit;
