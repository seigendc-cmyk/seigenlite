  // ---------------- Receive stock (receiving side): import, review, accept, variance ----------------
  // Rules this file exists to keep:
  //   * The receiver can NEVER edit a quantity. Accepting adds exactly the DN's
  //     quantities; if the count differs, the receiver reports a variance and
  //     no stock moves and no GRV number is used.
  //   * Receiving never creates a product, and never touches price or cost.
  //   * The GRV number is reserved only inside the Accept transaction.
  //   * Nothing written here is ever a "pending receipt": no stock_transfers row
  //     is created, and stock_received rows carry the DN link.

  // ---- database side ----
  function incomingHeader(fromBranchId, dnNo){
    return one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='in'",[fromBranchId,dnNo]);
  }
  function receiveContext(){
    return { ownBranchId:getBranchId(), ownBranchName:currentBranch(), lookup:incomingHeader,
      products:all("SELECT id,name,sku FROM products WHERE branch=?",[currentBranch()]) };
  }
  // Any signed-in user (a name is set) may receive; the name is recorded on everything.
  function requireSignedIn(){
    if(!String(sessionUser||"").trim()) throw new Error("Enter your name first (tap your name at the top), so the receipt is recorded against you.");
  }
  async function receiveCheckBytes(bytes){
    const text = decodeBytesUtf8(bytes);
    return { res: await checkIncomingDN(text, receiveContext()), text };
  }

  // The synchronous, all-or-nothing Accept: re-check, reserve the GRV number,
  // add quantities, write the header and link the lines — one transaction, no
  // persist. Any throw rolls everything back, including the number.
  function commitReceive(doc, now){
    requireSignedIn();
    const branch = currentBranch(), ts = now.toISOString(), iso = localIso(now);
    db.run("BEGIN");
    try{
      if(doc.from.branch_id===getBranchId()) throw new Error("This Delivery Note was dispatched by this branch.");
      if(!sameBranchName(doc.to.name, branch)) throw new Error("This Delivery Note is for \""+doc.to.name+"\", not this branch.");
      const rec = incomingHeader(doc.from.branch_id, doc.dn_no);
      if(rec && rec.status==="received") throw new Error("Already received as "+formatDocNo("GRV",rec.grv_no)+".");
      if(rec && rec.status==="cancelled") throw new Error("This Delivery Note was cancelled by "+doc.from.name+". Nothing was received.");
      if(doc.replaces) closeReplacedDN(doc, now);                       // the DN it replaces can no longer be received here
      const r = resolveLines(doc.items, all("SELECT id,name,sku FROM products WHERE branch=?",[branch]));
      if(r.problems.length) throw new Error("Some lines no longer match a product in this branch: "+r.problems.map(problemLineText).join("; "));
      const grv = reserveDocNumber("GRV");
      let units = 0;
      r.lines.forEach(l=>{
        units += l.item.qty;
        run("UPDATE products SET stock=stock+? WHERE id=?",[l.item.qty,l.product.id]);      // quantity only — never cost or price
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user,dn_branch_id,dn_no,grv_no) VALUES(?,?,?,?,?,?,?,?,?,?)",
          [ts,l.product.id,l.product.name,l.item.qty,grv.text+" from "+doc.from.name+" ("+doc.dn_display+")",branch,sessionUser,doc.from.branch_id,doc.dn_no,grv.n]);
      });
      const fileName = grvFileName(grv.n, doc.from.name, now);
      if(rec){
        run("UPDATE dispatch_docs SET status='received', grv_no=?, received_ts=?, received_iso=?, received_by=?, file_name=? WHERE dispatch_branch_id=? AND dn_no=? AND direction='in'",
          [grv.n,ts,iso,sessionUser,fileName,doc.from.branch_id,doc.dn_no]);
      } else {
        run(`INSERT INTO dispatch_docs(dispatch_branch_id,dispatch_branch_name,dn_no,receive_branch_name,direction,grv_no,created_ts,status,file_name,line_count,unit_total,created_iso,imported_ts,received_ts,received_iso,received_by)
             VALUES(?,?,?,?,'in',?,?,'received',?,?,?,?,?,?,?,?)`,
          [doc.from.branch_id,doc.from.name,doc.dn_no,branch,grv.n,ts,fileName,doc.items.length,units,doc.created_iso,ts,ts,iso,sessionUser]);
      }
      recordDnEvent({ dnBranchId:doc.from.branch_id, dnNo:doc.dn_no, type:"received", actorBranchId:getBranchId(), actorName:branch,
        fromName:doc.from.name, toName:branch, ts:iso, grvNo:grv.n, detail:{ dn_created_iso:doc.created_iso, received_by:sessionUser, units } });
      logAudit("Receive Stock", "", grv.text+": "+doc.items.length+" line"+(doc.items.length===1?"":"s")+", "+units+" unit"+(units===1?"":"s")+" from "+doc.from.name+" ("+doc.dn_display+")");
      db.run("COMMIT");
      return { grv, header:incomingHeader(doc.from.branch_id, doc.dn_no), fileName, receivedIso:iso };
    }catch(e){
      try{ db.run("ROLLBACK"); }catch(_){}
      throw e;
    }
  }

  // A variance report changes no stock and uses no GRV number. Calling it again
  // (after a recount) replaces the earlier report.
  function commitVariance(doc, report, now){
    requireSignedIn();
    const ts = now.toISOString();
    db.run("BEGIN");
    try{
      const rec = incomingHeader(doc.from.branch_id, doc.dn_no);
      if(rec && rec.status==="received") throw new Error("Already received as "+formatDocNo("GRV",rec.grv_no)+".");
      if(rec && rec.status==="cancelled") throw new Error("This Delivery Note was cancelled by "+doc.from.name+". No variance can be reported.");
      const json = JSON.stringify({ flags:report.flags, note:report.note, reported_by:sessionUser });
      const units = doc.items.reduce((s,i)=>s+i.qty,0);
      if(rec) run("UPDATE dispatch_docs SET variance_json=?, variance_ts=?, status='variance' WHERE dispatch_branch_id=? AND dn_no=? AND direction='in'",[json,ts,doc.from.branch_id,doc.dn_no]);
      else run(`INSERT INTO dispatch_docs(dispatch_branch_id,dispatch_branch_name,dn_no,receive_branch_name,direction,created_ts,status,line_count,unit_total,created_iso,imported_ts,variance_json,variance_ts)
                VALUES(?,?,?,?,'in',?,'variance',?,?,?,?,?,?)`,
        [doc.from.branch_id,doc.from.name,doc.dn_no,currentBranch(),ts,doc.items.length,units,doc.created_iso,ts,json,ts]);
      recordDnEvent({ dnBranchId:doc.from.branch_id, dnNo:doc.dn_no, type:"variance", actorBranchId:getBranchId(), actorName:currentBranch(),
        fromName:doc.from.name, toName:currentBranch(), ts,
        detail:{ dn_created_iso:doc.created_iso, flags:report.flags.map(f=>({ code:f.code, name:f.name, dn:f.dn, counted:f.counted, diff:f.diff })), note:report.note, reported_by:sessionUser } });
      logAudit("Variance Report","",doc.dn_display+" from "+doc.from.name+": "+report.flags.length+" line"+(report.flags.length===1?"":"s")+" flagged, stock not received");
      db.run("COMMIT");
    }catch(e){
      try{ db.run("ROLLBACK"); }catch(_){}
      throw e;
    }
  }

  // ---- cancellation (Phase 5) ----
  // A cancelled DN is a TERMINAL state here: received XOR cancelled. The row is kept (a tombstone) even if the DN
  // was never imported, so a forwarded copy of the file can never be received afterwards.
  // Synchronous, no transaction of its own (the caller owns BEGIN/COMMIT). Idempotent.
  // o: { fromBranchId, fromName, dnNo, cancelNo, nonce, replacedBy, kind, lineCount, unitTotal, createdIso, now }
  function tombstoneDN(o){
    const rec = incomingHeader(o.fromBranchId, o.dnNo);
    if(rec && rec.status==="received") throw new Error(formatDocNo("DN",o.dnNo)+" was already received here as "+formatDocNo("GRV",rec.grv_no)+", so it can't be cancelled.");
    if(rec && rec.status==="cancelled") return rec;
    const ts = o.now.toISOString(), branch = currentBranch();
    const varianceSeen = !!(rec && rec.variance_json);
    if(rec) run("UPDATE dispatch_docs SET status='cancelled', cancel_no=?, cancel_nonce=?, cancelled_ts=?, replaced_by=?, cancel_kind=? WHERE dispatch_branch_id=? AND dn_no=? AND direction='in'",
      [o.cancelNo==null?null:o.cancelNo,o.nonce||"",ts,o.replacedBy==null?null:o.replacedBy,o.kind||"",o.fromBranchId,o.dnNo]);
    else run(`INSERT INTO dispatch_docs(dispatch_branch_id,dispatch_branch_name,dn_no,receive_branch_name,direction,created_ts,status,line_count,unit_total,created_iso,imported_ts,cancel_no,cancel_nonce,cancelled_ts,replaced_by,cancel_kind)
              VALUES(?,?,?,?,'in',?,'cancelled',?,?,?,?,?,?,?,?,?)`,
      [o.fromBranchId,o.fromName,o.dnNo,branch,ts,o.lineCount||0,o.unitTotal||0,o.createdIso||"",ts,o.cancelNo==null?null:o.cancelNo,o.nonce||"",ts,o.replacedBy==null?null:o.replacedBy,o.kind||""]);
    recordDnEvent({ dnBranchId:o.fromBranchId, dnNo:o.dnNo, type:"cancelled", actorBranchId:getBranchId(), actorName:branch, fromName:o.fromName, toName:branch, ts:localIso(o.now),
      detail:{ cancel_no:o.cancelNo==null?null:o.cancelNo, replaced_by:o.replacedBy==null?null:o.replacedBy, variance_seen:varianceSeen, kind:o.kind||"" } });
    logAudit("Cancel confirmed", "", formatDocNo("DN",o.dnNo)+" from "+o.fromName+" cancelled"+(o.replacedBy? " (replaced by "+formatDocNo("DN",o.replacedBy)+")" : ""));
    return incomingHeader(o.fromBranchId, o.dnNo);
  }
  // A reissued DN closes the DN it replaces (a tombstone), unless that one was already received.
  function closeReplacedDN(doc, now){
    return tombstoneDN({ fromBranchId:doc.from.branch_id, fromName:doc.from.name, dnNo:doc.replaces, cancelNo:doc.cancel_no, nonce:doc.cancel_nonce,
      replacedBy:doc.dn_no, kind:"reissue", now });
  }
  // Receiver confirms a cancellation notice. One transaction; the caller awaits persist().
  function commitCancelNotice(doc, now){
    requireSignedIn();
    db.run("BEGIN");
    try{
      const rec = tombstoneDN({ fromBranchId:doc.from.branch_id, fromName:doc.from.name, dnNo:doc.dn_no, cancelNo:doc.cancel_no, nonce:doc.nonce,
        replacedBy:doc.replaced_by, kind:doc.kind, lineCount:doc.items.length, unitTotal:doc.totals.units, now });
      db.run("COMMIT");
      return rec;
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
  }
  // Importing a reissued DN closes the old one for this receiver at once (a tombstone), before anything is accepted.
  function commitReplacementClose(doc, now){
    requireSignedIn();
    db.run("BEGIN");
    try{
      const rec = closeReplacedDN(doc, now);
      db.run("COMMIT");
      return rec;
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
  }
  // The confirmation for a tombstoned DN, rebuilt from the row (no stored file needed).
  async function buildAckFromRow(h){
    if(!h.cancel_no || !h.cancel_nonce) throw new Error("This cancellation has no reference to confirm against.");
    const varied = !!h.variance_json;
    return await buildAck({ cancelNo:h.cancel_no, nonce:h.cancel_nonce, dnNo:h.dn_no, fromBranchId:h.dispatch_branch_id, fromName:h.dispatch_branch_name,
      toBranchId:getBranchId(), toName:currentBranch(), varianceSeen:varied, confirmedIso:localIso(new Date(h.cancelled_ts||Date.now())) });
  }
  function cancelAckFileName(cancelNo, dispatcherName, date){
    return formatDocNo("CXL",cancelNo)+"-"+sanitizeBranchName(dispatcherName)+"-"+fileDatePart(date)+"-"+fileTimePart(date)+"-confirmed"+DOC_FILE_EXT;
  }
  async function cancelAckShare(h){
    const ack = await buildAckFromRow(h), text = serializeAck(ack);
    const msg = "Cancellation confirmed for "+ack.dn_display+" ("+ack.cancel_display+"): "+ack.to.name+" did not receive it and will not. In seiGEN Commerce Lite open Dispatch history \u2192 Import and choose the attached file.";
    return shareDocFile({ fileName:cancelAckFileName(h.cancel_no, h.dispatch_branch_name, new Date(h.cancelled_ts||Date.now())), text, folder:"Cancellations", title:ack.cancel_display,
      phone:dnPhoneFor(h.dispatch_branch_name), shareText:msg, whatsappText:msg+" (Attach the file from the folder that just opened.)" });
  }

  // ---- GRV file + voucher ----
  async function buildGRVFromCommit(doc, c){
    return await buildGRV({ grvNo:c.grv.n, dnNo:doc.dn_no, fromBranchId:doc.from.branch_id, fromName:doc.from.name,
      toBranchId:getBranchId(), toName:currentBranch(), receivedIso:c.receivedIso,
      items:doc.items.map(i=>({ code:i.code, name:i.name, unit:i.unit, qty:i.qty })) });
  }
  const grvKey = (dnNo)=> "GRV:"+dnNo;
  async function dnThumbList(h, grvDoc){
    const stored = await dnfGet(h.dispatch_branch_id, h.dn_no);
    if(!stored || !stored.text) return grvDoc.items.map(()=>null);
    const p = await parseDN(stored.text);
    if(!p.ok) return grvDoc.items.map(()=>null);
    return grvDoc.items.map((it,i)=>{
      const m = p.doc.items.find(x=>dnrKey(x.code)===dnrKey(it.code) && dnrKey(x.name)===dnrKey(it.name));
      return m && m.thumb || null;
    });
  }
  // Stored GRV file, or rebuilt from the linked stock_received lines.
  async function grvGetRecord(h){
    const stored = await dnfGet(h.dispatch_branch_id, grvKey(h.dn_no));
    if(stored && stored.text){
      const p = await parseGRV(stored.text);
      if(p.ok) return { doc:p.doc, text:stored.text, rebuilt:false };
    }
    const rows = all(`SELECT sr.name AS name, sr.qty AS qty, p.sku AS code FROM stock_received sr LEFT JOIN products p ON p.id=sr.product_id
                      WHERE sr.dn_branch_id=? AND sr.dn_no=? AND sr.grv_no=? AND sr.branch=? ORDER BY sr.id`,[h.dispatch_branch_id,h.dn_no,h.grv_no,currentBranch()]);
    const doc = await buildGRV({ grvNo:h.grv_no, dnNo:h.dn_no, fromBranchId:h.dispatch_branch_id, fromName:h.dispatch_branch_name,
      toBranchId:getBranchId(), toName:h.receive_branch_name, receivedIso:h.received_iso || localIso(new Date(h.received_ts)),
      items:rows.map(r=>({ code:r.code||"", name:r.name, qty:r.qty })) });
    const text = serializeGRV(doc);
    try{ await dnfPut(h.dispatch_branch_id, grvKey(h.dn_no), { text, file_name:h.file_name, saved_ts:new Date().toISOString() }); }catch(e){}
    return { doc, text, rebuilt:true };
  }
  function grvVoucherHtml(doc, thumbs){
    const when = new Date(doc.received_iso);
    const rows = doc.items.map((it,i)=>`
      <tr>
        <td style="width:14mm">${thumbs && thumbs[i]? `<img class="dn-thumb" src="${thumbs[i]}">` : ""}</td>
        <td>${escapeHtml(it.code||"—")}</td>
        <td>${escapeHtml(it.name)}</td>
        <td style="text-align:right">${it.qty} ${escapeHtml(it.unit)}</td>
      </tr>`).join("");
    return `
      <div class="report-print dn-voucher">
        <h2><span class="cat-vendor">${escapeHtml(getSetting("shop_name","My Shop"))}</span> — Goods Received Voucher</h2>
        <div class="sub">${escapeHtml(doc.grv_display)} · for ${escapeHtml(doc.dn_display)}</div>
        <table class="dn-meta">
          <tr><td>Received from</td><td><b>${escapeHtml(doc.from.name)}</b></td><td>Received at</td><td><b>${escapeHtml(doc.to.name)}</b></td></tr>
          <tr><td>Date</td><td>${escapeHtml(when.toLocaleDateString())}</td><td>Time</td><td>${escapeHtml(when.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}))}</td></tr>
        </table>
        <table class="dn-items">
          <thead><tr><th></th><th>Code</th><th>Item</th><th style="text-align:right">Qty</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p><b>${doc.totals.lines}</b> line${doc.totals.lines===1?"":"s"} · <b>${doc.totals.units}</b> unit${doc.totals.units===1?"":"s"}</p>
        <div class="dn-sign"><div>Received by: ______________________</div><div>Checked by: ______________________</div></div>
      </div>`;
  }
  // Browsers use the page title as the default file name for "Save as PDF".
  function printGRVVoucher(doc, thumbs, fileName){
    document.getElementById("printArea").innerHTML = grvVoucherHtml(doc, thumbs);
    const old = document.title;
    if(fileName) document.title = fileName.replace(/\.json$/,"");
    setTimeout(()=>{ printNow(); if(fileName) setTimeout(()=>{ document.title = old; }, 1500); }, 150);
  }
  // The receiver sends the GRV file back to the dispatcher (Phase 4). The number
  // comes from this branch's register when it has one; otherwise WhatsApp opens
  // with the text and no contact chosen.
  const grvSendLabel = (dispatcherName)=> (isTauriApp()? "📁 " : "📲 ")+"Send GRV to "+dispatcherName;
  function grvSendText(doc){
    return "Goods Received Voucher "+doc.grv_display+" for "+doc.dn_display+", received at "+doc.to.name+" on "+(isoDateText(doc.received_iso)||"")
      +". In seiGEN Commerce Lite open Dispatch history → Import GRV and choose the attached file.";
  }
  function grvShare(h, rec){
    const text = grvSendText(rec.doc);
    return shareDocFile({ fileName:h.file_name, text:rec.text, folder:"Receipts", title:rec.doc.grv_display, phone:dnPhoneFor(h.dispatch_branch_name),
      shareText:text, whatsappText:text+" (Attach the file from the folder that just opened.)" });
  }
  const grvHasDispatcherNumber = (h)=> !!String(dnPhoneFor(h.dispatch_branch_name)||"").trim();
  // WhatsApp to management, same opener per build; no number -> wa.me/?text=
  function openManagementWhatsApp(message){
    return openExternalUrl(dnWhatsAppUrl(getSetting("management_whatsapp",""), message));
  }

  // ---- screens ----
  function openReceiveWithFile(file){ openReceiveScreen(file); }
  function openReceiveScreen(file){
    const wrap = openModal("Receive stock", `
      <p class="muted" style="margin-top:0">Choose the Delivery Note file you were sent. Any file name works.</p>
      <input type="file" id="rcFile">`);
    const body = wrap.querySelector(".modal-body");
    wrap.querySelector("#rcFile").onchange=(e)=>{ const f = e.target.files[0]; e.target.value=""; if(f) handleFile(f); };
    if(file) handleFile(file);
    async function handleFile(f){
      body.innerHTML = `<div class="box" style="text-align:center"><p style="margin:0">Reading…</p></div>`;
      let bytes;
      try{ bytes = await readFileBytes(f); }catch(e){ return rcBlocked(wrap, body, { message:"Could not read that file." }); }
      const fmt = sniffJsonFormat(bytes);
      if(fmt===CANCEL_FORMAT) return rcCancelFlow(wrap, body, bytes);
      if(fmt===ACK_FORMAT) return rcBlocked(wrap, body, { message:"This is a cancellation confirmation. It belongs with the branch that sent the cancellation: open Dispatch history and use Import there." });
      let out;
      try{ out = await receiveCheckBytes(bytes); }catch(e){ return rcBlocked(wrap, body, { message:"Could not read that file as a Delivery Note." }); }
      rcShow(wrap, body, out.res, out.text);
    }
  }
  // Open a stored DN again (variance-pending) without importing it.
  async function openReceiveFromText(text){
    const wrap = openModal("Receive stock", `<div class="box" style="text-align:center"><p style="margin:0">Opening…</p></div>`);
    const body = wrap.querySelector(".modal-body");
    rcShow(wrap, body, await checkIncomingDN(text, receiveContext()), text);
  }
  async function rcShow(wrap, body, res, text){
    if(!res.ok) return rcBlocked(wrap, body, res);
    // A reissued DN closes the one it replaces, for this branch, as soon as it is opened.
    if(res.replaces && !(res.replaces.record && res.replaces.record.status==="cancelled")){
      try{ commitReplacementClose(res.doc, new Date()); await persist(); }
      catch(e){ return rcBlocked(wrap, body, { message:"Nothing was changed. "+(e.message||String(e)) }); }
    }
    rcReview(wrap, body, res, text);
  }
  // The receiver's answer to a cancellation notice: confirm it (a tombstone) and send the confirmation back.
  async function rcCancelFlow(wrap, body, bytes){
    let res;
    try{ res = await checkIncomingCancel(decodeBytesUtf8(bytes), { ownBranchId:getBranchId(), ownBranchName:currentBranch(), lookup:incomingHeader }); }
    catch(e){ return rcBlocked(wrap, body, { message:"Could not read that file as a cancellation notice." }); }
    if(!res.ok) return rcBlocked(wrap, body, res);
    const doc = res.doc;
    const sendAck = async (h, msgEl)=>{ try{ msgEl.textContent = dnShareMessage(await cancelAckShare(h)); }catch(e){ msgEl.textContent = "Couldn't share: "+(e.message||e); } };
    function done(h, lead){
      body.innerHTML = `<div class="box" style="text-align:center;margin-bottom:10px"><p style="font-size:16px;font-weight:700;margin:0 0 4px">${escapeHtml(lead)}</p>
        <p class="muted" style="margin:0">${escapeHtml(doc.dn_display)} can no longer be received here. ${escapeHtml(doc.from.name)} must now import your confirmation.</p></div>
        <button class="btn btn-primary" id="rcAckSend" style="width:100%">${isTauriApp()? "📁 " : "📲 "}Send confirmation to ${escapeHtml(doc.from.name)}</button>
        <div id="rcAckMsg" class="muted" style="font-size:12.5px;margin:8px 0"></div>
        <button class="btn btn-ghost" id="rcAckDone">Done</button>`;
      body.querySelector("#rcAckSend").onclick=()=>sendAck(h, body.querySelector("#rcAckMsg"));
      body.querySelector("#rcAckDone").onclick=()=>{ wrap.remove(); render(); };
    }
    if(res.already) return done(res.record, "Already cancelled");
    body.innerHTML = `
      <div class="box" style="margin-bottom:8px;border-color:#b42318">
        <div style="font-size:15px;font-weight:700">${escapeHtml(doc.cancel_display)}: ${escapeHtml(doc.dn_display)} cancelled</div>
        <div class="pmeta">By <b>${escapeHtml(doc.from.name)}</b> · ${escapeHtml(CANCEL_KIND_LABEL[doc.kind]||"")}${doc.replaced_by? " · replaced by "+escapeHtml(formatDocNo("DN",doc.replaced_by)) : ""}</div>
        ${res.record && res.record.status==="variance"? `<div class="pmeta" style="color:#b42318">You reported a variance on this Delivery Note. It stays on record.</div>` : ""}
      </div>
      <p style="margin:0 0 6px">This Delivery Note was cancelled. If you have not received the goods, confirm below. It can then never be received here. Lines that were on it:</p>
      <div style="max-height:34vh;overflow:auto">${rcItemsHtml(doc)}</div>
      <p class="muted" style="margin:8px 0;font-size:12.5px">If the goods have already arrived, do not confirm: close this and Accept the Delivery Note instead.</p>
      <div style="display:flex;gap:8px"><button class="btn btn-outline" id="rcCxNo" style="flex:1">Close</button><button class="btn btn-primary" id="rcCxYes" style="flex:1">Confirm cancellation</button></div>`;
    body.querySelector("#rcCxNo").onclick=()=>wrap.remove();
    let busy = false;
    body.querySelector("#rcCxYes").onclick=async ()=>{
      if(busy) return; busy = true;
      let h;
      try{ h = commitCancelNotice(doc, new Date()); }
      catch(e){ return rcBlocked(wrap, body, { message:"Nothing was changed. "+(e.message||String(e)) }); }
      try{ await persist(); }catch(e){}
      done(h, "Cancellation confirmed");
    };
  }
  function rcBlocked(wrap, body, res){
    const list = res.problems? `<div style="max-height:40vh;overflow:auto;margin:8px 0">${res.problems.map(p=>`<div class="pmeta" style="margin-bottom:4px">• ${escapeHtml(problemLineText(p))}</div>`).join("")}</div>` : "";
    body.innerHTML = `<p style="margin:0 0 6px"><b>${escapeHtml(res.message)}</b></p>${list}
      ${res.stage==="products"? `<button class="btn btn-primary" id="rcReportUnmatched" style="margin-bottom:8px">Report to management</button>` : ""}
      <button class="btn btn-outline" id="rcClose">Close</button>`;
    body.querySelector("#rcClose").onclick=()=>wrap.remove();
    if(res.record && res.record.status==="received" && ["duplicate","received","replaces-received"].includes(res.stage)){
      const b = document.createElement("button"); b.className = "btn btn-primary"; b.style.cssText = "margin-bottom:8px;display:block";
      b.textContent = grvSendLabel(res.record.dispatch_branch_name);
      b.onclick=async ()=>{ try{ const rec = await grvGetRecord(res.record); await grvShare(res.record, rec); }catch(e){ alert("Couldn't share: "+(e.message||e)); } };
      body.querySelector("#rcClose").before(b);
    }
    const rep = body.querySelector("#rcReportUnmatched");
    if(rep) rep.onclick=()=>{ openManagementWhatsApp(unmatchedMessage(res.doc, currentBranch(), res.problems, new Date())); };
  }
  function rcItemsHtml(doc){
    return doc.items.map(it=>`<div class="product-row" style="align-items:center"><div style="display:flex;gap:8px;align-items:center">
        ${it.thumb? `<img src="${it.thumb}" style="width:34px;height:34px;object-fit:cover;border-radius:4px;flex:none">` : `<span style="width:34px;height:34px;border-radius:4px;background:var(--border);flex:none"></span>`}
        <div><div class="pname">${escapeHtml(it.name)}</div><div class="pmeta">${escapeHtml(it.code||"no code")}</div></div></div>
        <b style="flex:none">${it.qty} ${escapeHtml(it.unit)}</b></div>`).join("");
  }
  // Read-only: there are no inputs anywhere on this screen.
  function rcReview(wrap, body, res, text){
    const doc = res.doc, when = new Date(doc.created_iso);
    let busy = false;
    body.innerHTML = `
      <div class="box" style="margin-bottom:8px">
        <div style="font-size:15px;font-weight:700">${escapeHtml(doc.dn_display)}</div>
        <div class="pmeta">From <b>${escapeHtml(doc.from.name)}</b> · ${escapeHtml(when.toLocaleDateString())} ${escapeHtml(when.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}))}</div>
      </div>
      ${res.replaces? `<div class="box" style="margin-bottom:8px"><b>Replaces ${escapeHtml(formatDocNo("DN",res.replaces.dnNo))}</b>: that Delivery Note is now closed for this branch and can't be received. Check what you counted against this one.
        <div style="margin-top:6px"><button class="btn btn-sm btn-outline" id="rcSendCancelAck">Send cancellation confirmation for ${escapeHtml(formatDocNo("DN",res.replaces.dnNo))}</button></div></div>` : ""}
      ${res.resume? `<div class="box" style="margin-bottom:8px;color:#b42318;font-weight:600">A variance was already reported for this Delivery Note${res.record&&res.record.variance_ts? " on "+escapeHtml(new Date(res.record.variance_ts).toLocaleDateString()) : ""}. No stock has been received. After a recount you can Accept it as-is or report again.</div>` : ""}
      <div style="max-height:42vh;overflow:auto">${rcItemsHtml(doc)}</div>
      <p style="margin:10px 0"><b>${doc.totals.lines}</b> line${doc.totals.lines===1?"":"s"} · <b>${doc.totals.units}</b> unit${doc.totals.units===1?"":"s"}</p>
      <div style="display:flex;gap:8px"><button class="btn btn-outline" id="rcVariance" style="flex:1">Report variance</button><button class="btn btn-primary" id="rcAccept" style="flex:1">Accept</button></div>`;
    body.querySelector("#rcVariance").onclick=()=>rcVarianceForm(wrap, body, res, text);
    const sca = body.querySelector("#rcSendCancelAck");
    if(sca) sca.onclick=async ()=>{ try{ const h = incomingHeader(doc.from.branch_id, doc.replaces); await cancelAckShare(h); }catch(e){ alert("Couldn't share: "+(e.message||e)); } };
    body.querySelector("#rcAccept").onclick=()=>{
      body.innerHTML = `
        <p style="margin:0 0 6px;font-weight:700">Accept ${escapeHtml(doc.dn_display)}?</p>
        <p style="margin:0 0 12px">Stock will be added exactly as shown. Quantities cannot be edited.</p>
        <div style="display:flex;gap:8px"><button class="btn btn-outline" id="rcNo" style="flex:1">Back</button><button class="btn btn-primary" id="rcYes" style="flex:1">Yes, add the stock</button></div>`;
      body.querySelector("#rcNo").onclick=()=>rcReview(wrap, body, res, text);
      const yes = body.querySelector("#rcYes");
      yes.onclick=async ()=>{
        if(busy) return; busy = true; yes.disabled = true;               // double-tap guard
        await rcAccept(wrap, body, res, text);
      };
    };
  }
  async function rcAccept(wrap, body, res, text){
    const doc = res.doc;
    let c;
    try{ c = commitReceive(doc, new Date()); }
    catch(e){
      body.innerHTML = `<p style="margin:0 0 10px"><b>Nothing was received.</b> ${escapeHtml(e.message||String(e))}</p><button class="btn btn-outline" id="rcClose">Close</button>`;
      body.querySelector("#rcClose").onclick=()=>{ wrap.remove(); render(); };
      return;
    }
    // ---- from here the GRV exists ----
    let persistFailed = false;
    try{ await persist(); }catch(e){ persistFailed = true; }
    const h = c.header;
    try{
      const grv = await buildGRVFromCommit(doc, c);
      const grvText = serializeGRV(grv);
      try{ await dnfPut(doc.from.branch_id, grvKey(doc.dn_no), { text:grvText, file_name:c.fileName, saved_ts:new Date().toISOString() }); }catch(e){}
      try{ await dnfPut(doc.from.branch_id, doc.dn_no, { text, file_name:"", saved_ts:new Date().toISOString() }); }catch(e){}
      let savedNote = "";
      if(isTauriApp()){ try{ savedNote = "Saved to "+(await tauriSaveFile("Receipts", c.fileName, grvText)).full; }catch(e){} }
      rcVoucher(wrap, body, { header:h, grv, text:grvText, thumbs:doc.items.map(i=>i.thumb||null), persistFailed, savedNote });
    }catch(e){
      body.innerHTML = `<div class="box"><p style="font-weight:700;margin:0 0 6px">${escapeHtml(c.grv.text)} was recorded</p>
        <p class="muted" style="margin:0">The stock has been added, but the voucher could not be built (${escapeHtml(e.message||String(e))}). Open <b>Receipts history</b> and choose <b>View voucher</b> to create it again.</p></div>
        <button class="btn btn-primary" id="rcClose" style="margin-top:10px">Close</button>`;
      body.querySelector("#rcClose").onclick=()=>{ wrap.remove(); render(); };
    }
  }
  function rcVoucher(wrap, body, r){
    body.innerHTML = `
      <div class="box" style="text-align:center;margin-bottom:10px">
        <p style="font-size:16px;font-weight:700;margin:0 0 4px">${escapeHtml(r.grv.grv_display)} — stock received</p>
        <p class="muted" style="margin:0">${r.grv.totals.lines} line${r.grv.totals.lines===1?"":"s"} · ${r.grv.totals.units} unit${r.grv.totals.units===1?"":"s"} from ${escapeHtml(r.grv.from.name)}</p>
        ${r.persistFailed? `<p style="color:#b42318;margin:6px 0 0;font-size:12.5px">Warning: this device couldn't save to its storage just now. Keep the app open and don't clear browser data.</p>` : ""}
        ${r.savedNote? `<p class="muted" style="margin:6px 0 0;font-size:12px">${escapeHtml(r.savedNote)}</p>` : ""}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn btn-primary" id="rvShare" style="flex:1">${escapeHtml(grvSendLabel(r.grv.from.name))}</button>
        <button class="btn btn-outline" id="rvPrint">🖨️ Print voucher</button>
      </div>
      <div id="rvMsg" class="muted" style="font-size:12.5px;margin-bottom:8px">${grvHasDispatcherNumber(r.header)? "" : escapeHtml("No WhatsApp number for "+r.grv.from.name+" in this branch's register — you will pick the contact in WhatsApp.")}</div>
      <div class="card" style="max-height:38vh;overflow:auto;padding:6px">${grvVoucherHtml(r.grv, r.thumbs)}</div>
      <button class="btn btn-ghost" id="rvDone" style="margin-top:10px">Done</button>`;
    body.querySelector("#rvShare").onclick=async ()=>{
      try{ body.querySelector("#rvMsg").textContent = dnShareMessage(await grvShare(r.header, { doc:r.grv, text:r.text })); }
      catch(e){ body.querySelector("#rvMsg").textContent = "Couldn't share: "+(e.message||e); }
    };
    body.querySelector("#rvPrint").onclick=()=>printGRVVoucher(r.grv, r.thumbs, r.header.file_name);
    body.querySelector("#rvDone").onclick=()=>{ wrap.remove(); render(); };
  }

  // Report variance: flag lines and enter what was counted. Information only.
  function rcVarianceForm(wrap, body, res, text){
    const doc = res.doc;
    let prev = null;
    try{ prev = res.record && res.record.variance_json? JSON.parse(res.record.variance_json) : null; }catch(e){}
    const prevFlag = (i)=> prev && prev.flags.find(f=>f.index===i);
    body.innerHTML = `
      <p style="margin:0 0 4px;font-weight:700">Report variance — ${escapeHtml(doc.dn_display)}</p>
      <p class="muted" style="margin:0 0 8px;font-size:12.5px">Tick each line that differs and enter what you counted. This is a report to management only — no stock is added and no GRV is created.</p>
      <div style="max-height:40vh;overflow:auto">${doc.items.map((it,i)=>{ const pf = prevFlag(i); return `
        <div class="card" style="padding:8px;margin-bottom:6px">
          <label style="display:flex;gap:8px;align-items:center;margin:0"><input type="checkbox" data-flag="${i}" ${pf?"checked":""} style="width:auto;margin:0">
            <span style="flex:1"><b>${escapeHtml(it.name)}</b> <span class="muted">${escapeHtml(it.code||"no code")} · DN ${it.qty}</span></span></label>
          <input class="field" data-counted="${i}" inputmode="numeric" placeholder="Counted" value="${pf? pf.counted : ""}" style="margin-top:6px" ${pf?"":"disabled"}>
        </div>`; }).join("")}</div>
      <label>Note (optional)</label>
      <textarea class="field" id="rvNote" rows="2">${escapeHtml(prev? prev.note||"" : "")}</textarea>
      <div id="rvErr" style="color:#b42318;font-size:12.5px;margin-top:6px"></div>
      <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-outline" id="rvBack">Back</button><button class="btn btn-primary" id="rvSend" style="flex:1">Send report</button></div>`;
    body.querySelectorAll("[data-flag]").forEach(cb=>cb.onchange=()=>{
      const inp = body.querySelector('[data-counted="'+cb.dataset.flag+'"]'); inp.disabled = !cb.checked; if(cb.checked) inp.focus();
    });
    body.querySelector("#rvBack").onclick=()=>rcReview(wrap, body, res, text);
    let sent = false;
    body.querySelector("#rvSend").onclick=async ()=>{
      if(sent) return;
      const flags = [...body.querySelectorAll("[data-flag]:checked")].map(cb=>({ index:+cb.dataset.flag, counted:body.querySelector('[data-counted="'+cb.dataset.flag+'"]').value }));
      const r = buildVarianceReport(doc, { flags, note:body.querySelector("#rvNote").value });
      if(!r.ok){ body.querySelector("#rvErr").innerHTML = r.errors.map(escapeHtml).join("<br>"); return; }
      sent = true;
      const now = new Date();
      try{ commitVariance(doc, r.report, now); }
      catch(e){ sent = false; body.querySelector("#rvErr").textContent = e.message||String(e); return; }
      try{ await persist(); }catch(e){}
      try{ await dnfPut(doc.from.branch_id, doc.dn_no, { text, file_name:"", saved_ts:now.toISOString() }); }catch(e){}
      const msg = varianceMessage(doc, currentBranch(), r.report, now);
      try{ openManagementWhatsApp(msg); }catch(e){}
      body.innerHTML = `
        <div class="box" style="text-align:center;margin-bottom:8px"><p style="font-weight:700;margin:0 0 4px">Variance reported</p>
          <p class="muted" style="margin:0">Stock was NOT received and no GRV number was used. The Delivery Note stays open under Receipts history for a recount.</p></div>
        <pre style="white-space:pre-wrap;font-size:12px;background:var(--border);padding:8px;border-radius:6px;max-height:32vh;overflow:auto">${escapeHtml(msg)}</pre>
        <div style="display:flex;gap:8px"><button class="btn btn-outline" id="rvAgain" style="flex:1">Open WhatsApp again</button><button class="btn btn-primary" id="rvClose" style="flex:1">Done</button></div>`;
      body.querySelector("#rvAgain").onclick=()=>{ try{ openManagementWhatsApp(msg); }catch(e){} };
      body.querySelector("#rvClose").onclick=()=>{ wrap.remove(); render(); };
    };
  }

  // ---- receipts history ----
  function openReceiptsHistory(){
    const wrap = openModal("Receipts history", "");
    const body = wrap.querySelector(".modal-body");
    function list(msg){
      const rows = all("SELECT * FROM dispatch_docs WHERE direction='in' ORDER BY imported_ts DESC, dn_no DESC");
      body.innerHTML = (msg? `<div class="box" style="margin-bottom:8px;font-size:12.5px">${escapeHtml(msg)}</div>` : "") + (rows.length===0? `<p class="muted">Nothing received yet.</p>` : rows.map(h=>{
        const received = h.status==="received", cancelled = h.status==="cancelled";
        return `<div class="card" style="padding:10px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center"><b>${escapeHtml(formatDocNo("DN",h.dn_no))}</b>
            <span style="font-size:12px;font-weight:600;${received?"":"color:#b42318"}">${received? "Received · "+escapeHtml(formatDocNo("GRV",h.grv_no)) : cancelled? "Cancelled"+(h.replaced_by? " · replaced by "+escapeHtml(formatDocNo("DN",h.replaced_by)) : "") : "Variance pending"}</span></div>
          <div class="pmeta">From ${escapeHtml(h.dispatch_branch_name)} · ${escapeHtml(new Date(received? h.received_ts : cancelled? (h.cancelled_ts||h.imported_ts) : (h.variance_ts||h.imported_ts)).toLocaleString())}</div>
          <div class="pmeta">${h.line_count||0} line${h.line_count===1?"":"s"} · ${h.unit_total||0} unit${h.unit_total===1?"":"s"}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            ${received? `<button class="btn btn-sm btn-outline" data-view="${h.dispatch_branch_id}|${h.dn_no}">View voucher</button><button class="btn btn-sm btn-outline" data-share="${h.dispatch_branch_id}|${h.dn_no}">${escapeHtml(grvSendLabel(h.dispatch_branch_name))}</button>`
                      : cancelled? (h.cancel_no? `<button class="btn btn-sm btn-outline" data-cxack="${h.dispatch_branch_id}|${h.dn_no}">Send confirmation</button>` : "")
                      : `<button class="btn btn-sm btn-primary" data-reopen="${h.dispatch_branch_id}|${h.dn_no}">Reopen</button>`}
          </div></div>`; }).join(""));
      const hdr = (k)=>{ const [b,n] = k.split("|"); return incomingHeader(b,+n); };
      body.querySelectorAll("[data-cxack]").forEach(b=>b.onclick=async ()=>{
        try{ const s = await cancelAckShare(hdr(b.dataset.cxack)); list(dnShareMessage(s)); }catch(e){ list("Couldn't share: "+(e.message||e)); }
      });
      body.querySelectorAll("[data-view]").forEach(b=>b.onclick=async ()=>{
        try{ const h = hdr(b.dataset.view), rec = await grvGetRecord(h); const thumbs = await dnThumbList(h, rec.doc);
          const w2 = openModal("Goods Received Voucher — "+rec.doc.grv_display, `<div class="card" style="max-height:60vh;overflow:auto;padding:6px">${grvVoucherHtml(rec.doc, thumbs)}</div>
            <button class="btn btn-primary" id="gvPrint" style="margin-top:10px">🖨️ Print voucher</button>`);
          w2.querySelector("#gvPrint").onclick=()=>printGRVVoucher(rec.doc, thumbs, h.file_name);
        }catch(e){ list("Couldn't open that voucher: "+(e.message||e)); }
      });
      body.querySelectorAll("[data-share]").forEach(b=>b.onclick=async ()=>{
        try{ const h = hdr(b.dataset.share), rec = await grvGetRecord(h); const s = await grvShare(h, rec);
          list((rec.rebuilt? "The stored file was missing, so it was rebuilt from the receipt records. " : "")+dnShareMessage(s)); }
        catch(e){ list("Couldn't share: "+(e.message||e)); }
      });
      body.querySelectorAll("[data-reopen]").forEach(b=>b.onclick=async ()=>{
        const h = hdr(b.dataset.reopen);
        const stored = await dnfGet(h.dispatch_branch_id, h.dn_no);
        if(!stored || !stored.text) return list("The saved Delivery Note file is no longer on this device. Use Receive stock and choose the file again.");
        wrap.remove(); openReceiveFromText(stored.text);
      });
    }
    list();
  }
