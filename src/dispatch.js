  // ---------------- Stock Dispatch & Receive (branch-to-branch transfers) ----------------
  // Available to every branch, including Remote: this only moves stock a
  // branch already has (or accepts stock sent to it) — it's not the same as
  // adding a brand-new product from scratch, so it isn't gated by isRemote()
  // the way Add Product / Import / Edit are.
  function dispatchStockModal(){
    const branch = currentBranch();
    const products = all("SELECT * FROM products WHERE branch=? ORDER BY name",[branch]);
    if(products.length===0){ alert("No products in this branch to dispatch."); return; }
    const branches = listBranches().filter(b=>b!==branch);
    let lineSeq = 0;
    const newLine = ()=>({ id: lineSeq++, query:"", product:null, qty:"" });
    let lines = [ newLine() ];

    const wrap = openModal("Dispatch Stock", `
      <label>Destination branch</label>
      <input class="field" id="dsBranch" list="dsBranchList" placeholder="e.g. Branch 2">
      <datalist id="dsBranchList">${branches.map(b=>`<option value="${escapeHtml(b)}">`).join("")}</datalist>
      <label>Note (optional)</label>
      <input class="field" id="dsNote" placeholder="e.g. for weekend promo">
      <div class="hr"></div>
      <div id="dsLines"></div>
      <button type="button" class="btn btn-outline btn-sm" id="dsAddLine" style="margin-top:4px">+ Add Line</button>
      <button class="btn btn-primary" id="dsConfirm" style="margin-top:14px">Dispatch</button>
    `);
    const linesEl = wrap.querySelector("#dsLines");

    function dropdownHtml(line){
      if(line.product || !line.query.trim()) return "";
      const matches = searchProducts(line.query, branch).slice(0,6);
      return `<div class="card" style="padding:4px;margin-top:4px;max-height:150px;overflow-y:auto">
        ${matches.length? matches.map(m=>`<button type="button" data-pick="${line.id}:${m.id}" style="display:block;width:100%;text-align:left;background:none;border:none;padding:8px;font-size:13px;border-bottom:1px solid var(--border)">${escapeHtml(m.sku?m.sku+" — ":"")}${escapeHtml(m.name)} (${m.stock} in stock)</button>`).join("")
                    : `<div class="muted" style="padding:6px;font-size:12.5px">No matching product in this branch</div>`}
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
            ? `<p class="muted" style="margin:0 0 4px">Matched: <b>${escapeHtml(line.product.sku?line.product.sku+" — ":"")}${escapeHtml(line.product.name)}</b> (${line.product.stock} in stock) <button type="button" data-clear-match="${line.id}" style="background:none;border:none;color:var(--orange);text-decoration:underline;padding:0;font-size:12px;margin-left:4px">change</button></p>`
            : `<input class="field" data-product-input="${line.id}" placeholder="Search by name or SKU" value="${escapeHtml(line.query)}" autocomplete="off">
               <div data-dropdown="${line.id}">${dropdownHtml(line)}</div>`}
          <label>Qty</label>
          <input class="field" data-qty="${line.id}" type="number" min="1" value="${escapeHtml(String(line.qty))}" placeholder="0">
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
        const removeBtn = linesEl.querySelector(`[data-remove-line="${line.id}"]`);
        if(removeBtn) removeBtn.onclick=()=>{
          if(lines.length===1) lines[0] = newLine();
          else lines = lines.filter(x=>x.id!==line.id);
          renderLines();
        };
      });
    }
    renderLines();
    wrap.querySelector("#dsAddLine").onclick=()=>{ lines.push(newLine()); renderLines(); };

    wrap.querySelector("#dsConfirm").onclick=()=>{
      const toBranch = wrap.querySelector("#dsBranch").value.trim();
      const note = wrap.querySelector("#dsNote").value.trim();
      if(!toBranch) return alert("Enter the destination branch");
      if(toBranch===branch) return alert("Destination branch must be different from the current branch");
      for(let i=0;i<lines.length;i++){
        const l = lines[i];
        if(!l.product) return alert(`Line ${i+1}: select a product`);
        const qty = parseInt(l.qty)||0;
        if(qty<1 || qty>l.product.stock) return alert(`Line ${i+1}: enter a quantity between 1 and ${l.product.stock} (current stock)`);
      }
      const ts = new Date().toISOString();
      lines.forEach(l=>{
        const qty = parseInt(l.qty)||0;
        run("UPDATE products SET stock=stock-? WHERE id=?",[qty,l.product.id]);
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES(?,?,?,?,?,?,?)",
          [ts,l.product.id,l.product.name,-qty,`Dispatched to ${toBranch}`,branch,sessionUser||""]);
        run(`INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status)
             VALUES(?,?,?,?,?,?,?,?,'Dispatched')`,
          [ts,branch,toBranch,l.product.name,l.product.sku||"",qty,note,sessionUser||""]);
      });
      logAudit("Dispatch Stock", "", `${lines.length} item${lines.length===1?"":"s"} to ${toBranch}`);
      persist();
      // Lock the file and ship it: every dispatch, regardless of how many
      // lines it contains, ends with exactly ONE export — the sender hands
      // the recipient a data file to merge in (Settings) before they
      // Receive the stock.
      downloadDb(exportFilename("Export", toBranch));
      wrap.querySelector(".modal-body").innerHTML = `
        <div class="box" style="text-align:center">
          <p style="font-size:16px;font-weight:700;margin:0 0 6px">Dispatched</p>
          <p class="muted" style="margin:0">A data file has been downloaded — send it to ${escapeHtml(toBranch)} (WhatsApp, email, USB, however you'd normally share a file) so they can merge it in under Settings and then Receive the stock on their device.</p>
        </div>
        <button class="btn btn-primary" id="dsDone" style="margin-top:12px">Done</button>
      `;
      wrap.querySelector("#dsDone").onclick=()=>{ wrap.remove(); render(); };
    };
  }
  function pendingTransfersCount(){
    return one("SELECT COUNT(*) as c FROM stock_transfers WHERE to_branch=? AND status='Dispatched' AND dn_no IS NULL",[currentBranch()]).c;
  }
  // Receiving a transfer addressed to this branch matches an existing product
  // by SKU first (case-insensitive), falling back to exact name — and if
  // neither matches, creates a new product for this branch. That create path
  // is a deliberate, narrow exception to "Remote can't add products": accepting
  // a transfer that was explicitly sent to you is not the same as self-service
  // adding new inventory from scratch.
  function receiveTransfer(transferId){
    const t = one("SELECT * FROM stock_transfers WHERE id=?",[transferId]);
    // Lines that belong to a Delivery Note are received through the DN/GRV flow
    // (Phase 3), never here — receiving them twice would double-count stock.
    if(!t || t.status!=="Dispatched" || t.dn_no!=null) return;
    const branch = currentBranch();
    let prod = t.sku? one("SELECT * FROM products WHERE branch=? AND lower(sku)=lower(?)",[branch,t.sku]) : null;
    if(!prod) prod = one("SELECT * FROM products WHERE branch=? AND lower(name)=lower(?)",[branch,t.product_name]);
    const ts = new Date().toISOString();
    if(prod){
      run("UPDATE products SET stock=stock+? WHERE id=?",[t.qty,prod.id]);
    } else {
      run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [t.product_name,0,t.qty,5,t.sku||"",branch,"",0,ts,""]);
      prod = { id: one("SELECT last_insert_rowid() as id").id };
    }
    run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES(?,?,?,?,?,?,?)",
      [ts,prod.id,t.product_name,t.qty,`Received from ${t.from_branch}`,branch,sessionUser||""]);
    run("UPDATE stock_transfers SET status='Received', received_ts=?, received_user=? WHERE id=?",[ts,sessionUser||"",transferId]);
    logAudit("Receive Stock", t.product_name, `${t.qty} from ${t.from_branch}`);
    persist();
  }
  function receiveStockModal(){
    const wrap = openModal("Receive Stock", "");
    const body = wrap.querySelector(".modal-body");
    function renderList(){
      const pending = all("SELECT * FROM stock_transfers WHERE to_branch=? AND status='Dispatched' AND dn_no IS NULL ORDER BY ts",[currentBranch()]);
      body.innerHTML = pending.length===0? `<p class="muted">No pending transfers.</p>` :
        pending.map(t=>`
          <div class="product-row" style="align-items:flex-start">
            <div>
              <div class="pname">${escapeHtml(t.sku?t.sku+" — ":"")}${escapeHtml(t.product_name)}</div>
              <div class="pmeta">Qty: ${t.qty} · From ${escapeHtml(t.from_branch)} · ${new Date(t.ts).toLocaleDateString()}</div>
              ${t.note? `<div class="pmeta">${escapeHtml(t.note)}</div>` : ""}
            </div>
            <button class="btn btn-sm btn-primary" data-receive="${t.id}" style="flex:none">Receive</button>
          </div>`).join("");
      body.querySelectorAll("[data-receive]").forEach(b=>{
        b.onclick=()=>{ receiveTransfer(+b.dataset.receive); renderList(); render(); };
      });
    }
    renderList();
  }
