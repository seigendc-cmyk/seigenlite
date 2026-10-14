# iTred Market Place upgrade + Orders Fulfillment in Commerce Lite: Stage A design

Status: **design only.** No code, no deploy, no database change. Waiting for the owner's answers and "go iTred-B".
Code state: `activation-v2` at `3328269` (Commerce Lite v25 on the previews, production v10).
Wireframes: `docs/itred/mock/*.png` (390 px), made from `docs/itred/mock/itred-mock.html`. All sample data in them is made up.

Labels: **VERIFIED** (seen in code, on the network or in the live database, read-only), **PROPOSED** (this design), **ASSUMED**, **UNVERIFIED**.

---

## Part A. iTred today

### A1. Source, build, deploy (VERIFIED)
- **One self-contained file:** `src/itred/index.html` (2812 lines, 193,429 bytes). It has inline CSS and JS, the logo as a base64 PNG, and its own hash router.
- **Build:** `build.js:362-377` (`node build.js --itred`) copies it byte for byte to `dist-itred/index.html`, without obfuscation.
- **Same file on both sites:** itred-preview and the live itredvpd both serve 193,429 bytes, the same file.
- **No iTred target in the deploy script:** `tools/cf/deploy-app.js:23-26` only knows `mobilepos(-preview)` and `desktoppos(-preview)`. Stage B adds `preview:itred` → `itred-preview` from `dist-itred`, and `production:itred` → `itredvpd`, which is gated like the other production targets.
- **External scripts:**
  - supabase-js 2.117.1 from cdn.jsdelivr (the only script on first load);
  - jsPDF 4.2.1 from cdn.jsdelivr, loaded on demand (`index.html:1814`).

### A2. Pages, routing, what loads first (VERIFIED)
- **Routes** (`index.html:1168`): `/`, `/market-space`, `/products`, `/rpn`, `/help`, `/contact`, `/orders`, `/account`, `/privacy`, `/terms`.
  - `currentRoute()` (`:1182-1185`) sends an empty or unknown hash to `/`.
- **First screen = Home** (`#page-/`, `:461`), a marketing page with hero, stats, highlights and "Browse Market Space". The market search is one tap away at `#/market-space` (`:603`).
  - Network check at 390 and 1280 px: the active page on load is `page-/`.
- **On load** (`:1206-1208`): `render()`, then `loadAllPublicData()`.
  - Only `loadListings()` really queries (`:1080-1092`).
  - The other loaders (partners, highlights, showcase, site products, RPN applications) are switched off by `placeholderBackend = null` (`:1065`).

### A3. Navigation (VERIFIED)
- **Header** (`:438-457`): logo, a hamburger (`#navToggle`, `:444`) and `nav.mainnav` with 8 links (`:445-454`). The hamburger only toggles `.open` on that nav (`:1217-1219`).
- **There's no floating footer bar ("bubble bar").** The `<footer>` (`:1023-1040`) is an ordinary site footer at the end of the page.
- **Feedback widget:** a fixed button at the bottom right (`:2781`, CSS `:222-237`). It posts to a `feedback` table that doesn't exist, and is switched off (`submitFeedback`, `:1159-1162`), so **nothing is ever sent**.

### A4. PWA (VERIFIED)
- No manifest link, no service worker (`navigator.serviceWorker.controller` is null), no icons and no offline shell. It isn't installable today.

### A5. Search (VERIFIED)
- **Matcher:** `matchesQuery` (`:1253-1260`) requires every typed word as a **substring** of name + vendor + category + keywords + city.
  - It is any order, but "5" matches "15", and "ant" matches "pants".
  - It isn't the Commerce Lite matcher.
- **Search box:** `#marketSearch` (`:607`) sits in the page flow and scrolls away (computed `position: static`).
- **"Near me"** (`:1385-1411`) explains that vendors share no map locations. Listings carry the vendor's city only.

