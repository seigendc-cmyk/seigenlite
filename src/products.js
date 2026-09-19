  // Reads an image file, crops it to a square, and re-encodes as WebP.
  function handleImageFile(file, cb){
    const reader = new FileReader();
    reader.onload = ()=>{
      const img = new Image();
      img.onload = ()=>{
        const size=300;
        const canvas=document.createElement("canvas");
        canvas.width=size; canvas.height=size;
        const ctx=canvas.getContext("2d");
        const side = Math.min(img.width,img.height);
        const sx=(img.width-side)/2, sy=(img.height-side)/2;
        ctx.drawImage(img, sx,sy,side,side, 0,0,size,size);
        canvas.toBlob(blob=>{
          const r2 = new FileReader();
          r2.onload=()=> cb(r2.result);
          r2.readAsDataURL(blob);
        }, "image/webp", 0.85);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }
  function printMarketingCard(p){
    document.getElementById("printArea").innerHTML = `
      <div class="report-print" style="text-align:center;max-width:6cm;margin:0 auto">
        <div style="width:1cm;height:1cm;margin:0 auto 8px;overflow:hidden;border:1px solid #ccc;border-radius:2px;">
          ${p.image? `<img src="${p.image}" style="width:100%;height:100%;object-fit:cover">` : ""}
        </div>
        <div style="font-weight:800;color:#E8590C;font-size:13px">${escapeHtml(p.sku||"")}</div>
        <div style="font-weight:700;font-size:16px;margin:2px 0">${escapeHtml(p.name)}</div>
        <div style="font-size:15px">${currency}${p.price.toFixed(2)}</div>
      </div>`;
    printNow(null);
  }

  // Prints an A4 catalogue of the given products — photo, SKU, name, price
  // only. Cost and search keywords are intentionally never included, since
  // this is meant to be handed out or displayed for customers.
  function printCatalogue(products){
    const cards = products.map(p=>`
      <div class="cat-card">
        ${p.image? `<img src="${p.image}">` : `<div class="cat-noimg">No photo</div>`}
        ${p.sku? `<div class="cat-sku">${escapeHtml(p.sku)}</div>` : ""}
        <div class="cat-name">${escapeHtml(p.name)}</div>
        <div class="cat-price">${currency}${p.price.toFixed(2)}</div>
      </div>`).join("");
    document.getElementById("printArea").innerHTML = `
      <div class="report-print">
        <h2><span class="cat-vendor">${escapeHtml(getSetting("shop_name","My Shop"))}</span> — Product Catalogue</h2>
        <div class="sub">${escapeHtml(currentBranch())} · ${new Date().toLocaleDateString()}</div>
        <div class="catalogue-grid">${cards}</div>
        <div class="cat-footer">Powered by seiGEN Commerce Infrastructure · +263774479121 · Terms and conditions apply</div>
      </div>`;
    if(!window._catalogueTipShown){
      window._catalogueTipShown = true;
      alert("For a clean catalogue with no browser date/URL/page-number line: in the print screen, open \"More settings\" and untick \"Headers and footers\" before printing.");
    }
    printNow(null);
  }

  function productModal(existing){
    const isEdit = !!existing;
    if(isRemote()){ alert("This is a remote branch — items are managed by your main branch."); return; }
    const wrap = openModal(isEdit? "Edit Product" : "Add Product", `
      <div id="pImgPreview" style="width:80px;height:80px;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:8px;background:var(--surface)">
        ${existing&&existing.image? `<img src="${existing.image}" style="width:100%;height:100%;object-fit:cover">` : ""}
      </div>
      <label>Product photo (optional)</label>
      <input class="field" id="pImage" type="file" accept="image/*">
      <label>Product name</label>
      <input class="field" id="pName" placeholder="e.g. 2L Cooking Oil" value="${existing?escapeHtml(existing.name):""}">
      <label>SKU</label>
      <input class="field" id="pSku" placeholder="e.g. OIL-2L-001" value="${existing?escapeHtml(existing.sku||""):""}">
      <label>Shelf / Location (optional)</label>
      <input class="field" id="pShelf" placeholder="e.g. Aisle 3, Bin 12" value="${existing?escapeHtml(existing.shelf||""):""}">
      <label>Search keywords (optional)</label>
      <input class="field" id="pDescription" placeholder="e.g. sunflower oil cooking bottled" value="${existing?escapeHtml(existing.description||""):""}">
      <p class="muted" style="margin-top:4px">Not shown anywhere — just extra words to help this item turn up in search.</p>
      <div class="row">
        <div><label>Price (${currency})</label><input class="field" id="pPrice" type="number" step="0.01" value="${existing?existing.price:""}"></div>
        <div><label>Cost (${currency})</label><input class="field" id="pCost" type="number" step="0.01" value="${existing?(existing.cost||0):""}"></div>
      </div>
      <label>Stock qty</label>
      <input class="field" id="pStock" type="number" value="${existing?existing.stock:""}" ${isEdit?"disabled":""}>
      ${isEdit? `<p class="muted">Use +Stock on the product row to change stock (it's logged for the Stock Received report).</p>`:""}
      <label>Low stock alert below</label>
      <input class="field" id="pLow" type="number" value="${existing?existing.low_threshold:"5"}">
      <button class="btn btn-primary" id="pConfirm" style="margin-top:12px">${isEdit?"Save Changes":"Add Product"}</button>
      ${isEdit? `<button class="btn btn-danger" id="pDelete" style="margin-top:8px">Delete Product</button>
      <button class="btn btn-outline" id="pCard" style="margin-top:8px">🖨️ Print Marketing Card</button>` : ""}
    `);
    let newImage = null;
    wrap.querySelector("#pImage").onchange=(e)=>{
      const f = e.target.files[0];
      if(!f) return;
      handleImageFile(f, dataUrl=>{
        newImage = dataUrl;
        wrap.querySelector("#pImgPreview").innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover">`;
      });
    };
    wrap.querySelector("#pConfirm").onclick=()=>{
      const name = wrap.querySelector("#pName").value.trim();
      const sku = wrap.querySelector("#pSku").value.trim();
      const shelf = wrap.querySelector("#pShelf").value.trim();
      const description = wrap.querySelector("#pDescription").value.trim();
      const price = parseFloat(wrap.querySelector("#pPrice").value)||0;
      const cost = parseFloat(wrap.querySelector("#pCost").value)||0;
      const low = parseInt(wrap.querySelector("#pLow").value)||5;
      if(!name) return alert("Enter a product name");
      const image = newImage!==null? newImage : (existing? existing.image||"" : "");
      if(isEdit){
        run("UPDATE products SET name=?,sku=?,shelf=?,price=?,cost=?,low_threshold=?,image=?,description=? WHERE id=?",[name,sku,shelf,price,cost,low,image,description,existing.id]);
        logAudit("Edit Product", name, `Price: ${currency}${price.toFixed(2)}, Cost: ${currency}${cost.toFixed(2)}, Low alert: ${low}`);
      } else {
        const stock = parseInt(wrap.querySelector("#pStock").value)||0;
        const branch = currentBranch();
        run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description,shelf) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          [name,price,stock,low,sku,branch,image,cost,new Date().toISOString(),description,shelf]);
        const pid = one("SELECT last_insert_rowid() as id").id;
        if(stock>0) run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES(?,?,?,?,?,?,?)",
          [new Date().toISOString(), pid, name, stock, "Initial stock", branch, sessionUser||""]);
        logAudit("Add Product", name, `Price: ${currency}${price.toFixed(2)}, Cost: ${currency}${cost.toFixed(2)}, Starting stock: ${stock}`);
      }
      persist(); wrap.remove(); render();
    };
    if(isEdit){
      wrap.querySelector("#pDelete").onclick=()=>{
        if(!confirm(`Delete ${existing.name}? This can't be undone.`)) return;
        run("DELETE FROM products WHERE id=?",[existing.id]);
        logAudit("Delete Product", existing.name, "");
        persist(); wrap.remove(); render();
      };
      wrap.querySelector("#pCard").onclick=()=>{
        const latest = { ...existing, name: wrap.querySelector("#pName").value.trim()||existing.name,
          sku: wrap.querySelector("#pSku").value.trim(), price: parseFloat(wrap.querySelector("#pPrice").value)||existing.price,
          image: newImage!==null? newImage : existing.image };
        printMarketingCard(latest);
      };
    }
  }

  // Same searchable fields as the Sell-screen's searchProducts(): name, SKU,
  // hidden search-keywords (description) — kept as a filter here rather
  // than calling searchProducts() itself, since this list is already
  // branch-scoped and DB-fetched by renderProducts() below.
  function filterProductsList(products, query){
    return products.filter(p=> matchesAnyOrder(query, p.name+" "+(p.sku||"")+" "+(p.description||"")));
  }
  function productsTableHtml(products, remote){
    const priceEdit = remotePriceEditable();
    // Which actions the ⋮ menu offers: a remote never gets edit / add stock, and only
    // gets change-price in branch_edits mode.
    const rowActions = remote? (priceEdit? ["price","adjust"] : ["adjust"]) : ["edit","restock","adjust"];
    if(products.length===0) return `<p class="muted" style="padding:10px 4px">No products match.</p>`;
    return `
      <table class="simple">
        <tr><th></th><th>Item</th><th>Shelf</th><th>Price</th><th>Stock</th><th></th></tr>
        ${products.map(p=>`
          <tr>
            <td><input type="checkbox" class="catCheck" data-cat="${p.id}"></td>
            <td>${p.sku?`<div class="psku">${escapeHtml(p.sku)}</div>`:""}${escapeHtml(p.name)}</td>
            <td>${escapeHtml(p.shelf||"—")}</td>
            <td>${currency}${p.price.toFixed(2)}</td>
            <td>${p.stock}${p.stock<=p.low_threshold?` <span class="pill low">low</span>`:""}</td>
            <td><button class="btn btn-sm btn-outline dots-btn" data-rowmenu="${p.id}" data-actions="${rowActions.join(" ")}" title="Actions">⋮</button></td>
          </tr>`).join("")}
      </table>`;
  }
  // Adjust stock: a dedicated modal on main AND remote (never the full product editor).
  // Every row action lives behind one ⋮ menu so the list stays uncluttered.
  function restockProduct(pid){
    const n = parseInt(prompt("Add how many units?"));
    if(!n) return;
    const prod = one("SELECT * FROM products WHERE id=?",[pid]);
    run("UPDATE products SET stock=stock+? WHERE id=?",[n,pid]);
    run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user) VALUES(?,?,?,?,?,?,?)",
      [new Date().toISOString(), pid, prod.name, n, "Restock", currentBranch(), sessionUser||""]);
    persist(); render();
  }
  function wireProductRowButtons(scope, remote){
    scope.querySelectorAll("[data-rowmenu]").forEach(b=>{
      b.onclick=()=>{
        const pid = +b.dataset.rowmenu;
        const get = ()=> one("SELECT * FROM products WHERE id=?",[pid]);
        const menu = {
          price:   {label:`${currency} Change price`,     fn:()=>{ const p = get(); if(p) openPriceEditModal(p); }},
          edit:    {label:`${ICON_EDIT} Edit`,            fn:()=>{ const p = get(); if(p) productModal(p); }},
          restock: {label:`${ICON_ADD} Add stock`,        fn:()=>restockProduct(pid)},
          adjust:  {label:`${ICON_ADJUST} Adjust stock`,  fn:()=>{ const p = get(); if(p) openAdjustStockModal(p); }}
        };
        showMenu(b, (b.dataset.actions||"").split(" ").filter(k=>menu[k]).map(k=>menu[k]));
      };
    });
  }
  function renderProductsTableOnly(products, remote){
    const target = document.getElementById("productsTableArea");
    if(!target) return;
    target.innerHTML = productsTableHtml(filterProductsList(products, productsQuery), remote);
    wireProductRowButtons(target, remote);
  }
  function renderProducts(main){
    const products = all("SELECT * FROM products WHERE branch=? ORDER BY name",[currentBranch()]);
    const remote = isRemote();
    const pendingTransfers = pendingTransfersCount();
    main.innerHTML = `
      <h2>Products</h2>
      ${remote? `<div class="box" style="margin-bottom:12px">This is a <b>remote branch</b> — items, stock levels, and costs are managed by your main branch. ${escapeHtml(remotePriceNote())}</div>` : ""}
      <div class="search-wrap">
        <span class="ic">🔎</span>
        <input class="field" id="productsSearch" placeholder="Search products or SKU…" value="${escapeHtml(productsQuery)}">
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        ${remote? "" : `<button class="btn btn-sm btn-outline" id="openAddProduct" title="Add Product">${ICON_ADD}</button>`}
        <button class="btn btn-sm btn-outline dots-btn" id="openExcelMenu" title="Excel: import, template, export">⋮</button>
        <button class="btn btn-sm btn-outline" id="openDispatch" title="Dispatch Stock">${ICON_DISPATCH}</button>
        <button class="btn btn-sm btn-outline" id="openDispatchHistory" title="Dispatch history">📋</button>
        ${remote? `<button class="btn btn-sm btn-outline" id="openGetCatalogue" title="Get catalogue from main">📥 Get catalogue</button>` : ""}
        <button class="btn btn-sm btn-outline" id="openReceive" title="Receive stock">${ICON_RECEIVE}</button>
        <button class="btn btn-sm btn-outline" id="openReceipts" title="Receipts history">🧾</button>
        <button class="btn btn-sm btn-outline" id="openAdjustments" title="Adjustments history">${ICON_ADJUST} Adjustments</button>
        ${pendingTransfers>0? `<button class="btn btn-sm btn-outline" id="openLegacyReceive" title="Older transfers from before Delivery Notes">Legacy pending (${pendingTransfers})</button>` : ""}
      </div>
      <div class="row" style="margin-bottom:10px">
        <button class="btn btn-outline" id="selectAllCat">Select all</button>
        <button class="btn btn-ghost" id="printCatalogueBtn">🖨️ Print Catalogue</button>
      </div>
      <div id="productsTableArea">${productsTableHtml(filterProductsList(products, productsQuery), remote)}</div>
    `;
    document.getElementById("productsSearch").oninput=(e)=>{ productsQuery = e.target.value; renderProductsTableOnly(products, remote); };
    let allSelected = false;
    document.getElementById("selectAllCat").onclick=()=>{
      allSelected = !allSelected;
      main.querySelectorAll(".catCheck").forEach(cb=> cb.checked = allSelected);
    };
    document.getElementById("printCatalogueBtn").onclick=()=>{
      const ids = Array.from(main.querySelectorAll(".catCheck:checked")).map(cb=>+cb.dataset.cat);
      if(ids.length===0) return alert("Select at least one product to include in the catalogue");
      const selected = ids.map(id=> one("SELECT * FROM products WHERE id=?",[id]));
      printCatalogue(selected);
    };
    document.getElementById("openDispatch").onclick=()=>openDispatchScreen();
    document.getElementById("openDispatchHistory").onclick=()=>openDispatchHistory();
    const getCat = document.getElementById("openGetCatalogue");
    if(getCat) getCat.onclick=()=>openCatalogueImportScreen();
    document.getElementById("openReceive").onclick=()=>openReceiveScreen();
    document.getElementById("openReceipts").onclick=()=>openReceiptsHistory();
    document.getElementById("openAdjustments").onclick=()=>openAdjustmentsHistory();
    const legacy = document.getElementById("openLegacyReceive");
    if(legacy) legacy.onclick=()=>receiveStockModal();
    document.getElementById("openExcelMenu").onclick=(e)=>{
      const items = [{label:"📊 Export all items to Excel", fn:()=>exportItemsExcel(currentBranch(), false)}];
      if(!remote){
        items.unshift({label:"⬆️ Import from Excel", fn:()=>importInventoryModal()},
                      {label:"📄 Download import template", fn:()=>downloadImportTemplate()});
      }
      showMenu(e.currentTarget, items);
    };
    if(remote){ wireProductRowButtons(main, remote); return; }
    document.getElementById("openAddProduct").onclick=()=>productModal();
    wireProductRowButtons(main, remote);
  }


  // Read-only, cross-branch product browser — distinct from the Products
  // screen (which stays scoped to the current branch for add/edit/restock).
  function productListRowsHtml(results){
    return results.length===0? `<p class="muted" style="padding:10px 4px">No products match.</p>` : `
    <table class="simple">
      <tr><th>Item</th><th>Shelf</th><th>Branch</th><th>Price</th><th>Stock</th></tr>
      ${results.map(p=>{
        const cls = p.stock<=0? "stock-out" : (p.stock<=p.low_threshold? "stock-low" : "");
        return `<tr class="${cls}">
          <td>${skuNameCellScreen(p.sku,p.name)}</td>
          <td>${escapeHtml(p.shelf||"—")}</td>
          <td>${escapeHtml(p.branch)}</td>
          <td>${currency}${p.price.toFixed(2)}</td>
          <td>${p.stock}</td>
        </tr>`;
      }).join("")}
    </table>`;
  }
  function renderProductListResultsOnly(){
    const results = searchProducts(plistQuery, plistBranch);
    const target = document.getElementById("plistResults");
    if(!target) return;
    target.innerHTML = productListRowsHtml(results);
  }
  function renderProductList(main){
    const results = searchProducts(plistQuery, plistBranch);
    main.innerHTML = `
      <div class="search-wrap">
        <span class="ic">🔎</span>
        <input class="field" id="plistSearch" placeholder="Search products or SKU…" value="${escapeHtml(plistQuery)}">
      </div>
      <label>Branch</label>${branchSelectHtml("plistBranchSel", plistBranch)}
      <div style="height:10px"></div>
      <div id="plistResults">${productListRowsHtml(results)}</div>
    `;
    const input = document.getElementById("plistSearch");
    input.oninput = (e)=>{ plistQuery = e.target.value; renderProductListResultsOnly(); };
    document.getElementById("plistBranchSel").onchange = (e)=>{ plistBranch = e.target.value; renderProductListResultsOnly(); };
  }
