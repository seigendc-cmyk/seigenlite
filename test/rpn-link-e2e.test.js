// Run: node --no-warnings test/rpn-link-e2e.test.js   (SHOT_DIR=<dir> saves screenshots at 390px and 1280px)
// (build first: node build.js && node build.js --tauri)
// The RPN link in a real browser (dist/index.html), against a FAKE Digital
// Commerce answering cl_device_checkin / cl_device_link_rpn /
// cl_device_rpn_status; nothing reaches the live project:
//   * setup step 3: the RPN types the field force number + PIN; a wrong
//     shape is stopped on the form; after Finish the check-in sends it and
//     More → About says "Onboarded by"
//   * More → Settings: a wrong PIN shows the plain refusal; offline it says
//     "Saved. It will be checked when you're online." and goes once online
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping.\n0 passed, 0 failed (skipped)"); process.exit(0); }

// phone: dist/ (the single-file phone build); desktop: dist-tauri/ (the desktop layout, hamburger menu)
const BUILDS = { phone: path.join(__dirname, "..", "dist", "index.html"), desktop: path.join(__dirname, "..", "dist-tauri", "index.html") };
for(const b of Object.values(BUILDS)) if(!fs.existsSync(b)){ console.log("Missing " + b + " — run: node build.js && node build.js --tauri"); process.exit(1); }
const SHOTS = process.env.SHOT_DIR || "";
if(SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}
const PHRASE = "Test Activation Phrase";

async function fakeServer(ctx, state){
  await ctx.route(/urbopdsubwawtybwrxjd\.supabase\.co/, async (route)=>{
    const req = route.request();
    const name = req.url().split("/rpc/")[1] || "";
    let body = {}; try{ body = JSON.parse(req.postData() || "{}"); }catch(e){}
    if(state.offline) return route.abort("internetdisconnected");
    const reply = (status, obj)=> route.fulfill({ status, contentType:"application/json", body: JSON.stringify(obj) });
    if(name === "cl_device_checkin") return reply(200, { vendor_id:"22222222-2222-4222-8222-222222222222", status:"onboarding", lock_cart:false, lock_add_product:false, lock_reason:null, messages:[] });
    if(name === "cl_device_link_rpn"){
      state.links.push(body);
      if(body.p_field_force_no === "RPN-014" && body.p_pin === "123456"){ state.linked = true; return reply(200, { ok:true, status:"linked", rpn_name:"Tendai", field_force_no:"RPN-014" }); }
      return reply(200, { ok:false, code:"RPN_NO_MATCH", message:"That field force number and PIN don't match. Check them with your RPN." });
    }
    if(name === "cl_device_rpn_status") return reply(200, { linked: !!state.linked, rpn_name: state.linked? "Tendai" : null, field_force_no: state.linked? "RPN-014" : null, on_business:false, open_conflict:false });
    return route.abort();   // anything else: never the live project
  });
}
async function nav(page, desktop, r){
  if(desktop){ await page.click("#hamburgerBtn"); await page.click('#navDrawer [data-route="' + r + '"]'); }
  else await page.click('.navbar [data-route="' + r + '"]');
}
async function moreTab(page, desktop, tab){
  await nav(page, desktop, "more");
  await page.click('[data-kebab-toggle="moretab"]');
  await page.click('[data-tab="' + tab + '"]');
  if(tab === "settings" && await page.$("#settingsPasscode")){ await page.fill("#settingsPasscode", "1234"); await page.click("#unlockSettings"); }
}

