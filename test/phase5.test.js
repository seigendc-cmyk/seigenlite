// Run: node --no-warnings test/phase5.test.js
// Phase 5 over the REAL app source and SQLite, two devices (each makeApp is its own database and identity):
// cancel / reissue / close as loss, the notice and confirmation files, the receiver's terminal states,
// conflict handling, the nine scenarios, statuses and reports.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}
const J = JSON.stringify;
const DAY = 86400000;
const bytesOf = (text)=>new Uint8Array(Buffer.from(text,"utf8"));
const fileOf = (name, bytes)=>({ name, bytes:new Uint8Array(bytes) });
function addProduct(app, branch, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [o.name,5,o.stock==null?0:o.stock,3,o.sku,branch,"",o.cost==null?0:o.cost,"2026-01-01",""]);
}
function snap(app){
  const names = app.api.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
  return J(names.map(n=>[n, app.api.all("SELECT * FROM "+n)]));
}
const stockOf = (app, sku)=>app.api.one("SELECT stock FROM products WHERE lower(sku)=lower(?) AND branch=?",[sku,app.api.currentBranch()]).stock;
const dnNo = (n)=>"DN"+String(n).padStart(4,"0");

// Dispatcher A "Boka" (main, Admin 9999, cancel enabled) and receiver B "CBD" (remote).
function rig(){
  const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", cancel_enabled:"1" });
  const B = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
  A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999','Boka',1,'x')");
  addProduct(A,"Boka",{name:"Rice 2kg",sku:"SK1",stock:30,cost:3.5}); addProduct(A,"Boka",{name:"Sugar 1kg",sku:"SK2",stock:20,cost:0});
  addProduct(B,"CBD",{name:"Rice 2kg",sku:"SK1",stock:4}); addProduct(B,"CBD",{name:"Sugar 1kg",sku:"SK2",stock:0});
  A.api.getBranchId(); B.api.getBranchId(); A.api.ensureSelfInRegister();
  A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('CBD','')");
  A.hook("getThumbs", async (ps)=>ps.map(()=>null));
  return { A, B };
}
async function dispatch(A, to, lines, when){
  const products = lines.map(l=>A.api.one("SELECT * FROM products WHERE sku=? AND branch='Boka'",[l[0]]));
  const dn = A.api.dnCommitDispatch({ branch:"Boka", toBranch:to, now:when||new Date(Date.now()-DAY), lines:lines.map((l,i)=>({product:products[i],qty:l[1]})) });
  const h = A.api.dnHeaderFor(dn.n);
  const doc = await A.api.buildDN({ dnNo:dn.n, fromBranchId:A.api.getBranchId(), fromName:"Boka", toName:to, createdIso:h.created_iso, items:lines.map((l,i)=>({ code:l[0], name:products[i].name, qty:l[1] })) });
  return { dn, n:dn.n, text:A.api.serializeDN(doc), doc };
}
const startCancel = (A, n, kind, plan, o)=>A.api.startCancelCase(Object.assign({ dnNo:n, kind, plan, note:"reason", passcode:"9999" }, o||{}));
const noticeText = async (A, caseNo)=>(await A.api.cancelNoticeFor(A.api.dnCaseByNo(caseNo))).text;
const recvCheck = (B, text)=>B.api.receiveCheckBytes(bytesOf(text)).then(r=>r.res);
const cxCheck = (B, text)=>B.api.checkIncomingCancel(text,{ ownBranchId:B.api.getBranchId(), ownBranchName:B.api.currentBranch(), lookup:B.api.incomingHeader });
async function replacementText(A, newNo){ return (await A.api.dnBuildFromDb(A.api.dnHeaderFor(newNo))).text; }
async function acceptAndGrv(B, text, when){
  const res = await recvCheck(B, text); assert.strictEqual(res.ok,true,res.message);
  const c = B.api.commitReceive(res.doc, when||new Date());
  return { grvText:B.api.serializeGRV(await B.api.buildGRVFromCommit(res.doc,c)), c, res };
}
const ackBytes = async (B, fromId, n)=>bytesOf(B.api.serializeAck(await B.api.buildAckFromRow(B.api.incomingHeader(fromId,n))));
const importGrv = async (A, text)=>{ const r = (await A.api.grvImportCheckBytes(bytesOf(text))).res; return r; };
const status = (app, id, n)=>app.api.dnStatusMap().get(id+"|"+n);
const plan = (...p)=>p.map(x=>({ nw:x[0], writeoff:x[1]||0, reason:x[2]||"" }));

