# Combined Claude Code prompt: Fix-A (v36) → Stock control + Notification bell (v37) → F-0 (v38)

Saved as given by the owner on 27 Oct 2026 (it replaces `fix-a-pre-f0-prompt.md`, `stock-control-v37-prompt.md` and `f0-finance-data-gaps-prompt.md`).

**Decision numbers (owner, 27 Oct 2026).** This prompt was written with its own numbers for the new decisions. The repo's `docs/decisions/post-build-29-decisions.md` keeps its numbering, so code comments, tests and "Logic changes" use the **repo** numbers:

| Prompt | Repo | Topic |
|---|---|---|
| prompt 45 | repo 48 | Role is authoritative everywhere (A11) |
| prompt 46 | repo 49 | Built-in Guest role (A12) |
| prompt 47 | repo 50 | RPN link locked (A13) |
| prompt 48 | repo 51 | Stock control order (v37 before F-0 v38) |
| prompt 49 | repo 52 | Cycle stocktake |
| prompt 50 | repo 53 | Stock requests from branches |
| prompt 51 | repo 54 | Recall from branches |
| prompt 52 | repo 55 | Notification bell |

Lower numbers in this prompt (8, 10, 12, 16, 28, 34, 39–44) are already the repo's and are unchanged.

---

Read `CLAUDE.md` and `docs/decisions/post-build-29-decisions.md` first. Save this prompt as `docs/prompts/next-builds-v36-v38.md` with your first commit.

**How to run this:**
- **Three builds in order:** Part 1 (v36), then Part 2 (v37), then Part 3 (v38). **Finish one** (applied, deployed to the previews, pushed) **before starting the next.**
- **Working mode:** stop only for:
  - "apply" on the live database;
  - a missing decision;
  - an unapproved logic change;
  - an owner decision this prompt asks for (A6, and the F-0 costing switch);
  - "go production".
- **Always:**
  - commit by name;
  - never chain an apply after a commit;
  - rebuild before tests, commits and deploys;
  - previews only;
  - one session at a time;
  - every report has a "Logic changes" section, tied to decision numbers.
- **After each stop, wait for my reply,** then continue from the next step of the same Part.

=====================================================================
# PART 1: Fix-A (v36)
=====================================================================

Read `CLAUDE.md` and `docs/decisions/post-build-29-decisions.md` ("Open issues before F-0", items A1–A10, and decision 34). Working mode: stop only for "apply", a missing decision, an unapproved logic change, or "go production". Commit by name; never chain an apply after a commit. Every report has a "Logic changes" section.

## A9 first: confirm the v35 state (read-only)
- Is v35 deployed to mobilepos-preview, desktoppos-preview and itred-preview, and pushed?
- Is the decision-40 correction in? The other-branch customer notice stays online; only the "this till's balance" sentence goes.
- If anything is missing, finish it first (deploy and push, previews only) and report.

## The fixes
**A1. Removed or old devices must not re-register silently** (decision 34, approved):
- seiGEN keeps a **list of removed devices** (filled by the purge and by future business deletions) and **refuses their check-ins** with a clear code.
- The device sends the **vendor id it last had**. If that vendor no longer exists, refuse the check-in. **Never auto-create a vendor row** from an unknown or removed device's check-in.
- The app shows **"This device belongs to a business that no longer exists on seiGEN. Reset this device"**, offering **"Save a backup first"** before anything is cleared. Never clear on its own.
- New installs still register normally through setup or join.

**A2. "New role" box:** reproduce at **1920×1080 and 1366×768**, and at 390 px. If the **Save** button is below the edge, make the box's footer (Save / Cancel) **always visible**, and the body scroll. Apply the same check to every modal with long content (Add person, Edit role, Receipts settings).

**A3. "Waiting to send" count:** reproduce the blank count from the v35 speed run. The indicator must always show a number (0 included) and the last-sent time. Fix it if it's blank.

**A4. Plan name on the bill (About, activation screen, banner):**
- remove the doubled word ("Growth Plan **plan**");
- show the plan name **exactly as set in the Console**, without adding "plan";
- report which plan names exist in the Console price plans today (expected: Business and Lite).

**A5. About page details:**
- the address and website come from the **company settings managed in the Console** (verify where these live; they were kept in the purge);
- the phone and WhatsApp numbers come from the **Contact directory** (decision 10);
- **nothing hard-coded**;
- cached for offline use, with "updated hh:mm";
- list every hard-coded address, website or number still in Commerce Lite, iTred or the Console (file:line).

