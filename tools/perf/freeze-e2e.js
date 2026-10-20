// Freeze diagnosis (Stage A): sign-in (A) and Remote -> Main switch (B) timed on a real build.
// Run: node tools/perf/freeze-e2e.js . <build html: dist/index.html or deploy/preview/mobile/index.html> <small|large> <cpu rate 1|4|6> [label]
// Supabase is blocked (an unregistered till: no seiGEN calls, as on a till that is offline at sign-in).
// Seeds the app's own database (IndexedDB) with: shop_roles + shop_staff (PIN 4826, PBKDF2 150,000 check
// values made with src/passcode-check.js), single operator mode off, a remote whose Admin passcode
// (admin123) came from main as a check value; "large" adds 5,000 products, 10,000 sales / 50,000 lines,
// 200 customers, 20 staff. Never touches the live project.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const [ROOT_ARG, BUILD_ARG, SIZE, RATE_S, LABEL] = process.argv.slice(2);
const ROOT = path.resolve(ROOT_ARG || "."), BUILD = path.resolve(BUILD_ARG);
const RATE = Number(RATE_S) || 1;
const { chromium } = require(path.join(ROOT, "node_modules/playwright"));
const { activateForTest } = require(path.join(ROOT, "test/test-activation"));
const pc = vm.createContext({ TextEncoder, crypto: require("crypto").webcrypto });
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/passcode-check.js"), "utf8") + "\n;this.make = adminCheckMake;", pc);
const PIN = pc.make("4826"), ADMIN = pc.make("admin123");
const fileUrl = (p)=> "file:///" + p.split(path.sep).join("/");
const out = { build: LABEL || path.basename(path.dirname(BUILD)), size: SIZE, rate: RATE };

async function seed(page, large){
  return page.evaluate(async ({ PIN, ADMIN, large })=>{
    const open = ()=> new Promise((res, rej)=>{ const r = indexedDB.open("seigen_lite_db", 1); r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); });
    const conn = await open();
    const bytes = await new Promise((res, rej)=>{ const g = conn.transaction("kv","readonly").objectStore("kv").get("dbfile"); g.onsuccess = ()=>res(g.result); g.onerror = ()=>rej(g.error); });
    const SQL = await initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/"+f });
    const d = new SQL.Database(new Uint8Array(bytes));
    const set = (k, v)=>{ d.run("DELETE FROM settings WHERE key=?", [k]); d.run("INSERT INTO settings(key,value) VALUES(?,?)", [k, v]); };
    const branch = (d.exec("SELECT value FROM settings WHERE key='branch_name'")[0]||{values:[[""]]}).values[0][0];
    d.run("DELETE FROM shop_roles"); d.run("DELETE FROM shop_staff");
    const all = ["m.sell","m.products","m.credit","m.reports","m.marketing","m.dispatch","m.receive","m.adjust","m.incoming","m.productlist","m.stocktake","m.requests","m.purchasing","m.reportwriter","m.directory","m.eod","m.settings","m.staff","m.terminals","costs","edit_prices","create_customers","review_requisitions","other_branches","approve_writeoffs","void_return","credit_over_limit","sales_reports"];
    d.run("INSERT INTO shop_roles(id,name,builtin,rights,seq) VALUES('r-admin','Admin','admin',?,1)", [JSON.stringify(all)]);
    d.run("INSERT INTO shop_roles(id,name,builtin,rights,seq) VALUES('r-cash','Cashier','cashier',?,1)", [JSON.stringify(["m.sell","m.credit","m.productlist","m.directory","m.requests","m.reports","m.eod","sales_reports"])]);
    const nStaff = large? 20 : 3;
    for(let i = 0; i < nStaff; i++) d.run(`INSERT INTO shop_staff(id,name,role_id,home_branch,home_branch_name,branches,active,here,pin_salt,pin_check,pin_rounds,legacy,pins_from_tills,has_pin,seq)
      VALUES(?,?,?,?,?,'[]',1,1,?,?,?,'[]',0,1,1)`, ["st-"+i, i===0? "Aaron Admin" : "Cashier "+i, i===0? "r-admin" : "r-cash", "b1", branch, PIN.salt, PIN.check, PIN.rounds]);
    d.run("DELETE FROM staff");
    d.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts,passcode_salt,passcode_check,passcode_rounds) VALUES('Admin (set by main)','Admin','',?,1,?,?,?,?)",
      [branch, new Date().toISOString(), ADMIN.salt, ADMIN.check, ADMIN.rounds]);
    set("single_operator_mode", "0"); set("branch_type", "remote");
    if(large){
      d.run("BEGIN");
      for(let i = 1; i <= 5000; i++) d.run("INSERT INTO products(name,price,stock,branch,sku,cost) VALUES(?,?,?,?,?,?)", ["Product "+i, 1+i%50, 100, branch, "SKU"+i, 0.5+i%30]);
      d.run(`INSERT INTO stock_movements(product_id,branch,qty_delta,kind,ts,note) SELECT id, branch, 100, 'opening', '2026-01-01T00:00:00Z', '' FROM products`);
      for(let i = 1; i <= 200; i++) d.run("INSERT INTO customers(name,phone) VALUES(?,?)", ["Customer "+i, "07700"+String(i).padStart(5,"0")]);
      for(let s = 1; s <= 10000; s++){
        const ts = new Date(Date.UTC(2026,0,1) + s*2400000).toISOString();
        d.run("INSERT INTO sales(ts,subtotal,discount,total,method,branch,user) VALUES(?,?,0,?,'Cash',?,'Perf')", [ts, 25, 25, branch]);
        const sid = d.exec("SELECT last_insert_rowid()")[0].values[0][0];
        for(let k = 0; k < 5; k++){ const pid = 1 + ((s*5+k) % 5000); d.run("INSERT INTO sale_items(sale_id,product_id,name,price,qty) VALUES(?,?,?,5,1)", [sid, pid, "Product "+pid]); }
      }
      d.run("COMMIT");
    }
    const t = performance.now(); const outBytes = d.export(); const exportMs = performance.now() - t; d.close();
    await new Promise((res, rej)=>{ const tx = conn.transaction("kv","readwrite"); tx.objectStore("kv").put(outBytes, "dbfile"); tx.oncomplete = ()=>res(); tx.onerror = ()=>rej(tx.error); });
    return { dbBytes: outBytes.length, exportMs: Math.round(exportMs) };
  }, { PIN, ADMIN, large });
}
// longest task while fn runs (Long Tasks API), and the wall time
async function timed(page, fn){
  await page.evaluate(()=>{ window.__lt = []; window.__po && window.__po.disconnect(); window.__po = new PerformanceObserver(l=> l.getEntries().forEach(e=> window.__lt.push(e.duration))); window.__po.observe({ entryTypes:["longtask"] }); });
  const t = Date.now(); await fn(); const wall = Date.now() - t;
  await page.waitForTimeout(300);
  const lt = await page.evaluate(()=> window.__lt.slice());
  return { wall_ms: wall, longest_task_ms: Math.round(Math.max(0, ...lt)), long_tasks: lt.length };
}
async function signIn(page){
  await page.click("#startSignIn"); await page.waitForSelector("#whoSelect");
  await page.selectOption("#whoSelect", "s:st-0"); await page.click("#whoSelectContinue");
  await page.waitForSelector("#whoPin"); await page.fill("#whoPin", "4826");
  return timed(page, async ()=>{ await page.click("#whoPinContinue", { timeout: 0, noWaitAfter: true }); await page.waitForSelector("#logoutBtn", { timeout: 0 }); });
}

