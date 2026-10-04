// node supabase/tests/onboarding-notes-draft-test.js
//
// Tests the migration supabase/migrations/20261003120000_rpn_onboarding_notes.sql
// (and its rollback) in an in-memory PGlite — never against the live
// database: the draft is not applied there.
//
// The stub below copies, from a read-only look at the live project on
// 2026-10-03, exactly what the draft depends on: the cl_jwt_* helpers and
// cl_has_module_access (same bodies), the columns of cl_rpn / cl_staff /
// cl_modules / cl_staff_module_access / cl_vendors / cl_activity_log that
// matter, their live grants (everything to anon and authenticated) and
// the live cl_vendors / cl_rpn policies. auth.jwt() reads the claims the
// way Supabase does (request.jwt.claims), so each caller is "signed in"
// by setting those claims, as PostgREST does from a cl_login token.
//
//   npm install --no-save @electric-sql/pglite   (already there if portal-schema-test runs)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRAFT = fs.readFileSync(`${ROOT}/migrations/20261003120000_rpn_onboarding_notes.sql`, 'utf8');
const ROLLBACK = fs.readFileSync(`${ROOT}/rollbacks/20261003120000_rpn_onboarding_notes.rollback.sql`, 'utf8');

const LIVE_STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;

create function public.cl_jwt_sub() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub','')::uuid $$;
create function public.cl_jwt_user_type() returns text language sql stable as $$ select auth.jwt() ->> 'user_type' $$;
create function public.cl_jwt_is_sysadmin() returns boolean language sql stable as $$ select coalesce((auth.jwt() ->> 'is_sysadmin')::boolean, false) $$;

create table public.cl_staff (id uuid primary key default gen_random_uuid(), full_name text not null, passcode_hash text not null default 'x', is_sysadmin boolean not null default false, active boolean not null default true, created_at timestamptz not null default now());
create table public.cl_modules (id uuid primary key default gen_random_uuid(), key text not null unique, label text not null, sort_order integer not null default 0);
create table public.cl_staff_module_access (staff_id uuid not null references public.cl_staff(id) on delete cascade, module_id uuid not null references public.cl_modules(id) on delete cascade, granted_at timestamptz not null default now(), primary key (staff_id, module_id));
create function public.cl_has_module_access(p_module_key text) returns boolean language sql stable as $$
  select cl_jwt_is_sysadmin() or exists (select 1 from cl_staff_module_access sma join cl_modules m on m.id = sma.module_id where sma.staff_id = cl_jwt_sub() and m.key = p_module_key)
$$;
create table public.cl_rpn (id uuid primary key default gen_random_uuid(), full_name text not null, phone text, city text, passcode_hash text not null default 'x', verification_code text not null default 'x', verification_used boolean not null default false, active boolean not null default true, created_at timestamptz not null default now());
create table public.cl_vendors (
  id uuid primary key default gen_random_uuid(), business_name text not null, owner_name text, phone text, city text,
  rpn_id uuid references public.cl_rpn(id), device_code text, shop_secret_phrase text, cycle_start_date date,
  status text not null default 'onboarding' check (status = any (array['onboarding','active','overdue','suspended','cancelled'])),
  onboarded_at timestamptz default now(), notes text, created_by uuid references public.cl_staff(id), created_at timestamptz not null default now(),
  install_id text unique, location text, app_registered_at timestamptz, last_checkin_at timestamptz,
  lock_cart boolean not null default false, lock_add_product boolean not null default false, lock_reason text);
create table public.cl_activity_log (id uuid primary key default gen_random_uuid(), staff_id uuid references public.cl_staff(id), action text not null, target_table text, target_id uuid, detail jsonb, created_at timestamptz not null default now());

