// Run: node --no-warnings test/devicecheckin-lock-e2e.test.js
// Digital Commerce Device Check-in — UI-level lock enforcement, over a REAL
// DOM (jsdom), REAL router.js/pos.js/desktop/sales-desktop.js/products.js,
// not a direct-API bypass. test/devicecheckin.test.js already covers the
// network call and the settings it persists; this file proves those
// persisted settings actually block the two named entry points end-to-end,
// on BOTH the mobile drawer and the desktop cart panel, while leaving
// everything else (product browsing, editing existing products) usable.
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

// Same harness shape as test/line-item-discount-e2e.test.js — `desktop`
// picks mobile drawer vs desktop cart panel. products.js is loaded here
// (unlike the other jsdom suites) specifically for productModal()/Add
// Product, which needs a real document.createElement (openModal, utils.js)
// that harness.js's plain-object document stub can't provide.
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
    let searchQuery="", reportsQuery="", creditQuery="", productsQuery="", plistQuery="", plistBranch="";
    let splitTender=false, splitLines=[], fxPreviewCurrency="", quickTapCurrency="";
    async function persist(){}
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
    function printReceipt(){}
    function renderRequestsDrawer(){}
  `;
  const files = ["db.js","utils.js","pos.js","printing.js","drawer.js","currencies.js","staff.js","eod.js","devicecheckin.js","products.js","router.js"];
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

function addProduct(app){
  app.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Rice',10,50,3,'Boka','')");
  return app.one("SELECT * FROM products WHERE name='Rice'");
}
const baseSettings = { branch_name:"Boka", branch_type:"main", setup_complete:"1" };
const lockedCart = Object.assign({}, baseSettings, { dc_lock_cart:"1", dc_lock_reason:"Payment overdue since Sept 3" });
const lockedAddProduct = Object.assign({}, baseSettings, { dc_lock_add_product:"1", dc_lock_reason:"Payment overdue since Sept 3" });

function run(label, desktop){
  return (async()=>{
    // ================= Cart lock =================
    await t(`[${label}] a locked cart blocks opening it and shows the reason, via the real cart button click`, ()=>{
      const app = makeDomApp(lockedCart, desktop);
      addProduct(app);
      app.exec("drawerOpen=false;"); // starts CLOSED — the prelude's default (true) exists for other suites that need it open immediately
      app.exec("render();");
      const cartBtn = app.document.getElementById("cartBtn");
      assert.ok(cartBtn, "the cart button is present (shared topbar shell, both mobile and desktop)");
      cartBtn.onclick();
      assert.deepStrictEqual(app.alerts, ["Payment overdue since Sept 3"]);
      const drawerOpen = app.exec("drawerOpen");
      assert.strictEqual(drawerOpen, false, "the drawer never actually opened");
    });

    await t(`[${label}] an unlocked cart opens normally, exactly as before this feature`, ()=>{
      const app = makeDomApp(baseSettings, desktop);
      addProduct(app);
      app.exec("render();");
      app.document.getElementById("cartBtn").onclick();
      assert.deepStrictEqual(app.alerts, []);
      assert.strictEqual(app.exec("drawerOpen"), true);
    });

    await t(`[${label}] a lock that lands while the drawer/panel is ALREADY open still takes effect on its next render (not just the open click)`, ()=>{
      const app = makeDomApp(baseSettings, desktop); // starts unlocked
      const rice = addProduct(app);
      app.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty:1, stock:rice.stock }]);
      app.exec("render();"); // drawer/panel open with a real cart item and Pay buttons present

      const payIdBefore = desktop? "dsPayCash" : "payCash";
      assert.ok(app.document.getElementById(payIdBefore), "Pay button exists before the lock lands");

      // The lock lands mid-session (deviceCheckin() persisted it via setSetting,
      // deliberately without forcing a render — see devicecheckin.js). The
      // very next natural re-render (simulated directly here) must reflect it.
      app.exec(`setSetting("dc_lock_cart","1"); setSetting("dc_lock_reason","Payment overdue since Sept 3");`);
      app.exec(desktop? "renderPOSDesktop(document.getElementById('main'));" : "renderDrawer();");

      assert.strictEqual(app.document.getElementById(desktop? "dsPayCash" : "payCash"), null, "Pay button is gone once locked");
      assert.ok(/locked/i.test(app.document.querySelector(desktop? ".ds-cart" : "#drawer").textContent), "a lock notice is shown in its place");
    });

    // ================= Add Product lock =================
    await t(`[${label}] a locked Add-Product blocks the Add flow but leaves Edit (and everything else) usable`, ()=>{
      const app = makeDomApp(lockedAddProduct, desktop);
      const rice = addProduct(app);
      app.exec(`productModal();`); // Add path
      assert.deepStrictEqual(app.alerts, ["Payment overdue since Sept 3"]);
      assert.strictEqual(app.document.querySelector(".modalOverlay"), null, "no Add modal was opened");

      app.exec(`productModal(one("SELECT * FROM products WHERE id=?",[${rice.id}]));`); // Edit path
      assert.strictEqual(app.alerts.length, 1, "still just the one alert from the Add attempt — Edit was never blocked");
      assert.ok(app.document.querySelector(".modalOverlay"), "the Edit modal opened normally");
    });

    await t(`[${label}] an unlocked shop can still add a product normally`, ()=>{
      const app = makeDomApp(baseSettings, desktop);
      app.exec(`productModal();`);
      assert.deepStrictEqual(app.alerts, []);
      assert.ok(app.document.querySelector(".modalOverlay"), "the Add modal opened");
    });

    // ================= message cards =================
    await t(`[${label}] pending messages show as dismissible cards on the Sell screen, and dismissing one persists`, ()=>{
      const app = makeDomApp(baseSettings, desktop);
      app.run(`INSERT INTO settings(key,value) VALUES('dc_messages',?)`,
        [JSON.stringify([{ id:"m1", title:"Reminder", body:"Payment due Friday", created_at:"2026-09-20T10:00:00Z", dismissed:false }])]);
      app.exec("render();");
      const card = app.document.querySelector('[data-dc-msg="m1"]');
      assert.ok(card, "the message card is rendered");
      assert.ok(/Reminder/.test(card.textContent) && /Payment due Friday/.test(card.textContent));

      app.document.querySelector('[data-dc-dismiss="m1"]').onclick();
      assert.strictEqual(app.document.querySelector('[data-dc-msg="m1"]'), null, "gone after dismiss (re-rendered)");
      const stored = JSON.parse(app.one("SELECT value FROM settings WHERE key='dc_messages'").value);
      assert.strictEqual(stored[0].dismissed, true, "the dismissal was actually persisted, not just visual");
    });

    await t(`[${label}] no banner at all when there are no pending messages (unaffected by default)`, ()=>{
      const app = makeDomApp(baseSettings, desktop);
      app.exec("render();");
      assert.strictEqual(app.document.querySelector("[data-dc-msg]"), null);
    });
  })();
}

(async()=>{
  await run("mobile drawer", false);
  await run("desktop cart panel", true);

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
