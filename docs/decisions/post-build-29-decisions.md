# Post–build 29 upgrade: owner decisions and roadmap

**Source of truth for Claude Code.** Save it at `docs/decisions/post-build-29-decisions.md`. The owner (Lovemore) updates it. Where it conflicts with an older design doc, this file wins, unless the owner says otherwise in the task prompt. Last updated 27 Oct 2026.

## Status
| Build | What | State |
|---|---|---|
| v30 | Fix for the sign-in and branch-switch freeze | done, `2c67145` |
| v31 | Staff managers on every till | applied, `4a8b439` |
| v32 | Office seat by invite (migration `20261109120000_office_seats`) | applied, on the previews, `d92a690`; test fix `0b2d67b` |
| v33 | Roles fetch after register/join, visible Refresh, limited old-staff upload, Owner default, first-Owner log, internal-transfer error fix | done, pushed `4e7eef2`, on previews + sclconsole-preview |
| purge | All test businesses deleted (961 rows, 56 photos, 6 sign-ins); backup kept offline | done 22 Oct 05:42; the 2 old-device vendor rows and the 2 test-leak rows removed 22 Oct (`d3e8ad8`) |
| 6A | Content protection + Contact directory | applied 22 Oct (`20261111120000_contact_directory`), `d3e8ad8` / Console `fe68c6a`, on previews + sclconsole-preview |
| v34 | Batch 2: credit limits, built-in customers, receipts, 4 reports, Sell speed (migration `20261112120000_builtin_customers`) | applied 22 Oct, done, `e541fc9`, on the 3 previews |
| v35 | B4 sales sync (migration `20261113120000_sales_sync`) | built `77878d2`; applied 23 Oct, `d5ec497` (with decision 40); on the 3 previews |
| v36 | Fix-A (open issues A1–A13, below) | in progress (27 Oct) |
| v37 | Stock control + notification bell (decisions 51–55) | after v36 |
| v38 | F-0 data gaps (items 41–47), then Finance F-1 screen designs | after v37 (decision 51) |

## Roadmap (in order)
1. ~~Purge of the test data~~ (done 22 Oct).
2. ~~**Batch 6A:** content protection in all apps, plus the Contact directory managed from the Console (items 9 and 10).~~ (done 22 Oct)
3. **Batch 2 (v34), selling and credit:**
   - items 1–4;
   - the receipt upgrade (business name, logo, address and phones; customer and operator; payment method and reference; credit before and after; a receipt message set in Settings; "powered by seiGEN Commerce" in small faint text);
   - credit-limit checks;
   - Sell speed for big shops (the product list held in memory, search waits for a pause in typing);
   - the remaining ~25 Admin passcode checks moved off the screen thread;
   - Batch 2 reports (below).
4. **B4:** sales sync (every sale, return, credit payment, payout, EOD cash; the cost at the time of sale; currency and exchange rate; payment method).
5. **Fix-A (v36)**, then **Stock control + notification bell** (v37, decisions 51–55), then **F-0, data gaps** (v38, item 41), then **Books + Cash Flow, one engine** (items 17–29): **F-1** books and cash basics, **F-2** growth tools, **F-3** purchasing and control, **F-4** payroll (wages, no tax calculation).
6. **Batch 3:** orders checkout and supervisor verification (items 5 and 5b).
7. **Batch 4, iTred:**
   - proof of payment (6), chat archive and delete-for-me (7);
   - hidden search keywords;
   - a search icon on Your Orders and Vendors;
   - remove "49 Brechin Est." from the iTred UI;
   - weak-signal speed and offline queued orders (13).
8. **Batch 5:** notifications (8), refresh at least every 60 s, the marketing-message flag (12). (The bell, the 60 s check and the Market feed come earlier, in v37: decision 55.)
9. **Batch 6B:** privacy and legal notices; the rule-based Seith helper on iTred Contact Us (11).
10. **Batch 7 (Console repo):** monthly document-review reminders.
11. **Office / business brain:** Seith prices (14), market intelligence (15), activity logs (B5).
12. Seith (after F-1 to F-4), then the **Qwen3 4B trial** (Windows .exe only).

**Production** comes as its own step, only on "go production", after the purge and the production checklist:
- the removed-devices fix (item 34; now built in Fix-A, A1);
- a unique, hidden secret phrase per device;
- dropping old-code acceptance;
- a private repo;
- Supabase Pro;
- the domain.

