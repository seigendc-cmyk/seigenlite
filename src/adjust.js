  // ---------------- Stock adjustments with a reason (Phase 4b) ----------------
  // Any branch, main or remote, can record lost / damaged / expired / stolen / miscounted
  // stock. Every adjustment needs an Admin passcode and a note, moves stock and writes
  // ONE ledger row (stock_received) plus one stock_adjustments row in a single
  // transaction. It never touches price or cost, and recorded sales are never changed.

  const ADJ_REASONS = ["Lost in transit","Damaged","Expired","Theft","Miscount correction","Other"];
  const ADJ_REDUCE_ONLY = ["Lost in transit","Damaged","Expired","Theft"];
  const ADJ_MAX_QTY = 1000000;
  // System-only: posted by the cancel/reissue flow, never selectable in the Adjust stock modal.
  const ADJ_SYSTEM_REASONS = ["Dispatch cancelled"];
  const ADJ_WRITEOFF_REASONS = ["Lost in transit","Damaged","Other"];        // what a cancelled DN's difference may be written off as

  // ---- pure part ----
  // A signed whole number as typed ("-3", "+2", "4"). -> integer | null
  function parseAdjustQty(raw){
    const s = String(raw==null?"":raw).trim();
    if(!/^[+-]?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n)? n : null;
  }
  // "" = fine, otherwise the plain reason it can't be recorded. stock = current stock.
  function adjustmentProblem(o){
    if(!ADJ_REASONS.includes(o.reason)) return "Choose a reason.";
    const q = parseAdjustQty(o.qty);
    if(q===null) return "Enter the quantity change as a whole number, for example -3.";
    if(q===0) return "The quantity change can't be zero.";
    if(Math.abs(q)>ADJ_MAX_QTY) return "That quantity is too large.";
    if(ADJ_REDUCE_ONLY.includes(o.reason) && q>0) return o.reason+" can only reduce stock. Enter a negative number, for example -"+q+".";
    if(!String(o.note==null?"":o.note).trim()) return "Write a note saying what happened.";
    const stock = Number.isInteger(o.stock)? o.stock : 0;
    if(stock+q<0) return "Stock can't go below zero: only "+stock+" in stock.";
    return "";
  }
  // Text for the preview line: "Stock 25 -> 22", or the problem.
  function adjustPreviewText(stock, qtyRaw, reason, note){
    const q = parseAdjustQty(qtyRaw);
    if(q===null || q===0) return "";
    const bad = adjustmentProblem({ reason, qty:qtyRaw, note:"x", stock });
    return bad? bad : "Stock "+stock+" -> "+(stock+q);
  }
  // Value of an adjustment at MAIN's cost, by product code. mainProducts: [{sku,cost}].
  // Blank (null) when there is no code, no main product, several main products share the code,
  // or main has no cost for it. Reductions come out negative.
  function buildMainCostIndex(mainProducts){
    const idx = new Map();
    mainProducts.forEach(p=>{
      const k = String(p.sku||"").trim().toLowerCase();
      if(!k) return;
      idx.set(k, idx.has(k)? { ambiguous:true } : { cost:Number(p.cost)||0 });
    });
    return idx;
  }
  function adjustmentValue(delta, code, idx){
    const e = idx.get(String(code||"").trim().toLowerCase());
    if(!e || e.ambiguous || !(e.cost>0)) return null;
    return Math.round(delta*e.cost*100)/100;
  }
  // rows: stock_adjustments rows. filter: { branch, reason, fromMs, toMs }
  // -> { rows:[{...row, value}], totals:[{reason,count,units,value}], unvalued }
  function adjustmentReportData(rows, mainProducts, f){
    f = f||{};
    const idx = buildMainCostIndex(mainProducts);
    const out = rows.filter(r=>{
      if(f.branch && String(r.branch).toLowerCase()!==String(f.branch).toLowerCase()) return false;
      if(f.reason && r.reason!==f.reason) return false;
      const t = Date.parse(r.ts);
      if(f.fromMs!=null && !Number.isNaN(t) && t<f.fromMs) return false;
      if(f.toMs!=null && !Number.isNaN(t) && t>f.toMs) return false;
      return true;
    }).sort((a,b)=>(Date.parse(a.ts)||0)-(Date.parse(b.ts)||0))
      .map(r=>Object.assign({}, r, { value:adjustmentValue(r.qty_delta, r.product_code, idx) }));
    const totals = [];
    ADJ_REASONS.concat([...new Set(out.map(r=>r.reason))].filter(x=>!ADJ_REASONS.includes(x))).forEach(reason=>{
      const rs = out.filter(r=>r.reason===reason);
      if(!rs.length) return;
      const valued = rs.filter(r=>r.value!=null);
      totals.push({ reason, count:rs.length, units:rs.reduce((s,r)=>s+r.qty_delta,0),
        value:valued.length? Math.round(valued.reduce((s,r)=>s+r.value,0)*100)/100 : null });    // blank, not 0.00, when nothing could be valued
    });
    return { rows:out, totals, unvalued:out.filter(r=>r.value==null).length };
  }

  // ---- database side ----
  // Everything happens in ONE synchronous transaction; the caller awaits persist() after.
  // Any throw rolls back the stock change, the ledger row, the adjustment row, the number
  // and the audit line together.
  // o: { productId, reason, qty, note, passcode, now }
  // The synchronous core shared by user adjustments and the cancel/reissue postings: the stock change,
  // the adjustment row and the ONE ledger row. No transaction of its own; the caller owns BEGIN/COMMIT.
  // o: { product, delta, reason, note, admin, ts, dnBranchId?, dnNo? } -> { n, text }
  function writeAdjustment(o){
    const branch = currentBranch(), branchId = getBranchId(), p = o.product;
    const adj = reserveDocNumber("ADJ");
    run("UPDATE products SET stock=stock+? WHERE id=?",[o.delta,p.id]);                 // quantity only: never price or cost
    run(`INSERT INTO stock_adjustments(branch,branch_id,adj_no,product_code,product_name,qty_delta,reason,note,by_user,authorised_by,ts,dn_branch_id,dn_no)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [branch,branchId,adj.n,p.sku||"",p.name,o.delta,o.reason,o.note,String(sessionUser||""),o.admin,o.ts,o.dnBranchId||null,o.dnNo==null?null:o.dnNo]);
    run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user,adj_branch_id,adj_no) VALUES(?,?,?,?,?,?,?,?,?)",
      [o.ts,p.id,p.name,o.delta,"Adjustment "+adj.text+": "+o.reason+" - "+o.note,branch,String(sessionUser||""),branchId,adj.n]);
    return adj;
  }
  function commitAdjustment(o){
    requireSignedIn();
    if(!hasAdminPasscode()) throw new Error(NO_ADMIN_PASSCODE_MSG);
    const admin = findAdmin(o.passcode);
    if(!admin) throw new Error("Incorrect Admin passcode.");
    const branch = currentBranch(), branchId = getBranchId();
    const now = o.now || new Date(), ts = now.toISOString();
    db.run("BEGIN");
    try{
      const p = one("SELECT * FROM products WHERE id=? AND branch=?",[o.productId,branch]);
      if(!p) throw new Error("That product is not in this branch.");
      const bad = adjustmentProblem({ reason:o.reason, qty:o.qty, note:o.note, stock:p.stock });
      if(bad) throw new Error(bad);
      const q = parseAdjustQty(o.qty), note = String(o.note).trim();
      const adj = writeAdjustment({ product:p, delta:q, reason:o.reason, note, admin:admin.name, ts });
      logAudit("Stock adjustment", p.name, (p.sku||"no code")+": "+o.reason+" "+(q>0?"+":"")+q+" ("+p.stock+" -> "+(p.stock+q)+"), "+note+" (authorised by "+admin.name+")");
      db.run("COMMIT");
      return { adjNo:adj.n, adjText:adj.text, product:p, old:p.stock, new:p.stock+q, delta:q, admin:admin.name };
    }catch(e){
      try{ db.run("ROLLBACK"); }catch(_){}
      throw e;
    }
  }
  function adjustmentRows(){ return all("SELECT * FROM stock_adjustments ORDER BY ts DESC, id DESC"); }
  // main only: every merged adjustment valued at main's cost
  function adjustmentReport(f){
    const products = all("SELECT sku,cost FROM products WHERE branch=?",[currentBranch()]);
    return adjustmentReportData(all("SELECT * FROM stock_adjustments"), products, f);
  }

  // ---- screens ----
  function openAdjustStockModal(product){
    try{ requireSignedIn(); }catch(e){ alert(e.message); return; }
    if(!hasAdminPasscode()){ alert(NO_ADMIN_PASSCODE_MSG); return; }
    const p = one("SELECT * FROM products WHERE id=?",[product.id]) || product;
    const wrap = openModal("Adjust stock", `
      <p style="margin:0 0 2px"><b>${escapeHtml(p.name)}</b></p>
      <p class="muted" style="margin:0 0 8px">${escapeHtml(p.sku||"no code")} · in stock now: <b>${p.stock}</b></p>
      <label style="margin-top:0">Reason</label>
      <select class="field" id="aReason">${ADJ_REASONS.map(r=>`<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("")}</select>
      <label>Quantity change (whole number)</label>
      <input class="field" id="aQty" inputmode="numeric" autocomplete="off" placeholder="e.g. -3">
      <div class="muted" id="aHint" style="font-size:12px;margin-top:4px"></div>
      <div id="aPreview" style="font-weight:700;margin:6px 0"></div>
      <label>Note (what happened)</label>
      <textarea class="field" id="aNote" rows="2"></textarea>
      <label>Admin passcode</label>
      <input class="field" id="aPass" type="password" autocomplete="off" placeholder="Required for every adjustment">
      <div id="aErr" style="color:#b42318;font-size:12.5px;margin-top:6px"></div>
      <button class="btn btn-primary" id="aSave" style="margin-top:10px">Record adjustment</button>`);
    const $q = (s)=>wrap.querySelector(s);
    function refresh(){
      const reason = $q("#aReason").value;
      $q("#aHint").textContent = ADJ_REDUCE_ONLY.includes(reason)? reason+" can only reduce stock (use a negative number)." : reason+" can increase or reduce stock.";
      const t = adjustPreviewText(p.stock, $q("#aQty").value, reason);
      $q("#aPreview").textContent = t; $q("#aPreview").style.color = /^Stock \d+ ->/.test(t)? "" : "#b42318";
    }
    ["#aReason","#aQty"].forEach(s=>{ $q(s).oninput=refresh; $q(s).onchange=refresh; });
    refresh();
    let busy = false;
    $q("#aSave").onclick=async ()=>{
      if(busy) return; busy = true;
      try{
        commitAdjustment({ productId:p.id, reason:$q("#aReason").value, qty:$q("#aQty").value, note:$q("#aNote").value, passcode:$q("#aPass").value });
      }catch(e){ $q("#aErr").textContent = e.message||String(e); busy = false; return; }
      try{ await persist(); }catch(e){}
      wrap.remove(); render();
    };
  }

  // Adjustments recorded ON THIS DEVICE (a main device also holds merged ones, which live in the report).
  function openAdjustmentsHistory(){
    const wrap = openModal("Adjustments", "");
    const body = wrap.querySelector(".modal-body");
    let reason = "", from = "", to = "";
    function list(){
      const f = { reason, fromMs:from? Date.parse(from+"T00:00:00") : null, toMs:to? Date.parse(to+"T23:59:59") : null };
      const rows = adjustmentReportData(all("SELECT * FROM stock_adjustments WHERE branch_id=?",[getBranchId()]), [], f).rows.reverse();
      body.innerHTML = `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          <select class="field" id="ahReason" style="flex:1;min-width:140px;margin:0"><option value="">All reasons</option>${ADJ_REASONS.map(r=>`<option value="${escapeHtml(r)}" ${r===reason?"selected":""}>${escapeHtml(r)}</option>`).join("")}</select>
          <input class="field" id="ahFrom" type="date" value="${from}" style="flex:1;min-width:130px;margin:0"><input class="field" id="ahTo" type="date" value="${to}" style="flex:1;min-width:130px;margin:0">
        </div>
        ${rows.length===0? `<p class="muted">No adjustments.</p>` : `<div style="max-height:52vh;overflow:auto"><table class="simple">
          <tr><th>Date</th><th>Item</th><th>Qty</th><th>Reason</th><th>Note</th><th>By</th></tr>
          ${rows.map(r=>`<tr><td>${escapeHtml(new Date(r.ts).toLocaleDateString())}</td>
            <td>${r.product_code? `<div class="psku">${escapeHtml(r.product_code)}</div>` : ""}${escapeHtml(r.product_name)}</td>
            <td>${r.qty_delta>0?"+":""}${r.qty_delta}</td><td>${escapeHtml(r.reason)}</td><td>${escapeHtml(r.note||"")}</td>
            <td>${escapeHtml(r.by_user||"")}<div class="pmeta">Admin: ${escapeHtml(r.authorised_by||"")}</div></td></tr>`).join("")}</table></div>`}`;
      body.querySelector("#ahReason").onchange=(e)=>{ reason = e.target.value; list(); };
      body.querySelector("#ahFrom").onchange=(e)=>{ from = e.target.value; list(); };
      body.querySelector("#ahTo").onchange=(e)=>{ to = e.target.value; list(); };
    }
    list();
  }
