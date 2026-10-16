  // ================== Roles and staff (Branches step 3, app v28) ==================
  // docs/branches/multi-branch-visibility-design.md, addendum §R8 (owner
  // 2026-10-14: Q1 the default rights, Q2 Owner, Q7 costs at a remote);
  // server side: supabase/migrations/20261107120000_shop_roles.sql.
  //   * Rights: one per menu (a menu without its right is hidden) and the
  //     action rights. Five built-in roles + custom roles, business-wide.
  //   * Roles and staff are kept on seiGEN and pulled by every till at each
  //     check-in. A till first sends its old staff list once (main first):
  //     Admin -> Admin, Cashier -> Cashier, Cashier with "Can create
  //     customers" -> "Cashier + customers". Each old PIN keeps working on
  //     the till it came from; signing in there sets it again for every till.
  //   * Sign-in works offline: the PIN against the synced check value
  //     (PBKDF2, passcode-check.js). Online, seiGEN checks it too and gives a
  //     token (held in memory with the PIN for this session only); readers of
  //     other branches' data or of costs send it, and seiGEN checks the right.
  //   * Single operator mode (the default) is unchanged: no sign-in, every menu
  //     as before, the Admin passcode for approvals. Server-gated extras need a
  //     signed-in person with the right.

  const ROLE_MENU_RIGHTS = [
    ["m.sell","Sell"], ["m.products","Products"], ["m.credit","Credit"], ["m.reports","Reports"], ["m.marketing","Marketing"],
    ["m.dispatch","Dispatch"], ["m.receive","Receive (GRV)"], ["m.adjust","Adjustments"], ["m.incoming","seiGEN dispatches (Incoming)"],
    ["m.productlist","Product List, Stock by branch"], ["m.stocktake","Stocktake"], ["m.requests","Requests (customer notepad)"],
    ["m.purchasing","Purchasing / Supplier GRV"], ["m.reportwriter","Report Writer"], ["m.directory","Directory"],
    ["m.eod","End of Day"], ["m.settings","Settings"], ["m.staff","Staff (people and roles)"], ["m.terminals","Business & Terminals"]];
  const ROLE_ACTION_RIGHTS = [
    ["costs","View costs"], ["edit_prices","Edit prices"], ["create_customers","Create customers"], ["review_requisitions","Review stock requisitions"],
    ["other_branches","View other branches' reports"], ["approve_writeoffs","Approve write-offs"], ["void_return","Void/return"],
    ["credit_over_limit","Credit sales over limit"], ["sales_reports","Sales and money reports"]];
  const ROLE_ALL_RIGHTS = ROLE_MENU_RIGHTS.concat(ROLE_ACTION_RIGHTS).map(r=>r[0]);
  // The built-in roles' rights, as seiGEN makes them (cl_shop_default_rights): used for an
  // old local staff sign-in before this till has the roles from seiGEN.
  const ROLE_DEFAULTS = {
    owner: ROLE_ALL_RIGHTS.concat("owner"),
    admin: ROLE_ALL_RIGHTS.slice(),
    manager: ROLE_ALL_RIGHTS.filter(r=> !["m.settings","m.staff","m.terminals"].includes(r)),
    stores: ["m.products","m.dispatch","m.receive","m.adjust","m.incoming","m.productlist","m.stocktake","m.purchasing","m.reports","m.reportwriter"],
    cashier: ["m.sell","m.credit","m.productlist","m.directory","m.requests","m.reports","m.eod","sales_reports"]
  };
  const ROLE_ORDER = { owner:1, admin:2, manager:3, stores:4, cashier:5 };

  // ---- this till's copy ----
  function rolesSynced(){ try{ return !!one("SELECT 1 AS x FROM shop_roles LIMIT 1"); }catch(e){ return false; } }
  function shopRoles(){
    return all("SELECT * FROM shop_roles").map(r=> Object.assign({}, r, { rights: staffJson(r.rights, []) }))
      .sort((a,b)=> (ROLE_ORDER[a.builtin]||9)-(ROLE_ORDER[b.builtin]||9) || String(a.name).localeCompare(String(b.name)));
  }
  function shopRole(id){ const r = one("SELECT * FROM shop_roles WHERE id=?",[id]); return r? Object.assign({}, r, { rights: staffJson(r.rights, []) }) : null; }
  function shopStaff(id){ return one("SELECT * FROM shop_staff WHERE id=?",[id]); }
  function shopStaffAll(){ return all("SELECT * FROM shop_staff ORDER BY active DESC, lower(name)"); }
  function staffJson(s, dflt){ try{ const v = JSON.parse(s||""); return v==null? dflt : v; }catch(e){ return dflt; } }
  // Who may sign in on this till: active, allowed at this branch, with a PIN this till can check.
  function shopStaffHere(){
    return all("SELECT * FROM shop_staff WHERE active=1 AND here=1 ORDER BY lower(name)")
      .filter(s=> s.pin_check || staffJson(s.legacy, []).length);
  }
  function staffBranches(){ return staffJson(getSetting("staff_branches","[]"), []); }
  function staffBranchName(id){ const b = staffBranches().find(x=>x.id===id); return b? b.name : ""; }

  // ---- the signed-in person ----
  // { id, name, pin (memory only), token, tokenExp, legacy } or null.
  let _staffSession = null;
  function staffSession(){ return _staffSession; }
  function currentRights(){
    if(_staffSession){
      const st = shopStaff(_staffSession.id), r = st? shopRole(st.role_id) : null;
      if(!r) return new Set();
      const set = new Set(r.rights);
      if(r.builtin==="owner" || (r.builtin==="admin" && getSetting("shop_has_owner","")!=="1")) set.add("owner");   // Q2: Admins keep the Owner items until there is an Owner
      return set;
    }
    const legacy = typeof currentStaff==="function"? currentStaff() : null;
    if(legacy){
      const set = new Set(ROLE_DEFAULTS[legacy.role==="Admin"? "admin" : "cashier"]);
      if(legacy.role==="Admin") set.add("owner");
      if(Number(legacy.can_create_customers)===1) set.add("create_customers");
      return set;
    }
    return null;   // nobody signed in with a PIN: everything as before
  }
  // A menu or an action: shown/allowed. Nobody signed in (single operator mode): as before.
  function can(right){ const r = currentRights(); return r===null || r.has(right); }
  // Only a signed-in person who holds it (seiGEN-gated extras).
  function canStrict(right){ const r = currentRights(); return r!==null && r.has(right); }

  // Menus (router.js): the nav bar and More.
  const NAV_RIGHT = { pos:"m.sell", products:"m.products", credit:"m.credit", reports:"m.reports", marketing:"m.marketing" };
  const MORE_RIGHT = { directory:"m.directory", productlist:"m.productlist", branches:"m.productlist", stocktake:"m.stocktake", requests:"m.requests",
    purchasing:"m.purchasing", reportwriter:"m.reportwriter", settings:"m.settings", itredorders:"m.sell", itredfeedback:"m.sell" };
  function navAllowed(id){ return !NAV_RIGHT[id] || can(NAV_RIGHT[id]); }
  function moreTabAllowed(id){ return !MORE_RIGHT[id] || can(MORE_RIGHT[id]); }
  // The first screen this person may open (Sell when they have it).
  function firstAllowedRoute(){ return ["pos","products","credit","reports","marketing"].find(navAllowed) || "more"; }

  // Reports page cards (reports.js), by title.
  const REPORT_KIND = { "Margin Report":"cost", "Inventory Report":"stock", "Stock Received Report":"stock", "Low Stock Report":"stock", "Aging Inventory":"stock" };
  function reportCardAllowed(name){
    const k = REPORT_KIND[name] || "sales";
    return k==="stock" || (k==="cost"? can("costs") && can("sales_reports") : can("sales_reports"));
  }

  // An approval (write-off, return, credit over the limit): the Admin passcode as always, or the
  // signed-in person's own PIN when their role holds the right (§R8 rule 6). -> the approver or null.
  function findApprover(code, right){
    const admin = findAdmin(code);
    if(admin) return admin;
    if(!_staffSession || !canStrict(right) || !String(code||"").trim()) return null;
    const st = shopStaff(_staffSession.id);
    return st && staffPinMatches(st, code)? { id:null, name:st.name, role:"Staff" } : null;
  }

  // ---- PINs ----
  function staffPinMatches(st, pin){
    const p = String(pin==null? "" : pin).trim();
    if(!/^\d{4,6}$/.test(p)) return null;
    if(st.pin_check && adminCheckMatches(p, st.pin_salt, st.pin_check, st.pin_rounds)) return { legacy:false };
    for(const e of staffJson(st.legacy, [])) if(e && e.salt && hashPinSync(p, e.salt)===e.hash) return { legacy:true };
    return null;
  }
  // Sign-in on this till (offline too): 5 wrong PINs -> 5 minutes, as before. -> { ok, staff } | { ok:false, message }
  function attemptShopSignin(id, pin){
    const st = one("SELECT * FROM shop_staff WHERE id=? AND active=1 AND here=1",[id]);
    if(!st) return { ok:false, message:"That person can't sign in at this branch." };
    if(st.locked_until && new Date(st.locked_until) > new Date()){
      const mins = Math.max(1, Math.ceil((new Date(st.locked_until) - new Date())/60000));
      return { ok:false, locked:true, message:`Too many incorrect PIN attempts. Try again in ${mins} minute(s).` };
    }
    const bad = pinProblem(pin);
    if(bad) return { ok:false, message:bad };
    const m = staffPinMatches(st, pin);
    if(!m){
      const fails = (Number(st.fail_count)||0)+1;
      if(fails>=PIN_MAX_ATTEMPTS){
        run("UPDATE shop_staff SET fail_count=0, locked_until=? WHERE id=?",[new Date(Date.now()+PIN_LOCKOUT_MINUTES*60000).toISOString(), id]);
        persist();
        return { ok:false, locked:true, message:`Too many incorrect PIN attempts. Try again in ${PIN_LOCKOUT_MINUTES} minutes.` };
      }
      run("UPDATE shop_staff SET fail_count=? WHERE id=?",[fails, id]); persist();
      return { ok:false, message:`Incorrect PIN. ${PIN_MAX_ATTEMPTS-fails} attempt(s) left.` };
    }
    run("UPDATE shop_staff SET fail_count=0, locked_until='' WHERE id=?",[id]);
    _staffSession = { id:st.id, name:st.name, pin:String(pin).trim(), token:null, tokenExp:0, legacy:m.legacy };
    logAudit("Sign in", "", st.name);
    persist();
    staffEnsureToken().catch(()=>{});
    return { ok:true, staff:st };
  }
  // The token, when online (seiGEN checks the PIN too). An old PIN is set again for every till.
  let _tokenTry = null;
  function staffToken(){ return _staffSession && _staffSession.token && _staffSession.tokenExp > Date.now()? _staffSession.token : null; }
  function staffEnsureToken(){
    if(!_staffSession || staffToken() || !isOnline() || !(typeof isTerminalRegistered==="function" && isTerminalRegistered())) return Promise.resolve(staffToken());
    if(_tokenTry) return _tokenTry;
    const s = _staffSession;
    _tokenTry = (async ()=>{
      const r = await terminalRpc("cl_device_staff_signin", Object.assign(terminalAuth(), { p_staff_id:s.id, p_pin:s.pin }), { timeoutMs:20000 });
      if(_staffSession!==s) return null;
      if(!r.ok){ s.tokenProblem = (r.data && r.data.message) || r.message || r.reason; return null; }
      s.token = r.data.token; s.tokenExp = Date.now() + 11.5*3600*1000; s.tokenProblem = "";
      if(r.data.legacy){   // this till's old PIN: set it again, so every till of the branch knows it
        const c = adminCheckMake(s.pin);
        const p = await terminalRpc("cl_device_staff_set_pin", Object.assign(terminalAuth(), { p_staff_token:s.token, p_staff_id:s.id, p_pin:s.pin,
          p_pin_salt:c.salt, p_pin_check:c.check, p_pin_rounds:c.rounds }), { timeoutMs:20000 });
        if(p.ok && p.data && p.data.staff) staffApplyOne(p.data.staff);
        s.legacy = false;
      }
      return s.token;
    })().finally(()=>{ _tokenTry = null; });
    return _tokenTry;
  }
  function staffSignOut(){
    const s = _staffSession;
    _staffSession = null;
    if(s && s.token) terminalRpc("cl_device_staff_signout", Object.assign(terminalAuth(), { p_staff_token:s.token })).catch(()=>{});
  }

  // ---- sync ----
  function staffSyncOn(){ return typeof isTerminalRegistered==="function" && isTerminalRegistered() && !(typeof isTerminalInactive==="function" && isTerminalInactive()); }
  function staffApplyOne(s){
    const old = one("SELECT fail_count, locked_until FROM shop_staff WHERE id=?",[s.id]);
    run(`INSERT OR REPLACE INTO shop_staff(id,name,role_id,home_branch,home_branch_name,branches,active,here,pin_salt,pin_check,pin_rounds,legacy,pins_from_tills,has_pin,seq,fail_count,locked_until)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [s.id, s.name, s.role_id, s.home_branch_id||"", s.home_branch||"", JSON.stringify(s.other_branches||[]), s.active?1:0, s.here?1:0,
       s.pin_salt||"", s.pin_check||"", Number(s.pin_rounds)||0, JSON.stringify(s.legacy||[]), Number(s.pins_from_tills)||0, s.has_pin?1:0, Number(s.seq)||0,
       old? old.fail_count||0 : 0, old? old.locked_until||"" : ""]);
  }
  let _staffPulling = null;
  function staffPull(){
    if(!staffSyncOn() || !isOnline()) return Promise.resolve({ ok:false, offline:!isOnline() });
    if(_staffPulling) return _staffPulling;
    _staffPulling = (async ()=>{
      let r = await terminalRpc("cl_device_staff_pull", terminalAuth(), { timeoutMs:20000 });
      if(!r.ok) return { ok:false, message:(r.data && r.data.message) || r.message || r.code || r.reason };
      if(r.data.upload==="ready" && await staffUploadLegacy()) r = await terminalRpc("cl_device_staff_pull", terminalAuth(), { timeoutMs:20000 });
      if(!r.ok) return { ok:false, message:r.message||r.reason };
      const d = r.data;
      run("DELETE FROM shop_roles");
      (d.roles||[]).forEach(x=> run("INSERT INTO shop_roles(id,name,builtin,rights,seq) VALUES(?,?,?,?,?)",[x.id, x.name, x.builtin||"", JSON.stringify(x.rights||[]), Number(x.seq)||0]));
      const keep = new Set((d.staff||[]).map(s=>s.id));
      all("SELECT id FROM shop_staff").forEach(x=>{ if(!keep.has(x.id)) run("DELETE FROM shop_staff WHERE id=?",[x.id]); });
      (d.staff||[]).forEach(staffApplyOne);
      setSetting("staff_branches", JSON.stringify(d.branches||[]));
      setSetting("shop_has_owner", d.has_owner? "1" : "");
      setSetting("shop_bootstrap", d.bootstrap? "1" : "");
      setSetting("shop_upload", d.upload||"");
      setSetting("staff_pulled_ts", new Date().toISOString());
      // switched off, or no longer at this branch: the session ends (they can't use this till's menus any more)
      if(_staffSession){ const st = shopStaff(_staffSession.id); if(!st || !st.active || !st.here) staffEndSession("Your access at this branch has changed. Sign in again."); }
      await persist();
      return { ok:true, roles:(d.roles||[]).length, staff:(d.staff||[]).length };
    })().finally(()=>{ _staffPulling = null; });
    return _staffPulling;
  }
  // This till's old staff list, once. Only people with a sign-in PIN.
  async function staffUploadLegacy(){
    const rows = all("SELECT * FROM staff WHERE branch=? AND COALESCE(pin_hash,'')<>''",[currentBranch()]);
    const r = await terminalRpc("cl_device_staff_upload", Object.assign(terminalAuth(), { p_staff: rows.map(s=>({ name:s.name, role:s.role, active:!!s.active,
      can_create_customers:Number(s.can_create_customers)===1, pin_salt:s.pin_salt||"", pin_hash:s.pin_hash||"" })) }), { timeoutMs:20000 });
    if(r.ok){ setSetting("staff_uploaded", new Date().toISOString()); logAudit("Staff moved to seiGEN", "", (r.data.added||0)+" added, "+(r.data.merged||0)+" matched"); return true; }
    return false;
  }
  function staffAfterCheckin(){ return staffPull().then(()=> staffEnsureToken()).catch(()=>{}); }
  if(typeof window!=="undefined" && window.addEventListener) window.addEventListener("online", ()=>{ staffEnsureToken().catch(()=>{}); });
  function staffEndSession(msg){
    staffSignOut();
    if(typeof sessionUser!=="undefined"){ sessionUser = ""; }
    if(msg && typeof alert==="function") try{ alert(msg); }catch(e){}
  }

  // ---- saving (online; seiGEN checks the right) ----
  // The first person who manages staff, on a main-branch till while nobody holds Staff: the Admin passcode.
  function staffBootstrapOpen(){ return getSetting("shop_bootstrap","")==="1" && !isRemote(); }
  function staffCanEdit(){ return (!!_staffSession && canStrict("m.staff")) || staffBootstrapOpen(); }
  async function staffSaveRemote(fn, payload, adminPasscode){
    if(!isOnline()) throw new Error("You're offline. Staff and roles are changed on seiGEN: connect, then try again.");
    let token = await staffEnsureToken();
    if(!token){
      if(!staffBootstrapOpen()) throw new Error("Sign in (online) as someone with the Staff right to change staff and roles.");
      if(!findAdmin(adminPasscode)) throw new Error("Enter this till's Admin passcode to add the first person who manages staff.");
    }
    const r = await terminalRpc(fn, Object.assign(terminalAuth(), { p_staff_token:token }, payload), { timeoutMs:20000 });
    if(!r.ok) throw new Error((r.data && r.data.message) || r.message || "Couldn't reach seiGEN.");
    await staffPull();
    return r.data;
  }
  // o: { id?, name, role_id, home_branch_id, other_branches, active, pin? }
  async function saveShopStaff(o, adminPasscode){
    const p = { id:o.id||null, name:o.name, role_id:o.role_id, home_branch_id:o.home_branch_id, other_branches:o.other_branches||[], active:o.active!==false };
    const pin = String(o.pin||"").trim();
    if(pin){
      const bad = pinProblem(pin); if(bad) throw new Error(bad);
      const c = adminCheckMake(pin);
      Object.assign(p, { pin, pin_salt:c.salt, pin_check:c.check, pin_rounds:c.rounds });
    } else if(!o.id) throw new Error(pinProblem(""));
    if(!String(o.name||"").trim()) throw new Error("Enter the person's name.");
    const d = await staffSaveRemote("cl_device_staff_save", { p_staff:p }, adminPasscode);
    logAudit(o.id? "Edit staff" : "Add staff", "", p.name+" · "+((shopRole(p.role_id)||{}).name||""));
    return d.staff;
  }
  // o: { id?, name, rights, delete? }
  async function saveShopRole(o){
    const d = await staffSaveRemote("cl_device_role_save", { p_role:{ id:o.id||null, name:o.name, rights:o.rights||[], delete:!!o.delete } });
    logAudit(o.delete? "Delete role" : o.id? "Edit role" : "Add role", "", o.name||"");
    return d;
  }

  // ---- Settings → Staff & Roles (when this till has seiGEN's staff) ----
  let _staffTab = "people";
  function rightsSummary(rights){
    const m = ROLE_MENU_RIGHTS.filter(r=>rights.includes(r[0])).length, a = ROLE_ACTION_RIGHTS.filter(r=>rights.includes(r[0])).map(r=>r[1]);
    return m+" menu"+(m===1?"":"s")+(a.length? " · "+a.join(", ") : " · no action rights");
  }
  function shopStaffSectionHtml(){
    const single = singleOperatorMode();
    const edit = staffCanEdit();
    const roles = shopRoles(), people = shopStaffAll();
    const pulled = getSetting("staff_pulled_ts","");
    const who = _staffSession? _staffSession.name+(staffToken()? "" : " (not checked by seiGEN yet)") : "";
    return `<div class="card" id="shopStaffCard">
      <h3>Staff & Roles</h3>
      <label style="display:flex;gap:8px;align-items:flex-start;margin-top:0"><input type="checkbox" id="sSingleOperator" ${single? "checked" : ""} style="width:auto;margin-top:3px"><span>Single operator mode — skip staff sign-in, just type a name (today's behaviour)</span></label>
      <p class="muted" style="font-size:12px">Turn this off so everyone signs in with their own PIN. Menus then follow each person's role. Reports of other branches and costs at a remote need a signed-in person with the right.</p>
      <p class="muted" style="font-size:12px;margin:6px 0">Kept on seiGEN for every branch${pulled? " · updated "+escapeHtml(new Date(pulled).toLocaleString()) : ""}. <button type="button" class="btn btn-sm btn-ghost" id="staffRefresh">🔄 Refresh</button></p>
      ${edit? (who? `<p class="muted" style="font-size:12px">Signed in: ${escapeHtml(who)}</p>` : `<p class="box" style="font-size:12.5px">Nobody can manage staff yet. Add the first person here with this till's Admin passcode (an Admin or Owner).</p>`)
            : `<p class="box" style="font-size:12.5px">Sign in as someone with the Staff right to add or change people and roles.</p>`}
      <div class="staff-tabs" style="display:flex;gap:8px;margin:8px 0">
        <button class="btn btn-sm ${_staffTab==="people"? "btn-primary" : "btn-outline"}" id="staffTabPeople" style="width:auto">People (${people.length})</button>
        <button class="btn btn-sm ${_staffTab==="roles"? "btn-primary" : "btn-outline"}" id="staffTabRoles" style="width:auto">Roles (${roles.length})</button>
      </div>
      ${_staffTab==="roles"? `
        ${edit? `<button class="btn btn-primary btn-sm" id="addRole" style="width:auto;margin-bottom:8px">+ New role</button>` : ""}
        ${roles.map(r=>`<div class="product-row role-row">
            <div><div class="pname">${escapeHtml(r.name)}${r.builtin? ` <span class="pill">built in</span>` : ""}</div>
              <div class="pmeta">${r.builtin==="owner"? "Every right, and the Owner-only items" : escapeHtml(rightsSummary(r.rights))} · ${people.filter(p=>p.role_id===r.id && p.active).length} active</div></div>
            <button class="btn btn-sm btn-outline" data-edit-role="${escapeHtml(r.id)}" style="flex:none">${edit && r.builtin!=="owner"? "Edit" : "View"}</button>
          </div>`).join("")}`
      : `
        ${edit? `<button class="btn btn-primary btn-sm" id="addShopStaff" style="width:auto;margin-bottom:8px">+ Add person</button>` : ""}
        ${people.length? people.map(s=>{ const r = shopRole(s.role_id); const others = staffJson(s.branches, []).map(staffBranchName).filter(Boolean);
          return `<div class="product-row staff-row">
            <div><div class="pname">${escapeHtml(s.name)}${s.active? "" : ` <span class="pill low">inactive</span>`}</div>
              <div class="pmeta">${escapeHtml(r? r.name : "?")} · ${escapeHtml(s.home_branch_name||"no branch")}${others.length? " + "+escapeHtml(others.join(", ")) : ""}${s.has_pin? "" : " · No PIN"}${s.pins_from_tills>1? ` · <span style="color:#b54708">Check: ${s.pins_from_tills} PINs from ${s.pins_from_tills} tills (each works on its own till until they sign in there)</span>` : ""}</div></div>
            ${edit? `<button class="btn btn-sm btn-outline" data-edit-shopstaff="${escapeHtml(s.id)}" style="flex:none">Edit</button>` : ""}
          </div>`; }).join("") : `<p class="muted">No staff on seiGEN yet.</p>`}`}
      <div class="muted" id="staffMsg" role="status" style="font-size:12.5px;margin-top:6px"></div>
    </div>`;
  }
  function wireShopStaffSection(container, redraw){
    const $s = (sel)=> container.querySelector(sel);
    $s("#staffTabPeople").onclick = ()=>{ _staffTab = "people"; redraw(); };
    $s("#staffTabRoles").onclick = ()=>{ _staffTab = "roles"; redraw(); };
    $s("#staffRefresh").onclick = async ()=>{ $s("#staffMsg").textContent = "Loading…"; const r = await staffPull(); redraw(); const m = container.querySelector("#staffMsg"); if(m) m.textContent = r.ok? "Up to date." : (r.offline? "You're offline." : "Couldn't load: "+(r.message||"")); };
    const so = $s("#sSingleOperator");
    if(so) so.onchange = ()=>{
      const wantOn = so.checked;
      if(!wantOn && !shopStaffHere().length && !activeStaffWithPin(currentBranch()).length){ alert("Add at least one active person with a PIN at this branch before turning this off."); so.checked = true; return; }
      if(!wantOn && !confirm("Everyone will need to pick their name and enter a PIN to use this device. Continue?")){ so.checked = true; return; }
      setSetting("single_operator_mode", wantOn? "1" : "0"); persist(); redraw();
    };
    const add = $s("#addShopStaff"); if(add) add.onclick = ()=> openShopStaffModal(null, redraw);
    container.querySelectorAll("[data-edit-shopstaff]").forEach(b=> b.onclick = ()=> openShopStaffModal(shopStaff(b.dataset.editShopstaff), redraw));
    const addR = $s("#addRole"); if(addR) addR.onclick = ()=> openRoleModal(null, redraw);
    container.querySelectorAll("[data-edit-role]").forEach(b=> b.onclick = ()=> openRoleModal(shopRole(b.dataset.editRole), redraw));
  }
  function openShopStaffModal(existing, redraw){
    const roles = shopRoles(), brs = staffBranches();
    const myBranch = getSetting("branch_uuid","") || (brs[0]||{}).id || "";
    const home = existing? existing.home_branch : myBranch, others = existing? staffJson(existing.branches, []) : [];
    const ownerOk = canStrict("owner") || staffBootstrapOpen();
    const boot = !_staffSession && staffBootstrapOpen();
    const wrap = openModal(existing? "Edit person" : "Add person", `
      <label style="margin-top:0" for="ssName">Name</label><input class="field" id="ssName" maxlength="60" value="${escapeHtml(existing? existing.name : "")}">
      <label for="ssRole">Role</label>
      <select class="field" id="ssRole">${roles.map(r=>`<option value="${escapeHtml(r.id)}" ${(existing? existing.role_id===r.id : r.builtin==="cashier")? "selected" : ""} ${r.builtin==="owner" && !ownerOk? "disabled" : ""}>${escapeHtml(r.name)}</option>`).join("")}</select>
      <label for="ssHome">Home branch</label>
      <select class="field" id="ssHome">${brs.map(b=>`<option value="${escapeHtml(b.id)}" ${b.id===home? "selected" : ""}>${escapeHtml(b.name)}</option>`).join("")}</select>
      ${brs.length>1? `<label>Also works at</label><div class="ss-others">${brs.map(b=>`<label style="display:flex;gap:8px;align-items:center;margin:4px 0;font-weight:500"><input type="checkbox" data-ss-branch="${escapeHtml(b.id)}" ${others.includes(b.id)? "checked" : ""} style="width:auto;margin:0"> ${escapeHtml(b.name)}</label>`).join("")}</div>` : ""}
      <label for="ssPin">Sign-in PIN (4 to 6 digits)</label>
      <input class="field" id="ssPin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" placeholder="${existing? "Leave blank to keep the PIN" : "e.g. 4821"}">
      ${existing? `<label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" id="ssActive" ${existing.active? "checked" : ""} style="width:auto;margin:0"> Active (switching someone off ends their sign-in on every till)</label>` : ""}
      ${boot? `<label for="ssAdminPass">This till's Admin passcode</label><input class="field" id="ssAdminPass" type="password" autocomplete="off">` : ""}
      <div id="ssMsg" role="alert" style="color:var(--danger);font-weight:600;margin-top:8px"></div>
      <button class="btn btn-primary" id="ssSave" style="margin-top:12px">${existing? "Save" : "Add"}</button>`);
    wrap.querySelector("#ssSave").onclick = async ()=>{
      const btn = wrap.querySelector("#ssSave"), msg = wrap.querySelector("#ssMsg");
      btn.disabled = true; msg.textContent = "";
      try{
        await saveShopStaff({ id:existing? existing.id : null, name:wrap.querySelector("#ssName").value, role_id:wrap.querySelector("#ssRole").value,
          home_branch_id:wrap.querySelector("#ssHome").value, other_branches:[...wrap.querySelectorAll("[data-ss-branch]:checked")].map(x=>x.dataset.ssBranch),
          active: existing? wrap.querySelector("#ssActive").checked : true, pin:wrap.querySelector("#ssPin").value },
          wrap.querySelector("#ssAdminPass")? wrap.querySelector("#ssAdminPass").value : "");
      }catch(e){ msg.textContent = e.message||String(e); btn.disabled = false; return; }
      wrap.remove(); redraw();
    };
    return wrap;
  }
  function openRoleModal(existing, redraw){
    const fixed = existing && existing.builtin==="owner";
    const edit = staffCanEdit() && !!_staffSession && !fixed;
    const rights = existing? existing.rights : [];
    const box = (r)=> `<label class="role-right" style="display:flex;gap:8px;align-items:center;margin:3px 0;font-weight:500"><input type="checkbox" data-right="${r[0]}" ${fixed || rights.includes(r[0])? "checked" : ""} ${edit? "" : "disabled"} style="width:auto;margin:0"> ${escapeHtml(r[1])}</label>`;
    const wrap = openModal(existing? (edit? "Edit role: " : "Role: ")+existing.name : "New role", `
      <label style="margin-top:0" for="rlName">Name</label>
      <input class="field" id="rlName" maxlength="40" value="${escapeHtml(existing? existing.name : "")}" ${edit && !(existing && existing.builtin)? "" : "readonly"}>
      ${fixed? `<p class="muted" style="font-size:12.5px">The Owner role always has every right, plus the Owner-only items: licence and billing, adding or removing Owners, deleting a role.</p>` : ""}
      <div class="role-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 16px;margin-top:8px">
        <div><h4 style="margin:6px 0">Menus</h4><p class="muted" style="font-size:11.5px;margin:0 0 4px">A menu without its right is hidden.</p>${ROLE_MENU_RIGHTS.map(box).join("")}</div>
        <div><h4 style="margin:6px 0">Actions</h4><p class="muted" style="font-size:11.5px;margin:0 0 4px">Approvals still take the Admin passcode, or this person's own PIN.</p>${ROLE_ACTION_RIGHTS.map(box).join("")}</div>
      </div>
      <div id="rlMsg" role="alert" style="color:var(--danger);font-weight:600;margin-top:8px"></div>
      ${edit? `<div class="row" style="margin-top:12px">
        ${existing && !existing.builtin? `<button class="btn btn-outline" id="rlDelete" ${canStrict("owner")? "" : `disabled title="Only an Owner may delete a role"`}>Delete role</button>` : ""}
        <button class="btn btn-primary" id="rlSave">${existing? "Save" : "Add role"}</button></div>` : ""}`);
    const save = wrap.querySelector("#rlSave");
    if(save) save.onclick = async ()=>{
      const msg = wrap.querySelector("#rlMsg"); save.disabled = true; msg.textContent = "";
      try{ await saveShopRole({ id:existing? existing.id : null, name:wrap.querySelector("#rlName").value, rights:[...wrap.querySelectorAll("[data-right]:checked")].map(x=>x.dataset.right) }); }
      catch(e){ msg.textContent = e.message||String(e); save.disabled = false; return; }
      wrap.remove(); redraw();
    };
    const del = wrap.querySelector("#rlDelete");
    if(del) del.onclick = async ()=>{
      if(!confirm("Delete the role "+existing.name+"?")) return;
      try{ await saveShopRole({ id:existing.id, name:existing.name, delete:true }); }
      catch(e){ wrap.querySelector("#rlMsg").textContent = e.message||String(e); return; }
      wrap.remove(); redraw();
    };
    return wrap;
  }

  // ---- Report Writer: other branches through seiGEN (§R4) ----
  async function staffBranchReport(kind, branchId, fromTs, toTs){
    if(!isOnline()) return { ok:false, message:"You're offline: other branches' reports come from seiGEN." };
    const token = await staffEnsureToken();
    const r = await terminalRpc("cl_device_branch_report", Object.assign(terminalAuth(), { p_staff_token:token, p_kind:kind, p_branch_id:branchId,
      p_from:fromTs||null, p_to:(toTs && toTs!=="9999")? toTs : null }), { timeoutMs:20000 });
    if(!r.ok) return { ok:false, message:(r.data && r.data.message) || (/PGRST202|could not find the function/i.test(r.message||"")? "Not on seiGEN yet: it comes with the seiGEN update." : r.message || "Couldn't reach seiGEN.") };
    return { ok:true, data:r.data };
  }
  // A DN's unit costs and charge, for a signed-in person with View costs. -> { lines, charge } | null
  async function staffDispatchCosts(id){
    if(!canStrict("costs") || !isOnline()) return null;
    const token = await staffEnsureToken();
    if(!token) return null;
    const r = await terminalRpc("cl_device_dispatch_costs", Object.assign(terminalAuth(), { p_staff_token:token, p_dispatch_id:id }), { timeoutMs:20000 });
    return r.ok? r.data : null;
  }
