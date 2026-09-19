// Run: node --no-warnings test/phase4.test.js
// Phase 4 over the REAL app source and SQLite: GRV import, DN events and status, movements report,
// rename / Replace guards, and the remote-branch security rules.
"use strict";
const assert = require("assert");
const vm = require("vm");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,4).join("\n       ")); }
}
const DAY = 86400000;
const daysAgo = (n)=>new Date(Date.now()-n*DAY);
const bytesOf = (text)=>new Uint8Array(Buffer.from(text,"utf8"));
const fileOf = (name, bytes)=>({ name, bytes:new Uint8Array(bytes) });
const THUMB = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

function addProduct(app, branch, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [o.name,o.price==null?5:o.price,o.stock==null?0:o.stock,3,o.sku,branch,"",o.cost==null?3:o.cost,"2026-01-01",""]);
}
function snapshot(app){
  const names = app.api.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
  return JSON.stringify(names.map(n=>[n, app.api.all("SELECT * FROM "+n)]));
}
const stockOf = (app, sku)=>app.api.one("SELECT stock FROM products WHERE lower(sku)=lower(?) AND branch=?",[sku,app.api.currentBranch()]).stock;

// Dispatcher "Boka" (main), receiver "CBD" (remote).
function rig(){
  const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", contact_phone:"0771111111" });
  const B = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
  addProduct(A,"Boka",{name:"Rice 2kg",sku:"SK1",stock:20}); addProduct(A,"Boka",{name:"Sugar 1kg",sku:"SK2",stock:10});
  addProduct(B,"CBD",{name:"Rice 2kg",sku:"SK1",stock:4}); addProduct(B,"CBD",{name:"Sugar 1kg",sku:"SK2",stock:0});
  A.api.getBranchId(); B.api.getBranchId();
  A.api.ensureSelfInRegister();
  A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('CBD','0772222222')");
  B.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Boka','0771111111')");
  return { A, B };
}
async function dispatch(A, toBranch, lines, when){
  const products = lines.map(l=>A.api.one("SELECT * FROM products WHERE sku=? AND branch='Boka'",[l[0]]));
  const dn = A.api.dnCommitDispatch({ branch:"Boka", toBranch, now:when||daysAgo(1), lines:lines.map((l,i)=>({product:products[i],qty:l[1]})) });
  const h = A.api.dnHeaderFor(dn.n);
  const doc = await A.api.buildDN({ dnNo:dn.n, fromBranchId:A.api.getBranchId(), fromName:"Boka", toName:toBranch, createdIso:h.created_iso,
    items:lines.map((l,i)=>({ code:l[0], name:products[i].name, qty:l[1], thumb:THUMB })) });
  return { dn, text:A.api.serializeDN(doc), doc };
}
// Receiver accepts; returns the GRV file exactly as it would be sent back.
async function acceptAndGrv(B, d, when){
  const res = await B.api.receiveCheckBytes(bytesOf(d.text)).then(r=>r.res);
  assert.strictEqual(res.ok,true,res.message);
  const c = B.api.commitReceive(res.doc, when||new Date());
  const grv = await B.api.buildGRVFromCommit(res.doc, c);
  return { grv, text:B.api.serializeGRV(grv), c, res };
}
const importCheck = (A, text)=>A.api.grvImportCheckBytes(bytesOf(text)).then(r=>r.res);
const movements = (app, b, status)=>app.api.REPORT_CONFIGS.find(c=>c.id==="movements").fetch(b||null,"2000-01-01T00:00:00","2100-01-01T00:00:00",null,status||"");

