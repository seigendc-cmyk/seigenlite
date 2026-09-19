  // ---------------- Delivery Note: browser-side pieces (Phase 2) ----------------
  // Thumbnails, the DN file store, and the per-build save/share layer. The
  // file itself is built by dnfile.js (pure) — everything here only feeds it
  // pictures or moves the finished text somewhere.

  // ---- thumbnails ----
  // Catalogue image (already a ~300px WebP data URI) -> longest side <= 200px,
  // WebP ~0.7 (JPEG where the canvas can't encode WebP). Never throws: a
  // missing/corrupt image just means the line has no thumb.
  const THUMB_MAX = 200, THUMB_WEBP_Q = 0.7, THUMB_JPEG_Q = 0.72;
  const thumbCache = new Map();
  let _webpOk = null;
  function canvasEncodesWebP(){
    if(_webpOk===null){
      try{
        const c = document.createElement("canvas"); c.width=c.height=1;
        _webpOk = c.toDataURL("image/webp").indexOf("data:image/webp")===0;
      }catch(e){ _webpOk = false; }
    }
    return _webpOk;
  }
  function makeThumb(dataUri){
    return new Promise(resolve=>{
      if(!dataUri || typeof dataUri!=="string" || dataUri.indexOf("data:image/")!==0) return resolve(null);
      const img = new Image();
      const timer = setTimeout(()=>resolve(null), 8000);
      img.onerror = ()=>{ clearTimeout(timer); resolve(null); };
      img.onload = ()=>{
        clearTimeout(timer);
        try{
          const scale = Math.min(1, THUMB_MAX/Math.max(img.width,img.height));
          const w = Math.max(1,Math.round(img.width*scale)), h = Math.max(1,Math.round(img.height*scale));
          const c = document.createElement("canvas"); c.width=w; c.height=h;
          const ctx = c.getContext("2d");
          const webp = canvasEncodesWebP();
          if(!webp){ ctx.fillStyle="#fff"; ctx.fillRect(0,0,w,h); } // JPEG has no alpha
          ctx.drawImage(img,0,0,w,h);
          const out = webp? c.toDataURL("image/webp",THUMB_WEBP_Q) : c.toDataURL("image/jpeg",THUMB_JPEG_Q);
          resolve(out.indexOf("data:image/")===0? out : null);
        }catch(e){ resolve(null); }
      };
      img.src = dataUri;
    });
  }
  async function getThumb(p){
    if(!p || !p.image) return null;
    const key = p.id+":"+p.image.length;
    if(thumbCache.has(key)) return thumbCache.get(key);
    const t = await makeThumb(p.image);
    thumbCache.set(key, t);
    return t;
  }
  // Sequential on purpose (keeps memory flat on cheap phones).
  async function getThumbs(products, onProgress){
    const out = [];
    for(let i=0;i<products.length;i++){
      if(onProgress) onProgress(i, products.length);
      out.push(await getThumb(products[i]));
    }
    if(onProgress) onProgress(products.length, products.length);
    return out;
  }

  // ---- DN file store ----
  // Its own IndexedDB database, so the sql.js blob (which is exported and
  // shared) never carries images. Key: branch_id|dn_no.
  const DNF_DB = "seigen_dn_files", DNF_STORE = "files";
  function dnfOpen(){
    return new Promise((res,rej)=>{
      const r = indexedDB.open(DNF_DB, 1);
      r.onupgradeneeded = ()=> r.result.createObjectStore(DNF_STORE);
      r.onsuccess = ()=> res(r.result);
      r.onerror = ()=> rej(r.error);
    });
  }
  const dnfKey = (branchId, dnNo)=> branchId+"|"+dnNo;
  async function dnfPut(branchId, dnNo, rec){
    const conn = await dnfOpen();
    return new Promise((res,rej)=>{
      const tx = conn.transaction(DNF_STORE,"readwrite");
      tx.objectStore(DNF_STORE).put(rec, dnfKey(branchId,dnNo));
      tx.oncomplete = ()=>{ conn.close(); res(true); };
      tx.onerror = ()=>{ conn.close(); rej(tx.error); };
    });
  }
  async function dnfGet(branchId, dnNo){
    try{
      const conn = await dnfOpen();
      return await new Promise((res,rej)=>{
        const rq = conn.transaction(DNF_STORE,"readonly").objectStore(DNF_STORE).get(dnfKey(branchId,dnNo));
        rq.onsuccess = ()=>{ conn.close(); res(rq.result||null); };
        rq.onerror = ()=>{ conn.close(); rej(rq.error); };
      });
    }catch(e){ return null; }
  }

  // ---- save / share layer ----
  const isTauriApp = ()=> !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.fs);

  function dnWhatsAppText(dnDisplay, fromName){
    return "Delivery Note "+dnDisplay+" from "+fromName+". Please attach the file from the folder that just opened.";
  }
  // Same number rules as every other WhatsApp link in the app (waLink); with
  // no number it falls back to wa.me/?text=.
  function dnWhatsAppUrl(phone, text){ return waLink(phone||"", text); }

  function downloadTextFile(fileName, text, mime){
    const url = URL.createObjectURL(new Blob([text],{type:mime||"application/json"}));
    const a = document.createElement("a");
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
  }

  // Desktop (Tauri): Documents/seiGEN/<folder>
  async function tauriSaveFile(folder, fileName, text){
    const T = window.__TAURI__;
    const docs = await T.path.documentDir();
    const dir = await T.path.join(docs, "seiGEN", folder);
    await T.fs.mkdir(dir, { recursive:true });
    const full = await T.path.join(dir, fileName);
    await T.fs.writeTextFile(full, text);
    return { dir, full };
  }
  const tauriSaveDN = (fileName, text)=> tauriSaveFile("Dispatches", fileName, text);
  function openExternalUrl(url){
    if(isTauriApp() && window.__TAURI__.opener) return window.__TAURI__.opener.openUrl(url);
    window.open(url, "_blank");
  }

  // Share a finished file. Returns { method, path? } where method is one of
  // "shared" | "cancelled" | "downloaded" | "saved-folder". Throws only if
  // nothing at all could be done.
  //   o: { fileName, text, folder (desktop), title, shareText (phone), whatsappText (desktop), phone }
  async function shareDocFile(o){
    if(isTauriApp()){
      const saved = await tauriSaveFile(o.folder, o.fileName, o.text);
      try{ await window.__TAURI__.opener.revealItemInDir(saved.full); }catch(e){}
      try{ await window.__TAURI__.opener.openUrl(dnWhatsAppUrl(o.phone, o.whatsappText)); }catch(e){}
      return { method:"saved-folder", path:saved.full };
    }
    try{
      const file = new File([o.text], o.fileName, { type:"application/json" });
      if(navigator.canShare && navigator.canShare({files:[file]})){
        try{
          await navigator.share({ files:[file], title:o.title, text:o.shareText });
          return { method:"shared" };
        }catch(e){
          if(e && e.name==="AbortError") return { method:"cancelled" };
          // any other share failure falls through to a plain download
        }
      }
    }catch(e){ /* File constructor unavailable — download instead */ }
    downloadTextFile(o.fileName, o.text);
    return { method:"downloaded" };
  }
  // Delivery Notes (Phase 2 signature kept).
  function shareDNFile(fileName, text, dnDisplay, fromName, toPhone){
    return shareDocFile({ fileName, text, folder:"Dispatches", title:dnDisplay, phone:toPhone,
      shareText:"Delivery Note "+dnDisplay+" from "+fromName, whatsappText:dnWhatsAppText(dnDisplay, fromName) });
  }
