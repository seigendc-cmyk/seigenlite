// Run: node --no-warnings test/upgrade-v4-v10.test.js
// The production upgrade, v4 -> this build, on a shop's own device data, and
// the way back (production rolled back to v4 after a device opened its data
// with this build).
//
// v4 is the REAL production code: src/, sw-pwa.js and test/harness.js are
// read from commit V4_REV with `git show` into a temp folder, so v4's own
// SCHEMA/migrate/completeSale/EOD/dispatch/receive write the database. Then
// this build opens that same database the way the app boots (db.js: SCHEMA,
// then migrate) and the checks run on it. The rollback half hands the
// database back to v4 the same way.
"use strict";
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { execFileSync } = require("child_process");
const { makeApp } = require("./harness");

const V4_REV = "04010ffa5b1d87d1ab2407ced8046626f84e06a0";   // main = production v4 (Phase 2), deployed 2026-10-06
const ROOT = path.join(__dirname, "..");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const plain = (x)=>JSON.parse(JSON.stringify(x));

// ---- v4's own code, from git ----
function loadV4(){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-v4-"));
  const git = (...a)=> execFileSync("git", a, { cwd:ROOT, maxBuffer:64*1024*1024 });
  const files = git("ls-tree", "-r", "--name-only", V4_REV, "src").toString().split("\n").filter(Boolean)
    .concat(["sw-pwa.js", "test/harness.js"]);
  files.forEach(f=>{ const out = path.join(dir, f); fs.mkdirSync(path.dirname(out), { recursive:true }); fs.writeFileSync(out, git("show", V4_REV+":"+f)); });
  assert.match(fs.readFileSync(path.join(dir, "sw-pwa.js"), "utf8"), /^\/\/ build: v4\b/m, "V4_REV is build v4");
  return require(path.join(dir, "test", "harness.js")).makeApp;
}
const makeV4 = loadV4();

// a fixed clock inside one app (Date and Date.now); A.clock("2026-10-05T09:00")
function withClock(A){
  vm.runInContext(`(function(){ const R = Date; globalThis.__now = R.now();
    class D extends R { constructor(...a){ if(a.length) super(...a); else super(globalThis.__now); } static now(){ return globalThis.__now; } }
    Date = D; })()`, A.ctx);
  A.clock = (s)=>{ A.ctx.__now = Date.parse(s+":00+02:00"); };
  return A;
}
function hooks(A){
  A.alerts = [];
  A.hook("printReceipt", ()=>{}); A.hook("alert", (m)=>{ A.alerts.push(String(m)); }); A.hook("confirm", ()=>true);
  return A;
}
// one sale through the app's own completeSale (v4 or this build)
function sell(A, lines, method, f){
  f = f||{};
  A.api.setCart(lines.map(([sku,qty])=>{ const p = A.api.one("SELECT * FROM products WHERE sku=? AND branch=?",[sku, A.api.currentBranch()]);
    return { product_id:p.id, name:p.name, price:p.price, qty, stock:p.stock, discount:0 }; }));
  ["custName","custPhone","paymentRef","discountReason","docRef"].forEach(k=>A.setField(k, ""));
  if(f.cust) A.setField("custName", f.cust);
  if(f.phone) A.setField("custPhone", f.phone);
  if(f.voucher) vm.runInContext(`appliedVoucher = ${JSON.stringify(f.voucher)};`, A.ctx);
  A.alerts.length = 0;
  A.api.completeSale(method);
  assert.deepStrictEqual(A.alerts, [], "the sale went through");
  return A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
}
// boot an app on an existing database exactly as db.js does: SCHEMA, then migrate
function boot(A, compatDb){ A.api.setDb(compatDb); compatDb.run(A.api.SCHEMA); A.api.migrate(compatDb); return A; }
const tables = (A)=> A.api.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
const cols = (A, tbl)=> A.api.all(`PRAGMA table_info(${tbl})`).map(c=>c.name);
// every row of every table, in v4's own columns
function snapshot(A){
  const out = {};
  tables(A).forEach(tbl=>{ const c = cols(A, tbl); out[tbl] = { cols:c, rows:plain(A.api.all(`SELECT ${c.map(x=>'"'+x+'"').join(",")} FROM ${tbl} ORDER BY rowid`)) }; });
  return out;
}
function rowsIn(A, snap, tbl){ const c = snap[tbl].cols; return plain(A.api.all(`SELECT ${c.map(x=>'"'+x+'"').join(",")} FROM ${tbl} ORDER BY rowid`)); }

