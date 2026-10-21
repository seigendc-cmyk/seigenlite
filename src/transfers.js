  // ================== Internal transfers (v32; seiGEN 20261109120000_office_seats) ==================
  // Stock between an Office seat (the store room) and a till of the SAME branch
  // (the shop floor), in two steps like a Delivery Note and its GRV: the sender
  // posts (its stock goes down), the receiving device confirms each line's
  // quantity (its stock goes up by what arrived). A shortage goes back into
  // the sender's stock; the sender writes it off (an ADJ, approved as any
  // write-off) or keeps it. No costs travel, no transport, no charge; costs
  // show here only to people with "View costs", from this device's own catalogue.
  // Each device moves its own stock once per document (stock_movements.doc_uid),
  // so a retry, a pull after a restore or a double tap never counts twice.

  function itEnabled(){ return typeof isTerminalRegistered==="function" && isTerminalRegistered() && getSetting("terminal_is_main","")==="1"; }
  function itDevices(){ try{ return JSON.parse(getSetting("it_devices","[]"))||[]; }catch(e){ return []; } }
  // Another device this one can send to: a seat sends to a till, a till to a seat (seiGEN checks it too).
  function itTargets(){ return itDevices().filter(d=> d.id!==getSetting("terminal_id","") && d.active && d.approval==="approved" && ((d.kind==="seat")!==isSeat())); }
  function itAvailable(){ return itEnabled() && (isSeat() || itDevices().some(d=>d.kind==="seat")); }
  async function itRefreshDevices(){
    if(!itEnabled() || typeof fetchBusinessBranches!=="function") return false;
    const r = await fetchBusinessBranches();
    if(!r.ok || !r.data) return false;
    const mine = (r.data.branches||[]).find(b=> b.id===getSetting("branch_uuid",""));
    if(!mine || !mine.terminals) return false;
    setSetting("it_devices", JSON.stringify(mine.terminals.map(t=>({ id:t.id, till_code:t.till_code, label:t.label||"", kind:t.kind||"till", active:!!t.active, approval:t.approval||"approved" }))));
    return true;
  }
  function itCache(){ try{ return JSON.parse(getSetting("it_cache","")||"null") || { incoming:[], outgoing:[] }; }catch(e){ return { incoming:[], outgoing:[] }; } }
  // seiGEN's answer to a send or a confirm goes into the list at once (the pull after it may take a while)
  function itCacheUpsert(dir, x){
    const c = itCache(), list = c[dir] || (c[dir] = []), i = list.findIndex(t=>t.id===x.id);
    if(i>=0) list[i] = x; else list.push(x);
    setSetting("it_cache", JSON.stringify(c));
  }
  function itDeviceName(code, kind){ return kind==="seat" || /^S\d+$/.test(String(code||""))? code+" (Office seat)" : code+" (till)"; }
  const itApplied = (docUid)=> !!one("SELECT 1 AS x FROM stock_movements WHERE doc_uid=? LIMIT 1",[docUid]);
  const itUid = (id)=> String(id||"").toLowerCase().replace(/-/g,"");
  function itNewId(){ const h = (typeof dsNewUid==="function"? dsNewUid() : sha256HexPure(String(Math.random())+Date.now()).slice(0,32)); return h.slice(0,8)+"-"+h.slice(8,12)+"-4"+h.slice(13,16)+"-a"+h.slice(17,20)+"-"+h.slice(20,32); }
  function itFindProduct(l){ return dsFindProduct(l); }
  function itSeatApprover(pin){
    const s = typeof staffSession==="function"? staffSession() : null;
    if(!s || !canStrict("approve_writeoffs")) throw new Error("A write-off needs someone signed in who may approve write-offs.");
    const st = shopStaff(s.id);
    if(!st || !staffPinMatches(st, pin)) throw new Error("Incorrect PIN.");
    return { name:st.name };
  }
  function itCanSeeCosts(){ return typeof can==="function"? can("costs") : true; }
  function itStatusText(x){
    if(x.status==="sent") return "Sent, waiting to be received";
    if(x.status==="cancelled") return "Cancelled";
    if(x.status==="received") return "Received";
    if(x.status==="received_short"){
      const open = (x.lines||[]).filter(l=>l.short_status==="open").length;
      return "Received short" + (open? " · "+open+" to settle" : "");
    }
    return x.status||"";
  }
  function itSay(r){ return typeof seatProblemText==="function"? seatProblemText(r) : ((r.data && r.data.message) || r.message || "Couldn't reach seiGEN."); }

  // ---- the sender ----
  // o: { toId, lines:[{ productId, qty }], note }
  async function itSend(o){
    if(!isOnline()) throw new Error("You need the internet to send a transfer, so both devices see the same thing.");
    if(typeof can==="function" && !can("m.dispatch")) throw new Error("Sending stock needs the Dispatch right.");
    const to = itTargets().find(d=>d.id===o.toId);
    if(!to) throw new Error("Choose another device of this branch.");
    const lines = (o.lines||[]).filter(l=>l.qty>0).map((l, i)=>{
      const p = one("SELECT * FROM products WHERE id=?",[l.productId]);
      if(!p) throw new Error("A product on this transfer isn't here any more.");
      if(!Number.isInteger(l.qty) || l.qty<1) throw new Error("Quantities are whole numbers.");
      if(l.qty > (p.stock||0)) throw new Error(p.name+": only "+(p.stock||0)+" in stock here.");
      return { line_no:i+1, cat_uid:p.cat_uid||null, code:p.sku||null, name:p.name, qty:l.qty, productId:p.id };
    });
    if(!lines.length) throw new Error("Add at least one product with a quantity.");
    const doc = reserveDocNumber("IT");
    await persist();
    const id = itNewId();
    const payload = { id, it_no:doc.n, it_display:doc.text, to_terminal_id:to.id, created_iso:new Date().toISOString(),
      sent_by:String(sessionUser||""), note:String(o.note||"").trim()||null, lines:lines.map(({ productId, ...l })=>l) };
    const r = await terminalRpc("cl_device_transfer_send", Object.assign(await seatAuth(), { p_transfer:payload }), { timeoutMs:20000 });
    if(!r.ok) throw new Error(itSay(r));
    itApplySend(r.data.transfer);
    itCacheUpsert("outgoing", r.data.transfer);
    logAudit("Internal transfer sent", "", doc.text+" to "+itDeviceName(to.till_code, to.kind)+": "+lines.map(l=>l.qty+" × "+l.name).join(", "));
    await persist();
    itPull().catch(()=>{});
    return r.data.transfer;
  }
  function itApplySend(x){
    const uid = itUid(x.id);
    return dsTx(()=>{
      if(itApplied(uid)) return false;
      const ts = new Date().toISOString();
      (x.lines||[]).forEach(l=>{
        const p = itFindProduct(l);
        if(!p) throw new Error(l.name+" isn't a product here.");
        dsMove(p, -l.qty, "transfer_out", "it", uid, x.it_display, "To "+itDeviceName(x.to_till, x.to_kind), ts);
      });
      return true;
    });
  }
  async function itCancel(id, reason){
    if(!isOnline()) throw new Error("You need the internet for this.");
    if(String(reason||"").trim().length<3) throw new Error("Give a reason (at least 3 characters).");
    const r = await terminalRpc("cl_device_transfer_cancel", Object.assign(await seatAuth(), { p_transfer_id:id, p_by:String(sessionUser||""), p_reason:String(reason).trim() }));
    if(!r.ok) throw new Error(itSay(r));
    itReconcileOut(r.data.transfer);
    logAudit("Internal transfer cancelled", "", r.data.transfer.it_display+": "+String(reason).trim());
    await persist();
    return r.data.transfer;
  }
  // A shortage: written off (ADJ, approved like any write-off) or kept in this device's stock.
  async function itResolve(id, lineNo, action, o){
    o = o||{};
    if(!isOnline()) throw new Error("You need the internet for this.");
    const x = itCache().outgoing.find(t=>t.id===id);
    const l = x && (x.lines||[]).find(k=>k.line_no===lineNo);
    if(!l || l.short_status!=="open") throw new Error("That shortage isn't open.");
    let p = { by:String(sessionUser||"") };
    if(action==="write_off"){
      const admin = isSeat()? itSeatApprover(o.passcode) : dsNeedAdmin(o.passcode, "approve_writeoffs");   // a seat has no Admin passcode: the signed-in person's own PIN
      if(String(o.reason||"").trim().length<3) throw new Error("Give a reason (at least 3 characters).");
      const adj = reserveDocNumber("ADJ");
      p = Object.assign(p, { adj_no:adj.n, adj_text:adj.text, adj_till:adj.till||null, reason:String(o.reason).trim(), admin:admin.name });
      await persist();
    }
    const r = await terminalRpc("cl_device_transfer_resolve", Object.assign(await seatAuth(), { p_transfer_id:id, p_line_no:lineNo, p_action:action,
      p_by:p.by, p_note:p.reason||null, p_adj_display:p.adj_text||null }));
    if(!r.ok) throw new Error(itSay(r));
    itReconcileOut(r.data.transfer, action==="write_off"? Object.assign({ line_no:lineNo }, p) : null);
    logAudit(action==="write_off"? "Write-off (internal transfer)" : "Internal transfer shortage kept", l.name, x.it_display+": "+(l.qty-l.received)+(p.adj_text? " ("+p.adj_text+", authorised by "+p.admin+")" : ""));
    await persist();
    return r.data.transfer;
  }
  // What seiGEN says happened to a transfer this device sent: moved here once each.
  function itReconcileOut(x, wo){
    if(x.from_terminal_id!==getSetting("terminal_id","")) return;
    const uid = itUid(x.id), ts = new Date().toISOString();
    dsTx(()=>{
      if(x.status!=="cancelled" && !itApplied(uid)){
        (x.lines||[]).forEach(l=>{ const p = itFindProduct(l); if(p) dsMove(p, -l.qty, "transfer_out", "it", uid, x.it_display, "To "+itDeviceName(x.to_till, x.to_kind)+" (put back from seiGEN)", ts); });
      }
      if(x.status==="cancelled" && itApplied(uid) && !itApplied(uid+":cancel")){
        (x.lines||[]).forEach(l=>{ const p = itFindProduct(l); if(p) dsMove(p, l.qty, "transfer_cancel", "it", uid+":cancel", x.it_display, "Cancelled: "+(x.cancel_reason||""), ts); });
      }
      if(x.status==="received_short" && itApplied(uid)){
        (x.lines||[]).filter(l=>l.received!=null && l.received<l.qty).forEach(l=>{
          const p = itFindProduct(l), k = uid+":"+l.line_no, short = l.qty-l.received;
          if(!p) return;
          if(!itApplied(k+":return")) dsMove(p, short, "transfer_return", "it", k+":return", x.it_display, "Short at "+itDeviceName(x.to_till, x.to_kind), ts);
          if(l.short_status==="written_off" && !itApplied(k+":wo")){
            const w = (wo && wo.line_no===l.line_no)? wo : {};
            if(w.adj_no!=null)
              run(`INSERT INTO stock_adjustments(branch,branch_id,adj_no,product_code,product_name,qty_delta,reason,note,by_user,authorised_by,ts,till_code)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
                [currentBranch(), getBranchId(), w.adj_no, p.sku||"", p.name, -short, "Lost in transit", w.reason||l.short_note||"", String(sessionUser||""), w.admin||l.short_resolved_by||"", ts, w.adj_till||null]);
            moveStock({ productId:p.id, delta:-short, kind:"write_off", docType:"adj", docUid:k+":wo", docNo:l.adj_display||w.adj_text||"", ts, note:"Short on "+x.it_display+": "+(w.reason||l.short_note||"") });
          }
        });
      }
    });
  }

  // ---- the receiver ----
  // counts: { line_no: received }
  async function itReceive(id, counts){
    if(!isOnline()) throw new Error("You need the internet to confirm a transfer.");
    if(typeof can==="function" && !can("m.receive")) throw new Error("Receiving stock needs the Receive right.");
    const x = itCache().incoming.find(t=>t.id===id);
    if(!x) throw new Error("That transfer isn't here. Tap Refresh.");
    const lines = (x.lines||[]).map(l=>{
      const n = Number(counts[l.line_no]);
      if(!Number.isInteger(n) || n<0 || n>l.qty) throw new Error(l.name+": received must be 0 to "+l.qty+".");
      if(n>0 && !itFindProduct(l)) throw new Error(l.name+" isn't a product on this device. Add it (or let the catalogue arrive), then confirm.");
      return { line_no:l.line_no, received:n };
    });
    const r = await terminalRpc("cl_device_transfer_receive", Object.assign(await seatAuth(), { p_transfer_id:id, p_by:String(sessionUser||""), p_lines:lines }), { timeoutMs:20000 });
    if(!r.ok) throw new Error(itSay(r));
    itApplyReceive(r.data.transfer);
    itCacheUpsert("incoming", r.data.transfer);
    const short = (r.data.transfer.lines||[]).filter(l=>l.received<l.qty);
    logAudit("Internal transfer received", "", r.data.transfer.it_display+" from "+itDeviceName(r.data.transfer.from_till, r.data.transfer.from_kind)+(short.length? ": short "+short.map(l=>(l.qty-l.received)+" × "+l.name).join(", ") : ""));
    await persist();
    itPull().catch(()=>{});
    return r.data.transfer;
  }
  function itApplyReceive(x){
    if(x.to_terminal_id!==getSetting("terminal_id","") || !(x.status==="received" || x.status==="received_short")) return false;
    const uid = itUid(x.id)+":in";
    return dsTx(()=>{
      if(itApplied(uid)) return false;
      const ts = new Date().toISOString();
      (x.lines||[]).filter(l=>l.received>0).forEach(l=>{
        const p = itFindProduct(l);
        if(!p) throw new Error(l.name+" isn't a product on this device.");
        dsMove(p, l.received, "transfer_in", "it", uid, x.it_display, "From "+itDeviceName(x.from_till, x.from_kind), ts);
      });
      return true;
    });
  }

  // ---- the pull: on opening the screen, after a check-in, on Refresh ----
  // A pull asked for while one runs gets a fresh pull after it (the running one may have
  // started before a send, and would put back a list without it); callers meanwhile share it.
  let _itPulling = null, _itNext = null, _itRedraw = null;
  function itPull(){
    if(_itPulling) return _itNext || (_itNext = _itPulling.catch(()=>{}).then(()=>{ _itNext = null; return itPull(); }));
    _itPulling = (async ()=>{
      if(!itEnabled() || !isOnline()) return { ok:false, offline:!isOnline() };
      const r = await terminalRpc("cl_device_transfers_pull", await seatAuth(), { timeoutMs:20000 });
      if(!r.ok) return { ok:false, message:itSay(r) };
      setSetting("it_cache", JSON.stringify({ incoming:r.data.incoming||[], outgoing:r.data.outgoing||[], ts:new Date().toISOString() }));
      if(r.data.max_it_no>0) dsBumpCounter("IT", r.data.max_it_no);
      const problems = [];
      (r.data.outgoing||[]).forEach(x=>{ try{ itReconcileOut(x); }catch(e){ problems.push(x.it_display+": "+(e.message||e)); } });
      (r.data.incoming||[]).forEach(x=>{ try{ itApplyReceive(x); }catch(e){ problems.push(x.it_display+": "+(e.message||e)); } });
      await persist();
      if(_itRedraw) _itRedraw();   // the Transfers screen, if it's open
      return { ok:true, problems };
    })().finally(()=>{ _itPulling = null; });
    return _itPulling;
  }
  // After every check-in on a main-branch device: this branch's devices (so a till learns of a new
  // seat and shows Transfers), then the transfers themselves when there's a seat.
  function itAfterCheckin(){
    if(!itEnabled() || !isOnline()) return Promise.resolve();
    return itRefreshDevices().then(()=> itAvailable()? itPull() : null).catch(()=>{});
  }
  function itWaitingCount(){ return itCache().incoming.filter(x=>x.status==="sent").length; }

  // ================== the screen: More → Transfers ==================
  function itLineValue(l){
    if(!itCanSeeCosts()) return "";
    const p = itFindProduct(l);
    return p && p.cost!=null? ` · ${escapeHtml(currency+(Number(p.cost)*(l.received!=null? l.received : l.qty)).toFixed(2))} at cost` : "";
  }
  function itCardHtml(x, dir){
    const other = dir==="in"? itDeviceName(x.from_till, x.from_kind) : itDeviceName(x.to_till, x.to_kind);
    return `<div class="card it-card" data-it="${escapeHtml(x.id)}">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>${escapeHtml(x.it_display)}</b>
        <span class="pill ${x.status==="received"? "ok" : x.status==="sent"? "" : "low"}">${escapeHtml(itStatusText(x))}</span></div>
      <div class="muted" style="font-size:12.5px">${dir==="in"? "From" : "To"} ${escapeHtml(other)} · ${escapeHtml(new Date(x.sent_at).toLocaleString())}${x.sent_by? " · "+escapeHtml(x.sent_by) : ""}${x.note? " · "+escapeHtml(x.note) : ""}</div>
      ${(x.lines||[]).map(l=>`<div class="it-line" style="font-size:13px;margin-top:4px">${escapeHtml(l.name)}${l.code? " ("+escapeHtml(l.code)+")" : ""}: ${l.qty}${l.received!=null? " sent, "+l.received+" received" : ""}${itLineValue(l)}
        ${l.received!=null && l.received<l.qty? ` · <b>short ${l.qty-l.received}</b>${l.short_status==="open"? (dir==="out"? ` <button class="btn btn-sm btn-outline" data-it-wo="${escapeHtml(x.id)}:${l.line_no}">Write off</button> <button class="btn btn-sm btn-ghost" data-it-keep="${escapeHtml(x.id)}:${l.line_no}">Keep in stock</button>` : " (back with the sender)")
          : l.short_status==="written_off"? " · written off "+escapeHtml(l.adj_display||"") : l.short_status==="kept"? " · kept by the sender" : ""}` : ""}</div>`).join("")}
      ${dir==="in" && x.status==="sent"? `<button class="btn btn-primary btn-sm" data-it-receive="${escapeHtml(x.id)}" style="margin-top:8px">Confirm what arrived</button>` : ""}
      ${dir==="out" && x.status==="sent"? `<button class="btn btn-outline btn-sm" data-it-cancel="${escapeHtml(x.id)}" style="margin-top:8px">Cancel</button>` : ""}
    </div>`;
  }
  async function renderTransfers(main){
    const draw = ()=>{
      const c = itCache(), waiting = c.incoming.filter(x=>x.status==="sent"), past = c.incoming.filter(x=>x.status!=="sent");
      main.innerHTML = `
        <p class="muted" style="margin-top:0">Stock between ${isSeat()? "this Office seat (the store room) and the branch's tills" : "this till and the branch's Office seat (the store room)"}.
          The sender posts it; the receiving device confirms what arrived. No costs travel and there's no transport charge.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">
          ${typeof can!=="function" || can("m.dispatch")? `<button class="btn btn-primary" id="itNew"${itTargets().length? "" : " disabled"}>+ New transfer</button>` : ""}
          <button class="btn btn-outline" id="itRefresh">Refresh</button></div>
        <p class="muted" id="itMsg" style="font-size:12.5px"></p>
        <h3>Waiting for you${waiting.length? " ("+waiting.length+")" : ""}</h3>
        ${waiting.map(x=>itCardHtml(x,"in")).join("") || `<p class="muted">Nothing waiting.</p>`}
        <h3>Sent</h3>
        ${c.outgoing.slice().reverse().map(x=>itCardHtml(x,"out")).join("") || `<p class="muted">Nothing sent in the last 60 days.</p>`}
        ${past.length? `<h3>Received</h3>${past.slice().reverse().map(x=>itCardHtml(x,"in")).join("")}` : ""}`;
      const msg = main.querySelector("#itMsg");
      const say = (t, bad)=>{ msg.textContent = t||""; msg.style.color = bad? "var(--danger)" : ""; };
      const nb = main.querySelector("#itNew"); if(nb) nb.onclick = ()=> openTransferModal(()=>{ draw(); });
      main.querySelector("#itRefresh").onclick = async ()=>{ say("Loading…"); await itRefreshDevices().catch(()=>{}); const r = await itPull(); draw(); const m2 = main.querySelector("#itMsg"); if(m2) m2.textContent = r.ok? (r.problems && r.problems.length? r.problems.join(" · ") : "Up to date.") : (r.offline? "You're offline." : r.message||""); };
      main.querySelectorAll("[data-it-receive]").forEach(b=> b.onclick = ()=> openTransferReceiveModal(b.dataset.itReceive, draw));
      const redraw = ()=>{ if(main.isConnected && main.querySelector("#itRefresh")) draw(); else if(_itRedraw===redraw) _itRedraw = null; };
      _itRedraw = redraw;
      main.querySelectorAll("[data-it-cancel]").forEach(b=> b.onclick = async ()=>{
        const why = prompt("Why cancel this transfer?"); if(why==null) return;
        try{ await itCancel(b.dataset.itCancel, why); await itPull(); draw(); }catch(e){ say(e.message||String(e), true); }
      });
      main.querySelectorAll("[data-it-keep]").forEach(b=> b.onclick = async ()=>{
        const [id, ln] = b.dataset.itKeep.split(":");
        if(!confirm("Keep the missing units in this device's stock?")) return;
        try{ await itResolve(id, Number(ln), "keep"); await itPull(); draw(); }catch(e){ say(e.message||String(e), true); }
      });
      main.querySelectorAll("[data-it-wo]").forEach(b=> b.onclick = ()=>{
        const [id, ln] = b.dataset.itWo.split(":");
        const wrap = openModal("Write off the shortage", `
          <p class="muted" style="margin-top:0">The missing units are taken off this device's stock with an adjustment (ADJ).</p>
          <label for="itWoWhy">Reason</label><input class="field" id="itWoWhy" placeholder="e.g. Lost between the store room and the counter">
          <label for="itWoPass">Admin passcode, or your own PIN if you may approve write-offs</label><input class="field" id="itWoPass" type="password" autocomplete="off">
          <button class="btn btn-primary" id="itWoGo" style="margin-top:10px">Write off</button>
          <p id="itWoMsg" role="alert" style="color:var(--danger);font-weight:600;margin:8px 0 0"></p>`);
        wrap.querySelector("#itWoGo").onclick = async ()=>{
          try{ await itResolve(id, Number(ln), "write_off", { reason:wrap.querySelector("#itWoWhy").value, passcode:wrap.querySelector("#itWoPass").value }); wrap.remove(); await itPull(); draw(); }
          catch(e){ wrap.querySelector("#itWoMsg").textContent = e.message||String(e); }
        };
      });
    };
    draw();
    if(isOnline()){ await itRefreshDevices().catch(()=>{}); await itPull(); if(main.isConnected) draw(); }
  }
  function openTransferModal(done){
    const targets = itTargets();
    const products = all("SELECT * FROM products WHERE branch=? AND stock>0 ORDER BY lower(name)",[currentBranch()]);
    const costs = itCanSeeCosts();
    const wrap = openModal("New transfer", `
      <label for="itTo">To</label>
      <select class="field" id="itTo">${targets.map(d=>`<option value="${escapeHtml(d.id)}">${escapeHtml(itDeviceName(d.till_code, d.kind))}${d.label? " · "+escapeHtml(d.label) : ""}</option>`).join("")}</select>
      <label for="itFind">Products</label>
      <input class="field" id="itFind" placeholder="Search a product to add">
      <div id="itPick" style="max-height:160px;overflow:auto"></div>
      <div id="itLines" style="margin-top:8px"></div>
      <label for="itNote">Note (optional)</label><input class="field" id="itNote" maxlength="200">
      <button class="btn btn-primary" id="itSend" style="margin-top:10px">Send</button>
      <p id="itSendMsg" role="alert" style="color:var(--danger);font-weight:600;margin:8px 0 0"></p>`);
    const chosen = new Map();   // productId -> qty
    const $w = (s)=> wrap.querySelector(s);
    const drawLines = ()=>{
      $w("#itLines").innerHTML = [...chosen.entries()].map(([id, qty])=>{ const p = products.find(x=>x.id===id);
        return `<div class="it-pickline" style="display:flex;gap:8px;align-items:center;margin:3px 0"><span style="flex:1">${escapeHtml(p.name)} <span class="muted">(${p.stock} here${costs && p.cost!=null? " · "+escapeHtml(currency+Number(p.cost).toFixed(2))+" each" : ""})</span></span>
          <input class="field" type="number" min="1" max="${p.stock}" step="1" value="${qty}" data-it-qty="${id}" style="width:90px;margin:0"><button class="btn btn-sm btn-ghost" data-it-drop="${id}">✕</button></div>`; }).join("") || `<p class="muted" style="font-size:12.5px">No products yet.</p>`;
      wrap.querySelectorAll("[data-it-qty]").forEach(i=> i.oninput = ()=>{ chosen.set(Number(i.dataset.itQty), Math.floor(Number(i.value)||0)); });
      wrap.querySelectorAll("[data-it-drop]").forEach(b=> b.onclick = ()=>{ chosen.delete(Number(b.dataset.itDrop)); drawLines(); });
    };
    const drawPick = ()=>{
      const qy = $w("#itFind").value.trim().toLowerCase();
      const hits = qy? products.filter(p=> (p.name+" "+(p.sku||"")).toLowerCase().includes(qy)).slice(0, 30) : [];
      $w("#itPick").innerHTML = hits.map(p=>`<button type="button" class="btn btn-sm btn-ghost" data-it-add="${p.id}" style="display:block;width:100%;text-align:left">${escapeHtml(p.name)}${p.sku? " · "+escapeHtml(p.sku) : ""} <span class="muted">(${p.stock})</span></button>`).join("");
      wrap.querySelectorAll("[data-it-add]").forEach(b=> b.onclick = ()=>{ const id = Number(b.dataset.itAdd); if(!chosen.has(id)) chosen.set(id, 1); $w("#itFind").value = ""; drawPick(); drawLines(); });
    };
    $w("#itFind").oninput = drawPick;
    drawLines();
    const go = $w("#itSend");
    go.onclick = async ()=>{
      if(go.disabled) return;
      go.disabled = true; go.textContent = "Sending…"; $w("#itSendMsg").textContent = "";
      try{
        await itSend({ toId:$w("#itTo").value, note:$w("#itNote").value, lines:[...chosen.entries()].map(([productId, qty])=>({ productId, qty })) });
        wrap.remove(); if(done) done();
      }catch(e){ go.disabled = false; go.textContent = "Send"; $w("#itSendMsg").textContent = e.message||String(e); }
    };
    return wrap;
  }
  function openTransferReceiveModal(id, done){
    const x = itCache().incoming.find(t=>t.id===id);
    if(!x) return null;
    const wrap = openModal("Confirm "+x.it_display, `
      <p class="muted" style="margin-top:0">From ${escapeHtml(itDeviceName(x.from_till, x.from_kind))}. Count what arrived; anything missing goes back to the sender's stock.</p>
      ${(x.lines||[]).map(l=>`<div style="display:flex;gap:8px;align-items:center;margin:4px 0"><span style="flex:1">${escapeHtml(l.name)} <span class="muted">(sent ${l.qty})</span></span>
        <input class="field" type="number" min="0" max="${l.qty}" step="1" value="${l.qty}" data-it-got="${l.line_no}" style="width:90px;margin:0"></div>`).join("")}
      <button class="btn btn-primary" id="itRecvGo" style="margin-top:10px">Confirm</button>
      <p id="itRecvMsg" role="alert" style="color:var(--danger);font-weight:600;margin:8px 0 0"></p>`);
    const go = wrap.querySelector("#itRecvGo");
    go.onclick = async ()=>{
      if(go.disabled) return;
      const counts = {}; wrap.querySelectorAll("[data-it-got]").forEach(i=>{ counts[Number(i.dataset.itGot)] = Math.floor(Number(i.value)); });
      go.disabled = true; go.textContent = "Confirming…";
      try{ await itReceive(id, counts); wrap.remove(); if(done) done(); }
      catch(e){ go.disabled = false; go.textContent = "Confirm"; wrap.querySelector("#itRecvMsg").textContent = e.message||String(e); }
    };
    return wrap;
  }
