// Run: node --no-warnings test/staff-deadlock-e2e.test.js   (build first: node build.js && node build.js --tauri)
//      PREVIEW=1 node --no-warnings test/staff-deadlock-e2e.test.js   (the deployed previews instead of the local builds)
// The v28 staff deadlock and its v29 fix in a REAL browser (Playwright/Chromium).
// seiGEN is the REAL server SQL (every migration) in an in-memory PGlite: every
// /rest/v1/rpc/<name> call from the pages is answered by running that function as
// role anon; any other Supabase request is blocked. Nothing reaches the live project.
//   * main (desktop) has an old-style Admin "Boss" (PIN 1234) and registers; its v28
//     check-in moves Boss to seiGEN; the remote (phone) joins with no old staff
//   * main, single operator mode ON: Sign in to manage staff with the old PIN ->
//     set a seiGEN PIN -> add a Cashier (Rumbi) for the remote -> edit -> a new role
//   * the remote: the single-mode alert says where to add people -> Refresh ->
//     single mode off -> Log out -> the PIN screen shows Rumbi -> sign in -> a
//     Cashier's menus
//   * from seiGEN 20261108120000 (v31): the remote Refreshes -> Boss (Admin, home
//     main) can now sign in there with his seiGEN PIN -> adds a Cashier (Tafara) at
//     the remote itself
// SWAP=1: the other way round (main on the phone build / mobilepos-preview, the
// remote on the desktop build / desktoppos-preview).
// SHOT_DIR=<dir> saves the screenshots (390 and 1280 px).
"use strict";
require("./dist-fresh");   // stop here if a bundle is older than its source (node tools/build-all.js)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { newPglite, buildFromRepo, v21AdminSeed } = require("../supabase/tests/rebuild-helpers");
const { activateForTest, passJoinTrialScreen } = require("./test-activation");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
const PREVIEW = process.env.PREVIEW === "1";
const SWAP = process.env.SWAP === "1";
const MAIN = SWAP? "phone" : "desktop", REMOTE = SWAP? "desktop" : "phone";
const BUILDS = { phone: path.join(ROOT, "dist", "index.html"), desktop: path.join(ROOT, "dist-tauri", "index.html") };
const URLS = { phone: "https://mobilepos-preview.seigendc.workers.dev/", desktop: "https://desktoppos-preview.seigendc.workers.dev/" };
if(!PREVIEW) for(const b of Object.values(BUILDS)) if(!fs.existsSync(b)){ console.log("Missing "+b+" — run: node build.js && node build.js --tauri"); process.exit(1); }
const SHOTS = process.env.SHOT_DIR || "";
if(SHOTS) fs.mkdirSync(SHOTS, { recursive:true });

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const fileUrl = (p)=> "file:///" + p.replace(/\\/g, "/");
async function waitFor(cond, what, ms){
  const deadline = Date.now() + (ms||20000);
  while(!(await cond())){ if(Date.now() > deadline) throw new Error("timed out waiting for "+what); await new Promise(r=>setTimeout(r, 150)); }
}
async function shot(page, name){ if(SHOTS) await page.screenshot({ path: path.join(SHOTS, name), fullPage:false }); }
// both widths of one screen: this device's own, then the other
async function shots(d, name){
  if(!SHOTS) return;
  const own = d.desktop? 1280 : 390;
  await shot(d.page, name+"-"+own+".png");
  await d.page.setViewportSize(d.desktop? { width:390, height:844 } : { width:1280, height:800 });
  await d.page.waitForTimeout(200);
  await shot(d.page, name+"-"+(d.desktop? 390 : 1280)+".png");
  await d.page.setViewportSize(d.desktop? { width:1280, height:800 } : { width:390, height:844 });
}

