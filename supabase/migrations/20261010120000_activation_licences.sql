-- =====================================================================
-- Activation v2: signed licences (docs/activation/activation-v2-design.md,
-- "Owner decisions" 2026-10-07).
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261010120000_activation_licences.rollback.sql
-- Tested in PGlite: supabase/tests/activation-licences-test.js
--
-- What it adds (nothing existing is changed):
--   * cl_licences: one row per licence. The payload (what gets signed) is
--     built HERE, so the Edge Function only ever signs what the database
--     prepared. The short code is never stored, only its sha256.
--   * Staff RPCs (role authenticated + a cl_login staff token with the
--     "Activation Codes" module, key activation_codes, or sysadmin):
--       cl_licence_prepare   reserve serial(s), build payload(s), make short code(s)
--       cl_licence_attach    store the signature from the Edge Function -> the licence
--       cl_licence_list / cl_licence_revoke / cl_vendor_repeat_installs
--   * Device RPCs (install ID + phrase + device key, like every device RPC):
--       cl_licence_redeem    short code -> licence; single use, rate-limited
--       cl_licence_pending   a registered till fetches a licence issued for it
-- The private signing key is never in the database (Edge Function secret).
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'table cl_vendors' n where to_regclass('public.cl_vendors') is null
    union all select 'table cl_businesses' where to_regclass('public.cl_businesses') is null
    union all select 'table cl_terminals' where to_regclass('public.cl_terminals') is null
    union all select 'table cl_staff' where to_regclass('public.cl_staff') is null
    union all select 'table cl_ledger_entries' where to_regclass('public.cl_ledger_entries') is null
    union all select 'table cl_activation_pricing' where to_regclass('public.cl_activation_pricing') is null
    union all select 'table cl_activity_log' where to_regclass('public.cl_activity_log') is null
    union all select 'function cl_install_vendor' where to_regprocedure('public.cl_install_vendor(text,text,text,boolean,text,text)') is null
    union all select 'function cl_has_module_access' where to_regprocedure('public.cl_has_module_access(text)') is null
    union all select 'function cl_norm_phrase' where to_regprocedure('public.cl_norm_phrase(text)') is null
    union all select 'function extensions.digest' where to_regprocedure('extensions.digest(bytea,text)') is null
  ) x;
  if missing is not null then raise exception 'activation_licences aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_licences' n where to_regclass('public.cl_licences') is not null
    union all select 'table cl_licence_redeem_failures' where to_regclass('public.cl_licence_redeem_failures') is not null
    union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cl_licence_prepare','cl_licence_attach','cl_licence_list','cl_licence_revoke','cl_licence_redeem',
                      'cl_licence_pending','cl_vendor_repeat_installs','cl_licence_staff_ok','cl_licence_hash','cl_licence_tag',
                      'cl_licence_new_code','cl_licence_b64url','cl_licence_binding_ok')
  ) x;
  if conflicts is not null then raise exception 'activation_licences aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;


-- 1. Tables ---------------------------------------------------------------
create table public.cl_licences (
  serial          integer generated always as identity (start with 1001) primary key,
  key_id          smallint not null check (key_id between 1 and 255),
  install_id      text not null check (install_id ~ '^[A-Z0-9]{4,8}$'),
  device_tag      text not null check (device_tag ~ '^[A-HJ-NP-Z2-9]{4}$'),
  binding         bytea not null check (length(binding) = 8),     -- first 8 bytes of sha512(device_key), or the tag's 20 bits
  strong_binding  boolean not null,                               -- true: the server knew the device key
  vendor_id       uuid references public.cl_vendors(id) on delete set null,
  business_id     uuid references public.cl_businesses(id) on delete set null,
  terminal_id     uuid references public.cl_terminals(id) on delete set null,
  plan            smallint not null default 0 check (plan between 0 and 255),
  features        integer not null default 0 check (features between 0 and 65535),
  days            integer not null check (days in (30, 90, 365)),
  valid_from      date not null,
  valid_to        date not null,
  payload         bytea not null,
  licence         text,                                           -- 'SL2.' + base64url(payload || signature); null until signed
  short_code_hash text not null unique,                           -- sha256 hex of the 10-character short code
  status          text not null default 'pending' check (status in ('pending', 'issued', 'redeemed', 'revoked')),
  note            text,
  issued_by       uuid not null references public.cl_staff(id),
  issued_at       timestamptz not null default now(),
  signed_at       timestamptz,
  redeemed_at     timestamptz,
  redeemed_via    text check (redeemed_via in ('code', 'checkin')),
  revoked_at      timestamptz,
  revoked_by      uuid references public.cl_staff(id),
  revoke_reason   text,
  ledger_entry_id uuid references public.cl_ledger_entries(id) on delete set null,
  check (valid_to > valid_from)
);
create index cl_licences_install_idx on public.cl_licences (install_id, serial desc);
create index cl_licences_business_idx on public.cl_licences (business_id, serial desc);
comment on table public.cl_licences is 'Activation v2 licences (signed by the issue-licence Edge Function). Short codes are stored only as sha256.';

