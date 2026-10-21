// node tools/db/gen-20261110-migration.js
// One-off generator for supabase/migrations/20261110120000_staff_first_owner.sql and
// its rollback (owner, 2026-10-21: "go — ship this as v33", items 2 and 4, and
// Decision 2 "approved": the first Owner only on a MAIN till, for everyone, while
// the business has no Owner). Like gen-20261109-migration.js it copies the CURRENT
// body of every function it changes (the last definition in the migration files,
// proven equal to live by supabase/tests/baseline-rebuild-test.js), so each changed
// function differs only by its marked lines ("-- v33") and the rollback restores
// them byte for byte.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const READ = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const OUT = '20261110120000_staff_first_owner.sql';
const FILES = fs.readdirSync(MIG).filter((f) => /^\d{14}_\w+\.sql$/.test(f) && f < OUT).sort();

// The last "create [or replace] function public.<name>(" in the migration files, to its closing delimiter.
function latest(name) {
  let hit = null;
  const re = new RegExp('^create (or replace )?function public\\.' + name + '\\(', 'gm');
  for (const f of FILES) {
    const src = READ(path.join(MIG, f));
    let m; re.lastIndex = 0;
    while ((m = re.exec(src))) {
      const tagM = /\bas (\$[a-z_]*\$)/.exec(src.slice(m.index));
      if (!tagM) throw new Error(name + ': no body delimiter in ' + f);
      const tag = tagM[1], open = m.index + tagM.index + tagM[0].length;
      const close = src.indexOf(tag + ';', open);
      if (close < 0) throw new Error(name + ': body not closed in ' + f);
      hit = { file: f, text: src.slice(m.index, close + tag.length + 1) };
    }
  }
  if (!hit) throw new Error('function not found: ' + name);
  return hit.text.replace(/^create function /, 'create or replace function ');
}
function rep(src, anchor, text, what) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error((what || '') + ': anchor found ' + n + ' times: ' + anchor.slice(0, 90));
  return src.replace(anchor, () => text);
}
const ins = (src, anchor, text, what) => rep(src, anchor, anchor + text, what);

const ORIG = {}, NEW = {};
function change(name, fn) { ORIG[name] = latest(name); NEW[name] = fn(ORIG[name]); if (NEW[name] === ORIG[name]) throw new Error(name + ' unchanged'); }

const MAIN_TILL = "coalesce(v_main, false) and coalesce(me.device_kind, 'till') = 'till'";
const NO_STAFF = 'not exists (select 1 from cl_shop_staff x where x.business_id = me.business_id)';

// ---- 1. the pull: a main till registered after the cutoff may send its old list while the business has 0 staff ----
change('cl_device_staff_pull', (s) => ins(s,
  "    when exists (select 1 from cl_shop_legacy_uploads u where u.terminal_id = me.id) then 'done'\n",
  '    when me.registered_ts > (select v from cl_shop_meta where k = \'legacy_cutoff\') and ' + MAIN_TILL + '   -- v33: a main till\n' +
  "         and " + NO_STAFF + " then 'ready'   -- v33: while the business has 0 staff on seiGEN\n", 'pull upload'));

// ---- 2. the upload: the same rule (checked under the business lock), and every upload logged ----
change('cl_device_staff_upload', (s) => {
  s = rep(s,
    "  if me.registered_ts > (select v from cl_shop_meta where k = 'legacy_cutoff') then\n" +
    "    return json_build_object('error', 'NOT_NEEDED', 'message', 'This till joined after the staff moved to seiGEN, so it has no old staff list to send.');\n" +
    "  end if;\n" +
    "  select is_main into v_main from cl_branches where id = me.branch_id;\n",
    "  select is_main into v_main from cl_branches where id = me.branch_id;   -- v33: read before the cutoff check\n" +
    "  if me.registered_ts > (select v from cl_shop_meta where k = 'legacy_cutoff')\n" +
    '     and not (' + MAIN_TILL + ' and ' + NO_STAFF + ') then   -- v33: a main till while the business has 0 staff\n' +
    "    return json_build_object('error', 'NOT_NEEDED', 'message', 'This till joined after the staff moved to seiGEN, so it has no old staff list to send.');\n" +
    "  end if;\n", 'upload cutoff');
  s = ins(s, '    v_custrole := null;\n  end loop;\n',
    "  if n_add + n_merge > 0 then   -- v33: logged when someone moved (Console vendor record)\n" +
    "    insert into cl_shop_staff_events (business_id, kind, terminal_id, till_code, people)\n" +
    "    values (me.business_id, 'old_staff_moved', me.id, me.till_code, n_add + n_merge);\n" +
    "  end if;\n", 'upload log');
  return s;
});

