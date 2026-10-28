  // ================== Stocktake tabs: Count now, Approvals, Shrinkage (v37, decision 52) ==================
  // The full stocktake (stocktake.js) is unchanged under "Full stocktake".
  let cycleTab = "full";
  let cycleShrinkFrom = "", cycleShrinkTo = "";
  function cycleCanCount(){ return typeof can!=="function" || can("count_stock"); }
  function cycleCanApprove(){ return typeof can!=="function" || can("approve_counts"); }
  function cycleTabs(){
    const t = [{ id:"full", label:"Full stocktake" }];
    if(cycleCanCount()) t.push({ id:"count", label:"Count now" });
    if(cycleCanApprove()){ const n = cycleWaiting().length; t.push({ id:"approve", label:"Approvals"+(n? " ("+n+")" : "") }); }
    if(cycleCanApprove() || (typeof can!=="function" || can("m.reportwriter"))) t.push({ id:"shrink", label:"Shrinkage" });
    return t;
  }
  // -> true when it drew the screen (the tabs and the chosen one)
  function renderStocktake(main){
    const tabs = cycleTabs();
    if(!tabs.some(t=>t.id===cycleTab)) cycleTab = "full";
    main.innerHTML = `<div class="tabs cycle-tabs" id="cycleTabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${tabs.map(t=>
      `<button class="btn btn-sm ${t.id===cycleTab? "btn-primary" : "btn-outline"}" data-cycle-tab="${t.id}">${escapeHtml(t.label)}</button>`).join("")}</div><div id="cycleBody"></div>`;
    main.querySelectorAll("[data-cycle-tab]").forEach(b=> b.onclick = ()=>{ cycleTab = b.dataset.cycleTab; stocktakeReportId = null; render(); });
    const body = main.querySelector("#cycleBody");
    if(cycleTab==="count") return renderCountNow(body);
    if(cycleTab==="approve") return renderCountApprovals(body);
    if(cycleTab==="shrink") return renderShrinkage(body);
    return renderStocktakeFull(body);
  }

  // ---- Count now (blind) ----
  function cycleSharedStockNote(){
    return typeof sharedStockTill==="function" && sharedStockTill()?
      `<div class="box" id="cycleShared" style="border-color:#b54708">Count now isn't available on a shared-stock branch yet (this till holds an allowance, not the shelf). Use the full stocktake.</div>` : "";
  }
  function renderCountNow(main){
    const shared = cycleSharedStockNote();
    if(shared){ main.innerHTML = shared; return; }
    const items = cycleList(), left = items.filter(i=>!i.done).length;
    const single = !(typeof staffSession==="function" && staffSession());
    const groups = cycleGroupByShelf(items);
    main.innerHTML = `
      <p class="muted" style="margin:0 0 6px">Today's short count, chosen by risk. Count what is on the shelf: the expected figure is never shown while you count.</p>
      <div class="box" id="cycleSummary" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <b>${escapeHtml(cycleToday())}</b><span><b id="cycleLeft">${left}</b> to count</span><span>${items.length-left} done</span>
        ${cycleCanApprove()? `<button class="btn btn-sm btn-outline" id="cycleAdd" style="margin-left:auto">+ Add items or a shelf</button>` : ""}
      </div>
      ${single? `<label style="margin-top:0">Counted by</label><input class="field" id="cycleBy" maxlength="80" value="${escapeHtml(getSetting("cycle_by","") || String(sessionUser||""))}" placeholder="Your name" style="max-width:260px">` : ""}
      ${items.length? groups.map(g=>`
        <h4 class="cycle-shelf" style="margin:12px 0 4px">${g.shelf? "Shelf "+escapeHtml(g.shelf) : "No shelf"}</h4>
        ${g.rows.map(i=>`
          <div class="card cycle-item${i.done? " cycle-done" : ""}" data-key="${escapeHtml(i.key)}" style="padding:8px;margin-bottom:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <div style="flex:1;min-width:160px"><div style="font-weight:600">${escapeHtml(i.name)}</div>
              <div class="muted" style="font-size:11.5px">${escapeHtml(i.code||"no code")}${i.shelf? " · "+escapeHtml(i.shelf) : ""}</div>
              <div class="cycle-reason" style="font-size:11.5px;color:${i.recountOf? "#b42318" : "#b54708"}">${escapeHtml(i.reason||"")}</div></div>
            ${i.done? `<div class="cycle-status" style="font-size:12.5px">✓ Counted${i.done.counted_by? " by "+escapeHtml(i.done.counted_by) : ""}: sent for checking</div>`
              : `<input class="field cycle-qty" data-qty="${escapeHtml(i.key)}" inputmode="numeric" placeholder="Counted" style="width:90px;margin:0">
                 <button class="btn btn-sm btn-primary" data-save="${escapeHtml(i.key)}">Save</button>`}
          </div>`).join("")}`).join("")
        : `<p class="muted" id="cycleNone">Nothing to count today: every item is within its count interval and has no red flags.</p>`}
      <div id="cycleErr" style="color:#b42318;font-size:12.5px;margin-top:6px"></div>
      <p class="muted" style="font-size:12px;margin-top:8px">Selling goes on while you count: the difference is fixed at the moment you save, and stock changes only when a manager approves it.</p>`;
    const by = main.querySelector("#cycleBy");
    if(by) by.oninput = ()=> setSetting("cycle_by", by.value);
    const save = (key)=>{
      const it = items.find(i=>i.key===key), inp = [...main.querySelectorAll("[data-qty]")].find(x=> x.dataset.qty===key);
      if(single && by && !by.value.trim()){ main.querySelector("#cycleErr").textContent = "Type who is counting."; return; }
      const r = cycleSaveCount(it, inp.value, single && by? by.value : "");
      if(!r.ok){ main.querySelector("#cycleErr").textContent = r.message; return; }
      persist(); scSoon(); render();
    };
    main.querySelectorAll("[data-save]").forEach(b=> b.onclick = ()=> save(b.dataset.save));
    main.querySelectorAll("[data-qty]").forEach(inp=> inp.onkeydown = (e)=>{ if(e.key==="Enter"){ e.preventDefault(); save(inp.dataset.qty); } });
    const add = main.querySelector("#cycleAdd");
    if(add) add.onclick = ()=> openCycleAddModal();
  }
  function openCycleAddModal(){
    const branch = currentBranch();
    const products = all("SELECT * FROM products WHERE branch=? AND COALESCE(active,1)=1 ORDER BY name",[branch]);
    const shelves = [...new Set(products.map(p=>String(p.shelf||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b, undefined, { numeric:true }));
    let q = "";
    const wrap = openModal("Add to today's count", `
      <label style="margin-top:0">A whole shelf</label>
      <div style="display:flex;gap:6px"><select class="field" id="caShelf" style="margin:0"><option value="">Choose a shelf…</option>${shelves.map(s=>`<option>${escapeHtml(s)}</option>`).join("")}</select>
        <button class="btn btn-outline" id="caShelfAdd">Add shelf</button></div>
      <label>Or items</label><input class="field" id="caSearch" placeholder="Search by name or code" autocomplete="off">
      <div id="caList" style="max-height:40vh;overflow:auto"></div>
      <button class="btn btn-primary" id="caDone">Done</button>`);
    const list = wrap.querySelector("#caList");
    const draw = ()=>{
      const rows = q.trim()? productSearch(products, q).slice(0,30) : [];
      list.innerHTML = rows.map(p=>`<button type="button" class="card" data-add="${p.id}" style="display:block;width:100%;text-align:left;padding:6px;margin:4px 0">${escapeHtml(p.name)} <span class="muted">${escapeHtml(p.sku||"")}${p.shelf? " · "+escapeHtml(p.shelf) : ""}</span></button>`).join("");
      list.querySelectorAll("[data-add]").forEach(b=> b.onclick = ()=>{ const p = products.find(x=>x.id===+b.dataset.add); cycleAdd([scProductKey(p) || "id:"+p.id], "Added by "+scWho()); b.textContent = "✓ "+p.name+" added"; b.disabled = true; persist(); });
    };
    wrap.querySelector("#caSearch").oninput = (e)=>{ q = e.target.value; draw(); };
    wrap.querySelector("#caShelfAdd").onclick = ()=>{
      const s = wrap.querySelector("#caShelf").value; if(!s) return;
      cycleAdd(products.filter(p=>String(p.shelf||"").trim()===s).map(p=> scProductKey(p) || "id:"+p.id), "Shelf "+s+", added by "+scWho());
      persist(); wrap.remove(); render();
    };
    wrap.querySelector("#caDone").onclick = ()=>{ wrap.remove(); render(); };
  }

  // ---- Approvals (approve_counts) ----
  function cycleShowCosts(){ return typeof can!=="function" || can("costs"); }
  function renderCountApprovals(main){
    const rows = cycleWaiting(), costs = cycleShowCosts();
    const recent = all("SELECT * FROM sc_counts WHERE status IN ('approved','rejected','recount') ORDER BY decided_at DESC LIMIT 20");
    const conflicts = all("SELECT * FROM sc_counts WHERE COALESCE(conflict,'')<>'' ORDER BY counted_ts DESC LIMIT 10");
    main.innerHTML = `
      <p class="muted" style="margin:0 0 6px">Every difference waits here. No approval, no stock change. Approving moves the counting till's stock by the difference found when it was counted.</p>
      ${conflicts.length? `<div class="box" id="ccConflicts" style="border-color:#b42318;font-size:12.5px">${conflicts.map(c=>`<div><b>${escapeHtml(c.name)}</b>: ${escapeHtml(c.conflict)}</div>`).join("")}</div>` : ""}
      ${rows.length? `<div class="card" style="overflow-x:auto"><table class="simple" id="ccTable">
        <tr><th>Item</th><th>Shelf</th><th>Counted</th><th>System at count</th><th>Difference</th>${costs? "<th>Value</th>" : ""}<th>Counted by</th><th>When</th><th>Why listed</th><th></th></tr>
        ${rows.map(c=>{ const p = scProductByKey(c.product_key), v = c.diff==null? null : c.diff*(Number(p && p.cost)||0);
          return `<tr data-cc="${escapeHtml(c.id)}"><td>${skuNameCellScreen(c.code, c.name)}</td><td>${escapeHtml(c.shelf||"—")}</td><td>${c.counted_qty}</td>
            <td>${c.system_qty==null? "—" : c.system_qty}</td><td><b>${c.diff==null? "—" : (c.diff>0? "+" : "")+c.diff}</b></td>
            ${costs? `<td>${v==null? "—" : currency+v.toFixed(2)}</td>` : ""}<td>${escapeHtml(c.counted_by||"")}</td><td>${escapeHtml(new Date(c.counted_ts).toLocaleString())}</td>
            <td style="font-size:11.5px">${escapeHtml(c.reason||"")}</td>
            <td style="white-space:nowrap"><button class="btn btn-sm btn-primary" data-act="approve">Approve</button> <button class="btn btn-sm btn-outline" data-act="recount">Recount</button> <button class="btn btn-sm btn-outline" data-act="reject">Reject</button></td></tr>`; }).join("")}
      </table></div>` : `<p class="muted" id="ccNone">Nothing waiting for approval.</p>`}
      ${recent.length? `<h4 style="margin:14px 0 4px">Recent decisions</h4><table class="simple">${recent.map(c=>`<tr><td>${escapeHtml(c.name)}</td><td>${c.diff==null? "" : (c.diff>0? "+" : "")+c.diff}</td><td>${escapeHtml(c.status)}</td><td>${escapeHtml(c.decided_by||"")}</td><td>${escapeHtml(c.adj_display||"")}</td></tr>`).join("")}</table>` : ""}`;
    main.querySelectorAll("[data-cc] [data-act]").forEach(b=> b.onclick = ()=> openCountDecision(b.closest("[data-cc]").dataset.cc, b.dataset.act));
  }
  function openCountDecision(id, action){
    const c = one("SELECT * FROM sc_counts WHERE id=?",[id]);
    if(!c) return;
    const title = action==="approve"? "Approve the difference" : action==="recount"? "Ask for a recount" : "Reject the count";
    const wrap = openModal(title, `
      <p style="margin:0 0 6px"><b>${escapeHtml(c.name)}</b>: counted ${c.counted_qty}${c.diff==null? "" : ", difference "+(c.diff>0? "+" : "")+c.diff} (by ${escapeHtml(c.counted_by||"?")}).</p>
      ${action==="approve"? `<p class="muted" style="font-size:12.5px">An ADJ "Miscount correction" moves the counting till's stock by ${c.diff==null? "the difference" : (c.diff>0? "+" : "")+c.diff}, at the current cost.</p>` : ""}
      ${action==="recount"? `<p class="muted" style="font-size:12.5px">It goes back on the list, to be counted by someone other than ${escapeHtml(c.counted_by||"the first counter")}.</p>` : ""}
      <label>Note${action==="reject"? " (why)" : " (optional)"}</label><input class="field" id="cdNote" maxlength="200">
      <label>Admin passcode, or your PIN</label><input class="field" id="cdCode" type="password" inputmode="numeric" autocomplete="off">
      <div id="cdErr" style="color:#b42318;font-size:12.5px"></div>
      <button class="btn btn-primary" id="cdOk">${escapeHtml(title)}</button>`);
    const codeEl = wrap.querySelector("#cdCode");
    codeEl.focus();
    wrap.querySelector("#cdOk").onclick = async ()=>{
      const code = codeEl.value;
      if(typeof approverPinWarm==="function") await approverPinWarm(code, "approve_counts");   // the holder's own PIN, off the screen thread
      const r = cycleDecide(id, action, code, wrap.querySelector("#cdNote").value);
      if(!r.ok){ wrap.querySelector("#cdErr").textContent = r.message; return; }
      await persist(); scSoon(); wrap.remove(); render();
      if(r.applied && r.applied.length) alert("Stock updated: "+r.applied.map(a=>a.product+" "+(a.diff>0?"+":"")+a.diff+(a.adj? " ("+a.adj+")" : "")).join(", "));
    };
  }

  // ---- Shrinkage (decision 52): Stocktake tab + Report Writer ----
  function shrinkPeriod(){
    const to = cycleShrinkTo || businessDateOf(), from = cycleShrinkFrom || businessDateOf(Date.now()-29*CYCLE_DAY);
    return { from, to, fromTs:new Date(businessDayStartMs(from)).toISOString(), toTs:new Date(businessDayStartMs(to, 1)-1).toISOString() };
  }
  function shrinkageData(fromTs, toTs){
    const costs = cycleShowCosts(), rows = cycleShrinkRows(fromTs, toTs);
    return Object.assign(cycleShrinkage(rows, costs), { rows, costs, doneDue:cycleDoneVsDue(fromTs, toTs) });
  }
  function renderShrinkage(main){
    const per = shrinkPeriod(), d = shrinkageData(per.fromTs, per.toTs);
    const money = (v)=> v==null? "" : currency+Number(v).toFixed(2);
    const tbl = (id, title, head, xs)=> `<h4 style="margin:12px 0 4px">${title}</h4>${xs.length? `<table class="simple" id="${id}"><tr><th>${head}</th><th>Units</th>${d.costs? "<th>Value at cost</th>" : ""}<th>Counts</th></tr>${xs.map(x=>`<tr><td>${escapeHtml(x.key)}</td><td>${x.units>0? "+" : ""}${x.units}</td>${d.costs? `<td>${money(x.value)}</td>` : ""}<td>${x.counts}</td></tr>`).join("")}</table>` : `<p class="muted">None.</p>`}`;
    main.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <label style="margin:0">From<input class="field" type="date" id="shFrom" value="${per.from}" style="margin:0"></label>
        <label style="margin:0">To<input class="field" type="date" id="shTo" value="${per.to}" style="margin:0"></label>
        <button class="btn btn-outline" id="shPrint">🖨️ Print/PDF</button>
      </div>
      <div class="box" id="shSummary" style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <span>Lost / found: <b id="shUnits">${d.units>0? "+" : ""}${d.units}</b> units</span>
        ${d.costs? `<span>Value at cost: <b id="shValue">${money(d.value)}</b></span>` : `<span class="muted" id="shNoCosts">Values need View costs: units only.</span>`}
        <span>Counts done vs due: <b id="shDone">${d.doneDue.done} / ${d.doneDue.due}</b></span>
      </div>
      ${tbl("shTop", "Top 10 items lost", "Item", d.top10)}
      ${tbl("shWeeks", "Trend by week", "Week from", d.weeks)}
      ${tbl("shShelves", "By shelf", "Shelf", d.shelves)}
      ${tbl("shStaff", "By staff on duty (who sold that day, and the counter)", "Staff", d.staff)}
      <p class="muted" style="font-size:12px">From approved cycle counts at this branch and full stocktakes applied on this device. ${escapeHtml(currentBranch())}.</p>`;
    main.querySelector("#shFrom").onchange = (e)=>{ cycleShrinkFrom = e.target.value; render(); };
    main.querySelector("#shTo").onchange = (e)=>{ cycleShrinkTo = e.target.value; render(); };
    main.querySelector("#shPrint").onclick = ()=>{
      const r = shrinkageReport(per.fromTs, per.toTs);
      printReport("Shrinkage", currentBranch()+" · "+per.from+" to "+per.to, r.headers, r.rows, r.footer);
    };
  }
  // The detail, as Report Writer and the print show it
  function shrinkageReport(fromTs, toTs){
    const d = shrinkageData(fromTs, toTs);
    const rows = d.rows.map(r=>[escapeHtml(new Date(r.counted_ts).toLocaleString()), skuNameCell(r.code, r.name), escapeHtml(r.shelf||"—"), (r.diff>0? "+" : "")+r.diff]
      .concat(d.costs? [currency+(r.diff*(r.unit_cost||0)).toFixed(2)] : [], [escapeHtml(r.how), escapeHtml(r.counted_by||""), escapeHtml(r.staff||"")]));
    return { headers:["Date","Item","Shelf","Units"].concat(d.costs? ["Value at cost"] : [], ["How","Counted by","Staff on duty"]), rows,
      footer:`${d.units>0? "+" : ""}${d.units} units${d.costs? " · "+currency+Number(d.value).toFixed(2)+" at cost" : " (values need View costs)"} · counts done ${d.doneDue.done} of ${d.doneDue.due} due` };
  }
  if(typeof REPORT_CONFIGS!=="undefined"){
    REPORT_CONFIGS.push({ id:"shrinkage", label:"Shrinkage (counts)", hasDate:true, fetch(b, fromTs, toTs){ return shrinkageReport(fromTs, toTs); } });
    RW_KIND.shrinkage = "stock";   // units for everyone with Report Writer; values only with View costs (shrinkageData)
  }

  // ---- Settings → Count now (the shop's intervals and list size) ----
  function cycleSettingsCardHtml(){
    if(!(typeof can!=="function" || can("approve_counts"))) return "";
    const s = cycleSettings();
    const f = (id, label, v)=> `<label style="flex:1;min-width:110px;margin:0">${label}<input class="field" id="${id}" type="number" min="1" max="999" step="1" value="${v}" style="margin:0"></label>`;
    return `<div class="card" id="cycleSettingsCard">
      <h3 style="margin-top:0">Count now (cycle stocktake)</h3>
      <p class="muted" style="font-size:12.5px;margin:0 0 6px">Class A is the top 80% of value sold at cost in 90 days, B the next 15%, C the rest. Red flags are always counted first.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${f("cyA","A every (days)",s.a)}${f("cyB","B every (days)",s.b)}${f("cyC","C every (days)",s.c)}${f("cySize","Items a day",s.size)}</div>
      <button class="btn btn-outline btn-sm" id="cySave" style="margin-top:8px">Save</button> <span class="muted" id="cyMsg" style="font-size:12px"></span>
    </div>`;
  }
  function cycleSettingsWire(scope){
    const b = scope.querySelector("#cySave");
    if(!b) return;
    b.onclick = ()=>{
      const vals = [["cyA","cycle_days_a"],["cyB","cycle_days_b"],["cyC","cycle_days_c"],["cySize","cycle_size"]].map(([id,k])=>[k, parseInt(scope.querySelector("#"+id).value, 10)]);
      if(vals.some(([,v])=> !(v>=1 && v<=999))){ scope.querySelector("#cyMsg").textContent = "Whole numbers from 1 to 999."; return; }
      vals.forEach(([k,v])=> setSetting(k, String(v)));
      setSetting("cycle_list", "");   // today's list is chosen again with the new figures
      persist(); scope.querySelector("#cyMsg").textContent = "Saved.";
    };
  }
