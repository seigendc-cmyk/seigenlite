-- =====================================================================
-- Minimum app build (owner, 2026-10-14: "minimum build in the check-in
-- answer, with a red 'must update' bar"). Applied live only after the owner
-- has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261025120000_min_app_build.rollback.sql
-- Tested in PGlite: supabase/tests/min-app-build-test.js
--
-- Changes:
--   cl_app_build_rule   new: one row, the lowest app build seiGEN still
--                       wants tills to run (starts at 21: a build before 21
--                       can't add or join tills since 20261023120000).
--                       Raised later with a one-line data change, after the
--                       owner says so.
--   cl_device_checkin   the answer also carries min_build and
--                       update_required (this till's build is below it);
--                       same signature, same grants, nothing else changes.
-- Apps before v23 ignore the two new fields. A till that sends no build
-- (before v8) is never told update_required (it couldn't show it anyway).
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
begin
  if to_regclass('public.cl_app_build_rule') is not null then
    raise exception 'min_app_build aborted: already there (cl_app_build_rule). Nothing was changed.';
  end if;
  if to_regprocedure('public.cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text,integer)') is null
     or not exists (select 1 from pg_proc where oid = to_regprocedure('public.cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text,integer)') and prosrc like '%admin passcode seed%') then
    raise exception 'min_app_build aborted: cl_device_checkin is not the 20261023120000 version. Nothing was changed.';
  end if;
end $$;

-- 1. The rule -------------------------------------------------------------
create table public.cl_app_build_rule (
  id         boolean primary key default true check (id),   -- one row
  min_build  integer not null check (min_build between 0 and 10000),
  note       text,
  updated_ts timestamptz not null default now()
);
comment on table public.cl_app_build_rule is 'Minimum app build (20261025120000): tills below min_build are told update_required in their check-in answer and show a red "must update" bar (app v23+).';
alter table public.cl_app_build_rule enable row level security;
revoke all on table public.cl_app_build_rule from anon, authenticated;
insert into public.cl_app_build_rule (id, min_build, note)
values (true, 21, 'Start: below v21 a till can''t add or join tills (20261023120000).');

-- 2. Check-in (20261023120000 body + marked lines; same signature) -----------
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


commit;
