// Run: node --no-warnings test/itred-site-e2e.test.js
// (build first: node build.js --itred)
// The public iTred Market Place site (src/itred/ -> dist-itred/) as an
// installable app (iTred-B, docs/itred/itred-upgrade-design.md Part E).
// Checks that
//   * the build fills in the shared search rule, apps.json and the site's
//     address, copies the app's files, and keeps the build numbers equal
//   * served like the Worker (test/itred-serve.js): the plain address opens
//     the market (no "#/…"), clean paths (/orders, /apps …) open their page
//     directly, links change the path, Back works, old #/ links still land
//   * every page's title is "iTred Market Place – <page>"; link previews
//     (Open Graph: name, logo, short description) and the manifest (name
//     "iTred Market Place", standalone = no address bar, the iTred icons)
//   * the service worker takes over and the app opens offline
//   * the menu (drawer): opens, Esc and a route change close it
//   * phones: the footer bar, hidden while typing; desktop: no footer bar,
//     the links in the header
//   * the Products page: the six apps with exactly the owner's lines
//   * no page errors; Supabase is only asked for listings (and auth)
// Supabase is the in-test fake (test/itred-fake-supabase.js).
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

const { createFakeSupabase, listingRow } = require("./itred-fake-supabase");
const { serveItred } = require("./itred-serve");
const ROOT = path.join(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist-itred");
const DIST = path.join(DIST_DIR, "index.html");
if(!fs.existsSync(DIST)){ console.log("Missing dist-itred/index.html — run: node build.js --itred"); process.exit(1); }
const FILE_SITE = "file:///" + DIST.replace(/\\/g, "/");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

const PAGES = [
  ["/", "Market"], ["/orders", "Your Orders"], ["/vendors", "Vendors"], ["/apps", "Products"], ["/account", "Account"],
  ["/about", "About"], ["/rpn", "Become an RPN"], ["/help", "Help"], ["/contact", "Contact"], ["/privacy", "Privacy Policy"], ["/terms", "Terms of Business"],
];
const APPS = [
  ["Desktop App – seiGEN Commerce Lite", "Point of sale for your shop PC: sell, track stock and run branches, even offline."],
  ["Mobile App – seiGEN Commerce Lite", "Your till in your pocket: sell and check stock from your phone, online or offline."],
  ["iTred Market Place", "Find products from local shops and send your order on WhatsApp."],
  ["Invoice Retail", "Make quotations and invoices for your shop in minutes, then share them on WhatsApp."],
  ["Invoice Contractors", "Quotations and invoices for builders and contractors: labour, materials and jobs."],
  ["farmPLAN", "Plan your farm and keep your records in one place."],
];
const chipo = { business_name:"Chipo Clothing", whatsapp_number:"0771234567", city:"Harare" };
const listings = ()=> [listingRow({ vendor_id:"c1000000-0000-4000-8000-000000000001", vendors:chipo, product_name:"School shirt 13-14" })];

async function open(browser, url, o){
  o = o || {};
  const context = o.context || await browser.newContext(Object.assign({ serviceWorkers: o.sw ? "allow" : "block" }, o.ctx || {}));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  const fake = createFakeSupabase({ listings: listings() });
  await fake.install(page);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(url);
  await page.waitForSelector(".page.active");
  const otherSupabase = ()=> fake.log.filter(r=> r.path!=="/rest/v1/vendor_listings" && !r.path.startsWith("/auth/v1/")).map(r=> r.method+" "+r.path);
  return { context, page, errors, fake, otherSupabase };
}
const state = (page)=> page.evaluate(()=>({
  active: Array.from(document.querySelectorAll(".page.active")).map(p=> p.id),
  title: document.title, path: location.pathname, hash: location.hash,
}));

(async()=>{
  const browser = await chromium.launch();
  const srv = await serveItred();

  await t("the build: shared search, apps.json and the address filled in; the app's files copied; build numbers equal", async ()=>{
    const html = fs.readFileSync(DIST, "utf8");
    assert.ok(!/@@[A-Z_]+@@/.test(html), "a build token is left in the page");
    assert.match(html, /function textMatches\(/, "the shared search rule");
    assert.match(html, /function productTermMatches\(/);
    assert.match(html, /<meta property="og:url" content="https:\/\/itred-preview\.seigendc\.workers\.dev\/">/);
    for(const f of ["sw.js", "manifest.webmanifest", "apps.json", "itred-icon-192.png", "itred-icon-512.png", "itred-maskable-512.png",
      "apple-touch-icon.png", "og-image.png", "supabase-2.117.1.js", "jspdf-4.2.1.umd.min.js"]) assert.ok(fs.existsSync(path.join(DIST_DIR, f)), "missing "+f);
    const sw = fs.readFileSync(path.join(DIST_DIR, "sw.js"), "utf8");
    assert.strictEqual(/const ITRED_BUILD = (\d+);/.exec(html)[1], /\/\/ build: i(\d+)/.exec(sw)[1]);
    assert.ok(!/cdn\.jsdelivr|unpkg|cdnjs/.test(html), "no CDN scripts: the app serves its own");
  });

  await t("the plain address opens the market, no #/ in the address; title 'iTred Market Place – Market'", async ()=>{
    const { context, page, errors } = await open(browser, srv.base + "/");
    const s = await state(page);
    assert.deepStrictEqual(s.active, ["page-/"]);
    assert.strictEqual(s.path, "/"); assert.strictEqual(s.hash, "");
    assert.strictEqual(s.title, "iTred Market Place – Market");
    await page.waitForSelector("#marketList .lrow");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("clean paths: each page opens directly at its own path, with its own title", async ()=>{
    const { context, page, errors, otherSupabase } = await open(browser, srv.base + "/");
    for(const [route, name] of PAGES){
      await page.goto(srv.base + route);
      await page.waitForSelector(".page.active");
      const s = await state(page);
      assert.deepStrictEqual(s.active, ["page-"+route], route);
      assert.strictEqual(s.title, "iTred Market Place – " + name, route);
      assert.strictEqual(s.hash, "");
    }
    await page.goto(srv.base + "/no-such-page");
    await page.waitForSelector(".page.active");
    assert.deepStrictEqual((await state(page)).active, ["page-/"], "an unknown path shows the market");
    assert.deepStrictEqual(otherSupabase(), [], "no static page queries Supabase");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("links change the path (no reload), Back works, and old #/ links land on the right page", async ()=>{
    const { context, page, errors } = await open(browser, srv.base + "/", { ctx:{ viewport:{ width:1280, height:800 } } });
    await page.evaluate(()=>{ window.__same = true; });
    await page.click('#topLinks a[href="/vendors"]');
    let s = await state(page);
    assert.strictEqual(s.path, "/vendors"); assert.deepStrictEqual(s.active, ["page-/vendors"]);
    assert.strictEqual(await page.getAttribute('#topLinks a[href="/vendors"]', "aria-current"), "page");
    await page.click('#topLinks a[href="/apps"]');
    await page.goBack();
    await page.waitForFunction(()=> location.pathname === "/vendors" && document.querySelector(".page.active").id === "page-/vendors");
    assert.strictEqual(await page.evaluate(()=> window.__same), true, "navigation never reloaded the page");
    await page.goto(srv.base + "/#/market-space");
    await page.waitForSelector(".page.active");
    s = await state(page);
    assert.deepStrictEqual([s.path, s.hash, s.active[0]], ["/", "", "page-/"]);
    await page.goto(srv.base + "/#/products");
    await page.waitForSelector(".page.active");
    s = await state(page);
    assert.deepStrictEqual([s.path, s.active[0]], ["/apps", "page-/apps"]);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("opened as a file (no server) the hash routes still work, old names included", async ()=>{
    const { context, page, errors } = await open(browser, FILE_SITE + "#/orders", { ctx:{ viewport:{ width:390, height:844 } } });
    assert.deepStrictEqual((await state(page)).active, ["page-/orders"]);
    await page.goto(FILE_SITE + "#/market-space"); await page.waitForSelector(".page.active");
    assert.deepStrictEqual((await state(page)).active, ["page-/"]);
    await page.click('#footbar a[href="/apps"]');
    await page.waitForFunction(()=> location.hash === "#/apps");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("link previews: name, logo and short description (Open Graph), absolute addresses", async ()=>{
    const { context, page } = await open(browser, srv.base + "/");
    const meta = await page.evaluate(()=> Object.fromEntries([...document.querySelectorAll('meta[property^="og:"], meta[name="description"], meta[name="twitter:card"]')]
      .map(m=> [m.getAttribute("property") || m.getAttribute("name"), m.content])));
    assert.strictEqual(meta["og:title"], "iTred Market Place");
    assert.strictEqual(meta["og:site_name"], "iTred Market Place");
    assert.strictEqual(meta["og:description"], "Find products from local shops and send your order on WhatsApp.");
    assert.strictEqual(meta.description, meta["og:description"]);
    assert.strictEqual(meta["og:image"], "https://itred-preview.seigendc.workers.dev/og-image.png");
    assert.strictEqual(meta["twitter:card"], "summary_large_image");
    const png = fs.readFileSync(path.join(DIST_DIR, "og-image.png"));
    assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], "og-image is 1200×630");
    await context.close();
  });

  await t("the manifest: 'iTred Market Place', standalone (no address bar), the iTred icons, opens at /", async ()=>{
    const { context, page } = await open(browser, srv.base + "/orders");
    const href = await page.getAttribute('link[rel="manifest"]', "href");
    const m = await page.evaluate(async (h)=> (await fetch(h)).json(), href);
    assert.strictEqual(m.name, "iTred Market Place");
    assert.strictEqual(m.short_name, "iTred");
    assert.strictEqual(m.display, "standalone");
    assert.strictEqual(m.start_url, "/");
    assert.deepStrictEqual(m.icons.map(i=> [i.src, i.sizes, i.purpose]),
      [["itred-icon-192.png","192x192","any"],["itred-icon-512.png","512x512","any"],["itred-maskable-512.png","512x512","maskable"]]);
    for(const i of m.icons){
      const png = fs.readFileSync(path.join(DIST_DIR, i.src));
      assert.strictEqual(png.readUInt32BE(16) + "x" + png.readUInt32BE(20), i.sizes, i.src);
    }
    assert.strictEqual(await page.getAttribute('link[rel="apple-touch-icon"]', "href"), "apple-touch-icon.png");
    await context.close();
  });

  await t("the service worker takes over, and the app (any path) opens offline", async ()=>{
    const { context, page, errors } = await open(browser, srv.base + "/", { sw:true });
    await page.waitForFunction(()=> navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout:15000 }).catch(async ()=>{
      await page.reload(); await page.waitForFunction(()=> navigator.serviceWorker.controller, null, { timeout:15000 });
    });
    srv.offline = true;
    try{
      for(const p of ["/", "/orders", "/apps"]){
        await page.goto(srv.base + p);
        await page.waitForSelector(".page.active");
        assert.deepStrictEqual((await state(page)).active, ["page-"+p], p+" offline");
      }
      await page.waitForSelector("#appsRoot .app");
      assert.strictEqual(await page.locator("#appsRoot .app").count(), 6, "the apps list comes from the cache offline");
      assert.ok(await page.evaluate(()=> !!window.supabase), "supabase-js comes from the cache");
    } finally { srv.offline = false; }
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("the menu (drawer) opens from the hamburger; Esc, the scrim and a link close it", async ()=>{
    const { context, page, errors } = await open(browser, srv.base + "/", { ctx:{ viewport:{ width:390, height:844 } } });
    await page.click("#navToggle");
    assert.strictEqual(await page.getAttribute("#navToggle", "aria-expanded"), "true");
    assert.ok(await page.locator("#drawer").isVisible());
    await page.keyboard.press("Escape");
    assert.strictEqual(await page.getAttribute("#navToggle", "aria-expanded"), "false");
    assert.strictEqual(await page.evaluate(()=> document.activeElement.id), "navToggle", "focus returns to the menu button");
    await page.click("#navToggle");
    await page.click('#drawer a[href="/about"]');
    assert.strictEqual(await page.evaluate(()=> document.body.classList.contains("drawer-open")), false);
    assert.deepStrictEqual((await state(page)).active, ["page-/about"]);
    const labels = await page.$$eval("#drawer a.dl", els=> els.map(e=> e.textContent.trim()));
    assert.deepStrictEqual(labels, ["Market", "Your Orders", "Vendors", "Products (our apps)", "Account", "About & Privacy"]);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("phones: the footer bar has the 5 main pages and hides while typing; desktop: no footer bar, links in the header", async ()=>{
    const phone = await open(browser, srv.base + "/", { ctx:{ viewport:{ width:390, height:844 }, isMobile:true, hasTouch:true } });
    const p = phone.page;
    assert.ok(await p.locator("#footbar").isVisible());
    assert.deepStrictEqual(await p.$$eval("#footbar a", els=> els.map(e=> e.getAttribute("aria-label"))), ["Market", "Your Orders", "Vendors", "Our apps", "Account"]);
    assert.strictEqual(await p.locator("#topLinks").isVisible(), false, "no header links on a phone (the menu and the footer bar have them)");
    await p.focus("#marketSearch");
    await p.waitForFunction(()=> getComputedStyle(document.getElementById("footbar")).display === "none");
    await p.evaluate(()=> document.activeElement.blur());
    await p.waitForFunction(()=> getComputedStyle(document.getElementById("footbar")).display !== "none");
    // The last thing on a page is never under the bar.
    const pad = await p.evaluate(()=> parseFloat(getComputedStyle(document.body).paddingBottom));
    assert.ok(pad >= 76, "body padding-bottom "+pad);
    await phone.context.close();

    const desk = await open(browser, srv.base + "/", { ctx:{ viewport:{ width:1280, height:800 } } });
    assert.strictEqual(await desk.page.locator("#footbar").isVisible(), false);
    assert.ok(await desk.page.locator("#topLinks").isVisible());
    assert.deepStrictEqual(await desk.page.$$eval("#topLinks a", els=> els.map(e=> e.firstChild.textContent.trim())), ["Market", "Your Orders", "Vendors", "Products", "About"]);
    assert.ok(await desk.page.locator("#navToggle").isVisible(), "the hamburger stays");
    await desk.context.close();
  });

  await t("Products: the six apps with exactly the owner's lines, each with Open and Install", async ()=>{
    const { context, page, errors } = await open(browser, srv.base + "/apps");
    await page.waitForSelector("#appsRoot .app");
    const apps = await page.$$eval("#appsRoot .app", els=> els.map(e=> [e.querySelector("h4").textContent, e.querySelector("p").textContent,
      e.querySelector('a[aria-label^="Open"]').getAttribute("href"), !!e.querySelector("[data-install]")]));
    assert.deepStrictEqual(apps.map(a=> [a[0], a[1]]), APPS);
    assert.deepStrictEqual(apps.map(a=> a[2]), ["https://desktoppos-preview.seigendc.workers.dev/", "https://mobilepos-preview.seigendc.workers.dev/",
      "https://itred-preview.seigendc.workers.dev/", "https://iqwriter.seigendc.workers.dev/", "https://iqwriterv10.seigendc.workers.dev/", "https://farmplan.seigendc.workers.dev/"]);
    assert.ok(apps.every(a=> a[3]));
    await page.click('[data-install="3"]');
    await page.waitForSelector("#installSheet[open]");
    assert.match(await page.textContent("#installSheet"), /Install Invoice Retail[\s\S]*Add to Home Screen/);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("About has what used to be the home page; Send feedback opens WhatsApp to the iTred team", async ()=>{
    const { context, page, errors } = await open(browser, srv.base + "/about");
    assert.match(await page.textContent("#page-\\/about"), /iTred/);
    await page.click("#navToggle");
    await page.click("#feedbackOpen");
    await page.fill("#feedbackText", "Nice site");
    await page.evaluate(()=>{ window.open = (u)=>{ window.__opened = u; return null; }; });
    await page.click("#feedbackSend");
    const u = await page.evaluate(()=> window.__opened);
    assert.match(u, /wa\.me\/263789487287\?text=/);
    assert.match(decodeURIComponent(u), /Page: iTred Market Place – About[\s\S]*Nice site/);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await srv.close();
  await browser.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
