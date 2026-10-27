// Run: node --no-warnings test/itred-fulfilment-fake.test.js
// The fake Supabase's side of 20261105120000_itred_order_fulfilment.sql:
// only the vendor's tills set quantity_fulfilled (the customer's PATCH is
// refused), the customer confirms or disputes a line the vendor has
// answered (rpc itred_line_respond), and each order has one message thread
// the customer reads and writes (itred_order_messages, rpc
// itred_messages_read). Requests go through a real browser's fetch()
// (Playwright) at the fake, exactly as the site's own PostgREST calls do.
// The SQL itself is proven in supabase/tests/itred-order-fulfilment-test.js
// (PGlite); this keeps the fake honest to it.
"use strict";
const assert = require("assert");
const { createFakeSupabase, listingRow, PROJECT } = require("./itred-fake-supabase");

let chromium;
require("./local-cdn");   // the cdnjs files from test/cdn/, not the internet
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

// A fake with one customer's order: a listed line (qty 2) and a custom
// request (qty 1), plus a second customer who must not reach it.
function rig(){
  const vendorId = "vendor-A";
  const listing = listingRow({ vendor_id: vendorId, product_name:"Sugar 2kg", price:3.5 });
  const fake = createFakeSupabase({ listings:[listing] });
  const u1 = fake.addUser("u1@test.invalid","pw123456",{ confirmed:true });
  const u2 = fake.addUser("u2@test.invalid","pw123456",{ confirmed:true });
  fake.tokens.set("tok-u1", u1.id); fake.tokens.set("tok-u2", u2.id);
  const order = { id:"po-1", customer_id:u1.id, vendor_id:vendorId, status:"sent", pdf_url:null, completed_at:null, created_at:new Date().toISOString() };
  fake.orders.push(order);
  const line = (id, qty, custom)=>({ id, purchase_order_id:order.id, vendor_listing_id: custom? null : listing.id, item_name: custom? "Gas 9kg" : "Sugar 2kg",
    unit_price: custom? null : 3.5, currency: custom? null : "USD", quantity_requested:qty, quantity_fulfilled:0, is_custom_request:!!custom,
    fulfillment_status:"outstanding", created_at:new Date().toISOString(),
    vendor_note:null, vendor_updated_at:null, customer_confirmed_at:null, customer_dispute:null });
  fake.items.push(line("line-listed", 2, false), line("line-custom", 1, true));
  return { fake, order, listed: fake.items[0], custom: fake.items[1] };
}

