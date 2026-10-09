// node test/dispatch-srv.test.js
//
// Dispatch & GRV through seiGEN, end to end: four tills running the REAL app
// code (test/harness.js) against the REAL server SQL (every migration,
// 20261017120000_dispatch_grv included) in PGlite, never the live database.
// Harare (main: T1, T2) dispatches to Murehwa (T1, T2). Covers: joined
// branches as destinations, an offline dispatch sent later (and only once),
// Incoming on both receiving tills, the file refused while seiGEN holds it,
// counts (short / damaged / extra), a product missing at the receiver, a lost
// answer (the GRV retried, stock in once), the second till refused before any
// stock moves, landed cost, the sender's differences (returned to stock, write
// off with ADJ, extra confirmed, re-dispatch, cancel reopening it), cancel
// after the GRV refused, a restored backup on both sides put right exactly
// once, a DN received from the file told to seiGEN without moving stock, the
// DN counter after a restore, and shared-stock tills kept on the file flow.
"use strict";
const assert = require("assert");
const path = require("path");
const crypto = require("crypto");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
const same = (a, b, m)=> assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);   // across the app's vm realm
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); }
}

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== "20261017120000_dispatch_grv.sql") });
  const q = async (sql, p)=> (await pg.query(sql, p)).rows;

  // PostgREST, as anon: POST /rest/v1/rpc/<fn> with named arguments
  let dropAnswer = null;            // fn name: the server runs it, the answer is lost
  const calls = [];
  async function rpc(fn, body){
    const names = Object.keys(body);
    const args = names.map((n)=> (body[n] !== null && typeof body[n] === "object") ? JSON.stringify(body[n]) : body[n]);
    const sql = `select to_json(public.${fn}(${names.map((n, i)=> `${n}=>$${i + 1}`).join(", ")})) j`;
    await pg.exec("set role anon");
    try{ return { status:200, body: JSON.stringify((await pg.query(sql, args)).rows[0].j) }; }
    catch(e){ return { status:400, body: JSON.stringify({ message: e.message }) }; }
    finally{ await pg.exec("reset role"); }
  }
  function fakeFetch(A){
    return async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      const fn = m[1];
      calls.push({ till: A.name, fn });
      const r = await rpc(fn, JSON.parse(opts.body));
      if(dropAnswer === fn){ dropAnswer = null; throw new TypeError("network lost the answer"); }
      return { ok: r.status < 300, status: r.status, text: async ()=> r.body };
    };
  }
  function till(name, settings){
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:"Mandie Phrase", install_date:"2026-09-01" }, settings));
    A.name = name;
    A.hook("fetch", fakeFetch(A));
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Boss','Admin','4321',?,1,?)", [A.api.currentBranch(), new Date().toISOString()]);
    return A;
  }
  const H1 = till("H1", { install_id:"HA01", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const H2 = till("H2", { install_id:"HA02", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE02", branch_type:"main" });
  const M1 = till("M1", { install_id:"MU01", shop_name:"Mandie Babyware", branch_name:"Murehwa", branch_id:"B-MUREHWA1", branch_type:"remote" });
  const M2 = till("M2", { install_id:"MU02", shop_name:"Mandie Babyware", branch_name:"Murehwa", branch_id:"B-MUREHWA2", branch_type:"remote" });

  await t("setup: Harare registers, T2 and Murehwa's two tills join with join codes (the app's own calls)", async ()=>{
    let r = await H1.api.registerMainBranch("Counter");
    assert.ok(r.ok, JSON.stringify(r));
    r = await H1.api.issueJoinCode({ branchId: H1.api.getSetting("branch_uuid","") });
    assert.ok((await H2.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Back" })).ok);
    r = await H1.api.issueJoinCode({ newBranchName:"Murehwa" });
    assert.ok((await M1.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Till 1", expectedBranchName:"Murehwa" })).ok);
    r = await H1.api.issueJoinCode({ branchId: M1.api.getSetting("branch_uuid","") });
    assert.ok((await M2.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Till 2", expectedBranchName:"Murehwa" })).ok);
    same([H1, H2, M1, M2].map((A)=> A.api.getSetting("till_code","")), ["T1", "T2", "T1", "T2"]);
    for(const A of [H1, H2, M1, M2]) assert.strictEqual(A.api.dsEnabled(), true);
  });

  // products: Harare has both; Murehwa has Sugar (from the catalogue) but not Rice
  const prod = (A, sku, name, stock, cost, cat)=> { A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,cost,created_ts,cat_uid) VALUES(?,?,?,?,?,?,?,?,?)", [name, 3, stock, 1, sku, A.api.currentBranch(), cost, new Date().toISOString(), cat || null]); A.api.recordStockMovement(A.api.one("SELECT id FROM products WHERE sku=?", [sku]).id, stock, { kind:"opening" }); };
  prod(H1, "SUG2", "Sugar 2kg", 50, 1.5, "cat-sugar"); prod(H1, "RIC5", "Rice 5kg", 100, 4);
  prod(H2, "SUG2", "Sugar 2kg", 20, 1.5, "cat-sugar");
  prod(M1, "S-2", "Sugar 2 kilo", 3, 1.4, "cat-sugar");
  prod(M2, "S-2", "Sugar 2 kilo", 0, 1.4, "cat-sugar");
  const stock = (A, sku)=> (A.api.one("SELECT stock FROM products WHERE sku=? AND branch=?", [sku, A.api.currentBranch()]) || {}).stock;
  const P = (A, sku)=> A.api.one("SELECT * FROM products WHERE sku=? AND branch=?", [sku, A.api.currentBranch()]);
  const ledgerOk = (A)=> assert.strictEqual(JSON.stringify(A.api.stockLedgerCheck().mismatches), "[]", A.name + ": stock = the sum of its movements");

  let D1;
  await t("a joined branch is a destination even before main adds it to the register", async ()=>{
    await H1.api.dsRefreshBranches();
    assert.ok(H1.api.branchDestinations().some((b)=> b.name === "Murehwa"));
    assert.strictEqual(H1.api.dsBranchFor("murehwa").name, "Murehwa");
    assert.strictEqual(H1.api.dsBranchFor("Harare"), null, "never its own branch");
  });

  await t("dispatching offline: stock leaves at once, the send waits; online it goes once, a second try changes nothing", async ()=>{
    H1.ctx.navigator.onLine = false;
    const mb = H1.api.dsBranchFor("Murehwa");
    const dn = H1.api.dnCommitDispatch({ branch:"Harare", toBranch:"Murehwa", now:new Date(), internalRef:"PO-7",
      lines:[{ product:P(H1, "SUG2"), qty:10 }, { product:P(H1, "RIC5"), qty:5 }], srv:{ toBranchId:mb.id, delivery:{ cost:12, currency:"usd", carrier:"Kombi", ref:"K-55" } } });
    assert.strictEqual(stock(H1, "SUG2"), 40); assert.strictEqual(stock(H1, "RIC5"), 95);
    const h = H1.api.dnHeaderFor(dn.n);
    assert.strictEqual(h.srv_status, "queued"); assert.strictEqual(H1.api.dsPending("send").length, 1);
    D1 = h.srv_id;
    assert.strictEqual(await H1.api.dsSendPending(), 0, "offline: nothing sent");
    H1.ctx.navigator.onLine = true;
    await Promise.all([H1.api.dsSendPending(), H1.api.dsSendPending()]);
    assert.strictEqual(H1.api.dnHeaderFor(dn.n).srv_status, "sent");
    assert.strictEqual((await q("select count(*)::int c from cl_dispatches"))[0].c, 1);
    const row = (await q("select delivery_cost::text, delivery_currency, from_legacy_branch_id, dn_display from cl_dispatches"))[0];
    assert.deepStrictEqual(row, { delivery_cost:"12.00", delivery_currency:"USD", from_legacy_branch_id:"B-HARARE01", dn_display:"DN-T1-0001" });
    const line = (await q("select cat_uid, code, unit_cost::float c from cl_dispatch_lines where line_no = 1"))[0];
    assert.deepStrictEqual(line, { cat_uid:"cat-sugar", code:"SUG2", c:1.5 }, "the catalogue uid and the cost travel with the line");
    ledgerOk(H1);
  });

  await t("both Murehwa tills see it in Incoming; the DN file is refused while it waits there", async ()=>{
    for(const A of [M1, M2]){ const r = await A.api.dsPull(); assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(A.api.dsIncomingWaiting().length, 1); }
    const msg = await M1.api.dsFileCheck({ from:{ branch_id:"B-HARARE01" }, dn_no:1 });
    assert.match(msg, /waiting in seiGEN dispatches \(Incoming\)/);
    assert.strictEqual(await M1.api.dsFileCheck({ from:{ branch_id:"B-OTHER001" }, dn_no:1 }), "");
  });

  await t("counting: a product missing here must be chosen or created (Admin passcode); bad counts are refused before anything is sent", async ()=>{
    const d = M1.api.dsCachedOne(D1);
    const counts = { 1:{ received:8, damaged:1, extra:0 }, 2:{ received:5, damaged:0, extra:2 } };
    const matches = { 1: M1.api.dsFindProduct(d.lines[0]).id };
    assert.match(M1.api.dsCountProblems(d, counts, matches).join(" "), /Rice 5kg: choose the product/);
    assert.match(M1.api.dsCountProblems(d, { 1:{ received:10, damaged:1, extra:0 }, 2:counts[2] }, matches).join(" "), /more than the 10 sent/);
    assert.throws(()=> M1.api.dsCreateProduct(d.lines[1], "6.50", "0000"), /Incorrect Admin passcode/);
    matches[2] = M1.api.dsCreateProduct(d.lines[1], "6.50", "4321");
    const rice = M1.api.one("SELECT * FROM products WHERE id=?", [matches[2]]);
    assert.strictEqual(rice.sku, "RIC5"); assert.strictEqual(rice.price, 6.5); assert.strictEqual(rice.stock, 0);
    same(M1.api.dsCountProblems(d, counts, matches), []);
    M1.counts = counts; M1.matches = matches;
  });

  await t("the answer is lost after the server took the GRV: nothing added yet; the retry adds the stock exactly once", async ()=>{
    dropAnswer = "cl_device_grv_post";
    const r = await M1.api.dsPostGrv(D1, M1.counts, M1.matches, { internalRef:"MU-1" });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.waiting, true);
    assert.strictEqual(stock(M1, "S-2"), 3, "no stock before the server's answer");
    assert.strictEqual((await q("select status from cl_dispatches"))[0].status, "received_diff", "the server did take it");
    const p = await M1.api.dsPull();
    assert.ok(p.ok);
    assert.strictEqual(stock(M1, "S-2"), 11, "3 + 8 received");
    assert.strictEqual(stock(M1, "RIC5"), 7, "5 received + 2 extra");
    await M1.api.dsPull();
    assert.strictEqual(stock(M1, "S-2"), 11, "a second pull changes nothing");
    assert.strictEqual(M1.api.dsPending("grv").length, 0);
    const h = M1.api.one("SELECT * FROM dispatch_docs WHERE direction='in' AND dispatch_branch_id='B-HARARE01' AND dn_no=1");
    assert.strictEqual(h.status, "received"); assert.strictEqual(h.grv_no, 1); assert.strictEqual(h.srv_status, "received_diff");
    ledgerOk(M1);
  });

  await t("landed cost: the USD 12 delivery spread by value over what came in, added to the unit cost (not split for the short one)", async ()=>{
    // value in: sugar 8 x 1.5 = 12, rice 7 x 4 = 28 -> sugar gets 12*12/40 = 3.60 (0.45 a unit), rice 8.40 (1.20 a unit)
    assert.strictEqual(P(M1, "S-2").cost, 1.95);
    assert.strictEqual(P(M1, "RIC5").cost, 5.2);
    const l = M1.api.dsLandedCosts({ delivery_cost:10, lines:[{ line_no:1, unit_cost:null }, { line_no:2, unit_cost:null }] }, { 1:{ received:1 }, 2:{ received:4 } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(l)), { 1:2, 2:2 }, "no costs: by units");
  });

  await t("the second Murehwa till is refused before any stock moves (first GRV wins)", async ()=>{
    const d = M2.api.dsCachedOne(D1);
    const r = await M2.api.dsPostGrv(D1, { 1:{ received:10, damaged:0, extra:0 }, 2:{ received:5, damaged:0, extra:0 } },
      { 1: M2.api.dsFindProduct(d.lines[0]).id, 2: M2.api.dsCreateProduct(d.lines[1], "6.50", "4321") });
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /already received as GRV-T1-0001 on till T1/);
    assert.strictEqual(stock(M2, "S-2"), 0); assert.strictEqual(stock(M2, "RIC5"), 0);
    assert.strictEqual(M2.api.dsPending("grv").length, 0);
    ledgerOk(M2);
  });

  await t("the sender's pull: short and damaged back in its stock, differences listed; only the dispatching till may act", async ()=>{
    await H1.api.dsPull(); await H2.api.dsPull();
    assert.strictEqual(stock(H1, "SUG2"), 42, "40 + 1 short + 1 damaged back");
    assert.strictEqual(stock(H2, "SUG2"), 20, "the other till's stock is untouched");
    const mine = H1.api.dsOpenIssues(), theirs = H2.api.dsOpenIssues();
    same(mine.map((x)=> x.i.kind + ":" + x.i.qty + ":" + x.mine).sort(), ["damaged:1:true", "extra:2:true", "short:1:true"]);
    assert.ok(theirs.length === 3 && theirs.every((x)=> !x.mine), "T2 sees them, read-only");
    const hd = H1.api.one("SELECT * FROM dispatch_docs WHERE srv_id=?", [D1]);
    assert.strictEqual(hd.status, "received"); assert.strictEqual(hd.srv_status, "received_diff");
    const short = theirs.find((x)=> x.i.kind === "short").i;
    const r = await H2.api.dsWriteOff(short.id, "lost in transit", "4321");
    assert.strictEqual(r.ok, false); assert.match(r.message, /Only the till that dispatched it \(T1\)/);
    assert.strictEqual(stock(H2, "SUG2"), 20);
    ledgerOk(H1); ledgerOk(H2);
  });

  await t("write off the shortage (ADJ, Admin passcode), confirm the extra; each once", async ()=>{
    const iss = H1.api.dsOpenIssues();
    const short = iss.find((x)=> x.i.kind === "short").i, extra = iss.find((x)=> x.i.kind === "extra").i;
    await assert.rejects(()=> H1.api.dsWriteOff(short.id, "lost", "9999"), /Incorrect Admin passcode/);
    const r = await H1.api.dsWriteOff(short.id, "lost in transit", "4321");
    assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.adj, "ADJ-T1-0001");
    assert.strictEqual(stock(H1, "SUG2"), 41);
    const adj = H1.api.one("SELECT * FROM stock_adjustments WHERE adj_no=1");
    assert.strictEqual(adj.qty_delta, -1); assert.strictEqual(adj.authorised_by, "Boss"); assert.strictEqual(adj.reason, "Lost in transit");
    await H1.api.dsResolveExtra(extra.id, "confirm", null, "4321");
    assert.strictEqual(stock(H1, "RIC5"), 93, "95 - 2 extra really sent");
    await H1.api.dsPull(); await H1.api.dsPull();
    assert.strictEqual(stock(H1, "SUG2"), 41); assert.strictEqual(stock(H1, "RIC5"), 93);
    ledgerOk(H1);
  });

  let D3;
  await t("re-dispatch the damaged unit (a new DN linked to it); cancelling that one brings the stock back and reopens the difference", async ()=>{
    const dmg = H1.api.dsOpenIssues().find((x)=> x.i.kind === "damaged").i;
    const dn = await H1.api.dsRedispatch(dmg.id);
    assert.strictEqual(dn.text, "DN-T1-0002");
    assert.strictEqual(stock(H1, "SUG2"), 40);
    assert.strictEqual(H1.api.dsOpenIssues().length, 0);
    D3 = H1.api.dnHeaderFor(dn.n).srv_id;
    await M1.api.dsPull();
    assert.strictEqual(M1.api.dsIncomingWaiting().length, 1);
    await assert.rejects(()=> H1.api.dsCancel(D1, "wrong", "4321"), /Already received as GRV-T1-0001/);
    await H1.api.dsCancel(D3, "Driver did not come", "4321");
    await H1.api.dsCancel(D3, "Driver did not come", "4321").catch(()=>{});
    assert.strictEqual(stock(H1, "SUG2"), 41, "the stock is back, once");
    assert.strictEqual(H1.api.dnHeaderFor(dn.n).status, "cancelled");
    await H1.api.dsPull();
    same(H1.api.dsOpenIssues().map((x)=> x.i.kind + ":" + x.i.status), ["damaged:open"]);
    await M1.api.dsPull();
    assert.strictEqual(M1.api.dsIncomingWaiting().length, 0, "gone from Incoming");
    const r = await M1.api.dsPostGrv(D3, { 1:{ received:1, damaged:0, extra:0 } }, { 1: P(M1, "S-2").id }).catch((e)=> ({ thrown:e.message }));
    assert.ok(r.thrown || (r.ok === false && /cancelled/.test(r.message)), JSON.stringify(r));
    assert.strictEqual(stock(M1, "S-2"), 11);
    ledgerOk(H1); ledgerOk(M1);
  });

  await t("a restored backup (everything since before the dispatch lost) is put right by the next pull, exactly once", async ()=>{
    const before = { sug:stock(H1, "SUG2"), ric:stock(H1, "RIC5") };
    // the restore: the ledger, documents and stock as they were before the first dispatch
    H1.api.run("DELETE FROM stock_movements WHERE kind<>'opening'");
    H1.api.run("DELETE FROM dispatch_docs"); H1.api.run("DELETE FROM stock_adjustments"); H1.api.run("DELETE FROM srv_dispatches");
    H1.api.run("UPDATE products SET stock=(SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements m WHERE m.product_id=products.id)");
    H1.api.run("UPDATE doc_counters SET last_no=0");
    assert.strictEqual(stock(H1, "SUG2"), 50);
    await H1.api.dsPull(); await H1.api.dsPull();
    assert.deepStrictEqual({ sug:stock(H1, "SUG2"), ric:stock(H1, "RIC5") }, before);
    assert.strictEqual(H1.api.one("SELECT last_no FROM doc_counters WHERE doc_type='DN'").last_no, 2, "the DN counter can't reuse a number the server has");
    assert.ok(H1.api.one("SELECT 1 AS x FROM dispatch_docs WHERE srv_id=?", [D1]), "the dispatch is back in the history");
    ledgerOk(H1);
    // the receiver too
    const mBefore = { sug:stock(M1, "S-2"), ric:stock(M1, "RIC5") };
    M1.api.run("DELETE FROM stock_movements WHERE kind<>'opening'"); M1.api.run("DELETE FROM dispatch_docs");
    M1.api.run("UPDATE products SET stock=(SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements m WHERE m.product_id=products.id)");
    await M1.api.dsPull(); await M1.api.dsPull();
    assert.deepStrictEqual({ sug:stock(M1, "S-2"), ric:stock(M1, "RIC5") }, mBefore);
    ledgerOk(M1);
  });

  await t("a DN this till already took in from the file: seiGEN is told, no stock moves, it leaves Incoming", async ()=>{
    const dn = H1.api.dnCommitDispatch({ branch:"Harare", toBranch:"Murehwa", now:new Date(), internalRef:"",
      lines:[{ product:P(H1, "SUG2"), qty:2 }], srv:{ toBranchId:H1.api.dsBranchFor("Murehwa").id, delivery:{} } });
    await H1.api.dsSendPending();
    // M2 received the file before it pulled (the old flow: its own GRV number, its own stock)
    const g = M2.api.reserveDocNumber("GRV");
    M2.api.run(`INSERT INTO dispatch_docs(dispatch_branch_id,dispatch_branch_name,dn_no,receive_branch_name,direction,grv_no,created_ts,status,grv_till_code,received_by)
                VALUES('B-HARARE01','Harare',?,'Murehwa','in',?,?,'received','T2','Chipo')`, [dn.n, g.n, new Date().toISOString()]);
    M2.api.run("UPDATE products SET stock=stock+2 WHERE sku='S-2'");
    M2.api.recordStockMovement(P(M2, "S-2").id, 2, { kind:"receive", docType:"grv" });
    await M2.api.dsPull();
    assert.strictEqual(stock(M2, "S-2"), 2, "no second receipt");
    const s = (await q("select status, grv_display from cl_dispatches where dn_no = $1 and from_legacy_branch_id = 'B-HARARE01'", [dn.n]))[0];
    assert.deepStrictEqual(s, { status:"received", grv_display:"GRV-T2-0002" }, "GRV-T2-0001 was spent by its refused try earlier: a number is skipped, never reused");
    await M1.api.dsPull();
    assert.strictEqual(M1.api.dsIncomingWaiting().length, 0, "the other till doesn't offer it either");
    ledgerOk(M2);
  });

  await t("a shared-stock till keeps the file flow", async ()=>{
    H2.api.setSetting("stock_mode", "shared"); H2.api.setSetting("stock_init", "1");
    assert.strictEqual(H2.api.dsEnabled(), false);
    assert.strictEqual(H2.api.dsBranchFor("Murehwa"), null);
    H2.api.setSetting("stock_mode", ""); H2.api.setSetting("stock_init", "");
  });

  await t("every till's stock still equals its ledger; nothing sent twice", async ()=>{
    for(const A of [H1, H2, M1, M2]) ledgerOk(A);
    assert.strictEqual((await q("select count(*)::int c from cl_dispatches"))[0].c, 3);
    assert.strictEqual((await q("select count(*)::int c from cl_interbranch_charges"))[0].c, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
