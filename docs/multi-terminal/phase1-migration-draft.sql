-- =====================================================================
-- DRAFT FOR REVIEW. NOT APPLIED. NOT IN supabase/migrations/ YET.
--
-- Multi-terminal sync, Phase 1A: business / branch / terminal identity.
-- On approval this becomes
--   supabase/migrations/2026100X120000_multi_terminal_identity.sql
-- with the rollback in supabase/rollbacks/ and the PGlite test
-- supabase/tests/multi-terminal-identity-test.js (never run against live).
--
-- Owner decisions this implements (2026-10-04):
--   Q1  New cl_businesses table; cl_vendors.business_id (nullable).
--       cl_vendors stays one row per install; billing and activation
--       history untouched; nothing deleted, nothing merged. Main's install
--       creates the business when it registers its branch. Remote devices
--       and new terminals link with a join code from main.
--   Q2  Phrase check is upper(btrim()) everywhere, cl_device_checkin
--       included. The join code, not the phrase, picks the business.
--   Q3  cl_device_checkin refuses to take over an existing vendor row that
--       belongs to another device. See PROPOSED DEVIATION below.
--   7   Devices write only through phrase-checked SECURITY DEFINER RPCs.
--
-- PROPOSED DEVIATION (needs the owner's OK): Q3 asked to refuse when the
-- install_id matches but the DEVICE CODE differs. The device code is
-- install_id || '-C' || cycle (src/activation.js:23-28) and check-in
-- overwrites cl_vendors.device_code on every call. So:
--   * a legitimate device's code changes every 30 days (C1 -> C2), and the
--     literal rule would lock every shop out at each cycle rollover;
--   * two devices that collide on install_id have the same prefix, and
--     differ only if they happen to be on different cycles.
-- Instead, each install sends a random 128-bit device_key (new local
-- setting, made once). The server records it the first time it sees it
-- (trust on first use) and refuses any later call for that install_id
-- with a different or missing key. This catches every collision and
-- never locks out a legitimate device.
--
-- Checked read-only against the live project on 2026-10-04:
--   * pgcrypto lives in schema "extensions" (crypt, gen_salt, digest,
--     gen_random_bytes), so it's called schema-qualified below.
--   * Default privileges in public grant ALL on new tables and EXECUTE on
--     new functions to anon and authenticated, so every new table revokes
--     explicitly and internal helpers revoke EXECUTE.
--   * No supabase_migrations history table: apply by hand in the SQL
--     editor, in one transaction.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'table cl_vendors' n where to_regclass('public.cl_vendors') is null
    union all select 'table cl_vendor_messages' where to_regclass('public.cl_vendor_messages') is null
    union all select 'function extensions.crypt' where to_regprocedure('extensions.crypt(text,text)') is null
    union all select 'function extensions.digest' where to_regprocedure('extensions.digest(text,text)') is null
    union all select 'function extensions.gen_random_bytes' where to_regprocedure('extensions.gen_random_bytes(integer)') is null
    union all select 'function cl_device_checkin (9 args)' where to_regprocedure(
      'public.cl_device_checkin(text,text,text,text,text,text,text,text,uuid)') is null
  ) x;
  if missing is not null then raise exception 'multi_terminal_identity aborted: missing %. Nothing was changed.', missing; end if;

  select string_agg(n, ', ') into conflicts from (
    select 'table cl_businesses' n where to_regclass('public.cl_businesses') is not null
    union all select 'table cl_branches' where to_regclass('public.cl_branches') is not null
    union all select 'table cl_terminals' where to_regclass('public.cl_terminals') is not null
    union all select 'table cl_branch_join_codes' where to_regclass('public.cl_branch_join_codes') is not null
    union all select 'table cl_join_failures' where to_regclass('public.cl_join_failures') is not null
    union all select 'column cl_vendors.business_id' where exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='cl_vendors' and column_name in ('business_id','device_key'))
  ) x;
  if conflicts is not null then raise exception 'multi_terminal_identity aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;


-- 1. Tables -------------------------------------------------------------
create table public.cl_businesses (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (length(btrim(name)) between 1 and 120),
  -- bcrypt of upper(btrim(phrase)) as entered by the main install at
  -- registration; never the phrase itself
  secret_phrase_hash   text not null,
  created_by_vendor_id uuid not null unique references public.cl_vendors(id),
  created_ts           timestamptz not null default now()
);
comment on table public.cl_businesses is
  'A Commerce Lite business (branches -> terminals). Created by the main install''s cl_branch_register(). Access only through cl_ RPCs.';

alter table public.cl_vendors
  add column business_id uuid references public.cl_businesses(id) on delete set null,
  add column device_key  text;
comment on column public.cl_vendors.business_id is
  'The business this install belongs to (null = not registered as a terminal yet). cl_vendors stays one row per install.';
comment on column public.cl_vendors.device_key is
  'Random key the install sends with every call; recorded on first use. A different key for the same install_id is refused (install_id collision guard).';
create index cl_vendors_business_idx on public.cl_vendors (business_id) where business_id is not null;

