// Run: node --no-warnings test/license-clock-guard.test.js
// License Date-Rollback Protection (src/eod.js's trusted-time extension of
// businessDateToday()'s high-water-mark, wired into src/activation.js's
// activationStatus()/currentDeviceCode()/unlock handler), over the REAL app
// source via the same harness the other suites use. Exercises
// establishTrustedTime()/trustedNow()/lastClockAnomaly() and
// activationStatus() directly — not copies of their logic — the same way
// eod-shift.test.js exercises businessDateToday()/shiftBlockReason()
// directly rather than reimplementing the anti-rollback math.
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
function rig(o){ return makeApp(Object.assign({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, o||{})); }
const D = (iso)=> new Date(iso);
const DAY = 86400000;

// A fully-licensed device: installed and activated long enough ago that
// activationStatus() would read "ok" for as long as `until` isn't passed.
function licensedRig(installIso, untilIso){
  return rig({ install_date: installIso, activated_until: untilIso });
}

(async()=>{
  // ================= normal date progression: no false positive =================
  await t("normal date progression across several real sessions never flags an anomaly or blocks a valid license", async ()=>{
    const A = licensedRig("2026-09-01T08:00:00Z","2026-10-01T08:00:00Z");
    let t0 = D("2026-09-01T08:00:00Z");
    for(let i=0;i<5;i++){
      t0 = new Date(t0.getTime()+DAY); // one plausible day forward per "session"
      const check = await A.api.establishTrustedTime(t0);
      assert.strictEqual(check.anomaly, null, "day "+i+": ordinary forward progress is never an anomaly");
      assert.strictEqual(A.api.activationStatus(),"ok");
    }
  });

  // ================= restart preserves the trusted timestamp state =================
  await t("device restart (fresh app instance over the same persisted db) preserves the trusted-time watermark", async ()=>{
    const A = licensedRig("2026-09-01T08:00:00Z","2026-10-01T08:00:00Z");
    await A.api.establishTrustedTime(D("2026-09-10T12:00:00Z"));
    assert.strictEqual(A.api.trustedTimeHwm().toISOString(), D("2026-09-10T12:00:00Z").toISOString());

    // Simulate "the app restarted and reloaded this device's persisted db"
    // — same pattern test/eod-shift.test.js uses for businessDateToday().
    const B = rig(); B.api.setDb(A.db);
    assert.strictEqual(B.api.trustedTimeHwm().toISOString(), D("2026-09-10T12:00:00Z").toISOString(), "the watermark survived the simulated restart, read by a brand-new module instance");

    // And a rollback attempt on the "restarted" instance is still caught,
    // proving the watermark isn't just readable but still enforced.
    const check = await B.api.establishTrustedTime(D("2026-09-05T00:00:00Z"));
    assert.strictEqual(check.anomaly,"rollback");
  });

  // ================= fully offline over a simulated multi-day period =================
  await t("fully offline usage over a simulated multi-day period causes no false positive", async ()=>{
    const A = licensedRig("2026-09-01T08:00:00Z","2026-10-15T08:00:00Z");
    A.ctx.navigator.onLine = false; // offline for the whole scenario
    let t0 = D("2026-09-01T08:00:00Z");
    for(let day=1; day<=6; day++){
      t0 = new Date(t0.getTime()+DAY);
      const check = await A.api.establishTrustedTime(t0);
      assert.strictEqual(check.anomaly, null, "offline day "+day+": plain elapsed time is never mistaken for an anomaly");
    }
    assert.strictEqual(A.api.activationStatus(),"ok","offline the whole time, license still genuinely valid");
    assert.strictEqual(A.api.trustedTimeHwm().toISOString(), t0.toISOString(), "the watermark still advanced normally without any network reachable");
  });

  // ================= backward rollback: detected, handled, no data corruption =================
  await t("a backward clock rollback is detected, recorded in the audit log, and never touches business data", async ()=>{
    const A = licensedRig("2026-09-01T08:00:00Z","2026-10-01T08:00:00Z");
    A.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Rice',10,50,3,'Boka','')");
    const rice = A.api.one("SELECT * FROM products WHERE name='Rice'");

    await A.api.establishTrustedTime(D("2026-09-15T09:00:00Z"));
    assert.strictEqual(A.api.activationStatus(),"ok");

    const before = { sales: A.api.all("SELECT * FROM sales").length, products: A.api.one("SELECT * FROM products WHERE id=?",[rice.id]) };

    // Wind the clock back ten minutes — well past the drift tolerance.
    const check = await A.api.establishTrustedTime(D("2026-09-15T08:50:00Z"));
    assert.strictEqual(check.anomaly, "rollback");
    assert.ok(check.time.getTime() > D("2026-09-15T08:50:00Z").getTime(), "the trusted time itself never actually moved backward");

    // Part 6: response is limited to license/activation state — no data
    // corruption, deletion, or lockout of sales/stock. Ordinary business
    // operations (here: a stock update, direct and unrelated to any
    // real-wall-clock-gated flow like EOD) still work fine right after the
    // anomaly was detected — nothing about it touches these tables.
    assert.strictEqual(A.api.all("SELECT * FROM sales").length, before.sales);
    assert.deepStrictEqual(A.api.one("SELECT * FROM products WHERE id=?",[rice.id]), before.products);
    A.api.run("UPDATE products SET stock=stock-1 WHERE id=?",[rice.id]);
    assert.strictEqual(A.api.one("SELECT * FROM products WHERE id=?",[rice.id]).stock, before.products.stock-1, "business data is still fully readable/writable right after a clock anomaly — licensing anomalies never lock out business data");

    // Part 8: audit trail, reusing the app's one existing mechanism.
    const anomalyRows = A.api.all("SELECT * FROM audit_log WHERE action LIKE 'Clock anomaly:%'");
    assert.strictEqual(anomalyRows.length, 1);
    assert.match(anomalyRows[0].action, /rollback/);
    assert.match(anomalyRows[0].details, /min behind/);
    assert.ok(anomalyRows[0].ts, "the anomaly record carries its own detection timestamp");
  });

  // ================= large forward jump: detected and handled =================
  await t("a large forward jump (months ahead) is flagged as an anomaly and does not silently extend/validate the license", async ()=>{
    const A = licensedRig("2026-09-01T08:00:00Z","2026-10-01T08:00:00Z");
    await A.api.establishTrustedTime(D("2026-09-05T08:00:00Z"));

    // Jump 6 months forward — the kind of jump that would otherwise let a
    // 30-day trial look valid (or invalid) far outside its real window.
    const check = await A.api.establishTrustedTime(D("2027-03-05T08:00:00Z"));
    assert.strictEqual(check.anomaly, "forward_jump");
    assert.strictEqual(check.time.toISOString(), D("2026-09-05T08:00:00Z").toISOString(), "the uncorroborated jump is not trusted — time stays frozen at the last known-good instant");

    const anomalyRows = A.api.all("SELECT * FROM audit_log WHERE action LIKE 'Clock anomaly:%'");
    assert.strictEqual(anomalyRows.length, 1);
    assert.match(anomalyRows[0].action, /forward_jump/);

    // Rolling back afterward to "cash in" on the frozen watermark doesn't
    // help either — the very next plausible reading resumes from the
    // frozen instant, never from the bogus jump.
    const after = await A.api.establishTrustedTime(D("2026-09-05T08:04:00Z")); // 4 min later, within tolerance of the frozen watermark
    assert.strictEqual(after.anomaly, null);
  });

  // ================= repeated back-and-forth cannot reset or extend a trial =================
  await t("repeatedly rolling the clock backward and forward never resets or extends a trial period", async ()=>{
    const A = rig({ install_date:"2026-09-01T08:00:00Z", activated_until:"2026-10-01T08:00:00Z" });
    await A.api.establishTrustedTime(D("2026-09-30T08:00:00Z")); // one day left on the trial

    for(let i=0;i<5;i++){
      await A.api.establishTrustedTime(D("2026-09-10T08:00:00Z")); // roll back ~20 days
      await A.api.establishTrustedTime(D("2026-09-30T08:00:00Z")); // roll forward again
    }
    assert.strictEqual(A.api.trustedTimeHwm().toISOString(), D("2026-09-30T08:00:00Z").toISOString(), "no amount of back-and-forth pushed the watermark past what was genuinely, plausibly observed");
    assert.strictEqual(A.api.activationStatus(),"ok","still exactly where a single honest reading would have left it");
  });

  // ================= legitimate time zone change, no date manipulation =================
  await t("a genuine time zone change alone (same instant, different offset) is never flagged", async ()=>{
    const A = licensedRig("2026-09-01T08:00:00Z","2026-10-01T08:00:00Z");
    await A.api.establishTrustedTime(D("2026-09-15T12:00:00Z")); // observed as UTC noon

    // The device's clock/timezone setting changes (e.g. a flight lands in a
    // new zone), but the underlying instant barely moves — a Date built
    // from a differently-offset ISO string one minute later, which is
    // exactly what changing time zones alone looks like at the epoch-ms
    // level Date.getTime() actually compares on.
    const sameInstantNewZone = new Date("2026-09-15T15:01:00+03:00"); // = 2026-09-15T12:01:00Z
    const check = await A.api.establishTrustedTime(sameInstantNewZone);
    assert.strictEqual(check.anomaly, null, "a time zone relabelling is not a clock rollback or jump");
    assert.strictEqual(A.api.all("SELECT * FROM audit_log WHERE action LIKE 'Clock anomaly:%'").length, 0);
  });

  // ================= an already-expired license stays expired despite rollback =================
  await t("an already-expired license remains expired even after a rollback attempt", async ()=>{
    const A = licensedRig("2026-06-01T08:00:00Z","2026-07-01T08:00:00Z"); // trial ended a while ago
    await A.api.establishTrustedTime(D("2026-09-01T08:00:00Z")); // the device has genuinely observed a date long past expiry
    assert.strictEqual(A.api.activationStatus(),"locked");

    // Roll the clock back to well before the expiry date, hoping the
    // license looks valid again.
    const check = await A.api.establishTrustedTime(D("2026-06-15T08:00:00Z"));
    assert.strictEqual(check.anomaly,"rollback");
    assert.strictEqual(A.api.activationStatus(),"locked","the watermark already passed activated_until once — rolling back can't undo that");
  });

  // ================= a valid, non-expired license keeps working throughout =================
  await t("a valid, non-expired license continues to work normally across ordinary use", async ()=>{
    const A = licensedRig("2026-09-01T08:00:00Z","2026-10-01T08:00:00Z");
    const readings = ["2026-09-05T08:00:00Z","2026-09-12T08:00:00Z","2026-09-20T08:00:00Z","2026-09-28T08:00:00Z"];
    for(const iso of readings){
      const check = await A.api.establishTrustedTime(D(iso));
      assert.strictEqual(check.anomaly, null);
      assert.strictEqual(A.api.activationStatus(),"ok", iso+" is still inside the trial window");
    }
    assert.strictEqual(A.api.all("SELECT * FROM audit_log WHERE action LIKE 'Clock anomaly:%'").length, 0, "nothing anomalous ever happened, so nothing was ever logged");
  });

  // ================= repeated rollback cannot cycle currentDeviceCode() backward either =================
  await t("currentDeviceCode()'s 30-day cycle number also can't be walked backward by rolling the clock back", async ()=>{
    const A = licensedRig("2026-09-01T08:00:00Z","2026-12-01T08:00:00Z");
    await A.api.establishTrustedTime(D("2026-11-05T08:00:00Z")); // ~65 days in -> cycle 3
    const codeAtCycle3 = A.api.currentDeviceCode();
    assert.match(codeAtCycle3, /-C3$/);

    await A.api.establishTrustedTime(D("2026-09-10T08:00:00Z")); // rollback attempt, well past tolerance
    const codeAfterRollback = A.api.currentDeviceCode();
    assert.strictEqual(codeAfterRollback, codeAtCycle3, "the device code is still derived from the trusted (unrolled-back) time, so it can't be walked back to an earlier cycle/code pairing");
  });

  // ================= when online, a corroborated network time is authoritative =================
  await t("when online with Supabase configured, a corroborated network timestamp is used and can validate a jump the device clock alone couldn't", async ()=>{
    const A = licensedRig("2026-09-01T08:00:00Z","2027-06-01T08:00:00Z");
    A.api.setSetting("supabase_url","https://example.supabase.co");
    A.api.setSetting("supabase_anon_key","anon-key");
    await A.api.establishTrustedTime(D("2026-09-05T08:00:00Z"));

    // Device was genuinely offline for months; its clock is correct, but
    // that's indistinguishable from a bogus jump using the device clock
    // alone. A server timestamp (here, the mocked fetch's Date header)
    // corroborates it, so it's accepted without being flagged.
    const serverNow = "2026-12-20T08:00:00Z";
    A.hook("fetch", async ()=> ({ ok:true, headers:{ get:(h)=> h.toLowerCase()==="date"? new Date(serverNow).toUTCString() : null } }));
    const check = await A.api.establishTrustedTime(D("2026-12-20T08:05:00Z")); // device clock's own guess, close to the server's
    assert.strictEqual(check.anomaly, null, "a server-corroborated jump is not an anomaly");
    assert.strictEqual(A.api.trustedTimeHwm().toISOString(), new Date(serverNow).toISOString());
    assert.strictEqual(A.api.all("SELECT * FROM audit_log WHERE action LIKE 'Clock anomaly:%'").length, 0);
  });

  // ================= network time is a best-effort convenience, never a hard requirement =================
  await t("without Supabase configured (no server call to reuse) or when the network call fails, the app falls back to the local watermark without throwing", async ()=>{
    const A = licensedRig("2026-09-01T08:00:00Z","2026-10-01T08:00:00Z");
    // No supabase_url set at all — fetchNetworkTime() has nothing to call.
    const check1 = await A.api.establishTrustedTime(D("2026-09-05T08:00:00Z"));
    assert.strictEqual(check1.anomaly, null);

    A.api.setSetting("supabase_url","https://example.supabase.co");
    A.api.setSetting("supabase_anon_key","anon-key");
    A.hook("fetch", async ()=>{ throw new Error("network unreachable"); });
    const check2 = await A.api.establishTrustedTime(D("2026-09-05T08:10:00Z"));
    assert.strictEqual(check2.anomaly, null, "a failed network probe just falls back to the device clock, same as being offline");
    assert.strictEqual(A.api.activationStatus(),"ok");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
