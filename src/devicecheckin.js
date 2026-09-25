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
  // Never blocks boot, never retries with backoff, never surfaces a failure
  // to the shop: offline/timeout/server-error all just skip silently, and
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

  // ---- the check-in call itself ----
  async function deviceCheckin(){
    if(!isOnline()) return; // sync.js's own cheap pre-filter, same rule its worker uses
    const installId = getSetting("install_id","");
    if(!installId) return; // nothing meaningful to report before setup has created this device's identity
    let timer = null;
    try{
      const ctrl = (typeof AbortController!=="undefined")? new AbortController() : null;
      if(ctrl) timer = setTimeout(()=>ctrl.abort(), DC_CHECKIN_TIMEOUT_MS);
      const res = await fetch(DC_CHECKIN_URL, {
        method: "POST",
        headers: { "apikey": DC_ANON_KEY, "Content-Type": "application/json" },
        signal: ctrl? ctrl.signal : undefined,
        body: JSON.stringify({
          p_install_id: installId,
          p_shop_secret_phrase: getSetting("secret_phrase",""),
          p_device_code: currentDeviceCode(),
          p_business_name: getSetting("shop_name",""),
          p_owner_name: "",           // no owner-name setting exists today — see summary
          p_phone: getSetting("contact_phone",""),
          p_city: "",                 // no shop-city setting exists today — see summary
          p_location: getSetting("branch_name",""), // closest existing concept to a free-text location
          p_rpn_hint_id: null         // RPN linkage (rpn.js) is stored as free text, no UUID tracked locally — see summary
        })
      });
      if(!res.ok) return;
      const data = await res.json();
      if(!data || typeof data!=="object") return;
      setSetting("dc_lock_cart", data.lock_cart? "1" : "");
      setSetting("dc_lock_add_product", data.lock_add_product? "1" : "");
      setSetting("dc_lock_reason", data.lock_reason || "");
      setSetting("dc_vendor_status", data.status || "");
      dcMergeMessages(data.messages);
      await persist();
      // Deliberately no render() here: this can land at any moment,
      // including mid-keystroke in a search box or a cart discount field —
      // forcing a full re-render would be exactly the rebuild-loses-focus
      // bug class this app has fixed elsewhere (see updateSplitTenderDerived's
      // comment in pos.js). Both gates below read settings fresh on every
      // call, so the new lock/messages state takes effect on the very next
      // natural render (next tap, next screen) with no special-casing here.
    }catch(e){
      // Offline, timeout, server error, malformed response — all the same:
      // skip silently, never alert the shop user, try again next launch or
      // reconnect (see startDeviceCheckin below).
    } finally { if(timer) clearTimeout(timer); }
  }

  // Called once at boot (main.js, after initDB — so getSetting/currentDeviceCode
  // work) and again on every "online" event, mirroring startSyncWorker's own
  // listener registration (sync.js) but as its own separate listener: this
  // is one RPC whose reply drives lock state, not a queued insert, so it
  // doesn't share that worker's wiring.
  function startDeviceCheckin(){
    deviceCheckin(); // fire-and-forget — boot() never awaits this, so it can never delay startup
    if(typeof window!=="undefined" && window.addEventListener) window.addEventListener("online", deviceCheckin);
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
