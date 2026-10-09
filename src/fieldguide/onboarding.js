  // ================== RPN Field Guide — full vendor onboarding (model + sending) ==================
  // An onboarding record is the RPN's account of onboarding one vendor,
  // worked on over several visits:
  //   1 vendor & plan · 2 installation & activation · 3 implementation &
  //   stocktake · 4 training & handover (with the vendor's acceptance)
  // then sent for office verification (Section 5, done in the Console).
  //
  // Saved on the phone first (IndexedDB "records" store, store.js v3) and
  // sent with the RPN's own Console sign-in by the same outbox run as the
  // notes (outbox.js calls obPass), with the same backoff. The database side
  // is supabase/migrations/20261009160000_rpn_onboarding_records.sql:
  //   cl_rpn_save_onboarding  — create/update own draft, or submit it
  //   rpn_onboarding_records  — read own rows: the office's answer comes back
  //
  // A record, on the phone:
  //   {id, rpnId, rpnName, noteId, data:{vendor, installation, implementation, training},
  //    createdAt, savedAt (last change on the phone), sentSavedAt (the copy
  //    the Console has), submitRequested, serverStatus (draft | submitted |
  //    returned | approved | rejected | null), officeReason, verifiedAt,
  //    sync (pending | failed | signin), attempts, nextAttemptAt, permanent, lastError}
  //
  // It can be changed while it is a draft or returned, and not after the RPN
  // taps Submit (unless the Console refuses the submit, or the office
  // returns it).

  // ---------------- what the form asks ----------------
  const YES_NO = [["", "Choose…"], ["yes", "Yes"], ["no", "No"]];
  const OB_MODULES = [
    ["sell", "Sell (cart and receipts)"], ["products", "Products"], ["credit", "Credit (debtors)"],
    ["reports", "Reports"], ["reportwriter", "Report Writer"], ["stocktake", "Stocktake"],
    ["purchasing", "Purchasing"], ["requests", "Requests"], ["directory", "Directory"],
    ["staff", "Staff and PINs"], ["shift", "Shift, float and EOD"], ["printing", "Printing"],
    ["whatsapp", "WhatsApp sharing"], ["backup", "Backup and merge"], ["marketing", "Marketing"],
  ];
  const OB_LEVELS = [["", "Not covered"], ["needs_help", "Needs help"], ["ok", "OK"], ["confident", "Confident"]];

  // type: text | tel | number | money | date | choice | check | textarea | list | modules
  // req: true, or a function of the section's values (required only then)
  // show: a function of the section's values (hidden, and not checked, otherwise)
  const OB_SECTIONS = [
    {
      key: "vendor", n: 1, title: "Vendor & plan", sub: "Who the vendor is and what they are paying for.",
      fields: [
        { name: "business_name", label: "Business name", req: true, max: 120 },
        { name: "owner_name", label: "Owner's name", req: true, max: 120 },
        { name: "phone", label: "Phone (WhatsApp)", req: true, type: "tel", hint: "e.g. 0771 234 567" },
        { name: "city", label: "City or town", req: true, max: 80 },
        { name: "location", label: "Area or street", max: 200 },
        { name: "business_type", label: "Type of business", max: 80, hint: "e.g. grocery, hardware, salon" },
        { name: "plan", label: "Plan", req: true, type: "choice", options: [["", "Choose…"], ["business", "Business (retail or wholesale)"], ["lite", "Lite (flea market, tuckshop, canteen)"]], hint: "Lite is for one branch only." },
        { name: "branches", label: "Branches", req: true, type: "number", min: 1, max: 200 },
        { name: "tills", label: "Tills in total (all branches)", req: true, type: "number", min: 1, max: 1000 },
        { name: "features_taken", label: "Features taken", req: true, type: "textarea", max: 1000, rows: 3, hint: "Branches, tills and add-ons the vendor is taking." },
        { name: "subscription_amount", label: "Monthly subscription (USD)", req: true, type: "money", max: 100000, hint: "The amount for the features above. The office confirms it." },
        { name: "first_visit_date", label: "Date of first visit", req: true, type: "date" },
      ],
    },
    {
      key: "installation", n: 2, title: "Installation & activation", sub: "Every device set up, the secret phrase, activation and the printer.",
      fields: [
        {
          name: "devices", label: "Devices", type: "list", item: "Device", min: 1, maxItems: 30, req: true,
          fields: [
            { name: "device_type", label: "Device", req: true, type: "choice", options: [["", "Choose…"], ["phone", "Phone"], ["laptop", "Laptop"], ["desktop", "Desktop computer"]] },
            { name: "install_type", label: "Installed as", req: true, type: "choice", options: [["", "Choose…"], ["pwa", "Installed web app"], ["desktop", "Desktop app"]] },
            { name: "branch", label: "Branch", req: true, max: 80 },
            { name: "till", label: "Till", max: 40, hint: "e.g. Till 2" },
            { name: "result", label: "Result", req: true, type: "choice", options: [["", "Choose…"], ["installed", "Installed and working"], ["failed", "Failed"]] },
            { name: "failure_reason", label: "What went wrong", max: 200, req: (d) => d.result === "failed", show: (d) => d.result === "failed" },
          ],
        },
        { name: "secret_phrase_set", label: "Secret phrase set by the vendor", req: true, type: "choice", options: YES_NO, hint: "Never write the phrase itself here." },
        { name: "join_codes_used", label: "Extra devices joined with a branch join code", req: true, type: "choice", options: [["", "Choose…"], ["yes", "Yes"], ["no", "No"], ["na", "Only one device"]] },
        { name: "activation_requested", label: "Activation requested", req: true, type: "choice", options: YES_NO, hint: "Never write the activation code here." },
        { name: "activation_date", label: "Date activation was requested", type: "date", req: (d) => d.activation_requested === "yes", show: (d) => d.activation_requested === "yes" },
        { name: "printer", label: "Printer", req: true, type: "choice", options: [["", "Choose…"], ["none", "No printer"], ["usb", "USB thermal printer"], ["bluetooth", "Bluetooth thermal printer"]] },
        { name: "test_print", label: "Test print worked", type: "choice", options: YES_NO, req: (d) => d.printer === "usb" || d.printer === "bluetooth", show: (d) => d.printer === "usb" || d.printer === "bluetooth" },
        { name: "install_issues", label: "Problems during installation", type: "textarea", max: 1000 },
      ],
    },
    {
      key: "implementation", n: 3, title: "Implementation & stocktake", sub: "Products, the first stocktake, staff and the first day.",
      fields: [
        { name: "product_source", label: "How products were loaded", req: true, type: "choice", options: [["", "Choose…"], ["excel", "Excel import"], ["manual", "Typed in"], ["stocktake", "Counted in a stocktake"]] },
        { name: "products_loaded", label: "Products loaded", req: true, type: "number", min: 0, max: 1000000 },
        { name: "import_issues", label: "Problems loading products", type: "textarea", max: 1000 },
        { name: "stocktake_done", label: "Initial stocktake done", req: true, type: "choice", options: YES_NO },
        { name: "stocktake_date", label: "Stocktake date", type: "date", req: (d) => d.stocktake_done === "yes", show: (d) => d.stocktake_done === "yes" },
        { name: "stocktake_lines", label: "Lines counted", type: "number", min: 0, max: 1000000, req: (d) => d.stocktake_done === "yes", show: (d) => d.stocktake_done === "yes" },
        { name: "variance_notes", label: "Variances found", type: "textarea", max: 1000, show: (d) => d.stocktake_done === "yes" },
        { name: "staff_count", label: "Staff set up", req: true, type: "number", min: 0, max: 500 },
        { name: "single_operator", label: "Single operator mode on (no staff PINs)", req: true, type: "choice", options: YES_NO },
        { name: "first_shift_eod", label: "First shift opened with a float and closed with EOD", req: true, type: "choice", options: YES_NO },
        { name: "backup_explained", label: "Backup and merge explained", req: true, type: "choice", options: YES_NO },
        { name: "debtor_balances", label: "Debtors' opening balances", req: true, type: "choice", options: [["", "Choose…"], ["yes", "Captured"], ["no", "Not yet"], ["none", "No debtors"]] },
      ],
    },
    {
      key: "training", n: 4, title: "Training & handover", sub: "Who was trained on what, and the vendor's acceptance.",
      fields: [
        {
          name: "sessions", label: "Training sessions", type: "list", item: "Session", min: 1, maxItems: 30, req: true,
          fields: [
            { name: "date", label: "Date", req: true, type: "date" },
            { name: "duration_min", label: "Minutes", req: true, type: "number", min: 1, max: 600 },
            { name: "staff_names", label: "Staff trained", req: true, max: 200, hint: "Names, separated by commas." },
          ],
        },
        { name: "modules", label: "What was covered, and how confident they are", type: "modules", req: true },
        { name: "support_contacts_given", label: "Support contacts given to the vendor", req: true, type: "choice", options: YES_NO },
        { name: "outstanding", label: "Still to do", type: "textarea", max: 1000 },
        { name: "follow_up_date", label: "Follow-up visit", type: "date", future: true },
        { name: "vendor_full_name", label: "Vendor's full name", req: true, max: 120, group: "Vendor acceptance" },
        { name: "vendor_confirms", label: "The vendor confirms the system was installed and their staff were trained.", req: true, type: "check" },
        { name: "acceptance_date", label: "Date of acceptance", req: true, type: "date" },
        { name: "rpn_declares", label: "I declare this onboarding record is true and complete.", req: true, type: "check", group: "Your declaration" },
      ],
    },
  ];
  const OB_SECTION_BY_KEY = {};
  for (const s of OB_SECTIONS) OB_SECTION_BY_KEY[s.key] = s;

  function obEmptySection(sec, now) {
    const d = {};
    for (const f of sec.fields) {
      if (f.type === "list") d[f.name] = [obEmptyItem(f, now)];
      else if (f.type === "modules") d[f.name] = {};
      else if (f.type === "check") d[f.name] = false;
      else d[f.name] = "";
    }
    if (sec.key === "vendor") d.first_visit_date = localDateKey(now);
    return d;
  }
  function obEmptyItem(listDef, now) {
    const it = {};
    for (const f of listDef.fields) it[f.name] = f.type === "date" ? localDateKey(now) : "";
    return it;
  }
  function obEmptyData(now) {
    const data = {};
    for (const s of OB_SECTIONS) data[s.key] = obEmptySection(s, now);
    return data;
  }

  // ---------------- checks ----------------
  const isReq = (f, d) => (typeof f.req === "function" ? !!f.req(d) : !!f.req);
  const isShown = (f, d) => (f.show ? !!f.show(d) : true);
  const blank = (v) => v == null || String(v).trim() === "";

  // One value. -> error message or "" (and the cleaned value via out.value)
  function obCheckValue(f, raw, d, now, out) {
    const label = f.label;
    if (f.type === "check") {
      out.value = raw === true;
      return isReq(f, d) && raw !== true ? "Tick to confirm." : "";
    }
    const s = raw == null ? "" : String(raw);
    const v = f.type === "textarea" ? s.trim() : s.replace(/\s+/g, " ").trim();
    out.value = v;
    if (!v) return isReq(f, d) ? (f.type === "choice" ? "Choose one." : label + " is needed.") : "";
    if (f.max && (f.type === "text" || f.type === "textarea" || !f.type) && v.length > f.max) return "Keep it under " + f.max + " characters.";
    if (f.type === "tel") {
      const p = normalizePhone(v);
      const digits = p.replace(/[^0-9]/g, "");
      if (!PHONE_RULE.test(p) || digits.length < 9 || digits.length > 15) return "Enter a phone number, e.g. 0771 234 567.";
      out.value = p;
    }
    if (f.type === "number") {
      if (!/^[0-9]+$/.test(v)) return "A whole number.";
      const n = Number(v);
      if (f.min != null && n < f.min) return "At least " + f.min + ".";
      if (f.max != null && n > f.max) return "At most " + f.max.toLocaleString("en-US") + ".";
    }
    if (f.type === "money") {
      if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(v)) return "An amount, e.g. 18 or 18.50.";
      if (Number(v) > f.max) return "At most " + f.max.toLocaleString("en-US") + ".";
    }
    if (f.type === "choice" && !f.options.some((o) => o[0] === v)) return "Choose one.";
    if (f.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v + "T00:00:00").getTime())) return "Enter a date.";
      if (!f.future && v > localDateKey(now)) return "This date can't be in the future.";
    }
    return "";
  }

  // A section's values -> {errors: {path: message}, complete, started}
  // Paths: "plan", "devices.0.branch", "devices" (the list itself), "modules".
  function obCheckSection(secKey, d, now) {
    const sec = OB_SECTION_BY_KEY[secKey];
    const errors = {};
    let started = false;
    for (const f of sec.fields) {
      if (f.type === "list") {
        const items = Array.isArray(d[f.name]) ? d[f.name] : [];
        items.forEach((it, i) => {
          for (const sf of f.fields) {
            if (!isShown(sf, it)) continue;
            if (!blank(it[sf.name]) && sf.type !== "date") started = true;
            const e = obCheckValue(sf, it[sf.name], it, now, {});
            if (e) errors[f.name + "." + i + "." + sf.name] = e;
          }
        });
        if (items.length < (f.min || 0)) errors[f.name] = "Add at least one " + f.item.toLowerCase() + ".";
        continue;
      }
      if (f.type === "modules") {
        const m = d[f.name] || {};
        const covered = OB_MODULES.filter(([k]) => m[k]);
        if (covered.length) started = true;
        for (const [k] of OB_MODULES) if (m[k] && !OB_LEVELS.some((o) => o[0] === m[k])) errors[f.name] = "Choose a level for each module.";
        if (isReq(f, d) && !covered.length) errors[f.name] = "Mark at least one module as covered.";
        continue;
      }
      if (!isShown(f, d)) continue;
      const raw = d[f.name];
      if (f.type === "check" ? raw === true : !blank(raw) && f.type !== "date") started = true;
      const e = obCheckValue(f, raw, d, now, {});
      if (e) errors[f.name] = e;
    }
    if (secKey === "vendor") {
      const branches = Number(d.branches), tills = Number(d.tills);
      if (!errors.branches && d.plan === "lite" && branches > 1) errors.branches = "Lite is for one branch. Choose Business for more branches.";
      if (!errors.tills && !errors.branches && d.branches && d.tills && tills < branches) errors.tills = "At least one till per branch (" + branches + ").";
    }
    return { errors, complete: Object.keys(errors).length === 0, started };
  }

  // "Not started" | "In progress" | "Done"
  function obSectionProgress(rec, secKey, now) {
    const c = obCheckSection(secKey, rec.data[secKey] || {}, now);
    return c.complete ? "done" : c.started ? "progress" : "none";
  }
  function obAllDone(rec, now) {
    return OB_SECTIONS.every((s) => obCheckSection(s.key, rec.data[s.key] || {}, now).complete);
  }

  // The parameters for cl_rpn_save_onboarding. A draft can be sent as soon
  // as the four identity fields are valid; any typed column whose own check
  // fails is sent as null, so the database never refuses a draft.
  function obCanSendDraft(rec, now) {
    const e = obCheckSection("vendor", rec.data.vendor || {}, now).errors;
    return !e.business_name && !e.owner_name && !e.phone && !e.city && !blank(rec.data.vendor.business_name);
  }
  function obRpcParams(rec, submit, now) {
    const v = rec.data.vendor || {};
    const e = obCheckSection("vendor", v, now).errors;
    const ok = (name) => !e[name] && !blank(v[name]);
    const tidy = (s) => String(s).replace(/\s+/g, " ").trim();
    const sections = {};
    for (const s of OB_SECTIONS) sections[s.key] = obCleanSection(s.key, rec.data[s.key] || {}, now);
    return {
      p_id: rec.id,
      p_note_id: rec.noteId || null,
      p_business_name: tidy(v.business_name),
      p_owner_name: tidy(v.owner_name),
      p_phone: normalizePhone(v.phone),
      p_city: tidy(v.city),
      p_plan: ok("plan") ? v.plan : null,
      p_branches: ok("branches") ? Number(v.branches) : null,
      p_tills: ok("tills") && ok("branches") ? Number(v.tills) : null,
      p_subscription_amount: ok("subscription_amount") ? Number(v.subscription_amount) : null,
      p_features_taken: ok("features_taken") ? String(v.features_taken).trim() : null,
      p_sections: sections,
      p_client_saved_at: new Date(rec.savedAt).toISOString(),
      p_submit: !!submit,
    };
  }
  // A section as the Console sees it: hidden fields left out, values tidied.
  function obCleanSection(secKey, d, now) {
    const sec = OB_SECTION_BY_KEY[secKey];
    const out = {};
    for (const f of sec.fields) {
      if (f.type === "list") {
        out[f.name] = (Array.isArray(d[f.name]) ? d[f.name] : []).map((it) => {
          const o = {};
          for (const sf of f.fields) {
            if (!isShown(sf, it)) continue;
            const c = {};
            obCheckValue(sf, it[sf.name], it, now, c);
            if (c.value !== "") o[sf.name] = c.value;
          }
          return o;
        });
      } else if (f.type === "modules") {
        const m = d[f.name] || {};
        const o = {};
        for (const [k] of OB_MODULES) if (m[k]) o[k] = m[k];
        out[f.name] = o;
      } else if (isShown(f, d)) {
        const c = {};
        obCheckValue(f, d[f.name], d, now, c);
        if (f.type === "check" || c.value !== "") out[f.name] = c.value;
      }
    }
    return out;
  }

  // ---------------- state ----------------
  const OB_PULL_EVERY_MS = 60 * 1000; // ask the Console for the office's answers at most once a minute
  const ob = {
    loaded: false,
    records: [], // newest change first
    sending: new Set(),
    showErrors: {}, // "recId:secKey" -> true once Save was tapped there
    lastPull: 0,
  };
  const OB_EDITABLE = { draft: true, returned: true };

  function obEditable(rec) {
    if (rec.submitRequested) return false;
    return !rec.serverStatus || !!OB_EDITABLE[rec.serverStatus];
  }
  function obPending(rec) {
    return rec.savedAt > (rec.sentSavedAt || 0) || (rec.submitRequested && rec.serverStatus !== "submitted" && !OB_FINAL[rec.serverStatus]);
  }
  const OB_FINAL = { approved: true, rejected: true };

  async function obInit() {
    await storeInit();
    try {
      ob.records = (await storeGetAll("records")).sort((a, b) => b.savedAt - a.savedAt);
    } catch (e) { /* storage refused: start empty */ }
    ob.loaded = true;
    if (state.tab === "field") render(false);
    kickOutbox();
  }
  async function obPut(rec) {
    await storePut("records", rec);
    const i = ob.records.findIndex((r) => r.id === rec.id);
    if (i === -1) ob.records.unshift(rec);
    else ob.records[i] = rec;
  }

  // A new record for the RPN signed in on this phone, blank or from one of
  // their onboarding notes (its details copied in; the note stays as it is).
  async function obCreate(noteId) {
    const now = fieldNow();
    const rec = {
      id: newNoteId(), rpnId: field.identity.rpnId, rpnName: field.identity.name, noteId: null,
      data: obEmptyData(now), createdAt: now, savedAt: now, sentSavedAt: 0,
      submitRequested: false, serverStatus: null, officeReason: "", verifiedAt: null,
      sync: "pending", attempts: 0, nextAttemptAt: now, permanent: false, lastError: "",
    };
    const note = noteId ? field.notes.find((n) => n.id === noteId) : null;
    if (note) {
      // Only a note the Console has can be linked (the database checks it is this RPN's).
      if (note.status === "sent" && note.rpnId === rec.rpnId) rec.noteId = note.id;
      const v = rec.data.vendor;
      for (const k of ["business_name", "owner_name", "phone", "city", "location", "business_type"]) v[k] = note.fields[k] || "";
      if (note.fields.visit_date) v.first_visit_date = note.fields.visit_date;
    }
    await obPut(rec);
    return rec;
  }

  // Typing: the value goes into the record at once (kept on the phone after
  // a short pause); nothing is sent until the RPN saves the section.
  const OB_SAVE_MS = 400;
  let obSaveTimer = null;
  let obDirty = null;
  function obSetValue(rec, secKey, path, value) {
    if (!obEditable(rec)) return;
    const d = rec.data[secKey];
    const parts = path.split(".");
    if (parts.length === 3) d[parts[0]][Number(parts[1])][parts[2]] = value;
    else if (parts.length === 2) { d[parts[0]] = d[parts[0]] || {}; d[parts[0]][parts[1]] = value; }
    else d[path] = value;
    obTouch(rec);
    obDirty = rec;
    clearTimeout(obSaveTimer);
    obSaveTimer = setTimeout(obFlush, OB_SAVE_MS);
  }
  function obTouch(rec) {
    rec.savedAt = Math.max(fieldNow(), (rec.savedAt || 0) + 1); // always moves forward
    rec.sync = "pending";
    rec.permanent = false;
    rec.lastError = "";
    rec.nextAttemptAt = rec.savedAt;
  }
  async function obFlush() {
    clearTimeout(obSaveTimer);
    const rec = obDirty;
    obDirty = null;
    if (rec) await storePut("records", rec).catch(() => {});
  }
  async function obAddItem(rec, secKey, listName) {
    if (!obEditable(rec)) return;
    const f = OB_SECTION_BY_KEY[secKey].fields.find((x) => x.name === listName);
    const items = rec.data[secKey][listName];
    if (items.length >= f.maxItems) return;
    items.push(obEmptyItem(f, fieldNow()));
    obTouch(rec);
    await obPut(rec);
  }
  async function obRemoveItem(rec, secKey, listName, index) {
    if (!obEditable(rec)) return;
    rec.data[secKey][listName].splice(index, 1);
    obTouch(rec);
    await obPut(rec);
  }
  // "Save section": shows its problems from now on, keeps it, and sends.
  async function obSaveSection(rec, secKey) {
    ob.showErrors[rec.id + ":" + secKey] = true;
    await obFlush();
    await obPut(rec);
    kickOutbox();
    return obCheckSection(secKey, rec.data[secKey], fieldNow());
  }
  // Submit for office verification: every section must be done.
  async function obSubmit(rec) {
    const now = fieldNow();
    if (!obEditable(rec) || !obAllDone(rec, now)) return false;
    rec.submitRequested = true;
    obTouch(rec);
    await obPut(rec);
    kickOutbox();
    return true;
  }
  async function obRetry(id) {
    const rec = ob.records.find((r) => r.id === id);
    if (!rec) return;
    Object.assign(rec, { sync: "pending", permanent: false, nextAttemptAt: fieldNow(), lastError: "" });
    await obPut(rec);
    kickOutbox();
  }

  // ---------------- sending (called from outbox.js's run) ----------------
  function obNeedsSending(rec) {
    return obPending(rec) && !OB_FINAL[rec.serverStatus];
  }
  async function obPass() {
    if (!ob.loaded) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const queue = ob.records.filter((r) => obNeedsSending(r) && (r.sync !== "failed" || !r.permanent)).sort((a, b) => a.savedAt - b.savedAt);
    for (const rec of queue) {
      const now = fieldNow();
      if (rec.sync === "failed" && rec.nextAttemptAt > now) continue;
      if (!canSend(rec, now)) {
        if (rec.sync !== "signin") { rec.sync = "signin"; await storePut("records", rec); refreshFieldScreens(); }
        continue;
      }
      if (!obCanSendDraft(rec, now)) continue; // waits on the phone until the vendor's details are filled in
      const submit = rec.submitRequested;
      const params = obRpcParams(rec, submit, now);
      const sentAt = rec.savedAt;
      ob.sending.add(rec.id);
      refreshFieldScreens();
      const res = await consoleSaveOnboarding(field.session, params);
      ob.sending.delete(rec.id);
      const after = fieldNow();
      if (res.result === "sent") {
        rec.sentSavedAt = Math.max(rec.sentSavedAt || 0, sentAt);
        Object.assign(rec, { sync: "pending", attempts: 0, permanent: false, lastError: "", nextAttemptAt: null });
        obApplyServer(rec, res.body);
      } else if (res.result === "auth") {
        field.session = null;
        await storeDelete("meta", "consoleSession");
        rec.sync = "signin";
      } else if (res.result === "locked") {
        // The Console already has it as submitted/approved/rejected: take its word.
        Object.assign(rec, { sync: "failed", permanent: true, lastError: res.message });
        ob.lastPull = 0;
      } else {
        rec.attempts = (rec.attempts || 0) + 1;
        Object.assign(rec, {
          sync: "failed", lastError: res.message, permanent: !!res.permanent,
          nextAttemptAt: res.permanent ? null : after + outboxBackoffMs(rec.attempts),
        });
        // A refused submit: give the record back to the RPN to fix.
        if (res.permanent && submit) rec.submitRequested = false;
      }
      await storePut("records", rec);
      refreshFieldScreens();
      if (res.result === "auth") { field.again = true; break; }
      if (res.result === "failed" && !res.permanent) break;
    }
    await obPull();
  }
  // The Console's answer for one record (from a save or a pull).
  function obApplyServer(rec, srv) {
    if (!srv || !srv.status) return;
    const was = rec.serverStatus;
    rec.serverStatus = srv.status;
    rec.officeReason = srv.office_reason || "";
    rec.verifiedAt = srv.verified_at || null;
    if (srv.status === "returned" && was !== "returned") rec.submitRequested = false; // back to the RPN to fix
    if (srv.status === "submitted") rec.submitRequested = true; // locked until the office answers
    if (srv.status === "returned" || srv.status === "draft") {
      // A "locked" refusal from before no longer applies.
      if (rec.sync === "failed" && rec.permanent && /can no longer be changed/.test(rec.lastError)) Object.assign(rec, { sync: "pending", permanent: false, lastError: "" });
    }
  }
  // The office's answers for this RPN's records: at most once a minute,
  // only when signed in.
  async function obPull(force) {
    const now = fieldNow();
    if (!sessionValid(field.session, now)) return;
    if (!force && now - ob.lastPull < OB_PULL_EVERY_MS) return;
    const mine = ob.records.filter((r) => r.rpnId === field.session.rpnId && (r.sentSavedAt || r.serverStatus));
    if (!mine.length) { ob.lastPull = now; return; }
    const res = await consoleFetchOnboardingStatus(field.session);
    if (!res.ok) return;
    ob.lastPull = now;
    const byId = {};
    for (const row of res.rows) byId[row.id] = row;
    let changed = false;
    for (const rec of mine) {
      const row = byId[rec.id];
      if (!row) continue;
      if (row.status !== rec.serverStatus || (row.office_reason || "") !== (rec.officeReason || "")) {
        obApplyServer(rec, row);
        await storePut("records", rec);
        changed = true;
      }
    }
    if (changed) refreshFieldScreens();
  }
  // When outbox.js should wake up for records.
  function obDueTimes() {
    return ob.records.filter((r) => r.sync === "failed" && !r.permanent && r.nextAttemptAt).map((r) => r.nextAttemptAt);
  }
  function obSignedInAgain(rpnId) {
    for (const r of ob.records) if (r.sync === "signin" && r.rpnId === rpnId) { r.sync = "pending"; r.nextAttemptAt = fieldNow(); }
  }

  // What the RPN sees about a record. -> {key, text}
  function obStatus(rec) {
    if (ob.sending.has(rec.id)) return { key: "sending", text: "Sending…" };
    if (rec.serverStatus === "approved") return { key: "approved", text: "Verified" };
    if (rec.serverStatus === "rejected") return { key: "rejected", text: "Rejected" };
    if (obPending(rec)) {
      if (rec.sync === "signin") return { key: "signin", text: "Sign in to send" };
      if (rec.sync === "failed") return { key: "failed", text: "Failed - retry" };
      if (rec.submitRequested) return { key: "saved", text: "Submit waiting" };
      return { key: "saved", text: "Saved on phone" };
    }
    if (rec.serverStatus === "submitted") return { key: "submitted", text: "With the office" };
    if (rec.serverStatus === "returned") return { key: "returned", text: "Returned to you" };
    return { key: "sent", text: "Draft sent" };
  }
