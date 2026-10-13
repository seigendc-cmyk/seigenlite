// node tools/db/gen-20261023-migration.js
// One-off generator for supabase/migrations/20261023120000_admin_passcode_from_main.sql
// and its rollback (docs/multi-terminal/admin-passcode-on-join-design.md,
// owner's answers 2026-10-13: the main branch's Admin sets a joined device's
// Admin passcode; also for extra tills of the main branch; 6 characters;
// join codes from an older main build are refused: "Update the main branch
// till first"). It copies the CURRENT bodies of the functions it changes
// (proven equal to live by supabase/tests/baseline-rebuild-test.js), so each
// changed function differs only by the marked lines, and the rollback
// restores them byte for byte.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const READ = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const PLANS = READ('supabase/migrations/20261013120000_price_plans.sql');
const LOCK = READ('supabase/migrations/20261008140000_shared_stock_checkin_lock.sql');

function cut(src, start, endMarker) {
  const i = src.indexOf(start); if (i < 0) throw new Error('not found: ' + start.slice(0, 60));
  if (src.indexOf(start, i + 1) >= 0) throw new Error('start not unique: ' + start.slice(0, 60));
  const j = src.indexOf(endMarker, i); if (j < 0) throw new Error('end not found for ' + start.slice(0, 60));
  return src.slice(i, j + endMarker.length);
}
function rep(src, anchor, text) { if (src.split(anchor).length !== 2) throw new Error('anchor not unique: ' + anchor.slice(0, 70)); return src.replace(anchor, () => text); }
const ins = (src, anchor, text) => rep(src, anchor, anchor + text);

const ISSUE0 = cut(PLANS, 'create or replace function public.cl_branch_issue_join_code(', 'end $fn$;');
const JOIN0 = cut(PLANS, 'create or replace function public.cl_terminal_join(', 'end $fn$;');
const CHECKIN0 = cut(LOCK, 'create or replace function public.cl_device_checkin(', '$function$;');

// ---- issue: the code carries the new device's Admin check value ----
let ISSUE = ISSUE0;
ISSUE = rep(ISSUE, 'p_branch_id uuid default null, p_new_branch_name text default null, p_valid_hours int default 24)',
  'p_branch_id uuid default null, p_new_branch_name text default null, p_valid_hours int default 24,\n' +
  '  p_admin_salt text default null, p_admin_check text default null, p_admin_rounds int default null)   -- admin passcode from main');
ISSUE = ins(ISSUE, "  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);\n",
  "  -- admin passcode from main: a code without the new device's Admin check value comes from an older main build\n" +
  "  if not cl_admin_seed_ok(p_admin_salt, p_admin_check, p_admin_rounds) then\n" +
  "    raise exception 'UPDATE_MAIN_FIRST: Update the main branch till first. It sets the new device''s Admin passcode when it issues the code.' using errcode = 'P0001';\n" +
  "  end if;\n");
ISSUE = rep(ISSUE, "      insert into cl_branch_join_codes (branch_id, code_hash, issued_by_terminal, expires_ts)\n      values (target.id, encode(extensions.digest(code, 'sha256'), 'hex'), me.id, exp);",
  "      insert into cl_branch_join_codes (branch_id, code_hash, issued_by_terminal, expires_ts,\n" +
  "                                        admin_salt, admin_check, admin_rounds)                  -- admin passcode from main\n" +
  "      values (target.id, encode(extensions.digest(code, 'sha256'), 'hex'), me.id, exp,\n" +
  "              p_admin_salt, p_admin_check, p_admin_rounds);");

// ---- join: refuse an old app and a code without a check value; hand the check value over ----
let JOIN = JOIN0;
JOIN = rep(JOIN, '  p_expected_branch_name text default null)',
  '  p_expected_branch_name text default null, p_app_build integer default null)   -- admin passcode from main');
JOIN = rep(JOIN, '    if t.branch_id = br.id then return cl_terminal_json(t.id); end if;',
  '    if t.branch_id = br.id then return cl_terminal_join_json(t.id, jc.id); end if;   -- admin passcode from main');
