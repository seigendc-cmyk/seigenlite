// Run: node --no-warnings test/trial-e2e.test.js     (SHOT_DIR=<dir> saves screenshots)
//
// Trial rules end to end, nothing reaching the live project:
//   * "Supabase" is the REAL server SQL (baseline + every migration, the
//     trial rules migration included) in an in-memory PGlite, behind a small
//     local HTTP server that behaves like PostgREST (HS256 JWTs checked with
//     a test secret; anon, authenticated and service_role) and like the
//     Functions gateway (verify_jwt), running the REAL Edge Function handler
//     (supabase/functions/issue-trial/handler.mjs) with a throwaway key.
//   * The app is the real phone build and the real desktop build, assembled
//     by build.js unobfuscated, with key 1 swapped for the test public key in
//     this test's copy only.
// Covers: the function (CORS, method, not configured, unregistered device,
// refusals passed through, success, repeat, a used phone, a joined till's
// cover, service-role-only attach, no secrets in answers, no ledger entry);
// the app: setup without an RPN (pretrial: products yes, selling, reports
// and marketing no), starting the trial from the banner (wrong PIN, then
// right), setup with an RPN (trial at Finish), a used phone (refusal with
// Try again / Continue without), offline at Finish, the desktop Sales cart
// in pretrial, at 390 and 1280 px.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { newPglite, buildFromRepo, v21AdminSeed } = require("../supabase/tests/rebuild-helpers");
const build = require("../build.js");

let chromium;
require("./local-cdn");   // the cdnjs files from test/cdn/, not the internet
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
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

// ---------------- keys and tokens (all throwaway) ----------------
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const b64u = (b)=> Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const jwt = (claims)=>{
  const h = b64u(JSON.stringify({ alg:"HS256", typ:"JWT" })), p = b64u(JSON.stringify(claims));
  return h+"."+p+"."+b64u(crypto.createHmac("sha256", JWT_SECRET).update(h+"."+p).digest());
};
const TEST_ANON = jwt({ role:"anon", iss:"supabase" });
const TEST_SERVICE = jwt({ role:"service_role", iss:"supabase" });
const APP_ANON = /const DC_ANON_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT,"src","devicecheckin.js"),"utf8"))[1];
function verifyJwt(token){
  if(token===APP_ANON) return { role:"anon" };
  const [h,p,s] = String(token).split(".");
  if(!h || !p || !s) return null;
  const want = b64u(crypto.createHmac("sha256", JWT_SECRET).update(h+"."+p).digest());
  if(want.length!==s.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(s))) return null;
  return JSON.parse(Buffer.from(p.replace(/-/g,"+").replace(/_/g,"/"), "base64").toString());
}
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const TEST_PUB = publicKey.export({ format:"der", type:"spki" }).subarray(-32).toString("base64");
const TEST_PKCS8 = privateKey.export({ format:"der", type:"pkcs8" }).toString("base64");

// ---------------- the fake Supabase (real SQL in PGlite) ----------------
let pg, BASE, handler;
const sq = async (sql, p)=> (await pg.query(sql, p)).rows;
const CASTS = { p_key_id:"::integer", p_serial:"::integer", p_after_serial:"::integer", p_earliest_sale:"::date", p_branch_id:"::uuid",
  p_rpn_hint_id:"::uuid", p_limit:"::integer", p_cursor:"::bigint", p_rows:"::jsonb", p_uids:"::text[]", p_active:"::boolean", p_terminal_id:"::uuid" };
