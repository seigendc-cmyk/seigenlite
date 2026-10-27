// node tools/db/gen-20261114120000-migration.js
//
// Writes supabase/migrations/20261114120000_roles_everywhere.sql and its
// rollback (v36 Fix-A: A11, decision 48; A12, decision 49; A13, decision 50).
// Every changed function is taken from its current body, so the new version
// differs only by the lines marked "-- v36", and the rollback puts back the
// exact current bodies. Needs 20261113180000_removed_devices (A1) first.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const READ = (f) => fs.readFileSync(path.join(MIG, f), 'utf8').replace(/\r\n/g, '\n');
const MARK = '   -- v36';

// The latest definition of a function in the migrations (by file order), from "create ... function public.<name>(" to its end.
function latest(name) {
  const files = fs.readdirSync(MIG).filter((f) => /^\d{14}_\w+\.sql$/.test(f) && f < '20261114120000').sort();
  let found = null;
  for (const f of files) {
    const src = READ(f);
    const re = new RegExp('create (or replace )?function public\\.' + name + '\\(', 'g');
    let m, last = null;
    while ((m = re.exec(src))) last = m.index;
    if (last == null) continue;
    const tail = src.slice(last);
    const ends = ['\nend $fn$;', '\n$$;', '\n$function$;'].map((e) => { const i = tail.indexOf(e); return i < 0 ? Infinity : i + e.length; });
    const end = Math.min(...ends);
    if (end === Infinity) throw new Error('no end for ' + name + ' in ' + f);
    found = { file: f, text: tail.slice(0, end) };
  }
  if (!found) throw new Error(name + ' not found');
  return found;
}
function swap(text, from, to, what) {
  if (text.split(from).length !== 2) throw new Error('expected exactly one in ' + (what || '?') + ': ' + from.slice(0, 90));
  return text.replace(from, () => to);
}
const asReplace = (t) => t.replace(/^create function public\./, 'create or replace function public.');

const changed = [];   // [name, file, oldText, newText]
function change(name, fn) {
  const cur = latest(name);
  const next = asReplace(fn(cur.text));
  if (next === asReplace(cur.text)) throw new Error(name + ': nothing changed');
  changed.push([name, cur.file, cur.text, next]);
}

// ---- A11: the caller (cl_install_vendor, from 20261113180000) ----
change('cl_install_vendor', (t) => {
  t = swap(t, '        st cl_terminals%rowtype; v_tok text; v_staff uuid;                -- office seats\n',
    '        st cl_terminals%rowtype; v_tok text; v_staff uuid;                -- office seats\n' +
    '        tt cl_terminals%rowtype;' + MARK + ': a till\'s own row\n', 'iv declare');
  t = swap(t, "  perform set_config('cl.seat_staff', '', true);                        -- office seats\n",
    "  perform set_config('cl.seat_staff', '', true);                        -- office seats\n" +
    "  perform set_config('cl.seat_guest', '', true);" + MARK + ' (decision 49): a Guest\'s Office seat\n' +
    "  perform set_config('cl.till_terminal', '', true);" + MARK + ' (decision 48): a till, for cl_seat_need\n' +
    "  perform set_config('cl.till_staff', '', true);" + MARK + '\n' +
    "  perform set_config('cl.till_token', '', true);" + MARK + '\n', 'iv resets');
  t = swap(t, "    p_phrase := split_part(coalesce(p_phrase, ''), '|', 1);\n  end if;\n",
    "    p_phrase := split_part(coalesce(p_phrase, ''), '|', 1);\n  end if;\n" +
    '  -- v36 (decision 48): a till in staff sign-in mode sends "<phrase>|<token>" too (only read when the phrase alone doesn\'t match)\n' +
    "  if st.id is null and v.shop_secret_phrase is not null and coalesce(p_phrase, '') ~ '\\|[0-9a-f]{64}$'" + MARK + '\n' +
    '     and cl_norm_phrase(v.shop_secret_phrase) <> cl_norm_phrase(p_phrase) then' + MARK + '\n' +
    '    v_tok := right(p_phrase, 64);' + MARK + '\n' +
    '    p_phrase := left(p_phrase, length(p_phrase) - 65);' + MARK + '\n' +
    '  end if;' + MARK + '\n', 'iv till token');
  t = swap(t, '  return v;\nend $fn$;',
    '  -- v36: a Guest\'s seat (its invite\'s person is a Guest) gets the stock and prices only; a till: who is signed in\n' +
    "  if st.id is not null and cl_seat_is_guest(st.id) then perform set_config('cl.seat_guest', '1', true); end if;" + MARK + '\n' +
    '  if st.id is null then' + MARK + '\n' +
    "    select * into tt from cl_terminals where vendor_id = v.id and device_kind = 'till' order by registered_ts desc limit 1;" + MARK + '\n' +
    '    if tt.id is not null then' + MARK + '\n' +
    "      perform set_config('cl.till_terminal', tt.id::text, true);" + MARK + '\n' +
    '      if v_tok is not null then' + MARK + '\n' +
    "        perform set_config('cl.till_token', '1', true);" + MARK + '\n' +
    '        select x.staff_id into v_staff from cl_shop_session(v_tok, tt.id) x limit 1;' + MARK + '\n' +
    "        if v_staff is not null then perform set_config('cl.till_staff', v_staff::text, true); end if;" + MARK + '\n' +
    '      end if;' + MARK + '\n' +
    '    end if;' + MARK + '\n' +
    '  end if;' + MARK + '\n' +
    '  return v;\nend $fn$;', 'iv end');
  return t;
});

