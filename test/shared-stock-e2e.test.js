// Run: node --no-warnings test/shared-stock-e2e.test.js   (build first: node build.js && node build.js --tauri)
// Multi-terminal Phase 3b in a REAL browser (Playwright/Chromium). "Digital
// Commerce" is the REAL server SQL (live stub + Phase 1, 2, 3a, 3b) in an
// in-memory PGlite: every /rest/v1/rpc/<name> call is answered by running that
// function as role anon. Nothing reaches the live project.
//   * main T1 (desktop, 1280px): products, an Admin, register, first catalogue sync
//   * T2 (phone, 390px) joins the same branch: the stock note while the branch is local
//   * T1 starts shared stock (Admin passcode); both tills show branch stock / their allowance
//   * T1 sells the last sugar; T2's sale of it is refused with a clear message
//   * T2 offline: the offline badge, "N on this till (offline)", a sale from its allowance
//   * T1 offline with more in the cart than its allowance: the offline refusal
//   * Diagnostics: the branch stock balance check
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
const MIG = (f)=>fs.readFileSync(path.join(ROOT,"supabase","migrations",f),"utf8");

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
const CASTS = { p_rows:"::jsonb", p_lines:"::jsonb", p_moves:"::jsonb", p_sales:"::jsonb", p_counts:"::jsonb", p_uids:"::text[]", p_branch_id:"::uuid",
  p_terminal_id:"::uuid", p_cursor:"::bigint", p_limit:"::integer", p_active:"::boolean", p_rpn_hint_id:"::uuid" };
