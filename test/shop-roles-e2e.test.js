// Run: node --no-warnings test/shop-roles-e2e.test.js   (build first: node build.js && node build.js --tauri)
// Roles (Branches step 3, app v28) in a REAL browser (Playwright/Chromium).
// seiGEN is the REAL server SQL (the live shape + 20261107120000_shop_roles)
// in an in-memory PGlite: every /rest/v1/rpc/<name> call from the pages is
// answered by running that function as role anon. Nothing reaches the live
// project.
//   * Harare (main, desktop build) registers; its first staff manager (Grace,
//     Admin) is added with the till's Admin passcode; Murehwa (phone) joins
//   * Grace signs in with her PIN: Settings → Staff & Roles → the Roles editor
//     (Manager), at 1280 and 390 px
//   * Murehwa: Sipho (Cashier) signs in: no Report Writer in More; Farai
//     (Admin) signs in: Report Writer → Inventory for Harare (from seiGEN),
//     with the cost and the value
// SHOT_DIR=<dir> saves the screenshots.
"use strict";
require("./dist-fresh");   // stop here if a bundle is older than its source (node tools/build-all.js)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, v21AdminSeed } = require("../supabase/tests/rebuild-helpers");
const { activateForTest, passJoinTrialScreen, addAdminForTest } = require("./test-activation");

let chromium;
require("./local-cdn");   // the cdnjs files from test/cdn/, not the internet
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
  fs.copyFileSync(BUILDS[desktop? "desktop" : "phone"], path.join(dir, "index.html")); if(fs.existsSync(path.join(path.dirname(BUILDS[desktop? "desktop" : "phone"]), "vendor"))) fs.cpSync(path.join(path.dirname(BUILDS[desktop? "desktop" : "phone"]), "vendor"), path.join(dir, "vendor"), { recursive: true });   // v37 (A14): the hosted builds load the engine from vendor/
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
// Settings → Staff & Roles once this till has seiGEN's staff (it arrives with a check-in).
async function openStaffCard(d){
  for(let i = 0; i < 20; i++){
    await openSettings(d);
    if(await d.page.$("#shopStaffCard")) return;
    await d.page.waitForTimeout(500);
  }
  throw new Error("no Staff & Roles card");
}
// The "Who's working today?" screen: Log out, Sign in, the name, the PIN.
async function signInAs(d, name, pin){
  await d.page.click("#logoutBtn");
  await d.page.waitForSelector("#startSignIn"); await d.page.click("#startSignIn");
  await d.page.waitForSelector("#whoSelect");
  await d.page.selectOption("#whoSelect", { label:name });
  await d.page.click("#whoSelectContinue");
  await d.page.fill("#whoPin", pin); await d.page.click("#whoPinContinue");
  await d.page.waitForSelector("#logoutBtn", { timeout:30000 });
  await waitFor(async()=> (await d.page.textContent("#userChip")).trim()===name, "signed in as "+name);
}
async function addPerson(d, o){
  await d.page.click("#addShopStaff");
  await d.page.waitForSelector("#ssName");
  await d.page.fill("#ssName", o.name);
  await d.page.selectOption("#ssRole", { label:o.role });
  await d.page.selectOption("#ssHome", { label:o.branch });
  await d.page.fill("#ssPin", o.pin);
  if(o.adminPass) await d.page.fill("#ssAdminPass", o.adminPass);
  await d.page.click("#ssSave");
  await d.page.waitForSelector("#ssName", { state:"detached", timeout:30000 });
}

