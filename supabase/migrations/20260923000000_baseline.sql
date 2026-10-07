-- =====================================================================
-- Baseline: the schema that existed before the first migration file.
--
-- The live project was built in the dashboard before supabase/migrations/
-- existed, so these objects (back office, ledger, vouchers, RPNs, staff,
-- activation, cl_vendors, cl_login ...) were in no migration file and the
-- database could not be rebuilt from the repo. This file recreates them,
-- so that this baseline followed by every later file builds the full
-- schema on an empty Supabase database.
--
-- * Generated from a read-only catalogue snapshot of the live database
--   (tools/db/catalog.js, tools/db/ddl.js), then reduced to the objects
--   no later migration creates. Objects a later migration changes are in
--   their earlier form: cl_vendors without business_id / device_key, its
--   install_id unique constraint and index (added by 20260924120000 and
--   20261004120000); cl_login, cl_sign_jwt and the 9-argument
--   cl_device_checkin as they were before 20260926120000 / 20261004120000.
-- * NEVER RUN ON THE LIVE DATABASE. The preflight refuses to run if any of
--   these objects exists, so it can't harm live; there it is only
--   recorded in supabase_migrations.schema_migrations as applied.
-- * No data rows. A rebuilt database still needs its configuration rows
--   (see docs/database/backup-and-restore.md): cl_modules, cl_app_settings,
--   cl_activation_pricing, cl_chart_of_accounts, a first cl_staff
--   sysadmin, and the Vault secret 'cl_jwt_secret'.
-- * Supabase-managed: roles anon / authenticated / service_role, schemas
--   auth, extensions, vault; extensions pg_stat_statements and
--   supabase_vault. pgjwt is installed in public on live but nothing of
--   ours uses it; it is created only where the server offers it.
-- * Proof: supabase/tests/baseline-rebuild-test.js
-- =====================================================================

begin;
set local check_function_bodies = off;

do $$
declare
  found_objects text;
begin
  select string_agg(n, ', ') into found_objects from (
    select 'table ' || t as n from unnest(array['cl_activation_codes', 'cl_activation_pricing', 'cl_activity_log', 'cl_app_settings', 'cl_cashbook_entries', 'cl_chart_of_accounts', 'cl_ledger_entries', 'cl_modules', 'cl_payment_voucher_lines', 'cl_payment_vouchers', 'cl_rpn', 'cl_staff', 'cl_staff_module_access', 'cl_vendor_messages', 'cl_vendors']) t
      where to_regclass('public.' || t) is not null
    union all
    select 'function ' || f from unnest(array['cl_approve_payment_voucher(uuid)',
      'cl_create_rpn(text,text,text,text)',
      'cl_create_staff(text,text,boolean)',
      'cl_create_voucher_with_lines(text,date,text,uuid,text,jsonb)',
      'cl_has_module_access(text)',
      'cl_issue_activation_code(uuid,text,text,integer,date,date)',
      'cl_jwt_is_sysadmin()',
      'cl_jwt_sub()',
      'cl_jwt_user_type()',
      'cl_mark_voucher_paid(uuid)',
      'cl_recalc_voucher_total()',
      'cl_record_ledger_payment(uuid,numeric,text,text,text,text,uuid)',
      'cl_reissue_rpn_verification_code(uuid,text)',
      'cl_rpn_activate(text,text,text)',
      'cl_send_billing_reminder(uuid,text,text)',
      'cl_set_activation_rate(numeric,text)',
      'cl_set_app_setting(text,text,text,text)',
      'cl_set_staff_passcode(uuid,text)',
      'cl_whoami()',
      'cl_login(text,text)',
      'cl_sign_jwt(json,text)',
      'cl_device_checkin(text,text,text,text,text,text,text,text,uuid)']) f
      where to_regprocedure('public.' || f) is not null
  ) x;
  if found_objects is not null then
    raise exception 'baseline aborted: this database already has its objects (%). The baseline is for an empty database only; on live it is only recorded as applied. Nothing was changed.', left(found_objects, 300);
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgjwt') then
    create extension if not exists pgjwt with schema public;
  end if;
end $$;

-- Extensions ------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- Sequences -------------------------------------------------------------
create sequence public.cl_voucher_no_seq as bigint increment by 1 minvalue 1 maxvalue 9223372036854775807 start with 1 cache 1;

-- Tables ----------------------------------------------------------------
create table public.cl_activation_codes (
  id uuid not null,
  vendor_id uuid not null,
  device_code text not null,
  computed_code text not null,
  cycle_number integer not null,
  valid_from date not null,
  valid_to date not null,
  issued_by uuid,
  issued_at timestamp with time zone not null
);
create table public.cl_activation_pricing (
  id uuid not null,
  amount numeric(14,2) not null,
  currency text not null,
  effective_from timestamp with time zone not null,
  set_by uuid,
  created_at timestamp with time zone not null
);
create table public.cl_activity_log (
  id uuid not null,
  staff_id uuid,
  action text not null,
  target_table text,
  target_id uuid,
  detail jsonb,
  created_at timestamp with time zone not null
);
create table public.cl_app_settings (
  key text not null,
  value text,
  label text,
  description text,
  updated_by uuid,
  updated_at timestamp with time zone not null
);
create table public.cl_cashbook_entries (
  id uuid not null,
  direction text not null,
  amount numeric(14,2) not null,
  currency text not null,
  coa_account_id uuid,
  description text,
  source_type text not null,
  source_id uuid,
  recorded_by uuid,
  created_at timestamp with time zone not null
);
create table public.cl_chart_of_accounts (
  id uuid not null,
  code text not null,
  name text not null,
  account_type text not null,
  active boolean not null,
  created_at timestamp with time zone not null,
  created_by uuid,
  parent_id uuid
);
create table public.cl_ledger_entries (
  id uuid not null,
  vendor_id uuid not null,
  entry_type text not null,
  amount numeric(14,2) not null,
  currency text not null,
  method text,
  reference text,
  notes text,
  activation_code_id uuid,
  recorded_by uuid,
  created_at timestamp with time zone not null
);
create table public.cl_modules (
  id uuid not null,
  key text not null,
  label text not null,
  description text,
  sort_order integer not null
);
create table public.cl_payment_voucher_lines (
  id uuid not null,
  voucher_id uuid not null,
  coa_account_id uuid,
  amount numeric(14,2) not null,
  description text,
  line_order integer not null
);
create table public.cl_payment_vouchers (
  id uuid not null,
  voucher_no text not null,
  voucher_date date not null,
  payee text not null,
  currency text not null,
  description text,
  status text not null,
  prepared_by uuid,
  approved_by uuid,
  approved_at timestamp with time zone,
  paid_at timestamp with time zone,
  created_at timestamp with time zone not null,
  paying_account_id uuid,
  total_amount numeric(14,2) not null
);
create table public.cl_rpn (
  id uuid not null,
  full_name text not null,
  phone text,
  city text,
  passcode_hash text not null,
  verification_code text not null,
  verification_used boolean not null,
  active boolean not null,
  created_at timestamp with time zone not null,
  created_by uuid
);
create table public.cl_staff (
  id uuid not null,
  full_name text not null,
  passcode_hash text not null,
  is_sysadmin boolean not null,
  active boolean not null,
  created_at timestamp with time zone not null,
  created_by uuid
);
create table public.cl_staff_module_access (
  staff_id uuid not null,
  module_id uuid not null,
  granted_at timestamp with time zone not null,
  granted_by uuid
);
create table public.cl_vendor_messages (
  id uuid not null,
  vendor_id uuid not null,
  title text not null,
  body text not null,
  channel text not null,
  status text not null,
  created_by uuid,
  created_at timestamp with time zone not null,
  delivered_at timestamp with time zone
);
create table public.cl_vendors (
  id uuid not null,
  business_name text not null,
  owner_name text,
  phone text,
  city text,
  rpn_id uuid,
  device_code text,
  shop_secret_phrase text,
  cycle_start_date date,
  status text not null,
  onboarded_at timestamp with time zone,
  notes text,
  created_by uuid,
  created_at timestamp with time zone not null,
  install_id text,
  location text,
  app_registered_at timestamp with time zone,
  last_checkin_at timestamp with time zone,
  lock_cart boolean not null,
  lock_add_product boolean not null,
  lock_reason text
);

