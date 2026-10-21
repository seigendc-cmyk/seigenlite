// node test/office-seat.test.js
//
// Office seats (v32, seiGEN 20261109120000_office_seats): the REAL app code
// (test/harness.js, JSDOM for the screens) on a main till and a new device,
// against the REAL server SQL in PGlite, never the live database:
//   - the invite: Owner/Admin signed in only; the code, the link (#seat=, no
//     secret), the WhatsApp text; revoke;
//   - the install page for Android Chrome, desktop Edge/Chrome, iPhone Safari
//     and the WhatsApp/Facebook in-app browsers: always the code + Copy code,
//     never a Join button in a browser tab; only the code is kept;
//   - joining inside the installed app (code filled in), the PIN, "Waiting for
//     approval" with the device check; nothing else opens meanwhile;
//   - approval on the main till: the same check, a checkbox before Approve;
//   - the approved seat: no Sell, Credit, End of Day; single operator mode never;
//     no secret phrase card or cash drawer; its calls carry the person's token;
//   - an internal transfer seat -> till with a shortage, written off;
//   - the business's bill shows the seat at USD 3.00.
"use strict";
const assert = require("assert");
const vm = require("vm");
const crypto = require("crypto");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); }
}
const flat = (s)=> String(s).replace(/\s+/g, " ");
const tick = ()=> new Promise((r)=> setTimeout(r, 20));
async function until(cond, what){ for(let i = 0; i < 300; i++){ if(await cond()) return; await tick(); } throw new Error("timed out: " + what); }
const UA = {
  androidChrome: "Mozilla/5.0 (Linux; Android 14; SM-A156E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  desktopEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  desktopChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  whatsappAndroid: "Mozilla/5.0 (Linux; Android 14; SM-A156E; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 WhatsApp/2.24.20.89",
  facebookIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.38.104;FBBV/656677460]",
  instagramAndroid: "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.42.89 Android",
};

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== "20261109120000_office_seats.sql") });
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
  const calls = [];
  function device(name, settings, o){
    const A = makeApp(settings, { dom:true });
    A.name = name; A.alerts = [];
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      calls.push({ dev:name, fn:m[1], body:String(opts.body) });
      const r = await serial(()=> rpcNow(m[1], JSON.parse(opts.body)));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.hook("alert", (m)=>{ A.alerts.push(String(m)); });
    A.hook("confirm", ()=> true);
    vm.runInContext(`var $app = document.getElementById("app"); var APP_VERSION = "test";`, A.ctx);
    A.standalone = (on)=> vm.runInContext(`window.matchMedia = (q)=>({ matches: ${on? "/standalone/.test(q)" : "false"}, addEventListener(){}, removeListener(){} });`, A.ctx);
    A.ua = (ua)=> Object.defineProperty(A.dom.window.navigator, "userAgent", { value:ua, configurable:true });
    A.standalone(!!(o && o.standalone));
    return A;
  }
  const doc = (A)=> A.dom.window.document;
  const $ = (A, sel)=> doc(A).querySelector(sel);
  const modal = (A)=> { const m = doc(A).querySelectorAll(".modalOverlay"); return m[m.length - 1]; };
  const txt = (A)=> flat(doc(A).getElementById("app").textContent);

  const J1 = device("J1", { setup_complete:"1", secret_phrase:"Kuda Phrase", install_date:"2026-09-01", install_id:"KU01",
    shop_name:"Kuda Stores", branch_name:"Avondale", branch_id:"B-AVON0001", branch_type:"main" });
  let tenId = null;

  await t("setup: main T1 registers; its first manager Boss (Admin) is added and signs in", async ()=>{
    assert.ok((await J1.api.registerMainBranch("Counter")).ok);
    await J1.api.staffPull();
    const roles = Object.fromEntries(J1.api.shopRoles().map((r)=> [r.builtin || r.name, r.id]));
    const r = await serial(()=> rpcNow("cl_device_staff_save", Object.assign(J1.api.terminalAuth(), { p_staff_token:null,
      p_staff:{ name:"Boss", role_id:roles.admin, home_branch_id:J1.api.getSetting("branch_uuid",""), pin:"1234", ...J1.api.adminCheckMake("1234") && (()=>{ const c = J1.api.adminCheckMake("1234"); return { pin_salt:c.salt, pin_check:c.check, pin_rounds:c.rounds }; })() } })));
    assert.ok(JSON.parse(r.body).ok, r.body);
    assert.ok((await J1.api.staffPull()).ok);
    J1.api.setSetting("single_operator_mode", "0");
    const boss = J1.api.shopStaffAll().find((s)=> s.name === "Boss");
    const s = await J1.api.attemptShopSigninAsync(boss.id, "1234");
    assert.ok(s && s.ok !== false, JSON.stringify(s));
    assert.ok(await J1.api.staffEnsureToken(), "Boss has a seiGEN token");
  });

  let inv = null;
  await t("the invite: made by the signed-in Admin; the link carries only the code; the WhatsApp text has no secret", async ()=>{
    const roles = Object.fromEntries(J1.api.shopRoles().map((r)=> [r.builtin || r.name, r.id]));
    const r = await J1.api.seatInviteCreate({ name:"Tendai", roleId:roles.manager });
    assert.ok(r.ok, JSON.stringify(r));
    inv = r.data;
    assert.match(inv.code, /^[A-Z0-9]{8}$/);
    const link = J1.api.seatInviteLink(inv.code);
    assert.strictEqual(link, "http://localhost/#seat=" + inv.code, "the app's own address, the code after #");
    const text = J1.api.seatShareText(inv, link);
    assert.match(text, /Tendai/); assert.match(text, new RegExp(inv.code.slice(0, 4) + "-" + inv.code.slice(4)));
    assert.ok(!/Kuda Phrase/i.test(text + link), "no secret phrase");
    assert.ok(!/1234/.test(text + link), "no PIN");
    // the result screen
    const w = J1.api.openSeatInviteModal ? null : null; void w;
  });

  await t("the invite screens: Create invite -> the code, the message, WhatsApp, Copy, Revoke", async ()=>{
    const m = J1.api.openSeatInviteModal();
    assert.ok(m.querySelector("#seatWho") && m.querySelector("#seatRole") && m.querySelector("#seatCreate"));
    assert.ok(![...m.querySelectorAll("#seatRole option")].some((o)=> /Cashier/.test(o.textContent)), "no Cashier role offered");
    m.querySelector("#seatName").value = "Rufaro";
    await m.querySelector("#seatCreate").onclick();
    const res = modal(J1);
    assert.match(res.querySelector("h3").textContent, /Invite ready/);
    assert.match(res.querySelector("#seatInvCode").textContent, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.match(res.querySelector("#seatShareWa").getAttribute("href"), /^https:\/\/wa\.me\/\?text=/);
    assert.ok(res.querySelector("#seatCopyMsg") && res.querySelector("#seatCopyCode2") && res.querySelector("#seatRevokeNow"));
    await res.querySelector("#seatRevokeNow").onclick({ currentTarget: res.querySelector("#seatRevokeNow") });
    assert.match(res.querySelector("#seatInvMsg").textContent, /Revoked/);
    res.remove();
  });

  await t("no invite without the Owner or an Admin signed in", async ()=>{
    J1.api.staffSignOut();
    const r = await J1.api.seatInviteCreate({ name:"X", roleId:J1.api.shopRoles()[1].id });
    assert.ok(!r.ok);
    const boss = J1.api.shopStaffAll().find((s)=> s.name === "Boss");
    await J1.api.attemptShopSigninAsync(boss.id, "1234"); await J1.api.staffEnsureToken();
  });

  const S = device("S", {});   // a fresh install opening the link
  await t("the device detection: Android Chrome, desktop Edge and Chrome, iPhone Safari, WhatsApp/Facebook/Instagram in-app", async ()=>{
    const d = (ua)=> S.api.seatDevice(ua);
    assert.ok(d(UA.androidChrome).android && !d(UA.androidChrome).inApp && d(UA.androidChrome).browser === "Chrome");
    assert.ok(d(UA.desktopEdge).desktop && d(UA.desktopEdge).browser === "Edge");
    assert.ok(d(UA.desktopChrome).desktop && d(UA.desktopChrome).browser === "Chrome");
    assert.ok(d(UA.iphoneSafari).ios && !d(UA.iphoneSafari).inApp && d(UA.iphoneSafari).browser === "Safari");
    assert.ok(d(UA.whatsappAndroid).inApp && d(UA.whatsappAndroid).inAppName === "WhatsApp");
    assert.ok(d(UA.facebookIos).inApp && d(UA.facebookIos).inAppName === "Facebook");
    assert.ok(d(UA.instagramAndroid).inApp && d(UA.instagramAndroid).inAppName === "Instagram");
  });

  await t("the install page in a browser tab: the code + Copy code always; the steps for each device; never a Join button", async ()=>{
    for(const [ua, id] of [[UA.androidChrome, "#seatStepsAndroid"], [UA.desktopEdge, "#seatStepsDesktop"], [UA.iphoneSafari, "#seatStepsIos"], [UA.whatsappAndroid, "#seatInApp"], [UA.facebookIos, "#seatInApp"]]){
      S.ua(ua);
      S.api.renderSeatEntry(inv.code);
      assert.ok($(S, id), id + " for " + ua.slice(0, 40));
      assert.strictEqual($(S, "#seatCode").textContent, inv.code.slice(0, 4) + "-" + inv.code.slice(4));
      assert.ok($(S, "#seatCopyCode"), "Copy code");
      assert.ok(!$(S, "#seatJoinGo"), "no Join button in a browser tab");
    }
    S.ua(UA.whatsappAndroid); S.api.renderSeatEntry(inv.code);
    assert.match(txt(S), /You're inside WhatsApp's browser/); assert.match(txt(S), /Open in Chrome/);
    S.ua(UA.facebookIos); S.api.renderSeatEntry(inv.code);
    assert.match(txt(S), /Open in Safari/);
    S.ua(UA.iphoneSafari); S.api.renderSeatEntry(inv.code);
    assert.match(txt(S), /Add to Home Screen/); assert.match(txt(S), /paste the code/);
    const kept = JSON.parse(S.dom.window.localStorage.getItem("scl_seat_invite"));
    assert.deepStrictEqual(Object.keys(kept).sort(), ["code", "ts"], "only the code is kept for the installed app");
  });

  let check = null;
  await t("inside the installed app: the code is filled in; Join -> Choose your PIN -> Waiting for approval with the device check", async ()=>{
    S.standalone(true); S.ua(UA.androidChrome);
    S.api.renderSeatEntry("");
    assert.strictEqual($(S, "#seatJoinCode").value, inv.code.slice(0, 4) + "-" + inv.code.slice(4), "filled in from the install page");
    await $(S, "#seatJoinGo").onclick();
    await until(()=> $(S, "#seatPinCard"), "the PIN screen");
    assert.match(txt(S), /Choose your PIN/); assert.match(txt(S), /Tendai/);
    assert.strictEqual(S.api.getSetting("terminal_kind", ""), "seat");
    assert.ok(/^[0-9a-f]{48}$/.test(S.api.getSetting("secret_phrase", "")), "the seat's own phrase");
    assert.notStrictEqual(S.api.getSetting("secret_phrase", ""), "Kuda Phrase");
    assert.strictEqual(S.api.getSetting("terminal_id", ""), "", "no till identity before approval");
    $(S, "#seatPin").value = "5151"; $(S, "#seatPin2").value = "5150";
    await $(S, "#seatPinGo").onclick();
    assert.match($(S, "#seatPinMsg").textContent, /aren't the same/);
    $(S, "#seatPin2").value = "5151";
    await $(S, "#seatPinGo").onclick();
    await until(()=> $(S, "#seatWaitCard"), "the waiting screen");
    assert.match(txt(S), /Waiting for approval by the Owner or an Admin/);
    check = $(S, "#seatCheck").textContent;
    assert.strictEqual(check, S.api.seatCheckOf(S.api.getSetting("device_key", "")));
    assert.strictEqual(S.api.seatWaiting(), true, "the app opens nothing else until approved (router.js, main.js)");
  });

  await t("the main till: the waiting seat with the same check; Approve only after ticking that the check matches", async ()=>{
    const host = doc(J1).createElement("div"); doc(J1).body.appendChild(host);
    host.innerHTML = J1.api.seatSectionHtml();
    await J1.api.wireSeatSection();
    await until(()=> host.querySelector("[data-seat-approve]"), "the pending seat");
    assert.match(flat(host.textContent), /Tendai · Manager/); assert.match(flat(host.textContent), /Android · Chrome/);
    host.querySelector("[data-seat-approve]").onclick();
    const m = modal(J1);
    assert.strictEqual(m.querySelector("#seatApproveCheck").textContent, check, "the same check on both screens");
    assert.ok(m.querySelector("#seatApproveGo").disabled, "Approve waits for the tick");
    m.querySelector("#seatCheckSame").checked = true; m.querySelector("#seatCheckSame").onchange();
    await m.querySelector("#seatApproveGo").onclick();
    await until(async ()=> (await q(`select approval_status from cl_terminals where device_kind = 'seat'`))[0].approval_status === "approved", "approved on seiGEN");
    host.remove();
  });

  await t("the seat sees the approval, gets the main branch's data, and Tendai signs in with the PIN", async ()=>{
    await S.api.seatCheckStatus(true);
    await until(()=> S.api.getSetting("terminal_id", "") && S.api.getSetting("seat_approval", "") === "approved", "approved here");
    await until(()=> S.api.shopStaffHere().some((s)=> s.name === "Tendai"), "Tendai pulled");
    assert.strictEqual(S.api.getSetting("till_code", ""), "S1");
    assert.strictEqual(S.api.getSetting("terminal_is_main", ""), "1");
    tenId = S.api.shopStaffAll().find((s)=> s.name === "Tendai").id;
    const r = await S.api.attemptShopSigninAsync(tenId, "5151");
    assert.ok(r && r.ok !== false, JSON.stringify(r));
    assert.ok(await S.api.staffEnsureToken(), "a seiGEN token");
    assert.match(S.api.terminalAuth().p_secret_phrase, /^[0-9a-f]{48}\|[0-9a-f]+$/, "the seat's calls carry the token");
  });

  await t("on the seat: no Sell, Credit or End of Day; never single operator mode; no secret phrase card or cash drawer", async ()=>{
    assert.strictEqual(S.api.isSeat(), true);
    const rights = S.api.currentRights();
    for(const x of ["m.sell", "m.credit", "m.eod", "void_return", "credit_over_limit"]) assert.ok(!rights.has(x), x);
    assert.ok(rights.has("m.products") && rights.has("m.receive") && rights.has("m.dispatch"), "a Manager's stores rights");
    assert.strictEqual(S.api.navAllowed("pos"), false); assert.strictEqual(S.api.navAllowed("credit"), false);
    assert.strictEqual(S.api.singleOperatorMode(), false);
    S.api.setSetting("single_operator_mode", "1");
    assert.strictEqual(S.api.singleOperatorMode(), false, "even if the setting says on");
    const host = doc(S).createElement("div"); doc(S).body.appendChild(host);
    host.innerHTML = S.api.shopStaffSectionHtml();
    assert.ok(host.querySelector("#seatNoSingle"), "Staff & Roles says single operator mode is never used here");
    assert.ok(host.querySelector("#sSingleOperator").closest("label").hidden, "... and hides the switch");
    host.remove();   // (the secret phrase card and the cash drawer: test/office-seat-e2e.test.js, in the full app)
    S.api.staffSignOut();
    assert.strictEqual(S.api.currentRights().size, 0, "nobody signed in: nothing");
    await S.api.attemptShopSigninAsync(tenId, "5151"); await S.api.staffEnsureToken();
  });

  await t("an internal transfer: the seat sends 10 to T1, T1 confirms 8, the 2 go back to the seat, written off with Tendai's PIN", async ()=>{
    for(const A of [S, J1]){
      A.api.run(`INSERT INTO products(name,price,stock,sku,branch,cost) VALUES('Bottle warmer',12,?,'BW-1',?,7)`, [A === S? 20 : 1, A.api.currentBranch()]);
      A.api.recordStockMovement(A.api.one("SELECT id FROM products WHERE sku='BW-1'").id, A === S? 20 : 1, { kind:"opening" });
      await A.api.itRefreshDevices();
    }
    assert.strictEqual(JSON.stringify(S.api.itTargets().map((d)=> d.till_code)), '["T1"]', "the seat sends to the main till");
    assert.ok(J1.api.itTargets().some((d)=> d.till_code === "S1"), "... and T1 to the seat");
    assert.ok(S.api.itAvailable() && J1.api.itAvailable());
    const pid = S.api.one("SELECT id FROM products WHERE sku='BW-1'").id;
    const x = await S.api.itSend({ toId:S.api.itTargets()[0].id, lines:[{ productId:pid, qty:10 }], note:"Shelf refill" });
    assert.match(x.it_display, /^IT-S1-0001$/);
    assert.strictEqual(S.api.one("SELECT stock FROM products WHERE id=?", [pid]).stock, 10);
    await J1.api.itPull();
    assert.strictEqual(J1.api.itCache().incoming.filter((y)=> y.status === "sent").length, 1);
    await J1.api.itReceive(x.id, { 1:8 });
    assert.strictEqual(J1.api.one("SELECT stock FROM products WHERE sku='BW-1'").stock, 9);
    await S.api.itPull();
    assert.strictEqual(S.api.one("SELECT stock FROM products WHERE id=?", [pid]).stock, 12, "the 2 short are back on the seat");
    await S.api.itResolve(x.id, 1, "write_off", { reason:"Lost on the way", passcode:"5151" });
    assert.strictEqual(S.api.one("SELECT stock FROM products WHERE id=?", [pid]).stock, 10);
    assert.ok(S.api.one("SELECT 1 AS x FROM stock_adjustments WHERE reason='Lost in transit' AND qty_delta=-2"), "the ADJ");
    await S.api.itPull(); await J1.api.itPull();
    assert.strictEqual(S.api.one("SELECT stock FROM products WHERE id=?", [pid]).stock, 10, "pulling again moves nothing");
    assert.strictEqual(J1.api.one("SELECT stock FROM products WHERE sku='BW-1'").stock, 9);
    assert.strictEqual(S.api.stockLedgerCheck().mismatches.length, 0, "the seat's ledger adds up");
    assert.strictEqual(J1.api.stockLedgerCheck().mismatches.length, 0, "T1's ledger adds up");
    const host = doc(S).createElement("div"); doc(S).body.appendChild(host);
    await S.api.renderTransfers(host);
    assert.match(flat(host.textContent), /IT-S1-0001/); assert.match(flat(host.textContent), /written off/);
    assert.match(flat(host.textContent), /at cost/, "a Manager sees the value at cost");
    host.remove();
  });

  await t("the business's bill: T1 main USD 15.00, S1 Office seat USD 3.00, total USD 18.00", async ()=>{
    await J1.api.refreshBusinessBill();
    const h = flat(J1.api.businessBillHtml());
    assert.match(h, /T1 · main till USD 15\.00/); assert.match(h, /S1 \(Office seat\) · Office seat USD 3\.00/); assert.match(h, /Total USD 18\.00 per 30 days/);
  });

  await t("nothing secret went over the wire in a link or a code; the seat never sent the business phrase", async ()=>{
    assert.ok(!calls.filter((c)=> c.dev === "S").some((c)=> /Kuda Phrase/i.test(c.body)), "the seat never sent the business phrase");
    const join = calls.find((c)=> c.fn === "cl_seat_join");
    assert.ok(join && !/secret_phrase/.test(join.body), "joining sends no phrase at all");
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
