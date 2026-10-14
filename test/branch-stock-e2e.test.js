// Run: node --no-warnings test/branch-stock-e2e.test.js   (build first: node build.js && node build.js --tauri)
// Branches B1 in a REAL browser (Playwright/Chromium). seiGEN is the REAL
// server SQL (the live shape + 20261024120000_branch_stock) in an in-memory
// PGlite: every /rest/v1/rpc/<name> call from the pages is answered by running
// that function as role anon. Nothing reaches the live project.
//   * Harare (main, desktop build) registers and uploads its catalogue;
//     Harare T2 and Murehwa T1 (phone build) join with join codes
//   * each till sends its own stock from its branch screen; main's Stock by
//     branch adds up Harare T1 + T2 and shows each till's own count; the
//     Products page gets an "Other branches" column; the Product List offers
//     Murehwa (stock from seiGEN) with no merged file
//   * Murehwa's Other branches: quantities and dispatches, no costs
// SHOT_DIR=<dir> saves screenshots (390px and 1280px).
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, v21AdminSeed } = require("../supabase/tests/rebuild-helpers");
const { activateForTest, passJoinTrialScreen } = require("./test-activation");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
const BUILDS = { phone: path.join(ROOT, "dist", "index.html"), desktop: path.join(ROOT, "dist-tauri", "index.html") };
for(const b of Object.values(BUILDS)) if(!fs.existsSync(b)){ console.log("Missing "+b+" — run: node build.js && node build.js --tauri"); process.exit(1); }
const SHOTS = process.env.SHOT_DIR || "";
if(SHOTS) fs.mkdirSync(SHOTS, { recursive:true });

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const fileUrl = (p)=> "file:///" + p.replace(/\\/g, "/");
async function waitFor(cond, what, ms){
  const deadline = Date.now() + (ms||15000);
  while(!(await cond())){ if(Date.now() > deadline) throw new Error("timed out waiting for "+what); await new Promise(r=>setTimeout(r, 150)); }
}
async function shot(page, name){ if(SHOTS) await page.screenshot({ path: path.join(SHOTS, name), fullPage:false }); }

let pg;
let queue = Promise.resolve();
function serverCall(name, body){
  const run = async ()=>{
    const keys = Object.keys(body);
    const vals = keys.map(k=> (body[k] !== null && typeof body[k] === "object")? JSON.stringify(body[k]) : body[k]);
    await pg.exec("set role anon");
    try{ return { status:200, json:(await pg.query(`select to_json(public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(",")})) j`, vals)).rows[0].j }; }
    catch(e){ return { status:400, json:{ code:"P0001", message:e.message } }; }
    finally{ await pg.exec("reset role"); }
  };
  const p = queue.then(run, run); queue = p.catch(()=>{}); return p;
}
const sq = (sql, p)=>{ const run = async ()=> (await pg.query(sql, p)).rows; const r = queue.then(run, run); queue = r.catch(()=>{}); return r; };