-- Functions -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cl_approve_payment_voucher(p_voucher_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_voucher cl_payment_vouchers%rowtype;
begin
  if cl_jwt_user_type() <> 'staff' or not cl_jwt_is_sysadmin() then
    raise exception 'Not authorized';
  end if;

  select * into v_voucher from cl_payment_vouchers where id = p_voucher_id;
  if not found then raise exception 'Voucher not found'; end if;
  if v_voucher.status <> 'draft' then raise exception 'Only draft vouchers can be approved'; end if;

  update cl_payment_vouchers
    set status = 'approved', approved_by = cl_jwt_sub(), approved_at = now()
    where id = p_voucher_id
    returning * into v_voucher;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (cl_jwt_sub(), 'approve_voucher', 'cl_payment_vouchers', p_voucher_id,
    json_build_object('voucher_no', v_voucher.voucher_no, 'amount', v_voucher.amount, 'currency', v_voucher.currency));

  return row_to_json(v_voucher);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_create_rpn(p_full_name text, p_phone text, p_city text, p_verification_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
begin
  if not (cl_jwt_user_type() = 'staff' and (cl_jwt_is_sysadmin() or cl_has_module_access('rpn_directory'))) then
    raise exception 'Not authorized';
  end if;
  -- passcode_hash starts as an unguessable random value; the RPN sets her
  -- own real passcode via cl_rpn_activate() using the verification code below.
  insert into cl_rpn (full_name, phone, city, passcode_hash, verification_code, created_by)
  values (p_full_name, p_phone, p_city, extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')), p_verification_code, cl_jwt_sub())
  returning id into v_id;
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_create_staff(p_full_name text, p_passcode text, p_is_sysadmin boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
begin
  if not (cl_jwt_user_type() = 'staff' and cl_jwt_is_sysadmin()) then
    raise exception 'Not authorized';
  end if;
  insert into cl_staff (full_name, passcode_hash, is_sysadmin, created_by)
  values (p_full_name, extensions.crypt(p_passcode, extensions.gen_salt('bf')), coalesce(p_is_sysadmin, false), cl_jwt_sub())
  returning id into v_id;
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_create_voucher_with_lines(p_payee text, p_voucher_date date, p_currency text, p_paying_account_id uuid, p_description text, p_lines jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff_id uuid := cl_jwt_sub();
  v_voucher  cl_payment_vouchers%rowtype;
  v_line     jsonb;
  v_idx      int := 0;
begin
  if cl_jwt_user_type() <> 'staff' or not (cl_jwt_is_sysadmin() or cl_has_module_access('payment_vouchers')) then
    raise exception 'Not authorized';
  end if;
  if p_payee is null or length(trim(p_payee)) = 0 then
    raise exception 'Payee is required';
  end if;
  if p_paying_account_id is null then
    raise exception 'Paying account is required';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one account line is required';
  end if;

  insert into cl_payment_vouchers (payee, voucher_date, currency, paying_account_id, description, status, prepared_by)
  values (trim(p_payee), coalesce(p_voucher_date, current_date), upper(trim(p_currency)), p_paying_account_id, p_description, 'draft', v_staff_id)
  returning * into v_voucher;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    if coalesce((v_line->>'amount')::numeric, 0) <= 0 then
      raise exception 'Every line needs an amount greater than zero';
    end if;
    insert into cl_payment_voucher_lines (voucher_id, coa_account_id, amount, description, line_order)
    values (v_voucher.id, nullif(v_line->>'coa_account_id','')::uuid, (v_line->>'amount')::numeric, v_line->>'description', v_idx);
    v_idx := v_idx + 1;
  end loop;

  select * into v_voucher from cl_payment_vouchers where id = v_voucher.id;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff_id, 'create_voucher', 'cl_payment_vouchers', v_voucher.id,
    json_build_object('voucher_no', v_voucher.voucher_no, 'total_amount', v_voucher.total_amount, 'currency', v_voucher.currency));

  return row_to_json(v_voucher);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_has_module_access(p_module_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
    select cl_jwt_is_sysadmin()
    or exists (
      select 1 from cl_staff_module_access sma
      join cl_modules m on m.id = sma.module_id
      where sma.staff_id = cl_jwt_sub() and m.key = p_module_key
    )
  $function$;

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

CREATE OR REPLACE FUNCTION public.cl_jwt_is_sysadmin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$ select coalesce((auth.jwt() ->> 'is_sysadmin')::boolean, false) $function$;

CREATE OR REPLACE FUNCTION public.cl_jwt_sub()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$ select nullif(auth.jwt() ->> 'sub','')::uuid $function$;

CREATE OR REPLACE FUNCTION public.cl_jwt_user_type()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$ select auth.jwt() ->> 'user_type' $function$;

CREATE OR REPLACE FUNCTION public.cl_mark_voucher_paid(p_voucher_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff_id uuid := cl_jwt_sub();
  v_voucher  cl_payment_vouchers%rowtype;
  v_cash     cl_cashbook_entries%rowtype;
begin
  if cl_jwt_user_type() <> 'staff' or not (cl_jwt_is_sysadmin() or cl_has_module_access('payment_vouchers')) then
    raise exception 'Not authorized';
  end if;

  select * into v_voucher from cl_payment_vouchers where id = p_voucher_id;
  if not found then raise exception 'Voucher not found'; end if;
  if v_voucher.status <> 'approved' then raise exception 'Only approved vouchers can be marked paid'; end if;

  update cl_payment_vouchers set status = 'paid', paid_at = now() where id = p_voucher_id
    returning * into v_voucher;

  insert into cl_cashbook_entries (direction, amount, currency, coa_account_id, description, source_type, source_id, recorded_by)
  values ('out', v_voucher.total_amount, v_voucher.currency, v_voucher.paying_account_id,
    coalesce(v_voucher.description, 'Voucher ' || v_voucher.voucher_no || ' — ' || v_voucher.payee),
    'voucher', v_voucher.id, v_staff_id)
  returning * into v_cash;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff_id, 'mark_voucher_paid', 'cl_payment_vouchers', p_voucher_id,
    json_build_object('voucher_no', v_voucher.voucher_no, 'amount', v_voucher.total_amount, 'currency', v_voucher.currency));

  return json_build_object('voucher', row_to_json(v_voucher), 'cashbook_entry', row_to_json(v_cash));
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_recalc_voucher_total()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  update cl_payment_vouchers
    set total_amount = coalesce((select sum(amount) from cl_payment_voucher_lines where voucher_id = coalesce(new.voucher_id, old.voucher_id)), 0)
    where id = coalesce(new.voucher_id, old.voucher_id);
  return null;
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

CREATE OR REPLACE FUNCTION public.cl_reissue_rpn_verification_code(p_rpn_id uuid, p_new_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (cl_jwt_user_type() = 'staff' and (cl_jwt_is_sysadmin() or cl_has_module_access('rpn_directory'))) then
    raise exception 'Not authorized';
  end if;
  update cl_rpn set verification_code = p_new_code, verification_used = false where id = p_rpn_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_rpn_activate(p_name text, p_verification_code text, p_new_passcode text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rpn cl_rpn%rowtype;
begin
  select * into v_rpn from cl_rpn
    where lower(full_name) = lower(p_name)
      and verification_code = p_verification_code
      and verification_used = false
      and active = true;

  if not found then
    raise exception 'Invalid name or verification code';
  end if;

  update cl_rpn
    set passcode_hash = extensions.crypt(p_new_passcode, extensions.gen_salt('bf')),
        verification_used = true
    where id = v_rpn.id;

  return json_build_object('status', 'ok', 'id', v_rpn.id, 'full_name', v_rpn.full_name);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_send_billing_reminder(p_vendor_id uuid, p_title text, p_body text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff_id uuid := cl_jwt_sub();
  v_msg cl_vendor_messages%rowtype;
begin
  if cl_jwt_user_type() <> 'staff' or not (cl_jwt_is_sysadmin() or cl_has_module_access('billing_reminders') or cl_has_module_access('collections_ledger')) then
    raise exception 'Not authorized';
  end if;

  insert into cl_vendor_messages (vendor_id, title, body, channel, status, created_by)
  values (p_vendor_id, p_title, p_body, 'in_app', 'pending', v_staff_id)
  returning * into v_msg;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff_id, 'send_billing_reminder', 'cl_vendor_messages', v_msg.id, json_build_object('vendor_id', p_vendor_id, 'title', p_title));

  return row_to_json(v_msg);
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

CREATE OR REPLACE FUNCTION public.cl_set_app_setting(p_key text, p_value text, p_label text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff_id uuid := cl_jwt_sub();
  v_row cl_app_settings%rowtype;
begin
  if cl_jwt_user_type() <> 'staff' or not cl_jwt_is_sysadmin() then
    raise exception 'Not authorized';
  end if;
  if p_key is null or length(trim(p_key)) = 0 then
    raise exception 'Setting key is required';
  end if;

  insert into cl_app_settings (key, value, label, description, updated_by, updated_at)
  values (trim(p_key), p_value, coalesce(p_label, trim(p_key)), p_description, v_staff_id, now())
  on conflict (key) do update set value = excluded.value, updated_by = v_staff_id, updated_at = now(),
    label = coalesce(cl_app_settings.label, excluded.label), description = coalesce(cl_app_settings.description, excluded.description)
  returning * into v_row;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff_id, 'set_app_setting', 'cl_app_settings', null, json_build_object('key', v_row.key, 'value', v_row.value));

  return row_to_json(v_row);
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_set_staff_passcode(p_staff_id uuid, p_new_passcode text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (cl_jwt_user_type() = 'staff' and (cl_jwt_is_sysadmin() or cl_jwt_sub() = p_staff_id)) then
    raise exception 'Not authorized';
  end if;
  update cl_staff set passcode_hash = extensions.crypt(p_new_passcode, extensions.gen_salt('bf')) where id = p_staff_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_whoami()
 RETURNS json
 LANGUAGE sql
 STABLE
AS $function$
  select json_build_object(
    'role', current_setting('request.jwt.claims', true)::json ->> 'role',
    'user_type', current_setting('request.jwt.claims', true)::json ->> 'user_type',
    'is_sysadmin', current_setting('request.jwt.claims', true)::json ->> 'is_sysadmin',
    'sub', current_setting('request.jwt.claims', true)::json ->> 'sub',
    'full_name', current_setting('request.jwt.claims', true)::json ->> 'full_name',
    'raw_claims', nullif(current_setting('request.jwt.claims', true), '')::json
  );
$function$;

-- Functions as they were before a later migration replaced or dropped them
-- (20260926120000 replaces cl_login and cl_sign_jwt: supabase/inspect/cl_jwt_functions_before_20260926.sql;
--  20261004120000 drops this cl_device_checkin: supabase/rollbacks/20261004120000_multi_terminal_identity.rollback.sql)
CREATE OR REPLACE FUNCTION public.cl_sign_jwt(payload json, secret text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare
  header_b64  text;
  payload_b64 text;
  signing_input text;
  sig_b64 text;
begin
  header_b64 := encode(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'), 'base64');
  payload_b64 := encode(convert_to(payload::text, 'utf8'), 'base64');
  header_b64 := replace(replace(rtrim(header_b64, '='), '+', '-'), '/', '_');
  payload_b64 := replace(replace(rtrim(payload_b64, '='), '+', '-'), '/', '_');
  signing_input := header_b64 || '.' || payload_b64;
  sig_b64 := encode(extensions.hmac(signing_input, secret, 'sha256'), 'base64');
  sig_b64 := replace(replace(rtrim(sig_b64, '='), '+', '-'), '/', '_');
  return signing_input || '.' || sig_b64;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cl_login(p_name text, p_passcode text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff  cl_staff%rowtype;
  v_rpn    cl_rpn%rowtype;
  v_secret text;
  v_token  text;
begin
  select current_setting('app.settings.jwt_secret', true) into v_secret;

  -- Try staff first
  select * into v_staff from cl_staff where lower(full_name) = lower(p_name) and active = true;
  if found and v_staff.passcode_hash = extensions.crypt(p_passcode, v_staff.passcode_hash) then
    v_token := public.cl_sign_jwt(
      json_build_object(
        'role', 'authenticated',
        'sub', v_staff.id::text,
        'user_type', 'staff',
        'is_sysadmin', v_staff.is_sysadmin,
        'full_name', v_staff.full_name,
        'iat', extract(epoch from now())::int,
        'exp', extract(epoch from now() + interval '12 hours')::int
      ),
      v_secret
    );
    return json_build_object(
      'token', v_token,
      'user_type', 'staff',
      'id', v_staff.id,
      'full_name', v_staff.full_name,
      'is_sysadmin', v_staff.is_sysadmin
    );
  end if;

  -- Then RPN
  select * into v_rpn from cl_rpn where lower(full_name) = lower(p_name) and active = true;
  if found and v_rpn.passcode_hash = extensions.crypt(p_passcode, v_rpn.passcode_hash) then
    v_token := public.cl_sign_jwt(
      json_build_object(
        'role', 'authenticated',
        'sub', v_rpn.id::text,
        'user_type', 'rpn',
        'full_name', v_rpn.full_name,
        'iat', extract(epoch from now())::int,
        'exp', extract(epoch from now() + interval '12 hours')::int
      ),
      v_secret
    );
    return json_build_object(
      'token', v_token,
      'user_type', 'rpn',
      'id', v_rpn.id,
      'full_name', v_rpn.full_name
    );
  end if;

  raise exception 'Invalid name or passcode';
end;
$function$;

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

revoke all on function public.cl_sign_jwt(payload json, secret text) from public, anon, authenticated, service_role;
grant execute on function public.cl_sign_jwt(payload json, secret text) to anon;
grant execute on function public.cl_sign_jwt(payload json, secret text) to authenticated;
grant execute on function public.cl_sign_jwt(payload json, secret text) to public;
grant execute on function public.cl_sign_jwt(payload json, secret text) to service_role;
revoke all on function public.cl_login(p_name text, p_passcode text) from public, anon, authenticated, service_role;
grant execute on function public.cl_login(p_name text, p_passcode text) to anon;
grant execute on function public.cl_login(p_name text, p_passcode text) to authenticated;
grant execute on function public.cl_login(p_name text, p_passcode text) to public;
grant execute on function public.cl_login(p_name text, p_passcode text) to service_role;
revoke all on function public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.cl_device_checkin(text, text, text, text, text, text, text, text, uuid)
  to public, anon, authenticated, service_role;

-- Column defaults -------------------------------------------------------
alter table public.cl_activation_codes alter column id set default gen_random_uuid();
alter table public.cl_activation_codes alter column cycle_number set default 1;
alter table public.cl_activation_codes alter column valid_from set default CURRENT_DATE;
alter table public.cl_activation_codes alter column valid_to set default (CURRENT_DATE + '30 days'::interval);
alter table public.cl_activation_codes alter column issued_at set default now();
alter table public.cl_activation_pricing alter column id set default gen_random_uuid();
alter table public.cl_activation_pricing alter column effective_from set default now();
alter table public.cl_activation_pricing alter column created_at set default now();
alter table public.cl_activity_log alter column id set default gen_random_uuid();
alter table public.cl_activity_log alter column created_at set default now();
alter table public.cl_app_settings alter column updated_at set default now();
alter table public.cl_cashbook_entries alter column id set default gen_random_uuid();
alter table public.cl_cashbook_entries alter column source_type set default 'manual'::text;
alter table public.cl_cashbook_entries alter column created_at set default now();
alter table public.cl_chart_of_accounts alter column id set default gen_random_uuid();
alter table public.cl_chart_of_accounts alter column active set default true;
alter table public.cl_chart_of_accounts alter column created_at set default now();
alter table public.cl_ledger_entries alter column id set default gen_random_uuid();
alter table public.cl_ledger_entries alter column created_at set default now();
alter table public.cl_modules alter column id set default gen_random_uuid();
alter table public.cl_modules alter column sort_order set default 0;
alter table public.cl_payment_voucher_lines alter column id set default gen_random_uuid();
alter table public.cl_payment_voucher_lines alter column line_order set default 0;
alter table public.cl_payment_vouchers alter column id set default gen_random_uuid();
alter table public.cl_payment_vouchers alter column voucher_no set default ('PV-'::text || lpad((nextval('cl_voucher_no_seq'::regclass))::text, 5, '0'::text));
alter table public.cl_payment_vouchers alter column voucher_date set default CURRENT_DATE;
alter table public.cl_payment_vouchers alter column status set default 'draft'::text;
alter table public.cl_payment_vouchers alter column created_at set default now();
alter table public.cl_payment_vouchers alter column total_amount set default 0;
alter table public.cl_rpn alter column id set default gen_random_uuid();
alter table public.cl_rpn alter column verification_used set default false;
alter table public.cl_rpn alter column active set default true;
alter table public.cl_rpn alter column created_at set default now();
alter table public.cl_staff alter column id set default gen_random_uuid();
alter table public.cl_staff alter column is_sysadmin set default false;
alter table public.cl_staff alter column active set default true;
alter table public.cl_staff alter column created_at set default now();
alter table public.cl_staff_module_access alter column granted_at set default now();
alter table public.cl_vendor_messages alter column id set default gen_random_uuid();
alter table public.cl_vendor_messages alter column status set default 'pending'::text;
alter table public.cl_vendor_messages alter column created_at set default now();
alter table public.cl_vendors alter column id set default gen_random_uuid();
alter table public.cl_vendors alter column status set default 'onboarding'::text;
alter table public.cl_vendors alter column onboarded_at set default now();
alter table public.cl_vendors alter column created_at set default now();
alter table public.cl_vendors alter column lock_cart set default false;
alter table public.cl_vendors alter column lock_add_product set default false;

-- Constraints (foreign keys last) ---------------------------------------
alter table public.cl_activation_codes add constraint cl_activation_codes_pkey PRIMARY KEY (id);
alter table public.cl_activation_pricing add constraint cl_activation_pricing_pkey PRIMARY KEY (id);
alter table public.cl_activity_log add constraint cl_activity_log_pkey PRIMARY KEY (id);
alter table public.cl_app_settings add constraint cl_app_settings_pkey PRIMARY KEY (key);
alter table public.cl_cashbook_entries add constraint cl_cashbook_entries_amount_check CHECK ((amount > (0)::numeric));
alter table public.cl_cashbook_entries add constraint cl_cashbook_entries_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text])));
alter table public.cl_cashbook_entries add constraint cl_cashbook_entries_pkey PRIMARY KEY (id);
alter table public.cl_cashbook_entries add constraint cl_cashbook_entries_source_type_check CHECK ((source_type = ANY (ARRAY['ledger_payment'::text, 'voucher'::text, 'manual'::text])));
alter table public.cl_chart_of_accounts add constraint cl_chart_of_accounts_account_type_check CHECK ((account_type = ANY (ARRAY['asset'::text, 'liability'::text, 'income'::text, 'expense'::text])));
alter table public.cl_chart_of_accounts add constraint cl_chart_of_accounts_code_key UNIQUE (code);
alter table public.cl_chart_of_accounts add constraint cl_chart_of_accounts_pkey PRIMARY KEY (id);
alter table public.cl_ledger_entries add constraint cl_ledger_entries_amount_check CHECK ((amount > (0)::numeric));
alter table public.cl_ledger_entries add constraint cl_ledger_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['charge'::text, 'payment'::text])));
alter table public.cl_ledger_entries add constraint cl_ledger_entries_pkey PRIMARY KEY (id);
alter table public.cl_modules add constraint cl_modules_key_key UNIQUE (key);
alter table public.cl_modules add constraint cl_modules_pkey PRIMARY KEY (id);
alter table public.cl_payment_voucher_lines add constraint cl_payment_voucher_lines_amount_check CHECK ((amount > (0)::numeric));
alter table public.cl_payment_voucher_lines add constraint cl_payment_voucher_lines_pkey PRIMARY KEY (id);
alter table public.cl_payment_vouchers add constraint cl_payment_vouchers_pkey PRIMARY KEY (id);
alter table public.cl_payment_vouchers add constraint cl_payment_vouchers_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'paid'::text])));
alter table public.cl_payment_vouchers add constraint cl_payment_vouchers_voucher_no_key UNIQUE (voucher_no);
alter table public.cl_rpn add constraint cl_rpn_pkey PRIMARY KEY (id);
alter table public.cl_staff add constraint cl_staff_pkey PRIMARY KEY (id);
alter table public.cl_staff_module_access add constraint cl_staff_module_access_pkey PRIMARY KEY (staff_id, module_id);
alter table public.cl_vendor_messages add constraint cl_vendor_messages_channel_check CHECK ((channel = ANY (ARRAY['in_app'::text, 'whatsapp'::text])));
alter table public.cl_vendor_messages add constraint cl_vendor_messages_pkey PRIMARY KEY (id);
alter table public.cl_vendor_messages add constraint cl_vendor_messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivered'::text, 'sent'::text])));
alter table public.cl_vendors add constraint cl_vendors_pkey PRIMARY KEY (id);
alter table public.cl_vendors add constraint cl_vendors_status_check CHECK ((status = ANY (ARRAY['onboarding'::text, 'active'::text, 'overdue'::text, 'suspended'::text, 'cancelled'::text])));
alter table public.cl_activation_codes add constraint cl_activation_codes_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES cl_staff(id);
alter table public.cl_activation_codes add constraint cl_activation_codes_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES cl_vendors(id) ON DELETE CASCADE;
alter table public.cl_activation_pricing add constraint cl_activation_pricing_set_by_fkey FOREIGN KEY (set_by) REFERENCES cl_staff(id);
alter table public.cl_activity_log add constraint cl_activity_log_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES cl_staff(id);
alter table public.cl_app_settings add constraint cl_app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES cl_staff(id);
alter table public.cl_cashbook_entries add constraint cl_cashbook_entries_coa_account_id_fkey FOREIGN KEY (coa_account_id) REFERENCES cl_chart_of_accounts(id);
alter table public.cl_cashbook_entries add constraint cl_cashbook_entries_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES cl_staff(id);
alter table public.cl_chart_of_accounts add constraint cl_chart_of_accounts_created_by_fkey FOREIGN KEY (created_by) REFERENCES cl_staff(id);
alter table public.cl_chart_of_accounts add constraint cl_chart_of_accounts_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES cl_chart_of_accounts(id);
alter table public.cl_ledger_entries add constraint cl_ledger_entries_activation_code_id_fkey FOREIGN KEY (activation_code_id) REFERENCES cl_activation_codes(id);
alter table public.cl_ledger_entries add constraint cl_ledger_entries_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES cl_staff(id);
alter table public.cl_ledger_entries add constraint cl_ledger_entries_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES cl_vendors(id) ON DELETE CASCADE;
alter table public.cl_payment_voucher_lines add constraint cl_payment_voucher_lines_coa_account_id_fkey FOREIGN KEY (coa_account_id) REFERENCES cl_chart_of_accounts(id);
alter table public.cl_payment_voucher_lines add constraint cl_payment_voucher_lines_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES cl_payment_vouchers(id) ON DELETE CASCADE;
alter table public.cl_payment_vouchers add constraint cl_payment_vouchers_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES cl_staff(id);
alter table public.cl_payment_vouchers add constraint cl_payment_vouchers_paying_account_id_fkey FOREIGN KEY (paying_account_id) REFERENCES cl_chart_of_accounts(id);
alter table public.cl_payment_vouchers add constraint cl_payment_vouchers_prepared_by_fkey FOREIGN KEY (prepared_by) REFERENCES cl_staff(id);
alter table public.cl_rpn add constraint cl_rpn_created_by_fkey FOREIGN KEY (created_by) REFERENCES cl_staff(id);
alter table public.cl_staff add constraint cl_staff_created_by_fkey FOREIGN KEY (created_by) REFERENCES cl_staff(id);
alter table public.cl_staff_module_access add constraint cl_staff_module_access_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES cl_staff(id);
alter table public.cl_staff_module_access add constraint cl_staff_module_access_module_id_fkey FOREIGN KEY (module_id) REFERENCES cl_modules(id) ON DELETE CASCADE;
alter table public.cl_staff_module_access add constraint cl_staff_module_access_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES cl_staff(id) ON DELETE CASCADE;
alter table public.cl_vendor_messages add constraint cl_vendor_messages_created_by_fkey FOREIGN KEY (created_by) REFERENCES cl_staff(id);
alter table public.cl_vendor_messages add constraint cl_vendor_messages_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES cl_vendors(id) ON DELETE CASCADE;
alter table public.cl_vendors add constraint cl_vendors_created_by_fkey FOREIGN KEY (created_by) REFERENCES cl_staff(id);
alter table public.cl_vendors add constraint cl_vendors_rpn_id_fkey FOREIGN KEY (rpn_id) REFERENCES cl_rpn(id);

