# seiGEN Commerce Lite

Offline-first POS and inventory app for small businesses — sales, stock,
credit, stocktakes, reports, and multi-branch data merge. All data lives in
a SQLite database (via sql.js/WASM) persisted to the browser's IndexedDB,
on the device it's used on, and every feature above works fully offline
with no server involved. The one optional exception is described below.

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

## Cloud sync (foundation only)

`src/sync.js` adds the app's first-ever, entirely optional connection to a
backend: a generic local outbox (`sync_queue`, schema in `src/db.js`) and a
background worker that pushes queued records to a Supabase project via its
REST API (plain `fetch()`, no SDK/bundler). It ships with no user-facing
feature — no RPN linkage, no Support button, no sync reminder — those are
later work built on top of this. Until a project is configured in Settings
→ Cloud sync (beta), the worker is a no-op and the app behaves exactly as
described above: fully offline, nothing ever sent anywhere.

**How a future feature (e.g. RPN linkage, support tasks) hooks in:**

1. Register your record type once, anywhere at your feature's top level:

   ```js
   registerSyncType("rpn_link", { table: "rpn_link" }); // table = Supabase table name
   ```

2. Whenever you have something to sync:

   ```js
   enqueueSync("rpn_link", { rpn_name, rpn_code, rpn_whatsapp, city_area });
   ```

   `enqueueSync()` stamps the device's tenant id on automatically (reusing
   the existing `getBranchId()` identity — no second tenant concept), marks
   the record "pending", and returns immediately. You never touch
   `sync_queue`'s SQL, call Supabase, or handle retries/offline yourself.
3. The background worker (started once at boot) picks up due records,
   POSTs each as one row to `${table}`, and marks it `synced` or `failed`
   (with exponential backoff, capped at 30 minutes) — silently, without
   blocking the UI or any POS operation.
4. To show status later (e.g. a future Sync Reminder Modal), read
   `pendingSyncCount()` / `pendingSyncRows()` — read-only.

You still need to create the actual Supabase table for your feature (e.g.
`rpn_link`) yourself — this foundation only proves the pipeline against a
`sync_health_check` table:

```sql
create table if not exists sync_health_check (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  note text,
  created_at timestamptz not null default now()
);
alter table sync_health_check enable row level security;
create policy "anon insert" on sync_health_check for insert to anon with check (true);
```

No Supabase project is wired in by default — paste a project's URL and
anon key into Settings → Cloud sync (beta) to activate the worker on a
device. Both build targets share the same code path and storage
(`settings` table via the usual `getSetting`/`setSetting`); a plain
`fetch()` to the Supabase REST API works identically in the PWA (a real
browser) and inside the Tauri webview — no extra Tauri capability is
needed, since Tauri's permission system only gates calls into its own Rust
commands, not the webview's own `fetch`.

## Verification

Both build targets are covered by the same Playwright-driven functional
walkthrough (setup, activation lock/unlock, POS checkout, products,
dispatch/receive, bulk import, credit, EOD, reports, report writer,
purchasing, stocktake, staff, requests, settings, backup/merge, remote
branch gating) plus PWA-specific installability checks (manifest
validity, service worker activation, precache contents, and a true
offline reload) for `dist-pwa/`.
