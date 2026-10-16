  // ================== Branch views (Branches step 2, app v27) ==================
  // docs/branches/multi-branch-visibility-design.md, addendum §R3 and §R4;
  // server side: supabase/migrations/20261106120000_branch_views.sql.
  //   * The DN card: one Delivery Note's whole record from seiGEN (header,
  //     transport, every line, the differences and how each was settled, the
  //     linked DNs and GRV, the history), with Print / PDF and, for a DN this
  //     till sent, Share file. Stock by branch → Dispatches and the seiGEN
  //     dispatches lists open it.
  //   * The item ledger: one product's movements. This till's own (the
  //     stock_movements ledger, with the running balance) and, from seiGEN,
  //     the other tills and branches: dispatches, GRVs, differences, supplier
  //     GRVs (their sales and adjustments come with B4 / B5). Products and
  //     the Product List open it.
  //   * Report Writer at remote branches: this branch's own reports, plus
  //     every branch's stock (quantities), the view everyone may see.
  // Double-click opens a record in the Windows program; a single tap on a phone.
  // Reads only. Quantities only: no cost travels here (costs by person come
  // with the Roles step).

  function bvDesktop(){ return typeof isDesktopBuild==="function" && isDesktopBuild(); }
  // el opens fn: a double-click (Windows program) or a tap (phone).
  function bvOnOpen(el, fn){
    el.style.cursor = "pointer";
    if(bvDesktop()){ el.ondblclick = fn; if(!el.title) el.title = "Double-click for the full record"; }
    else el.onclick = fn;
  }
  function bvWhen(ts){ return ts? new Date(ts).toLocaleString() : ""; }
  // A refusal in plain words; a server without 20261106120000 doesn't have the reader yet.
  function bvProblem(r){
    const m = (r && ((r.data && r.data.message) || r.message || r.code || r.reason)) || "";
    if(/could not find the function|PGRST202/i.test(m)) return "Not on seiGEN yet: it comes with the seiGEN update.";
    if(r && (r.reason==="offline" || r.reason==="network")) return "You're offline.";
    return m || "Couldn't reach seiGEN.";
  }

  // ---- the DN card ----
  const BV_ACTION_LABEL = { sent:"Sent", received:"Received", cancelled:"Cancelled", issue_written_off:"Difference written off",
    issue_redispatched:"Difference re-dispatched", issue_confirmed:"Extra confirmed", issue_disputed:"Extra disputed",
    issue_reopened:"Difference open again (its re-dispatch was cancelled)" };
  const BV_ISSUE_TEXT = { short:"short", damaged:"damaged", extra:"extra" };
  const BV_ISSUE_STATUS = { open:"open", written_off:"written off", redispatched:"re-dispatched", confirmed:"confirmed", disputed:"disputed" };
  async function bvFetchDnCard(id){
    if(!(typeof bsRegistered==="function" && bsRegistered())) return { ok:false, message:"This till isn't registered with seiGEN." };
    if(!isOnline()) return { ok:false, offline:true, message:"You're offline." };
    const r = await terminalRpc("cl_device_dispatch_card", Object.assign(terminalAuth(), { p_dispatch_id:id }), { timeoutMs:20000 });
    if(!r.ok) return { ok:false, message:bvProblem(r) };
    return { ok:true, card:r.data };
  }
  // What this till already holds for a DN (offline, or before the update): the business list or its own seiGEN lists.
  function bvLocalDn(id){
    const d = (typeof bsDispatches==="function"? bsDispatches() : []).find(x=>x.id===id) || (typeof dsCachedOne==="function"? dsCachedOne(id) : null);
    if(!d) return null;
    return { id:d.id, dn_display:d.dn_display, status:d.status, from_branch:d.from_branch, to_branch:d.to_branch, from_till:d.from_till,
      sent_by:d.sent_by, sent_at:d.sent_at, internal_ref:d.internal_ref, received_at:d.received_at, grv_display:d.grv_display, grv_till:d.grv_till,
      grv_by:d.grv_by, grv_internal_ref:d.grv_internal_ref, cancelled_at:d.cancelled_at, cancelled_by:d.cancelled_by, cancel_reason:d.cancel_reason,
      transport: d.delivery_cost!=null? { cost:d.delivery_cost, currency:d.delivery_currency, carrier:d.carrier, ref:d.delivery_ref, paid_by:"receiving" } : null,
      lines:(d.lines||[]).map(l=>({ line_no:l.line_no, code:l.code, name:l.name, qty:l.qty, received:l.received, damaged:l.damaged, short:l.short, extra:l.extra, note:l.note })),
      issues:null, history:null, mine: typeof dsMyTerminal==="function" && d.from_terminal_id===dsMyTerminal() };
  }
  function bvTransportText(t){
    if(!t || !(Number(t.cost)>0)) return "None";
    return [(t.currency? t.currency+" " : "")+Number(t.cost).toFixed(2), t.carrier, t.ref? "ref. "+t.ref : "", "paid by the receiving branch"].filter(Boolean).join(" · ");
  }
  function bvIssueText(i){
    const head = (i.name? i.name+": " : "")+(BV_ISSUE_TEXT[i.kind]||i.kind)+" "+i.qty+" · "+(BV_ISSUE_STATUS[i.status]||i.status);
    const how = [i.adj_display? "as "+i.adj_display : "", i.redispatch? "as "+i.redispatch.dn_display+" ("+(typeof dsStatusText==="function"? dsStatusText(i.redispatch.status) : i.redispatch.status)+")" : "",
      i.resolved_by? "by "+i.resolved_by+(i.resolved_till? " ("+i.resolved_till+")" : "") : "", i.resolved_at? bvWhen(i.resolved_at) : "", i.note? "“"+i.note+"”" : ""].filter(Boolean).join(" · ");
    return head+(how? " · "+how : "");
  }
  // Header and lines as label/value pairs and table rows (the screen and Print share them).
  function bvDnHeaderPairs(c){
    const st = typeof dsStatusText==="function"? dsStatusText(c.status) : c.status;
    return [["Delivery Note", c.dn_display], ["Status", st], ["From", (c.from_branch||"")+(c.from_till? " ("+c.from_till+")" : "")], ["To", c.to_branch],
      ["Created by", c.sent_by], ["Sent", bvWhen(c.sent_at)], ["Internal ref.", c.internal_ref],
      ["Received", c.received_at? bvWhen(c.received_at) : ""], ["GRV", c.grv_display? c.grv_display+(c.grv_till? " ("+c.grv_till+")" : "")+(c.grv_by? " by "+c.grv_by : "") : ""],
      ["GRV internal ref.", c.grv_internal_ref], ["GRV note", c.grv_note],
      ["Cancelled", c.cancelled_at? bvWhen(c.cancelled_at)+(c.cancelled_by? " by "+c.cancelled_by : "")+(c.cancel_reason? ": "+c.cancel_reason : "") : ""],
      ["Transport", c.transport? bvTransportText(c.transport) : ""]].filter(p=> p[1]!=null && p[1]!=="");
  }
  function bvDnLineRows(c){
    const n = (v)=> v==null? "" : String(v);
    return (c.lines||[]).map(l=>[escapeHtml((l.code? l.code+" · " : "")+l.name), n(l.qty), n(l.received), n(l.short||(l.received!=null? 0 : "")), n(l.damaged||(l.received!=null? 0 : "")), n(l.extra||(l.received!=null? 0 : "")), escapeHtml(l.note||"")]);
  }
  const BV_LINE_HEADS = ["Item","Sent","Received","Short","Damaged","Extra","Note"];
  function bvHistoryText(h){
    const who = [h.by, h.till? h.till+(h.branch? " at "+h.branch : "") : h.branch].filter(Boolean).join(", ");
    const det = [h.kind? (BV_ISSUE_TEXT[h.kind]||h.kind)+(h.qty!=null? " "+h.qty : "") : "", h.adj? h.adj : "", h.reason? "“"+h.reason+"”" : "",
      h.action==="received" && h.status==="received_diff"? "with differences" : ""].filter(Boolean).join(" · ");
    return bvWhen(h.at)+" · "+(BV_ACTION_LABEL[h.action]||h.action)+(who? " · "+who : "")+(det? " · "+det : "");
  }
  function bvDnCardHtml(c, note){
    const pairs = bvDnHeaderPairs(c).map(p=>`<tr><th style="text-align:left;white-space:nowrap">${escapeHtml(p[0])}</th><td>${escapeHtml(p[1])}</td></tr>`).join("");
    const lines = bvDnLineRows(c).map(r=>`<tr>${r.map(x=>`<td>${x}</td>`).join("")}</tr>`).join("");
    const issues = c.issues==null? "" : (c.issues.length? c.issues.map(i=>`<div class="pmeta bv-issue">${escapeHtml(bvIssueText(i))}${i.redispatch? ` <button type="button" class="btn btn-sm btn-ghost" data-bvdn="${escapeHtml(i.redispatch.id)}">Open ${escapeHtml(i.redispatch.dn_display)}</button>` : ""}</div>`).join("") : `<div class="pmeta">None.</div>`);
    const rep = c.replaces? `<div class="pmeta bv-replaces">Re-dispatch of the ${escapeHtml((BV_ISSUE_TEXT[c.replaces.kind]||c.replaces.kind)+" "+c.replaces.qty+" "+(c.replaces.name||""))} on ${escapeHtml(c.replaces.dn_display)} <button type="button" class="btn btn-sm btn-ghost" data-bvdn="${escapeHtml(c.replaces.id)}">Open it</button></div>` : "";
    const hist = c.history==null? "" : (c.history.length? c.history.map(h=>`<div class="pmeta bv-hist">${escapeHtml(bvHistoryText(h))}</div>`).join("") : `<div class="pmeta">No history on seiGEN.</div>`);
    return `${note? `<div class="box bv-note" style="font-size:12.5px;margin-bottom:8px;color:#b54708">${escapeHtml(note)}</div>` : ""}
      <table class="simple bv-head">${pairs}</table>
      <h4 style="margin:12px 0 6px">Lines</h4>
      <div style="overflow-x:auto"><table class="simple bv-lines"><tr>${BV_LINE_HEADS.map(h=>`<th>${h}</th>`).join("")}</tr>${lines}</table></div>
      ${rep? `<h4 style="margin:12px 0 6px">Linked</h4>${rep}` : ""}
      ${c.issues!=null? `<h4 style="margin:12px 0 6px">Differences</h4>${issues}` : ""}
      ${c.history!=null? `<h4 style="margin:12px 0 6px">History</h4>${hist}` : ""}
      <p class="muted" style="font-size:12px;margin-top:8px">Quantities only.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-outline btn-sm" id="bvPrint">🖨️ Print / PDF</button>
        ${bvShareRecord(c)? `<button class="btn btn-outline btn-sm" id="bvShare">${escapeHtml(typeof dnShareLabel==="function"? dnShareLabel() : "Share file")}</button>` : ""}
      </div><div class="muted" id="bvShareMsg" style="font-size:12.5px;margin-top:6px"></div>`;
  }
  // The DN file this till sent (its own dispatch_docs row): shared as the real DN file.
  function bvShareRecord(c){
    if(!c || !c.mine || !c.id) return null;
    try{ return one("SELECT * FROM dispatch_docs WHERE srv_id=? AND direction='out'",[c.id]) || null; }catch(e){ return null; }
  }
  function bvPrintDnCard(c){
    const head = bvDnHeaderPairs(c).map(p=>`<div><b>${escapeHtml(p[0])}:</b> ${escapeHtml(p[1])}</div>`).join("");
    const extra = (c.issues&&c.issues.length? `<h3>Differences</h3>`+c.issues.map(i=>`<div>${escapeHtml(bvIssueText(i))}</div>`).join("") : "")
      + (c.history&&c.history.length? `<h3>History</h3>`+c.history.map(h=>`<div>${escapeHtml(bvHistoryText(h))}</div>`).join("") : "");
    printReport("Delivery Note "+c.dn_display, (c.from_branch||"")+" → "+(c.to_branch||""), BV_LINE_HEADS, bvDnLineRows(c), `<div style="margin-top:8px">${head}</div>${extra}`);
  }
  // The DN's costs (View costs): each line's unit cost and value, and the inter-branch charge.
  function bvCostsHtml(card, c){
    const by = new Map((c.lines||[]).map(l=>[l.line_no, Number(l.unit_cost)]));
    const rows = (card.lines||[]).map(l=>{ const u = by.get(l.line_no); return [escapeHtml(l.name), u>0? currency+u.toFixed(2) : "—", u>0? currency+(u*l.qty).toFixed(2) : "—"]; });
    const total = (card.lines||[]).reduce((s,l)=> s+(by.get(l.line_no)||0)*l.qty, 0);
    return `<div class="bv-costs"><h4 style="margin:12px 0 6px">Costs</h4>
      <table class="simple"><tr><th>Item</th><th>Unit cost</th><th>Value</th></tr>${rows.map(r=>`<tr>${r.map(x=>`<td>${x}</td>`).join("")}</tr>`).join("")}</table>
      <div class="pmeta">Value sent at cost ${escapeHtml(currency+total.toFixed(2))}${c.charge? " · inter-branch charge "+escapeHtml((c.charge.currency? c.charge.currency+" " : "")+Number(c.charge.amount).toFixed(2)) : ""} (View costs)</div></div>`;
  }
  // id: the dispatch's seiGEN id. Opens at once with what this till holds, then the full card from seiGEN.
  function openDnCard(id){
    const local = bvLocalDn(id);
    const wrap = openModal("Delivery Note "+(local? local.dn_display : ""), `<p class="muted" id="bvLoading">Loading from seiGEN…</p>`);
    const body = wrap.querySelector(".modal-body");
    const show = (c, note)=>{
      body.innerHTML = bvDnCardHtml(c, note);
      const h3 = wrap.querySelector(".modal-head h3"); if(h3) h3.textContent = "Delivery Note "+(c.dn_display||"");
      body.querySelector("#bvPrint").onclick = ()=> bvPrintDnCard(c);
      const sh = body.querySelector("#bvShare");
      if(sh) sh.onclick = async ()=>{
        const h = bvShareRecord(c), msg = body.querySelector("#bvShareMsg");
        try{ const r = await dnShareRecord(h, await dnGetRecord(h)); msg.textContent = typeof dnShareMessage==="function"? dnShareMessage(r) : ""; }
        catch(e){ msg.textContent = "Couldn't share: "+(e.message||e); }
      };
      body.querySelectorAll("[data-bvdn]").forEach(b=> b.onclick = ()=> openDnCard(b.dataset.bvdn));
    };
    if(local) show(local, "Loading the full card from seiGEN…");
    bvFetchDnCard(id).then(r=>{
      if(!wrap.isConnected && typeof wrap.isConnected!=="undefined") return;
      if(r.ok){
        show(r.card, "");
        // Roles (v28, Q7): unit costs for a signed-in person with View costs, from seiGEN for this view only
        if(typeof staffDispatchCosts==="function") staffDispatchCosts(id).then(c=>{ if(c && c.lines && wrap.isConnected!==false) body.insertAdjacentHTML("beforeend", bvCostsHtml(r.card, c)); }).catch(()=>{});
      }
      else if(local) show(local, r.message+" Showing what this till holds: the differences and the history need seiGEN.");
      else body.innerHTML = `<p class="muted">${escapeHtml(r.message)}</p>`;
    }, (e)=>{ if(!local) body.innerHTML = `<p class="muted">${escapeHtml(e.message||String(e))}</p>`; });
    return wrap;
  }

  // ---- the item ledger ----
  const BV_KIND_LABEL = { dispatch_out:"Dispatched", dispatch_cancel:"Dispatch cancelled (back in)", dispatch_return:"Difference back (short or damaged)",
    write_off:"Written off", dispatch_extra:"Extra confirmed (out)", receive:"Received (GRV)", supplier_grv:"Supplier GRV" };
  async function bvFetchLedger(probe, fromTs, toTs){
    if(!(typeof bsRegistered==="function" && bsRegistered())) return { ok:false, message:"This till isn't registered with seiGEN, so only its own movements show." };
    if(!isOnline()) return { ok:false, offline:true, message:"You're offline: only this till's own movements show." };
    const r = await terminalRpc("cl_device_item_ledger", Object.assign(terminalAuth(), { p_cat_uid:probe.cat_uid||null, p_code:String(probe.sku||probe.code||"").trim()||null,
      p_name:String(probe.name||"").trim()||null, p_from:fromTs||null, p_to:(toTs && toTs!=="9999")? toTs : null }), { timeoutMs:20000 });
    if(!r.ok) return { ok:false, message:bvProblem(r) };
    return { ok:true, rows:(r.data && r.data.rows)||[] };
  }
  function bvKindText(m){
    const other = m.other_branch && m.kind!=="supplier_grv"? (m.kind==="receive"? " from " : m.kind==="dispatch_out"? " to " : " · ")+m.other_branch : "";
    return (BV_KIND_LABEL[m.kind]||m.kind)+other;
  }
  function bvServerRowsHtml(rows, empty){
    if(!rows.length) return `<p class="muted" style="font-size:12.5px">${escapeHtml(empty)}</p>`;
    return `<div style="overflow-x:auto"><table class="simple bv-srv"><tr><th>Date/Time</th><th>Movement</th><th>Document</th><th>Till</th><th>In</th><th>Out</th><th>By</th><th>Note</th></tr>
      ${rows.map(m=>`<tr><td>${escapeHtml(bvWhen(m.at))}</td><td>${escapeHtml(bvKindText(m))}</td>
        <td>${m.dispatch_id? `<button type="button" class="btn btn-sm btn-ghost" data-bvdn="${escapeHtml(m.dispatch_id)}">${escapeHtml(m.doc||"")}</button>` : escapeHtml(m.doc||"")}</td>
        <td>${escapeHtml(m.till||"")}</td><td>${m.qty_in? "+"+m.qty_in : ""}</td><td>${m.qty_out? "-"+m.qty_out : ""}</td><td>${escapeHtml(m.by||"")}</td><td>${escapeHtml(m.note||"")}</td></tr>`).join("")}
    </table></div>`;
  }
  function bvLocalLedgerHtml(d){
    if(!d) return `<p class="muted" style="font-size:12.5px">This till doesn't have this product.</p>`;
    const rows = d.rows.slice().reverse();
    return `<div class="pmeta bv-local-sum">Opening ${d.opening} · in +${d.inQ} · out -${d.outQ} · closing <b>${d.closing}</b></div>
      ${rows.length? `<div style="overflow-x:auto"><table class="simple bv-local"><tr><th>Date/Time</th><th>Movement</th><th>Document</th><th>In</th><th>Out</th><th>Balance</th><th>By</th><th>Note</th></tr>
      ${rows.map(m=>`<tr><td>${escapeHtml(bvWhen(m.ts))}</td><td>${escapeHtml((typeof LEDGER_KIND_LABEL!=="undefined" && LEDGER_KIND_LABEL[m.kind])||BV_KIND_LABEL[m.kind]||m.kind)}</td><td>${escapeHtml(m.doc_no||"")}</td>
        <td>${m.qty_delta>0? "+"+m.qty_delta : ""}</td><td>${m.qty_delta<0? String(m.qty_delta) : ""}</td><td>${m.balance}</td><td>${escapeHtml(m.user||"")}</td><td>${escapeHtml(m.note||"")}</td></tr>`).join("")}
      </table></div>` : `<p class="muted" style="font-size:12.5px">No movements on this till in these dates.</p>`}`;
  }
  // p: this till's product row, or a probe { cat_uid, sku, name } (the Product List, Stock by branch).
  function openItemLedger(p){
    const local = (p && p.id!=null && p.branch!=null && sameBranchName(p.branch, currentBranch()))? p : (typeof bsLocalMatch==="function"? bsLocalMatch(p) : null);
    const probe = { cat_uid:(local && local.cat_uid) || p.cat_uid || null, sku:(local && local.sku) || p.sku || p.code || "", name:(local && local.name) || p.name || "" };
    const reg = typeof bsRegistered==="function" && bsRegistered();
    const brs = reg? bsBranches() : [], me = reg? bsMyBranchUuid() : "";
    const today = businessDateOf();
    let sel = getSetting("bv_ledger_branch","mine"), from = localDateStr(new Date(Date.now() - 30*86400000)), to = today, srv = null, srvKey = "";
    if(sel!=="mine" && sel!=="all" && !brs.some(b=>b.id===sel)) sel = "mine";
    const wrap = openModal("Item ledger: "+probe.name, "");
    const body = wrap.querySelector(".modal-body");
    const figure = (b)=>{ const q = typeof bsBranchQty==="function"? bsBranchQty(b, local || probe) : null; return q? String(q.qty) : "—"; };
    function sectionFor(b){
      const rows = srv && srv.ok? srv.rows.filter(m=> m.branch_id===b.id && !(b.id===me && m.mine)) : [];
      const u = bsUpdatedText(b.updated_at);
      const head = `<h4 style="margin:12px 0 4px">${escapeHtml(b.name)}${b.id===me? " (this branch): the other tills" : ""}</h4>
        ${b.id===me? "" : `<div class="pmeta bv-now">Now: <b>${escapeHtml(figure(b))}</b> <span style="${u.old? "color:#b54708" : ""}">(${escapeHtml(u.text)})</span></div>`}`;
      const srvPart = !srv? `<p class="muted" style="font-size:12.5px">Loading from seiGEN…</p>` : !srv.ok? `<p class="muted" style="font-size:12.5px">${escapeHtml(srv.message)}</p>`
        : bvServerRowsHtml(rows, b.id===me? "No dispatches or GRVs on the other tills in these dates." : "No dispatches or GRVs in these dates.");
      return head + srvPart + `<p class="muted bv-partial" style="font-size:12px;color:#667085">Sales and adjustments ${b.id===me? "on the other tills" : "at "+escapeHtml(b.name)} are not on seiGEN yet (after the update), so there is no running balance here.</p>`;
    }
    function draw(){
      const { fromTs, toTs } = businessRange(from, to);
      const mine = local? itemLedgerData(local.id, fromTs, toTs) : null;
      const opts = [["mine", "This branch"+(brs.length? "" : " (this till)")]].concat(brs.filter(b=>b.id!==me).map(b=>[b.id, b.name])).concat(brs.length>1? [["all","All branches"]] : []);
      const myB = brs.find(b=>b.id===me);
      const others = brs.filter(b=>b.id!==me);
      let html = `<div class="pmeta">${probe.sku? escapeHtml(probe.sku)+" · " : ""}${escapeHtml(probe.name)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
          <select class="field" id="bvlBranch" style="flex:2;min-width:140px;margin:0">${opts.map(o=>`<option value="${escapeHtml(o[0])}" ${o[0]===sel? "selected" : ""}>${escapeHtml(o[1])}</option>`).join("")}</select>
          <input class="field" type="date" id="bvlFrom" value="${escapeHtml(from)}" style="flex:1;min-width:120px;margin:0">
          <input class="field" type="date" id="bvlTo" value="${escapeHtml(to)}" style="flex:1;min-width:120px;margin:0">
        </div>`;
      if(sel==="mine" || sel==="all"){
        html += `<h4 style="margin:8px 0 4px">${escapeHtml(currentBranch())}: this till</h4>${bvLocalLedgerHtml(mine)}`;
        if(myB && (Number(myB.active_tills)||0)>1) html += sectionFor(myB);
      }
      if(sel==="all") others.forEach(b=>{ html += sectionFor(b); });
      else if(sel!=="mine"){ const b = brs.find(x=>x.id===sel); if(b) html += sectionFor(b); }
      if(!reg) html += `<p class="muted" style="font-size:12px">This till isn't on seiGEN, so only its own movements show.</p>`;
      html += `<p class="muted" style="font-size:12px">Quantities only.</p>`;
      body.innerHTML = html;
      body.querySelector("#bvlBranch").onchange = (e)=>{ sel = e.target.value; setSetting("bv_ledger_branch", sel); load(); };
      body.querySelector("#bvlFrom").onchange = (e)=>{ from = e.target.value; load(); };
      body.querySelector("#bvlTo").onchange = (e)=>{ to = e.target.value; load(); };
      body.querySelectorAll("[data-bvdn]").forEach(b=> b.onclick = ()=> openDnCard(b.dataset.bvdn));
    }
    // seiGEN's rows for every branch at once (one call per date range); then the choice only filters.
    function load(){
      const need = reg && (sel!=="mine" || brs.some(b=> b.id===me && (Number(b.active_tills)||0)>1));
      const key = from+"|"+to;
      if(need && srvKey!==key){
        srvKey = key; srv = null;
        const { fromTs, toTs } = businessRange(from, to);
        bvFetchLedger(probe, fromTs, toTs).then(r=>{ if(srvKey===key){ srv = r; draw(); } }, (e)=>{ if(srvKey===key){ srv = { ok:false, message:e.message||String(e) }; draw(); } });
      }
      draw();
    }
    load();
    wrap._bvState = ()=>({ sel, from, to, srv });
    return wrap;
  }
  // Products, the Product List and Stock by branch: the name opens the item ledger.
  function wireItemLedgerOpeners(scope, rowOf){
    scope.querySelectorAll("[data-bvledger]").forEach(el=> bvOnOpen(el, ()=>{ const p = rowOf(el.dataset.bvledger); if(p) openItemLedger(p); }));
  }

  // ---- Report Writer: every branch's stock, quantities only (§R4: the view everyone may see) ----
  function bvBranchStockReport(){
    const brs = typeof bsRegistered==="function" && bsRegistered()? bsBranches() : [];
    if(!brs.length) return { headers:["Item","Stock"], rows:[], footer:"No figures from seiGEN yet. They arrive after the tills check in (a business with 2 or more tills)." };
    const view = bsProductListView("", "");
    const rows = (view? view.rows : []).map(r=>{
      const cells = brs.map(b=>{ const q = bsBranchQty(b, r.probe); return q? String(q.qty) : "—"; });
      return [skuNameCell(r.sku, r.name)].concat(cells, [r.stock==null? "—" : String(r.stock)]);
    });
    const times = brs.map(b=> b.name+": "+(b.id===bsMyBranchUuid()? "this till now, the other tills "+bsUpdatedText(b.updated_at).text : bsUpdatedText(b.updated_at).text)).join(" · ");
    return { headers:["Item"].concat(brs.map(b=>b.name), ["All branches"]), rows, footer:"Quantities only. "+times };
  }
