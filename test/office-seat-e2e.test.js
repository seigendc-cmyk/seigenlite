// Run: node --no-warnings test/office-seat-e2e.test.js   (build first: node build.js --pwa && node build.js --tauri)
//      PREVIEW=1 node --no-warnings test/office-seat-e2e.test.js   (the deployed previews instead of the local builds)
// Office seats (v32) in a REAL browser (Playwright/Chromium). seiGEN is the REAL
// server SQL (every migration, 20261109120000_office_seats included) in an
// in-memory PGlite: every /rest/v1/rpc/<name> call is answered by running that
// function as role anon; any other Supabase request is blocked. Nothing reaches
// the live project.
//   * main (desktop build): an Admin signs in -> Business & Terminals -> Invite an
//     Office seat -> the code, the message, Share on WhatsApp
//   * the link on a phone (Android Chrome), an iPhone (Safari), a PC (Edge) and
//     inside WhatsApp's and Facebook's browsers: the install page, always the code
//   * the phone "installs" the app (display-mode: standalone) and opens it: the
//     code is filled in -> Join -> Choose your PIN -> Waiting for approval
//   * main: Approve with the same device check -> the seat gets the data -> the
//     person signs in -> no Sell / Credit / EOD, no secret phrase card
//   * an internal transfer: the seat sends to T1, T1 confirms one short, the seat
//     sees the shortage
// SHOT_DIR=<dir> saves the screenshots (every new screen at 390 and 1280 px).
"use strict";
require("./dist-fresh");   // stop here if a bundle is older than its source (node tools/build-all.js)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");
const { activateForTest, writeSettings } = require("./test-activation");

