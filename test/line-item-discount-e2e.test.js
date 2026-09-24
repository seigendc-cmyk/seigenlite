// Run: node --no-warnings test/line-item-discount-e2e.test.js
//
// Line-Item Discount task: the cart-level "Discount ($)" field (mobile
// drawer only) was replaced with one discount input per cart line, on BOTH
// the mobile drawer (router.js) and the desktop cart panel
// (desktop/sales-desktop.js, which never had a discount field of any kind
// before this task). This file proves, against the REAL rendered DOM in
// both targets:
//   - discounting one line leaves every other line's own amount untouched
//   - discounts on several lines in the same cart sum correctly into the
//     live-updating and persisted subtotal/total
//   - typing a multi-digit discount amount never loses focus (the same
//     rebuild-loses-focus bug class split-tender's amount field had —
//     see updateSplitTenderDerived's comment in src/pos.js — fixed here by
//     updateLineDiscountDerived patching only the derived Total/reason-
//     reveal, never touching the input nodes themselves)
//   - the reason/approval gate is still enforced, and still gated once per
//     cart/checkout rather than once per discounted line
//   - completeSale() persists each line's own discount on its own
//     sale_items row
//   - a historical sale recorded before this feature (cart-level discount,
//     every sale_items.discount defaulting to 0) still displays correctly
//     in the read-only sale-detail modal — aggregate only, no per-line
//     sub-lines it never had data for
//   - desktop parity: every one of the above, driven through
//     renderPOSDesktop()/wireDesktopCartActions(), not just the mobile
//     drawer
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

