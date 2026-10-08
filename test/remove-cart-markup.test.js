// Run: node --no-warnings test/remove-cart-markup.test.js
// Remove Cart Markup Calculation, Keep Manual Discount/Override.
//
// Investigation finding (see summary): this app never had a "cost price x
// markup% = selling price" formula. The only "markup" in the cart/checkout
// flow was a manual, cashier-typed flat-amount surcharge (Markup ($) +
// Reason for markup, structurally parallel to Discount but additive) added
// on top of cartSubtotal() in cartTotals() (src/pos.js) and required on
// completeSale(). That input/field is what this task removes. Cost vs.
// selling price on the product editor (src/products.js) is a separate,
// untouched concept — never linked to the removed field. These tests run
// over the REAL app source via the same harness the other suites use.
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
// test-run time instead. (The discount tests below already used a plain
// `new Date()` for this same reason — TODAY/T() replace that ad hoc fix
// here so every test in this file uses one consistent mechanism.)
// A fixed test clock (harness fixedClock): every app here believes it is
// noon in Harare on TODAY, so the shift opened at T("08:00:00") is today's
// whatever the real time is (these tests used to fail after midnight).
const TODAY = "2026-10-06";
const NOON = TODAY+"T10:00:00Z";
const T = (hms)=> D(`${TODAY}T${hms}Z`);
function addProduct(app, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku,cost) VALUES(?,?,?,?,?,?,?)",
    [o.name,o.price,o.stock,o.low_threshold==null?3:o.low_threshold,"Boka",o.sku||"",o.cost||0]);
  return app.api.one("SELECT * FROM products WHERE name=?",[o.name]);
}
function setCart(app, product, qty, discount){
  const line = { product_id:product.id, name:product.name, price:product.price, qty, stock:product.stock };
  if(discount!==undefined) line.discount = discount;
  app.api.setCart([line]);
}
// Objects/arrays returned from the vm-sandboxed app live in a different
// realm than this test file, so assert.deepStrictEqual's prototype check
// fails even when the data is identical ("same structure but not
// reference-equal"). Round-tripping through JSON produces plain,
// same-realm values for comparison — a test-harness quirk, not app logic.
const plain = (x)=> JSON.parse(JSON.stringify(x));

