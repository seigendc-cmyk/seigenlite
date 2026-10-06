# Multi-terminal sync — Phase 3b design: shared branch stock + offline allowance

Status: **Stage A (design only). Nothing implemented. Waiting for "go Phase 3B-B".**
Branch: `phase3b-shared-stock` from `phase3a-catalogue-sync` at `217e440`. Phase 3a hasn't been promoted (production and `main` are still `04010ff`).
Baseline (VERIFIED, 2026-10-06): all 65 suites (60 `test/`, 5 `supabase/tests` in PGlite) pass on `217e440`.
Status words: VERIFIED (read in code or the live database, read-only), PROPOSED, ASSUMED.
Owner decisions this design implements: `phase3a-design.md` §12 (never below zero) and §13 (Phase 3b decisions).

---

## 0. Decisions in one page

| # | Proposal | Why |
|---|---|---|
| P1 | A branch has a **stock mode**, `local` or `shared`, held on the server (`cl_branches.stock_mode`). It becomes `shared` once, by an explicit **"Start shared stock"** done by an Admin on the till that holds the branch's stock. **Once shared, it stays shared.** | No silent switch can double-count, and a branch never flips back and forth. |
| P2 | The T2+ note is decided by the server's answer, not the till code: shown when the branch is `local` **and** this till isn't the branch's **stock holder**. | Fixes the 3a edge case: a branch whose T1 is deactivated and runs on a single T2. |
| P3 | **Server model:** per branch and product, `total` = `available` + the sum of the tills' `allowance`. Every change is a row in `cl_stock_events`, keyed by the movement's `uid`, so a retry is a no-op. One sequence orders everything. | Balanced by construction and idempotent. |
| P4 | **Online sale:** one RPC, `cl_stock_sale(sale_uid, lines)`, locks the cart's rows and checks all lines; all or nothing. It takes from `available` first, then this till's own allowance. It refuses with the product and how many are left. **Timeout 4 s.** | Two tills can never both sell the last unit. |
| P5 | **Timeout or offline:** the sale goes ahead only if **this till's allowance** covers every line. It's then recorded as an offline sale and reported later with the same `sale_uid`. If the timed-out request had actually succeeded, the server recognises the uid and gives the allowance back. | No double decrement, and the till never hangs. |
| P6 | **On a shared-stock till, `products.stock` = this till's allowance** (what it can sell offline). The last-known branch `available` is cached separately. Online it can sell up to allowance + available; offline, up to allowance. | The Phase 2 ledger (`moveStock`, `stock_movements`) keeps working: allowance in and out are movements. |
| P7 | **Other movements:** receiving, purchases, positive adjustments and restock **add to the branch when online**. Offline they're recorded locally and **become sellable only after sync** (Q3). Negative adjustments, DN dispatch, import "apply qty" and stocktake **need a connection** at a shared branch. | Nothing offline can take branch stock below zero. |
| P8 | **Stocktake at a shared branch:** posted only when **no other till holds allowance** (the server checks). The server sets `total` to the count and works out the change against the total at posting time. | One consistent count. |
| P9 | **Deactivating a till returns its allowance** to `available` at once. Its offline sales are still accepted when it reconnects: a report-only RPC is allowed for inactive tills. Any shortfall is recorded as a **discrepancy**, never as negative stock. | Matches owner decision §13 and Phase 2. |
| P10 | Single-till branches that never start shared stock, and unregistered shops: **no change at all.** | Owner decision 4. |

---

## 1. Inspection (VERIFIED)

### 1.1 Baseline
- **Branch:** `phase3b-shared-stock` = `217e440`.
- **Live database (read-only, 2026-10-06):**

| Business | Branch | Tills |
|---|---|---|
| IVO Dist | Warehouse (main) | T1 |
| Lazy One Shoes | Harare LOS (main) | T1, T2 |
| Mandie Babyware | Harare (main) | T1, T2, T3 |
| Mandie Babyware | Murehwa (remote) | T1, **deactivated** |

- **So 6 of 7 tills are active, not 7.** The Murehwa till was deactivated after the Phase 3a verification.
- **`cl_catalogue_products` has 3 rows.** A registered main ran its first sync after 3a was applied (assumed to be from preview testing).
- All six 3a functions are present.