### A6. Product list and images (VERIFIED, code + network)
- **Query:** `LISTING_SELECT` (`:1078`) reads `image_url` and **not `thumb_url`**. `listingToProduct` (`:1106`) uses `image_url`, and `productThumb` (`:1276-1280`) puts it in the list.
- **Network at 390 px:**
  - 2 live listings, both from one test vendor ("Chipo Clothing");
  - 2 images loaded, both `image_url` WebP at **200×200**, 5.7 and 7.0 KB;
  - stretched to **356×267** in card view (1280 px: 323×323).
- **Thumbnails on the server:**
  - 1 of the 2 live listings has `thumb_url`: a **100×100 WebP, 2.6 KB** (`-t.webp`);
  - live database: 2 published and live listings, 1 with a thumb; 23 expired and 2 pending.
- **Views:** a Grid/List toggle (`:1413-1423`). It isn't remembered: `marketView` resets to `card` on every load.
- **Category:** none of the 2 live listings has one.
- **Items per screen at 390 px today:** a card is 505 px tall, so **about 1½ products per screen**.

### A7. Your Orders and "Send PDF" (VERIFIED)
- **Drafts:** one per vendor, kept in `localStorage` `itred.draftOrders.v1` (`:1573-1617`). They work offline.
- **Sending** (`sendDraft`, `:2039-2081`):
  1. loads jsPDF first;
  2. inserts `purchase_orders`, then `purchase_order_items`; the database snapshots name and price from the listing;
  3. then calls `deliverOrder`.
- **"Send PDF"** (button `:2118`, `deliverOrder` `:2017-2037`):
  1. builds the PDF on the device with jsPDF (`buildSalesOrderPdf`, `:1900-2006`, A4, navy/gold);
  2. tries the Web Share sheet with the file, otherwise downloads it;
  3. "Open WhatsApp chat" (`:2093`) opens `wa.me/<vendor>` with a short sentence, not the order lines.
  - File name: `Sales-Order-PO-XXXXXXXX.pdf` (`:2005`). The order ref is `PO-` + the first 8 hex digits of the order id (`:1859`).
- **Sent orders** load from Supabase only when online and signed in (`loadSentOrders`, `:1839-1850`). **No offline copy.** jsPDF comes from the CDN, so **the PDF can't be made offline** unless the CDN file is already in the browser cache.
- **Fulfilment today is recorded by the customer, not the vendor:**
  - "Record delivery" (`:2120`, dialog `:2147-2300`) writes `purchase_order_items.quantity_fulfilled`;
  - the order status follows from the lines (see B1).
  - In the live database, the 1 order there is "fulfilled" this way.
- **Ordering needs a vendor WhatsApp number** (`canOrderFrom`, `:1291`).

### A8. Products page (VERIFIED)
- `#page-/products` (`:636-688`) has static cards with "Get notified" buttons.
- `commerceLiteDownload` points at the **production** mobilepos/desktoppos (`:1210-1215`).

---

## Part B. Server today vs part 7 (VERIFIED, read-only)

### B1. What `20260924120000_itred_marketplace_schema` and `20260925120000_itred_po_fulfilment` provide
Both are applied on live, as is `20261016120000_market_publishing`. `20260926160000` isn't applied.

- **Order tables:**
  - `purchase_orders(id, customer_id → customers, vendor_id → vendors, status ∈ sent|partially_fulfilled|fulfilled|closed, pdf_url, created_at)`;
  - `purchase_order_items(…, quantity_requested, quantity_fulfilled, is_custom_request, fulfillment_status generated: outstanding|partially_fulfilled|fulfilled, created_at)`.
- **Customer rights (RLS):** read their own orders and lines; create orders; add lines to their own open orders; set `status='closed'`; and (po_fulfilment) update `quantity_fulfilled` on their own lines.
- **Triggers:**
  - `purchase_order_items_snapshot_listing` copies the listing's name and price into a new line;
  - `purchase_order_items_sync_po_status` (security definer) derives the order status from the lines; a closed order stays closed.
- **Vendors:**
  - `vendors(install_id → cl_vendors.install_id)` is one iTred vendor **per business: its main till's install ID** (market_publishing `cl_market_publish_attach`, via `cl_account_identity`);
  - anon can read vendors with live listings; customers can read vendors they've ordered from.
