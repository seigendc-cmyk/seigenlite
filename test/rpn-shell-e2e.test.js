// Run: node --no-warnings test/rpn-shell-e2e.test.js
// (build first: node build.js --rpn)
// The RPN Field Guide shell (dist-rpn/), served over real http from its own
// origin, the way it's hosted on its own subdomain:
//   * loads with no console errors; Chrome reports it installable; the
//     manifest and icons are complete
//   * its service worker controls the page, with scope = its own origin, and
//     precaches the whole shell into seigen-rpn-v1 only
//   * every control added in Phase 1 is wired: the four tabs (and Back),
//     search open/close (button, Escape, backdrop), install button, update
//     banner
//   * offline: a reload with the network cut still opens and navigates
//   * cross-origin requests (Supabase later) are never cached by the worker
//   * an update waits for "Reload", never reloads on its own, and leaves
//     caches it doesn't own alone
//   * layout at 360x640 and 412x915: no sideways scroll, 48px+ tap targets,
//     light even when the phone asks for dark. Screenshots go to
//     RPN_SHOTS_DIR (default: a temp folder, printed at the end).
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist-rpn");
const SHELL_FILES = ["index.html", "sw.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
for(const f of SHELL_FILES){
  if(!fs.existsSync(path.join(DIST, f))){ console.log("Missing dist-rpn/"+f+" — run: node build.js --rpn"); process.exit(1); }
}
const SHOTS = process.env.RPN_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "rpn-shots-"));
fs.mkdirSync(SHOTS, { recursive: true });

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

