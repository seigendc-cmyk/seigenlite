// Run: node --no-warnings test/branch-business-day.test.js
// Phase 3c add-on: main sets "Business day ends at" per branch; each till of
// that branch picks it up with the catalogue pull and applies it under the
// same rules as a change made on the till (no open shift; the old and new
// rules agree on today's date). Real app source (test/harness.js) against the
// REAL server SQL (live stub + Phase 1, 2, 3a, 3b, build guard, check-in lock
// + supabase/migrations/20261009120000_branch_business_day.sql) in PGlite.
"use strict";
process.env.TZ = "Africa/Harare";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { makeApp } = require("./harness");
const { LIVE_STUB } = require("../supabase/tests/live-stub");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
const at = (s)=> Date.parse(s+":00+02:00");
let pg;
const CASTS = { p_rows:"::jsonb", p_lines:"::jsonb", p_moves:"::jsonb", p_sales:"::jsonb", p_counts:"::jsonb", p_uids:"::text[]", p_branch_id:"::uuid",
  p_cursor:"::bigint", p_limit:"::integer", p_hours:"::integer" };
const JSONB = ["p_rows","p_lines","p_moves","p_sales","p_counts"];
async function rpc(name, body){
  const keys = Object.keys(body);
  const vals = keys.map(k=> JSONB.includes(k)? JSON.stringify(body[k]) : k==="p_uids"? "{"+body[k].join(",")+"}" : body[k]);
  await pg.exec("set role anon");
  try{ const data = (await pg.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}${CASTS[k]||""}`).join(",")})::json j`, vals)).rows[0].j;
    return (data && data.error)? { ok:false, reason:"refused", code:data.error, data } : { ok:true, data }; }
  catch(e){ return { ok:false, reason:"rejected", message:e.message }; }
  finally{ await pg.exec("reset role"); }
}
function device(o){
  const A = makeApp(Object.assign({ setup_complete:"1", shop_name:"Gentronix", secret_phrase:"Gold Leaf 42", currency:"$" }, o));
  vm.runInContext(`(function(){ const R = Date; globalThis.__now = R.now();
    class D extends R { constructor(...a){ if(a.length) super(...a); else super(globalThis.__now); } static now(){ return globalThis.__now; } }
    Date = D; })()`, A.ctx);
  A.clock = (s)=>{ A.ctx.__now = at(s); };
  A.clock("2026-10-07T10:00");
  A.hook("terminalRpc", rpc); A.hook("getThumb", async ()=>null); A.hook("downloadDb", ()=>{}); A.hook("printReceipt", ()=>{});
  A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999',?,1,'x')",[o.branch_name||""]);
  A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES('Rice',5,10,3,'RICE',?,'',2,'2026-01-01','')",[o.branch_name||""]);
  return A;
}
const cutoff = (A)=> vm.runInContext("businessCutoffHours()", A.ctx);
const call = (A, js)=> vm.runInContext(js, A.ctx);

