  // Reuses the exact same build-target signal router.js already relies on
  // for the Sell screen (renderPOSDesktop only exists in the dist-tauri
  // bundle — see build.js's DESKTOP_EXTRA_SCRIPTS) rather than inventing a
  // second build-target flag. Nav shell is therefore locked to which build
  // this is, never to window width.
  function isDesktopBuild(){ return typeof renderPOSDesktop==="function"; }

  // Single source of truth for the nav items — both the phone/branch
  // bottom tab bar (dist/dist-pwa) and the desktop hamburger drawer
  // (dist-tauri) render from this one list instead of each hardcoding it.
  const NAV_ITEMS = [
    { id:"pos", icon:ICON_NAV_SELL, label:"Sell" },
    { id:"products", icon:ICON_NAV_PRODUCTS, label:"Products" },
    { id:"credit", icon:ICON_NAV_CREDIT, label:"Credit" },
    { id:"reports", icon:ICON_NAV_REPORTS, label:"Reports" },
    { id:"marketing", icon:ICON_NAV_MARKETING, label:"Marketing" },
    { id:"more", icon:ICON_NAV_MORE, label:"More" },
  ];

  // ================== CLICK ROUTER ==================
  document.addEventListener("click",(e)=>{
    const btn = e.target.closest("[data-route]");
    if(btn){
      if(route==="more" && btn.dataset.route!=="more" && moreTab==="settings") settingsUnlocked=false;
      route = btn.dataset.route; drawerOpen=false; navDrawerOpen=false; render();
    }
    const kebabToggle = e.target.closest("[data-kebab-toggle]");
    if(kebabToggle){
      const menu = document.getElementById("menu-"+kebabToggle.dataset.kebabToggle);
      const wasOpen = menu && menu.style.display==="block";
      document.querySelectorAll(".kebab-menu").forEach(m=> m.style.display="none");
      if(menu) menu.style.display = wasOpen? "none":"block";
    } else if(!e.target.closest(".kebab-menu")){
      document.querySelectorAll(".kebab-menu").forEach(m=> m.style.display="none");
    }
  });

  // ================== RENDER ==================
  function render(){
    if(route==="setup") return renderSetup();
    if(route==="lock") return renderLock();
    if(route==="start") return renderStart();
    const desktop = isDesktopBuild();
    $app.innerHTML = `
      <div class="topbar">
        ${desktop? `<button class="hamburger-btn" id="hamburgerBtn" aria-label="Menu">☰</button>` : ""}
        ${bannerMarkup(34)}
        <div class="names">
          <div class="shop">${escapeHtml(getSetting("shop_name","Shop"))}</div>
          <div class="branch">${escapeHtml(getSetting("branch_name",""))} · <span id="userChip" style="text-decoration:underline;cursor:pointer">${escapeHtml(sessionUser||"set name")}</span></div>
        </div>
        <button class="logout-btn" id="logoutBtn" aria-label="Log out" title="Log out">${ICON_LOGOUT}</button>
        <button class="cart-btn" id="cartBtn">🛒${cart.length?`<span class="cart-badge">${cart.reduce((s,c)=>s+c.qty,0)}</span>`:""}</button>
      </div>
      <main id="main"></main>
      ${desktop? "" : `<div class="navbar">${NAV_ITEMS.map(n=>navBtn(n.id,n.icon,n.label)).join("")}</div>`}
      <div class="overlay ${drawerOpen?'show':''}" id="overlay"></div>
      <div class="drawer ${drawerOpen?'show':''}" id="drawer"></div>
      <div class="overlay ${reqDrawerOpen?'show':''}" id="reqOverlay"></div>
      <div class="drawer ${reqDrawerOpen?'show':''}" id="reqDrawer"></div>
      ${desktop? `
      <div class="overlay ${navDrawerOpen?'show':''}" id="navOverlay"></div>
      <div class="drawer nav-drawer ${navDrawerOpen?'show':''}" id="navDrawer">
        <div class="drawer-head"><h3 style="margin:0">Menu</h3><button class="close-x" id="closeNavDrawer">✕</button></div>
        <div class="drawer-body">
          ${NAV_ITEMS.map(n=>`<button class="nav-drawer-item ${route===n.id?'active':''}" data-route="${n.id}"><span class="ic">${n.icon}</span>${escapeHtml(n.label)}</button>`).join("")}
        </div>
      </div>` : ""}
    `;
    document.getElementById("cartBtn").onclick = ()=>{
      const dcReason = dcLockCartReason();
      if(dcReason){ alert(dcReason); return; }
      drawerOpen=true; render();
    };
    document.getElementById("overlay").onclick = ()=>{ drawerOpen=false; render(); };
    document.getElementById("reqOverlay").onclick = ()=>{ reqDrawerOpen=false; render(); };
    document.getElementById("userChip").onclick = changeSessionUser;
    document.getElementById("logoutBtn").onclick = logoutSession;
    if(desktop){
      document.getElementById("hamburgerBtn").onclick = ()=>{ navDrawerOpen=true; render(); };
      document.getElementById("navOverlay").onclick = ()=>{ navDrawerOpen=false; render(); };
      document.getElementById("closeNavDrawer").onclick = ()=>{ navDrawerOpen=false; render(); };
      // Nav items carry [data-route] already, so the document-level click
      // router above handles navigation AND clears navDrawerOpen — this
      // only needs the drawer's own open/close chrome.
    }
    renderDrawer();
    renderRequestsDrawer();
    const main = document.getElementById("main");
    if(route==="pos"){ if(typeof renderPOSDesktop==="function") renderPOSDesktop(main); else renderPOS(main); }
    else if(route==="products") renderProducts(main);
    else if(route==="credit") renderCredit(main);
    else if(route==="reports") renderReports(main);
    else if(route==="marketing") renderMarketing(main);
    else if(route==="more") renderMore(main);
  }
  function navBtn(r,ic,label){
    return `<button class="${route===r?'active':''}" data-route="${r}"><span class="ic">${ic}</span>${label}</button>`;
  }
  function bannerMarkup(size){
    const img = getSetting("banner_image","");
    if(img) return `<img class="brand-mark" style="width:${size}px;height:${size}px" src="${img}">`;
    const initial = (getSetting("shop_name","S")||"S").charAt(0).toUpperCase();
    return `<div class="brand-mark placeholder" style="width:${size}px;height:${size}px">${initial}</div>`;
  }

  function renderDrawer(){
    const drawer = document.getElementById("drawer");
    if(!drawer) return;
    // Digital Commerce device check-in: a locked cart is replaced with a
    // plain notice — checked here too (not just cartBtn's click handler
    // above) so a lock that lands while the drawer is already open still
    // takes effect on its very next re-render (e.g. a qty +/- tap), rather
    // than leaving an already-open drawer's Pay buttons usable until the
    // shop happens to close and reopen it.
    const dcReason = dcLockCartReason();
    if(dcReason){
      drawer.innerHTML = `
        <div class="drawer-head"><h3 style="margin:0">Cart</h3><button class="close-x" id="closeDrawer">✕</button></div>
        <div class="drawer-body">
          <div class="card" style="border-color:var(--danger,#c0392b)">
            <p style="margin:0 0 4px;font-weight:700">🔒 Cart locked</p>
            <p class="muted" style="margin:0">${escapeHtml(dcReason)}</p>
          </div>
        </div>`;
      document.getElementById("closeDrawer").onclick=()=>{drawerOpen=false;render();};
      return;
    }
    const subtotal = cartSubtotal();
    drawer.innerHTML = `
      <div class="drawer-head"><h3 style="margin:0">Cart</h3><button class="close-x" id="closeDrawer">✕</button></div>
      <div class="drawer-body">
        ${cart.length===0? `<p class="muted">Cart is empty</p>` :
          cart.map(c=>`
            <div class="cart-item">
              <div style="flex:1">
                <div class="ci-name">${escapeHtml(c.name)}</div>
                <div class="ci-price">${currency}${c.price.toFixed(2)} each</div>
                <div class="row" style="margin-top:6px;align-items:center;gap:6px">
                  <label class="muted" style="flex:none;font-size:12px">Discount ${currency}</label>
                  <input class="field" style="flex:0.7" type="number" step="0.01" min="0" placeholder="0.00" data-line-discount="${c.product_id}" value="${escapeHtml(String(c.discount||''))}">
                </div>
              </div>
              <div class="qty-ctl">
                <button data-dec="${c.product_id}">−</button>
                <span>${c.qty}</span>
                <button data-inc="${c.product_id}">+</button>
              </div>
            </div>`).join("")}
      </div>
      <div class="drawer-foot">
        <div id="discountExtra" style="display:${cartDiscountTotal()>0?'block':'none'}">
          <label style="margin-top:0">Reason for discount</label>
          <input class="field" id="discountReason" placeholder="e.g. Bulk purchase" value="${window._discountReasonVal||''}">
          <label>Approved by (leave blank if pending)</label>
          <input class="field" id="discountApprovedBy" placeholder="Approver's name" value="${window._discountApprovedVal||''}">
        </div>
        <label>Payment reference (EcoCash/Bank)</label>
        <input class="field" id="paymentRef" placeholder="Transaction reference" value="${window._paymentRefVal||''}">
        <label>Document Reference No. (optional)</label>
        <input class="field" id="docRef" maxlength="40" placeholder="e.g. PO, delivery note or invoice no." value="${escapeHtml(window._docRefVal||'')}">
        <label>Customer name (optional, required for Credit)</label>
        <input class="field" id="custName" placeholder="e.g. Tendai Moyo" value="${window._custNameVal||''}">
        <label>Customer phone (optional)</label>
        <input class="field" id="custPhone" placeholder="e.g. 077xxxxxxx" value="${window._custPhoneVal||''}">
        <div id="voucherBox"></div>
        <div class="hr" style="margin:10px 0"></div>
        <div class="subline"><span>Subtotal</span><span>${currency}${subtotal.toFixed(2)}</span></div>
        <div class="total-line"><span>Total</span><span id="drawerTotal">${currency}${cartTotal().toFixed(2)}</span></div>
        ${fxPreviewHtml()}
        ${splitTender? splitTenderPanelHtml() : `
        ${quickTapCurrencySelectorHtml()}
        <div class="row" style="margin-bottom:8px">
          <button class="btn btn-primary" id="payCash" ${cart.length===0?"disabled":""}>Cash</button>
          <button class="btn btn-ghost" id="payEcocash" ${cart.length===0?"disabled":""}>EcoCash</button>
        </div>
        <div class="row" style="margin-bottom:8px">
          <button class="btn btn-ghost" id="payBank" ${cart.length===0?"disabled":""}>Bank</button>
          <button class="btn btn-outline" id="payCredit" ${cart.length===0?"disabled":""}>Credit</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="startSplitTender" ${cart.length===0?"disabled":""}>+ Split into multiple payment methods</button>
        `}
      </div>`;
    document.getElementById("closeDrawer").onclick=()=>{drawerOpen=false;render();};
    drawer.querySelectorAll("[data-inc]").forEach(b=>b.onclick=()=>changeQty(+b.dataset.inc,1));
    drawer.querySelectorAll("[data-dec]").forEach(b=>b.onclick=()=>changeQty(+b.dataset.dec,-1));
    wireLineDiscountInputs(drawer);
    document.getElementById("discountReason").oninput=(e)=>{ window._discountReasonVal=e.target.value; };
    document.getElementById("discountApprovedBy").oninput=(e)=>{ window._discountApprovedVal=e.target.value; };
    document.getElementById("paymentRef").oninput=(e)=>{ window._paymentRefVal=e.target.value; };
    document.getElementById("docRef").oninput=(e)=>{ window._docRefVal=e.target.value; };
    document.getElementById("custName").oninput=(e)=>{ window._custNameVal=e.target.value; renderVoucherBox(); };
    document.getElementById("custPhone").oninput=(e)=>{ window._custPhoneVal=e.target.value; };
    renderVoucherBox();
    wireFxPreview(drawer, renderDrawer);
    const resetTemp=()=>{ window._custNameVal=""; window._custPhoneVal="";
      window._discountReasonVal=""; window._discountApprovedVal=""; window._paymentRefVal=""; window._docRefVal=""; };
    if(splitTender){
      wireSplitTenderPanel(drawer, renderDrawer, (payments)=>{ completeSale(null, payments); resetTemp(); });
    } else {
      wireQuickTapCurrencySelector(drawer, renderDrawer);
      const startSplit = document.getElementById("startSplitTender");
      if(startSplit) startSplit.onclick=()=>{ startSplitTender(); renderDrawer(); };
      const payCash = document.getElementById("payCash");
      const payEco = document.getElementById("payEcocash");
      const payBank = document.getElementById("payBank");
      const payCredit = document.getElementById("payCredit");
      if(payCash) payCash.onclick=()=>{ completeSale("Cash", quickTapPayments("Cash")); resetTemp(); };
      if(payEco) payEco.onclick=()=>{ completeSale("EcoCash", quickTapPayments("EcoCash")); resetTemp(); };
      if(payBank) payBank.onclick=()=>{ completeSale("Bank", quickTapPayments("Bank")); resetTemp(); };
      if(payCredit) payCredit.onclick=()=>{ completeSale("Credit", quickTapPayments("Credit")); resetTemp(); };
    }
  }
  // Shows a "voucher available" badge + Apply button once the typed
  // customer name matches an existing customer with an Available voucher;
  // switches to a "voucher applied" pill (with a way to remove it) once
  // applied. Auto-clears if the name is edited to no longer match the
  // customer the voucher was applied for.
  function renderVoucherBox(){
    const box = document.getElementById("voucherBox");
    if(!box) return;
    const nameEl = document.getElementById("custName");
    const name = nameEl? nameEl.value.trim() : "";
    const cust = findMatchingCustomer(name);
    const totalEl = document.getElementById("drawerTotal");
    if(appliedVoucher && (!cust || cust.id!==appliedVoucher.customerId)){
      appliedVoucher = null;
      if(totalEl) totalEl.textContent = currency+cartTotal().toFixed(2);
    }
    if(!cust){ box.innerHTML=""; return; }
    if(appliedVoucher && appliedVoucher.customerId===cust.id){
      box.innerHTML = `<div class="pill ok" style="display:inline-flex;align-items:center;gap:6px;margin:6px 0">Voucher applied: -${currency}${appliedVoucher.amount.toFixed(2)} <button type="button" data-remove-voucher style="background:none;border:none;color:inherit;font-weight:700;padding:0 2px;cursor:pointer">✕</button></div>`;
      box.querySelector("[data-remove-voucher]").onclick=()=>{
        appliedVoucher = null;
        if(totalEl) totalEl.textContent = currency+cartTotal().toFixed(2);
        renderVoucherBox();
      };
      return;
    }
    const voucher = one("SELECT * FROM vouchers WHERE customer_id=? AND status='Available'",[cust.id]);
    if(!voucher){ box.innerHTML=""; return; }
    box.innerHTML = `<div class="card" style="padding:8px 10px;margin:6px 0;display:flex;justify-content:space-between;align-items:center">
      <span>🎁 Voucher available: ${currency}${voucher.amount.toFixed(2)}</span>
      <button type="button" class="btn btn-sm btn-primary" data-apply-voucher style="flex:none">Apply Voucher</button>
    </div>`;
    box.querySelector("[data-apply-voucher]").onclick=()=>{
      appliedVoucher = { id:voucher.id, amount:voucher.amount, customerId:cust.id };
      if(totalEl) totalEl.textContent = currency+cartTotal().toFixed(2);
      renderVoucherBox();
    };
  }


  // Single list of More-page tabs, filtered for Remote branches — used to
  // drive the dropdown so there's one place that defines what's in it.
  const MORE_TABS = [
    { id:"help", label:"Help" },
    { id:"about", label:"About" },
    { id:"directory", label:"Directory" },
    { id:"productlist", label:"Product List" },
    { id:"stocktake", label:"Stocktake", remoteHidden:true },
    { id:"requests", label:"Requests" },
    { id:"purchasing", label:"Purchasing", remoteHidden:true },
    { id:"reportwriter", label:"Report Writer", remoteHidden:true },
    { id:"settings", label:"Settings" },
  ];
  function moreTabsAvailable(){ return MORE_TABS.filter(t=> !(t.remoteHidden && isRemote())); }
  function renderMore(main){
    const tabs = moreTabsAvailable();
    const active = tabs.find(t=>t.id===moreTab) || tabs[0];
    main.innerHTML = `
      <h2>More</h2>
      <div class="moretab-wrap">
        <button class="moretab-btn" data-kebab-toggle="moretab">
          <span>${escapeHtml(active.label)}</span><span class="chev">▾</span>
        </button>
        <div class="kebab-menu moretab-menu" id="menu-moretab">
          ${tabs.map(t=>`<button data-tab="${t.id}" class="${t.id===moreTab?'active':''}">${escapeHtml(t.label)}</button>`).join("")}
        </div>
      </div>
      <div id="moreBody"></div>
    `;
    main.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{
      if(b.dataset.tab==="settings" && moreTab!=="settings") settingsUnlocked=false;
      moreTab=b.dataset.tab;
      document.getElementById("menu-moretab").style.display="none";
      render();
    });
    const body = document.getElementById("moreBody");
    if(moreTab==="help") renderHelp(body);
    else if(moreTab==="about") renderAbout(body);
    else if(moreTab==="directory") renderDirectory(body);
    else if(moreTab==="productlist") renderProductList(body);
    else if(moreTab==="stocktake"){ if(isRemote()){ moreTab="help"; renderHelp(body); } else renderStocktake(body); }
    else if(moreTab==="requests") renderStockRequests(body);
    else if(moreTab==="purchasing"){ if(isRemote()){ moreTab="help"; renderHelp(body); } else renderPurchasing(body); }
    else if(moreTab==="reportwriter"){ if(isRemote()){ moreTab="help"; renderHelp(body); } else renderReportWriter(body); }
    else if(moreTab==="settings") renderSettings(body);
  }

