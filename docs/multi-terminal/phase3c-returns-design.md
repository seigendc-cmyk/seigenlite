# Phase 3c — Sales returns & credit notes (design)

Status: **Stage A — design for approval.** Nothing in this document is built yet.
Branch: `phase3c-returns`, from `phase3b-shared-stock` at `c1fc9e7` (build v9: build guard, cart lock, business-day cut-off).

Labels used below: **VERIFIED** (read in code or the live DB this session), **ASSUMED**, **UNVERIFIED**, **PROPOSED** (new in this design).

---

## 1. What exists today (inspection)

### 1.1 The sale record — VERIFIED
| What | Where | Notes |
|---|---|---|
| `sales` | `src/db.js:63`, columns added in `migrate()` `src/db.js:277-292, 396` | `subtotal` (gross), `discount` (sum of line discounts; on older sales a cart-level discount), `markup` (historical only, always 0 now), `voucher_amount`, `total`, `method` (`Cash`/`EcoCash`/`Bank`/`Credit`/`Split`), `customer_id`, `branch`, `user`, `payment_ref`, `doc_ref`, `receipt_no` (per-till, e.g. `T1-0045`; NULL = shown as `#<id>`), `uid`, `terminal_id`, `branch_uuid`. |
| `sale_items` | `src/db.js:67`, `:293`, `:304` | `price`, `qty`, `cost` (product cost at sale time), `discount` (line discount, $), `uid`. No terminal stamp. |
| `sale_payments` | `src/db.js:76`, `:389-391` | One row per tender: `method`, `amount` (base-currency equivalent), `currency` (`BASE` or a code), `rate` (foreign units per 1 base), `tendered_amount`. Every sale has ≥1 row (backfilled `src/db.js:453`). |
| The maths | `cartTotals()` `src/pos.js:77` | `total = subtotal − discount − voucher` (+ `markup` on old sales). Voucher is capped at what's left after discount. |
| Writing a sale | `completeSale()` `src/pos.js:457` | Shift check → currency resolution → split validation → (shared-stock server check) → INSERT sale, payments, items, `moveStock(kind 'sale')` per line, voucher redeemed, audit, receipt. |
| Receipt number | `src/pos.js:562`, `receiptLabel()` `src/db.js:551` | Registered till: `reserveDocNumber("RCT")` → `T1-0001`. Unregistered or older: `#<sales.id>`. |

### 1.2 Where a sale can be opened — VERIFIED
- **Sale Detail modal** `openSaleDetailModal()` `src/printing.js:635`. It is read-only and opened **only** by tapping a Receipt# in Report Writer → Sales Report (`src/report-writer.js:378-380`). It has *Print Copy* and *Print Invoice*.
- The Sell screen shows only the **last** receipt (`src/pos.js:611`).
- "Receipts history" (`src/receive-in.js:493`) is **stock receiving (DN/GRV)**, not sales.
- **There is no way to look a sale up by receipt number today.**

### 1.3 Approval — VERIFIED, and it differs from the brief
- **Discount approval is not a passcode.** It is a free-text "Approver's name" field (`src/router.js:156`, `src/desktop/sales-desktop.js:159`). The sale stores `discount_status = 'Approved'` if a name was typed, else `'Pending'` (`src/pos.js:552`).
- **The Admin-passcode pattern** the brief describes is the one used by stock adjustments. `commitAdjustment()` (`src/adjust.js:105`) runs `requireSignedIn()`, `hasAdminPasscode()` (`src/catalogue-app.js:189`) and `findAdmin(passcode)` (`src/staff.js:347`), all in one `BEGIN…COMMIT`. It stores `by_user` and `authorised_by`, and writes an audit line naming both.
- **PROPOSED:** returns reuse the **stock-adjustment** pattern, not the discount one.

