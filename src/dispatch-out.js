  // ---------------- Dispatch (sending side): screen, voucher, history (Phase 2) ----------------
  // Replaces the old dispatchStockModal entry point. Receiving / GRV is
  // Phase 3 — the old receiveTransfer/receiveStockModal path stays as-is and
  // never sees lines that carry a dn_no.

  // ---- destination register ----
  // Main maintains it in Settings; it reaches Remote devices through the
  // normal merge (backup.js). This device's own branch is never a destination.
  function ensureSelfInRegister(){
    if(isRemote() || getSetting("setup_complete")!=="1") return;
    const me = currentBranch();
    if(!one("SELECT id FROM branch_register WHERE name=?",[me]))
      run("INSERT INTO branch_register(name,whatsapp) VALUES(?,?)",[me,getSetting("contact_phone","")]);
  }
  function branchDestinations(){
    ensureSelfInRegister();
    const me = currentBranch().toLowerCase();
    return all("SELECT * FROM branch_register ORDER BY name").filter(b=>b.name.toLowerCase()!==me);
  }
  function branchRegisterCardHtml(){
    ensureSelfInRegister();
    const rows = all("SELECT * FROM branch_register ORDER BY name");
    return `
      <div class="card">
        <h3>Destination branches</h3>
        <p class="muted">The branches stock can be dispatched to, and how prices work for each. The WhatsApp number is optional — when set, it's used to open the right chat after a dispatch on desktop. Remote branches receive this list with their catalogue (Build catalogue).</p>
        ${rows.map(b=>`
          <div class="product-row" style="align-items:flex-start">
            <div style="flex:1;min-width:0"><div class="pname">${escapeHtml(b.name)}</div><div class="pmeta">${escapeHtml(b.whatsapp||"no WhatsApp number")}</div>
              ${sameBranchName(b.name, currentBranch())? "" : catalogueRegisterExtras(b)}</div>
            <div style="display:flex;flex-direction:column;gap:4px;flex:none">
              ${sameBranchName(b.name, currentBranch())? "" : (destinationLock(b.name)
                ? `<span class="pmeta" style="max-width:150px;text-align:right">Name locked: ${destinationLock(b.name).by==="catalogue"? "a catalogue has been generated for it" : "a Delivery Note has been sent to it"}</span>`
                : `<button class="btn btn-sm btn-outline" data-reg-rename="${b.id}">Rename</button>`)}
              <button class="btn btn-sm btn-outline" data-reg-del="${b.id}">Remove</button>
            </div>
          </div>`).join("") || `<p class="muted">No branches yet.</p>`}
        <label>Branch name</label><input class="field" id="regName" placeholder="e.g. Boka">
        <label>WhatsApp number (optional)</label><input class="field" id="regWa" inputmode="tel" placeholder="e.g. 0771234567">
        <button class="btn btn-outline" id="regAdd" style="margin-top:10px">Add / update branch</button>
      </div>`;
  }
  function wireBranchRegisterCard(){
    const add = document.getElementById("regAdd");
    if(!add) return;
    wireCatalogueRegisterExtras();
    add.onclick=()=>{
      const name = document.getElementById("regName").value.trim();
      const wa = document.getElementById("regWa").value.trim();
      if(!name) return alert("Enter the branch name");
      const ex = one("SELECT id FROM branch_register WHERE name=?",[name]);
      if(ex) run("UPDATE branch_register SET whatsapp=? WHERE id=?",[wa,ex.id]);
      else run("INSERT INTO branch_register(name,whatsapp) VALUES(?,?)",[name,wa]);
      persist(); render();
    };
    document.querySelectorAll("[data-reg-rename]").forEach(btn=>{
      btn.onclick=async ()=>{
        const row = one("SELECT name FROM branch_register WHERE id=?",[+btn.dataset.regRename]);
        const nn = prompt("New name for \""+(row?row.name:"")+"\"? It can be changed only until the first Delivery Note is dispatched to it.", row?row.name:"");
        if(nn===null) return;
        try{ renameRegisterBranch(+btn.dataset.regRename, nn); }catch(e){ alert(e.message||String(e)); return; }
        try{ await persist(); }catch(e){}
        render();
      };
    });
    document.querySelectorAll("[data-reg-del]").forEach(b=>{
      b.onclick=()=>{
        if(!confirm("Remove this branch from the destination list?")) return;
        run("DELETE FROM branch_register WHERE id=?",[+b.dataset.regDel]);
        persist(); render();
      };
    });
  }

  // ---- voucher ----
  // Works from the DN document itself, so a re-viewed voucher matches the
  // file that was sent.
  function dnVoucherHtml(doc){
    const when = new Date(doc.created_iso);
    const rows = doc.items.map(it=>`
      <tr>
        <td style="width:14mm">${it.thumb? `<img class="dn-thumb" src="${it.thumb}">` : ""}</td>
        <td>${escapeHtml(it.code||"—")}</td>
        <td>${escapeHtml(it.name)}</td>
        <td style="text-align:right">${it.qty} ${escapeHtml(it.unit)}</td>
      </tr>`).join("");
    return `
      <div class="report-print dn-voucher">
        <h2><span class="cat-vendor">${escapeHtml(getSetting("shop_name","My Shop"))}</span> — Dispatch Voucher</h2>
        <div class="sub">${escapeHtml(doc.dn_display)}</div>
        <table class="dn-meta">
          <tr><td>From</td><td><b>${escapeHtml(doc.from.name)}</b></td><td>To</td><td><b>${escapeHtml(doc.to.name)}</b></td></tr>
          <tr><td>Date</td><td>${escapeHtml(when.toLocaleDateString())}</td><td>Time</td><td>${escapeHtml(when.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}))}</td></tr>
        </table>
        <table class="dn-items">
          <thead><tr><th></th><th>Code</th><th>Item</th><th style="text-align:right">Qty</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p><b>${doc.totals.lines}</b> line${doc.totals.lines===1?"":"s"} · <b>${doc.totals.units}</b> unit${doc.totals.units===1?"":"s"}</p>
        <div class="dn-sign"><div>Dispatched by: ______________________</div><div>Received by: ______________________</div></div>
      </div>`;
  }
  function printDNVoucher(doc){
    document.getElementById("printArea").innerHTML = dnVoucherHtml(doc);
    setTimeout(()=>printNow(), 150);
  }

  // ---- file record: stored file, or rebuilt from the database lines ----
  function dnHeaderFor(dnNo){
    return one("SELECT * FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND direction='out'",[getBranchId(),dnNo]);
  }
  // The lines this branch dispatched on a DN, as recorded at dispatch time.
  function dnStoredLines(h){
    return all(`SELECT * FROM stock_transfers WHERE dn_no=? AND (dn_branch_id=? OR ((dn_branch_id IS NULL OR dn_branch_id='') AND from_branch=?)) ORDER BY id`,
      [h.dn_no,h.dispatch_branch_id,h.dispatch_branch_name]);
  }
  async function dnBuildFromDb(h){
    const lines = dnStoredLines(h);
    const products = lines.map(l=>
      (l.sku? one("SELECT * FROM products WHERE branch=? AND lower(sku)=lower(?)",[currentBranch(),l.sku]) : null)
      || one("SELECT * FROM products WHERE branch=? AND lower(name)=lower(?)",[currentBranch(),l.product_name]));
    const thumbs = await getThumbs(products);
    const rc = h.replaces_dn_no? caseByReplacement(h.dn_no) : null;
    const doc = await buildDN({
      dnNo: h.dn_no, fromBranchId: h.dispatch_branch_id, fromName: h.dispatch_branch_name, toName: h.receive_branch_name,
      createdIso: h.created_iso || localIso(new Date(h.created_ts)),
      replaces: rc? h.replaces_dn_no : undefined, cancelNo: rc? rc.case_no : undefined, cancelNonce: rc? rc.nonce : undefined,
      items: lines.map((l,i)=>({ code:l.sku||"", name:l.product_name, qty:l.qty, thumb:thumbs[i]||undefined }))
    });
    return { doc, text: serializeDN(doc) };
  }
  // Returns { doc, text, rebuilt }. A stored file that no longer validates is
  // replaced by a rebuilt one rather than shared.
  async function dnGetRecord(h){
    const stored = await dnfGet(h.dispatch_branch_id, h.dn_no);
    if(stored && stored.text){
      const p = await parseDN(stored.text);
      if(p.ok) return { doc:p.doc, text:stored.text, rebuilt:false };
    }
    const b = await dnBuildFromDb(h);
    await dnfPut(h.dispatch_branch_id, h.dn_no, { text:b.text, file_name:h.file_name, saved_ts:new Date().toISOString() });
    return { doc:b.doc, text:b.text, rebuilt:true };
  }
  function dnPhoneFor(toName){
    const r = one("SELECT whatsapp FROM branch_register WHERE name=?",[toName]);
    return r? r.whatsapp||"" : "";
  }
  async function dnShareRecord(h, rec){
    const r = await shareDNFile(h.file_name, rec.text, rec.doc.dn_display, rec.doc.from.name, dnPhoneFor(h.receive_branch_name));
    return r;
  }
  function dnShareMessage(r){
    if(r.method==="saved-folder") return "Saved to "+r.path+". The folder and WhatsApp have been opened — attach the file in the chat.";
    if(r.method==="downloaded") return "This device can't share files directly, so the file was downloaded. Open WhatsApp, choose the branch's chat, tap attach (📎) → Document, and pick the file from your Downloads.";
    if(r.method==="shared") return "Shared.";
    return "";
  }
  const dnShareLabel = ()=> isTauriApp()? "📁 Save & open WhatsApp" : "📲 Share file";

  // Destination must be a branch in the register (no typed names), and never this branch.
  function dnDestinationAllowed(name){
    const n = String(name||"").trim();
    return !!n && !sameBranchName(n, currentBranch()) && branchDestinations().some(b=>b.name===n);
  }
  // A dispatched product must carry its own code: the receiving branch matches
  // stock by code, so an empty or shared code cannot be received safely.
  // -> message, or "" when fine.
  function dnProductCodeProblem(p){
    const code = String(p.sku||"").trim();
    if(!code) return "Add a code to "+p.name+" in Products first.";
    const same = all("SELECT name FROM products WHERE branch=? AND lower(trim(sku))=lower(?) AND id<>?",[currentBranch(),code,p.id]);
    if(same.length) return p.name+" shares its code ("+code+") with "+same.map(x=>x.name).join(", ")+" — give each product its own code in Products first.";
    return "";
  }

  // The synchronous heart of a dispatch: number + stock + DN header + lines in
  // ONE transaction. All-or-nothing — if anything throws, the rollback also
  // returns the reserved number (it never left this device). No persist here;
  // the caller awaits persist() right after.
  function dnCommitDispatch(o){
    const branchId = getBranchId();
    let dn;
    if(!dnDestinationAllowed(o.toBranch)) throw new Error("Choose a destination branch from the register.");
    try{
      db.run("BEGIN");
      dn = reserveDocNumber("DN");
      const ts = o.now.toISOString();
      let units = 0;
      o.lines.forEach(l=>{
        const qty = l.qty;
        const codeErr = dnProductCodeProblem(l.product);
        if(codeErr) throw new Error(codeErr);
        if(!Number.isInteger(qty) || qty<1) throw new Error(`${l.product.name}: quantity must be a whole number of 1 or more.`);
        const cur = one("SELECT stock FROM products WHERE id=?",[l.product.id]);
        if(!cur || qty>cur.stock) throw new Error(`${l.product.name}: only ${cur?cur.stock:0} in stock.`);
        units += qty;
        run("UPDATE products SET stock=stock-? WHERE id=?",[qty,l.product.id]);
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user,dn_branch_id,dn_no) VALUES(?,?,?,?,?,?,?,?,?)",
          [ts,l.product.id,l.product.name,-qty,`Dispatched to ${o.toBranch} (${dn.text})`,o.branch,sessionUser||"",branchId,dn.n]);
        run(`INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status,dn_no,dn_branch_id)
             VALUES(?,?,?,?,?,?,?,?,'Dispatched',?,?)`,
          [ts,o.branch,o.toBranch,l.product.name,l.product.sku||"",qty,dn.text,sessionUser||"",dn.n,branchId]);
      });
      if(o.lines.length===0) throw new Error("Add at least one product.");
      const ok = insertDispatchDoc({ dispatchBranchId:branchId, dispatchBranchName:o.branch, dnNo:dn.n, receiveBranchName:o.toBranch,
        direction:"out", createdTs:ts, createdIso:localIso(o.now), lineCount:o.lines.length, unitTotal:units,
        status:"dispatched", fileName:dnFileName(dn.n, o.branch, o.now) });
      if(!ok) throw new Error("Delivery Note "+dn.text+" already exists.");
      recordDnEvent({ dnBranchId:branchId, dnNo:dn.n, type:"dispatched", actorBranchId:branchId, actorName:o.branch, fromName:o.branch, toName:o.toBranch, ts,
        detail:{ dn_created_iso:localIso(o.now), lines:o.lines.length, units } });
      logAudit("Dispatch Stock", "", `${dn.text}: ${o.lines.length} item${o.lines.length===1?"":"s"} to ${o.toBranch}`);
      db.run("COMMIT");
      return dn;
    }catch(e){
      try{ db.run("ROLLBACK"); }catch(_){}
      throw e;
    }
  }

  // ---- dispatch screen ----
  function openDispatchScreen(){
    const branch = currentBranch();
    const products = all("SELECT * FROM products WHERE branch=? ORDER BY name",[branch]);
    if(products.length===0){ alert("No products in this branch to dispatch."); return; }
    const dests = branchDestinations();
    let lines = [];            // { product, qty:"" }
    let query = "";
    let stage = "edit";

    const wrap = openModal("Dispatch Stock", "");
    const body = wrap.querySelector(".modal-body");
    let toName = "";

    function thumbImg(p){ return p.image? `<img src="${p.image}" style="width:34px;height:34px;object-fit:cover;border-radius:4px;flex:none">` : `<span style="width:34px;height:34px;border-radius:4px;background:var(--border);flex:none"></span>`; }
    function addProduct(p){
      if(p.stock<1) return alert(p.name+" has no stock to dispatch.");
      const codeErr = dnProductCodeProblem(p);
      if(codeErr) return alert(codeErr);
      const ex = lines.find(l=>l.product.id===p.id);
      if(ex){ ex.qty = String(Math.min(p.stock,(parseInt(ex.qty)||0)+1)); }
      else lines.push({ product:p, qty:"1" });
      query = ""; renderEdit(true);
    }
    function problems(){
      const errs = [];
      if(!toName.trim()) errs.push("Choose the destination branch.");
      else if(toName.trim().toLowerCase()===branch.toLowerCase()) errs.push("You can't dispatch to your own branch.");
      else if(!dnDestinationAllowed(toName)) errs.push("Choose a branch from the list.");
      if(lines.length===0) errs.push("Add at least one product.");
      lines.forEach((l,i)=>{
        const codeErr = dnProductCodeProblem(l.product);
        if(codeErr) errs.push(codeErr);
        const raw = String(l.qty).trim();
        const q = Number(raw);
        if(!/^\d+$/.test(raw) || q<1) errs.push(`${l.product.name}: quantity must be a whole number of 1 or more.`);
        else if(q>l.product.stock) errs.push(`${l.product.name}: only ${l.product.stock} in stock.`);
      });
      return errs;
    }

    function renderEdit(keepFocus){
      stage = "edit";
      const matches = query.trim()? searchProducts(query, branch).slice(0,6) : [];
      body.innerHTML = `
        <label style="margin-top:0">Destination branch</label>
        <select class="field" id="doDest">
          <option value="">Choose a branch…</option>
          ${dests.map(b=>`<option value="${escapeHtml(b.name)}" ${b.name===toName?"selected":""}>${escapeHtml(b.name)}</option>`).join("")}
        </select>
        ${dests.length? "" : `<p class="muted" style="font-size:12px">No destination branches are set up yet. Main adds them under Settings → Destination branches, and a remote receives the list with its catalogue.</p>`}
        <div class="hr"></div>
        <label style="margin-top:0">Add product — search, or scan a barcode/SKU and press Enter</label>
        <input class="field" id="doSearch" placeholder="Search by name or SKU" value="${escapeHtml(query)}" autocomplete="off">
        ${matches.length? `<div class="card" style="padding:4px;margin-top:4px;max-height:170px;overflow-y:auto">${matches.map(m=>`
          <button type="button" data-pick="${m.id}" style="display:flex;gap:8px;align-items:center;width:100%;text-align:left;background:none;border:none;padding:6px;font-size:13px;border-bottom:1px solid var(--border)">
            ${thumbImg(m)}<span>${escapeHtml(m.sku?m.sku+" — ":"")}${escapeHtml(m.name)} <span class="muted">(${m.stock} in stock)</span></span></button>`).join("")}</div>`
          : (query.trim()? `<div class="muted" style="padding:6px;font-size:12.5px">No matching product in this branch</div>` : "")}
        <div style="margin-top:10px">
          ${lines.map((l,i)=>`
            <div class="card" style="padding:8px;margin-bottom:6px;display:flex;gap:8px;align-items:center">
              ${thumbImg(l.product)}
              <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600">${escapeHtml(l.product.name)}</div>
                <div class="muted" style="font-size:11.5px">${escapeHtml(l.product.sku||"no SKU")} · ${l.product.stock} in stock</div></div>
              <input class="field" data-qty="${i}" inputmode="numeric" value="${escapeHtml(String(l.qty))}" style="width:70px;margin:0">
              <button type="button" class="close-x" data-del="${i}" title="Remove">✕</button>
            </div>`).join("")}
        </div>
        <div id="doErr" style="color:#b42318;font-size:12.5px;margin-top:6px"></div>
        <button class="btn btn-primary" id="doReview" style="margin-top:8px">Review</button>`;
      const dest = body.querySelector("#doDest"), search = body.querySelector("#doSearch");
      dest.onchange = ()=>{ toName = dest.value; };
      search.oninput = ()=>{ query = search.value; renderEdit(true); };
      search.onkeydown = (e)=>{
        if(e.key!=="Enter") return;
        e.preventDefault();
        const q = search.value.trim().toLowerCase();
        if(!q) return;
        const exact = products.find(p=>(p.sku||"").toLowerCase()===q);
        const pick = exact || searchProducts(q, branch)[0];
        if(pick) addProduct(pick);
      };
      if(keepFocus){ search.focus(); const n=search.value.length; try{ search.setSelectionRange(n,n); }catch(e){} }
      body.querySelectorAll("[data-pick]").forEach(b=>b.onclick=()=>addProduct(products.find(p=>p.id===+b.dataset.pick)));
      body.querySelectorAll("[data-qty]").forEach(inp=>inp.oninput=()=>{ lines[+inp.dataset.qty].qty = inp.value; });
      body.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{ lines.splice(+b.dataset.del,1); renderEdit(); });
      body.querySelector("#doReview").onclick=()=>{
        toName = dest.value.trim();
        const errs = problems();
        if(errs.length){ body.querySelector("#doErr").innerHTML = errs.map(escapeHtml).join("<br>"); return; }
        renderReview();
      };
    }

    function renderReview(){
      stage = "review";
      const units = lines.reduce((s,l)=>s+Number(l.qty),0);
      body.innerHTML = `
        <p style="margin:0 0 8px">Dispatch from <b>${escapeHtml(branch)}</b> to <b>${escapeHtml(toName)}</b></p>
        ${lines.map(l=>`<div class="product-row" style="align-items:center"><div style="display:flex;gap:8px;align-items:center">${thumbImg(l.product)}<div><div class="pname">${escapeHtml(l.product.name)}</div><div class="pmeta">${escapeHtml(l.product.sku||"no SKU")}</div></div></div><b style="flex:none">${Number(l.qty)}</b></div>`).join("")}
        <p style="margin:10px 0"><b>${lines.length}</b> line${lines.length===1?"":"s"} · <b>${units}</b> unit${units===1?"":"s"}. Stock is deducted as soon as you confirm.</p>
        <div style="display:flex;gap:8px"><button class="btn btn-outline" id="doBack">Back</button><button class="btn btn-primary" id="doConfirm" style="flex:1">Dispatch</button></div>`;
      body.querySelector("#doBack").onclick=()=>renderEdit();
      body.querySelector("#doConfirm").onclick=()=>confirm_();
    }

    function working(msg){
      stage = "working";
      body.innerHTML = `<div class="box" style="text-align:center"><p style="margin:0" id="doWork">${escapeHtml(msg)}</p></div>`;
    }

    // Order matters: validate -> ONE synchronous step (number + stock + DN
    // header + lines, in a SQL transaction) -> await persist -> build file ->
    // save -> voucher. Once the synchronous step has run the DN exists and its
    // number is spent; nothing after it can undo that.
    async function confirm_(){
      if(stage!=="review") return;             // double-tap guard
      const errs = problems();
      if(errs.length){ renderEdit(); body.querySelector("#doErr").innerHTML = errs.map(escapeHtml).join("<br>"); return; }
      stage = "working";
      const now = new Date(), branchId = getBranchId(), toBranch = toName.trim();
      let dn;
      try{
        dn = dnCommitDispatch({ branch, toBranch, now, lines: lines.map(l=>({ product:l.product, qty:Number(l.qty) })) });
      }catch(e){
        alert("Dispatch was not completed and no stock was changed: "+(e.message||e));
        stage = "review"; renderReview();
        return;
      }
      // ---- from here the DN exists ----
      let persistFailed = false;
      try{ await persist(); }catch(e){ persistFailed = true; }
      const header = dnHeaderFor(dn.n);
      try{
        working("Preparing pictures…");
        const thumbs = await getThumbs(lines.map(l=>l.product), (i,n)=>{ const el=body.querySelector("#doWork"); if(el) el.textContent = n>3? `Preparing pictures ${i} / ${n}…` : "Preparing pictures…"; });
        working("Building the Delivery Note file…");
        const doc = await buildDN({ dnNo:dn.n, fromBranchId:branchId, fromName:branch, toName:toBranch, createdIso:header.created_iso,
          items: lines.map((l,i)=>({ code:l.product.sku||"", name:l.product.name, qty:Number(l.qty), thumb:thumbs[i]||undefined })) });
        const text = serializeDN(doc);
        await dnfPut(branchId, dn.n, { text, file_name:header.file_name, saved_ts:new Date().toISOString() });
        let savedNote = "";
        if(isTauriApp()){ try{ const s = await tauriSaveDN(header.file_name, text); savedNote = "Saved to "+s.full; }catch(e){ savedNote = ""; } }
        renderDone({ header, doc, text, persistFailed, savedNote });
      }catch(e){
        body.innerHTML = `
          <div class="box"><p style="font-weight:700;margin:0 0 6px">${escapeHtml(dn.text)} was dispatched</p>
          <p class="muted" style="margin:0">The stock has been deducted and the number is used, but the file could not be built (${escapeHtml(e.message||String(e))}). Open <b>Dispatch history</b> and use <b>Share</b> to create it again.</p></div>
          <button class="btn btn-primary" id="doClose" style="margin-top:12px">Close</button>`;
        body.querySelector("#doClose").onclick=()=>{ wrap.remove(); render(); };
      }
    }

    function renderDone(r){
      stage = "done";
      body.innerHTML = `
        <div class="box" style="text-align:center;margin-bottom:10px">
          <p style="font-size:16px;font-weight:700;margin:0 0 4px">${escapeHtml(r.doc.dn_display)} dispatched</p>
          <p class="muted" style="margin:0">${r.doc.totals.lines} line${r.doc.totals.lines===1?"":"s"} · ${r.doc.totals.units} unit${r.doc.totals.units===1?"":"s"} to ${escapeHtml(r.doc.to.name)}</p>
          ${r.persistFailed? `<p style="color:#b42318;margin:6px 0 0;font-size:12.5px">Warning: this device couldn't save to its storage just now. Keep the app open and don't clear browser data until you see this screen again after another save.</p>` : ""}
          ${r.savedNote? `<p class="muted" style="margin:6px 0 0;font-size:12px">${escapeHtml(r.savedNote)}</p>` : ""}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <button class="btn btn-primary" id="doShare" style="flex:1">${dnShareLabel()}</button>
          <button class="btn btn-outline" id="doPrint">🖨️ Print voucher</button>
        </div>
        <div id="doMsg" class="muted" style="font-size:12.5px;margin-bottom:8px"></div>
        <div class="card" style="max-height:38vh;overflow:auto;padding:6px">${dnVoucherHtml(r.doc)}</div>
        <button class="btn btn-ghost" id="doDone" style="margin-top:10px">Done</button>`;
      body.querySelector("#doShare").onclick=async ()=>{
        try{ const s = await shareDNFile(r.header.file_name, r.text, r.doc.dn_display, r.doc.from.name, dnPhoneFor(r.header.receive_branch_name)); body.querySelector("#doMsg").textContent = dnShareMessage(s); }
        catch(e){ body.querySelector("#doMsg").textContent = "Couldn't share: "+(e.message||e); }
      };
      body.querySelector("#doPrint").onclick=()=>printDNVoucher(r.doc);
      body.querySelector("#doDone").onclick=()=>{ wrap.remove(); render(); };
    }

    renderEdit();
  }

  // ---- dispatch history ----
  // ---- branch name lock (Phase 4b) ----
  // Names are baked into files already sent (DNs, GRVs, catalogues, the register), so a
  // branch's name is fixed once it exists. A device with no branch name yet (setup made it
  // optional) can still set one, once. branch_id never changes either way.
  function branchNameLocked(){ return !!String(getSetting("branch_name","")).trim(); }
  // What Settings may save: the existing name when locked, otherwise what was typed.
  function branchNameToSave(submitted){ return branchNameLocked()? getSetting("branch_name","") : String(submitted==null?"":submitted).trim(); }
  // A destination's name is locked by the FIRST of: a DN dispatched to it from this device, or a
  // catalogue generated for it. -> null | { by:"dispatch"|"catalogue", ts, dnNo? }
  function destinationLock(name){
    const dns = all("SELECT dn_no,created_ts,receive_branch_name FROM dispatch_docs WHERE direction='out'").filter(r=>sameBranchName(r.receive_branch_name, name))
      .sort((a,b)=>(Date.parse(a.created_ts)||0)-(Date.parse(b.created_ts)||0) || a.dn_no-b.dn_no);
    const reg = one("SELECT catalogue_first_ts FROM branch_register WHERE name=?",[name]);
    const firstDn = dns[0] || null, catTs = reg && reg.catalogue_first_ts? reg.catalogue_first_ts : "";
    if(!firstDn && !catTs) return null;
    if(firstDn && !catTs) return { by:"dispatch", ts:firstDn.created_ts, dnNo:firstDn.dn_no };
    if(!firstDn) return { by:"catalogue", ts:catTs };
    return (Date.parse(catTs)||0) < (Date.parse(firstDn.created_ts)||0) ? { by:"catalogue", ts:catTs } : { by:"dispatch", ts:firstDn.created_ts, dnNo:firstDn.dn_no };
  }
  const destinationNameLocked = (name)=> !!destinationLock(name);
  // The plain reason, saying which one triggered the lock.
  function destinationLockText(name, lock){
    lock = lock || destinationLock(name);
    if(!lock) return "";
    const when = isoDateText(lock.ts) || String(lock.ts||"").slice(0,10);
    return lock.by==="catalogue"
      ? "This name is locked: a catalogue was generated for \""+name+"\" on "+when+"."
      : "This name is locked: a Delivery Note ("+formatDocNo("DN",lock.dnNo)+") has been dispatched to \""+name+"\" on "+when+".";
  }
  // Main only. Renames one register entry; refuses once a DN has been dispatched to it.
  function renameRegisterBranch(id, newName){
    if(isRemote()) throw new Error("The branch register is managed on the main branch.");
    const row = one("SELECT * FROM branch_register WHERE id=?",[id]);
    if(!row) throw new Error("That branch is not in the register.");
    if(sameBranchName(row.name, currentBranch())) throw new Error("This is this branch's own entry. The branch name is locked after setup.");
    const nn = String(newName==null?"":newName).trim();
    if(!nn) throw new Error("Enter the new branch name.");
    if(nn===row.name) throw new Error("That is already the name.");
    const lock = destinationLock(row.name);
    if(lock) throw new Error(destinationLockText(row.name, lock));
    if(one("SELECT 1 AS x FROM branch_register WHERE name=? AND id<>?",[nn,id])) throw new Error("\""+nn+"\" is already in the register.");
    db.run("BEGIN");
    try{
      run("UPDATE branch_register SET name=? WHERE id=?",[nn,id]);           // no catalogue or DN exists for it yet (that is what would have locked it)
      run("UPDATE branch_prices SET dest_branch_name=? WHERE dest_branch_name=?",[nn,row.name]);
      logAudit("Rename destination","",row.name+" -> "+nn);
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
    return { old:row.name, new:nn };
  }
  // ---- status (Phase 4): joined on (dispatching branch id, dn_no) through dn_events ----
  function awaitingDays(){ return awaitingDaysFrom(getSetting("awaiting_days","")); }
  function dnMovementRows(){ return buildMovements(all("SELECT * FROM dn_events"), Date.now(), awaitingDays()); }
  // key "branchId|dnNo" -> status ("dispatched" | "received" | "variance" | "awaiting")
  function dnStatusMap(){
    const m = new Map();
    dnMovementRows().forEach(r=>m.set(r.key, r));
    return m;
  }
  function dnStatusBadge(status){
    const color = status==="received"? "#067647" : (status==="variance"||status==="conflict")? "#b42318" : (status==="awaiting"||status==="cancel_pending")? "#b54708" : DN_CANCELLED_STATUSES.includes(status)? "#555" : "var(--ink-soft)";
    return `<span style="font-size:12px;font-weight:700;color:${color}">${escapeHtml(DN_STATUS_LABEL[status]||status)}</span>`;
  }
  function openDispatchHistory(){
    const wrap = openModal("Dispatch history", "");
    const body = wrap.querySelector(".modal-body");
    function renderList(msg){
      const rows = all("SELECT * FROM dispatch_docs WHERE direction='out' AND dispatch_branch_id=? ORDER BY dn_no DESC",[getBranchId()]);
      const mv = dnStatusMap();
      const statusOf = (h)=>{ const r = mv.get(h.dispatch_branch_id+"|"+h.dn_no); return r? r.status : (h.status==="received"? "received" : "dispatched"); };
      body.innerHTML = (msg? `<div class="box" style="margin-bottom:8px;font-size:12.5px">${escapeHtml(msg)}</div>` : "")
        + `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><button class="btn btn-sm btn-primary" id="dhImport">📥 Import GRV / reply</button><span class="muted" style="font-size:12px">Confirm delivery with the receiver's GRV, or a cancellation confirmation.</span></div>`
        + (rows.length===0? `<p class="muted">No dispatches yet.</p>` : rows.map(h=>{
          const st = statusOf(h), mr = mv.get(h.dispatch_branch_id+"|"+h.dn_no);
          return `
        <div class="card" style="padding:10px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b>${escapeHtml(formatDocNo("DN",h.dn_no))}</b>
            ${dnStatusBadge(st)}
          </div>
          <div class="pmeta">To ${escapeHtml(h.receive_branch_name)} · ${escapeHtml(new Date(h.created_ts).toLocaleString())}</div>
          <div class="pmeta">${h.line_count||0} line${h.line_count===1?"":"s"} · ${h.unit_total||0} unit${h.unit_total===1?"":"s"}</div>
          ${st==="received" && mr && mr.grvNo? `<div class="pmeta">Confirmed as ${escapeHtml(formatDocNo("GRV",mr.grvNo))} on ${escapeHtml(isoDateText(mr.receivedIso)||"")}</div>` : ""}
          ${mr && mr.hasVariance? `<div class="pmeta" style="color:#b42318">${escapeHtml(varianceText(mr))}</div>` : ""}
          ${st==="awaiting"? `<div class="pmeta" style="color:#b54708">No GRV after ${awaitingDays()} days.</div>` : ""}
          ${mr && chainText(mr)? `<div class="pmeta" style="color:#b54708">${escapeHtml(chainText(mr))}</div>` : ""}
          ${mr && mr.cancelPending && st!=="cancel_pending"? `<div class="pmeta" style="color:#b54708">Cancel pending: waiting for ${escapeHtml(h.receive_branch_name)}'s confirmation.</div>` : ""}
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            <button class="btn btn-sm btn-outline" data-view="${h.dn_no}">View voucher</button>
            ${DN_CLOSED_STATUSES.includes(st)? "" : `<button class="btn btn-sm btn-outline" data-share="${h.dn_no}">${dnShareLabel()}</button>`}
            ${mr && mr.cancelPending? `<button class="btn btn-sm btn-outline" data-pending="${h.dn_no}">Cancel pending…</button>` : (cancelEnabled() && canStartCancel(st)? `<button class="btn btn-sm btn-outline" data-cancel="${h.dn_no}">Cancel / reissue…</button>` : "")}
          </div>
        </div>`; }).join(""));
      body.querySelector("#dhImport").onclick=()=>{ openGrvImportScreen(null, ()=>{ renderList(); render(); }); };
      body.querySelectorAll("[data-cancel]").forEach(b=>b.onclick=()=>openCancelWizard(+b.dataset.cancel, ()=>{ renderList(); render(); }));
      body.querySelectorAll("[data-pending]").forEach(b=>b.onclick=()=>openPendingCancelModal(+b.dataset.pending, ()=>{ renderList(); render(); }));
      body.querySelectorAll("[data-view]").forEach(b=>b.onclick=async ()=>{
        try{ const rec = await dnGetRecord(dnHeaderFor(+b.dataset.view)); const mvr = dnStatusMap().get(getBranchId()+"|"+(+b.dataset.view)); openDNVoucherModal(rec.doc, mvr? mvr.status : ""); }
        catch(e){ renderList("Couldn't open that voucher: "+(e.message||e)); }
      });
      body.querySelectorAll("[data-share]").forEach(b=>b.onclick=async ()=>{
        try{
          const h = dnHeaderFor(+b.dataset.share);
          const rec = await dnGetRecord(h);
          const s = await dnShareRecord(h, rec);
          renderList((rec.rebuilt? "The stored file was missing, so it was rebuilt from the dispatch records. " : "") + dnShareMessage(s));
        }catch(e){ renderList("Couldn't share: "+(e.message||e)); }
      });
    }
    renderList();
  }
  function openDNVoucherModal(doc, status){
    const wrap = openModal("Dispatch voucher — "+doc.dn_display, `
      ${DN_CLOSED_STATUSES.includes(status)? `<div class="box" style="margin-bottom:8px;border-color:#b42318;color:#b42318;font-weight:700">${escapeHtml((DN_STATUS_LABEL[status]||"").toUpperCase())}: this Delivery Note is no longer valid.</div>` : ""}
      ${doc.replaces? `<div class="box" style="margin-bottom:8px"><b>Replaces ${escapeHtml(formatDocNo("DN",doc.replaces))}</b></div>` : ""}
      <div class="card" style="max-height:60vh;overflow:auto;padding:6px">${dnVoucherHtml(doc)}</div>
      <button class="btn btn-primary" id="dvPrint" style="margin-top:10px">🖨️ Print voucher</button>`);
    wrap.querySelector("#dvPrint").onclick=()=>printDNVoucher(doc);
  }
