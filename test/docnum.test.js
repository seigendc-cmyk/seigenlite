// Run: node test/docnum.test.js   (Node 22.5+ for node:sqlite)
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const { DatabaseSync } = require("node:sqlite");

// Load src/docnum.js (IIFE-inner code) with the db.js helpers stubbed over an
// in-memory SQLite, using the real SCHEMA text pulled from src/db.js.
const src = (f)=>fs.readFileSync(path.join(__dirname,"..","src",f),"utf8");
const schema = /const SCHEMA = `([\s\S]*?)`;/.exec(src("db.js"))[1];
const alters = [...src("db.js").matchAll(/"(ALTER TABLE[^"]+)"/g)].map(m=>m[1]); // migrate()'s list
function migrate(db){ alters.forEach(a=>{ try{ db.exec(a); }catch(e){} }); }
function load(){
  const db = new DatabaseSync(":memory:"); db.exec(schema); migrate(db);
  let persists = 0;
  const ctx = {
    run:(sql,p=[])=>db.prepare(sql).run(...p),
    one:(sql,p=[])=>db.prepare(sql).get(...p)||null,
    getSetting:(k,f="")=>{ const r=db.prepare("SELECT value FROM settings WHERE key=?").get(k); return r?r.value:f; },
    setSetting:(k,v)=>db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,String(v)),
    uid4:()=>Math.random().toString(36).slice(2,6).toUpperCase(),
    persist:async()=>{ persists++; },
  };
  vm.createContext(ctx);
  vm.runInContext(src("docnum.js")+"\nthis.api={formatDocNo,sanitizeBranchName,dnFileBase,grvFileBase,dnFileName,grvFileName,DOC_FILE_EXT,getBranchId,nextDocNumber,recordDispatchDoc,hasDispatchDoc};",ctx);
  return { api: ctx.api, db, ctx, persists:()=>persists };
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+e.message); }
}
const D=(y,mo,d,h,mi)=>new Date(y,mo-1,d,h,mi);

