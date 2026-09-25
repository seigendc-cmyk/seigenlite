// Run: node --no-warnings test/dc-registration-e2e.test.js
// (build first: node build.js && node build.js --market)
// Registering a device with Digital Commerce, in a REAL browser
// (Playwright/Chromium) against the built dist/index.html + market.html,
// with cl_device_checkin answered by the fake in test/dc-fake.js:
//   * setup asks for the activation phrase and won't go on without it
//   * finishing setup checks in straight away (no restart needed)
//   * Settings → Save phrase checks in straight away and says the outcome
//   * Marketing shows whether the device is registered, says what to do
//     when it isn't, and won't prepare a file until it is
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stubDigitalCommerce } = require("./dc-fake");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
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
function tempFolder(){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-dcreg-"));
  fs.copyFileSync(CORE, path.join(dir, "index.html"));
  fs.copyFileSync(MARKET, path.join(dir, "market.html"));
  return dir;
}
async function openApp(browser, fakeOpts){
  const page = await browser.newPage();
  const pageErrors = [], alerts = [];
  page.on("pageerror", err => pageErrors.push(err.message));
  page.on("dialog", d => { alerts.push(d.message()); d.accept(); });
  const fake = await stubDigitalCommerce(page, fakeOpts);
  await page.goto(fileUrl(path.join(tempFolder(), "index.html")));
  await page.waitForSelector("#setShop", { timeout: 15000 }); // sql.js WASM (CDN) + boot()
  return { page, pageErrors, alerts, fake };
}
async function finishSetup(page, phrase){
  await page.fill("#setShop", "Test Shop");
  await page.fill("#setSecret", phrase);
  await page.click("#setupNext");
  await page.click("#setupNext2");
  await page.click("#setupNext3");
  await page.click("#setupFinish");
  await page.waitForSelector("[data-route]");
}
async function waitFor(cond, what){
  const deadline = Date.now() + 10000;
  while(!(await cond())){
    if(Date.now() > deadline) throw new Error("timed out waiting for "+what);
    await new Promise(r=>setTimeout(r, 100));
  }
}
async function openMarketing(page){
  await page.click('[data-route="pos"]');
  await page.click('[data-route="marketing"]');
  await page.waitForSelector("#marketReg");
}
async function openSettings(page){
  await page.click('[data-route="more"]');
  await page.click('[data-kebab-toggle="moretab"]');
  await page.click('[data-tab="settings"]');
  await page.waitForSelector("#sSecret");
}
async function addProduct(page, name){
  await page.click('[data-route="products"]');
  await page.click("#openAddProduct");
  await page.waitForSelector("#pName");
  await page.fill("#pName", name);
  await page.fill("#pPrice", "2");
  await page.fill("#pStock", "5");
  await page.click("#pConfirm");
  await page.waitForSelector(".modalOverlay", { state: "detached" });
}
// Picks every product and presses Prepare; returns the export error text ("" if none).
async function tryPrepare(page){
  await openMarketing(page);
  const frame = page.frameLocator("#marketFrame");
  await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });
  for(const c of await frame.locator(".mk-check").all()) if(!(await c.isChecked())) await c.check();
  await frame.locator("#mkContinue").click();
  await frame.locator("#mkPrepare").waitFor();
  await frame.locator("#mkCity").fill("Harare");
  await frame.locator("#mkPrepare").click();
  await Promise.race([
    frame.locator('.mk-status[data-state="exported"]').waitFor({ timeout: 15000 }),
    frame.locator("#mkExportError:not(:empty)").waitFor({ timeout: 15000 }),
  ]);
  const err = frame.locator("#mkExportError");
  return (await err.count()) ? ((await err.textContent()) || "").trim() : "";
}