// ---- A11: the check (cl_seat_need, from 20261109120000) ----
change('cl_seat_need', (t) => {
  t = swap(t, 'language plpgsql stable security definer set search_path = public as $fn$\n',
    'language plpgsql volatile security definer set search_path = public as $fn$' + MARK + ': volatile, it logs a till\'s checks\n', 'need volatility');
  t = swap(t, "        v_staff text := coalesce(current_setting('cl.seat_staff', true), ''); v_rights text[]; v_name text;\n",
    "        v_staff text := coalesce(current_setting('cl.seat_staff', true), ''); v_rights text[]; v_name text;\n" +
    "        v_till text := coalesce(current_setting('cl.till_terminal', true), ''); t cl_terminals%rowtype;" + MARK + '\n', 'need declare');
  t = swap(t, "begin\n  if v_seat = '' then return; end if;\n",
    'begin\n' +
    '  -- v36 (decision 48): a till checks the signed-in person\'s right too. Selling, payments and EOD stay as before on a till\n' +
    '  -- (offline, never held up). Single operator mode (no token, the till not in sign-in mode on seiGEN): as before, logged.\n' +
    "  if v_seat = '' and v_till <> '' and not (p_right = any(array['m.sell', 'm.credit', 'm.eod', 'void_return', 'credit_over_limit'])) then" + MARK + '\n' +
    '    select * into t from cl_terminals where id = v_till::uuid;' + MARK + '\n' +
    "    v_staff := coalesce(current_setting('cl.till_staff', true), '');" + MARK + '\n' +
    "    if v_staff <> '' then" + MARK + '\n' +
    '      select cl_shop_effective_rights(r), s.name into v_rights, v_name' + MARK + '\n' +
    '        from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id where s.id = v_staff::uuid and s.active;' + MARK + '\n' +
    '      if v_rights is null or not (p_right = any(v_rights)) then' + MARK + '\n' +
    "        raise exception 'STAFF_NO_RIGHT: % doesn''t have the right for this (%).', coalesce(v_name, 'This person'), p_right using errcode = 'P0001';" + MARK + '\n' +
    '      end if;' + MARK + '\n' +
    "      perform cl_till_rights_note(t, v_staff::uuid, p_right, 'signed in');" + MARK + '\n' +
    '      return;' + MARK + '\n' +
    '    end if;' + MARK + '\n' +
    "    if coalesce(current_setting('cl.till_token', true), '') = '1' then" + MARK + '\n' +
    "      raise exception 'STAFF_SIGN_IN: Your seiGEN sign-in on this till has ended. Sign in again (online).' using errcode = 'P0001';" + MARK + '\n' +
    '    end if;' + MARK + '\n' +
    "    if t.staff_mode = 'roles' then" + MARK + '\n' +
    "      raise exception 'STAFF_SIGN_IN: This till uses staff sign-in. Sign in (online) as someone with the right.' using errcode = 'P0001';" + MARK + '\n' +
    '    end if;' + MARK + '\n' +
    "    perform cl_till_rights_note(t, null, p_right, 'single operator');" + MARK + '\n' +
    '    return;' + MARK + '\n' +
    '  end if;' + MARK + '\n' +
    "  if v_seat = '' then return; end if;\n", 'need till');
  return t;
});

// ---- A12 (decision 49): Guest only on an Office seat, until the end date ----
change('cl_shop_session', (t) => swap(t, '     and cl_shop_staff_at(s, t.branch_id)\n$$;',
  '     and cl_shop_staff_at(s, t.branch_id)\n     and cl_shop_guest_ok(s, t.id)' + MARK + ' (decision 49): a Guest only on an Office seat, until the end date\n$$;', 'session'));
change('cl_shop_staff_json', (t) => {
  t = swap(t, "           'everywhere', cl_shop_staff_everywhere(s.role_id))\n",
    "           'everywhere', cl_shop_staff_everywhere(s.role_id), 'guest_until', s.guest_until)" + MARK + '\n', 'json until');
  t = swap(t, "           'here', s.active and cl_shop_staff_at(s, p_branch),\n",
    "           'here', s.active and cl_shop_staff_at(s, p_branch) and cl_shop_guest_ok(s, p_terminal)," + MARK + ': a Guest never on a till\n', 'json here');
  t = swap(t, '      || case when s.active and cl_shop_staff_at(s, p_branch) then\n',
    '      || case when s.active and cl_shop_staff_at(s, p_branch) and cl_shop_guest_ok(s, p_terminal) then' + MARK + ': a till never gets a Guest\'s PIN check\n', 'json pins');
  return t;
});
change('cl_device_staff_signin', (t) => swap(t,
  "    return json_build_object('error', 'NOT_HERE', 'message', 'That person doesn''t work at this branch.');\n  end if;\n",
  "    return json_build_object('error', 'NOT_HERE', 'message', 'That person doesn''t work at this branch.');\n  end if;\n" +
  '  if not cl_shop_guest_ok(s, me.id) then' + MARK + ' (decision 49)\n' +
  "    if me.device_kind <> 'seat' then return json_build_object('error', 'GUEST_SEAT_ONLY', 'message', 'A Guest signs in only on an Office seat.'); end if;" + MARK + '\n' +
  "    return json_build_object('error', 'GUEST_ENDED', 'message', 'This Guest''s access has ended. Ask the Owner or an Admin.');" + MARK + '\n' +
  '  end if;' + MARK + '\n', 'signin'));
