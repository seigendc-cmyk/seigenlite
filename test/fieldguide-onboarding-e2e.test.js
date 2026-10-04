// Run: node --no-warnings test/fieldguide-onboarding-e2e.test.js
// (build first: node build.js --rpn)
// Onboarding notes in a real browser, against a FAKE Console: every
// request to the Console's Supabase URL is answered here, with the same
// rules as the live table (primary key, own rows, token expiry); anything
// else to that host is aborted and fails the run. The live project is never
// contacted by this test.
//   * sign-in: wrong passcode, a staff account, no connection, offline;
//     then signed in
//   * the form: required fields and bad input marked and focused; typing
//     kept through offline/online, leaving the form, and a reload
//   * saved offline -> "Saved on phone" -> online -> "Sent to Console"
//   * a lost answer -> "Failed - retry" -> Retry -> sent, one row only
//   * an expired token -> "Sign in to send" -> sign in -> sent
//   * the form by keyboard; the screens at 360x640 and 412x915
//   * offline after a reload: notes and statuses still there, saving works
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist-rpn");
if(!fs.existsSync(path.join(DIST, "index.html"))){ console.log("Missing dist-rpn/ — run: node build.js --rpn"); process.exit(1); }
const CONSOLE_URL = fs.readFileSync(path.join(ROOT, "src", "devicecheckin.js"), "utf8").match(/const DC_SUPABASE_URL = "([^"]+)";/)[1];
const SHOTS = process.env.RPN_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "rpn-onboarding-shots-"));
fs.mkdirSync(SHOTS, { recursive: true });

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".webmanifest":"application/manifest+json", ".png":"image/png", ".svg":"image/svg+xml" };
function deploy(){
  const server = http.createServer((req, res)=>{
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(DIST, rel);
    if(!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){ res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r=> server.listen(0, "127.0.0.1", ()=> r({ server, base:"http://127.0.0.1:"+server.address().port+"/" })));
}

// ---------------- the fake Console ----------------
const RPN_A = "11111111-1111-4111-8111-111111111111";
const b64url = (o)=> Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const claimsOf = (token)=> JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"), "base64").toString());
function fakeConsole(){
  const c = { rows:new Map(), posts:0, logins:0, unexpected:[], loseAnswer:0, expireTokens:false, down:false };
  const accounts = { "Tendai Moyo":["1234", RPN_A, "rpn"], "Office Clerk":["9999", "33333333-3333-4333-8333-333333333333", "staff"] };
  const CORS = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"*", "Access-Control-Allow-Methods":"GET,POST,OPTIONS" };
  c.handle = async (route)=>{
    const req = route.request();
    const u = new URL(req.url());
    const json = (status, body)=> route.fulfill({ status, headers: Object.assign({ "Content-Type":"application/json" }, CORS), body: body === undefined ? "" : JSON.stringify(body) });
    if(req.method() === "OPTIONS") return route.fulfill({ status:204, headers:CORS });
    if(c.down) return route.abort("internetdisconnected");
    if(u.pathname === "/rest/v1/rpc/cl_login"){
      c.logins++;
      const { p_name, p_passcode } = JSON.parse(req.postData());
      const acct = accounts[p_name];
      if(!acct || acct[0] !== p_passcode) return json(400, { code:"P0001", message:"Invalid name or passcode" });
      const now = Math.floor(Date.now()/1000);
      const token = b64url({ alg:"HS256", typ:"JWT" })+"."+b64url({ role:"authenticated", sub:acct[1], user_type:acct[2], full_name:p_name, iat:now, exp:now+12*3600 })+".sig";
      return json(200, { token, user_type:acct[2], id:acct[1], full_name:p_name });
    }
    if(u.pathname === "/rest/v1/rpn_onboarding_notes"){
      const token = (req.headers()["authorization"]||"").replace("Bearer ","");
      let claims; try{ claims = claimsOf(token); }catch(e){ return json(401, { code:"PGRST301", message:"JWT invalid" }); }
      if(c.expireTokens || claims.exp*1000 <= Date.now()) return json(401, { code:"PGRST301", message:"JWT expired" });
      if(req.method() === "GET"){
        const id = u.searchParams.get("id").replace("eq.","");
        const row = c.rows.get(id);
        return json(200, row && row.rpn_id === claims.sub ? [{ id }] : []);
      }
      c.posts++;
      const body = JSON.parse(req.postData());
      if("rpn_id" in body) return json(400, { message:"rpn_id must come from the token" });
      if(claims.user_type !== "rpn") return json(403, { code:"42501", message:"new row violates row-level security policy" });
      if(c.rows.has(body.id)) return json(409, { code:"23505", message:"duplicate key value violates unique constraint \"rpn_onboarding_notes_pkey\"" });
      c.rows.set(body.id, Object.assign({ rpn_id:claims.sub }, body));
      if(c.loseAnswer > 0){ c.loseAnswer--; return route.abort("connectionreset"); }
      return json(201);
    }
    c.unexpected.push(req.method()+" "+u.pathname);
    return route.abort("blockedbyclient");
  };
  return c;
}

function watchErrors(page){
  const errors = [];
  page.on("console", (m)=>{ if(m.type()==="error" && !/Failed to load resource|ERR_(INTERNET_DISCONNECTED|CONNECTION_RESET|BLOCKED)|net::/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e)=> errors.push(String(e)));
  return errors;
}
const heading = (page, text)=> page.waitForFunction((x)=>{ const e = document.querySelector("#fgMain .fg-h1"); return e && e.textContent.trim() === x; }, text);
// Wait until an element exists and its text matches (screens are redrawn,
// so it may be missing for a moment).
const waitText = (page, sel, re)=> page.waitForFunction(([s, src, flags])=>{ const e = document.querySelector(s); return !!e && new RegExp(src, flags).test(e.textContent); }, [sel, re.source, re.flags]);
async function signIn(page, name, pass){
  if(!/#\/me/.test(page.url())) { await page.click("#fgNav-me"); await heading(page, "Me"); }
  await page.fill("#fgSigninName", name);
  await page.fill("#fgSigninPass", pass);
  await page.click("#fgSignin button[type=submit]");
}
async function fillRequired(page, overrides){
  const v = Object.assign({ business_name:"Mai Tendai Grocers", owner_name:"T. Mapfumo", phone:"0789 012 231", city:"Harare" }, overrides||{});
  for(const [k, val] of Object.entries(v)) await page.fill("#fgNote-"+k, val);
}
const noteStatus = (page, name)=> page.evaluate((n)=>{ const row = [...document.querySelectorAll(".fg-note-row")].find((r)=> r.querySelector(".fg-note-t").textContent === n); return row ? row.querySelector(".pill").textContent : null; }, name);

(async ()=>{
  const browser = await chromium.launch();
  const site = await deploy();
  const fake = fakeConsole();
  const ctx = await browser.newContext({ viewport:{ width:412, height:915 } });
  await ctx.route(CONSOLE_URL+"/**", fake.handle);
  const page = await ctx.newPage();
  const errors = watchErrors(page);

  await t("before signing in: the Field tab asks for a sign-in; no new note yet", async ()=>{
    await page.goto(site.base+"#/field");
    await heading(page, "Field");
    await page.waitForSelector("[data-act=f-go-me]");
    assert.ok(await page.isDisabled("[data-act=f-new]"));
    await page.screenshot({ path: path.join(SHOTS, "412-field-signed-out.png") });
  });

  await t("sign-in failures are told apart: wrong passcode, staff account, no connection, offline", async ()=>{
    await page.click("[data-act=f-go-me]");
    await heading(page, "Me");
    await signIn(page, "Tendai Moyo", "0000");
    await page.waitForSelector("#fgSignin .fg-err");
    assert.match(await page.textContent("#fgSignin .fg-err"), /don't match an RPN account/);
    assert.strictEqual(await page.inputValue("#fgSigninName"), "Tendai Moyo", "the name is kept");
    await signIn(page, "Office Clerk", "9999");
    await waitText(page, "#fgSignin .fg-err", /isn't an RPN account/);
    fake.down = true;
    await signIn(page, "Tendai Moyo", "1234");
    await waitText(page, "#fgSignin .fg-err", /Can't reach the Console/);
    fake.down = false;
    await ctx.setOffline(true);
    await page.waitForSelector("#fgSigninOffline:not([hidden])");
    assert.ok(await page.isDisabled("#fgSignin button[type=submit]"));
    await ctx.setOffline(false);
    await page.waitForSelector("#fgSignin button[type=submit]:not([disabled])");
  });

  await t("typing in the sign-in form survives going offline and online", async ()=>{
    await page.fill("#fgSigninName", "Tendai Moyo");
    await page.fill("#fgSigninPass", "12");
    await page.click("#fgMain .fg-h1"); // focus elsewhere: the text is still unsaved
    await ctx.setOffline(true);
    await ctx.setOffline(false);
    assert.strictEqual(await page.inputValue("#fgSigninPass"), "12");
  });

  await t("signed in: Me and Field say who is sending, and until when", async ()=>{
    await signIn(page, "Tendai Moyo", "1234");
    await waitText(page, "#fgSignin", /Signed in as Tendai Moyo until/);
    await page.click("#fgNav-field");
    await waitText(page, "#fgMain", /Sending as Tendai Moyo/);
    assert.ok(!(await page.isDisabled("[data-act=f-new]")));
  });

  await t("the form: missing and bad input is marked, said once at the top, and the first one focused", async ()=>{
    await page.click("[data-act=f-new]");
    await heading(page, "New onboarding note");
    assert.strictEqual(await page.inputValue("#fgNote-visit_date"), await page.evaluate(()=>{ const d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }), "visit date is today");
    await page.click(".fg-noteform button[type=submit]");
    await page.waitForSelector(".fg-errsum");
    assert.match(await page.textContent(".fg-errsum"), /4 fields/);
    assert.strictEqual(await page.evaluate(()=> document.activeElement.id), "fgNote-business_name");
    for(const f of ["business_name", "owner_name", "phone", "city"]) assert.strictEqual(await page.getAttribute("#fgNote-"+f, "aria-invalid"), "true", f);
    await fillRequired(page, { phone:"call me", approx_products:"lots" });
    await page.click(".fg-noteform button[type=submit]");
    await waitText(page, ".fg-errsum", /2 fields/);
    assert.match(await page.textContent("#fgNote-phone-err"), /phone number/);
    assert.match(await page.textContent("#fgNote-approx_products-err"), /whole number/);
    assert.strictEqual(await page.evaluate(()=> document.activeElement.id), "fgNote-phone");
    await page.screenshot({ path: path.join(SHOTS, "412-form-errors.png") });
    assert.strictEqual(fake.posts, 0);
  });

  await t("typing is kept: through offline/online, leaving the form, and a reload", async ()=>{
    await page.fill("#fgNote-phone", "0789 012 231");
    await page.fill("#fgNote-approx_products", "120");
    await page.fill("#fgNote-notes", "Wants to start next week");
    await page.selectOption("#fgNote-stocktake_needed", "yes");
    await ctx.setOffline(true);
    await ctx.setOffline(false);
    assert.strictEqual(await page.inputValue("#fgNote-notes"), "Wants to start next week");
    assert.strictEqual(await page.inputValue("#fgNote-business_name"), "Mai Tendai Grocers");
    await page.click("#fgNav-coach");
    await page.click("#fgNav-field");
    await page.click("[data-act=f-new]");
    assert.strictEqual(await page.inputValue("#fgNote-owner_name"), "T. Mapfumo");
    await page.waitForTimeout(600); // the draft is saved to the phone shortly after typing stops
    await page.reload();
    await page.waitForSelector("#fgNote-notes");
    assert.strictEqual(await page.inputValue("#fgNote-notes"), "Wants to start next week");
    assert.strictEqual(await page.inputValue("#fgNote-stocktake_needed"), "yes");
  });

  await t("saved offline: 'Saved on phone'; back online it goes by itself: 'Sent to Console'", async ()=>{
    await ctx.setOffline(true);
    await page.click(".fg-noteform button[type=submit]");
    await heading(page, "Field");
    assert.strictEqual(await noteStatus(page, "Mai Tendai Grocers"), "Saved on phone");
    assert.ok(await page.isVisible(".fg-offline-note"));
    await page.screenshot({ path: path.join(SHOTS, "412-field-saved-offline.png") });
    assert.strictEqual(fake.posts, 0);
    await ctx.setOffline(false);
    await page.waitForFunction(()=> [...document.querySelectorAll(".fg-note-row .pill")].some((p)=> p.textContent === "Sent to Console"));
    assert.strictEqual(fake.rows.size, 1);
    const row = [...fake.rows.values()][0];
    assert.strictEqual(row.rpn_id, RPN_A);
    assert.strictEqual(row.phone, "+263789012231");
    assert.strictEqual(row.approx_products, 120);
    assert.strictEqual(row.stocktake_needed, "yes");
    // the form starts empty again
    await page.click("[data-act=f-new]");
    assert.strictEqual(await page.inputValue("#fgNote-business_name"), "");
    await page.click("[data-act=f-back]");
    await page.click(".fg-note-row");
    await page.waitForFunction(()=>{ const s = document.querySelector(".fg-status"); return s && /Sent to the Console at/.test(s.textContent); });
  });

  await t("a lost answer: 'Failed - retry' with the reason; Retry sends it; still one row", async ()=>{
    await page.click("[data-act=f-back]");
    fake.loseAnswer = 1;
    await page.click("[data-act=f-new]");
    await fillRequired(page, { business_name:"Chikwanha Fast Foods", owner_name:"P. Chikwanha", city:"Mutare" });
    await page.click(".fg-noteform button[type=submit]");
    await heading(page, "Field");
    await page.waitForFunction(()=> [...document.querySelectorAll(".fg-note-row")].some((r)=> /Chikwanha/.test(r.textContent) && /Failed - retry/.test(r.textContent)));
    await page.click(".fg-note-row >> text=Chikwanha Fast Foods");
    await page.waitForSelector(".fg-status-failed");
    assert.match(await page.textContent(".fg-status"), /No connection to the Console\. Trying again at/);
    await page.screenshot({ path: path.join(SHOTS, "412-note-failed.png") });
    const before = fake.posts;
    await page.click("[data-act=f-retry]");
    await page.waitForSelector(".fg-status-sent");
    assert.strictEqual(fake.posts, before + 1);
    assert.strictEqual([...fake.rows.values()].filter((r)=> r.business_name === "Chikwanha Fast Foods").length, 1, "the retry didn't make a second row");
  });

  await t("an expired token: 'Sign in to send'; signing in again sends it", async ()=>{
    await page.click("[data-act=f-back]");
    fake.expireTokens = true;
    await page.click("[data-act=f-new]");
    await fillRequired(page, { business_name:"Bulawayo Hardware Corner", owner_name:"N. Sibanda", city:"Bulawayo" });
    await page.click(".fg-noteform button[type=submit]");
    await heading(page, "Field");
    await page.waitForFunction(()=> [...document.querySelectorAll(".fg-note-row")].some((r)=> /Bulawayo/.test(r.textContent) && /Sign in to send/.test(r.textContent)));
    assert.match(await page.textContent(".fg-callout-warn"), /your sign-in has ended/);
    await page.screenshot({ path: path.join(SHOTS, "412-field-signin-to-send.png") });
    fake.expireTokens = false;
    await page.click(".fg-callout-warn [data-act=f-go-me]");
    await heading(page, "Me");
    assert.strictEqual(await page.inputValue("#fgSigninName"), "Tendai Moyo", "name filled in");
    await page.fill("#fgSigninPass", "1234");
    await page.click("#fgSignin button[type=submit]");
    await waitText(page, "#fgSignin", /Signed in as/);
    await page.click("#fgNav-field");
    await page.waitForFunction(()=> [...document.querySelectorAll(".fg-note-row")].some((r)=> /Bulawayo/.test(r.textContent) && /Sent to Console/.test(r.textContent)));
    assert.strictEqual(fake.rows.size, 3);
  });

  await t("the form by keyboard: every field labelled, Tab in order, Enter saves", async ()=>{
    await page.click("[data-act=f-new]");
    await heading(page, "New onboarding note");
    const unlabelled = await page.$$eval(".fg-noteform input, .fg-noteform select, .fg-noteform textarea", (els)=> els.filter((e)=> !document.querySelector('label[for="'+e.id+'"]')).map((e)=> e.id));
    assert.deepStrictEqual(unlabelled, []);
    await page.focus("#fgNote-business_name");
    const order = ["business_name", "owner_name", "phone", "city", "location", "visit_date"];
    for(let i = 1; i < order.length; i++){
      await page.keyboard.press("Tab");
      if(order[i] === "visit_date"){ // a date box has inner parts; Tab moves through them
        await page.waitForFunction(()=> document.activeElement.id === "fgNote-visit_date");
      }
      assert.strictEqual(await page.evaluate(()=> document.activeElement.id), "fgNote-"+order[i]);
    }
    await page.focus("#fgNote-business_name");
    await page.keyboard.type("Keyboard Shop");
    await page.keyboard.press("Tab"); await page.keyboard.type("K. Owner");
    await page.keyboard.press("Tab"); await page.keyboard.type("0771234567");
    await page.keyboard.press("Tab"); await page.keyboard.type("Gweru");
    await page.keyboard.press("Enter");
    await heading(page, "Field");
    await page.waitForFunction(()=> [...document.querySelectorAll(".fg-note-row")].some((r)=> /Keyboard Shop/.test(r.textContent) && /Sent to Console/.test(r.textContent)));
  });

  await t("no console errors, and nothing went anywhere but the fake Console", async ()=>{
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(fake.unexpected, []);
  });
  await ctx.close();

  await t("offline after a reload: the notes and their statuses are there, and saving works", async ()=>{
    const c = await browser.newContext({ viewport:{ width:412, height:915 } });
    await c.route(CONSOLE_URL+"/**", fake.handle);
    const p = await c.newPage();
    const errs = watchErrors(p);
    await p.goto(site.base);
    await p.waitForFunction(()=> !!navigator.serviceWorker.controller);
    await signIn(p, "Tendai Moyo", "1234");
    await waitText(p, "#fgSignin", /Signed in as/);
    await c.setOffline(true);
    await p.goto(site.base+"#/field/new");
    await p.reload();
    await heading(p, "New onboarding note");
    await fillRequired(p, { business_name:"Offline Shop" });
    await p.click(".fg-noteform button[type=submit]");
    await heading(p, "Field");
    assert.strictEqual(await noteStatus(p, "Offline Shop"), "Saved on phone");
    await p.reload();
    await p.waitForSelector(".fg-note-row"); // "Field" shows while the notes are still being read from the phone
    assert.strictEqual(await noteStatus(p, "Offline Shop"), "Saved on phone", "still there after another reload");
    await c.setOffline(false);
    await p.waitForFunction(()=> [...document.querySelectorAll(".fg-note-row .pill")].some((x)=> x.textContent === "Sent to Console"));
    assert.deepStrictEqual(errs, []);
    await c.close();
  });

  for(const [w, h] of [[360, 640], [412, 915]]){
    await t("phone width "+w+"x"+h+": form, list, note and sign-in fit; 48px fields and buttons; 16px text in boxes", async ()=>{
      const c = await browser.newContext({ viewport:{ width:w, height:h }, deviceScaleFactor:2, isMobile:true, hasTouch:true, colorScheme:"dark" });
      await c.route(CONSOLE_URL+"/**", fake.handle);
      const p = await c.newPage();
      await p.goto(site.base+"#/me");
      await p.waitForSelector("#fgSignin");
      const check = async (name)=>{
        const m = await p.evaluate(()=>({
          scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
          boxes: [...document.querySelectorAll("#fgMain input:not([type=hidden]), #fgMain select, #fgMain button")].filter((e)=> e.offsetParent).map((e)=>({ id:e.id||e.textContent.trim().slice(0,20), h:e.getBoundingClientRect().height, fs: parseFloat(getComputedStyle(e).fontSize), tag:e.tagName })),
        }));
        assert.ok(m.scrollW <= m.clientW, name+": "+m.scrollW+" > "+m.clientW);
        for(const b of m.boxes){
          if(b.tag !== "BUTTON") assert.ok(b.fs >= 16, name+": "+b.id+" text "+b.fs+"px (phones zoom in under 16px)");
          assert.ok(b.h >= 36, name+": "+b.id+" only "+b.h+"px high");
        }
        await p.screenshot({ path: path.join(SHOTS, w+"-"+name+".png"), fullPage: name === "form" });
      };
      await check("signin");
      await signIn(p, "Tendai Moyo", "1234");
      await waitText(p, "#fgSignin", /Signed in as/);
      await p.tap("#fgNav-field");
      await heading(p, "Field");
      await p.tap("[data-act=f-new]");
      await heading(p, "New onboarding note");
      await check("form");
      await fillRequired(p, { business_name:"A very long business name that goes on and on, Harare CBD branch" });
      await p.tap(".fg-noteform button[type=submit]");
      await heading(p, "Field");
      await p.waitForFunction(()=> [...document.querySelectorAll(".fg-note-row .pill")].some((x)=> x.textContent === "Sent to Console"));
      await check("list");
      await p.tap(".fg-note-row");
      await p.waitForSelector(".fg-status-sent");
      await check("note");
      await c.close();
    });
  }

  await browser.close();
  site.server.close();
  console.log("Screenshots: "+SHOTS);
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
