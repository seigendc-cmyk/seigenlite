// Publish Portal service worker: makes the portal installable and keeps a
// copy of the page shell (HTML, CSS, JS, manifest, icons) so the app window
// opens even if the portal isn't running yet. That is ALL it caches.
//
// Never cached, never even touched (the browser handles them as if there
// were no service worker):
//   * anything under /api/ — sessions, staff, vendors, tokens, uploads, photos
//   * any request carrying a session (X-Portal-Session)
//   * anything from another origin (Supabase, including published photos)
//   * anything that isn't a GET
// The shell itself is public (it's the sign-in form until the server says
// otherwise), so a cached copy gives nobody access: every launch still
// signs in against the running portal.
"use strict";
const CACHE = "publish-portal-shell-v1";
const SHELL = ["/", "/index.html", "/app.js", "/style.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

self.addEventListener("install", (event)=>{
  event.waitUntil(caches.open(CACHE)
    .then(cache => cache.addAll(SHELL.map(p => new Request(p, { cache: "reload", credentials: "omit" }))))
    .then(()=> self.skipWaiting()));
});

self.addEventListener("activate", (event)=>{
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n))))
    .then(()=> self.clients.claim()));
});

self.addEventListener("fetch", (event)=>{
  const req = event.request;
  const url = new URL(req.url);
  // The sign-out beacon a closing/reloading page sends: pass it straight on
  // (left to the default, Chromium drops it while a controlled page unloads).
  if(req.method === "POST" && url.origin === self.location.origin && url.pathname === "/api/end-session"){ event.respondWith(fetch(req)); return; }
  if(req.method !== "GET" || url.origin !== self.location.origin) return;
  if(url.pathname.startsWith("/api/") || req.headers.has("x-portal-session")) return;
  if(!SHELL.includes(url.pathname)) return;
  // Network first, so an updated portal is picked up straight away; the
  // cached copy is only for when the portal isn't running.
  event.respondWith(
    fetch(req).then(res => {
      if(res.ok && res.type === "basic"){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(url.pathname, copy)); }
      return res;
    }).catch(()=> caches.match(url.pathname))
  );
});