const TYPES = { ".html":"text/html", ".js":"text/javascript", ".webmanifest":"application/manifest+json", ".png":"image/png", ".svg":"image/svg+xml" };
// A fresh copy of dist-rpn/ per server, so a test can change sw.js.
function deploy(){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpn-hosted-"));
  for(const f of fs.readdirSync(DIST)) fs.copyFileSync(path.join(DIST, f), path.join(dir, f));
  const server = http.createServer((req, res)=>{
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(dir, rel);
    if(!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){ res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r=> server.listen(0, "127.0.0.1", ()=> r({ server, dir, base:"http://127.0.0.1:"+server.address().port+"/" })));
}
// Stands in for Supabase: another origin, CORS open, counts every hit.
function otherOrigin(){
  const hits = { n:0 };
  const server = http.createServer((req, res)=>{
    hits.n++;
    res.writeHead(200, { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" });
    res.end(JSON.stringify({ hit: hits.n }));
  });
  return new Promise(r=> server.listen(0, "127.0.0.1", ()=> r({ server, hits, base:"http://127.0.0.1:"+server.address().port+"/" })));
}

function watchErrors(page){
  const errors = [];
  page.on("console", (m)=>{ if(m.type()==="error") errors.push(m.text()); });
  page.on("pageerror", (e)=> errors.push(String(e)));
  return errors;
}
async function waitFor(page, fn, what, ms=20000){
  const deadline = Date.now() + ms;
  while(!(await page.evaluate(fn))){
    if(Date.now() > deadline) throw new Error("timed out waiting for "+what);
    await page.waitForTimeout(100);
  }
}
async function openControlled(page, url){
  await page.goto(url);
  await waitFor(page, ()=> !!navigator.serviceWorker.controller, "the service worker to control the page");
}
const h1 = (page)=> page.textContent("#fgMain .fg-h1");
// The hash changes first; the screen renders on the hashchange that follows.
const TITLES = { coach:"Coach", field:"Field", receipts:"Receipts", me:"Me" };
async function onTab(page, key){
  await page.waitForFunction(([k, title])=>{
    const h = document.querySelector("#fgMain .fg-h1");
    return (location.hash==="#/"+k || (k==="coach" && location.hash==="")) && h && h.textContent.trim()===title;
  }, [key, TITLES[key]]);
}
const pngSize = (file)=>{ const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

(async ()=>{
  const browser = await chromium.launch();
  const site = await deploy();
  const api = await otherOrigin();

  await t("loads with no console errors; frame and Coach tab render", async ()=>{
    const ctx = await browser.newContext({ viewport:{ width:412, height:915 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await openControlled(page, site.base);
    await page.reload();
    assert.strictEqual((await h1(page)).trim(), "Coach");
    assert.strictEqual(await page.getAttribute("#fgNav-coach", "aria-current"), "page");
    assert.strictEqual(await page.title(), "RPN Field Guide");
    assert.deepStrictEqual(errors, []);
    await ctx.close();
  });

  await t("manifest is complete and every icon is the size it claims", async ()=>{
    const m = JSON.parse(fs.readFileSync(path.join(site.dir, "manifest.webmanifest"), "utf8"));
    assert.strictEqual(m.start_url, "./");
    assert.strictEqual(m.scope, "./");
    assert.strictEqual(m.display, "standalone");
    assert.ok(m.name && m.short_name && m.theme_color && m.background_color);
    const purposes = m.icons.map((i)=> i.purpose);
    assert.ok(purposes.includes("maskable"), "has a maskable icon");
    for(const icon of m.icons.filter((i)=> i.type==="image/png")){
      const [w, h] = pngSize(path.join(site.dir, icon.src));
      assert.strictEqual(w+"x"+h, icon.sizes, icon.src);
    }
    const [aw, ah] = pngSize(path.join(site.dir, "apple-touch-icon.png"));
    assert.strictEqual(aw+"x"+ah, "180x180");
  });

  await t("Chrome reports no installability errors", async ()=>{
    // A persistent profile: Chrome refuses installs in incognito-like contexts.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rpn-profile-"));
    const ctx = await chromium.launchPersistentContext(profile, { viewport:{ width:412, height:915 } });
    const page = ctx.pages()[0] || await ctx.newPage();
    await openControlled(page, site.base);
    const cdp = await ctx.newCDPSession(page);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    assert.deepStrictEqual(installabilityErrors, []);
    const { url, data } = await cdp.send("Page.getAppManifest");
    assert.ok(url.endsWith("/manifest.webmanifest") && data.includes("RPN Field Guide"));
    await ctx.close();
  });

  await t("service worker: scope is its own origin, shell precached into seigen-rpn-v1 only", async ()=>{
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await openControlled(page, site.base);
    const info = await page.evaluate(async ()=>{
      const reg = await navigator.serviceWorker.getRegistration();
      const names = await caches.keys();
      const cache = await caches.open("seigen-rpn-v1");
      const keys = (await cache.keys()).map((r)=> new URL(r.url).pathname);
      return { scope: reg.scope, names, keys };
    });
    assert.strictEqual(info.scope, site.base);
    assert.deepStrictEqual(info.names, ["seigen-rpn-v1"]);
    for(const f of SHELL_FILES.filter((f)=> f!=="sw.js")) assert.ok(info.keys.includes("/"+f), "precached "+f);
    await ctx.close();
  });

  await t("tabs: each one opens its screen, marks itself current, and Back returns", async ()=>{
    const ctx = await browser.newContext({ viewport:{ width:360, height:640 } });
    const page = await ctx.newPage();
    await page.goto(site.base);
    for(const key of ["field", "receipts", "me", "coach"]){
      await page.click("#fgNav-"+key);
      await onTab(page, key);
      const current = await page.$$eval(".fg-nav button[aria-current=page]", (els)=> els.map((e)=> e.dataset.tab));
      assert.deepStrictEqual(current, [key]);
    }
    await page.goBack();
    await onTab(page, "me");
    // A deep link opens straight on its tab; an unknown one falls back to Coach.
    await page.goto(site.base+"#/receipts");
    assert.strictEqual((await h1(page)).trim(), "Receipts");
    await page.goto(site.base+"#/nope");
    assert.strictEqual((await h1(page)).trim(), "Coach");
    await ctx.close();
  });

  // The search itself is covered in test/fieldguide-search-e2e.test.js;
  // this is the sheet: open, focus, close three ways.
  await t("search sheet: opens focused, answers, closes by button, Escape and backdrop", async ()=>{
    const ctx = await browser.newContext({ viewport:{ width:360, height:640 } });
    const page = await ctx.newPage();
    await page.goto(site.base);
    await page.click("#fgSearchOpen");
    assert.ok(await page.isVisible("#fgSearch"));
    assert.strictEqual(await page.evaluate(()=> document.activeElement.id), "fgSearchInput");
    await page.waitForFunction(()=> /Try asking about/.test(document.getElementById("fgSearchBody").textContent));
    await page.fill("#fgSearchInput", "day rate");
    await page.waitForSelector("#fgSearchBody .fg-sr-lead");
    await page.screenshot({ path: path.join(SHOTS, "360-search.png") });
    await page.keyboard.press("Escape"); // clears what was typed
    assert.ok(await page.isVisible("#fgSearch"));
    assert.strictEqual(await page.inputValue("#fgSearchInput"), "");
    await page.keyboard.press("Escape"); // then closes
    assert.ok(await page.isHidden("#fgSearch"));
    assert.strictEqual(await page.evaluate(()=> document.activeElement.id), "fgSearchOpen");
    await page.click("#fgSearchOpen");
    await page.fill("#fgSearchInput", "day rate");
    await page.click("#fgSearchClose");
    assert.ok(await page.isHidden("#fgSearch"));
    await page.click("#fgSearchOpen");
    assert.strictEqual(await page.inputValue("#fgSearchInput"), "day rate", "the query is kept when the sheet closes");
    await page.click("#fgSearchClear"); // a short sheet, so there is backdrop below it
    assert.strictEqual(await page.inputValue("#fgSearchInput"), "");
    await page.mouse.click(180, 630); // the dimmed backdrop below the panel
    assert.ok(await page.isHidden("#fgSearch"));
    await ctx.close();
  });

  await t("install button: appears when the browser offers install, prompts, then says installed", async ()=>{
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(site.base+"#/me");
    assert.strictEqual(await page.$("#fgInstall"), null, "no button before the browser offers install");
    assert.match(await page.textContent("#fgMain"), /Install isn't offered right now/);
    // Headless Chrome never fires beforeinstallprompt by itself; this is
    // the same event shape (prompt + userChoice) the app receives.
    await page.evaluate(()=>{
      const e = new Event("beforeinstallprompt", { cancelable:true });
      e.prompt = ()=>{ window.__prompted = true; };
      e.userChoice = Promise.resolve({ outcome:"accepted" });
      window.dispatchEvent(e);
    });
    await page.waitForSelector("#fgInstall");
    await page.click("#fgInstall");
    await page.waitForFunction(()=> /Installed on this device/.test(document.getElementById("fgMain").textContent));
    assert.strictEqual(await page.evaluate(()=> window.__prompted), true);
    assert.strictEqual(await page.$("#fgInstall"), null);
    await ctx.close();
  });

  await t("offline: reload with no network still opens, navigates and says so", async ()=>{
    const ctx = await browser.newContext({ viewport:{ width:412, height:915 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await openControlled(page, site.base+"#/me");
    await page.waitForFunction(()=> /Ready/.test(document.getElementById("fgReady").textContent));
    await ctx.setOffline(true);
    await page.reload();
    assert.strictEqual((await h1(page)).trim(), "Me");
    assert.ok(await page.isVisible("#fgOffline"), "offline pill in the top bar");
    assert.match(await page.textContent("#fgConn"), /Offline/);
    await page.waitForFunction(()=> /Ready/.test(document.getElementById("fgReady").textContent));
    await page.screenshot({ path: path.join(SHOTS, "412-me-offline.png") });
    for(const key of ["coach", "field", "receipts"]){
      await page.click("#fgNav-"+key);
      await onTab(page, key);
    }
    // A brand-new navigation (not a reload) is served from the cache too.
    await page.goto(site.base+"?from=homescreen#/field");
    assert.strictEqual((await h1(page)).trim(), "Field");
    await ctx.setOffline(false);
    await page.waitForFunction(()=> document.getElementById("fgOffline").hidden);
    assert.deepStrictEqual(errors, []);
    await ctx.close();
  });

  await t("cross-origin requests go to the network every time, never into a cache", async ()=>{
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await openControlled(page, site.base);
    const before = api.hits.n;
    await page.evaluate(async (u)=>{ await (await fetch(u)).json(); await (await fetch(u)).json(); }, api.base+"rest/v1/thing");
    assert.strictEqual(api.hits.n - before, 2);
    const cached = await page.evaluate(async (u)=> !!(await caches.match(u)), api.base+"rest/v1/thing");
    assert.strictEqual(cached, false);
    await ctx.close();
  });

  await t("update: banner waits for Reload, never reloads on its own, leaves other caches alone", async ()=>{
    const ctx = await browser.newContext({ viewport:{ width:412, height:915 } });
    const page = await ctx.newPage();
    await openControlled(page, site.base);
    await page.evaluate(async ()=>{
      window.__samePage = true;
      await (await caches.open("seigen-lite-pwa-v1")).put("/marker", new Response("core app's cache"));
    });
    assert.ok(await page.isHidden("#fgUpdate"));
    fs.appendFileSync(path.join(site.dir, "sw.js"), "\n// a new build\n");
    await page.evaluate(async ()=> (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForSelector("#fgUpdate", { state:"visible" });
    await page.waitForTimeout(1500);
    assert.strictEqual(await page.evaluate(()=> window.__samePage), true, "no reload before the person asks");
    assert.strictEqual(await page.evaluate(async ()=> !!(await navigator.serviceWorker.getRegistration()).waiting), true);
    await page.screenshot({ path: path.join(SHOTS, "412-update-banner.png") });
    await Promise.all([ page.waitForEvent("framenavigated"), page.click("#fgUpdateReload") ]);
    await page.waitForSelector("#fgMain .fg-h1");
    assert.notStrictEqual(await page.evaluate(()=> window.__samePage), true, "the page reloaded");
    const after = await page.evaluate(async ()=>{
      const reg = await navigator.serviceWorker.getRegistration();
      return { waiting: !!reg.waiting, controlled: !!navigator.serviceWorker.controller, names: (await caches.keys()).sort() };
    });
    assert.deepStrictEqual(after, { waiting:false, controlled:true, names:["seigen-lite-pwa-v1", "seigen-rpn-v1"] });
    assert.ok(await page.isHidden("#fgUpdate"));
    await ctx.close();
  });

  for(const [w, h] of [[360, 640], [412, 915]]){
    await t("layout at "+w+"x"+h+": no sideways scroll, 48px tap targets, light under dark mode", async ()=>{
      const ctx = await browser.newContext({ viewport:{ width:w, height:h }, colorScheme:"dark", deviceScaleFactor:2, isMobile:true, hasTouch:true });
      const page = await ctx.newPage();
      await page.goto(site.base);
      for(const key of ["coach", "field", "receipts", "me"]){
        await page.tap("#fgNav-"+key);
        await onTab(page, key);
        const m =await page.evaluate(()=>{
          const r = (sel)=> [...document.querySelectorAll(sel)].map((e)=>{ const b = e.getBoundingClientRect(); return { w:b.width, h:b.height }; });
          return {
            scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            nav: r(".fg-nav button"), search: r("#fgSearchOpen"),
          };
        });
        assert.ok(m.scrollW <= m.clientW, key+": page is "+m.scrollW+"px wide in a "+m.clientW+"px screen");
        assert.strictEqual(m.bodyBg, "rgb(255, 250, 246)", key+": background stays light");
        for(const b of m.nav.concat(m.search)) assert.ok(b.w >= 48 && b.h >= 44, key+": tap target "+b.w+"x"+b.h);
        await page.screenshot({ path: path.join(SHOTS, w+"-"+key+".png") });
      }
      await ctx.close();
    });
  }

  await browser.close();
  site.server.close();
  api.server.close();
  console.log("Screenshots: "+SHOTS);
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