-- Indexes ---------------------------------------------------------------
CREATE INDEX cl_activation_codes_vendor_id_idx ON public.cl_activation_codes USING btree (vendor_id);
CREATE INDEX cl_activation_pricing_effective_idx ON public.cl_activation_pricing USING btree (effective_from DESC);
CREATE INDEX cl_activity_log_created_idx ON public.cl_activity_log USING btree (created_at DESC);
CREATE INDEX cl_cashbook_entries_created_idx ON public.cl_cashbook_entries USING btree (created_at DESC);
CREATE INDEX cl_chart_of_accounts_parent_idx ON public.cl_chart_of_accounts USING btree (parent_id);
CREATE INDEX cl_ledger_entries_vendor_idx ON public.cl_ledger_entries USING btree (vendor_id, created_at DESC);
CREATE INDEX cl_payment_voucher_lines_voucher_idx ON public.cl_payment_voucher_lines USING btree (voucher_id);
CREATE INDEX cl_payment_vouchers_status_idx ON public.cl_payment_vouchers USING btree (status, created_at DESC);
CREATE UNIQUE INDEX cl_rpn_full_name_uidx ON public.cl_rpn USING btree (lower(full_name));
CREATE UNIQUE INDEX cl_rpn_verification_code_uidx ON public.cl_rpn USING btree (verification_code);
CREATE UNIQUE INDEX cl_staff_full_name_uidx ON public.cl_staff USING btree (lower(full_name));
CREATE INDEX cl_vendor_messages_vendor_id_idx ON public.cl_vendor_messages USING btree (vendor_id);
CREATE UNIQUE INDEX cl_vendors_install_id_uidx ON public.cl_vendors USING btree (install_id) WHERE (install_id IS NOT NULL);
CREATE INDEX cl_vendors_rpn_id_idx ON public.cl_vendors USING btree (rpn_id);

