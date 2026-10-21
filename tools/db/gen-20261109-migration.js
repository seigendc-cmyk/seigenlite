// node tools/db/gen-20261109-migration.js
// One-off generator for supabase/migrations/20261109120000_office_seats.sql and
// its rollback (docs/office/office-seat-design.md, owner: "go Seat-B with the
// design as recommended", 2026-10-20). It copies the CURRENT body of every
// function it changes (the last definition in the migration files, proven
// equal to live by supabase/tests/baseline-rebuild-test.js), so each changed
// function differs only by its marked lines ("-- office seats") and the
// rollback restores them byte for byte.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const READ = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const OUT = '20261109120000_office_seats.sql';
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

// ---- 1. the device check: a seat's own phrase (+ "|<staff token>"), approval, who is signed in ----
change('cl_install_vendor', (s) => {
  s = rep(s, 'declare v cl_vendors%rowtype;\nbegin\n',
    'declare v cl_vendors%rowtype;\n' +
    '        st cl_terminals%rowtype; v_tok text; v_staff uuid;                -- office seats\n' +
    'begin\n' +
    "  perform set_config('cl.seat_terminal', '', true);                     -- office seats: who the caller is, for cl_seat_need\n" +
    "  perform set_config('cl.seat_staff', '', true);                        -- office seats\n", 'install_vendor declare');
  s = ins(s, '    return v;\n  end if;\n\n',
    '  -- office seats: a seat sends its own phrase, then "|" and the signed-in person\'s token\n' +
    "  select * into st from cl_terminals where vendor_id = v.id and device_kind = 'seat';\n" +
    '  if st.id is not null then\n' +
    "    v_tok := nullif(split_part(coalesce(p_phrase, ''), '|', 2), '');\n" +
    "    p_phrase := split_part(coalesce(p_phrase, ''), '|', 1);\n" +
    '  end if;\n', 'install_vendor seat phrase');
  s = rep(s, '  return v;\nend $fn$;',
    '  -- office seats: an unapproved seat gets nothing (cl_seat_status / cl_seat_set_pin excepted)\n' +
    '  if st.id is not null then\n' +
    "    if st.approval_status <> 'approved' and coalesce(current_setting('cl.allow_pending_seat', true), '') <> '1' then\n" +
    "      raise exception 'SEAT_NOT_APPROVED: This Office seat is waiting for approval by the Owner or an Admin.' using errcode = 'P0001';\n" +
    '    end if;\n' +
    "    perform set_config('cl.seat_terminal', st.id::text, true);\n" +
    '    if v_tok is not null then\n' +
    '      select x.staff_id into v_staff from cl_shop_session(v_tok, st.id) x limit 1;\n' +
    "      if v_staff is not null then perform set_config('cl.seat_staff', v_staff::text, true); end if;\n" +
    '    end if;\n' +
    '  end if;\n' +
    '  return v;\nend $fn$;', 'install_vendor end');
  return s;
});

// ---- 2. a seat code never makes a till ----
change('cl_terminal_join', (s) => rep(s,
  "  select * into jc from cl_branch_join_codes where code_hash = encode(extensions.digest(norm, 'sha256'), 'hex') for update;",
  "  select * into jc from cl_branch_join_codes where code_hash = encode(extensions.digest(norm, 'sha256'), 'hex')\n" +
  "     and code_kind = 'till' for update;                                 -- office seats: an invite code isn't a join code"));

// ---- 3. billing: role 'seat' at the extra-till fee; tills are ranked among tills only ----
change('cl_plan_price', (s) => {
  s = rep(s, "    select * into br from cl_branches where id = te.branch_id;\n",
    "    if te.device_kind = 'seat' and te.approval_status <> 'approved' then        -- office seats\n" +
    "      raise exception 'SEAT_NOT_APPROVED: Office seat % is waiting for approval by the Owner or an Admin.', te.till_code using errcode = 'P0001';\n" +
    '    end if;\n' +
    '    select * into br from cl_branches where id = te.branch_id;\n');
  s = rep(s, '     where o.branch_id = te.branch_id and o.active and substr(o.till_code, 2)::int < substr(te.till_code, 2)::int;\n',
    "     where o.branch_id = te.branch_id and o.active and o.device_kind = 'till'   -- office seats: seats aren't ranked\n" +
    '       and substr(o.till_code, 2)::int < substr(te.till_code, 2)::int;\n');
  s = rep(s, "    v_role := case when v_rank > 1 then 'till' when br.is_main then 'main' else 'branch' end;",
    "    v_role := case when te.device_kind = 'seat' then 'seat'                   -- office seats: the extra-till fee\n" +
    "                   when v_rank > 1 then 'till' when br.is_main then 'main' else 'branch' end;");
  return s;
});
change('cl_next_till_code', (s) => rep(s, 'from cl_terminals where branch_id = p_branch_id',
  "from cl_terminals where branch_id = p_branch_id and till_code like 'T%'   -- office seats: S<n> is counted apart"));

// ---- 4. the signed licence says "Office seat" (features bit 1) ----
change('cl_licence_prepare', (s) => {
  s = rep(s, "      || '\\x0000'::bytea\n      || v_biz_bytes;\n    update cl_licences set payload = v_payload where serial = v_serial;",
    "      || cl_seat_features(t.terminal_id)                                   -- office seats (was '\\x0000')\n      || v_biz_bytes;\n" +
    '    update cl_licences set payload = v_payload, features = get_byte(cl_seat_features(t.terminal_id), 1) where serial = v_serial;   -- office seats');
  return s;
});
change('cl_trial_payload', (s) => rep(s, "    || '\\x0000'::bytea\n    || v_biz;\n  update cl_licences set payload = v_payload where serial = p_serial;",
  "    || cl_seat_features(l.terminal_id)                                     -- office seats (was '\\x0000')\n    || v_biz;\n" +
  '  update cl_licences set payload = v_payload, features = get_byte(cl_seat_features(l.terminal_id), 1) where serial = p_serial;   -- office seats'));

// ---- 5. the device list shows the kind and the approval; per-device figures only for approved devices ----
change('cl_branch_list', (s) => rep(s, "            'registered_ts', t.registered_ts, 'last_seen_ts', t.last_seen_ts) order by t.till_code)",
  "            'registered_ts', t.registered_ts, 'last_seen_ts', t.last_seen_ts,\n" +
  "            'kind', t.device_kind, 'approval', t.approval_status) order by t.till_code)   -- office seats"));
change('cl_bs_enabled', (s) => rep(s, 'where t.business_id = p_business and t.active) >= 2\n',
  "where t.business_id = p_business and t.active and t.approval_status = 'approved') >= 2   -- office seats\n"));

// ---- 6. shared stock stays for branches without a seat ----
change('cl_stock_start_shared', (s) => ins(s, "  if b.stock_mode = 'shared' then return json_build_object('error', 'ALREADY_SHARED'); end if;\n",
  "  if exists (select 1 from cl_terminals where branch_id = b.id and device_kind = 'seat' and active) then   -- office seats\n" +
  "    return json_build_object('error', 'SEATS_HERE', 'message', 'This branch has an Office seat, so it can''t use shared stock.');\n" +
  '  end if;\n'));

