// Run: node --no-warnings test/stocktake-search.test.js
//
// The product search matcher (productSearch / productMatches, src/utils.js),
// shared by Stocktake, Sell (phone and desktop), Products and every product
// picker (POS fixes, docs/pos/pos-fixes-design.md §4; owner decisions
// 2026-10-10): EVERY term must match, in any order, ignoring case, across
// name, SKU (the barcode) and the hidden search keywords. Words match the
// start of a word; numbers match whole numbers only ("5" finds 5lt and 5 kg,
// never 15lt, 50kg or 500ml); a number with a unit matches both together;
// codes (letters + digits with punctuation, or 6+ digits) match the start of
// the SKU or of a word.
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
function rig(){ return makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }); }
function addProduct(app, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku,description) VALUES(?,?,?,?,?,?,?)",
    [o.name, o.price==null?10:o.price, o.stock==null?5:o.stock, 3, "Boka", o.sku||"", o.description||""]);
  return app.api.one("SELECT * FROM products WHERE name=? AND sku=?",[o.name, o.sku||""]);
}
const names = (rows)=> JSON.parse(JSON.stringify(rows.map(p=>p.name)));
function shop(){
  const A = rig();
  for(const p of [
    { name:"Paint DURAN 5lt", sku:"PDU-5" }, { name:"Paint 15lt", sku:"P15" }, { name:"Paint 5 kg tub", sku:"P5KG" },
    { name:"Paint Gloss 500ml", sku:"PG500" }, { name:"Cement 50kg", sku:"CEM50" }, { name:"Sugar 2kg", sku:"SUG2" },
    { name:"Sugar 12kg", sku:"SUG12" }, { name:"Toyota Hilux 2015", sku:"HLX-2015" }, { name:"Toyota Corolla", sku:"COR" },
    { name:"Rice 2.5kg", sku:"6001234567890" }, { name:"Brake Pad Set", sku:"BPS", description:"hilux spare" },
    { name:"Hilux Spare Wheel", sku:"HSW" }, { name:"Primer 5ltr", sku:"PRM5" },
  ]) addProduct(A, p);
  return { A, products: A.api.all("SELECT * FROM products ORDER BY name") };
}

