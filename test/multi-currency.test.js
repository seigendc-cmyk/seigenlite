// Run: node --no-warnings test/multi-currency.test.js
// Multi-Currency Support: currencies table + saveCurrency (src/currencies.js),
// the currency-aware completeSale(method, payments) (src/pos.js), per-currency
// cash isolation in eodTotalsFor (src/eod.js) and paymentMethodCurrencyTotals
// (src/pos.js) — over the REAL app source via the same harness the other
// suites use. Builds directly on the Split-Tender task: every payment line
// still goes through sale_payments, this just adds currency/rate/
// tendered_amount columns to that same line rather than a parallel table.
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
// Test-Infrastructure Fix (Hardcoded Test Dates): every startShift() call in
// this file used to open a shift for a fixed calendar date. completeSale()
// (pos.js) always calls shiftBlockReason() with no explicit `now`, so
// eod.js's businessDateToday() falls back to the REAL device clock — the
// shift-open date and "today" only agreed on the day this file was written,
// and every sale in this suite would start failing with "the shift hasn't
// been completed yet" the moment a real day rolled over. TODAY/T() derive
// the date from the real clock at test-run time instead, so they always
// agree, on any day this suite runs — see test/eod-shift.test.js for the
// same fix applied to date-rollover tests that also need a real "yesterday".
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
// 1 base = 13000 ZWL, 1 base = 18 ZAR — plausible offline-set rates for the tests below.
function addZWL(app, rate){ return app.api.saveCurrency({ code:"ZWL", name:"Zimbabwe Gold", symbol:"ZiG", rate: rate==null?13000:rate }); }
function addZAR(app, rate){ return app.api.saveCurrency({ code:"ZAR", name:"South African Rand", symbol:"R", rate: rate==null?18:rate }); }

