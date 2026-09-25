// Shared by the Playwright suites: keeps every browser test away from
// Digital Commerce's live Supabase project. Setup now takes the activation
// phrase and checks in as soon as it finishes, so without this each test
// run would register a made-up shop on the real server.
//
// stubDigitalCommerce(target, opts) — target is a Page or BrowserContext
// (use the context when a service worker is involved: Chromium routes a
// worker's requests through context.route only).
//   opts.phrase   — the phrase the fake server accepts (default: any)
//   opts.offline  — () => boolean; true makes the check-in fail as unreachable
// Returns { calls } — the JSON bodies of every check-in the app sent.
"use strict";
const DC_HOST = /urbopdsubwawtybwrxjd\.supabase\.co/;
const TEST_PHRASE = "Test Activation Phrase";

async function stubDigitalCommerce(target, opts){
  opts = opts || {};
  const calls = [];
  await target.route(DC_HOST, async route => {
    const req = route.request();
    if(!/\/rpc\/cl_device_checkin$/.test(req.url())) return route.abort(); // cloud sync etc.: never reach the live project
    let body = {};
    try{ body = JSON.parse(req.postData() || "{}"); }catch(e){}
    calls.push(body);
    if(opts.offline && opts.offline()) return route.abort("internetdisconnected");
    const want = typeof opts.phrase === "function" ? opts.phrase() : opts.phrase;
    if(want && body.p_shop_secret_phrase !== want)
      return route.fulfill({ status:400, contentType:"application/json",
        body: JSON.stringify({ code:"P0001", message:"Shop secret phrase does not match this install" }) });
    return route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify({
      vendor_id:"22222222-2222-4222-8222-222222222222", status:"active",
      lock_cart:false, lock_add_product:false, lock_reason:null, cycle_start_date:"2026-09-01", messages:[] }) });
  });
  return { calls };
}

module.exports = { stubDigitalCommerce, TEST_PHRASE };
