  // ---------------- Catalogue + price policy: database and screens ----------------
  // Main builds a catalogue per destination (catalogue.js is the pure format);
  // a remote imports it. Prices never travel in DN/GRV files, and receiving
  // stock never touches price or cost — price only moves through this file
  // (per the destination's price_mode) or the Admin-gated price edit below.

  // ---- register: price mode + staleness ----
  function registerRow(name){ return one("SELECT * FROM branch_register WHERE name=?",[name]); }
  function priceModeOf(destName){ const r = registerRow(destName); return (r && r.price_mode) || "follow_main"; }
  // Main only. Takes effect on the remote when its NEXT catalogue is imported.
  function setBranchPriceMode(destName, mode){
    if(isRemote()) throw new Error("Only the main branch can change a branch's price policy.");
    if(!CAT_PRICE_MODES.includes(mode)) throw new Error("Unknown price policy.");
    if(!registerRow(destName)) throw new Error("That branch is not in the register.");
    run("UPDATE branch_register SET price_mode=? WHERE name=?",[mode,destName]);
  }

  // ---- branch prices (main side; only used in 'main_sets') ----
  function mainProducts(){ return all("SELECT * FROM products WHERE branch=? ORDER BY name",[currentBranch()]); }
  function getBranchPrices(dest){
    const m = new Map();
    all("SELECT code, price FROM branch_prices WHERE dest_branch_name=?",[dest]).forEach(r=>m.set(catCode(r.code), r.price));
    return m;
  }
  // value blank/null removes the branch price (main's price is used again).
  // Only while the destination's policy is 'main_sets'. Stored branch prices are
  // never deleted by a policy change; they simply stop being used (effectivePrice).
  // Any real change stamps the destination's prices_ts, which the staleness flag reads.
  function setBranchPrice(dest, code, value){
    if(isRemote()) throw new Error("Only the main branch sets branch prices.");
    if(!registerRow(dest)) throw new Error("That branch is not in the register.");
    if(priceModeOf(dest)!=="main_sets") throw new Error("Branch prices can only be set while "+dest+"'s policy is \""+priceModeLabel("main_sets")+"\".");
    const existing = one("SELECT price FROM branch_prices WHERE dest_branch_name=? AND code=?",[dest,code]);
    const ts = new Date().toISOString();
    if(value===null || value===undefined || String(value).trim()===""){
      if(existing){ run("DELETE FROM branch_prices WHERE dest_branch_name=? AND code=?",[dest,code]); run("UPDATE branch_register SET prices_ts=? WHERE name=?",[ts,dest]); }
      return null;
    }
    const p = parsePriceInput(value);
    if(!p.ok) throw new Error(code+": "+p.error);
    if(existing && catRound(existing.price)===p.value) return p.value;
    run(`INSERT INTO branch_prices(dest_branch_name,code,price,updated_ts) VALUES(?,?,?,?)
         ON CONFLICT(dest_branch_name,code) DO UPDATE SET price=excluded.price, updated_ts=excluded.updated_ts`,[dest,code,p.value,ts]);
    run("UPDATE branch_register SET prices_ts=? WHERE name=?",[ts,dest]);
    return p.value;
  }
  // Every coded product with main price, branch price (or null) and the price the
  // destination would actually get.
  function branchPriceRows(dest){
    const mode = priceModeOf(dest), bp = getBranchPrices(dest);
    return mainProducts().filter(p=>catCode(p.sku)).map(p=>{
      const b = bp.has(catCode(p.sku))? bp.get(catCode(p.sku)) : null;
      return { id:p.id, code:p.sku, name:p.name, main:catRound(p.price||0), branch:b, effective:effectivePrice(p.price, b, mode) };
    });
  }
  // All-or-nothing: validates every row first.
  function applyBulkBranchPrices(dest, rows){
    rows.forEach(r=>{ const p = parsePriceInput(r.new); if(!p.ok) throw new Error(r.code+": "+p.error); });
    db.run("BEGIN");
    try{ rows.forEach(r=>setBranchPrice(dest, r.code, r.new)); db.run("COMMIT"); }
    catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
  }

  // "Prices changed since last catalogue": compares what main WOULD send now with
  // what it sent last (a fingerprint of code:price), so a change that was undone
  // does not flag, and no price-edit path needs to remember a timestamp.
  function currentCatalogueItems(dest){
    const mode = priceModeOf(dest), bp = getBranchPrices(dest);
    return mainProducts().filter(p=>catCode(p.sku)).map(p=>({ code:p.sku, name:p.name,
      price: effectivePrice(p.price, bp.has(catCode(p.sku))? bp.get(catCode(p.sku)) : null, mode) }));
  }
  // Stale = a price the catalogue would carry changed AFTER the catalogue was made:
  // any main product's price_ts, or (main_sets only) this destination's branch
  // prices. Generating a new catalogue moves catalogue_ts forward, which clears it.
  function catalogueStatus(dest){
    const r = registerRow(dest);
    if(!r || !r.catalogue_ts) return { never:true, pricesChanged:false, modeChanged:false, ts:"" };
    const mode = r.price_mode || "follow_main";
    const mainChanged = !!one("SELECT 1 AS x FROM products WHERE branch=? AND trim(sku)<>'' AND price_ts>? LIMIT 1",[currentBranch(),r.catalogue_ts]);
    const branchChanged = mode==="main_sets" && !!r.prices_ts && r.prices_ts>r.catalogue_ts;
    return { never:false, ts:r.catalogue_ts, pricesChanged: mainChanged||branchChanged, modeChanged: mode!==r.catalogue_mode };
  }

  // ---- build (main) ----
  async function buildCatalogueFor(dest, onProgress){
    if(isRemote()) throw new Error("Only the main branch builds catalogues.");
    const reg = registerRow(dest);
    if(!reg) throw new Error("Choose a destination from the register.");
    if(sameBranchName(reg.name, currentBranch())) throw new Error("A catalogue can't be built for this branch itself.");
    const products = mainProducts();
    if(products.length===0) throw new Error("There are no products to put in a catalogue.");
    const problems = checkCatalogueProducts(products);
    if(problems.length){ const e = new Error("Some products need a code before a catalogue can be built."); e.problems = problems; throw e; }
    // Same clock (and rounding) the price_ts triggers use, so "newer" compares like with like.
    const startedTs = one("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS t").t;   // prices below are read now; anything changed after this is newer
    const mode = reg.price_mode || "follow_main", bp = getBranchPrices(reg.name);
    const thumbs = await getThumbs(products, onProgress);
    const now = new Date();
    const doc = await buildCatalogue({
      fromBranchId:getBranchId(), fromName:currentBranch(), toName:reg.name, createdIso:localIso(now), priceMode:mode,
      managementWhatsapp:getSetting("management_whatsapp",""),
      register: all("SELECT name, whatsapp FROM branch_register ORDER BY name"),
      items: products.map((p,i)=>({ code:p.sku, name:p.name, description:p.description||"", thumb:thumbs[i]||undefined,
        price: effectivePrice(p.price, bp.has(catCode(p.sku))? bp.get(catCode(p.sku)) : null, mode) }))
    });
    const text = serializeCatalogue(doc), fileName = catalogueFileName(reg.name, now);
    run("UPDATE branch_register SET catalogue_ts=?, catalogue_fp=?, catalogue_mode=?, catalogue_first_ts=CASE WHEN COALESCE(catalogue_first_ts,'')='' THEN ? ELSE catalogue_first_ts END WHERE id=?",
      [startedTs, priceFingerprint(doc.items), mode, startedTs, reg.id]);
    logAudit("Build Catalogue","",`For ${reg.name}: ${doc.items.length} products, ${mode}`);
    await persist();
    try{ await dnfPut(getBranchId(), "CAT:"+reg.name.toLowerCase(), { text, file_name:fileName, saved_ts:now.toISOString() }); }catch(e){ /* re-share just rebuilds */ }
    return { doc, text, fileName, dest:reg };
  }
  const catalogueShare = (b)=> shareDocFile({ fileName:b.fileName, text:b.text, folder:"Catalogues", title:"Catalogue for "+b.dest.name, phone:b.dest.whatsapp,
    shareText:"Catalogue for "+b.dest.name+" from "+currentBranch(),
    whatsappText:"Catalogue for "+b.dest.name+" from "+currentBranch()+". Please attach the file from the folder that just opened." });

  // ---- import (remote) ----
  function decodeBytesUtf8(bytes){
    return typeof TextDecoder!=="undefined" ? new TextDecoder("utf-8").decode(bytes) : String.fromCharCode.apply(null, Array.from(bytes));
  }
  // Checks in order; the first failure stops with a plain message and changes nothing.
  // -> { ok:false, message } | { ok:true, doc, plan, warning, storedMode }
  async function catalogueImportPreflight(bytes){
    if(!isRemote()) return { ok:false, message:"Catalogues are for remote branches. This is the main branch — build catalogues from Settings → Destination branches." };
    const p = await parseCatalogue(decodeBytesUtf8(bytes));
    if(!p.ok) return { ok:false, message:p.errors[0], errors:p.errors };
    const doc = p.doc;
    if(!sameBranchName(doc.to.name, currentBranch()))
      return { ok:false, message:"This catalogue is for \""+doc.to.name+"\", but this branch is \""+currentBranch()+"\". Nothing was imported.", wrongBranch:true };
    const local = all("SELECT * FROM products WHERE branch=?",[currentBranch()]);
    const plan = planCatalogueImport(doc, local, doc.price_mode);
    if(plan.ambiguous.length)
      return { ok:false, message:"This branch has more than one product with the same code ("+plan.ambiguous.map(a=>a.code).join(", ")+"), so the catalogue can't be matched safely. Nothing was imported. Ask main to fix the duplicate codes." };
    const storedMode = getSetting("price_mode","");
    return { ok:true, doc, plan, storedMode, warning: priceModeWarning(storedMode, doc.price_mode, plan) };
  }
  // The synchronous, all-or-nothing part. Stock and cost are never written; nothing is deleted.
  function commitCatalogueImport(doc, plan){
    const ts = new Date().toISOString(), branch = currentBranch();
    db.run("BEGIN");
    try{
      plan.inserts.forEach(it=>{
        run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
          [it.name,it.price,0,5,it.code,branch,it.thumb||"",0,ts,it.description||""]);
      });
      plan.updates.forEach(u=>{
        const sets = [], vals = [];
        if(u.name!==undefined){ sets.push("name=?"); vals.push(u.name); }
        if(u.image!==undefined){ sets.push("image=?"); vals.push(u.image); }
        if(u.price!==undefined){ sets.push("price=?"); vals.push(u.price); }
        if(sets.length) run("UPDATE products SET "+sets.join(",")+" WHERE id=?", vals.concat([u.id]));
      });
      setSetting("price_mode", doc.price_mode);
      if(!getSetting("management_whatsapp","") && doc.management_whatsapp) setSetting("management_whatsapp", doc.management_whatsapp);
      doc.register.forEach(r=>{
        if(sameBranchName(r.name, branch)) return;
        const ex = registerRow(r.name);
        if(!ex) run("INSERT INTO branch_register(name,whatsapp) VALUES(?,?)",[r.name,r.whatsapp]);
        else if(!ex.whatsapp && r.whatsapp) run("UPDATE branch_register SET whatsapp=? WHERE id=?",[r.whatsapp,ex.id]);
      });
      setSetting("catalogue_last_import", ts); setSetting("catalogue_from", doc.from.name);
      logAudit("Catalogue import","",`From ${doc.from.name}: ${plan.inserts.length} new, ${plan.updates.length} updated, ${plan.priceChanges.length} prices changed, policy ${doc.price_mode}`);
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
    return { inserted:plan.inserts.length, updated:plan.updates.length, priceChanges:plan.priceChanges.length };
  }
  // Backup first (same as the data merge), then apply.
  async function applyCatalogueImport(doc, plan){
    downloadDb("seigen-backup-before-catalogue-"+new Date().toISOString().replace(/[:.]/g,"-")+".sqlite");
    const r = commitCatalogueImport(doc, plan);
    await persist();
    return r;
  }

  // ---- price edit at a remote (branch_edits only, Admin passcode, price only) ----
  const remotePriceEditable = ()=> isRemote() && getSetting("price_mode","follow_main")==="branch_edits";
  // The same Admin unlock Remote Settings uses: an active Admin with a passcode.
  const NO_ADMIN_PASSCODE_MSG = "Set an Admin passcode in Settings first";
  function hasAdminPasscode(){
    return !!one("SELECT 1 AS x FROM staff WHERE role='Admin' AND active=1 AND trim(COALESCE(passcode,''))<>'' LIMIT 1");
  }
  // -> { product, old, new, admin }. Throws a plain message on any refusal; changes nothing then.
  function applyRemotePriceEdit(o){
    if(!isRemote()) throw new Error("Prices are edited on the main branch.");
    if(getSetting("price_mode","follow_main")!=="branch_edits") throw new Error(remotePriceNote());
    if(!hasAdminPasscode()) throw new Error(NO_ADMIN_PASSCODE_MSG);
    const admin = findAdmin(o.passcode);
    if(!admin) throw new Error("Incorrect Admin passcode.");
    const p = one("SELECT * FROM products WHERE id=? AND branch=?",[o.productId,currentBranch()]);
    if(!p) throw new Error("That product is not in this branch.");
    const parsed = parsePriceInput(o.price);
    if(!parsed.ok) throw new Error(parsed.error);
    const oldPrice = catRound(p.price||0);
    if(parsed.value===oldPrice) throw new Error("That is already the price.");
    run("UPDATE products SET price=? WHERE id=?",[parsed.value,p.id]);
    logAudit("Price change", p.name, (p.sku||"no code")+": "+oldPrice.toFixed(2)+" -> "+parsed.value.toFixed(2)+" (authorised by "+admin.name+")");
    return { product:p, old:oldPrice, new:parsed.value, admin:admin.name };
  }
  function remotePriceNote(){
    const m = getSetting("price_mode","follow_main");
    return m==="branch_edits" ? (hasAdminPasscode()? "Selling prices can be changed here with the Admin passcode." : NO_ADMIN_PASSCODE_MSG+" before prices can be changed here.")
      : m==="main_sets" ? "Prices at this branch are set by the main branch (branch prices) and change when a new catalogue is imported."
      : "Prices at this branch follow the main branch and change when a new catalogue is imported.";
  }

  // ---- screens ----
  function catalogueRegisterExtras(b){
    const mode = b.price_mode || "follow_main", st = catalogueStatus(b.name);
    return `
      <div style="margin-top:6px">
        <label style="margin-top:0;font-size:12px">Prices</label>
        <select class="field" data-reg-mode="${escapeHtml(b.name)}" style="margin-bottom:4px">
          ${CAT_PRICE_MODES.map(m=>`<option value="${m}" ${m===mode?"selected":""}>${escapeHtml(priceModeLabel(m))}</option>`).join("")}
        </select>
        <div class="pmeta">${st.never? "No catalogue generated yet" : "Catalogue last generated "+escapeHtml(new Date(st.ts).toLocaleString())}</div>
        ${st.pricesChanged? `<div class="pmeta" style="color:#b42318;font-weight:600">Prices changed since last catalogue</div>` : ""}
        ${st.modeChanged? `<div class="pmeta" style="color:#b42318;font-weight:600">Price policy changed since last catalogue</div>` : ""}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          <button class="btn btn-sm btn-outline" data-reg-cat="${escapeHtml(b.name)}">Build catalogue</button>
          ${mode==="main_sets"? `<button class="btn btn-sm btn-outline" data-reg-prices="${escapeHtml(b.name)}">Branch prices</button>` : ""}
        </div>
      </div>`;
  }
  function wireCatalogueRegisterExtras(){
    document.querySelectorAll("[data-reg-mode]").forEach(sel=>{
      sel.onchange=()=>{
        try{ setBranchPriceMode(sel.dataset.regMode, sel.value); }catch(e){ alert(e.message); }
        persist(); render();
      };
    });
    document.querySelectorAll("[data-reg-cat]").forEach(b=>b.onclick=()=>openCatalogueBuilder(b.dataset.regCat));
    document.querySelectorAll("[data-reg-prices]").forEach(b=>b.onclick=()=>openBranchPricesScreen(b.dataset.regPrices));
  }

  function openCatalogueBuilder(dest){
    const wrap = openModal("Catalogue for "+dest, `<div class="box" style="text-align:center"><p style="margin:0" id="cbWork">Checking products…</p></div>`);
    const body = wrap.querySelector(".modal-body");
    (async()=>{
      try{
        const b = await buildCatalogueFor(dest, (i,n)=>{ const el = body.querySelector("#cbWork"); if(el) el.textContent = n>3? "Preparing pictures "+i+" / "+n+"…" : "Preparing pictures…"; });
        body.innerHTML = `
          <div class="box" style="text-align:center;margin-bottom:10px">
            <p style="font-weight:700;margin:0 0 4px">Catalogue ready for ${escapeHtml(dest)}</p>
            <p class="muted" style="margin:0">${b.doc.items.length} products · ${escapeHtml(priceModeLabel(b.doc.price_mode))}</p>
          </div>
          <button class="btn btn-primary" id="cbShare">${isTauriApp()? "📁 Save & open WhatsApp" : "📲 Share file"}</button>
          <div id="cbMsg" class="muted" style="font-size:12.5px;margin-top:8px"></div>
          <button class="btn btn-ghost" id="cbDone" style="margin-top:10px">Done</button>`;
        body.querySelector("#cbShare").onclick=async ()=>{
          try{ body.querySelector("#cbMsg").textContent = dnShareMessage(await catalogueShare(b)); }
          catch(e){ body.querySelector("#cbMsg").textContent = "Couldn't share: "+(e.message||e); }
        };
        body.querySelector("#cbDone").onclick=()=>{ wrap.remove(); render(); };
      }catch(e){
        body.innerHTML = e.problems
          ? `<p style="margin:0 0 8px"><b>The catalogue was not built.</b> Fix these in Products first:</p>
             <div style="max-height:50vh;overflow:auto">${e.problems.map(pr=>`<div class="pmeta" style="margin-bottom:4px">• ${escapeHtml(catalogueProblemText(pr))}</div>`).join("")}</div>
             <button class="btn btn-outline" id="cbClose" style="margin-top:10px">Close</button>`
          : `<p style="margin:0 0 8px">${escapeHtml(e.message||String(e))}</p><button class="btn btn-outline" id="cbClose">Close</button>`;
        body.querySelector("#cbClose").onclick=()=>wrap.remove();
      }
    })();
  }

  function openBranchPricesScreen(dest){
    if(priceModeOf(dest)!=="main_sets"){ alert("Branch prices are only used when "+dest+"'s policy is \""+priceModeLabel("main_sets")+"\". Change the policy first."); return; }
    const wrap = openModal("Branch prices — "+dest, "");
    const body = wrap.querySelector(".modal-body");
    let query = "", pending = null;   // pending: bulk preview rows
    const fmt = (n)=> n===null||n===undefined? "" : Number(n).toFixed(2);
    function render_(){
      const rows = branchPriceRows(dest).filter(r=>!query.trim() || (r.code+" "+r.name).toLowerCase().includes(query.trim().toLowerCase()));
      body.innerHTML = `
        <p class="muted" style="margin-top:0">Leave a branch price blank to use the main price. Only used while this branch's policy is "${escapeHtml(priceModeLabel("main_sets"))}".</p>
        <div class="card" style="padding:8px;margin-bottom:8px">
          <label style="margin-top:0">Set all to main +/- % (use a minus for a discount)</label>
          <div style="display:flex;gap:6px"><input class="field" id="bpPct" inputmode="decimal" placeholder="e.g. 10 or -5" style="margin:0"><button class="btn btn-outline" id="bpPreview" style="flex:none">Preview</button></div>
          <div id="bpPreviewBox">${pending? previewHtml() : ""}</div>
        </div>
        <input class="field" id="bpSearch" placeholder="Search code or name" value="${escapeHtml(query)}" autocomplete="off">
        <div style="max-height:44vh;overflow:auto;margin-top:6px">
          <table class="simple"><tr><th>Code / item</th><th>Main</th><th>Branch</th><th>Effective</th></tr>
          ${rows.map(r=>`<tr><td><div class="psku">${escapeHtml(r.code)}</div>${escapeHtml(r.name)}</td><td>${fmt(r.main)}</td>
            <td><input class="field" data-bp="${escapeHtml(r.code)}" inputmode="decimal" value="${fmt(r.branch)}" placeholder="—" style="width:84px;margin:0"></td><td>${fmt(r.effective)}</td></tr>`).join("")}
          </table></div>
        <div id="bpErr" style="color:#b42318;font-size:12.5px;margin-top:6px"></div>
        <button class="btn btn-primary" id="bpSave" style="margin-top:8px">Save branch prices</button>`;
      body.querySelector("#bpSearch").oninput=(e)=>{ query = e.target.value; render_(); const s = body.querySelector("#bpSearch"); s.focus(); s.setSelectionRange(query.length,query.length); };
      body.querySelector("#bpPreview").onclick=()=>{
        const raw = body.querySelector("#bpPct").value.trim();
        const pct = Number(raw.replace(",","."));
        try{
          if(raw==="" || !Number.isFinite(pct)) throw new Error("Enter a percentage, e.g. 10 or -5.");
          pending = bulkAdjustPrices(branchPriceRows(dest).map(r=>({code:r.code,name:r.name,main:r.main})), pct);
          pending.pct = pct;
          render_();
        }catch(e){ body.querySelector("#bpErr").textContent = e.message; }
      };
      const apply = body.querySelector("#bpApply"), cancel = body.querySelector("#bpCancel");
      if(apply) apply.onclick=async ()=>{
        try{ applyBulkBranchPrices(dest, pending); await persist(); pending = null; render_(); body.querySelector("#bpErr").style.color="inherit"; body.querySelector("#bpErr").textContent = "Branch prices set."; }
        catch(e){ body.querySelector("#bpErr").textContent = e.message; }
      };
      if(cancel) cancel.onclick=()=>{ pending = null; render_(); };
      body.querySelector("#bpSave").onclick=async ()=>{
        const inputs = [...body.querySelectorAll("[data-bp]")];
        const bad = inputs.find(i=>i.value.trim()!=="" && !parsePriceInput(i.value).ok);
        if(bad){ body.querySelector("#bpErr").textContent = bad.dataset.bp+": "+parsePriceInput(bad.value).error; return; }
        try{
          db.run("BEGIN");
          try{ inputs.forEach(i=>{
            const cur = branchPriceRows(dest).find(r=>catCode(r.code)===catCode(i.dataset.bp));
            const v = i.value.trim()==="" ? null : parsePriceInput(i.value).value;
            if((cur? cur.branch : null)!==v) setBranchPrice(dest, i.dataset.bp, v);
          }); db.run("COMMIT"); }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
          await persist(); render_(); body.querySelector("#bpErr").style.color="inherit"; body.querySelector("#bpErr").textContent = "Saved.";
        }catch(e){ body.querySelector("#bpErr").textContent = e.message; }
      };
    }
    function previewHtml(){
      const changed = pending.filter(r=>r.new!==r.main).length;
      return `<div class="muted" style="font-size:12.5px;margin-top:6px">Main ${pending.pct>=0?"+":""}${pending.pct}% would set ${pending.length} branch price${pending.length===1?"":"s"}.
        ${pending.slice(0,5).map(r=>`<div>${escapeHtml(r.code)}: ${r.main.toFixed(2)} → ${r.new.toFixed(2)}</div>`).join("")}${pending.length>5?`<div>+${pending.length-5} more</div>`:""}</div>
        <div style="display:flex;gap:6px;margin-top:6px"><button class="btn btn-primary btn-sm" id="bpApply">Apply</button><button class="btn btn-outline btn-sm" id="bpCancel">Cancel</button></div>`;
    }
    render_();
  }

  // Remote: "Get catalogue". With a file already chosen (from the old merge guard)
  // it goes straight to the preview.
  function openCatalogueWithFile(file){ openCatalogueImportScreen(file); }
  function openCatalogueImportScreen(file){
    const wrap = openModal("Get catalogue", `
      <p class="muted" style="margin-top:0">Choose the catalogue file main sent you. Any file name works.</p>
      <input type="file" id="cgFile">`);
    const body = wrap.querySelector(".modal-body");
    async function handle(f){
      body.innerHTML = `<div class="box" style="text-align:center"><p style="margin:0">Reading…</p></div>`;
      let bytes;
      try{ bytes = await readFileBytes(f); }catch(e){ return showBlocked("Could not read that file."); }
      let r;
      try{ r = await catalogueImportPreflight(bytes); }catch(e){ r = { ok:false, message:"Could not read that file as a catalogue." }; }
      if(!r.ok) return showBlocked(r.message);
      showPreview(r);
    }
    function showBlocked(msg){
      body.innerHTML = `<p style="margin:0 0 10px">${escapeHtml(msg)}</p><button class="btn btn-outline" id="cgClose">Close</button>`;
      body.querySelector("#cgClose").onclick=()=>wrap.remove();
    }
    function showPreview(r){
      const pc = r.plan.priceChanges;
      body.innerHTML = `
        <p style="margin:0 0 6px">Catalogue from <b>${escapeHtml(r.doc.from.name)}</b> for <b>${escapeHtml(r.doc.to.name)}</b> · ${escapeHtml(new Date(r.doc.created_iso).toLocaleString())}</p>
        <p class="muted" style="margin:0 0 8px">Price policy: ${escapeHtml(priceModeLabel(r.doc.price_mode))}</p>
        ${r.warning? `<div class="box" style="margin-bottom:8px;color:#b42318;font-weight:600">${escapeHtml(r.warning)}</div>` : ""}
        <div class="card" style="padding:8px;margin-bottom:8px;font-size:13px">
          <div>${r.plan.inserts.length} new product${r.plan.inserts.length===1?"":"s"} · ${r.plan.updates.length} to update · ${r.plan.unchanged} unchanged</div>
          <div>${r.plan.overwritesPrices? `<b>${pc.length}</b> price${pc.length===1?"":"s"} will change` : "Existing prices are kept (this branch edits its own prices)"}</div>
          ${pc.length? `<div class="muted" style="margin-top:4px">${priceChangeLines(pc,10).map(escapeHtml).join("<br>")}</div>` : ""}
        </div>
        <p class="muted" style="font-size:12px;margin:0 0 8px">Stock is never changed and nothing is deleted. A backup downloads first.</p>
        <div style="display:flex;gap:8px"><button class="btn btn-outline" id="cgCancel">Cancel</button><button class="btn btn-primary" id="cgApply" style="flex:1">Apply</button></div>`;
      body.querySelector("#cgCancel").onclick=()=>wrap.remove();
      const apply = body.querySelector("#cgApply");
      apply.onclick=async ()=>{
        apply.disabled = true;                       // double-tap guard
        try{
          const res = await applyCatalogueImport(r.doc, r.plan);
          body.innerHTML = `<div class="box" style="text-align:center"><p style="font-weight:700;margin:0 0 4px">Catalogue applied</p>
            <p class="muted" style="margin:0">${res.inserted} added · ${res.updated} updated · ${res.priceChanges} price${res.priceChanges===1?"":"s"} changed</p></div>
            <button class="btn btn-primary" id="cgDone" style="margin-top:10px">Done</button>`;
          body.querySelector("#cgDone").onclick=()=>{ wrap.remove(); render(); };
        }catch(e){ showBlocked("The catalogue was not applied and nothing was changed: "+(e.message||e)); }
      };
    }
    wrap.querySelector("#cgFile").onchange=(e)=>{ const f = e.target.files[0]; e.target.value=""; if(f) handle(f); };
    if(file) handle(file);
  }

  // Remote, branch_edits only: a dedicated price-only modal behind the Admin passcode.
  // The full product editor stays locked.
  function openPriceEditModal(product){
    if(!remotePriceEditable()){ alert(remotePriceNote()); return; }
    if(!hasAdminPasscode()){ alert(NO_ADMIN_PASSCODE_MSG); return; }
    const wrap = openModal("Change price", `
      <p style="margin:0 0 4px"><b>${escapeHtml(product.name)}</b></p>
      <p class="muted" style="margin:0 0 8px">${escapeHtml(product.sku||"no code")} · now ${currency}${(product.price||0).toFixed(2)}</p>
      <label style="margin-top:0">New selling price (${escapeHtml(currency)})</label>
      <input class="field" id="peNew" inputmode="decimal" autocomplete="off">
      <label>Admin passcode</label>
      <input class="field" id="pePass" type="password" autocomplete="off" placeholder="Required to change a price">
      <div id="peErr" style="color:#b42318;font-size:12.5px;margin-top:6px"></div>
      <button class="btn btn-primary" id="peSave" style="margin-top:10px">Save price</button>`);
    wrap.querySelector("#peSave").onclick=async ()=>{
      try{
        applyRemotePriceEdit({ productId:product.id, price:wrap.querySelector("#peNew").value, passcode:wrap.querySelector("#pePass").value });
        await persist(); wrap.remove(); render();
      }catch(e){ wrap.querySelector("#peErr").textContent = e.message; }
    };
  }

  // Main, after merging a branch's data file: information only.
  function showBranchPriceDifferences(branchName, diffs){
    if(!diffs || diffs.length===0) return;
    openModal("Branch price differences — "+branchName, `
      <p class="muted" style="margin-top:0">${diffs.length} product${diffs.length===1?"":"s"} at ${escapeHtml(branchName)} ${diffs.length===1?"has":"have"} a different price from main. Information only — nothing was changed.</p>
      <div style="max-height:55vh;overflow:auto"><table class="simple"><tr><th>Code / item</th><th>Main</th><th>Branch</th></tr>
      ${diffs.map(d=>`<tr><td><div class="psku">${escapeHtml(d.code)}</div>${escapeHtml(d.name)}</td><td>${d.main.toFixed(2)}</td><td>${d.branch.toFixed(2)}</td></tr>`).join("")}</table></div>`);
  }