JOIN = ins(JOIN, "  if jc.expires_ts < now() then return json_build_object('error', 'JOIN_CODE_EXPIRED'); end if;\n",
  "  -- admin passcode from main: an app before v21 would ignore the Admin passcode (and let anyone set one)\n" +
  "  if coalesce(p_app_build, 0) < 21 then\n" +
  "    raise exception 'APP_UPDATE_NEEDED: Update this app first, then join again. Your join code is still valid.' using errcode = 'P0001';\n" +
  "  end if;\n" +
  "  if jc.admin_check is null then return json_build_object('error', 'ADMIN_SEED_MISSING'); end if;   -- a code from an older main build\n");
JOIN = rep(JOIN, '  end if;\n  return cl_terminal_json(t.id);\nend $fn$;',
  '  end if;\n  return cl_terminal_join_json(t.id, jc.id);   -- admin passcode from main\nend $fn$;');

// ---- check-in: deliver a pending check value once ----
let CHECKIN = CHECKIN0;
CHECKIN = ins(CHECKIN, '  v_shared_lock boolean := false;                                    -- shared stock lock\n',
  '  v_admin_seed json;                                                 -- admin passcode seed\n');
CHECKIN = rep(CHECKIN, '  select coalesce(json_agg(json_build_object(\'id\', id, \'title\', title, \'body\', body, \'created_at\', created_at)), \'[]\'::json)\n',
  '  -- admin passcode seed: a check value the main branch set for this till, delivered once\n' +
  '  if v_terminal_id is not null then\n' +
  '    update cl_terminal_admin_seeds set delivered_ts = now()\n' +
  '     where terminal_id = v_terminal_id and delivered_ts is null\n' +
  '    returning json_build_object(\'salt\', salt, \'check\', check_value, \'rounds\', rounds, \'set_ts\', created_ts) into v_admin_seed;\n' +
  '  end if;\n\n' +
  '  select coalesce(json_agg(json_build_object(\'id\', id, \'title\', title, \'body\', body, \'created_at\', created_at)), \'[]\'::json)\n');
CHECKIN = rep(CHECKIN, "    'terminal_active', v_terminal_active        -- Phase 2, additive\n  );",
  "    'terminal_active', v_terminal_active,       -- Phase 2, additive\n" +
  "    'admin_seed', v_admin_seed                  -- admin passcode seed, additive\n  );");

