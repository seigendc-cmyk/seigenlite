// Run: node --no-warnings test/dispatch.test.js
// Real app source over node:sqlite (see harness.js).
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,4).join("\n       ")); }
}
function addProduct(app, branch, name, sku, stock){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [name,5,stock,1,sku,branch,"",3,new Date().toISOString(),""]);
  return app.api.one("SELECT * FROM products WHERE branch=? AND name=?",[branch,name]);
}
const stockOf = (app,id)=>app.api.one("SELECT stock FROM products WHERE id=?",[id]).stock;
const NOW = new Date(2026,8,4,8,0);

(async()=>{
  // ---- sender (main, "Boka") and receiver (remote, "CBD") ----
  const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", contact_phone:"0771111111" });
  const B = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
  // Phase 4: a remote now refuses main-type files. These older tests exercise the merge LOGIC itself,
  // so the refusal is bypassed here; the refusal has its own tests (phase4.test.js).
  B.hook("mainFileProblem", ()=>"");
  const ax = addProduct(A,"Boka","Rice 2kg","SK1",10), ay = addProduct(A,"Boka","Sugar 1kg","SK2",5);
  const bx = addProduct(B,"CBD","Rice 2kg","SK1",4);
  A.api.ensureSelfInRegister(); A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('CBD','')");   // destinations are register-only

  await t("commit: deducts stock, writes header + lines with dn_no, uses DN0001", ()=>{
    const dn = A.api.dnCommitDispatch({ branch:"Boka", toBranch:"CBD", now:NOW, lines:[{product:ax,qty:3},{product:ay,qty:2}] });
    assert.strictEqual(dn.text,"DN0001");
    assert.strictEqual(stockOf(A,ax.id),7); assert.strictEqual(stockOf(A,ay.id),3);
    const rows = A.api.all("SELECT * FROM stock_transfers WHERE dn_no=1");
    assert.strictEqual(rows.length,2);
    assert.ok(rows.every(r=>r.to_branch==="CBD" && r.from_branch==="Boka" && r.status==="Dispatched"));
    const h = A.api.one("SELECT * FROM dispatch_docs WHERE dn_no=1");
    assert.strictEqual(h.direction,"out"); assert.strictEqual(h.status,"dispatched");
    assert.strictEqual(h.line_count,2); assert.strictEqual(h.unit_total,5);
    assert.strictEqual(h.file_name,"DN0001-Boka-04Sep26-0800AM.json");
    assert.ok(/^2026-09-04T08:00:00[+-]\d\d:\d\d$/.test(h.created_iso), h.created_iso);
  });
  await t("commit: failure rolls everything back, including the number", ()=>{
    const before = { x:stockOf(A,ax.id), y:stockOf(A,ay.id), t:A.api.all("SELECT * FROM stock_transfers").length };
    assert.throws(()=>A.api.dnCommitDispatch({ branch:"Boka", toBranch:"CBD", now:NOW, lines:[{product:ax,qty:1},{product:ay,qty:99}] }), /only 3 in stock/);
    assert.strictEqual(stockOf(A,ax.id),before.x); assert.strictEqual(stockOf(A,ay.id),before.y);
    assert.strictEqual(A.api.all("SELECT * FROM stock_transfers").length,before.t);
    assert.strictEqual(A.api.all("SELECT * FROM dispatch_docs").length,1);
    assert.strictEqual(A.api.reserveDocNumber("DN").text,"DN0002"); // number was not consumed by the failed attempt
    A.api.run("UPDATE doc_counters SET last_no=1 WHERE doc_type='DN'"); // undo this probe
  });
  await t("commit: rejects bad quantities and empty dispatch", ()=>{
    for(const q of [0,-1,1.5,NaN]) assert.throws(()=>A.api.dnCommitDispatch({ branch:"Boka", toBranch:"CBD", now:NOW, lines:[{product:ax,qty:q}] }));
    assert.throws(()=>A.api.dnCommitDispatch({ branch:"Boka", toBranch:"CBD", now:NOW, lines:[] }));
    assert.strictEqual(stockOf(A,ax.id),7);
  });
  await t("commit: second dispatch is DN0002 and numbers never repeat", ()=>{
    const dn = A.api.dnCommitDispatch({ branch:"Boka", toBranch:"CBD", now:NOW, lines:[{product:ax,qty:1}] });
    assert.strictEqual(dn.text,"DN0002");
  });

  await t("dispatch: destination must be in the register (no typed names) and not this branch", ()=>{
    const before = A.api.all("SELECT * FROM doc_counters").length, stock = stockOf(A,ax.id);
    for(const bad of ["Nowhere","cbd ","","Boka"]) assert.throws(()=>A.api.dnCommitDispatch({ branch:"Boka", toBranch:bad, now:NOW, lines:[{product:ax,qty:1}] }), /register|destination/i, JSON.stringify(bad));
    assert.strictEqual(stockOf(A,ax.id),stock);
    assert.strictEqual(A.api.all("SELECT * FROM dispatch_docs").length,2);
    assert.strictEqual(A.api.dnDestinationAllowed("CBD"),true); assert.strictEqual(A.api.dnDestinationAllowed("Boka"),false);
  });
  await t("dispatch: blocks a product with an empty or duplicate code (\"Add a code to X in Products first\")", ()=>{
    const nocode = addProduct(A,"Boka","Loose item","",5);
    const t1 = addProduct(A,"Boka","Twin A","TW1",5), t2 = addProduct(A,"Boka","Twin B"," tw1",5);
    const stock = stockOf(A,ax.id), headers = A.api.all("SELECT * FROM dispatch_docs").length;
    assert.strictEqual(A.api.dnProductCodeProblem(nocode),"Add a code to Loose item in Products first.");
    assert.ok(/Twin A shares its code \(TW1\) with Twin B/.test(A.api.dnProductCodeProblem(t1)));
    assert.ok(/Twin B shares its code/.test(A.api.dnProductCodeProblem(t2)));
    assert.strictEqual(A.api.dnProductCodeProblem(ax),"");
    for(const bad of [nocode,t1,t2]){
      assert.throws(()=>A.api.dnCommitDispatch({ branch:"Boka", toBranch:"CBD", now:NOW, lines:[{product:ax,qty:1},{product:bad,qty:1}] }), /code/);
    }
    assert.strictEqual(stockOf(A,ax.id),stock,"the good line was rolled back too");
    assert.strictEqual(A.api.all("SELECT * FROM dispatch_docs").length,headers);
    A.api.run("DELETE FROM products WHERE id IN (?,?,?)",[nocode.id,t1.id,t2.id]);
  });

  // ---- old receive path must not see DN lines ----
  // A legacy (pre-DN) transfer to CBD, to prove the old path still works.
  A.api.run("INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status) VALUES(?,?,?,?,?,?,?,?,'Dispatched')",
    ["2026-08-01T10:00:00.000Z","Boka","CBD","Rice 2kg","SK1",2,"old","u"]);

  await t("merge: DN lines arrive as records, never as pending receipts, stock not counted twice", async ()=>{
    const stockBefore = stockOf(B,bx.id);
    await B.api.mergeDatabase({ __db:A.db });
    const dnRows = B.api.all("SELECT * FROM stock_transfers WHERE dn_no IS NOT NULL");
    assert.strictEqual(dnRows.length,3, "all 3 DN lines (2 + 1) merged, even though DN0001's lines share a timestamp");
    assert.ok(dnRows.every(r=>r.to_branch==="CBD" && r.status==="Dispatched"));
    assert.strictEqual(B.api.pendingTransfersCount(),1, "only the legacy transfer is pending");
    dnRows.forEach(r=>B.api.receiveTransfer(r.id));           // even called directly, it must do nothing
    assert.strictEqual(stockOf(B,bx.id),stockBefore);
    assert.strictEqual(B.api.all("SELECT * FROM stock_received WHERE branch='CBD'").length,0);
    assert.ok(B.api.all("SELECT * FROM stock_transfers WHERE dn_no IS NOT NULL").every(r=>r.status==="Dispatched"));
  });
  await t("merge: the legacy receive path still works unchanged", ()=>{
    const legacy = B.api.one("SELECT * FROM stock_transfers WHERE dn_no IS NULL AND to_branch='CBD'");
    B.api.receiveTransfer(legacy.id);
    assert.strictEqual(stockOf(B,bx.id),6);
    assert.strictEqual(B.api.pendingTransfersCount(),0);
  });
  await t("merge: importing the same file again adds nothing", async ()=>{
    const n = B.api.all("SELECT * FROM stock_transfers").length;
    await B.api.mergeDatabase({ __db:A.db });
    assert.strictEqual(B.api.all("SELECT * FROM stock_transfers").length,n);
    assert.strictEqual(stockOf(B,bx.id),6);
  });
  await t("register: main's destinations reach the remote; own branch is excluded", ()=>{
    A.api.ensureSelfInRegister();
    A.api.run("UPDATE branch_register SET whatsapp='0772222222' WHERE name='CBD'");
    return B.api.mergeDatabase({ __db:A.db }).then(()=>{
      const names = B.api.branchDestinations().map(b=>b.name);
      assert.strictEqual(JSON.stringify(names),'["Boka"]');                    // CBD is the current branch -> excluded
      assert.strictEqual(JSON.stringify(A.api.branchDestinations().map(b=>b.name)),'["CBD"]');
      assert.strictEqual(A.api.branchDestinations()[0].whatsapp,"0772222222");
    });
  });
  await t("existing sync unchanged: products/sales still merge from an old-format file", async ()=>{
    const C = makeApp({ branch_name:"Old", setup_complete:"1" });
    addProduct(C,"Old","Salt","S9",3);
    C.api.run("INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status) VALUES(?,?,?,?,?,?,?,?,'Dispatched')",
      ["2026-08-02T10:00:00.000Z","Old","Boka","Salt","S9",1,"","u"]);
    await A.api.mergeDatabase({ __db:C.db });
    assert.ok(A.api.one("SELECT id FROM products WHERE branch='Old' AND name='Salt'"));
    const row = A.api.one("SELECT * FROM stock_transfers WHERE from_branch='Old'");
    assert.strictEqual(row.dn_no,null);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
