// Run: node --no-warnings test/terminal-join-e2e.test.js   (build first: node build.js)
// Multi-terminal Phase 1 in a REAL browser (Playwright/Chromium) against the
// built dist/index.html, with Digital Commerce answered by test/terminal-fake.js
// (never the live project). Each "device" is its own browser context, so each
// has its own IndexedDB, while all of them share one fake server:
//   * main: Settings → Business & Terminals → Register this branch → T1
//   * main: Add a terminal → a XXXX-XXXX code with Copy / Share on WhatsApp
//   * new device: Setup → Join an existing branch → success → T2, no product step
//   * join refusals: wrong code, offline
//   * existing remote device: join from Settings; a branch-name mismatch says
//     so and keeps the code usable; the right branch then joins
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
const SHOTS = process.env.SHOT_DIR || "";

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
  const pageErrors = [], alerts = [];
  page.on("pageerror", e=>pageErrors.push(e.message));
  page.on("dialog", d=>{ alerts.push(d.message()); d.accept(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-term-"));
  fs.copyFileSync(CORE, path.join(dir, "index.html"));
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#setShop", { timeout: 15000 });
  return { ctx, page, fake, pageErrors, alerts };
}
async function setupShop(page, o){
  await page.fill("#setShop", o.shop);
  await page.fill("#setBranch", o.branch);
  await page.fill("#setSecret", o.phrase);
  if(o.remote) await page.click("#setRemoteBtn");
  await page.click("#setupNext");
  if(o.remote){ await page.fill("#setAdminPass", "admin123"); await page.fill("#setAdminPass2", "admin123"); }
  await page.click("#setupNext2");
  await page.click("#setupNext3");
  await page.click("#setupFinish");
  await page.waitForSelector("[data-route]");
}
async function openSettings(page, remote){
  await page.click('[data-route="more"]');
  await page.click('[data-kebab-toggle="moretab"]');
  await page.click('[data-tab="settings"]');
  if(remote){
    await page.waitForSelector("#settingsPasscode");
    await page.fill("#settingsPasscode", "admin123");
    await page.click("#unlockSettings");
  }
  await page.waitForSelector("#terminalCard");
}
async function waitFor(cond, what){
  const deadline = Date.now() + 10000;
  while(!(await cond())){ if(Date.now() > deadline) throw new Error("timed out waiting for "+what); await new Promise(r=>setTimeout(r, 100)); }
}
async function shot(page, name){ if(SHOTS) await page.screenshot({ path: path.join(SHOTS, name), fullPage: false }); }
async function scrollTo(page, sel){ await page.locator(sel).scrollIntoViewIfNeeded(); }

(async()=>{
  const browser = await chromium.launch();
  const server = newTerminalState();
  let code1 = "";

  await t("main: Settings → Business & Terminals → Register this branch shows business, branch, T1 and Registered", async ()=>{
    const { page, fake, pageErrors } = await device(browser, server);
    await setupShop(page, { shop:"Gentronix", branch:"Harare CBD", phrase:"Gold Leaf 42" });
    await openSettings(page);
    assert.strictEqual(await page.getAttribute("#terminalCard","data-registered"), "0");
    await scrollTo(page, "#terminalCard"); await shot(page, "settings-unregistered-main.png");
    await page.click("#termRegisterBtn");
    await page.waitForSelector('#terminalCard[data-registered="1"]');
    const text = await page.textContent("#terminalCard");
    assert.match(text, /Gentronix/); assert.match(text, /Harare CBD/); assert.match(text, /Main/); assert.match(text, /Registered/);
    assert.strictEqual((await page.textContent("#termTill")).trim(), "T1");
    const reg = fake.calls.find(c=>c.name==="cl_branch_register").body;
    assert.strictEqual(reg.p_secret_phrase, "Gold Leaf 42"); assert.strictEqual(reg.p_branch_name, "Harare CBD");
    assert.match(reg.p_device_key, /^[0-9a-f]{32}$/); assert.match(reg.p_legacy_branch_id, /^B-[A-Z0-9]{8}$/);
    await waitFor(async()=> /T1/.test(await page.textContent("#termList")), "the terminals list");

    // Add a terminal for this branch
    await page.click("#termAddBtn");
    await page.click("#termAddIssue");
    await page.waitForSelector("#termAddCode");
    code1 = (await page.textContent("#termAddCode")).trim();
    assert.match(code1, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(await page.$("#termCopyCode") && await page.$("#termShareCode"), "Copy and Share on WhatsApp offered");
    await shot(page, "settings-add-terminal-code.png");
    // Share sends text only, to wa.me, with the code and never the phrase
    // (window.open is captured, not followed: tests never reach WhatsApp)
    await page.evaluate(()=>{ window.open = (u)=>{ window.__opened = u; return null; }; });
    await page.click("#termShareCode");
    const url = decodeURIComponent(await page.evaluate(()=>window.__opened||""));
    assert.ok(url.startsWith("https://wa.me/?text=") && url.includes(code1), url);
    assert.ok(!url.includes("Gold Leaf 42"), "the secret phrase is never shared");
    assert.deepStrictEqual(pageErrors, []);
  });

  await t("new device: Setup → Join an existing branch → T2 of Harare CBD, setup finished with no product step", async ()=>{
    const { page, fake, pageErrors } = await device(browser, server);
    await page.click("#setJoinBtn");
    await page.waitForSelector("#setJoinCode");
    assert.match(await page.textContent(".setup-card"), /starts with no products/);
    await shot(page, "setup-join.png");
    await page.fill("#setSecret", "gold leaf 42");                 // case doesn't matter (Q2)
    await page.fill("#setJoinCode", code1.toLowerCase().replace("-",""));
    await page.fill("#setTillLabel", "Till 2");
    await page.click("#setupJoin");
    await page.waitForSelector("[data-route]", { timeout: 10000 });
    const join = fake.calls.find(c=>c.name==="cl_terminal_join").body;
    assert.strictEqual(join.p_join_code, code1);
    assert.strictEqual(join.p_label, "Till 2");
    assert.match(join.p_install_id, /^[A-Z0-9]{4}$/, "4 characters while LONG_INSTALL_ID is off");
    await openSettings(page);
    const text = await page.textContent("#terminalCard");
    assert.match(text, /Gentronix/); assert.match(text, /Harare CBD/);
    assert.strictEqual((await page.textContent("#termTill")).trim(), "T2");
    await scrollTo(page, "#terminalCard"); await shot(page, "settings-joined-T2.png");
    // a till on the main branch is a main-branch device (can add products / terminals)
    assert.ok(await page.$("#termAddBtn"), "a main-branch till may add terminals");
    await waitFor(async()=> fake.calls.some(c=>c.name==="cl_device_checkin"), "the check-in after setup");
    assert.deepStrictEqual(pageErrors, []);
  });

  await t("join refusals: a used code and a wrong code each say why, and setup stays on the join step", async ()=>{
    const { page, pageErrors } = await device(browser, server);
    await page.click("#setJoinBtn");
    await page.fill("#setSecret", "Gold Leaf 42");
    await page.fill("#setJoinCode", code1);                          // already used by T2
    await page.click("#setupJoin");
    await waitFor(async()=> /already been used/.test(await page.textContent("#setupJoinStatus")), "the used-code message");
    await page.fill("#setJoinCode", "WXYZ-2345");
    await page.click("#setupJoin");
    await waitFor(async()=> /isn't right/.test(await page.textContent("#setupJoinStatus")), "the wrong-code message");
    assert.ok(await page.$("#setupJoin"), "still on the join step");
    await shot(page, "setup-join-wrong-code.png");
    assert.deepStrictEqual(pageErrors, []);
  });

  await t("join offline: says to connect once; nothing is sent", async ()=>{
    const { ctx, page, fake } = await device(browser, server);
    await page.click("#setJoinBtn");
    await page.fill("#setSecret", "Gold Leaf 42");
    await page.fill("#setJoinCode", "ABCD-EFGH");
    await ctx.setOffline(true);
    await page.click("#setupJoin");
    await waitFor(async()=> /Connect to the internet once/.test(await page.textContent("#setupJoinStatus")), "the offline message");
    assert.strictEqual(fake.calls.filter(c=>c.name==="cl_terminal_join").length, 0);
    await shot(page, "setup-join-offline.png");
  });

  await t("existing remote device: a branch-name mismatch says the name doesn't match and keeps the code; the right branch joins", async ()=>{
    // main issues a code for a branch it calls "Bulawayo Main St"; the remote device is "Bulawayo"
    // main (registered in the first test) issues codes through the shared fake server
    const mainInstall = Object.keys(server.vendors)[0];
    const mainTerm = server.terminals.find(x=>x.install===mainInstall);
    const issue = (name)=>{ const br = { id:"br-x"+(++server.seq), business:mainTerm.business, name, is_main:false }; server.branches.push(br);
      const code = "RMTE"+(2000+server.seq); server.codes.push({ code, branch:br.id, used:false }); return code.slice(0,4)+"-"+code.slice(4); };
    const wrongCode = issue("Bulawayo Main St");
    const { page, pageErrors } = await device(browser, server);
    await setupShop(page, { shop:"Gentronix", branch:"Bulawayo", phrase:"Remote Own Phrase", remote:true });
    await openSettings(page, true);
    assert.ok(await page.$("#termJoinCode"), "a remote sees the join form, not Register");
    await page.fill("#termJoinPhrase", "Gold Leaf 42");
    await page.fill("#termJoinCode", wrongCode);
    await page.click("#termJoinBtn");
    await waitFor(async()=> /branch name doesn't match/i.test(await page.textContent("#termStatus")), "the mismatch message");
    const msg = await page.textContent("#termStatus");
    assert.match(msg, /Bulawayo Main St/); assert.match(msg, /check the branch name/i); assert.match(msg, /can still be used/i);
    await scrollTo(page, "#terminalCard"); await shot(page, "settings-remote-name-mismatch.png");
    assert.strictEqual(server.codes.find(c=>c.code===wrongCode.replace("-","")).used, false, "the code stays usable");
    const rightCode = issue("Bulawayo");
    await page.fill("#termJoinCode", rightCode);
    await page.click("#termJoinBtn");
    await page.waitForSelector('#terminalCard[data-registered="1"]');
    assert.strictEqual((await page.textContent("#termTill")).trim(), "T1");
    assert.ok(!(await page.$("#termAddBtn")), "a remote-branch till can't add terminals");
    assert.deepStrictEqual(pageErrors, []);
  });

  await browser.close();
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
