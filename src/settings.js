  function renderSettings(main){
    // Remote branches must unlock with the device's Admin passcode before seeing
    // anything but the Backup section. A remote with no Admin passcode yet creates
    // its own here (Setup asks for one on new remotes) - no main-branch file needed.
    if(isRemote() && !settingsUnlocked){
      const hasCode = hasAdminPasscode();
      main.innerHTML = `
        <div class="card">
          <h3>Settings Locked</h3>
          ${hasCode
            ? `<p class="muted">Enter the Admin passcode to unlock Settings.</p>
               <label>Admin passcode</label>
               <input class="field" id="settingsPasscode" type="password" placeholder="Enter passcode">
               <button class="btn btn-primary" id="unlockSettings" style="margin-top:10px">Unlock</button>`
            : adminComesFromMain()? `<p class="muted" id="adminFromMainNote">${escapeHtml(ADMIN_FROM_MAIN_TEXT)}</p>
               <button class="btn btn-primary" id="adminFromMainCheck" style="margin-top:10px">Check now</button>
               <p class="muted" id="adminFromMainStatus" style="font-size:12.5px;margin-top:8px"></p>`
            : `<p class="muted">This device has no Admin passcode yet. Create one now - it protects Settings and price changes on this branch.</p>
               <label>New Admin passcode (at least ${ADMIN_PASSCODE_MIN} characters)</label>
               <input class="field" id="newAdminPass" type="password" placeholder="Choose a passcode">
               <label>Repeat the passcode</label>
               <input class="field" id="newAdminPass2" type="password" placeholder="Repeat it">
               <button class="btn btn-primary" id="createAdmin" style="margin-top:10px">Create Admin passcode</button>`}
        </div>
        ${backupMergeSectionHtml()}
      `;
      const unlock = document.getElementById("unlockSettings");
      if(unlock) unlock.onclick=async ()=>{
        if(unlock.disabled) return;                                       // v30: no double submit
        const code = document.getElementById("settingsPasscode").value;
        unlock.disabled = true; unlock.textContent = "Checking…";        // v30: checked off the UI thread
        let admin = null;
        try{ admin = await findAdminAsync(code); }catch(e){ admin = null; }   // also an Admin passcode set by main (v21)
        if(!unlock.isConnected) return;                                   // the screen was left meanwhile
        if(admin){ settingsUnlocked=true; render(); return; }
        unlock.disabled = false; unlock.textContent = "Unlock";
        alert("Incorrect passcode.");
      };
      // v21: a joined device's Admin passcode comes with its next check-in
      const check = document.getElementById("adminFromMainCheck");
      if(check) check.onclick=async ()=>{
        const st = document.getElementById("adminFromMainStatus");
        check.disabled = true; check.textContent = "Checking…"; if(st) st.textContent = "";
        try{ await deviceCheckin(); }catch(e){}
        if(hasAdminPasscode()){ render(); return; }
        check.disabled = false; check.textContent = "Check now";
        if(st) st.textContent = isOnline()? "Nothing yet. Set it on a main-branch till first, then check again." : "This device is offline. Connect to the internet, then check again.";
      };
      const create = document.getElementById("createAdmin");
      if(create) create.onclick=()=>{
        try{ createDeviceAdmin(document.getElementById("newAdminPass").value, document.getElementById("newAdminPass2").value); }
        catch(e){ return alert(e.message||String(e)); }
        persist(); settingsUnlocked=true; render();
      };
      wireBackupMergeSection();
      return;
    }
    main.innerHTML = `
      <div class="card">
        <h3>Shop details</h3>
        <p class="muted" style="font-size:11.5px;margin-top:-4px">Version ${escapeHtml(APP_VERSION)}</p>
        <label>Shop name</label><input class="field" id="sName" value="${escapeHtml(getSetting("shop_name",""))}">
        <label>Branch name</label><input class="field" id="sBranch" value="${escapeHtml(getSetting("branch_name",""))}" ${branchNameLocked()? "readonly" : ""}>
        ${branchNameLocked()? `<p class="muted" style="font-size:12px;margin-top:4px">🔒 The branch name is locked after setup, because Delivery Notes, catalogues and the branch register all carry it.</p>` : ""}
        <label>Branch type</label>
        <select class="field" id="sBranchType">
          <option value="main" ${!isRemote()?"selected":""} ${isRemote() && branchTypeLockedRemote()? "disabled" : ""}>Main Branch</option>
          <option value="remote" ${isRemote()?"selected":""}>Remote Branch</option>
        </select>
        ${isRemote() && branchTypeLockedRemote()? `<p class="muted" id="branchTypeLocked" style="font-size:12px;margin-top:4px">🔒 ${escapeHtml(BRANCH_TYPE_LOCKED_TEXT)}</p>` : ""}
        <p class="muted">Remote branches can sell, but can't add or edit items, change stock quantities directly, or see item costs.</p>
        <label>Contact number</label><input class="field" id="sContact" value="${escapeHtml(getSetting("contact_phone",""))}">
        <label>Management WhatsApp number</label><input class="field" id="sMgmt" inputmode="tel" value="${escapeHtml(getSetting("management_whatsapp",""))}" placeholder="e.g. 0771234567">
        <p class="muted">Where variance reports on received stock are sent. On a remote branch this is filled in from the catalogue if left blank.</p>
        <label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px"><input type="checkbox" id="sCancelOn" ${cancelEnabled()? "checked" : ""} style="width:auto;margin-top:3px"><span>Enable cancel and reissue of Delivery Notes on this device</span></label>
        <p class="muted">Turn this on only after <b>every</b> branch, main and remotes, has updated to this version. A branch on an older version can't read a cancellation or a reissued Delivery Note. It only sees "update the app".</p>
        <label>Mark a dispatch "Awaiting" after (days)</label>
        <input class="field" id="sAwait" type="number" min="1" max="365" step="1" value="${awaitingDays()}">
        <p class="muted">A Delivery Note with no Goods Received Voucher after this many days shows as Awaiting in Dispatch history and the Stock Movements report.</p>
        <label>Currency symbol</label><input class="field" id="sCurrency" value="${escapeHtml(currency)}">
        <label>Seed Money / Starting Capital</label>
        <input class="field" id="sSeedMoney" type="number" step="0.01" value="${escapeHtml(getSetting("seed_money","0"))}">
        <p class="muted">Used on More → Purchasing to track how much of your starting capital has been recovered from sales.</p>
        <label>Print width (mm)</label>
        <input class="field" id="sPaper" type="number" min="32" max="80" step="1" value="${paperWidth()}">
        <p class="muted">An estimate, not exact — use Print test line below to calibrate: if the digit/dash line wraps to a second row, lower this number and try again.</p>
        <button class="btn btn-outline" id="printTestLine" style="margin-bottom:12px">🖨️ Print test line</button>
        <button class="btn btn-primary" id="saveSettings" style="margin-top:12px">Save</button>
      </div>
      ${typeof receiptSettingsCardHtml==="function"? receiptSettingsCardHtml() : ""}
      ${businessDayCardHtml()}
      ${typeof returnDaysLimit==="function"? `<div class="card">
        <h3>Returns</h3>
        <label style="margin-top:0">A sale can be returned for (days)</label>
        <input class="field" id="sReturnDays" type="number" min="1" max="365" step="1" value="${returnDaysLimit()}">
        <p class="muted">Counted in business days from the sale. An older receipt is refused. Needs the Admin passcode.</p>
        <button class="btn btn-outline" id="saveReturnDays">Save return limit</button>
      </div>` : ""}
      ${rpnSectionHtml()}
      ${currenciesSectionHtml()}
      ${typeof isSeat==="function" && isSeat()? "" : `
      <div class="card">
        <h3>Activation secret phrase</h3>
        <input class="field" id="sSecret" value="${escapeHtml(getSetting("secret_phrase",""))}">
        <button class="btn btn-outline" id="saveSecret" style="margin-top:10px">Save phrase</button>
      </div>`}
      ${typeof can!=="function" || can("m.terminals")? terminalSectionHtml() : ""}
      ${printerSectionHtml()}
      ${barcodeReaderSectionHtml()}
      ${typeof isSeat==="function" && isSeat()? "" : cashDrawerSectionHtml()}
      ${isRemote()? "" : `
      <div class="card">
        <h3>Frequent Customer Vouchers</h3>
        <p class="muted">Automatically issues a voucher to a customer once they've made enough purchases within a time window. Leave the voucher amount at 0 to keep this switched off.</p>
        <label style="margin-top:0">Purchases needed</label>
        <input class="field" id="sFreqCount" type="number" min="1" step="1" value="${escapeHtml(getSetting("freq_purchases_needed","5"))}">
        <label>...within how many days</label>
        <input class="field" id="sFreqDays" type="number" min="1" step="1" value="${escapeHtml(getSetting("freq_within_days","30"))}">
        <label>Voucher amount (${currency})</label>
        <input class="field" id="sFreqAmount" type="number" min="0" step="0.01" value="${escapeHtml(getSetting("freq_voucher_amount","0"))}">
        <button class="btn btn-primary" id="saveFreqSettings" style="margin-top:12px">Save</button>
      </div>`}
      ${adminPasscodeSettingShown()? adminPasscodeCardHtml() : ""}
      ${typeof bellSettingsHtml==="function"? bellSettingsHtml() : ""}
      ${typeof cycleSettingsCardHtml==="function"? cycleSettingsCardHtml() : ""}
      ${settingsStaffCardHtml()}
      ${isRemote() || !(typeof can!=="function" || can("m.terminals"))? "" : branchRegisterCardHtml()}
      ${backupMergeSectionHtml()}
      ${cloudSyncSectionHtml()}
      ${diagnosticsSectionHtml()}
    `;
    document.getElementById("printTestLine").onclick=()=>printTestLine();
    document.getElementById("saveSettings").onclick=async ()=>{
      const v = (id)=> document.getElementById(id).value;
      const wantType = v("sBranchType");
      // v30 (owner 2026-10-20): a till registered with seiGEN as a remote doesn't make itself Main here
      if(typeof isSeat==="function" && isSeat() && wantType!=="main"){ alert("An Office seat is part of the main branch.\n\nNothing was changed."); render(); return; }   // v32
      if(isRemote() && wantType==="main" && branchTypeLockedRemote()){ alert(BRANCH_TYPE_LOCKED_TEXT+"\n\nNothing was changed."); render(); return; }
      // switching cancel/reissue on or off needs an Admin (asked before anything is written)
      let cancelTo = null;
      { const want = document.getElementById("sCancelOn").checked;
        if(want!==cancelEnabled()){
          if(!hasAdminPasscode()) alert(NO_ADMIN_PASSCODE_MSG+" before this can be changed.");
          else if(!(await findAdminAsync(prompt("Admin passcode to "+(want? "switch on" : "switch off")+" cancel and reissue:")||""))) alert("Incorrect Admin passcode. Cancel and reissue was not changed.");
          else cancelTo = want;
        }
      }
      const newCurrency = v("sCurrency").trim()||"$";
      // v30: every setting of this card in one transaction: all of them, or none (the branch type included)
      try{
        run("BEGIN");
        setSetting("shop_name", v("sName").trim());
        setSetting("branch_name", branchNameToSave(v("sBranch")));
        setSetting("awaiting_days", String(awaitingDaysFrom(v("sAwait"))));
        if(cancelTo!==null){ setSetting("cancel_enabled", cancelTo? "1" : ""); logAudit("Cancel and reissue", "", cancelTo? "switched on" : "switched off"); }
        if(wantType!==(isRemote()? "remote" : "main")) logAudit("Branch type", "", wantType==="main"? "Remote → Main" : "Main → Remote");
        setSetting("branch_type", wantType);
        setSetting("contact_phone", v("sContact").trim());
        setSetting("management_whatsapp", v("sMgmt").trim());
        setSetting("currency", newCurrency);
        setSetting("seed_money", parseFloat(v("sSeedMoney"))||0);
        setSetting("paper_width", v("sPaper"));
        run("COMMIT");
      }catch(e){
        try{ run("ROLLBACK"); }catch(e2){}
        alert("Settings couldn't be saved. Nothing was changed.\n\n"+(e && e.message || e));
        render(); return;
      }
      currency = newCurrency;
      persist(); render();
    };
    wireBusinessDayCard();
    if(typeof wireReceiptSettingsCard==="function") wireReceiptSettingsCard();
    const saveRet = document.getElementById("saveReturnDays");
    if(saveRet) saveRet.onclick=async ()=>{
      const n = parseInt(document.getElementById("sReturnDays").value,10);
      if(n===returnDaysLimit()) return alert("Returns are already allowed for "+n+" days.");
      if(!hasAdminPasscode()) return alert(NO_ADMIN_PASSCODE_MSG+" before this can be changed.");
      const pc = prompt("Admin passcode to allow returns for "+n+" days:");
      if(pc===null) return;
      await passcodeWarm(pc);   // v34: off the screen thread first
      try{ setReturnDaysLimit(n, pc); alert("Returns are now allowed for "+n+" days."); render(); }
      catch(e){ alert(e.message); }
    };
    const saveFreqBtn = document.getElementById("saveFreqSettings");
    if(saveFreqBtn) saveFreqBtn.onclick=()=>{
      setSetting("freq_purchases_needed", parseInt(document.getElementById("sFreqCount").value)||5);
      setSetting("freq_within_days", parseInt(document.getElementById("sFreqDays").value)||30);
      setSetting("freq_voucher_amount", parseFloat(document.getElementById("sFreqAmount").value)||0);
      persist(); alert("Voucher settings saved.");
    };
    const saveSecretBtn = document.getElementById("saveSecret");   // not on an Office seat (v32: its phrase is its own, never shown)
    if(saveSecretBtn) saveSecretBtn.onclick=async (e)=>{
      const btn = e.currentTarget;
      setSetting("secret_phrase", document.getElementById("sSecret").value.trim());
      await persist();
      // Register with Digital Commerce straight away rather than at the next launch.
      btn.disabled = true; btn.textContent = "Saving…";
      const r = await deviceCheckin();
      btn.disabled = false; btn.textContent = "Save phrase";
      alert(r.ok || dcIsRegistered()
        ? "Secret phrase saved. This device is registered with Digital Commerce."
        : "Secret phrase saved, but this device isn't registered with Digital Commerce yet. " + dcCheckinProblemText(r));
    };
    if(typeof can!=="function" || can("m.terminals")) wireTerminalSection();
    wirePrinterSection();
    wireBarcodeReaderSection();
    if(!(typeof isSeat==="function" && isSeat())) wireCashDrawerSection();
    wireRpnSection();
    wireCurrenciesSection();
    wireAdminPasscodeCard(main);
    if(typeof bellSettingsWire==="function") bellSettingsWire(main);   // v37
    if(typeof cycleSettingsWire==="function") cycleSettingsWire(main);
    wireSettingsStaffCard(main);
    if(!isRemote() && (typeof can!=="function" || can("m.terminals"))) wireBranchRegisterCard();
    wireBackupMergeSection();
    wireCloudSyncSection();
    wireDiagnosticsSection();
  }
  // v30 (owner 2026-10-20): a till registered with seiGEN as a remote (its branch isn't the business's
  // main on seiGEN) may not switch itself to Main here. Unregistered (offline-only) tills: as before.
  const BRANCH_TYPE_LOCKED_TEXT = "Branch type is set for the whole business. Ask the Owner, or seiGEN support.";
  function branchTypeLockedRemote(){ return typeof isTerminalRegistered==="function" && isTerminalRegistered() && getSetting("terminal_is_main","")!=="1"; }
  // Settings → Staff & Roles. A till with the business's staff from seiGEN (roles.js, v28): the
  // shared people and roles, at any branch, for a holder of Staff (anyone once Settings is open,
  // in single operator mode). v33: a till registered with seiGEN that has no roles yet says so, with
  // Refresh; on a main branch this till's own list stays under it, without "+ Add Staff" (people added
  // there would never reach seiGEN; Edit and the Admin passcode as before: owner 2026-10-21 "approved
  // option 1"). Otherwise (not on seiGEN) this till's own list, on a main branch, as before.
  function settingsStaffMode(){
    if(typeof rolesSynced==="function" && rolesSynced()) return can("m.staff")? "shop" : "";
    if(typeof isTerminalRegistered==="function" && isTerminalRegistered()) return "wait";
    return isRemote()? "" : "local";
  }
  function settingsStaffCardHtml(){ const m = settingsStaffMode(); return m==="shop"? shopStaffSectionHtml() : m==="wait"? `<div id="staffWaitBox">${staffWaitingCardHtml()}${isRemote()? "" : staffSectionHtml({ noAdd:true })}</div>` : m==="local"? staffSectionHtml() : ""; }
  function wireSettingsStaffCard(main){
    const m = settingsStaffMode();
    if(m==="local") return wireStaffSection();
    const card = m==="shop"? main.querySelector("#shopStaffCard") : m==="wait"? main.querySelector("#staffWaitBox") : null;
    if(!card) return;
    const redraw = ()=>{
      if(!card.isConnected) return;
      const box = document.createElement("div"); box.innerHTML = settingsStaffCardHtml();
      if(box.firstElementChild) card.replaceWith(box.firstElementChild); else card.remove();
      wireSettingsStaffCard(main);
    };
    card._staffRedraw = redraw;
    if(m==="shop") return wireShopStaffSection(card, redraw);
    wireStaffWaitingCard(card, redraw);
    if(!isRemote()) wireStaffSection();
    // the safety net (at most once a minute): the roles may arrive while Settings is open
    staffEnsureRoles().then(r=>{
      if(!r || !card.isConnected) return;
      if(rolesSynced()) return redraw();
      const why = card.querySelector("#staffWaitWhy"), b = card.querySelector("#staffWaitRefresh");
      if(why && b && !b.disabled) why.textContent = "Couldn't load: " + (getSetting("staff_pull_error","") || r.message || "unknown reason");
    });
  }
  // v33: the roles arrived while Settings shows "Roles not loaded": that card only is drawn again (never the whole page).
  function settingsStaffCardRefresh(){
    const card = typeof document!=="undefined" && document.getElementById? document.getElementById("staffWaitBox") : null;
    if(card && card._staffRedraw && typeof rolesSynced==="function" && rolesSynced()) card._staffRedraw();
  }
  // Settings -> Diagnostics: read-only. Every product of this branch should
  // hold exactly the sum of its stock movements (Phase 2 ledger).
  // Products below zero: a read-only warning for older data (tills never sell below zero).
  function negativeStockHtml(){
    const neg = all("SELECT name, sku, stock FROM products WHERE branch=? AND stock<0 ORDER BY stock, name",[currentBranch()]);
    if(!neg.length) return `<p class="diag-neg-ok" style="margin:8px 0 0;color:#067647;font-weight:600">No products below zero stock.</p>`;
    return `<p class="diag-neg" style="margin:8px 0 6px;color:#b42318;font-weight:600">${neg.length} product${neg.length===1?" is":"s are"} below zero stock (from older records; tills never sell below zero):</p>
      <table class="table"><tr><th>Item</th><th>Stock</th></tr>
      ${neg.slice(0,50).map(n=>`<tr><td>${skuNameCell(n.sku,n.name)}</td><td>${n.stock}</td></tr>`).join("")}</table>
      ${neg.length>50? `<p class="muted">+${neg.length-50} more</p>` : ""}
      <p class="muted" style="margin-top:6px">Count them (More → Stocktake) to set the real figure.</p>`;
  }
  function diagnosticsBodyHtml(){
    return ledgerCheckHtml() + negativeStockHtml() + (typeof sharedStockDiagHtml==="function"? sharedStockDiagHtml() : "");
  }
  function ledgerCheckHtml(){
    const r = stockLedgerCheck();
    if(!r.mismatches.length)
      return `<p class="diag-ok" style="margin:0;color:#067647;font-weight:600">Stock ledger: all ${r.checked} product${r.checked===1?"":"s"} match their stock movements.</p>`;
    return `<p class="diag-bad" style="margin:0 0 6px;color:#b42318;font-weight:600">Stock ledger: ${r.mismatches.length} of ${r.checked} product${r.checked===1?"":"s"} don't match their stock movements.</p>
      <table class="table"><tr><th>Item</th><th>Stock</th><th>Movements</th><th>Difference</th></tr>
      ${r.mismatches.map(m=>`<tr><td>${skuNameCell(m.sku,m.name)}</td><td>${m.stock}</td><td>${m.ledger}</td><td>${m.diff>0?"+"+m.diff:m.diff}</td></tr>`).join("")}</table>
      <p class="muted" style="margin-top:6px">Nothing has been changed. Send a backup to support so this can be looked at.</p>`;
  }
  function diagnosticsSectionHtml(){
    return `<div class="card" id="diagCard">
        <h3>Diagnostics</h3>
        <p class="muted" style="margin-top:-4px">Checks only. Nothing here changes your data.</p>
        <div id="diagBody">${diagnosticsBodyHtml()}</div>
        <button class="btn btn-outline btn-sm" id="diagRecheck" style="margin-top:10px">Check again</button>
      </div>`;
  }
  function wireDiagnosticsSection(){
    const b = document.getElementById("diagRecheck");
    if(b) b.onclick=()=>{ document.getElementById("diagBody").innerHTML = diagnosticsBodyHtml(); if(typeof wireSharedStockDiag==="function") wireSharedStockDiag(); };
    if(typeof wireSharedStockDiag==="function") wireSharedStockDiag();
  }
