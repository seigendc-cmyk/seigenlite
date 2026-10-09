// Run: node --no-warnings test/devicecheckin.test.js
// Digital Commerce Device Check-in (src/devicecheckin.js), over the REAL
// app source via the same harness the other suites use. Covers the network
// call itself (payload shape, success/failure handling, the offline/no-
// install-id skips) and the local state it persists (lock reasons, message
// dedup/dismiss) — NOT the UI-level lock enforcement (cartBtn/renderDrawer/
// desktopCartHtml/productModal), which needs real DOM and lives in
// test/devicecheckin-lock-e2e.test.js instead.
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
function rig(o){
  return makeApp(Object.assign({
    branch_name:"Boka", branch_type:"main", setup_complete:"1",
    install_id:"ABCD", secret_phrase:"Correct Horse", shop_name:"Boka General Dealer",
    contact_phone:"+263771234567",
  }, o||{}));
}
const sampleResponse = {
  vendor_id:"11111111-1111-1111-1111-111111111111",
  status:"active", lock_cart:false, lock_add_product:false, lock_reason:null,
  cycle_start_date:"2026-09-03", messages:[]
};

(async()=>{
  // ================= payload shape =================
  await t("sends the exact payload fields the RPC expects, with p_rpn_hint_id null (no RPN uuid is tracked locally)", async ()=>{
    const A = rig();
    let captured = null;
    A.hook("fetch", async (url, opts)=>{
      // after a check-in the app also asks for this shop's RPN (rpn.js); only the check-in is checked here
      if(!/cl_device_checkin$/.test(url)) return { ok:true, status:200, json: async()=>({}), text: async()=>"{}" };
      captured = { url, opts, body: JSON.parse(opts.body) };
      return { ok:true, json: async()=>sampleResponse };
    });
    await A.api.deviceCheckin();
    assert.strictEqual(captured.url, "https://urbopdsubwawtybwrxjd.supabase.co/rest/v1/rpc/cl_device_checkin");
    assert.strictEqual(captured.opts.method, "POST");
    assert.strictEqual(captured.opts.headers["Content-Type"], "application/json");
    assert.ok(captured.opts.headers.apikey, "apikey header present");
    assert.deepStrictEqual(captured.body, {
      p_install_id: "ABCD",
      p_shop_secret_phrase: "Correct Horse",
      p_device_code: A.api.currentDeviceCode(),
      p_business_name: "Boka General Dealer",
      p_owner_name: "",
      p_phone: "+263771234567",
      p_city: "",
      p_location: "Boka",
      p_rpn_hint_id: null,
      // multi-terminal Phase 1: this install's device_key (terminal.js), made once and reused
      p_device_key: A.api.getSetting("device_key",""),
      // build guard: the app build (sw-pwa.js "build: vN"), so the server can hold shared stock until every till runs v7+
      p_app_build: A.api.APP_BUILD
    });
    assert.ok(Number.isInteger(captured.body.p_app_build) && captured.body.p_app_build >= 8, "reports its build");
    assert.match(captured.body.p_device_key, /^[0-9a-f]{32}$/);
  });

  // ================= success persists lock state =================
  await t("a locked response persists lock_cart/lock_add_product/lock_reason, read back through dcLockCartReason/dcLockAddProductReason", async ()=>{
    const A = rig();
    A.hook("fetch", async ()=> ({ ok:true, json: async()=>Object.assign({}, sampleResponse, {
      lock_cart:true, lock_add_product:true, lock_reason:"Payment overdue since Sept 3", status:"overdue"
    }) }));
    await A.api.deviceCheckin();
    assert.strictEqual(A.api.dcLockCartReason(), "Payment overdue since Sept 3");
    assert.strictEqual(A.api.dcLockAddProductReason(), "Payment overdue since Sept 3");
    assert.strictEqual(A.api.getSetting("dc_vendor_status",""), "overdue");
  });

  await t("a locked response with no lock_reason falls back to a generic message, not a blank one", async ()=>{
    const A = rig();
    A.hook("fetch", async ()=> ({ ok:true, json: async()=>Object.assign({}, sampleResponse, {
      lock_cart:true, lock_reason:null
    }) }));
    await A.api.deviceCheckin();
    assert.strictEqual(A.api.dcLockCartReason(), "Contact Digital Commerce to reactivate");
  });

  await t("an unlocked response clears any previously-persisted lock", async ()=>{
    const A = rig({ dc_lock_cart:"1", dc_lock_reason:"old reason" });
    assert.strictEqual(A.api.dcLockCartReason(), "old reason", "starts locked");
    A.hook("fetch", async ()=> ({ ok:true, json: async()=>sampleResponse }));
    await A.api.deviceCheckin();
    assert.strictEqual(A.api.dcLockCartReason(), "", "cleared once the server reports unlocked");
  });

  // ================= message cards =================
  await t("messages from the response are stored locally and appear as pending", async ()=>{
    const A = rig();
    A.hook("fetch", async ()=> ({ ok:true, json: async()=>Object.assign({}, sampleResponse, {
      messages:[{ id:"m1", title:"Reminder", body:"Payment due Friday", created_at:"2026-09-20T10:00:00Z" }]
    }) }));
    await A.api.deviceCheckin();
    const pending = A.api.dcPendingMessages();
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].title, "Reminder");
    assert.strictEqual(pending[0].body, "Payment due Friday");
  });

  await t("the same message id returned again on a later check-in is never duplicated (server marks it delivered once)", async ()=>{
    const A = rig();
    A.hook("fetch", async ()=> ({ ok:true, json: async()=>Object.assign({}, sampleResponse, {
      messages:[{ id:"m1", title:"Reminder", body:"Payment due Friday", created_at:"2026-09-20T10:00:00Z" }]
    }) }));
    await A.api.deviceCheckin();
    await A.api.deviceCheckin(); // same server-side message, hypothetically resent
    assert.strictEqual(A.api.dcMessages().length, 1, "not duplicated");
  });

  await t("dismissing a message removes it from the pending list but keeps it in the full history", async ()=>{
    const A = rig();
    A.hook("fetch", async ()=> ({ ok:true, json: async()=>Object.assign({}, sampleResponse, {
      messages:[{ id:"m1", title:"Reminder", body:"Payment due Friday", created_at:"2026-09-20T10:00:00Z" }]
    }) }));
    await A.api.deviceCheckin();
    A.api.dcDismissMessage("m1");
    assert.strictEqual(A.api.dcPendingMessages().length, 0);
    assert.strictEqual(A.api.dcMessages().length, 1, "still in the record, just marked dismissed");
    assert.strictEqual(A.api.dcMessages()[0].dismissed, true);
  });

  await t("two different messages in one response both land, and dismissing one leaves the other pending", async ()=>{
    const A = rig();
    A.hook("fetch", async ()=> ({ ok:true, json: async()=>Object.assign({}, sampleResponse, {
      messages:[
        { id:"m1", title:"Reminder", body:"Payment due Friday", created_at:"2026-09-20T10:00:00Z" },
        { id:"m2", title:"Welcome", body:"Thanks for joining Digital Commerce", created_at:"2026-09-20T10:00:00Z" }
      ]
    }) }));
    await A.api.deviceCheckin();
    assert.strictEqual(A.api.dcPendingMessages().length, 2);
    A.api.dcDismissMessage("m1");
    const pending = A.api.dcPendingMessages();
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].id, "m2");
  });

  // ================= best-effort failure handling: never throws, never surfaces =================
  await t("offline: no fetch attempted at all, nothing thrown", async ()=>{
    const A = rig();
    A.ctx.navigator = { onLine:false };
    let fetchCalled = false;
    A.hook("fetch", async ()=>{ fetchCalled = true; return { ok:true, json: async()=>sampleResponse }; });
    await A.api.deviceCheckin();
    assert.strictEqual(fetchCalled, false, "isOnline() pre-filter skipped the call entirely");
  });

  await t("a fresh device with no install_id yet skips the call (nothing meaningful to report)", async ()=>{
    const A = rig({ install_id:"" });
    let fetchCalled = false;
    A.hook("fetch", async ()=>{ fetchCalled = true; return { ok:true, json: async()=>sampleResponse }; });
    await A.api.deviceCheckin();
    assert.strictEqual(fetchCalled, false);
  });

  await t("a network error (fetch rejects) is swallowed silently — no throw, no alert, settings untouched", async ()=>{
    const A = rig();
    let alerted = "";
    A.hook("alert", (m)=>{ alerted = m; });
    A.hook("fetch", async ()=>{ throw new Error("getaddrinfo ENOTFOUND"); });
    await A.api.deviceCheckin(); // must not reject
    assert.strictEqual(alerted, "", "the shop user is never shown a sync failure");
    assert.strictEqual(A.api.dcLockCartReason(), "");
  });

  await t("a non-OK server response (e.g. RLS/auth rejection) is skipped silently — settings untouched", async ()=>{
    const A = rig({ dc_lock_cart:"", dc_lock_reason:"" });
    A.hook("fetch", async ()=> ({ ok:false, status:401, text: async()=>"invalid secret phrase" }));
    await A.api.deviceCheckin();
    assert.strictEqual(A.api.dcLockCartReason(), "", "no lock applied off a rejected/unverified response");
  });

  await t("a real AbortSignal is wired to the request, so a stuck fetch is actually abortable (not just a bare fetch with no timeout at all)", async ()=>{
    const A = rig();
    let sawSignal = null;
    A.hook("fetch", async (url, opts)=>{ sawSignal = opts.signal; return { ok:true, json: async()=>sampleResponse }; });
    await A.api.deviceCheckin();
    assert.ok(sawSignal, "an AbortSignal was actually passed to fetch, not left undefined");
    assert.strictEqual(typeof sawSignal.addEventListener, "function", "it's a real AbortSignal (or equivalent), abortable by the internal ~8s timeout");
  });

  // ================= registration + result reasons =================
  await t("a successful check-in marks the device registered (dc_vendor_id), clears the last error and resolves ok", async ()=>{
    const A = rig({ dc_checkin_error:"old failure" });
    assert.strictEqual(A.api.dcIsRegistered(), false);
    A.hook("fetch", async ()=> ({ ok:true, json: async()=>sampleResponse }));
    const r = await A.api.deviceCheckin();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok:true, reason:"registered" });
    assert.strictEqual(A.api.getSetting("dc_vendor_id",""), sampleResponse.vendor_id);
    assert.strictEqual(A.api.getSetting("dc_checkin_error",""), "");
    assert.ok(A.api.getSetting("dc_checkin_ok_ts",""));
    assert.strictEqual(A.api.dcIsRegistered(), true);
  });

  await t("no secret phrase: no fetch (the server would refuse it), reason no_phrase, advice says where to enter it", async ()=>{
    const A = rig({ secret_phrase:"  " });
    let fetchCalled = false;
    A.hook("fetch", async ()=>{ fetchCalled = true; return { ok:true, json: async()=>sampleResponse }; });
    const r = await A.api.deviceCheckin();
    assert.strictEqual(fetchCalled, false);
    assert.strictEqual(r.reason, "no_phrase");
    assert.match(A.api.dcCheckinProblemText(r), /activation secret phrase.*Settings/);
  });

  await t("a rejection keeps the server's message (JSON or text) for Settings/Marketing, without alerting or registering", async ()=>{
    const A = rig();
    let alerted = "";
    A.hook("alert", (m)=>{ alerted = m; });
    A.hook("fetch", async ()=> ({ ok:false, status:400, text: async()=>JSON.stringify({ code:"P0001", message:"Shop secret phrase does not match this install" }) }));
    const r = await A.api.deviceCheckin();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "rejected");
    assert.strictEqual(A.api.getSetting("dc_checkin_error",""), "Shop secret phrase does not match this install");
    assert.strictEqual(A.api.dcIsRegistered(), false);
    assert.strictEqual(alerted, "");
    assert.match(A.api.dcCheckinProblemText(r), /different activation phrase/);
  });

  await t("offline and network failures resolve with a reason instead of rejecting", async ()=>{
    const A = rig();
    A.ctx.navigator = { onLine:false };
    assert.strictEqual((await A.api.deviceCheckin()).reason, "offline");
    A.ctx.navigator = { onLine:true };
    A.hook("fetch", async ()=>{ throw new Error("boom"); });
    const r = await A.api.deviceCheckin();
    assert.strictEqual(r.reason, "network");
    assert.match(A.api.dcCheckinProblemText(r), /Connect to the internet/);
    assert.strictEqual(A.api.dcCheckinProblemText({ reason:"registered" }), "");
  });

  await t("overlapping check-ins (boot + end of setup + Save phrase) share one request", async ()=>{
    const A = rig();
    let calls = 0, release;
    A.hook("fetch", (url)=>{
      if(!/cl_device_checkin$/.test(url)) return Promise.resolve({ ok:true, status:200, json: async()=>({}), text: async()=>"{}" });   // the RPN status call after it (rpn.js)
      calls++; return new Promise(res=>{ release = ()=>res({ ok:true, json: async()=>sampleResponse }); }); });
    const p1 = A.api.deviceCheckin(), p2 = A.api.deviceCheckin();
    await new Promise(r=>setTimeout(r, 10));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(calls, 1);
    assert.ok(r1.ok && r2.ok);
    const p3 = A.api.deviceCheckin(); // a later one is a fresh request
    await new Promise(r=>setTimeout(r, 10));
    release(); await p3;
    assert.strictEqual(calls, 2);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
