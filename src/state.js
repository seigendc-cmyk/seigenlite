/* =========================================================================
   seiGEN Commerce Lite — single-file offline POS
   Storage: SQLite via sql.js (WASM), persisted to IndexedDB as a blob.
   No install/Bluetooth. Runs as a plain local file; WhatsApp image/PDF
   attachments additionally need the file served via http://localhost
   (a local-server app) — text sharing always works from a plain file.

   ACTIVATION CODE FORMULA (also shown on the Help page in-app):
     function computeActivationCode(deviceCode, secretPhrase) {
       const combined = deviceCode.toUpperCase() + '|' + secretPhrase.toUpperCase();
       let hash = 0;
       for (let i = 0; i < combined.length; i++) {
         hash = ((hash << 5) - hash + combined.charCodeAt(i)) | 0;
       }
       hash = Math.abs(hash);
       return hash.toString(36).toUpperCase().padStart(6, '0').slice(-6);
     }
   Give this + the device code shown on the lock screen + the shop's secret
   phrase to any Claude chat to get the 6-character unlock code.
   ========================================================================= */

(function(){
  "use strict";

  let SQL=null, db=null;
  let cart=[];
  let appliedVoucher=null;
  let exportDirHandle=null;
  let exportScope=null; // "*" = all branches on this device, else a branch name; null = this branch
  // The chosen export folder is kept in IndexedDB (directory handles are
  // structured-cloneable) so it survives reloads — held only in memory it was
  // forgotten every time the app restarted.
  function exportDirStore(mode, fn){
    return new Promise((resolve)=>{
      try{
        const req = indexedDB.open("seigen-export-dir", 1);
        req.onupgradeneeded = ()=> req.result.createObjectStore("kv");
        req.onerror = ()=> resolve(null);
        req.onsuccess = ()=>{
          try{
            const tx = req.result.transaction("kv", mode);
            const r = fn(tx.objectStore("kv"));
            tx.oncomplete = ()=>{ resolve(r && r.result!==undefined ? r.result : null); req.result.close(); };
            tx.onerror = tx.onabort = ()=> resolve(null);
          }catch(e){ resolve(null); }
        };
      }catch(e){ resolve(null); }
    });
  }
  const saveExportDirHandle = (h)=> exportDirStore("readwrite", s=> h? s.put(h,"handle") : s.delete("handle"));
  if(window.showDirectoryPicker){
    exportDirStore("readonly", s=> s.get("handle")).then(h=>{
      if(h && !exportDirHandle){
        exportDirHandle = h;
        if(route==="more") render();
      }
    });
  }
  let route="loading";
  let moreTab="help";
  let plistQuery="";
  let plistBranch="";
  let reqBranch="";
  let reqDrawerOpen=false;
  let reqExpandedId=null;
  let reqLineSeq=0;
  let reqLines=[{id:reqLineSeq++, item:"", qty:""}];
  let settingsUnlocked=false;
  let stocktakeReportId=null;
  let rwType="sales";
  let rwBranch="";
  let rwStatus="";
  let rwReason="";
  let rwView="dn";
  let rwFrom="";
  let rwTo="";
  let rwGranularity="day";
  let drawerOpen=false;
  let searchQuery="";
  let productsQuery="";
  let creditQuery="";
  let directoryQuery="";
  let helpQuery="";
  let reportsQuery="";
  let currency="$";
  let sessionUser="";

  const $app = document.getElementById("app");
  const IDB_NAME="seigen_lite_db", IDB_STORE="kv", IDB_KEY="dbfile";

