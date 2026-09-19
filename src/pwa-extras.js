// ================== PWA install prompt + update banner ==================
// dist-pwa/ ONLY — build.js appends this file after main.js's closing
// })(); solely for the --pwa build; the single-file build's SCRIPT_ORDER
// never references it, so dist/index.html is byte-for-byte unaffected.
//
// This runs as a plain top-level script, outside the app's own IIFE, and
// touches the DOM only from the outside (matching by element id, same as
// a browser extension would) — it never needs, and never gets, access to
// the app's internal render()/state. That's deliberate: it's the only way
// to add PWA-only UI without editing help.js/router.js/main.js, which are
// shared verbatim with the single-file build.
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

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // suppress the browser's own heuristic-timed banner; we show our own button instead
    deferredInstallPrompt = e;
    ensureInstallButtonMounted();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    syncInstallButton();
  });

  // Re-check after every click in the app — cheap (a couple of
  // getElementById calls, no-op unless About is on screen) and catches
  // every way the About screen can (re)appear: picking it from the More
  // dropdown, or navigating back to More when it was already selected.
  document.addEventListener("click", () => ensureInstallButtonMounted());

  // ---------------- Service worker update banner ----------------
  if (!("serviceWorker" in navigator)) return;

  function updateBannerHtml() {
    return (
      '<div id="pwaUpdateBar" style="position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
      "background:#1f2430;color:#fff;padding:10px 14px;display:flex;align-items:center;" +
      'justify-content:space-between;gap:10px;font-size:13.5px;box-shadow:0 -2px 8px rgba(0,0,0,.25)">' +
      "<span>A new version is available.</span>" +
      '<span style="display:flex;gap:8px;flex:none">' +
      '<button id="pwaUpdateReload" style="background:#E8590C;color:#fff;border:none;border-radius:6px;' +
      'padding:7px 12px;font-weight:700;cursor:pointer">Reload</button>' +
      '<button id="pwaUpdateDismiss" style="background:none;border:none;color:#fff;opacity:.75;' +
      'cursor:pointer;font-size:16px;padding:2px 6px" aria-label="Dismiss">✕</button>' +
      "</span></div>"
    );
  }

  function showUpdateBanner(waitingWorker) {
    if (document.getElementById("pwaUpdateBar")) return;
    document.body.insertAdjacentHTML("beforeend", updateBannerHtml());
    document.getElementById("pwaUpdateDismiss").onclick = () => {
      const el = document.getElementById("pwaUpdateBar");
      if (el) el.remove();
    };
    document.getElementById("pwaUpdateReload").onclick = () => {
      waitingWorker.postMessage("SKIP_WAITING");
    };
  }

  // Reload only fires once the new worker actually takes control — i.e.
  // only after the shop staff tapped Reload above, never on its own.
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.ready
    .then((reg) => {
      if (reg.waiting) showUpdateBanner(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          // "installed" + an existing controller means this is an UPDATE
          // (a worker superseding one already running the page), not the
          // very first install — that distinction is what the banner is for.
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateBanner(newWorker);
          }
        });
      });
      // Proactively check for a newer sw.js on every load, rather than
      // relying solely on the browser's own (less predictable) update
      // timing — cheap, and makes "reopen the app after a deploy" reliable.
      reg.update().catch(() => {});
    })
    .catch(() => {});
})();
