// Windows program (Tauri) only: src/lib.rs injects this before every page.
//
// Inside the program a service worker can't update itself: the browser's
// own update fetch of sw.js fails ("An unknown error occurred when fetching
// the script"; checked 2026-10-14 with builds 22 and 23). So a worker left
// by an older build kept serving that build's cached files after every new
// installer, and the program never showed the build it was installed with.
// The program carries its files inside it and works offline without a
// worker: remove any registration, then reload once so the page comes from
// the program itself. Nothing is deleted: the shop's data (IndexedDB,
// localStorage) and the old cache are left as they are.
(function () {
  if (window.top !== window || !navigator.serviceWorker) return;
  navigator.serviceWorker.getRegistrations().then(function (regs) {
    if (!regs.length) return;
    return Promise.all(regs.map(function (r) { return r.unregister(); })).then(function () {
      if (!navigator.serviceWorker.controller) return;
      try { if (sessionStorage.getItem("scl_sw_off")) return; sessionStorage.setItem("scl_sw_off", "1"); } catch (e) { /* reload anyway */ }
      location.reload();
    });
  }).catch(function () {});
})();
