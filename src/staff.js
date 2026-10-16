  // ---------------- Staff & Roles (Settings, Main branch only) ----------------
  // Staff Access List + PIN Login: the staff table already existed (for the
  // Admin `passcode` used by Settings/price/cancel-reissue unlocks). This adds
  // a separate 4-6 digit sign-in PIN per staff member, stored as a salted
  // SHA-256 (reusing sha256HexPure from dnfile.js) — never the PIN itself —
  // plus a per-staff attempt counter/lockout. "Tenant" here is this device's
  // `branch`, the same scope every other staff/product/customer row already
  // uses; PIN uniqueness is enforced within that scope.
  const PIN_MIN_LEN=4, PIN_MAX_LEN=6, PIN_MAX_ATTEMPTS=5, PIN_LOCKOUT_MINUTES=5;
  function pinProblem(pin){
    const p = String(pin==null?"":pin).trim();
    if(!p) return `Enter a ${PIN_MIN_LEN} to ${PIN_MAX_LEN} digit PIN.`;
    if(!/^\d+$/.test(p) || p.length<PIN_MIN_LEN || p.length>PIN_MAX_LEN) return `PIN must be ${PIN_MIN_LEN} to ${PIN_MAX_LEN} digits.`;
    return "";
  }
  function hashPinSync(pin, salt){ return sha256HexPure((salt||"")+":"+String(pin).trim()); }
  function pinTakenByOther(branch, pin, excludeId){
    const p = String(pin).trim();
    const rows = all("SELECT id,pin_hash,pin_salt FROM staff WHERE branch=? AND active=1 AND pin_hash<>'' AND id<>?",[branch, excludeId||0]);
    return rows.some(r=> hashPinSync(p, r.pin_salt)===r.pin_hash);
  }
  // On (the default) = today's free-text name entry, unchanged. Off = the
  // dropdown+PIN flow below. Defaults ON so every existing install, and every
  // fresh one until an owner opts in, behaves exactly as before.
  function singleOperatorMode(){ return getSetting("single_operator_mode","1")==="1"; }
  function activeStaffWithPin(branch){ return all("SELECT * FROM staff WHERE branch=? AND active=1 AND pin_hash<>'' ORDER BY name",[branch]); }
  // Who can sign in here: the business's staff from seiGEN once this till has them (roles.js, v28),
  // else this till's own list as before. -> [{ key, name }] ("s:<id>" seiGEN, "l:<id>" this till's).
  function signinChoices(){
    if(typeof rolesSynced==="function" && rolesSynced()) return shopStaffHere().map(s=>({ key:"s:"+s.id, name:s.name }));
    return activeStaffWithPin(currentBranch()).map(s=>({ key:"l:"+s.id, name:s.name }));
  }
  // Queryable current operator (Part 6) — null in Single operator mode, where
  // there's no staff record behind the typed name, only sessionUser.
  function currentStaff(){ return sessionStaffId? one("SELECT * FROM staff WHERE id=?",[sessionStaffId]) : null; }

  // Pure add/edit (no DOM), so staffModal's Save button and the test suite
  // share one validated path. Throws a plain-text Error on any refusal.
  function saveStaffMember(o){
    o = o||{};
    const name = String(o.name||"").trim();
    if(!name) throw new Error("Enter the staff member's name");
    const role = o.role==="Admin"? "Admin" : "Cashier";
    const passcode = String(o.passcode||"").trim();
    const branch = currentBranch();
    const isEdit = !!o.id;
    const existing = isEdit? one("SELECT * FROM staff WHERE id=?",[o.id]) : null;
    if(isEdit && !existing) throw new Error("Staff member not found");
    const pinInput = String(o.pin||"").trim();
    let pin_hash = existing? (existing.pin_hash||"") : "";
    let pin_salt = existing? (existing.pin_salt||"") : "";
    if(pinInput){
      const bad = pinProblem(pinInput);
      if(bad) throw new Error(bad);
      if(pinTakenByOther(branch, pinInput, isEdit? o.id : 0)) throw new Error("That PIN is already used by another active staff member. Choose a different one.");
      pin_salt = uid4()+uid4();
      pin_hash = hashPinSync(pinInput, pin_salt);
    } else if(!isEdit){
      throw new Error(pinProblem(""));
    }
    // Admin passcode from main: on a joined device, giving someone an Admin
    // passcode needs an existing Admin's passcode (the first one comes from main).
    const givesAdmin = role==="Admin" && passcode && !(existing && existing.role==="Admin" && String(existing.passcode||"").trim()===passcode);
    if(givesAdmin && adminComesFromMain()){
      if(!hasAdminPasscode()) throw new Error(ADMIN_FROM_MAIN_TEXT);
      if(!findAdmin(o.adminPasscode)) throw new Error("Enter the current Admin passcode to give someone an Admin passcode on this device.");
    }
    // POS fixes: "Create customers" (Admins always can). Optional on an edit.
    const canCust = o.can_create_customers===undefined? (existing? Number(existing.can_create_customers)||0 : 0) : (o.can_create_customers? 1 : 0);
    if(isEdit){
      // active is optional on an edit — a caller updating just the PIN (or
      // name/role) shouldn't have to know or repeat the current active
      // status; only an explicit true/false changes it.
      const active = o.active===undefined ? existing.active : (o.active? 1 : 0);
      // Any Admin edit also clears a lockout — a deliberate, low-friction way
      // to unlock someone without a separate "unlock" button.
      run("UPDATE staff SET name=?, role=?, passcode=?, active=?, pin_hash=?, pin_salt=?, pin_fail_count=0, pin_locked_until='' WHERE id=?",
        [name,role,passcode,active,pin_hash,pin_salt,o.id]);
      run("UPDATE staff SET can_create_customers=? WHERE id=?",[canCust, o.id]);
      return one("SELECT * FROM staff WHERE id=?",[o.id]);
    }
    run("INSERT INTO staff(name,role,passcode,branch,active,created_ts,pin_hash,pin_salt) VALUES(?,?,?,?,1,?,?,?)",
      [name,role,passcode,branch,new Date().toISOString(),pin_hash,pin_salt]);
    const added = one("SELECT * FROM staff WHERE branch=? ORDER BY id DESC LIMIT 1",[branch]);
    run("UPDATE staff SET can_create_customers=? WHERE id=?",[canCust, added.id]);
    return one("SELECT * FROM staff WHERE id=?",[added.id]);
  }

  function staffSectionHtml(){
    const branch = currentBranch();
    const staffList = all("SELECT * FROM staff WHERE branch=? ORDER BY active DESC, name",[branch]);
    const single = singleOperatorMode();
    return `
      <div class="card">
        <h3>Staff & Roles</h3>
        <label style="display:flex;gap:8px;align-items:flex-start;margin-top:0"><input type="checkbox" id="sSingleOperator" ${single? "checked" : ""} style="width:auto;margin-top:3px"><span>Single operator mode — skip staff sign-in, just type a name (today's behaviour)</span></label>
        <p class="muted" style="font-size:12px">Turn this off so everyone picks their name and enters a PIN on the "Who's working today?" screen instead. Needs at least one active staff member with a PIN set below.</p>
        <div class="hr"></div>
        <button class="btn btn-primary" id="openAddStaff" style="margin-bottom:10px">+ Add Staff</button>
        ${staffList.length===0? `<p class="muted">No staff added yet.</p>` : staffList.map(s=>{
          const locked = s.pin_locked_until && new Date(s.pin_locked_until) > new Date();
          return `
          <div class="product-row">
            <div>
              <div class="pname">${escapeHtml(s.name)}${s.active? "" : ` <span class="pill low">inactive</span>`}</div>
              <div class="pmeta">${escapeHtml(s.role)} · ${s.pin_hash? "PIN set" : "No PIN"}${s.role==="Admin" || Number(s.can_create_customers)===1? " · Creates customers" : ""}${locked? " · Locked out" : ""}</div>
            </div>
            <button class="btn btn-sm btn-outline" data-edit-staff="${s.id}" style="flex:none">Edit</button>
          </div>`;}).join("")}
      </div>`;
  }
  function staffModal(existing){
    const isEdit = !!existing;
    const wrap = openModal(isEdit? "Edit Staff" : "Add Staff", `
      <label style="margin-top:0">Name</label>
      <input class="field" id="stName" value="${escapeHtml(existing? existing.name : "")}">
      <label>Role</label>
      <select class="field" id="stRole">
        <option value="Cashier" ${(!existing||existing.role==="Cashier")?"selected":""}>Cashier</option>
        <option value="Admin" ${(existing&&existing.role==="Admin")?"selected":""}>Admin</option>
      </select>
      <label>Admin passcode</label>
      <input class="field" id="stPasscode" value="${escapeHtml(existing? (existing.passcode||"") : "")}" placeholder="Numeric or text code">
      <p class="muted" style="font-size:11px;margin-top:-4px">Unlocks Settings and price/stock approvals on this device. Only needed for Admins.</p>
      ${adminComesFromMain()? `<label>Current Admin passcode</label>
      <input class="field" id="stAuth" type="password" autocomplete="off" placeholder="Needed to give someone an Admin passcode here">
      <p class="muted" style="font-size:11px;margin-top:-4px">This device's Admin passcode comes from your main branch.</p>` : ""}
      <label>Sign-in PIN (${PIN_MIN_LEN}-${PIN_MAX_LEN} digits)</label>
      <input class="field" id="stPin" type="password" inputmode="numeric" maxlength="${PIN_MAX_LEN}" placeholder="${existing && existing.pin_hash? "Leave blank to keep current PIN" : "e.g. 4821"}">
      <p class="muted" style="font-size:11px;margin-top:-4px">Used on the "Who's working today?" screen when Single operator mode is off.</p>
      <label style="display:flex;align-items:center;gap:8px;margin-top:14px"><input type="checkbox" id="stCanCust" ${existing && (existing.role==="Admin" || Number(existing.can_create_customers)===1)? "checked":""} style="width:auto;margin:0"> Can create customers</label>
      <p class="muted" style="font-size:11px;margin-top:2px">Adds and edits customers, sets their type and credit limit, and sees their address and ID number. Admins always can.</p>
      ${isEdit? `<label style="display:flex;align-items:center;gap:8px;margin-top:14px"><input type="checkbox" id="stActive" ${existing.active? "checked":""} style="width:auto;margin:0"> Active</label>` : ""}
      <button class="btn btn-primary" id="stConfirm" style="margin-top:14px">${isEdit? "Save Changes" : "Add Staff"}</button>
    `);
    wrap.querySelector("#stConfirm").onclick=()=>{
      try{
        saveStaffMember({
          id: isEdit? existing.id : null,
          name: wrap.querySelector("#stName").value,
          role: wrap.querySelector("#stRole").value,
          passcode: wrap.querySelector("#stPasscode").value,
          adminPasscode: wrap.querySelector("#stAuth")? wrap.querySelector("#stAuth").value : "",
          pin: wrap.querySelector("#stPin").value,
          active: isEdit? wrap.querySelector("#stActive").checked : true,
          can_create_customers: wrap.querySelector("#stCanCust").checked,
        });
      }catch(e){ return alert(e.message||String(e)); }
      persist(); wrap.remove(); render();
    };
  }
  function wireStaffSection(){
    document.getElementById("openAddStaff").onclick=()=>staffModal(null);
    document.querySelectorAll("[data-edit-staff]").forEach(b=>{
      b.onclick=()=>{
        const s = one("SELECT * FROM staff WHERE id=?",[+b.dataset.editStaff]);
        staffModal(s);
      };
    });
    const soToggle = document.getElementById("sSingleOperator");
    if(soToggle) soToggle.onchange=()=>{
      const wantOn = soToggle.checked;
      if(!wantOn && activeStaffWithPin(currentBranch()).length===0){
        alert("Add at least one active staff member with a PIN before turning this off.");
        soToggle.checked = true;
        return;
      }
      if(!wantOn && !confirm("Everyone will need to pick their name and enter a PIN to use this device. Continue?")){
        soToggle.checked = true;
        return;
      }
      setSetting("single_operator_mode", wantOn? "1" : "0");
      persist(); render();
    };
  }


  // ---- Start screen + Log out ----
  // The first screen once setup and activation are out of the way (boot,
  // main.js), and where Log out returns to. One job: Sign in, which is the
  // unchanged "Who's working today?" flow below. Shows the brand globe
  // (globe-transparent-*.png, generated by tools/icons/build-icons.js and
  // copied next to index.html by build.js), the shop, branch, and the till
  // code once multi-terminal registration has given one. When the image
  // isn't there — the single-file dist/index.html forwarded on its own —
  // it falls back to the storefront mark drawn inline.
  function renderStart(){
    route="start";
    const shop = getSetting("shop_name","") || "seiGEN Commerce Lite";
    const place = [getSetting("branch_name",""), getSetting("till_code","")].filter(Boolean).join(" · ");
    const mark = ICON_STOREFRONT.replace('width="22" height="22"', 'width="52" height="52"');
    $app.innerHTML = `<div class="center-screen"><div class="setup-card center" id="startCard">
      <img class="start-globe" id="startGlobe" src="globe-transparent-512.png" srcset="globe-transparent-512.png 1x, globe-transparent-1024.png 2x" alt="" width="512" height="512">
      <div class="start-mark" id="startMark" aria-hidden="true" style="display:none">${mark}</div>
      <h2 id="startShop" style="margin:0 0 4px">${escapeHtml(shop)}</h2>
      ${place? `<p class="muted" id="startPlace" style="margin:0">${escapeHtml(place)}</p>` : ""}
      <button class="btn btn-primary" id="startSignIn" style="margin-top:20px">Sign in</button>
      <p class="muted" style="font-size:11.5px;margin:14px 0 0">seiGEN Commerce Lite</p>
    </div></div>`;
    const globe = document.getElementById("startGlobe");
    const showMark = ()=>{ globe.remove(); document.getElementById("startMark").style.display = ""; };
    globe.onerror = showMark;
    if(globe.complete && globe.naturalWidth===0 && globe.getAttribute("src")) showMark();   // already failed before the handler was set
    document.getElementById("startSignIn").onclick = ()=> renderWhoAmI();
  }
  // Top bar Log out. Refused while the cart holds anything (the cart is left
  // exactly as it is). Otherwise ends this session only: the operator is
  // cleared and logged, Settings re-lock, and the app goes back to the Start
  // screen. The shift/EOD, settings, data, activation, the sync worker and
  // the device check-in are all untouched — none of them depends on who is
  // signed in. Returns true when logged out (tests use it).
  const LOGOUT_CART_MESSAGE = "Clear the cart or finish the sale first.";
  function logoutSession(){
    if(cart.length>0){ alert(LOGOUT_CART_MESSAGE); return false; }
    logAudit("Logout", "", sessionUser||"");               // written while sessionUser still names who left
    sessionUser = ""; sessionStaffId = null;
    if(typeof staffSignOut==="function") staffSignOut();   // roles (v28): seiGEN's token ends too
    accessStep=1; accessSelectedStaffId=null; accessPinDigits=""; accessError="";
    settingsUnlocked = false;
    drawerOpen = false;
    if(typeof reqDrawerOpen!=="undefined") reqDrawerOpen = false;
    if(typeof navDrawerOpen!=="undefined") navDrawerOpen = false;
    persist();
    renderStart();
    return true;
  }

  // ---- Who's-working access screen ----
  function renderWhoAmI(){
    route="whoami";
    accessError="";
    if(singleOperatorMode()) return renderSingleOperatorAccess();
    // Safety net: never strand the shop with no way in (e.g. the toggle was
    // flipped on via an imported/merged settings row with no PINs set up yet).
    if(signinChoices().length===0) return renderSingleOperatorAccess();
    accessStep=1; accessSelectedStaffId=null; accessPinDigits="";
    renderStaffAccess();
  }
  function renderSingleOperatorAccess(){
    route="whoami";
    const last = getSetting("last_user","");
    $app.innerHTML = `<div class="center-screen"><div class="setup-card center">
      <h2>Who's working today?</h2>
      <p class="muted">Your name is recorded against sales, stock changes, and discount approvals for this session.</p>
      <input class="field" id="whoName" placeholder="Your name" value="${escapeHtml(last)}" style="text-align:center;font-weight:700">
      <button class="btn btn-primary" id="whoContinue" style="margin-top:14px">Continue</button>
      ${sessionUser? `<button class="btn btn-outline" id="whoCancel" style="margin-top:8px">Cancel</button>` : ""}
    </div></div>`;
    const input = document.getElementById("whoName");
    input.focus();
    document.getElementById("whoContinue").onclick=()=>{
      const name = input.value.trim();
      if(!name) return alert("Enter your name to continue");
      sessionUser = name; sessionStaffId = null;
      if(typeof staffSignOut==="function") staffSignOut();
      setSetting("last_user", name); persist();
      route="pos"; render();
    };
    const cancel = document.getElementById("whoCancel");
    if(cancel) cancel.onclick=()=>{ route="pos"; render(); };
  }
  function renderStaffAccess(){
    route="whoami";
    const staffList = signinChoices();
    if(accessStep===1){
      $app.innerHTML = `<div class="center-screen"><div class="setup-card center">
        <h2>Who's working today?</h2>
        <p class="muted">Pick your name, then enter your PIN.</p>
        <select class="field" id="whoSelect">${staffList.map(s=>`<option value="${escapeHtml(s.key)}">${escapeHtml(s.name)}</option>`).join("")}</select>
        <button class="btn btn-primary" id="whoSelectContinue" style="margin-top:14px">Continue</button>
        ${sessionUser? `<button class="btn btn-outline" id="whoCancel" style="margin-top:8px">Cancel</button>` : ""}
      </div></div>`;
      document.getElementById("whoSelectContinue").onclick=()=>{
        accessSelectedStaffId = document.getElementById("whoSelect").value;
        accessStep=2; accessPinDigits=""; accessError="";
        renderStaffAccess();
      };
      const cancel = document.getElementById("whoCancel");
      if(cancel) cancel.onclick=()=>{ route="pos"; render(); };
      return;
    }
    const pick = staffList.find(s=>s.key===String(accessSelectedStaffId));
    const staffRow = pick? { name:pick.name } : null;
    $app.innerHTML = `<div class="center-screen"><div class="setup-card center">
      <h2>${escapeHtml(staffRow? staffRow.name : "")}</h2>
      <p class="muted">Enter your PIN</p>
      <input class="field" id="whoPin" type="password" inputmode="numeric" maxlength="${PIN_MAX_LEN}" value="${escapeHtml(accessPinDigits)}" style="text-align:center;letter-spacing:6px;font-weight:700">
      ${accessError? `<p class="muted" style="color:#c0392b">${escapeHtml(accessError)}</p>` : ""}
      <div class="row" style="margin-top:14px">
        <button class="btn btn-outline" id="whoBack">Back</button>
        <button class="btn btn-primary" id="whoPinContinue">Unlock</button>
      </div>
      ${sessionUser? `<button class="btn btn-outline" id="whoCancel" style="margin-top:8px">Cancel</button>` : ""}
    </div></div>`;
    const pinInput = document.getElementById("whoPin");
    pinInput.focus();
    pinInput.oninput = ()=>{ accessPinDigits = pinInput.value.replace(/\D/g,"").slice(0,PIN_MAX_LEN); pinInput.value = accessPinDigits; };
    document.getElementById("whoBack").onclick=()=>{ accessStep=1; accessPinDigits=""; accessError=""; renderStaffAccess(); };
    document.getElementById("whoPinContinue").onclick=()=>{
      const key = String(accessSelectedStaffId||"");
      if(typeof staffSignOut==="function") staffSignOut();   // the person before, if any
      const shop = key.startsWith("s:");
      const res = shop? attemptShopSignin(key.slice(2), accessPinDigits) : attemptPinLogin(+key.slice(2), accessPinDigits);
      if(!res.ok){ accessError = res.message; accessPinDigits=""; renderStaffAccess(); return; }
      sessionUser = res.staff.name; sessionStaffId = shop? null : res.staff.id;
      setSetting("last_user", res.staff.name); setSetting("last_staff_id", shop? key : String(res.staff.id));
      persist();
      accessStep=1; accessSelectedStaffId=null; accessPinDigits=""; accessError="";
      route = typeof firstAllowedRoute==="function" && !navAllowed("pos")? firstAllowedRoute() : "pos"; render();
    };
    const cancel = document.getElementById("whoCancel");
    if(cancel) cancel.onclick=()=>{ route="pos"; render(); };
  }
  // Pure PIN check (no DOM): active only, throttled 5 wrong tries per staff
  // member -> 5 minute lockout, cleared on a correct PIN or an Admin edit.
  function attemptPinLogin(staffId, pin){
    const s = one("SELECT * FROM staff WHERE id=? AND active=1",[staffId]);
    if(!s) return { ok:false, message:"That staff member is no longer active." };
    if(s.pin_locked_until && new Date(s.pin_locked_until) > new Date()){
      const mins = Math.max(1, Math.ceil((new Date(s.pin_locked_until) - new Date())/60000));
      return { ok:false, locked:true, message:`Too many incorrect PIN attempts. Try again in ${mins} minute(s).` };
    }
    const bad = pinProblem(pin);
    if(bad) return { ok:false, message:bad };
    const hash = hashPinSync(pin, s.pin_salt);
    if(s.pin_hash && hash===s.pin_hash){
      run("UPDATE staff SET pin_fail_count=0, pin_locked_until='' WHERE id=?",[s.id]);
      persist();
      return { ok:true, staff: one("SELECT * FROM staff WHERE id=?",[s.id]) };
    }
    const fails = (s.pin_fail_count||0)+1;
    if(fails>=PIN_MAX_ATTEMPTS){
      const until = new Date(Date.now()+PIN_LOCKOUT_MINUTES*60000).toISOString();
      run("UPDATE staff SET pin_fail_count=0, pin_locked_until=? WHERE id=?",[until, s.id]);
      persist();
      return { ok:false, locked:true, message:`Too many incorrect PIN attempts. Try again in ${PIN_LOCKOUT_MINUTES} minutes.` };
    }
    run("UPDATE staff SET pin_fail_count=? WHERE id=?",[fails, s.id]);
    persist();
    return { ok:false, message:`Incorrect PIN. ${PIN_MAX_ATTEMPTS-fails} attempt(s) left.` };
  }
  function changeSessionUser(){
    if(singleOperatorMode()){
      const name = prompt("Who's working now?", sessionUser||"");
      if(name && name.trim()){ sessionUser = name.trim(); sessionStaffId = null; setSetting("last_user", sessionUser); persist(); render(); }
      return;
    }
    accessStep=1; accessSelectedStaffId=null; accessPinDigits=""; accessError="";
    renderWhoAmI();
  }


  // ---- device Admin passcode (Phase 4) ----
  // A remote branch creates its OWN first Admin passcode, at Setup or on the locked
  // Settings screen while it has none. It no longer depends on merging a main
  // branch's data file to receive one.
  const ADMIN_PASSCODE_MIN = 4;
  // "" = fine, otherwise the plain reason.
  function adminPasscodeProblem(passcode, confirmText){
    const p = String(passcode==null?"":passcode).trim();
    if(p.length<ADMIN_PASSCODE_MIN) return "The Admin passcode must be at least "+ADMIN_PASSCODE_MIN+" characters.";
    if(p!==String(confirmText==null?"":confirmText).trim()) return "The two passcodes don't match.";
    return "";
  }
  // ---- Admin passcode from the main branch (v21; docs/multi-terminal/admin-passcode-on-join-design.md) ----
  // A device that joined a business with a join code (any till except the
  // main branch's T1, the owner's device that registered the business) can't
  // make its own first Admin passcode: the main branch sets it, and only a
  // check value (passcode-check.js) reaches this device.
  function adminComesFromMain(){
    if(typeof isTerminalRegistered!=="function" || !isTerminalRegistered()) return false;
    return !(getSetting("terminal_is_main","")==="1" && getSetting("till_code","")==="T1");
  }
  const ADMIN_FROM_MAIN_TEXT = "This device's Admin passcode is set by your main branch: on a main-branch till, Settings → Business & Terminals → this till → Set its Admin passcode. Then open this screen while online.";
  const ADMIN_FROM_MAIN_NAME = "Admin (set by main)";
  // The check value from a join answer or a check-in answer. The main branch's
  // passcode becomes THE Admin passcode here: other Admins' own passcodes on
  // this branch are cleared (they keep their sign-in PINs). -> true if stored.
  function storeAdminSeed(seed, via){
    if(!seed || !/^[0-9a-f]{32}$/.test(String(seed.salt||"")) || !/^[0-9a-f]{64}$/.test(String(seed.check||""))) return false;
    const rounds = Number(seed.rounds)||0;
    if(rounds < 100000 || rounds > 2000000) return false;
    const branch = currentBranch();
    const mine = one("SELECT * FROM staff WHERE branch=? AND role='Admin' AND COALESCE(passcode_check,'')<>'' ORDER BY id LIMIT 1",[branch]);
    if(mine && mine.passcode_check===seed.check) return false;          // the same one again
    const cleared = all("SELECT id FROM staff WHERE branch=? AND role='Admin' AND trim(COALESCE(passcode,''))<>''",[branch]).length;
    run("UPDATE staff SET passcode='' WHERE branch=? AND role='Admin'",[branch]);
    if(mine) run("UPDATE staff SET passcode_salt=?, passcode_check=?, passcode_rounds=?, active=1 WHERE id=?",[seed.salt, seed.check, rounds, mine.id]);
    else run("INSERT INTO staff(name,role,passcode,branch,active,created_ts,passcode_salt,passcode_check,passcode_rounds) VALUES(?,?,'',?,1,?,?,?,?)",
      [ADMIN_FROM_MAIN_NAME,"Admin",branch,new Date().toISOString(),seed.salt,seed.check,rounds]);
    _adminMatchCache.clear();
    logAudit("Admin passcode set by main", "", (via==="join"? "With the join code" : "From the main branch")+(cleared? "; "+cleared+" other Admin passcode"+(cleared===1?"":"s")+" on this device cleared" : ""));
    return true;
  }
  function createDeviceAdmin(passcode, confirmText){
    if(adminComesFromMain()) throw new Error(ADMIN_FROM_MAIN_TEXT);
    const bad = adminPasscodeProblem(passcode, confirmText);
    if(bad) throw new Error(bad);
    const branch = currentBranch();
    let name = "Admin", n = 1;
    while(one("SELECT 1 AS x FROM staff WHERE branch=? AND name=?",[branch,name])){ n++; name = "Admin "+n; }
    run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES(?,?,?,?,1,?)",
      [name,"Admin",String(passcode).trim(),branch,new Date().toISOString()]);
    return name;
  }

  // The Admin unlock shared by price edits and stock adjustments: an active Admin whose
  // (non-empty) passcode matches. There is no session unlock - it is typed each time.
  // An Admin set by the main branch has a check value instead of a passcode
  // (about a second to compare on a phone, so a match is remembered this session).
  const _adminMatchCache = new Map();
  function findAdmin(passcode){
    const code = String(passcode==null?"":passcode);
    if(!code.trim()) return null;
    const plain = one("SELECT * FROM staff WHERE role='Admin' AND passcode=? AND passcode<>'' AND active=1",[code]);
    if(plain) return plain;
    if(typeof adminCheckMatches!=="function") return null;
    for(const r of all("SELECT * FROM staff WHERE role='Admin' AND active=1 AND COALESCE(passcode_check,'')<>'' ORDER BY id")){
      const k = r.id+"|"+r.passcode_check+"|"+code;
      if(_adminMatchCache.get(k) || adminCheckMatches(code, r.passcode_salt, r.passcode_check, r.passcode_rounds)){ _adminMatchCache.set(k, true); return r; }
    }
    return null;
  }
