  // POS fixes (customers.js): one modal for adding and editing, needing
  // "Create customers" (or the Admin passcode when nobody signed in with a PIN).
  function newCustomerModal(onDone){
    openCustomerModal(null, { onSaved: (c)=>{ if(onDone) onDone(c.id); render(); } });
  }
  function editCustomerModal(customer){
    const wrap = openCustomerModal(customer, { onSaved: ()=> render() });
    if(!wrap) return;
    const del = document.createElement("button");
    del.className = "btn btn-danger"; del.id = "ecDelete"; del.style.marginTop = "8px"; del.textContent = "Delete customer";
    del.onclick = ()=>{
      if(!confirm(`Delete ${customer.name}? This does not delete their past sales history, just the contact record.`)) return;
      if(canCreateCustomers()===null){
        const pass = wrap.querySelector("#cuPass");
        if(!findAdmin(pass? pass.value : "")){ wrap.querySelector("#cuMsg").textContent = "Enter the Admin passcode to delete a customer."; return; }
      }
      run("DELETE FROM customers WHERE id=?", [customer.id]);
      logAudit("Delete customer", customer.name, "");
      persist(); wrap.remove(); render();
    };
    wrap.querySelector(".modal-body").appendChild(del);
  }

  // Credit tab: debtors only — focused purely on balances and payment reminders.
  function creditListHtml(customers, query){
    if(customers.length===0) return `<p class="muted">No credit customers yet — they appear here after a Credit sale at checkout.</p>`;
    const filtered = customers.filter(c=> textMatches(query, { text:[c.name], phones:[c.phone, c.phone_norm] }));   // the shared matcher (Branches addendum §R2)
    if(filtered.length===0) return `<p class="muted">No customers match "${escapeHtml(query)}".</p>`;
    return filtered.map(c=>{
      const bal = customerBalance(c.id);
      return `
      <div class="card">
        <div class="row" style="align-items:center">
          <div>
            <div style="font-weight:700">${escapeHtml(c.name)}</div>
            ${c.phone? `<button class="wa-link" data-wa="${c.id}">📲 ${escapeHtml(c.phone)}</button>` : `<div class="muted">No phone</div>`}
          </div>
          <div style="text-align:right;flex:none;display:flex;align-items:center;gap:8px">
            <div>
              <div class="muted">Balance</div>
              <div style="font-weight:800;color:${bal>0?'var(--danger)':'var(--success)'}">${currency}${bal.toFixed(2)}</div>
            </div>
            <button class="btn btn-sm btn-outline" data-editcust="${c.id}" title="Edit" style="padding:8px 10px">${ICON_EDIT}</button>
          </div>
        </div>
        ${bal>0? `
        <div class="row" style="margin-top:10px">
          <input class="field" id="pay-${c.id}" type="number" step="0.01" placeholder="Payment amount">
          <button class="btn btn-primary btn-sm" data-pay="${c.id}" style="flex:none">Record Payment</button>
        </div>` : ""}
      </div>`;
    }).join("");
  }
  function wireCreditCardHandlers(scope){
    scope.querySelectorAll("[data-pay]").forEach(b=>{
      b.onclick=()=>{
        const cid = +b.dataset.pay;
        const input = document.getElementById("pay-"+cid);
        const amt = parseFloat(input.value);
        if(!amt || amt<=0) return alert("Enter a valid payment amount");
        const ts = new Date().toISOString();
        run("INSERT INTO credit_payments(customer_id,ts,amount,note,branch,user) VALUES(?,?,?,?,?,?)",
          [cid, ts, amt, "", currentBranch(), sessionUser||""]);
        persist();
        const cust = one("SELECT * FROM customers WHERE id=?",[cid]);
        printPaymentReceipt(cust.name, amt, customerBalance(cid), ts);
        render();
      };
    });
    scope.querySelectorAll("[data-wa]").forEach(b=>{
      b.onclick=()=>{
        const cid = +b.dataset.wa;
        const c = one("SELECT * FROM customers WHERE id=?",[cid]);
        const bal = customerBalance(cid);
        const text = bal>0
          ? `Hi ${c.name}, a friendly reminder that your account balance with ${getSetting("shop_name","us")} is ${currency}${bal.toFixed(2)}. Thank you!`
          : `Hi ${c.name}, thank you for settling your account with ${getSetting("shop_name","us")}!`;
        shareWhatsApp(text, c.phone);
      };
    });
    scope.querySelectorAll("[data-editcust]").forEach(b=>{
      b.onclick=()=>{ const c = one("SELECT * FROM customers WHERE id=?",[+b.dataset.editcust]); editCustomerModal(c); };
    });
  }
  function renderCreditListOnly(customers){
    const target = document.getElementById("creditListArea");
    if(!target) return;
    target.innerHTML = creditListHtml(customers, creditQuery);
    wireCreditCardHandlers(target);
  }
  function renderCredit(main){
    // Joins sale_payments (not sales.method) so a customer whose only
    // credit exposure came from a Cash+Credit split sale still shows up
    // here, not just customers with a plain single-method Credit sale.
    const customers = all(`SELECT DISTINCT c.* FROM customers c
      JOIN sales s ON s.customer_id=c.id
      JOIN sale_payments sp ON sp.sale_id=s.id AND sp.method='Credit'
      ORDER BY c.name`);
    main.innerHTML = `
      <h2>Credit Ledger</h2>
      <p class="muted">Customers with credit sales, and payment reminders.</p>
      <div class="search-wrap">
        <span class="ic">🔎</span>
        <input class="field" id="creditSearch" placeholder="Search by name or phone…" value="${escapeHtml(creditQuery)}">
      </div>
      <div id="creditListArea">${creditListHtml(customers, creditQuery)}</div>
    `;
    document.getElementById("creditSearch").oninput=(e)=>{ creditQuery = e.target.value; renderCreditListOnly(customers); };
    wireCreditCardHandlers(document.getElementById("creditListArea"));
  }

  // Directory (under More): every customer, for marketing WhatsApp messages only.
  function directoryListHtml(customers, query){
    if(customers.length===0) return `<p class="muted">No customers yet. Add them here, or with "+ Add new customer" in the cart.</p>`;
    const filtered = customers.filter(c=> textMatches(query, { text:[c.name], phones:[c.phone, c.phone_norm] }));   // the shared matcher (Branches addendum §R2)
    if(filtered.length===0) return `<p class="muted">No customers match "${escapeHtml(query)}".</p>`;
    return filtered.map(c=>`
      <div class="card" style="display:flex;justify-content:space-between;align-items:center">
        <div>${escapeHtml(c.name)} <span class="pill ${c.customer_type==="wholesale"? "warn" : ""}">${escapeHtml(customerTypeLabel(c))}</span>
          ${customerPrivateVisible() && (c.credit_limit!=null || c.address || c.national_id)? `<div class="muted" style="font-size:12px">${c.credit_limit!=null? "Limit "+currency+Number(c.credit_limit).toFixed(2) : ""}${c.address? " · "+escapeHtml(c.address) : ""}${c.national_id? " · ID "+escapeHtml(c.national_id) : ""}</div>` : ""}</div>
        <div style="display:flex;align-items:center;gap:8px">
          ${c.phone? `<button class="wa-link" data-dwa="${c.id}">📲 ${escapeHtml(c.phone)}</button>` : `<div class="muted">No phone</div>`}
          <button class="btn btn-sm btn-outline" data-editcust="${c.id}" title="Edit" style="padding:8px 10px">${ICON_EDIT}</button>
        </div>
      </div>`).join("");
  }
  function wireDirectoryCardHandlers(scope){
    scope.querySelectorAll("[data-dwa]").forEach(b=>{
      b.onclick=()=>{
        const c = one("SELECT * FROM customers WHERE id=?",[+b.dataset.dwa]);
        const text = `Hi ${c.name}, thank you for shopping with ${getSetting("shop_name","us")}! We have new products in store — come check them out.`;
        shareWhatsApp(text, c.phone);
      };
    });
    scope.querySelectorAll("[data-editcust]").forEach(b=>{
      b.onclick=()=>{ const c = one("SELECT * FROM customers WHERE id=?",[+b.dataset.editcust]); editCustomerModal(c); };
    });
  }
  function renderDirectoryListOnly(customers){
    const target = document.getElementById("directoryListArea");
    if(!target) return;
    target.innerHTML = directoryListHtml(customers, directoryQuery);
    wireDirectoryCardHandlers(target);
  }
  function renderDirectory(main){
    const customers = all("SELECT * FROM customers ORDER BY name");
    main.innerHTML = `
${customerClashesHtml()}
      <div class="row" style="margin-bottom:12px">
        <button class="btn btn-primary" id="openNewCustomer" ${canCreateCustomers()===false? "disabled title=\"Ask an admin to add customers\"" : ""}>+ New Customer</button>
        <button class="btn btn-outline" id="openFullCustExport" style="flex:none;width:auto">Customer export (full)</button>
      </div>
      ${canCreateCustomers()===false? `<p class="muted" style="margin-top:-6px">Ask an admin to add customers.</p>` : ""}
      <div class="search-wrap">
        <span class="ic">🔎</span>
        <input class="field" id="directorySearch" placeholder="Search by name or phone…" value="${escapeHtml(directoryQuery)}">
      </div>
      <div id="directoryListArea">${directoryListHtml(customers, directoryQuery)}</div>
    `;
    document.getElementById("openNewCustomer").onclick=()=>newCustomerModal();
    document.getElementById("openFullCustExport").onclick=()=>openFullCustomerExport();
    wireCustomerClashes(main);
    document.getElementById("directorySearch").oninput=(e)=>{ directoryQuery = e.target.value; renderDirectoryListOnly(customers); };
    wireDirectoryCardHandlers(document.getElementById("directoryListArea"));
  }

  function payoutModal(refreshFn){
    const wrap = openModal("Add Payout", `
      <label>Amount (${currency})</label>
      <input class="field" id="poAmt" type="number" step="0.01" placeholder="0.00">
      <label>Reason</label>
      <input class="field" id="poReason" placeholder="e.g. Fuel, supplies">
      <button class="btn btn-primary" id="poConfirm" style="margin-top:12px">Add Payout</button>
    `);
    wrap.querySelector("#poConfirm").onclick=()=>{
      const amt = parseFloat(wrap.querySelector("#poAmt").value);
      const reason = wrap.querySelector("#poReason").value.trim();
      if(!amt || amt<=0) return alert("Enter a valid amount");
      run("INSERT INTO payouts(ts,amount,reason,branch,user) VALUES(?,?,?,?,?)",[new Date().toISOString(),amt,reason||"Payout",currentBranch(),sessionUser||""]);
      persist(); wrap.remove();
      if(refreshFn) refreshFn(); else render();
    };
  }

