// node test/supplier-grv.test.js
//
// Suppliers and the supplier GRV (Dispatch & GRV B2), end to end: three tills
// running the REAL app code (test/harness.js) against the REAL server SQL
// (20261017120000 + 20261018120000) in PGlite, never the live database.
// Harare main (T1, T2) and Murehwa (remote T1). Covers: the supplier list
// (main only, sent when online, pulled by every till, the same name added on
// two tills offline ends as one), the GRV (invoice required, a new selling
// price needs the Admin passcode, delivery cost landed by value, new products),
// the same invoice refused on this till and across the business, two tills
// receiving the same invoice offline (the second takes its receipt back out,
// once), a lost answer, a restored backup put back once, and remote tills
// kept out.
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); }
}

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> !/^2026101[78]120000_/.test(f)) });
  const q = async (sql, p)=> (await pg.query(sql, p)).rows;
  let dropAnswer = null;
  async function rpc(fn, body){
    const names = Object.keys(body);
    const args = names.map((n)=> (body[n] !== null && typeof body[n] === "object") ? JSON.stringify(body[n]) : body[n]);
    await pg.exec("set role anon");
    try{ return { status:200, body: JSON.stringify((await pg.query(`select to_json(public.${fn}(${names.map((n, i)=> `${n}=>$${i + 1}`).join(", ")})) j`, args)).rows[0].j) }; }
    catch(e){ return { status:400, body: JSON.stringify({ message: e.message }) }; }
    finally{ await pg.exec("reset role"); }
  }
  const fakeFetch = (A)=> async (url, opts)=>{
    if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
    const fn = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url))[1];
    const r = await rpc(fn, JSON.parse(opts.body));
    if(dropAnswer === fn){ dropAnswer = null; throw new TypeError("network lost the answer"); }
    return { ok: r.status < 300, status: r.status, text: async ()=> r.body };
  };
  function till(name, settings){
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:"Mandie Phrase", install_date:"2026-09-01", shop_name:"Mandie Babyware" }, settings));
    A.name = name; A.hook("fetch", fakeFetch(A));
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Boss','Admin','4321',?,1,?)", [A.api.currentBranch(), new Date().toISOString()]);
    return A;
  }
  const H1 = till("H1", { install_id:"HA01", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const H2 = till("H2", { install_id:"HA02", branch_name:"Harare", branch_id:"B-HARARE02", branch_type:"main" });
  const M1 = till("M1", { install_id:"MU01", branch_name:"Murehwa", branch_id:"B-MUREHWA1", branch_type:"remote" });
  const stock = (A, sku)=> (A.api.one("SELECT stock FROM products WHERE sku=? AND branch=?", [sku, A.api.currentBranch()]) || {}).stock;
  const P = (A, sku)=> A.api.one("SELECT * FROM products WHERE sku=? AND branch=?", [sku, A.api.currentBranch()]);
  const ledgerOk = (A)=> assert.strictEqual(JSON.stringify(A.api.stockLedgerCheck().mismatches), "[]", A.name + ": stock = the sum of its movements");
  const prod = (A, sku, name, stockN, cost, price)=>{ A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,cost,created_ts) VALUES(?,?,?,?,?,?,?,?)", [name, price, stockN, 1, sku, A.api.currentBranch(), cost, new Date().toISOString()]); A.api.recordStockMovement(P(A, sku).id, stockN, { kind:"opening" }); };
  const sup = (A, name)=> A.api.sgSuppliers().find((s)=> s.name === name);

  await t("setup: Harare T1 registers, T2 and Murehwa join (the app's own calls)", async ()=>{
    assert.ok((await H1.api.registerMainBranch("Counter")).ok);
    let r = await H1.api.issueJoinCode({ branchId: H1.api.getSetting("branch_uuid","") });
    assert.ok((await H2.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code })).ok);
    r = await H1.api.issueJoinCode({ newBranchName:"Murehwa" });
    assert.ok((await M1.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, expectedBranchName:"Murehwa" })).ok);
  });
  prod(H1, "SUG2", "Sugar 2kg", 10, 1.2, 3); prod(H2, "SUG2", "Sugar 2kg", 4, 1.2, 3);

  await t("the supplier list: added on main (offline, sent later), pulled by every till; a remote till can't add one", async ()=>{
    H1.ctx.navigator.onLine = false;
    H1.api.sgSaveSupplier({ name:"Metro  Wholesalers", phone:"0771 000 111" });
    assert.throws(()=> H1.api.sgSaveSupplier({ name:"metro wholesalers" }), /already in the supplier list/);
    H1.ctx.navigator.onLine = true;
    await H1.api.sgSendPending();
    assert.strictEqual((await q("select name, phone from cl_suppliers"))[0].name, "Metro Wholesalers");
    await H2.api.sgPull(); await M1.api.sgPull();
    assert.ok(sup(H2, "Metro Wholesalers") && sup(M1, "Metro Wholesalers"));
    assert.throws(()=> M1.api.sgSaveSupplier({ name:"Local Farm" }), /kept on the main branch/);
  });

  let g1;
  await t("the GRV: a new selling price needs the Admin passcode (nothing changes without it); delivery landed by value; a new product", async ()=>{
    const base = { supplierUid: sup(H1, "Metro Wholesalers").uid, invoiceNo:"INV-123", delivery:{ cost:10, currency:"usd" }, note:"two boxes",
      lines:[{ product:P(H1, "SUG2"), qty:20, unitCost:1.4, newPrice:3.2 }, { product:null, name:"Salt 1kg", qty:5, unitCost:0.5 }] };
    await assert.rejects(()=> H1.api.sgPostGrv(Object.assign({}, base, { passcode:"0000" })), /Incorrect Admin passcode/);
    await assert.rejects(()=> H1.api.sgPostGrv(Object.assign({}, base, { invoiceNo:" - " })), /invoice number/);
    assert.strictEqual(stock(H1, "SUG2"), 10); assert.strictEqual(P(H1, "SUG2").price, 3);
    g1 = await H1.api.sgPostGrv(Object.assign({}, base, { passcode:"4321" }));
    assert.strictEqual(g1.grv.text, "GRV-T1-0001");
    assert.strictEqual(stock(H1, "SUG2"), 30);
    assert.strictEqual(P(H1, "SUG2").price, 3.2);
    // value 28 + 2.5 = 30.5; sugar gets 10*28/30.5 = 9.1803 -> +0.459 a unit
    assert.strictEqual(P(H1, "SUG2").cost, 1.859);
    const salt = H1.api.one("SELECT * FROM products WHERE name='Salt 1kg'");
    assert.strictEqual(salt.stock, 5); assert.strictEqual(salt.cost, 0.6639);
    const srv = (await q("select g.invoice_no, g.grv_display, g.delivery_cost::text, l.new_price::text, l.old_price::text, l.price_by from cl_supplier_grvs g join cl_supplier_grv_lines l on l.grv_id = g.id and l.line_no = 1"))[0];
    assert.deepStrictEqual(srv, { invoice_no:"INV-123", grv_display:"GRV-T1-0001", delivery_cost:"10.00", new_price:"3.20", old_price:"3.00", price_by:"Boss" });
    assert.strictEqual(H1.api.one("SELECT srv_status FROM purchases WHERE grv_uid=?", [g1.grvUid]).srv_status, "sent");
    assert.match(H1.api.one("SELECT details FROM audit_log WHERE action='Price change'").details, /3\.00 -> 3\.20 at GRV-T1-0001 \(authorised by Boss\)/);
    ledgerOk(H1);
  });

  await t("the same invoice again: refused on this till, and on another till of the business (any spelling); nothing changes", async ()=>{
    const o = (A)=> ({ supplierUid: sup(A, "Metro Wholesalers").uid, invoiceNo:"inv 123", delivery:{}, lines:[{ product:P(A, "SUG2"), qty:1, unitCost:1 }] });
    await assert.rejects(()=> H1.api.sgPostGrv(o(H1)), /Invoice INV-123 from Metro Wholesalers was already received as GRV-T1-0001/);
    await assert.rejects(()=> H2.api.sgPostGrv(o(H2)), /Invoice inv 123 from Metro Wholesalers was already received as GRV-T1-0001 on till T1/);
    assert.strictEqual(stock(H1, "SUG2"), 30); assert.strictEqual(stock(H2, "SUG2"), 4);
  });

  await t("two tills receive the same invoice, one offline: the second takes its receipt back out, once, and says why", async ()=>{
    H2.ctx.navigator.onLine = false;
    const r2 = await H2.api.sgPostGrv({ supplierUid: sup(H2, "Metro Wholesalers").uid, invoiceNo:"INV-555", delivery:{}, lines:[{ product:P(H2, "SUG2"), qty:6, unitCost:1.3 }] });
    assert.strictEqual(stock(H2, "SUG2"), 10, "offline, the stock comes in at once");
    await H1.api.sgPostGrv({ supplierUid: sup(H1, "Metro Wholesalers").uid, invoiceNo:"INV-555", delivery:{}, lines:[{ product:P(H1, "SUG2"), qty:6, unitCost:1.3 }] });
    H2.ctx.navigator.onLine = true;
    await H2.api.sgSendPending(); await H2.api.sgSendPending();
    assert.strictEqual(stock(H2, "SUG2"), 4, "taken back out, once");
    assert.strictEqual(H2.api.one("SELECT srv_status FROM purchases WHERE grv_uid=?", [r2.grvUid]).srv_status, "reversed");
    assert.match(H2.api.dsProblems().map((p)=> p.text).join(" "), /GRV-T2-0001: Invoice INV-555 from Metro Wholesalers was already received as GRV-T1-0002 .* This till's receipt was taken back out\./);
    assert.strictEqual((await q("select count(*)::int c from cl_supplier_grvs where invoice_key = 'INV555'"))[0].c, 1);
    ledgerOk(H2);
  });

  await t("the answer is lost: the GRV is sent again with the same uid, on seiGEN once, stock in once", async ()=>{
    dropAnswer = "cl_device_supplier_grv_post";
    const r = await H1.api.sgPostGrv({ supplierUid: sup(H1, "Metro Wholesalers").uid, invoiceNo:"INV-777", delivery:{}, lines:[{ product:P(H1, "SUG2"), qty:2, unitCost:1.3 }] });
    assert.strictEqual(H1.api.one("SELECT srv_status FROM purchases WHERE grv_uid=?", [r.grvUid]).srv_status, "queued");
    await H1.api.sgSendPending();
    assert.strictEqual(H1.api.one("SELECT srv_status FROM purchases WHERE grv_uid=?", [r.grvUid]).srv_status, "sent");
    assert.strictEqual((await q("select count(*)::int c from cl_supplier_grvs where invoice_key = 'INV777'"))[0].c, 1);
    assert.strictEqual(stock(H1, "SUG2"), 38);
    ledgerOk(H1);
  });

  await t("the same new supplier added on two tills: the second takes the first's, and its waiting GRV goes with it", async ()=>{
    H2.ctx.navigator.onLine = false;
    const mine = H2.api.sgSaveSupplier({ name:"Bulawayo Traders" });
    await H2.api.sgPostGrv({ supplierUid: mine.uid, invoiceNo:"BT-1", delivery:{}, lines:[{ product:P(H2, "SUG2"), qty:1, unitCost:1 }] });
    H1.api.sgSaveSupplier({ name:"bulawayo traders" }); await H1.api.sgSendPending();
    H2.ctx.navigator.onLine = true;
    await H2.api.sgPull();
    const theirs = (await q("select id from cl_suppliers where lower(name) = 'bulawayo traders'"))[0].id;
    assert.strictEqual(H2.api.sgSuppliers().filter((s)=> /bulawayo/i.test(s.name)).length, 1);
    assert.strictEqual(sup(H2, "bulawayo traders").uid, theirs.replace(/-/g, ""));
    assert.strictEqual((await q("select count(*)::int c from cl_supplier_grvs where invoice_key = 'BT1' and supplier_id = $1", [theirs]))[0].c, 1);
    assert.strictEqual(H2.api.dsPending("supplier_grv").length, 0);
  });

  await t("a restored backup: the supplier GRVs it lost are put back from seiGEN, once; the GRV counter can't go back", async ()=>{
    const before = stock(H1, "SUG2");
    H1.api.run("DELETE FROM stock_movements WHERE kind='supplier_grv'"); H1.api.run("DELETE FROM purchases");
    H1.api.run("UPDATE products SET stock=(SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements m WHERE m.product_id=products.id)");
    H1.api.run("UPDATE doc_counters SET last_no=0 WHERE doc_type='GRV'");
    await H1.api.sgPull(); await H1.api.sgPull();
    assert.strictEqual(stock(H1, "SUG2"), before);
    assert.strictEqual(H1.api.all("SELECT DISTINCT grv_uid FROM purchases").length, 3);
    assert.strictEqual(H1.api.one("SELECT last_no FROM doc_counters WHERE doc_type='GRV'").last_no, 3);
    ledgerOk(H1);
  });

  await t("a remote till can't receive from a supplier", async ()=>{
    await assert.rejects(()=> M1.api.sgPostGrv({ supplierUid: sup(M1, "Metro Wholesalers").uid, invoiceNo:"X-1", delivery:{}, lines:[{ product:null, name:"Thing", qty:1, unitCost:1 }] }), /received on the main branch/);
  });

  await t("the purchases list groups each GRV with its invoice", async ()=>{
    const groups = H1.api.groupPurchases(H1.api.all("SELECT * FROM purchases ORDER BY ts DESC"));
    assert.strictEqual(groups.length, 3);
    assert.ok(groups.every((g)=> g.items.every((it)=> it.invoice_no && it.grv_no)));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