change('cl_device_staff_pull', (t) => {
  t = swap(t, "  return json_build_object('server_time', now(), 'branch_id', me.branch_id,",
    "  return json_build_object('server_time', now(), 'staff_mode', me.staff_mode, 'guest_seat', cl_guest_seat()," + MARK + '\n' +
    "    'branch_id', me.branch_id,", 'pull head');
  t = swap(t, "                       from cl_shop_staff s where s.business_id = me.business_id), '[]'::json),\n",
    "                       from cl_shop_staff s where s.business_id = me.business_id\n" +
    '                        and (not cl_guest_seat() or s.id = cl_seat_person(me.id))), \'[]\'::json),' + MARK + ': a Guest\'s seat gets only its Guest\n', 'pull staff');
  return t;
});
change('cl_device_staff_save', (t) => {
  t = swap(t, '        v_had_owner boolean;   -- v33\n', '        v_had_owner boolean;   -- v33\n        v_until timestamptz;' + MARK + '\n', 'save declare');
  t = swap(t, "  v_active := coalesce((p_staff->>'active')::boolean, cur.active, true);\n",
    "  v_active := coalesce((p_staff->>'active')::boolean, cur.active, true);\n" +
    '  -- v36 (decision 49): the Guest role is given or changed by the Owner or an Admin only; at the main branch (an Office seat);\n' +
    '  -- an optional end date, after which seiGEN refuses the sign-in and ends the session\n' +
    "  if (v_role.builtin = 'guest' or v_cur_tb = 'guest') and coalesce(ses.builtin, '') not in ('owner', 'admin') then" + MARK + '\n' +
    "    return json_build_object('error', 'GUEST_OWNER_ADMIN', 'message', 'Only the Owner or an Admin may add or change a Guest.');" + MARK + '\n' +
    '  end if;' + MARK + '\n' +
    "  if v_role.builtin = 'guest' then" + MARK + '\n' +
    '    if not exists (select 1 from cl_branches where id = v_home and is_main) then' + MARK + '\n' +
    "      return json_build_object('error', 'GUEST_MAIN', 'message', 'A Guest uses an Office seat, so their home branch is the main branch.');" + MARK + '\n' +
    '    end if;' + MARK + '\n' +
    "    v_others := '{}';" + MARK + '\n' +
    "    if p_staff ? 'guest_until' then" + MARK + '\n' +
    "      begin v_until := nullif(p_staff->>'guest_until', '')::timestamptz; exception when others then" + MARK + '\n' +
    "        raise exception 'Give the end date as a date.' using errcode = 'P0001'; end;" + MARK + '\n' +
    '    else v_until := cur.guest_until; end if;' + MARK + '\n' +
    '  end if;' + MARK + '\n', 'save guest');
  t = swap(t, "                               created_terminal, updated_by)\n",
    "                               created_terminal, updated_by, guest_until)" + MARK + '\n', 'save insert cols');
  t = swap(t, "            p_staff->>'pin_salt', p_staff->>'pin_check', (p_staff->>'pin_rounds')::integer, now(), me.id, v_by)\n",
    "            p_staff->>'pin_salt', p_staff->>'pin_check', (p_staff->>'pin_rounds')::integer, now(), me.id, v_by, v_until)" + MARK + '\n', 'save insert vals');
  t = swap(t, "           change_seq = nextval('cl_shop_seq'), updated_at = now(), updated_by = v_by\n",
    "           guest_until = v_until," + MARK + '\n' +
    "           change_seq = nextval('cl_shop_seq'), updated_at = now(), updated_by = v_by\n", 'save update');
  return t;
});
change('cl_device_role_save', (t) => swap(t,
  "    if cur.builtin = 'owner' then return json_build_object('error', 'OWNER_FIXED', 'message', 'The Owner role always has every right.'); end if;\n",
  "    if cur.builtin = 'owner' then return json_build_object('error', 'OWNER_FIXED', 'message', 'The Owner role always has every right.'); end if;\n" +
  "    if cur.builtin = 'guest' then return json_build_object('error', 'GUEST_FIXED', 'message', 'The Guest role sees stock and selling prices only. It can''t be changed or deleted.'); end if;" + MARK + '\n', 'role save'));
