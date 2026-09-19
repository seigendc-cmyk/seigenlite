  // Requests / market intelligence notepad — logs stock a customer asked for
  // that isn't currently in the shop. Any branch (including Remote) can log
  // one; once another branch's data file is merged in, its requests become
  // visible here too via the branch filter, same pattern as Product List.
  //
  // Logging + the pending queue live in a shared right-side drawer (same
  // .drawer/.overlay mechanics as the cart), opened from two places: the
  // Reports page and this More → Requests page's own button — one
  // implementation, two entry points. This page itself keeps showing the
  // full history (pending + fulfilled), unchanged, as the historical view.
  function newReqLine(){ return { id: reqLineSeq++, item:"", qty:"" }; }
  function openRequestsDrawer(){
    reqLines = [ newReqLine() ];
    reqExpandedId = null;
    reqDrawerOpen = true;
    render();
  }
  function pendingReqRowsHtml(rows){
    if(rows.length===0) return `<p class="muted" style="padding:6px 4px">No pending requests.</p>`;
    return rows.map(r=>`
      <div class="card" data-req-row="${r.id}" style="padding:10px;margin-bottom:8px;cursor:pointer">
        <div class="pname">${escapeHtml(r.item_requested)}</div>
        <div class="pmeta">${escapeHtml(r.branch)} · ${new Date(r.ts).toLocaleDateString()} · logged by ${escapeHtml(r.user||"—")}</div>
        ${(r.customer_name||r.customer_phone)? `<div class="pmeta">${escapeHtml(r.customer_name||"")}${r.customer_phone?` · ${escapeHtml(r.customer_phone)}`:""}</div>` : ""}
        ${r.qty_wanted? `<div class="pmeta">Qty wanted: ${r.qty_wanted}</div>` : ""}
        ${r.notes? `<div class="pmeta">${escapeHtml(r.notes)}</div>` : ""}
        ${reqExpandedId===r.id? `
          <div class="row" style="margin-top:10px" data-req-actions>
            ${r.customer_phone? `<button type="button" class="btn btn-ghost btn-sm" data-msg-customer="${r.id}">📲 Message Customer</button>` : ""}
            <button type="button" class="btn btn-outline btn-sm" data-mark-fulfilled="${r.id}">✓ Mark Fulfilled</button>
          </div>` : ""}
      </div>`).join("");
  }
  function wireReqPendingRows(){
    document.querySelectorAll("[data-req-row]").forEach(card=>{
      card.onclick=(e)=>{
        if(e.target.closest("[data-req-actions]")) return;
        const id = +card.dataset.reqRow;
        reqExpandedId = (reqExpandedId===id)? null : id;
        renderRequestsDrawer();
      };
    });
    document.querySelectorAll("[data-msg-customer]").forEach(b=>{
      b.onclick=(e)=>{
        e.stopPropagation();
        const r = one("SELECT * FROM stock_requests WHERE id=?",[+b.dataset.msgCustomer]);
        if(!r) return;
        const msg = `Hi ${r.customer_name||"there"}, following up on your request for "${r.item_requested}" — it's arrived / being followed up on.`;
        shareWhatsApp(msg, r.customer_phone);
      };
    });
    document.querySelectorAll("[data-mark-fulfilled]").forEach(b=>{
      b.onclick=(e)=>{
        e.stopPropagation();
        run("UPDATE stock_requests SET fulfilled=1 WHERE id=?",[+b.dataset.markFulfilled]);
        persist();
        reqExpandedId = null;
        renderRequestsDrawer();
        renderStockRequestsListOnly();
      };
    });
  }
  function renderRequestsDrawer(){
    const drawer = document.getElementById("reqDrawer");
    if(!drawer) return;
    const branch = reqBranch;
    const pending = branch? all("SELECT * FROM stock_requests WHERE branch=? AND fulfilled=0 ORDER BY ts DESC",[branch])
                          : all("SELECT * FROM stock_requests WHERE fulfilled=0 ORDER BY ts DESC");
    drawer.innerHTML = `
      <div class="drawer-head"><h3 style="margin:0">Log Request</h3><button class="close-x" id="closeReqDrawer">✕</button></div>
      <div class="drawer-body">
        <label style="margin-top:0">Customer name (optional)</label>
        <input class="field" id="reqCustName" placeholder="Full name">
        <label>Customer phone (optional)</label>
        <input class="field" id="reqCustPhone" placeholder="e.g. 077xxxxxxx">
        <div class="hr"></div>
        <div id="reqLinesWrap"></div>
        <button type="button" class="btn btn-outline btn-sm" id="reqAddLine" style="margin-top:4px">+ Add Line</button>
        <label>Notes (optional)</label>
        <input class="field" id="reqNotesShared" placeholder="e.g. willing to wait, asked twice">
        <button class="btn btn-primary" id="reqSubmit" style="margin-top:12px">Log Request</button>
        <div class="hr"></div>
        <h3>Pending Requests</h3>
        <label>Branch</label>${branchSelectHtml("reqDrawerBranchSel", reqBranch)}
        <div id="reqPendingList" style="margin-top:8px">${pendingReqRowsHtml(pending)}</div>
      </div>
    `;
    document.getElementById("closeReqDrawer").onclick=()=>{ reqDrawerOpen=false; render(); };
    const linesWrap = document.getElementById("reqLinesWrap");
    function renderReqLines(){
      linesWrap.innerHTML = reqLines.map((l,i)=>`
        <div class="card" style="padding:10px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span class="muted" style="font-size:11.5px;font-weight:700">ITEM ${i+1}</span>
            <button type="button" class="close-x" data-remove-reqline="${l.id}" title="Remove line" style="font-size:15px;padding:2px 6px">✕</button>
          </div>
          <label style="margin-top:0">Item requested</label>
          <input class="field" data-req-item="${l.id}" placeholder="e.g. 13mm socket set" value="${escapeHtml(l.item)}">
          <label>Qty wanted (optional)</label>
          <input class="field" data-req-qty="${l.id}" type="number" placeholder="0" value="${escapeHtml(String(l.qty))}">
        </div>`).join("");
      reqLines.forEach(l=>{
        const itemInput = linesWrap.querySelector(`[data-req-item="${l.id}"]`);
        if(itemInput) itemInput.oninput=(e)=>{ l.item=e.target.value; };
        const qtyInput = linesWrap.querySelector(`[data-req-qty="${l.id}"]`);
        if(qtyInput) qtyInput.oninput=(e)=>{ l.qty=e.target.value; };
        const removeBtn = linesWrap.querySelector(`[data-remove-reqline="${l.id}"]`);
        if(removeBtn) removeBtn.onclick=()=>{
          if(reqLines.length===1) reqLines[0]=newReqLine();
          else reqLines = reqLines.filter(x=>x.id!==l.id);
          renderReqLines();
        };
      });
    }
    renderReqLines();
    document.getElementById("reqAddLine").onclick=()=>{ reqLines.push(newReqLine()); renderReqLines(); };
    document.getElementById("reqSubmit").onclick=()=>{
      const custName = document.getElementById("reqCustName").value.trim();
      const custPhone = document.getElementById("reqCustPhone").value.trim();
      const notes = document.getElementById("reqNotesShared").value.trim();
      const validLines = reqLines.filter(l=>l.item.trim());
      if(validLines.length===0) return alert("Enter at least one item requested");
      const ts = new Date().toISOString();
      const branchNow = currentBranch();
      validLines.forEach(l=>{
        const qty = l.qty? parseInt(l.qty) : null;
        run("INSERT INTO stock_requests(ts,branch,user,item_requested,customer_name,customer_phone,qty_wanted,notes,fulfilled) VALUES(?,?,?,?,?,?,?,?,0)",
          [ts, branchNow, sessionUser||"", l.item.trim(), custName, custPhone, qty, notes]);
      });
      persist();
      reqLines = [ newReqLine() ];
      render();
      renderStockRequestsListOnly();
    };
    document.getElementById("reqDrawerBranchSel").onchange=(e)=>{ reqBranch=e.target.value; renderRequestsDrawer(); };
    wireReqPendingRows();
  }
  function stockRequestRowsHtml(rows){
    if(rows.length===0) return `<p class="muted" style="padding:10px 4px">No requests logged yet.</p>`;
    return `<div class="card" style="padding:6px 10px">
      ${rows.map(r=>`
        <div class="product-row" style="align-items:flex-start">
          <div>
            <div class="pname">${escapeHtml(r.item_requested)}${r.fulfilled? ` <span class="pill ok">fulfilled</span>` : ""}</div>
            <div class="pmeta">${escapeHtml(r.branch)} · ${new Date(r.ts).toLocaleDateString()} · logged by ${escapeHtml(r.user||"—")}</div>
            ${(r.customer_name||r.customer_phone)? `<div class="pmeta">${escapeHtml(r.customer_name||"")}${r.customer_phone?` · ${escapeHtml(r.customer_phone)}`:""}</div>` : ""}
            ${r.qty_wanted? `<div class="pmeta">Qty wanted: ${r.qty_wanted}</div>` : ""}
            ${r.notes? `<div class="pmeta">${escapeHtml(r.notes)}</div>` : ""}
          </div>
          ${r.fulfilled? "" : `<button class="btn btn-sm btn-outline" data-fulfil="${r.id}" style="flex:none">Mark fulfilled</button>`}
        </div>`).join("")}
    </div>`;
  }
  function renderStockRequestsListOnly(){
    const branch = reqBranch;
    const rows = branch? all("SELECT * FROM stock_requests WHERE branch=? ORDER BY ts DESC",[branch])
                        : all("SELECT * FROM stock_requests ORDER BY ts DESC");
    const target = document.getElementById("reqResults");
    if(!target) return;
    target.innerHTML = stockRequestRowsHtml(rows);
    wireStockRequestButtons(target);
  }
  function wireStockRequestButtons(scope){
    scope.querySelectorAll("[data-fulfil]").forEach(b=>{
      b.onclick=()=>{
        run("UPDATE stock_requests SET fulfilled=1 WHERE id=?",[+b.dataset.fulfil]);
        persist(); renderStockRequestsListOnly();
      };
    });
  }
  function renderStockRequests(main){
    const branch = reqBranch;
    const rows = branch? all("SELECT * FROM stock_requests WHERE branch=? ORDER BY ts DESC",[branch])
                        : all("SELECT * FROM stock_requests ORDER BY ts DESC");
    main.innerHTML = `
      <p class="muted">A quick notepad for stock customers asked for that you didn't have — useful for deciding what to order next, and for spotting demand across branches once their data is merged in.</p>
      <button class="btn btn-primary" id="openLogRequest" style="margin-bottom:12px">+ Log Request</button>
      <label>Branch</label>${branchSelectHtml("reqBranchSel", reqBranch)}
      <div style="height:10px"></div>
      <div id="reqResults">${stockRequestRowsHtml(rows)}</div>
    `;
    document.getElementById("openLogRequest").onclick=()=>openRequestsDrawer();
    document.getElementById("reqBranchSel").onchange=(e)=>{ reqBranch = e.target.value; renderStockRequestsListOnly(); };
    wireStockRequestButtons(main);
  }

