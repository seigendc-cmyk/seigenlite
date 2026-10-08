-- =====================================================================
-- Collections Ledger: credits (owner's decision, 2026-10-08).
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261011120000_ledger_credits.rollback.sql
-- Tested in PGlite: supabase/tests/ledger-credits-test.js
--
-- A credit reduces a vendor's balance on the Collections Ledger WITHOUT
-- any cash: unlike cl_record_ledger_payment, it writes no Cashbook entry.
-- Used to reverse a charge made in error (e.g. a test licence).
--
--   * cl_ledger_entries.entry_type may now be 'credit' (as well as 'charge'
--     and 'payment'). A credit must carry a reason (notes).
--   * cl_ledger_entries.reverses_entry_id: optional, only on credits, the
--     charge it reverses (same vendor and currency; all credits against one
--     charge can't add up to more than the charge).
--   * cl_record_ledger_credit(...): the only way to post one. Active staff
--     with the Collections Ledger or Billing & Reminders module, or
--     sysadmin (the same people who may record payments). Logged in
--     cl_activity_log with who posted it.
-- Nothing else changes. Balances are computed only in the Console
-- (charges minus everything else), so a credit already counts there.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'column cl_ledger_entries.reverses_entry_id' n from information_schema.columns
      where table_schema = 'public' and table_name = 'cl_ledger_entries' and column_name = 'reverses_entry_id'
    union all select 'function cl_record_ledger_credit' where exists (select 1 from pg_proc where proname = 'cl_record_ledger_credit' and pronamespace = 'public'::regnamespace)
    union all select 'constraint cl_ledger_entries_credit_shape' where exists (select 1 from pg_constraint where conname = 'cl_ledger_entries_credit_shape')
  ) x;
  if conflicts is not null then raise exception 'ledger_credits aborted: already exists: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'table cl_ledger_entries' n where to_regclass('public.cl_ledger_entries') is null
    union all select 'table cl_activity_log' where to_regclass('public.cl_activity_log') is null
    union all select 'table cl_staff' where to_regclass('public.cl_staff') is null
    union all select 'function cl_has_module_access' where to_regprocedure('public.cl_has_module_access(text)') is null
    union all select 'constraint cl_ledger_entries_entry_type_check (charge, payment)'
      where not exists (select 1 from pg_constraint where conname = 'cl_ledger_entries_entry_type_check'
                          and conrelid = 'public.cl_ledger_entries'::regclass
                          and pg_get_constraintdef(oid) = 'CHECK ((entry_type = ANY (ARRAY[''charge''::text, ''payment''::text])))')
  ) x;
  if missing is not null then raise exception 'ledger_credits aborted: missing or different: %. Nothing was changed.', missing; end if;
end $$;


-- 1. The table ----------------------------------------------------------
alter table public.cl_ledger_entries drop constraint cl_ledger_entries_entry_type_check;
alter table public.cl_ledger_entries add constraint cl_ledger_entries_entry_type_check
  check (entry_type = any (array['charge'::text, 'payment'::text, 'credit'::text]));

alter table public.cl_ledger_entries add column reverses_entry_id uuid
  references public.cl_ledger_entries(id) on delete restrict;
-- only credits point at a charge, and a credit always says why
alter table public.cl_ledger_entries add constraint cl_ledger_entries_credit_shape
  check ((entry_type = 'credit' and coalesce(btrim(notes), '') <> '') or (entry_type <> 'credit' and reverses_entry_id is null));
create index cl_ledger_entries_reverses_idx on public.cl_ledger_entries (reverses_entry_id) where reverses_entry_id is not null;
comment on column public.cl_ledger_entries.reverses_entry_id is 'On a credit: the charge it reverses (cl_record_ledger_credit).';


-- 2. Posting a credit ---------------------------------------------------
create function public.cl_record_ledger_credit(p_vendor_id uuid, p_amount numeric, p_currency text, p_reason text,
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

revoke all on function public.cl_record_ledger_credit(uuid, numeric, text, text, uuid) from public, anon, authenticated;
grant execute on function public.cl_record_ledger_credit(uuid, numeric, text, text, uuid) to authenticated;

commit;
