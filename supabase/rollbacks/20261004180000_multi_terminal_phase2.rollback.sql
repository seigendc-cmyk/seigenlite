-- =====================================================================
-- Rollback for supabase/migrations/20261004180000_multi_terminal_phase2.sql.
--
-- 1. Reactivates every till whose latest activity-log entry is this
--    migration's 'terminal_deactivated' (and only those).
-- 2. Drops cl_terminal_set_active().
-- 3. Restores the Phase 1 bodies of cl_device_checkin, cl_terminal_join,
--    cl_branch_register (verbatim from
--    supabase/migrations/20261004120000_multi_terminal_identity.sql) and
--    of cl_branch_key, and recreates the branch-name index.
--
-- LOSES: nothing stored. The activity-log rows stay as history.
-- Aborts, changing nothing, if two branch names of one business would
-- collide under the old key (possible only for names created after the
-- migration that differ by accents or beyond 24 characters).
-- =====================================================================
begin;

do $$
declare dupes text;
begin
  select string_agg(format('%s: %s', business_id, names), '; ') into dupes from (
    select business_id, string_agg(quote_literal(name), ' = ' order by name) names
      from public.cl_branches
     group by business_id, lower(regexp_replace(coalesce(name, ''), '[^A-Za-z0-9]', '', 'g'))
    having count(*) > 1
  ) d;
  if dupes is not null then raise exception 'multi_terminal_phase2 rollback aborted: branch names that the old key makes equal: %. Nothing was changed.', dupes; end if;
end $$;

-- 1. tills this migration's RPC left deactivated
update public.cl_terminals t set active = true
 where not t.active
   and (select l.action from public.cl_activity_log l
         where l.target_table = 'cl_terminals' and l.target_id = t.id
           and l.action in ('terminal_deactivated', 'terminal_reactivated')
         order by l.created_at desc limit 1) = 'terminal_deactivated';

-- 2.
drop function if exists public.cl_terminal_set_active(text, text, text, uuid, boolean);

-- 3. Phase 1 bodies
-- dropped and created again, not REINDEXed (see the migration, step 1)
drop index public.cl_branches_name_uidx;
create or replace function public.cl_branch_key(p text) returns text
language sql immutable as $$ select lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;
revoke execute on function public.cl_branch_key(text) from public, anon, authenticated;
create unique index cl_branches_name_uidx on public.cl_branches (business_id, public.cl_branch_key(name));

create or replace function public.cl_branch_register(
  p_install_id text, p_secret_phrase text, p_device_key text,
  p_business_name text, p_branch_name text, p_legacy_branch_id text default null,
  p_label text default null, p_device_code text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; t cl_terminals%rowtype; biz uuid; br uuid;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, true, p_business_name, p_device_code);

  select * into t from cl_terminals where vendor_id = v.id;
  if found then
    if not (select is_main from cl_branches where id = t.branch_id) then
      raise exception 'This device already belongs to a branch that is not the main branch' using errcode = 'P0001';
    end if;
    return cl_terminal_json(t.id);
  end if;
  if v.business_id is not null then
    raise exception 'This device is already linked to a business' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_branch_name,''))) = 0 then raise exception 'Branch name is required'; end if;

  insert into cl_businesses (name, secret_phrase_hash, created_by_vendor_id)
  values (coalesce(nullif(btrim(coalesce(p_business_name,'')), ''), v.business_name),
          extensions.crypt(cl_norm_phrase(p_secret_phrase), extensions.gen_salt('bf')), v.id)
  returning id into biz;
  insert into cl_branches (business_id, name, is_main, legacy_branch_id)
  values (biz, btrim(p_branch_name), true, nullif(p_legacy_branch_id, '')) returning id into br;
  update cl_vendors set business_id = biz where id = v.id;
  insert into cl_terminals (business_id, branch_id, vendor_id, install_id, till_code, label, last_seen_ts)
  values (biz, br, v.id, v.install_id, 'T1', nullif(btrim(coalesce(p_label,'')), ''), now()) returning * into t;
  return cl_terminal_json(t.id);
end $fn$;