**A6. Old local-only destination branches** (e.g. Norton "Not a branch on seiGEN: Delivery Notes are file only"): **proposal only, logic change**:
- Today these stay in the till's local list.
- Propose: on a registered till, show seiGEN's branches first; show local-only entries greyed under "Old local entries", with **Remove**. **Never delete them automatically.**
- **STOP and ask** before building A6.

**A7. Repeatable builds:**
- give the obfuscator a **fixed seed**, so identical source gives identical bundles;
- show that two rebuilds produce byte-identical files;
- the freshness check keeps working;
- the crypto files stay unscrambled (v30 rule).

**A8. Stray vendor rows** ("Today and Tomorrow", "Romana Books" device AKFW, and any other vendor rows created by old-device check-ins since the purge):
- after A1 is on live, prepare a data fix that deletes them **and** adds their devices to the removed list;
- backup first, trial run (ROLLBACK), then **STOP for "apply"**.

**A10. Owner test findings:** if the owner adds items in the reply, include them, each with its approval.

**A11. Role is authoritative everywhere** (decision 45, approved):
- **For every person on every device, the role decides.** A menu without the right is hidden **and** seiGEN refuses the call.
- **seiGEN checks the signed-in person's role on tills too**, not only on seats. That covers GRV, supplier GRV, dispatch, stock adjustments and stocktake posting, price changes, customer and supplier edits, reports from other branches, costs, staff and roles, and Finance later.
  - Use the same session token as seats (v32).
  - **Single operator mode:** the till acts as before, with today's Admin passcode checks, and logs "single operator". Report exactly what changes for single-operator tills; **don't weaken anything**.
- **Office seats show every menu the role allows** (reports, stock, dispatch, GRV, stocktake, approvals, staff, Directory, Finance when built), **except Sell, cash and End of Day, which stay on tills** (decision 16 kept, still locked in the seat licence).
- **Offline:** a till can still do offline what it can do today. Anything that needs seiGEN's check queues and is checked when sent; if refused, it's flagged to managers, never silently dropped. Report each case.

**A12. Built-in "Guest" role** (decision 46, approved):
- a new built-in role that **can't be deleted**, next to Owner, Admin, Manager, Bookkeeper, Stores and Cashier;
- **view only:** stock balances and **selling prices (retail and wholesale) for all branches**. Never costs, margins, customers, suppliers, sales, money, documents, reports beyond stock and prices, or settings. The role's rights can't be extended (a role with more rights is a different role);
- **signs in only on an Office seat.** Refused on tills, both in the app and by seiGEN;
- each Guest device is an **Office seat billed $3 per 30 days** (the existing seat billing);
- **an optional end date**, set by the Owner or Admin when adding a Guest. After it, sign-in is refused and the session ends;
- shown in Staff with a "Guest" tag and the end date.

**A13. Lock the RPN link** (decision 47, approved):
- after onboarding, the shop app shows the RPN link and the RPN's details **read-only**, with "To change your RPN, contact Digital Commerce";
- **seiGEN refuses** any change from a till or seat;
- only Console staff with a permission (e.g. "Change vendor RPN") can change it, and every change is logged (who, when, old and new);
- the Console page goes in the Console repo, deployed to `sclconsole-preview` only;
- verify where the RPN is set today (setup, Settings, About) and whether anything else depends on it (commissions, billing).

## Tests (at least)
- A1: a removed device's check-in is refused, with no vendor row created; the app shows the reset notice, and the backup is offered before any clear; a new install registers normally; an existing registered device is unaffected.
- A2: Save visible and working at 1080p, 768p and 390 px.
- A3: the indicator shows 0, then N, then 0 across a send.
- A4/A5: the plan label is correct; About reads from the Console settings and the Contact directory; offline cache.
- A7: two rebuilds are byte-identical; the freshness check passes.
- A11: each built-in role on a till and on a seat: menus shown or hidden, **and the server refuses** a forbidden call made directly (not just a hidden button); single-operator tills unchanged; offline calls queue and are checked on send; a seat never shows Sell or EOD for any role.
- A12: Guest on a seat sees all branches' stock and selling prices only; no costs anywhere; refused on a till; refused after the end date; billed as a seat.
- A13: the shop app shows the RPN read-only; a direct change from a till is refused by seiGEN; a Console change with the permission works and is logged.
- Full suite regression, including the roles, seat, freeze and B4 tests.

