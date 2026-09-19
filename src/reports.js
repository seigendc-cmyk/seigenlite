  function renderReports(main){
    const today = new Date().toISOString().slice(0,10);
    main.innerHTML = `
      <h2>Reports</h2>

      <div id="eodSection"></div>

      <div class="card">
        <h3>Log Request</h3>
        <p class="muted">Note stock a customer asked for that you didn't have.</p>
        <button class="btn btn-primary" id="reportsLogRequestBtn">+ Log Request</button>
      </div>

      <div class="search-wrap">
        <span class="ic">🔎</span>
        <input class="field" id="reportsSearch" placeholder="Search reports…" value="${escapeHtml(reportsQuery)}">
      </div>
      <p class="muted" id="reportsNoMatch" style="display:none">No reports match your search.</p>

      <div class="card" data-report-name="Sales Report">
        ${repHead("Sales Report","sales",REP_PRESETS)}
        <label>Branch</label>${branchSelectHtml("salesBranch")}
        <div class="row"><div><label>From</label><input class="field" id="salesFrom" type="date" value="${today}"></div><div><label>To</label><input class="field" id="salesTo" type="date" value="${today}"></div></div>
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genSales" title="Generate PDF">${ICON_GEN}</button><button class="btn btn-ghost icon-btn" id="waSales" title="WhatsApp">📲</button></div>
      </div>

      <div class="card" data-report-name="Inventory Report">
        ${repHead("Inventory Report")}
        <p class="muted">SKU, item name, and current quantity.</p>
        <label>Branch</label>${branchSelectHtml("invBranch")}
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genInventory" title="Generate PDF">${ICON_GEN}</button></div>
      </div>

      <div class="card" data-report-name="Stock Received Report">
        ${repHead("Stock Received Report","stock",REP_PRESETS)}
        <label>Branch</label>${branchSelectHtml("stockBranch")}
        <div class="row"><div><label>From</label><input class="field" id="stockFrom" type="date" value="${today}"></div><div><label>To</label><input class="field" id="stockTo" type="date" value="${today}"></div></div>
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genStock" title="Generate PDF">${ICON_GEN}</button></div>
      </div>

      <div class="card" data-report-name="Low Stock Report">
        ${repHead("Low Stock Report")}
        <label>Branch</label>${branchSelectHtml("lowBranch")}
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genLowStock" title="Generate PDF">${ICON_GEN}</button></div>
      </div>

      <div class="card" data-report-name="Credit Sales Report">
        ${repHead("Credit Sales Report","credit",REP_PRESETS)}
        <p class="muted">By customer: credit given, payments received, and balance.</p>
        <label>Branch</label>${branchSelectHtml("creditBranch")}
        <div class="row"><div><label>From</label><input class="field" id="creditFrom" type="date" value="${today}"></div><div><label>To</label><input class="field" id="creditTo" type="date" value="${today}"></div></div>
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genCredit" title="Generate PDF">${ICON_GEN}</button></div>
      </div>

      <div class="card" data-report-name="Discount Report">
        ${repHead("Discount Report","disc",REP_PRESETS)}
        <p class="muted">By customer: date, receipt #, amount, discount, cash paid, reason and approval status.</p>
        <label>Branch</label>${branchSelectHtml("discBranch")}
        <div class="row"><div><label>From</label><input class="field" id="discFrom" type="date" value="${today}"></div><div><label>To</label><input class="field" id="discTo" type="date" value="${today}"></div></div>
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genDiscount" title="Generate PDF">${ICON_GEN}</button></div>
      </div>

      ${isRemote()? "" : `
      <div class="card" data-report-name="Margin Report">
        ${repHead("Margin Report","margin",REP_PRESETS)}
        <p class="muted">Revenue vs cost per item, to evaluate expected margin.</p>
        <label>Branch</label>${branchSelectHtml("marginBranch")}
        <div class="row"><div><label>From</label><input class="field" id="marginFrom" type="date" value="${today}"></div><div><label>To</label><input class="field" id="marginTo" type="date" value="${today}"></div></div>
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genMargin" title="Generate PDF">${ICON_GEN}</button></div>
      </div>`}

      <div class="card" data-report-name="Aging Inventory">
        ${repHead("Aging Inventory")}
        <p class="muted">Items grouped by how long they've sat since last received: 0-15 / 15-30 / 30-60 / 60-90 / 90+ days.</p>
        <label>Branch</label>${branchSelectHtml("agingBranch")}
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genAging" title="Generate PDF">${ICON_GEN}</button></div>
      </div>

      <div class="card" data-report-name="Fast Moving Items">
        ${repHead("Fast Moving Items","fast",REP_PRESETS)}
        <p class="muted">Top-selling products by quantity, for a date range.</p>
        <label>Branch</label>${branchSelectHtml("fastBranch")}
        <div class="row"><div><label>From</label><input class="field" id="fastFrom" type="date" value="${today}"></div><div><label>To</label><input class="field" id="fastTo" type="date" value="${today}"></div></div>
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genFast" title="Generate PDF">${ICON_GEN}</button></div>
      </div>

      <div class="card" data-report-name="Payouts Report">
        ${repHead("Payouts Report","payout",REP_PRESETS)}
        <label>Branch</label>${branchSelectHtml("payoutBranch")}
        <div class="row"><div><label>From</label><input class="field" id="payoutFrom" type="date" value="${today}"></div><div><label>To</label><input class="field" id="payoutTo" type="date" value="${today}"></div></div>
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genPayoutReport" title="Generate PDF">${ICON_GEN}</button></div>
      </div>

      <div class="card" data-report-name="Customer Report">
        ${repHead("Customer Report")}
        <p class="muted">All customers, sorted by name, with phone and balance.</p>
        <label>Branch</label>${branchSelectHtml("custBranch")}
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genCustomers" title="Generate PDF">${ICON_GEN}</button></div>
      </div>

      <div class="card" data-report-name="Branch Report">
        ${repHead("Branch Report","branch",REP_PRESETS)}
        <p class="muted">Everything for one branch: stock, sales, credit, discounts, aging inventory, fast movers, stock activity, payouts, EOD variances, and customers.</p>
        <label>Branch</label>${branchSelectHtml("brBranch")}
        <div class="row"><div><label>From</label><input class="field" id="brFrom" type="date" value="${today}"></div><div><label>To</label><input class="field" id="brTo" type="date" value="${today}"></div></div>
        <div class="rep-actions"><button class="btn btn-outline icon-btn" id="genBranchReport" title="Generate PDF">${ICON_GEN}</button></div>
      </div>
    `;
    renderEOD(document.getElementById("eodSection"));
    document.getElementById("reportsLogRequestBtn").onclick=()=>openRequestsDrawer();

    // Filters which report-generator CARDS are shown by title — purely a
    // display:none toggle over cards already in the DOM, so it never
    // touches Report Writer (a separate page/state, rwType etc.) and never
    // re-renders (so none of the onclick wiring below needs re-binding).
    function applyReportsFilter(){
      const cards = main.querySelectorAll("[data-report-name]");
      let anyVisible = false;
      cards.forEach(c=>{
        const match = matchesAnyOrder(reportsQuery, c.dataset.reportName);
        c.style.display = match? "" : "none";
        if(match) anyVisible = true;
      });
      document.getElementById("reportsNoMatch").style.display = anyVisible? "none" : "";
    }
    document.getElementById("reportsSearch").oninput=(e)=>{ reportsQuery = e.target.value; applyReportsFilter(); };
    applyReportsFilter();

    function branchFilter(id){ const v=document.getElementById(id).value; return v||null; }
    function agingBucket(days){
      if(days<15) return "0-15 days";
      if(days<30) return "15-30 days";
      if(days<60) return "30-60 days";
      if(days<90) return "60-90 days";
      return "90+ days";
    }
    function productAgeDays(p){
      const lastReceived = one("SELECT MAX(ts) as t FROM stock_received WHERE product_id=? AND qty>0 AND adj_no IS NULL",[p.id]);
      const ref = (lastReceived && lastReceived.t) ? lastReceived.t : (p.created_ts||new Date().toISOString());
      return Math.max(0, daysBetween(new Date(ref), new Date()));
    }
    // Quick-access preset menus: sets a card's date range then triggers its
    // own Generate button, so common variants are one tap instead of four.
    function applyPreset(fromId, toId, key){
      const now = new Date();
      let from = new Date(now), to = new Date(now);
      if(key==="week"){ from.setDate(now.getDate()-6); }
      else if(key==="month"){ from = new Date(now.getFullYear(), now.getMonth(), 1); }
      document.getElementById(fromId).value = from.toISOString().slice(0,10);
      document.getElementById(toId).value = to.toISOString().slice(0,10);
    }
    const PRESET_TARGETS = {
      sales:["salesFrom","salesTo","genSales"], stock:["stockFrom","stockTo","genStock"],
      credit:["creditFrom","creditTo","genCredit"], disc:["discFrom","discTo","genDiscount"],
      margin:["marginFrom","marginTo","genMargin"], fast:["fastFrom","fastTo","genFast"],
      payout:["payoutFrom","payoutTo","genPayoutReport"], branch:["brFrom","brTo","genBranchReport"],
    };
    main.querySelectorAll("[data-preset]").forEach(btn=>{
      btn.onclick=()=>{
        const [cardKey,presetKey] = btn.dataset.preset.split(":");
        const target = PRESET_TARGETS[cardKey];
        if(!target) return;
        applyPreset(target[0], target[1], presetKey);
        document.getElementById("menu-"+cardKey).style.display="none";
        document.getElementById(target[2]).click();
      };
    });


    document.getElementById("genSales").onclick=()=>{
      const {fromTs,toTs} = dateRangeSQL("salesFrom","salesTo");
      const b = branchFilter("salesBranch");
      const sales = b? all("SELECT * FROM sales WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                      : all("SELECT * FROM sales WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
      const rows = sales.map(s=>[new Date(s.ts).toLocaleString(), escapeHtml(s.branch||""), s.method, currency+s.subtotal.toFixed(2), currency+s.discount.toFixed(2), currency+s.total.toFixed(2)]);
      const grand = sales.reduce((s,r)=>s+r.total,0);
      printReport("Sales Report", `${b||"All branches"} · ${fromTs.slice(0,10)} to ${toTs.slice(0,10)}`,
        ["Date/Time","Branch","Method","Subtotal","Discount","Total"], rows, `<p><b>Grand Total: ${currency}${grand.toFixed(2)}</b></p>`);
    };
    document.getElementById("waSales").onclick=()=>{
      const {fromTs,toTs} = dateRangeSQL("salesFrom","salesTo");
      const b = branchFilter("salesBranch");
      const sales = b? all("SELECT * FROM sales WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                      : all("SELECT * FROM sales WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
      const grand = sales.reduce((s,r)=>s+r.total,0);
      const itemLines = sales.slice(0,40).map(s=>padLine(`${s.ts.slice(0,16)} ${s.branch} ${s.method}`, `${currency}${s.total.toFixed(2)}`));
      shareWhatsApp(receiptText(`Sales Report (${b||"All branches"})`, itemLines, [padLine("TOTAL", `${currency}${grand.toFixed(2)}`)]));
    };

    document.getElementById("genInventory").onclick=()=>{
      const b = branchFilter("invBranch");
      const products = b? all("SELECT * FROM products WHERE branch=? ORDER BY name",[b]) : all("SELECT * FROM products ORDER BY branch,name");
      const rows = products.map(p=> b? [skuNameCell(p.sku,p.name), p.stock] : [skuNameCell(p.sku,p.name), escapeHtml(p.branch), p.stock]);
      const headers = b? ["Item","Qty"] : ["Item","Branch","Qty"];
      printReport("Inventory Report", `${b||"All branches"}`, headers, rows, "");
    };

    document.getElementById("genStock").onclick=()=>{
      const {fromTs,toTs} = dateRangeSQL("stockFrom","stockTo");
      const b = branchFilter("stockBranch");
      const recs = b? all("SELECT * FROM stock_received WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                     : all("SELECT * FROM stock_received WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
      const rows = recs.map(r=> b? [new Date(r.ts).toLocaleString(), escapeHtml(r.name), r.qty, escapeHtml(r.note||"")]
                                  : [new Date(r.ts).toLocaleString(), escapeHtml(r.branch), escapeHtml(r.name), r.qty, escapeHtml(r.note||"")]);
      const headers = b? ["Date/Time","Product","Qty","Note"] : ["Date/Time","Branch","Product","Qty","Note"];
      const totalQty = recs.reduce((s,r)=>s+r.qty,0);
      printReport("Stock Received Report", `${b||"All branches"} · ${fromTs.slice(0,10)} to ${toTs.slice(0,10)}`, headers, rows, `<p><b>Total units received: ${totalQty}</b></p>`);
    };

    document.getElementById("genLowStock").onclick=()=>{
      const b = branchFilter("lowBranch");
      const lowStock = b? all("SELECT * FROM products WHERE branch=? AND stock<=low_threshold ORDER BY stock",[b])
                         : all("SELECT * FROM products WHERE stock<=low_threshold ORDER BY branch,stock");
      const rows = lowStock.map(p=> b? [skuNameCell(p.sku,p.name), p.stock, p.low_threshold] : [skuNameCell(p.sku,p.name), escapeHtml(p.branch), p.stock, p.low_threshold]);
      const headers = b? ["Item","Current Stock","Alert Level"] : ["Item","Branch","Current Stock","Alert Level"];
      printReport("Low Stock Report", `${b||"All branches"} · ${new Date().toLocaleDateString()}`, headers, rows, "");
    };

    document.getElementById("genCredit").onclick=()=>{
      const {fromTs,toTs} = dateRangeSQL("creditFrom","creditTo");
      const b = branchFilter("creditBranch");
      const customers = all("SELECT * FROM customers ORDER BY name");
      const rows = [];
      let totalDebt=0, totalPaid=0;
      customers.forEach(c=>{
        const debt = b? one("SELECT COALESCE(SUM(total),0) as t FROM sales WHERE customer_id=? AND method='Credit' AND branch=? AND ts>=? AND ts<=?",[c.id,b,fromTs,toTs]).t
                       : one("SELECT COALESCE(SUM(total),0) as t FROM sales WHERE customer_id=? AND method='Credit' AND ts>=? AND ts<=?",[c.id,fromTs,toTs]).t;
        const paid = b? one("SELECT COALESCE(SUM(amount),0) as t FROM credit_payments WHERE customer_id=? AND branch=? AND ts>=? AND ts<=?",[c.id,b,fromTs,toTs]).t
                       : one("SELECT COALESCE(SUM(amount),0) as t FROM credit_payments WHERE customer_id=? AND ts>=? AND ts<=?",[c.id,fromTs,toTs]).t;
        const balance = customerBalance(c.id);
        if(debt>0 || paid>0){
          rows.push([escapeHtml(c.name), currency+debt.toFixed(2), currency+paid.toFixed(2), currency+balance.toFixed(2)]);
          totalDebt+=debt; totalPaid+=paid;
        }
      });
      printReport("Credit Sales Report", `${b||"All branches"} · ${fromTs.slice(0,10)} to ${toTs.slice(0,10)}`,
        ["Customer","Credit Given","Payments","Current Balance"], rows,
        `<p><b>Period totals — Credit: ${currency}${totalDebt.toFixed(2)} | Payments: ${currency}${totalPaid.toFixed(2)}</b></p>`);
    };

    document.getElementById("genDiscount").onclick=()=>{
      const {fromTs,toTs} = dateRangeSQL("discFrom","discTo");
      const b = branchFilter("discBranch");
      const sales = (b? all("SELECT * FROM sales WHERE branch=? AND discount>0 AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                      : all("SELECT * FROM sales WHERE discount>0 AND ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]));
      const rows = sales.map(s=>{
        const cust = s.customer_id? one("SELECT name FROM customers WHERE id=?",[s.customer_id]) : null;
        return [new Date(s.ts).toLocaleString(), s.id, escapeHtml(cust?cust.name:"—"), currency+s.subtotal.toFixed(2),
          currency+s.discount.toFixed(2), currency+s.total.toFixed(2), escapeHtml(s.discount_reason||""),
          escapeHtml(s.discount_status||"")];
      });
      const totalDisc = sales.reduce((s,r)=>s+r.discount,0);
      printReport("Discount Report", `${b||"All branches"} · ${fromTs.slice(0,10)} to ${toTs.slice(0,10)}`,
        ["Date","Receipt#","Customer","Amount","Discount","Cash Paid","Reason","Status"], rows,
        `<p><b>Total discounts given: ${currency}${totalDisc.toFixed(2)}</b></p>`);
    };

    const marginBtn = document.getElementById("genMargin");
    if(marginBtn) marginBtn.onclick=()=>{
      const {fromTs,toTs} = dateRangeSQL("marginFrom","marginTo");
      const b = branchFilter("marginBranch");
      const items = b? all(`SELECT si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.branch=? AND s.ts>=? AND s.ts<=?`,[b,fromTs,toTs])
                      : all(`SELECT si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.ts>=? AND s.ts<=?`,[fromTs,toTs]);
      const byName = {};
      items.forEach(i=>{
        if(!byName[i.name]) byName[i.name]={qty:0,revenue:0,cost:0};
        byName[i.name].qty += i.qty;
        byName[i.name].revenue += i.price*i.qty;
        byName[i.name].cost += (i.cost||0)*i.qty;
      });
      let totalRev=0, totalCost=0;
      const rows = Object.keys(byName).sort().map(name=>{
        const r = byName[name]; const margin = r.revenue-r.cost;
        const pct = r.revenue>0? (margin/r.revenue*100).toFixed(1)+"%" : "—";
        totalRev+=r.revenue; totalCost+=r.cost;
        return [escapeHtml(name), r.qty, currency+r.revenue.toFixed(2), currency+r.cost.toFixed(2), currency+margin.toFixed(2), pct];
      });
      const totalMargin = totalRev-totalCost;
      const totalPct = totalRev>0? (totalMargin/totalRev*100).toFixed(1)+"%" : "—";
      printReport("Margin Report", `${b||"All branches"} · ${fromTs.slice(0,10)} to ${toTs.slice(0,10)}`,
        ["Item","Qty Sold","Revenue","Cost","Margin","Margin %"], rows,
        `<p><b>Total — Revenue: ${currency}${totalRev.toFixed(2)} | Cost: ${currency}${totalCost.toFixed(2)} | Margin: ${currency}${totalMargin.toFixed(2)} (${totalPct})</b></p>`);
    };

    document.getElementById("genAging").onclick=()=>{
      const b = branchFilter("agingBranch");
      const products = b? all("SELECT * FROM products WHERE branch=? ORDER BY name",[b]) : all("SELECT * FROM products ORDER BY branch,name");
      const rows = products.map(p=>{
        const days = productAgeDays(p);
        return b? [skuNameCell(p.sku,p.name), p.stock, days, agingBucket(days)]
                : [skuNameCell(p.sku,p.name), escapeHtml(p.branch), p.stock, days, agingBucket(days)];
      });
      const headers = b? ["Item","Stock","Days","Bucket"] : ["Item","Branch","Stock","Days","Bucket"];
      printReport("Aging Inventory", `${b||"All branches"} · as of ${new Date().toLocaleDateString()}`, headers, rows, "");
    };

    document.getElementById("genFast").onclick=()=>{
      const {fromTs,toTs} = dateRangeSQL("fastFrom","fastTo");
      const b = branchFilter("fastBranch");
      const items = b? all(`SELECT si.name, si.qty, si.price FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.branch=? AND s.ts>=? AND s.ts<=?`,[b,fromTs,toTs])
                      : all(`SELECT si.name, si.qty, si.price FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.ts>=? AND s.ts<=?`,[fromTs,toTs]);
      const byName = {};
      items.forEach(i=>{ if(!byName[i.name]) byName[i.name]={qty:0,revenue:0}; byName[i.name].qty+=i.qty; byName[i.name].revenue+=i.price*i.qty; });
      const rows = Object.keys(byName).map(n=>({name:n,...byName[n]})).sort((a,b2)=>b2.qty-a.qty).slice(0,30)
        .map(r=>[escapeHtml(r.name), r.qty, currency+r.revenue.toFixed(2)]);
      printReport("Fast Moving Items", `${b||"All branches"} · ${fromTs.slice(0,10)} to ${toTs.slice(0,10)}`,
        ["Item","Qty Sold","Revenue"], rows, "");
    };

    document.getElementById("genPayoutReport").onclick=()=>{
      const {fromTs,toTs} = dateRangeSQL("payoutFrom","payoutTo");
      const b = branchFilter("payoutBranch");
      const payouts = b? all("SELECT * FROM payouts WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                        : all("SELECT * FROM payouts WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
      const rows = payouts.map(p=> b? [new Date(p.ts).toLocaleString(), escapeHtml(p.reason||""), currency+p.amount.toFixed(2), escapeHtml(p.user||"")]
                                     : [new Date(p.ts).toLocaleString(), escapeHtml(p.branch), escapeHtml(p.reason||""), currency+p.amount.toFixed(2), escapeHtml(p.user||"")]);
      const headers = b? ["Date/Time","Reason","Amount","By"] : ["Date/Time","Branch","Reason","Amount","By"];
      const total = payouts.reduce((s,r)=>s+r.amount,0);
      printReport("Payouts Report", `${b||"All branches"} · ${fromTs.slice(0,10)} to ${toTs.slice(0,10)}`, headers, rows,
        `<p><b>Total payouts: ${currency}${total.toFixed(2)}</b></p>`);
    };

    document.getElementById("genCustomers").onclick=()=>{
      const b = branchFilter("custBranch");
      const customers = b? all("SELECT * FROM customers WHERE branch=? ORDER BY name",[b]) : all("SELECT * FROM customers ORDER BY name");
      const rows = customers.map(c=>[escapeHtml(c.name), escapeHtml(c.phone||""), currency+customerBalance(c.id).toFixed(2)]);
      printReport("Customer Report", `${b||"All branches"} · sorted by name`, ["Customer","Phone","Balance"], rows, "");
    };

    document.getElementById("genBranchReport").onclick=()=>{
      const b = branchFilter("brBranch") || currentBranch();
      const {fromTs,toTs} = dateRangeSQL("brFrom","brTo");
      const stock = all("SELECT * FROM products WHERE branch=? ORDER BY name",[b]);
      const sales = all("SELECT * FROM sales WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs]);
      const credits = all("SELECT * FROM sales WHERE branch=? AND method='Credit' AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs]);
      const eods = all("SELECT * FROM eod_sessions WHERE branch=? AND date>=? AND date<=? ORDER BY date",[b,fromTs.slice(0,10),toTs.slice(0,10)]);
      const discSales = sales.filter(s=>s.discount>0);
      const payouts = all("SELECT * FROM payouts WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs]);
      const customersList = all("SELECT * FROM customers WHERE branch=? ORDER BY name",[b]);
      const received = all("SELECT * FROM stock_received WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts DESC",[b,fromTs,toTs]);
      const changes = all("SELECT * FROM audit_log WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts DESC",[b,fromTs,toTs]);
      const stockActivity = [
        ...received.map(r=>({ts:r.ts,type:"Received",item:r.name,detail:(r.qty>0?"+":"")+r.qty,user:r.user||""})),
        ...changes.map(c=>({ts:c.ts,type:c.action,item:c.product_name,detail:c.details,user:c.user||""}))
      ].sort((a,c)=> a.ts<c.ts?1:-1).slice(0,50);
      const salesTotal = sales.reduce((s,r)=>s+r.total,0);
      const payoutsTotal = payouts.reduce((s,r)=>s+r.amount,0);
      const discTotal = discSales.reduce((s,r)=>s+r.discount,0);
      const agingRows = stock.map(p=>({name:p.name,sku:p.sku,stock:p.stock,days:productAgeDays(p)}));
      const fastMap = {};
      all(`SELECT si.name, si.qty FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.branch=? AND s.ts>=? AND s.ts<=?`,[b,fromTs,toTs])
        .forEach(i=>{ fastMap[i.name]=(fastMap[i.name]||0)+i.qty; });
      const fastRows = Object.keys(fastMap).map(n=>({name:n,qty:fastMap[n]})).sort((a,c)=>c.qty-a.qty).slice(0,10);
      const remoteView = isRemote();

      document.getElementById("printArea").innerHTML = `
        <div class="report-print">
          <h2>${escapeHtml(getSetting("shop_name","My Shop"))} — Branch Report</h2>
          <div class="sub">${escapeHtml(b)} · ${fromTs.slice(0,10)} to ${toTs.slice(0,10)}</div>

          <h3 class="section">Stock List</h3>
          <table><tr><th>Item</th><th>Qty</th></tr>
          ${stock.map(p=>`<tr><td>${skuNameCell(p.sku,p.name)}</td><td>${p.stock}</td></tr>`).join("")}
          </table>

          <h3 class="section">Sales (by user)</h3>
          <table><tr><th>Date/Time</th><th>Method</th><th>Total</th><th>Sold By</th></tr>
          ${sales.map(s=>`<tr><td>${new Date(s.ts).toLocaleString()}</td><td>${s.method}</td><td>${currency}${s.total.toFixed(2)}</td><td>${escapeHtml(s.user||"")}</td></tr>`).join("")}
          </table>
          <p><b>Sales total: ${currency}${salesTotal.toFixed(2)}</b></p>

          <h3 class="section">Credit Sales</h3>
          <table><tr><th>Date/Time</th><th>Total</th></tr>
          ${credits.map(s=>`<tr><td>${new Date(s.ts).toLocaleString()}</td><td>${currency}${s.total.toFixed(2)}</td></tr>`).join("")}
          </table>

          <h3 class="section">Discounts Allowed to Customers</h3>
          <table><tr><th>Date</th><th>Customer</th><th>Discount</th><th>Reason</th><th>Status</th></tr>
          ${discSales.map(s=>{ const c=s.customer_id?one("SELECT name FROM customers WHERE id=?",[s.customer_id]):null;
            return `<tr><td>${new Date(s.ts).toLocaleString()}</td><td>${escapeHtml(c?c.name:"—")}</td><td>${currency}${s.discount.toFixed(2)}</td><td>${escapeHtml(s.discount_reason||"")}</td><td>${escapeHtml(s.discount_status||"")}</td></tr>`;
          }).join("")}
          </table>
          <p><b>Total discounts: ${currency}${discTotal.toFixed(2)}</b></p>

          <h3 class="section">Aging Inventory</h3>
          <table><tr><th>Item</th><th>Stock</th><th>Days</th><th>Bucket</th></tr>
          ${agingRows.map(r=>`<tr><td>${skuNameCell(r.sku,r.name)}</td><td>${r.stock}</td><td>${r.days}</td><td>${agingBucket(r.days)}</td></tr>`).join("")}
          </table>

          <h3 class="section">Fast Moving Items</h3>
          <table><tr><th>Item</th><th>Qty Sold</th></tr>
          ${fastRows.map(r=>`<tr><td>${escapeHtml(r.name)}</td><td>${r.qty}</td></tr>`).join("")}
          </table>

          <h3 class="section">Recent Stock Activity (Received / Updated)</h3>
          <table><tr><th>Date/Time</th><th>Type</th><th>Item</th><th>Detail</th><th>By</th></tr>
          ${stockActivity.map(a=>`<tr><td>${new Date(a.ts).toLocaleString()}</td><td>${escapeHtml(a.type)}</td><td>${escapeHtml(a.item||"")}</td><td>${escapeHtml(a.detail||"")}</td><td>${escapeHtml(a.user)}</td></tr>`).join("")}
          </table>

          <h3 class="section">Payouts</h3>
          <table><tr><th>Date/Time</th><th>Reason</th><th>Amount</th><th>By</th></tr>
          ${payouts.map(p=>`<tr><td>${new Date(p.ts).toLocaleString()}</td><td>${escapeHtml(p.reason||"")}</td><td>${currency}${p.amount.toFixed(2)}</td><td>${escapeHtml(p.user||"")}</td></tr>`).join("")}
          </table>
          <p><b>Total payouts: ${currency}${payoutsTotal.toFixed(2)}</b></p>

          <h3 class="section">EOD Variances</h3>
          <table><tr><th>Date</th><th>Expected</th><th>Counted</th><th>Variance</th></tr>
          ${eods.map(e=>`<tr><td>${e.date}</td><td>${currency}${e.expected_cash.toFixed(2)}</td><td>${currency}${e.counted_cash.toFixed(2)}</td><td>${currency}${e.variance.toFixed(2)}</td></tr>`).join("")}
          </table>

          <h3 class="section">Customers (by name)</h3>
          <table><tr><th>Customer</th><th>Phone</th><th>Balance</th></tr>
          ${customersList.map(c=>`<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.phone||"")}</td><td>${currency}${customerBalance(c.id).toFixed(2)}</td></tr>`).join("")}
          </table>
        </div>`;
      printNow(null);
    };
  }