let queue = Promise.resolve();
const rpcLog = [];
function runRpc(name, body, claims){
  const run = async ()=>{
    const keys = Object.keys(body);
    const vals = keys.map(k=> k==="p_rows"? JSON.stringify(body[k]) : k==="p_uids"? "{"+body[k].join(",")+"}" : body[k]);
    const role = ["authenticated","service_role"].includes(claims.role)? claims.role : "anon";
    await pg.exec("set role "+role);
    await pg.query("select set_config('request.jwt.claims', $1, false)", [role==="anon"? "" : JSON.stringify(claims)]);
    try{ return { status:200, json:(await pg.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}${CASTS[k]||""}`).join(",")})::json j`, vals)).rows[0].j }; }
    catch(e){
      const denied = e.code==="42501" || /permission denied/i.test(e.message);
      return { status: denied? (role==="anon"? 401 : 403) : (/function .* does not exist/.test(e.message)? 404 : e.code==="P0002"? 500 : 400), json:{ code:e.code||"P0001", message:e.message } };
    }
    finally{ await pg.exec("reset role"); await pg.query("select set_config('request.jwt.claims', '', false)"); }
  };
  const p = queue.then(run, run); queue = p.catch(()=>{}); return p;
}
const CORS = { "access-control-allow-origin":"*", "access-control-allow-headers":"authorization, apikey, content-type, x-client-info" };
function startServer(){
  return new Promise((resolve)=>{
    const srv = http.createServer(async (req, res)=>{
      const chunks = []; for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString();
      const send = (status, obj)=>{ res.writeHead(status, Object.assign({ "content-type":"application/json" }, CORS)); res.end(typeof obj==="string"? obj : JSON.stringify(obj)); };
      if(req.method==="HEAD") return send(200, "");
      const auth = /^Bearer\s+(\S+)$/.exec(req.headers.authorization||"");
      const token = auth? auth[1] : req.headers.apikey;
      let m = /^\/rest\/v1\/rpc\/([a-z_0-9]+)$/.exec(req.url);
      if(m){
        if(req.method==="OPTIONS") return send(200, "");
        const claims = token? verifyJwt(token) : null;
        if(!claims) return send(401, { code:"PGRST301", message:"JWT invalid" });
        let body = {}; try{ body = JSON.parse(text||"{}"); }catch(e){}
        rpcLog.push({ name:m[1], role:claims.role });
        const r = await runRpc(m[1], body, claims);
        return send(r.status, r.json);
      }
      if(/^\/functions\/v1\/issue-trial$/.test(req.url)){
        // The gateway (verify_jwt): a missing or bad JWT never reaches the function.
        if(req.method!=="OPTIONS" && !(auth && verifyJwt(auth[1]))) return send(401, { code:401, message:"Invalid JWT" });
        const r = await handler(new Request("http://edge"+req.url, { method:req.method, headers:req.headers, body: req.method==="POST"? text : undefined }));
        res.writeHead(r.status, Object.fromEntries(r.headers.entries())); return res.end(await r.text());
      }
      send(404, { message:"not found" });
    });
    srv.listen(0, "127.0.0.1", ()=> resolve(srv));
  });
}
const callFn = (body, opts)=> fetch(BASE+"/functions/v1/issue-trial", { method:(opts&&opts.method)||"POST",
  headers:{ "content-type":"application/json", apikey:TEST_ANON, authorization:"Bearer "+TEST_ANON }, body: (opts&&opts.method)==="GET"? undefined : JSON.stringify(body||{}) })
  .then(async r=>({ status:r.status, headers:r.headers, text: await r.text() })).then(r=> Object.assign(r, { json: (()=>{ try{ return JSON.parse(r.text); }catch(e){ return null; } })() }));

// A device known to the server (checked in), from Node.
const KEYS = {}, PHRASES = {};
const keyOf = (iid)=> (KEYS[iid] = KEYS[iid] || crypto.randomBytes(16).toString("hex"));
async function checkin(iid, phrase){
  PHRASES[iid] = phrase;
  const r = await runRpc("cl_device_checkin", { p_install_id:iid, p_shop_secret_phrase:phrase, p_device_code:iid, p_business_name:"Shop "+iid, p_device_key:keyOf(iid) }, { role:"anon" });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
}
const ask = (iid, o)=> callFn(Object.assign({ install_id:iid, phrase:PHRASES[iid], device_key:keyOf(iid), owner_phone:"0772 123 456", field_force_no:"RPN-014", pin:"123456" }, o||{}));

// The licence a device got: parsed and checked with the test public key.
function readLicence(text){
  const b = Buffer.from(text.slice(4).replace(/-/g,"+").replace(/_/g,"/"), "base64");
  const plen = (b[27] & 2)? 46 : 30;
  const ok = crypto.verify(null, b.subarray(0, plen), publicKey, b.subarray(plen));
  return { ok, flags:b[27], install:b.subarray(6,14).toString("latin1").replace(/\0+$/,""), untilDay:b.readUInt16BE(24), issuedDay:b.readUInt16BE(22), serial:b.readUInt32BE(2) };
}