const JSONB = ["p_rows","p_lines","p_moves","p_sales","p_counts"];
let queue = Promise.resolve();
function serverCall(name, body){
  const run = async ()=>{
    const keys = Object.keys(body);
    const vals = keys.map(k=> JSONB.includes(k)? JSON.stringify(body[k]) : k==="p_uids"? "{"+body[k].join(",")+"}" : body[k]);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-ss-"));
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
  if(await d.page.$("#settingsPasscode")){ await d.page.fill("#settingsPasscode", "1234"); await d.page.click("#unlockSettings"); }
  else if(await d.page.$("#newAdminPass")){ await d.page.fill("#newAdminPass", "1234"); await d.page.fill("#newAdminPass2", "1234"); await d.page.click("#createAdmin"); }
  await d.page.waitForSelector("#terminalCard");
}
async function addProduct(d, o){
  const p = d.page;
  await nav(d, "products");
  await p.click("#openAddProduct");
  await p.fill("#pName", o.name); await p.fill("#pSku", o.sku); await p.fill("#pPrice", String(o.price));
  await p.fill("#pCost", "1"); await p.fill("#pStock", String(o.stock));
  await p.click("#pConfirm");
  await p.waitForSelector(".modalOverlay", { state:"detached" });
}
async function startShift(d){
  await nav(d, "pos");
  const go = await d.page.$("#goToEodBtn");
  if(!go) return;
  await go.click();
  await d.page.waitForSelector("#openingFloat");
  await d.page.fill("#openingFloat", "0");
  await d.page.click("#startShiftBtn");
  await nav(d, "pos");
}
async function syncNow(d){
  await nav(d, "products");
  await d.page.click("#productsSyncNow");
  await waitFor(async()=> !!(await d.page.$("#productsSyncNow")) && (await d.page.textContent("#productsSyncNow")).includes("Sync now"), "Sync now to finish", 30000);
}
const server = async (code)=> (await sq(`select bs.total, bs.available from cl_branch_stock bs join cl_catalogue_products c on c.product_uid=bs.product_uid and c.business_id=bs.business_id where c.code=$1`,[code]))[0];

(async()=>{
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  pg = new PGlite({ extensions:{ pgcrypto } });
  await pg.exec(LIVE_STUB);
  for(const f of ["20261004120000_multi_terminal_identity","20261004180000_multi_terminal_phase2","20261006120000_catalogue_sync","20261007120000_shared_stock"]) await pg.exec(MIG(f+".sql"));
  const browser = await chromium.launch();
  let A, B, mainInstall;

  await t("setup: main T1 (desktop) with products and an Admin registers and uploads its catalogue; T2 (phone) joins the same branch", async ()=>{
    A = await device(browser, "desktop");
    const p = A.page;
    await p.fill("#setShop", "Gentronix"); await p.fill("#setBranch", "Harare"); await p.fill("#setSecret", "Gold Leaf 42");
    await p.click("#setupNext"); await p.click("#setupNext2"); await p.click("#setupNext3"); await p.click("#setupFinish");
    await p.waitForSelector("[data-route]");
    await addProduct(A, { name:"Rice 2kg", sku:"RICE", price:10, stock:30 });
    await addProduct(A, { name:"Sugar 1kg", sku:"SUG", price:4, stock:1 });
    await openSettings(A);
    await p.click("#openAddStaff");
    await p.fill("#stName", "Owner"); await p.selectOption("#stRole", "Admin"); await p.fill("#stPasscode", "1234"); await p.fill("#stPin", "4821");
    await p.click("#stConfirm");
    await p.waitForSelector(".modalOverlay", { state:"detached" });
    await p.click("#termRegisterBtn");
    await p.waitForSelector('#terminalCard[data-registered="1"]');
    await p.click("#catSyncNow"); await p.waitForSelector(".cat-report"); await p.click("#cbrApply");
    await p.waitForSelector("#cbrDone", { timeout:30000 }); await p.click("#cbrDone");
    mainInstall = (await sq("select install_id from cl_terminals"))[0].install_id;
    const m = (await sq("select install_id, shop_secret_phrase, device_key from cl_vendors where install_id=$1",[mainInstall]))[0];
    const branch = (await sq("select branch_id from cl_terminals"))[0].branch_id;
    const code = (await serverCall("cl_branch_issue_join_code", { p_install_id:m.install_id, p_secret_phrase:m.shop_secret_phrase, p_device_key:m.device_key, p_branch_id:branch, p_new_branch_name:null })).json;
    B = await device(browser, "phone");
    await B.page.click("#setJoinBtn"); await B.page.waitForSelector("#setJoinCode");
    await B.page.fill("#setSecret", "Gold Leaf 42"); await B.page.fill("#setJoinCode", code.code);
    await B.page.click("#setupJoin");
    await B.page.waitForSelector("[data-route]", { timeout:20000 });
    await nav(B, "products");
    await waitFor(async()=> /Rice 2kg/.test(await B.page.textContent("#productsTableArea")), "products on T2", 30000);
    assert.match(await B.page.textContent(".till-stock-note"), /This till has no stock yet/, "while the branch is local, T2 has no stock");
    await shot(B.page, "phone-t2-no-stock-note-products.png");
    await nav(B, "pos");
    assert.match(await B.page.textContent(".till-stock-note"), /This till has no stock yet/, "... and on Sell");
    await shot(B.page, "phone-t2-no-stock-note-sell.png");
    await nav(B, "products");
    assert.deepStrictEqual(A.pageErrors, []); assert.deepStrictEqual(B.pageErrors, []);
  });

  await t("T1 starts shared stock with its Admin passcode; both tills then show branch stock and their allowance", async ()=>{
    await openSettings(A);
    await A.page.click("#catSyncNow");
    await waitFor(async()=> /Up to date|change/.test(await A.page.textContent("#catMsg").catch(()=>"")), "the sync");
    await openSettings(A);
    await A.page.click("#ssStartBtn");
    assert.match(await A.page.textContent(".modalOverlay"), /Products handed to the branch: 2 \(31 units\)/);
    await A.page.fill("#ssPass", "1234");
    await A.page.click("#ssYes");
    await A.page.waitForSelector(".modalOverlay", { state:"detached", timeout:30000 });
    assert.deepStrictEqual(await server("RICE"), { total:30, available:27 });
    await openSettings(A);
    await A.page.locator("#ssStatus").scrollIntoViewIfNeeded();
    assert.match(await A.page.textContent("#ssStatus"), /Shared branch stock · online · this till holds 3 items to sell offline, valid until/);
    await shot(A.page, "desktop-allowance-status.png");
    await syncNow(B);
    assert.strictEqual(await B.page.$(".till-stock-note"), null, "the note is gone once the branch is shared");
    await openSettings(B);
    await B.page.locator("#ssStatus").scrollIntoViewIfNeeded();
    assert.match(await B.page.textContent("#ssStatus"), /this till holds 3 items to sell offline/);
    await shot(B.page, "phone-allowance-status.png");
  });

  await t("online: each till shows branch stock and what it holds; T1 sells the last sugar", async ()=>{
    await startShift(A);
    await waitFor(async()=> /30 in branch · 3 on this till/.test(await A.page.textContent("main")), "the stock line on T1's Sell screen");
    await shot(A.page, "desktop-stock-online.png");
    await A.page.click('tr:has-text("Sugar 1kg") .ds-add-btn');
    await A.page.click("#dsPayCash");
    await waitFor(async()=> (await server("SUG")).total===0, "the server to take the last sugar");
    await startShift(B);
    await waitFor(async()=> /30 in branch · 3 on this till/.test(await B.page.textContent("main")), "the stock line on T2's Sell screen");
    await shot(B.page, "phone-stock-online.png");
  });

  await t("T2 (still thinking one sugar is left) is refused by the server, with a clear message", async ()=>{
    await B.page.click('.product-row:has-text("Sugar 1kg") .add-chip');
    await B.page.click("#cartBtn");
    await B.page.click("#payCash");
    await B.page.waitForSelector(".ss-refusal");
    assert.match(await B.page.textContent(".ss-refusal"), /Sugar 1kg is sold out at this branch\.\s*Nothing was sold\. Change the quantity and try again\./);
    await shot(B.page, "phone-refusal-sold-out.png");
    await B.page.click("#ssOk");
    assert.strictEqual((await server("SUG")).total, 0, "never below zero");
  });

  await t("T2 offline: the badge and its allowance; a sale from the allowance; reported when back online", async ()=>{
    // the sale was refused and the cart kept: take the sugar out and close the cart
    await B.page.locator("#drawer button", { hasText:"−" }).first().click();
    await B.page.locator("#drawer .close-x").first().click().catch(()=>{});
    await B.ctx.setOffline(true);
    await nav(B, "products"); await nav(B, "pos");
    await waitFor(async()=> /Offline · selling from this till's allowance/.test(await B.page.textContent("main")), "the offline badge");
    assert.match(await B.page.textContent('.product-row:has-text("Rice 2kg")'), /3 on this till \(offline\)/);
    await shot(B.page, "phone-stock-offline.png");
    const before = (await server("RICE")).total;
    await B.page.click('.product-row:has-text("Rice 2kg") .add-chip');
    await B.page.click("#cartBtn");
    await B.page.click("#payCash");
    await waitFor(async()=> /2 on this till \(offline\)/.test(await B.page.textContent("main")), "the sale from the allowance");
    assert.strictEqual((await server("RICE")).total, before, "not on the server yet");
    await B.ctx.setOffline(false);
    await B.page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await waitFor(async()=> (await server("RICE")).total===before-1, "the offline sale to be reported", 30000);
  });

  await t("T1 offline with more in the cart than it holds: the offline refusal says exactly how many it can sell", async ()=>{
    await nav(A, "pos");
    for(let i=0;i<5;i++) await A.page.click('tr:has-text("Rice 2kg") .ds-add-btn');
    await A.ctx.setOffline(true);
    await A.page.click("#dsPayCash");
    await A.page.waitForSelector(".ss-refusal");
    assert.match(await A.page.textContent(".ss-refusal"), /Can't reach the server and this till can sell only 3 Rice 2kg while offline\. Sell fewer, or try again when connected\./);
    await shot(A.page, "desktop-refusal-offline.png");
    await A.page.click("#ssOk");
    await A.ctx.setOffline(false);
  });

  await t("Diagnostics: the branch stock balance check (both widths)", async ()=>{
    for(const [d, name] of [[A, "desktop-diagnostics.png"], [B, "phone-diagnostics.png"]]){
      await openSettings(d);
      await d.page.locator("#ssBalanceBtn").scrollIntoViewIfNeeded();
      await d.page.click("#ssBalanceBtn");
      await d.page.waitForSelector(".ss-bal-ok", { timeout:30000 });
      assert.match(await d.page.textContent(".ss-bal-ok"), /Branch stock: all 2 products balance/);
      await d.page.locator("#ssBalance").scrollIntoViewIfNeeded();
      await shot(d.page, name);
    }
    assert.deepStrictEqual(A.pageErrors, []); assert.deepStrictEqual(B.pageErrors, []);
  });

  await browser.close();
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
