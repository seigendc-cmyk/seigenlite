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

// build: v34 — Batch 2, selling and credit (owner decisions 1-4, 30-33; seiGEN 20261112120000): the phone Sell list shows each product's category; the Sell list is held in memory and search waits for a pause in typing; over the credit limit a sale is blocked, overridden only by someone holding "Credit sales over limit" with the Admin passcode (single operator: the Admin passcode alone, logged so), against the balance at this till, marked when checked offline; built-in Cash Sale and Wholesale customers on every till (locked, no credit); receipts carry the address, phones, logo (screen and PDF), customer, who served, payment reference, credit before and after, a receipt message and "powered by seiGEN Commerce"; the remaining Admin passcode checks run off the screen thread; reports: credit limit overrides, offline credit sales, sales by customer type, price changes
// v32: Office seats by invite (owner 2026-10-20; seiGEN 20261109120000): a device on the main branch with no till for the bookkeeper, the stores clerk or the owner (no selling, payments or End of Day; never single operator mode; its own phrase, never the business's); the Owner or an Admin invites a named person with a code and a link (one use, 24 hours, revocable), the person installs the app and joins inside it, sets or enters their PIN, and the Owner or an Admin approves the device by comparing the device check; the install page adjusts to Android, PC, iPhone and in-app browsers and always shows the code; internal transfers between the seat and the main branch's tills (sent, then confirmed; shortages written off or kept); the business's bill on the licence card and the lock screen, seats at $3
// v31: Staff managers at every branch (owner 2026-10-16; seiGEN 20261108120000): once seiGEN has that update, an Owner, an Admin or anyone with the Staff right signs in on every till of the business (everyone else at their home branch and "also works at"); the set-PIN screen says where the new PIN works; where nobody who manages staff can sign in yet, the Staff card and the single-mode alert say a manager can sign in there once they have a seiGEN PIN, or add the people on the main branch; before that seiGEN update everything is as v30
// v30: Sign-in and Settings unlock no longer freeze (owner 2026-10-20, P0): the PIN and Admin passcode checks run off the screen (Web Crypto; the same check values and strength), the check code is no longer slowed by the obfuscator, "Checking…" while it runs and no second tap; Sell shows the first 200 products ("Show more" adds 200; search and barcode as before); Settings saves all or nothing; a till registered as a remote can't make itself Main (Branch type is set for the whole business)
// v29: Staff deadlock fix (owner 2026-10-16): with single operator mode on, "Sign in to manage staff" (someone with the Staff right, by PIN) shows Add, Edit, PINs and the Roles editor until Done, Log out or 5 minutes without use; someone who signs in with an old PIN from a till's list sets a seiGEN PIN right away, so it works on every till of their branch; where nobody who manages staff can sign in (a remote, another main till) the Staff card and the single-mode alert say to add the people on the main branch, then Refresh
// v27: Branches step 2 (owner 2026-10-16; seiGEN 20261106120000): a double-click (Windows program) or a tap (phone) opens a Delivery Note's full card (header, transport, every line, the differences and how each was settled, the linked DNs, the history; Print / PDF, Share file for this till's own) from Stock by branch → Dispatches and the seiGEN dispatches lists, and a product's item ledger (this till's movements with the running balance, plus the other tills' and branches' dispatches, GRVs and supplier GRVs) from Products, the Product List and Stock by branch; the Dispatches search also finds internal refs and the transport; each till's own figure at every branch; More → Directory: Customers and Suppliers tabs, each with the branch that added it; picking another branch's customer asks first (once per customer on this till), a credit sale to them every time with the Admin passcode; Report Writer at remote branches (this branch's reports and every branch's stock, quantities only)
// v26: iTred orders (owner 2026-10-14, iTred-B): More → Orders Fulfillment (the business's iTred orders on every till: set what was supplied per line with a note, Mark complete; status only, no stock or sale) and More → Marketplace Feedback (reply to customers' comments on their orders); a "new iTred orders" line on Sell; changes kept offline and sent after check-in (no duplicates)
// v25: Branches (owner 2026-10-14): More → Product List "All branches" is the sum over the branches (each the sum of its tills; this branch with this till's live count), each branch's figure under it, a file-merge-only branch listed as "File copy from <date>" and never counted (it showed this till's own count); one search rule everywhere (every term, any order: Product List, Stock by branch, a new Dispatches search box, Dispatch/Receipts history, Directory, Credit, the cart's customer box); the other branches' stock at every branch (Products columns; Sell: tap a product's name); Stocktake counts this branch only, at every branch, with the other branches read-only; Reports → Inventory / Low stock "All branches (this device)"; Sell (desktop): no category buttons, the search matches the category
// v24: Dispatch: the destination list follows seiGEN's branch list while the dialog is open (a branch that just joined moves to "Through seiGEN" at once); names only this device knows are grouped and marked "(file only)"; Destination branches says which names are on seiGEN; "Goes through seiGEN to ..." names the branch just chosen (it kept the first one)
// v23: Updates: an open app looks for a new version every 30 minutes, when the internet comes back and when it comes back to the screen; it installs it by itself when the till is idle (Start screen, or an empty Sales screen untouched for 2 minutes; never with items in the cart or a window open); a clearer banner ("Update ready (build N)", Update now, ✕ hides it for an hour); More → About shows the build, with Check for updates; seiGEN's minimum build (20261025120000) shows a red "This app must be updated" bar
// v22: Branches B1: stock by branch (each registered till of a business with 2+ tills sends its own stock figures to seiGEN; a branch = the sum of its tills); main: an Other branches column on Products, More → Stock by branch with each till's own count, a warning when two tills look like copies, value at main's cost; remotes: More → Other branches (quantities and dispatches, no costs); the Product List lists joined branches; the branch list refreshes at every check-in; "too old to add terminals" in plain words (UPDATE_MAIN_FIRST)
// v21: Admin passcode from the main branch: a joined device's Admin passcode is set on a main-branch till (with the join code, or "Set its Admin passcode" on its row) and arrives as a check value, never the passcode; a joined device can't make its own first Admin passcode; receiving in plain words (the sender's list says "Received at <branch> (their GRV)", Receive stock names this device and shows each line before -> after, Import GRV says what a Delivery Note file is for)
// v20: Billing-B: a remote branch joins with a join code at setup (no code-less remote set-up); Register refuses a business already registered (same name and phrase); a till follows its business when seiGEN merges a duplicate; the Dispatch dialog and each Delivery Note say "File only: not through seiGEN" and why
// v19: Server time for the trusted clock from cl_server_time (readable by the browser; was an unreadable Date header), and no RPN status call for a device the server has not registered
// v18: Trial rules: no anonymous trial; the free trial comes signed from seiGEN at setup (online, RPN field force number + PIN, owner's phone, one per phone); before it the shop can add products and stock but not sell; joined tills share the business trial
// v17: POS fixes: cart with its own scroll and pinned Pay (phone and desktop), menus kept under the header, customer combo with "Add new" (Create customers permission), wholesale prices by customer type, credit limit warning, search where every term must match
// v14: RPN link: the RPN types their field force number + PIN (setup or More → Settings); About shows "Onboarded by"
// v13: Marketing add-on (market.html) is built into dist-pwa and dist-tauri, so no deploy can drop it again
// v12: price plans: More → About shows the plan, the till's role and its price; Lite's one-branch limit explained
// v11: activation v2: signed licences (link, long code, short code), trial from the earliest business data, read-only Reports when locked
// v10: Phase 3c: sales returns & credit notes, exchanges, store credit, Item Ledger; business day set per branch by main
// v9: business day: local dates everywhere, "Business day ends at" cut-off (reports, Sales Trend, shifts, End of Day agree)
// v8: tills report their build at check-in (shared stock waits until every till runs v7+)
// v7: multi-terminal Phase 3b: shared branch stock + offline allowance
// v6: multi-terminal Phase 3a: product catalogue sync, pictures store; tills never sell below zero
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

// Triggered by src/pwa-extras.js — its "Update now" button, or (v23) the
// till being idle with an empty cart — never on its own, so an update only
// ever takes over a page that isn't mid-sale.
// "GET_BUILD" (v23): the banner asks a waiting worker which build it brings.
// SW_BUILD must equal the "// build: vN" line above (build.js checks).
const SW_BUILD = 34;
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  else if (event.data === "GET_BUILD" && event.ports && event.ports[0]) event.ports[0].postMessage({ build: SW_BUILD });
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
