// Run: node --no-warnings test/phase4b.test.js
// Phase 4b over the REAL app source and SQLite: stock adjustments with a reason, their merge and
// report, and the branch-name lock.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { makeApp, Compat } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,4).join("\n       ")); }
}
const J = JSON.stringify;
function addProduct(app, branch, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [o.name,o.price==null?5:o.price,o.stock==null?0:o.stock,3,o.sku,branch,"",o.cost==null?0:o.cost,"2026-01-01",""]);
  return app.api.one("SELECT * FROM products WHERE branch=? AND name=?",[branch,o.name]);
}
function snapshot(app){
  const names = app.api.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
  return J(names.map(n=>[n, app.api.all("SELECT * FROM "+n)]));
}
const stockOf = (app, sku)=>app.api.one("SELECT stock FROM products WHERE lower(sku)=lower(?) AND branch=?",[sku,app.api.currentBranch()]).stock;
const addAdmin = (app, name, pass, o)=>app.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES(?,?,?,?,?,?)",[name||"Chipo","Admin",pass||"1234",app.api.currentBranch(),(o&&o.active)===0?0:1,"2026-01-01"]);
const adj = (app, p, reason, qty, note, pass, when)=>app.api.commitAdjustment({ productId:p.id, reason, qty, note, passcode:pass==null?"1234":pass, now:when });
const counts = (app)=>({ adj:app.api.all("SELECT * FROM stock_adjustments").length, led:app.api.all("SELECT * FROM stock_received WHERE adj_no IS NOT NULL").length,
  counter:J(app.api.all("SELECT * FROM doc_counters WHERE doc_type='ADJ'")), audit:app.api.all("SELECT * FROM audit_log").length });

// A remote (CBD) with an Admin and two products, and a main (Boka) with main's costs.
function rig(){
  const R = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
  const M = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
  addAdmin(R,"Chipo","1234"); addAdmin(M,"Owner","9999");
  const r1 = addProduct(R,"CBD",{name:"Rice 2kg",sku:"SK1",stock:25,price:5.5,cost:0});
  const r2 = addProduct(R,"CBD",{name:"Sugar 1kg",sku:"SK2",stock:10,price:3,cost:0});
  addProduct(M,"Boka",{name:"Rice 2kg",sku:"SK1",stock:100,price:5,cost:3.5});
  addProduct(M,"Boka",{name:"Sugar 1kg",sku:"SK2",stock:100,price:3,cost:0});          // main has no cost for SK2
  R.api.getBranchId(); M.api.getBranchId();
  return { R, M, r1, r2 };
}

