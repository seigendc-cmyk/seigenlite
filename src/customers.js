  // ================== Customers (POS fixes) ==================
  // docs/pos/pos-fixes-design.md §2. The cart's customer combo (search by
  // name or phone, pick, or "+ Add new customer"), the Add/Edit customer
  // modal, the "Create customers" permission, the credit-limit warning, the
  // privacy rules (national ID and address only for staff with the
  // permission or an Admin; never on receipts, reports or exports except the
  // Admin-only full export), and the business's shared customer list
  // (cl_customers, migration 20261018180000) for registered tills.
  //
  // The cart's selection itself (cartCustomer, setCartCustomer, the price
  // level and the credit-limit check) lives in pos.js.
  //
  // customers.srv_status: '' not considered yet | 'queued' new here, sent
  // next | 'legacy' from before the shared list, sent next | 'sent' |
  // 'clash' a legacy customer whose phone another till already has (an Admin
  // decides) | 'local' kept on this till only.

  // ---- permission ----
  // true: may create/edit customers and see ID + address; false: may not;
  // null: nobody is signed in with a PIN, so the Admin passcode decides.
  function canCreateCustomers(){
    const s = typeof currentStaff==="function"? currentStaff() : null;
    if(!s) return null;
    return s.role==="Admin" || Number(s.can_create_customers)===1;
  }
  const CUSTOMER_TYPES = { retail:"Retail", wholesale:"Wholesale" };
  function customerTypeLabel(c){ return CUSTOMER_TYPES[(c && c.customer_type)||"retail"] || "Retail"; }

  // ---- search (name: start of a word; phone: digits anywhere, any spelling) ----
  function customerSearch(query, limit){
    const q = String(query||"").trim().toLowerCase();
    const rows = all("SELECT * FROM customers ORDER BY name");
    if(!q) return rows.slice(0, limit||8);
    const terms = q.split(/\s+/).filter(Boolean);
    const qDigits = q.replace(/\D/g,""), qNorm = normPhone(q);
    const out = rows.filter(c=>{
      const words = String(c.name||"").toLowerCase().match(/[a-z0-9]+/g) || [];
      const byName = terms.every(t=> words.some(w=> w.startsWith(t.replace(/[^a-z0-9]/g,""))));
      const digits = String(c.phone||"").replace(/\D/g,"");
      const byPhone = qDigits.length>=3 && (digits.includes(qDigits) || (c.phone_norm||"").includes(qDigits.replace(/^0/,"")) || (qNorm && c.phone_norm===qNorm));
      return byName || byPhone;
    });
    return out.slice(0, limit||8);
  }

  // ---- the cart combo ----
  // The input keeps id "custName" (completeSale reads it for an exact-name
  // match); picking sets cartCustomer and re-prices. Only #custList and the
  // chip are re-rendered while typing, never the input.
  function customerComboHtml(){
    const c = cartCustomer;
    return `<div class="cust-combo" id="custCombo">
      <label for="custName" class="cust-combo-label">Customer (needed for Credit)</label>
      ${c? `<div class="cust-chip" id="custChip"><span><b>${escapeHtml(c.name)}</b>${c.phone? " · "+escapeHtml(c.phone) : ""}
            <span class="pill ${c.customer_type==="wholesale"? "warn" : ""}" style="margin-left:4px">${escapeHtml(customerTypeLabel(c))}</span></span>
          <button type="button" class="close-x" id="custClear" aria-label="Remove customer">✕</button></div>`
        : `<input class="field" id="custName" autocomplete="off" placeholder="Search name or phone, or add new" value="${escapeHtml(window._custNameVal||"")}">
           <div class="cust-list" id="custList" role="listbox"></div>`}
      <div class="cust-notice" id="custNotice" role="status">${escapeHtml(window._custNotice||"")}</div>
    </div>`;
  }
  function custListHtml(query){
    const rows = customerSearch(query, 8);
    const perm = canCreateCustomers();
    const add = perm===false
      ? `<button type="button" class="cust-opt cust-add" disabled title="Ask an admin to add customers">+ Add new customer <span class="muted">· Ask an admin to add customers</span></button>`
      : `<button type="button" class="cust-opt cust-add" data-cust-add="1">+ Add new customer${query.trim()? ` "${escapeHtml(query.trim())}"` : ""}</button>`;
    return rows.map(c=>`<button type="button" class="cust-opt" data-cust-pick="${c.id}"><b>${escapeHtml(c.name)}</b>
        <span class="muted">${escapeHtml(c.phone||"no phone")} · ${escapeHtml(customerTypeLabel(c))}</span></button>`).join("") + add;
  }
  // container: the drawer or the desktop cart; onChange: re-render the cart.
  function wireCustomerCombo(container, onChange){
    const inp = container.querySelector("#custName"), list = container.querySelector("#custList");
    const clear = container.querySelector("#custClear");
    const notice = (t)=>{ window._custNotice = t||""; const n = container.querySelector("#custNotice"); if(n) n.textContent = window._custNotice; };
    const pick = (c)=>{
      const t = setCartCustomer(c);
      window._custNameVal = ""; notice(t);
      onChange();
    };
    if(clear) clear.onclick = ()=> pick(null);
    if(!inp || !list) return;
    const show = ()=>{ list.innerHTML = custListHtml(inp.value); list.style.display = "block"; wireList(); };
    const wireList = ()=>{
      list.querySelectorAll("[data-cust-pick]").forEach(b=>{
        b.onmousedown = (e)=> e.preventDefault();   // keep focus until the click lands
        b.onclick = ()=>{ const c = one("SELECT * FROM customers WHERE id=?",[+b.dataset.custPick]); if(c) pick(c); };
      });
      const add = list.querySelector("[data-cust-add]");
      if(add){ add.onmousedown = (e)=> e.preventDefault(); add.onclick = ()=>{ list.style.display = "none"; openCustomerModal(null, { prefill: inp.value, onSaved: (c)=> pick(c) }); }; }
    };
    inp.oninput = (e)=>{ window._custNameVal = e.target.value; if(typeof renderVoucherBox==="function") renderVoucherBox(); show(); };
    inp.onfocus = show;
    inp.onblur = ()=> setTimeout(()=>{ list.style.display = "none"; }, 150);
    inp.onkeydown = (e)=>{
      if(e.key==="Escape"){ list.style.display = "none"; return; }
      if(e.key==="Enter"){ const first = list.querySelector("[data-cust-pick]"); if(first){ e.preventDefault(); first.click(); } }
    };
  }

  // ---- add / edit ----
  // existing: a customers row to edit, or null to add. o.prefill: typed text
  // (a name, or digits for the phone); o.onSaved(customerRow).
  function openCustomerModal(existing, o){
    o = o||{};
    const perm = canCreateCustomers();
    if(perm===false){ alert("Ask an admin to add or change customers."); return null; }
    const pre = String(o.prefill||"").trim(), preIsPhone = /^[+0-9][0-9 ()+\-]{5,}$/.test(pre);
    const c = existing || { name: preIsPhone? "" : pre, phone: preIsPhone? pre : "", customer_type:"retail", credit_limit:null, address:"", national_id:"" };
    const wrap = openModal(existing? "Edit customer" : "Add new customer", `
      <label for="cuName">Name</label>
      <input class="field" id="cuName" value="${escapeHtml(c.name||"")}" placeholder="Full name" autocomplete="off">
      <label for="cuPhone">Phone</label>
      <input class="field" id="cuPhone" value="${escapeHtml(c.phone||"")}" placeholder="e.g. 077x xxx xxx" inputmode="tel" autocomplete="off">
      <label>Customer type</label>
      <div class="row" id="cuTypeRow">
        <button type="button" class="btn ${c.customer_type!=="wholesale"? "btn-primary" : "btn-outline"}" data-cu-type="retail">Retail</button>
        <button type="button" class="btn ${c.customer_type==="wholesale"? "btn-primary" : "btn-outline"}" data-cu-type="wholesale">Wholesale</button>
      </div>
      <p class="muted" style="margin-top:4px">Wholesale customers get each product's wholesale price, where it has one.</p>
      <label for="cuLimit">Credit limit (${escapeHtml(currency)}, optional)</label>
      <input class="field" id="cuLimit" type="number" min="0" step="0.01" value="${c.credit_limit==null? "" : escapeHtml(String(c.credit_limit))}" placeholder="Empty: no limit">
      <label for="cuAddress">Address (optional)</label>
      <input class="field" id="cuAddress" value="${escapeHtml(c.address||"")}" autocomplete="off">
      <label for="cuNid">National ID number (optional)</label>
      <input class="field" id="cuNid" value="${escapeHtml(c.national_id||"")}" autocomplete="off">
      <p class="muted" style="margin-top:4px">Address and ID number are shown only to staff who can create customers, and never on receipts.</p>
      ${perm===null? `<label for="cuPass">Admin passcode</label><input class="field" id="cuPass" type="password" autocomplete="off">` : ""}
      <div id="cuMsg" role="alert" style="color:var(--danger);font-weight:600;margin-top:8px"></div>
      <button class="btn btn-primary" id="cuSave" style="margin-top:10px">${existing? "Save changes" : "Add customer"}</button>`);
    let type = c.customer_type==="wholesale"? "wholesale" : "retail";
    wrap.querySelectorAll("[data-cu-type]").forEach(b=> b.onclick = ()=>{
      type = b.dataset.cuType;
      wrap.querySelectorAll("[data-cu-type]").forEach(x=>{ x.className = "btn "+(x.dataset.cuType===type? "btn-primary" : "btn-outline"); });
    });
    const msg = wrap.querySelector("#cuMsg");
    wrap.querySelector("#cuSave").onclick = ()=>{
      msg.innerHTML = "";
      try{
        const saved = saveCustomer(existing, {
          name: wrap.querySelector("#cuName").value, phone: wrap.querySelector("#cuPhone").value, customer_type: type,
          credit_limit: wrap.querySelector("#cuLimit").value, address: wrap.querySelector("#cuAddress").value,
          national_id: wrap.querySelector("#cuNid").value,
        }, { passcode: perm===null? wrap.querySelector("#cuPass").value : null });
        wrap.remove();
        if(o.onSaved) o.onSaved(saved); else render();
      }catch(e){
        msg.textContent = e.message||String(e);
        if(e.existing){
          const b = document.createElement("button");
          b.className = "btn btn-outline btn-sm"; b.style.marginTop = "6px"; b.textContent = "Select "+e.existing.name;
          b.onclick = ()=>{ wrap.remove(); if(o.onSaved) o.onSaved(e.existing); };
          msg.appendChild(document.createElement("br")); msg.appendChild(b);
        }
      }
    };
    return wrap;
  }
  // The one write path for customers (the modal, tests). Throws a plain
  // Error; a duplicate phone throws with .existing (the customer to select).
  function saveCustomer(existing, f, o){
    o = o||{};
    const perm = canCreateCustomers();
    if(perm===false) throw new Error("Ask an admin to add or change customers.");
    let by = sessionUser||"";
    if(perm===null){
      const admin = findAdmin(o.passcode||"");
      if(!admin) throw new Error("Enter the Admin passcode to add or change customers.");
      by = admin.name;
    }
    const name = String(f.name||"").trim().replace(/\s+/g," ");
    const phone = String(f.phone||"").trim();
    if(!name) throw new Error("Enter the customer's name.");
    if(name.length>80) throw new Error("Keep the name under 80 characters.");
    const norm = normPhone(phone);
    if(!norm) throw new Error("Enter the customer's phone number, e.g. 077x xxx xxx or +263 77x xxx xxx.");
    const type = f.customer_type==="wholesale"? "wholesale" : "retail";
    const limRaw = String(f.credit_limit==null? "" : f.credit_limit).trim();
    const limit = limRaw===""? null : roundMoney(parseFloat(limRaw));
    if(limit!==null && !(limit>=0)) throw new Error("The credit limit must be 0 or more, or empty for no limit.");
    const address = String(f.address||"").trim().slice(0,200), nid = String(f.national_id||"").trim().slice(0,40);
    const dup = one("SELECT * FROM customers WHERE phone_norm=? AND id<>?",[norm, existing? existing.id : -1]);
    if(dup){ const e = new Error("A customer with this phone already exists: "+dup.name+"."); e.existing = dup; throw e; }
    const now = new Date().toISOString();
    let id = existing? existing.id : null;
    if(existing){
      run(`UPDATE customers SET name=?, phone=?, phone_norm=?, customer_type=?, credit_limit=?, address=?, national_id=?, updated_ts=?,
             srv_status=CASE WHEN srv_status IN ('sent','queued','legacy','') THEN 'queued' ELSE srv_status END WHERE id=?`,
        [name, phone, norm, type, limit, address, nid, now, existing.id]);
      logAudit("Edit customer", name, customerTypeLabel({customer_type:type})+(limit!==null? " · limit "+currency+limit.toFixed(2) : "")+" · by "+by);
    } else {
      run(`INSERT INTO customers(name,phone,phone_norm,branch,customer_type,credit_limit,address,national_id,updated_ts,srv_status)
           VALUES(?,?,?,?,?,?,?,?,?,'queued')`, [name, phone, norm, currentBranch(), type, limit, address, nid, now]);
      id = one("SELECT last_insert_rowid() AS id").id;   // before logAudit, which inserts a row of its own
      logAudit("Add customer", name, customerTypeLabel({customer_type:type})+(limit!==null? " · limit "+currency+limit.toFixed(2) : "")+" · by "+by);
    }
    const row = one("SELECT * FROM customers WHERE id=?",[id]);
    persist();
    if(typeof custSendPending==="function") custSendPending().catch(()=>{});
    return row;
  }

  // ---- credit limit (the cart) ----
  function openCreditLimitModal(info, retry){
    const wrap = openModal("Over the credit limit", `
      <p id="clText" style="font-weight:600">${escapeHtml(info.text)}</p>
      <label for="clPass">Admin passcode</label>
      <input class="field" id="clPass" type="password" autocomplete="off">
      <div id="clMsg" role="alert" style="color:var(--danger);font-weight:600;margin-top:8px"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-outline" id="clCancel">Don't sell</button>
        <button class="btn btn-primary" id="clGo">Continue the sale</button>
      </div>`);
    wrap.querySelector("#clCancel").onclick = ()=> wrap.remove();
    wrap.querySelector("#clGo").onclick = ()=>{
      try{ approveCreditLimit(info, wrap.querySelector("#clPass").value); }
      catch(e){ wrap.querySelector("#clMsg").textContent = e.message; return; }
      wrap.remove(); retry();
    };
    return wrap;
  }

  // ---- privacy: what a customer row shows to whom ----
  function customerPrivateVisible(){ return canCreateCustomers()===true; }

  // ---- Admin-only full customer export (the only export with ID and address) ----
  async function exportCustomersFull(passcode){
    const admin = findAdmin(passcode||"");
    if(!admin) throw new Error("Incorrect Admin passcode. Nothing was exported.");
    await loadXLSX();
    const rows = all("SELECT * FROM customers ORDER BY name").map(c=>({ "Name":c.name, "Phone":c.phone||"", "Type":customerTypeLabel(c),
      "Credit limit":c.credit_limit==null? "" : c.credit_limit, "Balance (this till)":roundMoney(customerBalance(c.id)),
      "Address":c.address||"", "National ID":c.national_id||"" }));
    const ws = XLSX.utils.json_to_sheet(rows), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Customers");
    logAudit("Customer export (full)", "", rows.length+" customers · by "+admin.name);
    XLSX.writeFile(wb, "customers-full-"+new Date().toISOString().slice(0,10)+".xlsx");
    return rows.length;
  }
  function openFullCustomerExport(){
    const wrap = openModal("Customer export (full)", `
      <p class="muted">Includes address and national ID number. Admin only.</p>
      <label for="cxPass">Admin passcode</label><input class="field" id="cxPass" type="password" autocomplete="off">
      <div id="cxMsg" role="alert" style="color:var(--danger);font-weight:600;margin-top:8px"></div>
      <button class="btn btn-primary" id="cxGo" style="margin-top:10px">Export</button>`);
    wrap.querySelector("#cxGo").onclick = async ()=>{
      try{ await exportCustomersFull(wrap.querySelector("#cxPass").value); wrap.remove(); }
      catch(e){ wrap.querySelector("#cxMsg").textContent = e.message||String(e); }
    };
  }

  // ---- the business's shared list (registered tills) ----
  function custRegistered(){ return !!getSetting("terminal_id","") && typeof terminalRpc==="function"; }
  function custRowPayload(c){
    return { uid:c.uid, name:c.name, phone:c.phone||"", customer_type:c.customer_type||"retail",
      credit_limit:c.credit_limit==null? null : c.credit_limit, address:c.address||"", national_id:c.national_id||"", active:true };
  }
  // A server record replaces this till's row (same local id, so its sales,
  // payments, vouchers and credit notes stay with it).
  function custAdopt(localId, s){
    run(`UPDATE customers SET uid=?, name=?, phone=?, phone_norm=?, customer_type=?, credit_limit=?, address=?, national_id=?,
           srv_status='sent', srv_error='', updated_ts=? WHERE id=?`,
      [s.uid, s.name, s.phone||"", s.phone_norm||normPhone(s.phone), s.customer_type||"retail", s.credit_limit==null? null : Number(s.credit_limit),
       s.address||"", s.national_id||"", s.updated_at||new Date().toISOString(), localId]);
  }
  let _custSending = null;
  function custSendPending(){
    if(_custSending) return _custSending;
    _custSending = (async ()=>{
      if(!custRegistered()) return { sent:0 };
      // customers from before the shared list go too (a phone clash waits for an Admin)
      run("UPDATE customers SET srv_status='legacy' WHERE COALESCE(srv_status,'')='' AND COALESCE(phone_norm,'')<>''");
      const rows = all("SELECT * FROM customers WHERE srv_status IN ('queued','legacy') AND COALESCE(phone_norm,'')<>'' ORDER BY id");
      let sent = 0;
      for(const c of rows){
        const r = await terminalRpc("cl_device_customer_save", Object.assign(terminalAuth(), { p_customer: custRowPayload(c) }));
        if(!r.ok && (r.reason==="offline" || r.reason==="network")) break;
        if(r.ok && r.data && r.data.ok){ run("UPDATE customers SET srv_status='sent', srv_error='' WHERE id=?",[c.id]); sent++; continue; }
        if(r.code==="DUPLICATE_PHONE" && r.data && r.data.existing){
          const ex = r.data.existing;
          const already = one("SELECT id FROM customers WHERE uid=? AND id<>?",[ex.uid, c.id]);
          if(c.srv_status==="queued" && !already) custAdopt(c.id, ex);   // added here offline while another till added them: take theirs
          else run("UPDATE customers SET srv_status='clash', srv_error=? WHERE id=?",[ex.uid+"|"+ex.name, c.id]);
          continue;
        }
        run("UPDATE customers SET srv_error=? WHERE id=?",[String(r.message||r.code||"not sent").slice(0,200), c.id]);
      }
      await persist();
      return { sent };
    })().finally(()=>{ _custSending = null; });
    return _custSending;
  }
  async function custPull(){
    if(!custRegistered()) return { applied:0 };
    let applied = 0;
    for(let guard=0; guard<50; guard++){
      const r = await terminalRpc("cl_device_customers_pull", Object.assign(terminalAuth(), { p_cursor: Number(getSetting("cust_cursor","0"))||0 }));
      if(!r.ok || !r.data || !Array.isArray(r.data.customers)) break;
      for(const s of r.data.customers){
        const mine = one("SELECT * FROM customers WHERE uid=?",[s.uid]);
        if(mine){ if(mine.srv_status!=="queued") custAdopt(mine.id, s); }
        else {
          const samePhone = one("SELECT * FROM customers WHERE phone_norm=? AND srv_status IN ('queued','')",[s.phone_norm]);
          if(samePhone && samePhone.srv_status==="queued") custAdopt(samePhone.id, s);
          else {
            run(`INSERT INTO customers(uid,name,phone,phone_norm,branch,customer_type,credit_limit,address,national_id,srv_status,updated_ts)
                 VALUES(?,?,?,?,?,?,?,?,?,'sent',?)`, [s.uid, s.name, s.phone||"", s.phone_norm||"", currentBranch(), s.customer_type||"retail",
                 s.credit_limit==null? null : Number(s.credit_limit), s.address||"", s.national_id||"", s.updated_at||""]);
            if(samePhone) run("UPDATE customers SET srv_status='clash', srv_error=? WHERE id=?",[s.uid+"|"+s.name, samePhone.id]);
          }
        }
        applied++;
      }
      setSetting("cust_cursor", String(r.data.cursor||0));
      if(!r.data.more) break;
    }
    await persist();
    return { applied };
  }
  // After every successful check-in (devicecheckin.js) and from Settings.
  function custAfterCheckin(){ return custSendPending().then(()=> custPull()).catch(()=>{}); }

  // ---- "Customers to check" (an Admin decides a phone clash) ----
  function customerClashes(){ return all("SELECT * FROM customers WHERE srv_status='clash' ORDER BY name"); }
  function customerClashesHtml(){
    const list = customerClashes();
    if(!list.length) return "";
    return `<div class="card" id="custClashes" style="border-color:var(--warn)">
      <h3 style="margin-top:0">Customers to check</h3>
      <p class="muted">Another till already has a customer with the same phone. Merge them (this till's sales and balance move to the business's customer), or keep this one on this till only.</p>
      ${list.map(c=>{ const other = String(c.srv_error||"").split("|")[1]||"another customer"; return `
        <div class="row" style="align-items:center;margin-top:8px">
          <div style="min-width:0"><b>${escapeHtml(c.name)}</b> <span class="muted">${escapeHtml(c.phone||"")} · the business has: ${escapeHtml(other)}</span></div>
          <button class="btn btn-sm btn-primary" data-clash-merge="${c.id}" style="flex:none;width:auto">Merge</button>
          <button class="btn btn-sm btn-outline" data-clash-keep="${c.id}" style="flex:none;width:auto">Keep apart</button>
        </div>`; }).join("")}
    </div>`;
  }
  function wireCustomerClashes(scope){
    const go = (id, action)=>{
      const wrap = openModal(action==="merge"? "Merge customers" : "Keep on this till", `
        <label for="ccPass">Admin passcode</label><input class="field" id="ccPass" type="password" autocomplete="off">
        <div id="ccMsg" role="alert" style="color:var(--danger);font-weight:600;margin-top:8px"></div>
        <button class="btn btn-primary" id="ccGo" style="margin-top:10px">${action==="merge"? "Merge" : "Keep apart"}</button>`);
      wrap.querySelector("#ccGo").onclick = ()=>{
        try{ resolveCustomerClash(id, action, wrap.querySelector("#ccPass").value); wrap.remove(); render(); }
        catch(e){ wrap.querySelector("#ccMsg").textContent = e.message||String(e); }
      };
    };
    scope.querySelectorAll("[data-clash-merge]").forEach(b=> b.onclick = ()=> go(+b.dataset.clashMerge, "merge"));
    scope.querySelectorAll("[data-clash-keep]").forEach(b=> b.onclick = ()=> go(+b.dataset.clashKeep, "keep"));
  }
  // merge: this till's customer becomes the business's record (its sales and balances move to it)
  function resolveCustomerClash(localId, action, passcode){
    const admin = findAdmin(passcode||"");
    if(!admin) throw new Error("Incorrect Admin passcode. Nothing was changed.");
    const c = one("SELECT * FROM customers WHERE id=?",[localId]);
    if(!c || c.srv_status!=="clash") throw new Error("That customer has nothing to check.");
    if(action==="keep"){ run("UPDATE customers SET srv_status='local', srv_error='' WHERE id=?",[localId]); logAudit("Customer kept on this till", c.name, "by "+admin.name); }
    else {
      const uid = String(c.srv_error||"").split("|")[0];
      const target = one("SELECT * FROM customers WHERE uid=? AND id<>?",[uid, localId]);
      if(!target) throw new Error("The business's record hasn't reached this till yet. Try again after the next sync.");
      run("BEGIN");
      try{
        for(const t of ["sales","credit_payments","vouchers","credit_notes"]) run(`UPDATE ${t} SET customer_id=? WHERE customer_id=?`,[target.id, localId]);
        run("DELETE FROM customers WHERE id=?",[localId]);
        run("COMMIT");
      }catch(e){ try{ run("ROLLBACK"); }catch(_){} throw e; }
      logAudit("Customers merged", target.name, c.name+" ("+(c.phone||"")+") joined the business's record · by "+admin.name);
    }
    persist();
  }
