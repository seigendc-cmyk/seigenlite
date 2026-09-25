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
  };
  const uuid = ()=> crypto.randomUUID();
  function filters(params){
    const f = [];
    for(const [k, v] of params){
      if(["select","order","limit","on_conflict"].includes(k)) continue;
      const m = v.match(/^(eq|neq|gt)\.(.*)$/);
      if(m) f.push(r=> m[1]==="eq"? String(r[k])===m[2] : m[1]==="neq"? String(r[k])!==m[2] : String(r[k]) > m[2]);
      else if(v==="not.is.null") f.push(r=> r[k]!=null);
    }
    return (r)=> f.every(fn=> fn(r));
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
        if(url.searchParams.get("order")==="published_at.desc") rows = rows.slice().sort((a,b)=> String(b.published_at).localeCompare(String(a.published_at)));
        return send(200, rows);
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
async function startPortal(){
  const fake = await startFakeSupabase();
  const { server } = createPortal({ supabaseUrl:fake.url, serviceKey:SERVICE_KEY, passphrase:PASS, log:()=>{} });
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
  const login = ()=> call("/api/login", { method:"POST", body:JSON.stringify({ passphrase:PASS }) });
  const upload = (text)=> call("/api/batches", { method:"POST", body:text });
  const publish = (id, include)=> call(`/api/batches/${id}/publish`, { method:"POST", body:JSON.stringify({ include }) });
  const close = ()=>{ server.close(); fake.server.close(); };
  return { fake, base, call, login, upload, publish, close, seen, get cookie(){ return cookie; } };
}
const writes = (fake)=> fake.state.log.filter(r=> r.method!=="GET");

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
  await t("everything under /api needs the passphrase; wrong ones are refused and rate-limited", async ()=>{
    const P = await startPortal();
    try{
      assert.strictEqual((await P.upload(await makeScl())).status, 401);
      assert.strictEqual((await P.call("/api/history")).status, 401);
      assert.strictEqual((await P.call("/api/session")).json.signedIn, false);
      for(let i=0; i<5; i++) assert.strictEqual((await P.call("/api/login", { method:"POST", body:JSON.stringify({ passphrase:"nope" }) })).status, 401);
      assert.strictEqual((await P.login()).status, 429, "6th try within a minute is refused even with the right passphrase");
      assert.strictEqual(writes(P.fake).length, 0);
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
  if(chromium) await t("in a browser: sign in, drop a file, see photos, untick one, publish, per-product results, history, unpublish", async ()=>{
    const P = await startPortal();
    const browser = await chromium.launch();
    try{
      const fs = require("fs"), os = require("os"), path = require("path");
      const file = path.join(os.tmpdir(), "MKT0007-Boka-portal-test.scl");
      fs.writeFileSync(file, await makeScl({ mutate: d=>{ d.vendor.business_name = "<img src=x onerror=alert(1)>Boka"; } }));
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", e=> errors.push(e.message));
      page.on("console", m=> { if(m.type()==="error") errors.push(m.text()); });
      page.on("dialog", d=> d.accept());
      await page.goto(P.base + "/");
      await page.fill("#passphrase", "wrong passphrase!");
      await page.click("#loginForm button[type=submit]");
      await page.waitForSelector("#loginError:not([hidden])");
      await page.fill("#passphrase", PASS);
      await page.click("#loginForm button[type=submit]");
      await page.waitForSelector("#drop");
      await page.setInputFiles("#fileInput", file);
      await page.waitForSelector("#vendorCard");
      // Vendor text from the file is shown as text, never as markup.
      assert.match(await page.textContent("#vendorCard"), /<img src=x onerror=alert\(1\)>Boka/);
      assert.strictEqual(await page.$$eval("#vendorCard img", els=> els.length), 0);
      assert.match(await page.textContent("#vendorCard"), /registered device/);
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
      await page.waitForFunction(()=> { const i = document.querySelector("details.group img.thumb"); return i && i.complete && i.naturalWidth > 0; });
      if(process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, "portal-3-history.png"), fullPage:true });
      await page.click('details.group tr:has-text("Sugar 2kg") button.unpublish');
      await page.waitForFunction(()=> /1 live/.test(document.querySelector("details.group summary").textContent));
      assert.strictEqual(P.fake.state.vendor_listings.find(l=> l.product_name==="Sugar 2kg").status, "pending_review");
      assert.deepStrictEqual(errors.filter(e=> !/401|Unauthorized/.test(e)), []);
    } finally { await browser.close(); P.close(); }
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
