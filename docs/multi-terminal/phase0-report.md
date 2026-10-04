# Multi-terminal sync — Phase 0 inspection report

Commit inspected: `7edabe5` (main). Date: 2026-10-04.
Scope: inspection only. No source, schema or database change was made. The only new file is this report.

Status words: **VERIFIED** (read in code or the live database), **IMPLEMENTED** (n/a in Phase 0), **UNVERIFIED**, **ASSUMED**, **BLOCKED**.

Line numbers are per source file (`src/<file>:<line>`), not positions in the concatenated build.

---

> **Update 2026-10-04:** the owner answered Q1–Q4. The decisions and the follow-up checks are in **§8**, and the revised plan is in [phase1-plan.md](phase1-plan.md). The blocking item below (business identity) is resolved by a new `cl_businesses` table.

## 0. Summary — what matters for Phase 1

1. **`cl_vendors` is one row per install (device), not one row per business.** VERIFIED (live function body, §3.1). A business with a main and two remote devices today has three `cl_vendors` rows, each with its own billing history (`cl_activation_codes`, `cl_ledger_entries`, `cl_vendor_messages` all FK to `cl_vendors.id`). "Business = the existing `cl_vendors` row" only works if we decide that the main device's row is the business, and say what happens to remote devices' own rows. **Owner decision needed before 1A** (see §7, Q1). As the brief asked, I'm stopping here and flagging it.
2. **`cl_device_checkin` creates a new `cl_vendors` row for any install_id it hasn't seen, with whatever phrase is sent.** VERIFIED. A joined terminal (new install_id) would create a second vendor on its first boot check-in. That breaks decision 3. So `cl_device_checkin` **has to change** in Phase 1 (look up `cl_terminals.install_id` first). The diff must be approved before it's applied.
3. **The secret phrase is not a business identifier.** VERIFIED: 21 vendors, 9 distinct phrases (case-insensitive), 3 phrase groups shared by more than one vendor. It is stored in plain text per vendor row and compared **case-sensitively** (`<>`). The activation code formula upper-cases it (`src/activation.js:2`), so the two checks treat case differently. The join flow can't find the business by phrase alone. The join code must identify the branch (and so the vendor), and the phrase is then checked against that vendor's stored phrase.
4. **`install_id` is 4 characters** (`uid4()`, alphabet of 32 → 1,048,576 values; `src/setup.js:135`, `src/db.js:428`). All 21 live rows have length 4. With shared phrases, a collision means a new device **silently takes over another shop's vendor row** (the update branch of `cl_device_checkin` overwrites business name, phone, location and device code, and hands over lock flags and messages). This already affects today's single-device shops, and the risk grows with every extra terminal. Decision 7 / brief 1B say not to change `install_id`, so I'm raising it rather than fixing it (§7, Q3).
5. **The POS blocks sales on stock today.** `addToCart` refuses when `stock<=0` and caps qty at stock (`src/pos.js:10-11,17`). The Add button is disabled at `stock<=0` (`src/pos.js:625`, `src/desktop/sales-desktop.js:99`). This conflicts with decision 1. Out of scope for Phase 1 (no behaviour change allowed), but Phase 4 must remove it.
6. **The existing outbox can't deliver anything.** VERIFIED live: tables `rpn_link`, `support_task` and `sync_health_check` don't exist in the live project. Every queued row fails with an HTTP error and retries forever (backoff capped at 30 min, `src/sync.js:114-119`). Harmless to selling, but "Cloud sync" in Settings will show a permanent backlog for any shop that saved an RPN link.
7. **There are no shared insert helpers.** Every insert is a raw `run("INSERT INTO …")` at the call site (§2.7: about 60 sites over 20 tables). For 1B I recommend stamping `uid` with **SQLite `AFTER INSERT` triggers created in `migrate()`**. There's direct precedent: the `products_price_ts_*` triggers at `src/db.js:362-367`. But `mergeDatabase` must then **carry the source row's uid**, otherwise the same sale gets different uids on two devices. Merged rows must also **not** be stamped with the receiving device's `terminal_id`.
8. Baseline: all three builds succeed. Of 51 `test/` suites, results are in §5. The 3 `supabase/tests` pass in local PGlite mode.

---

## 1. Local data layer

### 1.1 Storage and `persist()` — VERIFIED
- The whole database is one sql.js (WASM) database, exported as a single blob into IndexedDB `seigen_lite_db` / store `kv` / key `dbfile` (`src/state.js:125`, `src/db.js:1-27`).
- `persist()` = `idbSet(db.export())` (`src/db.js:27`): it rewrites the **entire** database on every call. About 90 call sites. Many are fire-and-forget (not awaited, e.g. after a sale at `src/pos.js:547`). There's no timer, `beforeunload` or `visibilitychange` flush. The only `setInterval` in the app is the sync worker (`src/sync.js:202`).
- Boot: `initDB()` (`src/db.js:417-426`) loads the blob, then runs `SCHEMA` (all `CREATE … IF NOT EXISTS`), then `migrate()`, then `backfillBranch()` if setup is complete. Then `startSyncWorker()`, `startDeviceCheckin()` and the activation check (`src/main.js:17-30`).
- Migration pattern: a list of `ALTER TABLE … ADD COLUMN`, each run inside `try{}catch(e){}` so re-runs are no-ops (`src/db.js:237-355`), followed by idempotent backfills and triggers (`src/db.js:356-391`). `migrate()` also runs on imported files before merge/replace (`src/backup.js:165,322`).

### 1.2 Full local schema (base `SCHEMA` + every `ALTER`) — VERIFIED from `src/db.js:56-391`

Primary keys: **not every table uses `INTEGER PRIMARY KEY AUTOINCREMENT`** (see conflict C2).

