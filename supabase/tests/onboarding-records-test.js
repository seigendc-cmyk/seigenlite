// node supabase/tests/onboarding-records-test.js
// Tests supabase/migrations/20261009160000_rpn_onboarding_records.sql and its
// rollback in an in-memory PGlite shaped like the live Console (with the
// self-update guard and the onboarding notes migration applied first).
// Never touches the live database.
'use strict';
const fs = require('fs');
const { freshConsole, counter, RPN_A, RPN_B, ROOT } = require('./rpn-console-stub');

const GUARD = fs.readFileSync(`${ROOT}/migrations/20261009150000_rpn_self_update_guard.sql`, 'utf8');
const MIGRATION = fs.readFileSync(`${ROOT}/migrations/20261009160000_rpn_onboarding_records.sql`, 'utf8');
const ROLLBACK = fs.readFileSync(`${ROOT}/rollbacks/20261009160000_rpn_onboarding_records.rollback.sql`, 'utf8');

const R1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const R2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const R3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const N1 = 'aaaaaaaa-0000-4000-8000-000000000001';

const FULL_SECTIONS = {
  vendor: { business_name: 'Mai Tendai Grocers' },
  installation: { secret_phrase_set: 'yes' },
  implementation: { product_source: 'excel' },
  training: { vendor_full_name: 'Tendai Mapfumo', vendor_confirms: true, rpn_declares: true },
};

function save(q, r) {
  const v = Object.assign({
    id: R1, note_id: null, business_name: 'Mai Tendai Grocers', owner_name: 'T. Mapfumo', phone: '+263789012231', city: 'Harare',
    plan: 'business', branches: 1, tills: 2, amount: 18, features: 'Main branch + 1 extra till', sections: { vendor: {} },
    saved_at: '2026-10-09T08:00:00Z', submit: false,
  }, r);
  return q(`select public.cl_rpn_save_onboarding($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14) as r`,
    [v.id, v.note_id, v.business_name, v.owner_name, v.phone, v.city, v.plan, v.branches, v.tills, v.amount, v.features, JSON.stringify(v.sections), v.saved_at, v.submit])
    .then((rows) => rows[0].r);
}

