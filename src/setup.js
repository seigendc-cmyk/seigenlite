  // ================== SETUP FLOW ==================
  let setupStep = 1;
  let setupData = {shop_name:"",branch_name:"",secret_phrase:"",contact_phone:"",banner_image:"",currency:"$",branch_type:"main",admin_pass:"",admin_pass2:"",
    rpn:{rpn_name:"",rpn_code:"",rpn_whatsapp:"",city_area:""}};

  function renderSetup(){
    $app.innerHTML = `
      <div class="center-screen">
        <div class="setup-card">
          <div class="step-dots">${[1,2,3,4].map(n=>`<span class="${n<=setupStep?'on':''}"></span>`).join("")}</div>
          ${setupStep===1? `
            <h2>Welcome</h2>
            <p class="muted">Let's set up seiGEN Commerce Lite for your shop.</p>
            <label>Shop name</label>
            <input class="field" id="setShop" value="${escapeHtml(setupData.shop_name)}" placeholder="e.g. Gentronix">
            <label>Branch name (optional)</label>
            <input class="field" id="setBranch" value="${escapeHtml(setupData.branch_name)}" placeholder="e.g. Harare CBD">
            <label>Activation secret phrase</label>
            <input class="field" id="setSecret" value="${escapeHtml(setupData.secret_phrase)}" placeholder="From your RPN or Digital Commerce" autocomplete="off">
            <p class="muted" style="margin-top:4px">Your RPN or Digital Commerce gives you this phrase when you join. It registers this device with Digital Commerce and is used for your activation codes.</p>
            <label>Branch type</label>
            <div class="row">
              <button type="button" class="btn ${setupData.branch_type==='main'?'btn-primary':'btn-outline'}" id="setMainBtn">Main Branch</button>
              <button type="button" class="btn ${setupData.branch_type==='remote'?'btn-primary':'btn-outline'}" id="setRemoteBtn">Remote Branch</button>
            </div>
            <p class="muted" style="margin-top:8px">Remote branches can sell, but can't add or edit items, change stock quantities directly, or see item costs.</p>
            <button class="btn btn-primary" id="setupNext" style="margin-top:16px">Continue</button>
          ` : setupStep===2? `
            <h2>Contact & branding</h2>
            <label>Contact / WhatsApp number</label>
            <input class="field" id="setContact" value="${escapeHtml(setupData.contact_phone)}" placeholder="e.g. +263...">
            <label>Currency symbol</label>
            <input class="field" id="setCurrency" value="${escapeHtml(setupData.currency)}" placeholder="$">
            <label>Shop banner / logo image (optional)</label>
            <input class="field" id="setBanner" type="file" accept="image/*">
            ${setupData.banner_image? `<img class="banner-img" src="${setupData.banner_image}">`:""}
            ${setupData.branch_type==='remote'? `
              <div class="hr"></div>
              <label>Admin passcode for this branch (at least ${ADMIN_PASSCODE_MIN} characters)</label>
              <input class="field" id="setAdminPass" type="password" value="${escapeHtml(setupData.admin_pass)}" placeholder="Choose a passcode">
              <label>Repeat the passcode</label>
              <input class="field" id="setAdminPass2" type="password" value="${escapeHtml(setupData.admin_pass2)}" placeholder="Repeat it">
              <p class="muted">It unlocks Settings and price changes on this remote branch. You create it here; it does not come from the main branch.</p>` : ""}
            <div class="row" style="margin-top:16px">
              <button class="btn btn-outline" id="setupBack">Back</button>
              <button class="btn btn-primary" id="setupNext2">Continue</button>
            </div>
          ` : setupStep===3? `
            <h2>RPN (Reseller Partner Network)</h2>
            <p class="muted">Optional — link the RPN who set you up, for Support later. No lookup happens here; it's stored as entered and you can change it any time from Settings.</p>
            ${rpnFieldsHtml("setRpn", setupData.rpn)}
            <div class="row" style="margin-top:16px">
              <button class="btn btn-outline" id="setupBack3">Back</button>
              <button class="btn btn-primary" id="setupNext3">Continue</button>
            </div>
          ` : `
            <h2>Confirm</h2>
            ${setupData.banner_image? `<img class="banner-img" src="${setupData.banner_image}">`:""}
            <table class="simple">
              <tr><td class="muted">Shop</td><td>${escapeHtml(setupData.shop_name)}</td></tr>
              <tr><td class="muted">Branch</td><td>${escapeHtml(setupData.branch_name)||"—"}</td></tr>
              <tr><td class="muted">Branch type</td><td>${setupData.branch_type==='main'?'Main Branch':'Remote Branch'}</td></tr>
              <tr><td class="muted">Activation phrase</td><td>Entered</td></tr>
              ${setupData.branch_type==='remote'? `<tr><td class="muted">Admin passcode</td><td>Set</td></tr>` : ""}
              <tr><td class="muted">Contact</td><td>${escapeHtml(setupData.contact_phone)||"—"}</td></tr>
              <tr><td class="muted">Currency</td><td>${escapeHtml(setupData.currency)}</td></tr>
              ${(setupData.rpn.rpn_name||setupData.rpn.rpn_code||setupData.rpn.rpn_whatsapp||setupData.rpn.city_area)? `<tr><td class="muted">RPN</td><td>${escapeHtml(setupData.rpn.rpn_name)||"—"}${setupData.rpn.rpn_code? " ("+escapeHtml(setupData.rpn.rpn_code)+")":""}</td></tr>` : ""}
            </table>
            <p class="muted">You get 30 days free use from today. After that, this screen will ask for an activation code — call or WhatsApp +263774479121.</p>
            <div class="row" style="margin-top:10px">
              <button class="btn btn-outline" id="setupBack2">Back</button>
              <button class="btn btn-primary" id="setupFinish">Finish setup</button>
            </div>
          `}
        </div>
      </div>
    `;
    if(setupStep===1){
      // Keep typed values when Main/Remote re-renders this step.
      const keepStep1 = ()=>{
        setupData.shop_name = document.getElementById("setShop").value.trim();
        setupData.branch_name = document.getElementById("setBranch").value.trim();
        setupData.secret_phrase = document.getElementById("setSecret").value.trim();
      };
      document.getElementById("setMainBtn").onclick=()=>{ keepStep1(); setupData.branch_type="main"; renderSetup(); };
      document.getElementById("setRemoteBtn").onclick=()=>{ keepStep1(); setupData.branch_type="remote"; renderSetup(); };
      document.getElementById("setupNext").onclick=()=>{
        keepStep1();
        if(!setupData.shop_name) return alert("Enter your shop name");
        if(!setupData.secret_phrase) return alert("Enter the activation secret phrase your RPN or Digital Commerce gave you.");
        setupStep=2; renderSetup();
      };
    } else if(setupStep===2){
      document.getElementById("setupBack").onclick=()=>{setupStep=1;renderSetup();};
      document.getElementById("setBanner").onchange=(e)=>{
        setupData.contact_phone = document.getElementById("setContact").value.trim();
        setupData.currency = document.getElementById("setCurrency").value.trim()||"$";
        const pa = document.getElementById("setAdminPass"); if(pa){ setupData.admin_pass = pa.value; setupData.admin_pass2 = document.getElementById("setAdminPass2").value; }
        const f = e.target.files[0];
        if(!f) return;
        const reader = new FileReader();
        reader.onload = ()=>{ setupData.banner_image = reader.result; renderSetup(); };
        reader.readAsDataURL(f);
      };
      document.getElementById("setupNext2").onclick=()=>{
        setupData.contact_phone = document.getElementById("setContact").value.trim();
        setupData.currency = document.getElementById("setCurrency").value.trim()||"$";
        if(setupData.branch_type==='remote'){
          setupData.admin_pass = document.getElementById("setAdminPass").value;
          setupData.admin_pass2 = document.getElementById("setAdminPass2").value;
          const bad = adminPasscodeProblem(setupData.admin_pass, setupData.admin_pass2);
          if(bad) return alert(bad);
        }
        setupStep=3; renderSetup();
      };
    } else if(setupStep===3){
      document.getElementById("setupBack3").onclick=()=>{ setupData.rpn = rpnFieldsFromInputs("setRpn"); setupStep=2; renderSetup(); };
      document.getElementById("setupNext3").onclick=()=>{
        setupData.rpn = rpnFieldsFromInputs("setRpn");
        setupStep=4; renderSetup();
      };
    } else {
      document.getElementById("setupBack2").onclick=()=>{setupStep=3;renderSetup();};
      document.getElementById("setupFinish").onclick=async ()=>{
        // Belt and braces: step 1 already insists on it.
        if(!setupData.secret_phrase){ setupStep=1; renderSetup(); return alert("Enter the activation secret phrase your RPN or Digital Commerce gave you."); }
        setSetting("shop_name", setupData.shop_name);
        setSetting("secret_phrase", setupData.secret_phrase);
        setSetting("branch_name", setupData.branch_name);
        setSetting("branch_type", setupData.branch_type);
        setSetting("contact_phone", setupData.contact_phone);
        setSetting("currency", setupData.currency);
        setSetting("banner_image", setupData.banner_image);
        setSetting("paper_width","80");
        setSetting("install_id", uid4());
        resetBranchId();                       // a new branch always gets a fresh identity
        // trustedNow() (eod.js), not a raw new Date(): seeds the trial from
        // the same watermark-clamped clock every other licensing decision
        // uses, so a clock rolled back before setup can't backdate the
        // trial's start either.
        const now = trustedNow();
        setSetting("install_date", now.toISOString());
        const until = new Date(now.getTime()+30*86400000);
        setSetting("activated_until", until.toISOString());
        setSetting("setup_complete","1");
        currency = setupData.currency;
        backfillBranch(db, currentBranch());
        if(setupData.branch_type==='remote') createDeviceAdmin(setupData.admin_pass, setupData.admin_pass2);
        setupData.admin_pass = setupData.admin_pass2 = "";
        // Foundation data only, and optional at onboarding (Part A.1/A.3):
        // if the RPN step was left untouched, skip it entirely rather than
        // queuing an empty sync record for every install. Any deliberate
        // Save from Settings afterward always enqueues (saveRpnLink).
        const rpn = setupData.rpn;
        if(rpn.rpn_name || rpn.rpn_code || rpn.rpn_whatsapp || rpn.city_area) saveRpnLink(rpn);
        await persist();
        route="pos"; render();
        // Register with Digital Commerce now, not at the next launch: the
        // check-in at boot ran before this device had an install ID.
        deviceCheckin();
      };
    }
  }

