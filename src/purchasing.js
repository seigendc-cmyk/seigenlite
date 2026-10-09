  // ---------------- Purchasing & Receiving + COGS Recovery (Main branch only) ----------------
  // Cost/financial data, same precedent as the Margin Report — this whole
  // module is hidden for Remote branches, not just gated at the action level.
  // Cart-style line items, each with a live search-as-you-type product
  // picker (reusing searchProducts exactly as the Sell screen does) so
  // staff tap a match instead of retyping a name that has to align exactly
  // with what's already in the database. Typing something with no match
  // is still allowed to stand as a brand-new product, same find-or-create
  // fallback the single-item version used.
  // Dispatch & GRV B2 (supplier-grv.js): a purchase is a supplier GRV: the
  // supplier comes from the business's list, the invoice number is required
  // (the same invoice twice is refused), a delivery cost is landed on the
  // lines by value, and a line may carry a new selling price (Admin passcode).
  function recordPurchaseModal(){
    const branch = currentBranch();
    let lineSeq = 0;
    const newLine = ()=>({ id: lineSeq++, query:"", product:null, qty:"", unitCost:"", newPrice:"" });
    let lines = [ newLine() ];
    let supplierUid = "";

    const wrap = openModal("Receive from a supplier (GRV)", `
      <label>Supplier</label>
      <div style="display:flex;gap:6px"><select class="field" id="puSupplier" style="flex:1"></select><button type="button" class="btn btn-outline btn-sm" id="puNewSupplier">+ New</button></div>
      <div id="puNewSupplierBox"></div>
      <label>Invoice number</label>
      <input class="field" id="puInvoice" maxlength="40" placeholder="As printed on the supplier's invoice" autocomplete="off">
      <div class="row">
        <div><label>Delivery cost (optional)</label><input class="field" id="puDelCost" inputmode="decimal" placeholder="0.00"></div>
        <div><label>Currency</label><input class="field" id="puDelCur" maxlength="3" value="${escapeHtml(getSetting("ds_currency","USD"))}"></div>
      </div>
      <label>Note (optional)</label>
      <input class="field" id="puNote" placeholder="e.g. two boxes, delivered by van">
      <div class="hr"></div>
      <div id="puLines"></div>
      <button class="btn btn-outline btn-sm" id="puAddLine" style="margin-top:4px">+ Add Line</button>
      <div id="puPassBox" style="display:none"><label>Admin passcode (for the new selling prices)</label><input class="field" id="puPass" type="password" autocomplete="off"></div>
      <div id="puErr" style="color:#b42318;font-size:12.5px;margin-top:6px"></div>
      <button class="btn btn-primary" id="puConfirm" style="margin-top:14px">Receive the goods</button>
    `);
    const linesEl = wrap.querySelector("#puLines");
    const supSel = wrap.querySelector("#puSupplier");
    function renderSuppliers(){
      const list = sgSuppliers();
      supSel.innerHTML = `<option value="">Choose the supplier…</option>` + list.map(s=>`<option value="${escapeHtml(s.uid)}" ${s.uid===supplierUid?"selected":""}>${escapeHtml(s.name)}</option>`).join("");
    }
    renderSuppliers();
    supSel.onchange = ()=>{ supplierUid = supSel.value; };
    wrap.querySelector("#puNewSupplier").onclick = ()=>{
      const box = wrap.querySelector("#puNewSupplierBox");
      box.innerHTML = `<div class="card" style="padding:8px;margin-top:6px"><label style="margin-top:0">New supplier's name</label><input class="field" id="puSupName" maxlength="80">
        <label>Phone (optional)</label><input class="field" id="puSupPhone" inputmode="tel">
        <div style="display:flex;gap:6px;margin-top:6px"><button type="button" class="btn btn-sm btn-primary" id="puSupSave">Add supplier</button><button type="button" class="btn btn-sm btn-ghost" id="puSupCancel">Cancel</button></div></div>`;
      box.querySelector("#puSupCancel").onclick = ()=>{ box.innerHTML = ""; };
      box.querySelector("#puSupSave").onclick = ()=>{
        try{ const s = sgSaveSupplier({ name:box.querySelector("#puSupName").value, phone:box.querySelector("#puSupPhone").value }); supplierUid = s.uid; persist(); box.innerHTML = ""; renderSuppliers(); if(typeof sgSendPending==="function") sgSendPending(); }
        catch(e){ wrap.querySelector("#puErr").textContent = e.message||String(e); }
      };
    };

    function dropdownHtml(line){
      if(line.product || !line.query.trim()) return "";
      const matches = searchProducts(line.query, branch).slice(0,6);
      return `<div class="card" style="padding:4px;margin-top:4px;max-height:150px;overflow-y:auto">
        ${matches.length? matches.map(m=>`<button type="button" data-pick="${line.id}:${m.id}" style="display:block;width:100%;text-align:left;background:none;border:none;padding:8px;font-size:13px;border-bottom:1px solid var(--border)">${escapeHtml(m.sku?m.sku+" — ":"")}${escapeHtml(m.name)}</button>`).join("")
                  : `<div class="muted" style="padding:6px;font-size:12.5px">No match — "${escapeHtml(line.query.trim())}" will be added as a new product</div>`}
      </div>`;
    }
    function wireDropdown(line){
      const dd = linesEl.querySelector(`[data-dropdown="${line.id}"]`);
      if(!dd) return;
      dd.querySelectorAll("[data-pick]").forEach(btn=>{
        btn.onclick=()=>{
          const [,pid] = btn.dataset.pick.split(":");
          line.product = one("SELECT * FROM products WHERE id=?",[+pid]);
          line.query = line.product.name;
          renderLines();
        };
      });
    }
    function lineRowHtml(line, idx){
      return `
        <div class="card" style="padding:10px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span class="muted" style="font-size:11.5px;font-weight:700">LINE ${idx+1}</span>
            <button type="button" class="close-x" data-remove-line="${line.id}" title="Remove line" style="font-size:15px;padding:2px 6px">✕</button>
          </div>
          <label style="margin-top:0">Product</label>
          ${line.product
            ? `<p class="muted" style="margin:0 0 4px">Matched: <b>${escapeHtml(line.product.sku?line.product.sku+" — ":"")}${escapeHtml(line.product.name)}</b> · selling ${currency}${Number(line.product.price||0).toFixed(2)} <button type="button" data-clear-match="${line.id}" style="background:none;border:none;color:var(--orange);text-decoration:underline;padding:0;font-size:12px;margin-left:4px">change</button></p>`
            : `<input class="field" data-product-input="${line.id}" placeholder="Search by name or SKU, or type a new item" value="${escapeHtml(line.query)}" autocomplete="off">
               <div data-dropdown="${line.id}">${dropdownHtml(line)}</div>`}
          <div class="row" style="margin-top:8px">
            <div><label>Qty</label><input class="field" data-qty="${line.id}" type="number" min="1" value="${escapeHtml(String(line.qty))}" placeholder="0"></div>
            <div><label>Unit Cost (${currency})</label><input class="field" data-unitcost="${line.id}" type="number" step="0.01" value="${escapeHtml(String(line.unitCost))}" placeholder="0.00"></div>
            <div><label>New selling price</label><input class="field" data-newprice="${line.id}" type="number" step="0.01" value="${escapeHtml(String(line.newPrice))}" placeholder="unchanged"></div>
          </div>
        </div>`;
    }
    function showPass(){ wrap.querySelector("#puPassBox").style.display = lines.some(l=>String(l.newPrice).trim()!=="")? "" : "none"; }
    function renderLines(){
      linesEl.innerHTML = lines.map((l,i)=>lineRowHtml(l,i)).join("");
      lines.forEach(line=>{
        const input = linesEl.querySelector(`[data-product-input="${line.id}"]`);
        if(input) input.oninput=(e)=>{
          line.query = e.target.value;
          line.product = null;
          const dd = linesEl.querySelector(`[data-dropdown="${line.id}"]`);
          if(dd){ dd.innerHTML = dropdownHtml(line); wireDropdown(line); }
        };
        wireDropdown(line);
        const clearBtn = linesEl.querySelector(`[data-clear-match="${line.id}"]`);
        if(clearBtn) clearBtn.onclick=()=>{ line.product=null; renderLines(); };
        const qtyInput = linesEl.querySelector(`[data-qty="${line.id}"]`);
        if(qtyInput) qtyInput.oninput=(e)=>{ line.qty = e.target.value; };
        const costInput = linesEl.querySelector(`[data-unitcost="${line.id}"]`);
        if(costInput) costInput.oninput=(e)=>{ line.unitCost = e.target.value; };
        const priceInput = linesEl.querySelector(`[data-newprice="${line.id}"]`);
        if(priceInput) priceInput.oninput=(e)=>{ line.newPrice = e.target.value; showPass(); };
        const removeBtn = linesEl.querySelector(`[data-remove-line="${line.id}"]`);
        if(removeBtn) removeBtn.onclick=()=>{
          if(lines.length===1) lines[0] = newLine();
          else lines = lines.filter(x=>x.id!==line.id);
          renderLines();
        };
      });
      showPass();
    }
    renderLines();
    wrap.querySelector("#puAddLine").onclick=()=>{ lines.push(newLine()); renderLines(); };

    let busy = false;
    wrap.querySelector("#puConfirm").onclick=async ()=>{
      if(busy) return;
      const err = wrap.querySelector("#puErr");
      err.textContent = "";
      const o = {
        supplierUid, invoiceNo: wrap.querySelector("#puInvoice").value, note: wrap.querySelector("#puNote").value,
        delivery: { cost: wrap.querySelector("#puDelCost").value.trim()===""? 0 : Number(wrap.querySelector("#puDelCost").value), currency: wrap.querySelector("#puDelCur").value },
        passcode: wrap.querySelector("#puPass").value,
        lines: lines.map(l=>({ product:l.product, name:l.product? l.product.name : l.query.trim(),
          qty: /^\d+$/.test(String(l.qty).trim())? Number(l.qty) : NaN, unitCost: String(l.unitCost).trim()===""? NaN : Number(l.unitCost),
          newPrice: String(l.newPrice).trim()===""? null : Number(l.newPrice) }))
      };
      busy = true;
      const btn = wrap.querySelector("#puConfirm"); btn.disabled = true; btn.textContent = "Receiving…";
      let r;
      try{ r = await sgPostGrv(o); }
      catch(e){ busy = false; btn.disabled = false; btn.textContent = "Receive the goods"; err.textContent = e.message||String(e); return; }
      if(o.delivery.cost>0) setSetting("ds_currency", String(o.delivery.currency).trim().toUpperCase());
      wrap.remove(); render();
      const created = r.lines.filter(l=>l.created && l.new_price==null).map(l=>l.name);
      alert(r.grv.text+": goods received."+(r.warning? "\n\n"+r.warning : "")
        +(created.length? "\n\n"+created.join(", ")+" "+(created.length===1?"was":"were")+" created with no selling price — set "+(created.length===1?"it":"them")+" via Edit on the Products page." : ""));
    };
  }
  function renderPurchasing(main){
    const branch = currentBranch();
    const seedMoney = parseFloat(getSetting("seed_money","0"))||0;
    const cogsRecovered = one(`SELECT COALESCE(SUM(si.cost*si.qty),0) as t FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.branch=?`,[branch]).t;
    const pctRecovered = seedMoney>0? (cogsRecovered/seedMoney*100) : null;
    const fullyRecovered = seedMoney>0 && cogsRecovered>=seedMoney;
    const purchases = all("SELECT * FROM purchases WHERE branch=? ORDER BY ts DESC LIMIT 200",[branch]);
    const groups = groupPurchases(purchases);
    const SRV = { queued:"waiting to send to seiGEN", sent:"on seiGEN", error:"not sent to seiGEN", reversed:"TAKEN BACK: the invoice was already received" };
    main.innerHTML = `
      <div class="card">
        <h3>Capital Recovery</h3>
        <div class="subline"><span>Seed Money / Starting Capital</span><span>${currency}${seedMoney.toFixed(2)}</span></div>
        <div class="subline"><span>Total COGS Recovered</span><span>${currency}${cogsRecovered.toFixed(2)}</span></div>
        <div class="subline"><span>% Recovered</span><span>${pctRecovered===null? "—" : pctRecovered.toFixed(1)+"%"}</span></div>
        ${fullyRecovered
          ? `<div class="subline"><span>Status</span><span style="color:var(--success);font-weight:700">Fully recovered — ${currency}${(cogsRecovered-seedMoney).toFixed(2)} surplus</span></div>`
          : `<div class="subline"><span>Remaining to Recover</span><span>${currency}${Math.max(0,seedMoney-cogsRecovered).toFixed(2)}</span></div>`}
        <button class="btn btn-outline btn-sm" id="editSeedMoney" style="margin-top:8px">Edit Seed Money in Settings</button>
      </div>
      <button class="btn btn-primary" id="openRecordPurchase" style="margin-bottom:12px">+ Receive from a supplier (GRV)</button>
      <h3>Recent Purchases</h3>
      ${groups.length===0? `<p class="muted">No purchases recorded yet.</p>` : groups.map(g=>{
        const groupTotal = g.items.reduce((s,it)=>s+it.total_cost,0);
        const first = g.items[0], dc = g.items.reduce((s,it)=>s+(Number(it.delivery_cost)||0),0);
        return `<div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div>
              <div style="font-weight:700">${escapeHtml(g.supplier)}</div>
              <div class="muted">${new Date(g.ts).toLocaleString()}${g.note? ` · ${escapeHtml(g.note)}` : ""}</div>
              ${first.grv_no? `<div class="muted pu-grv">${escapeHtml(docDisplay("GRV",first.grv_no,first.grv_till))} · invoice ${escapeHtml(first.invoice_no||"")}${dc>0? " · delivery "+dc.toFixed(2) : ""}${first.srv_status? " · "+escapeHtml(SRV[first.srv_status]||first.srv_status) : ""}</div>` : ""}
            </div>
            <div style="font-weight:700;flex:none">${currency}${groupTotal.toFixed(2)}</div>
          </div>
          <div class="hr" style="margin:8px 0"></div>
          ${g.items.map(it=>`
            <div class="product-row" style="padding:6px 0">
              <div>
                <div class="pname">${escapeHtml(it.product_name)}</div>
                <div class="pmeta">Qty ${it.qty} @ ${currency}${it.unit_cost.toFixed(2)}${it.landed_cost!=null && Math.abs(it.landed_cost-it.unit_cost)>0.00005? " · landed "+currency+Number(it.landed_cost).toFixed(2) : ""}</div>
              </div>
              <div>${currency}${it.total_cost.toFixed(2)}</div>
            </div>`).join("")}
        </div>`;
      }).join("")}
    `;
    document.getElementById("editSeedMoney").onclick=()=>{ moreTab="settings"; render(); };
    document.getElementById("openRecordPurchase").onclick=()=>recordPurchaseModal();
  }
  // Lines recorded together share one ts+supplier (and, since B2, one GRV),
  // which is how they are regrouped for display.
  function groupPurchases(purchases){
    const groups = {}; const order = [];
    purchases.forEach(p=>{
      const key = p.grv_uid || (p.ts+"|"+p.supplier);
      if(!groups[key]){ groups[key] = { ts:p.ts, supplier:p.supplier, note:p.note, items:[] }; order.push(key); }
      groups[key].items.push(p);
    });
    return order.map(k=>groups[k]);
  }
