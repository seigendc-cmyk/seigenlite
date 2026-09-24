// ---------------- seiGEN Marketing layer (dist-market/market.html) ----------------
// Runs inside the core app's Marketing tab, in a sandboxed iframe (see
// src/marketing.js). It has no database, no network code and no storage of
// its own: everything it knows about the shop comes from the core app over
// the postMessage bridge, and anything worth keeping (selection, city,
// currency, export status) is handed back to the core app to hold. What it
// does itself: the picker and export screens, and resizing photos to
// 200x200 WebP before they go to the core app for the file.
//
// This file is the whole layer: it is NOT concatenated into the core app's
// IIFE and can't call anything in it.
(function(){
  "use strict";

  const CHANNEL = "seigen-market";
  const BRIDGE_VERSION = 1;
  const MAX_RENDERED_ROWS = 400; // beyond this, ask the user to search rather than render thousands of rows
  const $root = document.getElementById("market");

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

  // ---- bridge client ----
  const inCoreApp = window.parent && window.parent!==window;
  let reqSeq = 0;
  const pending = new Map();
  function post(msg){ window.parent.postMessage(Object.assign({ ch:CHANNEL }, msg), "*"); }
  function ask(op, args){
    return new Promise((resolve, reject)=>{
      const id = ++reqSeq;
      pending.set(id, { resolve, reject });
      post({ type:"req", id, op, args });
    });
  }
  let welcomed = null;
  const welcome = new Promise(r=>{ welcomed = r; });
  window.addEventListener("message", (e)=>{
    if(e.source!==window.parent) return;
    const m = e.data;
    if(!m || typeof m!=="object" || m.ch!==CHANNEL) return;
    if(m.type==="welcome") welcomed(m);
    else if(m.type==="res" && pending.has(m.id)){
      const p = pending.get(m.id); pending.delete(m.id);
      if(m.ok) p.resolve(m.result); else p.reject(new Error(m.error||"Request failed"));
    }
  });
  // Keep the host iframe exactly as tall as this page, so the core app's
  // own page scroll is the only scroll (no box-in-a-box on phones).
  function reportHeight(){ if(inCoreApp) post({ type:"resize", height: document.documentElement.scrollHeight }); }
  if(typeof ResizeObserver==="function") new ResizeObserver(reportHeight).observe(document.body);
  window.addEventListener("load", reportHeight);

  // ---- state ----
  let ctx = null;          // from the core app: maxProducts, currencySymbol, branch...
  let products = [];       // [{id,name,sku,price,stock,category,hasImage}]
  let selected = new Set();
  let query = "";
  let onlySelected = false;
  let saveTimer = null;
  let screen = "picker";   // "picker" | "export"
  let status = { state:"not_exported" }; // from the core app: see marketStatus() in src/marketing.js
  let shareNote = "";      // what happened on the last Send tap, in plain words
  let showChatButton = false;
  let busy = false;
  let setupInfo = { marketWhatsApp:"" }; // shop identity + saved city/currency, from the core app

  const cap = ()=> (ctx && ctx.maxProducts) || 200;
  const money = (n)=> (ctx? ctx.currencySymbol : "") + Number(n||0).toFixed(2);

  // Same "every word must match somewhere" rule as the app's other search boxes.
  function matches(p, q){
    const hay = (p.name+" "+p.sku+" "+p.category).toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(w=> hay.indexOf(w)!==-1);
  }
  function visibleProducts(){
    return products.filter(p=> (!onlySelected || selected.has(p.id)) && (!query || matches(p, query)));
  }

  // Selection lives in the core app; debounce so ticking 20 boxes quickly
  // doesn't fire 20 round trips.
  function saveSelection(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(()=>{ saveTimer = null; flushSelection().catch(()=>{}); }, 250);
  }
  async function flushSelection(){
    clearTimeout(saveTimer); saveTimer = null;
    const ids = await ask("setSelection", { ids: Array.from(selected) });
    selected = new Set(ids); // the core app has the final say (it drops unknown ids, enforces the cap)
    renderCounts();
  }

  // ---- UI ----
  function productWarnings(p){
    const w = [];
    if(!p.hasImage) w.push(`<span class="pill mk-pill-muted">no photo</span>`);
    if(p.stock<=0) w.push(`<span class="pill low">out of stock</span>`);
    if(p.price<=0) w.push(`<span class="pill low">no price</span>`);
    return w.join(" ");
  }
  function rowHtml(p, full){
    const on = selected.has(p.id);
    const disabled = !on && full;
    return `
      <label class="product-row mk-row${on?" mk-on":""}${disabled?" mk-disabled":""}">
        <input type="checkbox" class="mk-check" data-pick="${p.id}" ${on?"checked":""} ${disabled?"disabled":""}>
        <div style="flex:1;min-width:0">
          ${p.sku? `<div class="psku">${escapeHtml(p.sku)}</div>` : ""}
          <div class="pname">${escapeHtml(p.name)}</div>
          <div class="pmeta">${escapeHtml(p.category||"No category")} · Stock ${escapeHtml(String(p.stock))}</div>
          ${productWarnings(p)? `<div style="margin-top:4px">${productWarnings(p)}</div>` : ""}
        </div>
        <div class="mk-price">${escapeHtml(money(p.price))}</div>
      </label>`;
  }
  function renderList(){
    const list = document.getElementById("mkList");
    if(!list) return;
    const vis = visibleProducts();
    const full = selected.size>=cap();
    const shown = vis.slice(0, MAX_RENDERED_ROWS);
    list.innerHTML = products.length===0
      ? `<p class="muted">This branch has no products yet. Add products in the Products tab first.</p>`
      : vis.length===0
        ? `<p class="muted">${onlySelected && selected.size===0? "Nothing selected yet." : "No products match your search."}</p>`
        : shown.map(p=>rowHtml(p, full)).join("")
          + (vis.length>shown.length? `<p class="muted" style="padding:10px 4px">Showing the first ${shown.length} of ${vis.length}. Search to narrow the list.</p>` : "");
    renderCounts();
  }
  function renderCounts(){
    const n = selected.size, max = cap();
    document.querySelectorAll(".mk-count").forEach(el=>{ el.innerHTML = `<b>${n}</b> of ${max} selected`; });
    const capNote = document.getElementById("mkCapNote");
    if(capNote) capNote.style.display = n>=max? "block" : "none";
    const onlyBtn = document.getElementById("mkOnlySelected");
    if(onlyBtn) onlyBtn.textContent = onlySelected? "Show all products" : `Show selected (${n})`;
    const next = document.getElementById("mkContinue");
    if(next) next.disabled = n===0;
    // Checkbox enabled state follows the cap without re-rendering the list
    // (keeps scroll position and doesn't rebuild rows under the user's finger).
    const full = n>=max;
    document.querySelectorAll(".mk-check").forEach(cb=>{
      const off = !cb.checked && full;
      cb.disabled = off;
      cb.closest(".mk-row").classList.toggle("mk-disabled", off);
    });
  }

  function renderPicker(){
    $root.innerHTML = `
      <div id="mkStatus">${statusCardHtml()}</div>
      <div class="card">
        <p style="margin-top:0"><b>Choose products for the iTred Market Place</b></p>
        <p class="muted" style="margin-bottom:0">Tick up to ${cap()} products from ${escapeHtml(ctx.branch)}. Their name, price, category, stock and photo
          go into one file for Digital Commerce to review. Products with a photo and stock get the best results.</p>
      </div>
      <div class="search-wrap">
        <span class="ic">🔎</span>
        <input class="field" id="mkSearch" placeholder="Search name, SKU or category…" value="${escapeHtml(query)}">
      </div>
      <div class="mk-toolbar">
        <button class="btn btn-sm btn-outline" id="mkOnlySelected"></button>
        <button class="btn btn-sm btn-ghost" id="mkSelectShown">Select all shown</button>
        <button class="btn btn-sm btn-ghost" id="mkClear">Clear</button>
        <span class="mk-count mk-count-top"></span>
      </div>
      <div class="box mk-cap" id="mkCapNote">You've reached the ${cap()}-product limit. Untick something to choose another.</div>
      <div class="card" id="mkList" style="padding:4px 10px"></div>
      <div class="mk-footer">
        <div class="mk-count"></div>
        <button class="btn btn-primary btn-sm" id="mkContinue">Continue to export →</button>
      </div>`;
    wireStatusCard();
    document.getElementById("mkContinue").onclick = async ()=>{
      await flushSelection();
      if(!selected.size) return;
      screen = "export"; render();
    };

    // Only the list re-renders while typing, so the search box never loses focus.
    document.getElementById("mkSearch").oninput = (e)=>{ query = e.target.value; renderList(); };
    document.getElementById("mkOnlySelected").onclick = ()=>{ onlySelected = !onlySelected; renderList(); };
    document.getElementById("mkSelectShown").onclick = ()=>{
      for(const p of visibleProducts()){
        if(selected.size>=cap()) break;
        selected.add(p.id);
      }
      renderList(); saveSelection();
    };
    // Two taps instead of confirm(): the sandbox has no allow-modals, so
    // alert/confirm are silently blocked in here.
    let clearArmed = null;
    const clearBtn = document.getElementById("mkClear");
    clearBtn.onclick = ()=>{
      if(!selected.size) return;
      if(!clearArmed){
        clearBtn.textContent = "Tap again to clear "+selected.size;
        clearArmed = setTimeout(()=>{ clearArmed = null; clearBtn.textContent = "Clear"; }, 3000);
        return;
      }
      clearTimeout(clearArmed); clearArmed = null; clearBtn.textContent = "Clear";
      selected.clear(); renderList(); saveSelection();
    };
    document.getElementById("mkList").addEventListener("change", (e)=>{
      const cb = e.target.closest("[data-pick]");
      if(!cb) return;
      const id = Number(cb.dataset.pick);
      if(cb.checked){
        if(selected.size>=cap()){ cb.checked = false; return; }
        selected.add(id);
      } else {
        selected.delete(id);
      }
      cb.closest(".mk-row").classList.toggle("mk-on", cb.checked);
      if(onlySelected && !cb.checked) renderList(); else renderCounts();
      saveSelection();
    });
    renderList();
  }

  // ---- status: not exported / exported / sent / expiring ----
  const fmtDate = (iso)=>{
    const d = new Date(iso);
    return isNaN(d)? "" : d.toLocaleDateString(undefined, { day:"numeric", month:"short", year:"numeric" })
      + " " + d.toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit" });
  };
  function statusCardHtml(){
    const s = status;
    const note = shareNote? `<p class="muted mk-share-note" id="mkShareNote">${escapeHtml(shareNote)}</p>` : "";
    const chat = showChatButton? `<button class="btn btn-sm btn-outline" id="mkOpenChat">Open WhatsApp chat</button>` : "";
    if(s.state==="not_exported"){
      return `<div class="card mk-status" data-state="not_exported"><p class="mk-status-line"><span class="pill mk-pill-muted">Not exported</span>
        No listing file sent yet. Choose products below, then Continue to export.</p></div>`;
    }
    const counts = `${s.productCount} product${s.productCount===1?"":"s"}, ${s.imageCount} with photo`;
    if(s.state==="exported"){
      return `<div class="card mk-status" data-state="exported">
        <p class="mk-status-line"><span class="pill">Exported</span> <b>${escapeHtml(s.exportNo)}</b> · ${escapeHtml(fmtDate(s.exportedTs))}</p>
        <p class="muted">${escapeHtml(counts)}. Not sent yet: send it to Digital Commerce on WhatsApp, then tap “I've sent it”.</p>
        <div class="mk-actions">
          <button class="btn btn-sm btn-primary" id="mkSend">Send via WhatsApp</button>
          ${chat}
          <button class="btn btn-sm btn-outline" id="mkMarkSent">I've sent it</button>
        </div>${note}</div>`;
    }
    if(s.expiring){
      return `<div class="card mk-status mk-expiring" data-state="expiring">
        <p class="mk-status-line"><b>Listing expiring — re-send</b></p>
        <p class="muted">${escapeHtml(s.exportNo)} was sent on ${escapeHtml(fmtDate(s.sentTs))}. iTred listings last 7 days, so it's due now.
          Prepare a fresh file (current prices and stock) and send it again.</p>
        <div class="mk-actions"><button class="btn btn-sm btn-primary" id="mkRefresh">Prepare a fresh file</button></div></div>`;
    }
    return `<div class="card mk-status" data-state="sent">
      <p class="mk-status-line"><span class="pill ok">Sent</span> <b>${escapeHtml(s.exportNo)}</b> · ${escapeHtml(fmtDate(s.sentTs))}</p>
      <p class="muted">${escapeHtml(counts)}. Re-send reminder on ${escapeHtml(fmtDate(s.expiresTs))}.</p>
      <div class="mk-actions"><button class="btn btn-sm btn-ghost" id="mkSend">Send again</button>${chat}</div>${note}</div>`;
  }
  function refreshStatusCard(){
    const el = document.getElementById("mkStatus");
    if(el){ el.innerHTML = statusCardHtml(); wireStatusCard(); }
  }
  // What each share outcome means for the shop, in the words the Delivery
  // Note screen already uses.
  function shareOutcomeText(r){
    if(r.method==="shared") return "Shared. If you picked WhatsApp, check it went to Digital Commerce ("+setupInfo.marketWhatsApp+"), then tap “I've sent it”.";
    if(r.method==="cancelled") return "Sharing was cancelled. Nothing was sent.";
    if(r.method==="saved-folder") return "Saved to "+r.path+". The folder and a WhatsApp chat with Digital Commerce have been opened: attach the file there, send it, then tap “I've sent it”.";
    return "This device can't share files directly, so the file was downloaded. Tap Open WhatsApp chat, then attach (📎) → Document and pick the file from your Downloads. Tap “I've sent it” once it's sent.";
  }
  function wireStatusCard(){
    const send = document.getElementById("mkSend");
    if(send) send.onclick = async ()=>{
      send.disabled = true;
      try{
        const r = await ask("shareExport");
        shareNote = shareOutcomeText(r);
        showChatButton = r.method==="downloaded";
      }catch(e){ shareNote = e.message; }
      refreshStatusCard();
    };
    const chat = document.getElementById("mkOpenChat");
    if(chat) chat.onclick = ()=>{ ask("openWhatsAppChat").catch(()=>{}); };
    const sent = document.getElementById("mkMarkSent");
    if(sent) sent.onclick = async ()=>{
      sent.disabled = true;
      try{ status = await ask("markSent"); shareNote = ""; showChatButton = false; }
      catch(e){ shareNote = e.message; }
      refreshStatusCard();
    };
    const fresh = document.getElementById("mkRefresh");
    if(fresh) fresh.onclick = async ()=>{
      await flushSelection();
      screen = selected.size? "export" : "picker"; render();
    };
  }

  // ---- photos: any stored product image -> exactly 200x200 WebP ----
  // Whole photo kept (fit inside, not cropped) and centred on white, so a
  // tall bottle or a wide pack isn't cut off. Sequential, one photo in
  // memory at a time, so a 200-product export doesn't spike a cheap phone.
  const IMG_SIZE = 200, IMG_QUALITY = 0.8;
  let _webp = null;
  function canEncodeWebP(){
    if(_webp===null){
      try{ const c = document.createElement("canvas"); c.width = c.height = 1; _webp = c.toDataURL("image/webp").indexOf("data:image/webp")===0; }
      catch(e){ _webp = false; }
    }
    return _webp;
  }
  function optimizeImage(dataUri){
    return new Promise(resolve=>{
      if(!dataUri || !canEncodeWebP()) return resolve(null);
      const img = new Image();
      const timer = setTimeout(()=>resolve(null), 8000);
      img.onerror = ()=>{ clearTimeout(timer); resolve(null); };
      img.onload = ()=>{
        clearTimeout(timer);
        try{
          const c = document.createElement("canvas"); c.width = c.height = IMG_SIZE;
          const g = c.getContext("2d");
          g.fillStyle = "#fff"; g.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
          const scale = Math.min(IMG_SIZE/img.width, IMG_SIZE/img.height);
          const w = img.width*scale, h = img.height*scale;
          g.imageSmoothingQuality = "high";
          g.drawImage(img, (IMG_SIZE-w)/2, (IMG_SIZE-h)/2, w, h);
          const out = c.toDataURL("image/webp", IMG_QUALITY);
          resolve(out.indexOf("data:image/webp;base64,")===0? out : null);
        }catch(e){ resolve(null); }
      };
      img.src = dataUri;
    });
  }

  // ---- export screen ----
  function renderExport(){
    const s = setupInfo;
    const chosen = products.filter(p=>selected.has(p.id));
    const noPhoto = chosen.filter(p=>!p.hasImage).length;
    const needsCity = !s.city, needsCurrency = !s.currencySet;
    $root.innerHTML = `
      <button class="btn btn-sm btn-ghost" id="mkBack">← Back to products</button>
      <div class="card" style="margin-top:10px">
        <p style="margin-top:0"><b>Your shop on iTred</b></p>
        <table class="simple mk-idtable">
          <tr><td class="muted">Business name</td><td>${escapeHtml(s.businessName||"—")}</td></tr>
          <tr><td class="muted">WhatsApp number</td><td>${escapeHtml(s.whatsappNumber||"—")}</td></tr>
          <tr><td class="muted">Install ID</td><td>${escapeHtml(s.installId||"—")}</td></tr>
          ${needsCity? "" : `<tr><td class="muted">City</td><td>${escapeHtml(s.city)} <button class="mk-link" data-edit="city">Change</button></td></tr>`}
          ${needsCurrency? "" : `<tr><td class="muted">Currency</td><td>${escapeHtml(s.currency)} <button class="mk-link" data-edit="currency">Change</button></td></tr>`}
        </table>
        ${s.whatsappNumber? "" : `<p class="mk-warn">No contact number is set, so customers won't see a WhatsApp number. Add one in More → Settings (Contact number).</p>`}
        <div id="mkCityField" style="display:${needsCity?"block":"none"}">
          <label for="mkCity">City or town</label>
          <input class="field" id="mkCity" maxlength="60" placeholder="e.g. Harare" value="${escapeHtml(s.city||"")}">
        </div>
        <div id="mkCurrencyField" style="display:${needsCurrency?"block":"none"}">
          <label for="mkCurrency">Currency of your prices (3-letter code)</label>
          <input class="field" id="mkCurrency" maxlength="3" autocapitalize="characters" value="${escapeHtml(s.currency||"USD")}">
          <p class="muted" style="margin:4px 0 0">Saved for next time. e.g. USD, ZWG, ZAR.</p>
        </div>
      </div>
      <div class="card">
        <p style="margin:0"><b>${chosen.length}</b> product${chosen.length===1?"":"s"} selected${noPhoto? ` · ${noPhoto} without a photo` : ""}.</p>
        ${canEncodeWebP()? "" : `<p class="mk-warn">This browser can't make WebP photos, so the file will go without photos. Use Chrome for photos.</p>`}
        <p class="muted" style="margin-bottom:0">Photos are resized to 200×200 on this device. Name, price, category and stock come from your Products list as they are right now.</p>
      </div>
      <p class="mk-warn" id="mkExportError" style="display:none"></p>
      <div id="mkProgress" class="muted" style="margin:0 2px 10px"></div>
      <button class="btn btn-primary" id="mkPrepare">Prepare file</button>`;
    document.getElementById("mkBack").onclick = ()=>{ screen = "picker"; render(); };
    $root.querySelectorAll("[data-edit]").forEach(b=> b.onclick = ()=>{
      document.getElementById(b.dataset.edit==="city"? "mkCityField" : "mkCurrencyField").style.display = "block";
      b.remove();
    });
    const cur = document.getElementById("mkCurrency");
    cur.oninput = ()=>{ const v = cur.value.toUpperCase().replace(/[^A-Z]/g,""); if(v!==cur.value) cur.value = v; };
    document.getElementById("mkPrepare").onclick = prepareExport;
  }

  async function prepareExport(){
    if(busy) return;
    const err = document.getElementById("mkExportError");
    const prog = document.getElementById("mkProgress");
    const btn = document.getElementById("mkPrepare");
    const city = document.getElementById("mkCity").value.trim();
    const currency = document.getElementById("mkCurrency").value.trim().toUpperCase();
    err.style.display = "none";
    if(!city){ err.textContent = "Enter the city or town your shop is in."; err.style.display = "block"; return; }
    if(!/^[A-Z]{3}$/.test(currency)){ err.textContent = "Currency must be a 3-letter code, e.g. USD."; err.style.display = "block"; return; }
    busy = true; btn.disabled = true;
    try{
      await flushSelection();
      const chosen = products.filter(p=>selected.has(p.id));
      const images = {};
      const withPhoto = chosen.filter(p=>p.hasImage);
      for(let i=0;i<withPhoto.length;i++){
        prog.textContent = "Resizing photos… "+(i+1)+" of "+withPhoto.length;
        const src = await ask("getProductImage", { id: withPhoto[i].id });
        const out = await optimizeImage(src);
        if(out) images[withPhoto[i].id] = out;
      }
      prog.textContent = "Building the file…";
      status = await ask("buildExport", { city, currency, images });
      setupInfo = await ask("getExportSetup");
      shareNote = ""; showChatButton = false;
      screen = "picker"; render();
    }catch(e){
      prog.textContent = "";
      err.textContent = e.message; err.style.display = "block";
    }finally{
      busy = false;
      const b = document.getElementById("mkPrepare"); if(b) b.disabled = false;
    }
  }

  function render(){ if(screen==="export") renderExport(); else renderPicker(); }

  function renderStandalone(){
    $root.innerHTML = `
      <div class="card">
        <p style="margin-top:0"><b>seiGEN Marketing add-on</b></p>
        <p class="muted" style="margin-bottom:0">This file adds the Marketing tab to seiGEN Commerce Lite. Put it in the same folder as the app,
          then open the app and tap Marketing. It does nothing when opened on its own.</p>
      </div>`;
  }
  function renderError(msg){
    $root.innerHTML = `<div class="card"><p style="margin-top:0"><b>Marketing couldn't load.</b></p><p class="muted" style="margin-bottom:0">${escapeHtml(msg)}</p></div>`;
  }

  async function start(){
    if(!inCoreApp){ renderStandalone(); return; }
    post({ type:"hello", bridgeVersion:BRIDGE_VERSION });
    await welcome;
    try{
      ctx = await ask("context");
      if(ctx.bridgeVersion!==BRIDGE_VERSION){
        renderError("This Marketing add-on doesn't match this version of the app ("+ctx.appVersion+"). Ask Digital Commerce for the matching add-on.");
        return;
      }
      const [list, sel, st, setup] = await Promise.all([ask("listProducts"), ask("getSelection"), ask("getStatus"), ask("getExportSetup")]);
      products = list;
      selected = new Set(sel);
      status = st;
      setupInfo = setup;
      render();
    }catch(e){
      renderError(e.message);
    }
  }
  start();
})();
