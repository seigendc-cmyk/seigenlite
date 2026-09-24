// Run: node --no-warnings test/split-tender.test.js
// Multi-Payment / Split Tender: completeSale(method, payments) in
// src/pos.js, the new sale_payments table (src/db.js), eodTotalsFor's cash
// isolation (src/eod.js) and the payment-method breakdown
// (paymentMethodTotals, src/pos.js) — over the REAL app source via the same
// harness the other suites use. Reuses eod_sessions/startShift/completeEOD
// from the Shift/EOD task and completeSale() as the one checkout choke
// point, same as test/eod-shift.test.js.
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}
function rig(o){ return makeApp(Object.assign({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, o||{})); }
const D = (iso)=> new Date(iso);
// Test-Infrastructure Fix (Hardcoded Test Dates): see test/multi-currency.test.js's
// identical comment — completeSale() always checks shiftBlockReason()
// against the real device clock, so a shift opened for a fixed calendar
// date looks stale (and blocks every sale) once a real day has passed since
// this file was written. TODAY/T() derive "today" from the real clock at
// test-run time instead.
const TODAY = new Date().toISOString().slice(0,10);
const T = (hms)=> D(`${TODAY}T${hms}Z`);
function addProduct(app, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES(?,?,?,?,?,?)",
    [o.name,o.price,o.stock,o.low_threshold==null?3:o.low_threshold,"Boka",o.sku||""]);
  return app.api.one("SELECT * FROM products WHERE name=?",[o.name]);
}
function setCart(app, product, qty){
  app.api.setCart([{ product_id:product.id, name:product.name, price:product.price, qty, stock:product.stock }]);
}

