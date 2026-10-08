// Run: node --no-warnings test/licence-e2e.test.js     (SHOT_DIR=<dir> saves screenshots)
//
// Activation v2 end to end, nothing reaching the live project:
//   * "Supabase" is the REAL server SQL (baseline + every migration, the
//     licence migration included) in an in-memory PGlite, behind a small
//     local HTTP server that behaves like PostgREST (HS256 JWTs checked with
//     a test secret; the role and claims come from the token) and like the
//     Functions gateway (verify_jwt), running the REAL Edge Function handler
//     (supabase/functions/issue-licence/handler.mjs) with a throwaway key.
//   * Staff sign in with the real cl_login (Vault secret stubbed with the
//     test secret) through the REAL CLI (tools/licence/issue.js).
//   * The app is the real phone build (dist order) and the real desktop
//     build (Tauri order), assembled by build.js unobfuscated, with key 1
//     swapped for the test public key in this test's copy only.
// Covers: Edge Function auth refusals (no token, anon key, forged token,
// RPN, staff without the permission) and success; the CLI (no token or
// passcode in its output); every lock/activation state and error at 390px
// and 1280px; link / long code / short code; read-only Reports after
// expiry; a link on a device with no setup; Q13 (foreground re-check).
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { newPglite, buildFromRepo, NOT_ON_LIVE_FILES } = require("../supabase/tests/rebuild-helpers");
const build = require("../build.js");

let chromium;
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
const jwt = (claims, secret)=>{
  const h = b64u(JSON.stringify({ alg:"HS256", typ:"JWT" })), p = b64u(JSON.stringify(claims));
  return h+"."+p+"."+b64u(crypto.createHmac("sha256", secret||JWT_SECRET).update(h+"."+p).digest());
};
const TEST_ANON = jwt({ role:"anon", iss:"supabase" });
const APP_ANON = /const DC_ANON_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT,"src","devicecheckin.js"),"utf8"))[1];
function verifyJwt(token){
  if(token===TEST_ANON || token===APP_ANON) return { role:"anon" };
  const [h,p,s] = String(token).split(".");
  if(!h || !p || !s) return null;
  const want = b64u(crypto.createHmac("sha256", JWT_SECRET).update(h+"."+p).digest());
  if(want.length!==s.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(s))) return null;
  const c = JSON.parse(Buffer.from(p.replace(/-/g,"+").replace(/_/g,"/"), "base64").toString());
  if(c.exp && c.exp < Date.now()/1000) return null;
  return c;
}
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const TEST_PUB = publicKey.export({ format:"der", type:"spki" }).subarray(-32).toString("base64");
const TEST_PKCS8 = privateKey.export({ format:"der", type:"pkcs8" }).toString("base64");

// A licence laid out as cl_licence_prepare builds it, signed here (for the
// cases the server never issues: expired, unknown key).
const EPOCH = Date.UTC(2026,0,1), DAY = 86400000;
function craft(o){
  const h = crypto.createHash("sha512").update(o.deviceKey, "utf8").digest();
  const p = Buffer.alloc(30);
  p[0] = 2; p[1] = o.kid||1; p.writeUInt32BE(o.serial||900, 2);
  Buffer.from(o.install, "latin1").copy(p, 6); h.subarray(0,8).copy(p, 14);
  p.writeUInt16BE(Math.floor((o.issuedMs-EPOCH)/DAY), 22); p.writeUInt16BE(Math.floor((o.untilMs-EPOCH)/DAY), 24);
  p[27] = 1;
  return "SL2." + b64u(Buffer.concat([p, crypto.sign(null, p, privateKey)]));
}

// ---------------- the fake Supabase (real SQL in PGlite) ----------------
let pg, BASE, handlerNoGateway, handler;
const sq = async (sql, p)=> (await pg.query(sql, p)).rows;
const CASTS = { p_business_id:"::uuid", p_days:"::integer", p_plan:"::integer", p_key_id:"::integer", p_serial:"::integer",
  p_after_serial:"::integer", p_limit:"::integer", p_rows:"::jsonb", p_uids:"::text[]", p_branch_id:"::uuid", p_terminal_id:"::uuid",
  p_cursor:"::bigint", p_active:"::boolean", p_rpn_hint_id:"::uuid" };
