// Run: node --no-warnings test/split-tender-focus-e2e.test.js
//
// Gap this closes: test/split-tender.test.js only ever calls completeSale()
// directly with a finished payments array — it never drives the actual
// split-tender line editor's <input>/<select> elements the way a cashier
// does. That made a real regression invisible to the whole suite: the
// amount field's oninput handler (and the currency select's onchange) were
// wired to refresh() — router.js's renderDrawer(), which rebuilds the
// ENTIRE cart drawer via innerHTML on every keystroke. Rebuilding via
// innerHTML destroys and recreates every node in the drawer, including
// whichever input the cashier is mid-typing into — so the DOM node loses
// focus (and jsdom, like real browsers, moves document.activeElement off a
// detached/replaced node) after the very first character. This file renders
// the REAL cart drawer into a REAL DOM (jsdom) and drives the split-tender
// panel the way a cashier actually would: open split tender, focus the
// first payment line's amount field, type a multi-digit amount one
// character at a time, and check after EVERY keystroke that (a) the input
// is still the exact same DOM node and (b) it still has focus. Before the
// fix, this test fails after the first keystroke; after the fix, the
// derived Remaining figure still updates live without ever touching the
// input/select nodes.
//
// Test-Infrastructure Fix (Hardcoded Test Dates): startShift() below used to
// open the shift for a fixed calendar date. Neither test here actually
// reaches completeSale()/shiftBlockReason() (they only drive the
// split-tender input UI), so this couldn't cause a false failure today —
// but it's the exact same fragile pattern every other suite had, so it's
// fixed the same way: `new Date()` at test-run time instead of a string
// that stops matching "today" the day after it was written.
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

// Same harness as test/cart-drawer-e2e.test.js: a real DOM (with the
// drawer/overlay/app shell nodes router.js expects) wired to a real
// in-memory SQLite db, running the REAL src/router.js — not a copy, not a
// direct-API bypass. Duplicated locally rather than imported because none
// of the existing e2e test files export theirs (each is self-contained).
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
    console,
    SQLctor: sqlCtor,
    __db: db,
    alert: (m)=>{ alerts.push(m); },
    confirm: ()=>true,
    printNow: ()=>{},
    $app: document.getElementById("app"),
  }));

  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="pos", cart=[];
    let sessionStaffId=null, accessStep=1, accessSelectedStaffId=null, accessPinDigits="", accessError="";
    let moreTab="help", settingsUnlocked=false, drawerOpen=true, appliedVoucher=null;
    let searchQuery="", reportsQuery="", creditQuery="", reqDrawerOpen=false;
    // See test/cart-drawer-e2e.test.js's identical prelude comment: these
    // lexical lets must shadow window globals the same way state.js's do,
    // or e.g. a bare "quickTapCurrency" reference could resolve to the
    // <select id="quickTapCurrency"> element via WHATWG named access once
    // it's rendered, instead of the state variable.
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
    ctx, db, document, alerts, window,
    run(sql, params){ return vm.runInContext(`run(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    one(sql, params){ return vm.runInContext(`one(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    all(sql, params){ return vm.runInContext(`all(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    exec(js){ return vm.runInContext(js, ctx); },
    setCart(arr){ vm.runInContext(`cart = ${JSON.stringify(arr)};`, ctx); },
  };
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

function addProductAndCart(app, price, qty){
  app.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Rice',?,50,3,'Boka','')",[price]);
  const rice = app.one("SELECT * FROM products WHERE name='Rice'");
  app.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty, stock:rice.stock }]);
  return rice;
}

// Fires a real "input" event's worth of state (value + oninput) one
// character at a time, the way a browser does as a cashier types — not one
// big jump straight to the final value.
function typeInto(el, text){
  let acc = "";
  for(const ch of text){
    acc += ch;
    el.value = acc;
    el.oninput({ target: el });
  }
}

(async()=>{
  await t("typing a multi-digit amount into a split-tender payment line keeps the SAME input node and never loses focus, keystroke by keystroke", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    app.exec(`startShift("0", new Date());`);
    addProductAndCart(app, 25, 2); // cart total $50
    app.exec("startSplitTender();");
    app.exec("renderDrawer();");

    // A reference far away from the split-tender panel, in a part of the
    // drawer the old bug would ALSO have destroyed (the whole innerHTML was
    // rebuilt, not just the panel) — proves this is a real "nothing in the
    // drawer got rebuilt" check, not just a coincidence about this one input.
    const closeDrawerBefore = app.document.getElementById("closeDrawer");

    const amountInput = app.document.querySelector('[data-split-amount="0"]');
    assert.ok(amountInput, "the first payment line's amount field is rendered");
    amountInput.focus();
    assert.strictEqual(app.document.activeElement, amountInput, "focus lands on the field once clicked/tapped, same as a real cashier");

    typeInto(amountInput, "45");

    const amountInputAfter = app.document.querySelector('[data-split-amount="0"]');
    assert.strictEqual(amountInputAfter, amountInput, "still the exact same DOM node after two keystrokes — not destroyed and recreated");
    assert.strictEqual(app.document.activeElement, amountInput, "focus was never lost while typing");
    assert.strictEqual(amountInput.value, "45", "the typed value is intact");
    assert.strictEqual(app.document.getElementById("closeDrawer"), closeDrawerBefore, "the rest of the drawer was never rebuilt either");

    // Live-updating Remaining must still work (item 5 of the report) —
    // just without rebuilding anything to do it. $50 total, $45 on this
    // line, second line (EcoCash) still blank -> $5 still owed.
    assert.strictEqual(app.document.getElementById("splitRemaining").textContent, "$5.00");

    const state = app.exec("JSON.stringify(splitLines)");
    assert.strictEqual(JSON.parse(state)[0].amount, "45", "the state array actually reflects what was typed, not just the DOM");
  });

  await t("changing a split-tender line's currency updates its equivalent message and Remaining without rebuilding the drawer", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    app.run("INSERT INTO currencies(code,name,symbol,rate,active) VALUES('ZWL','Zimbabwe Gold','ZiG',10,1)");
    app.exec(`startShift("0", new Date());`);
    addProductAndCart(app, 10, 1); // cart total $10
    app.exec("startSplitTender();");
    app.exec("renderDrawer();");

    const amountInput = app.document.querySelector('[data-split-amount="0"]');
    typeInto(amountInput, "100");
    // Still base currency at this point: $100 on a $10 sale -> overpaid by $90.
    assert.strictEqual(app.document.getElementById("splitRemaining").textContent, "$-90.00");

    const currencySelect = app.document.querySelector('[data-split-currency="0"]');
    const currencySelectBefore = currencySelect;
    const amountInputBefore = amountInput;
    currencySelect.value = "ZWL";
    currencySelect.onchange({ target: currencySelect });

    assert.strictEqual(app.document.querySelector('[data-split-currency="0"]'), currencySelectBefore, "the select itself wasn't recreated");
    assert.strictEqual(app.document.querySelector('[data-split-amount="0"]'), amountInputBefore, "switching currency didn't touch the amount field either");

    // 100 ZWL at rate 10 (ZWL per base) = $10 base -> exactly balances the $10 sale.
    assert.strictEqual(app.document.getElementById("splitRemaining").textContent, "$0.00");
    const msg = app.document.getElementById("splitMsg-0");
    assert.ok(/at this device's current rate/.test(msg.textContent), "the equivalent message updated in place: "+msg.textContent);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
