# Multi-branch visibility and stock management: Stage A design

Status: **design answered by the owner on 2026-10-13** (see "Owner decisions" at the end). B1 waits for one answer: how a multi-till branch's stock is counted.
Date: 2026-10-13. Branch `activation-v2`.

Every fact below comes from the repo (file:line) or from a read-only look at live (counts and short ids only). Labels: **VERIFIED** (seen in code or on live), **ASSUMED** (my reading, not proven), **BLOCKED** (I can't see it from here), **PROPOSED** (design).

---

## Part A. What exists today

### A1. Joining and how branches are linked

**One join links a device to the whole business: VERIFIED.**
- `cl_terminal_join` (migration 20261013120000_price_plans.sql:826-897) creates **one** `cl_terminals` row with `business_id` and `branch_id`. It sets `cl_vendors.business_id` too. Nothing is per branch pair.
- `cl_branch_list` (20261004120000_multi_terminal_identity.sql:382-401) returns **every branch of the caller's business**, whichever branch the caller is on. Till details are added only for main-branch callers.
- The app stores that list as `ds_branches` (src/dispatch-srv.js:48-56; src/terminal.js:143). Joined branches become Dispatch destinations through `dsDestinationNames` (src/dispatch-srv.js:81-85), and `branchDestinations` (src/dispatch-out.js:15-23) adds them to the register.
- `cl_device_dispatch_send` accepts **any branch of the same business** as a destination, remote → remote included (20261017120000_dispatch_grv.sql:231-235).
- **There is no branch-to-branch joining, and none is needed.**

**Why a joined remote branch doesn't show in main's product list: VERIFIED in code.**
- The branch filter of the product list (More → Product List, src/products.js:353) and of every report comes from `listBranches()` (src/utils.js:236-242).
- `listBranches()` reads **only this device's own tables**: `products`, `sales` and `eod_sessions`.
- A remote branch's rows reach main's tables only through the **file merge** (Settings → merge a branch's database file, `mergeDatabase`, src/backup.js:350-598).
- **Joining with a join code puts nothing into main's local tables, so the branch never appears.** Even after a merge, the stock shown is a snapshot from the moment of the merge (src/db.js:640-642).

**On live (read-only, today):**

| | Branches | Tills | Stock mode | Dispatches through seiGEN |
|---|---|---|---|---|
| Chipo Clothing (`95f0ba44…`) | Harare CBD (main), Sothleapark | 1 + 1 | both `local` | 0 |
| Mandie Babyware (`74984f5e…`) | Harare (main), Murehwa | 3 + 1 | both `local` | 0 |
| DEMO Shop (`f6ac53d6…`) | Harare (main), Fidelity | 1 + 1 | both `local` | 0 |

- 12 businesses, 14 branches and 22 tills in total.
- `cl_branch_stock` has 2 rows; `cl_branch_local_products` has 0 rows for these businesses.
- **So the server has no stock figure for any of these branches today.**
- Database size: **17 MB** (`pg_database_size`).

**Gaps in "one join = linked to all":**
1. **G1:** main's product list and reports don't know joined branches (above). Fixed in B1.
2. **G2:** the branch list (`ds_branches`) is refreshed at most every 6 hours, after a check-in (src/dispatch-srv.js:485-490). A branch that joined a minute ago doesn't show yet. B1: refresh it on every check-in, and when Dispatch, Request stock or Other branches opens while online.
3. **G3:** shared-stock tills are left out of seiGEN dispatch (`dsEnabled`, src/dispatch-srv.js:38-42). They also never fetch the branch list. Live has only test data in shared mode, so B1 changes nothing here.
4. **G4:** the WhatsApp numbers in the branch register still reach remote devices only through the file merge (src/backup.js:541-545). That doesn't matter for seiGEN. It matters only for Option 1 (Send as file).

### A2. What each till keeps locally (sql.js database in IndexedDB)

Schema: src/db.js:56-314; added columns: :315-518.

| Area | Tables | Unique across devices? |
|---|---|---|
| Sales | `sales`, `sale_items`, `sale_payments` | **yes:** `uid` (128-bit random, src/db.js:664-684); `sales.terminal_id` / `branch_uuid` stamped once registered; `receipt_no` per till |
| Returns | `credit_notes`, `credit_note_items`, `credit_note_refunds` | `uid`; `(cn_branch_id, cn_no)` unique |
| Shift / End of Day | `eod_sessions` (open → closed) | `uid`, terminal stamp |
| Credit | `customers` (synced since v17), `credit_payments`, `vouchers` | `uid` |
| Payouts | `payouts` | `uid`, terminal stamp |
| Stock | `products.stock` (cached), `stock_movements` (the ledger; `doc_uid` per document), `stock_received`, `stock_adjustments` (ADJ), `stocktakes` / `stocktake_counts`, `purchases` (supplier GRV) | `uid` on all; ADJ `(branch_id, adj_no)` |
| Dispatch | `dispatch_docs`, `dn_events`, `dn_cases`, `srv_dispatches` (the seiGEN copy), `srv_pending` | DN `(dispatch_branch_id, dn_no)`; seiGEN id = `dispatch_docs.uid` |
| Activity log | `audit_log` (ts, branch, user, action, product_name, details) | `uid` |
| Customer requests | `stock_requests` (an item a customer asked for, with the customer's name and phone) | `uid` |

- **A merge marks what came from elsewhere:** merged sales get `merged_ts` (src/db.js:474, src/backup.js:391). Merged rows keep their own `uid` and terminal stamp.
- **Sales before registration** have `terminal_id` NULL.

### A3. What already goes to the server (VERIFIED)

| What | Direction | How | Code |
|---|---|---|---|
| Catalogue and prices | main → all; a remote's own price only with `branch_edits` | push/pull with a cursor, every 5 min and after a check-in | src/catalogue-sync.js:22, :604-605; **cost goes only to main-branch tills** (20261006120000:304, :329) |
| Shared stock | per branch, only in `shared` mode | `cl_stock_*` RPCs, `stock_outbox` | src/shared-stock.js; 20261007120000 |
| Dispatch / GRV / differences | both ways | `srv_pending` → `cl_device_dispatch_send` / `_grv_post` / `_resolve`; `cl_device_dispatch_pull` after a check-in, on reconnect, on Refresh | src/dispatch-srv.js:142-490 |
| Suppliers and supplier GRVs | main → server | `cl_device_supplier_grv_post` | src/supplier-grv.js |
| Customers | all ways | `cl_device_customer_save` / `_customers_pull` (cursor) | src/customers.js:276-321 |
| Device check-in | device → server | at start and on every "online" (**no timer**) | src/devicecheckin.js:208-212; hooks :164-174 |
| **Sales, End of Day, returns, payouts** | **never** | (only the manual file merge) | VERIFIED: no RPC or outbox type for them |
| **Activity log** | **never** | (only the file merge, src/backup.js:499-503) | VERIFIED. `cl_activity_log` on the server is the **Console staff log** (baseline :106); the app never writes it |

**Patterns to reuse:**
- **Device-authenticated RPCs:** install + phrase + device key → `cl_catalogue_caller` / `cl_dispatch_caller`. Refusals come back as data.
- **Idempotency by the device's uid.**
- **A local pending table:** save the request first, then send it.
- **A pull with a cursor**, run from the check-in hook.
- **"Cost only for main" decided by the server** (the catalogue pull).

### A4. Today's Dispatch, GRV, Adjustments and Returns

**Products page icons** (src/products.js:248-264):

| Icon | Opens |
|---|---|
| ➕ Add (main only) | product form |
| ⋮ Excel | import / template / export |
| **Dispatch** | `openDispatchScreen` (src/dispatch-out.js:237) |
| 📋 | Dispatch history: Share file, **Import GRV / reply** (src/dispatch-out.js:537) |
| 📥 Get catalogue | remote, unregistered |
| 🔄 Sync now | registered |
| **Receive** | `openReceiveScreen`: **the DN file only** (src/receive-in.js) |
| 🧾 | Receipts history |
| **🚚 seiGEN (n)** | registered only: Incoming / Sent / Differences / In transit (src/dispatch-srv.js:524) |
| Adjustments | ADJ history (src/adjust.js:188) |
| Legacy pending | the old transfers |

- **Supplier GRV:** More → Purchasing, "Receive from a supplier (GRV)" (src/purchasing.js:21, :176). **Main only** (src/supplier-grv.js:29, :60).

**The two dispatch paths are one screen today.**
- `openDispatchScreen` picks the destination.
- If it is a joined branch (`dsBranchFor`), **the dispatch goes through seiGEN automatically** (`srv` passed to `dnCommitDispatch`, src/dispatch-out.js:399-402), **and** the DN file is still built and offered to share (:418-453).
- If it isn't a joined branch, it is **file only**, with the amber "File only" box and its reason (Billing-B, src/dispatch-srv.js:66-79).
- **There is no explicit choice.**

**Receiving:**
- **File path:** **Accept all or report a variance**. No per-line states. Stock moves once per DN (src/receive-in.js:32-102).
- **seiGEN path:** per line **received / damaged / extra**. Short = sent − received − damaged (server: 20261017120000:345-357; app: src/dispatch-srv.js:199-211).

**Differences today (seiGEN path):**
- **Short and damaged** go back to the **sender's** stock "on paper" at its next pull: movement `dispatch_return`, key `<issue>:return` (src/dispatch-srv.js:411-412).
- The sender then **writes off** (an ADJ, Admin passcode; src/dispatch-srv.js:340-361, :413-423) or **re-dispatches** (:374-387).
- **Damaged is labelled "the goods are at the receiver"** (src/dispatch-srv.js:507). The receiver never writes it off.
- **Extra:** it comes into the receiver's stock. The sender confirms it (off the sender's stock) or disputes it.

**Delivery cost today:**
- **Entered on the Dispatch screen**, seiGEN path only (src/dispatch-out.js:306-310).
- **Stored** in `cl_dispatches.delivery_cost` / `delivery_currency` and in local `dispatch_docs` (src/db.js:484-485).
- **At the GRV**, the receiver's unit cost becomes the **landed cost**: the delivery cost is spread by value over what was received (`dsLandedCosts`, src/dispatch-srv.js:185-197; written at :226).
- The server records **`cl_interbranch_charges`: owed by the receiving branch to the sender** (20261017120000:369-370).

**Return-to-sender: none exists. VERIFIED.**
- The only mention is the refusal text "send the goods back with a return dispatch" (20261017120000:394). That means an ordinary dispatch the other way, which deducts the receiver's stock.

**Adjustments:**
- **ADJ** documents (src/adjust.js:92-127): reasons Lost in transit / Damaged / Expired / Theft / Miscount correction / Other (:7), the **Admin passcode** (:108) and a note.
- **Customer returns** are credit notes (src/returns.js; CN numbers).

### A5. Notifications, permissions, Risk Management, activity log

- **Notifications:** **no notification system. VERIFIED.**
  - The patterns that exist: the check-in **message cards** (`dcMessages`, src/devicecheckin.js:49-65, banner :215) and the **seiGEN badge** on Products (`dsBadgeCount`, src/dispatch-srv.js:523).
- **Staff permissions:** roles are **Admin** or **Cashier** (src/staff.js:37), plus one flag, **"Can create customers"** (src/db.js:513; src/customers.js:24).
  - **Staff live on each device.** The server has no idea which person is signed in; it only knows the till.
- **Risk Management report: not verified from the current codebase.** A search for "risk" in `src/` finds nothing; the report list (src/report-writer.js:10-268) has none.
- **The activity log is local only.** `logAudit` (src/db.js:51-54) writes about 70 kinds of event. **Gaps for what you want logged (VERIFIED):**
  - **sign-in isn't logged.** A PIN login sets the session (src/staff.js:304+); only "Logout" is logged;
  - **Admin passcode use isn't logged on its own.** `findAdmin` (src/staff.js:400) logs nothing; some actions add "authorised by …" in their own text;
  - **discounts** are stored on the sale (`discount_approved_by`), not in the log;
  - **voids: there's no void action in the app.** A sale is reversed with a return (credit note).
  - **Price changes** ("Price change") and **stock adjustments** ("Stock adjustment") are logged.

### A6. Other things found while inspecting

1. **Remote receivers get unit costs in the seiGEN pull.**
   - `cl_dispatch_json` includes `unit_cost` and the charge (20261017120000:190, :196), and the pull returns it for incoming dispatches (:307).
   - The app doesn't **show** it on a remote device (`dsShowCosts`, src/dispatch-srv.js:45), but uses it for the landed cost (:226).
   - **It breaks "remote branches never see costs" at the data level.** See question 12.
2. **The name "Stock Requests" is already taken.**
   - It's used by the customer-requests notepad: the `stock_requests` table, More → Requests, and the report "Stock Requests" (src/report-writer.js:160). It holds **customer names and phones**.
   - The new feature must not reuse that table or that name (see §15).
3. **In a `local` branch with several tills, each till keeps its own stock** (corrected 2026-10-13; an earlier draft said only the stock holder's counts).
   - A sale on T2 lowers T2's stock only. A T2 with no stock is told: "Receive stock on this till, or ask the main till to start shared stock for the branch" (src/pos.js:86-97).
   - The "stock holder" (the earliest active till, docs/multi-terminal/phase3b-design.md:98-99) matters only when **shared stock** is started: its stock seeds the branch.
   - How a multi-till branch's stock is counted is **open: see "Multi-till branches" below**. Mandie Harare has 3 tills.
4. **Uncommitted work in this folder:**
   - v21, "Admin passcode from main", Stage B, plus the receiving-wording fix;
   - 24 changed and 7 new files, migration `20261023120000` not applied.
   - This design doesn't touch them. They should be committed or finished first (see Rollout).

---

## Part B. Design (PROPOSED)

### 1. Joining: one join = linked to all

- **Confirmed, no server change** (A1).
- B1 fixes G1 (§2) and G2 (refresh the branch list at every check-in and when a branch screen opens online).

### 2. Stock by branch

**Choice: each till pushes its stock levels, not its movements.**

Why levels:
- **Idempotent by nature.** A level is absolute, so a retry, a reinstall or an old backup can't double anything. The next push simply overwrites it.
- **Bounded size:** products × tills, updated in place. It doesn't grow with time.
- **Self-correcting:** a missed push is healed by the next one.
- **It never touches the till's own numbers.** It reads `products.stock` and nothing else.

Movements would grow without limit and need perfect ordering. The document-level history main needs (adjustments, stocktakes, write-offs) comes in §5 instead.

**Server (B1):**

```
cl_till_stock_levels(
  terminal_id uuid, product_key text,   -- cat_uid when linked, else 'local:'||product uid
  business_id uuid, branch_id uuid,
  cat_uid text null, code text, name text,
  qty integer, low_threshold integer,
  as_of timestamptz,                    -- device time of the snapshot
  pushed_at timestamptz default now(),
  primary key (terminal_id, product_key))

cl_till_stock_push(
  terminal_id uuid primary key,
  as_of timestamptz, pushed_at timestamptz,
  products integer, full_seq bigint)
```

**RPCs** (device-authenticated like today; refusals as data):
- `cl_device_stock_levels_push(auth, p_as_of, p_full boolean, p_rows jsonb)`
  - upserts the levels;
  - `p_full` also removes this till's rows that aren't in the set (a deleted product).
- `cl_device_branch_stock(auth, p_branch_id uuid default null)`
  - **Per branch:** name, is_main, stock_mode, `as_of` (the "last updated" time), and rows `{product_key, cat_uid, code, name, qty, low}`. **Never cost.**
  - **The branch figure:**
    - for a `shared` branch: `cl_branch_stock.total`;
    - for a `local` branch: **waiting for your answer** on multi-till branches (see "Multi-till branches" below; recommended: the sum of the tills).
  - **Main callers only** also get the other tills' own figures, labelled "Till T2 (own count)".

**The device (B1):**
- It pushes only what changed since the last push. A watermark on `stock_movements.id` is kept in settings; a full push runs once a day.
- **When it pushes:** after a check-in, after a sale (debounced 60 s), on reconnect, and on a 5-minute timer while the app is open.
- **Cost of a push:** a 2,000-product shop sends about 2,000 short rows on the first full push, then a few rows per sale.

**Local cache:**
- A new table `br_stock(branch_id, product_key, cat_uid, code, name, qty, as_of, pulled_ts)`.
- It is **local only**: never merged, never read by `products`, `moveStock` or any existing report. **So nothing is ever counted twice.**

**What main sees:**
- **Products page** (own branch, editable as today):
  - **a read-only "Other branches" column**, the sum across the other branches;
  - tap it to see each branch's figure with "updated 14:05" (or "updated 3 days ago" in amber).
  - It shows only when the business has 2+ branches.
- **More → Product List:**
  - the branch selector lists **joined branches too** (fixes G1);
  - picking one shows `br_stock` rows, read-only.
- **New "Stock by branch" view:**
  - a product × branch grid, a "last updated" time per column, and a low-stock highlight;
  - **main only: "Value at cost"** = qty × **main's own cost** (main already has every catalogue cost). **No cost goes to the server for this**, and nothing about cost goes to remotes.

**What remotes see:** §6.

### 3. Sales sync (B4)

**Rules:**
- **Append-only and idempotent:** the server key is the device's `uid`, with `on conflict do nothing`.
- **Only this till's own sales are pushed:**
  - `merged_ts = ''`;
  - `branch = currentBranch()`;
  - `terminal_id` equal to this till's id, or NULL (sales from before registration).
  - **Merged sales never go up, so a branch merged into main by file is never counted twice.**
- **Push only when the business has 2+ branches** (the server says so in the pull). Single-branch shops gain nothing and would use space.

**Server (one row per document; lines and payments as compact `jsonb`, to save space, see §9):**

| Table | Holds |
|---|---|
| `cl_sales` | `(business_id, uid)` key; branch, terminal, receipt_no, ts, business_date, cashier, customer uid, subtotal, discount (+reason, approver), markup, voucher, total, price_level, `lines jsonb` (code, name, qty, price, discount, **cost**), `payments jsonb` (method, amount, currency, rate, tendered) |
| `cl_returns` | credit notes: uid, CN number, sale uid, reason, approver, `items jsonb` (incl. condition), `refunds jsonb` |
| `cl_shifts` | End of Day: uid, opened/closed by and at, opening float, expected, counted, variance, status. **Upsert only forward:** open → closed |
| `cl_payouts`, `cl_credit_receipts` | small, append-only |

**RPCs:**
- `cl_device_sales_push(auth, p_batch jsonb)`: up to 200 documents of any of these kinds. It answers `{accepted, already}` per uid.
- **Main-only readers:**
  - `cl_device_branch_sales_summary(auth, from, to, branch?, terminal?, cashier?)`: totals, by payment method, by branch, by till, by cashier, returns, credit sales, discounts, top products, shifts;
  - `cl_device_branch_sales_list(…, page)`: receipt detail on demand.
- **Line costs are returned only to main callers** (for margin).

**The device:**
- A watermark per table on the local integer id, kept in settings in the same database.
  - After a restore, the watermark comes back with the data, the older rows are re-sent, and the server answers "already". **No duplicates.**
  - After a reinstall without a backup there is nothing local to send, and the server keeps what it had.
- **When:** after each completed sale (debounced 30 s), at shift close, after a check-in, on reconnect, and on the 5-minute timer.

**Branch reports on main (Reports → Branch sales):**
- by branch, all branches, by till, by cashier, by date range;
- tiles and tables as above, each branch with "last updated".

**Double counting is avoided:**
1. Branch sales reads **only the server**.
2. Every existing report keeps reading **only this device**, unchanged. Its title gets "(this device)" when the business has 2+ branches.
3. Merged sales are never pushed.
4. **A test proves it:** for each till, the server totals equal that till's local totals for its own sales.

### 4. Activity log sync (B5)

**Pushed:** `audit_log` rows from this device (append-only, by `uid`), plus **new events** added at their source:
- **sign-in** (PIN or name) and sign-out;
- **Admin passcode used**, with what for (at `findAdmin` callers);
- discount given, with the approver;
- price change and stock adjustment (already logged);
- returns, write-offs, stocktake applied, EOD, till switched on or off;
- every stock request step (§15).

**Server:** `cl_activity_events(uid pk, business_id, branch_id, terminal_id, ts, user_name, action, product_name, details varchar(300))`. Index `(business_id, ts desc)`.

**Personal data:**
- The device cleans `details` before sending: **national IDs never go**, and **digit runs of 7 or more are masked** to the last 3 (`07*****123`).
- Customer names stay (needed for credit). Request notes and customer phones from the customer-requests notepad never go.

**Retention:** 12 months on the server (recommended), then deleted (§9). Every till keeps its full local log.

### 5. Branch activity page (main, B5)

One page, filtered by branch, type, date and person. It lists:
- **dispatches and GRVs, with differences**: from `cl_dispatches` (exists);
- **supplier GRVs**: `cl_supplier_grvs` (exists);
- **adjustments / write-offs, stocktakes applied, and file-path DNs and GRVs** (today these are local only): a new `cl_stock_docs(uid pk, business_id, branch_id, terminal_id, kind, doc_no, ts, by, authorised_by, reason, lines jsonb[code,name,qty_delta])`, pushed like §3;
- **stock requests** (§15).

### 6. Remote branches: "Other branches" (B1, read-only)

**More → Other branches**, two tabs:
- **Stock:** branch selector, product, **quantity only**, with "updated …" per branch. It comes from `cl_device_branch_stock`, which **never returns cost to any caller** (main values stock with its own costs, §2).
- **Dispatches:** across the business: in transit, received, received with differences, open differences.
  - New RPC `cl_device_business_dispatches(auth, days)`.
  - **For non-main callers it strips `unit_cost` and the charge.**

**No sales and no activity logs for remotes** unless you say otherwise (question 6).

### 7. Permissions

| Who | Sees |
|---|---|
| Main, **Admin** | everything in §2-§5 |
| Main, staff with the new flag **"View all branches"** | the same (recommended for managers; question 7) |
| Main, other staff | own branch only (as today) |
| Remote, any staff | Other branches: stock quantities and dispatch activity |
| Anyone with **"Review stock requests"** (Admin by default) | the request list and the actions (§15) |

- **The flags are staff columns**, like `can_create_customers`: `can_view_all_branches`, `can_review_stock_requests`.
- **The server enforces the branch rules** (main-only readers check that the caller till's branch `is_main`). **It can't enforce the person**, because staff exist only on the device (A5). The app gates the screens. Same limit as every device RPC today.

### 8. Server design (all phases)

- **Tables:** §2, §3, §4, §5, §13, §14, §15.
- **The business's id is stored on every row** for fast filters, with `branch_id` / `terminal_id` foreign keys.
- **RLS on, no grants to `anon` / `authenticated` on tables.** Access only through `security definer` RPCs, as today.

**Indexes:**
- `(business_id, branch_id, ts desc)` on sales, returns, shifts, activity and stock_docs;
- `(terminal_id)` on levels;
- `(business_id, status, updated_seq)` on requests.

**Billing-B's business model:**
- `cl_business_merge_core` (20261021120000:159) must move the new rows to the surviving business: one `update … set business_id` per new table.
- The **Chipo undo file** and the **delete guard** must list them too.
- Each phase's migration extends the merge function and has a test.

**Plans:** Lite allows one branch (`max_branches`, 20261013120000:82), so only multi-branch plans ever push sales.

**Each phase gets:**
- a migration with a preflight;
- a rollback (it refuses while rows exist, unless forced by you);
- a PGlite test;
- the rebuild lists and the live fingerprint updated after "apply".

**Migration names** (after the pending `20261023120000`):

| Phase | Migration |
|---|---|
| B1 | `20261024120000_branch_stock` |
| B2 | `20261025120000_dispatch_returns_transport` |
| B3 | `20261026120000_stock_requests` |
| B4 | `20261027120000_branch_sales` |
| B5 | `20261028120000_branch_activity` |
| B6 | Console RPCs, in B4 and B5 |

### 9. Size and cost

**Today:** 17 MB used. The 500 MB Free limit is the figure you gave; check the current plan on the Supabase dashboard (I can't see billing from here).

**Free plan notes:**
- **No `pg_cron`** (20261016120000:43), so deleting old rows runs from a Console button or opportunistically inside the push RPC: at most once a day per business.
- Free plan egress is limited too. This is why main reads **server-side summaries**, not every row.

**Row sizes (ASSUMED, from column widths plus Postgres overhead and indexes):**

| | Size |
|---|---|
| One sale with ~2.5 lines and ~1.1 payments, stored compact (one row, `jsonb`) | **≈ 0.6 KB** (≈ 1.0 KB if normalised; the reason for `jsonb`) |
| One activity event | ≈ 0.25 KB |
| Stock levels | products × tills × ≈ 0.15 KB, **not growing** |

**Per till per month:**

| Till | Sales/day | Sales | Logs (30-60 events/day) | **Total** |
|---|---|---|---|---|
| Light | 30 | 0.55 MB | 0.25 MB | **≈ 0.8 MB** |
| Typical | 80 | 1.45 MB | 0.35 MB | **≈ 1.8 MB** |
| Busy | 200 | 3.6 MB | 0.45 MB | **≈ 4 MB** |

**When 500 MB runs out** (≈ 400 MB usable, keeping ~80 MB spare; typical tills; "shops" = syncing tills):

| Syncing tills | Growth/month | Keep everything | Keep 12 months of sales detail | **Keep 90 days of detail + daily summaries** |
|---|---|---|---|---|
| 20 | 36 MB | full in ~11 months | levels off ~430 MB: **over** | **levels off ~110 MB: fine** |
| 50 | 90 MB | ~4.5 months | over | **~270 MB: fine** |
| 150 | 270 MB | ~1.5 months | over | ~800 MB: **needs Pro** (8 GB, about USD 25/month; confirm the price) |

**Options:**
1. **Sync only businesses with 2+ branches** (recommended). Today that's 3 of 12 businesses and 10 of 22 tills.
2. **Sales detail 90 days on the server, then rolled up** into `cl_sales_daily` (per till per day: totals by method, by product qty and amount), kept 24 months. Tills keep full detail locally.
3. **Activity events:** 12 months.
4. **Move to Pro** when syncing tills pass about 80.

### 10. Sync timing and "last updated"

| What | When a till pushes | When others see it |
|---|---|---|
| Stock levels | after a check-in; 60 s after a sale; on reconnect; every 5 min while open; a full push daily | at their next pull: opening the screen online, after a check-in, every 5 min |
| Sales, returns, shifts, payouts | 30 s after a sale; at shift close; after a check-in; on reconnect; every 5 min | main's Branch sales loads on open and on Refresh |
| Activity, stock documents | with the sales batch | Branch activity on open and on Refresh |
| Stock requests | at once when online; queued when offline | reviewers: badge on the next pull (every 5 min while open, after a check-in) |

- **Offline**, every branch screen shows the **last pulled copy** with "updated 2 h ago (offline)".
- **Each branch column** shows its own `as_of` / last push. A branch not heard from in 24 hours is shown in amber with "not updated since …".

### 11. Rollout

**Order per phase:** migration (backup, SQL shown, your "apply") → app build (previews) → Console.

**Before B1:**
- commit or finish the v21 work now uncommitted (A6.4);
- apply its migration `20261023120000`, so the migration chain stays in order.

**Existing local history:**
- **Recommended: start from the update.** Sales, logs and stock documents made after the update go up.
- Also add a main-only button, **"Send this till's last 90 days"**, run once per till when you choose. It's idempotent by uid, so running it twice is harmless.
- **Why not backfill automatically:** about 4 MB per typical till all at once, and old pre-registration rows whose till can't be proven.
- **Stock levels are a snapshot anyway**, so they are complete from the first push.

### 12. Dispatch and GRV options (B2)

**Dispatch (Products → Dispatch icon):**
- **The first step is "How do you want to send it?"**
  - **Option 2: Send through seiGEN.** The destination list holds **only branches of this business** (`ds_branches`).
  - **Option 1: Send as file (WhatsApp).** The destination list is the register, as today, plus joined branches.
- **Option 2 is selected by default when it can be used.**
- **When it can't, the card is greyed with the reason in plain words, and Option 1 is offered:**
  - "This till isn't registered with seiGEN" (Settings → Business & Terminals);
  - "This till is switched off for the business";
  - "This till uses shared stock; send by file for now";
  - "No other branch has joined yet";
  - for a typed or register name not in the business: "X isn't a branch of {business} on seiGEN" (the existing text).
- **Offline doesn't block Option 2.** The dispatch is saved and sent when the till is back online (as today, `srv_pending`). It says: "You're offline: it goes to seiGEN when you're back online."
- **What changes in code:**
  - today a dispatch to a joined branch **always** goes through seiGEN. With Option 1 picked for a joined branch it is file only (`srv` not passed). **That's a rule change.**
  - With Option 2, the file is still made, labelled **"Copy for the driver (they receive it in seiGEN Incoming)"**. Importing it at the receiver stays refused (`dsFileCheck`, src/dispatch-srv.js:509-520).
  - Everything else is labels plus the choice step in `openDispatchScreen`. `dnCommitDispatch` is unchanged.

**Receive (GRV):**
- **One "Receive (GRV)" icon on Products** opens a chooser:
  - **Option 2: From seiGEN Incoming (n waiting)**: opens the existing Incoming tab;
  - **Option 1: From a Delivery Note file (Import)**: opens the existing `openReceiveScreen`;
  - **on main only:** a link to **Receive from a supplier (GRV)** (unchanged; it stays in Purchasing too).
- The seiGEN icon stays for Sent / Differences / In transit and its badge.
- **Import GRV / reply** (the sender's step, in Dispatch history) is unchanged, keeping the v21 wording.
- **What changes:** one chooser modal plus labels. No logic change.

### 13. Rejected and damaged lines, and returns (B2)

**Line states at a seiGEN GRV** (the file path keeps Accept / Variance):

| State | Goods are | Receiver's stock | Sender's stock | Then |
|---|---|---|---|---|
| Received | at the receiver | +qty | (already out) | done |
| **Short** | missing | – | +qty at its next pull (as today) | sender: write off (ADJ, Admin passcode) or re-dispatch: **unchanged** |
| **Rejected** (new; reason required: wrong item, expired, not ordered, poor quality, other) | at the receiver, refused | – | **nothing yet** | the receiver **returns** them; the sender's stock goes up **when it confirms the return** |
| **Damaged, send back** (new choice) | at the receiver | – | nothing yet | as rejected |
| **Damaged, keep and write off here** (new choice) | at the receiver | +qty, then −qty (ADJ "Damaged", **Admin passcode** at the GRV) | – | closed; the loss is the receiver's |
| Extra | at the receiver | +qty | −qty when the sender confirms (as today) | unchanged |

**The return document: a reverse dispatch with `kind = 'return'`.**
- It goes in the same `cl_dispatches` table, with `return_of_dispatch_id` and the issue ids it carries.
- Numbered **RTN-T1-0001** (new doc type in `doc_counters`).

**Steps:**
1. **At the GRV**, rejected and damaged-send-back lines become issues `rejected` / `damaged_return`, status `open`.
2. **The receiver taps "Return to {sender}"** on the issue and picks Option 2 (seiGEN) or Option 1 (file).
   - **No stock moves at the receiver:** these goods never entered its stock.
   - Issue status → `returning`.
3. **The sender receives the return** like a GRV, in Incoming, any staff.
   - Its stock goes **+qty once**: key `<return uid>`, the same once-only ledger rule as today.
   - Issue → `returned`.
   - If less arrives back, the gap becomes a `short` on the return, handled by the **existing shortage path**: the sender writes off with the Admin passcode.
4. **File path (Option 1):**
   - the return file is a DN v4 with `kind:"return"` and the original DN;
   - the sender opens it with Receive (GRV) → From a file;
   - the receiver's step tells seiGEN through the existing via-file post, so it's counted once.

**How it joins the existing paths:**
- **short** is untouched;
- **extra** is untouched;
- **legacy `damaged` issues** (the "back on paper, sender writes off" rule) keep working for any dispatch already received that way. **Live has 0 dispatches, so none exist.**
- The new GRV form offers only the two new damaged choices.

**Goods already in the receiver's stock** (a file-path receipt, or found faulty later):
- they go back with an **ordinary dispatch** marked "Return of DN-…";
- it deducts the receiver's stock as any dispatch does. **That already works today.** Only the label and link are new.

**Admin passcode points:**
- writing off kept-damaged goods at the GRV (receiver);
- writing off a return shortfall (sender), as today;
- cancelling a return before it's received (the returning till), as dispatch cancel today.
- Rejecting, sending back and receiving a return need **no** passcode, like counting today.

**Server:**
- `cl_dispatch_lines` + `rejected`, `damaged_kept`, `reason`;
- issue kinds + `rejected`, `damaged_return`, `damaged_kept`;
- statuses + `returning`, `returned`;
- `cl_dispatches` + `kind`, `return_of_dispatch_id`;
- the GRV check becomes received + damaged + rejected ≤ sent;
- new `cl_device_return_send`;
- `cl_device_grv_post` closes the linked issues for `kind = 'return'`.

### 14. Transport charge (B2)

**Data:**
- `cl_dispatches.delivery_paid_by text not null default 'receiver' check (in ('receiver','sender'))`;
- local `dispatch_docs.delivery_paid_by` (default `'receiver'`).
- **Old dispatches read as "Receiving branch"**, today's rule (the column default; nothing to migrate: 0 on live).

**Dispatch screen:**
- **"Transport cost"** + currency + carrier + reference (exist);
- **"Charged to: Receiving branch (default) / Sending branch"**.

**The accounting:**

| | Receiving branch (today) | Sending branch (new) |
|---|---|---|
| Receiver's unit cost | landed: unit cost + share of transport | unit cost only |
| Inter-branch charge | receiver owes sender | **none** |
| Sender | – | **its own transport expense**: shown on Stock Dispatched, Branch activity and the Console. It's **not** a till payout, so EOD cash isn't touched (question 1b) |

**Every place that assumes the receiver pays:**

| Place | What it assumes |
|---|---|
| 20261017120000:368-371 (`cl_device_grv_post`) | always inserts the charge |
| 20261017120000:138-146 | the comment "owed_by = the receiving branch" |
| src/dispatch-srv.js:185-197 (`dsLandedCosts`) | always adds the delivery cost |
| src/dispatch-srv.js:218 and :226 (`dsApplyGrv`) | writes the landed cost |
| src/dispatch-srv.js:615 | "(added to the cost of what you receive)" |
| src/dispatch-out.js:306-310 | the delivery cost box, with no payer |
| src/dispatch-srv.js:573 | the In transit value line |
| docs/dispatch/dispatch-grv-supabase-design.md §14 and question 2 | the earlier decision |
| Console Dispatches page (D:\SCL Console) | shows `delivery_cost` only (from `cl_dispatches_list`); it gets a "Paid by" column |

**Returns (§13):** they default to **Sending branch of the return** (question 1c).

**Remotes and costs:**
- unit costs are never shown, as today;
- **the transport amount on a dispatch they send is typed by them**, so it shows on their own screens;
- whether a remote receiver sees the charge it owes is question 1d.

### 15. Stock requests (B3)

**The name:**
- the new feature is **"Request stock"**;
- the existing notepad gets the label **"Customer requests"** (label only; its table, data and report stay).

**Screens:**
- **Request stock modal**, for all signed-in staff:
  - a button on Products, and in the Sell screen's menu;
  - lines: product (this branch's products; catalogue-linked ones carry `cat_uid`) and quantity;
  - **From:** "Any branch" or a branch of the business (from `ds_branches`), each with its quantity from §2;
  - **Urgency:** Normal / Urgent / Today;
  - **Note.**
  - Offline, it's saved and sent later ("Waiting to send").
- **My requests** (the requester): status **Pending → Approved → Dispatched → Received**, or **Rejected** (with reason), or **Ordered from a supplier**.
- **Requests to review** (reviewers):
  - a **badge** on the drawer and a **list across all branches**, oldest urgent first.
  - **Approve → choose the source branch**, showing each branch's quantity:
    - if the source is this till's branch, **Dispatch opens prefilled** (lines, destination = the requester, Option 2) and the dispatch carries `request_id`;
    - otherwise the request shows at the source branch as "Approved: dispatch to X", with **Create dispatch** prefilled.
  - **Reject**, with a reason;
  - **Mark as ordered from a supplier**: supplier (main's list) and a note.
- **Statuses update by themselves:** the dispatch send sets **Dispatched**; its GRV sets **Received**.

**The new permission:** staff flag **"Review stock requests"**, Admin by default.

**Server:**
- `cl_stock_requests(id uuid pk, business_id, requester_branch_id, requester_terminal_id, requested_by, from_branch_id null = any, urgency, note, status, source_branch_id, decided_by, decided_terminal_id, decided_at, decision_note, supplier_uid, dispatch_id, created_at, updated_seq)`;
- `cl_stock_request_lines(request_id, line_no, cat_uid, code, name, qty)`;
- `cl_stock_request_log(request_id, at, terminal_id, by_name, action, detail)`.

**RPCs:**
- `cl_device_stock_request_create`: idempotent by id;
- `cl_device_stock_requests_pull(auth, cursor)`: a reviewing till gets its whole business; others get their own branch's requests and those approved from their branch;
- `cl_device_stock_request_decide(auth, id, action, …)`;
- the dispatch send gets an optional `request_id`.

**Notifications:** in-app only. A badge count from the last pull, and a one-line toast when a request you made changes status. They work across branches through the server; offline requests are queued.

**Activity log:** every step (made, approved, rejected, ordered, dispatched, received) → `logAudit` locally and `cl_stock_request_log` on the server, with who and when. It joins the §4 sync.

**Risk Management report: there's none today** (A5). **The smallest useful version** goes in Reports, main only, filtered by branch and date:
1. **Stock requests:** open, urgent, older than 2 days, rejected;
2. **Write-offs:** ADJ by reason, quantity and value at main's cost;
3. **Dispatch differences:** short, damaged, rejected, still open;
4. **Returns (credit notes)** by reason;
5. **Admin passcode uses** and **large discounts** (from B5).

- In B3 it reads what exists (requests, this device's ADJs, `cl_dispatch_issues`).
- After B5 it reads all branches.
- **"Voids" can't be listed: the app has no void action** (returns are credit notes).

### 16. Tests, risks, rollback

**Tests** (your Stage B list, plus):
- **Two branches, three tills, offline then online:**
  - levels, sales and requests arrive once;
  - retries, a reinstall and a restore of an older backup make no duplicates;
  - **main's server totals equal the sum of each till's local own-sales totals**;
  - merged-file sales are never pushed.
- **Remote callers never receive cost:**
  - an RPC-level test on every new reader;
  - the dispatch pull stripped (question 12).
- **Permissions:** main-only readers refuse remote callers; staff flags gate the screens.
- **Dispatch:**
  - Option 1 / Option 2 end to end;
  - Option 1 to a joined branch stays file only;
  - both GRV paths;
  - a rejected line returned (the sender's stock goes up once, also after a retry and after a restore);
  - damaged kept and written off;
  - a return shortfall written off;
  - transport to the sender vs the receiver (landed cost and charge present or absent);
  - old dispatches default to the receiver.
- **Requests:** made offline → queued → approved → dispatched → received; rejected; ordered; the reviewer's badge on another branch.
- **Billing-B:** a business merge moves every new table's rows; the undo puts them back.
- **All existing suites stay green**, the dispatch / DN / receive / cancel / docnum tests above all, plus all three builds.

**Risks:**
- **Sync must never change a till's own numbers.** Every new path only **reads** local tables; the only local writes are new cache tables. A test compares the local database byte for byte before and after a sync, apart from those tables.
- **Space on Free:** mitigated by syncing only multi-branch businesses, 90-day detail and summaries (§9).
- **Staff identity isn't known to the server.** Permissions are per device, as today.
- **A clock that's wrong on a till** gives wrong "updated" times. The server's `pushed_at` is shown alongside.

**Rollback:**
- each phase's rollback drops its tables and RPCs, and **refuses while rows exist** unless you say so;
- the app hides each feature when its RPC is missing (refusal as data), so an older server never breaks the till;
- **the file paths stay throughout.**

---

## Questions for you (each with a recommendation)

1. **Transport charge**
   - a. Default "Receiving branch" (today's rule)? **[Recommend: yes.]**
   - b. A "Sending branch" charge is only recorded, not a till payout? **[Recommend: recorded only, so EOD cash isn't touched.]**
   - c. On a return of rejected goods, the returning branch pays? **[Recommend: yes, changeable per return.]**
   - d. Does a remote receiver see the transport charge it owes? **[Recommend: yes, the amount only; it's not a product cost.]**
   - e. Can the receiver dispute a charge? **[Recommend: not now; a note on the GRV, settled by the managers.]**
2. **Returns of rejected goods:** does the sender confirm receipt (like a GRV) before its stock goes up? **[Recommend: yes, any staff, counted once; a shortfall goes to the existing shortage path.]**
3. **Damaged goods:** let the receiver choose per line, "Send back" or "Keep and write off here" (Admin passcode)? **[Recommend: yes, the receiver chooses per line. This replaces the earlier "back on paper, the sender writes off" for new GRVs.]**
4. **Stock requests: who reviews by default?** **[Recommend: Admin and "Review stock requests" staff on the main branch, for all branches. The branch named in "From" sees requests addressed to it read-only, and creates the dispatch once main approves.]** Can a remote request from another remote? **[Recommend: yes; any branch, or "Any".]**
5. **Risk Management report:** start with stock requests, write-offs, dispatch differences and returns (B3), then add passcode use and large discounts (B5)? **[Recommend: yes. Voids don't exist in the app.]**
6. **Remote branches and sales:** **[Recommend: nothing about other branches' sales for now.]**
7. **Who on main sees all branches?** **[Recommend: Admin, plus a new "View all branches" flag for managers.]**
8. **Old sales:** **[Recommend: start from the update, plus a one-off "Send this till's last 90 days" button you run per till.]**
9. **Server retention:** **[Recommend: sales detail 90 days, then daily summaries kept 24 months; activity events 12 months; requests and stock documents 24 months.]**
10. **Stock value at cost per branch on main:** **[Recommend: yes, main only, using main's own catalogue costs; never sent to remotes.]**
11. **Sync only businesses with 2+ branches?** **[Recommend: yes, for space.]**
12. **Costs in the seiGEN dispatch pull (A6.1):** today a remote receiver's device gets unit costs and uses them for its landed cost, without showing them. **[Recommend: strip costs from the pull for non-main tills. A remote then keeps catalogue cost (none), and main values every branch with its own costs. Remote margins were never shown anyway.]**
13. **Ambiguities in today's code:**
    - a. In a `local` branch with several tills, only the stock holder's stock is the branch's (A6.3). Branch stock = the stock holder's figure, with other tills listed separately on main? **[Recommend: yes.]**
    - b. With Option 1 picked for a joined branch, the dispatch becomes file only (today it always went through seiGEN). OK? **[Recommend: yes, that's the point of the choice.]**
    - c. The label "Stock Requests" moves to the new feature, and the old notepad becomes "Customer requests"? **[Recommend: yes.]**
    - d. Sign-in and Admin-passcode use aren't logged today. Add both as events in B5? **[Recommend: yes.]**

---

## Owner decisions (2026-10-13)

| # | Decision | Changes to the design above |
|---|---|---|
| 1 | Transport: default **Receiving branch**. The other parts of question 1 as recommended | none |
| 2 | Returns: the **sender confirms receipt** before its stock goes up; **any staff** may confirm | none |
| 3 | Damaged goods: the **receiver chooses per line**: send back, or write off with the Admin passcode | none |
| 4 | Reviewers: **main's Admin + anyone with "Review stock requests"** (that flag is renamed, see 11). Any branch may request from any branch (as recommended) | none |
| 5 | Risk report: as recommended | none |
| 6 | Remote branches see **none** of the other branches' sales | none |
| 7 | On main: Admin + a "View all branches" flag (as recommended) | none |
| 8 | Old sales: **start from the update**, plus a one-off "Send the last 90 days" button per till | none |
| 9 | Server keeps **90 days of sales detail plus daily summaries**; the rest of question 9 as recommended | none |
| 10 | Stock value at cost on main (as recommended) | none |
| 11 | **Sync scope: businesses with 2 or more TILLS** (not just 2+ branches) | §3: a business pushes sales, logs and stock documents when it has **2+ active tills**, in any branches. So a one-branch shop with T1 + T2 syncs too. §9: the "Sync only multi-branch businesses" count becomes "2+ tills": today **5 of 11 active businesses and 15 of 21 active tills** (VERIFIED on live: KNIX Phones 5 tills in one branch, Mandie 4, Chipo 2, DEMO 2, Lazy One Shoes 2 in one branch) |
| 12 | **Cost leak: stop sending unit costs to remote devices.** The landed-cost maths moves to main / the server. **Built in B2** | B2: `cl_dispatch_json` gets a caller flag; for a non-main caller it drops `unit_cost` and the charge. At the GRV the **server** works out each line's landed unit cost (unit cost + its share of transport, only when charged to the receiver) and stores it on `cl_dispatch_lines.landed_cost`. **A remote receiver no longer writes a cost** into its products; main sees the landed cost in its reports. When the receiver is main, the server returns the landed costs in its GRV answer and main writes them, as today |
| 13 | **The new feature is named "Stock Requisition".** The existing "Stock Requests" notepad keeps its name | §15: "Request stock" → **"Stock Requisition"** (the modal, the list "Stock Requisitions to review", the flag **"Review stock requisitions"**, the server tables `cl_stock_requisitions*`, the doc number **SRQ-T1-0001**). Nothing about the notepad is renamed. Question 13c is withdrawn |
| 14 | **Multi-till branches:** explain how branch stock should be counted, and wait for the answer **before B1** | below |
| 15 | **Log sign-ins and Admin passcode use** (B5) | as §4 |
| 16 | All other questions: as recommended | none |

## Multi-till branches: how should a branch's stock be counted? (WAITING for your answer)

**How it works today (VERIFIED):**
- In a normal (`local`) branch, **each till keeps its own stock list**.
- When T2 sells a shirt, only T2's count goes down. T1 doesn't know.
- A new T2 starts with **no stock**, and the app tells it: "Receive stock on this till, or ask the main till to start shared stock for the branch" (src/pos.js:86-97). So each till's stock is whatever was received, adjusted or counted **on that till**.
- **Shared stock** (built in Phase 3b) is the other mode: the branch's stock lives on seiGEN, and every till sells from it, with a small allowance each for when it's offline. Your standing rule so far: **don't start shared stock on real branches.**

**The three ways to count it:**

| | What the branch figure is | Right when | Wrong when |
|---|---|---|---|
| **A. Sum of the tills** | T1 + T2 + T3 | each till has its own goods: separate counters, or a till given stock by dispatch / receive | the tills were each loaded with the **same** stock list (e.g. the same Excel import on every till): then the sum counts every item 2 or 3 times |
| **B. One stock till** | only T1's (the stock holder's) figure; the other tills are ignored | the other tills never really hold stock | T2 sells: its sales never lower the branch figure, and T2 can't sell anything it has no stock for on its own list. **It doesn't match how the app works today** |
| **C. Shared stock** | one figure on seiGEN that every till sells from | one shop floor with several tills: the true answer | it's a bigger switch per branch (a start step, allowances, the Admin merge report), and it goes against "no shared stock on real branches" |

**My recommendation: A, the sum of the tills, with each till's own figure shown underneath on main.**
- **It's what the numbers already mean today.** Each till's figure is real stock that till received and sells, so adding them is the true branch total.
- **It needs no change to how any till sells.**
- **Guard against the double-loading case:** when two tills of a branch show the **same quantity for most of their products**, main sees an amber note: "T1 and T2 look like copies of the same stock list: the branch total may be counted twice. Count the stock (Stocktake) on one of them."
- **For one shop floor with several tills**, **C (shared stock)** is the better long-term answer. It can come later, branch by branch, when you lift the "no shared stock" rule. A branch already in shared mode simply shows seiGEN's figure.

**To check on Mandie Harare (T1, T2, T3) and KNIX Phones (5 active tills, one branch):** on each till, open Products and look at 2 or 3 products. If T2 and T3 show the **same numbers as T1**, they were loaded with copies, and A would count them 3 times there until those tills are counted.

**STOP: waiting for your answer (A, B or C) before B1.** Nothing for B1 is built yet.
