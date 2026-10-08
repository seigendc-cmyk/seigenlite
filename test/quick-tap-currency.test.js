// Run: node --no-warnings test/quick-tap-currency.test.js
// Currency Selection on Quick-Tap Checkout: quickTapPayments() and the
// currency-aware quick-tap buttons (src/pos.js, wired in src/router.js and
// src/desktop/sales-desktop.js), over the REAL app source via the same
// harness the other suites use. quickTapPayments() is the EXACT function
// the real Cash/EcoCash/Bank/Credit button handlers call to build the
// `payments` array — these tests call it directly (not a reimplementation),
// then feed its result into the same completeSale() split-tender already
// uses, so there is nothing here that duplicates conversion/validation
// logic to test around.
"use strict";
const assert = require("assert");
const { makeApp, fixedClock } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}
function rig(o){ return fixedClock(makeApp(Object.assign({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, o||{})), NOON); }
const D = (iso)=> new Date(iso);
// Test-Infrastructure Fix (Hardcoded Test Dates): see test/multi-currency.test.js's
// identical comment — completeSale() always checks shiftBlockReason()
// against the real device clock, so a shift opened for a fixed calendar
// date looks stale (and blocks every sale) once a real day has passed since
// this file was written. TODAY/T() derive "today" from the real clock at
// test-run time instead.
// A fixed test clock (harness fixedClock): every app here believes it is
// noon in Harare on TODAY, so the shift opened at T("08:00:00") is today's
// whatever the real time is (these tests used to fail after midnight).
const TODAY = "2026-10-06";
const NOON = TODAY+"T10:00:00Z";
const T = (hms)=> D(`${TODAY}T${hms}Z`);
function addProduct(app, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES(?,?,?,?,?,?)",
    [o.name,o.price,o.stock,o.low_threshold==null?3:o.low_threshold,"Boka",o.sku||""]);
  return app.api.one("SELECT * FROM products WHERE name=?",[o.name]);
}
function setCart(app, product, qty){
  app.api.setCart([{ product_id:product.id, name:product.name, price:product.price, qty, stock:product.stock }]);
}
function addZWL(app, rate){ return app.api.saveCurrency({ code:"ZWL", name:"Zimbabwe Gold", symbol:"ZiG", rate: rate==null?13000:rate }); }
// Objects/arrays returned from the vm-sandboxed app live in a different
// realm than this test file, so assert.deepStrictEqual's prototype check
// fails even when the data is identical ("same structure but not
// reference-equal"). Round-tripping through JSON produces plain,
// same-realm values for comparison — a test-harness quirk, not app logic.
const plain = (x)=> JSON.parse(JSON.stringify(x));

