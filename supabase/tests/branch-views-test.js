// node supabase/tests/branch-views-test.js
//
// Tests supabase/migrations/20261106120000_branch_views.sql (and its
// rollback) in an in-memory PGlite built from the repo (the live shape),
// never the live database. Data is put in BEFORE the migration, as on live:
//   - the source branch of customers and suppliers: backfilled from the till
//     that added them (customers get a new change_seq, so the tills pull them
//     again), set on every new one, kept when another branch edits them;
//   - each till's own figure and the till list for EVERY caller (remotes too);
//   - the business's dispatches carry the internal refs and the transport;
//   - the DN card: header, transport (paid by the receiving branch), lines,
//     differences and how each was settled, the re-dispatch link, history;
//   - the item ledger: dispatched, received, the difference back, written
//     off, supplier GRVs; by catalogue uid, code or name; per branch; dates;
//   - NO unit cost, landed cost or inter-branch charge in anything a till gets;
//   - another business sees nothing; grants; a second run is refused; the
//     rollback restores the whole catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ, v21AdminSeed } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261106120000_branch_views.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261106120000_branch_views.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = () => crypto.randomBytes(16).toString('hex');
const uuid = () => crypto.randomUUID();

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261107120000_shop_roles.sql']) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const PH = { SO01: 'Solo Phrase' };
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
    await pg.exec('set role anon');
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  const auth = (iid) => ({ p_install_id: iid, p_secret_phrase: PH[iid] || 'Mandie Phrase', p_device_key: key(iid) });
  const call = async (iid, fn, args) => { const r = await anon(fn, { ...auth(iid), ...(args || {}) }); return r.e ? { raised: r.e } : r.j; };
  const code = async (iid, o) => { const s = v21AdminSeed('admin-pass-1'); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j.code; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 27 })).j;

  // ---- the business as it is on live before the migration ----
  let r = await anon('cl_branch_register', { ...auth('HA01'), p_business_name: 'Mandie Babyware', p_branch_name: 'Harare' });
  const HARARE = r.j.branch_id;
  ok('(Harare registers: T1)', r.j && r.j.till_code === 'T1', JSON.stringify(r));
  ok('(Harare T2 joins)', (await join('HA02', await code('HA01', { p_branch_id: HARARE }))).till_code === 'T2');
  const mj = await join('MU01', await code('HA01', { p_new_branch_name: 'Murehwa' }));
  const MUREHWA = mj.branch_id;
  ok('(Murehwa T1 joins)', mj && mj.till_code === 'T1', JSON.stringify(mj));
  await anon('cl_branch_register', { ...auth('SO01'), p_business_name: 'Solo Shop', p_branch_name: 'Mbare' });
  ok('(Solo Shop: another business, one till)', true);

  r = await call('MU01', 'cl_device_customer_save', { p_customer: { uid: 'cust-tendai-01', name: 'Tendai Moyo', phone: '0772 123 456' } });
  ok('(Murehwa adds Tendai)', r.ok, JSON.stringify(r));
  r = await call('HA01', 'cl_device_customer_save', { p_customer: { uid: 'cust-rudo-0001', name: 'Rudo Banda', phone: '0773 222 333' } });
  ok('(Harare adds Rudo)', r.ok, JSON.stringify(r));
  const SUP = uuid();
  r = await call('HA01', 'cl_device_supplier_save', { p_supplier: { id: SUP, name: 'Metro Wholesalers', phone: '0771 000 111' } });
  ok('(Harare adds a supplier)', r.ok, JSON.stringify(r));
  const seqBefore = (await q(`select customer_uid, change_seq from cl_customers order by change_seq`)).map((x) => [x.customer_uid, Number(x.change_seq)]);
  const cursorBefore = Math.max(...seqBefore.map((x) => x[1]));

  const BIB = hex(), CAP = hex();
  const D1 = uuid();
  r = await call('HA01', 'cl_device_dispatch_send', { p_dispatch: { id: D1, to_branch_id: MUREHWA, dn_no: 1, dn_display: 'DN-T1-0001', internal_ref: 'PO-778', sent_by: 'Boss',
    lines: [{ line_no: 1, cat_uid: BIB, code: 'BIB1', name: 'Bib', qty: 5, unit_cost: 3.21 }, { line_no: 2, cat_uid: CAP, code: 'CAP1', name: 'Cap', qty: 2, unit_cost: 1.11 }],
    delivery: { cost: 4.56, currency: 'USD', carrier: 'Swift Couriers', ref: 'WB-991' } } });
  ok('(Harare T1 sends DN-T1-0001 to Murehwa: 5 bibs, 2 caps, transport USD 4.56)', r.ok, JSON.stringify(r));
  r = await call('MU01', 'cl_device_grv_post', { p_dispatch_id: D1, p_grv: { grv_id: uuid(), grv_no: 1, grv_display: 'GRV-T1-0001', by: 'Tafadzwa', internal_ref: 'MU-IN-4',
    lines: [{ line_no: 1, received: 4, damaged: 0, extra: 0 }, { line_no: 2, received: 2, damaged: 0, extra: 1, note: 'one more in the box' }] } });
  ok('(Murehwa receives: 1 bib short, 1 cap extra)', r.ok && r.dispatch.status === 'received_diff', JSON.stringify(r).slice(0, 300));
  const shortIssue = r.dispatch.issues.find((i) => i.kind === 'short');
  r = await call('HA01', 'cl_device_dispatch_resolve', { p_issue_id: shortIssue.id, p_action: 'write_off', p_by: 'Boss', p_note: 'lost on the road', p_adj_display: 'ADJ-T1-0007' });
  ok('(Harare writes the short bib off as ADJ-T1-0007)', r.ok, JSON.stringify(r).slice(0, 300));
  r = await call('HA01', 'cl_device_supplier_grv_post', { p_grv: { id: uuid(), supplier_id: SUP, invoice_no: 'INV-55', grv_no: 2, grv_display: 'GRV-T1-0002', received_by: 'Boss',
    delivery: { cost: 9.87, currency: 'USD' }, lines: [{ cat_uid: BIB, code: 'BIB1', name: 'Bib', qty: 10, unit_cost: 2.22, landed_cost: 2.5 }] } });
  ok('(Harare receives 10 bibs from Metro, invoice INV-55)', r.ok, JSON.stringify(r).slice(0, 300));
  const D2 = uuid();
  r = await call('HA02', 'cl_device_dispatch_send', { p_dispatch: { id: D2, to_branch_id: MUREHWA, dn_no: 1, dn_display: 'DN-T2-0001', sent_by: 'Chipo', lines: [{ line_no: 1, code: 'BIB1', name: 'Bib', qty: 1 }] } });
  ok('(Harare T2 sends DN-T2-0001: 1 bib, no catalogue uid, by code)', r.ok, JSON.stringify(r));
  r = await call('HA02', 'cl_device_dispatch_cancel', { p_dispatch_id: D2, p_reason: 'wrong branch', p_by: 'Chipo' });
  ok('(... and cancels it)', r.ok, JSON.stringify(r).slice(0, 200));
  await q(`insert into cl_till_stock_levels (terminal_id, product_key, branch_id, cat_uid, code, name, qty, as_of)
           select t.id, $1, t.branch_id, $1, 'BIB1', 'Bib', v.qty, now() from cl_terminals t join (values ('HA01', 6), ('HA02', 3), ('MU01', 4)) v(iid, qty) on v.iid = t.install_id`, [BIB]);
  await q(`insert into cl_till_stock_push (terminal_id, branch_id, as_of, products) select id, branch_id, now(), 1 from cl_terminals where install_id in ('HA01', 'HA02', 'MU01')`);

  // ---- the migration ----
  r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('it applies on a business that already has customers, a supplier and dispatches', r.ok, r.e);

  // source branch (§R6)
  const src = async () => Object.fromEntries((await q(`select c.customer_uid u, b.name from cl_customers c left join cl_branches b on b.id = c.created_branch_id`)).map((x) => [x.u, x.name]));
  ok('backfill: Tendai was added at Murehwa, Rudo at Harare', JSON.stringify(await src()) === JSON.stringify({ 'cust-tendai-01': 'Murehwa', 'cust-rudo-0001': 'Harare' }), JSON.stringify(await src()));
  const seqAfter = (await q(`select customer_uid, change_seq from cl_customers order by change_seq`)).map((x) => [x.customer_uid, Number(x.change_seq)]);
  ok('... with new change_seq numbers above the old cursor, in their old order', seqAfter.every((x) => x[1] > cursorBefore) && seqAfter.map((x) => x[0]).join() === seqBefore.map((x) => x[0]).join(), JSON.stringify(seqAfter));
  r = await call('HA02', 'cl_device_customers_pull', { p_cursor: cursorBefore });
  ok('a till that had pulled them all gets both again, each with its source branch', r.customers.length === 2 &&
    r.customers.find((c) => c.uid === 'cust-tendai-01').source_branch === 'Murehwa' && r.customers.find((c) => c.uid === 'cust-tendai-01').source_branch_id === MUREHWA &&
    r.customers.find((c) => c.uid === 'cust-rudo-0001').source_branch === 'Harare', JSON.stringify(r).slice(0, 500));
  r = await call('MU01', 'cl_device_customer_save', { p_customer: { uid: 'cust-farai-001', name: 'Farai Dube', phone: '0774 555 666' } });
  ok('a new customer gets its till\'s branch at once', r.ok && r.customer.source_branch === 'Murehwa', JSON.stringify(r));
  r = await call('HA01', 'cl_device_customer_save', { p_customer: { uid: 'cust-tendai-01', name: 'Tendai Moyo', phone: '0772 123 456', customer_type: 'wholesale' } });
  ok('Harare edits Tendai: still "added at Murehwa"', r.ok && r.customer.source_branch === 'Murehwa' && r.customer.customer_type === 'wholesale', JSON.stringify(r));
  r = await call('MU01', 'cl_device_suppliers_pull');
  ok('suppliers carry their source branch too (any till pulls them)', r.suppliers.length === 1 && r.suppliers[0].source_branch === 'Harare' && r.suppliers[0].source_branch_id === HARARE, JSON.stringify(r).slice(0, 300));
  const SUP2 = uuid();
  r = await call('HA02', 'cl_device_supplier_save', { p_supplier: { id: SUP2, name: 'Farm Fresh' } });
  ok('a new supplier gets its till\'s branch', r.ok && r.supplier.source_branch === 'Harare', JSON.stringify(r));
  r = await call('SO01', 'cl_device_customers_pull', { p_cursor: 0 });
  ok('another business pulls none of them', r.customers.length === 0, JSON.stringify(r));

  // per-till figures for everyone (§R5)
  r = await call('MU01', 'cl_device_branch_stock');
  const hR = (r.branches || []).find((b) => b.id === HARARE);
  const bibR = hR && hR.rows.find((x) => x.k === BIB);
  ok('a remote till now gets each Harare till\'s own figure (T1 6, T2 3 = 9)', r.is_main === false && bibR && bibR.qty === 9 && bibR.t.T1 === 6 && bibR.t.T2 === 3, JSON.stringify(hR).slice(0, 400));
  ok('... and Harare\'s till list with their times', hR.tills.length === 2 && hR.tills.every((t) => t.till_code && 'pushed_at' in t), JSON.stringify(hR.tills));
  r = await call('HA01', 'cl_device_branch_stock');
  ok('main still gets them', (r.branches || []).find((b) => b.id === MUREHWA).rows.find((x) => x.k === BIB).t.T1 === 4);

  // the dispatches list (§R2)
  r = await call('MU01', 'cl_device_business_dispatches');
  const d1 = r.dispatches.find((d) => d.id === D1);
  ok('the business\'s dispatches now carry the internal refs and the transport', d1.internal_ref === 'PO-778' && d1.grv_internal_ref === 'MU-IN-4' &&
    Number(d1.delivery_cost) === 4.56 && d1.delivery_currency === 'USD' && d1.carrier === 'Swift Couriers' && d1.delivery_ref === 'WB-991', JSON.stringify(d1).slice(0, 500));

  // the DN card (§R3)
  const card = async (iid, id) => call(iid, 'cl_device_dispatch_card', { p_dispatch_id: id });
  r = await card('MU01', D1);
  ok('the DN card: header (number, branches, till, who, refs, GRV)', r.dn_display === 'DN-T1-0001' && r.from_branch === 'Harare' && r.to_branch === 'Murehwa' && r.from_till === 'T1' &&
    r.sent_by === 'Boss' && r.internal_ref === 'PO-778' && r.grv_display === 'GRV-T1-0001' && r.grv_till === 'T1' && r.grv_by === 'Tafadzwa' && r.grv_internal_ref === 'MU-IN-4' &&
    r.status === 'received_diff' && r.sent_at && r.received_at, JSON.stringify(r).slice(0, 600));
  ok('... the transport, paid by the receiving branch', Number(r.transport.cost) === 4.56 && r.transport.currency === 'USD' && r.transport.carrier === 'Swift Couriers' && r.transport.ref === 'WB-991' && r.transport.paid_by === 'receiving', JSON.stringify(r.transport));
  ok('... every line: sent, received, short, extra, the note', r.lines.length === 2 && r.lines[0].qty === 5 && r.lines[0].received === 4 && r.lines[0].short === 1 &&
    r.lines[1].extra === 1 && r.lines[1].note === 'one more in the box', JSON.stringify(r.lines));
  const iShort = r.issues.find((i) => i.kind === 'short'), iExtra = r.issues.find((i) => i.kind === 'extra');
  ok('... the differences and how each was settled', iShort.status === 'written_off' && iShort.adj_display === 'ADJ-T1-0007' && iShort.resolved_by === 'Boss' && iShort.resolved_till === 'T1' &&
    iShort.note === 'lost on the road' && iShort.name === 'Bib' && iExtra.status === 'open' && iExtra.name === 'Cap', JSON.stringify(r.issues));
  ok('... the history from seiGEN\'s log: sent, received, written off (who, till, branch)', r.history.map((h) => h.action).join() === 'sent,received,issue_written_off' &&
    r.history[0].till === 'T1' && r.history[0].branch === 'Harare' && r.history[1].branch === 'Murehwa' && r.history[2].adj === 'ADJ-T1-0007' && r.history[2].kind === 'short', JSON.stringify(r.history));
  ok('... "mine" only for the till that sent it', r.mine === false && (await card('HA01', D1)).mine === true && (await card('HA02', D1)).mine === false);
  const D3 = uuid();
  await call('HA01', 'cl_device_dispatch_resolve', { p_issue_id: iExtra.id, p_action: 'dispute', p_by: 'Boss', p_note: 'we sent 2' });
  r = await card('HA02', D2);
  ok('a cancelled DN: who cancelled it, when and why', r.status === 'cancelled' && r.cancelled_by === 'Chipo' && r.cancel_reason === 'wrong branch' && r.history.map((h) => h.action).join() === 'sent,cancelled', JSON.stringify(r).slice(0, 400));
  r = await call('SO01', 'cl_device_dispatch_card', { p_dispatch_id: D1 });
  ok('another business can\'t open it', r.error === 'NOT_FOUND', JSON.stringify(r));
  r = await card('MU01', D3);
  ok('an unknown DN: NOT_FOUND', r.error === 'NOT_FOUND', JSON.stringify(r));

  // the item ledger (§R3)
  const led = async (iid, a) => call(iid, 'cl_device_item_ledger', a);
  r = await led('MU01', { p_cat_uid: BIB, p_code: 'BIB1', p_name: 'Bib' });
  const kinds = (r.rows || []).map((x) => x.kind + ':' + x.branch + ':' + (x.qty_in - x.qty_out)).sort();
  ok('the bib\'s movements on seiGEN, newest first, at every branch (by catalogue uid; the uid-less DN by its code)',
    JSON.stringify(kinds) === JSON.stringify(['dispatch_cancel:Harare:1', 'dispatch_out:Harare:-1', 'dispatch_out:Harare:-5', 'dispatch_return:Harare:1', 'receive:Murehwa:4', 'supplier_grv:Harare:10', 'write_off:Harare:-1']), JSON.stringify(kinds));
  ok('... each with its document, till, person and note', (() => {
    const g = (k) => r.rows.find((x) => x.kind === k);
    return g('receive').doc === 'GRV-T1-0001' && g('receive').other_branch === 'Harare' && g('receive').by === 'Tafadzwa' && /DN-T1-0001/.test(g('receive').note) &&
      g('write_off').doc === 'ADJ-T1-0007' && g('write_off').till === 'T1' && g('supplier_grv').note === 'Metro Wholesalers, invoice INV-55' &&
      g('dispatch_cancel').till === 'T2' && g('dispatch_cancel').note === 'wrong branch';
  })(), JSON.stringify(r.rows).slice(0, 800));
  ok('... sorted newest first', r.rows.every((x, i, a) => i === 0 || Date.parse(a[i - 1].at) >= Date.parse(x.at)));
  ok('... "mine" marks the caller\'s own rows', r.rows.every((x) => x.mine === (x.kind === 'receive')));
  r = await led('HA01', { p_cat_uid: BIB, p_branch_id: MUREHWA });
  ok('one branch only: Murehwa received 4', r.rows.length === 1 && r.rows[0].kind === 'receive' && r.rows[0].qty_in === 4, JSON.stringify(r.rows));
  r = await led('HA01', { p_code: 'cap1' });
  ok('by code (any case): the cap went out 2 and arrived 2 + 1 extra', JSON.stringify(r.rows.map((x) => x.kind + ':' + x.qty_in + ':' + x.qty_out).sort()) === JSON.stringify(['dispatch_out:0:2', 'receive:3:0']), JSON.stringify(r.rows));
  r = await led('HA01', { p_name: ' bib ' });
  ok('by name when there is no code (no code given: names match)', r.rows.length === 7, JSON.stringify(r.rows.length));
  r = await led('HA01', { p_cat_uid: hex(), p_code: 'BIB1' });
  ok('another catalogue product with the same code is another product (only the uid-less DN-T2 lines match)', r.rows.every((x) => x.doc === 'DN-T2-0001'), JSON.stringify(r.rows));
  r = await led('HA01', { p_cat_uid: BIB, p_from: new Date(Date.now() + 3600e3).toISOString() });
  ok('a date range', r.rows.length === 0);
  r = await led('HA01', {});
  ok('no product: refused', /which product/.test(r.raised || ''), JSON.stringify(r));
  r = await led('SO01', { p_cat_uid: BIB, p_code: 'BIB1', p_name: 'Bib' });
  ok('another business sees none of it', r.rows.length === 0, JSON.stringify(r));
  r = await led('SO01', { p_cat_uid: BIB, p_branch_id: HARARE });
  ok('... and can\'t ask for its branch', r.error === 'NOT_FOUND', JSON.stringify(r));

  // never a cost (3.21 / 1.11 unit cost, 2.22 / 2.5 GRV costs, 9.87 GRV delivery)
  const everything = JSON.stringify([await card('MU01', D1), await card('HA01', D1), await led('MU01', { p_cat_uid: BIB }), await led('HA01', { p_code: 'CAP1' }),
    await call('MU01', 'cl_device_business_dispatches'), await call('MU01', 'cl_device_branch_stock')]);
  ok('no unit cost, landed cost, supplier price or inter-branch charge anywhere', !/unit_cost|landed|charge|3\.21|1\.11|2\.22|"2\.5"|9\.87/i.test(everything), everything.slice(0, 300));

  // grants
  const can = async (role, fn) => (await q(`select has_function_privilege($1, $2, 'execute') x`, [role, fn]))[0].x;
  ok('devices (anon) may call the DN card and the item ledger',
    await can('anon', 'public.cl_device_dispatch_card(text,text,text,uuid)') && await can('anon', 'public.cl_device_item_ledger(text,text,text,text,text,text,uuid,timestamptz,timestamptz)'));
  ok('the helpers are internal', !(await can('anon', 'public.cl_ledger_line_match(text,text,text,text,text,text)')) && !(await can('authenticated', 'public.cl_source_branch_fill()')) &&
    !(await can('anon', 'public.cl_customer_json(public.cl_customers)')) && !(await can('anon', 'public.cl_supplier_json(public.cl_suppliers)')));

  r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('a second run is refused and changes nothing', /already exists/.test(r.e || ''), r.e);

  r = await (async () => { try { await pg.exec(RB); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('the rollback applies', r.ok, r.e);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  r = await call('MU01', 'cl_device_customers_pull', { p_cursor: 0 });
  ok('... and the tills still pull their customers (as before: no source branch)', r.customers.length === 3 && !('source_branch' in r.customers[0]), JSON.stringify(r).slice(0, 300));
  r = await call('MU01', 'cl_device_branch_stock');
  ok('... and a remote is back to branch totals only', (r.branches || []).find((b) => b.id === HARARE).tills === null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
