// seiGEN Commerce Lite — PWA build service worker (dist-pwa/ and
// dist-tauri/, copied in as sw.js by build.js — never dist/).
// Unlike sw.js (the single-file build's reactive, cache-as-you-go worker),
// this one precaches the full app shell AND its CDN dependencies (sql.js,
// XLSX) at install time. That's what makes "works fully offline after the
// first successful load" (the promise already made in the app's own Help
// text) actually guaranteed for an installed PWA, rather than incidental
// on whichever resources happened to be fetched during a session.
//
// Deploy dist-pwa/ and dist-tauri/ on different origins/subpaths if both
// are hosted — CACHE_NAME below isn't scoped per-build, so two builds
// sharing one origin would share Cache Storage entries too.

// build: v6 — multi-terminal Phase 3a: product catalogue sync, pictures store; tills never sell below zero
// v5: built for Phase 3a with selling at zero on registered tills; never deployed (owner changed Q1)
// (bumped so this file's bytes differ, which is what actually triggers the browser's updatefound check).
// v4: multi-terminal Phase 1 + 2: tills, per-till numbering, stock ledger, internal refs, deactivate a till.
// v3: export scopes, doc-numbered filenames, Excel item export, app-log send, row menus.
// v2: marble-globe icons (tools/icons/build-icons.js) — new name so installed apps fetch them.
const CACHE_NAME = "seigen-lite-pwa-v2";

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
  "./icon-maskable-192.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./favicon.svg",
  "./favicon-32.png",
  "./favicon-16.png",
  "./icon.ico",
  // Start screen globe (src/staff.js renderStart)
  "./globe-transparent-512.png",
  "./globe-transparent-1024.png",
  // Marketing add-on (build.js --market). Optional: only there if it was
  // deployed next to index.html; if not, the best-effort add below just
  // skips it and the Marketing tab shows "not installed" as it should.
  "./market.html",
  "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js",
  "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
];

const PRECACHE_TIMEOUT_MS = 20000;
function precacheOne(cache, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRECACHE_TIMEOUT_MS);
  return cache
    .add(new Request(url, { cache: "reload", signal: ctrl.signal }))
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

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
            // Each download is also time-boxed (PRECACHE_TIMEOUT_MS): install
            // waits for every one of these, so a single stalled CDN request
            // used to keep the worker installing — and the page without
            // offline support — for as long as the network hung. A file cut
            // off here isn't lost: the fetch handler below caches it the next
            // time the app requests it (sql.js loads on every start).
            precacheOne(cache, url)
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
