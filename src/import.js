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
      const headers = ["SKU","Item Name","Search Keywords","Cost","Price","Qty","Low Stock Alert Below"];
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
    keywords: ["search keywords","keywords","search"],
    cost: ["cost"],
    price: ["price","selling price"],
    qty: ["qty","quantity","stock","stock qty"],
    threshold: ["low stock alert below","low stock","threshold","alert level"]
  };
  function findColumn(headerMap, keys){
    for(const k of keys){ if(headerMap[k]!==undefined) return headerMap[k]; }
    return null;
  }
  function parseImportRows(sheetRows){
    if(sheetRows.length===0) return [];
    const rawHeaders = Object.keys(sheetRows[0]);
    const headerMap = {};
    rawHeaders.forEach(h=> headerMap[normalizeHeader(h)] = h);
    const col = {};
    for(const field in IMPORT_COLUMN_MAP){ col[field] = findColumn(headerMap, IMPORT_COLUMN_MAP[field]); }
    return sheetRows.map((r,i)=>{
      const get = (field)=> col[field]? r[col[field]] : "";
      const name = String(get("name")||"").trim();
      const priceNum = parseFloat(get("price"));
      const sku = String(get("sku")||"").trim();
      const keywords = String(get("keywords")||"").trim();
      const cost = parseFloat(get("cost"))||0;
      const qtyNum = parseInt(get("qty"));
      const qty = isNaN(qtyNum)? 0 : qtyNum;
      const thresholdNum = parseInt(get("threshold"));
      const threshold = isNaN(thresholdNum)? 5 : thresholdNum;
      let skipReason = null;
      if(!name) skipReason = "missing Item Name";
      else if(isNaN(priceNum)) skipReason = "missing or invalid Price";
      return { rowNum:i+2, name, sku, keywords, cost, price:isNaN(priceNum)?0:priceNum, qty, threshold, skipReason };
    });
  }
  function findImportMatch(branch, row){
    let existing = null;
    if(row.sku) existing = one("SELECT * FROM products WHERE branch=? AND lower(sku)=lower(?)",[branch,row.sku]);
    if(!existing) existing = one("SELECT * FROM products WHERE branch=? AND lower(name)=lower(?)",[branch,row.name]);
    return existing;
  }
  function importInventoryModal(){
    const wrap = openModal("Import Inventory from Excel", `
      <p class="muted">Columns expected: SKU, Item Name, Search Keywords (optional), Cost, Price, Qty, Low Stock Alert Below. Column order and exact wording don't matter.</p>
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
        const workbook = XLSX.read(buf, {type:"array"});
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const sheetRows = XLSX.utils.sheet_to_json(sheet, {defval:""});
        const rows = parseImportRows(sheetRows);
        renderImportPreview(wrap, rows);
      }catch(e){
        status.textContent = "Couldn't read that file: " + (e.message||e);
      }
    };
  }
  function renderImportPreview(wrap, rows){
    const branch = currentBranch();
    const valid = rows.filter(r=>!r.skipReason);
    const skipped = rows.filter(r=>r.skipReason);
    let addCount=0, updateCount=0;
    valid.forEach(r=>{ if(findImportMatch(branch,r)) updateCount++; else addCount++; });
    const previewRows = valid.slice(0,15).map(r=>`
      <tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.sku||"—")}</td><td>${currency}${r.price.toFixed(2)}</td><td>${r.qty}</td></tr>
    `).join("");
    wrap.querySelector(".modal-body").innerHTML = `
      <div class="box">
        <div><b>${addCount}</b> new product${addCount===1?"":"s"} will be added</div>
        <div><b>${updateCount}</b> existing product${updateCount===1?"":"s"} will be updated</div>
        <div><b>${skipped.length}</b> row${skipped.length===1?"":"s"} skipped</div>
      </div>
      ${skipped.length? `<div class="box" style="max-height:120px;overflow-y:auto">
        ${skipped.map(r=>`<div class="muted">Row ${r.rowNum}: ${escapeHtml(r.skipReason)}</div>`).join("")}
      </div>` : ""}
      ${valid.length? `<table class="simple">
        <tr><th>Name</th><th>SKU</th><th>Price</th><th>Qty</th></tr>
        ${previewRows}
      </table>
      ${valid.length>15? `<p class="muted">…and ${valid.length-15} more</p>` : ""}` : ""}
      <div class="row" style="margin-top:12px">
        <button class="btn btn-outline" id="impCancel">Cancel</button>
        <button class="btn btn-primary" id="impConfirm" ${valid.length===0?"disabled":""}>Confirm Import</button>
      </div>
    `;
    wrap.querySelector("#impCancel").onclick = ()=> wrap.remove();
    const confirmBtn = wrap.querySelector("#impConfirm");
    if(confirmBtn) confirmBtn.onclick = ()=> runImport(wrap, valid);
  }
  function runImport(wrap, rows){
    const branch = currentBranch();
    const ts = new Date().toISOString();
    let added=0, updated=0;
    rows.forEach(r=>{
      const existing = findImportMatch(branch, r);
      if(existing){
        const delta = r.qty - existing.stock;
        run("UPDATE products SET name=?,sku=?,description=?,cost=?,price=?,low_threshold=?,stock=? WHERE id=?",
          [r.name, r.sku, r.keywords, r.cost, r.price, r.threshold, r.qty, existing.id]);
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES(?,?,?,?,?,?,?)",
          [ts, existing.id, r.name, delta, "Import adjustment", branch, sessionUser||""]);
        updated++;
      } else {
        run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
          [r.name, r.price, r.qty, r.threshold, r.sku, branch, "", r.cost, ts, r.keywords]);
        const pid = one("SELECT last_insert_rowid() as id").id;
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES(?,?,?,?,?,?,?)",
          [ts, pid, r.name, r.qty, "Import — initial stock", branch, sessionUser||""]);
        added++;
      }
    });
    logAudit("Bulk Import", "", `${added} added, ${updated} updated`);
    persist();
    wrap.querySelector(".modal-body").innerHTML = `
      <div class="box" style="text-align:center">
        <p style="font-size:16px;font-weight:700;margin:0 0 6px">Import complete</p>
        <p class="muted" style="margin:0">${added} added, ${updated} updated</p>
      </div>
      <button class="btn btn-primary" id="impDone" style="margin-top:12px">Done</button>
    `;
    wrap.querySelector("#impDone").onclick = ()=>{ wrap.remove(); render(); };
  }