const HEAD = `-- =====================================================================
-- A joined device's Admin passcode is set by the main branch (owner,
-- 2026-10-13: "the main branch Admin sets the new device's Admin passcode";
-- also for extra tills of the main branch; 6 characters; "refuse join codes
-- from an older main build, with the message 'Update the main branch till
-- first'"). Applied live only after the owner has seen this file and said
-- "apply".
-- Design: docs/multi-terminal/admin-passcode-on-join-design.md
-- Rollback: supabase/rollbacks/20261023120000_admin_passcode_from_main.rollback.sql
-- Tested in PGlite: supabase/tests/admin-passcode-from-main-test.js
-- Generated by tools/db/gen-20261023-migration.js (current bodies + marked lines).
--
-- Only a CHECK VALUE travels, never the passcode: the main till computes
-- PBKDF2-HMAC-SHA-256(passcode, 16-byte salt, rounds) itself (app v21,
-- src/passcode-check.js); seiGEN stores the salt, the result and the rounds,
-- and hands them to that one device: in the join answer, or once in a
-- check-in answer. The device compares typed passcodes against it, offline.
--
-- Changes:
--   cl_branch_join_codes        + admin_salt, admin_check, admin_rounds
--   cl_terminal_admin_seeds     new: one pending check value per till
--   cl_admin_seed_ok            new (internal): is it a well-formed check value?
--   cl_terminal_join_json       new (internal): the terminal's JSON + its code's check value
--   cl_branch_issue_join_code   + p_admin_salt/check/rounds, REQUIRED
--                               (an older main build is told "Update the main branch till first")
--   cl_terminal_join            + p_app_build: an app before v21 is told to update first;
--                               a code without a check value: ADMIN_SEED_MISSING;
--                               the answer carries admin_seed
--   cl_terminal_admin_set       new: a main-branch till sets another till's check value
--   cl_device_checkin           the answer carries admin_seed once (same signature)
-- Existing unused join codes have no check value, so they can't be used: the
-- main till issues a new one.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text;
begin
  if to_regclass('public.cl_terminal_admin_seeds') is not null
     or exists (select 1 from pg_proc where proname = 'cl_device_checkin' and prosrc like '%admin passcode seed%') then
    raise exception 'admin_passcode_from_main aborted: already there (cl_terminal_admin_seeds or the check-in seed). Nothing was changed.';
  end if;
  select string_agg(n, ', ') into missing from (
    select 'function cl_branch_issue_join_code (6 args)' n where to_regprocedure('public.cl_branch_issue_join_code(text,text,text,uuid,text,integer)') is null
    union all select 'function cl_terminal_join (10 args)' where to_regprocedure('public.cl_terminal_join(text,text,text,text,text,text,text,text,text,text)') is null
    union all select 'function cl_device_checkin (11 args)' where to_regprocedure('public.cl_device_checkin(text,text,text,text,text,text,text,text,uuid,text,integer)') is null
    union all select 'the shared stock lock in cl_device_checkin' where not exists (select 1 from pg_proc where proname = 'cl_device_checkin' and prosrc like '%shared stock lock%')
  ) x;
  if missing is not null then raise exception 'admin_passcode_from_main aborted: missing %. Nothing was changed.', missing; end if;
end $$;

-- 1. Where the check values live ------------------------------------------
alter table public.cl_branch_join_codes
  add column admin_salt   text,
  add column admin_check  text,
  add column admin_rounds integer,
  add constraint cl_branch_join_codes_admin_check_ok check (
    (admin_salt is null and admin_check is null and admin_rounds is null)
    or (admin_salt ~ '^[0-9a-f]{32}$' and admin_check ~ '^[0-9a-f]{64}$' and admin_rounds between 100000 and 2000000));

create table public.cl_terminal_admin_seeds (
  terminal_id     uuid primary key references public.cl_terminals(id),
  salt            text not null check (salt ~ '^[0-9a-f]{32}$'),
  check_value     text not null check (check_value ~ '^[0-9a-f]{64}$'),
  rounds          integer not null check (rounds between 100000 and 2000000),
  set_by_terminal uuid not null references public.cl_terminals(id),
  created_ts      timestamptz not null default now(),
  delivered_ts    timestamptz
);
comment on table public.cl_terminal_admin_seeds is 'Admin passcode from main (20261023120000): the check value (never the passcode) a main-branch till set for another till; delivered once in its check-in answer.';
alter table public.cl_terminal_admin_seeds enable row level security;
revoke all on table public.cl_terminal_admin_seeds from anon, authenticated;

-- 2. Helpers (internal) -------------------------------------------------
create function public.cl_admin_seed_ok(p_salt text, p_check text, p_rounds integer) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(p_salt ~ '^[0-9a-f]{32}$' and p_check ~ '^[0-9a-f]{64}$' and p_rounds between 100000 and 2000000, false)
$$;
revoke execute on function public.cl_admin_seed_ok(text, text, integer) from public, anon, authenticated;

-- The terminal's JSON, plus its join code's check value (only for the till that used the code).
create function public.cl_terminal_join_json(p_terminal_id uuid, p_code_id uuid) returns json
language sql stable set search_path = public as $$
  select (cl_terminal_json(p_terminal_id)::jsonb || jsonb_build_object('admin_seed',
           (select jsonb_build_object('salt', c.admin_salt, 'check', c.admin_check, 'rounds', c.admin_rounds)
              from cl_branch_join_codes c
             where c.id = p_code_id and c.used_by_terminal = p_terminal_id and c.admin_check is not null)))::json
$$;
revoke execute on function public.cl_terminal_join_json(uuid, uuid) from public, anon, authenticated;

-- 3. Issuing a join code (price plans body + marked lines) ------------------
drop function public.cl_branch_issue_join_code(text, text, text, uuid, text, int);
${ISSUE}
grant execute on function public.cl_branch_issue_join_code(text, text, text, uuid, text, int, text, text, int) to anon, authenticated;

-- 4. Joining (price plans body + marked lines) --------------------------------
drop function public.cl_terminal_join(text, text, text, text, text, text, text, text, text, text);
${JOIN}
grant execute on function public.cl_terminal_join(text, text, text, text, text, text, text, text, text, text, integer) to anon, authenticated;

-- 5. A main-branch till sets another till's Admin passcode -------------------
create function public.cl_terminal_admin_set(
  p_install_id text, p_secret_phrase text, p_device_key text, p_terminal_id uuid,
  p_admin_salt text, p_admin_check text, p_admin_rounds integer)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; me cl_terminals%rowtype; t cl_terminals%rowtype;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  select tt.* into me from cl_terminals tt join cl_branches b on b.id = tt.branch_id
   where tt.vendor_id = v.id and tt.active and b.is_main;
  if not found then raise exception 'Only a main-branch terminal can set a till''s Admin passcode' using errcode = 'P0001'; end if;
  if not cl_admin_seed_ok(p_admin_salt, p_admin_check, p_admin_rounds) then
    raise exception 'ADMIN_SEED_INVALID: That Admin passcode check value isn''t valid' using errcode = 'P0001';
  end if;
  select * into t from cl_terminals where id = p_terminal_id and business_id = me.business_id;
  if not found then raise exception 'Terminal not found in this business' using errcode = 'P0001'; end if;
  if t.id = me.id then raise exception 'A till sets its own Admin passcode in Settings' using errcode = 'P0001'; end if;
  insert into cl_terminal_admin_seeds (terminal_id, salt, check_value, rounds, set_by_terminal, created_ts, delivered_ts)
  values (t.id, p_admin_salt, p_admin_check, p_admin_rounds, me.id, now(), null)
  on conflict (terminal_id) do update set salt = excluded.salt, check_value = excluded.check_value, rounds = excluded.rounds,
    set_by_terminal = excluded.set_by_terminal, created_ts = excluded.created_ts, delivered_ts = null;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'terminal_admin_set', 'cl_terminals', t.id,
          jsonb_build_object('till_code', t.till_code, 'branch_id', t.branch_id, 'by_terminal', me.id, 'by_till', me.till_code));
  return (cl_terminal_json(t.id)::jsonb || jsonb_build_object('admin_set', true))::json;
end $fn$;
grant execute on function public.cl_terminal_admin_set(text, text, text, uuid, text, text, integer) to anon, authenticated;

-- 6. Check-in (shared stock lock body + marked lines; same signature) ---------
${CHECKIN}

commit;
`;