(async()=>{
  // ================= regression: single-method sale unchanged =================
  await t("single-method sale (regression): sales row and stock exactly as before, plus one mirrored sale_payments row", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 3);
    A.hook("printReceipt", ()=>{});
    A.api.completeSale("Cash");
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.method,"Cash");
    assert.strictEqual(sale.total,30);
    assert.strictEqual(A.api.one("SELECT stock FROM products WHERE id=?",[rice.id]).stock,47);
    const payments = A.api.salePayments(sale.id);
    assert.strictEqual(payments.length,1,"one row, not zero and not many");
    assert.strictEqual(payments[0].method,"Cash");
    assert.strictEqual(payments[0].amount,30);
  });

  // ================= split across two methods =================
  await t("split across two methods summing exactly to total completes and records both lines", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 5); // total 50
    A.setField("paymentRef","REF-001"); // required because an EcoCash line is present
    A.hook("printReceipt", ()=>{});
    let alerted="";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale(null, [{method:"Cash",amount:30},{method:"EcoCash",amount:20}]);
    assert.strictEqual(alerted,"","no validation alert for a balanced split");
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.method,"Split","stored as Split, not collapsed to either method");
    assert.strictEqual(sale.total,50);
    const payments = A.api.salePayments(sale.id);
    assert.strictEqual(payments.length,2);
    const byMethod = {}; payments.forEach(p=>byMethod[p.method]=p.amount);
    assert.deepStrictEqual(byMethod,{Cash:30,EcoCash:20});
  });

  // ================= split across three+ methods =================
  await t("split across three methods (Cash+EcoCash+Credit) records every line and only puts the Credit portion on the customer's balance", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 10); // total 100
    A.setField("custName","Tendai Moyo"); // required because a Credit line is present
    A.setField("paymentRef","REF-002");   // required because an EcoCash line is present
    A.hook("printReceipt", ()=>{});
    A.api.completeSale(null, [{method:"Cash",amount:40},{method:"EcoCash",amount:20},{method:"Credit",amount:40}]);
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.method,"Split");
    assert.strictEqual(sale.total,100);
    const payments = A.api.salePayments(sale.id);
    assert.strictEqual(payments.length,3);
    const cust = A.api.one("SELECT * FROM customers WHERE name='Tendai Moyo'");
    assert.ok(cust,"customer was created/linked, same as a plain Credit sale");
    assert.strictEqual(A.api.customerBalance(cust.id),40,"only the $40 Credit line is owed, not the full $100 sale");
  });

  // ================= validation: amounts must sum to total =================
  await t("attempted completion with amounts not summing to total is blocked — nothing is written", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 3); // total 30
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale(null, [{method:"Cash",amount:10},{method:"EcoCash",amount:5}]); // sums to 15, not 30
    assert.ok(/must add up to the sale total/.test(alerted), alerted);
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0,"no sale row created");
    assert.strictEqual(A.api.all("SELECT * FROM sale_payments").length,0,"no payment rows created");
    assert.strictEqual(A.api.one("SELECT stock FROM products WHERE id=?",[rice.id]).stock,50,"stock untouched");
  });

  await t("attempted completion with a blank payment-line amount is blocked", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 3);
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale(null, [{method:"Cash",amount:30},{method:"EcoCash",amount:""}]);
    assert.ok(/Enter an amount for every payment method/.test(alerted), alerted);
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0);
  });

  // ================= a single-line "split" is not treated as split =================
  await t("a split-tender call with only one payment line collapses to a plain single-method sale", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 3);
    A.setField("paymentRef","REF-003");
    A.hook("printReceipt", ()=>{});
    A.api.completeSale(null, [{method:"EcoCash",amount:30}]);
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.method,"EcoCash","not 'Split' — matches a normal single-method EcoCash sale");
    assert.strictEqual(A.api.salePayments(sale.id).length,1);
  });

  // ================= EOD cash reconciliation isolates the cash portion =================
  await t("EOD cash reconciliation isolates only the cash portion of split sales", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:100});
    const now = T("08:00:00");
    A.api.startShift("50", now);
    A.setField("paymentRef","REF-EOD");
    A.setField("custName","Grace");
    A.hook("printReceipt", ()=>{});
    setCart(A, rice, 3); A.api.completeSale("Cash");                                              // plain $30 cash
    setCart(A, rice, 3); A.api.completeSale(null,[{method:"Cash",amount:20},{method:"EcoCash",amount:10}]); // $20 cash + $10 ecocash
    setCart(A, rice, 3); A.api.completeSale(null,[{method:"Cash",amount:5},{method:"Credit",amount:25}]);   // $5 cash + $25 credit
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,3,"all three sales went through");
    const totals = A.api.eodTotalsFor("Boka",TODAY,50);
    assert.strictEqual(totals.cash,55,"30 + 20 + 5 — never the EcoCash/Credit portions of the split sales");
    assert.strictEqual(totals.ecocash,10);
    assert.strictEqual(totals.credit,25);
    assert.strictEqual(totals.expected,50+55,"opening float + isolated cash only");
    const closed = A.api.completeEOD("105","",T("20:00:00"));
    assert.strictEqual(closed.variance,0,"exact count against the isolated cash figure");
  });

  // ================= payment-method breakdown reporting =================
  await t("payment-method breakdown totals are correct across a mix of single and split sales", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:100});
    A.api.startShift("0", T("08:00:00"));
    A.setField("paymentRef","REF-BRK");
    A.hook("printReceipt", ()=>{});
    setCart(A, rice, 2); A.api.completeSale("Cash");                                              // Cash 20
    setCart(A, rice, 1); A.api.completeSale("Bank");                                               // Bank 10
    setCart(A, rice, 5); A.api.completeSale(null,[{method:"Cash",amount:30},{method:"EcoCash",amount:20}]); // Cash 30 + EcoCash 20
    const breakdown = A.api.paymentMethodTotals("Boka",TODAY+"T00:00:00",TODAY+"T23:59:59");
    const byMethod = {}; breakdown.forEach(r=>byMethod[r.method]=r.total);
    assert.strictEqual(byMethod.Cash,50,"20 (plain) + 30 (split line)");
    assert.strictEqual(byMethod.Bank,10);
    assert.strictEqual(byMethod.EcoCash,20);
    assert.strictEqual(byMethod.Credit,undefined,"no credit sales in this mix — not present at all, not zero");
  });

  // ================= backward compatibility: pre-feature historical data =================
  await t("pre-feature sales rows (no sale_payments yet) are backfilled by migrate(), so historical EOD/credit figures aren't zeroed out after upgrade", ()=>{
    const A = rig();
    A.api.run("INSERT INTO sales(ts,subtotal,discount,total,method,branch) VALUES(?,?,?,?,?,?)",
      ["2026-01-05T10:00:00Z",40,0,40,"Cash","Boka"]);
    A.api.run("INSERT INTO customers(name,phone,branch) VALUES('Old Customer','','Boka')");
    const cust = A.api.one("SELECT * FROM customers WHERE name='Old Customer'");
    A.api.run("INSERT INTO sales(ts,subtotal,discount,total,method,branch,customer_id) VALUES(?,?,?,?,?,?,?)",
      ["2026-01-05T11:00:00Z",15,0,15,"Credit","Boka",cust.id]);
    assert.strictEqual(A.api.all("SELECT * FROM sale_payments").length,0,"none yet — simulating a pre-upgrade database");
    A.api.migrate(A.db); // simulates the app upgrading over this pre-existing database
    const totals = A.api.eodTotalsFor("Boka","2026-01-05",0);
    assert.strictEqual(totals.cash,40,"backfilled from the old Cash sale");
    assert.strictEqual(totals.credit,15,"backfilled from the old Credit sale");
    assert.strictEqual(A.api.customerBalance(cust.id),15);
    A.api.migrate(A.db); // repeatable: must not duplicate the backfilled rows
    assert.strictEqual(A.api.all("SELECT * FROM sale_payments").length,2);
  });

  // ================= merge/backup: split-tender sales carry their payment lines across devices =================
  await t("merging in a branch's exported database also copies its sale_payments rows, not just sales/sale_items", ()=>{
    const M = rig({ branch_name:"Main" });
    const R = rig({ branch_name:"Boka" });
    const rice = addProduct(R,{name:"Rice",price:10,stock:50});
    R.api.startShift("0", T("08:00:00"));
    R.setField("paymentRef","REF-MERGE");
    R.hook("printReceipt", ()=>{});
    setCart(R, rice, 5);
    R.api.completeSale(null,[{method:"Cash",amount:30},{method:"EcoCash",amount:20}]);
    const remoteSale = R.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(R.api.salePayments(remoteSale.id).length,2);
    M.api.mergeDatabase({ __db: R.db });
    const mergedSale = M.api.one("SELECT * FROM sales WHERE branch='Boka' ORDER BY id DESC LIMIT 1");
    assert.ok(mergedSale,"the split sale itself merged in");
    assert.strictEqual(mergedSale.method,"Split");
    const mergedPayments = M.api.salePayments(mergedSale.id);
    assert.strictEqual(mergedPayments.length,2,"both payment lines merged in, not zero");
    const byMethod = {}; mergedPayments.forEach(p=>byMethod[p.method]=p.amount);
    assert.deepStrictEqual(byMethod,{Cash:30,EcoCash:20});
  });

  // ================= refunds/voids =================
  // Not implemented: this app has no refund/void flow for sales anywhere in
  // src/ (grep confirms "refund"/"void" only appear in grv-import.js/
  // styles.css, both unrelated to sales) — so item 7 of the spec ("if that
  // flow exists") does not apply, and there is nothing to test here.

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
