// Test-only help for the browser tests that finish setup and then sell.
//
// Trial rules (v18): a device set up without the free trial is "pretrial"
// and can't sell, take returns or open Reports and Marketing. Tests that
// aren't about the trial give their device an activation the way an
// old-style code would have left it (activated_until with source "code"),
// by writing the app's own database in IndexedDB, then reload and sign in
// at the Start screen. Nothing in the app is changed for this; the trial
// itself is tested end to end in test/trial-e2e.test.js.
"use strict";

const OWNER_PHONE = "0771234567";   // setup step 2's required owner's phone

async function writeSettings(page, pairs){
  await page.evaluate(async (pairs)=>{
    const open = ()=> new Promise((res, rej)=>{ const r = indexedDB.open("seigen_lite_db", 1); r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); });
    const conn = await open();
    const bytes = await new Promise((res, rej)=>{ const g = conn.transaction("kv","readonly").objectStore("kv").get("dbfile"); g.onsuccess = ()=>res(g.result); g.onerror = ()=>rej(g.error); });
    const SQL = await initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/"+f });
    const d = new SQL.Database(new Uint8Array(bytes));
    for(const [k, v] of pairs){ d.run("DELETE FROM settings WHERE key=?", [k]); d.run("INSERT INTO settings(key,value) VALUES(?,?)", [k, v]); }
    const out = d.export(); d.close();
    await new Promise((res, rej)=>{ const tx = conn.transaction("kv","readwrite"); tx.objectStore("kv").put(out, "dbfile"); tx.oncomplete = ()=>res(); tx.onerror = ()=>rej(tx.error); });
  }, pairs);
}

// After setup's Finish: activate, reload, sign in (single operator, no PINs).
// o: { name } the operator's name at "Who's working today?" (default "Test User").
async function activateForTest(page, o){
  o = o || {};
  await page.waitForTimeout(800);   // let setup's own saves (check-in etc.) land first
  const until = new Date(Date.now() + 30*86400000).toISOString();
  for(let i = 0; i < 3; i++){
    await writeSettings(page, [["activated_until", until], ["activated_until_src", "code"]]);
    await page.reload();
    await page.waitForSelector("#startSignIn", { timeout: 30000 });
    await page.click("#startSignIn");
    await page.waitForSelector("#whoName, #logoutBtn");
    if(await page.$("#whoName")){ await page.fill("#whoName", o.name || "Test User"); await page.click("#whoContinue"); }
    await page.waitForSelector("#logoutBtn");
    if(!(await page.$("#pretrialNotice"))) return;
    await page.waitForTimeout(500);   // a late save overwrote it: again
  }
  throw new Error("activateForTest: the device is still before its trial");
}

// After "Join and finish setup": the till asks for the business trial's cover
// (trial.js) and shows the answer. Tests without the issue-trial function (or
// with a main that has no trial) carry on without it.
async function passJoinTrialScreen(page){
  await page.waitForSelector("#trialSkip, #trialContinue", { timeout: 30000 });
  await page.click((await page.$("#trialContinue"))? "#trialContinue" : "#trialSkip");
  await page.waitForSelector("[data-route]");
}

module.exports = { OWNER_PHONE, activateForTest, writeSettings, passJoinTrialScreen };
