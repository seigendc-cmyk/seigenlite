  function searchProducts(q, branch){
    branch = branch===undefined ? currentBranch() : branch;
    // deactivated products (Phase 3a soft delete) are never offered for sale
    const all_ = branch? all("SELECT * FROM products WHERE branch=? AND COALESCE(active,1)=1 ORDER BY name",[branch])
                        : all("SELECT * FROM products WHERE COALESCE(active,1)=1 ORDER BY branch,name");
    return all_.filter(p=> matchesAnyOrder(q, p.name+" "+(p.sku||"")+" "+(p.description||"")));
  }

  // Owner decision (2026-10-06, replaces the first Phase 3a rule): a till
  // never sells below zero stock, registered or not. Multi-till branches get
  // shared branch stock and offline allowances in Phase 3b
  // (docs/multi-terminal/phase3a-design.md, "Phase 3b decisions").
  // What may be sold of a product now: its stock, or on a shared-stock till
  // (Phase 3b, shared-stock.js) branch stock online / this till's allowance offline.
  function sellable(p){ return typeof sellableNow==="function"? sellableNow(p) : p.stock; }
  function addToCart(p){
    if(typeof window!=="undefined" && window._stockChecking) return;   // a shared-stock sale is being checked
    const max = sellable(p);
    const existing = cart.find(c=>c.product_id===p.id);
    if(existing){ existing.stock = max; if(existing.qty < max) existing.qty++; }
    else { if(max>0) cart.push({product_id:p.id,name:p.name,price:p.price,qty:1,stock:max}); }
    render();
  }
  // A till in a multi-till branch whose stock isn't shared yet, and that
  // doesn't hold the branch's stock itself, has nothing to sell (Phase 3a
  // note). Phase 3b decides it from the server's answer (stock holder), so a
  // branch whose T1 was deactivated and runs on a single T2 is handled; before
  // the first stock sync it falls back to the till code.
  const TILL_STOCK_NOTE = "Stock for this till isn't set up yet — coming in the next update.";
  function tillStockPending(){
    if(!getSetting("terminal_id","")) return false;
    const mode = getSetting("stock_mode","");
    if(mode==="shared") return getSetting("stock_init","")!=="1";
    if(mode==="local") return getSetting("stock_holder","")!=="1";
    const t = getSetting("till_code","");
    return /^T[0-9]+$/.test(t) && t!=="T1";
  }
  function tillStockNoteHtml(){
    return tillStockPending()? `<div class="box till-stock-note" style="margin:0 0 10px;padding:10px 12px;border:1px solid #b54708;border-radius:8px;background:#fff8f0;color:#b54708;font-weight:600">${escapeHtml(TILL_STOCK_NOTE)}</div>` : "";
  }
  function changeQty(pid, delta){
    if(typeof window!=="undefined" && window._stockChecking) return;
    const item = cart.find(c=>c.product_id===pid);
    if(!item) return;
    if(delta>0 && item.qty>=item.stock) return;
    item.qty += delta;
    if(item.qty<=0) cart = cart.filter(c=>c.product_id!==pid);
    render();
  }
  function cartSubtotal(){ return cart.reduce((s,c)=>s+c.price*c.qty,0); }
  // Line-Item Discount: each cart line carries its own optional `discount`
  // (a dollar amount typed against that line, same convention the removed
  // cart-level Discount ($) field used — never a percentage), capped at
  // that line's own gross (price*qty) so one line's discount can never make
  // ANOTHER line — or the sale as a whole — go negative. Read straight off
  // the cart item itself rather than a DOM element (unlike the old
  // currentDiscount(), which read a single #discountInput): there's no
  // longer one shared input to read, and cart state is the natural home for
  // per-line data anyway (it already carries price/qty/stock per line).
  function lineDiscount(c){ return Math.min(Math.max(0, parseFloat(c.discount)||0), c.price*c.qty); }
  function cartDiscountTotal(){ return cart.reduce((s,c)=>s+lineDiscount(c),0); }
  function currentVoucherAmount(){ return appliedVoucher? appliedVoucher.amount : 0; }
  // Single source of truth for the sale math: discount is the sum of every
  // line's own (already-clamped) discount, so it can never exceed the
  // subtotal by construction, and voucher is capped at what's left after
  // discount — the amounts we store and print always add up to the printed
  // total. Cart-time markup was removed (Remove Cart Markup Calculation
  // task) — items sell strictly at cart price (already the product's
  // configured selling price); `sales.markup`/`markup_reason` stay in the
  // schema only so historical rows (and Merge/the Markup Report) keep
  // whatever was actually charged before this change, see completeSale
  // below. `subtotal`/`discount` keep their original meanings (gross sum,
  // and the amount subtracted from it) rather than folding the discount
  // into `subtotal` — every existing reader of sales.subtotal/sales.discount
  // (EOD, Discount Report, Sales Report, receipts) already expects that
  // shape, so nothing downstream has to change to keep working.
  function cartTotals(){
    const subtotal = cartSubtotal();
    const discount = cartDiscountTotal();
    const base = subtotal - discount;
    const voucher = Math.min(Math.max(0,currentVoucherAmount()), base);
    const total = base - voucher;
    return { subtotal, discount, voucher, total };
  }
  function cartTotal(){ return cartTotals().total; }
  // Wires every per-line discount <input> in a rendered cart (mobile drawer
  // or desktop cart panel — both share this, same reuse pattern as
  // wireSplitTenderPanel/wireFxPreview below). Not refresh(): a full
  // drawer/cart innerHTML rebuild on every keystroke would destroy and
  // recreate the very input being typed into, dropping focus after the
  // first character — the exact bug the split-tender payment-amount fields
  // had (see updateSplitTenderDerived's comment). updateLineDiscountDerived
  // below is this feature's equivalent of that fix: it patches only the
  // Total and the reason/approver reveal, never touching any input node.
  function wireLineDiscountInputs(container){
    container.querySelectorAll("[data-line-discount]").forEach(inp=>{
      inp.oninput = (e)=>{
        const item = cart.find(c=>c.product_id===+inp.dataset.lineDiscount);
        if(item) item.discount = inp.value;
        updateLineDiscountDerived(container);
      };
    });
  }
  // Patches only the values derived from cart-line discounts (the live
  // Total, and whether the reason/approver block is shown) into the
  // already-rendered cart. `container` is the mobile drawer or the desktop
  // cart aside; whichever of #drawerTotal/#dsTotal actually exists in it is
  // updated. Subtotal is deliberately left alone — it's the gross sum
  // (cartSubtotal()), unaffected by line discounts, exactly as it was
  // unaffected by the old cart-level discount field.
  function updateLineDiscountDerived(container){
    const totals = cartTotals();
    const totalEl = container.querySelector("#drawerTotal") || container.querySelector("#dsTotal");
    if(totalEl) totalEl.textContent = currency+totals.total.toFixed(2);
    const extra = container.querySelector("#discountExtra");
    if(extra) extra.style.display = totals.discount>0? "block":"none";
  }
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
  // Reads the Credit *portion* of what's owed via sale_payments rather than
  // whole-sale totals — a Cash+Credit split sale only puts its Credit line
  // on the books, not the full sale amount (the rest was already paid).
  // Every sale, split or not, has at least one sale_payments row (see
  // completeSale), so this is correct for legacy single-method Credit sales
  // too, not just split ones.
  function customerBalance(cid){
    const owed = one(`SELECT COALESCE(SUM(sp.amount),0) as t FROM sale_payments sp
                       JOIN sales s ON s.id=sp.sale_id
                       WHERE s.customer_id=? AND sp.method='Credit'`,[cid]).t;
    const paid = one("SELECT COALESCE(SUM(amount),0) as t FROM credit_payments WHERE customer_id=?",[cid]).t;
    return owed - paid;
  }
  // Payment lines actually recorded for a sale (see completeSale) — the one
  // source of truth for "how was this sale paid", whether split or not.
  function salePayments(saleId){ return all("SELECT * FROM sale_payments WHERE sale_id=?",[saleId]); }
  function saleHasPaymentMethod(saleId, method){ return salePayments(saleId).some(p=>p.method===method); }
  // Totals per payment method across all sales (split or not) in a branch
  // and date range — the one query both the Sales Report breakdown
  // (reports.js) and its tests need, kept here since it's plain data logic,
  // not DOM.
  function paymentMethodTotals(branch, fromTs, toTs){
    const sales = branch? all("SELECT id FROM sales WHERE branch=? AND ts>=? AND ts<=?",[branch,fromTs,toTs])
                         : all("SELECT id FROM sales WHERE ts>=? AND ts<=?",[fromTs,toTs]);
    if(sales.length===0) return [];
    const ids = sales.map(s=>s.id);
    const payments = all(`SELECT method, amount FROM sale_payments WHERE sale_id IN (${ids.map(()=>"?").join(",")})`, ids);
    const byMethod = {};
    payments.forEach(p=>{ byMethod[p.method] = (byMethod[p.method]||0) + p.amount; });
    return Object.keys(byMethod).sort().map(method=>({ method, total: Math.round(byMethod[method]*100)/100 }));
  }
  // Item 6: the same breakdown, additionally split by tender currency —
  // kept as a separate function rather than changing paymentMethodTotals'
  // shape, so its existing (method-only, base-currency-total) callers and
  // tests are untouched. `total` is the base-currency-equivalent (matches
  // paymentMethodTotals' own number for the method), `tendered` is what was
  // actually handed over in that currency — for a BASE-currency row the two
  // are identical by definition.
  function paymentMethodCurrencyTotals(branch, fromTs, toTs){
    const sales = branch? all("SELECT id FROM sales WHERE branch=? AND ts>=? AND ts<=?",[branch,fromTs,toTs])
                         : all("SELECT id FROM sales WHERE ts>=? AND ts<=?",[fromTs,toTs]);
    if(sales.length===0) return [];
    const ids = sales.map(s=>s.id);
    const payments = all(`SELECT method, amount, currency, tendered_amount FROM sale_payments WHERE sale_id IN (${ids.map(()=>"?").join(",")})`, ids);
    const byKey = {};
    payments.forEach(p=>{
      const code = p.currency || BASE_CURRENCY_CODE;
      const key = p.method+"|"+code;
      if(!byKey[key]) byKey[key] = { method:p.method, currency:code, total:0, tendered:0 };
      byKey[key].total += p.amount;
      byKey[key].tendered += (p.tendered_amount==null? p.amount : p.tendered_amount);
    });
    return Object.keys(byKey).sort().map(k=>{
      const r = byKey[k];
      return { method:r.method, currency:r.currency, symbol:currencySymbolFor(r.currency),
        total:roundMoney(r.total), tendered:roundMoney(r.tendered) };
    });
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

  // The four methods the app has always offered — single source of truth
  // for both the quick single-tap buttons and the split-tender line editor,
  // so adding/renaming a method only ever happens in one place.
  const PAYMENT_METHODS = ["Cash","EcoCash","Bank","Credit"];

  function roundMoney(n){ return Math.round((n||0)*100)/100; }
  // Base-currency equivalent of one split-tender line as currently typed —
  // the same conversion completeSale() applies for real, kept in sync here
  // purely so Remaining/Complete Sale reflect it live. NaN means "not
  // convertible right now" (no accepted/positive rate for this currency —
  // item 8): treated as 0 toward Remaining, but always keeps Complete Sale
  // disabled via splitLinesValid() below, never silently treated as 1:1.
  function lineBaseAmount(l){
    const code = l.currency || BASE_CURRENCY_CODE;
    const amt = parseFloat(l.amount)||0;
    if(code===BASE_CURRENCY_CODE) return roundMoney(amt);
    if(!currencyAccepted(code)) return NaN;
    return roundMoney(amt / getCurrencyByCode(code).rate);
  }
  function splitLinesTotal(){
    return roundMoney(splitLines.reduce((s,l)=>{ const b=lineBaseAmount(l); return s+(isNaN(b)?0:b); },0));
  }
  function splitLinesValid(){ return splitLines.every(l=>{ const b=lineBaseAmount(l); return !isNaN(b) && b>0; }); }
  // Shared by the initial render and updateSplitTenderDerived() so the
  // "invalid rate" / "≈ equivalent" message logic for a line lives in one
  // place, whether it's being stringified into the first innerHTML or
  // patched into an existing node on a later keystroke.
  function splitLineMessage(l){
    const code = l.currency || BASE_CURRENCY_CODE;
    const base = lineBaseAmount(l);
    const showEquivalent = code!==BASE_CURRENCY_CODE && parseFloat(l.amount)>0;
    const invalid = code!==BASE_CURRENCY_CODE && isNaN(base);
    const text = invalid? `"${code}" has no usable exchange rate — set one in Settings first.`
      : showEquivalent? `≈ ${currency}${base.toFixed(2)} at this device's current rate` : "";
    return { text, invalid, showEquivalent };
  }
  // Positive = still owed, negative = overpaid, both surfaced to the user;
  // only exactly 0 unlocks Complete Sale (item 2 of the spec).
  function splitRemaining(){ return roundMoney(cartTotal() - splitLinesTotal()); }
  function startSplitTender(){
    splitTender = true;
    if(splitLines.length===0) splitLines = [{method:"Cash",amount:"",currency:BASE_CURRENCY_CODE},{method:"EcoCash",amount:"",currency:BASE_CURRENCY_CODE}];
  }
  function cancelSplitTender(){ splitTender = false; splitLines = []; }
  function addSplitLine(){ splitLines.push({method:"Cash",amount:"",currency:BASE_CURRENCY_CODE}); }
  function removeSplitLine(i){ splitLines.splice(i,1); }
  function currencyOptionsHtml(selected){
    const base = `<option value="${BASE_CURRENCY_CODE}" ${selected===BASE_CURRENCY_CODE?"selected":""}>${escapeHtml(currency)} (base)</option>`;
    const others = activeCurrencies().map(c=>`<option value="${escapeHtml(c.code)}" ${selected===c.code?"selected":""}>${escapeHtml(c.code)} (${escapeHtml(c.symbol||c.code)})</option>`).join("");
    return base+others;
  }

  // Item 4: a non-persisted checkout convenience — the cart total converted
  // into a chosen foreign currency (total × rate), purely for the cashier's
  // reference. The authoritative total stays base-currency; this never
  // feeds into completeSale or any payment line. Hidden entirely when no
  // foreign currency is configured, so a base-currency-only shop's checkout
  // looks exactly as it did before this feature.
  function fxPreviewHtml(){
    const currencies = activeCurrencies();
    if(currencies.length===0) return "";
    const chosen = currencies.find(c=>c.code===fxPreviewCurrency);
    return `
      <div class="row" style="margin:2px 0 8px;align-items:center">
        <select class="field" id="fxPreviewSelect" style="flex:1">
          <option value="">Show total in…</option>
          ${currencies.map(c=>`<option value="${escapeHtml(c.code)}" ${fxPreviewCurrency===c.code?"selected":""}>${escapeHtml(c.code)}</option>`).join("")}
        </select>
        ${chosen? `<div class="muted" id="fxPreviewAmount" style="flex:1;text-align:right;font-size:13px">≈ ${escapeHtml(chosen.symbol||chosen.code)}${(cartTotal()*chosen.rate).toFixed(2)}</div>` : ""}
      </div>`;
  }
  function wireFxPreview(container, refresh){
    const sel = container.querySelector("#fxPreviewSelect");
    if(sel) sel.onchange = (e)=>{ fxPreviewCurrency = e.target.value; refresh(); };
  }

  // ---- Currency Selection on Quick-Tap Checkout ----
  // Reuses currencyOptionsHtml() — the exact same option list the
  // split-tender line editor already builds — so there is only ever one
  // place that renders "which currency" as a dropdown. Hidden entirely
  // when no foreign currency is configured, so a base-currency-only shop's
  // quick-tap checkout renders nothing extra (item 2).
  function quickTapCurrencySelectorHtml(){
    if(activeCurrencies().length===0) return "";
    return `
      <div class="row" style="margin-bottom:8px;align-items:center">
        <span class="muted" style="flex:none;font-size:12px">Pay in</span>
        <select class="field" id="quickTapCurrency">${currencyOptionsHtml(quickTapCurrency||BASE_CURRENCY_CODE)}</select>
      </div>`;
  }
  function wireQuickTapCurrencySelector(container, refresh){
    const sel = container.querySelector("#quickTapCurrency");
    // No refresh() here: nothing else on screen is derived from
    // quickTapCurrency (unlike fxPreviewCurrency, which drives a visible
    // converted-total line) — it's only read later, when a quick-tap button
    // is clicked. A full drawer/cart rebuild on every change would just
    // destroy and recreate this very <select>, jumping scroll for no
    // visible benefit; the native <select> already reflects the chosen
    // option on its own.
    if(sel) sel.onchange = (e)=>{ quickTapCurrency = e.target.value===BASE_CURRENCY_CODE? "" : e.target.value; };
  }
  // Builds the single-line `payments` array a quick-tap button passes to
  // completeSale() when a non-base currency is selected — completeSale then
  // runs the EXACT SAME resolution/validation it already runs for a
  // one-line split-tender sale (rate lookup, no-rate block, base-equivalent
  // conversion); nothing here duplicates that logic, it only decides what
  // tendered amount to ask for (the foreign equivalent of the cart total,
  // the same number fxPreviewHtml already shows as a convenience). Returns
  // undefined — the original call shape — when the base currency is
  // selected, so quick-tap behaves byte-for-byte as before in that case.
  function quickTapPayments(method){
    if(!quickTapCurrency) return undefined;
    const cur = getCurrencyByCode(quickTapCurrency);
    const rate = (cur && cur.rate>0)? cur.rate : 1; // falls through to completeSale's own no-rate block if invalid
    return [{ method, amount: roundMoney(cartTotal()*rate), currency: quickTapCurrency }];
  }

  // Shared between the mobile drawer (router.js) and the desktop cart
  // (desktop/sales-desktop.js) — both already reuse pos.js's cart/checkout
  // logic rather than keeping their own copy, so this new panel follows the
  // same pattern instead of being written twice.
  function splitTenderPanelHtml(){
    const remaining = splitRemaining();
    // Mirrors completeSale's own validation exactly (blank/zero/unconvertible
    // lines rejected, base-equivalent amounts must sum to the total) so
    // Complete Sale is only ever enabled when the click would actually
    // succeed.
    const ok = remaining===0 && splitLines.length>0 && splitLinesValid();
    return `
      <div class="split-tender">
        ${splitLines.map((l,i)=>{
          const code = l.currency || BASE_CURRENCY_CODE;
          const { text, invalid, showEquivalent } = splitLineMessage(l);
          return `
          <div class="row" id="splitRow-${i}" style="margin-bottom:${invalid||showEquivalent?"2px":"8px"}" data-split-idx="${i}">
            <select class="field" data-split-method="${i}">
              ${PAYMENT_METHODS.map(m=>`<option value="${m}" ${l.method===m?"selected":""}>${m}</option>`).join("")}
            </select>
            <input class="field" type="number" step="0.01" min="0" placeholder="0.00" data-split-amount="${i}" value="${escapeHtml(String(l.amount))}">
            <select class="field" data-split-currency="${i}" style="flex:0.8">${currencyOptionsHtml(code)}</select>
            ${splitLines.length>1? `<button class="btn btn-ghost btn-sm" data-split-remove="${i}" style="flex:none">✕</button>` : ""}
          </div>
          <div class="muted" id="splitMsg-${i}" style="font-size:11px;margin-bottom:${text?"8px":"0"}${invalid?";color:var(--danger)":""}">${escapeHtml(text)}</div>`;
        }).join("")}
        <button class="btn btn-ghost btn-sm" id="addSplitLine" style="margin-bottom:10px">+ Add another payment method</button>
        <div class="subline" id="splitRemainingLine" style="font-size:14px;font-weight:600;color:${remaining===0?"inherit":"var(--danger)"}">
          <span>Remaining</span><span id="splitRemaining">${currency}${remaining.toFixed(2)}</span>
        </div>
        <button class="btn btn-primary" id="completeSplitSale" ${ok?"":"disabled"} style="margin-top:6px">Complete Sale</button>
        <button class="btn btn-ghost btn-sm" id="cancelSplitTender" style="margin-top:8px">← Back to single payment method</button>
      </div>`;
  }
  // Patches only the values derived from splitLines (Remaining, Complete
  // Sale's disabled state, each line's invalid-rate/equivalent message) into
  // the already-rendered panel. Used instead of refresh() for the
  // amount/currency inputs specifically: those fire on every keystroke, and
  // refresh() rebuilds the whole drawer/cart via innerHTML — which destroys
  // and recreates every input in it, dropping focus (and, on the desktop
  // cart, the product table's scroll position too) after the very first
  // character typed. Nothing here touches the input/select elements
  // themselves, so whatever the cashier is mid-typing is left alone.
  function updateSplitTenderDerived(container){
    const remaining = splitRemaining();
    const ok = remaining===0 && splitLines.length>0 && splitLinesValid();
    const remEl = container.querySelector("#splitRemaining");
    if(remEl) remEl.textContent = currency+remaining.toFixed(2);
    const remLine = container.querySelector("#splitRemainingLine");
    if(remLine) remLine.style.color = remaining===0? "inherit":"var(--danger)";
    const completeBtn = container.querySelector("#completeSplitSale");
    if(completeBtn) completeBtn.disabled = !ok;
    splitLines.forEach((l,i)=>{
      const { text, invalid, showEquivalent } = splitLineMessage(l);
      const row = container.querySelector("#splitRow-"+i);
      if(row) row.style.marginBottom = (invalid||showEquivalent)? "2px":"8px";
      const msg = container.querySelector("#splitMsg-"+i);
      if(msg){
        msg.textContent = text;
        msg.style.marginBottom = text? "8px":"0";
        msg.style.color = invalid? "var(--danger)":"";
      }
    });
  }
  // refresh() redraws whichever screen (drawer or desktop cart) embedded the
  // panel; onComplete(payments) is called only once amounts balance exactly.
  function wireSplitTenderPanel(container, refresh, onComplete){
    container.querySelectorAll("[data-split-method]").forEach(sel=>{
      sel.onchange = (e)=>{ splitLines[+sel.dataset.splitMethod].method = e.target.value; refresh(); };
    });
    container.querySelectorAll("[data-split-amount]").forEach(inp=>{
      // Not refresh(): see updateSplitTenderDerived's comment above.
      inp.oninput = (e)=>{ splitLines[+inp.dataset.splitAmount].amount = e.target.value; updateSplitTenderDerived(container); };
    });
    container.querySelectorAll("[data-split-currency]").forEach(sel=>{
      sel.onchange = (e)=>{ splitLines[+sel.dataset.splitCurrency].currency = e.target.value; updateSplitTenderDerived(container); };
    });
    container.querySelectorAll("[data-split-remove]").forEach(btn=>{
      btn.onclick = ()=>{ removeSplitLine(+btn.dataset.splitRemove); refresh(); };
    });
    const addBtn = container.querySelector("#addSplitLine");
    if(addBtn) addBtn.onclick = ()=>{ addSplitLine(); refresh(); };
    const cancelBtn = container.querySelector("#cancelSplitTender");
    if(cancelBtn) cancelBtn.onclick = ()=>{ cancelSplitTender(); refresh(); };
    const completeBtn = container.querySelector("#completeSplitSale");
    if(completeBtn) completeBtn.onclick = ()=>{
      if(splitRemaining()!==0 || splitLines.length===0 || !splitLinesValid()) return;
      onComplete(splitLines.map(l=>({method:l.method, amount:parseFloat(l.amount)||0, currency:l.currency||BASE_CURRENCY_CODE})));
    };
  }

  // method: used exactly as before for the single-tap Cash/EcoCash/Bank/
  // Credit buttons (payments omitted). payments: optional [{method,amount}]
  // from the split-tender panel — when present it's the authoritative list
  // and method is ignored. Either way, every sale gets one-or-more
  // sale_payments rows (see below): a plain sale just gets a single row
  // mirroring its one method/total, so EOD/credit/report queries never have
  // to special-case "was this split or not".
  // Optional Document Reference No. (PO / delivery note / invoice number)
  // typed at the cart. Never required, so there's no rejecting alert — just
  // basic sanitising: control characters dropped (they'd garble an ESC/POS
  // printout), runs of whitespace collapsed, and capped at DOC_REF_MAX so a
  // stray paste can't blow out a receipt line. Blank stays blank.
  const DOC_REF_MAX = 40;
  function cleanDocRef(s){
    return String(s||"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0, DOC_REF_MAX).trim();
  }

  // stockPlan (Phase 3b, shared-stock.js): set when a shared-stock till's sale
  // comes back from the server check: { saleUid, alloc:{productId: units from
  // this till's allowance}, mode, inputs }. Every other till never passes it,
  // and the sale is exactly as before.
  function completeSale(method, payments, stockPlan){
    if(cart.length===0) return;
    // Shift/EOD control (Part 3): the one choke point every payment method,
    // on both the mobile cart drawer (router.js) and the desktop Sales
    // screen (desktop/sales-desktop.js), goes through — neither has its own
    // copy of this check. shiftBlockReason() (eod.js) also re-derives
    // today's business date here, on every attempted sale, which is the
    // main touchpoint that keeps the anti-rollback high-water-mark current.
    const blocked = shiftBlockReason();
    if(blocked){ alert(blocked); return; }

    // Clamped here (rather than trusting the raw inputs) so discount/voucher
    // never exceed what the sale can actually absorb — otherwise the
    // subtotal/discount/voucher lines printed on the receipt and summed in
    // EOD/Discount reports wouldn't add up to the total, which was floored
    // at 0 instead of reflecting what was really given away.
    const { subtotal, discount, voucher: voucherAmount, total } = cartTotals();

    const rawLines = (payments && payments.length) ? payments.slice() : [{method, amount: total}];

    // Resolve each line's tender currency to a base-currency-equivalent
    // amount up front, before any other validation — a currency with no
    // configured/active/positive rate blocks the whole sale right here
    // (item 8), never silently falls back to 1:1. A line with no `currency`
    // (every pre-existing caller: the four quick-tap buttons, and any
    // caller from before this feature) is the reserved BASE_CURRENCY_CODE,
    // so tendered_amount===amount and rate=1 — byte-for-byte the same sale
    // this app has always recorded.
    const lines = [];
    for(const l of rawLines){
      const currencyCode = l.currency || BASE_CURRENCY_CODE;
      const tenderedAmount = roundMoney(parseFloat(l.amount)||0);
      let rate = 1, baseAmount = tenderedAmount;
      if(currencyCode!==BASE_CURRENCY_CODE){
        const cur = getCurrencyByCode(currencyCode);
        if(!cur || !cur.active || !(cur.rate>0)){
          alert(`"${currencyCode}" isn't an accepted currency with a valid exchange rate. Add/fix it in Settings → Accepted Currencies first.`);
          return;
        }
        rate = cur.rate;
        baseAmount = roundMoney(tenderedAmount / rate);
      }
      lines.push({ method:l.method, currency:currencyCode, rate, tenderedAmount, amount:baseAmount });
    }
    if(lines.length>1){
      if(lines.some(l=>!(l.amount>0))){ alert("Enter an amount for every payment method."); return; }
      const sum = roundMoney(lines.reduce((s,l)=>s+l.amount,0));
      if(sum!==roundMoney(total)){
        alert(`Payment amounts (${currency}${sum.toFixed(2)}) must add up to the sale total (${currency}${total.toFixed(2)}).`);
        return;
      }
    }
    // "Split" only when genuinely more than one method was used — a
    // split-tender sale that ends up with a single line (e.g. everything
    // else removed) is stored exactly like a normal single-method sale.
    const saleMethod = lines.length>1? "Split" : lines[0].method;

    const inp = stockPlan && stockPlan.inputs;                             // the checkout fields as they were before the stock check
    const nameEl = inp? { value:inp.custName } : document.getElementById("custName");
    const phoneEl = inp? { value:inp.custPhone } : document.getElementById("custPhone");
    const custName = nameEl? nameEl.value.trim() : "";
    const custPhone = phoneEl? phoneEl.value.trim() : "";
    if(lines.some(l=>l.method==="Credit") && !custName){ alert("Enter the customer's name for a credit sale"); return; }

    const reasonEl = inp? { value:inp.discountReason } : document.getElementById("discountReason");
    const approvedEl = inp? { value:inp.discountApprovedBy } : document.getElementById("discountApprovedBy");
    const discountReason = reasonEl? reasonEl.value.trim() : "";
    const discountApprovedBy = approvedEl? approvedEl.value.trim() : "";
    // Gated once per cart/checkout, not once per discounted line: this is
    // still the same single reason-required-above-zero rule the cart-level
    // field enforced, now triggered by ANY line carrying a discount rather
    // than one shared input. A cashier discounting three lines for the same
    // reason ("Manager's special") shouldn't have to type it three times,
    // and there's still exactly one sale-level discount_reason/
    // discount_approved_by/discount_status to attach it to (see the INSERT
    // below) — unchanged from before this feature.
    if(discount>0 && !discountReason){ alert("Enter a reason for the discount"); return; }

    const refEl = inp? { value:inp.paymentRef } : document.getElementById("paymentRef");
    const paymentRef = refEl? refEl.value.trim() : "";
    if(lines.some(l=>l.method==="EcoCash"||l.method==="Bank") && !paymentRef){ alert("Enter the payment reference number"); return; }

    const docRefEl = inp? { value:inp.docRef } : document.getElementById("docRef");
    const docRef = cleanDocRef(docRefEl? docRefEl.value : "");

    // Multi-terminal Phase 3b: a shared-stock till asks the server first; the
    // sale is written only when that comes back (or from this till's allowance).
    if(!stockPlan && typeof sharedStockTill==="function" && sharedStockTill()){
      return sharedStockCheckout(cart.map(c=>({ product_id:c.product_id, qty:c.qty })), (plan)=>completeSale(method, payments, plan),
        { custName, custPhone, discountReason, discountApprovedBy, paymentRef, docRef });
    }
    const customerId = custName? findOrCreateCustomer(custName, custPhone) : null;
    const voucherToRedeem = appliedVoucher;
    const ts = new Date().toISOString();

    const discountStatus = discount>0? (discountApprovedBy? "Approved":"Pending") : "";
    const branch = currentBranch();
    // markup/markup_reason are always written as 0/"" — cart-time markup
    // was removed (Remove Cart Markup Calculation task); the columns stay
    // in the schema only so historical rows keep whatever was charged
    // before this change (see cartTotals above).
    // Multi-terminal Phase 2: a registered till numbers its receipts T2-0045
    // (its own counter); an unregistered device keeps "#<sales.id>" exactly as
    // before, so receipt_no stays NULL there.
    // (getSetting first: an unregistered device never needs docnum.js here)
    const receiptNo = getSetting("till_code","") && currentTillCode()? reserveDocNumber("RCT").text : null;
    run(`INSERT INTO sales(ts,subtotal,discount,total,method,customer_id,branch,discount_reason,discount_approved_by,discount_status,markup,markup_reason,payment_ref,user,voucher_amount,doc_ref,receipt_no)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ts,subtotal,discount,total,saleMethod,customerId,branch,discountReason,discountApprovedBy,discountStatus,0,"",paymentRef,sessionUser||"",voucherAmount,docRef,receiptNo]);
    const saleId = one("SELECT last_insert_rowid() as id").id;
    if(stockPlan) run("UPDATE sales SET uid=? WHERE id=?",[stockPlan.saleUid, saleId]);   // the uid the server knows this sale by
    const saleUid = (one("SELECT uid FROM sales WHERE id=?",[saleId])||{}).uid || null;
    const label = receiptLabel(saleId, receiptNo);
    lines.forEach(l=>{
      run("INSERT INTO sale_payments(sale_id,method,amount,currency,rate,tendered_amount) VALUES(?,?,?,?,?,?)",
        [saleId,l.method,l.amount,l.currency,l.rate,l.tenderedAmount]);
    });
    // Each line's own (already-clamped) discount is persisted alongside it
    // — additive column, see db.js's migrate(). sum(sale_items.discount)
    // for this sale always equals the `discount` written on the sales row
    // above, since both come from the same lineDiscount()/cartDiscountTotal()
    // calls (cartTotals() already ran before this loop).
    const receiptItems = cart.map(c=>({ product_id:c.product_id, name:c.name, price:c.price, qty:c.qty, discount:lineDiscount(c) }));
    receiptItems.forEach(c=>{
      const prod = one("SELECT cost FROM products WHERE id=?",[c.product_id]);
      run("INSERT INTO sale_items(sale_id,product_id,name,price,qty,cost,discount) VALUES(?,?,?,?,?,?,?)",
        [saleId,c.product_id,c.name,c.price,c.qty,prod?prod.cost:0,c.discount]);
      // shared-stock till: only the part of the line taken from this till's own allowance changes its stock
      const fromHere = stockPlan && Object.prototype.hasOwnProperty.call(stockPlan.alloc, c.product_id)? stockPlan.alloc[c.product_id] : c.qty;
      if(fromHere) moveStock({ productId:c.product_id, delta:-fromHere, kind:"sale", docType:"sale", docUid:saleUid, docNo:label, ts });
    });
    if(voucherToRedeem){
      run("UPDATE vouchers SET status='Redeemed', redeemed_ts=?, redeemed_sale_id=? WHERE id=?",[ts,saleId,voucherToRedeem.id]);
    }
    const itemNames = cart.map(c=>c.name);
    const itemsSummary = itemNames.length<=3? itemNames.join(", ") : `${itemNames[0]} +${itemNames.length-1} more`;
    const methodLabel = lines.length>1? `Split (${lines.map(l=>l.method).join("+")})` : saleMethod;
    logAudit("Sale", itemsSummary, `Receipt ${label} · ${currency}${total.toFixed(2)} · ${methodLabel}`);
    maybeIssueFrequentCustomerVoucher(customerId, branch, ts);
    persist();
    window._lastReceipt = {saleId,receiptNo,ts,subtotal,discount,markup:0,voucherAmount,total,method:saleMethod,payments:lines.slice(),items:receiptItems,docRef};
    printReceipt(saleId, ts, subtotal, discount, 0, voucherAmount, total, saleMethod, receiptItems, lines, docRef, receiptNo);
    cart = []; drawerOpen=false; appliedVoucher=null; cancelSplitTender(); fxPreviewCurrency=""; quickTapCurrency="";
    render();
  }


  function renderPOS(main){
    const results = searchProducts(searchQuery);
    main.innerHTML = `
      ${shiftBlockBannerHtml()}
      ${dcMessagesBannerHtml()}
      ${tillStockNoteHtml()}
      ${typeof sharedStockOfflineBadgeHtml==="function"? sharedStockOfflineBadgeHtml() : ""}
      ${window._lastReceipt? `<div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div class="muted">Receipt ${escapeHtml(receiptLabel(window._lastReceipt.saleId, window._lastReceipt.receiptNo))} · ${currency}${window._lastReceipt.total.toFixed(2)}</div>
        <div class="row" style="flex:none;width:auto;gap:6px">
          <button class="btn btn-sm btn-outline" id="reprintBtn">🖨️</button>
          <button class="btn btn-sm btn-ghost" id="waReceiptBtn">📲</button>
          ${hasUSBPrint()? `<button class="btn btn-sm btn-outline" id="usbReceiptBtn">🔌</button>` : ""}
          ${hasBTPrint()? `<button class="btn btn-sm btn-outline" id="btReceiptBtn">🔵</button>` : ""}
          ${hasSerialPort()? `<button class="btn btn-sm btn-outline" id="openDrawerBtn" title="Open cash drawer">🗃️</button>` : ""}
          ${(window._lastReceipt.payments||[]).some(p=>p.method==="Credit")? `<button class="btn btn-sm btn-outline" id="invoiceBtn">🖨️ Invoice</button>` : ""}
        </div>
      </div>` : ""}
      <div class="search-wrap">
        <span class="ic">🔎</span>
        <input class="field" id="searchInput" placeholder="Search products or SKU…" value="${escapeHtml(searchQuery)}">
      </div>
      <div class="card" id="posResultsArea" style="padding:6px 10px">
        ${productListHtml(results)}
      </div>
    `;
    wireShiftBlockBanner();
    wireDcMessagesBanner();
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
    // Explicit, standalone action (Device Setup, Cash Drawer) — never a
    // side effect of any of the print buttons above; openCashDrawer() is
    // the only thing this ever calls.
    const drawerBtn = document.getElementById("openDrawerBtn");
    if(drawerBtn) drawerBtn.onclick=()=> openCashDrawer();
    if(rp) rp.onclick=()=>{ const r=window._lastReceipt; printReceipt(r.saleId,r.ts,r.subtotal,r.discount,r.markup,r.voucherAmount||0,r.total,r.method,r.items,r.payments,r.docRef,r.receiptNo); };
    if(up) up.onclick=()=>{ const r=window._lastReceipt; usbPrintReceipt(r.saleId,r.ts,r.subtotal,r.discount,r.markup,r.voucherAmount||0,r.total,r.method,r.items,r.payments,r.docRef,r.receiptNo); };
    if(bp) bp.onclick=()=>{ const r=window._lastReceipt; btPrintReceipt(r.saleId,r.ts,r.subtotal,r.discount,r.markup,r.voucherAmount||0,r.total,r.method,r.items,r.payments,r.docRef,r.receiptNo); };
    if(ivb) ivb.onclick=()=>{ printCreditInvoice(window._lastReceipt.saleId); };
    if(wr) wr.onclick=()=>{
      const r = window._lastReceipt;
      const itemLines = r.items.map(i=>padLine(`${i.qty} x ${i.name}`, `${currency}${(i.price*i.qty).toFixed(2)}`));
      const totalLines = [];
      if(r.markup>0) totalLines.push(padLine("Markup", `+${currency}${r.markup.toFixed(2)}`));
      if(r.voucherAmount>0) totalLines.push(padLine("Voucher", `-${currency}${r.voucherAmount.toFixed(2)}`));
      totalLines.push(padLine("TOTAL", `${currency}${r.total.toFixed(2)}`));
      if(r.payments && r.payments.length>1) r.payments.forEach(p=> totalLines.push(padLine(`Payment: ${p.method}`, `${currency}${(parseFloat(p.amount)||0).toFixed(2)}`)));
      else totalLines.push(`Payment: ${r.method}`);
      if(r.docRef) totalLines.push(`Doc Ref: ${r.docRef}`);
      shareWhatsApp(receiptText(`${escapeHtml(getSetting("shop_name",""))} — Receipt ${receiptLabel(r.saleId, r.receiptNo)}`, itemLines, totalLines));
    };
  }
  function productListHtml(results){
    return results.length===0? `<p class="muted" style="padding:10px 4px">No products match. Add products in the Products tab.</p>` :
      results.map(p=>`
        <div class="product-row">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
            ${typeof catPicHtml==="function"? catPicHtml(p, 'class="prod-thumb"', `<div class="prod-thumb-placeholder">${ICON_STOREFRONT}</div>`)
              : (p.image? `<img class="prod-thumb" src="${p.image}">` : `<div class="prod-thumb-placeholder">${ICON_STOREFRONT}</div>`)}
            <div style="min-width:0">
              ${p.sku?`<div class="psku">${escapeHtml(p.sku)}</div>`:""}
              <div class="pname">${escapeHtml(p.name)}</div>
              <div class="pmeta">${currency}${p.price.toFixed(2)} · ${(typeof stockLineText==="function" && stockLineText(p))? `<span class="ss-stock">${escapeHtml(stockLineText(p))}</span>` : p.stock<0?`<span class="pill neg">${p.stock} below zero</span>`:p.stock<=p.low_threshold?`<span class="pill low">${p.stock} left</span>`:`${p.stock} in stock`}</div>
            </div>
          </div>
          <button class="add-chip" data-add="${p.id}" ${sellable(p)<=0?"disabled":""}>${sellable(p)<=0?"Out":"Add"}</button>
        </div>`).join("");
  }
  function wireProductAdds(scope){
    scope.querySelectorAll("[data-add]").forEach(b=>{
      b.onclick=()=>{ const p = one("SELECT * FROM products WHERE id=?",[+b.dataset.add]); addToCart(p); };
    });
  }
  // Rendering Audit fix: this used to target document.querySelector("#main
  // .card") — NOT unique. shiftBlockBannerHtml()/dcMessagesBannerHtml()/the
  // last-receipt card above are ALSO ".card" elements that render before
  // this one whenever a shift is blocked, a message is pending, or a sale
  // was just completed — querySelector matches the FIRST such element, so
  // typing into the search box silently overwrote the banner's own content
  // with the filtered results, while the real results card below kept
  // showing the old, unfiltered list untouched. Now targets the stable,
  // unique #posResultsArea id set on the actual results card above, the
  // same pattern renderProductsTableOnly()/renderCreditListOnly()/
  // renderStocktakeCountingListOnly() already use.
  function renderPOSListOnly(){
    const results = searchProducts(searchQuery);
    const card = document.getElementById("posResultsArea");
    if(!card) return;
    card.innerHTML = productListHtml(results);
    wireProductAdds(card);
  }

