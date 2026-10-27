// Run: node --no-warnings test/itred-orders-e2e.test.js
// (build first: node build.js --itred)
// iTred orders in a REAL browser (Playwright/Chromium) against
// dist-itred/index.html (docs/itred/itred-upgrade-design.md E6):
//   * "Add" on live listings; one draft per vendor, several vendors' drafts
//     side by side; no Add for a vendor without a WhatsApp number
//   * Your Orders: quantities, per-currency totals, remove, discard, custom
//     "please source this" requests, shop/customer text can't inject markup
//   * drafts survive a reload, follow another tab's changes, and still work
//     (with a warning) when the browser won't store them
//   * a listed item that's no longer live is flagged and can be kept as a
//     custom request; sending needs a signed-in customer
//   * Send saves the order and its lines (granted columns only; prices from
//     the database); no share sheet. Each sent order has Download PDF
//     (iTred-Order-<ref>-<vendor>.pdf, a normal download, with each line's
//     status), Share (WhatsApp with a short summary, no phone or email) and
//     Message (one thread per order with the vendor)
//   * the vendor's tills set what was fulfilled (the fake's vendorSetLine);
//     the customer confirms or reports a problem per answered line; the
//     customer can no longer record delivery
//   * offline: the device copy of the account's orders, and the PDF
// Supabase is the in-test fake from test/itred-fake-supabase.js. jsPDF is
// the copy the site serves itself (dist-itred/jspdf-4.2.1.umd.min.js).
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createFakeSupabase, listingRow, PROJECT } = require("./itred-fake-supabase");

let chromium;
require("./local-cdn");   // the cdnjs files from test/cdn/, not the internet
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

// Makes the site's jsPDF fail to load while window.__blockJsPdf is true.
function BLOCK_JSPDF(){
  window.__blockJsPdf = true;
  const orig = HTMLHeadElement.prototype.appendChild;
  HTMLHeadElement.prototype.appendChild = function(el){
    if(window.__blockJsPdf && el.tagName === "SCRIPT" && /jspdf/.test(el.src)){ setTimeout(()=> el.onerror && el.onerror(new Event("error")), 0); return el; }
    return orig.call(this, el);
  };
}

// Stands in for the phone's share sheet: records anything shared, so a test
// can prove nothing is (Send and Download PDF never open it).
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
  page.on("dialog", d=> d.type() === "prompt" ? d.accept(page.__prompt || "") : d.accept());
  if(o.init) await page.addInitScript(o.init);
  await fake.install(page);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(SITE + (hash||""));
  await page.waitForSelector(".page.active");
  return { context, page, errors };
}
// The market row for a product, by name.
const card = (page, name)=> page.locator("#marketList .lrow", { has: page.locator(".n", { hasText: name }) });
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
  await page.goto(SITE + "#/");
  await page.waitForSelector("#marketList .lrow");
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
const sentCard = (page)=> page.locator(".oc").first();
const refOf = (order)=> "PO-" + order.id.replace(/-/g,"").slice(0,8).toUpperCase();
let browser;
// An order already sent from Tariro's account to Boka: Sugar ×2, Oil ×1,
// and a custom request ×3 — seeded straight into the fake, as if sent on
// another visit — opened on Your Orders.
async function openWithSentOrder(o){
  o = o || {};
  const fake = createFakeSupabase({ listings: catalogue() });
  const r = await openSignedIn(browser, fake, o);
  const uid = fake.users.get("tariro@example.com").id;
  const order = { id:"9f000000-0000-4000-8000-000000000001", customer_id:uid, vendor_id:BOKA, status:o.status||"sent", pdf_url:null, completed_at:null, created_at:new Date().toISOString() };
  fake.orders.push(order);
  const line = (id, name, qty, custom, listing, price)=>({ id, purchase_order_id:order.id, vendor_listing_id: custom? null : listing, item_name:name,
    unit_price: custom? null : price, currency: custom? null : "USD", quantity_requested:qty, quantity_fulfilled:0, is_custom_request:custom,
    fulfillment_status:"outstanding", created_at:order.created_at, vendor_note:null, vendor_updated_at:null, customer_confirmed_at:null, customer_dispute:null });
  fake.items.push(line("9f100000-0000-4000-8000-000000000001", "Sugar 2kg", 2, false, "a0000000-0000-4000-8000-000000000001", 3.5),
                  line("9f100000-0000-4000-8000-000000000002", "Cooking Oil 2L", 1, false, "a0000000-0000-4000-8000-000000000002", 4.25),
                  line("9f100000-0000-4000-8000-000000000003", "Brown rice 10kg", 3, true));
  await r.page.goto(SITE + "#/orders");
  await sentCard(r.page).waitFor();
  return Object.assign(r, { fake, order });
}
const shared = (page)=> page.evaluate(()=> window.__shared);

