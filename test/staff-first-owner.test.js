// node test/staff-first-owner.test.js
//
// v33 (owner, 2026-10-21: "go — ship this as v33"; Decision 2 "approved"), as on
// live for Romana Books: a main till that registered after the roles migration
// with an old local Admin (Cathy) stayed on the old staff list because nothing
// fetched the roles after "Register this branch". Tills run the REAL app code
// (test/harness.js, JSDOM for the screens) against the REAL server SQL in
// PGlite with 20261110120000_staff_first_owner, never the live database:
//   - not registered: the old local list, as before;
//   - Register this branch -> the roles and staff are fetched at once (no
//     restart); when that fails, Settings says "Roles not loaded from seiGEN yet
//     — tap Refresh" with the reason and offers no local Add staff; Refresh
//     brings them; Cathy's old list is sent once and her PIN carries over;
//   - joining (Settings → Join your business) -> the roles arrive at once;
//   - a refusal from seiGEN shows its reason; the safety net fetches at most
//     once a minute;
//   - the first person defaults to Owner; the Owner choice is closed at a
//     remote and on an Office seat while the business has no Owner;
//   - the internal-transfer receive screen clears the old error when Confirm
//     is pressed again.
"use strict";
const assert = require("assert");
const vm = require("vm");
const { makeApp, fixedClock } = require("./harness");
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
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.filter((f)=> f !== "20261110120000_staff_first_owner.sql") });   // the live shape + this migration
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
  function till(name, settings, opts){
    const A = makeApp(Object.assign({ setup_complete:"1", install_date:"2026-09-01" }, settings), { dom:true });
    if(opts && opts.clock) fixedClock(A, opts.clock);
    A.name = name; A.alerts = []; A.down = new Set(); A.calls = {};
    A.hook("fetch", async (url, o)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      A.calls[m[1]] = (A.calls[m[1]] || 0) + 1;
      if(A.down.has(m[1]) || A.down.has("*")) throw new TypeError("Failed to fetch");   // no answer
      const r = await serial(()=> rpcNow(m[1], JSON.parse(o.body)));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.hook("alert", (m)=>{ A.alerts.push(String(m)); });
    A.hook("confirm", ()=> true);
    A.hook("render", ()=>{});   // the full page isn't drawn here; the cards are
    vm.runInContext(`var $app = document.getElementById("app");`, A.ctx);
    return A;
  }
  const doc = (A)=> A.dom.window.document;
  const modal = (A)=> doc(A).querySelector(".modalOverlay:last-of-type");
  // Settings → Staff & Roles and Business & Terminals, as settings.js draws and wires them
  function staffCard(A){
    const host = doc(A).createElement("div"); doc(A).body.appendChild(host);
    host.innerHTML = A.api.settingsStaffCardHtml(); A.api.wireSettingsStaffCard(host);
    return { $: (sel)=> host.querySelector(sel), text: ()=> flat(host.textContent), remove: ()=> host.remove() };
  }
  function termCard(A){
    const host = doc(A).createElement("div"); doc(A).body.appendChild(host);
    host.innerHTML = A.api.terminalSectionHtml(); A.api.wireTerminalSection();
    return { $: (sel)=> host.querySelector(sel), remove: ()=> host.remove() };
  }
  const RP = "Romana Phrase";
  const T1 = till("T1", { install_id:"RO01", secret_phrase:RP, shop_name:"Romana Books", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const NO = till("NO", { install_id:"RO03", secret_phrase:"Norton Device", shop_name:"Romana Books", branch_name:"Norton", branch_id:"B-NORTON01", branch_type:"remote" });
  const BB = till("BB", { install_id:"BB01", secret_phrase:"Bata Phrase", shop_name:"Bata Shoes", branch_name:"Mutare", branch_id:"B-MUTARE01", branch_type:"main" });
  const DU = till("DU", { install_id:"DU01", secret_phrase:"Dube Phrase", shop_name:"Dube Stores", branch_name:"Bindura", branch_id:"B-BINDURA1", branch_type:"main" }, { clock:"2026-10-21T10:00:00Z" });

  await t("not registered: Settings shows this till's own staff list, as before", async ()=>{
    T1.api.saveStaffMember({ name:"Cathy", role:"Admin", pin:"2468", passcode:"romana-admin-1" });
    assert.strictEqual(T1.api.settingsStaffMode(), "local");
    const c = staffCard(T1);
    assert.ok(c.$("#openAddStaff"), "+ Add Staff");
    assert.match(c.text(), /Cathy/);
    c.remove();
  });

  await t("Register this branch while seiGEN doesn't answer the fetch: \"Roles not loaded from seiGEN yet — tap Refresh\" with the reason; no local Add staff", async ()=>{
    T1.down = new Set(["cl_device_checkin", "cl_device_staff_pull"]);
    const tc = termCard(T1);
    await tc.$("#termRegisterBtn").onclick();
    tc.remove();
    assert.ok(T1.api.isTerminalRegistered(), "registered");
    await until(()=> T1.calls.cl_device_staff_pull >= 1 && T1.api.getSetting("staff_pull_error",""), "the fetch was tried at once");
    assert.ok(!T1.calls.cl_device_checkin, "no whole check-in (it would switch off a single till's stock figures for 6 hours)");
    assert.strictEqual(T1.api.rolesSynced(), false);
    assert.strictEqual(T1.api.settingsStaffMode(), "wait");
    const c = staffCard(T1);
    assert.match(c.$("#staffWaitNote").textContent, /Roles not loaded from seiGEN yet — tap Refresh\./);
    assert.match(c.$("#staffWaitWhy").textContent, /seiGEN didn't answer/);
    assert.ok(!c.$("#openAddStaff"), "no local Add staff");
    assert.ok(c.$("[data-edit-staff]") && /Cathy/.test(c.text()), "the old list stays under it, with Edit (owner 2026-10-21 \"approved option 1\")");
    c.remove();
    assert.deepStrictEqual([...T1.api.signinChoices()].map((x)=> x.name), ["Cathy"], "sign-in on this till works as before meanwhile");
  });

  await t("Refresh while seiGEN still doesn't answer: the reason again; then Refresh brings the roles and Cathy (her old list, once)", async ()=>{
    const c = staffCard(T1);
    await c.$("#staffWaitRefresh").onclick();
    assert.match(c.$("#staffWaitWhy").textContent, /Couldn't load: seiGEN didn't answer/);
    T1.down = new Set();
    await c.$("#staffWaitRefresh").onclick();
    assert.ok(T1.api.rolesSynced(), "roles here");
    assert.ok(c.$("#shopStaffCard"), "the card is now Staff & Roles from seiGEN");
    assert.match(c.text(), /Cathy/);
    c.remove();
    assert.strictEqual(T1.api.getSetting("staff_pull_error",""), "", "the reason is cleared");
    const ev = await q(`select e.kind, e.till_code, e.people from cl_shop_staff_events e join cl_businesses b on b.id = e.business_id where b.name = 'Romana Books'`);
    assert.deepStrictEqual(ev.map((e)=> [e.kind, e.till_code, e.people]), [["old_staff_moved", "T1", 1]]);
    const cathy = T1.api.shopStaffAll().find((s)=> s.name === "Cathy");
    assert.ok(cathy && cathy.here === 1 && JSON.parse(cathy.legacy).length === 1, "Cathy's old PIN check is on T1");
    assert.deepStrictEqual([...T1.api.signinChoices()].map((x)=> x.name), ["Cathy"], "she is on the sign-in list from seiGEN");
  });

  await t("Cathy's old PIN carries over: she signs in on T1 with it (and must set a seiGEN PIN, as since v29)", async ()=>{
    const cathy = T1.api.shopStaffAll().find((s)=> s.name === "Cathy");
    const r = await T1.api.attemptShopSigninAsync(cathy.id, "2468");
    assert.ok(r && r.ok, JSON.stringify(r));
    assert.ok(T1.api.staffSession() && T1.api.staffSession().legacy, "signed in with the old PIN");
    T1.api.staffSignOut();
  });

  await t("join (Settings → Join your business): the roles and staff arrive at once, no restart", async ()=>{
    const r = await T1.api.issueJoinCode({ newBranchName:"Norton", seed:T1.api.adminCheckMake("Romana-Admin-1") });
    assert.ok(r.ok, JSON.stringify(r));
    const tc = termCard(NO);
    tc.$("#termJoinPhrase").value = RP; tc.$("#termJoinCode").value = r.data.code;
    await tc.$("#termJoinBtn").onclick();
    tc.remove();
    assert.ok(NO.api.isTerminalRegistered(), "joined");
    await until(()=> NO.api.rolesSynced(), "roles at the remote");
    assert.ok(NO.api.shopStaffAll().some((s)=> s.name === "Cathy"));
  });

  await t("Register this branch (seiGEN answers): the roles arrive with nobody touching anything; an open Staff card redraws itself", async ()=>{
    BB.api.createDeviceAdmin("bata-admin-1", "bata-admin-1");
    const tc = termCard(BB);
    const reg = tc.$("#termRegisterBtn").onclick();
    await reg; tc.remove();
    const c = staffCard(BB);   // opened right away: still waiting, or already there
    await until(()=> BB.api.rolesSynced(), "roles without a restart");
    await until(()=> !!c.$("#shopStaffCard"), "the waiting card turned into Staff & Roles");
    assert.match(c.text(), /Nobody can manage staff yet\. Add the first person here with this till's Admin passcode: the business's Owner/);
    c.remove();
    assert.strictEqual(BB.api.getSetting("shop_bootstrap",""), "1");
  });

  await t("the first person defaults to Owner; saved with the Admin passcode; logged for the Console", async ()=>{
    BB.api.openShopStaffModal(null, ()=>{});
    const m = modal(BB);
    const sel = m.querySelector("#ssRole");
    assert.strictEqual(BB.api.shopRoles().find((r)=> r.id === sel.value).builtin, "owner", "Owner selected");
    assert.ok(m.querySelector("#ssFirstOwner"), "the line saying so");
    m.querySelector("#ssName").value = "Tsitsi"; m.querySelector("#ssPin").value = "1212"; m.querySelector("#ssAdminPass").value = "bata-admin-1";
    await m.querySelector("#ssSave").onclick();
    await until(()=> BB.api.shopStaffAll().some((s)=> s.name === "Tsitsi"), "saved");
    const ev = await q(`select e.kind, e.till_code, e.via from cl_shop_staff_events e join cl_businesses b on b.id = e.business_id where b.name = 'Bata Shoes'`);
    assert.deepStrictEqual(ev.map((e)=> [e.kind, e.till_code, e.via]), [["first_owner", "T1", "admin_passcode"]]);
    assert.strictEqual(BB.api.getSetting("shop_has_owner",""), "1");
  });

  await t("with people already on seiGEN the default stays Cashier (Romana: Cathy)", async ()=>{
    T1.hook("canStrict", (r)=> r === "owner" || r === "m.staff");   // as for a signed-in Admin while there is no Owner
    T1.api.openShopStaffModal(null, ()=>{});
    const m = modal(T1), sel = m.querySelector("#ssRole");
    assert.strictEqual(T1.api.shopRoles().find((r)=> r.id === sel.value).builtin, "cashier");
    assert.ok(!m.querySelector("#ssFirstOwner"));
    const own = [...sel.options].find((o)=> T1.api.shopRoles().find((r)=> r.id === o.value).builtin === "owner");
    assert.strictEqual(own.disabled, false, "an Admin on the main till may make the first Owner");
    m.remove();
  });

  await t("Decision 2: while there is no Owner, the Owner choice is closed at a remote and on an Office seat, even for an Admin", async ()=>{
    NO.hook("canStrict", (r)=> r === "owner" || r === "m.staff");
    const ownerOpt = (A)=>{ A.api.openShopStaffModal(null, ()=>{}); const m = modal(A);
      const o = [...m.querySelector("#ssRole").options].find((x)=> A.api.shopRoles().find((r)=> r.id === x.value).builtin === "owner"); const d = o.disabled; m.remove(); return d; };
    assert.strictEqual(NO.api.getSetting("shop_has_owner",""), "");
    assert.strictEqual(ownerOpt(NO), true, "remote: closed");
    T1.hook("isSeat", ()=> true);
    assert.strictEqual(ownerOpt(T1), true, "Office seat: closed");
    T1.hook("isSeat", ()=> false);
    NO.api.setSetting("shop_has_owner", "1");
    assert.strictEqual(ownerOpt(NO), false, "once there is an Owner, the Owner gives it anywhere (as before)");
    NO.api.setSetting("shop_has_owner", "");
  });

  await t("a refusal from seiGEN shows its reason (this till switched off)", async ()=>{
    DU.down = new Set(["cl_device_checkin", "cl_device_staff_pull"]);
    const tc = termCard(DU); await tc.$("#termRegisterBtn").onclick(); tc.remove();
    await until(()=> DU.api.getSetting("staff_pull_error",""), "first try failed");
    await q(`update cl_terminals t set active = false from cl_vendors v where v.id = t.vendor_id and v.install_id = 'DU01'`);
    DU.down = new Set();
    try{
      const c = staffCard(DU);
      await c.$("#staffWaitRefresh").onclick();
      await until(()=> /Couldn't load: This till is switched off for the business/.test(c.$("#staffWaitWhy").textContent), "the reason: " + c.$("#staffWaitWhy").textContent);
      c.remove();
    } finally {
      await q(`update cl_terminals t set active = true from cl_vendors v where v.id = t.vendor_id and v.install_id = 'DU01'`);
    }
  });

  await t("the safety net (start, Settings): at most one fetch a minute", async ()=>{
    DU.down = new Set(["cl_device_staff_pull"]);
    DU.setNow("2026-10-21T10:05:00Z");
    const n0 = DU.calls.cl_device_staff_pull || 0;
    await DU.api.staffEnsureRoles();
    await DU.api.staffEnsureRoles();
    assert.strictEqual(DU.calls.cl_device_staff_pull, n0 + 1, "one fetch");
    DU.setNow("2026-10-21T10:05:30Z"); await DU.api.staffEnsureRoles();
    assert.strictEqual(DU.calls.cl_device_staff_pull, n0 + 1, "still one within the minute");
    DU.down = new Set();
    DU.setNow("2026-10-21T10:06:01Z"); await DU.api.staffEnsureRoles();
    // a new one after a minute: the fetch, this main till's (empty) old list sent once, the fetch again
    assert.strictEqual(DU.calls.cl_device_staff_pull, n0 + 3, "a new one after a minute");
    assert.strictEqual(DU.calls.cl_device_staff_upload, 1);
    assert.ok(DU.api.rolesSynced(), "the roles arrived");
    DU.setNow("2026-10-21T10:08:00Z"); await DU.api.staffEnsureRoles();
    assert.strictEqual(DU.calls.cl_device_staff_pull, n0 + 3, "none once the roles are here");
  });

  await t("internal transfer receive: pressing Confirm again clears the old red error while it tries", async ()=>{
    const X = { id:"it-1", it_display:"IT0001", from_till:"S1", from_kind:"seat", status:"sent", lines:[{ line_no:1, name:"Soap", qty:5 }] };
    T1.hook("itCache", ()=> ({ incoming:[X], outgoing:[] }));
    let attempt = 0, release = null;
    T1.hook("itReceive", ()=>{ attempt++; if(attempt === 1) return Promise.reject(new Error("Soap isn't a product on this device yet.")); return new Promise((res)=>{ release = res; }); });
    const w = T1.api.openTransferReceiveModal("it-1", ()=>{});
    const go = w.querySelector("#itRecvGo"), msg = w.querySelector("#itRecvMsg");
    await go.onclick();
    assert.match(msg.textContent, /isn't a product on this device/);
    const second = go.onclick();
    assert.strictEqual(go.textContent, "Confirming…");
    assert.strictEqual(msg.textContent, "", "the old error is gone while it tries again");
    release({ ok:true }); await second;
    assert.ok(!w.isConnected, "confirmed: the screen closed");
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
