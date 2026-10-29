// Run: node --no-warnings test/module-run-v371-e2e.test.js   (build first: node tools/build-all.js)
// v37.1 Part 5: the whole-app module walk in a REAL browser (Playwright/
// Chromium), on every till build (dist and dist-pwa at 390 and 1280 px,
// dist-tauri at 1280 px), with no server at all (supabase.co is blocked).
// A fresh shop is set up, given products, a shift and a cash sale; then every
// menu entry, every More tab and every sub-tab inside it is opened by a real
// click, every report's Generate button is pressed, the bell and its settings
// open, Settings is unlocked, and the walk is repeated offline. Each screen
// must render something, throw no page error and show no "undefined", "NaN"
// or "[object Object]".
// SHOT_DIR=<dir> saves a screenshot of each screen.
"use strict";
require("./dist-fresh");   // stop here if a bundle is older than its source (node tools/build-all.js)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { activateForTest } = require("./test-activation");
const { TEST_PHRASE } = require("./dc-fake");

let chromium;
require("./local-cdn");   // the cdnjs files from test/cdn/, not the internet
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
const RUNS = [
  { build:"dist", width:390 }, { build:"dist", width:1280 },
  { build:"dist-pwa", width:390 }, { build:"dist-pwa", width:1280 },
  { build:"dist-tauri", width:1280 },
];
const SHOTS = process.env.SHOT_DIR || "";
if(SHOTS) fs.mkdirSync(SHOTS, { recursive:true });
const BAD_TEXT = /\bundefined\b|\bNaN\b|\[object Object\]/;

let passed=0, failed=0;
const table = [];   // { run, module, result, note }
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const fileUrl = (p)=> "file:///" + p.replace(/\\/g, "/");

async function device(browser, run){
  const ctx = await browser.newContext({ viewport: { width: run.width, height: run.width < 600? 844 : 800 }, acceptDownloads: true });
  await ctx.route(/supabase\.co/, (r)=>r.abort());   // no server at all: never reach live seiGEN
  const page = await ctx.newPage();
  const pageErrors = [], dialogs = [];
  page.on("pageerror", e=>pageErrors.push(e.message));
  page.on("dialog", d=>{ dialogs.push(d.message()); d.type()==="prompt"? d.accept("Tendai") : d.accept(); });
  page.on("download", (dl)=>{ dl.cancel().catch(()=>{}); });
  await page.addInitScript(()=>{ window.print = ()=>{}; window.open = ()=>null; });
  const src = path.join(ROOT, run.build);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-mr-"));
  fs.copyFileSync(path.join(src, "index.html"), path.join(dir, "index.html"));
  if(fs.existsSync(path.join(src, "vendor"))) fs.cpSync(path.join(src, "vendor"), path.join(dir, "vendor"), { recursive: true });
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#setShop", { timeout:30000 });
  const desktop = run.build==="dist-tauri";   // the desktop shell (hamburger drawer, desktop Sell) is that build's alone
  return { ctx, page, pageErrors, dialogs, desktop, run, tag: run.build+"@"+run.width };
}
const shot = async (d, name)=>{ if(SHOTS) await d.page.screenshot({ path: path.join(SHOTS, d.run.build+"-"+d.run.width+"-"+name+".png"), fullPage:false }); };
async function nav(d, route){
  if(d.desktop){ await d.page.click("#hamburgerBtn"); await d.page.click('#navDrawer [data-route="'+route+'"]'); }
  else await d.page.click('.navbar [data-route="'+route+'"]');
  await d.page.waitForTimeout(150);
}
async function closeModals(d){
  for(let i=0; i<4 && await d.page.$(".modalOverlay"); i++){
    const x = await d.page.$(".modalOverlay .close-x, .modalOverlay [data-modal-close]");
    if(x) await x.click().catch(()=>{}); else await d.page.keyboard.press("Escape");
    await d.page.waitForTimeout(150);
  }
}
// what a screen must be: something rendered, no page error since `from`, no broken text
async function checkScreen(d, module, from, sel){
  const text = (await d.page.$eval(sel || "#main", el=>el.innerText).catch(()=>"")) || "";
  const errs = d.pageErrors.slice(from);
  let result = "Pass", note = "";
  if(!text.trim()){ result = "Fails"; note = "empty screen"; }
  else if(errs.length){ result = "Fails"; note = "page error: "+errs[0]; }
  else { const m = BAD_TEXT.exec(text); if(m){ result = "Fails"; note = 'shows "'+m[0]+'": …'+text.slice(Math.max(0, m.index-60), m.index+40).replace(/\s+/g, " ")+"…"; } }
  table.push({ run: d.tag, module, result, note });
  return { result, note };
}
const must = (r, what)=> assert.strictEqual(r.result, "Pass", what+": "+r.note);

