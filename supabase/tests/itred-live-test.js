// iTred marketplace schema tests. Everything runs inside ONE transaction that
// is always rolled back; each expected failure is wrapped in a savepoint, and
// the run ends by counting leftover test rows (should all be 0).
//
//   node supabase/tests/itred-live-test.js live
//       -> against SUPABASE_DB_URL (both migrations must already be applied)
//   node supabase/tests/itred-live-test.js pglite
//       -> in-memory PGlite with Supabase role / cl_vendors stubs; applies
//          both migrations first. No network or credentials needed.
//
// Drivers are not app dependencies; install them without touching package.json:
//   npm install --no-save pg @electric-sql/pglite
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MIG = fs.readFileSync(`${ROOT}/migrations/20260924120000_itred_marketplace_schema.sql`, 'utf8');
const MIG_FULFIL = fs.readFileSync(`${ROOT}/migrations/20260925120000_itred_po_fulfilment.sql`, 'utf8');
const INSPECT = fs.readFileSync(`${ROOT}/inspect/itred_existing_schema_check.sql`, 'utf8');
const mode = process.argv[2] || 'pglite';

const PGLITE_STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(nullif(current_setting('request.jwt.claims', true),'')::json->>'sub','')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table public.cl_vendors (
  id uuid primary key default gen_random_uuid(), business_name text not null,
  install_id text, shop_secret_phrase text, status text not null default 'onboarding');