### 1.2 Every stock movement (`moveStock` / `recordStockMovement`)
| Kind | Where |
|---|---|
| sale | `src/pos.js:560` (inside `completeSale`, `src/pos.js:441`) |
| receive (GRV) | `src/receive-in.js:65` |
| dispatch (DN) | `src/dispatch-out.js:212` |
| dispatch (replacement DN, reissue) | `src/dn-cancel.js:54` |
| adjustment, including cancel restores and write-offs | `src/adjust.js:100` (`writeAdjustment`) |
| stocktake (set to count) | `src/stocktake.js:226` |
| import "apply qty" (set) / new product | `src/import.js:227` / `:239` |
| restock | `src/products.js:200` |
| new product with opening stock | `src/products.js:132` |
| purchase (existing / new product) | `src/purchasing.js:132` / `:133` |
| legacy transfer receive | `src/dispatch.js:27` / `:37` |
| opening balance | `src/db.js`, `migrateStockLedger` |

**Refunds / voids:** none in `src/`. `grep` finds no refund, void or sales-return code; the returns work sits on an unmerged branch. Nothing to design for them here.

### 1.3 The zero-stock block and the 3a note
- **The block:**
  - `addToCart` and `changeQty`: `src/pos.js:12-24`.
  - Mobile Add chip: `src/pos.js` `productListHtml`, `disabled` at `stock<=0`.
  - Desktop Add button: `src/desktop/sales-desktop.js:101`.
- **The note:** `tillStockPending()` (`src/pos.js:23`) is `registered && till_code !== "T1"`.
  - This misses the case **live already has**: Murehwa's T1 is deactivated. A replacement T2 there would be the only active till yet still get the note, and still have zero stock.

### 1.4 Checkout
- `completeSale(method, payments)` (`src/pos.js:441`) is **synchronous**.
  - It validates (shift block, currencies, amounts, credit customer, discount reason, payment reference), writes `sales`, `sale_payments` and `sale_items`, calls `moveStock` per line, then `persist()` and `render()`.
- **Callers** (`src/router.js:199-211`, `src/desktop/sales-desktop.js:230-242`) call it, then `resetTemp()`.
- **74 test call sites** assume it is synchronous.
- **Where the server check sits:** split into the validation and the local commit. Tills that aren't shared-stock call the same synchronous code as today. A shared-stock till runs `validate → await cl_stock_sale (4 s) → commit`, and the cart is cleared only after the commit.

