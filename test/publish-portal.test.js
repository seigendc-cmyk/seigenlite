// Run: node --no-warnings test/publish-portal.test.js
// Digital Commerce Publish Portal (tools/publish-portal): the .scl reader,
// the server's API, and the page in a real browser — against a fake
// Supabase (PostgREST + Storage) served over real HTTP, so the portal's own
// fetch() calls run unmodified. The .scl files are made with the app's own
// marketBuildDoc/marketChecksum (src/marketing.js, via test/harness.js), so
// the portal is checked against exactly what the app exports.
"use strict";
const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const { makeApp } = require("./harness");
const { parseScl } = require("../tools/publish-portal/scl");
const { createPortal } = require("../tools/publish-portal/server");
const { createSupabase } = require("../tools/publish-portal/supabase");
const { hashPassword, tokenStatus, todayLocal } = require("../tools/publish-portal/accounts");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

const SERVICE_KEY = "test-service-role-key-" + crypto.randomBytes(8).toString("hex");
const PASS = "correct horse battery staple";
const WEBP = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"; // 1x1 WebP
const INSTALL = "inst-boka-0001";

// ---- .scl files, made by the app's own code ----
const app = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
async function makeScl(o){
  o = o || {};
  const products = o.products || [
    { id:1, name:"Sugar 2kg", price:3.5, stock:12, category:"Groceries" },
    { id:2, name:"Cooking Oil 2L", price:4.25, stock:5, category:"Groceries" },
    { id:3, name:"Candles (6)", price:1, stock:0, category:null },
  ];
  const images = o.images || { 1: WEBP, 2: WEBP };
  const doc = app.api.marketBuildDoc({ products, images, currency:o.currency || "USD",
    vendor:Object.assign({ install_id:INSTALL, business_name:"Boka General Dealer", whatsapp_number:"0771234567", city:"Harare" }, o.vendor || {}),
    exportNo:o.exportNo || 7, createdIso:"2026-09-25T10:00:00", exportedAt:new Date().toISOString() });
  if(o.mutate) o.mutate(doc);
  doc.checksum = await app.api.marketChecksum(doc);
  if(o.afterChecksum) o.afterChecksum(doc);
  return JSON.stringify(doc);
}

