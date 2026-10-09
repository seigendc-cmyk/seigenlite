  // The Backup & multi-branch merge card is shared between the locked and
  // unlocked Settings views on Remote branches (Section 6) — it's the one
  // section that always has to stay reachable even while locked, since
  // merging in a Main export is how a Remote device receives its first
  // Admin passcode.
  function backupMergeSectionHtml(){
    const hasFolderPicker = !!window.showDirectoryPicker;
    return `
      <div class="card">
        <h3>Backup & multi-branch merge</h3>
        <p class="muted">Export data to share or move to another device. Files are named with the document type and number, where they were saved from, what they cover, and the date and time.</p>
        <label>What to include</label>
        <select class="field" id="exportScope">
          ${exportScopeOptions().map(o=>`<option value="${escapeHtml(o.value)}" ${o.value===(exportScope||currentBranch())?"selected":""}>${escapeHtml(o.label)}</option>`).join("")}
        </select>
        <div class="row" style="margin-bottom:10px">
          <button class="btn btn-primary" id="exportDb">⬇️ Export data file</button>
          <button class="btn btn-ghost" id="shareDb">📲 Share via WhatsApp</button>
        </div>
        <div class="row" style="margin-bottom:10px">
          <button class="btn btn-outline" id="exportItemsXlsx">📊 Export all items to Excel</button>
        </div>
        <div class="hr"></div>
        <h4 style="margin:0 0 4px">Send app log (for audit)</h4>
        <p class="muted">Sends the activity log for the period and branch chosen above, as a file to share when management or an auditor asks for it.</p>
        <div class="row" style="margin-bottom:8px">
          <input class="field" type="date" id="logFrom" value="${localDateStr(new Date(Date.now()-30*864e5))}">
          <input class="field" type="date" id="logTo" value="${localDateStr()}">
        </div>
        <div class="row" style="margin-bottom:${hasFolderPicker?'10px':'0'}">
          <button class="btn btn-outline" id="saveLog">⬇️ Save log</button>
          <button class="btn btn-ghost" id="shareLog">📲 Send log</button>
        </div>
        ${hasFolderPicker? `
          <button class="btn btn-outline" id="chooseExportFolder">📁 Choose export folder (Chrome desktop only)</button>
          <div class="muted" style="margin-top:6px">${exportDirHandle? `Also saving a copy to: ${escapeHtml(exportDirHandle.name)}` : "No folder chosen — exports only download/share as usual."}</div>
        ` : ""}
        <div class="hr"></div>
        <p class="muted">Merge another branch's exported file into this device. Every branch's records stay separate and filterable in Reports. A backup of your current data downloads automatically first.</p>
        <input type="file" id="mergeDb" accept=".sqlite,.db">
        <div class="hr"></div>
        <p class="muted">Or Replace — wipes current data and loads the imported file instead. A backup downloads first.</p>
        <input type="file" id="replaceDb" accept=".sqlite,.db">
        <div class="hr"></div>
        <p class="muted">Updating your product list from a spreadsheet instead of another device's file? Use Products → ⋮ → Import from Excel ("Update Existing / Add New") — it matches by SKU/name, updates matches in place, adds anything new, and never touches customers, sales, or other branches' data.</p>
      </div>`;
  }
  function wireBackupMergeSection(){
    const scopeSel = ()=> (exportScope = document.getElementById("exportScope").value);
    const dataName = (scope)=> docFilename({type:"DataExport", prefix:"EXP", ext:"sqlite", scope});
    document.getElementById("exportScope").onchange = scopeSel;
    document.getElementById("exportDb").onclick=()=>{ const s=scopeSel(); downloadDb(dataName(s), s); };
    document.getElementById("shareDb").onclick=()=>{ const s=scopeSel(); shareOrDownloadDb(dataName(s), s); };
    document.getElementById("exportItemsXlsx").onclick=()=> exportItemsExcel(scopeSel(), false);
    const logArgs = ()=> [scopeSel(), document.getElementById("logFrom").value, document.getElementById("logTo").value];
    document.getElementById("saveLog").onclick=()=> sendAppLog(...logArgs(), false);
    document.getElementById("shareLog").onclick=()=> sendAppLog(...logArgs(), true);
    const folderBtn = document.getElementById("chooseExportFolder");
    if(folderBtn) folderBtn.onclick=async ()=>{
      try{
        exportDirHandle = await window.showDirectoryPicker({mode:"readwrite", id:"seigen-export"});
        await saveExportDirHandle(exportDirHandle);
        render();
      }catch(e){ /* user cancelled the picker */ }
    };
    document.getElementById("mergeDb").onchange=(e)=>{
      const file = e.target.files[0];
      e.target.value = "";
      if(file) onMergePicked(file);
    };
    document.getElementById("replaceDb").onchange=(e)=>{
      const file = e.target.files[0];
      e.target.value = "";
      if(file) onReplacePicked(file);
    };
  }
  function readFileBytes(file){
    return new Promise((res,rej)=>{
      const reader = new FileReader();
      reader.onload = ()=>res(new Uint8Array(reader.result));
      reader.onerror = ()=>rej(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }
  // A Delivery Note is not a data backup. Judged by CONTENT (not name or type),
  // and checked before anything else happens — no pre-merge backup download,
  // no merge, no database change. Receive stock (Phase 3) is offered when it
  // exists in this build; it is handed the same file so nothing is re-picked.
  function showDNInBackupGuard(file, format){
    const isCat = format===CAT_FORMAT, isAck = format===ACK_FORMAT, isCx = format===CANCEL_FORMAT, isGrv = format===GRV_FORMAT || isAck;
    if(isAck || isCx){                       // Phase 5: cancellation files are never data backups either
      const openIt = isAck? typeof openGrvImportWithFile==="function" : typeof openReceiveWithFile==="function";
      const w = openModal(isAck? "This is a cancellation confirmation" : "This is a cancellation notice", `
        <p style="margin:0 0 10px">${isAck? "This is a cancellation confirmation, not a data backup. Use Import in Dispatch history." : "This is a cancellation notice, not a data backup. Use Receive stock."}</p>
        ${openIt? `<button class="btn btn-primary" id="dnGuardReceive">${isAck? "Open Import" : "Open Receive stock"}</button>` : ""}`);
      const b2 = w.querySelector("#dnGuardReceive");
      if(b2) b2.onclick=()=>{ w.remove(); if(isAck) openGrvImportWithFile(file); else openReceiveWithFile(file); };
      return;
    }
    const canOpen = isGrv? typeof openGrvImportWithFile==="function" : isCat? typeof openCatalogueWithFile==="function" : typeof openReceiveWithFile==="function";
    const wrap = openModal(isGrv? "This is a Goods Received Voucher" : isCat? "This is a Catalogue" : "This is a Delivery Note", `
      <p style="margin:0 0 10px">${isGrv? "This is a Goods Received Voucher file, not a data backup. Use Import GRV in Dispatch history." : isCat? "This is a Catalogue, not a data backup. Use Get catalogue." : "This is a Delivery Note, not a data backup. Use Receive stock to receive it."}</p>
      ${canOpen? `<button class="btn btn-primary" id="dnGuardReceive">${isGrv? "Open Import GRV" : isCat? "Open Get catalogue" : "Open Receive stock"}</button>` : ""}`);
    const btn = wrap.querySelector("#dnGuardReceive");
    if(btn) btn.onclick=()=>{ wrap.remove(); if(isCat) openCatalogueWithFile(file); else if(isGrv) openGrvImportWithFile(file); else openReceiveWithFile(file); };
  }
  // Our own JSON formats are never data backups.
  function guardedFormat(bytes){
    const f = sniffJsonFormat(bytes);
    return (f===DN_FORMAT || f===CAT_FORMAT || f===GRV_FORMAT || f===CANCEL_FORMAT || f===ACK_FORMAT)? f : null;
  }
  // A remote branch never takes a data file from a main branch: it carries the
  // main's staff passcodes, costs and every other branch's records. A remote gets
  // its products from the catalogue and its stock from Delivery Notes. Only a
  // file that says it came from a remote is accepted; this also covers Replace,
  // which would otherwise turn the device into a main branch. "" = no problem.
  function mainFileProblem(bytes, what){
    if(!isRemote()) return "";
    let type;
    try{ const imp = new SQL.Database(bytes); type = getSettingX(imp,"branch_type",""); }
    catch(e){ return ""; }                       // not a database at all: the normal path reports that
    if(type==="remote") return "";
    return (type==="main"? "This data file was exported by a main branch." : "This data file doesn't say it came from a remote branch.")
      +" A remote branch can't "+(what||"merge")+" it, because it would copy the main branch's staff passcodes, costs and other branches' records onto this device."
      +" Get products with Get catalogue and stock with Receive stock instead.";
  }
  // Replace also refuses a file that belongs to a differently named branch: the name is locked
  // after setup, and the file's own rows are filed under ITS name. "" = fine.
  function replaceNameProblem(bytes){
    const own = String(getSetting("branch_name","")).trim();
    if(!own) return "";
    let imp;
    try{ const t = new SQL.Database(bytes); imp = getSettingX(t,"branch_name","") || getSettingX(t,"shop_name","") || "Main"; }
    catch(e){ return ""; }
    return imp===own? "" : "This data file belongs to \""+imp+"\", but this device is \""+own+"\". A branch's name is locked after setup, so its data can't be replaced with another branch's file.";
  }
  async function onMergePicked(file){
    let bytes;
    try{ bytes = await readFileBytes(file); }catch(err){ alert("Could not read that file."); return; }
    const gf = guardedFormat(bytes);
    if(gf){ showDNInBackupGuard(file, gf); return; }
    const refused = mainFileProblem(bytes, "merge");
    if(refused){ alert(refused); return; }
    downloadDb(`seigen-backup-before-merge-${new Date().toISOString().replace(/[:.]/g,"-")}.sqlite`);
    try{
      const res = await mergeDatabase(bytes);
      persist(); render();
      alert("Merge complete.");
      if(res && res.priceDiffs && res.priceDiffs.length) showBranchPriceDifferences(res.branch, res.priceDiffs);
    }catch(err){ alert("Could not merge that file. Make sure it's a valid seiGEN Commerce Lite export."); }
  }
  // Replace gets the same guard: handing it a DN would otherwise swap the live
  // database for a non-database before failing.
  async function onReplacePicked(file){
    let bytes;
    try{ bytes = await readFileBytes(file); }catch(err){ alert("Could not read that file."); return; }
    const gf = guardedFormat(bytes);
    if(gf){ showDNInBackupGuard(file, gf); return; }
    const refused = mainFileProblem(bytes, "replace this device's data with") || replaceNameProblem(bytes);
    if(refused){ alert(refused); return; }
    if(!confirm("This will replace ALL current data with the imported file. A backup of your current data downloads first. Continue?")) return;
    downloadDb(`seigen-backup-before-replace-${new Date().toISOString().replace(/[:.]/g,"-")}.sqlite`);
    const ownId = getSetting("branch_id",""), ownCounters = ownId? all("SELECT doc_type,last_no FROM doc_counters WHERE branch_id=?",[ownId]) : [];
    const own = captureDeviceSettings();
    db = new SQL.Database(bytes);
    db.run(SCHEMA); migrate(db);
    keepDeviceIdentity(ownId, ownCounters);
    // another till's seiGEN requests must never go out under this till's name (dispatch-srv.js);
    // this till's own come back with its own backup, and the next pull puts the rest right
    const fileTerminal = getSetting("terminal_id","");
    restoreDeviceSettings(own);
    if(fileTerminal!==own.terminal_id){ try{ run("DELETE FROM srv_pending"); run("DELETE FROM srv_dispatches"); }catch(e){} }
    currency = getSetting("currency","$");
    backfillBranch(db, currentBranch());
    if(typeof refreshLicenceLock==="function") refreshLicenceLock();   // the restored data may end the trial (activation.js)
    await persist();
    render();
    alert("Data imported.");
  }

  // Activation v2: a restore never brings another device's (or an older
  // self's) identity, licence or clock with it. These settings stay the
  // device's own; the clock watermark keeps the higher of the two, so
  // restoring an old backup can't wind the trusted time back.
  const DEVICE_OWN_SETTINGS = ["install_id","device_key","secret_phrase","install_date","licence","licence_serials",
    "activated_until","activated_until_src","licence_v2_since",
    "business_id","business_name","branch_uuid","terminal_branch_name","terminal_is_main","terminal_id","till_code","terminal_label",
    "terminal_inactive","dc_vendor_id","dc_vendor_status"];
  function captureDeviceSettings(){
    const o = {};
    DEVICE_OWN_SETTINGS.forEach(k=>{ o[k] = getSetting(k,""); });
    o.trusted_time_hwm = getSetting("trusted_time_hwm","");
    return o;
  }
  function restoreDeviceSettings(o){
    DEVICE_OWN_SETTINGS.forEach(k=> setSetting(k, o[k]||""));
    const a = Date.parse(o.trusted_time_hwm||""), b = Date.parse(getSetting("trusted_time_hwm",""));
    const hi = [a,b].filter(x=>!isNaN(x));
    if(hi.length) setSetting("trusted_time_hwm", new Date(Math.max(...hi)).toISOString());
  }


  // branch_id is never copied from imported data. If the file carries this device's
  // own id it is kept; otherwise the device's own id is put back (or, if it had
  // none, a fresh one is made). The device's DN/GRV counters are carried over
  // (highest wins), so restoring an older backup can never reuse a number.
  function keepDeviceIdentity(ownId, ownCounters){
    if(ownId){
      if(getSetting("branch_id","")!==ownId) setSetting("branch_id", ownId);
      (ownCounters||[]).forEach(c=>run(`INSERT INTO doc_counters(branch_id,doc_type,last_no) VALUES(?,?,?)
        ON CONFLICT(branch_id,doc_type) DO UPDATE SET last_no=MAX(last_no,excluded.last_no)`,[ownId,c.doc_type,c.last_no]));
    } else resetBranchId();
  }

  const SQLITE_MIME = "application/x-sqlite3";
  function exportScopeOptions(){
    const cur = currentBranch();
    const others = listBranches().filter(b=>b!==cur);
    const opts = [{value:cur, label:`${cur} only (this branch)`}];
    others.forEach(b=> opts.push({value:b, label:`${b} only`}));
    if(others.length) opts.push({value:"*", label:"Both / all branches on this device"});
    return opts;
  }
  // Data file for export. scope: "*" (or omitted) = everything on this device,
  // otherwise a branch name — only that branch's rows are kept, in a throwaway
  // copy, so the live database is untouched.
  function exportBytes(scope){
    if(!scope || scope==="*") return db.export();
    const copy = new SQL.Database(db.export());
    try{
      const run2 = (sql,p=[])=>{ try{ copy.run(sql,p); }catch(e){} };
      ["products","sales","eod_sessions","payouts","credit_payments","stock_received","audit_log",
       "stock_requests","purchases","staff","vouchers","stocktakes","stock_adjustments","stock_movements","credit_notes"].forEach(t=>
        run2(`DELETE FROM ${t} WHERE branch<>?`,[scope]));
      run2("DELETE FROM stock_transfers WHERE from_branch<>? AND to_branch<>?",[scope,scope]);
      run2("DELETE FROM dispatch_docs WHERE dispatch_branch_name<>? AND receive_branch_name<>?",[scope,scope]);
      run2("DELETE FROM dn_events WHERE dn_from_name<>? AND dn_to_name<>?",[scope,scope]);
      run2("DELETE FROM branch_prices WHERE dest_branch_name<>?",[scope]);
      run2("DELETE FROM sale_items WHERE sale_id NOT IN (SELECT id FROM sales)");
      run2("DELETE FROM credit_note_items WHERE cn_id NOT IN (SELECT id FROM credit_notes)");
      run2("DELETE FROM credit_note_refunds WHERE cn_id NOT IN (SELECT id FROM credit_notes)");
      run2("DELETE FROM stocktake_counts WHERE stocktake_id NOT IN (SELECT id FROM stocktakes)");
      run2(`DELETE FROM customers WHERE id NOT IN (SELECT customer_id FROM sales WHERE customer_id IS NOT NULL)
              AND id NOT IN (SELECT customer_id FROM credit_payments WHERE customer_id IS NOT NULL)
              AND id NOT IN (SELECT customer_id FROM vouchers WHERE customer_id IS NOT NULL)
              AND id NOT IN (SELECT customer_id FROM credit_notes WHERE customer_id IS NOT NULL)`);
      return copy.export();
    } finally { copy.close(); }
  }
  function saveFile(bytes, filename, mime){
    const blob = new Blob([bytes], {type:mime});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    saveCopyToExportFolder(bytes, filename);
  }
  function downloadDb(filename, scope){
    saveFile(exportBytes(scope), filename, SQLITE_MIME);
  }
  // Best-effort mirror of an export into the folder chosen via
  // window.showDirectoryPicker() (Section 11) — a no-op when no folder has
  // been chosen, or when the handle's permission has lapsed since.
  async function saveCopyToExportFolder(bytes, filename){
    if(!exportDirHandle) return;
    try{
      // A restored handle needs its permission re-granted after a reload;
      // this runs inside the export click, so the prompt is allowed.
      const opts = {mode:"readwrite"};
      if(await exportDirHandle.queryPermission(opts) !== "granted" &&
         await exportDirHandle.requestPermission(opts) !== "granted") return;
      const fileHandle = await exportDirHandle.getFileHandle(filename, {create:true});
      const writable = await fileHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
    }catch(e){ /* best-effort only */ }
  }
  // Shares the export directly into WhatsApp (or whatever the OS share
  // sheet offers) via the Web Share API when the browser supports sharing
  // files, falling back to the normal download otherwise.
  async function shareOrSaveFile(bytes, filename, mime){
    const file = new File([bytes], filename, {type:mime});
    if(navigator.canShare && navigator.canShare({files:[file]})){
      try{
        await navigator.share({files:[file], title:filename});
        saveCopyToExportFolder(bytes, filename);
        return;
      }catch(e){
        if(e && e.name==="AbortError") return;
      }
    }
    saveFile(bytes, filename, mime);
    alert("Your browser doesn't support direct sharing — the file has been downloaded instead; attach it in WhatsApp manually.");
  }
  const shareOrDownloadDb = (filename, scope)=> shareOrSaveFile(exportBytes(scope), filename, SQLITE_MIME);

  // Items to Excel — same columns as the import template (plus Branch), so an exported list can be edited and imported back. Cost and
  // search keywords are left out on Remote branches, where they're hidden.
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  async function itemsExcelBytes(scope){
    await loadXLSX();
    const items = (!scope || scope==="*")? all("SELECT * FROM products ORDER BY branch,name")
                                        : all("SELECT * FROM products WHERE branch=? ORDER BY name",[scope]);
    const full = !isRemote();
    const data = items.map(p=>{
      const r = {"Branch":p.branch||"", "SKU":p.sku||"", "Item Name":p.name, "Shelf":p.shelf||"", "Category":p.category||""};
      if(full){ r["Search Keywords"]=p.description||""; r["Cost"]=p.cost||0; }
      r["Price"]=p.price; r["Qty"]=p.stock; r["Low Stock Alert Below"]=p.low_threshold;
      return r;
    });
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Items");
    return XLSX.write(wb, {type:"array", bookType:"xlsx"});
  }
  async function exportItemsExcel(scope, share){
    try{
      const bytes = new Uint8Array(await itemsExcelBytes(scope));
      const name = docFilename({type:"ItemList", prefix:"ITM", ext:"xlsx", scope});
      if(share) await shareOrSaveFile(bytes, name, XLSX_MIME); else saveFile(bytes, name, XLSX_MIME);
    }catch(e){
      alert("Couldn't export the item list: " + (e.message||e));
    }
  }

  // App log for audit — the activity log as CSV (opens in Excel) for a date
  // range and branch scope, to send to whoever requested it.
  function appLogCsvBytes(scope, fromTs, toTs){
    const logs = (!scope || scope==="*")
      ? all("SELECT * FROM audit_log WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs])
      : all("SELECT * FROM audit_log WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[scope,fromTs,toTs]);
    const q = (v)=> `"${String(v==null?"":v).replace(/"/g,'""')}"`;
    const lines = [["Date/Time","Branch","User","Action","Item","Details"].map(q).join(",")];
    logs.forEach(a=> lines.push([a.ts,a.branch,a.user,a.action,a.product_name,a.details].map(q).join(",")));
    return { bytes:new TextEncoder().encode("﻿"+lines.join("\r\n")), count:logs.length };
  }
  async function sendAppLog(scope, from, to, share){
    if(!from || !to) return alert("Choose the From and To dates.");
    const day = businessRange(from, to);   // same days as the reports (utils.js); the log keeps UTC timestamps
    const {bytes, count} = appLogCsvBytes(scope, day.fromTs, day.toTs);
    if(count===0) return alert("No activity was logged in that date range.");
    logAudit("Export App Log", "", `${count} entries, ${from} to ${to}, ${scopeLabel(scope)}${share?" (shared)":""}`);
    persist();
    const fd = (iso)=> fileDatePart(new Date(iso+"T00:00:00"));
    const name = docFilename({type:"AppLog", prefix:"LOG", ext:"csv", scope, period:`${fd(from)}-to-${fd(to)}`});
    if(share) await shareOrSaveFile(bytes, name, "text/csv"); else saveFile(bytes, name, "text/csv");
  }

  // ---------------- merge ----------------
  async function mergeDatabase(bytes){
    const refused = mainFileProblem(bytes, "merge");
    if(refused) throw Object.assign(new Error(refused), { code:"MAIN_FILE_REFUSED" });
    const impDb = new SQL.Database(bytes);
    impDb.run(SCHEMA); migrate(impDb);
    const impBranch = getSettingX(impDb,"branch_name","") || getSettingX(impDb,"shop_name","") || "Imported Branch";
    backfillBranch(impDb, impBranch);
    // Multi-terminal Phase 1: every merged row keeps its uid (impDb already
    // has one on every row: migrate() above backfills older files), and rows
    // that carry terminal stamps keep them. A row whose uid is already here
    // is the same row: skipped before the natural-key checks, which are
    // unchanged.
    const byUid = (tbl, uid)=> uid? one(`SELECT id FROM ${tbl} WHERE uid=?`,[uid]) : null;
    const tid = (r)=> r.terminal_id||null, buid = (r)=> r.branch_uuid||null;

    const prodMap = {};
    allX(impDb,"SELECT * FROM products").forEach(p=>{
      const existing = byUid("products",p.uid) || one("SELECT * FROM products WHERE name=? AND branch=?",[p.name,p.branch]);
      if(existing){ prodMap[p.id]=existing.id; }
      else{
        run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description,uid) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          [p.name,p.price,p.stock,p.low_threshold,p.sku||"",p.branch,p.image||"",p.cost||0,p.created_ts||new Date().toISOString(),p.description||"",p.uid||null]);
        prodMap[p.id] = one("SELECT last_insert_rowid() as id").id;
      }
    });

    const custMap = {};
    allX(impDb,"SELECT * FROM customers").forEach(c=>{
      const existing = byUid("customers",c.uid) || one("SELECT * FROM customers WHERE lower(name)=lower(?) AND COALESCE(phone,'')=COALESCE(?,'')",[c.name,c.phone]);
      if(existing){ custMap[c.id]=existing.id; }
      else{
        run("INSERT INTO customers(name,phone,branch,uid) VALUES(?,?,?,?)",[c.name,c.phone,c.branch,c.uid||null]);
        custMap[c.id]=one("SELECT last_insert_rowid() as id").id;
      }
    });

    const saleMap = {}; const newSaleImpIds = new Set(); const mergedTs = new Date().toISOString();
    allX(impDb,"SELECT * FROM sales").forEach(s=>{
      const dup = byUid("sales",s.uid) || one("SELECT id FROM sales WHERE branch=? AND ts=?",[s.branch,s.ts]);
      if(dup){ saleMap[s.id]=dup.id; return; }
      const newCustId = s.customer_id? (custMap[s.customer_id]||null) : null;
      // merged_ts (Phase 3c): a sale brought in by a merge is never returned on this device (returns.js)
      run(`INSERT INTO sales(ts,subtotal,discount,total,method,customer_id,branch,discount_reason,discount_approved_by,discount_status,markup,markup_reason,payment_ref,user,voucher_amount,doc_ref,uid,terminal_id,branch_uuid,receipt_no,merged_ts)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [s.ts,s.subtotal||0,s.discount||0,s.total,s.method,newCustId,s.branch,s.discount_reason||"",s.discount_approved_by||"",s.discount_status||"",s.markup||0,s.markup_reason||"",s.payment_ref||"",s.user||"",s.voucher_amount||0,s.doc_ref||"",s.uid||null,tid(s),buid(s),s.receipt_no||null,mergedTs]);
      saleMap[s.id]=one("SELECT last_insert_rowid() as id").id;
      newSaleImpIds.add(s.id);
    });
    allX(impDb,"SELECT * FROM sale_items").forEach(it=>{
      if(!newSaleImpIds.has(it.sale_id) || byUid("sale_items",it.uid)) return;
      const newProdId = prodMap[it.product_id]||null;
      // discount (Line-Item Discount) wasn't copied before 3c. Rows merged
      // earlier keep discount 0 (a re-merge skips them by uid); their sale's
      // own sales.discount was always copied, so totals were never wrong,
      // only the per-line split.
      run("INSERT INTO sale_items(sale_id,product_id,name,price,qty,cost,discount,uid) VALUES(?,?,?,?,?,?,?,?)",
        [saleMap[it.sale_id], newProdId, it.name, it.price, it.qty, it.cost||0, it.discount||0, it.uid||null]);
    });
    // Same additive rule as sale_items above: a merged-in split-tender sale
    // must bring its per-method payment lines along, or the receiving
    // branch's EOD cash figure and credit balances would silently lose the
    // split-tender breakdown for every sale merged in from another device.
    // impDb already had SCHEMA+migrate() applied above, so even a file from
    // before Multi-Currency Support arrives here with currency/rate/
    // tendered_amount already backfilled (to BASE/1/amount) — never NULL —
    // so a foreign-currency line's real rate/tendered figure always
    // survives the merge, not just its base-currency amount.
    allX(impDb,"SELECT * FROM sale_payments").forEach(p=>{
      if(!newSaleImpIds.has(p.sale_id) || byUid("sale_payments",p.uid)) return;
      run("INSERT INTO sale_payments(sale_id,method,amount,currency,rate,tendered_amount,uid) VALUES(?,?,?,?,?,?,?)",
        [saleMap[p.sale_id], p.method, p.amount||0, p.currency||"BASE", p.rate||1, p.tendered_amount==null? (p.amount||0) : p.tendered_amount, p.uid||null]);
    });

    allX(impDb,"SELECT * FROM payouts").forEach(p=>{
      const dup = byUid("payouts",p.uid) || one("SELECT id FROM payouts WHERE branch=? AND ts=?",[p.branch,p.ts]);
      if(dup) return;
      run("INSERT INTO payouts(ts,amount,reason,branch,user,uid,terminal_id,branch_uuid) VALUES(?,?,?,?,?,?,?,?)",[p.ts,p.amount,p.reason,p.branch,p.user||"",p.uid||null,tid(p),buid(p)]);
    });

    allX(impDb,"SELECT * FROM stock_received").forEach(r=>{
      // Rows linked to a DN/GRV (dispatch and receipt lines) share one timestamp per
      // document, so the old (branch, ts) key would keep only the first line. They
      // are de-duplicated per line instead; every other row keeps the old rule.
      // Stock adjustment ledger rows (Phase 4b) are keyed by (adj_branch_id, adj_no).
      const isAdj = r.adj_no!=null && r.adj_branch_id;
      const linked = r.dn_no!=null;
      const dup = byUid("stock_received",r.uid) || (isAdj
        ? one("SELECT id FROM stock_received WHERE adj_branch_id=? AND adj_no=?",[r.adj_branch_id,r.adj_no])
        : linked
        ? one("SELECT id FROM stock_received WHERE branch=? AND dn_branch_id=? AND dn_no=? AND name=? AND qty=?",[r.branch,r.dn_branch_id,r.dn_no,r.name,r.qty])
        : one("SELECT id FROM stock_received WHERE branch=? AND ts=?",[r.branch,r.ts]));
      if(dup) return;
      const newProdId = prodMap[r.product_id]||null;
      run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user,dn_branch_id,dn_no,grv_no,adj_branch_id,adj_no,uid,terminal_id,branch_uuid,till_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [r.ts,newProdId,r.name,r.qty,r.note,r.branch,r.user||"",linked?r.dn_branch_id:null,linked?r.dn_no:null,r.grv_no==null?null:r.grv_no,
         isAdj?r.adj_branch_id:null,isAdj?r.adj_no:null,r.uid||null,tid(r),buid(r),r.till_code||null]);
    });

    // Stock adjustments (Phase 4b): additive, one row per (branch_id, adj_no), never updated.
    // products.stock is never touched by the merge, so nothing is counted twice.
    allX(impDb,"SELECT * FROM stock_adjustments").forEach(a=>{
      if(!a.branch_id || a.adj_no==null) return;
      if(byUid("stock_adjustments",a.uid) || one("SELECT id FROM stock_adjustments WHERE branch_id=? AND adj_no=?",[a.branch_id,a.adj_no])) return;
      run(`INSERT INTO stock_adjustments(branch,branch_id,adj_no,product_code,product_name,qty_delta,reason,note,by_user,authorised_by,ts,dn_branch_id,dn_no,uid,terminal_id,branch_uuid,till_code)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [a.branch||"",a.branch_id,a.adj_no,a.product_code||"",a.product_name||"",a.qty_delta,a.reason||"",a.note||"",a.by_user||"",a.authorised_by||"",a.ts,
         a.dn_branch_id||null,a.dn_no==null?null:a.dn_no,a.uid||null,tid(a),buid(a),a.till_code||null]);
    });

    // Stock movements (Phase 2): additive, one row per uid, never updated.
    // products.stock is never touched by the merge; the source's movements
    // come with its product snapshot (outside this device's integrity check).
    allX(impDb,"SELECT * FROM stock_movements").forEach(m=>{
      if(!m.uid || byUid("stock_movements",m.uid)) return;
      run(`INSERT INTO stock_movements(uid,terminal_id,branch_uuid,product_id,product_uid,product_code,product_name,branch,qty_delta,kind,doc_type,doc_uid,doc_no,ts,user,note)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [m.uid,tid(m),buid(m),prodMap[m.product_id]||null,m.product_uid||null,m.product_code||"",m.product_name||"",m.branch||"",m.qty_delta,m.kind,
         m.doc_type||"",m.doc_uid||null,m.doc_no||"",m.ts,m.user||"",m.note||""]);
    });

    allX(impDb,"SELECT * FROM credit_payments").forEach(cp=>{
      const dup = byUid("credit_payments",cp.uid) || one("SELECT id FROM credit_payments WHERE branch=? AND ts=?",[cp.branch,cp.ts]);
      if(dup) return;
      const newCustId = custMap[cp.customer_id]||null;
      if(!newCustId) return;
      run("INSERT INTO credit_payments(customer_id,ts,amount,note,branch,user,uid,terminal_id,branch_uuid) VALUES(?,?,?,?,?,?,?,?,?)",[newCustId,cp.ts,cp.amount,cp.note,cp.branch,cp.user||"",cp.uid||null,tid(cp),buid(cp)]);
    });

    allX(impDb,"SELECT * FROM eod_sessions").forEach(e=>{
      // Shift/EOD rows (see eod.js) are matched on started_ts, which is
      // always set and unique per shift — the old expected/counted match
      // below is kept only as a fallback for rows from before shifts
      // existed (no started_ts), where it's still the best available key.
      // The old match alone would miss an OPEN shift's duplicate on a
      // repeat merge, since expected_cash/counted_cash are still NULL then
      // and SQL NULL=NULL never matches.
      const dup = byUid("eod_sessions",e.uid) || one(
        `SELECT id FROM eod_sessions WHERE branch=? AND date=? AND (
           (started_ts<>'' AND started_ts=?) OR (expected_cash=? AND counted_cash=?)
         )`,
        [e.branch,e.date,e.started_ts||"",e.expected_cash,e.counted_cash]);
      if(dup) return;
      run(`INSERT INTO eod_sessions(date,expected_cash,counted_cash,variance,notes,branch,ts,status,opening_float,started_ts,started_by,started_staff_id,closed_ts,closed_by,closed_staff_id,printed_ts,uid,terminal_id,branch_uuid)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [e.date,e.expected_cash,e.counted_cash,e.variance,e.notes||"",e.branch,e.ts||"",
         e.status||"closed",e.opening_float||0,e.started_ts||"",e.started_by||"",e.started_staff_id==null?null:e.started_staff_id,
         e.closed_ts||"",e.closed_by||"",e.closed_staff_id==null?null:e.closed_staff_id,e.printed_ts||"",e.uid||null,tid(e),buid(e)]);
    });

    allX(impDb,"SELECT * FROM audit_log").forEach(a=>{
      const dup = byUid("audit_log",a.uid) || one("SELECT id FROM audit_log WHERE branch=? AND ts=?",[a.branch,a.ts]);
      if(dup) return;
      run("INSERT INTO audit_log(ts,branch,user,action,product_name,details,uid) VALUES(?,?,?,?,?,?,?)",[a.ts,a.branch,a.user||"",a.action,a.product_name,a.details,a.uid||null]);
    });

    allX(impDb,"SELECT * FROM stock_requests").forEach(r=>{
      const dup = byUid("stock_requests",r.uid) || one("SELECT id FROM stock_requests WHERE branch=? AND ts=?",[r.branch,r.ts]);
      if(dup) return;
      run("INSERT INTO stock_requests(ts,branch,user,item_requested,customer_name,customer_phone,qty_wanted,notes,fulfilled,uid) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [r.ts,r.branch,r.user||"",r.item_requested,r.customer_name||"",r.customer_phone||"",r.qty_wanted||null,r.notes||"",r.fulfilled||0,r.uid||null]);
    });

    allX(impDb,"SELECT * FROM stock_transfers").forEach(t=>{
      // Lines that belong to a Delivery Note merge as records only (dn_no is
      // kept, and every pending-receipt query excludes dn_no rows). They are
      // de-duplicated per DN line, because all lines of one DN share a ts.
      const dup = byUid("stock_transfers",t.uid) || (t.dn_no!=null
        ? one("SELECT id FROM stock_transfers WHERE from_branch=? AND dn_no=? AND sku=? AND product_name=?",[t.from_branch,t.dn_no,t.sku||"",t.product_name])
        : one("SELECT id FROM stock_transfers WHERE from_branch=? AND ts=?",[t.from_branch,t.ts]));
      if(dup){
        if(t.dn_branch_id) run("UPDATE stock_transfers SET dn_branch_id=? WHERE id=? AND (dn_branch_id IS NULL OR dn_branch_id='')",[t.dn_branch_id,dup.id]);
        return;
      }
      run(`INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status,received_ts,received_user,dn_no,dn_branch_id,uid)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [t.ts,t.from_branch,t.to_branch,t.product_name,t.sku||"",t.qty,t.note||"",t.user||"",t.status||"Dispatched",t.received_ts||"",t.received_user||"",t.dn_no==null?null:t.dn_no,t.dn_branch_id||null,t.uid||null]);
    });

    // DN events (Phase 4): additive, one row per fact. dispatch_docs itself is
    // NOT merged (its key would clash between the dispatcher's and receiver's rows).
    // event_key de-duplicates: the same fact reaching main from two devices is one row.
    allX(impDb,"SELECT * FROM dn_events").forEach(e=>{
      if(byUid("dn_events",e.uid)) return;
      recordDnEvent({ dnBranchId:e.dn_branch_id, dnNo:e.dn_no, type:e.event_type, actorBranchId:e.actor_branch_id, actorName:e.actor_branch_name,
        fromName:e.dn_from_name, toName:e.dn_to_name, ts:e.event_ts, grvNo:e.grv_no, detail:e.detail_json||"", uid:e.uid||null,
        dnTill:e.dn_till_code||null, grvTill:e.grv_till_code||null });
    });

    // Destination register: main's list of branches (and WhatsApp numbers)
    // reaches Remote devices through this merge. Only ever adds; a number is
    // filled in only where the local entry has none.
    allX(impDb,"SELECT * FROM branch_register").forEach(b=>{
      const ex = one("SELECT * FROM branch_register WHERE name=?",[b.name]);
      if(!ex) run("INSERT INTO branch_register(name,whatsapp) VALUES(?,?)",[b.name,b.whatsapp||""]);
      else if(!ex.whatsapp && b.whatsapp) run("UPDATE branch_register SET whatsapp=? WHERE id=?",[b.whatsapp,ex.id]);
    });

    allX(impDb,"SELECT * FROM staff").forEach(s=>{
      const existing = byUid("staff",s.uid) || one("SELECT * FROM staff WHERE branch=? AND name=?",[s.branch,s.name]);
      if(existing) return;
      run("INSERT INTO staff(name,role,passcode,branch,active,created_ts,uid) VALUES(?,?,?,?,?,?,?)",
        [s.name,s.role||"Cashier",s.passcode||"",s.branch,s.active!==undefined?s.active:1,s.created_ts||new Date().toISOString(),s.uid||null]);
    });

    allX(impDb,"SELECT * FROM vouchers").forEach(v=>{
      const newCustId = custMap[v.customer_id]||null;
      if(!newCustId) return;
      const dup = byUid("vouchers",v.uid) || one("SELECT id FROM vouchers WHERE customer_id=? AND earned_ts=?",[newCustId,v.earned_ts]);
      if(dup) return;
      const newSaleId = v.redeemed_sale_id? (saleMap[v.redeemed_sale_id]||null) : null;
      run("INSERT INTO vouchers(customer_id,amount,branch,earned_ts,status,redeemed_ts,redeemed_sale_id,uid,kind,source_sale_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [newCustId,v.amount,v.branch,v.earned_ts,v.status||"Available",v.redeemed_ts||"",newSaleId,v.uid||null,v.kind||"loyalty",v.source_sale_id? (saleMap[v.source_sale_id]||null) : null]);
    });

    // Credit notes (Phase 3c): main sees a branch's returns and write-offs
    // (owner Q6). Matched by uid; links are re-pointed to the rows here.
    const uidOf = (tbl, id)=> id==null? null : ((oneX(impDb, `SELECT uid FROM ${tbl} WHERE id=?`,[id])||{}).uid || null);
    const localId = (tbl, impId)=>{ const u = uidOf(tbl, impId); const r = u? byUid(tbl, u) : null; return r? r.id : null; };
    allX(impDb,"SELECT * FROM credit_notes ORDER BY id").forEach(c=>{
      if(byUid("credit_notes",c.uid) || one("SELECT id FROM credit_notes WHERE cn_branch_id=? AND cn_no=?",[c.cn_branch_id,c.cn_no])) return;
      run(`INSERT INTO credit_notes(branch,cn_branch_id,cn_no,till_code,sale_id,sale_uid,sale_receipt,customer_id,ts,eod_session_id,reason,reason_note,started_by,started_staff_id,
            approved_by,approved_staff_id,goods_total,voucher_part,cost_reversed,exchange_sale_id,status,uid,terminal_id,branch_uuid) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,NULL,?,NULL,?,?,?,?,?,?,?,?)`,
        [c.branch,c.cn_branch_id,c.cn_no,c.till_code,c.sale_id!=null? (saleMap[c.sale_id]||null) : null,c.sale_uid,c.sale_receipt,c.customer_id? (custMap[c.customer_id]||null) : null,c.ts,
         c.reason,c.reason_note,c.started_by,c.approved_by,c.goods_total,c.voucher_part,c.cost_reversed,c.exchange_sale_id!=null? (saleMap[c.exchange_sale_id]||null) : null,c.status||"posted",c.uid||null,tid(c),buid(c)]);
      const cnId = one("SELECT last_insert_rowid() AS id").id;
      allX(impDb,"SELECT * FROM credit_note_items WHERE cn_id=? ORDER BY id",[c.id]).forEach(i=>{
        run(`INSERT INTO credit_note_items(cn_id,sale_item_id,sale_item_uid,product_id,product_uid,product_code,name,qty,unit_refund,amount,unit_cost,condition,uid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [cnId, i.sale_item_uid? ((byUid("sale_items", i.sale_item_uid)||{}).id||null) : null, i.sale_item_uid, i.product_id? (prodMap[i.product_id]||null) : null, i.product_uid,
           i.product_code, i.name, i.qty, i.unit_refund, i.amount, i.unit_cost, i.condition, i.uid||null]);
      });
      allX(impDb,"SELECT * FROM credit_note_refunds WHERE cn_id=? ORDER BY id",[c.id]).forEach(r=>{
        run(`INSERT INTO credit_note_refunds(cn_id,method,amount,currency,rate,tendered_amount,sale_payment_id,voucher_id,exchange_sale_id,ref,uid) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [cnId, r.method, r.amount, r.currency, r.rate, r.tendered_amount, localId("sale_payments", r.sale_payment_id), localId("vouchers", r.voucher_id),
           r.exchange_sale_id!=null? (saleMap[r.exchange_sale_id]||null) : null, r.ref||"", r.uid||null]);
      });
    });

    // Information for main only: where the branch's prices differ from main's,
    // read straight from the imported file (the merge itself never overwrites
    // an existing product). Nothing here changes any data.
    let priceDiffs = [];
    if(!isRemote()){
      priceDiffs = priceDifferences(
        all("SELECT sku,name,price FROM products WHERE branch=?",[currentBranch()]),
        allX(impDb,"SELECT sku,name,price FROM products WHERE branch=?",[impBranch]));
    }
    return { branch: impBranch, priceDiffs };
  }

