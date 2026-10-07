// Run: node --no-warnings test/logout-start-e2e.test.js
// (build first: node build.js --pwa && node build.js --tauri)
// Start screen + Log out, in a REAL browser against BOTH shipped builds:
// dist-pwa at phone width (bottom tab bar) and dist-tauri at 1280px
// (hamburger drawer). Digital Commerce is answered by test/dc-fake.js.
//   * reopening the app → Start screen → Sign in → Who's working → app
//   * Log out with an item in the cart → message, still in the app, cart unchanged
//   * Log out with an empty cart → Start screen; audit_log has a Logout row; Sign in works again
//   * Single operator mode and PIN mode both work after a logout
//   * an expired activation still shows the lock screen, not the Start screen
// The database is read straight from IndexedDB with the page's own sql.js —
// the same blob the app persists — so the audit check needs no test hooks.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stubDigitalCommerce, TEST_PHRASE } = require("./dc-fake");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
for(const b of ["dist-pwa","dist-tauri"]) if(!fs.existsSync(path.join(ROOT,b,"index.html"))){ console.log("Missing "+b+" — run: node build.js --pwa && node build.js --tauri"); process.exit(1); }
const SHOTS = process.env.SHOT_DIR || "";

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const fileUrl = (p)=> "file:///" + p.replace(/\\/g, "/");
async function waitFor(cond, what){
  const deadline = Date.now() + 10000;
  while(!(await cond())){ if(Date.now() > deadline) throw new Error("timed out waiting for "+what); await new Promise(r=>setTimeout(r, 100)); }
}

// One browser context per build = one device with its own IndexedDB.
async function openBuild(browser, build){
  const desktop = build==="dist-tauri";
  const ctx = await browser.newContext({ viewport: desktop? { width:1280, height:800 } : { width:390, height:844 } });
  await stubDigitalCommerce(ctx);
  const page = await ctx.newPage();
  const alerts = [], errors = [];
  page.on("dialog", d=>{ alerts.push(d.message()); d.accept(); });
  page.on("pageerror", e=>errors.push(e.message));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-start-"));
  for(const f of fs.readdirSync(path.join(ROOT, build))) fs.copyFileSync(path.join(ROOT, build, f), path.join(dir, f));
  const url = fileUrl(path.join(dir, "index.html"));
  await page.goto(url);
  await page.waitForSelector("#setShop", { timeout: 20000 });
  return { ctx, page, alerts, errors, desktop, url };
}
async function gotoRoute(page, route, desktop){
  if(desktop){ await page.click("#hamburgerBtn"); await page.click('#navDrawer [data-route="'+route+'"]'); }
  else await page.click('.navbar [data-route="'+route+'"]');
}
// The app's own database, read from IndexedDB with the page's sql.js.
async function dbQuery(page, sql){
  return page.evaluate(async (sql)=>{
    const bytes = await new Promise((res, rej)=>{
      const r = indexedDB.open("seigen_lite_db", 1);
      r.onsuccess = ()=>{ const g = r.result.transaction("kv","readonly").objectStore("kv").get("dbfile"); g.onsuccess = ()=>res(g.result); g.onerror = ()=>rej(g.error); };
      r.onerror = ()=>rej(r.error);
    });
    const SQL = await initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/"+f });
    const d = new SQL.Database(new Uint8Array(bytes));
    const res = d.exec(sql);
    d.close();
    return res.length? res[0].values.map(v=>Object.fromEntries(res[0].columns.map((c,i)=>[c,v[i]]))) : [];
  }, sql);
}
async function dbWrite(page, sql){
  await page.evaluate(async (sql)=>{
    const open = ()=> new Promise((res, rej)=>{ const r = indexedDB.open("seigen_lite_db", 1); r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); });
    const conn = await open();
    const bytes = await new Promise((res, rej)=>{ const g = conn.transaction("kv","readonly").objectStore("kv").get("dbfile"); g.onsuccess = ()=>res(g.result); g.onerror = ()=>rej(g.error); });
    const SQL = await initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/"+f });
    const d = new SQL.Database(new Uint8Array(bytes));
    d.run(sql);
    const out = d.export(); d.close();
    await new Promise((res, rej)=>{ const tx = conn.transaction("kv","readwrite"); tx.objectStore("kv").put(out, "dbfile"); tx.oncomplete = ()=>res(); tx.onerror = ()=>rej(tx.error); });
  }, sql);
}
async function signInSingle(page, name){
  await page.click("#startSignIn");
  await page.waitForSelector("#whoName");
  await page.fill("#whoName", name);
  await page.click("#whoContinue");
  await page.waitForSelector("#logoutBtn");
}
async function cartCount(page){ const b = await page.$(".cart-badge"); return b? (await b.textContent()).trim() : "0"; }

