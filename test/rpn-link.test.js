// Run: node --no-warnings test/rpn-link.test.js
// The verified RPN link in the app (src/rpn.js, server: supabase/migrations/
// 20261015120000_rpn_commissions.sql, tested in supabase/tests/
// rpn-commissions-test.js), over the REAL app source via the harness, with a
// fake Digital Commerce answering cl_device_checkin / cl_device_link_rpn /
// cl_device_rpn_status the way the server does:
//   * the field force number + PIN are checked on the form, saved, and sent
//     at once when online; offline they wait and go after the next check-in
//   * answers: linked (About shows "Onboarded by"), wrong number / PIN,
//     suspended, too many tries, conflict, not registered yet; the PIN is
//     deleted once the server has answered, and kept while it hasn't
//   * a link is sent once, not again on every check-in
//   * "Revenue Partner Network" everywhere in the app's own words
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeApp } = require("./harness");

let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}
function rig(o){
  return makeApp(Object.assign({ branch_name:"Boka", branch_type:"main", setup_complete:"1",
    install_id:"ABCD", secret_phrase:"Correct Horse", shop_name:"Boka General Dealer" }, o || {}));
}
const CHECKIN_OK = { vendor_id:"22222222-2222-4222-8222-222222222222", status:"onboarding", lock_cart:false, lock_add_product:false, lock_reason:null, messages:[] };
// A fake server: PINS { "RPN-014": ["123456", "Tendai"] }, plus suspended / conflict numbers.
function fakeServer(A, o){
  o = o || {};
  const calls = [];
  let linked = o.linked || null;
  A.hook("fetch", async (url, opts)=>{
    const name = String(url).split("/rpc/")[1];
    const body = JSON.parse(opts.body || "{}");
    calls.push({ name, body });
    if(o.down) throw new TypeError("Failed to fetch");
    const reply = (status, obj)=> ({ ok: status < 300, status, json: async()=>obj, text: async()=>JSON.stringify(obj) });
    if(name === "cl_device_checkin") return reply(200, CHECKIN_OK);
    if(o.unregistered) return reply(400, { code:"P0002", message:"This device is not registered yet" });
    if(name === "cl_device_link_rpn"){
      if(body.p_field_force_no === "RPN-014" && body.p_pin === "123456"){ linked = { rpn_name:"Tendai", field_force_no:"RPN-014" };
        return reply(200, { ok:true, status:"linked", rpn_name:"Tendai", field_force_no:"RPN-014", business:null }); }
      if(body.p_field_force_no === "RPN-016") return reply(200, { ok:false, code:"RPN_SUSPENDED", message:"That RPN isn't active at the moment. Ask Digital Commerce." });
      if(body.p_field_force_no === "RPN-020") return reply(200, { ok:false, code:"RPN_CONFLICT", message:"This business already has an RPN. Digital Commerce will check it." });
      if(body.p_field_force_no === "RPN-099") return reply(200, { ok:false, code:"RPN_TOO_MANY_TRIES", message:"Too many tries. Wait an hour, or ask Digital Commerce." });
      return reply(200, { ok:false, code:"RPN_NO_MATCH", message:"That field force number and PIN don't match. Check them with your RPN." });
    }
    if(name === "cl_device_rpn_status") return reply(200, { linked: !!linked, rpn_name: linked && linked.rpn_name, field_force_no: linked && linked.field_force_no, on_business:false, open_conflict:false });
    return reply(404, { message:"not faked: " + name });
  });
  return { calls, links: ()=> calls.filter((c)=> c.name === "cl_device_link_rpn") };
}

