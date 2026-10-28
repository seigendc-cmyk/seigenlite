# v37: Stock control + notification bell (+ A14)

Build notes for Part 2 of `docs/prompts/next-builds-v36-v38.md`. Decisions: 8, 12, 48 (prompt 45), 52 (cycle stocktake), 53 (stock requests), 54 (recall), 55 (bell), and A14. The owner's decisions doc wins over this file.

## What exists (inspected 27 Oct)
- **Stocktake** (`src/stocktake.js`):
  - one open full stocktake per branch, own branch only (§R7);
  - blind while counting;
  - "Apply counts" sets stock to the counted figure.
  - Unchanged in v37.
- **Shelf:** `products.shelf` (one per product row on a till).
  - Edited in Products; imported (`import.js`) and exported (`backup.js`).
  - Today it travels in the business catalogue (`catalogue-sync.js`), so the main branch's shelf overwrites every branch's.
- **Adjustments** (`adjust.js`):
  - an ADJ with a reason, the Admin passcode or the holder's PIN (`findApprover(code, "approve_writeoffs")`);
  - `moveStock` writes the ledger row;
  - shared-stock tills go through the server first.
- **Customer notepad** (`requests.js`, table `stock_requests`): kept separate; label only, unchanged.
- **Requisition (B3):** designed (`docs/branches/multi-branch-visibility-design.md` §15, §R9), never built. v37 builds it as "Stock requests" (decision 53).
- **Dispatch/GRV through seiGEN** (`dispatch-out.js`, `dispatch-srv.js`, migration `20261017120000`):
  - the sending till makes the DN, sends it (`cl_device_dispatch_send`, idempotent by uid) and holds the stock;
  - any till of the receiving branch posts the GRV;
  - a delivery cost becomes `cl_interbranch_charges`, owed by the **receiving** branch.
- **Rights:**
  - `cl_shop_rights_all()`, `cl_shop_default_rights()` and `cl_seat_need(right)` (on seats, and since v36 on tills with a token);
  - the app's `ROLE_*` lists and `can()` / `canStrict()` / `findApprover()` in `roles.js`.

## Rights (decision table in the prompt)
| key | label | Owner | Admin | Manager | Stores | Cashier | Guest |
|---|---|---|---|---|---|---|---|
| `request_stock` | Request stock | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `review_requisitions` (exists, label "Review stock requests") | Review stock requests | ✓ | ✓ | ✓ | – | – | – |
| `recall_stock` | Recall stock | ✓ | ✓ | ✓ | – | – | – |
| `count_stock` | Count stock (cycle) | ✓ | ✓ | ✓ | ✓ | – | – |
| `approve_counts` | Approve count differences | ✓ | ✓ | ✓ | – | – | – |

- Built-in roles of existing businesses get the new rights by default. Custom roles don't.
- seiGEN checks every new call with `cl_seat_need(<right>)` (decision 48).
- In single operator mode, approvals take the Admin passcode, as all approvals do today.

## 1. Cycle stocktake: "Count now" (decision 52)
**Shelf per branch:**
- `cl_branch_shelves(business_id, branch_id, product_uid, shelf, change_seq)`;
- `cl_device_shelves_push` (needs `m.products`);
- `cl_device_shelves_pull(cursor)`: this branch's rows.
- On the till, `products.shelf` stays the field that is shown and edited.
- The catalogue pull no longer overwrites a shelf that this branch has set.
- Import and export keep the Shelf column; an import queues the branch shelves.

**The daily list** (`cycle.js`, pure functions with tests):
- **class:** value sold at cost over 90 days, from `sale_items` (qty × cost now) minus returns. Top 80% = A, the next 15% = B, the rest = C. Nothing sold = C.
- **due:** A every 7 days, B every 30, C every 90 (Settings → Count now; the shop can change these).
- **red flags, counted first:**
  - negative stock;
  - a difference at the last cycle count;
  - 3 or more returned units (credit notes) in 30 days;
  - a sale while the stock showed 0 or less (the ledger: a sale movement whose running balance went below 0);
  - an adjustment or write-off of 10 units or more, or over 10% of stock, in 30 days;
  - received (GRV / supplier GRV) in the last 60 days but not sold since.
- **list size:** about 20 a day (setting). Order: red flags, then the most overdue, by class (A first).
- A manager can add items or a whole shelf to today's list.
- Grouped by shelf; items with no shelf are listed by name.
- The reason shows on each item.

**Counting:**
- **Blind:** the counter sees name, code and shelf, plus a quantity box. Never the expected figure or the difference.
- Each count stores `counted_qty`, `system_qty` at that moment (hidden), `counted_ts` and `counted_by`.