### 1.4 Vouchers — VERIFIED
- `vouchers(customer_id, amount, branch, earned_ts, status 'Available'|'Redeemed', redeemed_ts, redeemed_sale_id)` (`src/db.js:141`).
- **Issued only** by the frequent-customer rule `maybeIssueFrequentCustomerVoucher()` (`src/pos.js:213`). It **skips a customer who already holds any Available voucher** (`:222`).
- **Redeemed** at checkout:
  - The cart's customer name must match a customer exactly (`findMatchingCustomer()` `src/pos.js:121`).
  - `renderVoucherBox()` (`src/router.js:219`) offers one Available voucher, and one voucher is applied per sale.
  - The voucher is a **sale-level reduction** (`sales.voucher_amount`), **not a `sale_payments` line**.
  - It is marked Redeemed **in full** even when the sale was smaller (`src/pos.js:588`), so **any remainder is lost**.
- **Walk-in customers:** `customer_id` is NULL unless a name was typed at checkout. `findOrCreateCustomer(name, phone)` (`src/pos.js:131`) creates one.
- Vouchers and customers live **on each device**; they are not synced between tills.

### 1.5 Debtors — VERIFIED
- `customerBalance(cid)` (`src/pos.js:146`) = Σ `sale_payments.amount` where `method='Credit'` for that customer's sales − Σ `credit_payments.amount`.
- A payment is an INSERT into `credit_payments` (`src/credit.js:99`).
- The Credit Sales Report (`src/report-writer.js:47`) reads the same two tables.

### 1.6 EOD / shift (per till) — VERIFIED
- `eodTotalsFor(branch, date, float)` (`src/eod.js:238`):
  - It takes the **business day** of the shift date via `businessRange()` (v9).
  - It sums `sale_payments` per method: Cash, EcoCash, Credit. Cash is also split by currency.
  - It subtracts payouts.
  - `expected = float + cash − payouts`.
- `completeEOD()` (`src/eod.js:280`) stores expected, counted and variance.
- Screen: `renderShiftReconciliation()` (`src/eod.js:392`). Slip: `buildEODBytes`/`printEOD` (`src/printing.js`).
- Each till's database holds only its own sales, so EOD is per till.
- Every sale passes `shiftBlockReason()` (`src/eod.js:198`): a shift must be open for today's business date.

### 1.7 Stock — VERIFIED
- `moveStock(o)` (`src/db.js:505`) is the one way `products.stock` changes. It writes a `stock_movements` row in the same SAVEPOINT. Kinds in use include `sale`, `adjustment`, `receive`, `opening`, `allowance` and `shared_opening`.
- Diagnostics: `stockLedgerCheck()` (`src/db.js:541`, shown at `src/settings.js:186`).
- **Phase 3b, shared stock** (`src/shared-stock.js`):
  - On a shared-stock till, `moveStock` is intercepted (`sharedStockIntercept` `:91`).
  - An **increase** is queued in `stock_outbox` and counted in `products.stock_pending_in`. It is **sellable only after it reaches the server** (owner Q3 in 3b) and is reported by `cl_stock_report` on the next stock sync.
  - A **decrease** takes the till's allowance first.
  - `ssLocal:true` bypasses the interception.
- **Server (VERIFIED on the live DB):**
  - `cl_stock_move(…, p_moves)` accepts positive deltas with a free-form `kind`, stored in `detail`, and records event kind `move`.
  - The `cl_stock_events.kind` check is `opening, sale, offline_sale, move, stocktake, allowance_take, allowance_return, discrepancy`.
  - Live: 1 branch uses shared stock and 4 use local stock; 3 branches have more than one active till.
  - **There are no sales, returns or credit-note tables on the server.** Sales are local to each till.

### 1.8 Numbering — VERIFIED
- `DOC_TYPES` / `TILL_DOC_TYPES` (`src/docnum.js:13,19`), `docDisplay()` (`:33`) and `reserveDocNumber()` (`:91`, counters per device in `doc_counters`).
- `docDisplay("CN", 1, "T1")` → `CN-T1-0001`. With no till code → `formatDocNo("CN",1)` → `CN0001`. That is exactly the format the brief asks for.

