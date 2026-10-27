// node test/fix-a-v36.test.js
//
// v36 Fix-A in the app: the REAL app code (test/harness.js, JSDOM for the
// screens) against the REAL server SQL in PGlite (with 20261113180000 and
// 20261114120000), never the live database:
//   A1  a removed device: seiGEN refuses its check-in; the app says "This
//       device belongs to a business that no longer exists on seiGEN. Reset
//       this device", offers "Save a backup first", clears nothing until Reset;
//       a registered till is unaffected; a new install registers.
//   A11 single operator mode: no token, as before (seiGEN logs it); staff
//       sign-in mode: the till tells seiGEN, sends the person's token, a
//       Cashier's customer is refused by seiGEN and stays queued, listed for
//       managers; it goes when someone with the right sends it; offline work
//       queues and is checked when sent; back to single needs Settings.
//   A12 the Guest: added by the Admin with an end date, tagged in Staff; never
//       on a till; on her Office seat only stock and each branch's selling
//       prices (no costs); the seat skips everything else; after the end date
//       the session ends; a seat never has Sell or End of Day for any role.
//   A13 a linked RPN: read-only details from seiGEN, "To change your RPN,
//       contact Digital Commerce", no edit fields.
//   A5  About: seiGEN's company details and numbers, kept for offline.
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
const V36 = ["20261113180000_removed_devices.sql", "20261114120000_roles_everywhere.sql"];

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> !V36.includes(f)) });
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
    const A = makeApp(settings, Object.assign({ dom:true }, o||{}));
    A.name = name; A.alerts = []; A.downloads = [];
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
    A.hook("downloadDb", (f)=>{ A.downloads.push(f); });
    vm.runInContext(`var $app = document.getElementById("app"); var APP_VERSION = "test";`, A.ctx);
    A.standalone = (on)=> vm.runInContext(`window.matchMedia = (q)=>({ matches: ${on? "/standalone/.test(q)" : "false"}, addEventListener(){}, removeListener(){} });`, A.ctx);
    A.standalone(!!(o && o.standalone));
    return A;
  }
  const doc = (A)=> A.dom.window.document;
  const modal = (A)=> { const m = doc(A).querySelectorAll(".modalOverlay"); return m[m.length - 1]; };
  const closeModals = (A)=> doc(A).querySelectorAll(".modalOverlay").forEach((m)=> m.remove());
  const sectionText = (A)=>{ const h = doc(A).createElement("div"); h.innerHTML = A.api.shopStaffSectionHtml(); const s = flat(h.textContent); return { h, s }; };

  const J1 = device("J1", { setup_complete:"1", secret_phrase:"Kuda Phrase", install_date:"2026-09-01", install_id:"KU01",
    shop_name:"Kuda Stores", branch_name:"Avondale", branch_id:"B-AVON0001", branch_type:"main" }, { extra:["help.js"] });
  const ID = {};
  const mk = (pin)=>{ const c = J1.api.adminCheckMake(pin); return { pin, pin_salt:c.salt, pin_check:c.check, pin_rounds:c.rounds }; };

  await t("setup: main T1 registers; Boss (Admin) and Rudo (Cashier) are on seiGEN; T1 learns that seiGEN checks tills", async ()=>{
    assert.ok((await J1.api.registerMainBranch("Counter")).ok);
    await J1.api.staffPull();
    const roles = Object.fromEntries(J1.api.shopRoles().map((r)=> [r.builtin || r.name, r.id]));
    let r = JSON.parse((await serial(()=> rpcNow("cl_device_staff_save", Object.assign(J1.api.terminalAuth(), { p_staff_token:null,
      p_staff:Object.assign({ name:"Boss", role_id:roles.admin, home_branch_id:J1.api.getSetting("branch_uuid","") }, mk("1234")) })))).body);
    assert.ok(r.ok, JSON.stringify(r)); ID.Boss = r.staff.id;
    assert.ok((await J1.api.staffPull()).ok);
    await J1.api.attemptShopSigninAsync(ID.Boss, "1234");
    r = await J1.api.saveShopStaff({ name:"Rudo", role_id:roles.cashier, home_branch_id:J1.api.getSetting("branch_uuid",""), pin:"3333" });
    ID.Rudo = r.id;
    J1.api.staffSignOut();
    assert.ok((await J1.api.staffPull()).ok);
    assert.strictEqual(J1.api.getSetting("srv_staff_mode",""), "single", "seiGEN answered with this till's mode");
    assert.strictEqual(J1.api.tillRightsOn(), true);
  });

  // ---------------- A11 ----------------
  const addCustomer = (A, name, phone)=> A.api.run(`INSERT INTO customers(name,phone,phone_norm,branch,updated_ts,srv_status) VALUES(?,?,?,?,?,'queued')`,
    [name, phone, phone.replace(/\D/g, ""), A.api.currentBranch(), new Date().toISOString()]);
  const cust = (A, name)=> A.api.one("SELECT * FROM customers WHERE name=?", [name]);

  await t("A11 single operator mode (today's default): no token sent, the customer goes as before, seiGEN logs \"single operator\"", async ()=>{
    assert.strictEqual(J1.api.singleOperatorMode(), true);
    assert.strictEqual(J1.api.tillSendsToken(), false);
    assert.strictEqual(J1.api.terminalAuth().p_secret_phrase, "Kuda Phrase");
    addCustomer(J1, "Chipo One", "0771000001");
    await J1.api.custSendPending();
    assert.strictEqual(cust(J1, "Chipo One").srv_status, "sent");
    assert.strictEqual((await q(`select count(*)::int n from cl_till_rights_log where how = 'single operator' and right_key = 'create_customers'`))[0].n, 1);
  });

  await t("A11 staff sign-in mode on: T1 tells seiGEN (no token needed), then sends the signed-in person's token", async ()=>{
    J1.api.setSetting("single_operator_mode", "0");
    assert.strictEqual(await J1.api.staffModeSync(), "roles");
    assert.strictEqual((await q(`select staff_mode from cl_terminals where install_id = 'KU01'`))[0].staff_mode, "roles");
    const r = await J1.api.attemptShopSigninAsync(ID.Rudo, "3333");
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(await J1.api.staffEnsureToken());
    assert.match(J1.api.terminalAuth().p_secret_phrase, /^Kuda Phrase\|[0-9a-f]{64}$/);
  });

  await t("A11 Rudo (Cashier, no \"Create customers\"): seiGEN refuses the customer; it stays queued and is listed for managers", async ()=>{
    addCustomer(J1, "Tafadzwa Two", "0771000002");
    await J1.api.custSendPending();
    const c = cust(J1, "Tafadzwa Two");
    assert.strictEqual(c.srv_status, "queued", "kept, never dropped");
    assert.match(c.srv_error, /Rudo doesn't have the right for this \(create_customers\)/);
    const w = J1.api.rightsWaiting();
    assert.strictEqual(w.length, 1); assert.strictEqual(w[0].fn, "cl_device_customer_save"); assert.strictEqual(w[0].code, "STAFF_NO_RIGHT");
    assert.match(sectionText(J1).s, /Waiting for someone with the right.*A customer: Rudo doesn't have the right/);
    assert.ok(J1.api.one("SELECT 1 AS x FROM audit_log WHERE action='Refused by seiGEN (rights)'"), "in the activity log");
    assert.strictEqual(Number((await q(`select count(*)::int n from cl_customers where name = 'Tafadzwa Two'`))[0].n), 0, "not on seiGEN");
  });

  await t("A11 Boss (Admin) signs in: the same customer goes; the waiting line clears", async ()=>{
    J1.api.staffSignOut();
    await J1.api.attemptShopSigninAsync(ID.Boss, "1234"); await J1.api.staffEnsureToken();
    await J1.api.custSendPending();
    assert.strictEqual(cust(J1, "Tafadzwa Two").srv_status, "sent");
    assert.strictEqual(J1.api.rightsWaiting().length, 0);
    assert.ok(!/Waiting for someone with the right/.test(sectionText(J1).s));
  });

  await t("A11 offline: Rudo signs in offline and adds a customer; it queues; back online it is checked when sent (refused, kept)", async ()=>{
    J1.api.staffSignOut();
    J1.ctx.navigator.onLine = false;
    const r = await J1.api.attemptShopSigninAsync(ID.Rudo, "3333");
    assert.ok(r.ok, "offline sign-in works as before");
    assert.strictEqual(J1.api.staffToken(), null, "no seiGEN token yet");
    addCustomer(J1, "Offline Three", "0771000003");
    await J1.api.custSendPending();
    assert.strictEqual(cust(J1, "Offline Three").srv_status, "queued");
    J1.ctx.navigator.onLine = true;
    const before = calls.filter((c)=> c.fn === "cl_device_staff_signin").length;
    await J1.api.custSendPending();
    assert.ok(calls.filter((c)=> c.fn === "cl_device_staff_signin").length > before, "the token is fetched first");
    assert.strictEqual(cust(J1, "Offline Three").srv_status, "queued");
    assert.match(cust(J1, "Offline Three").srv_error, /Rudo doesn't have the right/);
  });

  await t("A11 back to single operator mode: refused for Rudo (no Settings); Boss turns it back on seiGEN", async ()=>{
    J1.api.setSetting("single_operator_mode", "1");
    await J1.api.staffModeSync();
    assert.strictEqual(J1.api.getSetting("srv_staff_mode",""), "roles", "seiGEN keeps sign-in mode");
    assert.match(J1.api.getSetting("staff_mode_problem",""), /Settings right/);
    assert.match(sectionText(J1).s, /seiGEN still has this till in staff sign-in mode/);
    J1.api.staffSignOut();
    await J1.api.attemptShopSigninAsync(ID.Boss, "1234");
    assert.strictEqual(await J1.api.staffModeSync(), "single");
    assert.strictEqual((await q(`select staff_mode from cl_terminals where install_id = 'KU01'`))[0].staff_mode, "single");
    assert.strictEqual(J1.api.getSetting("staff_mode_problem",""), "");
    assert.strictEqual(J1.api.tillSendsToken(), false, "single operator mode sends no token again");
    await J1.api.custSendPending();
    assert.strictEqual(cust(J1, "Offline Three").srv_status, "sent", "single operator: as before");
  });

  // ---------------- A12 ----------------
  let guestRole = null;
  await t("A12 the Guest role: built in, view only; only the Owner or an Admin may give it; Grace added with an end date", async ()=>{
    await J1.api.staffPull();
    guestRole = J1.api.shopRoles().find((r)=> r.builtin === "guest");
    assert.ok(guestRole, "the built-in Guest");
    assert.deepStrictEqual(Array.from(guestRole.rights).sort(), ["branch_prices", "m.productlist"]);
    const role = J1.api.openRoleModal(guestRole, ()=>{});
    assert.ok(!modal(J1).querySelector("#rlSave"), "no Save: it can't be changed");
    assert.match(flat(modal(J1).textContent), /view only/);
    closeModals(J1);
    void role;
    const m = J1.api.openShopStaffModal(null, ()=>{});
    const opt = [...m.querySelectorAll("#ssRole option")].find((o)=> o.value === guestRole.id);
    assert.ok(opt && !opt.disabled, "Boss (Admin) may pick Guest");
    m.querySelector("#ssRole").value = guestRole.id; m.querySelector("#ssRole").onchange();
    assert.strictEqual(m.querySelector("#ssGuestBox").hidden, false, "the end date shows");
    assert.strictEqual(m.querySelector("#ssBranchBox").hidden, true, "a Guest's branch is the main branch");
    m.querySelector("#ssName").value = "Grace"; m.querySelector("#ssPin").value = "7777";
    const day = new Date(Date.now() + 3 * 86400e3), p2 = (n)=> String(n).padStart(2, "0");
    m.querySelector("#ssUntil").value = day.getFullYear() + "-" + p2(day.getMonth() + 1) + "-" + p2(day.getDate());
    await m.querySelector("#ssSave").onclick();
    await until(()=> !doc(J1).querySelector(".modalOverlay #ssSave"), "saved");
    const g = (await q(`select s.*, r.builtin from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id where s.name = 'Grace'`))[0];
    assert.strictEqual(g.builtin, "guest"); assert.ok(g.guest_until && new Date(g.guest_until) > new Date(), "end date on seiGEN");
    ID.Grace = g.id;
    await J1.api.staffPull();
    assert.match(sectionText(J1).s, /Grace Guest · until/, "Staff shows the Guest tag and the end date");
  });

  await t("A12 a Guest never signs in on a till: not on its list, no PIN check value, refused", async ()=>{
    assert.ok(!J1.api.shopStaffHere().some((s)=> s.name === "Grace"));
    const st = J1.api.shopStaff(ID.Grace);
    assert.ok(st && !st.pin_check && Number(st.here) === 0);
    const r = await J1.api.attemptShopSigninAsync(ID.Grace, "7777");
    assert.strictEqual(r.ok, false);
  });

  const S = device("S", {}, { standalone:true });
  await t("A12 Grace's Office seat: invited (existing person), joins with her PIN, approved; a Guest seat holding only her", async ()=>{
    J1.api.staffSignOut(); await J1.api.attemptShopSigninAsync(ID.Boss, "1234"); await J1.api.staffEnsureToken();
    const inv = await J1.api.seatInviteCreate({ staffId:ID.Grace });
    assert.ok(inv.ok, JSON.stringify(inv));
    const j = await S.api.seatJoin(inv.data.code);
    assert.ok(j.ok, JSON.stringify(j));
    const p = await S.api.seatSetPin("7777");
    assert.ok(p.ok, JSON.stringify(p));
    const seatId = (await q(`select id from cl_terminals where device_kind = 'seat'`))[0].id;
    const a = JSON.parse((await serial(()=> rpcNow("cl_device_seat_approve", Object.assign(J1.api.terminalAuth(), { p_staff_token:J1.api.staffToken(),
      p_terminal_id:seatId, p_check:S.api.seatCheckOf(S.api.getSetting("device_key","")) })))).body);
    assert.ok(a.ok, JSON.stringify(a));
    await S.api.seatCheckStatus(false);
    await until(()=> S.api.getSetting("terminal_id",""), "approved here");
    await S.api.staffPull();
    assert.strictEqual(S.api.getSetting("seat_guest",""), "1");
    assert.strictEqual(JSON.stringify(S.api.shopStaffAll().map((s)=> s.name)), '["Grace"]');
  });

  await t("A12 on her seat: Stock by branch with every branch's selling prices (retail · wholesale), never a cost", async ()=>{
    const biz = (await q(`select business_id from cl_terminals where install_id = 'KU01'`))[0].business_id;
    const t1 = (await q(`select id, branch_id from cl_terminals where install_id = 'KU01'`))[0];
    const P1 = crypto.randomBytes(16).toString("hex");
    await q(`insert into cl_catalogue_products (business_id, product_uid, code, name, price, cost, wholesale_price, change_seq, last_op_id) values ($1, $2, 'BW-1', 'Bottle warmer', 12, 7.25, 10, 1, 'test')`, [biz, P1]);
    await q(`insert into cl_till_stock_levels (terminal_id, product_key, branch_id, cat_uid, code, name, qty, as_of) values ($1, $2, $3, $2, 'BW-1', 'Bottle warmer', 9, now())`, [t1.id, P1, t1.branch_id]);
    await q(`insert into cl_till_stock_push (terminal_id, branch_id, as_of, products) values ($1, $2, now(), 1)`, [t1.id, t1.branch_id]);
    const r = await S.api.attemptShopSigninAsync(ID.Grace, "7777");
    assert.ok(r.ok, JSON.stringify(r)); assert.ok(await S.api.staffEnsureToken());
    const rights = S.api.currentRights();
    assert.deepStrictEqual([...rights].sort(), ["branch_prices", "m.productlist"]);
    assert.strictEqual(S.api.navAllowed("pos"), false); assert.strictEqual(S.api.moreTabAllowed("settings"), false);
    assert.strictEqual(S.api.moreTabAllowed("branches"), true);
    assert.ok((await S.api.bsPull()).ok);
    const host = doc(S).getElementById("app");
    S.api.renderBranchStock(host);
    const txt = flat(host.textContent);
    assert.match(txt, /Bottle warmer/); assert.match(txt, /\$12\.00 · \$10\.00/);
    assert.ok(!/7\.25|value at cost/i.test(txt), "no cost anywhere");
    assert.ok(host.querySelector("#bsTabDisp").hidden, "no Dispatches tab on a Guest seat");
  });

  await t("A12 the Guest seat never asks for customers, suppliers, the catalogue, dispatches or the sales sync", async ()=>{
    const n = calls.length;
    for(const fn of ["cl_device_customers_pull", "cl_device_suppliers_pull", "cl_catalogue_pull", "cl_device_dispatch_pull", "cl_device_b4_push", "cl_device_transfers_pull"]){
      const r = await S.api.terminalRpc(fn, S.api.terminalAuth());
      assert.strictEqual(r.code, "GUEST_SEAT", fn);
    }
    assert.strictEqual(calls.length, n, "nothing reached seiGEN");
  });

  await t("A12 a seat never has Sell, Credit or End of Day, whatever the role", async ()=>{
    for(const b of ["owner", "admin", "manager", "stores"]){
      const role = S.api.shopRoles().find((r)=> r.builtin === b);
      S.api.run("UPDATE shop_staff SET role_id=?, guest_until='' WHERE id=?", [role.id, ID.Grace]);
      const rights = S.api.currentRights();
      for(const x of ["m.sell", "m.credit", "m.eod", "void_return", "credit_over_limit"]) assert.ok(!rights.has(x), b + ": " + x);
      assert.strictEqual(S.api.navAllowed("pos"), false, b);
    }
    await S.api.staffPull();   // back to seiGEN's copy (Guest)
    assert.ok(S.api.staffIsGuest(S.api.shopStaff(ID.Grace)));
  });

  await t("A12 after the end date: her session ends on the seat and sign-in is refused, offline too (seiGEN: GUEST_ENDED)", async ()=>{
    // the seat's own copy reaches the date (offline, no pull since)
    S.api.run("UPDATE shop_staff SET guest_until=? WHERE id=?", [new Date(Date.now() - 60000).toISOString(), ID.Grace]);
    assert.strictEqual(S.api.currentRights().size, 0);
    await tick();
    assert.strictEqual(S.api.staffSession(), null, "signed out");
    S.ctx.navigator.onLine = false;
    try{
      const r = await S.api.attemptShopSigninAsync(ID.Grace, "7777");
      assert.strictEqual(r.ok, false); assert.match(r.message, /access has ended/);
    } finally { S.ctx.navigator.onLine = true; }
    // seiGEN's end date: the next pull no longer lists her as able to sign in here (no PIN check value either)
    await q(`update cl_shop_staff set guest_until = now() - interval '1 minute' where id = $1`, [ID.Grace]);
    await S.api.staffPull();
    const st = S.api.shopStaff(ID.Grace);
    assert.ok(st && Number(st.here) === 0 && !st.pin_check, JSON.stringify(st));
    assert.strictEqual((await S.api.attemptShopSigninAsync(ID.Grace, "7777")).ok, false);
  });

  // ---------------- A13 ----------------
  await t("A13 a linked RPN: seiGEN's details read-only, \"To change your RPN, contact Digital Commerce\", nothing to edit", async ()=>{
    const biz = (await q(`select business_id from cl_terminals where install_id = 'KU01'`))[0].business_id;
    const rpn = (await q(`insert into cl_rpn (full_name, phone, city, passcode_hash, verification_code, field_force_no) values ('Tino', '+263771112223', 'Harare', 'x', 'V-T', 'RPN-014') returning id`))[0].id;
    await q(`update cl_businesses set rpn_id = $1 where id = $2`, [rpn, biz]);
    J1.api.setSetting("dc_vendor_id", (await q(`select id from cl_vendors where install_id = 'KU01'`))[0].id);
    await J1.api.refreshRpnStatus(true);
    assert.strictEqual(J1.api.rpnLocked(), true);
    const h = doc(J1).createElement("div"); h.innerHTML = J1.api.rpnSectionHtml();
    const s = flat(h.textContent);
    assert.match(s, /Onboarded by: Tino \(RPN-014\)/); assert.match(s, /To change your RPN, contact Digital Commerce/);
    assert.match(s, /WhatsApp: \+263771112223/);
    assert.ok(!h.querySelector("#saveRpnLink") && !h.querySelector("#linkRpnBtn") && !h.querySelector("#sRpnName"), "no edit fields");
    assert.strictEqual(J1.api.getRpnLink().rpn_whatsapp, "+263771112223", "Support uses seiGEN's number");
    const r = await serial(()=> pg.exec(`update cl_businesses set rpn_id = null where id = '${biz}'`).then(()=> "changed", (e)=> e.message));
    assert.match(r, /RPN_LOCKED/, "seiGEN refuses a change outside the Console permission");
  });

  // ---------------- A5 ----------------
  await t("A5 About: the company details from Console → Settings and the numbers from the Contact directory, kept for offline", async ()=>{
    await q(`insert into cl_app_settings (key, value, label) values ('company_name', 'Digital Commerce', 'Company name'), ('company_address', 'Commerce Valley Est, Marirangwe, Mhondoro', 'Company address') on conflict (key) do update set value = excluded.value`);
    const info = await J1.api.refreshAboutInfo();
    assert.ok(info && info.company && info.desks.length >= 1, JSON.stringify(info));
    const host = doc(J1).getElementById("app");
    J1.ctx.navigator.onLine = false;
    try{
      J1.api.renderAbout(host);
      const c = host.querySelector("#aboutCompany");
      assert.ok(c, "the company block");
      assert.strictEqual(c.querySelector("b").textContent, "Digital Commerce");
      assert.match(c.textContent, /Commerce Valley Est, Marirangwe, Mhondoro/);
      assert.strictEqual(c.querySelector("a").getAttribute("href"), "https://digitalcommerce.com");
      const s = flat(host.textContent);
      assert.match(s, /Queries Desk Main line: \+263774479121/); assert.match(s, /Sales Main line: \+263789487287/);
      assert.match(s, /From seiGEN · updated \d\d:\d\d/);
      assert.ok(host.querySelector("[data-about-wa='263774479121']"), "WhatsApp from the directory");
    } finally { J1.ctx.navigator.onLine = true; }
  });

  // ---------------- A1 ----------------
  const X = device("X", { setup_complete:"1", secret_phrase:"Gone Phrase", install_date:"2026-09-01", install_id:"GONE01", shop_name:"Old Shop", branch_name:"Mbare", branch_id:"B-MBARE001" });
  await t("A1 setup: an old device checks in (a vendor row), then its business is deleted on seiGEN", async ()=>{
    X.api.run(`INSERT INTO products(name,price,stock,sku,branch) VALUES('Kept item',5,3,'K-1',?)`, [X.api.currentBranch()]);
    const r = await X.api.deviceCheckin();
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(X.api.dcLastVendorId(), "the device keeps its vendor id");
    await q(`delete from cl_vendors where install_id = 'GONE01'`);
    assert.strictEqual((await q(`select count(*)::int n from cl_removed_devices where install_id = 'GONE01'`))[0].n, 1, "listed as removed");
  });

  await t("A1 its next check-in is refused, no vendor row is made, and the app shows the reset notice with \"Save a backup first\"", async ()=>{
    const r = await X.api.deviceCheckin();
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "removed");
    assert.strictEqual((await q(`select count(*)::int n from cl_vendors where install_id = 'GONE01'`))[0].n, 0);
    assert.strictEqual(X.api.dcDeviceRemoved(), true);
    const m = modal(X);
    assert.ok(m, "the notice opened");
    assert.match(flat(m.textContent), /This device belongs to a business that no longer exists on seiGEN\. Reset this device/);
    assert.ok(m.querySelector("#dcRmBackup"), "Save a backup first");
    assert.strictEqual(X.api.one("SELECT COUNT(*) AS n FROM products").n, 1, "nothing cleared on its own");
    m.querySelector("#dcRmBackup").onclick();
    assert.strictEqual(X.downloads.length, 1); assert.match(X.downloads[0], /^seigen-backup-before-reset-/);
    m.querySelector("#dcRmLater").onclick();
    assert.strictEqual(X.api.one("SELECT COUNT(*) AS n FROM products").n, 1, "Not now: still nothing cleared");
    assert.match(X.api.dcRemovedCardHtml(), /Reset this device/, "About keeps the notice");
  });

  await t("A1 Reset (after the confirmation) clears the device; it then starts setup as a new install", async ()=>{
    const m = X.api.openDcResetModal();
    await m.querySelector("#dcRmReset").onclick({ currentTarget: m.querySelector("#dcRmReset") });
    assert.strictEqual(X.api.one("SELECT COUNT(*) AS n FROM products").n, 0);
    assert.strictEqual(X.api.getSetting("install_id",""), "", "no install ID: setup makes a new one");
  });

  await t("A1 a registered till is unaffected: T1 checks in with its last vendor id as before", async ()=>{
    const r = await J1.api.deviceCheckin();
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(calls.filter((c)=> c.dev === "J1" && c.fn === "cl_device_checkin").some((c)=> /p_last_vendor_id/.test(c.body)));
    assert.strictEqual(J1.api.dcDeviceRemoved(), false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
