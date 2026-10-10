-- =====================================================================
-- Trial rules: no anonymous trials (owner: "go Trial-B", 2026-10-10, with
-- the Stage A recommendations accepted; a till added after the trial ends
-- needs a paid licence). Applied live only after the owner has seen this
-- file and said "apply".
-- Design: docs/activation/trial-rules-design.md
-- Rollback: supabase/rollbacks/20261019120000_trial_rules.rollback.sql
-- Tested in PGlite: supabase/tests/trial-rules-test.js
--
-- 1. cl_norm_phone: one phone number, one spelling (07x / +2637x / 2637x /
--    002637x are the same Zimbabwe mobile; other countries need +country).
-- 2. cl_trials: one row per free trial. ONE standard trial per phone number,
--    ever (unique), one per install (unique), one per business (checked).
--    cl_trial_refusals keeps every refused attempt; cl_trial_exceptions holds
--    a SysAdmin's allowance for one more trial (phone or install, reason,
--    1-30 days), used up by the device's next request.
-- 3. cl_licences: kind 'paid' | 'trial' and trial_id. A trial licence has no
--    staff member (issued_by null), no price and no ledger entry, so it
--    earns no RPN commission. Its payload sets flags bit 4 (trial).
-- 4. cl_trial_request (device: install ID + phrase + device key, called by
--    the issue-trial Edge Function with the anon key): ONE transaction checks
--    the device, rate limits, the phone, the RPN (field force number + PIN,
--    active), the Q8 rule (no sales older than 30 days), one per phone and
--    per business, links the RPN, records the trial and prepares the signed
--    licence's payload. Idempotent per install. A joined till of a business
--    whose trial is running gets a cover licence to the same end date.
--    cl_trial_attach (service_role ONLY: the Edge Function) stores the
--    signature. A lost answer reaches the till by cl_licence_pending.
-- 5. Console: cl_trials_list, cl_trial_refusals_list (Activation Codes
--    module or SysAdmin), cl_trial_exception_grant / cl_trial_exceptions_list
--    (SysAdmin), cl_rpn_trial_stats (RPN Directory permissions).
-- 6. The vendor and business delete guards also count trials.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_trials' n where to_regclass('public.cl_trials') is not null
    union all select 'table cl_trial_refusals' where to_regclass('public.cl_trial_refusals') is not null
    union all select 'table cl_trial_exceptions' where to_regclass('public.cl_trial_exceptions') is not null
    union all select 'column cl_licences.kind' where exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cl_licences' and column_name in ('kind', 'trial_id'))
  ) x;
  if conflicts is not null then raise exception 'trial_rules aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'table cl_licences' n where to_regclass('public.cl_licences') is null
    union all select 'table cl_rpn_pins (20261015120000)' where to_regclass('public.cl_rpn_pins') is null
    union all select 'table cl_suppliers (20261018120000)' where to_regclass('public.cl_suppliers') is null
    union all select 'function ' || f from unnest(array['public.cl_install_vendor(text,text,text,boolean,text,text)',
        'public.cl_device_link_rpn(text,text,text,text,text)', 'public.cl_vendor_business(uuid)', 'public.cl_licence_staff_ok()',
        'public.cl_licence_hash(text)', 'public.cl_licence_tag(bytea)', 'public.cl_licence_new_code()', 'public.cl_licence_b64url(bytea)',
        'public.cl_norm_phrase(text)', 'public.cl_rpn_staff(text[])', 'public.cl_rpn_reason(text)', 'public.cl_acting_staff()']) f
      where to_regprocedure(f) is null
  ) x;
  if missing is not null then raise exception 'trial_rules aborted: missing %. Nothing was changed.', missing; end if;
end $$;


-- 1. Phone numbers ----------------------------------------------------------
-- Digits only, country code first, no "+": 263771234567. Null = not a phone
-- number we accept. Zimbabwe mobiles (071, 073, 077, 078) in any common
-- spelling; another country only with its code typed (+ or 00).
create function public.cl_norm_phone(p text) returns text
language plpgsql immutable as $fn$
declare raw text := btrim(coalesce(p, '')); d text; intl boolean;
begin
  if raw = '' or raw ~ '[^0-9+() .\-]' then return null; end if;
  intl := raw ~ '^(\+|00)';
  d := regexp_replace(raw, '[^0-9]', '', 'g');
  if raw ~ '^00' then d := substr(d, 3); end if;
  if not intl then
    if d ~ '^0[0-9]{9}$' then d := '263' || substr(d, 2);
    elsif d ~ '^7[0-9]{8}$' then d := '263' || d;
    elsif d !~ '^263[0-9]{9}$' then return null;
    end if;
  end if;
  if d ~ '^263' then return case when d ~ '^2637[1378][0-9]{7}$' then d end; end if;
  return case when d ~ '^[1-9][0-9]{7,14}$' then d end;
