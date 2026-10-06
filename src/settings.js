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
      if(unlock) unlock.onclick=()=>{
        const code = document.getElementById("settingsPasscode").value;
        const match = code && one("SELECT * FROM staff WHERE role='Admin' AND passcode=? AND passcode<>'' AND active=1",[code]);
        if(match){ settingsUnlocked=true; render(); }
        else alert("Incorrect passcode.");
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
          <option value="main" ${!isRemote()?"selected":""}>Main Branch</option>
          <option value="remote" ${isRemote()?"selected":""}>Remote Branch</option>
        </select>
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
      ${rpnSectionHtml()}
      ${currenciesSectionHtml()}
      <div class="card">
        <h3>Activation secret phrase</h3>
        <input class="field" id="sSecret" value="${escapeHtml(getSetting("secret_phrase",""))}">
        <button class="btn btn-outline" id="saveSecret" style="margin-top:10px">Save phrase</button>
      </div>
      ${terminalSectionHtml()}
      ${printerSectionHtml()}
      ${barcodeReaderSectionHtml()}
      ${cashDrawerSectionHtml()}
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
      ${isRemote()? "" : staffSectionHtml()}
      ${isRemote()? "" : branchRegisterCardHtml()}
      ${backupMergeSectionHtml()}
      ${cloudSyncSectionHtml()}
      ${diagnosticsSectionHtml()}
    `;
    document.getElementById("printTestLine").onclick=()=>printTestLine();
    document.getElementById("saveSettings").onclick=()=>{
      setSetting("shop_name", document.getElementById("sName").value.trim());
      setSetting("branch_name", branchNameToSave(document.getElementById("sBranch").value));
      setSetting("awaiting_days", String(awaitingDaysFrom(document.getElementById("sAwait").value)));
      { // switching cancel/reissue on or off needs an Admin
        const want = document.getElementById("sCancelOn").checked;
        if(want!==cancelEnabled()){
          if(!hasAdminPasscode()) alert(NO_ADMIN_PASSCODE_MSG+" before this can be changed.");
          else if(!findAdmin(prompt("Admin passcode to "+(want? "switch on" : "switch off")+" cancel and reissue:")||"")) alert("Incorrect Admin passcode. Cancel and reissue was not changed.");
          else { setSetting("cancel_enabled", want? "1" : ""); logAudit("Cancel and reissue", "", want? "switched on" : "switched off"); }
        }
      }
      setSetting("branch_type", document.getElementById("sBranchType").value);
      setSetting("contact_phone", document.getElementById("sContact").value.trim());
      setSetting("management_whatsapp", document.getElementById("sMgmt").value.trim());
      currency = document.getElementById("sCurrency").value.trim()||"$";
      setSetting("currency", currency);
      setSetting("seed_money", parseFloat(document.getElementById("sSeedMoney").value)||0);
      setSetting("paper_width", document.getElementById("sPaper").value);
      persist(); render();
    };
    const saveFreqBtn = document.getElementById("saveFreqSettings");
    if(saveFreqBtn) saveFreqBtn.onclick=()=>{
      setSetting("freq_purchases_needed", parseInt(document.getElementById("sFreqCount").value)||5);
      setSetting("freq_within_days", parseInt(document.getElementById("sFreqDays").value)||30);
      setSetting("freq_voucher_amount", parseFloat(document.getElementById("sFreqAmount").value)||0);
      persist(); alert("Voucher settings saved.");
    };
    document.getElementById("saveSecret").onclick=async (e)=>{
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
    wireTerminalSection();
    wirePrinterSection();
    wireBarcodeReaderSection();
    wireCashDrawerSection();
    wireRpnSection();
    wireCurrenciesSection();
    if(!isRemote()) wireStaffSection();
    if(!isRemote()) wireBranchRegisterCard();
    wireBackupMergeSection();
    wireCloudSyncSection();
    wireDiagnosticsSection();
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
    return ledgerCheckHtml() + negativeStockHtml();
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
    if(b) b.onclick=()=>{ document.getElementById("diagBody").innerHTML = diagnosticsBodyHtml(); };
  }