- **Live counts:** 1 customer, 5 iTred vendors (2 linked to a business), 1 order (fulfilled), 1 line. **No feedback or message table exists.**

### B2. What's missing for part 7
| Need | Today |
|---|---|
| A vendor reads its orders | Vendors have **no access at all**; the migration header says vendors never touch Supabase |
| A vendor sets fulfilled qty / outstanding / note, and completes | Only the customer (or service_role) can set `quantity_fulfilled`; there's no note column and no "completed by vendor" |
| Offline queue without duplicates | Nothing on the vendor side |
| Feedback and comments on an order, with replies | No table |
| Change tracking for a pull cursor | Orders have no `updated_at` or sequence |

---

## Part C. Server design (PROPOSED): one migration, `20261105120000_itred_order_fulfilment`

Additive and in one transaction, the same rules as the earlier ones: a preflight that stops on any name clash, a rollback file, PGlite tests, a backup first, the SQL shown, and the owner's "apply".

### C1. Columns and tables
- **`purchase_order_items`:**
  - `vendor_note text check (length ≤ 300)`;
  - `vendor_updated_at timestamptz`;
  - `customer_confirmed_at timestamptz`;
  - `customer_dispute text check (length ≤ 300)` (Q2).
- **`purchase_orders`:**
  - `completed_at timestamptz` (vendor marked it complete);
  - `change_seq bigint not null default nextval('itred_po_change_seq')`, bumped by a trigger on any change to the order, its lines or its messages; this is the vendor pull cursor;
  - `updated_at timestamptz`.
- **New `itred_po_updates`** (one row per vendor action, so a resend is a no-op):
  - `uid uuid primary key` (from the till);
  - `purchase_order_id`, `item_id null`, `kind ∈ line|complete`, `qty_fulfilled`, `note`;
  - `terminal_id`, `till_code`, `created_at`.
  - This is also the history ("T2 marked 2 of 2 at 14:05").
- **New `itred_order_messages`** (feedback, comments and replies on an order):
  - `id uuid primary key` (from the client), `purchase_order_id`, `author ∈ customer|vendor`;
  - `body text check (1–1000 chars)`, `created_at`, `terminal_id null`, `vendor_read_at`, `customer_read_at`.
- **RLS on, no anon grants.** Customers:
  - **SELECT** messages on their own orders;
  - **INSERT** with `author='customer'` on their own orders;
  - **UPDATE** `customer_read_at` only;
  - for lines: UPDATE `customer_confirmed_at` and `customer_dispute` only, on their own lines (column grants).
  - `itred_po_updates` has no customer access. The customer sees its effects on the lines.

### C2. Who sets `quantity_fulfilled` (needs Q2)
- **Recommended:** the vendor, through C3.
- **The customer's** column grant and the "Customers can record fulfilment on own purchase orders" policy are **dropped**.
- **The customer instead** confirms receipt, or disputes a line with a short reason.
- The status trigger stays as it is.
- `completed_at` doesn't change `status`. Your Orders shows "Completed by vendor" next to the derived status, so a partly-supplied order can be completed honestly.

### C3. Vendor RPCs: phone-checked like every device call
- **Auth:** `cl_install_vendor(install_id, phrase, device_key)`, the same check as `cl_device_pack_submit`.
- **Which orders:** `vendors.install_id = cl_account_identity(business, device).install_id`, so any till of the business reaches **its business's** orders and no other's. A till of a business with no iTred vendor gets `{ error: 'NOT_ON_ITRED' }`.