### 1.9 Printing and sharing — VERIFIED
- Thermal receipts: `buildReceiptBytes()` (`src/printing.js:313`) for USB/Bluetooth ESC/POS (58/80mm from Settings), with the HTML fallback `printReceipt()` (`:417`) through the OS print dialog.
- A4 / PDF: `printReport()` (`:518`) and `printCreditInvoice()` (`:602`), via the print dialog's "Save as PDF".
- WhatsApp text: `receiptText()` + `shareWhatsApp()` (`src/utils.js:109,120`).

### 1.10 Reports — VERIFIED
- **Reports tab** (`src/reports.js`): Sales (with the payment-method and currency breakdown at `:181`), Stock received, Credit, Discount, Margin, Fast moving, Payouts, Branch report.
- **Report Writer** (`src/report-writer.js:8`): the same reports plus Sales Trend, Stock Adjustments, Stock Movements, Activity log.
- **There is no "Item Ledger" report.**
  - `stock_movements` is read only by the Diagnostics balance check.
  - "Stock Movements" in Report Writer is about DN statuses.

### 1.11 Business day — VERIFIED (v9)
- `businessCutoffHours()` / `businessDateOf()` / `businessRange()` are in `src/utils.js:143-165`.
- `setBusinessDayCutoff()` (`src/eod.js:33`) checks the Admin passcode. It refuses while a shift is open, and in the window where the old and new rules disagree.
- **Server, for the add-on:** branch policy already flows from main to tills.
  - `cl_branches.price_mode` is set by `cl_branch_set_price_mode` (main only).
  - It is returned in `cl_catalogue_pull`'s page meta (migration `20261006120000_catalogue_sync.sql:277,341`).
  - It is applied on the till at `src/catalogue-sync.js:134`.
  - Live: `cl_branches` has no business-day column.

### 1.12 Things found along the way — VERIFIED, not in scope unless you say so
1. **EOD leaves out Bank.** `eodTotalsFor` sums Cash, EcoCash and Credit only, so `totalSales` misses Bank-tender sales (`src/eod.js:238-249`). Expected cash is unaffected.
2. **Merging loses line discounts.** `mergeDatabase` copies `sale_items` without the `discount` column (`src/backup.js:369`), so on main, merged sales lose their per-line discounts.
3. **Store vouchers would block loyalty vouchers.** A loyalty voucher isn't issued while any voucher is Available (§1.4). Once store-credit vouchers exist, holding one would stop the loyalty voucher. The design below fixes this as part of 3c.

---

## 2. Design

### 2.1 Data (PROPOSED) — the original sale is never edited

```
credit_notes
  id, uid, terminal_id, branch_uuid          -- Phase 1 triggers (SYNC_UID_TABLES + TERMINAL_STAMP_TABLES)
  branch, cn_no INTEGER, till_code TEXT      -- CN-T1-0001 / CN0001
  sale_id, sale_uid, sale_receipt TEXT       -- the original, as printed (T1-0045 / #45)
  customer_id                                -- the sale's customer, or the one given for store credit
  ts                                         -- UTC; the business day comes from the shared rule
  eod_session_id                             -- the open shift on this till when it was saved
  reason TEXT, reason_note TEXT
  started_by, started_staff_id, approved_by, approved_staff_id
  goods_total REAL                           -- Σ line refund amounts (incl. any voucher part)
  voucher_part REAL                          -- part of goods_total that was paid by voucher
  cost_reversed REAL                         -- Σ cost × qty of RESTOCK lines only
  exchange_sale_id INTEGER                   -- set when part of an exchange
  status TEXT DEFAULT 'posted'
credit_note_items
  id, uid, cn_id, sale_item_id, sale_item_uid
  product_id, product_uid, product_code, name
  qty INTEGER, unit_refund REAL, amount REAL, unit_cost REAL
  condition TEXT  -- 'restock' | 'writeoff'
credit_note_refunds        -- one row per way the money went back
  id, uid, cn_id
  method TEXT     -- 'Cash' | 'EcoCash' | 'Bank' | 'Debtor' | 'Voucher' | 'Exchange'
  amount REAL     -- base-currency equivalent
  currency TEXT DEFAULT 'BASE', rate REAL DEFAULT 1, tendered_amount REAL
  sale_payment_id INTEGER  -- the original tender it reverses (same-way refunds)
  voucher_id INTEGER, exchange_sale_id INTEGER, ref TEXT  -- voucher issued / new sale / EcoCash-Bank ref
vouchers  (+ columns)
  kind TEXT DEFAULT 'loyalty'   -- 'loyalty' | 'store_credit'
  source_cn_id INTEGER, source_sale_id INTEGER
```

