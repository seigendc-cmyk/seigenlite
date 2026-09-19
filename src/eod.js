  function renderEOD(main){
    const today = new Date().toISOString().slice(0,10);
    const branch = currentBranch();
    const todaySales = all("SELECT * FROM sales WHERE branch=? AND ts LIKE ?",[branch,today+"%"]);
    const cash = todaySales.filter(s=>s.method==="Cash").reduce((s,r)=>s+r.total,0);
    const ecocash = todaySales.filter(s=>s.method==="EcoCash").reduce((s,r)=>s+r.total,0);
    const credit = todaySales.filter(s=>s.method==="Credit").reduce((s,r)=>s+r.total,0);
    const discounts = todaySales.reduce((s,r)=>s+(r.discount||0),0);
    const totalSales = cash+ecocash+credit;
    const payouts = all("SELECT * FROM payouts WHERE branch=? AND ts LIKE ? ORDER BY ts",[branch,today+"%"]);
    const payoutsTotal = payouts.reduce((s,r)=>s+r.amount,0);
    const expected = cash - payoutsTotal;
    const lowStock = all("SELECT * FROM products WHERE branch=? AND stock<=low_threshold ORDER BY stock",[branch]);

    main.innerHTML = `
      <h2>End of Day — ${today}</h2>
      <div class="card">
        <div class="subline"><span>Sales Cash</span><span>${currency}${cash.toFixed(2)}</span></div>
        <div class="subline"><span>Sales EcoCash</span><span>${currency}${ecocash.toFixed(2)}</span></div>
        <div class="subline"><span>Sales Credit</span><span>${currency}${credit.toFixed(2)}</span></div>
        <div class="subline"><span>Less: Discounts</span><span>-${currency}${discounts.toFixed(2)}</span></div>
        <div class="hr" style="margin:8px 0"></div>
        <div class="total-line"><span>Total Sales</span><span>${currency}${totalSales.toFixed(2)}</span></div>
      </div>

      <div class="card">
        <h3>Payouts today</h3>
        ${payouts.length===0?`<p class="muted">None recorded</p>`:
          payouts.map(p=>`<div class="subline"><span>${escapeHtml(p.reason||"Payout")}</span><span>-${currency}${p.amount.toFixed(2)}</span></div>`).join("")}
        <div class="subline" style="font-weight:700"><span>Total payouts</span><span>-${currency}${payoutsTotal.toFixed(2)}</span></div>
        <button class="btn btn-outline" id="openAddPayout" style="margin-top:10px">+ Add Payout</button>
      </div>

      <div class="card">
        <h3>Blind cash count</h3>
        <p class="muted">Count the drawer and enter the amount. Expected cash stays hidden until you submit.</p>
        <label>Cash counted (${currency})</label>
        <input class="field" id="counted" type="number" step="0.01" placeholder="0.00">
        <button class="btn btn-primary" id="submitCount" style="margin-top:12px">Reveal Variance</button>
        <div id="varianceResult"></div>
      </div>

      <div class="card">
        <h3>Low stock (${lowStock.length})</h3>
        ${lowStock.length===0? `<p class="muted">All good — nothing low.</p>` :
          lowStock.map(p=>`<div class="product-row"><div class="pname">${escapeHtml(p.name)}</div><span class="pill low">${p.stock} left</span></div>`).join("")}
      </div>
      <div class="row">
        <button class="btn btn-outline" id="printEodBtn">🖨️ Print / PDF</button>
        <button class="btn btn-ghost" id="waEodBtn">📲 WhatsApp</button>
        ${hasUSBPrint()? `<button class="btn btn-outline" id="usbEodBtn" style="flex:none;width:auto;padding:12px">🔌</button>` : ""}
        ${hasBTPrint()? `<button class="btn btn-outline" id="btEodBtn" style="flex:none;width:auto;padding:12px">🔵</button>` : ""}
      </div>
    `;
    document.getElementById("openAddPayout").onclick=()=>payoutModal(()=>render());
    document.getElementById("submitCount").onclick=()=>{
      const counted = parseFloat(document.getElementById("counted").value);
      if(isNaN(counted)) return alert("Enter the counted cash amount");
      const variance = counted - expected;
      run("INSERT INTO eod_sessions(date,expected_cash,counted_cash,variance,notes,branch,ts) VALUES(?,?,?,?,?,?,?)",
        [today,expected,counted,variance,"",branch,new Date().toISOString()]);
      persist();
      document.getElementById("varianceResult").innerHTML = `
        <div class="hr"></div>
        <div class="row">
          <div><div class="muted">Expected</div><b>${currency}${expected.toFixed(2)}</b></div>
          <div><div class="muted">Counted</div><b>${currency}${counted.toFixed(2)}</b></div>
          <div><div class="muted">Variance</div><b style="color:${variance<0?'var(--danger)':'var(--success)'}">${currency}${variance.toFixed(2)}</b></div>
        </div>`;
    };
    document.getElementById("printEodBtn").onclick=()=>{
      const counted = parseFloat(document.getElementById("counted").value)||0;
      printEOD({date:today,cash,ecocash,credit,discounts,totalSales,payouts,payoutsTotal,expected,counted,variance:counted-expected,lowStock});
    };
    const usbEodBtn = document.getElementById("usbEodBtn");
    if(usbEodBtn) usbEodBtn.onclick=()=>{
      const counted = parseFloat(document.getElementById("counted").value)||0;
      usbPrintEODBytes({date:today,cash,ecocash,credit,discounts,totalSales,payouts,payoutsTotal,expected,counted,variance:counted-expected,lowStock});
    };
    const btEodBtn = document.getElementById("btEodBtn");
    if(btEodBtn) btEodBtn.onclick=()=>{
      const counted = parseFloat(document.getElementById("counted").value)||0;
      btPrintEODBytes({date:today,cash,ecocash,credit,discounts,totalSales,payouts,payoutsTotal,expected,counted,variance:counted-expected,lowStock});
    };
    document.getElementById("waEodBtn").onclick=()=>{
      const counted = parseFloat(document.getElementById("counted").value)||0;
      const variance = counted-expected;
      const itemLines = [
        padLine("Sales Cash", `${currency}${cash.toFixed(2)}`),
        padLine("Sales EcoCash", `${currency}${ecocash.toFixed(2)}`),
        padLine("Sales Credit", `${currency}${credit.toFixed(2)}`),
        padLine("Less: Discounts", `-${currency}${discounts.toFixed(2)}`),
        padLine("Payouts", `-${currency}${payoutsTotal.toFixed(2)}`)
      ];
      const totalLines = [
        padLine("Total Sales", `${currency}${totalSales.toFixed(2)}`),
        padLine("Expected Cash", `${currency}${expected.toFixed(2)}`),
        padLine("Cash Count", `${currency}${counted.toFixed(2)}`),
        padLine("Variance", `${currency}${variance.toFixed(2)}`),
        "", `Low stock: ${lowStock.map(p=>p.name).join(", ")||"None"}`
      ];
      shareWhatsApp(receiptText(`${escapeHtml(getSetting("shop_name",""))} — EOD ${today}`, itemLines, totalLines));
    };
  }

  function branchSelectHtml(id, defaultValue){
    const branches = listBranches();
    const sel = defaultValue===undefined ? currentBranch() : defaultValue;
    return `<select class="field" id="${id}">
      <option value="" ${sel===""?"selected":""}>All branches</option>
      ${branches.map(b=>`<option value="${escapeHtml(b)}" ${b===sel?"selected":""}>${escapeHtml(b)}</option>`).join("")}
    </select>`;
  }

  function repHead(title, kebabId, presets){
    const menu = presets? `
      <div class="kebab-wrap">
        <button class="kebab-btn" data-kebab-toggle="${kebabId}">${ICON_DOTS}</button>
        <div class="kebab-menu" id="menu-${kebabId}">
          ${presets.map(p=>`<button data-preset="${kebabId}:${p.key}">${p.label}</button>`).join("")}
        </div>
      </div>` : "";
    return `<div class="rep-head"><h3 class="rep-title">${title}</h3>${menu}</div>`;
  }
  const REP_PRESETS = [{label:"Today",key:"today"},{label:"Last 7 days",key:"week"},{label:"This month",key:"month"}];

