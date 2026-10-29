# Claude Code prompt: Stock-request drafts, dispatch reminder, branch-figures fix, iTred bell fix, lost-logic audit and whole-app module test (v37.1)

**Queue position (owner, 28 Oct 2026):** runs **before F-0 (v38)**, right after v37 (deployed and pushed) and the Vendors Register status fix (Console). F-0 stays v38 and starts only after v37.1 is deployed and pushed. One Claude Code session at a time.

Paste below the line into Claude Code in `C:\seigen-commerce-lite-refactor` (branch `activation-v2`).

---

Read `CLAUDE.md` and `docs/decisions/post-build-29-decisions.md` (decisions 52–57, especially 53 and 55). Working mode: stop only for "apply", a missing decision, an unapproved logic change, or "go production". Commit by name; never chain an apply after a commit. Every report has a "Logic changes" section.

**Queue:** this is v37.1 and runs **before F-0 (v38)**. If F-0 work has already started in this repo, don't mix the two: report what F-0 work exists (uncommitted or committed), park it safely (commit it on its own by name, or leave it untouched and tell me), and STOP for my decision before building v37.1.

## Step 0: record the decisions
Add both decisions below to `docs/decisions/post-build-29-decisions.md` **after the last number**, as approved (owner, 28 Oct 2026). Keep the repo's numbering. STOP if anything conflicts. Also update the roadmap/queue in `docs/prompts/next-builds-v36-v38.md`: v37 → **v37.1 (this)** → v38 (F-0).

## Decision 1: approval saves a real draft DN
Today (v37) approval only shows a **"Create dispatch"** button that opens a pre-filled Dispatch screen; nothing is saved until someone sends it (`src/srq.js` ~lines 180–218, `src/dispatch-out.js` ~line 260). Change it to:
- When a request is **approved or part-approved**, seiGEN creates a **draft Delivery Note** at main for the approved quantities, linked to the request (the same link and internal ref as today).
- The draft is **stored on seiGEN**, so it doesn't matter which till or Office seat approved it. It shows in **Dispatch at main** under **"Drafts from stock requests"**, for anyone with the Dispatch right on a main till.
- **A draft moves no stock and reserves nothing.** Stock leaves main only when the DN is sent (unchanged).
- **Opening a draft** opens the normal Dispatch screen, pre-filled.
  - The sender may **lower** quantities or **remove** lines, never raise them above what was approved.
  - Each change is recorded: approved vs sent, and who changed it.
  - Sending is the normal DN flow through seiGEN; transport rules are unchanged. The request then goes Dispatched → Received, as today.
- **No silent delete.** A draft can only be **sent**, or **closed** with a reason by someone with Review stock requests or an Owner/Admin.
  - Closing shows on the request ("Approved, not dispatched: <reason>"), and the requesting branch sees it.
  - Propose the exact status name. Don't invent any flow beyond that; STOP if it needs one.
- Replace **"Create dispatch"** with **"Open draft DN"**.
- **Two people open the same draft:** only the first send counts; the second is told it's already been sent.
- **Requests approved before this build** that have no DN: create their drafts once, at post-check. Report how many.

## Decision 2: dispatch reminder, with an adjustable delay
- If an approved request's draft **hasn't been sent** after the **reminder delay**, the bell tells **everyone at main with the Dispatch right, plus the person who approved it**: "SRQ-… for <branch> approved <time>, not dispatched yet".
- It **repeats** at the **repeat interval** until the draft is sent or closed, and stops at once when it is.
- The requesting branch sees **"Approved, waiting for dispatch since <time>"** on its request.

**The timers are owner-adjustable** (owner request, 28 Oct 2026):
- A **business setting** in Settings (e.g. under Stock control or Notifications), changeable by **Owner/Admin only**:
  - **Reminder delay:** default **8 hours**; allowed **1 to 72 hours**, whole hours;
  - **Repeat every:** default **24 hours**; allowed **4 to 72 hours**, or **"Don't repeat"**.
- The setting is **business-wide**, stored and enforced on **seiGEN** (not per till), so every main till uses the same values. seiGEN refuses changes from anyone else.
- Every change is **audited** (who, when, old → new).
- A change applies to drafts **already waiting**, measured from their approval time (e.g. lowering 8 → 4 hours makes a 5-hour-old draft remind at once). Say clearly in the report how you handle this.
- Clock hours. Offline tills use the last values they received.

