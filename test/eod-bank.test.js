// Run: node --no-warnings test/eod-bank.test.js
// End of Day left Bank-tender sales out of Total Sales (eodTotalsFor counted
// Cash, EcoCash and Credit only). Expected cash is unchanged: Bank isn't
// cash in the drawer. Total Sales is never stored (completeEOD keeps
// expected/counted/variance), so a closed shift's stored figures don't
// change; only a shift reconciled from now on shows the Bank line.
"use strict";
process.env.TZ = "Africa/Harare";
const assert = require("assert");
const vm = require("vm");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}
const at = (s)=> Date.parse(s+":00+02:00");
function shop(){
  const A = makeApp({ setup_complete:"1", shop_name:"Gentronix", branch_name:"Harare", branch_type:"main", currency:"$" });
  vm.runInContext(`(function(){ const R = Date; globalThis.__now = R.now();
    class D extends R { constructor(...a){ if(a.length) super(...a); else super(globalThis.__now); } static now(){ return globalThis.__now; } }
    Date = D; })()`, A.ctx);
  A.clock = (s)=>{ A.ctx.__now = at(s); };
  A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch) VALUES('Rice',1,1000,3,'RICE','Harare')");
  A.hook("printReceipt", ()=>{});
  return A;
}
function sell(A, amount, method){
  const p = A.api.one("SELECT * FROM products WHERE sku='RICE'");
  A.api.setCart([{ product_id:p.id, name:p.name, price:1, qty:amount, stock:p.stock }]);
  A.setField("paymentRef", method==="Cash"? "" : "REF1");
  A.api.completeSale(method);
}

(async()=>{
  await t("Total Sales includes Bank (before the fix: 15.00, after: 40.00); expected cash unchanged", async ()=>{
    const A = shop();
    A.clock("2026-10-07T09:00"); A.api.startShift("20");
    sell(A, 10, "Cash"); sell(A, 25, "Bank"); sell(A, 5, "EcoCash");
    const tot = A.api.eodTotalsFor("Harare", "2026-10-07", 20);
    assert.strictEqual(tot.bank, 25);
    assert.strictEqual(tot.totalSales, 40, "Cash 10 + EcoCash 5 + Bank 25 (it was 15 without Bank)");
    assert.strictEqual(tot.expected, 30, "float 20 + cash 10: Bank never in the drawer");
    const summary = A.api.eodPrintSummary(A.api.completeEOD("30"), tot, [], 30);
    assert.match(A.api.eodWhatsAppText(summary), /Sales Bank.*\$25\.00/);
  });
  await t("No Bank sales: no Bank line, totals as before", async ()=>{
    const A = shop();
    A.clock("2026-10-07T09:00"); A.api.startShift("0");
    sell(A, 10, "Cash");
    const tot = A.api.eodTotalsFor("Harare", "2026-10-07", 0);
    assert.strictEqual(tot.totalSales, 10);
    assert.doesNotMatch(A.api.eodWhatsAppText(A.api.eodPrintSummary(A.api.completeEOD("10"), tot, [], 10)), /Bank/);
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