create table public.cl_branches (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.cl_businesses(id),
  name             text not null check (length(btrim(name)) between 1 and 80),
  is_main          boolean not null default false,
  legacy_branch_id text check (legacy_branch_id is null or legacy_branch_id ~ '^B-[A-Z0-9]{8}$'),
  created_ts       timestamptz not null default now()
);
-- Same idea as the app's sameBranchName() (src/docnum.js:30-32): letters
-- and digits only, case-insensitive, so "Harare CBD" and "HarareCBD" are
-- one branch here as they are on the devices. (The app also folds accents
-- and caps at 24 characters; names differing only that way are rare.)
create function public.cl_branch_key(p text) returns text
language sql immutable as $$ select lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;
revoke execute on function public.cl_branch_key(text) from public, anon, authenticated;
create unique index cl_branches_name_uidx on public.cl_branches (business_id, public.cl_branch_key(name));
create unique index cl_branches_one_main_uidx on public.cl_branches (business_id) where is_main;

create table public.cl_terminals (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.cl_businesses(id),
  branch_id     uuid not null references public.cl_branches(id),
  vendor_id     uuid not null unique references public.cl_vendors(id),   -- this install's own row
  install_id    text not null unique references public.cl_vendors(install_id) on update cascade,
  till_code     text not null check (till_code ~ '^T[0-9]{1,3}$'),
  label         text check (label is null or length(label) <= 60),
  registered_ts timestamptz not null default now(),
  last_seen_ts  timestamptz,
  active        boolean not null default true,
  unique (branch_id, till_code)
);

create table public.cl_branch_join_codes (
  id                 uuid primary key default gen_random_uuid(),
  branch_id          uuid not null references public.cl_branches(id),
  code_hash          text not null unique,          -- sha256 hex of the normalised code
  issued_by_terminal uuid not null references public.cl_terminals(id),
  issued_ts          timestamptz not null default now(),
  expires_ts         timestamptz not null,
  used_by_terminal   uuid references public.cl_terminals(id),
  used_ts            timestamptz
);

-- Wrong join codes per install, for a simple per-install attempt limit.
create table public.cl_join_failures (
  install_id text not null,
  ts         timestamptz not null default now()
);
create index cl_join_failures_idx on public.cl_join_failures (install_id, ts);

