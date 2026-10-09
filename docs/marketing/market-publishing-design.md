# Market data packs to the Console, and token-paid publishing: Stage A design

Status: **design only, nothing built.** Waiting for "go Publish-B".
Date: 2026-10-09. Facts come from the repo (file:line) or from live (read-only). No secrets are in this document.

This replaces Part 2 ("Publish Portal inside the Console") of the Marketing prompt. Part 1, the Marketing fix, is done (build v13, commit d9be43c).

---

## A1. What exists today (VERIFIED)

### The pack (`.scl`, format `seigen.market_export` v1)

- **Built by** `marketBuildDoc` (src/marketing.js:257-285). It's JSON: `{format, format_version, export_no "MKT0001", created_iso, exported_at, vendor{install_id, business_name, whatsapp_number, city}, listings[...], totals, checksum}`.
  - Each listing: `source_product_id, product_name, price, currency, category, stock_quantity, exported_at, image_webp`.
  - `checksum` = sha256 of the JSON text without the checksum (src/marketing.js:286, 346).
- **Limits:**
  - at most **200 products** (`MARKET_MAX_PRODUCTS`, :33);
  - **one photo per product, 200×200 WebP at quality 0.8**, made on the device (src/market/market.js:295-325);
  - **150,000 characters** per photo at most (:228).
- **Size:**
  - a 200×200 WebP is usually 5–30 KB, so 7–40 KB as text;
  - **a typical 200-product pack is about 2–6 MB**;
  - **the hard maximum is about 30 MB** (200 × 150 KB). The old portal accepts up to 40 MB.
- **Where it's kept:** in the browser's IndexedDB (`seigen_market_files`, the latest pack per branch) and the `market_exports` table (number, counts, checksum, status `exported` / `sent`).
- **"Send via WhatsApp" today** (src/marketing.js ~:394-410): `shareDocFile`.
  - Phone: the share sheet.
  - Desktop: the file is saved to Documents/seiGEN/Marketing and a WhatsApp chat to Digital Commerce (+263789487287) opens.
  - Otherwise: a download.
  - Tapping "I've sent it" marks it `sent`. **The app can't see whether WhatsApp actually delivered it.**

### The old Publish Portal (tools/publish-portal; Node; `service_role` key from .env)

- **Screens:**
  - sign-in, with its own `portal_staff` accounts (Admin / Reviewer, scrypt, lockouts);
  - Upload: drop a `.scl`, preview the vendor and products, see blocks;
  - Publish;
  - History, with Unpublish;
  - Vendors & tokens: record or void a token;
  - Staff.
- **The check before publishing** (tools/publish-portal/scl.js): checksum, shape, at most 200 products, fields, each photo really WebP, the install ID registered in `cl_vendors`, and **an active token**.
- **The publish** (tools/publish-portal/supabase.js:59-106):
  1. upserts `vendors` by `install_id`;
  2. **uploads each photo to the public `listing-images` bucket**;
  3. inserts `vendor_listings` as `published`. **A trigger sets `expires_at = published_at + 7 days`** (itred_set_listing_expiry, 20260924120000:143-159);
  4. sets the product's older live row to `expired`.
- **Unpublish** sets the row back to `pending_review`.
- **Tokens:** `vendor_tokens` rows (start date, days, optional amount). These are **listing rights, recorded outside the ledger, with no RPN commission.**

### The parked migration 20260926160000 (retired to supabase/parked/ on 2026-10-09)

It added `vendor_tokens.rpn_id` and required a payment on new tokens. The same ideas are now covered properly:
- payments go through the Collections Ledger;
- the RPN is earned through the commission trigger.

**Recommendation:** it stays retired. The old `vendor_tokens` (0 rows) and `portal_staff` (2 rows) tables are dropped in a clean-up migration once the old portal is removed.

### On live (read-only)

**`vendor_listings`:**
- 24 rows: 21 `published`, 1 `expired`, 2 `pending_review`.
- **All are past `expires_at`**, so the public sees **0**. Checked through the API as `anon`.
- Columns:
  - `id`, `vendor_id` → `vendors` (ON DELETE CASCADE);
  - `source_product_id`, `product_name`, `price` (≥0), `currency` (char 3);
  - `category`, `stock_quantity` (≥0), `image_url`;
  - `exported_at`, `published_at`, `expires_at`;
  - `status` (`pending_review` / `published` / `expired`), `created_at`.
  - Check: a published row must have both dates.