| RPC | Does |
|---|---|
| `cl_device_itred_orders_pull(auth…, p_cursor bigint, p_limit int)` | Orders with `change_seq > cursor`: order ref, created_at, status, completed_at, lines (name, qty requested, qty fulfilled, custom, unit price, currency, vendor note, confirmed / dispute), messages; plus the customer's **name and phone** (Q6); never the email or the customer id. Returns `{ orders, cursor, more }` |
| `cl_device_itred_line_update(auth…, p_uid, p_item_id, p_qty_fulfilled, p_note)` | Idempotent on `p_uid`. Checks 0 ≤ qty ≤ requested and that the order isn't closed. Sets the line and `vendor_updated_at`; logs `itred_po_updates` |
| `cl_device_itred_order_complete(auth…, p_uid, p_order_id)` | Idempotent. Sets `completed_at` |
| `cl_device_itred_message_send(auth…, p_id, p_order_id, p_body)` | Idempotent on `p_id`. `author='vendor'` |
| `cl_device_itred_messages_read(auth…, p_order_id)` | Sets `vendor_read_at` |

- **Last write wins per line:** a later `created_at` on the server overwrites. Every write is logged, so nothing is lost.

### C4. Customer reads (their own auth, PostgREST, RLS)
- Your Orders adds the new columns, plus `itred_order_messages(*)` on its existing `purchase_orders` select.
- **Sending a comment:** insert into `itred_order_messages` with a client-made uuid. A resend after a timeout fails on the primary key, and the page treats that as "already sent".

### C5. Tests (PGlite, Stage B)
- A vendor's pull returns only its business's orders. A till of another business, a wrong phrase or a wrong device key gets nothing.
- A line update is idempotent and refuses over-fulfilment.
- The status follows the lines.
- Customer A can't read or write customer B's orders, lines or messages. anon can read none of them.
- The customer can no longer change `quantity_fulfilled` (if Q2 is approved).
- The rollback restores the earlier policy and grant exactly (catalogue fingerprint).

---

## Part D. Commerce Lite (PROPOSED)

### D1. Where the two pages go
- **More → "Orders Fulfillment"** and **More → "Marketplace Feedback"**: two entries in `MORE_TABS` (`src/router.js:342-353`).
  - Both show on the phone builds (More dropdown) and on desktop (the same list, in the hamburger drawer's More).
  - They're listed only when the till is registered and the business has an iTred vendor (the first pull didn't answer `NOT_ON_ITRED`).
  - A count shows in the label: "Orders Fulfillment (2 new)".
  - Not the Marketing page: it's a sandboxed iframe layer (`src/marketing.js:92-140`), which can't hold local tables or the outbox.
- **On Sell:** a one-line banner, "2 new iTred orders", in the same style as `dcMessagesBannerHtml` (`src/devicecheckin.js:225`). Tapping it opens Orders Fulfillment.
- **Which tills:** all tills of the business see and update orders (Q4). Orders belong to the business, not to a branch, as with publishing.

### D2. Local data and sync (reuse the customers pattern)
- **New local tables:**
  - `itred_orders` (order id, ref, created, status, completed_at, customer name/phone, change_seq);
  - `itred_order_lines`;
  - `itred_messages`;
  - `itred_outbox(uid primary key, kind line|complete|message|read, payload json, created_ts, status queued|sent|error, error)`.
- **`itredAfterCheckin()`:**
  - added to the check-in hooks next to `custAfterCheckin` (`src/devicecheckin.js:172-184`);
  - it sends the outbox first, then pulls with the stored cursor, the same shape as `custSendPending()` / `custPull()` (`src/customers.js:262-320`);
  - it also runs on reconnect and when the page is opened.
- **Offline:**
  - every change goes into `itred_outbox` and shows at once, marked "waiting to send";
  - a network failure stops the loop and keeps the queue (as `custSendPending` does);
  - a uid sent twice is a no-op on the server, so **duplicates can't happen**.
- **Pulled order rows replace local ones,** except lines with a queued change. Those keep the local value until it's sent.

### D3. Screens and states
- **Orders Fulfillment:**
  - a list (new / open / completed) with the any-order search (`textMatches`: ref, customer, item, date);
  - an order card with each line: requested qty, a fulfilled-qty box, quick "All" and "None" buttons, an optional note;
  - "Save" (queues the line updates) and "Mark complete" (asks to confirm);
  - customer name and phone, with a WhatsApp link to the customer.
- **Marketplace Feedback:**
  - each order's messages, newest first, unread first;
  - a reply box (Q3); a reply goes to the outbox.
