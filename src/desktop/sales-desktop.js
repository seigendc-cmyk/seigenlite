  // Desktop (Tauri build) Sales screen — replaces pos.js's renderPOS for
  // the "pos" route on desktop only. Only concatenated into dist-tauri/, so
  // renderPOSDesktop simply doesn't exist in dist/ or dist-pwa/ and
  // router.js's feature-detect falls through to the untouched mobile
  // renderPOS there. Reuses pos.js's cart/product/checkout logic (cart,
  // addToCart, changeQty, cartSubtotal, cartTotal, completeSale,
  // searchProducts) rather than reimplementing it — this file is a UI
  // layer on top of that, not a parallel data path. completeSale() reads
  // the customer-name/payment-ref fields by id ("custName"/"paymentRef"),
  // so this screen's inputs reuse those same ids instead of introducing a
  // second read path.

  let desktopCategory = "";

  // Registered once at script load (not inside renderPOSDesktop, which
  // reruns on every add-to-cart) so Ctrl+K never accumulates duplicate
  // listeners across re-renders.
  document.addEventListener("keydown", (e)=>{
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="k"){
      const el = document.getElementById("dsSearch");
      if(el){ e.preventDefault(); el.focus(); el.select(); }
    }
  });

  function desktopCategories(){
    return all(
      "SELECT DISTINCT category FROM products WHERE branch=? AND category IS NOT NULL AND category<>'' ORDER BY category",
      [currentBranch()]
    ).map(r=>r.category);
  }

  function desktopSearchResults(){
    let results = searchProducts(searchQuery);
    if(desktopCategory) results = results.filter(p=>p.category===desktopCategory);
    return results;
  }

  function desktopStockLabel(p){
    if(p.stock<=0) return `<span class="ds-stock-label out">Out of Stock</span>`;
    if(p.stock<=p.low_threshold) return `<span class="ds-stock-label low">Low Stock</span>`;
    return `<span class="ds-stock-label ok">In Stock</span>`;
  }

  function renderPOSDesktop(main){
    // Overrides the shared mobile `main{max-width:640px;margin:0 auto}`
    // rule via a higher-specificity class instead of editing that rule —
    // router.js recreates <main id="main"> from scratch on every route
    // change, so this class never leaks onto other screens.
    main.className = "desktop-main";
    main.innerHTML = `
      <div class="desktop-sales">
        <div class="ds-main">
          <div class="ds-searchbar">
            <span class="ic">🔎</span>
            <input class="ds-search-input" id="dsSearch" placeholder="Search products or SKU…" value="${escapeHtml(searchQuery)}">
            <span class="ds-kbd">Ctrl K</span>
          </div>
          <div class="ds-pills">${desktopPillsHtml()}</div>
          <div class="ds-table-wrap">
            <table class="ds-table">
              <thead><tr><th>Product</th><th>Stock</th><th>Price</th><th></th></tr></thead>
              <tbody id="dsRows">${desktopRowsHtml(desktopSearchResults())}</tbody>
            </table>
          </div>
        </div>
        <aside class="ds-cart">${desktopCartHtml()}</aside>
      </div>
    `;
    wireDesktopSales(main);
  }

  function desktopPillsHtml(){
    const categories = desktopCategories();
    return `<button class="ds-pill ${desktopCategory===""?"active":""}" data-cat="">All</button>` +
      categories.map(c=>`<button class="ds-pill ${desktopCategory===c?"active":""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("");
  }

  function desktopRowsHtml(results){
    if(results.length===0) return `<tr><td colspan="4" style="text-align:center;color:var(--ink-soft);padding:30px 10px">No products match.</td></tr>`;
    return results.map(p=>`
      <tr>
        <td>
          <div class="ds-prod">
            ${p.image? `<img class="ds-thumb" src="${p.image}">` : `<div class="ds-thumb-placeholder">${ICON_STOREFRONT}</div>`}
            <div style="min-width:0">
              <div class="ds-pname">${escapeHtml(p.name)}</div>
              <div class="ds-psub">${p.sku? escapeHtml(p.sku)+" · ":""}${escapeHtml(p.category||"Uncategorized")}</div>
            </div>
          </div>
        </td>
        <td>${p.stock} ${desktopStockLabel(p)}</td>
        <td>${currency}${p.price.toFixed(2)}</td>
        <td><button class="ds-add-btn" data-add="${p.id}" ${p.stock<=0?"disabled":""}>${p.stock<=0?"Out":"Add"}</button></td>
      </tr>`).join("");
  }

  function desktopCartHtml(){
    if(cart.length===0){
      return `
        <div class="ds-cart-head">Cart</div>
        <div class="ds-cart-empty">
          <div class="ic">🛒</div>
          <h4>No products found</h4>
          <p>Add products from the list to start a sale.</p>
        </div>`;
    }
    const subtotal = cartSubtotal();
    return `
      <div class="ds-cart-head">Cart</div>
      <div class="ds-cart-body">
        ${cart.map(c=>`
          <div class="ds-cart-item">
            <div style="flex:1;min-width:0">
              <div class="ds-ci-name">${escapeHtml(c.name)}</div>
              <div class="ds-ci-price">${currency}${c.price.toFixed(2)} each</div>
            </div>
            <div class="ds-qty-ctl">
              <button data-dec="${c.product_id}">−</button>
              <span>${c.qty}</span>
              <button data-inc="${c.product_id}">+</button>
            </div>
          </div>`).join("")}
      </div>
      <div class="ds-cart-foot">
        <label style="display:block;font-size:12px;color:var(--ink-soft);margin-bottom:4px">Customer name (required for Credit)</label>
        <input class="field" id="custName" placeholder="e.g. Tendai Moyo" value="${window._custNameVal||""}" style="margin-bottom:8px">
        <label style="display:block;font-size:12px;color:var(--ink-soft);margin-bottom:4px">Payment reference (EcoCash/Bank)</label>
        <input class="field" id="paymentRef" placeholder="Transaction reference" value="${window._paymentRefVal||""}" style="margin-bottom:10px">
        <div class="ds-subline"><span>Subtotal</span><span>${currency}${subtotal.toFixed(2)}</span></div>
        <div class="ds-totalline"><span>Total</span><span id="dsTotal">${currency}${cartTotal().toFixed(2)}</span></div>
        <div class="ds-pay-grid">
          <button class="btn btn-primary" id="dsPayCash">Cash</button>
          <button class="btn btn-ghost" id="dsPayEcocash">EcoCash</button>
          <button class="btn btn-ghost" id="dsPayBank">Bank</button>
          <button class="btn btn-outline" id="dsPayCredit">Credit</button>
        </div>
      </div>`;
  }

  function wireDesktopSales(main){
    const search = document.getElementById("dsSearch");
    search.oninput = (e)=>{ searchQuery = e.target.value; refreshDesktopRows(); };
    main.querySelectorAll("[data-cat]").forEach(b=>{
      b.onclick = ()=>{ desktopCategory = b.dataset.cat; renderPOSDesktop(main); };
    });
    wireDesktopRowActions(document.getElementById("dsRows"));
    wireDesktopCartActions(main);
  }
  function refreshDesktopRows(){
    const tbody = document.getElementById("dsRows");
    if(!tbody) return;
    tbody.innerHTML = desktopRowsHtml(desktopSearchResults());
    wireDesktopRowActions(tbody);
  }
  function wireDesktopRowActions(scope){
    scope.querySelectorAll("[data-add]").forEach(b=>{
      // addToCart() already calls the router-level render(), which redraws
      // the whole route (including this screen, since it's still "pos") —
      // that's what refreshes the cart panel after adding an item.
      b.onclick = ()=>{ const p = one("SELECT * FROM products WHERE id=?",[+b.dataset.add]); addToCart(p); };
    });
  }
  function wireDesktopCartActions(main){
    main.querySelectorAll("[data-inc]").forEach(b=>b.onclick=()=>changeQty(+b.dataset.inc,1));
    main.querySelectorAll("[data-dec]").forEach(b=>b.onclick=()=>changeQty(+b.dataset.dec,-1));
    const cn = document.getElementById("custName");
    if(cn) cn.oninput = (e)=>{ window._custNameVal = e.target.value; };
    const pr = document.getElementById("paymentRef");
    if(pr) pr.oninput = (e)=>{ window._paymentRefVal = e.target.value; };
    const resetTemp = ()=>{ window._custNameVal=""; window._paymentRefVal=""; };
    const cash = document.getElementById("dsPayCash");
    const eco = document.getElementById("dsPayEcocash");
    const bank = document.getElementById("dsPayBank");
    const credit = document.getElementById("dsPayCredit");
    if(cash) cash.onclick = ()=>{ completeSale("Cash"); resetTemp(); };
    if(eco) eco.onclick = ()=>{ completeSale("EcoCash"); resetTemp(); };
    if(bank) bank.onclick = ()=>{ completeSale("Bank"); resetTemp(); };
    if(credit) credit.onclick = ()=>{ completeSale("Credit"); resetTemp(); };
  }