**`vendors`** (iTred side): 3 rows, all test vendors (IVO Dist, Gara Bolts, Brechin Nursery).

**Row security:**
- **Public read of `vendor_listings` only where `status = 'published' and expires_at > now()`.**
- `vendors` is readable when it has live listings, or by a customer who has ordered from it.

**Grants:**
- `anon` and `authenticated` can SELECT `vendor_listings`, and `vendors` through **column grants** (id, business_name, whatsapp_number, city, created_at).
- **Only `service_role` can write.**

**Storage:**
- **`listing-images`**: public, 200 KB per file, `image/webp` only.
- **No Storage policies at all**, so only `service_role` can write.
- 23 objects, about 91 KB.

**Expiry:**
- **Already automatic for customers:** the iTred site filters `.gt('expires_at', now)` (src/itred/index.html:1078-1085), and row security enforces the same.
- The sweep `itred_expire_vendor_listings()` that sets `status = 'expired'` exists, but **nothing runs it**: no `pg_cron`.
- `itred_set_listing_expiry` **forces 7 days** on every publish. This must change for paid days.

**`.env`** holds `SUPABASE_SERVICE_ROLE_KEY` (name checked only; never printed). The old portal is its only user.

### Plumbing to reuse

- **Device authentication:** `cl_install_vendor(install, phrase, device key)`, as `cl_device_link_rpn` / `cl_licence_terms` use it. The app calls it with `terminalRpc` (src/terminal.js:64).
  - **The sync.js outbox is for small records** (and its RPN types are paused). A multi-MB pack needs its own sender, like the RPN link sender (rpn.js `trySendRpnLink`): the pack is already in IndexedDB.
- **Ledger:**
  - `cl_record_ledger_payment` (Cashbook in, 30-second guard);
  - `cl_reverse_ledger_payment`;
  - `cl_record_ledger_credit`.
  - Charges are written by functions (licences: `cl_licence_attach`).
- **Price-plans pattern:** versions with an effective date, SysAdmin-edited, snapshotted on each charge (20261013120000).
- **RPN commission:** an **AFTER INSERT trigger on `cl_ledger_entries`** (20261015120000). **Any payment earns commission, whatever it pays for**, so token payments earn it with **no new code**.
- **Edge Function pattern:** `issue-licence`.
  - It holds a secret, keeps the gateway's sign-in check on, and calls the database **with the staff member's own token**, so the database decides permissions.
  - It works in two steps: prepare, then attach.
- **Activity log:** `cl_activity_log`, written by every staff function.

---

## A2. Design

### 1. Sending the pack from the app: "Send to seiGEN"

**Transport (recommended): chunked, phone-checked database calls.** No Edge Function on the device side, and nothing new to deploy for the app.

| Call | What it does |
|---|---|
| `cl_device_pack_submit(install, phrase, key, p_pack_uid, p_header jsonb)` | The pack **without photos**: vendor, export number, checksum, listings (≤ 200), and the photo list (product ID → sha256 of the photo text). **Idempotent by `pack_uid`** (a UUID made at export), so a resend never makes a second pack. Answers: the photos the server still needs. |
| `cl_device_pack_image(install, phrase, key, p_pack_uid, p_source_product_id, p_image_webp, p_thumb_webp)` | **One product's photos per call** (≤ 150 KB full, ≤ 20 KB thumbnail). Checked against the announced sha256 and the WebP header. Idempotent. |
| `cl_device_pack_status(install, phrase, key)` | The device's packs and their states, for the status line. |

- **Device check:** install ID + phrase + device key, as every device call.
- **Resuming:** after a dropped connection, the next try asks `submit` again (same `pack_uid`) and sends only the photos still missing.
- **A pack is "received"** only when every announced photo has arrived **and the server has recomputed the checksum** on the reassembled pack.
- **Size limits:**
  - ≤ 200 products;
  - ≤ 150,000 characters per full photo, ≤ 20,000 per thumbnail;
  - the header ≤ 512 KB;
  - per device: at most **3 packs not yet decided** (received or in review). A newer pack **replaces** an older undecided one.