(async()=>{
  console.log("the owner's examples");
  await t('"duran 5lt paint" finds "Paint DURAN 5lt"', ()=>{
    const { A, products } = shop();
    assert.deepStrictEqual(names(A.api.productSearch(products, "duran 5lt paint")), ["Paint DURAN 5lt"]);
  });
  await t('"5 paint" doesn\'t find "Paint 15lt" (or 500ml)', ()=>{
    const { A, products } = shop();
    assert.deepStrictEqual(names(A.api.productSearch(products, "5 paint")).sort(), ["Paint 5 kg tub", "Paint DURAN 5lt"]);
  });
  await t('"sugar 2" finds "Sugar 2kg" but not "Sugar 12kg"', ()=>{
    const { A, products } = shop();
    assert.deepStrictEqual(names(A.api.productSearch(products, "sugar 2")), ["Sugar 2kg"]);
  });

  console.log("words, numbers, units, codes");
  await t("a word matches the start of any word, in any case: \"pai\" finds Paint; \"aint\" finds nothing", ()=>{
    const { A, products } = shop();
    assert.strictEqual(A.api.productSearch(products, "PAI").length, 4);
    assert.strictEqual(A.api.productSearch(products, "aint").length, 0);
  });
  await t('"5" finds 5lt, 5 kg and 5ltr; never 15lt, 50kg or 500ml', ()=>{
    const { A, products } = shop();
    assert.deepStrictEqual(names(A.api.productSearch(products, "5")).sort(), ["Paint 5 kg tub", "Paint DURAN 5lt", "Primer 5ltr"]);
  });
  await t('a number with a unit matches both together: "5lt" finds 5lt and 5ltr, not 15lt and not 5 kg; "5kg" finds the 5 kg tub', ()=>{
    const { A, products } = shop();
    assert.deepStrictEqual(names(A.api.productSearch(products, "5lt")).sort(), ["Paint DURAN 5lt", "Primer 5ltr"]);
    assert.deepStrictEqual(names(A.api.productSearch(products, "5kg")), ["Paint 5 kg tub"]);
  });
  await t("decimals are whole numbers too: \"2.5\" finds Rice 2.5kg, \"2\" doesn't", ()=>{
    const { A, products } = shop();
    assert.deepStrictEqual(names(A.api.productSearch(products, "2.5")), ["Rice 2.5kg"]);
    assert.ok(!names(A.api.productSearch(products, "2")).includes("Rice 2.5kg"));
  });
  await t("a code matches the start of the SKU: \"HLX-2015\", \"hlx2015\" and a barcode's first 6+ digits", ()=>{
    const { A, products } = shop();
    assert.deepStrictEqual(names(A.api.productSearch(products, "HLX-2015")), ["Toyota Hilux 2015"]);
    assert.deepStrictEqual(names(A.api.productSearch(products, "hlx2015")), ["Toyota Hilux 2015"]);
    assert.deepStrictEqual(names(A.api.productSearch(products, "600123")), ["Rice 2.5kg"]);
    assert.deepStrictEqual(names(A.api.productSearch(products, "6001234567890")), ["Rice 2.5kg"]);
  });
  await t("every term must match (no partial matches any more), in any typed order", ()=>{
    const { A, products } = shop();
    for(const q of ["Toyota Hilux 2015", "2015 Hilux Toyota", "hilux toyota", "toy 2015"])
      assert.deepStrictEqual(names(A.api.productSearch(products, q)), ["Toyota Hilux 2015"], q);
    assert.strictEqual(A.api.productSearch(products, "toyota navara").length, 0);
  });
  await t("the hidden search keywords count; name/SKU matches come first", ()=>{
    const { A, products } = shop();
    assert.deepStrictEqual(names(A.api.productSearch(products, "hilux spare")), ["Hilux Spare Wheel", "Brake Pad Set"]);
  });
  await t("a name that starts with the first word comes first", ()=>{
    const { A, products } = shop();
    assert.strictEqual(names(A.api.productSearch(products, "sugar"))[0], "Sugar 12kg");   // both start with it: the given (alphabetical) order
    assert.deepStrictEqual(names(A.api.productSearch(products, "wheel spare")), ["Hilux Spare Wheel"]);
  });
  await t("an empty or blank query returns everything, in the given order", ()=>{
    const { A, products } = shop();
    assert.strictEqual(A.api.productSearch(products, "   ").length, products.length);
    assert.ok(A.api.productMatches("", products[0]));
  });

  console.log("used everywhere products are searched");
  await t("Sell (searchProducts) and Products use the same matcher", ()=>{
    const { A } = shop();
    assert.deepStrictEqual(names(A.api.searchProducts("5 paint", "Boka")).sort(), ["Paint 5 kg tub", "Paint DURAN 5lt"]);
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "products.js"), "utf8");
    assert.ok(/return productSearch\(products, query\);/.test(src));
    const st = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "stocktake.js"), "utf8");
    assert.strictEqual((st.match(/productSearch\(products, stocktakeQuery\)/g)||[]).length, 2, "both Stocktake renders");
  });
  await t("the search matches the category (owner 2026-10-14: no category pills, search filters)", ()=>{
    const A = rig();
    addProduct(A, { name:"Tail Lamp XTrail", sku:"TLT30" });
    addProduct(A, { name:"Brake Pad Set", sku:"BPS" });
    A.api.run("UPDATE products SET category='Lighting' WHERE sku='TLT30'");
    const products = A.api.all("SELECT * FROM products ORDER BY name");
    assert.deepStrictEqual(names(A.api.productSearch(products, "light")), ["Tail Lamp XTrail"]);
    assert.deepStrictEqual(names(A.api.productSearch(products, "lighting xtrail")), ["Tail Lamp XTrail"]);
  });
  await t("the desktop Sell screen has no category pills", ()=>{
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "desktop", "sales-desktop.js"), "utf8");
    assert.ok(!/ds-pill|data-cat=/.test(src));
  });
  await t("searching never modifies any product", ()=>{
    const { A, products } = shop();
    const before = JSON.stringify(A.api.all("SELECT * FROM products"));
    A.api.productSearch(products, "toyota hilux 2015"); A.api.productSearch(products, "zz 9"); A.api.productSearch(products, "");
    assert.strictEqual(JSON.stringify(A.api.all("SELECT * FROM products")), before);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})();
