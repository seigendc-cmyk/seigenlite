// Run: node --no-warnings test/doc-ref-e2e.test.js
//
// Document Reference No.: an optional free-text field on the cart (mobile
// drawer, router.js, and desktop cart panel, desktop/sales-desktop.js) for
// a PO / delivery note / invoice number the sale relates to. This file
// drives a REAL test sale through the rendered cart DOM, typing a reference
// into #docRef and tapping Cash, then proves the same value comes out:
//   - on the sales row (sales.doc_ref)
//   - on the receipt printed at checkout (OS-dialog HTML path, the real
//     printReceipt() completeSale calls) and its ESC/POS bytes
//   - on the last-receipt Reprint button
//   - on a historical Print Copy (HTML + ESC/POS), the A4 Credit invoice,
//     and the read-only Sale Detail modal
//   - in the Sales Report (Report Writer on-screen view, and the Reports
//     tab's printed/PDF Sales Report)
// and that a sale WITHOUT one is unaffected: '' stored, no "Doc Ref" line
// printed anywhere, no required-field alert.
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

// Same harness shape as test/line-item-discount-e2e.test.js, except the
// REAL printReceipt() is kept (not stubbed) so the checkout receipt itself
// is what gets inspected.
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
    console, SQLctor: sqlCtor, __db: db,
    alert: (m)=>{ alerts.push(m); }, confirm: ()=>true, print: ()=>{},
    $app: document.getElementById("app"),
  }));

  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="pos", cart=[];
    let sessionStaffId=null, accessStep=1, accessSelectedStaffId=null, accessPinDigits="", accessError="";
    let moreTab="help", settingsUnlocked=false, drawerOpen=true, appliedVoucher=null;
    let searchQuery="", reportsQuery="", creditQuery="", reqDrawerOpen=false;
    let splitTender=false, splitLines=[], fxPreviewCurrency="", quickTapCurrency="";
    async function persist(){}
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
    function renderRequestsDrawer(){}
  `;
  const files = ["db.js","utils.js","pos.js","printing.js","drawer.js","currencies.js","staff.js","eod.js","devicecheckin.js","router.js","report-writer.js","reports.js"];
  if(desktop) files.push("desktop/sales-desktop.js");
  const code = prelude + files.map(src).join("\n");

  vm.runInContext(code, ctx, { filename: "app-sources" });
  // db.js's real persist() needs sql.js's db.export(), which the node:sqlite
  // shim doesn't have — nothing here depends on IndexedDB persistence.
  vm.runInContext(`persist = async function(){}; db.run(SCHEMA); migrate(db);`, ctx);
  Object.entries(settings||{}).forEach(([k,v])=>{
    vm.runInContext(`setSetting(${JSON.stringify(k)}, ${JSON.stringify(String(v))});`, ctx);
  });

  return {
    ctx, document, alerts, window,
    run(sql, params){ return vm.runInContext(`run(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    one(sql, params){ return vm.runInContext(`one(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    exec(js){ return vm.runInContext(js, ctx); },
  };
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const tick = ()=> new Promise(r=>setTimeout(r,0));
const printArea = (app)=> app.document.getElementById("printArea").innerHTML;
const bytesText = (app, expr)=> app.exec(`new TextDecoder().decode(${expr})`);

// A real sale through the rendered cart: add Rice via its Add button,
// type the reference (and anything else) into the cart fields, tap the
// pay button. Returns the stored sales row.
async function ringUpSale(app, desktop, fields, payId){
  app.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Rice 2kg',10,50,3,'Boka','')");
  const rice = app.one("SELECT * FROM products WHERE name='Rice 2kg'");
  app.exec("render();");
  if(!desktop) app.exec("drawerOpen=true; render();");
  app.document.querySelector(`[data-add="${rice.id}"]`).onclick();
  if(!desktop) app.exec("drawerOpen=true; render();");
  Object.entries(fields).forEach(([id,val])=>{
    const el = app.document.getElementById(id);
    assert.ok(el, `#${id} is rendered in the cart`);
    el.value = val; el.oninput({ target: el });
  });
  app.document.getElementById(payId).onclick();
  await tick();
  return app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
}

