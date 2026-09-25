// Run: node --no-warnings test/inventory-import.test.js
// New Inventory Import Mode — "Update Existing / Add New" (src/import.js),
// over the REAL app source via the same harness the other suites use.
//
// Investigation finding (see summary): the app already had exactly ONE
// spreadsheet-based import mode (never named/exposed as a "mode" before
// this task) that already matched by SKU-then-name and already never
// deleted absent products — findImportMatch() and the overall
// update-or-create shape are REUSED here unchanged, not reinvented. The
// one real gap fixed: it used to overwrite stock unconditionally from the
// file's Qty column (even 0 for a file with no Qty column at all); now
// quantity is only ever touched when the file has a real Qty/Quantity/
// Stock column AND the shop explicitly ticks "Also update stock quantity".
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
function rig(o){ return makeApp(Object.assign({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, o||{})); }
// A stand-in for the modal's `wrap` DOM node: runImport() only ever writes
// to wrap.querySelector(".modal-body").innerHTML and wires up a #impDone
// button — this captures the last HTML written so tests can inspect the
// final on-screen summary without needing a real DOM.
function fakeWrap(){
  const el = {};
  Object.defineProperty(el, "innerHTML", { get(){ return el._html||""; }, set(v){ el._html=v; } });
  return { querySelector: ()=> el, get summaryHtml(){ return el._html||""; } };
}
// Builds sheet_to_json-shaped rows (plain objects keyed by header text) —
// exactly what XLSX.utils.sheet_to_json({defval:""}) would hand
// parseImportRows(), so these tests exercise the real header-matching path
// too, not a shortcut around it.
function sheetRow(o){
  return Object.assign({
    "SKU":"", "Item Name":"", "Search Keywords":"", "Category":"",
    "Cost":"", "Price":"", "Qty":"", "Low Stock Alert Below":"",
  }, o);
}
function addExistingProduct(app, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku,description,category,cost) VALUES(?,?,?,?,?,?,?,?,?)",
    [o.name, o.price==null?10:o.price, o.stock==null?5:o.stock, 3, o.branch||"Boka", o.sku||"", o.description||"", o.category||"", o.cost||0]);
  return app.api.one("SELECT * FROM products WHERE name=? AND branch=?",[o.name, o.branch||"Boka"]);
}

