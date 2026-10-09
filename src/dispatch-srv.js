  // ================== Dispatch & GRV through seiGEN (B1) ==================
  // docs/dispatch/dispatch-grv-supabase-design.md; server side:
  // supabase/migrations/20261017120000_dispatch_grv.sql.
  //
  // The server holds the documents (the dispatch, its GRV, the differences);
  // it never moves stock. This device moves ITS OWN stock once per document:
  // every movement carries a document key in stock_movements.doc_uid, and
  // nothing is applied when that key is already in the ledger. So a retry, a
  // double tap, a reinstall or a restored backup never counts twice, and the
  // pull puts back anything a restore lost (dsReconcile).
  //
  // Document keys (doc_uid):
  //   <dispatch uid>          the sender's dispatch (as today: dispatch_docs.uid)
  //   <dispatch uid>:cancel   the sender's stock back on a cancel
  //   <issue uid>:return      a shortage / damaged unit back in the sender's stock
  //   <issue uid>:wo          its write-off (ADJ)
  //   <issue uid>:extra       a confirmed extra, off the sender's stock
  //   <GRV uid>               the receiver's stock in
  // (uids are 32 hex; the server's uuids are the same digits with dashes.)
  //
  // Who does what: the till that dispatched holds the stock, so it alone
  // sends, cancels, re-dispatches and resolves; any till of the receiving
  // branch may receive (first GRV wins, checked on the server BEFORE any stock
  // moves here). Receiving, cancelling and resolving need the internet;
  // dispatching doesn't (the send waits in srv_pending).
  // Not on shared-stock tills yet (their stock lives on the server): they keep
  // the file flow.

  function dsUuid(hex){
    const h = String(hex||"").toLowerCase().replace(/-/g,"");
    return /^[0-9a-f]{32}$/.test(h)? h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20) : "";
  }
  function dsHex(uuid){ return String(uuid||"").toLowerCase().replace(/-/g,""); }
  function dsNewUid(){
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, x=>x.toString(16).padStart(2,"0")).join("");
  }
  function dsEnabled(){
    return typeof isTerminalRegistered==="function" && isTerminalRegistered()
      && !(typeof sharedStockTill==="function" && sharedStockTill())
      && !(typeof isTerminalInactive==="function" && isTerminalInactive());
  }
  const dsMyTerminal = ()=> getSetting("terminal_id","");
  const dsMyBranchUuid = ()=> getSetting("branch_uuid","");
  const dsShowCosts = ()=> !isRemote();

  // ---- the business's branches (for destinations) ----
  function dsBranches(){ try{ return JSON.parse(getSetting("ds_branches","[]"))||[]; }catch(e){ return []; } }
  async function dsRefreshBranches(){
    if(!dsEnabled() || typeof fetchBusinessBranches!=="function") return dsBranches();
    const r = await fetchBusinessBranches();
    if(r.ok && r.data && Array.isArray(r.data.branches)){
      setSetting("ds_branches", JSON.stringify(r.data.branches.map(b=>({ id:b.id, name:b.name, is_main:!!b.is_main }))));
    }
    return dsBranches();
  }
  // A joined branch of this business with that name (never this branch), or null.
  function dsBranchFor(name){
    if(!dsEnabled()) return null;
    const me = dsMyBranchUuid();
    return dsBranches().find(b=> b.id!==me && sameBranchName(b.name, name)) || null;
  }
  // Joined branches are destinations too, even before main adds them to the register.
  function dsDestinationNames(){
    if(!dsEnabled()) return [];
    const me = dsMyBranchUuid();
    return dsBranches().filter(b=> b.id!==me && !sameBranchName(b.name, currentBranch())).map(b=>b.name);
  }

  // ---- the local copy of what the server holds ----
  function dsCached(dir){
    return all("SELECT json FROM srv_dispatches WHERE dir=?",[dir]).map(r=>{ try{ return JSON.parse(r.json); }catch(e){ return null; } }).filter(Boolean)
      .sort((a,b)=> String(b.sent_at||"").localeCompare(String(a.sent_at||"")));
  }
  function dsCachedOne(id){
    const r = one("SELECT json FROM srv_dispatches WHERE id=?",[id]);
    try{ return r? JSON.parse(r.json) : null; }catch(e){ return null; }
  }
  function dsStore(dir, d){
    run("INSERT OR REPLACE INTO srv_dispatches(id,dir,status,json,pulled_ts) VALUES(?,?,?,?,?)",[d.id, dir, d.status, JSON.stringify(d), new Date().toISOString()]);
  }
  function dsPending(kind){ return all("SELECT * FROM srv_pending WHERE kind=? ORDER BY created_ts",[kind]).map(r=>Object.assign(r,{ payload:JSON.parse(r.payload_json) })); }
  function dsPendingOne(key){ const r = one("SELECT * FROM srv_pending WHERE key=?",[key]); return r? Object.assign(r,{ payload:JSON.parse(r.payload_json) }) : null; }
  function dsSetPending(key, kind, payload){
    run("INSERT OR REPLACE INTO srv_pending(key,kind,payload_json,created_ts,tries,error) VALUES(?,?,?,COALESCE((SELECT created_ts FROM srv_pending WHERE key=?),?),0,'')",
      [key, kind, JSON.stringify(payload), key, new Date().toISOString()]);
  }
  function dsProblems(){ try{ return JSON.parse(getSetting("ds_problems","[]"))||[]; }catch(e){ return []; } }
  function dsAddProblem(key, text){
    const p = dsProblems().filter(x=>x.key!==key); p.push({ key, text, ts:new Date().toISOString() });
    setSetting("ds_problems", JSON.stringify(p.slice(-50)));
  }
  function dsClearProblem(key){ setSetting("ds_problems", JSON.stringify(dsProblems().filter(x=>x.key!==key))); }

  // ---- the ledger: has this document moved stock here? ----
  const dsApplied = (docUid)=> !!one("SELECT 1 AS x FROM stock_movements WHERE doc_uid=? LIMIT 1",[docUid]);
  // A dispatch line's product in this branch: catalogue uid, then a unique code, then a unique exact name.
  function dsFindProduct(l){
    const branch = currentBranch();
    if(l.cat_uid){ const p = one("SELECT * FROM products WHERE branch=? AND cat_uid=?",[branch,l.cat_uid]); if(p) return p; }
    if(String(l.code||"").trim()){
      const ps = all("SELECT * FROM products WHERE branch=? AND lower(trim(sku))=lower(trim(?))",[branch,l.code]);
      if(ps.length===1) return ps[0];
      if(ps.length>1) return null;
    }
    const ns = all("SELECT * FROM products WHERE branch=? AND lower(trim(name))=lower(trim(?))",[branch,l.name]);
    return ns.length===1? ns[0] : null;
  }
  // One movement + its stock_received line. Throws when the product is missing (the caller's transaction rolls back).
  function dsMove(product, delta, kind, docType, docUid, docNo, note, ts){
    moveStock({ productId:product.id, delta, kind, docType, docUid, docNo, ts, note });
    run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user,till_code) VALUES(?,?,?,?,?,?,?,?)",
      [ts, product.id, product.name, delta, docNo+": "+note, currentBranch(), String(sessionUser||""), currentTillCode()||null]);
  }
  function dsTx(fn){
    db.run("BEGIN");
    try{ const r = fn(); db.run("COMMIT"); return r; }
    catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
  }
  function dsLegacyFrom(d){ return d.from_legacy_branch_id || ("SRV-"+dsHex(d.from_branch_id).slice(0,8)); }
  const dsLine = (d, n)=> (d.lines||[]).find(l=>l.line_no===n);

  // ---- sending (from dnCommitDispatch, inside its transaction) ----
  // o: { toBranchId, delivery:{ cost, currency, carrier, ref }, replacesIssueId? }
  function dsQueueDispatch(dnUid, dn, o, lines, createdIso, internalRef){
    const id = dsUuid(dnUid);
    if(!id) throw new Error("This Delivery Note has no id to send.");
    const dv = o.delivery || {};
    const cost = Math.round((Number(dv.cost)||0)*100)/100;
    if(!(cost>=0)) throw new Error("The delivery cost must be 0 or more.");
    const cur = String(dv.currency||"").trim().toUpperCase();
    if(cost>0 && !/^[A-Z]{3}$/.test(cur)) throw new Error("Give the delivery cost's currency (3 letters, e.g. USD).");
    const payload = { id, to_branch_id:o.toBranchId, dn_no:dn.n, dn_display:dn.text, created_iso:createdIso, internal_ref:internalRef||null,
      sent_by:String(sessionUser||""), from_legacy_branch_id:getBranchId(), replaces_issue_id:o.replacesIssueId||null,
      delivery:{ cost, currency:cost>0? cur : null, carrier:String(dv.carrier||"").trim()||null, ref:String(dv.ref||"").trim()||null },
      lines: lines.map(l=>({ cat_uid:l.product.cat_uid||null, code:l.product.sku||"", name:l.product.name, unit:null, qty:l.qty,
        unit_cost:(l.product.cost==null || l.product.cost==="")? null : Number(l.product.cost) })) };
    run("UPDATE dispatch_docs SET srv_id=?, srv_status='queued', srv_error='', delivery_cost=?, delivery_currency=? WHERE uid=?",[id, cost, cost>0? cur : "", dnUid]);
    dsSetPending(id, "send", payload);
    return id;
  }
  async function dsSendPending(){
    let sent = 0;
    for(const p of dsPending("send")){
      const r = await terminalRpc("cl_device_dispatch_send", Object.assign(terminalAuth(), { p_dispatch:p.payload }), { timeoutMs:20000 });
      if(!r.ok && (r.reason==="offline" || r.reason==="network")) break;
      if(r.ok){
        run("DELETE FROM srv_pending WHERE key=?",[p.key]);
        run("UPDATE dispatch_docs SET srv_status=?, srv_error='' WHERE srv_id=?",[r.data.status||"sent", p.key]);
        sent++;
      } else if(r.reason==="refused"){
        // it will never be accepted (another business, a used number…): the file is the way
        run("DELETE FROM srv_pending WHERE key=?",[p.key]);
        run("UPDATE dispatch_docs SET srv_status='error', srv_error=? WHERE srv_id=?",[(r.data&&r.data.message)||r.code, p.key]);
      } else {
        run("UPDATE srv_pending SET tries=tries+1, error=? WHERE key=?",[r.message||"", p.key]);
        run("UPDATE dispatch_docs SET srv_error=? WHERE srv_id=?",[r.message||"", p.key]);
      }
    }
    await persist();
    return sent;
  }

  // ---- receiving ----
  // The landed unit cost of each line: the delivery cost spread over what came
  // in by value (by units when nothing has a cost), added to the unit cost.
  // -> { line_no: unit cost } for lines with a cost. Not split on a short delivery.
  function dsLandedCosts(d, counts){
    const ins = (d.lines||[]).map(l=>{ const c = counts[l.line_no]||{}; return { l, units:(c.received||0)+(c.extra||0) }; }).filter(x=>x.units>0);
    const total = ins.reduce((s,x)=> s + (x.l.unit_cost==null? 0 : Number(x.l.unit_cost)*x.units), 0);
    const units = ins.reduce((s,x)=> s + x.units, 0);
    const dc = Number(d.delivery_cost)||0, out = {};
    ins.forEach(x=>{
      if(x.l.unit_cost==null && !dc) return;
      const base = x.l.unit_cost==null? 0 : Number(x.l.unit_cost);
      const share = !dc? 0 : (total>0? dc*(base*x.units)/total : dc*x.units/units);
      out[x.l.line_no] = Math.round((base + share/x.units)*10000)/10000;
    });
    return out;
  }
  // Problems with a count before anything is sent. counts: { line_no: { received, damaged, extra, note } }
  function dsCountProblems(d, counts, matches){
    const errs = [];
    (d.lines||[]).forEach(l=>{
      const c = counts[l.line_no] || {};
      const r = c.received, dm = c.damaged||0, x = c.extra||0;
      if(![r,dm,x].every(v=>Number.isInteger(v) && v>=0)) return errs.push(l.name+": the counts must be whole numbers of 0 or more.");
      if(r+dm>l.qty) return errs.push(l.name+": received and damaged add up to more than the "+l.qty+" sent. Count the rest as extra.");
      if(x>0 && r+dm<l.qty) return errs.push(l.name+": extra only when the full "+l.qty+" sent arrived.");
      if(r+x>0 && !(matches[l.line_no] && one("SELECT 1 AS x FROM products WHERE id=? AND branch=?",[matches[l.line_no], currentBranch()])))
        errs.push(l.name+": choose the product it goes into, or create it.");
    });
    return errs;
  }
  // Stock in for a GRV the server has accepted. Once: nothing when the GRV uid is in the ledger.
  function dsApplyGrv(d, p){
    const grvHex = dsHex(p.grv_id);
    return dsTx(()=>{
      if(dsApplied(grvHex) || one("SELECT 1 AS x FROM dispatch_docs WHERE srv_grv_id=?",[p.grv_id])) return false;
      const ts = new Date().toISOString(), iso = localIso(new Date()), from = dsLegacyFrom(d), branch = currentBranch();
      const landed = dsLandedCosts(d, p.counts);
      let units = 0;
      (d.lines||[]).forEach(l=>{
        const c = p.counts[l.line_no]||{}, n = (c.received||0)+(c.extra||0);
        if(n<=0) return;
        const prod = one("SELECT * FROM products WHERE id=? AND branch=?",[p.matches[l.line_no], branch]) || dsFindProduct(l);
        if(!prod) throw new Error(l.name+" isn't a product here any more.");
        dsMove(prod, n, "receive", "grv", grvHex, p.grv_display, "From "+d.from_branch+" ("+d.dn_display+")", ts);
        if(landed[l.line_no]!=null) run("UPDATE products SET cost=? WHERE id=?",[landed[l.line_no], prod.id]);
        units += n;
      });
      const rec = one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='in'",[from, d.dn_no]);
      if(rec) run(`UPDATE dispatch_docs SET status='received', grv_no=?, received_ts=?, received_iso=?, received_by=?, grv_till_code=?, grv_internal_ref=?, srv_id=?, srv_grv_id=?, srv_status=? WHERE dispatch_branch_id=? AND dn_no=? AND direction='in'`,
        [p.grv_no, ts, iso, p.by, currentTillCode()||null, p.internal_ref||null, d.id, p.grv_id, p.status||"received", from, d.dn_no]);
      else run(`INSERT INTO dispatch_docs(dispatch_branch_id,dispatch_branch_name,dn_no,receive_branch_name,direction,grv_no,created_ts,status,line_count,unit_total,created_iso,imported_ts,received_ts,received_iso,received_by,
                 till_code,internal_ref,grv_till_code,grv_internal_ref,srv_id,srv_grv_id,srv_status,delivery_cost,delivery_currency)
               VALUES(?,?,?,?,'in',?,?,'received',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [from, d.from_branch, d.dn_no, branch, p.grv_no, ts, (d.lines||[]).length, units, d.created_iso||"", ts, ts, iso, p.by,
         d.from_till||null, d.internal_ref||null, currentTillCode()||null, p.internal_ref||null, d.id, p.grv_id, p.status||"received", Number(d.delivery_cost)||0, d.delivery_currency||""]);
      recordDnEvent({ dnBranchId:from, dnNo:d.dn_no, type:"received", actorBranchId:getBranchId(), actorName:branch, fromName:d.from_branch, toName:branch, ts:iso, grvNo:p.grv_no,
        detail:{ dn_created_iso:d.created_iso||"", received_by:p.by, units, via:"seiGEN" }, dnTill:d.from_till||null, grvTill:currentTillCode()||null });
      logAudit("Receive Stock (seiGEN)", "", p.grv_display+": "+units+" unit"+(units===1?"":"s")+" from "+d.from_branch+" ("+d.dn_display+")"+(p.status==="received_diff"? ", with differences" : ""));
      return true;
    });
  }
  // Post the GRV: online only, the server first (the first till wins), then the stock here.
  // counts: { line_no: { received, damaged, extra, note } }; matches: { line_no: productId }
  async function dsPostGrv(dispatchId, counts, matches, opts){
    opts = opts || {};
    requireSignedIn();
    const d = dsCachedOne(dispatchId);
    if(!d) throw new Error("That dispatch isn't on this device. Refresh first.");
    let pend = dsPendingOne(dispatchId);
    if(!pend){
      if(!isOnline()) throw new Error("You need the internet to receive a seiGEN dispatch, so it's counted once for the whole branch.");
      const errs = dsCountProblems(d, counts, matches);
      if(errs.length) throw new Error(errs.join(" "));
      // the number and the request are saved BEFORE the call, so a retry sends the same GRV
      dsTx(()=>{
        const grv = reserveDocNumber("GRV");
        dsSetPending(dispatchId, "grv", { grv_id:dsUuid(dsNewUid()), grv_no:grv.n, grv_display:grv.text, by:String(sessionUser||""),
          internal_ref:cleanInternalRef(opts.internalRef)||null, note:String(opts.note||"").trim()||null, counts, matches });
      });
      await persist();
      pend = dsPendingOne(dispatchId);
    }
    return dsDriveGrv(pend);
  }
  async function dsDriveGrv(pend){
    const p = pend.payload;
    const d = dsCachedOne(pend.key);
    const lines = (d? d.lines : []).map(l=>{ const c = p.counts[l.line_no]||{}; return { line_no:l.line_no, received:c.received||0, damaged:c.damaged||0, extra:c.extra||0, note:c.note||null }; });
    const r = await terminalRpc("cl_device_grv_post", Object.assign(terminalAuth(), { p_dispatch_id:pend.key,
      p_grv:{ grv_id:p.grv_id, grv_no:p.grv_no, grv_display:p.grv_display, by:p.by, internal_ref:p.internal_ref, note:p.note, lines } }), { timeoutMs:20000 });
    if(!r.ok && (r.reason==="offline" || r.reason==="network"))
      return { ok:false, waiting:true, message:"Couldn't reach seiGEN. Nothing was added yet; it tries again by itself, or tap Receive again." };
    if(!r.ok){
      run("DELETE FROM srv_pending WHERE key=?",[pend.key]); await persist();
      return { ok:false, message:(r.data && r.data.message) || r.message || "Refused." };
    }
    const fresh = r.data.dispatch;
    dsStore("in", fresh);
    p.status = fresh.status;
    dsApplyGrv(fresh, p);
    run("DELETE FROM srv_pending WHERE key=?",[pend.key]);
    await persist();
    return { ok:true, grv_display:p.grv_display, status:fresh.status, dispatch:fresh };
  }
  // A dispatch this branch already took in from the DN file: tell seiGEN, move no stock.
  async function dsPostViaFile(d, rec){
    const grvId = dsUuid(dsNewUid());
    const r = await terminalRpc("cl_device_grv_post", Object.assign(terminalAuth(), { p_dispatch_id:d.id,
      p_grv:{ grv_id:grvId, grv_no:rec.grv_no, grv_display:docDisplay("GRV",rec.grv_no,rec.grv_till_code), by:rec.received_by||String(sessionUser||""), via_file:true,
        note:"Received from the Delivery Note file", lines:(d.lines||[]).map(l=>({ line_no:l.line_no, received:l.qty, damaged:0, extra:0 })) } }));
    if(r.ok){
      run("UPDATE dispatch_docs SET srv_id=?, srv_grv_id=?, srv_status=? WHERE dispatch_branch_id=? AND dn_no=? AND direction='in'",[d.id, grvId, r.data.dispatch.status, rec.dispatch_branch_id, rec.dn_no]);
      dsStore("in", r.data.dispatch);
    } else if(r.reason==="refused" && r.code==="ALREADY_RECEIVED"){
      dsAddProblem("twice:"+d.id, d.dn_display+" was received here from the file ("+docDisplay("GRV",rec.grv_no,rec.grv_till_code)+") AND through seiGEN on another till ("+(r.data.grv_display||"")+"). Count that stock and adjust it.");
    }
    return r;
  }

  // ---- the sender's actions (the dispatching till only) ----
  function dsNeedAdmin(passcode){
    requireSignedIn();
    if(!hasAdminPasscode()) throw new Error(NO_ADMIN_PASSCODE_MSG);
    const admin = findAdmin(passcode);
    if(!admin) throw new Error("Incorrect Admin passcode.");
    return admin;
  }
  function dsOnline(){ if(!isOnline()) throw new Error("You need the internet for this, so both branches see the same thing."); }
  async function dsCancel(dispatchId, reason, passcode){
    const admin = dsNeedAdmin(passcode); dsOnline();
    if(String(reason||"").trim().length<3) throw new Error("Give a reason (at least 3 characters).");
    if(dsPendingOne(dispatchId)) await dsSendPending();
    if(dsPendingOne(dispatchId)) throw new Error("It hasn't reached seiGEN yet. Try again in a moment.");
    const r = await terminalRpc("cl_device_dispatch_cancel", Object.assign(terminalAuth(), { p_dispatch_id:dispatchId, p_reason:String(reason).trim(), p_by:String(sessionUser||"") }));
    if(!r.ok) throw new Error((r.data && r.data.message) || r.message || "Couldn't reach seiGEN. Nothing was changed.");
    dsStore("out", r.data.dispatch);
    dsApplyCancel(r.data.dispatch, admin.name);
    await persist();
    return r.data.dispatch;
  }
  function dsApplyCancel(d, adminName){
    const uid = dsHex(d.id);
    return dsTx(()=>{
      if(!dsApplied(uid) || dsApplied(uid+":cancel")) return false;
      const ts = new Date().toISOString();
      (d.lines||[]).forEach(l=>{
        const prod = dsFindProduct(l);
        if(!prod) throw new Error(l.name+" isn't a product here any more.");
        dsMove(prod, l.qty, "dispatch_cancel", "dn", uid+":cancel", d.dn_display, "Cancelled: "+(d.cancel_reason||""), ts);
      });
      run("UPDATE dispatch_docs SET status='cancelled', srv_status='cancelled', cancelled_ts=?, cancel_kind='seigen' WHERE srv_id=? AND direction='out'",[ts, d.id]);
      recordDnEvent({ dnBranchId:getBranchId(), dnNo:d.dn_no, type:"cancelled", actorBranchId:getBranchId(), actorName:currentBranch(), fromName:d.from_branch, toName:d.to_branch,
        ts:localIso(new Date()), detail:{ kind:"seigen", reason:d.cancel_reason||"" }, dnTill:d.from_till||null });
      logAudit("Dispatch cancelled (seiGEN)", "", d.dn_display+" to "+d.to_branch+": "+(d.cancel_reason||"")+(adminName? " (authorised by "+adminName+")" : ""));
      return true;
    });
  }
  // Write off a shortage or damaged unit: ADJ number saved first, then the server, then the stock.
  async function dsWriteOff(issueId, reason, passcode){
    const admin = dsNeedAdmin(passcode); dsOnline();
    if(String(reason||"").trim().length<3) throw new Error("Give a reason (at least 3 characters).");
    let pend = dsPendingOne(issueId);
    if(!pend){
      dsTx(()=>{ const adj = reserveDocNumber("ADJ"); dsSetPending(issueId, "write_off", { adj_no:adj.n, adj_text:adj.text, adj_till:adj.till||null, reason:String(reason).trim(), admin:admin.name, by:String(sessionUser||"") }); });
      await persist();
      pend = dsPendingOne(issueId);
    }
    return dsDriveWriteOff(pend);
  }
  async function dsDriveWriteOff(pend){
    const p = pend.payload;
    const r = await terminalRpc("cl_device_dispatch_resolve", Object.assign(terminalAuth(), { p_issue_id:pend.key, p_action:"write_off", p_by:p.by, p_note:p.reason, p_adj_display:p.adj_text }));
    if(!r.ok && (r.reason==="offline" || r.reason==="network")) return { ok:false, waiting:true, message:"Couldn't reach seiGEN. Nothing was written off yet; try again." };
    if(!r.ok){ run("DELETE FROM srv_pending WHERE key=?",[pend.key]); await persist(); return { ok:false, message:(r.data && r.data.message) || r.message }; }
    dsStore("out", r.data.dispatch);
    dsReconcileOne(r.data.dispatch, Object.assign({ issue_id:pend.key }, p));
    run("DELETE FROM srv_pending WHERE key=?",[pend.key]);
    await persist();
    return { ok:true, adj:p.adj_text };
  }
  async function dsResolveExtra(issueId, action, reason, passcode){
    if(action==="confirm") dsNeedAdmin(passcode); else requireSignedIn();
    dsOnline();
    if(action==="dispute" && String(reason||"").trim().length<3) throw new Error("Give a reason (at least 3 characters).");
    const r = await terminalRpc("cl_device_dispatch_resolve", Object.assign(terminalAuth(), { p_issue_id:issueId, p_action:action, p_by:String(sessionUser||""), p_note:String(reason||"").trim()||null, p_adj_display:null }));
    if(!r.ok) throw new Error((r.data && r.data.message) || r.message || "Couldn't reach seiGEN. Nothing was changed.");
    dsStore("out", r.data.dispatch);
    dsReconcileOne(r.data.dispatch);
    await persist();
    return r.data.dispatch;
  }
  // Send the short / damaged quantity again, as a new dispatch linked to the difference.
  async function dsRedispatch(issueId){
    requireSignedIn(); dsOnline();
    const d = dsCached("out").find(x=>(x.issues||[]).some(i=>i.id===issueId));
    const iss = d && d.issues.find(i=>i.id===issueId);
    if(!iss || iss.status!=="open" || iss.kind==="extra") throw new Error("That difference can't be re-dispatched.");
    const l = dsLine(d, iss.line_no), prod = dsFindProduct(l);
    if(!prod) throw new Error(l.name+" isn't a product here any more.");
    const dn = dnCommitDispatch({ branch:currentBranch(), toBranch:d.to_branch, now:new Date(), internalRef:"Re-dispatch of "+d.dn_display,
      lines:[{ product:prod, qty:iss.qty }], srv:{ toBranchId:d.to_branch_id, delivery:{}, replacesIssueId:issueId } });
    await persist();
    await dsSendPending();
    await dsPull();
    return dn;
  }

  // ---- putting back what this device did, once (after a restore, a crash between server and ledger, ...) ----
  function dsReconcileOne(d, wo){
    const me = dsMyTerminal(), uid = dsHex(d.id), ts = new Date().toISOString();
    if(d.from_terminal_id!==me) return;
    dsTx(()=>{
      const dispatched = dsApplied(uid);
      if(d.status!=="cancelled" && !dispatched){
        (d.lines||[]).forEach(l=>{ const prod = dsFindProduct(l); if(prod) dsMove(prod, -l.qty, "dispatch", "dn", uid, d.dn_display, "To "+d.to_branch+" (put back from seiGEN)", ts); });
        if(!one("SELECT 1 AS x FROM dispatch_docs WHERE srv_id=? AND direction='out'",[d.id]) && !one("SELECT 1 AS x FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=?",[getBranchId(), d.dn_no]))
          run(`INSERT INTO dispatch_docs(dispatch_branch_id,dispatch_branch_name,dn_no,receive_branch_name,direction,created_ts,status,line_count,unit_total,created_iso,till_code,internal_ref,srv_id,srv_status,delivery_cost,delivery_currency,uid)
               VALUES(?,?,?,?,'out',?,'dispatched',?,?,?,?,?,?,?,?,?,?)`,
            [getBranchId(), d.from_branch, d.dn_no, d.to_branch, d.sent_at||ts, (d.lines||[]).length, (d.lines||[]).reduce((s,l)=>s+l.qty,0), d.created_iso||"", d.from_till||null,
             d.internal_ref||null, d.id, d.status, Number(d.delivery_cost)||0, d.delivery_currency||"", uid]);
      }
      if(d.status==="cancelled" && dispatched && !dsApplied(uid+":cancel")){
        (d.lines||[]).forEach(l=>{ const prod = dsFindProduct(l); if(prod) dsMove(prod, l.qty, "dispatch_cancel", "dn", uid+":cancel", d.dn_display, "Cancelled: "+(d.cancel_reason||""), ts); });
        run("UPDATE dispatch_docs SET status='cancelled', cancelled_ts=?, cancel_kind='seigen' WHERE srv_id=? AND direction='out'",[ts, d.id]);
      }
      if(d.status!=="cancelled" && dsApplied(uid)){
        (d.issues||[]).forEach(i=>{
          const l = dsLine(d, i.line_no), prod = l && dsFindProduct(l), ih = dsHex(i.id);
          if(!prod){ dsAddProblem("noproduct:"+i.id, (l? l.name : "A product")+" on "+d.dn_display+" isn't in this branch, so its difference can't be put in stock."); return; }
          if(i.kind!=="extra" && !dsApplied(ih+":return"))
            dsMove(prod, i.qty, "dispatch_return", "dn", ih+":return", d.dn_display, (i.kind==="damaged"? "Damaged, at "+d.to_branch : "Short at "+d.to_branch)+" ("+d.grv_display+")", ts);
          if(i.kind!=="extra" && i.status==="written_off" && !dsApplied(ih+":wo")){
            const w = (wo && wo.issue_id===i.id)? wo : {};
            const adjNo = w.adj_no || null;
            if(adjNo!=null)
              run(`INSERT INTO stock_adjustments(branch,branch_id,adj_no,product_code,product_name,qty_delta,reason,note,by_user,authorised_by,ts,dn_branch_id,dn_no,till_code)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [currentBranch(), getBranchId(), adjNo, prod.sku||"", prod.name, -i.qty, i.kind==="damaged"? "Damaged in transit" : "Lost in transit", w.reason||i.resolution_note||"",
                 String(sessionUser||""), w.admin||i.resolved_by||"", ts, getBranchId(), d.dn_no, w.adj_till||null]);
            moveStock({ productId:prod.id, delta:-i.qty, kind:"write_off", docType:"adj", docUid:ih+":wo", docNo:i.adj_display||w.adj_text||"", ts, note:(i.kind==="damaged"? "Damaged" : "Short")+" on "+d.dn_display+": "+(w.reason||i.resolution_note||"") });
            logAudit("Write-off (seiGEN)", prod.name, (i.adj_display||w.adj_text||"")+": "+i.qty+" "+i.kind+" on "+d.dn_display+(w.admin? " (authorised by "+w.admin+")" : ""));
          }
          if(i.kind==="extra" && i.status==="confirmed" && !dsApplied(ih+":extra"))
            dsMove(prod, -i.qty, "dispatch_extra", "dn", ih+":extra", d.dn_display, "Extra confirmed at "+d.to_branch+" ("+d.grv_display+")", ts);
        });
        if(d.status==="received" || d.status==="received_diff"){
          const h = one("SELECT * FROM dispatch_docs WHERE srv_id=? AND direction='out'",[d.id]);
          if(h && h.status!=="received"){
            run("UPDATE dispatch_docs SET status='received', grv_no=?, grv_till_code=?, grv_internal_ref=? WHERE srv_id=? AND direction='out'",[d.grv_no, d.grv_till||null, d.grv_internal_ref||null, d.id]);
            recordDnEvent({ dnBranchId:getBranchId(), dnNo:d.dn_no, type:"received", actorBranchId:"", actorName:d.to_branch, fromName:d.from_branch, toName:d.to_branch,
              ts:d.received_at||ts, grvNo:d.grv_no, detail:{ via:"seiGEN", status:d.status }, dnTill:d.from_till||null, grvTill:d.grv_till||null });
          }
        }
      }
      run("UPDATE dispatch_docs SET srv_status=? WHERE srv_id=? AND direction='out'",[d.status, d.id]);
    });
  }
  function dsReconcile(pulled){
    const me = dsMyTerminal();
    (pulled.outgoing||[]).forEach(d=>{ try{ dsReconcileOne(d); }catch(e){ dsAddProblem("out:"+d.id, d.dn_display+": "+(e.message||e)); } });
    (pulled.incoming||[]).filter(d=>d.grv_terminal_id===me && d.grv_id).forEach(d=>{
      if(dsApplied(dsHex(d.grv_id)) || one("SELECT 1 AS x FROM dispatch_docs WHERE srv_grv_id=?",[d.grv_id])) return;
      const counts = {}, matches = {};
      let missing = "";
      (d.lines||[]).forEach(l=>{ counts[l.line_no] = { received:l.received||0, damaged:l.damaged||0, extra:l.extra||0 }; const p = dsFindProduct(l); if(p) matches[l.line_no] = p.id; else if((l.received||0)+(l.extra||0)>0) missing = l.name; });
      if(missing){ dsAddProblem("in:"+d.id, d.grv_display+": "+missing+" isn't in this branch, so the receipt can't be put back. Add the product, then Refresh."); return; }
      try{ dsApplyGrv(d, { grv_id:d.grv_id, grv_no:d.grv_no, grv_display:d.grv_display, by:d.grv_by, internal_ref:d.grv_internal_ref, counts, matches, status:d.status }); dsClearProblem("in:"+d.id); }
      catch(e){ dsAddProblem("in:"+d.id, d.grv_display+": "+(e.message||e)); }
    });
  }
  function dsBumpCounter(type, n){
    if(!(n>0)) return;
    run(`INSERT INTO doc_counters(branch_id,doc_type,last_no) VALUES(?,?,?) ON CONFLICT(branch_id,doc_type) DO UPDATE SET last_no=MAX(last_no,excluded.last_no)`,[getBranchId(), type, n]);
  }

  // ---- the pull: after a check-in, on reconnect, on Refresh ----
  let _dsPulling = null;
  function dsPull(){
    if(_dsPulling) return _dsPulling;
    _dsPulling = (async ()=>{
      if(!dsEnabled() || !isOnline()) return { ok:false, offline:!isOnline() };
      await dsSendPending();
      for(const p of dsPending("grv")) await dsDriveGrv(p);
      for(const p of dsPending("write_off")) await dsDriveWriteOff(p);
      const r = await terminalRpc("cl_device_dispatch_pull", terminalAuth(), { timeoutMs:20000 });
      if(!r.ok) return { ok:false, message:r.message||r.code||r.reason };
      const data = r.data;
      run("DELETE FROM srv_dispatches");
      (data.incoming||[]).forEach(d=>dsStore("in", d));
      (data.outgoing||[]).forEach(d=>dsStore("out", d));
      dsBumpCounter("DN", data.max_dn_no); dsBumpCounter("GRV", data.max_grv_no);
      dsReconcile(data);
      // received from the DN file before it showed up here: tell seiGEN (no stock moves)
      for(const d of (data.incoming||[]).filter(x=>x.status==="sent")){
        const rec = one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='in' AND status='received'",[dsLegacyFrom(d), d.dn_no]);
        if(rec) await dsPostViaFile(d, rec);
      }
      setSetting("ds_pulled_ts", new Date().toISOString());
      await persist();
      return { ok:true, waiting:dsIncomingWaiting().length, issues:dsOpenIssues().length };
    })().finally(()=>{ _dsPulling = null; });
    return _dsPulling;
  }
  function dsAfterCheckin(){
    if(!dsEnabled()) return Promise.resolve();
    const last = Date.parse(getSetting("ds_branches_ts","")) || 0;
    const br = Date.now()-last > 6*3600000? dsRefreshBranches().then(()=>setSetting("ds_branches_ts", new Date().toISOString())) : Promise.resolve();
    return br.then(()=>dsPull()).catch(()=>{});
  }
  if(typeof window!=="undefined" && window.addEventListener) window.addEventListener("online", ()=>{ if(dsEnabled()) dsPull().catch(()=>{}); });

  // ---- what the screens and reports read ----
  function dsIncomingWaiting(){
    const fromFile = (d)=> !!one("SELECT 1 AS x FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='in' AND status='received'",[dsLegacyFrom(d), d.dn_no]);
    return dsCached("in").filter(d=>d.status==="sent" && !fromFile(d));
  }
  // Differences still open on dispatches from this branch: [{ d, i, line, mine }]
  function dsOpenIssues(){
    const me = dsMyTerminal(), out = [];
    dsCached("out").forEach(d=>(d.issues||[]).forEach(i=>{ if(i.status==="open" || i.status==="disputed") out.push({ d, i, line:dsLine(d,i.line_no), mine:d.from_terminal_id===me }); }));
    return out;
  }
  function dsInTransit(){ return dsCached("out").filter(d=>d.status==="sent"); }
  const DS_STATUS_TEXT = { queued:"Waiting to send to seiGEN", sent:"Sent: waiting for the GRV", received:"Received in full", received_diff:"Received with differences", cancelled:"Cancelled", error:"Not sent through seiGEN" };
  function dsStatusText(s){ return DS_STATUS_TEXT[s] || s || ""; }
  const DS_ISSUE_TEXT = { short:"Short", damaged:"Damaged (the goods are at the receiver)", extra:"Extra" };
  // A DN file for a dispatch seiGEN already holds is refused. -> message or "".
  async function dsFileCheck(doc){
    if(!dsEnabled()) return "";
    let found = dsCached("in").find(d=> dsLegacyFrom(d)===doc.from.branch_id && d.dn_no===doc.dn_no);
    if(!found && isOnline()){
      const r = await terminalRpc("cl_device_dispatch_lookup", Object.assign(terminalAuth(), { p_dispatch_id:null, p_from_legacy_branch_id:doc.from.branch_id, p_dn_no:doc.dn_no }));
      if(r.ok && r.data && r.data.found) found = r.data;
    }
    if(!found) return "";
    if(found.status==="sent") return "This Delivery Note is waiting in seiGEN dispatches (Incoming). Receive it there, so it's counted once for the branch.";
    if(found.status==="cancelled") return "This Delivery Note was cancelled through seiGEN. Nothing can be received.";
    return "This Delivery Note already arrived through seiGEN ("+(found.grv_display||"received")+"). Nothing was added.";
  }

  // ---- screens ----
  function dsBadgeCount(){ return dsEnabled()? dsIncomingWaiting().length + dsOpenIssues().filter(x=>x.mine).length : 0; }
  function openSeigenDispatches(tab){
    const wrap = openModal("seiGEN dispatches", "");
    const body = wrap.querySelector(".modal-body");
    let cur = tab || "in", msg = "";
    const money = (n, c)=> (c? c+" " : "")+Number(n||0).toFixed(2);
    function head(){
      const t = [["in","Incoming ("+dsIncomingWaiting().length+")"],["out","Sent"],["issues","Differences ("+dsOpenIssues().length+")"],["transit","In transit"]];
      return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${t.map(x=>`<button class="btn btn-sm ${cur===x[0]?"btn-primary":"btn-outline"}" data-dstab="${x[0]}">${escapeHtml(x[1])}</button>`).join("")}
        <button class="btn btn-sm btn-ghost" id="dsRefresh">🔄 Refresh</button></div>
        <div class="muted" style="font-size:12px;margin-bottom:6px">${getSetting("ds_pulled_ts","")? "Last checked "+escapeHtml(new Date(getSetting("ds_pulled_ts")).toLocaleString()) : "Not checked yet"}</div>
        ${dsProblems().map(p=>`<div class="box" style="border-color:#b42318;color:#b42318;font-size:12.5px;margin-bottom:6px">${escapeHtml(p.text)}</div>`).join("")}
        ${msg? `<div class="box" id="dsMsg" style="margin-bottom:8px;font-size:12.5px">${escapeHtml(msg)}</div>` : ""}`;
    }
    function render_(){
      let html = head();
      if(cur==="in"){
        const w = dsIncomingWaiting(), done = dsCached("in").filter(d=>d.status!=="sent").slice(0,20);
        html += w.length? w.map(d=>`<div class="card" style="padding:10px;margin-bottom:8px"><div style="display:flex;justify-content:space-between"><b>${escapeHtml(d.dn_display)}</b><span class="muted">${escapeHtml(new Date(d.sent_at).toLocaleString())}</span></div>
            <div class="pmeta">From ${escapeHtml(d.from_branch)} · ${d.lines.length} line${d.lines.length===1?"":"s"} · ${d.lines.reduce((s,l)=>s+l.qty,0)} units${d.sent_by? " · by "+escapeHtml(d.sent_by) : ""}</div>
            <button class="btn btn-sm btn-primary" data-dsrecv="${d.id}" style="margin-top:6px">Count and receive</button></div>`).join("")
          : `<p class="muted">Nothing waiting for this branch.</p>`;
        if(done.length) html += `<h4 style="margin:12px 0 6px">Recent</h4>`+done.map(d=>`<div class="pmeta" style="margin-bottom:4px">${escapeHtml(d.dn_display)} from ${escapeHtml(d.from_branch)} · ${escapeHtml(dsStatusText(d.status))}${d.grv_display? " · "+escapeHtml(d.grv_display)+(d.grv_till? " on "+escapeHtml(d.grv_till) : "") : ""}</div>`).join("");
      } else if(cur==="out"){
        const rows = dsCached("out");
        html += rows.length? rows.map(d=>{
          const mine = d.from_terminal_id===dsMyTerminal();
          return `<div class="card" style="padding:10px;margin-bottom:8px"><div style="display:flex;justify-content:space-between"><b>${escapeHtml(d.dn_display)}</b><span style="font-size:12px;font-weight:700">${escapeHtml(dsStatusText(d.status))}</span></div>
            <div class="pmeta">To ${escapeHtml(d.to_branch)} · ${escapeHtml(new Date(d.sent_at).toLocaleString())} · till ${escapeHtml(d.from_till)}</div>
            ${d.grv_display? `<div class="pmeta">${escapeHtml(d.grv_display)} by ${escapeHtml(d.grv_by||"")}</div>` : ""}
            ${d.status==="cancelled"? `<div class="pmeta">Cancelled: ${escapeHtml(d.cancel_reason||"")}</div>` : ""}
            ${(d.lines||[]).map(l=>`<div class="pmeta">${escapeHtml(l.name)}: sent ${l.qty}${l.received!=null? " · received "+l.received+(l.short? " · short "+l.short : "")+(l.damaged? " · damaged "+l.damaged : "")+(l.extra? " · extra "+l.extra : "") : ""}</div>`).join("")}
            ${d.status==="sent" && mine? `<button class="btn btn-sm btn-outline" data-dscancel="${d.id}" style="margin-top:6px">Cancel…</button>` : ""}</div>`; }).join("")
          : `<p class="muted">No dispatches through seiGEN yet.</p>`;
      } else if(cur==="issues"){
        const rows = dsOpenIssues();
        html += rows.length? rows.map(x=>`<div class="card" style="padding:10px;margin-bottom:8px">
            <b>${escapeHtml(x.line? x.line.name : "")}</b> · ${escapeHtml(DS_ISSUE_TEXT[x.i.kind])} ${x.i.qty}${x.i.status==="disputed"? " · disputed" : ""}
            <div class="pmeta">${escapeHtml(x.d.dn_display)} to ${escapeHtml(x.d.to_branch)} · ${escapeHtml(x.d.grv_display||"")}${x.d.lines && x.line && x.line.note? " · “"+escapeHtml(x.line.note)+"”" : ""}</div>
            ${x.mine? (x.i.kind==="extra"
                ? `<div style="display:flex;gap:6px;margin-top:6px"><button class="btn btn-sm btn-primary" data-dsextra="${x.i.id}">Confirm the extra…</button>${x.i.status==="open"? `<button class="btn btn-sm btn-outline" data-dsdispute="${x.i.id}">Dispute…</button>` : ""}</div>`
                : `<div style="display:flex;gap:6px;margin-top:6px"><button class="btn btn-sm btn-outline" data-dswo="${x.i.id}">Write off…</button><button class="btn btn-sm btn-primary" data-dsredo="${x.i.id}">Re-dispatch ${x.i.qty}</button></div>`)
              : `<div class="pmeta">Resolve it on till ${escapeHtml(x.d.from_till)}, which dispatched it.</div>`}</div>`).join("")
          : `<p class="muted">No open differences.</p>`;
      } else {
        const rows = dsInTransit();
        let total = 0;
        html += rows.length? rows.map(d=>{
          const v = (d.lines||[]).reduce((s,l)=>s+(l.unit_cost==null? 0 : Number(l.unit_cost)*l.qty),0); total += v;
          return `<div class="card" style="padding:10px;margin-bottom:8px"><b>${escapeHtml(d.dn_display)}</b> to ${escapeHtml(d.to_branch)} · ${escapeHtml(new Date(d.sent_at).toLocaleDateString())}
            <div class="pmeta">${d.lines.reduce((s,l)=>s+l.qty,0)} units${dsShowCosts()? " · value at cost "+escapeHtml(money(v)) : ""}${Number(d.delivery_cost)>0 && dsShowCosts()? " · delivery "+escapeHtml(money(d.delivery_cost, d.delivery_currency)) : ""}</div></div>`; }).join("")
            + (dsShowCosts()? `<p><b>In transit (ours): ${escapeHtml(money(total))}</b> at cost</p>` : "")
          : `<p class="muted">Nothing in transit.</p>`;
      }
      body.innerHTML = html;
      body.querySelectorAll("[data-dstab]").forEach(b=>b.onclick=()=>{ cur = b.dataset.dstab; msg = ""; render_(); });
      body.querySelector("#dsRefresh").onclick=async ()=>{ msg = "Checking…"; render_(); const r = await dsPull(); msg = r.ok? "Up to date." : (r.offline? "You're offline." : "Couldn't check: "+(r.message||"")); render_(); };
      body.querySelectorAll("[data-dsrecv]").forEach(b=>b.onclick=()=>dsReceiveForm(wrap, body, b.dataset.dsrecv, ()=>{ cur = "in"; render_(); render(); }));
      body.querySelectorAll("[data-dscancel]").forEach(b=>b.onclick=()=>dsAskAdmin(body, "Cancel this dispatch? The stock comes back to this branch.", true, async (pass, reason)=>{ await dsCancel(b.dataset.dscancel, reason, pass); msg = "Cancelled. The stock is back."; }, render_));
      body.querySelectorAll("[data-dswo]").forEach(b=>b.onclick=()=>dsAskAdmin(body, "Write off this difference? It comes off this branch's stock with an ADJ number.", true, async (pass, reason)=>{ const r = await dsWriteOff(b.dataset.dswo, reason, pass); if(!r.ok) throw new Error(r.message); msg = "Written off as "+r.adj+"."; }, render_));
      body.querySelectorAll("[data-dsextra]").forEach(b=>b.onclick=()=>dsAskAdmin(body, "Confirm the extra? It really was sent, so it comes off this branch's stock.", false, async (pass)=>{ await dsResolveExtra(b.dataset.dsextra, "confirm", null, pass); msg = "Extra confirmed."; }, render_));
      body.querySelectorAll("[data-dsdispute]").forEach(b=>b.onclick=()=>{ const reason = prompt("Why do you dispute it?"); if(reason===null) return; dsResolveExtra(b.dataset.dsdispute, "dispute", reason).then(()=>{ msg = "Disputed: settle it with the other branch."; render_(); }, (e)=>{ msg = e.message||String(e); render_(); }); });
      body.querySelectorAll("[data-dsredo]").forEach(b=>b.onclick=async ()=>{ if(!confirm("Send it again as a new Delivery Note?")) return; try{ const dn = await dsRedispatch(b.dataset.dsredo); msg = "Re-dispatched as "+dn.text+"."; }catch(e){ msg = e.message||String(e); } render_(); render(); });
    }
    render_();
    dsPull().then(()=>{ if(document.body.contains(wrap)) render_(); }).catch(()=>{});
  }
  function dsAskAdmin(body, question, needsReason, action, back){
    body.innerHTML = `<p style="margin:0 0 8px;font-weight:700">${escapeHtml(question)}</p>
      ${needsReason? `<label>Reason</label><input class="field" id="dsReason" maxlength="200">` : ""}
      <label>Admin passcode</label><input class="field" id="dsPass" type="password" autocomplete="off">
      <div id="dsErr" style="color:#b42318;font-size:12.5px;margin-top:6px"></div>
      <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-outline" id="dsBack" style="flex:1">Back</button><button class="btn btn-primary" id="dsGo" style="flex:1">OK</button></div>`;
    body.querySelector("#dsBack").onclick=()=>back();
    let busy = false;
    body.querySelector("#dsGo").onclick=async ()=>{
      if(busy) return; busy = true;
      try{ await action(body.querySelector("#dsPass").value, needsReason? body.querySelector("#dsReason").value : ""); back(); render(); }
      catch(e){ busy = false; body.querySelector("#dsErr").textContent = e.message||String(e); }
    };
  }
  // Count each line: received / damaged / extra (short = the rest), pick or create missing products, post.
  function dsReceiveForm(wrap, body, id, done){
    const d = dsCachedOne(id);
    if(!d) return done();
    const counts = {}, matches = {};
    (d.lines||[]).forEach(l=>{ counts[l.line_no] = { received:l.qty, damaged:0, extra:0, note:"" }; const p = dsFindProduct(l); if(p) matches[l.line_no] = p.id; });
    const products = all("SELECT id,name,sku FROM products WHERE branch=? AND COALESCE(active,1)=1 ORDER BY name",[currentBranch()]);
    let busy = false;
    function draw(err){
      body.innerHTML = `<div class="box" style="margin-bottom:8px"><div style="font-size:15px;font-weight:700">${escapeHtml(d.dn_display)} from ${escapeHtml(d.from_branch)}</div>
          <div class="pmeta">Sent ${escapeHtml(new Date(d.sent_at).toLocaleString())}${d.sent_by? " by "+escapeHtml(d.sent_by) : ""}${d.internal_ref? " · their ref. "+escapeHtml(d.internal_ref) : ""}</div>
          ${Number(d.delivery_cost)>0 && dsShowCosts()? `<div class="pmeta">Delivery cost ${escapeHtml(d.delivery_currency+" "+Number(d.delivery_cost).toFixed(2))}${d.carrier? " · "+escapeHtml(d.carrier) : ""} (added to the cost of what you receive)</div>` : ""}</div>
        <p class="muted" style="font-size:12.5px;margin:0 0 6px">Count what arrived. Anything not counted as received or damaged is short. Extra = more than was sent.</p>
        <div style="max-height:46vh;overflow:auto">${(d.lines||[]).map(l=>{ const c = counts[l.line_no], m = matches[l.line_no];
          return `<div class="card" style="padding:8px;margin-bottom:6px"><b>${escapeHtml(l.name)}</b> <span class="muted">${escapeHtml(l.code||"no code")} · sent ${l.qty}${dsShowCosts() && l.unit_cost!=null? " · cost "+Number(l.unit_cost).toFixed(2) : ""}</span>
            ${m? "" : `<div style="color:#b42318;font-size:12.5px;margin:4px 0">Not in this branch's products.</div>
              <select class="field" data-dspick="${l.line_no}"><option value="">Choose the product…</option>${products.map(p=>`<option value="${p.id}">${escapeHtml((p.sku? p.sku+" — " : "")+p.name)}</option>`).join("")}</select>
              <button class="btn btn-sm btn-outline" data-dsnew="${l.line_no}" style="margin-top:4px">Create it (Admin passcode)…</button>`}
            <div style="display:flex;gap:6px;margin-top:6px">
              <label style="flex:1;margin:0;font-size:12px">Received<input class="field" data-dsc="${l.line_no}:received" inputmode="numeric" value="${c.received}"></label>
              <label style="flex:1;margin:0;font-size:12px">Damaged<input class="field" data-dsc="${l.line_no}:damaged" inputmode="numeric" value="${c.damaged}"></label>
              <label style="flex:1;margin:0;font-size:12px">Extra<input class="field" data-dsc="${l.line_no}:extra" inputmode="numeric" value="${c.extra}"></label></div>
            <input class="field" data-dsnote="${l.line_no}" placeholder="Note (optional)" value="${escapeHtml(c.note)}" style="margin-top:4px"></div>`; }).join("")}</div>
        <label>Internal ref. (optional)</label><input class="field" id="dsRef" maxlength="${INTERNAL_REF_MAX}" autocomplete="off">
        <div id="dsErr" style="color:#b42318;font-size:12.5px;margin-top:6px">${escapeHtml(err||"")}</div>
        <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-outline" id="dsBack" style="flex:1">Back</button><button class="btn btn-primary" id="dsPost" style="flex:1">Receive</button></div>`;
      body.querySelectorAll("[data-dsc]").forEach(inp=>inp.oninput=()=>{ const [n,k] = inp.dataset.dsc.split(":"); const v = inp.value.trim(); counts[+n][k] = /^\d+$/.test(v)? +v : NaN; });
      body.querySelectorAll("[data-dsnote]").forEach(inp=>inp.oninput=()=>{ counts[+inp.dataset.dsnote].note = inp.value; });
      body.querySelectorAll("[data-dspick]").forEach(s=>s.onchange=()=>{ if(s.value){ matches[+s.dataset.dspick] = +s.value; draw(); } });
      body.querySelectorAll("[data-dsnew]").forEach(b=>b.onclick=()=>{
        const l = dsLine(d, +b.dataset.dsnew);
        const price = prompt("Selling price for "+l.name+" in this branch?", ""); if(price===null) return;
        const pass = prompt("Admin passcode"); if(pass===null) return;
        try{ matches[l.line_no] = dsCreateProduct(l, price, pass); persist(); draw(); }catch(e){ draw(e.message||String(e)); }
      });
      body.querySelector("#dsBack").onclick=()=>done();
      body.querySelector("#dsPost").onclick=async ()=>{
        if(busy) return; busy = true;
        const btn = body.querySelector("#dsPost"); btn.disabled = true; btn.textContent = "Receiving…";
        let r;
        try{ r = await dsPostGrv(d.id, counts, matches, { internalRef:body.querySelector("#dsRef").value }); }
        catch(e){ busy = false; return draw(e.message||String(e)); }
        busy = false;
        if(!r.ok) return draw(r.message);
        body.innerHTML = `<div class="box" style="text-align:center"><p style="font-size:16px;font-weight:700;margin:0 0 4px">${escapeHtml(r.grv_display)}: stock received</p>
          <p class="muted" style="margin:0">${escapeHtml(dsStatusText(r.status))}. ${escapeHtml(d.from_branch)} sees it at its next check.</p></div>
          <button class="btn btn-primary" id="dsDone" style="margin-top:10px;width:100%">Done</button>`;
        body.querySelector("#dsDone").onclick=()=>done();
      };
    }
    draw();
  }
  // A product missing at the receiver, from the dispatch line (narrow exception, Admin passcode).
  function dsCreateProduct(l, price, passcode){
    const admin = dsNeedAdmin(passcode);
    const pr = Number(String(price).trim());
    if(!(pr>=0) || String(price).trim()==="") throw new Error("Enter the selling price (0 or more).");
    if(l.code && all("SELECT 1 AS x FROM products WHERE branch=? AND lower(trim(sku))=lower(trim(?))",[currentBranch(), l.code]).length)
      throw new Error("A product with the code "+l.code+" exists already: choose it from the list.");
    const ts = new Date().toISOString();
    run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description,cat_uid) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [l.name, pr, 0, 5, l.code||"", currentBranch(), "", l.unit_cost==null? 0 : Number(l.unit_cost), ts, "", l.cat_uid||null]);
    const id = one("SELECT last_insert_rowid() AS id").id;
    logAudit("Add Product (receiving)", l.name, "Created while receiving a seiGEN dispatch (authorised by "+admin.name+")");
    return id;
  }