// Same harness shape as test/cart-drawer-e2e.test.js and
// test/split-tender-focus-e2e.test.js — a real DOM (jsdom) wired to a real
// in-memory SQLite db, running the REAL src files, not copies or a
// direct-API bypass. `desktop` picks which cart UI gets exercised: with it
// true, desktop/sales-desktop.js is loaded too (same relative order
// build.js uses — just before main.js, which isn't loaded here), so
// router.js's own `typeof renderPOSDesktop==="function"` feature-detect
// makes render() use the desktop cart panel for the "pos" route exactly as
// it does in the real Tauri build; with it false, only the mobile drawer
// exists, exactly as in dist/dist-pwa.
function makeDomApp(settings, desktop){
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
  if(desktop) files.push("desktop/sales-desktop.js");
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

function addTwoProducts(app){
  app.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Rice',10,50,3,'Boka','')");
  app.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Beans',20,50,3,'Boka','')");
  const rice = app.one("SELECT * FROM products WHERE name='Rice'");
  const beans = app.one("SELECT * FROM products WHERE name='Beans'");
  return { rice, beans };
}

// Fires a real "input" event's worth of state (value + oninput) one
// character at a time, the way a browser does as a cashier types — not one
// big jump straight to the final value. Same helper as
// test/split-tender-focus-e2e.test.js.
function typeInto(el, text){
  let acc = "";
  for(const ch of text){
    acc += ch;
    el.value = acc;
    el.oninput({ target: el });
  }
}

function run(label, desktop){
  // Both targets go through the real render() (not renderDrawer()/
  // renderPOSDesktop() directly): it builds the #app shell from scratch,
  // including a real, document-attached <main id="main">, which desktop's
  // wireDesktopCartActions() needs (it looks up #dsSearch etc. via the
  // global `document`, which only finds attached nodes).
  const totalId = desktop? "dsTotal" : "drawerTotal";

  return (async()=>{
    // ================= discounting one line leaves the others untouched =================
    await t(`[${label}] discounting one line only changes that line's own contribution — other lines are unaffected`, ()=>{
      const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, desktop);
      app.exec(`startShift("0", new Date());`);
      const { rice, beans } = addTwoProducts(app);
      app.setCart([
        { product_id:rice.id, name:rice.name, price:rice.price, qty:2, stock:rice.stock },   // 20
        { product_id:beans.id, name:beans.name, price:beans.price, qty:1, stock:beans.stock } // 20
      ]); // subtotal 40
      app.exec("render();");

      const riceInput = app.document.querySelector(`[data-line-discount="${rice.id}"]`);
      const beansInput = app.document.querySelector(`[data-line-discount="${beans.id}"]`);
      assert.ok(riceInput && beansInput, "each line has its own discount input");

      riceInput.value = "5";
      riceInput.oninput({ target: riceInput });

      assert.strictEqual(app.document.getElementById(totalId).textContent, "$35.00", "only Rice's 20 became 15: 40 - 5");
      assert.strictEqual(beansInput.value, "", "Beans' own input was never touched by discounting Rice");

      const reasonInput = app.document.getElementById("discountReason");
      reasonInput.value = "Bulk purchase";
      reasonInput.oninput({ target: reasonInput });
      const payCash = app.document.getElementById(desktop? "dsPayCash" : "payCash");
      payCash.onclick();

      assert.deepStrictEqual(app.alerts, []);
      const sale = app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
      assert.strictEqual(sale.subtotal, 40);
      assert.strictEqual(sale.discount, 5);
      assert.strictEqual(sale.total, 35);
      const items = app.all("SELECT * FROM sale_items WHERE sale_id=?",[sale.id]);
      assert.strictEqual(items.find(i=>i.product_id===rice.id).discount, 5);
      assert.strictEqual(items.find(i=>i.product_id===beans.id).discount, 0, "the untouched line persisted with no discount");
    });

    // ================= discounts on multiple lines sum correctly =================
    await t(`[${label}] discounts on multiple lines in the same cart sum correctly into subtotal/total, live and persisted`, ()=>{
      const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, desktop);
      app.exec(`startShift("0", new Date());`);
      const { rice, beans } = addTwoProducts(app);
      app.setCart([
        { product_id:rice.id, name:rice.name, price:rice.price, qty:3, stock:rice.stock },   // 30
        { product_id:beans.id, name:beans.name, price:beans.price, qty:2, stock:beans.stock } // 40
      ]); // subtotal 70
      app.exec("render();");

      const riceInput = app.document.querySelector(`[data-line-discount="${rice.id}"]`);
      const beansInput = app.document.querySelector(`[data-line-discount="${beans.id}"]`);
      riceInput.value = "5"; riceInput.oninput({ target: riceInput });
      beansInput.value = "8"; beansInput.oninput({ target: beansInput });

      assert.strictEqual(app.document.getElementById(totalId).textContent, "$57.00", "70 - 5 - 8, live on screen after both lines were typed into");

      // Item 3 of the task: gated once per cart/checkout, not once per
      // discounted line — one reason covers both discounted lines here.
      const reasonInput = app.document.getElementById("discountReason");
      reasonInput.value = "Manager's special";
      reasonInput.oninput({ target: reasonInput });
      app.document.getElementById(desktop? "dsPayCash" : "payCash").onclick();

      assert.deepStrictEqual(app.alerts, [], "a single reason satisfied the gate for both discounted lines");
      const sale = app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
      assert.strictEqual(sale.subtotal, 70);
      assert.strictEqual(sale.discount, 13, "5 + 8");
      assert.strictEqual(sale.total, 57);
      assert.strictEqual(sale.discount_reason, "Manager's special");
      const items = app.all("SELECT * FROM sale_items WHERE sale_id=?",[sale.id]);
      assert.strictEqual(items.find(i=>i.product_id===rice.id).discount, 5);
      assert.strictEqual(items.find(i=>i.product_id===beans.id).discount, 8);
    });

    // ================= anti-focus-loss: typing a multi-digit discount never loses focus =================
    await t(`[${label}] typing a multi-digit discount amount into a line's input keeps the SAME node and never loses focus, keystroke by keystroke`, ()=>{
      const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, desktop);
      app.exec(`startShift("0", new Date());`);
      const { rice, beans } = addTwoProducts(app);
      app.setCart([
        { product_id:rice.id, name:rice.name, price:rice.price, qty:2, stock:rice.stock },
        { product_id:beans.id, name:beans.name, price:beans.price, qty:1, stock:beans.stock }
      ]);
      app.exec("render();");

      // A reference far from the discount input, in a part of the cart a
      // full rebuild would ALSO destroy — proves this is a "nothing was
      // rebuilt" check, not a coincidence about this one input.
      const refBefore = app.document.getElementById(desktop? "dsSearch" : "closeDrawer");

      const riceInput = app.document.querySelector(`[data-line-discount="${rice.id}"]`);
      riceInput.focus();
      assert.strictEqual(app.document.activeElement, riceInput, "focus lands on the field once tapped, same as a real cashier");

      typeInto(riceInput, "12");

      const riceInputAfter = app.document.querySelector(`[data-line-discount="${rice.id}"]`);
      assert.strictEqual(riceInputAfter, riceInput, "still the exact same DOM node after two keystrokes — not destroyed and recreated");
      assert.strictEqual(app.document.activeElement, riceInput, "focus was never lost while typing");
      assert.strictEqual(riceInput.value, "12", "the typed value is intact");
      assert.strictEqual(app.document.getElementById(desktop? "dsSearch" : "closeDrawer"), refBefore, "the rest of the cart was never rebuilt either");

      // Live total updated correctly at every keystroke without touching
      // any input node: 20 (2x10 Rice) + 20 (1x20 Beans) - 12 = 28.
      assert.strictEqual(app.document.getElementById(totalId).textContent, "$28.00");
    });

    // ================= gating: blocked without a reason, via the real button =================
    await t(`[${label}] a line discount without a reason is still blocked through the real Cash button, not just a direct completeSale() call`, ()=>{
      const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, desktop);
      app.exec(`startShift("0", new Date());`);
      const { rice } = addTwoProducts(app);
      app.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty:2, stock:rice.stock }]);
      app.exec("render();");

      const riceInput = app.document.querySelector(`[data-line-discount="${rice.id}"]`);
      riceInput.value = "3";
      riceInput.oninput({ target: riceInput });
      // reason deliberately left blank

      app.document.getElementById(desktop? "dsPayCash" : "payCash").onclick();

      assert.strictEqual(app.alerts.length, 1);
      assert.ok(/reason for the discount/.test(app.alerts[0]), app.alerts[0]);
      assert.strictEqual(app.all("SELECT * FROM sales").length, 0, "blocked before anything was written");
    });

    // ================= historical (pre-line-item) sales still display correctly =================
    await t(`[${label}] a historical sale recorded before this feature (cart-level discount, no per-line data) still displays correctly in the read-only sale-detail modal`, ()=>{
      // Separate app instances per sale: openModal() appends to
      // document.body and never removes the previous one, so two modals
      // opened in the same instance would stack and make substring
      // searches ambiguous between them.
      const oldApp = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, desktop);
      const { rice: oldRice } = addTwoProducts(oldApp);
      // Simulates a sale recorded before line-item discounts existed:
      // sales.discount is the historical single figure, but every
      // sale_items row defaults to discount=0 (db.js's migrate() adds the
      // column with DEFAULT 0) — never retroactively apportioned across
      // lines, exactly as item 8 of the task requires.
      oldApp.run(`INSERT INTO sales(ts,subtotal,discount,total,method,branch,discount_reason,discount_status)
        VALUES(?,?,?,?,?,?,?,?)`, ["2026-01-05T10:00:00Z",30,5,25,"Cash","Boka","Loyal customer","Approved"]);
      const oldSale = oldApp.one("SELECT * FROM sales WHERE ts='2026-01-05T10:00:00Z'");
      oldApp.run("INSERT INTO sale_items(sale_id,product_id,name,price,qty,cost,discount) VALUES(?,?,?,?,?,?,0)",
        [oldSale.id, oldRice.id, oldRice.name, oldRice.price, 3, 0]);

      oldApp.exec(`openSaleDetailModal(${oldSale.id});`);
      const modalHtml = oldApp.document.body.innerHTML;
      assert.ok(/Subtotal[\s\S]*\$30\.00/.test(modalHtml), "old sale's subtotal still shows");
      assert.ok(/Discount[\s\S]*-\$5\.00/.test(modalHtml), "old sale's aggregate discount still shows, from sales.discount");
      assert.ok(/Loyal customer/.test(modalHtml), "the historical reason still shows");
      assert.ok(/\$25\.00/.test(modalHtml), "old sale's total still shows");
      // No per-line "Discount" sub-line under the item row itself — there's
      // no per-line data for this historical sale to show (discount=0 on
      // its only sale_items row), so it must not be fabricated.
      const itemLineIdx = modalHtml.indexOf("3 x Rice");
      const nextHr = modalHtml.indexOf('class="hr"', itemLineIdx);
      const between = modalHtml.slice(itemLineIdx, nextHr);
      assert.ok(!/padding-left:12px/.test(between), "no fabricated per-line discount sub-line under the item for a historical sale");

      // A NEW-style sale, for contrast: its per-line sub-line does show and
      // sums to the same aggregate.
      const newApp = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, desktop);
      const { rice: newRice } = addTwoProducts(newApp);
      newApp.run(`INSERT INTO sales(ts,subtotal,discount,total,method,branch,discount_reason,discount_status)
        VALUES(?,?,?,?,?,?,?,?)`, ["2026-09-20T10:00:00Z",30,5,25,"Cash","Boka","Loyal customer","Approved"]);
      const newSale = newApp.one("SELECT * FROM sales WHERE ts='2026-09-20T10:00:00Z'");
      newApp.run("INSERT INTO sale_items(sale_id,product_id,name,price,qty,cost,discount) VALUES(?,?,?,?,?,?,5)",
        [newSale.id, newRice.id, newRice.name, newRice.price, 3, 0]);
      newApp.exec(`openSaleDetailModal(${newSale.id});`);
      const newModalHtml = newApp.document.body.innerHTML;
      const newItemLineIdx = newModalHtml.indexOf("3 x Rice");
      const newNextHr = newModalHtml.indexOf('class="hr"', newItemLineIdx);
      const newBetween = newModalHtml.slice(newItemLineIdx, newNextHr);
      assert.ok(/padding-left:12px/.test(newBetween) && /-\$5\.00/.test(newBetween), "the new-style sale DOES show its per-line discount sub-line, summing to the same $5.00 aggregate");
    });
  })();
}

(async()=>{
  await run("mobile drawer", false);
  await run("desktop cart panel", true);

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
