  // ================== Notification bell (v37, owner decisions 8, 12, 55) ==================
  // docs/stock-control/v37-design.md §4. A bell in the header on every device,
  // with an unread count per person.
  //   * notices: one row per event (a unique key), so a repeated sync never makes a
  //     second one; read_by lists the people (staff id, or "device" in single
  //     operator mode) who read it. Who may see each category is checked again
  //     when it is shown (the role decides, decision 48).
  //   * titles only: never amounts, prices or customers' names (decision 8).
  //   * every 60 s while the app is open, visible and online: one check at a time
  //     (scTick: send, then pull with cursors, so nothing is lost offline);
  //     paused when hidden, run at once on return.
  //   * a short two-tone chime for a notice new in this check, never twice for one
  //     key; Settings → Notifications: sound and categories on/off per person.
  //   * phone/PC notifications while the app runs (Level 1): asked once, after the
  //     first notice, never again after a "no". Push when closed is Level 2.

  const BELL_EVERY_MS = 60000;
  const BELL_KEEP_DAYS = 60;
  const BELL_CATEGORIES = [
    { id:"market", label:"Market feed (seiGEN)", right:null },
    { id:"itred", label:"iTred sales orders", right:"m.sell" },
    { id:"requests", label:"Stock requests", right:null },          // new: reviewers; status: the requesting branch (bellRight)
    { id:"recalls", label:"Recalls", right:null },
    { id:"counts", label:"Count differences to approve", right:"approve_counts" },
    { id:"movements", label:"Incoming and received stock (DN / GRV)", right:null },
  ];

  function migrateBell(t){
    try{ t.run(`CREATE TABLE IF NOT EXISTS notices(
      key TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, route TEXT DEFAULT '', ts TEXT NOT NULL,
      right TEXT DEFAULT '', read_by TEXT DEFAULT '[]', chimed INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, body TEXT DEFAULT '')`); }catch(e){}
    try{ t.run("CREATE INDEX IF NOT EXISTS ix_notices_ts ON notices(ts)"); }catch(e){}
  }

  // ---- who is looking ----
  function bellPerson(){
    const s = typeof staffSession==="function"? staffSession() : null;
    return s && s.id? "staff:"+s.id : "device";
  }
  function bellSoundOn(){ return getSetting("bell_sound_"+bellPerson(), "1")!=="0"; }
  function bellCatsOff(){ return scJson(getSetting("bell_cats_off_"+bellPerson(), "[]"), []); }
  // A Guest's seat sees the Market feed only (decision 49)
  function bellCanSee(n){
    if(scGuest() && n.category!=="market") return false;
    if(n.right && n.right.split("|").every(r=> typeof can==="function" && !can(r))) return false;
    return !bellCatsOff().includes(n.category);
  }
  function bellVisible(){
    return all("SELECT * FROM notices WHERE hidden=0 ORDER BY ts DESC LIMIT 200").filter(bellCanSee);
  }
  function bellIsRead(n, person){ return scJson(n.read_by, []).includes(person || bellPerson()); }
  function bellUnread(){ const me = bellPerson(); return bellVisible().filter(n=>!bellIsRead(n, me)).length; }

  // ---- adding (INSERT OR IGNORE by key: never twice) ----
  // seed: the first look at a source marks what is already there as old (no flood, no chime)
  function bellAdd(key, category, title, o){
    o = o || {};
    const before = one("SELECT key FROM notices WHERE key=?",[key]);
    if(before) return false;
    run("INSERT INTO notices(key,category,title,route,ts,right,read_by,chimed,hidden,body) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [key, category, String(title).slice(0,140), o.route||"", o.ts||new Date().toISOString(), o.right||"", o.seed? JSON.stringify(["*"]) : "[]", o.seed? 1 : 0, o.seed? 1 : 0, String(o.body||"").slice(0,2000)]);
    return !o.seed;
  }
  // The notices a pull brings (stock-ctl.js scPull's changes). -> how many are new
  function bellFromChanges(ch){
    if(!ch) return 0;
    const seed = !!ch.first;
    let n = 0;
    const me = scMyBranch();
    (ch.market||[]).forEach(m=>{ if(bellAdd("market:"+m.id, "market", m.title, { route:"bell", ts:m.starts_at, body:m.body, seed:seed && getSetting("bell_market_seen","")==="1" })) n++; });
    setSetting("bell_market_seen","1");
    // drop broadcasts seiGEN switched off
    if(Array.isArray(ch.market)){ const ids = new Set(ch.market.map(m=>"market:"+m.id)); all("SELECT key FROM notices WHERE category='market'").forEach(r=>{ if(!ids.has(r.key)) run("DELETE FROM notices WHERE key=?",[r.key]); }); }
    if(ch.guest) return n;
    (ch.requests||[]).forEach(({ q, was })=>{
      if(!was && q.status==="pending" && q.from_branch_id!==me){
        if(bellAdd("srq:new:"+q.id, "requests", "New stock request "+q.req_no+" from "+(q.from_branch||"a branch"), { route:"srq:"+q.id, right:"review_requisitions", seed })) n++;
      }
      if(q.from_branch_id===me && was!==q.status && q.status!=="pending"){
        if(bellAdd("srq:"+q.id+":"+q.status, "requests", "Stock request "+q.req_no+": "+(SRQ_STATUS[q.status]||q.status), { route:"srq:"+q.id, right:"request_stock|review_requisitions", seed: seed || was===null && q.status==="received" })) n++;
      }
    });
    (ch.recalls||[]).forEach(({ q, was })=>{
      if(q.branch_id===me && !was && q.status==="open"){
        if(bellAdd("rcl:new:"+q.id, "recalls", "Recall "+q.rcl_no+": send stock back to "+(q.to_branch||"main")+" by "+q.due_date, { route:"rcl:"+q.id, right:"m.dispatch", seed })) n++;
      }
      if(q.overdue && q.terminal_id===scMyTerminal()){
        if(bellAdd("rcl:overdue:"+q.id, "recalls", "Recall "+q.rcl_no+" is overdue ("+(q.branch||"")+")", { route:"rcl:"+q.id, right:"recall_stock" })) n++;
      }
      if(was && q.terminal_id===scMyTerminal() && was.status!==q.status && ["partly_sent","sent","received"].includes(q.status)){
        if(bellAdd("rcl:"+q.id+":"+q.status, "recalls", "Recall "+q.rcl_no+": "+(RCL_STATUS[q.status]||q.status), { route:"rcl:"+q.id, right:"recall_stock" })) n++;
      }
    });
    (ch.counts||[]).forEach(({ c })=>{
      if(c.status==="waiting"){ if(bellAdd("cc:wait:"+c.id, "counts", "Count difference to approve: "+c.name, { route:"counts", right:"approve_counts", seed })) n++; }
      else run("UPDATE notices SET hidden=1 WHERE key=?",["cc:wait:"+c.id]);   // decided: nothing left to do
    });
    (ch.dispatches||[]).forEach(d=>{
      const s = seed && getSetting("bell_moves_seen","")!=="1";
      if(d.to_branch_id===me && d.status==="sent"){ if(bellAdd("dn:in:"+d.id, "movements", "Incoming "+d.dn_display+" from "+d.from_branch, { route:"incoming", right:"m.receive", ts:d.sent_at, seed:s })) n++; }
      if(d.from_branch_id===me && (d.status==="received" || d.status==="received_diff")){
        if(bellAdd("dn:rcv:"+d.id, "movements", d.dn_display+" received at "+d.to_branch+(d.grv_display? " ("+d.grv_display+")" : ""), { route:"dispatches", right:"m.dispatch", ts:d.received_at, seed:s })) n++;
      }
    });
    setSetting("bell_moves_seen","1");
    if(Array.isArray(ch.itred)) ch.itred.forEach(o=>{
      const t = new Date(o.created_at);
      if(bellAdd("itred:"+o.id, "itred", "New iTred order ("+t.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })+")", { route:"itred", right:"m.sell", ts:o.created_at, seed: seed && getSetting("bell_itred_seen","")!=="1" })) n++;
    });
    if(ch.itred) setSetting("bell_itred_seen","1");
    return n;
  }
  // Notices made on this device (a count waiting here, before seiGEN has it)
  function bellLocal(){
    let n = 0;
    try{ all("SELECT * FROM sc_counts WHERE status='waiting' AND mine=1").forEach(c=>{ if(bellAdd("cc:wait:"+c.id, "counts", "Count difference to approve: "+c.name, { route:"counts", right:"approve_counts" })) n++; }); }catch(e){}
    return n;
  }
  function bellPrune(){ run("DELETE FROM notices WHERE ts<?",[new Date(Date.now()-BELL_KEEP_DAYS*86400000).toISOString()]); }

  // ---- reading ----
  function bellMarkRead(key){
    const n = one("SELECT * FROM notices WHERE key=?",[key]); if(!n) return;
    const r = scJson(n.read_by, []), me = bellPerson();
    if(!r.includes(me)){ r.push(me); run("UPDATE notices SET read_by=? WHERE key=?",[JSON.stringify(r), key]); }
  }
  function bellMarkAllRead(){ bellVisible().forEach(n=> bellMarkRead(n.key)); }

  // ---- the chime (WebAudio: two short tones; browsers allow it only after a tap since opening) ----
  let _bellAudio = null;
  function bellChime(){
    try{
      const AC = typeof window!=="undefined" && (window.AudioContext || window.webkitAudioContext);
      if(!AC) return false;
      _bellAudio = _bellAudio || new AC();
      if(_bellAudio.state==="suspended") _bellAudio.resume().catch(()=>{});
      const t = _bellAudio.currentTime;
      [[880, 0], [1320, 0.16]].forEach(([f, at])=>{
        const o = _bellAudio.createOscillator(), g = _bellAudio.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t+at); g.gain.exponentialRampToValueAtTime(0.25, t+at+0.02); g.gain.exponentialRampToValueAtTime(0.0001, t+at+0.15);
        o.connect(g); g.connect(_bellAudio.destination); o.start(t+at); o.stop(t+at+0.16);
      });
      return true;
    }catch(e){ return false; }
  }
  // The new notices this person may see: chime once (if on), a phone/PC notification while running.
  function bellAnnounce(){
    const fresh = all("SELECT * FROM notices WHERE chimed=0 AND hidden=0 ORDER BY ts").filter(bellCanSee);
    if(!fresh.length) return { chimed:false, shown:0 };
    fresh.forEach(n=> run("UPDATE notices SET chimed=1 WHERE key=?",[n.key]));   // never again for the same key
    const chimed = bellSoundOn()? bellChime() : false;
    let shown = 0;
    if(typeof Notification!=="undefined" && Notification.permission==="granted"){
      fresh.slice(0,3).forEach(n=>{ try{ new Notification(n.title, { tag:n.key, icon:"icon-192.png" }); shown++; }catch(e){} });
    }
    if(getSetting("bell_notif_ask","")==="") setSetting("bell_notif_ask","due");   // the card in the bell asks, once
    return { chimed, shown, count:fresh.length };
  }

  // ---- the 60 s check ----
  let _bellTimer = null, _bellBusy = false, _bellStarted = false;
  function bellHidden(){ return typeof document!=="undefined" && document.visibilityState==="hidden"; }
  async function bellTick(){
    if(_bellBusy) return { skipped:"busy" };
    if(bellHidden()) return { skipped:"hidden" };
    if(!isOnline()) return { skipped:"offline" };
    if(!scRegistered()) return { skipped:"not registered" };
    _bellBusy = true;
    try{
      const r = await scTick();
      let fresh = bellLocal();
      if(r.pull && r.pull.ok) fresh += bellFromChanges(r.pull.changes);
      bellPrune();
      const a = bellAnnounce();
      if(fresh || a.count) await persist();
      bellRefreshBadge();
      return { fresh, announced:a };
    }catch(e){ return { error:String(e && e.message || e) }; }
    finally{ _bellBusy = false; }
  }
  function bellSchedule(){
    if(_bellTimer) clearTimeout(_bellTimer);
    _bellTimer = setTimeout(async ()=>{ _bellTimer = null; await bellTick(); if(!bellHidden()) bellSchedule(); }, BELL_EVERY_MS);
  }
  function startBell(){
    if(_bellStarted) return;
    _bellStarted = true;
    setTimeout(async ()=>{ await bellTick(); bellSchedule(); }, 3000);
    if(typeof document!=="undefined" && document.addEventListener) document.addEventListener("visibilitychange", ()=>{
      if(bellHidden()){ if(_bellTimer){ clearTimeout(_bellTimer); _bellTimer = null; } return; }   // paused while hidden
      bellTick().then(bellSchedule);                                                              // at once on return
    });
    if(typeof window!=="undefined" && window.addEventListener){
      window.addEventListener("online", ()=>{ bellTick().then(bellSchedule); });
      // a tap unlocks the sound for the session (browsers' rule)
      const unlock = ()=>{ try{ const AC = window.AudioContext || window.webkitAudioContext; if(AC){ _bellAudio = _bellAudio || new AC(); if(_bellAudio.state==="suspended") _bellAudio.resume(); } }catch(e){} };
      window.addEventListener("pointerdown", unlock, { once:true });
    }
  }

  // ---- the header button and the list ----
  const ICON_BELL = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
  function bellButtonHtml(){
    if(!scRegistered()) return "";
    const n = bellUnread();
    return `<button class="bell-btn" id="bellBtn" aria-label="Notifications${n? ", "+n+" unread" : ""}" title="Notifications">${ICON_BELL}<span class="bell-badge" id="bellBadge" ${n? "" : "hidden"}>${n>99? "99+" : n}</span></button>`;
  }
  function bellWire(){
    const b = typeof document!=="undefined" && document.getElementById? document.getElementById("bellBtn") : null;
    if(b) b.onclick = ()=> openBell();
  }
  function bellRefreshBadge(){
    const el = typeof document!=="undefined" && document.getElementById? document.getElementById("bellBadge") : null;
    if(!el) return;
    const n = bellUnread();
    el.textContent = n>99? "99+" : String(n); el.hidden = !n;
    const b = document.getElementById("bellBtn"); if(b) b.setAttribute("aria-label", "Notifications"+(n? ", "+n+" unread" : ""));
  }
  const BELL_CAT_LABEL = Object.fromEntries(BELL_CATEGORIES.map(c=>[c.id, c.label]));
  function openBell(){
    const wrap = openModal("Notifications", `<div id="bellBody"></div>`);
    const body = wrap.querySelector("#bellBody");
    let view = "list";
    const draw = ()=>{
      if(view==="settings"){
        body.innerHTML = bellSettingsHtml()+`<button class="btn btn-outline" id="bellBack" style="margin-top:8px">Back</button>`;
        bellSettingsWire(body);
        body.querySelector("#bellBack").onclick = ()=>{ view = "list"; draw(); };
        return;
      }
      const list = bellVisible(), me = bellPerson();
      const ask = getSetting("bell_notif_ask","")==="due" && typeof Notification!=="undefined" && Notification.permission==="default";
      body.innerHTML = `
        ${ask? `<div class="box" id="bellAsk" style="margin-bottom:8px;font-size:13px">Show notifications on this ${/Mobi|Android/i.test(navigator.userAgent||"")? "phone" : "computer"} too, while the app is open?
          <div style="display:flex;gap:6px;margin-top:6px"><button class="btn btn-sm btn-primary" id="bellAskYes">Yes</button><button class="btn btn-sm btn-outline" id="bellAskNo">No</button></div></div>` : ""}
        <div style="display:flex;gap:6px;margin-bottom:6px"><button class="btn btn-sm btn-outline" id="bellAllRead" ${list.some(n=>!bellIsRead(n, me))? "" : "disabled"}>Mark all read</button>
          <button class="btn btn-sm btn-ghost" id="bellSettings" style="margin-left:auto">Settings</button></div>
        ${list.length? `<div id="bellList">${list.map(n=>`<button type="button" class="bell-item${bellIsRead(n, me)? "" : " unread"}" data-key="${escapeHtml(n.key)}"
            style="display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--border);background:${bellIsRead(n, me)? "none" : "var(--surface,#f6f7f9)"};padding:8px 6px;cursor:pointer">
            <div style="font-weight:${bellIsRead(n, me)? 400 : 700};font-size:13.5px">${escapeHtml(n.title)}</div>
            <div class="muted" style="font-size:11.5px">${escapeHtml(BELL_CAT_LABEL[n.category]||n.category)} · ${escapeHtml(new Date(n.ts).toLocaleString())}</div></button>`).join("")}</div>`
          : `<p class="muted" id="bellEmpty">Nothing new.</p>`}`;
      body.querySelectorAll("[data-key]").forEach(b=> b.onclick = ()=>{ const n = one("SELECT * FROM notices WHERE key=?",[b.dataset.key]); bellMarkRead(n.key); persist(); wrap.remove(); bellGo(n); });
      body.querySelector("#bellAllRead").onclick = ()=>{ bellMarkAllRead(); persist(); bellRefreshBadge(); draw(); };
      body.querySelector("#bellSettings").onclick = ()=>{ view = "settings"; draw(); };   // per person: no Settings right needed
      const yes = body.querySelector("#bellAskYes"), no = body.querySelector("#bellAskNo");
      if(yes) yes.onclick = async ()=>{ let p = "denied"; try{ p = await Notification.requestPermission(); }catch(e){} setSetting("bell_notif_ask", p==="granted"? "yes" : "no"); persist(); draw(); };
      if(no) no.onclick = ()=>{ setSetting("bell_notif_ask","no"); persist(); draw(); };
    };
    draw();
    bellRefreshBadge();
  }
  // Tap: read, then the screen it is about
  function bellGo(n){
    const r = n.route||"";
    if(n.category==="market"){ openModal(n.title, `<p style="white-space:pre-wrap">${escapeHtml(n.body||"")}</p><p class="muted" style="font-size:12px">From seiGEN · ${escapeHtml(new Date(n.ts).toLocaleString())}</p>`); bellRefreshBadge(); return; }
    route = "more";
    if(r.startsWith("srq:")){ moreTab = "stockctl"; srqTab = "requests"; render(); openRequestHistory(r.slice(4)); return; }
    if(r.startsWith("rcl:")){ moreTab = "stockctl"; srqTab = "recalls"; render(); openRecallHistory(r.slice(4)); return; }
    if(r==="counts"){ moreTab = "stocktake"; cycleTab = "approve"; render(); return; }
    if(r==="itred"){ moreTab = "itredorders"; render(); return; }
    if(r==="incoming" || r==="dispatches"){ route = "products"; render(); return; }
    render();
  }

  // ---- Settings → Notifications (per person: in the bell, and on the Settings page) ----
  function bellSettingsHtml(){
    if(!scRegistered()) return "";
    const off = bellCatsOff(), cats = BELL_CATEGORIES.filter(c=> !scGuest() || c.id==="market");
    const perm = typeof Notification==="undefined"? "unsupported" : Notification.permission;
    return `<div class="card" id="bellSettingsCard">
      <h3 style="margin-top:0">Notifications</h3>
      <p class="muted" style="font-size:12.5px;margin:0 0 6px">For ${escapeHtml(bellPerson()==="device"? "this device (single operator)" : scWho())}. The bell shows titles only, never amounts or names.</p>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="bellSound" ${bellSoundOn()? "checked" : ""}> A short chime for each new notification</label>
      <p class="muted" style="font-size:12px;margin:2px 0 8px">Browsers allow sound only after you've tapped the app once since opening it. The bell's number shows either way.</p>
      ${cats.map(c=>`<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-bell-cat="${c.id}" ${off.includes(c.id)? "" : "checked"}> ${escapeHtml(c.label)}</label>`).join("")}
      <p class="muted" style="font-size:12px;margin:8px 0 0" id="bellPerm">${perm==="granted"? "Phone/PC notifications: on (while the app is open)." : perm==="denied"? "Phone/PC notifications are blocked for this app. To turn them on: the lock or ⓘ next to the address → Notifications → Allow (on a phone: Settings → Apps → your browser → Notifications)." : perm==="unsupported"? "This browser can't show phone/PC notifications." : "Phone/PC notifications: the bell asks once, after the first notification."}</p>
    </div>`;
  }
  function bellSettingsWire(scope){
    const s = scope.querySelector("#bellSound");
    if(!s) return;
    s.onchange = ()=>{ setSetting("bell_sound_"+bellPerson(), s.checked? "1" : "0"); if(s.checked) bellChime(); persist(); };
    scope.querySelectorAll("[data-bell-cat]").forEach(c=> c.onchange = ()=>{
      const off = new Set(bellCatsOff()); if(c.checked) off.delete(c.dataset.bellCat); else off.add(c.dataset.bellCat);
      setSetting("bell_cats_off_"+bellPerson(), JSON.stringify([...off])); persist(); bellRefreshBadge();
    });
  }