**Method for sales during counting:**
- The difference is fixed when the count is taken: `diff = counted − system_qty_at_count`.
- On approval, stock moves by `diff` (`moveStock({ delta: diff })`, never `setTo`).
- So sales and receipts between the count and the approval stay in the stock, and trading never stops.

**Approval:**
- A difference of 0 is closed at once, with no stock change.
- Any other difference waits as "Waiting for approval".
- The approver needs `approve_counts`: the Admin passcode, or their own PIN when signed in with the right (`findApprover`).
- The approver can:
  - **Approve:** an ADJ "Cycle count" (reason "Miscount correction", note "Cycle count, counted by X, approved by Y"), at the current cost (last cost today; WAC after F-0);
  - **Recount:** the item goes back on the list, flagged "Recount: not by X". The next count must be by someone else when people sign in. In single operator mode, the name typed or "single operator" is recorded.
  - **Reject:** no stock change; it stays on the list.
- **No approval, no stock change.**

**Sync:**
- Every count and decision is queued (`stock_ctl_outbox`), sent to `cl_cycle_counts` by `cl_device_cycle_counts_push`, idempotent by uid.
- Approvals on another device: `cl_device_cycle_count_decide` (needs `approve_counts`).
- The counting till pulls decisions (`cl_device_stock_ctl_pull`) and applies an approved one once, keyed by `doc_uid` `cc:<uid>`.
- Counting works offline.

**Shrinkage report** (Stocktake tab + Report Writer):
- From approved cycle-count adjustments (and full-stocktake adjustments on this device).
- Units and value at cost, by item, shelf, branch, period and staff on duty.
- **Staff on duty:** who sold on this till that business day (`sales.user`), plus the counter.
- Trend by week; top 10 items lost; counts done vs due.
- Values only with View costs; otherwise units only.

## 2. Stock requests (decision 53, B3 as designed + §R9)
**Server:**
- `cl_stock_requests(id, business_id, req_no text SRQ-…, from_branch_id = requester, to_branch_id = main, requester_terminal_id, requested_by, reason, needed_by, status, decided_by, decided_at, decision_note, dispatch_id, created_at, change_seq)`;
- `cl_stock_request_lines(request_id, line_no, cat_uid, code, name, qty, approved_qty)`;
- `cl_stock_request_log`.

**RPCs:**
- `cl_device_stock_request_create` (`request_stock`; idempotent by id);
- `cl_device_stock_request_decide(id, action approve | part | reject, lines, note)` (`review_requisitions`; any device of the business);
- the dispatch send accepts an optional `request_id` and sets status `dispatched`;
- the GRV sets `received`;
- the pull is part of `cl_device_stock_ctl_pull`: every request of the business (§R9; no customer data).

**Statuses:** pending → approved | part_approved | rejected → dispatched → received.

**App:**
- **Request stock:** lines picked from this branch's products, each showing main's stock (`cl_device_branch_stock`); a reason; a needed-by date. Queued offline.
- **Stock requests list:** status, branch and date filters; any-order search (`textMatches`); double-click or tap opens the history.
- **Review:** approve all, part (per-line quantities) or reject with a reason.
- **Approved at main:** "Create dispatch" opens Dispatch pre-filled (destination = the requester; lines = the approved quantities; carries `request_id`). This is the "draft DN". The normal DN → GRV flow follows; transport rules unchanged.
- **Report:** "Stock requests" in Report Writer: open, approved, part-approved, rejected, average hours to decide, by branch.

## 3. Recall (decision 54)
**Server:**
- `cl_stock_recalls(id, business_id, rcl_no, branch_id (the branch recalled from), to_branch_id = main, reason, due_date, status, created_by, created_at, change_seq)`;
- `cl_stock_recall_lines(recall_id, line_no, cat_uid, code, name, qty, all_on_hand, sent_qty, short_qty, short_reason)`.

**RPCs:**
- `cl_device_recall_create` (`recall_stock`);
- the dispatch send accepts `recall_id` (+ short lines): status `partly_sent` or `sent`;
- the GRV at main sets `received`.
- Overdue = past `due_date` and not sent; flagged in the pull, and shown to the person who made it.

**App:**
- **The branch:** a list plus "Send back", which opens Dispatch pre-filled to main from the recall. A line can be marked short with a reason.
- **Transport:** stays as today (the receiver owes it). The receiver here is main, so the DN shows "Transport paid by receiver: main".
- **A recall alone never changes stock.** Only the DN does, when it's sent.
- **Report:** open, overdue, shortages.

## 4. Notification bell (decisions 8, 12, 55)
**`bell.js`: a local `notices` table:**
- columns: key (unique), category, title, route, ts, read_by (JSON list of person keys), chimed;
- **person key:** the signed-in staff id, otherwise "device" (single operator). Read state is per person on the device.