function run(label, desktop){
  const pay = (m)=> desktop? `dsPay${m}` : `pay${m}`;
  return (async()=>{
    await t(`[${label}] the cart shows an optional Document Reference No. field`, ()=>{
      const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, desktop);
      app.exec(`startShift("0", new Date());`);
      app.exec("drawerOpen=true; render();");
      const el = app.document.getElementById("docRef");
      assert.ok(el, "#docRef input exists");
      assert.strictEqual(el.getAttribute("maxlength"), "40");
      const label_ = el.previousElementSibling.textContent;
      assert.ok(/Document Reference No\./.test(label_) && /optional/i.test(label_), "labelled and clearly optional: "+label_);
    });

    await t(`[${label}] test sale with a reference: stored, and on the checkout receipt (HTML + ESC/POS) and reprint`, async ()=>{
      const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", shop_name:"Test Shop" }, desktop);
      app.exec(`startShift("0", new Date());`);
      const sale = await ringUpSale(app, desktop, { docRef:"  PO-4471 / DN 0098  " }, pay("Cash"));

      assert.deepStrictEqual(app.alerts, []);
      assert.strictEqual(sale.doc_ref, "PO-4471 / DN 0098", "trimmed and stored on the sales row");

      const html = printArea(app);
      console.log("       checkout receipt text: " + app.document.getElementById("printArea").textContent.replace(/\s+/g," ").trim());
      assert.ok(html.includes(`Receipt #${sale.id}</div>`));
      assert.ok(html.includes("<div>Doc Ref: PO-4471 / DN 0098</div>"), "printed on the checkout receipt");
      assert.ok(html.indexOf("Doc Ref") > html.indexOf("Receipt #") && html.indexOf("Doc Ref") < html.indexOf("Rice 2kg"), "sits under the receipt number, above the items");

      const r = app.exec("JSON.stringify(window._lastReceipt)");
      assert.strictEqual(JSON.parse(r).docRef, "PO-4471 / DN 0098");
      const thermal = bytesText(app, `(()=>{ const r=window._lastReceipt; return buildReceiptBytes(r.saleId,r.ts,r.subtotal,r.discount,r.markup,r.voucherAmount,r.total,r.method,r.items,r.payments,r.docRef); })()`);
      assert.ok(thermal.includes("Doc Ref: PO-4471 / DN 0098\n"), "thermal receipt bytes carry it");

      // Last-receipt Reprint button on the POS screen (renders after the sale).
      app.document.getElementById("printArea").innerHTML = "";
      app.exec(`route="pos"; drawerOpen=false; render();`);
      const reprint = app.document.getElementById("reprintBtn");
      if(reprint){ reprint.onclick(); await tick(); assert.ok(printArea(app).includes("Doc Ref: PO-4471 / DN 0098"), "reprint keeps it"); }
      else assert.ok(desktop, "mobile POS screen always shows the reprint button");
    });

    await t(`[${label}] sale with NO reference: '' stored, no Doc Ref line, no alert`, async ()=>{
      const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, desktop);
      app.exec(`startShift("0", new Date());`);
      const sale = await ringUpSale(app, desktop, {}, pay("Cash"));
      assert.deepStrictEqual(app.alerts, []);
      assert.strictEqual(sale.doc_ref, "");
      assert.ok(!/Doc Ref/.test(printArea(app)));
      app.exec(`printSaleCopy(${sale.id})`); await tick();
      assert.ok(!/Doc Ref/.test(printArea(app)));
    });

    await t(`[${label}] the field is cleared for the next sale`, async ()=>{
      const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, desktop);
      app.exec(`startShift("0", new Date());`);
      await ringUpSale(app, desktop, { docRef:"INV-1" }, pay("Cash"));
      app.exec("drawerOpen=true; render();");
      assert.strictEqual(app.document.getElementById("docRef").value, "");
    });
  })();
}

(async()=>{
  await run("mobile", false);
  await run("desktop", true);

  await t("credit sale with a reference: Print Copy, A4 invoice, Sale Detail modal, Sales Reports all show it", async ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, false);
    app.exec(`startShift("0", new Date());`);
    const sale = await ringUpSale(app, false, { docRef:"DN-2231", custName:"Tendai Moyo" }, "payCredit");
    assert.deepStrictEqual(app.alerts, []);
    assert.strictEqual(sale.doc_ref, "DN-2231");

    app.exec(`printSaleCopy(${sale.id})`); await tick();
    assert.ok(printArea(app).includes("<div>Doc Ref: DN-2231</div>"), "historical Print Copy (HTML)");
    const copyBytes = bytesText(app, `buildSaleCopyBytes(one("SELECT * FROM sales WHERE id=?",[${sale.id}]), all("SELECT * FROM sale_items WHERE sale_id=?",[${sale.id}]), salePayments(${sale.id}))`);
    assert.ok(copyBytes.includes("Doc Ref: DN-2231\n"), "historical Print Copy (ESC/POS)");

    app.exec(`printCreditInvoice(${sale.id})`);
    assert.ok(printArea(app).includes("<br>Doc Ref: DN-2231</p>"), "A4 credit invoice");

    app.exec(`openSaleDetailModal(${sale.id})`);
    assert.ok(app.document.body.innerHTML.includes("<span>Doc Ref</span><span>DN-2231</span>"), "Sale Detail modal");

    const d = new Date(sale.ts);
    const day = new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
    // the report's own day range (business day as UTC instants), as Report Writer builds it
    const rw = JSON.parse(app.exec(`JSON.stringify((()=>{ const r = businessRange("${day}","${day}"); return REPORT_CONFIGS.find(c=>c.id==="sales").fetch(null, r.fromTs, r.toTs); })())`));
    const col = rw.headers.indexOf("Doc Ref");
    assert.ok(col>=0, "Report Writer Sales Report has a Doc Ref column");
    assert.strictEqual(rw.rows[0][col], "DN-2231");

    // Reports tab → Sales Report → Generate (printed/PDF report).
    const main = app.document.createElement("main"); main.id="main"; app.document.body.appendChild(main);
    app.exec(`renderReports(document.getElementById("main"))`);
    app.document.getElementById("salesFrom").value = day;
    app.document.getElementById("salesTo").value = day;
    app.document.getElementById("genSales").onclick();
    const rep = printArea(app);
    assert.ok(rep.includes("<th>Doc Ref</th>") && rep.includes("<td>DN-2231</td>"), "Reports tab printed Sales Report");
  });

  await t("control characters and over-long pastes are tidied, never rejected", async ()=>{
    const app = makeDomApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, false);
    app.exec(`startShift("0", new Date());`);
    assert.strictEqual(app.exec(`cleanDocRef("PO\\t12\\n34\\u001b")`), "PO 12 34");
    assert.strictEqual(app.exec(`cleanDocRef("${"X".repeat(60)}")`).length, 40);
    assert.strictEqual(app.exec(`cleanDocRef(undefined)`), "");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
