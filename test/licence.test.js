// Run: node --no-warnings test/licence.test.js
//
// Activation v2 (src/activation.js) in the REAL app code (test/harness.js):
// signed licences, device binding, expiry under the trusted clock, reuse,
// the Q8 trial rule, old-style codes until the cutoff, short-code redemption
// and check-in delivery (RPC faked), the backup-restore fix, the orange-note
// rules, the Q9 number and the Q12 formula check.
// Licences here are signed with a throwaway test key (key ID 9), laid out
// exactly as cl_licence_prepare builds them (supabase/tests/activation-licences-test.js
// proves the database, the Edge Function signer and this verifier agree).
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { makeApp } = require("./harness");

const ROOT = path.join(__dirname, "..");
const KID = 9;
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUB = publicKey.export({ format:"der", type:"spki" }).subarray(-32).toString("base64");
const EPOCH = Date.UTC(2026,0,1), DAY = 86400000;
const dayOf = (iso)=> Math.floor((Date.parse(iso)-EPOCH)/DAY);
const NOW = "2026-10-08T10:00:00Z";
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// A licence laid out as the server builds it.
function lic(o){
  const h = crypto.createHash("sha512").update(o.deviceKey, "utf8").digest();
  const strong = o.strong!==false;
  const binding = strong? h.subarray(0,8) : Buffer.from([h[0], h[1], h[2]&0xF0, 0,0,0,0,0]);
  const biz = o.businessId? Buffer.from(o.businessId.replace(/-/g,""), "hex") : Buffer.alloc(0);
  const p = Buffer.alloc(30 + biz.length);
  p[0] = 2; p[1] = o.kid||KID; p.writeUInt32BE(o.serial||1001, 2);
  Buffer.from(o.install, "latin1").copy(p, 6);
  binding.copy(p, 14);
  p.writeUInt16BE(dayOf(o.issued||NOW), 22); p.writeUInt16BE(dayOf(o.until), 24);
  p[26] = 0; p[27] = (strong?1:0) | (biz.length?2:0); p.writeUInt16BE(0, 28);
  biz.copy(p, 30);
  const sig = crypto.sign(null, p, o.priv||privateKey);
  const all = Buffer.concat([p, sig]);
  if(o.tamper) all[o.tamper] ^= 1;
  return "SL2." + all.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
function app(extra){
  const A = makeApp(Object.assign({ install_id:"ABCD", device_key:KEY, install_date:"2026-10-01T08:00:00Z", secret_phrase:"shop-secret" }, extra||{}));
  A.api.LICENCE_PUBLIC_KEYS[KID] = PUB;
  return A;
}
const at = (A, iso)=> A.api.establishTrustedTime(new Date(iso));
const plain = (x)=> JSON.parse(JSON.stringify(x));

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}

