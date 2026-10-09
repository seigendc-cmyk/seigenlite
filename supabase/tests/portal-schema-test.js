// Publish Portal schema tests (20260925150000_publish_portal_staff_tokens.sql).
// Everything runs inside ONE transaction that is always rolled back; each
// expected failure is wrapped in a savepoint.
//
//   node supabase/tests/portal-schema-test.js pglite
//       -> in-memory PGlite with Supabase role stubs; applies the migration
//          first. No network or credentials needed.
//   node supabase/tests/portal-schema-test.js live
//       -> against SUPABASE_DB_URL (the migration must already be applied)
//
// Drivers are not app dependencies; install them without touching package.json:
//   npm install --no-save pg @electric-sql/pglite
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MIG = fs.readFileSync(`${ROOT}/migrations/20260925150000_publish_portal_staff_tokens.sql`, 'utf8');
const MIG_RPN = fs.readFileSync(`${ROOT}/parked/20260926160000_vendor_tokens_rpn_and_payment.sql`, 'utf8');
const mode = process.argv[2] || 'pglite';

// cl_rpn as it is in the live project (only the columns that matter here).
const PGLITE_STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.cl_rpn (id uuid primary key default gen_random_uuid(), full_name text not null, active boolean not null default true, created_at timestamptz not null default now());
insert into public.cl_rpn (id, full_name) values ('464a661e-7c51-4b1b-bf4b-9ba56214d031', 'Test RPN');
`;
// Tokens recorded before the payment rule, as in the live project: one
// without an amount (the rule must leave it alone and still let it be voided).
const PGLITE_LEGACY = `
insert into public.portal_staff (id, username, display_name, role, password_hash)
  values ('00000000-0000-4000-8000-00000000000a', 'legacy-admin-zz', 'Legacy', 'admin', 'scrypt$1$1$1$a$b');
insert into public.vendor_tokens (install_id, starts_on, days, recorded_by)
  values ('TEST-LEGACY-ZZ', '2026-09-01', 30, '00000000-0000-4000-8000-00000000000a');
