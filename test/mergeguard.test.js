// Run: node --no-warnings test/mergeguard.test.js
// The old data-backup merge import must refuse a Delivery Note by CONTENT and change nothing.
"use strict";
const assert = require("assert");
const vm = require("vm");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,4).join("\n       ")); }
}
const fileOf = (name, bytes)=>({ name, bytes:new Uint8Array(bytes) });
const THUMB = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

// Every table's full contents, so "changes nothing" really means nothing.
function snapshot(app){
  const names = app.api.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
  return JSON.stringify(names.map(n=>[n, app.api.all("SELECT * FROM "+n)]));
}
function rig(){
  const app = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES('Rice',5,10,1,'SK1','CBD','',3,'2026-01-01','')");
  const calls = { download:0, merge:0, persist:0, render:0, alerts:[], modals:[], confirms:0 };
  app.hook("downloadDb", ()=>{ calls.download++; });
  app.hook("mergeDatabase", async ()=>{ calls.merge++; });
  app.hook("persist", async ()=>{ calls.persist++; });
  app.hook("render", ()=>{ calls.render++; });
  app.hook("alert", (m)=>{ calls.alerts.push(m); });
  app.hook("confirm", ()=>{ calls.confirms++; return true; });
  app.hook("openModal", (title, html)=>{
    const btn = { onclick:null };
    const wrap = { title, html, btn, removed:false, remove(){ this.removed=true; }, querySelector:(sel)=> sel==="#dnGuardReceive" && /dnGuardReceive/.test(html) ? btn : null };
    calls.modals.push(wrap); return wrap;
  });
  return { app, calls };
}
async function makeDN(app){
  const d = await app.api.buildDN({ dnNo:12, fromBranchId:"B-ABCD1234", fromName:"Boka", toName:"CBD", createdIso:"2026-09-04T08:00:00+02:00",
    items:[{code:"SK1",name:"Rice",qty:3,thumb:THUMB}] });
  return Buffer.from(app.api.serializeDN(d),"utf8");
}

