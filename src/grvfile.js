  // ---------------- Goods Received Voucher file ----------------
  // "seigen-grv": what a receiving branch produces when it accepts a Delivery
  // Note as-is. Same style and checksum scheme as the DN file, but with no
  // thumbnails. Pure — no DOM, no database. It always equals the DN exactly:
  // the receiver never edits a quantity.
  const GRV_FORMAT = "seigen-grv";
  const GRV_FORMAT_VERSION = 1;
  // Multi-terminal Phase 2: the GRV's own till code, the DN's till code (so its
  // DN-T1-0012 number can be checked) and/or the receiving shop's internal ref.
  // Written ONLY when one of those is present; otherwise v1 byte for byte.
  const GRV_FORMAT_VERSION_TILL = 2;

  function canonicalGRV(d, withChecksum){
    const out = {
      format: d.format,
      format_version: d.format_version,
      grv_no: d.grv_no,
      grv_display: d.grv_display
    };
    if(d.till_code) out.till_code = d.till_code;                    // v2 only
    out.dn_no = d.dn_no;
    out.dn_display = d.dn_display;
    if(d.dn_till_code) out.dn_till_code = d.dn_till_code;           // v2 only
    out.from = { branch_id: d.from && d.from.branch_id, name: d.from && d.from.name };
    out.to = { branch_id: d.to && d.to.branch_id, name: d.to && d.to.name };
    out.received_iso = d.received_iso;
    if(d.internal_ref) out.internal_ref = d.internal_ref;           // v2 only
    out.items = (d.items||[]).map(it=>({ code:it.code, name:it.name, unit:it.unit, qty:it.qty }));
    out.totals = { lines: d.totals && d.totals.lines, units: d.totals && d.totals.units };
    if(withChecksum) out.checksum = d.checksum;
    return out;
  }
  async function grvChecksum(d, hashFn){
    return await (hashFn||sha256Hex)(JSON.stringify(canonicalGRV(d,false)));
  }
  // input: { grvNo, dnNo, fromBranchId, fromName, toBranchId, toName, receivedIso, tillCode?, dnTillCode?, internalRef?, items:[{code,name,unit?,qty}] }
  async function buildGRV(input, hashFn){
    const items = (input.items||[]).map(it=>({
      code: String(it.code==null?"":it.code).trim(),
      name: String(it.name==null?"":it.name).trim(),
      unit: String(it.unit||DN_DEFAULT_UNIT).trim()||DN_DEFAULT_UNIT,
      qty: it.qty
    }));
    const till = input.tillCode? String(input.tillCode) : "", dnTill = input.dnTillCode? String(input.dnTillCode) : "";
    const ref = cleanInternalRef(input.internalRef);
    const doc = {
      format: GRV_FORMAT, format_version: (till || dnTill || ref)? GRV_FORMAT_VERSION_TILL : GRV_FORMAT_VERSION,
      grv_no: input.grvNo,
      grv_display: Number.isInteger(input.grvNo) && input.grvNo>=0 ? docDisplay("GRV",input.grvNo,till) : "",
      dn_no: input.dnNo,
      dn_display: Number.isInteger(input.dnNo) && input.dnNo>=0 ? docDisplay("DN",input.dnNo,dnTill) : "",
      from: { branch_id: input.fromBranchId, name: input.fromName },
      to: { branch_id: input.toBranchId, name: input.toName },
      received_iso: input.receivedIso,
      items,
      totals: { lines: items.length, units: items.reduce((s,i)=>s+(Number.isInteger(i.qty)?i.qty:0),0) }
    };
    if(till) doc.till_code = till;
    if(dnTill) doc.dn_till_code = dnTill;
    if(ref) doc.internal_ref = ref;
    const errs = grvStructureErrors(doc);
    if(errs.length) throw new Error("Cannot build Goods Received Voucher: "+errs.join("; "));
    const out = canonicalGRV(doc,false);
    out.checksum = await grvChecksum(doc, hashFn);
    return out;
  }
  function serializeGRV(doc){ return JSON.stringify(canonicalGRV(doc,true)); }

  const GRV_TOP_KEYS = ["format","format_version","grv_no","grv_display","till_code","dn_no","dn_display","dn_till_code","from","to","received_iso","internal_ref","items","totals","checksum"];
  function grvStructureErrors(d){
    const e = [];
    if(!isObj(d)) return ["This is not a Goods Received Voucher file."];
    if(d.format!==GRV_FORMAT) return ["This is not a seiGEN Goods Received Voucher (wrong file type)."];
    if(!Number.isInteger(d.format_version) || d.format_version<1) return [damagedVersionMessage("Goods Received Voucher")];
    if(d.format_version!==GRV_FORMAT_VERSION && d.format_version!==GRV_FORMAT_VERSION_TILL)
      return [newerAppMessage("Goods Received Voucher", d.format_version, GRV_FORMAT_VERSION_TILL)];
    Object.keys(d).forEach(k=>{ if(!GRV_TOP_KEYS.includes(k)) e.push("Unexpected field \""+k+"\"."); });
    if(d.format_version===GRV_FORMAT_VERSION_TILL){
      e.push(...tillFieldErrors(d, "Goods Received Voucher"));
      if(d.dn_till_code!==undefined && (typeof d.dn_till_code!=="string" || !TILL_CODE_RE.test(d.dn_till_code))) e.push("The Delivery Note's till code on this voucher is invalid.");
      if(d.till_code===undefined && d.dn_till_code===undefined && d.internal_ref===undefined) e.push("This voucher says it has a till number or reference, but has none.");
    } else ["till_code","dn_till_code","internal_ref"].forEach(k=>{ if(d[k]!==undefined) e.push("Unexpected field \""+k+"\"."); });
    if(!Number.isInteger(d.grv_no) || d.grv_no<1) e.push("The GRV number is missing or invalid.");
    else if(d.grv_display!==docDisplay("GRV",d.grv_no,typeof d.till_code==="string"? d.till_code : "")) e.push("The GRV number does not match its display number.");
    if(!Number.isInteger(d.dn_no) || d.dn_no<1) e.push("The Delivery Note number is missing or invalid.");
    else if(d.dn_display!==docDisplay("DN",d.dn_no,typeof d.dn_till_code==="string"? d.dn_till_code : "")) e.push("The Delivery Note number does not match its display number.");
    if(!isObj(d.from) || !isNonEmptyStr(d.from.branch_id) || !isNonEmptyStr(d.from.name)) e.push("The dispatching branch (id and name) is missing.");
    if(!isObj(d.to) || !isNonEmptyStr(d.to.branch_id) || !isNonEmptyStr(d.to.name)) e.push("The receiving branch (id and name) is missing.");
    if(!isNonEmptyStr(d.received_iso) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/.test(d.received_iso)) e.push("The date and time received is missing or invalid.");
    if(!Array.isArray(d.items) || d.items.length===0) e.push("The voucher has no items.");
    else d.items.forEach((it,i)=>{
      const n = i+1;
      if(!isObj(it)){ e.push("Item "+n+" is not valid."); return; }
      if(typeof it.code!=="string") e.push("Item "+n+" has no code.");
      if(!isNonEmptyStr(it.name)) e.push("Item "+n+" has no name.");
      if(!isNonEmptyStr(it.unit)) e.push("Item "+n+" has no unit.");
      if(!Number.isInteger(it.qty) || it.qty<1 || it.qty>DN_MAX_QTY) e.push("Item "+n+" ("+(it.name||it.code||"?")+") has an invalid quantity.");
      Object.keys(it).forEach(k=>{ if(!["code","name","unit","qty"].includes(k)) e.push("Item "+n+" has an unexpected field \""+k+"\"."); });
    });
    if(!isObj(d.totals)) e.push("The totals are missing.");
    else if(Array.isArray(d.items)){
      const units = d.items.reduce((s,i)=>s+(isObj(i)&&Number.isInteger(i.qty)?i.qty:0),0);
      if(d.totals.lines!==d.items.length || d.totals.units!==units) e.push("The totals do not match the items listed.");
    }
    return e;
  }
  async function verifyGRVChecksum(d, hashFn){
    if(!isObj(d) || typeof d.checksum!=="string" || !/^[0-9a-f]{64}$/.test(d.checksum)) return false;
    return (await grvChecksum(d, hashFn)) === d.checksum;
  }
  async function validateGRV(d, hashFn){
    const errors = grvStructureErrors(d);
    if(errors.length===0){
      if(typeof d.checksum!=="string" || !/^[0-9a-f]{64}$/.test(d.checksum)) errors.push("The file has no valid checksum — it may be incomplete.");
      else if(!(await verifyGRVChecksum(d,hashFn))) errors.push("The file's checksum does not match — it was changed or damaged after it was created.");
    }
    return { ok: errors.length===0, errors };
  }
  async function parseGRV(text, hashFn){
    let d;
    try{ d = JSON.parse(String(text).replace(/^﻿/,"")); }
    catch(e){ return { ok:false, errors:["This file is not a readable Goods Received Voucher."], doc:null }; }
    const r = await validateGRV(d, hashFn);
    return { ok:r.ok, errors:r.errors, doc: r.ok? d : null };
  }