(async()=>{
  // ================= rules =================
  await t("reasons: the fixed list, and each reason's direction rule", ()=>{
    const { R } = rig();
    assert.strictEqual(J(R.api.ADJ_REASONS),J(["Lost in transit","Damaged","Expired","Theft","Miscount correction","Other"]));
    for(const reason of ["Lost in transit","Damaged","Expired","Theft"]){
      assert.ok(/can only reduce stock/.test(R.api.adjustmentProblem({reason,qty:"3",note:"n",stock:10})), reason+" cannot increase");
      assert.strictEqual(R.api.adjustmentProblem({reason,qty:"-3",note:"n",stock:10}),"",reason+" may reduce");
    }
    for(const reason of ["Miscount correction","Other"]){
      assert.strictEqual(R.api.adjustmentProblem({reason,qty:"3",note:"n",stock:10}),"",reason+" may increase");
      assert.strictEqual(R.api.adjustmentProblem({reason,qty:"-3",note:"n",stock:10}),"",reason+" may reduce");
    }
    assert.ok(/Choose a reason/.test(R.api.adjustmentProblem({reason:"Gift",qty:"-1",note:"n",stock:10})));
    assert.ok(/Choose a reason/.test(R.api.adjustmentProblem({reason:"",qty:"-1",note:"n",stock:10})));
  });
  await t("whole numbers only, never zero", ()=>{
    const { R } = rig();
    for(const q of ["1.5","-2.5","abc","","  ","--2","1e2","2 3"]) assert.ok(/whole number/.test(R.api.adjustmentProblem({reason:"Other",qty:q,note:"n",stock:10})), "rejects '"+q+"'");
    assert.ok(/can't be zero/.test(R.api.adjustmentProblem({reason:"Other",qty:"0",note:"n",stock:10})));
    assert.ok(/can't be zero/.test(R.api.adjustmentProblem({reason:"Other",qty:"-0",note:"n",stock:10})));
    assert.ok(/too large/.test(R.api.adjustmentProblem({reason:"Other",qty:"99999999",note:"n",stock:10})));
    assert.strictEqual(R.api.adjustmentProblem({reason:"Other",qty:" +2 ",note:"n",stock:10}),"");
  });
  await t("stock can never go below zero (exactly zero is fine); a rejected adjustment writes nothing", ()=>{
    const { R, r1 } = rig();
    const before = snapshot(R);
    assert.throws(()=>adj(R,r1,"Damaged","-26","boxes crushed"), /only 25 in stock/);
    assert.strictEqual(snapshot(R),before,"nothing written, no number used");
    adj(R,r1,"Damaged","-25","all crushed");
    assert.strictEqual(stockOf(R,"SK1"),0);
    assert.throws(()=>adj(R,r1,"Miscount correction","-1","x"), /only 0 in stock/);
    assert.strictEqual(stockOf(R,"SK1"),0);
  });
  await t("a note is mandatory", ()=>{
    const { R, r1 } = rig(); const before = snapshot(R);
    for(const n of ["", "   ", null, undefined]) assert.throws(()=>adj(R,r1,"Damaged","-1",n), /Write a note/);
    assert.strictEqual(snapshot(R),before);
  });
  await t("Admin passcode is required: wrong, blank, cashier, inactive Admin and no Admin at all", ()=>{
    const { R, r1 } = rig();
    R.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Till','Cashier','5555','CBD',1,'x')");
    addAdmin(R,"Gone","7777",{active:0});
    const before = snapshot(R);
    for(const p of ["0000","","   ","5555","7777"]) assert.throws(()=>adj(R,r1,"Damaged","-1","n",p), /Incorrect Admin passcode/, "rejects '"+p+"'");
    assert.strictEqual(snapshot(R),before);
    const N = makeApp({ branch_name:"NoAdmin", branch_type:"remote", setup_complete:"1" });
    const p = addProduct(N,"NoAdmin",{name:"X",sku:"X1",stock:5});
    assert.throws(()=>adj(N,p,"Damaged","-1","n","anything"), /Set an Admin passcode in Settings first/);
    assert.strictEqual(stockOf(N,"X1"),5);
    assert.strictEqual(J(N.api.all("SELECT * FROM stock_adjustments")),"[]");
  });
  await t("a signed-in user is required", ()=>{
    const { R, r1 } = rig();
    vm.runInContext('sessionUser=""', R.ctx);
    assert.throws(()=>adj(R,r1,"Damaged","-1","n"), /Enter your name first/);
    assert.strictEqual(stockOf(R,"SK1"),25);
  });
  await t("a recorded adjustment: stock, ONE adjustment row, ONE ledger row, audit line with the authorising Admin", ()=>{
    const { R, r1 } = rig();
    const when = new Date("2026-09-10T08:30:00Z");
    const res = adj(R,r1,"Damaged","-3","2 bags split, 1 wet",null,when);
    assert.strictEqual(res.old,25); assert.strictEqual(res.new,22); assert.strictEqual(res.adjText,"ADJ0001"); assert.strictEqual(res.admin,"Chipo");
    assert.strictEqual(stockOf(R,"SK1"),22);
    const a = R.api.one("SELECT * FROM stock_adjustments");
    assert.strictEqual(a.branch,"CBD"); assert.strictEqual(a.branch_id,R.api.getBranchId()); assert.strictEqual(a.adj_no,1);
    assert.strictEqual(a.product_code,"SK1"); assert.strictEqual(a.product_name,"Rice 2kg"); assert.strictEqual(a.qty_delta,-3);
    assert.strictEqual(a.reason,"Damaged"); assert.strictEqual(a.note,"2 bags split, 1 wet"); assert.strictEqual(a.by_user,"Tester"); assert.strictEqual(a.authorised_by,"Chipo");
    assert.strictEqual(a.ts,when.toISOString()); assert.strictEqual(a.dn_branch_id,null); assert.strictEqual(a.dn_no,null);
    const led = R.api.all("SELECT * FROM stock_received WHERE adj_no IS NOT NULL");
    assert.strictEqual(led.length,1); assert.strictEqual(led[0].qty,-3); assert.strictEqual(led[0].product_id,r1.id); assert.strictEqual(led[0].branch,"CBD");
    assert.strictEqual(led[0].adj_branch_id,R.api.getBranchId()); assert.strictEqual(led[0].adj_no,1); assert.ok(/ADJ0001: Damaged/.test(led[0].note));
    const audit = R.api.one("SELECT * FROM audit_log WHERE action='Stock adjustment'");
    assert.ok(audit && /authorised by Chipo/.test(audit.details) && /25 -> 22/.test(audit.details));
    assert.strictEqual(adj(R,r1,"Other","+4","found a bag").adjText,"ADJ0002");
    assert.strictEqual(stockOf(R,"SK1"),26);
  });
  await t("one transaction: if anything fails after the stock moves, stock, both rows, the number and the audit line all roll back", ()=>{
    const { R, r1 } = rig(); const before = snapshot(R);
    R.hook("logAudit", ()=>{ throw new Error("disk full"); });
    assert.throws(()=>adj(R,r1,"Theft","-2","taken"), /disk full/);
    assert.strictEqual(snapshot(R),before);
    assert.strictEqual(stockOf(R,"SK1"),25);
    // and a failure between the two inserts
    const R2 = rig().R; const p2 = R2.api.one("SELECT * FROM products WHERE sku='SK1'"); const before2 = snapshot(R2);
    let n = 0; const realRun = R2.api.run;
    R2.hook("run", (sql, params)=>{ if(/INSERT INTO stock_received/.test(sql)) throw new Error("ledger failed"); return realRun(sql, params); });
    assert.throws(()=>adj(R2,p2,"Expired","-2","old"), /ledger failed/);
    R2.hook("run", realRun);
    assert.strictEqual(snapshot(R2),before2,"the stock change and the adjustment row were undone with it");
  });
  await t("price, cost and recorded sales are never touched", ()=>{
    const { R, r1 } = rig();
    R.api.run("INSERT INTO sales(ts,total,method,branch) VALUES('2026-09-01T10:00:00.000Z',11,'Cash','CBD')");
    R.api.run("INSERT INTO sale_items(sale_id,product_id,name,price,qty,cost) VALUES(1,?,?,5.5,2,0)",[r1.id,"Rice 2kg"]);
    const sales = J([R.api.all("SELECT * FROM sales"),R.api.all("SELECT * FROM sale_items")]);
    const p = R.api.one("SELECT price,cost,name,sku,low_threshold FROM products WHERE id=?",[r1.id]);
    adj(R,r1,"Damaged","-3","x"); adj(R,r1,"Miscount correction","+5","y");
    assert.strictEqual(J(R.api.one("SELECT price,cost,name,sku,low_threshold FROM products WHERE id=?",[r1.id])),J(p));
    assert.strictEqual(J([R.api.all("SELECT * FROM sales"),R.api.all("SELECT * FROM sale_items")]),sales);
  });
  await t("preview text: 'Stock 25 -> 22', or the problem", ()=>{
    const { R } = rig();
    assert.strictEqual(R.api.adjustPreviewText(25,"-3","Damaged"),"Stock 25 -> 22");
    assert.strictEqual(R.api.adjustPreviewText(25,"+3","Other"),"Stock 25 -> 28");
    assert.ok(/only 25 in stock/.test(R.api.adjustPreviewText(25,"-30","Damaged")));
    assert.ok(/can only reduce/.test(R.api.adjustPreviewText(25,"3","Theft")));
    assert.strictEqual(R.api.adjustPreviewText(25,"","Damaged"),"");
  });

  // ================= remote: adjust yes, full editor no =================
  await t("a remote can adjust stock, but the full product editor stays locked", ()=>{
    const { R, r1 } = rig();
    const alerts = []; R.hook("alert", (m)=>alerts.push(m));
    R.api.productModal(R.api.one("SELECT * FROM products WHERE id=?",[r1.id]));
    assert.ok(/remote branch/.test(alerts[0]||""), "productModal is still refused on a remote");
    const table = R.api.productsTableHtml(R.api.all("SELECT * FROM products"), true);
    assert.ok(/data-actions="[^"]*\badjust\b/.test(table)); assert.ok(!/data-actions="[^"]*\b(edit|restock)\b/.test(table));
    adj(R,r1,"Lost in transit","-4","missing from the truck");
    assert.strictEqual(stockOf(R,"SK1"),21);
    // main shows the adjust button next to edit and restock
    const M = rig().M; const mt = M.api.productsTableHtml(M.api.all("SELECT * FROM products"), false);
    assert.ok(/data-actions="edit restock adjust"/.test(mt));
  });
  await t("the same passcode unlock is used by price edits and adjustments", ()=>{
    const { R } = rig();
    assert.strictEqual(R.api.findAdmin("1234").name,"Chipo"); assert.strictEqual(R.api.findAdmin("nope"),null); assert.strictEqual(R.api.findAdmin(""),null);
  });

  // ================= ledger reports =================
  await t("existing ledger reports stay correct: Stock Received shows the adjustment and nets units; aging ignores stock going out", ()=>{
    const { R, r1 } = rig();
    R.api.run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES('2026-09-01T08:00:00.000Z',?,?,?,?,?,?)",[r1.id,"Rice 2kg",30,"Restock","CBD","u"]);
    adj(R,r1,"Damaged","-3","wet",null,new Date("2026-09-05T10:00:00Z"));
    const rep = R.api.REPORT_CONFIGS.find(c=>c.id==="stock").fetch("CBD","2026-01-01T00:00:00","2100-01-01T00:00:00");
    assert.strictEqual(rep.rows.length,2);
    assert.ok(rep.rows.some(r=>r.join("|").includes("-3") && /Adjustment ADJ0001: Damaged/.test(r.join("|"))));
    assert.strictEqual(rep.footer,"Total units received: 27");
    const src = fs.readFileSync(path.join(__dirname,"..","src","reports.js"),"utf8");
    assert.ok(/MAX\(ts\) as t FROM stock_received WHERE product_id=\? AND qty>0/.test(src), "aging only counts stock coming IN");
    assert.ok(!/detail:`\+\$\{r\.qty\}`/.test(src), "negative rows no longer print as '+-3'");
  });

  // ================= merge =================
  await t("merge: additive and de-duplicated per (branch_id, adj_no); never updated; stock never summed", async ()=>{
    const { R, M, r1, r2 } = rig();
    const sameMs = new Date("2026-09-10T08:00:00Z");
    adj(R,r1,"Damaged","-3","a",null,sameMs); adj(R,r2,"Theft","-1","b",null,sameMs);          // identical timestamp, different products
    adj(M,M.api.one("SELECT * FROM products WHERE sku='SK1'"),"Expired","-2","own",  "9999");    // main's own adj_no 1 must not collide with R's
    const mainStock = { sk1:stockOf(M,"SK1") };
    await M.api.mergeDatabase({ __db:R.db });
    assert.strictEqual(M.api.all("SELECT * FROM stock_adjustments").length,3);
    assert.strictEqual(M.api.all("SELECT * FROM stock_received WHERE adj_no IS NOT NULL").length,3,"both same-millisecond ledger rows arrive");
    assert.strictEqual(M.api.all("SELECT * FROM stock_adjustments WHERE adj_no=1").length,2,"same adj_no, different branch_id: both kept");
    assert.strictEqual(stockOf(M,"SK1"),mainStock.sk1,"main's own stock is not changed by merging");
    assert.strictEqual(M.api.one("SELECT stock FROM products WHERE branch='CBD' AND sku='SK1'").stock,22,"the branch's product arrives once, at its stock then");
    const snap = snapshot(M);
    await M.api.mergeDatabase({ __db:R.db }); await M.api.mergeDatabase({ __db:R.db });
    assert.strictEqual(snapshot(M),snap,"re-merging adds nothing");
    // a later adjustment arrives alone; an edit on the branch never rewrites main's copy
    adj(R,r1,"Other","+2","late find");
    R.api.run("UPDATE stock_adjustments SET note='EDITED' WHERE adj_no=1");
    await M.api.mergeDatabase({ __db:R.db });
    assert.strictEqual(M.api.all("SELECT * FROM stock_adjustments").length,4);
    assert.strictEqual(M.api.all("SELECT * FROM stock_received WHERE adj_no IS NOT NULL").length,4);
    assert.strictEqual(M.api.one("SELECT note FROM stock_adjustments WHERE branch_id=? AND adj_no=1",[R.api.getBranchId()]).note,"a","never updated");
  });
  await t("merge: an old-format file (no adjustments table, no ledger link columns) still merges", async ()=>{
    const { R, M } = rig();
    R.api.run("DROP TABLE stock_adjustments"); R.api.run("ALTER TABLE stock_received DROP COLUMN adj_no"); R.api.run("ALTER TABLE stock_received DROP COLUMN adj_branch_id");
    await M.api.mergeDatabase({ __db:R.db });
    assert.strictEqual(M.api.all("SELECT * FROM products WHERE branch='CBD'").length,2);
    assert.strictEqual(M.api.all("SELECT * FROM stock_adjustments").length,0);
  });
  await t("migration is safe to repeat and leaves data alone", ()=>{
    const { R, r1 } = rig(); adj(R,r1,"Damaged","-1","x");
    const before = snapshot(R); R.api.migrate(R.db); R.api.migrate(R.db);
    assert.strictEqual(snapshot(R),before);
  });

  // ================= report (main) =================
  await t("Stock Adjustments report on main: value at MAIN's cost by product code; blanks; filters; totals per reason; read-only", async ()=>{
    const { R, M, r1, r2 } = rig();
    adj(R,r1,"Damaged","-3","wet",null,new Date("2026-09-05T10:00:00Z"));           // main cost 3.5 -> -10.50
    adj(R,r1,"Damaged","-2","more",null,new Date("2026-09-06T10:00:00Z"));           // -7.00
    adj(R,r2,"Theft","-1","gone",null,new Date("2026-09-07T10:00:00Z"));             // main has no cost for SK2 -> blank
    adj(R,r1,"Miscount correction","+4","count",null,new Date("2026-09-08T10:00:00Z")); // +14.00
    const nocode = addProduct(R,"CBD",{name:"Mystery",sku:"",stock:9}); adj(R,nocode,"Other","-1","no code",null,new Date("2026-09-09T10:00:00Z"));
    await M.api.mergeDatabase({ __db:R.db });
    const before = snapshot(M);
    const fetch = (b,reason)=>M.api.REPORT_CONFIGS.find(c=>c.id==="adjustments").fetch(b||null,"2026-01-01T00:00:00","2100-01-01T00:00:00",null,"",{reason:reason||""});
    const all = fetch();
    const cells = all.rows.map(r=>r.join("|"));
    assert.ok(cells.some(c=>c.includes("Damaged") && c.includes("|-3|") && c.includes("-$10.50")), "value = -3 x main cost 3.50, shown as -$10.50");
    const d = M.api.adjustmentReport({});
    const byNote = (n)=>d.rows.find(r=>r.note===n);
    assert.strictEqual(byNote("wet").value,-10.5); assert.strictEqual(byNote("more").value,-7); assert.strictEqual(byNote("count").value,14);
    assert.strictEqual(byNote("gone").value,null,"main has no cost -> blank"); assert.strictEqual(byNote("no code").value,null,"no code -> blank");
    const tot = (r)=>d.totals.find(x=>x.reason===r);
    assert.strictEqual(tot("Damaged").units,-5); assert.strictEqual(tot("Damaged").value,-17.5); assert.strictEqual(tot("Damaged").count,2);
    assert.strictEqual(tot("Theft").units,-1); assert.strictEqual(tot("Theft").value,null,"nothing valued -> blank total, not 0.00");
    assert.strictEqual(tot("Miscount correction").units,4);
    assert.strictEqual(d.unvalued,2);
    assert.ok(/2 without a main cost/.test(all.footer));
    assert.ok(all.rows.some(r=>/<b>Total<\/b>/.test(r[0]) && /Damaged/.test(r[4])),"a totals row per reason is in the table");
    // filters
    assert.strictEqual(M.api.adjustmentReport({ reason:"Theft" }).rows.length,1);
    assert.strictEqual(M.api.adjustmentReport({ branch:"CBD" }).rows.length,5); assert.strictEqual(M.api.adjustmentReport({ branch:"Nowhere" }).rows.length,0);
    assert.strictEqual(M.api.adjustmentReport({ fromMs:Date.parse("2026-09-07T00:00:00Z"), toMs:Date.parse("2026-09-08T23:59:59Z") }).rows.length,2);
    assert.strictEqual(fetch("CBD","Damaged").rows.filter(r=>!/Total/.test(r[0])).length,2);
    assert.strictEqual(snapshot(M),before,"information only: viewing changes nothing");
    // ambiguous code on main -> blank; zero cost -> blank
    addProduct(M,"Boka",{name:"Rice dup",sku:"sk1",stock:1,cost:9});
    assert.strictEqual(M.api.adjustmentReport({}).rows.find(r=>r.note==="wet").value,null,"two main products with the code -> blank");
    // remotes do not see it
    assert.strictEqual(vm.runInContext("reportWriterConfigs().some(c=>c.id==='adjustments')",R.ctx),false);
    assert.strictEqual(vm.runInContext("reportWriterConfigs().some(c=>c.id==='adjustments')",M.ctx),true);
  });
  await t("Stock Movements has a separate Adjustments view; the default view is still the DN statuses", async ()=>{
    const { R, M, r1 } = rig(); adj(R,r1,"Damaged","-3","wet");
    await M.api.mergeDatabase({ __db:R.db });
    const cfg = M.api.REPORT_CONFIGS.find(c=>c.id==="movements");
    const dn = cfg.fetch(null,"2000-01-01T00:00:00","2100-01-01T00:00:00",null,"",{});
    assert.strictEqual(J(dn.headers),J(["DN","From","To","Dispatched","Status","GRV","Variance","Chain / notes","Loss (main cost)"]));
    assert.strictEqual(dn.rows.length,0,"an adjustment is not a DN and never appears among them");
    const av = cfg.fetch(null,"2000-01-01T00:00:00","2100-01-01T00:00:00",null,"",{ view:"adjustments" });
    assert.strictEqual(av.rows.length>=1,true); assert.ok(av.headers.includes("Reason") && av.headers.includes("Value"));
  });

  // ================= branch name lock =================
  await t("branch name: locked after setup on main and remote; a nameless device may set one, once", ()=>{
    for(const type of ["main","remote"]){
      const A = makeApp({ branch_name:"Boka", branch_type:type, setup_complete:"1" });
      assert.strictEqual(A.api.branchNameLocked(),true);
      assert.strictEqual(A.api.branchNameToSave("Something else"),"Boka","Settings can't change it ("+type+")");
      assert.strictEqual(A.api.branchNameToSave(""),"Boka");
    }
    const N = makeApp({ branch_type:"main", shop_name:"Shop", setup_complete:"1" });
    assert.strictEqual(N.api.branchNameLocked(),false);
    assert.strictEqual(N.api.branchNameToSave("  First Name "),"First Name");
    N.api.setSetting("branch_name","First Name");
    assert.strictEqual(N.api.branchNameLocked(),true); assert.strictEqual(N.api.branchNameToSave("Other"),"First Name");
    const src = fs.readFileSync(path.join(__dirname,"..","src","settings.js"),"utf8");
    assert.ok(/id="sBranch"[^>]*\$\{branchNameLocked\(\)\? "readonly"/.test(src), "the Settings field is read-only when locked");
    assert.ok(!/branchRenameWarning|branchRenameImpact/.test(src+fs.readFileSync(path.join(__dirname,"..","src","dispatch-out.js"),"utf8")), "the rename warning flow is gone");
  });
  await t("destination rename (main): allowed until the first DN is dispatched to it, then locked; nothing existing changes", ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    addProduct(A,"Boka",{name:"Rice",sku:"SK1",stock:20});
    A.api.ensureSelfInRegister();
    ["Harare CBD","Mutare"].forEach(n=>A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES(?,'')",[n]));
    A.api.run("INSERT INTO branch_prices(dest_branch_name,code,price,updated_ts) VALUES('Harare CBD','SK1',9,'x')");
    const id = (n)=>A.api.one("SELECT id FROM branch_register WHERE name=?",[n]).id;
    const r = A.api.renameRegisterBranch(id("Harare CBD"),"Harare Central");
    assert.strictEqual(r.new,"Harare Central");
    assert.strictEqual(A.api.one("SELECT COUNT(*) c FROM branch_prices WHERE dest_branch_name='Harare Central'").c,1,"branch prices follow the rename");
    // dispatch to Mutare -> locked
    const p = A.api.one("SELECT * FROM products WHERE sku='SK1'");
    const dn = A.api.dnCommitDispatch({ branch:"Boka", toBranch:"Mutare", now:new Date(), lines:[{product:p,qty:2}] });
    assert.strictEqual(A.api.destinationNameLocked("Mutare"),true); assert.strictEqual(A.api.destinationNameLocked("mutare"),true,"case-insensitive");
    assert.strictEqual(A.api.destinationNameLocked("Harare Central"),false);
    const before = snapshot(A);
    assert.throws(()=>A.api.renameRegisterBranch(id("Mutare"),"Mutare North"), (e)=>e.message.includes('locked: a Delivery Note (DN0001) has been dispatched to "Mutare"'));
    assert.strictEqual(snapshot(A),before,"existing rows and DNs are untouched");
    assert.strictEqual(A.api.dnHeaderFor(dn.n).receive_branch_name,"Mutare");
    // other refusals
    assert.throws(()=>A.api.renameRegisterBranch(id("Harare Central"),"mutare"), /already in the register/);
    assert.throws(()=>A.api.renameRegisterBranch(id("Harare Central"),"  "), /Enter the new branch name/);
    assert.throws(()=>A.api.renameRegisterBranch(id("Harare Central"),"Harare Central"), /already the name/);
    assert.throws(()=>A.api.renameRegisterBranch(id("Boka"),"Boka 2"), /own entry/);
    assert.throws(()=>A.api.renameRegisterBranch(9999,"X"), /not in the register/);
    // the card says why
    const card = A.api.branchRegisterCardHtml();
    assert.ok(/Name locked: a Delivery Note has been sent to it/.test(card));
    assert.strictEqual((card.match(/data-reg-rename=/g)||[]).length,1,"only the unlocked destination offers Rename");
    // remotes never manage the register
    const R = makeApp({ branch_name:"CBD", branch_type:"remote", setup_complete:"1" });
    R.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Boka','')");
    assert.throws(()=>R.api.renameRegisterBranch(R.api.one("SELECT id FROM branch_register").id,"X"), /managed on the main branch/);
  });
  await t("lock trigger 1 - DN: the first DN dispatched to a destination locks its name, and the message says a Delivery Note did it", ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    addProduct(A,"Boka",{name:"Rice",sku:"SK1",stock:20});
    A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Mutare','')");
    const id = A.api.one("SELECT id FROM branch_register WHERE name='Mutare'").id;
    assert.strictEqual(A.api.destinationLock("Mutare"),null,"a new destination is unlocked");
    const dn = A.api.dnCommitDispatch({ branch:"Boka", toBranch:"Mutare", now:new Date("2026-09-10T09:00:00Z"), lines:[{product:A.api.one("SELECT * FROM products WHERE sku='SK1'"),qty:1}] });
    const lock = A.api.destinationLock("Mutare");
    assert.strictEqual(lock.by,"dispatch"); assert.strictEqual(lock.dnNo,dn.n);
    assert.strictEqual(A.api.one("SELECT catalogue_first_ts FROM branch_register WHERE name='Mutare'").catalogue_first_ts,"","no catalogue was generated");
    let msg = ""; try{ A.api.renameRegisterBranch(id,"Mutare 2"); }catch(e){ msg = e.message; }
    assert.ok(msg.includes('a Delivery Note (DN0001) has been dispatched to "Mutare" on 10Sep26'), msg);
    assert.ok(!/catalogue/.test(msg));
    assert.strictEqual(A.api.one("SELECT name FROM branch_register WHERE id=?",[id]).name,"Mutare");
    assert.ok(/a Delivery Note has been sent to it/.test(A.api.branchRegisterCardHtml()));
  });
  await t("lock trigger 2 - catalogue: the first catalogue generated for a destination locks its name (no DN needed), and the message says a catalogue did it", async ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    addProduct(A,"Boka",{name:"Rice",sku:"SK1",stock:20});
    A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Mutare','')"); A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Gweru','')");
    const id = A.api.one("SELECT id FROM branch_register WHERE name='Mutare'").id;
    assert.strictEqual(A.api.destinationLock("Mutare"),null);
    A.hook("getThumbs", async (ps)=>ps.map(()=>null));
    await A.api.buildCatalogueFor("Mutare");
    const lock = A.api.destinationLock("Mutare");
    assert.strictEqual(lock.by,"catalogue"); assert.ok(lock.ts);
    assert.strictEqual(A.api.all("SELECT * FROM dispatch_docs WHERE direction='out'").length,0,"no DN was dispatched");
    let msg = ""; try{ A.api.renameRegisterBranch(id,"Mutare 2"); }catch(e){ msg = e.message; }
    assert.ok(/a catalogue was generated for "Mutare" on \d{2}[A-Z][a-z]{2}\d{2}\./.test(msg), msg);
    assert.ok(!/Delivery Note/.test(msg));
    const card = A.api.branchRegisterCardHtml();
    assert.ok(/Name locked: a catalogue has been generated for it/.test(card));
    assert.strictEqual((card.match(/data-reg-rename=/g)||[]).length,1,"the other destination (Gweru) is still renamable");
    assert.strictEqual(A.api.renameRegisterBranch(A.api.one("SELECT id FROM branch_register WHERE name='Gweru'").id,"Gweru North").new,"Gweru North");
    // rebuilding does not move the "first" time, and the lock stays
    const first = A.api.one("SELECT catalogue_first_ts FROM branch_register WHERE name='Mutare'").catalogue_first_ts;
    await new Promise(r=>setTimeout(r,30)); await A.api.buildCatalogueFor("Mutare");
    assert.strictEqual(A.api.one("SELECT catalogue_first_ts FROM branch_register WHERE name='Mutare'").catalogue_first_ts,first);
  });
  await t("lock: when both have happened, the message names whichever came FIRST", ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    addProduct(A,"Boka",{name:"Rice",sku:"SK1",stock:20});
    ["Mutare","Gweru"].forEach(n=>A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES(?,'')",[n]));
    const p = A.api.one("SELECT * FROM products WHERE sku='SK1'");
    // Mutare: catalogue first (Sep 1), DN later (Sep 5)
    A.api.run("UPDATE branch_register SET catalogue_first_ts='2026-09-01T08:00:00.000Z', catalogue_ts='2026-09-06T08:00:00.000Z' WHERE name='Mutare'");
    A.api.dnCommitDispatch({ branch:"Boka", toBranch:"Mutare", now:new Date("2026-09-05T08:00:00Z"), lines:[{product:p,qty:1}] });
    assert.strictEqual(A.api.destinationLock("Mutare").by,"catalogue");
    assert.ok(/a catalogue was generated for "Mutare" on 01Sep26/.test(A.api.destinationLockText("Mutare")));
    // Gweru: DN first (Sep 2), catalogue later (Sep 4)
    A.api.dnCommitDispatch({ branch:"Boka", toBranch:"Gweru", now:new Date("2026-09-02T08:00:00Z"), lines:[{product:p,qty:1}] });
    A.api.run("UPDATE branch_register SET catalogue_first_ts='2026-09-04T08:00:00.000Z', catalogue_ts='2026-09-04T08:00:00.000Z' WHERE name='Gweru'");
    assert.strictEqual(A.api.destinationLock("Gweru").by,"dispatch");
    assert.ok(A.api.destinationLockText("Gweru").includes('a Delivery Note (DN0002) has been dispatched to "Gweru" on 02Sep26'));
  });
  await t("lock: an upgraded device whose destination already had a catalogue is locked (first time backfilled from its latest build)", ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    A.api.run("INSERT INTO branch_register(name,whatsapp,catalogue_ts) VALUES('Old','','2026-08-01T08:00:00.000Z')");
    A.api.run("UPDATE branch_register SET catalogue_first_ts='' WHERE name='Old'");
    A.api.migrate(A.db);
    assert.strictEqual(A.api.destinationLock("Old").by,"catalogue");
  });
  await t("Replace refuses a file that belongs to a differently named branch; own backups and unnamed devices are fine", async ()=>{
    const A = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    const other = makeApp({ branch_name:"Mutare", branch_type:"main", setup_complete:"1" });
    const mine = makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1" });
    const bytes = (x)=>Object.assign(new Uint8Array([1]),{__db:x.db});
    assert.ok(/belongs to "Mutare", but this device is "Boka"/.test(A.api.replaceNameProblem(bytes(other))));
    assert.strictEqual(A.api.replaceNameProblem(bytes(mine)),"");
    const N = makeApp({ shop_name:"Shop", branch_type:"main", setup_complete:"1" });
    assert.strictEqual(N.api.replaceNameProblem(bytes(other)),"", "a device with no branch name yet may restore any backup");
    const calls = { alerts:[], downloads:0 }; A.hook("alert",(m)=>calls.alerts.push(m)); A.hook("downloadDb",()=>calls.downloads++); A.hook("render",()=>{});
    A.hook("readFileBytes", async ()=>bytes(other));
    const before = snapshot(A);
    await A.api.onReplacePicked({ name:"x.sqlite", bytes:new Uint8Array([1]) });
    assert.strictEqual(calls.downloads,0); assert.strictEqual(calls.alerts.length,1); assert.strictEqual(snapshot(A),before);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