(async()=>{
  console.log("the vendored verifier");
  await t("src/vendor/tweetnacl-fast.min.js is byte-for-byte the audited npm tweetnacl@1.0.3 file", async ()=>{
    const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT,"src","vendor","tweetnacl-fast.min.js"))).digest("hex");
    assert.strictEqual(sha, "3ec535c004aeeb225785d8e93fb33bf99f52e399bd7dfc01969b5629baea5131");
    assert.ok(fs.readFileSync(path.join(ROOT,"src","vendor","README.md"),"utf8").includes(sha));
  });
  await t("build.js ships it outside the obfuscated app code, and no CDN script is added for it", async ()=>{
    const b = fs.readFileSync(path.join(ROOT,"build.js"),"utf8");
    assert.ok(/VENDOR_SCRIPTS = \["vendor\/tweetnacl-fast.min.js"\]/.test(b));
    assert.ok(/headMid \+\s*vendorJS \+\s*appJS/.test(b));
    assert.ok(!/tweetnacl/i.test(fs.readFileSync(path.join(ROOT,"shell","head-mid.html"),"utf8")));
  });
  await t("the shipped public key is key ID 1, and the private key is nowhere in the repo", async ()=>{
    const A = makeApp({});
    assert.deepStrictEqual(Object.keys(plain(A.api.LICENCE_PUBLIC_KEYS)), ["1"]);
    const k = path.join("C:\\seigen-keys","licence-signing-key-1.json");
    if(fs.existsSync(k)){
      const priv = JSON.parse(fs.readFileSync(k,"utf8")).private_pkcs8_b64;
      assert.strictEqual(JSON.parse(fs.readFileSync(k,"utf8")).public_key_b64, A.api.LICENCE_PUBLIC_KEYS[1], "the app's key 1 matches the key file");
      const { execSync } = require("child_process");
      const hits = execSync("git grep -l -F -e " + JSON.stringify(priv.slice(16, 48)) + " || true", { cwd:ROOT, encoding:"utf8" }).trim();
      assert.strictEqual(hits, "", "a piece of the private key appears in tracked files: "+hits);
    }
  });

  console.log("licences");
  await t("a valid licence activates: status ok, source licence, until the end of its day (Harare)", async ()=>{
    const A = app(); await at(A, NOW);
    const r = await A.api.applyLicence(lic({ install:"ABCD", deviceKey:KEY, until:"2026-11-07T00:00:00Z" }), "paste");
    assert.ok(r.ok, JSON.stringify(r));
    const st = plain(A.api.licenceState());
    assert.strictEqual(st.status, "ok"); assert.strictEqual(st.source, "licence");
    assert.strictEqual(new Date(st.untilMs).toISOString(), "2026-11-07T22:00:00.000Z");
    assert.strictEqual(A.api.getSetting("activated_until"), "2026-11-07T22:00:00.000Z", "mirrored for a rollback to v10");
    assert.strictEqual(A.api.getSetting("activated_until_src"), "licence");
    assert.ok(A.api.all("SELECT action,details FROM audit_log WHERE action='Licence activated'").length===1);
  });
  await t("a tampered payload, a tampered signature, a cut-off or garbled licence: invalid", async ()=>{
    const A = app(); await at(A, NOW);
    for(const bad of [lic({ install:"ABCD", deviceKey:KEY, until:"2026-11-07T00:00:00Z", tamper:5 }),
                      lic({ install:"ABCD", deviceKey:KEY, until:"2026-11-07T00:00:00Z", tamper:40 }),
                      lic({ install:"ABCD", deviceKey:KEY, until:"2026-11-07T00:00:00Z" }).slice(0,-10),
                      "SL2.not-a-licence", "SL2."]){
      const r = await A.api.applyLicence(bad, "paste");
      assert.strictEqual(r.reason, "invalid", bad.slice(0,30)+" -> "+JSON.stringify(r));
    }
    // signed by another key under our key ID
    const other = crypto.generateKeyPairSync("ed25519").privateKey;
    assert.strictEqual((await A.api.applyLicence(lic({ install:"ABCD", deviceKey:KEY, until:"2026-11-07T00:00:00Z", priv:other }), "paste")).reason, "invalid");
    assert.strictEqual(A.api.activationStatus(), "ok", "still on its trial; nothing was stored");
    assert.strictEqual(A.api.getSetting("licence"), "");
  });
  await t("another device: wrong install ID, or the same install ID with another device key", async ()=>{
    const A = app(); await at(A, NOW);
    let r = await A.api.applyLicence(lic({ install:"WXYZ", deviceKey:KEY, until:"2026-11-07T00:00:00Z" }), "paste");
    assert.strictEqual(r.reason, "other_device");
    r = await A.api.applyLicence(lic({ install:"ABCD", deviceKey:"ffffffffffffffffffffffffffffffff", until:"2026-11-07T00:00:00Z" }), "paste");
    assert.strictEqual(r.reason, "other_device");
    assert.match(A.api.licenceProblemText(r), /for another device.*This device is ABCD-[A-HJ-NP-Z2-9]{4}/);
  });
  await t("a weak (tag-only) binding works on the right device and not on a device with another tag", async ()=>{
    const A = app(); await at(A, NOW);
    assert.ok((await A.api.applyLicence(lic({ install:"ABCD", deviceKey:KEY, strong:false, until:"2026-11-07T00:00:00Z" }), "paste")).ok);
    let other = "x"; let i = 0;
    do { other = "k"+(i++); } while(tagOf(other)===tagOf(KEY));
    const B = app({ device_key:other }); await at(B, NOW);
    assert.strictEqual((await B.api.applyLicence(lic({ install:"ABCD", deviceKey:KEY, strong:false, until:"2026-11-07T00:00:00Z" }), "paste")).reason, "other_device");
  });
  await t("an expired licence is refused", async ()=>{
    const A = app(); await at(A, NOW);
    const r = await A.api.applyLicence(lic({ install:"ABCD", deviceKey:KEY, issued:"2026-09-01T00:00:00Z", until:"2026-10-01T00:00:00Z" }), "paste");
    assert.strictEqual(r.reason, "expired");
    assert.match(A.api.licenceProblemText(r), /expired on 1 Oct 2026./, "the last valid day, not the next");
  });
  await t("clock moved back after the licence ran out: still locked (trusted clock)", async ()=>{
    const A = app({ install_date:"2026-08-01T08:00:00Z" }); await at(A, "2026-08-25T10:00:00Z");
    assert.ok((await A.api.applyLicence(lic({ install:"ABCD", deviceKey:KEY, issued:"2026-08-25T00:00:00Z", until:"2026-09-24T00:00:00Z" }), "paste")).ok);
    await at(A, "2026-09-26T10:00:00Z");
    assert.strictEqual(A.api.activationStatus(), "locked", "expired after its last day");
    const c = await at(A, "2026-09-20T10:00:00Z");   // rolled back into the licence's days
    assert.strictEqual(c.anomaly, "rollback");
    assert.strictEqual(A.api.activationStatus(), "locked", "rolling the clock back doesn't revive it");
  });
  await t("re-use: a used serial is refused; an older licence is refused while a newer one runs; the same one again is fine", async ()=>{
    const A = app(); await at(A, NOW);
    const l10 = lic({ install:"ABCD", deviceKey:KEY, serial:10, until:"2026-11-07T00:00:00Z" });
    const l11 = lic({ install:"ABCD", deviceKey:KEY, serial:11, until:"2026-12-07T00:00:00Z" });
    assert.ok((await A.api.applyLicence(l10, "paste")).ok);
    assert.ok((await A.api.applyLicence(l11, "paste")).ok);
    assert.strictEqual((await A.api.applyLicence(l10, "paste")).reason, "used");
    assert.strictEqual((await A.api.applyLicence(lic({ install:"ABCD", deviceKey:KEY, serial:9, until:"2026-12-30T00:00:00Z" }), "paste")).reason, "older");
    assert.strictEqual((await A.api.applyLicence(l11, "link")).already, true);
    assert.strictEqual(A.api.currentLicence().serial, 11);
  });
  await t("an unknown key ID asks for an app update", async ()=>{
    const A = app(); await at(A, NOW);
    const r = await A.api.applyLicence(lic({ install:"ABCD", deviceKey:KEY, kid:200, until:"2026-11-07T00:00:00Z" }), "paste");
    assert.strictEqual(r.reason, "unknown_key");
    assert.match(A.api.licenceProblemText(r), /newer version of the app/);
  });
  await t("a licence's signed issue date moves the trusted clock forward", async ()=>{
    const A = app({ install_date:"2026-09-01T08:00:00Z" }); await at(A, "2026-09-05T10:00:00Z");
    assert.ok((await A.api.applyLicence(lic({ install:"ABCD", deviceKey:KEY, issued:"2026-10-08T00:00:00Z", until:"2026-11-07T00:00:00Z" }), "paste")).ok);
    assert.ok(A.api.trustedNow().getTime() >= Date.parse("2026-10-08T00:00:00Z"));
    assert.ok(Date.parse(A.api.getSetting("trusted_time_hwm")) >= Date.parse("2026-10-08T00:00:00Z"));
  });
  await t("one box: a whole activation link, a long licence, a short code and an old code are told apart", async ()=>{
    const A = app(); await at(A, NOW);
    const l = lic({ install:"ABCD", deviceKey:KEY, until:"2026-11-07T00:00:00Z" });
    assert.strictEqual(A.api.classifyActivationInput("https://mobilepos.seigendc.workers.dev/#lic="+l).kind, "licence");
    assert.strictEqual(A.api.classifyActivationInput(" k7q2-9xmb-3h ").kind, "short");
    assert.strictEqual(A.api.classifyActivationInput("AR9W21").kind, "legacy");
    assert.strictEqual(A.api.classifyActivationInput("hello").kind, "bad");
    assert.ok((await A.api.activateFromInput("Tap this: https://mobilepos.seigendc.workers.dev/#lic="+l+" thanks", "paste")).ok);
  });

  console.log("old-style codes (until the cutoff)");
  const legacyCode = (A)=> A.api.computeActivationCode(A.api.currentDeviceCode(), "shop-secret");
  await t("accepted before the cutoff (30 days after this version first ran)", async ()=>{
    const A = app({ install_date:"2026-08-01T08:00:00Z", licence_v2_since:"2026-10-01T08:00:00Z" }); await at(A, NOW);
    assert.strictEqual(A.api.activationStatus(), "locked");
    const r = await A.api.activateFromInput(legacyCode(A), "paste");
    assert.ok(r.ok && r.legacy, JSON.stringify(r));
    assert.strictEqual(A.api.activationStatus(), "ok");
    assert.strictEqual(plain(A.api.licenceState()).source, "legacy");
  });
  await t("refused from the cutoff on, with a plain message", async ()=>{
    const A = app({ install_date:"2026-08-01T08:00:00Z", licence_v2_since:"2026-09-08T09:59:00Z" }); await at(A, NOW);
    const r = await A.api.activateFromInput(legacyCode(A), "paste");
    assert.strictEqual(r.reason, "legacy_closed");
    assert.match(A.api.licenceProblemText(r), /old-style code, which is no longer accepted.*\+263789487287/);
    assert.strictEqual(A.api.activationStatus(), "locked");
  });
  await t("an old code entered before the cutoff runs its 30 days; after the legacy horizon, activated_until counts for nothing", async ()=>{
    const A = app({ install_date:"2026-06-01T08:00:00Z", activated_until:"2027-01-01T00:00:00Z", activated_until_src:"code", licence_v2_since:"2026-09-01T08:00:00Z" });
    await at(A, "2026-10-30T10:00:00Z");
    assert.strictEqual(A.api.activationStatus(), "ok", "before the horizon (cutoff 1 Oct + 30 days)");
    await at(A, "2026-11-01T10:00:00Z");
    assert.strictEqual(A.api.activationStatus(), "locked", "after the horizon, an edited activated_until is ignored");
  });
  await t("a v10 device's activated_until (no source recorded) is honoured until it ends", async ()=>{
    const A = app({ install_date:"2026-08-01T08:00:00Z", activated_until:"2026-10-20T08:00:00Z" }); await at(A, NOW);
    assert.strictEqual(A.api.activationStatus(), "ok");
    await at(A, "2026-10-21T08:00:00Z");
    assert.strictEqual(A.api.activationStatus(), "locked");
  });

  console.log("the trial (Q8): from the earliest business data");
  const sale = (A, ts)=> A.api.run("INSERT INTO sales(ts,total) VALUES(?,1)", [ts]);
  await t("a fresh install: 30 days from the install date", async ()=>{
    const A = app({ install_date:NOW, activated_until:"2026-11-07T10:00:00Z", activated_until_src:"setup" }); await at(A, NOW);
    const st = plain(A.api.licenceState());
    assert.strictEqual(st.source, "trial"); assert.strictEqual(new Date(st.untilMs).toISOString(), "2026-11-07T10:00:00.000Z");
  });
  await t("installed today, but the database has a sale from 40 days ago: no trial left (setup's activated_until doesn't count)", async ()=>{
    const A = app({ install_date:NOW, activated_until:"2026-11-07T10:00:00Z", activated_until_src:"setup" }); await at(A, NOW);
    sale(A, "2026-08-29T09:00:00.000Z");
    assert.strictEqual(new Date(A.api.trialStartMs()).toISOString(), "2026-08-29T09:00:00.000Z");
    assert.strictEqual(A.api.activationStatus(), "locked");
  });
  await t("each kind of business data counts: a stock movement, a receipt, an adjustment, a product created", async ()=>{
    for(const [sql, args] of [
      ["INSERT INTO stock_movements(qty_delta,kind,ts) VALUES(1,'receive',?)", ["2026-09-01T00:00:00Z"]],
      ["INSERT INTO stock_received(ts,qty) VALUES(?,1)", ["2026-09-01T00:00:00Z"]],
      ["INSERT INTO stock_adjustments(ts,qty_delta) VALUES(?,1)", ["2026-09-01T00:00:00Z"]],
      ["INSERT INTO products(name,created_ts) VALUES('Rice',?)", ["2026-09-01T00:00:00Z"]]]){
      const A = app({ install_date:NOW }); await at(A, NOW);
      A.api.run(sql, args);
      assert.strictEqual(A.api.activationStatus(), "locked", sql);
    }
    const B = app({ install_date:NOW }); await at(B, NOW);
    B.api.run("INSERT INTO products(name,created_ts) VALUES('Rice',?)", ["2026-09-28T10:00:00Z"]);
    assert.strictEqual(plain(B.api.licenceState()).source, "trial", "10 days of history: 20 days of trial left");
    assert.strictEqual(new Date(B.api.trialEndMs()).toISOString(), "2026-10-28T10:00:00.000Z");
    B.api.run("INSERT INTO sales(ts,total) VALUES('not a date',1)");
    B.api.run("INSERT INTO sales(ts,total) VALUES('1970-01-01T00:00:00Z',1)");
    assert.strictEqual(new Date(B.api.trialEndMs()).toISOString(), "2026-10-28T10:00:00.000Z", "junk timestamps are ignored");
  });
  await t("reinstall + restore: a fresh device that restores a backup with 45 days of history is locked at once", async ()=>{
    const OLD = app({ install_id:"OLD1", device_key:"0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld00", install_date:"2026-08-24T08:00:00Z", branch_name:"Shop", branch_type:"main", setup_complete:"1",
      trusted_time_hwm:"2026-09-30T08:00:00.000Z", activated_until:"2026-11-30T00:00:00Z", activated_until_src:"code" });
    OLD.api.run("INSERT INTO sales(ts,total) VALUES('2026-08-24T09:00:00.000Z',5)");
    const NEW = app({ install_id:"NEW1", device_key:KEY, install_date:NOW, branch_name:"Shop", branch_type:"main", setup_complete:"1",
      activated_until:"2026-11-07T10:00:00Z", activated_until_src:"setup" });
    await at(NEW, NOW);
    assert.strictEqual(NEW.api.activationStatus(), "ok", "on its trial before the restore");
    NEW.hook("downloadDb",()=>{}); NEW.hook("render",()=>{}); NEW.hook("alert",()=>{});
    NEW.hook("readFileBytes", async ()=>Object.assign(new Uint8Array([1]),{__db:OLD.db}));
    await NEW.api.onReplacePicked({ name:"backup.sqlite", bytes:new Uint8Array([1]) });
    assert.strictEqual(NEW.api.one("SELECT COUNT(*) n FROM sales").n, 1, "the data came across");
    assert.strictEqual(NEW.api.getSetting("install_id"), "NEW1", "its own install ID");
    assert.strictEqual(NEW.api.getSetting("device_key"), KEY, "its own device key");
    assert.strictEqual(NEW.api.getSetting("activated_until_src"), "setup", "not the backup's old-code activation");
    assert.strictEqual(NEW.api.activationStatus(), "locked", "45 days of history: no new trial");
    assert.strictEqual(NEW.api.licenceLocked(), true, "the render guard knows");
  });
  await t("restore keeps this device's licence and the higher clock watermark", async ()=>{
    const A = app({ branch_name:"Shop", branch_type:"main", setup_complete:"1" }); await at(A, NOW);
    assert.ok((await A.api.applyLicence(lic({ install:"ABCD", deviceKey:KEY, serial:77, until:"2026-12-01T00:00:00Z" }), "paste")).ok);
    const FILE = app({ install_id:"ZZZZ", device_key:"zz", branch_name:"Shop", branch_type:"main", setup_complete:"1", trusted_time_hwm:"2026-01-01T00:00:00.000Z",
      licence:"SL2.someone-elses", install_date:"2026-01-01T00:00:00Z" });
    A.hook("downloadDb",()=>{}); A.hook("render",()=>{}); A.hook("alert",()=>{});
    A.hook("readFileBytes", async ()=>Object.assign(new Uint8Array([1]),{__db:FILE.db}));
    const hwm = A.api.getSetting("trusted_time_hwm");
    await A.api.onReplacePicked({ name:"old.sqlite", bytes:new Uint8Array([1]) });
    assert.strictEqual(A.api.currentLicence().serial, 77, "the device's own licence");
    assert.strictEqual(A.api.getSetting("install_id"), "ABCD");
    assert.strictEqual(A.api.getSetting("trusted_time_hwm"), hwm, "the old file's older watermark didn't win");
    assert.strictEqual(A.api.activationStatus(), "ok");
  });

  console.log("short codes and check-in delivery (RPC faked)");
  await t("a short code: sent with the device's auth, the returned licence is checked and stored", async ()=>{
    const A = app({ dc_vendor_id:"v1" }); await at(A, NOW);
    let sent = null;
    A.hook("terminalRpc", async (name, body)=>{ sent = { name, body }; return { ok:true, data:{ licence: lic({ install:"ABCD", deviceKey:KEY, serial:300, until:"2026-11-07T00:00:00Z" }) } }; });
    const r = await A.api.activateFromInput("K7Q2-9XMB-3H", "paste");
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(sent.name, "cl_licence_redeem");
    assert.strictEqual(sent.body.p_code, "K7Q29XMB3H");
    assert.strictEqual(sent.body.p_install_id, "ABCD"); assert.strictEqual(sent.body.p_device_key, KEY); assert.strictEqual(sent.body.p_secret_phrase, "shop-secret");
  });
  await t("a short code while offline: the offline message, nothing sent", async ()=>{
    const A = app({ dc_vendor_id:"v1" }); await at(A, NOW);
    let calls = 0; A.hook("terminalRpc", async ()=>{ calls++; return { ok:false, reason:"offline" }; });
    A.ctx.navigator.onLine = false;
    const r = await A.api.activateFromInput("K7Q2-9XMB-3H", "paste");
    assert.strictEqual(r.reason, "offline"); assert.strictEqual(calls, 0);
    assert.match(A.api.licenceProblemText(r), /You're offline\. A short code needs the internet/);
  });
  await t("server refusals become plain reasons: used, wrong device, too many tries, invalid, revoked, expired", async ()=>{
    const A = app({ dc_vendor_id:"v1" }); await at(A, NOW);
    for(const [code, reason] of [["ALREADY_USED","used"],["WRONG_DEVICE","other_device"],["TOO_MANY_TRIES","too_many"],["INVALID_CODE","invalid"],["REVOKED","revoked"],["EXPIRED","expired"]]){
      A.hook("terminalRpc", async ()=>({ ok:false, reason:"refused", code }));
      const r = await A.api.activateFromInput("K7Q2-9XMB-3H", "paste");
      assert.strictEqual(r.reason, reason, code);
      assert.ok(A.api.licenceProblemText(r).length > 20);
    }
  });
  await t("a server that answers with a licence for another device: refused by the app too", async ()=>{
    const A = app({ dc_vendor_id:"v1" }); await at(A, NOW);
    A.hook("terminalRpc", async ()=>({ ok:true, data:{ licence: lic({ install:"QQQQ", deviceKey:KEY, until:"2026-11-07T00:00:00Z" }) } }));
    assert.strictEqual((await A.api.activateFromInput("K7Q2-9XMB-3H", "paste")).reason, "other_device");
  });
  await t("check-in delivery: a registered till picks up a newer licence; nothing pending changes nothing", async ()=>{
    const A = app({ terminal_id:"t1" }); await at(A, NOW);
    let after = null;
    A.hook("terminalRpc", async (name, body)=>{ after = body.p_after_serial; return name==="cl_licence_pending"? { ok:true, data:{ licence:null } } : { ok:false }; });
    assert.strictEqual((await A.api.licencePullPending()).ok, false); assert.strictEqual(after, 0);
    A.hook("terminalRpc", async ()=>({ ok:true, data:{ licence: lic({ install:"ABCD", deviceKey:KEY, serial:501, until:"2027-01-07T00:00:00Z" }) } }));
    assert.ok((await A.api.licencePullPending()).ok);
    assert.strictEqual(A.api.currentLicence().serial, 501);
    A.hook("terminalRpc", async (name, body)=>{ after = body.p_after_serial; return { ok:true, data:{ licence:null } }; });
    await A.api.licencePullPending(); assert.strictEqual(after, 501, "asks only for newer than the one it holds");
  });

  console.log("the orange note (Products / Sell)");
  const till = (extra)=> makeApp(Object.assign({ terminal_id:"t2", till_code:"T2", branch_name:"Harare" }, extra||{}));
  await t("local branch, T2 that holds stock of its own: no note (it sells its own stock)", async ()=>{
    const A = till({ stock_mode:"local", stock_holder:"" });
    A.api.run("INSERT INTO products(name,stock,branch) VALUES('Rice',4,?)", [A.api.currentBranch()]);
    assert.strictEqual(A.api.tillStockNoteText(), ""); assert.strictEqual(A.api.tillStockNoteHtml(), "");
  });
  await t("local branch, T2 with no stock at all: says how to get some (no 'next update')", async ()=>{
    const A = till({ stock_mode:"local", stock_holder:"" });
    A.api.run("INSERT INTO products(name,stock,branch) VALUES('Rice',0,?)", [A.api.currentBranch()]);
    assert.match(A.api.tillStockNoteText(), /^This till has no stock yet\. Receive stock on this till, or ask the main till to start shared stock/);
    assert.ok(!/next update/.test(A.api.tillStockNoteHtml()));
  });
  await t("before the first stock sync: T2 with no stock gets the no-stock note; T1 never does", async ()=>{
    const A = till({});
    assert.match(A.api.tillStockNoteText(), /no stock yet/);
    assert.strictEqual(till({ till_code:"T1" }).api.tillStockNoteText(), "");
  });
  await t("shared branch, not joined: the merge note; joined: none; the stock holder and unregistered devices: none", async ()=>{
    assert.match(till({ stock_mode:"shared", stock_init:"" }).api.tillStockNoteText(), /^Your branch uses shared stock\. This till still has stock of its own/);
    assert.strictEqual(till({ stock_mode:"shared", stock_init:"1" }).api.tillStockNoteText(), "");
    assert.strictEqual(till({ stock_mode:"local", stock_holder:"1" }).api.tillStockNoteText(), "");
    assert.strictEqual(makeApp({ till_code:"T2" }).api.tillStockNoteText(), "");
  });

  console.log("Q9 number and Q12 formula");
  await t("+263774479121 appears nowhere in src/ (any spelling); +263789487287 is on the activation screen and Help", async ()=>{
    const files = []; (function walk(d){ for(const f of fs.readdirSync(d)){ const p = path.join(d,f); if(fs.statSync(p).isDirectory()) walk(p); else if(/\.(js|html|css|json)$/.test(f)) files.push(p); } })(path.join(ROOT,"src"));
    const hits = files.filter(f=> /263\s*77\s*447\s*9121|0774\s*479\s*121|774479121/.test(fs.readFileSync(f,"utf8")));
    assert.deepStrictEqual(hits.map(f=>path.relative(ROOT,f)), []);
    const act = fs.readFileSync(path.join(ROOT,"src","activation.js"),"utf8"), help = fs.readFileSync(path.join(ROOT,"src","help.js"),"utf8");
    assert.ok(act.includes('SEIGEN_PHONE = "+263789487287"') && /263789487287/.test(help));
  });
  await t("the old formula is explained nowhere (comments, docs, tests); its code is only in activation.js and whole-app copies of it", async ()=>{
    const { execSync } = require("child_process");
    const grep = (re)=>{ try{ return execSync('git grep -l -E "'+re+'" -- . ":!test/licence.test.js"', { cwd:ROOT, encoding:"utf8" }).trim().split(/\r?\n/).filter(Boolean); }catch(e){ return []; } };   // exit 1 = no match
    assert.deepStrictEqual(grep("Claude chat|CODE FORMULA|hash\\*31"), [], "no comment or doc explains how to compute a code");
    // the function itself: activation.js, its builds, and the two stale pre-build app copies (index.html, .backup/)
    const code = grep("hash ?<< ?5").filter(f=> f!=="src/activation.js" && !/^dist[^/]*\//.test(f) && f!=="index.html" && !/^\.backup\//.test(f));
    assert.deepStrictEqual(code, []);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();

function tagOf(key){
  const h = crypto.createHash("sha512").update(key, "utf8").digest();
  const bits = (h[0]<<12)|(h[1]<<4)|(h[2]>>4);
  return [0,1,2,3].map(i=> ALPHA[(bits>>(15-5*i))&31]).join("");
}