| Table | PK | Columns (base, then ALTER-added) |
|---|---|---|
| settings | `key TEXT` | key, value |
| products | id AI | name, price, stock INT, low_threshold · +sku, image, branch, cost, description, created_ts, shelf, category, price_ts |
| sales | id AI | ts, subtotal, discount, total, method, customer_id · +branch, discount_reason, discount_approved_by, discount_status, markup, markup_reason, voucher_amount, payment_ref, user, doc_ref |
| sale_items | id AI | sale_id, product_id, name, price, qty · +cost, discount |
| sale_payments | id AI | sale_id, method, amount · +currency ('BASE'), rate, tendered_amount — index ix_sale_payments_sale |
| currencies | id AI | code, name, symbol, rate, active (device-local, not merged) |
| eod_sessions | id AI | date, expected_cash, counted_cash, variance, notes · +branch, ts, status ('closed'), opening_float, started_ts, started_by, started_staff_id, closed_ts, closed_by, closed_staff_id, printed_ts — index ix_eod_sessions_branch_date_status |
| customers | id AI | name, phone · +branch, address, town_city, suburb |
| payouts | id AI | ts, amount, reason · +branch, user |
| credit_payments | id AI | customer_id, ts, amount, note · +branch, user |
| stock_received | id AI | ts, product_id, name, qty, note · +branch, user, dn_branch_id, dn_no, grv_no, adj_branch_id, adj_no |
| audit_log | id AI | ts, branch, user, action, product_name, details |
| stock_requests | id AI | ts, branch, user, item_requested, customer_name, customer_phone, qty_wanted, notes, fulfilled |
| stock_transfers | id AI | ts, from_branch, to_branch, product_name, sku, qty, note, user, status, received_ts, received_user · +dn_no, dn_branch_id |
| stocktakes | id AI | branch, team_names, start_date, end_date, status, cutoff_ts, created_by, created_ts |
| stocktake_counts | id AI | stocktake_id, product_id, product_name, sku, system_qty, counted_qty, counted_ts, counted_by |
| purchases | id AI | ts, branch, user, supplier, product_id, product_name, sku, qty, unit_cost, total_cost, note |
| staff | id AI | name, role, passcode, branch, active, created_ts · +pin_hash, pin_salt, pin_fail_count, pin_locked_until |
| vouchers | id AI | customer_id, amount, branch, earned_ts, status, redeemed_ts, redeemed_sale_id |
| doc_counters | (branch_id, doc_type) | last_no |
| dispatch_docs | (dispatch_branch_id, dn_no) | dispatch_branch_name, receive_branch_name, direction, grv_no, created_ts · +imported_ts, received_ts, received_iso, received_by, variance_json, variance_ts, status, file_name, line_count, unit_total, created_iso, cancel_no, cancelled_ts, replaces_dn_no, replaced_by, cancel_kind, stock_posted, cancel_nonce |
| dn_events | id AI | event_key UNIQUE, dn_branch_id, dn_no, event_type, actor_branch_id, actor_branch_name, dn_from_name, dn_to_name, event_ts, grv_no, detail_json |
| stock_adjustments | id AI | branch, branch_id, adj_no, product_code, product_name, qty_delta, reason, note, by_user, authorised_by, ts, dn_branch_id, dn_no — UNIQUE (branch_id, adj_no) |
| dn_cases | id AI | case_no, dn_branch_id, dn_no, kind, state, nonce, plan_json, replaced_by, override, note, started_ts, started_by, authorised_by, posted_ts, posted_via, acked_ts — UNIQUE (dn_branch_id, case_no) |
| branch_register | id AI | name UNIQUE NOCASE, whatsapp · +price_mode, catalogue_ts, catalogue_fp, catalogue_mode, prices_ts, catalogue_first_ts |
| branch_prices | (dest_branch_name, code) | price, updated_ts |
| sync_queue | id AI | record_type, record_key, tenant_id, payload_json, status, attempts, next_attempt_ts, created_ts, updated_ts, synced_ts, last_error — index ix_sync_queue_due |
| market_exports | id AI | branch, export_no, file_name, product_count, image_count, bytes, checksum, status, exported_ts, sent_ts |
| print_queue | id AI | label, bytes_json, status, attempts, last_error, created_ts, updated_ts |

Triggers: `products_price_ts_upd`, `products_price_ts_ins` (`src/db.js:362-367`).
Backfills on every boot: products.created_ts / price_ts, `backfillDnLinks` (`src/db.js:396-410`), branch_register.catalogue_first_ts, sale_payments for legacy sales, sale_payments.tendered_amount, and `backfillBranch` (fills blank `branch` on 8 tables with `currentBranch()`, `src/db.js:411-415`).

No `uid`, `terminal_id`, `business_id` or `branch_uuid` exists anywhere in `src/` today (VERIFIED by grep). There is a v4 UUID helper with a `getRandomValues` fallback in the separate Field Guide app (`src/fieldguide/outbox.js:142-149`), a ready pattern for `newUid()`.

### 1.3 Identity settings — VERIFIED
| Key | Set where | Notes |
|---|---|---|
| `install_id` | `src/setup.js:135` = `uid4()` (4 chars) | Device code = `install_id-C<cycle>` (`src/activation.js:23-28`); sent as `p_install_id` |
| `branch_id` | `getBranchId()` `src/docnum.js:52-56` = `"B-"+uid4()+uid4()` | **Reset at every Setup finish** (`resetBranchId()`, `src/setup.js:136`, `src/docnum.js:104-106`). Kept across Replace (`keepDeviceIdentity`, `src/backup.js:179-185`) |
| `branch_name` | Setup step 1 (optional), Settings | Locked once non-empty (`branchNameLocked`, `src/dispatch-out.js:405-407`). If blank, `currentBranch()` falls back to `shop_name`, then `"Main"` (`src/db.js:49`) |
| `branch_type` | Setup; **Settings can switch main↔remote at any time** (`src/settings.js:111`) | `isRemote()` `src/db.js:50` |
| `secret_phrase` | Setup; Settings "Save phrase" (`src/settings.js:127-138`) | Used by activation and check-in |
| `dc_vendor_id`, `dc_vendor_status`, `dc_lock_*`, `dc_messages`, `dc_checkin_*` | `src/devicecheckin.js:131-137` | From check-in reply |

