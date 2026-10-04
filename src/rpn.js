  // ================== RPN linkage + Support handoff ==================
  // The first real feature built on the sync.js foundation (sync_queue /
  // registerSyncType / enqueueSync / runSyncWorker) — see sync.js's own
  // header comment for the general pattern this follows. No parallel queue,
  // no parallel connectivity check: every "sync" action below is just an
  // enqueueSync() call, and status is read back through pendingSyncCount()
  // the same way the Cloud sync Settings card already does.
  //
  // Local storage reuses the existing `settings` key-value table — the same
  // place shop_name/contact_phone/management_whatsapp/etc.
  // already live — rather than a new table: RPN linkage is exactly the same
  // shape of thing (a handful of single-value fields describing this
  // device/tenant), so there was nothing to add to db.js's schema.
  // Paused (multi-terminal Phase 1, approved 2026-10-04): neither table
  // exists on Digital Commerce's project and nothing there reads them, so
  // every queued row failed forever. The RPN details are still saved in
  // settings and Support still opens WhatsApp; nothing is queued. See
  // docs/multi-terminal/phase1-plan.md §1E.
  registerSyncType("rpn_link", { table:"rpn_link", paused:true });
  registerSyncType("support_task", { table:"support_task", paused:true });

  function getRpnLink(){
    return {
      rpn_name: getSetting("rpn_name",""),
      rpn_code: getSetting("rpn_code",""),
      rpn_whatsapp: getSetting("rpn_whatsapp",""),
      city_area: getSetting("rpn_city_area",""),
    };
  }
  function hasRpnLink(){
    const r = getRpnLink();
    return !!(r.rpn_name || r.rpn_code || r.rpn_whatsapp || r.city_area);
  }
  // Writes the local record and enqueues a fresh sync every time it's
  // called — covers both "first captured at onboarding" and "edited later
  // from Settings" (Part A.4/A.5) with the one function. No validation
  // against any central registry (foundation data only) — stored as typed.
  function saveRpnLink(fields){
    fields = fields||{};
    const rpn_name = String(fields.rpn_name||"").trim();
    const rpn_code = String(fields.rpn_code||"").trim();
    const rpn_whatsapp = String(fields.rpn_whatsapp||"").trim();
    const city_area = String(fields.city_area||"").trim();
    setSetting("rpn_name", rpn_name);
    setSetting("rpn_code", rpn_code);
    setSetting("rpn_whatsapp", rpn_whatsapp);
    setSetting("rpn_city_area", city_area);
    const updated_ts = new Date().toISOString();
    setSetting("rpn_updated_ts", updated_ts);
    enqueueSync("rpn_link", { rpn_name, rpn_code, rpn_whatsapp, city_area, updated_ts });
    return getRpnLink();
  }

  // Plain input fields, reused by both the Setup wizard (Part A.1, "first-
  // time onboarding") and the Settings card (Part A.1, "editable
  // afterward") — one definition of what an RPN record looks like on
  // screen, matching how e.g. staff.js's rpnFieldsHtml-equivalent pattern
  // (see staffModal) keeps one field layout for add/edit.
  function rpnFieldsHtml(prefix, v){
    v = v||{};
    return `
      <label style="margin-top:0">RPN name</label>
      <input class="field" id="${prefix}Name" value="${escapeHtml(v.rpn_name||"")}" placeholder="e.g. Tendai Moyo">
      <label>RPN code</label>
      <input class="field" id="${prefix}Code" value="${escapeHtml(v.rpn_code||"")}" placeholder="e.g. RPN-014">
      <label>RPN WhatsApp number</label>
      <input class="field" id="${prefix}Wa" inputmode="tel" value="${escapeHtml(v.rpn_whatsapp||"")}" placeholder="e.g. 0771234567">
      <label>City / area serviced</label>
      <input class="field" id="${prefix}City" value="${escapeHtml(v.city_area||"")}" placeholder="e.g. Harare CBD">
    `;
  }
  function rpnFieldsFromInputs(prefix){
    const val = (id)=>{ const el=document.getElementById(id); return el? el.value : ""; };
    return { rpn_name: val(prefix+"Name"), rpn_code: val(prefix+"Code"), rpn_whatsapp: val(prefix+"Wa"), city_area: val(prefix+"City") };
  }

  // ---- Settings card ----
  function rpnSectionHtml(){
    return `
      <div class="card">
        <h3>RPN (Reseller Partner Network)</h3>
        <p class="muted">The RPN who set you up on seiGEN — used for Support, and stored as entered (no lookup against a central registry yet). Optional, and editable any time.</p>
        ${rpnFieldsHtml("sRpn", getRpnLink())}
        <button class="btn btn-primary" id="saveRpnLink" style="margin-top:12px">Save</button>
      </div>`;
  }
  function wireRpnSection(){
    const btn = document.getElementById("saveRpnLink");
    if(btn) btn.onclick=()=>{
      saveRpnLink(rpnFieldsFromInputs("sRpn"));
      persist(); render();
    };
  }

  // ---- Support handoff (Part B) ----
  // Placed on the Help tab (More → Help), matching the same
  // "📲 WhatsApp ..." button convention already used on the About tab.
  function supportSectionHtml(){
    return `
      <div class="card" id="supportCard">
        <h3>Support</h3>
        <p class="muted">Message your RPN (Reseller Partner Network) contact for help with this app.</p>
        <button class="btn btn-primary" id="supportBtn">📲 Contact Support</button>
      </div>`;
  }
  function wireSupportSection(){
    const btn = document.getElementById("supportBtn");
    if(btn) btn.onclick=()=>openSupportHandoff();
  }
  // Returns what actually happened ("no_rpn" | "opened") so callers/tests
  // can assert without scraping alert()/window.open().
  function openSupportHandoff(){
    const rpn = getRpnLink();
    if(!rpn.rpn_whatsapp){
      alert("No RPN is linked yet. Add your RPN's WhatsApp number in More → Settings first.");
      moreTab = "settings"; settingsUnlocked = false; render();
      return "no_rpn";
    }
    const shopName = getSetting("shop_name","this shop");
    const branchName = getSetting("branch_name","");
    const who = branchName? `${shopName} (${branchName})` : shopName;
    enqueueSync("support_task", {
      tenant_id: tenantId(),
      ts: new Date().toISOString(),
      rpn_code: rpn.rpn_code,
      rpn_name: rpn.rpn_name,
      rpn_whatsapp: rpn.rpn_whatsapp,
    }); // paused: queues nothing (see registerSyncType above); the audit line below is the record
    logAudit("Support requested", "", "WhatsApp to RPN "+(rpn.rpn_name||rpn.rpn_whatsapp)+(rpn.rpn_code? " ("+rpn.rpn_code+")" : ""));
    persist();
    const text = `Hi, this is ${who} on seiGEN Commerce Lite. I need some support — could you help?`;
    // openExternalUrl (dn-browser.js) is the existing wa.me mechanism that's
    // actually correct on both build targets: window.open() alone doesn't
    // reliably hand off to WhatsApp from inside the Tauri webview, which is
    // why dn-browser.js already routes external links through Tauri's
    // opener plugin when running there, and window.open() only in the PWA.
    openExternalUrl(waLink(rpn.rpn_whatsapp, text));
    return "opened";
  }
