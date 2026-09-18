// seiGEN Commerce Lite — PWA build service worker (dist-pwa/ only).
// Unlike sw.js (the single-file build's reactive, cache-as-you-go worker),
// this one precaches the full app shell AND its CDN dependencies (sql.js,
// XLSX) at install time. That's what makes "works fully offline after the
// first successful load" (the promise already made in the app's own Help
// text) actually guaranteed for an installed PWA, rather than incidental
// on whichever resources happened to be fetched during a session.

// build: v2 — PWA live update test (bumped so this file's bytes differ,
// which is what actually triggers the browser's updatefound check).
const CACHE_NAME = "seigen-lite-pwa-v1";

// App shell: everything dist-pwa/ ships. CDN deps: the exact files the app
// loads at runtime — sql.js's loader script + its wasm binary (initDB's
// locateFile always resolves to this fixed 1.10.3 URL), and the XLSX
// library used by Import/Download Template. Keep these version pins in
// sync with shell/head-mid.html and src/import.js's loadXLSX().
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon.ico",
  "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js",
  "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
];

self.addEventListener("install", (event) => {
  // Deliberately no self.skipWaiting() here. On a shop's very first
  // install there's no previous worker to supersede, so this still
  // activates right away per spec — but on an UPDATE, an old worker is
  // still controlling open tabs (mid-sale, mid-count), and this new
  // worker should sit in "waiting" until the app's own update banner
  // asks it to take over (see the SKIP_WAITING message handler below).
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          PRECACHE_URLS.map((url) =>
            // Precache best-effort per-URL: one CDN hiccup during install
            // shouldn't fail the whole install and leave the app shell
            // itself (the part that matters most) uncached.
            cache.add(new Request(url, { cache: "reload" })).catch(() => {})
          )
        )
      )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Triggered by src/pwa-extras.js's "Reload" button on the update banner —
// never on its own — so an update only ever takes over a page the shop
// staff explicitly asked to reload, not mid-sale underneath them.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

// Cache-first, falling back to network, and updating the cache in the
// background on every successful network fetch — same strategy as sw.js,
// so anything not in the precache list (or a future CDN version) still
// gets picked up opportunistically.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
