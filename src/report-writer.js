
  // ---------------- Report Writer (view reports on screen, not just print) ----------------
  // Each config's fetch() returns {headers, rows, footer} using the exact
  // same queries as the matching card in the Reports tab, so the on-screen
  // view and the printed PDF are always guaranteed to agree.
  const REPORT_CONFIGS = [
    { id:"sales", label:"Sales Report", hasDate:true,
      fetch(b,fromTs,toTs){
        const sales = b? all("SELECT * FROM sales WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                        : all("SELECT * FROM sales WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
        const rows = sales.map(s=>[`<button type="button" class="btn btn-outline btn-sm" data-view-sale="${s.id}" style="padding:4px 10px;font-size:12px">${s.id}</button>`, new Date(s.ts).toLocaleString(), escapeHtml(s.branch||""), s.method, currency+s.subtotal.toFixed(2), currency+s.discount.toFixed(2), currency+(s.markup||0).toFixed(2), currency+s.total.toFixed(2)]);
        const grand = sales.reduce((s,r)=>s+r.total,0);
        return { headers:["Receipt#","Date/Time","Branch","Method","Subtotal","Discount","Markup","Total"], rows, footer:`Grand Total: ${currency}${grand.toFixed(2)}` };
      }
    },
    { id:"inventory", label:"Inventory Report", hasDate:false,
      fetch(b){
        const products = b? all("SELECT * FROM products WHERE branch=? ORDER BY name",[b]) : all("SELECT * FROM products ORDER BY branch,name");
        const rows = products.map(p=> b? [skuNameCell(p.sku,p.name), p.stock] : [skuNameCell(p.sku,p.name), escapeHtml(p.branch), p.stock]);
        const headers = b? ["Item","Qty"] : ["Item","Branch","Qty"];
        return { headers, rows, footer:"" };
      }
    },
    { id:"stock", label:"Stock Received Report", hasDate:true,
      fetch(b,fromTs,toTs){
        const recs = b? all("SELECT * FROM stock_received WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                       : all("SELECT * FROM stock_received WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
        const rows = recs.map(r=> b? [new Date(r.ts).toLocaleString(), escapeHtml(r.name), r.qty, escapeHtml(r.note||"")]
                                    : [new Date(r.ts).toLocaleString(), escapeHtml(r.branch), escapeHtml(r.name), r.qty, escapeHtml(r.note||"")]);
        const headers = b? ["Date/Time","Product","Qty","Note"] : ["Date/Time","Branch","Product","Qty","Note"];
        const totalQty = recs.reduce((s,r)=>s+r.qty,0);
        return { headers, rows, footer:`Total units received: ${totalQty}` };
      }
    },
    { id:"lowstock", label:"Low Stock Report", hasDate:false,
      fetch(b){
        const lowStock = b? all("SELECT * FROM products WHERE branch=? AND stock<=low_threshold ORDER BY stock",[b])
                           : all("SELECT * FROM products WHERE stock<=low_threshold ORDER BY branch,stock");
        const rows = lowStock.map(p=> b? [skuNameCell(p.sku,p.name), p.stock, p.low_threshold] : [skuNameCell(p.sku,p.name), escapeHtml(p.branch), p.stock, p.low_threshold]);
        const headers = b? ["Item","Current Stock","Alert Level"] : ["Item","Branch","Current Stock","Alert Level"];
        return { headers, rows, footer:"" };
      }
    },
    { id:"credit", label:"Credit Sales Report", hasDate:true,
      fetch(b,fromTs,toTs){
        const customers = all("SELECT * FROM customers ORDER BY name");
        const rows = []; let totalDebt=0, totalPaid=0;
        customers.forEach(c=>{
          const debt = b? one("SELECT COALESCE(SUM(total),0) as t FROM sales WHERE customer_id=? AND method='Credit' AND branch=? AND ts>=? AND ts<=?",[c.id,b,fromTs,toTs]).t
                         : one("SELECT COALESCE(SUM(total),0) as t FROM sales WHERE customer_id=? AND method='Credit' AND ts>=? AND ts<=?",[c.id,fromTs,toTs]).t;
          const paid = b? one("SELECT COALESCE(SUM(amount),0) as t FROM credit_payments WHERE customer_id=? AND branch=? AND ts>=? AND ts<=?",[c.id,b,fromTs,toTs]).t
                         : one("SELECT COALESCE(SUM(amount),0) as t FROM credit_payments WHERE customer_id=? AND ts>=? AND ts<=?",[c.id,fromTs,toTs]).t;
          const balance = customerBalance(c.id);
          if(debt>0 || paid>0){ rows.push([escapeHtml(c.name), currency+debt.toFixed(2), currency+paid.toFixed(2), currency+balance.toFixed(2)]); totalDebt+=debt; totalPaid+=paid; }
        });
        return { headers:["Customer","Credit Given","Payments","Current Balance"], rows, footer:`Period totals — Credit: ${currency}${totalDebt.toFixed(2)} | Payments: ${currency}${totalPaid.toFixed(2)}` };
      }
    },
    { id:"discount", label:"Discount Report", hasDate:true,
      fetch(b,fromTs,toTs){
        const sales = b? all("SELECT * FROM sales WHERE branch=? AND discount>0 AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                        : all("SELECT * FROM sales WHERE discount>0 AND ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
        const rows = sales.map(s=>{
          const cust = s.customer_id? one("SELECT name FROM customers WHERE id=?",[s.customer_id]) : null;
          return [new Date(s.ts).toLocaleString(), s.id, escapeHtml(cust?cust.name:"—"), currency+s.subtotal.toFixed(2), currency+s.discount.toFixed(2), currency+s.total.toFixed(2), escapeHtml(s.discount_reason||""), escapeHtml(s.discount_status||"")];
        });
        const totalDisc = sales.reduce((s,r)=>s+r.discount,0);
        return { headers:["Date","Receipt#","Customer","Amount","Discount","Cash Paid","Reason","Status"], rows, footer:`Total discounts given: ${currency}${totalDisc.toFixed(2)}` };
      }
    },
    // Per-staff commission summary — not remoteHidden, same visibility rule
    // as Discount Report: markup is about selling price, not cost, so it's
    // fine for Remote branches to see.
    { id:"markup", label:"Markup Report", hasDate:true,
      fetch(b,fromTs,toTs){
        const sales = b? all("SELECT * FROM sales WHERE branch=? AND markup>0 AND ts>=? AND ts<=?",[b,fromTs,toTs])
                        : all("SELECT * FROM sales WHERE markup>0 AND ts>=? AND ts<=?",[fromTs,toTs]);
        const byUser = {};
        sales.forEach(s=>{
          const user = s.user||"—";
          if(!byUser[user]) byUser[user] = {count:0, total:0};
          byUser[user].count++; byUser[user].total += s.markup;
        });
        const rows = Object.keys(byUser).sort((a,b2)=>byUser[b2].total-byUser[a].total)
          .map(user=>[escapeHtml(user), byUser[user].count, currency+byUser[user].total.toFixed(2)]);
        const grand = Object.values(byUser).reduce((s,u)=>s+u.total,0);
        return { headers:["Staff","Sales with Markup","Total Markup"], rows, footer:`Total markup: ${currency}${grand.toFixed(2)}` };
      }
    },
    { id:"margin", label:"Margin Report", hasDate:true, remoteHidden:true,
      fetch(b,fromTs,toTs){
        const items = b? all(`SELECT si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.branch=? AND s.ts>=? AND s.ts<=?`,[b,fromTs,toTs])
                        : all(`SELECT si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.ts>=? AND s.ts<=?`,[fromTs,toTs]);
        const byName = {};
        items.forEach(i=>{ if(!byName[i.name]) byName[i.name]={qty:0,revenue:0,cost:0}; byName[i.name].qty+=i.qty; byName[i.name].revenue+=i.price*i.qty; byName[i.name].cost+=(i.cost||0)*i.qty; });
        let totalRev=0, totalCost=0;
        const rows = Object.keys(byName).sort().map(name=>{
          const r=byName[name]; const margin=r.revenue-r.cost; const pct=r.revenue>0?(margin/r.revenue*100).toFixed(1)+"%":"—";
          totalRev+=r.revenue; totalCost+=r.cost;
          return [escapeHtml(name), r.qty, currency+r.revenue.toFixed(2), currency+r.cost.toFixed(2), currency+margin.toFixed(2), pct];
        });
        const totalMargin = totalRev-totalCost;
        const totalPct = totalRev>0? (totalMargin/totalRev*100).toFixed(1)+"%" : "—";
        return { headers:["Item","Qty Sold","Revenue","Cost","Margin","Margin %"], rows, footer:`Total — Revenue: ${currency}${totalRev.toFixed(2)} | Cost: ${currency}${totalCost.toFixed(2)} | Margin: ${currency}${totalMargin.toFixed(2)} (${totalPct})` };
      }
    },
    { id:"aging", label:"Aging Inventory", hasDate:false,
      fetch(b){
        const products = b? all("SELECT * FROM products WHERE branch=? ORDER BY name",[b]) : all("SELECT * FROM products ORDER BY branch,name");
        const rows = products.map(p=>{ const days=productAgeDays(p); return b? [skuNameCell(p.sku,p.name), p.stock, days, agingBucket(days)] : [skuNameCell(p.sku,p.name), escapeHtml(p.branch), p.stock, days, agingBucket(days)]; });
        const headers = b? ["Item","Stock","Days","Bucket"] : ["Item","Branch","Stock","Days","Bucket"];
        return { headers, rows, footer:"" };
      }
    },
    { id:"fast", label:"Fast Moving Items", hasDate:true,
      fetch(b,fromTs,toTs){
        const items = b? all(`SELECT si.name, si.qty, si.price FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.branch=? AND s.ts>=? AND s.ts<=?`,[b,fromTs,toTs])
                        : all(`SELECT si.name, si.qty, si.price FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.ts>=? AND s.ts<=?`,[fromTs,toTs]);
        const byName = {};
        items.forEach(i=>{ if(!byName[i.name]) byName[i.name]={qty:0,revenue:0}; byName[i.name].qty+=i.qty; byName[i.name].revenue+=i.price*i.qty; });
        const rows = Object.keys(byName).map(n=>({name:n,...byName[n]})).sort((a,b2)=>b2.qty-a.qty).slice(0,30).map(r=>[escapeHtml(r.name), r.qty, currency+r.revenue.toFixed(2)]);
        return { headers:["Item","Qty Sold","Revenue"], rows, footer:"" };
      }
    },
    { id:"payouts", label:"Payouts Report", hasDate:true,
      fetch(b,fromTs,toTs){
        const payouts = b? all("SELECT * FROM payouts WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                          : all("SELECT * FROM payouts WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
        const rows = payouts.map(p=> b? [new Date(p.ts).toLocaleString(), escapeHtml(p.reason||""), currency+p.amount.toFixed(2), escapeHtml(p.user||"")] : [new Date(p.ts).toLocaleString(), escapeHtml(p.branch), escapeHtml(p.reason||""), currency+p.amount.toFixed(2), escapeHtml(p.user||"")]);
        const headers = b? ["Date/Time","Reason","Amount","By"] : ["Date/Time","Branch","Reason","Amount","By"];
        const total = payouts.reduce((s,r)=>s+r.amount,0);
        return { headers, rows, footer:`Total payouts: ${currency}${total.toFixed(2)}` };
      }
    },
    { id:"purchases", label:"Purchases", hasDate:true, remoteHidden:true,
      fetch(b,fromTs,toTs){
        const purchases = b? all("SELECT * FROM purchases WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                            : all("SELECT * FROM purchases WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
        const rows = purchases.map(p=>[new Date(p.ts).toLocaleString(), escapeHtml(p.supplier), skuNameCell(p.sku,p.product_name), p.qty, currency+p.unit_cost.toFixed(2), currency+p.total_cost.toFixed(2)]);
        const total = purchases.reduce((s,r)=>s+r.total_cost,0);
        return { headers:["Date","Supplier","Item","Qty","Unit Cost","Total Cost"], rows, footer:`Total spent: ${currency}${total.toFixed(2)}` };
      }
    },
    { id:"customers", label:"Customer Report", hasDate:false,
      fetch(b){
        const customers = b? all("SELECT * FROM customers WHERE branch=? ORDER BY name",[b]) : all("SELECT * FROM customers ORDER BY name");
        const rows = customers.map(c=>[escapeHtml(c.name), escapeHtml(c.phone||""), currency+customerBalance(c.id).toFixed(2)]);
        return { headers:["Customer","Phone","Balance"], rows, footer:"" };
      }
    },
    { id:"requests", label:"Stock Requests", hasDate:false,
      fetch(b){
        const reqs = b? all("SELECT * FROM stock_requests WHERE branch=? ORDER BY ts DESC",[b]) : all("SELECT * FROM stock_requests ORDER BY ts DESC");
        const rows = reqs.map(r=>[new Date(r.ts).toLocaleString(), escapeHtml(r.branch), escapeHtml(r.item_requested), escapeHtml(r.customer_name||""), r.qty_wanted||"", r.fulfilled?"Fulfilled":"Open"]);
        return { headers:["Date","Branch","Item","Customer","Qty","Status"], rows, footer:"" };
      }
    },
    { id:"transfers", label:"Stock Dispatched", hasDate:true,
      fetch(b,fromTs,toTs){
        const transfers = b? all("SELECT * FROM stock_transfers WHERE (from_branch=? OR to_branch=?) AND ts>=? AND ts<=? ORDER BY ts",[b,b,fromTs,toTs])
                            : all("SELECT * FROM stock_transfers WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
        // DN lines show the DN's real status (joined on dispatching branch id + dn_no);
        // older transfers keep their own line status.
        const mv = dnStatusMap(), byName = new Map();
        mv.forEach(r=>byName.set(String(r.from).toLowerCase()+"|"+r.dnNo, r));
        const statusOf = (t)=>{
          if(t.dn_no==null) return t.status;
          const r = (t.dn_branch_id && mv.get(t.dn_branch_id+"|"+t.dn_no)) || byName.get(String(t.from_branch).toLowerCase()+"|"+t.dn_no);
          return r? (DN_STATUS_LABEL[r.status]+(r.grvNo? " ("+formatDocNo("GRV",r.grvNo)+")" : "")) : "Dispatched";
        };
        const rows = transfers.map(t=>[new Date(t.ts).toLocaleString(), escapeHtml(t.from_branch), escapeHtml(t.to_branch), skuNameCell(t.sku,t.product_name), t.qty, escapeHtml(statusOf(t)), escapeHtml(t.user||"")]);
        return { headers:["Date","From","To","Item","Qty","Status","By"], rows, footer:"" };
      }
    },
    // Main only. Information only: nothing here changes any record.
    // Information only. Value is at MAIN's cost by product code (blank where main has no cost for it).
    { id:"adjustments", label:"Stock Adjustments", hasDate:true, hasReason:true, mainOnly:true,
      fetch(b,fromTs,toTs,gran,status,opts){ return adjustmentsTable(b,fromTs,toTs,(opts&&opts.reason)||""); }
    },
    { id:"movements", label:"Stock Movements", hasDate:true, hasStatus:true, hasReason:true, hasView:true, mainOnly:true,
      fetch(b,fromTs,toTs,gran,status,opts){
        if(opts && opts.view==="adjustments") return adjustmentsTable(b,fromTs,toTs,opts.reason||"");   // a separate view, never mixed into DN statuses
        const all_ = dnMovementRows();
        const rows = filterMovements(all_, { branch:b||"", status:status||"", fromMs:Date.parse(fromTs), toMs:Date.parse(toTs) });
        // loss written off on a DN (linked adjustments other than the restore), valued at MAIN's cost by product code
        const mainProducts = all("SELECT sku,cost FROM products WHERE branch=?",[currentBranch()]);
        const linked = adjustmentReportData(all("SELECT * FROM stock_adjustments WHERE dn_no IS NOT NULL AND reason<>'Dispatch cancelled' AND qty_delta<0"), mainProducts, {}).rows;
        const loss = new Map(); linked.forEach(a=>{ if(a.value==null) return; const k = a.dn_branch_id+"|"+a.dn_no; loss.set(k,(loss.get(k)||0)+(-a.value)); });
        const out = rows.map(r=>[escapeHtml(r.dnDisplay), escapeHtml(r.from), escapeHtml(r.to),
          r.dispatchedTs? escapeHtml(new Date(r.dispatchedTs).toLocaleDateString()) : "—",
          dnStatusBadge(r.status)+(r.cancelPending && r.status!=="cancel_pending"? " <span style='font-size:11px;color:#b54708'>+ cancel pending</span>" : ""),
          r.grvNo? escapeHtml(formatDocNo("GRV",r.grvNo)) : "", escapeHtml(varianceText(r)), escapeHtml(chainText(r)),
          loss.has(r.key)? currency+loss.get(r.key).toFixed(2) : ""]);
        const n = (st)=>rows.filter(r=>r.status===st).length;
        return { headers:["DN","From","To","Dispatched","Status","GRV","Variance","Chain / notes","Loss (main cost)"], rows:out,
          footer:`${rows.length} DN${rows.length===1?"":"s"} · Dispatched ${n("dispatched")} · Awaiting ${n("awaiting")} · Variance ${n("variance")} · Cancel pending ${n("cancel_pending")} · Received ${n("received")} · Cancelled ${n("cancelled")} · Superseded ${n("superseded")} · Closed as loss ${n("loss_closed")} · Conflict ${n("conflict")} (awaiting = no GRV after ${awaitingDays()} days)` };
      }
    },
    { id:"activity", label:"App Activity Log", hasDate:true,
      fetch(b,fromTs,toTs){
        const logs = b? all("SELECT * FROM audit_log WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts DESC",[b,fromTs,toTs])
                       : all("SELECT * FROM audit_log WHERE ts>=? AND ts<=? ORDER BY ts DESC",[fromTs,toTs]);
        const rows = logs.map(a=>[new Date(a.ts).toLocaleString(), escapeHtml(a.branch||""), escapeHtml(a.user||""), escapeHtml(a.action||""), escapeHtml(a.product_name||""), escapeHtml(a.details||"")]);
        return { headers:["Date/Time","Branch","User","Action","Item","Details"], rows, footer:"" };
      }
    },
    { id:"nopricecost", label:"Items Missing Price/Cost", hasDate:false, remoteHidden:true,
      fetch(b){
        const products = b? all("SELECT * FROM products WHERE branch=? AND (price<=0 OR cost<=0) ORDER BY name",[b])
                           : all("SELECT * FROM products WHERE (price<=0 OR cost<=0) ORDER BY branch,name");
        const rows = products.map(p=>{
          const priceCell = p.price<=0? "Missing" : currency+p.price.toFixed(2);
          const costCell = p.cost<=0? "Missing" : currency+p.cost.toFixed(2);
          return b? [skuNameCell(p.sku,p.name), priceCell, costCell] : [skuNameCell(p.sku,p.name), escapeHtml(p.branch), priceCell, costCell];
        });
        const headers = b? ["Item","Price","Cost"] : ["Item","Branch","Price","Cost"];
        return { headers, rows, footer:"" };
      }
    },
    { id:"salestrend", label:"Sales Trend", hasDate:true, hasGranularity:true,
      fetch(b,fromTs,toTs,granularity){
        const sales = b? all("SELECT * FROM sales WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[b,fromTs,toTs])
                        : all("SELECT * FROM sales WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
        function bucketKey(ts){
          if(granularity==="month") return ts.slice(0,7);
          if(granularity==="year") return ts.slice(0,4);
          if(granularity==="week"){
            // Simple Monday-start bucketing, computed off the date portion
            // only (as a local midnight) so it doesn't need to be strict
            // ISO-8601 or worry about UTC/local skew near midnight.
            const d = new Date(ts.slice(0,10)+"T00:00:00");
            const day = d.getDay();
            const diff = day===0? -6 : 1-day;
            d.setDate(d.getDate()+diff);
            const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), dd=String(d.getDate()).padStart(2,"0");
            return `${y}-${m}-${dd}`;
          }
          return ts.slice(0,10); // day (default)
        }
        const buckets = {};
        sales.forEach(s=>{ const key = bucketKey(s.ts); buckets[key] = (buckets[key]||0) + s.total; });
        const sortedKeys = Object.keys(buckets).sort();
        const chartData = sortedKeys.map(k=>({label:k, value:buckets[k]}));
        const rows = sortedKeys.map(k=>[k, currency+buckets[k].toFixed(2)]);
        const grand = sortedKeys.reduce((s,k)=>s+buckets[k],0);
        return { headers:["Period","Total Sales"], rows, footer:`Grand Total: ${currency}${grand.toFixed(2)}`, chartData };
      }
    },
  ];
  function adjustmentsTable(b,fromTs,toTs,reason){
    const d = adjustmentReport({ branch:b||"", reason:reason||"", fromMs:Date.parse(fromTs), toMs:Date.parse(toTs) });
    const money = (v)=> v==null? "" : (v<0? "-" : "")+currency+Math.abs(v).toFixed(2);
    const rows = d.rows.map(r=>[escapeHtml(new Date(r.ts).toLocaleDateString()), escapeHtml(r.branch), skuNameCell(r.product_code,r.product_name),
      (r.qty_delta>0?"+":"")+r.qty_delta, escapeHtml(r.reason), escapeHtml(r.note||""), escapeHtml(r.by_user||"")+" / "+escapeHtml(r.authorised_by||""), money(r.value)]);
    d.totals.forEach(t=>rows.push([`<b>Total</b>`,"","",`<b>${t.units>0?"+":""}${t.units}</b>`,`<b>${escapeHtml(t.reason)}</b> (${t.count})`,"","",`<b>${money(t.value)}</b>`]));
    const units = d.rows.reduce((s,r)=>s+r.qty_delta,0);
    return { headers:["Date","Branch","Item","Qty","Reason","Note","By / Admin","Value"], rows,
      footer:`${d.rows.length} adjustment${d.rows.length===1?"":"s"} · net ${units>0?"+":""}${units} units · values at main's cost by product code${d.unvalued? " ("+d.unvalued+" without a main cost, left blank)" : ""}` };
  }
  function reportWriterConfigs(){ return REPORT_CONFIGS.filter(c=> !((c.remoteHidden || c.mainOnly) && isRemote())); }
  function renderReportWriter(main){
    const configs = reportWriterConfigs();
    let selected = configs.find(c=>c.id===rwType) || configs[0];
    rwType = selected.id;
    const today = new Date().toISOString().slice(0,10);
    main.innerHTML = `
      <p class="muted">View most reports right here, with filters — no printing needed just to read the numbers.</p>
      <label>Report</label>
      <select class="field" id="rwTypeSel">
        ${configs.map(c=>`<option value="${c.id}" ${c.id===rwType?"selected":""}>${c.label}</option>`).join("")}
      </select>
      <label>Branch</label>${branchSelectHtml("rwBranchSel", rwBranch)}
      ${selected.hasDate? `<div class="row"><div><label>From</label><input class="field" id="rwFrom" type="date" value="${rwFrom||today}"></div><div><label>To</label><input class="field" id="rwTo" type="date" value="${rwTo||today}"></div></div>` : ""}
      ${selected.hasView? `<label>View</label>
        <select class="field" id="rwViewSel"><option value="dn" ${rwView!=="adjustments"?"selected":""}>Delivery Notes</option><option value="adjustments" ${rwView==="adjustments"?"selected":""}>Stock adjustments</option></select>` : ""}
      ${selected.hasReason && (!selected.hasView || rwView==="adjustments")? `<label>Reason</label>
        <select class="field" id="rwReasonSel"><option value="">All reasons</option>${ADJ_REASONS.concat(ADJ_SYSTEM_REASONS).map(r=>`<option value="${escapeHtml(r)}" ${rwReason===r?"selected":""}>${escapeHtml(r)}</option>`).join("")}</select>` : ""}
      ${selected.hasStatus && (!selected.hasView || rwView!=="adjustments")? `<label>Status</label>
        <select class="field" id="rwStatusSel">
          ${[["","All"],["attention","Needs attention"],["dispatched","Dispatched"],["awaiting","Awaiting"],["variance","Variance"],["cancel_pending","Cancel pending"],["received","Received"],["cancelled","Cancelled"],["superseded","Superseded"],["loss_closed","Closed as loss"],["conflict","Conflict"]].map(o=>`<option value="${o[0]}" ${rwStatus===o[0]?"selected":""}>${o[1]}</option>`).join("")}
        </select>` : ""}
      ${selected.hasGranularity? `<label>Group by</label>
        <select class="field" id="rwGranularitySel">
          <option value="day" ${rwGranularity==="day"?"selected":""}>Day</option>
          <option value="week" ${rwGranularity==="week"?"selected":""}>Week</option>
          <option value="month" ${rwGranularity==="month"?"selected":""}>Month</option>
          <option value="year" ${rwGranularity==="year"?"selected":""}>Year</option>
        </select>` : ""}
      <button class="btn btn-primary" id="rwView" style="margin-top:12px">View Report</button>
      <div id="rwResults" style="margin-top:14px"></div>
    `;
    document.getElementById("rwTypeSel").onchange=(e)=>{ rwType=e.target.value; render(); };
    document.getElementById("rwBranchSel").onchange=(e)=>{ rwBranch=e.target.value; };
    const viewSel = document.getElementById("rwViewSel");
    if(viewSel) viewSel.onchange=(e)=>{ rwView=e.target.value; render(); };
    const granSel = document.getElementById("rwGranularitySel");
    if(granSel) granSel.onchange=(e)=>{ rwGranularity=e.target.value; };
    document.getElementById("rwView").onclick=()=>runReportWriter();
  }
  // Hand-built inline SVG bar chart — no charting library. Bars are scaled
  // to the tallest bucket, capped at a sensible max width and centered so a
  // 1-2 bucket range doesn't render as one giant blob, and labels rotate +
  // abbreviate past ~10 buckets so they stay legible instead of overlapping.
  function abbreviateChartLabel(label){
    return /^\d{4}-\d{2}-\d{2}$/.test(label)? label.slice(5) : label;
  }
  function renderBarChartSvg(chartData){
    if(!chartData || chartData.length===0) return `<p class="muted">No data to chart.</p>`;
    const w=600, h=200, padBottom=46, padTop=14;
    const maxVal = Math.max(...chartData.map(d=>d.value), 0.01);
    const n = chartData.length;
    const gap = 6;
    const idealWidth = (w - gap*(n+1)) / n;
    const barWidth = Math.max(4, Math.min(idealWidth, 56));
    const totalBarsWidth = n*barWidth + (n-1)*gap;
    const startX = Math.max(gap, (w-totalBarsWidth)/2);
    const manyBars = n > 10;
    const bars = chartData.map((d,i)=>{
      const x = startX + i*(barWidth+gap);
      const barH = Math.max(1, (d.value/maxVal) * (h-padTop-padBottom));
      const y = h - padBottom - barH;
      const cx = x + barWidth/2;
      const labelY = h - padBottom + (manyBars? 10 : 16);
      const label = manyBars? abbreviateChartLabel(d.label) : d.label;
      const textAttrs = manyBars
        ? `text-anchor="end" transform="rotate(-40 ${cx.toFixed(1)} ${labelY.toFixed(1)})"`
        : `text-anchor="middle"`;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" style="fill:var(--orange)"></rect>
        <text x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" font-size="${manyBars?8.5:11}" style="fill:var(--ink-soft)" ${textAttrs}>${escapeHtml(label)}</text>`;
    }).join("");
    return `<div class="card" style="overflow-x:auto;padding:10px 6px">
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:200px;display:block" preserveAspectRatio="xMidYMid meet">${bars}</svg>
    </div>`;
  }
  function runReportWriter(){
    const configs = reportWriterConfigs();
    const selected = configs.find(c=>c.id===rwType);
    if(!selected) return;
    const b = rwBranch || null;
    let fromTs, toTs;
    if(selected.hasDate){
      rwFrom = document.getElementById("rwFrom").value;
      rwTo = document.getElementById("rwTo").value;
      fromTs = rwFrom+"T00:00:00"; toTs = rwTo+"T23:59:59";
    }
    let granularity;
    if(selected.hasGranularity){
      granularity = document.getElementById("rwGranularitySel").value;
      rwGranularity = granularity;
    }
    let status;
    const opts = {};
    if(selected.hasView) opts.view = rwView;
    const stEl = document.getElementById("rwStatusSel"); if(stEl){ status = stEl.value; rwStatus = status; }
    const rsEl = document.getElementById("rwReasonSel"); if(rsEl){ opts.reason = rsEl.value; rwReason = opts.reason; }
    const data = selected.fetch(b, fromTs, toTs, granularity, status, opts);
    window._rwLastData = { title:selected.label, subtitle:`${b||"All branches"}${selected.hasDate? ` · ${rwFrom} to ${rwTo}`:""}`, headers:data.headers, rows:data.rows, footer:data.footer };
    const target = document.getElementById("rwResults");
    target.innerHTML = `
      ${data.chartData? renderBarChartSvg(data.chartData) : ""}
      <div class="card" style="overflow-x:auto">
        ${data.rows.length===0? `<p class="muted">No data for this filter.</p>` : `
        <table class="simple">
          <tr>${data.headers.map(h=>`<th>${escapeHtml(h)}</th>`).join("")}</tr>
          ${data.rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join("")}
        </table>`}
        ${data.footer? `<p style="margin-top:8px"><b>${escapeHtml(data.footer)}</b></p>` : ""}
      </div>
      ${data.rows.length>0? `<button class="btn btn-outline" id="rwPrint" style="margin-top:10px">🖨️ Print / PDF this view</button>` : ""}
    `;
    const printBtn = document.getElementById("rwPrint");
    if(printBtn) printBtn.onclick=()=>{
      const d = window._rwLastData;
      printReport(d.title, d.subtitle, d.headers, d.rows, d.footer? `<p><b>${escapeHtml(d.footer)}</b></p>`:"");
    };
    target.querySelectorAll("[data-view-sale]").forEach(b=>{
      b.onclick=()=> openSaleDetailModal(+b.dataset.viewSale);
    });
  }