change('cl_device_seat_invite_create', (t) => swap(t,
  "    return json_build_object('error', 'CASHIER_ROLE', 'message', 'A Cashier can''t use an Office seat (it can''t sell). Choose another role.');\n  end if;\n",
  "    return json_build_object('error', 'CASHIER_ROLE', 'message', 'A Cashier can''t use an Office seat (it can''t sell). Choose another role.');\n  end if;\n" +
  "  if r.builtin = 'guest' and p_staff_id is null then" + MARK + ' (decision 49): the Guest (and their end date) is added in Staff first\n' +
  "    return json_build_object('error', 'GUEST_ADD_FIRST', 'message', 'Add the Guest in Staff first (with an end date if you want one), then invite them.');" + MARK + '\n' +
  '  end if;' + MARK + '\n', 'invite'));
change('cl_device_branch_stock', (t) => {
  t = swap(t, 'declare me cl_terminals%rowtype; caller_main boolean;\n',
    "declare me cl_terminals%rowtype; caller_main boolean;\n        v_out json; v_prices boolean;" + MARK + '\n', 'bs declare');
  t = swap(t, '  return json_build_object(\n    \'server_time\', now(),', '  v_out := json_build_object(' + MARK + '\n    \'server_time\', now(),', 'bs head');
  t = swap(t, "     where b.business_id = me.business_id and (p_branch_id is null or b.id = p_branch_id)) x), '[]'::json));\nend $fn$;",
    "     where b.business_id = me.business_id and (p_branch_id is null or b.id = p_branch_id)) x), '[]'::json));\n" +
    '  -- v36 (decision 49): each branch\'s selling prices (retail as that branch sells it, wholesale) for a person with "branch_prices" (the Guest)\n' +
    "  v_prices := 'branch_prices' = any(coalesce(cl_caller_rights(), '{}'));" + MARK + '\n' +
    '  if not v_prices then return v_out; end if;' + MARK + '\n' +
    "  return (v_out::jsonb || jsonb_build_object('prices', coalesce((select jsonb_object_agg(b.id::text, coalesce((" + MARK + '\n' +
    "      select jsonb_object_agg(c.product_uid, jsonb_build_object('price', case when b.price_mode = 'follow_main' then c.price else coalesce(bp.price, c.price) end," + MARK + '\n' +
    "                                                                'wholesale', c.wholesale_price))" + MARK + '\n' +
    '        from cl_catalogue_products c left join cl_branch_prices bp on bp.branch_id = b.id and bp.product_uid = c.product_uid' + MARK + '\n' +
    "       where c.business_id = me.business_id and c.active), '{}'::jsonb))" + MARK + '\n' +
    "      from cl_branches b where b.business_id = me.business_id and (p_branch_id is null or b.id = p_branch_id)), '{}'::jsonb)))::json;" + MARK + '\n' +
    'end $fn$;', 'bs tail');
  return t;
});

// ---- A12: a Guest's seat reads nothing else (customers, suppliers, costs, documents, money) ----
const GUEST_BLOCKED = ['cl_device_customers_pull', 'cl_device_suppliers_pull', 'cl_device_supplier_invoice_check', 'cl_device_dispatch_pull',
  'cl_device_dispatch_lookup', 'cl_device_business_dispatches', 'cl_device_dispatch_card', 'cl_device_item_ledger', 'cl_device_transfers_pull',
  'cl_device_credit_balances', 'cl_device_itred_orders_pull', 'cl_device_itred_messages_read', 'cl_catalogue_pull', 'cl_catalogue_images_pull',
  'cl_device_stock_levels_push', 'cl_device_b4_push', 'cl_device_dispatch_costs', 'cl_device_branch_report'];
for (const name of GUEST_BLOCKED) change(name, (t) => {
  const m = t.match(/\n(  (?:me|v) := cl_\w+\(p_install_id, p_secret_phrase, p_device_key(?:, false)?\);\n)/g);
  if (!m || m.length !== 1) throw new Error(name + ': expected one caller line');
  return swap(t, m[0], m[0] + '  perform cl_guest_seat_refuse();' + MARK + ' (decision 49): not on a Guest\'s Office seat\n', name);
});

// ---- A13 (decision 50): changing an RPN needs "Change vendor RPN" ----
// the entry check also lets in a holder of the new permission (the rest of the declare line is kept)
function rpnEntry(t, what) {
  const re = /\ndeclare v_staff uuid := cl_rpn_staff\(array\['vendors', 'rpn_directory'\]\);([^\n]*)\n/;
  if (!re.test(t)) throw new Error(what + ': no entry check');
  return t.replace(re, (m, rest) => "\ndeclare v_staff uuid := cl_rpn_staff(array['vendors', 'rpn_directory', 'change_vendor_rpn']);" + rest + MARK + '\n');
}
change('cl_assign_rpn', (t) => swap(rpnEntry(t, 'assign'),
  "  if v_cur is not distinct from p_rpn_id then\n    raise exception '\"%\" already has %.', v_name, coalesce(r.full_name, 'no RPN');\n  end if;\n",
  "  if v_cur is not distinct from p_rpn_id then\n    raise exception '\"%\" already has %.', v_name, coalesce(r.full_name, 'no RPN');\n  end if;\n" +
  "  if v_cur is not null then perform cl_rpn_staff(array['change_vendor_rpn']); end if;" + MARK + ' (decision 50): a change or a removal, not the first RPN\n' +
  "  perform set_config('cl.rpn_change_ok', '1', true);" + MARK + '\n', 'assign'));