## Steps
1. A9, then build A1–A5, A7, A11, A12 and A13. Migration + rollback + PGlite tests for A1, A11, A12 and A13.
2. Rebuild, full suite, commit by name. Back up live, show the final SQL → **STOP for "apply"** (A1).
3. After apply: post-checks, deploy **v36 to the three previews only**, push.
4. Then A8: prepare, trial run → **STOP for "apply"**.
5. A6: the proposal only → **STOP** for my decision.
6. Report: "Logic changes" (A1 rests on decision 34, A11 on 45, A12 on 46, A13 on 47; A2–A5 and A7 are fixes or display-only; A6 waits for the owner), test results, and a short test checklist for me (including a Guest on a seat, and a Cashier refused by the server on a till).

Report saved: reports\latest-report.md

=====================================================================
# PART 2: Stock control + Notification bell (v37)
=====================================================================

Start only after Part 1 is applied, deployed and pushed.

Read `CLAUDE.md` and `docs/decisions/post-build-29-decisions.md` (decisions 8, 12, 45, 49–52, plus the earlier Branches design for requisitions, B3, in `docs/branches/`). Working mode: stop only for "apply", a missing decision, an unapproved logic change, or "go production". Commit by name; never chain an apply after a commit. Every report has a "Logic changes" section.

**Inspect first and reuse what exists:**
- stocktake (own branch only, from v25);
- the "Stock Requests" customer notepad, which **stays separate**: it's not the requisition;
- any requisition code or tables already built;
- the "Review stock requests" right;
- dispatch (DN), GRV and internal transfer, plus transport charges;
- adjustments and write-offs;
- the B4 sync queue and events;
- the roles and rights (decision 45: the role decides, and seiGEN checks).

## 1. Cycle stocktake (decision 49)
**Shelf / location:**
- an optional **shelf or location code per product per branch** (e.g. "A3"), edited in Products by people with the Products right;
- included in Excel import and export;
- synced through seiGEN (branch-level, like prices).

**The "Count now" tab on Stocktake:**
- a **daily short list** for this branch, grouped by shelf (items with no shelf are listed by name);
- the default size is about 20 items a day (the shop can change it);
- **how items are chosen, with the reason shown on each:**
  - **A/B/C class** by value sold at cost over the last 90 days: A is the top 80% of value, B the next 15%, C the rest. **A is counted weekly, B monthly, C quarterly.** The shop can change these.
  - **red flags** (counted first):
    - negative stock;
    - a difference at the last count;
    - many voids or returns on the item;
    - a sale while it showed 0;
    - a large adjustment or write-off;
    - received but never sold (a possible receiving error).
  - **not counted** for longer than its class allows.
- A manager can also **add items or a whole shelf** to today's list.

**Counting:**
- **Blind count:** the counter never sees the expected quantity or the difference.
- The count records **when it was taken**. Sales made between the count and the approval are allowed for, so **trading never stops** (explain the method you use).
- Works **offline**; syncs through B4 as an event.

**Approval:**
- **every difference needs Manager approval** before stock changes (someone with a new **"Approve count differences"** right; Owner, Admin and Manager by default);
- the Manager can **ask for a recount by another person**;
- when approved, the adjustment posts at the **current cost** (last cost today; WAC after F-0) and is recorded with who counted, who approved and the reason;
- no approval, no stock change.

**Shrinkage report** (Report Writer and the Stocktake tab):
- loss in units and value at cost, by **item, shelf, branch, period** and **shift / staff on duty** at the time of the difference (from sales and EOD records);
- trends, and the top 10 items lost;
- counts done vs. due;
- visible to people with **View costs** for values; others see units only.

## 2. Stock requests from branches (decision 50)
- A branch user with a new **"Request stock"** right (Manager, Stores and Cashier by default) creates a request for main: items, quantities, a reason, a "needed by" date. They see main's stock for each item.
- **People with "Review stock requests"** get:
  - a notification (in-app now; push comes with Batch 5);
  - a **"Stock requests" list**, filtered by status, branch and date, with any-order search;
  - a **"Stock requests" report** in Report Writer: open, approved, part-approved, rejected, time to process, by branch.
- **The reviewer approves all, part or rejects**, with a reason.
- **Approval creates a draft DN at main** for the approved quantities, linked to the request. Then the normal DN → GRV flow, with the transport rules unchanged.
- **Statuses:** Pending → Approved / Part-approved / Rejected → Dispatched → Received (from the GRV).
- **The requesting branch sees each status and the reason.**
- Double-click or tap a request to see its full history (who asked, who reviewed, DN and GRV links).
- Reuse the existing requisition design and code if present. **Don't create a second system.**