end $fn$;


-- 2. Tables -------------------------------------------------------------------
create table public.cl_trial_exceptions (
  id            uuid primary key default gen_random_uuid(),
  phone_norm    text,
  install_id    text check (install_id is null or install_id ~ '^[A-Z0-9]{4,8}$'),
  days          integer not null check (days between 1 and 30),
  reason        text not null,
  granted_by    uuid not null references public.cl_staff(id),
  granted_at    timestamptz not null default now(),
  used_at       timestamptz,
  used_by_trial uuid,
  constraint cl_trial_exceptions_target check (phone_norm is not null or install_id is not null)
);

create table public.cl_trials (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('standard', 'exception')),
  phone_norm    text not null,
  vendor_id     uuid not null references public.cl_vendors(id) on delete restrict,
  install_id    text not null unique,
  business_id   uuid references public.cl_businesses(id) on delete restrict,   -- the business at the time, if it had one
  rpn_id        uuid references public.cl_rpn(id) on delete restrict,
  exception_id  uuid references public.cl_trial_exceptions(id) on delete restrict,
  started_on    date not null,
  ends_on       date not null,
  shop_name     text,
  name_key      text,           -- the shop name as compared: lower case, letters and digits only
  phrase_group  text,           -- left(md5(normalised shop phrase), 8): never the phrase itself
  device_hash   text,           -- left(md5(device key), 12)
  earliest_sale date,
  created_at    timestamptz not null default now(),
  check (ends_on > started_on),
  check ((kind = 'exception') = (exception_id is not null))
);
create unique index cl_trials_phone_standard_uidx on public.cl_trials (phone_norm) where kind = 'standard';
create index cl_trials_vendor_idx on public.cl_trials (vendor_id);
create index cl_trials_business_idx on public.cl_trials (business_id);
create index cl_trials_rpn_idx on public.cl_trials (rpn_id, created_at);
alter table public.cl_trial_exceptions add constraint cl_trial_exceptions_trial_fkey
  foreign key (used_by_trial) references public.cl_trials(id) on delete restrict;

create table public.cl_trial_refusals (
  id             bigint generated always as identity primary key,
  install_id     text not null,
  vendor_id      uuid references public.cl_vendors(id) on delete set null,
  phone_norm     text,
  rpn_id         uuid references public.cl_rpn(id) on delete set null,
  field_force_no text,
  code           text not null,
  created_at     timestamptz not null default now()
);
create index cl_trial_refusals_install_idx on public.cl_trial_refusals (install_id, created_at);
create index cl_trial_refusals_phone_idx on public.cl_trial_refusals (phone_norm, created_at);
create index cl_trial_refusals_rpn_idx on public.cl_trial_refusals (rpn_id, created_at);

-- Licences: paid (staff, priced, charged) or trial (no staff, no price, no charge).
alter table public.cl_licences
  add column kind text not null default 'paid' check (kind in ('paid', 'trial')),
  add column trial_id uuid references public.cl_trials(id) on delete restrict;
alter table public.cl_licences alter column issued_by drop not null;
alter table public.cl_licences add constraint cl_licences_kind_shape check (
  (kind = 'paid' and issued_by is not null and trial_id is null)
  or (kind = 'trial' and issued_by is null and trial_id is not null and amount is null));
create unique index cl_licences_trial_till_uidx on public.cl_licences (trial_id, install_id) where kind = 'trial';
comment on column public.cl_licences.kind is 'Trial rules (20261019120000): paid = issued by staff (priced, charged); trial = granted by cl_trial_request (no staff, no price, no ledger entry).';


-- 3. Internal helpers (not callable through the API) -------------------------
-- The plain message for a refusal code.
create function public.cl_trial_message(p_code text, p_date date default null) returns text
language sql immutable as $$
  select case p_code
    when 'PHONE_INVALID' then 'Enter the owner''s phone number, e.g. 07x xxx xxxx or +263 7x xxx xxxx.'
    when 'PHONE_USED' then 'This phone number has already used its free trial. Ask your RPN about a licence.'
    when 'BUSINESS_HAD_TRIAL' then 'This business has already had its free trial. Ask your RPN about a licence.'
    when 'TRIAL_OLD_DATA' then 'This shop has sales from ' || to_char(p_date, 'FMDD Mon YYYY') || ', more than 30 days ago, so a free trial can''t start. Ask your RPN about a licence.'
    when 'BUSINESS_TRIAL_ENDED' then 'This business''s free trial ended on ' || to_char(p_date, 'FMDD Mon YYYY') || '. Ask your RPN about a licence for this till.'
    when 'TRIAL_ENDS_TODAY' then 'This business''s free trial ends today, so this till can''t join it. Ask your RPN about a licence for this till.'
    when 'NO_BUSINESS_TRIAL' then 'This till belongs to a business with no free trial running. Ask your RPN about a licence for this till.'
    when 'RPN_MISSING' then 'Your RPN types their field force number and PIN here to start your free trial.'
    when 'RPN_NO_MATCH' then 'That field force number and PIN don''t match. Check them with your RPN.'
    when 'RPN_SUSPENDED' then 'That RPN isn''t active at the moment, so the free trial can''t start. Ask Digital Commerce.'
    when 'RPN_TOO_MANY_TRIES' then 'Too many tries. Wait an hour, or ask Digital Commerce.'
    when 'TOO_MANY_TRIES' then 'Too many tries. Wait an hour, or ask your RPN.'
    when 'NO_DEVICE_KEY' then 'This device must check in with Digital Commerce again before the trial can start. Connect to the internet and try again.'
    else 'The free trial couldn''t start (' || coalesce(p_code, '?') || ').' end
