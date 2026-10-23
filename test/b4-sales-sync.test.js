// node --no-warnings test/b4-sales-sync.test.js
//
// B4, sales sync (v35; owner decisions 3, 28, 30, 31, 35-38). Tills running the
// REAL app code (test/harness.js with opts.b4) against the REAL server SQL in
// PGlite (the live shape + 20261113120000_sales_sync), never the live database:
//   - a pre-B4 till upgrades: its first B4 check-in sends the last 90 days as
//     history and each customer's older balance brought forward; nothing older,
//     nothing merged in from another device; the business balance equals the
//     till's own; never twice (a second start, a restore, a resend);
//   - the 90-day boundary;
//   - every kind of event syncs once, after retries, lost answers, offline blips
//     and an app restart in the middle of a send;
//   - two tills, one customer, online at the same time: only one gets the last
//     available credit; the other is blocked (the override flow, decision 30);
//   - offline credit (decision 3): the balance at the last sync plus this till's
//     credit sales since; "checked offline" on the sale, the receipt and the report;
//   - an override syncs with the "single operator" flag;
//   - a flaky 2G line: every priority-1 event arrives, money first, nothing twice,
//     batches shrink after timeouts;
//   - selling never waits: a cash sale is saved with the network hung; a credit
//     sale falls back to the offline rule after the short timeout;
//   - the sync line on the Sell screen; another branch's sales in Report Writer.
"use strict";
process.env.TZ = "Africa/Harare";
const assert = require("assert");
const vm = require("vm");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
const TILLS = [];
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); }
  finally{ for(const A of TILLS){ A.ctx.navigator.onLine = true; A.net = "ok"; } }   // a failed test leaves no till offline
}
const sleep = (ms)=> new Promise((r)=> setTimeout(r, ms));
const DAY = 86400000;

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== "20261113120000_sales_sync.sql") });   // the live shape + B4
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
  // net: per till, how its line behaves: "ok" | "down" (fails before seiGEN) | "lose" (seiGEN answers, the answer is lost) | "hang" | a function -> one of those
  function till(name, settings){
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:"Mandie Phrase", install_date:"2026-09-01", currency:"$" }, settings), { dom:true, b4:true });
    A.name = name; A.net = "ok"; A.alerts = []; TILLS.push(A);
    A.hook("alert", (m)=>{ A.alerts.push(String(m)); });
    A.hook("printReceipt", ()=>{});
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      const mode = typeof A.net === "function"? A.net(m[1]) : A.net;
      if(mode === "down") throw new TypeError("Failed to fetch");
      if(mode === "hang") return new Promise((res, rej)=>{ if(opts.signal) opts.signal.addEventListener("abort", ()=> rej(new Error("aborted"))); });
      calls.push({ till:name, fn:m[1], body:opts.body });
      const r = await serial(()=> rpcNow(m[1], JSON.parse(opts.body)));
      if(mode === "lose") throw new TypeError("Failed to fetch");   // seiGEN did it; the answer never came back
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Boss','Admin','4321',?,1,?)", [A.api.currentBranch(), new Date().toISOString()]);
    A.api.run("INSERT INTO products(name,price,cost,stock,low_threshold,sku,branch,created_ts) VALUES('Bib',10,6,1000,2,'BIB1',?,?)", [A.api.currentBranch(), "2026-01-01"]);
    A.api.startShift("0", new Date());
    return A;
  }
  const bib = (A)=> A.api.one("SELECT * FROM products WHERE sku='BIB1'");
  // a sale through the real checkout (pos.js completeSale); resolves when it's written or refused
  // o.otherBranchAdmin: answer the "customer from another branch" box (Q5, offline) with this Admin passcode
  async function sell(A, qty, method, customer, o){
    const p = bib(A);
    A.api.setCart([{ product_id:p.id, name:p.name, price:p.price, qty, stock:p.stock, level:"retail", retail_price:p.price }]);
    if(customer) A.api.setCartCustomer(A.api.one("SELECT * FROM customers WHERE id=?", [customer.id]));
    const n0 = A.api.one("SELECT COUNT(*) n FROM sales").n, a0 = A.alerts.length;
    A.dom.window.document.querySelectorAll(".modalOverlay").forEach((m)=> m.remove());
    A.api.completeSale(method);
    for(let i = 0; i < 400; i++){
      if(A.api.one("SELECT COUNT(*) n FROM sales").n > n0 || A.alerts.length > a0 || A.dom.window.document.querySelector("#clText")) break;
      const xc = A.dom.window.document.querySelector("#xcPass");
      if(xc) A.lastXc = A.dom.window.document.querySelector("#xcText").textContent;
      if(xc && o && o.otherBranchAdmin){ xc.value = o.otherBranchAdmin; await A.dom.window.document.querySelector("#xcGo").onclick(); }
      else if(xc) break;
      await sleep(25);
    }
    const s = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    return A.api.one("SELECT COUNT(*) n FROM sales").n > n0? s : null;
  }
  const boxText = (A)=>{ const el = A.dom.window.document.querySelector("#clText"); return el? el.textContent : ""; };
  async function drain(A, rounds){
    for(let i = 0; i < (rounds || 20); i++){
      A.api.run("UPDATE b4_outbox SET next_ts='' WHERE status='queued'");
      await A.api.b4Tick();
      if(!A.api.b4WaitingCount()) break;
    }
  }
  const srvCount = async (table, where, p)=> (await q(`select count(*)::int n from ${table}${where? " where " + where : ""}`, p||[]))[0].n;
  const srvBalance = async (uid)=> Number((await q("select cl_b4_balance(b.id, $1) b from cl_businesses b where b.name='Mandie Babyware'", [uid]))[0].b);

  const H1 = till("H1", { install_id:"HA01", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const H2 = till("H2", { install_id:"HA02", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE02", branch_type:"main" });
  const M1 = till("M1", { install_id:"MU01", shop_name:"Mandie Babyware", branch_name:"Murehwa", branch_id:"B-MUREHWA1", branch_type:"remote" });

  // ---- H1 before B4: four months of its own sales, and a sale merged in from Murehwa ----
  const now = Date.now(), ago = (d)=> new Date(now - d*DAY).toISOString();
  H1.api.run("INSERT INTO customers(name,phone,phone_norm,branch,customer_type,credit_limit) VALUES('Chipo Traders','0782223333','263782223333','Harare','wholesale',100)");
  const chipoH1 = H1.api.one("SELECT * FROM customers WHERE name='Chipo Traders'");
  const oldSale = (A, d, total, method, custId, extra)=>{
    A.api.run(`INSERT INTO sales(ts,subtotal,discount,total,method,customer_id,branch,user${extra? ",merged_ts" : ""}) VALUES(?,?,0,?,?,?,?,'Boss'${extra? ",?" : ""})`,
      [ago(d), total, total, method, custId||null, extra? "Murehwa" : A.api.currentBranch()].concat(extra? [ago(d)] : []));
    const id = A.api.one("SELECT last_insert_rowid() AS id").id;
    A.api.run("INSERT INTO sale_payments(sale_id,method,amount,currency,rate,tendered_amount) VALUES(?,?,?,'BASE',1,?)", [id, method, total, total]);
    A.api.run("INSERT INTO sale_items(sale_id,product_id,name,price,qty,cost) VALUES(?,?,?,?,1,?)", [id, bib(A).id, "Bib", total, total*0.6]);
    return A.api.one("SELECT * FROM sales WHERE id=?", [id]);
  };
  const preWindow = oldSale(H1, 120, 30, "Credit", chipoH1.id);       // older than 90 days: brought forward, not sent
  const edgeOut = oldSale(H1, 91, 4, "Cash");                          // just outside the window
  const edgeIn = oldSale(H1, 89, 6, "Cash");                           // just inside
  const hist = oldSale(H1, 10, 20, "Credit", chipoH1.id);
  const merged = oldSale(H1, 5, 50, "Cash", null, true);               // Murehwa's, merged into main's database
  H1.api.run("INSERT INTO credit_payments(customer_id,ts,amount,note,branch,user) VALUES(?,?,10,'',?,'Boss')", [chipoH1.id, ago(5), "Harare"]);
  H1.api.run("INSERT INTO payouts(ts,amount,reason,branch,user) VALUES(?,3,'Fuel',?,'Boss')", [ago(3), "Harare"]);
  H1.api.run("INSERT INTO price_changes(ts,product_id,product_name,sku,branch,old_price,new_price,cost) VALUES(?,?,'Bib','BIB1','Harare',9,10,6)", [ago(4), bib(H1).id]);
  const tillBalance = H1.api.customerBalance(chipoH1.id);

  await t("(registration: Harare T1 + T2, Murehwa T1; Chipo on seiGEN and on every till)", async ()=>{
    let r = await H1.api.registerMainBranch("Counter");
    assert.ok(r.ok, JSON.stringify(r));
    r = await H1.api.issueJoinCode({ branchId: H1.api.getSetting("branch_uuid",""), seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await H2.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Back" })).ok);
    r = await H1.api.issueJoinCode({ newBranchName:"Murehwa", seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await M1.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Till 1", expectedBranchName:"Murehwa" })).ok);
    H1.api.run("UPDATE customers SET srv_status='queued' WHERE id=?", [chipoH1.id]);
    await H1.api.custSendPending();
    assert.strictEqual(H1.api.one("SELECT srv_status FROM customers WHERE id=?", [chipoH1.id]).srv_status, "sent");
    await H2.api.custPull(); await M1.api.custPull();
    assert.ok(H2.api.one("SELECT * FROM customers WHERE uid=?", [chipoH1.uid]) && M1.api.one("SELECT * FROM customers WHERE uid=?", [chipoH1.uid]));
  });

  await t("a pre-B4 till's first B4 check-in: the 90 days as history, the older balance brought forward; nothing older, nothing merged in", async ()=>{
    assert.strictEqual(H1.api.b4Started(), false);
    await H1.api.b4AfterCheckin();
    assert.ok(H1.api.b4Started());
    await drain(H1);
    const sales = await q("select uid, history from cl_sales order by sold_at");
    const uids = sales.map((x)=> x.uid);
    assert.ok(uids.includes(edgeIn.uid) && uids.includes(hist.uid), "the window's sales");
    assert.ok(!uids.includes(edgeOut.uid) && !uids.includes(preWindow.uid), "nothing older than 90 days");
    assert.ok(!uids.includes(merged.uid), "nothing merged in from another device");
    assert.ok(sales.every((x)=> x.history === true), "marked history");
    assert.strictEqual(await srvCount("cl_credit_payments"), 1); assert.strictEqual(await srvCount("cl_payouts"), 1);
    assert.strictEqual(await srvCount("cl_price_change_log"), 1);
    assert.strictEqual(Number((await q("select amount from cl_credit_bf"))[0].amount), 30, "the $30 from 120 days ago, brought forward");
    assert.strictEqual(await srvBalance(chipoH1.uid), tillBalance, "the business balance equals the till's own: " + tillBalance);
    assert.strictEqual(tillBalance, 40);
  });

  await t("never twice: a second start, the history again (a restored backup), a resend: seiGEN still holds each once", async ()=>{
    assert.strictEqual(H1.api.b4Begin(), false, "b4_start is set once");
    const n = await srvCount("cl_sales");
    H1.api.run("DELETE FROM b4_outbox"); H1.api.run("DELETE FROM settings WHERE key LIKE 'b4_%'");   // as if an older backup came back
    await H1.api.b4AfterCheckin(); await drain(H1);
    assert.strictEqual(await srvCount("cl_sales"), n);
    assert.strictEqual(await srvCount("cl_credit_bf"), 1);
    assert.strictEqual(await srvBalance(chipoH1.uid), 40);
    assert.ok(H1.api.one("SELECT COUNT(*) n FROM b4_outbox WHERE code='duplicate'").n > 0, "seiGEN answered 'duplicate'");
  });

  await t("the 90-day boundary: 89 days in, 91 days out", async ()=>{
    const ws = H1.api.b4WindowStart();
    assert.ok(H1.api.businessDateToday && ws < new Date(now - 89*DAY).toISOString().slice(0, 10) && ws > new Date(now - 92*DAY).toISOString().slice(0, 10), ws);
    assert.strictEqual(await srvCount("cl_sales", "uid=$1", [edgeIn.uid]), 1);
    assert.strictEqual(await srvCount("cl_sales", "uid=$1", [edgeOut.uid]), 0);
  });

  for(const A of [H2, M1]){ await A.api.b4AfterCheckin(); await drain(A); }

  await t("every kind syncs once, live (not history), after a lost answer and an offline blip", async ()=>{
    const s = await sell(H2, 2, "Cash");
    assert.ok(s, "sold");
    H2.api.run("INSERT INTO credit_payments(customer_id,ts,amount,note,branch,user) VALUES(?,?,5,'paid at T2',?,'Rudo')",
      [H2.api.one("SELECT id FROM customers WHERE uid=?", [chipoH1.uid]).id, new Date().toISOString(), "Harare"]);
    H2.api.run("INSERT INTO payouts(ts,amount,reason,branch,user) VALUES(?,2,'Bread',?,'Rudo')", [new Date().toISOString(), "Harare"]);
    H2.api.run("INSERT INTO vouchers(customer_id,amount,branch,earned_ts,status) VALUES(NULL,1,'Harare',?, 'Available')", [new Date().toISOString()]);
    H2.api.run(`INSERT INTO credit_notes(branch,cn_branch_id,cn_no,till_code,sale_id,sale_uid,sale_receipt,ts,reason,approved_by,goods_total,cost_reversed)
                VALUES('Harare','B-HARARE02',1,'T2',?,?,?,?,'Damaged','Boss',10,6)`, [s.id, s.uid, s.receipt_no||"", new Date().toISOString()]);
    const cn = H2.api.one("SELECT * FROM credit_notes ORDER BY id DESC LIMIT 1");
    H2.api.run("INSERT INTO credit_note_refunds(cn_id,method,amount) VALUES(?,'Cash',10)", [cn.id]);
    H2.api.run("UPDATE products SET price=11 WHERE sku='BIB1'");
    H2.api.completeEOD("10", "", new Date());
    H2.api.startShift("0", new Date());                                  // the next shift, for the sales below
    H2.api.b4ScanLive();
    const kinds = H2.api.all("SELECT kind FROM b4_outbox WHERE status='queued' ORDER BY kind").map((x)=> x.kind);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(kinds)), ["credit_payment","eod","payout","price_change","return","sale","voucher_issue"]);
    H2.net = "lose"; await H2.api.b4SendNow();                          // seiGEN stores them, the answer is lost
    assert.ok(H2.api.b4WaitingCount() > 0, "not marked sent without an answer");
    H2.ctx.navigator.onLine = false; await H2.api.b4SendNow(); H2.ctx.navigator.onLine = true;   // an offline blip: nothing sent
    H2.net = "ok"; await drain(H2);
    assert.strictEqual(H2.api.b4WaitingCount(), 0);
    assert.strictEqual(await srvCount("cl_sales", "uid=$1 and history=false", [s.uid]), 1);
    assert.strictEqual(await srvCount("cl_sale_returns", "uid=$1", [cn.uid]), 1);
    assert.strictEqual(await srvCount("cl_eod_closes"), 1);
    assert.strictEqual(await srvCount("cl_voucher_events"), 1);
    assert.strictEqual(await srvCount("cl_payouts", "reason='Bread'"), 1);
    assert.strictEqual(await srvCount("cl_credit_payments", "reference='paid at T2'"), 1);
    assert.ok((await q("select how from cl_price_change_log where name='Bib' and new_price=11"))[0].how === "on this till");
    const eod = (await q("select * from cl_eod_closes"))[0];
    assert.ok(Number(eod.counted_cash) === 10 && Array.isArray(eod.by_currency) && eod.totals && "cash" in eod.totals, JSON.stringify(eod));
  });

  await t("an app restart in the middle of a send: the same events go again, seiGEN keeps them once", async ()=>{
    const s = await sell(M1, 1, "Cash");
    M1.api.b4ScanLive();
    M1.net = "lose"; await M1.api.b4SendNow();
    // the restart: a new app with this till's whole database, fresh memory
    const M1b = makeApp({}, { dom:true, b4:true });
    M1b.hook("printReceipt", ()=>{});
    M1b.hook("fetch", M1.ctx.__h.fetch);
    const tables = M1.api.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((x)=> x.name);
    for(const tb of tables){
      M1b.api.run(`DELETE FROM ${tb}`);
      for(const row of M1.api.all(`SELECT * FROM ${tb}`)){
        const cols = Object.keys(row);
        M1b.api.run(`INSERT OR REPLACE INTO ${tb}(${cols.join(",")}) VALUES(${cols.map(()=>"?").join(",")})`, cols.map((c)=> row[c]));
      }
    }
    M1.net = "ok";
    await drain(M1b);
    assert.strictEqual(M1b.api.b4WaitingCount(), 0);
    assert.strictEqual(await srvCount("cl_sales", "uid=$1", [s.uid]), 1);
    assert.strictEqual(M1b.api.one("SELECT code FROM b4_outbox WHERE uid=?", [s.uid]).code, "duplicate");
  });

  // Chipo owes 40 + 0 (H2 sold cash) = 40, paid 5 at T2: 35 on seiGEN
  await t("two tills, one customer, online at once: only one gets the last available credit", async ()=>{
    H2.api.run("UPDATE products SET price=10 WHERE sku='BIB1'");   // back from the price change above: $50 on each till
    for(const A of [H1, H2, M1]){ await A.api.b4PullBalances(); }
    assert.strictEqual(await srvBalance(chipoH1.uid), 35);
    const cH2 = H2.api.one("SELECT * FROM customers WHERE uid=?", [chipoH1.uid]), cM1 = M1.api.one("SELECT * FROM customers WHERE uid=?", [chipoH1.uid]);
    // each wants $50 on credit: 35 + 50 fits once (85), not twice (135)
    M1.lastXc = "";
    const [a, b] = await Promise.all([sell(H2, 5, "Credit", cH2), sell(M1, 5, "Credit", cM1, { otherBranchAdmin:"4321" })]);
    assert.ok((a && !b) || (!a && b), "exactly one sale: " + JSON.stringify([!!a, !!b]));
    // decision 40: Murehwa still gets the notice and the passcode for Harare's customer, without the "this till only" sentence
    assert.strictEqual(M1.lastXc, "This customer was added at Harare. An Admin passcode lets the credit sale continue.");
    const loser = a? M1 : H2, winner = a? H2 : M1, sold = a || b;
    const box = boxText(loser);
    assert.ok(/over their credit limit of \$100\.00/.test(box) && /Balance \(business\): \$85\.00/.test(box) && /blocked/.test(box), box);
    assert.strictEqual(sold.credit_check, "online"); assert.strictEqual(sold.credit_scope, "business");
    assert.strictEqual(sold.credit_before, 35); assert.strictEqual(sold.credit_after, 85); assert.strictEqual(sold.credit_limit_at, 100);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(winner.api.receiptCreditRows(winner.api.receiptSaleInfo(sold.id)).map((x)=> x[0]))), ["Balance before (business)", "Balance after (business)"]);
    await drain(winner);
    assert.strictEqual(await srvBalance(chipoH1.uid), 85);
    assert.strictEqual(await srvCount("cl_credit_holds"), 0, "the hold ended when the sale arrived");
  });

  await t("an override online syncs with the \"single operator\" flag (decision 30)", async ()=>{
    const c = H1.api.one("SELECT * FROM customers WHERE uid=?", [chipoH1.uid]);
    await H1.api.b4PullBalances();
    let s = await sell(H1, 3, "Credit", c);                              // 85 + 30 = 115: blocked
    assert.strictEqual(s, null);
    const info = H1.api.creditLimitCheck(c, 30);
    assert.ok(info && info.scope === "business" && info.balance === 85, JSON.stringify(info));
    H1.api.approveCreditLimit(info, "4321");
    s = await sell(H1, 3, "Credit", c);
    assert.ok(s && s.credit_override_mode === "single operator" && s.credit_override === "Boss", JSON.stringify(s));
    await drain(H1);
    const o = (await q("select * from cl_credit_overrides where sale_uid=$1", [s.uid]))[0];
    assert.ok(o && o.single_operator === true && o.right_held === false && Number(o.credit_limit) === 100 && Number(o.amount_over) === 15, JSON.stringify(o));
    assert.strictEqual(await srvBalance(chipoH1.uid), 115);
  });

  await t("offline (decision 3): the balance at the last sync plus this till's credit sales since; marked \"checked offline\" on the sale, the receipt and the report", async ()=>{
    // Chipo is back under the limit: a $60 payment at T1
    H1.api.run("INSERT INTO credit_payments(customer_id,ts,amount,note,branch,user) VALUES(?,?,60,'',?,'Boss')", [H1.api.one("SELECT id FROM customers WHERE uid=?", [chipoH1.uid]).id, new Date().toISOString(), "Harare"]);
    await H1.api.b4Tick(); await drain(H1);
    assert.strictEqual(await srvBalance(chipoH1.uid), 55);
    await M1.api.b4PullBalances();
    const c = M1.api.one("SELECT * FROM customers WHERE uid=?", [chipoH1.uid]);
    M1.ctx.navigator.onLine = false;
    assert.ok(/Balance \(business, as of last sync \d\d:\d\d(?: ?[AP]M)?\): \$55\.00 · limit \$100\.00 · available \$45\.00/.test(M1.api.custBalanceLineHtml(c)), M1.api.custBalanceLineHtml(c));
    M1.lastXc = "";
    let s = await sell(M1, 3, "Credit", c, { otherBranchAdmin:"4321" });                            // 55 + 30 = 85: allowed offline
    assert.ok(/added at Harare\. Their credit balance here covers this till only \(until the update that shares sales\)\. An Admin passcode/.test(M1.lastXc), "decision 40: offline the sentence stays: " + M1.lastXc);
    assert.ok(s && s.credit_check === "offline" && s.credit_scope === "last_sync" && s.credit_before === 55 && s.credit_after === 85, JSON.stringify(s));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(M1.api.receiptCreditRows(M1.api.receiptSaleInfo(s.id)).map((x)=> x[0]))), ["Balance before (as of last sync)", "Balance after (as of last sync)"]);
    const s2 = await sell(M1, 2, "Credit", c, { otherBranchAdmin:"4321" });                         // 55 + 30 (unsynced, this till) + 20 = 105: blocked
    assert.strictEqual(s2, null);
    assert.ok(/Balance \(as of last sync \d\d:\d\d(?: ?[AP]M)?\): \$85\.00/.test(boxText(M1)), boxText(M1));
    const info = M1.api.creditLimitCheck(c, 20);
    assert.ok(info.offline && info.scope === "last_sync", JSON.stringify(info));
    const off = M1.dom.window.document.querySelector("#clOffline");   // the box the blocked sale opened
    assert.ok(off && /Checked offline, against the balance at the last sync \(\d\d:\d\d(?: ?[AP]M)?\) and this till's credit sales since\./.test(off.textContent), off && off.textContent);
    M1.dom.window.document.querySelectorAll(".modalOverlay").forEach((m)=> m.remove());
    const rep = M1.api.REPORT_CONFIGS.find((x)=> x.id === "offlinecredit").fetch("Murehwa", new Date(now - DAY).toISOString(), new Date(now + DAY).toISOString());
    assert.ok(rep.rows.length === 1 && /Credit checked offline: \$30\.00 on 1 sale/.test(rep.footer), JSON.stringify(rep));
    M1.ctx.navigator.onLine = true;
    await drain(M1);
    const srv = (await q("select credit_check, credit_scope from cl_sales where uid=$1", [s.uid]))[0];
    assert.deepStrictEqual(JSON.parse(JSON.stringify(srv)), { credit_check:"offline", credit_scope:"last_sync" });
  });

  await t("selling never waits: with the line hung, a cash sale is written at once; a credit sale falls back to the offline rule after the short timeout", async ()=>{
    H2.net = "hang";
    const t0 = Date.now();
    const s = await sell(H2, 1, "Cash");
    assert.ok(s && Date.now() - t0 < 1000, "cash sale in " + (Date.now() - t0) + " ms");
    await H2.api.b4PullBalances().catch(()=>{});
    const c = H2.api.one("SELECT * FROM customers WHERE uid=?", [chipoH1.uid]);
    const t1 = Date.now();
    const cs = await sell(H2, 1, "Credit", c);
    const ms = Date.now() - t1;
    assert.ok(cs && cs.credit_check === "offline" && cs.credit_scope === "last_sync" && ms >= 3500 && ms < 7000, "credit sale after " + ms + " ms: " + JSON.stringify(cs));
    H2.net = "ok"; await drain(H2);
  });

  await t("a flaky 2G line: every priority-1 event arrives, money first, nothing twice; batches shrink after timeouts", async ()=>{
    const ids = [];
    for(let i = 0; i < 40; i++){ const s = await sell(M1, 1, "Cash"); ids.push(s.uid); }
    for(let i = 0; i < 30; i++) M1.api.run("UPDATE products SET price=? WHERE sku='BIB1'", [20 + i]);   // 30 price changes (priority 2)
    for(let i = 0; i < 10; i++) M1.api.run("INSERT INTO payouts(ts,amount,reason,branch,user) VALUES(?,1,?,'Murehwa','Rudo')", [new Date().toISOString(), "Airtime " + i]);
    M1.api.b4ScanLive();
    let k = 0;
    M1.net = (fn)=> fn !== "cl_device_b4_push"? "ok" : ["ok","down","lose","ok","down","ok","lose"][k++ % 7];
    const pushes = [];
    const origLen = calls.length;
    for(let i = 0; i < 400 && M1.api.b4WaitingCount(); i++){
      M1.api.run("UPDATE b4_outbox SET next_ts='' WHERE status='queued'");
      await M1.api.b4SendNow({ budgetMs:5000 });
    }
    M1.net = "ok";
    const firstTry = {};   // each event's first send (a retry of a failed one can come later)
    calls.slice(origLen).filter((c)=> c.till === "M1" && c.fn === "cl_device_b4_push").forEach((c)=>{
      const evs = JSON.parse(c.body).p_events;
      evs.forEach((e)=>{ if(!(e.uid in firstTry)) firstTry[e.uid] = { at:pushes.length, kind:e.kind }; });
      pushes.push(evs.map((e)=> e.kind));
    });
    assert.strictEqual(M1.api.b4WaitingCount(), 0, "everything arrived: " + JSON.stringify(M1.api.all("SELECT kind, code, error, attempts FROM b4_outbox WHERE status='queued' LIMIT 5")));
    for(const uid of ids) assert.strictEqual(await srvCount("cl_sales", "uid=$1", [uid]), 1);
    assert.strictEqual(await srvCount("cl_payouts", "reason like 'Airtime %'"), 10);
    const tries = Object.values(firstTry);
    const firstPrice = Math.min(...tries.filter((x)=> x.kind === "price_change").map((x)=> x.at)), lastMoney = Math.max(...tries.filter((x)=> x.kind !== "price_change").map((x)=> x.at));
    assert.ok(isFinite(firstPrice) && isFinite(lastMoney) && lastMoney <= firstPrice, "every money event is tried before the first price change: " + JSON.stringify(pushes.map((b)=> b.length + ":" + [...new Set(b)].join("+"))));
    assert.ok(pushes.some((b, i)=> i > 0 && b.length < pushes[0].length), "a smaller batch after a failure");
    assert.ok(M1.api.b4Backoff(1) >= 2500 && M1.api.b4Backoff(1) <= 5000 && M1.api.b4Backoff(20) <= 15*60000, "back-off with jitter, capped");
  });

  await t("the sync line on the Sell screen: \"N waiting to send · last sent hh:mm\", tap for details", async ()=>{
    M1.ctx.navigator.onLine = false;
    await sell(M1, 1, "Cash"); M1.api.b4ScanLive();
    const html = M1.api.b4IndicatorHtml();
    assert.ok(/1 waiting to send · last sent \d\d:\d\d(?: ?[AP]M)?/.test(html), html);
    const wrap = M1.api.openB4Details();
    assert.ok(/Sales/.test(wrap.textContent) && /You're offline: selling goes on/.test(wrap.textContent), wrap.textContent);
    wrap.remove();
    M1.ctx.navigator.onLine = true; await drain(M1);
    assert.ok(/All sent · last sent \d\d:\d\d(?: ?[AP]M)?/.test(M1.api.b4IndicatorHtml()));
  });

  await t("another branch's sales in Report Writer: from seiGEN, costs only when seiGEN sends them", async ()=>{
    const r = await serial(()=> rpcNow("cl_device_branch_report", { p_install_id:"MU01", p_secret_phrase:"Mandie Phrase", p_device_key:M1.api.deviceKey(), p_staff_token:null, p_kind:"sales", p_branch_id:H1.api.getSetting("branch_uuid","") }));
    assert.ok(/NO_RIGHT/.test(r.body), "single operator mode can't read another branch: " + r.body);
    const data = { costs:false, rows:[{ type:"sale", uid:"x", doc:"T1-0009", at:new Date().toISOString(), till:"T1", method:"Cash", subtotal:10, discount:0, total:10, cost:null },
      { type:"return", uid:"y", doc:"CN-T1-0001", at:new Date().toISOString(), till:"T1", sale_receipt:"T1-0009", total:4, cost:null }] };
    let tb = M1.api.rwRemoteTable("sales", data, "sales");
    assert.ok(!tb.headers.includes("Cost") && /Gross \$10\.00 · Returns -\$4\.00 · Net \$6\.00/.test(tb.footer), JSON.stringify(tb));
    tb = M1.api.rwRemoteTable("sales", Object.assign({}, data, { costs:true, rows:[Object.assign({}, data.rows[0], { cost:6 })] }), "sales");
    assert.ok(tb.headers.includes("Cost") && tb.headers.includes("Margin") && tb.rows[0].includes("40%"), JSON.stringify(tb));
    tb = M1.api.rwRemoteTable("payouts", { rows:[{ at:new Date().toISOString(), till:"T1", reason:"Fuel", amount:3, operator:"Boss" }] }, "payouts");
    assert.ok(/Total payouts: \$3\.00/.test(tb.footer));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
