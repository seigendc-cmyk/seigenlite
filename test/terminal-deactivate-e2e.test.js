// Run: node --no-warnings test/terminal-deactivate-e2e.test.js   (build first: node build.js)
// Multi-terminal Phase 2 in a REAL browser (Playwright/Chromium) against the
// built dist/index.html, with Digital Commerce answered by test/terminal-fake.js
// (never the live project):
//   * main (T1) deactivates T2 from Settings → Business & Terminals; its own row has no button
//   * T2's next check-in says it is inactive: its card explains it, register/join are gone, selling still works
//   * main reactivates T2; T2's next check-in clears the message
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stubTerminals, newTerminalState } = require("./terminal-fake");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
const CORE = path.join(ROOT, "dist", "index.html");
if(!fs.existsSync(CORE)){ console.log("Missing dist/index.html — run: node build.js"); process.exit(1); }

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const fileUrl = (p)=> "file:///" + p.replace(/\\/g, "/");
async function device(browser, server){
  const ctx = await browser.newContext({ viewport:{ width:390, height:844 } });
  const fake = await stubTerminals(ctx, { state: server });
  const page = await ctx.newPage();
  const pageErrors = [], dialogs = [];
  page.on("pageerror", e=>pageErrors.push(e.message));
  page.on("dialog", d=>{ dialogs.push(d.message()); d.accept(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-deact-"));
  fs.copyFileSync(CORE, path.join(dir, "index.html"));
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#setShop", { timeout: 15000 });
  return { ctx, page, fake, pageErrors, dialogs };
}
async function openSettings(page){
  await page.click('[data-route="more"]');
  await page.click('[data-kebab-toggle="moretab"]');
  await page.click('[data-tab="settings"]');
  await page.waitForSelector("#terminalCard");
}
async function waitFor(cond, what){
  const deadline = Date.now() + 10000;
  while(!(await cond())){ if(Date.now() > deadline) throw new Error("timed out waiting for "+what); await new Promise(r=>setTimeout(r, 100)); }
}
// A check-in runs at boot and whenever the device comes back online (startDeviceCheckin).
async function checkinNow(dev){
  const before = dev.fake.calls.filter(c=>c.name==="cl_device_checkin").length;
  await dev.page.evaluate(()=>window.dispatchEvent(new Event("online")));
  await waitFor(async()=> dev.fake.calls.filter(c=>c.name==="cl_device_checkin").length > before, "a check-in");
  await dev.page.waitForTimeout(300);                       // its reply is stored after the call returns
}
const rowFor = (page, till)=> page.locator("#termList .term-row", { hasText: new RegExp("^\\s*"+till+"\\b") });

(async()=>{
  const browser = await chromium.launch();
  const server = newTerminalState();
  let main, t2;

  await t("setup: main registers (T1) and a second device joins the main branch (T2)", async ()=>{
    main = await device(browser, server);
    await main.page.fill("#setShop", "Gentronix"); await main.page.fill("#setBranch", "Harare CBD"); await main.page.fill("#setSecret", "Gold Leaf 42");
    await main.page.click("#setupNext"); await main.page.click("#setupNext2"); await main.page.click("#setupNext3"); await main.page.click("#setupFinish");
    await main.page.waitForSelector("[data-route]");
    await openSettings(main.page);
    await main.page.click("#termRegisterBtn");
    await main.page.waitForSelector('#terminalCard[data-registered="1"]');
    await main.page.click("#termAddBtn"); await main.page.click("#termAddIssue");
    await main.page.waitForSelector("#termAddCode");
    const code = (await main.page.textContent("#termAddCode")).trim();
    t2 = await device(browser, server);
    await t2.page.click("#setJoinBtn"); await t2.page.waitForSelector("#setJoinCode");
    await t2.page.fill("#setSecret", "Gold Leaf 42"); await t2.page.fill("#setJoinCode", code); await t2.page.fill("#setTillLabel", "Front");
    await t2.page.click("#setupJoin");
    await t2.page.waitForSelector("[data-route]", { timeout: 10000 });
    await openSettings(t2.page);
    assert.strictEqual((await t2.page.textContent("#termTill")).trim(), "T2");
  });

  await t("main: T2's row has Deactivate, main's own row has none; Deactivate asks first, then marks T2 deactivated", async ()=>{
    const page = main.page;
    await page.click(".modalOverlay [data-modal-close]");   // the Add a terminal code
    await page.click('[data-route="pos"]');
    await openSettings(page);                               // reopened: the list now includes T2
    await waitFor(async()=> await rowFor(page,"T2").count() === 1, "T2 in the terminals list");
    assert.strictEqual(await rowFor(page,"T1").locator("button").count(), 0, "no button on this till's own row");
    assert.match(await rowFor(page,"T1").textContent(), /this till/);
    const btn = rowFor(page,"T2").locator("button");
    assert.strictEqual((await btn.textContent()).trim(), "Deactivate");
    await btn.click();
    await waitFor(async()=> /deactivated/.test(await rowFor(page,"T2").textContent()), "T2 shown deactivated");
    assert.ok(main.dialogs.includes("Deactivate T2? It can still sell offline, but it can't add itself to the business again until reactivated."), main.dialogs.join(" | "));
    assert.strictEqual((await rowFor(page,"T2").locator("button").textContent()).trim(), "Reactivate");
    assert.ok(!/deactivated/.test(await rowFor(page,"T1").textContent()), "main itself unaffected");
    const call = main.fake.calls.find(c=>c.name==="cl_terminal_set_active").body;
    assert.strictEqual(call.p_active, false); assert.match(call.p_device_key, /^[0-9a-f]{32}$/);
    assert.strictEqual(server.terminals.find(x=>x.till==="T2").active, false);
    assert.deepStrictEqual(main.pageErrors, []);
  });

  await t("T2: after its next check-in the card says it was deactivated, add/register are gone, and selling still works", async ()=>{
    await checkinNow(t2);
    await t2.page.click('[data-route="pos"]');
    await openSettings(t2.page);
    await t2.page.waitForSelector('#terminalCard[data-inactive="1"]');
    const text = await t2.page.textContent("#terminalCard");
    assert.match(text, /This till was deactivated by your main branch\. Selling still works\. Ask main to reactivate it\./);
    assert.match(text, /Deactivated/);
    assert.strictEqual(await t2.page.$("#termAddBtn"), null, "no Add a terminal");
    assert.strictEqual(await t2.page.$("#termRegisterBtn"), null);
    assert.strictEqual(await t2.page.$("#termJoinBtn"), null);
    await t2.page.click('[data-route="pos"]');
    await t2.page.waitForSelector('[data-route="pos"]');
    assert.deepStrictEqual(t2.pageErrors, []);
  });

  await t("main reactivates T2; T2's next check-in clears the message", async ()=>{
    const page = main.page;
    await rowFor(page,"T2").locator("button").click();
    await waitFor(async()=> !/deactivated/.test(await rowFor(page,"T2").textContent()), "T2 active again");
    assert.strictEqual(server.terminals.find(x=>x.till==="T2").active, true);
    await checkinNow(t2);
    await t2.page.click('[data-route="pos"]');
    await openSettings(t2.page);
    assert.strictEqual(await t2.page.getAttribute("#terminalCard","data-inactive"), null);
    assert.match(await t2.page.textContent("#terminalCard"), /Registered/);
    assert.deepStrictEqual(main.pageErrors, []); assert.deepStrictEqual(t2.pageErrors, []);
  });

  await browser.close();
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