## Fix 3: main's stock shows "no figures yet" at the branch (owner report, 28 Oct 2026)
**What the owner sees:** main has opening stock (20 units), but the remote branch shows main as **"no figures yet"** in **Other branches** and the **Product list**.

**Likely cause, from reading the code (confirm it before fixing):**
- `src/branch-stock.js`: a till sends its figures (`bsPush`) only once seiGEN says the business takes them (`cl_bs_enabled`: 2 or more active tills, `20261024120000_branch_stock.sql` ~line 82).
- When main registered **alone**, seiGEN answered "enabled: false". Main then stored `bs_enabled = "0"` (~line 80) and **doesn't ask again for 6 hours** (`BS_RECHECK_MS`, ~lines 25 and 55). `bsSoon` (~line 98) also does nothing while `bs_enabled` isn't "1", so new stock (the opening stock) isn't sent either.
- When the branch joins, main isn't told. Its own pull already learns that seiGEN now takes figures (`bs_server_enabled = "1"`, ~line 128), but `bsPush` only checks `bs_enabled`. Nothing ever calls `bsPush({ force:true })`, and the **Refresh** button in Other branches (~line 496) doesn't force it either.
- Result: main sends nothing for up to 6 hours after a branch joins, and the branch shows "no figures yet" (`bsUpdatedText`, ~line 222).

**First, confirm read-only:**
- on live: does main's till have any stock-level rows, and when did it last push;
- on main's till (or a reproduction with two test tills): `bs_enabled`, `bs_checked_ts`, `bs_server_enabled`, `bs_error`;
- rule out the other causes: main is a shared-stock till, main is offline, or main's app hasn't been opened since the opening stock was entered.
Report which cause it is. If it's something else, STOP and report before fixing.

**The fix (bug fix: restores the designed behaviour "each registered till sends its own stock levels"):**
- When a pull shows seiGEN now takes figures (`enabled: true`) while this till has `bs_enabled = "0"`, **push at once** (full), without waiting for the 6-hour recheck.
- The **Refresh** button in Other branches forces a push from this till, then pulls.
- After a branch or till **joins** the business, every till learns at its next check-in or pull and sends its figures straight away.
- Branch figures show "**not sent yet by <branch>**" (with the reason when known, e.g. offline) instead of the plain "no figures yet", so staff can tell the difference.
- Nothing about **what** is sent, who can see it, or costs changes.

**Tests:** main registers alone ("enabled: false"); a branch joins; main sends within one pull or check-in, not 6 hours; Refresh forces it; opening stock entered before the branch joined shows at the branch; a single-till business still sends nothing; a shared-stock till still sends nothing; the branch-stock suite.

**Logic changes:** this is a bug fix, not a new rule. If the real cause turns out to need a rule change (e.g. a server change to `cl_bs_enabled`), STOP and report it as a logic change for my approval.

## Fix 4: iTred order in the bell opens an empty More page, plus an audit of lost or disconnected logic (owner report, 28 Oct 2026)
**What the owner sees:** an iTred order (Market fulfilment) notice arrives in the bell. Tapping it opens **More**, but **Orders Fulfillment isn't there**, so there's nowhere to go.

**What the code shows (confirm it):**
- The bell gets iTred orders from the v37 bell feed (`src/bell.js` ~lines 108–112), whatever this till's iTred state is.
- Tapping sets `moreTab = "itredorders"` (`src/bell.js` ~line 297).
- But **Orders Fulfillment** only shows when `itredAvailable()` is true (`src/router.js` MORE_TABS, `src/itred-orders.js:33`): the till is registered **and** its own setting `itred_on = "1"`.
  - `itred_on` becomes "1" only after this till's own `itredPull` succeeds (~line 221), and goes back to "0" when seiGEN answers `NOT_ON_ITRED` (~lines 170, 199).
- The tab also needs the **Sell** right (`src/roles.js:111`, `itredorders: "m.sell"`).
- When the tab is hidden, `renderMore` falls back to the first tab (Help), so the tap goes "nowhere".
- So the bell and Orders Fulfillment disagree about whether this business is on iTred, or about who may see the orders.

**First, confirm read-only which case it is:**
- on the owner's till: `itred_on`, `itred_error`, `itred_pulled_ts`, the signed-in role;
- on live: what `cl_device_itred_orders_pull` answers for this till, and what rule the bell feed uses for iTred orders, compared with the rule the pull uses (business on iTred? main till only? pack live or expired?);
- whether the till is a branch till or an Office seat, and whether that matters on either side.