// ---- a v4 shop: main "Harare" (Admin, products, sales, debtor, loyalty voucher, EOD history,
//      a DN to Murehwa) and the Murehwa device that received it (GRV) ----
async function buildV4Shop(){
  const H = hooks(withClock(makeV4({ setup_complete:"1", shop_name:"Gentronix", branch_name:"Harare", branch_type:"main", currency:"$",
    freq_voucher_amount:"5", freq_purchases_needed:"1", freq_within_days:"30" })));
  const M = hooks(withClock(makeV4({ setup_complete:"1", shop_name:"Gentronix", branch_name:"Murehwa", branch_type:"remote", currency:"$" })));
  H.clock("2026-10-05T08:00"); M.clock("2026-10-05T08:00");
  H.api.getBranchId(); M.api.getBranchId();
  H.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999','Harare',1,'x')");
  M.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999','Murehwa',1,'x')");
  [["Rice",10,6,"RICE",50],["Oil",20,12,"OIL",20],["Soap",5,3,"SOAP",30]].forEach(([n,p,c,s,q])=>
    H.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,3,?,'Harare','',?,'2026-01-01','')",[n,p,q,s,c]));
  M.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES('Soap',5,2,3,'SOAP','Murehwa','',3,'2026-01-01','')");
  H.api.migrate(H.db); M.api.migrate(M.db);                                      // opening balances for the stock ledger

  // day 1 (before registration): cash sale #1, a credit sale to a debtor (earns a loyalty voucher), a part payment, EOD
  H.api.startShift("100");
  H.clock("2026-10-05T09:00"); const s1 = sell(H, [["RICE",2],["SOAP",1]], "Cash");
  H.clock("2026-10-05T10:00"); const s2 = sell(H, [["OIL",1]], "Credit", { cust:"Chipo", phone:"0771234567" });
  const chipo = H.api.one("SELECT * FROM customers WHERE name='Chipo'");
  H.api.run("INSERT INTO credit_payments(customer_id,ts,amount,note,branch,user) VALUES(?,?,?,?,?,?)",[chipo.id, "2026-10-05T11:00:00.000Z", 8, "part payment", "Harare", "Tester"]);
  H.clock("2026-10-05T18:00"); H.api.completeEOD("125", "day 1");
  // day 2: registered as till T1 (Phase 1/2 numbering), a sale T1-0001, a DN to Murehwa, EOD
  H.clock("2026-10-06T08:00"); H.api.startShift("100");
  H.api.setSetting("till_code","T1"); H.api.setSetting("terminal_id","11111111-1111-1111-1111-111111111111");
  H.clock("2026-10-06T09:00"); const s3 = sell(H, [["RICE",1]], "Cash");
  H.api.ensureSelfInRegister(); H.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Murehwa','')");
  const soap = H.api.one("SELECT * FROM products WHERE sku='SOAP' AND branch='Harare'");
  const dn = H.api.dnCommitDispatch({ branch:"Harare", toBranch:"Murehwa", now:new Date("2026-10-06T10:00:00+02:00"), lines:[{ product:soap, qty:4 }] });
  const hd = H.api.dnHeaderFor(dn.n);
  const doc = await H.api.buildDN({ dnNo:dn.n, fromBranchId:H.api.getBranchId(), fromName:"Harare", toName:"Murehwa", createdIso:hd.created_iso,
    items:[{ code:"SOAP", name:"Soap", qty:4 }] });
  M.clock("2026-10-06T12:00");
  const chk = (await M.api.receiveCheckBytes(new Uint8Array(Buffer.from(H.api.serializeDN(doc),"utf8")))).res;
  M.api.commitReceive(chk.doc, new Date("2026-10-06T12:00:00+02:00"));
  H.clock("2026-10-06T18:00"); H.api.completeEOD("110", "day 2");
  return { H, M, s1, s2, s3, chipo };
}

