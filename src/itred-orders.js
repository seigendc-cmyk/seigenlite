  // ================== iTred orders (Orders Fulfillment, Marketplace Feedback) ==================
  // docs/itred/itred-upgrade-design.md Part D; server side:
  // supabase/migrations/20261105120000_itred_order_fulfilment.sql.
  //
  // Orders customers send the business on iTred Market Place reach every till
  // of the business (owner, Q4). A till sets what it supplied per line (a
  // quantity 0..requested and a short note), marks an order complete, and
  // answers the order's message thread. The customer sees all of it in
  // iTred's Your Orders and confirms or disputes each line.
  //
  // Status only (owner, Q1): nothing here touches stock or sales; the shop
  // rings up the sale on Sell as usual.
  //
  // Offline first, the same shape as the customer list (customers.js): every
  // change goes into itred_outbox at once (shown as "waiting to send") and is
  // sent after each check-in, on reconnect and when a page opens; each change
  // carries its own uid, so a resend is a no-op on the server (no duplicates).
  // Then the orders changed since the stored cursor are pulled. A pulled order
  // replaces the local copy (the server's JSON, as srv_dispatches keeps it);
  // changes still queued are laid over it until they are sent.
  //
  // The vendor sees the customer's name and phone, never the email (Q6).
  // Local only: mergeDatabase never reads these tables.

  const ITRED_PULL_LIMIT = 50;

  function itredRegistered(){
    return typeof isTerminalRegistered==="function" && isTerminalRegistered()
      && !(typeof isTerminalInactive==="function" && isTerminalInactive());
  }
  // The two More pages show once seiGEN has said this business is on iTred
  // (its first pull didn't answer NOT_ON_ITRED).
  function itredAvailable(){ return itredRegistered() && getSetting("itred_on","")==="1"; }

  function itredNewUid(){
    if(typeof crypto!=="undefined" && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    return dsUuid(Array.from(b, x=> x.toString(16).padStart(2,"0")).join(""));
  }
  const itredRef = (id)=> "PO-" + String(id||"").replace(/-/g,"").slice(0,8).toUpperCase();
  const itredQty = (n)=> String(Math.round(Number(n||0)*1000)/1000);

  // ---- the local copy ----
  function itredRows(){ return all("SELECT * FROM itred_orders ORDER BY created_at DESC"); }
  function itredRow(id){ return one("SELECT * FROM itred_orders WHERE id=?",[id]); }
  function itredOutbox(orderId){
    return orderId==null? all("SELECT * FROM itred_outbox ORDER BY created_ts, rowid") : all("SELECT * FROM itred_outbox WHERE order_id=? ORDER BY created_ts, rowid",[orderId]);
  }
  // asNew false: a first sight that isn't news (an old order on a till's first pull) is stored as seen.
  function itredStoreOrder(o, asNew){
    const existing = itredRow(o.id);
    run(`INSERT INTO itred_orders(id, created_at, status, completed_at, updated_at, change_seq, customer_name, customer_phone, json, pulled_ts, seen)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, status=excluded.status, completed_at=excluded.completed_at, updated_at=excluded.updated_at,
           change_seq=excluded.change_seq, customer_name=excluded.customer_name, customer_phone=excluded.customer_phone, json=excluded.json, pulled_ts=excluded.pulled_ts`,
      [o.id, o.created_at||"", o.status||"sent", o.completed_at||null, o.updated_at||"", Number(o.change_seq)||0,
       (o.customer && o.customer.name)||"", (o.customer && o.customer.phone)||"", JSON.stringify(o), new Date().toISOString(), existing? existing.seen : (asNew===false? 1 : 0)]);
  }

  // An order as this till shows it: the server's copy with the changes still
  // waiting to be sent laid over it.
  function itredOrderView(row){
    let o; try{ o = JSON.parse(row.json); }catch(e){ o = { id:row.id, lines:[], messages:[] }; }
    o.lines = (o.lines||[]).map(l=> Object.assign({}, l));
    o.messages = (o.messages||[]).slice();
    o.seen = !!row.seen;
    o.waiting = 0; o.problems = [];
    for(const q of itredOutbox(row.id)){
      let p = {}; try{ p = JSON.parse(q.payload_json); }catch(e){}
      if(q.status==="error") o.problems.push({ uid:q.uid, kind:q.kind, error:q.error, payload:p });
      if(q.status!=="queued") continue;
      o.waiting++;
      if(q.kind==="line"){
        const l = o.lines.find(x=> x.id===q.item_id);
        if(l){ l.fulfilled = p.qty; l.note = p.note||null; l.status = itredLineStatus(p.qty, l.qty); l.waiting = true; }
      } else if(q.kind==="complete"){ o.completed_at = o.completed_at || q.created_ts; o.completeWaiting = true; }
      else if(q.kind==="message") o.messages.push({ id:q.uid, author:"vendor", body:p.body, created_at:q.created_ts, till_code:currentTillCodeSafe(), waiting:true });
      else if(q.kind==="read") o.messages.forEach(m=>{ if(m.author==="customer" && !m.vendor_read_at) m.vendor_read_at = q.created_ts; });
    }
    return o;
  }
  function currentTillCodeSafe(){ try{ return typeof currentTillCode==="function"? currentTillCode() : ""; }catch(e){ return ""; } }
  function itredLineStatus(fulfilled, requested){
    const f = Number(fulfilled)||0, r = Number(requested)||0;
    return f<=0? "outstanding" : f>=r? "fulfilled" : "partially_fulfilled";
  }
  function itredUnread(o){ return (o.messages||[]).filter(m=> m.author==="customer" && !m.vendor_read_at).length; }
  function itredOrders(){ return itredRows().map(itredOrderView); }
  function itredNewCount(){ return (one("SELECT COUNT(*) n FROM itred_orders WHERE seen=0")||{}).n||0; }
  function itredUnreadCount(){ return itredOrders().reduce((s,o)=> s + itredUnread(o), 0); }
  function itredWaitingCount(){ return (one("SELECT COUNT(*) n FROM itred_outbox WHERE status='queued'")||{}).n||0; }
  // new: not opened on this till yet; open: not completed and not closed; completed: the vendor marked it, or the customer closed it
  function itredGroup(o){ return !o.seen? "new" : (o.completed_at || o.status==="closed")? "completed" : "open"; }

  // ---- changes (queued at once, sent when online) ----
  function itredQueue(kind, orderId, itemId, payload){
    const uid = itredNewUid();
    run("INSERT INTO itred_outbox(uid, kind, order_id, item_id, payload_json, created_ts, status) VALUES(?,?,?,?,?,?,'queued')",
      [uid, kind, orderId, itemId||null, JSON.stringify(payload||{}), new Date().toISOString()]);
    return uid;
  }
  // lines: [{ id, qty, note }] — only lines that changed are queued. Checks 0..requested.
  function itredSetLines(orderId, lines){
    const row = itredRow(orderId);
    if(!row) throw new Error("That order isn't on this till.");
    const o = itredOrderView(row);
    if(o.status==="closed") throw new Error("The customer closed this order.");
    const changes = [];
    for(const x of lines||[]){
      const l = o.lines.find(y=> y.id===x.id);
      if(!l) continue;
      const raw = String(x.qty==null? "" : x.qty).trim();
      const qty = Math.round(Number(raw)*1000)/1000;
      if(raw==="" || !Number.isFinite(qty) || qty<0) throw new Error(l.name+": enter how many you supplied (0 if none).");
      if(qty>Number(l.qty)) throw new Error(l.name+": only "+itredQty(l.qty)+" ordered.");
      const note = String(x.note||"").trim().slice(0,300);
      if(qty===Number(l.fulfilled||0) && note===String(l.note||"")) continue;   // unchanged (an unanswered line reads 0, no note)
      changes.push({ id:l.id, qty, note });
    }
    // a newer change to the same line replaces a queued one
    changes.forEach(c=>{
      run("DELETE FROM itred_outbox WHERE kind='line' AND item_id=? AND status='queued'",[c.id]);
      itredQueue("line", orderId, c.id, { qty:c.qty, note:c.note });
    });
    if(changes.length) logAudit("iTred order updated", itredRef(orderId), changes.map(c=> c.qty+" supplied").join(", "));
    return changes.length;
  }
  function itredMarkComplete(orderId){
    const row = itredRow(orderId);
    if(!row) throw new Error("That order isn't on this till.");
    const o = itredOrderView(row);
    if(o.completed_at) return false;
    itredQueue("complete", orderId, null, {});
    logAudit("iTred order marked complete", itredRef(orderId), "");
    return true;
  }
  function itredReply(orderId, body){
    const text = String(body||"").trim();
    if(!text) throw new Error("Write a reply first.");
    if(text.length>1000) throw new Error("Keep it under 1000 characters.");
    if(!itredRow(orderId)) throw new Error("That order isn't on this till.");
    return itredQueue("message", orderId, null, { body:text });
  }
  // Opening a thread with unread customer messages marks them read (once).
  function itredMarkRead(orderId){
    const row = itredRow(orderId);
    if(!row || !itredUnread(itredOrderView(row))) return false;
    itredQueue("read", orderId, null, {});
    return true;
  }
  function itredMarkSeen(orderId){ run("UPDATE itred_orders SET seen=1 WHERE id=?",[orderId]); }
  function itredDiscard(uid){ run("DELETE FROM itred_outbox WHERE uid=? AND status='error'",[uid]); }

  // ---- talking to seiGEN ----
  let _itredSending = null;
  function itredSendPending(){
    if(_itredSending) return _itredSending;
    _itredSending = (async ()=>{
      if(!itredRegistered()) return { sent:0 };
      let sent = 0, stopped = "";
      for(const q of all("SELECT * FROM itred_outbox WHERE status='queued' ORDER BY created_ts, rowid")){
        let p = {}; try{ p = JSON.parse(q.payload_json); }catch(e){}
        const auth = terminalAuth();
        const r = q.kind==="line"? await terminalRpc("cl_device_itred_line_update", Object.assign(auth, { p_uid:q.uid, p_item_id:q.item_id, p_qty_fulfilled:p.qty, p_note:p.note||null }))
          : q.kind==="complete"? await terminalRpc("cl_device_itred_order_complete", Object.assign(auth, { p_uid:q.uid, p_order_id:q.order_id }))
          : q.kind==="message"? await terminalRpc("cl_device_itred_message_send", Object.assign(auth, { p_id:q.uid, p_order_id:q.order_id, p_body:p.body }))
          : await terminalRpc("cl_device_itred_messages_read", Object.assign(auth, { p_order_id:q.order_id }));
        if(!r.ok && (r.reason==="offline" || r.reason==="network" || r.reason==="rejected")){ stopped = r.reason==="rejected"? (r.message||"refused") : r.reason; break; }
        if(!r.ok && r.code==="NOT_ON_ITRED"){ setSetting("itred_on","0"); stopped = "NOT_ON_ITRED"; break; }
        if(!r.ok && r.code==="TERMINAL_INACTIVE"){ noteTerminalRefusal(r); stopped = "TERMINAL_INACTIVE"; break; }
        if(!r.ok){ run("UPDATE itred_outbox SET status='error', error=? WHERE uid=?",[String((r.data && r.data.message) || r.code || "not sent").slice(0,200), q.uid]); continue; }
        run("DELETE FROM itred_outbox WHERE uid=?",[q.uid]);
        if(r.data && r.data.order) itredStoreOrder(r.data.order);
        else if(q.kind==="message"){   // shown at once; the next pull brings the server's copy
          const row = itredRow(q.order_id);
          if(row){ const o = JSON.parse(row.json); if(!(o.messages||[]).some(m=> m.id===q.uid)){ o.messages = (o.messages||[]).concat([{ id:q.uid, author:"vendor", body:p.body, created_at:q.created_ts, till_code:currentTillCodeSafe() }]);
            o.messages.forEach(m=>{ if(m.author==="customer" && !m.vendor_read_at) m.vendor_read_at = q.created_ts; }); run("UPDATE itred_orders SET json=? WHERE id=?",[JSON.stringify(o), q.order_id]); } }
        }
        sent++;
      }
      if(stopped && stopped!=="offline" && stopped!=="network") setSetting("itred_error", stopped);
      await persist();
      return { sent, stopped };
    })().finally(()=>{ _itredSending = null; });
    return _itredSending;
  }
  let _itredPulling = null;
  function itredPull(){
    if(_itredPulling) return _itredPulling;
    _itredPulling = (async ()=>{
      if(!itredRegistered()) return { ok:false, message:"This till isn't registered with seiGEN." };
      if(!isOnline()) return { ok:false, offline:true };
      let applied = 0, fresh = 0;
      const first = getSetting("itred_on","")!=="1";
      for(let guard=0; guard<100; guard++){
        const r = await terminalRpc("cl_device_itred_orders_pull", Object.assign(terminalAuth(), { p_cursor:Number(getSetting("itred_cursor","0"))||0, p_limit:ITRED_PULL_LIMIT }), { timeoutMs:20000 });
        if(!r.ok){
          if(r.code==="NOT_ON_ITRED"){ setSetting("itred_on","0"); setSetting("itred_error",""); await persist(); return { ok:true, notOnItred:true }; }
          noteTerminalRefusal(r);
          const msg = (r.data && r.data.message) || r.message || r.code || r.reason;
          if(r.reason!=="offline" && r.reason!=="network") setSetting("itred_error", String(msg||"").slice(0,200));
          await persist();
          return { ok:false, offline: r.reason==="offline" || r.reason==="network", message:msg };
        }
        const d = r.data || {};
        db.run("BEGIN");
        try{
          for(const o of d.orders||[]){
            const isNew = !itredRow(o.id);
            // the first pull on a till brings every order the business has: only today's count as new
            itredStoreOrder(o, isNew && !(first && Date.now() - Date.parse(o.created_at||0) > 24*3600*1000));
            if(isNew) fresh++;
            applied++;
          }
          setSetting("itred_cursor", String(d.cursor||0));
          db.run("COMMIT");
        }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
        if(!d.more) break;
      }
      setSetting("itred_on","1");
      setSetting("itred_error","");
      setSetting("itred_pulled_ts", new Date().toISOString());
      await persist();
      return { ok:true, applied, fresh };
    })().finally(()=>{ _itredPulling = null; });
    return _itredPulling;
  }
  // After every successful check-in (devicecheckin.js), on reconnect and when a page opens.
  function itredAfterCheckin(){ return itredSendPending().then(()=> itredPull()).catch(()=>({ ok:false })); }

  // ---- screens ----
  const ITRED_LINE_LABEL = { fulfilled:"Fulfilled", partially_fulfilled:"Partly fulfilled", outstanding:"Outstanding" };
  const ITRED_ORDER_LABEL = { sent:"New", partially_fulfilled:"Partly fulfilled", fulfilled:"Fulfilled", closed:"Closed by the customer" };
  function itredWhen(ts){ try{ return new Date(ts).toLocaleString("en-GB", { day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }); }catch(e){ return String(ts||""); } }
  function itredStatusHtml(){
    const waiting = itredWaitingCount(), pulled = getSetting("itred_pulled_ts",""), err = getSetting("itred_error","");
    const parts = [];
    if(!isOnline()) parts.push(`<b>Offline:</b> showing orders from ${escapeHtml(pulled? itredWhen(pulled) : "the last check")}. Your changes are kept and sent when the internet is back.`);
    else if(err) parts.push(`Couldn't load orders (${escapeHtml(err)}). <button class="btn btn-sm btn-outline" data-itred-sync style="width:auto">Try again</button>`);
    else if(pulled) parts.push(`Checked ${escapeHtml(itredWhen(pulled))}.`);
    if(waiting) parts.push(`<b>${waiting}</b> change${waiting===1? "" : "s"} waiting to send.`);
    return `<div class="muted" id="itredStatus" style="margin:6px 0 10px">${parts.join(" ")} ${isOnline() && !err? `<button class="btn btn-sm btn-ghost" data-itred-sync style="width:auto">Check now</button>` : ""}</div>`;
  }
  // The search box filters by ref, customer, item, phone and date (any order).
  let itredQuery = "", itredFilter = "open";
  function itredMatches(o, q){
    return textMatches(q, { text:[itredRef(o.id), o.id.slice(0,8), (o.customer||{}).name, ...(o.lines||[]).map(l=> l.name)], phones:[(o.customer||{}).phone], dates:[o.created_at] });
  }
  function itredLinesSummary(o){
    const n = (o.lines||[]).length, done = (o.lines||[]).filter(l=> l.status==="fulfilled").length;
    return n+" item"+(n===1? "" : "s")+(done? " · "+done+" fulfilled" : "");
  }
  function renderItredOrders(body){
    const all_ = itredOrders();
    const groups = { new:[], open:[], completed:[] };
    all_.forEach(o=> groups[itredGroup(o)].push(o));
    if(itredFilter==="open" && !groups.open.length && groups.new.length) itredFilter = "new";
    const shown = groups[itredFilter].filter(o=> itredMatches(o, itredQuery));
    body.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">Orders Fulfillment</h3>
        <p class="muted" style="margin-top:0">Orders customers sent your business on iTred Market Place. Set what you supplied; the customer sees it. This doesn't change stock or make a sale: ring the sale up on Sell as usual.</p>
        ${itredStatusHtml()}
        <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">
          ${["new","open","completed"].map(g=> `<button class="btn btn-sm ${itredFilter===g? "btn-primary" : "btn-outline"}" data-itred-filter="${g}" style="width:auto">${g==="new"? "New" : g==="open"? "Open" : "Completed"} (${groups[g].length})</button>`).join("")}
        </div>
        <input class="field" id="itredSearch" type="search" placeholder="Search: order, customer, item, phone or date" value="${escapeHtml(itredQuery)}" autocomplete="off">
      </div>
      <div id="itredList">${!all_.length? `<div class="card muted" id="itredEmpty">No iTred orders yet. Orders customers send you on iTred Market Place appear here after the till checks in.</div>`
        : !shown.length? `<div class="card muted">No ${itredFilter} orders${itredQuery? " match \""+escapeHtml(itredQuery)+"\"" : ""}.</div>`
        : shown.map(o=> `<div class="card" data-itred-open="${escapeHtml(o.id)}" style="cursor:pointer" role="button" tabindex="0">
            <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
              <div style="min-width:0"><b>${escapeHtml((o.customer||{}).name || "A customer")}</b> <span class="muted">${escapeHtml(itredRef(o.id))} · ${escapeHtml(itredWhen(o.created_at))}</span>
                <div class="muted">${escapeHtml(itredLinesSummary(o))}${o.waiting? " · <b>waiting to send</b>" : ""}${itredUnread(o)? " · <b>"+itredUnread(o)+" new message"+(itredUnread(o)===1? "" : "s")+"</b>" : ""}${o.problems.length? " · <b style=\"color:var(--danger)\">not sent</b>" : ""}</div></div>
              <span class="badge" style="flex:none">${escapeHtml(!o.seen? "New" : o.completed_at? "Completed" : ITRED_ORDER_LABEL[o.status]||o.status)}</span>
            </div></div>`).join("")}</div>`;
    body.querySelectorAll("[data-itred-filter]").forEach(b=> b.onclick = ()=>{ itredFilter = b.dataset.itredFilter; renderItredOrders(body); });
    const s = body.querySelector("#itredSearch");
    s.oninput = ()=>{ itredQuery = s.value; const pos = s.selectionStart; renderItredOrders(body); const again = body.querySelector("#itredSearch"); again.focus(); try{ again.setSelectionRange(pos,pos); }catch(e){} };
    body.querySelectorAll("[data-itred-open]").forEach(c=>{ c.onclick = ()=> openItredOrder(c.dataset.itredOpen, ()=> renderItredOrders(body)); c.onkeydown = (e)=>{ if(e.key==="Enter") c.onclick(); }; });
    itredWireSync(body, ()=> renderItredOrders(body));
  }
  function itredWireSync(scope, redraw){
    scope.querySelectorAll("[data-itred-sync]").forEach(b=> b.onclick = async ()=>{
      b.disabled = true; b.textContent = "Checking…";
      setSetting("itred_error","");
      await itredAfterCheckin();
      redraw();
    });
  }
  // Sent in the background; the page redraws when it's done.
  function itredSyncSoon(redraw){ if(!isOnline() || !itredRegistered()) return; itredAfterCheckin().then(()=>{ if(redraw) redraw(); }); }

  function itredLineRowHtml(o, l){
    const closed = o.status==="closed";
    const answer = l.dispute? `<div style="color:var(--danger)"><b>Customer:</b> ${escapeHtml(l.dispute)}</div>` : l.confirmed_at? `<div class="muted">Customer confirmed</div>` : "";
    return `<div class="card" data-itred-line="${escapeHtml(l.id)}" style="margin:8px 0;padding:10px">
      <div class="row" style="justify-content:space-between;gap:8px"><div style="min-width:0"><b>${escapeHtml(l.name)}</b>${l.custom? ` <span class="muted">(not listed: to quote)</span>` : ""}
        <div class="muted">Ordered ${escapeHtml(itredQty(l.qty))}${l.unit_price!=null? " · "+escapeHtml((l.currency||"")+" "+Number(l.unit_price).toFixed(2))+" each" : ""}</div></div>
        <span class="badge" style="flex:none">${escapeHtml(ITRED_LINE_LABEL[l.status]||l.status)}${l.waiting? " · waiting to send" : ""}</span></div>
      ${answer}
      <div class="row" style="gap:6px;align-items:flex-end;margin-top:6px;flex-wrap:wrap">
        <label style="flex:1;min-width:120px">Supplied<input class="field" type="number" inputmode="decimal" min="0" max="${escapeHtml(itredQty(l.qty))}" step="any" data-itred-qty value="${escapeHtml(itredQty(l.fulfilled))}" ${closed? "disabled" : ""} aria-label="Supplied of ${escapeHtml(l.name)}"></label>
        <button class="btn btn-sm btn-outline" data-itred-all style="width:auto" ${closed? "disabled" : ""}>All</button>
        <button class="btn btn-sm btn-outline" data-itred-none style="width:auto" ${closed? "disabled" : ""}>None</button>
      </div>
      <input class="field" data-itred-note maxlength="300" placeholder="Note for the customer (optional)" value="${escapeHtml(l.note||"")}" ${closed? "disabled" : ""} style="margin-top:6px" aria-label="Note on ${escapeHtml(l.name)}">
    </div>`;
  }
  function itredThreadHtml(o){
    const msgs = (o.messages||[]).slice().sort((a,b)=> String(a.created_at).localeCompare(String(b.created_at)));
    return `<div id="itredThread">${msgs.length? msgs.map(m=> `<div class="card" style="margin:6px 0;padding:8px 10px;${m.author==="vendor"? "margin-left:24px;background:var(--surface-2,#f4f6f8)" : "margin-right:24px"}">
        <div class="muted" style="font-size:12px">${m.author==="vendor"? "You"+(m.till_code? " ("+escapeHtml(m.till_code)+")" : "") : escapeHtml((o.customer||{}).name || "Customer")} · ${escapeHtml(itredWhen(m.created_at))}${m.waiting? " · waiting to send" : ""}</div>
        <div style="white-space:pre-wrap">${escapeHtml(m.body)}</div></div>`).join("") : `<p class="muted">No messages on this order yet.</p>`}
      <textarea class="field" id="itredReplyText" maxlength="1000" placeholder="Reply to ${escapeHtml((o.customer||{}).name || "the customer")}…" rows="2" style="margin-top:6px"></textarea>
      <button class="btn btn-primary" id="itredReplySend" style="margin-top:6px">Send reply</button>
    </div>`;
  }
  function openItredOrder(orderId, redraw){
    const row = itredRow(orderId);
    if(!row) return;
    if(!row.seen){ itredMarkSeen(orderId); persist(); }
    const o = itredOrderView(itredRow(orderId));
    const c = o.customer || {};
    const closed = o.status==="closed";
    const wrap = openModal("Order " + itredRef(o.id), `
      <div class="muted">${escapeHtml(itredWhen(o.created_at))} · ${escapeHtml(o.completed_at? "Completed" : ITRED_ORDER_LABEL[o.status]||o.status)}${o.completeWaiting? " (waiting to send)" : ""}</div>
      <p style="margin:8px 0"><b>${escapeHtml(c.name || "A customer")}</b>${c.phone? ` · ${escapeHtml(c.phone)} <a href="${escapeHtml(waLink(c.phone, "Hello "+(c.name||"")+", about your iTred order "+itredRef(o.id)+": "))}" target="_blank" rel="noopener" id="itredWa">WhatsApp</a>` : ""}</p>
      ${o.problems.map(p=> `<div class="card" style="border-color:var(--danger);padding:8px" data-itred-problem="${escapeHtml(p.uid)}"><b>Not sent:</b> ${escapeHtml(p.error)}
        <button class="btn btn-sm btn-outline" data-itred-discard="${escapeHtml(p.uid)}" style="width:auto;margin-left:8px">Discard</button></div>`).join("")}
      ${closed? `<p class="muted">The customer closed this order, so it can't be changed.</p>` : ""}
      <div id="itredLines">${(o.lines||[]).map(l=> itredLineRowHtml(o, l)).join("")}</div>
      <div id="itredMsg" role="alert" style="color:var(--danger);font-weight:600;margin:6px 0"></div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="itredSave" ${closed? "disabled" : ""}>Save</button>
        <button class="btn btn-outline" id="itredComplete" ${closed || o.completed_at? "disabled" : ""}>${o.completed_at? "Marked complete" : "Mark complete"}</button>
      </div>
      <h4 style="margin:14px 0 4px">Messages</h4>
      ${itredThreadHtml(o)}`);
    const msg = wrap.querySelector("#itredMsg");
    const after = ()=>{ persist(); if(redraw) redraw(); itredSyncSoon(()=>{ if(redraw) redraw(); }); };
    wrap.querySelectorAll("[data-itred-line]").forEach(box=>{
      const l = o.lines.find(x=> x.id===box.dataset.itredLine), input = box.querySelector("[data-itred-qty]");
      box.querySelector("[data-itred-all]").onclick = ()=>{ input.value = itredQty(l.qty); };
      box.querySelector("[data-itred-none]").onclick = ()=>{ input.value = "0"; };
    });
    wrap.querySelector("#itredSave").onclick = ()=>{
      const lines = [...wrap.querySelectorAll("[data-itred-line]")].map(b=> ({ id:b.dataset.itredLine, qty:b.querySelector("[data-itred-qty]").value, note:b.querySelector("[data-itred-note]").value }));
      try{
        const n = itredSetLines(o.id, lines);
        wrap.remove(); after();
        if(typeof catToast==="function") catToast(n?"Saved: "+n+" item"+(n===1? "" : "s")+(isOnline()? "" : ". Sent when you're back online.") : "Nothing changed.");
      }catch(e){ msg.textContent = e.message || String(e); }
    };
    wrap.querySelector("#itredComplete").onclick = ()=>{
      if(!confirm("Mark order "+itredRef(o.id)+" complete? The customer sees it as completed by you.")) return;
      try{ itredMarkComplete(o.id); wrap.remove(); after(); }catch(e){ msg.textContent = e.message || String(e); }
    };
    wrap.querySelector("#itredReplySend").onclick = ()=>{
      try{ itredReply(o.id, wrap.querySelector("#itredReplyText").value); wrap.remove(); after(); openItredOrder(orderId, redraw); }
      catch(e){ msg.textContent = e.message || String(e); }
    };
    wrap.querySelectorAll("[data-itred-discard]").forEach(b=> b.onclick = ()=>{ itredDiscard(b.dataset.itredDiscard); wrap.remove(); after(); openItredOrder(orderId, redraw); });
    if(itredMarkRead(o.id)) after();
    return wrap;
  }

  // Marketplace Feedback: every order's thread, unread first, then newest.
  function renderItredFeedback(body){
    const list = itredOrders().filter(o=> (o.messages||[]).length)
      .map(o=> ({ o, unread:itredUnread(o), last:(o.messages||[]).reduce((m,x)=> String(x.created_at)>m? String(x.created_at) : m, "") }))
      .sort((a,b)=> (b.unread>0) - (a.unread>0) || b.last.localeCompare(a.last));
    body.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">Marketplace Feedback</h3>
        <p class="muted" style="margin-top:0">Comments customers wrote on their iTred orders. Your reply goes to the customer, under the order in iTred.</p>
        ${itredStatusHtml()}
      </div>
      ${list.length? list.map(({ o, unread, last })=>{
        const m = (o.messages||[]).filter(x=> x.created_at===last).pop() || {};
        return `<div class="card" data-itred-open="${escapeHtml(o.id)}" style="cursor:pointer" role="button" tabindex="0">
          <div class="row" style="justify-content:space-between;gap:8px"><div style="min-width:0"><b>${escapeHtml((o.customer||{}).name || "A customer")}</b> <span class="muted">${escapeHtml(itredRef(o.id))} · ${escapeHtml(itredWhen(last))}</span>
            <div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.author==="vendor"? "You: " : ""}${escapeHtml(m.body||"")}</div></div>
            ${unread? `<span class="badge" style="flex:none">${unread} new</span>` : ""}</div></div>`; }).join("")
        : `<div class="card muted" id="itredFeedbackEmpty">No comments from customers yet.</div>`}`;
    body.querySelectorAll("[data-itred-open]").forEach(c=>{ c.onclick = ()=> openItredOrder(c.dataset.itredOpen, ()=> renderItredFeedback(body)); c.onkeydown = (e)=>{ if(e.key==="Enter") c.onclick(); }; });
    itredWireSync(body, ()=> renderItredFeedback(body));
  }
  // The More tabs (router.js) open with a fresh send + pull.
  function renderItredMoreTab(tab, body){
    const draw = ()=> tab==="itredfeedback"? renderItredFeedback(body) : renderItredOrders(body);
    draw();
    itredSyncSoon(()=>{ if(document.body.contains(body)) draw(); });
  }
  function itredMoreLabel(tab){
    if(tab==="itredfeedback"){ const n = itredUnreadCount(); return "Marketplace Feedback" + (n? " ("+n+" new)" : ""); }
    const n = itredNewCount(); return "Orders Fulfillment" + (n? " ("+n+" new)" : "");
  }

  // Sell (phone and desktop): "2 new iTred orders", tapping opens Orders Fulfillment.
  function itredBannerHtml(){
    if(!itredAvailable()) return "";
    const n = itredNewCount();
    if(!n) return "";
    return `<div class="card" id="itredBanner" style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:8px">
      <b>${n} new iTred order${n===1? "" : "s"}</b>
      <button class="btn btn-sm btn-primary" data-itred-banner style="width:auto;flex:none">Open</button></div>`;
  }
  function wireItredBanner(){
    document.querySelectorAll("[data-itred-banner]").forEach(b=> b.onclick = ()=>{ route = "more"; moreTab = "itredorders"; itredFilter = "new"; render(); });
  }
