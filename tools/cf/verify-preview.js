// node tools/cf/verify-preview.js <mobile url> <desktop url> <screenshot dir>
// Step 4 checks against deployed preview Workers (read-only for Supabase):
//   * response headers of / (index.html), /sw.js, /manifest.json
//   * Chromium's manifest parse (DevTools Page.getAppManifest) + every icon decoding at its declared size
//   * the service worker registers and takes control (Application panel equivalent)
//   * the app reaches Setup and, after setup + reload, the Start screen, with no console errors
//   * Supabase from THIS origin, with no database writes: real cross-origin RPC calls the server
//     rejects at validation (CORS preflight + readable JSON error = reachable, no CORS/CSP block).
//     The app's own check-in after setup is intercepted (a successful check-in would create a
//     cl_vendors row in the live database), and Settings → Business & Terminals is opened.
"use strict";
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const [,, MOBILE, DESKTOP, SHOTS] = process.argv;
const SUPA = "https://urbopdsubwawtybwrxjd.supabase.co";
// The app's public (anon/publishable) key, read from source — the shipped builds are obfuscated. Never printed.
const ANON = (fs.readFileSync(path.join(__dirname, "..", "..", "src", "devicecheckin.js"), "utf8").match(/const DC_ANON_KEY = "([^"]+)"/)||[])[1];
fs.mkdirSync(SHOTS, { recursive: true });

async function headers(url){
  const r = await fetch(url, { redirect: "manual" });
  const pick = ["content-type", "cache-control", "etag", "last-modified", "age", "cf-cache-status", "server", "location"];
  return Object.fromEntries([["status", r.status]].concat(pick.filter(h=>r.headers.get(h)!==null).map(h=>[h, r.headers.get(h)])));
}

