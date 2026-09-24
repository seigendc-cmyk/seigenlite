  // ---------------- Multi-Currency Support (Settings) ----------------
  // The base currency is still just the existing `currency` setting/symbol
  // (Settings -> "Currency symbol") — unchanged, and never a row in this
  // table. This table only holds the OTHER currencies a cashier may be
  // handed cash/EcoCash/etc. in, each with a manually-set exchange rate
  // (offline-first app: no live rate feed). "BASE" is a reserved code that
  // can never be assigned to a real row — it's what sale_payments.currency
  // is set to for a base-currency line (see pos.js completeSale).
  //
  // rate convention: foreign units per 1 base-currency unit (e.g. base=USD,
  // ZWL rate=13000 means 1 USD = ZWL 13000). So:
  //   foreign equivalent of a base amount = base * rate
  //   base equivalent of a tendered foreign amount = tendered / rate
  const BASE_CURRENCY_CODE = "BASE";

  function activeCurrencies(){ return all("SELECT * FROM currencies WHERE active=1 ORDER BY code"); }
  function allCurrencies(){ return all("SELECT * FROM currencies ORDER BY active DESC, code"); }
  function getCurrencyByCode(code){ return code? one("SELECT * FROM currencies WHERE code=?",[code]) : null; }
  // Accepted at checkout right now: configured, active, and has a usable
  // (>0) rate — the one gate completeSale() checks before taking payment in
  // it (item 8: no configured/zero rate must block, never fall back to 1:1).
  function currencyAccepted(code){
    const c = getCurrencyByCode(code);
    return !!(c && c.active && c.rate>0);
  }
  // Display helpers — fall back to the bare code if a line names a currency
  // this device no longer has configured (deactivated locally, or merged in
  // from a branch with a different list): the historical fact still prints,
  // just without a friendly symbol/name.
  function currencySymbolFor(code){
    if(!code || code===BASE_CURRENCY_CODE) return currency;
    const c = getCurrencyByCode(code);
    return c? (c.symbol||c.code) : code;
  }
  function currencyNameFor(code){
    if(!code || code===BASE_CURRENCY_CODE) return "Base currency";
    const c = getCurrencyByCode(code);
    return c? (c.name||c.code) : code;
  }

  // Pure add/edit (no DOM), so the modal's Save button and the test suite
  // share one validated path — same shape as saveStaffMember (staff.js).
  function saveCurrency(o){
    o = o||{};
    const code = String(o.code||"").trim().toUpperCase();
    if(!code) throw new Error("Enter a currency code (e.g. ZWL, ZAR).");
    if(code===BASE_CURRENCY_CODE) throw new Error(`"${BASE_CURRENCY_CODE}" is reserved for the base currency — choose a different code.`);
    const rate = parseFloat(o.rate);
    if(!(rate>0)) throw new Error("Enter an exchange rate greater than 0.");
    const name = String(o.name||"").trim();
    const symbol = String(o.symbol||"").trim();
    const isEdit = !!o.id;
    const existing = isEdit? one("SELECT * FROM currencies WHERE id=?",[o.id]) : null;
    if(isEdit && !existing) throw new Error("Currency not found");
    const clash = one("SELECT id FROM currencies WHERE upper(code)=? AND active=1 AND id<>?",[code, isEdit? o.id : 0]);
    if(clash) throw new Error(`"${code}" is already an accepted currency.`);
    if(isEdit){
      const active = o.active===undefined ? existing.active : (o.active? 1 : 0);
      run("UPDATE currencies SET code=?, name=?, symbol=?, rate=?, active=? WHERE id=?",[code,name,symbol,rate,active,o.id]);
      return one("SELECT * FROM currencies WHERE id=?",[o.id]);
    }
    run("INSERT INTO currencies(code,name,symbol,rate,active) VALUES(?,?,?,?,1)",[code,name,symbol,rate]);
    return one("SELECT * FROM currencies ORDER BY id DESC LIMIT 1");
  }

  function currenciesSectionHtml(){
    const list = allCurrencies();
    return `
      <div class="card">
        <h3>Accepted Currencies</h3>
        <p class="muted">The base currency (${escapeHtml(currency)}) is set above. Add other currencies a cashier can be tendered in at checkout — rates are set here by hand and only change when you update them; a past sale keeps the rate it was made at.</p>
        <button class="btn btn-primary" id="openAddCurrency" style="margin-bottom:10px">+ Add Currency</button>
        ${list.length===0? `<p class="muted">No other currencies added yet — checkout only offers ${escapeHtml(currency)}.</p>` : list.map(c=>`
          <div class="product-row">
            <div>
              <div class="pname">${escapeHtml(c.code)}${c.name? " — "+escapeHtml(c.name):""}${c.active? "" : ` <span class="pill low">inactive</span>`}</div>
              <div class="pmeta">1 ${escapeHtml(currency)} = ${escapeHtml(c.symbol||c.code)}${c.rate}</div>
            </div>
            <button class="btn btn-sm btn-outline" data-edit-currency="${c.id}" style="flex:none">Edit</button>
          </div>`).join("")}
      </div>`;
  }
  function currencyModal(existing){
    const isEdit = !!existing;
    const wrap = openModal(isEdit? "Edit Currency" : "Add Currency", `
      <label style="margin-top:0">Code (e.g. ZWL, ZAR, EUR)</label>
      <input class="field" id="cyCode" value="${escapeHtml(existing? existing.code : "")}" ${isEdit? "disabled":""} placeholder="ZWL">
      <label>Name</label>
      <input class="field" id="cyName" value="${escapeHtml(existing? (existing.name||"") : "")}" placeholder="Zimbabwe Gold">
      <label>Symbol</label>
      <input class="field" id="cySymbol" value="${escapeHtml(existing? (existing.symbol||"") : "")}" placeholder="ZiG">
      <label>Exchange rate (1 ${escapeHtml(currency)} = ? of this currency)</label>
      <input class="field" id="cyRate" type="number" step="0.0001" min="0" value="${existing? existing.rate : ""}" placeholder="e.g. 13000">
      <p class="muted" style="font-size:11px;margin-top:-4px">Set by hand — this app is offline-first and never fetches rates automatically. Update it here whenever the real rate moves; past sales keep whatever rate was in effect when they were made.</p>
      ${isEdit? `<label style="display:flex;align-items:center;gap:8px;margin-top:14px"><input type="checkbox" id="cyActive" ${existing.active? "checked":""} style="width:auto;margin:0"> Active (offered at checkout)</label>` : ""}
      <button class="btn btn-primary" id="cyConfirm" style="margin-top:14px">${isEdit? "Save Changes" : "Add Currency"}</button>
    `);
    wrap.querySelector("#cyConfirm").onclick=()=>{
      try{
        saveCurrency({
          id: isEdit? existing.id : null,
          code: isEdit? existing.code : wrap.querySelector("#cyCode").value,
          name: wrap.querySelector("#cyName").value,
          symbol: wrap.querySelector("#cySymbol").value,
          rate: wrap.querySelector("#cyRate").value,
          active: isEdit? wrap.querySelector("#cyActive").checked : true,
        });
      }catch(e){ return alert(e.message||String(e)); }
      persist(); wrap.remove(); render();
    };
  }
  function wireCurrenciesSection(){
    const addBtn = document.getElementById("openAddCurrency");
    if(addBtn) addBtn.onclick=()=>currencyModal(null);
    document.querySelectorAll("[data-edit-currency]").forEach(b=>{
      b.onclick=()=>{
        const c = one("SELECT * FROM currencies WHERE id=?",[+b.dataset.editCurrency]);
        currencyModal(c);
      };
    });
  }
