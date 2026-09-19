  // ---------------- Purchasing & Receiving + COGS Recovery (Main branch only) ----------------
  // Cost/financial data, same precedent as the Margin Report — this whole
  // module is hidden for Remote branches, not just gated at the action level.
  // Cart-style line items, each with a live search-as-you-type product
  // picker (reusing searchProducts exactly as the Sell screen does) so
  // staff tap a match instead of retyping a name that has to align exactly
  // with what's already in the database. Typing something with no match
  // is still allowed to stand as a brand-new product, same find-or-create
  // fallback the single-item version used.
  function recordPurchaseModal(){
    const branch = currentBranch();
    let lineSeq = 0;
    const newLine = ()=>({ id: lineSeq++, query:"", product:null, qty:"", unitCost:"" });
    let lines = [ newLine() ];

    const wrap = openModal("Record Purchase", `
      <label>Supplier</label>
      <input class="field" id="puSupplier" placeholder="e.g. Metro Wholesalers">
      <label>Note (optional)</label>
      <input class="field" id="puNote" placeholder="e.g. invoice #1234">
      <div class="hr"></div>
      <div id="puLines"></div>
      <button class="btn btn-outline btn-sm" id="puAddLine" style="margin-top:4px">+ Add Line</button>
      <button class="btn btn-primary" id="puConfirm" style="margin-top:14px">Record Purchase</button>
    `);
    const linesEl = wrap.querySelector("#puLines");

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
            ? `<p class="muted" style="margin:0 0 4px">Matched: <b>${escapeHtml(line.product.sku?line.product.sku+" — ":"")}${escapeHtml(line.product.name)}</b> <button type="button" data-clear-match="${line.id}" style="background:none;border:none;color:var(--orange);text-decoration:underline;padding:0;font-size:12px;margin-left:4px">change</button></p>`
            : `<input class="field" data-product-input="${line.id}" placeholder="Search by name or SKU, or type a new item" value="${escapeHtml(line.query)}" autocomplete="off">
               <div data-dropdown="${line.id}">${dropdownHtml(line)}</div>`}
          <div class="row" style="margin-top:8px">
            <div><label>Qty</label><input class="field" data-qty="${line.id}" type="number" min="1" value="${escapeHtml(String(line.qty))}" placeholder="0"></div>
            <div><label>Unit Cost (${currency})</label><input class="field" data-unitcost="${line.id}" type="number" step="0.01" value="${escapeHtml(String(line.unitCost))}" placeholder="0.00"></div>
          </div>
        </div>`;
    }
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
        const removeBtn = linesEl.querySelector(`[data-remove-line="${line.id}"]`);
        if(removeBtn) removeBtn.onclick=()=>{
          if(lines.length===1) lines[0] = newLine();
          else lines = lines.filter(x=>x.id!==line.id);
          renderLines();
        };
      });
    }
    renderLines();
    wrap.querySelector("#puAddLine").onclick=()=>{ lines.push(newLine()); renderLines(); };

    wrap.querySelector("#puConfirm").onclick=()=>{
      const supplier = wrap.querySelector("#puSupplier").value.trim();
      const note = wrap.querySelector("#puNote").value.trim();
      if(!supplier) return alert("Enter the supplier");
      for(let i=0;i<lines.length;i++){
        const l = lines[i];
        const typed = l.product? l.product.name : l.query.trim();
        const qty = parseInt(l.qty)||0;
        const unitCost = parseFloat(l.unitCost);
        if(!typed) return alert(`Line ${i+1}: enter or select a product`);
        if(qty<1) return alert(`Line ${i+1}: enter a quantity of at least 1`);
        if(isNaN(unitCost) || unitCost<0) return alert(`Line ${i+1}: enter a valid unit cost`);
      }
      const ts = new Date().toISOString();
      const newProductNames = [];
      lines.forEach(l=>{
        const typed = l.product? l.product.name : l.query.trim();
        const qty = parseInt(l.qty)||0;
        const unitCost = parseFloat(l.unitCost)||0;
        const totalCost = qty*unitCost;
        let prod = l.product;
        if(!prod){
          prod = one("SELECT * FROM products WHERE branch=? AND lower(sku)=lower(?)",[branch,typed])
               || one("SELECT * FROM products WHERE branch=? AND lower(name)=lower(?)",[branch,typed]);
        }
        if(prod){
          run("UPDATE products SET stock=stock+?, cost=? WHERE id=?",[qty,unitCost,prod.id]);
        } else {
          run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [typed,0,qty,5,"",branch,"",unitCost,ts,""]);
          prod = { id: one("SELECT last_insert_rowid() as id").id, name: typed, sku:"" };
          newProductNames.push(typed);
        }
        run("INSERT INTO purchases(ts,branch,user,supplier,product_id,product_name,sku,qty,unit_cost,total_cost,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          [ts,branch,sessionUser||"",supplier,prod.id,prod.name,prod.sku||"",qty,unitCost,totalCost,note]);
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES(?,?,?,?,?,?,?)",
          [ts,prod.id,prod.name,qty,`Purchased from ${supplier}`,branch,sessionUser||""]);
      });
      logAudit("Record Purchase", "", `${lines.length} item${lines.length===1?"":"s"} from ${supplier}`);
      persist(); wrap.remove(); render();
      if(newProductNames.length) alert(`${newProductNames.join(", ")} ${newProductNames.length===1?"was":"were"} created with no selling price — set ${newProductNames.length===1?"it":"them"} via Edit on the Products page.`);
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
      <button class="btn btn-primary" id="openRecordPurchase" style="margin-bottom:12px">+ Record Purchase</button>
      <h3>Recent Purchases</h3>
      ${groups.length===0? `<p class="muted">No purchases recorded yet.</p>` : groups.map(g=>{
        const groupTotal = g.items.reduce((s,it)=>s+it.total_cost,0);
        return `<div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div>
              <div style="font-weight:700">${escapeHtml(g.supplier)}</div>
              <div class="muted">${new Date(g.ts).toLocaleString()}${g.note? ` · ${escapeHtml(g.note)}` : ""}</div>
            </div>
            <div style="font-weight:700;flex:none">${currency}${groupTotal.toFixed(2)}</div>
          </div>
          <div class="hr" style="margin:8px 0"></div>
          ${g.items.map(it=>`
            <div class="product-row" style="padding:6px 0">
              <div>
                <div class="pname">${escapeHtml(it.product_name)}</div>
                <div class="pmeta">Qty ${it.qty} @ ${currency}${it.unit_cost.toFixed(2)}</div>
              </div>
              <div>${currency}${it.total_cost.toFixed(2)}</div>
            </div>`).join("")}
        </div>`;
      }).join("")}
    `;
    document.getElementById("editSeedMoney").onclick=()=>{ moreTab="settings"; render(); };
    document.getElementById("openRecordPurchase").onclick=()=>recordPurchaseModal();
  }
  // Lines recorded together via recordPurchaseModal() share one ts+supplier,
  // which is the only signal we have to regroup them for display — there's
  // no separate "purchase batch" id in the schema.
  function groupPurchases(purchases){
    const groups = {}; const order = [];
    purchases.forEach(p=>{
      const key = p.ts+"|"+p.supplier;
      if(!groups[key]){ groups[key] = { ts:p.ts, supplier:p.supplier, note:p.note, items:[] }; order.push(key); }
      groups[key].items.push(p);
    });
    return order.map(k=>groups[k]);
  }