(async()=>{
  browser = await chromium.launch();

  await t("'Add' on the market starts one draft per vendor; no button for a vendor without WhatsApp", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/");
    await page.waitForSelector("#marketList .lrow");
    assert.strictEqual(await card(page, "Bread").locator("[data-add-to-order]").count(), 0, "Mbare Bakery has no WhatsApp number");
    assert.strictEqual(await navCount(page), "");

    await addFromMarket(page, "Sugar 2kg");
    assert.strictEqual(await navCount(page), "1");
    assert.match(await page.textContent("#orderToast"), /Added to your order with Boka General Dealer/);
    assert.strictEqual(await page.getAttribute("#orderToast a", "href"), "/orders");
    await addFromMarket(page, "Cooking Oil 2L");
    assert.strictEqual(await navCount(page), "1", "same vendor, same draft");
    await addFromMarket(page, "Cement 50kg");
    assert.strictEqual(await navCount(page), "2", "a second vendor gets its own draft");
    // An item already in a draft links to it instead of adding again.
    assert.strictEqual(await card(page, "Sugar 2kg").locator("[data-in-order]").getAttribute("href"), "/orders");

    // Text only has the same buttons.
    await page.click("#viewText");
    const listItem = page.locator("#marketList .lrow.text", { has: page.locator(".n", { hasText:"Airtime bundle" }) });
    await listItem.locator("[data-add-to-order]").click();
    await listItem.locator("[data-in-order]").waitFor();

    await page.click('#topLinks a[href="/orders"]');
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

  await t("Your Orders: quantities update line and per-currency totals; bad quantities snap back; remove and discard", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/");
    await page.waitForSelector("#marketList .lrow");
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
    const { context, page, errors } = await open(browser, fake, "#/");
    await page.waitForSelector("#marketList .lrow");
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
    const { context, page, errors } = await open(browser, fake, "#/");
    await page.waitForSelector("#marketList .lrow");
    await addFromMarket(page, "Sugar 2kg");
    await addFromMarket(page, "Cement 50kg");
    await page.reload();
    await page.waitForSelector("#marketList [data-in-order]");
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
    const { context, page, errors } = await open(browser, fake, "#/", { init: ()=>{
      Storage.prototype.setItem = function(){ throw new DOMException("blocked", "QuotaExceededError"); };
    }});
    await page.waitForSelector("#marketList .lrow");
    await addFromMarket(page, "Sugar 2kg");
    await page.click('#topLinks a[href="/orders"]');
    await page.waitForSelector(".po-card");
    assert.match(await page.textContent("#draftsNotSaved"), /lost if you close or reload/);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a listed item that's no longer live is flagged, blocks nothing while drafting, and can be kept as a custom request", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/");
    await page.waitForSelector("#marketList .lrow");
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

  await t("sending needs an account: 'Sign in to send' returns to Your Orders once signed in", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/");
    await page.waitForSelector("#marketList .lrow");
    await addFromMarket(page, "Sugar 2kg");
    await page.click('#topLinks a[href="/orders"]');
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

  await t("Your Orders at phone width: no sideways scrolling, controls reachable", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/", { ctxOpts:{ viewport:{ width:360, height:780 } } });
    await page.waitForSelector("#marketList .lrow");
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
  await t("Send saves the order (granted columns only, database prices); the draft becomes a sent order with PDF, Share and Message; no share sheet", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB });
    await buildBokaDraft(page, "Maize (white) 10kg ✓");
    // Another vendor's draft is left alone.
    await page.goto(SITE + "#/");
    await addFromMarket(page, "Cement 50kg");
    await page.goto(SITE + "#/orders");
    await page.waitForSelector('[data-po-action="send"]:not([disabled])');
    assert.match(await draftCard(page, BOKA).locator(".po-send .hint").textContent(), /The vendor sees your name and phone number\./);
    // The price changes after the draft was built: the database's wins.
    fake.listings.find(l=> l.product_name==="Sugar 2kg").price = 3.75;
    await sendBoka(page);
    await sentCard(page).locator(".note.ok").waitFor();

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
    assert.deepStrictEqual(await shared(page), [], "no share sheet opens on Send");

    // The draft is gone, the other one stays, and the sent order shows up.
    assert.strictEqual(await draftCard(page, BOKA).count(), 0);
    assert.strictEqual(await draftCard(page, BYO).count(), 1);
    const stored = await page.evaluate(()=> Object.keys(JSON.parse(localStorage.getItem("itred.draftOrders.v1")).drafts));
    assert.deepStrictEqual(stored, [BYO]);
    const ref = refOf(po);
    const cardText = (await sentCard(page).innerText()).replace(/\s+/g," ");
    // decision 9: the order number has its own Copy button (no page text selection)
    assert.match(cardText, new RegExp("Boka General Dealer " + ref + " Copy · \\d+ \\w+ \\d{4} · Harare"));
    assert.strictEqual(await sentCard(page).locator(".copy-ref").getAttribute("data-copy"), ref);
    assert.match(cardText, /Total USD 11\.75/);
    assert.match(cardText, /\+ 1 to quote/);
    assert.match(await sentCard(page).locator(".note").textContent(), /Sent to Boka General Dealer\. Their shop sees it in Orders Fulfillment/);
    assert.strictEqual((await sentCard(page).locator(".oh .chip").textContent()).trim(), "Sent");
    assert.deepStrictEqual(await sentCard(page).locator(".ol .chip").allTextContents(), ["Outstanding", "Outstanding", "Outstanding"]);
    for(const sel of ['[data-order-action="pdf"]', "[data-order-share]", '[data-order-action="thread"]'])
      assert.strictEqual(await sentCard(page).locator(sel).count(), 1, sel);
    assert.strictEqual(await sentCard(page).locator("input").count(), 0, "the customer can't type a fulfilled quantity");
    assert.ok(!/Record delivery/.test(await page.textContent("body")));
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(fake.unexpected, []);
    await context.close();
  });

  await t("Download PDF: a normal download named iTred-Order-<ref>-<vendor>.pdf, with each line's status", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake, { init: SHARE_STUB });
    await buildBokaDraft(page, "Maize (white) 10kg ✓");
    await sendBoka(page);
    await sentCard(page).locator(".note.ok").waitFor();
    fake.vendorSetLine(fake.items.find(i=> i.item_name==="Sugar 2kg").id, 1, "1 more on Friday");
    await page.reload();
    await sentCard(page).waitFor();
    const [download] = await Promise.all([ page.waitForEvent("download"), sentCard(page).locator('[data-order-action="pdf"]').click() ]);
    const ref = refOf(fake.orders[0]);
    assert.strictEqual(download.suggestedFilename(), "iTred-Order-" + ref + "-Boka-General-Dealer.pdf");
    const pdf = fs.readFileSync(await download.path()).toString("latin1");
    assert.ok(pdf.startsWith("%PDF-"), "not a PDF");
    for(const txt of ["iTred Market Place", "ORDER", ref, "Partly fulfilled", "TO (VENDOR)", "Boka General Dealer", "Harare", "WhatsApp: 0771234567",
      "FROM (CUSTOMER)", "Tariro M", "Phone: 0772000111", "tariro@example.com",
      "LISTED ITEMS", "Sugar 2kg", "1 of 2 fulfilled - 1 more on Friday", "Cooking Oil 2L", "Outstanding", "USD 3.50", "USD 11.25",
      "PLEASE SOURCE AND QUOTE", "To quote", "Page 1 of 1"]){
      const esc = txt.replace(/[()\\]/g, m=> "\\"+m); // PDF string escaping
      assert.ok(pdf.includes("("+esc+")") || pdf.includes(esc), "PDF is missing "+JSON.stringify(txt));
    }
    assert.ok(pdf.includes("(Maize \\(white\\) 10kg ?)"), "custom text: brackets escaped, the tick (not in the PDF font) printed as ?");
    assert.match(await sentCard(page).locator(".note").textContent(), new RegExp("Downloaded iTred-Order-" + ref));
    assert.deepStrictEqual(await shared(page), [], "a download, never the share sheet");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("Share: WhatsApp to the vendor with the order summary (lines, status, total), no phone or email", async ()=>{
    const { context, page, errors, fake, order } = await openWithSentOrder();
    fake.vendorSetLine("9f100000-0000-4000-8000-000000000001", 2);
    fake.vendorSetLine("9f100000-0000-4000-8000-000000000003", 1);
    await page.reload(); await sentCard(page).waitFor();
    const href = await sentCard(page).locator("[data-order-share]").getAttribute("href");
    assert.match(href, /^https:\/\/wa\.me\/263771234567\?text=/);
    assert.strictEqual(await sentCard(page).locator("[data-order-share]").getAttribute("target"), "_blank");
    const text = decodeURIComponent(href.split("text=")[1]);
    const ref = refOf(order);
    assert.deepStrictEqual(text.split("\n").slice(1), [
      "Vendor: Boka General Dealer · Customer: Tariro M",
      "• Cooking Oil 2L × 1 — USD 4.25 (outstanding)",
      "• Sugar 2kg × 2 — USD 7.00 (fulfilled)",
      "• Brown rice 10kg × 3 — to quote, not listed (1 of 3)",
      "Total USD 11.25 + 1 to quote · Status: partly fulfilled",
    ]);
    assert.match(text.split("\n")[0], new RegExp("^iTred order " + ref + " · "));
    assert.ok(!/0772000111|tariro@example\.com/.test(text), "no phone or email in the summary");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a long order: the PDF runs onto numbered pages; Share stops after 15 lines and stays under 1,500 characters", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake);
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
    await sentCard(page).locator(".note.ok").waitFor();
    const [download] = await Promise.all([ page.waitForEvent("download"), sentCard(page).locator('[data-order-action="pdf"]').click() ]);
    const pdf = fs.readFileSync(await download.path()).toString("latin1");
    const pages = Number((pdf.match(/Page 1 of (\d+)/)||[])[1]);
    assert.ok(pages >= 2, "expected several pages, got "+pages);
    assert.ok(pdf.includes("(Page "+pages+" of "+pages+")"));
    assert.ok(pdf.includes("number 45"));
    const text = decodeURIComponent((await sentCard(page).locator("[data-order-share]").getAttribute("href")).split("text=")[1]);
    assert.ok(text.length <= 1500, "share text " + text.length + " chars");
    assert.match(text, /\n\+ \d+ more items \(see the PDF\)\nTotal USD 3\.50 \+ 45 to quote · Status: sent$/, "the '+ N more' and total lines are kept");
    assert.ok(text.split("\n").filter(l=> l.startsWith("• ")).length <= 15);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("sent orders come from the account on any device, with the vendor's updates and the messages", async ()=>{
    const { context, page, errors, fake } = await openWithSentOrder();
    const get = fake.requests("/rest/v1/purchase_orders", "GET").pop();
    const q = new URLSearchParams(get.query);
    assert.strictEqual(q.get("customer_id"), "eq."+fake.users.get("tariro@example.com").id);
    assert.match(q.get("select"), /vendors\(business_name,\s*whatsapp_number,\s*city\)/);
    for(const col of ["quantity_fulfilled", "fulfillment_status", "vendor_note", "vendor_updated_at", "customer_confirmed_at", "customer_dispute"])
      assert.match(q.get("select"), new RegExp("purchase_order_items\\([^)]*" + col), col);
    assert.match(q.get("select"), /itred_order_messages\(id,\s*author,\s*body,\s*created_at,\s*customer_read_at\)/);
    assert.ok(!/customer_id,|email/.test(q.get("select").replace("customer_id=", "")), "the order select asks for no email");
    assert.strictEqual(q.get("order"), "created_at.desc");
    const lines = await sentCard(page).locator(".ol").evaluateAll(els=> els.map(e=> e.innerText.replace(/\s+/g," ").trim()));
    assert.deepStrictEqual(lines, ["Cooking Oil 2L × 1 USD 4.25 Outstanding", "Sugar 2kg × 2 USD 7.00 Outstanding", "Brown rice 10kg × 3 (not listed) To quote Outstanding"]);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("signed out, Your Orders never asks Supabase for orders and points to sign in", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await open(browser, fake, "#/orders");
    await page.waitForSelector("#sentSignInHint");
    assert.strictEqual(fake.requests("/rest/v1/purchase_orders").length, 0);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("offline: Your Orders shows the copy on this device and the PDF still downloads; signing out removes the copy", async ()=>{
    const { context, page, errors, fake, order } = await openWithSentOrder();
    // The connection drops: every Supabase call fails from now on.
    await page.route(PROJECT + "/rest/**", r=> r.abort("internetdisconnected"));
    await page.reload();
    await page.waitForFunction(()=> /couldn't reach iTred/.test((document.getElementById("ordersOffline") || {}).textContent || ""));
    assert.match(await page.textContent("#ordersOffline"), /Showing the copy on this device from .*couldn't reach iTred/);
    assert.strictEqual(await page.locator(".oc").count(), 1);
    const [download] = await Promise.all([ page.waitForEvent("download"), sentCard(page).locator('[data-order-action="pdf"]').click() ]);
    assert.strictEqual(download.suggestedFilename(), "iTred-Order-" + refOf(order) + "-Boka-General-Dealer.pdf");
    await page.unroute(PROJECT + "/rest/**");
    const key = "itred.orders.v1." + fake.users.get("tariro@example.com").id;
    assert.ok(await page.evaluate((k)=> !!localStorage.getItem(k), key));
    await page.goto(SITE + "#/account");
    await page.click("#signOutBtn");
    await page.waitForSelector("#signInForm");
    assert.strictEqual(await page.evaluate((k)=> localStorage.getItem(k), key), null, "the account's orders left the device");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a listing that expired after the page loaded: no lines saved, the empty order closed, the item flagged, the draft kept", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake);
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
    assert.strictEqual(await page.locator(".oc").count(), 0);
    // Fix it and send again: a new order goes through; the closed empty one stays hidden.
    await page.click('[data-po-action="to-custom"]');
    await page.waitForSelector('[data-po-action="send"]:not([disabled])');
    await sendBoka(page);
    await sentCard(page).locator(".note.ok").waitFor();
    assert.strictEqual(fake.orders.length, 2);
    await page.reload();
    await sentCard(page).waitFor();
    assert.strictEqual(await page.locator(".oc").count(), 1);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("if the order can't be saved, nothing is sent and the draft stays", async ()=>{
    const fake = createFakeSupabase({ listings: catalogue() });
    const { context, page, errors } = await openSignedIn(browser, fake);
    await buildBokaDraft(page);
    fake.failNextOrderInsert = { status:503, body:{ message:"Service unavailable" } };
    await sendBoka(page);
    await draftCard(page, BOKA).locator(".po-error").waitFor();
    assert.match(await draftCard(page, BOKA).locator(".po-error").textContent(), /couldn't be saved \(Service unavailable\)\. Nothing was sent/);
    assert.strictEqual(fake.requests("/rest/v1/purchase_order_items", "POST").length, 0);
    assert.strictEqual((await draftLines(page, BOKA)).length, 3);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("if the PDF tool can't load, the page says so; a later tap works", async ()=>{
    let block = true;
    const { context, page, errors } = await openWithSentOrder({ init: BLOCK_JSPDF });
    await sentCard(page).locator('[data-order-action="pdf"]').click();
    await page.waitForFunction(()=> /The PDF couldn't be made/.test((document.querySelector(".oc .note") || {}).textContent || ""));
    await page.evaluate(()=>{ window.__blockJsPdf = false; });
    const [download] = await Promise.all([ page.waitForEvent("download"), sentCard(page).locator('[data-order-action="pdf"]').click() ]);
    assert.match(download.suggestedFilename(), /^iTred-Order-PO-/);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a sent order at phone width: no sideways scrolling, its buttons on screen and 44 px", async ()=>{
    const { context, page, errors, fake } = await openWithSentOrder({ ctxOpts:{ viewport:{ width:360, height:780 } } });
    fake.vendorSetLine("9f100000-0000-4000-8000-000000000001", 1, "A very long note from the vendor about when the rest of this item will be in stock again");
    await page.reload(); await sentCard(page).waitFor();
    await sentCard(page).locator('[data-order-action="thread"]').click();
    assert.strictEqual(await page.evaluate(()=> document.documentElement.scrollWidth <= window.innerWidth), true);
    for(const sel of ['[data-order-action="pdf"]', "[data-order-share]", '[data-order-action="thread"]', "[data-line-confirm]", "[data-line-dispute]", "[data-msg-send]"]){
      const box = await sentCard(page).locator(sel).first().boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 360 && box.width >= 44 && box.height >= 44, sel+": "+JSON.stringify(box));
    }
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  // ================= The vendor's updates; Confirm / Problem =================
  await t("the vendor's updates show per line: chip, 'x of y supplied', the note; the order's status; 'completed'", async ()=>{
    const { context, page, errors, fake, order } = await openWithSentOrder();
    assert.strictEqual(await sentCard(page).locator("[data-line-confirm]").count(), 0, "nothing to confirm before the vendor answers");
    fake.vendorSetLine("9f100000-0000-4000-8000-000000000001", 1, "1 more on Friday");
    fake.vendorSetLine("9f100000-0000-4000-8000-000000000002", 1);
    await page.reload(); await sentCard(page).waitFor();
    const lines = await sentCard(page).locator(".ol").evaluateAll(els=> els.map(e=> e.innerText.replace(/\s+/g," ").trim()));
    assert.deepStrictEqual(lines, [
      "Cooking Oil 2L × 1 All supplied USD 4.25 Fulfilled Confirm Problem",
      "Sugar 2kg × 2 1 of 2 supplied · Vendor: 1 more on Friday USD 7.00 Partly fulfilled Confirm Problem",
      "Brown rice 10kg × 3 (not listed) To quote Outstanding"]);
    assert.strictEqual((await sentCard(page).locator(".oh .chip").textContent()).trim(), "Partly fulfilled");
    fake.vendorComplete(order.id);
    await page.reload(); await sentCard(page).waitFor();
    assert.strictEqual((await sentCard(page).locator(".oh .chip").textContent()).trim(), "Partly fulfilled · completed");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("Confirm and Problem: one tap each, the reason goes to the vendor; a changed quantity asks again", async ()=>{
    const { context, page, errors, fake } = await openWithSentOrder();
    fake.vendorSetLine("9f100000-0000-4000-8000-000000000001", 2);
    fake.vendorSetLine("9f100000-0000-4000-8000-000000000002", 0, "Out of stock");
    await page.reload(); await sentCard(page).waitFor();
    await sentCard(page).locator('[data-line-confirm="9f100000-0000-4000-8000-000000000001"]').click();
    await page.waitForFunction(()=> /You confirmed/.test(document.querySelector('.ol[data-line="9f100000-0000-4000-8000-000000000001"]').textContent));
    assert.deepStrictEqual(fake.requests("/rest/v1/rpc/itred_line_respond", "POST")[0].body,
      { p_item_id:"9f100000-0000-4000-8000-000000000001", p_confirm:true, p_dispute:null });
    assert.strictEqual(await sentCard(page).locator('[data-line-confirm="9f100000-0000-4000-8000-000000000001"]').count(), 0);
    // Problem: the reason is asked for; an empty answer sends nothing.
    page.__prompt = "";
    await sentCard(page).locator('[data-line-dispute="9f100000-0000-4000-8000-000000000002"]').click();
    await page.waitForTimeout(200);
    assert.strictEqual(fake.requests("/rest/v1/rpc/itred_line_respond", "POST").length, 1);
    page.__prompt = "I collected 1 yesterday";
    await sentCard(page).locator('[data-line-dispute="9f100000-0000-4000-8000-000000000002"]').click();
    await page.waitForFunction(()=> /You raised: I collected 1 yesterday/.test(document.querySelector('.ol[data-line="9f100000-0000-4000-8000-000000000002"]').textContent));
    assert.match(await sentCard(page).locator(".note").textContent(), /Sent to the vendor/);
    // The vendor changes the quantity: the old answer is cleared and Confirm comes back.
    fake.vendorSetLine("9f100000-0000-4000-8000-000000000002", 1);
    await page.reload(); await sentCard(page).waitFor();
    assert.ok(!/You raised/.test(await sentCard(page).textContent()));
    assert.strictEqual(await sentCard(page).locator('[data-line-confirm="9f100000-0000-4000-8000-000000000002"]').count(), 1);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a closed order has no Confirm or Problem buttons", async ()=>{
    const { context, page, errors, fake } = await openWithSentOrder({ status:"closed" });
    fake.vendorSetLine("9f100000-0000-4000-8000-000000000001", 2);
    await page.reload(); await sentCard(page).waitFor();
    assert.strictEqual(await sentCard(page).locator("[data-line-confirm], [data-line-dispute]").count(), 0);
    assert.strictEqual((await sentCard(page).locator(".oh .chip").textContent()).trim(), "Closed");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  // ================= Messages (one thread per order) =================
  await t("messages: write to the vendor (client id, granted columns), see replies, unread count on Your Orders clears when read", async ()=>{
    const { context, page, errors, fake, order } = await openWithSentOrder();
    await sentCard(page).locator('[data-order-action="thread"]').click();
    await sentCard(page).locator(".thread").waitFor();
    assert.match(await sentCard(page).locator(".thread").textContent(), /No messages yet/);
    await sentCard(page).locator(".thread textarea").fill("Can you deliver to Avondale?");
    await sentCard(page).locator("[data-msg-send]").click();
    await page.waitForFunction(()=> /Can you deliver to Avondale\?/.test(document.querySelector(".thread").textContent));
    const [post] = fake.requests("/rest/v1/itred_order_messages", "POST");
    assert.deepStrictEqual(Object.keys(post.body).sort(), ["body", "id", "purchase_order_id"]);
    assert.match(post.body.id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(post.body.purchase_order_id, order.id);
    // The vendor replies; the customer sees a count on Your Orders and on the order.
    fake.vendorReply(order.id, "Yes, tomorrow morning");
    await page.reload(); await sentCard(page).waitFor();
    await page.waitForFunction(()=> document.getElementById("ordersNavCount").textContent === "1");
    assert.strictEqual((await sentCard(page).locator('[data-order-action="thread"] .dot').textContent()).trim(), "1");
    await sentCard(page).locator('[data-order-action="thread"]').click();
    await page.waitForFunction(()=> /Yes, tomorrow morning/.test((document.querySelector(".thread") || {}).textContent || ""));
    const msgs = await sentCard(page).locator(".thread .msg").evaluateAll(els=> els.map(e=> [e.className.replace("msg ", ""), e.lastChild.textContent]));
    assert.deepStrictEqual(msgs, [["customer", "Can you deliver to Avondale?"], ["vendor", "Yes, tomorrow morning"]]);
    await page.waitForFunction(()=> document.getElementById("ordersNavCount").textContent === "");
    assert.deepStrictEqual(fake.requests("/rest/v1/rpc/itred_messages_read", "POST")[0].body, { p_order_id:order.id });
    assert.ok(fake.messages[1].customer_read_at);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("a message that can't be sent stays in the box with the reason; a resend that already arrived counts as sent", async ()=>{
    const { context, page, errors, fake } = await openWithSentOrder();
    await sentCard(page).locator('[data-order-action="thread"]').click();
    fake.failNextMessage = { status:503, body:{ message:"Service unavailable" } };
    await sentCard(page).locator(".thread textarea").fill("Hello?");
    await sentCard(page).locator("[data-msg-send]").click();
    await page.waitForFunction(()=> /Message not sent: Service unavailable/.test((document.querySelector(".oc .note") || {}).textContent || ""));
    assert.strictEqual(await sentCard(page).locator(".thread textarea").inputValue(), "Hello?");
    assert.strictEqual(fake.messages.length, 0);
    // The server got it but the answer was lost: the retry hits the same id… modelled as a 409 on a fresh id
    fake.failNextMessage = { status:409, body:{ code:"23505", message:"duplicate key value violates unique constraint \"itred_order_messages_pkey\"" } };
    await sentCard(page).locator("[data-msg-send]").click();
    await page.waitForFunction(()=> document.querySelectorAll(".thread .msg").length === 1);
    assert.ok(!/Message not sent/.test(await sentCard(page).textContent()));
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await browser.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
