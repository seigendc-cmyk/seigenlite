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
    }));
    if(r.ok){ storeTerminal(r.data); await persist(); }
    return r;
  }
  // Main-branch tills only (the server decides). o: { branchId } or { newBranchName }.
  function issueJoinCode(o){
    return terminalRpc("cl_branch_issue_join_code", Object.assign(terminalAuth(), {
      p_branch_id: o.branchId||null, p_new_branch_name: o.newBranchName||null,
    }));
  }
  function fetchBusinessBranches(){ return terminalRpc("cl_branch_list", terminalAuth()); }
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
    const m = String(r.message||"");
    if(/JOIN_LOCKED/.test(m)) return "Too many wrong codes. Wait an hour, then try again.";
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
      if(r.ok){ logAudit("Joined business", "", "Till "+r.data.till_code+" of "+r.data.branch_name); await persist(); render(); return; }
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
            ${t.id===own? "" : `<button class="btn btn-sm btn-outline" style="flex:none" data-term-active="${t.active? "0" : "1"}" data-term="${escapeHtml(t.id)}">${t.active? "Deactivate" : "Reactivate"}</button>`}
          </div>`; }).join("")
          : `<div class="muted" style="font-size:12.5px">No tills yet</div>`}
      </div>`).join("") || `<p class="muted">No branches yet.</p>`;
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
      btn.disabled = true; btn.textContent = "Getting a code…"; st.textContent = ""; st.style.color = "";
      const r = await issueJoinCode(req);
      btn.disabled = false; btn.textContent = "Get a join code";
      if(!r.ok){ st.textContent = terminalProblemText(r); st.style.color = "var(--danger)"; return; }
      logAudit("Join code issued", "", "For "+r.data.branch_name);
      persist();
      const expires = new Date(r.data.expires_ts).toLocaleString();
      const text = "Join code for "+r.data.branch_name+" ("+(getSetting("shop_name","")||"our business")+"): "+r.data.code+"\nValid until "+expires+". Enter it in seiGEN Commerce Lite → Setup → Join an existing branch, with the business secret phrase.";
      wrap.querySelector("#termAddResult").innerHTML = `
        <div class="device-code" id="termAddCode">${escapeHtml(r.data.code)}</div>
        <p class="muted" style="margin:0 0 8px">For <b>${escapeHtml(r.data.branch_name)}</b>. Use it once, before ${escapeHtml(expires)}. Give it to the new till together with the business secret phrase.</p>
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
