// node test/billing-b.test.js
//
// Billing-B and the Chipo Clothing merge, end to end: tills running the REAL
// app code (test/harness.js) against the REAL server SQL in PGlite, never the
// live database. Before 20261021120000 the two Chipo tills register the same
// business twice (as on live); then, with the migration: a third device is
// refused with the plain message, Harare CBD's Delivery Notes to Sothleapark
// say "file only" and why, the merge (cl_business_merge_core, as the data fix
// runs it), Sothleapark's till follows its new business at its next check-in
// (remote branch, full catalogue pull), and Harare CBD -> Sothleapark then
// goes through seiGEN.
"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");
let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); }
}
async function waitFor(cond, what){
  const deadline = Date.now() + 10000;
  while(!(await cond())){ if(Date.now() > deadline) throw new Error("timed out waiting for " + what); await new Promise((r)=> setTimeout(r, 50)); }
}
(async ()=>{
  const MIG = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20261021120000_billing_b.sql"), "utf8");
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat(["20261021120000_billing_b.sql"]) });   // the live shape without Billing-B, as when the Chipo tills registered
  const q = async (sql, p)=> (await pg.query(sql, p)).rows;
  async function rpc(fn, body){
    const names = Object.keys(body);
    const args = names.map((n)=> (body[n] !== null && typeof body[n] === "object") ? JSON.stringify(body[n]) : body[n]);
    const sql = `select to_json(public.${fn}(${names.map((n, i)=> `${n}=>$${i + 1}`).join(", ")})) j`;
    await pg.exec("set role anon");
    try{ return { status:200, body: JSON.stringify((await pg.query(sql, args)).rows[0].j) }; }
    catch(e){ return { status:400, body: JSON.stringify({ message: e.message }) }; }
    finally{ await pg.exec("reset role"); }
  }
  function till(name, settings){
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:"Chipo Phrase", shop_name:"Chipo Clothing", install_date:"2026-09-01", branch_type:"main" }, settings));
    A.name = name;
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      const r = await rpc(m[1], JSON.parse(opts.body));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Chipo','Admin','4321',?,1,?)", [A.api.currentBranch(), new Date().toISOString()]);
    return A;
  }
  const H = till("Harare", { install_id:"HG58", branch_name:"Harare CBD", branch_id:"B-HARARECB" });
  const S = till("Sothleapark", { install_id:"2KBZ", branch_name:"Sothleapark", branch_id:"B-SOTHLEAP" });
  const P = (A, sku)=> A.api.one("SELECT * FROM products WHERE sku=? AND branch=?", [sku, A.api.currentBranch()]);
  A_prod(H, "PNT001", "Pants", 20);
  function A_prod(A, sku, name, stock){ A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,cost,created_ts) VALUES(?,?,?,?,?,?,?,?)", [name, 5, stock, 1, sku, A.api.currentBranch(), 2, new Date().toISOString()]); A.api.recordStockMovement(P(A, sku).id, stock, { kind:"opening" }); }
  // Harare CBD's own list of destination branches (as on live: Sothleapark typed in by hand)
  H.api.run("INSERT INTO branch_register(name) VALUES('Sothleapark')");

  let HBIZ, SBIZ, preMergeDn;
  await t("before Billing-B: both Chipo tills register Chipo Clothing, so seiGEN has two businesses (the live case)", async ()=>{
    const a = await H.api.registerMainBranch(null), b = await S.api.registerMainBranch(null);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    HBIZ = H.api.getSetting("business_id", ""); SBIZ = S.api.getSetting("business_id", "");
    assert.ok(HBIZ && SBIZ && HBIZ !== SBIZ);
    for(const [biz, code, name] of [[HBIZ, "pnt001", "Pants"], [SBIZ, "kds003", "Kids dress"], [SBIZ, "lmd001", "Ladies top"], [SBIZ, "mb005", "Men belt"]])
      await q(`insert into cl_catalogue_products (business_id, product_uid, code, name, price, cost, low_threshold, active, change_seq, last_op_id, updated_ts)
               values ($1, replace(gen_random_uuid()::text, '-', ''), $2, $3, 5, 2, 0, true, nextval('cl_catalogue_seq'), 'test-op', now())`, [biz, code, name]);
  });

  await pg.exec(MIG);

  await t("with Billing-B: a third device registering Chipo Clothing is refused, and told to join with a code", async ()=>{
    const C = till("Avondale", { install_id:"CH03", branch_name:"Avondale", branch_id:"B-AVONDALE" });
    const r = await C.api.registerMainBranch(null);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, "DUPLICATE_BUSINESS");
    const text = C.api.terminalProblemText(r);
    assert.match(text, /^Chipo Clothing is already registered on seiGEN from another device \(main branch: Harare CBD\)\. If this device is another branch or till of it, join with a join code/);
    assert.strictEqual(C.api.getSetting("terminal_id", ""), "", "not registered");
    assert.strictEqual((await q("select count(*)::int c from cl_businesses where name = 'Chipo Clothing'"))[0].c, 2, "no third business");
  });

  await t("Harare CBD -> Sothleapark: the Dispatch dialog says FILE ONLY and why; the Delivery Note has no seiGEN id", async ()=>{
    await H.api.dsRefreshBranches();
    assert.strictEqual(H.api.dsBranchFor("Sothleapark"), null, "not a branch of this business on seiGEN");
    assert.match(H.api.dsFileOnlyReason("Sothleapark"), /^Sothleapark isn't a branch of Chipo Clothing on seiGEN, so this Delivery Note won't go through seiGEN: it won't show in their Incoming dispatches\. Share the file with them\. To fix this, Sothleapark joins Chipo Clothing with a join code/);
    assert.strictEqual(H.api.dsFileOnlyReason("Sothleapark", { short:true }), "Sothleapark isn't a branch of Chipo Clothing on seiGEN.");
    assert.strictEqual(H.api.dsFileOnlyReason(""), "", "nothing until a branch is chosen");
    const dn = H.api.dnCommitDispatch({ branch:"Harare CBD", toBranch:"Sothleapark", now:new Date(), lines:[{ product:P(H, "PNT001"), qty:2 }], srv:null });
    assert.ok(!H.api.dnHeaderFor(dn.n).srv_id, "file only");
    preMergeDn = dn.n;
    assert.strictEqual((await q("select count(*)::int c from cl_dispatches"))[0].c, 0);
  });

  await t("an unregistered till: every Delivery Note is file only, and the note says so", async ()=>{
    const U = till("Unregistered", { install_id:"UN01", branch_name:"Mbare", branch_id:"B-MBARE001" });
    assert.match(U.api.dsFileOnlyReason("Harare CBD"), /^This till isn't registered with seiGEN, so Delivery Notes go by file only: share the file with Harare CBD\./);
  });

  await t("the merge (as the data fix runs it): Sothleapark becomes a branch of Harare CBD's business", async ()=>{
    const r = (await q(`select public.cl_business_merge_core($1, $2, 'Sothleapark is a branch of Chipo Clothing (owner, 2026-10-13)', true, null) j`, [SBIZ, HBIZ]))[0].j;
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.branches_now, "Harare CBD, Sothleapark");
  });

  await t("Sothleapark's next check-in: the till follows its new business (a remote branch now; full catalogue pull)", async ()=>{
    S.api.setSetting("cat_cursor", "999999");
    assert.strictEqual(S.api.getSetting("terminal_is_main", ""), "1");
    await S.api.deviceCheckin();
    await waitFor(async ()=> S.api.getSetting("business_id", "") === HBIZ, "the new business");
    assert.strictEqual(S.api.getSetting("terminal_is_main", ""), "", "its branch isn't main any more");
    assert.strictEqual(S.api.getSetting("branch_type", ""), "remote", "a remote branch on this till too");
    assert.strictEqual(S.api.getSetting("cat_cursor", ""), "0", "the whole catalogue again");
    assert.strictEqual(S.api.getSetting("terminal_branch_name", ""), "Sothleapark");
    assert.match(S.api.one("SELECT details FROM audit_log WHERE action='Business changed on seiGEN'").details, /Now a branch \(Sothleapark\) of Chipo Clothing/);
    assert.strictEqual(await S.api.terminalFollowBusiness(HBIZ), false, "the same business again: nothing to do");
    const c = await S.api.catalogueSyncNow({});
    assert.ok(c.ok, JSON.stringify(c));
    assert.strictEqual(JSON.stringify(S.api.all("SELECT sku FROM products WHERE cat_uid IS NOT NULL ORDER BY sku").map((p)=> p.sku.toLowerCase())), JSON.stringify(["kds003", "lmd001", "mb005", "pnt001"]));   // across the app's vm realm
  });

  const pants = (A)=> A.api.one("SELECT * FROM products WHERE lower(sku)='pnt001' AND branch=?", [A.api.currentBranch()]);
  await t("the Delivery Note sent by file before the merge stays file only; Sothleapark receives it with the file (Pants now in its catalogue: 0 -> 2)", async ()=>{
    const h = H.api.dnHeaderFor(preMergeDn);
    assert.ok(h && !h.srv_id, "still file only");
    const { text } = await H.api.dnBuildFromDb(h);
    const chk = await S.api.receiveCheckBytes(new Uint8Array(Buffer.from(text, "utf8")));
    assert.strictEqual(chk.res.ok, true, chk.res.message);
    const before = pants(S).stock;
    assert.strictEqual(before, 0, "came from the catalogue pull, with no stock");
    S.api.commitReceive(chk.res.doc, new Date());
    assert.strictEqual(pants(S).stock, 2);
    assert.strictEqual(pants(H).stock, 18, "Harare CBD's stock went down when it dispatched, not again");
    assert.strictEqual((await q("select count(*)::int c from cl_dispatches"))[0].c, 0, "nothing on seiGEN");
  });

  // The undo file (supabase/data-fixes/20261021_chipo_merge_undo.sql), with this database's ids.
  const undoSql = ()=> fs.readFileSync(path.join(__dirname, "..", "supabase", "data-fixes", "20261021_chipo_merge_undo.sql"), "utf8")
    .split("95f0ba44-4041-4e6e-ac52-3516902d20e0").join(HBIZ).split("7c47d0ea-ced3-4297-9c38-1c15fb24ac07").join(SBIZ)
    .split("07930efd-f41f-461d-a227-897c58956b46").join(S.api.getSetting("branch_uuid", "")).split("f1a153a3-9e3c-4021-a41d-a0ba46b235b1").join(H.api.getSetting("branch_uuid", ""));
  await t("the undo: Sothleapark's next check-in makes it a main branch of its own business again; its products and stock stay", async ()=>{
    const nProducts = S.api.one("SELECT count(*) c FROM products").c, stockBefore = JSON.stringify(S.api.all("SELECT sku, stock FROM products ORDER BY sku"));
    await pg.exec(undoSql());
    await S.api.deviceCheckin();
    await waitFor(async ()=> S.api.getSetting("business_id", "") === SBIZ, "the old business again");
    assert.strictEqual(S.api.getSetting("terminal_is_main", ""), "1");
    assert.strictEqual(S.api.getSetting("branch_type", ""), "main", "a main branch on this till again");
    assert.match(S.api.one("SELECT details FROM audit_log WHERE action='Business changed on seiGEN' ORDER BY id DESC").details, /Now the main branch \(Sothleapark\) of Chipo Clothing/);
    assert.strictEqual(S.api.one("SELECT count(*) c FROM products").c, nProducts, "nothing removed on the till");
    assert.strictEqual(JSON.stringify(S.api.all("SELECT sku, stock FROM products ORDER BY sku")), stockBefore, "stock unchanged");
    // ... and the merge again (as the data fix would), so the rest runs on the merged business
    const r = (await q(`select public.cl_business_merge_core($1, $2, 'again', true, null) j`, [SBIZ, HBIZ]))[0].j;
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    await S.api.deviceCheckin();
    await waitFor(async ()=> S.api.getSetting("business_id", "") === HBIZ, "the merged business again");
    assert.strictEqual(S.api.getSetting("branch_type", ""), "remote");
  });

  await t("Harare CBD -> Sothleapark now goes through seiGEN: no file-only note, sent, and waiting in Sothleapark's Incoming", async ()=>{
    H.api.setSetting("ds_branches_ts", "");
    await H.api.dsRefreshBranches();
    const sb = H.api.dsBranchFor("Sothleapark");
    assert.ok(sb && !sb.is_main, JSON.stringify(sb));
    assert.strictEqual(H.api.dsFileOnlyReason("Sothleapark"), "");
    const dn = H.api.dnCommitDispatch({ branch:"Harare CBD", toBranch:"Sothleapark", now:new Date(), lines:[{ product:P(H, "PNT001"), qty:3 }], srv:{ toBranchId:sb.id, delivery:{} } });
    await H.api.dsSendPending();
    assert.strictEqual(H.api.dnHeaderFor(dn.n).srv_status, "sent");
    const r = await S.api.dsPull();
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(S.api.dsIncomingWaiting().length, 1);
    assert.strictEqual(H.api.dsFileOnlyReason("Sothleapark", { short:true }), "", "the earlier file-only DN's line now just says file only, without the old reason");
  });

  await t("once a dispatch went through seiGEN between them, the undo file refuses and changes nothing", async ()=>{
    let err = "";
    try{ await pg.exec(undoSql()); }catch(e){ err = e.message; await pg.exec("rollback").catch(()=>{}); }
    assert.match(err, /since the merge, Chipo Clothing has 1 dispatches/);
    assert.strictEqual((await q("select business_id from cl_branches where id = $1", [S.api.getSetting("branch_uuid", "")]))[0].business_id, HBIZ);
  });

  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
