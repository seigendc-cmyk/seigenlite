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
    const status = activationStatus();
    if(status==="no_setup"){ route="setup"; renderSetup(); return; }
    if(status==="locked"){ route="lock"; renderLock(); return; }
    renderWhoAmI();
  }
  // Only registers when actually served over http(s)/localhost — this
  // silently does nothing when the file is just double-clicked (file://),
  // so it's safe to leave in either way. When it IS registered (device
  // running a local server, or hosted), it's what makes "Install app"
  // available and caches the app + the sql.js library for full offline use.
  if("serviceWorker" in navigator && location.protocol !== "file:"){
    window.addEventListener("load", ()=>{
      navigator.serviceWorker.register("sw.js").catch(()=>{});
    });
  }
  boot();
})();
