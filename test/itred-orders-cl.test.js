// node test/itred-orders-cl.test.js
//
// Commerce Lite's side of iTred orders (docs/itred/itred-upgrade-design.md
// Part D; owner 2026-10-14: status only, every till of the business, the
// customer's name and phone only). Tills running the REAL app code
// (test/harness.js, JSDOM for the screens) against the REAL server SQL in
// PGlite (the live shape + 20261105120000_itred_order_fulfilment), never the
// live database:
//   - a till of a business that isn't on iTred hides the pages; one that is
//     pulls the business's orders (both tills), new ones counted on Sell;
//   - changes made offline are kept, shown at once ("waiting to send"), and
//     sent when back online; a resend after a lost answer is never doubled;
//   - wrong quantities are refused on the till; a change the server refuses
//     (the customer closed the order) shows its reason and can be discarded;
//   - Mark complete; the message thread both ways, read marks;
//   - the screens: list, search (any order: item, customer, phone, date),
//     the order card; never the customer's email;
//   - nothing touches stock, sales or the stock ledger.
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
// values made inside the app's vm realm: compare as JSON (a cross-realm deepStrictEqual fails on prototypes)
const same = (a, b, m)=> assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); }
}

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== "20261105120000_itred_order_fulfilment.sql") });
  let lock = Promise.resolve();
  const serial = (fn)=>{ const run = lock.then(fn, fn); lock = run.catch(()=>{}); return run; };
  const q = (sql, p)=> serial(async ()=> (await pg.query(sql, p)).rows);
  // a signed-in iTred customer (PostgREST: role authenticated + the JWT sub)
  const as = (uid, sql, p)=> serial(async ()=>{
    await pg.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
    try{ return (await pg.query(sql, p)).rows; }
    finally{ await pg.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
  });
  const calls = [];
  let loseNextAnswer = null;   // fn name: the server runs it, the till never hears back
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
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:phrase||"Chipo Phrase", install_date:"2026-09-01" }, settings), { dom:true });
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      calls.push({ till:name, fn:m[1], body:JSON.parse(opts.body) });
      const r = await serial(()=> rpcNow(m[1], JSON.parse(opts.body)));
      if(loseNextAnswer === m[1]){ loseNextAnswer = null; throw new TypeError("Failed to fetch"); }
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES('Denim jacket',18,5,1,'DJ1',?,'',9,'2026-10-01','')", [A.api.currentBranch()]);
    return A;
  }
  const H1 = till("H1", { install_id:"CH01", shop_name:"Chipo Clothing", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const H2 = till("H2", { install_id:"CH02", shop_name:"Chipo Clothing", branch_name:"Harare", branch_id:"B-HARARE02", branch_type:"main" });
  const S1 = till("S1", { install_id:"SO01", shop_name:"Solo Shop", branch_name:"Mbare", branch_id:"B-MBARE001", branch_type:"main" }, "Solo Phrase");
  const footprint = (A)=> JSON.stringify(["sales","sale_items","sale_payments","stock_movements"].map((tb)=> A.api.one(`SELECT COUNT(*) n FROM ${tb}`).n)
    .concat(A.api.all("SELECT stock FROM products ORDER BY id").map((r)=> r.stock)));
  const before = { H1:footprint(H1), H2:footprint(H2) };

  let chipo, order1, order2, lines1;
  const CUST = crypto.randomUUID();
  await t("setup: Chipo Clothing (T1 + T2) and Solo Shop register; Chipo is on iTred; a customer sends two orders", async ()=>{
    assert.ok((await H1.api.registerMainBranch("Counter")).ok);
    const c = await H1.api.issueJoinCode({ branchId:H1.api.getSetting("branch_uuid",""), seed:H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await H2.api.joinBusiness({ phrase:"Chipo Phrase", code:c.data.code, label:"Back" })).ok);
    assert.ok((await S1.api.registerMainBranch("Counter")).ok);
    [chipo] = await q(`insert into vendors (install_id, business_name, whatsapp_number, city) values ('CH01', 'Chipo Clothing', '0771000001', 'Harare') returning id`);
    const [lst] = await q(`insert into vendor_listings (vendor_id, product_name, price, currency, stock_quantity, exported_at, published_at, expires_at, status)
      values ($1, 'Denim jacket', 18, 'USD', 5, now(), now(), now() + interval '5 days', 'published') returning id`, [chipo.id]);
    await q(`insert into auth.users (id, email) values ($1, 'tariro@example.test')`, [CUST]);
    await q(`insert into customers (id, email, full_name, phone) values ($1, 'tariro@example.test', 'Tariro Moyo', '0772000111')`, [CUST]);
    const send = async (lines)=>{
      const [po] = await as(CUST, `insert into purchase_orders (customer_id, vendor_id) values ($1, $2) returning id`, [CUST, chipo.id]);
      for(const l of lines) await as(CUST, `insert into purchase_order_items (purchase_order_id, vendor_listing_id, item_name, quantity_requested, is_custom_request) values ($1,$2,$3,$4,$5)`,
        [po.id, l.listing||null, l.name, l.qty, !l.listing]);
      return po.id;
    };
    order1 = await send([{ listing:lst.id, name:"x", qty:2 }, { name:"School shoes size 5", qty:3 }]);
    order2 = await send([{ name:"Wiper blades", qty:1 }]);
  });

  await t("a business not on iTred: the pull says so, the pages and the Sell line stay hidden", async ()=>{
    const r = await S1.api.itredAfterCheckin();
    assert.strictEqual(r.notOnItred, true, JSON.stringify(r));
    assert.strictEqual(S1.api.getSetting("itred_on",""), "0");
    assert.strictEqual(S1.api.itredAvailable(), false);
    assert.strictEqual(S1.api.itredBannerHtml(), "");
  });

  await t("every till of the business pulls its orders; new ones show on Sell; the customer's name and phone, never the email", async ()=>{
    for(const A of [H1, H2]){
      const r = await A.api.itredAfterCheckin();
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(A.api.itredAvailable(), true);
      same(A.api.itredOrders().map((o)=> o.id).sort(), [order1, order2].sort());
      assert.strictEqual(A.api.itredNewCount(), 2);
      assert.match(A.api.itredBannerHtml(), /2 new iTred orders/);
      assert.strictEqual(A.api.itredMoreLabel("itredorders"), "Orders Fulfillment (2 new)");
    }
    const o = H1.api.itredOrders().find((x)=> x.id === order1);
    same(o.customer, { name:"Tariro Moyo", phone:"0772000111" });
    assert.ok(!/example\.test/.test(H1.api.all("SELECT json FROM itred_orders").map((r)=> r.json).join("")), "no email on the till");
    lines1 = o.lines;
    same(lines1.map((l)=> [l.name, Number(l.qty), l.status]), [["Denim jacket", 2, "outstanding"], ["School shoes size 5", 3, "outstanding"]]);
    // a second pull brings nothing new (cursor)
    const n = calls.length;
    await H1.api.itredPull();
    assert.strictEqual(calls.length, n + 1);
    assert.strictEqual(H1.api.itredNewCount(), 2);
  });

  await t("wrong quantities are refused on the till; nothing is queued", async ()=>{
    for(const [qty, msg] of [["3", /only 2 ordered/], ["-1", /enter how many/], ["", /enter how many/], ["abc", /enter how many/]])
      assert.throws(()=> H1.api.itredSetLines(order1, [{ id:lines1[0].id, qty, note:"" }]), msg, "qty " + JSON.stringify(qty));
    assert.strictEqual(H1.api.itredWaitingCount(), 0);
  });

  await t("offline: the change is kept and shows at once ('waiting to send'); back online it is sent and the order follows", async ()=>{
    H1.ctx.navigator.onLine = false;
    assert.strictEqual(H1.api.itredSetLines(order1, [{ id:lines1[0].id, qty:"2", note:"" }, { id:lines1[1].id, qty:"1", note:"2 more on Friday" }]), 2);
    let o = H1.api.itredOrders().find((x)=> x.id === order1);
    same(o.lines.map((l)=> [l.status, !!l.waiting]), [["fulfilled", true], ["partially_fulfilled", true]]);
    assert.strictEqual(o.waiting, 2);
    assert.strictEqual((await H1.api.itredSendPending()).sent, 0);
    assert.strictEqual(H1.api.itredWaitingCount(), 2);
    assert.match(H1.api.itredStatusHtml(), /Offline:.*Your changes are kept/);
    // a newer change to the same line replaces the queued one
    H1.api.itredSetLines(order1, [{ id:lines1[1].id, qty:"1", note:"2 more on Saturday" }]);
    assert.strictEqual(H1.api.itredWaitingCount(), 2);
    H1.ctx.navigator.onLine = true;
    await H1.api.itredAfterCheckin();
    assert.strictEqual(H1.api.itredWaitingCount(), 0);
    const rows = await q(`select item_name, quantity_fulfilled::text qf, vendor_note, fulfillment_status from purchase_order_items where purchase_order_id = $1 order by item_name`, [order1]);
    same(rows.map((r)=> [r.item_name, Number(r.qf), r.vendor_note, r.fulfillment_status]),
      [["Denim jacket", 2, null, "fulfilled"], ["School shoes size 5", 1, "2 more on Saturday", "partially_fulfilled"]]);
    assert.strictEqual((await q(`select status from purchase_orders where id = $1`, [order1]))[0].status, "partially_fulfilled");
    const log = await q(`select till_code from itred_po_updates where purchase_order_id = $1`, [order1]);
    same(log.map((r)=> r.till_code), ["T1", "T1"], "two actions logged, from T1");
    o = H1.api.itredOrders().find((x)=> x.id === order1);
    same(o.lines.map((l)=> [l.status, !!l.waiting]), [["fulfilled", false], ["partially_fulfilled", false]]);
  });

  await t("a resend after a lost answer is never doubled (same uid)", async ()=>{
    H1.api.itredSetLines(order1, [{ id:lines1[1].id, qty:"3", note:"" }]);
    const uid = H1.api.itredOutbox(order1)[0].uid;
    loseNextAnswer = "cl_device_itred_line_update";
    await H1.api.itredSendPending();
    assert.strictEqual(H1.api.itredWaitingCount(), 1, "still waiting: the till never heard back");
    assert.strictEqual(H1.api.itredOutbox(order1)[0].uid, uid);
    await H1.api.itredSendPending();
    assert.strictEqual(H1.api.itredWaitingCount(), 0);
    assert.strictEqual((await q(`select count(*)::int n from itred_po_updates where uid = $1`, [uid]))[0].n, 1);
    const sent = calls.filter((c)=> c.fn === "cl_device_itred_line_update" && c.body.p_uid === uid);
    assert.strictEqual(sent.length, 2, "sent twice, applied once");
  });

  await t("the other till (T2) sees T1's changes after its next pull", async ()=>{
    await H2.api.itredAfterCheckin();
    const o = H2.api.itredOrders().find((x)=> x.id === order1);
    same(o.lines.map((l)=> [Number(l.fulfilled), l.status]), [[2, "fulfilled"], [3, "fulfilled"]]);
    assert.strictEqual(o.status, "fulfilled");
  });

  await t("a change the server refuses (the customer closed the order) shows its reason; Discard removes it", async ()=>{
    H2.ctx.navigator.onLine = false;
    H2.api.itredSetLines(order2, [{ id:H2.api.itredOrders().find((x)=> x.id === order2).lines[0].id, qty:"1", note:"" }]);
    await as(CUST, `update purchase_orders set status = 'closed' where id = $1`, [order2]);
    H2.ctx.navigator.onLine = true;
    await H2.api.itredSendPending();
    let o = H2.api.itredOrderView(H2.api.itredRow(order2));
    assert.strictEqual(o.problems.length, 1);
    assert.match(o.problems[0].error, /The customer closed this order/);
    H2.api.itredDiscard(o.problems[0].uid);
    o = H2.api.itredOrderView(H2.api.itredRow(order2));
    assert.strictEqual(o.problems.length, 0);
    await H2.api.itredPull();
    assert.throws(()=> H2.api.itredSetLines(order2, [{ id:o.lines[0].id, qty:"1" }]), /customer closed this order/);
  });

  await t("messages: the customer writes, the till sees it as new feedback, opening it marks it read, the reply reaches the customer", async ()=>{
    await as(CUST, `insert into itred_order_messages (id, purchase_order_id, body) values ($1, $2, 'Can you deliver to Avondale?')`, [crypto.randomUUID(), order1]);
    await H1.api.itredAfterCheckin();
    assert.strictEqual(H1.api.itredUnreadCount(), 1);
    assert.strictEqual(H1.api.itredMoreLabel("itredfeedback"), "Marketplace Feedback (1 new)");
    assert.strictEqual(H1.api.itredMarkRead(order1), true);
    assert.strictEqual(H1.api.itredMarkRead(order1), false, "queued once");
    assert.strictEqual(H1.api.itredUnreadCount(), 0, "read at once on this till");
    H1.api.itredReply(order1, "Yes, tomorrow morning");
    assert.throws(()=> H1.api.itredReply(order1, "   "), /Write a reply/);
    await H1.api.itredAfterCheckin();
    const msgs = await as(CUST, `select author, body, till_code, vendor_read_at is not null r from itred_order_messages where purchase_order_id = $1 order by created_at`, [order1]);
    same(msgs.map((m)=> [m.author, m.body, m.till_code, m.r]),
      [["customer", "Can you deliver to Avondale?", null, true], ["vendor", "Yes, tomorrow morning", "T1", true]]);
    await H2.api.itredPull();
    assert.strictEqual(H2.api.itredUnreadCount(), 0, "read on one till = read for the business");
  });

  await t("Mark complete: sent once; the order shows Completed; the customer's status still follows the lines", async ()=>{
    assert.strictEqual(H1.api.itredMarkComplete(order1), true);
    assert.strictEqual(H1.api.itredMarkComplete(order1), false, "already marked (waiting)");
    await H1.api.itredAfterCheckin();
    const [po] = await q(`select status, completed_at from purchase_orders where id = $1`, [order1]);
    assert.ok(po.completed_at); assert.strictEqual(po.status, "fulfilled");
    H1.api.itredMarkSeen(order1);
    assert.strictEqual(H1.api.itredGroup(H1.api.itredOrders().find((x)=> x.id === order1)), "completed");
  });

  await t("the screens: the list by group, search in any order (item, customer, phone, date), the order card", async ()=>{
    const doc = H1.dom.window.document;
    const body = doc.createElement("div"); doc.body.appendChild(body);
    H1.api.itredMarkSeen(order2);
    H1.api.renderItredOrders(body);
    const text = ()=> body.textContent.replace(/\s+/g, " ");
    assert.match(text(), /Orders Fulfillment/);
    assert.match(text(), /doesn't change stock or make a sale/);
    body.querySelector('[data-itred-filter="completed"]').click();
    assert.match(text(), /Tariro Moyo PO-/);
    assert.ok(!/example\.test/.test(body.innerHTML));
    const search = (s)=>{ const el = body.querySelector("#itredSearch"); el.value = s; el.oninput(); return body.querySelectorAll("[data-itred-open]").length; };
    assert.strictEqual(search("shoes school"), 1);
    // both orders are Tariro's (order 2 was closed by her, so it's under Completed too)
    assert.strictEqual(search("tariro"), 2);
    assert.strictEqual(search("blades wiper"), 1);
    assert.strictEqual(search("0772000"), 2);
    const d = new Date(); assert.strictEqual(search(d.getDate() + " " + ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"][d.getMonth()]), 2);
    assert.strictEqual(search("sandals"), 0);
    search("");
    const card = H1.api.openItredOrder(order1);
    const ct = card.textContent.replace(/\s+/g, " ");
    assert.match(ct, /Tariro Moyo · 0772000111 WhatsApp/);
    assert.match(ct, /Denim jacket.*Ordered 2.*Fulfilled/);
    assert.match(ct, /Yes, tomorrow morning/);
    assert.match(card.querySelector("#itredWa").getAttribute("href"), /^https:\/\/wa\.me\/263772000111\?text=/);
    // "All" / "None" fill the box; Save queues only what changed
    const box = card.querySelectorAll("[data-itred-line]")[1];
    box.querySelector("[data-itred-none]").click();
    assert.strictEqual(box.querySelector("[data-itred-qty]").value, "0");
    box.querySelector("[data-itred-all]").click();
    card.querySelector("#itredSave").click();
    assert.strictEqual(H1.api.itredWaitingCount(), 0, "nothing changed, nothing queued");
    card.remove();
    // Feedback: the thread, newest first
    H1.api.renderItredFeedback(body);
    assert.match(text(), /Marketplace Feedback.*Tariro Moyo PO-.*You: Yes, tomorrow morning/);
  });

  await t("nothing touched stock, sales or the stock ledger on either till", async ()=>{
    assert.strictEqual(footprint(H1), before.H1);
    assert.strictEqual(footprint(H2), before.H2);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