(async()=>{
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  pg = new PGlite({ extensions:{ pgcrypto } });
  await pg.exec(LIVE_STUB);
  for(const f of ["20261004120000_multi_terminal_identity","20261004180000_multi_terminal_phase2","20261006120000_catalogue_sync","20261007120000_shared_stock",
                  "20261008120000_till_build_guard","20261008140000_shared_stock_checkin_lock","20261009120000_branch_business_day"])
    await pg.exec(fs.readFileSync(path.join(__dirname,"..","supabase","migrations",f+".sql"),"utf8").replace(/\r\n/g,"\n"));

  const M = device({ branch_name:"Harare", branch_type:"main", install_id:"MAIN1" });
  const reg = (await M.api.registerMainBranch("Front")).data;
  await M.api.catalogueSyncNow({}); await M.api.catApplyBaseline({}); await M.api.catalogueSyncNow({});
  const code = (await M.api.issueJoinCode({ newBranchName:"Murehwa" })).data.code;
  const R = device({ branch_name:"", branch_type:"remote", install_id:"REM1" });
  const j = await R.api.joinBusiness({ phrase:"Gold Leaf 42", code, label:"till", devicePhrase:"Gold Leaf 42", expectedBranchName:null });
  assert.ok(j.ok, JSON.stringify(j));
  R.api.setSetting("branch_name", j.data.branch_name); R.api.setSetting("branch_type","remote");
  { const c = await R.api.catalogueSyncNow({}); if(c && c.needsReport){ await R.api.catApplyBaseline({}); await R.api.catalogueSyncNow({}); } }
  M.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Murehwa','')");
  const server = async ()=> (await pg.query(`select name, business_day_cutoff from cl_branches order by name`)).rows.map(r=>r.name+" "+r.business_day_cutoff);

  await t("main sets Murehwa to 03:00 (Admin passcode, logged); it reaches Digital Commerce with the next sync", async ()=>{
    assert.throws(()=>call(M, `setBranchBusinessDay("Murehwa", 3, "0000")`), /Incorrect Admin passcode/);
    assert.throws(()=>call(M, `setBranchBusinessDay("Murehwa", 7, "9999")`), /00:00 to 06:00/);
    assert.throws(()=>call(R, `setBranchBusinessDay("Murehwa", 3, "9999")`), /Only a till of the main branch/);
    call(M, `setBranchBusinessDay("Murehwa", 3, "9999")`);
    assert.match(M.api.one("SELECT details FROM audit_log WHERE action='Business day end set for a branch'").details, /Murehwa: 03:00/);
    await M.api.catalogueSyncNow({});
    assert.deepStrictEqual(await server(), ["Harare null", "Murehwa 3"]);
    assert.match(call(M, "businessDayCardHtml()"), /Set for each branch[\s\S]*Murehwa/, "main's card lists the branches");
  });

  await t("the Murehwa till applies it on its next pull (no shift open); its own selector becomes read-only", async ()=>{
    assert.strictEqual(cutoff(R), 0);
    await R.api.catalogueSyncNow({});
    assert.strictEqual(cutoff(R), 3);
    assert.match(R.api.one("SELECT details FROM audit_log WHERE action='Business day end changed (set by main)'").details, /00:00 → 03:00/);
    const html = call(R, "businessDayCardHtml()");
    assert.match(html, /<select class="field" id="sBizCutoff" disabled>/);
    assert.match(html, /Set by main: 03:00\./);
    assert.ok(!/saveBizCutoff/.test(html), "no Save button on the till");
    assert.throws(()=>call(R, `setBusinessDayCutoff(1, "9999")`), /Main sets when this branch's business day ends \(03:00\)/);
    assert.strictEqual(cutoff(M), 0, "Harare isn't set: main keeps its own");
  });

  await t("a shift is open: main's new time waits, and applies after End of Day", async ()=>{
    R.api.startShift("0");
    call(M, `setBranchBusinessDay("Murehwa", 2, "9999")`); await M.api.catalogueSyncNow({});
    await R.api.catalogueSyncNow({});
    assert.strictEqual(cutoff(R), 3, "not while the shift is open");
    assert.match(call(R, "businessDayCardHtml()"), /Set by main: 02:00\. Applies after this shift's End of Day\./);
    R.api.completeEOD("0");
    assert.strictEqual(cutoff(R), 2, "applied right after End of Day");
  });

  await t("the old and new rules disagree on today's date (02:30, 02:00 → 05:00): waits until they agree", async ()=>{
    call(M, `setBranchBusinessDay("Murehwa", 5, "9999")`); await M.api.catalogueSyncNow({});
    R.clock("2026-10-08T02:30");
    await R.api.catalogueSyncNow({});
    assert.strictEqual(cutoff(R), 2, "at 02:30 the new rule would say 7 Oct, the old one 8 Oct");
    R.clock("2026-10-08T05:30");
    await R.api.catalogueSyncNow({});
    assert.strictEqual(cutoff(R), 5);
  });

  await t("main clears it: the till keeps its time and can change it again; an older server (no key) changes nothing", async ()=>{
    call(M, `setBranchBusinessDay("Murehwa", "", "9999")`); await M.api.catalogueSyncNow({});
    await R.api.catalogueSyncNow({});
    assert.strictEqual(cutoff(R), 5, "kept");
    assert.ok(!/disabled/.test(call(R, "businessDayCardHtml()").match(/<select[^>]*id="sBizCutoff"[^>]*>/)[0]), "editable again");
    assert.strictEqual(call(R, "applyBranchBusinessDay(undefined)"), null);
    assert.strictEqual(cutoff(R), 5);
  });

  await t("unregistered and single-till shops keep their own setting", async ()=>{
    const U = makeApp({ setup_complete:"1", branch_name:"Solo", branch_type:"main" });
    U.hook("terminalRpc", async ()=>{ throw new Error("must not be called"); });
    U.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999','Solo',1,'x')");
    vm.runInContext(`setBusinessDayCutoff(3, "9999")`, U.ctx);
    assert.strictEqual(vm.runInContext("businessCutoffHours()", U.ctx), 3);
    assert.ok(!/Set by main|Set for each branch/.test(vm.runInContext("businessDayCardHtml()", U.ctx)));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
