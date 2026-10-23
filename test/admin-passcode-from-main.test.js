// node test/admin-passcode-from-main.test.js
//
// v21: a joined device's Admin passcode comes from the main branch
// (docs/multi-terminal/admin-passcode-on-join-design.md; owner's answers
// 2026-10-13). Tills running the REAL app code (test/harness.js, with a
// JSDOM document for the screens) against the REAL server SQL in PGlite
// (the live shape + 20261023120000), never the live database:
//   - Add a terminal on the main till needs its Admin passcode and the new
//     device's passcode (6+), and sends only a check value;
//   - the joined device unlocks with that passcode, offline; a wrong one is
//     refused; it can't create its own first Admin; giving someone an Admin
//     passcode there needs the current one;
//   - an already-joined till with no Admin: the locked Settings screen says
//     where it comes from; "Set its Admin passcode" on the main reaches it at
//     its next check-in ("Check now"), and replaces a passcode someone set there;
//   - extra tills of the main branch follow the same rule; the main branch's
//     T1 keeps its own Admins;
//   - an older main build's code: "Update the main branch till first";
//     an app too old to send the check value: "This version of the app is too
//     old to add terminals" (20261023180000);
//   - a main till with no Admin passcode of its own is stopped before it asks
//     seiGEN: "Set an Admin passcode for this till first".
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}
async function waitFor(cond, what){
  const end = Date.now() + 20000;
  while(Date.now() < end){ const v = await cond(); if(v) return v; await new Promise((r)=> setTimeout(r, 20)); }
  throw new Error("timed out waiting for " + what);
}

