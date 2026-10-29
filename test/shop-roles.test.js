// node test/shop-roles.test.js
//
// Branches step 3, Roles (app v28; docs/branches/multi-branch-visibility-design.md
// §R8, §R4, Q1, Q2, Q7; owner "go" 2026-10-16). Tills running the REAL app code
// (test/harness.js, JSDOM for the screens) against the REAL server SQL in
// PGlite (the live shape + 20261107120000_shop_roles), never the live database:
//   - existing staff keep their access after the move, on purpose: Admin ->
//     Admin, Cashier -> Cashier, "Can create customers" kept; each till's old
//     PIN works on that till; the same person on two tills is one person;
//   - each default role (Owner, Admin, Manager, Stores, Cashier) at main and
//     at a remote: menus shown or hidden, reports and costs shown or hidden;
//   - a custom role;
//   - Report Writer: other branches only with the right (seiGEN refuses
//     without it), costs only with View costs;
//   - sign-in works offline; single operator mode is unchanged;
//   - approvals by the holder's own PIN; switching someone off ends their
//     session; the Roles editor (Settings → Staff & Roles).
"use strict";
const assert = require("assert");
const vm = require("vm");
const { makeApp } = require("./harness");
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo } = require("../supabase/tests/rebuild-helpers");

let passed = 0, failed = 0;
const same = (a, b, m)=> assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); }
}
const flat = (s)=> String(s).replace(/\s+/g, " ");
const COST = /\b3\.21\b|\bCost\b|Value at cost|value at cost/;

