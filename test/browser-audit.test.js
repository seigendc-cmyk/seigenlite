// Run: node --no-warnings test/browser-audit.test.js
// Full Rendering Audit (Part A): the ONE test file in this suite that runs
// against a REAL headless browser (Playwright/Chromium) instead of jsdom —
// closing the "no real browser" verification gap the audit task asked
// about. Loads the actual dist/index.html build (not a copy, not src/
// concatenated ad hoc) and drives it exactly like a cashier would: real
// clicks, real typing, real focus/DOM-node identity checks.
//
// Why this is separate from the jsdom suites: jsdom is a very good DOM
// implementation but it is not a browser — it can't catch every class of
// rendering bug a browser's own layout/paint/focus engine would. This file
// exists specifically to close that gap for the highest-risk areas found
// during the audit. It is slower than the jsdom suites (real browser
// launch + real timers), so it's kept focused rather than exhaustive.
//
// Central case: the Products-search bug this audit started from — see
// summary. Root cause: renderPOSListOnly() (src/pos.js) used to target
// document.querySelector("#main .card"), which is NOT unique whenever
// shiftBlockBannerHtml()/dcMessagesBannerHtml() render their own ".card"
// elements above the results (e.g. before a shift has been started, which
// is every fresh install) — the FIRST ".card" in the DOM is the banner, not
// the results area, so typing into the search box overwrote the banner
// with filtered results while the real results card below silently kept
// its old, unfiltered list. Fixed by giving the results card a stable id
// (#posResultsArea), the same pattern every other list-search screen in
// this app already used.
"use strict";
const assert = require("assert");
const path = require("path");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping the real-browser audit suite.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

async function newSetUpPage(browser, distFile){
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err.message));
  const fileUrl = "file:///" + path.resolve(__dirname, "..", distFile).replace(/\\/g, "/");
  await page.goto(fileUrl);
  await page.waitForSelector("#setShop", { timeout: 15000 }); // sql.js WASM (CDN) + boot()
  await page.fill("#setShop", "Test Shop");
  await page.click("#setupNext");
  await page.click("#setupNext2");
  await page.click("#setupNext3");
  await page.click("#setupFinish");
  await page.waitForSelector("[data-route]");
  return { page, pageErrors };
}
async function addProduct(page, name, price, stock){
  await page.click("#openAddProduct");
  await page.waitForSelector("#pName");
  await page.fill("#pName", name);
  await page.fill("#pPrice", String(price));
  await page.fill("#pStock", String(stock));
  await page.click("#pConfirm");
  await page.waitForSelector(".modalOverlay", { state: "detached" });
}

