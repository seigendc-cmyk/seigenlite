  // ================== Stock requests and recalls (v37, owner decisions 53 and 54) ==================
  // docs/stock-control/v37-design.md §2-3. A branch asks main for stock (B3, as
  // designed); main approves all, part or rejects with a reason; seiGEN then holds
  // a draft DN for the approved quantities (v37.1, decision 63): "Open draft DN"
  // at main opens Dispatch pre-filled, never above what was approved, and only the
  // first sender's DN counts; a draft is sent or closed with a reason, never deleted.
  // The bell reminds main while a draft waits (decision 64). The normal DN -> GRV
  // flow follows. Main recalls stock from a branch; the branch sends it
  // back with a normal DN (short lines with a reason); main's GRV receives it. A
  // recall alone never moves stock. The customer notepad (requests.js) is separate.

  let srqTab = "requests";
  const srqFilter = { status:"", branch:"", from:"", to:"", q:"" };
  const rclFilter = { status:"", q:"" };
  const SRQ_STATUS = { pending:"Pending", approved:"Approved", part_approved:"Part-approved", rejected:"Rejected", dispatched:"Dispatched", received:"Received",
    not_dispatched:"Approved, not dispatched" };   // v37.1: its draft was closed with a reason (decision 63)
  const RCL_STATUS = { open:"Open", partly_sent:"Partly sent", sent:"Sent", received:"Received", cancelled:"Cancelled" };
  const RCL_REASONS = [["expiring","Expiring"],["overstock","Overstock"],["move","Move to another branch"],["quality","Quality"],["other","Other"]];
  const srqCan = (r)=> typeof can!=="function" || can(r);
  function srqAvailable(){ return typeof scAvailable==="function" && scAvailable() && (srqCan("request_stock") || srqCan("review_requisitions") || srqCan("recall_stock") || srqCan("m.dispatch")); }
  function srqToday(){ return businessDateOf(); }
  function srqStatusChip(s, overdue){
    const t = overdue? "Overdue" : SRQ_STATUS[s] || RCL_STATUS[s] || s;
    const c = overdue || s==="rejected" || s==="not_dispatched"? "#b42318" : s==="pending" || s==="open"? "#b54708" : s==="received"? "#067647" : "#344054";
    return `<span class="srq-status" style="font-size:11.5px;font-weight:700;color:${c}">${escapeHtml(t)}</span>`;
  }
  function rclOverdue(q){ return q.status==="open" && !!q.due_date && q.due_date < srqToday(); }
  function srqWaitingNote(id){
    const w = scWaitingFor(id), r = scRefusedFor(id);
    return (w.length? `<div class="muted srq-waiting" style="font-size:12px">⏳ Waiting to send to seiGEN${w[0].error? ": "+escapeHtml(w[0].error) : ""}</div>` : "")
      + r.map(x=>`<div class="srq-refused" style="font-size:12px;color:#b42318">seiGEN didn't take it: ${escapeHtml(x.error||x.code)}</div>`).join("");
  }

  // ---- the screen (More → Stock requests) ----
  function renderStockCtl(main){
    const tabs = [{ id:"requests", label:"Stock requests" }, { id:"recalls", label:"Recalls" }];
    main.innerHTML = `<div style="display:flex;gap:6px;margin-bottom:10px">${tabs.map(t=>`<button class="btn btn-sm ${t.id===srqTab? "btn-primary" : "btn-outline"}" data-srq-tab="${t.id}">${t.label}</button>`).join("")}
      <button class="btn btn-sm btn-ghost" id="srqRefresh" style="margin-left:auto">↻ Refresh</button></div><div id="srqBody"></div>`;
    main.querySelectorAll("[data-srq-tab]").forEach(b=> b.onclick = ()=>{ srqTab = b.dataset.srqTab; render(); });
    main.querySelector("#srqRefresh").onclick = async (e)=>{ e.target.disabled = true; await scTick(); render(); };
    const body = main.querySelector("#srqBody");
    if(srqTab==="recalls") renderRecalls(body); else renderRequestsList(body);
  }

  // ---- stock requests ----
  function srqVisible(){
    // the requesting branch sees its own; reviewers and main see every branch's (§R9)
    const mine = scMyBranch();
    return scRequests().filter(q=> q.from_branch_id===mine || srqCan("review_requisitions") || scIsMain());
  }
  function srqFiltered(){
    const f = srqFilter;
    return srqVisible().filter(q=>{
      if(f.status && q.status!==f.status) return false;
      if(f.branch && q.from_branch_id!==f.branch) return false;
      const d = businessDateOf(q.created_ts||q.created_at);
      if(f.from && d<f.from) return false;
      if(f.to && d>f.to) return false;
      return textMatches(f.q, { text:[q.req_no, q.from_branch, q.reason, q.requested_by, q.decided_by, q.dn_display, q.grv_display].concat((q.lines||[]).map(l=>l.name+" "+(l.code||""))), dates:[q.created_ts] });
    });
  }
  function renderRequestsList(main){
    const rows = srqFiltered(), branches = scBranches().filter(b=>!b.is_main);
    const canNew = srqCan("request_stock") && !scIsMain();
    main.innerHTML = `
      ${canNew? `<button class="btn btn-primary" id="srqNew" style="margin-bottom:10px">+ Request stock from main</button>` : ""}
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:end;margin-bottom:8px">
        <select class="field" id="srqStatus" style="margin:0;max-width:170px"><option value="">Every status</option>${Object.entries(SRQ_STATUS).map(([k,v])=>`<option value="${k}" ${srqFilter.status===k? "selected" : ""}>${v}</option>`).join("")}</select>
        ${branches.length>1 || scIsMain()? `<select class="field" id="srqBranch" style="margin:0;max-width:170px"><option value="">Every branch</option>${branches.map(b=>`<option value="${escapeHtml(b.id)}" ${srqFilter.branch===b.id? "selected" : ""}>${escapeHtml(b.name)}</option>`).join("")}</select>` : ""}
        <input class="field" type="date" id="srqFrom" value="${escapeHtml(srqFilter.from)}" style="margin:0;max-width:150px" title="From">
        <input class="field" type="date" id="srqTo" value="${escapeHtml(srqFilter.to)}" style="margin:0;max-width:150px" title="To">
      </div>
      <div class="search-wrap"><span class="ic">🔎</span><input class="field" id="srqSearch" placeholder="Search: number, branch, item, reason…" value="${escapeHtml(srqFilter.q)}"></div>
      <div id="srqList">${srqListHtml(rows)}</div>`;
    const set = (k, v)=>{ srqFilter[k] = v; main.querySelector("#srqList").innerHTML = srqListHtml(srqFiltered()); wireSrqRows(main); };
    main.querySelector("#srqStatus").onchange = (e)=> set("status", e.target.value);
    const br = main.querySelector("#srqBranch"); if(br) br.onchange = (e)=> set("branch", e.target.value);
    main.querySelector("#srqFrom").onchange = (e)=> set("from", e.target.value);
    main.querySelector("#srqTo").onchange = (e)=> set("to", e.target.value);
    main.querySelector("#srqSearch").oninput = (e)=> set("q", e.target.value);
    const nb = main.querySelector("#srqNew"); if(nb) nb.onclick = ()=> openRequestCreate();
    wireSrqRows(main);
  }
  function srqListHtml(rows){
    if(!rows.length) return `<p class="muted" id="srqNone">No stock requests${srqFilter.status||srqFilter.q||srqFilter.branch? " match" : " yet"}.</p>`;
    return `<div class="card" style="overflow-x:auto;padding:4px"><table class="simple" id="srqTable">
      <tr><th>Request</th><th>From</th><th>Date</th><th>Needed by</th><th>Items</th><th>Status</th></tr>
      ${rows.map(q=>`<tr class="srq-row" data-srq="${escapeHtml(q.id)}" style="cursor:pointer" title="Tap or double-click for its history">
        <td><b>${escapeHtml(q.req_no)}</b>${q._local? ` <span class="muted" style="font-size:11px">⏳</span>` : ""}</td><td>${escapeHtml(q.from_branch||scBranchName(q.from_branch_id))}</td>
        <td>${escapeHtml(new Date(q.created_ts||q.created_at).toLocaleDateString())}</td><td>${escapeHtml(q.needed_by||"—")}</td>
        <td>${(q.lines||[]).length}</td><td>${srqStatusChip(q.status)}</td></tr>`).join("")}</table></div>`;
  }
  function wireSrqRows(main){
    main.querySelectorAll("[data-srq]").forEach(tr=>{ tr.ondblclick = ()=> openRequestHistory(tr.dataset.srq); tr.onclick = ()=> openRequestHistory(tr.dataset.srq); });
  }
  // main's stock of a product (seiGEN's branch figures; this till's own when it is at main)
  function srqMainQty(p){
    if(scIsMain()) return p.stock;
    const mainB = typeof bsBranches==="function"? bsBranches().find(b=>b.is_main) : null;
    const q = mainB && typeof bsBranchQty==="function"? bsBranchQty(mainB, p) : null;
    return q? q.qty : null;
  }
  function openRequestCreate(){
    const branch = currentBranch();
    const products = all("SELECT * FROM products WHERE branch=? AND COALESCE(active,1)=1 ORDER BY name",[branch]);
    const lines = []; let q = "";
    const wrap = openModal("Request stock from main", `<div id="rcBody"></div>`);
    const body = wrap.querySelector("#rcBody");
    const draw = (keepFocus)=>{
      const matches = q.trim()? productSearch(products, q).slice(0,8) : [];
      body.innerHTML = `
        <label style="margin-top:0">Add items</label><input class="field" id="rcSearch" placeholder="Search by name or code" value="${escapeHtml(q)}" autocomplete="off">
        ${matches.map(p=>{ const mq = srqMainQty(p); return `<button type="button" class="card" data-add="${p.id}" style="display:block;width:100%;text-align:left;padding:6px;margin:4px 0">${escapeHtml(p.name)} <span class="muted">${escapeHtml(p.sku||"")} · main has ${mq==null? "?" : mq}</span></button>`; }).join("")}
        <div style="margin-top:8px">${lines.map((l,i)=>`<div class="card" style="padding:6px;margin-bottom:4px;display:flex;gap:6px;align-items:center">
          <div style="flex:1"><b>${escapeHtml(l.p.name)}</b><div class="muted" style="font-size:11.5px">${escapeHtml(l.p.sku||"")} · here ${l.p.stock} · main has <span class="rc-main">${l.main==null? "?" : l.main}</span></div></div>
          <input class="field" data-q="${i}" inputmode="numeric" value="${escapeHtml(l.qty)}" style="width:70px;margin:0"><button class="close-x" data-del="${i}">✕</button></div>`).join("")}</div>
        <label>Reason</label><input class="field" id="rcReason" maxlength="200" value="${escapeHtml(wrap._reason||"")}" placeholder="e.g. Running out before the weekend">
        <label>Needed by</label><input class="field" id="rcNeed" type="date" value="${escapeHtml(wrap._need||"")}">
        <div id="rcErr" style="color:#b42318;font-size:12.5px"></div>
        <button class="btn btn-primary" id="rcSave">Send request</button>`;
      const s = body.querySelector("#rcSearch");
      s.oninput = ()=>{ q = s.value; wrap._reason = body.querySelector("#rcReason").value; wrap._need = body.querySelector("#rcNeed").value; draw(true); };
      if(keepFocus){ s.focus(); try{ s.setSelectionRange(s.value.length, s.value.length); }catch(e){} }
      body.querySelectorAll("[data-add]").forEach(b=> b.onclick = ()=>{ const p = products.find(x=>x.id===+b.dataset.add); if(!lines.some(l=>l.p.id===p.id)) lines.push({ p, qty:"1", main:srqMainQty(p) }); q = ""; draw(); });
      body.querySelectorAll("[data-q]").forEach(inp=> inp.oninput = ()=>{ lines[+inp.dataset.q].qty = inp.value; });
      body.querySelectorAll("[data-del]").forEach(b=> b.onclick = ()=>{ lines.splice(+b.dataset.del, 1); draw(); });
      body.querySelector("#rcSave").onclick = ()=>{
        const reason = body.querySelector("#rcReason").value.trim(), need = body.querySelector("#rcNeed").value;
        const r = srqCreate(lines.map(l=>({ product:l.p, qty:l.qty })), reason, need);
        if(!r.ok){ body.querySelector("#rcErr").textContent = r.message; return; }
        persist(); scSoon(); wrap.remove(); render();
      };
    };
    draw();
  }
  // -> { ok, id, req_no } | { ok:false, message }
  function srqCreate(lines, reason, neededBy){
    if(!lines.length) return { ok:false, message:"Add at least one item." };
    for(const l of lines){ if(!/^\d+$/.test(String(l.qty).trim()) || Number(l.qty)<1) return { ok:false, message:l.product.name+": a whole number of 1 or more." }; }
    if(!String(reason||"").trim()) return { ok:false, message:"Give a reason." };
    if(neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) return { ok:false, message:"Needed by: a date." };
    const id = scNewUid(), ts = new Date().toISOString();
    let no;
    db.run("BEGIN");
    try{
      no = reserveDocNumber("SRQ");
      const ls = lines.map((l,i)=>({ line_no:i+1, product_key:scProductKey(l.product), code:l.product.sku||"", name:l.product.name, qty:Number(l.qty), approved_qty:null }));
      const doc = { id, req_no:no.text, from_branch_id:scMyBranch(), from_branch:currentBranch(), to_branch_id:scMainBranch(), to_branch:scBranchName(scMainBranch()),
        terminal_id:scMyTerminal(), requested_by:scWho(), reason:String(reason).trim(), needed_by:neededBy||null, status:"pending", created_ts:ts, lines:ls,
        log:[{ at:ts, by:scWho(), action:"requested" }] };
      scSaveDoc("sc_requests", doc, true);
      scQueue("request_create", { id, req_no:no.text, reason:doc.reason, needed_by:doc.needed_by, staff_id:scStaffId(), lines:ls.map(l=>({ product_key:l.product_key, code:l.code, name:l.name, qty:l.qty })) }, id);
      logAudit("Stock request", "", no.text+": "+ls.length+" item"+(ls.length===1? "" : "s")+" from main");
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} return { ok:false, message:String(e.message||e) }; }
    return { ok:true, id, req_no:no.text };
  }
  // action: approve | part | reject; lines: { line_no: approved qty } (part) -> { ok } | { ok:false, message }
  function srqDecide(id, action, note, lines){
    const q = scRequest(id);
    if(!q || q.status!=="pending") return { ok:false, message:"That request isn't pending any more." };
    if(!srqCan("review_requisitions")) return { ok:false, message:"Reviewing needs the Review stock requests right." };
    if(action==="reject" && !String(note||"").trim()) return { ok:false, message:"Give the reason for rejecting." };
    let ls = [];
    if(action==="part"){
      ls = (q.lines||[]).map(l=>({ line_no:l.line_no, approved_qty:Number(lines && lines[l.line_no]) }));
      for(const l of ls){ const src = q.lines.find(x=>x.line_no===l.line_no); if(!Number.isInteger(l.approved_qty) || l.approved_qty<0 || l.approved_qty>src.qty) return { ok:false, message:src.name+": approve 0 to "+src.qty+"." }; }
      if(!ls.some(l=>l.approved_qty>0)) return { ok:false, message:"Nothing approved: reject it with a reason instead." };
    }
    const status = action==="approve"? "approved" : action==="reject"? "rejected" : (ls.every(l=> l.approved_qty===q.lines.find(x=>x.line_no===l.line_no).qty)? "approved" : "part_approved");
    q.lines.forEach(l=>{ l.approved_qty = action==="approve"? l.qty : action==="reject"? 0 : ls.find(x=>x.line_no===l.line_no).approved_qty; });
    Object.assign(q, { status, decided_by:scWho(), decided_at:new Date().toISOString(), decision_note:String(note||"").trim()||null });
    (q.log = q.log||[]).push({ at:q.decided_at, by:q.decided_by, action:status });
    db.run("BEGIN");
    try{
      scSaveDoc("sc_requests", q, q._local);
      scQueue("request_decide", { id, action, note:q.decision_note, lines:ls }, id);
      logAudit("Stock request "+status, "", q.req_no+(q.decision_note? ": "+q.decision_note : ""));
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} return { ok:false, message:String(e.message||e) }; }
    return { ok:true, status };
  }
  // ---- the draft DN on seiGEN (v37.1, decision 63) ----
  // A request's draft is waiting while seiGEN holds it open and the request is still approved.
  function srqDraftOpen(q){ return !!(q && q.draft && q.draft.status==="open" && (q.status==="approved" || q.status==="part_approved")); }
  function srqOpenDrafts(){ return scRequests().filter(srqDraftOpen).sort((a,b)=> String(a.draft.approved_at||"").localeCompare(String(b.draft.approved_at||""))); }
  // Main's Dispatch: someone with the Dispatch right on a main till (or seat)
  function srqCanSendDrafts(){ return srqAvailable() && scIsMain() && srqCan("m.dispatch"); }
  function srqCanCloseDraft(){ return srqCan("review_requisitions") || (typeof staffOwnerOrAdmin==="function" && staffOwnerOrAdmin()); }
  // The draft opened in Dispatch: pre-filled with the approved quantities, linked to the request.
  // pre.draft: the most each product may go out with (approved), by product id; lines can only go down or be removed.
  function srqDispatchPrefill(q){
    const missing = [], max = {};
    const lines = (q.lines||[]).filter(l=>(l.approved_qty||0)>0).map(l=>{
      const p = scProductByKey(l.product_key);
      if(!p){ missing.push(l.name); return null; }
      max[p.id] = { line_no:l.line_no, approved:l.approved_qty, name:l.name };
      return { product:p, qty:l.approved_qty };
    }).filter(Boolean);
    return { toBranch:q.from_branch || scBranchName(q.from_branch_id), lines, link:{ type:"request", id:q.id }, title:"Draft DN for "+q.req_no, internalRef:q.req_no,
      draft:{ requestId:q.id, reqNo:q.req_no, max, lineNos:(q.lines||[]).map(l=>l.line_no) },
      note:"Draft Delivery Note for stock request "+q.req_no+" from "+(q.from_branch||"")+" ("+(SRQ_STATUS[q.status]||q.status)+"). You can lower a quantity or remove a line, never send more than was approved. Stock leaves this branch only when you send it."
        +(missing.length? " Not on this till: "+missing.join(", ")+"." : ""), missing };
  }
  // The quantities a draft goes out with, per request line (a line left out: 0). -> [{ line_no, sent_qty }]
  function srqDraftLines(pre, lines){
    const sent = {};
    lines.forEach(l=>{ const m = pre.draft.max[l.product.id]; if(m) sent[m.line_no] = (sent[m.line_no]||0) + Number(l.qty); });
    return pre.draft.lineNos.map(n=>({ line_no:n, sent_qty:sent[n]||0 }));
  }
  // Problems with what is about to be sent from a draft (Dispatch's own checks come first).
  function srqDraftProblems(pre, lines){
    const errs = [];
    const seen = {};
    lines.forEach(l=>{
      const m = pre.draft.max[l.product.id];
      if(!m){ errs.push(l.product.name+" isn't on the approved request: a draft can't add products."); return; }
      seen[m.line_no] = (seen[m.line_no]||0) + (Number(l.qty)||0);
      if(seen[m.line_no] > m.approved) errs.push(l.product.name+": "+m.approved+" approved, so no more than "+m.approved+" can go.");
    });
    return errs;
  }
  // Before the DN is made (online): seiGEN gives the draft to the first sender only. -> { ok, id } | { ok:false, message, code }
  async function srqDraftClaim(pre, lines){
    if(!isOnline()) return { ok:false, code:"offline", message:"Sending a draft needs the internet, so that only one Delivery Note is made from it. Connect and try again." };
    const id = scNewUid();
    const r = await terminalRpc("cl_device_srq_draft_claim", Object.assign(terminalAuth(), { p_request_id:pre.draft.requestId, p_dispatch_id:id, p_by:scWho(), p_lines:srqDraftLines(pre, lines) }), { timeoutMs:20000 });
    if(r.ok) return { ok:true, id };
    const msg = (r.data && r.data.message) || r.message || r.code || r.reason || "seiGEN didn't answer";
    if(r.code==="DRAFT_SENT" || r.code==="DRAFT_CLOSED"){ await scTick().catch(()=>{}); }   // its new state, for the request's screen
    return { ok:false, code:r.code||r.reason, message:String(msg) };
  }
  // The DN couldn't be made after all (its stock check): the draft is open again on seiGEN.
  function srqDraftRelease(pre, id){
    if(!pre || !pre.draft || !id || !isOnline()) return Promise.resolve();
    return terminalRpc("cl_device_srq_draft_release", Object.assign(terminalAuth(), { p_request_id:pre.draft.requestId, p_dispatch_id:id }), { timeoutMs:20000 }).catch(()=>{});
  }
  // Close a draft without sending it: Review stock requests or an Owner/Admin, with a reason (seiGEN checks the same).
  function srqCloseDraft(id, note){
    const q = scRequest(id);
    if(!srqDraftOpen(q)) return { ok:false, message:"That draft isn't waiting any more." };
    if(!srqCanCloseDraft()) return { ok:false, message:"Closing a draft needs the Review stock requests right, or an Owner or Admin." };
    if(!String(note||"").trim()) return { ok:false, message:"Give the reason for closing the draft." };
    const ts = new Date().toISOString(), reason = String(note).trim().slice(0, 200);
    Object.assign(q.draft, { status:"closed", closed_by:scWho(), close_reason:reason, closed_at:ts });
    q.status = "not_dispatched";
    (q.log = q.log||[]).push({ at:ts, by:scWho(), action:"not_dispatched", detail:{ note:reason } });
    db.run("BEGIN");
    try{
      scSaveDoc("sc_requests", q, q._local);
      scQueue("draft_close", { id, note:reason }, id);
      logAudit("Stock request draft closed", "", q.req_no+": "+reason);
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} return { ok:false, message:String(e.message||e) }; }
    return { ok:true };
  }
  function srqWhen(ts){ try{ return new Date(ts).toLocaleString([], { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }); }catch(e){ return String(ts||""); } }
  // Dispatch at main → "Drafts from stock requests"
  function openDraftsList(){
    const wrap = openModal("Drafts from stock requests", `<div id="srqDrafts"></div>`);
    const body = wrap.querySelector("#srqDrafts");
    const draw = ()=>{
      const rows = srqOpenDrafts();
      body.innerHTML = rows.length? `<p class="muted" style="margin:0 0 6px;font-size:12.5px">Approved stock requests waiting to be sent. A draft moves no stock: stock leaves only when you send its Delivery Note.</p>
        ${rows.map(q=>`<div class="card srq-draft" data-draft="${escapeHtml(q.id)}" style="padding:8px;margin-bottom:6px">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:160px"><b>${escapeHtml(q.req_no)}</b> for ${escapeHtml(q.from_branch||scBranchName(q.from_branch_id))}
            <div class="muted" style="font-size:12px">${srqStatusChip(q.status)} · approved ${escapeHtml(srqWhen(q.draft.approved_at||q.decided_at))}${q.draft.approved_by? " by "+escapeHtml(q.draft.approved_by) : ""} · ${(q.lines||[]).filter(l=>(l.approved_qty||0)>0).length} item(s)</div></div>
            <button class="btn btn-sm btn-primary" data-open-draft="${escapeHtml(q.id)}">Open draft DN</button></div></div>`).join("")}`
        : `<p class="muted" id="srqNoDrafts">No drafts waiting.</p>`;
      body.querySelectorAll("[data-open-draft]").forEach(b=> b.onclick = ()=>{
        const r = srqOpenDraft(b.dataset.openDraft);
        if(!r.ok) return alert(r.message);
        wrap.remove();
      });
    };
    draw();
  }
  // -> { ok } | { ok:false, message }
  function srqOpenDraft(id){
    const q = scRequest(id);
    if(!srqDraftOpen(q)) return { ok:false, message:"That draft isn't waiting any more: it has been sent or closed." };
    if(!srqCanSendDrafts()) return { ok:false, message:"Sending a draft needs the Dispatch right on a main-branch till." };
    const pre = srqDispatchPrefill(q);
    if(!pre.lines.length) return { ok:false, message:"None of the approved items is on this till." };
    openDispatchScreen(pre);
    return { ok:true };
  }

  // ---- the dispatch reminder (v37.1, decision 64) ----
  const SRQ_REMIND_DEFAULT = { delay_hours:8, repeat_hours:24 };
  function srqReminderSettings(){ const s = scJson(getSetting("srq_settings",""), null); return s && s.delay_hours? s : Object.assign({}, SRQ_REMIND_DEFAULT); }
  // The reminders due now for one open draft: 0 before the delay, then 1, 2, ... one per repeat (or just 1 with "Don't repeat").
  // Measured from the approval, with the timers in force now (a change applies to drafts already waiting).
  function srqReminderCount(q, nowMs, s){
    if(!srqDraftOpen(q)) return 0;
    const at = Date.parse(q.draft.approved_at || q.decided_at || ""); if(!at) return 0;
    const due = at + s.delay_hours*3600000;
    if(nowMs < due) return 0;
    return s.repeat_hours? Math.floor((nowMs - due) / (s.repeat_hours*3600000)) + 1 : 1;
  }
  // Who approved, as the bell knows people (bellPerson): "staff:<id>", or "device" for this till in single operator mode
  function srqApproverKey(q){
    const d = q.draft||{}, staff = d.approved_staff_id || q.decided_staff_id;
    if(staff) return "staff:"+staff;
    return (d.approved_terminal_id || q.decided_terminal_id) && (d.approved_terminal_id || q.decided_terminal_id)===scMyTerminal()? "device" : "";
  }
  function srqReminderCardHtml(){
    if(!(typeof scAvailable==="function" && scAvailable())) return "";
    const s = srqReminderSettings(), mayEdit = srqReminderMayEdit();
    const delays = Array.from({ length:72 }, (_,i)=> i+1), repeats = Array.from({ length:69 }, (_,i)=> i+4);
    return `<div class="card" id="srqRemindCard">
      <h3 style="margin-top:0">Stock requests: dispatch reminder</h3>
      <p class="muted" style="font-size:12.5px;margin:0 0 6px">When an approved request's draft Delivery Note hasn't been sent, the bell reminds everyone at main with the Dispatch right, and the person who approved it. For the whole business, set on seiGEN${s.updated_by? " (last changed by "+escapeHtml(s.updated_by)+")" : ""}.</p>
      <label style="margin-top:0">Remind after</label>
      <select class="field" id="srqRemDelay" ${mayEdit? "" : "disabled"}>${delays.map(h=>`<option value="${h}" ${h===Number(s.delay_hours)? "selected" : ""}>${h} hour${h===1? "" : "s"}</option>`).join("")}</select>
      <label>Repeat every</label>
      <select class="field" id="srqRemRepeat" ${mayEdit? "" : "disabled"}><option value="" ${s.repeat_hours==null? "selected" : ""}>Don't repeat</option>${repeats.map(h=>`<option value="${h}" ${h===Number(s.repeat_hours)? "selected" : ""}>${h} hours</option>`).join("")}</select>
      ${mayEdit? `<button class="btn btn-outline" id="srqRemSave" style="margin-top:10px">Save reminder</button>` : `<p class="muted" style="font-size:12px;margin:6px 0 0">Only an Owner or Admin can change it.</p>`}
      <p id="srqRemMsg" style="font-size:12.5px;margin:6px 0 0"></p>
    </div>`;
  }
  // An Owner or Admin signed in, or (nobody signed in) a till in single operator mode, which asks for the Admin passcode
  function srqReminderMayEdit(){
    if(typeof staffOwnerOrAdmin==="function" && staffOwnerOrAdmin()) return true;
    const signedIn = typeof staffSession==="function" && staffSession();
    return !signedIn && typeof currentRights==="function" && currentRights()===null && !(typeof isSeat==="function" && isSeat());
  }
  // -> { ok, settings } | { ok:false, message }
  async function srqReminderSave(delayHours, repeatHours){
    const d = Number(delayHours), r = repeatHours===null || repeatHours===""? null : Number(repeatHours);
    if(!Number.isInteger(d) || d<1 || d>72) return { ok:false, message:"Remind after 1 to 72 hours." };
    if(r!==null && (!Number.isInteger(r) || r<4 || r>72)) return { ok:false, message:"Repeat every 4 to 72 hours, or don't repeat." };
    if(!isOnline()) return { ok:false, message:"You need the internet: the reminder is set on seiGEN for every till." };
    const res = await terminalRpc("cl_device_srq_settings_set", Object.assign(terminalAuth(), { p_delay_hours:d, p_repeat_hours:r, p_by:scWho() }), { timeoutMs:20000 });
    if(!res.ok) return { ok:false, message:String((res.data && res.data.message) || res.message || res.code || res.reason) };
    const s = res.data.settings || { delay_hours:d, repeat_hours:r };
    setSetting("srq_settings", JSON.stringify({ delay_hours:s.delay_hours, repeat_hours:s.repeat_hours==null? null : s.repeat_hours, updated_at:s.updated_at||null, updated_by:s.updated_by||null }));
    logAudit("Dispatch reminder", "", "after "+d+" h, "+(r? "every "+r+" h" : "no repeat"));
    await persist();
    return { ok:true, settings:s };
  }
  function srqReminderCardWire(scope){
    const b = scope.querySelector("#srqRemSave");
    if(!b) return;
    b.onclick = async ()=>{
      const msg = scope.querySelector("#srqRemMsg");
      const signedIn = typeof staffSession==="function" && staffSession();
      if(!signedIn){   // single operator mode: the Admin passcode, as for every setting here
        const pc = prompt("Admin passcode to change the dispatch reminder:");
        if(pc===null) return;
        if(!(await findAdminAsync(pc))){ msg.style.color = "#b42318"; msg.textContent = "Incorrect Admin passcode. Nothing was changed."; return; }
      }
      b.disabled = true; b.textContent = "Saving…";
      const r = await srqReminderSave(scope.querySelector("#srqRemDelay").value, scope.querySelector("#srqRemRepeat").value);
      b.disabled = false; b.textContent = "Save reminder";
      msg.style.color = r.ok? "" : "#b42318";
      msg.textContent = r.ok? "Saved for the whole business." : r.message;
    };
  }
  function openRequestHistory(id){
    const q = scRequest(id);
    if(!q) return;
    const atMain = scIsMain();
    const wrap = openModal("Stock request "+q.req_no, `
      <div id="srqHist">
        <p style="margin:0 0 4px">${srqStatusChip(q.status)} · from <b>${escapeHtml(q.from_branch||"")}</b> to ${escapeHtml(q.to_branch||"main")}</p>
        <p class="muted" style="margin:0 0 4px;font-size:12.5px">Asked by ${escapeHtml(q.requested_by||"?")} on ${escapeHtml(new Date(q.created_ts||q.created_at).toLocaleString())}${q.needed_by? " · needed by "+escapeHtml(q.needed_by) : ""}</p>
        <p style="margin:0 0 6px">Reason: ${escapeHtml(q.reason||"")}</p>
        ${q.decision_note? `<p style="margin:0 0 6px" id="srqNote"><b>${escapeHtml(q.status==="rejected"? "Rejected" : "Reviewer's note")}:</b> ${escapeHtml(q.decision_note)}${q.decided_by? " ("+escapeHtml(q.decided_by)+")" : ""}</p>` : ""}
        ${srqWaitingNote(q.id)}
        ${srqDraftOpen(q)? `<p class="srq-draft-wait" id="srqDraftWait" style="margin:0 0 6px;font-size:12.5px;color:#b54708"><b>Approved, waiting for dispatch since ${escapeHtml(srqWhen(q.draft.approved_at||q.decided_at))}</b></p>` : ""}
        ${q.status==="not_dispatched" && q.draft? `<p id="srqDraftClosed" style="margin:0 0 6px;font-size:12.5px;color:#b42318"><b>Approved, not dispatched:</b> ${escapeHtml(q.draft.close_reason||"")}${q.draft.closed_by? " ("+escapeHtml(q.draft.closed_by)+(q.draft.closed_at? ", "+escapeHtml(srqWhen(q.draft.closed_at)) : "")+")" : ""}</p>` : ""}
        ${(()=>{ const sentCol = (q.lines||[]).some(l=>l.sent_qty!=null);
          return `<table class="simple"><tr><th>Item</th><th>Asked</th><th>Approved</th>${sentCol? "<th>Sent</th>" : ""}</tr>${(q.lines||[]).map(l=>`<tr><td>${skuNameCellScreen(l.code, l.name)}</td><td>${l.qty}</td>
          <td>${q.status==="pending"? `<input class="field" data-part="${l.line_no}" inputmode="numeric" value="${l.qty}" style="width:70px;margin:0" ${srqCan("review_requisitions")? "" : "disabled"}>` : (l.approved_qty==null? "—" : l.approved_qty)}</td>
          ${sentCol? `<td${l.sent_qty!=null && l.sent_qty!==l.approved_qty? ' style="color:#b54708;font-weight:700"' : ""}>${l.sent_qty==null? "—" : l.sent_qty}</td>` : ""}</tr>`).join("")}</table>`; })()}
        ${q.dn_display? `<p style="margin:6px 0 0">Delivery Note: <b>${escapeHtml(q.dn_display)}</b>${q.grv_display? " · GRV <b>"+escapeHtml(q.grv_display)+"</b>" : ""}</p>` : ""}
        <h4 style="margin:10px 0 4px">History</h4>
        <div style="font-size:12.5px">${(q.log||[]).map(g=>`<div>${escapeHtml(new Date(g.at).toLocaleString())} · ${escapeHtml(g.by||"")} · ${escapeHtml(g.action)}${g.detail && g.detail.dn? " "+escapeHtml(g.detail.dn) : ""}${g.detail && g.detail.grv? " "+escapeHtml(g.detail.grv) : ""}</div>`).join("")}</div>
        ${q.status==="pending" && srqCan("review_requisitions")? `<label>Note / reason</label><input class="field" id="srqDecNote" maxlength="200">
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button class="btn btn-primary" data-dec="approve">Approve all</button><button class="btn btn-outline" data-dec="part">Approve as typed (part)</button><button class="btn btn-outline" data-dec="reject">Reject</button></div>` : ""}
        ${srqDraftOpen(q) && atMain && srqCan("m.dispatch") && !q.dispatch_id? `<button class="btn btn-primary" id="srqDispatch" style="margin-top:10px">Open draft DN</button>` : ""}
        ${srqDraftOpen(q) && srqCanCloseDraft() && !q.dispatch_id? `<button class="btn btn-outline" id="srqCloseDraft" style="margin-top:10px">Close the draft (not dispatched)</button>` : ""}
        ${(q.status==="approved" || q.status==="part_approved") && !q.draft && !q.dispatch_id && atMain? `<p class="muted" style="font-size:12px;margin:8px 0 0">The draft Delivery Note comes from seiGEN with the next check (Refresh).</p>` : ""}
        <div id="srqErr" style="color:#b42318;font-size:12.5px"></div>
      </div>`);
    wrap.querySelectorAll("[data-dec]").forEach(b=> b.onclick = ()=>{
      const part = {}; wrap.querySelectorAll("[data-part]").forEach(i=>{ part[+i.dataset.part] = /^\d+$/.test(i.value.trim())? Number(i.value) : NaN; });
      const r = srqDecide(q.id, b.dataset.dec, wrap.querySelector("#srqDecNote").value, part);
      if(!r.ok){ wrap.querySelector("#srqErr").textContent = r.message; return; }
      persist(); scSoon(); wrap.remove(); render();
    });
    const dbtn = wrap.querySelector("#srqDispatch");
    if(dbtn) dbtn.onclick = ()=>{
      const r = srqOpenDraft(q.id);
      if(!r.ok){ wrap.querySelector("#srqErr").textContent = r.message; return; }
      wrap.remove();
    };
    const cbtn = wrap.querySelector("#srqCloseDraft");
    if(cbtn) cbtn.onclick = ()=>{
      const note = prompt("Why close this draft without dispatching? The requesting branch sees the reason.");
      if(note==null) return;
      const r = srqCloseDraft(q.id, note);
      if(!r.ok){ wrap.querySelector("#srqErr").textContent = r.message; return; }
      persist(); scSoon(); wrap.remove(); render();
    };
  }

  // ---- recalls ----
  function rclVisible(){ const me = scMyBranch(); return scRecalls().filter(q=> scIsMain() || q.branch_id===me); }
  function rclFiltered(){
    return rclVisible().filter(q=>{
      if(rclFilter.status==="overdue"? !rclOverdue(q) : rclFilter.status && q.status!==rclFilter.status) return false;
      return textMatches(rclFilter.q, { text:[q.rcl_no, q.branch, q.reason, q.reason_kind, q.created_by, q.dn_display].concat((q.lines||[]).map(l=>l.name+" "+(l.code||""))), dates:[q.created_ts] });
    });
  }
  function renderRecalls(main){
    const canNew = srqCan("recall_stock") && scIsMain();
    main.innerHTML = `
      ${canNew? `<button class="btn btn-primary" id="rclNew" style="margin-bottom:10px">+ New recall</button>` : ""}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
        <select class="field" id="rclStatus" style="margin:0;max-width:170px"><option value="">Every status</option><option value="overdue" ${rclFilter.status==="overdue"? "selected" : ""}>Overdue</option>${Object.entries(RCL_STATUS).map(([k,v])=>`<option value="${k}" ${rclFilter.status===k? "selected" : ""}>${v}</option>`).join("")}</select>
      </div>
      <div class="search-wrap"><span class="ic">🔎</span><input class="field" id="rclSearch" placeholder="Search: number, branch, item, reason…" value="${escapeHtml(rclFilter.q)}"></div>
      <div id="rclList">${rclListHtml(rclFiltered())}</div>`;
    const set = (k, v)=>{ rclFilter[k] = v; main.querySelector("#rclList").innerHTML = rclListHtml(rclFiltered()); wireRclRows(main); };
    main.querySelector("#rclStatus").onchange = (e)=> set("status", e.target.value);
    main.querySelector("#rclSearch").oninput = (e)=> set("q", e.target.value);
    const nb = main.querySelector("#rclNew"); if(nb) nb.onclick = ()=> openRecallCreate();
    wireRclRows(main);
  }
  function rclListHtml(rows){
    if(!rows.length) return `<p class="muted" id="rclNone">No recalls${rclFilter.status||rclFilter.q? " match" : ""}.</p>`;
    return `<div class="card" style="overflow-x:auto;padding:4px"><table class="simple" id="rclTable"><tr><th>Recall</th><th>From branch</th><th>Reason</th><th>Due</th><th>Items</th><th>Status</th></tr>
      ${rows.map(q=>`<tr class="rcl-row" data-rcl="${escapeHtml(q.id)}" style="cursor:pointer"><td><b>${escapeHtml(q.rcl_no)}</b>${q._local? ` <span class="muted" style="font-size:11px">⏳</span>` : ""}</td>
        <td>${escapeHtml(q.branch||scBranchName(q.branch_id))}</td><td>${escapeHtml((RCL_REASONS.find(r=>r[0]===q.reason_kind)||[,""])[1])}</td><td>${escapeHtml(q.due_date||"")}</td>
        <td>${(q.lines||[]).length}</td><td>${srqStatusChip(q.status, rclOverdue(q))}</td></tr>`).join("")}</table></div>`;
  }
  function wireRclRows(main){ main.querySelectorAll("[data-rcl]").forEach(tr=>{ tr.onclick = ()=> openRecallHistory(tr.dataset.rcl); tr.ondblclick = ()=> openRecallHistory(tr.dataset.rcl); }); }
  function openRecallCreate(){
    const products = all("SELECT * FROM products WHERE branch=? AND COALESCE(active,1)=1 ORDER BY name",[currentBranch()]);
    const branches = scBranches().filter(b=>!b.is_main);
    if(!branches.length){ alert("No other branches on seiGEN yet."); return; }
    const lines = []; let q = "";
    const due = businessDateOf(Date.now()+7*86400000);
    const wrap = openModal("Recall stock from a branch", `<div id="rlBody"></div>`);
    const st = { branch:branches[0].id, kind:"overstock", reason:"", due };
    const body = wrap.querySelector("#rlBody");
    const draw = (keepFocus)=>{
      const matches = q.trim()? productSearch(products, q).slice(0,8) : [];
      body.innerHTML = `
        <label style="margin-top:0">From branch</label><select class="field" id="rlBranch">${branches.map(b=>`<option value="${escapeHtml(b.id)}" ${st.branch===b.id? "selected" : ""}>${escapeHtml(b.name)}</option>`).join("")}</select>
        <label>Reason</label><select class="field" id="rlKind">${RCL_REASONS.map(([k,v])=>`<option value="${k}" ${st.kind===k? "selected" : ""}>${v}</option>`).join("")}</select>
        <input class="field" id="rlReason" maxlength="200" placeholder="Details${st.kind==="other"? " (required)" : " (optional)"}" value="${escapeHtml(st.reason)}">
        <label>Due date</label><input class="field" id="rlDue" type="date" value="${escapeHtml(st.due)}">
        <label>Items</label><input class="field" id="rlSearch" placeholder="Search by name or code" value="${escapeHtml(q)}" autocomplete="off">
        ${matches.map(p=>`<button type="button" class="card" data-add="${p.id}" style="display:block;width:100%;text-align:left;padding:6px;margin:4px 0">${escapeHtml(p.name)} <span class="muted">${escapeHtml(p.sku||"")}</span></button>`).join("")}
        ${lines.map((l,i)=>`<div class="card" style="padding:6px;margin:4px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap"><b style="flex:1">${escapeHtml(l.p.name)}</b>
          <label style="margin:0;font-size:12px"><input type="checkbox" data-all="${i}" ${l.all? "checked" : ""}> All on hand</label>
          <input class="field" data-q="${i}" inputmode="numeric" value="${escapeHtml(l.qty)}" style="width:70px;margin:0" ${l.all? "disabled" : ""}><button class="close-x" data-del="${i}">✕</button></div>`).join("")}
        <div id="rlErr" style="color:#b42318;font-size:12.5px"></div>
        <button class="btn btn-primary" id="rlSave">Send recall</button>`;
      const keep = ()=>{ st.branch = body.querySelector("#rlBranch").value; st.kind = body.querySelector("#rlKind").value; st.reason = body.querySelector("#rlReason").value; st.due = body.querySelector("#rlDue").value; };
      const s = body.querySelector("#rlSearch");
      s.oninput = ()=>{ keep(); q = s.value; draw(true); };
      if(keepFocus){ s.focus(); try{ s.setSelectionRange(s.value.length, s.value.length); }catch(e){} }
      body.querySelector("#rlKind").onchange = ()=>{ keep(); draw(); };
      body.querySelectorAll("[data-add]").forEach(b=> b.onclick = ()=>{ keep(); const p = products.find(x=>x.id===+b.dataset.add); if(!lines.some(l=>l.p.id===p.id)) lines.push({ p, qty:"1", all:false }); q = ""; draw(); });
      body.querySelectorAll("[data-q]").forEach(inp=> inp.oninput = ()=>{ lines[+inp.dataset.q].qty = inp.value; });
      body.querySelectorAll("[data-all]").forEach(c=> c.onchange = ()=>{ keep(); lines[+c.dataset.all].all = c.checked; draw(); });
      body.querySelectorAll("[data-del]").forEach(b=> b.onclick = ()=>{ keep(); lines.splice(+b.dataset.del, 1); draw(); });
      body.querySelector("#rlSave").onclick = ()=>{
        keep();
        const r = rclCreate(st.branch, st.kind, st.reason, st.due, lines.map(l=>({ product:l.p, qty:l.qty, all:l.all })));
        if(!r.ok){ body.querySelector("#rlErr").textContent = r.message; return; }
        persist(); scSoon(); wrap.remove(); render();
      };
    };
    draw();
  }
  function rclCreate(branchId, kind, reason, due, lines){
    if(!scBranches().some(b=>b.id===branchId && !b.is_main)) return { ok:false, message:"Choose a branch." };
    if(!RCL_REASONS.some(r=>r[0]===kind)) return { ok:false, message:"Choose a reason." };
    if(kind==="other" && !String(reason||"").trim()) return { ok:false, message:"Say what the reason is." };
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(due||""))) return { ok:false, message:"Give a due date." };
    if(!lines.length) return { ok:false, message:"Add at least one item." };
    for(const l of lines){ if(!l.all && (!/^\d+$/.test(String(l.qty).trim()) || Number(l.qty)<1)) return { ok:false, message:l.product.name+": a whole number of 1 or more, or All on hand." }; }
    const id = scNewUid(), ts = new Date().toISOString();
    let no;
    db.run("BEGIN");
    try{
      no = reserveDocNumber("RCL");
      const ls = lines.map((l,i)=>({ line_no:i+1, product_key:scProductKey(l.product), code:l.product.sku||"", name:l.product.name, qty:l.all? 0 : Number(l.qty), all_on_hand:!!l.all }));
      const doc = { id, rcl_no:no.text, branch_id:branchId, branch:scBranchName(branchId), to_branch_id:scMainBranch()||scMyBranch(), to_branch:currentBranch(), terminal_id:scMyTerminal(),
        created_by:scWho(), created_staff_id:scStaffId(), reason_kind:kind, reason:String(reason||"").trim()||null, due_date:due, status:"open", created_ts:ts, lines:ls, log:[{ at:ts, by:scWho(), action:"recalled" }] };
      scSaveDoc("sc_recalls", doc, true);
      scQueue("recall_create", { id, rcl_no:no.text, branch_id:branchId, reason_kind:kind, reason:doc.reason, due_date:due, staff_id:scStaffId(), lines:ls.map(l=>({ product_key:l.product_key, code:l.code, name:l.name, qty:l.qty, all_on_hand:l.all_on_hand })) }, id);
      logAudit("Recall", "", no.text+": "+ls.length+" item"+(ls.length===1? "" : "s")+" from "+doc.branch+", due "+due);
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} return { ok:false, message:String(e.message||e) }; }
    return { ok:true, id, rcl_no:no.text };
  }
  // Send back: per line, what goes and what is short (with a reason) -> the pre-filled DN to main
  // sent: { line_no: { sent, reason } } -> { ok, pre } | { ok:false, message }
  function rclSendBackPlan(q, sent){
    const lines = [], link = [];
    for(const l of q.lines||[]){
      const p = scProductByKey(l.product_key), have = p? p.stock : 0;
      const asked = l.all_on_hand? Math.max(0, have) : l.qty;
      const s = sent[l.line_no] || {}, n = s.sent==null? Math.min(asked, Math.max(0, have)) : Number(s.sent);
      if(!Number.isInteger(n) || n<0) return { ok:false, message:l.name+": a whole number to send." };
      if(n>have) return { ok:false, message:l.name+": only "+have+" here." };
      const short = l.all_on_hand? 0 : Math.max(0, asked - n);
      if(short>0 && !String(s.reason||"").trim()) return { ok:false, message:l.name+": "+short+" short. Say why." };
      if(n>0) lines.push({ product:p, qty:n });
      link.push({ line_no:l.line_no, sent_qty:n, short_qty:short, short_reason:short>0? String(s.reason).trim() : null });
    }
    if(!lines.length) return { ok:false, message:"Nothing to send: every line is short." };
    return { ok:true, pre:{ toBranch:q.to_branch || scBranchName(q.to_branch_id), lines, link:{ type:"recall", id:q.id, lines:link }, title:"Send back "+q.rcl_no, internalRef:q.rcl_no,
      note:"Recall "+q.rcl_no+": sending back to "+(q.to_branch||"main")+". Transport is paid by the receiver (main)." } };
  }
  // Decision 56: its maker, or an Owner or Admin, may cancel an open recall, with a reason, before any DN for it is sent (seiGEN checks the same)
  function rclCanCancel(q){
    if(!q || q.status!=="open" || q.dispatch_id || q.dn_display) return false;
    if(typeof staffOwnerOrAdmin==="function" && staffOwnerOrAdmin()) return true;
    if(!srqCan("recall_stock")) return false;
    const me = scStaffId();
    return me? q.created_staff_id===me : (!q.created_staff_id && q.terminal_id===scMyTerminal());
  }
  function rclCancel(id, note){
    const q = scRecall(id);
    if(!q || q.status!=="open" || q.dispatch_id || q.dn_display) return { ok:false, message:"Only an open recall with no Delivery Note sent can be cancelled." };
    if(!rclCanCancel(q)) return { ok:false, message:"Only the person who made this recall, an Owner or an Admin can cancel it." };
    if(!String(note||"").trim()) return { ok:false, message:"Give the reason for cancelling the recall." };
    Object.assign(q, { status:"cancelled", cancelled_by:scWho(), cancel_note:String(note).trim().slice(0, 200), cancelled_person:typeof bellPerson==="function"? bellPerson() : "" });
    db.run("BEGIN");
    try{ scSaveDoc("sc_recalls", q, q._local); scQueue("recall_cancel", { id, note:q.cancel_note }, id); db.run("COMMIT"); }
    catch(e){ try{ db.run("ROLLBACK"); }catch(_){} return { ok:false, message:String(e.message||e) }; }
    return { ok:true };
  }
  function openRecallHistory(id){
    const q = scRecall(id);
    if(!q) return;
    const atBranch = q.branch_id===scMyBranch(), sendable = atBranch && q.status==="open" && srqCan("m.dispatch") && !q._local;
    const wrap = openModal("Recall "+q.rcl_no, `
      <p style="margin:0 0 4px">${srqStatusChip(q.status, rclOverdue(q))} · from <b>${escapeHtml(q.branch||"")}</b> back to ${escapeHtml(q.to_branch||"main")} · due ${escapeHtml(q.due_date||"")}</p>
      <p class="muted" style="margin:0 0 4px;font-size:12.5px">By ${escapeHtml(q.created_by||"?")} on ${escapeHtml(new Date(q.created_ts||q.created_at).toLocaleString())} · ${escapeHtml((RCL_REASONS.find(r=>r[0]===q.reason_kind)||[,""])[1])}${q.reason? ": "+escapeHtml(q.reason) : ""}</p>
      <p class="muted" style="margin:0 0 6px;font-size:12px">A recall alone never moves stock: stock leaves the branch only when its Delivery Note is sent. Transport is paid by main (the receiver).</p>
      ${srqWaitingNote(q.id)}
      <table class="simple" id="rclLines"><tr><th>Item</th><th>Recalled</th>${atBranch? "<th>Here</th>" : ""}<th>Sent</th><th>Short</th></tr>${(q.lines||[]).map(l=>{ const p = atBranch? scProductByKey(l.product_key) : null;
        return `<tr><td>${skuNameCellScreen(l.code, l.name)}</td><td>${l.all_on_hand? "All on hand" : l.qty}</td>${atBranch? `<td>${p? p.stock : "—"}</td>` : ""}
          <td>${sendable? `<input class="field" data-sent="${l.line_no}" inputmode="numeric" value="${Math.max(0, Math.min(l.all_on_hand? (p? p.stock : 0) : l.qty, p? p.stock : 0))}" style="width:64px;margin:0">` : (l.sent_qty==null? "—" : l.sent_qty)}</td>
          <td>${sendable? `<input class="field" data-why="${l.line_no}" maxlength="200" placeholder="Why short" style="margin:0">` : (l.short_qty? l.short_qty+(l.short_reason? " ("+escapeHtml(l.short_reason)+")" : "") : "—")}</td></tr>`; }).join("")}</table>
      ${q.dn_display? `<p style="margin:6px 0 0">Delivery Note: <b>${escapeHtml(q.dn_display)}</b>${q.grv_display? " · GRV <b>"+escapeHtml(q.grv_display)+"</b>" : ""}</p>` : ""}
      <h4 style="margin:10px 0 4px">History</h4>
      <div style="font-size:12.5px">${(q.log||[]).map(g=>`<div>${escapeHtml(new Date(g.at).toLocaleString())} · ${escapeHtml(g.by||"")} · ${escapeHtml(g.action)}</div>`).join("")}</div>
      ${sendable? `<button class="btn btn-primary" id="rclSend" style="margin-top:10px">Send back (Delivery Note to main)</button>` : ""}
      ${atBranch && q.status==="open" && q._local? `<p class="muted">Waiting for seiGEN before it can be sent back.</p>` : ""}
      ${scIsMain() && rclCanCancel(q)? `<button class="btn btn-outline" id="rclCancel" style="margin-top:10px">Cancel the recall</button>` : ""}
      <div id="rclErr" style="color:#b42318;font-size:12.5px"></div>`);
    const send = wrap.querySelector("#rclSend");
    if(send) send.onclick = ()=>{
      const sent = {};
      wrap.querySelectorAll("[data-sent]").forEach(i=>{ const n = i.dataset.sent; sent[n] = { sent:/^\d+$/.test(i.value.trim())? Number(i.value) : NaN, reason:(wrap.querySelector(`[data-why="${n}"]`)||{}).value }; });
      const r = rclSendBackPlan(q, sent);
      if(!r.ok){ wrap.querySelector("#rclErr").textContent = r.message; return; }
      wrap.remove(); openDispatchScreen(r.pre);
    };
    const cb = wrap.querySelector("#rclCancel");
    if(cb) cb.onclick = ()=>{ const note = prompt("Why cancel this recall?"); if(note==null) return; const r = rclCancel(q.id, note); if(!r.ok){ wrap.querySelector("#rclErr").textContent = r.message; return; } persist(); scSoon(); wrap.remove(); render(); };
  }

  // ---- reports (Report Writer) ----
  function srqReport(fromTs, toTs){
    const rows = srqVisible().filter(q=>{ const t = q.created_ts||q.created_at; return (!fromTs || t>=fromTs) && (!toTs || t<=toTs); });
    const byBranch = new Map();
    rows.forEach(q=>{
      const k = q.from_branch||scBranchName(q.from_branch_id)||"?";
      const x = byBranch.get(k) || { open:0, approved:0, part:0, rejected:0, hours:[], n:0 };
      x.n++;
      if(q.status==="pending") x.open++; else if(q.status==="rejected") x.rejected++; else if(q.status==="part_approved") x.part++; else x.approved++;
      if(q.decided_at) x.hours.push((Date.parse(q.decided_at) - Date.parse(q.created_ts||q.created_at))/3600000);
      byBranch.set(k, x);
    });
    const avg = (h)=> h.length? (h.reduce((s,x)=>s+x,0)/h.length).toFixed(1) : "—";
    const out = [...byBranch.entries()].map(([k,x])=>[escapeHtml(k), x.n, x.open, x.approved, x.part, x.rejected, avg(x.hours)]);
    const all_ = rows.filter(q=>q.decided_at).map(q=>(Date.parse(q.decided_at) - Date.parse(q.created_ts||q.created_at))/3600000);
    return { headers:["Branch","Requests","Open","Approved","Part-approved","Rejected","Average hours to decide"], rows:out,
      footer:`${rows.length} request${rows.length===1? "" : "s"} · average ${avg(all_)} hours to decide` };
  }
  function rclReport(fromTs, toTs){
    const rows = rclVisible().filter(q=>{ const t = q.created_ts||q.created_at; return (!fromTs || t>=fromTs) && (!toTs || t<=toTs); });
    const out = rows.map(q=>{ const short = (q.lines||[]).filter(l=>(l.short_qty||0)>0);
      return [escapeHtml(q.rcl_no), escapeHtml(q.branch||""), escapeHtml(q.due_date||""), rclOverdue(q)? "Overdue" : (RCL_STATUS[q.status]||q.status),
        escapeHtml(q.dn_display||""), short.length? short.map(l=>escapeHtml(l.name)+" "+l.short_qty+(l.short_reason? " ("+escapeHtml(l.short_reason)+")" : "")).join("; ") : "—"]; });
    const open = rows.filter(q=>q.status==="open").length, overdue = rows.filter(rclOverdue).length, shorts = rows.filter(q=>(q.lines||[]).some(l=>(l.short_qty||0)>0)).length;
    return { headers:["Recall","Branch","Due","Status","DN","Shortages"], rows:out, footer:`${open} open · ${overdue} overdue · ${shorts} with shortages` };
  }
  if(typeof REPORT_CONFIGS!=="undefined"){
    REPORT_CONFIGS.push({ id:"branchrequests", label:"Stock requests (branches)", hasDate:true, needs:()=> srqAvailable(), fetch(b, fromTs, toTs){ return srqReport(fromTs, toTs); } });
    REPORT_CONFIGS.push({ id:"recalls", label:"Recalls", hasDate:true, needs:()=> srqAvailable(), fetch(b, fromTs, toTs){ return rclReport(fromTs, toTs); } });
    RW_KIND.branchrequests = "stock"; RW_KIND.recalls = "stock";
  }
