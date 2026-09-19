  function computeActivationCode(deviceCode, secretPhrase){
    const combined = deviceCode.toUpperCase()+"|"+secretPhrase.toUpperCase();
    let hash=0;
    for(let i=0;i<combined.length;i++){ hash = ((hash<<5)-hash+combined.charCodeAt(i))|0; }
    hash = Math.abs(hash);
    return hash.toString(36).toUpperCase().padStart(6,"0").slice(-6);
  }
  function daysBetween(a,b){ return Math.floor((b-a)/86400000); }
  function activationStatus(){
    const installDate = getSetting("install_date","");
    const activatedUntil = getSetting("activated_until","");
    if(!installDate) return "no_setup";
    const now = new Date();
    if(activatedUntil && now <= new Date(activatedUntil)) return "ok";
    return "locked";
  }
  function currentDeviceCode(){
    const installDate = new Date(getSetting("install_date"));
    const installId = getSetting("install_id","XXXX");
    const cycle = Math.max(1, Math.floor(daysBetween(installDate,new Date())/30)+1);
    return `${installId}-C${cycle}`;
  }


  function renderLock(){
    const deviceCode = currentDeviceCode();
    $app.innerHTML = `
      <div class="center-screen">
        <div class="setup-card center">
          <h2>Activation needed</h2>
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
        const until = new Date(Date.now()+30*86400000);
        setSetting("activated_until", until.toISOString());
        await persist();
        route="pos"; render();
      } else {
        alert("Incorrect code. Please check and try again.");
      }
    };
  }