## Open issues before F-0 (27 Oct 2026)
**Fix-A (one small build before F-0):**
- A1. Deleted or old devices re-register and create stray businesses (decision 34: seiGEN refuses removed devices; the app shows "Reset this device", offering a backup first).
- A2. "New role" box: the Save button isn't visible on a 1080p screen (to confirm).
- A3. The "waiting to send" count came back blank during the v35 speed run (to confirm).
- A4. About shows "Growth Plan plan" (the word repeated) and a plan name that isn't Business or Lite.
- A5. About shows a hard-coded address, website and WhatsApp number; it should read from the Contact directory and business settings.
- A6. Old destination branches that aren't on seiGEN (e.g. Norton "file only") stay in the till's local list.
- A7. Builds aren't repeatable: give the code scrambler a fixed seed.
- A8. Stray vendor rows on live from old devices ("Today and Tomorrow", "Romana Books" device AKFW): delete them once A1 is live (data fix, owner's "apply").
- A9. Confirm v35 is deployed to the three previews and pushed, and that the decision-40 correction is in (the other-branch customer notice stays online; only the "this till's balance" sentence goes).
- A10. Anything found in the owner's outstanding tests (below) is added here before Fix-A starts.
- A11. Role is authoritative everywhere (decision 48): seiGEN checks the person's role on tills too (B2 moved here); Office seats show every menu the role allows except Sell, cash and EOD.
- A12. The built-in Guest role (decision 49).
- A13. Lock the RPN link and details in the shop app (decision 50).
- A14. (owner 27 Oct, for v37; approved, not a logic change) The app must not depend on cdnjs at runtime: serve the database engine files (and any other cdnjs or third-party files the app loads at runtime, listed in the report) from our own app address, cached by the service worker as now. Measure first-load time on a throttled 2G profile before and after. (Found in the v36 full suite: sql-wasm.wasm took 12–48 s from cdnjs; the browser tests now use local copies, `test/local-cdn.js`.)

**Security before production:**
- B1. The secret phrase is shown in Settings and shared by every device → one phrase per device, hidden.
- B2. (moved into Fix-A as A11.)
- B3. seiGEN checks the Admin passcode when the first Owner is created.
- B4. Supabase Pro, a private repo, the domain.

(These B1–B4 are security items; they are not the Branches requisition design "B3" or the B4 sales sync build.)

**Owner tests outstanding:** v33/v34 combined test, the v35 two-till credit test, the Office seat test.

**Prompt numbers:** the combined prompt `docs/prompts/next-builds-v36-v38.md` numbers the new decisions 45–52; here they are 48–55 (prompt 45 = 48, 46 = 49, 47 = 50, 48 = 51, 49 = 52, 50 = 53, 51 = 54, 52 = 55).

## Decisions (20 Oct 2026)
| # | Topic | Decision |
|---|---|---|
| 1 | Category buttons on Sell | Remove all of them. Products are found by search and barcode; the category still shows under the name and is searchable. |
| 2 | Credit over the limit | Blocked. Override only by someone with the "Credit sales over limit" right plus the Admin passcode; every override is logged and shown to managers. |
| 3 | Offline credit sales | Allowed up to the available credit at the last sync, minus this till's unsynced credit sales. Marked "checked offline". |
| 4 | Cash Sale / Wholesale | Two built-in customers per business. Locked: no edit, no delete, no credit. Synced to every till. Shown in the Directory with a lock. |
| 5 | Orders Fulfillment checkout | Check Out puts the supplied quantities into the cart and makes a real sale (stock goes down, receipt). The order then waits as Pending verification. Replaces the earlier "status only" rule. |
| 5b | Who verifies | Someone with a new "Verify orders" right who did not do the checkout. Exception: if the business has only one such person, they may verify their own checkout, and it is flagged. |
| 6 | iTred proof of payment | Private Supabase storage, links expire after 10 minutes. Photos about 300 KB, PDFs up to 2 MB. Files deleted 180 days after the order closes; the payment record stays. |
| 7 | Order chat | "Delete for me" only. Whole conversations can be archived and restored. The record is always kept. |
| 8 | Notifications | Level 1 now: in-app alerts plus phone/PC notifications while the app is running. Level 2 next: web push when the app is closed. Titles only, never amounts or names. |
| 9 | Content protection | No screenshot blocking. In **all apps** (Commerce Lite, iTred, Console): the **right-click / long-press menu is blocked** so users can't choose "Inspect" (it still works inside inputs); **F12, Ctrl+Shift+I/J/C, Ctrl+Shift+L, Ctrl+U, Ctrl+S** are blocked (plus the Mac equivalents); other F-keys are blocked except the app's own shortcuts; no page text selection; Copy buttons where people need them; code scrambling for iTred and the Console too (crypto files excluded, no slowdown). No DevTools-detection tricks. Honest limit: DevTools can still be opened from the browser's own menu, so real security stays on the server. |
| 10 | Contact directory | **Not hard-coded.** Numbers live in the database and are **managed from the Console** ("Contact directory" page, a "Manage contact directory" permission, every change logged). **Desks can be added, and each desk can have several numbers**, each with a label, Call on/off, WhatsApp on/off, an order and active/inactive. Starting data: Queries Desk +263 774 479 121; Sales +263 789 487 287; Support +263 789 487 287, each with Call + WhatsApp. iTred Contact Us reads it and caches it offline. |
| 11 | Seith | Rule-based Seith now for the iTred Contact Us helper. A Qwen3 4B Q4_K_M trial later, on the Windows .exe only. |
| 12 | Marketing-message flag | Console broadcasts from seiGEN to shops, in one inbox that will later also carry Office messages to staff. Unread counts are per person. |
| 13 | iTred on very weak signal | Responsive and quick even on very weak signal. Public listings cached at Cloudflare's edge; small, paged, compressed replies; thumbnails load on scroll; data saver switches on automatically on 2G or "save data"; cached results shown first, then updated in place. **Orders can be queued offline** and sent when the signal returns ("Waiting to send"); the vendor then confirms price and stock. |
| 14 | Seith changing prices | Seith never changes a price itself. It prepares a confirmation card showing old and new price, cost, margin, the branches affected, and below-cost warnings. The user confirms with the **Edit prices** right; **any price below cost also needs the Admin passcode**. The change goes through the normal price-change process, checked by seiGEN, and is logged "via Seith" with who confirmed it. |
| 15 | Seith asking for market intelligence | Seith asks Owner, Admin, Manager and Stores (cashiers can add information whenever they want). The questions are triggered by stock requests, slow sellers and cost increases, plus a weekly question about competitor prices. Answers are stored as structured facts: competitor and area, product, price, date, notes, optional photo. No personal data about people. At most once a day per person, and every question can be skipped. |
| 16 | Office seat by invite | A one-time code + link (expires in 24 h, for one named person, no secrets; Owner or Admin approves the device; revocable). A device with no till, for admin work; holds main-branch stock; can do GRVs, dispatch, stocktake and adjustments, but **never sells or runs EOD**. **$3 per 30 days.** Built in v32. |
| 17 | COGS Reserve money | Held in a **separate reserve account** (bank, EcoCash or a locked cash box). **Funding is an actual transfer into it.** Paying suppliers for stock from it is the permitted use. |
| 18 | Reserve used for other purposes | Rent, wages, drawings and similar need **Owner or Admin approval with a reason**. Every use is logged, raises an alert and creates a recovery plan. Never physically blocked. |
| 19 | Packaging (updated 22 Oct) | **Books + Cash Flow are core for Business-plan shops.** Lite gets debtors and the reserve only. **Payroll (F-4) is a paid add-on.** |
| 20 | Order (updated 22 Oct) | After B4, **one engine**: a double-entry ledger underneath, with Cash Flow, Debtors, Creditors, the Reserve and the growth tools on top, all reading the same ledger. Before Seith. Replaces "Working Capital first, books add-on later". |
| 21 | Rights | Approved (table below), including a new built-in **Bookkeeper** role. |
| 22 | Manager approval limit | **$200 per supplier payment** by default; above that, Owner or Admin approves; each shop can change it. |
| 23 | Name and placement (updated 22 Oct) | **Finance: its own module with its own UI/UX**, replacing "Office → Cash Flow". A **"Finance" item in the main menu** (☰ on desktop, More on phones), hidden by rights; Office links to it. **Same brand, finance layout:** orange accent and the same fonts, a calm white workspace, a left sidebar, dense number-friendly tables with frozen columns and drill-down to the document, clear Actual / Forecast / Plan tags, a USD/ZiG switch and a branch filter. **PC first** (full workspace on a PC or Office seat); **phones get a summary**: Overview, Cash, Debtors, Creditors, approvals, via a Finance bottom bar and a "Back to shop" button. **Its own build layer** (like Marketing): loaded only for Business-plan shops and finance users, so the selling screens stay light. Sidebar: Overview · Cash · Debtors · Creditors · Reserve · Books · Journals · Plan · Payroll (add-on) · Reports · Finance settings (chart of accounts, months, reserve policy, approval limits, opening balances). Office keeps the Dashboard, the Approvals inbox (finance approvals also show inside Finance), messages and branch control. |
| 24 | End of Day prompts | "Bank the takings" and "Fund the reserve" (today's stock cost sold), each needing confirmation. |
| 25 | Privacy from seiGEN | Console staff never see a shop's cash flow, debtors, creditors or books. Support access needs the shop's written permission. To be stated in the Privacy Policy. |
| 26 | One engine: phases | **F-1** (after B4): the ledger and automatic posting from synced documents (sales, returns, GRVs, supplier GRVs, payments, payouts, EOD, transfers, dispatch/GRV between branches); a standard chart of accounts; cash, bank, EcoCash and the COGS Reserve as real accounts; debtors and creditors with ageing; supplier payments with approvals; Trial Balance, P&L, Balance Sheet, cash book, general ledger; the opening-balances wizard; closing and locking months; the End of Day prompts. **F-2:** the 13-week cash-flow plan and forecasts; break-even, margin by product and branch, stock money stuck, a weekly health score with the top 3 actions. **F-3:** purchase orders, supplier scorecards, bank matching, currency gains and losses. **F-4:** payroll (wages, advances, deductions, payslips; PAYE, NSSA and AIDS levy typed in, not calculated). |
| 27 | Posting | Automatic, on seiGEN, from the synced documents; deterministic and re-runnable with uids. Staff never type journals. Entries are never edited, only reversed; each links to its source document; debits equal credits per entry and currency; each entry carries its branch, currency and the rate used. |
| 28 | Starting the books | **Fresh from a go-live date**, with the opening-balances wizard (cash, bank, stock at weighted average cost, debtors, creditors, capital). No back-posting of older history. |
| 29 | Manual journals | The **Bookkeeper prepares them with a reason; Owner or Admin approves** before they post. Never edited, only reversed. Closing a month: Owner or Admin. |
| 30 | Over-limit credit (22 Oct) | The signed-in person must hold "Credit sales over limit" **and** type the Admin passcode. In single operator mode, the Admin passcode alone may override, logged as "single operator". |
| 31 | Credit before B4 | The credit limit uses **this till's own balance**, shown as "Balance at this till". No extra balance sync; B4 makes it business-wide. |
| 32 | Batch 2 reports | Approved: credit overrides, offline credit sales, sales by customer type, price changes (below-cost highlighted). |
| 33 | Receipt logo | On screen and PDF receipts only; thermal receipts print the business name in bold. |
| 34 | Removed devices (before production) | seiGEN keeps a list of removed devices and refuses their check-ins; the device sends its last vendor id; the app shows "Reset this device", offering a backup first. To be built before "go production". |
| 35 | B4 history (23 Oct) | On its first B4 check-in each till uploads its last 90 days of sales and money events, marked "history", for reports and the dashboard only; never posted to the books (decision 28). |
| 36 | B4 retention | Full sale detail kept 13 months on seiGEN; daily summaries per branch and till kept for good; books entries (Finance) kept for good. |
| 37 | Credit across the business | Balance = all synced credit sales − payments, business-wide. Online: seiGEN checks before the sale is committed (short timeout, then offline rule). Offline: decision 3, marked "checked offline". Two tills at once can't both use the same available credit. Receipts show "Balance (business)", or "(as of last sync)" offline. Replaces decision 31 once B4 is live. |
| 38 | Other branches' sales | In Report Writer only with "View other branches' reports" (Owner and Admin by default); costs and margins only with "View costs"; Cashiers see their own branch. |
| 39 | Older debts (23 Oct) | Each till sends one opening balance per customer, once, marked "balance before history"; seiGEN sums them across tills; never posted to the books. |
| 40 | Another branch's customer notice | Keep the notice and its rules (cash once per customer per till; credit every time with the Admin passcode). Drop only the "this till's balance" sentence when the business balance is available; keep it offline. |
| 41 | Data gaps for Finance | A separate step before F-1 (not built yet): weighted-average cost (logic change, before/after comparison for owner approval); payment method + reference on credit payments; account + approver on payouts; EOD counted per currency; a currency code (USD/ZiG). |
| 42 | Weighted-average cost rules (23 Oct) | WAC per product per stock holder (till or seat). Supplier GRV: (old qty × old WAC + received qty × cost) ÷ total; if old qty ≤ 0, WAC = the received cost. Dispatch → GRV moves at the sender's WAC, plus the transport charge added to the received cost (spread by value). Internal transfer at the sender's WAC. Sales, adjustments, write-offs and stocktake at the current WAC. Returns at the original sale's cost. Opening WAC at go-live = the current last landed cost; no history recalculated. Shadow mode first (both costs recorded, comparison report); switching reports and margins to WAC needs the owner's "approved". |
| 43 | Payment and payout fields | Credit payments: method required (cash / EcoCash / bank / card); reference required for EcoCash and bank. Payouts: account required (from the payout chart of accounts); who made it and who approved it recorded. End of Day: expected and counted cash per currency. Old records stay readable, with the fields empty. |
| 44 | Currency code | Every business has a base currency code (USD; ZiG stored as ZWG, shown as "ZiG"); every money event carries its code; the owner-set rate stays the rate used. |
| 45 | Payout accounts (23 Oct) | A fixed built-in list, the same on every till, not editable until F-1 maps it to the chart of accounts: Transport & fuel · Stock bought with till cash · Wages & casual labour · Rent & utilities · Repairs & maintenance · Cleaning & shop supplies · Food & refreshments · Owner drawings · Other (reason required). The reason box stays; old payouts show "Unassigned". |
| 46 | Base currency code for existing businesses (23 Oct) | Derived from the symbol: "$", "US$", "USD" → USD; "ZiG", "ZWG", "ZWL" → ZWG (shown as ZiG). Otherwise Owner/Admin picks it in Settings, and events send the code empty until then. New businesses pick it at setup. |
| 47 | Credit payments at End of Day (23 Oct) | Unchanged in v36: expected cash still leaves out credit payments, whatever the method. The method is recorded, printed and synced only. Revisit in F-1. |
| 48 | Role is authoritative (27 Oct) | For every person on every device (tills and Office seats), the **role decides** what they can see and do, and **seiGEN checks the signed-in person's role on the server** for every protected call, tills included (security item B2 moved into Fix-A). Office seats get **every menu the role allows** (Finance, reports, stock, dispatch, GRV, approvals, staff and so on), **except selling, cash and End of Day, which stay on tills** (decision 16 kept). |
| 49 | Guest role | A new **built-in "Guest" role**: **view only** stock balances and **selling prices (retail and wholesale) at all branches**. Never costs, margins, customers, sales, money, documents or settings. **Signs in only on an Office seat** (refused on tills); each Guest device is an Office seat **billed $3 per 30 days**. Owner or Admin may set an **optional end date** when adding a Guest; access stops automatically then (no end date = until removed). Guests can't be given extra rights: a role with more rights is a different role. |
| 50 | RPN link locked (27 Oct) | After onboarding, the shop **can't change** its RPN link or the RPN's details: Settings shows them read-only, with "To change your RPN, contact Digital Commerce". Only Console staff with a permission can change it; every change is logged; seiGEN enforces it. |
| 51 | Stock control batch: order | Built **after Fix-A (v36) and before F-0**: Stock control = v37, F-0 = v38. |
| 52 | Cycle stocktake | A **"Count now" tab** on Stocktake: a daily short list chosen by risk (A/B/C by value and speed: weekly / monthly / quarterly; red flags: negative stock, a past difference, many voids or returns, a sale while showing 0, big adjustments; not counted for too long). **Shelf/location per product per branch** (optional; lists group by shelf). **Blind counts** (the counter never sees the expected quantity). **Every difference needs Manager approval** before stock changes; the Manager may ask for a recount by another person. **Shrinkage report:** losses by item, shelf, branch, shift and staff on duty, with trends. |
| 53 | Stock requests from branches | The Stock Requisition from the Branches plan (B3): a branch requests items from main; staff with **"Review stock requests"** get a notification, a list and a report; they approve all, part or reject with a reason; an approved request becomes a **draft DN at main**, then the normal DN → GRV flow, linked from request to DN to GRV. |
| 54 | Recall from branches | Main issues a **recall** (items, quantities, reason, due date); the branch dispatches the stock back with a normal DN and main receives it with a GRV. The branch can mark items short, with a reason. Overdue recalls are flagged. **Main pays the transport.** New right **"Recall stock"** (Owner, Admin and Manager by default). |
| 55 | Notification bell (27 Oct) | A **bell in the header** on every device, with an unread count **per person**. Shows, by role: **Market feed** (seiGEN broadcasts; replaces the separate marketing-message flag of decision 12), **iTred sales orders**, **stock requests**, **recalls**, **count differences waiting for approval**, and **incoming DN/GRV**. **A short chime** for each new notification (no repeats for the same event), with sound on/off per person and per category in Settings → Notifications. Titles only. New items checked at least every 60 s while the app is open and online. Phone/PC notifications while running (decision 8 Level 1); push when closed stays Level 2. Built in v37 with Stock control. |

### Books + Cash Flow rights (approved; journals and month-close added 22 Oct)
| Right | Owner | Admin | Manager | Bookkeeper | Stores | Cashier |
|---|---|---|---|---|---|---|
| View Working Capital | all branches | all branches | own branch | all branches | – | – |
| Manage collections | ✓ | ✓ | ✓ | ✓ | – | – |
| Prepare supplier payments | ✓ | ✓ | ✓ | ✓ | – | – |
| Approve supplier payments | ✓ | ✓ | up to $200 | – | – | – |
| Record payments | ✓ | ✓ | ✓ | ✓ | – | – |
| Edit forecast | ✓ | ✓ | ✓ | ✓ | – | – |
| Approve forecast | ✓ | ✓ | – | – | – | – |
| Use reserve for other purposes | ✓ | ✓ | – | – | – | – |
| Reserve policy | ✓ | – | – | – | – | – |
| Credit limits and terms | ✓ | ✓ | request | request | – | – |
| View books (TB, P&L, BS, GL) | ✓ | ✓ | own branch P&L | ✓ | – | – |
| Prepare manual journals | ✓ | ✓ | – | ✓ | – | – |
| Approve manual journals | ✓ | ✓ | – | – | – | – |
| Bank matching | ✓ | ✓ | – | ✓ | – | – |
| Close and lock a month | ✓ | ✓ | – | – | – | – |

**What each role sees:**
- **Bookkeeper:** the figures, but payroll only as totals.
- **Stores:** supplier terms and the stock to reorder.
- **Cashier:** only the customer's available credit, at the till.

**Rules:**
- The preparer can't approve their own payment. Exception: a solo shop, where it is allowed and flagged.
- Every override needs a reason and is logged.
- seiGEN checks the rights on the server.

**Build rule:** follow the real codebase, not any spec's technical section: no React, no WAL (the database runs in the browser), polling instead of Realtime. Money is held in cents, and USD and ZiG are kept separately.

## Report Writer additions (proposed, awaiting owner confirmation)
Each report follows the rights above and supports any-order search, PDF, Excel and WhatsApp share. **Finance** shows the live screens; **Report Writer** holds the printable and exportable versions of the same figures.

| Batch | Reports |
|---|---|
| Batch 2 | credit limit overrides, offline credit sales, sales by customer type, price changes (below-cost changes highlighted) — **approved 22 Oct (item 32)** |
| Batch 3–4 | orders fulfilment (self-verified orders flagged), iTred payments (proof submitted vs. verified) |
| v32 follow-up | internal transfers (seat ↔ tills) |
| F-1 | trial balance, P&L, balance sheet, general ledger, cash book, debtors ageing, customer statement, creditors ageing, supplier statement, payments due, cash position, bank deposits and transfers, COGS Reserve, reserve misuse, expenses by account, cash-flow forecast, approvals log |
| Later | forecast scenarios, collection performance, supplier and customer scorecards, purchase orders vs. deliveries, market intelligence |

## Standing rules
- Inspect first, follow `docs/CODING-AGENT-PROTOCOL.md`, report with evidence.
- Live database: backup, the final SQL, then the owner's "apply". **Commit before asking for "apply" and before every deploy.**
- **Never chain an apply after a commit with ";"** (22 Oct 2026): if the commit fails, stop.
- Previews only, unless the owner says "go production".
- Rebuild the bundles before tests, commits and deploys; the freshness check enforces this.
- No secrets or personal data in commits or reports. The repo is public.
- One Claude Code session at a time. Stop a runaway process by its PID.
- **No silent logic changes (21 Oct 2026):** never change, remove, bypass or weaken existing logic (business rules, calculations, validations, rights and server checks, sign-in, sync and offline, licensing and billing, receipts, defaults, screen flows, features) without telling the owner first (what, where, today vs. proposed, why, impact, alternatives) and getting an explicit "approved". Tests may get timing or setup fixes, but expected business outcomes change only with approval. Every report has a "Logic changes" section, or "None".