**Categories and who sees them (checked again at display):**
| category | source | right |
|---|---|---|
| market | `cl_market_feed` (Console broadcasts; Console page "Market feed") | everyone, Guest included |
| itred | new order in the existing iTred orders pull | `m.sell` (Orders Fulfillment) |
| requests | stock-control pull: new (reviewers), status changes (the requesting branch) | `review_requisitions` / `request_stock` |
| recalls | new recall to this branch; overdue (the maker) | `m.dispatch` at the branch / `recall_stock` |
| counts | cycle counts waiting for approval | `approve_counts` |
| movements | incoming DN to this branch; our DN received | `m.receive` / `m.dispatch` |

- **Titles only:** e.g. "New stock request SRQ-T1-0003 from Norton". Never amounts, customers or prices.
- **The 60 s check:**
  - one loop, no overlap (a busy flag);
  - runs while visible and online;
  - paused when hidden; runs at once on return;
  - each pull uses its own cursor (B4-style), so nothing is lost offline.
- **Chime:**
  - WebAudio, a short two-tone sound, only for a notice newly added in this check;
  - never again for the same key;
  - Settings → Notifications: sound on/off per person, categories on/off per person;
  - "Browsers allow sound only after you've tapped the app once since opening it."
- **Phone/PC notifications (Level 1):**
  - `Notification` while the app runs;
  - asked once, after the first notice arrives (a card in the bell, "Show notifications on this phone?");
  - never again after a "no";
  - Settings explains how to turn it on.
- **Push when closed:** Level 2, later.

## A14 (owner 27 Oct)
- **Shop apps:** `sql-wasm.js`, `sql-wasm.wasm` and `xlsx.full.min.js` are copied into each dist (`vendor/…`) and loaded from the app's own address. The service workers precache them there.
- **iTred:** the Fraunces and Inter woff2 files (latin) are served from `fonts/` with a local `@font-face`. No googleapis or gstatic at runtime.
- **Measure:** first load on a throttled 2G profile, before and after (Playwright + CDP network throttling); results in the report.

## As built (27-28 Oct)
Where the build differs from the notes above, this section wins.
- **One queue, one push, one pull.**
  - Every stock-control event (shelf, count, count decision, count applied, request create / decide / link, recall create / link / cancel) goes through one local outbox (`sc_outbox`) and one call, `cl_device_stock_ctl_push`.
  - It answers per uid, idempotent; seiGEN checks each event's right with `cl_seat_need` (decision 48).
  - One pull, `cl_device_stock_ctl_pull(cursor, itred_after)`, also re-sends the last 2 minutes, so a late commit is never skipped.
  - No separate `cl_device_shelves_*` / `cl_device_cycle_count_decide` calls.
- **DN link without touching dispatch logic.**
  - `cl_device_dispatch_send` and `cl_device_grv_post` are unchanged.
  - The DN made from a request or recall queues a `request_link` / `recall_link` event in the same local transaction as the DN (`dnCommitDispatch` `o.link`). seiGEN answers `NO_DISPATCH` (tried again) until the DN is there.
  - A trigger on `cl_dispatches.status` moves the request or recall to `received` on the GRV, and back to approved / open when the DN is cancelled.
- **Blind on the server too.** A count's system figure and difference reach only callers with `approve_counts`, or a till in single operator mode (`cl_stock_ctl_sees_diff`).
- **A/B/C boundary.** Ranked by value; the share of value ranked *above* an item decides (< 80% A, < 95% B). An item across a line takes the higher class, so a product that is all the value is A.
- **Seats count too** (decision 16: a seat holds main-branch stock); the counting device moves its own stock.
- **Shared-stock branches.** Count now shows a notice and uses the full stocktake (a shared-stock till holds an allowance, not the shelf).
- **Bell sources.**
  - The pull carries a title-only list of this branch's DNs (14 days) and new iTred order ids, so the 60 s check is one call. The dispatch and iTred pulls are not run every minute (each saves the whole database).
  - The device saves only when something changed.
- **Notifications settings** live in the bell (per person; no Settings right needed) and on the Settings page.
- **Recall cancel:** the maker (`recall_stock`) can cancel an open recall.
- **A14:**
  - `assets/vendor/` holds byte-for-byte copies; build.js copies them to `dist-pwa/vendor/` and `dist-tauri/vendor/` and rewrites the cdnjs addresses there (the build fails if any is left).
  - `dist/` (one file, opened from disk) keeps cdnjs, because a browser can't fetch a wasm next to a file it opened from disk.
  - iTred serves Fraunces and Inter (latin + latin-ext) from `fonts/`.
