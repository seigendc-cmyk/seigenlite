  // ================== RPN Field Guide — full vendor onboarding (screens) ==================
  // Screens, under the Field tab:
  //   #/field                    "Vendor onboarding" block (fieldListHtml calls obListBlockHtml)
  //   #/field/ob/new             start: blank, or from one of the RPN's onboarding notes
  //   #/field/ob/<id>            the record: status, the four sections, Submit
  //   #/field/ob/<id>/<section>  one section's form (vendor | installation | implementation | training)
  //
  // Buttons carry data-act "o-…" (app.js sends clicks and submits here:
  // obAction / obSubmitForm); every input carries data-act "ob-field" with
  // data-sec and data-path (app.js sends typing here: obInput). Values go
  // straight into the record (onboarding.js obSetValue), so going offline or
  // online, a status change, or leaving the form never loses them.

  const OB_PILL = {
    sending: "fg-pill-grey", saved: "fg-pill-grey", sent: "fg-pill-grey", signin: "fg-pill-warn", failed: "low",
    submitted: "fg-pill-warn", returned: "low", approved: "ok", rejected: "low",
  };
  const OB_PROGRESS = { none: ["Not started", "fg-pill-grey"], progress: ["In progress", "fg-pill-warn"], done: ["Done", "ok"] };

  function obPillHtml(rec) {
    const s = obStatus(rec);
    return '<span class="pill ' + OB_PILL[s.key] + '">' + esc(s.text) + "</span>";
  }
  function obTitle(rec) {
    const n = (rec.data.vendor.business_name || "").replace(/\s+/g, " ").trim();
    return n || "New vendor";
  }

  // ---------------- the block on the Field list ----------------
  function obListBlockHtml() {
    if (!ob.loaded) return "";
    const rows = ob.records.map((r) => {
      const v = r.data.vendor;
      const done = OB_SECTIONS.filter((s) => obSectionProgress(r, s.key, fieldNow()) === "done").length;
      const sub = [v.city, done + " of 4 sections done"].filter(Boolean).join(" · ") +
        (r.rpnId !== (field.identity && field.identity.rpnId) ? " · " + r.rpnName : "");
      return '<button type="button" class="fg-note-row" data-act="o-open" data-id="' + r.id + '">' +
        '<span class="fg-note-main"><span class="fg-note-t">' + esc(obTitle(r)) + '</span><span class="fg-note-s">' + esc(sub) + "</span></span>" +
        obPillHtml(r) + "</button>";
    }).join("");
    return (
      '<h2 class="fg-sec">Vendor onboarding</h2>' +
      '<p class="muted fg-ob-intro">The full record of onboarding a vendor: installation, implementation, training and handover. Sent to the office to verify.</p>' +
      '<button type="button" class="btn btn-primary fg-newnote" data-act="o-new"' + (field.identity ? "" : " disabled") + ">+ Start vendor onboarding</button>" +
      (rows ? '<div class="fg-notes fg-ob-list">' + rows + "</div>" : '<p class="muted">No vendor onboardings yet.</p>')
    );
  }

  // ---------------- start ----------------
  function obStartHtml() {
    if (!field.identity) return fieldListHtml();
    const mine = field.notes.filter((n) => n.rpnId === field.identity.rpnId);
    const used = new Set(ob.records.map((r) => r.noteId).filter(Boolean));
    const rows = mine.map((n) =>
      '<button type="button" class="fg-note-row" data-act="o-start" data-note="' + n.id + '"' + (used.has(n.id) ? ' aria-describedby="fgObUsed"' : "") + ">" +
        '<span class="fg-note-main"><span class="fg-note-t">' + esc(n.fields.business_name) + '</span><span class="fg-note-s">' +
        esc(n.fields.city + " · " + dateOf(n.fields.visit_date) + (used.has(n.id) ? " · already used" : "")) + "</span></span></button>").join("");
    return (
      '<div class="fg-subhead"><button type="button" class="fg-back" data-act="f-back">‹ Field</button></div>' +
      '<h1 class="fg-h1" tabindex="-1">Start vendor onboarding</h1>' +
      '<p class="fg-lead">Start from one of your onboarding notes, so the vendor\'s details are filled in, or start blank.</p>' +
      '<button type="button" class="btn btn-outline fg-ob-blank" data-act="o-start">Start blank</button>' +
      '<h2 class="fg-sec">From an onboarding note</h2>' +
      (rows ? '<div class="fg-notes">' + rows + "</div>" + '<p class="muted" id="fgObUsed">Only a note already sent to the Console is linked to the onboarding; the details of the others are copied.</p>'
            : '<p class="muted">You have no onboarding notes on this phone.</p>')
    );
  }

  // ---------------- one record ----------------
  function obStatusText(rec) {
    const s = obStatus(rec).key;
    const now = fieldNow();
    if (s === "approved") return "The office verified this onboarding" + (rec.verifiedAt ? " on " + new Date(rec.verifiedAt).toLocaleDateString() : "") + ".";
    if (s === "rejected") return "The office rejected this onboarding." + (rec.officeReason ? " Reason: " + rec.officeReason : "");
    if (s === "returned") return "The office returned this to you: " + (rec.officeReason || "no reason given") + ". Fix it and submit again.";
    if (s === "submitted") return "Submitted. Waiting for the office to verify it.";
    if (s === "sent") return "Your draft is with the Console. Finish all four sections, then submit.";
    if (s === "sending") return "Sending now…";
    if (s === "signin") return field.identity && field.identity.rpnId !== rec.rpnId ? "Sign in as " + rec.rpnName + " to send this." : "Sign in to send this.";
    if (s === "failed") {
      const reason = /[.!?]$/.test(rec.lastError) ? rec.lastError : rec.lastError + ".";
      return reason + (rec.permanent ? " It won't be sent again until you tap Retry." : rec.nextAttemptAt ? " Trying again at " + timeOf(rec.nextAttemptAt) + "." : "");
    }
    if (!obCanSendDraft(rec, now)) return "Saved on this phone. It is sent once the business name, owner, phone and city are filled in.";
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "Saved on this phone. Waiting for internet.";
    return rec.submitRequested ? "Submit saved on this phone. Waiting to send." : "Saved on this phone. Waiting to send.";
  }
  function obRecordHtml(id) {
    const rec = ob.records.find((r) => r.id === id);
    if (!rec) return fieldListHtml();
    const now = fieldNow();
    const s = obStatus(rec).key;
    const editable = obEditable(rec);
    const cardClass = { approved: "sent", sent: "sent", failed: "failed", rejected: "failed", returned: "failed", signin: "signin", submitted: "signin" }[s] || "saved";
    const secRows = OB_SECTIONS.map((sec) => {
      const p = OB_PROGRESS[obSectionProgress(rec, sec.key, now)];
      return '<button type="button" class="fg-note-row" data-act="o-sec" data-id="' + rec.id + '" data-sec="' + sec.key + '">' +
        '<span class="fg-ob-n" aria-hidden="true">' + sec.n + "</span>" +
        '<span class="fg-note-main"><span class="fg-note-t">' + esc(sec.title) + '</span><span class="fg-note-s">' + esc(sec.sub) + "</span></span>" +
        '<span class="pill ' + p[1] + '">' + p[0] + "</span></button>";
    }).join("");
    const allDone = obAllDone(rec, now);
    const remaining = OB_SECTIONS.filter((sec) => obSectionProgress(rec, sec.key, now) !== "done").length;
    let submitBlock = "";
    if (editable) {
      submitBlock = '<div class="card fg-ob-submit"><h2 class="fg-card-title">Send for office verification</h2>' +
        '<p class="muted">' + (allDone ? "All four sections are done. Once submitted, you can't change it unless the office returns it." : remaining + " section" + (remaining === 1 ? " is" : "s are") + " not done yet.") + "</p>" +
        '<button type="button" class="btn btn-primary" data-act="o-submit" data-id="' + rec.id + '"' + (allDone ? "" : " disabled") + ">Submit for verification</button></div>";
    }
    return (
      '<div class="fg-subhead"><button type="button" class="fg-back" data-act="f-back">‹ Field</button>' + obPillHtml(rec) + "</div>" +
      '<h1 class="fg-h1" tabindex="-1">' + esc(obTitle(rec)) + "</h1>" +
      '<div class="card fg-status fg-status-' + cardClass + '" role="status"><p>' + esc(obStatusText(rec)) + "</p>" +
        (s === "failed" ? '<button type="button" class="btn btn-primary btn-sm" data-act="o-retry" data-id="' + rec.id + '">Retry now</button>' : "") +
        (s === "signin" ? '<button type="button" class="btn btn-primary btn-sm" data-act="f-go-me">Sign in</button>' : "") +
      "</div>" +
      '<h2 class="fg-sec">Sections</h2><div class="fg-notes">' + secRows + "</div>" +
      submitBlock +
      '<p class="muted">Started ' + esc(new Date(rec.createdAt).toLocaleString()) + " by " + esc(rec.rpnName) + "." +
        (rec.noteId ? " Linked to your onboarding note." : "") + "</p>"
    );
  }

  // ---------------- one section ----------------
  function obInputHtml(rec, secKey, f, values, path, errors, locked) {
    const id = "fgOb-" + secKey + "-" + path.replace(/\./g, "-");
    const raw = values[f.name];
    const err = errors[path];
    const req = isReq(f, values);
    const aria = ' aria-invalid="' + (err ? "true" : "false") + '" aria-describedby="' + id + "-help" + (err ? " " + id + "-err" : "") + '"';
    const common = ' id="' + id + '" name="' + esc(path) + '" data-act="ob-field" data-sec="' + secKey + '" data-path="' + esc(path) + '"' + (req ? " required" : "") + aria + (locked ? " disabled" : "");
    const value = raw == null ? "" : String(raw);
    let control;
    if (f.type === "check") {
      return '<div class="fg-fld fg-ob-check' + (err ? " is-invalid" : "") + '">' +
        '<label for="' + id + '"><input type="checkbox"' + common + (raw === true ? " checked" : "") + "><span>" + esc(f.label) + "</span></label>" +
        '<p class="fg-help" id="' + id + '-help"></p>' +
        (err ? '<p class="fg-err" id="' + id + '-err">' + esc(err) + "</p>" : "") + "</div>";
    }
    if (f.type === "textarea") {
      control = '<textarea class="field fg-ta"' + common + ' rows="' + (f.rows || 3) + '" maxlength="' + f.max + '">' + esc(value) + "</textarea>";
    } else if (f.type === "choice") {
      control = '<select class="field"' + common + ">" + f.options.map(([v, l]) => '<option value="' + v + '"' + (v === value ? " selected" : "") + ">" + esc(l) + "</option>").join("") + "</select>";
    } else if (f.type === "date") {
      control = '<input class="field" type="date"' + common + ' value="' + esc(value) + '"' + (f.future ? "" : ' max="' + localDateKey(fieldNow()) + '"') + ">";
    } else if (f.type === "number" || f.type === "money") {
      control = '<input class="field" type="text" inputmode="' + (f.type === "money" ? "decimal" : "numeric") + '" autocomplete="off"' + common + ' value="' + esc(value) + '">';
    } else {
      control = '<input class="field" type="' + (f.type === "tel" ? "tel" : "text") + '"' + common + ' value="' + esc(value) + '"' + (f.max ? ' maxlength="' + f.max + '"' : "") +
        (f.type === "tel" ? ' autocomplete="tel" inputmode="tel"' : ' autocomplete="off"') + ">";
    }
    return '<div class="fg-fld' + (err ? " is-invalid" : "") + '">' +
      '<label class="fg-label" for="' + id + '">' + esc(f.label) + (req ? ' <span class="fg-req">required</span>' : "") + "</label>" +
      control +
      '<p class="fg-help" id="' + id + '-help">' + esc(f.hint || "") + "</p>" +
      (err ? '<p class="fg-err" id="' + id + '-err">' + esc(err) + "</p>" : "") + "</div>";
  }
  function obListHtml(rec, secKey, f, d, errors, locked) {
    const items = d[f.name] || [];
    const body = items.map((it, i) =>
      '<fieldset class="card fg-ob-item"><legend>' + esc(f.item + " " + (i + 1)) + "</legend>" +
        f.fields.filter((sf) => isShown(sf, it)).map((sf) => obInputHtml(rec, secKey, sf, it, f.name + "." + i + "." + sf.name, errors, locked)).join("") +
        (!locked && items.length > (f.min || 0) ? '<button type="button" class="btn btn-outline btn-sm fg-ob-remove" data-act="o-remove" data-list="' + f.name + '" data-index="' + i + '">Remove ' + esc(f.item.toLowerCase() + " " + (i + 1)) + "</button>" : "") +
      "</fieldset>").join("");
    const err = errors[f.name];
    return '<h2 class="fg-sec">' + esc(f.label) + "</h2>" + body +
      (err ? '<p class="fg-err" id="fgOb-' + secKey + "-" + f.name + '-err">' + esc(err) + "</p>" : "") +
      (!locked && items.length < f.maxItems ? '<button type="button" class="btn btn-outline fg-ob-add" data-act="o-add" data-list="' + f.name + '">+ Add ' + esc(f.item.toLowerCase()) + "</button>" : "");
  }
  function obModulesHtml(rec, secKey, f, d, errors, locked) {
    const m = d[f.name] || {};
    const err = errors[f.name];
    return '<h2 class="fg-sec">' + esc(f.label) + "</h2>" +
      '<div class="card fg-ob-modules">' + OB_MODULES.map(([k, label]) => {
        const id = "fgOb-" + secKey + "-modules-" + k;
        return '<div class="fg-ob-mod"><label for="' + id + '">' + esc(label) + "</label>" +
          '<select class="field" id="' + id + '" data-act="ob-field" data-sec="' + secKey + '" data-path="modules.' + k + '"' + (locked ? " disabled" : "") + ">" +
          OB_LEVELS.map(([v, l]) => '<option value="' + v + '"' + (v === (m[k] || "") ? " selected" : "") + ">" + esc(l) + "</option>").join("") + "</select></div>";
      }).join("") + "</div>" +
      (err ? '<p class="fg-err" id="fgOb-' + secKey + '-modules-err">' + esc(err) + "</p>" : "");
  }
  function obSectionHtml(id, secKey) {
    const rec = ob.records.find((r) => r.id === id);
    const sec = OB_SECTION_BY_KEY[secKey];
    if (!rec || !sec) return fieldListHtml();
    const now = fieldNow();
    const d = rec.data[secKey];
    const locked = !obEditable(rec);
    const check = obCheckSection(secKey, d, now);
    const errors = ob.showErrors[rec.id + ":" + secKey] && !locked ? check.errors : {};
    const errorCount = Object.keys(errors).length;
    let lastGroup = null;
    const body = sec.fields.map((f) => {
      if (f.type === "list") return obListHtml(rec, secKey, f, d, errors, locked);
      if (f.type === "modules") return obModulesHtml(rec, secKey, f, d, errors, locked);
      if (!isShown(f, d)) return "";
      let head = "";
      if (f.group && f.group !== lastGroup) { head = '<h2 class="fg-sec">' + esc(f.group) + "</h2>"; lastGroup = f.group; }
      return head + obInputHtml(rec, secKey, f, d, f.name, errors, locked);
    }).join("");
    const next = OB_SECTIONS[sec.n] || null;
    return (
      '<div class="fg-subhead"><button type="button" class="fg-back" data-act="o-open" data-id="' + rec.id + '">‹ ' + esc(obTitle(rec)) + "</button>" +
        '<span class="pill ' + OB_PROGRESS[obSectionProgress(rec, secKey, now)][1] + '">' + OB_PROGRESS[obSectionProgress(rec, secKey, now)][0] + "</span></div>" +
      '<h1 class="fg-h1" tabindex="-1">' + sec.n + ". " + esc(sec.title) + "</h1>" +
      '<p class="fg-lead">' + esc(sec.sub) + "</p>" +
      (locked ? '<div class="fg-warn" role="status">This onboarding has been submitted, so it can\'t be changed here.</div>' : "") +
      (errorCount ? '<div class="fg-warn fg-errsum" role="alert">Check ' + (errorCount === 1 ? "the field" : "the " + errorCount + " fields") + " marked below.</div>" : "") +
      '<form class="fg-noteform fg-ob-form" data-act="o-save" data-id="' + rec.id + '" data-sec="' + secKey + '" novalidate>' +
        body +
        (locked ? "" : '<div class="fg-formbtns"><button type="submit" class="btn btn-primary">' + (next ? "Save and continue" : "Save section") + "</button></div>") +
      "</form>"
    );
  }

  function obScreen(sub) {
    if (!ob.loaded) return '<h1 class="fg-h1" tabindex="-1">Field</h1><p class="fg-lead">Loading…</p>';
    if (sub[0] === "new") return obStartHtml();
    if (sub[1]) return obSectionHtml(sub[0], sub[1]);
    return obRecordHtml(sub[0]);
  }

  // ---------------- events ----------------
  function obCurrent() {
    const sub = state.sub;
    return sub[0] === "ob" ? ob.records.find((r) => r.id === sub[1]) : null;
  }
  // Redraw the section after a change that shows or hides fields, keeping
  // the focus where it was.
  function obRedrawKeepFocus() {
    const active = document.activeElement;
    const id = active && active.id;
    const y = window.scrollY;
    render(false);
    window.scrollTo(0, y);
    if (id) { const el = document.getElementById(id); if (el) el.focus({ preventScroll: true }); }
  }
  async function obAction(act, el) {
    switch (act) {
      case "o-new": location.hash = "#/field/ob/new"; return;
      case "o-start": {
        if (!field.identity) return;
        const rec = await obCreate(el.dataset.note || null);
        location.hash = "#/field/ob/" + rec.id + "/vendor";
        return;
      }
      case "o-open": await obFlush(); location.hash = "#/field/ob/" + el.dataset.id; kickOutbox(); return;
      case "o-sec": location.hash = "#/field/ob/" + el.dataset.id + "/" + el.dataset.sec; return;
      case "o-retry": await obRetry(el.dataset.id); render(false); return;
      case "o-add": case "o-remove": {
        const rec = obCurrent();
        if (!rec) return;
        if (act === "o-add") {
          await obAddItem(rec, state.sub[2], el.dataset.list);
          render(false);
          const items = rec.data[state.sub[2]][el.dataset.list];
          const first = document.querySelector('[data-path^="' + el.dataset.list + "." + (items.length - 1) + '."]');
          if (first) { first.focus(); first.scrollIntoView({ block: "center" }); }
        } else {
          const ok = await fgDialog({ title: "Remove " + el.textContent.replace(/^Remove /, "") + "?", text: "What is typed in it is removed.", okLabel: "Remove", danger: true });
          if (!ok) return;
          await obRemoveItem(rec, state.sub[2], el.dataset.list, Number(el.dataset.index));
          obRedrawKeepFocus();
        }
        return;
      }
      case "o-submit": {
        const rec = ob.records.find((r) => r.id === el.dataset.id);
        if (!rec) return;
        const ok = await fgDialog({
          title: "Submit for verification?",
          text: "The office checks it with the vendor. You can't change it after this unless they return it to you.",
          okLabel: "Submit",
        });
        if (!ok) return;
        await obSubmit(rec);
        render(false);
        return;
      }
    }
  }
  async function obSubmitForm(act, form) {
    if (act !== "o-save") return;
    const rec = ob.records.find((r) => r.id === form.dataset.id);
    if (!rec || !obEditable(rec)) return;
    const secKey = form.dataset.sec;
    const check = await obSaveSection(rec, secKey);
    if (!check.complete) {
      render(false);
      const first = document.querySelector("#fgMain .is-invalid input, #fgMain .is-invalid select, #fgMain .is-invalid textarea") || document.querySelector("#fgMain .fg-err");
      if (first) { if (first.focus) first.focus(); first.scrollIntoView({ block: "center" }); }
      return;
    }
    const sec = OB_SECTION_BY_KEY[secKey];
    const next = OB_SECTIONS[sec.n];
    location.hash = "#/field/ob/" + rec.id + (next ? "/" + next.key : "");
  }
  function obInput(el) {
    const rec = obCurrent();
    if (!rec || el.dataset.sec !== state.sub[2]) return;
    const value = el.type === "checkbox" ? el.checked : el.value;
    obSetValue(rec, el.dataset.sec, el.dataset.path, value);
    // A choice can show or hide other fields: redraw (the typing is all in the record).
    if (el.tagName === "SELECT" || el.type === "checkbox") obRedrawKeepFocus();
  }
