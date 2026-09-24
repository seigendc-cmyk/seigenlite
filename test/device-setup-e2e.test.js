// Run: node --no-warnings test/device-setup-e2e.test.js
//
// Device Setup (Printer / Barcode Reader / Cash Drawer): real DOM (jsdom),
// real src/printing.js + src/drawer.js + src/scanner.js, same harness
// pattern as test/cart-drawer-e2e.test.js — not a direct-API bypass. Covers
// Step 5's requirements: each setup screen renders correctly; connection
// status displays correctly per state (connected/disconnected/error);
// printing and cash-drawer-open are proven independent of each other; the
// print queue's manual retry logic. Full Settings-page assembly (every
// section's own dependencies — rpn.js/staff.js/backup.js/sync.js/...) is
// intentionally NOT loaded here — see test/browser-audit.test.js for the
// real-browser proof that the three new cards render inside the actual
// Settings screen without blocking each other.
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
    `<!DOCTYPE html><body><div id="app"></div><div id="printArea"></div></body>`,
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
  }));

  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="pos", cart=[];
    async function persist(){}
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
  `;
  // printing.js needs BASE_CURRENCY_CODE (currencies.js) for its payment-
  // line helpers; drawer.js/scanner.js only need db.js/utils.js.
  const files = ["db.js","utils.js","currencies.js","printing.js","drawer.js","scanner.js"];
  const code = prelude.replace(/async function persist[^\n]*\n/, "")
    + files.map(src).join("\n");

  vm.runInContext(code, ctx, { filename: "app-sources" });
  vm.runInContext(`db.run(SCHEMA); migrate(db);`, ctx);
  Object.entries(settings||{}).forEach(([k,v])=>{
    vm.runInContext(`setSetting(${JSON.stringify(k)}, ${JSON.stringify(String(v))});`, ctx);
  });

  return {
    ctx, db, document, alerts,
    exec(js){ return vm.runInContext(js, ctx); },
  };
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

(async()=>{

  // ================= Printer setup screen =================
  await t("Printer setup modal renders with 'not connected' status when nothing is connected", ()=>{
    const app = makeDomApp();
    app.exec(`openPrinterSetupModal();`);
    const text = app.document.querySelector(".modalOverlay").textContent;
    assert.ok(/Not connected/.test(text), "shows the disconnected state");
  });

  await t("Printer status reflects a connected USB device by name", ()=>{
    const app = makeDomApp();
    app.exec(`window._usbPrinter = { device: { productName: "Star TSP100" }, endpointNumber: 1 };`);
    const html = app.exec(`printerStatusHtml()`);
    assert.ok(/Connected via USB/.test(html));
    assert.ok(/Star TSP100/.test(html));
  });

  await t("Printer status reflects a connected Bluetooth device by name", ()=>{
    const app = makeDomApp();
    app.exec(`window._btPrinter = { device: { name: "BT-Printer-9" }, characteristic: {} };`);
    const html = app.exec(`printerStatusHtml()`);
    assert.ok(/Connected via Bluetooth/.test(html));
    assert.ok(/BT-Printer-9/.test(html));
  });

  await t("Print test receipt reuses the real receipt path (buildReceiptBytes/printReceipt), not a separate builder", async ()=>{
    const app = makeDomApp();
    await app.exec(`printTestReceipt()`); // no direct printer connected -> falls back to #printArea/printNow(), must not throw
    const html = app.document.getElementById("printArea").innerHTML;
    assert.ok(/Sample Item/.test(html), "the fabricated test-receipt line was rendered through the real printReceipt()");
  });

  // ================= Print queue: error state + manual retry =================
  await t("a direct print failure (printer configured but unreachable) is queued, shown as an error state, and a manual retry can succeed", async ()=>{
    const app = makeDomApp();
    app.exec(`setSetting("printer_direct_configured","1");`); // shop has connected a direct printer before
    app.exec(`window._btPrinter = null; window._usbPrinter = null;`);
    app.exec(`reconnectBTPrinterSilently = async ()=> false; reconnectUSBPrinterSilently = async ()=> false;`);

    const sent = await app.exec(`sendDirect(new Uint8Array([1,2,3]), "Test job")`);
    assert.strictEqual(sent, false, "direct send failed as expected");

    let rows = app.exec(`printQueueRows()`);
    assert.strictEqual(rows.length, 1, "the failed job was queued");
    assert.strictEqual(rows[0].label, "Test job");
    assert.strictEqual(rows[0].status, "pending");

    const queueHtml = app.exec(`printQueueRowsHtml()`);
    assert.ok(/Test job/.test(queueHtml));
    assert.ok(/data-retry-print/.test(queueHtml), "a manual retry action is offered");

    // Manual retry while still unreachable -> moves to a visible error state.
    app.exec(`btPrintBytes = async ()=> false; usbPrintBytes = async ()=> false;`);
    const failedRetry = await app.exec(`retryPrintQueueJob(${rows[0].id})`);
    assert.strictEqual(failedRetry, false);
    rows = app.exec(`printQueueRows()`);
    assert.strictEqual(rows[0].status, "failed", "stays visible as a failed/error state, not silently dropped");
    assert.strictEqual(rows[0].attempts, 1);
    assert.ok(/Failed/.test(app.exec(`printQueueRowsHtml()`)));

    // Manual retry once the printer is reachable again -> succeeds and clears the queue.
    app.exec(`window._btPrinter = { device:{}, characteristic:{} }; btPrintBytes = async ()=> true;`);
    const okRetry = await app.exec(`retryPrintQueueJob(${rows[0].id})`);
    assert.strictEqual(okRetry, true);
    assert.strictEqual(app.exec(`printQueueRows()`).length, 0, "the job is cleared once it actually sends");
  });

  await t("a shop that has never connected a direct printer never gets anything queued (no behavior change from before this feature)", async ()=>{
    const app = makeDomApp(); // printer_direct_configured never set
    const sent = await app.exec(`sendDirect(new Uint8Array([9]), "Should not queue")`);
    assert.strictEqual(sent, false);
    assert.strictEqual(app.exec(`printQueueRows()`).length, 0, "falls straight through to the OS print dialog, exactly as before");
  });

  // ================= Barcode / Inventory Reader setup screen =================
  await t("Barcode reader setup modal captures a scan and shows a green confirmation with the code", ()=>{
    const app = makeDomApp();
    app.exec(`openBarcodeReaderSetupModal();`);
    const input = app.document.getElementById("scanTestInput");
    assert.ok(input, "the test-capture input renders");
    input.value = "8901234567890";
    input.oninput({ target: input });
    const result = app.document.getElementById("scanTestResult").innerHTML;
    assert.ok(/8901234567890/.test(result), "the captured code is shown");
    assert.ok(/Captured/.test(result));
  });

  await t("Barcode reader setup mentions it's the same device for both Sell search and Stocktake, and needs no pairing", ()=>{
    const app = makeDomApp();
    app.exec(`openBarcodeReaderSetupModal();`);
    const text = app.document.querySelector(".modalOverlay").textContent;
    assert.ok(/keyboard-wedge/.test(text));
    assert.ok(/Sell screen/.test(text) && /Stocktake/.test(text));
  });

  // ================= Cash Drawer setup screen =================
  await t("Cash Drawer setup shows a clear 'not supported' message when navigator.serial doesn't exist, without throwing", ()=>{
    const app = makeDomApp();
    assert.strictEqual(app.exec(`hasSerialPort()`), false, "jsdom has no navigator.serial by default — the real unsupported case");
    app.exec(`openCashDrawerSetupModal();`); // must not throw
    const text = app.document.querySelector(".modalOverlay").textContent;
    assert.ok(/[Nn]ot supported in this build/.test(text));
    // the section snippets settings.js splices in must all still evaluate fine alongside it
    assert.doesNotThrow(()=> app.exec(`printerSectionHtml() + barcodeReaderSectionHtml() + cashDrawerSectionHtml()`),
      "the rest of the Settings page's section HTML is unaffected by serial being unsupported");
  });

  await t("Cash Drawer setup shows 'Connected.' once a serial port is open", ()=>{
    const app = makeDomApp();
    app.exec(`navigator.serial = {}; window._drawer = { port: { writable: {} } };`);
    assert.strictEqual(app.exec(`drawerStatusHtml()`), "Connected.");
  });

  await t("Cash Drawer setup shows 'Not connected.' when serial exists but nothing is open yet", ()=>{
    const app = makeDomApp();
    app.exec(`navigator.serial = {};`);
    assert.strictEqual(app.exec(`drawerStatusHtml()`), "Not connected.");
  });

  // ================= Printer <-> Cash Drawer independence =================
  await t("printing a receipt NEVER calls openCashDrawer, in every print path", async ()=>{
    const app = makeDomApp();
    app.exec(`window.__drawerCalls = 0; openCashDrawer = async ()=>{ window.__drawerCalls++; return true; };`);
    await app.exec(`printReceipt("T1", new Date().toISOString(), 1, 0, 0, 0, 1, "Cash", [{name:"X",price:1,qty:1,discount:0}], [{method:"Cash",amount:1,currency:BASE_CURRENCY_CODE,tendered_amount:1}])`);
    await app.exec(`printEOD({date:"2026-01-01",openingFloat:0,cash:0,ecocash:0,credit:0,discounts:0,totalSales:0,payouts:[],payoutsTotal:0,expected:0,counted:0,variance:0,lowStock:[]})`);
    await app.exec(`printTestReceipt()`);
    assert.strictEqual(app.exec(`window.__drawerCalls`), 0, "no print path ever opens the cash drawer as a side effect");
  });

  await t("opening the cash drawer NEVER calls any print function", async ()=>{
    const app = makeDomApp();
    app.exec(`
      window.__printCalls = 0;
      sendDirect = async ()=>{ window.__printCalls++; return true; };
      usbPrintBytes = async ()=>{ window.__printCalls++; return true; };
      btPrintBytes = async ()=>{ window.__printCalls++; return true; };
      printReceipt = async ()=>{ window.__printCalls++; };
      printNow = ()=>{ window.__printCalls++; };
      window._drawer = { port: { writable: { getWriter: ()=>({ write: async ()=>{}, releaseLock: ()=>{} }) } } };
    `);
    const ok = await app.exec(`openCashDrawer()`);
    assert.strictEqual(ok, true);
    assert.strictEqual(app.exec(`window.__printCalls`), 0, "opening the drawer never triggers printing");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
