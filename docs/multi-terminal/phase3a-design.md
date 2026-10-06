# Multi-terminal sync — Phase 3a design: product catalogue sync (main → every till)

Status: **Approved 2026-10-06 ("go Phase 3A-B"), with the owner's answers in §10. Stage B in progress.**
Branch: `phase3a-catalogue-sync` from `main` at `04010ff` (= production).
Status words: VERIFIED (read in code or the live database, read-only), PROPOSED (design), ASSUMED (not measured).

Baseline (VERIFIED, 2026-10-06): `main` at `04010ff` is green. All 57 `test/` suites and the 5 `supabase/tests` (PGlite) pass. Three browser suites (`terminal-deactivate-e2e`, `sw-precache-timeout-e2e`, `itred-orders-e2e`) failed once on page-load timeouts in the batch run and passed when re-run alone, as before.

Goal: main's product catalogue and prices flow through Supabase to every till of the business, offline-first. Sales, payments, stock and EOD do **not** sync in this phase (3b).

---

## 0. Decisions in one page

| # | Proposal | Why |
|---|---|---|
| P1 | Two server tables, `cl_catalogue_products` (per business, keyed by main's product `uid`) and `cl_branch_prices` (keyed by branch **uuid**), plus a pictures table `cl_catalogue_images`. One server sequence orders every change; pulls use it as the cursor. | Device clocks never order anything. One cursor covers products and prices. |
| P2 | Five phrase-checked `SECURITY DEFINER` RPCs: push catalogue, push branch prices, set a branch's price policy, pull, pull pictures. Every one refuses an inactive till. | Same pattern as `cl_device_checkin` / Phase 1–2. No table grants to anon. |
| P3 | **Only main-branch tills push products.** Per product, the last change to reach the server wins. | Main is authoritative. Only main's tills can write products, so a "conflict" can only be between two main tills, and the server decides. |
| P4 | A new local column **`products.cat_uid`** (the catalogue identity = main's product uid). A till's own product rows keep their own `uid`. | Giving a till's product main's `uid` would break merges: `mergeDatabase` matches products by `uid` first, across branches (`src/backup.js:335`), so main would map a remote's rows onto its own. VERIFIED. |
| P5 | **Push = "dirty" flags on products, not `sync_queue` rows.** A trigger marks a product changed; a pusher sends changed products in batches of 100. | `sync_queue` posts one REST insert per row into a table (`src/sync.js:140-181`); that needs table grants we don't give, and an Excel import of 6,000 rows would queue 6,000 rows. Flags coalesce repeated edits into one push. |
| P6 | Pull on start, on reconnect, every 5 minutes while open, and **Sync now**. Applied in batches of 200, each its own transaction, yielding between batches. Never touches `stock`. | A sale can run between batches; nothing waits on the network. |
| P7 | Soft delete everywhere once registered: **Delete Product** on a registered main becomes **Deactivate**. Deactivated products are hidden from Sell and the pick lists, and kept for history and reports. | No till loses history. |
| P8 | Pictures sync separately and lazily, as **thumbnails (≤ 200 px)**, and are **stored outside the SQLite file**, in their own IndexedDB store keyed by `cat_uid` + picture version. Per-till switch "Download product pictures": on for desktop, off for phones. (Changed by the owner, §10.) | A 6,000-SKU pull stays small, and pictures never make `persist()` heavier. See §5. |
| P9 | **Recommended for Q1:** on a registered till, allow selling at zero stock ("allow and flag negative"). Negative stock is flagged on Products and in Settings → Diagnostics. Suggest an opening stocktake on a new till. | Owner decision; without it a new till can't sell until 3b. |
| P10 | First sync shows a **report before anything changes** (like the catalogue-file import preview, which already downloads a backup first). | No silent changes on existing remotes. |
| P11 | Unregistered devices: no change at all. Every new path checks `isTerminalRegistered()`. | Same rule as Phases 1–2. |

---

## 1. Inspection (VERIFIED)

### 1.1 Products today
- **Schema:** `products(id, name, price, stock, low_threshold)` (`src/db.js:58-62`), plus columns added by `ALTER` (`src/db.js:284-291, 323`): `sku` (the shared product code), `image`, `branch`, `cost`, `description`, `created_ts`, `shelf`, `category`, `price_ts`. Phase 1 added `uid` (and the sync stamps).
- **`price_ts`** is kept by triggers `products_price_ts_upd/_ins` (`src/db.js:389-399`) on SQLite's own clock.
- **`branch`:** every product row belongs to one branch by **name**. Every screen filters `WHERE branch=currentBranch()` (40 queries in 17 files).
- **Main holds other branches' rows after a merge.** `mergeDatabase` inserts the source's products with their own `branch` and `uid`, matching an existing row by `uid` first, then `name+branch` (`src/backup.js:333-343`). Those rows are snapshots that are never updated (the Phase 2 integrity check already excludes them).
- **`receiveTransfer`** (legacy pending transfers, `src/dispatch.js:16-37`) creates a product at the receiving branch when no SKU/name matches. It's the one path where a remote creates a product, and it only fires for transfers from before Delivery Notes.

### 1.2 Every place a product is created, edited, deleted or re-priced
| Where | What | Who today |
|---|---|---|
| `src/products.js:120` | edit (name, sku, shelf, price, cost, low alert, image, description) | main only (`productModal` refuses remote, `:64`) |
| `src/products.js:125` | create with opening stock | main only |
| `src/products.js:138` | **hard delete** | main only |
| `src/import.js:223` / `:236` | Excel import: update fields / create | main only (the menu hides import on remote, `src/products.js:269`) |
| `src/purchasing.js:121` / `:123` | purchase: set cost / create product | main only (the Purchasing tab is hidden on remote, `src/router.js:296`) |
| `src/catalogue-app.js:144` / `:152` | catalogue **file** import: create / update name, image, price | remote only |
| `src/catalogue-app.js:196` | remote price edit (`branch_edits` policy, Admin passcode) | remote only |
| `src/dispatch.js:29` | legacy transfer receive creates a product | any |
| `src/backup.js:338` | merge inserts another branch's snapshot | main |
| `src/catalogue-app.js:29-48` | branch prices (`branch_prices` table, main side) | main only |

Receiving a DN/GRV (`src/receive-in.js`) and stocktake (`src/stocktake.js`) never create, rename or re-price a product. They only move stock, through `moveStock`.

### 1.3 Branch pricing today
- `branch_register` (main's list of destinations) has `price_mode` ∈ `follow_main | main_sets | branch_edits` (`src/catalogue.js:17`), plus `catalogue_ts/fp/mode/first_ts` and `prices_ts` (`src/db.js:314-328`).
- `branch_prices(dest_branch_name, code, price, updated_ts)` is keyed by branch **name** and product **code** (`src/db.js:175-178`). It is used only when the destination is `main_sets`.
- Effective price is `effectivePrice(main, branch, mode)` (`src/catalogue.js:40-43`). A branch price only counts in `main_sets`; otherwise main's price is used.
- A remote edits its own price only in `branch_edits`, with an Admin passcode (`applyRemotePriceEdit`, `src/catalogue-app.js:184-201`).
- Prices reach a remote **only** through a catalogue file (`commitCatalogueImport`, `src/catalogue-app.js:139-169`). In `follow_main`/`main_sets` the import overwrites local prices; in `branch_edits` it doesn't.
- **This maps directly onto the owner's flexible-pricing rule**, so Phase 3a keeps the three policies and moves them to the server.

### 1.4 Pictures
- **Main:** a picked photo becomes a **300×300 WebP data URI, quality 0.85** (`handleImageFile`, `src/products.js:2-23`), stored in `products.image`, inside the sql.js database blob.
- **DN and catalogue files** carry a **thumbnail**: longest side ≤ 200 px, WebP 0.7 (JPEG 0.72 where WebP can't be encoded), made by `makeThumb` (`src/dn-browser.js:6-53`).
- A remote that imported a catalogue stores that thumbnail as its `products.image` (`src/catalogue-app.js:145`).
- **Size (ASSUMED, to be measured in Stage B on real photos):**
  - 300 px WebP 0.85: about 15–30 KB each.
  - 200 px WebP 0.7 thumbnail: about 6–12 KB as a data URI.
  - 6,000 SKUs with pictures: about 90–180 MB at full size, or about 36–72 MB as thumbnails.
- The whole database is rewritten to IndexedDB on every `persist()` (Phase 0 report §1.1), so picture weight directly slows every save.

### 1.5 The zero-stock sale block
- `addToCart`: won't add a product with `stock<=0`, and caps quantity at stock (`src/pos.js:8-12`).
- `changeQty`: won't go above stock (`src/pos.js:17`).
- Mobile list: the Add chip is disabled with label "Out" at `stock<=0` (`src/pos.js:632`).
- Desktop: the Add button is disabled at `stock<=0` (`src/desktop/sales-desktop.js:99`), with the label "Out of Stock" (`:39`).
- `completeSale` doesn't re-check stock, and `moveStock` allows negative stock.

### 1.6 The outbox and RPC helpers
- `sync_queue` + worker (`src/sync.js`): `enqueueSync` → the worker POSTs each row as **one insert into a REST table** (`supabaseInsert`, `:140`). It has exponential backoff, a 60 s poll and a reconnect trigger (`:213-218`).
  - Only `sync_health_check` is active; `rpn_link` and `support_task` are paused because their tables don't exist.
- `terminalRpc(name, body)` (`src/terminal.js:61-80`) is the phrase + install + device-key RPC helper Phase 1–2 use. It returns `{ ok, data } | { ok:false, reason, code, message }`, has a 10 s timeout, and never rejects.

### 1.7 The live database (read-only, 2026-10-06)
- **`cl_` tables:** activation_codes, activation_pricing, activity_log, app_settings, branch_join_codes, branches, businesses, cashbook_entries, chart_of_accounts, join_failures, ledger_entries, modules, payment_voucher_lines, payment_vouchers, rpn, staff, staff_module_access, terminals, vendor_messages, vendors.
- **iTred / portal tables:** `customers`, `portal_staff`, `purchase_orders`, `purchase_order_items`, `rpn_onboarding_notes`, `vendor_listings`, `vendor_tokens`, `vendors`.
- **No product or catalogue table exists.** The only product-like table is iTred's `vendor_listings`, which is untouched by this design. New names all start `cl_catalogue_` / `cl_branch_prices`, so there are no collisions.
- **Storage:** one bucket, `listing-images` (public, iTred's).
- **Extensions:** pgcrypto, uuid-ossp, pgjwt, vault (no pg_net).
- **Data:** 3 businesses, 4 branches, 6 tills, all active.

---

## 2. Server (PROPOSED)

### 2.1 Tables
All tables have RLS on and `revoke all … from public, anon, authenticated`, as in Phase 1.

```sql
create sequence public.cl_catalogue_seq;

create table public.cl_catalogue_products (
  business_id   uuid not null references public.cl_businesses(id),
  product_uid   text not null check (product_uid ~ '^[0-9a-f]{32}$'),   -- main's products.uid
  code          text not null default '',                                -- products.sku, the shared code
  name          text not null check (length(btrim(name)) between 1 and 200),
  description   text not null default '',
  category      text not null default '',
  shelf         text not null default '',
  price         numeric(14,2) not null check (price >= 0),
  cost          numeric(14,2) not null default 0 check (cost >= 0),
  low_threshold integer not null default 5,
  active        boolean not null default true,                           -- soft delete only
  image_hash    text,                                                    -- sha-256 of the thumbnail; null = no picture
  change_seq    bigint not null,                                         -- nextval('cl_catalogue_seq') on every change
  last_op_id    text not null,                                           -- idempotency (§2.3)
  updated_by    uuid references public.cl_terminals(id),
  updated_ts    timestamptz not null default now(),
  primary key (business_id, product_uid)
);
-- one ACTIVE product per code per business (codes compared like the app's catCode: trimmed, lower case)
create unique index cl_catalogue_code_uidx on public.cl_catalogue_products (business_id, lower(btrim(code)))
  where active and btrim(code) <> '';
create index cl_catalogue_seq_idx on public.cl_catalogue_products (business_id, change_seq);

create table public.cl_catalogue_images (
  business_id uuid not null, product_uid text not null, image_hash text not null,
  data text not null check (data like 'data:image/%' and length(data) <= 120000),   -- a thumbnail data URI, about 90 KB max
  primary key (business_id, product_uid),
  foreign key (business_id, product_uid) references public.cl_catalogue_products
);

create table public.cl_branch_prices (
  business_id uuid not null, branch_id uuid not null references public.cl_branches(id),
  product_uid text not null,
  price       numeric(14,2) check (price >= 0),                          -- null = removed: main's price applies again
  change_seq  bigint not null, last_op_id text not null,
  updated_by  uuid references public.cl_terminals(id), updated_ts timestamptz not null default now(),
  primary key (branch_id, product_uid),
  foreign key (business_id, product_uid) references public.cl_catalogue_products
);
create index cl_branch_prices_seq_idx on public.cl_branch_prices (branch_id, change_seq);

alter table public.cl_branches add column price_mode text not null default 'follow_main'
  check (price_mode in ('follow_main','main_sets','branch_edits'));
alter table public.cl_branches add column price_mode_seq bigint not null default 0;
```
- **Stage B additions:** `cl_catalogue_products.image_bytes` (the thumbnail size, used for the till's download estimate), and a private helper `cl_catalogue_caller()` (not callable by devices) that every RPC uses to identify the till. Final SQL: `supabase/migrations/20261006120000_catalogue_sync.sql`.
- **Ordering:** every push takes `select … from cl_businesses where id = me.business_id for update` before calling `nextval`. Changes within a business then commit in sequence order, so a pull can't read seq 11 and later miss a seq 10 that committed after it. Pulls filter by business, so this per-business lock is enough.

### 2.2 RPCs
Every RPC starts like `cl_terminal_set_active`:
```sql
v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
select t.* into me from cl_terminals t where t.vendor_id = v.id;
if not found then raise 'This device is not a registered till'; end if;
if not me.active then return json_build_object('error','TERMINAL_INACTIVE'); end if;
```

| RPC | Who | Does |
|---|---|---|
| `cl_catalogue_push(auth…, p_rows jsonb)` | **main-branch tills only** (`cl_branches.is_main`), else refused | Up to 100 rows `{uid, code, name, description, category, shelf, price, cost, low_threshold, active, image_hash, image?, op_id, base_seq}`. Returns per row `{uid, status: applied / duplicate / refused, reason?, seq, overwrote}`. |
| `cl_branch_price_push(auth…, p_rows jsonb)` | main-branch tills: any branch of the business. Other tills: **only their own branch, and only while that branch's `price_mode = 'branch_edits'`** | Up to 200 rows `{branch_id, product_uid, price or null, op_id}`, with per-row results. |
| `cl_branch_set_price_mode(auth…, p_branch_id, p_mode)` | main-branch tills | Sets `cl_branches.price_mode` and bumps `price_mode_seq`. |
| `cl_catalogue_pull(auth…, p_cursor bigint, p_limit int ≤ 500)` | any active till | `{ products:[…], prices:[own branch only], price_mode, cursor, more }`. Rows with `change_seq > p_cursor`, ordered, at most `p_limit`. **`cost` only for main-branch tills** (Q3). |
| `cl_catalogue_images_pull(auth…, p_uids text[] ≤ 50)` | any active till | `[{uid, image_hash, data}]` |

Grants: `execute` to anon and authenticated, as for every other device RPC. `cl_branch_key` and the tables have no anon access.

### 2.3 Conflict and idempotency rule
- **Idempotent:** each local edit gets an `op_id` (random, 32 hex). If the row's `last_op_id` already equals it, the push is a replay: the result is `duplicate`, and nothing changes.
- **Conflict: the last change to reach the server wins, per product, and per branch price.** The row carries `base_seq`, the `change_seq` that till last saw.
  - If the server row has moved on since then, it is still applied, and the result says `overwrote: true`.
  - The pushing till's status line then shows "Your change to X replaced a newer change from T2."
- **How this fits "main is authoritative":** only main-branch tills can write products at all, so the only possible conflict is two main tills editing the same product, and either one is main. Remote tills can only write their own branch price, under the policy main chose.
- **Refusals per row:** `DUPLICATE_CODE` (another active product already has the code), `BAD_ROW` (validation), `NOT_MAIN`.

### 2.4 Rollback
Rollback file:
1. drop the 5 functions;
2. drop `cl_branch_prices`, `cl_catalogue_images`, `cl_catalogue_products` and the sequence;
3. `alter table cl_branches drop column price_mode, drop column price_mode_seq`.

It loses only the synced catalogue copy; every product still exists on the devices. The preflight aborts if any object already exists. As in Phase 2, the affected live objects are backed up first and the SQL waits for your "apply".

---

## 3. Device side (PROPOSED)

### 3.1 New local columns (additive `ALTER`, unregistered devices never read them)
| Column | Meaning |
|---|---|
| `products.cat_uid TEXT` | Catalogue identity = main's product uid. On main's own products it equals `uid`. |
| `products.cat_seq INTEGER` | `change_seq` last applied from the server |
| `products.cat_dirty INTEGER DEFAULT 0` | main-branch tills: changed since the last push |
| `products.cat_op TEXT` | the op_id of the pending push |
| `products.active INTEGER DEFAULT 1` | 0 = deactivated (soft delete) |
| `products.image_hash TEXT` | the catalogue picture's version (sha-256 of the thumbnail), from the server. The picture itself is **not** stored in SQLite on tills that pull it (§5) |
| `branch_prices.branch_uuid TEXT` | server branch id once known (the name key stays for the file flow) |
| settings `cat_cursor`, `cat_last_pull_ts`, `cat_last_push_ts`, `cat_last_error`, `cat_baseline_done` | |

### 3.2 Push (main-branch tills only, registered only)
- **Marking changes:** `AFTER INSERT` and `AFTER UPDATE OF name, sku, price, cost, description, category, shelf, low_threshold, image, active` triggers set `cat_dirty=1, cat_op=<new op>`. They only fire:
  - when settings say this device is a registered main-branch till;
  - for this branch's rows;
  - when the setting `cat_applying` is empty.
  The trigger reads settings, as the Phase 1 terminal-stamp triggers already do. So every write site in §1.2 is covered without editing each one, and pulled changes don't bounce back.
- **The pusher:** runs on the existing sync worker tick (60 s), on reconnect, and on Sync now.
  - It takes up to 100 dirty rows plus each one's thumbnail if `image_hash` changed, calls `cl_catalogue_push`, and clears `cat_dirty` only where the row's `cat_op` is still the one sent. An edit made during the push stays dirty.
  - Offline, or on any failure, it keeps the rows dirty and retries with `syncBackoffMs`. No duplicates, because of `op_id`.
- **Branch prices:**
  - On main, `setBranchPrice` and `setBranchPriceMode` (`src/catalogue-app.js:11,29`) also mark a dirty row in a small local `branch_price_outbox(branch_uuid, cat_uid, price, op_id)`, pushed the same way.
  - On a `branch_edits` remote, `applyRemotePriceEdit` writes its own branch price there too.
  - Destinations not yet on the server (no join code issued, so no `cl_branches` row) wait, and the status line says "N branch prices wait until <branch> is added on Digital Commerce."
- **Deactivate:**
  - On a registered main, the product screen's **Delete Product** becomes **Deactivate product**, which sets `active=0` (trigger → push).
  - A **Reactivate** filter appears on the Products list.
  - Unregistered devices keep today's hard delete.

### 3.3 Pull (every registered till)
- **When:** at boot (after `startDeviceCheckin`), on `online`, every 5 minutes while open, and **Sync now**. One pull at a time.
- **How:** `cl_catalogue_pull(cursor, 500)` repeats while `more` is true.
- **Applying a page** (the setting `cat_applying='1'`, batches of 200, each `BEGIN…COMMIT`, then `await` a tick so a sale can run in between):
  - **Product:**
    - match by `cat_uid`, then by code among this branch's products that have no `cat_uid`;
    - update name, sku, description, category, shelf, low_threshold, `active`, `image_hash`, `cat_seq`;
    - set **price** = effective price (§3.4);
    - set **cost** only on main-branch tills;
    - **never `stock`**.
  - **No match:** insert with `stock 0`, `cat_uid`, `branch = this branch`. `recordStockMovement` writes nothing for 0, so the ledger stays exact.
  - **Branch price rows / `price_mode`:** stored, then the affected products' prices are recomputed.
- **Cursor:** saved only after the page's last batch commits. A crash mid-page re-applies the page, which is idempotent.
- **Pictures:** after the text sync, and only when the till's picture switch is on, a background loop fetches thumbnails that are new or changed, 50 per call, only while online and the app is open. It never blocks the till (§5).

### 3.4 Effective price on a till
| Policy for this branch | Price shown and sold |
|---|---|
| `follow_main` | main's price |
| `main_sets` | the branch price if one is set, else main's price |
| `branch_edits` | the branch price if one is set (set by this branch's Admin), else main's price |

The same `effectivePrice` rule as today (`src/catalogue.js:40`), extended to `branch_edits`. A main-branch till always uses main's price.

### 3.5 Remote tills: what's hidden
- Non-main tills already can't create, edit, import or delete (`src/products.js:64, 218-229, 269`; `src/router.js:294-297`).
- Once registered, a remote till also hides **Get catalogue** (the file import) and shows **Sync now** instead. Two sources of truth would fight.
- The Admin price edit stays, only under `branch_edits` (Q2).
- `receiveTransfer` creating a product (legacy pending transfers) is refused on a registered remote, with a message to ask main to add the product.
- Main-branch tills (T1, T2 at main) keep full product editing; they all originate the catalogue.

### 3.6 Soft-delete filtering
`active=1` is added to the **pick lists** only:
- Sell search (`searchProducts`, `src/pos.js:1`) and the desktop list;
- the Products list (with a "Show deactivated" toggle on main);
- the Dispatch product picker, Stocktake list, Purchasing picker and Marketing picker.

Reports, the ledger, receive matching and history keep reading every row.

### 3.7 Why not `sync_queue`
Evidence: `pushOneSyncRow` (`src/sync.js:163`) does `supabaseInsert(table, payload)`, one PostgREST insert per row into a table named after the type. It has no RPC path and no coalescing. Using it would mean:
- direct table grants for anon, which breaks the owner rule;
- or a second worker path inside it anyway;
- and an Excel import of 6,000 products queuing 6,000 rows.

The dirty-flag pusher reuses `isOnline`, `syncBackoffMs`, the worker tick and `terminalRpc`, so the delivery machinery is shared and only the "what to send" differs.

---

## 4. First sync / baseline (PROPOSED)

### 4.1 Main (first registered main-branch till to sync)
- Sets `cat_uid = uid` on this branch's products, then marks them all dirty.
- **Excluded:** every row whose `branch` isn't this device's branch. Merged-in snapshots of other branches are never pushed. That's the same filter `mainProducts()` uses (`src/catalogue-app.js:18`), and the trigger only marks this branch's rows.
- **Report before pushing:** N products to upload, N with pictures, plus:
  - **no code:** still uploaded, but flagged ("branches that already have this item can't match it until it has a code");
  - **duplicate code:** not uploaded until fixed. The server would refuse it anyway, and `checkCatalogueProducts` (`src/catalogue.js:49`) already finds these.
- A second main-branch till (T2) skips the upload. It **pulls** first and matches its products by code, like a remote. Its unmatched products are listed and kept local.

### 4.2 An existing remote device (has products, registered, first pull)
A **report screen** opens before anything is applied, built like `planCatalogueImport` (`src/catalogue.js:197`). A backup is downloaded first, as the catalogue-file import does.

| Case | What happens |
|---|---|
| Code matches main | linked (`cat_uid` set); name, description and picture take main's; **stock untouched** |
| Price differs | `follow_main`/`main_sets`: main's (or the branch price) wins and is listed. `branch_edits`: the local price is kept and offered as this branch's price (pushed only after an Admin confirms) |
| Main product not here | added with stock 0 |
| **Remote-only product** (no code match at main) | **kept, unchanged and unlinked**, listed as "Only at this branch: ask main to add it, or it stays local". Not pushed. It can be sold as today. |
| Duplicate codes locally | not linked; listed ("fix the duplicate code") |

The report stays available in Settings → Business & Terminals → **First sync report** until dismissed.

### 4.3 A brand-new till
No products, so nothing to report. It pulls everything, and the stock question (§6) applies.

---

## 5. Pictures (PROPOSED)

| Option | First pull for 6,000 SKUs | Device storage | Notes |
|---|---|---|---|
| Inline full 300 px in the pull | about 90–180 MB | same, in the DB blob | slow pull; every `persist()` rewrites it |
| Supabase Storage | text only + lazy files | same as stored | needs Storage policies for anon uploads, which breaks "RPCs only"; public URLs expose pictures |
| **Separate thumbnail pull (recommended)** | text about 2–3 MB (ASSUMED: about 400 B per product as JSON), then thumbnails lazily, only when the hash changed | about 36–72 MB for 6,000 thumbnails | Same size remotes already store from catalogue files. Pictures never delay prices. |

- Main pushes the 200 px thumbnail (made with `makeThumb`) and keeps its own 300 px picture locally, in `products.image` as today.

### 5.1 Approved storage rule (owner, 2026-10-06; replaces Q4)
- **Pictures pulled from the catalogue are never stored in the SQLite database**, because it is re-saved whole on every `persist()`. They go in a separate IndexedDB database, `seigen_cat_pics`, store `pics`, key `<cat_uid>|<image_hash>`, outside the sql.js file. That's the same approach as the DN file store (`src/dn-browser.js:64-67`).
- **Picture version** = `image_hash`, the sha-256 of the thumbnail data URI. A changed picture has a new key, and the old key for that `cat_uid` is deleted.
- **Download** only pictures whose `<cat_uid>|<image_hash>` key is missing, in the background after the text sync. A till that turns pictures off downloads nothing.
- **Before the first picture download** the till shows the estimated size, the sum of the server's `image_bytes` for the missing pictures: "Download 1,204 product pictures (about 9.8 MB)?" with **Download** and **Not now**. Later downloads, of only new or changed pictures, run without asking.
- **Per-till switch "Download product pictures"** in Settings → Business & Terminals. Default **on** for the desktop build (`dist-tauri`, `isDesktopBuild()`) and **off** for phones (`dist-pwa`). Turning it off keeps pictures already downloaded, and a **Remove downloaded pictures** button frees the space.
- **Display:** where a product picture is shown (Sell list `src/pos.js:625`, desktop list `src/desktop/sales-desktop.js:90`, Dispatch picker `src/dispatch-out.js:245`), a product with its own `products.image` shows it as today. Otherwise a product with a downloaded catalogue picture gets a placeholder `data-cat-pic="<cat_uid>|<hash>"`, filled from IndexedDB after rendering by one `MutationObserver`. Missing pictures show the existing placeholder icon.
- **Real sizes** are measured in Stage B and reported (§11).

---

## 6. Stock on a newly joined till (Q1)

| Option | For | Against |
|---|---|---|
| **A. Registered tills may sell at zero stock; negative stock is flagged** | Matches the owner decision. The till sells on day one. Stock stays exact through the ledger, so 3b can reconcile it. | Shows negative numbers until stock is counted or 3b arrives |
| B. Opening stock count on the new till (the existing Stocktake) | Real numbers | Must be done before the first sale; a shop with 6,000 SKUs can't |
| C. Pull a branch stock snapshot read-only | Numbers without counting | There's no server stock yet (3b), so this would mean building half of 3b now |

**Recommendation: A, plus suggest B.**
- On a **registered** till, `addToCart`, `changeQty` and both Add buttons stop blocking at zero (`src/pos.js:10,11,17,632`, `src/desktop/sales-desktop.js:99`). The label shows "0 left" or "−2" in red instead of "Out".
- Products shows a "Negative stock" pill, and Settings → Diagnostics adds "N products below zero".
- A new till's Settings card suggests "Count your opening stock (More → Stocktake)".
- **Unregistered devices keep the block exactly as today.**

---

## 7. UI (PROPOSED)
- **Settings → Business & Terminals** (registered tills), under the till table:
  - **Catalogue line:** "Catalogue synced 10:42 · 1,204 products · 3 changes waiting to send", or the error line.
  - **Sync now** button: pushes, then pulls, with progress "Syncing… 400 / 1,204". Disabled while running.
  - **First sync report** link (§4).
  - On main: "Branch prices: 12 waiting until Murehwa is on Digital Commerce" when that applies.
- **Messages** (plain English, through the existing `terminalProblemText` style):
  - offline: "You're offline. Products and prices will update when you're back online. Selling isn't affected."
  - wrong phrase: "This device's activation phrase doesn't match. Check Settings → Activation secret phrase."
  - deactivated: the Phase 2 wording.
  - server error: "Digital Commerce couldn't sync the catalogue (<reason>). It will try again."
- **Toast:** reuse the sync toast pattern for "Catalogue updated: 14 products changed" after a background pull, at most once per pull.
- **Remote till Products screen:** the existing remote box gets "Products come from your main branch. Last update 10:42." plus Sync now.
- Orange theme, light only; existing `.card`/`.box`/`.pill`/`openModal`.

---

## 8. Tests, risks, rollback

### 8.1 New tests (Stage B)
- **App:** `test/phase3a-catalogue-sync.test.js` (harness), with an in-memory fake of the 5 RPCs **backed by the real migration in PGlite**, so device and server rules are tested together:
  - push from main → pull on T2 (same branch) and on a remote till;
  - edit, re-price, deactivate;
  - branch price with `main_sets` and `branch_edits`, and other branches unaffected;
  - a remote push is refused server-side;
  - offline queue then online with no duplicates;
  - a pull never changes `stock`;
  - the first-sync report;
  - unregistered unchanged;
  - the picture hash and lazy fetch;
  - the conflict "overwrote" result;
  - a sale between apply batches;
  - zero-stock selling on registered tills only.
- **Server:** `supabase/tests/catalogue-sync-test.js` (PGlite):
  - main-only push, idempotent replay, duplicate-code refusal;
  - the cursor never misses a concurrent change;
  - cost hidden from non-main;
  - the branch price permission matrix;
  - an inactive till refused;
  - the rollback.
- **Browser:** `test/catalogue-sync-e2e.test.js` (Playwright with `terminal-fake.js` extended): Sync now, the status line, the report, and the remote Products screen at 390 px and 1280 px, with screenshots.

### 8.2 Existing tests expected to change
- `test/pos-search-e2e`, `cart-drawer-e2e`, `line-item-discount-e2e`: none expected. They run unregistered, so the zero-stock block stays.
- `test/terminal-fake.js`: gains the 5 RPCs, the `price_mode` column and the till permissions.
- `test/harness.js`: exposes the new functions.
- `test/phase4.test.js` "existing remotes are not modified by the upgrade": the new columns arrive at the first `migrate()` in `makeApp`, so before/after snapshots should still be equal. **Expected unchanged; if not, the reason will be listed.**
- `test/catalogue.test.js`: unchanged (unregistered). New cases for "file import hidden on a registered remote" go in the new suite.
- `test/terminal-identity.test.js`: unchanged. `SYNC_UID_TABLES` doesn't change, because `branch_price_outbox` is local-only.

### 8.3 Risks
1. **DB blob size from pictures** on big catalogues (§5). Mitigated by thumbnails and Q4; a separate picture store (as the DN files use IndexedDB) is a later option if needed.
2. **Main's hard delete becomes deactivate** on registered mains: owners must learn "Deactivate".
3. **First sync on existing remotes** changes names and prices. Mitigated by the report and the backup first.
4. **Selling at zero on registered tills:** negative stock appears until counted or 3b. Flagged, not hidden.
5. **Two main tills editing the same product:** the last arrival wins and the loser sees "replaced".
6. **Codes:** the server enforces one active product per code; main's duplicate codes must be fixed before they sync.
7. **The legacy `receiveTransfer` product creation** is refused on registered remotes, so old pending transfers for unknown items need main to add the item.
8. **Server load:** a 6,000-row first push is 60 calls of 100; a first pull is 12 pages of 500. Fine for the free tier (ASSUMED).

### 8.4 Rollback
- **Server:** §2.4.
- **App:**
  - Production keeps running Phase 2 until Phase 3a is promoted.
  - The rollback command (`wrangler rollback`) is recorded at deploy.
  - Local columns are additive and ignored by Phase 2 code.
  - A device that already applied pulls keeps its products (stock untouched).

---

## 9. Questions for the owner
- **Q1 (stock on a new till):** recommend **A** (registered tills may sell at zero, negative flagged) plus a suggested opening stocktake. §6.
- **Q2 (branch's own price):** recommend keeping today's rule. A branch till edits its own branch's price **only while main has set that branch to "this branch edits its own prices"**, and only with the branch **Admin passcode** (local check, as today). The server enforces the policy, but it can't see staff, so "Admin only" stays a till-side rule. Main and its tills can set any branch's price in "main sets each branch's prices".
- **Q3 (cost price):** recommend **remote tills don't receive cost**. The server only returns cost to main-branch tills. Today remotes never get cost (catalogue imports write `cost 0`, `src/catalogue-app.js:145`), and the Products screen says costs are managed by main.
- **Q4 (pictures):** thumbnails only, lazily, with a per-till "Download product pictures" switch defaulting to on? §5.
- **Q5 (catalogue files):** once a branch is registered, should main still be able to build catalogue **files** for it? Recommend: hidden for registered branches, kept for unregistered ones.
- **Q6 (codes):** must every product have a code to sync? Recommend no: uncoded products sync by uid to new tills, but existing remotes can't match them, and the first-sync report says so.
- **Q7 (deactivate wording):** on a registered main, "Delete Product" becomes "Deactivate product" (reversible). OK?

---

## 10. Owner's answers (2026-10-06)
- **Q1 accepted:** registered tills may sell at zero stock. Negative stock is flagged on Products and in Settings → Diagnostics. Unregistered devices keep the block.
- **Q2 accepted:** a branch edits its own price only under "this branch edits its own prices", with its Admin passcode. Main-branch tills set any branch's price under "main sets each branch's prices".
- **Q3 accepted:** no cost price to remote tills (the server returns cost only to main-branch tills).
- **Q4 changed:** pictures are stored outside SQLite, in their own IndexedDB store keyed by `cat_uid` + picture version. Only new or changed ones are downloaded, in the background after the text sync, with the estimated size shown before the first download. The per-till switch defaults on for desktop and off for phones. Real sizes are measured and reported. See §5.1.
- **Q5 accepted:** "Build catalogue" files are hidden for registered branches and kept for unregistered ones.
- **Q6 accepted, plus:** main's first-sync report also **lists main's products that have no code**, so codes can be added before remotes sync.
- **Q7 accepted:** "Delete Product" becomes "Deactivate product" (reversible) on a registered main.

---

## 11. Stage B: real picture sizes (measured 2026-10-06)
**Method:** the 23 real product photos in the live project's iTred listing bucket (read-only GETs), run through the app's own pipeline in Chromium:
- **picture:** 300 px square WebP 0.85, as `handleImageFile`, `src/products.js`;
- **catalogue thumbnail:** longest side 200 px, WebP 0.7, as `makeThumb`, `src/dn-browser.js`.

| As a data URI | min | median | mean | max |
|---|---|---|---|---|
| 300 px picture (main's `products.image`) | 3.4 KB | 6.2 KB | 7.5 KB | 19.5 KB |
| 200 px thumbnail (what syncs) | 1.8 KB | 3.2 KB | 3.6 KB | 8.7 KB |

- **For 6,000 products with pictures:** about **21 MB** of thumbnails at the mean, and at most about 52 MB at the largest size seen. The full pictures would be about 45 MB at the mean.
- These sizes are well under my Stage A estimate (§1.4).
- On tills the thumbnails sit in the separate `seigen_cat_pics` IndexedDB store, so the SQLite file and every `persist()` are unaffected.
- **Text-only first pull:** about 0.3–0.4 KB per product as JSON, so about 2 MB for 6,000 products (ASSUMED from the PGlite test rows, not measured live).
