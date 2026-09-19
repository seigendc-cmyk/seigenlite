  // ---------------- Cancel notice + confirmation files, and the cancel plan (Phase 5) ----------------
  // Pure: no DOM, no database. Two small checksummed JSON formats:
  //   seigen-dn-cancel       dispatcher -> receiver   "this DN is cancelled, do not receive it"
  //   seigen-dn-cancel-ack   receiver -> dispatcher   "confirmed: it was not received and now can't be"
  // (A DN with a "replaces" field, format_version 2 in dnfile.js, also acts as the notice.)
  // A checksum detects damage or editing; it is not a signature. The nonce ties a confirmation to
  // one cancel case on one dispatching device.
  const CANCEL_FORMAT = "seigen-dn-cancel";
  const ACK_FORMAT = "seigen-dn-cancel-ack";
  const CANCEL_FORMAT_VERSION = 1;
  const CANCEL_KINDS = ["cancel","reissue","loss"];
  const CANCEL_KIND_LABEL = { cancel:"Cancelled", reissue:"Cancelled and reissued", loss:"Closed as a loss" };
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/;
  const NONCE_RE = /^[A-Za-z0-9]{12,40}$/;

  function cxNo(n){ return formatDocNo("CXL", n); }

  // ---- notice ----
  function canonicalCancel(d, withChecksum){
    const out = {
      format: d.format, format_version: d.format_version,
      cancel_no: d.cancel_no, cancel_display: d.cancel_display, nonce: d.nonce, kind: d.kind,
      dn_no: d.dn_no, dn_display: d.dn_display,
      from: { branch_id: d.from && d.from.branch_id, name: d.from && d.from.name },
      to: { name: d.to && d.to.name },
      replaced_by: d.replaced_by===undefined? null : d.replaced_by,
      cancelled_iso: d.cancelled_iso,
      items: (d.items||[]).map(it=>({ code:it.code, name:it.name, unit:it.unit, qty:it.qty })),
      totals: { lines: d.totals && d.totals.lines, units: d.totals && d.totals.units }
    };
    if(withChecksum) out.checksum = d.checksum;
    return out;
  }
  const CANCEL_TOP_KEYS = ["format","format_version","cancel_no","cancel_display","nonce","kind","dn_no","dn_display","from","to","replaced_by","cancelled_iso","items","totals","checksum"];
  function cancelStructureErrors(d){
    const e = [];
    if(!isObj(d)) return ["This is not a cancellation file."];
    if(d.format!==CANCEL_FORMAT) return ["This is not a seiGEN cancellation notice (wrong file type)."];
    if(d.format_version!==CANCEL_FORMAT_VERSION) return [newerAppMessage("cancellation notice", d.format_version, CANCEL_FORMAT_VERSION)];
    Object.keys(d).forEach(k=>{ if(!CANCEL_TOP_KEYS.includes(k)) e.push("Unexpected field \""+k+"\"."); });
    if(!Number.isInteger(d.cancel_no) || d.cancel_no<1) e.push("The cancellation number is missing or invalid.");
    else if(d.cancel_display!==cxNo(d.cancel_no)) e.push("The cancellation number does not match its display number.");
    if(typeof d.nonce!=="string" || !NONCE_RE.test(d.nonce)) e.push("The cancellation code is missing or invalid.");
    if(!CANCEL_KINDS.includes(d.kind)) e.push("The kind of cancellation is missing or invalid.");
    if(!Number.isInteger(d.dn_no) || d.dn_no<1) e.push("The Delivery Note number is missing or invalid.");
    else if(d.dn_display!==formatDocNo("DN",d.dn_no)) e.push("The Delivery Note number does not match its display number.");
    if(!isObj(d.from) || !isNonEmptyStr(d.from.branch_id) || !isNonEmptyStr(d.from.name)) e.push("The dispatching branch (id and name) is missing.");
    if(!isObj(d.to) || !isNonEmptyStr(d.to.name)) e.push("The receiving branch is missing.");
    if(d.replaced_by!==null && !(Number.isInteger(d.replaced_by) && d.replaced_by>d.dn_no)) e.push("The replacement Delivery Note number is invalid.");
    else if((d.kind==="reissue") !== (d.replaced_by!==null)) e.push("The replacement Delivery Note does not match the kind of cancellation.");
    if(!isNonEmptyStr(d.cancelled_iso) || !ISO_RE.test(d.cancelled_iso)) e.push("The cancellation date and time is missing or invalid.");
    if(!Array.isArray(d.items) || d.items.length===0) e.push("The cancellation lists no items.");
    else d.items.forEach((it,i)=>{
      const n = i+1;
      if(!isObj(it)){ e.push("Item "+n+" is not valid."); return; }
      if(typeof it.code!=="string") e.push("Item "+n+" has no code.");
      if(!isNonEmptyStr(it.name)) e.push("Item "+n+" has no name.");
      if(!isNonEmptyStr(it.unit)) e.push("Item "+n+" has no unit.");
      if(!Number.isInteger(it.qty) || it.qty<1 || it.qty>DN_MAX_QTY) e.push("Item "+n+" has an invalid quantity.");
      Object.keys(it).forEach(k=>{ if(!["code","name","unit","qty"].includes(k)) e.push("Item "+n+" has an unexpected field \""+k+"\"."); });
    });
    if(!isObj(d.totals)) e.push("The totals are missing.");
    else if(Array.isArray(d.items)){
      const units = d.items.reduce((s,i)=>s+(isObj(i)&&Number.isInteger(i.qty)?i.qty:0),0);
      if(d.totals.lines!==d.items.length || d.totals.units!==units) e.push("The totals do not match the items listed.");
    }
    return e;
  }
  // input: { cancelNo, nonce, kind, dnNo, fromBranchId, fromName, toName, replacedBy?, cancelledIso, items:[{code,name,unit?,qty}] }
  async function buildCancel(input, hashFn){
    const items = (input.items||[]).map(it=>({ code:String(it.code==null?"":it.code).trim(), name:String(it.name==null?"":it.name).trim(),
      unit:String(it.unit||DN_DEFAULT_UNIT).trim()||DN_DEFAULT_UNIT, qty:it.qty }));
    const doc = {
      format:CANCEL_FORMAT, format_version:CANCEL_FORMAT_VERSION,
      cancel_no:input.cancelNo, cancel_display:Number.isInteger(input.cancelNo)&&input.cancelNo>=0? cxNo(input.cancelNo) : "",
      nonce:input.nonce, kind:input.kind, dn_no:input.dnNo,
      dn_display:Number.isInteger(input.dnNo)&&input.dnNo>=0? formatDocNo("DN",input.dnNo) : "",
      from:{ branch_id:input.fromBranchId, name:input.fromName }, to:{ name:input.toName },
      replaced_by:input.replacedBy==null? null : input.replacedBy, cancelled_iso:input.cancelledIso, items,
      totals:{ lines:items.length, units:items.reduce((s,i)=>s+(Number.isInteger(i.qty)?i.qty:0),0) }
    };
    const errs = cancelStructureErrors(doc);
    if(errs.length) throw new Error("Cannot build cancellation notice: "+errs.join("; "));
    const out = canonicalCancel(doc,false);
    out.checksum = await (hashFn||sha256Hex)(JSON.stringify(out));
    return out;
  }
  const serializeCancel = (doc)=>JSON.stringify(canonicalCancel(doc,true));
  async function parseCancel(text, hashFn){
    let d;
    try{ d = JSON.parse(String(text).replace(/^﻿/,"")); }
    catch(e){ return { ok:false, errors:["This file is not a readable cancellation notice."], doc:null }; }
    const errors = cancelStructureErrors(d);
    if(!errors.length){
      if(typeof d.checksum!=="string" || !/^[0-9a-f]{64}$/.test(d.checksum)) errors.push("The file has no valid checksum. It may be incomplete.");
      else if((await (hashFn||sha256Hex)(JSON.stringify(canonicalCancel(d,false))))!==d.checksum) errors.push("The file's checksum does not match. It was changed or damaged after it was created.");
    }
    return { ok:!errors.length, errors, doc:errors.length? null : d };
  }

  // ---- confirmation ----
  function canonicalAck(d, withChecksum){
    const out = {
      format:d.format, format_version:d.format_version,
      cancel_no:d.cancel_no, cancel_display:d.cancel_display, nonce:d.nonce,
      dn_no:d.dn_no, dn_display:d.dn_display,
      from:{ branch_id:d.from && d.from.branch_id, name:d.from && d.from.name },
      to:{ branch_id:d.to && d.to.branch_id, name:d.to && d.to.name },
      variance_seen:d.variance_seen, confirmed_iso:d.confirmed_iso
    };
    if(withChecksum) out.checksum = d.checksum;
    return out;
  }
  const ACK_TOP_KEYS = ["format","format_version","cancel_no","cancel_display","nonce","dn_no","dn_display","from","to","variance_seen","confirmed_iso","checksum"];
  function ackStructureErrors(d){
    const e = [];
    if(!isObj(d)) return ["This is not a cancellation confirmation."];
    if(d.format!==ACK_FORMAT) return ["This is not a seiGEN cancellation confirmation (wrong file type)."];
    if(d.format_version!==CANCEL_FORMAT_VERSION) return [newerAppMessage("cancellation confirmation", d.format_version, CANCEL_FORMAT_VERSION)];
    Object.keys(d).forEach(k=>{ if(!ACK_TOP_KEYS.includes(k)) e.push("Unexpected field \""+k+"\"."); });
    if(!Number.isInteger(d.cancel_no) || d.cancel_no<1) e.push("The cancellation number is missing or invalid.");
    else if(d.cancel_display!==cxNo(d.cancel_no)) e.push("The cancellation number does not match its display number.");
    if(typeof d.nonce!=="string" || !NONCE_RE.test(d.nonce)) e.push("The cancellation code is missing or invalid.");
    if(!Number.isInteger(d.dn_no) || d.dn_no<1) e.push("The Delivery Note number is missing or invalid.");
    else if(d.dn_display!==formatDocNo("DN",d.dn_no)) e.push("The Delivery Note number does not match its display number.");
    if(!isObj(d.from) || !isNonEmptyStr(d.from.branch_id) || !isNonEmptyStr(d.from.name)) e.push("The dispatching branch (id and name) is missing.");
    if(!isObj(d.to) || !isNonEmptyStr(d.to.branch_id) || !isNonEmptyStr(d.to.name)) e.push("The receiving branch (id and name) is missing.");
    if(typeof d.variance_seen!=="boolean") e.push("The confirmation is incomplete.");
    if(!isNonEmptyStr(d.confirmed_iso) || !ISO_RE.test(d.confirmed_iso)) e.push("The confirmation date and time is missing or invalid.");
    return e;
  }
  // input: { cancelNo, nonce, dnNo, fromBranchId, fromName, toBranchId, toName, varianceSeen, confirmedIso }
  async function buildAck(input, hashFn){
    const doc = {
      format:ACK_FORMAT, format_version:CANCEL_FORMAT_VERSION,
      cancel_no:input.cancelNo, cancel_display:Number.isInteger(input.cancelNo)&&input.cancelNo>=0? cxNo(input.cancelNo) : "", nonce:input.nonce,
      dn_no:input.dnNo, dn_display:Number.isInteger(input.dnNo)&&input.dnNo>=0? formatDocNo("DN",input.dnNo) : "",
      from:{ branch_id:input.fromBranchId, name:input.fromName }, to:{ branch_id:input.toBranchId, name:input.toName },
      variance_seen:!!input.varianceSeen, confirmed_iso:input.confirmedIso
    };
    const errs = ackStructureErrors(doc);
    if(errs.length) throw new Error("Cannot build cancellation confirmation: "+errs.join("; "));
    const out = canonicalAck(doc,false);
    out.checksum = await (hashFn||sha256Hex)(JSON.stringify(out));
    return out;
  }
  const serializeAck = (doc)=>JSON.stringify(canonicalAck(doc,true));
  async function parseAck(text, hashFn){
    let d;
    try{ d = JSON.parse(String(text).replace(/^﻿/,"")); }
    catch(e){ return { ok:false, errors:["This file is not a readable cancellation confirmation."], doc:null }; }
    const errors = ackStructureErrors(d);
    if(!errors.length){
      if(typeof d.checksum!=="string" || !/^[0-9a-f]{64}$/.test(d.checksum)) errors.push("The file has no valid checksum. It may be incomplete.");
      else if((await (hashFn||sha256Hex)(JSON.stringify(canonicalAck(d,false))))!==d.checksum) errors.push("The file's checksum does not match. It was changed or damaged after it was created.");
    }
    return { ok:!errors.length, errors, doc:errors.length? null : d };
  }

  // ---- importer checks ----
  const cxDate = (iso)=> (typeof isoDateText==="function" && isoDateText(iso)) || String(iso||"").slice(0,10);

  // Receiver, on a cancellation notice. ctx: { ownBranchId, ownBranchName, lookup(fromBranchId, dnNo) -> dispatch_docs 'in' row | null }
  // -> { ok:false, stage, message, doc?, record? } | { ok:true, doc, record, already }
  async function checkIncomingCancel(text, ctx, hashFn){
    const p = await parseCancel(text, hashFn);
    if(!p.ok) return { ok:false, stage:"file", message:p.errors[0], errors:p.errors };
    const doc = p.doc;
    if(doc.from.branch_id===ctx.ownBranchId)
      return { ok:false, stage:"own", message:"This cancellation is for "+doc.dn_display+", which this branch dispatched. It can only be confirmed at "+doc.to.name+".", doc };
    if(!sameBranchName(doc.to.name, ctx.ownBranchName))
      return { ok:false, stage:"destination", message:"This cancellation is for \""+doc.to.name+"\", but this branch is \""+ctx.ownBranchName+"\". Nothing was changed.", doc };
    const rec = ctx.lookup(doc.from.branch_id, doc.dn_no) || null;
    if(rec && rec.status==="received")
      return { ok:false, stage:"received", message:doc.dn_display+" was already received here as "+formatDocNo("GRV",rec.grv_no)+", so it can't be cancelled. Send that voucher to "+doc.from.name+".", doc, record:rec };
    if(rec && rec.status==="cancelled") return { ok:true, doc, record:rec, already:true };
    return { ok:true, doc, record:rec, already:false };
  }

  // Dispatcher, on a confirmation. ctx: { ownBranchId, header(dnNo) -> 'out' row | null, caseByNo(caseNo) -> dn_cases row | null }
  async function checkIncomingAck(text, ctx, hashFn){
    const p = await parseAck(text, hashFn);
    if(!p.ok) return { ok:false, stage:"file", message:p.errors[0], errors:p.errors };
    const doc = p.doc;
    if(doc.from.branch_id!==ctx.ownBranchId)
      return { ok:false, stage:"branch", message:"This confirmation is for "+doc.dn_display+" dispatched by \""+doc.from.name+"\", not by this branch. Nothing was changed.", doc };
    const h = ctx.header(doc.dn_no);
    if(!h) return { ok:false, stage:"unknown", message:doc.dn_display+" was not dispatched from this device, so this confirmation can't be matched. Nothing was changed.", doc };
    const c = ctx.caseByNo(doc.cancel_no);
    if(!c || c.dn_no!==doc.dn_no || c.nonce!==doc.nonce)
      return { ok:false, stage:"nomatch", message:"This confirmation doesn't match any cancellation started on this device. Nothing was changed.", doc, header:h };
    if(c.state==="posted" && !(c.override && !c.acked_ts))
      return { ok:false, stage:"duplicate", message:"Already confirmed on "+cxDate(c.acked_ts||c.posted_ts)+". Nothing was changed.", doc, header:h, case:c };
    if(c.state==="aborted")
      return { ok:false, stage:"aborted", message:"This cancellation was ended because "+doc.dn_display+" had been received. Nothing was changed.", doc, header:h, case:c };
    if(h.status==="received" && c.state!=="posted")
      return { ok:false, stage:"received", message:doc.dn_display+" is recorded here as received ("+formatDocNo("GRV",h.grv_no)+"), but the receiver says it was not. Nothing was changed. Check with "+doc.to.name+".", doc, header:h, case:c };
    if(!sameBranchName(doc.to.name, h.receive_branch_name))
      return { ok:false, stage:"receiver", message:"This confirmation is from \""+doc.to.name+"\", but "+doc.dn_display+" was sent to \""+h.receive_branch_name+"\". Nothing was changed.", doc, header:h, case:c };
    return { ok:true, doc, header:h, case:c };
  }

  // ---- the cancel plan ----
  // kind: cancel | reissue | loss. lines: [{code,name,qty}] as dispatched. plan: [{ nw, writeoff, reason }] (same order; strings ok).
  // Rules: cancel returns everything; loss writes everything off; reissue keeps 0..original, and the
  // rest of each line is either returned to stock or written off with a loss reason.
  // -> { ok, error, lines:[{code,name,orig,nw,writeoff,reason,returned}] }
  const WRITEOFF_REASONS_PLAN = ["Lost in transit","Damaged","Other"];
  function normalizeCancelPlan(kind, lines, plan, note){
    const fail = (error)=>({ ok:false, error, lines:[] });
    if(!CANCEL_KINDS.includes(kind)) return fail("Choose what to do with this Delivery Note.");
    if(!String(note==null?"":note).trim()) return fail("Write a note saying why.");
    const whole = (v)=>{ const s = String(v==null?"":v).trim(); return /^\d+$/.test(s)? Number(s) : null; };
    const out = [];
    for(let i=0;i<lines.length;i++){
      const l = lines[i], p = (plan&&plan[i])||{}, orig = l.qty, label = (l.code? l.code+" " : "")+l.name;
      let nw = 0, w = 0, reason = "";
      if(kind==="cancel"){ nw = 0; w = 0; }
      else if(kind==="loss"){ nw = 0; w = orig; reason = String(p.reason||""); }
      else {
        nw = whole(p.nw===undefined? orig : p.nw); w = whole(p.writeoff===undefined? 0 : p.writeoff); reason = String(p.reason||"");
        if(nw===null || nw>orig) return fail(label+": the new quantity must be a whole number from 0 to "+orig+".");
        if(w===null || w>orig-nw) return fail(label+": the written-off quantity must be a whole number from 0 to "+(orig-nw)+".");
      }
      if(w>0 && !WRITEOFF_REASONS_PLAN.includes(reason)) return fail(label+": choose a reason for the write-off (Lost in transit, Damaged or Other).");
      out.push({ code:l.code, name:l.name, orig, nw, writeoff:w, reason:w>0? reason : "", returned:orig-nw-w });
    }
    if(kind==="reissue" && !out.some(l=>l.nw>0)) return fail("A reissue needs at least one line to send. To stop the whole Delivery Note use Cancel or Close as loss.");
    return { ok:true, error:"", lines:out };
  }
  // Plain-language summary of what confirming will post.
  function cancelPlanSummary(kind, planLines, dnDisplay){
    const restore = planLines.reduce((s,l)=>s+l.orig,0), send = planLines.reduce((s,l)=>s+l.nw,0), wo = planLines.reduce((s,l)=>s+l.writeoff,0), back = planLines.reduce((s,l)=>s+l.returned,0);
    return { restore, send, writeoff:wo, returned:back, net:back,
      text: dnDisplay+": "+restore+" unit"+(restore===1?"":"s")+" restored to stock"+(send? ", "+send+" sent again on the replacement" : "")+(wo? ", "+wo+" written off" : "")+"; net back in stock: "+back+"." };
  }
  // A random code for a cancel case (letters and digits).
  function newCancelNonce(){
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let s = "";
    for(let i=0;i<16;i++) s += chars[Math.floor(Math.random()*chars.length)];
    return s;
  }
