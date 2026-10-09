// Run: node --no-warnings test/marketing-picker-e2e.test.js
// (build first: node build.js && node build.js --market)
// Marketing tab + dist-market layer in a REAL browser (Playwright/Chromium),
// against the built files: dist/index.html and dist-market/market.html,
// copied into a temp folder so "is market.html next to the app?" can be
// tested both ways without touching dist/.
//   * no market.html beside the app  -> the inert "not installed" card
//   * market.html beside the app     -> the picker loads through the bridge,
//                                        and the selection survives leaving
//                                        and re-entering the tab
//   * the 200 cap in the picker UI, driven through a stub host page that
//     plays the core app's side of the bridge with 205 products (adding
//     205 products through the real UI would make this suite very slow;
//     the core app's own cap is covered in test/marketing-bridge.test.js)
//   * the whole export: a real uploaded photo comes out as a 200x200 WebP
//     plus a 100x100 thumbnail (pack v2), "Save file" downloads the .scl,
//     and "Send to seiGEN" (a fake Digital Commerce answers the pack calls):
//     offline it waits, back online it sends (photos separately, never
//     twice), then each decision shows: in review, published until …, not
//     published + why, expired -> a fresh pack
//   * market.html opened on its own -> explains itself, does nothing
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stubDigitalCommerce, TEST_PHRASE } = require("./dc-fake");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const SHOTS = process.env.SHOT_DIR || "";
if(SHOTS) fs.mkdirSync(SHOTS, { recursive:true });
const CORE = path.join(ROOT, "dist", "index.html");
const MARKET = path.join(ROOT, "dist-market", "market.html");
for(const f of [CORE, MARKET]){
  if(!fs.existsSync(f)){ console.log("Missing "+path.relative(ROOT,f)+" — run: node build.js && node build.js --market"); process.exit(1); }
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const fileUrl = (p)=> "file:///" + p.replace(/\\/g, "/");
function tempFolder(withMarket){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-market-"));
  fs.copyFileSync(CORE, path.join(dir, "index.html"));
  if(withMarket) fs.copyFileSync(MARKET, path.join(dir, "market.html"));
  return dir;
}
async function setUpCore(browser, dir){
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err.message));
  await stubDigitalCommerce(page); // setup checks in: registered, without reaching the live project
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#setShop", { timeout: 15000 }); // sql.js WASM (CDN) + boot()
  await page.fill("#setShop", "Test Shop");
  await page.fill("#setSecret", TEST_PHRASE); // setup won't continue without it
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

  await t("Marketing is in the nav, and with no market.html beside the app it shows the inert not-installed card", async ()=>{
    const { page, pageErrors } = await setUpCore(browser, tempFolder(false));
    assert.ok(await page.$('[data-route="marketing"]'), "Marketing nav button missing");
    await page.click('[data-route="marketing"]');
    await page.waitForSelector("#marketRecheck", { timeout: 10000 });
    const text = await page.textContent("#main");
    assert.match(text, /Marketing isn't installed on this device/);
    assert.match(text, /market\.html/);
    assert.strictEqual(await page.$("#marketFrame"), null, "no iframe should be left behind");
    // Remembered for the session: re-entering doesn't wait for the handshake again.
    await page.click('[data-route="pos"]');
    await page.click('[data-route="marketing"]');
    assert.ok(await page.$("#marketRecheck"));
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  await t("with market.html beside the app, the picker loads this branch's products through the bridge", async ()=>{
    const { page, pageErrors } = await setUpCore(browser, tempFolder(true));
    await page.click('[data-route="products"]');
    await addProduct(page, "Sugar 2kg", 3.5, 12);
    await addProduct(page, "Bread", 1, 0);
    await page.click('[data-route="marketing"]');
    const frame = page.frameLocator("#marketFrame");
    await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });
    assert.deepStrictEqual(await frame.locator(".mk-row .pname").allTextContents(), ["Bread", "Sugar 2kg"]);
    assert.match(await frame.locator(".mk-row", { hasText:"Bread" }).textContent(), /out of stock/);
    assert.match(await frame.locator(".mk-row", { hasText:"Bread" }).textContent(), /no photo/);
    // iframe is sized to its content (no scroll box inside the page)
    const h = await page.$eval("#marketFrame", el=>el.getBoundingClientRect().height);
    assert.ok(h > 200, "iframe height "+h);
    assert.strictEqual(await page.textContent("#marketStatus"), "");
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  await t("ticking products updates the count, and the selection survives leaving and re-entering the tab", async ()=>{
    const { page } = await setUpCore(browser, tempFolder(true));
    await page.click('[data-route="products"]');
    await addProduct(page, "Sugar 2kg", 3.5, 12);
    await addProduct(page, "Rice 5kg", 6, 4);
    await addProduct(page, "Bread", 1, 3);
    await page.click('[data-route="marketing"]');
    let frame = page.frameLocator("#marketFrame");
    await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });
    await frame.locator(".mk-row", { hasText:"Sugar 2kg" }).locator(".mk-check").check();
    await frame.locator(".mk-row", { hasText:"Rice 5kg" }).locator(".mk-check").check();
    assert.match(await frame.locator(".mk-footer .mk-count").textContent(), /^2 of 200 selected$/);
    await page.waitForTimeout(500); // selection is saved to the core app after a 250ms debounce
    await page.click('[data-route="reports"]');
    await page.click('[data-route="marketing"]');
    frame = page.frameLocator("#marketFrame");
    await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });
    assert.strictEqual(await frame.locator(".mk-row", { hasText:"Sugar 2kg" }).locator(".mk-check").isChecked(), true);
    assert.strictEqual(await frame.locator(".mk-row", { hasText:"Rice 5kg" }).locator(".mk-check").isChecked(), true);
    assert.strictEqual(await frame.locator(".mk-row", { hasText:"Bread" }).locator(".mk-check").isChecked(), false);
    // search filters the list without losing the typed text
    await frame.locator("#mkSearch").fill("rice");
    assert.deepStrictEqual(await frame.locator(".mk-row .pname").allTextContents(), ["Rice 5kg"]);
    assert.strictEqual(await frame.locator("#mkSearch").inputValue(), "rice");
    // nothing exported yet
    assert.strictEqual(await frame.locator(".mk-status").getAttribute("data-state"), "not_exported");
    await page.close();
  });

  await t("Products → Add to Marketing opens Marketing with the checked products ticked; with none checked it just opens it", async ()=>{
    const { page, pageErrors } = await setUpCore(browser, tempFolder(true));
    await page.click('[data-route="products"]');
    await addProduct(page, "Sugar 2kg", 3.5, 12);
    await addProduct(page, "Rice 5kg", 6, 4);
    await addProduct(page, "Bread", 1, 3);
    // Nothing checked: Marketing opens, nothing pre-selected.
    assert.match(await page.textContent("#addToMarketingBtn"), /Add to Marketing/);
    await page.click("#addToMarketingBtn");
    let frame = page.frameLocator("#marketFrame");
    await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });
    assert.match(await frame.locator(".mk-footer .mk-count").textContent(), /^0 of 200 selected$/);
    // Check two on the Products page and carry them over.
    await page.click('[data-route="products"]');
    const row = (name)=> page.locator("#productsTableArea tr", { hasText:name }).locator(".catCheck");
    await row("Sugar 2kg").check();
    await row("Bread").check();
    await page.click("#addToMarketingBtn");
    frame = page.frameLocator("#marketFrame");
    await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });
    assert.strictEqual(await page.$eval('[data-route="marketing"]', el=> el.classList.contains("active")), true, "Marketing tab is showing");
    assert.strictEqual(await frame.locator(".mk-row", { hasText:"Sugar 2kg" }).locator(".mk-check").isChecked(), true);
    assert.strictEqual(await frame.locator(".mk-row", { hasText:"Bread" }).locator(".mk-check").isChecked(), true);
    assert.strictEqual(await frame.locator(".mk-row", { hasText:"Rice 5kg" }).locator(".mk-check").isChecked(), false);
    assert.match(await frame.locator(".mk-footer .mk-count").textContent(), /^2 of 200 selected$/);
    // Nothing was exported or sent: still at the start of the flow.
    assert.strictEqual(await frame.locator(".mk-status").getAttribute("data-state"), "not_exported");
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  await t("the picker stops at 200: other boxes disable, and Select all shown fills only up to the cap", async ()=>{
    const dir = tempFolder(true);
    // A stub host playing the core app's side of the bridge, with 205 products.
    fs.writeFileSync(path.join(dir, "host.html"), `<!DOCTYPE html><body>
      <iframe id="f" sandbox="allow-scripts" src="market.html" style="width:100%;height:4000px;border:0"></iframe>
      <script>
        const products = Array.from({length:205}, (_,i)=>({ id:i+1, name:"Item "+String(i+1).padStart(3,"0"), sku:"", price:1, stock:5, category:"", hasImage:true }));
        let sel = [];
        const f = document.getElementById("f");
        window.addEventListener("message", (e)=>{
          if(e.source!==f.contentWindow || !e.data || e.data.ch!=="seigen-market") return;
          const m = e.data, reply = (x)=> f.contentWindow.postMessage(Object.assign({ch:"seigen-market"}, x), "*");
          if(m.type==="hello") reply({ type:"welcome", bridgeVersion:1 });
          if(m.type!=="req") return;
          const ops = {
            context: ()=>({ bridgeVersion:1, appVersion:"test", maxProducts:200, currencySymbol:"$", branch:"Main", shopName:"S", isRemote:false }),
            listProducts: ()=>products,
            getSelection: ()=>sel,
            getStatus: ()=>({ state:"not_exported" }),
            getExportSetup: ()=>({ installId:"X", businessName:"S", whatsappNumber:"", city:"", currency:"USD", currencySet:false, marketWhatsApp:"+263789487287" }),
            setSelection: (a)=>{ sel = a.ids.slice(0,200); window.savedCount = sel.length; return sel; },
          };
          reply({ type:"res", id:m.id, ok:true, result: ops[m.op](m.args) });
        });
      </script></body>`);
    const page = await browser.newPage();
    await page.goto(fileUrl(path.join(dir, "host.html")));
    const frame = page.frameLocator("#f");
    await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });
    await frame.locator("#mkSelectShown").click();
    assert.match(await frame.locator(".mk-footer .mk-count").textContent(), /^200 of 200 selected$/);
    assert.strictEqual(await frame.locator(".mk-check:checked").count(), 200);
    assert.strictEqual(await frame.locator(".mk-check:disabled").count(), 5);
    assert.ok(await frame.locator("#mkCapNote").isVisible());
    await page.waitForFunction(()=> window.savedCount===200);
    // untick one -> the other five become pickable again, and one more can be ticked
    await frame.locator(".mk-row", { hasText:"Item 001" }).locator(".mk-check").uncheck();
    assert.strictEqual(await frame.locator(".mk-check:disabled").count(), 0);
    assert.ok(!(await frame.locator("#mkCapNote").isVisible()));
    await frame.locator(".mk-row", { hasText:"Item 205" }).locator(".mk-check").check();
    assert.strictEqual(await frame.locator(".mk-check:disabled").count(), 5);
    await page.close();
  });

  await t("full export: photo -> 200x200 WebP + 100x100 thumbnail (pack v2), Save file, Send to seiGEN (offline waits, then sends once), and every decision shown", async ()=>{
    const { page, pageErrors } = await setUpCore(browser, tempFolder(true));
    const shot = async (n)=>{ if(SHOTS) await page.screenshot({ path: path.join(SHOTS, "app-" + n + ".png") }); };
    // A fake Digital Commerce for the pack calls (routes added last win over dc-fake's).
    const server = { submits:[], images:[], decision:null };
    await page.route(/urbopdsubwawtybwrxjd\.supabase\.co\/rest\/v1\/rpc\/cl_device_pack_(submit|image|status)$/, async (route)=>{
      const name = route.request().url().split("/rpc/")[1];
      const body = JSON.parse(route.request().postData() || "{}");
      const reply = (o)=> route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify(o) });
      if(name === "cl_device_pack_submit"){
        server.submits.push(body);
        const h = JSON.parse(body.p_header);
        server.uid = body.p_pack_uid; server.want = h.listings.filter(l=>l.image_sha256).map(l=>l.source_product_id);
        return reply({ pack_uid: body.p_pack_uid, status:"receiving", missing: server.want.filter(id=> !server.images.some(i=> i.p_source_product_id===id)) });
      }
      if(name === "cl_device_pack_image"){ server.images.push(body); return reply({ pack_uid: body.p_pack_uid, status:"received", received: server.images.length, expected: server.want.length }); }
      return reply(server.decision? [Object.assign({ pack_uid: server.uid, from_this_device:true, received:1, expected:1 }, server.decision)] : []);
    });
    // A product with a real photo, uploaded through the real Add Product form.
    const png = Buffer.from(await page.evaluate(()=>{
      const c = document.createElement("canvas"); c.width = 640; c.height = 400;
      const g = c.getContext("2d"); g.fillStyle = "#c33"; g.fillRect(0,0,640,400);
      return c.toDataURL("image/png").split(",")[1];
    }), "base64");
    await page.click('[data-route="products"]');
    await page.click("#openAddProduct");
    await page.waitForSelector("#pName");
    await page.fill("#pName", "Cooking Oil 2L");
    await page.fill("#pPrice", "4.2");
    await page.fill("#pStock", "8");
    await page.setInputFiles("#pImage", { name:"oil.png", mimeType:"image/png", buffer:png });
    await page.waitForSelector("#pImgPreview img");
    await page.click("#pConfirm");
    await page.waitForSelector(".modalOverlay", { state: "detached" });
    await addProduct(page, "Bread", 1, 0);

    await page.click('[data-route="marketing"]');
    let frame = page.frameLocator("#marketFrame");
    await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });
    await frame.locator(".mk-row", { hasText:"Cooking Oil" }).locator(".mk-check").check();
    await frame.locator(".mk-row", { hasText:"Bread" }).locator(".mk-check").check();
    await frame.locator("#mkContinue").click();

    // Export screen: identity shown, city + currency asked once.
    await frame.locator("#mkPrepare").waitFor();
    assert.match(await frame.locator(".mk-idtable").textContent(), /Test Shop/);
    assert.strictEqual(await frame.locator("#mkCurrency").inputValue(), "USD");
    await frame.locator("#mkPrepare").click();
    assert.match(await frame.locator("#mkExportError").textContent(), /city or town/);
    await frame.locator("#mkCity").fill("Harare");
    await frame.locator("#mkPrepare").click();

    // Ready to send.
    await frame.locator('.mk-status[data-state="exported"]').waitFor({ timeout: 15000 });
    assert.match(await frame.locator(".mk-status").textContent(), /MKT0001[\s\S]*2 products, 1 with photo/);
    assert.ok(await frame.locator("#mkSendSeigen").isVisible() && await frame.locator("#mkSaveFile").isVisible());
    await shot("40-market-ready");

    // Save file (the backup) -> this browser can't share a .scl file, so it downloads.
    const [download] = await Promise.all([ page.waitForEvent("download"), frame.locator("#mkSaveFile").click() ]);
    assert.match(download.suggestedFilename(), /^MKT0001-TestShop-\d{2}[A-Z][a-z]{2}\d{2}-\d{4}[AP]M\.scl$/);
    const doc = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    assert.strictEqual(doc.format, "seigen.market_export");
    assert.strictEqual(doc.format_version, 2);
    assert.match(doc.pack_uid, /^[0-9a-f-]{36}$/);
    assert.strictEqual(doc.vendor.business_name, "Test Shop");
    assert.strictEqual(doc.vendor.city, "Harare");
    assert.deepStrictEqual(doc.listings.map(l=>[l.product_name, l.price, l.currency, l.stock_quantity]),
      [["Cooking Oil 2L",4.2,"USD",8], ["Bread",1,"USD",0]]); // in the order they were ticked
    const oil = doc.listings.find(l=>l.product_name==="Cooking Oil 2L");
    assert.match(oil.image_webp, /^data:image\/webp;base64,/);
    assert.match(oil.thumb_webp, /^data:image\/webp;base64,/);
    assert.strictEqual(doc.listings.find(l=>l.product_name==="Bread").image_webp, null);
    const dims = (src)=> page.evaluate((src)=> new Promise(r=>{ const i = new Image(); i.onload = ()=>r([i.naturalWidth, i.naturalHeight]); i.src = src; }), src);
    assert.deepStrictEqual(await dims(oil.image_webp), [200, 200]);
    assert.deepStrictEqual(await dims(oil.thumb_webp), [100, 100], "a 100x100 thumbnail for iTred lists");
    await frame.locator("#mkShareNote").waitFor();
    assert.match(await frame.locator("#mkShareNote").textContent(), /Downloaded/);

    // Send to seiGEN while offline: it waits.
    await page.context().setOffline(true);
    await frame.locator("#mkSendSeigen").click();
    await frame.locator('.mk-status[data-state="waiting"]').waitFor({ timeout: 10000 });
    assert.match(await frame.locator(".mk-status").textContent(), /Saved\. It will send when you're online\./);
    assert.strictEqual(server.submits.length, 0);
    await shot("41-market-waiting-offline");
    // Back online: it goes by itself.
    await page.context().setOffline(false);
    await page.evaluate(()=> window.dispatchEvent(new Event("online")));
    await frame.locator('.mk-status[data-state="sent"]').waitFor({ timeout: 15000 });
    assert.match(await frame.locator(".mk-status").textContent(), /Sent to Digital Commerce[\s\S]*Waiting for review/);
    assert.strictEqual(server.submits.length, 1, "sent once");
    const header = JSON.parse(server.submits[0].p_header);
    assert.strictEqual(server.submits[0].p_pack_uid, doc.pack_uid, "the same pack ID as the saved file");
    assert.ok(header.listings.every(l=> !("image_webp" in l) && !("thumb_webp" in l)), "the pack goes without photos first");
    assert.strictEqual(server.images.length, 1);
    assert.strictEqual(server.images[0].p_image_webp, oil.image_webp);
    assert.strictEqual(server.images[0].p_thumb_webp, oil.thumb_webp);
    assert.ok(server.submits[0].p_install_id && server.submits[0].p_secret_phrase && server.submits[0].p_device_key, "the device's own check");
    await shot("42-market-sent");

    // Each decision, as Digital Commerce gives it (Check status).
    const decide = async (d, state, re)=>{
      server.decision = d;
      await frame.locator("#mkCheckStatus").click();
      await frame.locator('.mk-status[data-state="' + state + '"]').waitFor({ timeout: 10000 });
      assert.match(await frame.locator(".mk-status").textContent(), re);
    };
    await decide({ status:"in_review" }, "in_review", /In review[\s\S]*reviewing it/);
    await shot("43-market-in-review");
    const until = new Date(Date.now() + 7*86400000).toISOString();
    await decide({ status:"published", expires_at: until, published_count:2 }, "published", /On the iTred Market Place until [\s\S]*\(2 products\)/);
    await shot("44-market-published");
    await decide({ status:"expired", expires_at: new Date(Date.now() - 3600000).toISOString(), published_count:2 }, "expired", /Expired[\s\S]*The listing ended on/);
    await shot("46-market-expired");
    // a check-in after it was sent never sends it again
    await page.evaluate(()=> window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(800);
    assert.strictEqual(server.submits.length, 1, "never sent twice");
    await page.close();
    assert.deepStrictEqual(pageErrors, []);
  });

  await t("not published (with the reason) -> Prepare a fresh pack: a new pack, city remembered", async ()=>{
    const { page, pageErrors } = await setUpCore(browser, tempFolder(true));
    const shot = async (n)=>{ if(SHOTS) await page.screenshot({ path: path.join(SHOTS, "app-" + n + ".png") }); };
    const server = { decision:{ status:"rejected", reason:"TEST: blurry photos" } };
    await page.route(/urbopdsubwawtybwrxjd\.supabase\.co\/rest\/v1\/rpc\/cl_device_pack_(submit|image|status)$/, async (route)=>{
      const name = route.request().url().split("/rpc/")[1];
      const body = JSON.parse(route.request().postData() || "{}");
      const reply = (o)=> route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify(o) });
      if(name === "cl_device_pack_submit"){ server.uid = body.p_pack_uid; return reply({ pack_uid: body.p_pack_uid, status:"received", missing:[] }); }
      if(name === "cl_device_pack_image") return reply({ status:"received" });
      return reply([Object.assign({ pack_uid: server.uid }, server.decision)]);
    });
    await page.click('[data-route="products"]');
    await addProduct(page, "Bread", 1, 3);
    await page.click('[data-route="marketing"]');
    let frame = page.frameLocator("#marketFrame");
    await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });
    await frame.locator(".mk-row .mk-check").first().check();
    await frame.locator("#mkContinue").click();
    await frame.locator("#mkCity").fill("Harare");
    await frame.locator("#mkPrepare").click();
    await frame.locator("#mkSendSeigen").click();
    await frame.locator('.mk-status[data-state="rejected"]').waitFor({ timeout: 15000 });
    assert.match(await frame.locator(".mk-status").textContent(), /Not published[\s\S]*didn't publish it: TEST: blurry photos\./);
    await shot("45-market-not-published");
    await frame.locator("#mkRefresh").click();
    await frame.locator("#mkPrepare").waitFor();
    assert.strictEqual(await frame.locator("#mkCityField").isVisible(), false, "city remembered");
    await frame.locator("#mkPrepare").click();
    await frame.locator('.mk-status[data-state="exported"]').waitFor({ timeout: 15000 });
    assert.match(await frame.locator(".mk-status").textContent(), /MKT0002/);
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  await t("market.html opened on its own explains what it is and does nothing else", async ()=>{
    const page = await browser.newPage();
    await page.goto(fileUrl(MARKET));
    assert.match(await page.textContent("#market"), /adds the Marketing tab to seiGEN Commerce Lite/);
    await page.close();
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed?1:0);
})();
