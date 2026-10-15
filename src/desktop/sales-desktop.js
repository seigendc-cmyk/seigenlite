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

  // Registered once at script load (not inside renderPOSDesktop, which
  // reruns on every add-to-cart) so Ctrl+K never accumulates duplicate
  // listeners across re-renders.
  document.addEventListener("keydown", (e)=>{
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="k"){
      const el = document.getElementById("dsSearch");
      if(el){ e.preventDefault(); el.focus(); el.select(); }
    }
  });

  // No category pills (owner, 2026-10-14): the search box is the filter, and
  // it matches the category too (utils.js productMatches).
  function desktopSearchResults(){
    return searchProducts(searchQuery);
  }

  function desktopStockLabel(p){
    if(p.stock<0) return `<span class="ds-stock-label out">Below zero</span>`;
    if(p.stock<=0) return `<span class="ds-stock-label out">Out of Stock</span>`;
    if(p.stock<=p.low_threshold) return `<span class="ds-stock-label low">Low Stock</span>`;
    return `<span class="ds-stock-label ok">In Stock</span>`;
  }

  function renderPOSDesktop(main){
    // The shared `main{}` rule (styles.css) is fluid-width on every build
    // now (Desktop Nav task), so .desktop-main's own max-width/margin are
    // redundant here — its one remaining job is padding:0, since ds-main/
    // ds-cart below handle their own inner padding. Kept as a class (not
    // an inline style) so it stays a single, findable override rather than
    // duplicated per element; router.js recreates <main id="main"> from
    // scratch on every route change, so this class never leaks onto other
    // screens.
    main.className = "desktop-main";
    main.innerHTML = `
      ${shiftBlockBannerHtml()}
      ${typeof tillStockNoteHtml==="function" && tillStockPending()? `<div style="padding:12px 24px 0">${tillStockNoteHtml()}</div>` : ""}
      ${typeof sharedStockOfflineBadgeHtml==="function" && sharedStockOfflineBadgeHtml()? `<div style="padding:12px 24px 0">${sharedStockOfflineBadgeHtml()}</div>` : ""}
      ${dcMessagesBannerHtml()}
      ${typeof itredBannerHtml==="function" && itredBannerHtml()? `<div style="padding:12px 24px 0">${itredBannerHtml()}</div>` : ""}
      <div class="desktop-sales">
        <div class="ds-main">
          <div class="ds-searchbar">
            <span class="ic">🔎</span>
            <input class="ds-search-input" id="dsSearch" placeholder="Search products or SKU…" value="${escapeHtml(searchQuery)}">
            <span class="ds-kbd">Ctrl K</span>
          </div>
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

  function desktopRowsHtml(results){
    if(results.length===0) return `<tr><td colspan="4" style="text-align:center;color:var(--ink-soft);padding:30px 10px">No products match.</td></tr>`;
    return results.map(p=>`
      <tr>
        <td>
          <div class="ds-prod">
            ${typeof catPicHtml==="function"? catPicHtml(p, 'class="ds-thumb"', `<div class="ds-thumb-placeholder">${ICON_STOREFRONT}</div>`)
              : (p.image? `<img class="ds-thumb" src="${p.image}">` : `<div class="ds-thumb-placeholder">${ICON_STOREFRONT}</div>`)}
            <div style="min-width:0" data-bsline="${p.id}">
              <div class="ds-pname">${escapeHtml(p.name)}</div>
              <div class="ds-psub">${p.sku? escapeHtml(p.sku)+" · ":""}${escapeHtml(p.category||"Uncategorized")}</div>
              ${typeof bsSellLineHtml==="function"? bsSellLineHtml(p) : ""}
            </div>
          </div>
        </td>
        <td>${(typeof stockLineText==="function" && stockLineText(p))? `<span class="ss-stock">${escapeHtml(stockLineText(p))}</span>` : p.stock+" "+desktopStockLabel(p)}</td>
        <td>${currency}${p.price.toFixed(2)}</td>
        <td><button class="ds-add-btn" data-add="${p.id}" ${sellable(p)<=0?"disabled":""}>${sellable(p)<=0?"Out":"Add"}</button></td>
      </tr>`).join("");
  }

  function desktopCartHtml(){
    // Digital Commerce device check-in: mirrors router.js's renderDrawer()
    // treatment exactly — a locked cart replaces the whole interactive body
    // (items, discount inputs, payment buttons) with a plain notice, so a
    // lock that lands mid-session takes effect on the panel's very next
    // re-render (any add/qty change re-renders this whole screen — see
    // renderPOSDesktop), not just on a fresh screen load.
    // Trial rules: before the free trial or a licence there is no selling.
    if(pretrialNow()){
      return `
        <div class="ds-cart-head">Cart</div>
        <div class="ds-cart-empty" style="text-align:left">${pretrialNoticeHtml()}</div>`;
    }
    const dcReason = dcLockCartReason();
    if(dcReason){
      return `
        <div class="ds-cart-head">Cart</div>
        <div class="ds-cart-empty">
          <div class="ic">🔒</div>
          <h4>Cart locked</h4>
          <p>${escapeHtml(dcReason)}</p>
        </div>`;
    }
    if(cart.length===0){
      return `
        <div class="ds-cart-head">Cart</div>
        <div class="ds-cart-empty">
          <div class="ic">🛒</div>
          <h4>No products found</h4>
          <p>Add products from the list to start a sale.</p>
        </div>${typeof exchangeCartHtml==="function"? `<div style="padding:0 12px">${exchangeCartHtml()}</div>` : ""}
        ${window._lastCreditNote && typeof openCreditNoteModal==="function"? `<div style="padding:0 12px"><div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div class="muted">Credit note ${escapeHtml(window._lastCreditNote.text)} (exchange)</div>
          <button class="btn btn-sm btn-outline" id="lastCnBtn" style="flex:none;width:auto">🖨️ Slip</button></div></div>` : ""}`;
    }
    const subtotal = cartSubtotal();
    const exchangeOn = typeof exchangePending==="function" && !!exchangePending();   // Phase 3c
    return `
      <div class="ds-cart-head">Cart</div>
      <div class="ds-cart-body" id="dsCartBody">
        ${cart.map(c=>`
          <div class="ds-cart-item">
            <div style="flex:1;min-width:0">
              <div class="ds-ci-name">${escapeHtml(c.name)}</div>
              <div class="ds-ci-price">${currency}${c.price.toFixed(2)} each${c.level==="wholesale"? ` <span class="pill warn">Wholesale</span>` : ""}</div>
              <div class="row" style="margin-top:4px;align-items:center;gap:6px">
                <label class="muted" style="flex:none;font-size:11px">Discount ${currency}</label>
                <input class="field" style="flex:0.7;padding:6px 8px" type="number" step="0.01" min="0" placeholder="0.00" data-line-discount="${c.product_id}" value="${escapeHtml(String(c.discount||''))}">
              </div>
            </div>
            <div class="ds-qty-ctl">
              <button data-dec="${c.product_id}" aria-label="One less">−</button>
              <span>${c.qty}</span>
              <button data-inc="${c.product_id}" aria-label="One more">+</button>
            </div>
          </div>`).join("")}
        ${saleDetailsHtml()}
        ${typeof exchangeCartHtml==="function"? exchangeCartHtml() : ""}
        ${splitTender && !(exchangeOn && cart.length && cartTotal()<=0)? splitTenderPanelHtml("lines") : ""}
      </div>
      <div class="ds-cart-foot pay-bar">
        ${customerComboHtml()}
        <div id="voucherBox"></div>
        <div class="ds-subline"><span>Subtotal</span><span>${currency}${subtotal.toFixed(2)}</span></div>
        <div class="ds-totalline"><span>${exchangeOn? "To pay" : "Total"}${cartPriceLevel()==="wholesale"? ` <span class="pill warn">Wholesale prices</span>` : ""}</span><span id="dsTotal">${currency}${cartTotal().toFixed(2)}</span></div>
        ${fxPreviewHtml()}
        ${exchangeOn && cart.length && cartTotal()<=0? `<button class="btn btn-primary" id="payExchange" style="width:100%">Complete exchange</button>` : splitTender? splitTenderPanelHtml("actions") : `
        ${quickTapCurrencySelectorHtml()}
        <div class="ds-pay-grid">
          <button class="btn btn-primary" id="dsPayCash">Cash</button>
          <button class="btn btn-ghost" id="dsPayEcocash">EcoCash</button>
          <button class="btn btn-ghost" id="dsPayBank">Bank</button>
          <button class="btn btn-outline" id="dsPayCredit">Credit</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="dsStartSplitTender" style="margin-top:8px;width:100%">+ Split into multiple payment methods</button>
        `}
      </div>`;
  }

  function wireDesktopSales(main){
    wireShiftBlockBanner();
    wireDcMessagesBanner();
    if(typeof wireItredBanner==="function") wireItredBanner();
    const search = document.getElementById("dsSearch");
    search.oninput = (e)=>{ searchQuery = e.target.value; window._dsListScroll = 0; const l = main.querySelector(".ds-main"); if(l) l.scrollTop = 0; refreshDesktopRows(); };
    wireDesktopRowActions(document.getElementById("dsRows"));
    wireDesktopCartActions(main);
    keepDesktopScroll(main);
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
    if(typeof wireBsSellLines==="function") wireBsSellLines(scope, refreshDesktopRows);   // Branches addendum: other branches' stock on a tap
  }
  function wireDesktopCartActions(main){
    // Digital Commerce device check-in: none of the elements this function
    // wires below exist while locked (desktopCartHtml() replaced them with
    // a plain notice) — skip entirely rather than wiring against nulls.
    if(pretrialNow()){ wirePretrialNotice(main.querySelector(".ds-cart") || main); return; }
    if(dcLockCartReason()) return;
    main.querySelectorAll("[data-inc]").forEach(b=>b.onclick=()=>changeQty(+b.dataset.inc,1));
    main.querySelectorAll("[data-dec]").forEach(b=>b.onclick=()=>changeQty(+b.dataset.dec,-1));
    const cartAside = main.querySelector(".ds-cart");
    wireLineDiscountInputs(cartAside);
    // POS fixes: the same Sale details, customer combo and pay buttons as the phone cart
    wireSaleDetails(cartAside);
    wireCustomerCombo(cartAside, ()=>renderPOSDesktop(main));
    // Phase 3c: vouchers (store credit from a return) and the exchange credit, as in the phone cart
    renderVoucherBox();
    if(typeof wireExchangeCart==="function") wireExchangeCart(cartAside, ()=>renderPOSDesktop(main));
    const lastCn = document.getElementById("lastCnBtn");
    if(lastCn) lastCn.onclick = ()=>openCreditNoteModal(window._lastCreditNote.id);
    wireFxPreview(cartAside, ()=>renderPOSDesktop(main));
    if(splitTender){
      wireSplitTenderPanel(cartAside, ()=>renderPOSDesktop(main), (payments)=>{ completeSale(null, payments); resetCheckoutFields(); });
    } else {
      wireQuickTapCurrencySelector(cartAside, ()=>renderPOSDesktop(main));
      const startSplit = document.getElementById("dsStartSplitTender");
      if(startSplit) startSplit.onclick = ()=>{ startSplitTender(); renderPOSDesktop(main); };
      wirePayButtons(cartAside, { cash:"#dsPayCash", eco:"#dsPayEcocash", bank:"#dsPayBank", credit:"#dsPayCredit" }, ()=>renderPOSDesktop(main));
    }
  }
  // The product list and the cart each scroll on their own; a re-render (any
  // add, qty or customer change rebuilds this screen) keeps both where they were.
  function keepDesktopScroll(main){
    const list = main.querySelector(".ds-main"), body = main.querySelector("#dsCartBody");
    if(list){ list.scrollTop = window._dsListScroll||0; list.onscroll = ()=>{ window._dsListScroll = list.scrollTop; }; }
    if(body){ body.scrollTop = window._dsCartScroll||0; body.onscroll = ()=>{ window._dsCartScroll = body.scrollTop; }; }
  }
