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
  // POS fixes: an open menu never drifts over the header or away from its
  // button: any scroll (the page or a panel; not the menu's own list) closes it.
  window.addEventListener("scroll", (e)=>{
    const t = e.target;
    if(t && t.closest && (t.closest(".popmenu") || t.closest(".kebab-menu"))) return;
    document.querySelectorAll(".kebab-menu").forEach(m=>{ if(m.style.display==="block") m.style.display = "none"; });
    document.querySelectorAll(".popmenu").forEach(m=> m.remove());
  }, true);

  // ================== RENDER ==================
  function render(){
    if(route==="setup") return renderSetup();
    // Activation (activation.js): a locked device only ever shows the lock
    // screen or read-only Reports, whatever route a button asks for.
    if(typeof licenceLocked==="function" && licenceLocked() && route!=="lockreports") route = "lock";
    if(route==="lock") return renderLock();
    if(route==="lockreports") return renderLockReports();
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
      if(pretrialNow()){ openTrialModal(); return; }
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
    measureHeader();
    // the cart drawer is open: the page under it must not scroll (desktop has no drawer cart)
    if(document.documentElement && document.documentElement.classList) document.documentElement.classList.toggle("noscroll", !!drawerOpen && !desktop);
    renderDrawer();
    renderRequestsDrawer();
    const main = document.getElementById("main");
    // Trial rules (pretrial): Reports (and End of Day in it) and Marketing
    // (market publishing) wait for the trial; elsewhere a notice says so.
    if(pretrialNow() && (route==="reports" || route==="marketing")){
      main.innerHTML = `<h2>${route==="reports"? "Reports" : "Marketing"}</h2>${pretrialNoticeHtml()}`;
      wirePretrialNotice(main);
      return;
    }
    if(route==="pos"){ if(typeof renderPOSDesktop==="function") renderPOSDesktop(main); else renderPOS(main); }
    else if(route==="products") renderProducts(main);
    else if(route==="credit") renderCredit(main);
    else if(route==="reports") renderReports(main);
    else if(route==="marketing") renderMarketing(main);
    else if(route==="more") renderMore(main);
    if(pretrialNow() && !(route==="pos" && desktop)){
      main.insertAdjacentHTML("afterbegin", pretrialNoticeHtml());
      wirePretrialNotice(main);
    }
  }
  // Trial rules: set up, no trial or licence yet (activation.js). Builds and
  // tests without activation.js never are.
  function pretrialNow(){ return typeof licencePretrial==="function" && licencePretrial(); }
  // POS fixes: menus, toasts and the desktop work area are placed against the
  // header's real height (it wraps on narrow screens), kept in --header-h.
  function measureHeader(){
    const tb = document.querySelector(".topbar");
    if(tb && tb.offsetHeight && document.documentElement.style) document.documentElement.style.setProperty("--header-h", tb.offsetHeight+"px");
  }
  if(typeof window!=="undefined" && window.addEventListener) window.addEventListener("resize", ()=>{ try{ measureHeader(); }catch(e){} });
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
    // Trial rules: before the free trial or a licence there is no selling.
    if(pretrialNow()){
      drawer.innerHTML = `
        <div class="drawer-head"><h3 style="margin:0">Cart</h3><button class="close-x" id="closeDrawer">✕</button></div>
        <div class="drawer-body">${pretrialNoticeHtml()}</div>`;
      document.getElementById("closeDrawer").onclick=()=>{drawerOpen=false;render();};
      wirePretrialNotice(drawer);
      return;
    }
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
    const exchangeCovers = typeof exchangePending==="function" && !!exchangePending();   // Phase 3c: an exchange credit is in the cart
    const scroller = drawer.querySelector(".drawer-body");
    const keepScroll = scroller? scroller.scrollTop : 0;
    // POS fixes (pinned Pay bar): head | ONE scrolling middle (lines, then
    // the folding "Sale details", exchange, split lines) | the Pay bar,
    // always visible (customer, totals, pay buttons).
    drawer.innerHTML = `
      <div class="drawer-head"><h3 style="margin:0">Cart${cart.length? ` <span class="muted" style="font-size:13px;font-weight:600">· ${cart.reduce((s,c)=>s+c.qty,0)} item${cart.reduce((s,c)=>s+c.qty,0)===1?"":"s"}</span>` : ""}</h3><button class="close-x" id="closeDrawer" aria-label="Close cart">✕</button></div>
      <div class="drawer-body">
        ${cart.length===0? `<p class="muted">Cart is empty</p>` :
          cart.map(c=>`
            <div class="cart-item">
              <div style="flex:1;min-width:0">
                <div class="ci-name">${escapeHtml(c.name)}</div>
                <div class="ci-price">${currency}${c.price.toFixed(2)} each${c.level==="wholesale"? ` <span class="pill warn">Wholesale</span>` : ""}</div>
                <div class="row" style="margin-top:6px;align-items:center;gap:6px">
                  <label class="muted" style="flex:none;font-size:12px">Discount ${currency}</label>
                  <input class="field" style="flex:0.7" type="number" step="0.01" min="0" placeholder="0.00" data-line-discount="${c.product_id}" value="${escapeHtml(String(c.discount||''))}">
                </div>
              </div>
              <div class="qty-ctl">
                <button data-dec="${c.product_id}" aria-label="One less">−</button>
                <span>${c.qty}</span>
                <button data-inc="${c.product_id}" aria-label="One more">+</button>
              </div>
            </div>`).join("")}
        ${saleDetailsHtml()}
        ${typeof exchangeCartHtml==="function"? exchangeCartHtml() : ""}
        ${splitTender && !(exchangeCovers && cart.length && cartTotal()<=0)? splitTenderPanelHtml("lines") : ""}
      </div>
      <div class="drawer-foot pay-bar">
        ${customerComboHtml()}
        <div id="voucherBox"></div>
        <div class="subline"><span>Subtotal</span><span>${currency}${subtotal.toFixed(2)}</span></div>
        <div class="total-line"><span>${exchangeCovers? "To pay" : "Total"}${cartPriceLevel()==="wholesale"? ` <span class="pill warn">Wholesale prices</span>` : ""}</span><span id="drawerTotal">${currency}${cartTotal().toFixed(2)}</span></div>
        ${fxPreviewHtml()}
        ${exchangeCovers && cart.length && cartTotal()<=0? `<button class="btn btn-primary" id="payExchange">Complete exchange</button>` : splitTender? splitTenderPanelHtml("actions") : `
        ${quickTapCurrencySelectorHtml()}
        <div class="pay-grid">
          <button class="btn btn-primary" id="payCash" ${cart.length===0?"disabled":""}>Cash</button>
          <button class="btn btn-ghost" id="payEcocash" ${cart.length===0?"disabled":""}>EcoCash</button>
          <button class="btn btn-ghost" id="payBank" ${cart.length===0?"disabled":""}>Bank</button>
          <button class="btn btn-outline" id="payCredit" ${cart.length===0?"disabled":""}>Credit</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="startSplitTender" ${cart.length===0?"disabled":""}>+ Split into multiple payment methods</button>
        `}
      </div>`;
    const body = drawer.querySelector(".drawer-body");
    if(body) body.scrollTop = keepScroll;
    document.getElementById("closeDrawer").onclick=()=>{drawerOpen=false;render();};
    drawer.querySelectorAll("[data-inc]").forEach(b=>b.onclick=()=>changeQty(+b.dataset.inc,1));
    drawer.querySelectorAll("[data-dec]").forEach(b=>b.onclick=()=>changeQty(+b.dataset.dec,-1));
    wireLineDiscountInputs(drawer);
    wireSaleDetails(drawer);
    wireCustomerCombo(drawer, renderDrawer);
    renderVoucherBox();
    if(typeof wireExchangeCart==="function") wireExchangeCart(drawer, renderDrawer);
    wireFxPreview(drawer, renderDrawer);
    if(splitTender){
      wireSplitTenderPanel(drawer, renderDrawer, (payments)=>{ completeSale(null, payments); resetCheckoutFields(); });
    } else {
      wireQuickTapCurrencySelector(drawer, renderDrawer);
      const startSplit = document.getElementById("startSplitTender");
      if(startSplit) startSplit.onclick=()=>{ startSplitTender(); renderDrawer(); };
      wirePayButtons(drawer, { cash:"#payCash", eco:"#payEcocash", bank:"#payBank", credit:"#payCredit" }, renderDrawer);
    }
  }
  // ---- shared by the phone drawer and the desktop cart (POS fixes) ----
  function resetCheckoutFields(){
    window._custNameVal=""; window._custPhoneVal=""; window._custNotice="";
    window._discountReasonVal=""; window._discountApprovedVal=""; window._paymentRefVal=""; window._docRefVal="";
    window._saleDetailsOpen=false;
  }
  // "Sale details": discount reason/approver, payment reference, document
  // reference. Folded unless something in it is needed or already filled.
  function saleDetailsOpen(){
    return !!(window._saleDetailsOpen || cartDiscountTotal()>0 || window._paymentRefVal || window._docRefVal);
  }
  function saleDetailsHtml(){
    if(!cart.length) return "";
    const open = saleDetailsOpen();
    return `<div class="sale-details">
      <button type="button" class="sale-details-toggle" id="saleDetailsToggle" aria-expanded="${open}" aria-controls="saleDetailsBody">
        <span>Sale details</span><span class="muted" style="font-weight:500">discount reason, payment and document reference</span><span class="chev">${open? "▴" : "▾"}</span></button>
      <div id="saleDetailsBody" ${open? "" : "hidden"}>
        <div id="discountExtra" style="display:${cartDiscountTotal()>0?'block':'none'}">
          <label style="margin-top:0" for="discountReason">Reason for discount</label>
          <input class="field" id="discountReason" placeholder="e.g. Bulk purchase" value="${escapeHtml(window._discountReasonVal||'')}">
          <label for="discountApprovedBy">Approved by (leave blank if pending)</label>
          <input class="field" id="discountApprovedBy" placeholder="Approver's name" value="${escapeHtml(window._discountApprovedVal||'')}">
        </div>
        <label for="paymentRef">Payment reference (EcoCash/Bank)</label>
        <input class="field" id="paymentRef" placeholder="Transaction reference" value="${escapeHtml(window._paymentRefVal||'')}">
        <label for="docRef">Document Reference No. (optional)</label>
        <input class="field" id="docRef" maxlength="40" placeholder="e.g. PO, delivery note or invoice no." value="${escapeHtml(window._docRefVal||'')}">
      </div>
    </div>`;
  }
  function wireSaleDetails(container){
    const t = container.querySelector("#saleDetailsToggle"), body = container.querySelector("#saleDetailsBody");
    if(t && body) t.onclick = ()=>{ body.hidden = !body.hidden; window._saleDetailsOpen = !body.hidden; t.setAttribute("aria-expanded", String(!body.hidden)); t.querySelector(".chev").textContent = body.hidden? "▾" : "▴"; };
    const on = (id, key)=>{ const el = container.querySelector("#"+id); if(el) el.oninput = (e)=>{ window[key] = e.target.value; }; };
    on("discountReason","_discountReasonVal"); on("discountApprovedBy","_discountApprovedVal"); on("paymentRef","_paymentRefVal"); on("docRef","_docRefVal");
  }
  // The four quick-tap buttons. EcoCash/Bank with no reference yet: open
  // "Sale details" at the reference box instead of an alert.
  function wirePayButtons(container, ids, refresh){
    const needsRef = ()=>{
      if((window._paymentRefVal||"").trim()) return false;
      window._saleDetailsOpen = true; refresh();
      const ref = document.getElementById("paymentRef");
      if(ref){ ref.focus(); ref.setAttribute("aria-invalid","true"); ref.placeholder = "Enter the payment reference to continue"; }
      return true;
    };
    const pay = (method)=>{ completeSale(method, quickTapPayments(method)); if(!cart.length) resetCheckoutFields(); };
    const b = (sel)=> container.querySelector(sel);
    if(b(ids.cash)) b(ids.cash).onclick = ()=> pay("Cash");
    if(b(ids.eco)) b(ids.eco).onclick = ()=>{ if(!needsRef()) pay("EcoCash"); };
    if(b(ids.bank)) b(ids.bank).onclick = ()=>{ if(!needsRef()) pay("Bank"); };
    if(b(ids.credit)) b(ids.credit).onclick = ()=> pay("Credit");
  }
  // Shows a "voucher available" badge + Apply button once the typed
  // customer name matches an existing customer with an Available voucher;
  // switches to a "voucher applied" pill (with a way to remove it) once
  // applied. Auto-clears if the name is edited to no longer match the
  // customer the voucher was applied for.
  function renderVoucherBox(){
    const box = document.getElementById("voucherBox");
    if(!box) return;
    // the customer picked in the cart (customers.js), else a typed exact name
    const nameEl = document.getElementById("custName");
    const name = nameEl? nameEl.value.trim() : "";
    const cust = (typeof cartCustomer!=="undefined" && cartCustomer)? one("SELECT * FROM customers WHERE id=?",[cartCustomer.id]) : findMatchingCustomer(name);
    const totalEl = document.getElementById("drawerTotal") || document.getElementById("dsTotal");
    if(appliedVoucher && (!cust || cust.id!==appliedVoucher.customerId)){
      appliedVoucher = null;
      if(totalEl) totalEl.textContent = currency+cartTotal().toFixed(2);
    }
    if(!cust){ box.innerHTML=""; return; }
    if(appliedVoucher && appliedVoucher.customerId===cust.id){
      box.innerHTML = `<div class="pill ok" style="display:inline-flex;align-items:center;gap:6px;margin:6px 0">Voucher applied: -${currency}${appliedVoucher.amount.toFixed(2)} <button type="button" data-remove-voucher style="background:none;border:none;color:inherit;font-weight:700;padding:0 2px;cursor:pointer">✕</button></div>`;
      box.querySelector("[data-remove-voucher]").onclick=()=>{
        appliedVoucher = null;
        if(totalEl){ totalEl.textContent = currency+cartTotal().toFixed(2); renderVoucherBox(); }
        else render();
      };
      return;
    }
    // Phase 3c: a customer can also hold store credit (a return); each is
    // offered, one voucher per sale, as before.
    const vouchers = all("SELECT * FROM vouchers WHERE customer_id=? AND status='Available' ORDER BY id",[cust.id]);
    if(!vouchers.length){ box.innerHTML=""; return; }
    box.innerHTML = vouchers.map(voucher=>`<div class="card" style="padding:8px 10px;margin:6px 0;display:flex;justify-content:space-between;align-items:center">
      <span>🎁 ${voucher.kind==="store_credit"? "Store credit" : "Voucher"} available: ${currency}${voucher.amount.toFixed(2)}</span>
      <button type="button" class="btn btn-sm btn-primary" data-apply-voucher="${voucher.id}" style="flex:none">Apply ${voucher.kind==="store_credit"? "Store Credit" : "Voucher"}</button>
    </div>`).join("");
    box.querySelectorAll("[data-apply-voucher]").forEach(b=>b.onclick=()=>{
      const voucher = vouchers.find(v=>v.id===+b.dataset.applyVoucher);
      appliedVoucher = { id:voucher.id, amount:voucher.amount, customerId:cust.id };
      if(totalEl){ totalEl.textContent = currency+cartTotal().toFixed(2); renderVoucherBox(); }
      else render();   // desktop Sales screen: its total is redrawn with the cart
    });
  }


  // Single list of More-page tabs, filtered for Remote branches — used to
  // drive the dropdown so there's one place that defines what's in it.
  const MORE_TABS = [
    { id:"help", label:"Help" },
    { id:"about", label:"About" },
    { id:"directory", label:"Directory" },
    { id:"productlist", label:"Product List" },
    { id:"branches", label:"Stock by branch", remoteLabel:"Other branches", needs:()=> typeof bsTabAvailable==="function" && bsTabAvailable() },   // Branches B1
    { id:"stocktake", label:"Stocktake" },   // every branch counts its own stock (Branches addendum §R7)
    { id:"requests", label:"Requests" },
    { id:"purchasing", label:"Purchasing", remoteHidden:true },
    { id:"reportwriter", label:"Report Writer", remoteHidden:true },
    { id:"settings", label:"Settings" },
  ];
  function moreTabsAvailable(){
    return MORE_TABS.filter(t=> !(t.remoteHidden && isRemote()) && !(t.needs && !t.needs()))
      .map(t=> t.remoteLabel && isRemote()? Object.assign({}, t, { label:t.remoteLabel }) : t);
  }
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
    else if(moreTab==="branches"){ if(typeof bsTabAvailable==="function" && bsTabAvailable()) renderBranchStock(body); else { moreTab="help"; renderHelp(body); } }
    else if(moreTab==="stocktake") renderStocktake(body);
    else if(moreTab==="requests") renderStockRequests(body);
    else if(moreTab==="purchasing"){ if(isRemote()){ moreTab="help"; renderHelp(body); } else renderPurchasing(body); }
    else if(moreTab==="reportwriter"){ if(isRemote()){ moreTab="help"; renderHelp(body); } else renderReportWriter(body); }
    else if(moreTab==="settings") renderSettings(body);
  }