---

## 2. Inventories

### 2.1 Every write to `products.stock` — VERIFIED (17 writes: 11 UPDATE + 6 INSERT with an initial figure)

| # | File:line | Kind | Flow / entry point | Ledger row written? |
|---|---|---|---|---|
| 1 | `src/pos.js:537` | `stock = stock - ?` | Sale (`completeSale`) | **No**, only sale_items |
| 2 | `src/adjust.js:95` | `stock=stock+?` (±) | Stock adjustment | stock_adjustments + stock_received |
| 3 | `src/dispatch-out.js:197` | `stock=stock-?` | DN dispatch (`dnCommitDispatch`) | stock_received (−) |
| 4 | `src/dispatch.js:104` | `stock=stock-?` | Legacy `dispatchStockModal`, **dead code: no caller** | stock_transfers |
| 5 | `src/dispatch.js:147` | `stock=stock+?` | Legacy receive (`receiveTransfer`, via "Legacy pending" button `src/products.js:263`) | — |
| 6 | `src/dn-cancel.js:53` | `stock=stock-?` | DN reissue (cancel wizard) | stock_received (−) |
| 7 | `src/import.js:228` | **`stock=?` overwrite** | Excel import with "apply qty" | stock_received (delta) |
| 8 | `src/products.js:183` | `stock=stock+?` | Restock (product row menu) | stock_received |
| 9 | `src/purchasing.js:120` | `stock=stock+?, cost=?` | Purchasing | purchases + stock_received |
| 10 | `src/receive-in.js:48` | `stock=stock+?` | Receive DN (`commitReceive`) | stock_received |
| 11 | `src/stocktake.js:223` | **`stock=?` overwrite** | Apply stocktake | stock_received ("Stocktake adjustment", variance computed at count time, so sales made after counting are lost by the overwrite) |
| 12 | `src/products.js:125` | INSERT stock | Add product | — |
| 13 | `src/import.js:237` | INSERT stock | Excel import, new item | stock_received |
| 14 | `src/purchasing.js:122` | INSERT stock | Purchasing, new item | — |
| 15 | `src/dispatch.js:149` | INSERT stock | Legacy receive, new item | — |
| 16 | `src/catalogue-app.js:144` | INSERT stock=0 | Get catalogue (remote) | — |
| 17 | `src/backup.js:331` | INSERT stock | Merge, product not found locally | — |

The product edit UPDATE (`src/products.js:120`) and catalogue updates (`src/catalogue-app.js:152,196`) do **not** touch stock (VERIFIED). Merge never updates an existing product's stock (`src/backup.js:405`).

### 2.2 Integer row ids that leave the device or are shown to users — VERIFIED
- **Receipt #** = `sales.id` from `last_insert_rowid()` (`src/pos.js:522`). Shown/printed at `src/pos.js:545` (audit text), `:561`, `:610` (WhatsApp), `src/printing.js:322,418,432,547,583,654`, and in `window._lastReceipt`.
- **`.sqlite` data export** (Settings → Backup → Export/Share, `src/backup.js:52-53` → `exportBytes` `:199-218`) ships the raw database, every integer id included.
- **Merge** (`mergeDatabase`, `src/backup.js:318-517`) never trusts foreign ids as keys. It re-maps `products`/`customers`/`sales` ids (`prodMap`, `custMap`, `saleMap`) and dedupes on natural keys:
  - products `(name, branch)` :328; customers `(lower(name), phone)` :339
  - sales / payouts / credit_payments / audit_log / stock_requests `(branch, ts)` :349, :380, :416, :445, :451
  - stock_received: `(adj_branch_id, adj_no)` or `(branch, dn_branch_id, dn_no, name, qty)` or `(branch, ts)` :392-396
  - stock_adjustments `(branch_id, adj_no)` :408; eod_sessions `(branch, date, started_ts | expected+counted)` :431-435
  - stock_transfers `(from_branch, dn_no, sku, product_name)` or `(from_branch, ts)` :461-463
  - dn_events `event_key` :476-479; branch_register `name` :485; staff `(branch, name)` :491; vouchers `(customer_id, earned_ts)` :500
  - **Not merged at all:** purchases, stocktakes, stocktake_counts, dispatch_docs, dn_cases, doc_counters, currencies, market_exports, sync_queue, print_queue, settings.
- **Marketing / iTred**: `source_product_id: String(p.id)` (`src/marketing.js:266`). Out of scope, but noted: product ids differ per device.
- **DN/GRV/CXL/ADJ numbers are not row ids.** They come from `doc_counters` (§2.4). DN/GRV files are JSON (`src/dnfile.js`, `src/grvfile.js`) carrying `branch_id` + number. `catalogue.js:212` uses `p.id` only inside the local import plan.

### 2.3 Branch **name** used as a key — VERIFIED
- `branch TEXT` columns: products, sales, payouts, stock_received, eod_sessions, credit_payments, customers, audit_log, stock_requests, stocktakes, purchases, staff, vouchers, stock_adjustments, market_exports.
- Name-pair columns: stock_transfers.from_branch/to_branch; dispatch_docs.dispatch_branch_name/receive_branch_name; dn_events.actor_branch_name/dn_from_name/dn_to_name; `branch_register.name` UNIQUE NOCASE; `branch_prices.dest_branch_name` (part of the PK). Destination rename rewrites it: `src/dispatch-out.js:445`.
- `currentBranch()` (`src/db.js:49`) is the filter for almost every screen: about 190 lines with `branch=?` / `branch<>?` / `currentBranch()`. Top files: reports.js 23, backup.js 21, report-writer.js 20, receive-in.js 14, eod.js 12, dispatch-out.js 12, staff.js 11, catalogue-app.js 11.
- `listBranches()` = `DISTINCT branch` over products ∪ sales ∪ eod_sessions (`src/utils.js:131-137`). It drives branch pickers (`src/eod.js:448-455`) and export scopes (`src/backup.js:188-195`).
- Merge dedupe keys (above), export scoping by name (`src/backup.js:204-210`), `replaceNameProblem` (`src/backup.js:129-136`), `backfillDnLinks` join on `dispatch_branch_name` (`src/db.js:397-399`).
- Fuzzy name equality `sameBranchName` (sanitised, case-insensitive; `src/docnum.js:30-32`): used in catalogue (`src/catalogue-app.js:89,129,157`), dispatch (`src/dispatch-out.js:30,32,163,411,435`) and cancel (`src/dncancel.js:171,198`).
- Staff PIN uniqueness is scoped by branch name (`src/staff.js:17-21`).

