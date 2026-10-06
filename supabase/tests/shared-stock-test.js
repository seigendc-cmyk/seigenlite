// node supabase/tests/shared-stock-test.js
//
// Tests supabase/migrations/20261007120000_shared_stock.sql (and its
// rollback) in an in-memory PGlite — never against the live database. The
// database is first brought to the live state: the shared live stub, then
// Phase 1, Phase 2 and Phase 3a.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LIVE_STUB } = require('./live-stub');

const ROOT = path.join(__dirname, '..');
const READ = (f) => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const P1 = READ('migrations/20261004120000_multi_terminal_identity.sql');
const P2 = READ('migrations/20261004180000_multi_terminal_phase2.sql');
const P3A = READ('migrations/20261006120000_catalogue_sync.sql');
const MIG = READ('migrations/20261007120000_shared_stock.sql');
const RB = READ('rollbacks/20261007120000_shared_stock.rollback.sql');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}
const hex = () => crypto.randomBytes(16).toString('hex');

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const q0 = async (pg, sql, p) => (await pg.query(sql, p)).rows;
  async function liveDb() {
    const pg = new PGlite({ extensions: { pgcrypto } });
    await pg.exec(LIVE_STUB); await pg.exec(P1); await pg.exec(P2); await pg.exec(P3A);
    return pg;
  }
  const pg = await liveDb();
  const q = (sql, p) => q0(pg, sql, p);
  async function anon(sql, p) {
    await pg.exec('set role anon');
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  }
  const dev = async (sql, p) => { const x = await anon(sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };

  // ---- live-like state: main branch Harare with T1, T2, T3; remote Murehwa with a single T1 ----
  const reg = await dev(`select public.cl_branch_register('MAIN0001','Biz Phrase','K-1','Gentronix','Harare','B-ABCD2345','Front') j`);
  const issue = async (o) => dev(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN0001',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-1',p_branch_id=>$1::uuid,p_new_branch_name=>$2) j`, [o.branch || null, o.name || null]);
  const t2 = await dev(`select public.cl_terminal_join('TILL0002','Biz Phrase','K-2',$1) j`, [(await issue({ branch: reg.branch_id })).code]);
  const t3 = await dev(`select public.cl_terminal_join('TILL0003','Biz Phrase','K-3',$1) j`, [(await issue({ branch: reg.branch_id })).code]);
  const rm = await dev(`select public.cl_terminal_join('REMOTE01','Biz Phrase','K-R',$1) j`, [(await issue({ name: 'Murehwa' })).code]);
  const W = { t1: ['MAIN0001', 'Biz Phrase', 'K-1'], t2: ['TILL0002', 'Biz Phrase', 'K-2'], t3: ['TILL0003', 'Biz Phrase', 'K-3'], rm: ['REMOTE01', 'Biz Phrase', 'K-R'] };
  // the catalogue (Phase 3a)
  const P = { rice: hex(), sugar: hex(), salt: hex(), oil: hex() };
  await dev(`select public.cl_catalogue_push('MAIN0001','Biz Phrase','K-1',$1::jsonb) j`, [JSON.stringify(Object.entries(P).map(([k, uid]) => ({ uid, op_id: hex(), code: k.toUpperCase(), name: k, price: 1 })))]);
  ok('setup: Harare (T1, T2, T3), Murehwa (T1), 4 catalogue products', t2.till_code === 'T2' && t3.till_code === 'T3' && rm.till_code === 'T1');

  const sync = (w, c) => dev(`select public.cl_stock_sync($1,$2,$3,$4) j`, [...w, c || 0]);
  const start = (w, op, rows) => dev(`select public.cl_stock_start_shared($1,$2,$3,$4,$5::jsonb) j`, [...w, op, JSON.stringify(rows)]);
  const sale = (w, uid, lines) => dev(`select public.cl_stock_sale($1,$2,$3,$4,$5::jsonb) j`, [...w, uid, JSON.stringify(lines)]);
  const move = (w, moves) => dev(`select public.cl_stock_move($1,$2,$3,$4::jsonb) j`, [...w, JSON.stringify(moves)]);
  const report = (w, sales, moves) => dev(`select public.cl_stock_report($1,$2,$3,$4::jsonb,$5::jsonb) j`, [...w, JSON.stringify(sales || []), JSON.stringify(moves || [])]);
  const take = (w, op, counts) => dev(`select public.cl_stock_stocktake($1,$2,$3,$4,$5::jsonb) j`, [...w, op, JSON.stringify(counts)]);
  const bal = (w) => dev(`select public.cl_stock_balance($1,$2,$3) j`, [...w]);
  const row = async (p) => (await q(`select total, available from cl_branch_stock where branch_id=$1 and product_uid=$2`, [reg.branch_id, p]))[0];
  const allow = async (term, p) => ((await q(`select qty from cl_till_allowance where terminal_id=$1 and product_uid=$2`, [term, p]))[0] || { qty: 0 }).qty;
  const balanced = async () => (await q(`select bool_and(bs.total = bs.available + coalesce((select sum(qty) from cl_till_allowance a where a.branch_id=bs.branch_id and a.product_uid=bs.product_uid),0)) b from cl_branch_stock bs`))[0].b !== false;
  const never_negative = async () => (await q(`select (select count(*) from cl_branch_stock where total<0 or available<0) + (select count(*) from cl_till_allowance where qty<0) n`))[0].n == 0;

  // ---- preflight ----
  {
    const other = await liveDb();
    await other.exec(MIG);
    let e = null; try { await other.exec(MIG); } catch (x) { e = x.message; await other.exec('rollback'); }
    ok('applying twice aborts in the preflight', /already exists: .*cl_branch_stock/.test(e || ''), e);
    await other.close();
    const bare = new PGlite({ extensions: { pgcrypto } });
    await bare.exec(LIVE_STUB); await bare.exec(P1); await bare.exec(P2);
    e = null; try { await bare.exec(MIG); } catch (x) { e = x.message; await bare.exec('rollback'); }
    ok('without Phase 3a it aborts in the preflight', /missing .*cl_catalogue_products/.test(e || ''), e);
    await bare.close();
  }
  await pg.exec(MIG);
  ok('migration applies to the live (Phase 3a) state', true);

  // ---- access ----
  for (const t of ['cl_branch_stock', 'cl_till_allowance', 'cl_till_stock_state', 'cl_stock_events', 'cl_branch_local_products'])
    ok(`anon cannot read ${t}`, /permission denied/.test((await anon(`select * from public.${t}`)).e || ''));
  ok('anon cannot call the helpers', /permission denied/.test((await anon(`select public.cl_stock_target(10,1)`)).e || ''));
  ok('every branch starts local', (await q(`select bool_and(stock_mode='local') b from cl_branches`))[0].b === true);

  // ---- local mode, holder, start ----
  let s = await sync(W.t2);
  ok('a local branch: sync reports local, the holder (T1) and 3 active tills', s.stock_mode === 'local' && s.holder_terminal_id === reg.terminal_id && s.is_holder === false && s.active_tills === 3);
  ok('T1 is the holder', (await sync(W.t1)).is_holder === true);
  ok('only the holder may start shared stock', (await start(W.t2, hex(), [])).error === 'NOT_HOLDER');
  ok('a single-till branch may not start it', (await start(W.rm, hex(), [])).error === 'SINGLE_TILL');
  ok('a product not in the catalogue is refused (and nothing changes)', /not in the catalogue/.test((await anon(`select public.cl_stock_start_shared('MAIN0001','Biz Phrase','K-1',$1,$2::jsonb)`, [hex(), JSON.stringify([{ product_uid: hex(), qty: 1 }])])).e || '')
    && (await q(`select stock_mode from cl_branches where id=$1`, [reg.branch_id]))[0].stock_mode === 'local');
  const op = hex();
  s = await start(W.t1, op, [{ product_uid: P.rice, qty: 30 }, { product_uid: P.sugar, qty: 1 }, { product_uid: P.salt, qty: 0 }, { product_uid: P.oil, qty: 8 }]);
  ok('the holder starts shared stock with its local stock as the opening', s.stock_mode === 'shared' && s.products === 4);
  ok('... replaying the same start changes nothing', (await start(W.t1, op, [{ product_uid: P.rice, qty: 30 }])).already === true && (await row(P.rice)).total === 30);
  ok('... and a second start is refused (once shared, stays shared)', (await start(W.t1, hex(), [])).error === 'ALREADY_SHARED');

  // ---- allowances (Q1) ----
  s = await sync(W.t1);
  const st = (x, p) => x.stock.find(r => r.product_uid === p);
  ok('T1 gets 10% of 30 = 3 rice as allowance', st(s, P.rice).allowance === 3 && st(s, P.rice).available === 27);
  ok('sugar (1 < 2 x 3 tills): online-only, no allowance', st(s, P.sugar).allowance === 0);
  ok('oil (8 >= 6): 10% rounds up to 1', st(s, P.oil).allowance === 1);
  await sync(W.t2); await sync(W.t3);
  ok('every till holds 3 rice; available 21; balanced', (await row(P.rice)).available === 21 && await allow(t2.terminal_id, P.rice) === 3 && await balanced());

  // ---- online sales ----
  const u1 = hex();
  let r = await sale(W.t1, u1, [{ product_uid: P.rice, qty: 5 }]);
  ok('an online sale takes from available first', r.ok === true && r.lines[0].from_available === 5 && r.lines[0].from_allowance === 0 && (await row(P.rice)).total === 25);
  r = await sale(W.t1, u1, [{ product_uid: P.rice, qty: 5 }]);
  ok('a retried sale (same uid) is counted once', r.already === true && (await row(P.rice)).total === 25);
  r = await sale(W.t1, hex(), [{ product_uid: P.rice, qty: 2 }, { product_uid: P.sugar, qty: 2 }]);
  ok('a cart with one line short is refused whole, naming the product and what is left', r.ok === false && r.refused.length === 1 && r.refused[0].product_uid === P.sugar && r.refused[0].left === 1 && (await row(P.rice)).total === 25);
  r = await sale(W.t1, hex(), [{ product_uid: P.sugar, qty: 1 }]);
  const r2 = await sale(W.t2, hex(), [{ product_uid: P.sugar, qty: 1 }]);
  ok('the last unit: the first till gets it, the second is refused', r.ok === true && r2.ok === false && r2.refused[0].left === 0 && (await row(P.sugar)).total === 0);
  const availNow = (await row(P.rice)).available;
  r = await sale(W.t3, hex(), [{ product_uid: P.rice, qty: availNow + 1 }]);
  ok('a sale bigger than available uses this till\'s own allowance too', r.ok === true && r.lines[0].from_available === availNow && r.lines[0].from_allowance === 1, JSON.stringify(r));
  ok('stock is never negative and stays balanced', await never_negative() && await balanced());

  // ---- offline report ----
  // top up everything by receiving 40 rice online
  r = await move(W.t1, [{ uid: hex(), product_uid: P.rice, delta: 40, kind: 'receive' }]);
  await sync(W.t1); await sync(W.t2); await sync(W.t3);
  const t2allow = await allow(t2.terminal_id, P.rice);
  const off1 = hex();
  r = await report(W.t2, [{ sale_uid: off1, lines: [{ product_uid: P.rice, qty: t2allow }] }]);
  ok('an offline sale within the allowance is taken from that allowance', r.sales[0].lines[0].from_allowance === t2allow && r.shortfall === 0 && await allow(t2.terminal_id, P.rice) === 0);
  ok('... reporting it again changes nothing', (await report(W.t2, [{ sale_uid: off1, lines: [{ product_uid: P.rice, qty: t2allow }] }])).sales[0].already === true);
  const timedOut = hex();
  r = await sale(W.t3, timedOut, [{ product_uid: P.rice, qty: 2 }]);              // succeeded on the server, the till never heard back
  const before = (await row(P.rice)).total;
  r = await report(W.t3, [{ sale_uid: timedOut, lines: [{ product_uid: P.rice, qty: 2 }] }]);
  ok('a timed-out sale that had succeeded is not counted twice', r.sales[0].already === true && (await row(P.rice)).total === before && r.sales[0].lines[0].from_allowance === 0);

  // ---- movements ----
  const mv = hex();
  r = await move(W.t1, [{ uid: mv, product_uid: P.oil, delta: 5, kind: 'receive' }]);
  ok('an online receipt adds to total and available', r.ok === true && (await row(P.oil)).total === 13);
  ok('... once only', (await move(W.t1, [{ uid: mv, product_uid: P.oil, delta: 5, kind: 'receive' }])).moves[0].already === true && (await row(P.oil)).total === 13);
  r = await move(W.t1, [{ uid: hex(), product_uid: P.oil, delta: -2, kind: 'adjust' }, { uid: hex(), product_uid: P.sugar, delta: -1, kind: 'dispatch' }]);
  ok('a decrease beyond stock refuses the whole batch', r.ok === false && r.refused[0].product_uid === P.sugar && (await row(P.oil)).total === 13);
  r = await move(W.t1, [{ uid: hex(), product_uid: hex(), delta: 1, kind: 'receive' }]);
  ok('a product outside the catalogue is refused', r.ok === false && r.refused[0].reason === 'UNKNOWN_PRODUCT');
  r = await report(W.t1, [], [{ uid: hex(), product_uid: P.salt, delta: 4, kind: 'receive' }]);
  ok('a receipt recorded offline adds when reported', (await row(P.salt)).total === 4);

  // ---- stocktake (Q4) ----
  await sync(W.t1); await sync(W.t2);
  r = await take(W.t1, hex(), [{ product_uid: P.rice, counted: 50 }]);
  ok('a stocktake is refused while another till holds allowance, naming the tills', r.error === 'ALLOWANCE_HELD' && r.tills.includes('T2'), JSON.stringify(r));

  // ---- deactivated till ----
  const t2held = await allow(t2.terminal_id, P.rice);
  const availBefore = (await row(P.rice)).available;
  await dev(`select public.cl_terminal_set_active('MAIN0001','Biz Phrase','K-1',$1::uuid,false) j`, [t2.terminal_id]);
  ok('deactivating T2 returns its allowance to available', await allow(t2.terminal_id, P.rice) === 0 && (await row(P.rice)).available === availBefore + t2held && await balanced());
  ok('a deactivated till cannot sell online', (await sale(W.t2, hex(), [{ product_uid: P.rice, qty: 1 }])).error === 'TERMINAL_INACTIVE');
  r = await report(W.t2, [{ sale_uid: hex(), lines: [{ product_uid: P.rice, qty: 1 }] }]);
  ok('... but its offline sales are still accepted (from available now)', r.sales[0].lines[0].from_available === 1 && r.shortfall === 0);
  r = await report(W.t2, [{ sale_uid: hex(), lines: [{ product_uid: P.sugar, qty: 3 }] }]);
  ok('a late offline sale nothing can cover is a discrepancy, never negative', r.shortfall === 3 && (await row(P.sugar)).total === 0 && await never_negative());
  await dev(`select public.cl_terminal_set_active('MAIN0001','Biz Phrase','K-1',$1::uuid,true) j`, [t2.terminal_id]);

  // ---- 72 h stale rule (Q2) ----
  await sync(W.t3);
  const t3held = await allow(t3.terminal_id, P.rice);
  await q(`update cl_till_stock_state set last_sync_ts = now() - interval '73 hours' where terminal_id=$1`, [t3.terminal_id]);
  await sync(W.t1);
  ok('a till that has not synced for 72 h loses its allowance when another till syncs', t3held > 0 && await allow(t3.terminal_id, P.rice) === 0);

  // ---- stocktake once nobody else holds allowance ----
  await q(`update cl_till_stock_state set last_sync_ts = now() - interval '73 hours' where terminal_id<>$1`, [reg.terminal_id]);
  await sync(W.t1);
  r = await take(W.t1, hex(), [{ product_uid: P.rice, counted: 50 }]);
  ok('with no allowance held elsewhere, the stocktake sets the count', r.ok === true && (await row(P.rice)).total === 50 && (await row(P.rice)).available === 50);

  // ---- balance + discrepancies ----
  const b = await bal(W.t1);
  ok('balance: every product balances (total = available + allowances = events)', b.mismatches.length === 0 && b.products === 4, JSON.stringify(b.mismatches));
  ok('... and the discrepancy is listed with the till', b.discrepancies.length === 1 && b.discrepancies[0].till === 'T2' && b.discrepancies[0].shortfall === 3);

  // ---- branch-only products (Q8) ----
  r = await dev(`select public.cl_stock_local_products_report('REMOTE01','Biz Phrase','K-R',$1::jsonb) j`, [JSON.stringify([{ code: 'BRD', name: 'Local bread' }, { code: '', name: 'Tomatoes' }])]);
  ok('a till reports its branch-only products', r.products === 2);
  r = await dev(`select public.cl_stock_local_products_list('MAIN0001','Biz Phrase','K-1') j`);
  ok('main lists them with branch and till', r.products.length === 2 && r.products.every(p => p.branch === 'Murehwa' && p.till === 'T1'));
  ok('a remote till cannot list them', (await dev(`select public.cl_stock_local_products_list('REMOTE01','Biz Phrase','K-R') j`)).error === 'NOT_MAIN');

  // ---- rollback ----
  await pg.exec(RB);
  ok('rollback: tables, functions and trigger gone', (await q(`select count(*)::int n from pg_class where relname in ('cl_branch_stock','cl_till_allowance','cl_till_stock_state','cl_stock_events','cl_branch_local_products')`))[0].n === 0
    && (await q(`select count(*)::int n from pg_proc where proname like 'cl_stock%'`))[0].n === 0
    && (await q(`select count(*)::int n from pg_trigger where tgname='cl_stock_till_deactivated'`))[0].n === 0);
  ok('rollback: cl_branches has no stock_mode', (await q(`select count(*)::int n from information_schema.columns where table_name='cl_branches' and column_name like 'stock%'`))[0].n === 0);
  ok('rollback: Phase 3a still works', Array.isArray((await dev(`select public.cl_catalogue_pull('MAIN0001','Biz Phrase','K-1',0,10) j`)).products));
  await pg.exec(MIG);
  ok('the migration applies again after a rollback', (await sync(W.t1)).stock_mode === 'local');

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
