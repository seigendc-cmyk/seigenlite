  function newCustomerModal(onDone){
    const wrap = openModal("New Customer", `
      <label>Customer name</label>
      <input class="field" id="ncName" placeholder="Full name">
      <label>Phone (optional)</label>
      <input class="field" id="ncPhone" placeholder="e.g. 077xxxxxxx">
      <label>Address (optional)</label>
      <input class="field" id="ncAddress" placeholder="e.g. 12 Baker Street">
      <label>Town/City (optional)</label>
      <input class="field" id="ncTownCity" placeholder="e.g. Harare">
      <label>Suburb (optional)</label>
      <input class="field" id="ncSuburb" placeholder="e.g. Avondale">
      <button class="btn btn-primary" id="ncConfirm" style="margin-top:12px">Add Customer</button>
    `);
    wrap.querySelector("#ncConfirm").onclick=()=>{
      const name = wrap.querySelector("#ncName").value.trim();
      const phone = wrap.querySelector("#ncPhone").value.trim();
      const address = wrap.querySelector("#ncAddress").value.trim();
      const townCity = wrap.querySelector("#ncTownCity").value.trim();
      const suburb = wrap.querySelector("#ncSuburb").value.trim();
      if(!name) return alert("Enter the customer's name");
      const cid = findOrCreateCustomer(name, phone, address, townCity, suburb);
      persist(); wrap.remove();
      if(onDone) onDone(cid);
      render();
    };
  }

  function editCustomerModal(customer){
    const wrap = openModal("Edit Customer", `
      <label>Customer name</label>
      <input class="field" id="ecName" value="${escapeHtml(customer.name)}">
      <label>Phone (optional)</label>
      <input class="field" id="ecPhone" value="${escapeHtml(customer.phone||"")}">
      <label>Address (optional)</label>
      <input class="field" id="ecAddress" value="${escapeHtml(customer.address||"")}">
      <label>Town/City (optional)</label>
      <input class="field" id="ecTownCity" value="${escapeHtml(customer.town_city||"")}">
      <label>Suburb (optional)</label>
      <input class="field" id="ecSuburb" value="${escapeHtml(customer.suburb||"")}">
      <button class="btn btn-primary" id="ecConfirm" style="margin-top:12px">Save Changes</button>
      <button class="btn btn-danger" id="ecDelete" style="margin-top:8px">Delete Customer</button>
    `);
    wrap.querySelector("#ecConfirm").onclick=()=>{
      const name = wrap.querySelector("#ecName").value.trim();
      const phone = wrap.querySelector("#ecPhone").value.trim();
      const address = wrap.querySelector("#ecAddress").value.trim();
      const townCity = wrap.querySelector("#ecTownCity").value.trim();
      const suburb = wrap.querySelector("#ecSuburb").value.trim();
      if(!name) return alert("Enter the customer's name");
      run("UPDATE customers SET name=?, phone=?, address=?, town_city=?, suburb=? WHERE id=?", [name, phone, address, townCity, suburb, customer.id]);
      persist(); wrap.remove(); render();
    };
    wrap.querySelector("#ecDelete").onclick=()=>{
      if(!confirm(`Delete ${customer.name}? This does not delete their past sales history, just the contact record.`)) return;
      run("DELETE FROM customers WHERE id=?", [customer.id]);
      persist(); wrap.remove(); render();
    };
  }

  // Credit tab: debtors only — focused purely on balances and payment reminders.
  function creditListHtml(customers, query){
    if(customers.length===0) return `<p class="muted">No credit customers yet — they appear here after a Credit sale at checkout.</p>`;
    const filtered = customers.filter(c=> matchesAnyOrder(query, c.name+" "+(c.phone||"")));
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
    const customers = all(`SELECT DISTINCT c.* FROM customers c JOIN sales s ON s.customer_id=c.id WHERE s.method='Credit' ORDER BY c.name`);
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
    if(customers.length===0) return `<p class="muted">No customers yet. They're added automatically when a name is entered at checkout, or add one here.</p>`;
    const filtered = customers.filter(c=> matchesAnyOrder(query, c.name+" "+(c.phone||"")));
    if(filtered.length===0) return `<p class="muted">No customers match "${escapeHtml(query)}".</p>`;
    return filtered.map(c=>`
      <div class="card" style="display:flex;justify-content:space-between;align-items:center">
        <div>${escapeHtml(c.name)}</div>
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
      <button class="btn btn-primary" id="openNewCustomer" style="margin-bottom:12px">+ New Customer</button>
      <div class="search-wrap">
        <span class="ic">🔎</span>
        <input class="field" id="directorySearch" placeholder="Search by name or phone…" value="${escapeHtml(directoryQuery)}">
      </div>
      <div id="directoryListArea">${directoryListHtml(customers, directoryQuery)}</div>
    `;
    document.getElementById("openNewCustomer").onclick=()=>newCustomerModal();
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