(async()=>{
  const browser = await chromium.launch();
  for(const [kind, vp] of [["phone", { width:390, height:844 }], ["desktop", { width:1280, height:860 }]]){
    console.log(kind + " (" + vp.width + "px)");
    const desktop = kind === "desktop";
    const shot = async (page, n)=>{ if(SHOTS) await page.screenshot({ path: path.join(SHOTS, kind + "-" + n + ".png"), fullPage:true }); };

    await t(kind + ": setup step 3 takes the field force number + PIN (wrong shape stopped); after Finish it's checked and About says Onboarded by", async ()=>{
      const ctx = await browser.newContext({ viewport: vp });
      const state = { links:[], linked:false, offline:false };
      await fakeServer(ctx, state);
      const page = await ctx.newPage();
      const errors = [], dialogs = [];
      page.on("pageerror", (e)=> errors.push(e.message));
      page.on("dialog", (d)=>{ dialogs.push(d.message()); d.accept(); });
      await page.goto("file:///" + BUILDS[kind].replace(/\\/g, "/"));
      await page.waitForSelector("#setShop", { timeout:30000 });
      await page.fill("#setShop", "Test Shop"); await page.fill("#setSecret", PHRASE);
      await page.click("#setupNext"); await page.click("#setupNext2");
      await page.waitForSelector("#setRpnVFf");
      assert.match(await page.textContent("h2"), /RPN \(Revenue Partner Network\)/);
      await page.fill("#setRpnVFf", "14"); await page.fill("#setRpnVPin", "123456");
      await page.click("#setupNext3");
      await page.waitForFunction(()=> true);
      assert.ok(dialogs.some((m)=> /field force number as it's printed, e\.g\. RPN-014/.test(m)), JSON.stringify(dialogs));
      await page.fill("#setRpnVFf", "RPN-014");
      await shot(page, "01-setup-rpn");
      await page.click("#setupNext3");
      await page.click("#setupFinish");
      await page.waitForSelector("[data-route]");
      await page.waitForFunction(()=> true);
      for(let i = 0; i < 50 && !state.linked; i++) await page.waitForTimeout(100);
      assert.strictEqual(state.links.length, 1, "sent once, after the check-in");
      assert.strictEqual(state.links[0].p_field_force_no, "RPN-014");
      await moreTab(page, desktop, "about");
      await page.waitForFunction(()=> /Onboarded by: Tendai \(RPN-014\)/.test((document.getElementById("rpnOnboardedLine")||{}).textContent||""), null, { timeout:10000 });
      await shot(page, "02-about-onboarded-by");
      await moreTab(page, desktop, "settings");
      await page.waitForSelector("#rpnCard");
      assert.match(await page.textContent("#rpnCard"), /✓ Onboarded by: Tendai \(RPN-014\)[\s\S]*To change your RPN, ask Digital Commerce/);
      assert.strictEqual(await page.$("#linkRpnBtn"), null);
      await shot(page, "03-settings-linked");
      assert.deepStrictEqual(errors, []);
      await ctx.close();
    });

    await t(kind + ": More → Settings: a wrong PIN shows the plain refusal; offline it waits ('Saved…'), then goes once online", async ()=>{
      const ctx = await browser.newContext({ viewport: vp });
      const state = { links:[], linked:false, offline:false };
      await fakeServer(ctx, state);
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e)=> errors.push(e.message));
      page.on("dialog", (d)=> d.accept());
      await page.goto("file:///" + BUILDS[kind].replace(/\\/g, "/"));
      await page.waitForSelector("#setShop", { timeout:30000 });
      await page.fill("#setShop", "Test Shop"); await page.fill("#setSecret", PHRASE);
      await page.click("#setupNext"); await page.click("#setupNext2"); await page.click("#setupNext3"); await page.click("#setupFinish");
      await page.waitForSelector("[data-route]");
      await moreTab(page, desktop, "settings");
      await page.waitForSelector("#linkRpnBtn");
      await page.fill("#sRpnVFf", "RPN-014"); await page.fill("#sRpnVPin", "000000");
      await page.click("#linkRpnBtn");
      await page.waitForSelector('#rpnLinkStatus[data-state="error"]');
      assert.strictEqual((await page.textContent("#rpnLinkStatus")).trim(), "That field force number and PIN don't match. Check them with your RPN.");
      await shot(page, "04-settings-wrong-pin");
      state.offline = true;
      await ctx.setOffline(true);
      await page.fill("#sRpnVFf", "RPN-014"); await page.fill("#sRpnVPin", "123456");
      await page.click("#linkRpnBtn");
      await page.waitForSelector('#rpnLinkStatus[data-state="pending"]');
      assert.strictEqual((await page.textContent("#rpnLinkStatus")).trim(), "Saved. It will be checked when you're online.");
      await shot(page, "05-settings-offline-saved");
      const before = state.links.length;
      state.offline = false;
      await ctx.setOffline(false);
      await page.evaluate(()=> window.dispatchEvent(new Event("online")));
      for(let i = 0; i < 80 && !state.linked; i++) await page.waitForTimeout(100);
      assert.strictEqual(state.links.length, before + 1, "sent once when back online");
      await moreTab(page, desktop, "settings");
      await page.waitForSelector('#rpnLinkStatus[data-state="linked"]');
      assert.deepStrictEqual(errors, []);
      await ctx.close();
    });
  }
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
