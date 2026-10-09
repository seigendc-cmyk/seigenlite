// Run: node --no-warnings test/publish-pack.test.js
// The publish-pack Edge Function's handler (supabase/functions/publish-pack/
// handler.mjs) against the REAL SQL (every migration, in PGlite) and a fake
// Storage that records what it was given:
//   * refusals: no token (401), not staff (403), the database's own refusals
//     (no permission, not enough paid days, a product with a problem)
//   * a publish: photos and thumbnails stored content-addressed under the
//     iTred install ID, with the service key, ONLY against Storage; the
//     listing rows carry those URLs; days used
//   * a Storage failure publishes nothing and charges nothing
//   * a second click answers "already published"
//   * old photo files: a republish deletes the replaced listing's files from
//     the bucket (except one the new listing reuses), Unpublish deletes the
//     rest; a failed delete stays queued and goes next time
//   * the service-role key never appears in any response
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const { newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}
const SERVICE_KEY = "service-role-key-must-never-leave-the-function-" + crypto.randomBytes(8).toString("hex");
const ANON = "anon-key";
const URL0 = "https://proj.supabase.co";
const b64u = (o)=> Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenFor = (claims)=> b64u({ alg:"HS256" }) + "." + b64u(claims) + ".sig";
const sha = (s)=> crypto.createHash("sha256").update(s, "utf8").digest("hex");
const webp = (seed)=> "data:image/webp;base64," + Buffer.concat([Buffer.from("RIFF"), Buffer.from([20,0,0,0]), Buffer.from("WEBPVP8L"), crypto.createHash("md5").update(String(seed)).digest()]).toString("base64");