let queue = Promise.resolve();
const rpcLog = [];
function runRpc(name, body, claims){
  const run = async ()=>{
    const keys = Object.keys(body);
    const vals = keys.map(k=> k==="p_rows"? JSON.stringify(body[k]) : k==="p_uids"? "{"+body[k].join(",")+"}" : body[k]);
    const role = claims.role==="authenticated"? "authenticated" : "anon";
    await pg.exec("set role "+role);
    await pg.query("select set_config('request.jwt.claims', $1, false)", [role==="anon"? "" : JSON.stringify(claims)]);
    try{ return { status:200, json:(await pg.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}${CASTS[k]||""}`).join(",")})::json j`, vals)).rows[0].j }; }
    catch(e){
      const denied = e.code==="42501" || /permission denied/i.test(e.message);
      return { status: denied? (role==="anon"? 401 : 403) : 400, json:{ code:e.code||"P0001", message:e.message } };
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
      const send = (status, obj, headers)=>{ res.writeHead(status, Object.assign({ "content-type":"application/json" }, CORS, headers||{})); res.end(typeof obj==="string"? obj : JSON.stringify(obj)); };
      if(req.method==="OPTIONS" || req.method==="HEAD") return send(200, "");
      const auth = /^Bearer\s+(\S+)$/.exec(req.headers.authorization||"");
      const token = auth? auth[1] : req.headers.apikey;
      let m = /^\/rest\/v1\/rpc\/([a-z_0-9]+)$/.exec(req.url);
      if(m){
        const claims = token? verifyJwt(token) : null;
        if(!claims) return send(401, { code:"PGRST301", message:"JWT invalid" });
        let body = {}; try{ body = JSON.parse(text||"{}"); }catch(e){}
        rpcLog.push({ name:m[1], role:claims.role });
        const r = await runRpc(m[1], body, claims);
        return send(r.status, r.json);
      }
      m = /^\/(functions|functions-nogw)\/v1\/issue-licence$/.exec(req.url);
      if(m){
        // The gateway (verify_jwt): a missing or bad JWT never reaches the function.
        if(m[1]==="functions" && !(auth && verifyJwt(auth[1]))) return send(401, { code:401, message:"Invalid JWT" });
        const h = m[1]==="functions"? handler : handlerNoGateway;
        const r = await h(new Request("http://edge"+req.url, { method:req.method, headers:req.headers, body: req.method==="POST"? text : undefined }));
        return send(r.status, await r.text());
      }
      send(404, { message:"not found" });
    });
    srv.listen(0, "127.0.0.1", ()=> resolve(srv));
  });
}
const callFn = (pathname, token, body)=> fetch(BASE+pathname, { method:"POST",
  headers: Object.assign({ "content-type":"application/json", apikey:TEST_ANON }, token? { authorization:"Bearer "+token } : {}),
  body: JSON.stringify(body||{}) }).then(async r=>({ status:r.status, json: await r.json().catch(()=>null) }));

