// node tools/db/gen-20261012-migration.js
// One-off generator for supabase/migrations/20261012120000_payment_reversal_and_duplicate_guards.sql
// and its rollback. It copies the CURRENT bodies of the functions it changes
// (baseline / activation licences / ledger credits, all proven equal to live
// by supabase/tests/baseline-rebuild-test.js) so the new versions differ only
// by the guard lines, and the rollback restores them byte for byte.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const READ = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const BASE = READ('supabase/migrations/20260923000000_baseline.sql');
const LIC = READ('supabase/migrations/20261010120000_activation_licences.sql');
const CRED = READ('supabase/migrations/20261011120000_ledger_credits.sql');

function cut(src, start, endMarker) {
  const i = src.indexOf(start); if (i < 0) throw new Error('not found: ' + start.slice(0, 60));
  const j = src.indexOf(endMarker, i); if (j < 0) throw new Error('end not found for ' + start.slice(0, 60));
  return src.slice(i, j + endMarker.length);
}
function ins(src, anchor, text) { if (src.split(anchor).length !== 2) throw new Error('anchor not unique: ' + anchor.slice(0, 60)); return src.replace(anchor, () => anchor + text); }
function insBefore(src, anchor, text) { if (src.split(anchor).length !== 2) throw new Error('anchor not unique: ' + anchor.slice(0, 60)); return src.replace(anchor, () => text + anchor); }

// ---- the current bodies ----
const ISSUE_OLD = cut(BASE, 'CREATE OR REPLACE FUNCTION public.cl_issue_activation_code(', '$function$;');
const PAY_OLD = cut(BASE, 'CREATE OR REPLACE FUNCTION public.cl_record_ledger_payment(', '$function$;');
const PREP_OLD = cut(LIC, 'create function public.cl_licence_prepare(', 'end $fn$;').replace('create function', 'create or replace function');
const CRED_OLD = cut(CRED, 'create function public.cl_record_ledger_credit(', 'end $fn$;').replace('create function', 'create or replace function');

