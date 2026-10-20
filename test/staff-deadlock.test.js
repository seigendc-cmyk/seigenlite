// node test/staff-deadlock.test.js
//
// The v28 staff deadlock (owner, 2026-10-16) and its v29 fix. As on live: the main
// till's old Admin is moved to seiGEN at the first check-in (so nobody can use the
// first-manager rule any more); the remote's old list is empty. Tills run the REAL
// app code (test/harness.js, JSDOM for the screens) against the REAL server SQL in
// PGlite, never the live database:
//   - main T1, single operator mode ON: "Sign in to manage staff" with the old PIN
//     -> a seiGEN PIN must be set right away -> add a Cashier with a PIN -> edit
//     -> a new role; single operator mode stays on;
//   - the remote: the guidance (card and the single-mode alert) -> Refresh -> the
//     Cashier and the roles arrive -> single mode off -> the PIN screen shows
//     them -> sign in -> the menus are a Cashier's;
//   - main T2: the moved Admin signs in with the new PIN (the old one is T1's only);
//   - "Sign in to manage staff" ends after 5 minutes idle, on Done and on Log out.
"use strict";
const assert = require("assert");
const vm = require("vm");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); }
}
const flat = (s)=> String(s).replace(/\s+/g, " ");
const tick = ()=> new Promise((r)=> setTimeout(r, 20));
async function until(cond, what){ for(let i = 0; i < 250; i++){ if(await cond()) return; await tick(); } throw new Error("timed out: " + what); }

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat(["20261108120000_shop_managers_everywhere.sql"]) });   // the shape before it: the test applies it part-way (it is on live now)
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
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:"Zuva Phrase", install_date:"2026-09-01" }, settings), { dom:true });
    A.name = name; A.alerts = [];
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      const r = await serial(()=> rpcNow(m[1], JSON.parse(opts.body)));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.hook("alert", (m)=>{ A.alerts.push(String(m)); });
    A.hook("confirm", ()=> true);
    vm.runInContext(`var $app = document.getElementById("app");`, A.ctx);
    return A;
  }
  const J1 = till("J1", { install_id:"ZU01", shop_name:"Zuva Hardware", branch_name:"Mbare", branch_id:"B-MBARE001", branch_type:"main" });
  const J2 = till("J2", { install_id:"ZU02", shop_name:"Zuva Hardware", branch_name:"Mbare", branch_id:"B-MBARE002", branch_type:"main" });
  const R1 = till("R1", { install_id:"ZU03", shop_name:"Zuva Hardware", branch_name:"Chitungwiza", branch_id:"B-CHITUNG1", branch_type:"remote" });
  const doc = (A)=> A.dom.window.document;
  const modal = (A)=> doc(A).querySelector(".modalOverlay:last-of-type");
  // Settings → Staff & Roles, as settings.js draws it (redraw = the card again)
  function staffCard(A){
    const host = doc(A).createElement("div"); doc(A).body.appendChild(host);
    const draw = ()=>{ host.innerHTML = A.api.shopStaffSectionHtml(); A.api.wireShopStaffSection(host.querySelector("#shopStaffCard"), draw); };
    draw();
    return { $: (sel)=> host.querySelector(sel), text: ()=> flat(host.textContent), draw, remove: ()=> host.remove() };
  }
  const server = (sql, p)=> q(sql, p);

  await t("setup (as on live): main T1's old Admin moves to seiGEN at the first check-in; T2 and the remote have no old staff", async ()=>{
    J1.api.saveStaffMember({ name:"Grace", role:"Admin", pin:"2580", passcode:"zuva-admin" });
    assert.ok((await J1.api.registerMainBranch("Counter")).ok);
    let r = await J1.api.issueJoinCode({ branchId:J1.api.getSetting("branch_uuid",""), seed:J1.api.adminCheckMake("Zuva-Admin-1") });
    assert.ok((await J2.api.joinBusiness({ phrase:"Zuva Phrase", code:r.data.code, label:"Back" })).ok);
    r = await J1.api.issueJoinCode({ newBranchName:"Chitungwiza", seed:J1.api.adminCheckMake("Zuva-Admin-1") });
    assert.ok((await R1.api.joinBusiness({ phrase:"Zuva Phrase", code:r.data.code, label:"Till 1", expectedBranchName:"Chitungwiza" })).ok);
    await q(`update cl_shop_meta set v = now() + interval '1 day' where k = 'legacy_cutoff'`);   // the tills are older than the migration, as on live
    for(const A of [J1, J2, R1]) assert.ok((await A.api.staffPull()).ok, A.name);
    const staff = await server(`select s.name, r.name role, jsonb_array_length(s.legacy_pins) old_pins, s.pin_check is null no_new_pin from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id`);
    assert.deepStrictEqual(staff.map((x)=> [x.name, x.role, x.old_pins, x.no_new_pin]), [["Grace", "Admin", 1, true]]);
    assert.strictEqual(J1.api.getSetting("shop_bootstrap",""), "", "the first-manager rule is closed (Grace holds Staff)");
    for(const A of [J1, J2, R1]) assert.strictEqual(A.api.singleOperatorMode(), true, A.name + " single operator mode is on");
  });

  await t("v28's deadlock is gone: main T1 (single mode on) offers \"Sign in to manage staff\"; the remote and T2 say where to do it", async ()=>{
    const c1 = staffCard(J1);
    assert.ok(c1.$("#staffMgrSignin"), "main T1: the button");
    assert.ok(!c1.$("#addShopStaff") && !c1.$("[data-edit-shopstaff]"), "nothing to change before signing in");
    c1.remove();
    for(const [A, where] of [[R1, /on the main branch/], [J2, /on the till where they have their PIN/]]){
      const c = staffCard(A);
      assert.ok(!c.$("#staffMgrSignin"), A.name + ": nobody here can manage staff");
      assert.match(c.$("#staffGuidance").textContent, where, A.name);
      c.remove();
    }
  });

  await t("main T1: sign in with the old PIN -> must set a seiGEN PIN right away; single operator mode stays on", async ()=>{
    const c = staffCard(J1);
    c.$("#staffMgrSignin").click();
    const m = modal(J1);
    assert.match(m.querySelector("h3").textContent, /Sign in to manage staff/);
    assert.deepStrictEqual([...m.querySelectorAll("#smWho option")].map((o)=> o.textContent), ["Grace"]);
    m.querySelector("#smPin").value = "1111"; await m.querySelector("#smGo").onclick();   // v30: the PIN is checked off the UI thread
    assert.match(m.querySelector("#smMsg").textContent, /Incorrect PIN/);
    m.querySelector("#smPin").value = "2580"; await m.querySelector("#smGo").onclick();
    const pinModal = modal(J1);
    assert.match(pinModal.querySelector("h3").textContent, /Set your seiGEN PIN/);
    assert.ok(!pinModal.querySelector("[data-modal-close]"), "no ✕: it can't be skipped while online");
    assert.strictEqual(pinModal.querySelector("#opLater").style.display, "none");
    pinModal.click();   // a tap beside it doesn't close it
    assert.ok(pinModal.isConnected);
    pinModal.querySelector("#opPin").value = "4826"; pinModal.querySelector("#opPin2").value = "4827"; pinModal.querySelector("#opSave").click();
    assert.match(pinModal.querySelector("#opMsg").textContent, /aren't the same/);
    pinModal.querySelector("#opPin2").value = "4826"; pinModal.querySelector("#opSave").click();
    await until(()=> !pinModal.isConnected, "the PIN is set");
    const g = (await server(`select jsonb_array_length(legacy_pins) old_pins, pin_check is not null new_pin, pin_bcrypt is not null bcrypt from cl_shop_staff where name = 'Grace'`))[0];
    assert.deepStrictEqual(g, { old_pins:0, new_pin:true, bcrypt:true }, "seiGEN has her new PIN; the old one is gone");
    assert.strictEqual(J1.api.staffSession().legacy, false);
    assert.strictEqual(J1.api.singleOperatorMode(), true, "single operator mode is still on");
    c.draw();
    assert.ok(c.$("#addShopStaff") && c.$("[data-edit-shopstaff]") && c.$("#staffMgrDone"), "Add, Edit and Done now show");
    assert.match(c.text(), /Signed in: Grace/);
    c.remove();
  });

  const MBARE = ()=> J1.api.getSetting("branch_uuid",""), CHIT = ()=> R1.api.getSetting("branch_uuid","");
  await t("main T1 (still single mode): add a Cashier with a PIN for the remote -> edit them -> a new role", async ()=>{
    const c = staffCard(J1);
    c.$("#addShopStaff").click();
    let m = modal(J1);
    assert.ok(!m.querySelector("#ssAdminPass"), "no Admin passcode: Grace is signed in");
    m.querySelector("#ssName").value = "Rumbi";
    m.querySelector("#ssRole").value = J1.api.shopRoles().find((r)=> r.builtin === "cashier").id;
    m.querySelector("#ssHome").value = CHIT();
    m.querySelector("#ssPin").value = "7531";
    m.querySelector("#ssSave").click();
    await until(()=> !m.isConnected, "Rumbi saved");
    c.draw();
    const rumbi = J1.api.shopStaffAll().find((s)=> s.name === "Rumbi");
    assert.ok(rumbi && rumbi.home_branch === CHIT(), "Rumbi works at Chitungwiza");
    c.$(`[data-edit-shopstaff="${rumbi.id}"]`).click();
    m = modal(J1);
    assert.strictEqual(m.querySelector("#ssName").value, "Rumbi");
    m.querySelector("#ssName").value = "Rumbidzai";
    m.querySelector("#ssSave").click();
    await until(()=> !m.isConnected, "Rumbi edited");
    c.draw();
    assert.match(c.text(), /Rumbidzai Cashier · Chitungwiza/);
    c.$("#staffTabRoles").click();
    c.$("#addRole").click();
    m = modal(J1);
    m.querySelector("#rlName").value = "Till Lead";
    for(const r of ["m.sell", "m.credit", "void_return"]) m.querySelector(`[data-right="${r}"]`).checked = true;
    m.querySelector("#rlSave").click();
    await until(()=> !m.isConnected, "the role saved");
    const roles = await server(`select r.name, r.rights from cl_shop_roles r where r.builtin is null`);
    assert.deepStrictEqual(roles.map((x)=> [x.name, x.rights.slice().sort()]), [["Till Lead", ["m.credit", "m.sell", "void_return"]]]);
    const people = await server(`select s.name, r.name role from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id order by s.name`);
    assert.deepStrictEqual(people.map((x)=> x.name + " " + x.role), ["Grace Admin", "Rumbidzai Cashier"], "Grace unchanged (Admin)");
    assert.strictEqual(J1.api.singleOperatorMode(), true);
    c.remove();
  });

  await t("the remote: the single-mode alert says where to add people; Refresh -> Rumbidzai and the roles arrive -> single mode off", async ()=>{
    let c = staffCard(R1);
    c.$("#sSingleOperator").checked = false; c.$("#sSingleOperator").onchange();
    assert.strictEqual(R1.alerts.length, 1);
    assert.match(R1.alerts[0], /^Add at least one active person with a PIN at this branch before turning this off\./);
    assert.match(R1.alerts[0], /Add or edit people for Chitungwiza on the main branch \(Settings → Staff & Roles\)\. They arrive here at the next check-in, or tap Refresh\./);
    assert.strictEqual(R1.api.singleOperatorMode(), true, "still on");
    c.remove();
    c = staffCard(R1);
    c.$("#staffRefresh").click();
    await until(()=> R1.api.shopStaffHere().length === 1, "the pull");
    c.remove(); c = staffCard(R1);
    assert.match(c.text(), /Rumbidzai Cashier · Chitungwiza/);
    assert.match(c.text(), /Roles \(6\)/, "5 built-in + Till Lead");
    c.$("#sSingleOperator").checked = false; c.$("#sSingleOperator").onchange();
    assert.strictEqual(R1.alerts.length, 1, "no alert this time");
    assert.strictEqual(R1.api.singleOperatorMode(), false, "single operator mode is off");
    c.remove();
  });

  await t("the remote's PIN screen shows Rumbidzai; she signs in and the menus are a Cashier's", async ()=>{
    vm.runInContext(`sessionUser = ""; renderWhoAmI();`, R1.ctx);
    const sel = doc(R1).getElementById("whoSelect");
    assert.ok(sel, "the PIN screen (not the free-text name)");
    assert.deepStrictEqual([...sel.querySelectorAll("option")].map((o)=> o.textContent), ["Rumbidzai"]);
    doc(R1).getElementById("whoSelectContinue").onclick();
    const pin = doc(R1).getElementById("whoPin");
    pin.value = "7531"; pin.oninput();
    await doc(R1).getElementById("whoPinContinue").onclick();   // v30: async
    assert.strictEqual(R1.api.getSessionUser(), "Rumbidzai");
    assert.strictEqual(vm.runInContext("route", R1.ctx), "pos");
    assert.ok(!modal(R1), "a seiGEN PIN: no PIN to set");
    const nav = ["pos", "products", "credit", "reports", "marketing"].map((m)=> R1.api.navAllowed(m)? 1 : 0);
    assert.deepStrictEqual(nav, [1, 0, 1, 1, 0], "Sell, Credit, Reports");
    assert.ok(!R1.api.moreTabAllowed("settings") && !R1.api.moreTabAllowed("reportwriter") && R1.api.moreTabAllowed("directory"));
    assert.ok(!R1.api.can("costs") && !R1.api.can("m.staff"));
    R1.api.staffSignOut();
  });

  await t("main T2: Grace signs in with her new seiGEN PIN (her old one was T1's only)", async ()=>{
    assert.ok((await J2.api.staffPull()).ok);
    const g = J2.api.staffManagersHere().find((s)=> s.name === "Grace");
    assert.ok(g, "Grace can now manage staff on T2 too");
    assert.strictEqual(J2.api.attemptShopSignin(g.id, "2580").ok, false, "the old PIN doesn't work on T2");
    const r = J2.api.attemptShopSignin(g.id, "4826");
    assert.ok(r.ok && !r.legacy, JSON.stringify(r));
    J2.api.staffSignOut();
    J2.ctx.navigator.onLine = false;
    assert.ok(J2.api.attemptShopSignin(g.id, "4826").ok, "offline too");
    J2.api.staffSignOut(); J2.ctx.navigator.onLine = true;
  });

  await t("\"Sign in to manage staff\" ends after 5 minutes idle, on Done and on Log out", async ()=>{
    const g = J1.api.staffManagersHere().find((s)=> s.name === "Grace");
    // idle
    assert.ok(J1.api.staffManageSignin(g.id, "4826").ok);
    assert.strictEqual(J1.api.staffManaging(), true);
    const t0 = J1.api.staffSession().lastActive;
    assert.strictEqual(J1.api.staffIdleCheck(t0 + 4*60000), false, "4 minutes: still signed in");
    doc(J1).dispatchEvent(new J1.dom.window.Event("keydown"));   // a key counts as use
    assert.ok(J1.api.staffSession().lastActive >= t0);
    const t1 = J1.api.staffSession().lastActive;
    assert.strictEqual(J1.api.staffIdleCheck(t1 + J1.api.STAFF_MANAGE_IDLE_MS), true, "5 minutes without use: signed out");
    assert.strictEqual(J1.api.staffSession(), null);
    let c = staffCard(J1);
    assert.ok(c.$("#staffMgrSignin") && !c.$("#addShopStaff"), "back to the button");
    c.remove();
    // Done
    assert.ok(J1.api.staffManageSignin(g.id, "4826").ok);
    c = staffCard(J1);
    c.$("#staffMgrDone").click();
    assert.strictEqual(J1.api.staffSession(), null);
    assert.ok(c.$("#staffMgrSignin"), "Done: back to the button");
    c.remove();
    // Log out
    assert.ok(J1.api.staffManageSignin(g.id, "4826").ok);
    vm.runInContext(`sessionUser = "Shop"; logoutSession();`, J1.ctx);
    assert.strictEqual(J1.api.staffSession(), null, "Log out ends it");
    const audit = J1.api.all("SELECT details FROM audit_log WHERE action='Staff management ended' ORDER BY id").map((x)=> x.details);
    assert.strictEqual(JSON.stringify(audit), JSON.stringify(["Grace (5 minutes idle)", "Grace"]));   // (the app's arrays are from another realm)
  });

  await t("an old PIN while offline: \"Later\" keeps it on this till only; it asks again at the next sign-in", async ()=>{
    // as if Grace had also been on T2's old list with PIN 9753 (a till's salted SHA-256 of "salt:PIN")
    const salt = "a1b2c3d4", hash = require("crypto").createHash("sha256").update(salt + ":9753").digest("hex");
    await q(`update cl_shop_staff set legacy_pins = legacy_pins || jsonb_build_array(jsonb_build_object('terminal_id', (select id from cl_terminals where install_id='ZU02')::text, 'salt', $1::text, 'hash', $2::text)) where name = 'Grace'`, [salt, hash]);
    assert.ok((await J2.api.staffPull()).ok);
    const g = J2.api.staffManagersHere().find((s)=> s.name === "Grace");
    J2.ctx.navigator.onLine = false;
    const r = J2.api.staffManageSignin(g.id, "9753");
    assert.ok(r.ok && r.legacy, "T2's old PIN, offline");
    const m = J2.api.openSetOwnPinModal(()=>{});
    assert.match(m.querySelector("#opMsg").textContent, /offline/);
    assert.strictEqual(m.querySelector("#opLater").style.display, "", "Later shows while offline");
    m.querySelector("#opLater").click();
    assert.ok(!m.isConnected);
    J2.api.staffSignOut();
    const again = J2.api.staffManageSignin(g.id, "9753");
    assert.ok(again.ok && again.legacy, "still the old PIN: the next sign-in asks again");
    J2.api.staffSignOut(); J2.ctx.navigator.onLine = true;
  });

  await t("v31 + seiGEN 20261108120000: Grace (Admin, home Mbare) signs in at the remote with her seiGEN PIN and adds its people there", async ()=>{
    assert.ok((await R1.api.staffPull()).ok);
    assert.ok(!R1.api.staffManagersHere().some((s)=> s.name === "Grace"), "before the update: Mbare's Admin isn't allowed at Chitungwiza");
    assert.strictEqual(R1.api.staffEverywhereRule(), false);
    assert.match(R1.api.staffManageGuidance(), /^Nobody who manages staff can sign in on this till\. Add or edit people for Chitungwiza on the main branch/);
    const path = require("path"), { READ } = require("../supabase/tests/rebuild-helpers");
    await serial(()=> pg.exec(READ(path.join(__dirname, "..", "supabase", "migrations", "20261108120000_shop_managers_everywhere.sql"))));
    assert.ok((await R1.api.staffPull()).ok);
    assert.strictEqual(R1.api.staffEverywhereRule(), true);
    assert.match(R1.api.staffManageGuidance(), /^Nobody who manages staff can sign in on this till yet\. An Owner, an Admin or anyone with the Staff right can sign in here once they have a seiGEN PIN/);
    const g = R1.api.staffManagersHere().find((s)=> s.name === "Grace");
    assert.ok(g, "Grace may sign in at Chitungwiza now");
    let c = staffCard(R1);
    assert.ok(!c.$("#staffGuidance"), "no 'nobody can manage staff here' any more");   // (single mode is off here: managers sign in at the PIN screen)
    assert.ok(R1.api.signinChoices().some((x)=> x.name === "Grace"), "Grace is on the remote's PIN screen");
    c.remove();
    R1.ctx.navigator.onLine = false;
    assert.ok(R1.api.staffManageSignin(g.id, "4826").ok, "offline too (seiGEN's check value reached this till)");
    R1.api.staffSignOut(); R1.ctx.navigator.onLine = true;
    const r = R1.api.staffManageSignin(g.id, "4826");
    assert.ok(r.ok && !r.legacy);
    assert.ok(await R1.api.staffEnsureToken(), "seiGEN gives a token at the remote");
    const role = R1.api.shopRoles().find((x)=> x.builtin === "cashier").id;
    const s = await R1.api.saveShopStaff({ name:"Tafara", role_id:role, home_branch_id:R1.api.getSetting("branch_uuid",""), other_branches:[], pin:"2580" });
    assert.ok(s && s.id, "added at the remote itself");
    R1.api.staffSignOut();
    assert.ok(R1.api.shopStaffHere().some((x)=> x.name === "Tafara"));
    assert.ok((await J1.api.staffPull()).ok);
    assert.ok(!J1.api.shopStaffHere().some((x)=> x.name === "Tafara"), "a Cashier stays at their branch: not on Mbare's tills");
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
