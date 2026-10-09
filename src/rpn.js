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

  // ================== Verified RPN link (RPN commissions, 20261015120000) ==================
  // The RPN who onboards this shop enters their field force number and
  // 6-digit RPN PIN; Digital Commerce checks them (cl_device_link_rpn: this
  // device's install ID + phrase + device key) and links the shop (the
  // business, for a till of one) to that RPN, who then earns commission on
  // the shop's payments. Offline-first: the pair waits in settings and is
  // sent as soon as the device is online (and after every check-in); the
  // PIN is deleted once the server has answered. Once linked, only Digital
  // Commerce changes it. The free-text contact fields stay for Support.
  //   settings: rpn_link_state  "" | "pending" | "linked" | "error" | "conflict"
  //             rpn_link_ff / rpn_link_pin (while pending) / rpn_link_name / rpn_link_message
  const RPN_FF_RE = /^RPN-[0-9]{2,6}$/;
  function rpnLinkState(){
    return { state: getSetting("rpn_link_state",""), ff: getSetting("rpn_link_ff",""), name: getSetting("rpn_link_name",""),
             message: getSetting("rpn_link_message",""), pending: !!getSetting("rpn_link_pin","") };
  }
  // Validates and saves the pair; returns "" or a plain error for the form.
  function requestRpnLink(ff, pin){
    ff = String(ff||"").trim().toUpperCase(); pin = String(pin||"").trim();
    if(!RPN_FF_RE.test(ff)) return "Enter the field force number as it's printed, e.g. RPN-014.";
    if(!/^[0-9]{6}$/.test(pin)) return "The RPN PIN is 6 digits.";
    setSetting("rpn_link_ff", ff); setSetting("rpn_link_pin", pin);
    setSetting("rpn_link_state", "pending"); setSetting("rpn_link_message", "Saved. It will be checked when you're online.");
    return "";
  }
  let _rpnLinkInFlight = null;
  // Sends a waiting link, if any. Safe to call any time (one at a time).
  function trySendRpnLink(){
    if(_rpnLinkInFlight) return _rpnLinkInFlight;
    _rpnLinkInFlight = (async ()=>{
      const pin = getSetting("rpn_link_pin","");
      if(!pin || typeof terminalRpc!=="function") return { sent:false };
      if(!getSetting("secret_phrase","").trim()){
        setSetting("rpn_link_message", "Saved. Finish registering this device first (More → Settings → activation phrase); it's sent after that.");
        await persist(); return { sent:false };
      }
      const r = await terminalRpc("cl_device_link_rpn", Object.assign(terminalAuth(), { p_field_force_no: getSetting("rpn_link_ff",""), p_pin: pin }));
      if(!r.ok && (r.reason==="offline" || r.reason==="network")) return { sent:false };   // stays pending
      if(!r.ok){
        // e.g. not registered yet / phrase mismatch: keep it, say why, try again later
        setSetting("rpn_link_message", /not registered/i.test(r.message||"")
          ? "Saved. Finish registering this device first; it's sent after that."
          : "Saved, but Digital Commerce couldn't check it yet: " + (r.message||"try again later") + ".");
        await persist(); return { sent:false, message: r.message };
      }
      const d = r.data || {};
      setSetting("rpn_link_pin", "");   // answered: the PIN isn't kept
      if(d.ok){
        setSetting("rpn_link_state", "linked"); setSetting("rpn_link_name", d.rpn_name||"");
        setSetting("rpn_link_ff", d.field_force_no||getSetting("rpn_link_ff","")); setSetting("rpn_link_message", "");
        logAudit("RPN linked", "", (d.rpn_name||"") + " (" + (d.field_force_no||"") + ")");
      } else {
        setSetting("rpn_link_state", d.code==="RPN_CONFLICT"? "conflict" : "error");
        setSetting("rpn_link_message", d.message || "Digital Commerce couldn't link that RPN.");
      }
      await persist();
      return { sent:true, data:d };
    })().finally(()=>{ _rpnLinkInFlight = null; });
    return _rpnLinkInFlight;
  }
  // The RPN the server has for this shop (shown on More → About): after a
  // check-in, at most once an hour, and only for a registered device.
  async function refreshRpnStatus(force){
    if(typeof terminalRpc!=="function" || !getSetting("secret_phrase","").trim()) return;
    const last = Date.parse(getSetting("rpn_status_ts","")||"") || 0;
    if(!force && Date.now() - last < 3600000) return;
    const r = await terminalRpc("cl_device_rpn_status", terminalAuth());
    if(!r.ok || !r.data) return;
    setSetting("rpn_status_ts", new Date().toISOString());
    if(r.data.linked){
      setSetting("rpn_link_state", "linked"); setSetting("rpn_link_name", r.data.rpn_name||""); setSetting("rpn_link_ff", r.data.field_force_no||"");
      setSetting("rpn_link_pin", ""); setSetting("rpn_link_message", "");
    } else if(getSetting("rpn_link_state","")==="linked"){
      setSetting("rpn_link_state", ""); setSetting("rpn_link_name", ""); setSetting("rpn_link_ff", "");
    }
    await persist();
  }
  // Called after every successful check-in (devicecheckin.js).
  function rpnAfterCheckin(){
    return trySendRpnLink().then(()=> refreshRpnStatus(false)).catch(()=>{});
  }
  function rpnOnboardedByText(){
    const s = rpnLinkState();
    return s.state==="linked" && s.name ? "Onboarded by: " + s.name + (s.ff? " (" + s.ff + ")" : "") : "";
  }
  // The two fields an RPN fills in (setup step 3 and More → Settings).
  function rpnVerifyFieldsHtml(prefix){
    return `
      <label style="margin-top:0">Field force number</label>
      <input class="field" id="${prefix}Ff" autocapitalize="characters" placeholder="e.g. RPN-014" value="${escapeHtml(getSetting("rpn_link_state","")==="linked"? "" : getSetting("rpn_link_ff",""))}">
      <label>RPN PIN</label>
      <input class="field" id="${prefix}Pin" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="6 digits, typed by your RPN" type="password">`;
  }
  function rpnLinkStatusHtml(){
    const s = rpnLinkState();
    if(s.state==="linked") return `<p id="rpnLinkStatus" data-state="linked"><b>✓ ${escapeHtml(rpnOnboardedByText())}</b></p>
      <p class="muted">To change your RPN, ask Digital Commerce.</p>`;
    if(!s.state) return "";
    const bad = s.state==="error" || s.state==="conflict";
    return `<p id="rpnLinkStatus" data-state="${escapeHtml(s.state)}" class="${bad? "" : "muted"}" style="${bad? "color:#b42318" : ""}">${escapeHtml(s.message)}</p>`;
  }

  // ---- Settings card ----
  function rpnSectionHtml(){
    const linked = rpnLinkState().state==="linked";
    return `
      <div class="card" id="rpnCard">
        <h3>RPN (Revenue Partner Network)</h3>
        ${rpnLinkStatusHtml()}
        ${linked? "" : `
          <p class="muted">Link the RPN who set you up: they type their field force number and RPN PIN here. Digital Commerce checks them.</p>
          ${rpnVerifyFieldsHtml("sRpnV")}
          <button class="btn btn-primary" id="linkRpnBtn" style="margin-top:12px">Link RPN</button>`}
        <h4 style="margin-top:18px">RPN contact (for Support)</h4>
        <p class="muted">Your RPN's name and WhatsApp number, for the Support button. Stored on this device as entered.</p>
        ${rpnFieldsHtml("sRpn", getRpnLink())}
        <button class="btn btn-outline" id="saveRpnLink" style="margin-top:12px">Save contact</button>
      </div>`;
  }
  function wireRpnSection(){
    const btn = document.getElementById("saveRpnLink");
    if(btn) btn.onclick=()=>{
      saveRpnLink(rpnFieldsFromInputs("sRpn"));
      persist(); render();
    };
    const link = document.getElementById("linkRpnBtn");
    if(link) link.onclick=async ()=>{
      const err = requestRpnLink(document.getElementById("sRpnVFf").value, document.getElementById("sRpnVPin").value);
      if(err){ alert(err); return; }
      link.disabled = true;
      await persist(); render();
      await trySendRpnLink();
      render();
    };
  }

  // ---- Support handoff (Part B) ----
  // Placed on the Help tab (More → Help), matching the same
  // "📲 WhatsApp ..." button convention already used on the About tab.
  function supportSectionHtml(){
    return `
      <div class="card" id="supportCard">
        <h3>Support</h3>
        <p class="muted">Message your RPN (Revenue Partner Network) contact for help with this app.</p>
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