create table public.cl_licence_redeem_failures (
  install_id text not null,
  ts         timestamptz not null default now(),
  reason     text not null
);
create index cl_licence_redeem_failures_idx on public.cl_licence_redeem_failures (install_id, ts);

alter table public.cl_licences enable row level security;
alter table public.cl_licence_redeem_failures enable row level security;
revoke all on table public.cl_licences, public.cl_licence_redeem_failures from public, anon, authenticated;


-- 2. Internal helpers (not callable by anon / authenticated) ---------------
-- The staff check every staff RPC starts with.
create function public.cl_licence_staff_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(cl_jwt_user_type() = 'staff', false)
     and exists (select 1 from cl_staff s where s.id = cl_jwt_sub() and s.active)
     and (cl_jwt_is_sysadmin() or cl_has_module_access('activation_codes'))
$$;

create function public.cl_licence_hash(p_device_key text) returns bytea
language sql immutable set search_path = public as $$
  select extensions.digest(convert_to(coalesce(p_device_key, ''), 'UTF8'), 'sha512')
$$;

-- 4 characters = the first 20 bits of a hash (the app's deviceTag()).
create function public.cl_licence_tag(h bytea) returns text
language sql immutable as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
           (((get_byte(h,0) << 12) | (get_byte(h,1) << 4) | (get_byte(h,2) >> 4)) >> (15 - 5*i) & 31) + 1, 1), '' order by i)
  from generate_series(0, 3) i
$$;

-- Does a device key match a stored binding? (strong: 8 bytes; weak: the tag's 20 bits)
create function public.cl_licence_binding_ok(p_binding bytea, p_strong boolean, p_device_key text) returns boolean
language sql immutable set search_path = public as $$
  select case when p_strong then substring(cl_licence_hash(p_device_key) from 1 for 8) = p_binding
              else cl_licence_tag(cl_licence_hash(p_device_key)) = cl_licence_tag(p_binding) end
$$;

-- 10 random characters from the install-ID alphabet (50 bits).
create function public.cl_licence_new_code() returns text
language sql volatile set search_path = public as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (get_byte(b, i) & 31) + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(10) b) r, generate_series(0, 9) i
$$;

create function public.cl_licence_b64url(b bytea) returns text
language sql immutable as $$
  select rtrim(translate(replace(encode(b, 'base64'), E'\n', ''), '+/', '-_'), '=')
$$;

revoke all on function public.cl_licence_staff_ok(), public.cl_licence_hash(text), public.cl_licence_tag(bytea),
  public.cl_licence_binding_ok(bytea, boolean, text), public.cl_licence_new_code(), public.cl_licence_b64url(bytea)
  from public, anon, authenticated;