(async()=>{
  // ================= Step 3: GRV import =================
  await t("import: success marks the DN received, stores GRV no + time + event; stock, counters and products untouched", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    const g = await acceptAndGrv(B, d);
    const stock = { sk1:stockOf(A,"SK1"), sk2:stockOf(A,"SK2") };
    const counters = JSON.stringify(A.api.all("SELECT * FROM doc_counters"));
    const received = JSON.stringify(A.api.all("SELECT * FROM stock_received"));
    const products = JSON.stringify(A.api.all("SELECT * FROM products"));
    const res = await importCheck(A, g.text);
    assert.strictEqual(res.ok,true,res.message);
    A.api.commitGrvImport(res.doc, new Date());
    const h = A.api.dnHeaderFor(d.dn.n);
    assert.strictEqual(h.status,"received"); assert.strictEqual(h.grv_no,1); assert.ok(h.received_ts); assert.strictEqual(h.received_iso,g.grv.received_iso);
    const ev = A.api.all("SELECT * FROM dn_events WHERE event_type='received'");
    assert.strictEqual(ev.length,1); assert.strictEqual(ev[0].grv_no,1); assert.strictEqual(ev[0].dn_branch_id,A.api.getBranchId());
    assert.strictEqual(stockOf(A,"SK1"),stock.sk1); assert.strictEqual(stockOf(A,"SK2"),stock.sk2,"stock is NOT touched");
    assert.strictEqual(JSON.stringify(A.api.all("SELECT * FROM doc_counters")),counters,"no number consumed");
    assert.strictEqual(JSON.stringify(A.api.all("SELECT * FROM stock_received")),received,"no stock movement recorded");
    assert.strictEqual(JSON.stringify(A.api.all("SELECT * FROM products")),products);
  });
  await t("import: a GRV for another dispatching branch is blocked, nothing changes", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const other = await A.api.buildGRV({ grvNo:1, dnNo:d.dn.n, fromBranchId:"B-OTHER123", fromName:"Elsewhere", toBranchId:B.api.getBranchId(), toName:"CBD", receivedIso:"2026-09-05T14:15:00+02:00", items:[{code:"SK1",name:"Rice 2kg",qty:6}] });
    const before = snapshot(A);
    const res = await importCheck(A, A.api.serializeGRV(other));
    assert.strictEqual(res.ok,false); assert.strictEqual(res.stage,"branch"); assert.ok(/not by this branch/.test(res.message));
    assert.strictEqual(snapshot(A),before);
  });
  await t("import: a DN number that was never dispatched here is blocked", async ()=>{
    const { A, B } = rig(); await dispatch(A,"CBD",[["SK1",6]]);
    const g = await A.api.buildGRV({ grvNo:1, dnNo:99, fromBranchId:A.api.getBranchId(), fromName:"Boka", toBranchId:B.api.getBranchId(), toName:"CBD", receivedIso:"2026-09-05T14:15:00+02:00", items:[{code:"SK1",name:"Rice 2kg",qty:6}] });
    const before = snapshot(A);
    const res = await importCheck(A, A.api.serializeGRV(g));
    assert.strictEqual(res.stage,"unknown"); assert.ok(/DN0099/.test(res.message));
    assert.strictEqual(snapshot(A),before);
  });
  await t("import: importing the same GRV again says 'Already confirmed on <date> as GRV####' and changes nothing", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const g = await acceptAndGrv(B, d, new Date(2026,8,5,14,15));
    A.api.commitGrvImport((await importCheck(A, g.text)).doc, new Date());
    const before = snapshot(A);
    const again = await importCheck(A, g.text);
    assert.strictEqual(again.ok,false); assert.strictEqual(again.stage,"duplicate");
    assert.strictEqual(again.message,"Already confirmed on 05Sep26 as GRV0001.");
    assert.strictEqual(snapshot(A),before);
    assert.throws(()=>A.api.commitGrvImport(again.doc, new Date()), /Already confirmed/);
    assert.strictEqual(snapshot(A),before,"even a forced second commit changes nothing");
  });
  await t("import: a GRV whose lines differ from the DN is blocked and both versions are shown", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    const mk = (items)=>A.api.buildGRV({ grvNo:1, dnNo:d.dn.n, fromBranchId:A.api.getBranchId(), fromName:"Boka", toBranchId:B.api.getBranchId(), toName:"CBD", receivedIso:"2026-09-05T14:15:00+02:00", items });
    const before = snapshot(A);
    const qty = await importCheck(A, A.api.serializeGRV(await mk([{code:"SK1",name:"Rice 2kg",qty:6},{code:"SK2",name:"Sugar 1kg",qty:2}])));
    assert.strictEqual(qty.stage,"lines");
    assert.ok(qty.dn.some(x=>/SK2 Sugar 1kg .* 3/.test(x))); assert.ok(qty.grv.some(x=>/SK2 Sugar 1kg .* 2/.test(x)));
    const code = await importCheck(A, A.api.serializeGRV(await mk([{code:"SK1",name:"Rice 2kg",qty:6},{code:"SK9",name:"Sugar 1kg",qty:3}])));
    assert.strictEqual(code.stage,"lines","a different code is a difference too");
    const fewer = await importCheck(A, A.api.serializeGRV(await mk([{code:"SK1",name:"Rice 2kg",qty:6}])));
    assert.strictEqual(fewer.stage,"lines","a missing line is a difference");
    const reordered = await importCheck(A, A.api.serializeGRV(await mk([{code:"SK2",name:"Sugar 1kg",qty:3},{code:"SK1",name:"Rice 2kg",qty:6}])));
    assert.strictEqual(reordered.ok,true,"order alone is not a difference");
    assert.strictEqual(snapshot(A),before);
  });
  await t("import: a tampered GRV file fails the checksum, nothing changes", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const g = await acceptAndGrv(B, d);
    const tampered = g.text.replace('"qty":6','"qty":60').replace('"units":6','"units":60');
    assert.notStrictEqual(tampered,g.text);
    const before = snapshot(A);
    const res = await importCheck(A, tampered);
    assert.strictEqual(res.ok,false); assert.strictEqual(res.stage,"file"); assert.ok(/checksum/.test(res.message));
    assert.strictEqual(snapshot(A),before);
    const junk = await importCheck(A, "not json at all");
    assert.strictEqual(junk.stage,"file");
  });
  await t("import: detected by content — a GRV renamed .txt is refused by the old merge with the Import GRV button, and imports fine under any name", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const g = await acceptAndGrv(B, d);
    const calls = { download:0, merge:0, modals:[], opened:null };
    A.hook("downloadDb", ()=>{ calls.download++; });
    A.hook("mergeDatabase", async ()=>{ calls.merge++; });
    A.hook("openGrvImportWithFile", (f)=>{ calls.opened = f; });
    A.hook("openModal", (title, html)=>{ const btn={onclick:null}; const w={title,html,btn,remove(){}, querySelector:(s)=> s==="#dnGuardReceive"? btn : null}; calls.modals.push(w); return w; });
    const file = fileOf("photo-of-receipt.txt", Buffer.from(g.text,"utf8"));
    const before = snapshot(A);
    await A.api.onMergePicked(file);
    assert.strictEqual(calls.download,0); assert.strictEqual(calls.merge,0); assert.strictEqual(snapshot(A),before);
    assert.ok(/Import GRV/.test(calls.modals[0].html));
    calls.modals[0].btn.onclick();
    assert.strictEqual(calls.opened,file,"the button opens Import GRV with the same file");
    const res = await importCheck(A, g.text);        // the import screen reads bytes only, never the name
    assert.strictEqual(res.ok,true);
  });
  await t("import: a receiver's device (or any other branch) cannot import a GRV it did not dispatch", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const g = await acceptAndGrv(B, d);
    const res = await importCheck(B, g.text);
    assert.strictEqual(res.ok,false); assert.strictEqual(res.stage,"branch");
  });

  // ================= Step 2: send back =================
  await t("send back: label, prefilled text, and the dispatcher's number from the register", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const g = await acceptAndGrv(B, d, new Date(2026,8,5,14,15));
    assert.strictEqual(B.api.grvSendLabel("Boka").replace(/^\S+ /,""),"Send GRV to Boka");
    let shared = null; B.hook("shareDocFile", async (o)=>{ shared = o; return { method:"downloaded" }; });
    const h = B.api.incomingHeader(A.api.getBranchId(), d.dn.n);
    await B.api.grvShare(h, { doc:g.grv, text:g.text });
    assert.strictEqual(shared.phone,"0771111111","number comes from the register");
    assert.ok(shared.shareText.includes("GRV0001") && shared.shareText.includes("DN"+String(d.dn.n).padStart(4,"0")) && shared.shareText.includes("CBD") && /Import GRV/.test(shared.shareText));
    assert.strictEqual(shared.fileName,h.file_name); assert.strictEqual(shared.text,g.text);
    B.api.run("DELETE FROM branch_register");
    await B.api.grvShare(h, { doc:g.grv, text:g.text });
    assert.strictEqual(shared.phone,"","no register entry -> no number (wa.me/?text= fallback)");
  });

  // ================= Step 4: events, status, reports =================
  await t("events: written at dispatch, accept and variance; a receiver's export and the dispatcher's import are the same 'received' fact", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    assert.strictEqual(JSON.stringify(A.api.all("SELECT event_type FROM dn_events").map(e=>e.event_type)),JSON.stringify(["dispatched"]));
    const doc = (await B.api.receiveCheckBytes(bytesOf(d.text))).res.doc;
    B.api.commitVariance(doc, B.api.buildVarianceReport(doc,{flags:[{index:0,counted:"4"}],note:"box torn"}).report, new Date(2026,8,5,9,0));
    assert.strictEqual(JSON.stringify(B.api.all("SELECT event_type FROM dn_events").map(e=>e.event_type)),JSON.stringify(["variance"]));
    const g = await acceptAndGrv(B, d);
    assert.strictEqual(JSON.stringify(B.api.all("SELECT event_type FROM dn_events ORDER BY id").map(e=>e.event_type)),JSON.stringify(["variance","received"]));
    const v = JSON.parse(B.api.one("SELECT detail_json FROM dn_events WHERE event_type='variance'").detail_json);
    assert.strictEqual(v.flags.length,1); assert.strictEqual(v.note,"box torn");
  });
  await t("merge: dn_events merge additively and de-duplicate; dispatch_docs is NOT merged; re-merging adds nothing", async () => {
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const doc = (await B.api.receiveCheckBytes(bytesOf(d.text))).res.doc;
    B.api.commitVariance(doc, B.api.buildVarianceReport(doc,{flags:[{index:0,counted:"4"}],note:"n"}).report, new Date(2026,8,5,9,0));
    const g = await acceptAndGrv(B, d);
    A.api.commitGrvImport((await importCheck(A, g.text)).doc, new Date());
    const M = makeApp({ branch_name:"Head Office", branch_type:"main", setup_complete:"1" });
    await M.api.mergeDatabase({ __db:A.db });
    await M.api.mergeDatabase({ __db:B.db });
    const types = M.api.all("SELECT event_type, COUNT(*) AS c FROM dn_events GROUP BY event_type ORDER BY event_type").map(r=>r.event_type+":"+r.c);
    assert.strictEqual(JSON.stringify(types),JSON.stringify(["dispatched:1","received:1","variance:1"]),"received arrives from both devices but is one row");
    const n = M.api.all("SELECT * FROM dn_events").length;
    await M.api.mergeDatabase({ __db:A.db }); await M.api.mergeDatabase({ __db:B.db });
    assert.strictEqual(M.api.all("SELECT * FROM dn_events").length,n);
    assert.strictEqual(M.api.all("SELECT * FROM dispatch_docs").length,0,"dispatch_docs never merged");
    // a second variance report (different time) is a different fact and is kept
    const r2 = M.api.recordDnEvent({ dnBranchId:A.api.getBranchId(), dnNo:d.dn.n, type:"variance", ts:"2026-09-06T10:00:00Z", detail:"" });
    assert.strictEqual(r2,true);
    assert.strictEqual(M.api.recordDnEvent({ dnBranchId:A.api.getBranchId(), dnNo:d.dn.n, type:"variance", ts:"2026-09-06T10:00:00Z", detail:"" }),false);
  });
  await t("status: dispatched / awaiting / variance / received, and the awaiting threshold is a setting", ()=>{
    const { A } = rig();
    const now = Date.parse("2026-09-20T12:00:00Z"), ago = (d)=>new Date(now-d*DAY).toISOString();
    const st = (o, days)=>A.api.computeDnStatus(o, now, days);
    assert.strictEqual(st({dispatchedTs:ago(1)},7),"dispatched");
    assert.strictEqual(st({dispatchedTs:ago(7)},7),"dispatched","exactly 7 days is not yet 'more than 7'");
    assert.strictEqual(st({dispatchedTs:ago(7.1)},7),"awaiting");
    assert.strictEqual(st({dispatchedTs:ago(3.1)},3),"awaiting","threshold follows the setting");
    assert.strictEqual(st({dispatchedTs:ago(30),hasVariance:true},7),"variance","variance beats awaiting");
    assert.strictEqual(st({dispatchedTs:ago(30),hasVariance:true,hasReceived:true},7),"received","a later receipt clears a variance");
    assert.strictEqual(st({dispatchedTs:"",},7),"dispatched","unknown dispatch date is never 'awaiting'");
    assert.strictEqual(A.api.awaitingDaysFrom("abc"),7); assert.strictEqual(A.api.awaitingDaysFrom("0"),7); assert.strictEqual(A.api.awaitingDaysFrom("14"),14);
    // from real rows: a 10-day-old DN is awaiting under the default, dispatched under a 30-day setting
    return dispatch(A,"CBD",[["SK1",1]],daysAgo(10)).then(d=>{
      const key = A.api.getBranchId()+"|"+d.dn.n;
      assert.strictEqual(A.api.dnStatusMap().get(key).status,"awaiting");
      A.api.setSetting("awaiting_days","30");
      assert.strictEqual(A.api.dnStatusMap().get(key).status,"dispatched");
    });
  });
  await t("variance is only known where its event has arrived (dispatcher does not know until it merges)", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const doc = (await B.api.receiveCheckBytes(bytesOf(d.text))).res.doc;
    B.api.commitVariance(doc, B.api.buildVarianceReport(doc,{flags:[{index:0,counted:"4"}],note:"short"}).report, new Date());
    const key = A.api.getBranchId()+"|"+d.dn.n;
    assert.strictEqual(A.api.dnStatusMap().get(key).status,"dispatched");
    await A.api.mergeDatabase({ __db:B.db });                      // A is main here; a remote's file is always accepted
    const r = A.api.dnStatusMap().get(key);
    assert.strictEqual(r.status,"variance"); assert.strictEqual(r.varianceLines,1); assert.strictEqual(r.varianceNote,"short");
  });
  await t("Dispatch History and Stock Dispatched show the real status, joined on (branch id, dn_no)", async ()=>{
    const { A, B } = rig(); const d1 = await dispatch(A,"CBD",[["SK1",6]]); const d2 = await dispatch(A,"CBD",[["SK2",2]],daysAgo(12));
    const g = await acceptAndGrv(B, d1);
    A.api.commitGrvImport((await importCheck(A, g.text)).doc, new Date());
    const map = A.api.dnStatusMap();
    assert.strictEqual(map.get(A.api.getBranchId()+"|"+d1.dn.n).status,"received");
    assert.strictEqual(map.get(A.api.getBranchId()+"|"+d2.dn.n).status,"awaiting");
    const rep = A.api.REPORT_CONFIGS.find(c=>c.id==="transfers").fetch(null,"2000-01-01T00:00:00","2100-01-01T00:00:00");
    const rows = rep.rows.map(r=>r.join("|"));
    assert.ok(rows.some(r=>/Received \(GRV0001\)/.test(r) && /Rice/.test(r)));
    assert.ok(rows.some(r=>/Awaiting/.test(r) && /Sugar/.test(r)));
    assert.strictEqual(A.api.all("SELECT status FROM stock_transfers WHERE dn_no IS NOT NULL").every(r=>r.status==="Dispatched"),true,"the per-line copy is left alone");
    // a legacy (no DN) transfer keeps its own status
    A.api.run("INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status) VALUES('2026-08-01T10:00:00.000Z','Boka','CBD','Rice 2kg','SK1',2,'old','u','Received')");
    const rep2 = A.api.REPORT_CONFIGS.find(c=>c.id==="transfers").fetch(null,"2000-01-01T00:00:00","2100-01-01T00:00:00");
    assert.ok(rep2.rows.some(r=>r.join("|").includes("Received")&&r.join("|").includes("old")===false&&r[5]==="Received"));
  });
  await t("Stock Movements (main): every DN with from/to/date/status/GRV/variance; filters; Awaiting+Variance view; read-only", async ()=>{
    const { A, B } = rig(); const M = makeApp({ branch_name:"Head Office", branch_type:"main", setup_complete:"1" });
    const d1 = await dispatch(A,"CBD",[["SK1",6]]);                   // will be received
    const d2 = await dispatch(A,"CBD",[["SK2",3]],daysAgo(9));         // awaiting
    const d3 = await dispatch(A,"CBD",[["SK1",1]],daysAgo(2));         // variance
    const d4 = await dispatch(A,"CBD",[["SK2",1]],daysAgo(1));         // plain dispatched
    const g1 = await acceptAndGrv(B, d1);
    const doc3 = (await B.api.receiveCheckBytes(bytesOf(d3.text))).res.doc;
    B.api.commitVariance(doc3, B.api.buildVarianceReport(doc3,{flags:[{index:0,counted:"0"}],note:"box missing"}).report, new Date());
    await M.api.mergeDatabase({ __db:A.db }); await M.api.mergeDatabase({ __db:B.db });
    const before = snapshot(M);
    const all = movements(M);
    assert.strictEqual(all.rows.length,4);
    const byDn = (n)=>all.rows.find(r=>r[0]==="DN"+String(n).padStart(4,"0"));
    assert.ok(/Received/.test(byDn(d1.dn.n)[4]) && byDn(d1.dn.n)[5]==="GRV0001" && byDn(d1.dn.n)[1]==="Boka" && byDn(d1.dn.n)[2]==="CBD");
    assert.ok(/Awaiting/.test(byDn(d2.dn.n)[4]));
    assert.ok(/Variance/.test(byDn(d3.dn.n)[4]) && /1 line flagged/.test(byDn(d3.dn.n)[6]) && /box missing/.test(byDn(d3.dn.n)[6]));
    assert.ok(/Dispatched/.test(byDn(d4.dn.n)[4]));
    assert.strictEqual(movements(M,null,"attention").rows.length,2,"Awaiting + Variance view");
    assert.strictEqual(movements(M,null,"received").rows.length,1);
    assert.strictEqual(movements(M,"CBD").rows.length,4); assert.strictEqual(movements(M,"Boka").rows.length,4); assert.strictEqual(movements(M,"Nowhere").rows.length,0);
    assert.strictEqual(snapshot(M),before,"viewing the report changes nothing");
    assert.ok(/Awaiting 1/.test(all.footer));
    // remotes do not see the report
    assert.strictEqual(vm.runInContext("reportWriterConfigs().some(c=>c.id==='movements')",B.ctx),false);
    assert.strictEqual(vm.runInContext("reportWriterConfigs().some(c=>c.id==='movements')",M.ctx),true);
  });
  await t("a DN known only from the receiver's file still shows on main (from, to, status, dispatched date)", async ()=>{
    const { A, B } = rig(); const M = makeApp({ branch_name:"Head Office", branch_type:"main", setup_complete:"1" });
    const d = await dispatch(A,"CBD",[["SK1",6]]); await acceptAndGrv(B, d);
    await M.api.mergeDatabase({ __db:B.db });                          // dispatcher's file never arrives
    const rows = movements(M).rows;
    assert.strictEqual(rows.length,1); assert.strictEqual(rows[0][1],"Boka"); assert.strictEqual(rows[0][2],"CBD"); assert.ok(/Received/.test(rows[0][4])); assert.notStrictEqual(rows[0][3],"—");
  });
  await t("upgrade: events and dn_branch_id are backfilled for dispatches made before Phase 4", ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    const id = A.api.getBranchId();
    A.api.run("INSERT INTO dispatch_docs(dispatch_branch_id,dispatch_branch_name,dn_no,receive_branch_name,direction,created_ts,status,created_iso,line_count,unit_total) VALUES(?,?,?,?,?,?,?,?,?,?)",[id,"Boka",5,"CBD","out","2026-09-01T08:00:00.000Z","dispatched","2026-09-01T10:00:00+02:00",1,3]);
    A.api.run("INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status,dn_no) VALUES('2026-09-01T08:00:00.000Z','Boka','CBD','Rice','SK1',3,'DN0005','u','Dispatched',5)");
    A.api.run("INSERT INTO dispatch_docs(dispatch_branch_id,dispatch_branch_name,dn_no,receive_branch_name,direction,created_ts,status,received_iso,grv_no) VALUES('B-XX','Zed',9,'Boka','in','2026-09-01T08:00:00.000Z','received','2026-09-02T10:00:00+02:00',4)");
    A.api.migrate(A.db); A.api.migrate(A.db);                            // and repeating changes nothing
    assert.strictEqual(A.api.one("SELECT dn_branch_id FROM stock_transfers WHERE dn_no=5").dn_branch_id,id);
    assert.strictEqual(JSON.stringify(A.api.all("SELECT event_type,dn_no FROM dn_events ORDER BY dn_no,event_type").map(e=>e.event_type+e.dn_no)),JSON.stringify(["dispatched5","received9"]));
  });

  // ================= Step 5: guards =================
  await t("Replace: branch_id is never copied from the file; own id kept, DN counters never rewind", async ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    const other = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });      // a cloned device: same name, different id
    const ownId = A.api.getBranchId(), otherId = other.api.getBranchId();
    A.api.reserveDocNumber("DN"); A.api.reserveDocNumber("DN"); A.api.reserveDocNumber("DN");            // own counter = 3
    other.api.reserveDocNumber("DN");                                                                    // file's counter = 1
    const calls = { alerts:[] };
    A.hook("downloadDb",()=>{}); A.hook("render",()=>{}); A.hook("alert",(m)=>calls.alerts.push(m));
    A.hook("readFileBytes", async ()=>Object.assign(new Uint8Array([1,2,3]),{__db:other.db}));
    await A.api.onReplacePicked(fileOf("clone.sqlite",[1]));
    assert.strictEqual(A.api.getSetting("branch_id"),ownId,"a different device's id is never adopted");
    assert.notStrictEqual(A.api.getSetting("branch_id"),otherId);
    assert.strictEqual(A.api.one("SELECT last_no FROM doc_counters WHERE branch_id=? AND doc_type='DN'",[ownId]).last_no,3,"own counter carried over (highest wins)");
    assert.strictEqual(A.api.getSetting("branch_name"),"Boka");
  });
  await t("Replace: a file carrying this device's own id keeps it; a device with no id gets a fresh one, not the file's", async ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    const ownId = A.api.getBranchId();
    const same = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", branch_id:ownId });
    A.hook("downloadDb",()=>{}); A.hook("render",()=>{}); A.hook("alert",()=>{});
    A.hook("readFileBytes", async ()=>Object.assign(new Uint8Array([1]),{__db:same.db}));
    await A.api.onReplacePicked(fileOf("same.sqlite",[1]));
    assert.strictEqual(A.api.getSetting("branch_id"),ownId);
    // device with no id yet
    const N = makeApp({ branch_name:"New", branch_type:"main", setup_complete:"1" });
    const src = makeApp({ branch_name:"New", branch_type:"main", setup_complete:"1" }); const srcId = src.api.getBranchId();
    N.hook("downloadDb",()=>{}); N.hook("render",()=>{}); N.hook("alert",()=>{});
    N.hook("readFileBytes", async ()=>Object.assign(new Uint8Array([1]),{__db:src.db}));
    assert.strictEqual(N.api.getSetting("branch_id"),"");
    await N.api.onReplacePicked(fileOf("src.sqlite",[1]));
    assert.ok(N.api.getSetting("branch_id") && N.api.getSetting("branch_id")!==srcId,"fresh id, not the file's");
  });
  await t("setup: a new branch always gets a fresh id (resetBranchId), never an inherited one", ()=>{
    const A = makeApp({ branch_name:"X", setup_complete:"1", branch_id:"B-INHERITED" });
    const id = A.api.resetBranchId();
    assert.notStrictEqual(id,"B-INHERITED"); assert.ok(/^B-[A-Z2-9]{8}$/.test(id)); assert.strictEqual(A.api.getSetting("branch_id"),id);
    assert.notStrictEqual(A.api.resetBranchId(),id);
  });

  // ================= Security: remote passcode and main-file refusal =================
  await t("remote setup: an Admin passcode is required, checked, and creates a working Admin; no main file needed", ()=>{
    const R = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
    assert.strictEqual(R.api.hasAdminPasscode(),false);
    assert.ok(/at least 4/.test(R.api.adminPasscodeProblem("12","12")));
    assert.ok(/at least 4/.test(R.api.adminPasscodeProblem("   ","   ")));
    assert.ok(/don't match/.test(R.api.adminPasscodeProblem("1234","1243")));
    assert.strictEqual(R.api.adminPasscodeProblem("1234","1234"),"");
    assert.throws(()=>R.api.createDeviceAdmin("1234","9999"), /don't match/);
    assert.strictEqual(R.api.all("SELECT * FROM staff").length,0,"nothing is created on a bad passcode");
    R.api.createDeviceAdmin("1234","1234");
    const s = R.api.one("SELECT * FROM staff");
    assert.strictEqual(s.role,"Admin"); assert.strictEqual(s.passcode,"1234"); assert.strictEqual(s.active,1); assert.strictEqual(s.branch,"CBD");
    assert.strictEqual(R.api.hasAdminPasscode(),true);
    const n = R.api.createDeviceAdmin("5678","5678");
    assert.strictEqual(n,"Admin 2");
  });
  await t("a main-type data file is refused on a remote (merge and Replace), by content, with no backup and no change", async ()=>{
    const R = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
    const M = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    const NOTYPE = makeApp({ branch_name:"Old", setup_complete:"1" });
    const calls = { download:0, alerts:[], confirms:0 };
    R.hook("downloadDb",()=>{ calls.download++; }); R.hook("render",()=>{}); R.hook("alert",(m)=>calls.alerts.push(m)); R.hook("confirm",()=>{ calls.confirms++; return true; });
    const before = snapshot(R);
    for(const [src,label] of [[M,"main"],[NOTYPE,"no branch type"]]){
      R.hook("readFileBytes", async ()=>Object.assign(new Uint8Array([1,2,3]),{__db:src.db}));
      await R.api.onMergePicked(fileOf("Export-x.sqlite",[1]));
      await R.api.onReplacePicked(fileOf("Export-x.sqlite",[1]));
    }
    assert.strictEqual(calls.download,0,"no backup download"); assert.strictEqual(calls.confirms,0);
    assert.strictEqual(calls.alerts.length,4);
    assert.ok(/exported by a main branch/.test(calls.alerts[0]) && /can't merge it/.test(calls.alerts[0]) && /passcodes, costs/.test(calls.alerts[0]));
    assert.ok(/can't replace this device's data with it/.test(calls.alerts[1]));
    assert.ok(/doesn't say it came from a remote/.test(calls.alerts[2]));
    assert.strictEqual(snapshot(R),before,"nothing changed");
    await assert.rejects(()=>R.api.mergeDatabase({ __db:M.db }), (e)=>e.code==="MAIN_FILE_REFUSED");
    assert.strictEqual(snapshot(R),before);
  });
  await t("a remote still accepts another remote's file; and remote-to-main merge is unchanged", async ()=>{
    const R1 = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
    const R2 = makeApp({ branch_name:"Mutare", branch_type:"remote", setup_complete:"1" });
    const M = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    addProduct(R2,"Mutare",{name:"Rice",sku:"SK1",stock:5});
    await R1.api.mergeDatabase({ __db:R2.db });
    assert.strictEqual(R1.api.all("SELECT * FROM products WHERE branch='Mutare'").length,1);
    await M.api.mergeDatabase({ __db:R2.db });
    assert.strictEqual(M.api.all("SELECT * FROM products WHERE branch='Mutare'").length,1);
    const n = M.api.all("SELECT * FROM products").length;
    await M.api.mergeDatabase({ __db:R2.db });
    assert.strictEqual(M.api.all("SELECT * FROM products").length,n,"and still de-duplicates");
  });
  await t("existing remotes are not modified by the upgrade (no staff, settings or data added)", ()=>{
    const R = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1", branch_id:"B-KEEPME12" });
    addProduct(R,"CBD",{name:"Rice",sku:"SK1",stock:5});
    const before = snapshot(R);
    R.api.migrate(R.db);
    assert.strictEqual(snapshot(R),before);
    assert.strictEqual(R.api.all("SELECT * FROM staff").length,0);
    assert.strictEqual(R.api.hasAdminPasscode(),false,"an existing remote with none is offered the create-passcode form on the locked screen");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
