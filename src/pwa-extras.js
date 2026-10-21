// ================== PWA install prompt + updates ==================
// dist-pwa/ and dist-tauri/ ONLY — build.js appends this file after
// main.js's closing })(); the single-file build's SCRIPT_ORDER never
// references it.
//
// This runs as a plain top-level script, outside the app's own IIFE, and
// touches the DOM only from the outside (matching by element id, same as
// a browser extension would). The one thing it reads from inside is
// window.sclUpdateHooks (main.js, v23): whether the till is idle, save(),
// and seiGEN's minimum build.
(function () {
  "use strict";

  // ---------------- Install prompt ----------------
  let deferredInstallPrompt = null;

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function installButtonHtml() {
    return (
      '<div style="height:8px"></div>' +
      '<button class="btn btn-outline" id="pwaInstallBtn" style="display:none">⬇️ Install App</button>'
    );
  }

  function syncInstallButton() {
    const btn = document.getElementById("pwaInstallBtn");
    if (!btn) return;
    btn.style.display = deferredInstallPrompt && !isStandalone() ? "" : "none";
  }

  // The About screen (renderAbout() in src/help.js) replaces #main's
  // innerHTML wholesale on every visit, so the button has to be
  // re-injected each time rather than mounted once.
  function ensureInstallButtonMounted() {
    if (isStandalone()) return; // never show inside an already-installed app
    const anchor = document.getElementById("waAbout2");
    if (!anchor) return; // About screen isn't the one currently rendered
    if (document.getElementById("pwaInstallBtn")) {
      syncInstallButton();
      return;
    }
    anchor.insertAdjacentHTML("afterend", installButtonHtml());
    const btn = document.getElementById("pwaInstallBtn");
    btn.onclick = async () => {
      if (!deferredInstallPrompt) return;
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null; // beforeinstallprompt only fires once; a captured event is single-use
      syncInstallButton();
      try {
        promptEvent.prompt();
        await promptEvent.userChoice; // resolves whether the user accepted or dismissed — either way there's nothing more to do
      } catch (e) {
        /* dismissed, or install no longer available — nothing to show the user */
      }
    };
    syncInstallButton();
  }

  // v32 Office seats: the install page's own button (src/seat.js renderSeatInstall). The page
  // always shows the code too, so joining never depends on the browser offering the install.
  function syncSeatInstallButton() {
    const b = document.getElementById("seatInstallBtn");
    if (!b) return;
    b.hidden = !(deferredInstallPrompt && !isStandalone());
    b.onclick = async () => {
      if (!deferredInstallPrompt) return;
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      syncSeatInstallButton();
      syncInstallButton();
      try { promptEvent.prompt(); await promptEvent.userChoice; } catch (e) { /* dismissed */ }
    };
  }
  window.sclSeatInstallMount = syncSeatInstallButton;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // suppress the browser's own heuristic-timed banner; we show our own button instead
    deferredInstallPrompt = e;
    ensureInstallButtonMounted();
    syncSeatInstallButton();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    syncInstallButton();
    syncSeatInstallButton();
  });

  // Re-check after every click in the app — cheap (a couple of
  // getElementById calls, no-op unless About is on screen) and catches
  // every way the About screen can (re)appear: picking it from the More
  // dropdown, or navigating back to More when it was already selected.
  document.addEventListener("click", () => ensureInstallButtonMounted());

  // ---------------- Updates (v23) ----------------
  // Owner, 2026-10-14: look for a new version while the app is open (every
  // 30 minutes, when the internet comes back, when the app comes back to the
  // screen); install it by itself only when the till is idle with an empty
  // cart; a clear banner whose ✕ hides it for an hour; the build and "Check
  // for updates" in More → About; and a red "must update" bar when seiGEN's
  // minimum build (check-in, 20261025120000) is above this build.
  const CHECK_EVERY_MS = 30 * 60 * 1000;
  const IDLE_MS = 2 * 60 * 1000;          // untouched this long, on top of hooks.idle()
  const HIDE_MS = 60 * 60 * 1000;         // ✕
  const TICK_MS = 15 * 1000;
  const HIDE_KEY = "scl_update_hidden_until";
  const THIS_BUILD = typeof APP_BUILD !== "undefined" ? Number(APP_BUILD) || 0 : 0;
  // The installed Windows program (Tauri) serves the files built into it and
  // has no service worker (main.js, src-tauri/sw-off.js): a newer build only
  // ever arrives with a new installer.
  const IS_TAURI = !!window.__TAURI__ || location.hostname === "tauri.localhost";
  const hasSW = "serviceWorker" in navigator && location.protocol !== "file:" && !IS_TAURI;
  const hooks = () => window.sclUpdateHooks || null;

  let reg = null;
  let waiting = null;          // a new version, installed and waiting
  let waitingBuild = null;     // its build, when its worker says (v23+ workers do)
  let applying = false;
  let reloadOnChange = false;
  let lastActivity = Date.now();
  let lastCheck = 0;

  function hiddenUntil() {
    try { return Number(localStorage.getItem(HIDE_KEY)) || 0; } catch (e) { return 0; }
  }
  function setHiddenUntil(ms) {
    try { if (ms) localStorage.setItem(HIDE_KEY, String(ms)); else localStorage.removeItem(HIDE_KEY); } catch (e) { /* private window: hides for this session only */ }
    memHiddenUntil = ms;
  }
  let memHiddenUntil = hiddenUntil();
  const isHidden = () => Date.now() < Math.max(memHiddenUntil, hiddenUntil());

  function minBuild() {
    const h = hooks();
    try { return h && h.minBuild ? Number(h.minBuild()) || 0 : 0; } catch (e) { return 0; }
  }
  const mustUpdate = () => THIS_BUILD > 0 && minBuild() > THIS_BUILD;

  // ---- the bar (one at a time: red "must update", else "update ready") ----
  function barState() {
    if (applying) return { kind: "applying", text: "Updating… This takes a few seconds; nothing is lost." };
    if (isHidden()) return null;
    if (mustUpdate()) {
      let text = "This app must be updated: seiGEN needs build " + minBuild() + " or later (this is build " + THIS_BUILD + ").";
      if (IS_TAURI && !waiting) text += " Ask seiGEN for the new Windows installer.";
      return { kind: "required", text: text, button: IS_TAURI && !waiting ? null : "Update now" };
    }
    if (waiting) {
      return { kind: "ready", text: "Update ready" + (waitingBuild ? " (build " + waitingBuild + ")" : "") +
        ". Tap Update now: it takes a few seconds and nothing is lost.", button: "Update now" };
    }
    return null;
  }

  function renderBar() {
    const s = barState();
    let el = document.getElementById("pwaUpdateBar");
    if (!s) { if (el) { el.remove(); placeBar(); } return; }
    const sig = s.kind + "|" + s.text + "|" + (s.button || "");
    if (el && el.getAttribute("data-sig") === sig) return;
    if (el) el.remove();
    const bg = s.kind === "required" ? "#c92a2a" : "#1f2430";
    // z-index 30: above the header and the phone's tab bar, UNDER the cart
    // drawer (50) and every window (70), so it never covers Pay or a dialog.
    document.body.insertAdjacentHTML("beforeend",
      '<div id="pwaUpdateBar" role="status" data-kind="' + s.kind + '" style="position:fixed;left:0;right:0;bottom:0;z-index:30;' +
      "background:" + bg + ";color:#fff;padding:10px 14px;display:flex;align-items:center;" +
      'justify-content:space-between;gap:10px;font-size:13.5px;box-shadow:0 -2px 8px rgba(0,0,0,.25)">' +
      '<span id="pwaUpdateText"></span>' +
      '<span style="display:flex;gap:8px;flex:none">' +
      (s.button ? '<button id="pwaUpdateNow" style="background:' + (s.kind === "required" ? "#fff;color:#c92a2a" : "#E8590C;color:#fff") +
        ';border:none;border-radius:6px;padding:7px 12px;font-weight:700;cursor:pointer"></button>' : "") +
      (s.kind === "applying" ? "" : '<button id="pwaUpdateDismiss" style="background:none;border:none;color:#fff;opacity:.8;' +
        'cursor:pointer;font-size:16px;padding:2px 6px" aria-label="Hide for an hour" title="Hide for an hour">✕</button>') +
      "</span></div>");
    el = document.getElementById("pwaUpdateBar");
    el.setAttribute("data-sig", sig);
    document.getElementById("pwaUpdateText").textContent = s.text;
    const now = document.getElementById("pwaUpdateNow");
    if (now) { now.textContent = s.button; now.onclick = () => updateNow(); }
    const x = document.getElementById("pwaUpdateDismiss");
    if (x) x.onclick = () => { setHiddenUntil(Date.now() + HIDE_MS); renderBar(); };
    placeBar();
  }

  // Never over the phone's tab bar (it floats just above it) or the desktop
  // Sales screen's cart panel (it stops at its edge). Re-placed whenever the
  // app redraws its screen.
  function placeBar() {
    const el = document.getElementById("pwaUpdateBar");
    if (!el) { document.body.style.paddingBottom = ""; return; }
    const nav = document.querySelector(".navbar");
    const cartPanel = document.querySelector(".ds-cart");
    if (nav && nav.offsetHeight) {
      el.style.bottom = (nav.offsetHeight + 16) + "px";
      el.style.left = "8px"; el.style.right = "8px"; el.style.borderRadius = "12px";
    } else {
      el.style.bottom = "0"; el.style.left = "0"; el.style.borderRadius = "0";
      el.style.right = cartPanel && cartPanel.offsetWidth ? cartPanel.offsetWidth + "px" : "0";
    }
    document.body.style.paddingBottom = el.offsetHeight + "px";   // the end of a long list can still scroll clear of it
  }
  const appRoot = document.getElementById("app");
  if (appRoot && typeof MutationObserver !== "undefined") new MutationObserver(() => placeBar()).observe(appRoot, { childList: true });
  window.addEventListener("resize", () => placeBar());

  function say(text) {               // a one-off message in the bar (e.g. "no update found")
    const t = document.getElementById("pwaUpdateText");
    if (t) t.textContent = text;
    const el = document.getElementById("pwaUpdateBar");
    if (el) el.setAttribute("data-sig", "msg");
  }

  // ---- finding and installing a new version ----
  function askBuild(worker) {
    return new Promise((resolve) => {
      try {
        const ch = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 1500);   // a worker before v23 doesn't answer
        ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data && Number(e.data.build) || null); };
        worker.postMessage("GET_BUILD", [ch.port2]);
      } catch (e) { resolve(null); }
    });
  }

  function onWaiting(worker) {
    if (!worker || worker === waiting) return;
    waiting = worker;
    waitingBuild = null;
    renderBar();
    askBuild(worker).then((b) => { if (waiting === worker) { waitingBuild = b; renderBar(); } });
  }

  function checkNow() {
    lastCheck = Date.now();
    if (!reg) return Promise.resolve(false);
    return reg.update().then(() => true, () => false);
  }

  function waitForWaiting(ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        if (reg && reg.waiting) onWaiting(reg.waiting);
        if (waiting) return resolve(true);
        if (Date.now() - t0 >= ms) return resolve(false);
        setTimeout(poll, 250);
      })();
    });
  }

  function applyUpdate() {
    if (applying || !waiting) return;
    applying = true;
    reloadOnChange = true;
    renderBar();
    const worker = waiting;
    const h = hooks();
    Promise.resolve(h && h.save ? h.save() : null).catch(() => {}).then(() => {
      worker.postMessage("SKIP_WAITING");
      // controllerchange reloads; this is only the fallback if it never comes
      setTimeout(() => window.location.reload(), 10000);
    });
  }

  function updateNow() {
    if (waiting) return applyUpdate();
    // "must update" with nothing downloaded yet: look for it now
    if (IS_TAURI) { say("This Windows program gets a new build as a new installer from seiGEN."); return; }
    if (!hasSW) { say("This copy of the app can't update itself: open it from its web address."); return; }
    if (navigator.onLine === false) { say("No internet: connect, then tap Update now again."); return; }
    say("Looking for the update…");
    checkNow().then(() => waitForWaiting(10000)).then((found) => {
      if (found) applyUpdate();
      else say("No update found yet. Check the internet, then tap Update now again.");
    });
  }

  // Installs a waiting version by itself only on the Start screen or an empty
  // Sales screen (hooks.idle()), untouched for IDLE_MS: never mid-sale.
  function idleTick() {
    if (!waiting || applying) return;
    const h = hooks();
    if (!h || !h.idle || !h.idle()) return;
    if (Date.now() - lastActivity < IDLE_MS) return;
    applyUpdate();
  }

  ["pointerdown", "keydown", "input", "touchstart", "wheel"].forEach((ev) =>
    document.addEventListener(ev, () => { lastActivity = Date.now(); }, { capture: true, passive: true }));

  // ---- More → About: the build and "Check for updates" ----
  function ensureAboutMounted() {
    const anchor = document.getElementById("aboutVersion");
    if (!anchor || document.getElementById("pwaCheckUpdates")) return;
    anchor.insertAdjacentHTML("afterend",
      '<button class="btn btn-outline" id="pwaCheckUpdates">Check for updates</button>' +
      '<p class="muted" id="pwaCheckResult" style="font-size:12px;margin-top:6px" aria-live="polite"></p>');
    const out = document.getElementById("pwaCheckResult");
    if (IS_TAURI) out.textContent = "This is the installed Windows program: a newer build comes as a new installer from seiGEN.";
    document.getElementById("pwaCheckUpdates").onclick = () => {
      const btn = document.getElementById("pwaCheckUpdates");
      if (navigator.onLine === false) { out.textContent = "No internet: can't check now."; return; }
      if (!reg) { out.textContent = IS_TAURI ? "This is the installed Windows program: a newer build comes as a new installer from seiGEN." : "Updates can't be checked in this copy of the app."; return; }
      btn.disabled = true;
      out.textContent = "Checking…";
      checkNow().then(() => waitForWaiting(8000)).then((found) => {
        btn.disabled = false;
        if (found) {
          setHiddenUntil(0);
          renderBar();
          out.textContent = "Build " + (waitingBuild || "(new)") + " is ready. Tap Update now at the bottom of the screen.";
        } else {
          out.textContent = "This is the newest build (" + THIS_BUILD + ")." +
            (IS_TAURI ? " A newer build for the Windows program comes as a new installer from seiGEN." : "");
        }
      });
    };
  }
  document.addEventListener("click", () => ensureAboutMounted());

  window.addEventListener("scl:minbuild", () => renderBar());
  setInterval(() => { idleTick(); renderBar(); ensureAboutMounted(); }, TICK_MS);
  // the bar for a stored "must update" as soon as the app has opened its database
  setTimeout(renderBar, 3000);

  if (!hasSW) return;

  // Reload only once the new worker has taken control after applyUpdate().
  // A page that opened with no controller is the very first visit: sw.js's
  // activate calls clients.claim(), which fires controllerchange as soon as
  // precaching finishes. That's not an update, and reloading there threw a
  // brand-new shop back to step 1 of Setup with everything they'd typed gone.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController && !reloadOnChange) return;
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.ready
    .then((r) => {
      reg = r;
      if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          // "installed" + an existing controller means this is an UPDATE
          // (a worker superseding one already running the page), not the
          // very first install.
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) onWaiting(newWorker);
        });
      });
      checkNow();
      setInterval(() => checkNow(), CHECK_EVERY_MS);
      window.addEventListener("online", () => checkNow());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastCheck > 60 * 1000) checkNow();
      });
    })
    .catch(() => {});
})();
