// node test/admin-passcode-setting.test.js
//
// v33 (owner, 2026-10-21: "approved option 1" and the "Admin passcode" setting
// on MAIN tills). Tills run the REAL app code (test/harness.js, JSDOM for the
// cards) against the REAL server SQL in PGlite (the live shape), never the live
// database:
//   (a) a main till with roles and no Admin passcode creates one in Settings
//       (the business has nobody yet), then adds the first Owner with it;
//       changing it then needs the current passcode or a signed-in Owner/Admin;
//   (b) a main till waiting for its roles keeps its old list under "Roles not
//       loaded": Edit and its Admin passcode field work, no "+ Add Staff";
//   (c) a till not on seiGEN: the old list as before (Add included);
//   a wrong current passcode changes nothing; create needs 0 staff or a
//   signed-in Owner/Admin; the passcode is never shown or logged; remotes and
//   joined tills are unchanged.
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
async function until(cond, what){ for(let i = 0; i < 400; i++){ if(await cond()) return; await tick(); } throw new Error("timed out: " + what); }

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES });   // the live shape
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
    const A = makeApp(Object.assign({ setup_complete:"1", install_date:"2026-09-01" }, settings), { dom:true });
    A.name = name; A.down = new Set();
    A.hook("fetch", async (url, o)=>{
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      if(A.down.has(m[1])) throw new TypeError("Failed to fetch");
      const r = await serial(()=> rpcNow(m[1], JSON.parse(o.body)));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.hook("alert", ()=>{});
    A.hook("confirm", ()=> true);
    A.hook("render", ()=>{});
    vm.runInContext(`var $app = document.getElementById("app");`, A.ctx);
    return A;
  }
  const doc = (A)=> A.dom.window.document;
  const modal = (A)=> doc(A).querySelector(".modalOverlay:last-of-type");
  function card(A, html, wire){
    const host = doc(A).createElement("div"); doc(A).body.appendChild(host);
    host.innerHTML = html(); wire(host);
    return { $: (sel)=> host.querySelector(sel), text: ()=> flat(host.textContent), remove: ()=> host.remove() };
  }
  const staffCard = (A)=> card(A, A.api.settingsStaffCardHtml, (h)=> A.api.wireSettingsStaffCard(h));
  const passCard = (A)=> card(A, A.api.adminPasscodeCardHtml, (h)=> A.api.wireAdminPasscodeCard(h));
  async function register(A){
    const host = doc(A).createElement("div"); doc(A).body.appendChild(host);
    host.innerHTML = A.api.terminalSectionHtml(); A.api.wireTerminalSection();
    await host.querySelector("#termRegisterBtn").onclick(); host.remove();
    assert.ok(A.api.isTerminalRegistered(), A.name + " registered");
  }
  const audit = (A)=> JSON.parse(JSON.stringify(A.api.all("SELECT action, details FROM audit_log WHERE action LIKE 'Admin passcode%' ORDER BY id")));   // out of the app's realm
  const SECRETS = ["lc-admin-1", "lc-admin-2", "lc-wrong-9", "wt-admin-1", "wt-admin-2", "fr-admin-1", "fr-admin-2", "fr-wrong-9"];
  const noSecret = (A)=>{ const s = JSON.stringify(A.api.all("SELECT * FROM audit_log")); for(const p of SECRETS) assert.ok(!s.includes(p), "the passcode is never logged"); };

  // (c) not on seiGEN
  const LC = till("LC", { install_id:"LC01", secret_phrase:"Local Phrase", shop_name:"Local Shop", branch_name:"Gweru", branch_id:"B-GWERU001", branch_type:"main" });
  await t("(c) not registered: the old list as before (Add staff and Edit); the Admin passcode card is there too", async ()=>{
    assert.strictEqual(LC.api.settingsStaffMode(), "local");
    const c = staffCard(LC);
    assert.ok(c.$("#openAddStaff"), "+ Add Staff as before");
    c.remove();
    assert.strictEqual(LC.api.adminPasscodeSettingShown(), true);
    const p = passCard(LC);
    assert.ok(p.$("#apNone") && !p.$("#apCurrent"), "no passcode yet: Create");
    assert.strictEqual(p.$("#apSave").textContent, "Create Admin passcode");
    p.remove();
  });

  await t("(c) Create while the business has nobody: allowed, logged without the passcode; it then approves", async ()=>{
    const p = passCard(LC);
    p.$("#apNew").value = "lc-admin-1"; p.$("#apNew2").value = "lc-admin-1";
    await p.$("#apSave").onclick();
    assert.match(p.$("#apMsg").textContent, /Admin passcode created/);
    assert.ok(p.$("#apCurrent"), "now it offers Change");
    assert.ok(!/lc-admin-1/.test(p.$("#adminPassCard").outerHTML.replace(/value="[^"]*"/g, "")), "never shown");
    p.remove();
    assert.ok(LC.api.findAdmin("lc-admin-1"), "it works");
    assert.deepStrictEqual(audit(LC).map((r)=> r.action), ["Admin passcode created"]);
    assert.match(audit(LC)[0].details, /while the business had no staff/);
    noSecret(LC);
  });

  await t("change with a WRONG current passcode is refused and changes nothing", async ()=>{
    const p = passCard(LC);
    p.$("#apCurrent").value = "lc-wrong-9"; p.$("#apNew").value = "lc-admin-2"; p.$("#apNew2").value = "lc-admin-2";
    await p.$("#apSave").onclick();
    assert.match(p.$("#apMsg").textContent, /Incorrect current Admin passcode\. Nothing was changed\./);
    p.remove();
    assert.ok(LC.api.findAdmin("lc-admin-1") && !LC.api.findAdmin("lc-admin-2"), "unchanged");
    await assert.rejects(LC.api.adminPasscodeChange("", "lc-admin-2", "lc-admin-2"), /Enter the current Admin passcode, or sign in as the Owner or an Admin/);
    assert.strictEqual(audit(LC).length, 1, "nothing logged");
  });

  await t("change with the right current passcode: the old one stops working; logged", async ()=>{
    const p = passCard(LC);
    p.$("#apCurrent").value = "lc-admin-1"; p.$("#apNew").value = "lc-admin-2"; p.$("#apNew2").value = "lc-admin-2";
    await p.$("#apSave").onclick();
    assert.match(p.$("#apMsg").textContent, /Admin passcode changed/);
    p.remove();
    assert.ok(LC.api.findAdmin("lc-admin-2") && !LC.api.findAdmin("lc-admin-1"));
    assert.deepStrictEqual(audit(LC).map((r)=> r.action), ["Admin passcode created", "Admin passcode changed"]);
    assert.match(audit(LC)[1].details, /with the current passcode/);
    noSecret(LC);
  });

  await t("Create once people exist: only a signed-in Owner or Admin", async ()=>{
    const X = till("LX", { install_id:"LX01", secret_phrase:"LX Phrase", shop_name:"LX Shop", branch_name:"Kwekwe", branch_id:"B-KWEKWE01", branch_type:"main" });
    X.api.saveStaffMember({ name:"Rudo", role:"Cashier", pin:"1111" });
    assert.throws(()=> X.api.adminPasscodeCreate("lx-admin-1", "lx-admin-1"), /Sign in as the Owner or an Admin to create this till's Admin passcode/);
    const p = passCard(X); assert.match(p.text(), /Sign in as the Owner or an Admin to create it/); p.remove();
    const tau = X.api.saveStaffMember({ name:"Tau", role:"Admin", pin:"2222" });   // an Admin with a PIN, no passcode
    X.api.setSessionStaffId(tau.id);
    X.api.adminPasscodeCreate("lx-admin-1", "lx-admin-1");
    assert.ok(X.api.findAdmin("lx-admin-1"));
    assert.match(audit(X)[0].details, /by Tau \(Admin\)/);
    X.api.setSessionStaffId(null);
  });

  // (b) waiting for roles
  const WT = till("WT", { install_id:"WT01", secret_phrase:"Wait Phrase", shop_name:"Wait Shop", branch_name:"Masvingo", branch_id:"B-MASVING1", branch_type:"main" });
  await t("(b) waiting for roles: the old list under \"Roles not loaded\", Edit there, no + Add Staff", async ()=>{
    WT.api.saveStaffMember({ name:"Chipo", role:"Admin", pin:"3456", passcode:"wt-admin-1" });
    WT.down = new Set(["cl_device_checkin", "cl_device_staff_pull"]);
    await register(WT);
    await until(()=> WT.api.getSetting("staff_pull_error",""), "the fetch failed");
    assert.strictEqual(WT.api.settingsStaffMode(), "wait");
    const c = staffCard(WT);
    assert.match(c.$("#staffWaitNote").textContent, /Roles not loaded from seiGEN yet — tap Refresh\./);
    assert.ok(!c.$("#openAddStaff"), "no + Add Staff");
    assert.ok(c.$("[data-edit-staff]") && /Chipo/.test(c.text()), "the list and Edit");
    c.remove();
  });

  await t("(b) Edit → its Admin passcode field changes the passcode, as before", async ()=>{
    const c = staffCard(WT);
    c.$("[data-edit-staff]").onclick();
    const m = modal(WT);
    assert.strictEqual(m.querySelector("#stPasscode").value, "wt-admin-1", "the field as before");
    m.querySelector("#stPasscode").value = "wt-admin-2";
    m.querySelector("#stConfirm").onclick();
    c.remove();
    assert.ok(WT.api.findAdmin("wt-admin-2") && !WT.api.findAdmin("wt-admin-1"));
  });

  await t("(b) the Admin passcode card is there on this main till too, and the roles still arrive with Refresh", async ()=>{
    assert.strictEqual(WT.api.adminPasscodeSettingShown(), true);
    await assert.rejects(WT.api.adminPasscodeChange("nope-nope", "wt-admin-3", "wt-admin-3"), /Incorrect current Admin passcode/);
    WT.down = new Set();
    const c = staffCard(WT);
    await c.$("#staffWaitRefresh").onclick();
    assert.ok(WT.api.rolesSynced() && c.$("#shopStaffCard"), "Staff & Roles from seiGEN");
    c.remove();
  });

  // (a) with roles, no passcode
  const FR = till("FR", { install_id:"FR01", secret_phrase:"Fresh Phrase", shop_name:"Fresh Mart", branch_name:"Chinhoyi", branch_id:"B-CHINHOY1", branch_type:"main" });
  let owner = null;
  await t("(a) main till with roles and NO Admin passcode: Create in Settings (the business has nobody yet)", async ()=>{
    await register(FR);
    await until(()=> FR.api.rolesSynced(), "roles");
    assert.strictEqual(FR.api.shopStaffAll().length, 0);
    assert.strictEqual(FR.api.hasAdminPasscode(), false);
    assert.strictEqual(FR.api.adminPasscodeSettingShown(), true, "before v33 there was no way here");
    const p = passCard(FR);
    p.$("#apNew").value = "fr-admin-1"; p.$("#apNew2").value = "fr-admin-1";
    await p.$("#apSave").onclick();
    assert.match(p.$("#apMsg").textContent, /Admin passcode created/);
    p.remove();
    assert.ok(FR.api.findAdmin("fr-admin-1"));
  });

  await t("(a) then the first Owner is added with it", async ()=>{
    FR.api.openShopStaffModal(null, ()=>{});
    const m = modal(FR);
    assert.strictEqual(FR.api.shopRoles().find((r)=> r.id === m.querySelector("#ssRole").value).builtin, "owner", "defaults to Owner");
    m.querySelector("#ssName").value = "Farai"; m.querySelector("#ssPin").value = "1357"; m.querySelector("#ssAdminPass").value = "fr-admin-1";
    await m.querySelector("#ssSave").onclick();
    await until(()=> FR.api.shopStaffAll().some((s)=> s.name === "Farai"), "saved");
    owner = FR.api.shopStaffAll().find((s)=> s.name === "Farai");
    const ev = await q(`select e.kind, e.via from cl_shop_staff_events e join cl_businesses b on b.id = e.business_id where b.name = 'Fresh Mart'`);
    assert.deepStrictEqual(ev.map((e)=> [e.kind, e.via]), [["first_owner", "admin_passcode"]]);
  });

  await t("(a) Change: nobody signed in needs the current passcode (wrong one refused); a signed-in Owner doesn't", async ()=>{
    await assert.rejects(FR.api.adminPasscodeChange("", "fr-admin-2", "fr-admin-2"), /Enter the current Admin passcode, or sign in as the Owner or an Admin/);
    await assert.rejects(FR.api.adminPasscodeChange("fr-wrong-9", "fr-admin-2", "fr-admin-2"), /Incorrect current Admin passcode/);
    assert.ok(FR.api.findAdmin("fr-admin-1"), "unchanged");
    const r = await FR.api.attemptShopSigninAsync(owner.id, "1357");
    assert.ok(r && r.ok, JSON.stringify(r));
    const p = passCard(FR);
    assert.match(p.$("#apCurrent").placeholder, /Not needed: Farai \(Owner\) is signed in/);
    p.$("#apNew").value = "fr-admin-2"; p.$("#apNew2").value = "fr-admin-2";
    await p.$("#apSave").onclick();
    assert.match(p.$("#apMsg").textContent, /Admin passcode changed/);
    p.remove();
    FR.api.staffSignOut();
    assert.ok(FR.api.findAdmin("fr-admin-2") && !FR.api.findAdmin("fr-admin-1"));
    const a = audit(FR);
    assert.deepStrictEqual(a.map((x)=> x.action), ["Admin passcode created", "Admin passcode changed"]);
    assert.match(a[1].details, /by Farai \(Owner\)/);
    noSecret(FR);
  });

  await t("remotes and joined tills: unchanged (no card; their passcode comes from the main branch or the locked screen)", async ()=>{
    const RM = till("RM", { install_id:"RM01", secret_phrase:"RM Phrase", shop_name:"RM Shop", branch_name:"Kadoma", branch_id:"B-KADOMA01", branch_type:"remote" });
    assert.strictEqual(RM.api.adminPasscodeSettingShown(), false, "a remote");
    assert.ok(RM.api.createDeviceAdmin("rm-admin-1", "rm-admin-1"), "the locked-screen create, as before");
    const JM = till("JM", { install_id:"JM01", secret_phrase:"JM Phrase", shop_name:"JM Shop", branch_name:"Harare", branch_id:"B-HARARE09", branch_type:"main",
      terminal_id:"00000000-0000-0000-0000-000000000009", terminal_is_main:"1", till_code:"T2" });
    assert.strictEqual(JM.api.adminPasscodeSettingShown(), false, "a joined till on the main branch");
    assert.throws(()=> JM.api.adminPasscodeCreate("jm-admin-1", "jm-admin-1"), /set by your main branch/);
    const SE = till("SE", { install_id:"SE01", secret_phrase:"SE Phrase", shop_name:"SE Shop", branch_name:"Harare", branch_id:"B-HARARE08", branch_type:"main", terminal_kind:"seat" });
    assert.strictEqual(SE.api.adminPasscodeSettingShown(), false, "an Office seat");
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