(async()=>{
  const browser = await chromium.launch();

  await t("setup asks for the activation phrase, won't continue without it, and keeps it when Main/Remote is switched", async ()=>{
    const { page, alerts, fake, pageErrors } = await openApp(browser);
    await page.fill("#setShop", "Test Shop");
    await page.click("#setupNext");
    assert.match(alerts.pop()||"", /activation secret phrase/);
    assert.ok(await page.$("#setSecret"), "still on step 1");
    await page.fill("#setSecret", "Gold Leaf 42");
    await page.click("#setRemoteBtn");
    await page.click("#setMainBtn");
    assert.strictEqual(await page.inputValue("#setSecret"), "Gold Leaf 42");
    assert.strictEqual(await page.inputValue("#setShop"), "Test Shop");
    assert.strictEqual(fake.calls.length, 0, "nothing sent before setup finishes");
    await page.close();
    assert.deepStrictEqual(pageErrors, []);
  });

  await t("finishing setup saves the phrase and checks in at once: Marketing shows the device registered, no restart", async ()=>{
    const { page, fake, alerts, pageErrors } = await openApp(browser, { phrase:"Gold Leaf 42" });
    await finishSetup(page, "Gold Leaf 42");
    await waitFor(async()=> fake.calls.length >= 1, "the check-in after setup");
    const c = fake.calls[0];
    assert.strictEqual(c.p_shop_secret_phrase, "Gold Leaf 42");
    assert.strictEqual(c.p_business_name, "Test Shop");
    assert.ok(c.p_install_id, "install ID sent");
    await openMarketing(page);
    await waitFor(async()=> (await page.getAttribute("#marketReg","data-registered"))==="1", "the registered banner");
    assert.match(await page.textContent("#marketReg"), /registered with Digital Commerce/);
    await openSettings(page);
    assert.strictEqual(await page.inputValue("#sSecret"), "Gold Leaf 42", "the setup phrase is the one Settings shows");
    assert.deepStrictEqual(alerts, [], "a good check-in is silent");
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  await t("wrong phrase: Marketing says so and blocks the file; Save phrase with the right one registers at once and the file goes through", async ()=>{
    const { page, fake, alerts, pageErrors } = await openApp(browser, { phrase:"Right Phrase" });
    await finishSetup(page, "Wrong Phrase");
    await waitFor(async()=> fake.calls.length >= 1, "the check-in after setup");
    await addProduct(page, "Sugar 2kg");
    await openMarketing(page);
    assert.strictEqual(await page.getAttribute("#marketReg","data-registered"), "0");
    const banner = await page.textContent("#marketReg");
    assert.match(banner, /isn't registered with Digital Commerce yet/);
    assert.match(banner, /different activation phrase/);
    const err = await tryPrepare(page);
    assert.match(err, /isn't registered with Digital Commerce/);
    assert.match(err, /different activation phrase/);

    await openSettings(page);
    await page.fill("#sSecret", "Right Phrase");
    const before = fake.calls.length;
    await page.click("#saveSecret");
    await waitFor(async()=> alerts.some(a=>/Secret phrase saved/.test(a)), "the Save phrase alert");
    assert.strictEqual(fake.calls.length, before + 1, "Save phrase checked in straight away");
    assert.strictEqual(fake.calls[fake.calls.length-1].p_shop_secret_phrase, "Right Phrase");
    assert.match(alerts[alerts.length-1], /registered with Digital Commerce/);
    assert.ok(!/isn't registered/.test(alerts[alerts.length-1]));

    await openMarketing(page);
    assert.strictEqual(await page.getAttribute("#marketReg","data-registered"), "1");
    assert.strictEqual(await tryPrepare(page), "", "the file is prepared once registered");
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  await t("Save phrase while the server still refuses it says so, with what to do", async ()=>{
    const { page, fake, alerts } = await openApp(browser, { phrase:"Right Phrase" });
    await finishSetup(page, "Wrong Phrase");
    await waitFor(async()=> fake.calls.length >= 1, "the check-in after setup");
    await openSettings(page);
    await page.fill("#sSecret", "Still Wrong");
    await page.click("#saveSecret");
    await waitFor(async()=> alerts.some(a=>/Secret phrase saved/.test(a)), "the Save phrase alert");
    assert.match(alerts[alerts.length-1], /isn't registered with Digital Commerce yet/);
    assert.match(alerts[alerts.length-1], /different activation phrase/);
    await page.close();
  });

  await t("offline at setup: Marketing says to connect; Check again registers once online, without reloading", async ()=>{
    let offline = true;
    const { page, fake, pageErrors } = await openApp(browser, { offline: ()=>offline });
    await finishSetup(page, "Gold Leaf 42");
    await waitFor(async()=> fake.calls.length >= 1, "the check-in after setup");
    await openMarketing(page);
    await waitFor(async()=> !(await page.$("#marketRegCheck[disabled]")), "the automatic re-check to finish");
    assert.strictEqual(await page.getAttribute("#marketReg","data-registered"), "0");
    assert.match(await page.textContent("#marketReg"), /connected to the internet/);
    offline = false;
    await page.click("#marketRegCheck");
    await waitFor(async()=> (await page.getAttribute("#marketReg","data-registered"))==="1", "registered after Check again");
    assert.ok(await page.$("#marketFrame"), "the add-on frame wasn't torn down by the banner update");
    assert.deepStrictEqual(pageErrors, []);
    await page.close();
  });

  await browser.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