change('cl_resolve_rpn_conflict', (t) => {
  const from = "  if p_accept then\n";
  if (t.split(from).length !== 2) throw new Error('resolve: no p_accept branch');
  t = rpnEntry(t, 'resolve');
  return swap(t, from, from +
    "    perform cl_rpn_staff(array['change_vendor_rpn']);" + MARK + ' (decision 50): accepting replaces the business\'s RPN\n' +
    "    perform set_config('cl.rpn_change_ok', '1', true);" + MARK + '\n', 'resolve');
});

change('cl_device_rpn_status', (t) => swap(t, "'rpn_name', r.full_name, 'field_force_no', r.field_force_no,\n",
  "'rpn_name', r.full_name, 'field_force_no', r.field_force_no, 'phone', r.phone," + MARK + ' (decision 50): the RPN\'s details, shown read-only\n', 'rpn status'));

// ---------------------------------------------------------------------------
const SEG =(s) => s.map(([n, f, , next]) => `-- ${n} (current body: ${f})\n${next}\n`).join('\n');
const ROLL = (s) => s.map(([n, f, old]) => `-- ${n} as in ${f}\n${asReplace(old)}\n`).join('\n');

const migration = `-- =====================================================================
-- v36 Fix-A: the role decides everywhere (A11, owner decision 48), the
-- built-in Guest role (A12, decision 49) and the locked RPN link (A13,
-- decision 50). Applied live only after the owner has seen this file and
-- said "apply". Needs 20261113180000_removed_devices (A1) first.
-- Rollback: supabase/rollbacks/20261114120000_roles_everywhere.rollback.sql
-- Tested in PGlite: supabase/tests/roles-everywhere-test.js (and the app's
-- test/fix-a-v36.test.js against this SQL)
-- Generated by tools/db/gen-20261114120000-migration.js: each changed
-- function is its current body plus the lines marked "-- v36".
--
-- A11. Tills: seiGEN checks the signed-in person's role, as on seats (v32).
--   cl_install_vendor   a till's calls may carry "<phrase>|<token>" (the
--                       person's seiGEN session, 12 hours); read only when
--                       the phrase alone doesn't match.
--   cl_seat_need        on a till: the person (token) must hold the right
--                       (STAFF_NO_RIGHT); a token that has ended, or a till
--                       in staff sign-in mode without one: STAFF_SIGN_IN.
--                       Selling, payments, EOD, void/return and credit over
--                       the limit: not checked on a till (as before).
--                       No token and the till in single operator mode: as
--                       before, logged "single operator".
--                       Every function that calls it (GRV, supplier GRV,
--                       dispatch, internal transfers, suppliers, customers,
--                       products, branch prices, tills and join codes,
--                       branch settings, Marketing packs) now checks tills.
--   cl_terminals        + staff_mode ('single' | 'roles'), default 'single'
--                       (every till today); the till reports it.
--   cl_device_staff_mode  read or change it: to 'roles' freely (stricter);
--                       back to 'single' only with a token holding Settings.
--   cl_till_rights_log  each till check: who (or "single operator"), the
--                       right, when; 90 days.
--   cl_device_staff_pull  + staff_mode (the app's sign that seiGEN checks).
-- A12. Guest (built in, can't be changed or deleted): Product List / Stock by
--   branch and "branch_prices" only (each branch's retail and wholesale
--   selling prices; never costs). Signs in only on an Office seat (billed as
--   a seat), until an optional end date (cl_shop_staff.guest_until).
--   A Guest's seat (its invite's person is a Guest) reads nothing else:
--   customers, suppliers, the catalogue (costs), dispatches, transfers,
--   iTred orders, credit, sales sync: GUEST_SEAT; its staff list holds only
--   its Guest; a till never gets a Guest's PIN check value.
--   Only the Owner or an Admin gives or changes the Guest role; home branch
--   main; a new Guest is added in Staff before the seat invite.
-- A13. Changing (or removing) a business's or device's RPN needs the new
--   Console permission "Change vendor RPN" (cl_assign_rpn, accepting a
--   conflict); the first RPN is set as before. A trigger refuses any other
--   change of an RPN that is set (a direct table update included). The
--   app's link (cl_device_link_rpn) is unchanged: it never changes an RPN
--   that is set. Every change stays logged (cl_rpn_assignments, activity).
-- RLS on the new table; no table grants to anon/authenticated.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'table cl_removed_devices (20261113180000)' n where to_regclass('public.cl_removed_devices') is null
    union all select 'cl_install_vendor (20261113180000)' where not exists (select 1 from pg_proc where oid = to_regprocedure('public.cl_install_vendor(text,text,text,boolean,text,text)') and prosrc like '%removed devices%')
    union all select 'cl_seat_need (20261109120000)' where to_regprocedure('public.cl_seat_need(text)') is null
    union all select 'constraint cl_shop_roles_builtin_check' where not exists (select 1 from pg_constraint where conname = 'cl_shop_roles_builtin_check')
  ) x;
  if missing is not null then raise exception 'roles_everywhere aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'column cl_terminals.staff_mode' n where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cl_terminals' and column_name = 'staff_mode')
    union all select 'column cl_shop_staff.guest_until' where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cl_shop_staff' and column_name = 'guest_until')
    union all select 'table cl_till_rights_log' where to_regclass('public.cl_till_rights_log') is not null
    union all select 'module change_vendor_rpn' where exists (select 1 from cl_modules where key = 'change_vendor_rpn')
    union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cl_device_staff_mode', 'cl_till_rights_note', 'cl_shop_guest_ok', 'cl_seat_is_guest', 'cl_seat_person', 'cl_guest_seat',
                      'cl_guest_seat_refuse', 'cl_caller_rights', 'cl_rpn_change_guard')
  ) x;
  if conflicts is not null then raise exception 'roles_everywhere aborted: already there: %. Nothing was changed.', conflicts; end if;
end $$;

-- 1. Tables ---------------------------------------------------------------------
alter table public.cl_terminals
  add column staff_mode text not null default 'single' check (staff_mode in ('single', 'roles')),
  add column staff_mode_ts timestamptz,
  add column staff_mode_by text check (staff_mode_by is null or length(staff_mode_by) <= 80);

create table public.cl_till_rights_log (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.cl_businesses(id) on delete cascade,
  terminal_id uuid not null references public.cl_terminals(id) on delete cascade,
  staff_id    uuid references public.cl_shop_staff(id) on delete set null,
  right_key   text not null check (length(right_key) <= 40),
  how         text not null check (how in ('signed in', 'single operator', 'mode roles', 'mode single')),
  at          timestamptz not null default now()
);
create index cl_till_rights_log_terminal on public.cl_till_rights_log (terminal_id, at);
alter table public.cl_till_rights_log enable row level security;
revoke all on table public.cl_till_rights_log from public, anon, authenticated;

alter table public.cl_shop_roles drop constraint cl_shop_roles_builtin_check;
alter table public.cl_shop_roles add constraint cl_shop_roles_builtin_check
  check (builtin in ('owner', 'admin', 'manager', 'stores', 'cashier', 'guest'));
alter table public.cl_shop_staff add column guest_until timestamptz;

-- 2. Helpers (internal) ------------------------------------------------------------
create function public.cl_till_rights_note(t public.cl_terminals, p_staff uuid, p_right text, p_how text) returns void
language plpgsql volatile security definer set search_path = public as $fn$
begin
  delete from cl_till_rights_log where terminal_id = t.id and at < now() - interval '90 days';
  insert into cl_till_rights_log (business_id, terminal_id, staff_id, right_key, how) values (t.business_id, t.id, p_staff, left(p_right, 40), p_how);
end $fn$;

-- A Guest may use a session only on an Office seat, and only before the end date. Anyone else: true.
create function public.cl_shop_guest_ok(s public.cl_shop_staff, p_terminal uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.builtin from cl_shop_roles r where r.id = s.role_id), '') <> 'guest'
      or (exists (select 1 from cl_terminals t where t.id = p_terminal and t.device_kind = 'seat')
          and (s.guest_until is null or s.guest_until > now()))
$$;
-- The person an Office seat was invited for.
create function public.cl_seat_person(p_terminal uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select jc.staff_id from cl_branch_join_codes jc where jc.used_by_terminal = p_terminal and jc.code_kind = 'seat' order by jc.used_ts desc nulls last limit 1
$$;
-- A Guest's seat: its invite's person (or, before approval, the invite's role) is a Guest.
create function public.cl_seat_is_guest(p_terminal uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from cl_branch_join_codes jc left join cl_shop_staff s on s.id = jc.staff_id
                   join cl_shop_roles r on r.id = coalesce(s.role_id, jc.role_id)
                  where jc.used_by_terminal = p_terminal and jc.code_kind = 'seat' and r.builtin = 'guest')
$$;
create function public.cl_guest_seat() returns boolean
language sql stable as $$ select coalesce(current_setting('cl.seat_guest', true), '') = '1' $$;
create function public.cl_guest_seat_refuse() returns void
language plpgsql stable as $fn$
begin
  if cl_guest_seat() then
    raise exception 'GUEST_SEAT: A Guest''s Office seat sees stock and selling prices only.' using errcode = 'P0001';
  end if;
end $fn$;
-- The rights of the person signed in on the calling device (seat or till), or null.
create function public.cl_caller_rights() returns text[]
language sql stable security definer set search_path = public as $$
  select cl_shop_effective_rights(r) from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id
   where s.active and s.id::text = coalesce(nullif(current_setting('cl.seat_staff', true), ''), nullif(current_setting('cl.till_staff', true), ''))
$$;

-- 3. The Guest role (decision 49) -------------------------------------------------------
create or replace function public.cl_shop_default_rights(p_builtin text) returns text[]
language sql immutable as $$
  select case p_builtin
    when 'owner' then public.cl_shop_rights_all()
    when 'admin' then array_remove(public.cl_shop_rights_all(), 'owner')
    when 'manager' then array['m.sell', 'm.products', 'm.credit', 'm.reports', 'm.marketing', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming',
                              'm.productlist', 'm.stocktake', 'm.requests', 'm.purchasing', 'm.reportwriter', 'm.directory', 'm.eod',
                              'costs', 'edit_prices', 'create_customers', 'review_requisitions', 'other_branches',
                              'approve_writeoffs', 'void_return', 'credit_over_limit', 'sales_reports']::text[]
    when 'stores' then array['m.products', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming', 'm.productlist', 'm.stocktake',
                             'm.purchasing', 'm.reports', 'm.reportwriter']::text[]
    when 'cashier' then array['m.sell', 'm.credit', 'm.productlist', 'm.directory', 'm.requests', 'm.reports', 'm.eod', 'sales_reports']::text[]
    when 'guest' then array['m.productlist', 'branch_prices']::text[]   -- v36 (decision 49): stock and selling prices, view only
  end
$$;
create or replace function public.cl_shop_ensure_roles(p_business uuid) returns void
language sql security definer set search_path = public as $$
  insert into cl_shop_roles (business_id, name, builtin, rights, updated_by)
  select p_business, v.n, v.b, cl_shop_default_rights(v.b), 'seiGEN'
    from (values ('Owner', 'owner', 1), ('Admin', 'admin', 2), ('Manager', 'manager', 3), ('Stores', 'stores', 4), ('Cashier', 'cashier', 5),
                 ('Guest', 'guest', 6)) v(n, b, o)   -- v36 (decision 49)
   where not exists (select 1 from cl_shop_roles r where r.business_id = p_business and r.builtin = v.b)
   order by v.o
  on conflict do nothing
$$;
-- every business that has its roles gets the Guest (a custom role already called "Guest" keeps its name; the built-in one is then "Guest (view only)")
insert into public.cl_shop_roles (business_id, name, builtin, rights, updated_by)
select b.business_id, case when exists (select 1 from public.cl_shop_roles x where x.business_id = b.business_id and lower(btrim(x.name)) = 'guest')
                           then 'Guest (view only)' else 'Guest' end, 'guest', public.cl_shop_default_rights('guest'), 'seiGEN'
  from (select distinct business_id from public.cl_shop_roles) b
 where not exists (select 1 from public.cl_shop_roles r where r.business_id = b.business_id and r.builtin = 'guest');

-- 4. Changed functions (each differs from its current body only by "-- v36" lines) ----------------
${SEG(changed)}
-- 5. A till's staff sign-in mode (A11) --------------------------------------------------------
-- p_mode null: read. 'roles': set (stricter, any time). 'single': only with the token of a person holding Settings.
create function public.cl_device_staff_mode(p_install_id text, p_secret_phrase text, p_device_key text, p_mode text default null, p_staff_token text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if me.device_kind = 'seat' then   -- an Office seat always signs people in (v32); its own column is not used
    if p_mode = 'single' then return json_build_object('error', 'SEAT_NO_SINGLE', 'message', 'An Office seat always uses staff sign-in.'); end if;
    return json_build_object('ok', true, 'staff_mode', 'roles');
  end if;
  if p_mode is null or p_mode = me.staff_mode then return json_build_object('ok', true, 'staff_mode', me.staff_mode); end if;
  if p_mode not in ('single', 'roles') then raise exception 'The mode is single or roles' using errcode = 'P0001'; end if;
  select * into ses from cl_shop_session(p_staff_token, me.id) limit 1;
  if p_mode = 'single' and (ses.staff_id is null or not ('m.settings' = any(ses.rights))) then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Turning single operator mode back on needs someone with the Settings right signed in (online).');
  end if;
  update cl_terminals set staff_mode = p_mode, staff_mode_ts = now(), staff_mode_by = left(coalesce(ses.name, 'this till'), 80) where id = me.id;
  insert into cl_till_rights_log (business_id, terminal_id, staff_id, right_key, how)
  values (me.business_id, me.id, ses.staff_id, 'staff_mode', case when p_mode = 'roles' then 'mode roles' else 'mode single' end);
  return json_build_object('ok', true, 'staff_mode', p_mode);
end $fn$;

-- 6. The RPN link (A13, decision 50) ------------------------------------------------------------
insert into public.cl_modules (id, key, label, description, sort_order)
select gen_random_uuid(), 'change_vendor_rpn', 'Change vendor RPN', 'Change or remove the RPN of a business or device (the first RPN needs Vendors or RPN Directory, as before). Every change is logged.', 61;

-- An RPN that is set changes only through cl_assign_rpn / cl_resolve_rpn_conflict with "Change vendor RPN".
create function public.cl_rpn_change_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if old.rpn_id is not null and new.rpn_id is distinct from old.rpn_id and coalesce(current_setting('cl.rpn_change_ok', true), '') <> '1' then
    raise exception 'RPN_LOCKED: Changing an RPN needs the "Change vendor RPN" permission (Console). Nothing was changed.' using errcode = 'P0001';
  end if;
  return new;
end $fn$;
create trigger cl_vendors_rpn_change_guard before update of rpn_id on public.cl_vendors
  for each row execute function public.cl_rpn_change_guard();
create trigger cl_businesses_rpn_change_guard before update of rpn_id on public.cl_businesses
  for each row execute function public.cl_rpn_change_guard();

-- 7. Who may call what ----------------------------------------------------------------------------
revoke all on function public.cl_till_rights_note(public.cl_terminals, uuid, text, text), public.cl_shop_guest_ok(public.cl_shop_staff, uuid),
  public.cl_seat_person(uuid), public.cl_seat_is_guest(uuid), public.cl_guest_seat(), public.cl_guest_seat_refuse(), public.cl_caller_rights(),
  public.cl_rpn_change_guard() from public, anon, authenticated;
revoke all on function public.cl_device_staff_mode(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.cl_device_staff_mode(text, text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
`;

