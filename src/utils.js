  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

  // Shared "any-order" search match: every whitespace-separated token in
  // the query must appear somewhere in the combined searchable text,
  // regardless of what order they were typed in — so "small metal" and
  // "metal small" match the same item. Originally lived only inside
  // pos.js's searchProducts(); factored out here so every search box in
  // the app (product search, and the five list-filter search boxes) shares
  // exactly one implementation of this rule instead of each reimplementing it.
  function matchesAnyOrder(query, searchableText){
    const q = (query||"").trim().toLowerCase();
    if(!q) return true;
    const hay = (searchableText||"").toLowerCase();
    return q.split(/\s+/).every(t=> hay.includes(t));
  }

  // Small outline SVG icons (stroke="currentColor" so they pick up the
  // button's own color, e.g. orange on btn-outline) used in place of
  // text labels on compact action buttons.
  const ICON_EDIT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
  const ICON_ADD  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  const ICON_GEN  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg>`;
  const ICON_DOTS = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`;
  // Same storefront mark used for the app icon/favicon — reused faintly as
  // the placeholder thumbnail for products with no uploaded photo.
  const ICON_STOREFRONT = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2 9 L4 4 L20 4 L22 9 Z"/><path d="M3 9 L3 21 L21 21 L21 9"/><path d="M9 21 L9 13.5 L15 13.5 L15 21"/></svg>`;
  const ICON_UPLOAD = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
  const ICON_DISPATCH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h13"/><path d="M12 5l7 7-7 7"/></svg>`;
  const ICON_ADJUST = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="12" y2="7"/><line x1="8" y1="3" x2="8" y2="11"/><line x1="14" y1="17" x2="22" y2="17"/></svg>`;
  const ICON_RECEIVE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12h-6l-2 3h-2l-2-3H3"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`;
  const ICON_TEMPLATE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 17 15 14"/></svg>`;

  // Bottom nav icons — sized in em (not a fixed px like the ICON_* above)
  // so they inherit .navbar button .ic's own font-size and keep the exact
  // same 17px/68px responsive sizing that emoji glyphs used to pick up
  // from that same font-size. Replaced the emoji here because Windows
  // renders certain color-emoji glyphs (🛍️📦🤝📊) with a stray black
  // outline baked into the glyph at the 68px desktop size — an OS/font
  // rendering artifact, not fixable via CSS. stroke="currentColor" also
  // means these now correctly tint orange on the active tab, which the
  // emoji never did.
  const ICON_NAV_SELL = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`;
  const ICON_NAV_PRODUCTS = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg>`;
  const ICON_NAV_CREDIT = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 12 8 9a2 2 0 0 0-3 3l4 4"/><path d="M9.5 15.5 7 18a1.5 1.5 0 0 1-2.5-1.7"/><path d="m13 12 3-3a2 2 0 0 1 3 3l-4 4"/><path d="m14.5 15.5 2.5 2.5a1.5 1.5 0 0 0 2.5-1.7"/><path d="m11 12 2 2"/></svg>`;
  const ICON_NAV_REPORTS = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="20" x2="6" y2="15"/><line x1="12" y1="20" x2="12" y2="9"/><line x1="18" y1="20" x2="18" y2="4"/></svg>`;
  const ICON_NAV_MORE = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`;

  function skuNameCell(sku,name){
    return `<div style="font-weight:800;color:#E8590C;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px">${escapeHtml(sku||"—")}</div>`
      + `<div style="font-size:10.5px;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px">${escapeHtml(name)}</div>`;
  }
  // Same stacked SKU/name layout as skuNameCell, but for on-screen tables:
  // uses the app's CSS variables instead of skuNameCell's print-only hex colors.
  function skuNameCellScreen(sku,name){
    return `<div class="psku">${escapeHtml(sku||"—")}</div>`
      + `<div style="font-size:12px;color:var(--ink-soft)">${escapeHtml(name)}</div>`;
  }

  function shareWhatsApp(text, phone){
    window.open(phone? waLink(phone,text) : ("https://wa.me/?text=" + encodeURIComponent(text)), "_blank");
  }
  // Formats a receipt-style message as 80-column monospace text, wrapped in
  // WhatsApp's ``` monospace markers so item names and amounts line up.
  function padLine(left, right, width){
    width = width||80;
    left=String(left); right=String(right);
    const gap = Math.max(1, width-left.length-right.length);
    return left + " ".repeat(gap) + right;
  }
  function receiptText(title, itemLines, totalLines){
    const bar = "-".repeat(80);
    let out = title+"\n"+bar+"\n";
    itemLines.forEach(l=> out+=l+"\n");
    out += bar+"\n";
    totalLines.forEach(l=> out+=l+"\n");
    return "```\n"+out+"```";
  }

  function dateRangeSQL(fromId, toId){
    const from = document.getElementById(fromId).value;
    const to = document.getElementById(toId).value;
    return { fromTs: from+"T00:00:00", toTs: to+"T23:59:59" };
  }
  function listBranches(){
    const rows = all(`SELECT branch FROM products WHERE branch<>''
      UNION SELECT branch FROM sales WHERE branch<>''
      UNION SELECT branch FROM eod_sessions WHERE branch<>''
      ORDER BY branch`);
    return rows.map(r=>r.branch);
  }

  function sanitizeFilenamePart(s){ return String(s).replace(/[\\/:*?"<>|]/g,"-"); }
  // Shared filename convention for every exported .sqlite file — Settings
  // Export, the WhatsApp share button, and the dispatch auto-export all
  // use this so a file's origin and moment are unambiguous at a glance.
  function exportFilename(baseName, branch){
    const date = new Date();
    const d = date.toISOString().slice(0,10);
    const t = date.toTimeString().slice(0,8).replace(/:/g,'-');
    return `${baseName}-${sanitizeFilenamePart(branch)}-${d}-${t}.sqlite`;
  }

  // Filename convention for exported data files, Excel item lists and app
  // logs, so whoever receives one can tell what it is, its document number,
  // where it was saved from, what it covers, and when:
  //   EXP0007_DataExport_From-Main_For-IVO_19Sep26-0341PM.sqlite
  // Numbers come from the same per-branch counters as DN/GRV (docnum.js), so
  // they survive a Replace and never repeat on a device.
  const scopeLabel = (scope)=> (!scope || scope==="*")? "AllBranches" : scope;
  function docFilename({type, prefix, ext, scope, period}){
    const d = new Date();
    const no = reserveDocNumber(prefix).text;
    persist();
    const parts = [no, type, "From-"+sanitizeBranchName(currentBranch())];
    if(scope!==undefined) parts.push("For-"+sanitizeBranchName(scopeLabel(scope)));
    if(period) parts.push(period);
    parts.push(fileDatePart(d)+"-"+fileTimePart(d));
    return parts.join("_")+"."+ext;
  }

  // Small anchored pop-up menu (the ⋮ buttons). items: [{label, fn}].
  function showMenu(anchor, items){
    document.querySelectorAll(".popmenu").forEach(m=>m.remove());
    const m = document.createElement("div");
    m.className = "popmenu";
    m.innerHTML = items.map((it,i)=>`<button data-mi="${i}">${it.label}</button>`).join("");
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = Math.max(8, Math.min(r.bottom+4, window.innerHeight-m.offsetHeight-8))+"px";
    m.style.left = Math.max(8, Math.min(r.right-m.offsetWidth, window.innerWidth-m.offsetWidth-8))+"px";
    const close = ()=>{ m.remove(); document.removeEventListener("click", outside, true); };
    const outside = (e)=>{ if(!m.contains(e.target)){ close(); if(anchor.contains(e.target)) e.stopPropagation(); } };
    setTimeout(()=>document.addEventListener("click", outside, true), 0);
    m.querySelectorAll("[data-mi]").forEach(b=> b.onclick=()=>{ close(); items[+b.dataset.mi].fn(); });
  }

  // ---------------- modal ----------------
  function openModal(title, bodyHtml){
    const wrap = document.createElement("div");
    wrap.className="modalOverlay";
    wrap.innerHTML = `<div class="modal-card"><div class="modal-head"><h3 style="margin:0">${escapeHtml(title)}</h3><button class="close-x" data-modal-close>✕</button></div><div class="modal-body">${bodyHtml}</div></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector("[data-modal-close]").onclick=()=>wrap.remove();
    wrap.addEventListener("click",(e)=>{ if(e.target===wrap) wrap.remove(); });
    return wrap;
  }