grant all on public.cl_staff, public.cl_modules, public.cl_staff_module_access, public.cl_rpn, public.cl_vendors, public.cl_activity_log to anon, authenticated;
alter table public.cl_vendors enable row level security;
alter table public.cl_rpn enable row level security;
alter table public.cl_activity_log enable row level security;
alter table public.cl_staff enable row level security;
alter table public.cl_modules enable row level security;
alter table public.cl_staff_module_access enable row level security;
create policy cl_vendors_select on public.cl_vendors for select using (((cl_jwt_user_type() = 'rpn') and (rpn_id = cl_jwt_sub())) or ((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors'))));
create policy cl_vendors_write_staff on public.cl_vendors for all using ((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors'))) with check ((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('vendors')));
create policy cl_rpn_select on public.cl_rpn for select using (((cl_jwt_user_type() = 'rpn') and (id = cl_jwt_sub())) or ((cl_jwt_user_type() = 'staff') and (cl_jwt_is_sysadmin() or cl_has_module_access('rpn_directory'))));
create policy cl_activity_log_insert on public.cl_activity_log for insert with check ((cl_jwt_user_type() = 'staff') and (staff_id = cl_jwt_sub()));
create policy cl_activity_log_select on public.cl_activity_log for select using ((cl_jwt_user_type() = 'staff') and cl_jwt_is_sysadmin());
create policy cl_staff_select_self on public.cl_staff for select using ((cl_jwt_user_type() = 'staff') and ((id = cl_jwt_sub()) or cl_jwt_is_sysadmin()));
create policy cl_modules_select on public.cl_modules for select using (cl_jwt_user_type() = any (array['staff','rpn']));
create policy cl_sma_select_self on public.cl_staff_module_access for select using ((cl_jwt_user_type() = 'staff') and ((staff_id = cl_jwt_sub()) or cl_jwt_is_sysadmin()));
`;

const RPN_A = '11111111-1111-4111-8111-111111111111';
const RPN_B = '22222222-2222-4222-8222-222222222222';
const STAFF_VENDORS = '33333333-3333-4333-8333-333333333333';
const STAFF_OTHER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const SEED = `
insert into public.cl_rpn (id, full_name) values ('${RPN_A}', 'Tendai Moyo'), ('${RPN_B}', 'Rudo Banda');
insert into public.cl_staff (id, full_name, is_sysadmin) values ('${STAFF_VENDORS}', 'Vendors Clerk', false), ('${STAFF_OTHER}', 'Cashbook Clerk', false), ('${ADMIN}', 'Admin', true);
insert into public.cl_modules (key, label) values ('vendors', 'Vendors Register'), ('cashbook', 'Cashbook'), ('rpn_directory', 'RPN Directory');
insert into public.cl_staff_module_access (staff_id, module_id) select '${STAFF_VENDORS}', id from public.cl_modules where key = 'vendors';
insert into public.cl_staff_module_access (staff_id, module_id) select '${STAFF_OTHER}', id from public.cl_modules where key = 'cashbook';
`;

const claims = {
  anon: null,
  rpnA: { role: 'authenticated', sub: RPN_A, user_type: 'rpn', full_name: 'Tendai Moyo' },
  rpnB: { role: 'authenticated', sub: RPN_B, user_type: 'rpn', full_name: 'Rudo Banda' },
  vendorsClerk: { role: 'authenticated', sub: STAFF_VENDORS, user_type: 'staff', is_sysadmin: false },
  otherClerk: { role: 'authenticated', sub: STAFF_OTHER, user_type: 'staff', is_sysadmin: false },
  admin: { role: 'authenticated', sub: ADMIN, user_type: 'staff', is_sysadmin: true },
};

let pass = 0, fail = 0, sp = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  await pg.exec(LIVE_STUB);
  await pg.exec(SEED);
  await pg.exec(DRAFT);
  ok('the draft applies to a database shaped like the live one', true);

  // Run fn as a caller (role + JWT claims), inside a savepoint that is
  // always rolled back unless keep is true.
  async function as(who, fn, keep) {
    const name = 'sp' + (++sp);
    await q('begin');
    await q(`savepoint ${name}`);
    try {
      const c = claims[who];
      await q(`set local role ${c ? 'authenticated' : 'anon'}`);
      await q(`select set_config('request.jwt.claims', $1, true)`, [c ? JSON.stringify(c) : '']);
      const r = await fn();
      await q('reset role');
      await q(keep ? 'commit' : 'rollback');
      return { r };
    } catch (e) {
      await q('rollback');
      return { e };
    }
  }
  const note = (id, extra) => Object.assign({
    id, business_name: 'Mai Tendai Grocers', owner_name: 'T. Mapfumo', phone: '+263 78 901 2231', city: 'Harare',
    location: 'Mbare, stall 14', notes: 'Wants to start next week', business_type: 'Grocery', record_keeping: 'Exercise book',
    approx_products: 120, devices: 'Android phone', plan_interest: 'Monthly', stocktake_needed: 'yes',
    visit_date: '2026-10-02', captured_at: '2026-10-02T10:15:00Z',
  }, extra || {});
  const insertNote = (n) => q(
    `insert into public.rpn_onboarding_notes (id, business_name, owner_name, phone, city, location, notes, business_type, record_keeping, approx_products, devices, plan_interest, stocktake_needed, visit_date, captured_at${n.rpn_id ? ', rpn_id' : ''}${n.vendor_id ? ', vendor_id' : ''})
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15${n.rpn_id ? ", '" + n.rpn_id + "'" : ''}${n.vendor_id ? ", '" + n.vendor_id + "'" : ''}) returning id, rpn_id`,
    [n.id, n.business_name, n.owner_name, n.phone, n.city, n.location, n.notes, n.business_type, n.record_keeping, n.approx_products, n.devices, n.plan_interest, n.stocktake_needed, n.visit_date, n.captured_at]);

  const N1 = 'aaaaaaaa-0000-4000-8000-000000000001';
  const N2 = 'aaaaaaaa-0000-4000-8000-000000000002';

  // ---- RPN writes ----
  let r = await as('rpnA', () => insertNote(note(N1)), true);
  ok('an RPN can send a note; rpn_id comes from the sign-in', !r.e && r.r[0].rpn_id === RPN_A, r.e && r.e.message);
  r = await as('rpnA', () => insertNote(note(N1)));
  ok('sending the same note again is refused by the primary key (no duplicate)', r.e && r.e.code === '23505', r.e ? r.e.code + ' ' + r.e.message : 'inserted twice');
  ok('...and there is still exactly one', (await q(`select count(*)::int n from public.rpn_onboarding_notes where id = $1`, [N1]))[0].n === 1);
  r = await as('rpnA', () => insertNote(note(N2, { rpn_id: RPN_B })));
  ok('an RPN can\'t send a note as another RPN', r.e && /row-level security/.test(r.e.message), r.e ? r.e.message : 'accepted');
  r = await as('rpnA', () => q(`insert into public.cl_vendors (business_name) values ('x') returning id`));
  ok('an RPN still can\'t write the Vendors Register directly (live policy, unchanged)', r.e && /row-level security/.test(r.e.message), r.e ? r.e.message : 'inserted');
  const [realVendor] = await q(`insert into public.cl_vendors (business_name, rpn_id) values ('Existing Shop', '${RPN_A}') returning id`);
  r = await as('rpnA', () => insertNote(note(N2, { vendor_id: realVendor.id })));
  ok('an RPN can\'t link their own note to a vendor (even one that is theirs)', r.e && /row-level security/.test(r.e.message), r.e ? r.e.message : 'accepted');
  await q(`delete from public.cl_vendors where id = $1`, [realVendor.id]);
  r = await as('vendorsClerk', () => insertNote(note(N2)));
  ok('staff can\'t send notes as an RPN', r.e && /row-level security/.test(r.e.message), r.e ? r.e.message : 'accepted');
  r = await as('anon', () => insertNote(note(N2)));
  ok('without signing in (anon key only), nothing can be sent', r.e && /permission denied/.test(r.e.message), r.e ? r.e.message : 'accepted');
  for (const [label, extra, re] of [
    ['a phone number with letters', { phone: 'call me' }, /phone/],
    ['an empty business name', { business_name: '   ' }, /business_name/],
    ['an empty owner name', { owner_name: '' }, /owner_name/],
    ['a stocktake answer that isn\'t yes/no/not sure', { stocktake_needed: 'maybe' }, /stocktake_needed/],
    ['a negative product count', { approx_products: -1 }, /approx_products/],
    ['a missing visit date', { visit_date: null }, /visit_date/],
  ]) {
    r = await as('rpnA', () => insertNote(note(N2, extra)));
    ok('refused: ' + label, r.e && re.test(r.e.message), r.e ? r.e.message : 'accepted');
  }

  // ---- RPN reads: own only (H5 in miniature) ----
  r = await as('rpnA', () => q(`select id from public.rpn_onboarding_notes`));
  ok('the RPN sees their own note', !r.e && r.r.length === 1 && r.r[0].id === N1);
  r = await as('rpnB', () => q(`select id from public.rpn_onboarding_notes`));
  ok('a second RPN sees none of the first RPN\'s notes', !r.e && r.r.length === 0, r.e ? r.e.message : JSON.stringify(r.r));
  r = await as('rpnB', () => q(`select id from public.rpn_onboarding_notes where id = $1`, [N1]));
  ok('...not even by asking for its id', !r.e && r.r.length === 0);
  r = await as('anon', () => q(`select id from public.rpn_onboarding_notes`));
  ok('anon can\'t read notes', r.e && /permission denied/.test(r.e.message), r.e ? r.e.message : 'read');

  // ---- no edits, no deletes ----
  r = await as('rpnA', () => q(`update public.rpn_onboarding_notes set notes = 'changed' where id = $1`, [N1]));
  ok('a sent note can\'t be edited by its RPN', r.e && /permission denied/.test(r.e.message), r.e ? r.e.message : 'updated');
  r = await as('rpnA', () => q(`delete from public.rpn_onboarding_notes where id = $1`, [N1]));
  ok('...or deleted', r.e && /permission denied/.test(r.e.message), r.e ? r.e.message : 'deleted');
  r = await as('admin', () => q(`update public.rpn_onboarding_notes set notes = 'changed' where id = $1`, [N1]));
  ok('not even a sysadmin edits it directly (only through the staff function)', r.e && /permission denied/.test(r.e.message), r.e ? r.e.message : 'updated');

  // ---- staff read path ----
  r = await as('vendorsClerk', () => q(`select * from public.cl_list_onboarding_notes()`));
  ok('staff with the Vendors Register module see incoming notes, with the RPN\'s name', !r.e && r.r.length === 1 && r.r[0].rpn_name === 'Tendai Moyo' && r.r[0].business_name === 'Mai Tendai Grocers', r.e ? r.e.message : JSON.stringify(r.r));
  r = await as('admin', () => q(`select * from public.cl_list_onboarding_notes()`));
  ok('a sysadmin sees them too', !r.e && r.r.length === 1);
  r = await as('otherClerk', () => q(`select * from public.cl_list_onboarding_notes()`));
  ok('staff without the Vendors Register module are refused', r.e && /Not authorized/.test(r.e.message), r.e ? r.e.message : 'read');
  r = await as('rpnA', () => q(`select * from public.cl_list_onboarding_notes()`));
  ok('an RPN can\'t use the staff read path', r.e && /Not authorized/.test(r.e.message), r.e ? r.e.message : 'read');
  r = await as('anon', () => q(`select * from public.cl_list_onboarding_notes()`));
  ok('anon can\'t call it at all', r.e && /permission denied/.test(r.e.message), r.e ? r.e.message : 'read');

  // ---- note -> Vendors Register ----
  r = await as('otherClerk', () => q(`select public.cl_onboarding_note_to_vendor($1) j`, [N1]));
  ok('staff without the module can\'t turn a note into a vendor', r.e && /Not authorized/.test(r.e.message), r.e ? r.e.message : 'done');
  r = await as('rpnA', () => q(`select public.cl_onboarding_note_to_vendor($1) j`, [N1]));
  ok('an RPN can\'t either', r.e && /Not authorized/.test(r.e.message), r.e ? r.e.message : 'done');
  r = await as('vendorsClerk', () => q(`select public.cl_onboarding_note_to_vendor($1) j`, [N1]), true);
  ok('staff with the module create the vendor from the note', !r.e && r.r[0].j.status === 'onboarding', r.e && r.e.message);
  const created = (await q(`select v.*, n.handled_by, n.vendor_id note_vendor from public.cl_vendors v join public.rpn_onboarding_notes n on n.vendor_id = v.id where n.id = $1`, [N1]))[0];
  ok('the new vendor: onboarding, the note\'s RPN, owner, city, phone and notes; created_by the clerk',
    created && created.status === 'onboarding' && created.rpn_id === RPN_A && created.owner_name === 'T. Mapfumo' && created.city === 'Harare' && created.phone === '+263 78 901 2231' && created.notes === 'Wants to start next week' && created.created_by === STAFF_VENDORS && created.handled_by === STAFF_VENDORS,
    JSON.stringify(created));
  const log = await q(`select action, staff_id, detail from public.cl_activity_log where target_id = $1`, [created.id]);
  ok('it is in the activity log, by the clerk', log.length === 1 && log[0].action === 'onboarding_note_new_vendor' && log[0].staff_id === STAFF_VENDORS);
  r = await as('rpnA', () => q(`select id, business_name from public.cl_vendors`));
  ok('the RPN now sees that vendor in the Vendors Register (existing cl_vendors policy)', !r.e && r.r.length === 1 && r.r[0].id === created.id);
  r = await as('vendorsClerk', () => q(`select public.cl_onboarding_note_to_vendor($1) j`, [N1]));
  ok('a note can only become a vendor once', r.e && /already linked/.test(r.e.message), r.e ? r.e.message : 'twice');
  r = await as('vendorsClerk', () => q(`select * from public.cl_list_onboarding_notes()`));
  ok('handled notes drop off the incoming list', !r.e && r.r.length === 0);
  r = await as('vendorsClerk', () => q(`select * from public.cl_list_onboarding_notes(true)`));
  ok('...and show, with the vendor and who handled it, when asked for', !r.e && r.r.length === 1 && r.r[0].vendor_business_name === 'Mai Tendai Grocers' && r.r[0].handled_by_name === 'Vendors Clerk');

  // link mode: a vendor row the shop's app made at check-in (no owner/city/RPN)
  const [device] = await q(`insert into public.cl_vendors (business_name, phone, install_id, location, status) values ('Chikwanha Fast Foods', '+263 77 220 0044', 'INST-ZZ1', 'Main St', 'onboarding') returning id`);
  const N3 = 'aaaaaaaa-0000-4000-8000-000000000003';
  await as('rpnB', () => insertNote(note(N3, { business_name: 'Chikwanha Fast Foods', owner_name: 'P. Chikwanha', phone: '+263 71 000 0000', city: 'Mutare', location: 'Other place' })), true);
  r = await as('vendorsClerk', () => q(`select public.cl_onboarding_note_to_vendor($1, $2) j`, [N3, device.id]), true);
  const linked = (await q(`select * from public.cl_vendors where id = $1`, [device.id]))[0];
  ok('linking fills only what the vendor row is missing (owner, city, RPN)',
    !r.e && linked.owner_name === 'P. Chikwanha' && linked.city === 'Mutare' && linked.rpn_id === RPN_B,
    r.e ? r.e.message : JSON.stringify(linked));
  ok('...and never overwrites what is there (phone, location, install)',
    linked.phone === '+263 77 220 0044' && linked.location === 'Main St' && linked.install_id === 'INST-ZZ1');
  ok('no second vendor row was made', (await q(`select count(*)::int n from public.cl_vendors where business_name = 'Chikwanha Fast Foods'`))[0].n === 1);

  // ---- applying twice, and the rollback ----
  let again;
  try { await pg.exec(DRAFT); } catch (e) { again = e; }
  ok('applying the draft a second time stops in the preflight, changing nothing', again && /already exists/.test(again.message), again && again.message);
  const vendorsBefore = (await q(`select count(*)::int n from public.cl_vendors`))[0].n;
  await pg.exec(ROLLBACK);
  const gone = await q(`select to_regclass('public.rpn_onboarding_notes') t,
    (select count(*)::int from pg_proc where proname in ('cl_list_onboarding_notes','cl_onboarding_note_to_vendor')) f`);
  ok('the rollback removes the table and both functions', gone[0].t === null && gone[0].f === 0);
  ok('...and leaves the Vendors Register rows alone', (await q(`select count(*)::int n from public.cl_vendors`))[0].n === vendorsBefore);
  await pg.exec(DRAFT);
  ok('after the rollback the draft applies cleanly again', true);

  await pg.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