const RB = `-- Rollback of 20261023120000_admin_passcode_from_main.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Generated by tools/db/gen-20261023-migration.js: the three changed
-- functions go back to their price-plans / shared-stock-lock bodies byte for
-- byte; the check values, the seeds table and the new functions are dropped.
-- Apps on v21 then can't issue or use join codes until updated again (their
-- calls carry parameters the old functions don't have).

begin;

drop function if exists public.cl_terminal_admin_set(text, text, text, uuid, text, text, integer);

drop function public.cl_terminal_join(text, text, text, text, text, text, text, text, text, text, integer);
${JOIN0.replace('create or replace function', 'create function')}
grant execute on function public.cl_terminal_join(text, text, text, text, text, text, text, text, text, text) to anon, authenticated;

drop function public.cl_branch_issue_join_code(text, text, text, uuid, text, int, text, text, int);
${ISSUE0.replace('create or replace function', 'create function')}
grant execute on function public.cl_branch_issue_join_code(text, text, text, uuid, text, int) to anon, authenticated;

${CHECKIN0}

drop function public.cl_terminal_join_json(uuid, uuid);
drop function public.cl_admin_seed_ok(text, text, integer);
drop table public.cl_terminal_admin_seeds;
alter table public.cl_branch_join_codes
  drop constraint cl_branch_join_codes_admin_check_ok,
  drop column admin_salt,
  drop column admin_check,
  drop column admin_rounds;

commit;
`;

fs.writeFileSync(path.join(ROOT, 'supabase/migrations/20261023120000_admin_passcode_from_main.sql'), HEAD);
fs.writeFileSync(path.join(ROOT, 'supabase/rollbacks/20261023120000_admin_passcode_from_main.rollback.sql'), RB);
console.log('wrote 20261023120000_admin_passcode_from_main.sql and its rollback');