$$;

-- Build (or rebuild) the payload of a trial licence row: the same layout as
-- cl_licence_prepare, with flags bit 4 = trial. Returns the payload.
create function public.cl_trial_payload(p_serial integer) returns bytea
language plpgsql security definer set search_path = public as $fn$
declare l cl_licences%rowtype; v_biz bytea; v_flags integer; v_payload bytea;
begin
  select * into l from cl_licences where serial = p_serial and kind = 'trial' for update;
  if not found then raise exception 'No such trial licence'; end if;
  v_biz := case when l.business_id is null then '\x'::bytea else decode(replace(l.business_id::text, '-', ''), 'hex') end;
  v_flags := (case when l.strong_binding then 1 else 0 end) | (case when l.business_id is null then 0 else 2 end) | 4;
  v_payload := set_byte('\x00'::bytea, 0, 2) || set_byte('\x00'::bytea, 0, l.key_id)
    || int4send(l.serial)
    || convert_to(l.install_id, 'UTF8') || substring('\x0000000000000000'::bytea from 1 for 8 - length(l.install_id))
    || l.binding
    || substring(int4send(l.valid_from - date '2026-01-01') from 3 for 2)
    || substring(int4send(l.valid_to - date '2026-01-01') from 3 for 2)
    || set_byte('\x00'::bytea, 0, l.plan) || set_byte('\x00'::bytea, 0, v_flags)
    || '\x0000'::bytea
    || v_biz;
  update cl_licences set payload = v_payload where serial = p_serial;
  return v_payload;
end $fn$;

-- Insert a pending trial licence for one till and build its payload.
create function public.cl_trial_new_licence(p_trial uuid, v cl_vendors, p_business uuid, p_terminal uuid,
                                            p_to date, p_key_id integer) returns integer
language plpgsql security definer set search_path = public as $fn$
declare v_hash bytea := cl_licence_hash(v.device_key); v_serial integer;
begin
  insert into cl_licences (key_id, install_id, device_tag, binding, strong_binding, vendor_id, business_id, terminal_id,
                           plan, days, valid_from, valid_to, payload, short_code_hash, note, issued_by, kind, trial_id)
  values (p_key_id, v.install_id, cl_licence_tag(v_hash), substring(v_hash from 1 for 8), true, v.id, p_business, p_terminal,
          0, 30, (now() at time zone 'Africa/Harare')::date, p_to, '\x'::bytea,
          encode(extensions.digest(cl_licence_new_code(), 'sha256'), 'hex'), 'Free trial', null, 'trial', p_trial)
  returning serial into v_serial;
  perform cl_trial_payload(v_serial);
  return v_serial;
end $fn$;

