// node test/branches-addendum.test.js
//
// Branches addendum step 1 (app v25; docs/branches/multi-branch-visibility-design.md
// §R1, §R2, §R5, §R7; owner 2026-10-14). Tills running the REAL app code
// (test/harness.js, JSDOM for the screens) against the REAL server SQL in PGlite
// (the live shape + 20261024120000_branch_stock), never the live database:
//   - bug A: More → Product List "All branches" = the sum over 3 branches (Harare
//     T1 5 + T2 3, Norton 7, Murehwa 0) = 15, not this till's own 5; a sale here
//     shows at once; a stale file copy of Norton is ignored; a file-merge-only
//     "Bulawayo" is listed as "File copy from <date>", never counted;
//   - one search rule (textMatches) on every screen listed: any order, words by
//     their start, whole numbers, phones, dates, DN fields and line products;
//   - the other branches' stock at every branch (a remote's Products columns;
//     Sell's line on a tap);
//   - Stocktake: this branch only, other branches read-only, an old stocktake of
//     a file copy can't be counted or applied.
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
const same = (a, b, m)=> assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); }
}
const hex = ()=> require("crypto").randomBytes(16).toString("hex");
const flat = (s)=> String(s).replace(/\s+/g, " ");

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== "20261024120000_branch_stock.sql") });
  let lock = Promise.resolve();
  const serial = (fn)=>{ const run = lock.then(fn, fn); lock = run.catch(()=>{}); return run; };
  async function rpcNow(fn, body){
    const names = Object.keys(body);
    const args = names.map((n)=> (body[n] !== null && typeof body[n] === "object") ? JSON.stringify(body[n]) : body[n]);
    const sql = `select to_json(public.${fn}(${names.map((n, i)=> `${n}=>$${i + 1}`).join(", ")})) j`;
    await pg.exec("set role anon");
    try{ return { status:200, body: JSON.stringify((await pg.query(sql, args)).rows[0].j) }; }
    catch(e){ return { status:400, body: JSON.stringify({ message: e.message }) }; }
    finally{ await pg.exec("reset role"); }
  }
  function till(name, settings){
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:"Ivo Phrase", install_date:"2026-09-01" }, settings), { dom:true });
    A.name = name;
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      const r = await serial(()=> rpcNow(m[1], JSON.parse(opts.body)));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Boss','Admin','4321',?,1,?)", [A.api.currentBranch(), new Date().toISOString()]);
    return A;
  }
  const H1 = till("H1", { install_id:"IV01", shop_name:"IVO Motor Spares", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const H2 = till("H2", { install_id:"IV02", shop_name:"IVO Motor Spares", branch_name:"Harare", branch_id:"B-HARARE02", branch_type:"main" });
  const N1 = till("N1", { install_id:"IV03", shop_name:"IVO Motor Spares", branch_name:"Norton", branch_id:"B-NORTON01", branch_type:"remote" });
  const M1 = till("M1", { install_id:"IV04", shop_name:"IVO Motor Spares", branch_name:"Murehwa", branch_id:"B-MUREHWA1", branch_type:"remote" });

  const CAT = { pad:hex(), oil:hex(), plug:hex() };
  const add = (A, name, sku, stock, cost, cat, branch)=> A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description,cat_uid) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    [name, 12, stock, 1, sku, branch || A.api.currentBranch(), "", cost, "2026-10-01", "", cat||null]);
  add(H1, "Brake Pad Front", "BP-100", 5, 6, CAT.pad); add(H1, "Engine Oil 5L", "OIL-5L", 2, 20, CAT.oil); add(H1, "Spark Plug", "SP-4", 30, 1, CAT.plug);
  add(H2, "Brake Pad Front", "BP-100", 3, 0, CAT.pad);
  add(N1, "Brake Pad Front", "BP-100", 7, 0, CAT.pad); add(N1, "Engine Oil 5L", "OIL-5L", 4, 0, CAT.oil);
  add(M1, "Brake Pad Front", "BP-100", 0, 0, CAT.pad);
  // H1 once merged Norton's and Bulawayo's database files: stale copies in its own tables
  add(H1, "Brake Pad Front", "BP-100", 40, 0, null, "Norton");
  add(H1, "Brake Pad Front", "BP-100", 9, 0, null, "Bulawayo");
  H1.api.setSetting("file_copy_ts", JSON.stringify({ Norton:"2026-09-20T10:00:00.000Z", Bulawayo:"2026-10-03T10:00:00.000Z" }));

  await t("setup: Harare registers; Harare T2, Norton and Murehwa join; every till sends its figures; all read them", async ()=>{
    assert.ok((await H1.api.registerMainBranch("Counter")).ok);
    let r = await H1.api.issueJoinCode({ branchId: H1.api.getSetting("branch_uuid",""), seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await H2.api.joinBusiness({ phrase:"Ivo Phrase", code:r.data.code, label:"Back" })).ok);
    r = await H1.api.issueJoinCode({ newBranchName:"Norton", seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await N1.api.joinBusiness({ phrase:"Ivo Phrase", code:r.data.code, label:"Till 1", expectedBranchName:"Norton" })).ok);
    r = await H1.api.issueJoinCode({ newBranchName:"Murehwa", seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await M1.api.joinBusiness({ phrase:"Ivo Phrase", code:r.data.code, label:"Till 1", expectedBranchName:"Murehwa" })).ok);
    for(const A of [H1, H2, N1, M1]) assert.ok((await A.api.bsPush()).ok, A.name);
    for(const A of [H1, H2, N1, M1]) assert.ok((await A.api.bsPull()).ok, A.name);
    same(H1.api.bsBranches().map((b)=> b.name).sort(), ["Harare", "Murehwa", "Norton"]);
  });

  await t("bug A: All branches = Harare (T1 5 + T2 3) + Norton 7 + Murehwa 0 = 15, each branch under it (it was this till's 5)", async ()=>{
    H1.api.setPlistBranch(""); H1.api.setPlistQuery("");
    const rows = H1.api.plistResults();
    const pad = rows.find((r)=> r.sku === "BP-100");
    assert.strictEqual(pad.stock, 15);
    same(pad.parts.map((p)=> p.name + " " + p.qty).sort(), ["Harare 8", "Murehwa 0", "Norton 7"]);
    assert.strictEqual(rows.filter((r)=> r.sku === "BP-100").length, 1, "one row per product");
    const oil = rows.find((r)=> r.sku === "OIL-5L");
    assert.strictEqual(oil.stock, 6, "Harare 2 + Norton 4; Murehwa doesn't have it");
  });

  await t("bug A: a stale file copy of Norton (40) is ignored; Bulawayo (file merge only) is listed, not counted", async ()=>{
    const rows = H1.api.plistResults();
    const pad = rows.find((r)=> r.sku === "BP-100");
    same(pad.files.map((f)=> f.name + " " + f.qty), ["Bulawayo 9"]);
    const el = H1.dom.window.document.createElement("div");
    H1.dom.window.document.body.appendChild(el);
    H1.api.renderProductList(el);
    const txt = flat(el.querySelector("#plistResults").textContent);
    assert.match(txt, /Brake Pad Front/); assert.match(txt, /Bulawayo 9 \(file copy from (3 Oct 2026|Oct 3, 2026), not counted\)/);
    assert.match(txt, /Norton: updated/);
    const sel = flat(el.querySelector("#plistBranchSel").textContent);
    assert.match(sel, /Harare \(this branch\)/); assert.match(sel, /Norton \(stock from seiGEN\)/); assert.match(sel, /Bulawayo \(file copy from (3 Oct 2026|Oct 3, 2026)\)/);
    assert.doesNotMatch(sel, /Norton \(file copy/, "a joined branch is never offered as its old file copy");
    // picking Norton shows seiGEN's 7, not the merged 40
    H1.api.setPlistBranch("Norton");
    same(H1.api.plistResults().filter((r)=> r.sku === "BP-100").map((r)=> r.stock), [7]);
    H1.api.setPlistBranch("");
    el.remove();
  });

  await t("bug A: a sale here shows at once (14), before this till sends its figures", async ()=>{
    const p = H1.api.one("SELECT * FROM products WHERE sku='BP-100' AND branch='Harare'");
    H1.api.moveStock({ productId:p.id, delta:-1, kind:"sale", ts:new Date().toISOString(), note:"test" });
    assert.strictEqual(H1.api.plistResults().find((r)=> r.sku === "BP-100").stock, 14);
    H1.api.openBsProductModal(H1.api.one("SELECT * FROM products WHERE id=?", [p.id]));
    const m = flat(H1.dom.window.document.querySelector(".modalOverlay").textContent);
    assert.match(m, /All branches ?14/); assert.match(m, /Harare \(this branch\) ?7/); assert.match(m, /T1 \(this till, now\): 4/); assert.match(m, /T2 \(own count\): 3/);
    H1.dom.window.document.querySelectorAll(".modalOverlay").forEach((x)=> x.remove());
  });

  await t("bug A: not registered, the list is this device's own and says so", async ()=>{
    const U = makeApp({ setup_complete:"1", shop_name:"Solo", branch_name:"Mbare", branch_type:"main", install_date:"2026-09-01" }, { dom:true });
    U.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES('Bread',1,9,1,'BR1','Mbare','',0,'2026-10-01','')");
    const el = U.dom.window.document.createElement("div"); U.dom.window.document.body.appendChild(el);
    U.api.renderProductList(el);
    assert.match(flat(el.textContent), /Figures on this device only \(not on seiGEN\)/); assert.match(flat(el.textContent), /Bread.*Mbare.*9/);
  });

  await t("textMatches: every term in any order; words by their start; whole numbers; phones; dates", async ()=>{
    const tm = H1.api.textMatches;
    assert.ok(tm("oil 5l", { text:"Engine Oil 5L" })); assert.ok(tm("5l oil", { text:"Engine Oil 5L" }));
    assert.ok(!tm("5", { text:"Engine Oil 15L" }), "5 is a whole number, never 15");
    assert.ok(!tm("ngine", { text:"Engine Oil" }), "a word matches by its start");
    assert.ok(tm("tendai 0772", { text:["Tendai Moyo"], phones:["0772 123 456", "263772123456"] }));
    assert.ok(tm("0772 tendai", { text:["Tendai Moyo"], phones:["263772123456"] }));
    assert.ok(!tm("tendai 0771", { text:["Tendai Moyo"], phones:["263772123456"] }));
    const d = { text:["DN-T1-0004 Harare Norton"], dates:["2026-10-14T09:30:00"] };
    assert.ok(tm("norton 14 oct", d)); assert.ok(tm("14/10", d)); assert.ok(tm("2026-10-14", d)); assert.ok(tm("october", d));
    assert.ok(!tm("15 oct", d));
    assert.ok(tm("dn-t1-0004", d)); assert.ok(tm("0004 harare", d));
  });

  await t("search: Product List, Stock by branch and the Products page use the shared matcher", async ()=>{
    H1.api.setPlistBranch(""); H1.api.setPlistQuery("front pad");
    same(H1.api.plistResults().map((r)=> r.sku), ["BP-100"]);
    H1.api.setPlistQuery("ront");
    same(H1.api.plistResults().map((r)=> r.sku), [], "not the middle of a word (it was a substring test)");
    H1.api.setPlistBranch("Norton"); H1.api.setPlistQuery("5l oil");
    same(H1.api.plistResults().map((r)=> r.sku), ["OIL-5L"]);
    H1.api.setPlistBranch(""); H1.api.setPlistQuery("");
    const el = H1.dom.window.document.createElement("div");
    H1.api.setSetting("bs_tab", "stock"); H1.api.setSetting("bs_branch", ""); H1.api.setSetting("bs_pulled_ts", new Date().toISOString());
    H1.api.renderBranchStock(el);
    const s = el.querySelector("#bsSearch"); s.value = "pad front"; s.oninput();
    const grid = flat(el.querySelector("#bsBody").textContent);
    assert.match(grid, /Brake Pad Front/); assert.doesNotMatch(grid, /Engine Oil/);
    s.value = "5"; s.oninput();
    assert.match(flat(el.querySelector("#bsBody").textContent), /Engine Oil 5L/); assert.doesNotMatch(flat(el.querySelector("#bsBody").textContent), /Spark Plug/);
  });

  await t("search: Stock by branch → Dispatches has a box: DN, branches, date, status, products, transport", async ()=>{
    const p = H1.api.one("SELECT * FROM products WHERE sku='OIL-5L' AND branch='Harare'");
    H1.api.dnCommitDispatch({ branch:"Harare", toBranch:"Norton", now:new Date(), lines:[{ product:p, qty:1 }], internalRef:"PO 4471",
      srv:{ toBranchId: N1.api.getSetting("branch_uuid",""), delivery:{ cost:25, currency:"USD" } } });
    await H1.api.dsSendPending();
    assert.ok((await N1.api.bsPullDispatches()).ok);
    const d = N1.api.bsDispatches()[0];
    const f = N1.api.bsDispatchSearchFields(d), tm = N1.api.textMatches;
    const today = new Date(); const dm = today.getDate() + " " + ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"][today.getMonth()];
    for(const q of ["norton harare", dm, "in transit", "oil 5l", "OIL-5L", d.dn_display.toLowerCase()]) assert.ok(tm(q, f), q);
    assert.ok(!tm("spark", f));
    // the transport amount and the internal ref arrive with 20261026120000; the fields are matched when present
    assert.ok(tm("25 po 4471", N1.api.bsDispatchSearchFields(Object.assign({}, d, { delivery_cost:25, internal_ref:"PO 4471" }))));
    const el = N1.dom.window.document.createElement("div");
    N1.api.setSetting("bs_tab", "dispatches"); N1.api.setSetting("bs_dispatches_ts", new Date().toISOString());
    N1.api.renderBranchStock(el);
    const box = el.querySelector("#bsDispSearch");
    box.value = "oil norton"; box.oninput();
    assert.match(flat(el.querySelector("#bsBody").textContent), /Harare → Norton/);
    box.value = "spark"; box.oninput();
    assert.match(flat(el.querySelector("#bsBody").textContent), /No dispatch matches/);
    N1.api.setSetting("bs_tab", "stock");
  });

  await t("search: Dispatch history finds a DN by its product, its date, its internal ref and its status", async ()=>{
    const h = H1.api.one("SELECT * FROM dispatch_docs WHERE direction='out' ORDER BY dn_no DESC");
    const f = H1.api.dnSearchFields(h, H1.api.dnLineWords(), "dispatched"), tm = H1.api.textMatches;
    for(const q of ["engine oil", "po 4471", "norton in transit", "dn-t1"]) assert.ok(tm(q, f), q);
    assert.ok(!tm("brake", f));
  });

  await t("search: the cart's customer box and the Directory: every term on name and phone ('tendai 0772')", async ()=>{
    H1.api.run("INSERT INTO customers(name,phone,phone_norm,branch,customer_type) VALUES('Tendai Moyo','0772 123 456','263772123456','Harare','retail')");
    H1.api.run("INSERT INTO customers(name,phone,phone_norm,branch,customer_type) VALUES('Tendai Banda','0712 555 000','263712555000','Harare','retail')");
    same(H1.api.customerSearch("tendai 0772").map((c)=> c.name), ["Tendai Moyo"]);
    same(H1.api.customerSearch("0772 tendai").map((c)=> c.name), ["Tendai Moyo"]);
    same(H1.api.customerSearch("moyo t").map((c)=> c.name), ["Tendai Moyo"]);
    same(H1.api.customerSearch("077 2123 456").map((c)=> c.name), ["Tendai Moyo"], "a whole number typed with spaces");
    same(H1.api.customerSearch("tendai").map((c)=> c.name).sort(), ["Tendai Banda", "Tendai Moyo"]);
  });

  await t("every branch: a remote's Products page shows the other branches (and this branch with 2+ tills on main)", async ()=>{
    assert.strictEqual(N1.api.bsShowOtherColumn(), true, "Norton (remote) has the column");
    const html = N1.api.productsTableHtml(N1.api.all("SELECT * FROM products ORDER BY name"), true);
    assert.match(html, /Other branches/);
    const pad = N1.api.one("SELECT * FROM products WHERE sku='BP-100'");
    assert.strictEqual(N1.api.bsOtherQty(pad), 8, "Harare 8 + Murehwa 0 (seiGEN's figures)");
    assert.strictEqual(H1.api.bsShowThisBranchColumn(), true, "Harare has 2 tills");
    assert.strictEqual(N1.api.bsShowThisBranchColumn(), false, "Norton has 1");
    const mh = H1.api.productsTableHtml(H1.api.all("SELECT * FROM products WHERE branch='Harare' ORDER BY name"), false);
    assert.match(mh, /This till/); assert.match(mh, /This branch/);
  });

  await t("Sell: tapping a product's name shows one line with the other branches' stock", async ()=>{
    const pad = N1.api.one("SELECT * FROM products WHERE sku='BP-100'");
    assert.match(N1.api.bsSellLineText(pad), /^Other branches: (Harare 8 · Murehwa 0|Murehwa 0 · Harare 8) \(updated /);
    const plug = N1.api.one("SELECT * FROM products WHERE sku='OIL-5L'");
    assert.match(N1.api.bsSellLineText(plug), /^Other branches: Harare 2 \(/, "seiGEN's figure as last read");
    const list = N1.api.productListHtml([pad]);
    assert.match(list, /data-bsline="\d+"/); assert.doesNotMatch(list, /bs-sell-line/, "hidden until tapped");
  });

  await t("Stocktake: this branch only; other branches read-only next to the count; available at a remote", async ()=>{
    const doc = N1.dom.window.document;
    const el = doc.createElement("div"); doc.body.appendChild(el);
    N1.api.renderStocktake(el);
    el.querySelector("#startStocktake").click();
    const modal = doc.querySelector(".modalOverlay");
    assert.match(flat(modal.textContent), /Norton \(this branch\)/);
    assert.strictEqual(modal.querySelector("select#stBranch"), null, "no branch picker");
    modal.querySelector("#stConfirm").click();
    const take = N1.api.one("SELECT * FROM stocktakes WHERE status='Open'");
    assert.strictEqual(take.branch, "Norton");
    N1.api.renderStocktake(el);
    const txt = flat(el.textContent);
    assert.match(txt, /Other branches/); assert.match(txt, /Harare 8/); assert.match(txt, /Murehwa 0/);
    assert.doesNotMatch(txt, /Norton 7/, "this branch's own expected figure stays hidden");
    el.remove();
  });

  await t("Stocktake: an old open stocktake of a file copy (Norton on Harare) can't be counted or applied", async ()=>{
    H1.api.run("INSERT INTO stocktakes(branch,team_names,start_date,end_date,status,created_by,created_ts) VALUES('Norton','','2026-10-01','','Closed','x',?)", [new Date().toISOString()]);
    const take = H1.api.one("SELECT * FROM stocktakes WHERE branch='Norton'");
    assert.strictEqual(H1.api.stocktakeIsOwnBranch(take), false);
    assert.match(H1.api.stocktakeCountingTableHtml(H1.api.all("SELECT * FROM products WHERE branch='Norton'"), {}, false), /disabled/);
    const doc = H1.dom.window.document, el = doc.createElement("div"); doc.body.appendChild(el);
    if(H1.api.renderStocktakeReport){ H1.api.renderStocktakeReport(el, take.id);
      assert.strictEqual(el.querySelector("#applyStocktake"), null, "no Apply button");
      assert.match(flat(el.textContent), /Only this branch's own stock can be counted and applied here/); }
    el.remove();
  });

  await t("bug A: Reports → Inventory / Low stock with All branches say they're this device's figures", async ()=>{
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "reports.js"), "utf8");
    assert.match(src, /printReport\("Inventory Report", `\$\{b\|\|"All branches \(this device\)"\}`/);
    assert.match(src, /printReport\("Low Stock Report", `\$\{b\|\|"All branches \(this device\)"\}/);
  });

  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
