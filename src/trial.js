  // ================== Free trial (trial rules) ==================
  // docs/activation/trial-rules-design.md. There is no anonymous trial: a
  // shop gets its 30 days only from seiGEN, online, with its RPN's field
  // force number + PIN and the owner's phone (one trial per phone, ever).
  // The issue-trial Edge Function answers with a signed trial licence
  // (activation.js applyLicence), which then works offline. A till that
  // joined a business gets a "cover" licence to the business trial's end
  // date, with no phone or RPN. Until a device has a trial or a licence it is
  // "pretrial" (activation.js licencePretrial()): products, stock and
  // settings work; selling, returns, reports, End of Day, dispatch and market
  // publishing wait.

  function trialUrl(){ return DC_SUPABASE_URL + "/functions/v1/issue-trial"; }
  const TRIAL_TIMEOUT_MS = 20000;
  const TRIAL_TEXT = {
    OFFLINE: "Connect to the internet to start your free trial.",
    RPN_MISSING: "Your RPN types their field force number and PIN here to start your free trial.",
    PHONE_INVALID: "Enter the owner's phone number, e.g. 07x xxx xxxx or +263 7x xxx xxxx.",
    TRY_AGAIN: "seiGEN couldn't start the trial right now. Try again in a minute.",
  };
  const TRIAL_PRETRIAL_TEXT = "Start your free trial to sell. Until then you can add products, receive stock and set up the shop.";

  // The oldest sale as a Harare date (Q8: the server refuses a shop whose
  // sales go back more than 30 days). Products and stock don't count.
  function trialEarliestSaleDate(){
    const ms = earliestSaleMs();
    return ms===null? null : new Date(ms + 2*3600000).toISOString().slice(0,10);
  }

  // o: { phone, ff, pin } for a shop's own trial; { quiet:true } for a joined
  // till's cover or a retry after a lost answer (the server answers a repeat
  // with the same trial). Resolves to { ok, untilMs, serial, kind } or
  // { ok:false, code, message }; never rejects.
  let _trialInFlight = null;
  function requestTrial(o){
    if(!_trialInFlight) _trialInFlight = requestTrialOnce(o||{}).catch(()=>({ ok:false, code:"ERROR", message:TRIAL_TEXT.TRY_AGAIN }))
      .finally(()=>{ _trialInFlight = null; });
    return _trialInFlight;
  }
  async function requestTrialOnce(o){
    if(!isOnline()) return { ok:false, code:"OFFLINE", message:TRIAL_TEXT.OFFLINE };
    if(!o.quiet){
      if(!normPhone(o.phone)) return { ok:false, code:"PHONE_INVALID", message:TRIAL_TEXT.PHONE_INVALID };
      if(!o.ff || !o.pin) return { ok:false, code:"RPN_MISSING", message:TRIAL_TEXT.RPN_MISSING };
      setSetting("owner_phone", String(o.phone).trim());
    }
    // seiGEN must know this device first: the check-in registers it.
    if(!dcIsRegistered()){
      const c = await deviceCheckin();
      if(!c.ok) return { ok:false, code:"CHECKIN", message: (c.reason==="offline" || c.reason==="network")? TRIAL_TEXT.OFFLINE : (dcCheckinProblemText(c) || TRIAL_TEXT.TRY_AGAIN) };
    }
    // Kept until an answer arrives: a lost answer is asked again after the next check-in.
    setSetting("trial_waiting", "1");
    await persist();
    let res, data = null, timer = null;
    try{
      const ctrl = (typeof AbortController!=="undefined")? new AbortController() : null;
      if(ctrl) timer = setTimeout(()=>ctrl.abort(), TRIAL_TIMEOUT_MS);
      res = await fetch(trialUrl(), {
        method:"POST", signal: ctrl? ctrl.signal : undefined,
        headers:{ "apikey": DC_ANON_KEY, "Authorization": "Bearer " + DC_ANON_KEY, "Content-Type":"application/json" },
        body: JSON.stringify({
          install_id: getSetting("install_id",""), phrase: getSetting("secret_phrase",""), device_key: deviceKey(),
          owner_phone: o.quiet? (getSetting("owner_phone","") || null) : String(o.phone).trim(),
          field_force_no: o.quiet? null : String(o.ff).trim().toUpperCase(), pin: o.quiet? null : String(o.pin).trim(),
          earliest_sale: trialEarliestSaleDate(),
        }),
      });
      try{ data = JSON.parse(await res.text()); }catch(e){ data = null; }
    }catch(e){ return { ok:false, code:"NETWORK", message:TRIAL_TEXT.TRY_AGAIN }; }
    finally{ if(timer) clearTimeout(timer); }
    if(!data || data.ok!==true){
      // a refusal is an answer; a server fault (or no function yet) isn't
      if(data && data.code && res.status < 500) setSetting("trial_waiting", "");
      await persist();
      return { ok:false, code: (data && data.code) || "SERVER", message: (data && data.code && res.status < 500 && data.message) || TRIAL_TEXT.TRY_AGAIN };
    }
    setSetting("trial_waiting", "");
    const r = await applyLicence(data.licence, data.kind==="cover"? "trial cover" : "trial");
    if(!r.ok) return { ok:false, code:"LICENCE", message: licenceProblemText(r) };
    if(data.kind==="cover") setSetting("trial_cover_wanted", "");
    await persist();
    // the trial linked the RPN: "Onboarded by" on More → About
    if(!o.quiet && typeof refreshRpnStatus==="function") refreshRpnStatus(true).catch(()=>{});
    return { ok:true, untilMs:r.untilMs, serial:r.serial, kind:data.kind };
  }

  // After every successful check-in (devicecheckin.js): a joined till asks
  // for its cover, and a device whose answer was lost asks again. Quiet: no
  // render, no alert (selling unlocks at the next natural render).
  function trialAfterCheckin(){
    if(licenceState().status!=="pretrial") return Promise.resolve();
    const cover = getSetting("trial_cover_wanted","")==="1";
    if(!cover && getSetting("trial_waiting","")!=="1") return Promise.resolve();
    return requestTrial({ quiet:true }).then((r)=>{
      // the business's trial is over: this till needs a paid licence, so stop asking
      if(!r.ok && (r.code==="BUSINESS_TRIAL_ENDED" || r.code==="TRIAL_ENDS_TODAY")){ setSetting("trial_cover_wanted", ""); return persist(); }
    }).catch(()=>{});
  }

  // ---- the form: owner's phone + the RPN's field force number and PIN ----
  function trialFormHtml(prefix){
    return `
      <label for="${prefix}Phone">Owner's phone</label>
      <input class="field" id="${prefix}Phone" inputmode="tel" autocomplete="tel" placeholder="e.g. 077 123 4567" value="${escapeHtml(getSetting("owner_phone","") || getSetting("contact_phone",""))}">
      <p class="muted" style="margin:4px 0 10px">One free trial per phone number.</p>
      ${rpnVerifyFieldsHtml(prefix)}
      <button class="btn btn-primary" id="${prefix}Start" style="margin-top:12px">Start the free trial</button>
      <div id="${prefix}Msg" role="status" style="margin-top:10px;font-weight:600"></div>`;
  }
  // Wires the form; onDone(r) after the trial is on this device.
  function wireTrialForm(prefix, onDone){
    const btn = document.getElementById(prefix+"Start"), msg = document.getElementById(prefix+"Msg");
    btn.onclick = async ()=>{
      const phone = document.getElementById(prefix+"Phone").value.trim();
      const ff = document.getElementById(prefix+"Ff").value.trim(), pin = document.getElementById(prefix+"Pin").value.trim();
      msg.style.color = "var(--danger)";
      if(!normPhone(phone)){ msg.textContent = TRIAL_TEXT.PHONE_INVALID; return; }
      if(!ff || !pin){ msg.textContent = TRIAL_TEXT.RPN_MISSING; return; }
      btn.disabled = true; btn.textContent = "Asking seiGEN…"; msg.textContent = "";
      const r = await requestTrial({ phone, ff, pin });
      btn.disabled = false; btn.textContent = "Start the free trial";
      if(r.ok){ onDone(r); return; }
      msg.textContent = r.message;
    };
  }
  function trialDoneText(r){ return "Your free trial runs until " + licDateText(r.untilMs) + "."; }
  function openTrialModal(){
    const wrap = openModal("Start your free trial", `
      <p class="muted" style="margin-top:0">Your RPN types their field force number and PIN. This needs the internet once; after that the trial works offline.</p>
      ${trialFormHtml("trialM")}`);
    wireTrialForm("trialM", (r)=>{ if(wrap && wrap.remove) wrap.remove(); render(); alert(trialDoneText(r)); });
    return wrap;
  }

  // ---- pretrial: what the shop sees instead of selling ----
  function pretrialNoticeHtml(){
    return `<div class="card" id="pretrialNotice" style="border-color:#E8590C;background:#fff8f0;color:#b54708">
      <p style="margin:0 0 8px;font-weight:700">${escapeHtml(TRIAL_PRETRIAL_TEXT)}</p>
      <button class="btn btn-primary btn-sm" data-trial-start="1">Start your free trial</button>
      <button class="btn btn-ghost btn-sm" data-trial-licence="1">I have a licence</button>
    </div>`;
  }
  function wirePretrialNotice(scope){
    (scope||document).querySelectorAll("[data-trial-start]").forEach(b=> b.onclick = ()=> openTrialModal());
    (scope||document).querySelectorAll("[data-trial-licence]").forEach(b=> b.onclick = ()=>{
      const wrap = openModal("Enter a licence", `<div class="center">${activationFormHtml()}</div>`);
      wireActivationForm((r)=>{ if(wrap && wrap.remove) wrap.remove(); render(); alert("Activated until "+licDateText(r.untilMs)+"."); });
    });
  }
  // For the entry points that must wait (returns, dispatch, a sale): true =
  // blocked, and the trial form is open.
  function pretrialBlocked(){
    if(!licencePretrial()) return false;
    openTrialModal();
    return true;
  }

  // ---- setup's last step: starting the trial, and the answer ----
  // o: { phone, ff, pin } (a new shop) or { quiet:true } (a joined till).
  async function renderTrialStarting(o){
    $app.innerHTML = `
      <div class="center-screen">
        <div class="setup-card center">
          <h2>Starting your free trial</h2>
          <p class="muted" id="trialStarting">Asking seiGEN…</p>
        </div>
      </div>`;
    const r = await requestTrial(o);
    renderTrialResult(r, o);
    return r;
  }
  function renderTrialResult(r, o){
    if(r.ok){
      $app.innerHTML = `
        <div class="center-screen">
          <div class="setup-card center">
            <h2>Free trial started</h2>
            <p id="trialResult" style="font-weight:700">${escapeHtml(trialDoneText(r))}</p>
            <p class="muted">After that, the app asks for a licence: ask your RPN, or WhatsApp seiGEN on ${SEIGEN_PHONE}.</p>
            <button class="btn btn-primary" id="trialContinue">Continue</button>
          </div>
        </div>`;
      document.getElementById("trialContinue").onclick = ()=>{ route = "pos"; render(); };
      return;
    }
    $app.innerHTML = `
      <div class="center-screen">
        <div class="setup-card center">
          <h2>The free trial didn't start</h2>
          <p id="trialResult" style="color:var(--danger);font-weight:600">${escapeHtml(r.message)}</p>
          <button class="btn btn-primary" id="trialRetry">Try again</button>
          <button class="btn btn-outline" id="trialSkip" style="margin-top:8px">Continue without the trial</button>
          <p class="muted" style="margin-top:10px">Without the trial you can add products and stock now; selling starts with the trial or a licence.</p>
        </div>
      </div>`;
    document.getElementById("trialSkip").onclick = ()=>{ route = "pos"; render(); };
    document.getElementById("trialRetry").onclick = ()=>{
      // the PIN isn't kept: a new shop's retry goes through the form
      if(o && !o.quiet) return renderTrialRetryForm();
      renderTrialStarting(o);
    };
  }
  function renderTrialRetryForm(){
    $app.innerHTML = `
      <div class="center-screen">
        <div class="setup-card">
          <h2>Start your free trial</h2>
          <p class="muted">Your RPN types their field force number and PIN.</p>
          ${trialFormHtml("trialS")}
          <button class="btn btn-outline" id="trialSkip2" style="margin-top:8px">Continue without the trial</button>
        </div>
      </div>`;
    wireTrialForm("trialS", (r)=> renderTrialResult(r, {}));
    document.getElementById("trialSkip2").onclick = ()=>{ route = "pos"; render(); };
  }
