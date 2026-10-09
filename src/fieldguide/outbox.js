  // ================== RPN Field Guide — onboarding notes outbox (Phase 4) ==================
  // Notes are saved on the phone first (IndexedDB "notes" store, store.js)
  // and sent to the Console when the phone is online AND the RPN is signed
  // in. Nothing is dropped: a note leaves this list only by being sent.
  //
  // Each note's status, shown on screen:
  //   saved    "Saved on phone"   waiting for a connection / its turn
  //   sending  "Sending…"         (in memory only, while a request is out)
  //   sent     "Sent to Console"
  //   failed   "Failed - retry"   with the reason; a passing problem (no
  //            connection, server error) is tried again on the same backoff
  //            as the shop app's sync (sync.js: 5 s, doubling, at most
  //            30 min), and the next try time is shown. A note the Console
  //            refused is not retried until the RPN taps Retry.
  //   signin   "Sign in to send"  no sign-in, it has run out (12 hours), or
  //            a different RPN is signed in on this phone
  //
  // A note belongs to the RPN who was signed in on this phone when it was
  // saved (their id and name stay with it, even after the sign-in runs
  // out), and is only ever sent with that RPN's own sign-in.
  const OUTBOX_BASE_DELAY_MS = 5000; // = SYNC_BASE_DELAY_MS in src/sync.js
  const OUTBOX_MAX_DELAY_MS = 30 * 60 * 1000; // = SYNC_MAX_DELAY_MS
  const SESSION_MARGIN_MS = 60 * 1000; // treat a token this close to expiry as expired
  function outboxBackoffMs(attempts) {
    return Math.min(OUTBOX_MAX_DELAY_MS, OUTBOX_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1)));
  }

  // ---------------- the form's fields (mirror the database's checks) ----------------
  const NOTE_FIELDS = [
    { name: "business_name", label: "Business name", required: true, max: 120 },
    { name: "owner_name", label: "Owner's name", required: true, max: 120 },
    { name: "phone", label: "Phone (WhatsApp)", required: true, type: "tel", hint: "e.g. 0771 234 567" },
    { name: "city", label: "City or town", required: true, max: 80 },
    { name: "location", label: "Area or street", max: 200 },
    { name: "visit_date", label: "Date of visit", required: true, type: "date" },
    { name: "business_type", label: "Type of business", max: 80, hint: "e.g. grocery, hardware, salon" },
    { name: "record_keeping", label: "How they keep records now", max: 200, hint: "e.g. exercise book, Excel, nothing" },
    { name: "approx_products", label: "About how many products", type: "number" },
    { name: "devices", label: "Phones or computers they have", max: 200 },
    { name: "plan_interest", label: "Subscription they're interested in", max: 200, hint: "Their words. Prices are set by Digital Commerce." },
    { name: "stocktake_needed", label: "Do they need a stocktake?", type: "choice", options: [["", "Not asked"], ["yes", "Yes"], ["no", "No"], ["not_sure", "Not sure"]] },
    { name: "notes", label: "Notes", max: 4000, type: "textarea" },
  ];
  const PHONE_RULE = /^\+?[0-9][0-9 ]{6,19}$/; // = rpn_onboarding_notes_phone_check

  function localDateKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function emptyNoteFields(now) {
    const f = {};
    for (const def of NOTE_FIELDS) f[def.name] = "";
    f.visit_date = localDateKey(now);
    return f;
  }
  // Zimbabwe by default, the same rule as the RPN Field Manual's trainer
  // number: "0771…" and "771…" become +263771…
  function normalizePhone(raw) {
    const s = String(raw || "").trim();
    const plus = s.startsWith("+");
    let digits = s.replace(/[^0-9]/g, "");
    if (!digits) return "";
    if (!plus) {
      if (digits.charAt(0) === "0") digits = "263" + digits.slice(1);
      else if (digits.length <= 9) digits = "263" + digits;
    }
    return "+" + digits;
  }
  // -> {fields (cleaned), errors: {name: message}}
  function validateNote(input, now) {
    const f = {};
    const errors = {};
    for (const def of NOTE_FIELDS) {
      const raw = input[def.name] == null ? "" : String(input[def.name]);
      const value = def.type === "textarea" ? raw.trim() : raw.replace(/\s+/g, " ").trim();
      f[def.name] = value;
      if (def.required && !value) { errors[def.name] = def.label + " is needed."; continue; }
      if (def.max && value.length > def.max) errors[def.name] = "Keep it under " + def.max + " characters.";
    }
    if (f.phone && !errors.phone) {
      const p = normalizePhone(f.phone);
      const digits = p.replace(/[^0-9]/g, "");
      if (!PHONE_RULE.test(p) || digits.length < 9 || digits.length > 15) errors.phone = "Enter a phone number, e.g. 0771 234 567.";
      else f.phone = p;
    }
    if (f.approx_products !== "") {
      const n = Number(f.approx_products);
      if (!/^[0-9]+$/.test(f.approx_products) || n > 1000000) errors.approx_products = "A whole number, 0 to 1,000,000.";
    }
    if (f.stocktake_needed && ["yes", "no", "not_sure"].indexOf(f.stocktake_needed) === -1) errors.stocktake_needed = "Choose one.";
    if (f.visit_date && !errors.visit_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.visit_date) || isNaN(new Date(f.visit_date + "T00:00:00").getTime())) errors.visit_date = "Enter the date of the visit.";
      else if (f.visit_date > localDateKey(now)) errors.visit_date = "The visit date can't be in the future.";
    }
    return { fields: f, errors };
  }

  // ---------------- state ----------------
  const field = {
    loaded: false,
    session: null, // {token, rpnId, name, exp} from cl_login, while it lasts
    identity: null, // {rpnId, name}: the RPN signed in on this phone (kept after the token runs out)
    notes: [], // newest first
    sending: new Set(), // note ids with a request out
    draft: null, // the form's values, kept while typing, across screens and reloads
    errors: {},
    signin: { busy: false, error: "" },
    running: false,
    again: false,
    current: null, // the promise of the run in progress
    timer: null,
  };
  const fieldNow = () => Date.now();

  function sessionValid(s, now) { return !!(s && s.token && s.exp - SESSION_MARGIN_MS > now); }
  function canSend(note, now) { return sessionValid(field.session, now) && field.session.rpnId === note.rpnId; }

  async function fieldInit() {
    await storeInit();
    try {
      const [session, identity, draft] = await Promise.all([storeGet("meta", "consoleSession"), storeGet("meta", "consoleIdentity"), storeGet("meta", "noteDraft")]);
      field.session = session ? session.value : null;
      field.identity = identity ? identity.value : null;
      field.draft = draft ? draft.value : null;
      field.notes = (await storeGetAll("notes")).sort((a, b) => b.savedAt - a.savedAt);
    } catch (e) { /* storage refused: start empty; storeMode says "memory" */ }
    // A note that was mid-send when the app closed is simply waiting again.
    for (const n of field.notes) if (n.status === "sending") n.status = "saved";
    field.loaded = true;
    // The screen drawn at boot said "Loading…": draw it properly once,
    // whichever it is (the form included; refreshFieldScreens skips that).
    if (state.tab === "field" || state.tab === "me") render(true);
    kickOutbox();
  }

  async function putNote(note) {
    await storePut("notes", note);
    const i = field.notes.findIndex((n) => n.id === note.id);
    if (i === -1) field.notes.unshift(note);
    else field.notes[i] = note;
  }
  function newNoteId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  // Saved on the phone straight away, then queued. Needs to know who the
  // RPN is (signed in at least once on this phone).
  async function saveNote(fields) {
    const now = fieldNow();
    const note = {
      id: newNoteId(), rpnId: field.identity.rpnId, rpnName: field.identity.name,
      fields, savedAt: now, status: "saved", attempts: 0, nextAttemptAt: now, permanent: false, lastError: "", sentAt: null,
    };
    await putNote(note);
    kickOutbox();
    return note;
  }

  // ---------------- sign-in ----------------
  async function signIn(name, passcode) {
    field.signin = { busy: true, error: "", name };
    const r = await consoleSignIn(name, passcode);
    if (!r.ok) {
      field.signin = { busy: false, error: r.reason, name };
      return r;
    }
    field.session = r.session;
    field.identity = { rpnId: r.session.rpnId, name: r.session.name };
    field.signin = { busy: false, error: "", name: "" };
    await storePut("meta", { key: "consoleSession", value: field.session });
    await storePut("meta", { key: "consoleIdentity", value: field.identity });
    // Notes waiting for this RPN's sign-in can go now.
    for (const n of field.notes) {
      if (n.status === "signin" && n.rpnId === r.session.rpnId) {
        Object.assign(n, { status: "saved", nextAttemptAt: fieldNow() });
        await storePut("notes", n);
      }
    }
    // …and so can full onboarding records (onboarding.js).
    if (typeof obSignedInAgain === "function") obSignedInAgain(r.session.rpnId);
    kickOutbox();
    return r;
  }
  // Forgets this phone's sign-in and who the RPN is. Notes stay, with
  // their RPN, until that RPN signs in again and they can be sent.
  async function signOut() {
    field.session = null;
    field.identity = null;
    await storeDelete("meta", "consoleSession");
    await storeDelete("meta", "consoleIdentity");
    refreshFieldScreens();
  }

  // ---------------- sending ----------------
  // One run at a time: asking again while a run is going makes that run
  // go round once more (field.again) instead of starting a second one, so
  // a note is never sent twice in parallel. Returns the run's promise.
  function kickOutbox() {
    if (field.running) { field.again = true; return field.current; }
    if (!field.loaded) return Promise.resolve();
    clearTimeout(field.timer);
    field.running = true;
    field.current = runOutbox();
    return field.current;
  }
  function outboxIdle() { return field.running ? field.current : Promise.resolve(); }
  async function runOutbox() {
    try {
      do {
        field.again = false;
        await outboxPass();
      } while (field.again);
    } finally {
      field.running = false;
    }
    scheduleOutbox();
  }
  async function outboxPass() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return; // waiting for a connection: statuses stay as they are
    const queue = field.notes
      .filter((n) => n.status === "saved" || n.status === "signin" || (n.status === "failed" && !n.permanent))
      .sort((a, b) => a.savedAt - b.savedAt);
    for (const note of queue) {
      const now = fieldNow();
      if (note.status === "failed" && note.nextAttemptAt > now) continue;
      if (!canSend(note, now)) {
        if (note.status !== "signin") { note.status = "signin"; await storePut("notes", note); refreshFieldScreens(); }
        continue;
      }
      field.sending.add(note.id);
      refreshFieldScreens();
      const res = await consoleSendNote(field.session, note);
      field.sending.delete(note.id);
      const after = fieldNow();
      if (res.result === "sent") {
        Object.assign(note, { status: "sent", sentAt: after, lastError: "", permanent: false, nextAttemptAt: null });
      } else if (res.result === "auth") {
        // The Console no longer accepts this sign-in: stop, keep everything.
        field.session = null;
        await storeDelete("meta", "consoleSession");
        Object.assign(note, { status: "signin" });
      } else {
        note.attempts++;
        Object.assign(note, {
          status: "failed", lastError: res.message, permanent: !!res.permanent,
          nextAttemptAt: res.permanent ? null : after + outboxBackoffMs(note.attempts),
        });
      }
      await storePut("notes", note);
      refreshFieldScreens();
      if (res.result === "auth") field.again = true; // so every other note shows "Sign in to send" too
      if (res.result === "failed" && !res.permanent) break; // no connection: don't hammer with the rest
    }
    // Full onboarding records go in the same run, after the notes (onboarding.js).
    if (typeof obPass === "function") await obPass();
  }
  // Wake up for the next due retry, or when the sign-in runs out.
  function scheduleOutbox() {
    clearTimeout(field.timer);
    const now = fieldNow();
    const due = field.notes.filter((n) => n.status === "failed" && !n.permanent && n.nextAttemptAt).map((n) => n.nextAttemptAt);
    if (field.session && field.notes.some((n) => n.status === "saved")) due.push(field.session.exp - SESSION_MARGIN_MS);
    if (typeof obDueTimes === "function") due.push.apply(due, obDueTimes());
    if (!due.length) return;
    const wait = Math.max(1000, Math.min.apply(null, due) - now);
    field.timer = setTimeout(kickOutbox, Math.min(wait, OUTBOX_MAX_DELAY_MS));
  }
  // Retry now: also for a note the Console refused (the RPN decides).
  async function retryNote(id) {
    const note = field.notes.find((n) => n.id === id);
    if (!note || note.status === "sent") return;
    Object.assign(note, { status: "saved", nextAttemptAt: fieldNow(), permanent: false });
    await storePut("notes", note);
    kickOutbox();
  }
