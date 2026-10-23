# B4: sales sync (v35), design

Owner decisions 3, 28, 30, 31 and 35–38 (`docs/decisions/post-build-29-decisions.md`, 23 Oct 2026), and the B4 prompt of 23 Oct 2026.
Labels: **VERIFIED**: seen in the code (file:line) or measured. **UNVERIFIED**: likely, not checked. **ASSUMED**: taken as true, with the reason.

## 1. What the till holds today (VERIFIED)
Every row that syncs already has a stable 32-hex `uid`. Rows written on a registered till also carry `terminal_id` and `branch_uuid`. Both are stamped by triggers, so no write path can forget them (`src/db.js` `migrateSyncIdentity`, `SYNC_UID_TABLES`, `TERMINAL_STAMP_TABLES`). A row merged in from another device keeps its own uid and is never stamped with this device's terminal.

| Event | Local rows | Fields that exist | Missing (see §2) |
|---|---|---|---|
| Sale | `sales`, `sale_items`, `sale_payments` (`src/pos.js:749-778`) | uid, `receipt_no` (T1-0045), ts, branch, terminal_id, `user` (the name), customer_id → `customers.uid`, `price_level` (retail/wholesale), subtotal, discount, total, voucher_amount, payment_ref, doc_ref; v34: credit_check (online/offline), credit_before/after, credit_override, credit_override_mode. Lines: product_id → product uid / cat_uid / sku, name, price, qty, line discount, `cost`, price_level, retail_price. Payments: method (Cash, EcoCash, Bank, Credit, Exchange; Voucher is the sale's voucher_amount), amount in base, **currency, rate, tendered_amount** per line | operator's staff id; the credit limit at the moment of an override |
| Return | `credit_notes`, `credit_note_items`, `credit_note_refunds` (`src/returns.js:269-290`) | uid, cn_no / till_code (CN-T1-0001), sale_uid, customer, ts, reason, reason_note, started_by, **approved_by**, goods_total, cost_reversed; lines with qty, unit_refund, unit_cost, condition; refunds by method (Cash, EcoCash, Bank, Debtor, Voucher, Exchange) with currency and rate | none |
| Void | none | there is no separate void: a mistake is undone with a return (credit note, right "Void/return") | none |
| Credit payment | `credit_payments` (`src/credit.js:63`) | uid, customer_id, ts, amount, note, branch, user | **method, reference**, the receipts it pays (payments are on account, not against a receipt) |
| Payout | `payouts` (`src/credit.js:227`) | uid, ts, amount, reason, branch, user | **account tag** (no shop chart of accounts exists: `cl_chart_of_accounts` on seiGEN is seiGEN's own billing chart, keyed by vendor), **approver** (a payout needs no approval today), currency (always the base currency). The money always comes from the till's cash drawer: EOD subtracts payouts from expected cash (`src/eod.js:388`) |
| End of Day | `eod_sessions` (`src/eod.js:331, 441`) | uid, date (business day), opening_float, started/closed ts and by, expected_cash, counted_cash, variance, notes; per-currency cash **expected** (`eodTotalsFor` → `cashByCurrency`, `src/eod.js:390-407`) | the **counted** cash per currency (one counted total is typed, in the base currency) |
| Credit override | on the sale (v34) | who (`credit_override`), mode ("single operator" / "right + Admin passcode"), credit_before/after, credit_check | the limit at that moment (the customer's limit can change later) |
| Price change | `price_changes` (v34 trigger, `src/db.js` `migratePriceChanges`) | ts, product, sku, branch, old and new price, cost; below cost = new price < cost | **uid, who, how** (the trigger can't see who is signed in) |
| Voucher | `vouchers` (`src/pos.js:358, 790`; `src/returns.js:283`) | uid, kind (loyalty / store_credit), customer, amount, earned_ts, status, redeemed_ts, redeemed_sale_id, source_cn_id | none |

**Cost at the time of sale (VERIFIED, a gap against the prompt):** `sale_items.cost` is the product's `cost` at that moment (`src/pos.js:776`). That cost is the **last** landed cost of a supplier GRV or a seiGEN dispatch (`src/supplier-grv.js:111`, `src/dispatch-srv.js:226`), or what was typed on the product. It is **not a weighted average**. Changing how cost is worked out changes COGS, which is a logic change, so B4 sends the cost exactly as the till recorded it and names it "cost at sale". Weighted average cost is a decision for F-1 (decision 28 already uses weighted average for the opening stock).

**Base currency (VERIFIED):** the base currency is only a symbol (Settings → Currency symbol, e.g. `$`). It has no ISO code (`src/currencies.js:1-13`). Other tender currencies have a code and a rate (foreign units per 1 base unit). B4 sends the symbol, and for each payment line its code, rate and tendered amount. Finance (USD and ZiG kept apart) will need a base currency code: **proposal**, a "Base currency code" setting in F-1.

## 2. Gaps and the smallest additions
| Gap | Addition in v35 | Logic change? |
|---|---|---|
| Operator's staff id on a sale, payment or payout | new column `staff_id` (the signed-in person's seiGEN id, empty in single operator mode), written with the row | no: a new column, nothing reads it but B4 |
| Limit at the moment of an override | new column `sales.credit_limit_at` | no |
| Which balance a credit sale was checked against | new column `sales.credit_scope`: `till` (as v34), `business` (seiGEN answered), `last_sync` (offline, decision 37) | wording only (decision 37) |
| Price change: uid, who, how | new columns `price_changes.uid` and `how` (a second trigger: `catalogue sync` when the change came from the catalogue pull, otherwise `on this till`; "via Seith" later). **Who** is taken from the app activity log line of the same change (same product, within 5 seconds) when there is one, otherwise sent empty: the trigger can't see who is signed in, and changing every price-editing screen to pass it on would touch 6 screens | no |
| Credit payment method and reference | **not added.** Sent as `method: null`, with the payment's note as the reference. A method picker on Record Payment would change a screen, and the EOD cash count (credit payments aren't in EOD today, `src/eod.js:355-408`). **Owner decision needed later** (F-1) | none made |
| Payout account tag, approver | **not added.** Sent as `account_tag: null`, `approved_by: null`, `source: "till cash"`. The chart of accounts comes with F-1 (decision 26) | none made |
| Counted cash per currency at EOD | **not added**: B4 sends the expected cash per currency and the one counted total | none made |

## 3. What syncs (one event per uid; a retry is stored once)
| Kind | Event uid | Priority | Payload (built from the till's rows when the event is queued) |
|---|---|---|---|
| `sale` | the sale's uid | 1 | header, lines (product uid, cat uid, code, name, qty, unit price, line discount, line total, cost at sale, price level), payments (method, amount, currency, rate, tendered, reference), credit fields, operator, staff id, customer uid, business day |
| `return` | the credit note's uid | 1 | original sale uid, lines, refunds, reason, started and approved by, the debtor part |
| `credit_payment` | the payment's uid | 1 | customer uid, amount, method (null), reference, operator |
| `payout` | the payout's uid | 1 | amount, currency, account tag (null), reason, operator, approver (null), source "till cash" |
| `eod` | the EOD session's uid | 1 | business day, opening float, expected, counted, variance, expected per currency, the day's totals by method, who opened and closed |
| `credit_override` | `ovr-` + the sale's uid | 1 | sale, customer, amount over the limit, the limit then, who, the right held, "single operator" flag (decision 30), checked online/offline |
| `credit_bf` | `bf-` + terminal + customer | 1 | this till's balance for a customer from before the 90-day window (see §5) |
| `price_change` | the row's uid | 2 | product, old and new price, cost, who, how, below cost |
| `voucher_issue` / `voucher_use` | the voucher's uid / `use-` + uid | 3 | kind, customer, amount, the sale or credit note |

History (decision 35) goes at **priority 2**, whatever its kind: live priority-1 events always go first.
**Only this till's own rows are sent:** rows it wrote itself (stamped with its terminal) and, from before it was registered, rows of its own branch that weren't merged in from another device. seiGEN also refuses an event whose till isn't in the caller's business, and **stores every event under the calling till's own branch and terminal, never the ones a payload claims**.

## 4. The till side (`src/b4-sync.js`)
- **Outbox:** `b4_outbox` (uid, kind, priority, payload, history flag, attempts, next try, sent time, error). It is local only, and `mergeDatabase` never reads it.
- **The scan:** queuing reads each table past a cursor (its highest rowid seen). EOD and voucher redemptions are updates, so they're found by "closed / redeemed and not queued yet". Every write path is covered without touching it, including imports and merges. Each scan does at most 200 rows, then yields, so the Sell screen never waits.
- **Sending:**
  - one RPC, `cl_device_b4_push`, in batches (up to 25 events or about 48 KB);
  - priority order, oldest first;
  - after a timeout the batch size halves (down to 1), and it grows again after a success;
  - exponential back-off with jitter (5 s doubling, at most 15 min, 50–100 % random);
  - a send on the browser's `online` event, 2 s after any money event, every 20 s while something waits, and every 60 s otherwise.
- **Resumable and idempotent:** an event is marked sent only after seiGEN answers for its uid (`stored` or `duplicate`). A restart in the middle of a send just sends it again, and seiGEN stores it once.
- **Credit events of a customer seiGEN doesn't have yet** (still queued, an old customer not sent yet, or a phone clash waiting for an Admin) wait until that customer is settled. A merge or adoption can change a customer's uid (`src/customers.js:330-337, 431-447`), and the business balance must be counted under the final uid. A customer kept on this till only ("Keep apart") is sent under its own uid.
- **Sync indicator:** "N waiting to send · last sent hh:mm" on the Sell screen header line and in Settings → Cloud sync. Tap for details: by kind, what's waiting for a customer, and the last error. It never covers the screen.
- **Office seat (VERIFIED, it never sells):** a seat has no sales, payments, payouts or EOD. It can still send price changes, with the signed-in person's "Edit prices" right checked by seiGEN. seiGEN refuses every money event from a seat (`SEAT_NO_SELLING`, as `cl_seat_need` already does for selling rights).

## 5. History and the first B4 check-in (decision 35)
- On the first successful check-in with v35, the till sets `b4_start` once.
- Every own sale and money event with a business date in the 90 days before `b4_start` is queued, marked `history: true`.
- Older rows are never sent. The flag `b4_history_done` makes sure history is queued once only.
- Events after `b4_start` are live, not history.
- **Balances brought forward (a gap between decisions 35 and 37):** a customer who owes money from more than 90 days back would otherwise owe nothing on seiGEN. To lose nothing, each till also sends, per customer, its balance from everything before the 90-day window (`credit_bf`). Today's balances are kept exactly; no detail older than 90 days is uploaded. History rows count in the debtor balance, because "all synced credit sales" includes them, and the debt is real. They are never posted to the books (decision 28): F-1 starts at its go-live date with the opening-balances wizard.

## 6. Credit across the business (decision 37)
- **seiGEN's balance** for a customer:
  - all synced credit sales;
  - minus credit payments;
  - minus returns refunded to the debtor account (the till's own formula today, `src/pos.js:276-285`);
  - plus balances brought forward;
  - for the whole business.
- **Online:** before a credit sale is committed, the till calls `cl_device_credit_check` with a **4-second** timeout.
  - seiGEN takes a per-customer lock and adds the other tills' credit holds still in flight.
  - When the sale fits: a hold under the sale's uid, and the answer "allowed".
  - When it doesn't fit: "over the limit", and the v34 override flow (decision 30) runs.
  - The hold ends when the sale itself arrives, or after 24 hours (a technical safety net, not a business rule).
  - **Two tills at once:** the second waits for the lock, sees the first one's hold, and is refused, or goes to override.
- **Offline, or after a timeout (decision 3):** available = limit − (seiGEN's balance at the last sync + this till's credit sales not yet in that balance). The sale is marked "checked offline" (`credit_check='offline'`, `credit_scope='last_sync'`).
  - Read literally, decision 3 subtracts this till's unsynced **credit sales** only. A payment taken offline counts once it reaches seiGEN.
- **The till's balance list:** pulled after each push (`cl_device_credit_balances`). Before the first pull, the till uses the v34 rule ("Balance at this till"). So does a device that isn't registered.
- **Wording:** cart, box and receipts show "Balance (business)" online, and "Balance (as of last sync)" offline. Without B4 they keep "Balance at this till".
- **The Q5 warning** ("Credit for another branch's customer", 14 Oct) said: "until B4 shares sales between tills". Decision 40 (23 Oct): the notice and its rules stay (cash: once per customer per till; credit: every time, with the Admin passcode). When seiGEN answered with the business balance, only the sentence "Their credit balance here covers this till only" is left out; offline the full text stays.
- **Unchanged:**
  - the Credit tab, statements and the full customer export keep this till's balance;
  - the over-limit override rules (decisions 2 and 30);
  - the built-in customers (no credit).

## 7. Reports (decision 38)
- `cl_device_branch_report` gains the kinds `sales` and `payouts`. As today:
  - another branch needs the signed-in person's "View other branches' reports";
  - costs and margins only with "View costs".
- In Report Writer the Sales Report, Credit Limit Overrides, Offline Credit Sales, Sales by Customer Type and Payouts Report offer "(from seiGEN)" branches, with the same right as Inventory today.
- A Cashier (no right) sees only their own branch, from the till, as now. Single operator mode is unchanged.

## 8. seiGEN (migration `20261113120000_sales_sync.sql`)
- **Tables** (RLS on, no grants to anon or authenticated; every row has `business_id` (on delete restrict), `branch_id` and `terminal_id` from the calling till, `history`, `received_at`):
  - `cl_sales`;
  - `cl_sale_returns`;
  - `cl_credit_payments`;
  - `cl_payouts`;
  - `cl_eod_closes`;
  - `cl_credit_overrides`;
  - `cl_price_change_log`;
  - `cl_voucher_events`;
  - `cl_credit_bf`;
  - `cl_credit_holds`;
  - `cl_sales_daily` (kept for good);
  - `cl_b4_runs` (when retention last ran).
  - Lines, payments and refunds are kept as `jsonb` inside their document: one row per document, which is smaller (§9).
- **Functions** (device auth as check-in: install ID, phrase and device key; a seat's person token):
  - `cl_device_b4_push`: up to 100 events per call, each answered on its own (stored, duplicate or refused, with a reason).
  - `cl_device_credit_check`.
  - `cl_device_credit_balances`.
  - `cl_device_branch_report`: replaced, the same plus `sales` and `payouts`.
  - Internal helpers.
- **Retention (decision 36):** at most once a day per business, during a push:
  - sale detail and money events older than 13 months are deleted;
  - first, their effect on each customer's balance is carried into that customer's balance brought forward, so no balance changes;
  - the daily summaries per branch and till stay;
  - books (F-1) are kept for good when they exist.
- **Unchanged:**
  - every existing function, except `cl_device_branch_report`;
  - the business merge: a business with synced sales still merges. Its sales stay under the archived business. A block like "it has customers" needs the owner's word, so it isn't added.

## 9. Sizes and the Free plan
- **Measured (VERIFIED):** one typical sale (3 lines, 1 payment) takes about **1.46 KB** in `cl_sales`, table and indexes together. The figure is from 2,000 sales, after VACUUM FULL, in `supabase/tests/sales-sync-test.js`. Returns, payments, payouts, End of Day and price changes add **under 5 %** to that in a normal shop (ASSUMED: about 1 of those for every 20 sales).
- **Daily summary:** one row per till per business day, about 150 bytes (ASSUMED from the row's columns), so about **55 KB per till per year**, kept for good.

| Shop | Sales a day | Detail per year | Kept (13 months) |
|---|---|---|---|
| Small | 50 | ~27 MB | ~29 MB |
| Medium | 150 | ~80 MB | ~87 MB |
| Busy | 400 | ~213 MB | ~231 MB |

- **Free plan (UNVERIFIED for this project's plan: Supabase Free has a 500 MB database):**
  - live is 17 MB today (`pg_database_size`, read-only, 23 Oct 2026);
  - room for about **15 small shops, 5 medium shops, or 2 busy shops** of sale detail.
  - This is the strongest case yet for **Supabase Pro** (8 GB included; already on the production checklist).
  - With Pro, about 90 medium shops fit before anything else is needed.

## 10. Tests
- `supabase/tests/sales-sync-test.js` (PGlite):
  - each kind stored once;
  - duplicates;
  - business and branch checks;
  - seat refusals;
  - two tills and one customer;
  - holds;
  - balances (with brought-forward amounts and returns);
  - retention keeps balances;
  - reports by right;
  - rollback exact.
- `test/b4-sales-sync.test.js` (the real app code against the real SQL):
  - every kind once after retries, blips and a restart mid-send;
  - the 90-day history, once;
  - a pre-B4 till's upgrade with nothing lost or doubled;
  - offline credit (decision 3) and the "checked offline" mark;
  - override flag;
  - priority on a flaky 2G network;
  - report rights;
  - a seat refused;
  - the indicator.
- Sell speed at 6× CPU on the large dataset (`tools/perf/sale-search-e2e.js`), before and after.
- The full suite.
