// Run: node --no-warnings test/itred-mobile-e2e.test.js
// (build first: node build.js --itred)
// The iTred market list in a REAL browser (Playwright/Chromium) at 390 and
// 1280 px, served like the Worker (test/itred-serve.js), with the Supabase
// fake from test/itred-fake-supabase.js (docs/itred/itred-upgrade-design.md
// E4, E5):
//   * the list only ever loads the 100×100 thumbnail (thumb_url), never the
//     full picture; a listing with no thumbnail shows the placeholder and
//     loads nothing; Text only loads no picture at all, and is remembered
//   * rows per screen at 390×844 (between the search bar and the footer
//     bar): at least 8 with pictures, 11 text only
//   * the search bar stays under the header while the list scrolls
//   * the search is Commerce Lite's rule: every term, any order, words by
//     their start, numbers whole; vendor and city count; the result line
//   * every icon button is at least 44×44 px with a label; nothing scrolls
//     sideways at 360/390/414 px
//   * shop-typed text can't inject markup
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createFakeSupabase, listingRow } = require("./itred-fake-supabase");
const { serveItred } = require("./itred-serve");

let chromium;
require("./local-cdn");   // the cdnjs files from test/cdn/, not the internet
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}
if(!fs.existsSync(path.join(__dirname, "..", "dist-itred", "index.html"))){ console.log("Missing dist-itred/index.html — run: node build.js --itred"); process.exit(1); }

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

const IMG = "https://img.test/";
const CHIPO = "c1000000-0000-4000-8000-000000000001", GARA = "c2000000-0000-4000-8000-000000000002";
const chipo = { business_name:"Chipo Clothing", whatsapp_number:"0771234567", city:"Harare" };
const gara = { business_name:"Gara Bolts & Fasteners Hardware Supplies", whatsapp_number:"0772222333", city:"Mutare" };
// 24 listings: even ones have a thumbnail (and a full picture the list must never load), odd ones only the full picture.
function listings(){
  const out = [];
  for(let i = 0; i < 24; i++){
    const has = i % 2 === 0;
    out.push(listingRow({ id:"d0000000-0000-4000-8000-0000000000" + String(i).padStart(2, "0"), vendor_id: i < 12 ? CHIPO : GARA, vendors: i < 12 ? chipo : gara,
      product_name: i < 12 ? "School shirt size " + (i + 1) : "Hex bolt M" + (i + 1) + " x 100mm zinc",
      price: 5 + i, image_url: IMG + "full-" + i + ".webp", thumb_url: has ? IMG + "thumb-" + i + "-t.webp" : null,
      published_at: new Date(Date.now() - i * 60000).toISOString() }));
  }
  out.push(listingRow({ vendor_id:GARA, vendors:gara, product_name:'<img src=x onerror="window.__xss=1">Paint 5lt', price:15, published_at:new Date(Date.now() - 99 * 60000).toISOString() }));
  out.push(listingRow({ vendor_id:GARA, vendors:gara, product_name:"Paint 15lt", price:40, published_at:new Date(Date.now() - 100 * 60000).toISOString() }));
  return out;
}
const PNG = fs.readFileSync(path.join(__dirname, "..", "dist-itred", "itred-icon-192.png"));