(async()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: [] });
  const q = async (sql, p)=> (await pg.query(sql, p)).rows;
  const staff = {};
  for(const [k, sys] of [["PUB", false], ["REV", false], ["TOK", false], ["LED", false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, true, now()) returning id`, ["Staff " + k, sys]))[0].id;
  const grant = async (s, key)=>{ const id = ((await q(`select id from cl_modules where key = $1`, [key]))[0] || {}).id || (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [key]))[0].id;
    await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff[s], id]); };
  await grant("PUB", "market_publish"); await grant("REV", "market_review"); await grant("TOK", "token_sales"); await grant("LED", "collections_ledger");
  const claims = (k)=> ({ role:"authenticated", sub:staff[k], user_type:"staff", is_sysadmin:false });
  const deviceKey = crypto.randomBytes(16).toString("hex");
  const vendor = (await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status) values ('Shop One', 'SD01', 'Shop Phrase', $1, 'onboarding') returning id`, [deviceKey]))[0].id;

  // the fake Supabase: RPCs run in PGlite with the caller's claims; Storage records
  const stored = {}, calls = [];
  let storageDown = false, deleteDown = false;
  const deletes = [];
  async function rpc(name, body, c){
    const keys = Object.keys(body);
    const casts = { p_pack_id:"::uuid", p_pack_uid:"::uuid", p_days:"::integer", p_items:"::text[]", p_urls:"::jsonb", p_vendor_id:"::uuid", p_business_id:"::uuid", p_qty:"::integer", p_amount:"::numeric", p_coa_account_id:"::uuid", p_ids:"::bigint[]", p_limit:"::integer", p_itred_vendor_id:"::uuid" };
    const vals = keys.map((k)=> k === "p_items" ? "{" + body[k].map((x)=> '"' + x + '"').join(",") + "}" : k === "p_urls" ? JSON.stringify(body[k]) : body[k]);
    await pg.exec("set role " + (c ? "authenticated" : "anon"));
    await pg.query("select set_config('request.jwt.claims', $1, false)", [c ? JSON.stringify(c) : ""]);
    try{ return { status:200, json:(await pg.query(`select to_json(public.${name}(${keys.map((k, i)=> `${k}=>$${i+1}${casts[k] || ""}`).join(",")})) j`, vals)).rows[0].j }; }
    catch(e){ return { status: /permission denied|42501/.test(e.message + e.code) ? 403 : 400, json:{ message:e.message } }; }
    finally{ await pg.exec("reset role"); await pg.query("select set_config('request.jwt.claims', '', false)"); }
  }
  const fakeFetch = async (url, opts)=>{
    const auth = (opts.headers.Authorization || "").replace(/^Bearer\s+/, "");
    calls.push({ url, auth, apikey: opts.headers.apikey });
    let m = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url);
    if(m){
      const c = JSON.parse(Buffer.from(auth.split(".")[1], "base64url").toString());
      const r = await rpc(m[1], JSON.parse(opts.body), c);
      return new Response(JSON.stringify(r.json), { status:r.status });
    }
    if(/\/storage\/v1\/object\/listing-images$/.test(url) && opts.method === "DELETE"){
      deletes.push({ auth, prefixes: JSON.parse(opts.body).prefixes });
      if(deleteDown) return new Response("{}", { status:500 });
      for(const p of JSON.parse(opts.body).prefixes) delete stored[p];
      return new Response("[]", { status:200 });
    }
    m = /\/storage\/v1\/object\/listing-images\/(.+)$/.exec(url);
    if(m){
      if(storageDown) return new Response("{}", { status:500 });
      stored[m[1]] = { bytes: Buffer.from(opts.body), auth, upsert: opts.headers["x-upsert"] };
      return new Response("{}", { status:200 });
    }
    return new Response("{}", { status:404 });
  };
  const { makeHandler } = await import("../supabase/functions/publish-pack/handler.mjs");
  const handler = makeHandler({ supabaseUrl:URL0, anonKey:ANON, serviceKey:SERVICE_KEY }, fakeFetch);
  const responses = [];
  const call = async (who, body)=>{
    const headers = { "Content-Type":"application/json" };
    if(who) headers.Authorization = "Bearer " + (typeof who === "string" ? tokenFor(claims(who)) : tokenFor(who));
    const r = await handler(new Request("https://edge/functions/v1/publish-pack", { method:"POST", headers, body: JSON.stringify(body) }));
    const text = await r.text(); responses.push(text);
    return { status:r.status, body: JSON.parse(text) };
  };

  // a pack, sent by the device
  const images = { A1: webp("a1"), A2: webp("a2") }, thumbs = { A1: webp("t1") };
  const header = JSON.stringify({ format:"seigen.market_export", format_version:2, export_no:"MKT0001",
    vendor:{ install_id:"SD01", business_name:"Shop One", whatsapp_number:null, city:"Harare" },
    listings:[{ source_product_id:"A1", product_name:"Sugar", price:2, currency:"USD", category:null, stock_quantity:3, exported_at:new Date().toISOString(), image_sha256: sha(images.A1) },
              { source_product_id:"A2", product_name:"Rice", price:5, currency:"USD", category:null, stock_quantity:1, exported_at:new Date().toISOString(), image_sha256: sha(images.A2) },
              { source_product_id:"A3", product_name:"Bad", price:-1, currency:"USD", category:null, stock_quantity:1, exported_at:new Date().toISOString(), image_sha256: null }] });
  const uid = crypto.randomUUID();
  const dev = (sql, p)=> rpc(sql, p, null);
  await dev("cl_device_pack_submit", { p_install_id:"SD01", p_secret_phrase:"Shop Phrase", p_device_key:deviceKey, p_pack_uid:uid, p_header:header, p_header_sha256:sha(header) });
  for(const id of ["A1", "A2"]) await dev("cl_device_pack_image", { p_install_id:"SD01", p_secret_phrase:"Shop Phrase", p_device_key:deviceKey, p_pack_uid:uid, p_source_product_id:id, p_image_webp:images[id], p_thumb_webp:thumbs[id] || null });

  await t("CORS: the browser preflight answers 200, and every answer (errors too) carries the same headers", async ()=>{
    const want = { "access-control-allow-origin":"*", "access-control-allow-headers":"authorization, apikey, content-type, x-client-info", "access-control-allow-methods":"POST, OPTIONS" };
    const pre = await handler(new Request("https://edge/functions/v1/publish-pack", { method:"OPTIONS", headers:{ Origin:"https://sclconsole-preview.seigendc.workers.dev" } }));
    assert.strictEqual(pre.status, 200);
    const answers = [pre,
      await handler(new Request("https://edge/functions/v1/publish-pack", { method:"GET" })),
      await handler(new Request("https://edge/functions/v1/publish-pack", { method:"POST", body:"{}" })),
      await handler(new Request("https://edge/functions/v1/publish-pack", { method:"POST", headers:{ Authorization:"Bearer " + tokenFor(claims("PUB")) }, body:"not json" })),
      await handler(new Request("https://edge/functions/v1/publish-pack", { method:"POST", headers:{ Authorization:"Bearer " + tokenFor(claims("PUB")) }, body: JSON.stringify({ pack_id:uid, days:99999, items:["A1"] }) }))];
    assert.deepStrictEqual(answers.map((r)=> r.status), [200, 405, 401, 400, 400]);
    for(const r of answers) for(const k of Object.keys(want)) assert.strictEqual(r.headers.get(k), want[k], r.status + " " + k);
  });

  await t("no token: 401; not a staff token: 403", async ()=>{
    assert.strictEqual((await call(null, { pack_id:uid, days:2, items:["A1"] })).status, 401);
    assert.strictEqual((await call({ role:"authenticated", sub:"x", user_type:"rpn" }, { pack_id:uid, days:2, items:["A1"] })).status, 403);
  });
  await t("staff without Market Publishing: the database refuses (403)", async ()=>{
    const r = await call("REV", { pack_id:uid, days:2, items:["A1"] });
    assert.strictEqual(r.status, 403); assert.match(r.body.error, /Not authorized/);
  });
  await t("not enough paid days: the database's plain refusal; nothing stored", async ()=>{
    const r = await call("PUB", { pack_id:uid, days:2, items:["A1", "A2"] });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Not enough paid listing days: 0 paid and unused, 2 needed\. Sell tokens and record the payment first\./);
    assert.deepStrictEqual(Object.keys(stored), []);
  });
  await t("a product with a problem must be unticked", async ()=>{
    const r = await call("PUB", { pack_id:uid, days:2, items:["A1", "A3"] });
    assert.match(r.body.error, /Untick the products with problems: Bad \(bad price\)/);
  });
  // tokens, paid
  const coa = (await q(`insert into cl_chart_of_accounts (id, code, name, account_type, active, created_at) values (gen_random_uuid(), '1000', 'Cash', 'asset', true, now()) returning id`))[0].id;
  await rpc("cl_sell_tokens", { p_business_id:null, p_vendor_id:vendor, p_qty:2 }, claims("TOK"));
  await rpc("cl_record_ledger_payment", { p_vendor_id:vendor, p_amount:2, p_currency:"USD", p_coa_account_id:coa }, claims("LED"));
  await t("Storage down: nothing published, no days used, a plain message", async ()=>{
    storageDown = true;
    const r = await call("PUB", { pack_id:uid, days:2, items:["A1", "A2"] });
    storageDown = false;
    assert.strictEqual(r.status, 502); assert.match(r.body.error, /^Nothing was published: Couldn't store a photo \(500\)\. Try again\.$/);
    assert.strictEqual((await q(`select count(*)::int c from vendor_listings`))[0].c, 0);
    assert.strictEqual((await q(`select count(*)::int c from cl_token_uses`))[0].c, 0);
  });
  await t("publish: photos and thumbnails stored content-addressed under the iTred install ID, with the service key; listings carry the URLs; 2 days used", async ()=>{
    const r = await call("PUB", { pack_id:uid, days:2, items:["A1", "A2"] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.published, 2); assert.strictEqual(r.body.days_used, 2); assert.strictEqual(r.body.available_after, 0);
    const keys = Object.keys(stored).sort();
    assert.deepStrictEqual(keys, ["SD01/" + sha(images.A1) + "-t.webp", "SD01/" + sha(images.A1) + ".webp", "SD01/" + sha(images.A2) + ".webp"].sort());
    assert.ok(Object.values(stored).every((s)=> s.auth === SERVICE_KEY && s.upsert === "true"));
    assert.strictEqual(stored["SD01/" + sha(images.A1) + ".webp"].bytes.toString("ascii", 0, 4), "RIFF");
    const rows = await q(`select source_product_id, image_url, thumb_url from vendor_listings order by source_product_id`);
    assert.deepStrictEqual(rows, [
      { source_product_id:"A1", image_url: URL0 + "/storage/v1/object/public/listing-images/SD01/" + sha(images.A1) + ".webp", thumb_url: URL0 + "/storage/v1/object/public/listing-images/SD01/" + sha(images.A1) + "-t.webp" },
      { source_product_id:"A2", image_url: URL0 + "/storage/v1/object/public/listing-images/SD01/" + sha(images.A2) + ".webp", thumb_url: null }]);
  });
  await t("the service key is used only against Storage (every RPC carried the staff token)", async ()=>{
    for(const c of calls){
      if(/\/rest\/v1\//.test(c.url)) assert.ok(c.auth !== SERVICE_KEY && c.apikey === ANON, c.url);
      else assert.ok(/\/storage\/v1\//.test(c.url), c.url);
    }
  });
  await t("a second click: 'already published', nothing new", async ()=>{
    const before = Object.keys(stored).length;
    const r = await call("PUB", { pack_id:uid, days:2, items:["A1", "A2"] });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /That pack was already published/);
    assert.strictEqual(Object.keys(stored).length, before);
    assert.strictEqual((await q(`select count(*)::int c from vendor_listings`))[0].c, 2);
  });
  // a second pack: A1 again (the same photo, so the same file) + a new B1
  const images2 = { A1: images.A1, B1: webp("b1") };
  const header2 = JSON.stringify({ format:"seigen.market_export", format_version:2, export_no:"MKT0002",
    vendor:{ install_id:"SD01", business_name:"Shop One", whatsapp_number:null, city:"Harare" },
    listings:[{ source_product_id:"A1", product_name:"Sugar", price:2, currency:"USD", category:null, stock_quantity:3, exported_at:new Date().toISOString(), image_sha256: sha(images2.A1) },
              { source_product_id:"B1", product_name:"Beans", price:1, currency:"USD", category:null, stock_quantity:3, exported_at:new Date().toISOString(), image_sha256: sha(images2.B1) }] });
  const uid2 = crypto.randomUUID();
  await dev("cl_device_pack_submit", { p_install_id:"SD01", p_secret_phrase:"Shop Phrase", p_device_key:deviceKey, p_pack_uid:uid2, p_header:header2, p_header_sha256:sha(header2) });
  for(const id of ["A1", "B1"]) await dev("cl_device_pack_image", { p_install_id:"SD01", p_secret_phrase:"Shop Phrase", p_device_key:deviceKey, p_pack_uid:uid2, p_source_product_id:id, p_image_webp:images2[id], p_thumb_webp: id === "A1" ? thumbs.A1 : null });

  await t("republish: the replaced listing's old files are deleted from the bucket (with the service key), except the one the new listing reuses", async ()=>{
    const r = await call("PUB", { pack_id:uid2, days:0, items:["A1", "B1"] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.photos_to_delete, 1); assert.strictEqual(r.body.photos_deleted, 1);
    assert.deepStrictEqual(deletes[deletes.length - 1].prefixes, ["SD01/" + sha(images.A2) + ".webp"]);
    assert.strictEqual(deletes[deletes.length - 1].auth, SERVICE_KEY);
    assert.ok(stored["SD01/" + sha(images.A1) + ".webp"] && stored["SD01/" + sha(images.A1) + "-t.webp"], "A1's files kept: the new listing uses them");
    assert.ok(!stored["SD01/" + sha(images.A2) + ".webp"], "A2's file deleted");
    assert.strictEqual((await q(`select count(*)::int c from cl_listing_photo_trash where done_at is null`))[0].c, 0);
    assert.strictEqual((await q(`select count(image_webp)::int c from cl_market_pack_images where pack_id = $1`, [uid2]))[0].c, 0, "the pack's photo data cleared once in Storage");
  });
  await t("unpublish through the function: off now, days back, and the listing's files deleted; a failed delete stays queued and goes next time", async ()=>{
    const iv = (await q(`select id from vendors where install_id = 'SD01'`))[0].id;
    deleteDown = true;
    const r = await call("PUB", { action:"unpublish", itred_vendor_id:iv, reason:"TEST: closing" });
    deleteDown = false;
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.photos_to_delete, 3); assert.strictEqual(r.body.photos_deleted, 0);
    assert.strictEqual((await q(`select count(*)::int c from cl_listing_photo_trash where done_at is null`))[0].c, 3, "still queued after a failed delete");
    // the next call sweeps them (any publish or unpublish); here: a refused unpublish still sweeps nothing, so publish-side sweep is used
    const r2 = await call("REV", { action:"unpublish", itred_vendor_id:iv, reason:"TEST" });
    assert.strictEqual(r2.status, 403);
    const sweepCall = await call("PUB", { action:"unpublish", itred_vendor_id:iv, reason:"TEST again" });
    assert.strictEqual(sweepCall.status, 400); assert.match(sweepCall.body.error, /no live listing/);
    assert.strictEqual((await q(`select count(*)::int c from cl_listing_photo_trash where done_at is null`))[0].c, 0, "the next call deleted them");
    assert.deepStrictEqual(Object.keys(stored).filter((k)=> k.startsWith("SD01/")), [], "no files of the taken-off listing left");
  });

  await t("the service-role key is in no response", async ()=>{
    assert.ok(responses.length >= 7);
    for(const text of responses) assert.ok(!text.includes(SERVICE_KEY));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