(async()=>{
  pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat(["20261108120000_shop_managers_everywhere.sql", "20261109120000_office_seats.sql", "20261110120000_staff_first_owner.sql", "20261112120000_builtin_customers.sql", "20261113120000_sales_sync.sql", "20261113180000_removed_devices.sql", "20261114120000_roles_everywhere.sql", "20261115120000_stock_control.sql", "20261116120000_vendor_register_status.sql"]) });
  const browser = await chromium.launch();
  let A, C, mainInstall, harare;
  const issue = async (o)=>{
    const m = await credentials(mainInstall), s = v21AdminSeed("admin123");
    return (await serverCall("cl_branch_issue_join_code", Object.assign({ p_install_id:m.install_id, p_secret_phrase:m.shop_secret_phrase, p_device_key:m.device_key,
      p_admin_salt:s.salt, p_admin_check:s.check, p_admin_rounds:s.rounds }, o))).json;
  };

  await t("Harare (main, desktop) registers with its catalogue; Murehwa (phone) joins and counts 7 Bibs", async ()=>{
    A = await device(browser, "desktop");
    const p = A.page;
    await p.fill("#setShop", "Mandie Babyware"); await p.fill("#setBranch", "Harare"); await p.fill("#setSecret", "Gold Leaf 42");
    await p.click("#setupNext"); await p.fill("#setOwnerPhone", "0771234567"); await p.click("#setupNext2"); await p.click("#setupNext3"); await p.click("#setupFinish");
    await p.waitForSelector("[data-route]");
    await addProduct(A, { name:"Bib", sku:"BIB1", price:5, cost:2.5, stock:10 });
    await addProduct(A, { name:"Cap", sku:"CAP1", price:4, cost:1.5, stock:6 });
    await openSettings(A);
    await p.click("#termRegisterBtn");
    await p.waitForSelector('#terminalCard[data-registered="1"]');
    mainInstall = (await sq("select install_id from cl_terminals"))[0].install_id;
    await p.click("#catSyncNow"); await p.waitForSelector(".cat-report"); await p.click("#cbrApply");
    await p.waitForSelector("#cbrDone", { timeout:30000 }); await p.click("#cbrDone");
    harare = (await sq("select id from cl_branches where is_main"))[0].id;
    C = await device(browser, "phone");
    const mc = await issue({ p_new_branch_name:"Murehwa" });
    await C.page.click("#setJoinBtn"); await C.page.waitForSelector("#setJoinCode");
    await C.page.fill("#setSecret", "Gold Leaf 42"); await C.page.fill("#setJoinCode", mc.code); await C.page.fill("#setTillLabel", "Front");
    await C.page.click("#setupJoin");
    await passJoinTrialScreen(C.page); await activateForTest(C.page);
    await setStockAndRestart(C.page, [["BIB1", 7]]);
    await addAdminForTest(A.page, "admin123");          // main's own Admin passcode (it was made by setup without one)
    for(const d of [A, C]){ await moreTab(d, "branches"); await refreshBranches(d); }
  });

  await t("the first staff manager: Grace (Admin) added on main with its Admin passcode; Farai (Admin) and Sipho (Cashier) at Murehwa", async ()=>{
    await openStaffCard(A);
    assert.match(await A.page.textContent("#shopStaffCard"), /Nobody can manage staff yet/);
    await addPerson(A, { name:"Grace", role:"Admin", branch:"Harare", pin:"2580", adminPass:"admin123" });
    await waitFor(async()=> /Grace/.test(await A.page.textContent("#shopStaffCard")), "Grace in the list");
    await A.page.uncheck("#sSingleOperator");
    await waitFor(async()=> !(await A.page.isChecked("#sSingleOperator")), "single operator off");
    await signInAs(A, "Grace", "2580");
    await openStaffCard(A);
    await addPerson(A, { name:"Farai", role:"Admin", branch:"Murehwa", pin:"6666" });
    await addPerson(A, { name:"Sipho", role:"Cashier", branch:"Murehwa", pin:"5555" });
    const txt = (await A.page.textContent("#shopStaffCard")).replace(/\s+/g, " ");
    assert.match(txt, /Farai Admin · Murehwa/); assert.match(txt, /Sipho Cashier · Murehwa/); assert.match(txt, /Signed in: Grace/);
    assert.deepStrictEqual((await sq(`select s.name, r.name role from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id order by s.name`)).map((x)=> x.name+" "+x.role),
      ["Farai Admin", "Grace Admin", "Sipho Cashier"]);
  });

  await t("Settings → Staff & Roles → the Roles editor (Manager), 1280 and 390 px", async ()=>{
    await A.page.click("#staffTabRoles");
    const txt = (await A.page.textContent("#shopStaffCard")).replace(/\s+/g, " ");
    for(const r of ["Owner", "Admin", "Manager", "Stores", "Cashier"]) assert.match(txt, new RegExp(r+" built in"));
    const mgr = (await sq(`select id from cl_shop_roles where builtin = 'manager'`))[0].id;
    await A.page.click(`[data-edit-role="${mgr}"]`);
    await A.page.waitForSelector(".role-grid");
    assert.match(await A.page.textContent(".modalOverlay h3"), /Edit role: Manager/);
    assert.strictEqual(await A.page.isChecked('.modalOverlay [data-right="costs"]'), true);
    assert.strictEqual(await A.page.isChecked('.modalOverlay [data-right="m.settings"]'), false);
    await shot(A.page, "desktop-1280-roles-editor.png");
    await A.page.setViewportSize({ width:390, height:844 });
    await shot(A.page, "phone-390-roles-editor.png");
    await A.page.setViewportSize({ width:1280, height:800 });
    await A.page.click(".modalOverlay [data-modal-close]");
    assert.deepStrictEqual(A.pageErrors, []);
  });

  // v36 A2: on a laptop screen the New role box ran past the bottom edge, with Save out of sight.
  await t("v36 A2: New role, Edit role and Add person keep Save in view at 1920×1080, 1366×768 and 390 px; Save works", async ()=>{
    const inView = (sel)=> A.page.$eval(sel, (b)=>{
      const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight && !!hit && (hit===b || b.contains(hit));
    });
    const mgr = (await sq(`select id from cl_shop_roles where builtin = 'manager'`))[0].id;
    // the full screens, plus what a browser window leaves of them: a 1366×768 laptop in Chrome (tabs, address bar,
    // taskbar) and a 1920×1080 screen at Windows' 125 % scaling
    const sizes = [[1920, 1080], [1366, 768], [1366, 657], [1536, 730], [390, 844]];
    for(const [w, h] of sizes){
      await A.page.setViewportSize({ width:w, height:h });
      await A.page.click("#staffTabRoles");
      await A.page.click("#addRole"); await A.page.waitForSelector(".modalOverlay #rlSave");
      assert.ok(await inView(".modalOverlay #rlSave"), "New role: Save in view at "+w+"×"+h);
      await shot(A.page, "a2-new-role-"+w+"x"+h+".png");
      await A.page.click(".modalOverlay [data-modal-close]");
      await A.page.click(`[data-edit-role="${mgr}"]`); await A.page.waitForSelector(".modalOverlay #rlSave");
      assert.ok(await inView(".modalOverlay #rlSave"), "Edit role: Save in view at "+w+"×"+h);
      await A.page.click(".modalOverlay [data-modal-close]");
      await A.page.click("#staffTabPeople");
      await A.page.click("#addShopStaff"); await A.page.waitForSelector(".modalOverlay #ssSave");
      assert.ok(await inView(".modalOverlay #ssSave"), "Add person: Save in view at "+w+"×"+h);
      await shot(A.page, "a2-add-person-"+w+"x"+h+".png");
      await A.page.click(".modalOverlay [data-modal-close]");
    }
    // Save works where it used to be out of sight: a new role at 1366×768, without scrolling
    await A.page.setViewportSize({ width:1366, height:768 });
    await A.page.click("#staffTabRoles");
    await A.page.click("#addRole"); await A.page.waitForSelector(".modalOverlay #rlSave");
    await A.page.fill(".modalOverlay #rlName", "Night shift");
    await A.page.check('.modalOverlay [data-right="m.sell"]');
    await A.page.click(".modalOverlay #rlSave", { noWaitAfter:true });
    await waitFor(async()=> !(await A.page.$(".modalOverlay #rlSave")), "the box closes after Save");
    assert.strictEqual((await sq(`select count(*)::int n from cl_shop_roles where name = 'Night shift'`))[0].n, 1);
    await A.page.setViewportSize({ width:1280, height:800 });
    assert.deepStrictEqual(A.pageErrors, []);
  });

  await t("Murehwa: Sipho (Cashier) signs in: Sell and Credit, no Products, no Report Writer in More", async ()=>{
    await activateForTest(C.page);                                  // a check-in brings Murehwa's staff
    await waitFor(async()=>{ await openSettings(C); return !!(await C.page.$("#shopStaffCard")) && /Sipho/.test(await C.page.textContent("#shopStaffCard")); }, "Murehwa has the staff", 30000);
    await C.page.uncheck("#sSingleOperator");
    await signInAs(C, "Sipho", "5555");
    const navs = await C.page.$$eval(".navbar [data-route]", (b)=> b.map((x)=> x.dataset.route));
    assert.deepStrictEqual(navs, ["pos", "credit", "reports", "more"]);
    await nav(C, "more");
    await C.page.click('[data-kebab-toggle="moretab"]');
    const tabs = await C.page.$$eval("#menu-moretab [data-tab]", (b)=> b.map((x)=> x.textContent.trim()));
    assert.ok(!tabs.includes("Report Writer") && !tabs.includes("Settings") && tabs.includes("Directory"), tabs.join(", "));
    await shot(C.page, "phone-390-cashier-more-no-report-writer.png");
    await C.page.setViewportSize({ width:1280, height:800 });
    await shot(C.page, "desktop-1280-cashier-more-no-report-writer.png");
    await C.page.setViewportSize({ width:390, height:844 });
    await C.page.click('[data-kebab-toggle="moretab"]');
  });

  await t("Murehwa: Farai (Admin) signs in: Report Writer → Inventory for Harare (from seiGEN), with the cost and the value", async ()=>{
    await signInAs(C, "Farai", "6666");
    await moreTab(C, "reportwriter");
    await C.page.selectOption("#rwTypeSel", "inventory");
    await C.page.waitForSelector('#rwBranchSel option[value^="srv:"]', { state:"attached" });
    const opts = await C.page.$$eval("#rwBranchSel option", (o)=> o.map((x)=> x.textContent));
    assert.deepStrictEqual(opts, ["Murehwa (this branch)", "Harare (from seiGEN)"]);
    await C.page.selectOption("#rwBranchSel", { label:"Harare (from seiGEN)" });
    await C.page.click("#rwView");
    await waitFor(async()=> /value at cost/.test(await C.page.textContent("#rwResults")), "Harare's inventory", 30000);
    const res = (await C.page.textContent("#rwResults")).replace(/\s+/g, " ");
    assert.match(res, /Bib ?10 ?\$2\.50 ?\$25\.00/, res); assert.match(res, /value at cost \$34\.00/, res);   // 10 × 2.50 + 6 × 1.50
    await shot(C.page, "phone-390-admin-report-writer-harare.png");
    await C.page.setViewportSize({ width:1280, height:800 });
    await shot(C.page, "desktop-1280-admin-report-writer-harare.png");
    await C.page.setViewportSize({ width:390, height:844 });
    assert.deepStrictEqual(C.pageErrors, []);
  });

  await browser.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
