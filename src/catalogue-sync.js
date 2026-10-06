  // ================== Catalogue sync (multi-terminal Phase 3a) ==================
  // Main's product catalogue and prices flow through Digital Commerce to every
  // till of the business. Design: docs/multi-terminal/phase3a-design.md.
  // Server: supabase/migrations/20261006120000_catalogue_sync.sql.
  //
  //   * Push (main-branch tills): a trigger (db.js migrateCatalogueSync) marks
  //     a changed product cat_dirty=1 with a fresh op_id; catPushProducts sends
  //     dirty rows 100 at a time. A replay of the same op_id is a no-op on the
  //     server, so a retry after a lost answer never duplicates anything.
  //   * Prices: cat_outbox holds branch prices / policies waiting to be sent.
  //   * Pull (every registered till): cl_catalogue_pull from a server cursor,
  //     applied in batches of 200 between sales. Stock is never touched.
  //   * Pictures: thumbnails in their own IndexedDB store (never inside the
  //     sql.js file, which is re-saved whole on every persist), keyed by
  //     cat_uid + picture version, downloaded in the background after the
  //     text sync, and only with this till's picture switch on.
  //   * First sync: a report is shown before anything changes on a device that
  //     already has products.
  // Unregistered devices: none of this runs.

  const CAT_PULL_LIMIT = 500, CAT_PUSH_BATCH = 100, CAT_PRICE_BATCH = 200, CAT_APPLY_BATCH = 200, CAT_PIC_BATCH = 50;
  const CAT_POLL_MS = 5*60*1000;

  function catRegistered(){ return !!getSetting("terminal_id",""); }
  function catIsMainTill(){ return getSetting("terminal_is_main","")==="1"; }
  function catBranch(){ return getSetting("cat_branch","") || currentBranch(); }
  function catBaselineDone(){ return getSetting("cat_baseline","")==="done"; }
  function catNewOp(){
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, x=>x.toString(16).padStart(2,"0")).join("");
  }
  const catTick = ()=> new Promise(r=>setTimeout(r,0));
  function catRpc(name, extra){ return terminalRpc(name, Object.assign(terminalAuth(), extra||{})); }

  // Plain-English line for a failed call (Settings, Sync now).
  function catProblemText(r){
    if(!r) return "";
    if(r.reason==="offline") return "You're offline. Products and prices will update when you're back online. Selling isn't affected.";
    if(r.reason==="network") return "Couldn't reach Digital Commerce. It will try again. Selling isn't affected.";
    if(r.code==="TERMINAL_INACTIVE") return TERMINAL_INACTIVE_TEXT;
    if(r.code==="NOT_MAIN") return "Only tills at the main branch can change products.";
    const m = String(r.message||"");
    if(/secret phrase does not match/i.test(m)) return "This device's activation phrase doesn't match what Digital Commerce has. Check it in Settings → Activation secret phrase.";
    if(/registered to another device/i.test(m)) return "Digital Commerce has this install ID registered to another device. Contact Digital Commerce to re-admit this device.";
    if(/not registered|not a registered till/i.test(m)) return "This device isn't registered on Digital Commerce yet (Settings → Business & Terminals).";
    return "Digital Commerce couldn't sync the catalogue ("+(m||r.code||"unknown reason")+"). It will try again.";
  }
  function catNoteFailure(r){
    if(r && r.code==="TERMINAL_INACTIVE") setSetting("terminal_inactive","1");
    setSetting("cat_last_error", catProblemText(r));
  }

  // ---- prices on this till ----
  // Main-branch tills sell at main's price. Elsewhere, per the branch's policy
  // (pulled from the server): follow_main -> main's price; main_sets and
  // branch_edits -> this branch's price when one is set, else main's.
  function catEffectivePrice(mainPrice, catUid){
    const main = catRound(Number(mainPrice)||0);
    if(catIsMainTill()) return main;
    const mode = getSetting("price_mode","follow_main");
    if(mode!=="main_sets" && mode!=="branch_edits") return main;
    const bp = one("SELECT price FROM cat_branch_prices WHERE cat_uid=?",[catUid]);
    return (bp && bp.price!==null && bp.price!==undefined)? catRound(Number(bp.price)) : main;
  }
  // A price this till changed and hasn't sent yet keeps its local value.
  function catPricePending(catUid){
    return !!one("SELECT 1 AS x FROM cat_outbox WHERE kind='price' AND cat_uid=? AND dest_name=?",[catUid, currentBranch()]);
  }
  function catRecomputePrice(catUid){
    if(catPricePending(catUid)) return;
    all("SELECT id, cat_main_price, price FROM products WHERE cat_uid=? AND branch=?",[catUid, catBranch()]).forEach(p=>{
      if(p.cat_main_price===null || p.cat_main_price===undefined) return;
      const np = catEffectivePrice(p.cat_main_price, catUid);
      if(catRound(Number(p.price)||0)!==np) run("UPDATE products SET price=? WHERE id=?",[np, p.id]);
    });
  }

  // ---- applying pulled rows (synchronous; the caller owns the transaction) ----
  // Match: cat_uid first, then the product code among this branch's not-yet-linked
  // products (only when exactly one has it). Never touches stock.
  function catFindLocal(r){
    const branch = catBranch();
    let p = one("SELECT * FROM products WHERE cat_uid=? AND branch=?",[r.uid, branch]);
    if(!p && catCode(r.code)){
      const m = all("SELECT * FROM products WHERE branch=? AND cat_uid IS NULL AND lower(trim(sku))=?",[branch, catCode(r.code)]);
      if(m.length===1) p = m[0];
    }
    return p;
  }
  function catApplyProduct(r, mainTill){
    const p = catFindLocal(r);
    if(p && mainTill && p.cat_dirty===1) return "kept";     // a local edit waits to be pushed; the later arrival wins on the server
    const cost = mainTill? Number(r.cost)||0 : null;
    if(!p){
      if(!r.active) return "skipped";                        // nothing to sell and no history here
      const price = catEffectivePrice(r.price, r.uid);
      run(`INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description,shelf,category,
             cat_uid,cat_seq,active,image_hash,image_bytes,cat_main_price)
           VALUES(?,?,0,?,?,?,'',?,?,?,?,?,?,?,1,?,?,?)`,
        [r.name, price, r.low_threshold==null?5:r.low_threshold, r.code||"", catBranch(), cost||0, new Date().toISOString(),
         r.description||"", r.shelf||"", r.category||"", r.uid, r.seq, r.image_hash||null, r.image_bytes||0, catRound(Number(r.price)||0)]);
      return "added";
    }
    const price = catPricePending(r.uid)? p.price : catEffectivePrice(r.price, r.uid);
    run(`UPDATE products SET name=?, sku=?, description=?, category=?, shelf=?, low_threshold=?, price=?, cost=COALESCE(?,cost),
           active=?, image_hash=?, image_bytes=?, cat_uid=?, cat_seq=?, cat_main_price=? WHERE id=?`,
      [r.name, r.code||"", r.description||"", r.category||"", r.shelf||"", r.low_threshold==null?5:r.low_threshold, price, cost,
       r.active?1:0, r.image_hash||null, r.image_bytes||0, r.uid, r.seq, catRound(Number(r.price)||0), p.id]);
    return "updated";
  }
  function catApplyBranchPrice(r){
    run(`INSERT INTO cat_branch_prices(cat_uid,price,seq) VALUES(?,?,?)
         ON CONFLICT(cat_uid) DO UPDATE SET price=excluded.price, seq=excluded.seq`,[r.uid, r.price===null||r.price===undefined? null : Number(r.price), r.seq]);
    catRecomputePrice(r.uid);
  }
  // One page from cl_catalogue_pull, in batches of CAT_APPLY_BATCH, each its own
  // transaction, yielding in between so a sale can run. The cursor is saved
  // only after the whole page is in (a crash re-applies it: idempotent).
  async function catApplyPage(page){
    const mainTill = !!page.is_main;
    const counts = { added:0, updated:0, kept:0, skipped:0, prices:0 };
    const batch = async (rows, fn)=>{
      for(let i=0;i<rows.length;i+=CAT_APPLY_BATCH){
        db.run("BEGIN");
        try{
          setSetting("cat_applying","1");
          rows.slice(i, i+CAT_APPLY_BATCH).forEach(fn);
          setSetting("cat_applying","");
          db.run("COMMIT");
        }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
        await catTick();
      }
    };
    if(!mainTill && page.price_mode && CAT_PRICE_MODES.includes(page.price_mode) && page.price_mode!==getSetting("price_mode","")){
      setSetting("price_mode", page.price_mode);
      await batch(all("SELECT DISTINCT cat_uid FROM products WHERE cat_uid IS NOT NULL AND branch=?",[catBranch()]), r=>catRecomputePrice(r.cat_uid));
    }
    await batch(page.products||[], r=>{ counts[catApplyProduct(r, mainTill)]++; });
    await batch(page.prices||[], r=>{ catApplyBranchPrice(r); counts.prices++; });
    if(page.branch_id && !getSetting("branch_uuid","")) setSetting("branch_uuid", page.branch_id);
    setSetting("cat_cursor", String(page.cursor||0));
    return counts;
  }
  async function catPull(onProgress){
    let cursor = Number(getSetting("cat_cursor","0"))||0;
    const total = { added:0, updated:0, kept:0, skipped:0, prices:0, rows:0 };
    for(let guard=0; guard<1000; guard++){
      const r = await catRpc("cl_catalogue_pull", { p_cursor:cursor, p_limit:CAT_PULL_LIMIT });
      if(!r.ok) return Object.assign(r, { total });
      const c = await catApplyPage(r.data);
      Object.keys(c).forEach(k=>total[k]+=c[k]);
      total.rows += (r.data.products||[]).length + (r.data.prices||[]).length;
      if(onProgress) onProgress("Updating products… "+total.rows);
      await persist();
      cursor = r.data.cursor;
      if(!r.data.more) break;
    }
    setSetting("cat_last_pull_ts", new Date().toISOString());
    return { ok:true, total };
  }

  // ---- push (main-branch tills) ----
  // The catalogue thumbnail of a product's own picture (dn-browser.js), and its version.
  async function catThumbFor(p){ return await getThumb(p); }
  async function catPushProducts(onProgress){
    if(!catIsMainTill() || !catBaselineDone()) return { ok:true, sent:0, overwrote:0, refused:0 };
    // Products created on this till since the last push (any path: Add, Excel import,
    // purchase) join the catalogue under their own uid.
    run("UPDATE products SET cat_uid=uid, cat_dirty=1, cat_op=lower(hex(randomblob(16))) WHERE branch=? AND cat_uid IS NULL AND uid IS NOT NULL",[catBranch()]);
    const out = { ok:true, sent:0, overwrote:0, refused:0, overwroteNames:[] };
    for(let guard=0; guard<500; guard++){
      const rows = all("SELECT * FROM products WHERE branch=? AND cat_dirty=1 AND cat_uid IS NOT NULL ORDER BY id LIMIT ?",[catBranch(), CAT_PUSH_BATCH]);
      if(!rows.length) break;
      const payload = [];
      for(const p of rows){
        if(!p.cat_op){ p.cat_op = catNewOp(); run("UPDATE products SET cat_op=? WHERE id=?",[p.cat_op, p.id]); }
        const row = { uid:p.cat_uid, op_id:p.cat_op, code:p.sku||"", name:p.name, description:p.description||"", category:p.category||"",
          shelf:p.shelf||"", price:catRound(Number(p.price)||0), cost:catRound(Number(p.cost)||0), low_threshold:p.low_threshold==null?5:p.low_threshold,
          active:p.active!==0, base_seq:p.cat_seq||null, image_hash:null };
        if(p.image){
          let thumb = null; try{ thumb = await catThumbFor(p); }catch(e){}
          if(thumb){
            row.image_hash = await sha256Hex(thumb);
            if(p.cat_img_sent!==row.image_hash) row.image = thumb;
          } else row.image_hash = p.cat_img_sent || null;      // couldn't make one now: keep what the server has
        }
        payload.push(row);
      }
      const r = await catRpc("cl_catalogue_push", { p_rows:payload });
      if(!r.ok) return Object.assign(r, { sent:out.sent });
      const byUid = new Map(payload.map((x,i)=>[x.uid, { row:x, p:rows[i] }]));
      let progressed = false;
      (r.data.results||[]).forEach(res=>{
        const it = byUid.get(res.uid); if(!it) return;
        if(res.status==="applied" || res.status==="duplicate"){
          run("UPDATE products SET cat_dirty=0, cat_seq=?, cat_img_sent=?, image_hash=?, cat_error='' WHERE id=? AND cat_op=?",
            [res.seq, it.row.image_hash, it.row.image_hash, it.p.id, it.row.op_id]);
          out.sent++; progressed = true;
          if(res.overwrote){ out.overwrote++; out.overwroteNames.push(it.p.name); }
        } else if(res.reason==="NEED_IMAGE"){
          run("UPDATE products SET cat_img_sent=NULL WHERE id=?",[it.p.id]); progressed = true;
        } else {
          run("UPDATE products SET cat_dirty=2, cat_error=? WHERE id=? AND cat_op=?",[res.reason||"refused", it.p.id, it.row.op_id]);
          out.refused++; progressed = true;
        }
      });
      if(onProgress) onProgress("Sending products… "+out.sent);
      await persist();
      if(!progressed) break;
    }
    setSetting("cat_last_push_ts", new Date().toISOString());
    if(out.overwrote) setSetting("cat_last_overwrote", out.overwroteNames.slice(0,3).join(", ")+(out.overwrote>3? " +"+(out.overwrote-3)+" more" : ""));
    return out;
  }

  // ---- price outbox ----
  function catQueuePrice(destName, catUid, price){
    if(!catRegistered() || !catUid) return;
    run(`INSERT INTO cat_outbox(kind,dest_name,cat_uid,price,mode,op_id,created_ts,error) VALUES('price',?,?,?,NULL,?,?,'')
         ON CONFLICT(kind,dest_name,cat_uid) DO UPDATE SET price=excluded.price, op_id=excluded.op_id, created_ts=excluded.created_ts, error=''`,
      [destName, catUid, price===null||price===undefined? null : Number(price), catNewOp(), new Date().toISOString()]);
  }
  function catQueueMode(destName, mode){
    if(!catRegistered() || !catIsMainTill()) return;
    run(`INSERT INTO cat_outbox(kind,dest_name,cat_uid,price,mode,op_id,created_ts,error) VALUES('mode',?,'',NULL,?,?,?,'')
         ON CONFLICT(kind,dest_name,cat_uid) DO UPDATE SET mode=excluded.mode, op_id=excluded.op_id, created_ts=excluded.created_ts, error=''`,
      [destName, mode, catNewOp(), new Date().toISOString()]);
  }
  // Main: every branch price and policy it holds (first sync).
  function catQueueAllBranchPrices(){
    all("SELECT name, price_mode FROM branch_register").forEach(b=>{
      if(sameBranchName(b.name, currentBranch())) return;
      catQueueMode(b.name, b.price_mode||"follow_main");
    });
    all("SELECT dest_branch_name, code, price FROM branch_prices").forEach(bp=>{
      const p = one("SELECT cat_uid FROM products WHERE branch=? AND lower(trim(sku))=? AND cat_uid IS NOT NULL",[catBranch(), catCode(bp.code)]);
      if(p) catQueuePrice(bp.dest_branch_name, p.cat_uid, bp.price);
    });
  }
  function catOutboxCounts(){
    const r = one("SELECT COUNT(*) c, SUM(CASE WHEN error='WAITING_BRANCH' THEN 1 ELSE 0 END) w FROM cat_outbox WHERE error NOT IN ('NOT_ALLOWED','UNKNOWN_BRANCH')");
    const waiting = all("SELECT DISTINCT dest_name FROM cat_outbox WHERE error='WAITING_BRANCH'").map(x=>x.dest_name);
    return { pending:(r&&r.c)||0, waiting };
  }
  async function catPushOutbox(){
    const rows = all("SELECT * FROM cat_outbox WHERE error NOT IN ('NOT_ALLOWED','UNKNOWN_BRANCH') ORDER BY kind DESC, created_ts");
    if(!rows.length) return { ok:true, sent:0 };
    const ownName = currentBranch(), ownId = getSetting("branch_uuid","");
    let branches = [];
    if(catIsMainTill()){
      const l = await catRpc("cl_branch_list", {});
      if(!l.ok) return l;
      branches = (l.data && l.data.branches) || [];
      setSetting("cat_server_branches", JSON.stringify(branches.map(b=>b.name)));
    }
    const idFor = (name)=> sameBranchName(name, ownName)? ownId : ((branches.find(b=>sameBranchName(b.name, name))||{}).id || "");
    let sent = 0;
    // policies first, so a branch's own price push is allowed once its policy is branch_edits
    for(const m of rows.filter(x=>x.kind==="mode")){
      const id = idFor(m.dest_name);
      if(!id){ run("UPDATE cat_outbox SET error='WAITING_BRANCH' WHERE kind='mode' AND dest_name=?",[m.dest_name]); continue; }
      const r = await catRpc("cl_branch_set_price_mode", { p_branch_id:id, p_mode:m.mode });
      if(!r.ok){ if(r.reason==="offline"||r.reason==="network") return r; run("UPDATE cat_outbox SET error=? WHERE kind='mode' AND dest_name=?",[r.code||"refused", m.dest_name]); continue; }
      run("DELETE FROM cat_outbox WHERE kind='mode' AND dest_name=? AND op_id=?",[m.dest_name, m.op_id]); sent++;
    }
    const prices = rows.filter(x=>x.kind==="price").map(x=>Object.assign({ branch_id:idFor(x.dest_name) }, x));
    prices.filter(x=>!x.branch_id).forEach(x=>run("UPDATE cat_outbox SET error='WAITING_BRANCH' WHERE kind='price' AND dest_name=? AND cat_uid=?",[x.dest_name, x.cat_uid]));
    const ready = prices.filter(x=>x.branch_id);
    for(let i=0;i<ready.length;i+=CAT_PRICE_BATCH){
      const chunk = ready.slice(i, i+CAT_PRICE_BATCH);
      const r = await catRpc("cl_branch_price_push", { p_rows: chunk.map(x=>({ branch_id:x.branch_id, product_uid:x.cat_uid, price:x.price, op_id:x.op_id })) });
      if(!r.ok) return Object.assign(r, { sent });
      (r.data.results||[]).forEach((res,j)=>{
        const x = chunk[j]; if(!x) return;
        if(res.status==="applied" || res.status==="duplicate"){ run("DELETE FROM cat_outbox WHERE kind='price' AND dest_name=? AND cat_uid=? AND op_id=?",[x.dest_name, x.cat_uid, x.op_id]); sent++; }
        else if(res.reason==="UNKNOWN_PRODUCT") run("UPDATE cat_outbox SET error='WAITING_PRODUCT' WHERE kind='price' AND dest_name=? AND cat_uid=?",[x.dest_name, x.cat_uid]);
        else run("UPDATE cat_outbox SET error=? WHERE kind='price' AND dest_name=? AND cat_uid=?",[res.reason||"refused", x.dest_name, x.cat_uid]);
      });
    }
    await persist();
    return { ok:true, sent };
  }

  // ---- pictures: a separate IndexedDB store, never the sql.js file ----
  const CATPIC_DB = "seigen_cat_pics", CATPIC_STORE = "pics";
  let _catPicKeys = null;                 // Set of "<cat_uid>|<image_hash>" this device holds
  const _catPicMem = new Map();           // fallback when there is no IndexedDB (tests, old webviews)
  const catPicKey = (uid, hash)=> uid+"|"+hash;
  function catPicIdb(){ return typeof indexedDB!=="undefined" && indexedDB; }
  function catPicOpen(){
    return new Promise((res,rej)=>{
      const r = indexedDB.open(CATPIC_DB, 1);
      r.onupgradeneeded = ()=> r.result.createObjectStore(CATPIC_STORE);
      r.onsuccess = ()=> res(r.result);
      r.onerror = ()=> rej(r.error);
    });
  }
  async function catPicTx(mode, fn){
    const conn = await catPicOpen();
    return new Promise((res,rej)=>{
      const tx = conn.transaction(CATPIC_STORE, mode), st = tx.objectStore(CATPIC_STORE);
      let out; const set = (v)=>{ out = v; };
      fn(st, set);
      tx.oncomplete = ()=>{ conn.close(); res(out); };
      tx.onerror = ()=>{ conn.close(); rej(tx.error); };
    });
  }
  async function catPicLoadKeys(){
    if(_catPicKeys) return _catPicKeys;
    if(!catPicIdb()){ _catPicKeys = new Set(_catPicMem.keys()); return _catPicKeys; }
    try{ const keys = await catPicTx("readonly", (st,set)=>{ const rq = st.getAllKeys(); rq.onsuccess = ()=>set(rq.result||[]); }); _catPicKeys = new Set(keys||[]); }
    catch(e){ _catPicKeys = new Set(); }
    return _catPicKeys;
  }
  async function catPicPut(uid, hash, data){
    const keys = await catPicLoadKeys(), k = catPicKey(uid, hash);
    const old = [...keys].filter(x=>x.indexOf(uid+"|")===0 && x!==k);   // an older version of this product's picture
    if(!catPicIdb()){ old.forEach(x=>_catPicMem.delete(x)); _catPicMem.set(k, data); }
    else await catPicTx("readwrite", (st)=>{ old.forEach(x=>st.delete(x)); st.put(data, k); });
    old.forEach(x=>keys.delete(x)); keys.add(k);
  }
  async function catPicGet(k){
    if(!catPicIdb()) return _catPicMem.get(k)||null;
    try{ return await catPicTx("readonly", (st,set)=>{ const rq = st.get(k); rq.onsuccess = ()=>set(rq.result||null); }); }catch(e){ return null; }
  }
  async function catPicClear(){
    if(!catPicIdb()) _catPicMem.clear();
    else await catPicTx("readwrite", (st)=>{ st.clear(); });
    _catPicKeys = new Set();
  }
  // Default: on for the desktop build, off for phones (owner, 2026-10-06).
  function catPicsEnabled(){
    const v = getSetting("cat_pics","");
    if(v==="") return typeof isDesktopBuild==="function" && isDesktopBuild();
    return v==="1";
  }
  // Pictures this till should have but doesn't: this branch's active catalogue
  // products with a picture version and no picture of their own.
  async function catPicsNeeded(){
    const keys = await catPicLoadKeys();
    return all(`SELECT cat_uid, image_hash, image_bytes FROM products WHERE branch=? AND cat_uid IS NOT NULL AND image_hash IS NOT NULL
                AND COALESCE(active,1)=1 AND COALESCE(image,'')=''`,[catBranch()])
      .filter(p=>!keys.has(catPicKey(p.cat_uid, p.image_hash)));
  }
  // The first download waits for the shop's OK, with its estimated size; later
  // ones (only new or changed pictures) run without asking.
  async function catDownloadPictures(onProgress, force){
    if(!catPicsEnabled()) return { ok:true, fetched:0 };
    const need = await catPicsNeeded();
    if(!need.length) return { ok:true, fetched:0 };
    if(getSetting("cat_pics_ok","")!=="1" && !force){
      const bytes = need.reduce((s,p)=>s+(p.image_bytes||0),0);
      catState.picsPrompt = { count:need.length, bytes };
      return { ok:true, fetched:0, prompt:catState.picsPrompt };
    }
    catState.picsPrompt = null;
    setSetting("cat_pics_ok","1");
    let fetched = 0;
    for(let i=0;i<need.length;i+=CAT_PIC_BATCH){
      if(!catPicsEnabled()) break;
      const chunk = need.slice(i, i+CAT_PIC_BATCH);
      const r = await catRpc("cl_catalogue_images_pull", { p_uids: chunk.map(p=>p.cat_uid) });
      if(!r.ok) return Object.assign(r, { fetched });
      for(const im of (r.data.images||[])){
        if(typeof im.data!=="string" || im.data.indexOf("data:image/")!==0) continue;
        if(await sha256Hex(im.data)!==im.image_hash) continue;         // damaged in transit: try again next time
        await catPicPut(im.uid, im.image_hash, im.data); fetched++;
      }
      if(onProgress) onProgress("Downloading pictures… "+fetched+" / "+need.length);
      catPicHydrate();
    }
    return { ok:true, fetched };
  }
  // Display: a product's own picture as today; else a downloaded catalogue
  // picture, filled in after rendering; else the caller's placeholder.
  function catPicHtml(p, attrs, placeholder){
    if(p.image) return `<img ${attrs} src="${p.image}">`;
    if(p.cat_uid && p.image_hash && _catPicKeys && _catPicKeys.has(catPicKey(p.cat_uid, p.image_hash)))
      return `<img ${attrs} data-cat-pic="${escapeHtml(catPicKey(p.cat_uid, p.image_hash))}" alt="">`;
    return placeholder;
  }
  function catPicHydrate(root){
    if(typeof document==="undefined" || !document.querySelectorAll) return;
    (root||document).querySelectorAll("img[data-cat-pic]:not([src])").forEach(async img=>{
      const data = await catPicGet(img.getAttribute("data-cat-pic"));
      if(data) img.src = data;
    });
  }
  let _catPicObserver = null;
  function startCatPicObserver(){
    if(_catPicObserver || typeof MutationObserver==="undefined" || typeof document==="undefined" || !document.body) return;
    _catPicObserver = new MutationObserver(()=>catPicHydrate());
    _catPicObserver.observe(document.body, { childList:true, subtree:true });
  }

  // ---- first sync (baseline) ----
  const catState = { running:null, progress:"", baseline:null, picsPrompt:null, lastChanged:0 };
  async function catFetchAll(onProgress){
    let cursor = 0; const prods = [], prices = []; let meta = null;
    for(let guard=0; guard<1000; guard++){
      const r = await catRpc("cl_catalogue_pull", { p_cursor:cursor, p_limit:CAT_PULL_LIMIT });
      if(!r.ok) return r;
      prods.push(...(r.data.products||[])); prices.push(...(r.data.prices||[]));
      meta = r.data; cursor = r.data.cursor;
      if(onProgress) onProgress("Reading the catalogue… "+prods.length);
      if(!r.data.more) break;
    }
    return { ok:true, prods, prices, meta, cursor };
  }
  // What the first sync would do, before anything changes.
  function catBaselinePlan(serverProds, local, mainTill, mode){
    const live = serverProds.filter(s=>s.active);
    const byCode = new Map();
    local.forEach(p=>{ const k = catCode(p.sku); if(!k) return; if(!byCode.has(k)) byCode.set(k,[]); byCode.get(k).push(p); });
    const plan = { mainTill, mode:mode||"follow_main", serverCount:live.length, localCount:local.length,
      matched:[], added:[], nameChanges:[], priceChanges:[], localOnly:[], dupCodes:[], noCode:[], upload:[] };
    const used = new Set();
    live.forEach(s=>{
      const k = catCode(s.code), g = k? byCode.get(k) : null;
      if(g && g.length===1){
        const p = g[0]; used.add(p.id);
        plan.matched.push({ id:p.id, uid:s.uid, code:s.code, name:s.name });
        if(p.name!==s.name) plan.nameChanges.push({ code:s.code, old:p.name, new:s.name });
        if(!mainTill && catRound(Number(p.price)||0)!==catRound(Number(s.price)||0))
          plan.priceChanges.push({ id:p.id, uid:s.uid, code:s.code, name:s.name, old:catRound(Number(p.price)||0), new:catRound(Number(s.price)||0) });
      } else if(g && g.length>1){ g.forEach(p=>used.add(p.id)); plan.dupCodes.push({ code:s.code, names:g.map(p=>p.name) }); }
      else plan.added.push({ uid:s.uid, code:s.code, name:s.name });
    });
    byCode.forEach((g,k)=>{ if(g.length>1 && !plan.dupCodes.some(d=>catCode(d.code)===k)) { g.forEach(p=>used.add(p.id)); plan.dupCodes.push({ code:g[0].sku, names:g.map(p=>p.name) }); } });
    local.filter(p=>!used.has(p.id)).forEach(p=>{
      const it = { id:p.id, code:p.sku||"", name:p.name };
      if(mainTill) plan.upload.push(it); else plan.localOnly.push(it);
      if(!catCode(p.sku)) plan.noCode.push(it);
    });
    return plan;
  }
  async function catPrepareBaseline(onProgress){
    const f = await catFetchAll(onProgress);
    if(!f.ok) return f;
    const mainTill = !!(f.meta && f.meta.is_main);
    const local = all("SELECT * FROM products WHERE branch=? AND COALESCE(active,1)=1",[currentBranch()]);
    const plan = catBaselinePlan(f.prods, local, mainTill, f.meta && f.meta.price_mode);
    catState.baseline = { plan, prods:f.prods, prices:f.prices, meta:f.meta, cursor:f.cursor, preparedTs:new Date().toISOString() };
    return { ok:true, plan };
  }
  // Applies the prepared first sync. opts.keepLocalPrices (branch_edits only,
  // Admin-checked by the caller): this branch's differing prices are kept and
  // sent as its own branch prices instead of taking main's.
  async function catApplyBaseline(opts){
    opts = opts||{};
    const b = catState.baseline;
    if(!b) throw new Error("Prepare the first sync again.");
    const plan = b.plan, mainTill = plan.mainTill;
    setSetting("cat_branch", currentBranch());
    if(!mainTill && b.meta && b.meta.price_mode) setSetting("price_mode", b.meta.price_mode);
    // 1. link matches (by code) to the catalogue identity
    db.run("BEGIN");
    try{
      setSetting("cat_applying","1");
      plan.matched.forEach(m=>run("UPDATE products SET cat_uid=? WHERE id=?",[m.uid, m.id]));
      if(!mainTill && opts.keepLocalPrices && plan.mode==="branch_edits")
        plan.priceChanges.forEach(pc=>catQueuePrice(currentBranch(), pc.uid, pc.old));
      setSetting("cat_applying","");
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
    // 2. the catalogue itself, in batches (never stock)
    await catApplyPage({ products:b.prods, prices:b.prices, is_main:mainTill, price_mode:b.meta? b.meta.price_mode : "", branch_id:b.meta? b.meta.branch_id : "", cursor:b.cursor });
    // 3. main-branch till: everything of this branch not in the catalogue yet joins it
    if(mainTill){
      run("UPDATE products SET cat_uid=uid, cat_dirty=1, cat_op=lower(hex(randomblob(16))) WHERE branch=? AND cat_uid IS NULL AND uid IS NOT NULL",[catBranch()]);
      catQueueAllBranchPrices();
    }
    setSetting("cat_baseline","done");
    setSetting("cat_baseline_report", JSON.stringify(catReportSummary(plan)));
    logAudit("Catalogue first sync","",(mainTill? plan.upload.length+" to upload, " : plan.localOnly.length+" only at this branch, ")
      +plan.matched.length+" matched, "+plan.added.length+" added, "+plan.noCode.length+" without a code");
    catState.baseline = null;
    await persist();
    return plan;
  }
  function catReportSummary(plan){
    const cut = (a)=>a.slice(0,200);
    return { ts:new Date().toISOString(), mainTill:plan.mainTill, mode:plan.mode, serverCount:plan.serverCount, localCount:plan.localCount,
      matched:plan.matched.length, added:cut(plan.added), nameChanges:cut(plan.nameChanges), priceChanges:cut(plan.priceChanges),
      localOnly:cut(plan.localOnly), dupCodes:cut(plan.dupCodes), noCode:cut(plan.noCode), upload:plan.upload.length,
      counts:{ added:plan.added.length, nameChanges:plan.nameChanges.length, priceChanges:plan.priceChanges.length,
               localOnly:plan.localOnly.length, dupCodes:plan.dupCodes.length, noCode:plan.noCode.length } };
  }
  // Main's products without a code, at any time (Q6: add codes before remotes sync).
  function catProductsWithoutCode(){
    return all("SELECT id, name FROM products WHERE branch=? AND COALESCE(active,1)=1 AND trim(COALESCE(sku,''))='' ORDER BY name",[currentBranch()]);
  }

  // ---- one sync ----
  // -> { ok, message, needsReport?, changed, sent, refused, overwrote, picsPrompt? }
  async function catalogueSyncNow(opts){
    opts = opts||{};
    if(!catRegistered()) return { ok:false, message:"Register this device first (Settings → Business & Terminals)." };
    if(catState.running) return catState.running;
    const progress = (t)=>{ catState.progress = t; if(opts.onProgress) opts.onProgress(t); };
    catState.running = (async()=>{
      try{
        let baselineAdded = 0;
        if(!catBaselineDone()){
          const pr = await catPrepareBaseline(progress);
          if(!pr.ok){ catNoteFailure(pr); return { ok:false, message:catProblemText(pr) }; }
          const p = pr.plan;
          // Nothing local to report on: apply at once (a new till, or a main with an empty server and no products).
          if(p.localCount===0){ await catApplyBaseline({}); baselineAdded = p.added.length; }
          else { setSetting("cat_last_error",""); return { ok:true, needsReport:true, plan:p }; }
        }
        const pushed = await catPushProducts(progress);
        if(!pushed.ok){ catNoteFailure(pushed); return { ok:false, message:catProblemText(pushed) }; }
        const ob = await catPushOutbox();
        if(!ob.ok){ catNoteFailure(ob); return { ok:false, message:catProblemText(ob) }; }
        const pulled = await catPull(progress);
        if(!pulled.ok){ catNoteFailure(pulled); return { ok:false, message:catProblemText(pulled) }; }
        setSetting("cat_last_error","");
        const changed = baselineAdded + pulled.total.added + pulled.total.updated + pulled.total.prices;
        catState.lastChanged = changed;
        const pics = await catDownloadPictures(progress, false);
        // Phase 3b: shared branch stock follows the catalogue (shared-stock.js)
        const stock = typeof stockSyncNow==="function"? await stockSyncNow({}) : null;
        await persist();
        return { ok:true, changed, sent:pushed.sent, refused:pushed.refused, overwrote:pushed.overwrote, picsPrompt:pics.prompt||null, stock,
                 picsFetched:pics.fetched||0, picsError: pics.ok? "" : catProblemText(pics) };
      }catch(e){
        setSetting("cat_last_error", "Catalogue sync stopped: "+(e.message||e)+". It will try again.");
        return { ok:false, message:String(e.message||e) };
      }finally{ catState.running = null; catState.progress = ""; }
    })();
    return catState.running;
  }

  // Status for Settings and the Products screen.
  function catalogueSyncStatus(){
    const own = currentBranch();
    const n = (sql, p)=> (one(sql, p)||{}).c||0;
    return {
      registered: catRegistered(), mainTill: catIsMainTill(), baselineDone: catBaselineDone(),
      lastPullTs: getSetting("cat_last_pull_ts",""), lastPushTs: getSetting("cat_last_push_ts",""), error: getSetting("cat_last_error",""),
      products: n("SELECT COUNT(*) c FROM products WHERE branch=? AND cat_uid IS NOT NULL AND COALESCE(active,1)=1",[own]),
      pending: n("SELECT COUNT(*) c FROM products WHERE branch=? AND cat_dirty=1",[own]) + n("SELECT COUNT(*) c FROM products WHERE branch=? AND cat_uid IS NULL AND ?='1' AND ?='done'",[own, getSetting("terminal_is_main",""), getSetting("cat_baseline","")]),
      refused: all("SELECT name, cat_error FROM products WHERE branch=? AND cat_dirty=2 ORDER BY name LIMIT 20",[own]),
      outbox: catOutboxCounts(), overwrote: getSetting("cat_last_overwrote",""),
      running: !!catState.running, progress: catState.progress,
      picsEnabled: catPicsEnabled(), picsPrompt: catState.picsPrompt,
      report: (()=>{ try{ return JSON.parse(getSetting("cat_baseline_report","")||"null"); }catch(e){ return null; } })(),
    };
  }
  function catStatusLine(s){
    if(!s.registered) return "";
    if(s.running) return s.progress || "Syncing…";
    if(!s.baselineDone) return "First catalogue sync: review the report before anything changes.";
    const when = s.lastPullTs? new Date(s.lastPullTs).toLocaleString() : "not yet";
    const parts = ["Catalogue synced "+when, s.products+" product"+(s.products===1?"":"s")];
    if(s.pending) parts.push(s.pending+" change"+(s.pending===1?"":"s")+" waiting to send");
    if(s.outbox.pending) parts.push(s.outbox.pending+" price change"+(s.outbox.pending===1?"":"s")+" waiting");
    return parts.join(" · ");
  }

  // ---- background ----
  let _catTimer = null;
  async function catBackgroundTick(){
    if(typeof document==="undefined" || !document.body) return;          // a page only (tests drive catalogueSyncNow directly)
    if(!catRegistered() || !isOnline() || catState.running) return;
    const r = await catalogueSyncNow({});
    if(r && r.ok && r.changed>0) catToast("Catalogue updated: "+r.changed+" change"+(r.changed===1?"":"s"));
    // Redraw only when nobody is in the middle of something: no dialog or menu
    // open and no field being typed in (a cashier's search must keep its focus).
    if(r && (r.changed>0 || r.picsFetched>0 || r.needsReport) && catSafeToRedraw()) render();
  }
  function catSafeToRedraw(){
    if(typeof document==="undefined" || !document.querySelector) return false;
    if(document.querySelector(".modalOverlay, .popmenu")) return false;
    const a = document.activeElement;
    return !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  function startCatalogueSync(){
    if(_catTimer) return;
    catPicLoadKeys().then(()=>catPicHydrate()).catch(()=>{});
    startCatPicObserver();
    setTimeout(catBackgroundTick, 4000);
    _catTimer = setInterval(catBackgroundTick, CAT_POLL_MS);
    if(typeof window!=="undefined" && window.addEventListener) window.addEventListener("online", catBackgroundTick);
  }
  function catToast(text){
    if(typeof document==="undefined" || !document.body || document.querySelector(".sync-toast")) return;
    const el = document.createElement("div");
    el.className = "sync-toast cat-toast"; el.setAttribute("role","status");
    el.innerHTML = `<span class="sync-toast-dot"></span><span>${escapeHtml(text)}</span>`;
    document.body.appendChild(el); void el.offsetWidth; el.classList.add("show");
    setTimeout(()=>{ el.classList.remove("show"); setTimeout(()=>{ try{ el.remove(); }catch(e){} }, 250); }, 4000);
  }

  // ---- screens ----
  function catFmtBytes(n){ return n>=1048576? (n/1048576).toFixed(1)+" MB" : Math.max(1,Math.round(n/1024))+" KB"; }
  // The block inside Settings → Business & Terminals (registered tills).
  function catalogueSyncCardHtml(){
    const s = catalogueSyncStatus();
    if(!s.registered) return "";
    const noCode = s.mainTill? catProductsWithoutCode() : [];
    return `
      <div class="hr"></div>
      <h4 style="margin:0 0 6px">Product catalogue</h4>
      <p class="muted" id="catStatus" style="margin:0 0 6px">${escapeHtml(catStatusLine(s))}</p>
      ${s.error? `<p class="cat-error" style="margin:0 0 6px;color:var(--danger);font-weight:600">${escapeHtml(s.error)}</p>` : ""}
      ${s.overwrote? `<p class="muted" style="margin:0 0 6px">Your change to ${escapeHtml(s.overwrote)} replaced a newer change from another till.</p>` : ""}
      ${s.refused.length? `<p style="margin:0 0 6px;color:#b54708">${s.refused.length} product${s.refused.length===1?"":"s"} not sent: ${escapeHtml(s.refused.map(r=>r.name+(r.cat_error==="DUPLICATE_CODE"?" (code already used)":"")).slice(0,5).join(", "))}. Fix ${s.refused.length===1?"it":"them"} in Products.</p>` : ""}
      ${s.outbox.waiting.length? `<p class="muted" style="margin:0 0 6px">Branch prices for ${escapeHtml(s.outbox.waiting.join(", "))} wait until ${s.outbox.waiting.length===1?"that branch is":"those branches are"} added on Digital Commerce (Add a terminal).</p>` : ""}
      ${s.mainTill && noCode.length? `<p style="margin:0 0 6px;color:#b54708">${noCode.length} product${noCode.length===1?" has":"s have"} no code: <span class="cat-nocode">${escapeHtml(noCode.slice(0,8).map(p=>p.name).join(", "))}${noCode.length>8? " +"+(noCode.length-8)+" more" : ""}</span>. Branches that already have ${noCode.length===1?"it":"them"} can't match ${noCode.length===1?"it":"them"} until a code is added.</p>` : ""}
      ${s.picsPrompt? `<div class="box" id="catPicsPrompt" style="margin:0 0 8px">Download ${s.picsPrompt.count} product picture${s.picsPrompt.count===1?"":"s"} (about ${escapeHtml(catFmtBytes(s.picsPrompt.bytes))})?
          <div style="display:flex;gap:6px;margin-top:6px"><button class="btn btn-sm btn-primary" id="catPicsYes">Download</button><button class="btn btn-sm btn-outline" id="catPicsNo">Not now</button></div></div>` : ""}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-sm btn-primary" id="catSyncNow" ${s.running?"disabled":""}>${s.baselineDone? "Sync now" : "Start first sync"}</button>
        ${s.report? `<button class="btn btn-sm btn-outline" id="catReportBtn">First sync report</button>` : ""}
      </div>
      <label class="cat-pics-row" style="display:flex;align-items:center;gap:8px;margin-top:10px;font-weight:600">
        <input type="checkbox" id="catPicsSwitch" ${s.picsEnabled?"checked":""} style="width:auto"> Download product pictures
      </label>
      <p class="muted" style="font-size:12px;margin:2px 0 0">Kept apart from your sales data. Only new or changed pictures are downloaded.
        <button class="btn btn-sm btn-ghost" id="catPicsRemove" style="padding:2px 6px">Remove downloaded pictures</button></p>
      <div id="catMsg" class="muted" style="font-size:12.5px;margin-top:6px"></div>
      ${s.mainTill && typeof openBranchOnlyProducts==="function"? `<button class="btn btn-sm btn-ghost" id="catBranchOnly" style="margin-top:6px;padding:2px 6px">Products only at branches</button>` : ""}
      ${typeof sharedStockStatusHtml==="function"? sharedStockStatusHtml() : ""}`;
  }
  function wireCatalogueSyncCard(){
    const btn = document.getElementById("catSyncNow");
    if(!btn) return;
    const msg = (t, bad)=>{ const el = document.getElementById("catMsg"); if(el){ el.textContent = t||""; el.style.color = bad? "var(--danger)" : ""; } };
    btn.onclick = async ()=>{
      btn.disabled = true; btn.textContent = "Syncing…";
      const r = await catalogueSyncNow({ onProgress:(t)=>{ const el = document.getElementById("catStatus"); if(el) el.textContent = t; } });
      if(r.needsReport){ render(); openCatalogueBaselineReport(); return; }
      render();
      if(!r.ok) return msg(r.message, true);
      msg(r.changed? r.changed+" change"+(r.changed===1?"":"s")+" received." : "Up to date."
        +(r.sent? " "+r.sent+" sent." : "")+(r.picsFetched? " "+r.picsFetched+" picture"+(r.picsFetched===1?"":"s")+" downloaded." : ""));
    };
    const bo = document.getElementById("catBranchOnly");
    if(bo) bo.onclick = ()=>openBranchOnlyProducts();
    if(typeof wireSharedStockStatus==="function") wireSharedStockStatus();
    const rep = document.getElementById("catReportBtn");
    if(rep) rep.onclick = ()=>openCatalogueReportSummary();
    const sw = document.getElementById("catPicsSwitch");
    if(sw) sw.onchange = async ()=>{ setSetting("cat_pics", sw.checked? "1" : "0"); if(!sw.checked) catState.picsPrompt = null; await persist(); render();
      if(sw.checked){ const r = await catDownloadPictures(null, false); render(); } };
    const rm = document.getElementById("catPicsRemove");
    if(rm) rm.onclick = async ()=>{ if(!confirm("Remove the product pictures downloaded on this device? They can be downloaded again.")) return;
      await catPicClear(); setSetting("cat_pics_ok",""); await persist(); render(); };
    const yes = document.getElementById("catPicsYes"), no = document.getElementById("catPicsNo");
    if(yes) yes.onclick = async ()=>{ yes.disabled = true; msg("Downloading pictures…");
      const r = await catDownloadPictures((t)=>msg(t), true); render(); if(!r.ok) msg(catProblemText(r), true); };
    if(no) no.onclick = ()=>{ catState.picsPrompt = null; render(); };
  }
  // First sync: the report BEFORE anything changes. Backup first when this
  // device already has products (as the catalogue-file import does).
  function catReportListHtml(title, items, fmt, cls){
    if(!items.length) return "";
    return `<div class="${cls||""}" style="margin-top:8px"><b>${escapeHtml(title)} (${items.length})</b>
      <div style="max-height:22vh;overflow:auto;font-size:12.5px">${items.slice(0,200).map(x=>`<div class="pmeta">${escapeHtml(fmt(x))}</div>`).join("")}${items.length>200? `<div class="pmeta">+${items.length-200} more</div>` : ""}</div></div>`;
  }
  function catReportBodyHtml(p){
    const lbl = (x)=> (x.code? x.code+" " : "")+x.name;
    return `
      <p style="margin:0 0 6px">${p.mainTill
        ? `This till is at the <b>main branch</b>. Its products become the business catalogue that every till receives. Stock is never changed.`
        : `Products here are matched to main's catalogue by <b>product code</b>. Stock is never changed.`}</p>
      <div class="pmeta">Main's catalogue: <b>${p.serverCount}</b> · On this device: <b>${p.localCount}</b> · Matched by code: <b>${p.matched.length}</b></div>
      ${p.mainTill? `<div class="pmeta">To upload as new: <b>${p.upload.length}</b></div>` : ""}
      ${catReportListHtml("Products without a code", p.noCode, lbl, "cat-rep-nocode")}
      ${p.mainTill && p.noCode.length? `<p class="muted" style="font-size:12px;margin:4px 0 0">They upload too, but branches that already have them can't match them until they have a code. Add codes in Products before your remote branches sync.</p>` : ""}
      ${catReportListHtml("Duplicate codes (not linked until fixed)", p.dupCodes, (d)=>d.code+": "+d.names.join(", "), "cat-rep-dup")}
      ${catReportListHtml("New from main (added with stock 0)", p.added, lbl, "cat-rep-added")}
      ${catReportListHtml("Names that change to main's", p.nameChanges, (c)=>c.code+": "+c.old+" → "+c.new, "cat-rep-names")}
      ${catReportListHtml(p.mode==="branch_edits"? "Prices that differ from main's" : "Prices that change to main's", p.priceChanges, (c)=>c.code+" "+c.name+": "+c.old.toFixed(2)+" → "+c.new.toFixed(2), "cat-rep-prices")}
      ${catReportListHtml("Only at this branch (kept, not linked: ask main to add them)", p.localOnly, lbl, "cat-rep-localonly")}`;
  }
  async function openCatalogueBaselineReport(){
    const wrap = openModal("First catalogue sync", `<div class="box" style="text-align:center"><p style="margin:0" id="cbrWork">Reading main's catalogue…</p></div>`);
    const body = wrap.querySelector(".modal-body");
    let p = catState.baseline && catState.baseline.plan;
    if(!p){
      const r = await catPrepareBaseline((t)=>{ const el = body.querySelector("#cbrWork"); if(el) el.textContent = t; });
      if(!r.ok){ body.innerHTML = `<p style="margin:0 0 8px">${escapeHtml(catProblemText(r))}</p><button class="btn btn-outline" id="cbrClose">Close</button>`; body.querySelector("#cbrClose").onclick=()=>wrap.remove(); return; }
      p = r.plan;
    }
    const keepable = !p.mainTill && p.mode==="branch_edits" && p.priceChanges.length>0;
    body.innerHTML = `<div class="cat-report">${catReportBodyHtml(p)}</div>
      ${keepable? `<div class="box" style="margin-top:10px"><label style="display:flex;gap:8px;align-items:center;margin:0"><input type="checkbox" id="cbrKeep" style="width:auto"> Keep this branch's prices (Admin passcode)</label>
        <input class="field" id="cbrPass" type="password" inputmode="numeric" placeholder="Admin passcode" style="margin-top:6px"></div>` : ""}
      <div id="cbrMsg" class="muted" style="font-size:12.5px;margin-top:8px"></div>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-outline" id="cbrLater" style="flex:1">Not now</button><button class="btn btn-primary" id="cbrApply" style="flex:1">${p.mainTill? "Upload catalogue" : "Apply"}</button></div>`;
    body.querySelector("#cbrLater").onclick = ()=>{ wrap.remove(); render(); };
    body.querySelector("#cbrApply").onclick = async ()=>{
      const go = body.querySelector("#cbrApply"); go.disabled = true;
      let keep = false;
      if(keepable && body.querySelector("#cbrKeep").checked){
        if(!findAdmin(body.querySelector("#cbrPass").value)){ body.querySelector("#cbrMsg").textContent = "Incorrect Admin passcode."; go.disabled = false; return; }
        keep = true;
      }
      try{
        if(p.localCount>0 && typeof downloadDb==="function") downloadDb("seigen-backup-before-catalogue-sync-"+new Date().toISOString().replace(/[:.]/g,"-")+".sqlite");
        body.querySelector("#cbrMsg").textContent = "Applying…";
        await catApplyBaseline({ keepLocalPrices:keep });
        const r = await catalogueSyncNow({ onProgress:(t)=>{ const el = body.querySelector("#cbrMsg"); if(el) el.textContent = t; } });
        body.innerHTML = `<div class="box" style="text-align:center;margin-bottom:10px"><p style="font-weight:700;margin:0 0 4px">First sync done</p>
          <p class="muted" style="margin:0">${r.ok? escapeHtml(catStatusLine(catalogueSyncStatus())) : escapeHtml(r.message||"")}</p></div>
          <button class="btn btn-primary" id="cbrDone">Done</button>`;
        body.querySelector("#cbrDone").onclick = ()=>{ wrap.remove(); render(); };
      }catch(e){ body.querySelector("#cbrMsg").textContent = "Nothing more was changed: "+(e.message||e); go.disabled = false; }
    };
  }
  function openCatalogueReportSummary(){
    const r = catalogueSyncStatus().report;
    if(!r) return;
    const p = Object.assign({}, r, { matched:{ length:r.matched }, upload:{ length:r.upload } });
    const wrap = openModal("First sync report", `<p class="muted" style="margin:0 0 6px">${escapeHtml(new Date(r.ts).toLocaleString())}</p>
      <div class="cat-report">${catReportBodyHtml(Object.assign(p, { noCode: catIsMainTill()? catProductsWithoutCode().map(x=>({ code:"", name:x.name })) : r.noCode }))}</div>
      <button class="btn btn-outline" id="crsDismiss" style="margin-top:10px">Dismiss report</button>`);
    wrap.querySelector("#crsDismiss").onclick = async ()=>{ setSetting("cat_baseline_report",""); await persist(); wrap.remove(); render(); };
  }
