-- Rollback for supabase/migrations/20261013120000_price_plans.sql.
-- Refuses (changing nothing) while any licence carries a price snapshot or
-- any shop has been put on a plan: those are real priced records.
-- Restores the seven changed functions exactly as they were, and drops the
-- plan tables, the snapshot columns and the new functions.
-- Also remove the row from supabase_migrations.schema_migrations
-- (tools/db/apply-migration.js apply <file> --rollback does both in one transaction).
begin;

do $$
begin
  if exists (select 1 from public.cl_licences where till_role is not null)
     or exists (select 1 from public.cl_plan_assignments) then
    raise exception 'price_plans rollback aborted: priced licences or plan assignments exist. Nothing was changed.';
  end if;
end $$;

create or replace function public.cl_licence_prepare(p_device_code text default null, p_business_id uuid default null,
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
    -- One issue per DEVICE per staff member per 30 seconds: a repeated tap or
    -- a retried request must not sign and charge twice. Other tills of the
    -- same business are not affected (T1, T2, T3 back to back is fine).
    perform pg_advisory_xact_lock(hashtext('cl_licence_prepare:' || v_install));
    select l.serial into v_serial from cl_licences l
     where l.issued_by = v_staff and l.install_id = v_install and l.issued_at > now() - interval '30 seconds'
     order by l.serial desc limit 1;
    if found then
      raise exception 'DUPLICATE_ISSUE: licence #% was issued for this device (%) a few seconds ago. Check the list; to issue another, wait 30 seconds.',
        v_serial, v_install;
    end if;
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

create or replace function public.cl_licence_attach(p_serial integer, p_signature_hex text)
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

create or replace function public.cl_licence_list(p_install_id text default null, p_business_id uuid default null, p_limit integer default 50)
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

CREATE OR REPLACE FUNCTION public.cl_issue_activation_code(p_vendor_id uuid, p_device_code text, p_computed_code text, p_cycle_number integer DEFAULT 1, p_valid_from date DEFAULT CURRENT_DATE, p_valid_to date DEFAULT (CURRENT_DATE + '30 days'::interval))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff_id uuid := cl_jwt_sub();
  v_rate     cl_activation_pricing%rowtype;
  v_code     cl_activation_codes%rowtype;
  v_ledger   cl_ledger_entries%rowtype;
begin
  if cl_jwt_user_type() <> 'staff' or not (cl_jwt_is_sysadmin() or cl_has_module_access('activation_codes')) then
    raise exception 'Not authorized';
  end if;

  -- The same code for the same device by the same staff member within 30
  -- seconds is a repeated tap or a retried request: answer with the one
  -- already logged (and its charge) instead of charging again.
  perform pg_advisory_xact_lock(hashtext('cl_issue_activation_code:' || coalesce(p_vendor_id::text, '') || ':' || coalesce(p_device_code, '')));
  select * into v_code from cl_activation_codes
   where vendor_id = p_vendor_id and device_code = p_device_code and computed_code = p_computed_code
     and issued_by is not distinct from v_staff_id and issued_at > now() - interval '30 seconds'
   order by issued_at desc limit 1;
  if found then
    select * into v_ledger from cl_ledger_entries where activation_code_id = v_code.id limit 1;
    return json_build_object('activation_code', row_to_json(v_code), 'ledger_charge', row_to_json(v_ledger), 'duplicate', true);
  end if;

  insert into cl_activation_codes (vendor_id, device_code, computed_code, cycle_number, valid_from, valid_to, issued_by)
  values (p_vendor_id, p_device_code, p_computed_code, p_cycle_number, p_valid_from, p_valid_to, v_staff_id)
  returning * into v_code;

  select * into v_rate from cl_activation_pricing order by effective_from desc limit 1;

  if found then
    insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, activation_code_id, recorded_by, notes)
    values (p_vendor_id, 'charge', v_rate.amount, v_rate.currency, v_code.id, v_staff_id, 'Auto-charged: activation code issued')
    returning * into v_ledger;
  end if;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff_id, 'issue_activation_code', 'cl_activation_codes', v_code.id,
    json_build_object('vendor_id', p_vendor_id, 'computed_code', p_computed_code, 'charged', v_rate.amount, 'currency', v_rate.currency));

  return json_build_object('activation_code', row_to_json(v_code), 'ledger_charge', row_to_json(v_ledger));
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_set_activation_rate(p_amount numeric, p_currency text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row cl_activation_pricing%rowtype;
begin
  if cl_jwt_user_type() <> 'staff' or not cl_jwt_is_sysadmin() then
    raise exception 'Not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;
  if p_currency is null or length(trim(p_currency)) = 0 then
    raise exception 'Currency is required';
  end if;

  insert into cl_activation_pricing (amount, currency, set_by)
  values (p_amount, upper(trim(p_currency)), cl_jwt_sub())
  returning * into v_row;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (cl_jwt_sub(), 'set_activation_rate', 'cl_activation_pricing', v_row.id,
    json_build_object('amount', p_amount, 'currency', v_row.currency));

  return row_to_json(v_row);
end;
$function$;

create or replace function public.cl_branch_issue_join_code(
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
    if not t.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;   -- Phase 2
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

drop function public.cl_licence_terms(text, text, text);
drop function public.cl_plan_accounts();
drop function public.cl_set_plan(uuid, uuid, text, text);
drop function public.cl_price_plan_set(text, text, numeric, numeric, numeric, text, integer, timestamptz, text);
drop function public.cl_price_plans_list();
drop function public.cl_licence_quote(text, uuid, integer);
drop function public.cl_plan_staff_ok();
drop function public.cl_plan_price(uuid, text, integer);
drop function public.cl_plan_branch_limit_text(integer);
drop function public.cl_plan_branch_allowed(uuid, integer);
drop function public.cl_plan_version(text);
drop function public.cl_plan_of(uuid, uuid);
drop trigger cl_licences_snapshot_guard on public.cl_licences;
drop function public.cl_licences_snapshot_guard();
alter table public.cl_licences drop constraint cl_licences_price_shape;
alter table public.cl_licences drop column price_plan_code, drop column plan_version_id, drop column plan_source,
  drop column till_role, drop column unit_fee, drop column amount, drop column currency;
drop table public.cl_plan_assignments;
drop table public.cl_price_plan_versions;
drop table public.cl_price_plans;

commit;