async function device(browser, kind){
  const desktop = kind==="desktop";
  const ctx = await browser.newContext({ viewport: desktop? { width:1280, height:800 } : { width:390, height:844 } });
  await ctx.route(/urbopdsubwawtybwrxjd\.supabase\.co\/rest\/v1\/rpc\/([a-z_]+)$/, async route=>{
    const name = /\/rpc\/([a-z_]+)$/.exec(route.request().url())[1];
    let body = {}; try{ body = JSON.parse(route.request().postData()||"{}"); }catch(e){}
    const r = await serverCall(name, body);
    return route.fulfill({ status:r.status, contentType:"application/json", headers:{ "access-control-allow-origin":"*" }, body:JSON.stringify(r.json) });
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", e=>pageErrors.push(e.message));
  page.on("dialog", d=>d.accept());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-bs-"));
  fs.copyFileSync(BUILDS[desktop? "desktop" : "phone"], path.join(dir, "index.html"));
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#setShop", { timeout: 30000 });
  return { ctx, page, pageErrors, desktop };
}
async function nav(d, route){
  if(d.desktop){ await d.page.click("#hamburgerBtn"); await d.page.click('#navDrawer [data-route="'+route+'"]'); }
  else await d.page.click('.navbar [data-route="'+route+'"]');
}
async function moreTab(d, tab){
  await nav(d, "more");
  await d.page.click('[data-kebab-toggle="moretab"]');
  await d.page.click('[data-tab="'+tab+'"]');
}
async function openSettings(d){
  await moreTab(d, "settings");
  if(await d.page.$("#settingsPasscode")){ await d.page.fill("#settingsPasscode", "admin123"); await d.page.click("#unlockSettings"); }
  else if(await d.page.$("#newAdminPass")){ await d.page.fill("#newAdminPass", "admin123"); await d.page.fill("#newAdminPass2", "admin123"); await d.page.click("#createAdmin"); }
  await d.page.waitForSelector("#terminalCard");
}
async function addProduct(d, o){
  const p = d.page;
  await nav(d, "products");
  await p.click("#openAddProduct");
  await p.fill("#pName", o.name); await p.fill("#pSku", o.sku); await p.fill("#pPrice", String(o.price));
  await p.fill("#pCost", String(o.cost)); await p.fill("#pStock", String(o.stock));
  await p.click("#pConfirm");
  await p.waitForSelector(".modalOverlay", { state:"detached" });
}
// Test-only: set this device's stock figures in its own database (as receiving would), then reload and sign in.
// The running app may save over the write before the reload (a late check-in), so it is checked after the
// reload, as the app loaded it, and written again if it was lost.
async function setStockAndRestart(page, pairs){
  for(let i = 0; i < 3; i++){
    await setStock(page, pairs);
    await activateForTest(page);
    const now = await readStock(page, pairs.map((p)=> p[0]));
    if(pairs.every(([sku, qty])=> now[sku] === qty)) return;
  }
  throw new Error("setStockAndRestart: the stock figures didn't stick");
}
async function readStock(page, skus){
  return page.evaluate(async (skus)=>{
    const conn = await new Promise((res, rej)=>{ const r = indexedDB.open("seigen_lite_db", 1); r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); });
    const bytes = await new Promise((res, rej)=>{ const g = conn.transaction("kv","readonly").objectStore("kv").get("dbfile"); g.onsuccess = ()=>res(g.result); g.onerror = ()=>rej(g.error); });
    const SQL = await initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/"+f });
    const d = new SQL.Database(new Uint8Array(bytes)); const out = {};
    for(const sku of skus){ const st = d.prepare("SELECT stock FROM products WHERE sku=?"); st.bind([sku]); if(st.step()) out[sku] = st.get()[0]; st.free(); }
    d.close(); return out;
  }, skus);
}
async function setStock(page, pairs){
  await page.waitForTimeout(800);
  await page.evaluate(async (pairs)=>{
    const open = ()=> new Promise((res, rej)=>{ const r = indexedDB.open("seigen_lite_db", 1); r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); });
    const conn = await open();
    const bytes = await new Promise((res, rej)=>{ const g = conn.transaction("kv","readonly").objectStore("kv").get("dbfile"); g.onsuccess = ()=>res(g.result); g.onerror = ()=>rej(g.error); });
    const SQL = await initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/"+f });
    const d = new SQL.Database(new Uint8Array(bytes));
    for(const [sku, qty] of pairs) d.run("UPDATE products SET stock=? WHERE sku=?", [qty, sku]);
    const out = d.export(); d.close();
    await new Promise((res, rej)=>{ const tx = conn.transaction("kv","readwrite"); tx.objectStore("kv").put(out, "dbfile"); tx.oncomplete = ()=>res(); tx.onerror = ()=>rej(tx.error); });
  }, pairs);
}
async function refreshBranches(d){
  await d.page.click("#bsRefresh");
  await waitFor(async()=> !/Loading/.test(await d.page.textContent("#bsStatus")), "the branch figures", 30000);
}
async function credentials(install){ return (await sq("select install_id, shop_secret_phrase, device_key from cl_vendors where install_id=$1",[install]))[0]; }