(async ()=>{
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat(["20261108120000_shop_managers_everywhere.sql", "20261109120000_office_seats.sql", "20261110120000_staff_first_owner.sql", "20261112120000_builtin_customers.sql", "20261113120000_sales_sync.sql", "20261113180000_removed_devices.sql", "20261114120000_roles_everywhere.sql", "20261115120000_stock_control.sql", "20261116120000_vendor_register_status.sql", "20261117120000_srq_drafts.sql"]) });
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
    const A = makeApp(Object.assign({ setup_complete:"1", secret_phrase:"Mandie Phrase", install_date:"2026-09-01" }, settings), { dom:true });
    A.name = name;
    A.hook("fetch", async (url, opts)=>{
      if(A.ctx.navigator.onLine === false) throw new TypeError("Failed to fetch");
      const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
      if(!m) throw new TypeError("not faked: " + url);
      const r = await serial(()=> rpcNow(m[1], JSON.parse(opts.body)));
      return { ok: r.status < 300, status: r.status, json: async ()=> JSON.parse(r.body), text: async ()=> r.body };
    });
    A.hook("printReport", ()=>{});
    vm.runInContext(`var APP_VERSION="test", rwType="sales", rwBranch="", rwStatus="", rwReason="", rwView="dn", rwFrom="", rwTo="", rwGranularity="day";`, A.ctx);
    return A;
  }
  const H1 = till("H1", { install_id:"MB01", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE01", branch_type:"main" });
  const H2 = till("H2", { install_id:"MB02", shop_name:"Mandie Babyware", branch_name:"Harare", branch_id:"B-HARARE02", branch_type:"main" });
  const M1 = till("M1", { install_id:"MB03", shop_name:"Mandie Babyware", branch_name:"Murehwa", branch_id:"B-MUREHWA1", branch_type:"remote" });
  const doc = (A)=> A.dom.window.document;
  const screen = (A)=>{ const el = doc(A).createElement("div"); doc(A).body.appendChild(el); return el; };
  const closeModals = (A)=> doc(A).querySelectorAll(".modalOverlay").forEach((m)=> m.remove());
  // each till's own staff list from before (salted SHA-256 PINs; Admin passcodes)
  const legacy = (A, name, role, pin, o)=> A.api.saveStaffMember(Object.assign({ name, role, pin, passcode: role==="Admin"? "pass-"+pin : "" }, o||{}));
  legacy(H1, "Boss", "Admin", "1111"); legacy(H1, "Rudo", "Cashier", "3333"); legacy(H1, "Chipo", "Cashier", "4444", { can_create_customers:true });
  legacy(H2, "boss", "Admin", "2222");
  legacy(M1, "Farai", "Admin", "6666"); legacy(M1, "Tari", "Cashier", "5555");
  const CAT = "0123456789abcdef0123456789abcdef";
  for(const [A, qty] of [[H1, 6], [H2, 3], [M1, 4]]){
    A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,cost,created_ts,cat_uid,image,description) VALUES('Bib',5,?,1,'BIB1',?,3.21,?,?,'','')", [qty, A.api.currentBranch(), new Date().toISOString(), CAT]);
  }
  const people = (A)=> Object.fromEntries(A.api.shopStaffAll().map((s)=> [s.name, s]));
  // sign in as on the "Who's working today?" screen: this till's check, then seiGEN's token
  async function signIn(A, name, pin){
    const choice = A.api.signinChoices().find((c)=> c.name === name);
    assert.ok(choice, A.name + ": " + name + " is on the sign-in list");
    A.api.staffSignOut();
    const r = choice.key.startsWith("s:")? A.api.attemptShopSignin(choice.key.slice(2), pin) : A.api.attemptPinLogin(+choice.key.slice(2), pin);
    if(r.ok){ A.api.setSessionUser(name); if(!choice.key.startsWith("s:")) A.api.setSessionStaffId(r.staff.id); await A.api.staffEnsureToken(); }
    return r;
  }

  await t("setup: Harare registers, T2 and Murehwa join; the tills are older than seiGEN's staff (as on live)", async ()=>{
    assert.ok((await H1.api.registerMainBranch("Counter")).ok);
    let r = await H1.api.issueJoinCode({ branchId:H1.api.getSetting("branch_uuid",""), seed:H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await H2.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Back" })).ok);
    r = await H1.api.issueJoinCode({ newBranchName:"Murehwa", seed:H1.api.adminCheckMake("Branch-Admin-1") });
    assert.ok((await M1.api.joinBusiness({ phrase:"Mandie Phrase", code:r.data.code, label:"Till 1", expectedBranchName:"Murehwa" })).ok);
    await q(`update cl_shop_meta set v = now() + interval '1 day' where k = 'legacy_cutoff'`);
    const biz = (await q(`select business_id from cl_terminals where install_id = 'MB01'`))[0].business_id;
    await q(`insert into cl_catalogue_products (business_id, product_uid, code, name, price, cost, change_seq, last_op_id) values ($1, $2, 'BIB1', 'Bib', 5, 3.21, 1, 'op1')`, [biz, CAT]);
    for(const A of [H1, H2, M1]){ assert.ok((await A.api.bsPush()).ok, A.name); }
    for(const A of [H1, H2, M1]){ assert.ok((await A.api.bsPull()).ok, A.name); }
  });

  await t("before seiGEN has them: an old local sign-in already follows its role (Cashier: no Products, no Settings)", async ()=>{
    H1.api.setSetting("single_operator_mode", "0");
    const r = await signIn(H1, "Rudo", "3333");
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(H1.api.navAllowed("pos"), true); assert.strictEqual(H1.api.navAllowed("products"), false);
    assert.strictEqual(H1.api.moreTabAllowed("settings"), false);
    H1.api.setSessionStaffId(null);
  });

  await t("the move: Murehwa waits for main; then each till sends its list once", async ()=>{
    let r = await M1.api.staffPull();
    assert.ok(r.ok && r.staff === 0, JSON.stringify(r));
    assert.strictEqual(M1.api.getSetting("shop_upload",""), "wait_main");
    r = await H1.api.staffPull();
    assert.ok(r.ok && r.roles === 6 && r.staff === 3, JSON.stringify(r));
    for(const A of [H2, M1, H1]) assert.ok((await A.api.staffPull()).ok, A.name);
    same(Object.keys(people(H1)).sort(), ["Boss", "Chipo", "Farai", "Rudo", "Tari"]);
    same(H1.api.shopRoles().map((x)=> x.name), ["Owner", "Admin", "Manager", "Stores", "Cashier", "Cashier + customers"]);
    assert.strictEqual(people(H1).Boss.pins_from_tills, 2, "Boss came from 2 tills: one person");
  });

  await t("existing staff keep their access (on purpose): Admin -> Admin, Cashier -> Cashier, Create customers kept, each old PIN on its own till", async ()=>{
    const roleOf = (n)=> H1.api.shopRole(people(H1)[n].role_id).name;
    same(["Boss", "Rudo", "Chipo", "Farai", "Tari"].map(roleOf), ["Admin", "Cashier", "Cashier + customers", "Admin", "Cashier"]);
    same(H1.api.signinChoices().map((c)=> c.name), ["Boss", "Chipo", "Rudo"], "Harare's people on Harare's till");
    same(M1.api.signinChoices().map((c)=> c.name), ["Farai", "Tari"]);
    // Rudo (Cashier): sells, no Products, can't add customers
    assert.ok((await signIn(H1, "Rudo", "3333")).ok);
    assert.ok(H1.api.navAllowed("pos") && H1.api.navAllowed("credit") && !H1.api.navAllowed("products"));
    assert.strictEqual(H1.api.canCreateCustomers(), false);
    // Chipo (Cashier + customers): adds customers as before
    assert.ok((await signIn(H1, "Chipo", "4444")).ok);
    assert.strictEqual(H1.api.canCreateCustomers(), true);
    assert.ok(!H1.api.navAllowed("products"));
    // Farai (Admin at Murehwa), Tari (Cashier)
    assert.ok((await signIn(M1, "Farai", "6666")).ok);
    assert.ok(M1.api.can("m.settings") && M1.api.can("costs") && M1.api.can("m.staff"));
    assert.ok((await signIn(M1, "Tari", "5555")).ok);
    assert.ok(!M1.api.can("m.settings") && M1.api.can("m.sell"));
    // Boss: T1's old PIN on T1, T2's on T2 (before he signs in online)
    H1.ctx.navigator.onLine = false; H2.ctx.navigator.onLine = false;
    const onH2 = H2.api.signinChoices().find((c)=> c.name === "Boss");
    assert.ok(onH2, "the merged person keeps the first name sent");
    assert.strictEqual(H2.api.attemptShopSignin(onH2.key.slice(2), "1111").ok, false, "T1's PIN isn't T2's");
    assert.strictEqual(H2.api.attemptShopSignin(onH2.key.slice(2), "2222").ok, true, "T2's old PIN works on T2");
    H2.api.staffSignOut();
    const b1 = await signIn(H1, "Boss", "1111");
    assert.ok(b1.ok, "T1's old PIN works on T1, offline");
    assert.ok(H1.api.can("m.staff") && H1.api.can("costs") && H1.api.can("owner"), "Admin, with the Owner items while there is no Owner");
    H1.ctx.navigator.onLine = true; H2.ctx.navigator.onLine = true;
  });

  await t("online, seiGEN checks Boss's old PIN; he sets his seiGEN PIN (v29): it now works on T2 too (T2's old one stops)", async ()=>{
    const tok = await H1.api.staffEnsureToken();
    assert.ok(tok && tok.length === 64, "a token");
    assert.strictEqual(H1.api.staffSession().legacy, true, "still the old PIN: nothing is set again by itself (v29)");
    assert.ok(await H1.api.staffSetOwnPin("1111"));
    await H2.api.staffPull();
    const onH2 = H2.api.signinChoices().find((c)=> c.name === "Boss").key.slice(2);
    assert.strictEqual(H2.api.attemptShopSignin(onH2, "2222").ok, false);
    assert.strictEqual(H2.api.attemptShopSignin(onH2, "1111").ok, true);
    H2.api.staffSignOut();
  });

  // ---- each default role, at main and at a remote ----
  const ids = {};
  await t("Boss adds an Owner, a Manager, Stores and a Cashier at each branch (seiGEN checks his Staff right)", async ()=>{
    await signIn(H1, "Boss", "1111");
    const role = (n)=> H1.api.shopRoles().find((r)=> r.name === n).id;
    const HAR = H1.api.getSetting("branch_uuid",""), MUR = M1.api.getSetting("branch_uuid","");
    const add = async (name, r, home, others)=>{ const s = await H1.api.saveShopStaff({ name, role_id:role(r), home_branch_id:home, other_branches:others||[], pin:"1357" }); ids[name] = s.id; };
    await add("Tendai", "Owner", HAR, [MUR]);
    await add("Mandla", "Manager", HAR); await add("Mpho", "Stores", HAR); await add("Kuda", "Cashier", HAR);
    await add("Lindiwe", "Manager", MUR); await add("Nyasha", "Stores", MUR); await add("Sipho", "Cashier", MUR);
    for(const A of [H1, H2, M1]) await A.api.staffPull();
    same(M1.api.signinChoices().map((c)=> c.name), ["Farai", "Lindiwe", "Nyasha", "Sipho", "Tari", "Tendai"]);
    assert.strictEqual(H1.api.getSetting("shop_has_owner",""), "1");
    assert.ok(!H1.api.can("owner"), "an Owner exists: Boss (Admin) no longer has the Owner items");
  });

  const MENUS = ["pos", "products", "credit", "reports", "marketing"], TABS = ["productlist", "stocktake", "directory", "requests", "reportwriter", "settings"];
  const EXPECT = {
    Owner:   { nav:[1,1,1,1,1], tabs:[1,1,1,1,1,1], acts:{ costs:1, other_branches:1, sales_reports:1, "m.staff":1, owner:1 } },
    Admin:   { nav:[1,1,1,1,1], tabs:[1,1,1,1,1,1], acts:{ costs:1, other_branches:1, sales_reports:1, "m.staff":1, owner:0 } },
    Manager: { nav:[1,1,1,1,1], tabs:[1,1,1,1,1,0], acts:{ costs:1, other_branches:1, sales_reports:1, "m.staff":0, owner:0 } },
    Stores:  { nav:[0,1,0,1,0], tabs:[1,1,0,0,1,0], acts:{ costs:0, other_branches:0, sales_reports:0, "m.staff":0, owner:0 } },
    Cashier: { nav:[1,0,1,1,0], tabs:[1,0,1,1,0,0], acts:{ costs:0, other_branches:0, sales_reports:1, "m.staff":0, owner:0 } } };
  const WHO = { main:{ Owner:"Tendai", Admin:"Boss", Manager:"Mandla", Stores:"Mpho", Cashier:"Kuda" },
                remote:{ Owner:"Tendai", Admin:"Farai", Manager:"Lindiwe", Stores:"Nyasha", Cashier:"Sipho" } };
  const PINS = { Boss:"1111", Farai:"6666" };
  for(const where of ["main", "remote"]){
    await t("each default role at " + (where==="main"? "main (Harare)" : "a remote (Murehwa)") + ": menus, reports and costs shown or hidden", async ()=>{
      const A = where==="main"? H1 : M1;
      for(const [role, exp] of Object.entries(EXPECT)){
        const name = WHO[where][role];
        const r = await signIn(A, name, PINS[name] || "1357");
        assert.ok(r.ok, name + " " + JSON.stringify(r));
        same(MENUS.map((m)=> A.api.navAllowed(m)? 1 : 0), exp.nav, role + " nav");
        same(TABS.map((m)=> A.api.moreTabAllowed(m)? 1 : 0), exp.tabs, role + " More");
        for(const [k, v] of Object.entries(exp.acts)) assert.strictEqual(A.api.can(k)? 1 : 0, v, role + " " + k);
        // Report Writer's reports: sales and cost ones follow the rights
        const rw = A.api.reportWriterConfigs().map((c)=> c.id);
        assert.strictEqual(rw.includes("sales"), !!exp.acts.sales_reports, role + " sales report");
        if(where==="main") assert.strictEqual(rw.includes("margin"), !!exp.acts.costs, role + " margin");
        assert.ok(rw.includes("inventory"), role + " stock reports");
        // Reports page cards
        assert.strictEqual(A.api.reportCardAllowed("Sales Report"), !!exp.acts.sales_reports);
        assert.strictEqual(A.api.reportCardAllowed("Margin Report"), !!exp.acts.costs);
        assert.strictEqual(A.api.reportCardAllowed("Inventory Report"), true);
        // the product editor: the cost box only with View costs
        if(where==="main" && exp.nav[1]){
          const p = A.api.one("SELECT * FROM products WHERE sku='BIB1' AND branch=?", [A.api.currentBranch()]);
          A.api.productModal(p);
          const box = doc(A).querySelector("#pCost").parentElement;
          assert.strictEqual(box.style.display === "none", !exp.acts.costs, role + " cost box");
          closeModals(A);
        }
        // seiGEN: another branch's inventory only with the right; its cost only with View costs
        const other = where==="main"? M1.api.getSetting("branch_uuid","") : H1.api.getSetting("branch_uuid","");
        const rep = await A.api.staffBranchReport("inventory", other);
        if(exp.acts.other_branches){ assert.ok(rep.ok, role + " " + JSON.stringify(rep)); assert.strictEqual(rep.data.costs, !!exp.acts.costs, role + " costs from seiGEN"); }
        else { assert.strictEqual(rep.ok, false, role); assert.match(rep.message, /View other branches' reports/); }
      }
    });
  }

  await t("a custom role: \"Supervisor\" sells and reads other branches in Report Writer, without costs", async ()=>{
    await signIn(H1, "Boss", "1111");
    const r = await H1.api.saveShopRole({ name:"Supervisor", rights:["m.sell", "m.reportwriter", "other_branches"] });
    assert.ok(r.ok, JSON.stringify(r));
    await H1.api.saveShopStaff({ name:"Tapiwa", role_id:r.role.id, home_branch_id:M1.api.getSetting("branch_uuid",""), pin:"2468" });
    await M1.api.staffPull();
    assert.ok((await signIn(M1, "Tapiwa", "2468")).ok);
    same(MENUS.map((m)=> M1.api.navAllowed(m)? 1 : 0), [1,0,0,0,0]);
    assert.ok(M1.api.moreTabAllowed("reportwriter") && !M1.api.moreTabAllowed("directory"));
    same(M1.api.reportWriterConfigs().map((c)=> c.id).filter((x)=> ["sales", "inventory", "margin"].includes(x)), ["inventory"], "stock reports only (no Sales and money reports)");
  });

  async function reportWriter(A, type, branchLabel){
    const el = screen(A);
    vm.runInContext(`rwType=${JSON.stringify(type)}; rwBranch="";`, A.ctx);
    A.api.renderReportWriter(el);
    const sel = el.querySelector("#rwBranchSel");
    const options = [...sel.querySelectorAll("option")].map((o)=> o.textContent);
    if(branchLabel){
      const o = [...sel.querySelectorAll("option")].find((x)=> x.textContent === branchLabel);
      assert.ok(o, "option " + branchLabel + " in " + options.join(" | "));
      vm.runInContext(`rwBranch=${JSON.stringify(o.value)};`, A.ctx);
      A.api.renderReportWriter(el);
    }
    await A.api.runReportWriter();
    const res = flat(el.querySelector("#rwResults").textContent);
    el.remove();
    return { options, res };
  }
  await t("Report Writer at a remote: other branches only with the right, costs only with View costs", async ()=>{
    // Tapiwa (other branches, no costs)
    let r = await reportWriter(M1, "inventory", "Harare (from seiGEN)");
    assert.ok(r.options.includes("Murehwa (this branch)"));
    assert.match(r.res, /Bib/); assert.match(r.res, /Bib ?9(?!\d)/, "Harare: T1 6 + T2 3");
    assert.match(r.res, /quantities only/); assert.doesNotMatch(r.res, COST, r.res);
    // Farai (Admin): the same with the cost and the value
    await signIn(M1, "Farai", "6666");
    r = await reportWriter(M1, "inventory", "Harare (from seiGEN)");
    assert.match(r.res, /Cost/); assert.match(r.res, /3\.21/); assert.match(r.res, /value at cost \$28\.89/);
    // Nyasha (Stores: Report Writer, no other branches): this branch only
    await signIn(M1, "Nyasha", "1357");
    r = await reportWriter(M1, "inventory");
    same(r.options, ["Murehwa (this branch)"]);
    assert.match(r.res, /Bib/);
    // Sipho (Cashier): no Report Writer at all
    await signIn(M1, "Sipho", "1357");
    assert.strictEqual(M1.api.moreTabAllowed("reportwriter"), false);
    // seiGEN itself refuses a till that asks without the right (even a changed app)
    const rep = await M1.api.staffBranchReport("inventory", H1.api.getSetting("branch_uuid",""));
    assert.strictEqual(rep.ok, false); assert.match(rep.message, /View other branches' reports/);
  });

  await t("single operator mode is unchanged: every menu, the branch picker as before, no seiGEN extras", async ()=>{
    M1.api.staffSignOut(); M1.api.setSessionStaffId(null);
    assert.strictEqual(M1.api.currentRights(), null);
    assert.ok(MENUS.every((m)=> M1.api.navAllowed(m)) && M1.api.moreTabAllowed("settings"));
    const r = await reportWriter(M1, "inventory");
    same(r.options, ["Murehwa (this branch)"], "a remote: its own branch, as in v27");
    const rep = await M1.api.staffBranchReport("inventory", H1.api.getSetting("branch_uuid",""));
    assert.strictEqual(rep.ok, false);
  });

  await t("sign-in works offline (this till's check), and gets seiGEN's token when back online", async ()=>{
    M1.ctx.navigator.onLine = false;
    const r = await signIn(M1, "Lindiwe", "1357");
    assert.ok(r.ok);
    assert.strictEqual(M1.api.staffToken(), null);
    assert.ok(M1.api.can("costs") && !M1.api.can("m.settings"), "menus from the last copy");
    const rep = await M1.api.staffBranchReport("inventory", H1.api.getSetting("branch_uuid",""));
    assert.match(rep.message, /offline/);
    M1.ctx.navigator.onLine = true;
    assert.ok(await M1.api.staffEnsureToken());
    assert.strictEqual(M1.api.attemptShopSignin(ids.Lindiwe, "9999").ok, false, "a wrong PIN offline or online");
  });

  await t("approvals: a Manager's own PIN approves (Credit sales over limit); a Cashier's doesn't; the Admin passcode still does", async ()=>{
    await signIn(H1, "Mandla", "1357");
    assert.strictEqual(H1.api.findApprover("1357", "credit_over_limit").name, "Mandla");
    assert.strictEqual(H1.api.findApprover("1358", "credit_over_limit"), null);
    await signIn(H1, "Kuda", "1357");
    assert.strictEqual(H1.api.findApprover("1357", "credit_over_limit"), null);
    assert.strictEqual(H1.api.findApprover("pass-1111", "credit_over_limit").name, "Boss", "this till's Admin passcode, as always");
  });

  await t("switching someone off ends their session (seiGEN at once; this till at its next pull)", async ()=>{
    await signIn(M1, "Tapiwa", "2468");
    assert.ok(M1.api.staffToken());
    await signIn(H1, "Boss", "1111");
    await H1.api.saveShopStaff({ id:ids.Tapiwa || M1.api.staffSession().id, name:"Tapiwa", role_id:M1.api.shopStaff(M1.api.staffSession().id).role_id, home_branch_id:M1.api.getSetting("branch_uuid",""), active:false });
    const rep = await M1.api.staffBranchReport("inventory", H1.api.getSetting("branch_uuid",""));
    assert.strictEqual(rep.ok, false, "seiGEN stops at once");
    M1.hook("alert", ()=>{});
    await M1.api.staffPull();
    assert.strictEqual(M1.api.staffSession(), null, "the till ends the session at its pull");
    assert.ok(!M1.api.signinChoices().some((c)=> c.name === "Tapiwa"));
  });

  await t("Settings → Staff & Roles: the people and the roles; the role editor saves a change through seiGEN", async ()=>{
    await signIn(H1, "Boss", "1111");
    const el = screen(H1);
    const draw = ()=>{ el.innerHTML = H1.api.shopStaffSectionHtml(); H1.api.wireShopStaffSection(el.querySelector("#shopStaffCard"), draw); };
    draw();   // the card Settings shows (settings.js settingsStaffCardHtml)
    const card = el.querySelector("#shopStaffCard");
    assert.ok(card, "the shared Staff & Roles card");
    assert.match(flat(card.textContent), /People \(\d+\)/);
    assert.match(flat(card.textContent), /Boss Admin · Harare/);
    card.querySelector("#staffTabRoles").click();
    const card2 = el.querySelector("#shopStaffCard");
    assert.match(flat(card2.textContent), /Owner built in Every right/);
    const mgr = H1.api.shopRoles().find((r)=> r.name === "Manager");
    card2.querySelector(`[data-edit-role="${mgr.id}"]`).click();
    const modal = doc(H1).querySelector(".modalOverlay");
    assert.match(modal.querySelector("h3").textContent, /Edit role: Manager/);
    const costs = modal.querySelector('[data-right="costs"]');
    assert.strictEqual(costs.checked, true);
    costs.checked = false;
    modal.querySelector("#rlSave").click();
    for(let i = 0; i < 100 && doc(H1).querySelector(".modalOverlay"); i++) await new Promise((r)=> setTimeout(r, 20));
    assert.ok(!doc(H1).querySelector(".modalOverlay"), "saved and closed");
    await M1.api.staffPull();
    assert.ok((await signIn(M1, "Lindiwe", "1357")).ok);
    assert.strictEqual(M1.api.can("costs"), false, "the Manager role lost View costs on every till");
    el.remove();
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
