  // ================== Business & Terminals (multi-terminal Phase 1) ==================
  // Which business, branch and till this install is, on Digital Commerce's
  // project. Registration happens once, online; after that the ids live in
  // settings and nothing here is needed to sell. Nothing syncs yet — this
  // phase only establishes identity (see docs/multi-terminal/phase1-plan.md).
  //
  // Server side: supabase/migrations/20261004120000_multi_terminal_identity.sql.
  // Every call is a phrase-checked SECURITY DEFINER RPC (decision 7), the same
  // way cl_device_checkin is called (devicecheckin.js), and carries this
  // install's device_key so the server can tell two devices that happen to
  // share an install ID apart.
  //
  // Settings written on success: business_id, business_name, branch_uuid,
  // terminal_branch_name, terminal_is_main, terminal_id, till_code,
  // terminal_label. branch_id / tenantId() / install_id are untouched:
  // Delivery Note keys, doc_counters and activation depend on them.

  // New installs: 4 characters as before until the Console's activation-code
  // screen is confirmed to accept a longer device code (phase1-plan.md);
  // then flip this to true for 8 characters. Existing installs keep theirs.
  const LONG_INSTALL_ID = false;
  function newInstallId(){ return LONG_INSTALL_ID? uid4()+uid4() : uid4(); }

  // Random, made once per install, never shown. 32 hex characters.
  function deviceKey(){
    let k = getSetting("device_key","");
    if(!k){
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      k = Array.from(b, x=>x.toString(16).padStart(2,"0")).join("");
      setSetting("device_key", k);
    }
    return k;
  }

  function terminalIdentity(){
    return {
      businessId: getSetting("business_id",""), businessName: getSetting("business_name",""),
      branchUuid: getSetting("branch_uuid",""), branchName: getSetting("terminal_branch_name",""),
      isMain: getSetting("terminal_is_main","")==="1",
      terminalId: getSetting("terminal_id",""), tillCode: getSetting("till_code",""), label: getSetting("terminal_label",""),
    };
  }
  function isTerminalRegistered(){ return !!getSetting("terminal_id",""); }
  function storeTerminal(d){
    setSetting("business_id", d.business_id||"");
    setSetting("business_name", d.business_name||"");
    setSetting("branch_uuid", d.branch_id||"");
    setSetting("terminal_branch_name", d.branch_name||"");
    setSetting("terminal_is_main", d.is_main? "1" : "");
    setSetting("terminal_id", d.terminal_id||"");
    setSetting("till_code", d.till_code||"");
    setSetting("terminal_label", d.label||"");
    // Phase 3a: a till that just registered or joined fetches the catalogue straight away
    if(typeof catBackgroundTick==="function") setTimeout(catBackgroundTick, 300);
  }

  // ---- the RPC call ----
  // Resolves to { ok, data } or { ok:false, reason, code?, message? } — never
  // rejects. reason: "offline" | "network" | "rejected" (server raised) |
  // "refused" (server answered { error: CODE }, e.g. a used join code).
  const TERMINAL_RPC_TIMEOUT_MS = 10000;
  // opts.timeoutMs: a shorter limit for calls a cashier waits on (a sale, Phase 3b).
  async function terminalRpc(name, body, opts){
    if(!isOnline()) return { ok:false, reason:"offline" };
    let timer = null;
    try{
      const ctrl = (typeof AbortController!=="undefined")? new AbortController() : null;
      if(ctrl) timer = setTimeout(()=>ctrl.abort(), (opts && opts.timeoutMs) || TERMINAL_RPC_TIMEOUT_MS);
      const res = await fetch(DC_SUPABASE_URL+"/rest/v1/rpc/"+name, {
        method:"POST", headers:{ "apikey": DC_ANON_KEY, "Content-Type":"application/json" },
        signal: ctrl? ctrl.signal : undefined, body: JSON.stringify(body),
      });
      const text = await res.text();
      let data = null; try{ data = JSON.parse(text); }catch(e){}
      if(!res.ok) return { ok:false, reason:"rejected", message: String((data && data.message) || text || ("HTTP "+res.status)).slice(0,200) };
      if(data && data.error) return { ok:false, reason:"refused", code:data.error, data };
      return { ok:true, data };
    }catch(e){ return { ok:false, reason:"network" }; }
    finally{ if(timer) clearTimeout(timer); }
  }
  // What every device RPC is authenticated with.
  function terminalAuth(phrase){
    return { p_install_id: getSetting("install_id",""), p_secret_phrase: phrase==null? getSetting("secret_phrase","") : phrase, p_device_key: deviceKey() };
  }

  // Main device: creates the business, its main branch and this till (T1). Idempotent.
  async function registerMainBranch(label){
    const r = await terminalRpc("cl_branch_register", Object.assign(terminalAuth(), {
      p_business_name: getSetting("shop_name",""), p_branch_name: getSetting("branch_name","") || currentBranch(),
      p_legacy_branch_id: getBranchId(), p_label: label||null, p_device_code: currentDeviceCode(),
    }));
    if(r.ok){ storeTerminal(r.data); await persist(); }
    return r;
  }
  // New till or existing remote device: links this install to the code's business.
  //   o: { phrase (the business phrase as typed), code, label, expectedBranchName?, devicePhrase?, legacyBranchId? }
  async function joinBusiness(o){
    const auth = terminalAuth(o.phrase);
    const r = await terminalRpc("cl_terminal_join", Object.assign(auth, {
      p_join_code: o.code, p_label: o.label||null, p_legacy_branch_id: o.legacyBranchId||null,
      p_device_phrase: o.devicePhrase||null, p_device_code: getSetting("install_date","")? currentDeviceCode() : null,
      p_business_name: getSetting("shop_name","")||null, p_expected_branch_name: o.expectedBranchName||null,
      p_app_build: (typeof APP_BUILD!=="undefined")? APP_BUILD : null,   // v21: the server refuses an app before v21 (it would ignore the Admin passcode)
    }));
    if(r.ok){ storeTerminal(r.data); await persist(); }
    return r;
  }
  // Main-branch tills only (the server decides). o: { branchId } or { newBranchName }, and
  // seed: the new device's Admin passcode check value (adminCheckMake, passcode-check.js; v21).
  function issueJoinCode(o){
    const seed = o.seed||{};
    return terminalRpc("cl_branch_issue_join_code", Object.assign(terminalAuth(), {
      p_branch_id: o.branchId||null, p_new_branch_name: o.newBranchName||null,
      p_admin_salt: seed.salt||null, p_admin_check: seed.check||null, p_admin_rounds: seed.rounds||null,
    }));
  }
  // v21: a main-branch till sets another till's Admin passcode (its check value; delivered at that till's next check-in).
  function setTerminalAdmin(terminalId, seed){
    return terminalRpc("cl_terminal_admin_set", Object.assign(terminalAuth(), {
      p_terminal_id: terminalId, p_admin_salt: seed.salt, p_admin_check: seed.check, p_admin_rounds: seed.rounds,
    }));
  }
  function fetchBusinessBranches(){ return terminalRpc("cl_branch_list", terminalAuth()); }
  // Billing-B: seiGEN merged this till's business into another (staff fixing a
  // business registered twice). A check-in reports the new business; the
  // till then takes its new identity from the branch list: business, whether
  // its branch is still main (a merged branch isn't, so it becomes a remote
  // branch here too), and a full catalogue pull from the start. -> changed?
  async function terminalFollowBusiness(bizId){
    bizId = String(bizId||"");
    if(!bizId || !isTerminalRegistered() || getSetting("business_id","")===bizId) return false;
    const r = await fetchBusinessBranches();
    if(!r.ok || !r.data || String(r.data.business_id||"")!==bizId) return false;
    const mine = (r.data.branches||[]).find(b=>b.id===getSetting("branch_uuid",""));
    if(!mine) return false;
    const wasName = getSetting("business_name",""), wasMain = getSetting("terminal_is_main","")==="1";
    setSetting("business_id", bizId);
    setSetting("business_name", r.data.business_name||"");
    setSetting("terminal_branch_name", mine.name||"");
    setSetting("terminal_is_main", mine.is_main? "1" : "");
    setSetting("cat_cursor", "0");                                   // the whole catalogue of the business, from the start
    setSetting("ds_branches", JSON.stringify((r.data.branches||[]).map(b=>({ id:b.id, name:b.name, is_main:!!b.is_main }))));
    setSetting("ds_branches_ts", new Date().toISOString());
    if(wasMain && !mine.is_main) setSetting("branch_type", "remote");
    if(!wasMain && mine.is_main) setSetting("branch_type", "main");   // the merge undone: main again
    logAudit("Business changed on seiGEN", "", "Now "+(mine.is_main? "the main branch" : "a branch")+" ("+(mine.name||"")+") of "+(r.data.business_name||"")+(wasName? "; was "+wasName : ""));
    await persist();
    return true;
  }
  // Main-branch tills only, never their own row (the server decides).
  function setTerminalActive(terminalId, active){
    return terminalRpc("cl_terminal_set_active", Object.assign(terminalAuth(), { p_terminal_id: terminalId, p_active: !!active }));
  }
  // Phase 2: set from check-in's terminal_active, or a TERMINAL_INACTIVE refusal.
  function isTerminalInactive(){ return getSetting("terminal_inactive","")==="1"; }
  const TERMINAL_INACTIVE_TEXT = "This till was deactivated by your main branch. Selling still works. Ask main to reactivate it.";
  function noteTerminalRefusal(r){ if(r && r.code==="TERMINAL_INACTIVE") setSetting("terminal_inactive", "1"); }

  // Plain-English line for any failed call.
  function terminalProblemText(r, ctx){
    r = r||{}; ctx = ctx||{};
    if(r.reason==="offline") return "Connect to the internet once to register this terminal. Selling offline still works as usual.";
    if(r.reason==="network") return "Couldn't reach Digital Commerce. Check the internet connection and try again.";
    const c = r.code;
    if(c==="JOIN_CODE_INVALID") return "That code isn't right. Check it with your main branch (it looks like ABCD-EFGH).";
    if(c==="JOIN_CODE_USED") return "That code has already been used. Ask your main branch for a new one.";
    if(c==="JOIN_CODE_EXPIRED") return "That code has expired. Ask your main branch for a new one.";
    if(c==="PHRASE_MISMATCH") return "That secret phrase doesn't match this business. Check it with your main branch.";
    if(c==="BRANCH_NAME_MISMATCH") return "The branch name doesn't match: this code is for \""+((r.data&&r.data.branch_name)||"another branch")+"\", but this device's branch is \""+(ctx.ownBranchName||currentBranch())+"\". Ask your main branch to check the branch name. Your code can still be used.";
    if(c==="ALREADY_JOINED") return "This device is already a till in another branch.";
    if(c==="OTHER_BUSINESS") return "This device already belongs to a different business.";
    if(c==="TERMINAL_INACTIVE") return TERMINAL_INACTIVE_TEXT;
    if(c==="ADMIN_SEED_MISSING") return "Update the main branch till first. This join code came from an older version of the app on the main branch, so it can't set this device's Admin passcode. Update the main till, then get a new join code.";
    if(c==="DUPLICATE_BUSINESS"){   // Billing-B: one business per name and phrase
      const d = r.data||{};
      return (d.business_name||"This business")+" is already registered on seiGEN from another device"+(d.main_branch? " (main branch: "+d.main_branch+")" : "")+
        ". If this device is another branch or till of it, join with a join code from that device instead: Settings → Business & Terminals → Add a terminal. Registering it again would bill it as a separate shop.";
    }
    const m = String(r.message||"");
    if(/JOIN_LOCKED/.test(m)) return "Too many wrong codes. Wait an hour, then try again.";
    if(/UPDATE_MAIN_FIRST/.test(m)) return "Update the main branch till first.";
    if(/APP_UPDATE_NEEDED/.test(m)) return "Update this app first, then join again. Your join code is still valid.";
    if(/ADMIN_SEED_INVALID/.test(m)) return "That Admin passcode couldn't be prepared. Try again.";
    if(/sets its own Admin passcode/i.test(m)) return "This till's own Admin passcode is set in Settings → Staff.";
    if(/can set a till's Admin passcode/i.test(m)) return "Only an active till on the main branch can set another till's Admin passcode.";
    if(/PLAN_BRANCH_LIMIT/.test(m)) return m.replace(/^.*PLAN_BRANCH_LIMIT:\s*/, "");   // price plans: Lite allows one branch
    if(/secret phrase does not match/i.test(m)) return "This device's activation phrase doesn't match what Digital Commerce has. Check it in Settings → Activation secret phrase.";
    if(/registered to another device/i.test(m)) return "Digital Commerce has this install ID registered to another device. Contact Digital Commerce to re-admit this device.";
    if(/cannot deactivate itself/i.test(m)) return "A till can't deactivate itself. Use another till on the main branch.";
    if(/Terminal not found in this business/i.test(m)) return "That till isn't part of this business any more. Refresh the list.";
    if(/can change terminals/i.test(m)) return "Only an active till on the main branch can deactivate or reactivate tills.";
    if(/main-branch terminal/i.test(m)) return "Only a till on the main branch can add terminals.";
    if(/not the main branch|already linked to a business/i.test(m)) return "This device already belongs to a branch. It can't register a new business.";
    return "Digital Commerce couldn't do that ("+(m||"unknown reason")+"). Try again, or contact Digital Commerce.";
  }
  function formatJoinCode(s){ const c = String(s||"").toUpperCase().replace(/[^A-Z0-9]/g,""); return c.length>4? c.slice(0,4)+"-"+c.slice(4,8) : c; }

  // ---- Settings card ----
  function terminalSectionHtml(){
    const id = terminalIdentity();
    const remote = isRemote();
    const status = `<p class="muted" id="termStatus" style="font-size:12.5px;margin:8px 0 0"></p>`;
    if(!isTerminalRegistered()){
      return `
      <div class="card" id="terminalCard" data-registered="0">
        <h3>Business &amp; Terminals</h3>
        ${isTerminalInactive()? `<p class="term-inactive" style="color:var(--danger);font-weight:600">${escapeHtml(TERMINAL_INACTIVE_TEXT)}</p>` : `
        <p class="muted">Not registered yet. Registering links this device to your business on Digital Commerce, so more tills can join it later. It needs the internet once; selling offline works either way.</p>
        ${remote? `
          <p class="muted" style="margin-top:6px">This is a remote branch. Ask your main branch for a join code (Settings → Business &amp; Terminals → Add a terminal on the main branch's device).</p>
          <label>Business secret phrase</label>
          <input class="field" id="termJoinPhrase" autocomplete="off" placeholder="The main branch's activation phrase">
          <label>Join code</label>
          <input class="field" id="termJoinCode" autocomplete="off" placeholder="ABCD-EFGH" style="letter-spacing:2px;text-transform:uppercase">
          <button class="btn btn-primary" id="termJoinBtn" style="margin-top:12px">Join your business</button>`
        : `<button class="btn btn-primary" id="termRegisterBtn" style="margin-top:8px">Register this branch</button>`}`}
        ${status}
      </div>`;
    }
    const inactive = isTerminalInactive();
    return `
      <div class="card" id="terminalCard" data-registered="1"${inactive? ` data-inactive="1"` : ""}>
        <h3>Business &amp; Terminals</h3>
        <table class="simple">
          <tr><td class="muted">Business</td><td>${escapeHtml(id.businessName||"—")}</td></tr>
          <tr><td class="muted">Branch</td><td>${escapeHtml(id.branchName||currentBranch())}${id.isMain? ` <span class="pill">Main</span>` : ""}</td></tr>
          <tr><td class="muted">Till</td><td><b id="termTill">${escapeHtml(id.tillCode)}</b>${id.label? " · "+escapeHtml(id.label) : ""}</td></tr>
          <tr><td class="muted">Terminal ID</td><td style="font-size:11.5px;word-break:break-all">${escapeHtml(id.terminalId)}</td></tr>
          <tr><td class="muted">Status</td><td>${inactive? `<span class="pill low">Deactivated</span>` : `<span class="pill ok">Registered</span>`}</td></tr>
        </table>
        ${inactive? `<p class="term-inactive" style="color:var(--danger);font-weight:600;margin:10px 0 0">${escapeHtml(TERMINAL_INACTIVE_TEXT)}</p>` : ""}
        ${id.isMain && !inactive? `
          <button class="btn btn-primary" id="termAddBtn" style="margin-top:12px">+ Add a terminal</button>
          <div class="hr"></div>
          <h4 style="margin:0 0 6px">Terminals</h4>
          <div id="termList"><p class="muted">Loading…</p></div>` : ""}
        ${typeof catalogueSyncCardHtml==="function"? catalogueSyncCardHtml() : ""}
        ${status}
      </div>`;
  }
  function setTermStatus(text, bad){
    const el = document.getElementById("termStatus");
    if(el){ el.textContent = text||""; el.style.color = bad? "var(--danger)" : ""; }
  }
  function wireTerminalSection(){
    const reg = document.getElementById("termRegisterBtn");
    if(reg) reg.onclick = async ()=>{
      reg.disabled = true; reg.textContent = "Registering…"; setTermStatus("");
      const r = await registerMainBranch(null);
      if(r.ok){ logAudit("Branch registered", "", "Till "+r.data.till_code+" of "+r.data.branch_name); await persist(); render(); return; }
      noteTerminalRefusal(r);
      if(r.code==="TERMINAL_INACTIVE"){ await persist(); render(); return; }
      reg.disabled = false; reg.textContent = "Register this branch";
      setTermStatus(terminalProblemText(r), true);
    };
    const join = document.getElementById("termJoinBtn");
    if(join) join.onclick = async ()=>{
      const phrase = document.getElementById("termJoinPhrase").value.trim();
      const code = formatJoinCode(document.getElementById("termJoinCode").value);
      if(!phrase || !code) return setTermStatus("Enter the business secret phrase and the join code.", true);
      join.disabled = true; join.textContent = "Joining…"; setTermStatus("");
      const own = getSetting("branch_name","") || currentBranch();
      const r = await joinBusiness({ phrase, code, expectedBranchName: own, devicePhrase: getSetting("secret_phrase",""), legacyBranchId: getBranchId() });
      if(r.ok){ logAudit("Joined business", "", "Till "+r.data.till_code+" of "+r.data.branch_name); if(typeof storeAdminSeed==="function") storeAdminSeed(r.data.admin_seed, "join"); await persist(); render(); return; }
      noteTerminalRefusal(r);
      if(r.code==="TERMINAL_INACTIVE"){ await persist(); render(); return; }
      join.disabled = false; join.textContent = "Join your business";
      setTermStatus(terminalProblemText(r, { ownBranchName: own }), true);
    };
    const add = document.getElementById("termAddBtn");
    if(add) add.onclick = ()=> openAddTerminalModal();
    if(document.getElementById("termList")) loadTerminalList();
    if(typeof wireCatalogueSyncCard==="function") wireCatalogueSyncCard();
  }
  async function loadTerminalList(){
    const r = await fetchBusinessBranches();
    const box = document.getElementById("termList");
    if(!box) return;                                   // left the screen meanwhile
    if(!r.ok){ box.innerHTML = `<p class="muted">${escapeHtml(terminalProblemText(r))}</p>`; return; }
    const branches = r.data.branches||[];
    const own = getSetting("terminal_id","");
    const byId = {};
    box.innerHTML = branches.map(b=>`
      <div style="margin-bottom:8px" data-term-branch="${escapeHtml(b.name)}">
        <div style="font-weight:700">${escapeHtml(b.name)}${b.is_main? ` <span class="pill">Main</span>` : ""}</div>
        ${(b.terminals||[]).length? (b.terminals||[]).map(t=>{ byId[t.id] = { till:t.till_code, branch:b.name };
          return `<div class="term-row" data-term-id="${escapeHtml(t.id)}" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:2px 0">
            <span class="muted" style="font-size:12.5px">${escapeHtml(t.till_code)}${t.label? " · "+escapeHtml(t.label) : ""}${t.last_seen_ts? " · last seen "+escapeHtml(new Date(t.last_seen_ts).toLocaleString()) : ""}${t.active? "" : ` · <b style="color:var(--danger)">deactivated</b>`}${t.id===own? " · this till" : ""}</span>
            ${t.id===own? "" : `<span style="display:flex;gap:6px;flex:none">${t.active? `<button class="btn btn-sm btn-outline" data-term-admin="${escapeHtml(t.id)}">Set its Admin passcode</button>` : ""}<button class="btn btn-sm btn-outline" data-term-active="${t.active? "0" : "1"}" data-term="${escapeHtml(t.id)}">${t.active? "Deactivate" : "Reactivate"}</button></span>`}
          </div>`; }).join("")
          : `<div class="muted" style="font-size:12.5px">No tills yet</div>`}
      </div>`).join("") || `<p class="muted">No branches yet.</p>`;
    box.querySelectorAll("[data-term-admin]").forEach(btn=>btn.onclick = ()=> openSetTerminalAdminModal(btn.dataset.termAdmin, byId[btn.dataset.termAdmin] || { till:"that till", branch:"" }));
    box.querySelectorAll("[data-term]").forEach(btn=>btn.onclick = async ()=>{
      const t = byId[btn.dataset.term] || { till:"this till", branch:"" }, active = btn.dataset.termActive==="1";
      const label = t.till+(t.branch? " ("+t.branch+")" : "");
      if(!active && !confirm("Deactivate "+t.till+"? It can still sell offline, but it can't add itself to the business again until reactivated.")) return;
      btn.disabled = true; btn.textContent = active? "Reactivating…" : "Deactivating…"; setTermStatus("");
      const res = await setTerminalActive(btn.dataset.term, active);
      if(!res.ok){ btn.disabled = false; btn.textContent = active? "Reactivate" : "Deactivate"; setTermStatus(terminalProblemText(res), true); return; }
      logAudit(active? "Till reactivated" : "Till deactivated", "", label);
      await persist();
      setTermStatus((active? "Reactivated " : "Deactivated ")+label+".");
      loadTerminalList();
    });
  }
  // v21: the main till's Admin sets the other device's Admin passcode. Only its
  // check value (passcode-check.js) goes to seiGEN, never the passcode.
  function adminSeedFormHtml(idp, forWhat){
    return `
      <label>Your Admin passcode (this till)</label>
      <input class="field" id="${idp}Main" type="password" autocomplete="off" placeholder="To confirm it's you">
      <label>Admin passcode for ${escapeHtml(forWhat)} (at least ${ADMIN_SEED_PASSCODE_MIN} characters)</label>
      <input class="field" id="${idp}New" type="password" autocomplete="new-password" placeholder="Choose a passcode">
      <label>Repeat it</label>
      <input class="field" id="${idp}New2" type="password" autocomplete="new-password" placeholder="Repeat it">
      <p class="muted" style="font-size:12px;margin-top:4px">It unlocks Settings, prices and stock changes on that device. Tell it only to the person who runs that till. seiGEN never sees the passcode itself.</p>`;
  }
  // -> { seed } or { error }
  function adminSeedFromForm(root, idp){
    const v = (id)=> (root.querySelector("#"+idp+id)||{}).value||"";
    if(!hasAdminPasscode()) return { error:"Set an Admin passcode for this till first: Settings → Staff." };
    if(!findAdmin(v("Main"))) return { error:"Incorrect Admin passcode for this till." };
    const bad = adminSeedPasscodeProblem(v("New"), v("New2"));
    if(bad) return { error:bad };
    return { seed: adminCheckMake(v("New")) };
  }
  // v21: set (or reset) another till's Admin passcode; that till picks it up at its next check-in.
  function openSetTerminalAdminModal(terminalId, t){
    const label = t.till+(t.branch? " ("+t.branch+")" : "");
    const wrap = openModal("Set its Admin passcode", `
      <p class="muted" style="margin:0 0 8px">For <b>${escapeHtml(label)}</b>. It replaces any Admin passcode on that device, and reaches it the next time it is online.</p>
      ${adminSeedFormHtml("termSet", label)}
      <button class="btn btn-primary" id="termSetGo" style="margin-top:12px">Set the Admin passcode</button>
      <p class="muted" id="termSetStatus" style="font-size:12.5px;margin-top:8px"></p>`);
    const go = wrap.querySelector("#termSetGo"), st = wrap.querySelector("#termSetStatus");
    go.onclick = async ()=>{
      go.disabled = true; go.textContent = "Preparing…"; st.textContent = ""; st.style.color = "";
      await new Promise((res)=> setTimeout(res, 30));
      const f = adminSeedFromForm(wrap, "termSet");
      const fail = (text)=>{ go.disabled = false; go.textContent = "Set the Admin passcode"; st.textContent = text; st.style.color = "var(--danger)"; };
      if(f.error) return fail(f.error);
      go.textContent = "Sending…";
      const r = await setTerminalAdmin(terminalId, f.seed);
      if(!r.ok) return fail(terminalProblemText(r));
      logAudit("Admin passcode set for a till", "", label);
      persist();
      wrap.querySelector(".modal-body").innerHTML = `<div class="box" id="termSetDone"><b>Set for ${escapeHtml(label)}.</b> It takes effect there at its next check-in (open the app there while online). Tell the passcode to the person who runs that till yourself.</div>`;
    };
  }
  // Main: pick which branch the new till is for, get a one-time code.
  function openAddTerminalModal(){
    const own = getSetting("terminal_branch_name","") || currentBranch();
    const others = (typeof branchDestinations==="function"? branchDestinations() : []).map(b=>b.name).filter(n=>!sameBranchName(n, own));
    const wrap = openModal("Add a terminal", `
      <p class="muted" style="margin:0 0 8px">Which branch is the new till for?</p>
      <select class="field" id="termAddBranch">
        <option value="__own">${escapeHtml(own)} (this branch)</option>
        ${others.map(n=>`<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}
        <option value="__new">A new branch…</option>
      </select>
      <input class="field" id="termAddNewName" placeholder="New branch name" style="display:none;margin-top:8px">
      ${adminSeedFormHtml("termAdd", "the new device")}
      <button class="btn btn-primary" id="termAddIssue" style="margin-top:12px">Get a join code</button>
      <p class="muted" id="termAddStatus" style="font-size:12.5px;margin-top:8px"></p>
      <div id="termAddResult"></div>`);
    const sel = wrap.querySelector("#termAddBranch"), nn = wrap.querySelector("#termAddNewName");
    sel.onchange = ()=>{ nn.style.display = sel.value==="__new"? "block" : "none"; };
    const btn = wrap.querySelector("#termAddIssue"), st = wrap.querySelector("#termAddStatus");
    btn.onclick = async ()=>{
      const v = sel.value;
      const req = v==="__own"? { branchId: getSetting("branch_uuid","") } : { newBranchName: v==="__new"? nn.value.trim() : v };
      if(req.newBranchName!==undefined && !req.newBranchName){ st.textContent = "Enter the new branch's name."; st.style.color="var(--danger)"; return; }
      btn.disabled = true; btn.textContent = "Preparing…"; st.textContent = ""; st.style.color = "";
      await new Promise((res)=> setTimeout(res, 30));                // let "Preparing…" show: the check value takes a moment
      const f = adminSeedFromForm(wrap, "termAdd");
      if(f.error){ btn.disabled = false; btn.textContent = "Get a join code"; st.textContent = f.error; st.style.color = "var(--danger)"; return; }
      req.seed = f.seed;
      btn.textContent = "Getting a code…";
      const r = await issueJoinCode(req);
      btn.disabled = false; btn.textContent = "Get a join code";
      if(!r.ok){ st.textContent = terminalProblemText(r); st.style.color = "var(--danger)"; return; }
      logAudit("Join code issued", "", "For "+r.data.branch_name+", with its Admin passcode");
      ["termAddMain","termAddNew","termAddNew2"].forEach(id=>{ const el = wrap.querySelector("#"+id); if(el) el.value = ""; });
      persist();
      const expires = new Date(r.data.expires_ts).toLocaleString();
      const text = "Join code for "+r.data.branch_name+" ("+(getSetting("shop_name","")||"our business")+"): "+r.data.code+"\nValid until "+expires+". Enter it in seiGEN Commerce Lite → Setup → Join an existing branch, with the business secret phrase.";
      wrap.querySelector("#termAddResult").innerHTML = `
        <div class="device-code" id="termAddCode">${escapeHtml(r.data.code)}</div>
        <p class="muted" style="margin:0 0 8px">For <b>${escapeHtml(r.data.branch_name)}</b>. Use it once, before ${escapeHtml(expires)}. Give it to the new till together with the business secret phrase. The Admin passcode you chose goes with it: tell it to the person who runs that till yourself (it isn't in the message).</p>
        <div class="row">
          <button class="btn btn-outline" id="termCopyCode">Copy</button>
          <button class="btn btn-ghost" id="termShareCode">📲 Share on WhatsApp</button>
        </div>`;
      wrap.querySelector("#termCopyCode").onclick = async (e)=>{
        try{ await navigator.clipboard.writeText(r.data.code); e.currentTarget.textContent = "Copied"; }
        catch(err){ e.currentTarget.textContent = "Copy failed — write it down"; }
      };
      wrap.querySelector("#termShareCode").onclick = ()=> openExternalUrl(waLink("", text));
      loadTerminalList();
    };
  }
