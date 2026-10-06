  // ================== Shared branch stock (multi-terminal Phase 3b) ==================
  // Branches with more than one till can hold ONE stock count on Digital
  // Commerce. Design: docs/multi-terminal/phase3b-design.md (owner's answers §11).
  // Server: supabase/migrations/20261007120000_shared_stock.sql.
  //
  //   * Never below zero: the server checks the whole cart at once (from the
  //     branch's available pool first, then this till's own allowance) and
  //     refuses anything that would go below zero.
  //   * Offline: a till sells only from its OFFLINE ALLOWANCE, which expires
  //     on the till 72 h after it was last granted (trusted clock, eod.js).
  //     Offline sales are reported on reconnect with their sale uid, so a sale
  //     that actually went through before a timeout is never counted twice.
  //   * On a shared-stock till products.stock IS this till's allowance; the
  //     last-known branch figures are products.branch_avail / branch_total.
  //   * moveStock (db.js) stays the one choke point: on a shared-stock till,
  //     increases are queued to the branch (sellable after sync, owner Q3);
  //     decreases that can't wait take this till's allowance and the rest is
  //     settled by the server. Dispatch, manual adjustments and stocktakes ask
  //     the server first (sharedStockPreApply).
  // Single-till branches that never start shared stock, and unregistered
  // shops: nothing here runs.

  const STOCK_SALE_TIMEOUT_MS = 4000;                  // owner, Q5
  const STOCK_ALLOW_TTL_MS = 72*3600*1000;             // owner, Q2
  const SS_LOCAL_KINDS = ["sale","allowance","shared_opening","merge_out"];
  let _ssBusy = false, _ssRunning = null;
  let _ssPreApplied = null;                            // productId -> { delta } | { setTo }, set by sharedStockPreApply

  function ssRegistered(){ return !!getSetting("terminal_id",""); }
  // This till sells from shared branch stock (the branch is shared and this
  // till has joined it: any own stock it had was merged or it had none).
  function sharedStockTill(){ return ssRegistered() && getSetting("stock_mode","")==="shared" && getSetting("stock_init","")==="1"; }
  function ssNowMs(){
    try{ if(typeof evaluateTrustedTime==="function") return evaluateTrustedTime(new Date()).time.getTime(); }catch(e){}
    return Date.now();
  }
  function ssNowIso(){ return new Date(ssNowMs()).toISOString(); }
  function allowanceValidUntil(){
    const ts = getSetting("stock_allow_local_ts","");
    return ts? Date.parse(ts) + STOCK_ALLOW_TTL_MS : 0;
  }
  function allowanceValid(){ return ssNowMs() < allowanceValidUntil(); }
  function stockReachable(){ return isOnline() && getSetting("stock_reach","")!=="fail"; }
  // What the till may sell of a product right now.
  function sellableNow(p){
    if(!p) return 0;
    if(!sharedStockTill() || !p.cat_uid) return p.stock;
    const own = allowanceValid()? Math.max(0, p.stock) : 0;
    return stockReachable()? Math.max(0, p.stock) + Math.max(0, p.branch_avail||0) : own;
  }
  // "12 in branch · 3 on this till" (online) / "3 on this till (offline)".
  function stockLineText(p){
    if(!sharedStockTill() || !p.cat_uid) return null;
    const pend = p.stock_pending_in>0? " · +"+p.stock_pending_in+" pending" : "";
    if(stockReachable()) return (p.branch_total||0)+" in branch · "+Math.max(0,p.stock)+" on this till"+pend;
    return allowanceValid()? Math.max(0,p.stock)+" on this till (offline)"+pend : "Offline · allowance expired"+pend;
  }
  function ssUid(){ return typeof catNewOp==="function"? catNewOp() : Array.from(crypto.getRandomValues(new Uint8Array(16)), x=>x.toString(16).padStart(2,"0")).join(""); }
  function ssRpc(name, extra, opts){ return terminalRpc(name, Object.assign(terminalAuth(), extra||{}), opts); }
  function ssProduct(catUid){ return one("SELECT * FROM products WHERE cat_uid=? AND branch=?",[catUid, currentBranch()]); }
  function ssNote(r){
    if(!r) return;
    if(r.ok) setSetting("stock_reach","ok");
    else if(r.reason==="offline" || r.reason==="network") setSetting("stock_reach","fail");
  }
  function ssProblemText(r){
    if(r && r.code==="TERMINAL_INACTIVE") return TERMINAL_INACTIVE_TEXT;
    if(r && r.code==="NOT_SHARED") return "This branch isn't using shared stock.";
    if(typeof catProblemText==="function") return catProblemText(r).replace("sync the catalogue","update shared stock");
    return "Couldn't reach Digital Commerce.";
  }

  // ---- outbox: what this till did offline, reported on reconnect ----
  function ssQueue(kind, payload, uid){
    run("INSERT OR IGNORE INTO stock_outbox(uid,kind,payload_json,created_ts) VALUES(?,?,?,?)",[uid||ssUid(), kind, JSON.stringify(payload), new Date().toISOString()]);
  }
  function ssPending(){ return all("SELECT * FROM stock_outbox WHERE COALESCE(sent_ts,'')='' ORDER BY created_ts, uid"); }
  // Allowance this till has used locally but not yet reported, per catalogue product.
  function ssPendingTakes(){
    const m = new Map(), add = (k,v)=>m.set(k,(m.get(k)||0)+v);
    ssPending().forEach(r=>{
      const p = JSON.parse(r.payload_json);
      if(r.kind==="sale") (p.lines||[]).forEach(l=>add(l.product_uid, l.qty));
      else if(r.kind==="move" && p.delta<0) add(p.product_uid, p.from_allowance_local||0);
    });
    return m;
  }

  // ---- moveStock hook (db.js): movements other than sales on a shared-stock till ----
  // Returns undefined to let moveStock work as before, or the local delta applied.
  function sharedStockIntercept(o){
    if(o.ssLocal || SS_LOCAL_KINDS.includes(o.kind) || !sharedStockTill()) return undefined;
    const p = one("SELECT * FROM products WHERE id=?",[o.productId]);
    if(!p || !p.cat_uid) return undefined;                          // branch-only products keep local stock (owner, Q8)
    const local = (d)=> d? moveStock(Object.assign({}, o, { delta:d, setTo:undefined, ssLocal:true })) : 0;
    if(_ssPreApplied && _ssPreApplied.has(p.id)){                    // the server already did it (dispatch, adjustment, stocktake)
      const pre = _ssPreApplied.get(p.id); _ssPreApplied.delete(p.id);
      if(pre.setTo!==undefined) return moveStock(Object.assign({}, o, { delta:undefined, setTo:pre.setTo, ssLocal:true }));
      return local(pre.delta||0);
    }
    const delta = (o.setTo!==undefined && o.setTo!==null)? o.setTo - p.stock : o.delta;
    if(!delta) return 0;
    const uid = ssUid();
    if(delta>0){                                                    // owner Q3: sellable once the branch has it
      ssQueue("move", { uid, product_uid:p.cat_uid, delta, kind:o.kind||"move" }, uid);
      run("UPDATE products SET stock_pending_in=COALESCE(stock_pending_in,0)+? WHERE id=?",[delta, p.id]);
      return 0;
    }
    const takeLocal = Math.min(Math.max(0, p.stock), -delta);
    ssQueue("move", { uid, product_uid:p.cat_uid, delta, kind:o.kind||"move", from_allowance_local:takeLocal }, uid);
    return local(-takeLocal);
  }

  // ---- the server first: dispatch, manual adjustment (decreases) ----
  // lines: [{ product, delta, kind }] -> { ok, message? }. On ok the local
  // commit must follow (sharedStockCommit), or sharedStockUndo on failure.
  async function sharedStockPreApply(lines){
    const linked = lines.filter(l=>l.product && l.product.cat_uid);
    if(!sharedStockTill() || !linked.length) return { ok:true, moves:[] };
    const moves = linked.map(l=>({ uid:ssUid(), product_uid:l.product.cat_uid, delta:l.delta, kind:l.kind, productId:l.product.id }));
    const r = await ssRpc("cl_stock_move", { p_moves: moves.map(m=>({ uid:m.uid, product_uid:m.product_uid, delta:m.delta, kind:m.kind })) });
    ssNote(r);
    if(!r.ok) return { ok:false, message: (r.reason==="offline"||r.reason==="network")? "This needs a connection at a shared-stock branch. Nothing was changed." : ssProblemText(r) };
    if(!r.data.ok){
      const bad = (r.data.refused||[])[0]||{}, prod = ssProduct(bad.product_uid);
      return { ok:false, message: bad.reason==="NOT_ENOUGH"? "Only "+bad.left+" "+(prod? prod.name : "of that product")+" left in the branch. Nothing was changed." : "Digital Commerce refused this ("+(bad.reason||"unknown")+"). Nothing was changed." };
    }
    _ssPreApplied = new Map();
    (r.data.moves||[]).forEach((res,i)=>{ const m = moves[i]; if(m) _ssPreApplied.set(m.productId, { delta:-(res.from_allowance||0) }); });
    return { ok:true, moves, rows:r.data.stock||[] };
  }
  // After the local commit: the server's new figures (allowance, branch stock).
  function sharedStockDone(pre){
    _ssPreApplied = null;
    if(pre && pre.rows && pre.rows.length) ssApplyRows(pre.rows);
  }
  // The local write failed after the server took the stock: give it back.
  async function sharedStockUndo(moves){
    _ssPreApplied = null;
    if(!moves || !moves.length) return;
    const back = moves.map(m=>({ uid:ssUid(), product_uid:m.product_uid, delta:-m.delta, kind:m.kind+"_undo" }));
    const r = await ssRpc("cl_stock_move", { p_moves:back });
    if(!r.ok || !r.data.ok) back.forEach(b=>ssQueue("move", b, b.uid));            // try again with the next report
  }

  // A refusal the cashier must read: an in-app message (alert() where there's no page).
  function ssShowMessage(title, text){
    if(typeof document!=="undefined" && document.body && typeof document.createElement==="function" && typeof openModal==="function"){
      const wrap = openModal(title, `<p class="ss-refusal" style="margin:0 0 12px;white-space:pre-line;font-weight:600;color:#b42318">${escapeHtml(text)}</p><button class="btn btn-primary" id="ssOk">OK</button>`);
      wrap.querySelector("#ssOk").onclick = ()=>wrap.remove();
    } else alert(text);
  }
  // ---- checkout (pos.js completeSale) ----
  // items: [{ product_id, qty }]; commit(plan) re-enters completeSale.
  async function sharedStockCheckout(items, commit, inputs){
    if(_ssBusy) return { ok:false };
    _ssBusy = true;
    if(typeof window!=="undefined") window._stockChecking = true;
    try{
      const saleUid = ssUid();
      const byPid = new Map();
      items.forEach(i=>byPid.set(i.product_id, (byPid.get(i.product_id)||0)+i.qty));
      const linked = [...byPid.entries()].map(([pid,qty])=>({ product: one("SELECT * FROM products WHERE id=?",[pid]), qty })).filter(l=>l.product && l.product.cat_uid);
      if(!linked.length){ commit({ saleUid, alloc:{}, mode:"local", inputs }); return { ok:true }; }
      const lines = linked.map(l=>({ product_uid:l.product.cat_uid, qty:l.qty }));
      const r = await ssRpc("cl_stock_sale", { p_sale_uid:saleUid, p_lines:lines }, { timeoutMs:STOCK_SALE_TIMEOUT_MS });
      ssNote(r);
      if(r.ok && r.data.ok){
        const alloc = {};
        (r.data.lines||[]).forEach(x=>{ const l = linked.find(y=>y.product.cat_uid===x.product_uid); if(l) alloc[l.product.id] = x.from_allowance||0; });
        commit({ saleUid, alloc, mode:"online", inputs });
        ssApplyRows(r.data.stock||[]);
        await persist();
        return { ok:true };
      }
      if(r.ok && r.data.ok===false){
        const msgs = (r.data.refused||[]).map(x=>{
          const p = ssProduct(x.product_uid);
          if(p) run("UPDATE products SET branch_avail=? WHERE id=?",[Math.max(0,(x.left||0)-Math.max(0,p.stock)), p.id]);
          return x.left>0? "Only "+x.left+" "+(p? p.name : "of a product")+" left in the branch." : (p? p.name : "A product")+" is sold out at this branch.";
        });
        ssShowMessage("Not enough stock", msgs.join("\n")+"\nNothing was sold. Change the quantity and try again.");
        return { ok:false, refused:r.data.refused };
      }
      if(r.code==="TERMINAL_INACTIVE"){
        setSetting("terminal_inactive","1");
        ssShowMessage("This till is deactivated", TERMINAL_INACTIVE_TEXT+" Branch stock can't be sold from this till.");
        return { ok:false };
      }
      // Slow, unreachable or a server error: this till's own allowance only.
      setSetting("stock_reach","fail");
      if(!allowanceValid()){
        ssShowMessage("Can't sell offline", "Can't reach the server, and this till's offline allowance has expired. Connect to get a fresh allowance, then try again.");
        return { ok:false };
      }
      const short = linked.find(l=>l.qty > Math.max(0, l.product.stock));
      if(short){
        ssShowMessage("Can't sell that many offline", "Can't reach the server and this till can sell only "+Math.max(0, short.product.stock)+" "+short.product.name+" while offline. Sell fewer, or try again when connected.");
        return { ok:false };
      }
      const alloc = {};
      linked.forEach(l=>{ alloc[l.product.id] = l.qty; });
      commit({ saleUid, alloc, mode:"offline", inputs });
      ssQueue("sale", { sale_uid:saleUid, lines }, saleUid);
      await persist();
      return { ok:true, offline:true };
    } finally {
      _ssBusy = false;
      if(typeof window!=="undefined") window._stockChecking = false;
    }
  }

  // ---- applying the server's figures ----
  // rows: [{ product_uid, total, available, allowance }]. The till's own stock
  // becomes its allowance minus what it has used locally but not yet reported.
  function ssApplyRows(rows, opts){
    if(!rows || !rows.length) return 0;
    const takes = ssPendingTakes();
    let changed = 0;
    rows.forEach(r=>{
      const p = ssProduct(r.product_uid);
      if(!p) return;
      run("UPDATE products SET branch_avail=?, branch_total=? WHERE id=?",[r.available, r.total, p.id]);
      const target = Math.max(0, (r.allowance||0) - (takes.get(r.product_uid)||0));
      if(p.stock!==target){ moveStock({ productId:p.id, setTo:target, kind:"allowance", note:"This till's allowance from branch stock", ssLocal:true }); changed++; }
    });
    setSetting("stock_allow_local_ts", ssNowIso());
    return changed;
  }

  // ---- one stock sync: report what happened offline, then refresh ----
  async function stockSyncNow(opts){
    opts = opts||{};
    if(!ssRegistered()) return { ok:false, message:"Register this device first." };
    if(_ssRunning) return _ssRunning;
    _ssRunning = (async()=>{
      try{
        await ssReportLocalProducts();
        if(sharedStockTill()){
          const rep = await ssReportOutbox();
          if(!rep.ok){ setSetting("stock_last_error", ssProblemText(rep)); return { ok:false, message:ssProblemText(rep) }; }
        }
        const full = getSetting("stock_mode","")!=="shared" || getSetting("stock_init","")!=="1";
        const r = await ssRpc("cl_stock_sync", { p_cursor: full? 0 : Number(getSetting("stock_cursor","0"))||0 });
        ssNote(r);
        if(!r.ok){
          if(r.code==="TERMINAL_INACTIVE") setSetting("terminal_inactive","1");
          setSetting("stock_last_error", ssProblemText(r)); return { ok:false, message:ssProblemText(r) };
        }
        const d = r.data;
        setSetting("stock_mode", d.stock_mode); setSetting("stock_holder", d.is_holder? "1" : ""); setSetting("stock_active_tills", String(d.active_tills||0));
        setSetting("stock_last_error","");
        if(d.stock_mode!=="shared"){ await persist(); return { ok:true, mode:"local" }; }
        if(getSetting("stock_init","")!=="1"){
          const own = all("SELECT * FROM products WHERE branch=? AND cat_uid IS NOT NULL AND stock>0",[currentBranch()]);
          if(own.length){ await persist(); return { ok:true, mode:"shared", needsMerge:true, rows:own }; }
          setSetting("stock_init","1");
        }
        db.run("BEGIN");
        try{
          ssApplyRows(d.stock||[]);
          setSetting("stock_allow_local_ts", ssNowIso());              // the server has just (re)granted this till's allowance
          setSetting("stock_cursor", String(d.cursor||0)); setSetting("stock_last_sync_ts", new Date().toISOString());
          db.run("COMMIT");
        }
        catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
        await persist();
        return { ok:true, mode:"shared", rows:(d.stock||[]).length };
      }catch(e){
        setSetting("stock_last_error","Shared stock update stopped: "+(e.message||e)+". It will try again.");
        return { ok:false, message:String(e.message||e) };
      }finally{ _ssRunning = null; }
    })();
    return _ssRunning;
  }
  async function ssReportOutbox(){
    const rows = ssPending();
    if(!rows.length) return { ok:true, sent:0 };
    const sales = rows.filter(r=>r.kind==="sale").map(r=>JSON.parse(r.payload_json));
    const moves = rows.filter(r=>r.kind==="move").map(r=>JSON.parse(r.payload_json)).map(m=>({ uid:m.uid, product_uid:m.product_uid, delta:m.delta, kind:m.kind }));
    const r = await ssRpc("cl_stock_report", { p_sales:sales, p_moves:moves });
    ssNote(r);
    if(!r.ok) return r;
    const now = new Date().toISOString();
    db.run("BEGIN");
    try{
      rows.forEach(row=>{
        run("UPDATE stock_outbox SET sent_ts=?, result_json=? WHERE uid=?",[now, JSON.stringify(r.data.shortfall||0), row.uid]);
        if(row.kind==="move"){
          const m = JSON.parse(row.payload_json);
          if(m.delta>0){ const p = ssProduct(m.product_uid); if(p) run("UPDATE products SET stock_pending_in=MAX(0,COALESCE(stock_pending_in,0)-?) WHERE id=?",[m.delta, p.id]); }
        }
      });
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
    if(r.data.shortfall>0) logAudit("Shared stock shortfall","",r.data.shortfall+" unit(s) sold or moved offline could not be covered by branch stock; recorded for the manager.");
    return { ok:true, sent:rows.length, shortfall:r.data.shortfall||0 };
  }
  // Owner Q8: products this till sells that aren't in main's catalogue.
  async function ssReportLocalProducts(){
    if(getSetting("terminal_is_main","")==="1") return;
    const list = all("SELECT sku, name FROM products WHERE branch=? AND cat_uid IS NULL AND COALESCE(active,1)=1 ORDER BY name",[currentBranch()])
      .map(p=>({ code:p.sku||"", name:p.name }));
    const fp = JSON.stringify(list);
    if(fp===getSetting("stock_local_report_fp","")) return;
    const r = await ssRpc("cl_stock_local_products_report", { p_rows:list });
    if(r.ok && r.data.ok) setSetting("stock_local_report_fp", fp);
  }

  // ---- starting shared stock (stock holder, Admin) and the merge on other tills ----
  function sharedStockStartPlan(){
    const own = all("SELECT * FROM products WHERE branch=? AND COALESCE(active,1)=1 ORDER BY name",[currentBranch()]);
    return { linked: own.filter(p=>p.cat_uid && p.cat_seq!=null), unlinked: own.filter(p=>!(p.cat_uid && p.cat_seq!=null)) };
  }
  // Server build guard: every other active till must report build v7+ first.
  function ssTillNeedsUpdateText(d){
    d = d || {};
    const till = (d.till_code||"another till") + (d.label? " ("+d.label+")" : "");
    return "Till "+till+" must update the app first: shared stock needs build v"+(d.min_build||7)+" or later on every till, and it "
      + (d.app_build? "runs build v"+d.app_build : "hasn't reported its build yet") + ". Open the app on that till while online (it updates and checks in), then try again.";
  }
  async function sharedStockStart(passcode){
    if(!findAdmin(passcode)) throw new Error("Incorrect Admin passcode.");
    if(typeof catalogueSyncNow==="function"){ const c = await catalogueSyncNow({}); if(c && c.needsReport) throw new Error("Finish the first catalogue sync first (Settings → Business & Terminals)."); }
    const plan = sharedStockStartPlan();
    const op = ssUid();
    const r = await ssRpc("cl_stock_start_shared", { p_op_id:op, p_rows: plan.linked.map(p=>({ product_uid:p.cat_uid, qty:Math.max(0,p.stock) })) });
    ssNote(r);
    if(!r.ok) throw new Error(r.code==="NOT_HOLDER"? "Only the till that holds the branch's stock can start shared stock."
      : r.code==="SINGLE_TILL"? "Shared stock needs at least two active tills in the branch." : r.code==="ALREADY_SHARED"? "This branch already uses shared stock."
      : r.code==="TILL_NEEDS_UPDATE"? ssTillNeedsUpdateText(r.data) : ssProblemText(r));
    db.run("BEGIN");
    try{
      plan.linked.forEach(p=>{ if(p.stock) moveStock({ productId:p.id, setTo:0, kind:"shared_opening", note:"Stock handed to the branch (shared stock)", ssLocal:true }); });
      setSetting("stock_mode","shared"); setSetting("stock_init","1"); setSetting("stock_cursor","0");
      logAudit("Shared stock started","",plan.linked.length+" products handed to the branch, "+plan.unlinked.length+" stay on this till");
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
    await persist();
    return await stockSyncNow({});
  }
  async function sharedStockMerge(passcode){
    if(!findAdmin(passcode)) throw new Error("Incorrect Admin passcode.");
    const own = all("SELECT * FROM products WHERE branch=? AND cat_uid IS NOT NULL AND stock>0",[currentBranch()]);
    if(own.length){
      const moves = own.map(p=>({ uid:ssUid(), product_uid:p.cat_uid, delta:p.stock, kind:"merge" }));
      const r = await ssRpc("cl_stock_move", { p_moves:moves });
      ssNote(r);
      if(!r.ok || !r.data.ok) throw new Error(r.ok? "Digital Commerce refused the merge." : ssProblemText(r));
      db.run("BEGIN");
      try{
        own.forEach(p=>moveStock({ productId:p.id, setTo:0, kind:"merge_out", note:"Added to branch stock (shared stock)", ssLocal:true }));
        logAudit("Shared stock: own stock added","",own.length+" products, "+own.reduce((s,p)=>s+p.stock,0)+" units added to branch stock");
        db.run("COMMIT");
      }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
    }
    setSetting("stock_init","1"); setSetting("stock_cursor","0");
    await persist();
    return await stockSyncNow({});
  }

  // ---- stocktake at a shared branch (owner Q4) ----
  async function sharedStockStocktake(rows){
    const linked = rows.filter(r=>r.product.cat_uid);
    const op = ssUid();
    const r = await ssRpc("cl_stock_stocktake", { p_op_id:op, p_counts: linked.map(x=>({ product_uid:x.product.cat_uid, counted:x.counted })) });
    ssNote(r);
    if(!r.ok) return { ok:false, message: r.code==="ALLOWANCE_HELD"? ("Till "+(r.data.tills||[]).join(", ")+" still holds stock to sell offline. Connect "+((r.data.tills||[]).length===1?"it":"them")+" (or wait 72 hours), then post the count.")
                                       : (r.reason==="offline"||r.reason==="network")? "A stocktake needs a connection at a shared-stock branch." : ssProblemText(r) };
    _ssPreApplied = new Map();
    linked.forEach(x=>_ssPreApplied.set(x.product.id, { setTo:0 }));                 // the server took this till's allowance back
    return { ok:true, rows:r.data.stock||[] };
  }

  // ---- branch balance (Diagnostics) and branch-only products (main) ----
  async function sharedStockBalance(){ const r = await ssRpc("cl_stock_balance", {}); ssNote(r); return r; }
  async function branchOnlyProducts(){ return await ssRpc("cl_stock_local_products_list", {}); }

  // ---- screens ----
  function sharedStockStatusHtml(){
    if(!ssRegistered()) return "";
    const mode = getSetting("stock_mode",""), holder = getSetting("stock_holder","")==="1", active = Number(getSetting("stock_active_tills","0"))||0;
    const err = getSetting("stock_last_error","");
    let body = "";
    if(mode==="shared" && getSetting("stock_init","")!=="1"){
      body = `<p style="margin:0 0 6px;color:#b54708;font-weight:600">Your branch uses shared stock. This till still holds stock of its own.</p>
        <button class="btn btn-sm btn-primary" id="ssMergeBtn">Add this till's stock to the branch…</button>`;
    } else if(mode==="shared"){
      const pend = ssPending().length;
      const held = (one("SELECT COALESCE(SUM(stock),0) s FROM products WHERE branch=? AND cat_uid IS NOT NULL",[currentBranch()])||{}).s||0;
      const until = allowanceValidUntil();
      body = `<p class="muted" id="ssStatus" style="margin:0 0 6px">Shared branch stock · ${stockReachable()? "online" : "offline"} · this till holds ${held} item${held===1?"":"s"} to sell offline${until? ", valid until "+escapeHtml(new Date(until).toLocaleString()) : ""}${pend? " · "+pend+" offline record"+(pend===1?"":"s")+" to report" : ""}</p>`;
    } else if(holder && active>=2){
      body = `<p class="muted" style="margin:0 0 6px">This branch has ${active} tills. Start shared stock so they all sell from one count (this till holds the branch's stock).</p>
        <button class="btn btn-sm btn-primary" id="ssStartBtn">Start shared stock…</button>`;
    } else if(!holder && mode==="local"){
      body = `<p class="muted" style="margin:0 0 6px">Your branch's stock is on its first till. Shared stock is started there.</p>`;
    } else return "";
    return `<div class="hr"></div><h4 style="margin:0 0 6px">Branch stock</h4>${body}
      ${err? `<p style="margin:0 0 6px;color:var(--danger);font-weight:600">${escapeHtml(err)}</p>` : ""}<div id="ssMsg" class="muted" style="font-size:12.5px"></div>`;
  }
  function wireSharedStockStatus(){
    const st = document.getElementById("ssStartBtn"); if(st) st.onclick = ()=>openSharedStockStart();
    const mg = document.getElementById("ssMergeBtn"); if(mg) mg.onclick = ()=>openSharedStockMerge();
  }
  function openSharedStockStart(){
    const plan = sharedStockStartPlan();
    const units = plan.linked.reduce((s,p)=>s+Math.max(0,p.stock),0);
    const wrap = openModal("Start shared stock", `
      <p style="margin:0 0 6px">All tills in <b>${escapeHtml(currentBranch())}</b> will sell from one stock count on Digital Commerce. This till's stock becomes the branch's opening stock. <b>This can't be undone.</b></p>
      <div class="pmeta">Products handed to the branch: <b>${plan.linked.length}</b> (${units} units)</div>
      ${plan.unlinked.length? `<div style="margin-top:8px"><b>Stay on this till only (${plan.unlinked.length})</b> — not in main's catalogue:
        <div style="max-height:22vh;overflow:auto;font-size:12.5px">${plan.unlinked.slice(0,200).map(p=>`<div class="pmeta">${escapeHtml((p.sku? p.sku+" " : "")+p.name)}</div>`).join("")}</div></div>` : ""}
      <label style="margin-top:10px">Admin passcode</label>
      <input class="field" id="ssPass" type="password" inputmode="numeric">
      <div id="ssStartMsg" class="muted" style="font-size:12.5px;margin-top:6px"></div>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-outline" id="ssNo" style="flex:1">Not now</button><button class="btn btn-primary" id="ssYes" style="flex:1">Start shared stock</button></div>`);
    wrap.querySelector("#ssNo").onclick = ()=>wrap.remove();
    wrap.querySelector("#ssYes").onclick = async ()=>{
      const b = wrap.querySelector("#ssYes"); b.disabled = true; wrap.querySelector("#ssStartMsg").textContent = "Starting…";
      try{ await sharedStockStart(wrap.querySelector("#ssPass").value); wrap.remove(); render(); }
      catch(e){ wrap.querySelector("#ssStartMsg").textContent = e.message||String(e); b.disabled = false; }
    };
  }
  function openSharedStockMerge(){
    const own = all("SELECT * FROM products WHERE branch=? AND cat_uid IS NOT NULL AND stock>0 ORDER BY name",[currentBranch()]);
    const wrap = openModal("Add this till's stock to the branch", `
      <p style="margin:0 0 6px">This till holds stock of its own. It's added to the branch's shared stock, then this till sells from the branch like the others.</p>
      <div style="max-height:30vh;overflow:auto;font-size:12.5px">${own.map(p=>`<div class="pmeta">${escapeHtml((p.sku? p.sku+" " : "")+p.name)}: <b>${p.stock}</b></div>`).join("")}</div>
      <label style="margin-top:10px">Admin passcode</label>
      <input class="field" id="smPass" type="password" inputmode="numeric">
      <div id="smMsg" class="muted" style="font-size:12.5px;margin-top:6px"></div>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-outline" id="smNo" style="flex:1">Not now</button><button class="btn btn-primary" id="smYes" style="flex:1">Add to branch stock</button></div>`);
    wrap.querySelector("#smNo").onclick = ()=>wrap.remove();
    wrap.querySelector("#smYes").onclick = async ()=>{
      const b = wrap.querySelector("#smYes"); b.disabled = true; wrap.querySelector("#smMsg").textContent = "Adding…";
      try{ await sharedStockMerge(wrap.querySelector("#smPass").value); wrap.remove(); render(); }
      catch(e){ wrap.querySelector("#smMsg").textContent = e.message||String(e); b.disabled = false; }
    };
  }
  // Sell screens: shown while offline on a shared-stock till.
  function sharedStockOfflineBadgeHtml(){
    if(!sharedStockTill() || stockReachable()) return "";
    const until = allowanceValidUntil();
    return `<div class="box ss-offline" style="margin:0 0 10px;padding:8px 12px;border:1px solid #b54708;border-radius:8px;background:#fff8f0;color:#b54708;font-weight:600">
      ${allowanceValid()? "Offline · selling from this till's allowance (valid until "+escapeHtml(new Date(until).toLocaleString())+")" : "Offline · this till's allowance has expired. Connect to sell."}</div>`;
  }
  // Diagnostics (settings.js): a button that asks the server.
  function sharedStockDiagHtml(){
    if(!sharedStockTill()) return "";
    return `<div class="hr"></div><button class="btn btn-sm btn-outline" id="ssBalanceBtn">Check branch stock balance</button><div id="ssBalance" style="margin-top:8px"></div>`;
  }
  function wireSharedStockDiag(){
    const b = document.getElementById("ssBalanceBtn");
    if(!b) return;
    b.onclick = async ()=>{
      const box = document.getElementById("ssBalance"); b.disabled = true; box.innerHTML = `<p class="muted" style="margin:0">Checking…</p>`;
      const r = await sharedStockBalance(); b.disabled = false;
      if(!r.ok){ box.innerHTML = `<p style="margin:0;color:var(--danger)">${escapeHtml(ssProblemText(r))}</p>`; return; }
      const d = r.data;
      box.innerHTML = (d.mismatches.length
        ? `<p class="ss-bal-bad" style="margin:0 0 6px;color:#b42318;font-weight:600">Branch stock: ${d.mismatches.length} of ${d.products} products don't balance.</p>
           <table class="table"><tr><th>Item</th><th>Total</th><th>Available</th><th>On tills</th><th>History</th></tr>
           ${d.mismatches.map(m=>`<tr><td>${skuNameCell(m.code,m.name)}</td><td>${m.total}</td><td>${m.available}</td><td>${m.allowances}</td><td>${m.events}</td></tr>`).join("")}</table>`
        : `<p class="ss-bal-ok" style="margin:0;color:#067647;font-weight:600">Branch stock: all ${d.products} products balance (total = available + held on tills).</p>`)
        + (d.discrepancies.length
        ? `<p style="margin:8px 0 4px;color:#b54708;font-weight:600">Not covered by branch stock (${d.discrepancies.length}):</p>
           ${d.discrepancies.map(x=>`<div class="pmeta">${escapeHtml(new Date(x.ts).toLocaleString())} · till ${escapeHtml(x.till||"?")} · ${escapeHtml(x.product||"")}: ${x.shortfall} (${escapeHtml(x.what||"")})</div>`).join("")}`
        : "");
    };
  }
  // Main (owner Q8): products tills sell that aren't in the catalogue.
  async function openBranchOnlyProducts(){
    const wrap = openModal("Products only at branches", `<p class="muted" style="margin:0">Loading…</p>`);
    const body = wrap.querySelector(".modal-body");
    const r = await branchOnlyProducts();
    if(!r.ok){ body.innerHTML = `<p>${escapeHtml(ssProblemText(r))}</p>`; return; }
    const list = r.data.products||[];
    body.innerHTML = list.length
      ? `<p class="muted" style="margin:0 0 6px">These are sold at a branch but aren't in your catalogue. Add them in Products (same code) so every till can match them.</p>
         <div style="max-height:55vh;overflow:auto">${list.map(p=>`<div class="pmeta bop-row">${escapeHtml(p.branch)} · ${escapeHtml(p.till)} · ${escapeHtml((p.code? p.code+" " : "")+p.name)}</div>`).join("")}</div>`
      : `<p style="margin:0">Every product sold at your branches is in the catalogue.</p>`;
  }
