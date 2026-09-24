  // ---------------- Marketing tab (iTred Market Place export) ----------------
  // The tab itself is always in the nav, in every build. What powers it is a
  // separate, optional layer — dist-market/market.html (build.js --market) —
  // that a shop only has once it's been placed in the SAME folder as this
  // app's index.html. This file hosts that layer and answers its requests.
  // The layer does the screens and the photo resizing; the export file
  // itself is assembled here, from this device's own data.
  //
  // How the layer is loaded and talked to:
  //   * a sandboxed iframe (allow-scripts only), so market.html runs in an
  //     opaque origin: no access to this app's IndexedDB/SQLite, cookies or
  //     DOM, even when both are served from the same host. Everything it
  //     gets comes through the bridge below.
  //   * postMessage, checked by SOURCE WINDOW (not origin — file:// and
  //     sandboxed frames both report "null"), on one channel name.
  //   * "present" means market.html answered a hello within the handshake
  //     window. A missing file (404 page, file-not-found page) never
  //     answers, so it reads as not installed.
  //
  // The layer is stateless on purpose: render() rebuilds $app on every
  // re-render (cart open, nav tap...), which reloads the iframe, so anything
  // worth keeping (selection, city/currency, export status) is saved on
  // this side, in the shop's SQLite.
  //
  // Nothing in this tab or the layer talks to Supabase: the export is a
  // local file the shop sends to Digital Commerce itself.
  const MARKET_FILE = "market.html";
  const MARKET_CHANNEL = "seigen-market";
  const MARKET_BRIDGE_VERSION = 1;
  const MARKET_MAX_PRODUCTS = 200;
  const MARKET_HANDSHAKE_MS = 6000;    // hard cap from iframe creation
  const MARKET_AFTER_LOAD_MS = 1500;   // grace after the frame's load event

  let marketLayerState = "unknown";    // "unknown" | "ready" | "missing" (remembered for the session)
  let marketFrame = null;              // the live <iframe>, while the Marketing route is showing

  function marketingNotInstalledHtml(){
    return `
      <div class="card">
        <p style="margin-top:0"><b>Marketing isn't installed on this device.</b></p>
        <p class="muted">Marketing lets you choose up to ${MARKET_MAX_PRODUCTS} of your products, with photos,
          prices and stock, and prepare them as one file to send to Digital Commerce on WhatsApp.
          Digital Commerce reviews it and lists those products on the iTred Market Place, where customers
          can find your shop and send you orders.</p>
        <p class="muted">Nothing is uploaded automatically. You choose the products, you send the file.</p>
        <div class="hr"></div>
        <p class="muted" style="margin-bottom:0">To turn it on, ask Digital Commerce for the Marketing add-on
          (<b>${MARKET_FILE}</b>) and put it in the same folder as this app, then tap Check again.</p>
      </div>
      <button class="btn btn-outline" id="marketRecheck">Check again</button>`;
  }

  function renderMarketing(main){
    main.innerHTML = `
      <h2>Marketing</h2>
      <div id="marketStatus"></div>
      <iframe id="marketFrame" title="Marketing" sandbox="allow-scripts"
        style="display:block;width:100%;height:0;border:0;background:transparent"></iframe>`;
    const status = document.getElementById("marketStatus");
    if(marketLayerState==="missing"){
      document.getElementById("marketFrame").remove();
      marketFrame = null;
      status.innerHTML = marketingNotInstalledHtml();
      document.getElementById("marketRecheck").onclick = ()=>{ marketLayerState="unknown"; render(); };
      return;
    }
    status.innerHTML = `<p class="muted">Loading Marketing…</p>`;
    marketFrame = document.getElementById("marketFrame");
    const frame = marketFrame;
    let answered = false;
    const giveUp = ()=>{
      if(answered || marketFrame!==frame || !frame.isConnected) return; // answered, or the user has already moved on
      marketLayerState = "missing";
      if(route==="marketing") render();
    };
    const hardTimer = setTimeout(giveUp, MARKET_HANDSHAKE_MS);
    frame.addEventListener("load", ()=> setTimeout(giveUp, MARKET_AFTER_LOAD_MS));
    frame._marketReady = ()=>{
      answered = true; clearTimeout(hardTimer);
      marketLayerState = "ready";
      status.innerHTML = "";
    };
    frame.src = MARKET_FILE;
  }

  // ---- the bridge: the ONLY things market.html can ask this app for ----
  function marketProductRows(){
    return all(`SELECT id, name, sku, price, stock, category,
                       CASE WHEN image IS NOT NULL AND image<>'' THEN 1 ELSE 0 END AS has_image
                  FROM products WHERE branch=? ORDER BY name COLLATE NOCASE`,[currentBranch()])
      .map(r=>({ id:r.id, name:r.name||"", sku:r.sku||"", price:Number(r.price)||0, stock:Number(r.stock)||0,
                 category:r.category||"", hasImage:!!r.has_image }));
  }
  // Keeps only ids that are real products at this branch, de-duplicated, in
  // the order given, and never more than the cap — whatever the layer sends.
  function marketCleanSelection(ids){
    if(!Array.isArray(ids)) throw new Error("Selection must be a list of product ids.");
    const valid = new Set(marketProductRows().map(p=>p.id));
    const out = [];
    for(const x of ids){
      const id = Number(x);
      if(Number.isInteger(id) && valid.has(id) && !out.includes(id)) out.push(id);
      if(out.length>=MARKET_MAX_PRODUCTS) break;
    }
    return out;
  }
  // Saved as a setting (per device, like the rest of Settings) so a re-send
  // a week later starts from the same products.
  function marketSavedSelection(){
    try{ return marketCleanSelection(JSON.parse(getSetting("market_selection","[]"))); }catch(e){ return []; }
  }

  // ---- export file (.scl) ----
  // First data-pack type on the .scl extension (the others move over in a
  // later phase). The content is JSON, like the DN/GRV/catalogue files, and
  // it is shaped for Digital Commerce's manual load into Supabase:
  //   vendor   -> public.vendors      (install_id, business_name, whatsapp_number, city)
  //   listings -> public.vendor_listings, one object per row, same column
  //               names. Columns Digital Commerce sets on review
  //               (vendor_id, published_at, expires_at, status) aren't here.
  //               image_url isn't either: the file carries the photo itself
  //               as image_webp (200x200 WebP data URI, or null) and Digital
  //               Commerce fills image_url once it has hosted it.
  // Values always come from this device's database at build time — the
  // layer only supplies which products, the photos it optimised, and the
  // two one-time settings (city, currency).
  const MARKET_FILE_FORMAT = "seigen.market_export";
  const MARKET_FILE_VERSION = 1;
  const MARKET_FILE_EXT = ".scl";
  const MARKET_WHATSAPP = "+263789487287"; // Digital Commerce marketing line (same number as Help → About)
  const MARKET_LISTING_DAYS = 7;           // vendor_listings expiry: published_at + 7 days
  const MARKET_MAX_IMAGE_CHARS = 150000;   // a 200x200 WebP is ~5-30 KB; anything far bigger isn't one
  const MARKET_IMAGE_PREFIX = "data:image/webp;base64,";

  function marketFileName(exportNo, shopName, date){
    return formatDocNo("MKT",exportNo)+"-"+sanitizeBranchName(shopName)+"-"+fileDatePart(date)+"-"+fileTimePart(date)+MARKET_FILE_EXT;
  }
  function marketNormalizeCurrency(v){
    const c = String(v==null?"":v).trim().toUpperCase();
    if(!/^[A-Z]{3}$/.test(c)) throw new Error("Currency must be a 3-letter code, e.g. USD or ZWG.");
    return c;
  }
  function marketNormalizeCity(v){
    const c = String(v==null?"":v).trim().replace(/\s+/g," ");
    if(!c) throw new Error("Enter the city or town your shop is in.");
    if(c.length>60) throw new Error("City is too long (60 characters at most).");
    return c;
  }
  function marketValidImage(v){
    return typeof v==="string" && v.indexOf(MARKET_IMAGE_PREFIX)===0 && v.length<=MARKET_MAX_IMAGE_CHARS
      && /^[A-Za-z0-9+/=]+$/.test(v.slice(MARKET_IMAGE_PREFIX.length));
  }
  function marketVendorIdentity(){
    return {
      install_id: getSetting("install_id",""),
      business_name: getSetting("shop_name","").trim(),
      whatsapp_number: getSetting("contact_phone","").trim(), // same value cl_device_checkin sends as p_phone
      city: getSetting("market_city",""),
    };
  }
  // Pure: rows + inputs -> file object (without checksum). Rounds to the
  // vendor_listings column scales and clamps what its CHECKs would reject.
  function marketBuildDoc(o){
    const r2 = (n)=> Math.round((Number(n)||0)*100)/100;
    const r3 = (n)=> Math.round((Number(n)||0)*1000)/1000;
    const listings = o.products.map(p=>{
      const name = String(p.name||"").trim();
      if(!name) throw new Error("A selected product has no name. Give it a name in Products first.");
      return {
        source_product_id: String(p.id),
        product_name: name,
        price: Math.max(0, r2(p.price)),
        currency: o.currency,
        category: String(p.category||"").trim() || null,
        stock_quantity: Math.max(0, r3(p.stock)),
        exported_at: o.exportedAt,
        image_webp: o.images[p.id] || null,
      };
    });
    return {
      format: MARKET_FILE_FORMAT, format_version: MARKET_FILE_VERSION,
      export_no: formatDocNo("MKT", o.exportNo),
      created_iso: o.createdIso,
      exported_at: o.exportedAt,
      vendor: o.vendor,
      listings,
      totals: { listings: listings.length, with_image: listings.filter(l=>l.image_webp).length },
    };
  }
  async function marketChecksum(doc){ return sha256Hex(JSON.stringify(doc)); }

  // The finished file text lives in its own IndexedDB store (latest one per
  // branch only), not in the SQLite blob that gets backed up and merged —
  // same reason the DN file store is separate: photos would bloat it.
  const MKF_DB = "seigen_market_files", MKF_STORE = "files";
  function mkfOpen(){
    return new Promise((res,rej)=>{
      const r = indexedDB.open(MKF_DB, 1);
      r.onupgradeneeded = ()=> r.result.createObjectStore(MKF_STORE);
      r.onsuccess = ()=> res(r.result);
      r.onerror = ()=> rej(r.error);
    });
  }
  async function mkfPut(key, rec){
    const conn = await mkfOpen();
    return new Promise((res,rej)=>{
      const tx = conn.transaction(MKF_STORE,"readwrite");
      tx.objectStore(MKF_STORE).put(rec, key);
      tx.oncomplete = ()=>{ conn.close(); res(true); };
      tx.onerror = ()=>{ conn.close(); rej(tx.error); };
    });
  }
  async function mkfGet(key){
    try{
      const conn = await mkfOpen();
      return await new Promise((res,rej)=>{
        const rq = conn.transaction(MKF_STORE,"readonly").objectStore(MKF_STORE).get(key);
        rq.onsuccess = ()=>{ conn.close(); res(rq.result||null); };
        rq.onerror = ()=>{ conn.close(); rej(rq.error); };
      });
    }catch(e){ return null; }
  }

  async function marketBuildExport(args){
    args = args||{};
    const vendor = marketVendorIdentity();
    if(!vendor.install_id) throw new Error("This device has no install ID yet. Finish Setup first.");
    if(!vendor.business_name) throw new Error("Set your shop name in More → Settings first.");
    const city = marketNormalizeCity(args.city);
    const cur = marketNormalizeCurrency(args.currency);
    const ids = marketSavedSelection();
    if(!ids.length) throw new Error("Choose at least one product first.");
    const byId = new Map(all(`SELECT id, name, price, stock, category FROM products WHERE branch=?`,[currentBranch()]).map(p=>[p.id,p]));
    const products = ids.map(id=>byId.get(id)).filter(Boolean);
    // Checked before a number is reserved, so a bad product doesn't burn one.
    if(products.some(p=>!String(p.name||"").trim())) throw new Error("A selected product has no name. Give it a name in Products first.");
    const images = {};
    const sent = (args.images && typeof args.images==="object")? args.images : {};
    for(const p of products){ if(marketValidImage(sent[p.id])) images[p.id] = sent[p.id]; }

    setSetting("market_city", city);
    setSetting("market_currency", cur);
    vendor.city = city;
    const now = new Date();
    const { n } = reserveDocNumber("MKT");
    const doc = marketBuildDoc({ products, images, currency:cur, vendor, exportNo:n,
      createdIso: localIso(now), exportedAt: now.toISOString() });
    doc.checksum = await marketChecksum(doc);
    const text = JSON.stringify(doc);
    const fileName = marketFileName(n, vendor.business_name, now);
    const branch = currentBranch();
    run(`INSERT INTO market_exports(branch,export_no,file_name,product_count,image_count,bytes,checksum,status,exported_ts,sent_ts)
         VALUES(?,?,?,?,?,?,?,'exported',?,'')`,
      [branch, doc.export_no, fileName, doc.totals.listings, doc.totals.with_image, text.length, doc.checksum, now.toISOString()]);
    await persist();
    await mkfPut(branch, { exportNo:doc.export_no, fileName, text });
    return marketStatus();
  }

  // not_exported -> exported (file built, timestamp) -> sent (the shop says
  // so: nothing can see a WhatsApp send succeed). A new export starts over
  // at exported. "expiring" = MARKET_LISTING_DAYS after it was marked sent.
  function marketStatus(){
    const row = one("SELECT * FROM market_exports WHERE branch=? ORDER BY id DESC LIMIT 1",[currentBranch()]);
    if(!row) return { state:"not_exported" };
    const out = { state:row.status, exportNo:row.export_no, fileName:row.file_name, productCount:row.product_count,
      imageCount:row.image_count, exportedTs:row.exported_ts, sentTs:row.sent_ts||"", expiresTs:"", expiring:false };
    if(row.status==="sent" && row.sent_ts){
      const exp = new Date(new Date(row.sent_ts).getTime() + MARKET_LISTING_DAYS*86400000);
      out.expiresTs = exp.toISOString();
      out.expiring = Date.now() >= exp.getTime();
    }
    return out;
  }
  async function marketMarkSent(){
    const row = one("SELECT * FROM market_exports WHERE branch=? ORDER BY id DESC LIMIT 1",[currentBranch()]);
    if(!row) throw new Error("There's no exported file to mark as sent.");
    if(row.status!=="sent"){
      run("UPDATE market_exports SET status='sent', sent_ts=? WHERE id=?",[new Date().toISOString(), row.id]);
      await persist();
    }
    return marketStatus();
  }
  function marketWhatsAppText(){
    const s = marketStatus();
    return "iTred Market Place listing "+(s.exportNo||"")+" from "+getSetting("shop_name","")+" ("+getSetting("install_id","")+").";
  }
  // Same helper every other file handoff uses: share sheet on a phone,
  // Documents/seiGEN/Marketing + folder + WhatsApp chat on desktop (Tauri),
  // plain download otherwise. Returns { method, path? } for the layer to explain.
  async function marketShareExport(){
    const s = marketStatus();
    if(s.state==="not_exported") throw new Error("Prepare the file first.");
    const rec = await mkfGet(currentBranch());
    if(!rec || rec.exportNo!==s.exportNo) throw new Error("The file for "+s.exportNo+" isn't on this device any more. Prepare a fresh file.");
    const msg = marketWhatsAppText();
    const r = await shareDocFile({ fileName:rec.fileName, text:rec.text, folder:"Marketing", title:rec.exportNo,
      phone:MARKET_WHATSAPP, shareText:msg, whatsappText:msg+" (Attach the file from the folder that just opened.)" });
    return { method:r.method, path:r.path||"" };
  }

  const MARKET_OPS = {
    context: ()=>({
      bridgeVersion: MARKET_BRIDGE_VERSION, appVersion: APP_VERSION,
      maxProducts: MARKET_MAX_PRODUCTS, currencySymbol: currency,
      branch: currentBranch(), shopName: getSetting("shop_name",""), isRemote: isRemote(),
    }),
    listProducts: ()=> marketProductRows(),
    getSelection: ()=> marketSavedSelection(),
    setSelection: async (args)=>{
      const ids = marketCleanSelection(args && args.ids);
      setSetting("market_selection", JSON.stringify(ids));
      await persist();
      return ids;
    },
    // Only for a product in the saved selection — the layer can't page
    // through every photo on the device.
    getProductImage: (args)=>{
      const id = Number(args && args.id);
      if(!marketSavedSelection().includes(id)) throw new Error("That product isn't selected.");
      const r = one("SELECT image FROM products WHERE id=? AND branch=?",[id, currentBranch()]);
      return (r && typeof r.image==="string" && r.image.indexOf("data:image/")===0)? r.image : "";
    },
    getExportSetup: ()=>{
      const v = marketVendorIdentity();
      return { installId:v.install_id, businessName:v.business_name, whatsappNumber:v.whatsapp_number,
        city:v.city, currency:getSetting("market_currency","") || "USD", currencySet:!!getSetting("market_currency",""),
        marketWhatsApp:MARKET_WHATSAPP };
    },
    buildExport: (args)=> marketBuildExport(args),
    getStatus: ()=> marketStatus(),
    shareExport: ()=> marketShareExport(),
    openWhatsAppChat: ()=>{ openExternalUrl(waLink(MARKET_WHATSAPP, marketWhatsAppText())); return true; },
    markSent: ()=> marketMarkSent(),
  };

  window.addEventListener("message", (e)=>{
    const frame = marketFrame;
    if(!frame || !frame.contentWindow || e.source!==frame.contentWindow) return;
    const m = e.data;
    if(!m || typeof m!=="object" || m.ch!==MARKET_CHANNEL) return;
    // The frame can be gone by the time an async op finishes (user moved on).
    const reply = (msg)=>{ if(frame.contentWindow) frame.contentWindow.postMessage(Object.assign({ ch:MARKET_CHANNEL }, msg), "*"); };
    if(m.type==="hello"){
      if(typeof frame._marketReady==="function") frame._marketReady();
      reply({ type:"welcome", bridgeVersion:MARKET_BRIDGE_VERSION });
    } else if(m.type==="resize"){
      const h = Math.max(0, Math.min(200000, Math.round(Number(m.height)||0)));
      frame.style.height = h+"px";
    } else if(m.type==="req"){
      const op = Object.prototype.hasOwnProperty.call(MARKET_OPS, m.op)? MARKET_OPS[m.op] : null;
      // shareExport/openWhatsAppChat need a user gesture (share sheet,
      // window.open). A tap inside the layer counts here too: Chrome passes a
      // frame's user activation up to its parent, and it lasts a few seconds.
      Promise.resolve().then(()=>{
        if(!op) throw new Error("Unknown request: "+String(m.op));
        return op(m.args);
      }).then(
        (result)=> reply({ type:"res", id:m.id, ok:true, result }),
        (err)=> reply({ type:"res", id:m.id, ok:false, error:String(err && err.message || err) })
      );
    }
  });
