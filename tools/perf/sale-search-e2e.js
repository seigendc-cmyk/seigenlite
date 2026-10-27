// Run: node tools/perf/sale-search-e2e.js . <build html: dist/index.html (plain) or dist-pwa/index.html (obfuscated)> <small|large> <cpu rate 1|4|6> [label]
// Does the obfuscator's control-flow flattening slow the Sell screen's product search and the sale commit?
// Measure only. A real build in Playwright Chromium (390 px), seiGEN blocked, single operator mode,
// a shift started; "large" = 5,000 products and 10,000 earlier sales / 50,000 lines (as freeze-e2e.js).
//   search: each keystroke of "prod 42" (the list redrawn by the app's own input handler), total and slowest;
//   sale: Add one product, Cart, Cash -> the sale saved (window._lastReceipt), median of 5.
// B4=1 (v35): the till is registered and has just had its first B4 check-in, so the sales sync
// queues its 90 days of history (and tries to send it; seiGEN is blocked) while search and sales are measured.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const [ROOT_ARG, BUILD_ARG, SIZE, RATE_S, LABEL] = process.argv.slice(2);
const ROOT = path.resolve(ROOT_ARG || "."), BUILD = path.resolve(BUILD_ARG), RATE = Number(RATE_S) || 1;
const { chromium } = require(path.join(ROOT, "node_modules/playwright"));
const { activateForTest } = require(path.join(ROOT, "test/test-activation"));
const fileUrl = (p)=> "file:///" + p.split(path.sep).join("/");
const out = { build: LABEL || path.basename(path.dirname(BUILD)), size: SIZE, rate: RATE, b4: process.env.B4==="1" };

async function seed(page, large){
  return page.evaluate(async ({ large, b4 })=>{
    const open = ()=> new Promise((res, rej)=>{ const r = indexedDB.open("seigen_lite_db", 1); r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); });
    const conn = await open();
    const bytes = await new Promise((res, rej)=>{ const g = conn.transaction("kv","readonly").objectStore("kv").get("dbfile"); g.onsuccess = ()=>res(g.result); g.onerror = ()=>rej(g.error); });
    const SQL = await initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/"+f });
    const d = new SQL.Database(new Uint8Array(bytes));
    const branch = (d.exec("SELECT value FROM settings WHERE key='branch_name'")[0]||{values:[[""]]}).values[0][0];
    const nP = large? 5000 : 50;
    d.run("BEGIN");
    for(let i = 1; i <= nP; i++) d.run("INSERT INTO products(name,price,stock,branch,sku,cost) VALUES(?,?,?,?,?,?)", ["Product "+i, 1+i%50, 1000, branch, "SKU"+i, 0.5+i%30]);
    d.run(`INSERT INTO stock_movements(product_id,branch,qty_delta,kind,ts,note) SELECT id, branch, 1000, 'opening', '2026-01-01T00:00:00Z', '' FROM products`);
    if(large){
      for(let i = 1; i <= 200; i++) d.run("INSERT INTO customers(name,phone) VALUES(?,?)", ["Customer "+i, "07700"+String(i).padStart(5,"0")]);
      for(let s = 1; s <= 10000; s++){
        d.run("INSERT INTO sales(ts,subtotal,discount,total,method,branch,user) VALUES(?,25,0,25,'Cash',?,'Perf')", [new Date(Date.UTC(2026,0,1) + s*2400000).toISOString(), branch]);
        const sid = d.exec("SELECT last_insert_rowid()")[0].values[0][0];
        for(let k = 0; k < 5; k++){ const pid = 1 + ((s*5+k) % 5000); d.run("INSERT INTO sale_items(sale_id,product_id,name,price,qty) VALUES(?,?,?,5,1)", [sid, pid, "Product "+pid]); }
      }
    }
    if(b4){   // as b4Begin() leaves a till at its first B4 check-in (src/b4-sync.js)
      const set = (k, v)=> d.run("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", [k, String(v)]);
      set("terminal_id", "00000000-0000-4000-8000-000000000001"); set("b4_start", new Date().toISOString());
      for(const t of ["sales","credit_notes","credit_payments","payouts","price_changes","vouchers"]){
        const m = (d.exec(`SELECT COALESCE(MAX(id),0) FROM ${t}`)[0]||{values:[[0]]}).values[0][0]; set("b4_cur_"+t, m); set("b4_hist_"+t, m); }
    }
    d.run("COMMIT");
    const o = d.export(); d.close();
    await new Promise((res, rej)=>{ const tx = conn.transaction("kv","readwrite"); tx.objectStore("kv").put(o, "dbfile"); tx.oncomplete = ()=>res(); tx.onerror = ()=>rej(tx.error); });
  }, { large, b4: process.env.B4==="1" });
}
const median = (a)=>{ const s = a.slice().sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };

