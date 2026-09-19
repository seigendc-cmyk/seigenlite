  // ---------------- Goods Received Voucher file ----------------
  // "seigen-grv": what a receiving branch produces when it accepts a Delivery
  // Note as-is. Same style and checksum scheme as the DN file, but with no
  // thumbnails. Pure — no DOM, no database. It always equals the DN exactly:
  // the receiver never edits a quantity.
  const GRV_FORMAT = "seigen-grv";
  const GRV_FORMAT_VERSION = 1;

  function canonicalGRV(d, withChecksum){
    const out = {
      format: d.format,
      format_version: d.format_version,
      grv_no: d.grv_no,
      grv_display: d.grv_display,
      dn_no: d.dn_no,
      dn_display: d.dn_display,
      from: { branch_id: d.from && d.from.branch_id, name: d.from && d.from.name },
      to: { branch_id: d.to && d.to.branch_id, name: d.to && d.to.name },
      received_iso: d.received_iso,
      items: (d.items||[]).map(it=>({ code:it.code, name:it.name, unit:it.unit, qty:it.qty })),
      totals: { lines: d.totals && d.totals.lines, units: d.totals && d.totals.units }
    };
    if(withChecksum) out.checksum = d.checksum;
    return out;
  }
  async function grvChecksum(d, hashFn){
    return await (hashFn||sha256Hex)(JSON.stringify(canonicalGRV(d,false)));
  }
  // input: { grvNo, dnNo, fromBranchId, fromName, toBranchId, toName, receivedIso, items:[{code,name,unit?,qty}] }
  async function buildGRV(input, hashFn){
    const items = (input.items||[]).map(it=>({
      code: String(it.code==null?"":it.code).trim(),
      name: String(it.name==null?"":it.name).trim(),
      unit: String(it.unit||DN_DEFAULT_UNIT).trim()||DN_DEFAULT_UNIT,
      qty: it.qty
    }));
    const doc = {
      format: GRV_FORMAT, format_version: GRV_FORMAT_VERSION,
      grv_no: input.grvNo,
      grv_display: Number.isInteger(input.grvNo) && input.grvNo>=0 ? formatDocNo("GRV",input.grvNo) : "",
      dn_no: input.dnNo,
      dn_display: Number.isInteger(input.dnNo) && input.dnNo>=0 ? formatDocNo("DN",input.dnNo) : "",
      from: { branch_id: input.fromBranchId, name: input.fromName },
      to: { branch_id: input.toBranchId, name: input.toName },
      received_iso: input.receivedIso,
      items,
      totals: { lines: items.length, units: items.reduce((s,i)=>s+(Number.isInteger(i.qty)?i.qty:0),0) }
    };
    const errs = grvStructureErrors(doc);
    if(errs.length) throw new Error("Cannot build Goods Received Voucher: "+errs.join("; "));
    const out = canonicalGRV(doc,false);
    out.checksum = await grvChecksum(doc, hashFn);
    return out;
  }
  function serializeGRV(doc){ return JSON.stringify(canonicalGRV(doc,true)); }

  const GRV_TOP_KEYS = ["format","format_version","grv_no","grv_display","dn_no","dn_display","from","to","received_iso","items","totals","checksum"];
  function grvStructureErrors(d){
    const e = [];
    if(!isObj(d)) return ["This is not a Goods Received Voucher file."];
    if(d.format!==GRV_FORMAT) return ["This is not a seiGEN Goods Received Voucher (wrong file type)."];
    if(d.format_version!==GRV_FORMAT_VERSION)
      return [newerAppMessage("Goods Received Voucher", d.format_version, GRV_FORMAT_VERSION)];
    Object.keys(d).forEach(k=>{ if(!GRV_TOP_KEYS.includes(k)) e.push("Unexpected field \""+k+"\"."); });
    if(!Number.isInteger(d.grv_no) || d.grv_no<1) e.push("The GRV number is missing or invalid.");
    else if(d.grv_display!==formatDocNo("GRV",d.grv_no)) e.push("The GRV number does not match its display number.");
    if(!Number.isInteger(d.dn_no) || d.dn_no<1) e.push("The Delivery Note number is missing or invalid.");
    else if(d.dn_display!==formatDocNo("DN",d.dn_no)) e.push("The Delivery Note number does not match its display number.");
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