-- Triggers --------------------------------------------------------------
CREATE TRIGGER cl_voucher_lines_recalc AFTER INSERT OR DELETE OR UPDATE ON public.cl_payment_voucher_lines FOR EACH ROW EXECUTE FUNCTION cl_recalc_voucher_total();

-- Row level security ----------------------------------------------------
alter table public.cl_activation_codes enable row level security;
alter table public.cl_activation_pricing enable row level security;
alter table public.cl_activity_log enable row level security;
alter table public.cl_app_settings enable row level security;
alter table public.cl_cashbook_entries enable row level security;
alter table public.cl_chart_of_accounts enable row level security;
alter table public.cl_ledger_entries enable row level security;
alter table public.cl_modules enable row level security;
alter table public.cl_payment_voucher_lines enable row level security;
alter table public.cl_payment_vouchers enable row level security;
alter table public.cl_rpn enable row level security;
alter table public.cl_staff enable row level security;
alter table public.cl_staff_module_access enable row level security;
alter table public.cl_vendor_messages enable row level security;
alter table public.cl_vendors enable row level security;
create policy cl_activation_codes_select on public.cl_activation_codes as permissive for select to public
  using ((((cl_jwt_user_type() = 'rpn'::text) AND (EXISTS ( SELECT 1
   FROM cl_vendors v
  WHERE ((v.id = cl_activation_codes.vendor_id) AND (v.rpn_id = cl_jwt_sub()))))) OR ((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('activation_codes'::text)))));