let pg;
let queue = Promise.resolve();
const calls = [];
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
  const ctx = await browser.newContext({ viewport: desktop? { width:1280, height:800 } : { width:390, height:844 }, serviceWorkers:"block" });
  await ctx.route(/supabase\.co\//, route=> route.abort());   // anything else: never the live project
  await ctx.route(/supabase\.co\/rest\/v1\/rpc\/([a-z_]+)$/, async route=>{
    const name = /\/rpc\/([a-z_]+)$/.exec(route.request().url())[1];
    let body = {}; try{ body = JSON.parse(route.request().postData()||"{}"); }catch(e){}
    const r = await serverCall(name, body);
    calls.push(kind+" "+name+" "+r.status+(r.json && r.json.error? " "+r.json.error : ""));
    return route.fulfill({ status:r.status, contentType:"application/json", headers:{ "access-control-allow-origin":"*" }, body:JSON.stringify(r.json) });
  });
  const page = await ctx.newPage();
  const d = { ctx, page, desktop, pageErrors:[], dialogs:[] };
  page.on("pageerror", e=> d.pageErrors.push(e.message));
  page.on("dialog", async x=>{ d.dialogs.push(x.message()); await x.accept(); });
  if(PREVIEW) await page.goto(URLS[kind]);
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-sd-"));
    fs.copyFileSync(BUILDS[kind], path.join(dir, "index.html"));
    await page.goto(fileUrl(path.join(dir, "index.html")));
  }
  await page.waitForSelector("#setShop", { timeout: 60000 });
  return d;
}
async function nav(d, route){
  if(d.desktop){ await d.page.click("#hamburgerBtn"); await d.page.click('#navDrawer [data-route="'+route+'"]'); }
  else await d.page.click('.navbar [data-route="'+route+'"]');
}
async function moreTab(d, tab){ await nav(d, "more"); await d.page.click('[data-kebab-toggle="moretab"]'); await d.page.click('[data-tab="'+tab+'"]'); }
async function openSettings(d){
  await moreTab(d, "settings");
  if(await d.page.$("#settingsPasscode")){ await d.page.fill("#settingsPasscode", "admin123"); await d.page.click("#unlockSettings"); }
  else if(await d.page.$("#newAdminPass")){ await d.page.fill("#newAdminPass", "admin123"); await d.page.fill("#newAdminPass2", "admin123"); await d.page.click("#createAdmin"); }
  await d.page.waitForSelector("#terminalCard");
}
async function openStaffCard(d){
  for(let i = 0; i < 40; i++){ await openSettings(d); if(await d.page.$("#shopStaffCard")) break; await d.page.waitForTimeout(500); }
  const card = await d.page.$("#shopStaffCard");
  if(!card) throw new Error("no Staff & Roles card");
  await card.scrollIntoViewIfNeeded();
}
const cardText = async (d)=> (await d.page.textContent("#shopStaffCard")).replace(/\s+/g, " ");
const gone = (d, sel)=> d.page.waitForSelector(sel, { state:"detached", timeout:30000 });

