// Run: node --no-warnings test/itred-site-e2e.test.js
// (build first: node build.js --itred)
// The public iTred Market Place site (src/itred/index.html -> dist-itred/):
// its page structure. Checks that
//   * the build is a byte-for-byte copy of the source
//   * each of the 9 hash routes shows exactly its own page, sets its title
//     and highlights its nav link; an unknown route falls back to Home
//   * the nav links really navigate, and the mobile menu toggle opens
//   * the page throws no errors, and the only Supabase calls are the live
//     ones (listings, auth) — the static sections never query it
// Runs against a real browser (Playwright/Chromium), like the other *-e2e
// suites, loading the built file from disk. Supabase is the in-test fake
// (test/itred-fake-supabase.js); the Supabase features themselves are
// covered in test/itred-supabase-e2e.test.js.
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

const { createFakeSupabase } = require("./itred-fake-supabase");
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src", "itred", "index.html");
const DIST = path.join(ROOT, "dist-itred", "index.html");
if(!fs.existsSync(DIST)){ console.log("Missing dist-itred/index.html — run: node build.js --itred"); process.exit(1); }

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const URL_BASE = "file:///" + DIST.replace(/\\/g, "/");

const ROUTES = [
  ["/",             "iTred Market Place",        "Home"],
  ["/market-space", "Market Space — iTred",      "Market Space"],
  ["/products",     "Products — iTred",          "Products"],
  ["/rpn",          "RPN Application — iTred",   "Become an RPN"],
  ["/help",         "Help — iTred",              "Help"],
  ["/contact",      "Contact Us — iTred",        "Contact"],
  ["/account",      "Your account — iTred",      "Sign in"],
  ["/privacy",      "Privacy Policy — iTred",    null], // footer-only pages: no top-nav link
  ["/terms",        "Terms of Business — iTred", null],
];

// supabaseRequests() lists Supabase calls OTHER than the live listings/auth ones.
async function openSite(browser, hash, viewport){
  const page = await browser.newPage(viewport? { viewport } : {});
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  const fake = createFakeSupabase();
  await fake.install(page);
  await page.goto(URL_BASE + (hash||""));
  await page.waitForSelector(".page.active");
  const supabaseRequests = ()=> fake.log
    .filter(r=> r.path!=="/rest/v1/vendor_listings" && !r.path.startsWith("/auth/v1/"))
    .map(r=> r.method+" "+r.path);
  return { page, errors, supabaseRequests };
}
async function routeState(page){
  return page.evaluate(()=>({
    active: Array.from(document.querySelectorAll(".page.active")).map(p=>p.id),
    title: document.title,
    navActive: Array.from(document.querySelectorAll("nav.mainnav a.active")).map(a=>a.textContent.trim()),
  }));
}

(async()=>{
  await t("dist-itred/index.html is a byte-for-byte copy of src/itred/index.html", async ()=>{
    assert.ok(fs.readFileSync(SRC).equals(fs.readFileSync(DIST)));
  });

  const browser = await chromium.launch();

  await t("the site has exactly the 9 expected pages", async ()=>{
    const { page } = await openSite(browser);
    const ids = await page.$$eval(".page", els=> els.map(e=>e.id));
    assert.deepStrictEqual(ids, ROUTES.map(r=>"page-"+r[0]));
    await page.close();
  });

  for(const [route, title, navLabel] of ROUTES){
    await t("#"+route+" loads its page, title and nav state", async ()=>{
      const { page, errors, supabaseRequests } = await openSite(browser, "#"+route);
      const s = await routeState(page);
      assert.deepStrictEqual(s.active, ["page-"+route]);
      assert.strictEqual(s.title, title);
      assert.deepStrictEqual(s.navActive, navLabel? [navLabel] : []);
      const text = await page.textContent('[id="page-'+route+'"]'); // ids contain "/", so no #id selector
      assert.ok(text.trim().length > 50, "page "+route+" looks empty");
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(supabaseRequests(), []);
      await page.close();
    });
  }

  await t("an unknown route falls back to Home", async ()=>{
    const { page } = await openSite(browser, "#/no-such-page");
    const s = await routeState(page);
    assert.deepStrictEqual(s.active, ["page-/"]);
    assert.strictEqual(s.title, "iTred Market Place");
    await page.close();
  });

  await t("clicking through the top nav moves between pages without reloading", async ()=>{
    const { page, errors, supabaseRequests } = await openSite(browser);
    await page.evaluate(()=>{ window.__sameDocument = true; });
    for(const [route, title, navLabel] of ROUTES.filter(r=>r[2])){
      await page.click('nav.mainnav a[data-route="'+route+'"]');
      await page.waitForFunction((id)=> document.querySelector(".page.active") && document.querySelector(".page.active").id===id, "page-"+route);
      assert.strictEqual(await page.title(), title);
    }
    assert.strictEqual(await page.evaluate(()=>window.__sameDocument), true);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(supabaseRequests(), []);
    await page.close();
  });

  await t("on a phone-width screen the menu toggle opens the nav, and navigating closes it", async ()=>{
    const { page } = await openSite(browser, "", { width:390, height:844 });
    await page.click("#navToggle");
    assert.strictEqual(await page.$eval("#mainNav", n=>n.classList.contains("open")), true);
    await page.click('nav.mainnav a[data-route="/help"]');
    await page.waitForFunction(()=> document.querySelector(".page.active").id==="page-/help");
    assert.strictEqual(await page.$eval("#mainNav", n=>n.classList.contains("open")), false);
    await page.close();
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed?1:0);
})();