create policy cl_activation_pricing_select on public.cl_activation_pricing as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('activation_codes'::text))));
create policy cl_activation_pricing_write on public.cl_activation_pricing as permissive for insert to public
  with check (((cl_jwt_user_type() = 'staff'::text) AND cl_jwt_is_sysadmin()));
create policy cl_activity_log_insert on public.cl_activity_log as permissive for insert to public
  with check (((cl_jwt_user_type() = 'staff'::text) AND (staff_id = cl_jwt_sub())));
create policy cl_activity_log_select on public.cl_activity_log as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND cl_jwt_is_sysadmin()));
create policy cl_app_settings_select on public.cl_app_settings as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND cl_jwt_is_sysadmin()));
create policy cl_app_settings_write on public.cl_app_settings as permissive for all to public
  using (((cl_jwt_user_type() = 'staff'::text) AND cl_jwt_is_sysadmin()))
  with check (((cl_jwt_user_type() = 'staff'::text) AND cl_jwt_is_sysadmin()));
create policy cl_cashbook_manual_insert on public.cl_cashbook_entries as permissive for insert to public
  with check (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('cashbook'::text)) AND (source_type = 'manual'::text)));
create policy cl_cashbook_select on public.cl_cashbook_entries as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('cashbook'::text))));
create policy cl_coa_select on public.cl_chart_of_accounts as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('chart_of_accounts'::text) OR cl_has_module_access('cashbook'::text) OR cl_has_module_access('payment_vouchers'::text))));
create policy cl_coa_write on public.cl_chart_of_accounts as permissive for all to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('chart_of_accounts'::text))))
  with check (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('chart_of_accounts'::text))));