// ---------------- the builds ----------------
const REAL_KEY_LINE = /1: "VLNqCYsJ2c6yZ\+MToGEfn0zoRoQYpBWZ\/f9naRP8jjA=",/;
function writeBuild(kind){
  let html = kind==="desktop"
    ? build.buildHTML(build.tauriScriptOrder(), build.DESKTOP_EXTRA_CSS).html
    : build.inlineIcons(build.buildHTML(build.SCRIPT_ORDER).html);
  assert.ok(REAL_KEY_LINE.test(html), "the build carries key 1");
  html = html.replace(REAL_KEY_LINE, '1: "'+TEST_PUB+'",');   // this test's copy only
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-trial-"));
  fs.writeFileSync(path.join(dir, "index.html"), html);
  return path.join(dir, "index.html");
}

// ---------------- driving a device ----------------
async function device(browser, kind, file){
  const desktop = kind==="desktop";
  const ctx = await browser.newContext({ viewport: desktop? { width:1280, height:800 } : { width:390, height:844 } });
  const d = { blockServer:false };
  await ctx.route(/urbopdsubwawtybwrxjd\.supabase\.co\//, async route=>{
    const req = route.request();
    if(d.blockServer) return route.abort("internetdisconnected");
    if(req.method()==="HEAD") return route.fulfill({ status:200, headers:{ "access-control-allow-origin":"*" }, body:"" });
    const r = await fetch(BASE + new URL(req.url()).pathname, { method:req.method(), headers:{ "content-type":"application/json", apikey:req.headers()["apikey"]||"", authorization:req.headers()["authorization"]||"" }, body: req.method()==="POST"? req.postData() : undefined });
    return route.fulfill({ status:r.status, contentType:"application/json", headers:{ "access-control-allow-origin":"*" }, body: await r.text() });
  });
  const page = await ctx.newPage();
  const pageErrors = [], dialogs = [];
  page.on("pageerror", e=>pageErrors.push(e.message));
  page.on("dialog", dl=>{ dialogs.push(dl.message()); dl.accept(); });
  return Object.assign(d, { ctx, page, pageErrors, dialogs, desktop, url:fileUrl(file), kind });
}
async function shot(d, name){ if(SHOTS) await d.page.screenshot({ path: path.join(SHOTS, d.kind+"-"+name+".png"), fullPage:true }); }
async function nav(d, route){
  if(d.desktop){ await d.page.click("#hamburgerBtn"); await d.page.click('#navDrawer [data-route="'+route+'"]'); }
  else await d.page.click('.navbar [data-route="'+route+'"]');
}
// o: { shop, phrase, phone, ff, pin } ; stops on the screen Finish leads to
async function setup(d, o){
  const p = d.page;
  await p.goto(d.url);
  await p.waitForSelector("#setShop", { timeout:30000 });
  await p.fill("#setShop", o.shop); await p.fill("#setSecret", o.phrase);
  await p.click("#setupNext");
  await p.fill("#setOwnerPhone", o.phone);
  await p.click("#setupNext2");
  if(o.ff){ await p.fill("#setRpnVFf", o.ff); await p.fill("#setRpnVPin", o.pin); }
  await p.click("#setupNext3");
  await p.click("#setupFinish");
}
async function addProduct(d, name){
  const p = d.page;
  await nav(d, "products");
  await p.click("#openAddProduct"); await p.waitForSelector("#pName");
  await p.fill("#pName", name); await p.fill("#pPrice", "5");
  if(await p.$("#pCost")) await p.fill("#pCost", "3");
  await p.fill("#pStock", "10");
  await p.click("#pConfirm"); await p.waitForSelector(".modalOverlay", { state:"detached" });
  await p.waitForTimeout(300);
}
async function openAbout(d){
  await nav(d, "more");
  await d.page.locator('[data-kebab-toggle="moretab"]:visible').first().click();
  await d.page.locator('[data-tab="about"]:visible').first().click();
  await d.page.waitForSelector("#licenceCard");
}
const ledgerRows = async ()=> (await sq("select count(*)::int n from cl_ledger_entries"))[0].n;