-- The answer a device gets for its trial licence row.
create function public.cl_trial_answer(p_serial integer, p_kind text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('ok', true, 'kind', p_kind, 'serial', l.serial, 'trial_id', l.trial_id,
    'valid_from', l.valid_from, 'valid_to', l.valid_to, 'licence', l.licence,
    'payload_hex', case when l.licence is null then encode(l.payload, 'hex') end)
  from cl_licences l where l.serial = p_serial
$$;

revoke all on function public.cl_trial_message(text, date), public.cl_trial_payload(integer),
  public.cl_trial_new_licence(uuid, public.cl_vendors, uuid, uuid, date, integer), public.cl_trial_answer(integer, text)
  from public, anon, authenticated;


-- 4. The device asks for its free trial -------------------------------------
-- Refusals are answers ({ok:false, code, message}), not errors, so the
-- refused attempt is kept. p_key_id: which public key the Edge Function signs
-- with (its LICENCE_KEY_ID). p_earliest_sale: the device's oldest sale (Q8).
create function public.cl_trial_request(p_install_id text, p_secret_phrase text, p_device_key text,
                                        p_phone text default null, p_field_force_no text default null, p_pin text default null,
                                        p_earliest_sale date default null, p_key_id integer default 1) returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v cl_vendors%rowtype; r cl_rpn%rowtype; t cl_trials%rowtype; x cl_trial_exceptions%rowtype;
  v_today date := (now() at time zone 'Africa/Harare')::date;
  v_biz uuid; v_creator boolean; v_term uuid; v_serial integer; v_phone text; v_ff text := upper(btrim(coalesce(p_field_force_no, '')));
  v_link json; v_kind text := 'standard'; v_days integer := 30; v_trial uuid;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  perform pg_advisory_xact_lock(hashtext('cl_trial_request:' || p_install_id));
  if p_key_id is null or p_key_id < 1 or p_key_id > 255 then raise exception 'Key ID must be 1..255'; end if;
  v_biz := cl_vendor_business(v.id);
  select id into v_term from cl_terminals where vendor_id = v.id;

  -- (a) idempotent: this install already has its trial (or its cover licence)
  select l.serial into v_serial from cl_licences l where l.kind = 'trial' and l.install_id = v.install_id order by l.serial desc limit 1;
  if found then
    update cl_licences set key_id = p_key_id where serial = v_serial and licence is null and key_id <> p_key_id;
    if (select licence is null from cl_licences where serial = v_serial) then perform cl_trial_payload(v_serial); end if;
    return cl_trial_answer(v_serial, case when exists (select 1 from cl_trials where install_id = v.install_id) then 'standard' else 'cover' end);
  end if;
  if v.device_key is null then return json_build_object('ok', false, 'code', 'NO_DEVICE_KEY', 'message', cl_trial_message('NO_DEVICE_KEY')); end if;

  -- (b) a till that joined a business (not the till that created it): the business's trial, or nothing
  v_creator := v_biz is null or exists (select 1 from cl_businesses b where b.id = v_biz and b.created_by_vendor_id = v.id);
  if not v_creator then
    select tr.* into t from cl_trials tr where tr.business_id = v_biz or cl_vendor_business(tr.vendor_id) = v_biz
     order by tr.ends_on desc limit 1;
    if not found then
      insert into cl_trial_refusals (install_id, vendor_id, code) values (v.install_id, v.id, 'NO_BUSINESS_TRIAL');
      return json_build_object('ok', false, 'code', 'NO_BUSINESS_TRIAL', 'message', cl_trial_message('NO_BUSINESS_TRIAL'));
    end if;
    if t.ends_on < v_today then
      insert into cl_trial_refusals (install_id, vendor_id, code) values (v.install_id, v.id, 'BUSINESS_TRIAL_ENDED');
      return json_build_object('ok', false, 'code', 'BUSINESS_TRIAL_ENDED', 'message', cl_trial_message('BUSINESS_TRIAL_ENDED', t.ends_on));
    end if;
    if t.ends_on = v_today then
      insert into cl_trial_refusals (install_id, vendor_id, code) values (v.install_id, v.id, 'TRIAL_ENDS_TODAY');
      return json_build_object('ok', false, 'code', 'TRIAL_ENDS_TODAY', 'message', cl_trial_message('TRIAL_ENDS_TODAY'));
    end if;
    v_serial := cl_trial_new_licence(t.id, v, v_biz, v_term, t.ends_on, p_key_id);
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (null, 'trial_cover', 'cl_trials', t.id, jsonb_build_object('install_id', v.install_id, 'serial', v_serial, 'ends_on', t.ends_on));
    return cl_trial_answer(v_serial, 'cover');
  end if;

  -- (c) rate limits: this install, this phone, this field force number
  v_phone := cl_norm_phone(p_phone);
  if (select count(*) from cl_trial_refusals where install_id = v.install_id and created_at > now() - interval '1 hour') >= 10
     or (v_phone is not null and (select count(*) from cl_trial_refusals where phone_norm = v_phone and created_at > now() - interval '1 hour') >= 5) then
    return json_build_object('ok', false, 'code', 'TOO_MANY_TRIES', 'message', cl_trial_message('TOO_MANY_TRIES'));
  end if;
  if (select count(*) from cl_rpn_link_failures where install_id = v.install_id and created_at > now() - interval '1 hour') >= 5
     or (v_ff <> '' and (select count(*) from cl_rpn_link_failures where field_force_no = left(v_ff, 20) and created_at > now() - interval '1 hour') >= 10) then
    return json_build_object('ok', false, 'code', 'RPN_TOO_MANY_TRIES', 'message', cl_trial_message('RPN_TOO_MANY_TRIES'));
  end if;

  -- (d) the phone
  if v_phone is null then
    insert into cl_trial_refusals (install_id, vendor_id, code) values (v.install_id, v.id, 'PHONE_INVALID');
    return json_build_object('ok', false, 'code', 'PHONE_INVALID', 'message', cl_trial_message('PHONE_INVALID'));
  end if;

  -- (e) the RPN: number + PIN (a failure counts towards the link's limits), then active
  if v_ff = '' or coalesce(p_pin, '') = '' then
    insert into cl_trial_refusals (install_id, vendor_id, phone_norm, code) values (v.install_id, v.id, v_phone, 'RPN_MISSING');
    return json_build_object('ok', false, 'code', 'RPN_MISSING', 'message', cl_trial_message('RPN_MISSING'));
  end if;
  select * into r from cl_rpn where field_force_no = v_ff;
  if not found or not exists (select 1 from cl_rpn_pins p where p.rpn_id = r.id and p.pin_hash = extensions.crypt(p_pin, p.pin_hash)) then
    insert into cl_rpn_link_failures (install_id, field_force_no) values (v.install_id, left(v_ff, 20));
    insert into cl_trial_refusals (install_id, vendor_id, phone_norm, field_force_no, code) values (v.install_id, v.id, v_phone, left(v_ff, 20), 'RPN_NO_MATCH');
    return json_build_object('ok', false, 'code', 'RPN_NO_MATCH', 'message', cl_trial_message('RPN_NO_MATCH'));
  end if;
  if not r.active then
    insert into cl_trial_refusals (install_id, vendor_id, phone_norm, rpn_id, field_force_no, code) values (v.install_id, v.id, v_phone, r.id, v_ff, 'RPN_SUSPENDED');
    return json_build_object('ok', false, 'code', 'RPN_SUSPENDED', 'message', cl_trial_message('RPN_SUSPENDED'));
  end if;

  -- (f) Q8: a shop whose sales go back more than 30 days isn't new
  if p_earliest_sale is not null and p_earliest_sale < v_today - 30 then
    insert into cl_trial_refusals (install_id, vendor_id, phone_norm, rpn_id, field_force_no, code) values (v.install_id, v.id, v_phone, r.id, v_ff, 'TRIAL_OLD_DATA');
    return json_build_object('ok', false, 'code', 'TRIAL_OLD_DATA', 'message', cl_trial_message('TRIAL_OLD_DATA', p_earliest_sale));
  end if;

  -- (g) one trial per phone, ever, and one per business; a SysAdmin's allowance lets one more through
  if exists (select 1 from cl_trials where phone_norm = v_phone)
     or (v_biz is not null and exists (select 1 from cl_trials tr where tr.business_id = v_biz or cl_vendor_business(tr.vendor_id) = v_biz)) then
    select * into x from cl_trial_exceptions e
     where e.used_at is null and (e.phone_norm = v_phone or e.install_id = v.install_id)
     order by e.granted_at limit 1 for update;
    if not found then
      insert into cl_trial_refusals (install_id, vendor_id, phone_norm, rpn_id, field_force_no, code)
      values (v.install_id, v.id, v_phone, r.id, v_ff,
              case when exists (select 1 from cl_trials where phone_norm = v_phone) then 'PHONE_USED' else 'BUSINESS_HAD_TRIAL' end);
      return json_build_object('ok', false,
        'code', case when exists (select 1 from cl_trials where phone_norm = v_phone) then 'PHONE_USED' else 'BUSINESS_HAD_TRIAL' end,
        'message', cl_trial_message(case when exists (select 1 from cl_trials where phone_norm = v_phone) then 'PHONE_USED' else 'BUSINESS_HAD_TRIAL' end));
    end if;
    v_kind := 'exception'; v_days := x.days;
  else
    -- an unused allowance for this install or phone is used up by a normal trial too, so it can't be kept for later
    select * into x from cl_trial_exceptions e
     where e.used_at is null and (e.phone_norm = v_phone or e.install_id = v.install_id) order by e.granted_at limit 1 for update;
  end if;

  -- (h) link the RPN (the same function the app's Settings use)
  v_link := cl_device_link_rpn(p_install_id, p_secret_phrase, p_device_key, v_ff, p_pin);
  if not coalesce((v_link->>'ok')::boolean, false) then
    insert into cl_trial_refusals (install_id, vendor_id, phone_norm, rpn_id, field_force_no, code)
    values (v.install_id, v.id, v_phone, r.id, v_ff, coalesce(v_link->>'code', 'RPN_NO_MATCH'));
    return json_build_object('ok', false, 'code', coalesce(v_link->>'code', 'RPN_NO_MATCH'), 'message', v_link->>'message');
  end if;

  -- (i) record the trial and prepare its licence
  insert into cl_trials (kind, phone_norm, vendor_id, install_id, business_id, rpn_id, exception_id, started_on, ends_on,
                         shop_name, name_key, phrase_group, device_hash, earliest_sale)
  values (v_kind, v_phone, v.id, v.install_id, v_biz, r.id, case when v_kind = 'exception' then x.id end, v_today, v_today + v_days,
          v.business_name, regexp_replace(lower(coalesce(v.business_name, '')), '[^a-z0-9]', '', 'g'),
          left(md5(cl_norm_phrase(v.shop_secret_phrase)), 8), left(md5(v.device_key), 12), p_earliest_sale)
  returning id into v_trial;
  if x.id is not null then update cl_trial_exceptions set used_at = now(), used_by_trial = v_trial where id = x.id; end if;
  update cl_vendors set phone = coalesce(nullif(btrim(phone), ''), p_phone) where id = v.id;
  v_serial := cl_trial_new_licence(v_trial, v, v_biz, v_term, v_today + v_days, p_key_id);
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'trial_granted', 'cl_trials', v_trial, jsonb_build_object('install_id', v.install_id, 'serial', v_serial, 'kind', v_kind,
          'rpn', r.field_force_no, 'ends_on', v_today + v_days, 'exception_id', x.id));
  return cl_trial_answer(v_serial, 'standard');
end $fn$;

-- The issue-trial Edge Function stores the signature it made (service_role only).
create function public.cl_trial_attach(p_serial integer, p_signature_hex text) returns json
language plpgsql security definer set search_path = public as $fn$
declare l cl_licences%rowtype;
begin
  select * into l from cl_licences where serial = p_serial and kind = 'trial' for update;
  if not found then raise exception 'No such trial licence'; end if;
  if l.licence is not null then
    return json_build_object('serial', l.serial, 'licence', l.licence, 'valid_to', l.valid_to, 'again', true);
  end if;
  if l.status <> 'pending' then raise exception 'Trial licence % is %', p_serial, l.status; end if;
  if p_signature_hex !~ '^[0-9a-fA-F]{128}$' then raise exception 'A signature is 64 bytes (128 hex characters)'; end if;
  update cl_licences set licence = 'SL2.' || cl_licence_b64url(l.payload || decode(p_signature_hex, 'hex')), status = 'issued', signed_at = now()
   where serial = p_serial returning * into l;
  return json_build_object('serial', l.serial, 'licence', l.licence, 'valid_to', l.valid_to);
end $fn$;


-- 5. Console --------------------------------------------------------------------
-- Trials, newest first, with what the Console needs to judge them.
create function public.cl_trials_list(p_limit integer default 200) returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_today date := (now() at time zone 'Africa/Harare')::date;
begin
  if not cl_licence_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return coalesce((select json_agg(x order by x.created_at desc) from (
    select t.id, t.kind, t.phone_norm, t.install_id, t.started_on, t.ends_on, t.created_at, t.earliest_sale,
           coalesce(b.name, v.business_name, t.shop_name) shop, v.business_name vendor_name,
           r.full_name rpn_name, r.field_force_no rpn_ff,
           case when t.ends_on > v_today then 'running' else 'ended' end status,
           (select count(*) from cl_licences l where l.trial_id = t.id) tills,
           exists (select 1 from cl_licences l where l.kind = 'paid' and l.status in ('issued', 'redeemed') and l.issued_at >= t.created_at
                     and (l.vendor_id = t.vendor_id or (coalesce(t.business_id, cl_vendor_business(t.vendor_id)) is not null
                          and l.business_id = coalesce(t.business_id, cl_vendor_business(t.vendor_id)))))
             or exists (select 1 from cl_ledger_entries le where le.vendor_id = t.vendor_id and le.entry_type = 'payment' and le.created_at >= t.created_at) converted,
           array_remove(array[
             case when exists (select 1 from cl_trials o where o.id <> t.id and o.phrase_group = t.phrase_group and t.phrase_group <> left(md5(''), 8)) then 'same_phrase' end,
             case when t.name_key <> '' and exists (select 1 from cl_trials o where o.id <> t.id and o.name_key = t.name_key) then 'same_name' end,
             case when exists (select 1 from cl_trials o where o.id <> t.id and o.device_hash = t.device_hash) then 'same_device' end,
             case when t.rpn_id is not null and (select count(*) from cl_trials o where o.rpn_id = t.rpn_id
                       and o.created_at between t.created_at - interval '7 days' and t.created_at + interval '7 days') >= 3 then 'busy_rpn' end
           ], null) flags,
           x.reason exception_reason
    from cl_trials t join cl_vendors v on v.id = t.vendor_id
         left join cl_businesses b on b.id = coalesce(t.business_id, cl_vendor_business(t.vendor_id))
         left join cl_rpn r on r.id = t.rpn_id left join cl_trial_exceptions x on x.id = t.exception_id
    order by t.created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x), '[]'::json);
end $fn$;

-- Refused attempts (latest) and counts per RPN by reason.
create function public.cl_trial_refusals_list(p_limit integer default 200) returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not cl_licence_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return json_build_object(
    'refusals', coalesce((select json_agg(x order by x.created_at desc) from (
        select f.id, f.created_at, f.install_id, f.code, f.phone_norm, f.field_force_no, coalesce(b.name, v.business_name) shop,
               r.full_name rpn_name, coalesce(r.field_force_no, f.field_force_no) rpn_ff
        from cl_trial_refusals f left join cl_vendors v on v.id = f.vendor_id left join cl_businesses b on b.id = cl_vendor_business(f.vendor_id)
             left join cl_rpn r on r.id = f.rpn_id
        order by f.created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x), '[]'::json),
    'per_rpn', coalesce((select json_agg(y order by y.total desc) from (
        select coalesce(r.field_force_no, f.field_force_no, '') rpn_ff, max(r.full_name) rpn_name, count(*) total,
               json_object_agg(f.code, f.n) by_code
        from (select rpn_id, field_force_no, code, count(*) n from cl_trial_refusals group by rpn_id, field_force_no, code) f
             left join cl_rpn r on r.id = f.rpn_id
        group by coalesce(r.field_force_no, f.field_force_no, '')) y), '[]'::json));
end $fn$;

-- SysAdmin: allow one more trial for a phone or an install (a lost phone, a genuine reinstall).
create function public.cl_trial_exception_grant(p_phone text, p_install_id text, p_days integer, p_reason text) returns json
language plpgsql security definer set search_path = public as $fn$
declare v_staff uuid := cl_acting_staff(); v_phone text; v_install text := nullif(upper(btrim(coalesce(p_install_id, ''))), ''); x cl_trial_exceptions%rowtype;
begin
  if v_staff is null or not cl_jwt_is_sysadmin() or not exists (select 1 from cl_staff where id = v_staff and active) then
    raise exception 'Not authorized: only a SysAdmin can grant an exception trial' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_phone, '')), '') is not null then
    v_phone := cl_norm_phone(p_phone);
    if v_phone is null then raise exception 'That phone number isn''t valid (e.g. 07x xxx xxxx or +263 7x xxx xxxx)'; end if;
  end if;
  if v_phone is null and v_install is null then raise exception 'Give the phone number or the install ID'; end if;
  if v_install is not null and v_install !~ '^[A-Z0-9]{4,8}$' then raise exception 'An install ID is 4 to 8 letters and digits'; end if;
  if p_days is null or p_days < 1 or p_days > 30 then raise exception 'Days must be 1 to 30'; end if;
  insert into cl_trial_exceptions (phone_norm, install_id, days, reason, granted_by)
  values (v_phone, v_install, p_days, cl_rpn_reason(p_reason), v_staff) returning * into x;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'trial_exception_granted', 'cl_trial_exceptions', x.id,
          jsonb_build_object('phone', v_phone, 'install_id', v_install, 'days', p_days, 'reason', x.reason));
  return row_to_json(x);