(async()=>{
  const v4 = await buildV4Shop();
  const { H, M } = v4;
  // what v4 itself says about its data
  const before = {
    H: snapshot(H), M: snapshot(M),
    balance: H.api.customerBalance(v4.chipo.id),
    eod1: plain(H.api.eodTotalsFor("Harare", "2026-10-05", 100)),
    ledgerH: plain(H.api.stockLedgerCheck().mismatches), ledgerM: plain(M.api.stockLedgerCheck().mismatches),
    receipts: [H.api.receiptDisplay(v4.s1), H.api.receiptDisplay(v4.s3)],
    voucher: plain(H.api.one("SELECT * FROM vouchers WHERE customer_id=?",[v4.chipo.id])),
  };

  await t("the v4 shop is what production makes: #1 and T1-0001 receipts, a debtor, a loyalty voucher, two closed EODs, a DN and a GRV", async ()=>{
    assert.deepStrictEqual(before.receipts, ["#"+v4.s1.id, "T1-0001"]);
    assert.strictEqual(before.balance, 12, "Oil 20 on credit - 8 paid");
    assert.ok(before.voucher && before.voucher.status==="Available" && before.voucher.amount===5, JSON.stringify(before.voucher));
    assert.strictEqual(H.api.all("SELECT * FROM eod_sessions WHERE status='closed'").length, 2);
    assert.ok(H.api.dnHeaderFor(1), "DN 1 on Harare");
    assert.deepStrictEqual(before.ledgerH, []); assert.deepStrictEqual(before.ledgerM, []);
    assert.strictEqual(M.api.one("SELECT stock FROM products WHERE sku='SOAP'").stock, 6, "2 + 4 received");
    assert.strictEqual(M.api.all("SELECT * FROM stock_received").length, 1);
  });

  // ---- this build opens v4's database ----
  const N = hooks(withClock(boot(makeApp(), H.db)));
  const NM = hooks(withClock(boot(makeApp(), M.db)));
  N.clock("2026-10-07T08:00"); NM.clock("2026-10-07T08:00");

  await t("v10 opens it: every v4 row of every table is unchanged (all v4 columns), on both devices", async ()=>{
    for(const [A, snap] of [[N, before.H], [NM, before.M]]){
      const now = tables(A);
      Object.keys(snap).forEach(tbl=>{
        assert.ok(now.includes(tbl), "table kept: "+tbl);
        const c = cols(A, tbl); snap[tbl].cols.forEach(x=>assert.ok(c.includes(x), tbl+"."+x+" kept"));
        if(tbl==="settings") return;                                            // compared below: v10 may add keys
        assert.deepStrictEqual(rowsIn(A, snap, tbl), snap[tbl].rows, "rows of "+tbl);
      });
      const oldSettings = new Map(snap.settings.rows.map(r=>[r.key, r.value]));
      const changed = plain(A.api.all("SELECT key, value FROM settings")).filter(r=>oldSettings.has(r.key) && oldSettings.get(r.key)!==r.value);
      assert.deepStrictEqual(changed, [], "no v4 setting changed its value");
    }
  });

  await t("v10: sales, stock, customer balance, EOD history and the stock ledger read as before; Diagnostics balances", async ()=>{
    assert.strictEqual(N.api.customerBalance(v4.chipo.id), before.balance);
    const e = plain(N.api.eodTotalsFor("Harare", "2026-10-05", 100));
    ["cash","credit","ecocash","expected"].forEach(k=>{ if(k in before.eod1) assert.strictEqual(e[k], before.eod1[k], "EOD day 1 "+k); });
    assert.strictEqual(e.totalSales, before.eod1.totalSales, "no Bank sales, so Total Sales is the same");
    assert.deepStrictEqual(plain(N.api.stockLedgerCheck().mismatches), [], "Diagnostics on Harare");
    assert.deepStrictEqual(plain(NM.api.stockLedgerCheck().mismatches), [], "Diagnostics on Murehwa");
  });

  await t("v10: old #1 and T1-0001 receipts are found and show the same receipt numbers (reprint data intact)", async ()=>{
    N.api.setSetting("return_days","30");
    const a = N.api.findReturnSale("#"+v4.s1.id), b = N.api.findReturnSale("T1-0001");
    assert.ok(a.sale && a.sale.id===v4.s1.id, JSON.stringify(a.error||""));
    assert.ok(b.sale && b.sale.id===v4.s3.id, JSON.stringify(b.error||""));
    assert.deepStrictEqual([N.api.receiptDisplay(a.sale), N.api.receiptDisplay(b.sale)], before.receipts);
    assert.deepStrictEqual(plain(N.api.salePayments(v4.s1.id)).map(p=>p.method+" "+p.amount), ["Cash 25"]);
  });

  await t("v10: the existing voucher is kind 'loyalty' and is redeemed exactly as v4 does (whole voucher, no store credit left)", async ()=>{
    const v = N.api.one("SELECT * FROM vouchers WHERE id=?",[before.voucher.id]);
    assert.strictEqual(v.kind, "loyalty");
    N.api.startShift("100");
    N.clock("2026-10-07T09:00");
    sell(N, [["SOAP",1]], "Cash", { voucher: plain(v) });                        // a $5 sale, the $5 voucher
    const after = plain(N.api.all("SELECT status, kind FROM vouchers WHERE customer_id=?",[v4.chipo.id]));
    assert.deepStrictEqual(after, [{ status:"Redeemed", kind:"loyalty" }], "redeemed, and no remainder voucher");
  });

  await t("v10: selling and returning work on the upgraded data (a return of #1 back to stock, cash)", async ()=>{
    N.clock("2026-10-07T10:00");
    const s = sell(N, [["RICE",1]], "Cash");
    assert.strictEqual(s.receipt_no, "T1-0003", "numbering carries on from v4 (T1-0002 was the voucher sale)");
    const li = N.api.one("SELECT * FROM sale_items WHERE sale_id=? AND name='Rice'",[v4.s1.id]);
    const plan = N.api.planCreditNote(v4.s1.id, [{ saleItemId:li.id, qty:1, condition:"restock" }], "same", { reason:"Changed mind" });
    const r = N.api.commitCreditNote(plan, { passcode:"9999" });
    assert.strictEqual(r.text, "CN-T1-0001");
    assert.deepStrictEqual(plain(N.api.stockLedgerCheck().mismatches), []);
  });

  await t("a v4 T2 of a multi-till branch that isn't shared keeps selling its own stock on v10 (the note shows, nothing is blocked)", async ()=>{
    const T2 = hooks(withClock(makeV4({ setup_complete:"1", shop_name:"Gentronix", branch_name:"Harare", branch_type:"main", currency:"$",
      till_code:"T2", terminal_id:"22222222-2222-2222-2222-222222222222", terminal_is_main:"1" })));
    T2.clock("2026-10-06T08:00");
    T2.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES('Rice',10,5,3,'RICE','Harare','',6,'2026-01-01','')");
    T2.api.migrate(T2.db); T2.api.startShift("50");
    T2.clock("2026-10-06T09:00"); assert.strictEqual(sell(T2, [["RICE",1]], "Cash").receipt_no, "T2-0001");
    T2.clock("2026-10-06T18:00"); T2.api.completeEOD("60", "");
    const U = hooks(withClock(boot(makeApp(), T2.db)));
    U.clock("2026-10-07T08:00"); U.api.startShift("50");
    assert.strictEqual(U.api.tillStockPending(), true, "before its first stock sync: the note shows");
    U.clock("2026-10-07T09:00"); assert.strictEqual(sell(U, [["RICE",2]], "Cash").receipt_no, "T2-0002");
    U.api.setSetting("stock_mode","local"); U.api.setSetting("stock_holder","");      // what cl_stock_sync answers for a non-holder of a local branch
    assert.strictEqual(U.api.tillStockPending(), true, "after it: the note still shows");
    U.clock("2026-10-07T10:00"); sell(U, [["RICE",1]], "Cash");
    assert.strictEqual(U.api.one("SELECT stock FROM products WHERE sku='RICE'").stock, 1, "5 - 1 (v4) - 2 - 1 (v10): its own stock, as before");
    assert.deepStrictEqual(plain(U.api.stockLedgerCheck().mismatches), []);
  });

  await t("updated mid-shift: the shift v4 opened carries on in v10 and its End of Day counts the sales of both", async ()=>{
    const A = hooks(withClock(makeV4({ setup_complete:"1", shop_name:"Gentronix", branch_name:"Harare", branch_type:"main", currency:"$" })));
    A.clock("2026-10-07T08:00");
    A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES('Rice',10,9,3,'RICE','Harare','',6,'2026-01-01','')");
    A.api.migrate(A.db); A.api.startShift("50");
    A.clock("2026-10-07T09:00"); sell(A, [["RICE",1]], "Cash");
    const U = hooks(withClock(boot(makeApp(), A.db)));
    U.clock("2026-10-07T13:00");
    assert.strictEqual(U.api.shiftBlockReason(new Date()), "", "selling isn't blocked");
    sell(U, [["RICE",2]], "Cash");
    U.clock("2026-10-07T18:00");
    const e = U.api.completeEOD("80", "");
    assert.strictEqual(e.expected_cash, 80, "float 50 + 10 (v4) + 20 (v10)");
    assert.strictEqual(e.variance, 0);
  });

  // ---- the way back: production rolled back to v4, this device's data was opened (and used) by v10 ----
  // v10 also leaves a store-credit voucher behind (a walk-in's return as store credit), and a debtor return.
  let storeCreditCust = null;
  await t("(v10 before the rollback) a store-credit return for a walk-in and a debtor return", async ()=>{
    N.clock("2026-10-07T11:00");
    const li = N.api.one("SELECT * FROM sale_items WHERE sale_id=? AND name='Soap'",[v4.s1.id]);
    const p1 = N.api.planCreditNote(v4.s1.id, [{ saleItemId:li.id, qty:1, condition:"restock" }], "voucher", { reason:"Changed mind", customerName:"Tariro", customerPhone:"0779998888" });
    N.api.commitCreditNote(p1, { passcode:"9999" });
    storeCreditCust = N.api.one("SELECT * FROM customers WHERE name='Tariro'");
    assert.deepStrictEqual(plain(N.api.all("SELECT amount, kind, status FROM vouchers WHERE customer_id=?",[storeCreditCust.id])), [{ amount:5, kind:"store_credit", status:"Available" }]);
    const oli = N.api.one("SELECT * FROM sale_items WHERE sale_id=?",[v4.s2.id]);
    const p2 = N.api.planCreditNote(v4.s2.id, [{ saleItemId:oli.id, qty:1, condition:"restock" }], "debtor", { reason:"Wrong item" });
    N.api.commitCreditNote(p2, { passcode:"9999" });
    assert.strictEqual(N.api.customerBalance(v4.chipo.id), 0, "v10: the return cleared the debt, the rest as store credit");
  });

  const snap10 = snapshot(N);
  const back = hooks(withClock(boot(makeV4(), H.db)));
  back.clock("2026-10-07T12:00");
  await t("rollback: v4 opens the database v10 used, keeps every row, sells and runs End of Day", async ()=>{
    Object.keys(snap10).filter(tbl=>tbl!=="settings").forEach(tbl=>assert.deepStrictEqual(rowsIn(back, snap10, tbl), snap10[tbl].rows, "v4's boot kept "+tbl));
    const s = sell(back, [["OIL",1]], "Cash");
    assert.strictEqual(s.receipt_no, "T1-0004", "v4 numbering carries on after v10's T1-0003");
    assert.ok(back.api.all("SELECT * FROM credit_notes").length===3, "v10's credit notes are still in the file (v4 ignores them)");
    assert.deepStrictEqual(plain(back.api.stockLedgerCheck().mismatches), [], "v4's Diagnostics balances (v10's returns moved stock through the same ledger)");
    back.clock("2026-10-07T18:00");
    const e = back.api.completeEOD("100", "after rollback");
    assert.strictEqual(e.status, "closed");
  });

  await t("rollback: what v4 gets wrong about v10's returns (stated, for the rollback plan)", async ()=>{
    // 1. cash refunds: v4's End of Day doesn't know them, so expected cash is too high by the cash refunded
    const e4 = plain(back.api.eodTotalsFor("Harare", "2026-10-07", 100));
    const e10 = plain(N.api.eodTotalsFor("Harare", "2026-10-07", 100));
    assert.strictEqual(e4.expected - e10.expected, 10, "v4 expects $10 more cash: the $10 Rice refund (v10 counts it, v4 can't) "+JSON.stringify({ e4, e10 }));
    // 2. debtor returns: v4's balance ignores them, so the customer owes again
    assert.strictEqual(back.api.customerBalance(v4.chipo.id), 12, "v4 shows the $12 debt the return cleared");
    // 3. store credit: v4 sees an ordinary voucher, offered once and used whole
    const sc = back.api.one("SELECT * FROM vouchers WHERE customer_id=?",[storeCreditCust.id]);
    assert.strictEqual(sc.status, "Available");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
