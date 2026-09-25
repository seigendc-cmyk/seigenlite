// Run: node --no-warnings test/license-lock-screen-e2e.test.js
//
// Gap this closes: test/license-clock-guard.test.js drives
// activationStatus()/establishTrustedTime() directly through the harness in
// test/harness.js, which never loads a $app/document (it doesn't need one
// for pure business logic) — so renderLock()'s actual DOM output, in
// particular the new clock-anomaly notice (Part 6: the response to a
// detected rollback/jump must be a plain-language message on THIS screen,
// never a data lockout), was never rendered by any test. This file renders
// the REAL src/activation.js's renderLock() into a REAL DOM (jsdom), the
// same pattern test/cart-drawer-e2e.test.js uses for the cart drawer.
"use strict";
const assert = require("assert");
const { JSDOM } = require("jsdom");
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");

class Compat {
  constructor(){ this.h = new DatabaseSync(":memory:"); }
  run(sql, params){ if(params && params.length) this.h.prepare(sql).run(...params); else this.h.exec(sql); }
  prepare(sql){
    const st = this.h.prepare(sql); let rows=null, i=0, p=[];
    return { bind:(x)=>{ p=x||[]; }, step(){ if(rows===null) rows=st.all(...p); return i<rows.length; },
             getAsObject(){ return {...rows[i++]}; }, free(){} };
  }
}

function makeDomApp(settings){
  const dom = new JSDOM(`<!DOCTYPE html><body><div id="app"></div></body>`, { url: "http://localhost/" });
  const window = dom.window;
  const document = window.document;
  const db = new Compat();
  const sqlCtor = function(x){ return x && x.__db ? x.__db : new Compat(); };

  const ctx = vm.createContext(Object.assign(window, {
    console,
    SQLctor: sqlCtor,
    __db: db,
    alert: ()=>{},
    confirm: ()=>true,
    $app: document.getElementById("app"),
  }));

  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    let route="lock", cart=[];
    async function persist(){}
    function render(){}
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
  `;
  const files = ["db.js","activation.js","pos.js","sync.js","eod.js"];
  // db.js defines the real persist() (idbSet/db.export-based, needing real
  // IndexedDB) — override it with a no-op after load, same pattern
  // test/harness.js uses, since this test only needs settings/business
  // logic and DOM output, never real persistence.
  // getSupabaseConfig() now returns Digital Commerce's live project (from
  // devicecheckin.js, not loaded here); read the old settings keys instead
  // so fetchNetworkTime() never leaves the test — same seam as test/harness.js.
  const code = prelude + files.map(src).join("\n") + "\npersist = async function(){};"
    + `\ngetSupabaseConfig = function(){ return { url: getSetting("supabase_url",""), anonKey: getSetting("supabase_anon_key","") }; };`;

  vm.runInContext(code, ctx, { filename: "app-sources" });
  vm.runInContext(`db.run(SCHEMA); migrate(db);`, ctx);
  Object.entries(settings||{}).forEach(([k,v])=>{
    vm.runInContext(`setSetting(${JSON.stringify(k)}, ${JSON.stringify(String(v))});`, ctx);
  });

  return {
    ctx, db, document,
    exec(js){ return vm.runInContext(js, ctx); },
  };
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}

(async()=>{
  await t("renderLock() with no clock anomaly shows the plain activation screen and no anomaly notice", async ()=>{
    const app = makeDomApp({ install_date:"2026-06-01T08:00:00Z", activated_until:"2026-07-01T08:00:00Z" });
    await app.exec(`establishTrustedTime(new Date("2026-09-22T08:00:00Z"))`);
    app.exec("renderLock();");

    assert.ok(app.document.querySelector(".device-code"), "the device code is shown");
    assert.ok(/Your 30 days are up/.test(app.document.getElementById("app").innerHTML));
    assert.strictEqual(app.exec("lastClockAnomaly()"), null);
    // No stray anomaly banner text anywhere on the screen.
    assert.ok(!/date\/time appears to have/.test(app.document.getElementById("app").innerHTML));
  });

  await t("renderLock() after a detected rollback shows a plain-language clock-anomaly notice, still with the normal unlock flow available", async ()=>{
    const app = makeDomApp({ install_date:"2026-06-01T08:00:00Z", activated_until:"2026-07-01T08:00:00Z" });
    await app.exec(`establishTrustedTime(new Date("2026-09-22T08:00:00Z"))`);
    const check = await app.exec(`establishTrustedTime(new Date("2026-09-22T07:00:00Z"))`); // an hour back — well past tolerance
    assert.strictEqual(check.anomaly, "rollback");

    app.exec("renderLock();");
    const html = app.document.getElementById("app").innerHTML;
    assert.ok(/date\/time appears to have moved backward/.test(html), "plain-language explanation is present: "+html.slice(0,400));
    assert.ok(/connect to the internet/i.test(html));

    // Part 6: the notice augments the existing lock screen, it doesn't
    // replace or break the normal unlock path.
    assert.ok(app.document.getElementById("actCode"), "the activation-code input is still there");
    assert.ok(app.document.getElementById("unlockBtn"), "the Unlock button is still wired");
    assert.ok(app.document.getElementById("waLock"), "the WhatsApp support button is still there");
  });

  await t("renderLock() after a detected forward jump shows the forward-jump wording, not the rollback wording", async ()=>{
    const app = makeDomApp({ install_date:"2026-06-01T08:00:00Z", activated_until:"2026-07-01T08:00:00Z" });
    await app.exec(`establishTrustedTime(new Date("2026-09-22T08:00:00Z"))`);
    const check = await app.exec(`establishTrustedTime(new Date("2027-06-22T08:00:00Z"))`); // 9 months ahead
    assert.strictEqual(check.anomaly, "forward_jump");

    app.exec("renderLock();");
    const html = app.document.getElementById("app").innerHTML;
    assert.ok(/jumped forward unexpectedly/.test(html), html.slice(0,400));
    assert.ok(!/moved backward/.test(html));
  });

  await t("a correct unlock code seeds the next 30 days from trusted time, not the raw device clock, and clears the lock", async ()=>{
    const app = makeDomApp({ install_date:"2026-06-01T08:00:00Z", activated_until:"2026-07-01T08:00:00Z", secret_phrase:"shop-secret" });
    await app.exec(`establishTrustedTime(new Date("2026-09-22T08:00:00Z"))`);
    app.exec("renderLock();");

    const deviceCode = app.exec("currentDeviceCode()");
    const code = app.exec(`computeActivationCode(${JSON.stringify(deviceCode)}, "shop-secret")`);
    app.document.getElementById("actCode").value = code;
    await app.exec(`document.getElementById("unlockBtn").onclick()`);

    const until = new Date(app.exec(`getSetting("activated_until")`));
    // Seeded from trustedNow() (~2026-09-22T08:00:00Z), not whatever the
    // real host machine's wall clock happens to read right now.
    const expected = new Date("2026-09-22T08:00:00Z").getTime()+30*86400000;
    assert.ok(Math.abs(until.getTime()-expected) < 5000, "activated_until is 30 days from the trusted instant: "+until.toISOString());
    assert.strictEqual(app.exec("route"), "pos", "unlocking navigates away from the lock screen");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