create unique index cl_vendors_install_id_uidx on public.cl_vendors (install_id) where install_id is not null;
insert into public.cl_vendors (business_name, install_id, shop_secret_phrase) values ('Existing', 'existing-1', 's');
`;

async function connect() {
  if (mode === 'live') {
    const { Client } = require('pg');
    // Verify the server against Supabase's root CA (public cert, committed).
    const ca = fs.readFileSync(`${ROOT}/prod-ca-2021.crt`, 'utf8');
    const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { ca, rejectUnauthorized: true } });
    await c.connect();
    return { q: async (sql, p) => (await c.query(sql, p)).rows, multi: sql => c.query(sql), end: () => c.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(PGLITE_STUB);
  await db.exec(MIG);
  await db.exec(MIG_FULFIL);
  return { q: async (sql, p) => (await db.query(sql, p)).rows, multi: sql => db.exec(sql), end: () => db.close() };
}

let pass = 0, fail = 0, sp = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}

(async () => {
  const db = await connect();
  // Run fn inside a savepoint; on error roll back to it. Role/claims are
  // restored to what they were before, because ROLLBACK TO undoes SET LOCAL.
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
  const rows = (sql, p) => db.q(sql, p);
  async function as(role, sub, email) {
    await db.q('reset role');
    const claims = sub ? JSON.stringify({ sub, email, role }) : '';
    await db.q("select set_config('request.jwt.claims', $1, true)", [claims]);
    if (role !== 'postgres') await db.q(`set local role ${role}`);
  }

  const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222';
  const VA = 'aaaaaaaa-0000-4000-8000-000000000001', VB = 'bbbbbbbb-0000-4000-8000-000000000002';
  const IA = 'itred-test-install-A', IB = 'itred-test-install-B';

  await db.q('begin');
  try {
    console.log('schema present / preflight');
    ok('migration objects exist', (await rows(`select count(*)::int n from unnest(array['public.vendors','public.vendor_listings','public.customers','public.purchase_orders','public.purchase_order_items']) t where to_regclass(t) is not null`))[0].n === 5);
    const colsBefore = (await rows(`select count(*)::int n from information_schema.columns where table_schema='public' and table_name='vendors'`))[0].n;
    await expectErr('re-run aborts via preflight, naming public.vendors', MIG, /already exist: public\.vendors/);
    ok('fulfilment migration objects exist', (await rows(`select
        (select count(*)::int from pg_proc where proname='itred_po_sync_status') +
        (select count(*)::int from pg_trigger where tgname='purchase_order_items_sync_po_status') +
        (select count(*)::int from pg_policy where polname='Customers can record fulfilment on own purchase orders') n`))[0].n === 3);
    await expectErr('fulfilment migration re-run aborts via preflight', MIG_FULFIL, /already exist: .*itred_po_sync_status/);
    ok('aborted re-run changed nothing', (await rows(`select count(*)::int n from information_schema.columns where table_schema='public' and table_name='vendors'`))[0].n === colsBefore);
    ok('cl_vendors_install_id_key constraint present', (await rows(`select count(*)::int n from pg_constraint where conrelid='public.cl_vendors'::regclass and conname='cl_vendors_install_id_key' and contype='u'`))[0].n === 1);
    const insp = INSPECT.replace(/^\s*--.*$/gm, '').split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
    let inspOk = true;
    for (const s of insp) { const { e } = await guarded(() => db.q(s)); if (e) { inspOk = false; console.log('   inspect err: ' + e.message); } }
    ok('inspection script runs', inspOk);
    ok('inspection conflict query now reports all 8 names as taken', (await rows(insp[0])).length === 8);

    console.log('seed (postgres)');
    await as('postgres');
    await db.q(`insert into auth.users (id, email) values ($1,'u1@itred-test.invalid'),($2,'u2@itred-test.invalid')`, [U1, U2]);
    await db.q(`insert into public.cl_vendors (business_name, install_id, shop_secret_phrase) values ('Shop A',$1,'test'),('Shop B',$2,'test')`, [IA, IB]);
    await db.q(`insert into vendors(id,install_id,business_name,whatsapp_number,city) values ($1,$3,'Shop A','0771','Harare'),($2,$4,'Shop B','0772','Bulawayo')`, [VA, VB, IA, IB]);
    await db.multi(`
      insert into vendor_listings(id,vendor_id,product_name,price,exported_at,published_at,status) values
       ('a1000000-0000-4000-8000-000000000001','${VA}','Sugar 2kg',3.50,now(),now(),'published'),
       ('a2000000-0000-4000-8000-000000000002','${VA}','Rice 5kg',6.00,now(),null,'pending_review'),
       ('a3000000-0000-4000-8000-000000000003','${VA}','Old Oil',2.00,now()-interval '9 days',now()-interval '8 days','published'),
       ('b1000000-0000-4000-8000-000000000001','${VB}','Bread',1.00,now(),now(),'published');`);
    ok('seeded', true);

    console.log('cl_vendors link');
    await expectErr('vendor with unregistered install_id rejected', `insert into vendors(install_id,business_name) values ('itred-test-no-such-install','X')`, /foreign key/);
    await expectErr('vendor without install_id rejected', `insert into vendors(business_name) values ('X')`, /null value|not-null/);
    await expectErr('second vendor for same install rejected', `insert into vendors(install_id,business_name) values ('${IA}','dup')`, /duplicate key/);
    await expectErr('deleting a cl_vendors shop with a marketplace vendor is blocked', `delete from public.cl_vendors where install_id='${IA}'`, /foreign key/);
    await expectErr('duplicate install_id in cl_vendors still rejected', `insert into public.cl_vendors (business_name, install_id) values ('dup','${IA}')`, /duplicate key/);
    if (mode === 'live') {
      const { r, e } = await guarded(() => db.q(`select public.cl_device_checkin('itred-test-install-C','test',null,'Checkin Test') j`));
      ok('cl_device_checkin still registers a new install', !e && r[0].j.status === 'onboarding', e && e.message);
      const again = await guarded(() => db.q(`select public.cl_device_checkin('${IA}','test',null,'Shop A renamed') j`));
      ok('cl_device_checkin still updates an install that has a marketplace vendor', !again.e && again.r[0].j.vendor_id, again.e && again.e.message);
    }

    console.log('listings / expiry');
    const d = (await rows(`select extract(epoch from expires_at - published_at)::int s from vendor_listings where id='a1000000-0000-4000-8000-000000000001'`))[0].s;
    ok('expires_at = published_at + 7 days', d === 7 * 86400, String(d));
    await expectErr('published without published_at rejected', `insert into vendor_listings(vendor_id,product_name,price,exported_at,status) values ('${VA}','x',1,now(),'published')`, /published_has_dates/);

    console.log('anon');
    await as('anon');
    const live = await rows(`select product_name from vendor_listings order by 1`);
    ok('anon sees only live published listings', live.map(r => r.product_name).join(',') === 'Bread,Sugar 2kg', JSON.stringify(live));
    ok('anon sees vendors with live listings', (await rows(`select business_name from vendors`)).length === 2);
    await expectErr('anon cannot read vendors.install_id', `select install_id from vendors`, /permission denied/);
    await expectErr('anon cannot insert listing', `insert into vendor_listings(vendor_id,product_name,price,exported_at) values ('${VA}','x',1,now())`, /permission denied/);
    await expectErr('anon cannot update listing', `update vendor_listings set price=0`, /permission denied/);
    await expectErr('anon cannot create customer', `insert into customers(id,email) values ('${U1}','u1@itred-test.invalid')`, /permission denied/);
    await expectErr('anon cannot run sweep', `select itred_expire_vendor_listings()`, /permission denied/);

    console.log('customer u1');
    await as('authenticated', U1, 'u1@itred-test.invalid');
    await expectErr('authenticated cannot write listings', `update vendor_listings set price=0`, /permission denied/);
    await expectErr("profile with someone else's email rejected", `insert into customers(id,email) values ('${U1}','u2@itred-test.invalid')`, /row-level security/);
    await expectErr('profile for another uid rejected', `insert into customers(id,email) values ('${U2}','u1@itred-test.invalid')`, /row-level security/);
    await db.q(`insert into customers(id,email,full_name) values ($1,'U1@itred-test.invalid','Tendai')`, [U1]); ok('own profile created', true);
    const po = (await rows(`insert into purchase_orders(customer_id,vendor_id) values ($1,$2) returning id, status`, [U1, VA]))[0];
    ok('PO created with status sent', po.status === 'sent');
    await expectErr('customer cannot set PO status on insert', `insert into purchase_orders(customer_id,vendor_id,status) values ('${U1}','${VA}','fulfilled')`, /permission denied/);
    await expectErr('customer cannot set pdf_url', `update purchase_orders set pdf_url='x' where id='${po.id}'`, /permission denied/);
    const it = (await rows(`insert into purchase_order_items(purchase_order_id,vendor_listing_id,item_name,quantity_requested) values ($1,'a1000000-0000-4000-8000-000000000001','FREE STUFF',2) returning item_name,unit_price,currency,fulfillment_status`, [po.id]))[0];
    ok('listed item snapshots name/price', it.item_name === 'Sugar 2kg' && Number(it.unit_price) === 3.5 && it.currency === 'USD', JSON.stringify(it));
    ok('new item is outstanding', it.fulfillment_status === 'outstanding');
    const cu = (await rows(`insert into purchase_order_items(purchase_order_id,item_name,quantity_requested,is_custom_request) values ($1,'Cooking gas 9kg',1,true) returning unit_price,vendor_listing_id`, [po.id]))[0];
    ok('custom request allowed with null listing', cu.unit_price === null && cu.vendor_listing_id === null);
    await expectErr('custom request with a listing id rejected', `insert into purchase_order_items(purchase_order_id,vendor_listing_id,item_name,quantity_requested,is_custom_request) values ('${po.id}','a1000000-0000-4000-8000-000000000001','x',1,true)`, /custom_xor_listing/);
    await expectErr('non-custom line without listing rejected', `insert into purchase_order_items(purchase_order_id,item_name,quantity_requested) values ('${po.id}','x',1)`, /custom_xor_listing|not found/);
    await expectErr("other vendor's listing rejected", `insert into purchase_order_items(purchase_order_id,vendor_listing_id,item_name,quantity_requested) values ('${po.id}','b1000000-0000-4000-8000-000000000001','x',1)`, /row-level security/);
    await expectErr('expired listing rejected', `insert into purchase_order_items(purchase_order_id,vendor_listing_id,item_name,quantity_requested) values ('${po.id}','a3000000-0000-4000-8000-000000000003','x',1)`, /not found|row-level/);
    await expectErr('pending listing rejected', `insert into purchase_order_items(purchase_order_id,vendor_listing_id,item_name,quantity_requested) values ('${po.id}','a2000000-0000-4000-8000-000000000002','x',1)`, /not found|row-level/);
    await expectErr('customer cannot set quantity_fulfilled', `insert into purchase_order_items(purchase_order_id,item_name,quantity_requested,is_custom_request,quantity_fulfilled) values ('${po.id}','x',1,true,1)`, /permission denied/);
    await expectErr('customer cannot mark PO fulfilled', `update purchase_orders set status='fulfilled' where id='${po.id}'`, /row-level security/);

    console.log('fulfilment recorded by the customer');
    const LISTED = `purchase_order_id='${po.id}' and vendor_listing_id is not null`, CUSTOM = `purchase_order_id='${po.id}' and is_custom_request`;
    const poStatus = async () => (await rows(`select status from purchase_orders where id=$1`, [po.id]))[0].status;
    const lineStatus = async (where) => (await rows(`select fulfillment_status s from purchase_order_items where ${where}`))[0].s;
    await db.q(`update purchase_order_items set quantity_fulfilled=1 where ${LISTED}`);
    ok('customer records a partial line', await lineStatus(LISTED) === 'partially_fulfilled');
    ok('PO becomes partially_fulfilled', await poStatus() === 'partially_fulfilled');
    await db.q(`update purchase_order_items set quantity_fulfilled=2 where ${LISTED}`);
    ok('one line fully fulfilled, other outstanding -> still partially_fulfilled', await poStatus() === 'partially_fulfilled');
    await db.q(`update purchase_order_items set quantity_fulfilled=1 where ${CUSTOM}`);
    ok('every line fulfilled -> PO fulfilled', await poStatus() === 'fulfilled');
    await db.q(`update purchase_order_items set quantity_fulfilled=0 where purchase_order_id=$1`, [po.id]);
    ok('correcting back to nothing -> PO sent again', await poStatus() === 'sent');
    await expectErr('negative quantity_fulfilled rejected', `update purchase_order_items set quantity_fulfilled=-1 where ${LISTED}`, /check constraint/);
    await expectErr('quantity_fulfilled above the ordered quantity rejected', `update purchase_order_items set quantity_fulfilled=3 where ${LISTED}`, /not_overfulfilled/);
    await expectErr('customer cannot change quantity_requested', `update purchase_order_items set quantity_requested=9 where ${LISTED}`, /permission denied/);
    await expectErr('customer cannot change unit_price', `update purchase_order_items set unit_price=0 where ${LISTED}`, /permission denied/);
    await expectErr('customer cannot change item_name', `update purchase_order_items set item_name='x' where ${CUSTOM}`, /permission denied/);
    await expectErr('customer cannot move a line to another order', `update purchase_order_items set purchase_order_id=gen_random_uuid() where ${CUSTOM}`, /permission denied/);
    await expectErr('customer cannot call the status function', `select itred_po_sync_status()`, /permission denied|trigger functions/);

    console.log('customer u2');
    await as('authenticated', U2, 'u2@itred-test.invalid');
    await db.q(`insert into customers(id,email) values ($1,'u2@itred-test.invalid')`, [U2]);
    ok('u2 cannot see u1 profile', (await rows(`select * from customers`)).length === 1);
    ok('u2 cannot see u1 POs', (await rows(`select * from purchase_orders`)).length === 0);
    ok('u2 cannot see u1 items', (await rows(`select * from purchase_order_items`)).length === 0);
    await expectErr('u2 cannot create PO as u1', `insert into purchase_orders(customer_id,vendor_id) values ('${U1}','${VA}')`, /row-level security/);
    await expectErr('u2 cannot add items to u1 PO', `insert into purchase_order_items(purchase_order_id,item_name,quantity_requested,is_custom_request) values ('${po.id}','x',1,true)`, /row-level security/);
    ok('u2 cannot close u1 PO', (await rows(`update purchase_orders set status='closed' where id=$1 returning id`, [po.id])).length === 0);
    ok("u2 cannot record fulfilment on u1's lines", (await rows(`update purchase_order_items set quantity_fulfilled=1 where purchase_order_id=$1 returning id`, [po.id])).length === 0);
    // No WHERE/RETURNING, so only the UPDATE policy (not the SELECT one) decides.
    await db.q(`update purchase_order_items set quantity_fulfilled=1`);
    await as('postgres');
    ok("u1's lines untouched by u2", (await rows(`select sum(quantity_fulfilled)::int n from purchase_order_items where purchase_order_id=$1`, [po.id]))[0].n === 0);

    console.log('fulfilment (service_role)');
    await as('service_role');
    await db.q(`update purchase_order_items set quantity_fulfilled=1 where purchase_order_id=$1 and vendor_listing_id is not null`, [po.id]);
    ok('partial fulfilment derived', (await rows(`select fulfillment_status s from purchase_order_items where purchase_order_id=$1 and vendor_listing_id is not null`, [po.id]))[0].s === 'partially_fulfilled');
    await db.q(`update purchase_order_items set quantity_fulfilled=2 where purchase_order_id=$1 and vendor_listing_id is not null`, [po.id]);
    ok('full fulfilment derived', (await rows(`select fulfillment_status s from purchase_order_items where purchase_order_id=$1 and vendor_listing_id is not null`, [po.id]))[0].s === 'fulfilled');
    ok('service_role fulfilment also drives PO status', (await rows(`select status from purchase_orders where id=$1`, [po.id]))[0].status === 'partially_fulfilled');
    await expectErr('over-fulfilment rejected', `update purchase_order_items set quantity_fulfilled=3 where purchase_order_id='${po.id}' and vendor_listing_id is not null`, /not_overfulfilled/);
    await expectErr("listing on an order can't be deleted", `delete from vendor_listings where id='a1000000-0000-4000-8000-000000000001'`, /foreign key/);

    console.log('sweep + vendor visibility after expiry');
    await as('postgres');
    await db.q(`update vendor_listings set published_at = now() - interval '10 days' where vendor_id=$1 and status='published'`, [VA]);
    ok('sweep expires past-due listings', (await rows(`select itred_expire_vendor_listings() n`))[0].n === 2);
    await as('anon');
    ok('anon no longer sees vendor A', (await rows(`select id from vendors where id=$1`, [VA])).length === 0);
    await as('authenticated', U1, 'u1@itred-test.invalid');
    ok('u1 still sees vendor A via their order', (await rows(`select id, business_name from vendors where id=$1`, [VA])).length === 1);
    await db.q(`update purchase_orders set status='closed' where id=$1`, [po.id]); ok('u1 can close own partially fulfilled PO', true);
    await db.q(`update purchase_order_items set quantity_fulfilled=1 where purchase_order_id=$1 and is_custom_request`, [po.id]);
    ok('fulfilment recorded after closing leaves the PO closed', (await rows(`select status from purchase_orders where id=$1`, [po.id]))[0].status === 'closed');
    await expectErr('no items added after close', `insert into purchase_order_items(purchase_order_id,item_name,quantity_requested,is_custom_request) values ('${po.id}','x',1,true)`, /row-level security/);
    await expectErr('no reopening a closed PO', `update purchase_orders set status='sent' where id='${po.id}'`, /row-level security/);
  } catch (e) {
    fail++; console.log('  FATAL ' + e.message);
  } finally {
    await db.q('rollback');
  }

  // Prove nothing persisted.
  const left = await db.q(`select
      (select count(*)::int from public.cl_vendors where install_id like 'itred-test-%') cl,
      (select count(*)::int from auth.users where email like '%@itred-test.invalid') au,
      (select count(*)::int from public.vendors) v,
      (select count(*)::int from public.vendor_listings) vl,
      (select count(*)::int from public.customers where email like '%@itred-test.invalid') c,
      (select count(*)::int from public.purchase_orders) po,
      (select count(*)::int from public.purchase_order_items) poi`);
  console.log('\nrows left after rollback: ' + JSON.stringify(left[0]));
  console.log(`${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})();
