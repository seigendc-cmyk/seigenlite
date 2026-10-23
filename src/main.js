  // ================== BOOT ==================
  function renderLoading(){
    $app.innerHTML = `<div class="center-screen"><div class="setup-card center">
      <h2>Starting…</h2>
      <p class="muted">Loading seiGEN Commerce Lite.</p>
    </div></div>`;
  }
  function renderBootError(){
    $app.innerHTML = `<div class="center-screen"><div class="setup-card center">
      <h2>Couldn't start</h2>
      <p class="muted">This needs an internet connection the first time it opens on a device (to load its database engine) — after that it works offline.</p>
      <p class="muted">Also make sure it's opened in a real browser (Chrome), not a preview screen inside WhatsApp or a file manager — tap "Open with" and choose Chrome if unsure.</p>
      <button class="btn btn-primary" id="retryBoot">Retry</button>
    </div></div>`;
    document.getElementById("retryBoot").onclick=boot;
  }
  async function boot(){
    renderLoading();
    try{
      await initDB();
    }catch(e){ renderBootError(); return; }
    startSyncWorker(); // Supabase Foundation: silent background outbox — see sync.js. No-op until a project is configured in Settings.
    startCatalogueSync(); // Phase 3a: main's catalogue to every registered till, in the background — see catalogue-sync.js. Never blocks boot or a sale.
    startDeviceCheckin(); // Digital Commerce device check-in: silent, best-effort phone-home — see devicecheckin.js. Never blocks boot.
    if(typeof staffEnsureRoles==="function") staffEnsureRoles(); // v33: a registered till with no roles fetches them now (roles.js). Never blocks boot.
    if(typeof startB4Worker==="function") startB4Worker(); // v35 B4: this till's sales and money events to seiGEN in the background, see b4-sync.js. Never blocks boot or a sale.
    if(typeof startBranchStock==="function") startBranchStock(); // Branches B1: this till's stock figures to seiGEN every 5 minutes when they changed, see branch-stock.js. Never blocks boot.
    businessDateToday(); // Shift/EOD control: establish the anti-rollback high-water-mark as early as possible each session — see eod.js.
    await establishTrustedTime(); // License anti-rollback: same "as early as possible each session" habit, extended to full-timestamp precision — see eod.js. Awaited so activationStatus() below always sees this session's checked/corroborated time, never a stale one.
    const linkLicence = takeLicenceFromUrl(); // activation.js: an activation link (#lic=…), checked offline
    const seatCode = typeof takeSeatCodeFromUrl==="function"? takeSeatCodeFromUrl() : "";   // v32: an Office seat invite link (#seat=...)
    const status = activationStatus();
    if(status==="no_setup"){
      if(seatCode || (typeof seatStoredCode==="function" && seatStoredCode() && seatCanJoinHere())){ renderSeatEntry(seatCode); return; }   // the install page, or the join screen in the installed app
      if(linkLicence){ route="setup"; renderLinkNoSetup(linkLicence); return; }   // never start setup from a link
      route="setup"; renderSetup(); return;
    }
    if(typeof seatWaiting==="function" && seatWaiting()){ renderSeatWaiting(); return; }   // v32: an Office seat waits for approval (no data, no licence yet)
    refreshLicenceLock();
    startLicenceWatch(); // re-checks every hour and when the app returns to the foreground
    if(linkLicence){ renderLinkResult(await applyLicence(linkLicence, "link")); return; }
    if(licenceLocked()){ route="lock"; renderLock(); return; }
    renderStart(); // Start screen → Sign in → "Who's working today?" (staff.js)
  }
  // A link tapped while the app is already open (some Android launchers
  // reuse the open window): same handling, no reload.
  if(typeof window!=="undefined" && window.addEventListener){
    window.addEventListener("hashchange", async ()=>{
      let setUp = false;
      try{ setUp = !!getSetting("install_date",""); }catch(e){ return; }   // still booting: boot() reads the link itself
      if(!/lic=/.test(String(location.hash||"")) || !setUp) return;
      const t = takeLicenceFromUrl();
      if(t) renderLinkResult(await applyLicence(t, "link"));
    });
  }
  // v23 updates (src/pwa-extras.js, which runs outside this closure): may a
  // waiting new version install itself now? Only on the Start screen or an
  // empty Sales screen: no cart, no drawer or window open, nothing typed.
  // pwa-extras.js adds the "untouched for 2 minutes" part. Read-only, apart
  // from save() (the same persist() every change already uses).
  if(typeof window!=="undefined"){
    window.sclUpdateHooks = {
      idle(){
        try{
          if(route!=="start" && route!=="pos") return false;
          if(cart.length || appliedVoucher || drawerOpen || reqDrawerOpen || navDrawerOpen) return false;
          if(String(searchQuery||"").trim()) return false;
          if(document.querySelector(".modalOverlay")) return false;
          const typed = Array.from(document.querySelectorAll("#app input, #app textarea"))
            .some(el=> el.type!=="checkbox" && el.type!=="radio" && el.type!=="hidden" && String(el.value||"").trim()!=="");
          return !typed;
        }catch(e){ return false; }
      },
      save(){ return db? persist() : Promise.resolve(); },
      minBuild(){ try{ return Number(getSetting("dc_min_build","0"))||0; }catch(e){ return 0; } }
    };
  }
  // Only registers when actually served over http(s)/localhost — this
  // silently does nothing when the file is just double-clicked (file://),
  // so it's safe to leave in either way. When it IS registered (device
  // running a local server, or hosted), it's what makes "Install app"
  // available and caches the app + the sql.js library for full offline use.
  // Not inside the installed Windows program (Tauri): its files are built in,
  // and a worker there can't update itself (src-tauri/sw-off.js removes one an
  // older build left). The same dist-tauri hosted on the web keeps its worker.
  const inTauriProgram = typeof window!=="undefined" && (!!window.__TAURI__ || location.hostname==="tauri.localhost");
  if("serviceWorker" in navigator && location.protocol !== "file:" && !inTauriProgram){
    window.addEventListener("load", ()=>{
      navigator.serviceWorker.register("sw.js").catch(()=>{});
    });
  }
  boot();
})();
