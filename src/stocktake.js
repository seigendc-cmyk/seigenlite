  // ---------------- Stocktake ----------------
  // One open stocktake per branch at a time. Counting is deliberately blind
  // (system_qty is never shown while counting, same principle as the EOD
  // cash count) so staff aren't biased toward matching what the system
  // expects. Cutting off closes the count and produces a variance report;
  // applying the counts to live stock is a separate, explicitly-confirmed step.
  function renderStocktake(main){
    if(stocktakeReportId) return renderStocktakeReport(main, stocktakeReportId);
    // Stocktakes are per-branch, and a device can have more than one open at
    // once (e.g. for two branches whose data has been merged onto it). Only
    // auto-jump into counting when there's exactly one open take — otherwise
    // show the list so the user picks which one to continue.
    const openTakes = all("SELECT * FROM stocktakes WHERE status='Open' ORDER BY created_ts");
    if(openTakes.length===1) return renderStocktakeCounting(main, openTakes[0]);
    renderStocktakeList(main);
  }
  function renderStocktakeList(main){
    const openTakes = all("SELECT * FROM stocktakes WHERE status='Open' ORDER BY created_ts");
    const past = all("SELECT * FROM stocktakes WHERE status='Closed' ORDER BY cutoff_ts DESC");
    main.innerHTML = `
      <p class="muted">Count physical stock and compare it against what the system expects.</p>
      <button class="btn btn-primary" id="startStocktake" style="margin-bottom:14px">+ Start Stocktake</button>
      ${openTakes.length? `
        <h3>Open Stocktakes</h3>
        ${openTakes.map(s=>`
          <div class="card" style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:700">${escapeHtml(s.branch)}</div>
              <div class="muted">${escapeHtml(s.start_date)}${s.end_date?` – ${escapeHtml(s.end_date)}`:""} · Team: ${escapeHtml(s.team_names||"—")}</div>
            </div>
            <button class="btn btn-sm btn-primary" data-continue-take="${s.id}">Continue</button>
          </div>`).join("")}
      ` : ""}
      <h3>Past Stocktakes</h3>
      ${past.length===0? `<p class="muted">No stocktakes yet.</p>` : past.map(s=>`
        <div class="card" style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:700">${escapeHtml(s.branch)}</div>
            <div class="muted">${escapeHtml(s.start_date)}${s.end_date?` – ${escapeHtml(s.end_date)}`:""} · Team: ${escapeHtml(s.team_names||"—")} · Closed ${s.cutoff_ts? new Date(s.cutoff_ts).toLocaleDateString() : "—"}</div>
          </div>
          <button class="btn btn-sm btn-outline" data-view-take="${s.id}">View</button>
        </div>`).join("")}
    `;
    document.getElementById("startStocktake").onclick=()=>startStocktakeModal();
    main.querySelectorAll("[data-continue-take]").forEach(b=>{
      b.onclick=()=>{ const take = one("SELECT * FROM stocktakes WHERE id=?",[+b.dataset.continueTake]); renderStocktakeCounting(main, take); };
    });
    main.querySelectorAll("[data-view-take]").forEach(b=>{
      b.onclick=()=>{ stocktakeReportId = +b.dataset.viewTake; render(); };
    });
  }
  function startStocktakeModal(){
    const today = new Date().toISOString().slice(0,10);
    const wrap = openModal("Start Stocktake", `
      <label>Branch</label>${branchSelectHtml("stBranch", currentBranch())}
      <label>Team names</label>
      <input class="field" id="stTeam" placeholder="e.g. Tapiwa, Rudo">
      <label>Start date</label>
      <input class="field" id="stStart" type="date" value="${today}">
      <label>End date (optional estimate)</label>
      <input class="field" id="stEnd" type="date">
      <p class="muted" id="stWarning" style="color:var(--danger)"></p>
      <button class="btn btn-primary" id="stConfirm" style="margin-top:12px">Start</button>
    `);
    const branchSel = wrap.querySelector("#stBranch");
    const warningEl = wrap.querySelector("#stWarning");
    function updateWarning(){
      const b = branchSel.value;
      if(!b){ warningEl.textContent = `Pick a specific branch — a stocktake can't target "All branches".`; return; }
      const existing = one("SELECT * FROM stocktakes WHERE branch=? AND status='Open'",[b]);
      warningEl.textContent = existing? `${b} already has an open stocktake — cut it off before starting another.` : "";
    }
    branchSel.onchange = updateWarning;
    updateWarning();
    wrap.querySelector("#stConfirm").onclick=()=>{
      const branch = branchSel.value;
      if(!branch) return alert(`Pick a specific branch for this stocktake — it can't target "All branches".`);
      if(one("SELECT * FROM stocktakes WHERE branch=? AND status='Open'",[branch])){
        alert(`${branch} already has an open stocktake. Cut it off before starting another.`);
        return;
      }
      const team = wrap.querySelector("#stTeam").value.trim();
      const start = wrap.querySelector("#stStart").value || today;
      const end = wrap.querySelector("#stEnd").value || "";
      run("INSERT INTO stocktakes(branch,team_names,start_date,end_date,status,created_by,created_ts) VALUES(?,?,?,?,'Open',?,?)",
        [branch, team, start, end, sessionUser||"", new Date().toISOString()]);
      persist(); wrap.remove(); render();
    };
  }
  // Multi-Token Search Engine: the table body only (no header/search box),
  // reused by both the initial full render below and
  // renderStocktakeCountingListOnly() (called on every search keystroke,
  // patching only this table rather than rebuilding the whole screen — the
  // same targeted-re-render idiom renderProductsTableOnly() (products.js)
  // already uses for the Products tab's own search box, kept here instead
  // of full innerHTML rebuilds specifically so the search <input> itself is
  // never touched/recreated and never loses focus mid-keystroke).
  function stocktakeCountingTableHtml(products, countMap){
    if(products.length===0) return `<p class="muted" style="padding:10px 4px">No products match.</p>`;
    return `
      <table class="simple">
        <tr><th>Item</th><th>Shelf</th><th>Counted Qty</th></tr>
        ${products.map(p=>{
          const c = countMap[p.id];
          return `<tr>
            <td>${skuNameCellScreen(p.sku,p.name)}</td>
            <td>${escapeHtml(p.shelf||"—")}</td>
            <td><input class="field" data-count="${p.id}" type="number" min="0" style="max-width:90px" value="${c?c.counted_qty:""}" placeholder="—"></td>
          </tr>`;
        }).join("")}
      </table>`;
  }
  function wireStocktakeCountInputs(scope, take){
    scope.querySelectorAll("[data-count]").forEach(inp=>{
      inp.onchange=(e)=>{
        const pid = +inp.dataset.count;
        const val = e.target.value;
        if(val==="") return;
        const qty = parseInt(val)||0;
        const p = one("SELECT * FROM products WHERE id=?",[pid]);
        const existingCount = one("SELECT * FROM stocktake_counts WHERE stocktake_id=? AND product_id=?",[take.id,pid]);
        if(existingCount){
          run("UPDATE stocktake_counts SET counted_qty=?, system_qty=?, counted_ts=?, counted_by=? WHERE id=?",
            [qty, p.stock, new Date().toISOString(), sessionUser||"", existingCount.id]);
        } else {
          run("INSERT INTO stocktake_counts(stocktake_id,product_id,product_name,sku,system_qty,counted_qty,counted_ts,counted_by) VALUES(?,?,?,?,?,?,?,?)",
            [take.id, pid, p.name, p.sku||"", p.stock, qty, new Date().toISOString(), sessionUser||""]);
        }
        persist();
      };
    });
  }
  // Re-fetches products/counts fresh (a count just typed into another row
  // must still be reflected) and re-renders ONLY #stCountTable — see the
  // comment on stocktakeCountingTableHtml above for why not a full rebuild.
  function renderStocktakeCountingListOnly(take){
    const target = document.getElementById("stCountTable");
    if(!target) return;
    const products = all("SELECT * FROM products WHERE branch=? ORDER BY name",[take.branch]);
    const counted = all("SELECT * FROM stocktake_counts WHERE stocktake_id=?",[take.id]);
    const countMap = {}; counted.forEach(c=> countMap[c.product_id]=c);
    const results = rankProductsBySearch(products, stocktakeQuery);
    target.innerHTML = stocktakeCountingTableHtml(results, countMap);
    wireStocktakeCountInputs(target, take);
  }
  function renderStocktakeCounting(main, take){
    const branch = take.branch;
    const products = all("SELECT * FROM products WHERE branch=? ORDER BY name",[branch]);
    const counted = all("SELECT * FROM stocktake_counts WHERE stocktake_id=?",[take.id]);
    const countMap = {}; counted.forEach(c=> countMap[c.product_id]=c);
    const results = rankProductsBySearch(products, stocktakeQuery);
    main.innerHTML = `
      <h3>Stocktake — ${escapeHtml(take.branch)} — ${escapeHtml(take.start_date)}${take.end_date?` to ${escapeHtml(take.end_date)}`:""}</h3>
      <p class="muted">Team: ${escapeHtml(take.team_names||"—")} · Counted ${counted.length} of ${products.length}</p>
      <p class="muted">Count what's physically on the shelf — the system's expected quantity is hidden while you count, so it doesn't bias you.</p>
      <div class="search-wrap">
        <span class="ic">🔎</span>
        <input class="field" id="stCountSearch" placeholder="Search products, SKU, description…" value="${escapeHtml(stocktakeQuery)}">
      </div>
      <div id="stCountTable">${stocktakeCountingTableHtml(results, countMap)}</div>
      <button class="btn btn-danger" id="cutoffStocktake" style="margin-top:14px">Cut Off & Generate Report</button>
    `;
    document.getElementById("stCountSearch").oninput=(e)=>{ stocktakeQuery = e.target.value; renderStocktakeCountingListOnly(take); };
    wireStocktakeCountInputs(document.getElementById("stCountTable"), take);
    document.getElementById("cutoffStocktake").onclick=()=>{
      if(!confirm("Cut off this stocktake? Any products not yet counted will be marked 'Not counted' in the report.")) return;
      run("UPDATE stocktakes SET status='Closed', cutoff_ts=? WHERE id=?",[new Date().toISOString(), take.id]);
      persist();
      stocktakeReportId = take.id;
      render();
    };
  }
  function computeStocktakeVariance(takeId){
    const take = one("SELECT * FROM stocktakes WHERE id=?",[takeId]);
    if(!take) return { take:null, rows:[] };
    const products = all("SELECT * FROM products WHERE branch=? ORDER BY name",[take.branch]);
    const counts = all("SELECT * FROM stocktake_counts WHERE stocktake_id=?",[takeId]);
    const countMap = {}; counts.forEach(c=> countMap[c.product_id]=c);
    const rows = products.map(p=>{
      const c = countMap[p.id];
      const counted = c? c.counted_qty : null;
      const variance = counted===null? null : counted - c.system_qty;
      return { product:p, count:c, counted, variance };
    });
    return { take, rows };
  }
  function renderStocktakeReport(main, takeId){
    const { take, rows } = computeStocktakeVariance(takeId);
    if(!take){ stocktakeReportId=null; return renderStocktakeList(main); }
    main.innerHTML = `
      <h3>Stocktake Report — ${escapeHtml(take.branch)} — ${escapeHtml(take.start_date)}${take.end_date?` to ${escapeHtml(take.end_date)}`:""}</h3>
      <p class="muted">Team: ${escapeHtml(take.team_names||"—")} · Cut off ${take.cutoff_ts? new Date(take.cutoff_ts).toLocaleString() : "—"}</p>
      <div class="card" style="overflow-x:auto">
        <table class="simple">
          <tr><th>Item</th><th>Shelf</th><th>System Qty</th><th>Counted Qty</th><th>Variance</th></tr>
          ${rows.map(r=>`<tr>
            <td>${skuNameCellScreen(r.product.sku,r.product.name)}</td>
            <td>${escapeHtml(r.product.shelf||"—")}</td>
            <td>${r.count? r.count.system_qty : r.product.stock}</td>
            <td>${r.counted===null? "Not counted" : r.counted}</td>
            <td>${r.variance===null? "—" : (r.variance>0?`+${r.variance}`:r.variance)}</td>
          </tr>`).join("")}
        </table>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-outline" id="printStocktake">🖨️ Print/PDF</button>
        <button class="btn btn-outline" id="backToStocktakes">Back to Stocktakes</button>
      </div>
      ${take.status==="Closed"? `<button class="btn btn-danger" id="applyStocktake" style="margin-top:10px">Apply counts to inventory</button>` : ""}
    `;
    document.getElementById("printStocktake").onclick=()=>{
      const headers = ["Item","Shelf","System Qty","Counted Qty","Variance"];
      const printRows = rows.map(r=>[skuNameCell(r.product.sku,r.product.name), escapeHtml(r.product.shelf||"—"), r.count?r.count.system_qty:r.product.stock, r.counted===null?"Not counted":r.counted, r.variance===null?"—":(r.variance>0?`+${r.variance}`:r.variance)]);
      printReport("Stocktake Report", `${take.branch} · ${take.start_date}${take.end_date?` to ${take.end_date}`:""}`, headers, printRows, "");
    };
    document.getElementById("backToStocktakes").onclick=()=>{ stocktakeReportId=null; render(); };
    const applyBtn = document.getElementById("applyStocktake");
    if(applyBtn) applyBtn.onclick=()=>{
      const toApply = rows.filter(r=>r.counted!==null && r.variance!==0);
      if(toApply.length===0){ alert("No counted items differ from system stock — nothing to apply."); return; }
      if(!confirm(`Apply ${toApply.length} counted quantities to live stock? This can't be undone.`)) return;
      toApply.forEach(r=>{
        const ts = new Date().toISOString();
        // The movement records the real change (counted − stock now), which can
        // differ from the count-time variance if sales happened since counting.
        moveStock({ productId:r.product.id, setTo:r.counted, kind:"stocktake", docType:"stocktake", docUid:take.uid||null, docNo:"Stocktake #"+take.id, ts, note:"Stocktake adjustment" });
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES(?,?,?,?,?,?,?)",
          [ts, r.product.id, r.product.name, r.variance, "Stocktake adjustment", take.branch, sessionUser||""]);
      });
      logAudit("Apply Stocktake", "", `${toApply.length} products adjusted (stocktake #${take.id})`);
      persist();
      alert("Inventory updated.");
      render();
    };
  }