create policy cl_ledger_entries_select on public.cl_ledger_entries as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('collections_ledger'::text) OR cl_has_module_access('billing_reminders'::text))));
create policy cl_modules_select on public.cl_modules as permissive for select to public
  using ((cl_jwt_user_type() = ANY (ARRAY['staff'::text, 'rpn'::text])));
create policy cl_voucher_lines_select on public.cl_payment_voucher_lines as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('payment_vouchers'::text))));
create policy cl_vouchers_select on public.cl_payment_vouchers as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('payment_vouchers'::text))));
create policy cl_vouchers_update_draft on public.cl_payment_vouchers as permissive for update to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (status = 'draft'::text) AND (cl_jwt_is_sysadmin() OR (cl_has_module_access('payment_vouchers'::text) AND (prepared_by = cl_jwt_sub())))))
  with check ((status = 'draft'::text));
create policy cl_rpn_select on public.cl_rpn as permissive for select to public
  using ((((cl_jwt_user_type() = 'rpn'::text) AND (id = cl_jwt_sub())) OR ((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('rpn_directory'::text)))));
create policy cl_rpn_update_self on public.cl_rpn as permissive for update to public
  using (((cl_jwt_user_type() = 'rpn'::text) AND (id = cl_jwt_sub())))
  with check (((cl_jwt_user_type() = 'rpn'::text) AND (id = cl_jwt_sub())));
create policy cl_rpn_write_staff on public.cl_rpn as permissive for all to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('rpn_directory'::text))))
  with check (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('rpn_directory'::text))));
create policy cl_staff_select_self on public.cl_staff as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND ((id = cl_jwt_sub()) OR cl_jwt_is_sysadmin())));
create policy cl_staff_write_sysadmin on public.cl_staff as permissive for all to public
  using (((cl_jwt_user_type() = 'staff'::text) AND cl_jwt_is_sysadmin()))
  with check (((cl_jwt_user_type() = 'staff'::text) AND cl_jwt_is_sysadmin()));
create policy cl_sma_select_self on public.cl_staff_module_access as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND ((staff_id = cl_jwt_sub()) OR cl_jwt_is_sysadmin())));
create policy cl_sma_write_sysadmin on public.cl_staff_module_access as permissive for all to public
  using (((cl_jwt_user_type() = 'staff'::text) AND cl_jwt_is_sysadmin()))
  with check (((cl_jwt_user_type() = 'staff'::text) AND cl_jwt_is_sysadmin()));