(async () => {
  const t = counter();
  const { pg, q, as } = await freshConsole();
  await pg.exec(GUARD);
  await pg.exec(MIGRATION);
  t.ok('the migration applies to a database shaped like the live one (after the notes migration and the guard)', true);
  let r = await (async () => { try { await pg.exec(MIGRATION); return null; } catch (e) { return e; } })();
  t.ok('applying it twice stops at the preflight', r && /already exists/.test(r.message), r && r.message);

  // A note of RPN A, for linking.
  await as('rpnA', () => q(`insert into public.rpn_onboarding_notes (id, business_name, owner_name, phone, city, visit_date, captured_at) values ('${N1}', 'Mai Tendai Grocers', 'T. Mapfumo', '+263789012231', 'Harare', '2026-10-02', '2026-10-02T10:00:00Z')`), true);

  // ---------------- the table API is closed ----------------
  r = await as('rpnA', () => q(`insert into public.rpn_onboarding_records (id, rpn_id, business_name, owner_name, phone, city, client_saved_at) values ('${R3}', '${RPN_A}', 'x', 'y', '+263771234567', 'z', now())`));
  t.ok('RPN cannot insert into the table directly', !!r.e && /permission denied/.test(r.e.message), r.e ? r.e.message : 'inserted');
  r = await as('anon', () => save(q, {}));
  t.ok('no token: cl_rpn_save_onboarding refused', !!r.e, r.e ? r.e.message : 'saved');
  r = await as('vendorsClerk', () => save(q, {}));
  t.ok('a staff token cannot save as an RPN', !!r.e && /Not authorized/.test(r.e.message), r.e ? r.e.message : 'saved');

  // ---------------- RPN: draft, update, retries ----------------
  r = await as('rpnA', () => save(q, { note_id: N1 }), true);
  t.ok('RPN creates a draft, linked to their own note', !r.e && r.r.status === 'draft' && r.r.result === 'saved', r.e && r.e.message);
  r = await as('rpnA', () => q(`select rpn_id, note_id, status, subscription_currency from public.rpn_onboarding_records where id = '${R1}'`));
  t.ok("rpn_id comes from the token; currency defaults to USD", !r.e && r.r[0].rpn_id === RPN_A && r.r[0].note_id === N1 && r.r[0].subscription_currency === 'USD', JSON.stringify(r.r || r.e.message));
  r = await as('rpnA', () => save(q, { city: 'Chitungwiza', saved_at: '2026-10-09T09:00:00Z' }), true);
  t.ok('a newer copy updates the draft', !r.e && r.r.result === 'saved');
  r = await as('rpnA', () => save(q, { city: 'Old City', saved_at: '2026-10-09T08:30:00Z' }), true);
  t.ok("an older copy arriving late changes nothing ('unchanged')", !r.e && r.r.result === 'unchanged');
  r = await as('rpnA', () => save(q, { city: 'Chitungwiza', saved_at: '2026-10-09T09:00:00Z' }), true);
  t.ok("the same copy again (lost answer, retry) is 'unchanged'", !r.e && r.r.result === 'unchanged');
  r = await q(`select city, count(*) over () n from public.rpn_onboarding_records`);
  t.ok('still one row, with the newest city', r.length === 1 && r[0].city === 'Chitungwiza', JSON.stringify(r));

  r = await as('rpnB', () => q(`select id from public.rpn_onboarding_records`));
  t.ok("RPN B cannot read RPN A's record", !r.e && r.r.length === 0);
  r = await as('rpnB', () => save(q, { saved_at: '2026-10-09T10:00:00Z' }));
  t.ok("RPN B cannot overwrite RPN A's record (same id)", !!r.e && /Not authorized/.test(r.e.message), r.e ? r.e.message : 'saved');
  r = await as('rpnB', () => save(q, { id: R2, note_id: N1 }));
  t.ok("RPN B cannot link RPN A's note", !!r.e && /not one of yours/.test(r.e.message), r.e ? r.e.message : 'saved');

  // ---------------- database checks ----------------
  r = await as('rpnA', () => save(q, { id: R2, plan: 'lite', branches: 2, tills: 2 }));
  t.ok('Lite with 2 branches is refused', !!r.e && /lite_one_branch/.test(r.e.message), r.e ? r.e.message : 'saved');
  r = await as('rpnA', () => save(q, { id: R2, branches: 3, tills: 2 }));
  t.ok('fewer tills than branches is refused', !!r.e && /tills_cover_branches/.test(r.e.message), r.e ? r.e.message : 'saved');
  r = await as('rpnA', () => save(q, { id: R2, phone: 'call me' }));
  t.ok('a bad phone number is refused', !!r.e && /phone_check/.test(r.e.message), r.e ? r.e.message : 'saved');
  r = await as('rpnA', () => save(q, { id: R2, amount: -1 }));
  t.ok('a negative amount is refused', !!r.e, r.e ? r.e.message : 'saved');

  // ---------------- submit ----------------
  r = await as('rpnA', () => save(q, { saved_at: '2026-10-09T11:00:00Z', submit: true, sections: { vendor: {}, installation: {}, implementation: {}, training: { vendor_full_name: 'T', vendor_confirms: false, rpn_declares: true } } }));
  t.ok("submit without the vendor's acceptance is refused", !!r.e && /acceptance/.test(r.e.message), r.e ? r.e.message : 'submitted');
  r = await as('rpnA', () => save(q, { saved_at: '2026-10-09T11:00:00Z', submit: true, sections: { vendor: {} } }));
  t.ok('submit with sections missing is refused', !!r.e && /all four sections/.test(r.e.message), r.e ? r.e.message : 'submitted');
  r = await as('rpnA', () => save(q, { saved_at: '2026-10-09T11:00:00Z', submit: true, amount: null, sections: FULL_SECTIONS }));
  t.ok('submit without the monthly amount is refused', !!r.e && /monthly amount/.test(r.e.message), r.e ? r.e.message : 'submitted');
  r = await as('rpnA', () => save(q, { saved_at: '2026-10-09T11:00:00Z', submit: true, sections: FULL_SECTIONS }), true);
  t.ok('a complete record is submitted', !r.e && r.r.status === 'submitted' && r.r.result === 'submitted', r.e && r.e.message);
  r = await as('rpnA', () => save(q, { saved_at: '2026-10-09T11:00:00Z', submit: true, sections: FULL_SECTIONS }), true);
  t.ok("submitting the same copy again is 'unchanged' (retry safe)", !r.e && r.r.result === 'unchanged' && r.r.status === 'submitted');
  r = await as('rpnA', () => save(q, { saved_at: '2026-10-09T12:00:00Z', city: 'Changed' }));
  t.ok('a submitted record can no longer be changed by the RPN', !!r.e && /no longer be changed/.test(r.e.message), r.e ? r.e.message : 'saved');

  // ---------------- staff: list ----------------
  r = await as('otherClerk', () => q(`select * from public.cl_list_onboarding_records()`));
  t.ok('staff without the Vendors module cannot list', !!r.e && /Not authorized/.test(r.e.message));
  r = await as('rpnA', () => q(`select * from public.cl_list_onboarding_records()`));
  t.ok('an RPN cannot use the staff list', !!r.e && /Not authorized/.test(r.e.message));
  r = await as('vendorsClerk', () => q(`select id, rpn_name, status, commission_eligible from public.cl_list_onboarding_records()`));
  t.ok('Vendors clerk lists submitted records with the RPN name', !r.e && r.r.length === 1 && r.r[0].rpn_name === 'Tendai Moyo' && r.r[0].commission_eligible === false, JSON.stringify(r.r || r.e.message));
  await as('rpnA', () => save(q, { id: R2, saved_at: '2026-10-09T08:00:00Z' }), true);
  r = await as('vendorsClerk', () => q(`select id from public.cl_list_onboarding_records()`));
  t.ok('drafts are left out of the default list', !r.e && r.r.length === 1);
  r = await as('vendorsClerk', () => q(`select id from public.cl_list_onboarding_records('draft')`));
  t.ok("…and shown when asked for ('draft')", !r.e && r.r.length === 1 && r.r[0].id === R2);

  // ---------------- staff: verify ----------------
  r = await as('otherClerk', () => q(`select public.cl_verify_onboarding('${R1}', 'rejected', 'x')`));
  t.ok('staff without the Vendors module cannot verify', !!r.e && /Not authorized/.test(r.e.message));
  r = await as('rpnA', () => q(`select public.cl_verify_onboarding('${R1}', 'approved')`));
  t.ok('an RPN cannot verify (Section 5 is office only)', !!r.e && /Not authorized/.test(r.e.message));
  r = await as('vendorsClerk', () => q(`select public.cl_verify_onboarding('${R1}', 'returned', '  ')`));
  t.ok('returning needs a reason', !!r.e && /reason is needed/.test(r.e.message));
  r = await as('vendorsClerk', () => q(`select public.cl_verify_onboarding('${R1}', 'approved')`));
  t.ok('approving needs a Vendors Register link', !!r.e && /link the onboarding to a vendor/.test(r.e.message));
  r = await as('vendorsClerk', () => q(`select public.cl_verify_onboarding('${R2}', 'rejected', 'x')`));
  t.ok('a draft cannot be verified', !!r.e && /Only a submitted/.test(r.e.message));

  r = await as('vendorsClerk', () => q(`select public.cl_verify_onboarding('${R1}', 'returned', 'Stocktake date missing', '{"vendor_contacted":true}'::jsonb) as r`), true);
  t.ok('office returns it to the RPN with a reason', !r.e && r.r[0].r.status === 'returned', r.e && r.e.message);
  r = await as('rpnA', () => q(`select status, office_reason from public.rpn_onboarding_records where id = '${R1}'`));
  t.ok('the RPN sees "returned" and the reason', !r.e && r.r[0].status === 'returned' && r.r[0].office_reason === 'Stocktake date missing');
  r = await as('rpnA', () => q(`select verified_by, office_checks from public.rpn_onboarding_records where id = '${R1}'`));
  t.ok('(the RPN can read the office fields of their own record, read-only)', !r.e);
  r = await as('rpnA', () => save(q, { saved_at: '2026-10-09T13:00:00Z', submit: true, sections: FULL_SECTIONS }), true);
  t.ok('a returned record can be fixed and submitted again', !r.e && r.r.status === 'submitted', r.e && r.e.message);

  // Vendors and payments for approval.
  const [{ id: V1 }] = await q(`insert into public.cl_vendors (business_name, rpn_id) values ('Mai Tendai Grocers', '${RPN_A}') returning id`);
  const [{ id: V2 }] = await q(`insert into public.cl_vendors (business_name) values ('Other Shop') returning id`);
  const [{ id: PAY1 }] = await q(`insert into public.cl_ledger_entries (vendor_id, entry_type, amount) values ('${V1}', 'payment', 18) returning id`);
  const [{ id: CHG1 }] = await q(`insert into public.cl_ledger_entries (vendor_id, entry_type, amount) values ('${V1}', 'charge', 18) returning id`);
  const [{ id: PAY2 }] = await q(`insert into public.cl_ledger_entries (vendor_id, entry_type, amount) values ('${V2}', 'payment', 6) returning id`);

  r = await as('vendorsClerk', () => q(`select public.cl_verify_onboarding('${R1}', 'approved', null, '{}'::jsonb, '${V1}', '${CHG1}')`));
  t.ok('a charge cannot be linked as the payment', !!r.e && /not a payment by this vendor/.test(r.e.message));
  r = await as('vendorsClerk', () => q(`select public.cl_verify_onboarding('${R1}', 'approved', null, '{}'::jsonb, '${V1}', '${PAY2}')`));
  t.ok("another vendor's payment cannot be linked", !!r.e && /not a payment by this vendor/.test(r.e.message));
  r = await as('vendorsClerk', () => q(`select public.cl_verify_onboarding('${R1}', 'approved', null, '{"vendor_contacted":true,"details_match":true,"plan_confirmed":true}'::jsonb, '${V1}', '${PAY1}') as r`), true);
  t.ok('office approves with the vendor and its first payment', !r.e && r.r[0].r.status === 'approved' && r.r[0].r.commission_eligible === true, r.e && r.e.message);
  r = await q(`select status from public.cl_vendors where id = '${V1}'`);
  t.ok("approving does not change the vendor's status (still 'onboarding')", r[0].status === 'onboarding');
  r = await q(`select count(*)::int n from public.cl_ledger_entries`);
  t.ok('no ledger entry is created or changed', r[0].n === 3);
  r = await q(`select action, staff_id from public.cl_activity_log where target_table = 'rpn_onboarding_records' order by created_at`);
  t.ok('both office decisions are in cl_activity_log', r.length === 2 && r[0].action === 'onboarding_record_returned' && r[1].action === 'onboarding_record_approved', JSON.stringify(r));
  r = await as('vendorsClerk', () => q(`select payment_amount, vendor_business_name, verified_by_name, commission_eligible from public.cl_list_onboarding_records('approved')`));
  t.ok('the list shows payment, vendor and who verified, by name', !r.e && Number(r.r[0].payment_amount) === 18 && r.r[0].vendor_business_name === 'Mai Tendai Grocers' && r.r[0].verified_by_name === 'Vendors Clerk' && r.r[0].commission_eligible === true, JSON.stringify(r.r || r.e.message));
  r = await as('vendorsClerk', () => q(`select public.cl_verify_onboarding('${R1}', 'rejected', 'changed mind')`));
  t.ok('an approved record cannot be verified again', !!r.e && /Only a submitted/.test(r.e.message));
  r = await as('rpnA', () => save(q, { saved_at: '2026-10-09T15:00:00Z' }));
  t.ok('an approved record cannot be changed by the RPN', !!r.e && /approved and can no longer be changed/.test(r.e.message));

  // ---------------- rollback ----------------
  await pg.exec(ROLLBACK);
  r = await q(`select to_regclass('public.rpn_onboarding_records') t, (select count(*)::int from pg_proc where proname in ('cl_rpn_save_onboarding','cl_list_onboarding_records','cl_verify_onboarding')) f, (select count(*)::int from public.cl_ledger_entries) l, (select count(*)::int from public.rpn_onboarding_notes) n`);
  t.ok('rollback removes the table and the three functions; ledger and notes untouched', r[0].t === null && r[0].f === 0 && r[0].l === 3 && r[0].n === 1, JSON.stringify(r));
  await pg.exec(MIGRATION);
  t.ok('the migration applies again after the rollback', true);

  t.done();
})().catch((e) => { console.error(e); process.exit(1); });