(async()=>{
  // ================= files =================
  await t("files: notice and confirmation round-trip with checksums; tampering, wrong type and newer versions are refused in plain words", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const c = startCancel(A,d.n,"cancel");
    const text = await noticeText(A,c.caseNo), p = await A.api.parseCancel(text);
    assert.strictEqual(p.ok,true,J(p.errors)); assert.strictEqual(p.doc.cancel_display,"CXL0001"); assert.strictEqual(p.doc.kind,"cancel"); assert.strictEqual(p.doc.replaced_by,null);
    assert.strictEqual(p.doc.items.length,1); assert.ok(/^[A-Za-z0-9]{16}$/.test(p.doc.nonce));
    assert.strictEqual((await A.api.parseCancel(text.replace('"qty":10','"qty":100'))).ok,false);
    assert.ok(/checksum/.test((await A.api.parseCancel(text.replace('"qty":10','"qty":11').replace('"units":10','"units":11'))).errors[0]));
    assert.ok(/not a readable/.test((await A.api.parseCancel("nope")).errors[0]));
    assert.ok(/wrong file type/.test((await A.api.parseCancel(J({format:"seigen-dn"}))).errors[0]));
    const v9 = J(Object.assign(JSON.parse(text),{ format_version:9 }));
    assert.ok(/needs a newer version of seiGEN Commerce Lite \(file version 9, this app reads up to 1\).*Nothing was changed/.test((await A.api.parseCancel(v9)).errors[0]));
    const ack = A.api.serializeAck(await A.api.buildAck({ cancelNo:1, nonce:p.doc.nonce, dnNo:d.n, fromBranchId:A.api.getBranchId(), fromName:"Boka", toBranchId:B.api.getBranchId(), toName:"CBD", varianceSeen:false, confirmedIso:"2026-09-05T10:00:00+02:00" }));
    assert.strictEqual((await A.api.parseAck(ack)).ok,true);
    assert.strictEqual((await A.api.parseAck(ack.replace('"variance_seen":false','"variance_seen":true'))).ok,false);
    // a DN with replaces is version 2 and needs its cancel reference; ordinary DNs stay version 1
    assert.strictEqual(JSON.parse(d.text).format_version,1); assert.ok(!("replaces" in JSON.parse(d.text)));
    const v2 = await A.api.buildDN({ dnNo:5, fromBranchId:"B-X", fromName:"Boka", toName:"CBD", createdIso:"2026-09-04T08:00:00+02:00", replaces:3, cancelNo:1, cancelNonce:p.doc.nonce, items:[{code:"SK1",name:"Rice",qty:2}] });
    assert.strictEqual(v2.format_version,2); assert.strictEqual(v2.replaces,3);
    assert.strictEqual(J(Object.keys(v2)),J(["format","format_version","dn_no","dn_display","from","to","created_iso","replaces","cancel_no","cancel_nonce","items","totals","checksum"]));
    assert.strictEqual((await A.api.parseDN(A.api.serializeDN(v2))).ok,true);
    await assert.rejects(()=>A.api.buildDN({ dnNo:5, fromBranchId:"B-X", fromName:"Boka", toName:"CBD", createdIso:"2026-09-04T08:00:00+02:00", replaces:9, cancelNo:1, cancelNonce:p.doc.nonce, items:[{code:"SK1",name:"Rice",qty:2}] }), /replaces/);
    assert.ok(/needs a newer version/.test(A.api.newerAppMessage("Delivery Note",3,2)));
    // a truncated, pretty-printed file is still recognised by content
    assert.strictEqual(A.api.sniffJsonFormat(bytesOf('{\n  "format": "seigen-dn-cancel",\n  "format_ver')),"seigen-dn-cancel");
  });
  await t("plan rules: cancel returns everything, loss writes everything off, reissue caps at the original, a reason is needed for write-offs", ()=>{
    const { A } = rig(); const lines = [{code:"SK1",name:"Rice",qty:10},{code:"SK2",name:"Sugar",qty:4}];
    const n = (k,p,note)=>A.api.normalizeCancelPlan(k,lines,p,note===undefined?"why":note);
    assert.strictEqual(n("cancel",[]).lines.every(l=>l.returned===l.orig && l.nw===0 && l.writeoff===0),true);
    assert.ok(/Write a note/.test(n("cancel",[],"  ").error));
    assert.ok(/choose a reason/.test(n("loss",[{},{}]).error));
    const loss = n("loss",[{reason:"Damaged"},{reason:"Other"}]); assert.strictEqual(loss.ok,true); assert.strictEqual(loss.lines[0].writeoff,10);
    assert.ok(/from 0 to 10/.test(n("reissue",plan([11],[4])).error), "new quantity can't exceed the original");
    assert.ok(/from 0 to 3/.test(n("reissue",plan([7,4,"Damaged"],[4])).error), "write-off can't exceed the difference");
    assert.ok(/choose a reason/.test(n("reissue",plan([7,3],[4])).error));
    assert.ok(/whole number/.test(n("reissue",plan(["1.5"],[4])).error));
    assert.ok(/at least one line/.test(n("reissue",plan([0],[0])).error));
    const ok = n("reissue",plan([7,2,"Lost in transit"],[4])); assert.strictEqual(ok.ok,true); assert.strictEqual(ok.lines[0].returned,1);
    assert.strictEqual(A.api.cancelPlanSummary("reissue",ok.lines,"DN0001").net,1);
    assert.ok(/Choose what to do/.test(A.api.normalizeCancelPlan("bogus",lines,[],"x").error));
  });

  // ================= rules on the dispatching device =================
  await t("only an Admin on the dispatching device can start; the switch, sign-in, status and pending rules", async ()=>{
    const { A } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const before = snap(A);
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Till','Cashier','5555','Boka',1,'x')");
    const before2 = snap(A);
    for(const p of ["0000","","5555"]) assert.throws(()=>startCancel(A,d.n,"cancel",[],{passcode:p}), /Incorrect Admin passcode/);
    assert.strictEqual(snap(A),before2,"nothing written on a refusal");
    A.api.setSetting("cancel_enabled","");
    assert.throws(()=>startCancel(A,d.n,"cancel",[]), /switched off on this device/);
    A.api.setSetting("cancel_enabled","1");
    vm.runInContext('sessionUser=""', A.ctx);
    assert.throws(()=>startCancel(A,d.n,"cancel",[]), /Enter your name first/);
    vm.runInContext('sessionUser="Tester"', A.ctx);
    assert.throws(()=>startCancel(A,99,"cancel",[]), /not dispatched from this device/);
    startCancel(A,d.n,"cancel",[]);
    assert.throws(()=>startCancel(A,d.n,"cancel",[]), /already has a cancellation in progress/);
    // a receiver device holds no 'out' rows, so it can never start one
    const B = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1", cancel_enabled:"1" });
    B.api.createDeviceAdmin("4321","4321");
    assert.throws(()=>B.api.startCancelCase({ dnNo:d.n, kind:"cancel", plan:[], note:"x", passcode:"4321" }), /not dispatched from this device/);
    // a received DN can't be cancelled
    const r = rig(); const d2 = await dispatch(r.A,"CBD",[["SK1",2]]); const g = await acceptAndGrv(r.B,d2.text);
    r.A.api.commitGrvImport((await importGrv(r.A,g.grvText)).doc,new Date());
    assert.throws(()=>startCancel(r.A,d2.n,"cancel",[]), /is received, so it can't be cancelled/);
  });

  // ================= scenario 1 =================
  await t("S1 receiver has not touched the DN: notice -> tombstone (Accept blocked) -> confirmation -> ONE posting on the dispatcher", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10],["SK2",4]]);
    assert.strictEqual(stockOf(A,"SK1"),20);
    const c = startCancel(A,d.n,"cancel");
    assert.strictEqual(status(A,A.api.getBranchId(),d.n).status,"cancel_pending");
    assert.strictEqual(stockOf(A,"SK1"),20,"nothing changes until the receiver confirms");
    assert.strictEqual(A.api.all("SELECT * FROM stock_adjustments").length,0);
    const nt = await noticeText(A,c.caseNo), r1 = await cxCheck(B,nt);
    assert.strictEqual(r1.ok,true); assert.strictEqual(r1.already,false);
    const dnRes = await recvCheck(B,d.text); assert.strictEqual(dnRes.ok,true);       // the receiver had the DN file open
    const rec = B.api.commitCancelNotice(r1.doc,new Date());
    assert.strictEqual(rec.status,"cancelled"); assert.strictEqual(rec.cancel_no,1);
    assert.throws(()=>B.api.commitReceive(dnRes.doc,new Date()), /was cancelled by Boka/);
    const again = await recvCheck(B,d.text); assert.strictEqual(again.ok,false); assert.strictEqual(again.stage,"cancelled"); assert.ok(/Do not receive it/.test(again.message));
    assert.strictEqual(stockOf(B,"SK1"),4,"receiver stock never moved");
    assert.strictEqual(B.api.all("SELECT * FROM stock_adjustments").length,0);
    // confirmation -> dispatcher posts
    const bytes = await ackBytes(B,A.api.getBranchId(),d.n);
    const chk = (await A.api.ackCheckBytes(bytes)).res; assert.strictEqual(chk.ok,true,chk.message);
    const r = A.api.commitAckImport(chk.doc,new Date());
    assert.strictEqual(r.posted,true);
    assert.strictEqual(stockOf(A,"SK1"),30); assert.strictEqual(stockOf(A,"SK2"),20);
    const rows = A.api.all("SELECT * FROM stock_adjustments ORDER BY id");
    assert.strictEqual(rows.length,2); assert.ok(rows.every(x=>x.reason==="Dispatch cancelled" && x.qty_delta>0 && x.dn_no===d.n && x.dn_branch_id===A.api.getBranchId() && x.authorised_by==="Owner"));
    assert.strictEqual(A.api.all("SELECT * FROM stock_received WHERE adj_no IS NOT NULL").length,2,"one ledger row per adjustment");
    const st = status(A,A.api.getBranchId(),d.n); assert.strictEqual(st.status,"cancelled"); assert.strictEqual(st.cancelPending,false); assert.strictEqual(st.unconfirmed,false);
    assert.strictEqual(A.api.dnHeaderFor(d.n).status,"cancelled");
    assert.ok(A.api.all("SELECT * FROM audit_log WHERE action='Cancel posted'").length===1);
    // never twice
    const dup = (await A.api.ackCheckBytes(bytes)).res; assert.strictEqual(dup.ok,false); assert.strictEqual(dup.stage,"duplicate"); assert.ok(/Already confirmed on/.test(dup.message));
    assert.strictEqual(stockOf(A,"SK1"),30);
  });
  await t("the posting is one transaction: a failure part-way rolls back stock, adjustments, ledger, numbers, events and audit", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10],["SK2",4]]);
    const c = startCancel(A,d.n,"reissue",plan([7,3,"Damaged"],[4]));
    const r1 = await cxCheck(B,await noticeText(A,c.caseNo)); B.api.commitCancelNotice(r1.doc,new Date());
    const chk = (await A.api.ackCheckBytes(await ackBytes(B,A.api.getBranchId(),d.n))).res;
    const before = snap(A);
    A.hook("logAudit", (a)=>{ if(a==="Cancel posted") throw new Error("disk full"); });
    assert.throws(()=>A.api.commitAckImport(chk.doc,new Date()), /disk full/);
    assert.strictEqual(snap(A),before,"everything undone together");
    assert.strictEqual(stockOf(A,"SK1"),20);
  });

  // ================= scenario 2 + 8 =================
  await t("S2/S8 variance waiting, reissue: replacement closes the old DN at the receiver; accepting it (GRV) is the confirmation; net stock is right", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10],["SK2",4]]);
    const doc = (await recvCheck(B,d.text)).doc;
    B.api.commitVariance(doc,B.api.buildVarianceReport(doc,{flags:[{index:0,counted:"7"}],note:"3 short"}).report,new Date());
    const before = { sk1:stockOf(A,"SK1"), sk2:stockOf(A,"SK2") };        // 20 / 16
    const c = startCancel(A,d.n,"reissue",plan([7,3,"Lost in transit"],[4]));
    assert.strictEqual(c.newDnNo,d.n+1);
    assert.strictEqual(stockOf(A,"SK1"),before.sk1,"nothing posted yet, not even the replacement");
    assert.strictEqual(A.api.dnHeaderFor(c.newDnNo).stock_posted,0);
    const rep = await replacementText(A,c.newDnNo), rp = JSON.parse(rep);
    assert.strictEqual(rp.format_version,2); assert.strictEqual(rp.replaces,d.n); assert.strictEqual(rp.cancel_no,c.caseNo); assert.strictEqual(rp.totals.units,11);
    // the receiver still has the OLD one open in variance; the replacement arrives
    const res = await recvCheck(B,rep);
    assert.strictEqual(res.ok,true,res.message); assert.strictEqual(res.replaces.dnNo,d.n); assert.strictEqual(res.replaces.record.status,"variance");
    B.api.commitReplacementClose(res.doc,new Date());
    const old = B.api.incomingHeader(A.api.getBranchId(),d.n);
    assert.strictEqual(old.status,"cancelled"); assert.strictEqual(old.replaced_by,c.newDnNo); assert.ok(old.variance_json,"the variance history is kept");
    const oldAgain = await recvCheck(B,d.text); assert.strictEqual(oldAgain.stage,"cancelled"); assert.ok(/replaced by DN0002/.test(oldAgain.message));
    assert.strictEqual(B.api.commitReplacementClose(res.doc,new Date()).status,"cancelled","closing twice is harmless");
    // accept the replacement -> GRV; the dispatcher imports it: that IS the confirmation
    const g = await acceptAndGrv(B,rep);
    assert.strictEqual(stockOf(B,"SK1"),11);
    const chk = await importGrv(A,g.grvText); assert.strictEqual(chk.ok,true,chk.message);
    const r = A.api.commitGrvImport(chk.doc,new Date());
    assert.ok(r.posted && r.posted.dnNo===d.n);
    assert.strictEqual(stockOf(A,"SK1"),20,"10 restored, 7 sent again, 3 written off: net -10 against the start");
    assert.strictEqual(stockOf(A,"SK2"),16);
    const adj = A.api.all("SELECT reason,qty_delta,dn_no FROM stock_adjustments ORDER BY id").map(x=>x.reason+":"+x.qty_delta+":"+x.dn_no);
    assert.strictEqual(J(adj),J(["Dispatch cancelled:10:"+d.n,"Dispatch cancelled:4:"+d.n,"Lost in transit:-3:"+d.n]));
    const led = A.api.all("SELECT qty,dn_no FROM stock_received WHERE dn_no=? AND adj_no IS NULL",[c.newDnNo]).map(x=>x.qty);
    assert.strictEqual(J(led),J([-7,-4]),"the replacement's own dispatch rows");
    assert.strictEqual(A.api.dnHeaderFor(c.newDnNo).stock_posted,1);
    const oldSt = status(A,A.api.getBranchId(),d.n), newSt = status(A,A.api.getBranchId(),c.newDnNo);
    assert.strictEqual(oldSt.status,"superseded"); assert.strictEqual(newSt.status,"received");
    assert.strictEqual(A.api.chainText(oldSt),"superseded by DN0002"); assert.strictEqual(A.api.chainText(newSt),"replaces DN0001");
    assert.strictEqual(oldSt.unconfirmed,false);
    assert.strictEqual(A.api.pendingCaseFor(d.n),null);
  });
  await t("S2b the same reissue completed by the receiver's confirmation file instead of the GRV", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const c = startCancel(A,d.n,"reissue",plan([6,4,"Damaged"]));
    const res = await recvCheck(B,await replacementText(A,c.newDnNo));
    B.api.commitReplacementClose(res.doc,new Date());
    const chk = (await A.api.ackCheckBytes(await ackBytes(B,A.api.getBranchId(),d.n))).res; assert.strictEqual(chk.ok,true,chk.message);
    A.api.commitAckImport(chk.doc,new Date());
    assert.strictEqual(stockOf(A,"SK1"),20); assert.strictEqual(A.api.dnHeaderFor(c.newDnNo).stock_posted,1);
    // now the replacement is accepted and its GRV imported: a plain receipt, nothing more is posted
    const g = await acceptAndGrv(B,await replacementText(A,c.newDnNo));
    const n = A.api.all("SELECT * FROM stock_adjustments").length;
    const r = A.api.commitGrvImport((await importGrv(A,g.grvText)).doc,new Date());
    assert.ok(!r.posted); assert.strictEqual(A.api.all("SELECT * FROM stock_adjustments").length,n); assert.strictEqual(stockOf(A,"SK1"),20);
  });
  await t("S8b a replacement for a DN the receiver ALREADY received is blocked, and offers that GRV", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const c = startCancel(A,d.n,"reissue",plan([6,4,"Damaged"]));
    const rep = await replacementText(A,c.newDnNo);
    const g = await acceptAndGrv(B,d.text);                                   // the receiver accepted the ORIGINAL first
    const res = await recvCheck(B,rep);
    assert.strictEqual(res.ok,false); assert.strictEqual(res.stage,"replaces-received"); assert.ok(/already received here as GRV0001/.test(res.message)); assert.strictEqual(res.record.status,"received");
    assert.strictEqual(stockOf(B,"SK1"),14);
  });

  // ================= scenario 3 + 4 =================
  await t("S3 accepted but the GRV not yet imported: the receiver refuses the cancel and the GRV ends it; nothing is restored", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const g = await acceptAndGrv(B,d.text);
    const c = startCancel(A,d.n,"reissue",plan([6,4,"Damaged"]));          // the dispatcher starts before it has seen the GRV
    const r = await cxCheck(B,await noticeText(A,c.caseNo));
    assert.strictEqual(r.ok,false); assert.strictEqual(r.stage,"received"); assert.ok(/already received here as GRV0001/.test(r.message));
    assert.throws(()=>B.api.commitCancelNotice(cancelDoc(r),new Date()), /already received/);
    assert.strictEqual(B.api.incomingHeader(A.api.getBranchId(),d.n).status,"received");
    const before = stockOf(A,"SK1");
    const chk = await importGrv(A,g.grvText); assert.strictEqual(chk.ok,true);
    const res = A.api.commitGrvImport(chk.doc,new Date());
    assert.ok(res.aborted && res.aborted.replacement===c.newDnNo);
    assert.strictEqual(stockOf(A,"SK1"),before,"stock untouched");
    assert.strictEqual(A.api.all("SELECT * FROM stock_adjustments").length,0);
    assert.strictEqual(A.api.dnCaseByNo(c.caseNo).state,"aborted");
    const st = status(A,A.api.getBranchId(),d.n); assert.strictEqual(st.status,"received"); assert.strictEqual(st.cancelPending,false);
    const rep = status(A,A.api.getBranchId(),c.newDnNo); assert.strictEqual(rep.status,"cancelled","the replacement never became valid");
    assert.strictEqual(A.api.dnHeaderFor(c.newDnNo).stock_posted,0);
    // and the receiver can still send the GRV
    assert.strictEqual(typeof B.api.grvSendLabel("Boka"),"string");
    function cancelDoc(x){ return x.doc; }
  });
  await t("S4 race: whichever the receiver's own database sees first wins, never both", async ()=>{
    // (a) accept first, then the notice
    let { A, B } = rig(); let d = await dispatch(A,"CBD",[["SK1",10]]);
    let c = startCancel(A,d.n,"cancel");
    await acceptAndGrv(B,d.text);
    assert.strictEqual((await cxCheck(B,await noticeText(A,c.caseNo))).stage,"received");
    // (b) notice first; an Accept screen opened BEFORE it is now stale and must fail inside its transaction
    ({ A, B } = rig()); d = await dispatch(A,"CBD",[["SK1",10]]); c = startCancel(A,d.n,"cancel");
    const stale = await recvCheck(B,d.text);
    B.api.commitCancelNotice((await cxCheck(B,await noticeText(A,c.caseNo))).doc,new Date());
    const before = snap(B);
    assert.throws(()=>B.api.commitReceive(stale.doc,new Date()), /cancelled/);
    assert.throws(()=>B.api.commitVariance(stale.doc,B.api.buildVarianceReport(stale.doc,{flags:[{index:0,counted:"3"}],note:""}).report,new Date()), /cancelled/);
    assert.strictEqual(snap(B),before); assert.strictEqual(stockOf(B,"SK1"),4);
  });

  // ================= scenario 5 =================
  await t("S5 receiver unreachable: override posts now (flagged); a later confirmation clears the flag; a later GRV makes it a conflict", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const c = startCancel(A,d.n,"cancel");
    assert.throws(()=>A.api.overridePendingCase({ dnNo:d.n, passcode:"9999", typed:"cancel dn0001" }), /Type CANCEL DN0001 exactly/);
    assert.throws(()=>A.api.overridePendingCase({ dnNo:d.n, passcode:"0000", typed:"CANCEL DN0001" }), /Incorrect Admin passcode/);
    assert.strictEqual(stockOf(A,"SK1"),20);
    A.api.overridePendingCase({ dnNo:d.n, passcode:"9999", typed:"CANCEL DN0001" });
    assert.strictEqual(stockOf(A,"SK1"),30);
    let st = status(A,A.api.getBranchId(),d.n);
    assert.strictEqual(st.status,"cancelled"); assert.strictEqual(st.unconfirmed,true); assert.ok(/WITHOUT the receiver's confirmation/.test(A.api.chainText(st)));
    assert.strictEqual(A.api.dnNeedsAttention(st),true);
    assert.strictEqual(A.api.all("SELECT * FROM stock_adjustments").length,1);
    // the receiver later imports the notice and confirms: flag cleared, nothing posted twice
    B.api.commitCancelNotice((await cxCheck(B,await noticeText(A,c.caseNo))).doc,new Date());
    const chk = (await A.api.ackCheckBytes(await ackBytes(B,A.api.getBranchId(),d.n))).res; assert.strictEqual(chk.ok,true,chk.message);
    const r = A.api.commitAckImport(chk.doc,new Date());
    assert.strictEqual(r.posted,false); assert.strictEqual(r.upgraded,true);
    assert.strictEqual(stockOf(A,"SK1"),30); assert.strictEqual(A.api.all("SELECT * FROM stock_adjustments").length,1);
    st = status(A,A.api.getBranchId(),d.n); assert.strictEqual(st.unconfirmed,false); assert.strictEqual(st.status,"cancelled");
    assert.strictEqual((await A.api.ackCheckBytes(await ackBytes(B,A.api.getBranchId(),d.n))).res.stage,"duplicate");
  });
  await t("S5b override then the goods ARE received: conflict, recorded, no automatic change", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const g = await acceptAndGrv(B,d.text);                                      // the receiver accepted; the dispatcher doesn't know yet
    startCancel(A,d.n,"cancel",[],{ override:true, typed:"CANCEL DN0001" });   // start + override in one go
    assert.strictEqual(stockOf(A,"SK1"),30);
    const before = { stock:stockOf(A,"SK1"), adj:A.api.all("SELECT * FROM stock_adjustments").length, hdr:A.api.dnHeaderFor(d.n).status };
    const res = await importGrv(A,g.grvText);
    assert.strictEqual(res.ok,false); assert.strictEqual(res.stage,"conflict"); assert.ok(/shows as Conflict/.test(res.message)); assert.ok(/No stock was changed/.test(res.message));
    A.api.commitConflictGrv(res.doc,new Date());
    assert.strictEqual(stockOf(A,"SK1"),before.stock); assert.strictEqual(A.api.all("SELECT * FROM stock_adjustments").length,before.adj);
    assert.strictEqual(A.api.dnHeaderFor(d.n).status,before.hdr);
    const st = status(A,A.api.getBranchId(),d.n); assert.strictEqual(st.status,"conflict"); assert.strictEqual(st.grvNo,1);
    assert.ok(/check stock/.test(A.api.chainText(st))); assert.strictEqual(A.api.dnNeedsAttention(st),true);
    A.api.commitConflictGrv(res.doc,new Date());                                   // repeating adds nothing
    assert.strictEqual(A.api.all("SELECT * FROM dn_events WHERE event_type='received'").length,1);
  });

  // ================= scenario 6 =================
  await t("S6 the notice imported twice, at the wrong branch, at the dispatcher, or tampered", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]); const c = startCancel(A,d.n,"cancel"); const nt = await noticeText(A,c.caseNo);
    const first = await cxCheck(B,nt); B.api.commitCancelNotice(first.doc,new Date());
    const before = snap(B);
    const second = await cxCheck(B,nt); assert.strictEqual(second.ok,true); assert.strictEqual(second.already,true);
    assert.strictEqual(snap(B),before,"the second import writes nothing (it just offers the confirmation again)");
    assert.strictEqual(B.api.commitCancelNotice(second.doc,new Date()).status,"cancelled");
    const other = makeApp({ branch_name:"Mutare", branch_type:"remote", setup_complete:"1" }); other.api.getBranchId();
    const wrong = await cxCheck(other,nt); assert.strictEqual(wrong.stage,"destination"); assert.ok(/for "CBD", but this branch is "Mutare"/.test(wrong.message));
    assert.strictEqual(other.api.all("SELECT * FROM dispatch_docs").length,0);
    const own = await cxCheck(A,nt); assert.strictEqual(own.stage,"own");
    const bad = await cxCheck(B,nt.replace('"units":10','"units":11'));
    assert.strictEqual(bad.ok,false); assert.strictEqual(bad.stage,"file");
    assert.strictEqual((await cxCheck(B,"garbage")).stage,"file");
  });
  await t("S6b the confirmation twice, wrong branch, wrong nonce, unknown DN, wrong receiver, tampered: each refused, nothing changes", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]); const c = startCancel(A,d.n,"cancel");
    B.api.commitCancelNotice((await cxCheck(B,await noticeText(A,c.caseNo))).doc,new Date());
    const good = B.api.serializeAck(await B.api.buildAckFromRow(B.api.incomingHeader(A.api.getBranchId(),d.n)));
    const p = JSON.parse(good);
    const mk = (o)=>A.api.buildAck(Object.assign({ cancelNo:p.cancel_no, nonce:p.nonce, dnNo:p.dn_no, fromBranchId:p.from.branch_id, fromName:"Boka", toBranchId:p.to.branch_id, toName:"CBD", varianceSeen:false, confirmedIso:p.confirmed_iso },o)).then(x=>A.api.serializeAck(x));
    const before = snap(A);
    const chk = async (txt)=>(await A.api.ackCheckBytes(bytesOf(txt))).res;
    assert.strictEqual((await chk(await mk({ fromBranchId:"B-OTHER999" }))).stage,"branch");
    assert.strictEqual((await chk(await mk({ dnNo:77 }))).stage,"unknown");
    assert.strictEqual((await chk(await mk({ nonce:"AAAAAAAAAAAAAAAA" }))).stage,"nomatch");
    assert.strictEqual((await chk(await mk({ cancelNo:9 }))).stage,"nomatch");
    const wr = await chk(await mk({ toName:"Mutare" })); assert.strictEqual(wr.stage,"receiver"); assert.ok(/from "Mutare"/.test(wr.message));
    assert.strictEqual((await chk(good.replace('"variance_seen":false','"variance_seen":true'))).stage,"file");
    assert.strictEqual((await chk("{}")).stage,"file");
    assert.strictEqual(snap(A),before,"nothing changed by any refusal");
    assert.strictEqual((await chk(good)).ok,true);
  });

  // ================= scenario 7 =================
  await t("S7 a GRV for an already cancelled DN: recorded as a fact, DN shows conflict, stock and header untouched", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const g = await acceptAndGrv(B,d.text);                    // B accepted...
    const c = startCancel(A,d.n,"cancel");
    A.api.overridePendingCase({ dnNo:d.n, passcode:"9999", typed:"CANCEL DN0001" });   // ...and the dispatcher cancelled (never saw the GRV)
    const s0 = stockOf(A,"SK1");
    const res = await importGrv(A,g.grvText); assert.strictEqual(res.stage,"conflict");
    A.api.commitConflictGrv(res.doc,new Date());
    assert.strictEqual(status(A,A.api.getBranchId(),d.n).status,"conflict"); assert.strictEqual(stockOf(A,"SK1"),s0);
  });

  // ================= scenario 9 =================
  await t("S9 destination name that no longer matches: the receiver refuses the notice and the replacement; override is the way out", async ()=>{
    const { A } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const B2 = makeApp({ branch_name:"Harare CBD", branch_type:"remote", setup_complete:"1" }); addProduct(B2,"Harare CBD",{name:"Rice 2kg",sku:"SK1",stock:0}); B2.api.getBranchId();
    const c = startCancel(A,d.n,"reissue",plan([6,4,"Damaged"]));
    const nr = await cxCheck(B2,await noticeText(A,c.caseNo)); assert.strictEqual(nr.stage,"destination");
    const rr = await recvCheck(B2,await replacementText(A,c.newDnNo)); assert.strictEqual(rr.stage,"destination");
    assert.strictEqual(B2.api.all("SELECT * FROM dispatch_docs").length,0,"no tombstone anywhere");
    assert.strictEqual(A.api.dnCaseByNo(c.caseNo).state,"pending"); assert.strictEqual(stockOf(A,"SK1"),20);
    A.api.overridePendingCase({ dnNo:d.n, passcode:"9999", typed:"CANCEL DN0001" });
    assert.strictEqual(stockOf(A,"SK1"),20,"restore +10, replacement -6, write-off -4");
    assert.strictEqual(status(A,A.api.getBranchId(),d.n).unconfirmed,true);
  });

  // ================= loss =================
  await t("close as loss: restore then write off, net zero on stock, both rows linked; main values the loss at ITS cost", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10],["SK2",4]]);
    const c = startCancel(A,d.n,"loss",[{reason:"Lost in transit"},{reason:"Damaged"}]);
    const after = { sk1:stockOf(A,"SK1"), sk2:stockOf(A,"SK2") };
    B.api.commitCancelNotice((await cxCheck(B,await noticeText(A,c.caseNo))).doc,new Date());
    A.api.commitAckImport((await A.api.ackCheckBytes(await ackBytes(B,A.api.getBranchId(),d.n))).res.doc,new Date());
    assert.strictEqual(stockOf(A,"SK1"),after.sk1,"the goods already left the books at dispatch: net zero"); assert.strictEqual(stockOf(A,"SK2"),after.sk2);
    const rows = A.api.all("SELECT reason,qty_delta FROM stock_adjustments ORDER BY id").map(x=>x.reason+":"+x.qty_delta);
    assert.strictEqual(J(rows),J(["Dispatch cancelled:10","Dispatch cancelled:4","Lost in transit:-10","Damaged:-4"]));
    assert.strictEqual(status(A,A.api.getBranchId(),d.n).status,"loss_closed");
    assert.strictEqual(A.api.dnHeaderFor(d.n).status,"loss_closed");
    // main merges the dispatcher's file: the loss shows in Stock Adjustments and, per DN, in Stock Movements at main's cost
    const M = makeApp({ branch_name:"Head Office", branch_type:"main", setup_complete:"1" });
    addProduct(M,"Head Office",{name:"Rice 2kg",sku:"SK1",stock:1,cost:3.5}); addProduct(M,"Head Office",{name:"Sugar 1kg",sku:"SK2",stock:1,cost:0});
    await M.api.mergeDatabase({ __db:A.db }); await M.api.mergeDatabase({ __db:B.db });
    const rep = M.api.adjustmentReport({}); const lossRow = rep.rows.find(r=>r.reason==="Lost in transit");
    assert.strictEqual(lossRow.value,-35); assert.strictEqual(rep.rows.find(r=>r.reason==="Damaged").value,null,"no main cost for SK2: blank");
    const mv = M.api.REPORT_CONFIGS.find(x=>x.id==="movements").fetch(null,"2000-01-01T00:00:00","2100-01-01T00:00:00",null,"",{});
    const row = mv.rows.find(r=>r[0]==="DN0001");
    assert.ok(/Closed as loss/.test(row[4])); assert.strictEqual(row[8],"$35.00"); assert.ok(/Closed as loss/.test(mv.footer));
    const only = M.api.REPORT_CONFIGS.find(x=>x.id==="movements").fetch(null,"2000-01-01T00:00:00","2100-01-01T00:00:00",null,"loss_closed",{}); assert.strictEqual(only.rows.length,1);
    assert.ok(M.api.ADJ_SYSTEM_REASONS.includes("Dispatch cancelled") && !M.api.ADJ_REASONS.includes("Dispatch cancelled"), "the restore reason is system-only");
  });

  // ================= statuses =================
  await t("status precedence, awaiting excludes cancelled and pending, the flags, attention and the chain", ()=>{
    const { A } = rig();
    const now = Date.parse("2026-09-30T00:00:00Z"), old = "2026-09-01T00:00:00Z";
    const st = (o)=>A.api.computeDnStatus(Object.assign({ dispatchedTs:old },o),now,7);
    assert.strictEqual(st({}),"awaiting");
    assert.strictEqual(st({ pending:{kind:"cancel"} }),"cancel_pending","awaiting never applies to a DN with a cancel pending");
    assert.strictEqual(st({ pending:{kind:"cancel"}, hasVariance:true }),"variance");
    assert.strictEqual(st({ pending:{kind:"cancel"}, aborted:true }),"awaiting");
    assert.strictEqual(st({ posted:{kind:"cancel"} }),"cancelled","awaiting never applies to a cancelled DN");
    assert.strictEqual(st({ posted:{kind:"reissue"} }),"superseded"); assert.strictEqual(st({ posted:{kind:"loss"} }),"loss_closed"); assert.strictEqual(st({ posted:{kind:"aborted"} }),"cancelled");
    assert.strictEqual(st({ posted:{kind:"cancel"}, hasReceived:true }),"conflict"); assert.strictEqual(st({ hasReceived:true, hasVariance:true }),"received");
    const ev = (type,detail,ts)=>({ dn_branch_id:"B-1", dn_no:1, event_type:type, dn_from_name:"Boka", dn_to_name:"CBD", event_ts:ts||old, grv_no:null, detail_json:detail? J(detail) : "" });
    const rows = A.api.buildMovements([ev("dispatched",{}),ev("variance",{flags:[{code:"SK1",name:"R",dn:10,counted:7}],note:"n"},"2026-09-02T00:00:00Z"),ev("cancel_pending",{kind:"reissue",cancel_no:1,replaced_by:2},"2026-09-03T00:00:00Z")],now,7);
    assert.strictEqual(rows[0].status,"variance"); assert.strictEqual(rows[0].cancelPending,true,"both are shown: the variance status and the pending-cancel flag");
    assert.strictEqual(A.api.dnNeedsAttention(rows[0]),true); assert.ok(/to be replaced by DN0002/.test(A.api.chainText(rows[0])));
    const dnRow = (over)=>Object.assign({ status:"dispatched", cancelPending:false, unconfirmed:false },over);
    assert.strictEqual(A.api.dnNeedsAttention(dnRow({ status:"cancelled" })),false); assert.strictEqual(A.api.dnNeedsAttention(dnRow({ status:"conflict" })),true);
    assert.strictEqual(A.api.dnNeedsAttention(dnRow({ status:"superseded", unconfirmed:true })),true);
    assert.strictEqual(J(A.api.filterMovements([dnRow({ status:"cancelled", from:"a", to:"b" }),dnRow({ status:"cancel_pending", from:"a", to:"b" })],{ status:"cancel_pending" }).map(r=>r.status)),J(["cancel_pending"]));
    ["dispatched","received","variance","awaiting","cancel_pending","cancelled","superseded","loss_closed","conflict"].forEach(s=>assert.ok(A.api.DN_STATUS_LABEL[s],s+" has a label"));
  });
  await t("Dispatch History and Stock Dispatched show the new statuses; a cancelled DN can't be shared as if live", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]); const c = startCancel(A,d.n,"cancel");
    const rep = (cfg)=>A.api.REPORT_CONFIGS.find(x=>x.id===cfg).fetch(null,"2000-01-01T00:00:00","2100-01-01T00:00:00");
    assert.ok(rep("transfers").rows.some(r=>r[5]==="Cancel pending"));
    B.api.commitCancelNotice((await cxCheck(B,await noticeText(A,c.caseNo))).doc,new Date());
    A.api.commitAckImport((await A.api.ackCheckBytes(await ackBytes(B,A.api.getBranchId(),d.n))).res.doc,new Date());
    assert.ok(rep("transfers").rows.some(r=>r[5]==="Cancelled"));
    assert.ok(A.api.all("SELECT status FROM stock_transfers WHERE dn_no=?",[d.n]).every(r=>r.status==="Dispatched"),"the lines keep their dn_no and are never deleted");
    const src = fs.readFileSync(path.join(__dirname,"..","src","dispatch-out.js"),"utf8");
    assert.ok(/DN_CLOSED_STATUSES\.includes\(st\)\? ""/.test(src), "no Share button on a cancelled / superseded / loss-closed DN");
    assert.ok(/data-cancel=/.test(src) && /data-pending=/.test(src));
  });

  // ================= receiver screens and guards =================
  await t("Receipts history: a cancelled DN reads Cancelled (replaced by ...), offers only Send confirmation, and can't be reopened", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]); const c = startCancel(A,d.n,"reissue",plan([6,4,"Damaged"]));
    const res = await recvCheck(B,await replacementText(A,c.newDnNo)); B.api.commitReplacementClose(res.doc,new Date());
    const h = B.api.incomingHeader(A.api.getBranchId(),d.n);
    assert.strictEqual(h.status,"cancelled"); assert.strictEqual(h.replaced_by,c.newDnNo); assert.ok(h.cancel_no);
    const src = fs.readFileSync(path.join(__dirname,"..","src","receive-in.js"),"utf8");
    assert.ok(/cancelled\? "Cancelled"/.test(src) && /data-cxack/.test(src));
    assert.ok(/status==="cancelled"/.test(fs.readFileSync(path.join(__dirname,"..","src","dnreceive.js"),"utf8")));
    // sharing the confirmation uses the per-build share layer, with the dispatcher's number when the register has it
    B.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Boka','0771111111')");
    let shared = null; B.hook("shareDocFile", async (o)=>{ shared = o; return { method:"downloaded" }; });
    await B.api.cancelAckShare(h);
    assert.strictEqual(shared.phone,"0771111111"); assert.ok(/CXL0001-Boka-.*-confirmed\.json$/.test(shared.fileName)); assert.strictEqual(shared.folder,"Cancellations");
    assert.ok(/Import/.test(shared.shareText) && shared.shareText.includes("CXL0001"));
    assert.strictEqual((await A.api.parseAck(shared.text)).ok,true);
  });
  await t("the old data-merge box refuses a cancellation notice / confirmation by content (any name), changes nothing, and points to the right screen", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]); const c = startCancel(A,d.n,"cancel");
    const nt = await noticeText(A,c.caseNo);
    B.api.commitCancelNotice((await cxCheck(B,nt)).doc,new Date());
    const ack = B.api.serializeAck(await B.api.buildAckFromRow(B.api.incomingHeader(A.api.getBranchId(),d.n)));
    for(const [app,text,btnText,opens] of [[B,nt,"Open Receive stock","openReceiveWithFile"],[A,ack,"Open Import","openGrvImportWithFile"]]){
      const calls = { download:0, merge:0, modals:[], opened:null };
      app.hook("downloadDb",()=>calls.download++); app.hook("mergeDatabase",async ()=>{ calls.merge++; }); app.hook(opens,(f)=>{ calls.opened = f; });
      app.hook("openModal",(title,html)=>{ const btn={onclick:null}; const w={title,html,btn,remove(){}, querySelector:(s)=>s==="#dnGuardReceive"? btn : null}; calls.modals.push(w); return w; });
      const before = snap(app), f = fileOf("whatsapp-image.txt",Buffer.from(text,"utf8"));
      await app.api.onMergePicked(f); await app.api.onReplacePicked(f);
      assert.strictEqual(calls.download,0); assert.strictEqual(calls.merge,0); assert.strictEqual(snap(app),before);
      assert.ok(calls.modals[0].html.includes(btnText)); calls.modals[0].btn.onclick(); assert.strictEqual(calls.opened,f);
    }
  });
  await t("migration: the new tables/columns arrive on an old device, repeat safely, and old DN rows count as stock-posted", ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    const id = A.api.getBranchId();
    A.api.run("INSERT INTO dispatch_docs(dispatch_branch_id,dispatch_branch_name,dn_no,receive_branch_name,direction,created_ts,status) VALUES(?,?,?,?,?,?,?)",[id,"Boka",1,"CBD","out","2026-09-01T00:00:00Z","dispatched"]);
    A.api.migrate(A.db);                                   // the first run backfills the dispatched event for the old row
    const before = snap(A); A.api.migrate(A.db); A.api.migrate(A.db); assert.strictEqual(snap(A),before);
    assert.strictEqual(A.api.one("SELECT stock_posted FROM dispatch_docs WHERE dn_no=1").stock_posted,1);
    ["dn_cases"].forEach(n=>assert.ok(A.api.one("SELECT name FROM sqlite_master WHERE name=?",[n])));
    assert.strictEqual(A.api.reserveDocNumber("CXL").text,"CXL0001");
  });
  await t("ledger: restore rows are positive but never reset a product's age (aging counts real intake only)", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const p = A.api.one("SELECT * FROM products WHERE sku='SK1'");
    A.api.run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES('2026-01-05T08:00:00.000Z',?,?,?,?,?,?)",[p.id,"Rice 2kg",30,"Restock","Boka","u"]);
    const c = startCancel(A,d.n,"cancel");
    B.api.commitCancelNotice((await cxCheck(B,await noticeText(A,c.caseNo))).doc,new Date());
    A.api.commitAckImport((await A.api.ackCheckBytes(await ackBytes(B,A.api.getBranchId(),d.n))).res.doc,new Date());
    assert.ok(A.api.all("SELECT * FROM stock_received WHERE adj_no IS NOT NULL AND qty>0").length>=1, "a positive restore row exists");
    const src = fs.readFileSync(path.join(__dirname,"..","src","reports.js"),"utf8");
    const sql = /SELECT MAX\(ts\) as t FROM stock_received WHERE[^"]*/.exec(src)[0].replace(/^SELECT MAX\(ts\) as t FROM stock_received/,"SELECT MAX(ts) AS t FROM stock_received");
    assert.strictEqual(A.api.one(sql,[p.id]).t,"2026-01-05T08:00:00.000Z");
  });
  await t("merge: cancel events reach main and derive the chain; each fact is one row however often files are merged", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",10]]);
    const c = startCancel(A,d.n,"reissue",plan([6,4,"Damaged"]));
    const rep = await replacementText(A,c.newDnNo); const res = await recvCheck(B,rep); B.api.commitReplacementClose(res.doc,new Date());
    const g = await acceptAndGrv(B,rep); A.api.commitGrvImport((await importGrv(A,g.grvText)).doc,new Date());
    const M = makeApp({ branch_name:"Head Office", branch_type:"main", setup_complete:"1" });
    await M.api.mergeDatabase({ __db:A.db }); await M.api.mergeDatabase({ __db:B.db });
    const n = M.api.all("SELECT * FROM dn_events").length;
    await M.api.mergeDatabase({ __db:A.db }); await M.api.mergeDatabase({ __db:B.db });
    assert.strictEqual(M.api.all("SELECT * FROM dn_events").length,n);
    const rows = M.api.dnMovementRows(); const old = rows.find(r=>r.dnNo===d.n), nw = rows.find(r=>r.dnNo===c.newDnNo);
    assert.strictEqual(old.status,"superseded"); assert.strictEqual(nw.status,"received"); assert.strictEqual(old.replacedBy,c.newDnNo); assert.strictEqual(nw.replaces,d.n);
    assert.strictEqual(M.api.all("SELECT * FROM dispatch_docs").length,0,"dispatch_docs and dn_cases are never merged");
    assert.strictEqual(M.api.all("SELECT name FROM sqlite_master WHERE name='dn_cases'").length,1);
    const view = M.api.REPORT_CONFIGS.find(x=>x.id==="movements").fetch(null,"2000-01-01T00:00:00","2100-01-01T00:00:00",null,"",{});
    assert.ok(view.rows.some(r=>r[0]==="DN0001" && /superseded by DN0002/.test(r[7])) && view.rows.some(r=>r[0]==="DN0002" && /replaces DN0001/.test(r[7])));
  });
  await t("the settings switch: off by default, and the source asks for an Admin passcode to change it", ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    assert.strictEqual(A.api.cancelEnabled(),false);
    const src = fs.readFileSync(path.join(__dirname,"..","src","settings.js"),"utf8");
    assert.ok(/id="sCancelOn"/.test(src) && /findAdmin\(prompt\(/.test(src));
    const A2 = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", cancel_enabled:"1" }); assert.strictEqual(A2.api.cancelEnabled(),true);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