- **Photos stay private until published:** they're kept in a database table with no API access. Only published products' photos are copied to the public bucket.
- **Thumbnails: made in the app at export.** The app already resizes to 200×200 with a canvas; it adds a **100×100 WebP**. A database or Edge Function has no simple image library, and the phone already holds the decoded picture.
  - The pack format goes to **v2** (adds `thumb_webp` and `pack_uid`).
  - **v1 packs stay accepted** for the hand upload in the Console. They have no thumbnails; the list falls back to the full photo, scaled by the browser.

**App side** (src/marketing.js and src/market/market.js):
- **"Send to seiGEN"** replaces "Send via WhatsApp". **"Save file" stays** as a backup (question 4).
- **The status line on Marketing:**
  - **Waiting to send** (offline): "Saved. It will send when you're online."
  - **Sending… 34 of 120 photos.**
  - **Sent: waiting for review.**
  - **In review.**
  - **Published until 23 Oct 2026.**
  - **Not published:** "<reason staff gave>".
  - **Expired on 23 Oct.**
  - **Replaced** by a newer pack.
- **Sending:** at once when online, after every check-in, and when the device comes back online. It's the same pattern as the RPN link. A pack is never sent twice: `pack_uid`, and the server answers "already have it".
- **Plain errors:**
  - offline (saved, sends later);
  - "This device isn't registered with Digital Commerce yet. Finish registering in More → Settings";
  - "Too many packs waiting for review. Wait for Digital Commerce";
  - "A photo is too large; it was left out" (that product goes without a photo);
  - "The pack changed after it was made. Export it again".

### 2. Tokens

**Settings: `cl_token_prices`.** Like the price-plan versions.
- Columns: price per token, **days per token**, currency, effective from, set by, note.
- **SysAdmin only.** Seeded **empty**.
- While none is set, tokens can't be sold: "Token price not set yet".

**Buying tokens: `cl_sell_tokens(p_business_id | p_vendor_id, p_qty, p_note)`.**
- **Who:** the new **Token sales** module or SysAdmin. Staff only (question 2).
- It writes **one ledger charge** of `qty × price`, with notes "Tokens: 3 × USD 5.00".
- It also writes a **`cl_token_purchases`** row with the **snapshot**: qty, unit price, days per token, currency, ledger entry, sold by.
- **Double-tap guard:** an identical sale by the same staff member within 30 seconds returns the first.
- **Undoing:** a sale made in error is undone with the existing **Record credit** against its charge. A credit fully covering the charge **cancels the purchase's tokens** (purchase status `cancelled`).

**When tokens are paid: oldest charges are paid first (FIFO).**
- For the account (a business with all its tills, or a single device), payments minus reversals, plus credits, are applied to its charges in date order.
- **A token purchase is paid when everything up to and including its charge is covered.**
- Partly covered means **not yet usable**. Payments aren't linked to specific charges today, and this rule needs no new data.
- **With licences:** an older unpaid licence charge is covered first, so tokens bought after it wait until it's paid. That matches "pay your bills in order". The page always says why: "Paid tokens: 0. Licence #1004 (USD 15.00) is still unpaid".

**Balance per account** (`cl_token_balance(account)`):

| Figure | Meaning |
|---|---|
| bought | tokens and listing-days bought |
| paid | listing-days covered |
| used | listing-days used by publishing and extending |
| **available** | paid − used, in days and in tokens |

**Every movement is logged:** sale, cancel, use (publish or extend) and refund-on-unpublish (question 3).

**RPN commission:** recording the token payment with **Record payment** is a ledger payment, so the existing trigger creates the RPN line (onboarding or recurring). **Nothing is duplicated.** A test will prove it.

### 3. Publishing

**The queue: `cl_market_packs`.**
- **States:** `receiving` → `received` → `in_review` → `published` / `rejected` → `expired`, or `replaced` by a newer pack.
- **Each pack:** vendor, account, export number, checksum, counts, received at, reviewer, decision, reason.
- **Each product:** `cl_market_pack_items`, with a ticked flag. Photos: `cl_market_pack_images` (full + thumbnail, bytea).

**Review** (Console):
- vendor, city, RPN;
- every product with its thumbnail, price, stock and category;
- problems flagged, as the old portal's checks: bad currency, negative price, repeated ID, missing or bad photo;
- **untick** anything that shouldn't go live;
- **Reject** with a reason (shown in the app);
- **Publish** for N days.