**The fix:**
- **One rule** for "this business has iTred orders here", used by the bell **and** Orders Fulfillment (and the Marketplace Feedback tab). If the bell can show an order, the person can open it, and vice versa.
- A tap on an iTred notice must always land on the order. If the person can't open it, the bell doesn't show it to them (same rights as the tab).
- **No tap from the bell may end on a page that isn't there.** Apply this to every bell route (`srq:`, `rcl:`, `counts`, `itred`, `incoming`/`dispatches`, `market`): if the target isn't available, show why ("Needs the Sell right", "This till isn't on iTred yet: tap Refresh") instead of falling back to Help.

**Audit: lost or disconnected logic (report first; restore only as described):**
1. **Marketing and iTred, end to end.** List every feature with its menu entry, its handler (file:line), whether it's reachable, and whether it works, then trace each one:
   - Marketing menu → Add to Marketing → market pack (photos, thumbnails) → Send to seiGEN (`cl_device_pack_submit`, right `m.marketing`);
   - listing tokens (1 token = 1 day = USD 1 per pack, paid through the ledger, oldest charges first);
   - Console review → live on iTred → renewal and expiry;
   - iTred orders → Orders Fulfillment → checkout as a real sale (decision 5/5b: a different person verifies, except solo shops, flagged);
   - Marketplace Feedback; iTred orders in the bell; queued orders on weak signal (decision 13).
2. **Every menu item and every in-app link** (phone bottom bar + More; desktop ☰; Settings sections; bell routes; Help links): does it open a real screen for the roles that see it? List any that are hidden, empty, or fall back somewhere else.
3. **Git history:** search the history (`git log -S` / `-G` on the function and screen names) since v27 for features, menu entries or handlers that were **removed or disconnected**. For each: what it was, the commit that removed it, and whether the decisions doc approved the removal.

**Rules for restoring:**
- Something that was approved and built, then **removed or disconnected without an approval** in the decisions doc, is a **regression**: restore it as it was, list it under "Logic changes" as "restored (regression)", with the commit that broke it, and test it.
- Anything that needs a **new** rule or changes how something worked before: **don't build it**. STOP and list it for my approval.
- Never remove anything as part of this audit.

**Tests:** an iTred order notice opens the order for a person with Sell; a person without Sell doesn't get the notice; a till not on iTred shows neither; every bell route lands on a real screen or shows why; each restored item has its own test; the iTred and marketing suites.

## Part 5: run and test every module, then report (owner directive, 28 Oct 2026)
After Fixes 1–4 are built, **run the whole app and test every module as a user would**, not just the unit tests. Report what you ran, what you tested, what failed and what you fixed.

**Scope: every module, on each build where it exists** (`dist` desktop, `dist-pwa` phone, `dist-tauri` where it can run here, `dist-itred`), and the Console (`sclconsole`) for its own pages:
- **Setup and access:** setup, activation and trial, first Owner, Admin passcode (this till), single operator mode, PIN sign-in, idle sign-out, sign in to manage staff, roles and the Refresh button.
- **Sell:** cart, search, customers (Cash Sale / Wholesale built-ins), payments and references, credit sales, limits and overrides, vouchers/store credit, receipts (screen, PDF, logo), returns and voids, End of Day.
- **Products:** add, edit, Excel import and export, categories, prices, shelves, low stock, the item ledger.
- **Stock:** stocktake, Count now, approvals, shrinkage, adjustments and write-offs.
- **Branches:** Stock by branch / Other branches, dispatch (DN, through seiGEN and file only), receiving (GRV), supplier GRV, internal transfers, transport charges, stock requests (with the new drafts), recalls, joining a branch, Office seat invite and seat sign-in, Guest.
- **Credit and customers, Directory, Purchasing, Requests (customer notepad).**
- **Reports and Report Writer:** every report, with and without View costs, own branch vs other branches.
- **Marketing and iTred:** the full chain from Fix 4, plus Orders Fulfillment, Marketplace Feedback, and iTred itself (browse, order, weak signal).
- **The bell:** every category and every route, sound and per-person settings, the new dispatch reminder.
- **Settings:** every section, Business & Terminals, Notifications, the new reminder timers, Receipts, backups and restore, About (Contact directory, company details).
- **Sync and offline:** B4 sales sync, "waiting to send", going offline mid-task and coming back, removed-device reset notice.
- **Console:** Vendors Register, licences and activation codes, RPN Directory, Market feed, plans, the pages this build touches.