- **Merge:** `mergeDatabase` (`src/backup.js`) gains the three tables, matched by `uid`, so main's merged reports net out returns too. This uses the same additive pattern as sales.
- **Removal:** credit notes are never deleted or edited. A mistake is undone with a new sale.

### 2.2 Numbering
- Add `"CN"` to `DOC_TYPES` and `TILL_DOC_TYPES`.
- A registered till gets `CN-T1-0001`. An unregistered device gets `CN0001`.
- The counter is per device (`doc_counters`), like every other document.
- The number is reserved inside the same transaction as the credit note.

### 2.3 Finding the original receipt (required)
- **Input:** `T1-0045` (matched case-insensitively on `receipt_no`), or `#45` / `45` (matched on `sales.id` where `receipt_no IS NULL`).
- **Allowed** only when all of these hold:
  - `sale.branch = currentBranch()`;
  - the sale was made on **this till** (`sale.terminal_id` is NULL — from before registration — or equals this till's `terminal_id`);
  - the sale is within the time limit (Q1), counted on business dates.
- **Messages:**
  - "Receipt T1-0045 wasn't found on this till."
  - "Receipt T2-0010 was made on till T2. Do the return on that till." (when the number's till code isn't ours)
  - "This receipt was made at Harare CBD. Returns are done at the branch that made the sale."
  - "Everything on receipt T1-0045 has already been returned (CN-T1-0003)."
  - "Receipt T1-0045 is from 12 Aug, past the 30-day return limit."

### 2.4 The return limit (one transaction)
- Returnable on a line = `sale_items.qty − Σ credit_note_items.qty` for that `sale_item_id`.
- The check and every insert run in **one `BEGIN…COMMIT`**. sql.js is single-threaded, so two credit notes can't interleave, and a double tap is guarded by a busy flag (the same pattern as `openAdjustStockModal`).
- Any violation rolls back everything, including the CN number. A number can be skipped, never reused, as with every document.

### 2.5 Refund maths
- **Per line**, for sale S and line *i*:

  ```
  N_i = price_i × qty_i − linediscount_i                     -- net of its own discount
  B   = S.subtotal − S.discount + S.markup                   -- what the goods cost after all discounts
  L_i = N_i × B / Σ N                                        -- line's share; spreads an old cart-level
                                                              -- discount (S.discount − Σ linediscount)
                                                              -- and old markup over lines by value
  V   = S.voucher_amount
  ```

- **Returning r of q units:** `amount = round2(L_i × r / q)`. For the **last** remaining units, it is `L_i − already refunded on that line`, so rounding never refunds more than was paid.
  - Of that amount, `× V/B` was paid by voucher, and the rest by the sale's tenders.
  - `unit_refund = amount / r`, kept for display.
- **Example:**
  - 3 × $10, line discount $3, so `N = 27`.
  - 1 × $5, so `N = 5`. `Σ N = 32`.
  - An old cart discount of $2 gives `B = 30`.
  - Line 1: `L = 27 × 30 / 32 = 25.3125`. Returning 1 of 3 = **$8.44**.
  - Returning the remaining 2 later = 25.31 − 8.44 = **$16.87**.

### 2.6 Where the money goes (the four owner-approved methods)

**(a) Same way they paid** is the default.
- The tender part is spread over the sale's own `sale_payments` lines in proportion to their amounts.
- Each tender is capped at what it took minus earlier refunds on it. Any rounding goes to the largest tender.
  - **Cash / EcoCash / Bank:** refunded on that tender. EcoCash and Bank ask for the reference number of the transfer back (Q10).
  - **Foreign currency:** refunded in **that currency at the sale's own rate**: `tendered = round2(base × sale_payments.rate)`. The last refund on a tender returns exactly what's left of its `tendered_amount`.
  - **Credit tender:** goes to **(c) Debtor**. Cash is never paid out for goods that were never paid for.
- **Voucher part:** refunded as a **new store-credit voucher** (Q2), never as cash.

**(b) Store credit voucher.** The whole refund (tender part + voucher part) becomes one voucher, `kind='store_credit'`.
- It needs a customer: the sale's customer, or a name (+ phone) typed now, through `findOrCreateCustomer()`.
- Walk-in sales must give a name.
- The voucher is redeemed exactly like today's at checkout.

**(c) Reduce debtor balance.**
- Allowed only when the sale had a Credit tender and a customer.
- Capped at that sale's Credit portion minus earlier debtor refunds on it.
- `customerBalance()` becomes `owed − paid − Σ credit_note_refunds(method 'Debtor')`, so the Credit screen, invoices and the Credit Sales Report all follow.
- If the customer has already paid off part of it, the part beyond their current balance goes to Q8's method.

**(d) Exchange** — one flow:
1. The returned lines are chosen and approved as usual. The credit (value Xc) is held as a **pending exchange** on the cart, shown as "Exchange credit CN… −$Xc".
2. The cashier adds the new items. Normal checkout runs: zero-stock rule, shared-stock server check, offline allowance.
3. At checkout:
   - **New total ≥ Xc:** the sale gets a `sale_payments` line `method='Exchange'` for Xc, and the customer pays the rest with any method (split tender works).
   - **New total < Xc:** the whole sale is paid by Exchange, and the difference goes back by Q5's rule.
4. The credit note (`exchange_sale_id` set, a refund row `method='Exchange'`) is written **in the same synchronous step as the sale** inside `completeSale()`. Either both are saved or neither.
5. Cancelling the exchange before checkout discards the pending credit. Nothing was saved.
- `'Exchange'` is never offered as a normal payment button. It is not cash for EOD and not Credit for debtors.

**Mixed methods (Q3):** recommended only as "same way", which can mix tenders automatically, or "all as store credit". There is no free-form mixing.

### 2.7 EOD and the shift
- **A return needs an open shift for today on this till**, for every method (Q11). It uses the same `shiftBlockReason()` check as a sale.
- `eodTotalsFor()` adds the credit notes whose `ts` falls in the shift's business day (`businessRange`, the same rule as sales):
  - `cashRefunds` (and per currency, in tendered amounts), `ecocashRefunds`, `bankRefunds`, `debtorReductions`, `vouchersIssued`, `exchangeCredits`.
  - **`expected = float + cash − payouts − cashRefunds`.**
  - "Total Sales" becomes gross, less returns, giving net.
- The EOD screen, thermal slip, PDF and WhatsApp text each gain a "Returns" block listing these lines and the CN count.
- Because refunds are counted by business day, a refund made at 01:30 with cut-off 03:00 lands in the previous day's shift, exactly like a sale at 01:30.

### 2.8 Stock
- **Restock line:** `moveStock({ kind:'return', delta:+qty, docType:'cn', docUid, docNo:'CN-T1-0001' })`. On each kind of till:
  - **Single-till or unregistered:** stock goes up at once, fully offline.
  - **Shared-stock till, catalogue product:** the existing interception queues it and shows "+N pending". It becomes sellable once it reaches the branch. The app then runs `stockSyncNow()` in the background when online, so online returns are sellable within seconds and offline ones after reconnecting. That is the approved rule ("offline receipts become sellable only after sync").
  - **No server change is needed:** `cl_stock_report` / `cl_stock_move` already take positive moves with `kind:'return'`.
  - **Shared-stock till, branch-only product (no `cat_uid`):** local stock, at once.
- **Write-off line:** two movements in one SAVEPOINT, both `ssLocal:true` so they never touch branch stock:
  - `return_damaged` +qty, then `return_writeoff` −qty.
  - Net change 0; sellable stock never goes up; the ledger keeps both units visible; Diagnostics stays balanced.
  - Stock can't go below zero, because the decrease follows its own increase.
- **Product deleted or deactivated:** restock is not offered; write-off only (Q14).

### 2.9 Where a return can be done (Q4)
- **Recommended: on the till that made the sale.** Sales live only on the till that rang them up (verified: there are no sales on the server), so another till cannot see the receipt or what was already returned.
- An online cross-till lookup needs sales on the server, which is the out-of-scope sales-sync phase. Recommended for after that phase.
- **Other branches:** not yet, until Phase 6.
- Main's merged copies of a branch's sales are view-only (§2.3 branch rule).

### 2.10 Approval
- The cashier, signed in (`requireSignedIn()`), starts the return.
- An **Admin passcode** is typed on the review step and checked with `findAdmin()` inside the transaction. Wrong or missing: nothing is saved.
- No Admin passcode set up gives the existing message `NO_ADMIN_PASSCODE_MSG`.
- Audit line, action `Credit note`: `CN-T1-0001 for receipt T1-0045 · $25.31 · Cash · 1 restock, 1 write-off · reason: Faulty · started by Tendai, authorised by Owner`.

### 2.11 Printing and sharing
- **Credit note slip**, 58/80mm ESC/POS plus the HTML/OS-dialog fallback, built like `buildReceiptBytes`:
  - shop, branch, date/time;
  - **CREDIT NOTE CN-T1-0001**, "Original receipt T1-0045 (date)";
  - lines `qty x name  −$amount` with "(restocked)" / "(written off)";
  - total refunded, how it was refunded (per tender and currency, voucher amount, debtor reduction, exchange);
  - reason; "Started by … · Authorised by …".
- **PDF:** the same slip through the print dialog (Save as PDF), as with EOD.
- **WhatsApp:** `receiptText()` text of the same content.
- **Reprint** from the Returns report and from the original sale's detail.

### 2.12 Reports
- **Sales Report** (Reports tab and Report Writer):
  - Credit notes in the range are listed as rows marked **Return** with negative totals.
  - The footer reads **Gross $X · Returns −$Y · Net $Z**.
  - The payment-method and currency breakdown gains a Refunds column per method and currency, plus Net.
  - Returns are dated by the **credit note's** business day, not the original sale's.
- **Margin / profit:**
  - Revenue less all returned amounts.
  - Cost less **restocked lines only** (`cost_reversed`). A write-off keeps its cost, so it shows as a loss.
- **Fast Moving:** quantity net of returns.
- **Sales Trend:** net (Q13), returns bucketed by their own business date.
- **Credit Sales Report:** a Returns column (debtor reductions); the balance follows `customerBalance`.
- **EOD:** §2.7.
- **New Returns report** (Report Writer, every till):
  - Columns: CN number, date/time, till, original receipt, customer, items, conditions, amount, method(s), reason, started by, authorised by.
  - Filters: date range, reason, method, condition.
  - Footer: totals per method and per condition.
- **Item Ledger:** none exists today. Q12 proposes a small "Item Ledger" in Report Writer (one product, a date range, every `stock_movements` row with its document number), which would show returns and write-offs.

### 2.13 Screens
- **Ways in:**
  1. **"Return / Credit note"** on the Sale Detail modal, shown when §2.3 allows.
  2. A new **"Returns"** entry under Reports, with a "Find receipt" box (and on the desktop Sales screen), since today a sale can only be reached through Report Writer.
- **Steps** (one modal, phone and 1280px layouts, orange theme, light only):
  1. **Find receipt.** Shows the receipt summary, or one of the §2.3 messages.
  2. **Choose items.** Per line: sold / already returned / returnable, a qty stepper (0…returnable), the condition (Good → back to stock / Damaged or faulty → write off), and the live refund per line.
  3. **Refund.** The method (only those allowed for this sale are enabled, each disabled one with its reason), the customer for store credit, the reference for EcoCash/Bank, and the reason (Q7).
  4. **Review and approve.** Totals per tender and currency, stock effect, Admin passcode, then **Save credit note**.
  5. **Done.** Print / PDF / WhatsApp; for Exchange it returns to the cart with the credit applied.
- **Messages:** §2.3, plus:
  - "Choose at least one item."
  - "Store credit needs the customer's name."
  - "This sale wasn't on credit, so the debtor balance can't be reduced."
  - "Start a shift first (Reports → End of Day)."
  - "Incorrect Admin passcode. Nothing was saved."

### 2.14 Add-on: business day set per branch by main
- **Server** (to show before applying), mirroring `price_mode`:
  - `cl_branches.business_day_cutoff smallint null check (0..6)`. NULL means main hasn't set it.
  - `cl_branch_set_business_day(…, p_branch_id, p_hours)`: main only, `null` clears it.
  - `cl_catalogue_pull`'s meta gains `business_day_cutoff`. This is a `create or replace` with the same signature, one extra key.
  - Rollback script included.
- **Main:** Settings → Business & Terminals lists each branch, including its own, with a "Business day ends at" select. The Admin passcode is required, and each change goes into the audit log. Changes queue in `cat_outbox` (kind `bizday`) and push like price policies.
- **Till** (on each catalogue pull):
  - If the branch value is set and differs from this till's, it applies it through the existing rules: no shift open on this till, and the old and new rules agree on today's date. Logged as `Business day end changed (set by main)`.
  - If either rule refuses, it stays **pending** and is retried on each pull and after End of Day. Settings shows "Main set 03:00 — applies after this shift's End of Day."
  - Once main has set a value, the till's selector is **read-only**: "Set by main."
  - Unregistered tills, and branches where main never set a value, keep the local setting exactly as in v9.

### 2.15 Tests (Stage B)
The full list from the brief, plus these:
- rounding on the last units returned;
- an old cart discount and markup apportioned;
- a voucher-part refund;
- Bank and EcoCash refund references;
- the time limit at the business-day edge;
- `#45` on a till registered after the sale;
- a receipt from another till refused;
- merge carrying credit notes to main;
- loyalty vouchers still issued while store credit is held;
- the business-day add-on: a pulled value applied, held while a shift is open, held in the disagree window, the read-only selector, and unregistered tills unchanged.
- Server: PGlite tests for the new RPC and pull field, plus a live check after apply.

### 2.16 Risks and rollback
| Risk | Mitigation |
|---|---|
| Refund maths disagrees with what the receipt showed | One function owns the maths. Tests pin worked examples (§2.5). Rounding is done per line with last-unit correction. |
| Cash refunds make EOD look short | The refunds block on the EOD screen and slip. Expected cash includes it. |
| Exchange half-saved | The credit note and the sale are written in the same synchronous step of `completeSale`, or not at all. |
| Shared-stock till: returned stock not yet sellable offline | This is by the approved 3b rule, and shown as "+N pending". |
| Store credit only works on the till that issued it (vouchers aren't synced) | Said on the slip ("Use at this till"). Lifted when customers and vouchers sync (later phase). |
| Schema | Additive only: new tables, new columns with defaults, old rows unchanged. |

**Rollback:**
- **App:** redeploy v9. The new tables are simply ignored by v9, and sales are untouched.
- **Server:** a rollback script drops the column and RPC and restores `cl_catalogue_pull`.

**Build:** v10 (`sw-pwa.js`).

---

## 3. Questions for the owner (each with a recommendation)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Time limit for returns | **30 days**, counted in business days. Settings, Admin passcode to change. |
| Q2 | Part paid by voucher | **Back as a store-credit voucher only**, never cash. |
| Q3 | One credit note split across methods? | **Only "same way"** (which mixes tenders automatically) **or all as store credit.** No free-form mixing. |
| Q4 | Return at another till, or at another branch | **Selling till only** until sales sync to the server. **Other branches: Phase 6.** |
| Q5 | Exchange where the new items cost less | **Difference back the same way they originally paid** (same rules as a return). Alternative: always a voucher. |
| Q6 | Must main see write-offs (supplier claims)? | **Yes.** Credit notes travel to main in the existing branch merge and show in the Returns report (condition filter). Server sync is a later phase. |
| Q7 | Reasons | **Fixed list + note:** Wrong item, Faulty / damaged, Changed mind, Not as described, Other (note required). |
| Q8 | Credit-sale return when the customer has already paid part of it | **Reduce the balance down to zero; anything beyond that as store credit**, not cash. |
| Q9 | Store-credit voucher used on a smaller sale | **Keep the remainder as a new voucher** (today the remainder is lost). No expiry. Loyalty vouchers unchanged. |
| Q10 | EcoCash / Bank refund reference | **Required**, like at checkout. |
| Q11 | Must a shift be open to do a return? | **Yes, for every method.** The refund lands in that shift's EOD. |
| Q12 | There is no Item Ledger today | **Add a small "Item Ledger" view in 3c** (one product, date range, every stock movement with its document). Otherwise returns appear only in the Returns report. |
| Q13 | Sales Trend: gross or net? | **Net**, with returns on their own business date. |
| Q14 | Product since deleted or deactivated | **Write-off only** for that line. |
| Q15 | Side findings §1.12: EOD omits Bank, merge loses line discounts | **Fix both in 3c** (small, and returns touch the same code). Or leave them for a later phase. |

---

## 4. Owner decisions (2026-10-07, "go Phase 3C-B") — authoritative

1. **Time limit:** 30 days by business date (utils.js helpers), changeable in Settings with the Admin passcode. Older sales are refused with a clear message; no per-return override.
2. **Voucher-paid part:** back as a store-credit voucher only, never cash.
3. **Split methods:** either the automatic "same way they paid" split, or all store credit. "Reduce debtor balance" only for credit sales. Exchange is its own flow. No free-form manual splits.
4. **Where:** only on the till that made the sale. Sales that arrived through `mergeDatabase` or from another till are never returnable. Refusal text: "This receipt was made on another till. Return it on that till." Other branches: Phase 6.
   - **Rule used (Stage B):** a sale is returnable here only if
     - `sale.branch = currentBranch()`;
     - `sale.merged_ts` is empty (a new column `mergeDatabase` stamps on every sale it inserts from 3c on);
     - `sale.terminal_id` is NULL or equals this till's `terminal_id`. A registered sale from another terminal is refused.
   - **Known limit, stated, not guessed around:** a sale merged **before 3c** from a device with the **same branch name** and **no terminal stamp** looks exactly like this device's own pre-registration sale. No existing column tells them apart, and merges were not audit-logged. Merges from other branches (the normal main ← remote case) are refused reliably by the branch rule.
5. **Cheaper exchange:** the difference goes back the same way they paid (voucher-paid share as voucher). A dearer exchange is paid through normal checkout.
6. **Write-offs at main:** yes, via the existing merge.
7. **Reasons:** Wrong item, Faulty / damaged, Changed mind, Other. The note is optional, but required for Other.
8. **Partly-paid credit sale:** reduce the balance to zero, the rest as store credit.
9. **Voucher remainder:** the remainder becomes a new voucher, no expiry, for **store-credit vouchers only** (`vouchers.kind`, default `'loyalty'`). Loyalty vouchers behave exactly as today. The loyalty "already holds a voucher" check looks at loyalty vouchers only, so holding store credit doesn't block a loyalty voucher.
10. **EcoCash/Bank refund reference:** required.
11. **Open shift:** required for every method.
12. **Item Ledger:** small and read-only: one product, date range, `stock_movements` rows, running balance. No other report changes beyond those listed here. This drops Fast Moving net-of-returns and a Credit-report Returns column from §2.12; the credit balance still follows `customerBalance`.
13. **Sales Trend:** net, labelled "net of returns".
14. **Deleted or deactivated product:** the money is refunded, and that line is write-off only.
15. **The two existing bugs:** fix both, each in its own commit with its own test (EOD Bank; merge line discounts).

Also confirmed:
- Store credit for a walk-in asks for a name and phone and creates the customer in the same save.
- The audit line names the cashier, the approving Admin, the reason, the CN number and the original receipt.
- Shared stock: restock follows the 3b path (offline sellable only after sync); write-offs make no server stock change.
- Diagnostics balances after both kinds of return.