// ---- 3. saving a person: the first Owner (owner 2026-10-21, Decision 2 "approved"), logged ----
change('cl_device_staff_save', (s) => {
  s = rep(s, 's cl_shop_staff%rowtype; v_by text;\nbegin\n',
    's cl_shop_staff%rowtype; v_by text;\n        v_had_owner boolean;   -- v33\nbegin\n', 'save declare');
  s = ins(s,
    "    return json_build_object('error', 'OWNER_ONLY', 'message', 'Only an Owner may give, change or take away the Owner role.');\n  end if;\n",
    "  -- v33: while the business has no active Owner, the first one is made on a main-branch till only (whoever saves);\n" +
    "  -- with the Admin passcode (nobody signed in) only as the business's first person. After that only an Owner gives it (above).\n" +
    "  v_had_owner := exists (select 1 from cl_shop_staff st join cl_shop_roles ro on ro.id = st.role_id\n" +
    "                          where st.business_id = me.business_id and st.active and ro.builtin = 'owner');   -- v33\n" +
    "  if v_role.builtin = 'owner' and coalesce(v_cur_tb, '') <> 'owner' and not v_had_owner then   -- v33\n" +
    '    if not (' + MAIN_TILL + ') then   -- v33\n' +
    "      return json_build_object('error', 'FIRST_OWNER_MAIN', 'message', 'The business''s first Owner is set on a main-branch till.');   -- v33\n" +
    "    end if;   -- v33\n" +
    '    if v_boot and exists (select 1 from cl_shop_staff x where x.business_id = me.business_id) then   -- v33\n' +
    "      return json_build_object('error', 'FIRST_OWNER_NOT_EMPTY', 'message', 'With the Admin passcode the Owner can only be the business''s first person. Sign in as an Admin to make someone Owner.');   -- v33\n" +
    "    end if;   -- v33\n" +
    "  end if;   -- v33\n", 'save first owner');
  s = rep(s, "  return json_build_object('ok', true, 'staff', cl_shop_staff_json(s, me.branch_id, me.id));\nend $fn$;",
    "  if v_role.builtin = 'owner' and coalesce(v_cur_tb, '') <> 'owner' and not v_had_owner then   -- v33: logged (Console vendor record)\n" +
    "    insert into cl_shop_staff_events (business_id, kind, terminal_id, till_code, staff_id, via)\n" +
    "    values (me.business_id, 'first_owner', me.id, me.till_code, s.id, case when v_boot then 'admin_passcode' else 'signed_in' end);\n" +
    "  end if;\n" +
    "  return json_build_object('ok', true, 'staff', cl_shop_staff_json(s, me.branch_id, me.id));\nend $fn$;", 'save log');
  return s;
});
const CHANGED = Object.keys(NEW);

const HEAD = `-- =====================================================================
-- Roles and staff, v33 (owner, 2026-10-21: "go — ship this as v33", items 2
-- and 4; Decision 2 "approved"). Applied live only after the owner has seen
-- this file and said "apply".
-- Rollback: supabase/rollbacks/20261110120000_staff_first_owner.rollback.sql
-- Tested in PGlite: supabase/tests/staff-first-owner-test.js (and the app's
-- test/staff-first-owner.test.js against this SQL)
-- Generated by tools/db/gen-20261110-migration.js: each changed function is its
-- current body plus the lines marked "-- v33".
--
-- 1. A till's old staff list (cl_device_staff_pull / cl_device_staff_upload):
--    as before, a till registered before the roles migration sends it once.
--    New: a MAIN till (not an Office seat) registered after it may also send
--    it once, but only while the business has 0 staff on seiGEN (checked
--    under the business lock). Every upload is logged.
-- 2. The first Owner (cl_device_staff_save): while the business has no
--    active Owner, the Owner role is given on a main-branch till only,
--    whoever saves (a signed-in Admin, or the Admin passcode); with the Admin
--    passcode only as the business's first person. Once there is an Owner,
--    only an Owner gives the Owner role (as before). Logged.
-- 3. cl_shop_staff_events: those two log lines, per business (till, time,
--    how many people / how the Owner was made; no names). The Console reads
--    them with cl_vendor_staff_events (staff with the Vendors module).
-- No other function, grant or data changes.
-- =====================================================================
`;

