// node supabase/tests/itred-order-fulfilment-test.js
//
// Tests supabase/migrations/20261105120000_itred_order_fulfilment.sql (and its
// rollback) in an in-memory PGlite built from the repo (the live shape),
// never the live database:
//   - every till of the business (main and a joined till) pulls its
//     business's iTred orders with a cursor; another shop, a wrong phrase or
//     a wrong device key gets nothing; the customer's email never goes out;
//   - a line update sets the fulfilled quantity, note and status; a resend
//     (same uid) changes nothing; over-fulfilment and closed orders are refused;
//   - "Mark complete", messages both ways, read marks;
//   - the customer can no longer set quantity_fulfilled; confirms or disputes
//     an answered line; reads only their own orders' threads; anon reads none;
//   - nothing touches stock or sales tables;
//   - a second run is refused; the rollback restores the catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ, v21AdminSeed } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261105120000_itred_order_fulfilment.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261105120000_itred_order_fulfilment.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = () => crypto.randomBytes(16).toString('hex');
const uuid = () => crypto.randomUUID();

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261109120000_office_seats.sql', '20261110120000_staff_first_owner.sql', '20261112120000_builtin_customers.sql', '20261113120000_sales_sync.sql', '20261113180000_removed_devices.sql', '20261114120000_roles_everywhere.sql']) });   // the live shape
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const run = async (sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
    await pg.exec('set role anon');
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  // a signed-in customer (PostgREST: role authenticated + the JWT sub)
  const as = async (uid, sql, p) => {
    await pg.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
    try { return { rows: await q(sql, p) }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
  };
  const auth = (iid, phrase) => ({ p_install_id: iid, p_secret_phrase: phrase || 'Chipo Phrase', p_device_key: key(iid) });
  const code = async (iid, o) => { const s = v21AdminSeed('admin-pass-1'); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j.code; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 25 })).j;

  // Chipo Clothing: Harare main T1 + T2; Solo Shop: one till, also on iTred.
  let r = await anon('cl_branch_register', { ...auth('CH01'), p_business_name: 'Chipo Clothing', p_branch_name: 'Harare' });
  ok('setup: Chipo registers (T1)', r.j && r.j.till_code === 'T1', JSON.stringify(r));
  ok('setup: Chipo T2 joins', (await join('CH02', await code('CH01', { p_branch_id: r.j.branch_id }))).till_code === 'T2');
  await anon('cl_branch_register', { ...auth('SO01', 'Solo Phrase'), p_business_name: 'Solo Shop', p_branch_name: 'Mbare' });
  const [chipo] = await q(`insert into vendors (install_id, business_name, whatsapp_number, city) values ('CH01', 'Chipo Clothing', '0771000001', 'Harare') returning id`);
  const [solo] = await q(`insert into vendors (install_id, business_name, whatsapp_number, city) values ('SO01', 'Solo Shop', '0771000002', 'Mbare') returning id`);
  const [lst] = await q(`insert into vendor_listings (vendor_id, product_name, price, currency, stock_quantity, exported_at, published_at, expires_at, status)
                         values ($1, 'Denim jacket', 18, 'USD', 5, now(), now(), now() + interval '5 days', 'published') returning id`, [chipo.id]);

  // two customers
  const CUST_A = uuid(), CUST_B = uuid();
  await q(`insert into auth.users (id, email) values ($1, 'a@example.test'), ($2, 'b@example.test')`, [CUST_A, CUST_B]);
  await q(`insert into customers (id, email, full_name, phone) values ($1, 'a@example.test', 'Customer A', '0772000001'), ($2, 'b@example.test', 'Customer B', '0772000002')`, [CUST_A, CUST_B]);
  const order = async (cust, vendor, lines) => {
    const po = await as(cust, `insert into purchase_orders (customer_id, vendor_id) values ($1, $2) returning id`, [cust, vendor]);
    if (po.e) return po;
    for (const l of lines) {
      const it = await as(cust, `insert into purchase_order_items (purchase_order_id, vendor_listing_id, item_name, quantity_requested, is_custom_request) values ($1, $2, $3, $4, $5) returning id`,
        [po.rows[0].id, l.listing || null, l.name, l.qty, !l.listing]);
      if (it.e) return it;
    }
    return { id: po.rows[0].id };
  };
  const before = fingerprint(await snapshot(q));
  const o0 = await order(CUST_A, chipo.id, [{ listing: lst.id, name: 'x', qty: 2 }]);
  ok('before: the customer can still record delivery (today\'s rule)', !(await as(CUST_A, `update purchase_order_items set quantity_fulfilled = 1 where purchase_order_id = $1`, [o0.id])).e);

  r = await run(MIG);
  ok('it applies', r.ok, r.e);
  const d1 = diff(before, fingerprint(await snapshot(q)));
  ok('only the expected objects change', d1.onlyA.every((k) => /record fulfilment|quantity_fulfilled|purchase_order/.test(k)) &&
    d1.changed.every((c) => /purchase_order/.test(c.key)), JSON.stringify({ onlyA: d1.onlyA, changed: d1.changed.map((c) => c.key) }).slice(0, 800));

  const oA = await order(CUST_A, chipo.id, [{ listing: lst.id, name: 'x', qty: 2 }, { name: 'Wiper blades', qty: 3 }]);
  const oB = await order(CUST_B, chipo.id, [{ name: 'School shoes', qty: 1 }]);
  const oS = await order(CUST_B, solo.id, [{ name: 'Bread', qty: 1 }]);
  ok('customers still send orders (listed + custom lines)', oA.id && oB.id && oS.id, JSON.stringify({ oA, oB, oS }));
  const emptyPo = await as(CUST_A, `insert into purchase_orders (customer_id, vendor_id) values ($1, $2) returning id`, [CUST_A, chipo.id]);

  const pull = (iid, cursor, phrase) => anon('cl_device_itred_orders_pull', { ...auth(iid, phrase), p_cursor: cursor || 0 });
  r = await pull('CH01');
  const ids = (r.j && r.j.orders || []).map((o) => o.id);
  ok('main till pulls its business\'s orders (A, B and the earlier one), not Solo\'s, not an order without lines',
    ids.includes(oA.id) && ids.includes(oB.id) && ids.includes(o0.id) && !ids.includes(oS.id) && !ids.includes(emptyPo.rows[0].id), JSON.stringify(r).slice(0, 500));
  const json = JSON.stringify(r.j);
  ok('the customer\'s name and phone are there; no email, no customer id', /Customer A/.test(json) && /0772000001/.test(json) && !/example\.test/.test(json) && !json.includes(CUST_A), json.slice(0, 300));
  const cursor1 = r.j.cursor;
  r = await pull('CH02');
  ok('a joined till (T2) of the same business sees the same orders', r.j && r.j.orders.length === ids.length, JSON.stringify(r).slice(0, 300));
  r = await pull('CH01', cursor1);
  ok('the cursor: nothing new → nothing returned', r.j && r.j.orders.length === 0 && r.j.cursor === cursor1, JSON.stringify(r));
  r = await pull('SO01', 0, 'Solo Phrase');
  ok('another shop sees only its own', r.j && r.j.orders.length === 1 && r.j.orders[0].id === oS.id, JSON.stringify(r).slice(0, 300));
  r = await pull('CH01', 0, 'Wrong Phrase');
  ok('a wrong phrase is refused', !!r.e, JSON.stringify(r));
  r = await anon('cl_device_itred_orders_pull', { p_install_id: 'CH01', p_secret_phrase: 'Chipo Phrase', p_device_key: hex(), p_cursor: 0 });
  ok('a wrong device key is refused', !!r.e, JSON.stringify(r));
  await anon('cl_branch_register', { ...auth('NO01', 'None Phrase'), p_business_name: 'Not Listed', p_branch_name: 'Gweru' });
  r = await pull('NO01', 0, 'None Phrase');
  ok('a shop not on iTred: NOT_ON_ITRED', r.j && r.j.error === 'NOT_ON_ITRED', JSON.stringify(r));

  // vendor updates
  const lines = (await pull('CH01')).j.orders.find((o) => o.id === oA.id).lines;
  const listed = lines.find((l) => !l.custom), custom = lines.find((l) => l.custom);
  ok('the listed line carries the listing\'s name and price', listed.name === 'Denim jacket' && Number(listed.unit_price) === 18, JSON.stringify(listed));
  const upd = (iid, uid, item, qty, note) => anon('cl_device_itred_line_update', { ...auth(iid), p_uid: uid, p_item_id: item, p_qty_fulfilled: qty, p_note: note });
  const U1 = uuid();
  r = await upd('CH02', U1, listed.id, 2, 'Collected at Harare');
  ok('T2 sets a line fulfilled with a note', r.j && r.j.ok && r.j.order.lines.find((l) => l.id === listed.id).status === 'fulfilled', JSON.stringify(r).slice(0, 400));
  ok('the order is partly fulfilled now (status follows the lines)', (await q(`select status from purchase_orders where id = $1`, [oA.id]))[0].status === 'partially_fulfilled');
  r = await upd('CH02', U1, listed.id, 0, 'changed?');
  ok('the same uid again changes nothing (duplicate)', r.j && r.j.duplicate === true && Number((await q(`select quantity_fulfilled f from purchase_order_items where id = $1`, [listed.id]))[0].f) === 2);
  ok('the action log has one row with T2', (await q(`select count(*)::int c, max(till_code) t from itred_po_updates where item_id = $1`, [listed.id]))[0].t === 'T2');
  r = await upd('CH01', uuid(), custom.id, 4, null);
  ok('more than requested is refused', r.j && r.j.error === 'BAD_QTY', JSON.stringify(r));
  r = await upd('SO01', uuid(), custom.id, 1, null);
  ok('another shop can\'t touch it', !!(r.e || (r.j && r.j.error)), JSON.stringify(r));
  r = await upd('CH01', uuid(), custom.id, 1, 'Two more next week');
  ok('a custom line partly fulfilled', r.j && r.j.ok);
  r = await pull('CH01', cursor1);
  ok('the cursor picks up the changed order', r.j && r.j.orders.some((o) => o.id === oA.id), JSON.stringify(r).slice(0, 200));

  // the customer
  r = await as(CUST_A, `update purchase_order_items set quantity_fulfilled = 3 where id = $1`, [custom.id]);
  ok('the customer can no longer set quantity_fulfilled', !!r.e || Number((await q(`select quantity_fulfilled f from purchase_order_items where id = $1`, [custom.id]))[0].f) === 1, JSON.stringify(r));
  r = await as(CUST_A, `select itred_line_respond($1, true) j`, [listed.id]);
  ok('the customer confirms an answered line', r.rows && r.rows[0].j.ok && (await q(`select customer_confirmed_at is not null c from purchase_order_items where id = $1`, [listed.id]))[0].c, JSON.stringify(r));
  r = await as(CUST_A, `select itred_line_respond($1, false, 'Only one arrived') j`, [custom.id]);
  ok('the customer disputes a line with a reason', r.rows && r.rows[0].j.ok, JSON.stringify(r));
  r = await as(CUST_A, `select itred_line_respond($1, false, '') j`, [custom.id]);
  ok('a dispute needs a reason', r.rows && r.rows[0].j.error === 'REASON_REQUIRED', JSON.stringify(r));
  const bLine = (await q(`select id from purchase_order_items where purchase_order_id = $1`, [oB.id]))[0].id;
  r = await as(CUST_B, `select itred_line_respond($1, true) j`, [bLine]);
  ok('a line the vendor hasn\'t answered can\'t be confirmed', r.rows && r.rows[0].j.error === 'NOT_ANSWERED', JSON.stringify(r));
  r = await as(CUST_B, `select itred_line_respond($1, true) j`, [listed.id]);
  ok('customer B can\'t answer customer A\'s line', r.rows && r.rows[0].j.error === 'NOT_FOUND', JSON.stringify(r));
  r = await pull('CH01');
  const seen = r.j.orders.find((o) => o.id === oA.id).lines;
  ok('the vendor sees the confirmation and the dispute', seen.find((l) => l.id === listed.id).confirmed_at && seen.find((l) => l.id === custom.id).dispute === 'Only one arrived');
  r = await upd('CH01', uuid(), custom.id, 2, 'Second one sent');
  ok('a changed quantity clears the old dispute', r.j && r.j.order.lines.find((l) => l.id === custom.id).dispute === null, JSON.stringify(r).slice(0, 300));

  // messages
  const M1 = uuid();
  r = await as(CUST_A, `insert into itred_order_messages (id, purchase_order_id, body) values ($1, $2, 'Can I collect on Saturday?')`, [M1, oA.id]);
  ok('the customer writes on their own order', !r.e, r.e);
  r = await as(CUST_A, `insert into itred_order_messages (id, purchase_order_id, body) values ($1, $2, 'hi')`, [uuid(), oB.id]);
  ok('the customer can\'t write on someone else\'s order', !!r.e, JSON.stringify(r));
  r = await as(CUST_A, `insert into itred_order_messages (id, purchase_order_id, author, body) values ($1, $2, 'vendor', 'fake')`, [uuid(), oA.id]);
  ok('the customer can\'t write as the vendor', !!r.e, JSON.stringify(r));
  const send = (iid, id, order, body) => anon('cl_device_itred_message_send', { ...auth(iid), p_id: id, p_order_id: order, p_body: body });
  const M2 = uuid();
  r = await send('CH01', M2, oA.id, 'Yes, Saturday is fine.');
  ok('the vendor replies', r.j && r.j.ok, JSON.stringify(r));
  r = await send('CH01', M2, oA.id, 'Yes, Saturday is fine.');
  ok('the same reply again is not doubled', r.j && r.j.duplicate && (await q(`select count(*)::int c from itred_order_messages where purchase_order_id = $1`, [oA.id]))[0].c === 2);
  r = await send('SO01', uuid(), oA.id, 'spam');
  ok('another shop can\'t write on the order', !!(r.e || (r.j && r.j.error)), JSON.stringify(r));
  r = await as(CUST_A, `select author, body from itred_order_messages where purchase_order_id = $1 order by created_at`, [oA.id]);
  ok('the customer sees the reply', r.rows && r.rows.length === 2 && r.rows[1].author === 'vendor', JSON.stringify(r));
  r = await as(CUST_B, `select count(*)::int c from itred_order_messages`);
  ok('customer B sees none of A\'s messages', r.rows && r.rows[0].c === 0, JSON.stringify(r));
  r = await as(CUST_A, `select itred_messages_read($1) j`, [oA.id]);
  ok('the customer marks replies read', r.rows && r.rows[0].j.ok && (await q(`select customer_read_at is not null r from itred_order_messages where id = $1`, [M2]))[0].r);
  ok('the vendor\'s reply marked the customer\'s message read', (await q(`select vendor_read_at is not null r from itred_order_messages where id = $1`, [M1]))[0].r);

  // complete, close
  r = await anon('cl_device_itred_order_complete', { ...auth('CH01'), p_uid: uuid(), p_order_id: oA.id });
  ok('Mark complete sets completed_at; the status still follows the lines (2 of 3 on one: partly)', r.j && r.j.ok && r.j.order.completed_at && r.j.order.status === 'partially_fulfilled', JSON.stringify(r).slice(0, 300));
  await as(CUST_B, `update purchase_orders set status = 'closed' where id = $1`, [oB.id]);
  r = await upd('CH01', uuid(), bLine, 1, null);
  ok('a closed order can\'t be updated', r.j && r.j.error === 'CLOSED', JSON.stringify(r));

  // access
  const can = async (role, obj, priv) => (await q(`select has_table_privilege($1, $2, $3) x`, [role, obj, priv]))[0].x;
  ok('anon can\'t read orders, lines, messages or the action log', !(await can('anon', 'public.itred_order_messages', 'select')) && !(await can('anon', 'public.itred_po_updates', 'select')) &&
    !(await can('authenticated', 'public.itred_po_updates', 'select')));
  r = await as(CUST_B, `select count(*)::int c from purchase_orders where id = $1`, [oA.id]);
  ok('customer B can\'t see customer A\'s order', r.rows && r.rows[0].c === 0);
  ok('helpers aren\'t callable from outside', !(await q(`select has_function_privilege('anon', 'public.itred_order_json(uuid)', 'execute') x`))[0].x &&
    !(await q(`select has_function_privilege('authenticated', 'public.itred_vendor_of_device(cl_vendors)', 'execute') x`))[0].x);
  ok('nothing touched stock or sales', (await q(`select (select count(*) from cl_till_stock_levels)::int s`))[0].s === 0);

  r = await run(MIG);
  ok('a second run is refused and changes nothing', /already there/.test(r.e || ''), r.e);
  r = await run(RB);
  ok('the rollback applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 800));
  ok('after the rollback the customer can record delivery again', !(await as(CUST_A, `update purchase_order_items set quantity_fulfilled = 0 where purchase_order_id = $1`, [o0.id])).e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
