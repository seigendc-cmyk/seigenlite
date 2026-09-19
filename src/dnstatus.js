  // ---------------- DN status and the Stock Movements view (Phase 4) ----------------
  // Pure — no DOM, no database. Input is a list of dn_events rows; output is one
  // row per Delivery Note, identified by (dispatching branch id, dn_no).
  //
  // Status:
  //   received   a 'received' event exists (a GRV was issued / imported)
  //   variance   a 'variance' event exists and no receipt has followed
  //   awaiting   dispatched more than `awaitingDays` days ago, no GRV, no variance
  //   dispatched everything else
  // "variance" is only ever known from an event that reached this device.
  // Phase 5 adds (highest first): conflict (a posted cancel AND a receipt), superseded / loss_closed / cancelled
  // (a 'cancel_posted' event), then received, variance, cancel_pending, awaiting, dispatched.
  // cancelPending is also kept as a flag, so a DN with a variance report and a pending cancel shows both.
  // Awaiting never applies to a DN that is cancelled or has a cancel pending.
  const DN_STATUS_LABEL = { dispatched:"Dispatched", received:"Received", variance:"Variance", awaiting:"Awaiting",
    cancel_pending:"Cancel pending", cancelled:"Cancelled", superseded:"Superseded", loss_closed:"Closed as loss", conflict:"Conflict" };
  const DN_CANCELLED_STATUSES = ["cancelled","superseded","loss_closed"];
  const DN_AWAITING_DEFAULT_DAYS = 7;

  function awaitingDaysFrom(raw){
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n>=1 && n<=365? n : DN_AWAITING_DEFAULT_DAYS;
  }
  function dnEventDetail(e){
    if(!e || !e.detail_json) return {};
    try{ const d = JSON.parse(e.detail_json); return d && typeof d==="object"? d : {}; }catch(_){ return {}; }
  }
  const dnMs = (iso)=>{ const t = Date.parse(iso); return Number.isNaN(t)? null : t; };

  // Status of one DN from what is known about it.
  //   info: { dispatchedTs, hasReceived, hasVariance, pending, posted:{kind} }
  function computeDnStatus(info, nowMs, awaitingDays){
    if(info.posted && info.hasReceived) return "conflict";
    if(info.posted) return info.posted.kind==="reissue"? "superseded" : info.posted.kind==="loss"? "loss_closed" : "cancelled";
    if(info.hasReceived) return "received";
    if(info.hasVariance) return "variance";
    if(info.pending && !info.aborted) return "cancel_pending";
    const t = info.dispatchedTs? dnMs(info.dispatchedTs) : null;
    if(t!==null && nowMs - t > awaitingDaysFrom(awaitingDays)*86400000) return "awaiting";
    return "dispatched";
  }

  // events -> rows, newest dispatch first.
  function buildMovements(events, nowMs, awaitingDays){
    const map = new Map();
    (events||[]).forEach(e=>{
      const key = e.dn_branch_id+"|"+e.dn_no;
      let r = map.get(key);
      if(!r){
        r = { key, dnBranchId:e.dn_branch_id, dnNo:e.dn_no, dnDisplay:formatDocNo("DN",e.dn_no), from:"", to:"",
              dispatchedTs:"", hasReceived:false, hasVariance:false, grvNo:null, receivedIso:"", varianceTs:"",
              varianceLines:0, varianceFlags:[], varianceNote:"", varianceBy:"", createdHint:"",
              pending:null, posted:null, aborted:false, receiverCancelled:false, replacedBy:null, replaces:null, cancelKind:"" };
        map.set(key, r);
      }
      if(e.dn_from_name && !r.from) r.from = e.dn_from_name;
      if(e.dn_to_name && !r.to) r.to = e.dn_to_name;
      const d = dnEventDetail(e);
      if(d.dn_created_iso && !r.createdHint) r.createdHint = d.dn_created_iso;
      if(e.event_type==="dispatched"){ r.dispatchedTs = e.event_ts; if(e.dn_from_name) r.from = e.dn_from_name; if(e.dn_to_name) r.to = e.dn_to_name; if(Number.isInteger(d.replaces)) r.replaces = d.replaces; }
      else if(e.event_type==="cancel_pending"){ r.pending = { kind:d.kind, caseNo:d.cancel_no, ts:e.event_ts }; if(Number.isInteger(d.replaced_by)) r.replacedBy = d.replaced_by; }
      else if(e.event_type==="cancel_posted"){ r.posted = { kind:d.kind, override:!!d.override, caseNo:d.case_no, ts:e.event_ts, via:d.via||"" }; r.cancelKind = d.kind; if(Number.isInteger(d.replaced_by)) r.replacedBy = d.replaced_by; }
      else if(e.event_type==="cancelled"){ r.receiverCancelled = true; }
      else if(e.event_type==="cancel_aborted"){ r.aborted = true; }                    // a GRV ended the cancel: the DN was received after all
      else if(e.event_type==="received"){ r.hasReceived = true; r.grvNo = e.grv_no; r.receivedIso = e.event_ts; }
      else if(e.event_type==="variance"){
        r.hasVariance = true;
        const t = dnMs(e.event_ts)||0, cur = r.varianceTs? (dnMs(r.varianceTs)||0) : -1;
        if(t>=cur){                                     // the latest report wins
          r.varianceTs = e.event_ts;
          r.varianceFlags = Array.isArray(d.flags)? d.flags : [];
          r.varianceLines = r.varianceFlags.length;
          r.varianceNote = String(d.note||"");
          r.varianceBy = String(d.reported_by||"");
        }
      }
    });
    const rows = [...map.values()];
    rows.forEach(r=>{
      if(!r.dispatchedTs && r.createdHint) r.dispatchedTs = r.createdHint;     // known only from the receiver's copy
      r.status = computeDnStatus(r, nowMs, awaitingDays);
      r.cancelPending = !!r.pending && !r.posted && !r.aborted;
      r.unconfirmed = !!(r.posted && r.posted.override && !r.receiverCancelled && r.posted.kind!=="aborted");
    });
    rows.sort((a,b)=> (dnMs(b.dispatchedTs)||0)-(dnMs(a.dispatchedTs)||0) || b.dnNo-a.dnNo);
    return rows;
  }

  // filter: { branch: name ("" = all; matches From or To), status: "" | dispatched | received | variance | awaiting | attention,
  //           fromMs, toMs (on the dispatched date; optional) }
  // "attention" = Awaiting + Variance.
  function filterMovements(rows, f){
    f = f||{};
    return rows.filter(r=>{
      if(f.branch){
        const b = String(f.branch).toLowerCase();
        if(String(r.from).toLowerCase()!==b && String(r.to).toLowerCase()!==b) return false;
      }
      if(f.status){
        if(f.status==="attention"){ if(!dnNeedsAttention(r)) return false; }
        else if(r.status!==f.status) return false;
      }
      const t = dnMs(r.dispatchedTs);
      if(f.fromMs!=null && t!==null && t<f.fromMs) return false;
      if(f.toMs!=null && t!==null && t>f.toMs) return false;
      return true;
    });
  }
  // Awaiting, variance, a pending cancel, a conflict, or a cancel posted without the receiver's confirmation.
  function dnNeedsAttention(r){
    return r.status==="awaiting" || r.status==="variance" || r.status==="cancel_pending" || r.status==="conflict" || !!r.cancelPending || !!r.unconfirmed;
  }
  // "superseded by DN0015", "replaces DN0012", "written off ..." for the chain column.
  function chainText(r){
    const parts = [];
    if(r.replacedBy && (r.status==="superseded" || r.cancelPending)) parts.push((r.status==="superseded"? "superseded by " : "to be replaced by ")+formatDocNo("DN",r.replacedBy));
    if(r.replaces) parts.push("replaces "+formatDocNo("DN",r.replaces));
    if(r.unconfirmed) parts.push("cancelled WITHOUT the receiver's confirmation");
    if(r.status==="conflict") parts.push("cancelled here but a receipt (GRV) exists: check stock");
    return parts.join("; ");
  }
  // Short text for the variance column: "2 lines: 7 short — <note>"
  function varianceText(r){
    if(!r.hasVariance) return "";
    const parts = [];
    if(r.varianceLines) parts.push(r.varianceLines+" line"+(r.varianceLines===1?"":"s")+" flagged: "+r.varianceFlags.map(f=>(f.code||f.name)+" DN "+f.dn+" / counted "+f.counted).join("; "));
    if(r.varianceNote) parts.push("Note: "+r.varianceNote);
    return parts.join(" — ") || "Variance reported";
  }
