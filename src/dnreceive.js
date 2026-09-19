  // ---------------- Receiving a Delivery Note: checks + variance report ----------------
  // Pure — no DOM, no database. The database side (receive-in.js) hands in what
  // it knows (own branch, earlier records, this branch's products) and gets
  // back either the first reason to stop or the resolved lines. Nothing here
  // changes anything, and nothing here can change a quantity: the lines it
  // returns carry the DN's own numbers.

  // "2026-09-04T08:00:00+02:00" -> "04Sep26" (read from the text, so no time-zone shift)
  function isoDateText(iso){
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||""));
    return m? m[3]+MONTH_ABBR[Number(m[2])-1]+m[1].slice(2) : "";
  }
  const dnrKey = (s)=> String(s==null?"":s).trim().toLowerCase();

  // Every DN line must map to exactly ONE product in this branch:
  //   code given  -> match by code (case-insensitive)
  //   code empty  -> exact name match, which must be unique
  // Anything else is a problem and blocks the WHOLE receipt. Receiving never creates a product.
  // -> { lines:[{index,item,product}], problems:[{index,code,name,qty,reason,matches?}] }
  function resolveLines(items, products){
    const byCode = new Map(), byName = new Map();
    products.forEach(p=>{
      const c = dnrKey(p.sku), n = dnrKey(p.name);
      if(c){ if(!byCode.has(c)) byCode.set(c,[]); byCode.get(c).push(p); }
      if(n){ if(!byName.has(n)) byName.set(n,[]); byName.get(n).push(p); }
    });
    const lines = [], problems = [];
    items.forEach((item,index)=>{
      const code = dnrKey(item.code);
      const list = code? byCode.get(code) : byName.get(dnrKey(item.name));
      if(!list || list.length===0) problems.push({ index, code:item.code, name:item.name, qty:item.qty, reason:"not found" });
      else if(list.length>1) problems.push({ index, code:item.code, name:item.name, qty:item.qty, reason:"ambiguous", matches:list.map(p=>p.name) });
      else lines.push({ index, item, product:list[0] });
    });
    return { lines, problems };
  }
  function problemLineText(p){
    const what = (p.code? p.code+" " : "")+p.name;
    return p.reason==="ambiguous"
      ? what+": matches more than one product here ("+p.matches.join(", ")+")"
      : what+": "+(p.code? "code not found" : "no product with exactly this name")+" in this branch";
  }

  // The receiving checks, in order; the first failure stops with a plain message.
  //   text: file content   ctx: { ownBranchId, ownBranchName, lookup(fromBranchId, dnNo), products }
  // -> { ok:false, stage, message, ... } | { ok:true, doc, lines, resume, record }
  async function checkIncomingDN(text, ctx, hashFn){
    // 1. parse, validate, checksum
    const p = await parseDN(text, hashFn);
    if(!p.ok) return { ok:false, stage:"file", message:p.errors[0], errors:p.errors };
    const doc = p.doc;
    // 2. a DN this branch dispatched itself
    if(doc.from.branch_id===ctx.ownBranchId)
      return { ok:false, stage:"own", message:"This Delivery Note was dispatched by this branch ("+doc.dn_display+" to "+doc.to.name+"). It can only be received at "+doc.to.name+".", doc };
    // 3. destination must be this branch
    if(!sameBranchName(doc.to.name, ctx.ownBranchName))
      return { ok:false, stage:"destination", message:"This Delivery Note is for \""+doc.to.name+"\", but this branch is \""+ctx.ownBranchName+"\". Nothing was received.", doc };
    // 4. already received? variance-pending may be opened again
    const rec = ctx.lookup(doc.from.branch_id, doc.dn_no) || null;
    let resume = false;
    if(rec){
      if(rec.status==="received")
        return { ok:false, stage:"duplicate", message:"Already received on "+(isoDateText(rec.received_iso)||String(rec.received_ts||"").slice(0,10))+" as "+formatDocNo("GRV",rec.grv_no)+".", doc, record:rec };
      if(rec.status==="cancelled")
        return { ok:false, stage:"cancelled", message:"This Delivery Note was cancelled by "+doc.from.name+(rec.cancelled_ts? " on "+(isoDateText(rec.cancelled_ts)||String(rec.cancelled_ts).slice(0,10)) : "")
          +(rec.replaced_by? " and replaced by "+formatDocNo("DN",rec.replaced_by) : "")+". Do not receive it.", doc, record:rec };
      if(rec.status==="variance") resume = true;
    }
    // 4b. a reissued DN replaces an earlier one. If that one was already received here, this one can't be.
    let replaces = null;
    if(doc.replaces){
      const old = ctx.lookup(doc.from.branch_id, doc.replaces) || null;
      if(old && old.status==="received")
        return { ok:false, stage:"replaces-received", message:doc.dn_display+" replaces "+formatDocNo("DN",doc.replaces)+", which was already received here as "+formatDocNo("GRV",old.grv_no)
          +". This replacement can't be received. Send that voucher to "+doc.from.name+".", doc, record:old };
      replaces = { dnNo:doc.replaces, record:old };
    }
    // 5. every line resolves to exactly one local product
    const r = resolveLines(doc.items, ctx.products);
    if(r.problems.length)
      return { ok:false, stage:"products", message:"Some lines on this Delivery Note can't be matched to a product in this branch, so nothing was received.", problems:r.problems, doc };
    return { ok:true, doc, lines:r.lines, resume, record:rec, replaces };
  }

  // ---- variance report ----
  // Flags are information only: they are never applied to stock.
  //   input: { flags:[{index, counted}], note }
  // -> { ok, errors, report:{ flags:[{index,code,name,dn,counted,diff}], note } }
  function buildVarianceReport(doc, input){
    const errors = [], seen = new Set(), flags = [];
    (input.flags||[]).forEach(f=>{
      const item = doc.items[f.index];
      if(!item){ errors.push("A flagged line is not on this Delivery Note."); return; }
      if(seen.has(f.index)){ errors.push((item.code||item.name)+" is flagged twice."); return; }
      seen.add(f.index);
      const raw = String(f.counted==null?"":f.counted).trim();
      if(!/^\d+$/.test(raw) || Number(raw)>DN_MAX_QTY){ errors.push((item.code||item.name)+": counted quantity must be a whole number, 0 or more."); return; }
      const counted = Number(raw);
      flags.push({ index:f.index, code:item.code, name:item.name, dn:item.qty, counted, diff:counted-item.qty });
    });
    const note = String(input.note||"").trim();
    if(errors.length===0 && flags.length===0 && !note) errors.push("Flag at least one line with the counted quantity, or write a note.");
    return { ok:errors.length===0, errors, report:{ flags, note } };
  }
  // "19Sep26 10:15 AM" — local date and 12-hour time
  function reportedStamp(d){
    const h = d.getHours();
    return fileDatePart(d)+" "+String(h%12||12)+":"+String(d.getMinutes()).padStart(2,"0")+" "+(h<12?"AM":"PM");
  }
  function varianceLine(f){
    const state = f.diff<0? "short "+(-f.diff) : f.diff>0? "over "+f.diff : "matches";
    return (f.code||"(no code)")+" "+f.name+": DN "+f.dn+", counted "+f.counted+" ("+state+")";
  }
  // The WhatsApp text. Kept under ~maxChars: if the flagged lines don't fit, the
  // first ones are listed and the rest summarised.
  function varianceMessage(doc, ownName, report, now, maxChars){
    maxChars = maxChars||1500;
    const head = ["VARIANCE REPORT", doc.dn_display+" from "+doc.from.name+" to "+ownName+", dispatched "+isoDateText(doc.created_iso), "Stock NOT received."];
    const note = report.note? "Note: "+(report.note.length>400? report.note.slice(0,400)+"…" : report.note) : "";
    const foot = "Reported "+reportedStamp(now);
    const fixed = head.join("\n").length + (note? note.length+1 : 0) + foot.length + 2;
    const lines = report.flags.map(varianceLine);
    const out = [];
    let used = fixed;
    for(let i=0;i<lines.length;i++){
      const more = lines.length-(i+1);
      const reserve = more>0? ("+"+more+" more lines, see the DN file").length+1 : 0;
      if(used+lines[i].length+1+reserve>maxChars){ break; }
      out.push(lines[i]); used += lines[i].length+1;
    }
    const rest = lines.length-out.length;
    const parts = head.concat(out);
    if(rest>0) parts.push("+"+rest+" more line"+(rest===1?"":"s")+", see the DN file");
    if(note) parts.push(note);
    parts.push(foot);
    return parts.join("\n");
  }
  // Same channel, for a DN that can't be matched to this branch's products.
  function unmatchedMessage(doc, ownName, problems, now, maxChars){
    maxChars = maxChars||1500;
    const head = ["UNMATCHED PRODUCTS", doc.dn_display+" from "+doc.from.name+" to "+ownName+", dispatched "+isoDateText(doc.created_iso), "Stock NOT received."];
    const foot = "Reported "+reportedStamp(now);
    const out = [];
    let used = head.join("\n").length+foot.length+2;
    for(let i=0;i<problems.length;i++){
      const line = problemLineText(problems[i]);
      const more = problems.length-(i+1), reserve = more>0? ("+"+more+" more lines, see the DN file").length+1 : 0;
      if(used+line.length+1+reserve>maxChars) break;
      out.push(line); used += line.length+1;
    }
    const rest = problems.length-out.length;
    const parts = head.concat(out);
    if(rest>0) parts.push("+"+rest+" more line"+(rest===1?"":"s")+", see the DN file");
    parts.push(foot);
    return parts.join("\n");
  }
