// Run: node --no-warnings test/stocktake-search-e2e.test.js
// Stocktake Multi-Token Search Engine — real DOM (jsdom), real
// src/stocktake.js, not a direct-API bypass. test/stocktake-search.test.js
// already covers the ranking algorithm itself (rankProductsBySearch) in
// isolation; this file proves the actual counting-screen wiring: the
// search box exists, typing into it re-renders ONLY the results table
// (never losing focus — same anti-focus-loss idiom this app already fixed
// for split-tender/line-item-discount, applied here via the
// renderProductsTableOnly()-style targeted patch, not full innerHTML
// rebuilds), and that the "Counted X of Y" summary keeps reporting the
// TRUE total regardless of what's currently filtered.
"use strict";
const assert = require("assert");
const { JSDOM } = require("jsdom");
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");

class Compat {
  constructor(){ this.h = new DatabaseSync(":memory:"); }
  run(sql, params){ if(params && params.length) this.h.prepare(sql).run(...params); else this.h.exec(sql); }
  prepare(sql){
    const st = this.h.prepare(sql); let rows=null, i=0, p=[];
    return { bind:(x)=>{ p=x||[]; }, step(){ if(rows===null) rows=st.all(...p); return i<rows.length; },
             getAsObject(){ return {...rows[i++]}; }, free(){} };
  }
}