- **Empty:** "No iTred orders yet. Orders customers send you on iTred Market Place appear here after the till checks in."
- **Offline:** "Offline: showing orders from <time>. Your changes are kept and sent when the internet is back." The queued count is shown.
- **Error:** "Couldn't load orders (<reason>). Try again." A queued item that the server refused shows its reason and a "Discard" button.
- **Not on iTred:** the pages are hidden. The entry appears once the business has published on iTred.
- **Stock and sales:** marking a line fulfilled **doesn't change stock and doesn't create a sale** (Q1). The vendor rings up the sale on Sell as usual.

---

## Part E. iTred design (PROPOSED)

### E1. Shell, phone first
- **Landing (`#/`) is the market search** (wireframe `landing-390.png`).
  - Today's Home content moves to **About** (`#/about`), together with Privacy, Terms, Help, Contact and Become an RPN.
- **Header** (56 px, white): hamburger, logo, account icon.
- **Search bar:** `position: sticky; top: 56px` under the header, always visible, translucent off-white.
  - It holds the **Pictures** and **Text only** icon toggles.
- **Colours:** navy `#12243F`, white, off-white `#F7F4EE`, the gold accent and the existing logo (`:11-23`, `:441`). Fraunces stays for headings; Inter for text.

### E2. Icons and buttons
- **One component:** `.ib` = an outline SVG icon (22 px, stroke 1.6, `currentColor`), a 10.5 px caption under it, no border, no background.
  - Minimum 44×44 px tap area.
  - `aria-label` always set; the caption is `aria-hidden` when it repeats the label.
  - Focus: a 2 px gold outline.
- **One inline SVG sprite** (`<symbol>`s, about 20 icons, about 4 KB): market, orders, vendors, apps, account, info, search, pictures, text, add, PDF, share, message, open, install, menu, place, phone, desktop, document.
  - Drawn in one style (24-grid, round caps), as in the wireframes. No icon font.
- **Measured in the wireframes:** 0 of 98 icon buttons are under 44 px.

### E3. Navigation
- **Hamburger** (wireframe `menu-390.png`): a left drawer with Market, Your Orders, Vendors, Products (our apps), Account, About & Privacy, plus small links to Help, Contact, Terms and Become an RPN.
  - Esc, the scrim or a route change closes it. Focus is trapped while it's open.
- **Footer bar (phones, < 768 px):**
  - floating, transparent (`rgba(255,255,255,.78)` + blur), 60 px high plus the safe-area inset, rounded;
  - 5 entries: Market, Orders, Vendors, Apps, Account;
  - the page gets `padding-bottom: 80px + env(safe-area-inset-bottom)`, so the last item is never covered;
  - **hidden while the keyboard is up:** it hides when an input has focus, or when `visualViewport.height` drops by more than 150 px (`keyboard-390.png`);
  - it doesn't replace the hamburger.
- **Desktop (≥ 768 px):** no footer bar. The header shows the 5 links inline next to the hamburger (Q5).
- **Vendors page:** the vendors with live listings (name, city, number of products). A tap fills the search with the vendor's name.

### E4. Search
- **Matcher:** the Commerce Lite matcher, shared at build time.
  - `searchTokens`, `productSearchParts`, `productTermKind`, `productTermMatches` and `textMatches` move from `src/utils.js` into `src/shared/search.js`. Commerce Lite still gets them through `build.js`.
  - `buildItred()` becomes a small assembly step, as the comment at `build.js:362-370` already planned, and inlines the same file into iTred.
  - So one rule: every term, any order; words by their start; numbers whole.
- **Fields:** product name, vendor, category (when present) and city.
- **Result line:** "N products from M vendors", or a no-match message that suggests checking the spelling.

