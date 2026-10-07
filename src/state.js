/* =========================================================================
   seiGEN Commerce Lite — single-file offline POS
   Storage: SQLite via sql.js (WASM), persisted to IndexedDB as a blob.
   No install/Bluetooth. Runs as a plain local file; WhatsApp image/PDF
   attachments additionally need the file served via http://localhost
   (a local-server app) — text sharing always works from a plain file.

   Activation: signed licences, see src/activation.js and
   docs/activation/activation-v2-design.md.
   ========================================================================= */

(function(){
  "use strict";

  let SQL=null, db=null;
  let cart=[];
  let appliedVoucher=null;
  // Split-tender checkout (pos.js): off by default, so the existing
  // single-tap Cash/EcoCash/Bank/Credit flow is untouched. splitLines is an
  // array of {method, amount} the drawer/desktop cart edit in place while
  // splitTender is true; both reset to their defaults once completeSale()
  // succeeds, same lifecycle as cart/appliedVoucher above.
  let splitTender=false;
  let splitLines=[];
  // Multi-Currency Support: which currency (a currencies.code, or "" for
  // none chosen) the cart-total-in-foreign-currency convenience line shows
  // — purely a checkout display helper (item 4), never persisted or sent to
  // completeSale. Resets with the rest of the checkout state.
  let fxPreviewCurrency="";
  // Currency Selection on Quick-Tap Checkout: "" (default) = base currency,
  // meaning the Cash/EcoCash/Bank/Credit buttons behave exactly as before
  // this feature. A currencies.code means the NEXT quick-tap is tendered in
  // that currency instead — a completely separate concern from
  // fxPreviewCurrency above (which never affects what's actually charged).
  // Reset alongside the rest of the checkout state once completeSale()
  // succeeds.
  let quickTapCurrency="";
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
  // Stocktake Multi-Token Search Engine: same per-screen query convention
  // as plistQuery/productsQuery/creditQuery/directoryQuery/helpQuery below
  // — its own variable, not a reuse of searchQuery (the Sell screen's),
  // since the two screens' search boxes are independent.
  let stocktakeQuery="";
  let rwType="sales";
  let rwBranch="";
  let rwStatus="";
  let rwReason="";
  let rwView="dn";
  let rwFrom="";
  let rwTo="";
  let rwGranularity="day";
  let drawerOpen=false;
  // Desktop shell (dist-tauri) only: the hamburger-triggered nav drawer —
  // a separate flag from drawerOpen/reqDrawerOpen (cart/requests drawers)
  // since all three can coexist independently. Always false and unused on
  // dist/dist-pwa, which keep the bottom tab bar (see router.js's render(),
  // isDesktopBuild()).
  let navDrawerOpen=false;
  let searchQuery="";
  let productsQuery="";
  let creditQuery="";
  let directoryQuery="";
  let helpQuery="";
  let reportsQuery="";
  let currency="$";
  let sessionUser="";
  let sessionStaffId=null;   // staff.id behind sessionUser once signed in via PIN (null in Single operator mode)
  let accessStep=1;          // Who's-working screen, staff PIN mode: 1=pick staff, 2=enter PIN
  let accessSelectedStaffId=null;
  let accessPinDigits="";
  let accessError="";

  const $app = document.getElementById("app");
  const IDB_NAME="seigen_lite_db", IDB_STORE="kv", IDB_KEY="dbfile";

