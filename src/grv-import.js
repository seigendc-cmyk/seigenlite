  // ---------------- Import GRV (dispatcher side, Phase 4) ----------------
  // The receiver sends its Goods Received Voucher back. Importing it marks the DN
  // 'received'. Stock is NEVER touched here: it was deducted at dispatch and the
  // receiver added it on Accept. Nothing is written unless every check passes.

  // ---- pure part ----
  const grvLineKey = (l)=> (String(l.code==null?"":l.code).trim().toLowerCase() || "name:"+String(l.name==null?"":l.name).trim().toLowerCase());
  function grvLineText(l){ return (l.code? l.code+" " : "")+l.name+" × "+l.qty; }
  // dnLines: [{code,name,qty}] (what this branch dispatched)  grvLines: [{code,name,qty}]
  // Equal means the same set of (code, qty) pairs — order does not matter.
  // Lines with no code are matched on their name.
  function compareGrvLines(dnLines, grvLines){
    const norm = (ls)=> ls.map(l=>grvLineKey(l)+"|"+l.qty).sort();
    const a = norm(dnLines), b = norm(grvLines);
    if(a.length===b.length && a.every((x,i)=>x===b[i])) return { same:true };
    return { same:false, dn:dnLines.map(grvLineText), grv:grvLines.map(grvLineText) };
  }
  // ctx: { ownBranchId, lookup(dnNo) -> dispatch_docs 'out' row | null, storedLines(header) -> [{code,name,qty}] }
  // -> { ok:false, stage, message, ... } | { ok:true, doc, header, lines }
  async function checkIncomingGRV(text, ctx, hashFn){
    // 1. parse, validate, checksum
    const p = await parseGRV(text, hashFn);
    if(!p.ok) return { ok:false, stage:"file", message:p.errors[0], errors:p.errors };
    const doc = p.doc;
    // 2. the DN must have been dispatched by this branch
    if(doc.from.branch_id!==ctx.ownBranchId)
      return { ok:false, stage:"branch", message:"This Goods Received Voucher is for "+doc.dn_display+" dispatched by \""+doc.from.name+"\", not by this branch. Nothing was changed.", doc };
    // 3. and must exist here as an outgoing DN
    const h = ctx.lookup(doc.dn_no);
    if(!h) return { ok:false, stage:"unknown", message:doc.dn_display+" was not dispatched from this device, so this voucher can't be matched. Nothing was changed.", doc };
    // 4. only once
    if(h.status==="received")
      return { ok:false, stage:"duplicate", message:"Already confirmed on "+(isoDateText(h.received_iso)||String(h.received_ts||"").slice(0,10))+" as "+formatDocNo("GRV",h.grv_no)+".", doc, header:h };
    // 4b. a DN cancelled here can't be received: record that the two facts disagree (the screen does), change no stock
    if(["cancelled","superseded","loss_closed"].includes(h.status))
      return { ok:false, stage:"conflict", message:doc.dn_display+" was "+({ cancelled:"cancelled", superseded:"cancelled and reissued", loss_closed:"closed as a loss" }[h.status])+" on this device, but this voucher ("+doc.grv_display+") says "+doc.to.name
        +" received it. Both facts are now recorded and "+doc.dn_display+" shows as Conflict. No stock was changed. Management must check the stock.", doc, header:h };
    // 5. the lines must equal what was dispatched
    const stored = ctx.storedLines(h);
    const cmp = compareGrvLines(stored, doc.items);
    if(!cmp.same)
      return { ok:false, stage:"lines", message:"The lines on this voucher are not the same as the lines dispatched on "+doc.dn_display+". Nothing was changed.", dn:cmp.dn, grv:cmp.grv, doc, header:h };
    return { ok:true, doc, header:h };
  }

  // ---- database side ----
  function grvImportContext(){
    return { ownBranchId:getBranchId(),
      lookup:(dnNo)=>one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[getBranchId(),dnNo]),
      storedLines:(h)=>dnStoredLines(h).map(l=>({ code:l.sku||"", name:l.product_name, qty:l.qty })) };
  }
  async function grvImportCheckBytes(bytes){
    const text = decodeBytesUtf8(bytes);
    return { res: await checkIncomingGRV(text, grvImportContext()), text };
  }
  // Synchronous and all-or-nothing; the caller awaits persist() afterwards.
  // Writes the header and the event ONLY: no product, stock or counter is touched.
  function commitGrvImport(doc, now){
    db.run("BEGIN");
    try{
      const h = one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[getBranchId(),doc.dn_no]);
      if(!h) throw new Error(doc.dn_display+" was not dispatched from this device.");
      if(h.status==="received") throw new Error("Already confirmed as "+formatDocNo("GRV",h.grv_no)+".");
      const ts = now.toISOString();
      let aborted = null, posted = null;
      // A cancel still waiting on this DN ends here: the receiver had accepted it, so nothing is restored.
      const pc = pendingCaseFor(doc.dn_no);
      if(pc){
        run("UPDATE dn_cases SET state='aborted', posted_ts=?, posted_via='grv' WHERE id=?",[ts,pc.id]);
        recordDnEvent({ dnBranchId:getBranchId(), dnNo:doc.dn_no, type:"cancel_aborted", actorBranchId:getBranchId(), actorName:currentBranch(), fromName:h.dispatch_branch_name, toName:h.receive_branch_name, ts:localIso(now),
          detail:{ case_no:pc.case_no, reason:"received as "+doc.grv_display } });
        if(pc.kind==="reissue" && pc.replaced_by){          // the replacement was never valid: nothing was posted for it
          run("UPDATE dispatch_docs SET status='cancelled', cancel_kind='aborted', cancelled_ts=? WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[ts,getBranchId(),pc.replaced_by]);
          recordDnEvent({ dnBranchId:getBranchId(), dnNo:pc.replaced_by, type:"cancel_posted", actorBranchId:getBranchId(), actorName:currentBranch(), fromName:h.dispatch_branch_name, toName:h.receive_branch_name, ts:localIso(now),
            detail:{ kind:"aborted", replaced_by:null, override:false, case_no:pc.case_no, via:"grv-of-original" } });
        }
        aborted = { caseNo:pc.case_no, replacement:pc.replaced_by||null };
      }
      // A voucher for a REPLACEMENT DN also proves the DN it replaced can no longer be received: post that cancel now.
      if(h.replaces_dn_no && h.stock_posted===0){
        const oc = caseByReplacement(h.dn_no);
        if(oc && oc.state==="pending"){
          postCaseSync(oc, { override:false, via:"grv-of-replacement", now });
          run("UPDATE dn_cases SET acked_ts=? WHERE id=?",[ts,oc.id]);
          recordDnEvent({ dnBranchId:getBranchId(), dnNo:oc.dn_no, type:"cancelled", actorBranchId:doc.to.branch_id, actorName:doc.to.name, fromName:h.dispatch_branch_name, toName:h.receive_branch_name,
            ts:doc.received_iso, detail:{ cancel_no:oc.case_no, via:"grv-of-replacement" } });
          posted = { dnNo:oc.dn_no, caseNo:oc.case_no };
        }
      }
      run("UPDATE dispatch_docs SET status='received', grv_no=?, received_ts=?, received_iso=?, received_by=? WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",
        [doc.grv_no, ts, doc.received_iso, String(sessionUser||""), getBranchId(), doc.dn_no]);
      recordDnEvent({ dnBranchId:getBranchId(), dnNo:doc.dn_no, type:"received", actorBranchId:doc.to.branch_id, actorName:doc.to.name,
        fromName:h.dispatch_branch_name, toName:h.receive_branch_name, ts:doc.received_iso, grvNo:doc.grv_no,
        detail:{ dn_created_iso:h.created_iso, imported_at:ts, imported_by:String(sessionUser||"") } });
      logAudit("Import GRV","",doc.grv_display+" confirms "+doc.dn_display+" received by "+doc.to.name);
      db.run("COMMIT");
      return { header:one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[getBranchId(),doc.dn_no]), aborted, posted };
    }catch(e){
      try{ db.run("ROLLBACK"); }catch(_){}
      throw e;
    }
  }
  // A voucher for a DN this device cancelled: record the disagreement as a fact (no stock, no header change).
  // The DN then derives as 'conflict' (a posted cancel AND a receipt).
  function commitConflictGrv(doc, now){
    db.run("BEGIN");
    try{
      const h = one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[getBranchId(),doc.dn_no]);
      if(!h) throw new Error(doc.dn_display+" was not dispatched from this device.");
      recordDnEvent({ dnBranchId:getBranchId(), dnNo:doc.dn_no, type:"received", actorBranchId:doc.to.branch_id, actorName:doc.to.name,
        fromName:h.dispatch_branch_name, toName:h.receive_branch_name, ts:doc.received_iso, grvNo:doc.grv_no,
        detail:{ dn_created_iso:h.created_iso, imported_at:now.toISOString(), imported_by:String(sessionUser||""), conflict:true } });
      logAudit("GRV conflict","",doc.grv_display+" says "+doc.dn_display+" was received, but it is "+h.status+" here. Stock NOT changed.");
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
  }

  // ---- screen ----
  function openGrvImportWithFile(file){ openGrvImportScreen(file); }
  function openGrvImportScreen(file, onDone){
    const wrap = openModal("Import GRV", `
      <p class="muted" style="margin-top:0">Choose the Goods Received Voucher file the receiving branch sent back. Any file name works.</p>
      <input type="file" id="giFile">`);
    const body = wrap.querySelector(".modal-body");
    wrap.querySelector("#giFile").onchange=(e)=>{ const f = e.target.files[0]; e.target.value=""; if(f) handle(f); };
    if(file) handle(file);
    function close(){ wrap.remove(); if(onDone) onDone(); else render(); }
    function blocked(res){
      const both = res.stage==="lines"? `
        <div class="card" style="padding:8px;margin:8px 0"><b>Dispatched on ${escapeHtml(res.doc.dn_display)}</b>${res.dn.map(t=>`<div class="pmeta">${escapeHtml(t)}</div>`).join("")}</div>
        <div class="card" style="padding:8px;margin:8px 0"><b>On the voucher ${escapeHtml(res.doc.grv_display)}</b>${res.grv.map(t=>`<div class="pmeta">${escapeHtml(t)}</div>`).join("")}</div>` : "";
      body.innerHTML = `<p style="margin:0 0 6px"><b>${escapeHtml(res.message)}</b></p>${both}<button class="btn btn-outline" id="giClose">Close</button>`;
      body.querySelector("#giClose").onclick=close;
    }
    // A cancellation confirmation from a receiver: post the cancel (restore, replacement, write-offs) in one transaction.
    async function handleAck(bytes){
      let out;
      try{ out = await ackCheckBytes(bytes); }catch(e){ return blocked({ stage:"file", message:"Could not read that file as a cancellation confirmation." }); }
      if(!out.res.ok) return blocked(out.res);
      const ack = out.res.doc;
      let r;
      try{ r = commitAckImport(ack, new Date()); }
      catch(e){ return blocked({ stage:"commit", message:"Nothing was changed. "+(e.message||String(e)) }); }
      try{ await persist(); }catch(e){}
      const c = r.case, kindText = c? CANCEL_KIND_LABEL[c.kind] : "Cancelled";
      body.innerHTML = `<div class="box" style="text-align:center;margin-bottom:10px"><p style="font-size:16px;font-weight:700;margin:0 0 4px">${escapeHtml(ack.dn_display)}: ${escapeHtml(kindText.toLowerCase())}</p>
        <p class="muted" style="margin:0">${r.upgraded? escapeHtml(ack.to.name+" has now confirmed the cancellation you posted earlier without confirmation. Nothing else changed.") : escapeHtml("Confirmed by "+ack.to.name+". Your stock was restored"+(c && c.kind==="reissue"? ", the replacement "+formatDocNo("DN",c.replaced_by)+" was posted" : "")+(c && c.kind==="loss"? " and the loss was written off" : "")+".")}</p></div>
        <button class="btn btn-primary" id="giDone">Done</button>`;
      body.querySelector("#giDone").onclick=close;
    }
    async function handle(f){
      body.innerHTML = `<div class="box" style="text-align:center"><p style="margin:0">Reading…</p></div>`;
      let bytes;
      try{ bytes = await readFileBytes(f); }catch(e){ return blocked({ stage:"file", message:"Could not read that file." }); }
      const fmt = sniffJsonFormat(bytes);
      if(fmt===ACK_FORMAT) return handleAck(bytes);
      if(fmt===CANCEL_FORMAT) return blocked({ stage:"file", message:"This is a cancellation notice for the receiving branch. It goes through Products, then Receive stock, on the branch it was sent to." });
      let out;
      try{ out = await grvImportCheckBytes(bytes); }catch(e){ return blocked({ stage:"file", message:"Could not read that file as a Goods Received Voucher." }); }
      if(!out.res.ok && out.res.stage==="conflict"){
        try{ commitConflictGrv(out.res.doc, new Date()); await persist(); }catch(e){ return blocked({ stage:"commit", message:"Nothing was changed. "+(e.message||String(e)) }); }
        try{ await dnfPut(getBranchId(), "GRV:"+out.res.doc.dn_no, { text:out.text, file_name:f.name||"", saved_ts:new Date().toISOString() }); }catch(e){}
        return blocked(out.res);
      }
      if(!out.res.ok) return blocked(out.res);
      const doc = out.res.doc;
      let cr;
      try{ cr = commitGrvImport(doc, new Date()); }
      catch(e){ return blocked({ stage:"commit", message:"Nothing was changed. "+(e.message||String(e)) }); }
      try{ await persist(); }catch(e){}
      try{ await dnfPut(getBranchId(), "GRV:"+doc.dn_no, { text:out.text, file_name:f.name||"", saved_ts:new Date().toISOString() }); }catch(e){}
      body.innerHTML = `<div class="box" style="text-align:center;margin-bottom:10px"><p style="font-size:16px;font-weight:700;margin:0 0 4px">${escapeHtml(doc.dn_display)} confirmed</p>
        <p class="muted" style="margin:0">Received by ${escapeHtml(doc.to.name)} on ${escapeHtml(isoDateText(doc.received_iso))} as ${escapeHtml(doc.grv_display)}. ${cr && cr.posted? "This also confirms the cancellation of "+escapeHtml(formatDocNo("DN",cr.posted.dnNo))+": your stock was restored and this replacement was posted." : "Your stock was not changed."}</p>
        ${cr && cr.aborted? `<p style="margin:8px 0 0;color:#b54708">The cancellation in progress on this Delivery Note was ended, because the goods were received. Nothing was restored${cr.aborted.replacement? " and the replacement "+escapeHtml(formatDocNo("DN",cr.aborted.replacement))+" is void" : ""}.</p>` : ""}</div>
        <button class="btn btn-primary" id="giDone">Done</button>`;
      body.querySelector("#giDone").onclick=close;
    }
  }