### E5. List: Pictures or Text only
- **Query:** `LISTING_SELECT` reads `thumb_url` and **stops reading `image_url`.** The list only ever loads `thumb_url` (100×100 WebP), shown at 56×56 CSS px, which is sharp on a 2× screen. `loading="lazy"` and `decoding="async"` are set.
- **No thumb:** a neutral placeholder icon, and nothing is loaded. Today that's 1 of the 2 live listings.
- **Text only:** no `<img>` at all, so no image request.
- **The choice is remembered** in `localStorage` `itred.view`, wrapped in try/catch.
- **Row:** name (bold), vendor · city, price, and the Add icon. 72 px with a picture, 56 px in text only.
- **Items per screen at 390×844** (measured in the wireframes, between the search bar and the footer bar):
  - **8 rows fully visible with pictures, 11 in text only.** Today it's about 1½.
- **Product detail:** a tap on a row opens a sheet with the same thumb, details, "Add to order" and "WhatsApp the vendor". No full image (an "image" button can come later if wanted).

### E6. Your Orders (wireframe `orders-390.png`)
- **Order card:** vendor, ref, date and city, the order status, and per line: qty, amount and a status chip, **Fulfilled / Partly fulfilled / Outstanding** (from `fulfillment_status`). The vendor's note and "x of y supplied" show under the line.
- **Icons:** **PDF** (download), **Share**, **Message** (opens the order's comments; Q3).
  - With Q2: **Confirm** and **Dispute** on a line once the vendor has set it.
- **Download PDF:**
  - the existing `buildSalesOrderPdf`, plus a status column;
  - always a normal download (`<a download>`); no share sheet;
  - file name **`iTred-Order-<PO-XXXXXXXX>-<vendor>.pdf`**, with the vendor name made safe for file names (letters, digits and hyphens, at most 30 characters);
  - works offline: jsPDF is **self-hosted** in `dist-itred/` and pre-cached by the service worker. The signed-in customer's sent orders are cached in IndexedDB on the device, and cleared when they sign out.
- **Share:** `https://wa.me/<vendor digits>?text=…`, or `https://wa.me/?text=…` when the vendor has no number, so the customer picks a chat. The text:
  ```
  iTred order PO-3F9A21C0 · 14 Oct 2026
  Vendor: <vendor> · Customer: <name on the order>
  • Brake pads, front set × 2 — USD 48.00 (fulfilled)
  • Tail lamp, left × 1 — USD 65.00 (outstanding)
  • Wiper blades × 2 — to quote, not listed (1 of 2)
  Total USD 113.00 · Status: partly fulfilled
  ```
  - Kept under 1,500 characters: after 15 lines it adds "+ N more items (see the PDF)".
  - Only what's on the order: no phone, email or address.
- **Drafts:** unchanged (stored on the device).
- **"Send"** saves the order and shows it in Your Orders with PDF and Share. The automatic share sheet goes away.

### E7. Products page: our apps (wireframe `apps-390.png`)
- **Config list:** `dist-itred/apps.json`, fetched at runtime, so a link changes without a rebuild. Keys: `name`, `url`, `icon`, `line`.
- **The six links** below, as given (previews).
- **Each card:** icon, name, one line, **Open** (new tab) and **Install**.
  - **Install** for iTred itself uses the real install prompt (`beforeinstallprompt`) when the browser offers one.
  - For the other apps a site can't install another site, so Install opens a short guide: "Open the app, then: Android Chrome ⋮ → Install app / Add to Home screen; iPhone Safari Share → Add to Home Screen; PC Chrome/Edge ⊕ in the address bar".
- **Descriptions:** none invented. The wireframe lines are placeholders. Please give one line each (Q7).

### E8. PWA
- **Install pieces:** `manifest.webmanifest` (name, short name "iTred", navy theme, off-white background, `display: standalone`, start `./#/`), plus 192, 512 and maskable icons made from the existing logo.
- **`sw.js`:**
  - pre-caches the shell (index, the sprite inside it, the pinned self-hosted supabase-js and jsPDF, manifest, icons, `apps.json`);
  - network-first for `apps.json`;
  - **never caches Supabase API calls or listing images** in Stage B (fresh data matters; offline orders come from IndexedDB).
- **Update banner:** the same approach as Commerce Lite v23 (`src/pwa-extras.js`):
  - a `// build: vN` line and `SW_BUILD` that build.js checks;
  - it checks on start, on `online` and on `visibilitychange`;
  - "Update now" sends `SKIP_WAITING`, then reloads once.
- **Offline shell:** the market shows "You're offline. Showing nothing until you're back online." Your Orders and the PDF work from the device copy.

---

## Part F. Link check (VERIFIED, 2026-10-14)
| App | URL | Result |
|---|---|---|
| Desktop App – seiGEN Commerce Lite | https://desktoppos-preview.seigendc.workers.dev/ | 200, "seiGEN Commerce Lite", manifest |
| Mobile App – seiGEN Commerce Lite | https://mobilepos-preview.seigendc.workers.dev/ | 200, "seiGEN Commerce Lite", manifest |
| iTred Market Place | https://itred-preview.seigendc.workers.dev/ | 200, "iTred Market Place", **no manifest yet** (part E8) |
| Invoice Retail | https://iqwriter.seigendc.workers.dev/ | 200, "Quotation or Invoice", manifest |
| Invoice Contractors | https://iqwriterv10.seigendc.workers.dev/ | 200, "Quotation or Invoice", manifest |
| farmPLAN | https://farmplan.seigendc.workers.dev/ | 200, "farmPLAN Tobacco — Zimbabwe", manifest (a 581-byte app shell; the app itself is a script bundle) |

All six load. The two Invoice apps have the same page title.

---

## Part G. Questions (each with a recommendation)
1. **Does marking a line "fulfilled" change stock or create a sale in Commerce Lite?**
   **[Recommend: no, as you lean. It's status only; the vendor rings up the sale on Sell as usual.]** Automatic sales would double-count whenever the vendor also sells at the counter, and custom items have no product.
2. **Can the customer confirm receipt or dispute a line after the vendor's status arrives?**
   **[Recommend: yes, Confirm or Dispute (with a short reason) per line, and the vendor sees both.]** The vendor becomes the only one who sets the fulfilled quantity, so the customer's "Record delivery" (today's only fulfilment path) is removed.
3. **Can vendors reply to feedback, and does the customer see the reply?**
   **[Recommend: yes, one thread per order (`itred_order_messages`); the customer sees replies under the order with an unread mark.]** No public reviews in this step.
4. **Which tills see and update Orders Fulfillment?**
   **[Recommend: all tills of the business.]** Orders are addressed to the business; uids make repeats harmless, and every change is logged with its till. (Main only would leave remote counters unable to act on orders they physically fill.)
5. **Should the footer nav bar also show on desktop?**
   **[Recommend: no.]** On ≥ 768 px the same 5 links sit in the header, and the hamburger stays.
6. **New: what does the vendor see about the customer?**
   **[Recommend: the name and phone from the customer's iTred profile, never the email.]** The customer is told under "Send": "The vendor sees your name and phone number."
7. **New: one line per app for the Products page.** Please send six short lines; until then each shows only its name.
8. **New: the test vendor.** On live, the only vendor with published, unexpired listings today is **Chipo Clothing** (2 listings). There are no live listings for Weldone Ent. **[Recommend: use Chipo Clothing for the two-device test, or publish a few Weldone Ent listings first.]**
9. **New: Home moves to About.** **[Recommend: yes, as the requirement implies.]** Highlights, stats and Become an RPN stay reachable from the hamburger.

## Part H. Stage B outline (after "go iTred-B")
1. **Migration** `20261105120000_itred_order_fulfilment`: rollback, PGlite tests, backup, the SQL shown, "apply", recorded in `schema_migrations`.
2. **`src/shared/search.js`;** `buildItred()` assembles the files; iTred moves into a few source files plus the sprite, manifest, sw and `apps.json`.
3. **iTred screens** E1–E8; the deploy script gets the `preview:itred` target.
4. **Commerce Lite** D1–D3: the full suite, three builds, the sw build line bumped (v26 or the next free number), previews only.
5. **Tests** as listed in the prompt (iTred e2e at 390 and 1280 px including network image sizes; RLS; offline sync); screenshots; the two-device checklist.

**Out of scope:** payments, domains, the publish/token rules, `20260926160000`, production deploys.