(async()=>{
  const browser = await chromium.launch();

  // ================= the central bug, and its fixed state =================
  await t("Sell screen search never bleeds into another .card (shift-block banner) — the exact repro this audit started from", async ()=>{
    const { page, pageErrors } = await newSetUpPage(browser, "dist/index.html");
    await page.click('[data-route="products"]');
    await addProduct(page, "Toyota Vitz Front Bumper", 45, 3);
    await addProduct(page, "Toyota Vitz Rear Bumper", 40, 2);
    await addProduct(page, "Generic Widget", 5, 10);

    await page.click('[data-route="pos"]');
    // No shift started yet -> shiftBlockBannerHtml() renders its own
    // ".card" ABOVE the results card. This is the exact condition that
    // triggered the bug.
    await page.waitForSelector(".card");
    const bannerTextBefore = await page.textContent("#main");
    assert.ok(/Start a shift/.test(bannerTextBefore), "the shift-block banner is showing (precondition for the repro)");

    const search = await page.$("#searchInput");
    await search.click();
    for(const ch of "vitz bumper") await search.type(ch, { delay: 10 });
    await page.waitForTimeout(150);

    const mainHtml = await page.$eval("#main", el => el.outerHTML);
    assert.ok(/Start a shift/.test(mainHtml), "the banner's own text is still intact — not overwritten by search results");
    assert.strictEqual((mainHtml.match(/id="posResultsArea"/g)||[]).length, 1, "exactly one results container");
    const rowCount = await page.$$eval("#posResultsArea .product-row", els => els.length);
    assert.strictEqual(rowCount, 2, "both Vitz bumpers shown, and ONLY them — not the stale unfiltered 3-item list");
    assert.ok(!/Generic Widget/.test(await page.$eval("#posResultsArea", el=>el.textContent)), "the non-matching product is correctly excluded from the results area");

    assert.deepStrictEqual(pageErrors, [], "no JS errors while reproducing/verifying the fix");
    await page.close();
  });

  await t("typing in the Sell search box never loses focus, keystroke by keystroke, in a REAL browser (not just jsdom)", async ()=>{
    const { page } = await newSetUpPage(browser, "dist/index.html");
    await page.click('[data-route="products"]');
    await addProduct(page, "Rice 2kg", 10, 50);
    await page.click('[data-route="pos"]');
    await page.waitForSelector("#searchInput");

    const search = await page.$("#searchInput");
    await search.click();
    for(const ch of "rice"){
      await search.type(ch, { delay: 15 });
      const stillFocused = await page.evaluate(()=> document.activeElement && document.activeElement.id==="searchInput");
      assert.ok(stillFocused, `focus lost after typing "${ch}"`);
    }
    assert.strictEqual(await page.$eval("#searchInput", el=>el.value), "rice");
    await page.close();
  });

  // ================= previously-fixed focus patterns: confirm no regression =================
  await t("line-item discount input keeps focus while typing, in a REAL browser (mobile drawer)", async ()=>{
    const { page } = await newSetUpPage(browser, "dist/index.html");
    await page.click('[data-route="products"]');
    await addProduct(page, "Rice 2kg", 10, 50);
    await page.click('[data-route="pos"]');
    await page.click("[data-add]");
    await page.click("#cartBtn");
    await page.waitForSelector("[data-line-discount]");

    const discInput = await page.$("[data-line-discount]");
    await discInput.click();
    for(const ch of "3"){
      await discInput.type(ch, { delay: 15 });
      const stillFocused = await page.evaluate((el)=> document.activeElement===el, discInput);
      assert.ok(stillFocused, "discount input lost focus");
    }
    assert.strictEqual(await page.$eval("#drawerTotal", el=>el.textContent), "$7.00", "total reflects the typed discount (10 - 3)");
    await page.close();
  });

  await t("split-tender amount input keeps focus while typing, in a REAL browser", async ()=>{
    const { page } = await newSetUpPage(browser, "dist/index.html");
    await page.click('[data-route="products"]');
    await addProduct(page, "Rice 2kg", 10, 50);
    await page.click('[data-route="pos"]');
    await page.click("[data-add]");
    await page.click("#cartBtn");
    await page.waitForSelector("#startSplitTender");
    await page.click("#startSplitTender");
    await page.waitForSelector('[data-split-amount="0"]');

    const amountInput = await page.$('[data-split-amount="0"]');
    await amountInput.click();
    for(const ch of "7"){
      await amountInput.type(ch, { delay: 15 });
      const stillFocused = await page.evaluate((el)=> document.activeElement===el, amountInput);
      assert.ok(stillFocused, "split-tender amount input lost focus");
    }
    assert.strictEqual(await page.$eval("#splitRemaining", el=>el.textContent), "$3.00", "10 - 7");
    await page.close();
  });

  // ================= rapid interactions: no stale/duplicate DOM =================
  await t("rapid tab switching never leaves duplicate #main elements or accumulating DOM", async ()=>{
    const { page, pageErrors } = await newSetUpPage(browser, "dist/index.html");
    const tabs = ["pos","products","credit","reports","more"];
    for(let round=0; round<5; round++){
      for(const tab of tabs) await page.click(`[data-route="${tab}"]`);
    }
    await page.waitForTimeout(200);
    assert.strictEqual(await page.$$eval("#main", els=>els.length), 1);
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  await t("rapid Add Product modal open/cancel cycles never leak stacked modal overlays", async ()=>{
    const { page } = await newSetUpPage(browser, "dist/index.html");
    await page.click('[data-route="products"]');
    for(let i=0;i<5;i++){
      await page.click("#openAddProduct");
      await page.waitForSelector(".modalOverlay .close-x");
      await page.click(".modalOverlay .close-x");
      await page.waitForSelector(".modalOverlay", { state: "detached" });
    }
    assert.strictEqual(await page.$$eval(".modalOverlay", els=>els.length), 0);
    await page.close();
  });

  await t("rapid search type/clear cycles on the Products tab never duplicate #productsTableArea", async ()=>{
    const { page } = await newSetUpPage(browser, "dist/index.html");
    await page.click('[data-route="products"]');
    await addProduct(page, "Widget", 5, 10);
    for(let i=0;i<3;i++){
      await page.fill("#productsSearch", "widget");
      await page.fill("#productsSearch", "");
    }
    assert.strictEqual(await page.$$eval("#productsTableArea", els=>els.length), 1);
    await page.close();
  });

  // ================= Device Setup: Printer / Barcode Reader / Cash Drawer =================
  await t("Settings shows all three Device Setup entries as separate cards, and each opens its own screen without breaking the others", async ()=>{
    const { page, pageErrors } = await newSetUpPage(browser, "dist/index.html");
    await page.click('[data-route="more"]');
    await page.click('[data-kebab-toggle="moretab"]');
    await page.click('[data-tab="settings"]');
    await page.waitForSelector("#openPrinterSetup");
    assert.ok(await page.$("#openScannerSetup"), "Barcode Reader has its own entry, separate from Printer");
    assert.ok(await page.$("#openDrawerSetup"), "Cash Drawer has its own entry, separate from both");

    await page.click("#openPrinterSetup");
    await page.waitForSelector(".modalOverlay");
    let modalText = await page.textContent(".modalOverlay");
    assert.ok(/Not connected|Connected/.test(modalText), "Printer setup shows a connection status");
    await page.click(".modalOverlay .close-x");
    await page.waitForSelector(".modalOverlay", { state: "detached" });

    await page.click("#openScannerSetup");
    await page.waitForSelector(".modalOverlay");
    modalText = await page.textContent(".modalOverlay");
    assert.ok(/keyboard-wedge/.test(modalText));
    await page.click(".modalOverlay .close-x");
    await page.waitForSelector(".modalOverlay", { state: "detached" });

    // Cash Drawer: assert against whatever navigator.serial actually is in
    // THIS browser rather than assuming — real-browser support varies, and
    // the point of this test is that either way nothing throws or blocks.
    const serialSupported = await page.evaluate(()=> !!navigator.serial);
    await page.click("#openDrawerSetup");
    await page.waitForSelector(".modalOverlay");
    modalText = await page.textContent(".modalOverlay");
    if(serialSupported) assert.ok(/Connected|Not connected/.test(modalText));
    else assert.ok(/not supported in this build/i.test(modalText));
    await page.click(".modalOverlay .close-x");
    await page.waitForSelector(".modalOverlay", { state: "detached" });

    // The rest of Settings (a section further down the same page) still
    // rendered fine regardless of the Cash Drawer's support state.
    assert.ok(await page.$("#saveSecret"), "the rest of the Settings page rendered normally");
    assert.deepStrictEqual(pageErrors, [], "no JS errors opening/closing any of the three Device Setup screens");
    await page.close();
  });

  // ================= desktop build (dist-tauri) =================
  await t("desktop Sales screen search (dsSearch) keeps focus and filters correctly, in a REAL browser", async ()=>{
    const { page, pageErrors } = await newSetUpPage(browser, "dist-tauri/index.html");
    await page.click("#hamburgerBtn");
    await page.click('[data-route="products"]');
    await addProduct(page, "Toyota Vitz Front Bumper", 45, 3);
    await addProduct(page, "Generic Widget", 5, 10);
    await page.click("#hamburgerBtn");
    await page.click('[data-route="pos"]');
    await page.waitForSelector("#dsSearch");

    const dsSearch = await page.$("#dsSearch");
    await dsSearch.click();
    for(const ch of "vitz"){
      await dsSearch.type(ch, { delay: 15 });
      const stillFocused = await page.evaluate(()=> document.activeElement && document.activeElement.id==="dsSearch");
      assert.ok(stillFocused, `desktop search lost focus after "${ch}"`);
    }
    const rows = await page.$$eval("#dsRows tr", els=>els.length);
    assert.strictEqual(rows, 1, "only the matching product row shown");
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  // ================= Nav shell: hamburger drawer (dist-tauri) vs bottom bar (dist-pwa) =================
  await t("dist-tauri shows the hamburger + slide-in drawer (no bottom tab bar); drawer opens, navigates, and closes after navigating", async ()=>{
    const { page, pageErrors } = await newSetUpPage(browser, "dist-tauri/index.html");
    assert.ok(await page.$("#hamburgerBtn"), "hamburger button renders");
    assert.strictEqual(await page.$(".navbar"), null, "the bottom tab bar is NOT rendered on the desktop build");

    assert.strictEqual(await page.$eval("#navDrawer", el=>el.classList.contains("show")), false, "drawer starts closed");

    await page.click("#hamburgerBtn");
    await page.waitForSelector("#navDrawer.show");
    const items = await page.$$eval("#navDrawer [data-route]", els => els.map(e=>e.dataset.route));
    assert.deepStrictEqual(items, ["pos","products","credit","reports","more"], "same nav items, same order, driven from the shared list");

    await page.click('#navDrawer [data-route="products"]');
    await page.waitForSelector("#openAddProduct"); // Products screen actually loaded
    assert.strictEqual(await page.$eval("#navDrawer", el=>el.classList.contains("show")), false, "drawer closed itself after navigating");
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  await t("dist-pwa keeps the unchanged bottom tab bar (no hamburger), even in a wide browser window", async ()=>{
    const { page, pageErrors } = await newSetUpPage(browser, "dist-pwa/index.html");
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForSelector(".navbar");
    assert.strictEqual(await page.$("#hamburgerBtn"), null, "no hamburger on the phone/branch build, regardless of window width");
    const labels = await page.$$eval(".navbar [data-route]", els => els.map(e=>e.dataset.route));
    assert.deepStrictEqual(labels, ["pos","products","credit","reports","more"], "same shared nav list, rendered as the familiar bottom bar");
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  await t("resizing a Tauri window smaller does NOT bring back the bottom bar, and resizing dist-pwa wider does NOT show the hamburger drawer — nav shell is locked to build, not width", async ()=>{
    const tauri = await newSetUpPage(browser, "dist-tauri/index.html");
    await tauri.page.setViewportSize({ width: 375, height: 700 }); // phone-sized window
    assert.ok(await tauri.page.$("#hamburgerBtn"), "still the hamburger — narrowing the window never swaps it for the bottom bar");
    assert.strictEqual(await tauri.page.$(".navbar"), null);
    await tauri.page.close();

    const pwa = await newSetUpPage(browser, "dist-pwa/index.html");
    await pwa.page.setViewportSize({ width: 2000, height: 1100 }); // desktop-sized window
    assert.ok(await pwa.page.$(".navbar"), "still the bottom bar — widening the window never swaps it for the hamburger");
    assert.strictEqual(await pwa.page.$("#hamburgerBtn"), null);
    await pwa.page.close();
  });

  await browser.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
