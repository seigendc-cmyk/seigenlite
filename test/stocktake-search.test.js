// Run: node --no-warnings test/stocktake-search.test.js
// Stocktake Multi-Token Search Engine (rankProductsBySearch, src/utils.js).
// Investigation finding (see summary): Stocktake's counting screen
// (renderStocktakeCounting, src/stocktake.js) had NO search of any kind
// before this task — it listed every branch product in one table. The
// app's existing any-order matcher (matchesAnyOrder, used by pos.js's
// searchProducts, products.js's filterProductsList, credit.js, help.js and
// reports.js) is a plain include/exclude filter with no ranking, so it's
// left completely unchanged here — rankProductsBySearch is new, reuses its
// tokenization rule (searchTokens), and is Stocktake's own to start with.
// These tests exercise it directly (a pure function over plain product
// rows) — the real render/search-box wiring is covered separately in
// test/stocktake-search-e2e.test.js.
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

(async()=>{
  // ================= word-order independence =================
  await t("finds the same product regardless of typed word order (all four example variations)", ()=>{
    const A = rig();
    addProduct(A, { name:"Toyota Hilux 2015", sku:"HLX-2015" });
    const products = A.api.all("SELECT * FROM products");
    ["Toyota Hilux 2015", "2015 Hilux Toyota", "Hilux Toyota", "Toyota 2015 Hilux"].forEach(q=>{
      const results = A.api.rankProductsBySearch(products, q);
      assert.strictEqual(results.length, 1, `query "${q}" should find exactly one product`);
      assert.strictEqual(results[0].name, "Toyota Hilux 2015", `query "${q}"`);
    });
  });

  // ================= single-token / substring search =================
  await t("a single token alone still finds the product ('Hilux' by itself)", ()=>{
    const A = rig();
    addProduct(A, { name:"Toyota Hilux 2015", sku:"HLX-2015" });
    addProduct(A, { name:"Toyota Corolla 2018", sku:"COR-2018" });
    const products = A.api.all("SELECT * FROM products");
    const results = A.api.rankProductsBySearch(products, "Hilux");
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, "Toyota Hilux 2015");
  });

  // ================= SKU-only search =================
  await t("searching by SKU alone finds the product even when no typed token appears in the name", ()=>{
    const A = rig();
    addProduct(A, { name:"Toyota Hilux 2015", sku:"HLX-2015" });
    addProduct(A, { name:"Toyota Corolla 2018", sku:"COR-2018" });
    const products = A.api.all("SELECT * FROM products");
    const results = A.api.rankProductsBySearch(products, "HLX-2015");
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].sku, "HLX-2015");
  });

  // ================= mixed-case =================
  await t("mixed-case queries match regardless of the case typed or stored", ()=>{
    const A = rig();
    addProduct(A, { name:"Toyota Hilux 2015", sku:"HLX-2015" });
    const products = A.api.all("SELECT * FROM products");
    ["TOYOTA HILUX", "toyota hilux", "ToYoTa HiLuX"].forEach(q=>{
      const results = A.api.rankProductsBySearch(products, q);
      assert.strictEqual(results.length, 1, `query "${q}"`);
    });
  });

  // ================= whitespace tolerance =================
  await t("extra/duplicate spaces between tokens are ignored", ()=>{
    const A = rig();
    addProduct(A, { name:"Toyota Hilux 2015", sku:"HLX-2015" });
    const products = A.api.all("SELECT * FROM products");
    const results = A.api.rankProductsBySearch(products, "  Toyota    Hilux   ");
    assert.strictEqual(results.length, 1);
  });

  // ================= ranking by token-match count =================
  await t("multiple similar products are ranked with more matching tokens first", ()=>{
    const A = rig();
    // 3/3 tokens
    addProduct(A, { name:"Toyota Hilux 2015" });
    // 2/3 tokens (Toyota Hilux, different year)
    addProduct(A, { name:"Toyota Hilux 2010" });
    // 1/3 tokens (Toyota only)
    addProduct(A, { name:"Toyota Corolla" });
    // 0/3 tokens
    addProduct(A, { name:"Nissan Navara" });
    const products = A.api.all("SELECT * FROM products");
    const results = A.api.rankProductsBySearch(products, "Toyota Hilux 2015");
    assert.strictEqual(results.length, 3, "the 0-token match (Nissan Navara) is excluded entirely");
    // JSON round-trip: objects returned from the vm-sandboxed app live in a
    // different realm, so deepStrictEqual's prototype check fails on
    // otherwise-identical plain arrays/strings — a harness quirk, not app logic.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(results.map(p=>p.name))), ["Toyota Hilux 2015", "Toyota Hilux 2010", "Toyota Corolla"]);
  });

  await t("equal token-match counts are broken by preferring name/SKU matches over description-only matches", ()=>{
    const A = rig();
    // token "spare" matches only in description
    addProduct(A, { name:"Brake Pad Set", description:"spare part for Hilux" });
    // token "spare" matches in the name itself
    addProduct(A, { name:"Hilux Spare Wheel", description:"" });
    const products = A.api.all("SELECT * FROM products");
    const results = A.api.rankProductsBySearch(products, "Hilux spare");
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].name, "Hilux Spare Wheel", "both matched 2 tokens, but this one matched 'spare' in the NAME, not just description");
    assert.strictEqual(results[1].name, "Brake Pad Set");
  });

  // ================= empty query =================
  await t("an empty (or whitespace-only) query returns every product, unranked/unfiltered", ()=>{
    const A = rig();
    addProduct(A, { name:"Toyota Hilux" });
    addProduct(A, { name:"Nissan Navara" });
    const products = A.api.all("SELECT * FROM products");
    assert.strictEqual(A.api.rankProductsBySearch(products, "").length, 2);
    assert.strictEqual(A.api.rankProductsBySearch(products, "   ").length, 2);
  });

  // ================= read-only: never mutates data =================
  await t("searching never modifies stock quantity or any other product field", ()=>{
    const A = rig();
    const rice = addProduct(A, { name:"Toyota Hilux 2015", sku:"HLX-2015", stock:7 });
    const before = A.api.one("SELECT * FROM products WHERE id=?",[rice.id]);
    const products = A.api.all("SELECT * FROM products");
    A.api.rankProductsBySearch(products, "toyota hilux 2015");
    A.api.rankProductsBySearch(products, "nonexistent query xyz");
    A.api.rankProductsBySearch(products, "");
    const after = A.api.one("SELECT * FROM products WHERE id=?",[rice.id]);
    assert.deepStrictEqual(after, before, "byte-for-byte unchanged by any amount of searching");
  });

  // ================= performance sanity check =================
  await t("stays fast against a few hundred products (no obviously slow per-keystroke pattern)", ()=>{
    const A = rig();
    for(let i=0;i<400;i++){
      A.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku,description) VALUES(?,?,?,?,?,?,?)",
        [`Product ${i} Widget`, 10, 5, 3, "Boka", `SKU-${i}`, `generic widget number ${i}`]);
    }
    addProduct(A, { name:"Toyota Hilux 2015", sku:"HLX-2015" });
    const products = A.api.all("SELECT * FROM products");
    assert.ok(products.length>=400);
    const start = Date.now();
    // Simulates several rapid keystrokes' worth of re-searches in a row —
    // the actual per-keystroke pattern renderStocktakeCountingListOnly() uses.
    for(const q of ["t","to","toy","toyo","toyot","toyota","toyota h","toyota hi","toyota hilux"]){
      A.api.rankProductsBySearch(products, q);
    }
    const elapsed = Date.now()-start;
    assert.ok(elapsed<500, `9 searches over ${products.length} products took ${elapsed}ms — too slow for per-keystroke use`);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
