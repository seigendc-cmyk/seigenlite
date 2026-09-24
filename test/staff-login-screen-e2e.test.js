// Run: node --no-warnings test/staff-login-screen-e2e.test.js
//
// Bug report: the "Who's working today?" screen (shown on app launch) was
// reported as never updated for Staff PIN — still free-text name + Continue,
// no dropdown, no PIN, never calling attemptPinLogin().
//
// Investigation finding (see report): there is only ONE "who's working"
// screen/entry point — src/staff.js's renderWhoAmI() — and it already
// dispatches correctly: renderSingleOperatorAccess() (today's free-text
// flow, unchanged) when singleOperatorMode() is on OR no staff has a PIN
// yet (a deliberate safety net so the shop is never locked out), or
// renderStaffAccess() (dropdown -> PIN -> attemptPinLogin()) otherwise.
// main.js's boot() already calls renderWhoAmI() directly (not a second,
// unwired code path). There was no duplicate/dead screen to find.
//
// What WAS genuinely missing: end-to-end test coverage of the actual
// rendered screen. test/staff-pin.test.js only ever exercised the pure
// logic (attemptPinLogin, saveStaffMember, ...) through test/harness.js's
// DOM-less Node-vm — nothing rendered or clicked through renderWhoAmI()
// itself, so the wiring this bug report worried about had never actually
// been proven end-to-end. This file closes that gap with a real DOM
// (jsdom) driving the real src/staff.js + src/router.js, same harness
// pattern as test/cart-drawer-e2e.test.js.
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
  const dom = new JSDOM(
    `<!DOCTYPE html><body><div id="app"></div><div id="drawer"></div><div id="overlay"></div>
     <div id="reqOverlay"></div><div id="reqDrawer"></div><div id="printArea"></div></body>`,
    { url: "http://localhost/" }
  );
  const window = dom.window;
  const document = window.document;
  const db = new Compat();
  const sqlCtor = function(x){ return x && x.__db ? x.__db : new Compat(); };
  const alerts = [], confirms = [];

  const ctx = vm.createContext(Object.assign(window, {
    console, SQLctor: sqlCtor, __db: db,
    alert: (m)=>{ alerts.push(m); },
    confirm: (m)=>{ confirms.push(m); return true; },
    printNow: ()=>{},
    $app: document.getElementById("app"),
  }));

  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="pos", cart=[];
    let sessionStaffId=null, accessStep=1, accessSelectedStaffId=null, accessPinDigits="", accessError="";
    let moreTab="help", settingsUnlocked=false, drawerOpen=false, appliedVoucher=null;
    let searchQuery="", reportsQuery="", creditQuery="", reqDrawerOpen=false;
    let splitTender=false, splitLines=[], fxPreviewCurrency="", quickTapCurrency="";
    async function persist(){}
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
    function printReceipt(){}
    function renderRequestsDrawer(){}
  `;
  const files = ["db.js","utils.js","dnfile.js","pos.js","printing.js","drawer.js","currencies.js","staff.js","eod.js","devicecheckin.js","router.js"];
  const code = prelude.replace(/async function persist[^\n]*\n/, "").replace(/function printReceipt\(\)\{\}[^\n]*\n/, "")
    + files.map(src).join("\n")
    + "\n;this.printReceipt = printReceipt;";

  vm.runInContext(code, ctx, { filename: "app-sources" });
  vm.runInContext(`db.run(SCHEMA); migrate(db);`, ctx);
  Object.entries(settings||{}).forEach(([k,v])=>{
    vm.runInContext(`setSetting(${JSON.stringify(k)}, ${JSON.stringify(String(v))});`, ctx);
  });

  return {
    ctx, db, document, alerts, confirms,
    run(sql, params){ return vm.runInContext(`run(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    one(sql, params){ return vm.runInContext(`one(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    all(sql, params){ return vm.runInContext(`all(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    exec(js){ return vm.runInContext(js, ctx); },
  };
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

function addStaffWithPin(app, name, pin, role){
  return app.exec(`saveStaffMember({ name:${JSON.stringify(name)}, role:${JSON.stringify(role||"Cashier")}, pin:${JSON.stringify(pin)} })`);
}

(async()=>{
  const baseSettings = { branch_name:"Boka", branch_type:"main", setup_complete:"1" };

  // ================= Single operator mode: today's flow, unchanged =================
  await t("single operator mode (default ON): renderWhoAmI() shows the free-text name screen exactly as before — regression guard", ()=>{
    const app = makeDomApp(baseSettings); // single_operator_mode not set -> defaults ON
    assert.strictEqual(app.exec(`singleOperatorMode()`), true);
    app.exec(`renderWhoAmI();`);
    assert.strictEqual(app.document.getElementById("whoSelect"), null, "no dropdown in single-operator mode");
    assert.strictEqual(app.document.getElementById("whoPin"), null, "no PIN field in single-operator mode");
    const nameInput = app.document.getElementById("whoName");
    assert.ok(nameInput, "the old free-text input is still there");
    assert.ok(/Who's working today\?/.test(app.document.getElementById("app").textContent));

    nameInput.value = "Tapiwa";
    app.document.getElementById("whoContinue").onclick();
    assert.strictEqual(app.exec(`sessionUser`), "Tapiwa");
    assert.strictEqual(app.exec(`sessionStaffId`), null, "no staff record behind a free-text name, exactly as before");
    assert.strictEqual(app.exec(`route`), "pos");
  });

  await t("single operator mode is respected even with staff+PINs configured (owner hasn't opted in yet) — no silent switch to the PIN flow", ()=>{
    const app = makeDomApp(baseSettings);
    addStaffWithPin(app, "Rudo", "1234");
    app.exec(`renderWhoAmI();`);
    assert.ok(app.document.getElementById("whoName"), "still the free-text flow — single_operator_mode alone decides this, not whether staff/PINs exist");
    assert.strictEqual(app.document.getElementById("whoSelect"), null);
  });

  await t("multi-staff mode with nobody having a PIN yet safely falls back to the free-text screen (documented safety net, never strands the shop)", ()=>{
    const app = makeDomApp(baseSettings);
    app.exec(`setSetting("single_operator_mode","0");`);
    app.exec(`renderWhoAmI();`);
    assert.ok(app.document.getElementById("whoName"), "falls back rather than showing an empty, unusable dropdown");
  });

  // ================= Multi-staff mode: the dropdown + PIN flow =================
  await t("multi-staff mode (single_operator_mode off): renderWhoAmI() shows a dropdown of activeStaffWithPin(), not a free-text field", ()=>{
    const app = makeDomApp(baseSettings);
    app.exec(`setSetting("single_operator_mode","0");`);
    addStaffWithPin(app, "Rudo", "1234");
    addStaffWithPin(app, "Tapiwa", "5678");
    app.exec(`renderWhoAmI();`);
    assert.strictEqual(app.document.getElementById("whoName"), null, "no free-text field once staff/PINs are set up and single-operator is off");
    const select = app.document.getElementById("whoSelect");
    assert.ok(select, "the dropdown renders");
    const names = Array.from(select.querySelectorAll("option")).map(o=>o.textContent).sort();
    assert.deepStrictEqual(names, ["Rudo","Tapiwa"], "populated from activeStaffWithPin(), the correct existing accessor");
  });

  await t("a correct PIN logs the selected staff in via the real attemptPinLogin(), setting session state exactly as the rest of the app expects (currentStaff())", ()=>{
    const app = makeDomApp(baseSettings);
    app.exec(`setSetting("single_operator_mode","0");`);
    const rudo = addStaffWithPin(app, "Rudo", "1234");
    app.exec(`renderWhoAmI();`);
    app.document.getElementById("whoSelect").value = String(rudo.id);
    app.document.getElementById("whoSelectContinue").onclick();
    assert.ok(app.document.getElementById("whoPin"), "moved to the PIN step");
    assert.ok(/Enter your PIN/.test(app.document.getElementById("app").textContent));

    const pinInput = app.document.getElementById("whoPin");
    pinInput.value = "1234"; pinInput.oninput();
    app.document.getElementById("whoPinContinue").onclick();

    assert.strictEqual(app.exec(`sessionUser`), "Rudo");
    assert.strictEqual(app.exec(`sessionStaffId`), rudo.id);
    assert.deepStrictEqual(app.exec(`currentStaff()`), rudo, "currentStaff() — the existing accessor used elsewhere in the app — now resolves this session's staff");
    assert.strictEqual(app.exec(`route`), "pos");
    assert.strictEqual(app.exec(`getSetting("last_staff_id","")`), String(rudo.id));
  });

  await t("a wrong PIN is rejected with attemptPinLogin's own message, staying on the PIN screen, session untouched", ()=>{
    const app = makeDomApp(baseSettings);
    app.exec(`setSetting("single_operator_mode","0");`);
    const rudo = addStaffWithPin(app, "Rudo", "1234");
    app.exec(`renderWhoAmI();`);
    app.document.getElementById("whoSelect").value = String(rudo.id);
    app.document.getElementById("whoSelectContinue").onclick();
    const pinInput = app.document.getElementById("whoPin");
    pinInput.value = "0000"; pinInput.oninput();
    app.document.getElementById("whoPinContinue").onclick();

    assert.strictEqual(app.exec(`sessionStaffId`), null, "not logged in");
    assert.strictEqual(app.exec(`route`), "whoami", "stays on the login screen");
    assert.ok(/Incorrect PIN/.test(app.document.getElementById("app").textContent), "attemptPinLogin's message is shown, not a generic/silent failure");
    assert.ok(app.document.getElementById("whoPin"), "still on the PIN step, ready to retry");
  });

  await t("lockout after repeated wrong PINs shows staff.js's own lockout message on the real screen", ()=>{
    const app = makeDomApp(baseSettings);
    app.exec(`setSetting("single_operator_mode","0");`);
    const rudo = addStaffWithPin(app, "Rudo", "1234");
    app.exec(`renderWhoAmI();`);
    app.document.getElementById("whoSelect").value = String(rudo.id);
    app.document.getElementById("whoSelectContinue").onclick();
    for(let i=0;i<5;i++){
      const pinInput = app.document.getElementById("whoPin");
      pinInput.value = "0000"; pinInput.oninput();
      app.document.getElementById("whoPinContinue").onclick();
    }
    assert.ok(/Too many incorrect PIN attempts/.test(app.document.getElementById("app").textContent), "the real lockout message from attemptPinLogin() reaches the screen");
    // Even the correct PIN is refused while locked — proves the screen
    // genuinely calls attemptPinLogin() (which enforces this) rather than
    // checking the hash itself.
    const pinInput = app.document.getElementById("whoPin");
    pinInput.value = "1234"; pinInput.oninput();
    app.document.getElementById("whoPinContinue").onclick();
    assert.strictEqual(app.exec(`sessionStaffId`), null, "still locked out, even with the right PIN");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
