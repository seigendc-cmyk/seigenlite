  function searchProducts(q, branch){
    branch = branch===undefined ? currentBranch() : branch;
    const all_ = branch? all("SELECT * FROM products WHERE branch=? ORDER BY name",[branch])
                        : all("SELECT * FROM products ORDER BY branch,name");
    return all_.filter(p=> matchesAnyOrder(q, p.name+" "+(p.sku||"")+" "+(p.description||"")));
  }

  function addToCart(p){
    const existing = cart.find(c=>c.product_id===p.id);
    if(existing){ if(existing.qty < p.stock) existing.qty++; }
    else { if(p.stock>0) cart.push({product_id:p.id,name:p.name,price:p.price,qty:1,stock:p.stock}); }
    render();
  }
  function changeQty(pid, delta){
    const item = cart.find(c=>c.product_id===pid);
    if(!item) return;
    if(delta>0 && item.qty>=item.stock) return;
    item.qty += delta;
    if(item.qty<=0) cart = cart.filter(c=>c.product_id!==pid);
    render();
  }
  function cartSubtotal(){ return cart.reduce((s,c)=>s+c.price*c.qty,0); }
  function currentDiscount(){
    const el = document.getElementById("discountInput");
    return el? (parseFloat(el.value)||0) : 0;
  }
  function currentMarkup(){
    const el = document.getElementById("markupInput");
    return el? (parseFloat(el.value)||0) : 0;
  }
  function currentVoucherAmount(){ return appliedVoucher? appliedVoucher.amount : 0; }
  // Single source of truth for the sale math: discount is capped at the
  // subtotal and voucher is capped at what's left after discount+markup, so
  // the amounts we store and print always add up to the printed total —
  // rather than being floored to 0 while the itemized lines above it still
  // show the uncapped amount the customer/staff typed or that a voucher
  // happened to be worth.
  function cartTotals(){
    const subtotal = cartSubtotal();
    const discount = Math.min(Math.max(0,currentDiscount()), subtotal);
    const markup = Math.max(0,currentMarkup());
    const base = (subtotal - discount) + markup;
    const voucher = Math.min(Math.max(0,currentVoucherAmount()), base);
    const total = base - voucher;
    return { subtotal, discount, markup, voucher, total };
  }
  function cartTotal(){ return cartTotals().total; }
  // Loose name match for the live voucher-eligibility preview while typing
  // in the cart's customer field — not the same lookup findOrCreateCustomer
  // uses to attach/create the sale's customer record.
  function findMatchingCustomer(name){
    name = (name||"").trim();
    if(!name) return null;
    return one("SELECT * FROM customers WHERE lower(name)=lower(?)",[name]);
  }

  // address/townCity/suburb are optional and only ever passed by
  // newCustomerModal (credit.js) — checkout (completeSale below) still
  // calls this with just name+phone, same as before, and those columns
  // are simply left at their '' default for a customer created that way.
  function findOrCreateCustomer(name, phone, address, townCity, suburb){
    name = (name||"").trim(); phone=(phone||"").trim();
    address=(address||"").trim(); townCity=(townCity||"").trim(); suburb=(suburb||"").trim();
    if(!name) return null;
    const existing = one("SELECT * FROM customers WHERE lower(name)=lower(?) AND COALESCE(phone,'')=COALESCE(?,'')",[name,phone]);
    if(existing) return existing.id;
    run("INSERT INTO customers(name,phone,branch,address,town_city,suburb) VALUES(?,?,?,?,?,?)",[name,phone,currentBranch(),address,townCity,suburb]);
    return one("SELECT last_insert_rowid() as id").id;
  }
  function customerBalance(cid){
    const owed = one("SELECT COALESCE(SUM(total),0) as t FROM sales WHERE customer_id=? AND method='Credit'",[cid]).t;
    const paid = one("SELECT COALESCE(SUM(amount),0) as t FROM credit_payments WHERE customer_id=?",[cid]).t;
    return owed - paid;
  }
  function waNumber(phone){
    let d = (phone||"").replace(/[^\d]/g,"");
    if(d.startsWith("0")) d = "263"+d.slice(1);
    return d;
  }
  function waLink(phone, text){
    const n = waNumber(phone);
    return n? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
  }

  // Frequent-customer vouchers: after a sale, check whether this customer
  // has now hit the configured purchase count within the configured window
  // at this branch, and if so, and they don't already hold an unused
  // voucher, issue one. The voucher amount comes from Settings — left at 0
  // (the shipped default) this never issues anything, by design.
  function maybeIssueFrequentCustomerVoucher(customerId, branch, ts){
    if(!customerId) return;
    const voucherAmt = parseFloat(getSetting("freq_voucher_amount","0"))||0;
    if(voucherAmt<=0) return;
    const purchasesNeeded = parseInt(getSetting("freq_purchases_needed","5"))||5;
    const withinDays = parseInt(getSetting("freq_within_days","30"))||30;
    const sinceTs = new Date(Date.now() - withinDays*86400000).toISOString();
    const recentCount = one("SELECT COUNT(*) as c FROM sales WHERE customer_id=? AND branch=? AND ts>=?",[customerId,branch,sinceTs]).c;
    if(recentCount < purchasesNeeded) return;
    const existingVoucher = one("SELECT * FROM vouchers WHERE customer_id=? AND status='Available'",[customerId]);
    if(existingVoucher) return;
    run("INSERT INTO vouchers(customer_id,amount,branch,earned_ts,status) VALUES(?,?,?,?,'Available')",[customerId,voucherAmt,branch,ts]);
  }

  function completeSale(method){
    if(cart.length===0) return;
    const nameEl = document.getElementById("custName");
    const phoneEl = document.getElementById("custPhone");
    const custName = nameEl? nameEl.value.trim() : "";
    const custPhone = phoneEl? phoneEl.value.trim() : "";
    if(method==="Credit" && !custName){ alert("Enter the customer's name for a credit sale"); return; }

    const reasonEl = document.getElementById("discountReason");
    const approvedEl = document.getElementById("discountApprovedBy");
    const discountReason = reasonEl? reasonEl.value.trim() : "";
    const discountApprovedBy = approvedEl? approvedEl.value.trim() : "";
    if(currentDiscount()>0 && !discountReason){ alert("Enter a reason for the discount"); return; }

    const markupReasonEl = document.getElementById("markupReason");
    const markupReason = markupReasonEl? markupReasonEl.value.trim() : "";

    const refEl = document.getElementById("paymentRef");
    const paymentRef = refEl? refEl.value.trim() : "";
    if((method==="EcoCash"||method==="Bank") && !paymentRef){ alert("Enter the payment reference number"); return; }

    const customerId = custName? findOrCreateCustomer(custName, custPhone) : null;
    const voucherToRedeem = appliedVoucher;
    const ts = new Date().toISOString();

    // Clamped here (rather than trusting the raw inputs) so discount/voucher
    // never exceed what the sale can actually absorb — otherwise the
    // subtotal/discount/markup/voucher lines printed on the receipt and
    // summed in EOD/Discount reports wouldn't add up to the total, which
    // was floored at 0 instead of reflecting what was really given away.
    const { subtotal, discount, markup, voucher: voucherAmount, total } = cartTotals();
    const discountStatus = discount>0? (discountApprovedBy? "Approved":"Pending") : "";
    const branch = currentBranch();
    run(`INSERT INTO sales(ts,subtotal,discount,total,method,customer_id,branch,discount_reason,discount_approved_by,discount_status,markup,markup_reason,payment_ref,user,voucher_amount)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ts,subtotal,discount,total,method,customerId,branch,discountReason,discountApprovedBy,discountStatus,markup,markupReason,paymentRef,sessionUser||"",voucherAmount]);
    const saleId = one("SELECT last_insert_rowid() as id").id;
    cart.forEach(c=>{
      const prod = one("SELECT cost FROM products WHERE id=?",[c.product_id]);
      run("INSERT INTO sale_items(sale_id,product_id,name,price,qty,cost) VALUES(?,?,?,?,?,?)",
        [saleId,c.product_id,c.name,c.price,c.qty,prod?prod.cost:0]);
      run("UPDATE products SET stock = stock - ? WHERE id=?",[c.qty,c.product_id]);
    });
    if(voucherToRedeem){
      run("UPDATE vouchers SET status='Redeemed', redeemed_ts=?, redeemed_sale_id=? WHERE id=?",[ts,saleId,voucherToRedeem.id]);
    }
    const itemNames = cart.map(c=>c.name);
    const itemsSummary = itemNames.length<=3? itemNames.join(", ") : `${itemNames[0]} +${itemNames.length-1} more`;
    logAudit("Sale", itemsSummary, `Receipt #${saleId} · ${currency}${total.toFixed(2)} · ${method}`);
    maybeIssueFrequentCustomerVoucher(customerId, branch, ts);
    persist();
    window._lastReceipt = {saleId,ts,subtotal,discount,markup,voucherAmount,total,method,items:cart.slice()};
    printReceipt(saleId, ts, subtotal, discount, markup, voucherAmount, total, method, cart.slice());
    cart = []; drawerOpen=false; appliedVoucher=null;
    render();
  }


  function renderPOS(main){
    const results = searchProducts(searchQuery);
    main.innerHTML = `
      ${window._lastReceipt? `<div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div class="muted">Receipt #${window._lastReceipt.saleId} · ${currency}${window._lastReceipt.total.toFixed(2)}</div>
        <div class="row" style="flex:none;width:auto;gap:6px">
          <button class="btn btn-sm btn-outline" id="reprintBtn">🖨️</button>
          <button class="btn btn-sm btn-ghost" id="waReceiptBtn">📲</button>
          ${hasUSBPrint()? `<button class="btn btn-sm btn-outline" id="usbReceiptBtn">🔌</button>` : ""}
          ${hasBTPrint()? `<button class="btn btn-sm btn-outline" id="btReceiptBtn">🔵</button>` : ""}
          ${window._lastReceipt.method==="Credit"? `<button class="btn btn-sm btn-outline" id="invoiceBtn">🖨️ Invoice</button>` : ""}
        </div>
      </div>` : ""}
      <div class="search-wrap">
        <span class="ic">🔎</span>
        <input class="field" id="searchInput" placeholder="Search products or SKU…" value="${escapeHtml(searchQuery)}">
      </div>
      <div class="card" style="padding:6px 10px">
        ${productListHtml(results)}
      </div>
    `;
    const input = document.getElementById("searchInput");
    input.oninput = (e)=>{ searchQuery = e.target.value; renderPOSListOnly(); };
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    wireProductAdds(main);
    const rp = document.getElementById("reprintBtn");
    const wr = document.getElementById("waReceiptBtn");
    const up = document.getElementById("usbReceiptBtn");
    const bp = document.getElementById("btReceiptBtn");
    const ivb = document.getElementById("invoiceBtn");
    if(rp) rp.onclick=()=>{ const r=window._lastReceipt; printReceipt(r.saleId,r.ts,r.subtotal,r.discount,r.markup,r.voucherAmount||0,r.total,r.method,r.items); };
    if(up) up.onclick=()=>{ const r=window._lastReceipt; usbPrintReceipt(r.saleId,r.ts,r.subtotal,r.discount,r.markup,r.voucherAmount||0,r.total,r.method,r.items); };
    if(bp) bp.onclick=()=>{ const r=window._lastReceipt; btPrintReceipt(r.saleId,r.ts,r.subtotal,r.discount,r.markup,r.voucherAmount||0,r.total,r.method,r.items); };
    if(ivb) ivb.onclick=()=>{ printCreditInvoice(window._lastReceipt.saleId); };
    if(wr) wr.onclick=()=>{
      const r = window._lastReceipt;
      const itemLines = r.items.map(i=>padLine(`${i.qty} x ${i.name}`, `${currency}${(i.price*i.qty).toFixed(2)}`));
      const totalLines = [];
      if(r.markup>0) totalLines.push(padLine("Markup", `+${currency}${r.markup.toFixed(2)}`));
      if(r.voucherAmount>0) totalLines.push(padLine("Voucher", `-${currency}${r.voucherAmount.toFixed(2)}`));
      totalLines.push(padLine("TOTAL", `${currency}${r.total.toFixed(2)}`), `Payment: ${r.method}`);
      shareWhatsApp(receiptText(`${escapeHtml(getSetting("shop_name",""))} — Receipt #${r.saleId}`, itemLines, totalLines));
    };
  }
  function productListHtml(results){
    return results.length===0? `<p class="muted" style="padding:10px 4px">No products match. Add products in the Products tab.</p>` :
      results.map(p=>`
        <div class="product-row">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
            ${p.image? `<img class="prod-thumb" src="${p.image}">` : `<div class="prod-thumb-placeholder">${ICON_STOREFRONT}</div>`}
            <div style="min-width:0">
              ${p.sku?`<div class="psku">${escapeHtml(p.sku)}</div>`:""}
              <div class="pname">${escapeHtml(p.name)}</div>
              <div class="pmeta">${currency}${p.price.toFixed(2)} · ${p.stock<=p.low_threshold?`<span class="pill low">${p.stock} left</span>`:`${p.stock} in stock`}</div>
            </div>
          </div>
          <button class="add-chip" data-add="${p.id}" ${p.stock<=0?"disabled":""}>${p.stock<=0?"Out":"Add"}</button>
        </div>`).join("");
  }
  function wireProductAdds(scope){
    scope.querySelectorAll("[data-add]").forEach(b=>{
      b.onclick=()=>{ const p = one("SELECT * FROM products WHERE id=?",[+b.dataset.add]); addToCart(p); };
    });
  }
  function renderPOSListOnly(){
    const results = searchProducts(searchQuery);
    const card = document.querySelector("#main .card");
    if(!card) return;
    card.innerHTML = productListHtml(results);
    wireProductAdds(card);
  }