(async()=>{
  pg = await newPglite();
  await buildFromRepo(pg, { skip: [] });
  await pg.exec("update public.cl_shop_meta set v = now() + interval '1 day' where k = 'legacy_cutoff'");   // the tills are older than the migration, as on live
  const browser = await chromium.launch();
  let A, C;

  await t(`main (${MAIN}): an old-style Admin with a PIN; it registers and its v28 check-in moves the Admin to seiGEN; the remote (${REMOTE}) joins`, async ()=>{
    A = await device(browser, MAIN);
    const p = A.page;
    await p.fill("#setShop", "Zuva Hardware"); await p.fill("#setBranch", "Mbare"); await p.fill("#setSecret", "Gold Leaf 42");
    await p.click("#setupNext"); await p.fill("#setOwnerPhone", "0771234567"); await p.click("#setupNext2"); await p.click("#setupNext3"); await p.click("#setupFinish");
    await p.waitForSelector("[data-route]");
    await openSettings(A);
    await p.click("#openAddStaff"); await p.waitForSelector("#stName");
    await p.fill("#stName", "Boss"); await p.selectOption("#stRole", "Admin"); await p.fill("#stPasscode", "admin123"); await p.fill("#stPin", "1234");
    await p.click("#stConfirm"); await gone(A, "#stName");
    await openSettings(A);
    await p.click("#termRegisterBtn");
    await p.waitForSelector('#terminalCard[data-registered="1"]', { timeout:60000 });
    await activateForTest(p);   // the app starts again: the v28 check-in moves Boss
    await openStaffCard(A);
    const m = (await sq("select install_id, shop_secret_phrase, device_key from cl_vendors limit 1"))[0], s = v21AdminSeed("admin123");
    const code = (await serverCall("cl_branch_issue_join_code", { p_install_id:m.install_id, p_secret_phrase:m.shop_secret_phrase, p_device_key:m.device_key,
      p_admin_salt:s.salt, p_admin_check:s.check, p_admin_rounds:s.rounds, p_new_branch_name:"Chitungwiza" })).json.code;
    C = await device(browser, REMOTE);
    await C.page.click("#setJoinBtn"); await C.page.waitForSelector("#setJoinCode");
    await C.page.fill("#setSecret", "Gold Leaf 42"); await C.page.fill("#setJoinCode", code); await C.page.fill("#setTillLabel", "Front");
    await C.page.click("#setupJoin");
    await passJoinTrialScreen(C.page); await activateForTest(C.page);
    const staff = await sq(`select s.name, r.name role, jsonb_array_length(s.legacy_pins) old_pins from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id`);
    assert.deepStrictEqual(staff.map((x)=> [x.name, x.role, x.old_pins]), [["Boss", "Admin", 1]]);
  });

  await t("main, single operator mode ON: Sign in to manage staff with the old PIN -> set a seiGEN PIN", async ()=>{
    const p = A.page;
    await openStaffCard(A);
    assert.ok(await p.isChecked("#sSingleOperator"));
    assert.ok(!(await p.$("#addShopStaff")), "no Add before signing in");
    await shots(A, "1-main-staff-card-sign-in-to-manage");
    await p.click("#staffMgrSignin");
    await p.waitForSelector("#smPin");
    await p.selectOption("#smWho", { label:"Boss" });
    await p.fill("#smPin", "1234"); await p.click("#smGo");
    await p.waitForSelector("#opPin");
    assert.strictEqual(await p.$(".modalOverlay [data-modal-close]"), null, "it can't be closed");
    await shots(A, "2-main-set-seigen-pin");
    await p.fill("#opPin", "4826"); await p.fill("#opPin2", "4826"); await p.click("#opSave");
    await gone(A, "#opPin");
    await p.waitForSelector("#addShopStaff");
    assert.match(await cardText(A), /Signed in: Boss/);
    assert.ok(await p.isChecked("#sSingleOperator"), "single operator mode stays on");
    const b = (await sq(`select jsonb_array_length(legacy_pins) old_pins, pin_check is not null new_pin from cl_shop_staff where name = 'Boss'`))[0];
    assert.deepStrictEqual(b, { old_pins:0, new_pin:true });
  });

  await t("main: add a Cashier (Rumbi, PIN 7531) for the remote -> edit -> a new role", async ()=>{
    const p = A.page;
    // signing in to manage staff fetched the latest branches: Chitungwiza joined after main's last check-in
    await waitFor(async()=>{ await p.click("#addShopStaff"); await p.waitForSelector("#ssName");
      if(await p.$('#ssHome option:text("Chitungwiza")')) return true; await p.click(".modalOverlay [data-modal-close]"); await p.waitForTimeout(300); return false; }, "Chitungwiza in the branch list");
    await p.fill("#ssName", "Rumbi"); await p.selectOption("#ssRole", { label:"Cashier" }); await p.selectOption("#ssHome", { label:"Chitungwiza" });
    await p.fill("#ssPin", "7531");
    await shots(A, "3-main-add-person");
    await p.click("#ssSave"); await gone(A, "#ssName");
    await waitFor(async()=> /Rumbi Cashier · Chitungwiza/.test(await cardText(A)), "Rumbi in the list");
    const id = (await sq(`select id from cl_shop_staff where name = 'Rumbi'`))[0].id;
    await p.click(`[data-edit-shopstaff="${id}"]`); await p.waitForSelector("#ssName");
    await p.fill("#ssName", "Rumbidzai"); await p.click("#ssSave"); await gone(A, "#ssName");
    await waitFor(async()=> /Rumbidzai Cashier · Chitungwiza/.test(await cardText(A)), "the edit");
    await p.click("#staffTabRoles"); await p.click("#addRole"); await p.waitForSelector("#rlName");
    await p.fill("#rlName", "Till Lead");
    for(const r of ["m.sell", "m.credit", "void_return"]) await p.check(`.modalOverlay [data-right="${r}"]`);
    await p.click("#rlSave"); await gone(A, "#rlName");
    await waitFor(async()=> /Till Lead/.test(await cardText(A)), "the role");
    await shots(A, "4-main-roles-with-new-role");
    await p.click("#staffTabPeople");
    assert.deepStrictEqual(A.pageErrors, []);
  });

  await t("the remote: the alert says where to add people; Refresh -> Boss (Admin, home main) signs in here and adds Tafara -> single mode off -> the PIN screen -> Rumbidzai, a Cashier's menus", async ()=>{
    const p = C.page;
    await openStaffCard(C);
    assert.match(await cardText(C), /can sign in here once they have a seiGEN PIN.*Or add or edit people for Chitungwiza on the main branch/);
    await shots(C, "5-remote-guidance");
    await p.uncheck("#sSingleOperator").catch(()=>{});
    await waitFor(async()=> C.dialogs.length > 0, "the alert");
    assert.match(C.dialogs[0], /Add at least one active person with a PIN at this branch before turning this off\.\s+Nobody who manages staff can sign in on this till yet\. An Owner, an Admin or anyone with the Staff right can sign in here once they have a seiGEN PIN.*Or add or edit people for Chitungwiza on the main branch/);
    assert.ok(await p.isChecked("#sSingleOperator"), "still on");
    await p.click("#staffRefresh");
    await waitFor(async()=> /Rumbidzai Cashier · Chitungwiza/.test(await cardText(C)), "Rumbidzai arrives", 30000);
    assert.match(await cardText(C), /Roles \(6\)/);
    // v31 + seiGEN 20261108120000: Boss (Admin, home Mbare) has a seiGEN PIN, so he can manage staff here too
    await p.waitForSelector("#staffMgrSignin");
    await p.click("#staffMgrSignin"); await p.waitForSelector("#smPin");
    await p.selectOption("#smWho", { label:"Boss" }); await p.fill("#smPin", "4826"); await p.click("#smGo");
    await p.waitForSelector("#addShopStaff");
    assert.ok(!(await p.$("#opPin")), "no set-PIN step: it is already a seiGEN PIN");
    await p.click("#addShopStaff"); await p.waitForSelector("#ssName");
    await p.fill("#ssName", "Tafara"); await p.selectOption("#ssRole", { label:"Cashier" }); await p.selectOption("#ssHome", { label:"Chitungwiza" });
    await p.fill("#ssPin", "2580");
    await shots(C, "5b-remote-manager-adds-person");
    await p.click("#ssSave"); await gone(C, "#ssName");
    await waitFor(async()=> /Tafara Cashier · Chitungwiza/.test(await cardText(C)), "Tafara in the list");
    await p.click("#staffMgrDone");
    await p.waitForSelector("#staffMgrSignin");
    assert.ok(await p.isChecked("#sSingleOperator"), "single mode still on");
    await p.uncheck("#sSingleOperator");
    await waitFor(async()=> !(await p.isChecked("#sSingleOperator")), "single mode off");
    await p.click("#logoutBtn");
    await p.waitForSelector("#startSignIn"); await p.click("#startSignIn");
    await p.waitForSelector("#whoSelect");
    assert.deepStrictEqual(await p.$$eval("#whoSelect option", (o)=> o.map((x)=> x.textContent)), ["Boss", "Rumbidzai", "Tafara"]);
    await shots(C, "6-remote-pin-screen");
    await p.selectOption("#whoSelect", { label:"Rumbidzai" });
    await p.click("#whoSelectContinue");
    await p.fill("#whoPin", "7531"); await p.click("#whoPinContinue");
    await p.waitForSelector("#logoutBtn", { timeout:30000 });
    await waitFor(async()=> (await p.textContent("#userChip")).trim()==="Rumbidzai", "signed in");
    const routes = C.desktop? (await p.click("#hamburgerBtn"), await p.$$eval("#navDrawer [data-route]", (b)=> b.map((x)=> x.dataset.route)))
                            : await p.$$eval(".navbar [data-route]", (b)=> b.map((x)=> x.dataset.route));
    if(C.desktop) await p.keyboard.press("Escape");
    for(const r of ["pos", "credit", "reports", "more"]) assert.ok(routes.includes(r), r+" in "+routes);
    for(const r of ["products", "marketing"]) assert.ok(!routes.includes(r), "a Cashier has no "+r+": "+routes);
    if(!C.desktop) assert.deepStrictEqual(routes, ["pos", "credit", "reports", "more"]);
    await shots(C, "7-remote-cashier-signed-in");
    assert.deepStrictEqual(C.pageErrors, []);
  });

  await browser.close();
  const bad = calls.filter((c)=> / 400/.test(c));
  if(bad.length) console.log("  (rejected calls: "+bad.join(", ")+")");
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