-- 3. Staff: prepare licence(s) ---------------------------------------------
-- Either p_device_code ('ABCD-K7Q2', what the shop's screen shows) or
-- p_business_id (one licence per active till of that business). Returns
-- { licences: [ { serial, payload_hex, short_code, device_code, ... } ],
--   skipped: [ { till_code, install_id, reason } ] }.
-- The short code is returned only here, once.
create function public.cl_licence_prepare(p_device_code text default null, p_business_id uuid default null,
                                          p_days integer default 30, p_plan integer default 0,
                                          p_key_id integer default 1, p_note text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_staff uuid := cl_jwt_sub();
  v_from date := (now() at time zone 'Africa/Harare')::date;
  v_to date;
  t record;
  out_rows json[] := '{}';
  skipped json[] := '{}';
  v_install text; v_tag text; v_hash bytea; v_binding bytea; v_strong boolean;
  v_code text; v_payload bytea; v_serial integer; v_flags integer;
  v_biz_bytes bytea; v_vendor cl_vendors%rowtype;
begin
  if not cl_licence_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_days not in (30, 90, 365) then raise exception 'Days must be 30, 90 or 365'; end if;
  if p_plan is null or p_plan < 0 or p_plan > 255 then raise exception 'Plan must be 0..255'; end if;
  if p_key_id is null or p_key_id < 1 or p_key_id > 255 then raise exception 'Key ID must be 1..255'; end if;
  if (p_device_code is null) = (p_business_id is null) then raise exception 'Give either a device code or a business'; end if;
  if p_device_code is not null and upper(regexp_replace(p_device_code, '\s', '', 'g')) !~ '^[A-Z0-9]{4,8}-[A-HJ-NP-Z2-9]{4}$' then
    raise exception 'Device code must look like ABCD-K7Q2 (install ID, dash, 4 characters)';
  end if;
  v_to := v_from + p_days;

  for t in
    select x.install_id, x.tag, x.vendor_id, x.business_id, x.terminal_id, x.till_code, x.branch_name, x.business_name
    from (
      -- one device, by the code on its screen
      select upper(split_part(regexp_replace(p_device_code, '\s', '', 'g'), '-', 1)) install_id,
             upper(split_part(regexp_replace(p_device_code, '\s', '', 'g'), '-', 2)) tag,
             vd.id vendor_id, te.business_id, te.id terminal_id, te.till_code, br.name branch_name, bz.name business_name
      from (select 1) one
      left join cl_vendors vd on vd.install_id = upper(split_part(regexp_replace(p_device_code, '\s', '', 'g'), '-', 1))
      left join cl_terminals te on te.install_id = vd.install_id
      left join cl_branches br on br.id = te.branch_id
      left join cl_businesses bz on bz.id = te.business_id
      where p_device_code is not null
      union all
      -- every active till of a business (the tag comes from the device key the server holds)
      select te.install_id, null, te.vendor_id, te.business_id, te.id, te.till_code, br.name, bz.name
      from cl_terminals te join cl_branches br on br.id = te.branch_id join cl_businesses bz on bz.id = te.business_id
      where p_business_id is not null and te.business_id = p_business_id and te.active
    ) x
    order by x.branch_name nulls first, x.till_code nulls first
  loop
    v_install := t.install_id;
    select * into v_vendor from cl_vendors where id = t.vendor_id;
    if v_install !~ '^[A-Z0-9]{4,8}$' then raise exception 'Device code must look like ABCD-K7Q2 (install ID, dash, 4 characters)'; end if;
    if v_vendor.device_key is not null then
      v_hash := cl_licence_hash(v_vendor.device_key);
      v_tag := cl_licence_tag(v_hash);
      if t.tag is not null and t.tag <> v_tag then
        raise exception 'DEVICE_CODE_MISMATCH: % is not the code of install % (check the 4 characters after the dash)', p_device_code, v_install;
      end if;
      v_binding := substring(v_hash from 1 for 8);
      v_strong := true;
    elsif t.tag is not null then
      if t.tag !~ '^[A-HJ-NP-Z2-9]{4}$' then raise exception 'Device code must look like ABCD-K7Q2 (install ID, dash, 4 characters)'; end if;
      v_tag := t.tag;
      -- the tag's 20 bits, left-aligned in 3 bytes, then zeros
      v_flags := ((strpos('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', substr(v_tag,1,1)) - 1) << 15)
               | ((strpos('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', substr(v_tag,2,1)) - 1) << 10)
               | ((strpos('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', substr(v_tag,3,1)) - 1) << 5)
               |  (strpos('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', substr(v_tag,4,1)) - 1);
      v_binding := set_byte(set_byte(set_byte('\x0000000000000000'::bytea, 0, (v_flags >> 12) & 255), 1, (v_flags >> 4) & 255), 2, (v_flags & 15) << 4);
      v_strong := false;
    else
      skipped := skipped || json_build_object('till_code', t.till_code, 'branch', t.branch_name, 'install_id', v_install,
                                              'reason', 'NO_DEVICE_KEY');
      continue;
    end if;

    v_code := cl_licence_new_code();
    insert into cl_licences (key_id, install_id, device_tag, binding, strong_binding, vendor_id, business_id, terminal_id,
                             plan, days, valid_from, valid_to, payload, short_code_hash, note, issued_by)
    values (p_key_id, v_install, v_tag, v_binding, v_strong, t.vendor_id, t.business_id, t.terminal_id,
            p_plan, p_days, v_from, v_to, '\x'::bytea, encode(extensions.digest(v_code, 'sha256'), 'hex'), p_note, v_staff)
    returning serial into v_serial;

    -- payload (activation.js parseLicence): version, key, serial, install ID (8, NUL-padded),
    -- binding (8), issued day, valid-until day, plan, flags, features, [business ID]
    v_biz_bytes := case when t.business_id is null then '\x'::bytea else decode(replace(t.business_id::text, '-', ''), 'hex') end;
    v_flags := (case when v_strong then 1 else 0 end) | (case when t.business_id is null then 0 else 2 end);
    v_payload := set_byte('\x00'::bytea, 0, 2) || set_byte('\x00'::bytea, 0, p_key_id)
      || int4send(v_serial)
      || convert_to(v_install, 'UTF8') || substring('\x0000000000000000'::bytea from 1 for 8 - length(v_install))
      || v_binding
      || substring(int4send(v_from - date '2026-01-01') from 3 for 2)
      || substring(int4send(v_to - date '2026-01-01') from 3 for 2)
      || set_byte('\x00'::bytea, 0, p_plan) || set_byte('\x00'::bytea, 0, v_flags)
      || '\x0000'::bytea
      || v_biz_bytes;
    update cl_licences set payload = v_payload where serial = v_serial;

    out_rows := out_rows || json_build_object('serial', v_serial, 'payload_hex', encode(v_payload, 'hex'),
      'short_code', substr(v_code,1,4) || '-' || substr(v_code,5,4) || '-' || substr(v_code,9,2),
      'device_code', v_install || '-' || v_tag, 'install_id', v_install, 'strong_binding', v_strong,
      'business_id', t.business_id, 'business_name', t.business_name, 'branch', t.branch_name, 'till_code', t.till_code,
      'valid_from', v_from, 'valid_to', v_to, 'days', p_days);
  end loop;

  if p_device_code is not null and array_length(out_rows, 1) is null and array_length(skipped, 1) is null then
    raise exception 'Device code not recognised';
  end if;
  return json_build_object('licences', to_json(out_rows), 'skipped', to_json(skipped));
end $fn$;


-- 4. Staff: attach the Edge Function's signature -> the licence ----------
create function public.cl_licence_attach(p_serial integer, p_signature_hex text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  l cl_licences%rowtype; v_sig bytea; v_rate cl_activation_pricing%rowtype; v_ledger uuid; v_amount numeric;
begin
  if not cl_licence_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into l from cl_licences where serial = p_serial for update;
  if not found then raise exception 'No such licence'; end if;
  if l.status <> 'pending' then raise exception 'Licence % is already %', p_serial, l.status; end if;
  if l.issued_by is distinct from cl_jwt_sub() then raise exception 'Only the staff member who prepared licence % can sign it', p_serial; end if;
  if p_signature_hex !~ '^[0-9a-fA-F]{128}$' then raise exception 'A signature is 64 bytes (128 hex characters)'; end if;
  v_sig := decode(p_signature_hex, 'hex');

  -- the same automatic charge cl_issue_activation_code writes, per 30 days
  if l.vendor_id is not null then
    select * into v_rate from cl_activation_pricing order by effective_from desc limit 1;
    if found then
      v_amount := round(v_rate.amount * l.days / 30.0, 2);
      insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, recorded_by, notes)
      values (l.vendor_id, 'charge', v_amount, v_rate.currency, cl_jwt_sub(),
              'Auto-charged: licence #' || l.serial || ' (' || l.days || ' days)')
      returning id into v_ledger;
    end if;
  end if;

  update cl_licences set licence = 'SL2.' || cl_licence_b64url(l.payload || v_sig), status = 'issued',
         signed_at = now(), ledger_entry_id = v_ledger
  where serial = p_serial returning * into l;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (cl_jwt_sub(), 'issue_licence', 'cl_licences', null,
          jsonb_build_object('serial', l.serial, 'install_id', l.install_id, 'device_tag', l.device_tag,
                             'business_id', l.business_id, 'days', l.days, 'valid_to', l.valid_to,
                             'plan', l.plan, 'key_id', l.key_id, 'charged', v_amount, 'note', l.note));

  return json_build_object('serial', l.serial, 'licence', l.licence, 'valid_to', l.valid_to);
end $fn$;


-- 5. Staff: list, revoke, repeat installs ----------------------------------
create function public.cl_licence_list(p_install_id text default null, p_business_id uuid default null, p_limit integer default 50)
returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not cl_licence_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return coalesce((select json_agg(r order by r.serial desc) from (
    select l.serial, l.install_id, l.device_tag, l.strong_binding, l.business_id, b.name business_name, t.till_code,
           l.days, l.valid_from, l.valid_to, l.plan, l.status, l.issued_at, s.full_name issued_by, l.signed_at,
           l.redeemed_at, l.redeemed_via, l.revoked_at, l.revoke_reason, l.note, l.licence
    from cl_licences l left join cl_businesses b on b.id = l.business_id left join cl_terminals t on t.id = l.terminal_id
         left join cl_staff s on s.id = l.issued_by
    where (p_install_id is null or l.install_id = upper(p_install_id)) and (p_business_id is null or l.business_id = p_business_id)
    order by l.serial desc limit least(greatest(coalesce(p_limit, 50), 1), 500)) r), '[]'::json);
end $fn$;

create function public.cl_licence_revoke(p_serial integer, p_reason text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare l cl_licences%rowtype;
begin
  if not cl_licence_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  update cl_licences set status = 'revoked', revoked_at = now(), revoked_by = cl_jwt_sub(), revoke_reason = p_reason
  where serial = p_serial and status <> 'revoked' returning * into l;
  if not found then raise exception 'No such licence, or already revoked'; end if;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (cl_jwt_sub(), 'revoke_licence', 'cl_licences', null, jsonb_build_object('serial', p_serial, 'reason', p_reason));
  return json_build_object('serial', l.serial, 'status', l.status);
end $fn$;

-- Q8: installs that share a shop phrase (a reinstall, or a new device of
-- the same shop). Groups are labelled by a hash, never the phrase itself.
create function public.cl_vendor_repeat_installs(p_days integer default 90)
returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not cl_licence_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return coalesce((select json_agg(g order by g.installs desc, g.last_install desc) from (
    select left(md5(cl_norm_phrase(v.shop_secret_phrase)), 8) phrase_group, count(*) installs,
           count(*) filter (where v.created_at > now() - make_interval(days => greatest(coalesce(p_days, 90), 1))) recent_installs,
           array_agg(v.install_id order by v.created_at) install_ids,
           array_agg(distinct v.business_name) business_names,
           min(v.created_at) first_install, max(v.created_at) last_install
    from cl_vendors v
    where cl_norm_phrase(v.shop_secret_phrase) <> ''
    group by cl_norm_phrase(v.shop_secret_phrase)
    having count(*) > 1) g), '[]'::json);
end $fn$;


-- 6. Devices: redeem a short code, fetch a pending licence ----------------
create function public.cl_licence_redeem(p_install_id text, p_secret_phrase text, p_device_key text, p_code text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; l cl_licences%rowtype; v_code text;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  if (select count(*) from cl_licence_redeem_failures
      where install_id = p_install_id and ts > now() - interval '15 minutes') >= 5 then
    return json_build_object('error', 'TOO_MANY_TRIES');
  end if;
  v_code := regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g');
  select * into l from cl_licences where short_code_hash = encode(extensions.digest(v_code, 'sha256'), 'hex') for update;
  if not found or l.status = 'pending' or l.licence is null then
    insert into cl_licence_redeem_failures (install_id, reason) values (p_install_id, 'INVALID_CODE');
    return json_build_object('error', 'INVALID_CODE');
  end if;
  if l.install_id <> p_install_id or not cl_licence_binding_ok(l.binding, l.strong_binding, p_device_key) then
    insert into cl_licence_redeem_failures (install_id, reason) values (p_install_id, 'WRONG_DEVICE');
    return json_build_object('error', 'WRONG_DEVICE');
  end if;
  if l.status = 'revoked' then return json_build_object('error', 'REVOKED'); end if;
  if l.valid_to < (now() at time zone 'Africa/Harare')::date then return json_build_object('error', 'EXPIRED'); end if;
  if l.status = 'redeemed' then
    -- single use: only the same device retrying within 10 minutes (a dropped answer) gets it again
    if l.redeemed_via = 'code' and l.redeemed_at > now() - interval '10 minutes' then
      return json_build_object('serial', l.serial, 'licence', l.licence, 'valid_to', l.valid_to, 'again', true);
    end if;
    return json_build_object('error', 'ALREADY_USED');
  end if;
  update cl_licences set status = 'redeemed', redeemed_at = now(), redeemed_via = 'code' where serial = l.serial;
  return json_build_object('serial', l.serial, 'licence', l.licence, 'valid_to', l.valid_to);
end $fn$;

create function public.cl_licence_pending(p_install_id text, p_secret_phrase text, p_device_key text, p_after_serial integer default 0)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; l cl_licences%rowtype;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  select * into l from cl_licences
  where install_id = p_install_id and status in ('issued', 'redeemed') and licence is not null
    and serial > coalesce(p_after_serial, 0) and valid_to >= (now() at time zone 'Africa/Harare')::date
    and cl_licence_binding_ok(binding, strong_binding, p_device_key)
  order by serial desc limit 1 for update;
  if not found then return json_build_object('licence', null); end if;
  if l.status = 'issued' then
    update cl_licences set status = 'redeemed', redeemed_at = now(), redeemed_via = 'checkin' where serial = l.serial;
  end if;
  return json_build_object('serial', l.serial, 'licence', l.licence, 'valid_to', l.valid_to);
end $fn$;


-- 7. Who may call what ------------------------------------------------------
revoke all on function public.cl_licence_prepare(text, uuid, integer, integer, integer, text), public.cl_licence_attach(integer, text),
  public.cl_licence_list(text, uuid, integer), public.cl_licence_revoke(integer, text), public.cl_vendor_repeat_installs(integer),
  public.cl_licence_redeem(text, text, text, text), public.cl_licence_pending(text, text, text, integer)
  from public, anon, authenticated;
-- staff (cl_login tokens carry role 'authenticated'; the function checks the rest)
grant execute on function public.cl_licence_prepare(text, uuid, integer, integer, integer, text), public.cl_licence_attach(integer, text),
  public.cl_licence_list(text, uuid, integer), public.cl_licence_revoke(integer, text), public.cl_vendor_repeat_installs(integer)
  to authenticated;
-- devices (the app calls with the anon key, like every device RPC)
grant execute on function public.cl_licence_redeem(text, text, text, text), public.cl_licence_pending(text, text, text, integer)
  to anon, authenticated;

commit;
