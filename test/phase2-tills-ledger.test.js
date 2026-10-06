// Run: node --no-warnings test/phase2-tills-ledger.test.js
// Multi-terminal Phase 2 over the REAL app source and SQLite
// (docs/multi-terminal/phase2-design.md §6):
//   * per-till numbering: receipts T2-0045, DN-T1-0012, GRV/ADJ/CXL; unregistered devices unchanged
//   * files: DN v3 / GRV v2 / cancel v2 written only when needed; an OLD app's validators
//     (the live build, commit 96cacab) refuse them with the "update the app" message
//   * internal refs on DN and GRV: cleaned, capped, in the files, vouchers and search
//   * the stock ledger: every stock change writes a movement; integrity check; opening balance; merge
//   * deactivated till: the app's refusal handling
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const cp = require("child_process");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
const DAY = 86400000;
const TODAY = new Date().toISOString().slice(0,10);
const bytesOf = (text)=>new Uint8Array(Buffer.from(text,"utf8"));
const plain = (x)=>JSON.parse(JSON.stringify(x));

function addProduct(app, branch, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [o.name,o.price==null?5:o.price,o.stock==null?0:o.stock,3,o.sku,branch,"",o.cost==null?3:o.cost,"2026-01-01",""]);
  return app.api.one("SELECT * FROM products WHERE branch=? AND name=?",[branch,o.name]);
}
const stockOf = (app, sku)=>app.api.one("SELECT stock FROM products WHERE lower(sku)=lower(?) AND branch=?",[sku,app.api.currentBranch()]).stock;
const register = (app, till)=>app.api.setSetting("till_code", till);
const ledgerOk = (app)=>{ const r = app.api.stockLedgerCheck(); assert.deepStrictEqual(plain(r.mismatches), [], "ledger mismatches: "+JSON.stringify(r.mismatches)); return r; };

// Dispatcher "Boka" (main, Admin 9999, cancel on) and receiver "CBD" (remote).
// migrate() runs again after the raw product inserts, as a boot would: it writes the opening balances.
function rig(o){
  o = o||{};
  const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", cancel_enabled:"1" });
  const B = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
  B.hook("mainFileProblem", ()=>"");
  A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999','Boka',1,'x')");
  addProduct(A,"Boka",{name:"Rice 2kg",sku:"SK1",stock:30}); addProduct(A,"Boka",{name:"Sugar 1kg",sku:"SK2",stock:20});
  addProduct(B,"CBD",{name:"Rice 2kg",sku:"SK1",stock:4}); addProduct(B,"CBD",{name:"Sugar 1kg",sku:"SK2",stock:0});
  A.api.getBranchId(); B.api.getBranchId(); A.api.ensureSelfInRegister();
  A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('CBD','')");
  A.hook("getThumbs", async (ps)=>ps.map(()=>null));
  A.api.migrate(A.db); B.api.migrate(B.db);
  if(o.aTill) register(A, o.aTill);
  if(o.bTill) register(B, o.bTill);
  return { A, B };
}
async function dispatch(A, to, lines, o){
  o = o||{};
  const products = lines.map(l=>A.api.one("SELECT * FROM products WHERE sku=? AND branch=?",[l[0],A.api.currentBranch()]));
  const dn = A.api.dnCommitDispatch({ branch:A.api.currentBranch(), toBranch:to, now:o.now||new Date(Date.now()-DAY), internalRef:o.ref,
    lines:lines.map((l,i)=>({product:products[i],qty:l[1]})) });
  const built = await A.api.dnBuildFromDb(A.api.dnHeaderFor(dn.n));
  return { dn, n:dn.n, text:built.text, doc:built.doc };
}
const recvCheck = (B, text)=>B.api.receiveCheckBytes(bytesOf(text)).then(r=>r.res);
async function acceptAndGrv(B, text, ref){
  const res = await recvCheck(B, text); assert.strictEqual(res.ok,true,res.message);
  const c = B.api.commitReceive(res.doc, new Date(), ref);
  const grv = await B.api.buildGRVFromCommit(res.doc, c);
  return { grv, text:B.api.serializeGRV(grv), c, res };
}
function sell(app, product, qty){
  app.api.setCart([{ product_id:product.id, name:product.name, price:product.price, qty, stock:product.stock }]);
  app.hook("printReceipt", ()=>{});
  app.api.completeSale("Cash");
  return app.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
}
function openShift(app){ app.api.startShift("0", new Date(`${TODAY}T06:00:00Z`)); }

