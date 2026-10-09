-- =====================================================================
-- RPN self-update guard — approved 2026-10-09 (decision D4).
-- Rollback: supabase/rollbacks/20261009150000_rpn_self_update_guard.rollback.sql
-- Tested in PGlite: supabase/tests/rpn-self-update-guard-test.js
--
-- The problem (baseline, policy cl_rpn_update_self): an RPN signed in with
-- a cl_login token may UPDATE their own cl_rpn row, and the policy does not
-- limit which columns. So an RPN could set their own `active` back to true
-- after being deactivated, change `verification_code` / `verification_used`,
-- `passcode_hash`, or even `full_name` (the name they sign in with).
--
-- The fix, smallest change that keeps everything else working:
--   a BEFORE UPDATE trigger on cl_rpn. When the update comes straight from
--   the API (current_user is anon or authenticated) with an RPN token, only
--   `phone` and `city` may change; any other column changing is refused.
--
-- Not affected:
--   * staff updates (user_type 'staff', policy cl_rpn_write_staff);
--   * SECURITY DEFINER functions (cl_rpn_activate, cl_reissue_rpn_verification_code,
--     cl_login…): they run as the function owner, not anon/authenticated,
--     so the trigger lets them through exactly as today;
--   * the policy cl_rpn_update_self itself is left as it is.
-- =====================================================================

do $$
begin
  if to_regclass('public.cl_rpn') is null then
    raise exception 'rpn self-update guard aborted: table cl_rpn missing. Nothing was changed.';
  end if;
  if to_regprocedure('public.cl_jwt_user_type()') is null then
    raise exception 'rpn self-update guard aborted: function cl_jwt_user_type() missing. Nothing was changed.';
  end if;
  if exists (select 1 from pg_proc where proname = 'cl_rpn_self_update_guard' and pronamespace = 'public'::regnamespace) then
    raise exception 'rpn self-update guard aborted: function cl_rpn_self_update_guard already exists. Nothing was changed.';
  end if;
end $$;

create function public.cl_rpn_self_update_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if current_user in ('anon', 'authenticated') and cl_jwt_user_type() = 'rpn' then
    if new.id                is distinct from old.id
    or new.full_name         is distinct from old.full_name
    or new.passcode_hash     is distinct from old.passcode_hash
    or new.verification_code is distinct from old.verification_code
    or new.verification_used is distinct from old.verification_used
    or new.active            is distinct from old.active
    or new.created_at        is distinct from old.created_at
    or new.created_by        is distinct from old.created_by then
      raise exception 'An RPN can only change their own phone and city'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

comment on function public.cl_rpn_self_update_guard() is
  'Trigger: an RPN updating their own cl_rpn row through the API may change only phone and city. Staff and SECURITY DEFINER functions are not affected.';

create trigger cl_rpn_self_update_guard
  before update on public.cl_rpn
  for each row execute function public.cl_rpn_self_update_guard();
