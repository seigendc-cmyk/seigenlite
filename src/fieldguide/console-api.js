  // ================== RPN Field Guide — Console connection (Phase 4) ==================
  // The only file that talks to the Console's Supabase project (CONSOLE_URL,
  // CONSOLE_ANON_KEY: injected by build.js from src/devicecheckin.js). Plain
  // fetch() to the REST API, the way the shop app's sync does; no SDK.
  //
  //   consoleSignIn(name, passcode)  -> the existing cl_login RPC (unchanged).
  //       Its 12-hour token carries user_type and sub (= cl_rpn.id); RLS on
  //       rpn_onboarding_notes is built on those. Staff accounts are refused
  //       here: the Field Guide is for RPNs.
  //   consoleSendNote(session, note) -> one insert into rpn_onboarding_notes.
  //
  // Every outcome is sorted into one the outbox can act on:
  //   sent       inserted, or it was already there from an earlier try
  //   auth       the token is expired or refused: "Sign in to send"
  //   failed + permanent  the Console refused the note itself (shown, retried only by hand)
  //   failed     no connection or the server had a problem (retried with backoff)
  const CONSOLE_TIMEOUT_MS = 15000;

  async function consoleFetch(pathAndQuery, opts, token) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), CONSOLE_TIMEOUT_MS) : null;
    try {
      const res = await fetch(CONSOLE_URL + pathAndQuery, Object.assign({}, opts, {
        signal: ctrl ? ctrl.signal : undefined,
        headers: Object.assign({
          apikey: CONSOLE_ANON_KEY,
          Authorization: "Bearer " + (token || CONSOLE_ANON_KEY),
          "Content-Type": "application/json",
        }, (opts && opts.headers) || {}),
      }));
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { body = { message: text }; }
      return { status: res.status, body };
    } catch (e) {
      return { status: 0, body: null, network: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // The middle part of a JWT, decoded. Read only for exp/sub/user_type;
  // the server checks the signature on every request.
  function decodeJwtPayload(token) {
    try {
      const part = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = part + "===".slice((part.length + 3) % 4);
      const bytes = atob(padded);
      const utf8 = decodeURIComponent(Array.prototype.map.call(bytes, (ch) => "%" + ("0" + ch.charCodeAt(0).toString(16)).slice(-2)).join(""));
      return JSON.parse(utf8);
    } catch (e) {
      return null;
    }
  }

  // -> {ok:true, session:{token, rpnId, name, exp}} or {ok:false, reason, message}
  //    reason: "network" | "invalid" | "not_rpn" | "server"
  async function consoleSignIn(name, passcode) {
    const r = await consoleFetch("/rest/v1/rpc/cl_login", { method: "POST", body: JSON.stringify({ p_name: name, p_passcode: passcode }) });
    if (r.network) return { ok: false, reason: "network" };
    if (r.status === 200 && r.body && r.body.token) {
      const claims = decodeJwtPayload(r.body.token);
      if (!claims || claims.user_type !== "rpn" || !claims.sub || !claims.exp) return { ok: false, reason: "not_rpn" };
      return { ok: true, session: { token: r.body.token, rpnId: claims.sub, name: r.body.full_name || claims.full_name || name, exp: claims.exp * 1000 } };
    }
    const message = (r.body && r.body.message) || "";
    if (/invalid name or passcode/i.test(message)) return { ok: false, reason: "invalid" };
    return { ok: false, reason: "server", message: message || "HTTP " + r.status };
  }

  // The columns the RPN sends. rpn_id is not one of them: the database
  // fills it from the token, and RLS refuses any other value.
  function noteRow(note) {
    const f = note.fields;
    const row = {
      id: note.id,
      business_name: f.business_name, owner_name: f.owner_name, phone: f.phone, city: f.city,
      location: f.location || null, notes: f.notes || null,
      business_type: f.business_type || null, record_keeping: f.record_keeping || null,
      approx_products: f.approx_products === "" || f.approx_products == null ? null : Number(f.approx_products),
      devices: f.devices || null, plan_interest: f.plan_interest || null,
      stocktake_needed: f.stocktake_needed || null,
      visit_date: f.visit_date,
      captured_at: new Date(note.savedAt).toISOString(),
    };
    return row;
  }

  // -> {result:"sent", duplicate?} | {result:"auth"} | {result:"failed", permanent, message}
  async function consoleSendNote(session, note) {
    const r = await consoleFetch("/rest/v1/rpn_onboarding_notes", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(noteRow(note)),
    }, session.token);
    if (r.network) return { result: "failed", permanent: false, message: "No connection to the Console" };
    if (r.status === 201 || r.status === 204) return { result: "sent" };
    const code = (r.body && r.body.code) || "";
    const message = (r.body && r.body.message) || "HTTP " + r.status;
    if (r.status === 401 && code !== "42501") return { result: "auth" }; // PGRST301/302: token expired or invalid
    if (code === "42501") return { result: "failed", permanent: true, message: "The Console didn't accept this account for notes (" + message + ")" };
    if (r.status === 409 || code === "23505") {
      // An earlier try got through but its answer was lost. If the note is
      // there and it's this RPN's, it's sent; nothing is inserted twice.
      const check = await consoleFetch("/rest/v1/rpn_onboarding_notes?select=id&id=eq." + encodeURIComponent(note.id), { method: "GET" }, session.token);
      if (check.status === 200 && Array.isArray(check.body) && check.body.length === 1) return { result: "sent", duplicate: true };
      if (check.network || check.status >= 500) return { result: "failed", permanent: false, message: "Couldn't confirm with the Console" };
      return { result: "failed", permanent: true, message: "The Console already has a different note with this id" };
    }
    if (r.status >= 500 || r.status === 429 || r.status === 408) return { result: "failed", permanent: false, message: "The Console had a problem (" + r.status + ")" };
    return { result: "failed", permanent: true, message: "The Console refused this note: " + message };
  }
