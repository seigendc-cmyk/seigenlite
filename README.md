# seiGEN Commerce Lite

Offline-first POS and inventory app for small businesses — sales, stock,
credit, stocktakes, reports, and multi-branch data merge, with no backend.
All data lives in a SQLite database (via sql.js/WASM) persisted to the
browser's IndexedDB, on the device it's used on. Nothing is ever sent to a
server, and neither build target adds one.

## Source layout

`src/` holds the app split by concern (`pos.js`, `products.js`,
`dispatch.js`, `import.js`, `credit.js`, `reports.js`, etc.), concatenated
by `build.js` into one script inside an IIFE — `state.js` opens it,
`main.js` closes it and calls `boot()`. `shell/` holds the surrounding
HTML (head, meta tags, closing body) and `styles.css` is inlined between
them. This structure is shared by both build targets below; only the
packaging differs.

## Building

```
node build.js         # dist/       — single-file build
node build.js --pwa   # dist-pwa/   — installable PWA build
```

Both read the same `src/` files and produce the same app. Run either or
both any time; neither depends on the other having been built first.

### `dist/index.html` — the single-file build

One self-contained HTML file with all CSS and JS inlined. Double-click it
open from disk, or forward the file itself — WhatsApp, USB drive, email —
to another device and it works exactly the same, no install, no server,
no sibling files required. This is the version for a shop with no
reliable internet, or one that just receives a copy of the file from
someone else.

It needs an internet connection the *first* time it's opened anywhere (to
fetch the sql.js database engine from its CDN) — after that first
successful load, it works fully offline. This is also true if `dist/` is
served over http(s) instead of opened as a file: `sw.js` caches whatever
it fetches as it's fetched, opportunistically, so a shop that opens it
once online can keep using that same URL offline afterward. The Help tab
inside the app describes this promise to shop staff already.

### `dist-pwa/` — the installable PWA build

`index.html` + `manifest.json` + `sw.js` + icons as static files, meant to
be hosted at a URL and installed to a phone's home screen ("Add to Home
Screen" / the browser's install prompt) so it opens like a normal app icon
instead of a browser tab. The app itself is identical to `dist/` — same
`src/` content, same features, same math. The only real difference is
`sw.js`: instead of caching opportunistically, it **precaches** the full
app shell and its CDN dependencies (`sql-wasm.js`, `sql-wasm.wasm`,
`xlsx.full.min.js`) at install time, so "works fully offline after the
first successful load" is guaranteed the moment install finishes, not
just likely once enough features have been used online. This was verified
directly: after a first load, the browser's network is fully cut and the
app still boots to the setup/lock/POS screen straight from cache.

This build is meant for shop/branch staff who'll use the app daily from a
phone — install it once while online, then it behaves like a native app
icon, still fully offline afterward, still with the same "no data ever
leaves the device" model as the single-file build. It is **not** meant to
replace `dist/` for shops without reliable internet at all, or for
one-off use — those should keep using the forwarded single file.

An admin working from a desktop across branches (merging exports,
running head-office reports) is expected to keep using a desktop-friendly
build — that's a later phase, not part of `dist-pwa/`.

### Hosting `dist-pwa/`

`dist-pwa/` is a folder of static files — no build step, no server code,
no database, nothing to run. Any static host works:

- **GitHub Pages** — push `dist-pwa/`'s contents to a `gh-pages` branch or
  a repo's Pages-configured folder. Free, simplest for a single shop.
- **Netlify / Vercel / Cloudflare Pages** — drag-and-drop the `dist-pwa/`
  folder, or connect the repo and point the build output at `dist-pwa/`.
- Any other static file host (S3 + CloudFront, a shared hosting `public_html`
  folder, etc.) — it only needs to serve plain files over https.

Hosting `dist-pwa/` only publishes the **app shell** (the same code
that's in every copy of `dist/index.html`) to that URL. It does not add a
database, an API, or any server-side component, and no shop's sales,
stock, or customer data is ever uploaded there — that data stays local to
each device's IndexedDB, exactly as it does for the single-file build.

## Verification

Both build targets are covered by the same Playwright-driven functional
walkthrough (setup, activation lock/unlock, POS checkout, products,
dispatch/receive, bulk import, credit, EOD, reports, report writer,
purchasing, stocktake, staff, requests, settings, backup/merge, remote
branch gating) plus PWA-specific installability checks (manifest
validity, service worker activation, precache contents, and a true
offline reload) for `dist-pwa/`.