### 2.4 `doc_counters` consumers and doc types — VERIFIED
Types: `DN, GRV, ADJ, CXL, EXP, LOG, ITM, MKT` (`src/docnum.js:13`), keyed `(branch_id, doc_type)`, so per device's `branch_id` (per branch only because one device = one branch).
| Type | Consumer |
|---|---|
| DN | `src/dispatch-out.js:186` (dispatch), `src/dn-cancel.js:98` (reissue replacement DN) |
| GRV | `src/receive-in.js:44` |
| ADJ | `src/adjust.js:94` |
| CXL | `src/dn-cancel.js:95` (becomes `dn_cases.case_no`) |
| EXP / ITM / LOG | `docFilename()` `src/utils.js:157-166`, called by `src/backup.js:50,288,313` (data export, item list, app log) |
| MKT | `src/marketing.js:343` |
Replace keeps the device's counters, highest wins (`src/backup.js:163,179-185`). `nextDNNumber`/`nextGRVNumber` (`src/docnum.js:79-80`) have no callers outside docnum (VERIFIED by grep).

### 2.5 `.sqlite` / branch-exchange flows (UI → handler) — VERIFIED
Note: in this codebase the `.scl` extension is used **only** by the Marketing/iTred export (`src/marketing.js:209-225`), which is out of scope. Branch-to-branch exchange uses `.sqlite` data files and JSON document files (`.json`, `src/docnum.js:12`). So "retire `.scl` branch exchange" (decision 5) in practice means retiring the flows below. See conflict C8.