function makeDomApp(settings){
  const dom = new JSDOM(`<!DOCTYPE html><body><div id="app"></div></body>`, { url: "http://localhost/" });
  const window = dom.window;
  const document = window.document;
  const db = new Compat();
  const sqlCtor = function(x){ return x && x.__db ? x.__db : new Compat(); };

  const ctx = vm.createContext(Object.assign(window, {
    console, SQLctor: sqlCtor, __db: db,
    alert: ()=>{}, confirm: ()=>true, printNow: ()=>{},
    $app: document.getElementById("app"),
  }));

  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="reports", cart=[];
    let sessionStaffId=null, moreTab="stocktake", settingsUnlocked=false, drawerOpen=false;
    let stocktakeReportId=null, stocktakeQuery="";
    async function persist(){}
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
  `;
  const files = ["db.js","utils.js","eod.js","stocktake.js"];
  const code = prelude + files.map(src).join("\n");
  vm.runInContext(code, ctx, { filename: "app-sources" });
  vm.runInContext(`db.run(SCHEMA); migrate(db);`, ctx);
  Object.entries(settings||{}).forEach(([k,v])=>{
    vm.runInContext(`setSetting(${JSON.stringify(k)}, ${JSON.stringify(String(v))});`, ctx);
  });

  return {
    ctx, db, document,
    run(sql, params){ return vm.runInContext(`run(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    one(sql, params){ return vm.runInContext(`one(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    all(sql, params){ return vm.runInContext(`all(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    exec(js){ return vm.runInContext(js, ctx); },
  };
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

function typeInto(el, text){
  let acc = "";
  for(const ch of text){
    acc += ch;
    el.value = acc;
    el.oninput({ target: el });
  }
}

function seedProducts(app){
  [
    ["Toyota Hilux 2015","HLX-2015","Aisle 1"],
    ["Toyota Hilux 2010","HLX-2010","Aisle 1"],
    ["Toyota Corolla","COR-2018","Aisle 2"],
    ["Nissan Navara","NAV-2019","Aisle 3"],
  ].forEach(([name,sku,shelf])=>{
    app.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku,shelf) VALUES(?,10,5,3,'Boka',?,?)",[name,sku,shelf]);
  });
}
function openStocktakeCounting(app){
  app.run("INSERT INTO stocktakes(branch,team_names,start_date,status,created_by,created_ts) VALUES('Boka','Tapiwa','2026-09-01','Open','Tester','2026-09-01T08:00:00Z')");
  const take = app.one("SELECT * FROM stocktakes WHERE branch='Boka'");
  app.exec(`const main = document.getElementById("app"); renderStocktakeCounting(main, ${JSON.stringify(take)});`);
  return take;
}

(async()=>{
  await t("the search box is actually rendered on the counting screen (it never had one before this task)", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main" });
    seedProducts(app);
    openStocktakeCounting(app);
    const input = app.document.getElementById("stCountSearch");
    assert.ok(input, "search input exists");
    assert.strictEqual(typeof input.oninput, "function", "actually wired, not just markup");
  });

  await t("typing a multi-token query filters and ranks the REAL table, keystroke by keystroke, without ever losing focus", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main" });
    seedProducts(app);
    const take = openStocktakeCounting(app);
    const input = app.document.getElementById("stCountSearch");
    input.focus();
    assert.strictEqual(app.document.activeElement, input);

    typeInto(input, "hilux toyota");

    // Still the exact same node — the table area was patched, not the whole screen.
    assert.strictEqual(app.document.getElementById("stCountSearch"), input, "the search input itself was never destroyed/recreated");
    assert.strictEqual(app.document.activeElement, input, "focus was never lost while typing");
    assert.strictEqual(input.value, "hilux toyota");

    const bodyText = app.document.getElementById("stCountTable").textContent;
    assert.ok(/Hilux 2015/.test(bodyText) && /Hilux 2010/.test(bodyText), "both Hilux variants shown (2/2 tokens: hilux+toyota)");
    // "Toyota Corolla" matches only 1 of the 2 tokens ("toyota") — per the
    // "best-matching subset, ranked accordingly" rule (task item 3) it still
    // shows, just ranked below the 2/2 matches, not excluded outright.
    assert.ok(/Corolla/.test(bodyText), "a 1/2-token partial match still surfaces, just lower");
    assert.ok(!/Navara/.test(bodyText), "a 0/2-token non-match (neither 'hilux' nor 'toyota') is excluded entirely");
    const idxCorolla = bodyText.indexOf("Corolla");
    const idx2015Check = bodyText.indexOf("Hilux 2015"), idx2010Check = bodyText.indexOf("Hilux 2010");
    assert.ok(idxCorolla > idx2015Check && idxCorolla > idx2010Check, "the weaker 1/2 match ranks below both 2/2 matches");
    // 2015 has all 2 tokens plus would also match a 3-token query; here both
    // match "hilux"+"toyota" equally (2/2) — same rank, original (name) order.
    const idx2015 = bodyText.indexOf("Hilux 2015"), idx2010 = bodyText.indexOf("Hilux 2010");
    assert.ok(idx2010 < idx2015, "2010 sorts first alphabetically among the tied 2/2 matches, same as the underlying ORDER BY name");
  });

  await t("a query that narrows to one product still ranks it correctly above lesser matches", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main" });
    seedProducts(app);
    const take = openStocktakeCounting(app);
    const input = app.document.getElementById("stCountSearch");
    typeInto(input, "2015");
    const bodyText = app.document.getElementById("stCountTable").textContent;
    const idx2015 = bodyText.indexOf("Hilux 2015");
    assert.ok(idx2015 >= 0, "the matching product is shown");
    assert.ok(!/Corolla/.test(bodyText) && !/Navara/.test(bodyText) && !/Hilux 2010/.test(bodyText), "everything else excluded — none of them contain '2015'");
  });

  await t("the 'Counted X of Y' summary always reports the true total, unaffected by the current search filter", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main" });
    seedProducts(app);
    const take = openStocktakeCounting(app);
    const input = app.document.getElementById("stCountSearch");
    typeInto(input, "hilux"); // narrows the visible table to 2 of 4 products
    const summary = app.document.querySelector(".muted").textContent;
    assert.ok(/Counted 0 of 4/.test(summary), `summary should still say "of 4" (all branch products), not "of 2": "${summary}"`);
  });

  await t("searching never modifies stock or any other product data (real end-to-end flow, not just the algorithm)", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main" });
    seedProducts(app);
    const before = app.all("SELECT * FROM products ORDER BY id");
    const take = openStocktakeCounting(app);
    const input = app.document.getElementById("stCountSearch");
    typeInto(input, "toyota hilux 2015 nonexistent");
    typeInto(input, "");
    const after = app.all("SELECT * FROM products ORDER BY id");
    assert.deepStrictEqual(after, before);
  });

  await t("a count typed into a visible row is still saved correctly while a search filter is active", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main" });
    seedProducts(app);
    const take = openStocktakeCounting(app);
    const input = app.document.getElementById("stCountSearch");
    typeInto(input, "hilux 2015");
    const rice = app.one("SELECT * FROM products WHERE sku='HLX-2015'");
    const countInput = app.document.querySelector(`[data-count="${rice.id}"]`);
    assert.ok(countInput, "the filtered-down row's count input is present");
    countInput.value = "3";
    countInput.onchange({ target: countInput });
    const saved = app.one("SELECT * FROM stocktake_counts WHERE stocktake_id=? AND product_id=?",[take.id, rice.id]);
    assert.ok(saved, "the count was actually persisted");
    assert.strictEqual(saved.counted_qty, 3);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