const SQL_MAIN = `
begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'function cl_device_staff_pull (20261107120000)' n where to_regprocedure('public.cl_device_staff_pull(text,text,text)') is null
    union all select 'function cl_device_staff_upload (20261107120000)' where to_regprocedure('public.cl_device_staff_upload(text,text,text,jsonb)') is null
    union all select 'function cl_device_staff_save (20261107120000)' where to_regprocedure('public.cl_device_staff_save(text,text,text,text,jsonb)') is null
    union all select 'function cl_rpn_staff (20261015120000)' where to_regprocedure('public.cl_rpn_staff(text[])') is null
    union all select 'column cl_terminals.device_kind (20261109120000)' where not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cl_terminals' and column_name = 'device_kind')
  ) x;
  if missing is not null then raise exception 'staff_first_owner aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_shop_staff_events' n where to_regclass('public.cl_shop_staff_events') is not null
    union all select 'function cl_vendor_staff_events' where exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'cl_vendor_staff_events')
  ) x;
  if conflicts is not null then raise exception 'staff_first_owner aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;

-- 1. The log ---------------------------------------------------------------
create table public.cl_shop_staff_events (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.cl_businesses(id) on delete cascade,
  kind text not null check (kind in ('old_staff_moved', 'first_owner')),
  terminal_id uuid references public.cl_terminals(id) on delete set null,
  till_code text,
  staff_id uuid references public.cl_shop_staff(id) on delete set null,
  via text check (via in ('admin_passcode', 'signed_in')),
  people integer,
  at timestamptz not null default now()
);
create index cl_shop_staff_events_business on public.cl_shop_staff_events (business_id, at);

-- 2. Changed functions (each differs from its current body only by "-- v33" lines) ----
${CHANGED.map((n) => NEW[n]).join('\n\n')}

-- 3. The Console: a vendor record's staff events (till and time; never names) ----
create function public.cl_vendor_staff_events(p_vendor_id uuid) returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['vendors']);
  return coalesce((select json_agg(json_build_object('kind', e.kind, 'till_code', e.till_code, 'via', e.via, 'people', e.people, 'at', e.at) order by e.at)
                     from cl_shop_staff_events e join cl_vendors v on v.business_id = e.business_id
                    where v.id = p_vendor_id), '[]'::json);
end $fn$;

-- 4. Who may call what ----------------------------------------------------------------
alter table public.cl_shop_staff_events enable row level security;
revoke all on table public.cl_shop_staff_events from public, anon, authenticated;
revoke all on function public.cl_vendor_staff_events(uuid) from public, anon, authenticated;
grant execute on function public.cl_vendor_staff_events(uuid) to authenticated;

commit;
`;

const RB = `-- Rollback of ${OUT}
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Puts ${CHANGED.join(', ')} back exactly as 20261107120000_shop_roles left
-- them and drops cl_vendor_staff_events and cl_shop_staff_events (the log
-- lines are lost; no staff, role or PIN changes).

begin;

drop function public.cl_vendor_staff_events(uuid);

${CHANGED.map((n) => ORIG[n]).join('\n\n')}

drop table public.cl_shop_staff_events;

commit;
`;

fs.writeFileSync(path.join(MIG, OUT), HEAD + SQL_MAIN);
fs.writeFileSync(path.join(ROOT, 'supabase', 'rollbacks', OUT.replace(/\.sql$/, '.rollback.sql')), RB);
console.log('Wrote ' + OUT + ' (' + CHANGED.length + ' changed functions: ' + CHANGED.join(', ') + ') and its rollback.');
