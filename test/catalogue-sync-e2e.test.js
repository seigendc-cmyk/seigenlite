// Run: node --no-warnings test/catalogue-sync-e2e.test.js   (build first: node build.js && node build.js --tauri)
// Multi-terminal Phase 3a in a REAL browser (Playwright/Chromium). "Digital
// Commerce" is the REAL server SQL (live stub + Phase 1 + Phase 2 + the
// catalogue migration) in an in-memory PGlite: every /rest/v1/rpc/<name> call
// from the pages is answered by running that function as role anon. Nothing
// reaches the live project.
//   * main (desktop build, 1280px): products → register → first-sync report
//     (lists the product with no code) → upload → status line
//   * a second business's main at phone width: its first-sync report
//   * a new remote till (phone, 390px) joins: products arrive, create/edit
//     hidden, Sync now; sells a product it has no stock of
//   * a remote till on the desktop build: pictures on by default, the
//     estimate shown first, then downloaded and shown on Sell
//   * main re-prices → Sync now on both → the remote shows the new price
// SHOT_DIR=<dir> saves screenshots (phone width and 1280px).
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LIVE_STUB } = require("../supabase/tests/live-stub");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
const BUILDS = { phone: path.join(ROOT, "dist", "index.html"), desktop: path.join(ROOT, "dist-tauri", "index.html") };
for(const b of Object.values(BUILDS)) if(!fs.existsSync(b)){ console.log("Missing "+b+" — run: node build.js && node build.js --tauri"); process.exit(1); }
const SHOTS = process.env.SHOT_DIR || "";
if(SHOTS) fs.mkdirSync(SHOTS, { recursive:true });
const MIG = (f)=>fs.readFileSync(path.join(ROOT,"supabase",f),"utf8");

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
const CASTS = { p_rows:"::jsonb", p_uids:"::text[]", p_branch_id:"::uuid", p_terminal_id:"::uuid", p_cursor:"::bigint", p_limit:"::integer", p_active:"::boolean", p_rpn_hint_id:"::uuid" };
let queue = Promise.resolve();
function serverCall(name, body){
  // one call at a time on the single PGlite connection (role switching is per connection)
  const run = async ()=>{
    const keys = Object.keys(body);
    const vals = keys.map(k=> k==="p_rows"? JSON.stringify(body[k]) : k==="p_uids"? "{"+body[k].join(",")+"}" : body[k]);
    await pg.exec("set role anon");
    try{ return { status:200, json:(await pg.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}${CASTS[k]||""}`).join(",")})::json j`, vals)).rows[0].j }; }
    catch(e){ return { status:400, json:{ code:"P0001", message:e.message } }; }
    finally{ await pg.exec("reset role"); }
  };
  const p = queue.then(run, run); queue = p.catch(()=>{}); return p;
}
const sq = async (sql, p)=> (await pg.query(sql, p)).rows;

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
  const pageErrors = [], dialogs = [];
  page.on("pageerror", e=>pageErrors.push(e.message));
  page.on("dialog", d=>{ dialogs.push(d.message()); d.accept(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-cat-"));
  fs.copyFileSync(BUILDS[desktop? "desktop" : "phone"], path.join(dir, "index.html"));
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#setShop", { timeout: 30000 });
  return { ctx, page, pageErrors, dialogs, desktop };
}
async function nav(d, route){
  if(d.desktop){ await d.page.click("#hamburgerBtn"); await d.page.click('#navDrawer [data-route="'+route+'"]'); }
  else await d.page.click('.navbar [data-route="'+route+'"]');
}
async function openSettings(d){
  await nav(d, "more");
  await d.page.click('[data-kebab-toggle="moretab"]');
  await d.page.click('[data-tab="settings"]');
  if(await d.page.$("#settingsPasscode")){ await d.page.fill("#settingsPasscode", "admin123"); await d.page.click("#unlockSettings"); }
  else if(await d.page.$("#newAdminPass")){ await d.page.fill("#newAdminPass", "admin123"); await d.page.fill("#newAdminPass2", "admin123"); await d.page.click("#createAdmin"); }
  await d.page.waitForSelector("#terminalCard");
}
async function setupMain(d, shop, branch, phrase){
  const p = d.page;
  await p.fill("#setShop", shop); await p.fill("#setBranch", branch); await p.fill("#setSecret", phrase);
  await p.click("#setupNext"); await p.click("#setupNext2"); await p.click("#setupNext3"); await p.click("#setupFinish");
  await p.waitForSelector("[data-route]");
}
async function addProduct(d, o){
  const p = d.page;
  await nav(d, "products");
  await p.click("#openAddProduct");
  if(o.image) await p.setInputFiles("#pImage", o.image);
  await p.fill("#pName", o.name); await p.fill("#pSku", o.sku||""); await p.fill("#pPrice", String(o.price));
  await p.fill("#pCost", String(o.cost||1)); await p.fill("#pStock", String(o.stock==null?10:o.stock));
  if(o.image) await p.waitForSelector("#pImgPreview img");
  await p.click("#pConfirm");
  await p.waitForSelector(".modalOverlay", { state:"detached" });
}
async function credentials(install){
  return (await sq("select install_id, shop_secret_phrase, device_key from cl_vendors where install_id=$1",[install]))[0];
}
async function installOf(d){ return (await sq("select install_id from cl_vendors order by app_registered_at desc limit 1"))[0].install_id; }

(async()=>{
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  pg = new PGlite({ extensions:{ pgcrypto } });
  await pg.exec(LIVE_STUB);
  await pg.exec(MIG("migrations/20261004120000_multi_terminal_identity.sql"));
  await pg.exec(MIG("migrations/20261004180000_multi_terminal_phase2.sql"));
  await pg.exec(MIG("migrations/20261006120000_catalogue_sync.sql"));
  const browser = await chromium.launch();
  const PIC = path.join(ROOT, "assets", "brand", "globe-master.png");
  let A, mainInstall, murehwa;

  await t("main (desktop, 1280px): first-sync report lists the product with no code, then uploads the catalogue", async ()=>{
    A = await device(browser, "desktop");
    await setupMain(A, "Gentronix", "Harare CBD", "Gold Leaf 42");
    await addProduct(A, { name:"Rice 2kg", sku:"RICE2", price:10.5, image:PIC });
    await addProduct(A, { name:"Sugar 1kg", sku:"SUG1", price:4 });
    await addProduct(A, { name:"Loose sweets", sku:"", price:0.5 });
    await openSettings(A);
    await A.page.click("#termRegisterBtn");
    await A.page.waitForSelector('#terminalCard[data-registered="1"]');
    mainInstall = (await sq("select install_id from cl_terminals"))[0].install_id;
    await A.page.click("#catSyncNow");
    await A.page.waitForSelector(".cat-report");
    const rep = await A.page.textContent(".modalOverlay");
    assert.match(rep, /To upload as new: 3/); assert.match(rep, /Products without a code \(1\)/); assert.match(rep, /Loose sweets/);
    await shot(A.page, "desktop-first-sync-report.png");
    assert.strictEqual((await sq("select count(*)::int n from cl_catalogue_products"))[0].n, 0, "nothing sent before the OK");
    await A.page.click("#cbrApply");
    await A.page.waitForSelector("#cbrDone", { timeout:30000 });
    await A.page.click("#cbrDone");
    assert.deepStrictEqual((await sq("select name from cl_catalogue_products order by name")).map(r=>r.name), ["Loose sweets","Rice 2kg","Sugar 1kg"]);
    assert.ok((await sq("select image_bytes from cl_catalogue_products where code='RICE2'"))[0].image_bytes > 0, "the picture's thumbnail went up");
    await openSettings(A);
    await A.page.locator("#catStatus").scrollIntoViewIfNeeded();
    assert.match(await A.page.textContent("#catStatus"), /Catalogue synced .* · 3 products/);
    assert.match(await A.page.textContent("#terminalCard"), /1 product has no code/);
    await shot(A.page, "desktop-sync-status.png");
    assert.deepStrictEqual(A.pageErrors, []);
  });

  await t("another business's main at phone width: its first-sync report", async ()=>{
    const B = await device(browser, "phone");
    await setupMain(B, "Other Shop", "Bulawayo", "Other Phrase");
    await addProduct(B, { name:"Bread", sku:"BRD", price:1 });
    await addProduct(B, { name:"Milk", sku:"", price:1.1 });
    await openSettings(B);
    await B.page.click("#termRegisterBtn");
    await B.page.waitForSelector('#terminalCard[data-registered="1"]');
    await B.page.click("#catSyncNow");
    await B.page.waitForSelector(".cat-report");
    assert.match(await B.page.textContent(".modalOverlay"), /Products without a code \(1\)[\s\S]*Milk/);
    await shot(B.page, "phone-first-sync-report.png");
    await B.page.click("#cbrLater");
    assert.strictEqual((await sq("select count(*)::int n from cl_catalogue_products p join cl_businesses b on b.id=p.business_id where b.name='Other Shop'"))[0].n, 0, "Not now changes nothing");
    assert.deepStrictEqual(B.pageErrors, []);
    await B.ctx.close();
  });

  let C;
  await t("a new remote till (phone) joins: products arrive with stock 0; create/edit hidden; Sync now; never sells below zero", async ()=>{
    const m = await credentials(mainInstall);
    const code = (await serverCall("cl_branch_issue_join_code", { p_install_id:m.install_id, p_secret_phrase:m.shop_secret_phrase, p_device_key:m.device_key, p_branch_id:null, p_new_branch_name:"Murehwa" })).json;
    murehwa = code.branch_id;
    C = await device(browser, "phone");
    await C.page.click("#setJoinBtn"); await C.page.waitForSelector("#setJoinCode");
    await C.page.fill("#setSecret", "Gold Leaf 42"); await C.page.fill("#setJoinCode", code.code); await C.page.fill("#setTillLabel", "Front");
    await C.page.click("#setupJoin");
    await C.page.waitForSelector("[data-route]", { timeout:20000 });
    await nav(C, "products");
    await waitFor(async()=> /Rice 2kg/.test(await C.page.textContent("#productsTableArea")), "products to arrive", 30000);
    assert.strictEqual(await C.page.$("#openAddProduct"), null, "no Add Product on a remote till");
    assert.strictEqual(await C.page.$("#openGetCatalogue"), null, "no catalogue file once registered");
    assert.ok(await C.page.$("#productsSyncNow"), "Sync now on the Products screen");
    assert.match(await C.page.textContent(".remote-sync-line"), /Products come from your main branch\. Catalogue synced/);
    await shot(C.page, "phone-remote-products.png");
    assert.strictEqual(await C.page.$(".till-stock-note"), null, "a single-till branch (T1) has no stock note");
    // a product with no stock here can't be sold
    await nav(C, "pos");
    const add = C.page.locator('.product-row:has-text("Sugar 1kg") .add-chip');
    await add.first().waitFor();
    assert.strictEqual(await add.first().isDisabled(), true, "Out at zero stock, registered or not");
    assert.strictEqual((await add.first().textContent()).trim(), "Out");
    assert.deepStrictEqual(C.pageErrors, []);
  });

  await t("remote Settings (phone): status line, Sync now, picture switch off by default", async ()=>{
    await openSettings(C);
    await C.page.locator("#catSyncNow").scrollIntoViewIfNeeded();
    assert.strictEqual(await C.page.isChecked("#catPicsSwitch"), false, "pictures off on phones");
    await C.page.click("#catSyncNow");
    await waitFor(async()=> /Up to date|change/.test(await C.page.textContent("#catMsg").catch(()=>"")), "the Sync now result");
    await shot(C.page, "phone-sync-status.png");
  });

  let D;
  await t("a remote till on the desktop build: pictures on by default; size shown before the first download; then shown on Sell", async ()=>{
    const m = await credentials(mainInstall);
    const code = (await serverCall("cl_branch_issue_join_code", { p_install_id:m.install_id, p_secret_phrase:m.shop_secret_phrase, p_device_key:m.device_key, p_branch_id:murehwa, p_new_branch_name:null })).json;
    D = await device(browser, "desktop");
    await D.page.click("#setJoinBtn"); await D.page.waitForSelector("#setJoinCode");
    await D.page.fill("#setSecret", "Gold Leaf 42"); await D.page.fill("#setJoinCode", code.code);
    await D.page.click("#setupJoin");
    await D.page.waitForSelector("[data-route]", { timeout:20000 });
    await nav(D, "products");                                               // let the background first sync land
    await waitFor(async()=> /Rice 2kg/.test(await D.page.textContent("#productsTableArea")), "products to arrive", 30000);
    await openSettings(D);
    await D.page.click("#catSyncNow");
    await waitFor(async()=> !!(await D.page.$("#catPicsPrompt")), "the picture download prompt", 30000);
    assert.strictEqual(await D.page.isChecked("#catPicsSwitch"), true, "pictures on for desktop");
    assert.match(await D.page.textContent("#catPicsPrompt"), /Download 1 product picture \(about \d+ KB\)\?/);
    // Sync now can join a background sync already running; both redraw the card when they finish
    await D.page.waitForTimeout(1000);
    await D.page.locator("#catPicsPrompt").scrollIntoViewIfNeeded();
    await shot(D.page, "desktop-pictures-prompt.png");
    await D.page.click("#catPicsYes");
    await waitFor(async()=> !(await D.page.$("#catPicsPrompt")), "the download to finish");
    await nav(D, "products");
    await waitFor(async()=> /Rice 2kg/.test(await D.page.textContent("#productsTableArea")), "products");
    assert.strictEqual(await D.page.$("#openAddProduct"), null);
    assert.match(await D.page.textContent(".till-stock-note"), /Stock for this till isn't set up yet — coming in the next update./, "T2 of Murehwa: note on Products");
    await shot(D.page, "desktop-remote-products.png");
    await nav(D, "pos");
    await waitFor(async()=> (await D.page.$$('img.ds-thumb[data-cat-pic][src^="data:image/"]')).length===1, "the downloaded picture on Sell");
    assert.match(await D.page.textContent(".till-stock-note"), /Stock for this till isn't set up yet/, "... and on Sell");
    assert.strictEqual(await D.page.locator('.ds-add-btn').first().isDisabled(), true, "Out at zero stock");
    await shot(D.page, "desktop-remote-sell-pictures.png");
    const inSql = await D.page.evaluate(()=>new Promise(res=>{ const r = indexedDB.open("seigen_cat_pics"); r.onsuccess = ()=>{ const q = r.result.transaction("pics").objectStore("pics").count(); q.onsuccess = ()=>res(q.result); }; }));
    assert.strictEqual(inSql, 1, "the picture is in its own IndexedDB store");
    assert.deepStrictEqual(D.pageErrors, []);
  });

  await t("main re-prices → Sync now on main and on the remote → the remote shows the new price", async ()=>{
    await nav(A, "products");
    await A.page.locator('#productsTableArea tr:has-text("Sugar 1kg") [data-rowmenu]').click();
    await A.page.locator('.popmenu button:has-text("Edit")').click();
    await A.page.waitForSelector("#pPrice");
    await A.page.fill("#pPrice", "4.75");
    await A.page.click("#pConfirm");
    await A.page.click("#productsSyncNow");
    await waitFor(async()=> Number((await sq("select price from cl_catalogue_products where code='SUG1'"))[0].price)===4.75, "the new price on the server");
    await nav(C, "products");
    await C.page.click("#productsSyncNow");
    await waitFor(async()=> /4\.75/.test(await C.page.textContent("#productsTableArea")), "the new price on the remote");
    assert.deepStrictEqual(A.pageErrors, []); assert.deepStrictEqual(C.pageErrors, []);
  });

  await browser.close();
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
