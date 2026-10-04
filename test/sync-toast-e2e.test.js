// Run: node --no-warnings test/sync-toast-e2e.test.js
//
// Sync reminder toast (src/sync.js): real DOM (jsdom). The trigger logic
// (syncReminderShouldShow/checkSyncReminderModal) is covered headless in
// test/rpn-support-modal.test.js; this file covers what the shop actually
// sees — a small .sync-toast instead of a modal, gone after a few seconds
// or on any tap outside it, and never wiped by a re-render of #app.
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

function makeDomApp(){
  const dom = new JSDOM(`<!DOCTYPE html><body><div id="app"><div class="topbar"><button id="inside">x</button></div></div></body>`,
    { url: "http://localhost/" });
  const window = dom.window;
  Object.defineProperty(window.navigator, "onLine", { configurable:true, get:()=>false });
  const db = new Compat();
  const sqlCtor = function(x){ return x && x.__db ? x.__db : new Compat(); };
  const ctx = vm.createContext(Object.assign(window, { console, SQLctor: sqlCtor, __db: db }));
  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="pos", cart=[], drawerOpen=false;
    function render(){}
  `;
  const code = prelude
    + ["db.js","utils.js","docnum.js","devicecheckin.js","sync.js"].map(src).join("\n")
    + `\n;this.api={ enqueueSync, checkSyncReminderModal, syncReminderVisible, dismissSyncReminder, SYNC_TOAST_MS };`;
  vm.runInContext(code, ctx, { filename: "app-sources" });
  vm.runInContext(`db.run(SCHEMA); migrate(db);`, ctx);
  return { api: ctx.api, document: window.document, window };
}

const wait = (ms)=> new Promise(r=>setTimeout(r, ms));
let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}

(async ()=>{
  await t("shows a small toast (not a modal) while offline with records waiting", ()=>{
    const A = makeDomApp();
    A.api.enqueueSync("sync_health_check", {});
    A.api.enqueueSync("sync_health_check", {});
    A.api.checkSyncReminderModal();
    assert.strictEqual(A.document.querySelector(".modalOverlay"), null, "no modal");
    const toast = A.document.querySelector(".sync-toast");
    assert.ok(toast, "toast is in the page");
    assert.ok(toast.classList.contains("show"));
    assert.ok(/2 records/.test(toast.textContent), toast.textContent);
    assert.strictEqual(toast.parentNode, A.document.body, "outside #app, so render() can't wipe it");
    A.api.dismissSyncReminder();
  });
  await t("dismisses itself after SYNC_TOAST_MS", async ()=>{
    const A = makeDomApp();
    A.api.enqueueSync("sync_health_check", {});
    A.api.checkSyncReminderModal();
    assert.strictEqual(A.api.syncReminderVisible(), true);
    await wait(A.api.SYNC_TOAST_MS - 1000);
    assert.strictEqual(A.api.syncReminderVisible(), true, "still up before the timeout");
    const deadline = Date.now() + 5000; // timers run late when the machine is busy
    while(A.document.querySelector(".sync-toast") && Date.now() < deadline) await wait(50);
    assert.strictEqual(A.api.syncReminderVisible(), false);
    assert.strictEqual(A.document.querySelector(".sync-toast"), null, "removed after sliding out");
  });
  await t("a tap outside it dismisses it at once; a tap on it doesn't", async ()=>{
    const A = makeDomApp();
    A.api.enqueueSync("sync_health_check", {});
    A.api.checkSyncReminderModal();
    const toast = A.document.querySelector(".sync-toast");
    toast.dispatchEvent(new A.window.Event("pointerdown", { bubbles:true }));
    assert.strictEqual(A.api.syncReminderVisible(), true, "tap on the toast keeps it");
    A.document.getElementById("inside").dispatchEvent(new A.window.Event("pointerdown", { bubbles:true }));
    assert.strictEqual(A.api.syncReminderVisible(), false, "tap elsewhere closes it");
    assert.ok(!toast.classList.contains("show"), "slides out");
    await wait(300);
    assert.strictEqual(A.document.querySelector(".sync-toast"), null);
  });
  await t("still comes back on the next check while records are unsynced (trigger unchanged)", ()=>{
    const A = makeDomApp();
    A.api.enqueueSync("sync_health_check", {});
    A.api.checkSyncReminderModal();
    A.api.dismissSyncReminder();
    A.api.checkSyncReminderModal();
    assert.strictEqual(A.api.syncReminderVisible(), true);
    assert.strictEqual(A.document.querySelectorAll(".sync-toast.show").length, 1, "never stacks");
    A.api.dismissSyncReminder();
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})();
