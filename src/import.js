  // ---------------- Bulk inventory import (Excel/CSV) ----------------
  let _xlsxLoading = null;
  function loadXLSX(){
    if(window.XLSX) return Promise.resolve();
    if(_xlsxLoading) return _xlsxLoading;
    _xlsxLoading = new Promise((resolve, reject)=>{
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      s.onload = ()=> resolve();
      s.onerror = ()=> reject(new Error("Could not load the Excel import library — check your internet connection."));
      document.head.appendChild(s);
    });
    return _xlsxLoading;
  }
  // Header row matches IMPORT_COLUMN_MAP's primary synonym for each field
  // exactly, so a file filled in from this template re-imports with zero
  // "unrecognized column" ambiguity.
  async function downloadImportTemplate(){
    try{
      await loadXLSX();
      const headers = ["SKU","Item Name","Shelf","Search Keywords","Category","Cost","Price","Qty","Low Stock Alert Below"];
      const ws = XLSX.utils.aoa_to_sheet([headers]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Products");
      XLSX.writeFile(wb, "seigen-import-template.xlsx");
    }catch(e){
      alert("Couldn't build the template: " + (e.message||e));
    }
  }
  function normalizeHeader(h){ return String(h||"").trim().toLowerCase().replace(/\s+/g," "); }
  const IMPORT_COLUMN_MAP = {
    sku: ["sku"],
    name: ["item name","name","product name","item"],
    shelf: ["shelf","shelf / location","location","bin"],
    keywords: ["search keywords","keywords","search"],
    category: ["category"],
    cost: ["cost"],
    price: ["price","selling price"],
    qty: ["qty","quantity","stock","stock qty"],
    threshold: ["low stock alert below","low stock","threshold","alert level"]
  };
  function findColumn(headerMap, keys){
    for(const k of keys){ if(headerMap[k]!==undefined) return headerMap[k]; }
    return null;
  }
  // Update Existing / Add New: hasQtyColumn tells the caller whether the
  // file even had a recognizable Qty/Quantity/Stock column at all — a
  // price-or-description-only file (no such column) must never be able to
  // zero out existing stock just because a missing value parsed to 0. See
  // runImport()'s applyQty handling below, and item 6 of the task summary.
  // Spreadsheet numbers arrive either as real numbers (xlsx) or as text
  // (csv, or cells formatted as text). "1,200.50" must read as 1200.5, not
  // parseFloat's silent 1 — thousands separators are stripped only when
  // they're unambiguously thousands separators.
  function importNum(v){
    if(typeof v==="number") return v;
    let s = String(v==null?"":v).trim().replace(/\s/g,"");
    if(/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g,"");
    return s===""? NaN : Number(s);
  }
  // Each row also carries `update`: only the fields an existing product
  // should have overwritten. A column the file doesn't have at all (e.g.
  // Category in an older Items export, or Cost in a Remote branch's export)
  // leaves that field alone rather than blanking it, and a blank numeric
  // cell leaves Cost / Low Stock Alert alone rather than resetting it to
  // 0 / 5. Brand-new products still get the defaulted values.
  function parseImportRows(sheetRows){
    if(sheetRows.length===0) return { rows:[], hasQtyColumn:false };
    const rawHeaders = Object.keys(sheetRows[0]);
    const headerMap = {};
    rawHeaders.forEach(h=> headerMap[normalizeHeader(h)] = h);
    const col = {};
    for(const field in IMPORT_COLUMN_MAP){ col[field] = findColumn(headerMap, IMPORT_COLUMN_MAP[field]); }
    const rows = sheetRows.map((r,i)=>{
      const get = (field)=> col[field]? r[col[field]] : "";
      const text = (field)=> String(get(field)==null? "" : get(field)).trim();
      const name = text("name");
      const priceNum = importNum(get("price"));
      const sku = text("sku");
      const shelf = text("shelf");
      const keywords = text("keywords");
      const category = text("category");
      const costNum = importNum(get("cost"));
      const cost = isNaN(costNum)? 0 : costNum;
      const qtyNum = Math.trunc(importNum(get("qty")));
      const qty = isNaN(qtyNum)? 0 : qtyNum;
      const thresholdNum = Math.trunc(importNum(get("threshold")));
      const threshold = isNaN(thresholdNum)? 5 : thresholdNum;
      let skipReason = null;
      if(!name) skipReason = "missing Item Name";
      else if(isNaN(priceNum)) skipReason = "missing or invalid Price";
      else if(priceNum<0) skipReason = "negative Price";
      const update = { name, price: priceNum };
      if(sku) update.sku = sku;   // blank SKU never wipes an existing one — it's half of the product's identity
      if(col.shelf) update.shelf = shelf;
      if(col.keywords) update.description = keywords;
      if(col.category) update.category = category;
      if(col.cost && !isNaN(costNum)) update.cost = costNum;
      if(col.threshold && !isNaN(thresholdNum)) update.low_threshold = thresholdNum;
      return { rowNum:i+2, name, sku, shelf, keywords, category, cost, price:isNaN(priceNum)?0:priceNum, qty, hasQty:!isNaN(qtyNum), threshold, update, skipReason };
    });
    return { rows, hasQtyColumn: col.qty!==null };
  }
  // Update Existing / Add New's identity rule — the SAME one this app
  // already used for its one existing import mode (SKU first, falling back
  // to name; both scoped to the current branch, per the multi-branch
  // isolation every other product query already follows). Reused as-is,
  // not reimplemented, so this new mode can never disagree with the
  // original import path about what counts as "the same product".
  function findImportMatch(branch, row){
    let existing = null;
    if(row.sku) existing = one("SELECT * FROM products WHERE branch=? AND lower(sku)=lower(?)",[branch,row.sku]);
    if(!existing) existing = one("SELECT * FROM products WHERE branch=? AND lower(name)=lower(?)",[branch,row.name]);
    return existing;
  }
  function importInventoryModal(){
    const wrap = openModal("Update Existing / Add New — Import Inventory from Excel", `
      <p class="muted">Matches each row to an existing product by SKU, then by name — a match is updated in place, anything unmatched is added as new. Products already in your catalogue but missing from the file are left alone (nothing is ever deleted). Columns expected: SKU, Item Name, Shelf, Search Keywords, Category, Cost, Price, Qty, Low Stock Alert Below — all optional except Item Name and Price. Column order and exact wording don't matter; a column left out of the file leaves that detail unchanged on existing products.</p>
      <input class="field" id="impFile" type="file" accept=".xlsx,.xls,.csv">
      <div id="impStatus" class="muted" style="margin-top:8px"></div>
    `);
    const fileInput = wrap.querySelector("#impFile");
    const status = wrap.querySelector("#impStatus");
    fileInput.onchange = async ()=>{
      const file = fileInput.files[0];
      if(!file) return;
      status.textContent = "Reading file…";
      try{
        await loadXLSX();
        const buf = await file.arrayBuffer();
        // raw for CSV: keep SKUs/barcodes as typed ("00123" must not become 123).
        const workbook = XLSX.read(buf, {type:"array", raw:/\.csv$/i.test(file.name)});
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const sheetRows = XLSX.utils.sheet_to_json(sheet, {defval:""});
        const { rows, hasQtyColumn } = parseImportRows(sheetRows);
        renderImportPreview(wrap, rows, hasQtyColumn);
      }catch(e){
        status.textContent = "Couldn't read that file: " + (e.message||e);
      }
    };
  }
  // A row's identity within THIS FILE — same precedence as findImportMatch
  // (SKU, else name) — used only to detect two rows in the same file
  // claiming the same product, never to decide DB matching itself.
  function importRowKey(row){ return row.sku? "sku:"+row.sku.toLowerCase() : "name:"+row.name.toLowerCase(); }
  // Splits the already-parsed rows into: rows to actually apply (first
  // occurrence of each identity wins), duplicates (a later row reusing an
  // earlier row's identity — reported, not silently applied a second time
  // with possibly-conflicting values), and the already-invalid rows
  // parseImportRows() flagged. Pure/read-only — never touches the database.
  function classifyImportRows(rows){
    const skipped = rows.filter(r=>r.skipReason);
    const seen = new Set();
    const toApply = [], duplicates = [];
    rows.filter(r=>!r.skipReason).forEach(r=>{
      const key = importRowKey(r);
      if(seen.has(key)) duplicates.push(r); else { seen.add(key); toApply.push(r); }
    });
    return { toApply, duplicates, skipped };
  }
  function renderImportPreview(wrap, rows, hasQtyColumn){
    const branch = currentBranch();
    const { toApply, duplicates, skipped } = classifyImportRows(rows);
    let addCount=0, updateCount=0;
    toApply.forEach(r=>{ if(findImportMatch(branch,r)) updateCount++; else addCount++; });
    const previewRows = toApply.slice(0,15).map(r=>`
      <tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.sku||"—")}</td><td>${currency}${r.price.toFixed(2)}</td><td>${r.qty}</td></tr>
    `).join("");
    wrap.querySelector(".modal-body").innerHTML = `
      <div class="box">
        <div>${rows.length} record${rows.length===1?"":"s"} read from the file</div>
        <div><b>${addCount}</b> new product${addCount===1?"":"s"} will be added</div>
        <div><b>${updateCount}</b> existing product${updateCount===1?"":"s"} will be updated</div>
        <div><b>${duplicates.length}</b> duplicate row${duplicates.length===1?"":"s"} in this file (same SKU/name as an earlier row) — only the first is applied</div>
        <div><b>${skipped.length}</b> row${skipped.length===1?"":"s"} rejected</div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;margin:10px 0 0;${hasQtyColumn?"":"opacity:.6"}">
        <input type="checkbox" id="impApplyQty" ${hasQtyColumn?"":"disabled"}>
        <span>Also update stock quantity from the Qty column${hasQtyColumn?"":" — no Qty/Quantity/Stock column was found in this file"}</span>
      </label>
      <p class="muted" style="margin:4px 0 0">Off by default: existing stock is left exactly as it is unless you tick this — a price/description-only file should never be able to zero out what's on the shelf.</p>
      ${(duplicates.length||skipped.length)? `<div class="box" style="max-height:140px;overflow-y:auto;margin-top:10px">
        ${duplicates.map(r=>`<div class="muted">Row ${r.rowNum}: duplicate of an earlier row (${escapeHtml(r.sku?"SKU "+r.sku:r.name)}) — not applied</div>`).join("")}
        ${skipped.map(r=>`<div class="muted">Row ${r.rowNum}: rejected — ${escapeHtml(r.skipReason)}</div>`).join("")}
      </div>` : ""}
      ${toApply.length? `<table class="simple" style="margin-top:10px">
        <tr><th>Name</th><th>SKU</th><th>Price</th><th>Qty</th></tr>
        ${previewRows}
      </table>
      ${toApply.length>15? `<p class="muted">…and ${toApply.length-15} more</p>` : ""}` : ""}
      <div class="row" style="margin-top:12px">
        <button class="btn btn-outline" id="impCancel">Cancel</button>
        <button class="btn btn-primary" id="impConfirm" ${toApply.length===0?"disabled":""}>Confirm Import</button>
      </div>
    `;
    wrap.querySelector("#impCancel").onclick = ()=> wrap.remove();
    const confirmBtn = wrap.querySelector("#impConfirm");
    if(confirmBtn) confirmBtn.onclick = ()=>{
      const applyQty = hasQtyColumn && !!wrap.querySelector("#impApplyQty").checked;
      runImport(wrap, { toApply, duplicates, skipped, totalRead: rows.length }, applyQty);
    };
  }
  // Update Existing / Add New. Only ever touches products (and, when the
  // shop opted into it, stock_received — the same audit trail restock/
  // adjust/other-import paths already write to) — no other table. Branch
  // isolation comes for free: findImportMatch() above is already
  // branch-scoped, and every INSERT here stamps currentBranch(), same as
  // productModal()'s own Add Product path.
  function runImport(wrap, batch, applyQty){
    const branch = currentBranch();
    const ts = new Date().toISOString();
    let created=0, updated=0;
    batch.toApply.forEach(r=>{
      const existing = findImportMatch(branch, r);
      if(existing){
        // Quantity is deliberately excluded from this UPDATE unless the
        // shop explicitly opted in (applyQty) — everything else (name,
        // sku, description, category, cost, price, low-stock threshold)
        // is "product master data" and always safe to update in place.
        // Only the fields parseImportRows() put in r.update — columns the
        // file lacks (or blank numeric cells) keep their current values.
        const fields = Object.keys(r.update);
        run("UPDATE products SET "+fields.map(f=>f+"=?").join(",")+" WHERE id=?",
          fields.map(f=>r.update[f]).concat([existing.id]));
        // A blank Qty cell is "no figure given", never "set stock to 0".
        if(applyQty && r.hasQty){
          const delta = r.qty - existing.stock;
          run("UPDATE products SET stock=? WHERE id=?",[r.qty, existing.id]);
          run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES(?,?,?,?,?,?,?)",
            [ts, existing.id, r.name, delta, "Import adjustment", branch, sessionUser||""]);
        }
        updated++;
      } else {
        // A brand-new product always needs a starting stock figure — this
        // is establishing it for the first time, not "changing" an
        // existing quantity, so it's unaffected by the applyQty opt-in.
        run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description,category,shelf) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          [r.name, r.price, r.qty, r.threshold, r.sku, branch, "", r.cost, ts, r.keywords, r.category, r.shelf]);
        const pid = one("SELECT last_insert_rowid() as id").id;
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES(?,?,?,?,?,?,?)",
          [ts, pid, r.name, r.qty, "Import — initial stock", branch, sessionUser||""]);
        created++;
      }
    });
    logAudit("Bulk Import", "", `${created} added, ${updated} updated, ${batch.duplicates.length} duplicate row(s) skipped, ${batch.skipped.length} rejected${applyQty?"":", stock quantity untouched"}`);
    persist();
    wrap.querySelector(".modal-body").innerHTML = `
      <div class="box" style="text-align:center">
        <p style="font-size:16px;font-weight:700;margin:0 0 6px">Import complete</p>
        <p class="muted" style="margin:0">${batch.totalRead} record${batch.totalRead===1?"":"s"} read · ${created} added · ${updated} updated${applyQty?"" : " (quantity untouched)"}</p>
        <p class="muted" style="margin:4px 0 0">${batch.duplicates.length} duplicate row${batch.duplicates.length===1?"":"s"} skipped · ${batch.skipped.length} row${batch.skipped.length===1?"":"s"} rejected</p>
      </div>
      ${(batch.duplicates.length||batch.skipped.length)? `<div class="box" style="max-height:140px;overflow-y:auto;margin-top:10px">
        ${batch.duplicates.map(r=>`<div class="muted">Row ${r.rowNum}: duplicate — not applied</div>`).join("")}
        ${batch.skipped.map(r=>`<div class="muted">Row ${r.rowNum}: rejected — ${escapeHtml(r.skipReason)}</div>`).join("")}
      </div>` : ""}
      <button class="btn btn-primary" id="impDone" style="margin-top:12px">Done</button>
    `;
    wrap.querySelector("#impDone").onclick = ()=>{ wrap.remove(); render(); };
  }
