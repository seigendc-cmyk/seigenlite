// node test/branch-views.test.js
//
// Branches step 2 (app v27; docs/branches/multi-branch-visibility-design.md
// §R2, §R3, §R4, §R5, §R6; owner 2026-10-14 Q4 / Q5, "go" 2026-10-16). Tills
// running the REAL app code (test/harness.js, JSDOM for the screens) against
// the REAL server SQL in PGlite (the live shape + 20261106120000_branch_views),
// never the live database:
//   - Directory: Customers and Suppliers tabs, each name with the branch that
//     added it; search by that branch; suppliers read-only at a remote;
//   - the cart: another branch's customer asks first, once per customer on a
//     till (another till asks again); this branch's customers never ask;
//   - a credit sale to another branch's customer: every time, the Admin
//     passcode (a wrong one sells nothing); cash never asks;
//   - Stock by branch → Dispatches: found by internal ref and transport; a tap
//     (phone) or a double-click (Windows program) opens the DN card: header,
//     transport, lines, the differences and how they were settled, history;
//     no cost anywhere; Share file only on the till that sent it;
//   - an older seiGEN: the card shows what the till holds and says why;
//   - the item ledger from Products, the Product List and Stock by branch:
//     this till's movements with the running balance, the other branches'
//     from seiGEN, marked partial;
//   - each till's own figure at a remote; Report Writer at a remote: this
//     branch only, plus every branch's stock (quantities).
"use strict";
const assert = require("assert");
const vm = require("vm");
const { makeApp, fixedClock } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
const same = (a, b, m)=> assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); }
}
const flat = (s)=> String(s).replace(/\s+/g, " ");
async function waitFor(cond, what){
  const end = Date.now() + 15000;
  while(!cond()){ if(Date.now() > end) throw new Error("timed out waiting for " + what); await new Promise((r)=> setTimeout(r, 20)); }
}
const COSTS = /unit.?cost|landed|charge|\b1\.50\b|\b4\.00\b/i;   // Sugar costs 1.50, Rice 4.00 on Harare

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== "20261106120000_branch_views.sql") });
  let lock = Promise.resolve();
  const serial = (fn)=>{ const run = lock.then(fn, fn); lock = run.catch(()=>{}); return run; };
  let oldServer = false;   // answer as a seiGEN without 20261106120000 (its new readers missing)
  async function rpcNow(fn, body){
    if(oldServer && /^cl_device_(dispatch_card|item_ledger)$/.test(fn))
      return { status:404, body: JSON.stringify({ code:"PGRST202", message:"Could not find the function public." + fn + " in the schema cache" }) };
    const names = Object.keys(body);
    const args = names.map((n)=> (body[n] !== null && typeof body[n] === "object") ? JSON.stringify(body[n]) : body[n]);
    const sql = `select to_json(public.${fn}(${names.map((n, i)=> `${n}=>$${i + 1}`).join(", ")})) j`;
    await pg.exec("set role anon");
    try{ return { status:200, body: JSON.stringify((await pg.query(sql, args)).rows[0].j) }; }
    catch(e){ return { status:400, body: JSON.stringify({ message: e.message }) }; }
    finally{ await pg.exec("reset role"); }
  }
  function till(name, settings){
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:"Mandie Phrase", install_date:"2026-09-01" }, settings), { dom:true });
    A.name = name;
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      const r = await serial(()=> rpcNow(m[1], JSON.parse(opts.body)));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.hook("printReport", ()=>{});
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Boss','Admin','4321',?,1,?)", [A.api.currentBranch(), new Date().toISOString()]);
    // Report Writer's screen state (state.js, not loaded by the harness)
    vm.runInContext(`var rwType="sales", rwBranch="", rwStatus="", rwReason="", rwView="dn", rwFrom="", rwTo="", rwGranularity="day";`, A.ctx);
    return A;
  }
  const H1 = till("H1", { install_id:"MB01", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const H2 = till("H2", { install_id:"MB02", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE02", branch_type:"main" });
  const M1 = till("M1", { install_id:"MB03", shop_name:"Mandie Babyware", branch_name:"Murehwa", branch_id:"B-MUREHWA1", branch_type:"remote" });
  const doc = (A)=> A.dom.window.document;
  const screen = (A)=>{ const el = doc(A).createElement("div"); doc(A).body.appendChild(el); return el; };
  const modals = (A)=> [...doc(A).querySelectorAll(".modalOverlay")];
  const lastModal = (A)=> modals(A).slice(-1)[0];
  const closeModals = (A)=> modals(A).forEach((m)=> m.remove());
  const prod = (A, sku, name, stock, cost, cat)=>{
    A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,cost,created_ts,cat_uid,image,description) VALUES(?,?,?,?,?,?,?,?,?,'','')", [name, 3, stock, 1, sku, A.api.currentBranch(), cost, new Date().toISOString(), cat || null]);
    A.api.recordStockMovement(A.api.one("SELECT id FROM products WHERE sku=?", [sku]).id, stock, { kind:"opening" });
  };
  const P = (A, sku)=> A.api.one("SELECT * FROM products WHERE sku=? AND branch=?", [sku, A.api.currentBranch()]);
  prod(H1, "SUG2", "Sugar 2kg", 50, 1.5, "cat-sugar"); prod(H1, "RIC5", "Rice 5kg", 100, 4);
  prod(H2, "SUG2", "Sugar 2kg", 20, 1.5, "cat-sugar");
  prod(M1, "S-2", "Sugar 2 kilo", 3, 0, "cat-sugar"); prod(M1, "RIC5", "Rice 5kg", 0, 0);

  let D1;
  await t("setup: Harare registers; Harare T2 and Murehwa join; customers and a supplier are added on their own tills", async ()=>{
    assert.ok((await H1.api.registerMainBranch("Counter")).ok);
    let r = await H1.api.issueJoinCode({ branchId:H1.api.getSetting("branch_uuid",""), seed:H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await H2.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Back" })).ok);
    r = await H1.api.issueJoinCode({ newBranchName:"Murehwa", seed:H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await M1.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Till 1", expectedBranchName:"Murehwa" })).ok);
    M1.api.saveCustomer(null, { name:"Tendai Moyo", phone:"0772 123 456" }, { passcode:"4321" });
    H1.api.saveCustomer(null, { name:"Rudo Banda", phone:"0773 222 333" }, { passcode:"4321" });
    await M1.api.custSendPending(); await H1.api.custSendPending();
    H1.api.sgSaveSupplier({ name:"Metro Wholesalers", phone:"0771 000 111", notes:"Sugar and rice" });
    await H1.api.sgSendPending();
    for(const A of [H1, H2, M1]){ await A.api.custPull(); await A.api.sgPull(); }
  });

  await t("customers carry the branch that added them; a till's own customers are 'this branch', never 'another'", ()=>{
    const tendai = H1.api.one("SELECT * FROM customers WHERE name='Tendai Moyo'"), rudo = H1.api.one("SELECT * FROM customers WHERE name='Rudo Banda'");
    assert.strictEqual(tendai.src_branch_name, "Murehwa"); assert.strictEqual(tendai.src_branch, M1.api.getSetting("branch_uuid",""));
    assert.strictEqual(rudo.src_branch_name, "Harare");
    assert.strictEqual(H1.api.custOtherBranch(tendai), "Murehwa");
    assert.strictEqual(H1.api.custOtherBranch(rudo), "");
    assert.strictEqual(H2.api.custOtherBranch(H2.api.one("SELECT * FROM customers WHERE name='Rudo Banda'")), "", "Harare T2: Rudo is this branch's");
    assert.strictEqual(M1.api.custOtherBranch(M1.api.one("SELECT * FROM customers WHERE name='Tendai Moyo'")), "", "the till that added Tendai");
    assert.strictEqual(M1.api.custOtherBranch(M1.api.one("SELECT * FROM customers WHERE name='Rudo Banda'")), "Harare");
  });

  await t("Directory → Customers: each name says where it was added; the search finds a branch and 'tendai 0772' in any order", ()=>{
    H1.api.setSetting("dir_tab", "customers");
    const el = screen(H1);
    H1.api.renderDirectory(el);
    const txt = flat(el.textContent);
    assert.match(txt, /Tendai Moyo.*added at Murehwa/); assert.match(txt, /Rudo Banda.*added at Harare \(this branch\)/);
    const s = el.querySelector("#directorySearch");
    s.value = "murehwa"; s.dispatchEvent(new H1.dom.window.Event("input"));
    let list = flat(el.querySelector("#directoryListArea").textContent);
    assert.match(list, /Tendai/); assert.doesNotMatch(list, /Rudo/);
    s.value = "0772 tendai"; s.dispatchEvent(new H1.dom.window.Event("input"));
    list = flat(el.querySelector("#directoryListArea").textContent);
    assert.match(list, /Tendai/); assert.doesNotMatch(list, /Rudo/);
    s.value = ""; s.dispatchEvent(new H1.dom.window.Event("input"));
    el.remove();
  });

  await t("Directory → Suppliers: the business's suppliers at a remote too, read-only, with the branch that added them", ()=>{
    const el = screen(M1);
    M1.api.renderDirectory(el);
    el.querySelector("#dirTabSup").click();
    const txt = flat(el.textContent);
    assert.match(txt, /Metro Wholesalers/); assert.match(txt, /Sugar and rice/); assert.match(txt, /added at Harare/);
    assert.match(txt, /read-only here\. The main branch adds and changes them/);
    assert.ok(!el.querySelector("#openNewCustomer"), "no add button on the Suppliers tab");
    const s = el.querySelector("#directorySearch");
    s.value = "harare metro"; s.dispatchEvent(new M1.dom.window.Event("input"));
    assert.match(flat(el.textContent), /Metro Wholesalers/);
    s.value = "bulawayo"; s.dispatchEvent(new M1.dom.window.Event("input"));
    assert.match(flat(el.textContent), /No suppliers match/);
    el.querySelector("#dirTabCust").click();
    assert.ok(el.querySelector("#openNewCustomer"), "back on Customers");
    el.remove();
  });

  // the cart's customer box, as the drawer and the desktop cart use it
  function combo(A){
    const el = screen(A);
    const draw = ()=>{ el.innerHTML = A.api.customerComboHtml(); A.api.wireCustomerCombo(el, draw); };
    draw();
    return { el, pick(text, name){
      const inp = el.querySelector("#custName");
      inp.value = text; inp.dispatchEvent(new A.dom.window.Event("input"));
      const opt = [...el.querySelectorAll("[data-cust-pick]")].find((b)=> b.textContent.includes(name));
      assert.ok(opt, "the option for " + name); const label = flat(opt.textContent); opt.click(); return label;
    }, clear(){ const c = el.querySelector("#custClear"); if(c) c.click(); } };
  }
  await t("the cart: another branch's customer asks first (Cancel leaves the cart without them), then once per customer on this till", ()=>{
    const c = combo(H1);
    const label = c.pick("tendai", "Tendai Moyo");
    assert.match(label, /added at Murehwa/, "the option says where they were added");
    let m = lastModal(H1);
    assert.ok(m, "a notice"); assert.match(flat(m.textContent), /Customer from another branch.*This customer was added at Murehwa\. Continue\?/);
    m.querySelector("#xbCancel").click();
    assert.strictEqual(H1.api.getCartCustomer(), null, "Cancel: no customer on the sale");
    c.pick("tendai", "Tendai Moyo");
    lastModal(H1).querySelector("#xbGo").click();
    assert.strictEqual(H1.api.getCartCustomer().name, "Tendai Moyo");
    c.clear(); assert.strictEqual(H1.api.getCartCustomer(), null);
    const n = modals(H1).length;
    c.pick("0772", "Tendai Moyo");
    assert.strictEqual(modals(H1).length, n, "the second time on this till: no notice");
    assert.strictEqual(H1.api.getCartCustomer().name, "Tendai Moyo");
    c.clear();
    c.pick("rudo", "Rudo Banda");
    assert.strictEqual(modals(H1).length, n, "this branch's customer: no notice");
    c.clear(); c.el.remove();
    const c2 = combo(H2);
    c2.pick("tendai", "Tendai Moyo");
    assert.match(flat(lastModal(H2).textContent), /added at Murehwa/, "another till asks again (once per customer per till)");
    lastModal(H2).querySelector("#xbGo").click(); c2.clear(); c2.el.remove();
    closeModals(H1); closeModals(H2);
  });

  await t("a dispatch with an internal ref and transport; Murehwa receives one short; Harare writes it off", async ()=>{
    await H1.api.dsRefreshBranches();
    const mb = H1.api.dsBranchFor("Murehwa");
    const dn = H1.api.dnCommitDispatch({ branch:"Harare", toBranch:"Murehwa", now:new Date(), internalRef:"PO-7",
      lines:[{ product:P(H1, "SUG2"), qty:10 }, { product:P(H1, "RIC5"), qty:5 }], srv:{ toBranchId:mb.id, delivery:{ cost:12, currency:"usd", carrier:"Kombi", ref:"K-55" } } });
    D1 = H1.api.dnHeaderFor(dn.n).srv_id;
    await H1.api.dsSendPending();
    assert.ok((await M1.api.dsPull()).ok);
    const d = M1.api.dsCachedOne(D1);
    const r = await M1.api.dsPostGrv(D1, { 1:{ received:9, damaged:0, extra:0 }, 2:{ received:5, damaged:0, extra:0 } },
      { 1:M1.api.dsFindProduct(d.lines[0]).id, 2:M1.api.dsFindProduct(d.lines[1]).id }, { internalRef:"MU-IN-4" });
    assert.ok(r.ok, JSON.stringify(r));
    await H1.api.dsPull();
    const iss = H1.api.dsOpenIssues().find((x)=> x.i.kind === "short");
    await H1.api.dsWriteOff(iss.i.id, "lost on the road", "4321");
    for(const A of [H1, H2, M1]){ assert.ok((await A.api.bsPush()).ok, A.name); }
    for(const A of [H1, H2, M1]){ assert.ok((await A.api.bsPull()).ok, A.name); assert.ok((await A.api.bsPullDispatches()).ok, A.name); }
  });

  await t("Stock by branch → Dispatches (a remote): the card shows the ref and the transport; found by 'po-7', 'kombi' and '12'", ()=>{
    M1.api.setSetting("bs_tab", "dispatches");
    const el = screen(M1);
    M1.api.renderBranchStock(el);
    const card = el.querySelector(".bs-dispatch");
    assert.match(flat(card.textContent), /Ref\. PO-7 · Transport USD 12\.00 · Kombi/);
    const s = el.querySelector("#bsDispSearch");
    for(const q of ["po-7", "kombi", "12", "k-55", "mu-in-4", "murehwa sugar"]){
      s.value = q; s.dispatchEvent(new M1.dom.window.Event("input"));
      assert.ok(el.querySelector(".bs-dispatch"), "found by " + q);
    }
    s.value = "13"; s.dispatchEvent(new M1.dom.window.Event("input"));
    assert.ok(!el.querySelector(".bs-dispatch"), "'13' doesn't match 12.00");
    el.remove();
  });

  let cardText = "";
  await t("a tap on the DN (phone) opens its full card: header, transport, lines, the difference written off, history; no cost", async ()=>{
    M1.api.setSetting("bs_tab", "dispatches");
    const el = screen(M1);
    M1.api.renderBranchStock(el);
    el.querySelector(".bs-dispatch").click();
    const m = lastModal(M1);
    await waitFor(()=> !/Loading/.test(m.textContent), "the card from seiGEN");
    cardText = flat(m.textContent);
    assert.match(m.querySelector(".modal-head h3").textContent, /Delivery Note DN-T1-0001/);
    for(const re of [/Status\s?Received with differences|Status\s?Received/, /From\s?Harare \(T1\)/, /To\s?Murehwa/, /Internal ref\.\s?PO-7/, /GRV\s?GRV-T1-0001 \(T1\)/,
      /GRV internal ref\.\s?MU-IN-4/, /Transport\s?USD 12\.00 · Kombi · ref\. K-55 · paid by the receiving branch/])
      assert.match(cardText, re);
    const lines = [...m.querySelectorAll(".bv-lines tr")].map((tr)=> [...tr.children].map((c)=> c.textContent.trim()));
    same(lines.slice(1).map((l)=> l.slice(0, 4)), [["SUG2 · Sugar 2kg", "10", "9", "1"], ["RIC5 · Rice 5kg", "5", "5", "0"]]);
    assert.match(flat(m.querySelector(".bv-issue").textContent), /Sugar 2kg: short 1 · written off · as ADJ-.* · by .*“lost on the road”/);
    same([...m.querySelectorAll(".bv-hist")].map((h)=> / · (Sent|Received|Difference written off)/.exec(h.textContent)[1]), ["Sent", "Received", "Difference written off"]);
    assert.doesNotMatch(cardText, COSTS, "no cost on the card");
    assert.ok(!m.querySelector("#bvShare"), "Share file: only on the till that sent it");
    closeModals(M1); el.remove();
  });

  await t("the Windows program: a single click does nothing, a double-click opens the card; the sending till may share the DN file", async ()=>{
    H1.hook("isDesktopBuild", ()=> true);
    H1.api.setSetting("bs_tab", "dispatches");
    const el = screen(H1);
    H1.api.renderBranchStock(el);
    const card = el.querySelector(".bs-dispatch");
    card.click();
    assert.strictEqual(modals(H1).length, 0, "a click doesn't open it");
    assert.match(card.title, /Double-click/);
    card.dispatchEvent(new H1.dom.window.MouseEvent("dblclick", { bubbles:true }));
    const m = lastModal(H1);
    assert.ok(m, "a double-click does");
    await waitFor(()=> !/Loading/.test(m.textContent), "the card");
    assert.ok(m.querySelector("#bvShare"), "Share file on the till that sent it");
    closeModals(H1); el.remove();
    H1.hook("isDesktopBuild", ()=> false);
  });

  await t("the seiGEN Incoming list (Products → seiGEN dispatches) opens the same card", async ()=>{
    // the receiver's Recent list: the DN number is the opener
    const html = flat(M1.api.dsCached("in").map((d)=> d.dn_display).join(" "));
    assert.match(html, /DN-T1-0001/);
    const el = screen(M1);
    el.innerHTML = `<span class="bv-dn" data-bvdn="${D1}">DN-T1-0001</span>`;
    el.querySelectorAll("[data-bvdn]").forEach((x)=> M1.api.bvOnOpen(x, ()=> M1.api.openDnCard(x.dataset.bvdn)));
    el.querySelector("[data-bvdn]").click();
    await waitFor(()=> !/Loading/.test(lastModal(M1).textContent), "the card");
    assert.strictEqual(flat(lastModal(M1).textContent), cardText);
    closeModals(M1); el.remove();
  });

  await t("an older seiGEN (no card yet): the card shows what this till holds and says the rest comes with the update", async ()=>{
    oldServer = true;
    const m = M1.api.openDnCard(D1);
    await waitFor(()=> /Not on seiGEN yet/.test(m.textContent), "the note");
    const txt = flat(m.textContent);
    assert.match(txt, /Not on seiGEN yet: it comes with the seiGEN update\. Showing what this till holds/);
    assert.match(txt, /DN-T1-0001/); assert.match(txt, /Sugar 2kg/);
    oldServer = false; closeModals(M1);
  });

  await t("the item ledger (Products, a tap on the name): this till's movements with the running balance", async ()=>{
    const el = screen(H1);
    el.innerHTML = H1.api.productsTableHtml(H1.api.all("SELECT * FROM products WHERE branch=? ORDER BY name", [H1.api.currentBranch()]), false);
    H1.api.wireProductRowButtons(el, false);
    H1.api.setSetting("bv_ledger_branch", "mine");
    [...el.querySelectorAll("[data-bvledger]")].find((x)=> /Sugar/.test(x.textContent)).click();
    const m = lastModal(H1);
    assert.match(m.querySelector(".modal-head h3").textContent, /Item ledger: Sugar 2kg/);
    await waitFor(()=> !/Loading from seiGEN/.test(m.textContent), "seiGEN's rows");
    const sum = flat(m.querySelector(".bv-local-sum").textContent);
    assert.match(sum, new RegExp("closing " + P(H1, "SUG2").stock + "$"), sum);
    const rows = [...m.querySelectorAll(".bv-local tr")].slice(1).map((tr)=> flat(tr.textContent));
    assert.ok(rows.some((r)=> /DN-T1-0001/.test(r) && /-10/.test(r)), rows.join(" | "));
    assert.match(flat(m.textContent), /Harare \(this branch\): the other tills/, "Harare has 2 tills: their rows from seiGEN");
    assert.match(flat(m.textContent), /Sales and adjustments on the other tills are not on seiGEN yet/);
    assert.doesNotMatch(flat(m.textContent), COSTS);
    closeModals(H1); el.remove();
  });

  await t("the item ledger, All branches: Murehwa's receipt from seiGEN, its figure now, marked partial; a DN opens its card", async ()=>{
    H1.api.setSetting("bv_ledger_branch", "all");
    const m = H1.api.openItemLedger(P(H1, "SUG2"));
    await waitFor(()=> !/Loading from seiGEN/.test(m.textContent), "seiGEN's rows");
    const txt = flat(m.textContent);
    assert.match(txt, /Murehwa Now: 12/, "Murehwa: 3 + 9 received");
    const srv = [...m.querySelectorAll(".bv-srv tr")].slice(1).map((tr)=> flat(tr.textContent));
    assert.ok(srv.some((r)=> /Received \(GRV\) from Harare/.test(r) && /GRV-T1-0001/.test(r) && /\+9/.test(r)), srv.join(" | "));
    assert.match(txt, /Sales and adjustments at Murehwa are not on seiGEN yet \(after the update\), so there is no running balance here/);
    assert.doesNotMatch(txt, COSTS);
    m.querySelector(".bv-srv [data-bvdn]").click();
    assert.match(lastModal(H1).querySelector(".modal-head h3").textContent, /Delivery Note/);
    closeModals(H1);
    H1.api.setSetting("bv_ledger_branch", "mine");
  });

  await t("the item ledger from a remote's Product List and Stock by branch (a product probe)", async ()=>{
    M1.api.setPlistBranch(""); M1.api.setPlistQuery("sugar");
    const el = screen(M1);
    M1.api.renderProductList(el);
    el.querySelector("[data-bvledger]").click();
    let m = lastModal(M1);
    await waitFor(()=> !/Loading from seiGEN/.test(m.textContent), "rows");
    assert.match(m.querySelector(".modal-head h3").textContent, /Item ledger: Sugar 2 kilo/, "this till's own product, by catalogue uid");
    assert.match(flat(m.querySelector(".bv-local-sum").textContent), /closing 12$/);
    closeModals(M1); el.remove();
    M1.api.setSetting("bs_tab", "stock");
    const bs = screen(M1);
    M1.api.renderBranchStock(bs);
    bs.querySelector("[data-bvledger]").click();
    m = lastModal(M1);
    assert.match(m.querySelector(".modal-head h3").textContent, /Item ledger:/);
    closeModals(M1); bs.remove();
  });

  await t("each till's own figure at a remote (it was main only): Harare T1 and T2 under Harare's total", ()=>{
    const har = M1.api.bsBranches().find((b)=> b.name === "Harare");
    const row = har.rows.find((r)=> r.k === "cat-sugar");
    assert.ok(row, JSON.stringify(har.rows));
    same(row.t, { T1:P(H1, "SUG2").stock, T2:20 });
    assert.strictEqual(har.tills.length, 2);
    M1.api.setSetting("bs_tab", "stock");
    const el = screen(M1);
    M1.api.renderBranchStock(el);
    assert.match(flat(el.querySelector(".bs-tills").textContent), new RegExp("T1: " + P(H1, "SUG2").stock + " · T2: 20"));
    assert.match(flat(el.textContent), /Harare: T1 updated .* · T2 updated/);
    el.remove();
  });

  await t("Report Writer at a remote: this branch only; every branch's stock (quantities); the main-only reports stay hidden", ()=>{
    const ids = M1.api.reportWriterConfigs().map((c)=> c.id);
    assert.ok(ids.includes("branchstock") && ids.includes("itemledger") && ids.includes("sales"), ids.join());
    for(const hidden of M1.api.REPORT_CONFIGS.filter((c)=> c.remoteHidden || c.mainOnly).map((c)=> c.id)) assert.ok(!ids.includes(hidden), hidden + " hidden");
    const el = screen(M1);
    vm.runInContext(`rwType="sales"; rwBranch="Harare";`, M1.ctx);
    M1.api.renderReportWriter(el);
    same([...el.querySelectorAll("#rwBranchSel option")].map((o)=> o.textContent), ["Murehwa (this branch)"]);
    el.querySelector("#rwView").click();
    assert.strictEqual(vm.runInContext("rwBranch", M1.ctx), "Murehwa");
    vm.runInContext(`rwType="branchstock";`, M1.ctx);
    M1.api.renderReportWriter(el);
    assert.ok(el.querySelector("#rwBranchSel").disabled);
    el.querySelector("#rwView").click();
    const heads = [...el.querySelectorAll("#rwResults th")].map((x)=> x.textContent);
    same(heads, ["Item", "Harare", "Murehwa", "All branches"]);
    const sugar = [...el.querySelectorAll("#rwResults tr")].map((tr)=> flat(tr.textContent)).find((r)=> /Sugar/.test(r));
    assert.match(sugar, new RegExp(String(P(H1, "SUG2").stock + 20) + " ?12 ?" + String(P(H1, "SUG2").stock + 32)), sugar);
    assert.match(flat(el.textContent), /Quantities only/);
    assert.doesNotMatch(flat(el.querySelector("#rwResults").textContent), COSTS);
    el.remove();
  });

  // ---- a credit sale to another branch's customer (Q5): this till alone, a fixed clock ----
  await t("credit to another branch's customer: every sale asks the Admin passcode; a wrong one sells nothing; cash never asks", ()=>{
    const A = fixedClock(makeApp({ branch_name:"Boka", branch_type:"main", setup_complete:"1", branch_uuid:"11111111-1111-4111-8111-111111111111" }, { dom:true }), "2026-10-06T10:00:00Z");
    A.hook("printReceipt", ()=>{});
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Boss','Admin','4321','Boka',1,'x')");
    A.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Rice',10,50,3,'Boka','R1')");
    A.api.run("INSERT INTO customers(uid,name,phone,branch,src_branch,src_branch_name) VALUES('c-far','Farai','0774','Boka','22222222-2222-4222-8222-222222222222','Norton')");
    A.api.run("INSERT INTO customers(uid,name,phone,branch,src_branch,src_branch_name) VALUES('c-own','Grace','0775','Boka','11111111-1111-4111-8111-111111111111','Boka')");
    A.api.startShift("0", new Date("2026-10-06T08:00:00Z"));
    const rice = A.api.one("SELECT * FROM products WHERE sku='R1'");
    const sales = ()=> A.api.one("SELECT COUNT(*) n FROM sales").n;
    const sell = (cust, payments)=>{ A.api.setCart([{ product_id:rice.id, name:"Rice", price:10, qty:2, stock:rice.stock }]); A.api.setCartCustomer(cust); A.api.completeSale(null, payments); };
    const farai = A.api.one("SELECT * FROM customers WHERE uid='c-far'"), grace = A.api.one("SELECT * FROM customers WHERE uid='c-own'");
    sell(farai, [{ method:"Credit", amount:20 }]);
    assert.strictEqual(sales(), 0, "nothing sold before the passcode");
    let m = lastModal(A);
    assert.match(flat(m.textContent), /Credit for another branch's customer.*added at Norton\. Their credit balance here covers this till only \(until the update that shares sales\)/);
    m.querySelector("#xcPass").value = "0000"; m.querySelector("#xcGo").click();
    assert.match(m.querySelector("#xcMsg").textContent, /Incorrect Admin passcode/); assert.strictEqual(sales(), 0);
    m.querySelector("#xcPass").value = "4321"; m.querySelector("#xcGo").click();
    assert.strictEqual(sales(), 1, "sold after the passcode");
    assert.strictEqual(A.api.customerBalance(farai.id), 20);
    assert.ok(A.api.one("SELECT * FROM audit_log WHERE action=?", ["Credit to another branch's customer"]), "logged with who approved");
    closeModals(A);
    sell(farai, [{ method:"Credit", amount:20 }]);
    assert.strictEqual(sales(), 1, "the next credit sale asks again");
    assert.ok(lastModal(A).querySelector("#xcPass")); lastModal(A).querySelector("#xcCancel").click();
    sell(farai, [{ method:"Cash", amount:20 }]);
    assert.strictEqual(sales(), 2, "cash: no passcode");
    sell(grace, [{ method:"Credit", amount:20 }]);
    assert.strictEqual(sales(), 3, "this branch's customer: no passcode");
    assert.strictEqual(modals(A).length, 0);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
