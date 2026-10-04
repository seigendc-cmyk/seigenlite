// Run: node --no-warnings test/marketing-hosted-e2e.test.js
// (build first: node build.js --pwa && node build.js --tauri && node build.js --market)
// The Marketing tab in the two HOSTED builds, served over real http from a
// local server with market.html deployed next to index.html:
//   * dist-pwa: the picker loads online and the service worker precaches
//     market.html; then the device goes offline and the tab still works,
//     because src/marketing.js fetches the add-on (through the worker) and
//     hands it to the sandboxed frame as srcdoc
//   * dist-pwa with NO market.html deployed: the 404 shows the
//     not-installed card straight away (no handshake wait)
//   * dist-tauri (opened in a browser, the way it's also installed as a
//     PWA): Marketing is in the hamburger drawer and the picker loads.
// test/marketing-picker-e2e.test.js covers the tab itself on dist/.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stubDigitalCommerce, TEST_PHRASE } = require("./dc-fake");
const http = require("http");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const MARKET = path.join(ROOT, "dist-market", "market.html");
for(const f of [path.join(ROOT,"dist-pwa","index.html"), path.join(ROOT,"dist-tauri","index.html"), MARKET]){
  if(!fs.existsSync(f)){ console.log("Missing "+path.relative(ROOT,f)+" — run: node build.js --pwa && node build.js --tauri && node build.js --market"); process.exit(1); }
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

// A copy of a build folder plus market.html, served as static files.
function deploy(buildDir, withMarket=true){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-hosted-"));
  for(const f of fs.readdirSync(path.join(ROOT, buildDir))) fs.copyFileSync(path.join(ROOT, buildDir, f), path.join(dir, f));
  if(withMarket) fs.copyFileSync(MARKET, path.join(dir, "market.html"));
  const types = { ".html":"text/html", ".js":"text/javascript", ".json":"application/json", ".png":"image/png", ".ico":"image/x-icon" };
  const server = http.createServer((req, res)=>{
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(dir, rel);
    if(!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){ res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r=> server.listen(0, "127.0.0.1", ()=> r({ server, base:"http://127.0.0.1:"+server.address().port+"/" })));
}
// The test WANTS the real worker (that's what it's checking), so start from
// a page it controls from the first byte: wait for the first visit's worker
// to claim the page, then reload. (pwa-extras.js deliberately doesn't reload
// on that first claim — it used to, and wiped a new shop's half-filled Setup.)
async function openControlled(page, base){
  await page.goto(base);
  const deadline = Date.now() + 30000;
  while(!(await page.evaluate(()=> !!navigator.serviceWorker.controller))){
    if(Date.now() > deadline) throw new Error("service worker never took control of the page");
    await page.waitForTimeout(200);
  }
  await page.reload();
  if(!(await page.evaluate(()=> !!navigator.serviceWorker.controller))) throw new Error("reloaded page isn't controlled");
}
async function finishSetup(page){
  // On the context so the service worker's requests are caught too.
  await stubDigitalCommerce(page.context());
  await page.waitForSelector("#setShop", { timeout: 20000 });
  await page.fill("#setShop", "Test Shop");
  await page.fill("#setSecret", TEST_PHRASE); // setup won't continue without it
  await page.click("#setupNext");
  await page.click("#setupNext2");
  await page.click("#setupNext3");
  await page.click("#setupFinish");
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
async function gotoRoute(page, route, desktop){
  if(desktop){ await page.click("#hamburgerBtn"); await page.click('#navDrawer [data-route="'+route+'"]'); }
  else await page.click('.navbar [data-route="'+route+'"]');
}

(async()=>{
  const browser = await chromium.launch();

  await t("dist-pwa: picker loads online, and OFFLINE from the service worker cache", async ()=>{
    const { server, base } = await deploy("dist-pwa");
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err.message));
    try{
      await openControlled(page, base);
      await finishSetup(page);
      await page.waitForSelector("[data-route]");
      await gotoRoute(page, "products");
      await addProduct(page, "Sugar 2kg", 3.5, 12);
      await gotoRoute(page, "marketing");
      let frame = page.frameLocator("#marketFrame");
      await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });

      // Wait until the service worker is installed and its precache holds market.html.
      await page.evaluate(()=> navigator.serviceWorker.ready);
      await page.waitForFunction(async ()=> !!(await caches.match("./market.html")), null, { timeout: 20000 });

      await context.setOffline(true);
      await page.reload();
      // A new session starts at the Start screen; Sign in leads to "Who's working today?".
      await page.waitForSelector("#startSignIn", { timeout: 20000 }).catch(async ()=>{
        throw new Error("after the offline reload the app showed: "+JSON.stringify((await page.textContent("#app")).replace(/\s+/g," ").slice(0,400)));
      });
      await page.click("#startSignIn");
      await page.waitForSelector("#whoContinue", { timeout: 20000 }).catch(async ()=>{
        throw new Error("after the offline reload the app showed: "+JSON.stringify((await page.textContent("#app")).replace(/\s+/g," ").slice(0,400)));
      });
      if(await page.$("#whoName")) await page.fill("#whoName", "Tester");
      await page.click("#whoContinue");
      await page.waitForSelector("[data-route]", { timeout: 20000 });
      await gotoRoute(page, "marketing");
      frame = page.frameLocator("#marketFrame");
      const outcome = await Promise.race([
        frame.locator(".mk-row").first().waitFor({ timeout: 12000 }).then(()=>"picker"),
        page.waitForSelector("#marketRecheck", { timeout: 12000 }).then(()=>"not-installed"),
      ]);
      assert.strictEqual(outcome, "picker", "offline, the Marketing tab showed: "+outcome);
      assert.deepStrictEqual(await frame.locator(".mk-row .pname").allTextContents(), ["Sugar 2kg"]);
      // The offline add-on still works end to end, not just renders.
      await frame.locator(".mk-row .mk-check").first().check();
      await frame.locator("#mkContinue").click();
      await frame.locator("#mkPrepare").waitFor();
      assert.deepStrictEqual(pageErrors, []);
    } finally {
      await context.close(); server.close();
    }
  });

  await t("dist-pwa with no market.html deployed: not-installed card, without waiting out the handshake", async ()=>{
    const { server, base } = await deploy("dist-pwa", false);
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err.message));
    try{
      await openControlled(page, base);
      await finishSetup(page);
      await page.waitForSelector("[data-route]");
      const t0 = Date.now();
      await gotoRoute(page, "marketing");
      await page.waitForSelector("#marketRecheck", { timeout: 10000 });
      const ms = Date.now() - t0;
      assert.ok(ms < 3000, "took "+ms+"ms (the handshake cap is 6000ms)");
      assert.strictEqual(await page.$("#marketFrame"), null);
      assert.deepStrictEqual(pageErrors, []);
    } finally {
      await context.close(); server.close();
    }
  });

  await t("dist-tauri in a browser: Marketing is in the hamburger drawer and the picker loads", async ()=>{
    const { server, base } = await deploy("dist-tauri");
    const context = await browser.newContext({ viewport:{ width:1280, height:800 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err.message));
    try{
      await openControlled(page, base);
      await finishSetup(page);
      await page.waitForSelector("#hamburgerBtn");
      assert.strictEqual(await page.$(".navbar"), null, "desktop build has no bottom bar");
      await gotoRoute(page, "products", true);
      await addProduct(page, "Rice 5kg", 6, 4);
      await gotoRoute(page, "marketing", true);
      const frame = page.frameLocator("#marketFrame");
      await frame.locator(".mk-row").first().waitFor({ timeout: 10000 });
      assert.deepStrictEqual(await frame.locator(".mk-row .pname").allTextContents(), ["Rice 5kg"]);
      await frame.locator(".mk-row .mk-check").first().check();
      await frame.locator("#mkContinue").click();
      await frame.locator("#mkPrepare").waitFor();
      assert.deepStrictEqual(pageErrors, []);
    } finally {
      await context.close(); server.close();
    }
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed?1:0);
})();
