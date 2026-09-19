// Run: node --no-warnings test/receive.test.js
// Receiving side over the REAL app source and SQLite: import checks, Accept, variance, GRV, merge safety.
"use strict";
const assert = require("assert");
const vm = require("vm");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,4).join("\n       ")); }
}
const NOW = new Date(2026,8,4,8,0), LATER = new Date(2026,8,5,14,15);
const bytesOf = (text)=>new Uint8Array(Buffer.from(text,"utf8"));
const THUMB = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

function addProduct(app, branch, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [o.name,o.price==null?5:o.price,o.stock==null?0:o.stock,3,o.sku,branch,"",o.cost==null?3:o.cost,"2026-01-01",""]);
  return app.api.one("SELECT * FROM products WHERE branch=? AND name=?",[branch,o.name]);
}
function snapshot(app){
  const names = app.api.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
  return JSON.stringify(names.map(n=>[n, app.api.all("SELECT * FROM "+n)]));
}
const stockOf = (app, sku)=>app.api.one("SELECT stock FROM products WHERE lower(sku)=lower(?) AND branch=?",[sku,app.api.currentBranch()]).stock;
const grvCounter = (app)=>app.api.one("SELECT last_no FROM doc_counters WHERE doc_type='GRV'");
const countProducts = (app)=>app.api.all("SELECT id FROM products").length;

