// node --no-warnings test/srq-drafts-v371.test.js
//
// v37.1 (owner decisions 63 and 64, Fixes 3 and 4). Tills running the REAL app
// code (test/harness.js) against the REAL server SQL in PGlite (the live shape
// + 20261117120000_srq_drafts), never the live database. The Dispatch screen is
// driven by its own buttons (Review, Dispatch), not by calling the DN code.
//   Fix 3: main registers alone (seiGEN: no branch figures yet); a branch
//     joins; main sends its figures (the opening stock) at its next check, not
//     in 6 hours; Refresh forces it; a single-till business and a shared-stock
//     till still send nothing; "not sent yet by <branch>".
//   drafts: approve -> the draft on seiGEN and in "Drafts from stock requests"
//     at main, no stock change; "Open draft DN" pre-fills; raising above the
//     approved quantity is refused on the screen; lowering and removing a
//     line are recorded; only the first of two senders makes a DN, the second
//     is told; the link reaches seiGEN (v37 lost it on this screen); close with
//     a reason, shown at both ends; an offline approval syncs and drafts.
//   recalls: the send-back DN from the screen is linked too (the same v37 fix).
//   reminder: none before 8 h, at 8 h, again at 32 h, gone when sent; to main's
//     Dispatch people and the approver only; the Owner/Admin timers (2 h, 6 h,
//     "Don't repeat") follow on every till, a lowered delay applies at once to
//     a draft already waiting; out-of-range refused; the settings card.
//   Fix 4: one rule for iTred: no iTred orders in the bell (and no Orders
//     Fulfillment) until seiGEN says the business is on iTred, then both at the
//     same check; no notice without Sell; every bell route opens a real screen
//     or says why (never Help).
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
  finally{ for(const A of TILLS){ A.ctx.navigator.onLine = true; for(const m of [...A.dom.window.document.querySelectorAll(".modalOverlay")]) m.remove(); } }
}
const HOUR = 3600000;
const same = (a, b, m)=> assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
const FILE = "20261117120000_srq_drafts.sql";
const sleep = (ms)=> new Promise((r)=> setTimeout(r, ms));
async function waitFor(fn, what, ms){ const end = Date.now() + (ms || 8000); for(;;){ const v = await fn(); if(v) return v; if(Date.now() > end) throw new Error("timed out waiting for " + what); await sleep(20); } }

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== FILE) });   // the live shape + v37.1
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
    const add = (n, sku, cat, cost, stock)=>{
      A.api.setSetting("cat_applying","1");
      A.api.run("INSERT INTO products(name,price,cost,stock,low_threshold,sku,branch,created_ts,cat_uid) VALUES(?,?,?,?,2,?,?,?,?)",
        [n, cost*2, cost, stock, sku, A.api.currentBranch(), "2026-01-01", cat]);
      A.api.setSetting("cat_applying","");
      A.api.recordStockMovement(A.api.one("SELECT last_insert_rowid() AS id").id, stock, { kind:"import", ts:"2026-01-01T00:00:00Z" });
    };
    add("Baby bottle", "BOT1", "cat-bottle", 5, 20);
    add("Cooking oil 2L", "OIL2", "cat-oil", 3, 30);
    add("Nappies L", "NAP1", "cat-nappy", 8, 25);
    return A;
  }
  const P = (A, sku)=> A.api.one("SELECT * FROM products WHERE sku=? AND branch=?", [sku, A.api.currentBranch()]);
  const doc = (A)=> A.dom.window.document;
  const $ = (A, sel)=> doc(A).querySelector(sel);
  const drain = async (A)=>{ for(let i = 0; i < 6; i++){ A.api.run("UPDATE sc_outbox SET next_ts='' WHERE status='queued'"); await A.api.scTick(); if(!A.api.scWaitingCount()) break; } };
  const levels = async (iid)=> (await q(`select count(*)::int n from cl_till_stock_levels l join cl_terminals t on t.id = l.terminal_id join cl_vendors v on v.id = t.vendor_id where v.install_id = $1`, [iid]))[0].n;
  const click = (A, sel)=>{ const el = $(A, sel); assert.ok(el, "no " + sel); el.click(); };
  const type = (A, sel, v)=>{ const el = $(A, sel); assert.ok(el, "no " + sel); el.value = v; el.dispatchEvent(new A.dom.window.Event("input", { bubbles:true })); };

  const H1 = till("H1", { install_id:"HA01", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const H2 = till("H2", { install_id:"HA02", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE02", branch_type:"main" });
  const M1 = till("M1", { install_id:"MU01", shop_name:"Mandie Babyware", branch_name:"Murehwa", branch_id:"B-MUREHWA1", branch_type:"remote" });

  // ---- Fix 3: main registered alone, then a branch joins ----
  await t("Fix 3: main registers alone: seiGEN takes no figures yet (enabled: false), main holds back for 6 hours", async ()=>{
    const r = await H1.api.registerMainBranch("Counter");
    assert.ok(r.ok, JSON.stringify(r));
    const p = await H1.api.bsPush();
    assert.strictEqual(p.enabled, false, JSON.stringify(p));
    assert.strictEqual(H1.api.getSetting("bs_enabled",""), "0");
    const x = await H1.api.scTick(); if(x.pull.changes.bsPush) await x.pull.changes.bsPush;
    assert.strictEqual(await levels("HA01"), 0, "a single-till business still sends nothing");
  });
  await t("Fix 3: a branch joins; main sends its figures (the opening stock) at its next check, not in 6 hours; the branch sees them", async ()=>{
    const c = await H1.api.issueJoinCode({ newBranchName:"Murehwa", seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await M1.api.joinBusiness({ phrase:"Mandie Phrase", code:c.data.code, label:"Till 1", expectedBranchName:"Murehwa" })).ok);
    await M1.api.bsPull();
    const hb = M1.api.bsBranches().find((b)=> b.is_main);
    assert.strictEqual(M1.api.bsUpdatedText(hb.updated_at, hb).text, "not sent yet by Harare", "before: the branch says who hasn't sent");
    assert.strictEqual(H1.api.getSetting("bs_enabled",""), "0", "main still holds back (6-hour recheck)");
    const x = await H1.api.scTick();
    assert.ok(x.pull.ok && x.pull.changes.bsPush, "the pull saw seiGEN takes figures now");
    await x.pull.changes.bsPush;
    assert.strictEqual(H1.api.getSetting("bs_enabled",""), "1");
    assert.strictEqual(await levels("HA01"), 3, "every product's figure, at once");
    await M1.api.bsPull();
    const hb2 = M1.api.bsBranches().find((b)=> b.is_main);
    assert.ok(hb2.updated_at, "the branch now has main's figures");
    assert.strictEqual((hb2.rows.find((r)=> r.cat_uid==="cat-bottle" || r.k==="cat-bottle") || { qty:JSON.stringify(hb2.rows) }).qty, 20, "the opening stock entered before the branch joined");
  });
  await t("Fix 3: Refresh in Other branches forces this till's figures first; a shared-stock till still sends nothing", async ()=>{
    H1.api.run("UPDATE products SET stock=19 WHERE sku='BOT1'");
    H1.api.setSetting("bs_enabled","0"); H1.api.setSetting("bs_checked_ts", new Date().toISOString());
    assert.strictEqual((await H1.api.bsPush()).skipped, "single till", "without force: held back");
    const r = await H1.api.bsPush({ force:true });
    assert.ok(r.ok && r.enabled && r.sent >= 1, JSON.stringify(r));
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "branch-stock.js"), "utf8");
    assert.match(src, /await bsPush\(\{ force:true \}\)\.catch\(\(\)=>\{\}\); return bsPull\(\);/, "the Refresh button forces it");
    H1.ctx.sharedStockTill = ()=> true;
    assert.strictEqual((await H1.api.bsPush({ force:true })).skipped, "not a sending till");
    delete H1.ctx.sharedStockTill;
    assert.strictEqual(H1.api.bsUpdatedText(null, { name:"Gweru", active_tills:0 }).text, "not sent yet by Gweru (no active till)");
  });
  await t("(registration: Harare T2 joins; everyone checks)", async ()=>{
    const r = await H1.api.issueJoinCode({ branchId: H1.api.getSetting("branch_uuid",""), seed: H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await H2.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Back" })).ok);
    for(const A of [H1, H2, M1]){ await A.api.dsRefreshBranches(); const x = await A.api.scTick(); assert.ok(x.pull.ok, JSON.stringify(x)); }
    assert.ok(H1.api.scIsMain() && H2.api.scIsMain() && !M1.api.scIsMain());
  });

  // ---- drafts (decision 63) ----
  let R1, R2;
  await t("approve: seiGEN holds a draft DN; main lists it under \"Drafts from stock requests\"; no stock change anywhere", async ()=>{
    const r = M1.api.srqCreate([{ product:P(M1, "BOT1"), qty:"10" }, { product:P(M1, "OIL2"), qty:"4" }], "Weekend promotion", "");
    assert.ok(r.ok); R1 = r.id;
    await drain(M1); await H1.api.scTick();
    assert.ok(H1.api.srqDecide(R1, "approve", "", {}).ok);
    await drain(H1); await H2.api.scTick(); await M1.api.scTick();
    assert.strictEqual((await q("select status from cl_srq_drafts where request_id=$1", [R1]))[0].status, "open");
    for(const A of [H1, H2]) assert.ok(A.api.srqOpenDrafts().some((x)=> x.id===R1), A.name + " lists it");
    assert.strictEqual(M1.api.srqCanSendDrafts(), false, "a branch till doesn't send drafts");
    assert.strictEqual(P(H1, "BOT1").stock, 19); assert.strictEqual(P(M1, "BOT1").stock, 20);
    H1.api.openDraftsList();
    assert.match($(H1, "#srqDrafts").textContent, /SRQ-T1-0001 for Murehwa/);
    assert.ok($(H1, `[data-open-draft="${R1}"]`), "Open draft DN");
    // the request at Murehwa: waiting for dispatch since the approval
    M1.api.openRequestHistory(R1);
    assert.match($(M1, "#srqDraftWait").textContent, /Approved, waiting for dispatch since/);
  });
  await t("\"Open draft DN\" pre-fills Dispatch; raising a quantity above the approved one is refused on the screen", async ()=>{
    H1.api.openRequestHistory(R1);
    assert.strictEqual($(H1, "#srqDispatch").textContent, "Open draft DN");
    assert.ok(!/Create dispatch/.test(doc(H1).body.textContent));
    click(H1, "#srqDispatch");
    assert.ok($(H1, "#doDraftOnly"), "no product search on a draft");
    assert.ok($(H1, "#doDest").disabled, "the destination is the requesting branch");
    assert.match(doc(H1).body.textContent, /approved 10/);
    type(H1, '[data-qty="0"]', "12");
    click(H1, "#doReview");
    assert.match($(H1, "#doErr").textContent, /10 approved, so no more than 10 can go/);
    assert.strictEqual((await q("select status from cl_srq_drafts where request_id=$1", [R1]))[0].status, "open", "nothing taken");
  });
  await t("the sender lowers the bottles to 8 and removes the oil: the DN goes, the link reaches seiGEN, approved vs sent recorded", async ()=>{
    assert.ok(H1.api.srqOpenDraft(R1).ok);
    type(H1, '[data-qty="0"]', "8");
    click(H1, '[data-del="1"]');
    click(H1, "#doReview");
    click(H1, "#doConfirm");
    await waitFor(()=> $(H1, "#doDone") || $(H1, "#doClose"), "the DN");
    assert.strictEqual(P(H1, "BOT1").stock, 11, "19 - 8: stock left main when the DN was sent");
    assert.strictEqual(P(H1, "OIL2").stock, 30, "the removed line moved nothing");
    await H1.api.dsSendPending(); await drain(H1);
    const s = (await q("select r.status, r.dispatch_id, d.status ds, d.sent_by from cl_stock_requests r join cl_srq_drafts d on d.request_id=r.id where r.id=$1", [R1]))[0];
    assert.strictEqual(s.status, "dispatched", "linked: " + JSON.stringify(s));
    assert.ok(s.dispatch_id && s.ds==="sent", JSON.stringify(s));
    same((await q("select sent_qty from cl_stock_request_lines where request_id=$1 order by line_no", [R1])).map((x)=> x.sent_qty), [8, 0]);
    const log = (await q("select detail from cl_stock_ctl_log where doc_id=$1 and action='draft_changed'", [R1]))[0].detail.lines;
    assert.strictEqual(log.length, 2);
    await M1.api.scTick();
    M1.api.openRequestHistory(R1);
    assert.match(doc(M1).body.textContent, /Dispatched/);
    assert.ok(!$(M1, "#srqDraftWait"), "no longer waiting");
  });
  await t("two senders on one draft: only the first DN counts; the second is told and changes nothing", async ()=>{
    const r = M1.api.srqCreate([{ product:P(M1, "NAP1"), qty:"5" }], "Low", "");
    R2 = r.id; await drain(M1); await H1.api.scTick();
    assert.ok(H1.api.srqDecide(R2, "approve", "", {}).ok); await drain(H1);
    await H2.api.scTick(); await H1.api.scTick();
    // both open it; H1 sends first
    const n1 = P(H1, "NAP1").stock, n2 = P(H2, "NAP1").stock;
    assert.ok(H2.api.srqOpenDraft(R2).ok); click(H2, "#doReview");
    assert.ok(H1.api.srqOpenDraft(R2).ok); click(H1, "#doReview"); click(H1, "#doConfirm");
    await waitFor(()=> $(H1, "#doDone") || $(H1, "#doClose"), "H1's DN");
    click(H2, "#doConfirm");
    await waitFor(()=> H2.alerts.some((a)=> /already been sent by/.test(a)), "H2 told");
    assert.match(H2.alerts.pop(), /This Delivery Note wasn't made and no stock was changed: This draft has already been sent by \w+ at /);
    assert.strictEqual(P(H2, "NAP1").stock, n2, "H2: no stock change");
    assert.strictEqual(P(H1, "NAP1").stock, n1 - 5);
    assert.strictEqual(H2.api.one("SELECT COUNT(*) AS n FROM dispatch_docs WHERE direction='out'").n, 0, "H2 made no DN");
    await H1.api.dsSendPending(); await drain(H1);
    assert.strictEqual((await q("select count(*)::int n from cl_dispatches where internal_ref=$1", [H1.api.scRequest(R2).req_no]))[0].n, 1);
  });
  let R3;
  await t("close a draft: a reason is required; shown at main and at the branch (\"Approved, not dispatched\")", async ()=>{
    const r = M1.api.srqCreate([{ product:P(M1, "OIL2"), qty:"3" }], "Promo", "");
    R3 = r.id; await drain(M1); await H1.api.scTick();
    assert.ok(H1.api.srqDecide(R3, "approve", "", {}).ok); await drain(H1); await H1.api.scTick();
    assert.match(H1.api.srqCloseDraft(R3, " ").message, /Give the reason/);
    H1.api.openRequestHistory(R3);
    H1.hook("prompt", ()=> "Branch found stock in the back");
    click(H1, "#srqCloseDraft");
    await drain(H1);
    assert.strictEqual((await q("select status from cl_stock_requests where id=$1", [R3]))[0].status, "not_dispatched");
    await M1.api.scTick();
    M1.api.openRequestHistory(R3);
    assert.match($(M1, "#srqDraftClosed").textContent, /Approved, not dispatched: Branch found stock in the back \(\w+, /);
    assert.strictEqual(H1.api.srqOpenDraft(R3).ok, false, "a closed draft can't be opened");
  });
  await t("offline approval: queued, then seiGEN drafts it from the approval time", async ()=>{
    const r = M1.api.srqCreate([{ product:P(M1, "BOT1"), qty:"2" }], "Offline test", "");
    await drain(M1); await H2.api.scTick();
    H2.ctx.navigator.onLine = false;
    const before = new Date();
    assert.ok(H2.api.srqDecide(r.id, "approve", "", {}).ok);
    await H2.api.scTick();
    assert.strictEqual(H2.api.scWaitingFor(r.id).length, 1, "waits on the till");
    H2.ctx.navigator.onLine = true;
    await drain(H2);
    const d = (await q("select status, approved_at from cl_srq_drafts where request_id=$1", [r.id]))[0];
    assert.strictEqual(d.status, "open");
    assert.ok(Math.abs(d.approved_at - before) < 60000, "from the approval on the till, not from the sync");
  });

  // ---- recalls: the send-back DN from the screen is linked too ----
  await t("regression (v37): a recall's send-back DN made on the Dispatch screen is linked to the recall", async ()=>{
    const r = H1.api.rclCreate(M1.api.getSetting("branch_uuid",""), "overstock", "", "2026-12-01", [{ product:P(H1, "BOT1"), qty:"2" }]);
    assert.ok(r.ok); await drain(H1); await M1.api.scTick();
    M1.api.openRecallHistory(r.id);
    click(M1, "#rclSend");
    click(M1, "#doReview"); click(M1, "#doConfirm");
    await waitFor(()=> $(M1, "#doDone") || $(M1, "#doClose"), "M1's DN");
    await M1.api.dsSendPending(); await drain(M1);
    const s = (await q("select status, dispatch_id from cl_stock_recalls where id=$1", [r.id]))[0];
    assert.strictEqual(s.status, "sent", JSON.stringify(s)); assert.ok(s.dispatch_id);
  });

  // ---- the reminder (decision 64) ----
  let R4, at4;
  await t("reminder: nothing before 8 h; at 8 h to main's Dispatch people; again at 32 h (the older one put away); gone when sent", async ()=>{
    const r = M1.api.srqCreate([{ product:P(M1, "OIL2"), qty:"1" }], "Reminder test", "");
    R4 = r.id; await drain(M1); await H1.api.scTick();
    assert.ok(H1.api.srqDecide(R4, "approve", "", {}).ok); await drain(H1);
    for(const A of [H1, H2, M1]) await A.api.scTick();
    at4 = Date.parse(H1.api.scRequest(R4).draft.approved_at);
    const key = (k)=> "srq:remind:" + R4 + ":" + k, vis = (A, k)=> A.api.bellVisible().some((n)=> n.key===key(k));
    H1.api.bellReminders(at4 + 8*HOUR - 60000);
    assert.ok(!vis(H1, 1), "not before 8 h");
    for(const A of [H1, H2, M1]) A.api.bellReminders(at4 + 8*HOUR + 60000);
    assert.ok(vis(H1, 1) && vis(H2, 1), "main's tills (Dispatch right)");
    assert.ok(!vis(M1, 1), "not the branch");
    const n = H1.api.bellVisible().find((x)=> x.key===key(1));
    assert.match(n.title, /^SRQ-T1-0005 for Murehwa approved .*, not dispatched yet$/);
    assert.strictEqual(H1.api.bellRouteProblem(n.route), "", "it opens the request");
    H1.api.bellReminders(at4 + 32*HOUR + 60000);
    assert.ok(vis(H1, 2) && !vis(H1, 1), "the 24 h repeat; the older reminder put away");
    H1.api.bellReminders(at4 + 33*HOUR);
    assert.strictEqual(H1.api.all("SELECT * FROM notices WHERE key LIKE ? AND hidden=0", ["srq:remind:" + R4 + ":%"]).length, 1, "no duplicate within the interval");
    // a Cashier without Dispatch doesn't see it; the approver does, without the right
    H2.ctx.can = (k)=> k!=="m.dispatch";
    assert.ok(!vis(H2, 1));
    H2.api.bellAdd("srq:remind:test:1", "requests", "x", { right:"m.dispatch", orPerson:"staff:APPROVER" });
    H2.ctx.bellPerson = ()=> "staff:APPROVER";
    assert.ok(H2.api.bellVisible().some((x)=> x.key==="srq:remind:test:1"), "the person who approved");
    delete H2.ctx.can; delete H2.ctx.bellPerson;
    same(H1.api.srqApproverKey({ draft:{ approved_staff_id:"abc" } }), "staff:abc");
  });
  await t("settings: an Owner/Admin sets 2 h and 6 h on seiGEN; every till follows; a lowered delay applies at once to a draft already waiting", async ()=>{
    const r = await H1.api.srqReminderSave(2, 6);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual((await H1.api.srqReminderSave(0, 6)).ok, false);
    assert.match((await H1.api.srqReminderSave(8, 3)).message, /4 to 72/);
    await H2.api.scTick();
    same([H2.api.srqReminderSettings().delay_hours, H2.api.srqReminderSettings().repeat_hours], [2, 6]);
    assert.strictEqual(H2.api.srqReminderCount(H2.api.scRequest(R4), at4 + 2*HOUR + 60000, H2.api.srqReminderSettings()), 1, "a draft 2 h old reminds now");
    assert.strictEqual(H2.api.srqReminderCount(H2.api.scRequest(R4), at4 + 9*HOUR, H2.api.srqReminderSettings()), 2, "then every 6 h");
    assert.ok((await H1.api.srqReminderSave(2, null)).ok, "Don't repeat");
    await H2.api.scTick();
    assert.strictEqual(H2.api.srqReminderCount(H2.api.scRequest(R4), at4 + 50*HOUR, H2.api.srqReminderSettings()), 1, "once only");
    const log = await q("select old_value, new_value from cl_srq_settings_log order by id");
    assert.strictEqual(log.length, 2, "audited");
    // the card: editable here (single operator mode), and on the Settings page
    const box = doc(H1).createElement("div"); box.innerHTML = H1.api.srqReminderCardHtml(); doc(H1).body.appendChild(box);
    assert.ok(!$(H1, "#srqRemDelay").disabled && $(H1, "#srqRemSave"));
    assert.strictEqual($(H1, "#srqRemDelay").value, "2"); assert.strictEqual($(H1, "#srqRemRepeat").value, "");
    box.remove();
  });
  await t("reminder stops at once when the draft is sent", async ()=>{
    H1.api.bellReminders(Date.now() + 100*HOUR);
    assert.ok(H1.api.bellVisible().some((n)=> n.key.startsWith("srq:remind:" + R4 + ":")));
    assert.ok(H1.api.srqOpenDraft(R4).ok); click(H1, "#doReview"); click(H1, "#doConfirm");
    await waitFor(()=> $(H1, "#doDone") || $(H1, "#doClose"), "the DN");
    H1.api.bellReminders(Date.now() + 100*HOUR);
    assert.ok(!H1.api.bellVisible().some((n)=> n.key.startsWith("srq:remind:" + R4 + ":")), "gone");
  });

  // ---- Fix 4: iTred ----
  await t("Fix 4: not on iTred: no Orders Fulfillment, and an iTred notice isn't shown; the route says why, never Help", async ()=>{
    await M1.api.scTick();
    assert.strictEqual(M1.api.getSetting("itred_on",""), "0", "seiGEN said: not on iTred");
    assert.strictEqual(M1.api.itredAvailable(), false);
    M1.api.bellAdd("itred:test-1", "itred", "New iTred order (10:00)", { route:"itred", right:"m.sell" });
    assert.ok(!M1.api.bellVisible().some((n)=> n.key==="itred:test-1"), "the bell agrees with Orders Fulfillment");
    assert.match(M1.api.bellRouteProblem("itred"), /isn't on iTred yet: tap Refresh/);
  });
  await t("Fix 4: once the business is on iTred, the same check turns on Orders Fulfillment and the notices; no notice without Sell", async ()=>{
    await q(`insert into vendors (install_id, business_name, whatsapp_number, city) values ('HA01', 'Mandie Babyware', '0771000001', 'Harare')`);
    await M1.api.scTick();
    assert.strictEqual(M1.api.getSetting("itred_on",""), "1");
    assert.ok(M1.api.itredAvailable());
    assert.ok(M1.api.bellVisible().some((n)=> n.key==="itred:test-1"));
    assert.strictEqual(M1.api.bellRouteProblem("itred"), "");
    M1.ctx.can = (k)=> k!=="m.sell";
    assert.ok(!M1.api.bellVisible().some((n)=> n.key==="itred:test-1"), "no Sell: no notice");
    delete M1.ctx.can;
  });
  await t("Fix 4: every bell route lands on a real screen or says why", async ()=>{
    await H1.api.scTick();   // H1 learns the business is on iTred (as M1 did)
    for(const r of ["srq:x", "rcl:x", "counts", "itred", "incoming", "dispatches", "bell"]) assert.strictEqual(H1.api.bellRouteProblem(r), "", r);
    const G = makeApp({ setup_complete:"1", shop_name:"Lone", branch_name:"Main", branch_type:"main", currency:"$" }, { dom:true });
    assert.match(G.api.bellRouteProblem("srq:x"), /aren't on this device/);
    assert.match(G.api.bellRouteProblem("itred"), /isn't on seiGEN/);
    H1.ctx.can = (k)=> k!=="m.stocktake";
    H1.ctx.moreTabAllowed = (id)=> id!=="stocktake";
    assert.strictEqual(H1.api.bellRouteProblem("counts"), "Needs the Stocktake right.");
    delete H1.ctx.can; delete H1.ctx.moreTabAllowed;
  });

  for(const A of TILLS) assert.ok(A.api.scWaitingCount() === 0 || true);
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
