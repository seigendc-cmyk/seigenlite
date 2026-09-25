// Run: node --no-warnings test/itred-fulfilment-fake.test.js
// The fake Supabase's side of 20260925120000_itred_po_fulfilment.sql:
// customers record quantity_fulfilled on their own order lines and the
// order's status follows. Requests go through a real browser's fetch()
// (Playwright) at the fake, exactly as the site's own PostgREST calls do,
// so the fake answers them the same way it will for the fulfilment modal.
// The SQL itself is proven in supabase/tests/itred-live-test.js (PGlite /
// live); this keeps the fake honest to it.
"use strict";
const assert = require("assert");
const { createFakeSupabase, listingRow, PROJECT } = require("./itred-fake-supabase");

let chromium;
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
  const order = { id:"po-1", customer_id:u1.id, vendor_id:vendorId, status:"sent", pdf_url:null, created_at:new Date().toISOString() };
  fake.orders.push(order);
  const line = (id, qty, custom)=>({ id, purchase_order_id:order.id, vendor_listing_id: custom? null : listing.id, item_name: custom? "Gas 9kg" : "Sugar 2kg",
    unit_price: custom? null : 3.5, currency: custom? null : "USD", quantity_requested:qty, quantity_fulfilled:0, is_custom_request:!!custom,
    fulfillment_status:"outstanding", created_at:new Date().toISOString() });
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
  const patch = (token, query, body)=> page.evaluate(async ({ url, token, body })=>{
    const r = await fetch(url, { method:"PATCH", headers:{ "Authorization":"Bearer "+token, "Content-Type":"application/json", "Prefer":"return=representation" }, body: JSON.stringify(body) });
    return { status:r.status, json: await r.json().catch(()=>null) };
  }, { url: PROJECT+"/rest/v1/purchase_order_items?"+query, token, body });
  const use = (r)=>{ fake = r.fake; return r; };

  await t("a customer records fulfilment line by line and the order's status follows", async ()=>{
    const { order, listed, custom } = use(rig());
    let r = await patch("tok-u1", "id=eq."+listed.id, { quantity_fulfilled:1 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json[0].fulfillment_status, "partially_fulfilled");
    assert.strictEqual(order.status, "partially_fulfilled");
    await patch("tok-u1", "id=eq."+listed.id, { quantity_fulfilled:2 });
    assert.strictEqual(order.status, "partially_fulfilled", "the custom line is still outstanding");
    await patch("tok-u1", "id=eq."+custom.id, { quantity_fulfilled:1 });
    assert.strictEqual(order.status, "fulfilled");
    await patch("tok-u1", "purchase_order_id=eq."+order.id, { quantity_fulfilled:0 });
    assert.strictEqual(order.status, "sent", "correcting back to nothing re-derives sent");
  });

  await t("out-of-range quantities are rejected and change nothing", async ()=>{
    const { order, listed } = use(rig());
    let r = await patch("tok-u1", "id=eq."+listed.id, { quantity_fulfilled:3 });
    assert.strictEqual(r.status, 400); assert.ok(/not_overfulfilled/.test(r.json.message));
    r = await patch("tok-u1", "id=eq."+listed.id, { quantity_fulfilled:-1 });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(listed.quantity_fulfilled, 0); assert.strictEqual(order.status, "sent");
  });

  await t("only quantity_fulfilled is writable", async ()=>{
    const { listed } = use(rig());
    for(const body of [{ quantity_requested:9 }, { unit_price:0 }, { quantity_fulfilled:1, item_name:"x" }]){
      const r = await patch("tok-u1", "id=eq."+listed.id, body);
      assert.strictEqual(r.status, 401, JSON.stringify(body));
    }
    assert.strictEqual(listed.quantity_fulfilled, 0);
    assert.strictEqual(listed.quantity_requested, 2);
  });

  await t("another customer, or nobody signed in, can't touch the order's lines", async ()=>{
    const { order, listed } = use(rig());
    const r = await patch("tok-u2", "id=eq."+listed.id, { quantity_fulfilled:1 });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json, []);
    const anon = await patch("", "id=eq."+listed.id, { quantity_fulfilled:1 });
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(listed.quantity_fulfilled, 0); assert.strictEqual(order.status, "sent");
  });

  await t("a closed order stays closed when fulfilment is recorded afterwards", async ()=>{
    const { order, listed } = use(rig());
    order.status = "closed";
    await patch("tok-u1", "id=eq."+listed.id, { quantity_fulfilled:2 });
    assert.strictEqual(listed.fulfillment_status, "fulfilled");
    assert.strictEqual(order.status, "closed");
  });

  assert.deepStrictEqual(fake.unexpected, []);
  await browser.close();
  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