let srv;
async function open(browser, width, o){
  o = o || {};
  const fake = createFakeSupabase({ listings: listings() });
  const context = o.context || await browser.newContext({ viewport:{ width, height: width < 600 ? 844 : 800 }, isMobile: width < 600, hasTouch: width < 600, serviceWorkers:"block" });
  const page = await context.newPage();
  const errors = [], images = [];
  page.on("pageerror", e=> errors.push(e.message));
  await fake.install(page);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route(IMG + "**", r => { images.push(r.request().url()); r.fulfill({ status:200, contentType:"image/png", body:PNG }); });
  await page.goto(srv.base + (o.path || "/"));
  await page.waitForSelector("#marketList .lrow");
  return { context, page, errors, images, fake };
}
const search = async (page, q)=>{ await page.fill("#marketSearch", q); };
const names = (page)=> page.$$eval("#marketList .lrow .n", els=> els.map(e=> e.textContent));
// Rows fully visible between the bottom of the search bar and the top of the footer bar (or the screen's bottom).
const rowsOnScreen = (page)=> page.evaluate(()=>{
  const top = document.querySelector(".searchbar").getBoundingClientRect().bottom;
  const fb = document.getElementById("footbar");
  const bottom = fb && getComputedStyle(fb).display !== "none" ? fb.getBoundingClientRect().top : window.innerHeight;
  return [...document.querySelectorAll("#marketList .lrow")].filter(r=>{ const b = r.getBoundingClientRect(); return b.top >= top - 0.5 && b.bottom <= bottom + 0.5; }).length;
});