**Publish (Edge Function `publish-pack`, the same pattern as `issue-licence`):**

| Step | What happens |
|---|---|
| 1. prepare | **`cl_market_publish_prepare(p_pack_id, p_days, p_items)`**, called with the **staff member's own token**. Checks the permission, the pack state, **enough paid listing-days**, and the items. It reserves nothing, and answers the item list and the storage names. |
| 2. photos | The function **copies each ticked photo** (full + thumbnail) from the pack to **`listing-images`**, using the service key it holds as a secret. Names are content-addressed: `<vendor>/<sha256>.webp`, so a re-upload is harmless. |
| 3. attach | **`cl_market_publish_attach(...)`**, again with the staff token, **in one transaction**: (a) **uses the days** (FIFO from paid purchases); (b) upserts the iTred `vendors` row; (c) **replaces** the vendor's live listing: current rows → `expired`, the ticked products inserted as `published` with `expires_at = now + days` and `image_url` / `thumb_url`; (d) marks the pack `published`; (e) writes the activity log. |

- **A double click:** a transaction lock on the pack, and the pack state, mean a second attach answers "already published".
- **If the photo copy fails halfway,** nothing is charged or published. Leftover photo files are harmless and overwritten next time.

**Recommendations:**
- **A republish replaces the whole listing,** and its **days carry over**: a new pack published while one is live keeps the current expiry and uses no tokens unless you also extend (question 3).
- **Extend** (`cl_market_extend(vendor, days)`): uses more paid days and moves `expires_at` on every live row.
- **Unpublish:** takes the listing off at once.
  - Rows → `expired`, pack → `expired`.
  - **Unused whole days go back** to the balance (question 3).

**Expiry is automatic:**
- **No scheduled job is needed for customers:** iTred's query and row security already hide anything past `expires_at`.
- The state the app sees (`expired`) is worked out from `expires_at` when read.
- **Recommendation:** also run the existing `itred_expire_vendor_listings()` sweep at each publish. That's tidiness only. No pg_cron.

**Change to the 7-day trigger:** `itred_set_listing_expiry` sets 7 days only when `expires_at` is empty. The rollback restores it exactly.

**Back to the app:** `cl_device_pack_status` answers each pack's state, decision reason and expiry. The app asks after each check-in (at most every 15 minutes) and when Marketing opens online.

### 4. Permissions (new modules; every check on the server)

| Action | Module |
|---|---|
| See the queue, open and review packs, reject | **`market_review`** |
| Publish, extend, unpublish | **`market_publish`** |
| Sell tokens (creates the ledger charge) | **`token_sales`** |
| Token price and days per token | **SysAdmin only** |
| Record the payment for tokens | existing **Collections Ledger** (as today) |

### 5. The Console page "Market Publishing"

**Queue:**
- filters: vendor, RPN, city, status;
- each pack's received time, products and photos;
- **the account's paid days available** ("covers 21 days").

**Pack review:**
- product grid with **thumbnails only** (never full photos in lists);
- the full photo on tap;
- untick;
- Reject (reason);
- **Publish**: days chosen; "uses 2 tokens (14 days), 7 days left after";
- **the refusal** when there aren't enough paid days: "Not enough paid listing days: 0 paid, 7 needed. Sell tokens and record the payment first."

**Tokens card** on the vendor:
- bought, paid, used, available;
- **Sell tokens** (qty, showing qty × price and days);
- the purchase list with paid / unpaid / cancelled.

**Published listings:**
- each vendor's live listing, with product count and **expires on**;
- **Extend** and **Unpublish**.

**Token price card:** SysAdmin edits; history.

**Layout:** phone and desktop, with empty, loading and error states, as on the other screens.

**Hand upload:** a staff member drops a `.scl` (v1 or v2) that a vendor sent another way. It enters the same queue through a staff call with the same checks, including **the install ID must be a registered device**.

### 6. Retiring the local portal