// ---- the guarded versions ----
const WINDOW = "interval '30 seconds'";
let ISSUE_NEW = ins(ISSUE_OLD, `    raise exception 'Not authorized';
  end if;
`, `
  -- The same code for the same device by the same staff member within 30
  -- seconds is a repeated tap or a retried request: answer with the one
  -- already logged (and its charge) instead of charging again.
  perform pg_advisory_xact_lock(hashtext('cl_issue_activation_code:' || coalesce(p_vendor_id::text, '') || ':' || coalesce(p_device_code, '')));
  select * into v_code from cl_activation_codes
   where vendor_id = p_vendor_id and device_code = p_device_code and computed_code = p_computed_code
     and issued_by is not distinct from v_staff_id and issued_at > now() - ${WINDOW}
   order by issued_at desc limit 1;
  if found then
    select * into v_ledger from cl_ledger_entries where activation_code_id = v_code.id limit 1;
    return json_build_object('activation_code', row_to_json(v_code), 'ledger_charge', row_to_json(v_ledger), 'duplicate', true);
  end if;
`);
let PAY_NEW = ins(PAY_OLD, `  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;
`, `
  -- The same payment (vendor, amount, currency, method, reference, notes) by
  -- the same staff member within 30 seconds is a repeated tap or a retried
  -- request: answer with the one already recorded, no second cash entry.
  perform pg_advisory_xact_lock(hashtext('cl_record_ledger_payment:' || coalesce(p_vendor_id::text, '')));
  select * into v_entry from cl_ledger_entries
   where vendor_id = p_vendor_id and entry_type = 'payment' and amount = p_amount and currency = upper(trim(p_currency))
     and method is not distinct from p_method and reference is not distinct from p_reference and notes is not distinct from p_notes
     and recorded_by is not distinct from v_staff_id and created_at > now() - ${WINDOW}
   order by created_at desc limit 1;
  if found then
    select * into v_cash from cl_cashbook_entries where source_type = 'ledger_payment' and source_id = v_entry.id limit 1;
    return json_build_object('ledger_entry', row_to_json(v_entry), 'cashbook_entry', row_to_json(v_cash), 'duplicate', true);
  end if;
`);
let CRED_NEW = insBefore(CRED_OLD, `  if p_reverses_entry_id is not null then
    select * into v_orig`, `  -- The same credit by the same staff member within 30 seconds is a repeated
  -- tap or a retried request: answer with the one already posted.
  perform pg_advisory_xact_lock(hashtext('cl_record_ledger_credit:' || coalesce(p_vendor_id::text, '')));
  select * into v_entry from cl_ledger_entries
   where vendor_id = p_vendor_id and entry_type = 'credit' and amount = p_amount and currency = v_cur and notes = v_reason
     and reverses_entry_id is not distinct from p_reverses_entry_id
     and recorded_by is not distinct from v_staff and created_at > now() - ${WINDOW}
   order by created_at desc limit 1;
  if found then return json_build_object('ledger_entry', row_to_json(v_entry), 'duplicate', true); end if;

`);
let PREP_NEW = ins(PREP_OLD, `  v_to := v_from + p_days;
`, `
  -- One issue per device (or per business) per staff member per 30 seconds:
  -- a repeated tap or a retried request must not sign and charge twice.
  perform pg_advisory_xact_lock(hashtext('cl_licence_prepare:' || coalesce(upper(split_part(regexp_replace(p_device_code, '\\s', '', 'g'), '-', 1)), p_business_id::text)));
  select l.serial into v_serial from cl_licences l
   where l.issued_by = v_staff and l.issued_at > now() - ${WINDOW}
     and ((p_device_code is not null and l.install_id = upper(split_part(regexp_replace(p_device_code, '\\s', '', 'g'), '-', 1)))
       or (p_business_id is not null and l.business_id = p_business_id))
   order by l.serial desc limit 1;
  if found then
    raise exception 'DUPLICATE_ISSUE: licence #% was issued for this % a few seconds ago. Check the list; to issue another, wait 30 seconds.',
      v_serial, case when p_device_code is not null then 'device' else 'business' end;
  end if;
`);

const HEADER = `-- =====================================================================
-- Collections Ledger: payment reversals, and duplicate guards on every
-- call that writes a charge, payment, credit or licence (owner's decisions,
-- 2026-10-08). Applied live only after the owner has seen this file and
-- said "apply".
-- Rollback: supabase/rollbacks/20261012120000_payment_reversal_and_duplicate_guards.rollback.sql
-- Tested in PGlite: supabase/tests/payment-reversal-test.js
-- Generated by tools/db/gen-20261012-migration.js from the live function
-- bodies, so each changed function differs only by its guard lines.
--
-- 1. Payment reversal: a payment recorded in error (or a test) is undone
--    honestly, without deleting anything:
--      * cl_ledger_entries.entry_type 'payment_reversal': adds the amount
--        back to the vendor's balance and names the payment it reverses
--        (reverses_entry_id); one reversal per payment; reason required.
--      * cl_cashbook_entries.source_type 'ledger_payment_reversal': the
--        matching cash OUT, on the same account the payment's cash IN used.
--      * cl_reverse_ledger_payment(p_payment_id, p_reason): the only way to
--        post one. Same people who may record payments (Collections Ledger
--        or Billing & Reminders, or SysAdmin), active staff. Logged.
-- 2. Duplicate guards (one tap = one charge, even with a double-tap or a
--    retried request): cl_issue_activation_code, cl_record_ledger_payment
--    and cl_record_ledger_credit answer an identical call from the same
--    staff member within 30 seconds with the entry already written
--    ('duplicate': true), and write nothing new; cl_licence_prepare refuses
--    a second issue for the same device or business by the same staff
--    member within 30 seconds (DUPLICATE_ISSUE). Each takes a transaction
--    lock first, so even calls arriving at the same instant are serialised.
--    Grants are unchanged (create or replace keeps them).
-- =====================================================================
`;

