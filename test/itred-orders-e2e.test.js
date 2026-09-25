// Run: node --no-warnings test/itred-orders-e2e.test.js
// (build first: node build.js --itred)
// iTred purchase orders — draft orders built from Market Space, and sending
// them — in a REAL browser (Playwright/Chromium) against
// dist-itred/index.html:
//   * "Add to order" on live listings; one draft per vendor, several
//     vendors' drafts side by side; no button for a vendor without a
//     WhatsApp number (the order can't reach them)
//   * #/orders: quantities, per-currency totals, remove, discard, custom
//     "please source this" requests, shop/customer text can't inject markup
//   * drafts survive a reload, follow another tab's changes, and still work
//     (with a warning) when the browser won't store them
//   * a listed item that's no longer live is flagged and can be kept as a
//     custom request
//   * sending needs a signed-in customer; "Sign in to send" comes back to
//     #/orders; nothing is written to Supabase while drafting
//   * Send: the order and its lines are saved (granted columns only; prices
//     from the database), then the Sales Order PDF is shared — or, where the
//     browser can't share files, downloaded with a WhatsApp chat link;
//     cancelled shares, a listing that expired meanwhile, a PDF tool that
//     won't load and a failed save each leave things consistent
//   * sent orders are listed from the account on any device, and "Send PDF"
//     makes and shares the PDF again
// Supabase is the in-test fake from test/itred-fake-supabase.js. jsPDF is
// fetched once from its pinned CDN URL and served to every page from memory.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createFakeSupabase, listingRow } = require("./itred-fake-supabase");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

const DIST = path.join(__dirname, "..", "dist-itred", "index.html");
if(!fs.existsSync(DIST)){ console.log("Missing dist-itred/index.html — run: node build.js --itred"); process.exit(1); }
const SITE = "file:///" + DIST.replace(/\\/g, "/");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

const BOKA = "11111111-1111-4111-8111-111111111111";
const BYO  = "22222222-2222-4222-8222-222222222222";
const MBARE = "33333333-3333-4333-8333-333333333333";
const bokaV = { business_name:"Boka General Dealer", whatsapp_number:"0771234567", city:"Harare" };
function catalogue(){
  return [
    listingRow({ id:"a0000000-0000-4000-8000-000000000001", vendor_id:BOKA, product_name:"Sugar 2kg", price:3.5, currency:"USD", stock_quantity:12, vendors:bokaV }),
    listingRow({ id:"a0000000-0000-4000-8000-000000000002", vendor_id:BOKA, product_name:"Cooking Oil 2L", price:4.25, currency:"USD", stock_quantity:5, vendors:bokaV }),
    listingRow({ id:"a0000000-0000-4000-8000-000000000003", vendor_id:BOKA, product_name:"Airtime bundle", price:20, currency:"ZWG", stock_quantity:100, vendors:bokaV }),
    listingRow({ id:"b0000000-0000-4000-8000-000000000001", vendor_id:BYO, product_name:"Cement 50kg", price:12, currency:"USD", stock_quantity:40,
      vendors:{ business_name:"Byo Hardware", whatsapp_number:"+263 78 000 1111", city:"Bulawayo" } }),
    listingRow({ id:"c0000000-0000-4000-8000-000000000001", vendor_id:MBARE, product_name:"Bread", price:1, currency:"USD", stock_quantity:3,
      vendors:{ business_name:"Mbare Bakery", whatsapp_number:null, city:"Harare" } }),
  ];
}

// The site's pinned jsPDF, fetched once for the whole run.
const JSPDF_URL = fs.readFileSync(DIST, "utf8").match(/const JSPDF_URL = '([^']+)'/)[1];
let jsPdfSource = null;
async function serveJsPdf(page, o){
  await page.route(JSPDF_URL, route=> (o && o.blockJsPdf && o.blockJsPdf())
    ? route.abort()
    : route.fulfill({ status:200, contentType:"application/javascript", headers:{ "Access-Control-Allow-Origin":"*" }, body:jsPdfSource }));
}

// Stands in for the phone's share sheet: records what was shared (the PDF
// as a binary string) and, per call, can act out a cancel or a block via
// window.__shareMode = ["AbortError", …].
function SHARE_STUB(){
  window.__shared = []; window.__shareMode = [];
  Object.defineProperty(navigator, "canShare", { configurable:true, value:(d)=> !!(d && d.files && d.files.length) });
  Object.defineProperty(navigator, "share", { configurable:true, value: async (d)=>{
    const f = d.files[0];
    const u8 = new Uint8Array(await f.arrayBuffer());
    let s = ""; for(const b of u8) s += String.fromCharCode(b);
    const mode = window.__shareMode.shift();
    window.__shared.push({ name:f.name, type:f.type, title:d.title, text:d.text, pdf:s, mode:mode||null });
    if(mode) throw new DOMException(mode, mode);
  }});
}
// A desktop browser that can't share files.
function NO_SHARE(){
  Object.defineProperty(navigator, "canShare", { configurable:true, value:undefined });
  Object.defineProperty(navigator, "share", { configurable:true, value:undefined });
}

