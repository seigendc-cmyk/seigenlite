// node --no-warnings test/stock-control-v37.test.js
//
// v37 Stock control + the notification bell (owner decisions 8, 12, 48, 52-55).
// Tills running the REAL app code (test/harness.js) against the REAL server SQL in
// PGlite (the live shape + 20261115120000_stock_control), never the live database:
//   cycle: A/B/C classes and every red flag pick the right items, each with its
//     reason; blind counting (no expected figure anywhere on the counter's screen);
//     every difference waits, no stock change before approval; a recount by
//     another person; a sale between the count and the approval stays counted
//     (the difference moves stock, never "set to"); an offline count syncs later;
//     an approval on another till moves the counting till's stock once; the
//     shrinkage figures, units only without View costs; shelf per branch, import.
//   requests: create, notify, part-approve with a reason -> the pre-filled DN
//     (draft) -> GRV -> statuses at both ends; refused work waits for a sign-in.
//   recalls: create, notify, send back with a short line -> DN -> GRV at main;
//     transport owed by main; overdue; no stock change until the DN is sent.
//   bell: each category only to people with the right; unread per person; the
//     chime once per new event and only when on; no duplicates after repeated
//     syncs; the 60 s check pauses when hidden; titles only; a Guest sees only
//     the Market feed.
"use strict";
process.env.TZ = "Africa/Harare";
const assert = require("assert");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
const TILLS = [];
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); }
  finally{ for(const A of TILLS){ A.ctx.navigator.onLine = true; } }
}
const DAY = 86400000;
// values made inside the app's vm context: compare as JSON (test/harness.js realm)
const same = (a, b, m)=> assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
const FILE = "20261115120000_stock_control.sql";

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== FILE) });   // the live shape + v37
  let lock = Promise.resolve();
  const serial = (fn)=>{ const run = lock.then(fn, fn); lock = run.catch(()=>{}); return run; };
  const q = (sql, p)=> serial(async ()=> (await pg.query(sql, p)).rows);
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
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:"Mandie Phrase", install_date:"2026-09-01", currency:"$" }, settings), { dom:true });
    A.name = name; A.alerts = []; TILLS.push(A);
    A.hook("alert", (m)=>{ A.alerts.push(String(m)); });
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      const r = await serial(()=> rpcNow(m[1], JSON.parse(opts.body)));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Boss','Admin','4321',?,1,?)", [A.api.currentBranch(), new Date().toISOString()]);
    // as the catalogue delivers them (cat_applying: main's shelf, not one this branch set), with their opening movement
    const add = (n, sku, cat, cost, stock, shelf)=>{
      A.api.setSetting("cat_applying","1");
      A.api.run("INSERT INTO products(name,price,cost,stock,low_threshold,sku,branch,created_ts,cat_uid,shelf) VALUES(?,?,?,?,2,?,?,?,?,?)",
        [n, cost*2, cost, stock, sku, A.api.currentBranch(), "2026-01-01", cat, shelf||""]);
      A.api.setSetting("cat_applying","");
      A.api.recordStockMovement(A.api.one("SELECT last_insert_rowid() AS id").id, stock, { kind:"import", ts:"2026-01-01T00:00:00Z" });
    };
    add("Baby bottle", "BOT1", "cat-bottle", 5, 40, "A1");
    add("Cooking oil 2L", "OIL2", "cat-oil", 3, 30, "B2");
    add("Nappies L", "NAP1", "cat-nappy", 8, 25, "A1");
    add("Rattle", "RAT1", "cat-rattle", 1, 10, "");
    return A;
  }
  const P = (A, sku)=> A.api.one("SELECT * FROM products WHERE sku=? AND branch=?", [sku, A.api.currentBranch()]);
  const doc = (A)=> A.dom.window.document;
  const drain = async (A)=>{ for(let i = 0; i < 6; i++){ A.api.run("UPDATE sc_outbox SET next_ts='' WHERE status='queued'"); await A.api.scTick(); if(!A.api.scWaitingCount()) break; } };

  const H1 = till("H1", { install_id:"HA01", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const H2 = till("H2", { install_id:"HA02", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE02", branch_type:"main" });
  const M1 = till("M1", { install_id:"MU01", shop_name:"Mandie Babyware", branch_name:"Murehwa", branch_id:"B-MUREHWA1", branch_type:"remote" });

  await t("(registration: Harare T1 + T2, Murehwa T1, on seiGEN)", async ()=>{
    let r = await H1.api.registerMainBranch("Counter");
    assert.ok(r.ok, JSON.stringify(r));
    r = await H1.api.issueJoinCode({ branchId: H1.api.getSetting("branch_uuid",""), seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await H2.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Back" })).ok);
    r = await H1.api.issueJoinCode({ newBranchName:"Murehwa", seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await M1.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Till 1", expectedBranchName:"Murehwa" })).ok);
    for(const A of [H1, H2, M1]){ await A.api.dsRefreshBranches(); const x = await A.api.scTick(); assert.ok(x.pull.ok, JSON.stringify(x)); }
    assert.ok(H1.api.scIsMain() && !M1.api.scIsMain());
  });

  // ---- rights ----
  await t("rights: the four new rights in the roles editor; built-in defaults as the prompt's table; the old right's new label", ()=>{
    const acts = Object.fromEntries(H1.api.ROLE_ACTION_RIGHTS);
    assert.strictEqual(acts.request_stock, "Request stock"); assert.strictEqual(acts.recall_stock, "Recall stock");
    assert.strictEqual(acts.count_stock, "Count stock (cycle)"); assert.strictEqual(acts.approve_counts, "Approve count differences");
    assert.strictEqual(acts.review_requisitions, "Review stock requests");
    const D = H1.api.ROLE_DEFAULTS, has = (r, k)=> D[r].includes(k);
    for(const k of ["request_stock","recall_stock","count_stock","approve_counts"]){ assert.ok(has("owner", k) && has("admin", k) && has("manager", k), k); assert.ok(!has("guest", k)); }
    assert.ok(has("stores","request_stock") && has("stores","count_stock") && !has("stores","recall_stock") && !has("stores","approve_counts"));
    assert.ok(has("cashier","request_stock") && !has("cashier","count_stock") && !has("cashier","recall_stock") && !has("cashier","approve_counts"));
  });

  // ---- cycle: the pure rules ----
  await t("cycle: A/B/C by value sold at cost (top 80% A, next 15% B, the rest and nothing sold C; an item across a line takes the higher class)", ()=>{
    // shares before each item: a 0%, b 50%, c 80%, d 90%, e 96%, f 99%
    const c = H1.api.cycleClasses({ a:500, b:300, c:100, d:60, e:30, f:10, z:0 });
    same(c, { a:"A", b:"A", c:"B", d:"B", e:"C", f:"C", z:"C" });
    same(H1.api.cycleClasses({ only:12, none:0 }), { only:"A", none:"C" }, "one product that sold: A");
  });
  await t("cycle: every red flag, with its reason", ()=>{
    const f = H1.api.cycleFlags({ stock:-2, lastDiff:true, returned30:3, soldAtZero:true, bigAdjust:true, receivedNotSold:true });
    same(f, ["Negative stock","Difference at the last count","3 returned in 30 days","Sold while showing 0","Large adjustment or write-off","Received, not sold since"]);
    same(H1.api.cycleFlags({ stock:4, returned30:2 }), []);
    const moves = [{ qty_delta:5, kind:"receive", ts:new Date(Date.now()-3*DAY).toISOString() }, { qty_delta:-6, kind:"sale", ts:new Date(Date.now()-2*DAY).toISOString() }, { qty_delta:3, kind:"receive", ts:new Date().toISOString() }];
    assert.strictEqual(H1.api.cycleSoldAtZero(moves, 2, Date.now()-30*DAY), true, "5 in, 6 sold -> -1 after the sale");
    assert.strictEqual(H1.api.cycleSoldAtZero(moves, 5, Date.now()-30*DAY), false);
  });
  await t("cycle: red flags first, then the most overdue (A first); never counted counts as overdue; size limit", ()=>{
    const now = Date.now(), set = { a:7, b:30, c:90, size:3 };
    const products = ["p1","p2","p3","p4","p5"].map((key)=>({ key }));
    const facts = { p1:{ stock:3, lastCountMs:now-2*DAY }, p2:{ stock:-1, lastCountMs:now-1*DAY }, p3:{ stock:4, lastCountMs:now-40*DAY },
      p4:{ stock:5, lastCountMs:now-10*DAY }, p5:{ stock:2, lastCountMs:now-100*DAY } };
    const classes = { p1:"A", p2:"C", p3:"B", p4:"A", p5:"C" };
    const list = H1.api.cycleChoose(products, facts, classes, now, set);
    same(list.map((x)=>x.key), ["p2","p3","p5"], JSON.stringify(list));
    assert.match(list[0].reason, /Negative stock/); assert.match(list[1].reason, /Class B, not counted for 40 days/);
    assert.ok(!list.some((x)=>x.key==="p1"), "an A counted 2 days ago isn't due");
  });

  // ---- Count now on Harare T2 (blind) ----
  let C1;
  await t("Count now: the day's list on the screen, grouped by shelf, each with its reason; blind: no expected figure anywhere", ()=>{
    const A = H2;
    A.api.moveStock({ productId:P(A, "RAT1").id, delta:-11, kind:"sale", docType:"sale", docNo:"R0", ts:new Date().toISOString() });   // a red flag: -1, sold at 0
    A.api.setSetting("cycle_list", "");
    const main = doc(A).createElement("div"); doc(A).body.appendChild(main);
    A.api.renderCountNow(main);
    const text = main.textContent;
    assert.match(text, /Rattle/); assert.match(text, /Negative stock/);
    assert.match(text, /Shelf A1/); assert.match(text, /No shelf/);
    for(const p of A.api.all("SELECT * FROM products WHERE branch='Harare'")) assert.ok(!new RegExp("\\b" + p.stock + " in stock").test(text));
    const items = [...main.querySelectorAll(".cycle-item")].map((x)=> x.textContent).join(" ");
    assert.ok(!/System|Expected|Difference|Variance/i.test(items), "no expected figure or difference on any item: " + items.slice(0, 300));
    assert.strictEqual(main.querySelectorAll(".cycle-qty").length, A.api.cycleList().length);
    main.remove();
  });
  await t("a count saves the stock at that moment (hidden), waits for approval and changes no stock", ()=>{
    const A = H2, item = A.api.cycleList().find((i)=> i.code==="BOT1") || (A.api.cycleAdd(["cat-bottle"], "test"), A.api.cycleList().find((i)=> i.code==="BOT1"));
    const r = A.api.cycleSaveCount(item, "37", "Tafara");
    assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.status, "waiting");
    C1 = r.id;
    const c = A.api.one("SELECT * FROM sc_counts WHERE id=?", [C1]);
    assert.strictEqual(c.system_qty, 40); assert.strictEqual(c.diff, -3);
    assert.strictEqual(P(A, "BOT1").stock, 40, "no stock change before approval");
    const main = doc(A).createElement("div"); A.api.renderCountNow(main);
    assert.match(main.querySelector(`.cycle-item[data-key="cat-bottle"]`).textContent, /Counted by Tafara: sent for checking/);
    assert.ok(!/-3|\b40\b|\b37\b/.test(main.querySelector(`.cycle-item[data-key="cat-bottle"]`).textContent), "neither the count, the system figure nor the difference");
    const z = A.api.cycleSaveCount(A.api.cycleList().find((i)=> i.code==="OIL2") || (A.api.cycleAdd(["cat-oil"]), A.api.cycleList().find((i)=> i.code==="OIL2")), "30", "Tafara");
    assert.strictEqual(z.status, "closed", "no difference: closed at once");
  });
  await t("offline: the count waits on the till; back online it goes to seiGEN once", async ()=>{
    H2.ctx.navigator.onLine = false;
    await H2.api.scTick();
    assert.strictEqual(H2.api.scWaitingCount(), 2);
    H2.ctx.navigator.onLine = true;
    await drain(H2); await drain(H2);
    assert.strictEqual(H2.api.scWaitingCount(), 0);
    assert.strictEqual((await q("select count(*)::int n from cl_cycle_counts"))[0].n, 2);
    assert.strictEqual((await q("select status from cl_cycle_counts where id=$1", [C1]))[0].status, "waiting");
  });
  await t("a sale between the count and the approval: approved on Harare T1, T2's stock moves by the counted difference once (an ADJ, Miscount correction)", async ()=>{
    // 2 bottles sold on T2 after the count: 40 -> 38; the shelf really holds 37 - 2 = 35
    H2.api.moveStock({ productId:P(H2, "BOT1").id, delta:-2, kind:"sale", docType:"sale", docNo:"R1", ts:new Date().toISOString() });
    await H1.api.scTick();
    assert.ok(H1.api.cycleWaiting().some((c)=> c.id===C1), "T1 (same branch) sees it waiting");
    const bad = H1.api.cycleDecide(C1, "approve", "0000");
    assert.strictEqual(bad.ok, false); assert.match(bad.message, /Incorrect Admin passcode/);
    const r = H1.api.cycleDecide(C1, "approve", "4321", "");
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(P(H1, "BOT1").stock, 40, "T1's own stock is not T2's: unchanged");
    await drain(H1);
    await H2.api.scTick(); await H2.api.scTick();
    assert.strictEqual(P(H2, "BOT1").stock, 35, "38 + (-3), never set to 37");
    const adj = H2.api.one("SELECT * FROM stock_adjustments ORDER BY id DESC LIMIT 1");
    assert.strictEqual(adj.reason, "Miscount correction"); assert.strictEqual(adj.qty_delta, -3);
    assert.match(adj.note, /Cycle count, counted by Tafara, approved by Boss/);
    assert.strictEqual(H2.api.all("SELECT * FROM stock_adjustments").length, 1, "once, however often it pulls");
    await drain(H2);
    const srv = (await q("select applied_at, adj_display, unit_cost::float c from cl_cycle_counts where id=$1", [C1]))[0];
    assert.ok(srv.applied_at && srv.adj_display && srv.c === 5, JSON.stringify(srv));
    same(H2.api.stockLedgerCheck().mismatches, [], "stock = the sum of its movements");
  });
  await t("a recount by another person: back on the list as 'Recount: not by X'; the same person is refused", async ()=>{
    const it = H2.api.cycleList().find((i)=> i.code==="NAP1") || (H2.api.cycleAdd(["cat-nappy"]), H2.api.cycleList().find((i)=> i.code==="NAP1"));
    const r = H2.api.cycleSaveCount(it, "20", "Tafara");
    assert.strictEqual(r.status, "waiting");
    assert.ok(H2.api.cycleDecide(r.id, "recount", "4321", "check the top shelf").ok);
    assert.strictEqual(P(H2, "NAP1").stock, 25, "no stock change");
    const again = H2.api.cycleList().find((i)=> i.recountOf===r.id);
    assert.ok(again && /Recount: not by Tafara/.test(again.reason), JSON.stringify(again));
    assert.match(H2.api.cycleSaveCount(again, "24", "Tafara").message, /someone other than Tafara/);
    const ok = H2.api.cycleSaveCount(again, "24", "Rudo");
    assert.ok(ok.ok); await drain(H2);
    assert.strictEqual((await q("select recount_of from cl_cycle_counts where id=$1", [ok.id]))[0].recount_of, r.id);
    assert.ok(H2.api.cycleDecide(ok.id, "reject", "4321", "").ok === false, "a reject needs a reason");
    assert.ok(H2.api.cycleDecide(ok.id, "reject", "4321", "will do a full stocktake").ok);
    assert.strictEqual(P(H2, "NAP1").stock, 25, "rejected: no stock change");
  });
  await t("Approvals screen: the difference and value for the approver; shrinkage: units and value, units only without View costs", ()=>{
    const A = H2, main = doc(A).createElement("div");
    const it = A.api.cycleList().find((i)=> i.code==="RAT1");
    const r = A.api.cycleSaveCount(it, "2", "Rudo");
    A.api.renderCountApprovals(main);
    const row = main.querySelector(`[data-cc="${r.id}"]`).textContent;
    assert.match(row, /Rattle/); assert.match(row, /\+3/);
    const from = new Date(Date.now()-DAY).toISOString(), to = new Date(Date.now()+DAY).toISOString();
    let s = A.api.shrinkageReport(from, to);
    assert.ok(s.headers.includes("Value at cost"));
    assert.match(s.footer, /-3 units · \$-15\.00 at cost/);
    A.ctx.can = (k)=> k!=="costs";
    s = A.api.shrinkageReport(from, to);
    assert.ok(!s.headers.includes("Value at cost")); assert.match(s.footer, /values need View costs/);
    const sh = doc(A).createElement("div"); A.api.renderShrinkage(sh);
    assert.match(sh.querySelector("#shNoCosts").textContent, /units only/); assert.match(sh.querySelector("#shTop").textContent, /Baby bottle/);
    delete A.ctx.can;
    assert.ok(A.api.REPORT_CONFIGS.some((c)=> c.id==="shrinkage"));
  });

  await t("a till not on seiGEN: Count now works on its own (Save on the screen, approve with the Admin passcode, stock moves; nothing queued)", ()=>{
    const S = makeApp({ setup_complete:"1", shop_name:"Solo Shop", branch_name:"Main", branch_type:"main", currency:"$" }, { dom:true });
    S.hook("alert", ()=>{});
    S.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Boss','Admin','4321','Main',1,?)", [new Date().toISOString()]);
    S.api.run("INSERT INTO products(name,price,cost,stock,low_threshold,sku,branch,created_ts) VALUES('Soap',2,1,-4,2,'SOAP','Main','2026-01-01')");
    S.api.recordStockMovement(S.api.one("SELECT id FROM products").id, -4, { kind:"import", ts:"2026-01-01T00:00:00Z" });
    const main = S.dom.window.document.createElement("div"); S.dom.window.document.body.appendChild(main);
    S.api.renderCountNow(main);
    const inp = main.querySelector(".cycle-qty");
    assert.ok(inp, "Soap is on the list (negative stock)");
    main.querySelector("#cycleBy").value = "Solo"; main.querySelector("#cycleBy").oninput();
    inp.value = "3"; main.querySelector("[data-save]").onclick();
    const c = S.api.one("SELECT * FROM sc_counts");
    assert.strictEqual(c.status, "waiting"); assert.strictEqual(c.diff, 7); assert.strictEqual(c.counted_by, "Solo");
    assert.ok(S.api.cycleDecide(c.id, "approve", "4321", "").ok);
    assert.strictEqual(S.api.one("SELECT stock FROM products").stock, 3);
    assert.strictEqual(S.api.one("SELECT COUNT(*) AS n FROM sc_outbox").n, 0, "not on seiGEN: nothing queued");
  });

  // ---- shelves per branch ----
  await t("shelf per branch: Murehwa's own shelf stays when main's catalogue arrives; sent to seiGEN; an import queues it", async ()=>{
    M1.api.run("UPDATE products SET shelf='M7' WHERE sku='OIL2'");
    assert.strictEqual(M1.api.one("SELECT shelf FROM sc_shelves WHERE product_key='cat-oil'").shelf, "M7");
    await drain(M1);
    assert.strictEqual((await q("select shelf from cl_branch_shelves where product_key='cat-oil' and branch_id=$1", [M1.api.getSetting("branch_uuid","")]))[0].shelf, "M7");
    M1.api.setSetting("cat_applying","1");
    M1.api.catApplyProduct({ uid:"cat-oil", code:"OIL2", name:"Cooking oil 2L", price:6, cost:3, shelf:"H9", active:true, seq:5, low_threshold:2 }, false);
    M1.api.catApplyProduct({ uid:"cat-nappy", code:"NAP1", name:"Nappies L", price:16, cost:8, shelf:"H3", active:true, seq:6, low_threshold:2 }, false);
    M1.api.setSetting("cat_applying","");
    assert.strictEqual(P(M1, "OIL2").shelf, "M7", "the branch's own shelf stays");
    assert.strictEqual(P(M1, "NAP1").shelf, "H3", "no shelf of its own: main's, as before");
    const pl = await H1.api.scTick();
    assert.ok(!(await q("select 1 from cl_branch_shelves where branch_id=$1 and product_key='cat-oil'", [H1.api.getSetting("branch_uuid","")])).length, "Harare's shelves are its own");
    const parsed = M1.api.parseImportRows([{ "Item Name":"Rattle", "SKU":"RAT1", "Shelf":"Z1", "Price":2 }]);
    const wrap = doc(M1).createElement("div"); wrap.innerHTML = '<div class="modal-body"></div>';
    M1.api.runImport(wrap, M1.api.classifyImportRows(parsed.rows), false);
    assert.strictEqual(P(M1, "RAT1").shelf, "Z1");
    assert.strictEqual(M1.api.one("SELECT shelf FROM sc_shelves WHERE product_key='cat-rattle'").shelf, "Z1", "the import's shelf is this branch's, queued");
    await drain(M1);
    assert.strictEqual((await q("select shelf from cl_branch_shelves where product_key='cat-rattle' and branch_id=$1", [M1.api.getSetting("branch_uuid","")]))[0].shelf, "Z1");
  });

  // ---- stock requests ----
  let R1, D1;
  await t("a stock request from Murehwa: shows main's stock, queued, sent once; main's reviewer is notified (titles only)", async ()=>{
    await M1.api.bsPull().catch(()=>{});
    const r = M1.api.srqCreate([{ product:P(M1, "BOT1"), qty:"10" }, { product:P(M1, "OIL2"), qty:"4" }], "Weekend promotion", "2026-11-01");
    assert.ok(r.ok, JSON.stringify(r)); R1 = r.id;
    assert.match(r.req_no, /^SRQ-T1-0001$/);
    assert.strictEqual(M1.api.scRequest(R1)._local, true);
    await drain(M1);
    assert.strictEqual((await q("select status, req_no from cl_stock_requests where id=$1", [R1]))[0].status, "pending");
    const b = await H1.api.bellTick();
    assert.ok(b.fresh >= 1, JSON.stringify(b));
    const n = H1.api.bellVisible().find((x)=> x.key==="srq:new:"+R1);
    assert.strictEqual(n.title, "New stock request SRQ-T1-0001 from Murehwa");
    assert.ok(!/\$|\d+\.\d\d/.test(n.title), "no amounts");
  });
  await t("main part-approves with a reason; Murehwa sees the status and reason, and is notified", async ()=>{
    assert.strictEqual(H1.api.srqDecide(R1, "part", "", { 1:10, 2:2 }).ok, true);
    await drain(H1);
    assert.strictEqual((await q("select status, decision_note from cl_stock_requests where id=$1", [R1]))[0].status, "part_approved");
    await M1.api.bellTick();
    const q1 = M1.api.scRequest(R1);
    assert.strictEqual(q1.status, "part_approved"); assert.strictEqual(q1.lines[1].approved_qty, 2);
    assert.ok(M1.api.bellVisible().some((x)=> x.title==="Stock request SRQ-T1-0001: Part-approved"));
  });
  await t("Create dispatch: the draft DN pre-filled with the approved quantities, linked; GRV at Murehwa: Received at both ends", async ()=>{
    const pre = H1.api.srqDispatchPrefill(H1.api.scRequest(R1));
    same(pre.lines.map((l)=>[l.product.sku, l.qty]), [["BOT1",10],["OIL2",2]]);
    assert.strictEqual(pre.toBranch, "Murehwa"); assert.strictEqual(pre.link.type, "request");
    const mb = H1.api.dsBranchFor("Murehwa");
    const dn = H1.api.dnCommitDispatch({ branch:"Harare", toBranch:"Murehwa", now:new Date(), internalRef:pre.internalRef, lines:pre.lines, link:pre.link,
      srv:{ toBranchId:mb.id, delivery:{ cost:0 } } });
    D1 = H1.api.dnHeaderFor(dn.n).srv_id;
    await H1.api.dsSendPending(); await drain(H1);
    assert.strictEqual((await q("select status, dispatch_id from cl_stock_requests where id=$1", [R1]))[0].status, "dispatched");
    await M1.api.dsPull();
    const r = await M1.api.dsPostGrv(D1, { 1:{ received:10, damaged:0, extra:0 }, 2:{ received:2, damaged:0, extra:0 } }, { 1:P(M1,"BOT1").id, 2:P(M1,"OIL2").id });
    assert.ok(r.ok, JSON.stringify(r));
    await M1.api.scTick(); await H1.api.scTick();
    for(const A of [M1, H1]){ const x = A.api.scRequest(R1); assert.strictEqual(x.status, "received", A.name); assert.ok(x.dn_display && x.grv_display, JSON.stringify(x)); }
    const actions = M1.api.scRequest(R1).log.map((g)=> g.action);
    same(actions, ["requested","part_approved","dispatched","received"]);
    const rep = H1.api.srqReport();
    assert.match(rep.footer, /1 request/); assert.ok(rep.rows[0][0].includes("Murehwa"));
  });
  await t("decision 48: on a till in staff sign-in mode with nobody signed in, seiGEN refuses; the request waits (not lost) and shows why", async ()=>{
    await q("update cl_terminals set staff_mode='roles' where id=$1", [M1.api.getSetting("terminal_id","")]);
    const r = M1.api.srqCreate([{ product:P(M1, "NAP1"), qty:"1" }], "test", "");
    await drain(M1);
    const w = M1.api.scWaitingFor(r.id);
    assert.strictEqual(w.length, 1); assert.strictEqual(w[0].code, "STAFF_SIGN_IN");
    assert.strictEqual((await q("select count(*)::int n from cl_stock_requests where id=$1", [r.id]))[0].n, 0);
    await q("update cl_terminals set staff_mode='single' where id=$1", [M1.api.getSetting("terminal_id","")]);
    await drain(M1);
    assert.strictEqual((await q("select count(*)::int n from cl_stock_requests where id=$1", [r.id]))[0].n, 1, "sent once allowed");
  });

  // ---- recalls ----
  let K1;
  await t("a recall from main: Murehwa is notified; the recall alone moves no stock; overdue after the due date", async ()=>{
    const r = H1.api.rclCreate(M1.api.getSetting("branch_uuid",""), "expiring", "", "2026-10-01", [{ product:P(H1,"BOT1"), qty:"6" }, { product:P(H1,"NAP1"), all:true }]);
    assert.ok(r.ok, JSON.stringify(r)); K1 = r.id;
    await drain(H1);
    const before = P(M1, "BOT1").stock;
    await M1.api.bellTick();
    assert.ok(M1.api.bellVisible().some((x)=> x.key==="rcl:new:"+K1 && /^Recall RCL-T1-0001: send stock back to Harare by 2026-10-01$/.test(x.title)));
    assert.strictEqual(P(M1, "BOT1").stock, before, "no stock change");
    assert.strictEqual(M1.api.rclOverdue(M1.api.scRecall(K1)), true);
    const main = doc(M1).createElement("div"); M1.api.setSrqTab("recalls"); M1.api.renderStockCtl(main);
    assert.match(main.querySelector("#rclTable").textContent, /Overdue/);
  });
  await t("Murehwa sends back with a short line (reason required) -> DN to main, 'Transport paid by receiver: main'; main's GRV -> Received", async ()=>{
    const q0 = M1.api.scRecall(K1);
    let plan = M1.api.rclSendBackPlan(q0, { 1:{ sent:4 } });
    assert.match(plan.message, /2 short\. Say why/);
    plan = M1.api.rclSendBackPlan(q0, { 1:{ sent:4, reason:"2 sold before the recall" } });
    assert.ok(plan.ok, JSON.stringify(plan));
    same(plan.pre.lines.map((l)=>[l.product.sku, l.qty]), [["BOT1",4],["NAP1",25]], "all on hand: what Murehwa holds");
    assert.match(plan.pre.note, /Transport is paid by the receiver \(main\)/);
    const stockBefore = P(M1, "BOT1").stock;
    const hb = M1.api.dsBranchFor("Harare");
    const dn = M1.api.dnCommitDispatch({ branch:"Murehwa", toBranch:"Harare", now:new Date(), internalRef:plan.pre.internalRef, lines:plan.pre.lines, link:plan.pre.link,
      srv:{ toBranchId:hb.id, delivery:{ cost:5, currency:"USD", carrier:"Kombi", ref:"" } } });
    assert.strictEqual(P(M1, "BOT1").stock, stockBefore - 4, "stock leaves only with the DN");
    const D3 = M1.api.dnHeaderFor(dn.n).srv_id;
    await M1.api.dsSendPending(); await drain(M1);
    assert.strictEqual((await q("select status from cl_stock_recalls where id=$1", [K1]))[0].status, "partly_sent");
    await H1.api.dsPull();
    const g = await H1.api.dsPostGrv(D3, { 1:{ received:4, damaged:0, extra:0 }, 2:{ received:25, damaged:0, extra:0 } }, { 1:P(H1,"BOT1").id, 2:P(H1,"NAP1").id });
    assert.ok(g.ok, JSON.stringify(g));
    assert.strictEqual((await q("select owed_by_branch_id = $1 m from cl_interbranch_charges where dispatch_id=$2", [H1.api.getSetting("branch_uuid",""), D3]))[0].m, true, "main owes the transport");
    await H1.api.bellTick();
    const k = H1.api.scRecall(K1);
    assert.strictEqual(k.status, "received"); assert.strictEqual(k.lines[0].short_qty, 2);
    assert.match(H1.api.rclReport().footer, /0 open · 0 overdue · 1 with shortages/);
  });
  await t("cancelling a recall (decision 56): a reason is required; the maker cancels; not someone else's; never after its DN is sent", async ()=>{
    assert.match(H1.api.rclCancel(K1, "too late").message, /no Delivery Note sent/, "received: its DN was sent");
    const r = H1.api.rclCreate(M1.api.getSetting("branch_uuid",""), "overstock", "", "2099-01-01", [{ product:P(H1,"BOT1"), qty:"1" }]);
    assert.ok(r.ok, JSON.stringify(r));
    await drain(H1);
    assert.match(H1.api.rclCancel(r.id, "   ").message, /reason/, "a blank reason is refused");
    const other = Object.assign({}, H1.api.scRecall(r.id), { created_staff_id:"00000000-0000-4000-8000-000000000001" });
    assert.strictEqual(H1.api.rclCanCancel(other), false, "someone else's recall: no Cancel for a single operator till");
    assert.strictEqual(H1.api.rclCanCancel(Object.assign({}, other, { created_staff_id:null, terminal_id:"another-till" })), false, "made on another till");
    const c = H1.api.rclCancel(r.id, "stock is fine at Murehwa");
    assert.ok(c.ok, JSON.stringify(c));
    await drain(H1);
    const row = (await q("select status, cancel_note from cl_stock_recalls where id=$1", [r.id]))[0];
    assert.strictEqual(row.status, "cancelled"); assert.strictEqual(row.cancel_note, "stock is fine at Murehwa");
    assert.strictEqual((await q("select count(*)::int n from cl_stock_ctl_log where doc_id=$1 and action='cancelled'", [r.id]))[0].n, 1, "logged");

    // the offline gap (accepted): Murehwa still sees the recall open and sends its DN; the link is refused,
    // and the person who cancelled gets a bell notice to receive it with a GRV
    await M1.api.scPull();
    const mq = Object.assign({}, M1.api.scRecall(r.id), { status:"open" });
    M1.api.run("UPDATE sc_recalls SET json=?, status='open' WHERE id=?", [JSON.stringify(mq), r.id]);
    const plan = M1.api.rclSendBackPlan(M1.api.scRecall(r.id), { 1:{ sent:1 } });
    assert.ok(plan.ok, JSON.stringify(plan));
    const hb = M1.api.dsBranchFor("Harare");
    const dn = M1.api.dnCommitDispatch({ branch:"Murehwa", toBranch:"Harare", now:new Date(), internalRef:plan.pre.internalRef, lines:plan.pre.lines, link:plan.pre.link,
      srv:{ toBranchId:hb.id, delivery:{ cost:0, currency:"USD", carrier:"", ref:"" } } });
    await M1.api.dsSendPending(); await drain(M1);
    const refused = M1.api.all("SELECT code FROM sc_outbox WHERE doc_id=? AND type='recall_link'", [r.id]);
    assert.strictEqual(refused.map((x)=>x.code).join(","), "WRONG_STATUS", "the link to the cancelled recall is refused");
    await H1.api.bellTick();
    const note = H1.api.bellVisible().find((x)=> x.key.startsWith("rcl:dncx:"));
    assert.ok(note, "a notice for the person who cancelled");
    assert.match(note.title, new RegExp("^Stock from Murehwa arrived on DN-\\S+ for cancelled recall " + mq.rcl_no + "; receive it with a GRV$"), note.title);
    assert.strictEqual(note.person, "device");
    H1.api.run("UPDATE notices SET person='staff:someone-else' WHERE key=?", [note.key]);
    assert.ok(!H1.api.bellVisible().some((x)=> x.key===note.key), "nobody else sees it");
    H1.api.run("UPDATE notices SET hidden=1 WHERE key=?", [note.key]);   // kept (never added twice), out of the per-person counts below
  });

  // ---- the bell ----
  await t("bell: no duplicates after repeated syncs; the chime once per new event, and only when on", async ()=>{
    const A = H1;
    await A.api.bellTick();
    const n0 = A.api.all("SELECT * FROM notices").length;
    await A.api.bellTick(); await A.api.bellTick();
    A.api.bellFromChanges({ requests:[{ q:A.api.scRequest(R1), was:null }], recalls:[], counts:[], dispatches:[], market:[] });
    assert.strictEqual(A.api.all("SELECT * FROM notices").length, n0, "the same events again: nothing new");
    let chimes = 0; A.ctx.AudioContext = function(){ chimes++; return { state:"running", currentTime:0, destination:{}, createOscillator:()=>({ connect(){}, start(){}, stop(){}, frequency:{} }), createGain:()=>({ connect(){}, gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} } }) }; };
    A.dom.window.AudioContext = A.ctx.AudioContext;
    A.api.bellAdd("test:1", "requests", "Test notice", { right:"review_requisitions" });
    let a = A.api.bellAnnounce(); assert.strictEqual(a.chimed, true);
    a = A.api.bellAnnounce(); assert.strictEqual(a.count, undefined, "never twice for one key");
    A.api.setSetting("bell_sound_device", "0");
    A.api.bellAdd("test:2", "requests", "Test notice 2", {});
    a = A.api.bellAnnounce(); assert.strictEqual(a.chimed, false, "sound off for this person");
    A.api.setSetting("bell_sound_device", "1");
  });
  await t("bell: the unread count is per person; Mark all read; each category only for people with its right", ()=>{
    const A = H1;
    const total = A.api.bellUnread();
    assert.ok(total > 0);
    A.api.bellMarkAllRead();
    assert.strictEqual(A.api.bellUnread(), 0, "the device (single operator) has read them");
    A.ctx.staffSession = ()=>({ id:"11111111-1111-4111-8111-111111111111", name:"Rudo" });
    assert.strictEqual(A.api.bellPerson(), "staff:11111111-1111-4111-8111-111111111111");
    assert.strictEqual(A.api.bellUnread(), total, "Rudo hasn't read them");
    A.ctx.can = (r)=> ["m.sell","request_stock"].includes(r);   // a Cashier
    const cats = new Set(A.api.bellVisible().map((n)=> n.category));
    assert.ok(!A.api.bellVisible().some((n)=> n.key.startsWith("srq:new:")), "new requests: reviewers only");
    assert.ok(!cats.has("counts"), "counts: approve_counts only");
    delete A.ctx.can; delete A.ctx.staffSession;
  });
  await t("bell: the Market feed reaches every device; a Guest's seat sees only the Market feed; the bell button and settings", async ()=>{
    await q(`insert into cl_market_feed (title, body) values ('School shoes week', 'All week at every shop.')`);
    await M1.api.bellTick();
    assert.ok(M1.api.bellVisible().some((n)=> n.category==="market" && n.title==="School shoes week"));
    M1.api.setSetting("seat_guest", "1");
    assert.ok(M1.api.bellVisible().every((n)=> n.category==="market"));
    M1.api.setSetting("seat_guest", "");
    const html = M1.api.bellButtonHtml();
    assert.match(html, /bell-btn/); assert.match(html, /bell-badge/);
    const card = doc(M1).createElement("div"); card.innerHTML = M1.api.bellSettingsHtml(); M1.api.bellSettingsWire(card);
    assert.match(card.textContent, /Browsers allow sound only after you've tapped the app once since opening it/);
    assert.strictEqual(card.querySelectorAll("[data-bell-cat]").length, M1.api.BELL_CATEGORIES.length);
    card.querySelector('[data-bell-cat="market"]').checked = false; card.querySelector('[data-bell-cat="market"]').onchange();
    assert.ok(!M1.api.bellVisible().some((n)=> n.category==="market"), "a category switched off for this person");
  });
  await t("bell: the 60 s check pauses while hidden and never runs twice at once", async ()=>{
    const A = M1;
    Object.defineProperty(doc(A), "visibilityState", { configurable:true, get:()=> "hidden" });
    same(await A.api.bellTick(), { skipped:"hidden" });
    Object.defineProperty(doc(A), "visibilityState", { configurable:true, get:()=> "visible" });
    const [x, y] = await Promise.all([A.api.bellTick(), A.api.bellTick()]);
    assert.ok([x, y].some((r)=> r.skipped==="busy"), JSON.stringify([x, y]));
  });
  await t("bell: titles only, everywhere (no amounts, prices or customers)", ()=>{
    for(const A of [H1, H2, M1]) for(const n of A.api.all("SELECT * FROM notices")) assert.ok(!/\$\s?\d|\d+\.\d\d\b/.test(n.title), n.title);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
