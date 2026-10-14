// Run: node --no-warnings test/update-flow-e2e.test.js
// (build first: node build.js --pwa && node build.js --tauri)
// v23 updates (owner, 2026-10-14), in a REAL browser against dist-pwa served
// over http (a service worker needs it). A "deploy" rewrites the served
// sw.js and index.html to a higher build, as Cloudflare would serve it.
// Page time is Playwright's clock, so "30 minutes" and "2 minutes idle"
// take no real time. seiGEN's check-in is answered here (never the live one).
//   * an open app finds a new version without being reopened (back online,
//     back on screen, every 30 minutes) and says which build it is
//   * it never installs by itself with an item in the cart; ✕ hides the
//     banner for an hour, then it's back
//   * on an empty Sales screen untouched for 2 minutes it installs by itself
//     (the shop's data is still there); Update now does it at once
//   * More → About shows the build and Check for updates
//   * seiGEN's minimum build: a red "must update" bar, gone when it isn't above
//     this build
//   * the desktop build on the web: the banner keeps clear of the cart panel
//   * the installed Windows program (Tauri): a worker an older build left is
//     removed (src-tauri/sw-off.js), so a new installer's build shows at once,
//     data kept; About and the red bar say a new installer comes from seiGEN
"use strict";
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { activateForTest, writeSettings } = require("./test-activation");
const { TEST_PHRASE } = require("./dc-fake");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
for(const b of ["dist-pwa","dist-tauri"]) if(!fs.existsSync(path.join(ROOT,b,"index.html"))){ console.log("Missing "+b+" — run: node build.js --pwa && node build.js --tauri"); process.exit(1); }
const BUILD = Number(/^\/\/ build: v(\d+)/m.exec(fs.readFileSync(path.join(ROOT, "sw-pwa.js"), "utf8"))[1]);
const SHOTS = process.env.SHOT_DIR || "";

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
async function waitFor(cond, what, ms){
  const deadline = Date.now() + (ms || 15000);
  while(!(await cond())){ if(Date.now() > deadline) throw new Error("timed out waiting for "+what); await new Promise(r=>setTimeout(r, 150)); }
}