let chromium;
require("./local-cdn");   // the cdnjs files from test/cdn/, not the internet
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
const PREVIEW = process.env.PREVIEW === "1";
const BUILDS = { phone: path.join(ROOT, "dist-pwa", "index.html"), desktop: path.join(ROOT, "dist-tauri", "index.html") };
const URLS = { phone: "https://mobilepos-preview.seigendc.workers.dev/", desktop: "https://desktoppos-preview.seigendc.workers.dev/" };
if(!PREVIEW) for(const b of Object.values(BUILDS)) if(!fs.existsSync(b)){ console.log("Missing "+b+" — run: node build.js --pwa && node build.js --tauri"); process.exit(1); }
const SHOTS = process.env.SHOT_DIR || "";
if(SHOTS) fs.mkdirSync(SHOTS, { recursive:true });
const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; SM-A156E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  whatsapp: "Mozilla/5.0 (Linux; Android 14; SM-A156E; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 WhatsApp/2.24.20.89",
  facebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.38.104;FBBV/656677460]",
};

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
async function shots(d, name){
  if(!SHOTS) return;
  const own = d.desktop? 1280 : 390;
  await shot(d.page, name+"-"+own+".png");
  await d.page.setViewportSize(d.desktop? { width:390, height:844 } : { width:1280, height:800 });
  await d.page.waitForTimeout(250);
  await shot(d.page, name+"-"+(d.desktop? 390 : 1280)+".png");
  await d.page.setViewportSize(d.desktop? { width:1280, height:800 } : { width:390, height:844 });
  await d.page.waitForTimeout(150);
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

const STANDALONE = ()=>{
  const real = window.matchMedia ? window.matchMedia.bind(window) : null;
  window.matchMedia = (q)=> /display-mode:\s*standalone/.test(q)
    ? { matches:true, media:q, onchange:null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } }
    : (real? real(q) : { matches:false, media:q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
};
async function device(browser, kind, o){
  o = o||{};
  const desktop = kind==="desktop";
  const ctx = await browser.newContext({ viewport: desktop? { width:1280, height:800 } : { width:390, height:844 }, serviceWorkers:"block", userAgent:o.ua });
  await ctx.route(/supabase\.co\//, route=> route.abort());
  await ctx.route(/supabase\.co\/rest\/v1\/rpc\/([a-z_]+)$/, async route=>{
    const name = /\/rpc\/([a-z_]+)$/.exec(route.request().url())[1];
    let body = {}; try{ body = JSON.parse(route.request().postData()||"{}"); }catch(e){}
    const r = await serverCall(name, body);
    calls.push({ kind, name, status:r.status, body:route.request().postData()||"" });
    return route.fulfill({ status:r.status, contentType:"application/json", headers:{ "access-control-allow-origin":"*" }, body:JSON.stringify(r.json) });
  });
  if(o.standalone) await ctx.addInitScript(STANDALONE);
  const page = await ctx.newPage();
  const d = { ctx, page, desktop, pageErrors:[], dialogs:[], url:"" };
  page.on("pageerror", e=> d.pageErrors.push(e.message));
  page.on("dialog", async x=>{ d.dialogs.push(x.message()); await x.accept(); });
  if(PREVIEW) d.url = URLS[kind];
  else { const dir = o.dir || fs.mkdtempSync(path.join(os.tmpdir(), "seigen-seat-")); fs.copyFileSync(BUILDS[kind], path.join(dir, "index.html")); d.dir = dir; d.url = fileUrl(path.join(dir, "index.html")); }
  await page.goto(d.url + (o.hash || ""));
  return d;
}
async function nav(d, route){
  if(d.desktop){ await d.page.click("#hamburgerBtn"); await d.page.click('#navDrawer [data-route="'+route+'"]'); }
  else await d.page.click('.navbar [data-route="'+route+'"]');
}
async function moreTab(d, tab){ await nav(d, "more"); await d.page.click('[data-kebab-toggle="moretab"]'); await d.page.click('[data-tab="'+tab+'"]'); }
async function openSettings(d){ await moreTab(d, "settings"); await d.page.waitForSelector("#terminalCard"); }
const gone = (d, sel)=> d.page.waitForSelector(sel, { state:"detached", timeout:30000 });
const text = async (d, sel)=> ((await d.page.textContent(sel || "body"))||"").replace(/\s+/g, " ");
async function signIn(d, name, pin){
  await d.page.waitForSelector("#startSignIn", { timeout:30000 }); await d.page.click("#startSignIn");
  await d.page.waitForSelector("#whoSelect");
  await d.page.selectOption("#whoSelect", { label:name }); await d.page.click("#whoSelectContinue");
  await d.page.fill("#whoPin", pin); await d.page.click("#whoPinContinue");
}

(async()=>{
  pg = await newPglite();
  await buildFromRepo(pg, { skip: [] });
  await pg.exec("update public.cl_shop_meta set v = now() + interval '1 day' where k = 'legacy_cutoff'");
  const browser = await chromium.launch();
  let A, S, code = "", link = "";

  await t("main (desktop build): an Admin signs in with a seiGEN PIN; Business & Terminals shows Office seats", async ()=>{
    A = await device(browser, "desktop");
    const p = A.page;
    await p.waitForSelector("#setShop", { timeout:60000 });
    await p.fill("#setShop", "Kuda Stores"); await p.fill("#setBranch", "Avondale"); await p.fill("#setSecret", "Blue Gum 77");
    await p.click("#setupNext"); await p.fill("#setOwnerPhone", "0771234567"); await p.click("#setupNext2"); await p.click("#setupNext3"); await p.click("#setupFinish");
    await p.waitForSelector("[data-route]");
    await openSettings(A);
    await p.click("#openAddStaff"); await p.waitForSelector("#stName");
    await p.fill("#stName", "Boss"); await p.selectOption("#stRole", "Admin"); await p.fill("#stPasscode", "admin123"); await p.fill("#stPin", "1234");
    await p.click("#stConfirm"); await gone(A, "#stName");
    await openSettings(A);
    await p.click("#termRegisterBtn");
    await p.waitForSelector('#terminalCard[data-registered="1"]', { timeout:60000 });
    await activateForTest(p);
    for(let i = 0; i < 40 && !(await p.$("#shopStaffCard")); i++){ await openSettings(A); await p.waitForTimeout(500); }
    await p.uncheck("#sSingleOperator");
    await waitFor(async()=> !(await p.isChecked("#sSingleOperator")), "single mode off");
    await p.click("#logoutBtn");
    await signIn(A, "Boss", "1234");
    await p.waitForSelector("#opPin", { timeout:30000 });
    await p.fill("#opPin", "4826"); await p.fill("#opPin2", "4826"); await p.click("#opSave");
    await gone(A, "#opPin");
    await openSettings(A);
    await p.waitForSelector("#seatInviteBtn");
    await (await p.$("#seatInviteBtn")).scrollIntoViewIfNeeded();
    assert.match(await text(A, "#terminalCard"), /Office seats.*can't sell, take payments or run End of Day.*\$3 per 30 days/);
    await shots(A, "01-main-business-terminals-office-seats");
  });

  await t("main: Invite an Office seat (Tendai, Manager) -> the code, the WhatsApp message, Copy, Revoke", async ()=>{
    const p = A.page;
    await p.click("#seatInviteBtn"); await p.waitForSelector("#seatCreate");
    assert.ok(!(await p.$$eval("#seatRole option", (o)=> o.map((x)=> x.textContent))).includes("Cashier"), "no Cashier role");
    await p.fill("#seatName", "Tendai"); await p.selectOption("#seatRole", { label:"Manager" });
    await shots(A, "02-main-create-invite");
    await p.click("#seatCreate");
    await p.waitForSelector("#seatInvCode", { timeout:30000 });
    code = (await p.textContent("#seatInvCode")).trim();
    const msg = await p.inputValue("#seatInvText");
    link = /https?:\S+#seat=[A-Z0-9]{8}/.exec(msg)[0];
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(msg.includes(code) && msg.includes("Tendai") && msg.includes("Manager"), msg);
    assert.ok(!/Blue Gum|4826|1234|admin123/i.test(msg), "no secret in the message");
    assert.match(await p.getAttribute("#seatShareWa", "href"), /^https:\/\/wa\.me\/\?text=/);
    await shots(A, "03-main-invite-ready-whatsapp-message");
    await p.click(".modalOverlay [data-modal-close]");
  });

  const hash = ()=> "#seat=" + code.replace("-", "");
  for(const [label, ua, kind, sel, file] of [
    ["Android Chrome", UA.android, "phone", "#seatStepsAndroid", "04-install-page-android-chrome"],
    ["iPhone Safari", UA.iphone, "phone", "#seatStepsIos", "05-install-page-iphone-safari"],
    ["PC Edge", UA.edge, "desktop", "#seatStepsDesktop", "06-install-page-pc-edge"],
    ["WhatsApp's in-app browser", UA.whatsapp, "phone", "#seatInApp", "07-in-app-browser-whatsapp"],
    ["Facebook's in-app browser", UA.facebook, "phone", "#seatInApp", "08-in-app-browser-facebook"],
  ]){
    await t("the link in " + label + ": the install page with the code and Copy code, and no Join button", async ()=>{
      const D = await device(browser, kind, { ua, hash:hash() });
      await D.page.waitForSelector("#seatInstallCard", { timeout:60000 });
      assert.ok(await D.page.$(sel), sel);
      assert.strictEqual((await D.page.textContent("#seatCode")).trim(), code);
      assert.ok(await D.page.$("#seatCopyCode"));
      assert.ok(!(await D.page.$("#seatJoinGo")), "no Join in a browser tab");
      assert.ok(!/#seat=/.test(D.page.url()), "the code is taken out of the address bar");
      if(/in-app/.test(label)) assert.match(await text(D, "#seatInstallCard"), /You're inside (WhatsApp|Facebook)'s browser/);
      await shots(D, file);
      assert.deepStrictEqual(D.pageErrors, []);
      await D.ctx.close();
    });
  }

  await t("the phone installs the app and opens it: the code is filled in -> Join -> Choose your PIN -> Waiting for approval", async ()=>{
    const first = await device(browser, "phone", { ua:UA.android, hash:hash() });
    await first.page.waitForSelector("#seatInstallCard", { timeout:60000 });
    const dir = first.dir, storage = await first.ctx.storageState(); await first.ctx.close();
    // the installed app: same address, same storage, display-mode standalone, opened without the link
    S = await device(browser, "phone", { ua:UA.android, standalone:true, dir });
    await S.page.evaluate((o)=>{ for(const e of (o.origins||[])) for(const i of e.localStorage) window.localStorage.setItem(i.name, i.value); }, storage).catch(()=>{});
    if(!PREVIEW && !(await S.page.evaluate(()=> !!window.localStorage.getItem("scl_seat_invite")))) await S.page.evaluate((c)=> window.localStorage.setItem("scl_seat_invite", JSON.stringify({ code:c, ts:Date.now() })), code);
    await S.page.reload();
    await S.page.waitForSelector("#seatJoinCode", { timeout:60000 });
    assert.strictEqual(await S.page.inputValue("#seatJoinCode"), code, "filled in");
    await shots(S, "09-installed-app-join-code-filled");
    await S.page.click("#seatJoinGo");
    await S.page.waitForSelector("#seatPin", { timeout:30000 });
    assert.match(await text(S, "#seatPinCard"), /Choose your PIN.*Tendai \(Manager\)/);
    await S.page.fill("#seatPin", "5151"); await S.page.fill("#seatPin2", "5151");
    await shots(S, "10-seat-choose-pin");
    await S.page.click("#seatPinGo");
    await S.page.waitForSelector("#seatWaitCard", { timeout:30000 });
    assert.match(await text(S, "#seatWaitCard"), /Waiting for approval by the Owner or an Admin/);
    await shots(S, "11-seat-waiting-for-approval");
    await S.page.reload();
    await S.page.waitForSelector("#seatWaitCard", { timeout:60000 });   // nothing else opens until approved
  });

  await t("main: the waiting seat; Approve shows the same device check and waits for the tick", async ()=>{
    const p = A.page;
    const check = (await S.page.textContent("#seatCheck")).trim();
    await openSettings(A);
    await p.waitForSelector("[data-seat-approve]", { timeout:30000 });
    await (await p.$("[data-seat-approve]")).scrollIntoViewIfNeeded();
    await shots(A, "12-main-seat-waiting-banner");
    await p.click("[data-seat-approve]"); await p.waitForSelector("#seatApproveCheck");
    assert.strictEqual((await p.textContent("#seatApproveCheck")).trim(), check, "the same check on both screens");
    assert.ok(await p.isDisabled("#seatApproveGo"));
    await shots(A, "13-main-approve-device");
    await p.check("#seatCheckSame");
    await p.click("#seatApproveGo");
    await gone(A, "#seatApproveGo");
    await waitFor(async()=> (await sq(`select approval_status from cl_terminals where device_kind = 'seat'`))[0].approval_status === "approved", "approved");
    await waitFor(async()=> /S1 \(Office seat\) · Tendai · approved/.test(await text(A, "#seatList")), "the seat in the list", 30000);
    await (await p.$("#seatList")).scrollIntoViewIfNeeded();
    await shots(A, "14-main-seat-approved-and-invites");
  });

  await t("the seat: approved -> the main branch's data -> Tendai signs in: no Sell, Credit or End of Day; no secret phrase card", async ()=>{
    const p = S.page;
    await p.click("#seatWaitCheckNow");
    await p.waitForSelector("#trialSkip, #trialContinue, #startSignIn", { timeout:60000 });
    await writeSettings(p, [["activated_until", new Date(Date.now() + 30*86400000).toISOString()], ["activated_until_src", "code"]]);
    await p.reload();
    await signIn(S, "Tendai", "5151");
    await p.waitForSelector("#logoutBtn", { timeout:30000 });
    const routes = await p.$$eval(".navbar [data-route]", (b)=> b.map((x)=> x.dataset.route));
    for(const r of ["pos", "credit"]) assert.ok(!routes.includes(r), "no " + r + ": " + routes);
    assert.ok(routes.includes("products") && routes.includes("more"), routes.join(","));
    assert.ok(await p.isHidden("#cartBtn"));
    await shots(S, "15-seat-signed-in-home");
    // A Manager has no Settings right (design §3): no Settings tab, and no End of Day or iTred orders on a seat
    const tabs = await (async ()=>{ await nav(S, "more"); await p.click('[data-kebab-toggle="moretab"]'); return p.$$eval("#menu-moretab [data-tab]", (b)=> b.map((x)=> x.dataset.tab + ":" + x.textContent)); })();
    assert.ok(!tabs.some((x)=> /^settings:|End of Day|Orders Fulfillment/.test(x)), tabs.join(","));
    await p.keyboard.press("Escape").catch(()=>{});
    // An Admin on the seat has Settings, still without the secret phrase card or the cash drawer
    await p.reload();
    await signIn(S, "Boss", "4826");
    await p.waitForSelector("#logoutBtn", { timeout:30000 });
    await moreTab(S, "settings");
    await p.waitForSelector("#terminalCard");
    assert.ok(!(await p.$("#sSecret")), "no secret phrase card");
    assert.ok(!/Cash drawer/i.test(await text(S, "#main")), "no cash drawer");
    assert.match(await text(S, "#terminalCard"), /S1/);
    await shots(S, "16-seat-settings-no-secret-phrase");
    await p.reload();
    await signIn(S, "Tendai", "5151");
    await p.waitForSelector("#logoutBtn", { timeout:30000 });
  });

  await t("an internal transfer: the seat adds 20 of a product, sends 10 to T1; T1 confirms 8; the seat sees 2 short", async ()=>{
    const p = S.page;
    await nav(S, "products"); await p.click("#openAddProduct"); await p.waitForSelector("#pName");
    await p.fill("#pName", "Bottle warmer"); await p.fill("#pSku", "BW-1"); await p.fill("#pPrice", "12"); await p.fill("#pCost", "7"); await p.fill("#pStock", "20");
    await p.click("#pConfirm"); await gone(S, "#pName");
    // the product reaches T1 through the catalogue
    await waitFor(async()=> (await sq(`select count(*)::int n from cl_catalogue_products where code = 'BW-1'`))[0].n === 1, "the catalogue push", 60000);
    await A.page.reload(); await signIn(A, "Boss", "4826"); await A.page.waitForSelector("#logoutBtn", { timeout:30000 });
    await moreTab(S, "transfers"); await p.waitForSelector("#itNew");
    await waitFor(async()=> !(await p.isDisabled("#itNew")), "a destination", 30000);
    await p.click("#itNew"); await p.waitForSelector("#itFind");
    await p.fill("#itFind", "bottle"); await p.click("[data-it-add]");
    await p.fill("[data-it-qty]", "10"); await p.fill("#itNote", "Shelf refill");
    await shots(S, "17-seat-new-transfer");
    await p.click("#itSend");
    // one read of the modal (it closes when the send succeeds; two reads could straddle that)
    const sendState = ()=> p.evaluate(()=>{ const b = document.querySelector("#itSend"), m = document.querySelector("#itSendMsg");
      return { open:!!b, btn:b? b.textContent : "", msg:m? m.textContent.trim() : "" }; });
    await waitFor(async()=>{ const s = await sendState(); return !s.open || !!s.msg; }, "sent or refused", 30000)
      .catch(async (e)=>{ const s = await sendState(); throw new Error(e.message + ": button '" + s.btn + "', message '" + s.msg + "'; last calls " + calls.slice(-4).map((c)=>c.name + " " + c.status).join(", ")); });
    if(await p.$("#itSend")) throw new Error("not sent: " + await p.textContent("#itSendMsg"));
    await waitFor(async()=> /IT-S1-0001/.test(await text(S, "#main")), "IT-S1-0001 sent");
    await shots(S, "18-seat-transfer-sent");
    const ap = A.page;
    await waitFor(async()=> { await moreTab(A, "transfers"); await ap.waitForSelector("#itRefresh"); await ap.click("#itRefresh"); await ap.waitForTimeout(800); return !!(await ap.$("[data-it-receive]")); }, "T1 sees it", 60000);
    await ap.click("[data-it-receive]"); await ap.waitForSelector("[data-it-got]");
    await ap.fill("[data-it-got]", "8");
    await shots(A, "19-main-confirm-transfer");
    await ap.click("#itRecvGo");
    const recvState = ()=> ap.evaluate(()=>{ const b = document.querySelector("#itRecvGo"), m = document.querySelector("#itRecvMsg");
      return { open:!!b, busy:!!b && b.disabled, msg:m? m.textContent.trim() : "" }; });
    // a retried Confirm keeps the last refusal on screen while it works, so wait for it to finish
    // ("Confirming…" disabled) before reading the message
    // T1 may not have the new product from the catalogue yet ("isn't a product on this device"):
    // a check-in pulls the catalogue, then Confirm again, as a person would
    const tries = Date.now() + 60000;
    for(;;){
      await waitFor(async()=>{ const s = await recvState(); return !s.open || (!s.busy && !!s.msg); }, "confirmed or refused", 30000);
      const s = await recvState();
      if(!s.open) break;
      if(!/isn't a product on this device/.test(s.msg) || Date.now() > tries) throw new Error("not confirmed: " + s.msg);
      await ap.evaluate(()=> window.dispatchEvent(new Event("online")));
      await ap.waitForTimeout(1500);
      await ap.click("#itRecvGo");
    }
    await waitFor(async()=> /Received short/.test(await text(A, "#main")), "received short on T1");
    await p.click("#itRefresh");
    await waitFor(async()=> /short 2/.test(await text(S, "#main")), "the shortage on the seat", 30000);
    assert.ok(await p.$("[data-it-wo]") && await p.$("[data-it-keep]"));
    await shots(S, "20-seat-transfer-shortage");
    const st = await sq(`select status from cl_internal_transfers`);
    assert.strictEqual(st[0].status, "received_short");
  });

  await t("the business's bill on the licence card: T1 main 15, S1 Office seat 3", async ()=>{
    await moreTab(A, "about");
    await A.page.waitForSelector("#businessBillTotal", { timeout:30000 });
    assert.match(await text(A, "[data-business-bill]"), /T1 · main till USD 15\.00.*S1 \(Office seat\) · Office seat USD 3\.00.*Total USD 18\.00 per 30 days/);
    await (await A.page.$("[data-business-bill]")).scrollIntoViewIfNeeded();
    await shots(A, "21-main-business-bill");
  });

  await t("no secret phrase or PIN in the seat's join, and no page errors", async ()=>{
    const join = calls.filter((c)=> c.name === "cl_seat_join");
    assert.ok(join.length && join.every((c)=> !/Blue Gum/i.test(c.body) && !/secret_phrase/.test(c.body)));
    assert.ok(!calls.filter((c)=> c.kind === "phone").some((c)=> /Blue Gum/i.test(c.body)), "the seat never sends the business phrase");
    assert.deepStrictEqual(A.pageErrors, []); assert.deepStrictEqual(S.pageErrors, []);
  });

  await browser.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