// Dispatcher "Boka" (main) and receiver "CBD" (remote); products share codes.
function rig(){
  const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", contact_phone:"0771111111" });
  const B = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
  // Phase 4: a remote now refuses main-type files. These older tests exercise the merge LOGIC itself,
  // so the refusal is bypassed here; the refusal has its own tests (phase4.test.js).
  B.hook("mainFileProblem", ()=>"");
  addProduct(A,"Boka",{name:"Rice 2kg",sku:"SK1",stock:20}); addProduct(A,"Boka",{name:"Sugar 1kg",sku:"SK2",stock:10}); addProduct(A,"Boka",{name:"Salt",sku:"SK3",stock:10});
  addProduct(B,"CBD",{name:"Rice 2kg",sku:"SK1",stock:4,price:5.5,cost:3.3}); addProduct(B,"CBD",{name:"Sugar 1kg",sku:"SK2",stock:0});
  A.api.getBranchId(); B.api.getBranchId();   // branch_id is created lazily; fix it up front so snapshots compare cleanly
  A.api.ensureSelfInRegister();
  ["CBD","Mutare","Elsewhere"].forEach(n=>A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES(?,'')",[n]));
  return { A, B };
}
// Real dispatch on A, then the DN file exactly as it would be sent.
async function dispatch(A, toBranch, lines, when){
  const products = lines.map(l=>A.api.one("SELECT * FROM products WHERE sku=? AND branch='Boka'",[l[0]]));
  const dn = A.api.dnCommitDispatch({ branch:"Boka", toBranch, now:when||NOW, lines:lines.map((l,i)=>({product:products[i],qty:l[1]})) });
  const h = A.api.dnHeaderFor(dn.n);
  const doc = await A.api.buildDN({ dnNo:dn.n, fromBranchId:A.api.getBranchId(), fromName:"Boka", toName:toBranch, createdIso:h.created_iso,
    items:lines.map((l,i)=>({ code:l[0], name:products[i].name, qty:l[1], thumb:THUMB })) });
  return { dn, text:A.api.serializeDN(doc), doc };
}
async function rawDN(A, o){    // hand-built DN (things the dispatch screen would refuse)
  const doc = await A.api.buildDN(Object.assign({ dnNo:77, fromBranchId:A.api.getBranchId(), fromName:"Boka", toName:"CBD", createdIso:"2026-09-04T08:00:00+02:00", items:[{code:"SK1",name:"Rice 2kg",qty:1}] }, o));
  return A.api.serializeDN(doc);
}
const check = (app, text)=>app.api.receiveCheckBytes(bytesOf(text)).then(r=>r.res);

(async()=>{
  // ================= Accept =================
  await t("accept: adds stock exactly once, links lines to (from branch, DN, GRV), never creates a product", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    const before = { products:countProducts(B), price:B.api.one("SELECT price,cost FROM products WHERE sku='SK1'") };
    const res = await check(B, d.text);
    assert.strictEqual(res.ok,true,res.message);
    assert.strictEqual(grvCounter(B),null,"checking uses no GRV number");
    const c = B.api.commitReceive(res.doc, LATER);
    assert.strictEqual(c.grv.text,"GRV0001");
    assert.strictEqual(stockOf(B,"SK1"),10); assert.strictEqual(stockOf(B,"SK2"),3);
    const rows = B.api.all("SELECT * FROM stock_received WHERE grv_no=1");
    assert.strictEqual(rows.length,2);
    assert.ok(rows.every(r=>r.dn_branch_id===A.api.getBranchId() && r.dn_no===d.dn.n && r.branch==="CBD" && r.qty>0 && r.user==="Tester"));
    const h = B.api.incomingHeader(A.api.getBranchId(), d.dn.n);
    assert.strictEqual(h.status,"received"); assert.strictEqual(h.grv_no,1); assert.strictEqual(h.direction,"in");
    assert.strictEqual(h.dispatch_branch_name,"Boka"); assert.strictEqual(h.unit_total,9);
    assert.strictEqual(h.file_name,"GRV0001-Boka-05Sep26-0215PM.json");
    assert.strictEqual(countProducts(B),before.products,"no product created");
    const p = B.api.one("SELECT price,cost FROM products WHERE sku='SK1'");
    assert.strictEqual(p.price,before.price.price); assert.strictEqual(p.cost,before.price.cost);
    assert.strictEqual(B.api.all("SELECT * FROM stock_transfers").length,0,"no pending-receipt row is ever written");
    assert.strictEqual(B.api.pendingTransfersCount(),0);
  });
  await t("accept: a second import of the same DN is blocked, and a second Accept adds nothing (double-tap)", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const res = await check(B, d.text);
    B.api.commitReceive(res.doc, LATER);
    assert.throws(()=>B.api.commitReceive(res.doc, LATER), /Already received as GRV0001/);
    assert.strictEqual(stockOf(B,"SK1"),10);
    assert.strictEqual(grvCounter(B).last_no,1,"exactly one GRV number used");
    const again = await check(B, d.text);
    assert.strictEqual(again.ok,false); assert.strictEqual(again.stage,"duplicate");
    assert.strictEqual(again.message,"Already received on 05Sep26 as GRV0001.");
  });
  await t("accept: file renamed to .txt / with BOM is accepted (judged by content)", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",1]]);
    const r = await B.api.receiveCheckBytes(new Uint8Array(Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]),Buffer.from(d.text,"utf8")])));
    assert.strictEqual(r.res.ok,true,r.res.message);
  });
  await t("the receiver cannot change a quantity: only the DN's own numbers can be added", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const edited = JSON.parse(d.text); edited.items[0].qty = 60; edited.totals.units = 60;
    const r = await check(B, JSON.stringify(edited));
    assert.strictEqual(r.ok,false); assert.ok(/checksum/i.test(r.message));
    assert.strictEqual(stockOf(B,"SK1"),4);
    const ok = await check(B, d.text); B.api.commitReceive(ok.doc, LATER);
    assert.strictEqual(stockOf(B,"SK1"),4+6);
  });

  // ================= Blocked imports: no stock change, no GRV number =================
  async function blocked(name, mk, stage, re){
    await t("blocked: "+name+" — no stock change, no GRV number, no record", async ()=>{
      const { A, B } = rig();
      const text = await mk(A, B);
      const target = stage==="own" ? A : B;
      const before = snapshot(target);
      const r = await check(target, text);
      assert.strictEqual(r.ok,false); assert.strictEqual(r.stage,stage,r.message);
      if(re) assert.ok(re.test(r.message), r.message);
      assert.strictEqual(snapshot(target),before);
      assert.strictEqual(grvCounter(target),null);
    });
  }
  await blocked("wrong destination", async (A)=> (await dispatch(A,"Elsewhere",[["SK1",1]])).text, "destination", /"Elsewhere".*"CBD"/);
  await blocked("tampered file", async (A)=>{ const d = JSON.parse((await dispatch(A,"CBD",[["SK1",1]])).text); d.items[0].name="Changed"; return JSON.stringify(d); }, "file", /checksum/i);
  await blocked("not a DN at all", async ()=>"hello", "file");
  await blocked("a DN this branch dispatched itself", async (A)=> (await dispatch(A,"CBD",[["SK1",1]])).text, "own", /dispatched by this branch/);
  await blocked("unknown code", async (A)=> (await dispatch(A,"CBD",[["SK3",1]])).text, "products", null);
  await blocked("code-less line whose name matches two products", async (A,B)=>{
    addProduct(B,"CBD",{name:"Twin",sku:"T1"}); addProduct(B,"CBD",{name:"Twin ",sku:"T2"});
    return rawDN(A,{ items:[{code:"",name:"Twin",qty:1}] });
  }, "products");
  await blocked("code-less line with no exact name match", async (A)=> rawDN(A,{ items:[{code:"",name:"Rice",qty:1}] }), "products");
  await blocked("two local products share the code", async (A,B)=>{ addProduct(B,"CBD",{name:"Rice B",sku:"sk1"}); return (await dispatch(A,"CBD",[["SK1",1]])).text; }, "products");

  await t("blocked: one unmatched line blocks the WHOLE receipt and lists it; management can be told", async ()=>{
    const { A, B } = rig();
    const d = await dispatch(A,"CBD",[["SK1",2],["SK3",4]]);
    const before = snapshot(B);
    const r = await check(B, d.text);
    assert.strictEqual(r.ok,false); assert.strictEqual(r.stage,"products");
    assert.strictEqual(r.problems.length,1); assert.strictEqual(r.problems[0].code,"SK3"); assert.strictEqual(r.problems[0].reason,"not found");
    assert.strictEqual(snapshot(B),before, "the matching line (SK1) was not received either");
    assert.strictEqual(countProducts(B),2,"no product created");
    const msg = B.api.unmatchedMessage(r.doc,"CBD",r.problems,LATER);
    assert.ok(/^UNMATCHED PRODUCTS\nDN\d{4} from Boka to CBD, dispatched 04Sep26\nStock NOT received\.\nSK3 Salt: code not found in this branch\nReported 05Sep26 2:15 PM$/.test(msg), msg);
    // the same WhatsApp path as the variance report
    let url = null; B.hook("openExternalUrl", (u)=>{ url = u; });
    B.api.openManagementWhatsApp(msg);
    assert.ok(url.startsWith("https://wa.me/?text=UNMATCHED%20PRODUCTS"), url);
  });
  await t("blocked: a line whose product vanished between check and Accept rolls EVERYTHING back", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    const res = await check(B, d.text);
    B.api.run("DELETE FROM products WHERE sku='SK2'");
    const before = snapshot(B);
    assert.throws(()=>B.api.commitReceive(res.doc, LATER), /no longer match/);
    assert.strictEqual(snapshot(B),before);
    assert.strictEqual(grvCounter(B),null,"the reserved number was rolled back with it");
  });
  await t("rollback: a failure late in the transaction undoes stock, header, links AND the GRV number", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    const res = await check(B, d.text);
    const before = snapshot(B);
    B.hook("logAudit", ()=>{ throw new Error("disk exploded"); });     // runs after stock + header are written
    assert.throws(()=>B.api.commitReceive(res.doc, LATER), /disk exploded/);
    assert.strictEqual(snapshot(B),before);
    assert.strictEqual(grvCounter(B),null);
    assert.strictEqual(stockOf(B,"SK1"),4);
    B.hook("logAudit", ()=>{});                                          // and the retry works, as GRV0001
    assert.strictEqual(B.api.commitReceive(res.doc, LATER).grv.text,"GRV0001");
  });
  await t("signed-in user required; nothing changes without one", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6]]);
    const res = await check(B, d.text);
    vm.runInContext('sessionUser=""', B.ctx);
    const before = snapshot(B);
    assert.throws(()=>B.api.commitReceive(res.doc, LATER), /Enter your name first/);
    assert.throws(()=>B.api.commitVariance(res.doc,{flags:[],note:"x"},LATER), /Enter your name first/);
    assert.strictEqual(snapshot(B),before);
  });

  // ================= Variance =================
  await t("variance: no stock, no GRV number; DN stays open; later Accept works; re-report replaces", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    const res = await check(B, d.text);
    const rep = B.api.buildVarianceReport(res.doc,{ flags:[{index:0,counted:"4"}], note:"one box damaged" });
    assert.strictEqual(rep.ok,true,rep.errors.join("|"));
    B.api.commitVariance(res.doc, rep.report, NOW);
    assert.strictEqual(stockOf(B,"SK1"),4); assert.strictEqual(stockOf(B,"SK2"),0);
    assert.strictEqual(grvCounter(B),null,"no GRV number used");
    assert.strictEqual(B.api.all("SELECT * FROM stock_received").length,0);
    let h = B.api.incomingHeader(A.api.getBranchId(), d.dn.n);
    assert.strictEqual(h.status,"variance"); assert.strictEqual(h.grv_no,null);
    const saved = JSON.parse(h.variance_json); assert.strictEqual(saved.flags[0].counted,4); assert.strictEqual(saved.note,"one box damaged");
    // reopen: allowed, flagged as a recount
    const again = await check(B, d.text);
    assert.strictEqual(again.ok,true); assert.strictEqual(again.resume,true);
    // report again: replaces
    const rep2 = B.api.buildVarianceReport(again.doc,{ flags:[{index:1,counted:"0"}], note:"" });
    B.api.commitVariance(again.doc, rep2.report, NOW);
    assert.strictEqual(B.api.all("SELECT * FROM dispatch_docs WHERE direction='in'").length,1);
    assert.strictEqual(JSON.parse(B.api.incomingHeader(A.api.getBranchId(), d.dn.n).variance_json).flags[0].index,1);
    assert.strictEqual(grvCounter(B),null);
    // recount matched: accept as-is
    const c = B.api.commitReceive(again.doc, LATER);
    assert.strictEqual(c.grv.text,"GRV0001");
    assert.strictEqual(stockOf(B,"SK1"),10); assert.strictEqual(stockOf(B,"SK2"),3);
    h = B.api.incomingHeader(A.api.getBranchId(), d.dn.n);
    assert.strictEqual(h.status,"received"); assert.strictEqual(B.api.all("SELECT * FROM dispatch_docs WHERE direction='in'").length,1);
    // and now a variance can no longer be filed
    assert.throws(()=>B.api.commitVariance(again.doc, rep2.report, NOW), /Already received/);
  });
  await t("variance report validation", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    const doc = (await check(B, d.text)).doc, V = B.api.buildVarianceReport;
    assert.strictEqual(V(doc,{flags:[],note:""}).ok,false,"needs a flagged line or a note");
    assert.strictEqual(V(doc,{flags:[],note:"  "}).ok,false);
    assert.strictEqual(V(doc,{flags:[],note:"box crushed"}).ok,true,"a note alone is enough");
    assert.strictEqual(V(doc,{flags:[{index:0,counted:"0"}]}).ok,true,"counted 0 is valid");
    for(const bad of ["-1","1.5","abc","","  ",null,"1e3"]) assert.strictEqual(V(doc,{flags:[{index:0,counted:bad}]}).ok,false, JSON.stringify(bad));
    assert.strictEqual(V(doc,{flags:[{index:0,counted:"1"},{index:0,counted:"2"}]}).ok,false,"a line flagged twice");
    assert.strictEqual(V(doc,{flags:[{index:9,counted:"1"}]}).ok,false);
    const r = V(doc,{flags:[{index:0,counted:"4"},{index:1,counted:"5"}]});
    assert.strictEqual(r.report.flags[0].diff,-2); assert.strictEqual(r.report.flags[1].diff,2);
  });
  await t("variance message: exact format, short/over, no-number and with-number URLs", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",12],["SK2",3]]);
    const doc = (await check(B, d.text)).doc;
    const rep = B.api.buildVarianceReport(doc,{ flags:[{index:0,counted:"10"},{index:1,counted:"5"}], note:"Two boxes wet" }).report;
    const msg = B.api.varianceMessage(doc,"CBD",rep,LATER);
    assert.strictEqual(msg,
      "VARIANCE REPORT\nDN0001 from Boka to CBD, dispatched 04Sep26\nStock NOT received.\nSK1 Rice 2kg: DN 12, counted 10 (short 2)\nSK2 Sugar 1kg: DN 3, counted 5 (over 2)\nNote: Two boxes wet\nReported 05Sep26 2:15 PM");
    let url = null; B.hook("openExternalUrl", (u)=>{ url = u; });
    B.api.openManagementWhatsApp(msg);
    assert.ok(url.startsWith("https://wa.me/?text="), "no management number -> wa.me/?text=");
    B.api.setSetting("management_whatsapp","0779999999"); B.api.openManagementWhatsApp(msg);
    assert.ok(url.startsWith("https://wa.me/263779999999?text="), url);
    assert.strictEqual(decodeURIComponent(url.split("?text=")[1]),msg);
  });
  await t("variance message: stays under ~1500 chars, lists the first lines, then +N more", async ()=>{
    const { A, B } = rig();
    const items = Array.from({length:60},(_,i)=>({code:"CODE"+String(i).padStart(3,"0"),name:"A fairly long product name number "+i,qty:100}));
    const doc = JSON.parse(await rawDN(A,{ items }));
    const rep = B.api.buildVarianceReport(doc,{ flags:items.map((_,i)=>({index:i,counted:String(i)})), note:"n".repeat(900) }).report;
    const msg = B.api.varianceMessage(doc,"CBD",rep,LATER);
    assert.ok(msg.length<=1500, "length "+msg.length);
    assert.ok(/\+\d+ more lines, see the DN file/.test(msg));
    assert.ok(msg.includes("CODE000") && !msg.includes("CODE059"));
    const lines = msg.split("\n"); assert.strictEqual(lines[0],"VARIANCE REPORT"); assert.ok(lines[lines.length-1].startsWith("Reported "));
    const small = B.api.varianceMessage(doc,"CBD",{flags:rep.flags.slice(0,2),note:""},LATER);
    assert.ok(!/more line/.test(small));
    const singular = B.api.varianceMessage(doc,"CBD",rep,LATER,700);
    assert.ok(singular.length<=700, "length "+singular.length);
  });

  // ================= GRV numbering and file =================
  await t("GRV numbers increase per receiving branch; another branch starts at 0001", async ()=>{
    const { A, B } = rig(); const C = makeApp({ branch_name:"Mutare", branch_type:"remote", setup_complete:"1" });
    addProduct(C,"Mutare",{name:"Rice 2kg",sku:"SK1"}); addProduct(C,"Mutare",{name:"Sugar 1kg",sku:"SK2"});
    const d1 = await dispatch(A,"CBD",[["SK1",1]]), d2 = await dispatch(A,"CBD",[["SK2",2]]), d3 = await dispatch(A,"Mutare",[["SK1",1]]);
    assert.strictEqual(B.api.commitReceive((await check(B,d1.text)).doc, LATER).grv.text,"GRV0001");
    assert.strictEqual(B.api.commitReceive((await check(B,d2.text)).doc, LATER).grv.text,"GRV0002");
    assert.strictEqual(C.api.commitReceive((await check(C,d3.text)).doc, LATER).grv.text,"GRV0001");
    assert.strictEqual(B.api.all("SELECT grv_no FROM dispatch_docs WHERE direction='in' ORDER BY grv_no").map(r=>r.grv_no).join(),"1,2");
  });
  await t("GRV file: build, validate, tamper, no thumbnails, equals the DN exactly", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    const res = await check(B, d.text); const c = B.api.commitReceive(res.doc, LATER);
    const grv = await B.api.buildGRVFromCommit(res.doc, c); const text = B.api.serializeGRV(grv);
    assert.strictEqual(grv.format,"seigen-grv"); assert.strictEqual(grv.grv_display,"GRV0001"); assert.strictEqual(grv.dn_display,"DN0001");
    assert.strictEqual(grv.from.name,"Boka"); assert.strictEqual(grv.to.name,"CBD"); assert.strictEqual(grv.to.branch_id,B.api.getBranchId());
    assert.ok(!/thumb|data:image/.test(text));
    assert.strictEqual(JSON.stringify(grv.items.map(i=>[i.code,i.name,i.qty])),JSON.stringify(res.doc.items.map(i=>[i.code,i.name,i.qty])),"GRV == DN");
    assert.strictEqual(grv.totals.units,9);
    assert.strictEqual((await B.api.parseGRV(text)).ok,true);
    for(const mut of [g=>{g.items[0].qty=7; g.totals.units=10;}, g=>{g.to.name="X";}, g=>{g.received_iso="2027-01-01T00:00:00Z";}, g=>{delete g.checksum;}, g=>{g.extra=1;}, g=>{g.format="seigen-dn";}]){
      const g = JSON.parse(text); mut(g); assert.strictEqual((await B.api.validateGRV(g)).ok,false);
    }
    assert.strictEqual(B.api.grvFileName(5,"Boka",new Date(2026,8,19,14,15)),"GRV0005-Boka-19Sep26-0215PM.json");
  });
  await t("GRV voucher: number, DN reference, from, date/time, lines with thumbnail, totals, signature lines; HTML escaped", async ()=>{
    const { A, B } = rig();
    const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    const res = await check(B, d.text); const c = B.api.commitReceive(res.doc, LATER);
    const grv = await B.api.buildGRVFromCommit(res.doc, c);
    const html = B.api.grvVoucherHtml(grv, res.doc.items.map(i=>i.thumb));
    ["Goods Received Voucher","GRV0001","DN0001","Boka","CBD","SK1","Rice 2kg","6 pcs","SK2","Sugar 1kg","3 pcs","Received by","Checked by","9</b> unit"].forEach(s=>assert.ok(html.includes(s), s));
    assert.strictEqual((html.match(/dn-thumb/g)||[]).length,2);
    const evil = await B.api.buildGRV({ grvNo:2, dnNo:3, fromBranchId:"B-1", fromName:"<img src=x>", toBranchId:"B-2", toName:"CBD", receivedIso:"2026-09-05T14:15:00+02:00", items:[{code:"<b>",name:"<script>alert(1)</script>",qty:1}] });
    const h2 = B.api.grvVoucherHtml(evil, []);
    assert.ok(!/<script>|<img src=x>/.test(h2)); assert.ok(h2.includes("&lt;script&gt;"));
  });
  await t("GRV can be regenerated from the linked receipt lines when the stored file is missing", async ()=>{
    const { A, B } = rig(); const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    const res = await check(B, d.text); const c = B.api.commitReceive(res.doc, LATER);
    const h = B.api.incomingHeader(A.api.getBranchId(), d.dn.n);
    const rec = await B.api.grvGetRecord(h);
    assert.strictEqual(rec.rebuilt,true);
    assert.strictEqual(rec.doc.grv_display,"GRV0001"); assert.strictEqual(rec.doc.dn_display,"DN0001");
    assert.strictEqual(JSON.stringify(rec.doc.items.map(i=>[i.code,i.name,i.qty])),JSON.stringify(res.doc.items.map(i=>[i.code,i.name,i.qty])));
    assert.strictEqual(rec.doc.received_iso,c.receivedIso);
  });

  // ================= Merge safety =================
  await t("merge: received lines never create a pending receipt anywhere; every line reaches admin once", async ()=>{
    const { A, B } = rig();
    const d = await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    B.api.commitReceive((await check(B,d.text)).doc, LATER);
    const stockA = { sk1:stockOf(A,"SK1"), sk2:stockOf(A,"SK2") };
    await A.api.mergeDatabase({ __db:B.db });                           // admin merges the remote's export
    const merged = A.api.all("SELECT * FROM stock_received WHERE branch='CBD' AND grv_no=1");
    assert.strictEqual(merged.length,2,"both lines of the GRV merged (they share one timestamp)");
    assert.ok(merged.every(r=>r.dn_branch_id===A.api.getBranchId() && r.dn_no===d.dn.n));
    assert.strictEqual(A.api.pendingTransfersCount(),0);
    assert.strictEqual(A.api.all("SELECT * FROM stock_transfers WHERE status='Dispatched' AND to_branch='Boka' AND dn_no IS NULL").length,0);
    await A.api.mergeDatabase({ __db:B.db });
    assert.strictEqual(A.api.all("SELECT * FROM stock_received WHERE branch='CBD' AND grv_no=1").length,2,"re-merge adds nothing");
    assert.strictEqual(stockOf(A,"SK1"),stockA.sk1,"admin's own stock untouched");
    assert.strictEqual(stockOf(A,"SK2"),stockA.sk2);
    // and the receiver merging the dispatcher's file never makes the DN pending or moves its stock
    const before = { sk1:stockOf(B,"SK1"), sk2:stockOf(B,"SK2") };
    await B.api.mergeDatabase({ __db:A.db });
    assert.strictEqual(B.api.pendingTransfersCount(),0);
    assert.strictEqual(stockOf(B,"SK1"),before.sk1); assert.strictEqual(stockOf(B,"SK2"),before.sk2);
  });
  await t("merge: Phase 2 dispatch lines (negative stock_received rows) now all reach the other side", async ()=>{
    const { A } = rig(); const C = makeApp({ branch_name:"Admin", branch_type:"main", setup_complete:"1" });
    await dispatch(A,"CBD",[["SK1",6],["SK2",3]]);
    await C.api.mergeDatabase({ __db:A.db });
    const rows = C.api.all("SELECT * FROM stock_received WHERE branch='Boka' AND dn_no=1");
    assert.strictEqual(rows.length,2); assert.ok(rows.every(r=>r.qty<0 && r.dn_branch_id===A.api.getBranchId()));
    await C.api.mergeDatabase({ __db:A.db });
    assert.strictEqual(C.api.all("SELECT * FROM stock_received WHERE branch='Boka' AND dn_no=1").length,2);
  });
  await t("merge: old (unlinked) stock_received rows keep the old de-dupe rule", async ()=>{
    const { A } = rig(); const C = makeApp({ branch_name:"Admin", branch_type:"main", setup_complete:"1" });
    const p = A.api.one("SELECT id FROM products WHERE sku='SK1'").id;
    A.api.run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES('2026-01-01T00:00:00Z',?,?,5,'Restock','Boka','u')",[p,"Rice 2kg"]);
    await C.api.mergeDatabase({ __db:A.db }); await C.api.mergeDatabase({ __db:A.db });
    const rows = C.api.all("SELECT * FROM stock_received WHERE note='Restock'");
    assert.strictEqual(rows.length,1); assert.strictEqual(rows[0].dn_no,null);
  });
  await t("old receive path is untouched: legacy pending rows still work and never see DN lines", async ()=>{
    const { A, B } = rig();
    await dispatch(A,"CBD",[["SK1",6]]);
    await B.api.mergeDatabase({ __db:A.db });
    A.api.run("INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status) VALUES('2026-08-01T10:00:00.000Z','Boka','CBD','Rice 2kg','SK1',2,'old','u','Dispatched')");
    await B.api.mergeDatabase({ __db:A.db });
    assert.strictEqual(B.api.pendingTransfersCount(),1,"only the legacy row is pending");
    const legacy = B.api.one("SELECT * FROM stock_transfers WHERE dn_no IS NULL AND to_branch='CBD'");
    B.api.receiveTransfer(legacy.id);
    assert.strictEqual(stockOf(B,"SK1"),6);
    assert.strictEqual(B.api.pendingTransfersCount(),0);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