// ---- a fake Supabase: just the PostgREST/Storage calls the portal makes ----
function startFakeSupabase(){
  const state = {
    cl_vendors: [{ install_id:INSTALL, business_name:"Boka General Dealer", status:"active", shop_secret_phrase:"SECRET-PHRASE" }],
    vendors: [], vendor_listings: [], objects: new Map(), log: [], failUpload: null, failInsert: null,
    portal_staff: [], vendor_tokens: [],
  };
  const uuid = ()=> crypto.randomUUID();
  function filters(params){
    const f = [];
    for(const [k, v] of params){
      if(["select","order","limit","on_conflict"].includes(k)) continue;
      const m = v.match(/^(eq|neq|gt)\.(.*)$/);
      if(m) f.push(r=> m[1]==="eq"? String(r[k])===m[2] : m[1]==="neq"? String(r[k])!==m[2] : String(r[k]) > m[2]);
      else if(v==="not.is.null") f.push(r=> r[k]!=null);
      else if(v==="is.null") f.push(r=> r[k]==null);
    }
    return (r)=> f.every(fn=> fn(r));
  }
  // The new tables' defaults and checks, as in 20260925150000_publish_portal_staff_tokens.sql.
  function insertRow(table, r){
    const now = new Date().toISOString();
    if(table==="portal_staff"){
      if(state.portal_staff.some(s=> s.username===r.username)) return { error:{ status:409, message:'duplicate key value violates unique constraint "portal_staff_username_key"' } };
      if(!/^scrypt\$/.test(r.password_hash)) return { error:{ status:400, message:"portal_staff_password_hash_format" } };
      return { row: Object.assign({ id:uuid(), must_change_password:false, active:true, failed_attempts:0, locked_until:null, last_login_at:null, created_at:now, created_by:null, updated_at:now }, r) };
    }
    if(table==="vendor_tokens"){
      if(!state.portal_staff.some(s=> s.id===r.recorded_by)) return { error:{ status:409, message:"vendor_tokens_recorded_by_fkey" } };
      const end = new Date(r.starts_on+"T00:00:00Z"); end.setUTCDate(end.getUTCDate() + r.days - 1);
      return { row: Object.assign({ id:uuid(), recorded_at:now, voided_at:null, voided_by:null, void_reason:null }, r, { ends_on:end.toISOString().slice(0,10) }) };
    }
    return { error:{ status:405, message:"not in the fake" } };
  }
  const server = http.createServer((req, res)=>{
    const chunks = [];
    req.on("data", c=> chunks.push(c));
    req.on("end", ()=>{
      const url = new URL(req.url, "http://x");
      const raw = Buffer.concat(chunks);
      state.log.push({ method:req.method, path:url.pathname, query:url.search, headers:req.headers });
      const send = (status, body, type)=>{ res.writeHead(status, { "Content-Type": type || "application/json" }); res.end(Buffer.isBuffer(body)? body : JSON.stringify(body)); };
      if(req.method==="GET" && url.pathname.startsWith("/storage/v1/object/public/listing-images/")){
        const obj = state.objects.get(url.pathname.replace("/storage/v1/object/public/listing-images/",""));
        return obj? send(200, obj, "image/webp") : send(400, { error:"not_found" });
      }
      if(req.headers.apikey!==SERVICE_KEY || req.headers.authorization!=="Bearer "+SERVICE_KEY) return send(401, { message:"bad key" });
      if(req.method==="POST" && url.pathname.startsWith("/storage/v1/object/listing-images/")){
        const p = url.pathname.replace("/storage/v1/object/listing-images/","");
        if(state.failUpload && p.includes(state.failUpload)) return send(500, { message:"storage is down" });
        if(req.headers["content-type"]!=="image/webp") return send(415, { message:"mime not allowed" });
        state.objects.set(p, raw);
        return send(200, { Key:"listing-images/"+p });
      }
      const m = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
      const table = m && state[m[1]];
      if(!table) return send(404, { message:"no such table" });
      const where = filters(url.searchParams);
      const body = raw.length? JSON.parse(raw.toString()) : null;
      if(req.method==="GET"){
        let rows = table.filter(where);
        if(m[1]==="vendor_listings" && /vendors\(/.test(url.searchParams.get("select")||""))
          rows = rows.map(r=> Object.assign({}, r, { vendors: (({ business_name, install_id })=>({ business_name, install_id }))(state.vendors.find(v=> v.id===r.vendor_id) || {}) }));
        if(m[1]==="cl_vendors") rows = rows.map(({ install_id, business_name, status })=>({ install_id, business_name, status })); // the select the portal asks for
        const order = (url.searchParams.get("order")||"").match(/^(\w+)\.(asc|desc)$/);
        if(order) rows = rows.slice().sort((a,b)=> String(a[order[1]]).localeCompare(String(b[order[1]])) * (order[2]==="desc"? -1 : 1));
        if(url.searchParams.get("limit")) rows = rows.slice(0, Number(url.searchParams.get("limit")));
        const sel = url.searchParams.get("select");
        if(sel && sel!=="*" && !/\(/.test(sel) && m[1]!=="cl_vendors"){ const cols = sel.split(","); rows = rows.map(r=> Object.fromEntries(cols.map(c=> [c, r[c]]))); }
        return send(200, rows);
      }
      if(req.method==="POST" && (m[1]==="portal_staff" || m[1]==="vendor_tokens")){
        const out = [];
        for(const r of body){ const x = insertRow(m[1], r); if(x.error) return send(x.error.status, { message:x.error.message }); table.push(x.row); out.push(x.row); }
        return send(201, out);
      }
      if(req.method==="POST" && m[1]==="vendors"){
        const out = body.map(v=>{
          let row = state.vendors.find(x=> x.install_id===v.install_id);
          if(row) Object.assign(row, v); else { row = Object.assign({ id:uuid(), created_at:new Date().toISOString() }, v); state.vendors.push(row); }
          return row;
        });
        return send(201, out);
      }
      if(req.method==="POST" && m[1]==="vendor_listings"){
        const out = [];
        for(const r of body){
          if(state.failInsert && r.product_name===state.failInsert) return send(400, { message:"insert refused" });
          const row = Object.assign({ id:uuid(), created_at:new Date().toISOString() }, r);
          row.expires_at = new Date(Date.parse(row.published_at) + 7*86400000).toISOString(); // the expiry trigger
          state.vendor_listings.push(row); out.push(row);
        }
        return send(201, out);
      }
      if(req.method==="PATCH"){
        const hits = table.filter(where);
        hits.forEach(r=> Object.assign(r, body));
        return send(200, hits);
      }
      send(405, { message:"not in the fake" });
    });
  });
  return new Promise(res=> server.listen(0, "127.0.0.1", ()=> res({ server, state, url:"http://127.0.0.1:"+server.address().port })));
}

// ---- the portal, talking to the fake ----
// Staff seeded straight into the fake (hashes made the portal's own way).
const ADMIN = { username:"tariro", password:"admin password 42", name:"Tariro Admin" };
const REVIEWER = { username:"rudo", password:"reviewer password 7", name:"Rudo Reviewer" };
const TODAY = "2026-09-25";
// o.staff:false -> no staff at all (first-run setup); o.token: false -> the
// test vendor has no token; otherwise it has one covering TODAY.
async function startPortal(o){
  o = o || {};
  const fake = await startFakeSupabase();
  const s = fake.state;
  if(o.staff !== false){
    for(const [who, role] of [[ADMIN, "admin"], [REVIEWER, "reviewer"]])
      s.portal_staff.push({ id:crypto.randomUUID(), username:who.username, display_name:who.name, role, password_hash:hashPassword(who.password),
        must_change_password:false, active:true, failed_attempts:0, locked_until:null, last_login_at:null, created_at:new Date(Date.now() - (role==="admin"? 2 : 1)*1000).toISOString(), updated_at:new Date().toISOString() });
    if(o.token !== false) s.vendor_tokens.push({ id:crypto.randomUUID(), install_id:INSTALL, business_name:"Boka General Dealer", starts_on:"2026-09-10", days:30, ends_on:"2026-10-09",
      amount:10, currency:"USD", payment_method:"EcoCash", reference:null, notes:null, recorded_by:s.portal_staff[0].id, recorded_at:new Date().toISOString(), voided_at:null, voided_by:null, void_reason:null });
  }
  let now = new Date(TODAY + "T10:00:00Z");
  const { server } = createPortal({ supabaseUrl:fake.url, serviceKey:SERVICE_KEY, setupPassphrase:PASS, log:()=>{}, clock:()=> new Date(now) });
  await new Promise(r=> server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:"+server.address().port;
  const seen = [];   // every response the portal gave, to check the key never leaks
  let cookie = "";
  async function call(path, o){
    o = o || {};
    const res = await fetch(base+path, { method:o.method||"GET",
      headers:Object.assign({ "X-Portal":"1" }, cookie? { Cookie:cookie } : {}, o.headers||{}), body:o.body });
    const buf = Buffer.from(await res.arrayBuffer());
    seen.push(JSON.stringify([...res.headers]) + buf.toString("latin1"));
    const sc = res.headers.get("set-cookie"); if(sc && !o.keepCookie) cookie = sc.split(";")[0];
    let json = null; try{ json = JSON.parse(buf.toString()); }catch(e){}
    return { status:res.status, json, buf, headers:res.headers };
  }
  const login = (who, password)=> call("/api/login", { method:"POST", body:JSON.stringify({ username:(who||ADMIN).username, password:password || (who||ADMIN).password }) });
  const upload = (text)=> call("/api/batches", { method:"POST", body:text });
  const publish = (id, include)=> call(`/api/batches/${id}/publish`, { method:"POST", body:JSON.stringify({ include }) });
  const post = (path, body)=> call(path, { method:"POST", body:JSON.stringify(body||{}) });
  const staffRow = (username)=> fake.state.portal_staff.find(x=> x.username===username);
  const close = ()=>{ server.close(); fake.server.close(); };
  return { fake, base, call, login, upload, publish, post, staffRow, close, seen,
    get cookie(){ return cookie; }, set cookie(v){ cookie = v; }, advance(ms){ now = new Date(now.getTime() + ms); }, setNow(iso){ now = new Date(iso); } };
}
// Writes to listings, vendors, tokens or photos (a sign-in's own portal_staff update isn't one).
const writes = (fake)=> fake.state.log.filter(r=> r.method!=="GET" && r.path!=="/rest/v1/portal_staff");

(async()=>{
  // ================= .scl reader =================
  await t("a file the app exported parses: vendor, every product, photos decoded as WebP, checksum good", async ()=>{
    const p = parseScl(await makeScl());
    assert.strictEqual(p.ok, true, JSON.stringify(p.fileProblems.concat(p.vendorProblems)));
    assert.deepStrictEqual(p.vendor, { install_id:INSTALL, business_name:"Boka General Dealer", whatsapp_number:"0771234567", city:"Harare" });
    assert.deepStrictEqual(p.items.map(i=> [i.row.product_name, i.row.price, i.row.stock_quantity, i.row.currency, !!i.image]),
      [["Sugar 2kg",3.5,12,"USD",true], ["Cooking Oil 2L",4.25,5,"USD",true], ["Candles (6)",1,0,"USD",false]]);
    assert.strictEqual(p.items[0].image.toString("ascii",8,12), "WEBP");
    assert.deepStrictEqual(p.items[2].notes, ["out of stock", "no photo"]);
    assert.strictEqual(p.exportNo, "MKT0007");
  });

  await t("a file changed after export (price edited) fails its checksum and can't be published", async ()=>{
    const p = parseScl(await makeScl({ afterChecksum: d=>{ d.listings[0].price = 0.01; } }));
    assert.strictEqual(p.ok, false);
    assert.match(p.fileProblems[0], /checksum doesn't match/);
  });

  await t("not an .scl file, the wrong version, or no products: refused with a plain reason", async ()=>{
    assert.match(parseScl("{not json").fileProblems[0], /isn't readable JSON/);
    assert.match(parseScl(JSON.stringify({ format:"seigen.dn" })).fileProblems[0], /isn't a marketing export/);
    assert.match(parseScl(JSON.stringify({ format:"seigen.market_export", format_version:2 })).fileProblems[0], /format version 2/);
    assert.ok(parseScl(await makeScl({ products:[], images:{} })).fileProblems.some(x=> /no products/.test(x)));
  });

  await t("per-product problems block only that product; a bad photo is a note (published without it)", async ()=>{
    const text = await makeScl({ mutate: d=>{
      d.listings.push(Object.assign({}, d.listings[0]));                         // same product id again
      d.listings[1].price = -1;
      d.listings[2].currency = "US";
      d.listings[0].image_webp = "data:image/webp;base64,SGVsbG8gd29ybGQ=";       // base64, but not a WebP
    }});
    const p = parseScl(text);
    assert.strictEqual(p.ok, true, "the file itself is fine");
    assert.deepStrictEqual(p.items.map(i=> i.problems.length > 0), [false, true, true, true]);
    assert.match(p.items[1].problems.join(), /price is missing or negative/);
    assert.match(p.items[2].problems.join(), /currency/);
    assert.match(p.items[3].problems.join(), /same product ID/);
    assert.strictEqual(p.items[0].image, null);
    assert.match(p.items[0].notes.join(), /isn't a WebP file — it would be published without a photo/);
  });

  // ================= server: access =================
  // ---- first run ----
  await t("first run: no staff -> setup, which needs PORTAL_PASSPHRASE, creates one Admin (hashed), signs in, and then closes", async ()=>{
    const P = await startPortal({ staff:false });
    try{
      const s = (await P.call("/api/session")).json;
      assert.deepStrictEqual([s.signedIn, s.setupNeeded, s.setupAvailable], [false, true, true]);
      assert.strictEqual((await P.upload(await makeScl())).status, 401, "nothing works before setup");
      assert.strictEqual((await P.post("/api/setup", { setupPassphrase:"not it", username:"tariro", displayName:"Tariro", password:"a good long password" })).status, 401);
      assert.match((await P.post("/api/setup", { setupPassphrase:PASS, username:"Ta Riro", displayName:"Tariro", password:"a good long password" })).json.error, /Usernames are/);
      assert.match((await P.post("/api/setup", { setupPassphrase:PASS, username:"tariro", displayName:"Tariro", password:"short" })).json.error, /at least 10/);
      const r = await P.post("/api/setup", { setupPassphrase:PASS, username:"Tariro", displayName:"Tariro M", password:"a good long password" });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual([r.json.me.username, r.json.me.role, r.json.me.mustChangePassword], ["tariro", "admin", false]);
      const row = P.staffRow("tariro");
      assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$/);
      assert.ok(!row.password_hash.includes("a good long password"));
      assert.strictEqual((await P.call("/api/session")).json.me.role, "admin", "signed in by setup");
      assert.strictEqual((await P.post("/api/setup", { setupPassphrase:PASS, username:"other", displayName:"X", password:"another long password" })).status, 409, "setup closes once an account exists");
      P.cookie = "";
      assert.strictEqual((await P.call("/api/session")).json.setupNeeded, false);
      assert.strictEqual((await P.login({ username:"tariro", password:"a good long password" })).status, 200);
    } finally { P.close(); }
  });

  // ---- sign-in + lockout ----
  await t("sign-in is per person: username (any case) + password; wrong or unknown gets the same answer; nothing works signed out", async ()=>{
    const P = await startPortal();
    try{
      assert.strictEqual((await P.upload(await makeScl())).status, 401);
      assert.strictEqual((await P.call("/api/history")).status, 401);
      assert.strictEqual((await P.call("/api/vendors")).status, 401);
      const wrong = await P.login(ADMIN, "not the password");
      const unknown = await P.login({ username:"nobody", password:"whatever at all" });
      assert.deepStrictEqual([wrong.status, wrong.json.error], [401, "Wrong username or password."]);
      assert.deepStrictEqual([unknown.status, unknown.json.error], [401, "Wrong username or password."]);
      const ok = await P.login({ username:"  TARIRO ", password:ADMIN.password });
      assert.strictEqual(ok.status, 200);
      assert.deepStrictEqual(ok.json.me, { id:P.staffRow("tariro").id, username:"tariro", name:"Tariro Admin", role:"admin", mustChangePassword:false });
      assert.strictEqual(P.staffRow("tariro").failed_attempts, 0, "a good sign-in clears the count");
      assert.ok(P.staffRow("tariro").last_login_at);
    } finally { P.close(); }
  });

  await t("5 wrong passwords lock the account for 15 minutes — even the right password is refused — then it works again", async ()=>{
    const P = await startPortal();
    try{
      for(let i=1; i<=4; i++){ assert.strictEqual((await P.login(REVIEWER, "wrong password " + i)).status, 401); assert.strictEqual(P.staffRow("rudo").failed_attempts, i); }
      const fifth = await P.login(REVIEWER, "wrong password 5");
      assert.strictEqual(fifth.status, 423);
      assert.match(fifth.json.error, /locked until 12:15/, "10:00 UTC is 12:00 in Harare; +15 minutes");
      assert.strictEqual(Date.parse(P.staffRow("rudo").locked_until) - Date.parse(TODAY+"T10:00:00Z"), 15*60000);
      const right = await P.login(REVIEWER);
      assert.strictEqual(right.status, 423, "locked means locked");
      assert.match(right.json.error, /locked after 5 wrong passwords\. Try again after 12:15, or ask an Admin to unlock it/);
      assert.strictEqual((await P.login(ADMIN)).status, 200, "other accounts are unaffected");
      P.advance(14*60000);
      P.cookie = "";
      assert.strictEqual((await P.login(REVIEWER)).status, 423, "still locked at 14 minutes");
      P.advance(61000);
      assert.strictEqual((await P.login(REVIEWER)).status, 200, "open again after 15 minutes");
      assert.strictEqual(P.staffRow("rudo").locked_until, null);
    } finally { P.close(); }
  });

  await t("the lock survives a portal restart (it's stored on the account), and an Admin can unlock early", async ()=>{
    const P = await startPortal();
    try{
      for(let i=0; i<5; i++) await P.login(REVIEWER, "wrong " + i + " password");
      // A second portal on the same database: a restart.
      const { server } = createPortal({ supabaseUrl:P.fake.url, serviceKey:SERVICE_KEY, setupPassphrase:PASS, log:()=>{}, clock:()=> new Date(TODAY+"T10:01:00Z") });
      await new Promise(r=> server.listen(0, "127.0.0.1", r));
      const r2 = await fetch("http://127.0.0.1:"+server.address().port+"/api/login", { method:"POST", headers:{ "X-Portal":"1" }, body:JSON.stringify({ username:REVIEWER.username, password:REVIEWER.password }) });
      server.close();
      assert.strictEqual(r2.status, 423);
      await P.login(ADMIN);
      const staff = (await P.call("/api/staff")).json.staff;
      assert.strictEqual(staff.find(x=> x.username==="rudo").locked, true);
      assert.strictEqual((await P.post(`/api/staff/${P.staffRow("rudo").id}`, { action:"unlock" })).status, 200);
      P.cookie = "";
      assert.strictEqual((await P.login(REVIEWER)).status, 200);
    } finally { P.close(); }
  });

  await t("many wrong sign-ins across accounts pause sign-in for everyone (spraying guesses at many names)", async ()=>{
    const P = await startPortal();
    try{
      for(let i=0; i<20; i++) await P.login({ username:"guess"+i, password:"password guess " + i });
      assert.strictEqual((await P.login(ADMIN)).status, 429);
      assert.strictEqual(P.staffRow("tariro").failed_attempts, 0, "unknown names don't count against a real account");
    } finally { P.close(); }
  });

  // ---- roles ----
  await t("a Reviewer can upload, publish, unpublish, see history and tokens — but not record/void tokens or manage staff", async ()=>{
    const P = await startPortal();
    try{
      await P.login(REVIEWER);
      const b = (await P.upload(await makeScl())).json;
      assert.strictEqual(b.canPublish, true);
      assert.strictEqual((await P.publish(b.id, [0])).status, 200);
      const h = (await P.call("/api/history")).json.groups;
      assert.strictEqual((await P.post(`/api/listings/${h[0].listings[0].id}/unpublish`)).status, 200);
      const v = (await P.call("/api/vendors")).json.vendors;
      assert.strictEqual(v[0].token.state, "active", "can see token status");
      const rec = await P.post(`/api/vendors/${INSTALL}/tokens`, { startsOn:TODAY, days:30 });
      assert.deepStrictEqual([rec.status, rec.json.error], [403, "Only an Admin can record token purchases."]);
      assert.strictEqual((await P.post(`/api/tokens/${P.fake.state.vendor_tokens[0].id}/void`, { reason:"x" })).status, 403);
      assert.strictEqual((await P.call("/api/staff")).status, 403);
      assert.strictEqual((await P.post("/api/staff", { username:"sneaky", displayName:"S", role:"admin", password:"sneaky password 1" })).status, 403);
      assert.strictEqual((await P.post(`/api/staff/${P.staffRow("rudo").id}`, { action:"role", role:"admin" })).status, 403, "can't promote themselves");
      assert.strictEqual(P.fake.state.vendor_tokens.length, 1);
      assert.strictEqual(P.fake.state.portal_staff.length, 2);
    } finally { P.close(); }
  });

  await t("role changes and deactivation take effect on the very next request", async ()=>{
    const P = await startPortal();
    try{
      await P.login(REVIEWER);
      const reviewerCookie = P.cookie;
      P.staffRow("rudo").role = "admin";                 // (as if another Admin promoted them)
      assert.strictEqual((await P.call("/api/staff")).status, 200);
      P.staffRow("rudo").role = "reviewer";
      assert.strictEqual((await P.call("/api/staff")).status, 403);
      P.cookie = "";
      await P.login(ADMIN);
      assert.strictEqual((await P.post(`/api/staff/${P.staffRow("rudo").id}`, { action:"deactivate" })).status, 200);
      P.cookie = reviewerCookie;
      assert.strictEqual((await P.call("/api/history")).status, 401, "signed out at once");
      assert.strictEqual((await P.login(REVIEWER)).status, 401, "can't sign in while deactivated");
    } finally { P.close(); }
  });

  // ---- staff accounts ----
  await t("an Admin adds staff with a temporary password; they must choose their own before doing anything", async ()=>{
    const P = await startPortal();
    try{
      await P.login(ADMIN);
      assert.match((await P.post("/api/staff", { username:"rudo", displayName:"Dup", role:"reviewer", password:"temporary pass 1" })).json.error, /already taken/);
      assert.match((await P.post("/api/staff", { username:"chipo", displayName:"Chipo", role:"owner", password:"temporary pass 1" })).json.error, /Admin or Reviewer/);
      const add = await P.post("/api/staff", { username:"Chipo", displayName:"Chipo Moyo", role:"reviewer", password:"temporary pass 1" });
      assert.strictEqual(add.status, 200, JSON.stringify(add.json));
      assert.deepStrictEqual([add.json.staff.username, add.json.staff.role, add.json.staff.mustChangePassword], ["chipo", "reviewer", true]);
      assert.strictEqual(P.staffRow("chipo").created_by, P.staffRow("tariro").id);
      P.cookie = "";
      const li = await P.login({ username:"chipo", password:"temporary pass 1" });
      assert.strictEqual(li.json.me.mustChangePassword, true);
      const blocked = await P.upload(await makeScl());
      assert.deepStrictEqual([blocked.status, blocked.json.mustChangePassword], [403, true]);
      assert.match((await P.post("/api/password", { current:"wrong one here", next:"chipo own password" })).json.error, /current password isn't right/);
      assert.match((await P.post("/api/password", { current:"temporary pass 1", next:"temporary pass 1" })).json.error, /different/);
      assert.match((await P.post("/api/password", { current:"temporary pass 1", next:"chipo123456789" })).json.error, /username/);
      const ch = await P.post("/api/password", { current:"temporary pass 1", next:"a password of my own" });
      assert.strictEqual(ch.json.me.mustChangePassword, false);
      assert.strictEqual((await P.upload(await makeScl())).status, 200, "works once changed, same session");
      P.cookie = "";
      assert.strictEqual((await P.login({ username:"chipo", password:"temporary pass 1" })).status, 401, "temporary password no longer works");
      assert.strictEqual((await P.login({ username:"chipo", password:"a password of my own" })).status, 200);
    } finally { P.close(); }
  });

  await t("there's always an active Admin: no demoting or deactivating the last one, or yourself; resets sign the person out", async ()=>{
    const P = await startPortal();
    try{
      await P.login(REVIEWER); const reviewerCookie = P.cookie; P.cookie = "";
      await P.login(ADMIN);
      const me = P.staffRow("tariro").id, rudo = P.staffRow("rudo").id;
      assert.match((await P.post(`/api/staff/${me}`, { action:"role", role:"reviewer" })).json.error, /your own role/);
      assert.match((await P.post(`/api/staff/${me}`, { action:"deactivate" })).json.error, /your own account/);
      assert.strictEqual((await P.post(`/api/staff/${rudo}`, { action:"role", role:"admin" })).json.staff.role, "admin");
      assert.strictEqual((await P.post(`/api/staff/${rudo}`, { action:"role", role:"reviewer" })).json.staff.role, "reviewer");
      assert.deepStrictEqual((await P.call("/api/staff")).json.staff.filter(s=> s.role==="admin" && s.active).map(s=> s.username), ["tariro"], "still exactly one Admin");
      assert.match((await P.post(`/api/staff/${rudo}`, { action:"reset-password", password:"short" })).json.error, /at least 10/);
      const reset = await P.post(`/api/staff/${rudo}`, { action:"reset-password", password:"fresh temporary 9" });
      assert.strictEqual(reset.json.staff.mustChangePassword, true);
      P.cookie = reviewerCookie;
      assert.strictEqual((await P.call("/api/history")).status, 401, "a reset signs them out everywhere");
      assert.strictEqual((await P.login(REVIEWER)).status, 401, "old password gone");
      assert.strictEqual((await P.login({ username:"rudo", password:"fresh temporary 9" })).json.me.mustChangePassword, true);
    } finally { P.close(); }
  });

  // ---- tokens ----
  await t("token status: active until (renewals chain), expired on, starts later, none — in Harare dates", ()=>{
    const tk = (s, d)=> ({ starts_on:s, days:d, ends_on:new Date(Date.parse(s+"T00:00:00Z") + (d-1)*86400000).toISOString().slice(0,10) });
    assert.deepStrictEqual(tokenStatus([], TODAY), { state:"none" });
    assert.deepStrictEqual(tokenStatus([tk("2026-09-10", 30)], TODAY), { state:"active", until:"2026-10-09" });
    assert.deepStrictEqual(tokenStatus([tk("2026-09-10", 30), tk("2026-10-10", 30)], TODAY), { state:"active", until:"2026-11-08" }, "a renewal bought early extends it");
    assert.deepStrictEqual(tokenStatus([tk("2026-09-10", 30), tk("2026-10-20", 30)], TODAY), { state:"active", until:"2026-10-09" }, "a gap doesn't");
    assert.deepStrictEqual(tokenStatus([tk("2026-08-01", 30)], TODAY), { state:"expired", expiredOn:"2026-08-30" });
    assert.deepStrictEqual(tokenStatus([tk("2026-10-01", 30)], TODAY), { state:"future", startsOn:"2026-10-01", expiredOn:null });
    assert.deepStrictEqual(tokenStatus([Object.assign(tk("2026-09-10", 30), { voided_at:"x" })], TODAY), { state:"none" }, "voided tokens don't count");
    assert.deepStrictEqual(tokenStatus([tk("2026-09-25", 1)], TODAY), { state:"active", until:TODAY }, "a 1-day token covers its day");
    assert.strictEqual(todayLocal(new Date("2026-09-25T22:30:00Z")), "2026-09-26", "after 22:00 UTC it's tomorrow in Harare");
  });

  await t("no token: preview says so and Publish is refused with the reason; nothing written", async ()=>{
    const P = await startPortal({ token:false });
    try{
      await P.login(ADMIN);
      const b = (await P.upload(await makeScl())).json;
      assert.ok(b.registeredDevice, "the device is registered — the token is the only thing missing");
      assert.strictEqual(b.canPublish, false);
      assert.deepStrictEqual([b.token.state, b.token.message], ["none", "No active token — none has been recorded for this vendor. Record one to continue."]);
      assert.strictEqual(b.token.defaultStart, TODAY);
      const r = await P.publish(b.id, [0,1,2]);
      assert.strictEqual(r.status, 409);
      assert.match(r.json.error, /^No active token — none has been recorded.*Nothing was published\.$/);
      assert.strictEqual(writes(P.fake).length, 0);
    } finally { P.close(); }
  });

  await t("expired token: 'expired on [date]'; an Admin records a new one and the same upload can then publish", async ()=>{
    const P = await startPortal({ token:false });
    try{
      await P.login(ADMIN);
      const admin = P.staffRow("tariro").id;
      P.fake.state.vendor_tokens.push({ id:crypto.randomUUID(), install_id:INSTALL, starts_on:"2026-08-01", days:30, ends_on:"2026-08-30", recorded_by:admin, voided_at:null });
      const b = (await P.upload(await makeScl())).json;
      assert.strictEqual(b.token.message, "No active token — expired on 30 Aug 2026. Record a new one to continue.");
      // Bad entries are refused with a reason.
      for(const [body, re] of [[{ startsOn:"2026-13-01", days:30 }, /date the token starts/], [{ startsOn:TODAY, days:0 }, /1 to 366/],
        [{ startsOn:TODAY, days:30, amount:-1, currency:"USD" }, /0 or more/], [{ startsOn:TODAY, days:30, amount:5 }, /currency/], [{ startsOn:TODAY, days:30, amount:5, currency:"us$" }, /3-letter/]])
        assert.match((await P.post(`/api/vendors/${INSTALL}/tokens`, body)).json.error, re);
      assert.strictEqual((await P.post(`/api/vendors/inst-unknown/tokens`, { startsOn:TODAY, days:30 })).status, 404, "only registered devices");
      const rec = await P.post(`/api/vendors/${INSTALL}/tokens`, { startsOn:TODAY, days:30, amount:"10", currency:"USD", paymentMethod:"EcoCash", reference:"MP260925.1234", notes:"" });
      assert.strictEqual(rec.status, 200, JSON.stringify(rec.json));
      assert.deepStrictEqual([rec.json.token.state, rec.json.token.until], ["active", "2026-10-24"]);
      const saved = P.fake.state.vendor_tokens.at(-1);
      assert.deepStrictEqual([saved.install_id, saved.business_name, saved.starts_on, saved.days, saved.amount, saved.currency, saved.payment_method, saved.reference, saved.notes, saved.recorded_by],
        [INSTALL, "Boka General Dealer", TODAY, 30, 10, "USD", "EcoCash", "MP260925.1234", null, admin]);
      const again = (await P.call(`/api/batches/${b.id}`)).json;
      assert.strictEqual(again.canPublish, true, "re-checked without uploading again");
      assert.strictEqual((await P.publish(b.id, [0])).status, 200);
    } finally { P.close(); }
  });

  await t("a token voided between preview and Publish stops the publish (checked again at publish time)", async ()=>{
    const P = await startPortal();
    try{
      await P.login(ADMIN);
      const b = (await P.upload(await makeScl())).json;
      assert.strictEqual(b.canPublish, true);
      const tok = P.fake.state.vendor_tokens[0];
      assert.match((await P.post(`/api/tokens/${tok.id}/void`, { reason:"  " })).json.error, /why/);
      assert.strictEqual((await P.post(`/api/tokens/${tok.id}/void`, { reason:"recorded against the wrong vendor" })).status, 200);
      assert.deepStrictEqual([!!tok.voided_at, tok.voided_by, tok.void_reason], [true, P.staffRow("tariro").id, "recorded against the wrong vendor"]);
      assert.strictEqual((await P.post(`/api/tokens/${tok.id}/void`, { reason:"again" })).status, 409, "already voided");
      const r = await P.publish(b.id, [0]);
      assert.strictEqual(r.status, 409);
      assert.match(r.json.error, /No active token/);
      assert.strictEqual(P.fake.state.vendor_listings.length, 0);
    } finally { P.close(); }
  });

  await t("vendors list: every registered device with token status, history newest first, who recorded it, and where a renewal starts", async ()=>{
    const P = await startPortal();
    try{
      await P.login(ADMIN);
      await P.post(`/api/vendors/${INSTALL}/tokens`, { startsOn:"2026-10-10", days:30, amount:10, currency:"USD", paymentMethod:"Cash" });
      const v = (await P.call("/api/vendors")).json;
      assert.strictEqual(v.today, TODAY);
      const boka = v.vendors.find(x=> x.installId===INSTALL);
      assert.deepStrictEqual([boka.businessName, boka.token.state, boka.token.until], ["Boka General Dealer", "active", "2026-11-08"]);
      assert.strictEqual(boka.defaultStart, "2026-11-09", "the next purchase starts after the current run");
      assert.deepStrictEqual(boka.tokens.map(x=> [x.startsOn, x.endsOn, x.recordedBy]), [["2026-10-10","2026-11-08","Tariro Admin"], ["2026-09-10","2026-10-09","Tariro Admin"]]);
      assert.ok(!JSON.stringify(v).includes("SECRET-PHRASE"));
    } finally { P.close(); }
  });

  await t("history shows each vendor's token status next to their listings", async ()=>{
    const P = await startPortal();
    try{
      await P.login(ADMIN);
      const b = (await P.upload(await makeScl())).json;
      await P.publish(b.id, [0]);
      const g = (await P.call("/api/history")).json.groups[0];
      assert.deepStrictEqual([g.token.state, g.token.until], ["active", "2026-10-09"]);
      P.setNow("2026-10-12T10:00:00Z");
      const g2 = (await P.call("/api/history")).json.groups[0];
      assert.deepStrictEqual([g2.token.state, g2.token.expiredOn], ["expired", "2026-10-09"]);
    } finally { P.close(); }
  });

  await t("no password hash ever leaves the portal", async ()=>{
    const P = await startPortal();
    try{
      await P.login(ADMIN);
      await P.call("/api/staff"); await P.call("/api/session"); await P.call("/api/vendors");
      await P.post("/api/staff", { username:"chipo", displayName:"C", role:"reviewer", password:"temporary pass 1" });
      assert.ok(P.seen.every(s=> !/scrypt\$/.test(s)), "a hash was sent to the browser");
    } finally { P.close(); }
  });

  await t("sign-in sets an HttpOnly SameSite=Strict cookie; writes need the X-Portal header; other Host names are refused", async ()=>{
    const P = await startPortal();
    try{
      const r = await P.login();
      assert.strictEqual(r.status, 200);
      assert.match(r.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Path=\//);
      assert.strictEqual((await P.call("/api/session")).json.signedIn, true);
      const noHeader = await fetch(P.base+"/api/batches", { method:"POST", headers:{ Cookie:P.cookie }, body:await makeScl() });
      assert.strictEqual(noHeader.status, 403);
      const rebinding = await new Promise(res=> http.get(P.base+"/api/session", { headers:{ Host:"evil.example" } }, r=> res(r.statusCode)));
      assert.strictEqual(rebinding, 421);
      assert.throws(()=> createPortal({ supabaseUrl:"http://x", serviceKey:"k", passphrase:"short" }), /at least 12/);
    } finally { P.close(); }
  });

  // ================= upload / preview =================
  await t("upload previews the file (vendor, registered device, products, photos) and writes nothing to Supabase", async ()=>{
    const P = await startPortal();
    try{
      await P.login();
      const r = await P.upload(await makeScl());
      assert.strictEqual(r.status, 200);
      const b = r.json;
      assert.strictEqual(b.canPublish, true);
      assert.deepStrictEqual(b.registeredDevice, { install_id:INSTALL, business_name:"Boka General Dealer", status:"active" });
      assert.strictEqual(JSON.stringify(b).includes("SECRET-PHRASE"), false, "cl_vendors secret never selected");
      assert.strictEqual(b.existingVendor, null);
      assert.deepStrictEqual(b.items.map(i=> [i.name, i.hasImage, i.alreadyLive]), [["Sugar 2kg",true,false], ["Cooking Oil 2L",true,false], ["Candles (6)",false,false]]);
      const img = await P.call(`/api/batches/${b.id}/images/0`);
      assert.strictEqual(img.status, 200);
      assert.strictEqual(img.headers.get("content-type"), "image/webp");
      assert.strictEqual(img.buf.toString("ascii",8,12), "WEBP");
      assert.strictEqual((await P.call(`/api/batches/${b.id}/images/2`)).status, 404, "no photo for Candles");
      assert.strictEqual(writes(P.fake).length, 0, "preview never writes");
    } finally { P.close(); }
  });

  await t("an install ID with no registered device blocks publishing — no orphan vendor is created", async ()=>{
    const P = await startPortal();
    try{
      await P.login();
      const b = (await P.upload(await makeScl({ vendor:{ install_id:"inst-unknown-9999" } }))).json;
      assert.strictEqual(b.registeredDevice, null);
      assert.strictEqual(b.canPublish, false);
      const r = await P.publish(b.id, [0,1,2]);
      assert.strictEqual(r.status, 409);
      assert.match(r.json.error, /doesn't match any registered device/);
      assert.strictEqual(writes(P.fake).length, 0);
      assert.strictEqual(P.fake.state.vendors.length, 0);
    } finally { P.close(); }
  });

  // ================= publish =================
  await t("publish: vendor upserted, ticked products only, photos to listing-images, rows published with the photo link", async ()=>{
    const P = await startPortal();
    try{
      await P.login();
      const b = (await P.upload(await makeScl())).json;
      const r = await P.publish(b.id, [0, 2]);   // Cooking Oil left out
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const s = P.fake.state;
      assert.deepStrictEqual(s.vendors.map(v=> [v.install_id, v.business_name, v.whatsapp_number, v.city]), [[INSTALL, "Boka General Dealer", "0771234567", "Harare"]]);
      assert.deepStrictEqual(s.vendor_listings.map(l=> l.product_name), ["Sugar 2kg", "Candles (6)"]);
      const sugar = s.vendor_listings[0], candles = s.vendor_listings[1];
      assert.strictEqual(sugar.status, "published");
      assert.strictEqual(sugar.vendor_id, s.vendors[0].id);
      assert.strictEqual(sugar.source_product_id, "1");
      assert.strictEqual(sugar.published_at, candles.published_at, "one publish moment per batch");
      assert.match(sugar.image_url, new RegExp("^"+P.fake.url.replace(/\./g,"\\.")+"/storage/v1/object/public/listing-images/inst-boka-0001/1-[0-9a-f]{16}\\.webp$"));
      assert.strictEqual(candles.image_url, null);
      assert.strictEqual(s.objects.size, 1, "only Sugar had a photo to upload");
      const photo = await fetch(sugar.image_url);
      assert.strictEqual((Buffer.from(await photo.arrayBuffer())).toString("ascii",8,12), "WEBP");
      assert.deepStrictEqual(r.json.results.map(x=> [x.name, x.ok]), [["Sugar 2kg",true], ["Candles (6)",true]]);
      assert.ok(!Object.keys(sugar).some(k=> ["image_webp"].includes(k)), "no photo data in the table");
    } finally { P.close(); }
  });

  await t("one product failing doesn't stop the others; each gets its own result", async ()=>{
    const P = await startPortal();
    try{
      await P.login();
      const b = (await P.upload(await makeScl())).json;
      P.fake.state.failUpload = "/2-";              // Cooking Oil's photo upload fails
      P.fake.state.failInsert = "Candles (6)";       // Candles' row is refused
      const r = await P.publish(b.id, [0,1,2]);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.results.map(x=> [x.name, x.ok, x.step || null]),
        [["Sugar 2kg",true,null], ["Cooking Oil 2L",false,"photo"], ["Candles (6)",false,"listing"]]);
      assert.match(r.json.results[1].error, /storage is down/);
      assert.deepStrictEqual(P.fake.state.vendor_listings.map(l=> l.product_name), ["Sugar 2kg"]);
    } finally { P.close(); }
  });

  await t("publishing a product again replaces its live listing instead of showing it twice", async ()=>{
    const P = await startPortal();
    try{
      await P.login();
      const first = (await P.upload(await makeScl())).json;
      await P.publish(first.id, [0,1,2]);
      const again = (await P.upload(await makeScl({ exportNo:8 }))).json;
      assert.ok(again.existingVendor, "vendor now known");
      assert.deepStrictEqual(again.items.map(i=> i.alreadyLive), [true, true, true]);
      const r = await P.publish(again.id, [0]);
      assert.strictEqual(r.json.results[0].superseded, 1);
      const sugars = P.fake.state.vendor_listings.filter(l=> l.product_name==="Sugar 2kg");
      assert.deepStrictEqual(sugars.map(l=> l.status), ["expired", "published"]);
      assert.strictEqual(P.fake.state.vendors.length, 1, "vendor upserted, not duplicated");
    } finally { P.close(); }
  });

  // ================= history / unpublish =================
  await t("history lists each publish (vendor, date, count, live); unpublish takes one listing down", async ()=>{
    const P = await startPortal();
    try{
      await P.login();
      const b = (await P.upload(await makeScl())).json;
      await P.publish(b.id, [0,1]);
      let h = (await P.call("/api/history")).json.groups;
      assert.strictEqual(h.length, 1);
      assert.deepStrictEqual([h[0].vendor, h[0].count, h[0].live], ["Boka General Dealer", 2, 2]);
      const oil = h[0].listings.find(l=> l.name==="Cooking Oil 2L");
      const r = await P.call(`/api/listings/${oil.id}/unpublish`, { method:"POST", body:"{}" });
      assert.deepStrictEqual(r.json, { ok:true, id:oil.id, status:"pending_review" });
      h = (await P.call("/api/history")).json.groups;
      assert.strictEqual(h[0].live, 1);
      assert.strictEqual(h[0].listings.find(l=> l.id===oil.id).status, "pending_review");
      assert.strictEqual((await P.call(`/api/listings/${oil.id}/unpublish`, { method:"POST", body:"{}" })).status, 409, "already unpublished");
    } finally { P.close(); }
  });

  await t("the service_role key never appears in anything the portal sends back", async ()=>{
    const P = await startPortal();
    try{
      await P.login();
      const b = (await P.upload(await makeScl())).json;
      P.fake.state.failInsert = "Sugar 2kg";
      await P.publish(b.id, [0,1,2]);
      await P.call("/api/history");
      await P.call("/");
      await P.call("/app.js");
      assert.ok(P.seen.length >= 6);
      assert.ok(P.seen.every(s=> !s.includes(SERVICE_KEY)), "key found in a response");
      assert.ok(P.fake.state.log.filter(r=> r.method!=="GET" || r.path.startsWith("/rest")).every(r=> r.headers.apikey===SERVICE_KEY), "every Supabase call is server-side with the key");
    } finally { P.close(); }
  });

  // ================= the page, in a real browser =================
  let chromium = null;
  try{ ({ chromium } = require("playwright")); }catch(e){ console.log("  (Playwright not installed — skipping the browser test)"); }
  const fs = require("fs"), os = require("os"), path = require("path");
  async function browserPage(browser, P, o){
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", e=> errors.push(e.message));
    page.on("console", m=> { if(m.type()==="error") errors.push(m.text()); });
    page.on("dialog", d=> (o && o.onDialog) ? o.onDialog(d) : d.accept());
    await page.goto(P.base + "/");
    // The browser logs every refused request; the tests cause those on purpose.
    return { page, errors: ()=> errors.filter(e=> !/status of (400|401|403|423)/.test(e)) };
  }
  async function signIn(page, who, password){
    await page.fill("#username", who.username);
    await page.fill("#password", password || who.password);
    await page.click("#loginForm button[type=submit]");
  }
  const shot = async (page, name)=>{ if(process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, name + ".png"), fullPage:true }); };

  if(chromium) await t("in a browser: a Reviewer signs in, drops a file, sees photos, unticks one, publishes, sees results and history, unpublishes", async ()=>{
    const P = await startPortal();
    const browser = await chromium.launch();
    try{
      const file = path.join(os.tmpdir(), "MKT0007-Boka-portal-test.scl");
      fs.writeFileSync(file, await makeScl({ mutate: d=>{ d.vendor.business_name = "<img src=x onerror=alert(1)>Boka"; } }));
      const { page, errors } = await browserPage(browser, P);
      await page.waitForSelector("#loginForm:not([hidden]), #loginView:not([hidden])");
      await signIn(page, REVIEWER, "wrong password!!");
      await page.waitForSelector("#loginError:not([hidden])");
      assert.strictEqual((await page.textContent("#loginError")).trim(), "Wrong username or password.");
      await signIn(page, REVIEWER);
      await page.waitForSelector("#drop");
      assert.strictEqual(await page.isVisible("#staffTab"), false, "no Staff tab for a Reviewer");
      assert.match(await page.textContent("#whoami"), /Rudo Reviewer · Reviewer/);
      const page_errors = errors;
      await page.setInputFiles("#fileInput", file);
      await page.waitForSelector("#vendorCard");
      // Vendor text from the file is shown as text, never as markup.
      assert.match(await page.textContent("#vendorCard"), /<img src=x onerror=alert\(1\)>Boka/);
      assert.strictEqual(await page.$$eval("#vendorCard img", els=> els.length), 0);
      assert.match(await page.textContent("#vendorCard"), /registered device/);
      assert.match(await page.textContent("#vendorToken"), /token active until 9 Oct 2026/);
      await page.waitForFunction(()=> [...document.querySelectorAll("#items img.thumb")].every(i=> i.complete && i.naturalWidth > 0));
      assert.strictEqual(await page.$$eval("#items img.thumb", els=> els.length), 2);
      assert.match(await page.textContent("#publishCount"), /3 of 3 products will be published/);
      if(process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, "portal-1-preview.png"), fullPage:true });
      await page.uncheck('#items input.include[data-index="1"]');
      assert.match(await page.textContent("#publishCount"), /2 of 3/);
      await page.click("#publishBtn");
      await page.waitForSelector("#resultBanner");
      assert.match(await page.textContent("#resultBanner"), /2 of 2 published/);
      assert.match(await page.textContent('#items tr[data-index="0"] td.result'), /published/);
      assert.strictEqual((await page.textContent('#items tr[data-index="1"] td.result')).trim(), "", "untouched row has no result");
      if(process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, "portal-2-published.png"), fullPage:true });
      assert.deepStrictEqual(P.fake.state.vendor_listings.map(l=> l.product_name), ["Sugar 2kg", "Candles (6)"]);

      await page.click('#nav [data-view="history"]');
      await page.waitForSelector("details.group");
      await page.click("details.group summary");
      assert.match(await page.textContent("details.group summary"), /token active until 9 Oct 2026/);
      await page.waitForFunction(()=> { const i = document.querySelector("details.group img.thumb"); return i && i.complete && i.naturalWidth > 0; });
      if(process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, "portal-3-history.png"), fullPage:true });
      await page.click('details.group tr:has-text("Sugar 2kg") button.unpublish');
      // The list is rebuilt after an unpublish; wait for the new one.
      await page.waitForFunction(()=>{ const s = document.querySelector("details.group summary"); return !!s && /1 live/.test(s.textContent); });
      assert.strictEqual(P.fake.state.vendor_listings.find(l=> l.product_name==="Sugar 2kg").status, "pending_review");
      // Tokens are visible to a Reviewer, but there's nothing to record or void.
      await page.click('#nav [data-view="vendors"]');
      await page.waitForSelector("details.vendor");
      assert.strictEqual(await page.$$eval(".token-form, button.void", els=> els.length), 0);
      assert.deepStrictEqual(page_errors(), []);
    } finally { await browser.close(); P.close(); }
  });

  if(chromium) await t("in a browser: first run creates the Admin; they add a Reviewer, who must pick their own password first", async ()=>{
    const P = await startPortal({ staff:false });
    const browser = await chromium.launch();
    try{
      const { page, errors } = await browserPage(browser, P);
      await page.waitForSelector("#setupForm");
      await page.fill("#setupPassphrase", "not the passphrase");
      await page.fill("#setupName", "Tariro Moyo"); await page.fill("#setupUsername", "tariro");
      await page.fill("#setupPassword", "my admin password 1"); await page.fill("#setupPassword2", "my admin password 1");
      await page.click("#setupForm button[type=submit]");
      await page.waitForSelector("#setupError:not([hidden])");
      assert.match(await page.textContent("#setupError"), /isn't the setup passphrase/);
      await page.fill("#setupPassphrase", PASS);
      await page.click("#setupForm button[type=submit]");
      await page.waitForSelector("#drop");
      assert.strictEqual(await page.isVisible("#staffTab"), true, "Admins see Staff");
      await page.click("#staffTab");
      await page.waitForSelector('#staffList tr[data-username="tariro"]');
      await shot(page, "portal-4-staff");
      await page.fill("#newName", "Rudo Reviewer"); await page.fill("#newUsername", "rudo");
      await page.selectOption("#newRole", "reviewer"); await page.fill("#newPassword", "temporary pass 1");
      await page.click("#addStaffForm button[type=submit]");
      await page.waitForSelector('#staffList tr[data-username="rudo"]');
      assert.match(await page.textContent('#staffList tr[data-username="rudo"]'), /temporary password/);
      await page.click("#logoutBtn");
      await page.waitForSelector("#loginView:not([hidden])");
      await signIn(page, { username:"rudo", password:"temporary pass 1" });
      await page.waitForSelector("#passwordView:not([hidden])");
      assert.strictEqual(await page.isVisible("#passwordForced"), true);
      assert.strictEqual(await page.isDisabled('#nav [data-view="upload"]'), true, "nothing else until the password is changed");
      // Containing the username is refused, with the reason on screen.
      await page.fill("#pwCurrent", "temporary pass 1"); await page.fill("#pwNext", "rudo's own password"); await page.fill("#pwNext2", "rudo's own password");
      await page.click("#passwordForm button[type=submit]");
      await page.waitForSelector("#passwordError:not([hidden])");
      assert.match(await page.textContent("#passwordError"), /Don't include your username/);
      await page.fill("#pwNext", "a password of my own"); await page.fill("#pwNext2", "a password of my own");
      await page.click("#passwordForm button[type=submit]");
      await page.waitForSelector("#drop");
      assert.strictEqual(await page.isVisible("#staffTab"), false);
      assert.strictEqual(P.staffRow("rudo").must_change_password, false);
      assert.deepStrictEqual(errors(), []);
    } finally { await browser.close(); P.close(); }
  });

  if(chromium) await t("in a browser: no token blocks Publish with the reason; an Admin records one right there and publishes", async ()=>{
    const P = await startPortal({ token:false });
    const browser = await chromium.launch();
    try{
      const file = path.join(os.tmpdir(), "MKT0007-Boka-portal-token.scl");
      fs.writeFileSync(file, await makeScl());
      // A Reviewer sees the reason but no way to record a token.
      const r = await browserPage(browser, P);
      await signIn(r.page, REVIEWER);
      await r.page.waitForSelector("#drop");
      await r.page.setInputFiles("#fileInput", file);
      await r.page.waitForSelector("#tokenBlock");
      assert.match(await r.page.textContent("#tokenBlock"), /No active token — none has been recorded for this vendor\. Record one to continue\. Ask an Admin to record one\./);
      assert.strictEqual(await r.page.$("#recordTokenBtn"), null);
      assert.strictEqual(await r.page.isDisabled("#publishBtn"), true);
      await r.page.close();

      const { page, errors } = await browserPage(browser, P);
      await signIn(page, ADMIN);
      await page.waitForSelector("#drop");
      await page.setInputFiles("#fileInput", file);
      await page.waitForSelector("#tokenBlock");
      assert.strictEqual(await page.isDisabled("#publishBtn"), true);
      assert.match(await page.textContent("#publishCount"), /No active token/);
      assert.strictEqual(await page.$$eval("#items input.include:not(:disabled)", els=> els.length), 0, "nothing can be ticked");
      await shot(page, "portal-5-no-token");
      await page.click("#recordTokenBtn");
      await page.waitForSelector(".token-form");
      assert.strictEqual(await page.inputValue(".token-form .tk-start"), TODAY);
      assert.strictEqual(await page.inputValue(".token-form .tk-days"), "30", "30 days by default");
      assert.match(await page.textContent(".token-form .tk-covers"), /Covers 25 Sept? 2026 to 24 Oct 2026 \(30 days\)/);
      await page.fill(".token-form .tk-days", "31");
      assert.match(await page.textContent(".token-form .tk-covers"), /to 25 Oct 2026 \(31 days\)/);
      await page.fill(".token-form .tk-amount", "10");
      await page.selectOption(".token-form .tk-via", "EcoCash");
      await page.fill(".token-form .tk-ref", "MP260925.1200.A12345");
      await shot(page, "portal-6-record-token");
      await page.click(".token-form button[type=submit]");
      await page.waitForFunction(()=> !document.querySelector("#tokenBlock"));
      assert.match(await page.textContent("#vendorToken"), /token active until 25 Oct 2026/);
      assert.match(await page.textContent("#publishCount"), /3 of 3 products will be published/);
      const tok = P.fake.state.vendor_tokens[0];
      assert.deepStrictEqual([tok.starts_on, tok.days, tok.amount, tok.currency, tok.payment_method, tok.reference], [TODAY, 31, 10, "USD", "EcoCash", "MP260925.1200.A12345"]);
      await page.click("#publishBtn");
      await page.waitForSelector("#resultBanner");
      assert.match(await page.textContent("#resultBanner"), /3 of 3 published/);
      // Vendors & tokens: the purchase is listed and can be voided.
      await page.click('#nav [data-view="vendors"]');
      await page.waitForSelector("details.vendor");
      await page.click("details.vendor summary");
      assert.match(await page.textContent("details.vendor summary"), /token active until 25 Oct 2026/);
      assert.match(await page.textContent("table.tokens"), /25 Sept? 2026 – 25 Oct 2026.*31.*USD 10\.00.*EcoCash · MP260925\.1200\.A12345.*Tariro Admin/s);
      await shot(page, "portal-7-vendors");
      assert.deepStrictEqual(errors(), []);
    } finally { await browser.close(); P.close(); }
  });

  if(chromium) await t("in a browser: the lockout message and an Admin voiding a token", async ()=>{
    const P = await startPortal();
    const browser = await chromium.launch();
    try{
      const { page, errors } = await browserPage(browser, P, { onDialog: d=> d.type()==="prompt" ? d.accept("entered against the wrong shop") : d.accept() });
      for(let i=0; i<5; i++){ await signIn(page, REVIEWER, "wrong password " + i); await page.waitForFunction((n)=> !document.querySelector("#loginError").hidden, i); }
      assert.match(await page.textContent("#loginError"), /locked until 12:15; an Admin can unlock it sooner/);
      await signIn(page, ADMIN);
      await page.waitForSelector("#drop");
      await page.click('#nav [data-view="vendors"]');
      await page.waitForSelector("details.vendor");
      await page.click("details.vendor summary");
      await page.click("table.tokens button.void");
      await page.waitForSelector("table.tokens tr.voided");
      assert.match(await page.textContent("table.tokens tr.voided"), /voided by Tariro Admin: entered against the wrong shop/);
      assert.match(await page.textContent("details.vendor summary"), /no token/);
      await page.click("#staffTab");
      await page.waitForSelector('#staffList tr[data-username="rudo"] button.unlock');
      await page.click('#staffList tr[data-username="rudo"] button.unlock');
      await page.waitForFunction(()=> !document.querySelector('#staffList tr[data-username="rudo"] button.unlock'));
      assert.strictEqual(P.staffRow("rudo").locked_until, null);
      assert.deepStrictEqual(errors(), []);
    } finally { await browser.close(); P.close(); }
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