## 3. Recall from branches (decision 51)
- A user with the new **"Recall stock"** right (Owner, Admin and Manager by default) creates a **recall** to a branch: items, quantities (you may pick "all on hand"), a reason (expiring, overstock, move to another branch, quality, other) and a **due date**.
- **The branch sees the recall** with a notification and a list.
- **The branch fulfils it by dispatching back:** "Send back" creates a **DN to main**, pre-filled from the recall. The branch may mark items short, with a reason.
- **Main receives it with a normal GRV.**
- **Transport on a recall is paid by main** (shown on the DN as "paid by receiver: main").
- **Statuses:** Open → Partly sent → Sent → Received; **Overdue** after the due date, flagged to the person who made the recall.
- A recall report: open, overdue, shortages.
- Stock leaves the branch only when its DN is sent. **A recall alone never changes stock.**

## 4. Notification bell in the header (decision 52)
- **A bell icon in the header** on every till, seat, phone and desktop, with an **unread count**. Tap it to open the notification list.
- **What it shows (each only to people whose role allows it):**
  - **Market feed:** seiGEN broadcasts from the Console (decision 12; the bell replaces the separate "marketing-message flag");
  - **iTred sales orders:** a new order for this shop (Orders Fulfillment right);
  - **stock requests:** new and updated (requesters see their own; reviewers see new ones);
  - **recalls:** new recall to this branch, and overdue ones;
  - **count differences** waiting for approval;
  - **incoming DN / GRV movements** for this branch.
- **Sound:**
  - a short chime when a new notification arrives;
  - **Settings → Notifications:** sound on/off per person, plus on/off per category;
  - no sound repeat for the same event, however many times it syncs;
  - browsers only allow sound after the user has tapped the app once since opening it: say this in the setting, and show the bell badge either way.
- **Read state is per person** (decision 12). Tap an item → mark read → go to the screen. "Mark all read".
- **Titles only:** never amounts, customer names or prices in the bell text or in phone/PC notifications.
- **Checking for new items:**
  - while the app is open and online, **at least every 60 seconds**, using the B4 sync cursors;
  - pause when the app is hidden, check at once when it returns;
  - never two checks at once;
  - nothing new is lost while offline: it shows when the app is back online.
- **Phone/PC notifications while the app is running** (decision 8, Level 1): ask permission once, at a sensible moment; never ask again after a "no"; explain how to turn it on.
- **Push when the app is fully closed** stays Level 2 (later).
- **Tests:**
  - each category reaches only people with the right;
  - the unread count is per person;
  - the chime plays once per new event and respects the settings;
  - no duplicates after repeated syncs;
  - the 60-second check pauses when hidden;
  - titles only;
  - Guest sees only Market feed.

## Rights summary (add to the roles editor; built-in defaults)
| Right | Owner | Admin | Manager | Bookkeeper | Stores | Cashier | Guest |
|---|---|---|---|---|---|---|---|
| Request stock | ✓ | ✓ | ✓ | – | ✓ | ✓ | – |
| Review stock requests (exists) | ✓ | ✓ | ✓ | – | – | – | – |
| Recall stock | ✓ | ✓ | ✓ | – | – | – | – |
| Count stock (cycle) | ✓ | ✓ | ✓ | – | ✓ | – | – |
| Approve count differences | ✓ | ✓ | ✓ | – | – | – | – |

seiGEN checks all of these (decision 45).

## Tests (at least)
- **Cycle:**
  - A/B/C classes and the red flags select the right items, each with its reason;
  - blind count (no expected quantity shown anywhere to the counter);
  - every difference waits for approval, and no stock changes before approval;
  - a recount by another person;
  - sales during counting are handled correctly;
  - offline count then sync;
  - the shrinkage report figures, and units-only without View costs;
  - shelf per branch, plus import and export.
- **Requests:**
  - create, notify, approve all, part or reject with a reason → draft DN → GRV → statuses at both ends;
  - rights refused by seiGEN;
  - the report.
- **Recall:**
  - create, notify, send back with shortages → DN → GRV at main;
  - transport paid by main;
  - overdue flag;
  - no stock change until the DN is sent.
- **Bell:** see section 4.
- **Regression:** stocktake (own branch), dispatch and GRV, internal transfer, B4 sync, roles, the full suite.

## Steps
1. Inspect, then build. Migration + rollback + PGlite tests.
2. Rebuild, full suite, commit by name. Back up live, show the final SQL → **STOP for "apply"**.
3. After apply: post-checks, deploy **v37 to the three previews only**, push.
4. Report:
   - "Logic changes" (each tied to decisions 8, 12, 45 and 49–52);
   - test results;
   - screenshots at 390 and 1280 px of Count now, the approval screen, the shrinkage report, the stock requests list, the recall, and the bell (closed, open, settings);
   - **a two-branch checklist** for me.

