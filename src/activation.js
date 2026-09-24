  function computeActivationCode(deviceCode, secretPhrase){
    const combined = deviceCode.toUpperCase()+"|"+secretPhrase.toUpperCase();
    let hash=0;
    for(let i=0;i<combined.length;i++){ hash = ((hash<<5)-hash+combined.charCodeAt(i))|0; }
    hash = Math.abs(hash);
    return hash.toString(36).toUpperCase().padStart(6,"0").slice(-6);
  }
  function daysBetween(a,b){ return Math.floor((b-a)/86400000); }
  // Both installDate/now here previously used the raw device clock — the
  // one thing an on-device date-rollback bypass can always manipulate.
  // trustedNow() (eod.js) is the persisted, never-goes-backward substitute:
  // rolling the clock back can no longer make an already-elapsed trial
  // period look unexpired again, because trustedNow() never actually moves
  // backwards even when the device clock does.
  function activationStatus(){
    const installDate = getSetting("install_date","");
    const activatedUntil = getSetting("activated_until","");
    if(!installDate) return "no_setup";
    const now = trustedNow();
    if(activatedUntil && now <= new Date(activatedUntil)) return "ok";
    return "locked";
  }
  function currentDeviceCode(){
    const installDate = new Date(getSetting("install_date"));
    const installId = getSetting("install_id","XXXX");
    const cycle = Math.max(1, Math.floor(daysBetween(installDate,trustedNow())/30)+1);
    return `${installId}-C${cycle}`;
  }


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
  function renderLock(){
    const deviceCode = currentDeviceCode();
    $app.innerHTML = `
      <div class="center-screen">
        <div class="setup-card center">
          <h2>Activation needed</h2>
          ${clockAnomalyNoticeHtml()}
          <p class="muted">Your 30 days are up. Call or WhatsApp us with the code below and we'll send an unlock code.</p>
          <div class="device-code">${deviceCode}</div>
          <button class="btn btn-primary" id="waLock">📲 WhatsApp +263774479121</button>
          <div class="hr"></div>
          <label>Enter activation code</label>
          <input class="field" id="actCode" placeholder="XXXXXX" style="text-align:center;letter-spacing:2px;font-weight:700">
          <button class="btn btn-outline" id="unlockBtn" style="margin-top:12px">Unlock</button>
        </div>
      </div>
    `;
    document.getElementById("waLock").onclick=()=>{
      const text = `Hi, my shop needs an activation code. Device code: ${deviceCode}`;
      window.open("https://wa.me/263774479121?text="+encodeURIComponent(text),"_blank");
    };
    document.getElementById("unlockBtn").onclick=async ()=>{
      const entered = document.getElementById("actCode").value.trim().toUpperCase();
      const secret = getSetting("secret_phrase","");
      const expected = computeActivationCode(deviceCode, secret);
      if(entered === expected){
        // trustedNow(), not Date.now(): otherwise rolling the clock back to
        // replay a previously-issued code (same device-code cycle, same
        // secret phrase) would grant a fresh 30 days measured from the
        // rolled-back instant — exactly the repeated-manipulation extension
        // Part 5 rules out.
        const until = new Date(trustedNow().getTime()+30*86400000);
        setSetting("activated_until", until.toISOString());
        await persist();
        route="pos"; render();
      } else {
        alert("Incorrect code. Please check and try again.");
      }
    };
  }