(async()=>{
  const browser = await chromium.launch();
  srv = await serveItred();

  await t("390 px, Pictures: only 100×100 thumbnails load (never the full picture); no thumbnail = the placeholder, nothing loaded", async ()=>{
    const { context, page, errors, images, fake } = await open(browser, 390);
    const sel = new URLSearchParams(fake.requests("/rest/v1/vendor_listings", "GET")[0].query).get("select");
    assert.match(sel, /thumb_url/); assert.ok(!/image_url/.test(sel), "the list never asks for image_url");
    // scroll through the whole list so every lazy picture would load
    for(let y = 0; y < 6000; y += 400){ await page.mouse.wheel(0, 400); await page.waitForTimeout(40); }
    await page.waitForTimeout(300);
    assert.ok(images.length > 0, "thumbnails were loaded");
    assert.ok(images.every(u=> /-t\.webp$/.test(u)), "only thumbnails: " + images.filter(u=> !/-t\.webp$/.test(u)).join(", "));
    const rows = await page.$$eval("#marketList .lrow", els=> els.map(e=> ({ n:e.querySelector(".n").textContent, img:e.querySelector("img.th") && e.querySelector("img.th").getAttribute("src"),
      ph:!!e.querySelector(".th-empty"), w:e.querySelector(".th, .th-empty").getBoundingClientRect().width, lazy:e.querySelector("img.th") && e.querySelector("img.th").getAttribute("loading") })));
    const noThumb = rows.filter(r=> !r.img);
    assert.strictEqual(noThumb.length, 14, "12 odd listings + 2 paint listings have no thumbnail");
    assert.ok(noThumb.every(r=> r.ph), "each shows the placeholder");
    assert.ok(rows.filter(r=> r.img).every(r=> r.lazy === "lazy"));
    assert.ok(rows.every(r=> r.w === 56), "shown at 56 px");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("390 px: at least 8 rows on screen with pictures, 11 text only; Text only loads no pictures and is remembered", async ()=>{
    const { context, page, errors, images } = await open(browser, 390);
    const pics = await rowsOnScreen(page);
    assert.ok(pics >= 8, "pictures: " + pics + " rows");
    await page.click("#viewText");
    assert.strictEqual(await page.getAttribute("#viewText", "aria-pressed"), "true");
    const text = await rowsOnScreen(page);
    assert.ok(text >= 11, "text only: " + text + " rows");
    assert.strictEqual(await page.locator("#marketList img").count(), 0);
    assert.match(await page.textContent("#marketMeta"), /text only, no pictures/);
    images.length = 0;
    await page.reload();
    await page.waitForSelector("#marketList .lrow.text");
    for(let y = 0; y < 4000; y += 400){ await page.mouse.wheel(0, 400); await page.waitForTimeout(30); }
    assert.deepStrictEqual(images, [], "no picture requested in Text only");
    assert.strictEqual(await page.evaluate(()=> localStorage.getItem("itred.view")), "text");
    await page.click("#viewPics");
    assert.strictEqual(await page.evaluate(()=> localStorage.getItem("itred.view")), "pics");
    console.log("       (rows on screen at 390×844: " + pics + " with pictures, " + text + " text only)");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("the search bar stays under the header while the list scrolls", async ()=>{
    const { context, page } = await open(browser, 390);
    const before = await page.locator(".searchbar").boundingBox();
    await page.mouse.wheel(0, 1500); await page.waitForTimeout(200);
    const after = await page.locator(".searchbar").boundingBox();
    assert.ok(await page.evaluate(()=> window.scrollY) > 500, "the page scrolled");
    assert.strictEqual(Math.round(after.y), 56, "pinned under the 56 px header");
    assert.ok(Math.abs(after.height - before.height) < 1);
    await context.close();
  });

  await t("Commerce Lite's search: every term, any order; words by their start; numbers whole; vendor and city count", async ()=>{
    const { context, page, errors } = await open(browser, 390);
    await search(page, "shirt school 3");
    assert.deepStrictEqual(await names(page), ["School shirt size 3"], "any order, a number is whole (not 13)");
    await search(page, "5lt");
    assert.deepStrictEqual((await names(page)).map(n=> n.replace(/^<img[^>]*>/, "")), ["Paint 5lt"], "5lt is not 15lt");
    await search(page, "hirt");
    assert.deepStrictEqual(await names(page), [], "a word matches by its start only");
    await search(page, "mutare paint");
    assert.strictEqual((await names(page)).length, 2, "the city and the name");
    await search(page, "chipo");
    assert.strictEqual((await names(page)).length, 12, "the vendor");
    assert.strictEqual(await page.textContent("#marketMeta"), "12 products from 1 vendor");
    await search(page, "zzz");
    assert.match(await page.textContent("#marketEmpty"), /No matches[\s\S]*Check the spelling/);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("Vendors lists each vendor with its city and count; a tap shows its products", async ()=>{
    const { context, page, errors } = await open(browser, 390);
    await page.click('#footbar a[href="/vendors"]');
    await page.waitForSelector("#vendorsRoot .vrow");
    const rows = await page.$$eval("#vendorsRoot .vrow", els=> els.map(e=> e.innerText.replace(/\s+/g, " ").trim()));
    assert.deepStrictEqual(rows, ["Chipo Clothing Harare · 12 products Products", "Gara Bolts & Fasteners Hardware Supplies Mutare · 14 products Products"]);
    await page.click('#vendorsRoot [data-vendor-search="Chipo Clothing"]');
    await page.waitForFunction(()=> location.pathname === "/" && document.getElementById("marketSearch").value === "Chipo Clothing");
    assert.strictEqual(await page.textContent("#marketMeta"), "12 products from 1 vendor");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("every icon button is at least 44×44 px with a label; nothing scrolls sideways at 360/390/414 px", async ()=>{
    for(const w of [360, 390, 414]){
      const { context, page, errors } = await open(browser, w);
      const small = await page.evaluate(()=> [...document.querySelectorAll(".ib")].filter(e=> e.offsetParent).map(e=>{ const b = e.getBoundingClientRect();
        return { l:e.getAttribute("aria-label"), w:Math.round(b.width), h:Math.round(b.height) }; }).filter(x=> x.w < 44 || x.h < 44 || !x.l));
      assert.deepStrictEqual(small, [], w + " px");
      assert.strictEqual(await page.evaluate(()=> document.documentElement.scrollWidth <= window.innerWidth), true, w + " px scrolls sideways");
      assert.strictEqual(await page.evaluate(()=> window.__xss), undefined);
      assert.deepStrictEqual(errors, []);
      await context.close();
    }
  });

  await t("1280 px: the same list, no footer bar, the search bar under the header", async ()=>{
    const { context, page, errors, images } = await open(browser, 1280);
    assert.strictEqual(await page.locator("#footbar").isVisible(), false);
    assert.ok(await rowsOnScreen(page) >= 8);
    await page.waitForTimeout(300);
    assert.ok(images.every(u=> /-t\.webp$/.test(u)));
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await srv.close();
  await browser.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