### 1.5 Phase 3a plumbing that can be reused
| Piece | Reuse |
|---|---|
| `terminalRpc` (`src/terminal.js:61`), phrase + install + device key, **10 s** timeout | Reused, with a per-call timeout added (4 s for a sale) |
| `cl_catalogue_caller` (server) | Reused by every stock RPC; the inactive-till exception is in the report RPC only |
| `catalogueSyncNow` orchestration and `catState.running` single-flight | Same pattern: `stockSyncNow` runs after the catalogue sync |
| Background tick: **`CAT_POLL_MS` = 5 min** (`src/catalogue-sync.js:22`), plus `online` and right after register/join | Stock sync piggybacks on it. **Correction to my 3a report:** catalogue pushes go out on this 5-minute tick, on Sync now, and on reconnect, not on a 60-second tick (that's the separate `sync_queue` worker). |
| `catSafeToRedraw()` (`src/catalogue-sync.js:571`) | Reused for stock redraws |
| `cat_uid` (catalogue identity) | Branch stock is keyed by `cat_uid` |
| Business row lock before `nextval` (3a) | Same ordering guarantee |

### 1.6 Reports that read stock
- `src/report-writer.js:19,37-39,110` (stock levels, low stock, ageing) read `products.stock`.
- On a shared till that would be its allowance, so they'll read the cached branch figure instead (§7).

---

## 2. Multi-till and the switch-over (PROPOSED)

- **"Multi-till"** is a branch with **more than one active till**. It may switch to shared stock; it never has to.
- **Stock holder:** the branch's active till with the earliest registration (normally T1). The server works it out and returns it in the pull (`stock_holder_terminal`). If T1 is deactivated, the next active till is the holder, starting from its own local stock (often 0).
- **Before switching:** the stock holder sells from local stock as today. Other tills show the 3a note.
- **Start shared stock** (`cl_stock_start_shared`, Admin passcode on the holder):
  1. The holder sends its local stock for every **linked** (`cat_uid`) product as one batch, with an `op_id`.
  2. The server, in one transaction:
     - checks the branch is still `local` and the caller is the holder;
     - sets `total = available = qty` per product;
     - marks the branch `shared`;
     - records one `opening` event per product.
     - A replay of the same `op_id` changes nothing.
  3. The holder writes an `allowance_out` movement per product (local stock → 0), then receives its first allowance like any till. The ledger balances.
- **Other tills' own local stock** (e.g. a T2 that received a GRV): on its first stock sync after the switch it shows a **merge report**, e.g. "This till has 5 Rice 2kg of its own. Add to branch stock?". An Admin confirms, and it's sent as `merge` events. Nothing is added silently.
- **Unlinked products** (no `cat_uid`, e.g. remote-only items kept by the 3a first sync) stay **till-local** and are listed in the switch-over report.
- **Never switches back.** If tills drop to one, that till simply works through allowances; online it sells from branch stock as before.

---

## 3. Server model (PROPOSED)

```sql
alter table cl_branches add column stock_mode text not null default 'local' check (stock_mode in ('local','shared'));
alter table cl_branches add column stock_shared_ts timestamptz;

create table cl_branch_stock (                       -- one row per branch and catalogue product
  branch_id uuid references cl_branches(id), product_uid text, business_id uuid,
  total integer not null check (total >= 0),
  available integer not null check (available >= 0),
  change_seq bigint not null,
  primary key (branch_id, product_uid));

create table cl_till_allowance (                     -- what each till may sell offline
  terminal_id uuid references cl_terminals(id), branch_id uuid, product_uid text,
  qty integer not null check (qty >= 0), change_seq bigint not null,
  primary key (terminal_id, product_uid));

create table cl_stock_events (                       -- every change, once
  uid text primary key,                              -- the movement's uid (sale uid, GRV movement uid, op id...)
  branch_id uuid, terminal_id uuid, product_uid text,
  kind text,          -- opening | sale | offline_sale | receive | adjust | stocktake | dispatch | merge | allowance_take | allowance_return | discrepancy
  qty_delta integer,  -- change to total
  from_available integer, from_allowance integer,
  seq bigint, ts timestamptz default now(), detail jsonb);
```
- **Invariant, checked by a constraint trigger at commit:** `total = available + sum(allowance)` per branch and product.
- **Locking:** every write locks the business row first (3a ordering), then the `cl_branch_stock` rows in `product_uid` order, so two carts can't deadlock.
- **Security:** RLS on, no table grants, RPCs only, the 3a `cl_catalogue_caller` credential check.

### RPCs
| RPC | Who | Does |
|---|---|---|
| `cl_stock_start_shared(op_id, rows)` | stock holder, branch `local` | §2 |
| `cl_stock_sale(sale_uid, lines)` | active till, branch `shared` | Atomic for the whole cart. Takes from `available`, then own allowance; refuses `{product_uid, left}`; a replay of the `sale_uid` returns the first answer. |
| `cl_stock_report(sales, moves)` | **any till, including deactivated** | Reports offline sales (from own allowance; any shortfall from `available`; anything still uncovered is a `discrepancy` event, never negative) and offline-recorded receipts and positive adjustments. Each is idempotent by uid. |
| `cl_stock_move(moves)` | active till, online | Online receive, purchase, adjustment, restock and dispatch. A negative move takes from `available` then own allowance, refused below zero. |
| `cl_stock_stocktake(op_id, counts)` | active till, Admin locally | Refused while any **other** till holds allowance; sets `total` (and `available`) to the count. |
| `cl_stock_allowance(targets)` | active till | Tops up or returns this till's allowance towards a target per product (§4); returns the new allowance and `available`. |
| `cl_stock_pull(cursor)` | active till | Branch stock and own allowance changed since the cursor, plus `stock_mode` and `stock_holder_terminal`. |
| `cl_stock_balance()` | active till | Per product: `total`, `available`, sum of allowances, and the sum of events, for Diagnostics |

- **Deactivating a till:** a trigger on `cl_terminals` (`active` → false) returns its allowances to `available` and logs `allowance_return` events. `cl_terminal_set_active` itself is unchanged.

---

## 4. Online sale and the offline allowance (PROPOSED)

### Online sale (shared-stock till)
1. **Validate** exactly as today; nothing is written.
2. Call `cl_stock_sale(sale_uid, lines)` with a **4 s timeout** (Q5).
3. **ok:** commit locally. The server says how much of each line came from this till's allowance, and only that part is a local `moveStock` (stock = allowance). The cached branch `available` is updated. The cart is cleared.
4. **refused:** nothing is written and the cart stays. The till shows "Only 2 Rice 2kg left in the branch." (or "Rice 2kg is sold out at this branch.").
5. **Timeout or offline:**
   - **If the allowance covers every line:** commit locally as an **offline sale**, with `moveStock` from the allowance. The sale's uid is queued for `cl_stock_report`.
   - **If not:** nothing is written and the cart stays. The till shows "Can't reach the server and this till can sell only 1 Rice 2kg while offline. Sell fewer, or try again when connected."
6. **On reconnect, the report sends each offline `sale_uid`:**
   - if the timed-out online call **had** succeeded, the server already has that uid: it changes nothing and answers `{already:true, from_allowance:x}`, and the till adds the difference back to its allowance (a correcting `allowance_in` movement);
   - otherwise the server takes it from the till's allowance.

### Allowance
- **Target per till and product (Q1, recommendation):** `ceil(10% of branch total)`, at least 1 while the branch has stock, at most 10. Main can change the percentage and cap later.
- **Topping up:** after every pull and after every online sale. The server never lets allowances exceed `total`.
- **Returning:**
  - automatically when the target falls (e.g. stock dropping);
  - for a deactivated till, at once (§3);
  - for a till offline longer than **72 h** (Q2), the next time any till of the branch syncs. Its late sales are still accepted, as in `cl_stock_report`.

### What the till shows
| State | Products / Sell show | Add allowed up to |
|---|---|---|
| online | "12 in branch · 3 on this till" | allowance + branch available |
| offline | "3 on this till (offline)" | allowance |

---

## 5. Other movements at a shared branch (PROPOSED)

| Movement | Online | Offline |
|---|---|---|
| Receive GRV, purchase, restock, positive adjustment, merge | `cl_stock_move` adds to `total`/`available` | recorded locally as **pending**, sent by `cl_stock_report`; sellable after sync (Q3) |
| Negative adjustment (damage, cancel write-off) | takes from `available`, then own allowance; refused below zero | allowed only within own allowance |
| DN dispatch (incl. reissue) | as negative adjustment | "Dispatch needs a connection at a shared-stock branch." |
| Import "apply qty" (overwrite) | handled as a stocktake of those products (P8 rule) | needs a connection |
| Stocktake | P8: refused while another till holds allowance ("T2 still holds 4 items offline; connect it first") | needs a connection |
| Legacy transfer receive | as receive | as receive |
| New product with opening stock (main till) | `cl_stock_move` +qty | pending |

---

## 6. Deactivated till
- Its allowance returns at once, via the trigger.
- When it reconnects, its pending reports are accepted (`cl_stock_report` allows inactive tills). Selling stays possible only from whatever allowance is left locally, which is 0 once the server has taken it back.
- **Discrepancy:** if an inactive till's late offline sale can't be covered, a `discrepancy` event records the shortfall for the manager. Stock never goes negative.

---

## 7. Reports and Diagnostics
- **Sales reports:** unchanged. They're local per till; sales sync to main is out of scope.
- **Stock reports** (stock levels, low stock, ageing, `src/report-writer.js:19,37,110`) on a shared till read the **cached branch total**, labelled "branch stock as of 10:42". All others are unchanged.
- **Diagnostics:**
  - the Phase 2 ledger check stays (on shared tills it checks the allowance);
  - **new "Branch stock balance"**: `cl_stock_balance()` shows "all N products balance" or a read-only table where total ≠ available + allowances, or ≠ sum of events;
  - **discrepancies** listed with the till and date.
- **Main** sees the same balance check for its own branch. A view per branch across branches is Phase 4.

---

## 8. UI
- **Stock line** on Products and Sell per product as in §4.
- **Offline badge** "Offline · selling from this till's allowance" on Sell.
- **Refusal messages** as above; they use the existing `alert` pattern, as `completeSale` does today.
- **Settings → Business & Terminals:**
  - branch stock mode;
  - **Start shared stock** (holder only, Admin passcode, report first);
  - the merge report on other tills;
  - "Allowance: 23 items on this till"; pending reports.
- **T2+ note:** shown only while the branch is `local` and this till isn't the holder (P2). Gone once shared.
- Orange theme, light only; existing `.card`/`.box`/`.pill`/`openModal`.

---

## 9. Tests, risks, rollback

### Tests (Stage B)
- **Server (PGlite):**
  - two concurrent `cl_stock_sale` calls for the last unit, on two connections: exactly one succeeds;
  - replay is idempotent;
  - refusal answers;
  - the invariant trigger;
  - report from an inactive till;
  - discrepancy;
  - stocktake blocked while allowance is held elsewhere;
  - switch-over once only;
  - rollback.
- **App (harness, real server SQL in PGlite, as 3a):**
  - online sale decrements once with retry;
  - offline sale within allowance, and blocked beyond it;
  - reconnect report;
  - timeout-succeeded uid, with no double count;
  - switch-over and the merge report;
  - every other movement per §5;
  - deactivated till;
  - single-till and unregistered unchanged (the 74 existing `completeSale` tests run unchanged);
  - the Diagnostics balance check.
- **Browser (Playwright, real server SQL in PGlite), screenshots at 390 and 1280 px:**
  - stock online and offline;
  - the allowance indicator;
  - a refusal;
  - Diagnostics.

### Existing tests expected to change
- None expected to change their assertions: tills that aren't shared keep the synchronous `completeSale`.
- `test/harness.js` gains exports.
- `test/terminal-fake.js` isn't used; the new e2e uses real SQL in PGlite, as 3a's does.

### Risks
1. **Async checkout on shared tills:** a slow network adds up to 4 s per sale before the offline fallback.
2. **Allowance sizing:** too small and offline selling runs out; too large and online tills see less `available`.
3. **Switch-over** must happen on the till that really holds the stock. The report and Admin passcode guard this, but a wrong choice means a recount.
4. **Inactive tills reporting late:** discrepancies need a manager's eye.
5. **Two meanings of `products.stock`** (allowance on shared tills) could confuse code added later. Contained by using the helpers (`sellableNow`, `branchStockLine`) everywhere stock is shown.

### Rollback (server)
- Drop the 8 RPCs, the trigger and the 3 tables; drop `cl_branches.stock_mode` and `stock_shared_ts`.
- This **loses the shared stock figures**. Tills keep their local allowance as local stock, so before a rollback the branch would do a stocktake.

---

## 10. Questions for the owner
- **Q1 – allowance size:** recommend **10% of branch stock, at least 1, at most 10 per product per till**. Main can change the percentage and cap later. Fast sellers: not in 3b; a per-product override by main can come later.
- **Q2 – long offline:** recommend that unused allowance returns **after 72 h** offline (24 h would strand weekend outages). Late sales are still accepted, and any shortfall becomes a discrepancy for the manager, never negative stock.
- **Q3 – offline receiving:** recommend **not sellable until synced**. It's recorded locally at once and adds to branch stock on reconnect.
- **Q4 – stocktake:** recommend P8: posted only when no other till holds allowance, with the server setting the count against the total at posting time.
- **Q5 – online timeout:** recommend **4 s**. The message when the allowance can't cover it: "Can't reach the server and this till can sell only 1 Rice 2kg while offline. Sell fewer, or try again when connected."
- **Q6 – starting shared stock:** an explicit **Start shared stock** by an Admin on the stock holder, with a report (recommended), rather than automatically when a second till joins?
- **Q7 – other tills' own stock at the switch:** an Admin-confirmed **merge report** on each till (recommended), or discard it?
- **Q8 – unlinked products** (no catalogue code match) at a shared branch: stay till-local (recommended) or be blocked from sale until main adds them?
