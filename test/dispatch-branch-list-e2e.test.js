// Run: node --no-warnings test/dispatch-branch-list-e2e.test.js
// (build first: node build.js --pwa && node build.js --tauri)
// The Dispatch dialog's destination list follows seiGEN's branch list (IVO,
// 2026-10-14: Warehouse's till said "File only: Norton isn't a branch of IVO
// Motor Spares" after Norton had joined, because its saved copy of the
// business's branches was older than the join). In a REAL browser, both
// builds. seiGEN is answered here (never the live one): the check-in, and
// cl_branch_list, which first gives the old list (Warehouse only) and then,
// slowly, the new one (Warehouse, Norton, Harare).
//   * opened with the old list: a local "norton" from Destination branches is
//     file only; the joined branches aren't there yet
//   * the new list lands while the dialog is open: "norton" moves to Through
//     seiGEN (same branch: case, spaces and punctuation don't matter), Harare
//     appears, the chosen branch and the lines stay, File only becomes
//     "Goes through seiGEN"
//   * a name only this device knows (Bulawayo) stays "(file only)", with the reason
"use strict";
require("./dist-fresh");   // stop here if a bundle is older than its source (node tools/build-all.js)
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { activateForTest, writeSettings } = require("./test-activation");
const { TEST_PHRASE } = require("./dc-fake");

let chromium;
require("./local-cdn");   // the cdnjs files from test/cdn/, not the internet
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
for(const b of ["dist-pwa","dist-tauri"]) if(!fs.existsSync(path.join(ROOT,b,"index.html"))){ console.log("Missing "+b+" — run: node build.js --pwa && node build.js --tauri"); process.exit(1); }

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
async function waitFor(cond, what, ms){
  const deadline = Date.now() + (ms || 10000);
  while(!(await cond())){ if(Date.now() > deadline) throw new Error("timed out waiting for "+what); await new Promise(r=>setTimeout(r, 100)); }
}
const fileUrl = (p)=> "file:///" + p.replace(/\\/g, "/");
const IDS = { biz:"32f8d976-0000-4000-8000-000000000001", wh:"476b5b1e-0000-4000-8000-000000000002", norton:"71499f68-0000-4000-8000-000000000003",
  harare:"4d543599-0000-4000-8000-000000000004", till:"361300b3-0000-4000-8000-000000000005" };
const OLD = [{ id:IDS.wh, name:"Warehouse", is_main:true }];
const NEW = OLD.concat([{ id:IDS.norton, name:"Norton", is_main:false }, { id:IDS.harare, name:"Harare", is_main:false }]);

async function dbWrite(page, sql){
  await page.evaluate(async (sql)=>{
    const open = ()=> new Promise((res, rej)=>{ const r = indexedDB.open("seigen_lite_db", 1); r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); });
    const conn = await open();
    const bytes = await new Promise((res, rej)=>{ const g = conn.transaction("kv","readonly").objectStore("kv").get("dbfile"); g.onsuccess = ()=>res(g.result); g.onerror = ()=>rej(g.error); });
    const SQL = await initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/"+f });
    const d = new SQL.Database(new Uint8Array(bytes));
    d.run(sql);
    const out = d.export(); d.close();
    await new Promise((res, rej)=>{ const tx = conn.transaction("kv","readwrite"); tx.objectStore("kv").put(out, "dbfile"); tx.oncomplete = ()=>res(); tx.onerror = ()=>rej(tx.error); });
  }, sql);
}
async function gotoRoute(page, route, desktop){
  if(desktop){ await page.click("#hamburgerBtn"); await page.click('#navDrawer [data-route="'+route+'"]'); }
  else await page.click('.navbar [data-route="'+route+'"]');
}
// The destination <select> as the user sees it: [group label, option text, value] per option.
const destOptions = (page)=> page.evaluate(()=> Array.from(document.querySelectorAll("#doDest option")).filter(o=>o.value)
  .map(o=> [o.parentElement.tagName==="OPTGROUP"? o.parentElement.label : "", o.textContent, o.value]));

