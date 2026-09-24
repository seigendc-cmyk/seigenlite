// Run: node --no-warnings test/cart-drawer-e2e.test.js
//
// Gap this closes: every other suite (including the Cart Markup Removal
// task's own tests) calls completeSale()/cartTotals() directly through the
// harness API, never router.js's renderDrawer() — so a bug in the actual
// rendered HTML, its event wiring, or an exception thrown mid-render (which
// would silently leave stale/unwired DOM behind) was structurally
// invisible to the whole suite until now. This file renders the REAL cart
// drawer into a REAL DOM (jsdom — see package.json) and drives it the way a
// cashier actually would: open the drawer, add items, type into a line's
// own Discount field, read the on-screen total, click Cash, then check what
// actually landed in the database.
//
// Line-Item Discount update: the single cart-level "Discount ($)" field
// this file originally drove was removed (Line-Item Discount task) in
// favor of one discount input per cart line (`[data-line-discount]`,
// wired by pos.js's wireLineDiscountInputs). Every discount-flavored test
// below now targets a specific line's input instead of one shared field —
// see test/line-item-discount-e2e.test.js for the multi-line math, the
// anti-focus-loss keystroke-by-keystroke proof, and desktop parity.
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

// One app instance = a real DOM (with the drawer/overlay/app shell nodes
// router.js expects) wired to a real in-memory SQLite db, running the
// REAL src/router.js — not a copy, not a direct-API bypass.
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
    // main.js's boot() normally creates/owns this; attached to the real
    // document (not detached) so router.js's own document.getElementById
    // calls after the innerHTML swap (cartBtn, overlay, ...) resolve.
    $app: document.getElementById("app"),
  }));

  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="pos", cart=[];
    let sessionStaffId=null, accessStep=1, accessSelectedStaffId=null, accessPinDigits="", accessError="";
    let moreTab="help", settingsUnlocked=false, drawerOpen=true, appliedVoucher=null;
    let searchQuery="", reportsQuery="", creditQuery="", reqDrawerOpen=false;
    // Mirrors state.js exactly. Critical here specifically because this
    // harness uses the REAL jsdom window as the vm's global object: WITHOUT
    // a lexical let declaration, a bare reference to e.g. quickTapCurrency
    // would fall through to window.quickTapCurrency — and once the drawer
    // renders a <select id="quickTapCurrency">, WHATWG "named access on the
    // Window object" makes that bare identifier silently resolve to the DOM
    // element itself instead of a string. In production this can't happen:
    // state.js's own let declarations already shadow it the same way.
    let splitTender=false, splitLines=[], fxPreviewCurrency="", quickTapCurrency="";
    async function persist(){}
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
    function printReceipt(){} // printing.js's real one is loaded (for buildReceiptBytes/paymentLineDetail),
                               // but the top-level printReceipt() itself needs a live #printArea flow we don't
                               // need for this UI-wiring test — same no-op the other suites' printReceipt hook uses.
    function renderRequestsDrawer(){} // requests.js isn't loaded; router.js's render() calls this unconditionally.
  `;
  // Real router.js + its actual runtime dependencies, same relative load
  // order build.js uses (state.js's variables are the prelude above).
  const files = ["db.js","utils.js","pos.js","printing.js","drawer.js","currencies.js","staff.js","eod.js","devicecheckin.js","router.js"];
  const code = prelude.replace(/async function persist[^\n]*\n/, "").replace(/function printReceipt\(\)\{\}[^\n]*\n/, "")
    + files.map(src).join("\n")
    + "\n;this.printReceipt = printReceipt;"; // keep printing.js's real printReceipt (it's async and no-ops safely without a printer/direct-print path)

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
    // `let cart=[]` in the prelude is a lexical binding inside the vm's
    // global scope, NOT a property of the context/window object — vm only
    // reflects `var`/function declarations onto the context object, not
    // `let`/`const`. So this must assign via runInContext (a real statement
    // executing in that scope), not `ctx.cart = arr` from the outside,
    // which would silently set an unrelated, unread property.
    setCart(arr){ vm.runInContext(`cart = ${JSON.stringify(arr)};`, ctx); },
  };
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}

function addProductAndCart(app, price, qty){
  app.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Rice',?,50,3,'Boka','')",[price]);
  const rice = app.one("SELECT * FROM products WHERE name='Rice'");
  app.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty, stock:rice.stock }]);
  return rice;
}

(async()=>{
  // ================= the exact end-to-end flow the regression report describes, now line-item =================
  await t("add item -> open drawer -> type a line's discount+reason -> displayed total updates -> Cash completes with the discounted total recorded", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    app.exec(`startShift("0", new Date());`);
    const rice = addProductAndCart(app, 10, 3); // subtotal $30

    app.exec("renderDrawer();"); // the REAL render function, not a stand-in

    assert.strictEqual(app.document.getElementById("discountInput"), null, "the old single cart-level Discount field no longer exists");
    const discountInput = app.document.querySelector(`[data-line-discount="${rice.id}"]`);
    assert.ok(discountInput, "the line's own Discount field is actually in the rendered drawer");
    assert.strictEqual(typeof discountInput.oninput, "function", "it's actually wired, not just present in markup");

    const totalBefore = app.document.getElementById("drawerTotal").textContent;
    assert.strictEqual(totalBefore, "$30.00", "no discount typed yet");

    discountInput.value = "5";
    discountInput.oninput({ target: discountInput });
    const totalAfterTyping = app.document.getElementById("drawerTotal").textContent;
    assert.strictEqual(totalAfterTyping, "$25.00", "the ON-SCREEN total actually updates live as the cashier types — this is what 'discount doesn't work' would mean to a cashier, and isolated cartTotals() calls can never observe it");

    const discountExtra = app.document.getElementById("discountExtra");
    assert.strictEqual(discountExtra.style.display, "block", "the reason field reveals itself once an amount is entered");

    const discountReasonInput = app.document.getElementById("discountReason");
    discountReasonInput.value = "Bulk purchase";
    discountReasonInput.oninput({ target: discountReasonInput });

    const payCash = app.document.getElementById("payCash");
    assert.ok(payCash && typeof payCash.onclick === "function", "the Cash button is present and wired");
    payCash.onclick(); // the REAL click handler: completeSale("Cash", quickTapPayments("Cash"))

    assert.deepStrictEqual(app.alerts, [], "no validation alert — a reason was supplied");
    const sale = app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.ok(sale, "a sale was actually recorded");
    assert.strictEqual(sale.subtotal, 30);
    assert.strictEqual(sale.discount, 5);
    assert.strictEqual(sale.total, 25, "the discount that was TYPED INTO THE REAL LINE FIELD made it all the way to the persisted total");
    assert.strictEqual(sale.discount_reason, "Bulk purchase");
    assert.strictEqual(sale.markup, 0, "cart-time markup stays gone");
    const item = app.one("SELECT * FROM sale_items WHERE sale_id=?",[sale.id]);
    assert.strictEqual(item.discount, 5, "the line's discount is persisted on its own sale_items row");
  });

  await t("discount typed on a line but the reason left blank is still blocked through the real Cash button click, not just a direct completeSale() call", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    app.exec(`startShift("0", new Date());`);
    const rice = addProductAndCart(app, 10, 2);
    app.exec("renderDrawer();");

    const discountInput = app.document.querySelector(`[data-line-discount="${rice.id}"]`);
    discountInput.value = "3";
    discountInput.oninput({ target: discountInput });
    // discountReason deliberately left blank

    app.document.getElementById("payCash").onclick();

    assert.strictEqual(app.alerts.length, 1);
    assert.ok(/reason for the discount/.test(app.alerts[0]), app.alerts[0]);
    assert.strictEqual(app.all("SELECT * FROM sales").length, 0, "blocked before anything was written, via the real button, not a bypassed call");
  });

  // ================= the class of bug this regression report hypothesized =================
  await t("the Markup UI is genuinely gone from the rendered drawer (not just from completeSale's math) and its removal did not leave the drawer in a broken/partial render", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    app.exec(`startShift("0", new Date());`);
    const rice = addProductAndCart(app, 10, 1);
    app.exec("renderDrawer();");

    assert.strictEqual(app.document.getElementById("markupInput"), null);
    assert.strictEqual(app.document.getElementById("markupReason"), null);
    assert.strictEqual(app.document.getElementById("markupExtra"), null);
    assert.strictEqual(app.document.getElementById("discountInput"), null, "the old cart-level Discount field is also gone, replaced by per-line inputs");
    // And everything AFTER where the markup block used to sit still rendered
    // and wired correctly — proves the removal wasn't a truncated/half-done
    // edit that silently swallowed the rest of the template or the wiring
    // that follows it (paymentRef, custName, the pay buttons).
    assert.ok(app.document.querySelector(`[data-line-discount="${rice.id}"]`), "the per-line discount input exists");
    ["paymentRef","custName","custPhone","payCash","payEcocash","payBank","payCredit"].forEach(id=>{
      assert.ok(app.document.getElementById(id), `#${id} exists`);
    });
  });

  await t("re-rendering the drawer multiple times (as real quantity +/- clicks and re-opens do) never throws and line discount keeps working on every pass", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    app.exec(`startShift("0", new Date());`);
    const rice = addProductAndCart(app, 10, 1);
    for(let i=0;i<4;i++) app.exec("renderDrawer();"); // simulates repeated re-renders across a session
    const discountInput = app.document.querySelector(`[data-line-discount="${rice.id}"]`);
    discountInput.value = "1";
    discountInput.oninput({ target: discountInput });
    assert.strictEqual(app.document.getElementById("drawerTotal").textContent, "$9.00");
  });

  // ================= discount still works when a foreign currency is configured =================
  // (the area right next to where markup's UI/state used to be, and the
  // newest UI addition sharing that region of the template/wiring code —
  // exactly what the regression report asked to double-check.)
  await t("line discount still works correctly even with the currency selector and fx-preview rendered alongside it", ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    app.run("INSERT INTO currencies(code,name,symbol,rate,active) VALUES('ZWL','Zimbabwe Gold','ZiG',13000,1)");
    app.exec(`startShift("0", new Date());`);
    const rice = addProductAndCart(app, 10, 4); // subtotal $40
    app.exec("renderDrawer();"); // must not throw despite quickTapCurrencySelectorHtml()/fxPreviewHtml() now rendering real content

    assert.ok(app.document.getElementById("quickTapCurrency"), "the currency selector is present (a currency is configured)");
    const discountInput = app.document.querySelector(`[data-line-discount="${rice.id}"]`);
    discountInput.value = "10";
    discountInput.oninput({ target: discountInput });
    assert.strictEqual(app.document.getElementById("drawerTotal").textContent, "$30.00");

    app.document.getElementById("discountReason").value = "Regular";
    app.document.getElementById("discountReason").oninput({ target:{ value:"Regular" } });
    app.document.getElementById("payCash").onclick(); // base currency (no currency selected) — same as a plain Cash tap
    const sale = app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(sale.discount, 10);
    assert.strictEqual(sale.total, 30);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