create policy cl_vendor_messages_select on public.cl_vendor_messages as permissive for select to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('billing_reminders'::text) OR cl_has_module_access('vendors'::text))));
create policy cl_vendor_messages_write on public.cl_vendor_messages as permissive for all to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('billing_reminders'::text) OR cl_has_module_access('vendors'::text))))
  with check (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('billing_reminders'::text) OR cl_has_module_access('vendors'::text))));
create policy cl_vendors_select on public.cl_vendors as permissive for select to public
  using ((((cl_jwt_user_type() = 'rpn'::text) AND (rpn_id = cl_jwt_sub())) OR ((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('vendors'::text)))));
create policy cl_vendors_write_staff on public.cl_vendors as permissive for all to public
  using (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('vendors'::text))))
  with check (((cl_jwt_user_type() = 'staff'::text) AND (cl_jwt_is_sysadmin() OR cl_has_module_access('vendors'::text))));

-- Privileges (anon, authenticated, service_role, PUBLIC) ----------------
revoke all on table public.cl_activation_codes from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_activation_codes to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_activation_codes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_activation_codes to service_role;
revoke all on table public.cl_activation_pricing from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_activation_pricing to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_activation_pricing to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_activation_pricing to service_role;
revoke all on table public.cl_activity_log from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_activity_log to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_activity_log to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_activity_log to service_role;
revoke all on table public.cl_app_settings from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_app_settings to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_app_settings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_app_settings to service_role;
revoke all on table public.cl_cashbook_entries from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_cashbook_entries to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_cashbook_entries to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_cashbook_entries to service_role;
revoke all on table public.cl_chart_of_accounts from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_chart_of_accounts to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_chart_of_accounts to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_chart_of_accounts to service_role;
revoke all on table public.cl_ledger_entries from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_ledger_entries to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_ledger_entries to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_ledger_entries to service_role;
revoke all on table public.cl_modules from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_modules to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_modules to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_modules to service_role;
revoke all on table public.cl_payment_voucher_lines from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_payment_voucher_lines to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_payment_voucher_lines to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_payment_voucher_lines to service_role;
revoke all on table public.cl_payment_vouchers from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_payment_vouchers to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_payment_vouchers to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_payment_vouchers to service_role;
revoke all on table public.cl_rpn from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_rpn to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_rpn to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_rpn to service_role;
revoke all on table public.cl_staff from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_staff to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_staff to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_staff to service_role;
revoke all on table public.cl_staff_module_access from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_staff_module_access to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_staff_module_access to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_staff_module_access to service_role;
revoke all on table public.cl_vendor_messages from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_vendor_messages to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_vendor_messages to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_vendor_messages to service_role;
revoke all on table public.cl_vendors from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_vendors to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_vendors to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cl_vendors to service_role;
revoke all on sequence public.cl_voucher_no_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.cl_voucher_no_seq to anon;
grant select, update, usage on sequence public.cl_voucher_no_seq to authenticated;
grant select, update, usage on sequence public.cl_voucher_no_seq to service_role;
revoke all on function public.cl_approve_payment_voucher(p_voucher_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.cl_approve_payment_voucher(p_voucher_id uuid) to anon;
grant execute on function public.cl_approve_payment_voucher(p_voucher_id uuid) to authenticated;
grant execute on function public.cl_approve_payment_voucher(p_voucher_id uuid) to public;
grant execute on function public.cl_approve_payment_voucher(p_voucher_id uuid) to service_role;
revoke all on function public.cl_create_rpn(p_full_name text, p_phone text, p_city text, p_verification_code text) from public, anon, authenticated, service_role;
grant execute on function public.cl_create_rpn(p_full_name text, p_phone text, p_city text, p_verification_code text) to anon;
grant execute on function public.cl_create_rpn(p_full_name text, p_phone text, p_city text, p_verification_code text) to authenticated;
grant execute on function public.cl_create_rpn(p_full_name text, p_phone text, p_city text, p_verification_code text) to public;
grant execute on function public.cl_create_rpn(p_full_name text, p_phone text, p_city text, p_verification_code text) to service_role;
revoke all on function public.cl_create_staff(p_full_name text, p_passcode text, p_is_sysadmin boolean) from public, anon, authenticated, service_role;
grant execute on function public.cl_create_staff(p_full_name text, p_passcode text, p_is_sysadmin boolean) to anon;
grant execute on function public.cl_create_staff(p_full_name text, p_passcode text, p_is_sysadmin boolean) to authenticated;
grant execute on function public.cl_create_staff(p_full_name text, p_passcode text, p_is_sysadmin boolean) to public;
grant execute on function public.cl_create_staff(p_full_name text, p_passcode text, p_is_sysadmin boolean) to service_role;
revoke all on function public.cl_create_voucher_with_lines(p_payee text, p_voucher_date date, p_currency text, p_paying_account_id uuid, p_description text, p_lines jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cl_create_voucher_with_lines(p_payee text, p_voucher_date date, p_currency text, p_paying_account_id uuid, p_description text, p_lines jsonb) to anon;
grant execute on function public.cl_create_voucher_with_lines(p_payee text, p_voucher_date date, p_currency text, p_paying_account_id uuid, p_description text, p_lines jsonb) to authenticated;
grant execute on function public.cl_create_voucher_with_lines(p_payee text, p_voucher_date date, p_currency text, p_paying_account_id uuid, p_description text, p_lines jsonb) to public;
grant execute on function public.cl_create_voucher_with_lines(p_payee text, p_voucher_date date, p_currency text, p_paying_account_id uuid, p_description text, p_lines jsonb) to service_role;
revoke all on function public.cl_has_module_access(p_module_key text) from public, anon, authenticated, service_role;
grant execute on function public.cl_has_module_access(p_module_key text) to anon;
grant execute on function public.cl_has_module_access(p_module_key text) to authenticated;
grant execute on function public.cl_has_module_access(p_module_key text) to public;
grant execute on function public.cl_has_module_access(p_module_key text) to service_role;
revoke all on function public.cl_issue_activation_code(p_vendor_id uuid, p_device_code text, p_computed_code text, p_cycle_number integer, p_valid_from date, p_valid_to date) from public, anon, authenticated, service_role;
grant execute on function public.cl_issue_activation_code(p_vendor_id uuid, p_device_code text, p_computed_code text, p_cycle_number integer, p_valid_from date, p_valid_to date) to anon;
grant execute on function public.cl_issue_activation_code(p_vendor_id uuid, p_device_code text, p_computed_code text, p_cycle_number integer, p_valid_from date, p_valid_to date) to authenticated;
grant execute on function public.cl_issue_activation_code(p_vendor_id uuid, p_device_code text, p_computed_code text, p_cycle_number integer, p_valid_from date, p_valid_to date) to public;
grant execute on function public.cl_issue_activation_code(p_vendor_id uuid, p_device_code text, p_computed_code text, p_cycle_number integer, p_valid_from date, p_valid_to date) to service_role;
revoke all on function public.cl_jwt_is_sysadmin() from public, anon, authenticated, service_role;
grant execute on function public.cl_jwt_is_sysadmin() to anon;
grant execute on function public.cl_jwt_is_sysadmin() to authenticated;
grant execute on function public.cl_jwt_is_sysadmin() to public;
grant execute on function public.cl_jwt_is_sysadmin() to service_role;
revoke all on function public.cl_jwt_sub() from public, anon, authenticated, service_role;
grant execute on function public.cl_jwt_sub() to anon;
grant execute on function public.cl_jwt_sub() to authenticated;
grant execute on function public.cl_jwt_sub() to public;
grant execute on function public.cl_jwt_sub() to service_role;
revoke all on function public.cl_jwt_user_type() from public, anon, authenticated, service_role;
grant execute on function public.cl_jwt_user_type() to anon;
grant execute on function public.cl_jwt_user_type() to authenticated;
grant execute on function public.cl_jwt_user_type() to public;
grant execute on function public.cl_jwt_user_type() to service_role;
revoke all on function public.cl_mark_voucher_paid(p_voucher_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.cl_mark_voucher_paid(p_voucher_id uuid) to anon;
grant execute on function public.cl_mark_voucher_paid(p_voucher_id uuid) to authenticated;
grant execute on function public.cl_mark_voucher_paid(p_voucher_id uuid) to public;
grant execute on function public.cl_mark_voucher_paid(p_voucher_id uuid) to service_role;
revoke all on function public.cl_recalc_voucher_total() from public, anon, authenticated, service_role;
grant execute on function public.cl_recalc_voucher_total() to anon;
grant execute on function public.cl_recalc_voucher_total() to authenticated;
grant execute on function public.cl_recalc_voucher_total() to public;
grant execute on function public.cl_recalc_voucher_total() to service_role;
revoke all on function public.cl_record_ledger_payment(p_vendor_id uuid, p_amount numeric, p_currency text, p_method text, p_reference text, p_notes text, p_coa_account_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.cl_record_ledger_payment(p_vendor_id uuid, p_amount numeric, p_currency text, p_method text, p_reference text, p_notes text, p_coa_account_id uuid) to anon;
grant execute on function public.cl_record_ledger_payment(p_vendor_id uuid, p_amount numeric, p_currency text, p_method text, p_reference text, p_notes text, p_coa_account_id uuid) to authenticated;
grant execute on function public.cl_record_ledger_payment(p_vendor_id uuid, p_amount numeric, p_currency text, p_method text, p_reference text, p_notes text, p_coa_account_id uuid) to public;
grant execute on function public.cl_record_ledger_payment(p_vendor_id uuid, p_amount numeric, p_currency text, p_method text, p_reference text, p_notes text, p_coa_account_id uuid) to service_role;
revoke all on function public.cl_reissue_rpn_verification_code(p_rpn_id uuid, p_new_code text) from public, anon, authenticated, service_role;
grant execute on function public.cl_reissue_rpn_verification_code(p_rpn_id uuid, p_new_code text) to anon;
grant execute on function public.cl_reissue_rpn_verification_code(p_rpn_id uuid, p_new_code text) to authenticated;
grant execute on function public.cl_reissue_rpn_verification_code(p_rpn_id uuid, p_new_code text) to public;
grant execute on function public.cl_reissue_rpn_verification_code(p_rpn_id uuid, p_new_code text) to service_role;
revoke all on function public.cl_rpn_activate(p_name text, p_verification_code text, p_new_passcode text) from public, anon, authenticated, service_role;
grant execute on function public.cl_rpn_activate(p_name text, p_verification_code text, p_new_passcode text) to anon;
grant execute on function public.cl_rpn_activate(p_name text, p_verification_code text, p_new_passcode text) to authenticated;
grant execute on function public.cl_rpn_activate(p_name text, p_verification_code text, p_new_passcode text) to public;
grant execute on function public.cl_rpn_activate(p_name text, p_verification_code text, p_new_passcode text) to service_role;
revoke all on function public.cl_send_billing_reminder(p_vendor_id uuid, p_title text, p_body text) from public, anon, authenticated, service_role;
grant execute on function public.cl_send_billing_reminder(p_vendor_id uuid, p_title text, p_body text) to anon;
grant execute on function public.cl_send_billing_reminder(p_vendor_id uuid, p_title text, p_body text) to authenticated;
grant execute on function public.cl_send_billing_reminder(p_vendor_id uuid, p_title text, p_body text) to public;
grant execute on function public.cl_send_billing_reminder(p_vendor_id uuid, p_title text, p_body text) to service_role;
revoke all on function public.cl_set_activation_rate(p_amount numeric, p_currency text) from public, anon, authenticated, service_role;
grant execute on function public.cl_set_activation_rate(p_amount numeric, p_currency text) to anon;
grant execute on function public.cl_set_activation_rate(p_amount numeric, p_currency text) to authenticated;
grant execute on function public.cl_set_activation_rate(p_amount numeric, p_currency text) to public;
grant execute on function public.cl_set_activation_rate(p_amount numeric, p_currency text) to service_role;
revoke all on function public.cl_set_app_setting(p_key text, p_value text, p_label text, p_description text) from public, anon, authenticated, service_role;
grant execute on function public.cl_set_app_setting(p_key text, p_value text, p_label text, p_description text) to anon;
grant execute on function public.cl_set_app_setting(p_key text, p_value text, p_label text, p_description text) to authenticated;
grant execute on function public.cl_set_app_setting(p_key text, p_value text, p_label text, p_description text) to public;
grant execute on function public.cl_set_app_setting(p_key text, p_value text, p_label text, p_description text) to service_role;
revoke all on function public.cl_set_staff_passcode(p_staff_id uuid, p_new_passcode text) from public, anon, authenticated, service_role;
grant execute on function public.cl_set_staff_passcode(p_staff_id uuid, p_new_passcode text) to anon;
grant execute on function public.cl_set_staff_passcode(p_staff_id uuid, p_new_passcode text) to authenticated;
grant execute on function public.cl_set_staff_passcode(p_staff_id uuid, p_new_passcode text) to public;
grant execute on function public.cl_set_staff_passcode(p_staff_id uuid, p_new_passcode text) to service_role;
revoke all on function public.cl_whoami() from public, anon, authenticated, service_role;
grant execute on function public.cl_whoami() to anon;
grant execute on function public.cl_whoami() to authenticated;
grant execute on function public.cl_whoami() to public;
grant execute on function public.cl_whoami() to service_role;

-- Comments --------------------------------------------------------------

commit;
