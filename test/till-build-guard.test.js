// Run: node --no-warnings test/till-build-guard.test.js
// Build guard: shared stock can't start until every active till in the
// branch has reported build v7+ at check-in. The device is the REAL app
// source over SQLite (test/harness.js); "Digital Commerce" is the REAL server
// SQL (live stub + Phase 1, 2, 3a, 3b + the guard) in an in-memory PGlite,
// called as role anon exactly as PostgREST would. Nothing reaches the live project.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeApp } = require("./harness");
const { LIVE_STUB } = require("../supabase/tests/live-stub");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
const MIG = (f)=>fs.readFileSync(path.join(__dirname,"..","supabase","migrations",f+".sql"),"utf8");

let pg;
const CASTS = { p_rows:"::jsonb", p_branch_id:"::uuid", p_cursor:"::bigint", p_rpn_hint_id:"::uuid", p_app_build:"::integer" };
// One statement at a time on the single PGlite connection (role switching is
// per connection): the app's own fire-and-forget calls (check-in's licence
// pick-up, activation.js) mustn't interleave with the test's queries.
let queue = Promise.resolve();
const serial = (fn)=>{ const p = queue.then(fn, fn); queue = p.catch(()=>{}); return p; };
function serverRpc(name, body){ return serial(()=>serverRpcNow(name, body)); }
async function serverRpcNow(name, body){
  const keys = Object.keys(body);
  const vals = keys.map(k=> k==="p_rows"? JSON.stringify(body[k]) : body[k]);
  const sql = `select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}${CASTS[k]||""}`).join(",")})::json j`;
  await pg.exec("set role anon");
  try{
    const data = (await pg.query(sql, vals)).rows[0].j;
    return (data && data.error)? { ok:false, reason:"refused", code:data.error, data } : { ok:true, data };
  }catch(e){ return { ok:false, reason:"rejected", message:e.message }; }
  finally{ await pg.exec("reset role"); }
}
// cl_device_checkin goes through fetch (devicecheckin.js), not terminalRpc
function checkinFetch(app){
  app.hook("fetch", async (url, opts)=>{
    assert.match(url, /\/rpc\/cl_device_checkin$/);
    const r = await serverRpc("cl_device_checkin", JSON.parse(opts.body));
    if(!r.ok) return { ok:false, status:400, text: async()=>JSON.stringify({ message:r.message }) };
    return { ok:true, json: async()=>r.data };
  });
}
function device(o){
  const A = makeApp(Object.assign({ setup_complete:"1", shop_name:"Gentronix", secret_phrase:"Gold Leaf 42", currency:"$" }, o));
  A.hook("terminalRpc", serverRpc);
  A.hook("getThumb", async ()=>null);
  checkinFetch(A);
  A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999',?,1,'x')",[o.branch_name||""]);
  return A;
}
const sq = (sql, p)=> serial(async ()=> (await pg.query(sql, p)).rows);

(async()=>{
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  pg = new PGlite({ extensions:{ pgcrypto } });
  await pg.exec(LIVE_STUB);
  for(const f of ["20261004120000_multi_terminal_identity","20261004180000_multi_terminal_phase2","20261006120000_catalogue_sync",
                  "20261007120000_shared_stock","20261008120000_till_build_guard","20261008140000_shared_stock_checkin_lock"])
    await pg.exec(MIG(f));

  const M1 = device({ branch_name:"Harare", branch_type:"main", install_id:"TIL1" });
  M1.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES('Rice 2kg',5,30,3,'RICE',?,'',2,'2026-01-01','')",[M1.api.currentBranch()]);
  M1.api.migrate(M1.db);
  const reg = (await M1.api.registerMainBranch("Front")).data;
  await M1.api.catalogueSyncNow({}); await M1.api.catApplyBaseline({}); await M1.api.catalogueSyncNow({});
  const code = (await M1.api.issueJoinCode({ branchId:reg.branch_id })).data.code;
  const M2 = device({ branch_name:"", branch_type:"main", install_id:"TIL2" });
  const j = await M2.api.joinBusiness({ phrase:"Gold Leaf 42", code, label:"Back", devicePhrase:"Gold Leaf 42", expectedBranchName:null });
  assert.ok(j.ok, JSON.stringify(j));
  M2.api.setSetting("branch_name", j.data.branch_name);
  await M1.api.stockSyncNow({});
  const buildOf = async (inst)=> (await sq(`select app_build from cl_terminals where install_id=$1`,[inst]))[0].app_build;

  await t("a till that hasn't reported its build blocks the start; the message names it", async ()=>{
    await assert.rejects(()=>M1.api.sharedStockStart("9999"),
      (e)=>{ assert.strictEqual(e.message, "Till T2 (Back) must update the app first: shared stock needs build v7 or later on every till, and it hasn't reported its build yet. Open the app on that till while online (it updates and checks in), then try again."); return true; });
    assert.strictEqual((await sq(`select stock_mode from cl_branches where id=$1`,[reg.branch_id]))[0].stock_mode, "local");
    assert.strictEqual(M1.api.getSetting("stock_mode",""), "local", "nothing changed on the till either");
    assert.strictEqual(M1.api.one("SELECT stock FROM products WHERE sku='RICE'").stock, 30);
  });

  await t("check-in reports this app's build (sw-pwa.js build: vN)", async ()=>{
    const r = await M2.api.deviceCheckin();
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(await buildOf("TIL2"), M2.api.APP_BUILD);
    assert.ok(M2.api.APP_BUILD >= 8);
  });

  await t("an old build on T2 (reports v6): the message says which build it runs", async ()=>{
    await serverRpc("cl_device_checkin", { p_install_id:"TIL2", p_shop_secret_phrase:"Gold Leaf 42", p_device_code:"X", p_business_name:"Gentronix",
      p_device_key:M2.api.getSetting("device_key",""), p_app_build:6 });
    await assert.rejects(()=>M1.api.sharedStockStart("9999"), /^Error: Till T2 \(Back\) must update the app first: .* and it runs build v6\./);
  });

  await t("once T2 checks in on this build, the start goes ahead", async ()=>{
    await M2.api.deviceCheckin();
    const r = await M1.api.sharedStockStart("9999");
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual((await sq(`select stock_mode from cl_branches where id=$1`,[reg.branch_id]))[0].stock_mode, "shared");
    assert.strictEqual(M1.api.getSetting("stock_mode",""), "shared");
  });

  await t("shared branch: a till whose check-in sends no build (an older app) gets its cart locked; updating lifts it", async ()=>{
    const LOCK_MSG = "This branch uses shared stock. Update the app before selling: tap Reload on the update banner, or reopen the app while online.";
    // the same app, but its check-in body has no p_app_build, as every build before v8 sends it
    M2.hook("fetch", async (url, opts)=>{
      const body = JSON.parse(opts.body); delete body.p_app_build;
      const r = await serverRpc("cl_device_checkin", body);
      return r.ok? { ok:true, json: async()=>r.data } : { ok:false, status:400, text: async()=>JSON.stringify({ message:r.message }) };
    });
    assert.ok((await M2.api.deviceCheckin()).ok);
    assert.strictEqual(M2.api.dcLockCartReason(), LOCK_MSG, "the cart is locked with the update message");
    assert.strictEqual(M2.api.dcLockAddProductReason(), "", "adding products is not locked");
    checkinFetch(M2);
    assert.ok((await M2.api.deviceCheckin()).ok);
    assert.strictEqual(M2.api.dcLockCartReason(), "", "the first check-in on this build lifts it");
    assert.strictEqual(M1.api.getSetting("dc_lock_cart",""), "", "T1 (this build) was never locked");
  });

  await pg.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