Report saved: reports\latest-report.md

=====================================================================
# PART 3: F-0, data gaps before Finance (v38)
=====================================================================

Start only after Part 2 is applied, deployed and pushed.

Read `CLAUDE.md` and `docs/decisions/post-build-29-decisions.md` (items 28, 39–44). Working mode: stop only for "apply", a missing decision, an unapproved logic change, or "go production". Commit by name; never chain an apply after a commit. Every report has a "Logic changes" section.

## Goal
Fill the gaps B4 found (decision 41), so Finance F-1 can post correct double-entry later. **Additive only:** old records stay readable, with the new fields left empty.

## 1. Weighted-average cost (WAC): a logic change, done in two steps
The owner decided in October that stock is valued at **weighted average cost**. Today each sale records the **last landed cost**. Changing this changes COGS and profit, so:

**Step 1a, shadow mode (build now):**
- Compute WAC per **product per stock holder** (each till and Office seat, because a branch's stock is the sum of its tills).
- **Rules (owner decision 42):**
  - **Supplier GRV:** new WAC = (old qty × old WAC + received qty × unit cost) ÷ (old qty + received qty). If old qty ≤ 0 (negative stock is allowed offline), new WAC = the received unit cost.
  - **Dispatch → GRV between branches:** goods move at the **sender's WAC**. The **transport charge** (paid by the receiver) is **added to the received cost**, spread over the lines by value.
  - **Internal transfer (seat ↔ till):** moves at the sender's WAC, with no transport.
  - **Sales, adjustments, write-offs, stocktake differences:** valued at the **current WAC** of that stock holder.
  - **Returns:** go back at the **cost recorded on the original sale**.
  - **Starting point:** at go-live, each product's opening WAC = its current last landed cost. No history is recalculated.
- **Record both on every new sale line:** `cost_last` (today's) and `cost_wac`. Both sync in B4 events. **Reports and receipts keep using today's cost.**
- **A comparison report** ("Costing comparison: last cost vs WAC"): per product and branch, units sold, COGS and margin under each method, and the difference. Filter by date range.

**Step 1b, the switch (only after the owner approves the comparison):** reports, margins, stock value and the B4 cost sent all switch to WAC. **STOP before Step 1b** and show me the comparison on the test business.

## 2. Credit payments: method and reference (owner decision 43)
- **Method required:** cash / EcoCash / bank / card.
- **Reference required for EcoCash and bank**, optional for cash and card.
- The credit payment receipt shows the method and reference.
- Synced in the B4 credit-payment event.

## 3. Payouts: account and approver (owner decision 43)
- **Account required** on every new payout, from the existing payout chart of accounts. Verify what exists (file:line). If there's no chart of accounts, propose the smallest one and **STOP** (missing decision).
- **Approver:** record who made the payout and, where an approval or passcode was used, who approved it.
- Synced in the B4 payout event. Old payouts stay "unassigned".

## 4. End of Day per currency (owner decision 43)
- Expected and counted cash **per currency** (USD, ZiG, and any other currency the till holds), with a difference per currency.
- A till with one currency looks as it does today (one row).
- Synced in the B4 EOD event.

## 5. Currency code (owner decision 44)
- Every business has a **base currency code** (ISO style: `USD`; ZiG as `ZWG`, shown as "ZiG"). The symbol stays for display.
- Verify how ZiG is handled today (file:line). Don't invent exchange rules: the rate the owner sets stays the rate used.
- Every money event carries its currency code (B4).

## Tests (at least)
- WAC: GRV into stock, into zero and into negative stock; dispatch + transport into the receiver; internal transfer; sale, return, adjustment, write-off; both costs on the sale line; the comparison report totals.
- Credit payment: method required; reference required for EcoCash and bank; shown on the receipt; synced.
- Payout: account required; approver recorded; old payouts readable.
- EOD: two currencies, differences per currency; a single-currency till unchanged.
- Currency code on every synced money event.
- **Reports and receipts unchanged in Step 1a** (the same figures as v35).
- Full suite regression.

## Steps
1. Inspect, then build Step 1a plus items 2–5. Migration + rollback + PGlite tests.
2. Rebuild, full suite, commit by name. Back up live, show the final SQL → **STOP for "apply"**.
3. After apply: post-checks, rebuild, full suite, commit, deploy **v38 to the three previews only**, push.
4. **STOP** with the costing-comparison instructions for my test business. **Step 1b waits for my "approved".**
5. Report: "Logic changes" (each tied to decisions 41–44), test results, and a short test checklist for me.

Report saved: reports\latest-report.md
