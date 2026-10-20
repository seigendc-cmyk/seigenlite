// node test/freeze-fix.test.js
//
// The P0 freezes after build 29 and their v30 fix (owner 2026-10-20;
// docs/perf/login-branch-switch-diagnosis.md):
//   - the PIN / Admin passcode check values: the async check (Web Crypto, off the UI
//     thread) gives exactly the bytes of passcode-check.js's own code, and so does its
//     fallback; nothing weaker (same 150,000 rounds, same check values);
//   - build.js's obfuscation leaves passcode-check.js alone (it made the hash ~40x slower);
//   - sign-in: correct and wrong PIN, lockout after 5 wrong tries (still counted on the
//     async path), one check at a time ("Checking…", no double submit);
//   - Settings unlock: correct and wrong Admin passcode set by main, "Checking…";
//   - Remote -> Main: unregistered tills as before; a till registered with seiGEN as a
//     remote may not (the message, nothing changed); Save all or nothing; pending
//     offline sales and the outbox untouched;
//   - Sell: the first 200 products, "Show more" adds 200, a new search starts again;
//     the shared-stock settings read once per list give the same answers.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { makeApp } = require("./harness");

let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); }
}
const SALT = "00112233445566778899aabbccddeeff";
const ROOT = path.join(__dirname, "..");

function app(settings, dom){
  const A = makeApp(Object.assign({ setup_complete:"1", branch_name:"Mbare", shop_name:"Zuva" }, settings||{}), { dom:!!dom });
  A.alerts = [];
  A.hook("alert", (m)=>{ A.alerts.push(String(m)); });
  if(dom) vm.runInContext(`var $app = document.getElementById("app"); var APP_VERSION="test", exportScope=null, exportDirHandle=null;`, A.ctx);
  return A;
}
// roles from seiGEN and one person with a seiGEN PIN (check value) at this branch
function withStaff(A, pin){
  const c = A.api.adminCheckMake(pin, SALT);
  A.api.run("INSERT INTO shop_roles(id,name,builtin,rights,seq) VALUES('r-admin','Admin','admin',?,1)", [JSON.stringify(A.api.ROLE_DEFAULTS.admin)]);
  A.api.run(`INSERT INTO shop_staff(id,name,role_id,home_branch,home_branch_name,branches,active,here,pin_salt,pin_check,pin_rounds,legacy,pins_from_tills,has_pin,seq)
    VALUES('st-1','Grace','r-admin','b1','Mbare','[]',1,1,?,?,?,'[]',0,1,1)`, [c.salt, c.check, c.rounds]);
  return c;
}
function withMainAdmin(A, passcode){
  const c = A.api.adminCheckMake(passcode, SALT);
  A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts,passcode_salt,passcode_check,passcode_rounds) VALUES('Admin (set by main)','Admin','','Mbare',1,'x',?,?,?)", [c.salt, c.check, c.rounds]);
  return c;
}

