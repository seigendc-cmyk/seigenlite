// Run: node --no-warnings test/receipt-discount-aggregate.test.js
//
// Change: the printed/PDF receipt used to show an indented "Discount"
// sub-line under EVERY discounted item (saleItemLineBytes/saleItemLineHtml,
// src/printing.js). That's now removed — the receipt already had a single
// aggregate "Discount: -$X" line in its totals block (above TOTAL, hidden
// when zero), built from the sale-level `discount` value, which was always
// the sum of every line's discount (see pos.js's completeSale comment) —
// so no new summing logic was needed, only removing the per-item sub-line.
// This file proves: the printed receipt (ESC/POS bytes AND the OS-dialog
// HTML path) never shows a per-item sub-line, the one aggregate line sums
// correctly across multiple discounted lines, and it's hidden entirely at
// zero. openSaleDetailModal() is untouched — see
// test/line-item-discount-e2e.test.js, which already proves its per-item
// discount sub-line still renders exactly as before.
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

function makeDomApp(){
  const dom = new JSDOM(`<!DOCTYPE html><body><div id="printArea"></div></body>`, { url: "http://localhost/" });
  const window = dom.window;
  const document = window.document;
  const db = new Compat();
  const sqlCtor = function(x){ return x && x.__db ? x.__db : new Compat(); };

  const ctx = vm.createContext(Object.assign(window, {
    console, SQLctor: sqlCtor, __db: db,
    alert: ()=>{}, confirm: ()=>true, printNow: ()=>{},
  }));

  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="pos", cart=[];
    async function persist(){}
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
  `;
  const files = ["db.js","utils.js","currencies.js","printing.js"];
  const code = prelude.replace(/async function persist[^\n]*\n/, "") + files.map(src).join("\n");

  vm.runInContext(code, ctx, { filename: "app-sources" });
  vm.runInContext(`db.run(SCHEMA); migrate(db);`, ctx);

  return {
    ctx, document,
    exec(js){ return vm.runInContext(js, ctx); },
  };
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

// buildReceiptBytes/buildSaleCopyBytes return raw ESC/POS bytes; decode to
// text for content assertions (control bytes just become junk chars the
// regexes below don't match).
function decode(app, expr){
  return app.exec(`new TextDecoder().decode(${expr})`);
}

(async()=>{
  const oneItem = [{ name:"Rice 2kg", price:10, qty:1, discount:2 }];
  const twoItems = [{ name:"Rice 2kg", price:10, qty:1, discount:2 }, { name:"Sugar 1kg", price:5, qty:1, discount:1 }];
  const zeroItems = [{ name:"Rice 2kg", price:10, qty:1, discount:0 }];
  const payments = `[{method:"Cash",amount:1,currency:"BASE",tendered_amount:1}]`;

  // ================= ESC/POS bytes (direct print / reprint) =================
  await t("receipt bytes: one discounted item — no per-item sub-line, one aggregate Discount line above TOTAL", ()=>{
    const app = makeDomApp();
    const text = decode(app, `buildReceiptBytes(1, new Date().toISOString(), 10, 2, 0, 0, 8, "Cash", ${JSON.stringify(oneItem)}, ${payments})`);
    const discountMatches = text.match(/Discount/g) || [];
    assert.strictEqual(discountMatches.length, 1, "exactly one Discount occurrence — the aggregate line, no per-item sub-line");
    assert.ok(/Discount[\s\S]*-\$2\.00/.test(text), "aggregate shows the correct amount");
    assert.ok(text.indexOf("Discount") < text.indexOf("TOTAL"), "Discount line sits above TOTAL");
  });

  await t("receipt bytes: multiple discounted items — the aggregate sums correctly, still just one line", ()=>{
    const app = makeDomApp();
    const text = decode(app, `buildReceiptBytes(1, new Date().toISOString(), 15, 3, 0, 0, 12, "Cash", ${JSON.stringify(twoItems)}, ${payments})`);
    const discountMatches = text.match(/Discount/g) || [];
    assert.strictEqual(discountMatches.length, 1, "still exactly one Discount line for two discounted items");
    assert.ok(/Discount[\s\S]*-\$3\.00/.test(text), "sums 2 + 1 = 3 correctly");
  });

  await t("receipt bytes: zero discount across all items — no Discount line at all", ()=>{
    const app = makeDomApp();
    const text = decode(app, `buildReceiptBytes(1, new Date().toISOString(), 10, 0, 0, 0, 10, "Cash", ${JSON.stringify(zeroItems)}, ${payments})`);
    assert.ok(!/Discount/.test(text), "no Discount line is shown when there's nothing to discount");
  });

  await t("sale-copy bytes (reprint path): same rules — one aggregate line, no per-item sub-line", ()=>{
    const app = makeDomApp();
    const sale = { id:1, ts:new Date().toISOString(), subtotal:15, discount:3, markup:0, voucher_amount:0, total:12, method:"Cash" };
    const text = decode(app, `buildSaleCopyBytes(${JSON.stringify(sale)}, ${JSON.stringify(twoItems)}, ${payments})`);
    const discountMatches = text.match(/Discount/g) || [];
    assert.strictEqual(discountMatches.length, 1);
    assert.ok(/Discount[\s\S]*-\$3\.00/.test(text));
  });

  // ================= OS-dialog HTML path (printReceipt) =================
  await t("HTML receipt (OS print dialog): one discounted item — no per-item sub-line, one aggregate Discount line above TOTAL", async ()=>{
    const app = makeDomApp();
    await app.exec(`printReceipt(1, new Date().toISOString(), 10, 2, 0, 0, 8, "Cash", ${JSON.stringify(oneItem)}, ${payments})`);
    const html = app.document.getElementById("printArea").innerHTML;
    const discountMatches = html.match(/Discount/g) || [];
    assert.strictEqual(discountMatches.length, 1, "no per-item sub-line rendered under the item row");
    assert.ok(/Discount<\/span><span>-\$2\.00/.test(html));
    assert.ok(html.indexOf("Discount") < html.indexOf("TOTAL"));
  });

  await t("HTML receipt: multiple discounted items sum into the one aggregate line", async ()=>{
    const app = makeDomApp();
    await app.exec(`printReceipt(1, new Date().toISOString(), 15, 3, 0, 0, 12, "Cash", ${JSON.stringify(twoItems)}, ${payments})`);
    const html = app.document.getElementById("printArea").innerHTML;
    const discountMatches = html.match(/Discount/g) || [];
    assert.strictEqual(discountMatches.length, 1);
    assert.ok(/Discount<\/span><span>-\$3\.00/.test(html));
  });

  await t("HTML receipt: zero discount — the Discount line is hidden entirely", async ()=>{
    const app = makeDomApp();
    await app.exec(`printReceipt(1, new Date().toISOString(), 10, 0, 0, 0, 10, "Cash", ${JSON.stringify(zeroItems)}, ${payments})`);
    const html = app.document.getElementById("printArea").innerHTML;
    assert.ok(!/Discount/.test(html));
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