end $fn$;

create function public.cl_trial_exceptions_list() returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not cl_licence_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return coalesce((select json_agg(json_build_object('id', x.id, 'phone_norm', x.phone_norm, 'install_id', x.install_id, 'days', x.days,
            'reason', x.reason, 'granted_by', s.full_name, 'granted_at', x.granted_at, 'used_at', x.used_at, 'used_by_trial', x.used_by_trial)
            order by x.granted_at desc)
          from cl_trial_exceptions x left join cl_staff s on s.id = x.granted_by), '[]'::json);
end $fn$;

-- RPN Directory: trials, conversions and refusals per RPN.
create function public.cl_rpn_trial_stats() returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['rpn_directory', 'vendors', 'rpn_commissions', 'rpn_payouts']);
  return coalesce((select json_object_agg(r.id, json_build_object(
      'trials', (select count(*) from cl_trials t where t.rpn_id = r.id),
      'running', (select count(*) from cl_trials t where t.rpn_id = r.id and t.ends_on > (now() at time zone 'Africa/Harare')::date),
      'converted', (select count(*) from cl_trials t where t.rpn_id = r.id and (
          exists (select 1 from cl_licences l where l.kind = 'paid' and l.status in ('issued', 'redeemed') and l.issued_at >= t.created_at
                    and (l.vendor_id = t.vendor_id or l.business_id = coalesce(t.business_id, cl_vendor_business(t.vendor_id))))
          or exists (select 1 from cl_ledger_entries le where le.vendor_id = t.vendor_id and le.entry_type = 'payment' and le.created_at >= t.created_at))),
      'refused', (select count(*) from cl_trial_refusals f where f.rpn_id = r.id or (f.rpn_id is null and f.field_force_no = r.field_force_no))))
    from cl_rpn r), '{}'::json);