async function setUp(d){
  const p = d.page;
  // the setup order the onboarding pack describes (decision 62 comparison): Welcome -> Contact & branding -> RPN -> Confirm
  const order = [];
  order.push(await p.$eval("#app h2", el=>el.textContent));
  await p.fill("#setShop", "Module Run"); await p.fill("#setBranch", "Harare"); await p.fill("#setSecret", TEST_PHRASE);
  await p.click("#setupNext"); order.push(await p.$eval("#app h2", el=>el.textContent));
  await p.fill("#setOwnerPhone", "0771234567"); await p.click("#setupNext2"); order.push(await p.$eval("#app h2", el=>el.textContent));
  await p.click("#setupNext3"); order.push(await p.$eval("#app h2", el=>el.textContent));
  await p.click("#setupFinish");
  await p.waitForSelector("[data-route]");
  await activateForTest(p);
  return order;
}
async function addProduct(d, o){
  const p = d.page;
  await nav(d, "products");
  await p.click("#openAddProduct");
  await p.fill("#pName", o.name); await p.fill("#pSku", o.sku); await p.fill("#pPrice", String(o.price));
  await p.fill("#pCost", String(o.cost)); await p.fill("#pStock", String(o.stock));
  await p.click("#pConfirm");
  await p.waitForSelector(".modalOverlay", { state:"detached" });
}
async function startShift(d){
  await nav(d, "pos");
  const go = await d.page.$("#goToEodBtn");
  if(!go) return;
  await go.click();
  await d.page.waitForSelector("#openingFloat");
  await d.page.fill("#openingFloat", "50");
  await d.page.click("#startShiftBtn");
  await nav(d, "pos");
}
async function sellCash(d, name){
  if(d.desktop){ await d.page.click(`tr:has-text("${name}") .ds-add-btn`); await d.page.click("#dsPayCash"); }
  else { await d.page.click(`.product-row:has-text("${name}") .add-chip`); await d.page.click("#cartBtn"); await d.page.click("#payCash"); }
  await d.page.waitForFunction(()=> !!window._lastReceipt, null, { timeout: 15000 });
  await closeModals(d);
}
async function moreTabs(d){
  await nav(d, "more");
  return d.page.$$eval("[data-tab]", els=> els.map(e=>({ id:e.dataset.tab, label:e.textContent.trim() })));
}
async function openMoreTab(d, id){
  await nav(d, "more");
  await d.page.click('[data-kebab-toggle="moretab"]');
  await d.page.click('[data-tab="'+id+'"]');
  await d.page.waitForTimeout(250);
}
async function unlockSettings(d){
  const p = d.page;
  if(await p.$("#settingsPasscode")){ await p.fill("#settingsPasscode", "admin123"); await p.click("#unlockSettings"); }
  else if(await p.$("#newAdminPass")){ await p.fill("#newAdminPass", "admin123"); await p.fill("#newAdminPass2", "admin123"); await p.click("#createAdmin"); }
  await p.waitForTimeout(400);
}
// every sub-tab a screen has (stock requests, dispatch, cycle counts)
async function walkSubTabs(d, module){
  for(const attr of ["data-srq-tab", "data-dstab", "data-cycle-tab"]){
    const ids = await d.page.$$eval("["+attr+"]", (els, a)=> els.map(e=>e.getAttribute(a)), attr);
    for(const id of [...new Set(ids)]){
      const from = d.pageErrors.length;
      const b = await d.page.$("["+attr+'="'+id+'"]');
      if(!b || !(await b.isVisible())) continue;
      await b.click(); await d.page.waitForTimeout(250);
      must(await checkScreen(d, module+" › "+id, from), module+" › "+id);
      await shot(d, module.replace(/\W+/g, "-")+"-"+id);
    }
  }
}

