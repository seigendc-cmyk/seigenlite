  // ---------------- Delivery Note file (Phase 2) ----------------
  // One self-contained JSON document. Pure: no DOM, no database, no network,
  // so test/dnfile.test.js can load it under plain Node (it does need
  // formatDocNo from docnum.js, which is also pure).
  //
  // Key order is fixed (canonicalDN below) and the checksum is SHA-256 over
  // JSON.stringify of the document WITHOUT the checksum field. The same
  // inputs therefore always produce the same bytes, on every build.
  //
  // Deliberately NOT in the file: cost and selling price. A DN is forwarded
  // over WhatsApp and Remote branches must never see costs.
  const DN_FORMAT = "seigen-dn";
  const DN_FORMAT_VERSION = 1;            // ordinary Delivery Notes: unchanged, byte for byte
  const DN_FORMAT_VERSION_REPLACES = 2;   // a reissued DN (carries "replaces"); older apps reject it with the "update the app" message
  // One wording for every file family: a file from a newer build than this app reads.
  function newerAppMessage(what, fileVersion, maxVersion){
    return "This "+what+" needs a newer version of seiGEN Commerce Lite (file version "+String(fileVersion)+", this app reads up to "+maxVersion+"). Update the app, then import it again. Nothing was changed.";
  }
  const DN_DEFAULT_UNIT = "pcs";
  const DN_MAX_QTY = 1000000;

  // ---- SHA-256 ----
  // Pure-JS fallback for contexts without crypto.subtle (e.g. plain http on a
  // phone). Works on UTF-8 bytes; returns lowercase hex synchronously.
  function utf8Bytes(str){
    const out = [];
    for(let i=0;i<str.length;i++){
      let c = str.charCodeAt(i);
      if(c>=0xD800 && c<=0xDBFF && i+1<str.length){
        const d = str.charCodeAt(i+1);
        if(d>=0xDC00 && d<=0xDFFF){ c = 0x10000 + ((c-0xD800)<<10) + (d-0xDC00); i++; }
      }
      if(c<0x80) out.push(c);
      else if(c<0x800) out.push(0xC0|(c>>6), 0x80|(c&63));
      else if(c<0x10000) out.push(0xE0|(c>>12), 0x80|((c>>6)&63), 0x80|(c&63));
      else out.push(0xF0|(c>>18), 0x80|((c>>12)&63), 0x80|((c>>6)&63), 0x80|(c&63));
    }
    return out;
  }
  const SHA256_K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  function sha256HexPure(str){
    const bytes = utf8Bytes(String(str));
    const bitLen = bytes.length*8;
    bytes.push(0x80);
    while(bytes.length%64!==56) bytes.push(0);
    const hi = Math.floor(bitLen/0x100000000), lo = bitLen>>>0;
    for(let i=3;i>=0;i--) bytes.push((hi>>>(i*8))&255);
    for(let i=3;i>=0;i--) bytes.push((lo>>>(i*8))&255);
    const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const w = new Array(64);
    const rotr = (x,n)=>(x>>>n)|(x<<(32-n));
    for(let off=0;off<bytes.length;off+=64){
      for(let i=0;i<16;i++) w[i] = (bytes[off+i*4]<<24)|(bytes[off+i*4+1]<<16)|(bytes[off+i*4+2]<<8)|bytes[off+i*4+3];
      for(let i=16;i<64;i++){
        const s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);
        const s1 = rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);
        w[i] = (w[i-16]+s0+w[i-7]+s1)|0;
      }
      let [a,b,c,d,e,f,g,h] = H;
      for(let i=0;i<64;i++){
        const S1 = rotr(e,6)^rotr(e,11)^rotr(e,25);
        const ch = (e&f)^(~e&g);
        const t1 = (h+S1+ch+SHA256_K[i]+w[i])|0;
        const S0 = rotr(a,2)^rotr(a,13)^rotr(a,22);
        const maj = (a&b)^(a&c)^(b&c);
        const t2 = (S0+maj)|0;
        h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
      }
      H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
      H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
    }
    return H.map(x=>(x>>>0).toString(16).padStart(8,"0")).join("");
  }
  // Default hash: crypto.subtle where present, else the pure fallback.
  // Any (string)=>hex or Promise<hex> can be injected instead.
  async function sha256Hex(str){
    try{
      if(typeof crypto!=="undefined" && crypto.subtle && crypto.subtle.digest){
        const buf = await crypto.subtle.digest("SHA-256", new Uint8Array(utf8Bytes(String(str))));
        return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
      }
    }catch(e){ /* fall through to the pure implementation */ }
    return sha256HexPure(str);
  }

  // Local time with UTC offset, e.g. 2026-09-04T08:00:00+02:00.
  function localIso(d){
    const p = (n,l=2)=>String(n).padStart(l,"0");
    const off = -d.getTimezoneOffset(), sign = off>=0?"+":"-", a = Math.abs(off);
    return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds())
      + sign+p(Math.floor(a/60))+":"+p(a%60);
  }

  // The one place key order is decided. Anything not listed is dropped, and
  // thumb is omitted (not null) when an item has no image.
  function canonicalDN(d, withChecksum){
    const out = {
      format: d.format,
      format_version: d.format_version,
      dn_no: d.dn_no,
      dn_display: d.dn_display,
      from: { branch_id: d.from && d.from.branch_id, name: d.from && d.from.name },
      to: { name: d.to && d.to.name },
      created_iso: d.created_iso
    };
    if(d.replaces!==undefined && d.replaces!==null){                                 // only reissued DNs (version 2)
      out.replaces = d.replaces;
      out.cancel_no = d.cancel_no;            // the cancel case it belongs to, so a receiver can confirm the old DN's cancellation
      out.cancel_nonce = d.cancel_nonce;
    }
    out.items = (d.items||[]).map(it=>{
      const o = { code: it.code, name: it.name, unit: it.unit, qty: it.qty };
      if(it.thumb) o.thumb = it.thumb;
      return o;
    });
    out.totals = { lines: d.totals && d.totals.lines, units: d.totals && d.totals.units };
    if(withChecksum) out.checksum = d.checksum;
    return out;
  }
  async function dnChecksum(d, hashFn){
    return await (hashFn||sha256Hex)(JSON.stringify(canonicalDN(d,false)));
  }

  // input: { dnNo, fromBranchId, fromName, toName, createdIso, replaces?, items:[{code,name,unit?,qty,thumb?}] }
  // Throws on input that could never form a valid DN (so a bad DN is never written).
  async function buildDN(input, hashFn){
    const items = (input.items||[]).map(it=>({
      code: String(it.code==null?"":it.code).trim(),
      name: String(it.name==null?"":it.name).trim(),
      unit: String(it.unit||DN_DEFAULT_UNIT).trim()||DN_DEFAULT_UNIT,
      qty: it.qty,
      thumb: it.thumb||undefined
    }));
    const hasReplaces = input.replaces!==undefined && input.replaces!==null;
    const doc = {
      format: DN_FORMAT,
      format_version: hasReplaces? DN_FORMAT_VERSION_REPLACES : DN_FORMAT_VERSION,
      dn_no: input.dnNo,
      dn_display: Number.isInteger(input.dnNo) && input.dnNo>=0 ? formatDocNo("DN",input.dnNo) : "",
      from: { branch_id: input.fromBranchId, name: input.fromName },
      to: { name: input.toName },
      created_iso: input.createdIso,
      items,
      totals: { lines: items.length, units: items.reduce((s,i)=>s+(Number.isInteger(i.qty)?i.qty:0),0) }
    };
    if(hasReplaces){ doc.replaces = input.replaces; doc.cancel_no = input.cancelNo; doc.cancel_nonce = input.cancelNonce; }
    const errs = dnStructureErrors(doc);
    if(errs.length) throw new Error("Cannot build Delivery Note: "+errs.join("; "));
    const out = canonicalDN(doc,false);
    out.checksum = await dnChecksum(doc, hashFn);
    return out;
  }
  // The exact bytes that go into the file.
  function serializeDN(doc){ return JSON.stringify(canonicalDN(doc,true)); }

  const DN_TOP_KEYS = ["format","format_version","dn_no","dn_display","from","to","created_iso","replaces","cancel_no","cancel_nonce","items","totals","checksum"];
  const isObj = (x)=>x!==null && typeof x==="object" && !Array.isArray(x);
  const isNonEmptyStr = (x)=>typeof x==="string" && x.trim().length>0;

  // Everything except the checksum. Returns human-readable messages.
  function dnStructureErrors(d){
    const e = [];
    if(!isObj(d)) return ["This is not a Delivery Note file."];
    if(d.format!==DN_FORMAT) return ["This is not a seiGEN Delivery Note (wrong file type)."];
    if(d.format_version!==DN_FORMAT_VERSION && d.format_version!==DN_FORMAT_VERSION_REPLACES)
      return [newerAppMessage("Delivery Note", d.format_version, DN_FORMAT_VERSION_REPLACES)];
    Object.keys(d).forEach(k=>{ if(!DN_TOP_KEYS.includes(k)) e.push("Unexpected field \""+k+"\" in the Delivery Note."); });
    if(!Number.isInteger(d.dn_no) || d.dn_no<1) e.push("The Delivery Note number is missing or invalid.");
    else if(d.dn_display!==formatDocNo("DN",d.dn_no)) e.push("The Delivery Note number does not match its display number.");
    if(d.format_version===DN_FORMAT_VERSION_REPLACES){
      if(!Number.isInteger(d.replaces) || d.replaces<1 || (Number.isInteger(d.dn_no) && d.replaces>=d.dn_no)) e.push("The Delivery Note it replaces is missing or invalid.");
      if(!Number.isInteger(d.cancel_no) || d.cancel_no<1 || typeof d.cancel_nonce!=="string" || !/^[A-Za-z0-9]{12,40}$/.test(d.cancel_nonce)) e.push("The cancellation reference on this replacement is missing or invalid.");
    } else ["replaces","cancel_no","cancel_nonce"].forEach(k=>{ if(d[k]!==undefined) e.push("Unexpected field \""+k+"\" in the Delivery Note."); });
    if(!isObj(d.from) || !isNonEmptyStr(d.from.branch_id) || !isNonEmptyStr(d.from.name)) e.push("The dispatching branch (id and name) is missing.");
    if(!isObj(d.to) || !isNonEmptyStr(d.to.name)) e.push("The receiving branch is missing.");
    if(!isNonEmptyStr(d.created_iso) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/.test(d.created_iso)) e.push("The dispatch date and time is missing or invalid.");
    if(!Array.isArray(d.items) || d.items.length===0) e.push("The Delivery Note has no items.");
    else {
      const seen = new Set();
      d.items.forEach((it,i)=>{
        const n = i+1;
        if(!isObj(it)){ e.push("Item "+n+" is not valid."); return; }
        if(typeof it.code!=="string") e.push("Item "+n+" has no code.");
        if(!isNonEmptyStr(it.name)) e.push("Item "+n+" has no name.");
        if(!isNonEmptyStr(it.unit)) e.push("Item "+n+" has no unit.");
        if(!Number.isInteger(it.qty) || it.qty<1) e.push("Item "+n+" ("+(it.name||it.code||"?")+") has an invalid quantity — it must be a whole number of 1 or more.");
        else if(it.qty>DN_MAX_QTY) e.push("Item "+n+" ("+(it.name||it.code||"?")+") has an unrealistic quantity.");
        if(it.thumb!==undefined && (typeof it.thumb!=="string" || !/^data:image\/(webp|jpeg|png);base64,/.test(it.thumb))) e.push("Item "+n+" has an invalid picture.");
        Object.keys(it).forEach(k=>{ if(!["code","name","unit","qty","thumb"].includes(k)) e.push("Item "+n+" has an unexpected field \""+k+"\"."); });
        // Products without a SKU are told apart by name.
        const key = (typeof it.code==="string" && it.code.trim()) ? "code:"+it.code.trim().toLowerCase() : "name:"+String(it.name||"").trim().toLowerCase();
        if(seen.has(key)) e.push("Item "+n+" ("+(it.code||it.name)+") appears more than once in this Delivery Note.");
        seen.add(key);
      });
    }
    if(!isObj(d.totals)) e.push("The totals are missing.");
    else if(Array.isArray(d.items)){
      const units = d.items.reduce((s,i)=>s+(isObj(i)&&Number.isInteger(i.qty)?i.qty:0),0);
      if(d.totals.lines!==d.items.length || d.totals.units!==units) e.push("The totals do not match the items listed.");
    }
    return e;
  }
  async function verifyChecksum(d, hashFn){
    if(!isObj(d) || typeof d.checksum!=="string" || !/^[0-9a-f]{64}$/.test(d.checksum)) return false;
    return (await dnChecksum(d, hashFn)) === d.checksum;
  }
  // -> { ok, errors:[...] }. Structure first (clear messages), then integrity.
  async function validateDN(d, hashFn){
    const errors = dnStructureErrors(d);
    if(errors.length===0){
      if(typeof d.checksum!=="string" || !/^[0-9a-f]{64}$/.test(d.checksum)) errors.push("The file has no valid checksum — it may be incomplete.");
      else if(!(await verifyChecksum(d,hashFn))) errors.push("The file's checksum does not match — it was changed or damaged after it was created. Ask the sender to send it again.");
    }
    return { ok: errors.length===0, errors };
  }
  // Content sniff used by the old data-backup import (backup.js): which of our
  // JSON file formats is this, if any? Returns the top-level "format" string
  // (e.g. "seigen-dn", "seigen-catalogue") or null. Never throws. Judges by
  // content only. A SQLite backup starts with "SQLite format 3" and is
  // rejected before any decoding; a truncated file (invalid JSON) is still
  // recognised by its leading "format" key.
  function sniffJsonFormat(bytes){
    try{
      let i = 0;
      if(bytes.length>=3 && bytes[0]===0xEF && bytes[1]===0xBB && bytes[2]===0xBF) i = 3;
      while(i<bytes.length && (bytes[i]===0x20||bytes[i]===0x09||bytes[i]===0x0A||bytes[i]===0x0D)) i++;
      if(i>=bytes.length || bytes[i]!==0x7B) return null;               // must start with "{"
      const dec = (u8)=> typeof TextDecoder!=="undefined" ? new TextDecoder("utf-8").decode(u8) : String.fromCharCode.apply(null, Array.from(u8));
      const text = dec(bytes.subarray? bytes.subarray(i) : bytes.slice(i));
      try{
        const d = JSON.parse(text);
        return isObj(d) && typeof d.format==="string" ? d.format : null;
      }catch(e){
        const m = /^\{\s*"format"\s*:\s*"([a-z0-9-]+)"/.exec(text.slice(0,200));
        return m? m[1] : null;
      }
    }catch(e){ return null; }
  }
  function isDNFileBytes(bytes){ return sniffJsonFormat(bytes)===DN_FORMAT; }
  // Text of a .json file -> validated document. Never throws.
  async function parseDN(text, hashFn){
    let d;
    try{ d = JSON.parse(String(text).replace(/^﻿/,"")); }
    catch(e){ return { ok:false, errors:["This file is not a readable Delivery Note (it is not valid JSON, or was cut off)."], doc:null }; }
    const r = await validateDN(d, hashFn);
    return { ok:r.ok, errors:r.errors, doc: r.ok? d : null };
  }
