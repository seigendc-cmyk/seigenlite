// Run: node --no-warnings test/module-run-v371-round2-e2e.test.js   (build first: node tools/build-all.js)
// v37.1 Part 5, round 2: the module walk on tills registered with seiGEN, in a
// REAL browser (Playwright/Chromium). seiGEN is the REAL server SQL (every
// migration, v37.1's 20261117120000_srq_drafts included) in an in-memory
// PGlite: every /rest/v1/rpc/<name> call is answered by running that function
// as role anon; any other Supabase request is blocked. Nothing reaches live.
//   * two branches: Harare (main, desktop build, 1280 px) and Murehwa (phone
//     build, 390 px), plus an Office seat at main (phone build)
//   * the built-in roles, each signed in with a seiGEN PIN: Owner, Admin,
//     Manager, Stores, Cashier at main; Stores and Cashier at Murehwa; a
//     Manager and a Guest on the seat. Each walks every menu entry and More tab
//     it has (every screen renders, no page error, no "undefined"/"NaN"); what
//     a role must not have is checked
//   * stock requests through the drafts (decision 63): wrong input refused,
//     part-approval, the draft at main (Products and Dispatch), the request at
//     both ends, a raise refused, a lowered line, the DN, the GRV
//   * the dispatch reminder (decision 64), with main's clock moved on by
//     Playwright (every device starts at 05:00 today, so the day never changes): none at
//     7 h 50, the bell at 8 h for the Dispatch people and the approver, never
//     for a Cashier; Settings → the timers (Admin), 2 h / 6 h; a second draft
//     reminds at 2 h; closed with a reason (both ends); the reminder goes away
// SHOT_DIR=<dir> saves the screenshots (the new screens at 390 and 1280 px).
// TABLE_OUT=<file> writes the module table rows (JSON).
"use strict";
require("./dist-fresh");   // stop here if a bundle is older than its source (node tools/build-all.js)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");
const { activateForTest, passJoinTrialScreen, addAdminForTest, writeSettings } = require("./test-activation");

let chromium;
require("./local-cdn");   // the cdnjs files from test/cdn/, not the internet
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
const BUILDS = { phone: path.join(ROOT, "dist-pwa"), desktop: path.join(ROOT, "dist-tauri") };
for(const b of Object.values(BUILDS)) if(!fs.existsSync(path.join(b, "index.html"))){ console.log("Missing "+b+"/index.html — run: node tools/build-all.js"); process.exit(1); }
const SHOTS = process.env.SHOT_DIR || "";
if(SHOTS) fs.mkdirSync(SHOTS, { recursive:true });
const BAD_TEXT = /\bundefined\b|\bNaN\b|\[object Object\]/;
const PHRASE = "Gold Leaf 42";
const MIN = 60000, HOUR = 60*MIN;
const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-A156E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";

let passed=0, failed=0;
const table = [];   // { run, module, result, note }
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const fileUrl = (p)=> "file:///" + p.replace(/\\/g, "/");
async function waitFor(cond, what, ms){
  const deadline = Date.now() + (ms||15000);
  while(!(await cond())){ if(Date.now() > deadline) throw new Error("timed out waiting for "+what); await new Promise(r=>setTimeout(r, 150)); }
}
const text = async (d, sel)=> ((await d.page.textContent(sel || "body").catch(()=>""))||"").replace(/\s+/g, " ");
const gone = (d, sel)=> d.page.waitForSelector(sel, { state:"detached", timeout:30000 });
// a screenshot at the device's own width and at the other one (390 / 1280)
// sel: an element to bring back into view after the viewport changes (a resize loses the scroll)
async function shots(d, name, sel){
  if(!SHOTS) return;
  const into = async()=>{ if(sel){ const el = await d.page.$(sel); if(el) await el.scrollIntoViewIfNeeded(); } };
  const own = d.desktop? 1280 : 390;
  await d.page.screenshot({ path: path.join(SHOTS, name+"-"+own+".png") });
  await d.page.setViewportSize(d.desktop? { width:390, height:844 } : { width:1280, height:800 });
  await d.page.waitForTimeout(250);
  await into();
  await d.page.screenshot({ path: path.join(SHOTS, name+"-"+(d.desktop? 390 : 1280)+".png") });
  await d.page.setViewportSize(d.desktop? { width:1280, height:800 } : { width:390, height:844 });
  await d.page.waitForTimeout(150);
}

let pg;
let queue = Promise.resolve();
function serverCall(name, body){
  const run = async ()=>{
    const keys = Object.keys(body);
    const vals = keys.map(k=> (body[k] !== null && typeof body[k] === "object")? JSON.stringify(body[k]) : body[k]);
    await pg.exec("set role anon");
    try{ return { status:200, json:(await pg.query(`select to_json(public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(",")})) j`, vals)).rows[0].j }; }
    catch(e){ return { status:400, json:{ code:"P0001", message:e.message } }; }
    finally{ await pg.exec("reset role"); }
  };
  const p = queue.then(run, run); queue = p.catch(()=>{}); return p;
}
const sq = (sql, p)=>{ const run = async ()=> (await pg.query(sql, p)).rows; const r = queue.then(run, run); queue = r.catch(()=>{}); return r; };