(async()=>{
  await t("the form: the field force number must look like RPN-014, the PIN must be 6 digits; nothing is saved otherwise", async ()=>{
    const A = rig();
    assert.match(A.api.requestRpnLink("14", "123456"), /field force number as it's printed, e\.g\. RPN-014/);
    assert.match(A.api.requestRpnLink("RPN-014", "12345"), /The RPN PIN is 6 digits/);
    assert.strictEqual(A.api.getSetting("rpn_link_pin", ""), "");
    assert.strictEqual(A.api.requestRpnLink(" rpn-014 ", "123456"), "", "lower case and spaces are fine");
    assert.strictEqual(A.api.getSetting("rpn_link_ff", ""), "RPN-014");
    assert.strictEqual(A.api.rpnLinkState().state, "pending");
  });

  await t("online: the link is sent with this device's install ID, phrase and device key; linked; the PIN is deleted; About says Onboarded by", async ()=>{
    const A = rig(); const S = fakeServer(A);
    A.api.requestRpnLink("RPN-014", "123456");
    const r = await A.api.trySendRpnLink();
    assert.strictEqual(r.sent, true);
    const b = S.links()[0].body;
    assert.deepStrictEqual(Object.keys(b).sort(), ["p_device_key", "p_field_force_no", "p_install_id", "p_pin", "p_secret_phrase"]);
    assert.strictEqual(b.p_install_id, "ABCD"); assert.strictEqual(b.p_secret_phrase, "Correct Horse"); assert.ok(b.p_device_key);
    const st = A.api.rpnLinkState();
    assert.strictEqual(st.state, "linked"); assert.strictEqual(st.name, "Tendai"); assert.strictEqual(st.pending, false, "the PIN is gone");
    assert.strictEqual(A.api.rpnOnboardedByText(), "Onboarded by: Tendai (RPN-014)");
    assert.match(A.api.licenceStatusCardHtml(), /id="rpnOnboardedLine"[^>]*>Onboarded by: Tendai \(RPN-014\)</);
    assert.match(A.api.rpnSectionHtml(), /✓ Onboarded by: Tendai \(RPN-014\)[\s\S]*To change your RPN, ask Digital Commerce/);
    assert.doesNotMatch(A.api.rpnSectionHtml(), /linkRpnBtn/, "no form once linked");
  });

  await t("offline: saved and waiting ('Saved. It will be checked when you're online.'); sent after the next check-in; once", async ()=>{
    const A = rig(); const S = fakeServer(A);
    A.ctx.navigator.onLine = false;
    A.api.requestRpnLink("RPN-014", "123456");
    assert.strictEqual((await A.api.trySendRpnLink()).sent, false);
    assert.strictEqual(S.links().length, 0, "nothing goes out offline");
    assert.match(A.api.rpnSectionHtml(), /Saved\. It will be checked when you(&#39;|')re online\./);
    assert.strictEqual(A.api.rpnLinkState().pending, true, "the PIN waits on the device");
    A.ctx.navigator.onLine = true;
    await A.api.deviceCheckin();
    await new Promise((r)=> setTimeout(r, 20));
    await A.api.trySendRpnLink();   // whatever the check-in started has finished
    assert.strictEqual(S.links().length, 1, "sent once, after the check-in");
    assert.strictEqual(A.api.rpnLinkState().state, "linked");
    await A.api.deviceCheckin(); await new Promise((r)=> setTimeout(r, 20));
    assert.strictEqual(S.links().length, 1, "not sent again by later check-ins");
  });

  await t("a dropped connection mid-send: it stays waiting with the PIN, and goes next time", async ()=>{
    const A = rig(); fakeServer(A, { down:true });
    A.api.requestRpnLink("RPN-014", "123456");
    assert.strictEqual((await A.api.trySendRpnLink()).sent, false);
    assert.strictEqual(A.api.rpnLinkState().state, "pending"); assert.strictEqual(A.api.rpnLinkState().pending, true);
    const S = fakeServer(A);
    await A.api.trySendRpnLink();
    assert.strictEqual(S.links().length, 1); assert.strictEqual(A.api.rpnLinkState().state, "linked");
  });

  for(const [ff, pin, state, text] of [
    ["RPN-014", "000000", "error", "That field force number and PIN don't match. Check them with your RPN."],
    ["RPN-777", "123456", "error", "That field force number and PIN don't match. Check them with your RPN."],
    ["RPN-016", "123456", "error", "That RPN isn't active at the moment. Ask Digital Commerce."],
    ["RPN-099", "123456", "error", "Too many tries. Wait an hour, or ask Digital Commerce."],
    ["RPN-020", "123456", "conflict", "This business already has an RPN. Digital Commerce will check it."]]){
    await t("refused (" + ff + "/" + pin + "): '" + text + "' shown; the PIN is deleted; the form is back", async ()=>{
      const A = rig(); fakeServer(A);
      A.api.requestRpnLink(ff, pin);
      await A.api.trySendRpnLink();
      const st = A.api.rpnLinkState();
      assert.strictEqual(st.state, state); assert.strictEqual(st.message, text); assert.strictEqual(st.pending, false);
      const html = A.api.rpnSectionHtml();
      assert.ok(html.includes(text.replace(/'/g, "&#39;")) || html.includes(text), html.slice(0, 300));
      assert.match(html, /id="linkRpnBtn"/, "they can try again");
    });
  }

  await t("not registered yet: kept with its PIN and the reason shown; sent after registration", async ()=>{
    const A = rig(); fakeServer(A, { unregistered:true });
    A.api.requestRpnLink("RPN-014", "123456");
    await A.api.trySendRpnLink();
    assert.strictEqual(A.api.rpnLinkState().pending, true);
    assert.match(A.api.rpnLinkState().message, /Finish registering this device first/);
    fakeServer(A);
    await A.api.trySendRpnLink();
    assert.strictEqual(A.api.rpnLinkState().state, "linked");
  });

  await t("no activation phrase yet: nothing is sent, the reason is shown", async ()=>{
    const A = rig({ secret_phrase:"" }); const S = fakeServer(A);
    A.api.requestRpnLink("RPN-014", "123456");
    await A.api.trySendRpnLink();
    assert.strictEqual(S.calls.length, 0);
    assert.match(A.api.rpnLinkState().message, /Finish registering this device first/);
  });

  await t("linked by Digital Commerce (staff assigned it): About picks it up from the server", async ()=>{
    const A = rig(); fakeServer(A, { linked:{ rpn_name:"Rudo", field_force_no:"RPN-015" } });
    assert.strictEqual(A.api.rpnOnboardedByText(), "");
    await A.api.refreshRpnStatus(true);
    assert.strictEqual(A.api.rpnOnboardedByText(), "Onboarded by: Rudo (RPN-015)");
  });

  await t("wording: 'Revenue Partner Network' in the app; 'Reseller' nowhere in src/ or the built app", async ()=>{
    const A = rig();
    assert.match(A.api.rpnSectionHtml(), /RPN \(Revenue Partner Network\)/);
    const hits = [];
    const walk = (d)=>{ for(const f of fs.readdirSync(d)){ const p = path.join(d, f); if(fs.statSync(p).isDirectory()) walk(p); else if(/\.(js|html|css|json|md)$/.test(f) && /Reseller/.test(fs.readFileSync(p, "utf8"))) hits.push(p); } };
    walk(path.join(__dirname, "..", "src"));
    for(const b of ["dist/index.html", "dist-pwa/index.html", "dist-tauri/index.html"]){
      const p = path.join(__dirname, "..", b);
      if(fs.existsSync(p) && /Reseller Partner/.test(fs.readFileSync(p, "utf8"))) hits.push(b);
    }
    assert.deepStrictEqual(hits, []);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
