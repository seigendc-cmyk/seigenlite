  // ================== Business date (seed for licensing anti-rollback) ==================
  // No business-date concept existed anywhere in the app before this — every
  // date-sensitive screen (this one included) used the raw device clock
  // directly. This is the minimum necessary to stop the obvious "wind the
  // clock back a day to keep selling without closing EOD" bypass (Part 7):
  // a persisted high-water-mark that the business date can never fall
  // behind, even if the device clock does.
  //
  // This is NOT full anti-rollback protection — a device whose clock is
  // rolled back BEFORE the app ever observes the later date (e.g. changed
  // while the app is closed, before its next launch) isn't caught here;
  // that needs a trusted time source (network time, or a monotonic clock
  // survey) and is explicitly out of scope for this task. This function is
  // deliberately the seed for that later licensing/anti-rollback work, not
  // a replacement for it.
  function businessDateToday(now){
    now = now || new Date();
    const deviceDate = businessDateOf(now);   // business day rule (utils.js); the watermark below still never lets it go back
    const hwm = getSetting("business_date_hwm","");
    const date = (hwm && hwm > deviceDate) ? hwm : deviceDate;
    if(date !== hwm){ setSetting("business_date_hwm", date); persist(); }
    return date;
  }

  // Settings → "Business day ends at" (owner decision 2026-10-07): 0–6 hours
  // after local midnight. Admin only, and never while a shift is open on
  // this till, so a shift's business day can't change under it. Nor between
  // midnight and the later of the two cut-offs, when the old and new rules
  // disagree on today's date: 00:00 → 03:00 at 01:30 would date the next
  // shift 7 Oct (the watermark never goes back) while its sales count for
  // 6 Oct, already closed, so they'd be in no cash-up.
  function businessCutoffLabel(h){ return String(h).padStart(2,"0")+":00"; }
  function setBusinessDayCutoff(hours, passcode, now){
    const h = Number(hours);
    if(!Number.isInteger(h) || h<0 || h>BUSINESS_DAY_CUTOFF_MAX) throw new Error("Choose a time from 00:00 to 06:00.");
    const open = one("SELECT date, branch FROM eod_sessions WHERE status='open' ORDER BY date LIMIT 1");
    if(open) throw new Error(`Complete the open shift (${open.date}${open.branch? ", "+open.branch : ""}) in Reports → End of Day first, then change when the business day ends.`);
    now = now || new Date();
    const later = Math.max(h, businessCutoffHours());
    if(localDateStr(new Date(now.getTime() - h*3600000)) !== businessDateToday(now))
      throw new Error(`Change this after ${businessCutoffLabel(later)}: until then the new time would move today's business date.`);
    if(!findAdmin(passcode)) throw new Error("Incorrect Admin passcode. The business day was not changed.");
    const old = businessCutoffHours();
    if(h===old) return { changed:false };
    setSetting("business_day_cutoff", String(h));
    logAudit("Business day end changed", "", businessCutoffLabel(old)+" → "+businessCutoffLabel(h));
    persist();
    return { changed:true };
  }

  // ================== License anti-rollback: trusted time ==================
  // This is the "later licensing/anti-rollback work" businessDateToday()'s
  // own comment above flags as its reason for existing. Same technique
  // (a persisted settings-table watermark the app's notion of "now" can
  // never fall behind, no matter what the device clock says), same file,
  // extended from day-granularity (all EOD/shift needs) to full-timestamp
  // precision, because licensing needs to tell ordinary clock drift (a few
  // minutes — never flagged) apart from an actual rollback or forward-jump
  // attempt. This is a second SETTING (trusted_time_hwm), not a second
  // MECHANISM — one settings table, one "persisted max wins" idea, used by
  // activation.js instead of a raw `new Date()` everywhere a licensing
  // decision is made.
  //
  // Also reuses the app's one existing audit trail (logAudit()/audit_log,
  // db.js) for anomaly records instead of a separate log, and its one
  // existing outbound network call primitive (fetch(), see sync.js's
  // supabaseInsert) as an authoritative time source when online — see
  // fetchNetworkTime()'s comment for exactly what "reuse" means here and
  // its real limits, which are also called out plainly in this task's
  // summary rather than overclaimed.

  const CLOCK_DRIFT_TOLERANCE_MS = 5*60*1000;         // ordinary NTP/manual clock drift — never flagged as an anomaly
  const CLOCK_FORWARD_JUMP_ANOMALY_MS = 45*86400000;  // beyond "device was switched off a while"; large enough that no legitimate offline gap this app expects should trip it, small enough to catch a trial-cycling forward jump
  const NETWORK_TIME_TIMEOUT_MS = 4000;               // never let a hung network probe delay boot — see fetchNetworkTime()

  function trustedTimeHwm(){
    const raw = getSetting("trusted_time_hwm","");
    return raw? new Date(raw) : null;
  }
  function setTrustedTimeHwm(d){ setSetting("trusted_time_hwm", d.toISOString()); }
  // Same shape/spirit as every other logAudit() call in this app (Shift
  // started, stock adjustments, ...) — product_name left blank because this
  // isn't a product event, exactly like those other non-product actions.
  function logClockAnomaly(kind, detail){ logAudit("Clock anomaly: "+kind, "", detail); }

  // The one choke point that advances/clamps trusted_time_hwm and records
  // an anomaly when `observed` doesn't line up with it. Pure aside from the
  // setSetting/logAudit side effects — never throws, never blocks anything
  // else. `trustedSource: true` means `observed` already came from a
  // corroborated server timestamp (fetchNetworkTime()): it's allowed to
  // advance the watermark past the forward-jump ceiling (a real server
  // response IS the authoritative source item 4 asks for — the ceiling
  // exists to distrust the DEVICE clock, not a verified server one), but it
  // can still never move the watermark backwards, same as any other source.
  function evaluateTrustedTime(observed, opts){
    observed = observed || new Date();
    const trustedSource = !!(opts && opts.trustedSource);
    const hwm = trustedTimeHwm();
    if(!hwm){ setTrustedTimeHwm(observed); return { time:observed, anomaly:null }; }
    const deltaMs = observed.getTime() - hwm.getTime();
    if(!trustedSource && deltaMs < -CLOCK_DRIFT_TOLERANCE_MS){
      logClockAnomaly("rollback", `Device time ${observed.toISOString()} is ${Math.round(-deltaMs/60000)} min behind the last trusted time ${hwm.toISOString()}`);
      return { time:hwm, anomaly:"rollback" }; // watermark wins — the trusted time never actually moves backwards
    }
    if(!trustedSource && deltaMs > CLOCK_FORWARD_JUMP_ANOMALY_MS){
      logClockAnomaly("forward_jump", `Device time ${observed.toISOString()} is ${Math.round(deltaMs/86400000)} days ahead of the last trusted time ${hwm.toISOString()}`);
      return { time:hwm, anomaly:"forward_jump" }; // don't trust an uncorroborated jump either — freeze at the watermark
    }
    if(deltaMs > 0){ setTrustedTimeHwm(observed); return { time:observed, anomaly:null }; }
    return { time:hwm, anomaly:null }; // not newer than the watermark (e.g. trivial negative drift from a trusted source) — keep it, no anomaly
  }

  // Attempts a server-corroborated timestamp using the exact same fetch()
  // call this app already makes for Supabase (sync.js's supabaseInsert) —
  // the only outbound network mechanism it has. Reads the response's Date
  // header, which every HTTP server sends, including Supabase's own
  // gateway. Real, plainly-stated limitation: a cross-origin fetch()'s
  // response headers are only readable in a browser if the server opts in
  // via Access-Control-Expose-Headers, which most gateways (Supabase's
  // included, by default) do not do for the Date header — so in practice
  // this often returns null, and the app correctly falls back to the local
  // high-water-mark below. It's still the right thing to attempt (it costs
  // nothing when it fails). It reuses cloud sync's Supabase project (built
  // in — see getSupabaseConfig in sync.js) rather than inventing a new
  // server to ask. Bounded by a short
  // timeout so a hung request can never delay boot.
  async function fetchNetworkTime(){
    if(!isOnline()) return null;
    const cfg = getSupabaseConfig();
    if(!cfg.url.trim()) return null;
    let timer=null;
    try{
      const ctrl = (typeof AbortController!=="undefined")? new AbortController() : null;
      if(ctrl) timer = setTimeout(()=>ctrl.abort(), NETWORK_TIME_TIMEOUT_MS);
      const res = await fetch(cfg.url.replace(/\/+$/,"")+"/rest/v1/", { method:"HEAD", cache:"no-store", signal: ctrl? ctrl.signal : undefined });
      const hdr = (res && res.headers && res.headers.get)? res.headers.get("date") : null;
      if(!hdr) return null;
      const d = new Date(hdr);
      return isNaN(d.getTime())? null : d;
    }catch(e){ return null; }
    finally{ if(timer) clearTimeout(timer); }
  }

  // Cached across the session so activation.js's synchronous checks
  // (activationStatus(), currentDeviceCode(), the unlock handler) all see
  // the SAME evaluated instant/anomaly this boot found, rather than each
  // re-running the async network probe. Set for real by establishTrustedTime()
  // (called once at boot, main.js — same spot/habit as businessDateToday()'s
  // own "as early as possible each session" call).
  let _lastClockCheck = null;
  async function establishTrustedTime(now){
    const netTime = await fetchNetworkTime();
    _lastClockCheck = netTime
      ? evaluateTrustedTime(netTime, { trustedSource:true })
      : evaluateTrustedTime(now || new Date());
    persist();
    return _lastClockCheck;
  }
  // The time any licensing decision must use instead of a raw `new Date()`.
  // If establishTrustedTime() hasn't run yet this session (a direct/test
  // call, or activationStatus() somehow reached before boot's await
  // resolves), this still routes through the same watermark-clamping logic
  // synchronously (device clock only, no network) — never bypasses it.
  function trustedNow(){
    if(!_lastClockCheck) _lastClockCheck = evaluateTrustedTime(new Date());
    return _lastClockCheck.time;
  }
  // What activation.js's lock screen reads to explain (Part 6: license/
  // activation state only, never a data lockout) when the CURRENT session's
  // check found the device clock rolled back or jumped — null the rest of
  // the time, including once a later, clean check supersedes it.
  function lastClockAnomaly(){ return _lastClockCheck? _lastClockCheck.anomaly : null; }

  // ================== Shift / EOD control ==================
  // Reuses eod_sessions (already existed as a one-row-per-count log; see
  // db.js) as the shift record — one row per (branch, business date),
  // status 'open' while trading, 'closed' once EOD is completed. No new
  // table. Operator attribution reuses currentStaff()/sessionStaffId from
  // the staff-PIN work: currentStaff() when PIN sign-in is active, else the
  // existing single-operator sessionUser — never a second identity concept.
  function oldestOpenShift(branch){
    return one("SELECT * FROM eod_sessions WHERE branch=? AND status='open' ORDER BY date LIMIT 1",[branch]);
  }
  function openShiftForDate(branch, date){
    return one("SELECT * FROM eod_sessions WHERE branch=? AND date=? AND status='open'",[branch,date]);
  }
  function eodOperatorName(){
    const staff = currentStaff();
    return staff? staff.name : (sessionUser||"");
  }
  function eodOperatorStaffId(){
    const staff = currentStaff();
    return staff? staff.id : null;
  }
  // "" = a sale may proceed; otherwise the plain reason to show the
  // operator. The one choke point both renderPOS and renderPOSDesktop (via
  // completeSale) go through — see pos.js.
  function shiftBlockReason(now){
    const branch = currentBranch();
    const today = businessDateToday(now);
    const stale = oldestOpenShift(branch);
    if(stale && stale.date<today) return `${stale.date}'s shift hasn't been completed yet. Go to Reports → End of Day, complete and print it, before making a new sale.`;
    if(!stale) return "Start a shift (declare your opening cash float) in Reports → End of Day before making a sale.";
    return "";
  }
  // Idempotent: re-calling with today's shift already open just returns it
  // (Part 8's "reopening the screen never creates duplicates" applies here
  // too, not just to completion).
  function startShift(openingFloat, now){
    const branch = currentBranch();
    const today = businessDateToday(now);
    const stale = oldestOpenShift(branch);
    if(stale && stale.date<today) throw new Error(`${stale.date}'s shift hasn't been completed yet. Complete and print it before starting a new one.`);
    if(stale && stale.date===today) return stale;
    const amt = parseFloat(openingFloat);
    if(isNaN(amt) || amt<0) throw new Error("Enter the opening cash float (0 or more)");
    const ts = (now||new Date()).toISOString();
    run(`INSERT INTO eod_sessions(date,branch,ts,status,opening_float,started_ts,started_by,started_staff_id)
         VALUES(?,?,?,'open',?,?,?,?)`,
      [today,branch,ts,amt,ts,eodOperatorName(),eodOperatorStaffId()]);
    logAudit("Shift started","",`Opening float ${currency}${amt.toFixed(2)}`);
    persist();
    return openShiftForDate(branch,today);
  }
  // Single source of truth for the reconciliation math (Part 4), shared by
  // the live preview and the actual completion, so what's shown is always
  // what gets recorded. Payouts already exist as a concept in this app
  // (the payouts table, used elsewhere for cash-drawer-outs) and are reused
  // exactly as-is — no Chart of Accounts/categorization is built here; that
  // stays the clearly-flagged next phase.
  // cash/ecocash/credit are read from sale_payments, not sales.total, so a
  // split-tender sale only contributes the portion actually paid by each
  // method — critical for "expected cash", which must never include a
  // non-cash tender line just because it shared a receipt with a cash one.
  // Every sale (split or not) has at least one sale_payments row (see
  // pos.js completeSale), so this is exactly equivalent to the old
  // sales.total-based sums for any sale that was never split.
  function eodTotalsFor(branch, date, openingFloat){
    // the shift's business day as UTC instants (utils.js), same rule as the reports
    const day = businessRange(date, date);
    const daySales = all("SELECT * FROM sales WHERE branch=? AND ts>=? AND ts<=?",[branch,day.fromTs,day.toTs]);
    const saleIds = daySales.map(s=>s.id);
    const dayPayments = saleIds.length
      ? all(`SELECT * FROM sale_payments WHERE sale_id IN (${saleIds.map(()=>"?").join(",")})`, saleIds)
      : [];
    const sumMethod = (m)=> dayPayments.filter(p=>p.method===m).reduce((s,r)=>s+r.amount,0);
    const cash = sumMethod("Cash");
    const ecocash = sumMethod("EcoCash");
    const credit = sumMethod("Credit");
    const discounts = daySales.reduce((s,r)=>s+(r.discount||0),0);
    const totalSales = cash+ecocash+credit;
    const payouts = all("SELECT * FROM payouts WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[branch,day.fromTs,day.toTs]);
    const payoutsTotal = payouts.reduce((s,r)=>s+r.amount,0);
    const expected = (openingFloat||0) + cash - payoutsTotal; // opening float + cash sales - payouts = expected cash
    // Multi-Currency Support (item 5): `cash` above stays the blended
    // base-currency-equivalent figure `expected` is built from — unchanged.
    // This is purely an additional breakdown so a till count can be
    // reconciled physically, per currency, using `tendered` (the actual
    // banknotes handed over) rather than each currency's base-equivalent.
    const byCurrency = {};
    dayPayments.filter(p=>p.method==="Cash").forEach(p=>{
      const code = p.currency || BASE_CURRENCY_CODE;
      if(!byCurrency[code]) byCurrency[code] = { currency:code, tendered:0, amount:0 };
      byCurrency[code].tendered += (p.tendered_amount==null? p.amount : p.tendered_amount);
      byCurrency[code].amount += p.amount;
    });
    const cashByCurrency = Object.keys(byCurrency).sort().map(code=>({
      currency: code,
      symbol: currencySymbolFor(code),
      name: currencyNameFor(code),
      tendered: roundMoney(byCurrency[code].tendered),
      amount: roundMoney(byCurrency[code].amount),
    }));
    return { cash, ecocash, credit, discounts, totalSales, payouts, payoutsTotal, expected, cashByCurrency };
  }
  // Closes whichever shift is open (today's, or an older unresolved one
  // being caught up on) — idempotent: once closed, oldestOpenShift() no
  // longer finds it, so calling this again throws instead of writing a
  // second row (Part 8).
  function completeEOD(countedCash, notes, now){
    const branch = currentBranch();
    const shift = oldestOpenShift(branch);
    if(!shift) throw new Error("There's no open shift to complete.");
    const counted = parseFloat(countedCash);
    if(isNaN(counted)) throw new Error("Enter the counted cash amount");
    const totals = eodTotalsFor(branch, shift.date, shift.opening_float);
    const variance = counted-totals.expected;
    const ts = (now||new Date()).toISOString();
    run(`UPDATE eod_sessions SET status='closed', expected_cash=?, counted_cash=?, variance=?, notes=?, closed_ts=?, closed_by=?, closed_staff_id=? WHERE id=?`,
      [totals.expected,counted,variance,notes||"",ts,eodOperatorName(),eodOperatorStaffId(),shift.id]);
    logAudit("EOD completed","",`Expected ${currency}${totals.expected.toFixed(2)}, counted ${currency}${counted.toFixed(2)}, variance ${currency}${variance.toFixed(2)}`);
    persist();
    return one("SELECT * FROM eod_sessions WHERE id=?",[shift.id]);
  }
  function markEodPrinted(shiftId, now){
    run("UPDATE eod_sessions SET printed_ts=? WHERE id=?",[(now||new Date()).toISOString(),shiftId]);
    persist();
  }
  // Shapes a shift + its totals into the `summary` object printing.js's
  // buildEODBytes/printEOD already expect — only addition is openingFloat.
  function eodPrintSummary(shift, totals, lowStock, counted){
    const c = counted===undefined? (shift.counted_cash||0) : counted;
    return { date:shift.date, cash:totals.cash, ecocash:totals.ecocash, credit:totals.credit, discounts:totals.discounts,
      totalSales:totals.totalSales, payouts:totals.payouts, payoutsTotal:totals.payoutsTotal, openingFloat:shift.opening_float||0,
      expected:totals.expected, counted:c, variance:c-totals.expected, lowStock, cashByCurrency:totals.cashByCurrency||[] };
  }
  function eodWhatsAppText(summary){
    const itemLines = [
      padLine("Opening Float", `${currency}${summary.openingFloat.toFixed(2)}`),
      padLine("Sales Cash", `${currency}${summary.cash.toFixed(2)}`),
      // Only shown once more than one currency was actually taken as cash —
      // a base-currency-only shop's EOD message reads exactly as before.
      ...((summary.cashByCurrency||[]).length>1
        ? summary.cashByCurrency.map(r=>padLine(`  ${r.currency} cash`, `${r.symbol}${r.tendered.toFixed(2)}`))
        : []),
      padLine("Sales EcoCash", `${currency}${summary.ecocash.toFixed(2)}`),
      padLine("Sales Credit", `${currency}${summary.credit.toFixed(2)}`),
      padLine("Less: Discounts", `-${currency}${summary.discounts.toFixed(2)}`),
      padLine("Payouts", `-${currency}${summary.payoutsTotal.toFixed(2)}`)
    ];
    const totalLines = [
      padLine("Total Sales", `${currency}${summary.totalSales.toFixed(2)}`),
      padLine("Expected Cash", `${currency}${summary.expected.toFixed(2)}`),
      padLine("Cash Count", `${currency}${summary.counted.toFixed(2)}`),
      padLine("Variance", `${currency}${summary.variance.toFixed(2)}`),
      "", `Low stock: ${summary.lowStock.map(p=>p.name).join(", ")||"None"}`
    ];
    return receiptText(`${escapeHtml(getSetting("shop_name",""))} — EOD ${summary.date}`, itemLines, totalLines);
  }

  // Advisory only — completeSale() is what actually enforces the block.
  // Shared by renderPOS (pos.js) and renderPOSDesktop (desktop/sales-
  // desktop.js, Tauri only) so a cashier finds out before filling a cart,
  // not only at checkout, without either screen duplicating the rule.
  function shiftBlockBannerHtml(){
    const reason = shiftBlockReason();
    if(!reason) return "";
    return `<div class="card" style="border-color:var(--danger,#c0392b);margin-bottom:10px">
      <p style="margin:0 0 8px;font-weight:700">${escapeHtml(reason)}</p>
      <button class="btn btn-outline" id="goToEodBtn">Go to End of Day</button>
    </div>`;
  }
  function wireShiftBlockBanner(){
    const btn = document.getElementById("goToEodBtn");
    if(btn) btn.onclick=()=>{ route="reports"; render(); };
  }

  function renderEOD(main){
    const branch = currentBranch();
    const now = new Date();
    const today = businessDateToday(now);
    const shift = oldestOpenShift(branch);
    if(!shift) return renderStartShiftCard(main, branch, today);
    renderShiftReconciliation(main, branch, shift, today);
  }

  function renderStartShiftCard(main, branch, today){
    const lastClosed = one("SELECT * FROM eod_sessions WHERE branch=? AND date=? AND status='closed' ORDER BY closed_ts DESC LIMIT 1",[branch,today]);
    main.innerHTML = `
      ${lastClosed? `
        <div class="card">
          <h3>Today's End of Day is complete</h3>
          <p class="muted">Closed ${lastClosed.closed_ts? new Date(lastClosed.closed_ts).toLocaleString() : ""} by ${escapeHtml(lastClosed.closed_by||"—")}.</p>
          <div class="subline"><span>Opening float</span><span>${currency}${(lastClosed.opening_float||0).toFixed(2)}</span></div>
          <div class="subline"><span>Expected cash</span><span>${currency}${(lastClosed.expected_cash||0).toFixed(2)}</span></div>
          <div class="subline"><span>Counted cash</span><span>${currency}${(lastClosed.counted_cash||0).toFixed(2)}</span></div>
          <div class="subline" style="font-weight:700"><span>Variance</span><span style="color:${(lastClosed.variance||0)<0?'var(--danger)':'var(--success)'}">${currency}${(lastClosed.variance||0).toFixed(2)}</span></div>
          <button class="btn btn-outline" id="reprintClosedEodBtn" style="margin-top:10px">🖨️ Print / PDF again</button>
        </div>` : ""}
      <div class="card">
        <h3>Start Shift — ${today}</h3>
        <p class="muted">Declare the opening cash float counted into the drawer before selling can begin${lastClosed? " again":""}. Recorded against you, timestamped.</p>
        <label>Opening float (${currency})</label>
        <input class="field" id="openingFloat" type="number" step="0.01" placeholder="0.00">
        <button class="btn btn-primary" id="startShiftBtn" style="margin-top:12px">Start Shift</button>
      </div>
    `;
    const reprint = document.getElementById("reprintClosedEodBtn");
    if(reprint) reprint.onclick=()=>{
      const totals = eodTotalsFor(branch, lastClosed.date, lastClosed.opening_float);
      const lowStock = all("SELECT * FROM products WHERE branch=? AND stock<=low_threshold ORDER BY stock",[branch]);
      printEOD(eodPrintSummary(lastClosed, totals, lowStock));
      markEodPrinted(lastClosed.id);
    };
    document.getElementById("startShiftBtn").onclick=()=>{
      try{ startShift(document.getElementById("openingFloat").value); }
      catch(e){ return alert(e.message||String(e)); }
      render();
    };
  }

  function renderShiftReconciliation(main, branch, shift, today){
    const totals = eodTotalsFor(branch, shift.date, shift.opening_float);
    const lowStock = all("SELECT * FROM products WHERE branch=? AND stock<=low_threshold ORDER BY stock",[branch]);
    const isStale = shift.date<today;
    main.innerHTML = `
      ${isStale? `<div class="card" style="border-color:var(--danger,#c0392b)">
        <p style="margin:0;font-weight:700">This shift is from ${shift.date} and must be completed before ${today}'s sales can continue.</p>
      </div>` : ""}
      <h2>End of Day — ${shift.date}</h2>
      <div class="card">
        <div class="subline"><span>Opening float</span><span>${currency}${(shift.opening_float||0).toFixed(2)}</span></div>
        <div class="subline"><span>Sales Cash</span><span>${currency}${totals.cash.toFixed(2)}</span></div>
        ${(totals.cashByCurrency||[]).length>1? `<div style="padding-left:12px;margin-bottom:2px">
          ${totals.cashByCurrency.map(r=>`<div class="subline" style="font-size:12px"><span>${escapeHtml(r.currency)} cash</span><span>${escapeHtml(r.symbol)}${r.tendered.toFixed(2)} <span class="muted">(≈ ${currency}${r.amount.toFixed(2)})</span></span></div>`).join("")}
        </div>` : ""}
        <div class="subline"><span>Sales EcoCash</span><span>${currency}${totals.ecocash.toFixed(2)}</span></div>
        <div class="subline"><span>Sales Credit</span><span>${currency}${totals.credit.toFixed(2)}</span></div>
        <div class="subline"><span>Less: Discounts</span><span>-${currency}${totals.discounts.toFixed(2)}</span></div>
        <div class="hr" style="margin:8px 0"></div>
        <div class="total-line"><span>Total Sales</span><span>${currency}${totals.totalSales.toFixed(2)}</span></div>
        <p class="muted" style="font-size:12px;margin-top:6px">Shift started ${shift.started_ts? new Date(shift.started_ts).toLocaleString():""} by ${escapeHtml(shift.started_by||"—")}.</p>
      </div>

      <div class="card">
        <h3>Payouts today</h3>
        ${totals.payouts.length===0?`<p class="muted">None recorded</p>`:
          totals.payouts.map(p=>`<div class="subline"><span>${escapeHtml(p.reason||"Payout")}</span><span>-${currency}${p.amount.toFixed(2)}</span></div>`).join("")}
        <div class="subline" style="font-weight:700"><span>Total payouts</span><span>-${currency}${totals.payoutsTotal.toFixed(2)}</span></div>
        <button class="btn btn-outline" id="openAddPayout" style="margin-top:10px">+ Add Payout</button>
      </div>

      <div class="card">
        <h3>Blind cash count</h3>
        <p class="muted">Opening float + cash sales − payouts = expected cash. Count the drawer and enter the amount — expected cash stays hidden until you submit.</p>
        <label>Cash counted (${currency})</label>
        <input class="field" id="counted" type="number" step="0.01" placeholder="0.00">
        <button class="btn btn-primary" id="submitCount" style="margin-top:12px">Complete EOD</button>
        <div id="varianceResult"></div>
      </div>

      <div class="card">
        <h3>Low stock (${lowStock.length})</h3>
        ${lowStock.length===0? `<p class="muted">All good — nothing low.</p>` :
          lowStock.map(p=>`<div class="product-row"><div class="pname">${escapeHtml(p.name)}</div><span class="pill low">${p.stock} left</span></div>`).join("")}
      </div>
    `;
    document.getElementById("openAddPayout").onclick=()=>payoutModal(()=>render());

    // Printing/sharing only becomes available once EOD is actually
    // completed (see file header on "completes and prints") — the buttons
    // are injected here rather than shown upfront, and always act on the
    // just-closed record so what's printed always matches what's stored.
    document.getElementById("submitCount").onclick=()=>{
      const countedVal = document.getElementById("counted").value;
      let completed;
      try{ completed = completeEOD(countedVal, ""); }
      catch(e){ return alert(e.message||String(e)); }
      const variance = completed.variance;
      const summary = eodPrintSummary(completed, totals, lowStock, completed.counted_cash);
      document.getElementById("varianceResult").innerHTML = `
        <div class="hr"></div>
        <div class="row">
          <div><div class="muted">Expected</div><b>${currency}${completed.expected_cash.toFixed(2)}</b></div>
          <div><div class="muted">Counted</div><b>${currency}${completed.counted_cash.toFixed(2)}</b></div>
          <div><div class="muted">Variance</div><b style="color:${variance<0?'var(--danger)':'var(--success)'}">${currency}${variance.toFixed(2)}</b></div>
        </div>
        <p class="muted" style="margin-top:8px">Shift closed. Print or share this report, then Sell unlocks for the next business day.</p>
        <div class="row" style="margin-top:10px">
          <button class="btn btn-outline" id="printEodBtn">🖨️ Print / PDF</button>
          <button class="btn btn-ghost" id="waEodBtn">📲 WhatsApp</button>
          ${hasUSBPrint()? `<button class="btn btn-outline" id="usbEodBtn" style="flex:none;width:auto;padding:12px">🔌</button>` : ""}
          ${hasBTPrint()? `<button class="btn btn-outline" id="btEodBtn" style="flex:none;width:auto;padding:12px">🔵</button>` : ""}
        </div>`;
      document.getElementById("submitCount").disabled = true;
      document.getElementById("counted").disabled = true;
      document.getElementById("printEodBtn").onclick=()=>{ printEOD(summary); markEodPrinted(completed.id); };
      document.getElementById("waEodBtn").onclick=()=>{ shareWhatsApp(eodWhatsAppText(summary)); markEodPrinted(completed.id); };
      const usbBtn = document.getElementById("usbEodBtn");
      if(usbBtn) usbBtn.onclick=()=>{ usbPrintEODBytes(summary); markEodPrinted(completed.id); };
      const btBtn = document.getElementById("btEodBtn");
      if(btBtn) btBtn.onclick=()=>{ btPrintEODBytes(summary); markEodPrinted(completed.id); };
    };
  }

  function branchSelectHtml(id, defaultValue){
    const branches = listBranches();
    const sel = defaultValue===undefined ? currentBranch() : defaultValue;
    return `<select class="field" id="${id}">
      <option value="" ${sel===""?"selected":""}>All branches</option>
      ${branches.map(b=>`<option value="${escapeHtml(b)}" ${b===sel?"selected":""}>${escapeHtml(b)}</option>`).join("")}
    </select>`;
  }

  function repHead(title, kebabId, presets){
    const menu = presets? `
      <div class="kebab-wrap">
        <button class="kebab-btn" data-kebab-toggle="${kebabId}">${ICON_DOTS}</button>
        <div class="kebab-menu" id="menu-${kebabId}">
          ${presets.map(p=>`<button data-preset="${kebabId}:${p.key}">${p.label}</button>`).join("")}
        </div>
      </div>` : "";
    return `<div class="rep-head"><h3 class="rep-title">${title}</h3>${menu}</div>`;
  }
  const REP_PRESETS = [{label:"Today",key:"today"},{label:"Last 7 days",key:"week"},{label:"This month",key:"month"}];
