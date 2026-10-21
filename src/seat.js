  // ================== Office seats (v32; seiGEN 20261109120000_office_seats) ==================
  // docs/office/office-seat-design.md. An Office seat is a device on the MAIN
  // branch with no till, for the bookkeeper, the stores clerk or the owner: it
  // never sells, takes payments or runs End of Day (hidden here, refused by
  // seiGEN, and marked in the signed licence); it holds main-branch stock like
  // a till and does stores and office work by the signed-in person's rights.
  //
  // Joining: the Owner or an Admin makes an invite (a code + a link, one use,
  // 24 hours, one named person); the person opens the link, installs the app,
  // and joins INSIDE the installed app (never in a browser tab, so the data
  // lives where the app does); they set or enter their PIN; the Owner or an
  // Admin approves the device after comparing the device check shown on both
  // screens; then the seat downloads the main branch's data.
  // The seat never learns the business secret phrase: seiGEN gives it a phrase
  // of its own (kept in secret_phrase, never shown). Each call from a seat
  // carries the signed-in person's token after it ("<phrase>|<token>").

  const SEAT_WEB_APP = "https://mobilepos-preview.seigendc.workers.dev/";   // where an invite link points when this device isn't the web app itself
  const SEAT_DENY = ["m.sell","m.credit","m.eod","void_return","credit_over_limit"];   // never on a seat (seiGEN's cl_seat_need too)
  const SEAT_CODE_KEY = "scl_seat_invite";   // this address's storage: the invite CODE only (never a phrase or a PIN), for 48 hours
  const SEAT_POLL_MS = 30000;

  // ---- what this device is ----
  function isSeat(){
    if(getSetting("terminal_kind","")==="seat") return true;
    try{ const l = typeof currentLicence==="function"? currentLicence() : null; return !!(l && (l.features & 1)); }catch(e){ return false; }   // the signed licence's seat bit
  }
  function seatWaiting(){ return getSetting("terminal_kind","")==="seat" && getSetting("seat_approval","")!=="approved"; }
  function seatCheckOf(k){ const h = sha256HexPure(String(k||"")).toUpperCase(); return h.slice(0,2)+"-"+h.slice(2,4); }
  function seatTillLabel(code){ return /^S\d+$/.test(String(code||""))? code+" (Office seat)" : String(code||""); }
  function seatStandalone(){
    try{ return !!((window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone===true); }catch(e){ return false; }
  }
  function seatTauri(){ return !!(typeof window!=="undefined" && window.__TAURI__); }
  function seatCanJoinHere(){ return seatStandalone() || seatTauri(); }
  // The browser and device, from the user agent (an in-app browser can't install apps, so it's warned off).
  function seatDevice(ua){
    ua = String(ua || (typeof window!=="undefined" && window.navigator && window.navigator.userAgent) || "");
    const fb = /FBAN|FBAV|FB_IAB|FBIOS|FB4A/.test(ua), wa = /WhatsApp/i.test(ua), ig = /Instagram/i.test(ua);
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof window!=="undefined" && window.navigator && window.navigator.maxTouchPoints>1);
    const android = /Android/.test(ua);
    const webview = android && /; wv\)/.test(ua);   // an Android app's own browser (not Chrome)
    const inApp = fb || wa || ig || /\bLine\//.test(ua) || webview;
    const edge = /Edg(A|iOS)?\//.test(ua);
    const browser = edge? "Edge" : /CriOS|Chrome\//.test(ua)? "Chrome" : /Firefox|FxiOS/.test(ua)? "Firefox" : /Safari\//.test(ua)? "Safari" : "browser";
    return { inApp, inAppName: wa? "WhatsApp" : fb? "Facebook" : ig? "Instagram" : "this app", ios, android, desktop: !ios && !android, browser,
      hint: (ios? "iPhone/iPad" : android? "Android" : /Windows/.test(ua)? "Windows" : /Mac/.test(ua)? "Mac" : "PC") + " · " + (seatTauri()? "Windows program" : browser) };
  }

  // ---- the invite code: from the link, kept for the installed app (Android, PC) ----
  function takeSeatCodeFromUrl(){
    try{
      const loc = window.location, m = /(?:^#|&)seat=([A-Za-z0-9-]{8,9})(?:&|$)/.exec(String(loc.hash||""));
      if(!m) return "";
      const c = formatJoinCode(m[1]);
      seatRememberCode(c);
      if(window.history && window.history.replaceState) window.history.replaceState(null, "", loc.pathname + loc.search);
      return c;
    }catch(e){ return ""; }
  }
  function seatRememberCode(c){ try{ window.localStorage.setItem(SEAT_CODE_KEY, JSON.stringify({ code:formatJoinCode(c), ts:Date.now() })); }catch(e){} }
  function seatStoredCode(){
    try{ const o = JSON.parse(window.localStorage.getItem(SEAT_CODE_KEY)||"null"); return o && o.code && Date.now()-o.ts < 48*3600e3? o.code : ""; }catch(e){ return ""; }
  }
  function seatForgetCode(){ try{ window.localStorage.removeItem(SEAT_CODE_KEY); }catch(e){} }
  function seatInviteLink(code){
    const loc = typeof window!=="undefined" && window.location, here = loc && /^https?:$/.test(loc.protocol)? loc.origin + loc.pathname : SEAT_WEB_APP;
    return here + "#seat=" + String(code||"").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  function seatShareText(inv, link){
    const until = new Date(inv.expires_ts);
    return "Hi " + inv.person_name + ", you're invited to " + (inv.business_name || getSetting("shop_name","") || "our business") +
      " on seiGEN Commerce Lite as an Office seat (" + inv.role_name + ").\n" +
      "1. Open this link in Chrome (Android or PC) or Safari (iPhone): " + link + "\n" +
      "2. Install the app, then open it.\n" +
      "3. Your code: " + formatJoinCode(inv.code) + " (one use, valid until " + until.toLocaleString() + ").\n" +
      "Don't forward this message.";
  }
  async function seatCopy(text, btn){
    let done = false;
    try{ const nav = window.navigator; if(nav.clipboard && nav.clipboard.writeText){ await nav.clipboard.writeText(text); done = true; } }catch(e){}
    if(!done){
      try{ const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); done = document.execCommand("copy"); ta.remove(); }catch(e){}
    }
    if(btn){ const was = btn.dataset.label || btn.textContent; btn.dataset.label = was; btn.textContent = done? "Copied ✓" : "Select and copy it"; setTimeout(()=>{ btn.textContent = was; }, 2500); }
    return done;
  }
  function seatProblemText(r){
    r = r||{};
    if(r.reason==="offline") return "You're offline. Connect to the internet, then try again.";
    if(r.reason==="network") return "Couldn't reach seiGEN. Check the internet connection and try again.";
    const m = String((r.data && r.data.message) || r.message || "");
    const k = /^(SEAT_[A-Z_]+):\s*(.*)$/.exec(m);
    return (k? k[2] : m) || "seiGEN couldn't do that. Try again.";
  }
  // Every seiGEN call from a seat carries the signed-in person's token (terminalAuth adds it); make sure there is one.
  async function seatAuth(){
    if(isSeat() && typeof staffEnsureToken==="function") await staffEnsureToken();
    return terminalAuth();
  }
  if(typeof window!=="undefined" && window.setInterval){
    const keepToken = ()=>{ try{ if(isSeat() && typeof staffSession==="function" && staffSession() && !staffToken() && isOnline()) staffEnsureToken(); }catch(e){} };
    window.setInterval(keepToken, 60000);
    if(window.addEventListener) window.addEventListener("online", keepToken);
  }

  // ================== the joining device ==================
  function seatCodeBoxHtml(code){
    return `<div class="seat-code-box"><div class="muted" style="font-size:12.5px">Your code</div>
      <div class="seat-code" id="seatCode">${escapeHtml(formatJoinCode(code)||"—")}</div>
      <button type="button" class="btn btn-outline" id="seatCopyCode">Copy code</button></div>`;
  }
  // The link opened in a browser tab: how to install, for this device. Never a Join button here.
  function renderSeatInstall(code){
    route = "seatinstall";
    code = code || seatStoredCode();
    if(code) seatRememberCode(code);
    const d = seatDevice();
    const app = "seiGEN Commerce Lite";
    let steps;
    if(d.inApp){
      steps = `<div class="seat-warn" id="seatInApp"><b>You're inside ${escapeHtml(d.inAppName)}'s browser.</b> The app can't be installed here, and joining here would keep your data in the wrong place.</div>
        <ol class="seat-steps"><li>${d.ios? "Tap <b>⋯</b> or the compass, then <b>Open in Safari</b>." : "Tap <b>⋮</b> (top right), then <b>Open in Chrome</b>."}</li>
        <li>Then follow the steps there. Your code is below: copy it now in case you need it.</li></ol>`;
    } else if(d.ios){
      steps = `<ol class="seat-steps" id="seatStepsIos"><li>Tap <b>Share</b> <span aria-hidden="true">⬆</span> at the bottom of Safari.</li>
        <li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        <li>Open <b>${app}</b> from your home screen.</li>
        <li>Tap <b>Join as an Office seat</b> and <b>paste the code</b> (copy it first).</li></ol>`;
    } else {
      steps = `<button type="button" class="btn btn-primary" id="seatInstallBtn" hidden>⬇️ Install the app</button>
        <ol class="seat-steps" id="${d.android? "seatStepsAndroid" : "seatStepsDesktop"}">
        <li>${d.android? "Tap <b>Install the app</b> above. If there's no button, tap <b>⋮</b> → <b>Install app</b> (or <b>Add to Home screen</b>)."
                       : "Click <b>Install the app</b> above, or the install icon <span aria-hidden=\"true\">⊕</span> at the right of the address bar."}</li>
        <li>Open <b>${app}</b> ${d.android? "from your home screen" : "from the new window or your Start menu"}.</li>
        <li>Tap <b>Join as an Office seat</b>: the code is usually filled in. If not, paste it.</li></ol>`;
    }
    $app.innerHTML = `<div class="center-screen"><div class="setup-card" id="seatInstallCard">
      <h2 style="margin-top:0">Join as an Office seat</h2>
      <p class="muted" style="margin-top:0">An Office seat is the business's office and stores device on the main branch. It can't sell, take payments or run End of Day.</p>
      ${code? seatCodeBoxHtml(code) : `<p class="seat-warn" id="seatNoCode">Open the link from your invite message to see your code.</p>`}
      ${steps}
      <p class="muted" style="font-size:12px;margin-top:12px">Join only in the installed app. Already installed? Open it, then tap <b>Join as an Office seat</b>.</p>
    </div></div>`;
    const cp = document.getElementById("seatCopyCode");
    if(cp) cp.onclick = ()=> seatCopy(formatJoinCode(code), cp);
    // pwa-extras.js (installable builds) shows #seatInstallBtn when the browser offers the install
    if(typeof window!=="undefined" && window.sclSeatInstallMount) window.sclSeatInstallMount();
  }
  function renderSeatEntry(code){ return seatCanJoinHere()? renderSeatJoin(code) : renderSeatInstall(code); }

  function renderSeatJoin(code){
    route = "setup";
    code = code || seatStoredCode();
    $app.innerHTML = `<div class="center-screen"><div class="setup-card" id="seatJoinCard">
      <h2 style="margin-top:0">Join as an Office seat</h2>
      <p class="muted" style="margin-top:0">Type or paste the code from your invite. You don't need the business's secret phrase.</p>
      <label for="seatJoinCode">Code</label>
      <input class="field" id="seatJoinCode" value="${escapeHtml(formatJoinCode(code||""))}" placeholder="K7Q4-M9TX" autocomplete="off" style="letter-spacing:2px;text-transform:uppercase">
      <button class="btn btn-primary" id="seatJoinGo" style="margin-top:12px">Join</button>
      <p id="seatJoinMsg" role="alert" style="color:var(--danger);font-weight:600;margin:8px 0 0"></p>
      <button type="button" class="btn btn-ghost" id="seatJoinBack" style="margin-top:6px">← Set up a shop instead</button>
    </div></div>`;
    const msg = document.getElementById("seatJoinMsg");
    document.getElementById("seatJoinBack").onclick = ()=>{ if(typeof renderSetup==="function") renderSetup(); };
    const go = document.getElementById("seatJoinGo");
    go.onclick = async ()=>{
      const c = formatJoinCode(document.getElementById("seatJoinCode").value);
      if(!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)){ msg.textContent = "The code has 8 letters and numbers, like K7Q4-M9TX."; return; }
      if(!seatCanJoinHere()){ renderSeatInstall(c); return; }
      go.disabled = true; go.textContent = "Joining…"; msg.textContent = "";
      const r = await seatJoin(c);
      if(!r.ok){ go.disabled = false; go.textContent = "Join"; msg.textContent = seatProblemText(r); return; }
      renderSeatPin();
    };
  }
  async function seatJoin(code){
    if(!seatCanJoinHere()) return { ok:false, reason:"refused", data:{ message:"Join inside the installed app." } };
    if(!getSetting("install_id","")) setSetting("install_id", newInstallId());
    deviceKey();
    await persist();
    const r = await terminalRpc("cl_seat_join", { p_install_id:getSetting("install_id",""), p_device_key:deviceKey(), p_code:formatJoinCode(code),
      p_app_build:(typeof APP_BUILD!=="undefined")? APP_BUILD : null, p_join_hint:seatDevice().hint, p_device_code:null }, { timeoutMs:20000 });
    if(!r.ok) return r;
    seatStoreJoin(r.data);
    await persist();
    return r;
  }
  // Like a till's join (setup.js), with seiGEN's names; the till identity is kept back until approval.
  function seatStoreJoin(d){
    setSetting("terminal_kind", "seat");
    setSetting("seat_approval", d.approval||"pending");
    setSetting("seat_person", d.person_name||""); setSetting("seat_role", d.role_name||"");
    setSetting("seat_has_pin", d.person_has_pin? "1" : ""); setSetting("seat_pin_ok", d.pin_ok? "1" : "");
    setSetting("seat_join_json", JSON.stringify({ business_id:d.business_id, business_name:d.business_name, branch_id:d.branch_id, branch_name:d.branch_name,
      is_main:true, terminal_id:d.terminal_id, till_code:d.till_code, label:d.label }));
    setSetting("secret_phrase", d.device_phrase);   // this seat's own phrase from seiGEN: never shown, never the business's
    setSetting("shop_name", d.business_name||""); setSetting("branch_name", d.branch_name||""); setSetting("branch_type", "main");
    setSetting("single_operator_mode", "0");
    if(!getSetting("install_date","")){
      setSetting("currency", getSetting("currency","")||"$"); setSetting("paper_width","80");
      resetBranchId();
      const now = trustedNow();
      setSetting("install_date", now.toISOString()); setSetting("licence_v2_since", now.toISOString());
      setSetting("setup_complete","1");
      backfillBranch(db, currentBranch());
    }
    logAudit("Joined as an Office seat", "", (d.till_code||"")+" of "+(d.branch_name||"")+" ("+(d.business_name||"")+") for "+(d.person_name||""));
    seatForgetCode();
  }

  function renderSeatPin(){
    route = "seatwait";
    const has = getSetting("seat_has_pin","")==="1", who = getSetting("seat_person",""), role = getSetting("seat_role","");
    $app.innerHTML = `<div class="center-screen"><div class="setup-card" id="seatPinCard">
      <h2 style="margin-top:0">${has? "Enter your PIN" : "Choose your PIN"}</h2>
      <p class="muted" style="margin-top:0">${escapeHtml(who)}${role? " ("+escapeHtml(role)+")" : ""}, ${has? "enter the PIN you already use at "+escapeHtml(getSetting("shop_name",""))+"."
        : "choose a PIN of 4 to 6 digits. You'll sign in with it on this Office seat."}</p>
      <label for="seatPin">${has? "Your PIN" : "New PIN"}</label>
      <input class="field" id="seatPin" type="password" inputmode="numeric" maxlength="6" autocomplete="${has? "current-password" : "new-password"}">
      ${has? "" : `<label for="seatPin2">The same PIN again</label><input class="field" id="seatPin2" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password">`}
      <button class="btn btn-primary" id="seatPinGo" style="margin-top:12px">${has? "Continue" : "Set PIN"}</button>
      <p id="seatPinMsg" role="alert" style="color:var(--danger);font-weight:600;margin:8px 0 0"></p>
    </div></div>`;
    const go = document.getElementById("seatPinGo"), msg = document.getElementById("seatPinMsg");
    go.onclick = async ()=>{
      const p = document.getElementById("seatPin").value.trim();
      const bad = pinProblem(p); if(bad){ msg.textContent = bad; return; }
      if(!has && document.getElementById("seatPin2").value.trim()!==p){ msg.textContent = "The two PINs aren't the same."; return; }
      if(go.disabled) return;
      go.disabled = true; go.textContent = "Checking…"; msg.textContent = "";
      const r = await seatSetPin(p);
      go.disabled = false; go.textContent = has? "Continue" : "Set PIN";
      if(!r.ok){ msg.textContent = (r.data && r.data.error==="BAD_PIN")? "Incorrect PIN."+(r.data.left!=null? " "+r.data.left+" tries left." : "") : seatProblemText(r); return; }
      renderSeatWaiting();
    };
  }
  async function seatSetPin(pin){
    const has = getSetting("seat_has_pin","")==="1";
    const c = has? {} : await adminCheckMakeAsync(pin);
    const r = await terminalRpc("cl_seat_set_pin", Object.assign(terminalAuth(), { p_pin:pin, p_pin_salt:c.salt||null, p_pin_check:c.check||null, p_pin_rounds:c.rounds||null }), { timeoutMs:20000 });
    if(r.ok){ setSetting("seat_pin_ok", "1"); logAudit("Office seat PIN "+(has? "entered" : "set"), "", getSetting("seat_person","")); await persist(); }
    return r;
  }

  let _seatPoll = null;
  function renderSeatWaiting(){
    route = "seatwait";
    if(getSetting("seat_approval","")==="refused") return renderSeatRefused();
    if(getSetting("seat_pin_ok","")!=="1") return renderSeatPin();
    const who = getSetting("seat_person",""), role = getSetting("seat_role","");
    $app.innerHTML = `<div class="center-screen"><div class="setup-card center" id="seatWaitCard">
      <h2 style="margin-top:0">Waiting for approval</h2>
      <p class="muted" style="margin-top:0">Waiting for approval by the Owner or an Admin of ${escapeHtml(getSetting("shop_name",""))}. Ask them to open
        <b>More → Settings → Business &amp; Terminals</b> on a main-branch device and approve this Office seat.</p>
      <p style="margin:12px 0 4px">Read them this device check:</p>
      <div class="seat-check" id="seatCheck">${escapeHtml(seatCheckOf(deviceKey()))}</div>
      <p class="muted" style="font-size:12.5px">They see the same check on their screen. If it's different, they mustn't approve.</p>
      <p class="muted" id="seatWaitWho">${escapeHtml(who)}${role? " · "+escapeHtml(role) : ""} · ${escapeHtml(getSetting("branch_name",""))}</p>
      <button class="btn btn-outline" id="seatWaitCheckNow">Check now</button>
      <p class="muted" id="seatWaitMsg" style="font-size:12.5px;margin-top:8px">This screen updates by itself.</p>
    </div></div>`;
    document.getElementById("seatWaitCheckNow").onclick = ()=> seatCheckStatus(true);
    if(_seatPoll) clearInterval(_seatPoll);
    _seatPoll = setInterval(()=>{ if(route!=="seatwait"){ clearInterval(_seatPoll); _seatPoll = null; return; } seatCheckStatus(false); }, SEAT_POLL_MS);
  }
  async function seatCheckStatus(say){
    const el = document.getElementById("seatWaitMsg");
    const r = await terminalRpc("cl_seat_status", terminalAuth());
    if(!r.ok){ if(el && say) el.textContent = seatProblemText(r); return r; }
    const d = r.data;
    if(d.approval==="approved"){ await seatOnApproved(); return r; }
    if(d.approval==="refused"){ setSetting("seat_approval", "refused"); setSetting("seat_refused_reason", d.refused_reason||""); await persist(); renderSeatRefused(); return r; }
    if(!d.pin_ok && getSetting("seat_pin_ok","")==="1"){ setSetting("seat_pin_ok", ""); await persist(); renderSeatPin(); return r; }
    if(el) el.textContent = "Still waiting · checked "+new Date().toLocaleTimeString();
    return r;
  }
  async function seatOnApproved(){
    if(_seatPoll){ clearInterval(_seatPoll); _seatPoll = null; }
    let j = {}; try{ j = JSON.parse(getSetting("seat_join_json","{}"))||{}; }catch(e){}
    setSetting("seat_approval", "approved");
    setSetting("trial_cover_wanted", "1");   // the business's free trial covers this seat too (trial.js)
    storeTerminal(j);                        // now a registered device of the main branch (catalogue, staff, stock figures)
    logAudit("Office seat approved", "", (j.till_code||"")+" of "+(j.branch_name||""));
    await persist();
    $app.innerHTML = `<div class="center-screen"><div class="setup-card center" id="seatReadyCard"><h2 style="margin-top:0">Approved</h2>
      <p class="muted" id="seatReadyMsg">Getting the main branch's data…</p></div></div>`;
    try{ if(typeof staffPull==="function") await staffPull(); }catch(e){}
    try{ if(typeof catBackgroundTick==="function") await catBackgroundTick(); }catch(e){}
    try{ if(typeof dsRefreshBranches==="function") await dsRefreshBranches(); }catch(e){}
    try{ if(typeof itRefreshDevices==="function") await itRefreshDevices(); }catch(e){}
    await persist();
    if(typeof renderTrialStarting==="function" && !(typeof currentLicence==="function" && currentLicence())) return renderTrialStarting({ quiet:true });
    renderStart();
  }
  function renderSeatRefused(){
    route = "seatwait";
    const why = getSetting("seat_refused_reason","");
    $app.innerHTML = `<div class="center-screen"><div class="setup-card center" id="seatRefusedCard">
      <h2 style="margin-top:0">This Office seat was refused</h2>
      <p class="muted">The Owner or an Admin of ${escapeHtml(getSetting("shop_name",""))} didn't approve this device.${why? " Reason: "+escapeHtml(why) : ""}</p>
      <p class="muted">If this is a mistake, ask them for a new invite and join on a fresh install of the app.</p>
    </div></div>`;
  }

  // ================== the main branch: invite, approve, revoke ==================
  function seatAdminSession(){
    const s = typeof staffSession==="function"? staffSession() : null;
    const st = s && shopStaff(s.id), r = st && shopRole(st.role_id);
    return r && (r.builtin==="owner" || r.builtin==="admin")? s : null;
  }
  function seatSectionHtml(){
    return `<div class="hr"></div>
      <h4 style="margin:0 0 4px">Office seats</h4>
      <p class="muted" style="font-size:12.5px;margin:0 0 8px">An Office seat is a device on the main branch with no till, for the bookkeeper, the stores clerk or the owner.
        It can't sell, take payments or run End of Day. It costs $3 per 30 days, like a till.</p>
      <div id="seatPendingBox"></div>
      <button class="btn btn-outline" id="seatInviteBtn">+ Invite an Office seat</button>
      <div id="seatList" style="margin-top:8px"></div>`;
  }
  async function seatLoad(){
    if(!seatAdminSession()) return { ok:false, reason:"refused", data:{ message:"Sign in as the Owner or an Admin to invite or approve Office seats." } };
    const token = await staffEnsureToken();
    return terminalRpc("cl_device_seat_invites", Object.assign(terminalAuth(), { p_staff_token:token }));
  }
  const SEAT_STATUS_TEXT = { open:"open", used:"used", expired:"expired", revoked:"revoked" };
  async function wireSeatSection(){
    const inv = document.getElementById("seatInviteBtn");
    if(!inv) return;
    inv.onclick = ()=> openSeatInviteModal();
    const box = document.getElementById("seatList"), pend = document.getElementById("seatPendingBox");
    const r = await seatLoad();
    if(!document.getElementById("seatList")) return;
    if(!r.ok){ box.innerHTML = `<p class="muted" style="font-size:12.5px" id="seatListMsg">${escapeHtml(seatProblemText(r))}</p>`; return; }
    const d = r.data, waiting = (d.seats||[]).filter(s=>s.approval==="pending"), seats = (d.seats||[]).filter(s=>s.approval!=="pending");
    pend.innerHTML = waiting.map(s=>`<div class="seat-pending" data-seat-pending="${escapeHtml(s.id)}">
        <div><b>${escapeHtml(s.person||"?")}</b> · ${escapeHtml(s.role||"")} <span class="pill low">Waiting for approval</span></div>
        <div class="muted" style="font-size:12.5px">${escapeHtml(s.till_code)} · joined ${escapeHtml(new Date(s.registered_ts).toLocaleString())}${s.join_hint? " from "+escapeHtml(s.join_hint) : ""}${s.pin_ok? "" : " · PIN not set yet"}</div>
        <button class="btn btn-sm btn-primary" data-seat-approve="${escapeHtml(s.id)}" style="margin-top:6px">Approve or refuse…</button></div>`).join("");
    const inviteRows = (d.invites||[]).map(i=>`<div class="term-row" data-seat-invite="${escapeHtml(i.id)}" style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin:2px 0">
        <span class="muted" style="font-size:12.5px">Invite · ${escapeHtml(i.person||"?")} (${escapeHtml(i.role||"")}) · ${escapeHtml(SEAT_STATUS_TEXT[i.status]||i.status)}${i.status==="open"? " until "+escapeHtml(new Date(i.expires_ts).toLocaleString()) : ""}${i.seat_code? " · "+escapeHtml(i.seat_code) : ""}</span>
        ${i.status==="open"? `<button class="btn btn-sm btn-outline" data-seat-revoke="${escapeHtml(i.id)}">Revoke</button>` : ""}</div>`).join("");
    const seatRows = seats.map(s=>`<div class="term-row" style="margin:2px 0"><span class="muted" style="font-size:12.5px">${escapeHtml(seatTillLabel(s.till_code))} · ${escapeHtml(s.person||"")}
        · ${s.approval==="refused"? "refused" : s.active? "approved"+(s.approved_by? " by "+escapeHtml(s.approved_by) : "") : "deactivated"}${s.last_seen_ts? " · last seen "+escapeHtml(new Date(s.last_seen_ts).toLocaleString()) : ""}</span></div>`).join("");
    box.innerHTML = (seatRows + inviteRows) || `<p class="muted" style="font-size:12.5px">No Office seats or invites yet.</p>`;
    pend.querySelectorAll("[data-seat-approve]").forEach(b=> b.onclick = ()=> openSeatApproveModal(waiting.find(s=>s.id===b.dataset.seatApprove)));
    box.querySelectorAll("[data-seat-revoke]").forEach(b=> b.onclick = async ()=>{
      if(!confirm("Revoke this invite? The code stops working.")) return;
      b.disabled = true;
      const x = await seatRevoke(b.dataset.seatRevoke);
      if(!x.ok){ b.disabled = false; alert(seatProblemText(x)); return; }
      wireSeatSection();
    });
  }
  async function seatRevoke(id){
    const token = await staffEnsureToken();
    const r = await terminalRpc("cl_device_seat_invite_revoke", Object.assign(terminalAuth(), { p_staff_token:token, p_invite_id:id }));
    if(r.ok) logAudit("Office seat invite revoked", "", id);
    return r;
  }
  async function seatInviteCreate(o){
    const token = await staffEnsureToken();
    if(!token) return { ok:false, reason:"refused", data:{ message:"Sign in (online) as the Owner or an Admin first." } };
    const r = await terminalRpc("cl_device_seat_invite_create", Object.assign(terminalAuth(), { p_staff_token:token,
      p_staff_id:o.staffId||null, p_name:o.name||null, p_role_id:o.roleId||null, p_valid_hours:24 }));
    if(r.ok) logAudit("Office seat invite created", "", r.data.person_name+" ("+r.data.role_name+"), valid until "+new Date(r.data.expires_ts).toLocaleString());
    return r;
  }
  function openSeatInviteModal(){
    if(!seatAdminSession()) return alert("Sign in as the Owner or an Admin to invite an Office seat.");
    const roles = shopRoles().filter(r=> r.builtin!=="cashier");
    const people = shopStaffAll().filter(s=> s.active && (shopRole(s.role_id)||{}).builtin!=="cashier");
    const wrap = openModal("Invite an Office seat", `
      <p class="muted" style="margin-top:0">For the main branch. No till: no selling, payments or End of Day. $3 per 30 days, like a till.</p>
      <label for="seatWho">Person</label>
      <select class="field" id="seatWho"><option value="">+ A new person</option>${people.map(s=>`<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml((shopRole(s.role_id)||{}).name||"")})</option>`).join("")}</select>
      <div id="seatNewBox"><label for="seatName">Name</label><input class="field" id="seatName" maxlength="60" placeholder="e.g. Tendai">
      <label for="seatRole">Role</label><select class="field" id="seatRole">${roles.map(r=>`<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join("")}</select></div>
      <p class="muted" style="font-size:12.5px">The invite works once, for this person only, for 24 hours. You approve the device before it gets any data.</p>
      <button class="btn btn-primary" id="seatCreate" style="margin-top:6px">Create invite</button>
      <p id="seatCreateMsg" role="alert" style="color:var(--danger);font-weight:600;margin:8px 0 0"></p>`);
    const who = wrap.querySelector("#seatWho"), nb = wrap.querySelector("#seatNewBox");
    who.onchange = ()=>{ nb.style.display = who.value? "none" : ""; };
    const go = wrap.querySelector("#seatCreate"), msg = wrap.querySelector("#seatCreateMsg");
    go.onclick = async ()=>{
      const o = who.value? { staffId:who.value } : { name:wrap.querySelector("#seatName").value.trim(), roleId:wrap.querySelector("#seatRole").value };
      if(!o.staffId && !o.name){ msg.textContent = "Enter the person's name."; return; }
      if(go.disabled) return;
      go.disabled = true; go.textContent = "Creating…"; msg.textContent = "";
      const r = await seatInviteCreate(o);
      go.disabled = false; go.textContent = "Create invite";
      if(!r.ok){ msg.textContent = seatProblemText(r); return; }
      wrap.remove();
      openSeatInviteResult(r.data);
      wireSeatSection();
    };
    return wrap;
  }
  function openSeatInviteResult(inv){
    const link = seatInviteLink(inv.code), text = seatShareText(inv, link);
    const wrap = openModal("Invite ready", `
      <p style="margin-top:0"><b>${escapeHtml(inv.person_name)}</b> · ${escapeHtml(inv.role_name)}</p>
      <div class="seat-code" id="seatInvCode">${escapeHtml(formatJoinCode(inv.code))}</div>
      <p class="muted" id="seatInvUntil" style="font-size:12.5px">Valid until ${escapeHtml(new Date(inv.expires_ts).toLocaleString())} · one use · for ${escapeHtml(inv.person_name)} only.
        Share the code and the link together; there's no password in either.</p>
      <label for="seatInvText">The message</label>
      <textarea class="field" id="seatInvText" rows="7" readonly>${escapeHtml(text)}</textarea>
      <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px">
        <a class="btn btn-primary" id="seatShareWa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">Share on WhatsApp</a>
        <button class="btn btn-outline" id="seatCopyMsg">Copy message</button>
        <button class="btn btn-outline" id="seatCopyCode2">Copy code</button>
        <button class="btn btn-ghost" id="seatRevokeNow">Revoke</button>
      </div>
      <p id="seatInvMsg" role="alert" style="font-weight:600;margin:8px 0 0"></p>`);
    wrap.querySelector("#seatCopyMsg").onclick = (e)=> seatCopy(text, e.currentTarget);
    wrap.querySelector("#seatCopyCode2").onclick = (e)=> seatCopy(formatJoinCode(inv.code), e.currentTarget);
    wrap.querySelector("#seatRevokeNow").onclick = async (e)=>{
      if(!confirm("Revoke this invite? The code stops working.")) return;
      e.currentTarget.disabled = true;
      const r = await seatRevoke(inv.invite_id);
      wrap.querySelector("#seatInvMsg").textContent = r.ok? "Revoked. The code no longer works." : seatProblemText(r);
      wireSeatSection();
    };
    return wrap;
  }
  function openSeatApproveModal(s){
    if(!s) return null;
    const wrap = openModal("Approve an Office seat", `
      <p style="margin-top:0"><b>${escapeHtml(s.person||"?")}</b> · ${escapeHtml(s.role||"")} · ${escapeHtml(s.till_code)}</p>
      <p class="muted" style="font-size:12.5px">Joined ${escapeHtml(new Date(s.registered_ts).toLocaleString())}${s.join_hint? " from "+escapeHtml(s.join_hint) : ""}.</p>
      <p style="margin:10px 0 4px">Device check on their screen should be:</p>
      <div class="seat-check" id="seatApproveCheck">${escapeHtml(s.check||"")}</div>
      <p class="muted" style="font-size:12.5px">Ask ${escapeHtml(s.person||"them")} to read the check on their Office seat (call them if they aren't here). Approve only if it's the same.</p>
      ${s.pin_ok? "" : `<p class="seat-warn" id="seatApproveNoPin">They haven't set or entered their PIN yet. Ask them to do it on the Office seat first.</p>`}
      <label style="display:flex;gap:8px;align-items:flex-start;margin-top:8px"><input type="checkbox" id="seatCheckSame" style="width:auto;margin-top:3px"><span>The check on their screen is the same</span></label>
      <button class="btn btn-primary" id="seatApproveGo" disabled style="margin-top:8px">Approve</button>
      <div class="hr"></div>
      <label for="seatRefuseWhy">Or refuse it (reason, optional)</label>
      <input class="field" id="seatRefuseWhy" maxlength="200" placeholder="e.g. not our device">
      <button class="btn btn-outline" id="seatRefuseGo" style="margin-top:6px">Refuse</button>
      <p id="seatApproveMsg" role="alert" style="color:var(--danger);font-weight:600;margin:8px 0 0"></p>`);
    const same = wrap.querySelector("#seatCheckSame"), ap = wrap.querySelector("#seatApproveGo"), msg = wrap.querySelector("#seatApproveMsg");
    same.onchange = ()=>{ ap.disabled = !same.checked; };
    ap.onclick = async ()=>{
      if(ap.disabled) return;
      ap.disabled = true; ap.textContent = "Approving…"; msg.textContent = "";
      const token = await staffEnsureToken();
      const r = await terminalRpc("cl_device_seat_approve", Object.assign(terminalAuth(), { p_staff_token:token, p_terminal_id:s.id, p_check:s.check }));
      if(!r.ok){ ap.disabled = false; ap.textContent = "Approve"; msg.textContent = seatProblemText(r); return; }
      logAudit("Office seat approved", "", s.till_code+" for "+(s.person||""));
      if(typeof staffPull==="function") staffPull().catch(()=>{});   // a new person from the invite
      if(typeof itRefreshDevices==="function") itRefreshDevices().catch(()=>{});   // this till can now send to and receive from the seat
      wrap.remove(); wireSeatSection();
    };
    wrap.querySelector("#seatRefuseGo").onclick = async (e)=>{
      if(!confirm("Refuse this Office seat? It gets no data, and the device can't join again.")) return;
      e.currentTarget.disabled = true;
      const token = await staffEnsureToken();
      const r = await terminalRpc("cl_device_seat_refuse", Object.assign(terminalAuth(), { p_staff_token:token, p_terminal_id:s.id, p_reason:wrap.querySelector("#seatRefuseWhy").value.trim()||null }));
      if(!r.ok){ e.currentTarget.disabled = false; msg.textContent = seatProblemText(r); return; }
      logAudit("Office seat refused", "", s.till_code+" for "+(s.person||""));
      wrap.remove(); wireSeatSection();
    };
    return wrap;
  }

  // ================== the business's bill (every device, seats included) ==================
  const BILL_ROLE_TEXT = { main:"main till", branch:"first till of a branch", till:"extra till", seat:"Office seat" };
  function businessBillCached(){ try{ return JSON.parse(getSetting("business_bill","")||"null"); }catch(e){ return null; } }
  function businessBillHtml(){
    const b = businessBillCached();
    if(!b || !b.devices || !b.devices.length) return "";
    const cur = b.currency || "USD", money = (n)=> cur+" "+Number(n).toFixed(2);
    return `<div class="business-bill" id="businessBillBox"><div style="font-weight:600;margin-bottom:4px">Your business's bill${b.plan_name? " ("+escapeHtml(b.plan_name)+" plan)" : ""}</div>
      ${b.devices.map(d=>`<div class="muted" style="font-size:12.5px">${escapeHtml(d.branch)} ${escapeHtml(seatTillLabel(d.till_code))} · ${d.unit_fee==null? escapeHtml(d.problem||"not billed") : escapeHtml(BILL_ROLE_TEXT[d.role]||d.role)+" "+escapeHtml(money(d.unit_fee))}</div>`).join("")}
      <div style="font-weight:700;margin-top:4px" id="businessBillTotal">Total ${escapeHtml(money(b.total))} per 30 days</div></div>`;
  }
  async function refreshBusinessBill(){
    if(!(typeof isTerminalRegistered==="function" && isTerminalRegistered()) || !isOnline()) return null;
    const r = await terminalRpc("cl_business_bill", terminalAuth());
    if(!r.ok || !r.data) return null;
    setSetting("business_bill", JSON.stringify(r.data));
    document.querySelectorAll("[data-business-bill]").forEach(el=>{ el.innerHTML = businessBillHtml(); });
    return r.data;
  }