// The real CLI, as a staff member (credentials through the environment).
// Each issue here is a deliberate new licence, not a repeated tap: earlier
// ones are aged past the server's 30-second duplicate guard (20261012120000).
async function cli(args, who){
  await pg.exec("update cl_licences set issued_at = issued_at - interval '1 minute'");
  return new Promise((resolve)=>{
    execFile(process.execPath, [path.join(ROOT,"tools","licence","issue.js"), ...args], {
      env: Object.assign({}, process.env, { SUPABASE_URL:BASE, SUPABASE_ANON_KEY:TEST_ANON, LICENCE_FUNCTION_URL:BASE+"/functions/v1/issue-licence",
        SEIGEN_STAFF_NAME:who.name, SEIGEN_STAFF_PASSCODE:who.pass }), timeout:60000,
    }, (err, stdout, stderr)=> resolve({ code: err? (err.code||1) : 0, out: stdout+stderr }));
  });
}
function parseIssue(out){
  return { link:(/^(https:\/\/\S+#lic=SL2\.\S+)$/m.exec(out)||[])[1], long:(/^(SL2\.[A-Za-z0-9_-]+)$/m.exec(out)||[])[1],
    short:(/^([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2})$/m.exec(out)||[])[1], serial:Number((/licence #(\d+)/.exec(out)||[])[1]) };
}
const STAFF_A = { name:"Tendai Staff", pass:"a-good-passcode-1" };   // has Activation Codes
const STAFF_B = { name:"Rudo Staff", pass:"another-passcode-2" };    // doesn't

// ---------------- the builds ----------------
const REAL_KEY_LINE = /1: "VLNqCYsJ2c6yZ\+MToGEfn0zoRoQYpBWZ\/f9naRP8jjA=",/;
function writeBuild(kind){
  let html = kind==="desktop"
    ? build.buildHTML(build.tauriScriptOrder(), build.DESKTOP_EXTRA_CSS).html
    : build.inlineIcons(build.buildHTML(build.SCRIPT_ORDER).html);
  assert.ok(REAL_KEY_LINE.test(html), "the build carries key 1");
  html = html.replace(REAL_KEY_LINE, '1: "'+TEST_PUB+'",');   // this test's copy only
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-lic-"));
  fs.writeFileSync(path.join(dir, "index.html"), html);
  return path.join(dir, "index.html");
}

// ---------------- driving a device ----------------
const PHRASE = "Licence Test Phrase";
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
  page.on("dialog", d=>{ dialogs.push(d.message()); d.accept(); });
  return Object.assign(d, { ctx, page, pageErrors, dialogs, desktop, url:fileUrl(file), kind });
}
async function shot(d, name){ if(SHOTS) await d.page.screenshot({ path: path.join(SHOTS, d.kind+"-"+name+".png"), fullPage:true }); }
async function nav(d, route){
  if(d.desktop){ await d.page.click("#hamburgerBtn"); await d.page.click('#navDrawer [data-route="'+route+'"]'); }
  else await d.page.click('.navbar [data-route="'+route+'"]');
}
async function signIn(d){
  await d.page.waitForSelector("#startSignIn", { timeout:30000 });
  await d.page.click("#startSignIn"); await d.page.waitForSelector("#whoName");
  await d.page.fill("#whoName", "Owner"); await d.page.click("#whoContinue");
  await d.page.waitForSelector("[data-route]");
}
async function setup(d, shop){
  const p = d.page;
  await p.goto(d.url);
  await p.waitForSelector("#setShop", { timeout:30000 });
  await p.fill("#setShop", shop); await p.fill("#setSecret", PHRASE);
  await p.click("#setupNext"); await p.click("#setupNext2"); await p.click("#setupNext3"); await p.click("#setupFinish");
  await p.waitForSelector("[data-route]");
  await p.waitForTimeout(500);
}
async function addProduct(d, name){
  const p = d.page;
  await nav(d, "products");
  await p.click("#openAddProduct"); await p.waitForSelector("#pName");
  await p.fill("#pName", name); await p.fill("#pPrice", "5");
  if(await p.$("#pCost")) await p.fill("#pCost", "3");
  await p.fill("#pStock", "10");
  await p.click("#pConfirm"); await p.waitForSelector(".modalOverlay", { state:"detached" });
  await p.waitForTimeout(400);
}
async function openAbout(d){
  await nav(d, "more");
  await d.page.click('[data-kebab-toggle="moretab"]');
  await d.page.click('[data-tab="about"]');
  await d.page.waitForSelector("#licenceCard");
}
// The app's settings, read from IndexedDB with the page's sql.js.
async function settingsOf(d){
  return d.page.evaluate(async ()=>{
    const bytes = await new Promise((res, rej)=>{
      const r = indexedDB.open("seigen_lite_db", 1);
      r.onsuccess = ()=>{ const g = r.result.transaction("kv","readonly").objectStore("kv").get("dbfile"); g.onsuccess = ()=>res(g.result); g.onerror = ()=>rej(g.error); };
      r.onerror = ()=>rej(r.error);
    });
    const SQL = await initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/"+f });
    const db = new SQL.Database(new Uint8Array(bytes));
    const res = db.exec("SELECT key, value FROM settings"); db.close();
    return Object.fromEntries(res[0].values);
  });
}
async function activate(d, text){
  await d.page.fill("#actCode", text);
  await d.page.click("#unlockBtn");
  await waitFor(async()=> !(await d.page.isDisabled("#unlockBtn").catch(()=>false)), "the Activate button to come back", 20000);
}
const msg = (d)=> d.page.textContent("#actMsg");

(async()=>{
  // ---- server ----
  pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter(f=>!/activation_licences/.test(f)) });
  await pg.exec(`create or replace view vault.decrypted_secrets as select gen_random_uuid() id, 'cl_jwt_secret'::text name, '${JWT_SECRET}'::text decrypted_secret, now() created_at`);
  const staffId = {};
  for(const s of [STAFF_A, STAFF_B])
    staffId[s.name] = (await sq(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, extensions.crypt($2, extensions.gen_salt('bf')), false, true, now()) returning id`, [s.name, s.pass]))[0].id;
  const mod = (await sq(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), 'activation_codes', 'Activation Codes', 3) returning id`))[0].id;
  await sq(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staffId[STAFF_A.name], mod]);
  const OTHER_KEY = crypto.randomBytes(16).toString("hex");
  await sq(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status) values ('Other Shop','OTHR','Other Phrase',$1,'onboarding')`, [OTHER_KEY]);
  const otherCode = "OTHR-" + (await sq(`select public.cl_licence_tag(public.cl_licence_hash($1)) t`, [OTHER_KEY]))[0].t;
  const srv = await startServer();
  BASE = "http://127.0.0.1:" + srv.address().port;
  const { makeHandler } = await import("../supabase/functions/issue-licence/handler.mjs");
  handler = makeHandler({ supabaseUrl:BASE, anonKey:TEST_ANON, signingKey:TEST_PKCS8, keyId:1 });
  handlerNoGateway = handler;

  const loginTok = async (who)=> (await runRpc("cl_login", { p_name:who.name, p_passcode:who.pass }, { role:"anon" })).json.token;
  const tokA = await loginTok(STAFF_A), tokB = await loginTok(STAFF_B);

  console.log("Edge Function auth");
  await t("no Authorization header: refused by the gateway (401) and by the function itself (401)", async ()=>{
    assert.strictEqual((await callFn("/functions/v1/issue-licence", null, { device_code:otherCode })).status, 401);
    const r = await callFn("/functions-nogw/v1/issue-licence", null, { device_code:otherCode });
    assert.strictEqual(r.status, 401); assert.match(r.json.error, /Sign in as seiGEN staff/);
  });
  await t("the anon key (anonymous): 403, nothing prepared", async ()=>{
    const before = (await sq("select count(*)::int n from cl_licences"))[0].n;
    const r = await callFn("/functions/v1/issue-licence", TEST_ANON, { device_code:otherCode });
    assert.strictEqual(r.status, 403); assert.match(r.json.error, /Not authorized/);
    assert.strictEqual((await sq("select count(*)::int n from cl_licences"))[0].n, before);
  });
  await t("a forged staff token (wrong secret): the gateway says 401; without the gateway the database refuses it (403)", async ()=>{
    const forged = jwt({ role:"authenticated", sub:staffId[STAFF_A.name], user_type:"staff", is_sysadmin:true }, "not-the-secret");
    assert.strictEqual((await callFn("/functions/v1/issue-licence", forged, { device_code:otherCode })).status, 401);
    const r = await callFn("/functions-nogw/v1/issue-licence", forged, { device_code:otherCode });
    assert.strictEqual(r.status, 403, JSON.stringify(r.json));
  });
  await t("an RPN token: 403", async ()=>{
    const rpn = jwt({ role:"authenticated", sub:crypto.randomUUID(), user_type:"rpn" });
    assert.strictEqual((await callFn("/functions/v1/issue-licence", rpn, { device_code:otherCode })).status, 403);
  });
  await t("a staff member WITHOUT the Activation Codes permission: 403, nothing prepared", async ()=>{
    const before = (await sq("select count(*)::int n from cl_licences"))[0].n;
    const r = await callFn("/functions/v1/issue-licence", tokB, { device_code:otherCode });
    assert.strictEqual(r.status, 403, JSON.stringify(r.json)); assert.match(r.json.error, /Activation Codes permission/);
    assert.strictEqual((await sq("select count(*)::int n from cl_licences"))[0].n, before);
  });
  await t("staff WITH the permission: issued, signed, logged with who issued it", async ()=>{
    const r = await callFn("/functions/v1/issue-licence", tokA, { device_code:otherCode, days:30 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.public_key, TEST_PUB, "signed with the configured key");
    const l = r.json.licences[0];
    assert.match(l.licence, /^SL2\./);
    const row = (await sq("select issued_by, status from cl_licences where serial=$1", [l.serial]))[0];
    assert.strictEqual(row.issued_by, staffId[STAFF_A.name]); assert.strictEqual(row.status, "issued");
    assert.strictEqual((await sq("select count(*)::int n from cl_activity_log where action='issue_licence' and staff_id=$1", [staffId[STAFF_A.name]]))[0].n, 1);
  });

  console.log("the CLI (holds no key; signs in as staff)");
  let other;
  await t("staff WITH the permission: a WhatsApp message with the link, the long code and the short code", async ()=>{
    const r = await cli(["--device", otherCode, "--days", "90", "--preview"], STAFF_A);
    assert.strictEqual(r.code, 0, r.out);
    other = parseIssue(r.out);
    assert.ok(other.link && other.long && other.short, r.out);
    assert.ok(other.link.startsWith("https://mobilepos-preview.seigendc.workers.dev/#lic="+other.long));
    assert.match(r.out, /Signed in as Tendai Staff/);
    assert.ok(!/eyJ[\w-]+\.[\w-]+\./.test(r.out), "no token in the output");
    assert.ok(!r.out.includes(STAFF_A.pass), "no passcode in the output");
    assert.strictEqual((await sq("select days from cl_licences where serial=$1", [other.serial]))[0].days, 90);
  });
  await t("staff WITHOUT the permission: refused (403), exit code 1", async ()=>{
    const r = await cli(["--device", otherCode], STAFF_B);
    assert.strictEqual(r.code, 1); assert.match(r.out, /Refused \(403\): Not authorized/);
    assert.ok(!r.out.includes(STAFF_B.pass));
  });
  await t("a wrong passcode: sign-in fails, nothing issued", async ()=>{
    const r = await cli(["--device", otherCode], { name:STAFF_A.name, pass:"wrong" });
    assert.strictEqual(r.code, 1); assert.match(r.out, /Sign-in failed/);
  });
  await t("--list shows who issued; --repeat-installs runs", async ()=>{
    const r = await cli(["--list", "--device", "OTHR"], STAFF_A);
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /by Tendai Staff/);
    assert.strictEqual((await cli(["--repeat-installs"], STAFF_A)).code, 0);
  });

  // ---- the app ----
  const browser = await chromium.launch();
  const NOW = Date.now();
  const T0 = NOW - 31*DAY;

  for(const kind of ["phone", "desktop"]){
    const file = writeBuild(kind);
    const d = await device(browser, kind, file);
    const p = d.page;
    let dev = null;
    console.log(kind + " build");
    await t(kind+": set up 31 days ago with a product, then today: the trial has ended and selling is locked", async ()=>{
      await p.clock.setFixedTime(new Date(T0));
      await setup(d, "Licence Test Shop");
      await p.reload(); await signIn(d);                 // this version's first boot is at T0 (old codes close 30 days later)
      await addProduct(d, "Rice 2kg");
      await openAbout(d);
      assert.match(await p.textContent("#licenceLine"), /Free trial until/);
      await shot(d, "01-about-trial");
      await waitFor(async()=> (await sq("select count(*)::int n from cl_vendors where business_name='Licence Test Shop' and device_key is not null"))[0].n >= 1, "the check-in");
      await p.clock.setFixedTime(new Date(NOW));
      await p.reload();
      await p.waitForSelector("#lockReason", { timeout:30000 });
      assert.match(await p.textContent("#lockReason"), /free trial ended on .* Selling is paused/);
      const s = await settingsOf(d);
      dev = { install:s.install_id, key:s.device_key, code:(await p.textContent("#actDeviceCode")).trim() };
      assert.match(dev.code, new RegExp("^"+dev.install+"-[A-HJ-NP-Z2-9]{4}$"));
      assert.match(await p.textContent("#waLock"), /\+263789487287/);
      assert.strictEqual(await p.getAttribute("#callLock", "href"), "tel:+263789487287");
      await shot(d, "02-lock-trial-ended");
    });
    await t(kind+": read-only Reports after expiry (no End of Day, returns or requests; no way to Sell)", async ()=>{
      await p.click("#lockReports");
      await p.waitForSelector("#lockReportsNote");
      assert.match(await p.textContent("#main h2"), /Reports \(read-only\)/);
      assert.strictEqual(await p.$("#eodSection"), null); assert.strictEqual(await p.$("#reportsLogRequestBtn"), null);
      assert.strictEqual(await p.$('[data-route="pos"]'), null);
      await shot(d, "03-reports-read-only");
      await p.click("#lockReportsActivate"); await p.waitForSelector("#actCode");
    });
    await t(kind+": errors in plain words: empty, not a code, old-style code after the cutoff", async ()=>{
      await activate(d, ""); assert.match(await msg(d), /Paste the licence from WhatsApp, or type the code/); await shot(d, "04-err-empty");
      await activate(d, "hello there"); assert.match(await msg(d), /This code isn't valid/); await shot(d, "05-err-invalid");
      await activate(d, "AB12CD"); assert.match(await msg(d), /old-style code, which is no longer accepted.*\+263789487287/); await shot(d, "06-err-old-code");
    });
    await t(kind+": another device's licence (long code), an expired one, one needing a newer app", async ()=>{
      await activate(d, other.long); assert.match(await msg(d), /This licence is for another device \(OTHR…\)\. This device is /); await shot(d, "07-err-other-device");
      await activate(d, craft({ install:dev.install, deviceKey:dev.key, issuedMs:NOW-40*DAY, untilMs:NOW-10*DAY }));
      assert.match(await msg(d), /This licence expired on .* Ask seiGEN for a new one/); await shot(d, "08-err-expired");
      await activate(d, craft({ install:dev.install, deviceKey:dev.key, kid:5, issuedMs:NOW, untilMs:NOW+30*DAY }));
      assert.match(await msg(d), /needs a newer version of the app/); await shot(d, "09-err-unknown-key");
    });
    await t(kind+": short codes: another device's (server: WRONG_DEVICE), offline, too many tries", async ()=>{
      await activate(d, other.short); assert.match(await msg(d), /This licence is for another device/); await shot(d, "10-err-short-wrong-device");
      await d.ctx.setOffline(true);
      await activate(d, "ABCD-EFGH-JK"); assert.match(await msg(d), /You're offline\. A short code needs the internet/); await shot(d, "11-err-offline");
      await d.ctx.setOffline(false);
      for(let i=0;i<4;i++){ await activate(d, "ZZZZ-ZZZZ-Z"+(2+i)); assert.match(await msg(d), /This code isn't valid/); }
      await activate(d, "ZZZZ-ZZZZ-ZZ"); assert.match(await msg(d), /Too many wrong codes/); await shot(d, "12-err-too-many");
      await sq("delete from cl_licence_redeem_failures");
    });
    await t(kind+": the clock moved back: the lock screen explains it", async ()=>{
      await p.clock.setFixedTime(new Date(NOW - 3*DAY)); await p.reload();
      await p.waitForSelector("#lockReason", { timeout:30000 });
      assert.match(await p.textContent("#app"), /date\/time appears to have moved backward/);
      await shot(d, "13-lock-clock-rollback");
      await p.clock.setFixedTime(new Date(NOW)); await p.reload(); await p.waitForSelector("#actCode", { timeout:30000 });
    });
    let first;
    await t(kind+": activate by LONG code (paste the whole WhatsApp message)", async ()=>{
      const r = await cli(["--device", dev.code, "--app", kind==="desktop"? "desktop" : "phone", "--preview"], STAFF_A);
      assert.strictEqual(r.code, 0, r.out); first = parseIssue(r.out);
      if(kind==="desktop") assert.ok(first.link.startsWith("https://desktoppos-preview.seigendc.workers.dev/#lic="));
      await activate(d, r.out.slice(r.out.indexOf("seiGEN licence for device")));
      await p.waitForSelector("#actDone");
      assert.match(await p.textContent("#actDone"), /This device is activated until/);
      assert.match(await p.textContent("#app"), new RegExp("Licence #"+first.serial+" for device "+dev.code));
      await shot(d, "14-activated-long-code");
      await p.click("#actContinue"); await signIn(d);
      await nav(d, "pos"); await p.waitForSelector("#main");      // selling is back
    });
    await t(kind+": More → About: licensed until …, and Enter a new licence", async ()=>{
      await openAbout(d);
      assert.match(await p.textContent("#licenceLine"), new RegExp("Licensed until .* \\(licence #"+first.serial+"\\)"));
      await shot(d, "15-about-licensed");
      await p.click("#licenceRenew"); await p.waitForSelector(".modalOverlay #actCode");
      await shot(d, "16-about-enter-new-licence");
      await p.click("[data-modal-close]");
    });
    await t(kind+": activate by SHORT code (online), then the same licence again is fine, an older one is refused", async ()=>{
      const r = await cli(["--device", dev.code, "--days", "365"], STAFF_A);
      const third = parseIssue(r.out);
      await p.click("#licenceRenew"); await p.waitForSelector(".modalOverlay #actCode");
      await activate(d, third.short.toLowerCase());
      await waitFor(async()=> d.dialogs.some(m=>/Activated until/.test(m)), "the Activated alert", 20000);
      await openAbout(d);
      assert.match(await p.textContent("#licenceLine"), new RegExp("\\(licence #"+third.serial+"\\)"));
      await shot(d, "17-activated-short-code");
      assert.strictEqual((await sq("select status, redeemed_via from cl_licences where serial=$1", [third.serial]))[0].status, "redeemed");
      await p.click("#licenceRenew"); await p.waitForSelector(".modalOverlay #actCode");
      await activate(d, first.long);
      assert.match(await msg(d), /already been used/);
      await shot(d, "18-err-used");
      await p.click("[data-modal-close]");
    });
    await t(kind+": activate by LINK (opened in the app): no server needed, the licence leaves the address bar", async ()=>{
      const r = await cli(["--device", dev.code, "--days", "365", "--note", "link test"], STAFF_A);
      const fourth = parseIssue(r.out);
      d.blockServer = true;                     // Digital Commerce unreachable (sql.js still loads from the CDN, as on a real device's cache)
      const calls = rpcLog.length;
      await p.goto(d.url + "#lic=" + fourth.long);
      await p.waitForSelector("#actDone", { timeout:30000 });
      assert.match(await p.textContent("#app"), new RegExp("Licence #"+fourth.serial));
      assert.strictEqual(await p.evaluate(()=>location.hash), "", "the #lic= part is cleared");
      await shot(d, "19-activated-link");
      await p.goto(d.url + "#lic=" + other.long);
      await p.waitForSelector("#linkErr", { timeout:30000 });
      assert.match(await p.textContent("#linkErr"), /for another device/);
      await shot(d, "20-link-error-other-device");
      assert.strictEqual(rpcLog.length, calls, "no server call while activating by link");
      d.blockServer = false;
    });
    await t(kind+": a link opened where nothing is set up: 'open it in your app', never setup", async ()=>{
      const e = await device(browser, kind, file);
      await e.page.goto(e.url + "#lic=" + other.long);
      await e.page.waitForSelector("#linkCopy", { timeout:30000 });
      assert.match(await e.page.textContent("h2"), /Open this in your seiGEN app/);
      assert.strictEqual(await e.page.$("#setShop"), null);
      await shot(e, "21-link-no-setup");
      assert.deepStrictEqual(e.pageErrors, []);
      await e.ctx.close();
    });
    await t(kind+": no page errors", async ()=>{ assert.deepStrictEqual(d.pageErrors, []); });
    await d.ctx.close();
  }

  console.log("Q13: re-check when the app comes back to the foreground");
  await t("an app left open past the end of its trial locks when it returns to the foreground (no restart)", async ()=>{
    const d = await device(browser, "phone", writeBuild("phone"));
    await d.page.clock.setFixedTime(new Date(NOW - 29.5*DAY));
    await setup(d, "Open All Night");
    await d.page.clock.setFixedTime(new Date(NOW)); await d.page.reload(); await signIn(d);
    await nav(d, "pos");
    await d.page.clock.setFixedTime(new Date(NOW + 1*DAY));
    await d.page.evaluate(()=> document.dispatchEvent(new Event("visibilitychange")));
    await d.page.waitForSelector("#lockReason", { timeout:15000 });
    assert.match(await d.page.textContent("#lockReason"), /free trial ended/);
    assert.deepStrictEqual(d.pageErrors, []);
    await d.ctx.close();
  });
  await t("... and the hourly re-check locks it too (fake timers: a day passes, the hourly timer fires)", async ()=>{
    const d = await device(browser, "phone", writeBuild("phone"));
    await d.page.clock.install({ time: new Date(NOW - 29.5*DAY) });   // the app's timers now run on the test's clock
    await setup(d, "Open All Day");
    await d.page.clock.setSystemTime(new Date(NOW)); await d.page.reload(); await signIn(d);
    await nav(d, "pos");
    assert.strictEqual(await d.page.$("#lockReason"), null, "still in its trial");
    await d.page.clock.fastForward(24*3600000);                        // fires each due timer once, the hourly re-check among them
    await d.page.waitForSelector("#lockReason", { timeout:15000 });
    assert.match(await d.page.textContent("#lockReason"), /free trial ended/);
    assert.deepStrictEqual(d.pageErrors, []);
    await d.ctx.close();
  });

  await browser.close();
  srv.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