(async ()=>{
  // ================= the hash =================
  await t("async check values = passcode-check.js's own (Web Crypto and the fallback), 150,000 rounds", async ()=>{
    const A = app();
    for(const p of ["1234", "482613", "admin123", "  mbare-77  ", "ñandú £ 5", "x".repeat(80)]){
      const sync = A.api.adminCheckMake(p, SALT);
      const web = await A.api.adminCheckMakeAsync(p, SALT);
      A.api.pcTestForceFallback(true);
      const fb = await A.api.adminCheckMakeAsync(p, SALT);
      A.api.pcTestForceFallback(false);
      assert.strictEqual(sync.rounds, 150000);
      assert.deepStrictEqual([web.check, web.rounds, fb.check, fb.rounds], [sync.check, 150000, sync.check, 150000], "for " + JSON.stringify(p));
      assert.strictEqual(await A.api.adminCheckMatchesAsync(p, SALT, sync.check, 150000), true);
      assert.strictEqual(await A.api.adminCheckMatchesAsync(p + "0", SALT, sync.check, 150000), false);
    }
    // the same guards as the sync check
    const c = A.api.adminCheckMake("1234", SALT);
    assert.strictEqual(await A.api.adminCheckMatchesAsync("", SALT, c.check, 150000), false);
    assert.strictEqual(await A.api.adminCheckMatchesAsync("1234", "zz", c.check, 150000), false);
    assert.strictEqual(await A.api.adminCheckMatchesAsync("1234", SALT, c.check, 999), false, "too few rounds is refused");
    assert.strictEqual(A.api.adminCheckMatches("1234", SALT, c.check, 150000), true);
  });

  await t("build.js's obfuscation leaves passcode-check.js out (the hash stays at plain speed); the rest stays obfuscated", ()=>{
    const JO = require(path.join(ROOT, "node_modules", "javascript-obfuscator"));
    const opts = eval("(" + /const OBFUSCATOR_OPTIONS = (\{[\s\S]*?\n\});/.exec(fs.readFileSync(path.join(ROOT, "build.js"), "utf8"))[1] + ")");
    const src = fs.readFileSync(path.join(ROOT, "src", "passcode-check.js"), "utf8");
    const code = "(function(){ function otherAppCode(x){ return 'other app text ' + x; }\n" + src + "\n;this.make = adminCheckMake; this.other = otherAppCode; }).call(this);";
    const out = JO.obfuscate(code, opts).getObfuscatedCode();
    assert.ok(!/other app text/.test(out), "the rest of the app is still obfuscated");
    assert.ok(/function pbkdf2Sha256Hex\(/.test(out), "the hash code is left as written");
    const run = (c)=>{ const ctx = vm.createContext({ TextEncoder, crypto:globalThis.crypto }); vm.runInContext(c, ctx); return ctx; };
    const plain = run(code), obf = run(out);
    let t0 = Date.now(); const a = plain.make("1234", SALT).check; const tPlain = Date.now() - t0;
    t0 = Date.now(); const b = obf.make("1234", SALT).check; const tObf = Date.now() - t0;
    assert.strictEqual(a, b);
    assert.ok(tObf < tPlain*3 + 500, `obfuscated build hash ${tObf} ms vs plain ${tPlain} ms (it was ~40x)`);
  });

  // ================= sign-in =================
  await t("sign-in (async): the right PIN signs in; a wrong one says how many tries are left", async ()=>{
    const A = app(); withStaff(A, "4826");
    let r = await A.api.attemptShopSigninAsync("st-1", "1111");
    assert.deepStrictEqual([r.ok, r.message], [false, "Incorrect PIN. 4 attempt(s) left."]);
    assert.strictEqual(A.api.staffSession(), null);
    r = await A.api.attemptShopSigninAsync("st-1", "4826");
    assert.ok(r.ok); assert.strictEqual(A.api.staffSession().name, "Grace");
    assert.strictEqual(A.api.one("SELECT fail_count FROM shop_staff WHERE id='st-1'").fail_count, 0, "a right PIN clears the count");
  });

  await t("sign-in (async): 5 wrong PINs lock for 5 minutes; the right PIN is refused while locked", async ()=>{
    const A = app(); withStaff(A, "4826");
    for(let i = 1; i <= 4; i++) assert.match((await A.api.attemptShopSigninAsync("st-1", "000" + i)).message, /Incorrect PIN/);
    const fifth = await A.api.attemptShopSigninAsync("st-1", "0005");
    assert.ok(fifth.locked && /Try again in 5 minutes/.test(fifth.message));
    const right = await A.api.attemptShopSigninAsync("st-1", "4826");
    assert.ok(!right.ok && right.locked, "locked: not even the right PIN");
    assert.strictEqual(A.api.staffSession(), null);
  });

  await t("sign-in (async): a second tap during the check is the same check (one wrong try counted, not two)", async ()=>{
    const A = app(); withStaff(A, "4826");
    const p1 = A.api.attemptShopSigninAsync("st-1", "1111"), p2 = A.api.attemptShopSigninAsync("st-1", "1111");
    assert.strictEqual(p1, p2);
    await p1;
    assert.strictEqual(A.api.one("SELECT fail_count FROM shop_staff WHERE id='st-1'").fail_count, 1);
  });

  await t("sign-in (async): a wrong try counted on another screen during the check still counts", async ()=>{
    const A = app(); withStaff(A, "4826");
    A.api.run("UPDATE shop_staff SET fail_count=3 WHERE id='st-1'");
    const p = A.api.attemptShopSigninAsync("st-1", "1111");
    A.api.run("UPDATE shop_staff SET fail_count=4 WHERE id='st-1'");   // meanwhile
    const r = await p;
    assert.ok(r.locked, "the 5th wrong try locks");
  });

  await t("the PIN screen: \"Checking…\" with Unlock, Back and Cancel disabled, then signed in", async ()=>{
    const A = app({ single_operator_mode:"0" }, true); withStaff(A, "4826");
    vm.runInContext(`sessionUser = "Earlier"; renderWhoAmI();`, A.ctx);
    const doc = A.dom.window.document;
    doc.getElementById("whoSelectContinue").onclick();
    const pin = doc.getElementById("whoPin"); pin.value = "4826"; pin.oninput();
    const btn = doc.getElementById("whoPinContinue");
    const done = btn.onclick();
    assert.ok(btn.disabled && btn.textContent === "Checking…");
    assert.ok(doc.getElementById("whoBack").disabled && doc.getElementById("whoCancel").disabled);
    await btn.onclick();   // a second tap while checking does nothing
    await done;
    assert.strictEqual(A.api.getSessionUser(), "Grace");
    assert.strictEqual(A.api.all("SELECT 1 FROM audit_log WHERE action='Sign in'").length, 1, "signed in once");
    assert.strictEqual(vm.runInContext("route", A.ctx), "pos");
  });

  await t("the PIN screen: a wrong PIN shows the message and a fresh Unlock", async ()=>{
    const A = app({ single_operator_mode:"0" }, true); withStaff(A, "4826");
    vm.runInContext(`sessionUser = ""; renderWhoAmI();`, A.ctx);
    const doc = A.dom.window.document;
    doc.getElementById("whoSelectContinue").onclick();
    const pin = doc.getElementById("whoPin"); pin.value = "1111"; pin.oninput();
    await doc.getElementById("whoPinContinue").onclick();
    assert.match(doc.getElementById("app").textContent, /Incorrect PIN\. 4 attempt\(s\) left\./);
    const btn = doc.getElementById("whoPinContinue");
    assert.ok(!btn.disabled && btn.textContent === "Unlock");
    assert.strictEqual(A.api.getSessionUser(), "");
  });

  // ================= Settings unlock (Admin passcode set by main) =================
  await t("Settings unlock (async): the Admin passcode set by main unlocks; a wrong one doesn't; \"Checking…\" meanwhile", async ()=>{
    const A = app({ branch_type:"remote" }, true); withMainAdmin(A, "mbare-77");
    assert.strictEqual((await A.api.findAdminAsync("mbare-77")).name, "Admin (set by main)");
    assert.strictEqual(await A.api.findAdminAsync("mbare-78"), null);
    A.api.setRoute("more");
    const main = A.dom.window.document.getElementById("app");
    A.api.renderSettings(main);
    const doc = A.dom.window.document;
    doc.getElementById("settingsPasscode").value = "wrong-1";
    await doc.getElementById("unlockSettings").onclick();
    assert.strictEqual(A.api.getSettingsUnlocked(), false);
    assert.deepStrictEqual(A.alerts, ["Incorrect passcode."]);
    assert.ok(!doc.getElementById("unlockSettings").disabled);
    doc.getElementById("settingsPasscode").value = "mbare-77";
    const p = doc.getElementById("unlockSettings").onclick();
    assert.strictEqual(doc.getElementById("unlockSettings").textContent, "Checking…");
    await p;
    assert.strictEqual(A.api.getSettingsUnlocked(), true);
  });

  // ================= Remote -> Main =================
  // The full Settings screen draws cards from files the harness doesn't load (printing, scanner, drawer…):
  // those helpers are stubbed as empty, one by one, as the screen asks for them. Only the Shop details card is tested.
  function openUnlockedSettings(A){
    vm.runInContext("settingsUnlocked = true;", A.ctx);
    A.api.setRoute("more");
    const main = A.dom.window.document.getElementById("app");
    for(let i = 0; i < 60; i++){
      try{ A.api.renderSettings(main); return A.dom.window.document; }
      catch(e){
        const m = /^(\w+) is not defined$/.exec(e.message);
        if(!e || e.name !== "ReferenceError" || !m) throw e;
        vm.runInContext(`var ${m[1]} = function(){ return ""; };`, A.ctx);
      }
    }
    throw new Error("Settings didn't draw");
  }
  await t("an unregistered (offline-only) remote switches to Main as before", ()=>{
    const A = app({ branch_type:"remote" }, true);
    const doc = openUnlockedSettings(A);
    assert.ok(!doc.querySelector('#sBranchType option[value="main"]').disabled);
    assert.strictEqual(doc.getElementById("branchTypeLocked"), null);
    doc.getElementById("sBranchType").value = "main";
    doc.getElementById("saveSettings").onclick();
    assert.strictEqual(A.api.getSetting("branch_type"), "main");
    assert.deepStrictEqual(A.alerts, []);
  });

  await t("a till registered with seiGEN as a remote may not switch itself to Main: the message, nothing changed", ()=>{
    const A = app({ branch_type:"remote", terminal_id:"t-remote", terminal_is_main:"", contact_phone:"0771" }, true);
    assert.strictEqual(A.api.branchTypeLockedRemote(), true);
    const doc = openUnlockedSettings(A);
    assert.ok(doc.querySelector('#sBranchType option[value="main"]').disabled, "Main can't be picked");
    assert.match(doc.getElementById("branchTypeLocked").textContent, /Branch type is set for the whole business\. Ask the Owner, or seiGEN support\./);
    // even if the option is forced
    doc.querySelector('#sBranchType option[value="main"]').disabled = false;
    doc.getElementById("sBranchType").value = "main"; doc.getElementById("sContact").value = "0999";
    doc.getElementById("saveSettings").onclick();
    assert.strictEqual(A.api.getSetting("branch_type"), "remote");
    assert.strictEqual(A.api.getSetting("contact_phone"), "0771", "nothing else saved either");
    assert.match(A.alerts[0], /^Branch type is set for the whole business\. Ask the Owner, or seiGEN support\.\n\nNothing was changed\.$/);
  });

  await t("a till registered on the main branch: as before (Main stays pickable)", ()=>{
    const A = app({ branch_type:"main", terminal_id:"t-main", terminal_is_main:"1" }, true);
    assert.strictEqual(A.api.branchTypeLockedRemote(), false);
    const doc = openUnlockedSettings(A);
    assert.ok(!doc.querySelector('#sBranchType option[value="main"]').disabled);
  });

  await t("Save is all or nothing: a failure part-way leaves every setting (the branch type too) as it was", ()=>{
    const A = app({ branch_type:"remote", contact_phone:"0771" }, true);
    const doc = openUnlockedSettings(A);
    const orig = vm.runInContext("setSetting", A.ctx);
    A.hook("setSetting", (k, v)=>{ if(k === "management_whatsapp") throw new Error("disk full"); return orig(k, v); });
    doc.getElementById("sBranchType").value = "main"; doc.getElementById("sName").value = "New Name"; doc.getElementById("sContact").value = "0999";
    doc.getElementById("saveSettings").onclick();
    assert.deepStrictEqual([A.api.getSetting("branch_type"), A.api.getSetting("shop_name"), A.api.getSetting("contact_phone")], ["remote", "Zuva", "0771"]);
    assert.match(A.alerts[0], /Nothing was changed/);
    A.hook("setSetting", orig);
  });

  await t("an offline Remote -> Main switch keeps the pending sales and the outbox exactly as they were", ()=>{
    const A = app({ branch_type:"remote" }, true);
    A.ctx.navigator.onLine = false;
    for(let i = 1; i <= 3; i++){
      A.api.run("INSERT INTO sales(ts,subtotal,discount,total,method,branch) VALUES(?,10,0,10,'Cash','Mbare')", ["2026-10-20T08:0" + i + ":00Z"]);
      A.api.enqueueSync("sale", { n:i }, "sale-" + i);
    }
    const snap = ()=> JSON.stringify([A.api.all("SELECT id,uid,total FROM sales ORDER BY id"), A.api.all("SELECT record_key,status,payload_json FROM sync_queue ORDER BY id")]);
    const before = snap();
    const doc = openUnlockedSettings(A);
    doc.getElementById("sBranchType").value = "main";
    doc.getElementById("saveSettings").onclick();
    assert.strictEqual(A.api.getSetting("branch_type"), "main");
    assert.strictEqual(snap(), before);
    assert.strictEqual(A.api.all("SELECT 1 FROM sync_queue WHERE status='pending'").length, 3);
  });

  // ================= Sell: 200 at a time =================
  await t("Sell: the first 200 products, \"Show more\" adds 200, a new search starts again at 200", ()=>{
    const A = app({}, true);
    for(let i = 1; i <= 450; i++) A.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES(?,1,10,3,'Mbare',?)", [(i <= 111? "Bolt " : "Nut ") + i, "S" + i]);
    const doc = A.dom.window.document;
    doc.getElementById("app").innerHTML = `<div id="posResultsArea"></div>`;
    vm.runInContext(`searchQuery = ""; renderPOSListOnly();`, A.ctx);
    const rows = ()=> doc.querySelectorAll("#posResultsArea [data-add]").length;
    assert.strictEqual(rows(), 200);
    assert.strictEqual(doc.getElementById("posMoreText").textContent, "Showing 200 of 450 — search, or Show more");
    doc.getElementById("posShowMore").onclick();
    assert.strictEqual(rows(), 400);
    doc.getElementById("posShowMore").onclick();
    assert.strictEqual(rows(), 450);
    assert.strictEqual(doc.getElementById("posShowMore"), null, "all shown: no Show more");
    vm.runInContext(`searchQuery = "bolt"; renderPOSListOnly();`, A.ctx);
    assert.strictEqual(rows(), 111, "search as before (every match under 200 shown)");
    vm.runInContext(`searchQuery = ""; renderPOSListOnly();`, A.ctx);
    assert.strictEqual(rows(), 200, "a new search starts again at 200");
  });

  await t("Sell: the shared-stock settings read once per list give each product's own answers", ()=>{
    const A = app({ terminal_id:"t1", stock_mode:"shared", stock_init:"1", stock_reach:"ok" });
    const p = { stock:3, cat_uid:"c1", branch_avail:9, branch_total:12, stock_pending_in:2 }, q = { stock:-1, cat_uid:null };
    for(const reach of ["ok", "fail"]){
      A.api.setSetting("stock_reach", reach);
      const st = A.api.ssListState();
      for(const x of [p, q]){
        assert.strictEqual(A.api.sellableNow(x, st), A.api.sellableNow(x));
        assert.strictEqual(A.api.stockLineText(x, st), A.api.stockLineText(x));
      }
    }
    A.api.setSetting("stock_mode", "");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(A.api.ssListState())), { till:false });
    assert.strictEqual(A.api.sellableNow(p, A.api.ssListState()), 3);
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})();
