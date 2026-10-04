  // ================== RPN Field Guide — app shell ==================
  // dist-rpn/ only (build.js --rpn). A separate app for RPN agents, not a
  // package of the shop app: it shares styles.css with it at build time and
  // nothing else (no sql.js, no activation). It runs on its own origin with
  // its own service worker (sw-rpn.js), manifest and icons. build.js wraps
  // this file, store.js, coach-engine.js and coach-ui.js in one IIFE, after
  // the inlined MANUAL and COACH_LINES data; this file is last and boots.
  //
  // The frame: top bar with search, four tabs (Coach, Field, Receipts, Me),
  // offline status, install button, update banner and a small dialog.
  // Coach is built (coach-ui.js). Field, Receipts and search still say
  // plainly that they aren't built yet; later phases replace them.

  const CACHE_NAME = "seigen-rpn-v1"; // must match sw-rpn.js

  // ---------------- icons (inline SVG, stroke = currentColor) ----------------
  const svg = (body) => '<svg class="fg-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + body + "</svg>";
  const ICONS = {
    coach: svg('<path class="fg-ic-fill" d="M6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-8A2.5 2.5 0 0 1 6.5 3z"/><path d="M8 8h8M8 11.5h5"/>'),
    field: svg('<path class="fg-ic-fill" d="M6 4.5h12a1.5 1.5 0 0 1 1.5 1.5v13.5A1.5 1.5 0 0 1 18 21H6a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 6 4.5z"/><path d="M9 3h6v3H9zM8 10.5h8M8 14h8M8 17.5h5"/>'),
    receipts: svg('<path class="fg-ic-fill" d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z"/><path d="M9 8h6M9 11.5h6M9 15h4"/>'),
    me: svg('<circle class="fg-ic-fill" cx="12" cy="8" r="3.5"/><path class="fg-ic-fill" d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6z"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    back: svg('<path d="M15 5l-7 7 7 7"/>'),
    play: svg('<path class="fg-ic-fill" d="M8 5.5v13l10-6.5z"/>'),
    book: svg('<path class="fg-ic-fill" d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z"/><path d="M12 6.5v13"/>'),
    pen: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
    clock: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'),
    tasks: svg('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M3.5 6.5l1.5 1.5 2.5-3M3.5 12l1.5 1.5 2.5-3M3.5 17.5l1.5 1.5 2.5-3"/>'),
  };
  const MARK =
    '<svg class="fg-mark" viewBox="0 0 512 512" aria-hidden="true" focusable="false">' +
    '<rect width="512" height="512" rx="104" style="fill:var(--orange)"/>' +
    '<path d="M176 144h160a40 40 0 0 1 40 40v96a40 40 0 0 1-40 40H236l-60 52v-52a40 40 0 0 1-40-40v-96a40 40 0 0 1 40-40z" style="fill:var(--paper)"/>' +
    '<path d="M200 232l40 40 76-80" fill="none" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ink)"/>' +
    "</svg>";
  // Flat two-tone illustration, coloured from the core tokens.
  const ART_RECEIPT =
    '<svg viewBox="0 0 160 120" aria-hidden="true" focusable="false">' +
    '<circle cx="80" cy="62" r="54" style="fill:var(--orange-light)"/>' +
    '<path d="M56 18h48v86l-8-6-8 6-8-6-8 6-8-6-8 6z" stroke-width="3" stroke-linejoin="round" style="fill:var(--paper);stroke:var(--ink)"/>' +
    '<path d="M66 38h28M66 52h28M66 66h18" stroke-width="5" stroke-linecap="round" style="stroke:var(--orange)"/>' +
    "</svg>";

  const TABS = [
    { key: "coach", label: "Coach" },
    { key: "field", label: "Field" },
    { key: "receipts", label: "Receipts" },
    { key: "me", label: "Me" },
  ];
  const TAB_KEYS = TABS.map((t) => t.key);

  // ---------------- state ----------------
  const state = {
    tab: "coach",
    sub: [], // the rest of the route, e.g. ["lesson", "ch3"] under #/coach/lesson/ch3
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    offlineReady: "checking", // checking | ready | pending | unsupported
    installPrompt: null, // the captured beforeinstallprompt event (single use)
    installed: false,
    updateWorker: null, // a waiting service worker, once one is found
  };
  let reloadRequested = false;

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function isStandalone() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  }
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent || "");
  }
  // "#/coach/lesson/ch3" -> ["coach", "lesson", "ch3"]; anything unknown -> ["coach"].
  function routeParts() {
    const parts = (location.hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
    return TAB_KEYS.indexOf(parts[0]) !== -1 ? parts : ["coach"];
  }

  // ---------------- frame (mounted once) ----------------
  function mountFrame() {
    const root = document.getElementById("fg");
    root.innerHTML =
      '<header class="fg-top">' +
        MARK +
        '<button type="button" class="fg-searchbtn" id="fgSearchOpen" aria-haspopup="dialog">' + ICONS.search + "<span>Ask or search…</span></button>" +
        '<span class="fg-offline" id="fgOffline" hidden>Offline</span>' +
      "</header>" +
      '<main class="fg-main" id="fgMain" tabindex="-1"></main>' +
      '<nav class="fg-nav" aria-label="Main">' +
        TABS.map((t) => '<button type="button" data-tab="' + t.key + '" id="fgNav-' + t.key + '">' + ICONS[t.key] + "<span>" + t.label + "</span></button>").join("") +
      "</nav>" +
      '<div class="fg-update" id="fgUpdate" role="status" hidden><span>A new version is ready.</span>' +
        '<button type="button" class="btn btn-primary btn-sm" id="fgUpdateReload">Reload</button></div>' +
      '<div class="fg-search" id="fgSearch" role="dialog" aria-modal="true" aria-label="Search" hidden>' +
        '<div class="fg-search-panel">' +
          '<div class="fg-search-row">' +
            '<button type="button" class="fg-iconbtn" id="fgSearchClose" aria-label="Close search">' + ICONS.back + "</button>" +
            '<input id="fgSearchInput" type="search" autocomplete="off" enterkeyhint="search" placeholder="Ask or search…" aria-label="Ask or search" aria-controls="fgSearchBody">' +
            '<button type="button" class="fg-iconbtn" id="fgSearchClear" aria-label="Clear search" hidden>' + ICONS.close + "</button>" +
          "</div>" +
          '<div class="fg-search-body" id="fgSearchBody" aria-live="polite"></div>' +
        "</div>" +
      "</div>" +
      '<div class="fg-modal" id="fgModal" role="dialog" aria-modal="true" aria-labelledby="fgModalTitle" hidden>' +
        '<div class="fg-modal-card">' +
          '<h2 class="fg-modal-title" id="fgModalTitle"></h2>' +
          '<p class="fg-modal-text" id="fgModalText"></p>' +
          '<input class="field" id="fgModalInput" maxlength="40" aria-labelledby="fgModalTitle">' +
          '<div class="fg-modal-btns"><button type="button" class="btn btn-outline btn-sm" id="fgModalCancel">Cancel</button>' +
          '<button type="button" class="btn btn-primary btn-sm" id="fgModalOk">OK</button></div>' +
        "</div>" +
      "</div>";

    // Everything inside the screen area is wired once, here, by data-act:
    // screens are redrawn wholesale, so nothing inside them keeps handlers.
    const main = document.getElementById("fgMain");
    main.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el || el.tagName !== "BUTTON" || el.disabled) return;
      if (el.dataset.act.startsWith("f-")) fieldAction(el.dataset.act, el);
      else coachAction(el.dataset.act, el);
    });
    main.addEventListener("submit", (e) => {
      const form = e.target.closest("form[data-act]");
      if (!form) return;
      e.preventDefault();
      if (form.dataset.act.startsWith("f-")) fieldSubmit(form.dataset.act, form);
      else coachSubmit(form.dataset.act, form);
    });
    main.addEventListener("input", (e) => {
      if (!e.target.dataset || !e.target.dataset.act) return;
      if (e.target.dataset.act === "note-field") fieldInput(e.target);
      else coachInput(e.target);
    });

    for (const t of TABS) {
      document.getElementById("fgNav-" + t.key).onclick = () => goTab(t.key);
    }
    document.getElementById("fgSearchOpen").onclick = openSearch;
    document.getElementById("fgSearchClose").onclick = closeSearch;
    document.getElementById("fgSearch").addEventListener("click", (e) => {
      if (e.target.id === "fgSearch") closeSearch(); // tap on the dimmed backdrop
    });
    const searchInput = document.getElementById("fgSearchInput");
    searchInput.addEventListener("input", onSearchInput);
    searchInput.addEventListener("keydown", onSearchKeydown);
    document.getElementById("fgSearchClear").onclick = clearSearch;
    document.getElementById("fgSearchBody").addEventListener("click", onSearchBodyClick);
    document.getElementById("fgSearchBody").addEventListener("keydown", onSearchKeydown);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!document.getElementById("fgModal").hidden) closeDialog(null);
      else if (!document.getElementById("fgSearch").hidden) {
        // First Escape clears what was typed (as a search field does), the next one closes.
        const input = document.getElementById("fgSearchInput");
        e.preventDefault();
        if (e.target === input && input.value) clearSearch();
        else closeSearch();
      }
    });
    document.getElementById("fgModalCancel").onclick = () => closeDialog(null);
    document.getElementById("fgModalOk").onclick = () => {
      const input = document.getElementById("fgModalInput");
      closeDialog(input.hidden ? true : input.value);
    };
    document.getElementById("fgModalInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("fgModalOk").click();
    });
    document.getElementById("fgModal").addEventListener("click", (e) => {
      if (e.target.id === "fgModal") closeDialog(null);
    });
    document.getElementById("fgUpdateReload").onclick = applyUpdate;
  }

  // ---------------- navigation ----------------
  function goTab(key) {
    const parts = routeParts();
    if (parts[0] === key && parts.length === 1 && location.hash) return;
    location.hash = "#/" + key; // hashchange renders, so Back works too
  }
  function onHashChange() {
    const parts = routeParts();
    state.tab = parts[0];
    state.sub = parts.slice(1);
    render(true);
  }

  // ---------------- small dialog (core modal radius) ----------------
  // fgDialog({title, text?, input?, okLabel?, danger?}) resolves to the
  // typed text (with input), true (without), or null when cancelled.
  let dialogResolve = null;
  let dialogReturnFocus = null;
  function fgDialog(opts) {
    if (dialogResolve) closeDialog(null);
    dialogReturnFocus = document.activeElement;
    document.getElementById("fgModalTitle").textContent = opts.title;
    const text = document.getElementById("fgModalText");
    text.textContent = opts.text || "";
    text.hidden = !opts.text;
    const input = document.getElementById("fgModalInput");
    input.hidden = opts.input === undefined;
    input.value = opts.input || "";
    const ok = document.getElementById("fgModalOk");
    ok.textContent = opts.okLabel || "OK";
    ok.className = "btn btn-sm " + (opts.danger ? "btn-danger" : "btn-primary");
    document.getElementById("fgModal").hidden = false;
    (input.hidden ? ok : input).focus();
    return new Promise((resolve) => { dialogResolve = resolve; });
  }
  function closeDialog(value) {
    document.getElementById("fgModal").hidden = true;
    const resolve = dialogResolve;
    dialogResolve = null;
    if (dialogReturnFocus && dialogReturnFocus.isConnected) dialogReturnFocus.focus();
    if (resolve) resolve(value);
  }

  // ---------------- screens ----------------
  function screenCoach() {
    return coachScreen(state.sub);
  }
  function screenField() {
    return fieldScreen(state.sub);
  }
  function screenReceipts() {
    return (
      '<h1 class="fg-h1" tabindex="-1">Receipts</h1>' +
      '<p class="fg-lead">Receipts for subscriptions, stocktakes and other services you provide.</p>' +
      '<div class="fg-hero">' + ART_RECEIPT +
        "<h2>No receipts yet</h2>" +
        "<p>The receipt writer arrives in a later update.</p>" +
      "</div>"
    );
  }
  function offlineReadyText() {
    switch (state.offlineReady) {
      case "ready": return '<span class="pill ok">Ready</span>';
      case "pending": return '<span class="pill fg-pill-warn">Not yet</span>';
      case "unsupported": return '<span class="pill fg-pill-grey">Not available</span>';
      default: return '<span class="pill fg-pill-grey">Checking…</span>';
    }
  }
  function offlineReadyHint() {
    if (state.offlineReady === "pending") return '<p class="muted" style="margin:10px 0 0">Keep the app open while online for a moment, then it works without internet.</p>';
    if (state.offlineReady === "unsupported") return '<p class="muted" style="margin:10px 0 0">Open the app from its web address to use it offline.</p>';
    return "";
  }
  function installCard() {
    let body;
    if (state.installed || isStandalone()) {
      body = '<p class="muted" style="margin:0">Installed on this device.</p>';
    } else if (state.installPrompt) {
      body = '<button type="button" class="btn btn-primary" id="fgInstall">Install RPN Field Guide</button>';
    } else if (isIOS()) {
      body = '<p class="muted" style="margin:0">On iPhone: tap Share, then Add to Home Screen.</p>';
    } else if (location.protocol === "file:") {
      body = '<p class="muted" style="margin:0">Open the app from its web address to install it.</p>';
    } else {
      body = '<p class="muted" style="margin:0">Install isn\'t offered right now. In Chrome, open the ⋮ menu and choose Install app or Add to Home screen.</p>';
    }
    return '<div class="card"><h2 class="fg-card-title">Install</h2>' + body + "</div>";
  }
  function screenMe() {
    return (
      '<h1 class="fg-h1" tabindex="-1">Me</h1>' +
      '<p class="fg-lead">Your Console sign-in, who is learning on this phone, and this app.</p>' +
      signInCardHtml() +
      profilesCardHtml() +
      '<div class="card"><h2 class="fg-card-title">This app</h2><dl class="fg-rows">' +
        '<div class="fg-row"><dt>Connection</dt><dd id="fgConn">' + (state.online ? '<span class="pill ok">Online</span>' : '<span class="pill fg-pill-warn">Offline</span>') + "</dd></div>" +
        '<div class="fg-row"><dt>Works offline</dt><dd id="fgReady">' + offlineReadyText() + "</dd></div>" +
        '<div class="fg-row"><dt>Version</dt><dd>' + escapeHtml(APP_VERSION) + "</dd></div>" +
      "</dl>" + offlineReadyHint() + "</div>" +
      installCard()
    );
  }
  const SCREENS = { coach: screenCoach, field: screenField, receipts: screenReceipts, me: screenMe };

  // navigated: true when the route changed (start at the top, focus the
  // heading); false when the same screen is redrawn after an action.
  function render(navigated) {
    document.getElementById("fgMain").innerHTML = SCREENS[state.tab]();
    if (navigated) {
      window.scrollTo(0, 0);
      const h1 = document.querySelector("#fgMain .fg-h1");
      if (h1) h1.focus({ preventScroll: true });
    }
    if (state.tab === "coach") coachAfterRender(state.sub, !!navigated);
    for (const t of TABS) {
      const btn = document.getElementById("fgNav-" + t.key);
      if (t.key === state.tab) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    }
    document.getElementById("fgOffline").hidden = state.online;
    document.getElementById("fgUpdate").hidden = !state.updateWorker;
    const install = document.getElementById("fgInstall");
    if (install) install.onclick = runInstall;
  }

  // (search: search-ui.js)

  // ---------------- install ----------------
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // show our own button on Me instead of the browser's timed banner
    state.installPrompt = e;
    if (state.tab === "me") render();
  });
  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    state.installed = true;
    if (state.tab === "me") render();
  });
  async function runInstall() {
    const prompt = state.installPrompt;
    if (!prompt) return;
    state.installPrompt = null; // a captured prompt can only be used once
    try {
      prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice && choice.outcome === "accepted") state.installed = true;
    } catch (e) {
      /* dismissed, or no longer installable: the card falls back to the menu hint */
    }
    render();
  }

  // ---------------- offline readiness + updates ----------------
  async function checkOfflineReady() {
    if (location.protocol === "file:" || !("serviceWorker" in navigator) || !("caches" in window)) {
      state.offlineReady = "unsupported";
    } else {
      try {
        const cache = (await caches.has(CACHE_NAME)) ? await caches.open(CACHE_NAME) : null;
        const shell = cache ? await cache.match("./index.html") : null;
        state.offlineReady = navigator.serviceWorker.controller && shell ? "ready" : "pending";
      } catch (e) {
        state.offlineReady = "pending";
      }
    }
    if (state.tab === "me") render();
  }
  function showUpdate(worker) {
    state.updateWorker = worker;
    document.getElementById("fgUpdate").hidden = false;
  }
  function applyUpdate() {
    const worker = state.updateWorker;
    if (!worker) return;
    reloadRequested = true;
    worker.postMessage("SKIP_WAITING"); // controllerchange below does the reload
  }
  function registerWorker() {
    if (location.protocol === "file:" || !("serviceWorker" in navigator)) {
      checkOfflineReady();
      return;
    }
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // Only reload when the person asked for it. The first install also
      // fires this (clients.claim) and must not reload a page in use.
      if (reloadRequested) location.reload();
      else checkOfflineReady();
    });
    navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
      .then((reg) => {
        if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate(worker);
          });
        });
        return navigator.serviceWorker.ready;
      })
      .then(checkOfflineReady)
      .catch(() => {
        state.offlineReady = "pending";
        if (state.tab === "me") render();
      });
  }

  // ---------------- connectivity ----------------
  // Nothing is redrawn wholesale when the connection changes: the few
  // things that show it are updated in place, so a half-typed note,
  // reflection or sign-in is never lost. Then waiting notes get a go.
  function setOnline(online) {
    state.online = online;
    document.getElementById("fgOffline").hidden = online;
    const conn = document.getElementById("fgConn");
    if (conn) conn.innerHTML = online ? '<span class="pill ok">Online</span>' : '<span class="pill fg-pill-warn">Offline</span>';
    patchSignInOnline(online);
    refreshFieldScreens();
    if (online) kickOutbox();
  }
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
  // Back to the app after a while: retries that came due, a sign-in that ran out.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kickOutbox();
  });

  // ---------------- boot ----------------
  mountFrame();
  {
    const parts = routeParts();
    state.tab = parts[0];
    state.sub = parts.slice(1);
  }
  render(true);
  window.addEventListener("hashchange", onHashChange);
  registerWorker();
  coachInit();
  fieldInit();