(async()=>{
  pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== "20261024120000_branch_stock.sql") });
  const browser = await chromium.launch();
  let A, E, C, mainInstall, harare, murehwa;
  const joinWith = async (d, code)=>{
    await d.page.click("#setJoinBtn"); await d.page.waitForSelector("#setJoinCode");
    await d.page.fill("#setSecret", "Gold Leaf 42"); await d.page.fill("#setJoinCode", code); await d.page.fill("#setTillLabel", "Front");
    await d.page.click("#setupJoin");
    await passJoinTrialScreen(d.page); await activateForTest(d.page);
    await nav(d, "products");
    await waitFor(async()=> /Bib/.test(await d.page.textContent("#productsTableArea")), "products to arrive", 30000);
  };
  const issue = async (o)=>{
    const m = await credentials(mainInstall), s = v21AdminSeed("admin123");
    return (await serverCall("cl_branch_issue_join_code", Object.assign({ p_install_id:m.install_id, p_secret_phrase:m.shop_secret_phrase, p_device_key:m.device_key,
      p_admin_salt:s.salt, p_admin_check:s.check, p_admin_rounds:s.rounds }, o))).json;
  };

  await t("Harare (main, desktop) registers and uploads its catalogue; Harare T2 and Murehwa T1 (phones) join", async ()=>{
    A = await device(browser, "desktop");
    const p = A.page;
    await p.fill("#setShop", "Mandie Babyware"); await p.fill("#setBranch", "Harare"); await p.fill("#setSecret", "Gold Leaf 42");
    await p.click("#setupNext"); await p.fill("#setOwnerPhone", "0771234567"); await p.click("#setupNext2"); await p.click("#setupNext3"); await p.click("#setupFinish");
    await p.waitForSelector("[data-route]");
    await addProduct(A, { name:"Bib", sku:"BIB1", price:5, cost:2.5, stock:10 });
    await addProduct(A, { name:"Cap", sku:"CAP1", price:4, cost:1.5, stock:6 });
    await addProduct(A, { name:"Socks", sku:"SOK1", price:2, cost:0.8, stock:20 });
    await openSettings(A);
    await p.click("#termRegisterBtn");
    await p.waitForSelector('#terminalCard[data-registered="1"]');
    mainInstall = (await sq("select install_id from cl_terminals"))[0].install_id;
    await p.click("#catSyncNow"); await p.waitForSelector(".cat-report"); await p.click("#cbrApply");
    await p.waitForSelector("#cbrDone", { timeout:30000 }); await p.click("#cbrDone");
    harare = (await sq("select id from cl_branches where is_main"))[0].id;
    E = await device(browser, "phone");
    await joinWith(E, (await issue({ p_branch_id:harare })).code);
    const mc = await issue({ p_new_branch_name:"Murehwa" }); murehwa = mc.branch_id;
    C = await device(browser, "phone");
    await joinWith(C, mc.code);
    assert.deepStrictEqual((await sq("select t.till_code, b.name from cl_terminals t join cl_branches b on b.id = t.branch_id order by b.is_main desc, t.till_code")).map((r)=> r.name+" "+r.till_code), ["Harare T1", "Harare T2", "Murehwa T1"]);
  });

  await t("each till's own stock: Harare T2 has 4 Bibs; Murehwa has 7 Bibs and 2 Caps (received there)", async ()=>{
    await setStockAndRestart(E.page, [["BIB1", 4]]);
    await setStockAndRestart(C.page, [["BIB1", 7], ["CAP1", 2]]);
    await activateForTest(A.page);                                   // main restarts: its check-in brings the branch list
    for(const d of [E, C]){ await moreTab(d, "branches"); await refreshBranches(d); }
    assert.deepStrictEqual((await sq(`select t.till_code || ' ' || b.name || ' ' || l.name || ' ' || l.qty x from cl_till_stock_levels l join cl_terminals t on t.id = l.terminal_id join cl_branches b on b.id = l.branch_id where l.name = 'Bib' order by 1`)).map((r)=> r.x),
      ["T1 Harare Bib 10", "T1 Murehwa Bib 7", "T2 Harare Bib 4"]);
  });

  await t("main (1280px): More → Stock by branch adds up Harare T1 + T2 (14) with each till's own count, Murehwa 7, value at main's cost", async ()=>{
    await moreTab(A, "branches");
    await refreshBranches(A);
    const txt = (await A.page.textContent("#moreBody")).replace(/\s+/g, " ");
    assert.match(txt, /Harare \(this\)/); assert.match(txt, /Murehwa/);
    assert.match(txt, /14 ?T1: 10 · T2: 4/, txt.slice(0, 600));
    assert.match(txt, /Murehwa: value at cost \$20\.50/);          // 7 × 2.50 + 2 × 1.50
    await shot(A.page, "desktop-1280-stock-by-branch.png");
    await A.page.setViewportSize({ width:390, height:844 });
    await shot(A.page, "phone-390-stock-by-branch-main.png");
    await A.page.setViewportSize({ width:1280, height:800 });
    assert.deepStrictEqual(A.pageErrors, []);
  });

  await t("main's Products page: the 'Other branches' column (Bib 7, Cap 2, Socks 0); a tap shows each branch and till", async ()=>{
    await nav(A, "products");
    const row = A.page.locator('#productsTableArea tr:has-text("Bib")');
    assert.strictEqual((await row.locator("[data-bsprod]").textContent()).trim(), "7");
    assert.strictEqual((await A.page.locator('#productsTableArea tr:has-text("Socks") [data-bsprod]').textContent()).trim(), "0");
    await shot(A.page, "desktop-1280-products-other-branches.png");
    await row.locator("[data-bsprod]").click();
    await A.page.waitForSelector(".bs-branch");
    const m = (await A.page.textContent(".modalOverlay")).replace(/\s+/g, " ");
    assert.match(m, /Harare \(this branch\) ?14/); assert.match(m, /T2 \(own count\): 4/); assert.match(m, /Murehwa ?7/);
    await shot(A.page, "desktop-1280-product-each-branch.png");
    await A.page.click(".modalOverlay [data-modal-close]");
  });

  await t("the joining fix: More → Product List on main offers Murehwa (stock from seiGEN), with no merged file", async ()=>{
    await moreTab(A, "productlist");
    await A.page.selectOption("#plistBranchSel", "Murehwa");
    const txt = (await A.page.textContent("#plistResults")).replace(/\s+/g, " ");
    assert.match(txt, /Bib ?— ?Murehwa ?— ?7/); assert.match(txt, /Cap ?— ?Murehwa ?— ?2/);
    await shot(A.page, "desktop-1280-product-list-murehwa.png");
  });

  await t("Murehwa (remote, 390px): More → Other branches, quantities only, no costs; Dispatches lists main's dispatch without costs", async ()=>{
    const m = await credentials(mainInstall);
    const did = require("crypto").randomUUID();
    const sent = await serverCall("cl_device_dispatch_send", { p_install_id:m.install_id, p_secret_phrase:m.shop_secret_phrase, p_device_key:m.device_key,
      p_dispatch:{ id:did, to_branch_id:murehwa, dn_no:1, dn_display:"DN-T1-0001", lines:[{ code:"SOK1", name:"Socks", qty:5, unit_cost:0.8 }], delivery:{ cost:3, currency:"USD" } } });
    assert.ok(sent.json && sent.json.ok, JSON.stringify(sent));
    await moreTab(C, "branches");
    assert.match(await C.page.textContent(".moretab-btn"), /Other branches/);
    await refreshBranches(C);
    const txt = (await C.page.textContent("#moreBody")).replace(/\s+/g, " ");
    assert.match(txt, /All other branches/); assert.match(txt, /Harare/); assert.doesNotMatch(txt, /Murehwa \(this\)/);
    assert.match(txt, /Bib ?14/); assert.doesNotMatch(txt, /T1: |value at cost|\$/);
    await shot(C.page, "phone-390-other-branches.png");
    await C.page.setViewportSize({ width:1280, height:800 });
    await shot(C.page, "desktop-1280-other-branches-remote.png");
    await C.page.setViewportSize({ width:390, height:844 });
    await C.page.click("#bsTabDisp");
    await waitFor(async()=> /DN-T1-0001/.test(await C.page.textContent("#moreBody")), "the dispatch", 30000);
    const d = (await C.page.textContent("#moreBody")).replace(/\s+/g, " ");
    assert.match(d, /Harare → Murehwa/); assert.match(d, /1 line · 5 units/); assert.doesNotMatch(d, /cost|\$|3\.00|0\.80/i);
    await shot(C.page, "phone-390-other-branches-dispatches.png");
    assert.deepStrictEqual(C.pageErrors, []); assert.deepStrictEqual(E.pageErrors, []);
  });

  await browser.close();
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