async function open(browser, fake, hash, o){
  o = o || {};
  const context = o.context || await browser.newContext(Object.assign({ acceptDownloads:true }, o.ctxOpts||{}));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e=> errors.push(e.message));
  page.on("dialog", d=> d.accept());
  if(o.init) await page.addInitScript(o.init);
  await serveJsPdf(page, o);
  await fake.install(page);
  await page.goto(SITE + (hash||""));
  await page.waitForSelector(".page.active");
  return { context, page, errors };
}
// The Market Space card for a product, by name.
const card = (page, name)=> page.locator("#marketResults .product-card", { has: page.locator("h4", { hasText: name }) });
async function addFromMarket(page, name){
  await card(page, name).locator("[data-add-to-order]").click();
  await card(page, name).locator("[data-in-order]").waitFor();
}
const navCount = (page)=> page.textContent("#ordersNavCount");
const draftCard = (page, vendorId)=> page.locator('.po-card[data-vendor="'+vendorId+'"]');
async function draftLines(page, vendorId){
  return draftCard(page, vendorId).locator(".po-line").evaluateAll(els=> els.map(e=>({
    name: e.querySelector(".po-name").childNodes[0].textContent.trim(),
    text: e.textContent.replace(/\s+/g," ").trim(),
    qty: e.querySelector(".po-qty").value })));
}
const draftTotals = (page, vendorId)=> draftCard(page, vendorId).locator(".po-totals").evaluate(e=> e.textContent.replace(/\s+/g," ").trim());
function writes(fake){ return fake.log.filter(r=> r.method!=="GET" && r.path.startsWith("/rest/v1/")); }
async function signIn(page, fake, email){
  fake.addUser(email, "secret123", { confirmed:true, user_metadata:{ full_name:"Tariro M" } });
  await page.fill("#authEmail", email);
  await page.fill("#authPassword", "secret123");
  await page.click("#signInBtn");
}

// Signed in as Tariro (profile row created by the site), on #/account.
async function openSignedIn(browser, fake, o){
  if(!fake.users.has("tariro@example.com"))
    fake.addUser("tariro@example.com", "secret123", { confirmed:true, user_metadata:{ full_name:"Tariro M", phone:"0772000111" } });
  const r = await open(browser, fake, "#/account", o);
  await r.page.fill("#authEmail", "tariro@example.com");
  await r.page.fill("#authPassword", "secret123");
  await r.page.click("#signInBtn");
  await r.page.waitForSelector("#accountEmail");
  return r;
}
// Tariro's Boka draft: Sugar ×2, Cooking Oil ×1, a custom request ×3.
async function buildBokaDraft(page, customName){
  await page.goto(SITE + "#/market-space");
  await page.waitForSelector("#marketResults .product-card");
  await addFromMarket(page, "Sugar 2kg");
  await addFromMarket(page, "Cooking Oil 2L");
  await page.goto(SITE + "#/orders");
  await page.waitForSelector('[data-po-action="send"]:not([disabled])');
  const sugarQty = draftCard(page, BOKA).locator('.po-line[data-line="a0000000-0000-4000-8000-000000000001"] .po-qty');
  await sugarQty.fill("2"); await sugarQty.press("Tab");
  await page.fill('.po-card[data-vendor="'+BOKA+'"] .po-custom-name', customName || "Brown rice 10kg");
  await page.fill('.po-card[data-vendor="'+BOKA+'"] .po-custom-qty', "3");
  await page.press('.po-card[data-vendor="'+BOKA+'"] .po-custom-name', "Enter");
  await page.waitForFunction((v)=> document.querySelectorAll('.po-card[data-vendor="'+v+'"] .po-line').length === 3, BOKA);
}
const sendBoka = (page)=> draftCard(page, BOKA).locator('[data-po-action="send"]').click();
const sentCard = (page)=> page.locator(".po-sent").first();
const shared = (page)=> page.evaluate(()=> window.__shared);