**How to test:**
- Use the **browser tests (Playwright)** on freshly built bundles, at **390 px and 1280 px**, plus the existing harness and PGlite server tests. Drive real clicks and typing: UI → handler → data → what the screen shows.
- Test **as each built-in role** where it matters (Owner, Admin, Manager, Bookkeeper, Stores, Cashier, Guest), and **single operator mode**.
- Use a **two-branch setup** (main + one remote till, plus an Office seat) for everything that crosses branches.
- For each module test the **normal path, wrong input, empty state, offline, and a refused right**.
- **Never touch real shops.** Anything that must reach live seiGEN uses a **dedicated test business**, created for this run and fully removed afterwards (report what you created and removed). No live schema change outside the v37.1 migration and its "apply" stop.
- Keep the PC otherwise idle while the full run goes (it's long).

**Fixing what you find:**
- **A bug** (something that doesn't do what was approved and built: a broken button, a screen that won't open, a wrong total, a crash): fix it, add a test that would have caught it, and list it.
- **A logic change** (anything needing a new or different rule): don't fix it. List it for my approval, with what, where, today vs proposed, why, impact and alternatives.
- **Something you can't test here** (e.g. a real phone install, a printer, a real 2G network): mark it **UNVERIFIED** and say how I can test it.
- Re-run the affected modules and then the full suite after every round of fixes.

**The report must include a module table** with one row per module (and per role where it matters):

| Module | Builds tested | Roles | What was tested | Result (Pass / Fixed / Fails / Needs approval / Unverified) | Fix commit | Evidence (test name or screenshot) |

Then:
- the bugs fixed (each with cause, fix, test);
- the items waiting for my approval;
- what's UNVERIFIED and why;
- remaining failures, if any (never hide one).

## Inspect first
`src/srq.js`, `src/dispatch-out.js`, `src/dispatch-srv.js`, `src/bell.js`, `src/stock-ctl.js`, `src/settings.js`, `src/branch-stock.js`, `src/branch-views.js`, `src/itred-orders.js`, `src/marketing.js`, `src/router.js`, `src/roles.js` and the v37 migration `20261115120000_stock_control.sql` (now on live: build on it with a **new** migration; never edit the applied one). List what you reuse (file:line). Don't create a second dispatch or notification system.

## Tests (at least)
- Approve all / part → the draft exists on seiGEN and in Dispatch at main; **no stock change until sent**.
- Sender lowers a quantity (recorded) and can't raise it; removes a line.
- Two senders on one draft.
- Close a draft with a reason (shown at both ends); closing without a reason is refused; rights refused by seiGEN.
- **Reminder:** fires at the default 8 h (time-travelled), repeats at 24 h, stops when sent or closed.
- **Settings:** an Owner/Admin changes the delay (e.g. 2 h) and the repeat (e.g. 6 h, and "Don't repeat") and the reminders follow; out-of-range values are refused; a Manager or Cashier is refused by seiGEN; the change is audited; a lowered delay applies to waiting drafts.
- Offline approval, then sync.
- The existing v37 tests and the full suite.

## Steps
1. Step 0, inspect, then build. Migration + rollback + PGlite tests.
2. Rebuild, full suite, **commit by name**. Back up live, show the final SQL → **STOP for "apply"** (I run it in PowerShell, then tell you to continue).
3. After apply: post-checks (including drafts created for older approved requests), rebuild, full suite.
4. **Part 5: run and test every module** (the whole-app run above), fix bugs, list the rest. Commit fixes by name in small commits.
5. Final rebuild, full suite, commit, deploy **v37.1 to the three previews only** (and `sclconsole-preview` if the Console changed), push.
6. Report:
   - "Logic changes" (these two decisions only, plus Fixes 3 and 4 and the Part 5 bug fixes as bug fixes and restored regressions; anything beyond them, stop and ask);
   - Part 5: the module table, bugs fixed, items waiting for approval, UNVERIFIED items, remaining failures;
   - Fix 3: the confirmed cause, with evidence;
   - Fix 4: the confirmed cause, the audit table (feature, menu entry, handler, reachable?, works?, removed by which commit?), what you restored as regressions, and the list waiting for my approval;
   - test results;
   - screenshots at 390 and 1280 px: "Drafts from stock requests" in Dispatch, an open draft, the reminder in the bell, the new settings;
   - a short two-branch test checklist for me.

Report saved: reports\latest-report.md
