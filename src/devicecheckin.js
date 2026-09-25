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
      if(!res.ok){
        // e.g. "Shop secret phrase does not match this install" — kept so
        // Settings/Marketing can explain; lock state is left untouched.
        let message = "HTTP " + res.status;
        try{ const t = await res.text(); try{ const j = JSON.parse(t); message = j.message || t || message; }catch(e){ message = t || message; } }catch(e){}
        setSetting("dc_checkin_error", String(message).slice(0, 200));
        await persist();
        return { ok:false, reason:"rejected", message: String(message).slice(0, 200) };
      }
      const data = await res.json();
      if(!data || typeof data!=="object") return { ok:false, reason:"network" };
      setSetting("dc_lock_cart", data.lock_cart? "1" : "");
      setSetting("dc_lock_add_product", data.lock_add_product? "1" : "");
      setSetting("dc_lock_reason", data.lock_reason || "");
      setSetting("dc_vendor_status", data.status || "");
      if(data.vendor_id) setSetting("dc_vendor_id", String(data.vendor_id));
      setSetting("dc_checkin_error", "");
      setSetting("dc_checkin_ok_ts", new Date().toISOString());
      dcMergeMessages(data.messages);
      await persist();
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
    if(r.reason==="rejected") return /secret phrase does not match/i.test(r.message||"")
      ? "Digital Commerce has a different activation phrase for this device. Check the phrase with your RPN or Digital Commerce and save it again in More → Settings."
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