-- RLS on, no policies, no grants: reachable only through the RPCs below.
do $$ declare t text; begin
  foreach t in array array['cl_businesses','cl_branches','cl_terminals','cl_branch_join_codes','cl_join_failures'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;


-- 2. Internal helpers (not callable by anon/authenticated) --------------
create function public.cl_norm_phrase(p text) returns text
language sql immutable as $$ select upper(btrim(coalesce(p, ''))) $$;

-- The one install + phrase + device_key check every device RPC uses,
-- cl_device_checkin included. Locks and returns this install's cl_vendors
-- row, creating it (exactly the columns check-in always set) when
-- p_create and the install is new.
create function public.cl_install_vendor(
  p_install_id text, p_phrase text, p_device_key text, p_create boolean,
  p_business_name text default null, p_device_code text default null)
returns public.cl_vendors
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype;
begin
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

  if v.shop_secret_phrase is not null and cl_norm_phrase(v.shop_secret_phrase) <> cl_norm_phrase(p_phrase) then
    raise exception 'Shop secret phrase does not match this install';
  end if;
  if v.device_key is not null and v.device_key is distinct from nullif(p_device_key, '') then
    raise exception 'This install ID is already registered to another device';
  end if;
  if v.device_key is null and nullif(p_device_key, '') is not null then
    update cl_vendors set device_key = p_device_key where id = v.id returning * into v;
  end if;
  return v;
end $fn$;

-- Normalises a typed join code: upper case, letters/digits only.
create function public.cl_norm_join_code(p text) returns text
language sql immutable as $$ select regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g') $$;

-- 8 characters, no I L O 0 1.
create function public.cl_new_join_code() returns text
language plpgsql volatile set search_path = public as $fn$
declare alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; b bytea := extensions.gen_random_bytes(8); s text := ''; i int;
begin
  for i in 0..7 loop s := s || substr(alphabet, (get_byte(b, i) % 31) + 1, 1); end loop;
  return s;
end $fn$;

create function public.cl_next_till_code(p_branch_id uuid) returns text
language sql volatile set search_path = public as $$
  select 'T' || (coalesce(max(substr(till_code, 2)::int), 0) + 1)::text from cl_terminals where branch_id = p_branch_id
$$;

create function public.cl_terminal_json(p_terminal_id uuid) returns json
language sql stable set search_path = public as $$
  select json_build_object('business_id', b.id, 'business_name', b.name,
    'branch_id', br.id, 'branch_name', br.name, 'is_main', br.is_main,
    'terminal_id', t.id, 'till_code', t.till_code, 'label', t.label)
  from cl_terminals t join cl_branches br on br.id = t.branch_id join cl_businesses b on b.id = t.business_id
  where t.id = p_terminal_id
$$;

revoke execute on function public.cl_norm_phrase(text) from public, anon, authenticated;
revoke execute on function public.cl_install_vendor(text, text, text, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.cl_norm_join_code(text) from public, anon, authenticated;
revoke execute on function public.cl_new_join_code() from public, anon, authenticated;
revoke execute on function public.cl_next_till_code(uuid) from public, anon, authenticated;
revoke execute on function public.cl_terminal_json(uuid) from public, anon, authenticated;


-- 3. Device RPCs (anon may call; each checks install + phrase + key) ----

-- Main install creates the business, its main branch and its own terminal
-- (T1). Idempotent: a second call returns the same ids. A device that
-- isn't main joins with a code instead (cl_terminal_join).
create function public.cl_branch_register(
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

-- Main-branch terminals only. Either an existing branch (p_branch_id) or a
-- new remote branch by name (p_new_branch_name, from main's branch
-- register). Returns the plain code once; only its hash is stored.
create function public.cl_branch_issue_join_code(
  p_install_id text, p_secret_phrase text, p_device_key text,
  p_branch_id uuid default null, p_new_branch_name text default null, p_valid_hours int default 24)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; me cl_terminals%rowtype; target cl_branches%rowtype; code text; exp timestamptz;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  select t.* into me from cl_terminals t join cl_branches b on b.id = t.branch_id
   where t.vendor_id = v.id and t.active and b.is_main;
  if not found then raise exception 'Only a main-branch terminal can add terminals' using errcode = 'P0001'; end if;

  if (p_branch_id is null) = (nullif(btrim(coalesce(p_new_branch_name,'')), '') is null) then
    raise exception 'Give either a branch or a new branch name';
  end if;
  if p_branch_id is not null then
    select * into target from cl_branches where id = p_branch_id and business_id = me.business_id;
    if not found then raise exception 'Branch not found in this business'; end if;
  else
    select * into target from cl_branches where business_id = me.business_id and cl_branch_key(name) = cl_branch_key(p_new_branch_name);
    if not found then
      insert into cl_branches (business_id, name, is_main) values (me.business_id, btrim(p_new_branch_name), false)
      returning * into target;
    end if;
  end if;

  exp := now() + make_interval(hours => greatest(1, least(coalesce(p_valid_hours, 24), 72)));
  loop
    code := cl_new_join_code();
    begin
      insert into cl_branch_join_codes (branch_id, code_hash, issued_by_terminal, expires_ts)
      values (target.id, encode(extensions.digest(code, 'sha256'), 'hex'), me.id, exp);
      exit;
    exception when unique_violation then -- astronomically rare: draw again
    end;
  end loop;
  return json_build_object('code', substr(code,1,4) || '-' || substr(code,5,4),
    'branch_id', target.id, 'branch_name', target.name, 'expires_ts', exp);
end $fn$;

-- Links this install to the code's business and branch as a new till.
-- p_secret_phrase: the BUSINESS phrase as typed. p_device_phrase: this
-- install's own stored phrase when it differs (an existing remote device
-- that registered with its own phrase); defaults to p_secret_phrase.
-- Never creates a business; creates this install's own cl_vendors row only
-- if it has none yet (same columns check-in would set).
create function public.cl_terminal_join(
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

-- The business's branches (decision 4), for pickers. Terminals are listed
-- only to main-branch callers (Settings -> Business & Terminals).
create function public.cl_branch_list(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; me cl_terminals%rowtype; caller_main boolean;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  select * into me from cl_terminals where vendor_id = v.id and active;
  if not found then raise exception 'This device is not a registered terminal' using errcode = 'P0002'; end if;
  select is_main into caller_main from cl_branches where id = me.branch_id;
  return json_build_object(
    'business_id', me.business_id,
    'business_name', (select name from cl_businesses where id = me.business_id),
    'branches', coalesce((select json_agg(json_build_object(
        'id', b.id, 'name', b.name, 'is_main', b.is_main,
        'terminals', case when caller_main then coalesce((select json_agg(json_build_object(
            'id', t.id, 'till_code', t.till_code, 'label', t.label, 'active', t.active,
            'registered_ts', t.registered_ts, 'last_seen_ts', t.last_seen_ts) order by t.till_code)
          from cl_terminals t where t.branch_id = b.id), '[]'::json) else null end)
        order by b.is_main desc, b.name)
      from cl_branches b where b.business_id = me.business_id), '[]'::json));
end $fn$;

grant execute on function public.cl_branch_register(text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.cl_branch_issue_join_code(text, text, text, uuid, text, int) to anon, authenticated;
grant execute on function public.cl_terminal_join(text, text, text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.cl_branch_list(text, text, text) to anon, authenticated;


-- 4. cl_device_checkin: case-insensitive phrase, device_key guard ------
-- Signature gains p_device_key (default null). PostgREST can't choose
-- between two overloads that differ only by a defaulted argument, so the
-- old one is dropped, not overloaded. Old app versions that don't send
-- p_device_key still work until their row has a key recorded.
-- Everything else (insert columns, update columns, messages, reply) is
-- the live body from 2026-10-04 unchanged, plus two additive reply keys.
drop function public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid);

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

-- same grants as live (PUBLIC, anon, authenticated, service_role)
grant execute on function public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid, text)
  to public, anon, authenticated, service_role;

commit;
