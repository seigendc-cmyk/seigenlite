// node test/branch-stock.test.js
//
// Branches B1: stock by branch (docs/branches/multi-branch-visibility-design.md;
// owner 2026-10-13: "Add up the tills, show each till's own figure under the
// branch total on main, and show the amber warning when tills look like copies
// of the same list"). Tills running the REAL app code (test/harness.js, JSDOM
// for the screens) against the REAL server SQL in PGlite (the live shape +
// 20261024120000_branch_stock), never the live database:
//   - one join links a till to every branch: the branch list arrives at once,
//     and the Product List offers a joined branch with no merged rows here;
//   - Harare T1 + T2 + Murehwa T1: each sends its own figures; a branch is the
//     sum of its tills; main sees each till's own count, remotes don't;
//   - after a sale only the changed product is sent; a retry or an old backup
//     never counts twice; offline sends nothing; a single-till shop sends
//     nothing and asks again only after 6 hours;
//   - sending and reading never change a till's own stock or its ledger;
//   - the copies warning; value at main's own cost; no cost ever reaches a
//     remote (stock, dispatches, the screens).
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
const same = (a, b, m)=> assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 5).join("\n       ")); }
}
const hex = ()=> require("crypto").randomBytes(16).toString("hex");

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== "20261024120000_branch_stock.sql") });   // the live shape + B1
  let lock = Promise.resolve();
  const serial = (fn)=>{ const run = lock.then(fn, fn); lock = run.catch(()=>{}); return run; };
  const q = (sql, p)=> serial(async ()=> (await pg.query(sql, p)).rows);
  const calls = [];
  async function rpcNow(fn, body){
    const names = Object.keys(body);
    const args = names.map((n)=> (body[n] !== null && typeof body[n] === "object") ? JSON.stringify(body[n]) : body[n]);
    const sql = `select to_json(public.${fn}(${names.map((n, i)=> `${n}=>$${i + 1}`).join(", ")})) j`;
    await pg.exec("set role anon");
    try{ return { status:200, body: JSON.stringify((await pg.query(sql, args)).rows[0].j) }; }
    catch(e){ return { status:400, body: JSON.stringify({ message: e.message }) }; }
    finally{ await pg.exec("reset role"); }
  }
  function till(name, settings, phrase){
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:phrase||"Mandie Phrase", install_date:"2026-09-01" }, settings), { dom:true });
    A.name = name;
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      calls.push({ till:name, fn:m[1], body:opts.body });
      const r = await serial(()=> rpcNow(m[1], JSON.parse(opts.body)));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Boss','Admin','4321',?,1,?)", [A.api.currentBranch(), new Date().toISOString()]);
    return A;
  }
  const H1 = till("H1", { install_id:"HA01", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const H2 = till("H2", { install_id:"HA02", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE02", branch_type:"main" });
  const M1 = till("M1", { install_id:"MU01", shop_name:"Mandie Babyware", branch_name:"Murehwa", branch_id:"B-MUREHWA1", branch_type:"remote" });
  const S1 = till("S1", { install_id:"SO01", shop_name:"Solo Shop", branch_name:"Mbare", branch_id:"B-MBARE001", branch_type:"main" }, "Solo Phrase");

  // the same catalogue products on every till (as the catalogue sync leaves them), plus one of Harare's own
  const CAT = { bib:hex(), cap:hex(), sock:hex(), hat:hex(), mitt:hex(), vest:hex() };
  const add = (A, name, sku, stock, cost, cat)=> A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description,cat_uid) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    [name, 5, stock, 2, sku, A.api.currentBranch(), "", cost, "2026-10-01", "", cat||null]);
  const stockOf = (A, sku)=> A.api.one("SELECT stock FROM products WHERE sku=?", [sku]).stock;
  const ledger = (A)=> A.api.one("SELECT COUNT(*) n, COALESCE(SUM(qty_delta),0) s FROM stock_movements").n + "/" + A.api.one("SELECT COALESCE(SUM(stock),0) s FROM products").s;
  add(H1, "Bib", "BIB1", 10, 2.5, CAT.bib); add(H1, "Cap", "CAP1", 4, 1, CAT.cap); add(H1, "Rattle", "OWN1", 3, 1, null);
  add(H2, "Bib", "BIB1", 4, 0, CAT.bib);
  add(M1, "Bib", "BIB1", 7, 0, CAT.bib); add(M1, "Cap", "CAP1", 1, 0, CAT.cap);
  add(S1, "Bread", "BRD1", 9, 1, null);

  await t("one join links a till to the whole business: Harare registers, Harare T2 and Murehwa T1 join with join codes", async ()=>{
    let r = await H1.api.registerMainBranch("Counter");
    assert.ok(r.ok, JSON.stringify(r));
    r = await H1.api.issueJoinCode({ branchId: H1.api.getSetting("branch_uuid",""), seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await H2.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Back" })).ok);
    r = await H1.api.issueJoinCode({ newBranchName:"Murehwa", seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await M1.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Till 1", expectedBranchName:"Murehwa" })).ok);
    assert.ok((await S1.api.registerMainBranch("Counter")).ok);
    same([H1, H2, M1].map((A)=> A.api.getSetting("till_code","")), ["T1", "T2", "T1"]);
  });

  const before = {};
  await t("each till sends its own figures (all of them the first time); its own stock and ledger don't change", async ()=>{
    [H1, H2, M1].forEach((A)=>{ before[A.name] = ledger(A); });
    for(const A of [H1, H2, M1]){
      const r = await A.api.bsPush();
      assert.ok(r.ok && r.enabled === true && r.full === true, A.name + " " + JSON.stringify(r));
    }
    same((await q(`select t.till_code, count(*)::int n from cl_till_stock_levels l join cl_terminals t on t.id = l.terminal_id group by t.till_code, t.branch_id order by 1, 2`)).map((x)=> x.n).sort(), [1, 2, 3]);
    [H1, H2, M1].forEach((A)=> assert.strictEqual(ledger(A), before[A.name], A.name + "'s stock and ledger"));
    assert.strictEqual(H1.api.getSetting("bs_enabled",""), "1");
  });

  await t("a single-till shop sends nothing, and doesn't ask again for 6 hours", async ()=>{
    let r = await S1.api.bsPush();
    assert.ok(r.ok && r.enabled === false, JSON.stringify(r));
    assert.strictEqual(S1.api.getSetting("bs_enabled",""), "0");
    const n = calls.filter((c)=> c.till === "S1" && c.fn === "cl_device_stock_levels_push").length;
    r = await S1.api.bsPush();
    assert.strictEqual(r.skipped, "single till");
    assert.strictEqual(calls.filter((c)=> c.till === "S1" && c.fn === "cl_device_stock_levels_push").length, n, "no call");
    assert.strictEqual((await q(`select count(*)::int n from cl_till_stock_levels l join cl_terminals t on t.id = l.terminal_id where t.install_id = 'SO01'`))[0].n, 0);
  });

  await t("main reads every branch: Harare's Bib = T1 10 + T2 4 = 14, each till's own count; Murehwa's 7", async ()=>{
    const r = await H1.api.bsPull();
    assert.ok(r.ok && r.enabled && r.branches === 2, JSON.stringify(r));
    const br = H1.api.bsBranches();
    same(br.map((b)=> b.name), ["Harare", "Murehwa"]);
    const bib = H1.api.bsRowFor(br[0], { cat_uid:CAT.bib, sku:"BIB1", name:"Bib" });
    same({ qty:bib.qty, t:bib.t }, { qty:14, t:{ T1:10, T2:4 } });
    assert.strictEqual(H1.api.bsRowFor(br[1], { cat_uid:CAT.bib }).qty, 7);
    assert.strictEqual(H1.api.bsRowFor(br[0], { sku:"OWN1", name:"Rattle" }).qty, 3, "Harare's own product, matched by code");
  });

  await t("Products on main: an 'Other branches' column (Bib 7, Cap 1); tapping it shows each branch, its time and each till's count", async ()=>{
    assert.strictEqual(H1.api.bsShowOtherColumn(), true);
    const p = H1.api.one("SELECT * FROM products WHERE sku='BIB1'");
    assert.strictEqual(H1.api.bsOtherQty(p), 7, "the other branches only");
    assert.strictEqual(H1.api.bsOtherQty(H1.api.one("SELECT * FROM products WHERE sku='OWN1'")), null, "no other branch has the rattle");
    const html = H1.api.productsTableHtml(H1.api.all("SELECT * FROM products ORDER BY name"), false);
    assert.match(html, /Other branches/); assert.match(html, /data-bsprod="\d+"[^>]*>7</);
    H1.api.openBsProductModal(p);
    const txt = H1.dom.window.document.querySelector(".modalOverlay").textContent.replace(/\s+/g, " ");
    assert.match(txt, /All branches ?21/); assert.match(txt, /Harare \(this branch\) ?14/); assert.match(txt, /T1 \(this till, now\): 10/); assert.match(txt, /T2 \(own count\): 4/);
    assert.match(txt, /Murehwa ?7/); assert.match(txt, /updated \d{1,2}:\d\d/); assert.match(txt, /the sum of its tills/);
    H1.dom.window.document.querySelectorAll(".modalOverlay").forEach((m)=> m.remove());
    assert.strictEqual(M1.api.bsShowOtherColumn(), false, "a remote that hasn't read the branches yet: no column (it has one at every branch once it has: addendum §R5)");
  });

  await t("More → Stock by branch on main: the grid, each till's count, value at main's cost", async ()=>{
    const el = H1.dom.window.document.createElement("div");
    H1.api.setSetting("bs_pulled_ts", new Date().toISOString());     // fresh: the screen doesn't reload by itself
    H1.api.renderBranchStock(el);
    const txt = el.textContent.replace(/\s+/g, " ");
    assert.match(txt, /All branches/); assert.match(txt, /Harare \(this\)/); assert.match(txt, /Murehwa/);
    assert.match(el.querySelector(".bs-tills").textContent, /T1: 10 · T2: 4/);
    // Murehwa: Bib 7 × 2.50 + Cap 1 × 1.00 = 18.50 (main's own costs)
    assert.match(el.querySelector(".bs-value").textContent, /Murehwa: value at cost \$18\.50/);
    assert.strictEqual(H1.api.bsValueAtCost(H1.api.bsBranches()[1]).value, 18.5);
    assert.ok(H1.api.bsTabAvailable());
  });

  await t("a sale on Harare T2: only the changed product goes; main sees 13 after its next read", async ()=>{
    H2.api.run("UPDATE products SET stock=stock-1 WHERE sku='BIB1'");       // (as moveStock leaves it)
    const n0 = calls.length;
    const r = await H2.api.bsPush();
    assert.ok(r.ok && r.sent === 1 && !r.full, JSON.stringify(r));
    assert.strictEqual(JSON.parse(calls.slice(n0).find((c)=> c.fn === "cl_device_stock_levels_push").body).p_rows.length, 1);
    const again = await H2.api.bsPush();
    assert.ok(again.ok && again.sent === 0, "nothing changed: no call: " + JSON.stringify(again));
    await H1.api.bsPull();
    assert.strictEqual(H1.api.bsRowFor(H1.api.bsBranches()[0], { cat_uid:CAT.bib }).qty, 13);
  });

  await t("a restored old backup (an older figure, sent again) is the till's figure now: overwritten, never added", async ()=>{
    H2.api.run("UPDATE products SET stock=4 WHERE sku='BIB1'");          // the backup's figure
    H2.api.run("DELETE FROM bs_sent");                                    // a restore brings no record of what was sent
    const r = await H2.api.bsPush();
    assert.ok(r.ok && r.full, JSON.stringify(r));
    await H1.api.bsPull();
    assert.strictEqual(H1.api.bsRowFor(H1.api.bsBranches()[0], { cat_uid:CAT.bib }).qty, 14, "10 + 4, not 10 + 3 + 4");
  });

  await t("offline: nothing is sent and nothing read; back online, the change goes", async ()=>{
    M1.ctx.navigator.onLine = false;
    M1.api.run("UPDATE products SET stock=6 WHERE sku='BIB1'");
    assert.strictEqual((await M1.api.bsPush()).skipped, "offline");
    assert.ok((await M1.api.bsPull()).offline);
    M1.ctx.navigator.onLine = true;
    assert.ok((await M1.api.bsPush()).sent === 1);
  });

  await t("the copies warning: Harare T1 and T2 showing the same figures for most products", async ()=>{
    const br0 = H1.api.bsBranches()[0];
    assert.strictEqual(H1.api.bsCopies(br0).length, 0, "not now (Bib 10 vs 4)");
    // T2 loaded with the same list as T1
    for(const [n, k, s, c] of [["Cap","CAP1",4,CAT.cap],["Sock","SOCK",6,CAT.sock],["Hat","HAT1",2,CAT.hat],["Mitt","MIT1",8,CAT.mitt],["Vest","VST1",5,CAT.vest]]){
      if(!H2.api.one("SELECT 1 x FROM products WHERE sku=?",[k])) add(H2, n, k, s, 0, c);
      if(!H1.api.one("SELECT 1 x FROM products WHERE sku=?",[k])) add(H1, n, k, s, 1, c);
    }
    await H1.api.bsPush(); await H2.api.bsPush(); await H1.api.bsPull();
    const w = H1.api.bsCopies(H1.api.bsBranches()[0]);
    same(w, [{ a:"T1", b:"T2", same:5, of:6 }]);
    const el = H1.dom.window.document.createElement("div");
    H1.api.setSetting("bs_pulled_ts", new Date().toISOString());
    H1.api.renderBranchStock(el);
    assert.match(el.querySelector(".bs-copies").textContent, /Harare: T1 and T2 look like copies of the same stock list.*may count those products twice/s);
  });

  await t("a remote: More → Other branches, quantities only: no till counts, no value, no cost anywhere", async ()=>{
    const r = await M1.api.bsPull();
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(M1.api.bsTabAvailable());
    same(M1.api.bsOtherBranches().map((b)=> b.name), ["Harare"]);
    const h = M1.api.bsOtherBranches()[0];
    assert.strictEqual(M1.api.bsRowFor(h, { cat_uid:CAT.bib }).qty, 14);
    assert.strictEqual(M1.api.bsRowFor(h, { cat_uid:CAT.bib }).t, null, "no till figures");
    assert.strictEqual(h.tills, null);
    const el = M1.dom.window.document.createElement("div");
    M1.api.setSetting("bs_pulled_ts", new Date().toISOString());
    M1.api.renderBranchStock(el);
    const txt = el.textContent.replace(/\s+/g, " ");
    assert.match(txt, /All other branches/); assert.match(txt, /Harare/); assert.doesNotMatch(txt, /Murehwa \(this\)/);
    assert.doesNotMatch(txt, /value at cost|T1: |\$/); assert.match(txt, /costs are kept on the main branch/);
  });

  await t("a remote's dispatch list: Harare's dispatch to Murehwa, with no unit or delivery cost", async ()=>{
    const p = H1.api.one("SELECT * FROM products WHERE sku='BIB1'");
    H1.api.dnCommitDispatch({ branch:"Harare", toBranch:"Murehwa", now:new Date(), lines:[{ product:p, qty:2 }],
      srv:{ toBranchId: M1.api.getSetting("branch_uuid",""), delivery:{ cost:4.56, currency:"USD" } } });
    await H1.api.dsSendPending();
    const r = await M1.api.bsPullDispatches();
    assert.ok(r.ok && r.count === 1, JSON.stringify(r));
    const raw = M1.api.getSetting("bs_dispatches","");
    assert.doesNotMatch(raw, /cost|charge|4\.56|2\.5/i, raw);
    const d = M1.api.bsDispatches()[0];
    assert.strictEqual(d.from_branch, "Harare"); assert.strictEqual(d.lines[0].qty, 2); assert.strictEqual(d.status, "sent");
    const el = M1.dom.window.document.createElement("div");
    M1.api.setSetting("bs_tab", "dispatches"); M1.api.setSetting("bs_dispatches_ts", new Date().toISOString());
    M1.api.renderBranchStock(el);
    assert.match(el.textContent.replace(/\s+/g, " "), /Harare → Murehwa.*1 line · 2 units/);
    M1.api.setSetting("bs_tab", "stock");
  });

  await t("the joining fix: the Product List on main offers Murehwa (stock from seiGEN) with no merged file", async ()=>{
    assert.ok(!H1.api.all("SELECT DISTINCT branch FROM products").some((r)=> r.branch === "Murehwa"), "no Murehwa rows here");
    same(H1.api.bsJoinedOnlyBranchNames(["Harare"]), ["Murehwa"]);
    const el = H1.dom.window.document.createElement("div");
    H1.dom.window.document.body.appendChild(el);              // the list reads its inputs by id
    H1.api.renderProductList(el);
    assert.match(el.querySelector("#plistBranchSel").textContent, /Murehwa \(stock from seiGEN\)/);
    H1.api.setPlistBranch("Murehwa");
    const rows = H1.api.plistResults();
    same(rows.map((r)=> [r.name, r.stock]).sort(), [["Bib", 6], ["Cap", 1]]);
    H1.api.renderProductList(el);
    assert.match(el.querySelector("#plistResults").textContent.replace(/\s+/g, " "), /Bib.*Murehwa.*—.*6/);
    H1.api.setPlistBranch("");
  });

  await t("never a till's own numbers: sending and reading left every till's stock and ledger as the app left them", async ()=>{
    // H2 and M1 had stock edits above (outside moveStock), so compare the ledger counts only
    for(const A of [H1, H2, M1]) assert.strictEqual(A.api.one("SELECT COUNT(*) n FROM stock_movements WHERE kind NOT IN ('dispatch')").n,
      Number(before[A.name].split("/")[0]), A.name + ": no movement added by B1");
    assert.strictEqual(stockOf(H1, "BIB1"), 8, "Harare T1: 10 − 2 dispatched");
  });

  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
