# Post–build 29 upgrade: owner decisions and roadmap

**Source of truth for Claude Code.** Save it at `docs/decisions/post-build-29-decisions.md`. The owner (Lovemore) updates it. Where it conflicts with an older design doc, this file wins, unless the owner says otherwise in the task prompt. Last updated 21 Oct 2026.

## Status
| Build | What | State |
|---|---|---|
| v30 | Fix for the sign-in and branch-switch freeze | done, `2c67145` |
| v31 | Staff managers on every till | applied, `4a8b439` |
| v32 | Office seat by invite (migration `20261109120000_office_seats`) | applied, on the previews, `d92a690`; test fix `0b2d67b` |
| v33 | Roles fetch after register/join, visible Refresh, limited old-staff upload, Owner default, first-Owner log, internal-transfer error fix | in progress |
| next | Purge of test data | prompt ready |

## Roadmap (in order)
1. **Purge of the test data:** keep only Sysadmin.
2. **Batch 6A:** content protection in all apps, plus the Contact directory managed from the Console (items 9 and 10).
3. **Batch 2 (v34), selling and credit:**
   - items 1–4;
   - the receipt upgrade (business name, logo, address and phones; customer and operator; payment method and reference; credit before and after; a receipt message set in Settings; "powered by seiGEN Commerce" in small faint text);
   - credit-limit checks;
   - Sell speed for big shops (the product list held in memory, search waits for a pause in typing);
   - the remaining ~25 Admin passcode checks moved off the screen thread;
   - Batch 2 reports (below).
4. **B4:** sales sync (every sale, return, credit payment, payout, EOD cash; the cost at the time of sale; currency and exchange rate; payment method).
5. **Working Capital / Cash Flow WC-1** (items 17–25), then WC-2, WC-3, WC-4.
6. **Batch 3:** orders checkout and supervisor verification (items 5 and 5b).
7. **Batch 4, iTred:**
   - proof of payment (6), chat archive and delete-for-me (7);
   - hidden search keywords;
   - a search icon on Your Orders and Vendors;
   - remove "49 Brechin Est." from the iTred UI;
   - weak-signal speed and offline queued orders (13).
8. **Batch 5:** notifications (8), refresh at least every 60 s, the marketing-message flag (12).
9. **Batch 6B:** privacy and legal notices; the rule-based Seith helper on iTred Contact Us (11).
10. **Batch 7 (Console repo):** monthly document-review reminders.
11. **Office / business brain:** Seith prices (14), market intelligence (15), activity logs (B5).
12. **Books add-on** (double entry and payroll), then the **Qwen3 4B trial** (Windows .exe only).

**Production** comes as its own step, only on "go production", after the purge and the production checklist:
- a unique, hidden secret phrase per device;
- dropping old-code acceptance;
- a private repo;
- Supabase Pro;
- the domain.

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
| 19 | Packaging | Core Office feature for Business-plan shops. Lite gets a simple version (debtors and the reserve). |
| 20 | Order | After B4, Working Capital first; the double-entry books add-on follows, posting from the same synced documents. |
| 21 | Rights | Approved (table below), including a new built-in **Bookkeeper** role. |
| 22 | Manager approval limit | **$200 per supplier payment** by default; above that, Owner or Admin approves; each shop can change it. |
| 23 | Name and placement | **Office → Cash Flow**, hidden by rights. Sub-pages: Cash position, Cash-flow plan (13-week grid; 30-day daily and 12-month views), Debtors, Creditors, COGS Reserve, Alerts. 4 cash tiles on the Office Dashboard. The full grid is for a PC or Office seat; phones get a summary. |
| 24 | End of Day prompts | "Bank the takings" and "Fund the reserve" (today's stock cost sold), each needing confirmation. |
| 25 | Privacy from seiGEN | Console staff never see a shop's cash flow, debtors, creditors or books. Support access needs the shop's written permission. To be stated in the Privacy Policy. |

### Working Capital rights (approved)
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
Each report follows the rights above and supports any-order search, PDF, Excel and WhatsApp share. **Office → Cash Flow** shows the live screens; **Report Writer** holds the printable and exportable versions of the same figures.

| Batch | Reports |
|---|---|
| Batch 2 | credit limit overrides, offline credit sales, sales by customer type, price changes (below-cost changes highlighted) |
| Batch 3–4 | orders fulfilment (self-verified orders flagged), iTred payments (proof submitted vs. verified) |
| v32 follow-up | internal transfers (seat ↔ tills) |
| WC-1 | debtors ageing, customer statement, creditors ageing, supplier statement, payments due, cash position, bank deposits and transfers, COGS Reserve, reserve misuse, expenses by account, cash-flow forecast, approvals log |
| Later | forecast scenarios, collection performance, supplier and customer scorecards, purchase orders vs. deliveries, market intelligence |

## Standing rules
- Inspect first, follow `docs/CODING-AGENT-PROTOCOL.md`, report with evidence.
- Live database: backup, the final SQL, then the owner's "apply". **Commit before asking for "apply" and before every deploy.**
- Previews only, unless the owner says "go production".
- Rebuild the bundles before tests, commits and deploys; the freshness check enforces this.
- No secrets or personal data in commits or reports. The repo is public.
- One Claude Code session at a time. Stop a runaway process by its PID.
- **No silent logic changes (21 Oct 2026):** never change, remove, bypass or weaken existing logic (business rules, calculations, validations, rights and server checks, sign-in, sync and offline, licensing and billing, receipts, defaults, screen flows, features) without telling the owner first (what, where, today vs. proposed, why, impact, alternatives) and getting an explicit "approved". Tests may get timing or setup fixes, but expected business outcomes change only with approval. Every report has a "Logic changes" section, or "None".