(async()=>{
  const { api } = load();
  await t("padding", ()=>{
    assert.strictEqual(api.formatDocNo("DN",1),"DN0001");
    assert.strictEqual(api.formatDocNo("GRV",12),"GRV0012");
    assert.strictEqual(api.formatDocNo("DN",9999),"DN9999");
  });
  await t("rollover past 9999 grows, never wraps", ()=>{
    assert.strictEqual(api.formatDocNo("DN",10000),"DN10000");
    assert.strictEqual(api.formatDocNo("GRV",123456),"GRV123456");
  });
  await t("rejects bad numbers", ()=>{
    for(const bad of [-1,1.5,NaN,"3",null]) assert.throws(()=>api.formatDocNo("DN",bad));
  });
  await t("spec examples", ()=>{
    assert.strictEqual(api.dnFileBase(12,"Boka",D(2026,9,4,8,0)),"DN0012-Boka-04Sep26-0800AM");
    assert.strictEqual(api.grvFileBase(7,"Boka",D(2026,9,5,14,15)),"GRV0007-Boka-05Sep26-0215PM");
  });
  await t("midnight and noon", ()=>{
    assert.ok(api.dnFileBase(1,"A",D(2026,1,1,0,0)).endsWith("-1200AM"));
    assert.ok(api.dnFileBase(1,"A",D(2026,1,1,0,5)).endsWith("-1205AM"));
    assert.ok(api.dnFileBase(1,"A",D(2026,1,1,12,0)).endsWith("-1200PM"));
    assert.ok(api.dnFileBase(1,"A",D(2026,1,1,23,59)).endsWith("-1159PM"));
    assert.ok(api.dnFileBase(1,"A",D(2026,1,1,11,59)).endsWith("-1159AM"));
  });
  await t("single-digit days/years and all months", ()=>{
    assert.ok(api.dnFileBase(1,"A",D(2026,1,1,9,7)).includes("-01Jan26-0907AM"));
    assert.ok(api.dnFileBase(1,"A",D(2005,3,9,9,7)).includes("-09Mar05-"));
    const m=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    m.forEach((n,i)=>assert.ok(api.dnFileBase(1,"A",D(2026,i+1,15,9,0)).includes("-15"+n+"26-")));
  });
  await t("awkward branch names", ()=>{
    const s=api.sanitizeBranchName;
    assert.strictEqual(s("Harare CBD"),"HarareCBD");
    assert.strictEqual(s("A/B\\C:D*E?F\"G<H>I|J"),"ABCDEFGHIJ");
    assert.strictEqual(s("  St. Mary's  #2 "),"StMarys2");
    assert.strictEqual(s("Z\u00fcrich Caf\u00e9"),"ZurichCafe");
    assert.strictEqual(s("...///"),"Branch");
    assert.strictEqual(s(""),"Branch");
    assert.strictEqual(s(null),"Branch");
    assert.strictEqual(s("\u65e5\u672c\u5e97"),"Branch");
    assert.strictEqual(s("x".repeat(80)).length,24);
    for(const n of ["a:b","C:\\x","a\u0000b","con.","Boka "]) assert.ok(!/[^A-Za-z0-9]/.test(s(n)));
  });
  await t("no illegal characters in any file name", ()=>{
    const n=api.grvFileName(3,"Bad:/\\*?\"<>| Name",D(2026,9,19,14,15));
    assert.ok(!/[\\/:*?"<>|\s]/.test(n), n);
  });
  await t("extension is one constant", ()=>{
    assert.strictEqual(api.dnFileName(1,"A",D(2026,1,1,9,0)),api.dnFileBase(1,"A",D(2026,1,1,9,0))+api.DOC_FILE_EXT);
    assert.strictEqual(api.grvFileName(1,"A",D(2026,1,1,9,0)),api.grvFileBase(1,"A",D(2026,1,1,9,0))+api.DOC_FILE_EXT);
  });

  await t("counters: sequential, independent per type", async ()=>{
    const { api } = load();
    assert.strictEqual((await api.nextDocNumber("DN")).text,"DN0001");
    assert.strictEqual((await api.nextDocNumber("DN")).text,"DN0002");
    assert.strictEqual((await api.nextDocNumber("GRV")).text,"GRV0001");
    assert.strictEqual((await api.nextDocNumber("DN")).text,"DN0003");
  });
  await t("counters: double-tap (concurrent calls) never duplicate", async ()=>{
    const { api } = load();
    const r = await Promise.all([1,2,3,4,5].map(()=>api.nextDocNumber("DN")));
    assert.deepStrictEqual(r.map(x=>x.n).sort(),[1,2,3,4,5]);
  });
  await t("counters: a failed save does not roll the number back", async ()=>{
    const { api, ctx } = load();
    ctx.persist = async()=>{ throw new Error("disk full"); };
    await assert.rejects(()=>api.nextDocNumber("DN"));
    ctx.persist = async()=>{};
    assert.strictEqual((await api.nextDocNumber("DN")).text,"DN0002");
  });
  await t("counters: persisted on every issue", async ()=>{
    const { api, persists } = load();
    await api.nextDocNumber("DN"); await api.nextDocNumber("GRV");
    assert.strictEqual(persists(),2);
  });
  await t("counters: separate branches each start at 0001", async ()=>{
    const a=load(), b=load();
    assert.strictEqual((await a.api.nextDocNumber("DN")).text,"DN0001");
    assert.strictEqual((await b.api.nextDocNumber("DN")).text,"DN0001");
    assert.notStrictEqual(a.api.getBranchId(),b.api.getBranchId());
  });
  await t("counters: branch_id is stable, and survives a branch rename", async ()=>{
    const { api, ctx } = load();
    const id=api.getBranchId(); ctx.setSetting("branch_name","Renamed");
    assert.strictEqual(api.getBranchId(),id);
    await api.nextDocNumber("DN");
    assert.strictEqual((await api.nextDocNumber("DN")).text,"DN0002");
  });
  await t("counters: unknown type rejected", async ()=>{
    const { api } = load();
    await assert.rejects(()=>api.nextDocNumber("XYZ"));
  });
  await t("existing data untouched: schema is additive and re-runnable", ()=>{
    const { db } = load();
    db.prepare("INSERT INTO products(name,price,stock) VALUES('x',1,2)").run();
    db.exec(schema); migrate(db); // simulates the next startup's db.run(SCHEMA) + migrate()
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM products").get().c,1);
  });

  await t("duplicate protection: same (branch, DN) rejected, other branch accepted", async ()=>{
    const { api } = load();
    const d={dispatchBranchId:"B-AAA",dispatchBranchName:"Boka",dnNo:12,receiveBranchName:"CBD",direction:"received",grvNo:1};
    assert.strictEqual(await api.recordDispatchDoc(d),true);
    assert.strictEqual(api.hasDispatchDoc("B-AAA",12),true);
    assert.strictEqual(await api.recordDispatchDoc(d),false);
    assert.strictEqual(await api.recordDispatchDoc({...d,grvNo:2}),false);
    assert.strictEqual(await api.recordDispatchDoc({...d,dispatchBranchId:"B-BBB"}),true); // both branches have DN0012
    assert.strictEqual(await api.recordDispatchDoc({...d,dnNo:13}),true);
    assert.strictEqual(api.hasDispatchDoc("B-AAA",99),false);
  });
  await t("duplicate protection holds even if the branch is renamed", async ()=>{
    const { api } = load();
    await api.recordDispatchDoc({dispatchBranchId:"B-AAA",dispatchBranchName:"Boka",dnNo:5});
    assert.strictEqual(await api.recordDispatchDoc({dispatchBranchId:"B-AAA",dispatchBranchName:"Boka Renamed",dnNo:5}),false);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