async function runFor(browser, build){
  const d = await openBuild(browser, build);
  const { page, alerts, desktop } = d;
  const tag = build+": ";

  await t(tag+"reopening the app shows the Start screen (shop, branch) → Sign in → Who's working → app", async ()=>{
    await page.fill("#setShop", "Gentronix"); await page.fill("#setBranch", "Harare CBD"); await page.fill("#setSecret", TEST_PHRASE);
    await page.click("#setupNext"); await page.click("#setupNext2"); await page.click("#setupNext3"); await page.click("#setupFinish");
    await page.waitForSelector("#logoutBtn");                       // setup still goes straight into the app, unchanged
    await page.waitForTimeout(400);                                  // let persist() land
    await page.reload();
    await page.waitForSelector("#startSignIn", { timeout: 20000 });
    assert.strictEqual((await page.textContent("#startShop")).trim(), "Gentronix");
    assert.strictEqual((await page.textContent("#startPlace")).trim(), "Harare CBD");
    // the brand globe loads from the build folder, square and undistorted (180px phone, 240px desktop)
    await page.waitForFunction(()=>{ const g = document.getElementById("startGlobe"); return g && g.complete && g.naturalWidth>0; });
    const g = await page.evaluate(()=>{ const r = document.getElementById("startGlobe").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    assert.deepStrictEqual(g, desktop? { w:240, h:240 } : { w:180, h:180 });
    assert.ok(await page.$("#startCard .start-mark svg"), "the storefront fallback is still there (hidden)");
    assert.strictEqual(await page.$("#whoName"), null, "Start comes BEFORE Who's working");
    if(SHOTS) await page.screenshot({ path: path.join(SHOTS, build+"-start.png") });
    await signInSingle(page, "Tendai");
    assert.match(await page.textContent(".topbar"), /Tendai/);
    const btn = await page.$("#logoutBtn");
    assert.strictEqual(await btn.getAttribute("aria-label"), "Log out");
    assert.strictEqual(await btn.getAttribute("title"), "Log out");
    const box = await btn.boundingBox();
    assert.ok(box.width>=40 && box.height>=40, "tap target at least 40x40, got "+box.width+"x"+box.height);
    assert.ok(await page.$("#logoutBtn svg path"), "inline SVG outline icon");
    if(SHOTS) await page.screenshot({ path: path.join(SHOTS, build+"-topbar.png"), clip:{ x:0, y:0, width: desktop? 1280 : 390, height: 70 } });
  });

  await t(tag+"Log out with an item in the cart: message shown, still in the app, cart unchanged", async ()=>{
    await gotoRoute(page, "products", desktop);
    await page.click("#openAddProduct");
    await page.waitForSelector("#pName");
    await page.fill("#pName", "Rice 2kg"); await page.fill("#pPrice", "3"); await page.fill("#pStock", "10");
    await page.click("#pConfirm");
    await page.waitForSelector(".modalOverlay", { state: "detached" });
    await gotoRoute(page, "pos", desktop);
    await page.locator("[data-add]").first().click();
    await waitFor(async()=> (await cartCount(page))==="1", "the cart badge");
    alerts.length = 0;
    await page.click("#logoutBtn");
    await waitFor(async()=> alerts.length>0, "the message");
    assert.strictEqual(alerts[0], "Clear the cart or finish the sale first.");
    assert.ok(await page.$("#logoutBtn"), "still in the app");
    assert.strictEqual(await page.$("#startSignIn"), null);
    assert.strictEqual(await cartCount(page), "1", "cart untouched");
    assert.match(await page.textContent(".topbar"), /Tendai/, "still signed in");
  });

  await t(tag+"Log out with an empty cart: Start screen, audit_log has a Logout row for Tendai, Sign in works again", async ()=>{
    // empty the cart through the cart itself (qty − to zero)
    await page.click("#cartBtn");
    await page.waitForSelector("#drawer.show");
    await page.locator('#drawer [data-dec]').first().click();
    await waitFor(async()=> (await cartCount(page))==="0", "an empty cart");
    if(await page.$("#closeDrawer")) await page.click("#closeDrawer");
    await page.click("#logoutBtn");
    await page.waitForSelector("#startSignIn");
    await page.waitForTimeout(400);
    const rows = await dbQuery(page, "SELECT action,user,details FROM audit_log WHERE action='Logout'");
    assert.strictEqual(rows.length, 1, JSON.stringify(rows));
    assert.strictEqual(rows[0].user, "Tendai"); assert.strictEqual(rows[0].details, "Tendai");
    const shift = await dbQuery(page, "SELECT COUNT(*) n FROM eod_sessions WHERE status='closed' AND closed_ts<>''");
    assert.strictEqual(shift[0].n, 0, "no shift was closed by logging out");
    await signInSingle(page, "Rudo");
    assert.match(await page.textContent(".topbar"), /Rudo/);
  });

  await t(tag+"PIN mode: after Log out, Sign in shows the staff list + PIN and lets the staff member in", async ()=>{
    await gotoRoute(page, "more", desktop);
    await page.locator('[data-kebab-toggle="moretab"]:visible').first().click();
    await page.locator('[data-tab="settings"]:visible').first().click();
    await page.click("#openAddStaff");
    await page.fill("#stName", "Chipo"); await page.fill("#stPin", "4821");
    await page.click("#stConfirm");
    await page.waitForSelector(".modalOverlay", { state: "detached" });
    await page.uncheck("#sSingleOperator");                          // confirm() is accepted by the dialog handler
    await waitFor(async()=> !(await page.isChecked("#sSingleOperator")), "PIN mode on");
    await page.click("#logoutBtn");
    await page.waitForSelector("#startSignIn");
    await page.click("#startSignIn");
    await page.waitForSelector("#whoSelect");
    assert.strictEqual(await page.$("#whoName"), null, "no free-text name in PIN mode");
    assert.strictEqual(await page.$("#whoCancel"), null, "no Cancel back into a session that has ended");
    await page.click("#whoSelectContinue");
    await page.fill("#whoPin", "4821");
    await page.click("#whoPinContinue");
    await page.waitForSelector("#logoutBtn");
    assert.match(await page.textContent(".topbar"), /Chipo/);
    await page.click("#logoutBtn");
    await page.waitForSelector("#startSignIn");
    const rows = await dbQuery(page, "SELECT user FROM audit_log WHERE action='Logout' ORDER BY id");
    assert.deepStrictEqual(rows.map(r=>r.user), ["Tendai","Rudo","Chipo"]);
  });

  await t(tag+"with a till code from multi-terminal registration, the Start screen shows it (\"Harare CBD · T2\")", async ()=>{
    await dbWrite(page, "INSERT INTO settings(key,value) VALUES('till_code','T2') ON CONFLICT(key) DO UPDATE SET value='T2'");
    await page.reload();
    await page.waitForSelector("#startSignIn", { timeout: 20000 });
    assert.strictEqual((await page.textContent("#startPlace")).trim(), "Harare CBD · T2");
    if(SHOTS) await page.screenshot({ path: path.join(SHOTS, build+"-start-till.png") });
  });

  await t(tag+"an expired activation shows the lock screen, not the Start screen", async ()=>{
    // v11 (activation.js): the trial runs 30 days from the install date (or older business data)
    await dbWrite(page, "UPDATE settings SET value='2026-01-01T00:00:00.000Z' WHERE key='install_date'");
    await page.reload();
    await page.waitForSelector("#unlockBtn", { timeout: 20000 });
    assert.strictEqual(await page.$("#startSignIn"), null);
    assert.match(await page.textContent("#app"), /Activation needed/);
  });

  assert.deepStrictEqual(d.errors, [], "page errors: "+d.errors.join(" | "));
  await d.ctx.close();
}

(async()=>{
  const browser = await chromium.launch();
  await runFor(browser, "dist-pwa");
  await runFor(browser, "dist-tauri");
  await browser.close();
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