end $fn$;


-- 6. Delete guards count trials -------------------------------------------------
create or replace function public.cl_vendor_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare parts text[] := '{}'; n integer;
begin
  select count(*) into n from cl_ledger_entries where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' ledger entr' || case when n = 1 then 'y' else 'ies' end); end if;
  select count(*) into n from cl_licences where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' licence' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_activation_codes where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' activation code' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_vendor_messages where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' billing message' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_terminals where vendor_id = old.id or install_id = old.install_id;
  if n > 0 then parts := parts || (n || ' till' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_plan_assignments where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' price-plan setting' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_businesses where created_by_vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' business' || case when n = 1 then '' else 'es' end || ' it created'); end if;
  select count(*) into n from vendors where install_id = old.install_id;
  if n > 0 then parts := parts || ('an iTred Market Place listing account'::text); end if;
  -- RPN commissions (20261015120000)
  select count(*) into n from cl_rpn_commissions where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN commission line' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_rpn_assignments where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN history entr' || case when n = 1 then 'y' else 'ies' end); end if;
  -- Market publishing (20261016120000)
  select count(*) into n from cl_market_packs where device_vendor_id = old.id or vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' market pack' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_token_purchases where vendor_id = old.id or charge_vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' token purchase' || case when n = 1 then '' else 's' end); end if;
  -- Trial rules (20261019120000)
  select count(*) into n from cl_trials where vendor_id = old.id;
  if n > 0 then parts := parts || (n || ' free trial' || case when n = 1 then '' else 's' end); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead (Console → Vendors → Archive). Nothing was deleted.',
      old.business_name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

