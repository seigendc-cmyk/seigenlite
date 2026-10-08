  // ================== Activation (v2: signed licences) ==================
  // docs/activation/activation-v2-design.md ("Owner decisions" wins).
  //
  // A device may be used while ONE of these holds (licenceState()):
  //   licence  a licence string signed by seiGEN (Ed25519), bound to this
  //            device, not yet expired. Checked fully offline with the public
  //            key(s) below and the vendored TweetNaCl (src/vendor/).
  //   trial    30 days from the EARLIEST of: install date, first sale, first
  //            stock movement, first product created (so a reinstall + restore
  //            of an old backup gives no new trial). Never signed.
  //   legacy   activated_until from an old-style 6-character code (or from a
  //            v10 install), honoured only until the legacy horizon.
  // Every decision uses trustedNow() (eod.js), which never moves backwards.

  // Public keys by key ID. Only seiGEN's private key (kept outside this repo,
  // see docs/activation/licence-keys.md) can make a licence these accept.
  // A new key ID can be added here to rotate keys; old IDs keep working until removed.
  const LICENCE_PUBLIC_KEYS = {
    1: "VLNqCYsJ2c6yZ+MToGEfn0zoRoQYpBWZ/f9naRP8jjA=",
  };
  const LICENCE_PREFIX = "SL2.";
  const LICENCE_VERSION = 2;
  const LICENCE_EPOCH_MS = Date.UTC(2026, 0, 1);      // day numbers in a licence count from 1 Jan 2026
  const LICENCE_DAY_MS = 86400000;
  const LICENCE_DAY_END_MS = 22*3600000;              // a licence day ends at 24:00 Harare (UTC+2) = 22:00 UTC
  const TRIAL_DAYS = 30;
  const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // install IDs, device tags, short codes
  const SEIGEN_PHONE = "+263789487287";
  const SEIGEN_WA = "263789487287";
  // Old-style codes: accepted until the cutoff, then refused. Set at the
  // production release to that date + 30 days ("YYYY-MM-DD", end of that day
  // in Harare). Until then each device's cutoff is 30 days after it first ran
  // this version (licence_v2_since). The legacy horizon (cutoff + 30 days) is
  // the last moment an old code entered before the cutoff can still run.
  const LEGACY_CODE_CUTOFF = null;
  const LEGACY_GRACE_DAYS = 30;

  // ---- small helpers (no dependencies beyond TweetNaCl) ----
  function naclLib(){
    if(typeof nacl!=="undefined" && nacl && nacl.sign) return nacl;
    if(typeof self!=="undefined" && self.nacl && self.nacl.sign) return self.nacl;
    return null;
  }
  function licUtf8(s){ return new Uint8Array(new TextEncoder().encode(String(s))); }   // copied: this realm's Uint8Array, which nacl insists on
  function licB64ToBytes(s){
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    s = String(s).replace(/-/g,"+").replace(/_/g,"/").replace(/=+$/,"");
    if(/[^A-Za-z0-9+/]/.test(s) || s.length%4===1) return null;
    const out = new Uint8Array(Math.floor(s.length*3/4));
    let bits=0, val=0, j=0;
    for(let i=0;i<s.length;i++){
      val = (val<<6) | A.indexOf(s[i]); bits += 6;
      if(bits>=8){ bits-=8; out[j++] = (val>>bits) & 255; }
    }
    return out;
  }
  function licU16(b,o){ return (b[o]<<8)|b[o+1]; }
  function licU32(b,o){ return ((b[o]<<24)>>>0) + (b[o+1]<<16) + (b[o+2]<<8) + b[o+3]; }
  function licHex(b){ return Array.from(b, x=>x.toString(16).padStart(2,"0")).join(""); }
  // The last day something is valid on (an end instant is exclusive: a
  // licence ending at 24:00 on 7 Nov reads "7 Nov", not "8 Nov").
  function licDateText(ms){ return new Date(ms-1).toLocaleDateString("en-GB",{ day:"numeric", month:"short", year:"numeric", timeZone:"Africa/Harare" }); }

  // ---- this device ----
  // SHA-512 of the device's private random key (terminal.js deviceKey()).
  let _devHashKey = null, _devHash = null;
  function deviceKeyHash(){
    const k = deviceKey();
    if(_devHashKey!==k){ _devHash = naclLib().hash(licUtf8(k)); _devHashKey = k; }
    return _devHash;
  }
  // 4 characters = the first 20 bits of that hash. Ties a licence to this device.
  function deviceTag(){
    const h = deviceKeyHash();
    const bits = (h[0]<<12) | (h[1]<<4) | (h[2]>>4);
    let s = "";
    for(let i=0;i<4;i++) s += ID_ALPHABET[(bits >> (15-5*i)) & 31];
    return s;
  }
  // What the shop sends seiGEN: install ID + device tag, e.g. ABCD-K7Q2.
  function licenceDeviceCode(){ return getSetting("install_id","XXXX") + "-" + deviceTag(); }

  // ---- parsing and checking a licence (offline) ----
  // Accepts the bare "SL2.…" text, a whole activation link (…#lic=SL2.…), or
  // a WhatsApp message containing either. The licence is the run of
  // base64url characters after "SL2."; if a paste broke it across lines,
  // the run with the line breaks taken out is used instead.
  const LICENCE_LENGTHS = [126, 147];   // base64url of 94 / 110 bytes (unregistered / registered)
  function extractLicenceText(text){
    const s = String(text||"");
    const i = s.indexOf(LICENCE_PREFIX);
    if(i<0) return null;
    const rest = s.slice(i + LICENCE_PREFIX.length);
    const run = (/^[A-Za-z0-9_-]*/.exec(rest)||[""])[0];
    if(LICENCE_LENGTHS.includes(run.length)) return LICENCE_PREFIX + run;
    const joined = (/^[A-Za-z0-9_-]*/.exec(rest.replace(/\s+/g,""))||[""])[0];
    return LICENCE_PREFIX + (LICENCE_LENGTHS.includes(joined.length)? joined : run);
  }
  function parseLicence(text){
    const t = extractLicenceText(text);
    if(!t) return { ok:false, reason:"invalid" };
    const b = licB64ToBytes(t.slice(LICENCE_PREFIX.length));
    if(!b || b.length<30+64) return { ok:false, reason:"invalid" };
    const flags = b[27], hasBiz = !!(flags & 2), plen = hasBiz? 46 : 30;
    if(b.length!==plen+64 || b[0]!==LICENCE_VERSION) return { ok:false, reason:"invalid" };
    const payload = b.subarray(0, plen), sig = b.subarray(plen);
    let install = "";
    for(let i=6;i<14 && b[i];i++) install += String.fromCharCode(b[i]);
    const biz = hasBiz? licHex(b.subarray(30,46)) : "";
    return { ok:true, text:t, payload, sig, kid:b[1], serial:licU32(b,2), installId:install,
      binding:b.subarray(14,22), strong:!!(flags & 1), issuedDay:licU16(b,22), untilDay:licU16(b,24),
      plan:b[26], features:licU16(b,28),
      businessId: biz? biz.slice(0,8)+"-"+biz.slice(8,12)+"-"+biz.slice(12,16)+"-"+biz.slice(16,20)+"-"+biz.slice(20) : "",
      issuedMs: LICENCE_EPOCH_MS + licU16(b,22)*LICENCE_DAY_MS,
      untilMs: LICENCE_EPOCH_MS + (licU16(b,24)+1)*LICENCE_DAY_MS - (24*3600000-LICENCE_DAY_END_MS) };
  }
  // reason: invalid | unknown_key | other_device. Expiry is checked by the caller (needs trusted time).
  // Any unexpected error counts as invalid (fails closed).
  function verifyLicence(text){
    try{ return verifyLicenceUnsafe(text); }catch(e){ return { ok:false, reason:"invalid" }; }
  }
  function verifyLicenceUnsafe(text){
    const p = parseLicence(text);
    if(!p.ok) return p;
    const lib = naclLib();
    const pub = LICENCE_PUBLIC_KEYS[p.kid];
    if(!lib) return { ok:false, reason:"invalid" };
    if(!pub) return { ok:false, reason:"unknown_key", lic:p };
    let good = false;
    try{ good = lib.sign.detached.verify(p.payload, p.sig, licB64ToBytes(pub)); }catch(e){ good = false; }
    if(!good) return { ok:false, reason:"invalid" };
    const h = deviceKeyHash();
    const same = p.installId===getSetting("install_id","") && (p.strong
      ? p.binding.every((x,i)=> x===h[i])
      : p.binding[0]===h[0] && p.binding[1]===h[1] && (p.binding[2]>>4)===(h[2]>>4));
    if(!same) return { ok:false, reason:"other_device", lic:p };
    return { ok:true, lic:p };
  }
  // The licence this device holds, if it still verifies here (cached per string).
  let _licCacheText = null, _licCacheResult = null;
  function currentLicence(){
    const t = getSetting("licence","");
    if(!t) return null;
    if(t!==_licCacheText || _devHashKey!==getSetting("device_key","")){ _licCacheText = t; _licCacheResult = verifyLicence(t); }
    return _licCacheResult.ok? _licCacheResult.lic : null;
  }
  function usedLicenceSerials(){ try{ return JSON.parse(getSetting("licence_serials","[]"))||[]; }catch(e){ return []; } }

  // ---- the trial (Q8): counts from the earliest business data ----
  // Sales, stock movements (ledger, receipts, adjustments) and products
  // created: whichever is oldest, or the install date if older still.
  // Values that aren't dates (or are before 2024) are ignored.
  function earliestBusinessDataMs(){
    const qs = ["SELECT MIN(ts) v FROM sales WHERE ts IS NOT NULL AND ts<>''",
      "SELECT MIN(ts) v FROM stock_movements WHERE ts IS NOT NULL AND ts<>''",
      "SELECT MIN(ts) v FROM stock_received WHERE ts IS NOT NULL AND ts<>''",
      "SELECT MIN(ts) v FROM stock_adjustments WHERE ts IS NOT NULL AND ts<>''",
      "SELECT MIN(created_ts) v FROM products WHERE created_ts IS NOT NULL AND created_ts<>''"];
    let min = null;
    for(const q of qs){
      let v = null;
      try{ v = (one(q)||{}).v; }catch(e){ v = null; }
      const ms = v? Date.parse(v) : NaN;
      if(!isNaN(ms) && ms>=Date.UTC(2024,0,1) && (min===null || ms<min)) min = ms;
    }
    return min;
  }
  function trialStartMs(){
    const inst = Date.parse(getSetting("install_date",""));
    const data = earliestBusinessDataMs();
    const c = [inst, data].filter(x=> x!==null && !isNaN(x));
    return c.length? Math.min(...c) : null;
  }
  function trialEndMs(){ const s = trialStartMs(); return s===null? null : s + TRIAL_DAYS*LICENCE_DAY_MS; }

  // ---- old-style codes: until the cutoff ----
  function licenceV2SinceMs(){
    let s = getSetting("licence_v2_since","");
    if(!s){ s = trustedNow().toISOString(); setSetting("licence_v2_since", s); }
    return Date.parse(s);
  }
  function legacyCutoffMs(){
    if(LEGACY_CODE_CUTOFF) return Date.parse(LEGACY_CODE_CUTOFF+"T00:00:00Z") + LICENCE_DAY_MS - (24*3600000-LICENCE_DAY_END_MS);
    return licenceV2SinceMs() + LEGACY_GRACE_DAYS*LICENCE_DAY_MS;
  }
  function legacyHorizonMs(){ return legacyCutoffMs() + LEGACY_GRACE_DAYS*LICENCE_DAY_MS; }
  // The old 6-character code for a device code and phrase. Kept only so old
  // codes still unlock until the cutoff; removed after the legacy horizon.
  function computeActivationCode(deviceCode, secretPhrase){
    const combined = deviceCode.toUpperCase()+"|"+secretPhrase.toUpperCase();
    let hash=0;
    for(let i=0;i<combined.length;i++){ hash = ((hash<<5)-hash+combined.charCodeAt(i))|0; }
    hash = Math.abs(hash);
    return hash.toString(36).toUpperCase().padStart(6,"0").slice(-6);
  }
  function daysBetween(a,b){ return Math.floor((b-a)/86400000); }
  // The old device code (install ID + 30-day cycle), still what check-in
  // reports and what an old-style code is made from.
  function currentDeviceCode(){
    const installDate = new Date(getSetting("install_date"));
    const installId = getSetting("install_id","XXXX");
    const cycle = Math.max(1, Math.floor(daysBetween(installDate,trustedNow())/30)+1);
    return `${installId}-C${cycle}`;
  }

  // ---- the state ----
  // { status: ok|locked|no_setup, source: licence|trial|legacy|null, untilMs, licence, trialEndMs }
  function licenceState(){
    if(!getSetting("install_date","")) return { status:"no_setup", source:null, untilMs:null };
    licenceV2SinceMs();   // records this version's first run (a device upgraded from v10)
    const now = trustedNow().getTime();
    const lic = currentLicence();
    const licUntil = lic? lic.untilMs : null;
    const trialEnd = trialEndMs();
    // activated_until set by v11 setup is the trial's mirror for a rollback to
    // v10, not a grant: the trial rule above decides instead.
    const au = Date.parse(getSetting("activated_until",""));
    const auSrc = getSetting("activated_until_src","");
    const legacyUntil = (!isNaN(au) && auSrc!=="setup" && now < legacyHorizonMs())? au : null;
    const valid = [];
    if(licUntil!==null && now<=licUntil) valid.push(["licence", licUntil]);
    if(trialEnd!==null && now<trialEnd) valid.push(["trial", trialEnd]);
    if(legacyUntil!==null && now<=legacyUntil) valid.push(["legacy", legacyUntil]);
    if(valid.length){
      valid.sort((a,b)=> b[1]-a[1]);
      return { status:"ok", source:valid[0][0], untilMs:valid[0][1], licence:lic, trialEndMs:trialEnd };
    }
    const ended = [licUntil, trialEnd, legacyUntil].filter(x=>x!==null);
    return { status:"locked", source:null, untilMs: ended.length? Math.max(...ended) : null, licence:lic, trialEndMs:trialEnd };
  }
  function activationStatus(){ return licenceState().status; }
  // render() (router.js) checks this cached flag on every screen; it's
  // refreshed at boot, every hour, when the app comes back to the
  // foreground (startLicenceWatch) and after any activation.
  let _licenceLocked = false;
  function refreshLicenceLock(){ _licenceLocked = activationStatus()==="locked"; return _licenceLocked; }
  function licenceLocked(){ return _licenceLocked; }

  // ---- activating ----
  // via: link | paste | code | checkin. Resolves to { ok, untilMs, serial, already? } or { ok:false, reason }.
  async function applyLicence(text, via){
    const v = verifyLicence(text);
    if(!v.ok) return { ok:false, reason:v.reason, lic:v.lic };
    const lic = v.lic;
    // A signed issue date is a trusted time: the watermark moves forward to it.
    if(typeof noteTrustedTime==="function") noteTrustedTime(new Date(lic.issuedMs));
    const now = trustedNow().getTime();
    if(now > lic.untilMs) return { ok:false, reason:"expired", lic };
    const cur = currentLicence();
    if(cur && cur.serial===lic.serial) return { ok:true, already:true, untilMs:lic.untilMs, serial:lic.serial };
    if(usedLicenceSerials().includes(lic.serial)) return { ok:false, reason:"used", lic };
    if(cur && lic.serial < cur.serial && now <= cur.untilMs) return { ok:false, reason:"older", lic };
    setSetting("licence", lic.text);
    setSetting("licence_serials", JSON.stringify(usedLicenceSerials().concat([lic.serial]).slice(-50)));
    // mirror for a rollback to v10, which only reads activated_until
    setSetting("activated_until", new Date(lic.untilMs).toISOString());
    setSetting("activated_until_src", "licence");
    logAudit("Licence activated", "", "Licence #"+lic.serial+" until "+licDateText(lic.untilMs)+" ("+via+")");
    refreshLicenceLock();
    await persist();
    return { ok:true, untilMs:lic.untilMs, serial:lic.serial };
  }
  async function enterLegacyCode(code){
    if(trustedNow().getTime() >= legacyCutoffMs()) return { ok:false, reason:"legacy_closed" };
    const expected = computeActivationCode(currentDeviceCode(), getSetting("secret_phrase",""));
    if(code!==expected) return { ok:false, reason:"invalid" };
    // trustedNow(), not Date.now(): a rolled-back clock can't stretch a replayed code
    const until = new Date(trustedNow().getTime()+30*LICENCE_DAY_MS);
    setSetting("activated_until", until.toISOString());
    setSetting("activated_until_src", "code");
    logAudit("Activated (old-style code)", "", "until "+licDateText(until.getTime()));
    refreshLicenceLock();
    await persist();
    return { ok:true, untilMs:until.getTime(), legacy:true };
  }
  // Short code: needs the internet. The server checks it's for this device,
  // marks it used and answers with the signed licence (cl_licence_redeem).
  async function redeemShortCode(code){
    if(!isOnline()) return { ok:false, reason:"offline" };
    if(!getSetting("secret_phrase","").trim()) return { ok:false, reason:"no_phrase" };
    if(typeof dcIsRegistered==="function" && !dcIsRegistered()){
      const c = await deviceCheckin();
      if(!c.ok && (c.reason==="offline" || c.reason==="network")) return { ok:false, reason:"offline" };
    }
    const r = await terminalRpc("cl_licence_redeem", Object.assign(terminalAuth(), { p_code: code }));
    if(!r.ok){
      if(r.reason==="offline" || r.reason==="network") return { ok:false, reason:"offline" };
      if(r.reason==="refused"){
        const map = { INVALID_CODE:"invalid", ALREADY_USED:"used", WRONG_DEVICE:"other_device", TOO_MANY_TRIES:"too_many", EXPIRED:"expired", REVOKED:"revoked" };
        return { ok:false, reason: map[r.code] || "invalid" };
      }
      return { ok:false, reason:"server", message:r.message };
    }
    if(!r.data || !r.data.licence) return { ok:false, reason:"invalid" };
    return applyLicence(r.data.licence, "code");
  }
  // One box takes a link, the long licence, a short code or an old-style code.
  function classifyActivationInput(text){
    const raw = String(text||"").trim();
    if(!raw) return { kind:"empty" };
    if(extractLicenceText(raw)) return { kind:"licence", value:raw };
    const n = raw.toUpperCase().replace(/[^A-Z0-9]/g,"");
    if(n.length===10 && [...n].every(c=>ID_ALPHABET.includes(c))) return { kind:"short", value:n };
    if(n.length===6) return { kind:"legacy", value:n };
    return { kind:"bad" };
  }
  async function activateFromInput(text, via){
    const c = classifyActivationInput(text);
    if(c.kind==="empty") return { ok:false, reason:"empty" };
    if(c.kind==="licence") return applyLicence(c.value, via||"paste");
    if(c.kind==="short") return redeemShortCode(c.value);
    if(c.kind==="legacy") return enterLegacyCode(c.value);
    return { ok:false, reason:"invalid" };
  }
  function licenceProblemText(r){
    r = r || {};
    const code = licenceDeviceCode();
    switch(r.reason){
      case "empty": return "Paste the licence from WhatsApp, or type the code.";
      case "other_device": return "This licence is for another device"+(r.lic && r.lic.installId? " ("+r.lic.installId+"…)" : "")+". This device is "+code+". Ask seiGEN for a licence for this device.";
      case "expired": return "This licence expired"+(r.lic? " on "+licDateText(r.lic.untilMs) : "")+". Ask seiGEN for a new one.";
      case "used": return "This code has already been used. If it was on this device, the licence is already active; otherwise ask seiGEN for a new one.";
      case "older": return "This device already has a newer licence"+(r.lic? " than #"+r.lic.serial : "")+".";
      case "offline": return "You're offline. A short code needs the internet: connect and try again, or tap the link or paste the long licence from WhatsApp, which work offline.";
      case "too_many": return "Too many wrong codes. Wait 15 minutes, then try again, or paste the long licence from WhatsApp.";
      case "revoked": return "This licence has been cancelled by seiGEN. Contact seiGEN "+SEIGEN_PHONE+".";
      case "legacy_closed": return "This is an old-style code, which is no longer accepted. seiGEN now sends a licence (a link or a code): WhatsApp "+SEIGEN_PHONE+" with your device code "+code+".";
      case "no_phrase": return "Enter your activation secret phrase in More → Settings first, then try the code again.";
      case "unknown_key": return "This licence needs a newer version of the app. Update the app, then try again.";
      case "server": return "seiGEN couldn't check the code right now ("+(r.message||"server problem")+"). Try again, or paste the long licence.";
      default: return "This code isn't valid. Check it, or paste the whole licence from WhatsApp.";
    }
  }

  // ---- automatic delivery for registered devices (after a check-in) ----
  async function licencePullPending(){
    const cur = currentLicence();
    const r = await terminalRpc("cl_licence_pending", Object.assign(terminalAuth(), { p_after_serial: cur? cur.serial : 0 }));
    if(!r.ok || !r.data || !r.data.licence) return { ok:false };
    return applyLicence(r.data.licence, "checkin");
  }

  // ---- an activation link (…#lic=SL2.…) ----
  // Read once at boot and removed from the address bar; the "#" part never
  // reaches any server.
  function takeLicenceFromUrl(){
    try{
      const h = String(location.hash||"");
      if(!/lic=/.test(h)) return null;
      const t = extractLicenceText(decodeURIComponent(h));
      if(history && history.replaceState) history.replaceState(null, "", location.pathname + location.search);
      return t;
    }catch(e){ return null; }
  }

  // ---- re-checks: every hour, and when the app comes back to the front ----
  let _licWatchStarted = false;
  function startLicenceWatch(){
    if(_licWatchStarted || typeof document==="undefined") return;
    _licWatchStarted = true;
    const check = async ()=>{
      try{ await establishTrustedTime(); }catch(e){}
      if(refreshLicenceLock() && route!=="lock" && route!=="lockreports" && route!=="setup"){ route = "lock"; render(); }
    };
    setInterval(check, 3600000);
    document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="visible") check(); });
  }

  // ================== Screens ==================
  // Part 6: a detected clock anomaly must only ever affect this
  // license/activation screen's copy — never sales, stock, or any other
  // business data. Shown only alongside the existing lock screen, never as
  // its own blocking modal elsewhere in the app.
  function clockAnomalyNoticeHtml(){
    const anomaly = lastClockAnomaly();
    if(!anomaly) return "";
    const what = anomaly==="rollback"
      ? "This device's date/time appears to have moved backward."
      : "This device's date/time appears to have jumped forward unexpectedly.";
    return `<div class="card" style="background:var(--danger-bg);color:var(--danger);margin-bottom:12px;text-align:left">
      <strong>${what}</strong>
      <p class="muted" style="color:inherit;margin:6px 0 0">We use the date/time to keep your trial and activation accurate, so this may be why activation looks locked. Please check the device's date/time settings, connect to the internet so we can verify it automatically, and contact support if this keeps happening.</p>
    </div>`;
  }
  function licenceAppKind(){ return (typeof isDesktopBuild==="function" && isDesktopBuild())? "desktop app" : "phone app"; }
  function licenceWhatsAppText(){
    const lines = ["Hi seiGEN, my shop needs a licence.",
      "Device code: "+licenceDeviceCode(),
      "Shop: "+getSetting("shop_name",""),
      "App: "+licenceAppKind()];
    if(trustedNow().getTime() < legacyCutoffMs()) lines.push("Old-style device code: "+currentDeviceCode());
    return lines.join("\n");
  }
  function copyText(t){
    try{ if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t); return true; } }catch(e){}
    return false;
  }
  function lockReasonText(st){
    if(st.licence && st.untilMs && st.source===null && st.untilMs===st.licence.untilMs) return "Your licence ended on "+licDateText(st.untilMs)+".";
    if(st.trialEndMs && st.untilMs===st.trialEndMs) return "Your 30-day free trial ended on "+licDateText(st.trialEndMs)+".";
    if(st.untilMs) return "Your activation ended on "+licDateText(st.untilMs)+".";
    return "This device needs a licence.";
  }
  // The activation form: device code, contact, one input. Used by the lock
  // screen and by "Enter a new licence" on More → About.
  function activationFormHtml(){
    const legacyOpen = trustedNow().getTime() < legacyCutoffMs();
    return `
      <p class="muted" style="margin:0 0 6px">Your device code</p>
      <div class="device-code" id="actDeviceCode">${escapeHtml(licenceDeviceCode())}</div>
      <button class="btn btn-ghost btn-sm" id="actCopyCode" style="margin:0 auto 10px;display:block">Copy device code</button>
      <button class="btn btn-primary" id="waLock">📲 WhatsApp seiGEN ${SEIGEN_PHONE}</button>
      <a class="btn btn-outline" id="callLock" href="tel:${SEIGEN_PHONE}" style="display:block;margin-top:8px;text-align:center;text-decoration:none">📞 Call ${SEIGEN_PHONE}</a>
      <div class="hr"></div>
      <label for="actCode">Licence or code</label>
      <textarea class="field" id="actCode" rows="2" placeholder="Paste the licence from WhatsApp, or type the code" autocomplete="off" autocapitalize="characters" spellcheck="false" style="text-align:center;font-weight:700;resize:vertical"></textarea>
      <button class="btn btn-primary" id="unlockBtn" style="margin-top:10px">Activate</button>
      <div id="actMsg" role="status" style="margin-top:10px;font-weight:600"></div>
      ${legacyOpen? `<p class="muted" style="font-size:12px;margin:10px 0 0">Old-style 6-character codes are still accepted until ${escapeHtml(licDateText(legacyCutoffMs()))} (old device code ${escapeHtml(currentDeviceCode())}).</p>` : ""}`;
  }
  function wireActivationForm(onDone){
    document.getElementById("waLock").onclick=()=>{
      window.open("https://wa.me/"+SEIGEN_WA+"?text="+encodeURIComponent(licenceWhatsAppText()),"_blank");
    };
    document.getElementById("actCopyCode").onclick=(e)=>{ e.currentTarget.textContent = copyText(licenceDeviceCode())? "Copied" : licenceDeviceCode(); };
    const btn = document.getElementById("unlockBtn"), msg = document.getElementById("actMsg");
    btn.onclick = async ()=>{
      const text = document.getElementById("actCode").value;
      const kind = classifyActivationInput(text).kind;
      btn.disabled = true; btn.textContent = kind==="short"? "Checking with seiGEN…" : "Activating…";
      msg.textContent = ""; msg.style.color = "";
      let r;
      try{ r = await activateFromInput(text, "paste"); }catch(e){ r = { ok:false, reason:"invalid" }; }
      btn.disabled = false; btn.textContent = "Activate";
      if(r.ok){ onDone(r); return; }
      msg.style.color = "var(--danger)";
      msg.textContent = licenceProblemText(r);
    };
  }
  function renderLock(){
    route = "lock";
    const st = licenceState();
    $app.innerHTML = `
      <div class="center-screen">
        <div class="setup-card center">
          <h2>Activation needed</h2>
          ${clockAnomalyNoticeHtml()}
          <p class="muted" id="lockReason">${escapeHtml(lockReasonText(st))} Selling is paused until this device has a licence. Your data is safe.</p>
          ${activationFormHtml()}
          <div class="hr"></div>
          <button class="btn btn-outline" id="lockReports">📊 View reports (read-only)</button>
          <button class="btn btn-outline" id="lockBackup" style="margin-top:8px">💾 Download backup</button>
        </div>
      </div>
    `;
    wireActivationForm((r)=> renderActivationDone(r));
    document.getElementById("lockReports").onclick = ()=>{ route = "lockreports"; render(); };
    document.getElementById("lockBackup").onclick = ()=>{
      downloadDb(`seigen-backup-${new Date().toISOString().replace(/[:.]/g,"-")}.sqlite`);
    };
  }
  function renderActivationDone(r){
    const legacy = r && r.legacy;
    $app.innerHTML = `
      <div class="center-screen">
        <div class="setup-card center">
          <h2>Activated</h2>
          <p id="actDone" style="font-weight:700">This device is activated until ${escapeHtml(licDateText(r.untilMs))}.</p>
          <p class="muted">${legacy? "Old-style code accepted." : "Licence #"+escapeHtml(String(r.serial||""))+" for device "+escapeHtml(licenceDeviceCode())+"."}</p>
          <button class="btn btn-primary" id="actContinue">Continue</button>
        </div>
      </div>`;
    document.getElementById("actContinue").onclick = ()=>{ route = "start"; render(); };
  }
  // A link opened where the shop isn't set up (another browser, a new
  // install): never start setup from it, just say where to open it.
  function renderLinkNoSetup(text){
    $app.innerHTML = `
      <div class="center-screen">
        <div class="setup-card center">
          <h2>Open this in your seiGEN app</h2>
          <p class="muted">This activation link is for a device that's already set up, but this browser has no shop set up. Open the link in the seiGEN Commerce Lite app on that device (or in the browser you installed it from), or copy the licence and paste it into the app's activation screen.</p>
          <button class="btn btn-primary" id="linkCopy">Copy the licence</button>
          <div id="linkCopyMsg" class="muted" style="margin-top:8px"></div>
          <div class="hr"></div>
          <button class="btn btn-ghost" id="linkSetup">This is a new device: set it up</button>
        </div>
      </div>`;
    document.getElementById("linkCopy").onclick = ()=>{
      document.getElementById("linkCopyMsg").textContent = copyText(text)? "Copied. Paste it into the app's activation screen." : text;
    };
    document.getElementById("linkSetup").onclick = ()=>{ route = "setup"; renderSetup(); };
  }
  function renderLinkResult(r){
    if(r.ok) return renderActivationDone(r);
    $app.innerHTML = `
      <div class="center-screen">
        <div class="setup-card center">
          <h2>Couldn't activate</h2>
          <p id="linkErr" style="color:var(--danger);font-weight:600">${escapeHtml(licenceProblemText(r))}</p>
          <button class="btn btn-primary" id="linkContinue">Continue</button>
        </div>
      </div>`;
    document.getElementById("linkContinue").onclick = ()=>{ route = licenceLocked()? "lock" : "start"; render(); };
  }
  // Locked: read-only Reports (no End of Day, returns or requests).
  function renderLockReports(){
    $app.innerHTML = `
      <div class="topbar">
        <button class="logout-btn" id="lockReportsBack" aria-label="Back to activation" title="Back to activation" style="font-size:18px">‹</button>
        <div class="names">
          <div class="shop">${escapeHtml(getSetting("shop_name","Shop"))}</div>
          <div class="branch">Read-only · activation needed</div>
        </div>
      </div>
      <main id="main"><div class="card" id="lockReportsNote" style="border-color:#E8590C;background:#fff8f0;color:#b54708;font-weight:600">Read-only: selling is paused until this device has a licence. <button class="btn btn-sm btn-primary" id="lockReportsActivate" style="margin-left:6px">Activate</button></div><div id="lockReportsBody"></div></main>
    `;
    document.getElementById("lockReportsBack").onclick = ()=>{ route = "lock"; render(); };
    document.getElementById("lockReportsActivate").onclick = ()=>{ route = "lock"; render(); };
    renderReports(document.getElementById("lockReportsBody"), { readOnly:true });
  }
  // More → About: what this device runs on, and early renewal.
  function licenceStatusCardHtml(){
    const st = licenceState();
    let line = "This device needs a licence.";
    if(st.status==="ok" && st.source==="licence") line = "Licensed until "+licDateText(st.untilMs)+" (licence #"+st.licence.serial+").";
    else if(st.status==="ok" && st.source==="trial") line = "Free trial until "+licDateText(st.untilMs)+".";
    else if(st.status==="ok" && st.source==="legacy") line = "Activated (old-style code) until "+licDateText(st.untilMs)+".";
    return `<div class="card" id="licenceCard">
      <h3 style="margin-top:0">Licence</h3>
      <p id="licenceLine" style="font-weight:600">${escapeHtml(line)}</p>
      <p id="licencePlanLine" class="muted" style="margin:0 0 8px">${escapeHtml(licencePlanText(st))}</p>
      <p class="muted" style="margin:0 0 8px">Device code: <b>${escapeHtml(licenceDeviceCode())}</b></p>
      <button class="btn btn-outline" id="licenceRenew">Enter a new licence</button>
    </div>`;
  }
  // Price plans: the plan comes from the SIGNED licence (works offline);
  // the till's role and price from cl_licence_terms (this device only),
  // remembered for when it's offline. Nothing here is editable.
  const LICENCE_PLAN_NAMES = { 1:"Business", 2:"Lite" };
  const LICENCE_ROLE_TEXT = { main:"main till", branch:"first till of a branch", till:"extra till" };
  function licenceTermsCached(){ try{ return JSON.parse(getSetting("licence_terms","")||"null"); }catch(e){ return null; } }
  function licencePlanText(st){
    const lic = st && st.source==="licence" ? st.licence : null;
    if(!lic) return "";
    const t = licenceTermsCached();
    const mine = t && t.serial===lic.serial && t.till_role ? t : null;
    const plan = (mine && mine.plan_name) || LICENCE_PLAN_NAMES[lic.plan];
    if(!plan) return "";   // a licence issued before price plans
    let s = plan+" plan";
    if(mine){
      s += " · "+(LICENCE_ROLE_TEXT[mine.till_role]||mine.till_role)+" · "+mine.currency+" "+Number(mine.unit_fee).toFixed(2)+" per 30 days";
      if(Number(mine.days)!==30) s += " (this licence: "+mine.currency+" "+Number(mine.amount).toFixed(2)+" for "+mine.days+" days)";
    }
    return s+".";
  }
  async function refreshLicenceTerms(){
    if(typeof terminalRpc!=="function" || typeof terminalAuth!=="function") return;
    const r = await terminalRpc("cl_licence_terms", terminalAuth());
    if(!r.ok || !r.data) return;
    setSetting("licence_terms", JSON.stringify(r.data));
    const el = document.getElementById("licencePlanLine");
    if(el) el.textContent = licencePlanText(licenceState());
  }
  function wireLicenceStatusCard(){
    const st = licenceState();
    if(st.source==="licence") refreshLicenceTerms();
    const b = document.getElementById("licenceRenew");
    if(!b) return;
    b.onclick = ()=>{
      const wrap = openModal("Enter a new licence", `<div class="center">${activationFormHtml()}</div>`);
      wireActivationForm((r)=>{ if(wrap && wrap.remove) wrap.remove(); render(); alert("Activated until "+licDateText(r.untilMs)+"."); });
    };
  }