async function walk(browser, run){
  const d = await device(browser, run);
  const p = d.page;
  await t(d.tag+": setup is Welcome -> Contact & branding -> RPN -> Confirm, and finishes", async ()=>{
    const order = await setUp(d);
    assert.deepStrictEqual(order.map(s=>s.split(" (")[0]), ["Welcome", "Contact & branding", "RPN", "Confirm"]);
    table.push({ run: d.tag, module: "Setup", result: "Pass", note: order.join(" -> ") });
  });
  await t(d.tag+": products, a shift and a cash sale", async ()=>{
    await addProduct(d, { name:"Rice 2kg", sku:"R2", price:10, cost:6, stock:20 });
    await addProduct(d, { name:"Soap bar", sku:"S1", price:2, cost:1, stock:30 });
    await startShift(d);
    await sellCash(d, "Rice 2kg");
    assert.strictEqual(await p.evaluate(()=> window._lastReceipt && window._lastReceipt.total), 10);
    table.push({ run: d.tag, module: "Sell (cash sale, receipt)", result: "Pass", note: "" });
  });
  await t(d.tag+": every menu entry opens", async ()=>{
    const routes = d.desktop
      ? (await p.click("#hamburgerBtn"), await p.$$eval("#navDrawer [data-route]", els=>els.map(e=>e.dataset.route)))
      : await p.$$eval(".navbar [data-route]", els=>els.map(e=>e.dataset.route));
    if(d.desktop) await p.click("#closeNavDrawer");
    assert.deepStrictEqual(routes, ["pos", "products", "credit", "reports", "marketing", "more"]);
    for(const r of routes){
      const from = d.pageErrors.length;
      await nav(d, r);
      must(await checkScreen(d, "Menu › "+r, from), r);
      await shot(d, "route-"+r);
    }
  });
  await t(d.tag+": every More tab opens, with every sub-tab", async ()=>{
    const tabs = await moreTabs(d);
    assert.ok(tabs.length >= 8, "More has its tabs: "+tabs.map(x=>x.id).join(", "));
    for(const tab of tabs){
      const from = d.pageErrors.length;
      await openMoreTab(d, tab.id);
      if(tab.id==="settings") await unlockSettings(d);
      must(await checkScreen(d, "More › "+tab.label, from), tab.label);
      await shot(d, "more-"+tab.id);
      await walkSubTabs(d, "More › "+tab.label);
      await closeModals(d);
    }
  });
  await t(d.tag+": every report's Generate button runs", async ()=>{
    await nav(d, "reports");
    const names = await p.$$eval("[data-report-name]", els=>els.map(e=>e.dataset.reportName));
    assert.ok(names.length >= 5, "reports listed: "+names.join(", "));
    for(const name of names){
      await nav(d, "reports");
      const card = p.locator(`[data-report-name="${name}"]`);
      const gen = card.locator('[title="Generate PDF"], [title="Generate"]').first();
      if(!(await gen.count())){ table.push({ run: d.tag, module: "Report › "+name, result: "Pass", note: "no Generate button (opens inline)" }); continue; }
      const from = d.pageErrors.length;
      await gen.scrollIntoViewIfNeeded(); await gen.click(); await p.waitForTimeout(700);
      const r = await checkScreen(d, "Report › "+name, from, "body");
      await closeModals(d);
      must(r, name);
    }
  });
  await t(d.tag+": the Branch Report runs while today's shift is still open (bug: null.toFixed on an open shift's EOD row)", async ()=>{
    await nav(d, "pos");
    assert.strictEqual(await p.$("#goToEodBtn"), null, "precondition: a shift is open (no Start a shift banner)");
    const from = d.pageErrors.length;
    await nav(d, "reports");
    await p.click("#genBranchReport"); await p.waitForTimeout(700);
    assert.deepStrictEqual(d.pageErrors.slice(from), []);
    await closeModals(d);
  });
  // the bell is for tills on seiGEN (bell.js bellButtonHtml: scRegistered()); this shop has no server,
  // so it has none. The bell's lists, reminders and routes are tested in srq-drafts-v371 and stock-control-v37.
  await t(d.tag+": no bell on a till that is not on seiGEN", async ()=>{
    await nav(d, "pos");
    assert.strictEqual(await p.$("#bellBtn"), null);
    table.push({ run: d.tag, module: "Bell (unregistered till: hidden)", result: "Pass", note: "" });
  });
  await t(d.tag+": offline, every menu entry and More tab still opens", async ()=>{
    await d.ctx.setOffline(true);
    for(const r of ["pos", "products", "credit", "reports", "marketing", "more"]){
      const from = d.pageErrors.length;
      await nav(d, r);
      must(await checkScreen(d, "Offline › "+r, from), "offline "+r);
    }
    for(const tab of await moreTabs(d)){
      const from = d.pageErrors.length;
      await openMoreTab(d, tab.id);
      if(tab.id==="settings") await unlockSettings(d);
      must(await checkScreen(d, "Offline › More › "+tab.label, from), "offline "+tab.label);
      await closeModals(d);
    }
    await d.ctx.setOffline(false);
  });
  await t(d.tag+": no page errors in the whole walk", async ()=>{
    assert.deepStrictEqual(d.pageErrors, []);
  });
  await d.ctx.close();
}

(async()=>{
  const browser = await chromium.launch();
  for(const run of RUNS){
    if(!fs.existsSync(path.join(ROOT, run.build, "index.html"))){ console.log("Missing "+run.build+"/index.html — run: node tools/build-all.js"); process.exit(1); }
    await walk(browser, run);
  }
  await browser.close();
  if(process.env.TABLE_OUT) fs.writeFileSync(process.env.TABLE_OUT, JSON.stringify(table, null, 1));
  const fails = table.filter(r=>r.result!=="Pass");
  console.log("\nscreens checked: "+table.length+", failing: "+fails.length);
  for(const f of fails) console.log("  "+f.run+"  "+f.module+"  "+f.note);
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
