// Run: node --no-warnings test/pos-search-e2e.test.js
// Full Rendering Audit — the Sell screen's product search
// (renderPOS/renderPOSListOnly, src/pos.js) had NO test coverage at all
// before this audit, which is how its bug shipped unnoticed: renderPOSListOnly()
// used to target document.querySelector("#main .card") — not unique
// whenever shiftBlockBannerHtml()/dcMessagesBannerHtml() render their own
// ".card" above the results (e.g. before any shift has been started, which
// is every fresh install's first screen). The search patch landed on the
// FIRST ".card" — the banner — overwriting its own text with filtered
// results, while the real results card below kept showing the stale,
// unfiltered list. This is a real DOM (jsdom), real src/router.js +
// src/pos.js harness, same pattern as test/cart-drawer-e2e.test.js — not a
// direct-API bypass.
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
  const dom = new JSDOM(
    `<!DOCTYPE html><body><div id="app"></div><div id="drawer"></div><div id="overlay"></div>
     <div id="reqOverlay"></div><div id="reqDrawer"></div><div id="printArea"></div></body>`,
    { url: "http://localhost/" }
  );
  const window = dom.window;
  const document = window.document;
  const db = new Compat();
  const sqlCtor = function(x){ return x && x.__db ? x.__db : new Compat(); };
  const alerts = [];

  const ctx = vm.createContext(Object.assign(window, {
    console, SQLctor: sqlCtor, __db: db,
    alert: (m)=>{ alerts.push(m); }, confirm: ()=>true, printNow: ()=>{},
    $app: document.getElementById("app"),
  }));

  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="pos", cart=[];
    let sessionStaffId=null, accessStep=1, accessSelectedStaffId=null, accessPinDigits="", accessError="";
    let moreTab="help", settingsUnlocked=false, drawerOpen=false, appliedVoucher=null;
    let searchQuery="", reportsQuery="", creditQuery="", reqDrawerOpen=false;
    let splitTender=false, splitLines=[], fxPreviewCurrency="", quickTapCurrency="";
    async function persist(){}
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
    function printReceipt(){}
    function renderRequestsDrawer(){}
  `;
  const files = ["db.js","utils.js","pos.js","printing.js","drawer.js","currencies.js","staff.js","eod.js","devicecheckin.js","router.js"];
  const code = prelude.replace(/async function persist[^\n]*\n/, "").replace(/function printReceipt\(\)\{\}[^\n]*\n/, "")
    + files.map(src).join("\n")
    + "\n;this.printReceipt = printReceipt;";

  vm.runInContext(code, ctx, { filename: "app-sources" });
  vm.runInContext(`db.run(SCHEMA); migrate(db);`, ctx);
  Object.entries(settings||{}).forEach(([k,v])=>{
    vm.runInContext(`setSetting(${JSON.stringify(k)}, ${JSON.stringify(String(v))});`, ctx);
  });

  return {
    ctx, db, document, alerts,
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

function addProducts(app){
  [["Toyota Vitz Front Bumper","VITZ-FB"],["Toyota Vitz Rear Bumper","VITZ-RB"],["Generic Widget","WID-1"]]
    .forEach(([name,sku])=> app.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES(?,10,5,3,'Boka',?)",[name,sku]));
}

function typeInto(el, text){
  let acc = "";
  for(const ch of text){ acc += ch; el.value = acc; el.oninput({ target: el }); }
}

(async()=>{
  await t("searching does not corrupt the shift-block banner and shows only matching results — the exact repro this bug came from", ()=>{
    // No shift started -> shiftBlockBannerHtml() renders its own ".card"
    // ABOVE the results, reproducing the exact precondition of the bug.
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    addProducts(app);
    app.exec("render();");

    const bannerBefore = app.document.getElementById("main").textContent;
    assert.ok(/Start a shift/.test(bannerBefore), "the shift-block banner is showing (precondition)");

    const search = app.document.getElementById("searchInput");
    typeInto(search, "vitz bumper");

    assert.ok(/Start a shift/.test(app.document.getElementById("main").textContent), "the banner's own text survived the search — not overwritten");
    const resultsArea = app.document.getElementById("posResultsArea");
    assert.ok(resultsArea, "the results container has its stable id");
    assert.strictEqual(app.document.querySelectorAll('[id="posResultsArea"]').length, 1, "exactly one results container, never duplicated");
    const names = Array.from(resultsArea.querySelectorAll(".pname")).map(el=>el.textContent);
    assert.deepStrictEqual(names.sort(), ["Toyota Vitz Front Bumper","Toyota Vitz Rear Bumper"], "only the matching products, not the stale full list");
  });

  await t("the banner's own button (Go to End of Day) still works after a search — proves the banner itself wasn't clobbered", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    addProducts(app);
    app.exec("render();");
    typeInto(app.document.getElementById("searchInput"), "vitz");
    const goBtn = app.document.getElementById("goToEodBtn");
    assert.ok(goBtn, "the banner's button still exists in the DOM");
    assert.strictEqual(typeof goBtn.onclick, "function", "and is still wired");
  });

  await t("typing keystroke by keystroke keeps the SAME search input node and never loses focus", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    addProducts(app);
    app.exec("render();");
    const search = app.document.getElementById("searchInput");
    search.focus();
    typeInto(search, "widget");
    assert.strictEqual(app.document.getElementById("searchInput"), search, "same node throughout");
    assert.strictEqual(app.document.activeElement, search, "focus never lost");
    assert.strictEqual(search.value, "widget");
  });

  await t("once a shift IS open (no banner), search still works correctly (regression guard for the non-banner case)", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    addProducts(app);
    app.exec(`startShift("0", new Date());`);
    app.exec("render();");
    assert.strictEqual(app.document.getElementById("goToEodBtn"), null, "no banner this time");
    typeInto(app.document.getElementById("searchInput"), "widget");
    const resultsArea = app.document.getElementById("posResultsArea");
    const names = Array.from(resultsArea.querySelectorAll(".pname")).map(el=>el.textContent);
    assert.deepStrictEqual(names, ["Generic Widget"]);
  });

  await t("clearing the search restores the full list via the same #posResultsArea, no duplication", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    addProducts(app);
    app.exec("render();");
    const search = app.document.getElementById("searchInput");
    typeInto(search, "vitz");
    search.value = ""; search.oninput({ target: search }); // clearing is a single event, not zero characters typed
    assert.strictEqual(app.document.querySelectorAll('[id="posResultsArea"]').length, 1);
    const names = Array.from(app.document.getElementById("posResultsArea").querySelectorAll(".pname")).map(el=>el.textContent);
    assert.strictEqual(names.length, 3, "back to the full unfiltered list");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
