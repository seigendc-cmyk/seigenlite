  // ================== RPN Field Guide — Field tab + Console sign-in (Phase 4) ==================
  // Screens:
  //   #/field              onboarding notes, each with its sending status
  //   #/field/new          the onboarding note form
  //   #/field/note/<id>    one note: what was written, where it is, Retry
  //   #/field/ob/…         full vendor onboarding (onboarding-ui.js)
  // plus the sign-in card on the Me tab (cl_login).
  //
  // Buttons carry data-act "f-…"; app.js sends clicks, submits and typing
  // on #fgMain here (fieldAction / fieldSubmit / fieldInput). What the RPN
  // types into the form lives in field.draft (and on the phone), not in the
  // page: going online or offline, a status change on another note, or
  // leaving the form and coming back never loses it.
  const DRAFT_SAVE_MS = 400;
  let draftTimer = null;

  const STATUS_TEXT = { saved: "Saved on phone", sending: "Sending…", sent: "Sent to Console", failed: "Failed - retry", signin: "Sign in to send" };
  const STATUS_CLASS = { saved: "fg-pill-grey", sending: "fg-pill-grey", sent: "ok", failed: "low", signin: "fg-pill-warn" };
  function noteStatus(note) { return field.sending.has(note.id) ? "sending" : note.status; }
  function statusPill(note) {
    const s = noteStatus(note);
    return '<span class="pill ' + STATUS_CLASS[s] + '">' + esc(STATUS_TEXT[s]) + "</span>";
  }
  const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateOf = (key) => { const d = new Date(key + "T00:00:00"); return isNaN(d) ? key : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }); };

  // Redraw whatever shows notes or the sign-in, but never the form itself.
  // (Only runs after app.js has booted: fieldInit is started from there.)
  // Skipped while anything on the screen holds typing that isn't saved
  // (a box whose text differs from what was drawn, or one being typed in):
  // it catches up on the next change of screen.
  function screenHasTyping(main) {
    const active = document.activeElement;
    if (active && main.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return true;
    return [...main.querySelectorAll("input, textarea")].some((el) => el.type !== "hidden" && el.value !== el.defaultValue);
  }
  function refreshFieldScreens() {
    const main = document.getElementById("fgMain");
    if (!main || screenHasTyping(main)) return;
    // Never the forms: a note being written, or an onboarding section.
    const onForm = state.tab === "field" && (state.sub[0] === "new" || (state.sub[0] === "ob" && (state.sub[1] === "new" || state.sub.length > 2)));
    if ((state.tab === "field" && !onForm) || state.tab === "me") render(false);
  }
  // The sign-in button and its "needs internet" line, updated in place.
  function patchSignInOnline(online) {
    const btn = document.querySelector("#fgSignin form button[type=submit]");
    if (btn) btn.disabled = !online || field.signin.busy;
    const hint = document.getElementById("fgSigninOffline");
    if (hint) hint.hidden = online;
  }

  // ---------------- list ----------------
  function identityHtml() {
    const now = fieldNow();
    if (!field.identity) {
      return '<div class="card fg-callout-card"><p>Sign in once on this phone with your Console RPN account to start writing onboarding notes.</p>' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="f-go-me">Sign in</button></div>';
    }
    if (!sessionValid(field.session, now)) {
      return '<div class="card fg-callout-card fg-callout-warn"><p><strong>' + esc(field.identity.name) + "</strong>, your sign-in has ended. Notes still save on this phone; sign in again to send them.</p>" +
        '<button type="button" class="btn btn-primary btn-sm" data-act="f-go-me">Sign in to send</button></div>';
    }
    return '<p class="fg-who">Sending as <strong>' + esc(field.identity.name) + "</strong> · signed in until " + esc(timeOf(field.session.exp)) + "</p>";
  }
  function fieldListHtml() {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const rows = field.notes.map((n) =>
      '<button type="button" class="fg-note-row" data-act="f-open" data-id="' + n.id + '">' +
        '<span class="fg-note-main"><span class="fg-note-t">' + esc(n.fields.business_name) + "</span>" +
        '<span class="fg-note-s">' + esc(n.fields.city + " · " + dateOf(n.fields.visit_date)) + (n.rpnId !== (field.identity && field.identity.rpnId) ? " · " + esc(n.rpnName) : "") + "</span></span>" +
        statusPill(n) + "</button>").join("");
    return (
      '<h1 class="fg-h1" tabindex="-1">Field</h1>' +
      '<p class="fg-lead">Notes for the vendors you visit. They save on this phone first and go to the Console when you\'re online and signed in.</p>' +
      identityHtml() +
      (offline ? '<p class="fg-offline-note" role="status">Offline: new notes wait on this phone.</p>' : "") +
      obListBlockHtml() +
      '<h2 class="fg-sec">Onboarding notes</h2>' +
      '<button type="button" class="btn btn-outline fg-newnote" data-act="f-new"' + (field.identity ? "" : " disabled") + ">+ New onboarding note</button>" +
      (rows ? '<div class="fg-notes">' + rows + "</div>" : '<p class="muted">No notes yet.</p>') +
      '<h2 class="fg-sec">Coming later</h2>' +
      '<div class="card fg-tile"><div class="fg-tile-ic">' + ICONS.tasks + '</div><div class="fg-tile-body"><div class="fg-tile-title">Support tasks</div><div class="fg-tile-sub">Log support work and follow-ups.</div></div><span class="pill fg-pill-grey">Soon</span></div>'
    );
  }

  // ---------------- form ----------------
  function fieldInputHtml(def) {
    const id = "fgNote-" + def.name;
    const value = (field.draft && field.draft[def.name]) || "";
    const err = field.errors[def.name];
    const aria = ' aria-invalid="' + (err ? "true" : "false") + '" aria-describedby="' + id + "-help" + (err ? " " + id + "-err" : "") + '"';
    const common = ' id="' + id + '" name="' + def.name + '" data-act="note-field"' + (def.required ? " required" : "") + aria;
    let control;
    if (def.type === "textarea") {
      control = '<textarea class="field fg-ta"' + common + ' rows="4" maxlength="' + def.max + '">' + esc(value) + "</textarea>";
    } else if (def.type === "choice") {
      control = '<select class="field"' + common + ">" + def.options.map(([v, l]) => '<option value="' + v + '"' + (v === value ? " selected" : "") + ">" + esc(l) + "</option>").join("") + "</select>";
    } else if (def.type === "date") {
      control = '<input class="field" type="date"' + common + ' value="' + esc(value) + '" max="' + localDateKey(fieldNow()) + '">';
    } else if (def.type === "number") {
      control = '<input class="field" type="text" inputmode="numeric" autocomplete="off"' + common + ' value="' + esc(value) + '">';
    } else {
      control = '<input class="field" type="' + (def.type === "tel" ? "tel" : "text") + '"' + common + ' value="' + esc(value) + '"' + (def.max ? ' maxlength="' + def.max + '"' : "") +
        (def.name === "phone" ? ' autocomplete="tel" inputmode="tel"' : ' autocomplete="off"') + ">";
    }
    return '<div class="fg-fld' + (err ? " is-invalid" : "") + '">' +
      '<label class="fg-label" for="' + id + '">' + esc(def.label) + (def.required ? ' <span class="fg-req">required</span>' : "") + "</label>" +
      control +
      '<p class="fg-help" id="' + id + '-help">' + esc(def.hint || "") + "</p>" +
      (err ? '<p class="fg-err" id="' + id + '-err">' + esc(err) + "</p>" : "") + "</div>";
  }
  function fieldFormHtml() {
    if (!field.identity) return fieldListHtml();
    if (!field.draft) field.draft = emptyNoteFields(fieldNow());
    const errorCount = Object.keys(field.errors).length;
    return (
      '<div class="fg-subhead"><button type="button" class="fg-back" data-act="f-back">‹ Field</button></div>' +
      '<h1 class="fg-h1" tabindex="-1">New onboarding note</h1>' +
      '<p class="fg-lead">For a vendor you\'ve just visited. Saved on this phone; sent to the Console as <strong>' + esc(field.identity.name) + "</strong>.</p>" +
      (errorCount ? '<div class="fg-warn fg-errsum" role="alert">Check ' + (errorCount === 1 ? "the field" : "the " + errorCount + " fields") + " marked below.</div>" : "") +
      '<form class="fg-noteform" data-act="f-save" novalidate>' +
        NOTE_FIELDS.slice(0, 6).map(fieldInputHtml).join("") +
        '<h2 class="fg-sec">About the business</h2>' +
        NOTE_FIELDS.slice(6).map(fieldInputHtml).join("") +
        '<div class="fg-formbtns"><button type="button" class="btn btn-outline" data-act="f-clear">Clear form</button>' +
        '<button type="submit" class="btn btn-primary">Save on phone</button></div>' +
      "</form>"
    );
  }

  // ---------------- one note ----------------
  function fieldNoteHtml(id) {
    const n = field.notes.find((x) => x.id === id);
    if (!n) return fieldListHtml();
    const s = noteStatus(n);
    let status = "";
    if (s === "sent") status = "Sent to the Console at " + timeOf(n.sentAt) + ".";
    else if (s === "saved") status = typeof navigator !== "undefined" && navigator.onLine === false ? "Waiting for internet." : "Waiting to send.";
    else if (s === "sending") status = "Sending now…";
    else if (s === "signin") status = field.identity && field.identity.rpnId !== n.rpnId ? "Sign in as " + n.rpnName + " to send this note." : "Sign in to send this note.";
    else {
      const reason = /[.!?]$/.test(n.lastError) ? n.lastError : n.lastError + ".";
      status = reason + (n.permanent ? " It won't be sent again until you tap Retry." : n.nextAttemptAt ? " Trying again at " + timeOf(n.nextAttemptAt) + "." : "");
    }
    const rows = NOTE_FIELDS.filter((d) => n.fields[d.name]).map((d) => {
      let v = n.fields[d.name];
      if (d.type === "choice") v = (d.options.find((o) => o[0] === v) || [v, v])[1];
      if (d.type === "date") v = dateOf(v);
      return '<div class="fg-row"><dt>' + esc(d.label) + "</dt><dd>" + esc(v) + "</dd></div>";
    }).join("");
    return (
      '<div class="fg-subhead"><button type="button" class="fg-back" data-act="f-back">‹ Field</button>' + statusPill(n) + "</div>" +
      '<h1 class="fg-h1" tabindex="-1">' + esc(n.fields.business_name) + "</h1>" +
      '<div class="card fg-status fg-status-' + s + '" role="status"><p>' + esc(status) + "</p>" +
        (s === "failed" ? '<button type="button" class="btn btn-primary btn-sm" data-act="f-retry" data-id="' + n.id + '">Retry now</button>' : "") +
        (s === "signin" ? '<button type="button" class="btn btn-primary btn-sm" data-act="f-go-me">Sign in</button>' : "") +
      "</div>" +
      '<div class="card"><dl class="fg-rows fg-rows-wide">' + rows + "</dl></div>" +
      '<p class="muted">Saved ' + esc(new Date(n.savedAt).toLocaleString()) + " by " + esc(n.rpnName) + ". A sent note can't be changed; Digital Commerce adds the vendor to the Vendors Register from it.</p>"
    );
  }

  function fieldScreen(sub) {
    if (!field.loaded) return '<h1 class="fg-h1" tabindex="-1">Field</h1><p class="fg-lead">Loading…</p>';
    if (sub[0] === "new") return fieldFormHtml();
    if (sub[0] === "note") return fieldNoteHtml(sub[1]);
    if (sub[0] === "ob") return obScreen(sub.slice(1));
    return fieldListHtml();
  }

  // ---------------- Me: sign-in ----------------
  const SIGNIN_ERRORS = {
    invalid: "That name and passcode don't match an RPN account.",
    not_rpn: "That isn't an RPN account. The Field Guide is for RPNs.",
    network: "Can't reach the Console. Check the connection and try again.",
    server: "The Console had a problem. Try again in a moment.",
  };
  function signInCardHtml() {
    if (!field.loaded) return "";
    const now = fieldNow();
    if (sessionValid(field.session, now)) {
      return '<div class="card" id="fgSignin"><h2 class="fg-card-title">Console sign-in</h2>' +
        '<p style="margin:0 0 10px">Signed in as <strong>' + esc(field.session.name) + "</strong> until " + esc(timeOf(field.session.exp)) + ".</p>" +
        '<button type="button" class="btn btn-outline btn-sm" data-act="f-signout">Sign out</button></div>';
    }
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const err = field.signin.error ? SIGNIN_ERRORS[field.signin.error] || SIGNIN_ERRORS.server : "";
    return '<div class="card" id="fgSignin"><h2 class="fg-card-title">Console sign-in</h2>' +
      '<p class="muted" style="margin:0 0 8px">' + (field.identity ? "Your sign-in has ended. Sign in again to send notes." : "Your RPN name and passcode for the Commerce Lite Console. Needed to send onboarding notes; it lasts 12 hours.") + "</p>" +
      '<form data-act="f-signin" novalidate>' +
        '<label class="fg-label" for="fgSigninName">Name</label>' +
        '<input class="field" id="fgSigninName" name="name" autocomplete="username" value="' + esc(field.signin.name || (field.identity ? field.identity.name : "")) + '" required>' +
        '<label class="fg-label" for="fgSigninPass">Passcode</label>' +
        '<input class="field" id="fgSigninPass" name="passcode" type="password" autocomplete="current-password" required>' +
        (err ? '<p class="fg-err" role="alert">' + esc(err) + "</p>" : "") +
        '<p class="fg-help" id="fgSigninOffline"' + (offline ? "" : " hidden") + ">Signing in needs internet.</p>" +
        '<button type="submit" class="btn btn-primary" style="margin-top:12px"' + (field.signin.busy || offline ? " disabled" : "") + ">" + (field.signin.busy ? "Signing in…" : "Sign in") + "</button>" +
      "</form></div>";
  }

  // ---------------- events ----------------
  async function fieldAction(act, el) {
    switch (act) {
      case "f-go-me": location.hash = "#/me"; return;
      case "f-new": location.hash = "#/field/new"; return;
      case "f-back": location.hash = "#/field"; return;
      case "f-open": location.hash = "#/field/note/" + el.dataset.id; return;
      case "f-retry": await retryNote(el.dataset.id); render(false); return;
      case "f-clear": {
        const ok = await fgDialog({ title: "Clear the form?", text: "Everything typed into this note is removed. Notes already saved are not affected.", okLabel: "Clear", danger: true });
        if (!ok) return;
        field.draft = emptyNoteFields(fieldNow());
        field.errors = {};
        await storeDelete("meta", "noteDraft");
        render(false);
        return;
      }
      case "f-signout": {
        const waiting = field.notes.filter((n) => n.status !== "sent").length;
        const ok = await fgDialog({
          title: "Sign out?",
          text: waiting ? waiting + " note" + (waiting === 1 ? " is" : "s are") + " not sent yet. They stay on this phone and go when you sign in again." : "You can sign in again any time.",
          okLabel: "Sign out",
        });
        if (!ok) return;
        await signOut();
        render(false);
        return;
      }
    }
  }
  async function fieldSubmit(act, form) {
    if (act === "f-signin") {
      const name = form.elements.name.value.trim();
      const passcode = form.elements.passcode.value;
      if (!name || !passcode) { (name ? form.elements.passcode : form.elements.name).focus(); return; }
      field.signin = { busy: true, error: "", name };
      render(false);
      const r = await signIn(name, passcode);
      field.signin.name = name; // the redrawn form keeps the name typed
      render(false);
      if (!r.ok) { const p = document.getElementById("fgSigninPass"); if (p) p.focus(); }
      return;
    }
    if (act === "f-save") {
      const { fields, errors } = validateNote(field.draft || {}, fieldNow());
      field.errors = errors;
      if (Object.keys(errors).length) {
        render(false);
        const first = NOTE_FIELDS.find((d) => errors[d.name]);
        const el = document.getElementById("fgNote-" + first.name);
        if (el) { el.focus(); el.scrollIntoView({ block: "center" }); }
        return;
      }
      await saveNote(fields);
      field.draft = null;
      field.errors = {};
      clearTimeout(draftTimer);
      await storeDelete("meta", "noteDraft");
      location.hash = "#/field";
    }
  }
  function fieldInput(el) {
    if (el.dataset.act !== "note-field") return;
    if (!field.draft) field.draft = emptyNoteFields(fieldNow());
    field.draft[el.name] = el.value;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { storePut("meta", { key: "noteDraft", value: field.draft }).catch(() => {}); }, DRAFT_SAVE_MS);
  }
