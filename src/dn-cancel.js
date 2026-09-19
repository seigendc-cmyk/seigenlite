  // ---------------- Cancel / reissue / close as loss: the dispatching device (Phase 5) ----------------
  // Only the DISPATCHING device, with the Admin passcode, can cancel, reissue or close a DN.
  //
  // Protocol in one paragraph: starting a case writes a cancel_pending event and makes a checksummed notice
  // (or, for a reissue, a replacement DN that also acts as the notice). NOTHING about stock changes yet.
  // The receiver confirms (its DN becomes a tombstone: received XOR cancelled) and sends a confirmation back.
  // Only when that confirmation is imported (or the GRV for the replacement arrives, or management overrides)
  // is everything posted, in ONE synchronous transaction: restore, the replacement DN's stock, write-offs,
  // events and audit. A GRV that arrives while a cancel is pending ends the cancel instead.

  const cancelEnabled = ()=> getSetting("cancel_enabled","")==="1";
  const CANCEL_OFF_MSG = "Cancel and reissue is switched off on this device. An Admin can switch it on in Settings once every branch has updated the app.";
  const DN_CLOSED_STATUSES = ["cancelled","superseded","loss_closed"];

  function dnCaseByNo(caseNo){ return one("SELECT * FROM dn_cases WHERE dn_branch_id=? AND case_no=?",[getBranchId(),caseNo]); }
  function pendingCaseFor(dnNo){ return one("SELECT * FROM dn_cases WHERE dn_branch_id=? AND dn_no=? AND state='pending'",[getBranchId(),dnNo]); }
  function caseByReplacement(newDnNo){ return one("SELECT * FROM dn_cases WHERE dn_branch_id=? AND replaced_by=? ORDER BY id DESC",[getBranchId(),newDnNo]); }
  function planOf(c){ try{ return JSON.parse(c.plan_json).lines; }catch(e){ return []; } }
  function findProductForLine(l){
    const branch = currentBranch();
    return (l.code? one("SELECT * FROM products WHERE branch=? AND lower(sku)=lower(?)",[branch,l.code]) : null)
        || one("SELECT * FROM products WHERE branch=? AND lower(name)=lower(?)",[branch,l.name]);
  }
  function derivedDnStatus(dnNo){
    const r = dnStatusMap().get(getBranchId()+"|"+dnNo);
    return r? r.status : "dispatched";
  }
  const canStartCancel = (status)=> ["dispatched","awaiting","variance"].includes(status);

  // ---- the posting: restore, replacement DN stock, write-offs. Synchronous; the CALLER owns the transaction. ----
  // opts: { override:boolean, via:string, now:Date }
  function postCaseSync(c, opts){
    const branchId = getBranchId(), h = one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[branchId,c.dn_no]);
    if(!h) throw new Error(formatDocNo("DN",c.dn_no)+" is not a Delivery Note of this device.");
    if(c.state!=="pending") throw new Error("This cancellation is already "+c.state+".");
    const ts = (opts.now||new Date()).toISOString(), plan = planOf(c), dn = formatDocNo("DN",c.dn_no), admin = c.authorised_by||"";
    const products = plan.map(l=>{
      const p = findProductForLine(l);
      if(!p) throw new Error((l.code? l.code+" " : "")+l.name+" is no longer a product in this branch, so stock can't be restored. Nothing was changed.");
      return p;
    });
    // 1. restore everything that left with the original DN (first, so the later rows can never go below zero)
    plan.forEach((l,i)=>writeAdjustment({ product:products[i], delta:l.orig, reason:"Dispatch cancelled", note:"Restored: "+dn+" cancelled ("+CANCEL_KIND_LABEL[c.kind]+")",
      admin, ts, dnBranchId:branchId, dnNo:c.dn_no }));
    // 2. a reissue sends the corrected quantities again, on the replacement DN
    if(c.kind==="reissue"){
      const nh = one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[branchId,c.replaced_by]);
      if(!nh) throw new Error("The replacement Delivery Note "+formatDocNo("DN",c.replaced_by)+" is missing.");
      plan.forEach((l,i)=>{
        if(!(l.nw>0)) return;
        const cur = one("SELECT stock FROM products WHERE id=?",[products[i].id]);
        if(!cur || cur.stock<l.nw) throw new Error(l.name+": only "+(cur?cur.stock:0)+" in stock for the replacement. Nothing was changed.");
        run("UPDATE products SET stock=stock-? WHERE id=?",[l.nw,products[i].id]);
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user,dn_branch_id,dn_no) VALUES(?,?,?,?,?,?,?,?,?)",
          [ts,products[i].id,l.name,-l.nw,"Dispatched to "+h.receive_branch_name+" ("+formatDocNo("DN",c.replaced_by)+")",currentBranch(),String(sessionUser||""),branchId,c.replaced_by]);
      });
      run("UPDATE dispatch_docs SET stock_posted=1 WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[branchId,c.replaced_by]);
    }
    // 3. what is written off, linked to the ORIGINAL DN, with the reason management chose
    plan.forEach((l,i)=>{ if(l.writeoff>0) writeAdjustment({ product:products[i], delta:-l.writeoff, reason:l.reason, note:c.note||"", admin, ts, dnBranchId:branchId, dnNo:c.dn_no }); });
    // 4. nothing may end below zero
    products.forEach(p=>{ const cur = one("SELECT stock,name FROM products WHERE id=?",[p.id]); if(cur.stock<0) throw new Error(cur.name+": stock would go below zero. Nothing was changed."); });
    const status = c.kind==="reissue"? "superseded" : c.kind==="loss"? "loss_closed" : "cancelled";
    run("UPDATE dn_cases SET state='posted', posted_ts=?, posted_via=?, override=? WHERE id=?",[ts,opts.via||"",opts.override?1:0,c.id]);
    run("UPDATE dispatch_docs SET status=?, cancel_kind=?, cancelled_ts=? WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[status,c.kind,ts,branchId,c.dn_no]);
    recordDnEvent({ dnBranchId:branchId, dnNo:c.dn_no, type:"cancel_posted", actorBranchId:branchId, actorName:currentBranch(), fromName:h.dispatch_branch_name, toName:h.receive_branch_name, ts:localIso(opts.now||new Date()),
      detail:{ kind:c.kind, replaced_by:c.replaced_by||null, override:!!opts.override, case_no:c.case_no, via:opts.via||"" } });
    logAudit("Cancel posted", "", dn+": "+CANCEL_KIND_LABEL[c.kind]+(c.replaced_by? " (replaced by "+formatDocNo("DN",c.replaced_by)+")" : "")+", "+(opts.override? "WITHOUT receiver confirmation" : "confirmed")+", authorised by "+admin);
  }

  // ---- start ----
  // o: { dnNo, kind, plan:[{nw,writeoff,reason}], note, passcode, override?, typed?, now? }
  // Synchronous; the caller awaits persist(). -> { caseNo, caseText, kind, newDnNo|null, overridden }
  function startCancelCase(o){
    requireSignedIn();
    if(!cancelEnabled()) throw new Error(CANCEL_OFF_MSG);
    if(!hasAdminPasscode()) throw new Error(NO_ADMIN_PASSCODE_MSG);
    const admin = findAdmin(o.passcode);
    if(!admin) throw new Error("Incorrect Admin passcode.");
    const branchId = getBranchId(), now = o.now || new Date(), ts = now.toISOString();
    const h = one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[branchId,o.dnNo]);
    if(!h) throw new Error("That Delivery Note was not dispatched from this device.");
    const dn = formatDocNo("DN",o.dnNo), status = derivedDnStatus(o.dnNo);
    if(pendingCaseFor(o.dnNo)) throw new Error(dn+" already has a cancellation in progress.");
    if(!canStartCancel(status)) throw new Error(dn+" is "+(DN_STATUS_LABEL[status]||status).toLowerCase()+", so it can't be cancelled. Only dispatched, awaiting or variance Delivery Notes can.");
    if(h.status==="received" || DN_CLOSED_STATUSES.includes(h.status)) throw new Error(dn+" is already "+h.status+".");
    const stored = dnStoredLines(h).map(l=>({ code:l.sku||"", name:l.product_name, qty:l.qty }));
    if(!stored.length) throw new Error("The lines of "+dn+" could not be found on this device.");
    const norm = normalizeCancelPlan(o.kind, stored, o.plan, o.note);
    if(!norm.ok) throw new Error(norm.error);
    norm.lines.forEach(l=>{ if(!findProductForLine(l)) throw new Error((l.code? l.code+" " : "")+l.name+" is no longer a product in this branch."); });
    if(o.override && String(o.typed||"").trim()!=="CANCEL "+dn) throw new Error("Type CANCEL "+dn+" exactly to cancel without the receiver's confirmation.");
    db.run("BEGIN");
    try{
      const cx = reserveDocNumber("CXL"), nonce = newCancelNonce();
      let newNo = null;
      if(o.kind==="reissue"){
        const nd = reserveDocNumber("DN"); newNo = nd.n;
        const send = norm.lines.filter(l=>l.nw>0), units = send.reduce((s,l)=>s+l.nw,0);
        const ok = insertDispatchDoc({ dispatchBranchId:branchId, dispatchBranchName:h.dispatch_branch_name, dnNo:nd.n, receiveBranchName:h.receive_branch_name, direction:"out",
          createdTs:ts, createdIso:localIso(now), lineCount:send.length, unitTotal:units, status:"dispatched", fileName:dnFileName(nd.n, h.dispatch_branch_name, now) });
        if(!ok) throw new Error("Delivery Note "+nd.text+" already exists.");
        run("UPDATE dispatch_docs SET replaces_dn_no=?, stock_posted=0 WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[o.dnNo,branchId,nd.n]);
        send.forEach(l=>run(`INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status,dn_no,dn_branch_id) VALUES(?,?,?,?,?,?,?,?,'Dispatched',?,?)`,
          [ts,h.dispatch_branch_name,h.receive_branch_name,l.name,l.code,l.nw,nd.text+" (replaces "+dn+")",String(sessionUser||""),nd.n,branchId]));
        recordDnEvent({ dnBranchId:branchId, dnNo:nd.n, type:"dispatched", actorBranchId:branchId, actorName:h.dispatch_branch_name, fromName:h.dispatch_branch_name, toName:h.receive_branch_name, ts,
          detail:{ dn_created_iso:localIso(now), lines:send.length, units, replaces:o.dnNo } });
      }
      run(`INSERT INTO dn_cases(case_no,dn_branch_id,dn_no,kind,state,nonce,plan_json,replaced_by,override,note,started_ts,started_by,authorised_by)
           VALUES(?,?,?,?,'pending',?,?,?,0,?,?,?,?)`,
        [cx.n,branchId,o.dnNo,o.kind,nonce,JSON.stringify({ lines:norm.lines }),newNo,String(o.note).trim(),ts,String(sessionUser||""),admin.name]);
      run("UPDATE dispatch_docs SET cancel_no=?, replaced_by=?, cancel_kind=? WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[cx.n,newNo,o.kind,branchId,o.dnNo]);
      recordDnEvent({ dnBranchId:branchId, dnNo:o.dnNo, type:"cancel_pending", actorBranchId:branchId, actorName:currentBranch(), fromName:h.dispatch_branch_name, toName:h.receive_branch_name, ts,
        detail:{ kind:o.kind, cancel_no:cx.n, replaced_by:newNo } });
      logAudit("Cancel started", "", dn+": "+CANCEL_KIND_LABEL[o.kind]+" ("+cx.text+")"+(newNo? ", replacement "+formatDocNo("DN",newNo) : "")+", "+String(o.note).trim()+" (authorised by "+admin.name+")");
      if(o.override) postCaseSync(one("SELECT * FROM dn_cases WHERE dn_branch_id=? AND case_no=?",[branchId,cx.n]), { override:true, via:"override", now });
      db.run("COMMIT");
      return { caseNo:cx.n, caseText:cx.text, kind:o.kind, newDnNo:newNo, overridden:!!o.override };
    }catch(e){
      try{ db.run("ROLLBACK"); }catch(_){}
      throw e;
    }
  }

  // Management posts a pending cancel without waiting for the receiver. Flagged; a later GRV makes the DN a conflict.
  function overridePendingCase(o){
    requireSignedIn();
    if(!cancelEnabled()) throw new Error(CANCEL_OFF_MSG);
    if(!hasAdminPasscode()) throw new Error(NO_ADMIN_PASSCODE_MSG);
    const admin = findAdmin(o.passcode);
    if(!admin) throw new Error("Incorrect Admin passcode.");
    const c = pendingCaseFor(o.dnNo);
    if(!c) throw new Error(formatDocNo("DN",o.dnNo)+" has no cancellation waiting for a confirmation.");
    if(String(o.typed||"").trim()!=="CANCEL "+formatDocNo("DN",o.dnNo)) throw new Error("Type CANCEL "+formatDocNo("DN",o.dnNo)+" exactly to cancel without the receiver's confirmation.");
    db.run("BEGIN");
    try{
      run("UPDATE dn_cases SET authorised_by=? WHERE id=?",[admin.name,c.id]);
      postCaseSync(Object.assign({}, c, { authorised_by:admin.name }), { override:true, via:"override", now:o.now||new Date() });
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
  }

  // ---- receiver's confirmation arrives ----
  function ackContext(){
    return { ownBranchId:getBranchId(),
      header:(dnNo)=>one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[getBranchId(),dnNo]),
      caseByNo:dnCaseByNo };
  }
  async function ackCheckBytes(bytes){
    const text = decodeBytesUtf8(bytes);
    return { res: await checkIncomingAck(text, ackContext()), text };
  }
  // Post the case (or, for an override-posted case, just record that the receiver has now confirmed). One transaction.
  function commitAckImport(ack, now){
    db.run("BEGIN");
    try{
      const c = dnCaseByNo(ack.cancel_no);
      if(!c || c.nonce!==ack.nonce || c.dn_no!==ack.dn_no) throw new Error("This confirmation doesn't match any cancellation started on this device.");
      const h = one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[getBranchId(),ack.dn_no]);
      let posted = false;
      if(c.state==="pending"){
        if(h.status==="received") throw new Error(formatDocNo("DN",ack.dn_no)+" is recorded as received. Nothing was changed.");
        postCaseSync(c, { override:false, via:"confirmation", now });
        posted = true;
      } else if(c.state==="posted" && c.override && !c.acked_ts){ /* upgrade only */ }
      else throw new Error("Already confirmed.");
      run("UPDATE dn_cases SET acked_ts=? WHERE id=?",[now.toISOString(),c.id]);
      recordDnEvent({ dnBranchId:getBranchId(), dnNo:ack.dn_no, type:"cancelled", actorBranchId:ack.to.branch_id, actorName:ack.to.name, fromName:h.dispatch_branch_name, toName:h.receive_branch_name,
        ts:ack.confirmed_iso, detail:{ cancel_no:ack.cancel_no, variance_seen:ack.variance_seen, via:"confirmation" } });
      db.run("COMMIT");
      return { posted, upgraded:!posted, case:dnCaseByNo(ack.cancel_no) };
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
  }

  // ---- files the dispatcher sends ----
  function cancelNoticeFileName(caseNo, receiverName, date){
    return formatDocNo("CXL",caseNo)+"-"+sanitizeBranchName(receiverName)+"-"+fileDatePart(date)+"-"+fileTimePart(date)+"-cancel"+DOC_FILE_EXT;
  }
  async function cancelNoticeFor(c){
    const h = one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[getBranchId(),c.dn_no]);
    const items = dnStoredLines(h).map(l=>({ code:l.sku||"", name:l.product_name, qty:l.qty }));
    const doc = await buildCancel({ cancelNo:c.case_no, nonce:c.nonce, kind:c.kind, dnNo:c.dn_no, fromBranchId:getBranchId(), fromName:h.dispatch_branch_name, toName:h.receive_branch_name,
      replacedBy:c.replaced_by||null, cancelledIso:localIso(new Date(c.started_ts)), items });
    return { doc, text:serializeCancel(doc), fileName:cancelNoticeFileName(c.case_no, h.receive_branch_name, new Date(c.started_ts)), header:h };
  }
  async function shareCancelNotice(c){
    const n = await cancelNoticeFor(c);
    const msg = "CANCELLED: "+n.doc.dn_display+" ("+n.doc.cancel_display+") from "+n.doc.from.name+". Do not receive it. In seiGEN Commerce Lite open Products \u2192 Receive stock and choose the attached file.";
    return shareDocFile({ fileName:n.fileName, text:n.text, folder:"Cancellations", title:n.doc.cancel_display, phone:dnPhoneFor(n.header.receive_branch_name), shareText:msg, whatsappText:msg+" (Attach the file from the folder that just opened.)" });
  }
  // The replacement DN (it also acts as the notice for the DN it replaces).
  async function shareReplacementDN(newDnNo){
    const h = dnHeaderFor(newDnNo), rec = await dnGetRecord(h);
    const s = await dnShareRecord(h, rec);
    return s;
  }

  // ---- screens ----
  function openCancelWizard(dnNo, onDone){
    if(!cancelEnabled()){ alert(CANCEL_OFF_MSG); return; }
    try{ requireSignedIn(); }catch(e){ alert(e.message); return; }
    if(!hasAdminPasscode()){ alert(NO_ADMIN_PASSCODE_MSG); return; }
    const h = dnHeaderFor(dnNo);
    if(!h){ alert("That Delivery Note was not dispatched from this device."); return; }
    const status = derivedDnStatus(dnNo);
    if(!canStartCancel(status)){ alert(formatDocNo("DN",dnNo)+" is "+(DN_STATUS_LABEL[status]||status).toLowerCase()+". Only dispatched, awaiting or variance Delivery Notes can be cancelled."); return; }
    const dn = formatDocNo("DN",dnNo), lines = dnStoredLines(h).map(l=>({ code:l.sku||"", name:l.product_name, qty:l.qty }));
    const mv = dnStatusMap().get(getBranchId()+"|"+dnNo);
    const counted = (l)=>{ const f = mv && mv.varianceFlags.find(x=>(x.code||"")===(l.code||"") && x.name===l.name); return f? Math.min(f.counted, l.qty) : null; };
    const wrap = openModal("Cancel or reissue "+dn, "");
    const body = wrap.querySelector(".modal-body");
    const receiver = h.receive_branch_name;
    let note = "", kind = "cancel", state = lines.map(l=>({ nw:counted(l)!==null? counted(l) : l.qty, disp:"return" }));
    function planFromState(){
      return state.map((s,i)=>{
        const diff = lines[i].qty - (kind==="reissue"? Number(s.nw) : 0);
        return { nw:s.nw, writeoff:(s.disp==="return" || kind==="cancel")? 0 : (kind==="loss"? lines[i].qty : (Number.isInteger(diff)? diff : 0)), reason:s.disp==="return"? "" : s.disp };
      });
    }
    function draw(err){
      body.innerHTML = `
        <div class="pmeta" style="margin-bottom:6px">To <b>${escapeHtml(receiver)}</b> · status: ${escapeHtml(DN_STATUS_LABEL[status]||status)}${mv && mv.hasVariance? " · variance reported" : ""}</div>
        ${mv && mv.hasVariance? `<div class="box" style="margin-bottom:8px;font-size:12.5px">${escapeHtml(varianceText(mv))}</div>` : ""}
        <div class="card" style="padding:8px;margin-bottom:8px">
          ${[["cancel","Cancel: sent by mistake. Everything returns to stock."],["reissue","Cancel and reissue with corrected lines"],["loss","Close as loss: the goods never arrived or can't be recovered"]].map(o=>`
            <label style="display:flex;gap:8px;align-items:flex-start;margin:4px 0"><input type="radio" name="cwKind" value="${o[0]}" ${kind===o[0]?"checked":""} style="width:auto;margin-top:3px"><span>${escapeHtml(o[1])}</span></label>`).join("")}
        </div>
        ${kind==="cancel"? "" : `<div style="max-height:34vh;overflow:auto">${lines.map((l,i)=>`
          <div class="card" style="padding:8px;margin-bottom:6px">
            <div><b>${escapeHtml(l.name)}</b> <span class="muted">${escapeHtml(l.code||"no code")} · sent ${l.qty}</span></div>
            ${kind==="reissue"? `<label style="margin:6px 0 0">New quantity (0 to ${l.qty})</label><input class="field" data-nw="${i}" inputmode="numeric" value="${state[i].nw}">` : ""}
            <label style="margin:6px 0 0">${kind==="reissue"? "The difference" : "Write off as"}</label>
            <select class="field" data-disp="${i}">
              ${kind==="reissue"? `<option value="return" ${state[i].disp==="return"?"selected":""}>Return to stock</option>` : ""}
              ${ADJ_WRITEOFF_REASONS.map(r=>`<option value="${escapeHtml(r)}" ${state[i].disp===r?"selected":""}>Write off: ${escapeHtml(r)}</option>`).join("")}
            </select>
          </div>`).join("")}</div>`}
        <div id="cwSummary" class="muted" style="font-size:12.5px;margin:6px 0"></div>
        <label>Note (why)</label><textarea class="field" id="cwNote" rows="2">${escapeHtml(note)}</textarea>
        <label>Admin passcode</label><input class="field" id="cwPass" type="password" autocomplete="off">
        <div id="cwErr" style="color:#b42318;font-size:12.5px;margin-top:6px">${escapeHtml(err||"")}</div>
        <button class="btn btn-primary" id="cwStart" style="margin-top:10px">Start</button>`;
      body.querySelectorAll('[name="cwKind"]').forEach(r=>r.onchange=()=>{ kind = r.value; if(kind==="loss") state.forEach(s=>{ if(s.disp==="return") s.disp="Lost in transit"; }); if(kind!=="loss") state.forEach(s=>{ }); draw(); });
      body.querySelectorAll("[data-nw]").forEach(i=>i.oninput=()=>{ state[+i.dataset.nw].nw = i.value; summary(); });
      body.querySelectorAll("[data-disp]").forEach(s=>s.onchange=()=>{ state[+s.dataset.disp].disp = s.value; summary(); });
      body.querySelector("#cwNote").oninput=(e)=>{ note = e.target.value; };        // survives a re-draw after an error
      summary();
      body.querySelector("#cwStart").onclick=start;
    }
    function summary(){
      const el = body.querySelector("#cwSummary"); if(!el) return;
      const n = normalizeCancelPlan(kind, lines, planFromState(), "x");
      el.textContent = n.ok? cancelPlanSummary(kind, n.lines, dn).text : n.error;
      el.style.color = n.ok? "" : "#b42318";
    }
    let busy = false;
    async function start(){
      if(busy) return; busy = true;
      let r;
      try{
        note = body.querySelector("#cwNote").value;
        r = startCancelCase({ dnNo, kind, plan:planFromState(), note, passcode:body.querySelector("#cwPass").value });
        await persist();
      }catch(e){ busy = false; draw(e.message||String(e)); return; }
      if(r.newDnNo){
        try{ const hh = dnHeaderFor(r.newDnNo), b = await dnBuildFromDb(hh); await dnfPut(hh.dispatch_branch_id, hh.dn_no, { text:b.text, file_name:hh.file_name, saved_ts:new Date().toISOString() }); }catch(e){}
      }
      started(r);
    }
    function started(r){
      const nd = r.newDnNo? formatDocNo("DN",r.newDnNo) : "";
      body.innerHTML = `<div class="box" style="margin-bottom:10px"><p style="font-weight:700;margin:0 0 4px">${escapeHtml(r.caseText)} started for ${escapeHtml(dn)}</p>
        <p class="muted" style="margin:0">Nothing has changed in your stock yet. It is posted when ${escapeHtml(receiver)}'s confirmation is imported${nd? " (or when the receipt voucher for "+escapeHtml(nd)+" arrives)" : ""}. Send them the file now.</p></div>
        ${nd? `<button class="btn btn-primary" id="cwShareNew" style="width:100%;margin-bottom:8px">${isTauriApp()? "📁 " : "📲 "}Send replacement ${escapeHtml(nd)} to ${escapeHtml(receiver)}</button>` : ""}
        <button class="btn ${nd? "btn-outline" : "btn-primary"}" id="cwShareNotice" style="width:100%;margin-bottom:8px">${isTauriApp()? "📁 " : "📲 "}Send cancellation notice to ${escapeHtml(receiver)}</button>
        <div id="cwMsg" class="muted" style="font-size:12.5px;margin-bottom:8px"></div>
        <button class="btn btn-ghost" id="cwDone">Done</button>`;
      const msg = body.querySelector("#cwMsg");
      const sn = body.querySelector("#cwShareNew");
      if(sn) sn.onclick=async ()=>{ try{ msg.textContent = dnShareMessage(await shareReplacementDN(r.newDnNo)); }catch(e){ msg.textContent = "Couldn't share: "+(e.message||e); } };
      body.querySelector("#cwShareNotice").onclick=async ()=>{ try{ msg.textContent = dnShareMessage(await shareCancelNotice(dnCaseByNo(r.caseNo))); }catch(e){ msg.textContent = "Couldn't share: "+(e.message||e); } };
      body.querySelector("#cwDone").onclick=()=>{ wrap.remove(); if(onDone) onDone(); else render(); };
    }
    draw();
  }

  // For a DN with a cancel waiting for the receiver: re-share, or post it WITHOUT the receiver's confirmation.
  function openPendingCancelModal(dnNo, onDone){
    const c = pendingCaseFor(dnNo);
    if(!c){ alert("No cancellation is waiting on "+formatDocNo("DN",dnNo)+"."); return; }
    const h = dnHeaderFor(dnNo), dn = formatDocNo("DN",dnNo), receiver = h.receive_branch_name;
    const wrap = openModal(dn+": cancel pending", `
      <p style="margin:0 0 6px">${escapeHtml(formatDocNo("CXL",c.case_no))} (${escapeHtml(CANCEL_KIND_LABEL[c.kind])}) is waiting for <b>${escapeHtml(receiver)}</b> to confirm. Your stock changes only when it does.</p>
      <button class="btn btn-outline" id="pcShare" style="width:100%;margin-bottom:6px">${isTauriApp()? "📁 " : "📲 "}Send the cancellation again</button>
      ${c.replaced_by? `<button class="btn btn-outline" id="pcShareNew" style="width:100%;margin-bottom:6px">Send replacement ${escapeHtml(formatDocNo("DN",c.replaced_by))} again</button>` : ""}
      <div id="pcMsg" class="muted" style="font-size:12.5px;margin-bottom:8px"></div>
      <div class="box" style="border-color:#b42318">
        <b>Cancel without confirmation</b>
        <p class="muted" style="margin:4px 0">Use this only if ${escapeHtml(receiver)} can't be reached. Your stock is posted now. If they still receive the goods, stock will be counted twice and ${escapeHtml(dn)} will show <b>Conflict</b>. Nothing is corrected automatically.</p>
        <label style="margin-top:6px">Type CANCEL ${escapeHtml(dn)}</label><input class="field" id="pcTyped" autocomplete="off">
        <label>Admin passcode</label><input class="field" id="pcPass" type="password" autocomplete="off">
        <div id="pcErr" style="color:#b42318;font-size:12.5px;margin-top:6px"></div>
        <button class="btn btn-primary" id="pcGo" style="margin-top:8px;background:#b42318">Cancel without confirmation</button>
      </div>`);
    const q = (s)=>wrap.querySelector(s);
    q("#pcShare").onclick=async ()=>{ try{ q("#pcMsg").textContent = dnShareMessage(await shareCancelNotice(c)); }catch(e){ q("#pcMsg").textContent = "Couldn't share: "+(e.message||e); } };
    const sn = q("#pcShareNew"); if(sn) sn.onclick=async ()=>{ try{ q("#pcMsg").textContent = dnShareMessage(await shareReplacementDN(c.replaced_by)); }catch(e){ q("#pcMsg").textContent = "Couldn't share: "+(e.message||e); } };
    let busy = false;
    q("#pcGo").onclick=async ()=>{
      if(busy) return; busy = true;
      try{ overridePendingCase({ dnNo, passcode:q("#pcPass").value, typed:q("#pcTyped").value }); await persist(); }
      catch(e){ busy = false; q("#pcErr").textContent = e.message||String(e); return; }
      wrap.remove(); if(onDone) onDone(); else render();
    };
  }