const MIGRATION = HEADER + `
begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'function cl_reverse_ledger_payment' n where exists (select 1 from pg_proc where proname = 'cl_reverse_ledger_payment' and pronamespace = 'public'::regnamespace)
    union all select 'index cl_ledger_entries_one_reversal' where to_regclass('public.cl_ledger_entries_one_reversal') is not null
  ) x;
  if conflicts is not null then raise exception 'payment_reversal aborted: already exists: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'function cl_record_ledger_credit (20261011120000)' n where to_regprocedure('public.cl_record_ledger_credit(uuid,numeric,text,text,uuid)') is null
    union all select 'function cl_licence_prepare (20261010120000)' where to_regprocedure('public.cl_licence_prepare(text,uuid,integer,integer,integer,text)') is null
    union all select 'constraint cl_ledger_entries_entry_type_check (charge, payment, credit)'
      where not exists (select 1 from pg_constraint where conname = 'cl_ledger_entries_entry_type_check' and conrelid = 'public.cl_ledger_entries'::regclass
                          and pg_get_constraintdef(oid) = 'CHECK ((entry_type = ANY (ARRAY[''charge''::text, ''payment''::text, ''credit''::text])))')
    union all select 'constraint cl_cashbook_entries_source_type_check (ledger_payment, voucher, manual)'
      where not exists (select 1 from pg_constraint where conname = 'cl_cashbook_entries_source_type_check' and conrelid = 'public.cl_cashbook_entries'::regclass
                          and pg_get_constraintdef(oid) = 'CHECK ((source_type = ANY (ARRAY[''ledger_payment''::text, ''voucher''::text, ''manual''::text])))')
  ) x;
  if missing is not null then raise exception 'payment_reversal aborted: missing or different: %. Nothing was changed.', missing; end if;
end $$;


-- 1. Payment reversals ----------------------------------------------------
alter table public.cl_ledger_entries drop constraint cl_ledger_entries_entry_type_check;
alter table public.cl_ledger_entries add constraint cl_ledger_entries_entry_type_check
  check (entry_type = any (array['charge'::text, 'payment'::text, 'credit'::text, 'payment_reversal'::text]));
-- credits and reversals carry a reason; a reversal always names its payment; nothing else names an entry
alter table public.cl_ledger_entries drop constraint cl_ledger_entries_credit_shape;
alter table public.cl_ledger_entries add constraint cl_ledger_entries_credit_shape
  check ((entry_type = 'credit' and coalesce(btrim(notes), '') <> '')
      or (entry_type = 'payment_reversal' and coalesce(btrim(notes), '') <> '' and reverses_entry_id is not null)
      or (entry_type in ('charge', 'payment') and reverses_entry_id is null));
create unique index cl_ledger_entries_one_reversal on public.cl_ledger_entries (reverses_entry_id) where entry_type = 'payment_reversal';
comment on column public.cl_ledger_entries.reverses_entry_id is 'On a credit: the charge it reverses (cl_record_ledger_credit). On a payment_reversal: the payment it reverses (cl_reverse_ledger_payment).';

alter table public.cl_cashbook_entries drop constraint cl_cashbook_entries_source_type_check;
alter table public.cl_cashbook_entries add constraint cl_cashbook_entries_source_type_check
  check (source_type = any (array['ledger_payment'::text, 'voucher'::text, 'manual'::text, 'ledger_payment_reversal'::text]));

create function public.cl_reverse_ledger_payment(p_payment_id uuid, p_reason text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_staff uuid := cl_jwt_sub();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_pay cl_ledger_entries%rowtype;
  v_in cl_cashbook_entries%rowtype;
  v_entry cl_ledger_entries%rowtype;
  v_cash cl_cashbook_entries%rowtype;
begin
  if not (coalesce(cl_jwt_user_type() = 'staff', false)
          and exists (select 1 from cl_staff s where s.id = v_staff and s.active)
          and (cl_jwt_is_sysadmin() or cl_has_module_access('collections_ledger') or cl_has_module_access('billing_reminders'))) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_reason = '' then raise exception 'A reason is required'; end if;
  if length(v_reason) > 500 then raise exception 'Keep the reason under 500 characters'; end if;

  select * into v_pay from cl_ledger_entries where id = p_payment_id for update;   -- one reversal at a time
  if not found then raise exception 'No such ledger entry'; end if;
  if v_pay.entry_type <> 'payment' then raise exception 'Only a payment can be reversed this way (use a credit for a charge)'; end if;
  select * into v_entry from cl_ledger_entries where entry_type = 'payment_reversal' and reverses_entry_id = p_payment_id;
  if found then
    -- already reversed: a repeated tap or retried request gets the same answer; anything else is refused
    if v_entry.recorded_by is not distinct from v_staff and v_entry.created_at > now() - interval '30 seconds' then
      select * into v_cash from cl_cashbook_entries where source_type = 'ledger_payment_reversal' and source_id = v_entry.id limit 1;
      return json_build_object('ledger_entry', row_to_json(v_entry), 'cashbook_entry', row_to_json(v_cash), 'duplicate', true);
    end if;
    raise exception 'That payment was already reversed on %', to_char(v_entry.created_at at time zone 'Africa/Harare', 'DD Mon YYYY HH24:MI');
  end if;

  insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes, recorded_by, reverses_entry_id)
  values (v_pay.vendor_id, 'payment_reversal', v_pay.amount, v_pay.currency, v_reason, v_staff, v_pay.id)
  returning * into v_entry;

  -- the cash the payment booked comes out of the same account
  select * into v_in from cl_cashbook_entries where source_type = 'ledger_payment' and source_id = v_pay.id order by created_at limit 1;
  if found then
    insert into cl_cashbook_entries (direction, amount, currency, coa_account_id, description, source_type, source_id, recorded_by)
    values ('out', v_in.amount, v_in.currency, v_in.coa_account_id, 'Reversal of collections payment: ' || v_reason,
            'ledger_payment_reversal', v_entry.id, v_staff)
    returning * into v_cash;
  end if;

  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (v_staff, 'reverse_ledger_payment', 'cl_ledger_entries', v_entry.id,
          json_build_object('vendor_id', v_pay.vendor_id, 'payment_id', v_pay.id, 'amount', v_pay.amount, 'currency', v_pay.currency,
                            'reason', v_reason, 'cashbook_entry_id', v_cash.id));

  return json_build_object('ledger_entry', row_to_json(v_entry), 'cashbook_entry', row_to_json(v_cash));
end $fn$;

revoke all on function public.cl_reverse_ledger_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.cl_reverse_ledger_payment(uuid, text) to authenticated;


-- 2. Duplicate guards ----------------------------------------------------
-- 2a. Old-style activation codes (production Console's "Log this issuance")
${ISSUE_NEW}

-- 2b. Collections payments
${PAY_NEW}

-- 2c. Ledger credits
${CRED_NEW}

-- 2d. Licences
${PREP_NEW}

commit;
`;

const ROLLBACK = `-- Rollback for supabase/migrations/20261012120000_payment_reversal_and_duplicate_guards.sql.
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

${ISSUE_OLD}

${PAY_OLD}

${CRED_OLD}

${PREP_OLD}

commit;
`;

fs.writeFileSync(path.join(ROOT, 'supabase/migrations/20261012120000_payment_reversal_and_duplicate_guards.sql'), MIGRATION);
fs.writeFileSync(path.join(ROOT, 'supabase/rollbacks/20261012120000_payment_reversal_and_duplicate_guards.rollback.sql'), ROLLBACK);
console.log('wrote migration (' + MIGRATION.length + ' chars) and rollback (' + ROLLBACK.length + ' chars)');
