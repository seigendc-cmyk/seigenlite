// Run: node --no-warnings test/itred-mobile-e2e.test.js
// (build first: node build.js --itred)
// The iTred site at phone widths in a REAL browser (Playwright/Chromium),
// against dist-itred/index.html with the Supabase fake from
// test/itred-fake-supabase.js:
//   * no page scrolls sideways at 375/390/414px, in Market Space grid and
//     list view too, with long shop-typed names
//   * list view keeps the text readable (buttons go under it, not beside it)
//   * listing text and buttons are smaller on a phone than on desktop
//   * the card buttons carry outline icons, and their labels are unchanged
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
const ROUTES = ["#/", "#/market-space", "#/products", "#/rpn", "#/help", "#/contact", "#/orders", "#/account", "#/privacy", "#/terms"];

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
function listings(){
  const vendorId = "9b1c0000-0000-4000-8000-000000000001";
  const vendor = { business_name:"Gara Bolts & Fasteners Hardware Supplies", whatsapp_number:"0771234567", city:"Harare" };
  return [
    listingRow({ vendor_id:vendorId, vendors:vendor, product_name:"Hex Bolt M12 x 100mm Zinc Plated (box of 50)", price:24.5, stock_quantity:40 }),
    listingRow({ vendor_id:vendorId, vendors:vendor, product_name:"Supercalifragilisticexpialidocious-Cooking-Oil-Economy-Pack", price:12345.67, stock_quantity:0 }),
  ];
}
async function open(browser, width, hash){
  const fake = createFakeSupabase({ listings: listings() });
  const context = await browser.newContext({ viewport:{ width, height:800 }, isMobile: width < 600, hasTouch: width < 600 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e=> errors.push(e.message));
  await fake.install(page);
  await page.goto(SITE + (hash||"#/market-space"));
  await page.waitForSelector(".page.active");
  return { context, page, errors };
}
// Elements of the visible page that stick out past the screen edge.
const overflow = (page)=> page.evaluate(()=>{
  const vw = document.documentElement.clientWidth, out = [];
  for(const el of document.querySelectorAll("body *")){
    if(el.closest(".page") && !el.closest(".page.active")) continue;
    const cs = getComputedStyle(el); if(cs.display==="none" || cs.visibility==="hidden") continue;
    const b = el.getBoundingClientRect();
    if(b.width && (b.right > vw + 0.5 || b.left < -0.5)) out.push(el.tagName.toLowerCase() + (el.className && typeof el.className==="string" ? "."+el.className.trim().replace(/\s+/g,".") : ""));
  }
  return { scrollWidth: document.documentElement.scrollWidth, vw, out: out.slice(0,5) };
});

(async()=>{
  const browser = await chromium.launch();

  for(const width of [375, 390, 414]){
    await t(`nothing scrolls sideways at ${width}px on any page, including Market Space grid and list view`, async ()=>{
      const { context, page, errors } = await open(browser, width);
      await page.waitForSelector("#marketResults .product-card");
      // So #/orders has lines. Each add re-renders the cards: click the first one left each time.
      for(let i = 0; i < 5 && await page.locator("[data-add-to-order]").count(); i++) await page.locator("[data-add-to-order]").first().click();
      for(const route of ROUTES){
        await page.goto(SITE + route); await page.waitForSelector(".page.active");
        const views = route === "#/market-space" ? ["#viewCardBtn", "#viewListBtn"] : [null];
        for(const v of views){
          if(v){ await page.click(v); await page.waitForTimeout(100); }
          const o = await overflow(page);
          assert.ok(o.scrollWidth <= o.vw && !o.out.length, `${route}${v?" "+v:""} at ${width}px: scrollWidth ${o.scrollWidth} > ${o.vw}, ${o.out.join(", ")}`);
        }
      }
      assert.deepStrictEqual(errors, []);
      await context.close();
    });
  }

  await t("list view on a phone: buttons sit under the text, which keeps a readable width", async ()=>{
    const { context, page } = await open(browser, 375);
    await page.waitForSelector("#marketResults .product-card");
    await page.click("#viewListBtn");
    const item = page.locator(".product-list-item").first();
    const body = await item.locator(".pbody").boundingBox();
    const actions = await item.locator(".product-actions").boundingBox();
    assert.ok(body.width > 200, "text column is " + body.width + "px wide");
    assert.ok(actions.y >= body.y + body.height - 1, "buttons are below the text");
    await context.close();
  });

  await t("listing text and buttons are smaller on a phone than on desktop", async ()=>{
    const sizes = async (width)=>{
      const { context, page } = await open(browser, width);
      await page.waitForSelector("#marketResults .product-card");
      const px = (sel)=> page.$eval("#marketResults .product-card " + sel, el=> parseFloat(getComputedStyle(el).fontSize));
      const s = { name: await px("h4"), vendor: await px(".vendor"), meta: await px(".product-meta"), button: await px(".product-actions .btn") };
      await context.close();
      return s;
    };
    const phone = await sizes(390), desk = await sizes(1280);
    for(const k of Object.keys(desk)){
      assert.ok(phone[k] < desk[k], `${k}: phone ${phone[k]}px vs desktop ${desk[k]}px`);
      assert.ok(phone[k] >= 12, `${k} stays readable: ${phone[k]}px`);
    }
  });

  await t("Contact on WhatsApp and Add to order carry outline icons; labels unchanged", async ()=>{
    const { context, page } = await open(browser, 390);
    await page.waitForSelector("#marketResults .product-card");
    const card = page.locator("#marketResults .product-card").first();
    for(const [sel, label] of [[".btn-gold", "Contact on WhatsApp"], ["[data-add-to-order]", "Add to order"]]){
      const btn = card.locator(sel);
      assert.strictEqual((await btn.textContent()).trim(), label);
      const icon = btn.locator("svg.btn-icon");
      assert.strictEqual(await icon.count(), 1, label + " has one icon");
      assert.strictEqual(await icon.getAttribute("fill"), "none", "outline, not filled");
      assert.strictEqual(await icon.getAttribute("aria-hidden"), "true");
      const box = await icon.boundingBox();
      assert.ok(box.width >= 14 && box.width <= 18, label + " icon is " + box.width + "px");
    }
    await context.close();
  });

  await t("the page has no iframes, and one added later is capped to the screen width", async ()=>{
    const { context, page } = await open(browser, 375, "#/");
    assert.strictEqual(await page.locator("iframe").count(), 0);
    const w = await page.evaluate(()=>{
      const f = document.createElement("iframe"); f.width = "640"; f.height = "360";
      document.querySelector(".page.active .wrap").appendChild(f);
      return f.getBoundingClientRect().right <= document.documentElement.clientWidth;
    });
    assert.ok(w, "a 640px-wide embed fits inside the 375px screen");
    await context.close();
  });

  await browser.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