(async()=>{
  // ================= cart sells at exactly the product's listed price =================
  await t("cart total is exactly price x qty (minus discount) — no cart-time markup math, even if a stray markupInput field is present", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    setCart(A, rice, 3);
    // A markupInput field, if it still existed, would once have added its
    // value on top of the subtotal — proving this has no effect proves the
    // calculation itself is gone, not just hidden from the UI.
    A.setField("markupInput","999");
    const totals = A.api.cartTotals();
    assert.strictEqual(totals.subtotal,30);
    assert.strictEqual(totals.total,30,"exactly price x qty — a stray markup field must not change it");
    assert.strictEqual(totals.markup,undefined,"markup is no longer part of the sale math at all, not just zeroed");

    A.api.startShift("0", T("08:00:00"));
    A.hook("printReceipt", ()=>{});
    A.api.completeSale("Cash");
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.total,30,"the sale itself was recorded at exactly the product's price x qty");
    assert.strictEqual(sale.subtotal,30);
    assert.strictEqual(sale.markup,0,"the historical column is written as 0 for every new sale");
    assert.strictEqual(sale.markup_reason,"");
  });

  await t("a stray markupReason field also has no effect and is never required to complete a sale", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:20,stock:10});
    setCart(A, rice, 1);
    A.setField("markupInput","50");
    A.setField("markupReason","Rush delivery");
    A.api.startShift("0", T("08:00:00"));
    A.hook("printReceipt", ()=>{});
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale("Cash");
    assert.strictEqual(alerted,"","no markup-related validation blocks the sale — the field is inert");
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.total,20);
    assert.strictEqual(sale.markup,0);
  });

  // ================= manual (now line-item) discount/override is unchanged =================
  // Discount moved from one cart-level field to a per-line amount on each
  // cart item (Line-Item Discount task) — these tests now set it via the
  // cart line's own `discount` property (what router.js's/sales-desktop.js's
  // per-line inputs actually write to), not a shared #discountInput field.
  await t("line discount still reduces the total correctly, exactly as before", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    setCart(A, rice, 3, "5"); // subtotal 30, line discount 5
    A.setField("discountReason","Bulk purchase");
    const totals = A.api.cartTotals();
    assert.strictEqual(totals.discount,5);
    assert.strictEqual(totals.total,25,"30 - 5, discount math untouched by removing markup");
    // Real "now" (not a fixed past date like the other tests in this file):
    // completeSale() calls shiftBlockReason() with no explicit date, so it
    // always checks against the real device clock — a shift opened for a
    // fixed past date would immediately look stale and block the sale.
    A.api.startShift("0", T("08:00:00"));
    A.hook("printReceipt", ()=>{});
    A.api.completeSale("Cash");
    const sale = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.discount,5);
    assert.strictEqual(sale.total,25);
    assert.strictEqual(sale.discount_reason,"Bulk purchase");
  });

  await t("discount is still blocked without a reason — the same permission rule as before, untouched by this change", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    setCart(A, rice, 2, "3");
    A.setField("discountReason",""); // left blank
    A.api.startShift("0", T("08:00:00"));
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale("Cash");
    assert.ok(/reason for the discount/.test(alerted), alerted);
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0,"blocked, nothing written");
  });

  await t("discount approval status is still tracked exactly as before: Pending without an approver, Approved with one", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    A.hook("printReceipt", ()=>{});

    setCart(A, rice, 2, "2");
    A.setField("discountReason","Loyal customer"); A.setField("discountApprovedBy","");
    A.api.completeSale("Cash");
    const pending = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(pending.discount_status,"Pending");

    setCart(A, rice, 2, "2");
    A.setField("discountApprovedBy","Manager Grace");
    A.api.completeSale("Cash");
    const approved = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(approved.discount_status,"Approved");
  });

  // ================= Margin Report is unaffected (uses actual sale price vs cost) =================
  await t("the Margin Report already computes from actual sale_items price vs cost — never the removed cart markup field, confirmed rather than assumed", ()=>{
    const A = rig();
    // cost=6, price=10: a real $4/unit margin, independent of any markup concept.
    const rice = addProduct(A,{name:"Rice",price:10,stock:50,cost:6});
    A.api.startShift("0", T("08:00:00"));
    A.hook("printReceipt", ()=>{});
    setCart(A, rice, 5); // revenue 50, cost 30, margin 20
    A.api.completeSale("Cash");
    const marginConfig = A.api.REPORT_CONFIGS.find(c=>c.id==="margin");
    assert.ok(marginConfig, "Margin Report exists");
    const { headers, rows } = marginConfig.fetch("Boka",TODAY+"T00:00:00",TODAY+"T23:59:59");
    assert.deepStrictEqual(plain(headers),["Item","Qty Sold","Revenue","Cost","Margin","Margin %"]);
    const riceRow = rows.find(r=>r[0]==="Rice");
    assert.ok(riceRow, "Rice appears in the margin report");
    assert.strictEqual(riceRow[1],5);
    assert.strictEqual(riceRow[2],"$50.00");
    assert.strictEqual(riceRow[3],"$30.00");
    assert.strictEqual(riceRow[4],"$20.00","margin = actual sale price x qty - cost x qty, unrelated to sales.markup");
  });

  // ================= historical sales are unaffected =================
  await t("a historical sale with markup>0 (from before this change) keeps its exact recorded values — migrate() never rewrites it", ()=>{
    const A = rig();
    A.api.run(`INSERT INTO sales(ts,subtotal,discount,total,method,branch,markup,markup_reason)
      VALUES(?,?,?,?,?,?,?,?)`,
      ["2026-01-05T10:00:00Z",40,0,55,"Cash","Boka",15,"Rush delivery"]);
    const before = A.api.one("SELECT * FROM sales WHERE ts='2026-01-05T10:00:00Z'");
    assert.strictEqual(before.markup,15);
    assert.strictEqual(before.total,55,"the historical total already includes the markup that was actually charged");
    A.api.migrate(A.db); A.api.migrate(A.db); // simulates upgrading over this pre-existing database, twice
    const after = A.api.one("SELECT * FROM sales WHERE ts='2026-01-05T10:00:00Z'");
    assert.deepStrictEqual(after,before,"byte-for-byte unchanged by the upgrade");
  });

  await t("the historical Sales Report and Markup Report still surface an old markup sale correctly", ()=>{
    const A = rig();
    A.api.run(`INSERT INTO sales(ts,subtotal,discount,total,method,branch,user,markup,markup_reason)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      ["2026-01-05T10:00:00Z",40,0,55,"Cash","Boka","Tendai",15,"Rush delivery"]);
    const salesConfig = A.api.REPORT_CONFIGS.find(c=>c.id==="sales");
    const salesData = salesConfig.fetch("Boka","2026-01-01T00:00:00","2026-01-10T23:59:59");
    const salesRows = salesData.rows;
    assert.strictEqual(salesRows.length,1);
    assert.strictEqual(salesRows[0][salesData.headers.indexOf("Markup")],"$15.00","Sales Report's Markup column still reads the historical value");
    assert.strictEqual(salesRows[0][salesData.headers.indexOf("Total")],"$55.00","Total column includes it, exactly as charged at the time");

    const markupConfig = A.api.REPORT_CONFIGS.find(c=>c.id==="markup");
    assert.ok(markupConfig, "the historical Markup Report itself was left in place — it's a read-only view of past data, not a cart-time calculation");
    const { rows, footer } = markupConfig.fetch("Boka","2026-01-01T00:00:00","2026-01-10T23:59:59");
    assert.strictEqual(rows.length,1);
    assert.deepStrictEqual(plain(rows[0]),["Tendai",1,"$15.00"]);
    assert.ok(/\$15\.00/.test(footer));
  });

  await t("a NEW sale never appears in the Markup Report — nothing going forward can create markup>0", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("0", T("08:00:00"));
    A.hook("printReceipt", ()=>{});
    setCart(A, rice, 4);
    A.api.completeSale("Cash");
    const markupConfig = A.api.REPORT_CONFIGS.find(c=>c.id==="markup");
    const { rows } = markupConfig.fetch("Boka",TODAY+"T00:00:00",TODAY+"T23:59:59");
    assert.strictEqual(rows.length,0,"the new sale has markup=0, so it never shows up here");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
