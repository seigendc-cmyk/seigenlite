  // ================== Supabase Foundation (sync queue) ==================
  // This app has no backend: everything lives in the local SQLite database
  // (sql.js -> IndexedDB), and that stays true by default. This file adds
  // a generic outbox ("sync_queue", schema in db.js) that any feature can
  // drop records into, plus a background worker that pushes them to Digital
  // Commerce's Supabase project (built in — see getSupabaseConfig) whenever
  // the device is online. It works silently, in the background, without
  // ever changing what already works offline.
  //
  // ---- How a future feature registers a new sync record type ----
  // 1. Call registerSyncType() once, anywhere at the top level of your
  //    feature's own file (order doesn't matter — everything in this app's
  //    IIFE is hoisted and concatenated into one script; see build.js):
  //
  //      registerSyncType("rpn_link", { table: "rpn_link" });
  //
  //    `table` is the Supabase table name that record type is inserted
  //    into. If you skip registerSyncType() entirely, enqueueSync() still
  //    works — the record_type string is used as the table name directly —
  //    but registering is the documented, explicit way to do it and is
  //    where you'd hang future per-type behaviour (e.g. a different write
  //    strategy) without changing the queue itself.
  // 2. Whenever your feature has something to sync, call:
  //
  //      enqueueSync("rpn_link", { rpn_name, rpn_code, rpn_whatsapp, city_area });
  //
  //    enqueueSync() stamps tenant_id onto the payload automatically (see
  //    tenantId() below) if you didn't already include one, timestamps it,
  //    and marks it "pending". That's it — you never touch sync_queue's SQL
  //    directly, and you never call Supabase yourself.
  // 3. The background worker (started once at boot, see main.js) picks up
  //    "pending"/"failed" rows whose next_attempt_ts has arrived, POSTs each
  //    payload as one row to `${table}` via the Supabase REST API, and marks
  //    it "synced" on success or "failed" (with exponential backoff) on
  //    failure. Your feature never needs to poll, retry, or handle offline
  //    itself — enqueue and forget.
  // 4. If your feature wants to show sync status (e.g. a future Sync
  //    Reminder Modal), read it with pendingSyncCount()/pendingSyncRows() —
  //    read-only, never mutate sync_queue directly from UI code.
  //
  // A tiny "sync_health_check" type is registered below and is what this
  // foundation is verified against end-to-end (see test/sync-queue.test.js
  // and README.md) — it is not a real feature, just proof the pipeline
  // works before RPN linkage/support tasks/etc. are built on top of it.

  // ---- tenant identity ----
  // "Tenant" reuses this device's existing branch identity (getBranchId(),
  // docnum.js) rather than inventing a second one — every other per-device
  // identifier in this app (stock_adjustments, doc_counters, DN/GRV
  // messaging) already keys off it. Once multi-tenant Supabase tables exist,
  // this is the column every synced row is attributed by.
  function tenantId(){ return getBranchId(); }

  // ---- Supabase config ----
  // Always Digital Commerce's own project — the same one device check-in
  // uses, defined once in devicecheckin.js. Shops no longer enter a URL/key;
  // any supabase_url/supabase_anon_key left in settings by older versions
  // is ignored. (Tests swap this function out to point at a local server.)
  function getSupabaseConfig(){
    return { url: DC_SUPABASE_URL, anonKey: DC_ANON_KEY };
  }
  function supabaseConfigured(){
    const cfg = getSupabaseConfig();
    return !!(cfg.url.trim() && cfg.anonKey.trim());
  }

  // ---- connectivity ----
  // navigator.onLine reflects the OS/browser's own link-layer status, which
  // is what "appropriate to the platform" means here: it's a standard Web
  // Platform API, so it works the same way in the PWA (a real browser) and
  // in the Tauri build (WebView2/WebKit, which implement it identically) —
  // no Tauri-specific plugin needed. It's a cheap pre-filter, not a
  // guarantee Supabase itself is reachable; the sync worker's own POST is
  // the real reachability test, and a failed POST just requeues with
  // backoff exactly like a genuinely offline device would.
  function isOnline(){ return typeof navigator==="undefined" || navigator.onLine!==false; }

  // ---- registry ----
  const SYNC_TYPES = {};
  function registerSyncType(recordType, opts){
    SYNC_TYPES[recordType] = Object.assign({ table: recordType }, opts||{});
  }
  function syncTableFor(recordType){
    return (SYNC_TYPES[recordType] && SYNC_TYPES[recordType].table) || recordType;
  }
  // Reference registration + what the worker is proven against (see file
  // header). Not a real feature — RPN linkage/support tasks are later work.
  registerSyncType("sync_health_check", { table:"sync_health_check" });

  // ---- enqueue / read ----
  function enqueueSync(recordType, payload, recordKey){
    if(!recordType) throw new Error("enqueueSync needs a record type");
    const now = new Date().toISOString();
    const body = Object.assign({}, payload||{});
    if(body.tenant_id===undefined) body.tenant_id = tenantId();
    run(`INSERT INTO sync_queue(record_type,record_key,tenant_id,payload_json,status,attempts,next_attempt_ts,created_ts,updated_ts)
         VALUES(?,?,?,?,'pending',0,?,?,?)`,
      [recordType, String(recordKey||""), tenantId(), JSON.stringify(body), now, now, now]);
    return one("SELECT * FROM sync_queue WHERE id=(SELECT last_insert_rowid())");
  }
  function pendingSyncRows(recordType){
    return recordType
      ? all("SELECT * FROM sync_queue WHERE record_type=? AND status IN ('pending','failed') ORDER BY id",[recordType])
      : all("SELECT * FROM sync_queue WHERE status IN ('pending','failed') ORDER BY id");
  }
  function pendingSyncCount(recordType){
    const r = recordType
      ? one("SELECT COUNT(*) c FROM sync_queue WHERE record_type=? AND status IN ('pending','failed')",[recordType])
      : one("SELECT COUNT(*) c FROM sync_queue WHERE status IN ('pending','failed')");
    return r? r.c : 0;
  }

  // ---- backoff ----
  const SYNC_BASE_DELAY_MS = 5000;        // first retry ~5s later
  const SYNC_MAX_DELAY_MS = 30*60*1000;   // capped at 30 minutes
  const SYNC_MAX_ATTEMPTS_PER_RUN = 25;   // one worker tick moves at most this many rows, so a huge backlog can't hang a tick
  function syncBackoffMs(attempts){
    return Math.min(SYNC_MAX_DELAY_MS, SYNC_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts-1)));
  }

  // ---- minimal Supabase REST client (no SDK — this app has no bundler; a
  // plain fetch() to PostgREST is the smallest thing that works identically
  // in the PWA and inside the Tauri webview, which both allow ordinary
  // fetch() to an external https origin without extra Tauri capabilities —
  // Tauri's permission system only gates calls into its own Rust commands) ----
  async function supabaseInsert(table, row){
    const cfg = getSupabaseConfig();
    if(!cfg.url.trim() || !cfg.anonKey.trim()) throw new Error("Supabase is not configured");
    const res = await fetch(cfg.url.replace(/\/+$/,"")+"/rest/v1/"+encodeURIComponent(table), {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "apikey": cfg.anonKey,
        "Authorization": "Bearer "+cfg.anonKey,
        "Prefer":"return=minimal"
      },
      body: JSON.stringify(row)
    });
    if(!res.ok){
      let detail = "";
      try{ detail = (await res.text()).slice(0,200); }catch(e){}
      throw new Error("Supabase "+res.status+(detail? ": "+detail : ""));
    }
    return true;
  }

  // ---- worker ----
  let _syncRunning = false;
  async function pushOneSyncRow(row){
    try{
      await supabaseInsert(syncTableFor(row.record_type), JSON.parse(row.payload_json));
      const now = new Date().toISOString();
      run("UPDATE sync_queue SET status='synced', synced_ts=?, updated_ts=?, last_error='' WHERE id=?",[now,now,row.id]);
      return true;
    }catch(e){
      const attempts = (row.attempts||0)+1;
      const now = new Date().toISOString();
      const next = new Date(Date.now()+syncBackoffMs(attempts)).toISOString();
      run("UPDATE sync_queue SET status='failed', attempts=?, next_attempt_ts=?, updated_ts=?, last_error=? WHERE id=?",
        [attempts, next, now, String((e&&e.message)||e).slice(0,300), row.id]);
      return false;
    }
  }
  // Never blocks the UI or any core operation: this is only ever invoked
  // from a timer/connectivity event (see startSyncWorker) or an explicit,
  // call from Settings → Cloud sync's "Sync now" — nothing
  // in POS/stocktake/etc. awaits it, and _syncRunning skips overlapping runs
  // instead of queueing up work that could pile up behind a slow network.
  async function runSyncWorker(){
    if(_syncRunning) return { attempted:0, synced:0, reason:"already running" };
    if(!supabaseConfigured()) return { attempted:0, synced:0, reason:"not configured" };
    if(!isOnline()) return { attempted:0, synced:0, reason:"offline" };
    _syncRunning = true;
    try{
      const now = new Date().toISOString();
      const due = all(
        "SELECT * FROM sync_queue WHERE status IN ('pending','failed') AND (next_attempt_ts='' OR next_attempt_ts<=?) ORDER BY id LIMIT ?",
        [now, SYNC_MAX_ATTEMPTS_PER_RUN]
      );
      let synced=0;
      for(const row of due){ if(await pushOneSyncRow(row)) synced++; }
      if(due.length) await persist();
      return { attempted:due.length, synced };
    } finally { _syncRunning = false; }
  }

  const SYNC_POLL_MS = 60000; // background check while the app is open; a failed POST already retries sooner via backoff
  let _syncTimer = null;
  // One tick drives both the worker and the reminder modal below — the
  // modal reacts to the exact same timer/online-event the worker already
  // uses, rather than a second connectivity check running on its own clock.
  async function syncTick(){
    await runSyncWorker();
    checkSyncReminderModal();
  }
  // Called once at boot (main.js), after initDB. Entirely passive: offline or
  // with nothing due, every tick below is a few synchronous reads and
  // returns immediately; an unreachable server just backs off.
  function startSyncWorker(){
    if(_syncTimer) return;
    syncTick();
    _syncTimer = setInterval(syncTick, SYNC_POLL_MS);
    if(typeof window!=="undefined" && window.addEventListener) window.addEventListener("online", syncTick);
  }

  // ---- Sync Reminder Modal (generic, reusable) ----
  // Not RPN/support-specific: it only ever reads pendingSyncCount()/
  // pendingSyncRows() — the exact same queries the Cloud sync (beta)
  // Settings card already uses — so any future record type (RPN linkage,
  // support tasks, EOD, payouts, backups, ...) shows up here automatically
  // the moment it calls enqueueSync(), with no changes to this section.
  let _syncReminderVisible = false;
  let _syncReminderEl = null;
  function syncReminderVisible(){ return _syncReminderVisible; }
  // Pure trigger condition (Part C.2/C.5) — no DOM, so it's directly
  // testable: offline OR unconfigured, AND something pending, AND not in
  // the middle of a sale or still onboarding.
  function syncReminderShouldShow(){
    if(typeof route!=="undefined" && route==="setup") return false;         // RPN linkage is already on screen there
    if(typeof drawerOpen!=="undefined" && drawerOpen) return false;         // an in-progress sale (cart open)
    return (!isOnline() || !supabaseConfigured()) && pendingSyncCount()>0;
  }
  // User-dismiss path (✕ / outside click, via openModal's onClose) and the
  // programmatic one tests use — both just mark it hidden. Nothing here
  // touches sync_queue, so the very next tick's syncReminderShouldShow()
  // decides fresh: still unsynced -> it reappears, exactly as specified.
  function dismissSyncReminder(){
    _syncReminderVisible = false;
    if(_syncReminderEl){ try{ _syncReminderEl.remove(); }catch(e){} _syncReminderEl=null; }
  }
  function checkSyncReminderModal(){
    if(!syncReminderShouldShow()){ if(_syncReminderVisible) dismissSyncReminder(); return; }
    if(_syncReminderVisible) return; // already up, leave it alone
    // Never stack on top of another modal already in front of the user
    // (checkout/discount flow, a product editor, ...) — try again next tick.
    if(typeof document!=="undefined" && document.querySelector && document.querySelector(".modalOverlay")) return;
    _syncReminderVisible = true;
    if(typeof document==="undefined" || typeof document.createElement!=="function" || typeof openModal!=="function") return; // headless/test context — state above still exercised
    const pending = pendingSyncRows();
    const byType = {};
    pending.forEach(r=>{ byType[r.record_type]=(byType[r.record_type]||0)+1; });
    const lines = Object.keys(byType).map(k=>`<li>${escapeHtml(k)}: ${byType[k]}</li>`).join("");
    _syncReminderEl = openModal("Waiting to sync", `
      <p class="muted">You're offline. ${pending.length} record(s) are saved on this device and will sync automatically once you're back online.</p>
      <ul style="margin:8px 0 0 18px;padding:0">${lines}</ul>
    `, dismissSyncReminder);
  }

  // ---- Settings card (Cloud sync) ----
  // Status only: the project is built in (getSupabaseConfig above), so
  // there's nothing for the shop to enter — just whether its records have
  // gone up, and a way to try now instead of waiting for the next tick.
  function cloudSyncStatusText(){
    const pending = pendingSyncCount();
    if(!pending) return "Everything is synced.";
    if(!isOnline()) return `You're offline — ${pending} record(s) saved on this device will sync when you reconnect.`;
    const retrying = one("SELECT COUNT(*) c FROM sync_queue WHERE status='failed'").c;
    return `${pending} record(s) waiting to sync.` + (retrying? ` ${retrying} couldn't be sent yet and will be retried automatically.` : "");
  }
  function cloudSyncSectionHtml(){
    return `
      <div class="card">
        <h3>Cloud sync</h3>
        <p class="muted">Built in — there's nothing to set up. Records are kept on this device and sent to Digital Commerce in the background whenever you're online.</p>
        <p class="muted" id="cloudSyncStatus" style="font-size:12px">${escapeHtml(cloudSyncStatusText())}</p>
        ${pendingSyncCount()? `<button class="btn btn-outline" id="syncNowBtn" style="margin-top:6px">Sync now</button>` : ""}
      </div>`;
  }
  function wireCloudSyncSection(){
    const btn = document.getElementById("syncNowBtn");
    if(btn) btn.onclick=async ()=>{
      btn.disabled = true;
      btn.textContent = "Syncing…";
      await runSyncWorker();
      render();
    };
  }