(async()=>{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{ width:390, height:844 }, serviceWorkers:"block" });
  await ctx.route(/supabase\.co\//, r=> r.abort());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-sale-"));
  fs.copyFileSync(BUILD, path.join(dir, "index.html"));
  let page = await ctx.newPage();
  page.on("dialog", x=> x.accept());
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#setShop", { timeout:60000 });
  await page.fill("#setShop", "Perf Hardware"); await page.fill("#setBranch", "Mbare"); await page.fill("#setSecret", "Gold Leaf 42");
  await page.click("#setupNext"); await page.fill("#setOwnerPhone", "0771234567"); await page.click("#setupNext2"); await page.click("#setupNext3"); await page.click("#setupFinish");
  await page.waitForSelector("[data-route]");
  await activateForTest(page);
  await page.waitForTimeout(1500);
  await seed(page, SIZE==="large");
  await page.close();
  page = await ctx.newPage();
  page.on("dialog", x=> x.accept());
  await page.addInitScript(()=>{ window.print = ()=>{}; });
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#startSignIn", { timeout:0 });
  await page.click("#startSignIn"); await page.waitForSelector("#whoName"); await page.fill("#whoName", "Perf"); await page.click("#whoContinue");
  await page.waitForSelector("#logoutBtn", { timeout:0 });
  const go = await page.$("#goToEodBtn");
  if(go){ await go.click(); await page.waitForSelector("#openingFloat"); await page.fill("#openingFloat", "50"); await page.click("#startShiftBtn"); await page.click('.navbar [data-route="pos"]'); }
  await page.waitForSelector("#searchInput", { timeout:0 });
  if(process.env.B4==="1") await page.waitForTimeout(6000);   // B4's first step has started (5 s after boot)
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: RATE });

  // search: the app's own input handler, one keystroke at a time
  const q = "prod 42";
  const keys = await page.evaluate(async (q)=>{
    const input = document.getElementById("searchInput"), times = [];
    for(let i = 1; i <= q.length; i++){
      input.value = q.slice(0, i);
      const t = performance.now(); input.dispatchEvent(new Event("input", { bubbles:true })); times.push(performance.now() - t);
      await new Promise(r=> setTimeout(r, 30));
    }
    input.value = ""; input.dispatchEvent(new Event("input", { bubbles:true }));
    return times;
  }, q);
  out.search_total_ms = Math.round(keys.reduce((a,b)=>a+b, 0));
  out.search_slowest_key_ms = Math.round(Math.max(...keys));
  out.search_first_key_ms = Math.round(keys[0]);

  // sale commit: Add -> Cart -> Cash -> saved
  const sales = [];
  for(let i = 0; i < 5; i++){
    await page.click(".product-row .add-chip:not([disabled])");
    await page.click("#cartBtn"); await page.waitForSelector("#payCash");
    const before = await page.evaluate(()=> window._lastReceipt? window._lastReceipt.saleId : 0);
    const t = Date.now();
    await page.click("#payCash", { timeout:0, noWaitAfter:true });
    await page.waitForFunction((b)=> window._lastReceipt && window._lastReceipt.saleId!==b, before, { timeout:0 });
    sales.push(Date.now() - t);
    await page.waitForTimeout(300);
    if(await page.$("#closeDrawer")) await page.click("#closeDrawer").catch(()=>{});
  }
  out.sale_commit_ms = sales;
  out.sale_commit_median_ms = median(sales);
  // v36 A3: the obfuscated build has no global one(), so read the number from the Sell screen's sync line
  if(process.env.B4==="1") out.b4_queued = await page.evaluate(()=>{ const el = document.getElementById("b4SyncText"); const m = el && /^(\d+) waiting to send/.exec(el.textContent); return m? Number(m[1]) : "no sync line"; });
  console.log(JSON.stringify(out));
  await browser.close();
})().catch(e=>{ console.log(JSON.stringify(Object.assign(out, { error: e.message.split("\n")[0] }))); process.exit(1); });
