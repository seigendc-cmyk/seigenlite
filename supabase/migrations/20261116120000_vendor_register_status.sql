-- =====================================================================
-- Vendors Register: Registration and Licence (owner decision, 28 Oct 2026).
-- Applied on live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261116120000_vendor_register_status.rollback.sql
-- Tested in PGlite: supabase/tests/vendor-register-status-test.js
--
-- The Console's Vendors Register showed cl_vendors.status, which is
-- 'onboarding' for every vendor and never changes. It now shows two columns
-- worked out from real records. This file adds ONE read-only function for
-- them; nothing else changes (cl_vendors.status and its data stay as they are).
--
-- cl_vendor_register_status(): one row per cl_vendors row, for Console staff
-- who may see accounts (cl_plan_staff_ok: SysAdmin, Vendors Register,
-- Activation Codes, Collections Ledger or Billing & Reminders; the same
-- check as cl_plan_accounts). Only facts, never amounts, names or shop books
-- (decision 25):
--   business_id         the vendor row's business (cl_vendor_business)
--   tills_active        its business's tills that are active (cl_terminals,
--   tills_deactivated   device_kind 'till'); the vendor row's own if it has
--                       no business (none: it never registered)
--   seats_active        approved, active Office seats (shown apart)
--   licence_units       the devices a licence is judged on: the active tills;
--                       else every till; else the vendor row's own install
--   licence_current     of those, how many have a paid licence (issued or
--                       redeemed) whose valid_to is today or later, Harare:
--                       a licence day ends at 24:00 Harare (src/activation.js
--                       :30 and :260)
--   paid_valid_to       the earliest valid_to among the current ones (the
--                       next to run out)
--   paid_last_valid_to  the latest valid_to of any paid licence of the group
--   trial_ends_on       the latest trial of the vendor row's group
--   trial_running       ends_on > today, Harare (cl_trials_list, 20261019120000)
--   overdue             a positive Collections Ledger balance in any currency,
--                       the group's vendor rows added together (the Console's
--                       Billing & Reminders "Overdue vendors" rule, and its
--                       account balance: charges and payment reversals add,
--                       payments and credits take off). A yes/no only.
-- The group of a vendor row = its business's tills' vendor rows plus the
-- business's creator (as cl_plan_accounts), else the row itself.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'function cl_vendor_register_status' n where to_regprocedure('public.cl_vendor_register_status()') is not null
  ) x;
  if conflicts is not null then raise exception 'vendor_register_status aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'function cl_plan_staff_ok (20261013120000)' n where to_regprocedure('public.cl_plan_staff_ok()') is null
    union all select 'function cl_vendor_business (20261015120000)' where to_regprocedure('public.cl_vendor_business(uuid)') is null
    union all select 'table cl_trials (20261019120000)' where to_regclass('public.cl_trials') is null
    union all select 'column cl_licences.kind (20261019120000)' where not exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'cl_licences' and column_name = 'kind')
    union all select 'column cl_terminals.device_kind (20261109120000)' where not exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'cl_terminals' and column_name = 'device_kind')
  ) x;
  if missing is not null then raise exception 'vendor_register_status aborted: missing %. Nothing was changed.', missing; end if;
end $$;

-- 1. The function ---------------------------------------------------------
create function public.cl_vendor_register_status() returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_today date := (now() at time zone 'Africa/Harare')::date;
begin
  if not cl_plan_staff_ok() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return coalesce((select json_agg(row_to_json(x) order by x.created_at desc, x.vendor_id) from (
    select vb.vendor_id, vb.created_at, vb.business_id,
           tl.tills_active, tl.tills_deactivated, tl.seats_active,
           lic.licence_units, lic.licence_current, lic.paid_valid_to,
           (select max(l.valid_to) from cl_licences l
             where l.kind = 'paid' and l.status in ('issued', 'redeemed')
               and (l.vendor_id = any(g.vids) or l.install_id = any(g.iids) or (vb.business_id is not null and l.business_id = vb.business_id))) paid_last_valid_to,
           tr.trial_ends_on, coalesce(tr.trial_ends_on > v_today, false) trial_running,
           exists (select 1 from cl_ledger_entries le where le.vendor_id = any(g.vids)
                    group by le.currency
                   having sum(case when le.entry_type in ('charge', 'payment_reversal') then le.amount else -le.amount end) > 0.0001) overdue
    from (select v.id vendor_id, v.created_at, v.install_id, cl_vendor_business(v.id) business_id from cl_vendors v) vb
    -- the business's devices (tills and seats), else none
    cross join lateral (
      select coalesce(array_agg(te.install_id) filter (where te.device_kind = 'till' and te.active), '{}') active_iids,
             coalesce(array_agg(te.install_id) filter (where te.device_kind = 'till'), '{}') till_iids,
             count(*) filter (where te.device_kind = 'till' and te.active)::int tills_active,
             count(*) filter (where te.device_kind = 'till' and not te.active)::int tills_deactivated,
             count(*) filter (where te.device_kind = 'seat' and te.active and te.approval_status = 'approved')::int seats_active
      from cl_terminals te
      where (vb.business_id is not null and te.business_id = vb.business_id) or (vb.business_id is null and te.vendor_id = vb.vendor_id)
    ) tl
    -- the vendor rows and installs billed together
    cross join lateral (
      select array(select distinct y.x from (
               select te.vendor_id x from cl_terminals te where vb.business_id is not null and te.business_id = vb.business_id
               union select b.created_by_vendor_id from cl_businesses b where b.id = vb.business_id
               union select vb.vendor_id) y where y.x is not null) vids,
             array(select distinct y.x from (
               select te.install_id x from cl_terminals te where vb.business_id is not null and te.business_id = vb.business_id
               union select vb.install_id) y where y.x is not null) iids
    ) g
    -- the devices a licence is judged on, each with its latest paid licence
    cross join lateral (
      select count(*)::int licence_units,
             count(*) filter (where u.valid_to >= v_today)::int licence_current,
             min(u.valid_to) filter (where u.valid_to >= v_today) paid_valid_to
      from (select iid, (select max(l.valid_to) from cl_licences l
                          where l.kind = 'paid' and l.status in ('issued', 'redeemed') and l.install_id = iid) valid_to
            from unnest(case when cardinality(tl.active_iids) > 0 then tl.active_iids
                             when cardinality(tl.till_iids) > 0 then tl.till_iids
                             else array_remove(array[vb.install_id], null) end) iid) u
    ) lic
    cross join lateral (
      select max(t.ends_on) trial_ends_on from cl_trials t
      where t.vendor_id = any(g.vids) or t.install_id = any(g.iids) or (vb.business_id is not null and t.business_id = vb.business_id)
    ) tr
  ) x), '[]'::json);
end $fn$;

-- 2. Who may call it --------------------------------------------------------
revoke all on function public.cl_vendor_register_status() from public, anon, authenticated;
grant execute on function public.cl_vendor_register_status() to authenticated;

commit;
