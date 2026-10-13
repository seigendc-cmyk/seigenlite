-- =====================================================================
-- Server time for the app's trusted clock (owner, 2026-10-13: "fix the
-- network-time check (a)"). Applied live only after the owner has seen
-- this file and said "apply".
-- Rollback: supabase/rollbacks/20261020120000_server_time.rollback.sql
-- Tested in PGlite: supabase/tests/server-time-test.js
--
-- The app asked for the time with a bare HEAD request and read its Date
-- header, but a browser may not read that header across origins (Supabase
-- doesn't expose it), so in the phone and browser app the check always came
-- back empty and trials and licences ran on the device's clock (plus its
-- high-water mark). cl_server_time answers the time in the response BODY,
-- which the browser can read.
--
-- Nothing is read or written: it returns now() only. Callable by anon (the
-- app's built-in key, like every device RPC), so a device that hasn't
-- checked in yet gets the time too. Independent of 20261019120000.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
begin
  if to_regprocedure('public.cl_server_time()') is not null then
    raise exception 'server_time aborted: already there: function cl_server_time. Nothing was changed.';
  end if;
end $$;

-- 1. The function ---------------------------------------------------------
create function public.cl_server_time() returns json
language sql stable security invoker set search_path = public as $$
  select json_build_object('now', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;
comment on function public.cl_server_time() is 'Server time (20261020120000) for the app''s trusted clock: {now: ISO UTC}. Reads and writes nothing.';

-- 2. Who may call it ------------------------------------------------------
revoke all on function public.cl_server_time() from public;
grant execute on function public.cl_server_time() to anon, authenticated, service_role;

commit;