(async()=>{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{ width:390, height:844 }, serviceWorkers:"block" });
  await ctx.route(/supabase\.co\//, r=> r.abort());
  const dialogs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-freeze-"));
  fs.copyFileSync(BUILD, path.join(dir, "index.html"));
  for(const f of fs.readdirSync(path.dirname(BUILD))) if(/^globe-/.test(f)) fs.copyFileSync(path.join(path.dirname(BUILD), f), path.join(dir, f));
  let page = await ctx.newPage();
  page.on("dialog", async x=>{ dialogs.push(x.message()); await x.accept(); });
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#setShop", { timeout:60000 });
  await page.fill("#setShop", "Perf Hardware"); await page.fill("#setBranch", "Mbare"); await page.fill("#setSecret", "Gold Leaf 42");
  await page.click("#setupNext"); await page.fill("#setOwnerPhone", "0771234567"); await page.click("#setupNext2"); await page.click("#setupNext3"); await page.click("#setupFinish");
  await page.waitForSelector("[data-route]");
  await activateForTest(page);
  await page.waitForTimeout(1500);
  out.seed = await seed(page, SIZE==="large");
  await page.close();

  // cold start: a new page (fresh JS heap; the database read from IndexedDB)
  page = await ctx.newPage();
  page.on("dialog", async x=>{ dialogs.push(x.message()); await x.accept(); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: RATE });
  let t = Date.now();
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#startSignIn", { timeout: 0 });
  out.cold_start_ms = Date.now() - t;
  out.A_cold = await signIn(page);

  // B: Settings on the remote: Admin passcode -> Unlock; then Branch type Main -> Save
  await page.click('.navbar [data-route="more"]'); await page.click('[data-kebab-toggle="moretab"]'); await page.click('[data-tab="settings"]');
  await page.waitForSelector("#settingsPasscode"); await page.fill("#settingsPasscode", "admin123");
  out.B_unlock = await timed(page, async ()=>{ await page.click("#unlockSettings", { timeout:0, noWaitAfter:true }); await page.waitForSelector("#sBranchType", { timeout:0 }); });
  await page.selectOption("#sBranchType", "main");
  out.B_save_main = await timed(page, async ()=>{ await page.click("#saveSettings", { timeout:0, noWaitAfter:true }); await page.waitForFunction(()=> document.getElementById("sBranchType") && document.getElementById("sBranchType").value==="main" && !document.getElementById("settingsPasscode"), null, { timeout:0 }); });

  // warm: Log out and sign in again on the same page
  await page.click("#logoutBtn"); await page.waitForSelector("#startSignIn");
  out.A_warm = await signIn(page);
  out.dialogs = dialogs.filter(m=> !/trial|activation/i.test(m)).slice(0, 5);
  console.log(JSON.stringify(out));
  await browser.close();
})().catch(e=>{ console.log(JSON.stringify(Object.assign(out, { error: e.message.split("\n")[0] }))); process.exit(1); });