// ---- 7. on a seat, these need the signed-in person's right (tills: unchanged) ----
const NEED = {
  cl_device_grv_post: 'm.receive', cl_device_dispatch_send: 'm.dispatch', cl_device_dispatch_cancel: 'm.dispatch',
  cl_device_dispatch_resolve: 'm.dispatch', cl_device_supplier_grv_post: 'm.purchasing', cl_device_supplier_save: 'm.purchasing',
  cl_catalogue_push: 'm.products', cl_branch_price_push: 'edit_prices', cl_device_customer_save: 'create_customers',
  cl_terminal_set_active: 'm.terminals', cl_terminal_admin_set: 'm.terminals', cl_branch_issue_join_code: 'm.terminals',
  cl_branch_set_price_mode: 'm.settings', cl_branch_set_business_day: 'm.settings', cl_device_pack_submit: 'm.marketing',
  // selling, payments, EOD: always refused on a seat
  cl_stock_sale: 'm.sell', cl_device_itred_order_complete: 'm.sell', cl_device_itred_line_update: 'm.sell', cl_device_itred_message_send: 'm.sell',
};
for (const [name, right] of Object.entries(NEED)) {
  change(name, (s) => {
    const lines = s.split('\n');
    const i = lines.findIndex((l) => /:=\s*cl_[a-z_]+\(p_install_id\b/.test(l));
    if (i < 0) throw new Error(name + ': no device check line');
    if (!/;\s*$/.test(lines[i])) throw new Error(name + ': device check spans lines');
    const indent = /^\s*/.exec(lines[i])[0];
    lines.splice(i + 1, 0, indent + "perform cl_seat_need('" + right + "');" + ' '.repeat(Math.max(1, 52 - indent.length - right.length)) + '-- office seats');
    return lines.join('\n');
  });
}
const CHANGED = Object.keys(ORIG);

// ---------------------------------------------------------------------------
const HEAD = `-- =====================================================================
-- Office seats by invite (owner, 2026-10-20: "go Seat-B with the design as
-- recommended", plus the internal transfer, the install page always showing
-- the code, and approval by comparing the short check). Applied live only
-- after the owner has seen this file and said "apply".
-- Design: docs/office/office-seat-design.md
-- Rollback: supabase/rollbacks/20261109120000_office_seats.rollback.sql
-- Tested in PGlite: supabase/tests/office-seats-test.js (and the app's
-- test/office-seat.test.js and test/office-seat-e2e.test.js against this SQL)
-- Generated by tools/db/gen-20261109-migration.js from the current function
-- bodies, so each changed function differs only by its "-- office seats" lines.
--
-- An Office seat is a device on the MAIN branch with no till: it never sells,
-- takes payments or runs End of Day; it holds main-branch stock (counted in
-- main's total, like a till) and does stores and office work by the signed-in
-- person's rights.
--  1. cl_terminals: device_kind ('till' | 'seat'), approval_status ('approved'
--     for every existing device), approved / refused by and when; till codes
--     T<n> for tills, S<n> for seats.
--  2. Invites are join codes (cl_branch_join_codes, code_kind 'seat'): one
--     named person (existing, or new with a role), 24 hours, one use,
--     revocable; seiGEN keeps only the code's SHA-256. Owner or Admin only
--     (signed in). Not for the Cashier role; not at a shared-stock main.
--  3. cl_seat_join: the code, the install ID and the device key, NO business
--     phrase. The seat gets its own random phrase (returned once, never shown).
--     5 wrong codes per install per hour, and 20 per caller address per hour
--     when seiGEN can see one (only a SHA-256 of it is kept), lock joining.
--  4. The person sets their PIN (a new person, or one without a PIN) or
--     enters their PIN (counted like a sign-in); then the Owner or an Admin
--     approves the device after comparing the short device check shown on
--     both screens. Until then every device function refuses the seat.
--  5. On a seat every device call carries the signed-in person's token after
--     the phrase ("<phrase>|<token>"); the calls that change data need that
--     person's right (cl_seat_need); selling, payments, EOD and iTred orders
--     are always refused. Tills: unchanged.
--  6. Billing: role 'seat' at the plan's extra-till fee ($3, Business and
--     Lite); seats are never ranked as a branch's first till. The signed
--     licence carries features bit 1 = Office seat. cl_business_bill: every
--     device of the business with its role and fee, and the total.
--  7. Internal transfers between a seat and a till of the same branch: the
--     sender posts, the receiving device confirms the quantities; a shortage
--     goes back to the sender, who writes it off (ADJ) or keeps it. No costs,
--     no transport, no charge. Each device moves its own stock once per
--     document (the app's ledger), as for dispatches.
--  8. Audit (cl_activity_log): invite created / revoked, joined, PIN set,
--     approved, refused. Never a code, a phrase or a PIN.
-- RLS on every new table; no table grants to anon/authenticated.
-- =====================================================================
`;

const SQL_MAIN = `
begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'function cl_shop_staff_at (20261108120000)' n where to_regprocedure('public.cl_shop_staff_at(public.cl_shop_staff,uuid)') is null
    union all select 'table cl_till_stock_levels (20261024120000)' where to_regclass('public.cl_till_stock_levels') is null
    union all select 'constraint cl_terminals_till_code_check' where not exists (select 1 from pg_constraint where conname = 'cl_terminals_till_code_check')
  ) x;
  if missing is not null then raise exception 'office_seats aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'column cl_terminals.' || c n from unnest(array['device_kind', 'approval_status']) c
      where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cl_terminals' and column_name = c)
    union all select 'table ' || t from unnest(array['cl_internal_transfers', 'cl_internal_transfer_lines']) t where to_regclass('public.' || t) is not null
    union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cl_seat_need', 'cl_seat_features', 'cl_seat_check', 'cl_seat_ip_hash', 'cl_seat_admin', 'cl_seat_join', 'cl_seat_status', 'cl_seat_set_pin',
                      'cl_device_seat_invite_create', 'cl_device_seat_invites', 'cl_device_seat_invite_revoke', 'cl_device_seat_approve',
                      'cl_device_seat_refuse', 'cl_business_bill', 'cl_transfer_json', 'cl_device_transfer_send', 'cl_device_transfers_pull',
                      'cl_device_transfer_receive', 'cl_device_transfer_cancel', 'cl_device_transfer_resolve')
  ) x;
  if conflicts is not null then raise exception 'office_seats aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;

-- 1. Devices ------------------------------------------------------------------
alter table public.cl_terminals
  add column device_kind text not null default 'till' check (device_kind in ('till', 'seat')),
  add column approval_status text not null default 'approved' check (approval_status in ('pending', 'approved', 'refused')),
  add column approved_ts timestamptz,
  add column approved_by_staff uuid references public.cl_shop_staff(id) on delete set null,
  add column refused_ts timestamptz,
  add column refused_reason text check (refused_reason is null or length(refused_reason) <= 200);
alter table public.cl_terminals drop constraint cl_terminals_till_code_check;
alter table public.cl_terminals add constraint cl_terminals_till_code_check check (
  (device_kind = 'till' and till_code ~ '^T[0-9]{1,3}$') or (device_kind = 'seat' and till_code ~ '^S[0-9]{1,3}$'));

-- 2. Invites (join codes of kind 'seat') -------------------------------------------
alter table public.cl_branch_join_codes
  add column code_kind text not null default 'till' check (code_kind in ('till', 'seat')),
  add column staff_id uuid references public.cl_shop_staff(id) on delete set null,     -- an existing person
  add column person_name text check (person_name is null or length(btrim(person_name)) between 1 and 60),
  add column role_id uuid references public.cl_shop_roles(id) on delete set null,       -- a new person's role
  add column issued_by_staff uuid references public.cl_shop_staff(id) on delete set null,
  add column revoked_ts timestamptz,
  add column revoked_by_staff uuid references public.cl_shop_staff(id) on delete set null,
  add column join_hint text check (join_hint is null or length(join_hint) <= 60),       -- "Android · Chrome", from the joining app
  add column pin_bcrypt text, add column pin_salt text, add column pin_check text, add column pin_rounds integer,
  add column pin_ok boolean not null default false;
alter table public.cl_licences drop constraint cl_licences_till_role_check;   -- the role 'seat' on a licence's price snapshot
alter table public.cl_licences add constraint cl_licences_till_role_check check (till_role in ('main', 'branch', 'till', 'seat'));
alter table public.cl_join_failures
  add column code_kind text not null default 'till',
  add column ip_hash text;
create index cl_join_failures_seat_idx on public.cl_join_failures (install_id, ts) where code_kind = 'seat';
create index cl_join_failures_ip_idx on public.cl_join_failures (ip_hash, ts) where ip_hash is not null;

-- 3. Internal transfers ----------------------------------------------------------------
create table public.cl_internal_transfers (
  id               uuid primary key,                       -- made on the sending device
  business_id      uuid not null references public.cl_businesses(id),
  branch_id        uuid not null references public.cl_branches(id),
  from_terminal_id uuid not null references public.cl_terminals(id),
  to_terminal_id   uuid not null references public.cl_terminals(id),
  it_no            integer not null check (it_no > 0),
  it_display       text not null check (length(it_display) between 1 and 40),
  created_iso      text check (created_iso is null or length(created_iso) <= 40),
  note             text check (note is null or length(note) <= 200),
  sent_by          text check (sent_by is null or length(sent_by) <= 80),
  sent_at          timestamptz not null default now(),
  status           text not null default 'sent' check (status in ('sent', 'received', 'received_short', 'cancelled')),
  received_at      timestamptz,
  received_by      text check (received_by is null or length(received_by) <= 80),
  cancelled_at     timestamptz,
  cancelled_by     text,
  cancel_reason    text check (cancel_reason is null or length(cancel_reason) <= 200),
  unique (from_terminal_id, it_no),
  check (from_terminal_id <> to_terminal_id)
);
create index cl_internal_transfers_to_idx on public.cl_internal_transfers (to_terminal_id, status);
create index cl_internal_transfers_from_idx on public.cl_internal_transfers (from_terminal_id, sent_at);
create table public.cl_internal_transfer_lines (
  transfer_id  uuid not null references public.cl_internal_transfers(id) on delete cascade,
  line_no      integer not null check (line_no between 1 and 500),
  cat_uid      text check (cat_uid is null or length(cat_uid) <= 64),
  code         text check (code is null or length(code) <= 64),
  name         text not null check (length(btrim(name)) between 1 and 120),
  qty          integer not null check (qty between 1 and 1000000),
  received     integer check (received >= 0 and received <= qty),
  short_status text check (short_status in ('open', 'written_off', 'kept')),
  short_resolved_at timestamptz,
  short_resolved_by text check (short_resolved_by is null or length(short_resolved_by) <= 80),
  short_note   text check (short_note is null or length(short_note) <= 200),
  adj_display  text check (adj_display is null or length(adj_display) <= 40),
  primary key (transfer_id, line_no)
);
alter table public.cl_internal_transfers enable row level security;
alter table public.cl_internal_transfer_lines enable row level security;
revoke all on table public.cl_internal_transfers, public.cl_internal_transfer_lines from anon, authenticated;

-- 4. Helpers (internal) ---------------------------------------------------------------
-- On a seat: the signed-in person (cl_install_vendor read the token) must hold p_right.
-- Selling, payments and EOD rights: never on a seat. Not a seat: nothing to check.
create function public.cl_seat_need(p_right text) returns void
language plpgsql stable security definer set search_path = public as $fn$
declare v_seat text := coalesce(current_setting('cl.seat_terminal', true), '');
        v_staff text := coalesce(current_setting('cl.seat_staff', true), ''); v_rights text[]; v_name text;
begin
  if v_seat = '' then return; end if;
  if p_right = any(array['m.sell', 'm.credit', 'm.eod', 'void_return', 'credit_over_limit']) then
    raise exception 'SEAT_NO_SELLING: An Office seat can''t sell, take payments or run End of Day.' using errcode = 'P0001';
  end if;
  if v_staff = '' then
    raise exception 'SEAT_SIGN_IN: Sign in on this Office seat first (online).' using errcode = 'P0001';
  end if;
  select cl_shop_effective_rights(r), s.name into v_rights, v_name
    from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id where s.id = v_staff::uuid and s.active;
  if v_rights is null or not (p_right = any(v_rights)) then
    raise exception 'SEAT_NO_RIGHT: % doesn''t have the right for this (%).', coalesce(v_name, 'This person'), p_right using errcode = 'P0001';
  end if;
end $fn$;

-- The licence's features field: bit 1 = Office seat.
create function public.cl_seat_features(p_terminal uuid) returns bytea
language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from cl_terminals where id = p_terminal and device_kind = 'seat') then '\\x0001'::bytea else '\\x0000'::bytea end
$$;

-- The short device check both screens show: the first 2 bytes of SHA-256(device key), "4F-9A".
create function public.cl_seat_check(p_device_key text) returns text
language sql immutable as $$
  select upper(substr(h, 1, 2) || '-' || substr(h, 3, 2)) from (select encode(extensions.digest(coalesce(p_device_key, ''), 'sha256'), 'hex') h) x
$$;

-- The caller's address as seiGEN sees it (first x-forwarded-for entry, or cf-connecting-ip), hashed; null when not visible.
create function public.cl_seat_ip_hash() returns text
language plpgsql stable set search_path = public as $fn$
declare h json; ip text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  ip := btrim(split_part(coalesce(h->>'x-forwarded-for', h->>'cf-connecting-ip', h->>'x-real-ip', ''), ',', 1));
  if ip = '' then return null; end if;
  return encode(extensions.digest('cl-seat-ip:' || ip, 'sha256'), 'hex');
end $fn$;

-- The Owner or an Admin signed in on an active device of the main branch -> the session, else null.
create function public.cl_seat_admin(me public.cl_terminals, p_staff_token text)
returns table (staff_id uuid, business_id uuid, name text, builtin text, rights text[])
language sql stable security definer set search_path = public as $$
  select x.* from cl_shop_session(p_staff_token, me.id) x
   where me.active and (select is_main from cl_branches where id = me.branch_id) and x.builtin in ('owner', 'admin')
$$;

-- One internal transfer as the devices see it.
create function public.cl_transfer_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', x.id, 'it_no', x.it_no, 'it_display', x.it_display, 'branch_id', x.branch_id,
    'from_terminal_id', x.from_terminal_id, 'from_till', ft.till_code, 'from_kind', ft.device_kind,
    'to_terminal_id', x.to_terminal_id, 'to_till', tt.till_code, 'to_kind', tt.device_kind,
    'created_iso', x.created_iso, 'note', x.note, 'sent_by', x.sent_by, 'sent_at', x.sent_at, 'status', x.status,
    'received_at', x.received_at, 'received_by', x.received_by, 'cancelled_at', x.cancelled_at, 'cancel_reason', x.cancel_reason,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'cat_uid', l.cat_uid, 'code', l.code, 'name', l.name,
        'qty', l.qty, 'received', l.received, 'short', case when l.received is null then null else l.qty - l.received end,
        'short_status', l.short_status, 'short_resolved_by', l.short_resolved_by, 'short_note', l.short_note, 'adj_display', l.adj_display)
        order by l.line_no) from cl_internal_transfer_lines l where l.transfer_id = x.id), '[]'::jsonb))
  from cl_internal_transfers x join cl_terminals ft on ft.id = x.from_terminal_id join cl_terminals tt on tt.id = x.to_terminal_id
  where x.id = p_id
$$;

-- 5. Changed functions (each differs from its current body only by "-- office seats" lines) ----
${CHANGED.map((n) => NEW[n]).join('\n\n')}

-- 6. Invites ----------------------------------------------------------------------------
-- The Owner or an Admin, signed in on a main-branch device, invites one person:
-- p_staff_id (an existing person) or p_name + p_role_id (a new one). -> the code, once.
create function public.cl_device_seat_invite_create(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text,
                                                    p_staff_id uuid default null, p_name text default null, p_role_id uuid default null,
                                                    p_valid_hours integer default 24)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; br cl_branches%rowtype; s cl_shop_staff%rowtype; r cl_shop_roles%rowtype;
        v_name text; v_code text; v_exp timestamptz; v_id uuid; tries integer := 0;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into ses from cl_seat_admin(me, p_staff_token) limit 1;
  if ses.staff_id is null then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Sign in (online) as the Owner or an Admin on a main-branch device to invite an Office seat.');
  end if;
  select * into br from cl_branches where id = me.branch_id;
  if br.stock_mode = 'shared' then
    return json_build_object('error', 'SHARED_STOCK', 'message', 'The main branch uses shared stock, so it can''t have an Office seat.');
  end if;
  if (select count(*) from cl_branch_join_codes j join cl_branches b on b.id = j.branch_id
       where b.business_id = me.business_id and j.code_kind = 'seat' and j.used_by_terminal is null and j.revoked_ts is null and j.expires_ts > now()) >= 10 then
    return json_build_object('error', 'TOO_MANY_INVITES', 'message', 'There are already 10 open invites. Revoke one, or wait until they are used or expire.');
  end if;
  perform cl_shop_ensure_roles(me.business_id);
  if p_staff_id is not null then
    select * into s from cl_shop_staff where id = p_staff_id and business_id = me.business_id and active;
    if s.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That person isn''t active in this business.'); end if;
    select * into r from cl_shop_roles where id = s.role_id;
    v_name := s.name;
  else
    v_name := left(btrim(regexp_replace(coalesce(p_name, ''), '\\s+', ' ', 'g')), 60);
    if v_name = '' then return json_build_object('error', 'NO_NAME', 'message', 'Enter the person''s name.'); end if;
    select * into r from cl_shop_roles where id = p_role_id and business_id = me.business_id;
    if r.id is null then return json_build_object('error', 'NO_ROLE', 'message', 'Choose a role of this business.'); end if;
    if r.builtin = 'owner' and not cl_shop_owner_ok(me.business_id, ses.builtin) then
      return json_build_object('error', 'OWNER_ONLY', 'message', 'Only an Owner may give the Owner role.');
    end if;
  end if;
  if r.builtin = 'cashier' then
    return json_build_object('error', 'CASHIER_ROLE', 'message', 'A Cashier can''t use an Office seat (it can''t sell). Choose another role.');
  end if;
  v_exp := now() + make_interval(hours => greatest(1, least(coalesce(p_valid_hours, 24), 24)));
  loop
    tries := tries + 1;
    v_code := cl_new_join_code();
    begin
      insert into cl_branch_join_codes (branch_id, code_hash, issued_by_terminal, expires_ts, code_kind, staff_id, person_name, role_id, issued_by_staff)
      values (br.id, encode(extensions.digest(v_code, 'sha256'), 'hex'), me.id, v_exp, 'seat', s.id, case when s.id is null then v_name end,
              case when s.id is null then r.id end, ses.staff_id)
      returning id into v_id;
      exit;
    exception when unique_violation then
      if tries >= 5 then raise; end if;
    end;
  end loop;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'seat_invite_created', 'cl_branch_join_codes', v_id,
          jsonb_build_object('business_id', me.business_id, 'by_staff', ses.staff_id, 'by_till', me.till_code, 'person', v_name, 'role', r.name, 'expires_ts', v_exp));
  return json_build_object('ok', true, 'invite_id', v_id, 'code', v_code, 'expires_ts', v_exp, 'person_name', v_name, 'role_name', r.name,
                           'existing_person', s.id is not null, 'business_name', (select name from cl_businesses where id = me.business_id));
end $fn$;

-- The business's invites (30 days) and Office seats, for the Owner or an Admin.
create function public.cl_device_seat_invites(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into ses from cl_seat_admin(me, p_staff_token) limit 1;
  if ses.staff_id is null then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Sign in (online) as the Owner or an Admin on a main-branch device.');
  end if;
  return json_build_object(
    'invites', coalesce((select json_agg(json_build_object('id', j.id,
        'person', coalesce(ps.name, j.person_name), 'role', coalesce(pr.name, nr.name), 'issued_ts', j.issued_ts, 'expires_ts', j.expires_ts,
        'issued_by', ib.name, 'used_ts', j.used_ts, 'seat_code', ut.till_code, 'revoked_ts', j.revoked_ts,
        'status', case when j.revoked_ts is not null then 'revoked' when j.used_by_terminal is not null then 'used'
                       when j.expires_ts <= now() then 'expired' else 'open' end) order by j.issued_ts desc)
      from cl_branch_join_codes j join cl_branches b on b.id = j.branch_id
      left join cl_shop_staff ps on ps.id = j.staff_id left join cl_shop_roles pr on pr.id = ps.role_id
      left join cl_shop_roles nr on nr.id = j.role_id left join cl_shop_staff ib on ib.id = j.issued_by_staff
      left join cl_terminals ut on ut.id = j.used_by_terminal
      where b.business_id = me.business_id and j.code_kind = 'seat' and j.issued_ts > now() - interval '30 days'), '[]'::json),
    'seats', coalesce((select json_agg(json_build_object('id', t.id, 'till_code', t.till_code, 'label', t.label, 'active', t.active,
        'approval', t.approval_status, 'registered_ts', t.registered_ts, 'last_seen_ts', t.last_seen_ts, 'approved_ts', t.approved_ts,
        'approved_by', ab.name, 'refused_ts', t.refused_ts,
        'person', coalesce(ps.name, j.person_name), 'role', coalesce(pr.name, nr.name), 'join_hint', j.join_hint, 'pin_ok', coalesce(j.pin_ok, false),
        'check', case when t.approval_status = 'pending' then cl_seat_check(v.device_key) end) order by t.registered_ts desc)
      from cl_terminals t join cl_vendors v on v.id = t.vendor_id
      left join cl_branch_join_codes j on j.used_by_terminal = t.id and j.code_kind = 'seat'
      left join cl_shop_staff ps on ps.id = j.staff_id left join cl_shop_roles pr on pr.id = ps.role_id
      left join cl_shop_roles nr on nr.id = j.role_id left join cl_shop_staff ab on ab.id = t.approved_by_staff
      where t.business_id = me.business_id and t.device_kind = 'seat'), '[]'::json));
end $fn$;

create function public.cl_device_seat_invite_revoke(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text, p_invite_id uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; j cl_branch_join_codes%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into ses from cl_seat_admin(me, p_staff_token) limit 1;
  if ses.staff_id is null then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Sign in (online) as the Owner or an Admin on a main-branch device.');
  end if;
  select j2.* into j from cl_branch_join_codes j2 join cl_branches b on b.id = j2.branch_id
   where j2.id = p_invite_id and j2.code_kind = 'seat' and b.business_id = me.business_id for update of j2;
  if j.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That invite isn''t in this business.'); end if;
  if j.revoked_ts is not null then return json_build_object('ok', true, 'already', true); end if;
  if j.used_by_terminal is not null then
    return json_build_object('error', 'ALREADY_USED', 'message', 'That invite has been used. Refuse or deactivate the Office seat instead.');
  end if;
  update cl_branch_join_codes set revoked_ts = now(), revoked_by_staff = ses.staff_id where id = j.id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'seat_invite_revoked', 'cl_branch_join_codes', j.id, jsonb_build_object('business_id', me.business_id, 'by_staff', ses.staff_id, 'by_till', me.till_code));
  return json_build_object('ok', true);
end $fn$;

-- 7. Joining, the PIN, the wait -------------------------------------------------------------
-- No business phrase: the code, this install's ID and device key. Refusals come back as
-- { error } (a raise would roll back the failure row).
create function public.cl_seat_join(p_install_id text, p_device_key text, p_code text, p_app_build integer default null,
                                    p_join_hint text default null, p_device_code text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare jc cl_branch_join_codes%rowtype; br cl_branches%rowtype; biz cl_businesses%rowtype; v cl_vendors%rowtype; t cl_terminals%rowtype;
        v_ip text := cl_seat_ip_hash(); v_phrase text; v_code text; v_person text; v_role text; v_has_pin boolean;
begin
  if coalesce(btrim(p_install_id), '') = '' or coalesce(p_device_key, '') !~ '^[0-9a-f]{32}$' then
    return json_build_object('error', 'BAD_DEVICE', 'message', 'This device isn''t ready to join. Reopen the app and try again.');
  end if;
  delete from cl_join_failures where ts < now() - interval '1 day' and code_kind = 'seat';
  if (select count(*) from cl_join_failures where install_id = p_install_id and code_kind = 'seat' and ts > now() - interval '1 hour') >= 5
     or (v_ip is not null and (select count(*) from cl_join_failures where ip_hash = v_ip and code_kind = 'seat' and ts > now() - interval '1 hour') >= 20) then
    return json_build_object('error', 'SEAT_JOIN_LOCKED', 'message', 'Too many wrong codes. Wait an hour, then try again.');
  end if;
  select * into jc from cl_branch_join_codes where code_hash = encode(extensions.digest(cl_norm_join_code(p_code), 'sha256'), 'hex')
     and code_kind = 'seat' for update;
  if not found then
    insert into cl_join_failures (install_id, code_kind, ip_hash) values (p_install_id, 'seat', v_ip);
    return json_build_object('error', 'JOIN_CODE_INVALID', 'message', 'That code isn''t right. Check it in the invite message (it looks like K7Q4-M9TX).');
  end if;
  select * into br from cl_branches where id = jc.branch_id;
  select * into biz from cl_businesses where id = br.business_id;
  -- a retried join from the same device answers the same (with its phrase); anything else is refused
  select * into t from cl_terminals where install_id = p_install_id;
  if found then
    select * into v from cl_vendors where id = t.vendor_id;
    if jc.used_by_terminal = t.id and v.device_key = p_device_key then
      v_phrase := v.shop_secret_phrase;
    else
      return json_build_object('error', 'ALREADY_JOINED', 'message', 'This device already belongs to a business. Use a new install of the app for the Office seat.');
    end if;
  else
    if jc.revoked_ts is not null then return json_build_object('error', 'INVITE_REVOKED', 'message', 'This invite was revoked. Ask the Owner or an Admin for a new one.'); end if;
    if jc.used_by_terminal is not null then return json_build_object('error', 'JOIN_CODE_USED', 'message', 'This invite has already been used. Ask the Owner or an Admin for a new one.'); end if;
    if jc.expires_ts < now() then return json_build_object('error', 'JOIN_CODE_EXPIRED', 'message', 'This invite has expired. Ask the Owner or an Admin for a new one.'); end if;
    if coalesce(p_app_build, 0) < 32 then
      return json_build_object('error', 'APP_UPDATE_NEEDED', 'message', 'Update this app first, then join again. Your code is still valid.');
    end if;
    if exists (select 1 from cl_vendors where install_id = p_install_id) then
      return json_build_object('error', 'ALREADY_JOINED', 'message', 'This device already belongs to a business. Use a new install of the app for the Office seat.');
    end if;
    if br.stock_mode = 'shared' then
      return json_build_object('error', 'SHARED_STOCK', 'message', 'The main branch uses shared stock, so it can''t have an Office seat.');
    end if;
    v_phrase := encode(extensions.gen_random_bytes(24), 'hex');
    v := cl_install_vendor(p_install_id, v_phrase, p_device_key, true, biz.name, p_device_code);
    perform 1 from cl_branches where id = br.id for update;               -- serialise seat numbering
    insert into cl_terminals (business_id, branch_id, vendor_id, install_id, till_code, label, last_seen_ts, device_kind, approval_status)
    values (biz.id, br.id, v.id, v.install_id,
            'S' || (coalesce((select max(substr(till_code, 2)::int) from cl_terminals where branch_id = br.id and till_code like 'S%'), 0) + 1)::text,
            'Office seat', now(), 'seat', 'pending')
    returning * into t;
    update cl_branch_join_codes set used_by_terminal = t.id, used_ts = now(), join_hint = left(nullif(btrim(coalesce(p_join_hint, '')), ''), 60)
     where id = jc.id returning * into jc;
    update cl_vendors set business_id = biz.id where id = v.id;
    insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
    values (null, 'seat_joined', 'cl_terminals', t.id, jsonb_build_object('business_id', biz.id, 'invite_id', jc.id, 'seat', t.till_code, 'hint', jc.join_hint));
  end if;
  select coalesce(s.name, jc.person_name), coalesce(r1.name, r2.name), s.pin_bcrypt is not null
    into v_person, v_role, v_has_pin
    from (select 1) one left join cl_shop_staff s on s.id = jc.staff_id left join cl_shop_roles r1 on r1.id = s.role_id
    left join cl_shop_roles r2 on r2.id = jc.role_id;
  return json_build_object('ok', true, 'business_id', biz.id, 'business_name', biz.name, 'branch_id', br.id, 'branch_name', br.name, 'is_main', br.is_main,
    'terminal_id', t.id, 'till_code', t.till_code, 'label', t.label, 'device_phrase', v_phrase, 'approval', t.approval_status,
    'person_name', v_person, 'role_name', v_role, 'person_has_pin', coalesce(v_has_pin, false), 'pin_ok', jc.pin_ok, 'check', cl_seat_check(p_device_key));
end $fn$;

-- The seat (pending or not) asks where it stands.
create function public.cl_seat_status(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; t cl_terminals%rowtype; jc cl_branch_join_codes%rowtype;
begin
  perform set_config('cl.allow_pending_seat', '1', true);
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  perform set_config('cl.allow_pending_seat', '', true);
  select * into t from cl_terminals where vendor_id = v.id and device_kind = 'seat';
  if t.id is null then return json_build_object('error', 'NOT_A_SEAT', 'message', 'This device isn''t an Office seat.'); end if;
  select * into jc from cl_branch_join_codes where used_by_terminal = t.id and code_kind = 'seat';
  return json_build_object('ok', true, 'approval', t.approval_status, 'active', t.active, 'till_code', t.till_code, 'check', cl_seat_check(v.device_key),
    'pin_ok', coalesce(jc.pin_ok, false), 'refused_reason', t.refused_reason,
    'person_name', coalesce((select name from cl_shop_staff where id = jc.staff_id), jc.person_name));
end $fn$;

-- Before approval: the invited person enters their PIN (they have one: checked like a sign-in)
-- or sets one (it becomes theirs at approval). p_pin_*: the check values made on the seat.
create function public.cl_seat_set_pin(p_install_id text, p_secret_phrase text, p_device_key text, p_pin text,
                                       p_pin_salt text default null, p_pin_check text default null, p_pin_rounds integer default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; t cl_terminals%rowtype; jc cl_branch_join_codes%rowtype; s cl_shop_staff%rowtype; n_fail integer; v_problem text;
begin
  perform set_config('cl.allow_pending_seat', '1', true);
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  perform set_config('cl.allow_pending_seat', '', true);
  select * into t from cl_terminals where vendor_id = v.id and device_kind = 'seat';
  if t.id is null then return json_build_object('error', 'NOT_A_SEAT', 'message', 'This device isn''t an Office seat.'); end if;
  if t.approval_status <> 'pending' then return json_build_object('error', 'NOT_PENDING', 'message', 'This Office seat isn''t waiting for approval.'); end if;
  select * into jc from cl_branch_join_codes where used_by_terminal = t.id and code_kind = 'seat' for update;
  if jc.staff_id is not null then select * into s from cl_shop_staff where id = jc.staff_id; end if;
  if s.id is not null and s.pin_bcrypt is not null then
    select count(*) into n_fail from cl_shop_staff_signin_fails where staff_id = s.id and at > now() - interval '15 minutes';
    if n_fail >= 5 then return json_build_object('error', 'LOCKED', 'message', 'Too many incorrect PINs. Try again in 15 minutes.'); end if;
    if coalesce(p_pin, '') !~ '^\\d{4,6}$' or s.pin_bcrypt <> extensions.crypt(p_pin, s.pin_bcrypt) then
      insert into cl_shop_staff_signin_fails (staff_id, terminal_id) values (s.id, t.id);
      return json_build_object('error', 'BAD_PIN', 'message', 'Incorrect PIN.', 'left', greatest(0, 4 - n_fail));
    end if;
    delete from cl_shop_staff_signin_fails where staff_id = s.id;
    update cl_branch_join_codes set pin_ok = true where id = jc.id;
  else
    v_problem := cl_shop_pin_problem(p_pin, p_pin_salt, p_pin_check, p_pin_rounds);
    if v_problem is not null then return json_build_object('error', 'BAD_PIN_FORMAT', 'message', v_problem); end if;
    update cl_branch_join_codes set pin_bcrypt = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), pin_salt = p_pin_salt,
           pin_check = p_pin_check, pin_rounds = p_pin_rounds, pin_ok = true where id = jc.id;
  end if;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'seat_pin_set', 'cl_terminals', t.id, jsonb_build_object('business_id', t.business_id, 'seat', t.till_code, 'existing_pin', s.pin_bcrypt is not null));
  return json_build_object('ok', true, 'existing_pin', s.pin_bcrypt is not null);
end $fn$;

-- 8. Approval -------------------------------------------------------------------------------------
-- The Owner or an Admin approves a waiting seat after comparing the device check (p_check).
-- A new person is made now (home branch: main), or the person without a PIN gets the one they set.
create function public.cl_device_seat_approve(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text,
                                              p_terminal_id uuid, p_check text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; t cl_terminals%rowtype; v cl_vendors%rowtype; jc cl_branch_join_codes%rowtype; s cl_shop_staff%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into ses from cl_seat_admin(me, p_staff_token) limit 1;
  if ses.staff_id is null then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Sign in (online) as the Owner or an Admin on a main-branch device to approve an Office seat.');
  end if;
  select * into t from cl_terminals where id = p_terminal_id and business_id = me.business_id and device_kind = 'seat' for update;
  if t.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That Office seat isn''t in this business.'); end if;
  if t.approval_status = 'approved' then return json_build_object('ok', true, 'already', true); end if;
  if t.approval_status <> 'pending' then return json_build_object('error', 'NOT_PENDING', 'message', 'That Office seat was refused.'); end if;
  select * into v from cl_vendors where id = t.vendor_id;
  if upper(btrim(coalesce(p_check, ''))) <> cl_seat_check(v.device_key) then
    return json_build_object('error', 'CHECK_MISMATCH', 'message', 'The device check doesn''t match. Don''t approve: ask the person to read the check on their screen.');
  end if;
  select * into jc from cl_branch_join_codes where used_by_terminal = t.id and code_kind = 'seat' for update;
  if not coalesce(jc.pin_ok, false) then
    return json_build_object('error', 'PIN_NOT_SET', 'message', 'The person hasn''t set or entered their PIN on the Office seat yet.');
  end if;
  if jc.staff_id is not null then
    select * into s from cl_shop_staff where id = jc.staff_id for update;
    if s.id is null or not s.active then return json_build_object('error', 'PERSON_GONE', 'message', 'The invited person is no longer active. Refuse this seat.'); end if;
    if s.pin_bcrypt is null then
      update cl_shop_staff set pin_bcrypt = jc.pin_bcrypt, pin_salt = jc.pin_salt, pin_check = jc.pin_check, pin_rounds = jc.pin_rounds,
             pin_changed_at = now(), legacy_pins = '[]'::jsonb, change_seq = nextval('cl_shop_seq'), updated_at = now(), updated_by = ses.name
       where id = s.id returning * into s;
    end if;
  else
    if not exists (select 1 from cl_shop_roles where id = jc.role_id and business_id = me.business_id) then
      return json_build_object('error', 'NO_ROLE', 'message', 'The invite''s role no longer exists. Refuse this seat and invite again.');
    end if;
    insert into cl_shop_staff (business_id, name, role_id, home_branch_id, other_branches, active, pin_bcrypt, pin_salt, pin_check, pin_rounds,
                               pin_changed_at, created_terminal, updated_by)
    values (me.business_id, jc.person_name, jc.role_id, t.branch_id, '{}', true, jc.pin_bcrypt, jc.pin_salt, jc.pin_check, jc.pin_rounds, now(), t.id, ses.name)
    returning * into s;
    update cl_branch_join_codes set staff_id = s.id where id = jc.id;
  end if;
  update cl_branch_join_codes set pin_bcrypt = null, pin_salt = null, pin_check = null where id = jc.id;   -- the PIN lives on the person now
  update cl_terminals set approval_status = 'approved', approved_ts = now(), approved_by_staff = ses.staff_id where id = t.id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'seat_approved', 'cl_terminals', t.id, jsonb_build_object('business_id', me.business_id, 'seat', t.till_code, 'by_staff', ses.staff_id,
          'by_till', me.till_code, 'person', s.name));
  return json_build_object('ok', true, 'till_code', t.till_code, 'person', s.name);
end $fn$;

create function public.cl_device_seat_refuse(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text,
                                             p_terminal_id uuid, p_reason text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; t cl_terminals%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into ses from cl_seat_admin(me, p_staff_token) limit 1;
  if ses.staff_id is null then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Sign in (online) as the Owner or an Admin on a main-branch device.');
  end if;
  select * into t from cl_terminals where id = p_terminal_id and business_id = me.business_id and device_kind = 'seat' for update;
  if t.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That Office seat isn''t in this business.'); end if;
  if t.approval_status <> 'pending' then return json_build_object('error', 'NOT_PENDING', 'message', 'Only a waiting Office seat can be refused. Deactivate it instead.'); end if;
  update cl_terminals set approval_status = 'refused', active = false, refused_ts = now(), refused_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 200)
   where id = t.id;
  update cl_branch_join_codes set pin_bcrypt = null, pin_salt = null, pin_check = null where used_by_terminal = t.id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, 'seat_refused', 'cl_terminals', t.id, jsonb_build_object('business_id', me.business_id, 'seat', t.till_code, 'by_staff', ses.staff_id, 'by_till', me.till_code));
  return json_build_object('ok', true);
end $fn$;

-- 9. The business's bill (any device of it) ----------------------------------------------------------
create function public.cl_business_bill(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; t record; v jsonb; rows jsonb := '[]'; v_total numeric := 0; v_cur text; v_plan text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  for t in select te.vendor_id, te.install_id, te.till_code, te.device_kind, te.approval_status, b.name branch, b.is_main
             from cl_terminals te join cl_branches b on b.id = te.branch_id
            where te.business_id = me.business_id and te.active
            order by b.is_main desc, b.name, te.device_kind desc, substr(te.till_code, 2)::int
  loop
    begin
      v := cl_plan_price(t.vendor_id, t.install_id, 30);
      rows := rows || jsonb_build_array(jsonb_build_object('branch', t.branch, 'is_main', t.is_main, 'till_code', t.till_code, 'kind', t.device_kind,
                'role', v->>'till_role', 'unit_fee', v->'unit_fee'));
      v_total := v_total + (v->>'unit_fee')::numeric; v_cur := v->>'currency'; v_plan := v->>'plan_name';
    exception when others then
      rows := rows || jsonb_build_array(jsonb_build_object('branch', t.branch, 'is_main', t.is_main, 'till_code', t.till_code, 'kind', t.device_kind,
                'role', null, 'unit_fee', null, 'problem', case when t.approval_status <> 'approved' then 'Waiting for approval' else left(sqlerrm, 120) end));
    end;
  end loop;
  return json_build_object('plan_name', v_plan, 'currency', v_cur, 'days', 30, 'devices', rows, 'total', v_total);
end $fn$;

-- 10. Internal transfers ---------------------------------------------------------------------------
-- p_transfer: { id, it_no, it_display, to_terminal_id, created_iso, sent_by, note, lines: [{ line_no, cat_uid, code, name, qty }] }
create function public.cl_device_transfer_send(p_install_id text, p_secret_phrase text, p_device_key text, p_transfer jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; dest cl_terminals%rowtype; x cl_internal_transfers%rowtype; v_id uuid; l jsonb; n integer := 0;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  perform cl_seat_need('m.dispatch');
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This device is switched off for the business.'); end if;
  begin v_id := (p_transfer->>'id')::uuid; exception when others then v_id := null; end;
  if v_id is null then raise exception 'A transfer needs its id' using errcode = 'P0001'; end if;
  select * into x from cl_internal_transfers where id = v_id;
  if found then
    if x.from_terminal_id <> me.id then return json_build_object('error', 'NOT_YOURS', 'message', 'That transfer belongs to another device.'); end if;
    return json_build_object('ok', true, 'already', true, 'transfer', cl_transfer_json(x.id));
  end if;
  select * into dest from cl_terminals where id = nullif(p_transfer->>'to_terminal_id', '')::uuid;
  if dest.id is null or dest.branch_id <> me.branch_id or dest.business_id <> me.business_id or dest.id = me.id then
    return json_build_object('error', 'BAD_DESTINATION', 'message', 'Send it to another device of this branch.');
  end if;
  if not dest.active or dest.approval_status <> 'approved' then
    return json_build_object('error', 'DESTINATION_OFF', 'message', dest.till_code || ' is switched off or waiting for approval.');
  end if;
  if (me.device_kind = 'seat') = (dest.device_kind = 'seat') then
    return json_build_object('error', 'SEAT_AND_TILL', 'message', 'An internal transfer goes between an Office seat and a till of the same branch.');
  end if;
  if jsonb_typeof(p_transfer->'lines') <> 'array' or jsonb_array_length(p_transfer->'lines') not between 1 and 500 then
    raise exception 'A transfer has 1 to 500 lines' using errcode = 'P0001';
  end if;
  insert into cl_internal_transfers (id, business_id, branch_id, from_terminal_id, to_terminal_id, it_no, it_display, created_iso, note, sent_by)
  values (v_id, me.business_id, me.branch_id, me.id, dest.id, (p_transfer->>'it_no')::integer, cl_dispatch_name(p_transfer->>'it_display', 40),
          cl_dispatch_name(p_transfer->>'created_iso', 40), cl_dispatch_name(p_transfer->>'note', 200), cl_dispatch_name(p_transfer->>'sent_by', 80));
  for l in select value from jsonb_array_elements(p_transfer->'lines') loop
    n := n + 1;
    insert into cl_internal_transfer_lines (transfer_id, line_no, cat_uid, code, name, qty)
    values (v_id, coalesce((l->>'line_no')::integer, n), cl_dispatch_name(l->>'cat_uid', 64), cl_dispatch_name(l->>'code', 64),
            cl_dispatch_name(l->>'name', 120), (l->>'qty')::integer);
  end loop;
  update cl_terminals set last_seen_ts = now() where id = me.id;
  return json_build_object('ok', true, 'transfer', cl_transfer_json(v_id));
end $fn$;

-- What reaches this device and what it sent (60 days, and anything still open).
create function public.cl_device_transfers_pull(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  return json_build_object(
    'incoming', coalesce((select json_agg(cl_transfer_json(x.id) order by x.sent_at) from cl_internal_transfers x
       where x.to_terminal_id = me.id and (x.status = 'sent' or x.sent_at > now() - interval '60 days')), '[]'::json),
    'outgoing', coalesce((select json_agg(cl_transfer_json(x.id) order by x.sent_at) from cl_internal_transfers x
       where x.from_terminal_id = me.id and (x.status = 'sent' or x.sent_at > now() - interval '60 days'
          or exists (select 1 from cl_internal_transfer_lines l where l.transfer_id = x.id and l.short_status = 'open'))), '[]'::json),
    'max_it_no', (select max(it_no) from cl_internal_transfers where from_terminal_id = me.id));
end $fn$;

-- The receiving device confirms each line's quantity (0..sent). The first answer counts.
create function public.cl_device_transfer_receive(p_install_id text, p_secret_phrase text, p_device_key text, p_transfer_id uuid,
                                                  p_by text, p_lines jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; x cl_internal_transfers%rowtype; l record; v_got integer; v_short boolean := false;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  perform cl_seat_need('m.receive');
  select * into x from cl_internal_transfers where id = p_transfer_id for update;
  if x.id is null or x.business_id <> me.business_id then return json_build_object('error', 'NOT_FOUND', 'message', 'That transfer isn''t on seiGEN.'); end if;
  if x.to_terminal_id <> me.id then return json_build_object('error', 'NOT_YOURS', 'message', 'That transfer is for ' || (select till_code from cl_terminals where id = x.to_terminal_id) || '.'); end if;
  if x.status in ('received', 'received_short') then return json_build_object('ok', true, 'already', true, 'transfer', cl_transfer_json(x.id)); end if;
  if x.status = 'cancelled' then return json_build_object('error', 'CANCELLED', 'message', 'The sender cancelled this transfer.'); end if;
  for l in select * from cl_internal_transfer_lines where transfer_id = x.id order by line_no loop
    v_got := null;
    select (e->>'received')::integer into v_got from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e where (e->>'line_no')::integer = l.line_no limit 1;
    if v_got is null or v_got < 0 or v_got > l.qty then
      raise exception 'Line %: received must be 0 to %', l.line_no, l.qty using errcode = 'P0001';
    end if;
    update cl_internal_transfer_lines set received = v_got, short_status = case when v_got < l.qty then 'open' end
     where transfer_id = x.id and line_no = l.line_no;
    if v_got < l.qty then v_short := true; end if;
  end loop;
  update cl_internal_transfers set status = case when v_short then 'received_short' else 'received' end, received_at = now(),
         received_by = cl_dispatch_name(p_by, 80) where id = x.id;
  update cl_terminals set last_seen_ts = now() where id = me.id;
  return json_build_object('ok', true, 'transfer', cl_transfer_json(x.id));
end $fn$;

create function public.cl_device_transfer_cancel(p_install_id text, p_secret_phrase text, p_device_key text, p_transfer_id uuid,
                                                 p_by text, p_reason text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; x cl_internal_transfers%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  perform cl_seat_need('m.dispatch');
  select * into x from cl_internal_transfers where id = p_transfer_id for update;
  if x.id is null or x.business_id <> me.business_id then return json_build_object('error', 'NOT_FOUND', 'message', 'That transfer isn''t on seiGEN.'); end if;
  if x.from_terminal_id <> me.id then return json_build_object('error', 'NOT_SENDER', 'message', 'Only the device that sent it can cancel it.'); end if;
  if x.status = 'cancelled' then return json_build_object('ok', true, 'already', true, 'transfer', cl_transfer_json(x.id)); end if;
  if x.status <> 'sent' then return json_build_object('error', 'ALREADY_RECEIVED', 'message', 'It has been received, so it can''t be cancelled.'); end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason (at least 3 characters)' using errcode = 'P0001'; end if;
  update cl_internal_transfers set status = 'cancelled', cancelled_at = now(), cancelled_by = cl_dispatch_name(p_by, 80),
         cancel_reason = cl_dispatch_name(p_reason, 200) where id = x.id;
  return json_build_object('ok', true, 'transfer', cl_transfer_json(x.id));
end $fn$;

-- A shortage (back in the sender's stock): written off with its ADJ number, or kept.
create function public.cl_device_transfer_resolve(p_install_id text, p_secret_phrase text, p_device_key text, p_transfer_id uuid,
                                                  p_line_no integer, p_action text, p_by text, p_note text, p_adj_display text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; x cl_internal_transfers%rowtype; l cl_internal_transfer_lines%rowtype; v_to text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  perform cl_seat_need(case when p_action = 'write_off' then 'approve_writeoffs' else 'm.dispatch' end);
  select * into x from cl_internal_transfers where id = p_transfer_id;
  if x.id is null or x.business_id <> me.business_id then return json_build_object('error', 'NOT_FOUND', 'message', 'That transfer isn''t on seiGEN.'); end if;
  if x.from_terminal_id <> me.id then return json_build_object('error', 'NOT_SENDER', 'message', 'Only the device that sent it can settle its shortage.'); end if;
  select * into l from cl_internal_transfer_lines where transfer_id = x.id and line_no = p_line_no for update;
  if l.transfer_id is null or l.short_status is null then return json_build_object('error', 'NO_SHORTAGE', 'message', 'That line has no shortage.'); end if;
  v_to := case p_action when 'write_off' then 'written_off' when 'keep' then 'kept' end;
  if v_to is null then raise exception 'Write off or keep' using errcode = 'P0001'; end if;
  if l.short_status = v_to then return json_build_object('ok', true, 'already', true, 'transfer', cl_transfer_json(x.id)); end if;
  if l.short_status <> 'open' then return json_build_object('error', 'ALREADY_RESOLVED', 'message', 'That shortage is already ' || replace(l.short_status, '_', ' ') || '.'); end if;
  if p_action = 'write_off' and cl_dispatch_name(p_adj_display, 40) is null then raise exception 'A write-off needs its ADJ number' using errcode = 'P0001'; end if;
  if p_action = 'write_off' and length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Give a reason (at least 3 characters)' using errcode = 'P0001'; end if;
  update cl_internal_transfer_lines set short_status = v_to, short_resolved_at = now(), short_resolved_by = cl_dispatch_name(p_by, 80),
         short_note = cl_dispatch_name(p_note, 200), adj_display = case when p_action = 'write_off' then cl_dispatch_name(p_adj_display, 40) end
   where transfer_id = x.id and line_no = l.line_no;
  return json_build_object('ok', true, 'transfer', cl_transfer_json(x.id));
end $fn$;

-- 11. Who may call what ----------------------------------------------------------------------------
revoke all on function public.cl_seat_need(text), public.cl_seat_features(uuid), public.cl_seat_check(text), public.cl_seat_ip_hash(),
  public.cl_seat_admin(public.cl_terminals, text), public.cl_transfer_json(uuid) from public, anon, authenticated;
revoke all on function public.cl_device_seat_invite_create(text, text, text, text, uuid, text, uuid, integer),
  public.cl_device_seat_invites(text, text, text, text), public.cl_device_seat_invite_revoke(text, text, text, text, uuid),
  public.cl_seat_join(text, text, text, integer, text, text), public.cl_seat_status(text, text, text),
  public.cl_seat_set_pin(text, text, text, text, text, text, integer),
  public.cl_device_seat_approve(text, text, text, text, uuid, text), public.cl_device_seat_refuse(text, text, text, text, uuid, text),
  public.cl_business_bill(text, text, text), public.cl_device_transfer_send(text, text, text, jsonb),
  public.cl_device_transfers_pull(text, text, text), public.cl_device_transfer_receive(text, text, text, uuid, text, jsonb),
  public.cl_device_transfer_cancel(text, text, text, uuid, text, text),
  public.cl_device_transfer_resolve(text, text, text, uuid, integer, text, text, text, text) from public;
grant execute on function public.cl_device_seat_invite_create(text, text, text, text, uuid, text, uuid, integer),
  public.cl_device_seat_invites(text, text, text, text), public.cl_device_seat_invite_revoke(text, text, text, text, uuid),
  public.cl_seat_join(text, text, text, integer, text, text), public.cl_seat_status(text, text, text),
  public.cl_seat_set_pin(text, text, text, text, text, text, integer),
  public.cl_device_seat_approve(text, text, text, text, uuid, text), public.cl_device_seat_refuse(text, text, text, text, uuid, text),
  public.cl_business_bill(text, text, text), public.cl_device_transfer_send(text, text, text, jsonb),
  public.cl_device_transfers_pull(text, text, text), public.cl_device_transfer_receive(text, text, text, uuid, text, jsonb),
  public.cl_device_transfer_cancel(text, text, text, uuid, text, text),
  public.cl_device_transfer_resolve(text, text, text, uuid, integer, text, text, text, text) to anon, authenticated;

commit;
`;

const RB = `-- Rollback of 20261109120000_office_seats.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- Generated by tools/db/gen-20261109-migration.js: the changed functions go
-- back to their bodies before the migration, byte for byte; the new functions,
-- tables and columns are dropped. Refused if any Office seat or internal
-- transfer exists (they would be lost): deactivate and remove them first.

begin;

do $$
begin
  if exists (select 1 from public.cl_terminals where device_kind = 'seat') or exists (select 1 from public.cl_internal_transfers) then
    raise exception 'office_seats rollback refused: Office seats or internal transfers exist. Nothing was changed.';
  end if;
end $$;

drop function public.cl_device_transfer_resolve(text, text, text, uuid, integer, text, text, text, text);
drop function public.cl_device_transfer_cancel(text, text, text, uuid, text, text);
drop function public.cl_device_transfer_receive(text, text, text, uuid, text, jsonb);
drop function public.cl_device_transfers_pull(text, text, text);
drop function public.cl_device_transfer_send(text, text, text, jsonb);
drop function public.cl_business_bill(text, text, text);
drop function public.cl_device_seat_refuse(text, text, text, text, uuid, text);
drop function public.cl_device_seat_approve(text, text, text, text, uuid, text);
drop function public.cl_seat_set_pin(text, text, text, text, text, text, integer);
drop function public.cl_seat_status(text, text, text);
drop function public.cl_seat_join(text, text, text, integer, text, text);
drop function public.cl_device_seat_invite_revoke(text, text, text, text, uuid);
drop function public.cl_device_seat_invites(text, text, text, text);
drop function public.cl_device_seat_invite_create(text, text, text, text, uuid, text, uuid, integer);

${CHANGED.map((n) => ORIG[n]).join('\n\n')}

drop function public.cl_transfer_json(uuid);
drop function public.cl_seat_admin(public.cl_terminals, text);
drop function public.cl_seat_ip_hash();
drop function public.cl_seat_check(text);
drop function public.cl_seat_features(uuid);
drop function public.cl_seat_need(text);

drop table public.cl_internal_transfer_lines;
drop table public.cl_internal_transfers;
drop index public.cl_join_failures_ip_idx;
drop index public.cl_join_failures_seat_idx;
alter table public.cl_join_failures drop column ip_hash, drop column code_kind;
alter table public.cl_branch_join_codes drop column pin_ok, drop column pin_rounds, drop column pin_check, drop column pin_salt, drop column pin_bcrypt,
  drop column join_hint, drop column revoked_by_staff, drop column revoked_ts, drop column issued_by_staff, drop column role_id,
  drop column person_name, drop column staff_id, drop column code_kind;
alter table public.cl_terminals drop constraint cl_terminals_till_code_check;
alter table public.cl_terminals drop column refused_reason, drop column refused_ts, drop column approved_by_staff, drop column approved_ts,
  drop column approval_status, drop column device_kind;
alter table public.cl_terminals add constraint cl_terminals_till_code_check check (till_code ~ '^T[0-9]{1,3}$');
alter table public.cl_licences drop constraint cl_licences_till_role_check;
alter table public.cl_licences add constraint cl_licences_till_role_check check (till_role in ('main', 'branch', 'till'));

commit;
`;

fs.writeFileSync(path.join(MIG, OUT), HEAD + SQL_MAIN);
fs.writeFileSync(path.join(ROOT, 'supabase', 'rollbacks', '20261109120000_office_seats.rollback.sql'), RB);
console.log('Wrote ' + OUT + ' (' + CHANGED.length + ' changed functions: ' + CHANGED.join(', ') + ') and its rollback.');