(async()=>{
  // ---- server ----
  pg = await newPglite();
  await buildFromRepo(pg, { skip: [] });   // every migration, the trial rules included
  for(const [ff, active, pin] of [["RPN-014", true, "123456"], ["RPN-020", false, "222222"]]){
    const id = (await sq(`insert into cl_rpn (id, full_name, passcode_hash, verification_code, verification_used, active, created_at, field_force_no)
      values (gen_random_uuid(), $1, 'x', $3 || '-v', false, $2, now(), $3) returning id`, ["Agent "+ff, active, ff]))[0].id;
    await sq(`insert into cl_rpn_pins (rpn_id, pin_hash) values ($1, extensions.crypt($2, extensions.gen_salt('bf')))`, [id, pin]);
  }
  const srv = await startServer();
  BASE = "http://127.0.0.1:" + srv.address().port;
  const { makeHandler } = await import("../supabase/functions/issue-trial/handler.mjs");
  const ENV = { supabaseUrl:BASE, anonKey:TEST_ANON, serviceRoleKey:TEST_SERVICE, signingKey:TEST_PKCS8, keyId:1 };
  handler = makeHandler(ENV);

  console.log("issue-trial (the real handler, real SQL)");
  await t("the signing helper is the same file as issue-licence's", async ()=>{
    assert.strictEqual(fs.readFileSync(path.join(ROOT,"supabase/functions/issue-trial/sign.mjs"),"utf8"), fs.readFileSync(path.join(ROOT,"supabase/functions/issue-licence/sign.mjs"),"utf8"));
  });
  await t("CORS preflight answers; GET is refused (405); a missing JWT stops at the gateway (401)", async ()=>{
    const o = await fetch(BASE+"/functions/v1/issue-trial", { method:"OPTIONS" });
    assert.strictEqual(o.status, 200); assert.strictEqual(o.headers.get("access-control-allow-origin"), "*");
    assert.strictEqual((await callFn(null, { method:"GET" })).status, 405);
    assert.strictEqual((await fetch(BASE+"/functions/v1/issue-trial", { method:"POST", body:"{}" })).status, 401);
  });
  await t("not configured (no signing key or no service role key): 500 with the plain try-again message", async ()=>{
    for(const miss of ["signingKey", "serviceRoleKey"]){
      handler = makeHandler(Object.assign({}, ENV, { [miss]:"" }));
      const r = await callFn({});
      assert.strictEqual(r.status, 500); assert.strictEqual(r.json.code, "NOT_CONFIGURED"); assert.match(r.json.message, /Try again in a minute/);
    }
    handler = makeHandler(ENV);
  });
  await t("a device seiGEN doesn't know: refused with the server's reason, nothing recorded", async ()=>{
    const r = await callFn({ install_id:"NOPE", phrase:"x", device_key:"y", owner_phone:"0772123456", field_force_no:"RPN-014", pin:"123456" });
    assert.strictEqual(r.json.ok, false); assert.strictEqual(r.json.code, "DEVICE_REFUSED"); assert.match(r.json.message, /not registered/);
    assert.strictEqual((await sq("select count(*)::int n from cl_trials"))[0].n, 0);
  });
  await t("before the migration is on the server (no cl_trial_request): the plain try-again, never the database's text", async ()=>{
    const real = handler;
    handler = makeHandler(Object.assign({}, ENV, { supabaseUrl: BASE + "/nowhere" }));
    const r = await callFn({ install_id:"NOPE", phrase:"x", device_key:"y" });
    handler = real;
    assert.strictEqual(r.status, 502); assert.strictEqual(r.json.code, "SERVER"); assert.match(r.json.message, /Try again in a minute/);
  });
  await checkin("TRA1", "Trial Shop One");
  await t("refusals pass through as answers (200, ok:false, the code and its plain message): no RPN, wrong PIN, suspended RPN, bad phone", async ()=>{
    let r = await ask("TRA1", { field_force_no:null, pin:null });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.code, "RPN_MISSING");
    r = await ask("TRA1", { pin:"000000" }); assert.strictEqual(r.json.code, "RPN_NO_MATCH"); assert.match(r.json.message, /don't match/);
    r = await ask("TRA1", { field_force_no:"RPN-020", pin:"222222" }); assert.strictEqual(r.json.code, "RPN_SUSPENDED");
    r = await ask("TRA1", { owner_phone:"024 2123456" }); assert.strictEqual(r.json.code, "PHONE_INVALID");
    assert.strictEqual((await sq("select count(*)::int n from cl_trials"))[0].n, 0);
  });
  let firstLicence = null;
  await t("success: a signed trial licence for this device (trial flag, 30 days), stored as issued, no ledger entry", async ()=>{
    const before = await ledgerRows();
    rpcLog.length = 0;
    const r = await ask("TRA1");
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.ok, true, r.text); assert.strictEqual(r.json.kind, "standard");
    const L = readLicence(r.json.licence);
    assert.ok(L.ok, "signed with the configured key"); assert.strictEqual(L.flags & 4, 4, "trial bit"); assert.strictEqual(L.flags & 1, 1, "strong binding");
    assert.strictEqual(L.install, "TRA1"); assert.strictEqual(L.untilDay - L.issuedDay, 30);
    const row = (await sq("select status, kind, licence, issued_by from cl_licences where serial = $1", [r.json.serial]))[0];
    assert.strictEqual(row.status, "issued"); assert.strictEqual(row.kind, "trial"); assert.strictEqual(row.licence, r.json.licence); assert.strictEqual(row.issued_by, null);
    assert.strictEqual(await ledgerRows(), before, "no charge, so no commission");
    assert.deepStrictEqual(rpcLog.map(x=>x.name+":"+x.role), ["cl_trial_request:anon", "cl_trial_attach:service_role"], "the service role is used for the attach only");
    assert.ok(!r.text.includes(TEST_PKCS8) && !r.text.includes(TEST_SERVICE), "no secret in the answer");
    firstLicence = r.json.licence;
  });
  await t("asking again (a lost answer): the same licence, no second trial", async ()=>{
    const r = await ask("TRA1", { owner_phone:null, field_force_no:null, pin:null });
    assert.strictEqual(r.json.ok, true); assert.strictEqual(r.json.licence, firstLicence);
    assert.strictEqual((await sq("select count(*)::int n from cl_trials"))[0].n, 1);
  });
  await t("another install with the same phone in another spelling: PHONE_USED", async ()=>{
    await checkin("TRA2", "Trial Shop Two");
    const r = await ask("TRA2", { owner_phone:"+263 77 212 3456" });
    assert.strictEqual(r.json.code, "PHONE_USED"); assert.match(r.json.message, /already used its free trial/);
  });
  await t("Q8: sales older than 30 days refuse the trial (and don't use up the phone)", async ()=>{
    const r = await ask("TRA2", { owner_phone:"0712 000 111", earliest_sale:"2026-01-02" });
    assert.strictEqual(r.json.code, "TRIAL_OLD_DATA");
    assert.strictEqual((await sq("select count(*)::int n from cl_trials where phone_norm = '263712000111'"))[0].n, 0);
  });
  await t("a joined till gets cover to the business trial's end, with no phone or RPN", async ()=>{
    await checkin("BIZ1", "Biz Phrase");
    const reg = await runRpc("cl_branch_register", { p_install_id:"BIZ1", p_secret_phrase:"Biz Phrase", p_device_key:keyOf("BIZ1"), p_business_name:"Biz", p_branch_name:"Harare", p_legacy_branch_id:"B-HARARE01" }, { role:"anon" });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
    const main = await ask("BIZ1", { owner_phone:"0783 333 444" });
    assert.strictEqual(main.json.ok, true, main.text);
    const jc = await runRpc("cl_branch_issue_join_code", { p_install_id:"BIZ1", p_secret_phrase:"Biz Phrase", p_device_key:keyOf("BIZ1"), p_branch_id:reg.json.branch_id, p_new_branch_name:null,
      ...(()=>{ const sd = v21AdminSeed("Joined-Admin-1"); return { p_admin_salt:sd.salt, p_admin_check:sd.check, p_admin_rounds:sd.rounds }; })() }, { role:"anon" });   // v21: with its Admin passcode
    PHRASES.BIZ2 = "Biz Phrase";
    const jn = await runRpc("cl_terminal_join", { p_install_id:"BIZ2", p_secret_phrase:"Biz Phrase", p_device_key:keyOf("BIZ2"), p_join_code:jc.json.code, p_app_build:21 }, { role:"anon" });
    assert.strictEqual(jn.status, 200, JSON.stringify(jn.json));
    const cover = await ask("BIZ2", { owner_phone:null, field_force_no:null, pin:null });
    assert.strictEqual(cover.json.ok, true, cover.text); assert.strictEqual(cover.json.kind, "cover");
    assert.strictEqual(cover.json.valid_to, main.json.valid_to, "ends with the business trial");
    const L = readLicence(cover.json.licence);
    assert.ok(L.ok); assert.strictEqual(L.install, "BIZ2"); assert.strictEqual(L.flags & 4, 4);
  });
  await t("devices and staff can't store a signature: cl_trial_attach is service_role only", async ()=>{
    const pend = (await sq("select serial from cl_licences where kind='trial' limit 1"))[0].serial;
    for(const claims of [{ role:"anon" }, { role:"authenticated", sub:crypto.randomUUID(), user_type:"staff", is_sysadmin:true }]){
      const r = await runRpc("cl_trial_attach", { p_serial:pend, p_signature_hex:"00".repeat(64) }, claims);
      assert.ok(r.status===401 || r.status===403, JSON.stringify(r));
    }
  });

  // ---- the app ----
  const browser = await chromium.launch();
  const files = { phone: writeBuild("phone"), desktop: writeBuild("desktop") };
  try{
    console.log("the app: phone build");
    const P = await device(browser, "phone", files.phone);
    await t("setup asks for the owner's phone and refuses one that isn't a mobile", async ()=>{
      const p = P.page;
      await p.goto(P.url); await p.waitForSelector("#setShop", { timeout:30000 });
      await p.fill("#setShop", "Pretrial Shop"); await p.fill("#setSecret", "Pretrial Phrase"); await p.click("#setupNext");
      await p.fill("#setOwnerPhone", "024 212 3456"); await p.click("#setupNext2");
      await waitFor(async()=> P.dialogs.some(m=>/owner's phone/.test(m)), "the phone message");
      assert.ok(await p.$("#setOwnerPhone"), "still on step 2");
      await shot(P, "setup-step2");
      await p.fill("#setOwnerPhone", "0774 100 200"); await p.click("#setupNext2");
      await p.waitForSelector("#setRpnVFf");
      assert.match(await p.textContent("#setRpnNoTrial"), /no free trial/);
      await p.click("#setupNext3");
      assert.match(await p.textContent("#setupTrialNote"), /No RPN entered/);
      assert.doesNotMatch(await p.content(), /30 days free use from today/);
      await p.click("#setupFinish");
      await p.waitForSelector("#pretrialNotice");
    });
    await t("pretrial: products can be added; the cart, Reports and Marketing wait for the trial", async ()=>{
      const p = P.page;
      await addProduct(P, "Sugar 2kg");
      assert.ok(await p.$("#pretrialNotice"), "the banner on Products");
      await shot(P, "pretrial-products");
      await p.click("#cartBtn");
      await p.waitForSelector("#trialMPhone");
      await shot(P, "pretrial-trial-form");
      await p.click(".modalOverlay .close-x, .modalOverlay [data-close]").catch(()=>{});
      await p.evaluate(()=> document.querySelectorAll(".modalOverlay").forEach(m=>m.remove()));
      await nav(P, "reports");
      assert.ok(await p.$("main #pretrialNotice"), "Reports shows the notice");
      assert.ok(!(await p.$("#eodSection")), "no End of Day");
      await nav(P, "marketing");
      assert.ok(await p.$("main #pretrialNotice"), "Marketing shows the notice");
      await openAbout(P);
      assert.match(await p.textContent("#licenceLine"), /Free trial not started/);
      assert.ok(await p.$("#licenceTrial"));
    });
    await t("starting the trial from the banner: a wrong PIN says so; the right one starts it (online, signed, offline after)", async ()=>{
      const p = P.page;
      await nav(P, "products");
      await p.click("#pretrialNotice [data-trial-start]");
      await p.waitForSelector("#trialMPhone");
      assert.strictEqual(await p.inputValue("#trialMPhone"), "0774 100 200", "prefilled with the owner's phone");
      await p.fill("#trialMFf", "RPN-014"); await p.fill("#trialMPin", "999999");
      await p.click("#trialMStart");
      await waitFor(async()=> /don't match/.test(await p.textContent("#trialMMsg")), "the PIN message", 20000);
      await p.fill("#trialMPin", "123456");
      P.dialogs.length = 0;
      await p.click("#trialMStart");
      await waitFor(async()=> P.dialogs.some(m=>/Your free trial runs until/.test(m)), "the trial alert", 20000);
      await p.waitForSelector(".modalOverlay", { state:"detached" });
      assert.ok(!(await p.$("#pretrialNotice")), "the banner is gone");
      await openAbout(P);
      assert.match(await p.textContent("#licenceLine"), /Free trial until/);
      const row = (await sq("select t.phone_norm, r.field_force_no from cl_trials t join cl_rpn r on r.id = t.rpn_id where t.install_id = (select install_id from cl_vendors where business_name='Pretrial Shop')"))[0];
      assert.deepStrictEqual(row, { phone_norm:"263774100200", field_force_no:"RPN-014" });
      await shot(P, "trial-about");
    });
    await t("after the trial: the cart opens with its Pay buttons, and Cash doesn't ask for the trial", async ()=>{
      const p = P.page;
      await nav(P, "pos");
      await p.click("[data-add]");
      await p.click("#cartBtn");
      await p.waitForSelector("#drawer.show #payCash");
      assert.ok(!(await p.$("#drawer #pretrialNotice")));
      await p.click("#drawer #payCash");
      await p.waitForTimeout(500);
      assert.ok(!(await p.$("#trialMPhone")), "no trial form");
    });
    await P.ctx.close();

    const Q = await device(browser, "phone", files.phone);
    await t("setup with the RPN: Finish starts the trial and says until when", async ()=>{
      await setup(Q, { shop:"RPN Shop", phrase:"RPN Shop Phrase", phone:"+263 78 555 6667", ff:"RPN-014", pin:"123456" });
      await Q.page.waitForSelector("#trialContinue", { timeout:30000 });
      assert.match(await Q.page.textContent("#trialResult"), /Your free trial runs until \d{1,2} [A-Z][a-z]{2} 2026\./);
      await shot(Q, "setup-trial-started");
      await Q.page.click("#trialContinue");
      await Q.page.waitForSelector("[data-route]");
      assert.ok(!(await Q.page.$("#pretrialNotice")));
    });
    await Q.ctx.close();

    const R = await device(browser, "phone", files.phone);
    await t("setup with a phone that already had its trial: the plain refusal, Try again and Continue without the trial", async ()=>{
      await setup(R, { shop:"Reused Phone Shop", phrase:"Reused Phrase", phone:"0785556667", ff:"RPN-014", pin:"123456" });
      await R.page.waitForSelector("#trialRetry", { timeout:30000 });
      assert.match(await R.page.textContent("#trialResult"), /already used its free trial/);
      await shot(R, "setup-trial-refused");
      await R.page.click("#trialRetry");
      await R.page.waitForSelector("#trialSPhone");
      await R.page.click("#trialSkip2");
      await R.page.waitForSelector("#pretrialNotice");
    });
    await R.ctx.close();

    const S = await device(browser, "phone", files.phone);
    await t("offline at Finish: 'Connect to the internet to start your free trial.'", async ()=>{
      S.blockServer = true;
      await setup(S, { shop:"Offline Shop", phrase:"Offline Phrase", phone:"0716 777 888", ff:"RPN-014", pin:"123456" });
      await S.page.waitForSelector("#trialRetry", { timeout:30000 });
      assert.strictEqual((await S.page.textContent("#trialResult")).trim(), "Connect to the internet to start your free trial.");
    });
    await S.ctx.close();

    console.log("the app: desktop build");
    const D = await device(browser, "desktop", files.desktop);
    await t("desktop pretrial: the Sales cart panel shows the notice; the trial starts from it", async ()=>{
      await setup(D, { shop:"Desktop Shop", phrase:"Desktop Phrase", phone:"0733 444 555" });
      await D.page.waitForSelector(".ds-cart #pretrialNotice", { timeout:30000 });
      await shot(D, "pretrial-sales");
      await D.page.click(".ds-cart [data-trial-start]");
      await D.page.fill("#trialMFf", "RPN-014"); await D.page.fill("#trialMPin", "123456");
      D.dialogs.length = 0;
      await D.page.click("#trialMStart");
      await waitFor(async()=> D.dialogs.some(m=>/Your free trial runs until/.test(m)), "the trial alert", 20000);
      await waitFor(async()=> !(await D.page.$(".ds-cart #pretrialNotice")), "the cart to come back");
      await shot(D, "trial-sales");
    });
    await t("no page errors on any device", async ()=>{
      for(const d of [P, Q, R, S, D]) assert.deepStrictEqual(d.pageErrors, [], d.kind+" page errors");
    });
    await D.ctx.close();
  } finally {
    await browser.close();
    srv.close();
  }
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