create or replace function public.cl_terminal_join(
  p_install_id text, p_secret_phrase text, p_device_key text, p_join_code text,
  p_label text default null, p_legacy_branch_id text default null,
  p_device_phrase text default null, p_device_code text default null, p_business_name text default null,
  p_expected_branch_name text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; jc cl_branch_join_codes%rowtype; br cl_branches%rowtype; biz cl_businesses%rowtype;
        t cl_terminals%rowtype; norm text := cl_norm_join_code(p_join_code);
begin
  if (select count(*) from cl_join_failures where install_id = p_install_id and ts > now() - interval '1 hour') >= 10 then
    raise exception 'JOIN_LOCKED: Too many wrong codes. Try again in an hour.' using errcode = 'P0001';
  end if;

  select * into jc from cl_branch_join_codes where code_hash = encode(extensions.digest(norm, 'sha256'), 'hex') for update;
  if not found then
    insert into cl_join_failures (install_id) values (p_install_id);
    -- the failure row must survive the exception, so return an error object
    -- instead of raising (a raise would roll the insert back)
    return json_build_object('error', 'JOIN_CODE_INVALID');
  end if;
  select * into br from cl_branches where id = jc.branch_id;
  select * into biz from cl_businesses where id = br.business_id;

  if extensions.crypt(cl_norm_phrase(p_secret_phrase), biz.secret_phrase_hash) <> biz.secret_phrase_hash then
    insert into cl_join_failures (install_id) values (p_install_id);
    return json_build_object('error', 'PHRASE_MISMATCH');
  end if;

  -- Already a terminal? A retried join answers the same; nothing is created.
  select * into t from cl_terminals where install_id = p_install_id;
  if found then
    v := cl_install_vendor(p_install_id, coalesce(nullif(p_device_phrase, ''), p_secret_phrase), p_device_key, false);
    if t.branch_id = br.id then return cl_terminal_json(t.id); end if;
    return json_build_object('error', 'ALREADY_JOINED', 'branch_id', t.branch_id);
  end if;
  -- Every refusal comes before anything is written for this install.
  if jc.used_by_terminal is not null then return json_build_object('error', 'JOIN_CODE_USED'); end if;
  if jc.expires_ts < now() then return json_build_object('error', 'JOIN_CODE_EXPIRED'); end if;
  -- An existing device's branch name is locked (DN keys carry it), so it
  -- may only join a branch of the same name.
  if nullif(btrim(coalesce(p_expected_branch_name,'')), '') is not null
     and cl_branch_key(p_expected_branch_name) <> cl_branch_key(br.name) then
    return json_build_object('error', 'BRANCH_NAME_MISMATCH', 'branch_name', br.name);
  end if;
  if exists (select 1 from cl_vendors where install_id = p_install_id and business_id is not null and business_id <> biz.id) then
    return json_build_object('error', 'OTHER_BUSINESS');
  end if;

  v := cl_install_vendor(p_install_id, coalesce(nullif(p_device_phrase, ''), p_secret_phrase), p_device_key, true,
                         coalesce(p_business_name, biz.name), p_device_code);

  perform 1 from cl_branches where id = br.id for update;            -- serialise till numbering
  insert into cl_terminals (business_id, branch_id, vendor_id, install_id, till_code, label, last_seen_ts)
  values (biz.id, br.id, v.id, v.install_id, cl_next_till_code(br.id), nullif(btrim(coalesce(p_label,'')), ''), now())
  returning * into t;
  update cl_branch_join_codes set used_by_terminal = t.id, used_ts = now() where id = jc.id;
  update cl_vendors set business_id = biz.id where id = v.id;
  if not br.is_main and br.legacy_branch_id is null and nullif(p_legacy_branch_id, '') is not null then
    update cl_branches set legacy_branch_id = p_legacy_branch_id where id = br.id;
  end if;
  return cl_terminal_json(t.id);
end $fn$;

create or replace function public.cl_device_checkin(
  p_install_id text, p_shop_secret_phrase text, p_device_code text, p_business_name text,
  p_owner_name text default null, p_phone text default null, p_city text default null,
  p_location text default null, p_rpn_hint_id uuid default null, p_device_key text default null)
returns json
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_vendor cl_vendors%rowtype;
  v_messages json;
  v_terminal_id uuid;
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

  update cl_terminals set last_seen_ts = now() where vendor_id = v_vendor.id returning id into v_terminal_id;

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
    'business_id', v_vendor.business_id,        -- new, additive
    'terminal_id', v_terminal_id                -- new, additive
  );
end;
$function$;

commit;