const rollback = `-- Rollback of 20261114120000_roles_everywhere (v36 Fix-A: A11, A12, A13).
-- Puts back every changed function exactly as before, removes the new
-- functions, the triggers, the Console permission, the Guest roles (only when
-- nobody has them), the columns and the log. The log's rows are lost with it.
begin;

do $$
begin
  if exists (select 1 from public.cl_shop_staff s join public.cl_shop_roles r on r.id = s.role_id where r.builtin = 'guest') then
    raise exception 'Rollback aborted: some staff have the Guest role. Give them another role first. Nothing was changed.';
  end if;
end $$;

drop trigger if exists cl_vendors_rpn_change_guard on public.cl_vendors;
drop trigger if exists cl_businesses_rpn_change_guard on public.cl_businesses;
drop function if exists public.cl_rpn_change_guard();
delete from public.cl_staff_module_access where module_id in (select id from public.cl_modules where key = 'change_vendor_rpn');
delete from public.cl_modules where key = 'change_vendor_rpn';
drop function if exists public.cl_device_staff_mode(text, text, text, text, text);

${ROLL(changed)}
create or replace function public.cl_shop_default_rights(p_builtin text) returns text[]
language sql immutable as $$
  select case p_builtin
    when 'owner' then public.cl_shop_rights_all()
    when 'admin' then array_remove(public.cl_shop_rights_all(), 'owner')
    when 'manager' then array['m.sell', 'm.products', 'm.credit', 'm.reports', 'm.marketing', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming',
                              'm.productlist', 'm.stocktake', 'm.requests', 'm.purchasing', 'm.reportwriter', 'm.directory', 'm.eod',
                              'costs', 'edit_prices', 'create_customers', 'review_requisitions', 'other_branches',
                              'approve_writeoffs', 'void_return', 'credit_over_limit', 'sales_reports']::text[]
    when 'stores' then array['m.products', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming', 'm.productlist', 'm.stocktake',
                             'm.purchasing', 'm.reports', 'm.reportwriter']::text[]
    when 'cashier' then array['m.sell', 'm.credit', 'm.productlist', 'm.directory', 'm.requests', 'm.reports', 'm.eod', 'sales_reports']::text[]
  end
$$;
create or replace function public.cl_shop_ensure_roles(p_business uuid) returns void
language sql security definer set search_path = public as $$
  insert into cl_shop_roles (business_id, name, builtin, rights, updated_by)
  select p_business, v.n, v.b, cl_shop_default_rights(v.b), 'seiGEN'
    from (values ('Owner', 'owner', 1), ('Admin', 'admin', 2), ('Manager', 'manager', 3), ('Stores', 'stores', 4), ('Cashier', 'cashier', 5)) v(n, b, o)
   where not exists (select 1 from cl_shop_roles r where r.business_id = p_business and r.builtin = v.b)
   order by v.o
  on conflict do nothing
$$;

drop function if exists public.cl_caller_rights();
drop function if exists public.cl_guest_seat_refuse();
drop function if exists public.cl_guest_seat();
drop function if exists public.cl_seat_is_guest(uuid);
drop function if exists public.cl_seat_person(uuid);
drop function if exists public.cl_shop_guest_ok(public.cl_shop_staff, uuid);
drop function if exists public.cl_till_rights_note(public.cl_terminals, uuid, text, text);

delete from public.cl_shop_roles where builtin = 'guest';
alter table public.cl_shop_roles drop constraint cl_shop_roles_builtin_check;
alter table public.cl_shop_roles add constraint cl_shop_roles_builtin_check
  check (builtin in ('owner', 'admin', 'manager', 'stores', 'cashier'));
alter table public.cl_shop_staff drop column guest_until;
drop table if exists public.cl_till_rights_log;
alter table public.cl_terminals drop column staff_mode, drop column staff_mode_ts, drop column staff_mode_by;

notify pgrst, 'reload schema';

commit;
`;

fs.writeFileSync(path.join(MIG, '20261114120000_roles_everywhere.sql'), migration);
fs.writeFileSync(path.join(ROOT, 'supabase', 'rollbacks', '20261114120000_roles_everywhere.rollback.sql'), rollback);
console.log('wrote 20261114120000_roles_everywhere.sql (' + migration.length + ' bytes, ' + changed.length + ' changed functions) and its rollback (' + rollback.length + ' bytes)');