const STANDALONE = ()=>{
  const real = window.matchMedia ? window.matchMedia.bind(window) : null;
  window.matchMedia = (q)=> /display-mode:\s*standalone/.test(q)
    ? { matches:true, media:q, onchange:null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } }
    : (real? real(q) : { matches:false, media:q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
};
// o.clock: a Date the device's clock starts at (Playwright's clock; it then runs on in real time)
async function device(browser, kind, name, o){
  o = o||{};
  const desktop = kind==="desktop";
  const ctx = await browser.newContext({ viewport: desktop? { width:1280, height:800 } : { width:390, height:844 },
    timezoneId:"Africa/Harare", userAgent:o.ua, acceptDownloads:true });
  await ctx.route(/supabase\.co\//, route=> route.abort());
  await ctx.route(/supabase\.co\/rest\/v1\/rpc\/([a-z_]+)$/, async route=>{
    const fn = /\/rpc\/([a-z_]+)$/.exec(route.request().url())[1];
    let body = {}; try{ body = JSON.parse(route.request().postData()||"{}"); }catch(e){}
    const r = await serverCall(fn, body);
    return route.fulfill({ status:r.status, contentType:"application/json", headers:{ "access-control-allow-origin":"*" }, body:JSON.stringify(r.json) });
  });
  if(o.clock) await ctx.clock.install({ time:o.clock });
  if(o.standalone) await ctx.addInitScript(STANDALONE);
  await ctx.addInitScript(()=>{ window.print = ()=>{}; window.open = ()=>null; });
  const page = await ctx.newPage();
  const d = { ctx, page, desktop, name, pageErrors:[], dialogs:[], promptText:"" };
  page.on("pageerror", e=> d.pageErrors.push(e.message));
  page.on("dialog", async x=>{ d.dialogs.push(x.message()); x.type()==="prompt"? await x.accept(d.promptText) : await x.accept(); });
  page.on("download", (dl)=>{ dl.cancel().catch(()=>{}); });
  const src = BUILDS[kind];
  const dir = o.dir || fs.mkdtempSync(path.join(os.tmpdir(), "seigen-mr2-"));
  if(!o.dir){ fs.copyFileSync(path.join(src, "index.html"), path.join(dir, "index.html")); if(fs.existsSync(path.join(src, "vendor"))) fs.cpSync(path.join(src, "vendor"), path.join(dir, "vendor"), { recursive:true }); }
  d.dir = dir; d.url = fileUrl(path.join(dir, "index.html"));
  await page.goto(d.url + (o.hash || ""));
  return d;
}
async function nav(d, route){
  if(d.desktop){ await d.page.click("#hamburgerBtn"); await d.page.click('#navDrawer [data-route="'+route+'"]'); }
  else await d.page.click('.navbar [data-route="'+route+'"]');
  await d.page.waitForTimeout(150);
}
async function routes(d){
  if(!d.desktop) return d.page.$$eval(".navbar [data-route]", els=>els.map(e=>e.dataset.route));
  await d.page.click("#hamburgerBtn");
  const r = await d.page.$$eval("#navDrawer [data-route]", els=>els.map(e=>e.dataset.route));
  await d.page.click("#closeNavDrawer");
  return r;
}
async function moreTabs(d){
  await nav(d, "more");
  return d.page.$$eval("[data-tab]", els=> els.map(e=>({ id:e.dataset.tab, label:e.textContent.trim() })));
}
async function moreTab(d, tab){
  await nav(d, "more");
  await d.page.click('[data-kebab-toggle="moretab"]');
  await d.page.click('[data-tab="'+tab+'"]');
  await d.page.waitForTimeout(250);
}
async function closeModals(d){
  for(let i=0; i<4 && await d.page.$(".modalOverlay"); i++){
    const x = await d.page.$(".modalOverlay .close-x, .modalOverlay [data-modal-close]");
    if(x) await x.click().catch(()=>{}); else await d.page.keyboard.press("Escape");
    await d.page.waitForTimeout(150);
  }
}
async function openSettings(d){
  await moreTab(d, "settings");
  if(await d.page.$("#settingsPasscode")){ await d.page.fill("#settingsPasscode", "admin123"); await d.page.click("#unlockSettings"); }
  await d.page.waitForSelector("#terminalCard");
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
async function credentials(install){ return (await sq("select install_id, shop_secret_phrase, device_key from cl_vendors where install_id=$1",[install]))[0]; }
async function openStaffCard(d){
  for(let i = 0; i < 30; i++){
    await openSettings(d);
    if(await d.page.$("#shopStaffCard")) return;
    await d.page.waitForTimeout(500);
  }
  throw new Error("no Staff & Roles card");
}
async function addPerson(d, o){
  await d.page.click("#addShopStaff");
  await d.page.waitForSelector("#ssName");
  await d.page.fill("#ssName", o.name);
  await d.page.selectOption("#ssRole", { label:o.role });
  if(o.branch) await d.page.selectOption("#ssHome", { label:o.branch });
  await d.page.fill("#ssPin", o.pin);
  if(o.adminPass) await d.page.fill("#ssAdminPass", o.adminPass);
  await d.page.click("#ssSave");
  await d.page.waitForSelector("#ssName", { state:"detached", timeout:30000 });
}
// The "Who's working today?" screen: (Log out,) Sign in, the name, the PIN.
async function signInAs(d, name, pin){
  await closeModals(d);
  await d.page.waitForSelector("#startSignIn, #logoutBtn", { timeout:30000 });
  if(!(await d.page.$("#startSignIn"))){ await d.page.click("#logoutBtn"); }
  await d.page.waitForSelector("#startSignIn", { timeout:30000 }); await d.page.click("#startSignIn");
  await d.page.waitForSelector("#whoSelect");
  await d.page.selectOption("#whoSelect", { label:name });
  await d.page.click("#whoSelectContinue");
  await d.page.fill("#whoPin", pin); await d.page.click("#whoPinContinue");
  await d.page.waitForSelector("#logoutBtn", { timeout:30000 });
  await waitFor(async()=> (await d.page.textContent("#userChip")).trim()===name, "signed in as "+name);
}
// signed in as `name` still (after a clock jump the session may have ended)
async function stillSignedIn(d, name, pin){
  const chip = await d.page.$("#userChip");
  if(!chip || (await chip.textContent()).trim()!==name) await signInAs(d, name, pin);
}
// a bell check now: the bell checks at once when the till comes back online
async function bellCheck(d){
  await d.ctx.setOffline(true); await d.page.waitForTimeout(300);
  await d.ctx.setOffline(false); await d.page.waitForTimeout(2500);
}
async function bellTitles(d){
  await closeModals(d);
  await d.page.click("#bellBtn");
  await d.page.waitForSelector("#bellBody");
  const r = await d.page.$$eval("#bellList .bell-item", els=> els.map(e=> e.innerText.replace(/\s+/g, " ")));
  return r;
}
// More → Stock requests & recalls, on its Stock requests sub-tab (the screen keeps the last sub-tab)
async function stockRequests(d){
  await moreTab(d, "stockctl");
  await d.page.click('[data-srq-tab="requests"]');
  await d.page.waitForTimeout(200);
}
// a stock-control check (Refresh on that screen)
async function srqRefresh(d){
  await stockRequests(d);
  await d.page.click("#srqRefresh");
  await d.page.waitForTimeout(1500);
  await stockRequests(d);
}
async function openRequest(d, reqNo){
  await stockRequests(d);
  await d.page.click(`#srqTable tr:has-text("${reqNo}")`);
  await d.page.waitForSelector("#srqHist");
}

// what a screen must be: something rendered, no page error since `from`, no broken text
async function checkScreen(d, run, module, from, sel){
  const s = (await d.page.$eval(sel || "#main", el=>el.innerText).catch(()=>"")) || "";
  const errs = d.pageErrors.slice(from);
  let result = "Pass", note = "";
  if(!s.trim()){ result = "Fails"; note = "empty screen"; }
  else if(errs.length){ result = "Fails"; note = "page error: "+errs[0]; }
  else { const m = BAD_TEXT.exec(s); if(m){ result = "Fails"; note = 'shows "'+m[0]+'": …'+s.slice(Math.max(0, m.index-60), m.index+40).replace(/\s+/g, " ")+"…"; } }
  table.push({ run, module, result, note });
  return { result, note };
}
const must = (r, what)=> assert.strictEqual(r.result, "Pass", what+": "+r.note);
// One role's walk: every menu entry and More tab it has (Settings as it opens for that person).
async function roleWalk(d, who){
  const run = d.name+" · "+who;
  const rs = await routes(d);
  for(const r of rs){
    const from = d.pageErrors.length;
    await nav(d, r);
    must(await checkScreen(d, run, "Menu › "+r, from), run+" "+r);
  }
  const tabs = await moreTabs(d);
  for(const tab of tabs){
    const from = d.pageErrors.length;
    await moreTab(d, tab.id);
    must(await checkScreen(d, run, "More › "+tab.label, from), run+" "+tab.label);
    for(const attr of ["data-srq-tab", "data-dstab", "data-cycle-tab"]){
      const ids = await d.page.$$eval("["+attr+"]", (els, a)=> els.map(e=>e.getAttribute(a)), attr);
      for(const id of [...new Set(ids)]){
        const b = await d.page.$("["+attr+'="'+id+'"]');
        if(!b || !(await b.isVisible())) continue;
        const f2 = d.pageErrors.length;
        await b.click(); await d.page.waitForTimeout(250);
        must(await checkScreen(d, run, "More › "+tab.label+" › "+id, f2), run+" "+tab.label+" › "+id);
      }
    }
    await closeModals(d);
  }
  table.push({ run, module:"What this role has", result:"Pass", note:"menu: "+rs.join(", ")+" · More: "+tabs.map(x=>x.id).join(", ") });
  return { routes:rs, tabs:tabs.map(x=>x.id) };
}

// Every device's clock runs SHIFT behind real time, so the run starts at 05:00 today in Harare and 8 h + 2 h of
// reminders stay inside one business day. Only main's clock is then moved on (setSystemTime).
const SHIFT = (()=>{ const day = new Intl.DateTimeFormat("en-CA", { timeZone:"Africa/Harare" }).format(new Date());
  return Date.now() - new Date(day+"T05:00:00+02:00").getTime(); })();
const shiftedNow = ()=> new Date(Date.now() - SHIFT);

(async()=>{
  pg = await newPglite();
  await buildFromRepo(pg, { skip: [] });   // every migration: the live shape, v37.1 included
  await pg.exec("update public.cl_shop_meta set v = now() + interval '1 day' where k = 'legacy_cutoff'");
  const browser = await chromium.launch();
  let A, C, S, mainInstall, harare, murehwa, req1 = "", req2 = "", approvedAt1 = 0, approvedAt2 = 0, seatCode = "";
  const issue = async (o)=>{
    const m = await credentials(mainInstall), s = require("../supabase/tests/rebuild-helpers").v21AdminSeed("admin123");
    return (await serverCall("cl_branch_issue_join_code", Object.assign({ p_install_id:m.install_id, p_secret_phrase:m.shop_secret_phrase, p_device_key:m.device_key,
      p_admin_salt:s.salt, p_admin_check:s.check, p_admin_rounds:s.rounds }, o))).json;
  };

  // ---------------- two branches ----------------
  await t("Harare (main, desktop, clock at 05:00) registers with Bib 20 and Cap 10; Murehwa (phone) joins", async ()=>{
    A = await device(browser, "desktop", "Harare main", { clock:shiftedNow() });
    const p = A.page;
    await p.waitForSelector("#setShop", { timeout:60000 });
    await p.fill("#setShop", "Mandie Babyware"); await p.fill("#setBranch", "Harare"); await p.fill("#setSecret", PHRASE);
    await p.click("#setupNext"); await p.fill("#setOwnerPhone", "0771234567"); await p.click("#setupNext2"); await p.click("#setupNext3"); await p.click("#setupFinish");
    await p.waitForSelector("[data-route]");
    await addProduct(A, { name:"Bib", sku:"BIB1", price:5, cost:2.5, stock:20 });
    await addProduct(A, { name:"Cap", sku:"CAP1", price:4, cost:1.5, stock:10 });
    await addAdminForTest(p, "admin123");
    await openSettings(A);
    await p.click("#termRegisterBtn");
    await p.waitForSelector('#terminalCard[data-registered="1"]', { timeout:60000 });
    mainInstall = (await sq("select install_id from cl_terminals"))[0].install_id;
    await p.click("#catSyncNow"); await p.waitForSelector(".cat-report"); await p.click("#cbrApply");
    await p.waitForSelector("#cbrDone", { timeout:30000 }); await p.click("#cbrDone");
    await activateForTest(p);
    harare = (await sq("select id from cl_branches where is_main"))[0].id;
    const mc = await issue({ p_new_branch_name:"Murehwa" }); murehwa = mc.branch_id;
    C = await device(browser, "phone", "Murehwa", { clock:shiftedNow() });
    await C.page.waitForSelector("#setShop", { timeout:60000 });
    await C.page.click("#setJoinBtn"); await C.page.waitForSelector("#setJoinCode");
    await C.page.fill("#setSecret", PHRASE); await C.page.fill("#setJoinCode", mc.code); await C.page.fill("#setTillLabel", "Front");
    await C.page.click("#setupJoin");
    // Part 5 round 2 bug: the catalogue pull (main's Bib and Cap) redrew the join form over the trial screen
    await C.page.waitForSelector("#trialSkip, #trialContinue", { timeout:30000 });
    await C.page.evaluate(()=> window.dispatchEvent(new Event("online")));   // the catalogue pull runs now
    await C.page.waitForTimeout(3000);   // the pull (or the 4 s first tick) has landed: its toast says "Catalogue updated"
    assert.ok(await C.page.$("#trialSkip, #trialContinue"), "the trial screen stays after the catalogue arrives");
    assert.strictEqual(await C.page.$("#setupJoin"), null, "the join form is not drawn again");
    table.push({ run:"Murehwa (390)", module:"Join → trial screen while the catalogue arrives", result:"Pass", note:"fixed in round 2: no redraw on the setup screens" });
    await passJoinTrialScreen(C.page); await activateForTest(C.page);
    await nav(C, "products");
    await waitFor(async()=> /Bib/.test(await text(C, "#productsTableArea")), "the catalogue at Murehwa", 30000);
    assert.deepStrictEqual((await sq("select b.name || ' ' || t.till_code x from cl_terminals t join cl_branches b on b.id = t.branch_id order by b.is_main desc")).map(r=>r.x), ["Harare T1", "Murehwa T1"]);
    assert.ok(new Date(await p.evaluate(()=> new Date().toISOString())).getTime() < Date.now(), "main's clock runs from 05:00");
  });

  // Main learns of the new branch at its next check-in (start-up or reconnect; the 5-minute timer only sends
  // this till's figures: reported for the owner, not changed). Here: a reconnect.
  await t("main reconnects: its check-in brings Murehwa, and More has Stock by branch", async ()=>{
    await bellCheck(A);
    await waitFor(async()=> (await moreTabs(A)).some(x=> x.id==="branches"), "Stock by branch at main", 30000);
  });

  // ---------------- staff for every built-in role ----------------
  await t("staff: Rudo (Owner, the first person, with main's Admin passcode) adds Grace (Admin), Mike (Manager), Tafadzwa (Stores), Sipho (Cashier) at Harare; Nyasha (Stores) and Chipo (Cashier) at Murehwa; Gift (Guest)", async ()=>{
    await openStaffCard(A);
    await addPerson(A, { name:"Rudo", role:"Owner", branch:"Harare", pin:"1111", adminPass:"admin123" });
    await waitFor(async()=> /Rudo/.test(await text(A, "#shopStaffCard")), "Rudo in the list");
    await A.page.uncheck("#sSingleOperator");
    await waitFor(async()=> !(await A.page.isChecked("#sSingleOperator")), "single operator off");
    await signInAs(A, "Rudo", "1111");
    await openStaffCard(A);
    for(const o of [{ name:"Grace", role:"Admin", branch:"Harare", pin:"2222" }, { name:"Mike", role:"Manager", branch:"Harare", pin:"3333" },
      { name:"Tafadzwa", role:"Stores", branch:"Harare", pin:"4444" }, { name:"Sipho", role:"Cashier", branch:"Harare", pin:"5555" },
      { name:"Nyasha", role:"Stores", branch:"Murehwa", pin:"6666" }, { name:"Chipo", role:"Cashier", branch:"Murehwa", pin:"7777" },
      { name:"Gift", role:"Guest", pin:"8888" }]) await addPerson(A, o);
    assert.deepStrictEqual((await sq(`select s.name || ' ' || r.builtin x from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id order by s.name`)).map(x=>x.x),
      ["Chipo cashier", "Gift guest", "Grace admin", "Mike manager", "Nyasha stores", "Rudo owner", "Sipho cashier", "Tafadzwa stores"]);
    await activateForTest(C.page);   // a check-in brings Murehwa its staff
    await waitFor(async()=>{ await openSettings(C); return !!(await C.page.$("#shopStaffCard")) && /Nyasha/.test(await text(C, "#shopStaffCard")); }, "Murehwa has the staff", 30000);
    await C.page.uncheck("#sSingleOperator");
    await waitFor(async()=> !(await C.page.isChecked("#sSingleOperator")), "single operator off at Murehwa");
    assert.deepStrictEqual(A.pageErrors, []); assert.deepStrictEqual(C.pageErrors, []);
  });

  // ---------------- every role walks the app ----------------
  const ROLE_RUNS = [
    ["Rudo", "1111", "Owner"], ["Grace", "2222", "Admin"], ["Mike", "3333", "Manager"], ["Tafadzwa", "4444", "Stores"], ["Sipho", "5555", "Cashier"],
  ];
  const seen = {};
  for(const [name, pin, role] of ROLE_RUNS){
    await t("main (1280): "+name+" ("+role+") signs in and walks every menu entry and More tab", async ()=>{
      await signInAs(A, name, pin);
      seen[role] = await roleWalk(A, role);
    });
  }
  await t("main: what each role must and must not have (rights as built: roles.js ROLE_DEFAULTS)", async ()=>{
    for(const r of ["Owner", "Admin"]) assert.ok(seen[r].tabs.includes("settings") && seen[r].tabs.includes("stockctl") && seen[r].tabs.includes("branches"), r+": "+seen[r].tabs);
    assert.ok(!seen.Manager.tabs.includes("settings") && seen.Manager.tabs.includes("stockctl"), "Manager: "+seen.Manager.tabs);
    assert.ok(!seen.Stores.routes.includes("pos") && seen.Stores.routes.includes("products"), "Stores: "+seen.Stores.routes);
    assert.ok(!seen.Cashier.routes.includes("products") && seen.Cashier.routes.includes("pos") && !seen.Cashier.tabs.includes("settings"), "Cashier: "+seen.Cashier.routes+" / "+seen.Cashier.tabs);
    assert.deepStrictEqual(A.pageErrors, []);
  });
  for(const [name, pin, role] of [["Nyasha", "6666", "Stores"], ["Chipo", "7777", "Cashier"]]){
    await t("Murehwa (390): "+name+" ("+role+") signs in and walks every menu entry and More tab", async ()=>{
      await signInAs(C, name, pin);
      const w = await roleWalk(C, role);
      assert.ok(w.tabs.includes("stockctl"), "a branch "+role+" can request stock: "+w.tabs);
      assert.ok(!w.tabs.includes("settings"), "no Settings");
      assert.deepStrictEqual(C.pageErrors, []);
    });
  }

  // ---------------- stock request -> draft ----------------
  await t("Murehwa (390): Chipo (Cashier) requests 6 Bibs and 2 Caps; an empty request and one without a reason are refused", async ()=>{
    await signInAs(C, "Chipo", "7777");
    await stockRequests(C);
    await C.page.click("#srqNew"); await C.page.waitForSelector("#rcSearch");
    await C.page.click("#rcSave");
    const e1 = (await text(C, "#rcErr")); assert.ok(e1.length > 3, "an empty request is refused: "+e1);
    await C.page.fill("#rcSearch", "bib"); await C.page.click("[data-add]");
    await C.page.fill("#rcSearch", "cap"); await C.page.click("[data-add]");
    await C.page.fill('[data-q="0"]', "6"); await C.page.fill('[data-q="1"]', "2");
    await C.page.click("#rcSave");
    const e2 = (await text(C, "#rcErr")); assert.ok(e2.length > 3, "a request without a reason is refused: "+e2);
    table.push({ run:"Murehwa · Cashier", module:"Stock request: wrong input", result:"Pass", note:"empty: \""+e1+"\"; no reason: \""+e2+"\"" });
    await C.page.fill("#rcReason", "Weekend market");
    await shots(C, "r2-01-murehwa-new-stock-request");
    await C.page.click("#rcSave");
    await gone(C, "#rcSearch");
    await waitFor(async()=> (await sq("select count(*)::int n from cl_stock_requests"))[0].n === 1, "the request on seiGEN", 30000);
    req1 = (await sq("select req_no from cl_stock_requests"))[0].req_no;
    assert.match(await text(C, "#srqList"), new RegExp(req1+".*Pending"));
  });

  await t("main (1280): Mike (Manager) part-approves "+"(Bib 4 of 6, Cap 2): the draft is on seiGEN, no stock moves", async ()=>{
    await signInAs(A, "Mike", "3333");
    await srqRefresh(A);
    await openRequest(A, req1);
    await A.page.fill('[data-part="1"]', "4");
    await A.page.fill("#srqDecNote", "4 Bibs for now");
    await shots(A, "r2-02-main-review-request");
    await A.page.click('[data-dec="part"]');
    await gone(A, "#srqHist");
    await waitFor(async()=> (await sq("select count(*)::int n from cl_srq_drafts where status = 'open'"))[0].n === 1, "the draft on seiGEN", 30000);
    approvedAt1 = new Date((await sq("select approved_at from cl_srq_drafts"))[0].approved_at).getTime();
    await nav(A, "products");
    assert.match(await text(A, '#productsTableArea tr:has-text("Bib")'), /20/, "no stock change until sent");
  });

  await t("main: Tafadzwa (Stores) sees \"Drafts from stock requests (1)\" on Products and in Dispatch; the open draft", async ()=>{
    await signInAs(A, "Tafadzwa", "4444");
    await srqRefresh(A);
    await nav(A, "products");
    await A.page.waitForSelector("#openSrqDrafts", { timeout:30000 });
    assert.match(await text(A, "#openSrqDrafts"), /Drafts from stock requests \(1\)/);
    await shots(A, "r2-03-main-products-drafts-button");
    await A.page.click("#openSrqDrafts");
    await A.page.waitForSelector("[data-open-draft]");
    const list = await text(A, "#srqDrafts");
    assert.match(list, new RegExp(req1+" for Murehwa")); assert.match(list, /Part-approved/); assert.match(list, /by Mike/); assert.match(list, /2 item\(s\)/);
    await shots(A, "r2-04-main-drafts-from-stock-requests");
    await closeModals(A);
    await A.page.click("#openDispatch");
    await A.page.waitForSelector("#doDraftsBox");
    assert.match(await text(A, "#doDraftsBox"), /1 waiting/);
    await shots(A, "r2-05-main-dispatch-drafts-box");
    await closeModals(A);
    await openRequest(A, req1);
    assert.match(await text(A, "#srqDraftWait"), /Approved, waiting for dispatch since/);
    assert.ok(await A.page.$("#srqDispatch"), "Open draft DN");
    await shots(A, "r2-06-main-open-draft-request");
    await closeModals(A);
  });

  await t("rights: Sipho (Cashier at main) has no drafts button and no Open draft DN; Murehwa sees Part-approved, waiting", async ()=>{
    await signInAs(A, "Sipho", "5555");
    assert.ok(!(await routes(A)).includes("products"));
    await openRequest(A, req1).catch(()=>{});
    assert.strictEqual(await A.page.$("#srqDispatch"), null, "no Open draft DN without the Dispatch right");
    await closeModals(A);
    await srqRefresh(C);
    await openRequest(C, req1);
    const h = await text(C, "#srqHist");
    assert.match(h, /Part-approved/); assert.match(h, /4 Bibs for now/); assert.match(h, /Approved, waiting for dispatch since/);
    assert.strictEqual(await C.page.$("#srqDispatch"), null, "a branch can't send main's draft");
    await shots(C, "r2-07-murehwa-request-part-approved");
    await closeModals(C);
  });

  // ---------------- the reminder ----------------
  await t("reminder: nothing at 7 h 50; at 8 h the bell tells Tafadzwa (Dispatch) and Mike (approver), never Sipho (Cashier)", async ()=>{
    await A.page.clock.setSystemTime(new Date(approvedAt1 + 7*HOUR + 50*MIN));
    await stillSignedIn(A, "Tafadzwa", "4444");
    await bellCheck(A);
    assert.ok(!(await bellTitles(A)).some(x=> /not dispatched yet/.test(x)), "no reminder before 8 h");
    await A.page.clock.setSystemTime(new Date(approvedAt1 + 8*HOUR + 2*MIN));
    await stillSignedIn(A, "Tafadzwa", "4444");
    await bellCheck(A);
    const tz = await bellTitles(A);
    assert.ok(tz.some(x=> new RegExp(req1+" for Murehwa approved .*not dispatched yet").test(x)), "Tafadzwa: "+tz.join(" | "));
    await shots(A, "r2-08-main-bell-dispatch-reminder");
    await closeModals(A);
    await signInAs(A, "Mike", "3333");
    assert.ok((await bellTitles(A)).some(x=> /not dispatched yet/.test(x)), "the approver");
    await closeModals(A);
    await signInAs(A, "Sipho", "5555");
    assert.ok(!(await bellTitles(A)).some(x=> /not dispatched yet/.test(x)), "never a Cashier at main");
    await closeModals(A);
    await bellCheck(C);
    await signInAs(C, "Nyasha", "6666");
    assert.ok(!(await bellTitles(C)).some(x=> /not dispatched yet/.test(x)), "not at the branch");
    await closeModals(C);
    assert.deepStrictEqual(A.pageErrors, []);
  });

  await t("the bell's reminder opens the request (route srq:)", async ()=>{
    await signInAs(A, "Tafadzwa", "4444");
    await bellTitles(A);
    await A.page.click('#bellList .bell-item:has-text("not dispatched yet")');
    await A.page.waitForSelector("#srqHist");
    assert.match(await text(A, ".modalOverlay"), new RegExp("Stock request "+req1));
    await closeModals(A);
  });

  await t("Settings → the timers: Mike (Manager) has no Settings; Grace (Admin) sees the card (8 h, 24 h) and saves 2 h / every 6 h on seiGEN", async ()=>{
    await signInAs(A, "Mike", "3333");
    assert.ok(!(await moreTabs(A)).some(x=> x.id==="settings"), "no Settings for a Manager");
    await signInAs(A, "Grace", "2222");
    await openSettings(A);
    await A.page.waitForSelector("#srqRemindCard");
    assert.strictEqual(await A.page.inputValue("#srqRemDelay"), "8"); assert.strictEqual(await A.page.inputValue("#srqRemRepeat"), "24");
    await (await A.page.$("#srqRemindCard")).scrollIntoViewIfNeeded();
    await shots(A, "r2-09-main-settings-reminder-timers", "#srqRemindCard");
    await A.page.selectOption("#srqRemDelay", "2"); await A.page.selectOption("#srqRemRepeat", "6");
    await A.page.click("#srqRemSave");
    await waitFor(async()=> /Saved for the whole business/.test(await text(A, "#srqRemMsg")), "saved", 30000);
    const s = (await sq("select * from cl_srq_settings"))[0];
    assert.strictEqual(Number(s.delay_hours), 2); assert.strictEqual(Number(s.repeat_hours), 6);
    await shots(A, "r2-10-main-settings-reminder-saved", "#srqRemindCard");
    assert.deepStrictEqual(A.pageErrors, []);
  });

  // ---------------- the draft is sent ----------------
  await t("Tafadzwa opens the draft DN: pre-filled 4 + 2; raising Bib to 5 is refused; Bib lowered to 3; sent through seiGEN", async ()=>{
    await signInAs(A, "Tafadzwa", "4444");
    await nav(A, "products");
    await A.page.click("#openSrqDrafts"); await A.page.click("[data-open-draft]");
    await A.page.waitForSelector("#doDraftOnly");
    const qtys = await A.page.$$eval("[data-qty]", els=> els.map(e=> e.value));
    assert.deepStrictEqual(qtys.map(Number).sort(), [2, 4]);
    await shots(A, "r2-11-main-draft-dn-prefilled");
    const bib = await A.page.$$eval("[data-qty]", els=> els.findIndex(e=> /Bib/.test(e.closest(".card").textContent)));
    await A.page.fill(`[data-qty="${bib}"]`, "5"); await A.page.click("#doReview");
    const err = await text(A, "#doErr");
    assert.ok(err.length > 3 && !(await A.page.$("#doConfirm")), "raising above the approved quantity is refused: "+err);
    table.push({ run:"Harare main · Stores", module:"Draft DN: raise refused", result:"Pass", note:err });
    await A.page.fill(`[data-qty="${bib}"]`, "3"); await A.page.click("#doReview");
    await A.page.waitForSelector("#doConfirm");
    await A.page.click("#doConfirm");
    await A.page.waitForSelector("#doDone", { timeout:30000 });
    await A.page.click("#doDone");
    await waitFor(async()=> (await sq("select status from cl_srq_drafts"))[0].status === "sent", "the draft sent on seiGEN", 30000);
    // the claim marks the draft sent first; the DN push then links the request
    await waitFor(async()=> (await sq("select status from cl_stock_requests"))[0].status !== "part_approved", "the DN on seiGEN", 30000);
    const r =(await sq("select r.status, d.dn_display from cl_stock_requests r left join cl_dispatches d on d.id = r.dispatch_id"))[0];
    assert.strictEqual(r.status, "dispatched"); assert.ok(r.dn_display, "linked to its DN");
    await nav(A, "products");
    assert.match(await text(A, '#productsTableArea tr:has-text("Bib")'), /17/, "stock leaves when the DN is sent (20 - 3)");
    assert.strictEqual(await A.page.$("#openSrqDrafts"), null, "no drafts waiting");
  });

  await t("the reminder goes away once sent; Murehwa (Nyasha, Stores) receives the DN: GRV, the request is Received, Sent 3 shown", async ()=>{
    await bellCheck(A);
    assert.ok(!(await bellTitles(A)).some(x=> new RegExp(req1+".*not dispatched yet").test(x)), "the reminder is put away");
    await closeModals(A);
    await signInAs(C, "Nyasha", "6666");
    await nav(C, "products");
    await C.page.waitForSelector("#openSeigenDispatches", { timeout:30000 });
    await C.page.click("#openSeigenDispatches");
    await C.page.waitForSelector("[data-dsrecv]", { timeout:30000 });
    await C.page.click("[data-dsrecv]");
    await C.page.waitForSelector("#dsGo, #dsPost", { timeout:30000 });
    if(await C.page.$("#dsGo")){ await C.page.click("#dsGo"); await C.page.waitForSelector("#dsPost", { timeout:30000 }); }
    await C.page.click("#dsPost");
    await waitFor(async()=> (await sq("select status from cl_stock_requests"))[0].status === "received", "received on seiGEN", 30000);
    await closeModals(C);
    await srqRefresh(C);
    await openRequest(C, req1);
    const h = await text(C, "#srqHist");
    assert.match(h, /Received/); assert.match(h, /Delivery Note: DN-/); assert.match(h, /GRV/);
    assert.match(h, /Bib ?6 ?4 ?3/, "Asked 6, Approved 4, Sent 3 (the lowered line)");
    await shots(C, "r2-12-murehwa-request-received");
    await closeModals(C);
    assert.deepStrictEqual(C.pageErrors, []);
  });

  // ---------------- a second draft: the new timers, closed with a reason ----------------
  await t("a second request (Cap 1): approved all; with the new timers it reminds at 2 h; Mike closes it with a reason; both ends show it; the reminder goes", async ()=>{
    await signInAs(C, "Chipo", "7777");
    await stockRequests(C);
    await C.page.click("#srqNew"); await C.page.waitForSelector("#rcSearch");
    await C.page.fill("#rcSearch", "cap"); await C.page.click("[data-add]");
    await C.page.fill("#rcReason", "Display"); await C.page.click("#rcSave"); await gone(C, "#rcSearch");
    await waitFor(async()=> (await sq("select count(*)::int n from cl_stock_requests"))[0].n === 2, "the second request on seiGEN", 30000);
    req2 = (await sq("select req_no from cl_stock_requests order by created_at desc limit 1"))[0].req_no;
    await signInAs(A, "Mike", "3333");
    await srqRefresh(A);
    await openRequest(A, req2);
    await A.page.click('[data-dec="approve"]'); await gone(A, "#srqHist");
    await waitFor(async()=> (await sq("select count(*)::int n from cl_srq_drafts where status = 'open'"))[0].n === 1, "the second draft", 30000);
    approvedAt2 = new Date((await sq("select approved_at from cl_srq_drafts where status = 'open'"))[0].approved_at).getTime();
    await srqRefresh(A);
    await A.page.clock.setSystemTime(new Date(approvedAt2 + 2*HOUR + 2*MIN));
    await stillSignedIn(A, "Mike", "3333");
    await bellCheck(A);
    assert.ok((await bellTitles(A)).some(x=> new RegExp(req2+" for Murehwa approved .*not dispatched yet").test(x)), "the 2 h reminder");
    await closeModals(A);
    await openRequest(A, req2);
    A.promptText = "";
    await A.page.click("#srqCloseDraft");
    assert.match(await text(A, "#srqErr"), /reason/i, "closing without a reason is refused");
    A.promptText = "Cap out of stock this week";
    await A.page.click("#srqCloseDraft");
    await gone(A, "#srqHist");
    await waitFor(async()=> (await sq("select status, close_reason from cl_srq_drafts where status = 'closed'")).length === 1, "closed on seiGEN", 30000);
    await openRequest(A, req2);
    assert.match(await text(A, "#srqDraftClosed"), /Approved, not dispatched: Cap out of stock this week \(Mike/);
    await shots(A, "r2-13-main-draft-closed");
    await closeModals(A);
    await bellCheck(A);
    assert.ok(!(await bellTitles(A)).some(x=> new RegExp(req2+".*not dispatched yet").test(x)), "the reminder is put away when closed");
    await closeModals(A);
    await srqRefresh(C);
    await openRequest(C, req2);
    assert.match(await text(C, "#srqDraftClosed"), /Approved, not dispatched: Cap out of stock this week/);
    await shots(C, "r2-14-murehwa-request-not-dispatched");
    await closeModals(C);
    assert.deepStrictEqual(A.pageErrors, []); assert.deepStrictEqual(C.pageErrors, []);
  });

  // ---------------- the Office seat ----------------
  await t("Office seat: Grace invites Tendai (Manager); the phone joins, chooses a PIN; Grace approves", async ()=>{
    await signInAs(A, "Grace", "2222");
    await openSettings(A);
    await A.page.waitForSelector("#seatInviteBtn", { timeout:30000 });
    await A.page.click("#seatInviteBtn"); await A.page.waitForSelector("#seatCreate");
    await A.page.fill("#seatName", "Tendai"); await A.page.selectOption("#seatRole", { label:"Manager" });
    await A.page.click("#seatCreate");
    await A.page.waitForSelector("#seatInvCode", { timeout:30000 });
    seatCode = (await A.page.textContent("#seatInvCode")).trim();
    await closeModals(A);
    const first = await device(browser, "phone", "Office seat", { ua:ANDROID, clock:shiftedNow(), hash:"#seat="+seatCode.replace("-", "") });
    await first.page.waitForSelector("#seatInstallCard", { timeout:60000 });
    const dir = first.dir; await first.ctx.close();
    S = await device(browser, "phone", "Office seat", { ua:ANDROID, standalone:true, clock:shiftedNow(), dir });
    await S.page.evaluate((c)=> window.localStorage.setItem("scl_seat_invite", JSON.stringify({ code:c, ts:Date.now() })), seatCode);
    await S.page.reload();
    await S.page.waitForSelector("#seatJoinCode", { timeout:60000 });
    await S.page.click("#seatJoinGo");
    await S.page.waitForSelector("#seatPin", { timeout:30000 });
    await S.page.fill("#seatPin", "5151"); await S.page.fill("#seatPin2", "5151"); await S.page.click("#seatPinGo");
    await S.page.waitForSelector("#seatWaitCard", { timeout:30000 });
    await openSettings(A);
    await A.page.waitForSelector("[data-seat-approve]", { timeout:30000 });
    await A.page.click("[data-seat-approve]"); await A.page.waitForSelector("#seatApproveCheck");
    await A.page.check("#seatCheckSame"); await A.page.click("#seatApproveGo"); await gone(A, "#seatApproveGo");
    await waitFor(async()=> (await sq(`select approval_status from cl_terminals where device_kind = 'seat'`))[0].approval_status === "approved", "approved");
    await S.page.click("#seatWaitCheckNow");
    await S.page.waitForSelector("#trialSkip, #trialContinue, #startSignIn", { timeout:60000 });
    await writeSettings(S.page, [["activated_until", new Date(Date.now() + 30*86400000).toISOString()], ["activated_until_src", "code"]]);
    await S.page.reload();
  });

  await t("the seat (390): Tendai (Manager) walks every screen; no Sell, Credit or Settings; Stock requests shows the requests from seiGEN", async ()=>{
    await signInAs(S, "Tendai", "5151");
    const w = await roleWalk(S, "Manager (seat)");
    for(const r of ["pos", "credit"]) assert.ok(!w.routes.includes(r), "no "+r+": "+w.routes);
    assert.ok(!w.tabs.includes("settings"), "no Settings");
    if(w.tabs.includes("stockctl")){
      await srqRefresh(S);
      const list = await text(S, "#srqList");
      table.push({ run:"Office seat · Manager", module:"Stock requests on a seat", result:"Pass", note:list.slice(0, 160) });
      assert.match(list, new RegExp(req1)); assert.match(list, new RegExp(req2));
      await shots(S, "r2-15-seat-stock-requests");
    }
    assert.deepStrictEqual(S.pageErrors, []);
  });

  await t("the seat: Gift (Guest) signs in: view only, no stock requests, no Settings", async ()=>{
    await signInAs(S, "Gift", "8888");
    const w = await roleWalk(S, "Guest (seat)");
    for(const x of ["stockctl", "settings", "purchasing", "reportwriter"]) assert.ok(!w.tabs.includes(x), "a Guest has no "+x+": "+w.tabs);
    for(const r of ["pos", "credit"]) assert.ok(!w.routes.includes(r), "no "+r);
    await shots(S, "r2-16-seat-guest-home");
    assert.deepStrictEqual(S.pageErrors, []);
  });

  await t("a Guest can't sign in on a till (only on an Office seat)", async ()=>{
    await closeModals(A);
    if(!(await A.page.$("#startSignIn"))) await A.page.click("#logoutBtn");
    await A.page.waitForSelector("#startSignIn"); await A.page.click("#startSignIn");
    await A.page.waitForSelector("#whoSelect");
    const names = await A.page.$$eval("#whoSelect option", o=> o.map(x=> x.textContent));
    if(names.includes("Gift")){
      await A.page.selectOption("#whoSelect", { label:"Gift" }); await A.page.click("#whoSelectContinue");
      await A.page.fill("#whoPin", "8888"); await A.page.click("#whoPinContinue");
      await A.page.waitForTimeout(1500);
      assert.notStrictEqual(((await A.page.$("#userChip"))? (await A.page.textContent("#userChip")).trim() : ""), "Gift", "a Guest never signs in on a till");
    }
    table.push({ run:"Harare main", module:"Guest on a till", result:"Pass", note: names.includes("Gift")? "listed, sign-in refused" : "not listed" });
  });

  await browser.close();
  if(process.env.TABLE_OUT) fs.writeFileSync(process.env.TABLE_OUT, JSON.stringify(table, null, 1));
  const fails = table.filter(r=>r.result!=="Pass");
  console.log("\nscreens checked: "+table.length+", failing: "+fails.length);
  for(const f of fails) console.log("  "+f.run+"  "+f.module+"  "+f.note);
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