- **Next release:** the portal refuses to start unless `PORTAL_LEGACY=1` is set, and says "Use the Console's Market Publishing page".
- **The release after:** delete `tools/publish-portal/`, its test and `render.yaml`. Then a clean-up migration drops `portal_staff` and `vendor_tokens`.
- **Remove `SUPABASE_SERVICE_ROLE_KEY` from `.env`** once the portal is gone. The Edge Function gets its own copy from Supabase automatically; nothing local needs it.

### 7. Tests, risks and rollback

**Tests:**
- **App (harness + real browser):**
  - Send to seiGEN online;
  - offline it queues, then sends; a dropped connection resumes (only missing photos);
  - never twice;
  - each status shows in the app;
  - plain errors.
- **Database (PGlite):**
  - device checks on all device calls; checksum and photo checks; limits;
  - a newer pack replaces an undecided one;
  - publishing refused with no tokens, unpaid tokens, or an older unpaid licence; works once paid (FIFO);
  - days used correctly; `expires_at` = publish + days;
  - expired listings hidden from the public read;
  - extend and unpublish (with the refund rule);
  - the token price snapshot unaffected by a later price change;
  - **a token payment creates the RPN line at the right %**;
  - the credit cancels the purchase;
  - permissions per module; SysAdmin-only price; anonymous calls refused;
  - double-click publish and double-tap sale each happen once;
  - the 7-day trigger change;
  - the rollback restores the exact catalogue.
- **Edge Function:** a handler test with a fake Supabase, as for issue-licence, including **"the service key is never in a response"**.
- **Console (fake server):**
  - queue, review, Sell tokens, Publish with days, refusal, Published listings, Extend, Unpublish;
  - **a check that the service key appears nowhere in the Console's code or network traffic.**
- **End to end on preview:** app preview → send → Console preview → sell 1 token → record payment → publish → visible on an iTred **preview** → expires → each status in the app.
  - **Which iTred site:** a new `itred-preview` Worker built from `dist-itred`. The live iTred site isn't changed.

**Risks:**
- **Database size:** photos are kept in Postgres until decided. 30 MB at most per pack, and at most 3 undecided per device. Decided packs' photos are deleted 30 days after the decision (a step in each publish, no cron).
- **Request size:** PostgREST and the Supabase gateway accept bodies of a few MB. One photo per call keeps each call under ~200 KB.
- **The change to the 7-day trigger** affects the old portal too: it doesn't set `expires_at`, so it keeps getting 7 days.

**Rollback:** drops the new tables, functions and columns, and restores `itred_set_listing_expiry`. It refuses while token purchases or published packs exist (money history), like the earlier rollbacks. The Edge Function is removed separately.

---

## Questions for you (each with a recommendation)

1. **How many days does one token buy, and what does a token cost?** *You set both in the Console. I won't assume them.* For a starting point: 1 token = 7 days, matching today's 7-day listing. Your price.
2. **Can RPNs sell tokens to their vendors, or only staff?** *Recommend: only staff for now.* The sale is a ledger charge, and the RPN earns commission on the payment anyway. RPN self-service comes later.
3. **Republish, carry-over, refunds:**
   - Does a republish replace the whole listing? *Recommend yes.*
   - Do unused days carry over? *Recommend yes: a republish while live keeps the current expiry and uses no tokens.*
   - Does Unpublish give back unused whole days? *Recommend yes.*
4. **Keep "Save file" as an offline backup that staff can upload by hand?** *Recommend yes.*
5. **Free days at the start for a new vendor?** *Recommend none for now.* If you want some, set "welcome days" (e.g. 7) once per account in the token settings. It's a setting, not a promise.
6. **One iTred vendor per business or per till?** Today it's per device (`vendors.install_id`). *Recommend: per business.* Any till may send a pack; the business's **main till's install ID** is its iTred identity, and tokens belong to the business.
7. **The test listings on live** (24 rows, 3 vendors, 23 photos, all expired): *Recommend:* leave them. They're invisible. A clean-up can remove them with the old portal.
8. **When tokens are "paid":** oldest charges first (FIFO), so an unpaid older licence holds up newer tokens. *Recommend this.* Or tokens only (a token purchase counts as paid once payments since its date cover it), which ignores licences.
9. **Pack format v2** (thumbnails + `pack_uid`): devices on v14 or older keep sending v1 by hand. *Recommend:* v15 sends v2; the Console accepts both.

**STOP: waiting for "go Publish-B" and your answers.**