// A copy of the build, served over http; deploy(n) makes it build n.
function serve(build){
  const types = { ".html":"text/html", ".js":"text/javascript", ".json":"application/json", ".png":"image/png", ".svg":"image/svg+xml", ".ico":"image/x-icon" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-upd-"));
  for(const f of fs.readdirSync(path.join(ROOT, build))) fs.copyFileSync(path.join(ROOT, build, f), path.join(dir, f));
  const server = http.createServer((req, res)=>{
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(dir, rel);
    if(!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){ res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
  let current = BUILD;
  function deploy(n){
    const idx = path.join(dir, "index.html"), sw = path.join(dir, "sw.js");
    const html = fs.readFileSync(idx, "utf8"), from = "APP_BUILD=0x"+current.toString(16);
    assert.ok(html.includes(from), "index.html has "+from);
    fs.writeFileSync(idx, html.replace(from, "APP_BUILD=0x"+n.toString(16)));
    fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace(/^\/\/ build: v\d+/m, "// build: v"+n).replace(/^const SW_BUILD = \d+;$/m, "const SW_BUILD = "+n+";"));
    current = n;
  }
  return new Promise(r=> server.listen(0, "127.0.0.1", ()=> r({ server, deploy, base:"http://127.0.0.1:"+server.address().port+"/" })));
}

// seiGEN's check-in, answered here; state.minBuild is what it says (null = an older server).
async function stubCheckin(ctx, state){
  const calls = [];
  await ctx.route(/urbopdsubwawtybwrxjd\.supabase\.co/, async route=>{
    const req = route.request();
    if(!/\/rpc\/cl_device_checkin$/.test(req.url())) return route.abort();
    let body = {}; try{ body = JSON.parse(req.postData() || "{}"); }catch(e){}
    calls.push(body);
    const ans = { vendor_id:"22222222-2222-4222-8222-222222222222", status:"active", lock_cart:false, lock_add_product:false,
      lock_reason:null, cycle_start_date:"2026-09-01", messages:[] };
    if(state.minBuild !== null){ ans.min_build = state.minBuild; ans.update_required = (body.p_app_build||0) > 0 && body.p_app_build < state.minBuild; }
    return route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify(ans) });
  });
  return calls;
}

const appBuild = (page)=> page.evaluate(()=> APP_BUILD);
const barText = async (page)=>{ const el = await page.$("#pwaUpdateBar"); return el? (await el.textContent()).trim() : null; };
const barKind = (page)=> page.evaluate(()=>{ const el = document.getElementById("pwaUpdateBar"); return el? el.getAttribute("data-kind") : null; });
async function cartCount(page){ const b = await page.$(".cart-badge"); return b? (await b.textContent()).trim() : "0"; }
async function gotoRoute(page, route, desktop){
  if(desktop){ await page.click("#hamburgerBtn"); await page.click('#navDrawer [data-route="'+route+'"]'); }
  else await page.click('.navbar [data-route="'+route+'"]');
}
async function openAbout(page, desktop){
  await gotoRoute(page, "more", desktop);
  await page.click(".moretab-btn");
  await page.click('[data-tab="about"]');
  await page.waitForSelector("#aboutVersion");
}
async function signInAgain(page){
  await page.waitForSelector("#startSignIn, #logoutBtn", { timeout: 30000 });
  if(await page.$("#startSignIn")){
    await page.click("#startSignIn");
    await page.waitForSelector("#whoName, #logoutBtn");
    if(await page.$("#whoName")){ await page.fill("#whoName", "Tendai"); await page.click("#whoContinue"); }
    await page.waitForSelector("#logoutBtn");
  }
}

// A set-up, activated shop on its own browser context, controlled by the service worker.
async function newShop(browser, build){
  const desktop = build === "dist-tauri";
  const srv = await serve(build);
  const ctx = await browser.newContext({ viewport: desktop? { width:1280, height:800 } : { width:390, height:844 } });
  const state = { minBuild: null };
  const calls = await stubCheckin(ctx, state);
  const page = await ctx.newPage();
  await page.clock.install();
  const errors = [];
  page.on("dialog", d=> d.accept());
  page.on("pageerror", e=> errors.push(e.message));
  await page.goto(srv.base);
  await page.waitForSelector("#setShop", { timeout: 30000 });
  await page.fill("#setShop", "IVO Test"); await page.fill("#setBranch", "Warehouse"); await page.fill("#setSecret", TEST_PHRASE);
  await page.click("#setupNext"); await page.fill("#setOwnerPhone", "0771234567"); await page.click("#setupNext2"); await page.click("#setupNext3"); await page.click("#setupFinish");
  await page.waitForSelector("#logoutBtn");
  await waitFor(()=> page.evaluate(()=> !!navigator.serviceWorker.controller), "the service worker to take control", 30000);
  await activateForTest(page, { name: "Tendai" });
  return { srv, ctx, page, state, calls, errors, desktop };
}

async function addProduct(page, desktop, name){
  await gotoRoute(page, "products", desktop);
  await page.click("#openAddProduct");
  await page.waitForSelector("#pName");
  await page.fill("#pName", name); await page.fill("#pPrice", "3"); await page.fill("#pStock", "10");
  await page.click("#pConfirm");
  await page.waitForSelector(".modalOverlay", { state: "detached" });
}

(async()=>{
  const browser = await chromium.launch();

  // ---------------- phone build ----------------
  const s = await newShop(browser, "dist-pwa");
  const { page, srv } = s;

  await t("More → About shows the build and Check for updates; with nothing new it says this is the newest build", async ()=>{
    await openAbout(page, false);
    assert.match(await page.textContent("#aboutVersion"), new RegExp("Version \\S+ · build "+BUILD+"$"));
    await page.click("#pwaCheckUpdates");
    await waitFor(async()=> /newest build/.test(await page.textContent("#pwaCheckResult")), "the check result");
    assert.strictEqual((await page.textContent("#pwaCheckResult")).trim(), "This is the newest build ("+BUILD+").");
    assert.strictEqual(await barText(page), null, "no bar");
  });

  await t("an open app finds a new version when the internet comes back, and says which build (no reopen)", async ()=>{
    await addProduct(page, false, "Brake pads");
    srv.deploy(BUILD+1);
    await page.evaluate(()=> window.dispatchEvent(new Event("online")));
    await waitFor(async()=> /build \d+/.test(await barText(page) || ""), "the update banner");
    assert.strictEqual(await barText(page), "Update ready (build "+(BUILD+1)+"). Tap Update now: it takes a few seconds and nothing is lost.Update now✕");
    assert.strictEqual(await barKind(page), "ready");
    assert.strictEqual(await appBuild(page), BUILD, "still running the old build until it's installed");
    if(process.env.SHOT_DIR) await page.screenshot({ path: path.join(SHOTS, "update-ready.png") });
  });

  await t("the banner floats above the phone's tab bar (the tabs still work) and an open cart covers it", async ()=>{
    const r = await page.evaluate(()=>{ const b = document.getElementById("pwaUpdateBar").getBoundingClientRect(), n = document.querySelector(".navbar").getBoundingClientRect(); return { barBottom: b.bottom, navTop: n.top }; });
    assert.ok(r.barBottom <= r.navTop, "bar ends at "+r.barBottom+", tabs start at "+r.navTop);
    await gotoRoute(page, "pos", false);                     // a tab tap works with the banner showing
    await page.click("#cartBtn");
    await page.waitForSelector("#drawer.show");
    await page.waitForTimeout(400);                          // the drawer slides in
    const top = await page.evaluate(()=>{ const b = document.getElementById("pwaUpdateBar").getBoundingClientRect(); const el = document.elementFromPoint(b.left + 20, b.top + b.height/2); return el && el.closest("#pwaUpdateBar")? "bar" : "other"; });
    assert.strictEqual(top, "other", "the cart drawer is on top of the banner");
    await page.click("#closeDrawer");
  });

  await t("with an item in the cart it never installs by itself, however long the till is left", async ()=>{
    await gotoRoute(page, "pos", false);
    await page.locator("[data-add]").first().click();
    await waitFor(async()=> (await cartCount(page))==="1", "the cart badge");
    await page.clock.fastForward("05:00");
    await page.clock.fastForward("05:00");
    await page.waitForTimeout(1500);
    assert.strictEqual(await appBuild(page), BUILD);
    assert.strictEqual(await cartCount(page), "1", "the cart is untouched");
  });

  await t("✕ hides the banner for an hour; after the hour it is back", async ()=>{
    await page.click("#pwaUpdateDismiss");
    assert.strictEqual(await barText(page), null);
    await page.clock.fastForward("30:00");
    await page.waitForTimeout(500);
    assert.strictEqual(await barText(page), null, "still hidden after 30 minutes");
    await page.clock.fastForward("31:00");
    await waitFor(async()=> (await barKind(page))==="ready", "the banner to come back");
    assert.strictEqual(await appBuild(page), BUILD, "still not installed: the cart has an item");
  });

  await t("on an empty Sales screen untouched for 2 minutes it installs by itself; the shop's data is all there", async ()=>{
    // empty the cart the way staff do: open it and remove the line
    await page.evaluate(()=>{ const b = document.getElementById("cartBtn"); b.click(); });
    await page.waitForSelector("#drawer.show");
    await page.click("#drawer [data-dec]");                  // "One less" on its only line
    await waitFor(async()=> (await cartCount(page))==="0", "an empty cart");
    if(await page.$("#drawer.show")) await page.click("#closeDrawer");
    await page.clock.fastForward("01:00");
    await page.waitForTimeout(800);
    assert.strictEqual(await appBuild(page), BUILD, "1 minute untouched is not enough");
    await page.clock.fastForward("01:30");
    await waitFor(async()=>{ try{ return (await appBuild(page)) === BUILD+1; }catch(e){ return false; } }, "the new build to load", 30000);
    await signInAgain(page);
    await gotoRoute(page, "products", false);
    await waitFor(async()=> /Brake pads/.test(await page.textContent("#main")), "the product added before the update");
    assert.strictEqual(await barText(page), null, "no banner after the update");
  });

  await t("Update now installs at once (a new version found when the app comes back to the screen)", async ()=>{
    srv.deploy(BUILD+2);
    await page.clock.fastForward("02:00");              // > 1 minute since the last check
    await page.evaluate(()=> document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(async()=> /build \d+/.test(await barText(page) || ""), "the update banner");
    assert.match(await barText(page), new RegExp("^Update ready \\(build "+(BUILD+2)+"\\)"));
    await page.click("#pwaUpdateNow");
    await waitFor(async()=>{ try{ return (await appBuild(page)) === BUILD+2; }catch(e){ return false; } }, "the new build to load", 30000);
    await signInAgain(page);
  });

  await t("every 30 minutes an open app looks again by itself", async ()=>{
    srv.deploy(BUILD+3);
    await page.locator("[data-route]").first().click();      // touched just now: not idle
    await page.clock.fastForward("31:00");
    await waitFor(async()=> new RegExp("build "+(BUILD+3)).test(await barText(page) || ""), "the update banner");
  });

  await t("seiGEN's minimum build above this build: a red \"must update\" bar with Update now", async ()=>{
    s.state.minBuild = 99;
    await page.click("#pwaUpdateNow");                        // installs BUILD+3 first (it was waiting)
    await waitFor(async()=>{ try{ return (await appBuild(page)) === BUILD+3; }catch(e){ return false; } }, "the new build", 30000);
    await signInAgain(page);
    await waitFor(async()=> (await barKind(page))==="required", "the red bar", 20000);
    assert.strictEqual(await barText(page), "This app must be updated: seiGEN needs build 99 or later (this is build "+(BUILD+3)+").Update now✕");
    assert.strictEqual(await page.evaluate(()=> getComputedStyle(document.getElementById("pwaUpdateBar")).backgroundColor), "rgb(201, 42, 42)");
    if(process.env.SHOT_DIR) await page.screenshot({ path: path.join(SHOTS, "update-required.png") });
    // nothing newer on the site yet: Update now looks, and says so
    await page.click("#pwaUpdateNow");
    await waitFor(async()=> /No update found yet/.test(await barText(page) || ""), "the 'no update found' answer", 20000);
  });

  await t("the red bar goes when seiGEN's minimum isn't above this build; an older server (no min_build) changes nothing", async ()=>{
    s.state.minBuild = BUILD+3;
    await page.reload(); await signInAgain(page);
    await waitFor(()=> page.evaluate(()=> window.sclUpdateHooks.minBuild()), "the stored minimum");
    await page.clock.fastForward("00:20");
    await page.waitForTimeout(500);
    assert.strictEqual(await barText(page), null);
    s.state.minBuild = null;
    await page.reload(); await signInAgain(page);
    await page.clock.fastForward("00:20"); await page.waitForTimeout(500);
    assert.strictEqual(await page.evaluate(()=> window.sclUpdateHooks.minBuild()), BUILD+3, "kept as it was");
    assert.strictEqual(await barText(page), null);
    assert.ok(s.calls.length >= 3 && s.calls.every(c=> typeof c.p_app_build === "number"), "every check-in sends the build");
  });

  await t("no page errors on the phone build", async ()=>{ assert.deepStrictEqual(s.errors, []); });
  await s.ctx.close(); s.srv.server.close();

  // ---------------- desktop build: on the web (desktoppos), then as the Windows program ----------------
  const w = await newShop(browser, "dist-tauri");
  await t("desktop on the web: the banner stops at the Sales screen's cart panel (Pay stays clear); idle install works", async ()=>{
    await addProduct(w.page, true, "Clutch plate");
    w.srv.deploy(BUILD+1);
    await w.page.evaluate(()=> window.dispatchEvent(new Event("online")));
    await waitFor(async()=> /Update now/.test(await barText(w.page) || ""), "Update now on the bar");
    await gotoRoute(w.page, "pos", true);
    await w.page.waitForSelector(".ds-cart");
    await w.page.waitForTimeout(300);
    const r = await w.page.evaluate(()=>{ const b = document.getElementById("pwaUpdateBar").getBoundingClientRect(), c = document.querySelector(".ds-cart").getBoundingClientRect(); return { barRight: b.right, cartLeft: c.left }; });
    assert.ok(r.barRight <= r.cartLeft + 1, "the bar stops at the cart panel ("+r.barRight+" vs "+r.cartLeft+")");
    if(process.env.SHOT_DIR) await w.page.screenshot({ path: path.join(SHOTS, "update-ready-desktop.png") });
    await w.page.clock.fastForward("02:30");
    await waitFor(async()=>{ try{ return (await appBuild(w.page)) === BUILD+1; }catch(e){ return false; } }, "the new build", 30000);
    await signInAgain(w.page);
  });

  // The same device now runs as the installed Windows program: what the program
  // adds before every page (window.__TAURI__, and src-tauri/sw-off.js), with a
  // newer installer's files (BUILD+2) behind the old worker.
  await t("Windows program: the worker an older build left is removed, so a new installer's build shows at once; the shop's data is kept", async ()=>{
    assert.ok(await w.page.evaluate(()=> !!navigator.serviceWorker.controller), "the old worker controls the page first");
    w.srv.deploy(BUILD+2);
    await w.ctx.addInitScript(()=>{ window.__TAURI__ = {}; });
    await w.ctx.addInitScript({ path: path.join(ROOT, "src-tauri", "sw-off.js") });
    await w.page.reload();
    await waitFor(async()=>{ try{ return (await appBuild(w.page)) === BUILD+2; }catch(e){ return false; } }, "the new installer's build", 30000);
    await signInAgain(w.page);
    const sw = await w.page.evaluate(async ()=> ({ controller: !!navigator.serviceWorker.controller, regs: (await navigator.serviceWorker.getRegistrations()).length, caches: (await caches.keys()).length }));
    assert.deepStrictEqual({ controller: sw.controller, regs: sw.regs }, { controller: false, regs: 0 }, "no worker, and none registered again");
    assert.ok(sw.caches >= 1, "the old cache is left as it was (nothing deleted)");
    await gotoRoute(w.page, "products", true);
    await waitFor(async()=> /Clutch plate/.test(await w.page.textContent("#main")), "the product added before");
    await w.page.reload(); await signInAgain(w.page);           // and it stays that way
    assert.strictEqual(await appBuild(w.page), BUILD+2);
    assert.strictEqual(await w.page.evaluate(async ()=> (await navigator.serviceWorker.getRegistrations()).length), 0);
  });
  await t("Windows program: About says a newer build comes as a new installer; the red bar says to ask seiGEN for it", async ()=>{
    await openAbout(w.page, true);
    assert.match(await w.page.textContent("#aboutVersion"), new RegExp("build "+(BUILD+2)+"$"));
    assert.match(await w.page.textContent("#pwaCheckResult"), /installed Windows program: a newer build comes as a new installer from seiGEN/);
    w.state.minBuild = 99;
    await w.page.reload(); await signInAgain(w.page);
    await waitFor(async()=> (await barKind(w.page))==="required", "the red bar", 20000);
    assert.strictEqual(await barText(w.page), "This app must be updated: seiGEN needs build 99 or later (this is build "+(BUILD+2)+"). Ask seiGEN for the new Windows installer.✕");
    assert.strictEqual(await w.page.$("#pwaUpdateNow"), null, "no Update now: nothing to install from here");
  });
  await t("no page errors on the desktop build", async ()=>{ assert.deepStrictEqual(w.errors, []); });
  await w.ctx.close(); w.srv.server.close();

  await browser.close();
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
