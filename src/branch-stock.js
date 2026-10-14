  // ================== Stock by branch (Branches B1) ==================
  // docs/branches/multi-branch-visibility-design.md §1, §2, §6; server side:
  // supabase/migrations/20261024120000_branch_stock.sql.
  //
  // Each registered till sends its OWN stock levels to seiGEN (absolute
  // figures: the next push simply overwrites, so nothing ever counts twice)
  // and reads every branch's figures back. A branch's stock is the SUM of its
  // active tills (owner, 2026-10-13: option 1); main-branch tills also see
  // each till's own figure and a warning when two tills look like copies of
  // the same stock list. Remote tills see quantities only. No cost ever
  // travels: main values other branches' stock with its own costs.
  //
  // Only reads this till's products: nothing here changes a till's own
  // numbers. The copies (br_stock, bs_sent) are local only; mergeDatabase
  // never reads them.
  //
  // Only for a business with 2 or more active tills (the server decides and
  // says so; a single-till shop sends nothing, and asks again every 6 hours).
  // Not on a shared-stock till: its branch's figure is already on seiGEN.

  const BS_DEBOUNCE_MS = 60*1000;            // after a stock change
  const BS_POLL_MS = 5*60*1000;              // while the app is open
  const BS_FULL_EVERY_MS = 24*3600*1000;     // all products, so deleted ones go
  const BS_RECHECK_MS = 6*3600*1000;         // a single-till business: ask again
  const BS_MAX_ROWS = 5000;                  // per call (the server's limit)

  function bsRegistered(){
    return typeof isTerminalRegistered==="function" && isTerminalRegistered()
      && !(typeof isTerminalInactive==="function" && isTerminalInactive());
  }
  // This till sends its figures (registered, switched on, not shared stock).
  function bsCanPush(){ return bsRegistered() && !(typeof sharedStockTill==="function" && sharedStockTill()); }
  const bsKeyOf = (p)=> p.cat_uid? String(p.cat_uid) : (p.uid? "local:"+p.uid : "");
  const bsSig = (r)=> [r.qty, r.name, r.code, r.low, r.cat_uid||""].join("|");
  const bsMyBranchUuid = ()=> getSetting("branch_uuid","");
  const bsCostsVisible = ()=> !isRemote();

  // ---- sending this till's figures ----
  function bsLocalRows(){
    return all("SELECT id, uid, cat_uid, sku, name, stock, low_threshold FROM products WHERE branch=? AND COALESCE(active,1)=1 ORDER BY id",[currentBranch()])
      .map(p=>({ k:bsKeyOf(p), cat_uid:p.cat_uid||null, code:String(p.sku||"").slice(0,64), name:String(p.name||"").trim().slice(0,120)||"?",
        qty:Number(p.stock)||0, low:Math.max(0, Number(p.low_threshold)||0) }))
      .filter(r=>r.k);
  }
  let _bsPushing = null;
  // o.full: send every product (the server drops this till's others). -> { ok, sent?, enabled?, skipped? }
  function bsPush(o){
    if(_bsPushing) return _bsPushing;
    _bsPushing = (async ()=>{
      o = o || {};
      if(!bsCanPush()) return { ok:false, skipped:"not a sending till" };
      if(!isOnline()) return { ok:false, skipped:"offline" };
      const now = Date.now();
      if(getSetting("bs_enabled","")==="0" && !o.force && now - (Date.parse(getSetting("bs_checked_ts",""))||0) < BS_RECHECK_MS)
        return { ok:true, enabled:false, skipped:"single till" };
      const rows = bsLocalRows();
      const sent = new Map(all("SELECT product_key, sig FROM bs_sent").map(r=>[r.product_key, r.sig]));
      const full = !!o.full || !sent.size || getSetting("bs_enabled","")!=="1" || now - (Date.parse(getSetting("bs_full_ts",""))||0) > BS_FULL_EVERY_MS;
      const send = full? rows : rows.filter(r=> sent.get(r.k)!==bsSig(r));
      if(!full && !send.length) return { ok:true, sent:0 };
      const asOf = new Date().toISOString();
      const chunks = [];
      for(let i=0;i<send.length;i+=BS_MAX_ROWS) chunks.push(send.slice(i, i+BS_MAX_ROWS));
      if(!chunks.length) chunks.push([]);
      let enabled = true;
      for(let i=0;i<chunks.length;i++){
        // a full set that needs several calls can't say "these are all": the daily full push of a smaller set does
        const r = await terminalRpc("cl_device_stock_levels_push", Object.assign(terminalAuth(), { p_as_of:asOf, p_full: full && chunks.length===1, p_rows:chunks[i] }), { timeoutMs:20000 });
        if(!r.ok){
          if(typeof noteTerminalRefusal==="function") noteTerminalRefusal(r);
          setSetting("bs_error", (r.data && r.data.message) || r.message || r.code || r.reason || "");
          await persist();
          return { ok:false, message:getSetting("bs_error","") };
        }
        if(r.data && r.data.enabled===false){ enabled = false; break; }
      }
      setSetting("bs_checked_ts", asOf);
      setSetting("bs_error", "");
      if(!enabled){ setSetting("bs_enabled", "0"); await persist(); return { ok:true, enabled:false }; }
      setSetting("bs_enabled", "1");
      db.run("BEGIN");
      try{
        if(full) run("DELETE FROM bs_sent");
        send.forEach(r=> run("INSERT OR REPLACE INTO bs_sent(product_key, sig) VALUES(?,?)",[r.k, bsSig(r)]));
        db.run("COMMIT");
      }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
      setSetting("bs_pushed_ts", asOf);
      if(full) setSetting("bs_full_ts", asOf);
      await persist();
      return { ok:true, enabled:true, sent:send.length, full };
    })().finally(()=>{ _bsPushing = null; });
    return _bsPushing;
  }
  // A stock change here (moveStock, db.js): send the changed figures a minute later.
  let _bsSoonTimer = null;
  function bsSoon(){
    if(_bsSoonTimer || getSetting("bs_enabled","")!=="1" || !bsCanPush()) return;   // only once seiGEN said this business takes figures
    _bsSoonTimer = setTimeout(()=>{ _bsSoonTimer = null; bsPush().catch(()=>{}); }, BS_DEBOUNCE_MS);
    if(_bsSoonTimer && _bsSoonTimer.unref) _bsSoonTimer.unref();
  }

  // ---- reading every branch's figures ----
  // The whole answer per branch, kept as pulled ("last updated" is the server's).
  function bsBranches(){
    return all("SELECT json FROM br_stock ORDER BY is_main DESC, name").map(r=>{ try{ return JSON.parse(r.json); }catch(e){ return null; } }).filter(Boolean);
  }
  function bsOtherBranches(){ const me = bsMyBranchUuid(); return bsBranches().filter(b=>b.id!==me); }
  let _bsPulling = null;
  function bsPull(){
    if(_bsPulling) return _bsPulling;
    _bsPulling = (async ()=>{
      if(!bsRegistered()) return { ok:false, message:"This till isn't registered with seiGEN." };
      if(!isOnline()) return { ok:false, offline:true, message:"You're offline." };
      const r = await terminalRpc("cl_device_branch_stock", terminalAuth(), { timeoutMs:20000 });
      if(!r.ok){ if(typeof noteTerminalRefusal==="function") noteTerminalRefusal(r); return { ok:false, message:(r.data && r.data.message) || r.message || r.code || r.reason }; }
      const d = r.data || {};
      const ts = new Date().toISOString();
      db.run("BEGIN");
      try{
        run("DELETE FROM br_stock");
        (d.branches||[]).forEach(b=> run("INSERT INTO br_stock(branch_id,name,is_main,json,pulled_ts) VALUES(?,?,?,?,?)",[b.id, b.name, b.is_main?1:0, JSON.stringify(b), ts]));
        db.run("COMMIT");
      }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
      setSetting("bs_pulled_ts", ts);
      setSetting("bs_server_enabled", d.enabled? "1" : "0");
      // the branch list from the same answer (joining fix: every joined branch, at once)
      if(Array.isArray(d.branches) && d.branches.length){
        setSetting("ds_branches", JSON.stringify(d.branches.map(b=>({ id:b.id, name:b.name, is_main:!!b.is_main }))));
        setSetting("ds_branches_ts", ts);
      }
      await persist();
      return { ok:true, enabled:!!d.enabled, branches:(d.branches||[]).length };
    })().finally(()=>{ _bsPulling = null; });
    return _bsPulling;
  }
  // The business's dispatches, without costs (Other branches → Dispatches).
  async function bsPullDispatches(){
    if(!bsRegistered() || !isOnline()) return { ok:false, offline:!isOnline() };
    const r = await terminalRpc("cl_device_business_dispatches", Object.assign(terminalAuth(), { p_days:30 }), { timeoutMs:20000 });
    if(!r.ok) return { ok:false, message:(r.data && r.data.message) || r.message || r.code || r.reason };
    setSetting("bs_dispatches", JSON.stringify(r.data.dispatches||[]));
    setSetting("bs_dispatches_ts", new Date().toISOString());
    await persist();
    return { ok:true, count:(r.data.dispatches||[]).length };
  }
  function bsDispatches(){ try{ return JSON.parse(getSetting("bs_dispatches","[]"))||[]; }catch(e){ return []; } }

  // After a check-in, on reconnect and every 5 minutes: the branch list
  // (every joined branch: the joining fix), this till's figures, everyone's.
  async function bsAfterCheckin(){
    if(!bsRegistered()) return;
    await bsPush().catch(()=>{});
    await bsPull().catch(()=>{});
  }
  let _bsTimer = null;
  function startBranchStock(){
    if(_bsTimer) return;
    _bsTimer = setInterval(()=>{ if(bsRegistered()) bsPush().catch(()=>{}); }, BS_POLL_MS);
    if(typeof window!=="undefined" && window.addEventListener) window.addEventListener("online", ()=>{ bsAfterCheckin().catch(()=>{}); });
  }

  // ---- matching and sums ----
  const bsNorm = (s)=> String(s||"").trim().toLowerCase();
  // A branch's row for one of this till's products: catalogue uid, then code, then exact name.
  function bsRowFor(branch, p){
    const rows = branch.rows || [];
    if(p.cat_uid){ const r = rows.find(x=>x.cat_uid===p.cat_uid || x.k===p.cat_uid); if(r) return r; }
    if(bsNorm(p.sku)){ const r = rows.filter(x=>bsNorm(x.code)===bsNorm(p.sku)); if(r.length===1) return r[0]; }
    const n = rows.filter(x=>bsNorm(x.name)===bsNorm(p.name));
    return n.length===1? n[0] : null;
  }
  // The other branches' total for one product, or null when no other branch has it.
  function bsOtherQty(p){
    let total = null;
    bsOtherBranches().forEach(b=>{ const r = bsRowFor(b, p); if(r) total = (total||0) + Number(r.qty||0); });
    return total;
  }
  // Main only: two tills of a branch whose figures are the same for most products
  // they both hold (at least 5, 80% or more of those with stock) look like copies
  // of the same stock list, so the sum may count them twice. -> [{ a, b, same, of }]
  function bsCopies(branch){
    const tills = (branch.tills||[]).filter(t=>t.active).map(t=>t.till_code);
    const out = [];
    for(let i=0;i<tills.length;i++) for(let j=i+1;j<tills.length;j++){
      let both = 0, same = 0;
      (branch.rows||[]).forEach(r=>{
        const t = r.t||{}, a = t[tills[i]], b = t[tills[j]];
        if(a==null || b==null || (a===0 && b===0)) return;
        both++; if(a===b) same++;
      });
      if(both>=5 && same/both>=0.8) out.push({ a:tills[i], b:tills[j], same, of:both });
    }
    return out;
  }
  // Main only: a branch's stock valued at main's own cost (products it can match). -> { value, matched, unmatched }
  function bsValueAtCost(branch){
    const mine = all("SELECT cat_uid, sku, name, cost FROM products WHERE branch=?",[currentBranch()]);
    const byCat = new Map(mine.filter(p=>p.cat_uid).map(p=>[p.cat_uid, p]));
    const byCode = new Map(); mine.forEach(p=>{ const c = bsNorm(p.sku); if(c) byCode.set(c, byCode.has(c)? null : p); });
    let value = 0, matched = 0, unmatched = 0;
    (branch.rows||[]).forEach(r=>{
      const p = (r.cat_uid && byCat.get(r.cat_uid)) || byCode.get(bsNorm(r.code)) || null;
      if(p){ matched++; if(r.qty>0) value += r.qty*(Number(p.cost)||0); } else unmatched++;
    });
    return { value:Math.round(value*100)/100, matched, unmatched };
  }
  // "updated 14:05" / "updated 12 Oct 14:05"; old: more than a day ago.
  function bsUpdatedText(ts){
    if(!ts) return { text:"no figures yet", old:true };
    const d = new Date(ts), now = new Date();
    const hm = d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
    const sameDay = d.toDateString()===now.toDateString();
    return { text:"updated "+(sameDay? hm : d.toLocaleDateString([], { day:"numeric", month:"short" })+" "+hm), old: now - d > 24*3600*1000 };
  }
  // Products: the "Other branches" column (main, registered, a business with other branches).
  function bsShowOtherColumn(){ return !isRemote() && bsRegistered() && bsOtherBranches().length>0; }
  // More → Stock by branch / Other branches: a registered till of a business with 2+ branches.
  function bsTabAvailable(){
    if(!bsRegistered()) return false;
    let ds = []; try{ ds = JSON.parse(getSetting("ds_branches","[]"))||[]; }catch(e){}
    return ds.length>1 || bsBranches().length>1;
  }
  // The Product List's extra branch choices: joined branches with no local rows here.
  function bsJoinedOnlyBranchNames(local){
    const have = (local||[]).map(bsNorm);
    return bsBranches().filter(b=>!have.includes(bsNorm(b.name))).map(b=>b.name);
  }
  function bsBranchByName(name){ return bsBranches().find(b=>sameBranchName(b.name, name)) || null; }

  // ---- screens ----
  function bsCellHtml(p){
    const q = bsOtherQty(p);
    return `<button type="button" class="btn btn-sm btn-ghost bs-other" data-bsprod="${p.id}" title="Each branch's stock">${q==null? "—" : escapeHtml(String(q))}</button>`;
  }
  function wireBsCells(scope){
    scope.querySelectorAll("[data-bsprod]").forEach(b=> b.onclick=()=>{ const p = one("SELECT * FROM products WHERE id=?",[+b.dataset.bsprod]); if(p) openBsProductModal(p); });
  }
  // One product in every branch: the branch total, its time and (main) each till's own figure.
  function openBsProductModal(p){
    const main = !isRemote();
    const rows = bsBranches().map(b=>{
      const r = bsRowFor(b, p), u = bsUpdatedText(b.updated_at);
      const tills = main && r && r.t? Object.keys(r.t).sort().map(k=>`<div class="pmeta bs-till">${escapeHtml(k)} (own count): ${escapeHtml(String(r.t[k]))}</div>`).join("") : "";
      return `<div class="card bs-branch" style="padding:8px;margin-bottom:6px">
        <div style="display:flex;justify-content:space-between;gap:8px"><b>${escapeHtml(b.name)}${b.id===bsMyBranchUuid()? " (this branch)" : ""}</b><b>${r? escapeHtml(String(r.qty)) : "—"}</b></div>
        <div class="pmeta" style="${u.old? "color:#b54708" : ""}">${escapeHtml(b.stock_mode==="shared"? "Shared stock on seiGEN · "+u.text : u.text)}</div>${tills}</div>`;
    }).join("");
    openModal(p.name, `${rows || `<p class="muted">No branch figures yet. They arrive after the tills check in.</p>`}
      <p class="muted" style="font-size:12px">A branch's stock is the sum of its tills.${main? "" : " Quantities only."}</p>`);
  }

  function renderBranchStock(main){
    const isMain = !isRemote();
    let tab = getSetting("bs_tab","stock"), branchSel = getSetting("bs_branch",""), query = "", msg = "";
    function stockHtml(){
      const mineId = bsMyBranchUuid();
      const list = isMain? bsBranches() : bsOtherBranches();
      if(getSetting("bs_server_enabled","")==="0") return `<div class="box">Stock by branch needs 2 or more tills in the business. A business with one till keeps its stock on that till only.</div>`;
      if(!list.length) return `<p class="muted">No branch figures yet. Tap Refresh when you're online; each till sends its stock after it checks in.</p>`;
      const shown = branchSel? list.filter(b=>b.id===branchSel) : list;
      // one line per product across the branches: the same catalogue uid, else the same code, else the same name
      const names = new Map(), byCat = new Map(), byCode = new Map(), byName = new Map();
      shown.forEach(b=>(b.rows||[]).forEach(r=>{
        const c = bsNorm(r.code), n = bsNorm(r.name);
        const k = (r.cat_uid && byCat.get(r.cat_uid)) || (c && byCode.get(c)) || (!c && byName.get(n)) || (r.cat_uid || (c? "c:"+c : "n:"+n));
        if(!names.has(k)) names.set(k, { name:r.name, code:r.code, cat_uid:r.cat_uid });
        if(r.cat_uid) byCat.set(r.cat_uid, k); if(c) byCode.set(c, k); else byName.set(n, k);
      }));
      const q = bsNorm(query);
      const items = [...names.entries()].filter(([,v])=> !q || bsNorm(v.name).includes(q) || bsNorm(v.code).includes(q)).sort((a,b)=>String(a[1].name).localeCompare(String(b[1].name)));
      const qtyOf = (b, v)=> bsRowFor(b, { cat_uid:v.cat_uid, sku:v.code, name:v.name });
      const heads = shown.map(b=>{ const u = bsUpdatedText(b.updated_at); return `<th class="bs-col">${escapeHtml(b.name)}${b.id===mineId? " (this)" : ""}<div class="pmeta" style="font-weight:400;${u.old? "color:#b54708" : ""}">${escapeHtml(u.text)}</div></th>`; }).join("");
      const warn = isMain? shown.map(b=>bsCopies(b).map(c=>`<div class="box bs-copies" style="margin-bottom:8px;border-color:#b54708;background:#fffaeb;color:#b54708;font-size:12.5px"><b>${escapeHtml(b.name)}: ${escapeHtml(c.a)} and ${escapeHtml(c.b)} look like copies of the same stock list</b> (${c.same} of ${c.of} products show the same figure). The branch total may count those products twice. Count the stock (Stocktake) on one of them.</div>`).join("")).join("") : "";
      const value = isMain && bsCostsVisible()? `<div class="muted bs-value" style="margin-top:8px;font-size:12.5px">${shown.map(b=>{ const v = bsValueAtCost(b); return escapeHtml(b.name)+": value at cost "+escapeHtml(currency+v.value.toFixed(2))+(v.unmatched? " ("+v.unmatched+" product"+(v.unmatched===1?"":"s")+" without a cost here)" : ""); }).join("<br>")}</div>` : "";
      const tillsLine = (b)=> isMain && b.tills && b.tills.length>1? `<div class="muted bs-tilltimes" style="font-size:12.5px">${escapeHtml(b.name)}: ${b.tills.filter(t=>t.active).map(t=>escapeHtml(t.till_code)+" "+escapeHtml(bsUpdatedText(t.pushed_at).text)).join(" · ")}</div>` : "";
      return `${warn}
        <div style="overflow-x:auto"><table class="simple bs-grid"><tr><th>Item</th>${heads}</tr>
        ${items.length? items.map(([,v])=>`<tr><td>${v.code? `<div class="psku">${escapeHtml(v.code)}</div>` : ""}${escapeHtml(v.name)}</td>${shown.map(b=>{
            const r = qtyOf(b, v);
            const t = isMain && r && r.t && Object.keys(r.t).length>1? `<div class="pmeta bs-tills">${Object.keys(r.t).sort().map(k=>escapeHtml(k)+": "+escapeHtml(String(r.t[k]))).join(" · ")}</div>` : "";
            const low = r && r.qty<=(r.low||0);
            return `<td class="bs-col${low? " stock-low" : ""}">${r? escapeHtml(String(r.qty)) : "—"}${t}</td>`; }).join("")}</tr>`).join("")
          : `<tr><td colspan="${shown.length+1}" class="muted">No products match.</td></tr>`}
        </table></div>
        ${shown.map(tillsLine).join("")}${value}
        <p class="muted" style="font-size:12px">A branch's stock is the sum of its tills' own figures${isMain? "; under it, each till's own count" : ""}. Quantities only${isMain? "" : ": costs are kept on the main branch"}.</p>`;
    }
    function dispatchesHtml(){
      const rows = bsDispatches();
      if(!rows.length) return `<p class="muted">No dispatches through seiGEN in the last 30 days.</p>`;
      return rows.map(d=>{
        const units = (d.lines||[]).reduce((s,l)=>s+(Number(l.qty)||0),0);
        const diffs = (d.lines||[]).filter(l=>l.short||l.damaged||l.extra).map(l=>escapeHtml(l.name)+": "+[l.short? "short "+l.short : "", l.damaged? "damaged "+l.damaged : "", l.extra? "extra "+l.extra : ""].filter(Boolean).join(", ")).join(" · ");
        return `<div class="card bs-dispatch" style="padding:10px;margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:8px"><b>${escapeHtml(d.dn_display)}</b><span style="font-size:12px;font-weight:700">${escapeHtml(typeof dsStatusText==="function"? dsStatusText(d.status) : d.status)}</span></div>
          <div class="pmeta">${escapeHtml(d.from_branch)} → ${escapeHtml(d.to_branch)} · ${escapeHtml(new Date(d.sent_at).toLocaleString())}</div>
          <div class="pmeta">${(d.lines||[]).length} line${(d.lines||[]).length===1?"":"s"} · ${units} unit${units===1?"":"s"}${d.grv_display? " · "+escapeHtml(d.grv_display) : ""}${d.open_issues? " · "+d.open_issues+" open difference"+(d.open_issues===1?"":"s") : ""}</div>
          ${diffs? `<div class="pmeta" style="color:#b42318">${diffs}</div>` : ""}</div>`;
      }).join("");
    }
    function draw(){
      const list = isMain? bsBranches() : bsOtherBranches();
      const pulled = getSetting(tab==="stock"? "bs_pulled_ts" : "bs_dispatches_ts","");
      main.innerHTML = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
          <button class="btn btn-sm ${tab==="stock"? "btn-primary" : "btn-outline"}" id="bsTabStock">Stock</button>
          <button class="btn btn-sm ${tab==="dispatches"? "btn-primary" : "btn-outline"}" id="bsTabDisp">Dispatches</button>
          <button class="btn btn-sm btn-outline" id="bsRefresh">🔄 Refresh</button>
          <span class="muted" id="bsStatus" style="font-size:12px">${escapeHtml(msg || (pulled? (isOnline()? "Loaded " : "Offline: the copy from ")+new Date(pulled).toLocaleString() : "Not loaded yet"))}</span>
        </div>
        ${tab==="stock"? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <select class="field" id="bsBranchSel" style="flex:1;min-width:150px;margin:0"><option value="">${isMain? "All branches" : "All other branches"}</option>${list.map(b=>`<option value="${escapeHtml(b.id)}" ${b.id===branchSel?"selected":""}>${escapeHtml(b.name)}</option>`).join("")}</select>
            <input class="field" id="bsSearch" placeholder="Search products or code…" value="${escapeHtml(query)}" style="flex:2;min-width:150px;margin:0"></div>
          <div id="bsBody">${stockHtml()}</div>` : `<div id="bsBody">${dispatchesHtml()}</div>`}`;
      main.querySelector("#bsTabStock").onclick=()=>{ tab="stock"; setSetting("bs_tab","stock"); draw(); };
      main.querySelector("#bsTabDisp").onclick=()=>{ tab="dispatches"; setSetting("bs_tab","dispatches"); draw(); if(!getSetting("bs_dispatches_ts","")) refresh(); };
      main.querySelector("#bsRefresh").onclick=()=>refresh();
      const sel = main.querySelector("#bsBranchSel");
      if(sel) sel.onchange=()=>{ branchSel = sel.value; setSetting("bs_branch", branchSel); draw(); };
      const s = main.querySelector("#bsSearch");
      if(s) s.oninput=()=>{ query = s.value; main.querySelector("#bsBody").innerHTML = stockHtml(); };
    }
    async function refresh(){
      msg = "Loading…"; draw();
      const r = tab==="stock"? await (async ()=>{ await bsPush().catch(()=>{}); return bsPull(); })() : await bsPullDispatches();
      msg = r.ok? "" : (r.offline? "You're offline: showing the last copy." : "Couldn't load: "+(r.message||""));
      draw();
    }
    draw();
    if(isOnline() && Date.now() - (Date.parse(getSetting(tab==="stock"? "bs_pulled_ts" : "bs_dispatches_ts",""))||0) > 60000) refresh();
  }
