  // ---------------- Stock Dispatch & Receive (branch-to-branch transfers) ----------------
  // Available to every branch, including Remote: this only moves stock a
  // branch already has (or accepts stock sent to it) — it's not the same as
  // adding a brand-new product from scratch, so it isn't gated by isRemote()
  // the way Add Product / Import / Edit are. Dispatching is the Delivery Note
  // screen (dispatch-out.js); only receiving legacy pending transfers lives here.
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
    const mv = { kind:"legacy_receive", docType:"transfer", docUid:t.uid||null, ts, note:"Received from "+t.from_branch };
    if(prod){
      moveStock(Object.assign({ productId:prod.id, delta:t.qty }, mv));
    } else {
      run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [t.product_name,0,t.qty,5,t.sku||"",branch,"",0,ts,""]);
      prod = { id: one("SELECT last_insert_rowid() as id").id };
      recordStockMovement(prod.id, t.qty, mv);
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