(async()=>{
  // ================= existing product: update in place, no duplicate =================
  await t("a row matching an existing product (by SKU) updates it in place — no duplicate row is created", ()=>{
    const A = rig();
    const rice = addExistingProduct(A, { name:"Rice 2kg", sku:"RICE-2KG", price:5, cost:3 });
    const { rows } = A.api.parseImportRows([ sheetRow({ "SKU":"RICE-2KG", "Item Name":"Rice 2kg (new name)", "Price":6.5, "Cost":4, "Category":"Groceries" }) ]);
    const { toApply, duplicates, skipped } = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), { toApply, duplicates, skipped, totalRead:1 }, false);
    const all = A.api.all("SELECT * FROM products WHERE branch='Boka'");
    assert.strictEqual(all.length, 1, "still exactly one product — updated, not duplicated");
    const updated = A.api.one("SELECT * FROM products WHERE id=?",[rice.id]);
    assert.strictEqual(updated.name, "Rice 2kg (new name)");
    assert.strictEqual(updated.price, 6.5);
    assert.strictEqual(updated.cost, 4);
    assert.strictEqual(updated.category, "Groceries");
  });

  await t("a row matching an existing product by NAME (no SKU on either side) also updates in place", ()=>{
    const A = rig();
    const p = addExistingProduct(A, { name:"Sugar 2kg", price:4 });
    const { rows } = A.api.parseImportRows([ sheetRow({ "Item Name":"Sugar 2kg", "Price":4.5 }) ]);
    const { toApply, duplicates, skipped } = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), { toApply, duplicates, skipped, totalRead:1 }, false);
    assert.strictEqual(A.api.all("SELECT * FROM products WHERE branch='Boka'").length, 1);
    assert.strictEqual(A.api.one("SELECT * FROM products WHERE id=?",[p.id]).price, 4.5);
  });

  // ================= no match: create new product =================
  await t("a row with no existing match creates a new product correctly", ()=>{
    const A = rig();
    const { rows } = A.api.parseImportRows([ sheetRow({ "SKU":"OIL-2L", "Item Name":"Cooking Oil 2L", "Price":8, "Cost":5, "Qty":12, "Category":"Groceries" }) ]);
    const { toApply, duplicates, skipped } = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), { toApply, duplicates, skipped, totalRead:1 }, false);
    const p = A.api.one("SELECT * FROM products WHERE sku='OIL-2L'");
    assert.ok(p, "the new product was created");
    assert.strictEqual(p.name, "Cooking Oil 2L");
    assert.strictEqual(p.price, 8);
    assert.strictEqual(p.category, "Groceries");
    assert.strictEqual(p.stock, 12, "a brand-new product's initial stock always comes from Qty — this isn't 'changing' an existing quantity");
    assert.strictEqual(p.branch, "Boka");
  });

  // ================= mixed file: both in one pass =================
  await t("a mixed file (some updates, some new) processes both correctly in a single pass", ()=>{
    const A = rig();
    addExistingProduct(A, { name:"Rice 2kg", sku:"RICE-2KG", price:5 });
    const { rows } = A.api.parseImportRows([
      sheetRow({ "SKU":"RICE-2KG", "Item Name":"Rice 2kg", "Price":5.5 }),
      sheetRow({ "SKU":"NEW-001", "Item Name":"Brand New Item", "Price":3 }),
    ]);
    const { toApply, duplicates, skipped } = A.api.classifyImportRows(rows);
    assert.strictEqual(toApply.length, 2);
    A.api.runImport(fakeWrap(), { toApply, duplicates, skipped, totalRead:2 }, false);
    assert.strictEqual(A.api.one("SELECT * FROM products WHERE sku='RICE-2KG'").price, 5.5);
    assert.ok(A.api.one("SELECT * FROM products WHERE sku='NEW-001'"), "the new item was also created");
    assert.strictEqual(A.api.all("SELECT * FROM products WHERE branch='Boka'").length, 2);
  });

  // ================= absent products are never deleted =================
  await t("products absent from the import file are NOT deleted (unlike Replace mode)", ()=>{
    const A = rig();
    addExistingProduct(A, { name:"Untouched Product", sku:"UNTOUCH-1" });
    const { rows } = A.api.parseImportRows([ sheetRow({ "SKU":"NEW-002", "Item Name":"Something Else", "Price":2 }) ]);
    const { toApply, duplicates, skipped } = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), { toApply, duplicates, skipped, totalRead:1 }, false);
    assert.ok(A.api.one("SELECT * FROM products WHERE sku='UNTOUCH-1'"), "still there, completely untouched");
    assert.strictEqual(A.api.all("SELECT * FROM products WHERE branch='Boka'").length, 2, "2 products now: the untouched one + the new one, nothing removed");
  });

  // ================= unrelated tables untouched =================
  await t("unrelated records (customers, sales, other tables) are completely untouched", ()=>{
    const A = rig();
    A.api.run("INSERT INTO customers(name,phone,branch) VALUES('Tendai Moyo','0771234567','Boka')");
    A.api.run("INSERT INTO sales(ts,subtotal,discount,total,method,branch) VALUES('2026-09-01T10:00:00Z',10,0,10,'Cash','Boka')");
    const custBefore = A.api.all("SELECT * FROM customers");
    const salesBefore = A.api.all("SELECT * FROM sales");
    const { rows } = A.api.parseImportRows([ sheetRow({ "SKU":"NEW-003", "Item Name":"Widget", "Price":1 }) ]);
    const { toApply, duplicates, skipped } = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), { toApply, duplicates, skipped, totalRead:1 }, false);
    assert.deepStrictEqual(A.api.all("SELECT * FROM customers"), custBefore);
    assert.deepStrictEqual(A.api.all("SELECT * FROM sales"), salesBefore);
  });

  // ================= quantity opt-in: both paths =================
  await t("quantity is left untouched by default, even when the file has a Qty column with a different value", ()=>{
    const A = rig();
    const p = addExistingProduct(A, { name:"Rice 2kg", sku:"RICE-2KG", stock:20 });
    const { rows } = A.api.parseImportRows([ sheetRow({ "SKU":"RICE-2KG", "Item Name":"Rice 2kg", "Price":5, "Qty":0 }) ]);
    const { toApply, duplicates, skipped } = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), { toApply, duplicates, skipped, totalRead:1 }, false); // applyQty=false
    assert.strictEqual(A.api.one("SELECT * FROM products WHERE id=?",[p.id]).stock, 20, "stock untouched — a Qty of 0 in the file must NOT zero out real stock when not opted in");
    assert.strictEqual(A.api.all("SELECT * FROM stock_received WHERE product_id=?",[p.id]).length, 0, "no stock movement was recorded either");
  });

  await t("quantity IS applied when the shop explicitly opts in and the file has a Qty column", ()=>{
    const A = rig();
    const p = addExistingProduct(A, { name:"Rice 2kg", sku:"RICE-2KG", stock:20 });
    const { rows } = A.api.parseImportRows([ sheetRow({ "SKU":"RICE-2KG", "Item Name":"Rice 2kg", "Price":5, "Qty":35 }) ]);
    const { toApply, duplicates, skipped } = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), { toApply, duplicates, skipped, totalRead:1 }, true); // applyQty=true
    const updated = A.api.one("SELECT * FROM products WHERE id=?",[p.id]);
    assert.strictEqual(updated.stock, 35);
    const movement = A.api.one("SELECT * FROM stock_received WHERE product_id=?",[p.id]);
    assert.ok(movement, "a stock movement WAS recorded when opted in");
    assert.strictEqual(movement.qty, 15, "the delta (35-20), same convention as the pre-existing import path");
  });

  await t("parseImportRows correctly reports whether the file even HAS a Qty column, so the opt-in can be disabled when it doesn't", ()=>{
    const A = rig();
    const withQty = A.api.parseImportRows([ sheetRow({ "Item Name":"X", "Price":1, "Qty":5 }) ]);
    assert.strictEqual(withQty.hasQtyColumn, true);
    const noQtyRows = [{ "Item Name":"X", "Price":"1" }]; // no Qty/Quantity/Stock header at all
    const withoutQty = A.api.parseImportRows(noQtyRows);
    assert.strictEqual(withoutQty.hasQtyColumn, false);
  });

  // ================= branch isolation =================
  await t("branch isolation is preserved — a row never matches or updates another branch's identically-named/SKU'd product", ()=>{
    const A = rig();
    const boka = addExistingProduct(A, { name:"Rice 2kg", sku:"RICE-2KG", branch:"Boka", price:5 });
    A.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Rice 2kg',5,5,3,'CBD','RICE-2KG')");
    const cbd = A.api.one("SELECT * FROM products WHERE branch='CBD'");
    // Import runs against currentBranch() = "Boka" (the harness's default branch_name setting)
    const { rows } = A.api.parseImportRows([ sheetRow({ "SKU":"RICE-2KG", "Item Name":"Rice 2kg", "Price":9.99 }) ]);
    const { toApply, duplicates, skipped } = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), { toApply, duplicates, skipped, totalRead:1 }, false);
    assert.strictEqual(A.api.one("SELECT * FROM products WHERE id=?",[boka.id]).price, 9.99, "Boka's product was updated");
    assert.strictEqual(A.api.one("SELECT * FROM products WHERE id=?",[cbd.id]).price, 5, "CBD's identically-SKU'd product is completely untouched");
    assert.strictEqual(A.api.all("SELECT * FROM products").length, 2, "no duplicate created in either branch");
  });

  // ================= import summary accuracy =================
  await t("the import summary reports accurate counts for a mixed-result import (created/updated/duplicates/rejected)", ()=>{
    const A = rig();
    addExistingProduct(A, { name:"Rice 2kg", sku:"RICE-2KG", price:5 });
    const { rows } = A.api.parseImportRows([
      sheetRow({ "SKU":"RICE-2KG", "Item Name":"Rice 2kg", "Price":5.5 }),   // update
      sheetRow({ "SKU":"NEW-001", "Item Name":"Brand New", "Price":3 }),     // create
      sheetRow({ "SKU":"NEW-001", "Item Name":"Brand New Again", "Price":9 }), // duplicate (same SKU, later row)
      sheetRow({ "Item Name":"", "Price":2 }),                               // rejected: missing name
      sheetRow({ "Item Name":"No Price Item", "Price":"" }),                 // rejected: missing/invalid price
    ]);
    const batch = A.api.classifyImportRows(rows);
    assert.strictEqual(batch.toApply.length, 2);
    assert.strictEqual(batch.duplicates.length, 1);
    assert.strictEqual(batch.skipped.length, 2);
    const wrap = fakeWrap();
    A.api.runImport(wrap, Object.assign({}, batch, { totalRead: rows.length }), false);
    const summary = wrap.summaryHtml;
    assert.ok(/5 record/.test(summary), "records read");
    assert.ok(/1 added/.test(summary), "created count");
    assert.ok(/1 updated/.test(summary), "updated count");
    assert.ok(/1 duplicate row/.test(summary), "duplicate count");
    assert.ok(/2 row.*rejected/.test(summary), "rejected count");
    assert.strictEqual(A.api.all("SELECT * FROM products WHERE branch='Boka'").length, 2, "only the 2 genuinely-applied rows actually landed");
  });

  // ================= malformed rows: rejected and reported, not crashing =================
  await t("malformed/invalid rows are rejected and reported, not silently skipped or crashing the import", ()=>{
    const A = rig();
    const { rows } = A.api.parseImportRows([
      sheetRow({ "Item Name":"", "Price":5 }),           // missing name
      sheetRow({ "Item Name":"Valid Item", "Price":"" }), // missing price
      sheetRow({ "Item Name":"Also Valid", "Price":"not a number" }), // invalid price
      sheetRow({ "Item Name":"Good Item", "Price":4.5 }), // actually fine
    ]);
    assert.strictEqual(rows.filter(r=>r.skipReason).length, 3);
    assert.ok(/Item Name/i.test(rows[0].skipReason));
    assert.ok(/Price/i.test(rows[1].skipReason));
    assert.ok(/Price/i.test(rows[2].skipReason));
    assert.strictEqual(rows[3].skipReason, null);
    const { toApply, duplicates, skipped } = A.api.classifyImportRows(rows);
    assert.strictEqual(toApply.length, 1);
    // Must not throw even though 3 of the 4 rows are malformed.
    assert.doesNotThrow(()=> A.api.runImport(fakeWrap(), { toApply, duplicates, skipped, totalRead:4 }, false));
    assert.ok(A.api.one("SELECT * FROM products WHERE name='Good Item'"), "the one valid row still went through");
    assert.strictEqual(A.api.all("SELECT * FROM products").length, 1, "the 3 malformed rows created nothing");
  });

  // ================= field coverage / partial files =================
  await t("Shelf is imported on new products and updated on existing ones", ()=>{
    const A = rig();
    const p = addExistingProduct(A, { name:"Rice 2kg", sku:"RICE-2KG" });
    const { rows } = A.api.parseImportRows([
      Object.assign(sheetRow({ "SKU":"RICE-2KG", "Item Name":"Rice 2kg", "Price":5 }), { "Shelf":"Aisle 3" }),
      Object.assign(sheetRow({ "Item Name":"Salt 1kg", "Price":1 }), { "Shelf":"Bin 7" }),
    ]);
    const b = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), Object.assign({}, b, { totalRead:2 }), false);
    assert.strictEqual(A.api.one("SELECT shelf FROM products WHERE id=?",[p.id]).shelf, "Aisle 3");
    assert.strictEqual(A.api.one("SELECT shelf FROM products WHERE name='Salt 1kg'").shelf, "Bin 7");
  });

  await t("columns missing from the file (and blank numeric cells) leave existing values untouched", ()=>{
    const A = rig();
    const p = addExistingProduct(A, { name:"Rice 2kg", sku:"RICE-2KG", description:"rice white", category:"Groceries", cost:3 });
    A.api.run("UPDATE products SET shelf='Aisle 1', low_threshold=9 WHERE id=?",[p.id]);
    // e.g. a Remote branch's Items export: no Category/Keywords/Cost columns
    const { rows } = A.api.parseImportRows([{ "SKU":"RICE-2KG", "Item Name":"Rice 2kg", "Price":6, "Low Stock Alert Below":"" }]);
    const b = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), Object.assign({}, b, { totalRead:1 }), false);
    const u = A.api.one("SELECT * FROM products WHERE id=?",[p.id]);
    assert.strictEqual(u.price, 6);
    assert.strictEqual(u.category, "Groceries");
    assert.strictEqual(u.description, "rice white");
    assert.strictEqual(u.cost, 3);
    assert.strictEqual(u.shelf, "Aisle 1");
    assert.strictEqual(u.low_threshold, 9);
    assert.strictEqual(u.sku, "RICE-2KG");
  });

  await t("a blank Qty cell never zeroes stock, even with the opt-in ticked", ()=>{
    const A = rig();
    const p = addExistingProduct(A, { name:"Rice 2kg", stock:40 });
    const { rows } = A.api.parseImportRows([ sheetRow({ "Item Name":"Rice 2kg", "Price":5, "Qty":"" }) ]);
    const b = A.api.classifyImportRows(rows);
    A.api.runImport(fakeWrap(), Object.assign({}, b, { totalRead:1 }), true);
    assert.strictEqual(A.api.one("SELECT stock FROM products WHERE id=?",[p.id]).stock, 40);
  });

  await t("text numbers with thousands separators parse correctly; negative prices are rejected", ()=>{
    const A = rig();
    const { rows } = A.api.parseImportRows([
      sheetRow({ "Item Name":"TV", "Price":"1,200.50", "Cost":"1,000", "Qty":"12" }),
      sheetRow({ "Item Name":"Bad", "Price":"-3" }),
    ]);
    assert.strictEqual(rows[0].price, 1200.5);
    assert.strictEqual(rows[0].cost, 1000);
    assert.strictEqual(rows[0].qty, 12);
    assert.ok(/negative/i.test(rows[1].skipReason));
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