async function runFor(browser, build){
  const desktop = build === "dist-tauri";
  const ctx = await browser.newContext({ viewport: desktop? { width:1280, height:800 } : { width:390, height:844 } });
  const srv = { list: OLD, delayMs: 0, calls: 0 };
  await ctx.route(/urbopdsubwawtybwrxjd\.supabase\.co/, async route=>{
    const url = route.request().url();
    if(/\/rpc\/cl_device_checkin$/.test(url))
      return route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify({ vendor_id:"22222222-2222-4222-8222-222222222222", status:"active",
        lock_cart:false, lock_add_product:false, lock_reason:null, cycle_start_date:"2026-09-01", messages:[], business_id:IDS.biz, terminal_id:IDS.till, terminal_active:true, min_build:21 }) });
    if(/\/rpc\/cl_branch_list$/.test(url)){
      srv.calls++;
      const list = srv.list, delay = srv.delayMs;
      if(delay) await new Promise(r=>setTimeout(r, delay));
      return route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify({ branches: list }) });
    }
    return route.abort();                                    // nothing else reaches "seiGEN" here
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("dialog", d=> d.accept());
  page.on("pageerror", e=> errors.push(e.message));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-dbl-"));
  for(const f of fs.readdirSync(path.join(ROOT, build))) fs.copyFileSync(path.join(ROOT, build, f), path.join(dir, f));
  await page.goto(fileUrl(path.join(dir, "index.html")));
  await page.waitForSelector("#setShop", { timeout: 20000 });
  await page.fill("#setShop", "IVO Motor Spares"); await page.fill("#setBranch", "Warehouse"); await page.fill("#setSecret", TEST_PHRASE);
  await page.click("#setupNext"); await page.fill("#setOwnerPhone", "0771234567"); await page.click("#setupNext2"); await page.click("#setupNext3"); await page.click("#setupFinish");
  await page.waitForSelector("#logoutBtn");
  await page.waitForTimeout(800);
  // Warehouse's main till on seiGEN, with an OLD copy of the branch list; Destination branches holds
  // "norton" (typed here long ago, other spelling) and "Bulawayo" (never on seiGEN)
  await writeSettings(page, [["terminal_id", IDS.till], ["business_id", IDS.biz], ["business_name", "IVO Motor Spares"], ["branch_uuid", IDS.wh],
    ["terminal_branch_name", "Warehouse"], ["terminal_is_main", "1"], ["ds_branches", JSON.stringify(OLD)], ["ds_branches_ts", new Date().toISOString()]]);
  await dbWrite(page, "INSERT INTO branch_register(name,whatsapp) VALUES('norton ',''),('Bulawayo','')");
  await activateForTest(page, { name: "Tendai" });
  await gotoRoute(page, "products", desktop);
  await page.click("#openAddProduct"); await page.waitForSelector("#pName");
  await page.fill("#pName", "Brake pads"); await page.fill("#pSku", "BP-01"); await page.fill("#pPrice", "12"); await page.fill("#pStock", "40");
  await page.click("#pConfirm"); await page.waitForSelector(".modalOverlay", { state: "detached" });
  return { ctx, page, srv, errors, desktop };
}

(async()=>{
  const browser = await chromium.launch();
  for(const build of ["dist-tauri", "dist-pwa"]){
    const tag = build+": ";
    const s = await runFor(browser, build);
    const { page, srv } = s;

    await t(tag+"opened with an OLD copy of seiGEN's list: the local names are marked file only, and choosing one says why", async ()=>{
      srv.list = NEW; srv.delayMs = 2500;                   // seiGEN now has Norton and Harare; its answer is slow
      await page.click("#openDispatch");
      await page.waitForSelector("#doDest");
      assert.deepStrictEqual(await destOptions(page), [
        ["File only (not on seiGEN)", "Bulawayo (file only)", "Bulawayo"],
        ["File only (not on seiGEN)", "norton  (file only)", "norton "]]);
      await page.selectOption("#doDest", "norton ");
      await page.waitForSelector("#doFileOnly");
      assert.match(await page.textContent("#doFileOnly"), /File only: not through seiGEN\. norton isn't a branch of IVO Motor Spares on seiGEN/);
      await page.fill("#doSearch", "BP-01"); await page.press("#doSearch", "Enter");
      await page.waitForSelector("[data-qty]");
      await page.fill("[data-qty]", "5");
    });

    await t(tag+"seiGEN's new list lands while the dialog is open: norton is the joined Norton (through seiGEN), Harare appears; choice and lines kept", async ()=>{
      await waitFor(async()=> !!(await page.$("#doSrvBox")), "the dialog to follow seiGEN's list");
      assert.deepStrictEqual(await destOptions(page), [
        ["Through seiGEN", "Harare", "Harare"],
        ["Through seiGEN", "norton ", "norton "],
        ["File only (not on seiGEN)", "Bulawayo (file only)", "Bulawayo"]]);
      assert.strictEqual(await page.$eval("#doDest", el=> el.value), "norton ", "the chosen branch is kept");
      assert.strictEqual(await page.$("#doFileOnly"), null, "no File only box");
      assert.match(await page.textContent("#doSrvBox"), /Goes through seiGEN to Norton: they count it in Incoming dispatches/);
      assert.strictEqual(await page.$eval("[data-qty]", el=> el.value), "5", "the line and its quantity are kept");
    });

    await t(tag+"Harare (joined, not in Destination branches) goes through seiGEN; Bulawayo stays file only, with the reason", async ()=>{
      await page.selectOption("#doDest", "Harare");
      await page.waitForSelector("#doSrvBox");
      assert.match(await page.textContent("#doSrvBox"), /Goes through seiGEN to Harare/);
      await page.selectOption("#doDest", "Bulawayo");
      await page.waitForSelector("#doFileOnly");
      assert.match(await page.textContent("#doFileOnly"), /Bulawayo isn't a branch of IVO Motor Spares on seiGEN/);
    });

    await t(tag+"reopened: the saved list is the new one, so it's right from the start (no wait)", async ()=>{
      await page.click(".modalOverlay [data-modal-close]");
      srv.delayMs = 0;
      await page.click("#openDispatch");
      await page.waitForSelector("#doDest");
      const opts = await destOptions(page);
      assert.deepStrictEqual(opts.map(o=>o[0]+"|"+o[2]), ["Through seiGEN|Harare", "Through seiGEN|norton ", "File only (not on seiGEN)|Bulawayo"]);
      await page.click(".modalOverlay [data-modal-close]");
    });

    await t(tag+"no page errors", async ()=>{ assert.deepStrictEqual(s.errors, []); });
    await s.ctx.close();
  }
  await browser.close();
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