(async()=>{
  // ================= regression: quick-tap in base currency unchanged =================
  await t("quick-tap sale in base currency (regression): quickTapPayments() returns undefined, completeSale behaves exactly as before", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 3);
    A.api.setQuickTapCurrency(""); // the default — nothing selected
    assert.strictEqual(A.api.quickTapPayments("Cash"), undefined, "no currency chosen -> the original call shape, not an empty array");
    A.hook("printReceipt", ()=>{});
    A.api.completeSale("Cash", A.api.quickTapPayments("Cash"));
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.method,"Cash");
    assert.strictEqual(sale.total,30);
    const p = A.api.salePayments(sale.id);
    assert.strictEqual(p.length,1);
    assert.strictEqual(p[0].currency, A.api.BASE_CURRENCY_CODE);
    assert.strictEqual(p[0].rate,1);
    assert.strictEqual(p[0].amount,30);
    assert.strictEqual(p[0].tendered_amount,30);
  });

  // ================= quick-tap in a non-base currency =================
  await t("quick-tap sale in a non-base currency is correctly converted and stored, indistinguishable downstream from an equivalent split-tender sale", ()=>{
    // Sale A: via the quick-tap Cash button with ZWL selected.
    const A = rig();
    addZWL(A, 13000); // 1 base = ZWL 13000
    const riceA = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, riceA, 1); // total $10
    A.api.setQuickTapCurrency("ZWL");
    const payments = A.api.quickTapPayments("Cash");
    assert.deepStrictEqual(plain(payments), [{ method:"Cash", amount:130000, currency:"ZWL" }], "the foreign equivalent of the $10 total at this rate");
    A.hook("printReceipt", ()=>{});
    A.api.completeSale("Cash", payments);
    const saleA = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    const pA = A.api.salePayments(saleA.id)[0];

    // Sale B: an equivalent one-line SPLIT-TENDER sale in the same currency
    // (same cart, same rate, on a separate device so nothing interferes).
    const B = rig({ branch_name:"CBD" });
    addZWL(B, 13000);
    const riceB = addProduct(B,{name:"Rice",price:10,stock:50});
    B.api.startShift("0", T("08:00:00"));
    setCart(B, riceB, 1);
    B.hook("printReceipt", ()=>{});
    B.api.completeSale(null, [{method:"Cash", amount:130000, currency:"ZWL"}]); // what the split-tender panel would submit for one balanced line
    const saleB = B.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    const pB = B.api.salePayments(saleB.id)[0];

    // Identical shape on both the sales row and the sale_payments line.
    assert.strictEqual(saleA.method, saleB.method, "quick-tap-with-currency collapses to the same plain method as a 1-line split, not 'Split'");
    assert.strictEqual(saleA.method,"Cash");
    assert.strictEqual(saleA.total, saleB.total);
    assert.strictEqual(pA.method, pB.method);
    assert.strictEqual(pA.currency, pB.currency);
    assert.strictEqual(pA.rate, pB.rate);
    assert.strictEqual(pA.tendered_amount, pB.tendered_amount);
    assert.strictEqual(pA.amount, pB.amount);

    // And every downstream reader treats it the same way (item 5): EOD
    // per-currency breakdown, the payment-method/currency report.
    const totalsA = A.api.eodTotalsFor("Boka",TODAY,0);
    const totalsB = B.api.eodTotalsFor("CBD",TODAY,0);
    assert.deepStrictEqual(
      plain(totalsA.cashByCurrency).map(r=>({currency:r.currency,tendered:r.tendered,amount:r.amount})),
      plain(totalsB.cashByCurrency).map(r=>({currency:r.currency,tendered:r.tendered,amount:r.amount}))
    );
    const rowsA = A.api.paymentMethodCurrencyTotals("Boka",TODAY+"T00:00:00",TODAY+"T23:59:59");
    const rowsB = B.api.paymentMethodCurrencyTotals("CBD",TODAY+"T00:00:00",TODAY+"T23:59:59");
    assert.deepStrictEqual(
      plain(rowsA).map(r=>({method:r.method,currency:r.currency,total:r.total,tendered:r.tendered})),
      plain(rowsB).map(r=>({method:r.method,currency:r.currency,total:r.total,tendered:r.tendered}))
    );
  });

  // ================= quick-tap with no rate / deactivated currency =================
  await t("quick-tap with a no-rate/deactivated currency is blocked with the same message split-tender uses — nothing is written", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 1);
    A.api.setQuickTapCurrency("XYZ"); // never configured at all
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale("Cash", A.api.quickTapPayments("Cash"));
    assert.ok(/XYZ.*isn't an accepted currency|no valid exchange rate/i.test(alerted), alerted);
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0);

    // Now with a currency that exists but has been deactivated — same block.
    const zwl = addZWL(A, 13000);
    A.api.saveCurrency({ id:zwl.id, code:"ZWL", name:zwl.name, symbol:zwl.symbol, rate:13000, active:false });
    A.api.setQuickTapCurrency("ZWL");
    alerted = "";
    A.api.completeSale("Cash", A.api.quickTapPayments("Cash"));
    assert.ok(/ZWL/.test(alerted), alerted);
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0);
  });

  // ================= base-currency-only shop: no UI-facing change =================
  await t("a base-currency-only shop's quick-tap flow is unaffected: no active currencies means quickTapPayments always passes through unchanged", ()=>{
    const A = rig();
    assert.strictEqual(A.api.activeCurrencies().length,0,"nothing configured");
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    setCart(A, rice, 2);
    // In the real app, state.js declares quickTapCurrency="" at load time,
    // before any screen renders — this harness doesn't load state.js, so
    // the equivalent starting point is set explicitly here. A shop with
    // zero active currencies can never set it to anything else through the
    // real UI, since quickTapCurrencySelectorHtml() returns "" (renders no
    // selector at all) whenever activeCurrencies().length===0.
    A.api.setQuickTapCurrency("");
    assert.strictEqual(A.api.quickTapPayments("Cash"), undefined);
    A.hook("printReceipt", ()=>{});
    A.api.completeSale("Cash", A.api.quickTapPayments("Cash"));
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.method,"Cash");
    assert.strictEqual(sale.total,20);
    assert.strictEqual(A.api.salePayments(sale.id)[0].currency, A.api.BASE_CURRENCY_CODE);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