(async()=>{
  await t("sniffing: DN recognised by content; other files are not", async ()=>{
    const { app } = rig(); const dn = await makeDN(app);
    const is = (b)=>app.api.isDNFileBytes(new Uint8Array(b));
    assert.strictEqual(is(dn), true);
    assert.strictEqual(is(Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]),Buffer.from("  \n"),dn])), true, "BOM and leading whitespace");
    assert.strictEqual(is(dn.subarray(0,dn.length-40)), true, "truncated DN still gets the friendly message");
    assert.strictEqual(is(Buffer.from('{"format":"seigen-dn","format_version":9}')), true, "any version");
    assert.strictEqual(is(Buffer.concat([Buffer.from("SQLite format 3\0"),Buffer.alloc(200)])), false);
    for(const s of ['{"format":"something-else"}','{"a":{"format":"seigen-dn"}}','[]','null','plain text','',' ','{']){
      assert.strictEqual(is(Buffer.from(s)), false, JSON.stringify(s));
    }
    assert.strictEqual(is(Buffer.from([0,1,2,3,255,254])), false);
  });

  for(const fname of ["DN0012-Boka-04Sep26-0800AM.json","renamed.txt","backup.sqlite","noextension","photo.jpg"]){
    await t("merge: a DN picked as "+fname+" changes nothing", async ()=>{
      const { app, calls } = rig(); const dn = await makeDN(app);
      const before = snapshot(app), dbRef = app.api.getDb();
      await app.api.onMergePicked(fileOf(fname, dn));
      assert.strictEqual(snapshot(app), before, "database unchanged");
      assert.strictEqual(app.api.getDb(), dbRef);
      assert.strictEqual(calls.merge,0,"mergeDatabase not called");
      assert.strictEqual(calls.download,0,"no pre-merge backup download either");
      assert.strictEqual(calls.persist,0); assert.strictEqual(calls.render,0);
      assert.strictEqual(calls.alerts.length,0,"no Merge complete / error alert");
      assert.strictEqual(calls.modals.length,1);
      assert.ok(/This is a Delivery Note, not a data backup\. Use Receive stock to receive it\./.test(calls.modals[0].html));
    });
  }
  await t("catalogue: a seigen-catalogue picked in the old merge changes nothing and points to Get catalogue", async ()=>{
    const { app, calls } = rig();
    const d = await app.api.buildCatalogue({ fromBranchId:"B-1", fromName:"Boka", toName:"CBD", createdIso:"2026-09-04T08:00:00+02:00", priceMode:"follow_main", managementWhatsapp:"", register:[], items:[{code:"SK1",name:"Rice",price:5}] });
    const file = fileOf("cat.txt", Buffer.from(app.api.serializeCatalogue(d),"utf8"));
    const before = snapshot(app), dbRef = app.api.getDb();
    await app.api.onMergePicked(file);
    assert.strictEqual(snapshot(app), before); assert.strictEqual(app.api.getDb(), dbRef);
    assert.strictEqual(calls.merge,0); assert.strictEqual(calls.download,0); assert.strictEqual(calls.persist,0); assert.strictEqual(calls.alerts.length,0);
    assert.strictEqual(calls.modals.length,1);
    assert.ok(/This is a Catalogue, not a data backup. Use Get catalogue./.test(calls.modals[0].html));
    assert.ok(/dnGuardReceive/.test(calls.modals[0].html), "openCatalogueWithFile exists in this build, so the button shows");
    let got = null; app.ctx.openCatalogueWithFile = (f)=>{ got = f; };
    vm.runInContext("openCatalogueWithFile = __oc;", Object.assign(app.ctx,{ __oc:(f)=>{ got = f; } }));
    await app.api.onMergePicked(file);
    calls.modals[1].btn.onclick();
    assert.strictEqual(got,file,"opens Get catalogue with the SAME file");
    await app.api.onReplacePicked(file);
    assert.strictEqual(calls.confirms,0); assert.strictEqual(app.api.getDb(), dbRef);
  });
  await t("replace: a DN is refused too, the live database is not swapped", async ()=>{
    const { app, calls } = rig(); const dn = await makeDN(app);
    const before = snapshot(app), dbRef = app.api.getDb();
    await app.api.onReplacePicked(fileOf("x.sqlite", dn));
    assert.strictEqual(app.api.getDb(), dbRef); assert.strictEqual(snapshot(app), before);
    assert.strictEqual(calls.confirms,0); assert.strictEqual(calls.download,0); assert.strictEqual(calls.persist,0);
    assert.strictEqual(calls.modals.length,1);
  });
  await t("button: Open Receive stock opens it with the SAME file", async ()=>{
    const { app, calls } = rig(); const dn = await makeDN(app);
    const file = fileOf("DN.json", dn);
    let got = null;
    app.hook("openReceiveWithFile", (f)=>{ got = f; });
    await app.api.onMergePicked(file);
    const m = calls.modals[0]; assert.ok(/dnGuardReceive/.test(m.html), "button shown now that Receive stock exists");
    m.btn.onclick();
    assert.strictEqual(m.removed,true); assert.strictEqual(got,file);
  });
  await t("a Goods Received Voucher file is refused too (button opens Import GRV)", async ()=>{
    const { app, calls } = rig();
    const g = await app.api.buildGRV({ grvNo:1, dnNo:2, fromBranchId:"B-1", fromName:"Boka", toBranchId:"B-2", toName:"CBD", receivedIso:"2026-09-05T14:15:00+02:00", items:[{code:"SK1",name:"Rice",qty:3}] });
    const before = snapshot(app);
    await app.api.onMergePicked(fileOf("grv.txt", Buffer.from(app.api.serializeGRV(g),"utf8")));
    assert.strictEqual(snapshot(app),before); assert.strictEqual(calls.merge,0); assert.strictEqual(calls.download,0);
    assert.ok(/Goods Received Voucher file, not a data backup/.test(calls.modals[0].html)); assert.ok(/Import GRV/.test(calls.modals[0].html) && /dnGuardReceive/.test(calls.modals[0].html));
  });
  await t("a real data backup still merges exactly as before", async ()=>{
    const { app, calls } = rig();
    const sqliteLike = Buffer.concat([Buffer.from("SQLite format 3\0"),Buffer.alloc(200)]);
    await app.api.onMergePicked(fileOf("Export-Boka.sqlite", sqliteLike));
    assert.strictEqual(calls.download,1,"pre-merge backup still downloads"); assert.strictEqual(calls.merge,1);
    assert.strictEqual(calls.persist,1); assert.ok(calls.alerts.includes("Merge complete."));
    assert.strictEqual(calls.modals.length,0);
  });
  await t("a failing non-DN file keeps the old error message", async ()=>{
    const { app, calls } = rig();
    app.hook("mergeDatabase", async ()=>{ throw new Error("bad"); });
    await app.api.onMergePicked(fileOf("junk.sqlite", Buffer.from("not a database at all")));
    assert.ok(calls.alerts.some(m=>/valid seiGEN Commerce Lite export/.test(m)));
    assert.strictEqual(calls.modals.length,0);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