(async()=>{
  // ================= regression: single-currency sale unchanged =================
  await t("single-currency sale (regression): defaults to BASE, tendered_amount mirrors amount, rate 1", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 3);
    A.hook("printReceipt", ()=>{});
    A.api.completeSale("Cash");
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.method,"Cash");
    assert.strictEqual(sale.total,30);
    const payments = A.api.salePayments(sale.id);
    assert.strictEqual(payments.length,1);
    assert.strictEqual(payments[0].currency, A.api.BASE_CURRENCY_CODE);
    assert.strictEqual(payments[0].rate,1);
    assert.strictEqual(payments[0].amount,30);
    assert.strictEqual(payments[0].tendered_amount,30,"tendered == base-equivalent for a base-currency line");
  });

  // ================= a single non-base-currency payment line =================
  await t("a single payment line in a non-base currency is converted and stored correctly", ()=>{
    const A = rig();
    addZWL(A, 13000); // 1 base = ZWL 13000
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 1); // total $10
    A.hook("printReceipt", ()=>{});
    A.api.completeSale(null, [{method:"Cash", amount:130000, currency:"ZWL"}]); // ZWL 130,000 == $10 at this rate
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.method,"Cash","a single foreign-currency line still collapses to a plain method, not 'Split'");
    assert.strictEqual(sale.total,10,"the sale total itself stays in the base currency");
    const p = A.api.salePayments(sale.id)[0];
    assert.strictEqual(p.currency,"ZWL");
    assert.strictEqual(p.rate,13000);
    assert.strictEqual(p.tendered_amount,130000,"the actual ZWL handed over");
    assert.strictEqual(p.amount,10,"base-currency equivalent used everywhere else (EOD, credit, reports)");
  });

  // ================= split-tender mixing base and non-base currency =================
  await t("a split-tender sale mixing base and non-base currency lines converts and balances correctly", ()=>{
    const A = rig();
    addZWL(A, 13000);
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 5); // total $50
    A.setField("paymentRef","REF-MC1"); // an EcoCash line is present below
    A.hook("printReceipt", ()=>{});
    // $30 cash (base) + ZWL 260,000 EcoCash (== $20 at 13000) = $50 total
    A.api.completeSale(null, [{method:"Cash",amount:30,currency:"BASE"},{method:"EcoCash",amount:260000,currency:"ZWL"}]);
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.method,"Split");
    assert.strictEqual(sale.total,50);
    const payments = A.api.salePayments(sale.id);
    assert.strictEqual(payments.length,2);
    const cash = payments.find(p=>p.method==="Cash"), eco = payments.find(p=>p.method==="EcoCash");
    assert.strictEqual(cash.currency,"BASE"); assert.strictEqual(cash.amount,30); assert.strictEqual(cash.tendered_amount,30);
    assert.strictEqual(eco.currency,"ZWL"); assert.strictEqual(eco.tendered_amount,260000); assert.strictEqual(eco.amount,20);
  });

  // ================= EOD separates cash-on-hand by currency =================
  await t("EOD reconciliation correctly separates cash-on-hand by currency", ()=>{
    const A = rig();
    addZWL(A, 13000);
    addZAR(A, 18);
    const rice = addProduct(A,{name:"Rice",price:10,stock:200});
    const now = T("08:00:00");
    A.api.startShift("50", now);
    A.hook("printReceipt", ()=>{});
    setCart(A, rice, 3); A.api.completeSale("Cash");                                           // $30 base cash
    setCart(A, rice, 5); A.api.completeSale(null,[{method:"Cash",amount:130000,currency:"ZWL"}]); // ZWL 130,000 == $10 base cash
    setCart(A, rice, 2); A.api.completeSale(null,[{method:"Cash",amount:180,currency:"ZAR"}]);     // ZAR 180 == $10 base cash
    const totals = A.api.eodTotalsFor("Boka",TODAY,50);
    assert.strictEqual(totals.cash,50,"blended base-currency total unchanged: 30+10+10");
    assert.strictEqual(totals.expected,50+50);
    const byCur = {}; totals.cashByCurrency.forEach(r=>byCur[r.currency]=r);
    assert.strictEqual(Object.keys(byCur).length,3,"BASE, ZWL and ZAR each isolated");
    assert.strictEqual(byCur.BASE.tendered,30); assert.strictEqual(byCur.BASE.amount,30);
    assert.strictEqual(byCur.ZWL.tendered,130000,"the physical ZWL count, not its base-equivalent");
    assert.strictEqual(byCur.ZWL.amount,10);
    assert.strictEqual(byCur.ZAR.tendered,180);
    assert.strictEqual(byCur.ZAR.amount,10);
    const closed = A.api.completeEOD("100","",T("20:00:00")); // counted against the blended expected figure
    assert.strictEqual(closed.variance,0);
  });

  // ================= rate changes never alter a past sale =================
  await t("a rate change after a sale does not alter that sale's already-recorded base-currency-equivalent amount", ()=>{
    const A = rig();
    addZWL(A, 13000);
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 1);
    A.hook("printReceipt", ()=>{});
    A.api.completeSale(null,[{method:"Cash",amount:130000,currency:"ZWL"}]); // $10 at rate 13000
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    const before = A.api.salePayments(sale.id)[0];
    assert.strictEqual(before.amount,10); assert.strictEqual(before.rate,13000); assert.strictEqual(before.tendered_amount,130000);
    // The rate moves substantially the next day...
    const zwl = A.api.one("SELECT * FROM currencies WHERE code='ZWL'");
    A.api.saveCurrency({ id:zwl.id, code:"ZWL", name:zwl.name, symbol:zwl.symbol, rate:26000, active:true });
    assert.strictEqual(A.api.getCurrencyByCode("ZWL").rate,26000,"the rate really did change going forward");
    // ...but the historical sale's own recorded rate/amounts are untouched.
    const after = A.api.salePayments(sale.id)[0];
    assert.strictEqual(after.amount,10,"base-currency-equivalent unchanged by the later rate move");
    assert.strictEqual(after.rate,13000,"the rate AT THE TIME OF SALE is what's kept, not today's rate");
    assert.strictEqual(after.tendered_amount,130000);
    // EOD for that historical date also still reports the original figures.
    const totals = A.api.eodTotalsFor("Boka",TODAY,0);
    assert.strictEqual(totals.cash,10);
    assert.strictEqual(totals.cashByCurrency.find(r=>r.currency==="ZWL").tendered,130000);
  });

  // ================= no configured rate is blocked, not 1:1 or a crash =================
  await t("accepting a currency with no configured rate is blocked with a clear message — nothing is written", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 1);
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale(null,[{method:"Cash",amount:999,currency:"XYZ"}]); // never configured
    assert.ok(/XYZ.*isn't an accepted currency|no valid exchange rate/i.test(alerted), alerted);
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0,"blocked before any write, not treated as 1:1");
    assert.strictEqual(A.api.all("SELECT * FROM sale_payments").length,0);
  });

  await t("a currency saved with a zero/blank rate is refused outright (saveCurrency itself), and an inactive currency is also blocked at checkout", ()=>{
    const A = rig();
    assert.throws(()=>A.api.saveCurrency({code:"ZWL",rate:0}), /rate greater than 0/);
    assert.throws(()=>A.api.saveCurrency({code:"ZWL",rate:""}), /rate greater than 0/);
    const zwl = addZWL(A, 13000);
    A.api.saveCurrency({ id:zwl.id, code:"ZWL", name:zwl.name, symbol:zwl.symbol, rate:13000, active:false }); // deactivated
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 1);
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale(null,[{method:"Cash",amount:130000,currency:"ZWL"}]);
    assert.ok(/ZWL/.test(alerted), alerted);
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0);
  });

  // ================= payment-method / currency breakdown report =================
  await t("payment-method/currency breakdown totals are correct across a mix of base and foreign-currency sales", ()=>{
    const A = rig();
    addZWL(A, 13000);
    const rice = addProduct(A,{name:"Rice",price:10,stock:200});
    A.api.startShift("0", T("08:00:00"));
    A.setField("paymentRef","REF-BRK2");
    A.hook("printReceipt", ()=>{});
    setCart(A, rice, 2); A.api.completeSale("Cash");                                                 // Cash/BASE $20
    setCart(A, rice, 1); A.api.completeSale(null,[{method:"Cash",amount:130000,currency:"ZWL"}]);      // Cash/ZWL tendered 130000 == $10
    setCart(A, rice, 5); A.api.completeSale(null,[{method:"Cash",amount:30},{method:"EcoCash",amount:20}]); // Cash/BASE $30 + EcoCash/BASE $20
    const rows = A.api.paymentMethodCurrencyTotals("Boka",TODAY+"T00:00:00",TODAY+"T23:59:59");
    const key = (m,c)=> m+"|"+c;
    const byKey = {}; rows.forEach(r=>byKey[key(r.method,r.currency)]=r);
    assert.strictEqual(byKey["Cash|BASE"].total,50,"20 (plain) + 30 (split line), base only");
    assert.strictEqual(byKey["Cash|BASE"].tendered,50);
    assert.strictEqual(byKey["Cash|ZWL"].tendered,130000,"the physical ZWL total, not its base-equivalent");
    assert.strictEqual(byKey["Cash|ZWL"].total,10,"base-currency-equivalent");
    assert.strictEqual(byKey["EcoCash|BASE"].total,20);
    // The plain method-only breakdown (paymentMethodTotals, from the Split-Tender task) stays a pure base-currency total, unaffected.
    const plain = A.api.paymentMethodTotals("Boka",TODAY+"T00:00:00",TODAY+"T23:59:59");
    const plainByMethod = {}; plain.forEach(r=>plainByMethod[r.method]=r.total);
    assert.strictEqual(plainByMethod.Cash,60,"20 + 10 (ZWL's base-equivalent) + 30 — all methods blended into base currency, exactly as before this feature");
    assert.strictEqual(plainByMethod.EcoCash,20);
  });

  // ================= merge carries currency/rate/tendered detail =================
  await t("merging in a branch's exported database also copies a foreign-currency line's currency/rate/tendered_amount, not just its base-equivalent", ()=>{
    const M = rig({ branch_name:"Main" });
    const R = rig({ branch_name:"Boka" });
    addZWL(R, 13000);
    const rice = addProduct(R,{name:"Rice",price:10,stock:50});
    R.api.startShift("0", T("08:00:00"));
    R.hook("printReceipt", ()=>{});
    setCart(R, rice, 1);
    R.api.completeSale(null,[{method:"Cash",amount:130000,currency:"ZWL"}]);
    M.api.mergeDatabase({ __db: R.db }); // Main has no ZWL configured at all — the merge must still carry the raw facts
    const mergedSale = M.api.one("SELECT * FROM sales WHERE branch='Boka' ORDER BY id DESC LIMIT 1");
    const mergedPayment = M.api.salePayments(mergedSale.id)[0];
    assert.strictEqual(mergedPayment.currency,"ZWL");
    assert.strictEqual(mergedPayment.rate,13000);
    assert.strictEqual(mergedPayment.tendered_amount,130000);
    assert.strictEqual(mergedPayment.amount,10);
  });

  // ================= backward compatibility: pre-feature sale_payments rows =================
  await t("pre-multi-currency sale_payments rows (no currency column values yet) are backfilled to BASE, not left null", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 2);
    A.hook("printReceipt", ()=>{});
    A.api.completeSale("Cash");
    // Simulate a sale_payments row inserted by a build from before this task
    // (the Split-Tender feature's own schema, i.e. no currency/rate/tendered_amount columns populated).
    A.api.run("INSERT INTO sales(ts,subtotal,discount,total,method,branch) VALUES(?,?,?,?,?,?)",
      ["2026-01-05T10:00:00Z",25,0,25,"Cash","Boka"]);
    const oldSale = A.api.one("SELECT * FROM sales WHERE ts='2026-01-05T10:00:00Z'");
    A.api.run("INSERT INTO sale_payments(sale_id,method,amount) VALUES(?,?,?)",[oldSale.id,"Cash",25]);
    assert.strictEqual(A.api.one("SELECT tendered_amount FROM sale_payments WHERE sale_id=?",[oldSale.id]).tendered_amount, null);
    A.api.migrate(A.db);
    const backfilled = A.api.one("SELECT * FROM sale_payments WHERE sale_id=?",[oldSale.id]);
    assert.strictEqual(backfilled.currency,"BASE");
    assert.strictEqual(backfilled.rate,1);
    assert.strictEqual(backfilled.tendered_amount,25,"backfilled equal to amount, correct by definition for a base-currency line");
    const totals = A.api.eodTotalsFor("Boka","2026-01-05",0);
    assert.strictEqual(totals.cash,25);
    assert.strictEqual(totals.cashByCurrency[0].currency,"BASE");
    assert.strictEqual(totals.cashByCurrency[0].tendered,25);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
