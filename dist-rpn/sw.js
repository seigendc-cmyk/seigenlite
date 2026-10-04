// build: 1.09.01-7bfe3c3debba
// RPN Field Guide — service worker (dist-rpn/ only; build.js copies it in
// as sw.js with a BUILD_ID line on top, so every build that changes the
// app also changes this file's bytes, which is what makes the browser
// notice an update).
//
// Differences from the core app's sw-pwa.js, all deliberate:
//   * Only ever touches caches named "seigen-rpn-…". The core worker
//     deletes every cache that isn't its own; this one leaves anything it
//     doesn't own alone, so it can never wipe another app's offline copy.
//   * Only answers same-origin GETs. Cross-origin requests (Supabase, in
//     later phases) go straight to the network, never into a cache.
//   * The app shell is served from the precache only, and replaced only
//     when a new worker takes over. The page's update banner asks before
//     that happens, so an update never lands under someone mid-form.
//   * A new version downloads into a staging cache first, and is moved
//     into the live cache when it activates. The live cache keeps its
//     fixed name, and the page still running keeps getting the old files.

const CACHE_NAME = "seigen-rpn-v1";
const STAGING_CACHE = CACHE_NAME + "-next";
const OWN_CACHE_PREFIX = "seigen-rpn-";

const SHELL_URLS = [
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  // All or nothing: every file is on our own origin, and half a shell is
  // worse than keeping the previous one. No skipWaiting() here; see the
  // SKIP_WAITING message below.
  event.waitUntil(
    caches
      .delete(STAGING_CACHE)
      .then(() => caches.open(STAGING_CACHE))
      .then((cache) => cache.addAll(SHELL_URLS.map((url) => new Request(url, { cache: "reload" }))))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const staged = await caches.open(STAGING_CACHE);
      const requests = await staged.keys();
      if (requests.length) {
        await caches.delete(CACHE_NAME);
        const live = await caches.open(CACHE_NAME);
        for (const request of requests) {
          const response = await staged.match(request);
          if (response) await live.put(request, response);
        }
      }
      await caches.delete(STAGING_CACHE);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(OWN_CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// Sent by the page's "Reload" button on the update banner, and only then.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    // One-page app: any navigation inside the scope opens the shell.
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match("./index.html"))
        .then((hit) => hit || fetch(request))
    );
    return;
  }
  event.respondWith(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.match(request, { ignoreSearch: true }))
      .then((hit) => hit || fetch(request))
  );
});