(async()=>{
  jsPdfSource = await (await fetch(JSPDF_URL)).text();
  assert.ok(/jsPDF/.test(jsPdfSource), "couldn't fetch "+JSPDF_URL);
  const browser = await chromium.launch();

  await t("'Add to order' on Market Space starts one draft per vendor; no button for a vendor without WhatsApp", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/market-space");
    await page.waitForSelector("#marketResults .product-card");
    assert.strictEqual(await card(page, "Bread").locator("[data-add-to-order]").count(), 0, "Mbare Bakery has no WhatsApp number");
    assert.strictEqual(await navCount(page), "");

    await addFromMarket(page, "Sugar 2kg");
    assert.strictEqual(await navCount(page), "1");
    assert.match(await page.textContent("#orderToast"), /Added to your order with Boka General Dealer/);
    assert.strictEqual(await page.getAttribute("#orderToast a", "href"), "#/orders");
    await addFromMarket(page, "Cooking Oil 2L");
    assert.strictEqual(await navCount(page), "1", "same vendor, same draft");
    await addFromMarket(page, "Cement 50kg");
    assert.strictEqual(await navCount(page), "2", "a second vendor gets its own draft");
    // An item already in a draft links to it instead of adding again.
    assert.strictEqual(await card(page, "Sugar 2kg").locator("[data-in-order]").getAttribute("href"), "#/orders");

    // List view has the same buttons.
    await page.click("#viewListBtn");
    const listItem = page.locator("#marketResults .product-list-item", { has: page.locator("h4", { hasText:"Airtime bundle" }) });
    await listItem.locator("[data-add-to-order]").click();
    await listItem.locator("[data-in-order]").waitFor();

    await page.click("#ordersNavLink");
    await page.waitForSelector(".po-card");
    const vendors = await page.$$eval(".po-card h3", els=> els.map(e=>e.textContent));
    assert.deepStrictEqual(vendors.sort(), ["Boka General Dealer","Byo Hardware"]);
    assert.deepStrictEqual((await draftLines(page, BOKA)).map(l=>[l.name,l.qty]), [["Sugar 2kg","1"],["Cooking Oil 2L","1"],["Airtime bundle","1"]]);
    assert.deepStrictEqual((await draftLines(page, BYO)).map(l=>[l.name,l.qty]), [["Cement 50kg","1"]]);
    assert.match(await draftCard(page, BOKA).locator(".po-head").textContent(), /Harare\s*·\s*3 items/);
    assert.deepStrictEqual(writes(fake), [], "drafting writes nothing to Supabase");
    assert.deepStrictEqual(fake.unexpected, []);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("#/orders: quantities update line and per-currency totals; bad quantities snap back; remove and discard", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/market-space");
    await page.waitForSelector("#marketResults .product-card");
    for(const n of ["Sugar 2kg","Cooking Oil 2L","Airtime bundle","Cement 50kg"]) await addFromMarket(page, n);
    await page.goto(SITE + "#/orders");
    await page.waitForSelector(".po-card");
    assert.strictEqual(await draftTotals(page, BOKA), "Listed items: USD 7.75 + ZWG 20.00");

    const sugarQty = draftCard(page, BOKA).locator('.po-line[data-line="a0000000-0000-4000-8000-000000000001"] .po-qty');
    await sugarQty.fill("4"); await sugarQty.press("Tab");
    await page.waitForFunction(()=> /USD 18\.25/.test(document.querySelector('.po-card .po-totals').textContent));
    const sugar = (await draftLines(page, BOKA))[0];
    assert.match(sugar.text, /USD 3\.50 each/);
    assert.match(sugar.text, /USD 14\.00/);
    // Decimals are allowed (quantity_requested is numeric(12,3)).
    await sugarQty.fill("1.5"); await sugarQty.press("Tab");
    await page.waitForFunction(()=> /USD 9\.50/.test(document.querySelector('.po-card .po-totals').textContent));
    // Zero / empty / negative snap back to the last good quantity.
    for(const bad of ["0", "", "-2"]){
      await sugarQty.fill(bad); await sugarQty.press("Tab");
      await page.waitForFunction(()=> document.querySelector('.po-line .po-qty').value === "1.5");
    }
    // More than listed is allowed, with a note.
    const oilQty = draftCard(page, BOKA).locator('.po-line[data-line="a0000000-0000-4000-8000-000000000002"] .po-qty');
    await oilQty.fill("9"); await oilQty.press("Tab");
    await page.waitForFunction(()=> /Only 5 listed/.test(document.body.textContent));

    // Remove the ZWG line: the ZWG total goes with it.
    await draftCard(page, BOKA).locator('.po-line[data-line="a0000000-0000-4000-8000-000000000003"] .po-remove').click();
    await page.waitForFunction(()=> !/ZWG/.test(document.querySelector('.po-card .po-totals').textContent));
    assert.strictEqual((await draftLines(page, BOKA)).length, 2);

    // Removing the last line of a draft removes the draft.
    await draftCard(page, BYO).locator(".po-remove").click();
    await draftCard(page, BYO).waitFor({ state:"detached" });
    assert.strictEqual(await navCount(page), "1");

    // Discard (confirmed) removes the whole draft -> empty state.
    await draftCard(page, BOKA).locator('[data-po-action="discard"]').click();
    await page.waitForSelector("#ordersEmpty");
    assert.strictEqual(await navCount(page), "");
    assert.deepStrictEqual(await page.evaluate(()=> JSON.parse(localStorage.getItem("itred.draftOrders.v1")).drafts), {});
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(writes(fake), []);
    await context.close();
  });

  await t("custom requests: added per vendor, 'vendor to quote', empty names refused, markup shown as text", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/market-space");
    await page.waitForSelector("#marketResults .product-card");
    await addFromMarket(page, "Sugar 2kg");
    await page.goto(SITE + "#/orders");
    await page.waitForSelector(".po-card");
    const form = draftCard(page, BOKA).locator(".po-custom-form");
    // Empty name: nothing added.
    await form.locator("button").click();
    assert.strictEqual((await draftLines(page, BOKA)).length, 1);
    await form.locator(".po-custom-name").fill("Brown rice 10kg");
    await form.locator(".po-custom-qty").fill("3");
    await form.locator("button").click();
    await page.waitForFunction(()=> document.querySelectorAll(".po-line").length === 2);
    // The name box is cleared and focused for the next request.
    assert.strictEqual(await page.evaluate(()=> document.activeElement.classList.contains("po-custom-name") && document.activeElement.value), "");
    await page.fill(".po-custom-name", '<img src=x onerror="window.__xss=1">Maize <b>meal</b>');
    await page.press(".po-custom-name", "Enter");
    await page.waitForFunction(()=> document.querySelectorAll(".po-line").length === 3);
    const lines = await draftLines(page, BOKA);
    assert.deepStrictEqual(lines.map(l=>[l.name,l.qty]), [["Sugar 2kg","1"],["Brown rice 10kg","3"],['<img src=x onerror="window.__xss=1">Maize <b>meal</b>',"1"]]);
    assert.match(lines[1].text, /Custom request Vendor to quote/);
    assert.strictEqual(await page.evaluate(()=> window.__xss), undefined);
    assert.strictEqual(await page.locator(".po-line img").count(), 0);
    assert.strictEqual(await draftTotals(page, BOKA), "Listed items: USD 3.50 plus 2 custom requests for the vendor to quote");
    assert.strictEqual(await draftCard(page, BOKA).locator(".po-head .hint").textContent(), "Harare · 3 items");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("drafts survive a reload and follow changes made in another tab", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/market-space");
    await page.waitForSelector("#marketResults .product-card");
    await addFromMarket(page, "Sugar 2kg");
    await addFromMarket(page, "Cement 50kg");
    await page.reload();
    await page.waitForSelector("#marketResults [data-in-order]");
    assert.strictEqual(await navCount(page), "2");
    assert.strictEqual(await card(page, "Sugar 2kg").locator("[data-in-order]").count(), 1);

    // A second tab edits the Boka draft; the first tab picks it up.
    const other = await open(browser, fake, "#/orders", { context });
    await other.page.waitForSelector(".po-card");
    await draftCard(other.page, BYO).locator(".po-remove").click();
    await draftCard(other.page, BYO).waitFor({ state:"detached" });
    await page.waitForFunction(()=> document.getElementById("ordersNavCount").textContent === "1");
    await card(page, "Cement 50kg").locator("[data-add-to-order]").waitFor();
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(other.errors, []);
    await context.close();
  });

  await t("unreadable or hand-edited stored drafts don't break the page; bad lines are dropped", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const context = await browser.newContext();
    const seed = await context.newPage();
    await seed.goto(SITE);
    await seed.evaluate((BOKA)=>{
      localStorage.setItem("itred.draftOrders.v1", JSON.stringify({ v:1, drafts:{
        [BOKA]: { vendorId:BOKA, updatedAt:1, vendor:{ name:"Boka General Dealer", city:"Harare", whatsapp:"0771234567" }, lines:[
          { key:"a0000000-0000-4000-8000-000000000001", listingId:"a0000000-0000-4000-8000-000000000001", name:"Sugar 2kg", unitPrice:3.5, currency:"USD", qty:2, image:"javascript:alert(1)" },
          { key:"x", listingId:null, custom:true, name:"", qty:1 },
          { key:"y", listingId:null, custom:true, name:"Rice", qty:-1 },
          "junk",
        ]},
        "empty-vendor": { vendorId:"empty-vendor", vendor:{}, lines:[] },
        "broken": "nope",
      }}));
    }, BOKA);
    await seed.close();
    const { page, errors } = await open(browser, fake, "#/orders", { context });
    await page.waitForSelector(".po-card");
    assert.strictEqual(await page.locator(".po-card").count(), 1);
    assert.deepStrictEqual((await draftLines(page, BOKA)).map(l=>[l.name,l.qty]), [["Sugar 2kg","2"]]);
    // Not even JSON:
    await page.evaluate(()=> localStorage.setItem("itred.draftOrders.v1", "{not json"));
    await page.reload();
    await page.waitForSelector("#ordersEmpty");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("when the browser won't store drafts they still work for this visit, with a warning", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/market-space", { init: ()=>{
      Storage.prototype.setItem = function(){ throw new DOMException("blocked", "QuotaExceededError"); };
    }});
    await page.waitForSelector("#marketResults .product-card");
    await addFromMarket(page, "Sugar 2kg");
    await page.click("#ordersNavLink");
    await page.waitForSelector(".po-card");
    assert.match(await page.textContent("#draftsNotSaved"), /lost if you close or reload/);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a listed item that's no longer live is flagged, blocks nothing while drafting, and can be kept as a custom request", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/market-space");
    await page.waitForSelector("#marketResults .product-card");
    await addFromMarket(page, "Sugar 2kg");
    await addFromMarket(page, "Cooking Oil 2L");
    // The oil listing expires; the price of sugar changes.
    fake.listings.find(l=> l.product_name==="Cooking Oil 2L").expires_at = new Date(Date.now()-1000).toISOString();
    fake.listings.find(l=> l.product_name==="Sugar 2kg").price = 3.75;
    await page.goto(SITE + "#/orders");
    await page.reload();
    await page.waitForSelector(".po-warn");
    let lines = await draftLines(page, BOKA);
    assert.match(lines[0].text, /USD 3\.75 each/, "the live price is shown");
    assert.match(lines[1].text, /No longer listed/);
    assert.match(lines[1].text, /— each/, "no price for a delisted item");
    assert.strictEqual(await draftTotals(page, BOKA), "Listed items: USD 3.75", "sugar at the live price; the delisted oil isn't counted");
    await page.click('[data-po-action="to-custom"]');
    await page.waitForFunction(()=> !document.querySelector(".po-warn"));
    lines = await draftLines(page, BOKA);
    assert.deepStrictEqual(lines.map(l=>l.name), ["Sugar 2kg","Cooking Oil 2L"]);
    assert.match(lines[1].text, /Custom request Vendor to quote/);
    assert.strictEqual(await draftTotals(page, BOKA), "Listed items: USD 3.75 plus 1 custom request for the vendor to quote");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("sending needs an account: 'Sign in to send' returns to #/orders once signed in", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/market-space");
    await page.waitForSelector("#marketResults .product-card");
    await addFromMarket(page, "Sugar 2kg");
    await page.click("#ordersNavLink");
    await page.waitForSelector(".po-card");
    assert.strictEqual(await page.locator('[data-po-action="send"]').count(), 0);
    await page.click("[data-po-signin]");
    await page.waitForSelector("#signInForm");
    await signIn(page, fake, "tariro@example.com");
    await page.waitForFunction(()=> location.hash === "#/orders" && document.querySelector('[data-po-action="send"]'));
    assert.strictEqual(await page.locator("[data-po-signin]").count(), 0);
    // Only the account's own profile has been written — no order yet.
    assert.deepStrictEqual(writes(fake).map(r=> r.method+" "+r.path), ["POST /rest/v1/customers"]);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("#/orders at phone width: no sideways scrolling, controls reachable", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/market-space", { ctxOpts:{ viewport:{ width:360, height:780 } } });
    await page.waitForSelector("#marketResults .product-card");
    await addFromMarket(page, "Sugar 2kg");
    await page.goto(SITE + "#/orders");
    await page.waitForSelector(".po-card");
    await page.fill(".po-custom-name", "A very long custom request name that goes on and on without stopping anywhere");
    await page.press(".po-custom-name", "Enter");
    await page.waitForFunction(()=> document.querySelectorAll(".po-line").length === 2);
    assert.strictEqual(await page.evaluate(()=> document.documentElement.scrollWidth <= window.innerWidth), true, "page scrolls sideways");
    for(const sel of [".po-qty", ".po-remove", ".po-custom-name", "[data-po-signin]"]){
      const box = await page.locator(sel).first().boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 360, sel+" off-screen: "+JSON.stringify(box));
    }
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  // ================= Sending =================
  await t("Send saves the order (granted columns only, database prices), shares the Sales Order PDF, and the draft becomes a sent order", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB });
    await buildBokaDraft(page, "Maize (white) 10kg ✓");
    // Another vendor's draft is left alone.
    await page.goto(SITE + "#/market-space");
    await addFromMarket(page, "Cement 50kg");
    await page.goto(SITE + "#/orders");
    await page.waitForSelector('[data-po-action="send"]:not([disabled])');
    // The price changes after the draft was built: the database's wins.
    fake.listings.find(l=> l.product_name==="Sugar 2kg").price = 3.75;
    await sendBoka(page);
    await sentCard(page).locator(".po-note.ok").waitFor();

    const [poReq] = fake.requests("/rest/v1/purchase_orders", "POST");
    const user = [...fake.users.values()][0];
    assert.deepStrictEqual(poReq.body, { customer_id:user.id, vendor_id:BOKA });
    const [itemsReq] = fake.requests("/rest/v1/purchase_order_items", "POST");
    const po = fake.orders[0];
    assert.deepStrictEqual(itemsReq.body, [
      { purchase_order_id:po.id, vendor_listing_id:"a0000000-0000-4000-8000-000000000001", item_name:"Sugar 2kg", quantity_requested:2, is_custom_request:false },
      { purchase_order_id:po.id, vendor_listing_id:"a0000000-0000-4000-8000-000000000002", item_name:"Cooking Oil 2L", quantity_requested:1, is_custom_request:false },
      { purchase_order_id:po.id, vendor_listing_id:null, item_name:"Maize (white) 10kg ✓", quantity_requested:3, is_custom_request:true },
    ]);
    assert.strictEqual(po.status, "sent");
    assert.strictEqual(fake.requests("/rest/v1/purchase_orders", "PATCH").length, 0);

    const ref = "PO-" + po.id.replace(/-/g,"").slice(0,8).toUpperCase();
    const s = await shared(page);
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].name, "Sales-Order-"+ref+".pdf");
    assert.strictEqual(s[0].type, "application/pdf");
    assert.strictEqual(s[0].title, "Sales Order "+ref);
    assert.match(s[0].text, new RegExp("^Hello Boka General Dealer, this is Tariro M\\. Here is my Sales Order "+ref+" from iTred Market Place \\(3 items\\)"));
    const pdf = s[0].pdf;
    assert.ok(pdf.startsWith("%PDF-"), "not a PDF");
    for(const txt of ["SALES ORDER", ref, "TO (VENDOR)", "Boka General Dealer", "Harare", "WhatsApp: 0771234567",
      "FROM (CUSTOMER)", "Tariro M", "Phone: 0772000111", "tariro@example.com",
      "LISTED ITEMS", "Sugar 2kg", "USD 3.75", "USD 7.50", "Cooking Oil 2L", "USD 4.25", "USD 11.75",
      "PLEASE SOURCE AND QUOTE", "To quote", "Page 1 of 1"]){
      const esc = txt.replace(/[()\\]/g, m=> "\\"+m); // PDF string escaping
      assert.ok(pdf.includes("("+esc+")") || pdf.includes(esc), "PDF is missing "+JSON.stringify(txt));
    }
    assert.ok(pdf.includes("(Maize \\(white\\) 10kg ?)"), "custom text: brackets escaped, the tick (not in the PDF font) printed as ?");
    assert.ok(!pdf.includes("3.50"), "the page's stale price isn't used");

    // The draft is gone, the other one stays, and the sent order shows up.
    assert.strictEqual(await navCount(page), "1");
    assert.strictEqual(await draftCard(page, BOKA).count(), 0);
    assert.strictEqual(await draftCard(page, BYO).count(), 1);
    const stored = await page.evaluate(()=> Object.keys(JSON.parse(localStorage.getItem("itred.draftOrders.v1")).drafts));
    assert.deepStrictEqual(stored, [BYO]);
    const cardText = (await sentCard(page).textContent()).replace(/\s+/g," ");
    assert.match(cardText, new RegExp(ref+" · 3 items · Harare"));
    assert.match(cardText, /Boka General Dealer/);
    assert.match(cardText, /Listed items: USD 11\.75 plus 1 item for the vendor to quote/);
    assert.match(await sentCard(page).locator(".po-note").textContent(), /Shared\. If you picked WhatsApp, check it went to Boka General Dealer \(0771234567\)/);
    assert.strictEqual(await sentCard(page).locator(".po-status").textContent(), "Sent");
    const chat = await sentCard(page).locator("[data-order-chat]").getAttribute("href");
    assert.match(chat, /^https:\/\/wa\.me\/263771234567\?text=/);
    assert.match(decodeURIComponent(chat.split("text=")[1]), new RegExp(ref+".*attaching the PDF here"));
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(fake.unexpected, []);
    await context.close();
  });

  await t("sent orders come from the account on any device; Send PDF makes and shares it again", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const first = await openSignedIn(browser, fake, { init: SHARE_STUB });
    await buildBokaDraft(first.page);
    await sendBoka(first.page);
    await sentCard(first.page).locator(".po-note.ok").waitFor();
    const firstPdf = (await shared(first.page))[0];
    await first.context.close();

    // A fresh browser: no drafts, nothing cached — just the account.
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB });
    await page.goto(SITE + "#/orders");
    await sentCard(page).waitFor();
    const get = fake.requests("/rest/v1/purchase_orders", "GET").pop();
    const q = new URLSearchParams(get.query);
    assert.strictEqual(q.get("customer_id"), "eq."+[...fake.users.values()][0].id);
    assert.match(q.get("select"), /vendors\(business_name,\s*whatsapp_number,\s*city\)/);
    assert.match(q.get("select"), /purchase_order_items\(/);
    assert.strictEqual(q.get("order"), "created_at.desc");
    assert.strictEqual(await page.locator("#ordersEmpty").count(), 0);
    await sentCard(page).locator("summary").click();
    const lines = await sentCard(page).locator(".po-sent-line").evaluateAll(els=> els.map(e=> e.textContent.replace(/\s+/g," ").trim()));
    assert.deepStrictEqual(lines, ["Cooking Oil 2L × 1 USD 4.25", "Sugar 2kg × 2 USD 7.00", "Brown rice 10kg × 3 To quote"]);

    await sentCard(page).locator('[data-order-action="share"]').click();
    await sentCard(page).locator(".po-note.ok").waitFor();
    const again = (await shared(page))[0];
    assert.strictEqual(again.name, firstPdf.name);
    for(const txt of ["Sugar 2kg", "Cooking Oil 2L", "Brown rice 10kg", "USD 11.25", "Tariro M"]) assert.ok(again.pdf.includes(txt), "missing "+txt);
    assert.strictEqual(fake.requests("/rest/v1/purchase_orders", "POST").length, 1, "Send PDF doesn't create another order");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("signed out, #/orders never asks Supabase for orders and points to sign in", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/orders");
    await page.waitForSelector("#sentSignInHint");
    assert.strictEqual(fake.requests("/rest/v1/purchase_orders").length, 0);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a cancelled share keeps the order saved and says it's not sent yet; Send PDF tries again", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB });
    await buildBokaDraft(page);
    await page.evaluate(()=>{ window.__shareMode = ["AbortError"]; });
    await sendBoka(page);
    await sentCard(page).locator(".po-note").waitFor();
    await page.waitForFunction(()=> /Not sent yet/.test(document.querySelector(".po-sent .po-note").textContent));
    assert.strictEqual(fake.orders.length, 1);
    assert.strictEqual(fake.items.length, 3);
    assert.strictEqual(await draftCard(page, BOKA).count(), 0);
    await sentCard(page).locator('[data-order-action="share"]').click();
    await sentCard(page).locator(".po-note.ok").waitFor();
    assert.strictEqual((await shared(page)).length, 2);
    assert.strictEqual(fake.orders.length, 1);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a share blocked because the tap was too long ago asks for another tap", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB });
    await buildBokaDraft(page);
    await page.evaluate(()=>{ window.__shareMode = ["NotAllowedError"]; });
    await sendBoka(page);
    await page.waitForFunction(()=> { const n = document.querySelector(".po-sent .po-note"); return n && /Tap Send PDF to share it/.test(n.textContent); });
    await sentCard(page).locator('[data-order-action="share"]').click();
    await sentCard(page).locator(".po-note.ok").waitFor();
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("where the browser can't share files, the PDF is downloaded and the WhatsApp chat is one tap away", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake, { init: NO_SHARE });
    await buildBokaDraft(page);
    const [download] = await Promise.all([ page.waitForEvent("download"), sendBoka(page) ]);
    const ref = "PO-" + fake.orders[0].id.replace(/-/g,"").slice(0,8).toUpperCase();
    assert.strictEqual(download.suggestedFilename(), "Sales-Order-"+ref+".pdf");
    const bytes = fs.readFileSync(await download.path()).toString("latin1");
    assert.ok(bytes.startsWith("%PDF-") && bytes.includes("(Sugar 2kg)"));
    await page.waitForFunction(()=> { const n = document.querySelector(".po-sent .po-note"); return n && /has been downloaded/.test(n.textContent); });
    assert.match(await sentCard(page).locator(".po-note").textContent(), /Tap Open WhatsApp chat, then attach it/);
    assert.match(await sentCard(page).locator("[data-order-chat]").getAttribute("href"), /^https:\/\/wa\.me\/263771234567\?text=/);
    assert.strictEqual(await sentCard(page).locator("[data-order-chat]").getAttribute("target"), "_blank");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a listing that expired after the page loaded: no lines saved, the empty order closed, the item flagged, the draft kept", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB });
    await buildBokaDraft(page);
    fake.listings.find(l=> l.product_name==="Cooking Oil 2L").expires_at = new Date(Date.now()-1000).toISOString();
    await sendBoka(page);
    await draftCard(page, BOKA).locator(".po-error").waitFor();
    assert.match(await draftCard(page, BOKA).locator(".po-error").textContent(), /an item in it is no longer listed/);
    assert.strictEqual(fake.items.length, 0);
    assert.strictEqual(fake.orders.length, 1);
    assert.strictEqual(fake.orders[0].status, "closed");
    assert.deepStrictEqual(fake.requests("/rest/v1/purchase_orders", "PATCH")[0].body, { status:"closed" });
    await draftCard(page, BOKA).locator(".po-warn").waitFor(); // listings re-checked
    assert.strictEqual(await draftCard(page, BOKA).locator('[data-po-action="send"]').isDisabled(), true);
    assert.deepStrictEqual(await shared(page), []);
    assert.strictEqual(await page.locator(".po-sent").count(), 0);
    // Fix it and send again: a new order goes through; the closed empty one stays hidden.
    await page.click('[data-po-action="to-custom"]');
    await page.waitForSelector('[data-po-action="send"]:not([disabled])');
    await sendBoka(page);
    await sentCard(page).locator(".po-note.ok").waitFor();
    assert.strictEqual(fake.orders.length, 2);
    await page.reload();
    await sentCard(page).waitFor();
    assert.strictEqual(await page.locator(".po-sent").count(), 1);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("if the PDF tool can't load, nothing is recorded; once it can, sending works", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    let block = true;
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB, blockJsPdf: ()=> block });
    await buildBokaDraft(page);
    await sendBoka(page);
    await draftCard(page, BOKA).locator(".po-error").waitFor();
    assert.match(await draftCard(page, BOKA).locator(".po-error").textContent(), /PDF tool couldn't load.*Nothing was sent/);
    assert.strictEqual(fake.requests("/rest/v1/purchase_orders", "POST").length, 0);
    block = false;
    await sendBoka(page);
    await sentCard(page).locator(".po-note.ok").waitFor();
    assert.strictEqual(fake.orders.length, 1);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("if the order can't be saved, nothing is sent and the draft stays", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB });
    await buildBokaDraft(page);
    fake.failNextOrderInsert = { status:503, body:{ message:"Service unavailable" } };
    await sendBoka(page);
    await draftCard(page, BOKA).locator(".po-error").waitFor();
    assert.match(await draftCard(page, BOKA).locator(".po-error").textContent(), /couldn't be saved \(Service unavailable\)\. Nothing was sent/);
    assert.strictEqual(fake.requests("/rest/v1/purchase_order_items", "POST").length, 0);
    assert.deepStrictEqual(await shared(page), []);
    assert.strictEqual((await draftLines(page, BOKA)).length, 3);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a long order runs onto more pages, numbered", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB });
    await page.evaluate((BOKA)=>{
      const lines = [{ key:"a0000000-0000-4000-8000-000000000001", listingId:"a0000000-0000-4000-8000-000000000001", name:"Sugar 2kg", unitPrice:3.5, currency:"USD", qty:1, image:"" }];
      for(let i = 1; i <= 45; i++) lines.push({ key:"c-"+i, listingId:null, custom:true, name:"Special order item number "+i+" with a fairly long description to wrap", qty:i });
      localStorage.setItem("itred.draftOrders.v1", JSON.stringify({ v:1, drafts:{ [BOKA]:{ vendorId:BOKA, updatedAt:1,
        vendor:{ name:"Boka General Dealer", city:"Harare", whatsapp:"0771234567" }, lines } } }));
    }, BOKA);
    await page.goto(SITE + "#/orders");
    await page.reload();
    await page.waitForSelector('[data-po-action="send"]:not([disabled])');
    await sendBoka(page);
    await sentCard(page).locator(".po-note.ok").waitFor();
    const pdf = (await shared(page))[0].pdf;
    const pages = Number((pdf.match(/Page 1 of (\d+)/)||[])[1]);
    assert.ok(pages >= 2, "expected several pages, got "+pages);
    assert.ok(pdf.includes("(Page "+pages+" of "+pages+")"));
    assert.ok(pdf.includes("number 45"));
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a sent order at phone width: no sideways scrolling", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB, ctxOpts:{ viewport:{ width:360, height:780 } } });
    await buildBokaDraft(page);
    await sendBoka(page);
    await sentCard(page).locator(".po-note.ok").waitFor();
    await sentCard(page).locator("summary").click();
    assert.strictEqual(await page.evaluate(()=> document.documentElement.scrollWidth <= window.innerWidth), true);
    for(const sel of ['[data-order-action="share"]', "[data-order-chat]"]){
      const box = await sentCard(page).locator(sel).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 360, sel+" off-screen: "+JSON.stringify(box));
    }
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed?1:0);
})();