`;

async function connect() {
  if (mode === 'live') {
    const { Client } = require('pg');
    const ca = fs.readFileSync(`${ROOT}/prod-ca-2021.crt`, 'utf8');
    const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { ca, rejectUnauthorized: true } });
    await c.connect();
    return { q: async (sql, p) => (await c.query(sql, p)).rows, multi: sql => c.query(sql), end: () => c.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(PGLITE_STUB);
  await db.exec(MIG);
  await db.exec(PGLITE_LEGACY);
  await db.exec(MIG_RPN);
  return { q: async (sql, p) => (await db.query(sql, p)).rows, multi: sql => db.exec(sql), end: () => db.close() };
}

let pass = 0, fail = 0, sp = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}

(async () => {
  const db = await connect();
  async function guarded(fn) {
    const name = 'sp' + (++sp);
    await db.q(`savepoint ${name}`);
    try { const r = await fn(); await db.q(`release savepoint ${name}`); return { r }; }
    catch (e) { await db.q(`rollback to savepoint ${name}`); return { e }; }
  }
  async function expectErr(name, sql, re) {
    const { e } = await guarded(() => db.multi(sql));
    if (!e) ok(name, false, 'no error'); else ok(name, !re || re.test(e.message), e.message);
  }
  const HASH = "scrypt$16384$8$1$c2FsdA$aGFzaA";
  try {
    await db.q('begin');

    // ---- staff ----
    const [admin] = await db.q(`insert into public.portal_staff (username, display_name, role, password_hash)
      values ('test-admin-zz', 'Test Admin', 'admin', $1) returning *`, [HASH]);
    ok('a staff row gets defaults: active, 0 failed attempts, not locked, no forced change',
      admin.active === true && admin.failed_attempts === 0 && admin.locked_until === null && admin.must_change_password === false);
    await expectErr('usernames are unique', `insert into public.portal_staff (username, display_name, role, password_hash) values ('test-admin-zz','X','reviewer','${HASH}')`, /portal_staff_username_key/);
    await expectErr('only admin or reviewer', `insert into public.portal_staff (username, display_name, role, password_hash) values ('test-x-zz','X','owner','${HASH}')`, /portal_staff_role_check/);
    await expectErr('usernames are lower-case, no spaces', `insert into public.portal_staff (username, display_name, role, password_hash) values ('Test User','X','reviewer','${HASH}')`, /portal_staff_username_format/);
    await expectErr('a plain-text password is refused', `insert into public.portal_staff (username, display_name, role, password_hash) values ('test-y-zz','X','reviewer','hunter2')`, /portal_staff_password_hash_format/);

    // ---- tokens ----
    const [tok] = await db.q(`insert into public.vendor_tokens (install_id, business_name, starts_on, days, amount, currency, payment_method, recorded_by)
      values ('TEST-8FJM-ZZ', 'Test Vendor', '2026-10-01', 30, 10, 'USD', 'EcoCash', $1) returning *, ends_on::text as ends_on_text`, [admin.id]);
    // As text: drivers turn a date into a local-midnight Date object (PostgREST, which the portal uses, sends the text).
    ok('ends_on is the last day covered: 30 days from 1 Oct ends 30 Oct', tok.ends_on_text === '2026-10-30', tok.ends_on_text);
    await expectErr('ends_on can\'t be written', `update public.vendor_tokens set ends_on = '2027-01-01' where id = '${tok.id}'`, /generated|ends_on/);
    await expectErr('days must be 1..366', `insert into public.vendor_tokens (install_id, starts_on, days, recorded_by, amount, currency, payment_method) values ('TEST-ZZ','2026-10-01',0,'${admin.id}',10,'USD','Cash')`, /vendor_tokens_days_check/);
    await expectErr('a token needs who recorded it', `insert into public.vendor_tokens (install_id, starts_on, days, amount, currency, payment_method) values ('TEST-ZZ','2026-10-01',30,10,'USD','Cash')`, /recorded_by/);
    await expectErr('recorded_by must be a staff member', `insert into public.vendor_tokens (install_id, starts_on, days, recorded_by, amount, currency, payment_method) values ('TEST-ZZ','2026-10-01',30,gen_random_uuid(),10,'USD','Cash')`, /foreign key/);
    await expectErr('currency is a 3-letter code', `insert into public.vendor_tokens (install_id, starts_on, days, currency, recorded_by, amount, payment_method) values ('TEST-ZZ','2026-10-01',30,'usd','${admin.id}',10,'Cash')`, /3-letter/);
    await expectErr('voiding needs who and why', `update public.vendor_tokens set voided_at = now() where id = '${tok.id}'`, /vendor_tokens_void_consistent/);
    const { e: voidErr } = await guarded(() => db.q(`update public.vendor_tokens set voided_at = now(), voided_by = $1, void_reason = 'entered twice' where id = $2`, [admin.id, tok.id]));
    ok('a token can be voided with who and why', !voidErr, voidErr && voidErr.message);

    // ---- RPN on the token, payment required on new tokens (20260926160000) ----
    const RPN = (await db.q(`select id from public.cl_rpn order by created_at nulls last limit 1`))[0].id;
    const ins = (cols, vals) => `insert into public.vendor_tokens (install_id, starts_on, days, recorded_by${cols}) values ('TEST-RPN-ZZ', '2026-10-01', 30, '${admin.id}'${vals})`;
    await expectErr('a new token without an amount is refused', ins(', currency, payment_method', `, 'USD', 'Cash'`), /amount paid/);
    await expectErr('an amount of 0 is refused', ins(', amount, currency, payment_method', `, 0, 'USD', 'Cash'`), /amount paid/);
    await expectErr('a new token without a currency is refused', ins(', amount, payment_method', `, 10, 'Cash'`), /currency/);
    await expectErr('a new token without a payment method is refused', ins(', amount, currency', `, 10, 'USD'`), /payment method/);
    await expectErr('a blank payment method is refused', ins(', amount, currency, payment_method', `, 10, 'USD', '   '`), /payment method/);
    await expectErr('rpn_id must be a real cl_rpn row', ins(', amount, currency, payment_method, rpn_id', `, 10, 'USD', 'Cash', gen_random_uuid()`), /vendor_tokens_rpn_id_fkey/);
    const [paid] = await db.q(ins(', amount, currency, payment_method, rpn_id', `, 10, 'USD', 'EcoCash', '${RPN}'`) + ' returning rpn_id, reference');
    ok('a paid token with an RPN and no reference is accepted', paid.rpn_id === RPN && paid.reference === null);
    const [noRpn] = await db.q(ins(', amount, currency, payment_method', `, 5, 'USD', 'Cash'`) + ' returning rpn_id');
    ok('"No RPN" (rpn_id null) is allowed', noRpn.rpn_id === null);
    const legacy = (await db.q(`select id from public.vendor_tokens where amount is null and voided_at is null order by recorded_at limit 1`))[0];
    ok('tokens recorded before the rule, without an amount, are still there', !!legacy);
    if (legacy) {
      const { e } = await guarded(() => db.q(`update public.vendor_tokens set voided_at = now(), voided_by = $1, void_reason = 'schema test' where id = $2`, [admin.id, legacy.id]));
      ok('...and can still be voided (the rule is for new records only)', !e, e && e.message);
    }
    const trg = await db.q(`select tgname, tgtype from pg_trigger where tgrelid = 'public.vendor_tokens'::regclass and not tgisinternal`);
    ok('the payment rule runs on insert only', trg.length === 1 && trg[0].tgname === 'vendor_tokens_require_payment' && (trg[0].tgtype & 4) === 4 && (trg[0].tgtype & 16) === 0, JSON.stringify(trg));
    if (mode === 'pglite') await expectErr('an RPN that has tokens can\'t be deleted', `delete from public.cl_rpn where id = '${RPN}'`, /vendor_tokens_rpn_id_fkey/);

    // ---- access ----
    for (const role of ['anon', 'authenticated']) {
      for (const t of ['portal_staff', 'vendor_tokens']) {
        const { e } = await guarded(async () => { await db.q(`set local role ${role}`); return db.q(`select * from public.${t}`); });
        ok(`${role} can't read ${t}`, e && /permission denied/.test(e.message), e ? e.message : 'read succeeded');
        await db.q('reset role');
      }
    }
    const rls = await db.q(`select relname, relrowsecurity from pg_class where relname in ('portal_staff','vendor_tokens') order by 1`);
    ok('RLS is on for both tables', rls.length === 2 && rls.every(r => r.relrowsecurity));
    const privs = await db.q(`select
        has_table_privilege('service_role','public.portal_staff','SELECT,INSERT,UPDATE') su,
        has_table_privilege('service_role','public.portal_staff','DELETE') sd,
        has_table_privilege('service_role','public.vendor_tokens','DELETE') td,
        has_table_privilege('anon','public.vendor_tokens','INSERT') ai`);
    ok('service_role can select/insert/update, but not delete; anon can\'t insert',
      privs[0].su === true && privs[0].sd === false && privs[0].td === false && privs[0].ai === false, JSON.stringify(privs[0]));

    // ---- existing tables untouched (live only: pglite has none of them) ----
    if (mode === 'live') {
      const fk = await db.q(`select conrelid::regclass::text t, confrelid::regclass::text r from pg_constraint
        where contype='f' and conrelid in ('public.portal_staff'::regclass,'public.vendor_tokens'::regclass)`);
      ok('the only foreign keys point at portal_staff (none into vendors / cl_vendors)', fk.every(r => r.r === 'portal_staff'), JSON.stringify(fk));
    }
  } finally {
    await db.q('rollback').catch(() => {});
    if (mode === 'live') {
      const left = await db.q(`select (select count(*)::int from public.portal_staff where username like 'test-%-zz') s,
        (select count(*)::int from public.vendor_tokens where install_id like 'TEST-%') t`);
      ok('nothing left behind after the rollback', left[0].s === 0 && left[0].t === 0, JSON.stringify(left[0]));
    }
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
