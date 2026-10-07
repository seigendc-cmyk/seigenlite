// Run: node --no-warnings test/returns-e2e.test.js   (build first: node build.js && node build.js --tauri)
// Phase 3c returns in a REAL browser (Playwright/Chromium), on the phone build
// (dist/, 390px) and the desktop build (dist-tauri/, 1280px). An unregistered
// shop, fully offline (no server at all):
//   sell → Reports → Returns → find receipt → choose items (one back to stock,
//   one written off) → refund the same way → Admin passcode → credit note +
//   slip → End of Day shows the cash refund → Report Writer: Returns report,
//   the credit note slip, Item Ledger → an exchange through the cart.
// SHOT_DIR=<dir> saves screenshots.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
const BUILDS = { phone: path.join(ROOT, "dist", "index.html"), desktop: path.join(ROOT, "dist-tauri", "index.html") };
for(const b of Object.values(BUILDS)) if(!fs.existsSync(b)){ console.log("Missing "+b+" — run: node build.js && node build.js --tauri"); process.exit(1); }
const SHOTS = process.env.SHOT_DIR || "";
if(SHOTS) fs.mkdirSync(SHOTS, { recursive:true });

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const fileUrl = (p)=> "file:///" + p.replace(/\\/g, "/");
async function waitFor(cond, what, ms){
  const deadline = Date.now() + (ms||15000);
  while(!(await cond())){ if(Date.now() > deadline) throw new Error("timed out waiting for "+what); await new Promise(r=>setTimeout(r, 150)); }
}