(async ()=>{
  const MIG = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20261023120000_admin_passcode_from_main.sql"), "utf8");
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat(["20261023120000_admin_passcode_from_main.sql", "20261023180000_update_app_first_message.sql", "20261024120000_branch_stock.sql", "20261025120000_min_app_build.sql", "20261106120000_branch_views.sql", "20261107120000_shop_roles.sql", "20261108120000_shop_managers_everywhere.sql", "20261109120000_office_seats.sql", "20261110120000_staff_first_owner.sql", "20261112120000_builtin_customers.sql", "20261113120000_sales_sync.sql"]) });
  await pg.exec(MIG);
  await pg.exec(fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20261023180000_update_app_first_message.sql"), "utf8"));
  // one database call at a time: an app's background call (role anon) must not overlap the test's own reads
  let lock = Promise.resolve();
  const serial = (fn)=>{ const run = lock.then(fn, fn); lock = run.catch(()=>{}); return run; };
  const q = (sql, p)=> serial(async ()=> (await pg.query(sql, p)).rows);
  const rpc = (fn, body)=> serial(()=> rpcNow(fn, body));
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
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:"Seed Phrase", shop_name:"Seed Shop", install_date:"2026-09-01", branch_type:"main" }, settings), { dom:true });
    A.hook("backupMergeSectionHtml", ()=> "");            // Settings' backup card needs files this harness doesn't load
    A.hook("wireBackupMergeSection", ()=>{});
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      const r = await rpc(m[1], JSON.parse(opts.body));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    return A;
  }
  const doc = (A)=> A.dom.window.document;
  const $ = (A, id)=> doc(A).getElementById(id);
  const text = (el)=> (el && el.textContent || "").replace(/\s+/g, " ").trim();
  const fill = (A, values)=> Object.entries(values).forEach(([id, v])=>{ $(A, id).value = v; });
  const closeModals = (A)=> doc(A).querySelectorAll(".modalOverlay").forEach((m)=> m.remove());

  const M = till("Main", { install_id:"MAIN", branch_name:"Harare", branch_id:"B-HARARE01" });
  M.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','4321',?,1,?)", [M.api.currentBranch(), new Date().toISOString()]);
  let codeMbare = null, codeT2 = null;

  await t("the main branch registers (T1) and keeps its own Admin passcode", async ()=>{
    const r = await M.api.registerMainBranch(null);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(M.api.adminComesFromMain(), false, "the owner's T1");
    assert.strictEqual(M.api.findAdmin("4321").name, "Owner");
  });

  await t("Add a terminal: needs this till's Admin passcode and the new device's (6+), then gives a code", async ()=>{
    closeModals(M); M.api.openAddTerminalModal();
    const sel = $(M, "termAddBranch");
    sel.value = "__new"; sel.onchange();
    $(M, "termAddNewName").value = "Mbare";
    fill(M, { termAddMain:"0000", termAddNew:"mbare-77", termAddNew2:"mbare-77" });
    await $(M, "termAddIssue").onclick();
    assert.strictEqual(text($(M, "termAddStatus")), "Incorrect Admin passcode for this till.");
    fill(M, { termAddMain:"4321", termAddNew:"mb77", termAddNew2:"mb77" });
    await $(M, "termAddIssue").onclick();
    assert.strictEqual(text($(M, "termAddStatus")), "The Admin passcode must be at least 6 characters.");
    fill(M, { termAddMain:"4321", termAddNew:"mbare-77", termAddNew2:"mbare-78" });
    await $(M, "termAddIssue").onclick();
    assert.strictEqual(text($(M, "termAddStatus")), "The two passcodes don't match.");
    assert.strictEqual((await q("select count(*)::int c from cl_branch_join_codes"))[0].c, 0, "no code yet");
    fill(M, { termAddMain:"4321", termAddNew:"mbare-77", termAddNew2:"mbare-77" });
    await $(M, "termAddIssue").onclick();
    codeMbare = text(await waitFor(()=> $(M, "termAddCode"), "the code"));
    assert.match(codeMbare, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.strictEqual($(M, "termAddNew").value, "", "the passcode fields are cleared");
    const row = (await q("select admin_salt, admin_check, admin_rounds from cl_branch_join_codes"))[0];
    assert.strictEqual(row.admin_rounds, 150000);
    assert.strictEqual(crypto.pbkdf2Sync("mbare-77", Buffer.from(row.admin_salt, "hex"), 150000, 32, "sha256").toString("hex"), row.admin_check, "only the PBKDF2 check value reached seiGEN");
    closeModals(M);
  });

  const J = till("Mbare", { install_id:"MB01", branch_name:"Mbare", branch_id:"B-MBARE001", branch_type:"remote" });
  await t("the new device joins: its Admin passcode is the one main chose; a wrong one is refused", async ()=>{
    const r = await J.api.joinBusiness({ phrase:"Seed Phrase", code:codeMbare, label:null });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(J.api.storeAdminSeed(r.data.admin_seed, "join"));
    assert.strictEqual(J.api.adminComesFromMain(), true);
    assert.strictEqual(J.api.hasAdminPasscode(), true);
    assert.strictEqual(J.api.findAdmin("mbare-77").name, "Admin (set by main)");
    assert.strictEqual(J.api.findAdmin("mbare-78"), null);
    assert.strictEqual(J.api.one("SELECT passcode FROM staff WHERE name='Admin (set by main)'").passcode, "", "no passcode stored on the device either");
  });

  await t("... it unlocks offline (the check is on the device)", async ()=>{
    J.ctx.navigator.onLine = false;
    try{
      J.api.setRoute("more");
      const main = doc(J).getElementById("app");
      J.api.renderSettings(main);
      $(J, "settingsPasscode").value = "mbare-77";
      await $(J, "unlockSettings").onclick();   // v30: async
      assert.strictEqual(J.api.getSettingsUnlocked(), true);
    } finally { J.ctx.navigator.onLine = true; }
  });

  await t("... it can't create its own first Admin; giving someone an Admin passcode there needs the current one", async ()=>{
    assert.throws(()=> J.api.createDeviceAdmin("abcd", "abcd"), /set by your main branch/);
    assert.throws(()=> J.api.saveStaffMember({ name:"Cashier Admin", role:"Admin", passcode:"9999", pin:"4821" }), /Enter the current Admin passcode/);
    const s = J.api.saveStaffMember({ name:"Branch Manager", role:"Admin", passcode:"9999", pin:"4821", adminPasscode:"mbare-77" });
    assert.strictEqual(s.role, "Admin");
    assert.strictEqual(J.api.findAdmin("9999").name, "Branch Manager");
    const c = J.api.saveStaffMember({ name:"Cashier", role:"Cashier", passcode:"", pin:"4822" });
    assert.strictEqual(c.role, "Cashier", "cashiers need nothing extra");
  });

  // an already-joined till with no Admin passcode (as a v20 join left it), where someone set their own
  const K = till("Mbare2", { install_id:"MB02", branch_name:"Mbare", branch_id:"B-MBARE001", branch_type:"remote" });
  await t("an already-joined till with no Admin: the locked Settings screen says it comes from main (no Create)", async ()=>{
    closeModals(M); M.api.openAddTerminalModal();
    const sel = $(M, "termAddBranch"); sel.value = "Mbare";
    if(sel.value !== "Mbare"){ sel.value = "__new"; sel.onchange(); $(M, "termAddNewName").value = "Mbare"; }
    fill(M, { termAddMain:"4321", termAddNew:"other-pass", termAddNew2:"other-pass" });
    await $(M, "termAddIssue").onclick();
    const code = text(await waitFor(()=> $(M, "termAddCode"), "the code"));
    closeModals(M);
    const r = await K.api.joinBusiness({ phrase:"Seed Phrase", code, label:null });
    assert.ok(r.ok, JSON.stringify(r));                       // (as a v20 join: the check value isn't stored)
    assert.strictEqual(K.api.hasAdminPasscode(), false);
    K.api.renderSettings(doc(K).getElementById("app"));
    assert.strictEqual(text($(K, "adminFromMainNote")), K.api.ADMIN_FROM_MAIN_TEXT);
    assert.strictEqual($(K, "createAdmin"), null, "no Create Admin passcode");
    // the gap as v20 left it: someone set their own Admin passcode there
    K.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Whoever','Admin','1111',?,1,?)", [K.api.currentBranch(), new Date().toISOString()]);
  });

  await t("main: 'Set its Admin passcode' on that till's row; it arrives at the till's next check-in and replaces the one someone set", async ()=>{
    const tid = K.api.getSetting("terminal_id", "");
    closeModals(M); M.api.openSetTerminalAdminModal(tid, { till:"T2", branch:"Mbare" });
    fill(M, { termSetMain:"4321", termSetNew:"mbare2-set", termSetNew2:"mbare2-set" });
    await $(M, "termSetGo").onclick();
    assert.match(text(await waitFor(()=> $(M, "termSetDone"), "done")), /^Set for T2 \(Mbare\)\. It takes effect there at its next check-in/);
    closeModals(M);
    assert.strictEqual(K.api.findAdmin("1111").name, "Whoever", "before the check-in");
    await K.api.deviceCheckin();
    assert.strictEqual(K.api.findAdmin("mbare2-set").name, "Admin (set by main)");
    assert.strictEqual(K.api.findAdmin("1111"), null, "the passcode someone set there no longer works");
    assert.strictEqual(K.api.one("SELECT active FROM staff WHERE name='Whoever'").active, 1, "the person stays (sign-in PIN)");
    assert.match(K.api.one("SELECT details FROM audit_log WHERE action='Admin passcode set by main'").details, /From the main branch; 1 other Admin passcode on this device cleared/);
    await K.api.deviceCheckin();
    assert.strictEqual((await q("select count(*)::int c from cl_terminal_admin_seeds where delivered_ts is null"))[0].c, 0, "delivered once");
  });

  await t("'Check now' on the locked screen picks it up", async ()=>{
    const L = till("Mbare3", { install_id:"MB03", branch_name:"Mbare", branch_id:"B-MBARE001", branch_type:"remote" });
    closeModals(M); M.api.openAddTerminalModal();
    const sel = $(M, "termAddBranch"); sel.value = "Mbare";
    if(sel.value !== "Mbare"){ sel.value = "__new"; sel.onchange(); $(M, "termAddNewName").value = "Mbare"; }
    fill(M, { termAddMain:"4321", termAddNew:"first-pass", termAddNew2:"first-pass" });
    await $(M, "termAddIssue").onclick();
    const code = text(await waitFor(()=> $(M, "termAddCode"), "the code"));
    closeModals(M);
    assert.ok((await L.api.joinBusiness({ phrase:"Seed Phrase", code, label:null })).ok);
    L.api.renderSettings(doc(L).getElementById("app"));
    await $(L, "adminFromMainCheck").onclick();
    assert.match(text($(L, "adminFromMainStatus")), /^Nothing yet\. Set it on a main-branch till first/);
    await M.api.setTerminalAdmin(L.api.getSetting("terminal_id", ""), M.api.adminCheckMake("later-pass"));
    await $(L, "adminFromMainCheck").onclick();
    assert.strictEqual(L.api.findAdmin("later-pass").name, "Admin (set by main)");
  });

  await t("an extra till of the main branch: the same rule (its Admin passcode comes from main; no own Admin without it)", async ()=>{
    closeModals(M); M.api.openAddTerminalModal();
    fill(M, { termAddMain:"4321", termAddNew:"harare-t2", termAddNew2:"harare-t2" });
    await $(M, "termAddIssue").onclick();
    codeT2 = text(await waitFor(()=> $(M, "termAddCode"), "the code"));
    closeModals(M);
    const T2 = till("Harare T2", { install_id:"HR02", branch_name:"Harare", branch_id:"B-HARARE01" });
    const r = await T2.api.joinBusiness({ phrase:"Seed Phrase", code:codeT2, label:null });
    assert.ok(r.ok && r.data.till_code === "T2", JSON.stringify(r));
    T2.api.storeAdminSeed(r.data.admin_seed, "join");
    assert.strictEqual(T2.api.adminComesFromMain(), true, "T2 of the main branch");
    assert.strictEqual(T2.api.findAdmin("harare-t2").name, "Admin (set by main)");
    assert.throws(()=> T2.api.saveStaffMember({ name:"Self Made", role:"Admin", passcode:"2222", pin:"4823" }), /Enter the current Admin passcode/);
  });

  await t("a main till with no Admin passcode of its own: 'Set an Admin passcode for this till first', and seiGEN isn't asked", async ()=>{
    const N = till("No Admin", { install_id:"NOADM", branch_name:"Borrowdale", branch_id:"B-BORROW01", shop_name:"Plain Shop", secret_phrase:"Plain Phrase" });
    assert.ok((await N.api.registerMainBranch(null)).ok);
    assert.strictEqual(N.api.hasAdminPasscode(), false);
    let asked = 0; const real = N.ctx.fetch;
    N.hook("fetch", async (url, opts)=>{ if(/cl_branch_issue_join_code/.test(String(url))) asked++; return real(url, opts); });
    const codesBefore = (await q("select count(*)::int c from cl_branch_join_codes"))[0].c;
    closeModals(N); N.api.openAddTerminalModal();
    fill(N, { termAddMain:"", termAddNew:"new-till-1", termAddNew2:"new-till-1" });
    await $(N, "termAddIssue").onclick();
    assert.strictEqual(text($(N, "termAddStatus")), "Set an Admin passcode for this till first: Settings → Admin passcode (this till).");
    assert.strictEqual($(N, "termAddIssue").disabled, false, "the button works again");
    assert.strictEqual($(N, "termAddCode"), null, "no code");
    assert.strictEqual(asked, 0, "seiGEN wasn't asked");
    assert.strictEqual((await q("select count(*)::int c from cl_branch_join_codes"))[0].c, codesBefore);
    closeModals(N);
  });

  await t("an app too old to send the check value: 'This version of the app is too old to add terminals'", async ()=>{
    const r = await M.api.issueJoinCode({ newBranchName:"Avondale" });
    assert.strictEqual(r.ok, false);
    assert.match(String(r.message||""), /^UPDATE_MAIN_FIRST: This version of the app is too old to add terminals. Update this app, then try again./, "the server's own words (for apps that show them)");
    assert.strictEqual(M.api.terminalProblemText(r), "This version of the app is too old to add terminals. Update this app, then try again.");
    // a code made before the migration (no check value) is refused at the joining device
    const br = (await q("select id from cl_branches where name = 'Harare'"))[0].id, mt = M.api.getSetting("terminal_id", "");
    await q(`insert into cl_branch_join_codes (branch_id, code_hash, issued_by_terminal, expires_ts) values ($1, encode(extensions.digest('OLDCODE1', 'sha256'), 'hex'), $2, now() + interval '1 day')`, [br, mt]);
    const O = till("Old", { install_id:"OLD1", branch_name:"Harare", branch_id:"B-HARARE01" });
    const j = await O.api.joinBusiness({ phrase:"Seed Phrase", code:"OLDC-ODE1", label:null });
    assert.strictEqual(j.ok, false);
    assert.match(O.api.terminalProblemText(j), /^Update the main branch till first\. This join code came from an older version of the app on the main branch/);
  });

  await t("the main branch's T1 still makes its own Admins, and its old plain passcode still works", async ()=>{
    const s = M.api.saveStaffMember({ name:"Second Owner", role:"Admin", passcode:"5555", pin:"4824" });
    assert.strictEqual(s.role, "Admin");
    assert.strictEqual(M.api.findAdmin("4321").name, "Owner");
  });

  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