create or replace function public.cl_business_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare parts text[] := '{}'; n integer;
begin
  select count(*) into n from cl_branches where business_id = old.id;
  if n > 0 then parts := parts || (n || ' branch' || case when n = 1 then '' else 'es' end); end if;
  select count(*) into n from cl_terminals where business_id = old.id;
  if n > 0 then parts := parts || (n || ' till' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_licences where business_id = old.id;
  if n > 0 then parts := parts || (n || ' licence' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_plan_assignments where business_id = old.id;
  if n > 0 then parts := parts || (n || ' price-plan setting' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_catalogue_products where business_id = old.id;
  if n > 0 then parts := parts || (n || ' catalogue product' || case when n = 1 then '' else 's' end); end if;
  -- RPN commissions (20261015120000)
  select count(*) into n from cl_rpn_commissions where business_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN commission line' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_rpn_assignments where business_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN history entr' || case when n = 1 then 'y' else 'ies' end); end if;
  -- Market publishing (20261016120000)
  select count(*) into n from cl_market_packs where business_id = old.id;
  if n > 0 then parts := parts || (n || ' market pack' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_token_purchases where business_id = old.id;
  if n > 0 then parts := parts || (n || ' token purchase' || case when n = 1 then '' else 's' end); end if;
  -- Dispatch & GRV (20261017120000)
  select count(*) into n from cl_dispatches where business_id = old.id;
  if n > 0 then parts := parts || (n || ' dispatch' || case when n = 1 then '' else 'es' end); end if;
  -- Suppliers (20261018120000)
  select count(*) into n from cl_suppliers where business_id = old.id;
  if n > 0 then parts := parts || (n || ' supplier' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_supplier_grvs where business_id = old.id;
  if n > 0 then parts := parts || (n || ' supplier GRV' || case when n = 1 then '' else 's' end); end if;
  -- Trial rules (20261019120000)
  select count(*) into n from cl_trials where business_id = old.id;
  if n > 0 then parts := parts || (n || ' free trial' || case when n = 1 then '' else 's' end); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;


-- 7. Who may call what ----------------------------------------------------------
alter table public.cl_trials enable row level security;
alter table public.cl_trial_refusals enable row level security;
alter table public.cl_trial_exceptions enable row level security;
revoke all on table public.cl_trials, public.cl_trial_refusals, public.cl_trial_exceptions from public, anon, authenticated;
revoke all on function public.cl_norm_phone(text) from public, anon, authenticated;
revoke all on function public.cl_trial_request(text, text, text, text, text, text, date, integer), public.cl_trial_attach(integer, text),
  public.cl_trials_list(integer), public.cl_trial_refusals_list(integer), public.cl_trial_exception_grant(text, text, integer, text),
  public.cl_trial_exceptions_list(), public.cl_rpn_trial_stats() from public, anon, authenticated;
-- devices (the issue-trial Edge Function calls with the anon key, like every device RPC)
grant execute on function public.cl_trial_request(text, text, text, text, text, text, date, integer) to anon, authenticated;
-- ONLY the Edge Function's service role stores signatures
grant execute on function public.cl_trial_attach(integer, text) to service_role;
-- staff (cl_login tokens are role authenticated; each function checks the rest)
grant execute on function public.cl_trials_list(integer), public.cl_trial_refusals_list(integer),
  public.cl_trial_exception_grant(text, text, integer, text), public.cl_trial_exceptions_list(), public.cl_rpn_trial_stats() to authenticated;

commit;