async function device(browser, kind){
  const desktop = kind==="desktop";
  const ctx = await browser.newContext({ viewport: desktop? { width:1280, height:800 } : { width:390, height:844 } });
  const page = await ctx.newPage();
  const pageErrors = [], dialogs = [];
  page.on("pageerror", e=>pageErrors.push(e.message));
  page.on("dialog", d=>{ dialogs.push(d.message()); d.type()==="prompt"? d.accept("Tendai") : d.accept(); });
  await page.addInitScript(()=>{ window.print = ()=>{}; window.open = ()=>null; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-rt-"));
  fs.copyFileSync(BUILDS[kind], path.join(dir, "index.html"));
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#setShop", { timeout:30000 });
  return { ctx, page, pageErrors, dialogs, desktop, kind };
}
const shot = async (d, name)=>{ if(SHOTS) await d.page.screenshot({ path: path.join(SHOTS, d.kind+"-"+name+".png"), fullPage:false }); };
async function nav(d, route){
  if(d.desktop){ await d.page.click("#hamburgerBtn"); await d.page.click('#navDrawer [data-route="'+route+'"]'); }
  else await d.page.click('.navbar [data-route="'+route+'"]');
}
async function moreTab(d, tab){
  await nav(d, "more");
  await d.page.click('[data-kebab-toggle="moretab"]');
  await d.page.click('[data-tab="'+tab+'"]');
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
async function addToCart(d, name){
  if(d.desktop) await d.page.click(`tr:has-text("${name}") .ds-add-btn`);
  else await d.page.click(`.product-row:has-text("${name}") .add-chip`);
}
async function payCash(d){
  if(d.desktop) await d.page.click("#dsPayCash");
  else { await d.page.click("#cartBtn"); await d.page.click("#payCash"); }
}
// the phone shows "Receipt #n" above the products; the desktop cart has no last-receipt card
const saleDone = (d, id)=> d.page.evaluate((id)=>!!(window._lastReceipt && window._lastReceipt.saleId===id), id);
const modal = (d)=> d.page.locator(".modalOverlay").last();

async function scenario(browser, kind){
  const d = await device(browser, kind);
  const p = d.page;
  await t(kind+": setup, products, Admin passcode, a shift, a cash sale (2 Rice + 1 Soap)", async ()=>{
    await p.fill("#setShop", "Gentronix"); await p.fill("#setBranch", "Harare"); await p.fill("#setSecret", "Gold Leaf 42");
    await p.click("#setupNext"); await p.click("#setupNext2"); await p.click("#setupNext3"); await p.click("#setupFinish");
    await p.waitForSelector("[data-route]");
    await addProduct(d, { name:"Rice 2kg", sku:"RICE", price:10, cost:6, stock:30 });
    await addProduct(d, { name:"Soap bar", sku:"SOAP", price:5, cost:3, stock:20 });
    await addProduct(d, { name:"Oil 2L", sku:"OIL", price:20, cost:12, stock:10 });
    await moreTab(d, "settings");
    await p.click("#openAddStaff");
    await p.fill("#stName", "Owner"); await p.selectOption("#stRole", "Admin"); await p.fill("#stPasscode", "1234"); await p.fill("#stPin", "4821");
    await p.click("#stConfirm");
    await p.waitForSelector(".modalOverlay", { state:"detached" });
    await p.click("#userChip");                                             // the cashier signs in: the return is recorded against her
    await waitFor(async()=> (await p.textContent("#userChip"))==="Tendai", "the cashier signed in");
    await startShift(d);
    await addToCart(d, "Rice 2kg"); await addToCart(d, "Rice 2kg"); await addToCart(d, "Soap bar");
    await payCash(d);
    await waitFor(()=>saleDone(d, 1), "the sale");
  });

  await t(kind+": Reports → Returns: a wrong number is refused; #1 opens the return (step 1: items)", async ()=>{
    await nav(d, "reports");
    await p.fill("#rtFindInput", "T2-0001"); await p.click("#rtFindBtn");
    assert.strictEqual(await p.textContent("#rtFindMsg"), "Receipt T2-0001 wasn't found on this till.");
    await p.locator("#rtFindInput").scrollIntoViewIfNeeded();
    await shot(d, "1-find-receipt");
    await p.fill("#rtFindInput", "#1"); await p.click("#rtFindBtn");
    await p.waitForSelector(".return-flow .rt-line", { timeout:8000 }).catch(async e=>{
      throw new Error("no return modal; message: "+(await p.textContent("#rtFindMsg"))+"; dialogs: "+JSON.stringify(d.dialogs)+"; errors: "+JSON.stringify(d.pageErrors)); });
    assert.match(await modal(d).textContent(), /Sold 2 · returned 0 · can return 2/);
    await shot(d, "2-items");
  });

  await t(kind+": choose 1 Rice back to stock and the Soap written off; step 2: refund the same way, reason", async ()=>{
    await p.click('.rt-line:has-text("Rice 2kg") [data-rt-inc]');
    await p.click('.rt-line:has-text("Soap bar") [data-rt-inc]');
    await p.selectOption('.rt-line:has-text("Soap bar") select', "writeoff");
    assert.strictEqual(await p.textContent("#rtTotal"), "$15.00");
    await shot(d, "3-items-chosen");
    await p.click("#rtNext");
    await p.waitForSelector("[name=rtMethod]");
    assert.ok(await p.isDisabled('input[name=rtMethod][value=debtor]'), "debtor is only for credit sales");
    assert.match(await modal(d).textContent(), /Only for a sale on credit\./);
    await p.selectOption("#rtReason", "Faulty / damaged");
    await p.fill("#rtNote", "soap wrapper torn");
    assert.match(await modal(d).textContent(), /Cash refunded\s*\$15\.00/);
    await shot(d, "4-refund");
    await p.click("#rtNext");
    await p.waitForSelector("#rtPass");
  });

  await t(kind+": step 3: the Admin passcode (wrong one refused), save; step 4: credit note CN0001 and its slip", async ()=>{
    assert.match(await modal(d).textContent(), /1 x Rice 2kg \(back to stock\)[\s\S]*1 x Soap bar \(written off\)/);
    await shot(d, "5-approve");
    await p.fill("#rtPass", "0000"); await p.click("#rtSave");
    await waitFor(async()=> /Incorrect Admin passcode/.test(await p.textContent("#rtErr")), "the refusal");
    await p.fill("#rtPass", "1234"); await p.click("#rtSave");
    await waitFor(async()=> /Credit note CN0001 saved\./.test(await modal(d).textContent()), "the credit note");
    const slip = await p.textContent(".return-flow .cn-slip");
    for(const bit of ["CREDIT NOTE CN0001","Original receipt #1","Rice 2kg","(back to stock)","(written off)","Cash refunded","Started by Tendai","Authorised by Owner"])
      assert.ok(slip.includes(bit), "slip: "+bit+"\n"+slip);
    await shot(d, "6-done-slip");
    await p.click("#cnPrint"); await p.click("#cnPdf"); await p.click("#cnWa");
    await p.click("#rtClose");
  });

  await t(kind+": End of Day shows the return and the cash refund; expected cash = float + cash − refund", async ()=>{
    await nav(d, "reports");
    await p.waitForSelector(".eod-returns");
    const txt = await p.textContent("#eodSection");
    assert.match(txt, /Less: Returns \(1\)\s*-\$15\.00/);
    assert.match(txt, /Cash refunded\s*-\$15\.00/);
    assert.match(txt, /Net Sales\s*\$10\.00/);
    assert.match(txt, /cash sales − payouts − cash refunds = expected cash/);
    await p.locator(".eod-returns").scrollIntoViewIfNeeded();
    await shot(d, "7-eod-cash-refund");
  });

  await t(kind+": Report Writer: the Returns report, the credit note slip from it, and the Item Ledger", async ()=>{
    await moreTab(d, "reportwriter");
    await p.selectOption("#rwTypeSel", "returns");
    await p.waitForSelector('[data-rw-filter="condition"]');
    await p.click("#rwView");
    await p.waitForSelector("[data-view-cn]");
    assert.match(await p.textContent("#rwResults"), /1 credit note · \$15\.00 · Cash \$15\.00 · 1 unit\(s\) back to stock, 1 written off/);
    await p.locator("#rwResults").scrollIntoViewIfNeeded();
    await shot(d, "8-returns-report");
    await p.click("[data-view-cn]");
    await p.waitForSelector(".modalOverlay .cn-slip");
    await shot(d, "9-credit-note-slip");
    await p.click(".modalOverlay [data-modal-close]");
    await p.selectOption("#rwTypeSel", "itemledger");
    await p.waitForSelector('[data-rw-filter="product"]');
    await p.selectOption('[data-rw-filter="product"]', { label:"RICE · Rice 2kg" });
    await p.click("#rwView");
    await waitFor(async()=> /closing 29/.test(await p.textContent("#rwResults")), "the ledger");
    assert.match(await p.textContent("#rwResults"), /Return \(back to stock\)/);
    await shot(d, "10-item-ledger");
  });

  await t(kind+": exchange: Oil returned for Soap — the credit covers it, the difference back in cash, one save", async ()=>{
    await nav(d, "pos");
    await addToCart(d, "Oil 2L"); await payCash(d);
    await waitFor(()=>saleDone(d, 2), "the Oil sale");
    await nav(d, "reports");
    await p.fill("#rtFindInput", "2"); await p.click("#rtFindBtn");
    await p.waitForSelector(".return-flow .rt-line");
    await p.click('.rt-line:has-text("Oil 2L") [data-rt-inc]');
    await p.click("#rtNext");
    await p.check('input[name=rtMethod][value=exchange]');
    await p.selectOption("#rtReason", "Wrong item");
    await p.click("#rtNext");
    await p.fill("#rtPass", "1234");
    await p.click("#rtSave");
    await waitFor(async()=> /Exchange credit/.test(await p.textContent("body")), "the exchange in the cart");
    if(!d.desktop){ await p.click("#closeDrawer").catch(()=>{}); }
    await addToCart(d, "Soap bar");
    if(!d.desktop) await p.click("#cartBtn");
    await waitFor(async()=> !!(await p.$("#payExchange")), "Complete exchange");
    assert.match(await p.textContent(".exchange-box"), /Exchange credit \(receipt #2\)\s*−\$5\.00[\s\S]*\$15\.00 goes back the same way they paid/);
    await shot(d, "11-exchange-cart");
    await p.click("#payExchange");
    await waitFor(async()=> /Credit note CN0002 \(exchange\)/.test(await p.textContent("main")), "the exchange saved");
    await shot(d, "12-exchange-done");
    await p.click("#lastCnBtn");
    await p.waitForSelector(".modalOverlay .cn-slip");
    const slip = await p.textContent(".modalOverlay .cn-slip");
    assert.match(slip, /CREDIT NOTE CN0002[\s\S]*1 x Oil 2L[\s\S]*Exchange \(receipt #3\)\s*\$5\.00[\s\S]*Cash refunded\s*\$15\.00/);
    await shot(d, "13-exchange-slip");
    assert.deepStrictEqual(d.pageErrors, []);
  });
  await d.ctx.close();
}

(async()=>{
  const browser = await chromium.launch();
  await scenario(browser, "phone");
  await scenario(browser, "desktop");
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
