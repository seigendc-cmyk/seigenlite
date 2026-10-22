// iTred Market Place service worker (iTred-B, docs/itred/itred-upgrade-design.md §E8).
// The shell (the page, its pinned libraries, icons, manifest) is kept per
// build, so the site opens offline and a new build waits until the page
// asks it to take over ("Update now"). Supabase calls and listing pictures
// are never cached here: listings must be fresh, and a customer's own
// orders are kept by the page itself (localStorage) for offline use.
// apps.json (the Products page) is network-first, so a changed link shows
// at once when online.
// build: i2 — content protection (decision 9: no right-click / long-press menu or page text selection outside inputs, DevTools and view-source keys blocked, the script scrambled; Copy buttons for order numbers and phone numbers); Contact Us from the Console's contact directory (decision 10: desks and numbers, Call / WhatsApp, kept for offline use)
// i1: first installable iTred: market search landing, outline icons, footer bar, Pictures / Text only, Download PDF + Share, vendor fulfilment status, order messages, Products page
// ITRED_BUILD in index.html must equal the "// build: iN" line above (build.js checks).
const ITRED_SW_BUILD = 2;
const CACHE = "itred-shell-i" + ITRED_SW_BUILD;
const SHELL = ["./", "manifest.webmanifest", "apps.json", "supabase-2.117.1.js", "jspdf-4.2.1.umd.min.js",
  "itred-icon-192.png", "itred-icon-512.png", "itred-maskable-512.png", "apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith("itred-shell-") && n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  else if (event.data === "GET_BUILD" && event.ports && event.ports[0]) event.ports[0].postMessage({ build: ITRED_SW_BUILD });
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                    // Supabase, listing pictures, WhatsApp: straight to the network
  if (url.pathname.endsWith("/apps.json")) {                          // network first
    event.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("apps.json", copy)); } return res; })
      .catch(() => caches.match("apps.json")));
    return;
  }
  if (req.mode === "navigate") {                                      // every page path is the one app page
    event.respondWith(caches.match("./").then((hit) => hit || fetch(req)).catch(() => fetch(req)));
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
