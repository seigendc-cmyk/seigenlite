  // ================== Digital Commerce — Device Check-in ==================
  // Additive, best-effort phone-home to the Digital Commerce backoffice
  // console: reports this device's identity/contact details, and receives
  // back a lock state (Cart/Add Product) plus any message cards the shop's
  // RPN/Digital Commerce has queued for them. Deliberately separate from
  // sync.js's outbox (enqueueSync/supabaseInsert/runSyncWorker). Both talk
  // to the same Digital Commerce project — DC_SUPABASE_URL/DC_ANON_KEY below
  // are the one definition, and sync.js's getSupabaseConfig() reuses them —
  // but this is a single RPC per launch whose reply sets lock state, not a
  // queued insert, so it intentionally doesn't go through enqueueSync() or
  // share sync_queue.
  //
  // Runs at every launch, on every reconnect, straight after setup
  // finishes and after Settings → Save phrase. Never blocks boot, never
  // retries with backoff, never pops up an error: a failure is only
  // recorded (dc_checkin_error) for Marketing and Settings to explain, and
  // the next launch or reconnect tries again (see startDeviceCheckin below)
  // — exactly the same "best-effort, nothing invented beyond what's asked"
  // rule fetchNetworkTime() (eod.js) already follows for its own probe.

  const DC_SUPABASE_URL = "https://urbopdsubwawtybwrxjd.supabase.co";
  const DC_CHECKIN_URL = DC_SUPABASE_URL + "/rest/v1/rpc/cl_device_checkin";
  const DC_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVyYm9wZHN1Yndhd3R5YndyeGpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMTYzNzEsImV4cCI6MjEwNTY5MjM3MX0.pCGkNETrB4ISse2ES_6goALKJz3g_22osjLfIgFG4k4";
  const DC_CHECKIN_TIMEOUT_MS = 8000;

  // ---- lock state (read fresh from settings every time — never cached in
  // a module-level var, so a check-in that lands mid-session takes effect
  // the moment either gate below is next consulted, with no forced re-render
  // needed) ----
  const DC_DEFAULT_LOCK_MESSAGE = "Contact Digital Commerce to reactivate";
  function dcLockCartReason(){
    return getSetting("dc_lock_cart","")==="1"
      ? (getSetting("dc_lock_reason","").trim() || DC_DEFAULT_LOCK_MESSAGE)
      : "";
  }
  function dcLockAddProductReason(){
    return getSetting("dc_lock_add_product","")==="1"
      ? (getSetting("dc_lock_reason","").trim() || DC_DEFAULT_LOCK_MESSAGE)
      : "";
  }

  // ---- message cards ----
  // The server marks each message delivered the instant it's returned in a
  // checkin response, so it is never re-sent — this local copy (settings
  // table, same store getSetting/setSetting already use everywhere else)
  // is the only record of it from that point on. Stored as one JSON array
  // under a single settings key rather than a new table: a shop-facing
  // inbox, not transactional/reportable data the rest of the app queries.
  function dcMessages(){
    try{ const arr = JSON.parse(getSetting("dc_messages","[]")); return Array.isArray(arr)? arr : []; }
    catch(e){ return []; }
  }
  function dcPendingMessages(){ return dcMessages().filter(m=>!m.dismissed); }
  function dcMergeMessages(incoming){
    if(!Array.isArray(incoming) || !incoming.length) return;
    const existing = dcMessages();
    const seen = new Set(existing.map(m=>m.id));
    const fresh = incoming.filter(m=> m && m.id && !seen.has(m.id)).map(m=>({
      id: m.id, title: m.title||"", body: m.body||"",
      created_at: m.created_at || new Date().toISOString(), dismissed:false
    }));
    if(!fresh.length) return;
    setSetting("dc_messages", JSON.stringify(existing.concat(fresh)));
  }
  function dcDismissMessage(id){
    const msgs = dcMessages().map(m=> m.id===id? Object.assign({},m,{dismissed:true}) : m);
    setSetting("dc_messages", JSON.stringify(msgs));
    persist();
  }

  // ---- registration (is this device known to Digital Commerce?) ----
  // A device is registered once a check-in has succeeded: the server then
  // has its install_id in cl_vendors, which is what the publish portal
  // checks before it will list a shop's products. dc_vendor_id is stored by
  // this version; dc_vendor_status is also accepted so a device that
  // registered under an older version still counts.
  // dc_checkin_error keeps the last reason a check-in didn't go through
  // (never shown as an alert — Marketing and Settings read it to explain).
  function dcIsRegistered(){ return !!(getSetting("dc_vendor_id","") || getSetting("dc_vendor_status","")); }
  function dcRegistration(){
    return { registered: dcIsRegistered(), hasPhrase: !!getSetting("secret_phrase","").trim(),
      lastError: getSetting("dc_checkin_error",""), lastOkTs: getSetting("dc_checkin_ok_ts","") };
  }

  // ---- the check-in call itself ----
  // Resolves to { ok, reason, message? } — never rejects — so the places
  // that start one on purpose (end of setup, Save phrase, Marketing's
  // "Check again") can say what happened. reason: "registered" |
  // "offline" | "no_install" | "no_phrase" | "rejected" | "network".
  let _dcInFlight = null;
  function deviceCheckin(){
    // One at a time: boot, setup and Save phrase can overlap on a fresh device.
    if(!_dcInFlight) _dcInFlight = dcCheckinOnce().finally(()=>{ _dcInFlight = null; });
    return _dcInFlight;
  }
  async function dcCheckinOnce(){
    if(!isOnline()) return { ok:false, reason:"offline" }; // sync.js's own cheap pre-filter, same rule its worker uses
    const installId = getSetting("install_id","");
    if(!installId) return { ok:false, reason:"no_install" }; // nothing meaningful to report before setup has created this device's identity
    // The server refuses a check-in without the shop's activation phrase,
    // so don't send one that can only fail.
    if(!getSetting("secret_phrase","").trim()) return { ok:false, reason:"no_phrase" };
    let timer = null;
    try{
      const ctrl = (typeof AbortController!=="undefined")? new AbortController() : null;
      if(ctrl) timer = setTimeout(()=>ctrl.abort(), DC_CHECKIN_TIMEOUT_MS);
      const post = (extra)=> fetch(DC_CHECKIN_URL, {
        method: "POST",
        headers: { "apikey": DC_ANON_KEY, "Content-Type": "application/json" },
        signal: ctrl? ctrl.signal : undefined,
        body: JSON.stringify(Object.assign({
          p_install_id: installId,
          p_shop_secret_phrase: getSetting("secret_phrase",""),
          p_device_code: currentDeviceCode(),
          p_business_name: getSetting("shop_name",""),
          p_owner_name: "",           // no owner-name setting exists today — see summary
          p_phone: getSetting("contact_phone",""),
          p_city: "",                 // no shop-city setting exists today — see summary
          p_location: getSetting("branch_name",""), // closest existing concept to a free-text location
          p_rpn_hint_id: null,        // RPN linkage (rpn.js) is stored as free text, no UUID tracked locally — see summary
          p_device_key: (typeof deviceKey==="function")? deviceKey() : null,  // terminal.js: tells this device apart from another with the same install ID
          p_app_build: (typeof APP_BUILD!=="undefined")? APP_BUILD : null      // build.js (sw-pwa.js "build: vN"): shared stock waits until every till runs v7+
        }, extra))
      });
      // v36 A1 (decision 34): the vendor id this device last had, so seiGEN can tell a removed device from a new one.
      // A seiGEN before 20261113180000 doesn't know the field: asked again without it.
      const last = dcLastVendorId();
      let res = await post(last? { p_last_vendor_id: last } : {});
      let errText = null;
      if(!res.ok){
        try{ errText = await res.text(); }catch(e){ errText = ""; }
        if(last && /p_last_vendor_id|PGRST202|Could not find the function|does not exist/i.test(errText||"") && !/DEVICE_REMOVED/.test(errText||"")){
          res = await post({}); errText = null;
          if(!res.ok){ try{ errText = await res.text(); }catch(e){ errText = ""; } }
        }
      }
      if(!res.ok){
        // e.g. "Shop secret phrase does not match this install" — kept so
        // Settings/Marketing can explain; lock state is left untouched.
        let message = "HTTP " + res.status;
        const t = errText||""; try{ const j = JSON.parse(t); message = j.message || t || message; }catch(e){ message = t || message; }
        setSetting("dc_checkin_error", String(message).slice(0, 200));
        // v36 A1: seiGEN no longer has this device's business. Remembered (and shown) until a check-in goes through
        // or the device is reset; nothing on the device is cleared here.
        const removed = /DEVICE_REMOVED/.test(message);
        if(removed) setSetting("dc_device_removed", "1");
        await persist();
        if(removed) dcRemovedNotice();
        return { ok:false, reason: removed? "removed" : "rejected", message: String(message).slice(0, 200) };
      }
      const data = await res.json();
      if(!data || typeof data!=="object") return { ok:false, reason:"network" };
      setSetting("dc_lock_cart", data.lock_cart? "1" : "");
      setSetting("dc_lock_add_product", data.lock_add_product? "1" : "");
      setSetting("dc_lock_reason", data.lock_reason || "");
      setSetting("dc_vendor_status", data.status || "");
      if(data.vendor_id) setSetting("dc_vendor_id", String(data.vendor_id));
      // Multi-terminal: only ever filled in, never cleared, by a check-in —
      // registering/joining (terminal.js) is what sets the full identity.
      if(data.business_id && !getSetting("business_id","")) setSetting("business_id", String(data.business_id));
      // Billing-B: a different business = seiGEN merged this till's business into another (terminal.js)
      else if(data.business_id && String(data.business_id)!==getSetting("business_id","") && typeof terminalFollowBusiness==="function")
        terminalFollowBusiness(String(data.business_id)).then(ch=>{ if(ch && typeof render==="function") render(); }).catch(()=>{});
      if(data.terminal_id && !getSetting("terminal_id","")) setSetting("terminal_id", String(data.terminal_id));
      // Phase 2: main can deactivate a till. Selling is unaffected; Settings
      // says so and hides register/join. Only a true/false answer changes it
      // (null = this install isn't a till, or an older server).
      if(data.terminal_active===false) setSetting("terminal_inactive", "1");
      else if(data.terminal_active===true) setSetting("terminal_inactive", "");
      // v21: an Admin passcode the main branch set for this till (a check value, delivered once)
      if(data.admin_seed && typeof storeAdminSeed==="function") storeAdminSeed(data.admin_seed, "checkin");
      // v23: seiGEN's minimum build (20261025120000). Only the minimum is kept:
      // "must update" is worked out here against the build running now, so the
      // red bar (pwa-extras.js) goes as soon as the app is updated. An older
      // server sends no min_build: the stored value is left as it was.
      if(data.min_build!==undefined && data.min_build!==null){
        setSetting("dc_min_build", String(Math.max(0, Number(data.min_build)||0)));
        try{ window.dispatchEvent(new CustomEvent("scl:minbuild", { detail:{ min_build: Number(data.min_build)||0 } })); }catch(e){}
      }
      setSetting("dc_checkin_error", "");
      setSetting("dc_device_removed", "");   // v36 A1: seiGEN knows this device again
      setSetting("dc_checkin_ok_ts", new Date().toISOString());
      dcMergeMessages(data.messages);
      await persist();
      // Activation (activation.js): a registered till picks up a licence
      // seiGEN issued for it. Fire-and-forget, like the rest of check-in.
      if(typeof licencePullPending==="function" && typeof isTerminalRegistered==="function" && isTerminalRegistered())
        licencePullPending().catch(()=>{});
      // Free trial (trial.js): a joined till's cover, or an answer that was lost.
      if(typeof trialAfterCheckin==="function") trialAfterCheckin();
      // RPN link (rpn.js): send a waiting field force number + PIN, refresh "Onboarded by".
      if(typeof rpnAfterCheckin==="function") rpnAfterCheckin();
      // Market pack (marketing.js): send a waiting pack, fetch Digital Commerce's decision.
      if(typeof marketAfterCheckin==="function") marketAfterCheckin();
      // seiGEN dispatches (dispatch-srv.js): send waiting dispatches, pull Incoming and the differences.
      if(typeof dsAfterCheckin==="function") dsAfterCheckin();
      // internal transfers (transfers.js, v32): the main branch's devices, then the transfers when it has an Office seat.
      if(typeof itAfterCheckin==="function") itAfterCheckin();
      // suppliers and supplier GRVs (supplier-grv.js): send waiting ones, pull the list.
      if(typeof sgAfterCheckin==="function") sgAfterCheckin();
      // the business's customer list (customers.js): send this till's new customers, pull the rest.
      if(typeof custAfterCheckin==="function") custAfterCheckin();
      // the business's roles and staff (roles.js, v28): this till's old staff list once, then everyone's.
      if(typeof staffAfterCheckin==="function") staffAfterCheckin();
      // stock by branch (branch-stock.js): the branch list, this till's stock figures, every branch's.
      if(typeof bsAfterCheckin==="function") bsAfterCheckin().catch(()=>{});
      // iTred orders (itred-orders.js): send this till's fulfilment changes and replies, pull the business's orders.
      if(typeof itredAfterCheckin==="function") itredAfterCheckin();
      // sales sync (b4-sync.js, v35): the first check-in starts B4 (the 90 days of history), then this till's sales and money events.
      if(typeof b4AfterCheckin==="function") b4AfterCheckin().catch(()=>{});
      // About (help.js, v36 A5): seiGEN's company details and contact numbers, kept for offline, at most once a day.
      if(typeof aboutAfterCheckin==="function") aboutAfterCheckin();
      return { ok:true, reason:"registered" };
      // Deliberately no render() here: this can land at any moment,
      // including mid-keystroke in a search box or a cart discount field —
      // forcing a full re-render would be exactly the rebuild-loses-focus
      // bug class this app has fixed elsewhere (see updateSplitTenderDerived's
      // comment in pos.js). Both gates below read settings fresh on every
      // call, so the new lock/messages state takes effect on the very next
      // natural render (next tap, next screen) with no special-casing here.
    }catch(e){
      // Offline, timeout, unreachable server, malformed response — all the
      // same: never alert the shop user, try again next launch or reconnect
      // (see startDeviceCheckin below).
      return { ok:false, reason:"network" };
    } finally { if(timer) clearTimeout(timer); }
  }
  // What to tell the shop when a check-in didn't register the device.
  function dcCheckinProblemText(r){
    r = r || {};
    if(r.reason==="no_phrase") return "Enter your activation secret phrase (from your RPN or Digital Commerce) in More → Settings.";
    if(r.reason==="offline" || r.reason==="network") return "Connect to the internet, then try again.";
    if(r.reason==="removed" || /DEVICE_REMOVED/.test(r.message||"")) return DC_REMOVED_TEXT+" (More → About).";
    if(r.reason==="rejected") return /secret phrase does not match/i.test(r.message||"")
      ? "Digital Commerce has a different activation phrase for this device. Check the phrase with your RPN or Digital Commerce and save it again in More → Settings."
      : /registered to another device/i.test(r.message||"")
      ? "Digital Commerce has this install ID registered to another device, so this one can't use it. Contact Digital Commerce to re-admit this device."
      : "Digital Commerce couldn't register this device (" + (r.message||"unknown reason") + "). Contact Digital Commerce.";
    return "";
  }

  // Called once at boot (main.js, after initDB — so getSetting/currentDeviceCode
  // work) and again on every "online" event, mirroring startSyncWorker's own
  // listener registration (sync.js) but as its own separate listener: this
  // is one RPC whose reply drives lock state, not a queued insert, so it
  // doesn't share that worker's wiring.
  function startDeviceCheckin(){
    deviceCheckin(); // fire-and-forget — boot() never awaits this, so it can never delay startup
    if(typeof window!=="undefined" && window.addEventListener) window.addEventListener("online", deviceCheckin);
    if(dcDeviceRemoved()) setTimeout(dcRemovedNotice, 1500);   // v36 A1: shown again at every launch, even offline
  }

  // ---- removed device (v36 A1, owner decision 34) ----
  // seiGEN refused this device: the business it belonged to was deleted. The
  // app says so and offers a reset, with a backup first. Nothing is ever
  // cleared on its own: only the Reset button (Admin passcode when the till
  // has one, then a confirmation) clears the device, which then starts setup
  // as a new install. A new install isn't affected: it sends no vendor id.
  const DC_REMOVED_TEXT = "This device belongs to a business that no longer exists on seiGEN. Reset this device";
  function dcLastVendorId(){
    const v = getSetting("dc_vendor_id","").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)? v : null;
  }
  function dcDeviceRemoved(){ return getSetting("dc_device_removed","")==="1"; }
  let _dcRemovedShown = false;
  // once per app session, never on top of another window (tried again shortly)
  function dcRemovedNotice(){
    if(!dcDeviceRemoved() || _dcRemovedShown) return;
    if(typeof document==="undefined" || !document.body || typeof document.querySelector!=="function") return;
    if(document.querySelector(".modalOverlay")){ setTimeout(dcRemovedNotice, 20000); return; }
    _dcRemovedShown = true;
    openDcResetModal();
  }
  function dcRemovedCardHtml(){
    if(!dcDeviceRemoved()) return "";
    return `<div class="card" id="dcRemovedCard" style="border:2px solid var(--danger,#c92a2a)">
      <p style="margin:0 0 8px;font-weight:700">${escapeHtml(DC_REMOVED_TEXT)}.</p>
      <button class="btn btn-primary" id="dcRemovedOpen">Reset this device…</button></div>`;
  }
  function wireDcRemovedCard(){
    const b = document.getElementById("dcRemovedOpen");
    if(b) b.onclick = ()=> openDcResetModal();
  }
  function openDcResetModal(){
    const admin = typeof hasAdminPasscode==="function" && hasAdminPasscode();
    let saved = false;
    const wrap = openModal("This device", `
      <p id="dcRmText" style="margin-top:0;font-weight:700">${escapeHtml(DC_REMOVED_TEXT)}.</p>
      <p class="muted" style="font-size:12.5px">This device keeps what's on it, but seiGEN no longer answers it. Resetting clears everything on this device (products, stock, sales, customers, staff and settings) and starts setup again as a new device. Nothing is cleared until you reset.</p>
      <button class="btn btn-primary" id="dcRmBackup">💾 Save a backup first</button>
      <p class="muted" id="dcRmSaved" style="font-size:12.5px;margin:6px 0 0"></p>
      ${admin? `<label for="dcRmPass">Admin passcode (to reset)</label><input class="field" id="dcRmPass" type="password" autocomplete="off">` : ""}
      <div id="dcRmMsg" role="alert" style="color:var(--danger);font-weight:600;margin-top:8px"></div>
      <div class="row" style="margin-top:12px"><button class="btn btn-outline" id="dcRmLater">Not now</button><button class="btn btn-outline" id="dcRmReset">Reset this device</button></div>`);
    wrap.querySelector("#dcRmLater").onclick = ()=> wrap.remove();
    wrap.querySelector("#dcRmBackup").onclick = ()=>{
      downloadDb(`seigen-backup-before-reset-${new Date().toISOString().replace(/[:.]/g,"-")}.sqlite`);
      saved = true;
      wrap.querySelector("#dcRmSaved").textContent = "Backup saved to this device's downloads. Keep it somewhere safe before you reset.";
    };
    wrap.querySelector("#dcRmReset").onclick = async (e)=>{
      const btn = e.currentTarget, msg = wrap.querySelector("#dcRmMsg");
      if(btn.disabled) return;
      msg.textContent = "";
      if(admin){
        btn.disabled = true;
        let ok = null;
        try{ ok = await findAdminAsync(wrap.querySelector("#dcRmPass").value); }catch(err){ ok = null; }
        btn.disabled = false;
        if(!ok){ msg.textContent = "Incorrect Admin passcode."; return; }
      }
      if(!confirm(saved? "Reset this device? Everything on it is cleared and setup starts again."
        : "You haven't saved a backup. Reset anyway? Everything on this device is cleared and setup starts again.")) return;
      btn.disabled = true;
      await dcResetDevice();
    };
    return wrap;
  }
  // As a new install: an empty database; setup then makes a new install ID.
  async function dcResetDevice(){
    db = new SQL.Database(); db.run(SCHEMA); migrate(db);
    await persist();
    if(typeof location!=="undefined" && typeof location.reload==="function") location.reload();
  }

  // ---- message-card banner (mobile drawer + desktop Sales screen, same
  // spot shiftBlockBannerHtml() already occupies — see eod.js) ----
  function dcMessagesBannerHtml(){
    const pending = dcPendingMessages();
    if(!pending.length) return "";
    return pending.map(m=>`
      <div class="card" style="margin-bottom:10px" data-dc-msg="${escapeHtml(m.id)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div style="min-width:0">
            <p style="margin:0 0 4px;font-weight:700">${escapeHtml(m.title)}</p>
            <p class="muted" style="margin:0">${escapeHtml(m.body)}</p>
          </div>
          <button class="btn btn-sm btn-ghost" data-dc-dismiss="${escapeHtml(m.id)}" style="flex:none">✕</button>
        </div>
      </div>`).join("");
  }
  function wireDcMessagesBanner(){
    document.querySelectorAll("[data-dc-dismiss]").forEach(b=>{
      b.onclick = ()=>{ dcDismissMessage(b.dataset.dcDismiss); render(); };
    });
  }