| Flow | UI entry point | Handler chain | File format |
|---|---|---|---|
| Data export / share | Settings → Backup & multi-branch merge → "Export data file" / "Share via WhatsApp" (`src/backup.js:17-18`) | `wireBackupMergeSection` :52-53 → `downloadDb`/`shareOrDownloadDb` → `exportBytes(scope)` :199 | `.sqlite` (EXP#) |
| Merge | same card, file input `#mergeDb` (`src/backup.js:40,66-70`) | `onMergePicked` :137 → `mergeDatabase` :318 | `.sqlite` |
| Replace | `#replaceDb` (`src/backup.js:43,71-75`) | `onReplacePicked` :154 → `keepDeviceIdentity` :179 | `.sqlite` |
| Dispatch (DN) | Products → Dispatch icon (`src/products.js:223,255`) | `openDispatchScreen` `src/dispatch-out.js:221` → `dnCommitDispatch` :180 → `buildDN` `src/dnfile.js:135` | JSON `seigen-dn` |
| Receive DN / cancel notice | Products → Receive (`src/products.js:259`) | `openReceiveScreen` `src/receive-in.js:249` → `commitReceive` :31, `commitVariance` :74, `commitCancelNotice` :126, `commitReplacementClose` :137; GRV built `buildGRVFromCommit` :164 | JSON `seigen-dn`, `seigen-dn-cancel` → produces `seigen-grv`/ack |
| Import GRV / ack (dispatcher side) | Products → Dispatch history → Import (`src/dispatch-out.js:464,494`) | `openGrvImportScreen` `src/grv-import.js:120` → `commitGrvImport` :58 / `commitConflictGrv` :105; ack → `commitAckImport` `src/dn-cancel.js:154` | `seigen-grv`, `seigen-dn-cancel-ack` |
| Cancel / reissue DN | Dispatch history → Cancel (`src/dispatch-out.js:495`) | `openCancelWizard` `src/dn-cancel.js:199` → `buildCancel` `src/dncancel.js:70` | `seigen-dn-cancel` |
| Build catalogue (main) | Settings → Branch register card → "Build catalogue" (`src/dispatch-out.js:20-43`, `src/catalogue-app.js:220,232`) | `openCatalogueBuilder` :236 → `buildCatalogueFor` :85 → `buildCatalogue` `src/catalogue.js:102` | `seigen-catalogue` |
| Branch prices | Branch register → prices (`src/catalogue-app.js:266`) | `branch_prices` rows, carried in the catalogue | — |
| Get catalogue (remote) | Products → "Get catalogue" (remote only, `src/products.js:225,258`) | `openCatalogueImportScreen` `src/catalogue-app.js:333` → `commitCatalogueImport` :139 | `seigen-catalogue` |
| Legacy pending transfers | Products → "Legacy pending (n)" (`src/products.js:228,263`) | `receiveStockModal` `src/dispatch.js:159` → `receiveTransfer` :137 | (pre-DN `stock_transfers` rows that arrived by merge) |
| Guard | Merge/Replace sniff JSON formats and redirect | `guardedFormat` / `showDNInBackupGuard` `src/backup.js:89-111` | — |
| Remote guard | A remote refuses merge/replace of a main's file | `mainFileProblem` `src/backup.js:117-126` | — |

### 2.6 Shift / EOD model — VERIFIED
- Table `eod_sessions`. Lifecycle columns added by ALTER (`src/db.js:334-342`).
- Keyed by **branch name + business date**, not by device: `oldestOpenShift(branch)`, `openShiftForDate(branch,date)` (`src/eod.js:155-160`), `startShift` :183-198, `completeEOD` :252-266. A sale is blocked unless today's shift is open (`shiftBlockReason` :172-179, enforced in `completeSale` `src/pos.js:433-434`).
- Totals `eodTotalsFor(branch,date)` sum **all** sales/payouts with that branch name and date (`src/eod.js:212-247`).
- Today it is per device only because one device = one branch and each device has its own database. With two tills in one branch, once their sales are on one database (by merge or by Phase 4 pull), `eodTotalsFor` would add both tills' cash into one expected-cash figure. Phase 5 needs `terminal_id` on eod_sessions, sales, payouts and sale_payments (sale_payments links through sale_id).

### 2.7 Insert sites per candidate sync table — VERIFIED (grep of `INSERT INTO <t>(`)
sales 2 (pos, backup) · sale_items 2 · sale_payments 3 (+db.js backfill) · products 6 · customers 2 · payouts 2 (credit.js, backup) · credit_payments 2 · stock_received 13 (10 files) · stock_adjustments 2 · stock_transfers 4 · purchases 1 · eod_sessions 2 · staff 3 · vouchers 2 · stock_requests 2 · stocktakes 1 · stocktake_counts 1 · dispatch_docs 4 (via `insertDispatchDoc` + receive-in) · dn_events 2 (`recordDnEvent` + db.js backfill) · dn_cases 1 · audit_log 2.
Only dispatch_docs and dn_events already go through a helper. So "stamp in existing insert helpers" isn't possible for the rest. Options: (a) triggers in `migrate()` (recommended, one place, matches `src/db.js:362-367`), or (b) edit about 60 call sites.

---

## 3. Supabase (live project `urbopdsubwawtybwrxjd`) — VERIFIED, read only

How: `SUPABASE_DB_URL` in this machine's environment points at `postgres.urbopdsubwawtybwrxjd` (pooler, eu-north-1). Every query ran inside `BEGIN READ ONLY … ROLLBACK`, so the server would have refused any write. Only definitions and **counts** were read, no vendor row contents. (The claude.ai Supabase connector only sees a different project, `qfkwsxnprhrtipdjwbdn`. The "My SCL Superbase" MCP server failed to connect.)

### 3.1 `cl_device_checkin` definition (verbatim, `pg_get_functiondef`)
Signature: `(p_install_id text, p_shop_secret_phrase text, p_device_code text, p_business_name text, p_owner_name text DEFAULT NULL, p_phone text DEFAULT NULL, p_city text DEFAULT NULL, p_location text DEFAULT NULL, p_rpn_hint_id uuid DEFAULT NULL) RETURNS json`, `SECURITY DEFINER`, `SET search_path TO 'public'`, EXECUTE granted to PUBLIC, anon, authenticated, service_role.

```sql
CREATE OR REPLACE FUNCTION public.cl_device_checkin(p_install_id text, p_shop_secret_phrase text, p_device_code text, p_business_name text, p_owner_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_location text DEFAULT NULL::text, p_rpn_hint_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_vendor cl_vendors%rowtype;
  v_messages json;
  v_business_name text := nullif(trim(coalesce(p_business_name,'')), '');
  v_owner_name    text := nullif(trim(coalesce(p_owner_name,'')), '');
  v_phone         text := nullif(trim(coalesce(p_phone,'')), '');
  v_city          text := nullif(trim(coalesce(p_city,'')), '');
  v_location      text := nullif(trim(coalesce(p_location,'')), '');
  v_device_code   text := nullif(trim(coalesce(p_device_code,'')), '');
begin
  if p_install_id is null or length(trim(p_install_id)) = 0 then
    raise exception 'install_id is required';
  end if;
  if p_shop_secret_phrase is null or length(trim(p_shop_secret_phrase)) = 0 then
    raise exception 'shop_secret_phrase is required';
  end if;

  select * into v_vendor from cl_vendors where install_id = p_install_id;

  if not found then
    insert into cl_vendors (
      business_name, owner_name, phone, city, location, install_id, device_code,
      shop_secret_phrase, rpn_id, status, app_registered_at, last_checkin_at
    ) values (
      coalesce(v_business_name, 'Unnamed vendor'), v_owner_name, v_phone, v_city, v_location,
      p_install_id, v_device_code, p_shop_secret_phrase, p_rpn_hint_id, 'onboarding', now(), now()
    )
    returning * into v_vendor;
  else
    if v_vendor.shop_secret_phrase is not null
       and v_vendor.shop_secret_phrase <> p_shop_secret_phrase then
      raise exception 'Shop secret phrase does not match this install';
    end if;

    update cl_vendors set
      business_name       = coalesce(v_business_name, business_name),
      owner_name          = coalesce(v_owner_name, owner_name),
      phone               = coalesce(v_phone, phone),
      city                = coalesce(v_city, city),
      location            = coalesce(v_location, location),
      device_code         = coalesce(v_device_code, device_code),
      shop_secret_phrase  = coalesce(v_vendor.shop_secret_phrase, p_shop_secret_phrase),
      rpn_id              = coalesce(v_vendor.rpn_id, p_rpn_hint_id),
      last_checkin_at     = now()
    where id = v_vendor.id
    returning * into v_vendor;
  end if;

  select coalesce(json_agg(json_build_object('id', id, 'title', title, 'body', body, 'created_at', created_at)), '[]'::json)
    into v_messages
    from cl_vendor_messages
    where vendor_id = v_vendor.id and channel = 'in_app' and status = 'pending';

  update cl_vendor_messages
    set status = 'delivered', delivered_at = now()
    where vendor_id = v_vendor.id and channel = 'in_app' and status = 'pending';

  return json_build_object(
    'vendor_id', v_vendor.id,
    'status', v_vendor.status,
    'lock_cart', v_vendor.lock_cart,
    'lock_add_product', v_vendor.lock_add_product,
    'lock_reason', v_vendor.lock_reason,
    'cycle_start_date', v_vendor.cycle_start_date,
    'messages', v_messages
  );
end;
$function$
```

**How the phrase is checked** (this is what Phase 1 RPCs are told to reuse):
- Stored **per `cl_vendors` row = per install**, plain text, column `shop_secret_phrase`.
- An **unknown install_id is accepted with any phrase** and gets a new vendor row (status `onboarding`). There is no proof of belonging to a business.
- For a known install: rejected only if the stored phrase is non-null **and** differs **case-sensitively** (`<>`, no trim/upper). The first non-null phrase sticks forever.
- Tables it touches: `cl_vendors` (select/insert/update), `cl_vendor_messages` (select/update).

### 3.2 `cl_vendors` — VERIFIED
Columns: id uuid PK default gen_random_uuid(), business_name text NOT NULL, owner_name, phone, city, rpn_id uuid FK→cl_rpn, device_code, shop_secret_phrase, cycle_start_date date, status text NOT NULL default 'onboarding' CHECK in (onboarding, active, overdue, suspended, cancelled), onboarded_at timestamptz default now(), notes, created_by uuid FK→cl_staff, created_at NOT NULL default now(), install_id text, location, app_registered_at, last_checkin_at, lock_cart bool NOT NULL default false, lock_add_product bool NOT NULL default false, lock_reason.
Constraints/indexes: `cl_vendors_pkey`; `cl_vendors_install_id_key` UNIQUE(install_id) (added by `20260924120000_itred_marketplace_schema.sql:83-84`); **also** `cl_vendors_install_id_uidx` UNIQUE partial (redundant duplicate); `cl_vendors_rpn_id_idx`; FKs created_by→cl_staff, rpn_id→cl_rpn. No triggers.
Referenced by: cl_activation_codes.vendor_id (CASCADE), cl_ledger_entries.vendor_id (CASCADE), cl_vendor_messages.vendor_id (CASCADE), rpn_onboarding_notes.vendor_id (SET NULL), vendors.install_id → cl_vendors.install_id (ON UPDATE CASCADE, ON DELETE RESTRICT).
RLS: enabled (not forced). Policies: `cl_vendors_select` (rpn sees own, staff with 'vendors' module), `cl_vendors_write_staff` (ALL, staff only); both rely on `cl_jwt_*()` claims, so anon gets nothing.
Grants: **every `cl_` table grants all privileges (`arwdDxtm`) to anon and authenticated**. Protection rests entirely on RLS policies. New `cl_branches` / `cl_terminals` / `cl_branch_join_codes` must `revoke all … from public, anon, authenticated` explicitly (the onboarding-notes migration does this, `20261003120000_rpn_onboarding_notes.sql`) and keep RLS on with no policies.
Data shape (counts only): 21 rows; 21 with install_id (all distinct, **all length 4**); 21 with a phrase; **9 distinct phrases**; 3 groups of vendors share a phrase; all 21 `status='onboarding'`.
Other functions touching cl_vendors: `cl_list_onboarding_notes`, `cl_onboarding_note_to_vendor` (can create a vendor row **without install_id**, `20261003120000_rpn_onboarding_notes.sql:206-208`).
Name check: `cl_branches`, `cl_terminals`, `cl_branch_join_codes` do not exist yet (no collision).
Extensions available: pgcrypto 1.3 (for hashing join codes, `gen_random_uuid`), pgjwt, supabase_vault, uuid-ossp.
`supabase_migrations.schema_migrations` **does not exist**: migrations in this project are applied by hand (SQL editor), not with the CLI. Phase 1 must do the same and record it.

---

## 4. Conflicts with the "already established" list

| # | Claim | Finding |
|---|---|---|
| C1 | build.js → dist-pwa/ and dist-tauri/ | VERIFIED, with additions: `--tauri` adds `desktop/sales-desktop.js` + CSS; both are obfuscated (output is not byte-reproducible); a plain `node build.js` also builds `dist/` (single file). **dist-pwa/ and dist-tauri/ are committed to git**, so every rebuild produces a large diff. |
| C2 | "every table uses INTEGER PRIMARY KEY AUTOINCREMENT" | **Not true for 4 tables**: settings (`key TEXT`), doc_counters (composite), dispatch_docs (composite `(dispatch_branch_id, dn_no)`), branch_prices (composite). dispatch_docs is on the brief's 1B uid list. |
| C3 | receipt = `last_insert_rowid()` | VERIFIED `src/pos.js:522`. |
| C4 | `getBranchId()` = "B-"+uid4()+uid4() per device | VERIFIED, but it is **regenerated at every Setup finish** (`src/setup.js:136`) and on Replace when the device had none (`src/backup.js:184`). A reinstalled device gets a new branch_id; its old DN keys stay on other devices. `legacy_branch_id` on the server can therefore be stale. |
| C5 | doc_counters per-branch, not per-terminal | VERIFIED (it's per `branch_id`, which is really per device). Doc types: 8, not just DN/GRV. |
| C6 | sync.js push-only, 3 types, anon `/rest/v1/<table>` | VERIFIED. Addition: none of the 3 target tables exist live, so the outbox never succeeds today. |
| C7 | `cl_device_checkin` params/returns; one row per install_id | VERIFIED. Additions: returns `cycle_start_date` too; auto-creates vendors for unknown installs; phrase check is case-sensitive and per install. |
| C8 | ".scl/.sqlite branch exchange" | Branch exchange uses **`.sqlite` + JSON** (`seigen-dn`, `seigen-grv`, `seigen-catalogue`, `seigen-dn-cancel`, `seigen-dn-cancel-ack`). `.scl` is used **only** by the Marketing/iTred export, which the brief puts out of scope. |
| C9 | `cl_` definitions not in migrations | VERIFIED, but migrations **do** alter/use cl_vendors (itred adds `cl_vendors_install_id_key`; onboarding notes inserts rows). |
| C10 | "~16 stock writes" | 17 (11 UPDATE + 6 INSERT); one of the UPDATEs (`src/dispatch.js:104`) is unreachable dead code. |

---

## 5. Baseline checks

Builds (run in a detached git worktree of `7edabe5` so the committed dist folders in the main checkout were not touched):
- `node build.js --pwa` → `dist-pwa/index.html` 1,323,515 bytes, 45 src files. **PASS**
- `node build.js --tauri` → `dist-tauri/index.html` 1,346,734 bytes, 46 src files. **PASS**
- `node build.js` → `dist/index.html` 766,628 bytes, 44 src files. **PASS**

`test/*.test.js` (51 suites, each `node --no-warnings test/<x>.test.js`, 300 s timeout, run in the same worktree):

- **50 of 51 suites PASS** (exit 0, no `FAIL` line in any of their logs).
- **1 FAIL, a worktree artifact, not a code fault:** `fieldguide-engine` reports "manual.json matches the source manual … source file changed since conversion" (a sha256 mismatch). With `core.autocrlf=true`, a fresh checkout rewrites line endings in the source manual. Re-run in the main checkout: **12 passed, 0 failed**. Treat it as passing. When later phases run tests in a fresh worktree, expect this one failure.
- Passing suites: browser-audit, cart-drawer-e2e, catalogue, dc-registration-e2e, device-setup-e2e, devicecheckin-lock-e2e, devicecheckin, dispatch, dnfile, doc-ref-e2e, docnum, eod-shift, fieldguide-coach-e2e, fieldguide-field, fieldguide-onboarding-e2e, fieldguide-search-e2e, fieldguide-search, inventory-import, itred-fulfilment-fake, itred-mobile-e2e, itred-orders-e2e, itred-site-e2e, itred-supabase-e2e, license-clock-guard, license-lock-screen-e2e, line-item-discount-e2e, marketing-bridge, marketing-hosted-e2e, marketing-picker-e2e, mergeguard, multi-currency, phase4, phase4b, phase5, pos-search-e2e, publish-portal, quick-tap-currency, receipt-discount-aggregate, receive, remove-cart-markup, rpn-shell-e2e, rpn-support-modal, split-tender-focus-e2e, split-tender, staff-login-screen-e2e, staff-pin, stocktake-search-e2e, stocktake-search, sync-queue, sync-toast-e2e.
- The README has no single test command. Each suite is run as `node --no-warnings test/<name>.test.js` (header convention, e.g. `test/device-setup-e2e.test.js:1`). The Playwright suites stub Digital Commerce with `test/dc-fake.js`, so none of them reached the live project.

`supabase/tests` (local PGlite mode only, never live):
- `itred-live-test.js pglite`: 72 passed, 0 failed
- `portal-schema-test.js pglite`: 31 passed, 0 failed
- `onboarding-notes-test.js`: 43 passed, 0 failed

---

## 6. Risks for Phase 1

1. **Business identity (blocking).** `cl_vendors` = device. A remote device calling `cl_branch_register` has no way to name *which* business it belongs to: the phrase is shared across businesses, and its own vendor row is a different business as far as the server knows. Either remote devices also join with a join code issued by main (then their own vendor rows become orphans holding billing history), or Console staff link them. Needs a decision (Q1).
2. **`cl_device_checkin` must change**, or every joined terminal registers as a new vendor and gets that vendor's lock flags and messages instead of the business's. The proposed change (resolve `install_id` via `cl_terminals` → its `vendor_id` first) affects billing and locks for every device, so it needs your review of the diff.
3. **"Check the phrase exactly the way `cl_device_checkin` does" is weak for new installs**: it accepts anything for an unknown install. The join RPC must check the phrase against the join code's vendor's stored phrase. Case rule to decide: today the check is case-sensitive, activation is case-insensitive (Q2).
4. **4-char install_id collisions** (Q3). `cl_terminals.install_id UNIQUE` will reject a colliding terminal outright, which is safer than today's silent takeover, but that terminal can't join without a new install_id.
5. **main/remote is a local, switchable setting** (`src/settings.js:111`). "Main only" for issuing join codes must be decided server-side from `cl_branches.is_main`, not from the device's claim. Two devices could both claim main. The first registration should win, and later main claims should be refused.
6. **Branch names**: a blank branch name falls back to shop name / "Main" (`src/db.js:49`). Two devices with blank names collide on `UNIQUE (vendor_id, lower(name))`. Names are also matched fuzzily locally (`sameBranchName`) but exactly on the server, so "Harare CBD" and "HarareCBD" would be one branch locally and two on the server.
7. **uid and merge**: if uids are stamped by trigger, merged-in rows get a fresh local uid. Phase 1 should make `mergeDatabase` copy `uid` when the source row has one (and skip stamping `terminal_id`/`branch_uuid` on merged rows), otherwise the same sale carries different uids on two devices before Phase 3 even starts. That's a change to the merge path, which the brief says must "behave exactly as before". It's additive, but it is a change, so I'm flagging it.
8. **Stamping terminal_id by trigger** reads `settings` inside the trigger (precedent `src/db.js:401`), but must not fire for merge/replace imports. Merge inserts can be told apart only if merge sets a flag or passes the values explicitly.
9. **persist() rewrites the whole DB**. The uid backfill adds 36 bytes × every row. Measure on a large real file before shipping.
10. **New tables inherit anon/authenticated grants** in this project (all cl_ tables show full grants). The migration must revoke explicitly.
11. **No migration history table**: apply by hand. The test in `supabase/tests` will need PGlite stubs for `cl_vendors` and `cl_device_checkin` (pattern exists in `supabase/tests/itred-live-test.js:25-36`).
12. **Committed dist folders**: rebuilding for Phase 1 changes `dist-pwa/` and `dist-tauri/` wholesale (non-deterministic obfuscation).
13. **Publish portal / iTred key on install_id** (`vendors.install_id` → `cl_vendors.install_id`). A joined terminal has no cl_vendors row of its own, so marketing/publish from a joined terminal won't be recognised until those lookups also go through `cl_terminals`. Out of scope, but it will surface as "not registered" on such a terminal (`dcIsRegistered`, `src/devicecheckin.js:76`, relies on `dc_vendor_id`).

## 7. Questions for the owner before Phase 1

- **Q1 (blocking):** Business = main device's `cl_vendors` row? If yes: do existing remote devices join that business with a join code issued by main (same flow as new terminals), and what happens to their own existing `cl_vendors` rows (keep for billing history / mark merged / Console links them)? Today all 21 live vendors are `onboarding`, so this is the cheapest moment to decide.
- **Q2:** Phrase comparison for join/register: keep case-sensitive exact match (as check-in), or trim + case-insensitive (as activation)?
- **Q3:** May **new** installs get a longer install_id (e.g. 8 characters from the same alphabet)? The activation formula is unchanged and accepts any device code, but the device code shown on the lock screen gets longer. Existing installs keep theirs.
- **Q4:** Is it acceptable that Phase 1 changes `mergeDatabase` to carry `uid` (additive; no change to what is merged or how duplicates are detected)?

---

## 8. Owner decisions (2026-10-04) and follow-up checks

### Decisions (authoritative)
| # | Decision |
|---|---|
| Q1 | **No** use of main's vendor row as the business, and **no** merging of vendor rows. A new `cl_businesses` table; `cl_vendors.business_id` (nullable). `cl_vendors` stays one row per install, with billing and activation history untouched. Main's install creates the business when it registers its branch. Existing remote devices and new terminals link to it with a join code from main. Nothing is deleted. The migration SQL is shown before it's applied. |
| Q2 | The phrase check is case-insensitive everywhere (`upper(trim())`), `cl_device_checkin` included, to match activation. **The join code, not the phrase, decides which business a device belongs to.** |
| Q3 | New installs get a longer install_id; existing ones keep theirs. `cl_device_checkin` must refuse to take over an existing vendor row that belongs to another device. Check first that the Console's activation-code tool accepts the longer device code. |
| Q4 | `mergeDatabase` carries each row's uid. |
| — | uid is stamped by triggers using `lower(hex(randomblob(16)))`, so it also works on databases opened during merge. |
| — | The zero-stock sale block is left alone (Phase 4 removes it). |
| — | Phase 1 stops the dead outbox (`rpn_link`, `support_task`): RPCs or pause, proposed with evidence. |

### Follow-up checks (read-only, 2026-10-04)
- **Console activation tooling vs a longer device code.**
  - Server side, VERIFIED: `cl_issue_activation_code` takes `p_device_code text` and stores it in `cl_activation_codes.device_code text`, with no CHECK constraints or triggers. `cl_activation_codes` has **0 rows**. No CHECK constraint on `device_code`/`install_id` exists anywhere except `vendor_tokens.install_id` being non-empty. All 21 `cl_vendors.device_code` values have the shape `XXXX-C<n>`.
  - App side, VERIFIED: `computeActivationCode` accepts any length (`src/activation.js:1-7`). The publish portal allows install IDs up to 100 characters (`tools/publish-portal/scl.js:53`).
  - **UNVERIFIED: the Console's own browser screen** (where `p_computed_code` is computed). Its source isn't in this repo or anywhere searched on this machine. Test vector for a manual check: device code `ABCD2345-C1`, phrase `TEST` → expected code **`AR9W21`**.
- **Q3 as worded would lock shops out.** `cl_device_checkin` overwrites `cl_vendors.device_code` on every call (§3.1), and the code is `install_id-C<cycle>` (`src/activation.js:23-28`). Refusing on "device code differs" would refuse every legitimate device at its 30-day rollover, and colliding devices share the prefix anyway. Proposed instead: a per-install random `device_key`, recorded on first use. Awaiting OK (phase1-plan.md, item 1).
- **Phrase data**: the 21 rows hold 9 distinct phrases case-insensitively. Each row is only ever compared with its own stored phrase, so Q2 doesn't newly refuse or newly accept any live row.
- **pgcrypto** is installed in schema `extensions` (crypt, gen_salt, digest, gen_random_bytes) and also works in local PGlite 0.5.8 via its contrib module (VERIFIED).
- **Default privileges** in `public` grant ALL on new tables and EXECUTE on new functions to anon and authenticated (`pg_default_acl`, VERIFIED). New objects must revoke explicitly.
- **SQLite triggers**: `lower(hex(randomblob(16)))` gives a different value per row in a backfill `UPDATE`; an `AFTER INSERT … WHEN NEW.uid IS NULL` trigger leaves carried uids alone and works on composite-key tables through rowid (VERIFIED in node:sqlite). Postgres `uuid` accepts the undashed 32-hex form (VERIFIED in PGlite).
- **Outbox evidence**: `rpn_link`, `support_task` and `sync_health_check` don't exist live. No live function or repo file under `supabase/`, `tools/` or `src/fieldguide/` reads them. The server already links vendors to RPNs structurally (`cl_vendors.rpn_id` → `cl_rpn`). All queue readers filter `status IN ('pending','failed')` (`src/sync.js:103-109,177`). **Recommendation: pause** (details in phase1-plan.md §1E).
- **Draft SQL** (`phase1-migration-draft.sql` + `phase1-rollback-draft.sql`) checked in in-memory PGlite with `phase1-draft-smoke.mjs`: **34 passed, 0 failed**. This caught one bug before review (a join refused for a used code still created a vendor row), and it's fixed in the draft.

### Answers to §7
Q1–Q4 above. §0 item 1 and §6 risks 1–3 are resolved by the `cl_businesses` design. §6 risk 4 (install_id collisions) is addressed by the longer install_id for new installs plus the proposed `device_key` guard. §6 risk 7 is resolved by Q4.