// An OLD app: the live build's validators (commit 96cacab, before Phase 2), loaded on their own.
let OLD = null;
function oldApp(){
  if(OLD) return OLD;
  const old = (f)=>cp.execSync("git show 96cacab:src/"+f, { encoding:"utf8", cwd:path.join(__dirname,"..") });
  const ctx = { console, TextEncoder, TextDecoder, crypto:globalThis.crypto };
  vm.createContext(ctx);
  vm.runInContext(["docnum.js","dnfile.js","grvfile.js","dncancel.js"].map(old).join("\n")+"\n;this.api={ parseDN, parseGRV, parseCancel, parseAck };", ctx);
  return (OLD = ctx.api);
}
const NEWER_TEXT = "This file was made by a newer version. Tap Reload on the update banner (or close and reopen the app while online), then import it again.";

(async()=>{
  // ================= numbering =================
  await t("unregistered device: receipts #id, DN0001/GRV0001/ADJ0001, today's file names, v1 file bytes", async ()=>{
    const { A, B } = rig();
    openShift(A);
    const sale = sell(A, A.api.one("SELECT * FROM products WHERE sku='SK1'"), 1);
    assert.strictEqual(sale.receipt_no, null);
    assert.strictEqual(A.api.receiptDisplay(sale), "#"+sale.id);
    assert.strictEqual(A.api.getLastReceipt().receiptNo, null);
    assert.ok(A.api.all("SELECT details FROM audit_log WHERE action='Sale'")[0].details.startsWith("Receipt #"+sale.id+" "));
    assert.strictEqual(A.api.one("SELECT COUNT(*) c FROM doc_counters WHERE doc_type='RCT'").c, 0, "no receipt counter without a till");
    const d = await dispatch(A,"CBD",[["SK1",2]], { now:new Date(2026,9,4,14,30) });
    assert.strictEqual(d.dn.text, "DN0001"); assert.strictEqual(d.dn.till, "");
    assert.strictEqual(A.api.dnHeaderFor(d.n).file_name, "DN0001-Boka-04Oct26-0230PM.json");
    assert.strictEqual(A.api.dnHeaderFor(d.n).till_code, null);
    assert.strictEqual(d.doc.format_version, 1);
    assert.deepStrictEqual(Object.keys(JSON.parse(d.text)), ["format","format_version","dn_no","dn_display","from","to","created_iso","items","totals","checksum"]);
    const g = await acceptAndGrv(B, d.text);
    assert.strictEqual(g.grv.format_version, 1); assert.strictEqual(g.grv.grv_display, "GRV0001");
    assert.ok(!("internal_ref" in JSON.parse(g.text)) && !("till_code" in JSON.parse(g.text)));
    const adj = A.api.writeAdjustment({ product:A.api.one("SELECT * FROM products WHERE sku='SK2'"), delta:-1, reason:"Damaged", note:"x", admin:"Owner", ts:new Date().toISOString() });
    assert.strictEqual(adj.text, "ADJ0001");
  });

  await t("registered till: receipt T1-0001, DN-T1-0001, GRV-T2-0001, ADJ-T1-0001; till stored on each row", async ()=>{
    const { A, B } = rig({ aTill:"T1", bTill:"T2" });
    openShift(A);
    const s1 = sell(A, A.api.one("SELECT * FROM products WHERE sku='SK1'"), 1);
    const s2 = sell(A, A.api.one("SELECT * FROM products WHERE sku='SK1'"), 1);
    assert.strictEqual(s1.receipt_no, "T1-0001"); assert.strictEqual(s2.receipt_no, "T1-0002");
    assert.strictEqual(A.api.receiptDisplay(s2), "T1-0002");
    assert.ok(A.api.all("SELECT details FROM audit_log WHERE action='Sale' ORDER BY id DESC")[0].details.startsWith("Receipt T1-0002 "));
    const d = await dispatch(A,"CBD",[["SK1",3]], { now:new Date(2026,9,4,14,30) });
    assert.strictEqual(d.dn.text, "DN-T1-0001");
    const h = A.api.dnHeaderFor(d.n);
    assert.strictEqual(h.till_code, "T1");
    assert.strictEqual(h.file_name, "DN-T1-0001-Boka-04Oct26-0230PM.json");
    assert.strictEqual(A.api.one("SELECT dn_till_code FROM dn_events WHERE event_type='dispatched'").dn_till_code, "T1");
    assert.ok(/\(DN-T1-0001\)/.test(A.api.one("SELECT note FROM stock_received WHERE dn_no=?",[d.n]).note));
    const g = await acceptAndGrv(B, d.text);
    assert.strictEqual(g.c.grv.text, "GRV-T2-0001");
    const bin = B.api.incomingHeader(A.api.getBranchId(), d.n);
    assert.strictEqual(bin.till_code, "T1"); assert.strictEqual(bin.grv_till_code, "T2");
    assert.ok(/^GRV-T2-0001-Boka-/.test(bin.file_name));
    const adj = A.api.writeAdjustment({ product:A.api.one("SELECT * FROM products WHERE sku='SK2'"), delta:-1, reason:"Damaged", note:"x", admin:"Owner", ts:new Date().toISOString() });
    assert.strictEqual(adj.text, "ADJ-T1-0001");
    assert.strictEqual(A.api.one("SELECT till_code FROM stock_adjustments").till_code, "T1");
  });

  await t("counters keep running when a device registers; old documents keep their old numbers everywhere", async ()=>{
    const { A } = rig();
    openShift(A);
    const old = sell(A, A.api.one("SELECT * FROM products WHERE sku='SK1'"), 1);
    const d1 = await dispatch(A,"CBD",[["SK1",1]]);
    register(A, "T1");
    const d2 = await dispatch(A,"CBD",[["SK1",1]]);
    assert.strictEqual(d1.dn.text, "DN0001"); assert.strictEqual(d2.dn.text, "DN-T1-0002", "no restart at 1 (D2)");
    assert.strictEqual(A.api.ownDnDisplay(d1.n), "DN0001", "an old DN still shows its old number");
    assert.strictEqual(A.api.ownDnDisplay(d2.n), "DN-T1-0002");
    const rebuilt = await A.api.dnBuildFromDb(A.api.dnHeaderFor(d1.n));
    assert.strictEqual(rebuilt.doc.dn_display, "DN0001"); assert.strictEqual(rebuilt.doc.format_version, 1, "a reshare of an old DN is byte-identical v1");
    assert.strictEqual(rebuilt.text, d1.text);
    assert.strictEqual(A.api.receiptDisplay(A.api.one("SELECT * FROM sales WHERE id=?",[old.id])), "#"+old.id, "old receipts keep #id");
    const newer = sell(A, A.api.one("SELECT * FROM products WHERE sku='SK1'"), 1);
    assert.strictEqual(newer.receipt_no, "T1-0001", "receipts get their own per-till counter");
    const h1 = A.api.dnHeaderFor(d1.n);
    assert.ok(A.api.matchesAnyOrder("dn0001", A.api.dnSearchText(h1)));
    assert.ok(!A.api.matchesAnyOrder("dn-t1", A.api.dnSearchText(h1)));
    assert.ok(A.api.matchesAnyOrder("DN-T1-0002", A.api.dnSearchText(A.api.dnHeaderFor(d2.n))));
  });

  await t("a till code that isn't T<digits> is ignored: the device behaves as unregistered", async ()=>{
    const { A } = rig({ aTill:"X9" });
    assert.strictEqual(A.api.currentTillCode(), "");
    openShift(A);
    assert.strictEqual(sell(A, A.api.one("SELECT * FROM products WHERE sku='SK1'"), 1).receipt_no, null);
    assert.strictEqual((await dispatch(A,"CBD",[["SK1",1]])).dn.text, "DN0001");
  });

  await t("two tills in one branch work offline, then merge into a third device: no number or key collisions", async ()=>{
    const T1 = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", till_code:"T1" });
    const T2 = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", till_code:"T2" });
    const C  = makeApp({ branch_name:"Boka HQ", branch_type:"main", setup_complete:"1" });
    [T1,T2].forEach(x=>{ addProduct(x,"Boka",{name:"Rice 2kg",sku:"SK1",stock:50}); x.api.migrate(x.db); x.hook("getThumbs", async (ps)=>ps.map(()=>null));
      x.api.ensureSelfInRegister(); x.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('CBD','')"); openShift(x); });
    assert.notStrictEqual(T1.api.getBranchId(), T2.api.getBranchId(), "each device has its own DN key space");
    for(const x of [T1,T2]){ for(let i=0;i<3;i++) sell(x, x.api.one("SELECT * FROM products WHERE sku='SK1'"), 1); await dispatch(x,"CBD",[["SK1",2]]); await dispatch(x,"CBD",[["SK1",1]]); }
    await C.api.mergeDatabase({ __db:T1.db }); await C.api.mergeDatabase({ __db:T2.db });
    const receipts = C.api.all("SELECT receipt_no FROM sales ORDER BY receipt_no").map(r=>r.receipt_no);
    assert.deepStrictEqual(plain(receipts), ["T1-0001","T1-0002","T1-0003","T2-0001","T2-0002","T2-0003"]);
    // a merge carries DNs as their events (dispatch_docs stay on the dispatching device)
    const dns = C.api.all("SELECT dn_branch_id, dn_no, dn_till_code FROM dn_events WHERE event_type='dispatched'");
    assert.strictEqual(dns.length, 4, "4 DNs, none dropped as a duplicate");
    assert.strictEqual(new Set(dns.map(r=>r.dn_branch_id+"|"+r.dn_no)).size, 4);
    assert.deepStrictEqual(plain(dns.map(r=>C.api.docDisplay("DN",r.dn_no,r.dn_till_code)).sort()), ["DN-T1-0001","DN-T1-0002","DN-T2-0001","DN-T2-0002"]);
    assert.deepStrictEqual(plain([...C.api.dnStatusMap().values()].map(r=>r.dnDisplay).sort()), ["DN-T1-0001","DN-T1-0002","DN-T2-0001","DN-T2-0002"], "movement reports show the till numbers");
    const mv = C.api.all("SELECT uid FROM stock_movements");
    assert.strictEqual(new Set(mv.map(r=>r.uid)).size, mv.length);
    await C.api.mergeDatabase({ __db:T1.db });
    assert.strictEqual(C.api.all("SELECT * FROM sales").length, 6, "merging again adds nothing");
    assert.strictEqual(C.api.all("SELECT * FROM stock_movements").length, mv.length);
  });

  // ================= files =================
  await t("DN v3: till + internal ref, round-trips; the receiver stores both and shows them", async ()=>{
    const { A, B } = rig({ aTill:"T1" });
    const d = await dispatch(A,"CBD",[["SK1",3]], { ref:"  PO 4471\t/ Week 40 " });
    assert.strictEqual(A.api.dnHeaderFor(d.n).internal_ref, "PO 4471 / Week 40");
    const f = JSON.parse(d.text);
    assert.strictEqual(f.format_version, 3);
    assert.deepStrictEqual(Object.keys(f), ["format","format_version","dn_no","dn_display","till_code","from","to","created_iso","internal_ref","items","totals","checksum"]);
    assert.strictEqual(f.dn_display, "DN-T1-0001"); assert.strictEqual(f.till_code, "T1"); assert.strictEqual(f.internal_ref, "PO 4471 / Week 40");
    assert.strictEqual((await A.api.parseDN(d.text)).ok, true);
    assert.ok(A.api.dnVoucherHtml(d.doc).includes("PO 4471 / Week 40"), "printed on the DN voucher");
    const tampered = JSON.stringify(Object.assign(JSON.parse(d.text), { dn_display:"DN0001" }));
    assert.ok((await A.api.parseDN(tampered)).errors.some(e=>/does not match its display number/.test(e)));
    const g = await acceptAndGrv(B, d.text, "GRN/88");
    const bin = B.api.incomingHeader(A.api.getBranchId(), d.n);
    assert.strictEqual(bin.internal_ref, "PO 4471 / Week 40"); assert.strictEqual(bin.grv_internal_ref, "GRN/88");
    assert.ok(B.api.matchesAnyOrder("po 4471", B.api.dnSearchText(bin)), "Receipts history search finds their ref");
    assert.ok(B.api.matchesAnyOrder("grn/88", B.api.dnSearchText(bin)), "... and our own");
    // GRV v2 back to main
    const gf = JSON.parse(g.text);
    assert.strictEqual(gf.format_version, 2);
    assert.deepStrictEqual(Object.keys(gf), ["format","format_version","grv_no","grv_display","dn_no","dn_display","dn_till_code","from","to","received_iso","internal_ref","items","totals","checksum"]);
    assert.strictEqual(gf.dn_display, "DN-T1-0001"); assert.strictEqual(gf.grv_display, "GRV0001", "the receiver is unregistered");
    assert.ok(B.api.grvVoucherHtml(g.grv, []).includes("GRN/88"), "printed on the GRV voucher");
    const res = (await A.api.grvImportCheckBytes(bytesOf(g.text))).res; assert.strictEqual(res.ok, true, res.message);
    A.api.commitGrvImport(res.doc, new Date());
    const out = A.api.dnHeaderFor(d.n);
    assert.strictEqual(out.grv_internal_ref, "GRN/88");
    assert.ok(A.api.matchesAnyOrder("grn 88", A.api.dnSearchText(out)) || A.api.matchesAnyOrder("grn/88", A.api.dnSearchText(out)), "Dispatch history search finds their ref");
    assert.ok(A.api.matchesAnyOrder("cbd", A.api.dnSearchText(out)), "... and the branch");
  });

  await t("a v1 DN from an old app is still received; an unregistered DN with an internal ref is v3 with no till", async ()=>{
    const { A, B } = rig();
    const d = await dispatch(A,"CBD",[["SK1",1]]);
    assert.strictEqual(JSON.parse(d.text).format_version, 1);
    await acceptAndGrv(B, d.text);
    const e = await dispatch(A,"CBD",[["SK1",1]], { ref:"ORDER 9" });
    const f = JSON.parse(e.text);
    assert.strictEqual(f.format_version, 3); assert.strictEqual(f.dn_display, "DN0002"); assert.ok(!("till_code" in f));
    assert.strictEqual((await B.api.parseDN(e.text)).ok, true);
  });

  await t("an OLD app (the live build) refuses DN v3, GRV v2 and cancel v2 with its update message, and changes nothing", async ()=>{
    const OLDAPP = oldApp();
    const { A, B } = rig({ aTill:"T1", bTill:"T2" });
    const d = await dispatch(A,"CBD",[["SK1",1]]);
    const rd = await OLDAPP.parseDN(d.text);
    assert.strictEqual(rd.ok, false); assert.ok(/needs a newer version.*file version 3.*Update the app/.test(rd.errors[0]), rd.errors[0]);
    const g = await acceptAndGrv(B, d.text);
    const rg = await OLDAPP.parseGRV(g.text);
    assert.strictEqual(rg.ok, false); assert.ok(/needs a newer version.*file version 2/.test(rg.errors[0]), rg.errors[0]);
    const d2 = await dispatch(A,"CBD",[["SK1",1]]);
    const c = A.api.startCancelCase({ dnNo:d2.n, kind:"cancel", plan:[], note:"wrong branch", passcode:"9999" });
    assert.strictEqual(c.caseText, "CXL-T1-0001");
    const notice = await A.api.cancelNoticeFor(A.api.dnCaseByNo(c.caseNo));
    assert.strictEqual(notice.doc.format_version, 2); assert.strictEqual(notice.doc.cancel_display, "CXL-T1-0001"); assert.strictEqual(notice.doc.dn_display, "DN-T1-0002");
    assert.ok(/^CXL-T1-0001-CBD-/.test(notice.fileName));
    const rc = await OLDAPP.parseCancel(notice.text);
    assert.strictEqual(rc.ok, false); assert.ok(/needs a newer version/.test(rc.errors[0]), rc.errors[0]);
    assert.strictEqual((await B.api.parseCancel(notice.text)).ok, true, "this version reads it");
    // and the same old app still reads what an unregistered device writes
    const { A:A0 } = rig();
    assert.strictEqual((await OLDAPP.parseDN((await dispatch(A0,"CBD",[["SK1",1]])).text)).ok, true);
  });

  await t("this version's message for a file from a newer build is the approved wording, for every file family", async ()=>{
    const { A } = rig({ aTill:"T1" });
    const d = await dispatch(A,"CBD",[["SK1",1]]);
    const bump = (text, v)=>JSON.stringify(Object.assign(JSON.parse(text), { format_version:v }));
    assert.deepStrictEqual(plain((await A.api.parseDN(bump(d.text, 4))).errors), [NEWER_TEXT]);
    const g = await A.api.buildGRV({ grvNo:1, dnNo:1, fromBranchId:"B-X", fromName:"Boka", toBranchId:"B-Y", toName:"CBD", receivedIso:"2026-10-04T10:00:00+02:00", items:[{code:"SK1",name:"Rice",qty:1}] });
    assert.deepStrictEqual(plain((await A.api.parseGRV(bump(A.api.serializeGRV(g), 3))).errors), [NEWER_TEXT]);
    assert.strictEqual(A.api.newerAppMessage("catalogue", 9, 1), NEWER_TEXT);
  });

  await t("reissue from a till: the replacement is DN v3 with replaces; the receiver closes the old DN", async ()=>{
    const { A, B } = rig({ aTill:"T1" });
    const d = await dispatch(A,"CBD",[["SK1",10]], { ref:"PO 1" });
    const c = A.api.startCancelCase({ dnNo:d.n, kind:"reissue", plan:[{ nw:8, writeoff:0, reason:"" }], note:"short", passcode:"9999" });
    const rh = A.api.dnHeaderFor(c.newDnNo);
    assert.strictEqual(rh.till_code, "T1"); assert.strictEqual(rh.internal_ref, "PO 1", "the replacement keeps the internal ref");
    const rep = await A.api.dnBuildFromDb(rh);
    const f = JSON.parse(rep.text);
    assert.strictEqual(f.format_version, 3); assert.strictEqual(f.replaces, d.n); assert.strictEqual(f.dn_display, "DN-T1-0002");
    assert.strictEqual((await B.api.parseDN(rep.text)).ok, true);
    const g = await acceptAndGrv(B, rep.text);
    const old = B.api.incomingHeader(A.api.getBranchId(), d.n);
    assert.strictEqual(old.status, "cancelled"); assert.strictEqual(old.replaced_by, c.newDnNo);
    // the confirmation the receiver sends back carries the till codes
    const ack = await B.api.buildAckFromRow(old);
    assert.strictEqual(ack.format_version, 2); assert.strictEqual(ack.dn_display, "DN-T1-0001"); assert.strictEqual(ack.cancel_display, "CXL-T1-0001");
    assert.ok(/^CXL-T1-0001-Boka-/.test(B.api.cancelAckFileName(old.cancel_no, "Boka", new Date(), old.cancel_till_code)));
    ledgerOk(A); ledgerOk(B);
  });

  // ================= internal ref =================
  await t("internal ref: cleaned like Doc Ref, capped at 30, optional; old documents blank", async ()=>{
    const { A } = rig();
    assert.strictEqual(A.api.INTERNAL_REF_MAX, 30);
    assert.strictEqual(A.api.cleanInternalRef("  a\u0007b \n\n c  "), "a b c");
    assert.strictEqual(A.api.cleanInternalRef("x".repeat(40)).length, 30);
    assert.strictEqual(A.api.cleanInternalRef("a".repeat(29)+"  b"), "a".repeat(29), "no trailing space after the cap");
    assert.strictEqual(A.api.cleanInternalRef(null), ""); assert.strictEqual(A.api.cleanInternalRef("   "), "");
    const d = await dispatch(A,"CBD",[["SK1",1]], { ref:"   " });
    assert.strictEqual(A.api.dnHeaderFor(d.n).internal_ref, null);
    assert.strictEqual(JSON.parse(d.text).format_version, 1, "a blank ref doesn't change the file");
    assert.ok(!A.api.dnVoucherHtml(d.doc).includes("Internal ref."));
    const long = await dispatch(A,"CBD",[["SK1",1]], { ref:"R".repeat(45) });
    assert.strictEqual(A.api.dnHeaderFor(long.n).internal_ref, "R".repeat(30));
    const bad = JSON.stringify(Object.assign(JSON.parse(long.text), { internal_ref:"R".repeat(31) }));
    assert.ok((await A.api.parseDN(bad)).errors.some(e=>/internal reference/.test(e)));
  });

  // ================= stock ledger =================
  await t("no stock write outside the ledger helpers (static check of src/)", ()=>{
    const dir = path.join(__dirname,"..","src");
    const files = []; (function walk(d){ fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{ const p = path.join(d,e.name); if(e.isDirectory()) walk(p); else if(p.endsWith(".js")) files.push(p); }); })(dir);
    const hits = [];
    files.forEach(f=>{ if(path.basename(f)==="db.js") return;
      fs.readFileSync(f,"utf8").split("\n").forEach((line,i)=>{ if(/UPDATE\s+products\s+SET[^;]*\bstock\s*=/i.test(line)) hits.push(path.relative(dir,f)+":"+(i+1)); }); });
    assert.deepStrictEqual(hits, []);
    assert.ok(!/function dispatchStockModal/.test(fs.readFileSync(path.join(dir,"dispatch.js"),"utf8")), "the dead legacy dispatch screen is gone");
  });

  await t("opening balance: one movement per product with stock, uid open-<product uid>; repeating migrate adds nothing", ()=>{
    const { A } = rig();
    const rows = A.api.all("SELECT * FROM stock_movements ORDER BY product_id");
    assert.strictEqual(rows.length, 2);
    rows.forEach(r=>{ assert.strictEqual(r.kind, "opening"); assert.strictEqual(r.uid, "open-"+A.api.one("SELECT uid FROM products WHERE id=?",[r.product_id]).uid); });
    assert.deepStrictEqual(plain(rows.map(r=>r.qty_delta)), [30,20]);
    A.api.migrate(A.db); A.api.migrate(A.db);
    assert.strictEqual(A.api.all("SELECT * FROM stock_movements").length, 2);
    addProduct(A,"Boka",{name:"Empty",sku:"SK9",stock:0}); A.api.migrate(A.db);
    assert.strictEqual(A.api.all("SELECT * FROM stock_movements").length, 2, "no opening row for zero stock");
    ledgerOk(A);
  });

  await t("every live stock path writes a matching movement; the check passes after a mixed session", async ()=>{
    const { A, B } = rig({ aTill:"T1" });
    openShift(A);
    const sk1 = ()=>A.api.one("SELECT * FROM products WHERE sku='SK1'");
    const sale = sell(A, sk1(), 2);                                                          // sale
    const d = await dispatch(A,"CBD",[["SK1",5],["SK2",3]]);                                // dispatch
    const g = await acceptAndGrv(B, d.text);                                                // receive (B)
    A.api.commitGrvImport((await A.api.grvImportCheckBytes(bytesOf(g.text))).res.doc, new Date());   // GRV import: no stock change
    A.api.writeAdjustment({ product:sk1(), delta:-1, reason:"Damaged", note:"x", admin:"Owner", ts:new Date().toISOString() });     // adjustment
    A.api.moveStock({ productId:sk1().id, delta:4, kind:"restock", note:"Restock" });                                                 // restock (products.js)
    // stocktake with a sale after counting: the movement records the real change (counted − stock at apply)
    const counted = stockOf(A,"SK1") - 3; sell(A, sk1(), 1);
    const st = A.api.moveStock({ productId:sk1().id, setTo:counted, kind:"stocktake" });
    assert.strictEqual(st, -2); assert.strictEqual(stockOf(A,"SK1"), counted);
    // import with "apply qty" (overwrite) and a new product
    const fakeWrap = ()=>{ const el = {}; return { querySelector:()=>el }; };
    const batch = (rows)=>{ const p = A.api.parseImportRows(rows); const c = A.api.classifyImportRows(p.rows); return { toApply:c.toApply, duplicates:c.duplicates, skipped:c.skipped, totalRead:rows.length }; };
    A.api.runImport(fakeWrap(), batch([{ "SKU":"SK2", "Item Name":"Sugar 1kg", "Price":5, "Cost":3, "Qty":40 }, { "SKU":"SK7", "Item Name":"Oil 2L", "Price":9, "Cost":6, "Qty":12 }]), true);
    assert.strictEqual(stockOf(A,"SK2"), 40); assert.strictEqual(stockOf(A,"SK7"), 12);
    // legacy pending transfer: into an existing product, and creating one
    A.api.run("INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status) VALUES('t','Old','Boka','Rice 2kg','SK1',3,'','u','Dispatched')");
    A.api.run("INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status) VALUES('t','Old','Boka','Salt','SK8',6,'','u','Dispatched')");
    A.api.all("SELECT id FROM stock_transfers WHERE dn_no IS NULL").forEach(r=>A.api.receiveTransfer(r.id));
    assert.strictEqual(stockOf(A,"SK8"), 6);
    const kinds = new Set(A.api.all("SELECT DISTINCT kind FROM stock_movements").map(r=>r.kind));
    ["opening","sale","dispatch","adjustment","restock","stocktake","import","legacy_receive"].forEach(k=>assert.ok(kinds.has(k), k));
    assert.ok(B.api.one("SELECT * FROM stock_movements WHERE kind='receive'"));
    const sm = A.api.one("SELECT * FROM stock_movements WHERE kind='sale'");
    assert.strictEqual(sm.doc_no, sale.receipt_no); assert.strictEqual(sm.doc_uid, sale.uid); assert.strictEqual(sm.qty_delta, -2);
    const dm = A.api.all("SELECT * FROM stock_movements WHERE kind='dispatch'");
    assert.ok(dm.every(m=>m.doc_no==="DN-T1-0001" && m.doc_uid===A.api.dnHeaderFor(d.n).uid));
    assert.strictEqual(B.api.one("SELECT doc_no FROM stock_movements WHERE kind='receive'").doc_no, "GRV0001");
    assert.ok(A.api.all("SELECT terminal_id FROM stock_movements WHERE kind<>'opening'").length > 0);
    const r = ledgerOk(A); assert.strictEqual(r.checked, 4);
    ledgerOk(B);
  });

  await t("cancel posting and reissue go through the ledger (restore, write-off, replacement dispatch)", async ()=>{
    const { A, B } = rig();
    const d = await dispatch(A,"CBD",[["SK1",10],["SK2",4]]);
    const c = A.api.startCancelCase({ dnNo:d.n, kind:"reissue", plan:[{ nw:8, writeoff:1, reason:"Damaged" },{ nw:4, writeoff:0, reason:"" }], note:"x", passcode:"9999", override:true, typed:"CANCEL "+A.api.ownDnDisplay(d.n) });
    assert.ok(c.overridden);
    assert.strictEqual(A.api.all("SELECT * FROM stock_movements WHERE kind='dispatch' AND doc_no=?",[A.api.ownDnDisplay(c.newDnNo)]).length, 2, "replacement leaves stock through the ledger");
    assert.ok(A.api.all("SELECT * FROM stock_movements WHERE kind='adjustment'").length >= 2);
    ledgerOk(A);
  });

  await t("a dispatch that fails midway leaves no stock change, no movement and no number used", ()=>{
    const { A } = rig();
    const before = JSON.stringify([A.api.all("SELECT * FROM products"), A.api.all("SELECT * FROM stock_movements"), A.api.all("SELECT * FROM doc_counters")]);
    A.hook("recordDnEvent", ()=>{ throw new Error("disk full"); });
    assert.throws(()=>A.api.dnCommitDispatch({ branch:"Boka", toBranch:"CBD", now:new Date(), lines:[{ product:A.api.one("SELECT * FROM products WHERE sku='SK1'"), qty:5 }] }), /disk full/);
    assert.strictEqual(JSON.stringify([A.api.all("SELECT * FROM products"), A.api.all("SELECT * FROM stock_movements"), A.api.all("SELECT * FROM doc_counters")]), before);
  });

  await t("moveStock on its own: a non-whole change or unknown product writes nothing; zero is a no-op", ()=>{
    const { A } = rig();
    const n = ()=>A.api.all("SELECT * FROM stock_movements").length, before = n();
    const id = A.api.one("SELECT id FROM products WHERE sku='SK1'").id;
    assert.throws(()=>A.api.moveStock({ productId:id, delta:1.5, kind:"restock" }), /whole number/);
    assert.throws(()=>A.api.moveStock({ productId:99999, delta:1, kind:"restock" }), /not found/);
    assert.strictEqual(A.api.moveStock({ productId:id, delta:0, kind:"restock" }), 0);
    assert.strictEqual(n(), before); assert.strictEqual(stockOf(A,"SK1"), 30);
  });

  await t("the check reports a mismatch read-only, and covers this branch's products only", async ()=>{
    const { A, B } = rig();
    A.api.run("UPDATE products SET stock=stock+7 WHERE sku='SK1'");    // a write that bypassed the ledger
    const r = A.api.stockLedgerCheck();
    assert.strictEqual(r.checked, 2);
    assert.deepStrictEqual(plain(r.mismatches.map(m=>[m.sku, m.stock, m.ledger, m.diff])), [["SK1",37,30,7]]);
    assert.strictEqual(stockOf(A,"SK1"), 37, "nothing is fixed up");
    await A.api.mergeDatabase({ __db:B.db });    // CBD's products arrive as snapshots
    assert.strictEqual(A.api.stockLedgerCheck().checked, 2, "merged CBD products are outside the check (D8)");
    assert.ok(A.api.all("SELECT * FROM stock_movements WHERE branch='CBD'").length >= 1, "but their movements are carried");
  });

  // ================= deactivated till (app side) =================
  await t("a TERMINAL_INACTIVE refusal marks the device and explains it; other refusals don't", ()=>{
    const { A } = rig();
    assert.strictEqual(A.api.isTerminalInactive(), false);
    A.api.noteTerminalRefusal({ ok:false, code:"JOIN_CODE_USED" });
    assert.strictEqual(A.api.isTerminalInactive(), false);
    A.api.noteTerminalRefusal({ ok:false, code:"TERMINAL_INACTIVE" });
    assert.strictEqual(A.api.isTerminalInactive(), true);
    assert.strictEqual(A.api.terminalProblemText({ ok:false, code:"TERMINAL_INACTIVE" }), "This till was deactivated by your main branch. Selling still works. Ask main to reactivate it.");
    assert.ok(/can't deactivate itself/.test(A.api.terminalProblemText({ ok:false, message:"A till cannot deactivate itself" })));
    assert.ok(/main branch can deactivate/.test(A.api.terminalProblemText({ ok:false, message:"Only a main-branch terminal can change terminals" })));
    // selling is unaffected
    openShift(A);
    assert.ok(sell(A, A.api.one("SELECT * FROM products WHERE sku='SK1'"), 1).id);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})();
