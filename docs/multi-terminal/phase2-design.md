# Multi-terminal sync — Phase 2 design: per-till numbering, stock ledger, internal references

Status: **Stage B implemented locally (2026-10-06), not pushed or deployed.** App changes and tests are in the working tree of this branch. The server migration (`supabase/migrations/20261004180000_multi_terminal_phase2.sql`) is tested in PGlite only and waits for the owner's "apply"; live objects were backed up read-only to `docs/multi-terminal/live-backup-phase2-2026-10-04T16-25-36-250Z/` (not committed).
Branch: `phase2-numbering-ledger` from `main` at `96cacab` (identical to what is live on mobilepos/desktoppos). The only commit so far untracks `lint-report/` (`7be5e1a`).
Status words: VERIFIED (read in code or the live database, read-only), PROPOSED (design), ASSUMED.

Goal: make the local data safe for several tills before any sync is built. Nothing syncs in this phase. Selling still never waits on the network, and the zero-stock sale block stays.

---

## 0. Decisions in one page

| # | Decision | Why |
|---|---|---|
| D1 | **The DN identity key does not change.** It stays `(dispatch_branch_id, dn_no)`. Only the *displayed* number gains the till code. | `dispatch_branch_id` is `getBranchId()`, which is already **per device = per till**: it's reset at every Setup (`src/setup.js:136`) and every Join (the Phase 1 join flow calls `resetBranchId()`). Two tills in one branch already have different ids, so their DN keys can't collide today. Adding `till_code` to the key would change ~60 queries for no gain. (VERIFIED) |
| D2 | **Counters keep running; they don't restart.** A till that registers after issuing DN0010 continues at `DN-T1-0011`. | `dn_no` must stay unique per `dispatch_branch_id`. Restarting at 1 under the same device id would collide with the old DN0001. The same rule applies to GRV, ADJ and CXL. |
| D3 | **Receipts get their own per-till counter** (`RCT`, starting at `T2-0001`) and a stored `sales.receipt_no`. Old sales keep `#<id>`. | `sales.id` is a local rowid. A merge gives incoming sales new ids (`src/backup.js:355`), so a rowid can't be a stable receipt number across devices. |
| D4 | **Formats:** receipt `T2-0045`; `DN-T1-0012`; `GRV-T2-0007`; `ADJ-T1-0003`; `CXL-T1-0002`. File name `DN-T1-0012-HarareCBD-04Oct26-0230PM.json`. Unregistered devices keep today's `#45`, `DN0012`, `DN0012-HarareCBD-…json` exactly. | Short enough for a 58 mm receipt line ("Receipt T2-0045" is 15 of 32 columns) and for file names. |
| D5 | **File formats are versioned, and the new version is only written when needed.** DN v3, GRV v2, cancel/ack v2 are written only when the document has a till code or an internal ref. Otherwise the bytes are exactly today's v1/v2. | Unregistered single-device shops (and old receivers) see no change. An old app given a new file gets the existing "needs a newer version … Update the app" message (`newerAppMessage`, `src/dnfile.js:16`). New apps read every old version. |
| D6 | **The stock ledger `stock_movements` is written by one helper, `moveStock()`, wrapped in a SAVEPOINT** so the stock change and its movement commit together, whether or not the caller already has a transaction open. | One choke point for the 16 live writes (17 minus the dead one). |
| D7 | **Opening balance:** one `opening` movement per product with a deterministic uid `open-<product uid>`, inserted with `INSERT OR IGNORE`. | Running it twice changes nothing, and `SUM(qty_delta) = products.stock` from day one. |
| D8 | **The integrity check covers this branch's own products only**, and is shown read-only in **Settings → Diagnostics** (new card). | Products merged in from other branches are snapshots that a merge never updates (`src/backup.js:405`), so their sums can't be expected to match. |
| D9 | **Reports don't change in Phase 2.** They keep reading `stock_received`, `dispatch_docs` and `dn_events` exactly as today. Switching them to `stock_movements` is a Phase 4 item. | As you preferred: no report output changes in this phase. |
| D10 | **Internal ref:** optional, at most 30 characters, cleaned like the cart's Doc Ref (`cleanDocRef`, `src/pos.js:421`). Stored on `dispatch_docs`, carried in DN v3 and GRV v2, printed on both vouchers, shown in both history lists, and findable through new search boxes. | Neither history screen has a search box today (VERIFIED), so "searchable" needs one. |
| D11 | **Deactivate a till** with a new RPC `cl_terminal_set_active` (main-branch tills only, phrase + device_key, logged, can't deactivate itself). Check-in reports `terminal_active`, so a deactivated till shows a message, keeps selling and can't register again. | SQL in §4.1 for review; it's applied only after your "apply". |
| D12 | **Server branch-name key = the app's `sanitizeBranchName()` rule:** NFKD accent folding, letters and digits only, 24-character cap, case-insensitive. **No live collisions** (read-only check, §4.2). | Correction to the brief: the app function that folds accents and caps at 24 is **`sanitizeBranchName`** (`src/docnum.js:24-27`), not `sanitizeFilenamePart` (`src/utils.js:139`), which only swaps `\/:*?"<>|` for `-`. |

**Q1, decided 2026-10-04: automatic, no Settings switch.** Approved otherwise as designed, including deleting the dead legacy dispatch screen.

**The "newer file" message, approved wording.** Every file family (DN, GRV, cancel notice, cancellation confirmation, catalogue) uses one shared message, `newerAppMessage` (`src/dnfile.js:16`). From this version on it reads:

> This file was made by a newer version. Tap Reload on the update banner (or close and reopen the app while online), then import it again.

Limit: an app only shows the wording built into *its own* version. Devices still on a pre-Phase-2 build keep their current text ("This Delivery Note needs a newer version of seiGEN Commerce Lite (file version 3, this app reads up to 2). Update the app, then import it again. Nothing was changed."). Both tell the user to update and import again, and both change nothing. The new wording applies to every later format bump.

**Question as originally asked (Q1):** should per-till numbering (and so DN v3 / GRV v2 files) switch on **automatically** for registered tills, or behind a **Settings switch** "turn on after every branch has updated", like the existing cancel/reissue switch (`src/settings.js:56-57`)? The trade-off: an un-updated receiving device can't read a v3 DN until it updates; it sees the clear "update the app" message and nothing is changed. **My recommendation is automatic.** All 5 registered tills on live are on the Phase 1 build or newer, every device in a business updates from the same Workers through the update banner, and a switch adds a state a shop can forget to flip.

---

## 1. Inspection (Stage A1/A2)

### 1.1 Document numbering today (VERIFIED)
- **Counter:** `doc_counters(branch_id, doc_type, last_no)`, PK `(branch_id, doc_type)`, `src/db.js:146-148`. Reserved by `reserveDocNumber(type)` (`src/docnum.js:66-73`) with `branch_id = getBranchId()` (per device). Types: `DN, GRV, ADJ, CXL, EXP, LOG, ITM, MKT` (`src/docnum.js:13`).
- **Consumers:**
  - DN: `src/dispatch-out.js:186` (dispatch) and `src/dn-cancel.js:98` (reissue replacement)
  - GRV: `src/receive-in.js:44`
  - ADJ: `src/adjust.js:94` (`writeAdjustment`, also used by cancel write-offs)
  - CXL: `src/dn-cancel.js:95` (becomes `dn_cases.case_no`)
  - EXP / ITM / LOG: `docFilename()` `src/utils.js:157-166`, from `src/backup.js:50,288,313`
  - MKT: `src/marketing.js:343`
- **Display:** `formatDocNo(prefix, n)` → `PREFIX` + 4-digit number (`src/docnum.js:18-21`). Call sites: DN 43, GRV 16, CXL 4 (via `cxNo`), plus about 15 uses of `.text` from a reservation. ADJ is shown through `adj.text`.
- **Receipt number:** `sales.id = last_insert_rowid()` (`src/pos.js:522`). Shown, printed or shared at:
  - `src/pos.js:545` (audit text), `:548` (`_lastReceipt`), `:561` (last-receipt card), `:610` (WhatsApp)
  - `src/printing.js:322` (thermal), `:432` (print/PDF), `:547` + `:583` (sale copy), `:616` ("Invoice #"), `:654` (Sale Detail modal title)
  - `src/report-writer.js:11` (Sales list button, opens Sale Detail), `:65`
  - `src/reports.js:271` (discount report rows)
  - There is no free-text receipt search today; receipts are found through report lists.
- **How DN/GRV documents are identified:**
  - `dispatch_docs` PK `(dispatch_branch_id, dn_no)`, plus `direction 'out'|'in'` (`src/db.js:149-152`).
  - `dn_events.event_key = dn_branch_id|dn_no|type[|ts]` (`src/docnum.js:239-241`).
  - `dn_cases` UNIQUE `(dn_branch_id, case_no)`.
  - `stock_adjustments` UNIQUE `(branch_id, adj_no)`, linking a DN via `dn_branch_id, dn_no`.
  - `stock_received` links via `dn_branch_id, dn_no, grv_no` / `adj_branch_id, adj_no`.
  - `stock_transfers` links via `dn_branch_id, dn_no`.
- **Files:**
  - `seigen-dn` v1, or v2 for reissues (`src/dnfile.js:12-14,108-157`). Fields: `dn_no`, `dn_display` (must equal `formatDocNo("DN",dn_no)`, `:193`), `from{branch_id,name}`, `to{name}`, `created_iso`, items, totals, checksum.
  - `seigen-grv` v1 (`src/grvfile.js:6-7`). It repeats `dn_no`/`dn_display` and checks both displays with `formatDocNo` (`:68-71`).
  - `seigen-dn-cancel` / `-ack` v1 (`src/dncancel.js:8-10`). They check `dn_display`/`cancel_display` the same way.
  - Validators reject unknown top-level keys, so new fields **require** a version bump. That's exactly what makes an old app say "update the app".
- **File names:**
  - `dnFileName` = `DN0012-<Branch>-<ddMonyy>-<hhmmAM>.json` (`src/docnum.js:41-48`)
  - `grvFileName` = the same pattern with `GRV`
  - `cancelNoticeFileName` (`src/dn-cancel.js:176`)
- **Receiver identity checks:**
  - `checkIncomingDN` (`src/dnreceive.js:47-…`) uses `from.branch_id` + `dn_no`.
  - `commitReceive` (`src/receive-in.js:31-75`).
  - GRV import only accepts a GRV for a DN *this device* dispatched (`src/grv-import.js:47-50,61`), keyed `getBranchId()` + `dn_no`.

### 1.2 Stock writes today (VERIFIED, current `main`)

| # | Where | Meaning | Kind (proposed) |
|---|---|---|---|
| 1 | `src/pos.js:537` | sale, `stock - qty` | `sale` |
| 2 | `src/adjust.js:95` (`writeAdjustment`) | adjustment ±, also cancel write-offs and "Dispatch cancelled" returns | `adjustment` |
| 3 | `src/dispatch-out.js:197` | DN dispatch, `−qty` | `dispatch` |
| 4 | `src/dispatch.js:104` | legacy `dispatchStockModal`: **dead code, no caller** (VERIFIED again: `grep dispatchStockModal(` finds only its definition) | — (removed) |
| 5 | `src/dispatch.js:147` | legacy pending-transfer receive (`receiveTransfer`, "Legacy pending" button `src/products.js:263`), `+qty` | `legacy_receive` |
| 6 | `src/dn-cancel.js:53` | reissue: the replacement DN's quantities leave stock | `dispatch` (doc = replacement DN) |
| 7 | `src/import.js:228` | Excel import with "apply qty": **overwrite** `stock = qty` | `import` (delta = new − old) |
| 8 | `src/products.js:183` | Restock (row menu), `+n` | `restock` |
| 9 | `src/purchasing.js:120` | purchase of an existing product, `+qty` | `purchase` |
| 10 | `src/receive-in.js:48` | GRV accept, `+qty` | `receive` (doc = GRV) |
| 11 | `src/stocktake.js:223` | apply stocktake: **overwrite** `stock = counted` | `stocktake` (delta = counted − stock **at apply time**) |
| 12 | `src/products.js:125` | new product with opening stock | `product_created` |
| 13 | `src/import.js:237` | Excel import, new product | `import` |
| 14 | `src/purchasing.js:122` | purchase creates a product | `purchase` |
| 15 | `src/dispatch.js:149` | legacy receive creates a product | `legacy_receive` |
| 16 | `src/catalogue-app.js:144` | Get catalogue inserts with stock 0 | none needed (0); recorded as `product_created` 0 for completeness |
| 17 | `src/backup.js:331` | merge inserts **another branch's** product snapshot | none: the source's movements are carried instead (D8) |

Note on #11: the stocktake variance is measured against the count-time snapshot (`src/stocktake.js:182`), but apply overwrites with the count. Its `stock_received` note can therefore disagree with the real change if sales happened after counting. The movement records the real change. The `stock_received` row is left exactly as today (D9).

`stock_received` is already a *partial* ledger: everything except sales, plus some notes. Reports read it (`src/reports.js:138,221,367`, `src/report-writer.js:26`) and keep doing so.

---

## 2. Per-till numbering (PROPOSED)

### 2.1 Rules
- **Till code source:** `getSetting("till_code")` from Phase 1 (`src/terminal.js` `storeTerminal`). Empty means unregistered, and unregistered means exactly today's behaviour everywhere.
- **New helper** `docDisplay(type, n, tillCode)`:
  - `tillCode` empty → `formatDocNo(type, n)` (today's `DN0012`);
  - `tillCode` set → `type + "-" + tillCode + "-" + pad4(n)`, e.g. `DN-T1-0012`;
  - receipts: `receiptDisplay(sale)` = `sale.receipt_no` if present, otherwise `"#" + sale.id`.
- `reserveDocNumber(type)` keeps one counter per device and returns `{ n, text, till }`, where `text` comes from `docDisplay` with the till code **at the moment of reservation**. That till code is stored on the row (columns below), so a document displays the same way forever, even if the device later registers or is re-joined. History is never renumbered.
- **Receipts:** a new doc type `RCT` in `DOC_TYPES`, reserved only when a till code is set. `completeSale` writes `sales.receipt_no = 'T2-0045'`; when unregistered, `receipt_no` stays NULL and the display stays `#<id>`. All printing functions keep their `saleId` argument and gain an optional `receiptNo`, so `printReceipt(saleId, …)` callers and the existing tests keep working.

### 2.2 New columns (additive `ALTER`s, NULL on old rows)

| Table | Column | Meaning |
|---|---|---|
| `sales` | `receipt_no TEXT` | e.g. `T2-0045`; NULL = old receipt, shown `#id` |
| `dispatch_docs` | `till_code TEXT` | DN's till code (out: own; in: from the file) |
| `dispatch_docs` | `grv_till_code TEXT` | GRV's till code (in: own; out: from the imported GRV) |
| `dispatch_docs` | `internal_ref TEXT`, `grv_internal_ref TEXT` | see §3 |
| `dn_events` | `dn_till_code TEXT`, `grv_till_code TEXT` | so the Stock Movements view can show `DN-T1-0012` without a join |
| `dn_cases` | `till_code TEXT` | CXL display |
| `stock_adjustments` | `till_code TEXT` | ADJ display |
| `stock_received` | `till_code TEXT` | so its note's document number keeps its display |

All of these are carried by `mergeDatabase`, which already copies uid and stamps per table (Phase 1).

### 2.3 Files
- **DN v3** (`DN_FORMAT_VERSION_TILL = 3`): v1/v2 fields plus `till_code` (string, `^T[0-9]{1,3}$`) and `internal_ref` (string ≤ 30, optional). `dn_display` must equal `docDisplay("DN", dn_no, till_code)`. `replaces` stays allowed in v3, so a reissue from a registered till is v3. It's written only when `till_code` or `internal_ref` is present; otherwise v1/v2 byte for byte (the existing `dnfile` tests pin these bytes).
- **GRV v2:** v1 fields plus `till_code` (the receiver's), `dn_till_code` (so `dn_display` can be checked), and `internal_ref` (the receiver's). Written only when any of those is present.
- **Cancel / ack v2:** plus `dn_till_code` and `till_code`, for the same display reason. Written only when present.
- **Readers:**
  - new apps read v1, v2 and v3 for DN, and v1 and v2 for GRV and cancel/ack;
  - old apps reject a new-version file with the existing `newerAppMessage` (they already reject any unknown version: `src/dnfile.js:191-192`, `src/grvfile.js:65-66`, `src/dncancel.js:39,119`).
- **File names** use `docDisplay`, e.g. `DN-T1-0012-HarareCBD-04Oct26-0230PM.json`. `sanitizeFilenamePart` isn't needed because `T1` is already filename-safe.
- **Known limit (unchanged from today, made visible):** a GRV can only be imported on the **till that dispatched** the DN, because `dispatch_docs` 'out' rows exist only on that device. A second till in the same branch gets the existing "was not dispatched from this device" message. Phase 6 (DN/GRV through Supabase) removes this. Phase 2 only adds the till code to that message so staff know which till to use.

---

## 3. Internal reference numbers (PROPOSED)
- **Limit:** 30 characters, after `cleanDocRef`-style cleaning (control characters → spaces, whitespace collapsed, trimmed). Not required, not unique, case kept.
- **DN:** a new field **"Internal ref."** on the Dispatch Stock screen (`openDispatchScreen`, `src/dispatch-out.js:221`), passed to `dnCommitDispatch` and written to `dispatch_docs.internal_ref` (out).
  - In DN v3 as `internal_ref`.
  - Printed on the DN voucher (`dnVoucherHtml`) under the DN number.
  - Shown on the receiving side's review screen and in its Receipts history (stored on the 'in' row's `internal_ref`), and in Dispatch history.
- **GRV:** a new field **"Internal ref."** on the receiving branch's Accept step (`openReceiveScreen` → `commitReceive`), written to the 'in' row's `grv_internal_ref`.
  - In GRV v2 as `internal_ref`.
  - Printed on the GRV voucher (`grvVoucherHtml`).
  - When main imports the GRV (`commitGrvImport`), stored on the 'out' row's `grv_internal_ref` and shown in Dispatch history as "GRV-T2-0007 (their ref …)".
- **Search:** a search box at the top of **Dispatch history** and **Receipts history** that matches document number (old or new format), branch name, and either internal ref (case-insensitive substring). It reuses `matchesAnyOrder` (`src/utils.js`) so typing behaves like the Sell search.
- **No effect** on matching, quantities or variance rules: the ref is excluded from `compareGrvLines`. Old documents show it blank.

---

## 4. Server follow-ups from Phase 1 (PROPOSED; SQL shown, nothing applied)

### 4.1 Deactivate / reactivate a till
```sql
create function public.cl_terminal_set_active(
  p_install_id text, p_secret_phrase text, p_device_key text, p_terminal_id uuid, p_active boolean)
returns json language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; me cl_terminals%rowtype; t cl_terminals%rowtype;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, false);
  select tt.* into me from cl_terminals tt join cl_branches b on b.id = tt.branch_id
   where tt.vendor_id = v.id and tt.active and b.is_main;
  if not found then raise exception 'Only a main-branch terminal can change terminals' using errcode = 'P0001'; end if;
  select * into t from cl_terminals where id = p_terminal_id and business_id = me.business_id for update;
  if not found then raise exception 'Terminal not found in this business' using errcode = 'P0001'; end if;
  if t.id = me.id and not p_active then raise exception 'A till cannot deactivate itself' using errcode = 'P0001'; end if;
  update cl_terminals set active = p_active where id = t.id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (null, case when p_active then 'terminal_reactivated' else 'terminal_deactivated' end, 'cl_terminals', t.id,
          json_build_object('till_code', t.till_code, 'by_terminal', me.id, 'by_till', me.till_code));
  return cl_terminal_json(t.id)::jsonb || jsonb_build_object('active', p_active);
end $fn$;
grant execute on function public.cl_terminal_set_active(text, text, text, uuid, boolean) to anon, authenticated;
```
- `cl_activity_log.staff_id` is nullable (VERIFIED), so a till-initiated action logs with `staff_id = null` and the till in `detail`.
- **`cl_device_checkin`** gains one reply key, `terminal_active` (boolean or null). It is still not refused for an inactive till: licensing is per install (Phase 1, 1D).
- **`cl_terminal_join` / `cl_branch_register`:** an inactive till's install gets the error `TERMINAL_INACTIVE` and can't register or join anywhere. (`cl_branch_issue_join_code` and `cl_branch_list` already require `active`; VERIFIED in the Phase 1 SQL.)
- **App:**
  - Settings → Business & Terminals → Terminals list (main only) gets **Deactivate** / **Reactivate** per till, except its own row. Deactivate asks for confirmation: "Deactivate T2? It can still sell offline, but it can't add itself to the business again until reactivated."
  - When check-in reports `terminal_active:false`, the device stores `terminal_inactive=1`. Its card then says "This till was deactivated by your main branch. Selling still works. Ask main to reactivate it." and its register/join buttons are hidden.
- **Rollback:**
  - drop `cl_terminal_set_active`;
  - restore the Phase 1 bodies of `cl_device_checkin`, `cl_terminal_join` and `cl_branch_register` (kept verbatim in the rollback file);
  - `update cl_terminals set active = true` only for rows this migration's log shows it deactivated.

### 4.2 Server branch-name key = app rule
```sql
create or replace function public.cl_branch_key(p text) returns text language sql immutable as $$
  select coalesce(nullif(lower(left(regexp_replace(normalize(coalesce(p, ''), NFKD), '[^A-Za-z0-9]', '', 'g'), 24)), ''), 'branch') $$;
reindex index public.cl_branches_name_uidx;   -- the unique (business_id, cl_branch_key(name)) index
```
**Changed in Stage B:** the migration drops the index before replacing the function and creates it again afterwards, instead of `reindex`. The PGlite test showed that a `reindex` in the same session rebuilds the index with the **old** function body: the session caches the index expression with the SQL function inlined. The index then accepted `ZURICH-CAFE` beside `Zürich Café`. A newly created index reads the new body. The rollback does the same.
Read-only evidence (live, 2026-10-04):
- `normalize()` exists and is **immutable** (`provolatile = 'i'`), so it's valid in an index.
- The database encoding is **UTF8**.
- `normalize('Zürich Café – Ünit L', NFKD)` gives `zurichcafeunitl`, the same as the app's `sanitizeBranchName` (lowercased).
- The 24-character cap matches: `Chitungwiza Unit L Shopping Centre` → `chitungwizaunitlshopping` on both sides.
- PGlite (the local test database) supports the same function inside a unique index and refuses the folded duplicate.
- Live data: 2 businesses, 3 branches, 5 tills (all active). **0 collisions** under the new key, and **0 of the 3 names** get a different key than today. `unaccent` isn't needed; core `normalize` is enough.
- The migration's preflight re-checks for collisions and aborts if any exist.
- **Rollback:** restore the Phase 1 `cl_branch_key` body and recreate the index (it aborts first if two names would collide under the old key).

---

## 5. Stock movement ledger (PROPOSED)

### 5.1 Table (local SQLite)
```sql
CREATE TABLE IF NOT EXISTS stock_movements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,            -- local id (fast joins; remapped on merge like stock_received)
  product_uid TEXT,              -- products.uid (Phase 1)
  product_code TEXT DEFAULT '',  -- products.sku, the code shared across branches
  product_name TEXT DEFAULT '',  -- snapshot for readability
  branch TEXT DEFAULT '',        -- branch name, like every other table (export scope, filters)
  qty_delta INTEGER NOT NULL,
  kind TEXT NOT NULL,            -- opening | sale | dispatch | receive | adjustment | stocktake | import | restock | purchase | product_created | legacy_receive
  doc_type TEXT DEFAULT '',      -- sale | dn | grv | adj | stocktake | import | purchase | ''
  doc_uid TEXT,                  -- uid of the source row where one exists (sales.uid, dispatch_docs.uid, stock_adjustments.uid, stocktakes.uid, purchases.uid)
  doc_no TEXT DEFAULT '',        -- human number at the time: T2-0045, DN-T1-0012, GRV0007, ...
  ts TEXT NOT NULL,
  user TEXT DEFAULT '',
  note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_stock_movements_product ON stock_movements(product_id);
```
- Added to `SYNC_UID_TABLES` and `TERMINAL_STAMP_TABLES` (Phase 1), so `uid`, `terminal_id` and `branch_uuid` are stamped by the existing trigger mechanism.

### 5.2 Writing it
- `moveStock(o)`, with `o = { productId, delta | setTo, kind, docType, docUid, docNo, ts, note }`:
  1. `SAVEPOINT move_stock`
  2. read the product
  3. if `setTo` is given, `delta = setTo − current stock`
  4. `UPDATE products SET stock = stock + delta`
  5. `INSERT stock_movements`
  6. `RELEASE`, or `ROLLBACK TO` and re-throw on error.

  A SAVEPOINT works both inside the callers' existing `BEGIN…COMMIT` (dispatch, receive, adjust, cancel) and on its own (sale, restock, purchase, import, stocktake). Returns the delta.
- `recordStockMovement(o)`: the same insert without the UPDATE, for the product-insert paths (#12–#16), right after the `INSERT INTO products`.
- All 15 live paths in §1.2 call one of the two; #4 (dead) is deleted; #17 (merge snapshot) writes nothing.
- **Merge** carries `stock_movements` by uid (uid-first skip, `product_id` remapped through `prodMap`), like `stock_received`.
- **Opening balance (D7):** in `migrate()`,
  ```sql
  INSERT OR IGNORE INTO stock_movements(uid, product_id, product_uid, product_code, product_name, branch, qty_delta, kind, ts, note)
  SELECT 'open-'||uid, id, uid, sku, name, branch, stock, 'opening', <now>, 'Stock on hand when the ledger started'
  FROM products
  ```
  Uniqueness on `uid` makes a second run a no-op. It runs on databases opened for merge too, so a pre-Phase-2 file gets its own opening rows.

### 5.3 Integrity check
- `stockLedgerCheck(branch = currentBranch())` → `[{ product, stock, ledger, diff }]` for products where `stock ≠ SUM(qty_delta)`.
- **Settings → Diagnostics** (new card at the bottom, main and remote): "Stock ledger: all N products match" or a read-only table of mismatches. No fix-up button; that's a later decision.

---

## 6. Tests
**Written in Stage B:** `test/phase2-tills-ledger.test.js` (numbering, files, internal refs, ledger, deactivation refusals; the "old app" cases load the live build's validators from commit `96cacab`), `test/terminal-deactivate-e2e.test.js` (Playwright, against `test/terminal-fake.js`, which now answers `cl_terminal_set_active` and `terminal_active`), and `supabase/tests/multi-terminal-phase2-test.js` (PGlite).

**Planned (Stage A):**
- **Numbering:**
  - two tills in one branch (two harness devices with T1/T2) issue receipts and DNs offline, then merge into a third: no number or key collisions;
  - an unregistered device keeps `#id`, `DN0001`, today's file names and v1 bytes exactly;
  - old documents keep their numbers on reprint, in history and in search after a device registers.
- **Ledger:**
  - every one of the 15 paths writes a matching movement;
  - the integrity check passes after a mixed session (sale, receive, dispatch, GRV, adjustment, stocktake with a sale after counting, import with apply-qty, restock, purchase, merge);
  - the opening balance is idempotent.
- **Files:**
  - an old v1 DN is still received;
  - a v3 DN/GRV fed to the v2-only validator (simulating an old app) gives the update message;
  - v3 round-trip, including `replaces`.
- **Internal ref:**
  - DN: entered, printed, in the file, shown at the receiving branch, searchable;
  - GRV: the same, back to main;
  - blank on old documents; 30-character cap and cleaning.
- **Deactivate:** a PGlite test for `cl_terminal_set_active` (main only, not self, logged, the inactive till can't join or register, check-in still works); a Playwright test of main deactivating T2 and T2 showing its message after check-in; other tills unaffected.
- **Server name key:** the PGlite test gains accent and 24-character cases; the preflight collision abort is tested.

**Existing tests expected to change:**
- `test/terminal-identity.test.js`: the `SYNC_UID_TABLES` length 21 → 22, and the backfill fixture gains a `stock_movements` row (the test asserts every syncable table is covered).
- `test/harness.js`: exposes the new functions (`moveStock`, `docDisplay`, `stockLedgerCheck`, …).
- `supabase/tests/multi-terminal-identity-test.js`: new cases only. Its rollback assertions move into the Phase 2 test where the Phase 2 rollback restores Phase 1 bodies.
- **Expected to pass unchanged** (they exercise the unregistered path): `dnfile`, `docnum`, `receive`, `phase4`, `phase4b`, `phase5`, `mergeguard`, `catalogue`, `doc-ref-e2e` (it asserts `Receipt #${sale.id}`, which still holds for an unregistered device). Any that do change will be listed with the reason in the Stage B report.

---

## 7. Risks
1. **Mixed app versions inside one business:** a registered till's DN v3 can't be read by a receiver that hasn't updated. The receiver gets the clear update message and nothing changes, but receiving waits for the update. See Q1.
2. **Receipt numbers restart per till** (`T2-0001`). Staff used to `#1234` will see shorter numbers. Old receipts keep `#1234`.
3. **The SAVEPOINT inside existing transactions** must not break the callers' own `ROLLBACK` paths. The tests cover a dispatch failing midway: no movement, no stock change.
4. **Stocktake apply** after sales: the movement records the true change; the existing `stock_received` note keeps today's count-time figure (D9). A report switch later (Phase 4) resolves it.
5. **Merged other-branch products** are outside the integrity check by design (D8).
6. **GRV import is still tied to the dispatching till** (§2.3).
7. **Server:** the changed `cl_device_checkin` reply is additive, so old apps ignore it. `cl_terminal_join`/`cl_branch_register` gain one refusal. Both come with full-body rollbacks and a local backup taken before applying (as in Phase 1).

## 8. Out of scope (unchanged)
Syncing sales or stock (Phase 3); pulling and cross-branch stock (Phase 4); removing the zero-stock block (Phase 4); switching reports to the ledger (Phase 4); per-till EOD (Phase 5); retiring file exchange and GRV-on-any-till (Phase 6); `LONG_INSTALL_ID` (off until the Console check).