(async()=>{
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // A page on the project's own origin, so fetch() needs no CORS handshake.
  let fake = null;
  await page.route(PROJECT+"/**", route => route.request().url()===PROJECT+"/"
    ? route.fulfill({ status:200, contentType:"text/html", body:"<!doctype html><title>t</title>" })
    : fake.__handle(route));
  await page.goto(PROJECT+"/");
  const call = (method, path, token, body)=> page.evaluate(async ({ url, method, token, body })=>{
    const headers = { "Content-Type":"application/json", "Prefer":"return=representation" };
    if(token) headers.Authorization = "Bearer "+token;
    const r = await fetch(url, { method, headers, body: JSON.stringify(body) });
    return { status:r.status, json: await r.json().catch(()=>null) };
  }, { url: PROJECT+path, method, token, body });
  const use = (r)=>{ fake = r.fake; return r; };

  await t("the customer can no longer set quantity_fulfilled (or any other line column)", async ()=>{
    const { order, listed } = use(rig());
    for(const body of [{ quantity_fulfilled:1 }, { quantity_requested:9 }, { customer_dispute:"x" }]){
      const r = await call("PATCH", "/rest/v1/purchase_order_items?id=eq."+listed.id, "tok-u1", body);
      assert.strictEqual(r.status, 401, JSON.stringify(body));
    }
    assert.strictEqual(listed.quantity_fulfilled, 0); assert.strictEqual(order.status, "sent");
  });

  await t("the vendor's till sets lines and the order's status follows; a closed order stays closed", async ()=>{
    const { order, listed, custom } = use(rig());
    fake.vendorSetLine(listed.id, 1, "1 more on Friday");
    assert.strictEqual(listed.fulfillment_status, "partially_fulfilled");
    assert.strictEqual(order.status, "partially_fulfilled");
    fake.vendorSetLine(listed.id, 2); fake.vendorSetLine(custom.id, 1);
    assert.strictEqual(order.status, "fulfilled");
    fake.vendorComplete(order.id);
    assert.ok(order.completed_at);
    order.status = "closed"; fake.vendorSetLine(listed.id, 0);
    assert.strictEqual(order.status, "closed");
  });

  await t("confirm or dispute: only an answered line, only with a reason, only on your own order", async ()=>{
    const { listed, custom } = use(rig());
    const respond = (token, body)=> call("POST", "/rest/v1/rpc/itred_line_respond", token, body);
    assert.strictEqual((await respond("tok-u1", { p_item_id:listed.id, p_confirm:true, p_dispute:null })).json.error, "NOT_ANSWERED");
    fake.vendorSetLine(listed.id, 2);
    assert.strictEqual((await respond("tok-u2", { p_item_id:listed.id, p_confirm:true, p_dispute:null })).json.error, "NOT_FOUND");
    assert.strictEqual((await respond("", { p_item_id:listed.id, p_confirm:true, p_dispute:null })).status, 401);
    assert.deepStrictEqual((await respond("tok-u1", { p_item_id:listed.id, p_confirm:true, p_dispute:null })).json, { ok:true });
    assert.ok(listed.customer_confirmed_at);
    fake.vendorSetLine(custom.id, 0, "out of stock");
    assert.strictEqual((await respond("tok-u1", { p_item_id:custom.id, p_confirm:false, p_dispute:"  " })).json.error, "REASON_REQUIRED");
    await respond("tok-u1", { p_item_id:custom.id, p_confirm:false, p_dispute:"I collected it" });
    assert.strictEqual(custom.customer_dispute, "I collected it");
    fake.vendorSetLine(custom.id, 1);
    assert.strictEqual(custom.customer_dispute, null, "a changed quantity clears the old dispute");
  });

  await t("messages: the customer writes on their own order once per id, reads the vendor's replies", async ()=>{
    const { order } = use(rig());
    const post = (token, row)=> call("POST", "/rest/v1/itred_order_messages", token, row);
    let r = await post("tok-u1", { id:"m-1", purchase_order_id:order.id, body:"Is it in stock?" });
    assert.strictEqual(r.status, 201);
    r = await post("tok-u1", { id:"m-1", purchase_order_id:order.id, body:"Is it in stock?" });
    assert.strictEqual(r.status, 409, "a resend is refused, not doubled");
    assert.strictEqual((await post("tok-u2", { id:"m-2", purchase_order_id:order.id, body:"hi" })).status, 403);
    assert.strictEqual((await post("tok-u1", { id:"m-3", purchase_order_id:order.id, body:"hi", author:"vendor" })).status, 401);
    assert.strictEqual((await post("", { id:"m-4", purchase_order_id:order.id, body:"hi" })).status, 401);
    assert.strictEqual(fake.messages.length, 1);
    const reply = fake.vendorReply(order.id, "Yes, 2 left");
    const got = await call("GET", "/rest/v1/purchase_orders?select=id,itred_order_messages(id,author,body,created_at,customer_read_at)&customer_id=eq."+fake.users.get("u1@test.invalid").id, "tok-u1");
    assert.deepStrictEqual(got.json[0].itred_order_messages.map(m=> m.author), ["customer","vendor"]);
    await call("POST", "/rest/v1/rpc/itred_messages_read", "tok-u1", { p_order_id:order.id });
    assert.ok(reply.customer_read_at);
  });

  assert.deepStrictEqual(fake.unexpected, []);
  await browser.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
