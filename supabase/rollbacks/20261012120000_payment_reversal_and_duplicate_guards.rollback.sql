-- Rollback for supabase/migrations/20261012120000_payment_reversal_and_duplicate_guards.sql.
-- Refuses (changing nothing) while any payment reversal exists: those are
-- real entries (and cash out) that the old rules can't hold.
-- Restores the four functions exactly as they were (no duplicate guards).
-- Also remove the row from supabase_migrations.schema_migrations
-- (tools/db/apply-migration.js apply <file> --rollback does both in one transaction).
begin;

do $$
begin
  if exists (select 1 from public.cl_ledger_entries where entry_type = 'payment_reversal')
     or exists (select 1 from public.cl_cashbook_entries where source_type = 'ledger_payment_reversal') then
    raise exception 'payment_reversal rollback aborted: payment reversals exist. Nothing was changed.';
  end if;
end $$;

drop function if exists public.cl_reverse_ledger_payment(uuid, text);
drop index if exists public.cl_ledger_entries_one_reversal;
alter table public.cl_cashbook_entries drop constraint cl_cashbook_entries_source_type_check;
alter table public.cl_cashbook_entries add constraint cl_cashbook_entries_source_type_check
  check (source_type = any (array['ledger_payment'::text, 'voucher'::text, 'manual'::text]));
alter table public.cl_ledger_entries drop constraint cl_ledger_entries_credit_shape;
alter table public.cl_ledger_entries add constraint cl_ledger_entries_credit_shape
  check ((entry_type = 'credit' and coalesce(btrim(notes), '') <> '') or (entry_type <> 'credit' and reverses_entry_id is null));
alter table public.cl_ledger_entries drop constraint cl_ledger_entries_entry_type_check;
alter table public.cl_ledger_entries add constraint cl_ledger_entries_entry_type_check
  check (entry_type = any (array['charge'::text, 'payment'::text, 'credit'::text]));
comment on column public.cl_ledger_entries.reverses_entry_id is 'On a credit: the charge it reverses (cl_record_ledger_credit).';

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

CREATE OR REPLACE FUNCTION public.cl_record_ledger_payment(p_vendor_id uuid, p_amount numeric, p_currency text, p_method text DEFAULT NULL::text, p_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_coa_account_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff_id uuid := cl_jwt_sub();
  v_entry    cl_ledger_entries%rowtype;
  v_cash     cl_cashbook_entries%rowtype;
begin
  if cl_jwt_user_type() <> 'staff' or not (cl_jwt_is_sysadmin() or cl_has_module_access('collections_ledger') or cl_has_module_access('billing_reminders')) then
    raise exception 'Not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, method, reference, notes, recorded_by)
  values (p_vendor_id, 'payment', p_amount, upper(trim(p_currency)), p_method, p_reference, p_notes, v_staff_id)
  returning * into v_entry;

  insert into cl_cashbook_entries (direction, amount, currency, coa_account_id, description, source_type, source_id, recorded_by)
  values ('in', p_amount, v_entry.currency, p_coa_account_id, coalesce(p_notes, 'Collections payment'), 'ledger_payment', v_entry.id, v_staff_id)
  returning * into v_cash;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff_id, 'record_ledger_payment', 'cl_ledger_entries', v_entry.id,
    json_build_object('vendor_id', p_vendor_id, 'amount', p_amount, 'currency', v_entry.currency));

  return json_build_object('ledger_entry', row_to_json(v_entry), 'cashbook_entry', row_to_json(v_cash));
end;
$function$;

create or replace function public.cl_record_ledger_credit(p_vendor_id uuid, p_amount numeric, p_currency text, p_reason text,
                                               p_reverses_entry_id uuid default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_staff uuid := cl_jwt_sub();
  v_cur text := upper(btrim(coalesce(p_currency, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_orig cl_ledger_entries%rowtype;
  v_already numeric;
  v_entry cl_ledger_entries%rowtype;
begin
  if not (coalesce(cl_jwt_user_type() = 'staff', false)
          and exists (select 1 from cl_staff s where s.id = v_staff and s.active)
          and (cl_jwt_is_sysadmin() or cl_has_module_access('collections_ledger') or cl_has_module_access('billing_reminders'))) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if round(p_amount, 2) <> p_amount then raise exception 'Amount can have at most 2 decimals'; end if;
  if v_reason = '' then raise exception 'A reason is required'; end if;
  if length(v_reason) > 500 then raise exception 'Keep the reason under 500 characters'; end if;
  if v_cur !~ '^[A-Z]{3}$' then raise exception 'Currency must be a 3-letter code, e.g. USD'; end if;
  if not exists (select 1 from cl_vendors where id = p_vendor_id) then raise exception 'No such vendor'; end if;

  if p_reverses_entry_id is not null then
    select * into v_orig from cl_ledger_entries where id = p_reverses_entry_id for update;   -- one credit at a time per charge
    if not found then raise exception 'The entry to reverse doesn''t exist'; end if;
    if v_orig.entry_type <> 'charge' then raise exception 'Only a charge can be reversed'; end if;
    if v_orig.vendor_id <> p_vendor_id then raise exception 'That charge belongs to another vendor'; end if;
    if v_orig.currency <> v_cur then raise exception 'That charge is in %, not %', v_orig.currency, v_cur; end if;
    select coalesce(sum(amount), 0) into v_already from cl_ledger_entries where reverses_entry_id = p_reverses_entry_id;
    if v_already + p_amount > v_orig.amount then
      raise exception 'Credits against that charge would total % %, more than the charge (% %)', v_already + p_amount, v_cur, v_orig.amount, v_cur;
    end if;
  end if;

  insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes, recorded_by, reverses_entry_id)
  values (p_vendor_id, 'credit', p_amount, v_cur, v_reason, v_staff, p_reverses_entry_id)
  returning * into v_entry;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'record_ledger_credit', 'cl_ledger_entries', v_entry.id,
          json_build_object('vendor_id', p_vendor_id, 'amount', p_amount, 'currency', v_cur, 'reason', v_reason,
                            'reverses_entry_id', p_reverses_entry_id));

  return json_build_object('ledger_entry', row_to_json(v_entry));
end $fn$;

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

commit;