async function check(browser, base, desktop){
  const out = { base, headers: {}, consoleErrors: [], pageErrors: [] };
  for(const p of ["", "sw.js", "manifest.json"]) out.headers["/"+p] = await headers(base + p);

  const ctx = await browser.newContext({ viewport: desktop? { width:1280, height:800 } : { width:390, height:844 }, isMobile: !desktop, hasTouch: !desktop,
    userAgent: desktop? undefined : "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36" });
  // the app's own writes to the live project are intercepted (see header)
  const intercepted = [];
  await ctx.route(/urbopdsubwawtybwrxjd\.supabase\.co\/rest\/v1\/rpc\/cl_device_checkin$/, route=>{
    if(route.request().headers()["x-preview-probe"]) return route.continue();   // the validation-only probe below
    intercepted.push("cl_device_checkin");
    route.fulfill({ status:200, contentType:"application/json", headers:{ "access-control-allow-origin":"*" },
      body: JSON.stringify({ vendor_id:null, status:"onboarding", lock_cart:false, lock_add_product:false, lock_reason:null, messages:[], business_id:null, terminal_id:null }) });
  });
  const page = await ctx.newPage();
  page.on("console", m=>{ if(m.type()==="error") out.consoleErrors.push(m.text().slice(0,200)); });
  page.on("pageerror", e=> out.pageErrors.push(e.message.slice(0,200)));
  page.on("dialog", d=>d.accept());
  await page.goto(base);

  // manifest + icons
  const cdp = await ctx.newCDPSession(page);
  const man = await cdp.send("Page.getAppManifest");
  const parsed = JSON.parse(man.data || "{}");
  out.manifest = { errors: man.errors, url: man.url, icons: await page.evaluate(async (icons)=> Promise.all(icons.map(async ic=>{
    const img = new Image(); img.src = ic.src; try{ await img.decode(); }catch(e){ return { src: ic.src, ok:false }; }
    return { src: ic.src, purpose: ic.purpose, size: img.naturalWidth+"x"+img.naturalHeight, ok: ic.sizes===img.naturalWidth+"x"+img.naturalHeight };
  })), parsed.icons||[]) };

  // service worker: registers, activates, controls after a reload
  await page.waitForSelector("#setShop", { timeout: 30000 });
  const reg = await page.evaluate(async ()=>{ const r = await navigator.serviceWorker.ready; return { scope: r.scope, script: r.active && r.active.scriptURL, state: r.active && r.active.state }; });
  out.serviceWorker = reg;
  if(desktop===false) await page.screenshot({ path: path.join(SHOTS, "mobile-preview-setup.png") });

  // Supabase from this origin, no writes: validation errors prove the cross-origin call worked
  out.supabaseFromOrigin = await page.evaluate(async ({ SUPA, key })=>{
    const call = async (fn, body)=>{
      try{
        const r = await fetch(SUPA + "/rest/v1/rpc/" + fn, { method:"POST", headers:{ apikey: key, "Content-Type":"application/json", "x-preview-probe":"1" }, body: JSON.stringify(body) });
        const j = await r.json().catch(()=>null);
        return { status: r.status, readable: true, message: j && (j.message || (j.error && j.error)) || null };
      }catch(e){ return { readable:false, error: String(e) }; }
    };
    return {
      origin: location.origin,
      // empty install_id: refused before any read or write
      cl_device_checkin: await call("cl_device_checkin", { p_install_id:"", p_shop_secret_phrase:"x", p_device_code:null, p_business_name:null }),
      // unknown install, p_create=false path: refused, nothing written
      cl_branch_list: await call("cl_branch_list", { p_install_id:"PREVIEW-CHECK-NOT-A-DEVICE", p_secret_phrase:"x", p_device_key:"x" }),
    };
  }, { SUPA, key: ANON });

  // finish setup (check-in intercepted), reload: the Start screen
  await page.fill("#setShop", "Preview Check"); await page.fill("#setBranch", "Harare CBD"); await page.fill("#setSecret", "preview check phrase");
  await page.click("#setupNext"); await page.click("#setupNext2"); await page.click("#setupNext3"); await page.click("#setupFinish");
  await page.waitForSelector("#logoutBtn", { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForSelector("#startSignIn", { timeout: 30000 });
  await page.waitForFunction(()=>{ const g = document.getElementById("startGlobe"); return g && g.complete && g.naturalWidth>0; }, null, { timeout: 15000 });
  out.serviceWorker.controlsAfterReload = await page.evaluate(()=> !!navigator.serviceWorker.controller);
  out.startScreen = await page.evaluate(()=>({ shop: document.getElementById("startShop").textContent.trim(), place: (document.getElementById("startPlace")||{}).textContent, globe: document.getElementById("startGlobe").getBoundingClientRect().width }));
  await page.screenshot({ path: path.join(SHOTS, (desktop? "desktop" : "mobile") + "-preview-start.png") });

  // sign in → app → Settings → Business & Terminals (unregistered card, no call made until Register is pressed)
  await page.click("#startSignIn"); await page.fill("#whoName", "Preview"); await page.click("#whoContinue");
  await page.waitForSelector("#logoutBtn");
  if(desktop){ await page.click("#hamburgerBtn"); await page.click('#navDrawer [data-route="more"]'); }
  else await page.click('.navbar [data-route="more"]');
  await page.locator('[data-kebab-toggle="moretab"]:visible').first().click();
  await page.locator('[data-tab="settings"]:visible').first().click();
  await page.waitForSelector("#terminalCard");
  out.businessAndTerminalsCard = await page.getAttribute("#terminalCard", "data-registered");
  if(desktop) await page.screenshot({ path: path.join(SHOTS, "desktop-preview-app-1280.png") });
  out.intercepted = intercepted;
  await ctx.close();
  return out;
}

(async()=>{
  const browser = await chromium.launch();
  const res = { mobile: await check(browser, MOBILE, false), desktop: await check(browser, DESKTOP, true) };
  await browser.close();
  console.log(JSON.stringify(res, null, 1));
})().catch(e=>{ console.error(e); process.exit(1); });
