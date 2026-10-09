# RPN ↔ vendor link and RPN commissions: Stage A design

Status: **design only, nothing built.** Waiting for "go RPN-B".
Date: 2026-10-09. Every fact below was read from the repo (file:line) or from live (read-only). No personal data is in this document: names only.

---

## A1. What exists today (VERIFIED)

### RPN records

- **Table `cl_rpn`** (supabase/migrations/20260923000000_baseline.sql:189). Columns:
  - `id`, `full_name` (unique, case-insensitive);
  - `phone`, `city`;
  - `passcode_hash` (bcrypt);
  - `verification_code` (**plain text**, unique; a one-time code);
  - `verification_used`, `active`;
  - `created_at`, `created_by`.
- **There is no field force number column anywhere** (repo, Console and live searched). The app's setup has a free-text "RPN code" field with the placeholder "RPN-014" (src/rpn.js:64-65), which looks like the intended format.
- **Live:**
  - 2 RPNs, both active: Lovemore Nyamutsamba (activated) and Amanda (code not yet used);
  - **0 of 35 vendors have an RPN** (`cl_vendors.rpn_id`);
  - 0 onboarding notes.
- **How an RPN is created** (Console → RPN Directory → "+ New RPN" → `cl_create_rpn`, baseline:282):
  - only staff with the `rpn_directory` module, or a SysAdmin;
  - the staff member types a verification code (Console index.html:2963).
- **How an RPN activates:** on the Console sign-in page's "Activate RPN Desk" tab, they enter their name, that code and a new passcode (`cl_rpn_activate`, baseline:533; Console index.html:766, 879).
- **RPNs are not staff.** `cl_login` (baseline:700-760) tries staff first, then RPN, and signs a 12-hour token with `user_type: 'rpn'`, `sub = cl_rpn.id`.
  - In the Console, an RPN sees only the Vendors module (Console index.html:938-939).
  - In the Field Guide, they send onboarding notes (`rpn_onboarding_notes`, 20261003120000).
- **"Suspended"** today is just `active = false`. `cl_login` refuses inactive RPNs, but a token already issued lasts up to 12 hours.

### Any RPN ↔ vendor link

| Piece | Real or planned |
|---|---|
| `cl_vendors.rpn_id` → `cl_rpn` (baseline:957, ON DELETE NO ACTION) | **Real**, but empty on live |
| Console "New vendor" form sets `rpn_id` (index.html:2947); Vendors Register shows an "RPN" column (index.html:1293) | **Real** |
| Vendors Register **filter** by RPN | **Not there** |
| RPN Directory: each RPN's vendor portfolio | **Not there**. It lists RPNs, phone, status and verification code (index.html:1909) |
| `cl_device_checkin(p_rpn_hint_id uuid)`: sets `rpn_id` if empty (20261008140000) | **Real but unused**: the app always sends `null` (src/devicecheckin.js:120) |
| `rpn_onboarding_notes.rpn_id` + `cl_onboarding_note_to_vendor` (fills a blank `rpn_id`) | **Real**, 0 rows |
| App's RPN fields: name, code, WhatsApp, city (setup step 3, src/setup.js:65-67; More → Settings, src/settings.js:79) | **Real but local only.** Stored in settings, never sent: the `rpn_link` sync type is paused (src/rpn.js:19). Used for the Support WhatsApp button. |
| `cl_businesses` RPN column | **None** |

### Commerce Lite flows (where an RPN could enter details)

- **First-run setup step 3** "RPN": optional free text (src/setup.js:63-70).
  - Its heading says "Reseller Partner Network". The right name is **Revenue Partner Network**; to be fixed.
- **More → Settings → RPN section** (`rpnSectionHtml`, src/rpn.js:78); Support → WhatsApp to the RPN (src/rpn.js:98-123).
- **More → About** (src/activation.js:522): plan, licence, build.
- **There is no `dc-registration` or `rpn-support-modal` as named files.** The equivalents are `devicecheckin.js` (registration and check-in) and the Support section in rpn.js.
- **Getting data to the server:**
  - `cl_device_checkin` (install ID, phrase, device key) on start and on resume;
  - the `sync.js` outbox (`enqueueSync`, src/sync.js:104; worker :183). RPN link types are paused.
  - The licence and terms calls are phrase-checked device RPCs built on `cl_install_vendor`, the same pattern used here.

### The ledger payment path (where commission hooks in)

- **`cl_record_ledger_payment`** (live body: 20261012120000:184-230):
  - who: Collections Ledger or Billing & Reminders, or SysAdmin;
  - inserts the `payment` ledger row, then a Cashbook `in` (`source_type 'ledger_payment'`, on the chosen account), then an activity log entry;
  - **30-second duplicate guard** with a transaction lock: an identical repeat gets back the first row and writes nothing.
- **`cl_reverse_ledger_payment`** (20261012120000:168ff):
  - inserts a `payment_reversal` ledger row (`reverses_entry_id`) and a Cashbook `out` (`ledger_payment_reversal`);
  - one reversal per payment.
- **`cl_record_ledger_credit`:** a `credit` row with no cash.
- **Licence charges** (price plans, 20261013120000:649-651) go to **each till's own vendor row**. A business's tills are added up in the Console (`cl_plan_accounts`).

### Payouts and the Cashbook

- **Check Writer** (`cl_payment_vouchers`, maker-checker): when a voucher is marked paid, `cl_mark_voucher_paid` (baseline:446-461) posts a Cashbook `out` **on the paying account** (`source_type 'voucher'`). The expense lines are on the voucher.
- **Cashbook `source_type` values in code:** `ledger_payment`, `ledger_payment_reversal`, `voucher`, `manual`. Live is empty since the reset.
- **Chart of accounts:** it has **5100 Commissions Paid** (expense). The paying accounts are 1000 Cash on Hand, 1100 Bank and 1200 Ecocash LN.
- **There is no RPN payout feature.** The one RPN commission ever paid (5.00, "RPN-0403 L Nyamutsamba") was a manual Cashbook entry, now cleared by the reset.

### The parked migration 20260926160000 (VERIFIED, not applied)

It touches only the old Publish Portal's `vendor_tokens` table (live: the table exists with 0 rows; no `rpn_id` column):
1. adds `vendor_tokens.rpn_id` → `cl_rpn`, "the RPN a payment is credited to";
2. adds a trigger making new tokens carry an amount, currency and method.

- **Overlap:** the same idea as here, crediting an RPN per payment, but on the portal's own token table, outside the ledger.
- **Conflict:** commissions here are earned on **Collections Ledger payments**. Token money that bypassed the ledger would earn nothing, or would be counted twice.
- **Recommendation: retire 20260926160000.** Market publishing (the next prompt) puts token sales through the ledger, so this hook covers them. Nothing copied from it.

### Security findings that matter once vendors have RPNs

1. **`cl_vendors_select` lets a signed-in RPN read every column of "their" vendors, including `shop_secret_phrase` and `device_key`** (baseline:1054-1055). Row-level security limits rows, not columns, and `authenticated` has table-wide SELECT.
   - Harmless today: 0 vendors are linked.
   - **It would expose the phrase the moment linking starts.** Fix in this migration (B1 below).
2. **`cl_rpn_update_self` lets an RPN update any column of their own row** (baseline:1033-1035): `active`, `verification_code`, and the new PIN or field force number once added. Nothing uses it: the Field Guide only calls `cl_login` and `rpn_onboarding_notes` (src/fieldguide/console-api.js:59, 91, 105). Fix: drop it.

---

## A2. Design

### 1. Linking a vendor to an RPN in the app

**What the RPN enters: field force number + 6-digit RPN PIN.**
- **Field force number:**
  - new `cl_rpn.field_force_no`, unique, e.g. `RPN-014`;
  - set by staff in the RPN Directory;
  - printed on the RPN's card.
- **RPN PIN:**
  - new `cl_rpn.link_pin_hash` (bcrypt);
  - set by staff, or by the RPN on the Activate RPN Desk;
  - **separate from their Console passcode**, so the RPN never types their sign-in passcode on a vendor's phone.
- A vendor can't just type any RPN number: without the PIN, the link is refused.

**Where in the app:**
- **Setup step 3** keeps its optional fields, plus **"Field force number"** and **"RPN PIN"**.
- **"Add later" is allowed:** More → Settings → RPN shows **"Link your RPN"** while there is no verified link. It disappears once verified. Changing RPN after that is a staff action in the Console.
- **More → About** shows **"Onboarded by: <RPN name> (RPN-014)"**, read-only. The name comes back from the server.
- The free-text name, WhatsApp and city fields stay for the Support button.

**Transport (offline-first):**
- The pair is saved on the device and sent with a **new phone-checked device RPC**: `cl_device_link_rpn(p_install_id, p_shop_secret_phrase, p_device_key, p_field_force_no, p_pin)`.
  - It uses the same check as the licence calls: `cl_install_vendor` (install ID + phrase + device key).
  - It's tried right away when online, otherwise at the next successful check-in.
- **The PIN is kept only until the server answers, then deleted from the device.**
- **The answer** is stored in settings (`rpn_link_status`, `rpn_link_name`, `rpn_link_error`). The check-in response also returns the linked RPN's name, so About stays right on every till.

**Server rules:**
- Wrong PIN and unknown field force number get **the same answer**, so numbers can't be guessed.
- **Rate limit:** 5 failed tries per install per hour, logged in a `cl_rpn_link_failures` table (like `cl_licence_redeem_failures`).

**Plain messages in the app:**

| Case | Message |
|---|---|
| Unknown number or wrong PIN | "That field force number and PIN don't match. Check them with your RPN." |
| Suspended RPN | "That RPN isn't active at the moment. Ask Digital Commerce." |
| Too many tries | "Too many tries. Wait an hour, or ask Digital Commerce." |
| Offline | "Saved. It will be checked when you're online." |
| Not registered yet (no phrase) | "Finish registering this device first (More → Settings → activation phrase)." |
| Business already has a different RPN | "This business already has an RPN. Digital Commerce will check it." The conflict goes to staff (below). |

### 2. Console side

**Where the link lives:**
- A business with tills is linked **on the business**: new `cl_businesses.rpn_id`.
- A single device with no business is linked on `cl_vendors.rpn_id`, which already exists.
- **The effective RPN of a vendor row** = its business's RPN if it belongs to a business, else its own.
- **One RPN per business:** the first till that links sets it.
  - A later till entering the **same** RPN is fine.
  - A later till entering a **different** RPN does **not** change it. It creates a **conflict** for staff.

**Assignment history: new `cl_rpn_assignments`.**
- Columns:
  - `vendor_id` or `business_id`;
  - `rpn_id` (null = removed), `previous_rpn_id`;
  - `source`: `app`, `console`, `onboarding_note` or `register_form`;
  - `status`: `applied` or `conflict`;
  - `reason`, `by_staff`, `by_install`, `created_at`.
- **A trigger on `cl_vendors.rpn_id` and `cl_businesses.rpn_id` writes a history row for every change, whatever path made it.** That includes the existing "New vendor" form and the onboarding-note action, so nothing escapes the history.

**Staff actions:**
- **`cl_assign_rpn(p_business_id | p_vendor_id, p_rpn_id | null, p_reason)`:** assign, reassign or remove, with a reason.
  - Who: the Vendors Register **or** RPN Directory module, or a SysAdmin.
  - Logged.
- **`cl_resolve_rpn_conflict(p_assignment_id, p_accept boolean, p_reason)`.**

**Console screens:**
- **Vendors Register:** an **RPN filter** (All / Unassigned / each RPN), and conflicts shown with a badge. The vendor card shows the RPN, how it was linked, and the history, with **Reassign RPN**.
- **RPN Directory:**
  - each RPN's **field force number**;
  - **"Set PIN"** (a generated 6-digit PIN, shown once);
  - **Suspend / Reactivate**: a reason, logged; it sets `active`;
  - a **portfolio** (their vendors and businesses).

### 3. Commission rates (SysAdmin only)

**`cl_rpn_commission_rates`:**
- `id`;
- `onboarding_pct`, `recurring_pct`: numeric(5,2), 0–100;
- `effective_from`, `set_by`, `note`, `created_at`.

**Rules:**
- Seeded **empty: no rate**. You set the real rates in the Console.
- The rate in effect at the **payment's time** is snapshotted on each commission line, so later changes never touch earlier lines.
- Like price plans: `cl_rpn_rate_set(...)` (SysAdmin only), `cl_rpn_rates_list()`, with history.
- **While no rate is set,** payments still create commission lines **at 0%, marked "no rate set"**. The RPN statement then shows every payment, and you see what was missed (question 5).

### 4. Accrual (server-side, same transaction as the payment)

**The hook: an AFTER INSERT trigger on `cl_ledger_entries`** for `entry_type in ('payment', 'payment_reversal')`.
- **Every way a payment can be recorded earns commission once.** That covers `cl_record_ledger_payment` today and token sales tomorrow (market publishing). **No payment function is changed, and no logic is duplicated.**
- The 30-second duplicate guard returns the first row without inserting, so the trigger doesn't fire twice. `unique (ledger_entry_id)` on the commission line is the backstop.

**On a payment:**
1. Find the **account**: the vendor's business if any, else the vendor.
2. Find the account's **effective RPN at that moment**.
   - **No RPN, or an inactive RPN: no line.** The Console's payment detail says "No commission: no RPN" or "… RPN inactive".
3. **Kind:**
   - `onboarding` if the account has **no earlier payment that still stands**, meaning not reversed, counting all its tills;
   - otherwise `recurring`.
4. Insert into **`cl_rpn_commissions`**:
   - `rpn_id`, `vendor_id`, `business_id`, `ledger_entry_id`, `kind`;
   - `base_amount`, `currency` (the payment's currency);
   - `rate_id`, `rate_pct` (snapshot), `amount` (rounded to cents);
   - `created_at`.

**On a payment reversal:** a **negative line** of the same kind, `reverses_commission_id` → the original line, for the same RPN and rate as the original, even if the vendor has since moved to another RPN.

**After reversing the onboarding payment:** the next payment counts as **onboarding again**, because the first payment never really happened (question 3).

**Who earns after a reassignment:** **the RPN linked at the time of each payment.** Earlier lines stay with the old RPN.

**Credits don't affect commission:** they reduce charges, not money received. The trigger ignores `charge` and `credit` rows.

### 5. Payouts

**`cl_rpn_payouts`:**
- `id`, `rpn_id`, `amount`, `currency`;
- `paying_account_id` (Cash, Bank or Ecocash), `expense_account_id` (5100 Commissions Paid);
- `cashbook_entry_id`, `reference`, `notes`;
- `paid_by`, `created_at`, `reverses_payout_id`.

**Paying: `cl_pay_rpn_commission(p_rpn_id, p_amount, p_currency, p_paying_account_id, p_reference, p_notes)`:**
- refused above what is **due** in that currency;
- posts a Cashbook **`out`** on the paying account with `source_type 'rpn_commission_payout'`. That is the same shape as a Check Writer voucher: Cashbook out on the paying account, expense account on the record;
- same 30-second duplicate guard and transaction lock as payments;
- logged.

**Reversing a payout made in error: `cl_reverse_rpn_payout(p_payout_id, p_reason)`.** A Cashbook `in` with `rpn_commission_payout_reversal`. One reversal per payout.

**Due per RPN and currency** = sum of commission lines − (payouts − reversed payouts).

**Check Writer is not used for payouts.** It's maker-checker for general expenses, and a payout is a fixed amount against a computed balance. A voucher can still be printed from the payout as a receipt (later).

### 6. The Console "RPN Commissions" screen

- **Summary per RPN:**
  - vendors;
  - earned (onboarding, recurring);
  - reversed;
  - paid;
  - **due**.
- **Filters:** RPN, city, date range.
- **Drill-down to lines:** date, **vendor or business name**, payment amount, kind, rate %, commission, or "reversed".
- **Actions:** **Pay commission** (amount defaults to due) and **Reverse payout**.
- **Export:**
  - **CSV**;
  - a **printable RPN statement** (a print-to-PDF page) with the period, lines, totals and payouts, to share on WhatsApp.
- **Commission rates card** (SysAdmin edits; others see the history).
- **Layout:** phone and desktop, with empty, loading and error states as on the other screens.

### 7. Permissions

The module system has whole modules, not sub-permissions (`cl_staff_module_access`), so:

| Action | Who (server-checked) |
|---|---|
| See commissions and statements | new module **`rpn_commissions`**, or SysAdmin |
| Pay or reverse payouts | new module **`rpn_payouts`**, or SysAdmin |
| Reassign RPN; resolve conflicts | existing **`vendors`** or **`rpn_directory`**, or SysAdmin |
| Field force number, PIN, suspend | existing **`rpn_directory`**, or SysAdmin |
| Commission rates | **SysAdmin only** |

### 8. The vendor-delete guard

- `cl_rpn_commissions` and `cl_rpn_assignments` reference vendors, businesses, RPNs and ledger entries with **ON DELETE RESTRICT**.
- The vendor and business delete-guard messages add "N commission lines".
- An RPN with commission lines or vendors can't be deleted. It's **suspended** instead (`active = false`), as today.

### 9. Security fixes in the same migration

- **Drop the RPN branch of `cl_vendors_select`,** so RPNs can't read vendor phrases or device keys. An RPN self-service view comes later as an RPC returning only safe columns.
- **Drop `cl_rpn_update_self`.** Nothing uses it.
- The PIN is stored hashed only. The field force number is not secret.

### 10. Existing vendors (all test)

Staff assign an RPN in the Console with **Reassign RPN** and a reason: "TEST" or the real one. Nothing is assigned automatically.

### 11. Tests (PGlite, plus the Console fake-server test, plus app tests)

**Linking:**
- An RPN entered in the app reaches the Console, both online and offline-then-synced.
- Wrong PIN, unknown number, suspended RPN and the rate limit are each refused with the plain message.
- A second till with a different RPN makes a conflict; staff resolve it.
- History is written for every path (app, Console, form, onboarding note).

**Commission:**
- The first payment gives onboarding at the onboarding %; later payments give recurring at the recurring %; multi-till accounts are counted once.
- A rate change applies only from its effective date, and old lines are unchanged.
- With no rate set, lines are 0% "no rate".
- A reversal gives a negative line, and the next payment is onboarding again.
- No RPN or an inactive RPN gives no line. Credits give no line.
- A duplicate payment tap gives one line.

**Payouts:**
- A payout reduces due and posts a Cashbook out; a payout above due is refused.
- A double tap pays once; reversing a payout brings due back.

**Permissions, deletes and security:**
- view, pay, reassign and rates are each refused for the wrong staff and for anonymous calls;
- deleting a vendor or RPN with lines is refused;
- an RPN token can't read `shop_secret_phrase`.

**Rollback** restores the exact catalogue. All existing database and app suites still pass.

**Risks:**
- **The trigger runs inside every payment.** A bug there would block recording payments. Kept small; covered by tests.
- **Changing `cl_vendors_select`** affects the Console when an RPN signs in: their Vendors screen becomes empty until the self-service view exists.

**Rollback:** drops the new tables, triggers, functions and columns, and restores the two policies byte for byte. It refuses if commission lines or payouts exist, as the earlier rollbacks did.

---

## Questions for you (each with a recommendation)

1. **What does the app ask the RPN for?** *Recommend:* field force number + a 6-digit RPN PIN, separate from their Console passcode. It can be added later in More → Settings until verified. After that, only staff change it.
2. **A vendor is reassigned: who earns from then on?** *Recommend:* the RPN linked **at the time of each payment**. Earlier commission stays with the old RPN.
3. **The onboarding payment is reversed: is the next payment onboarding again?** *Recommend:* yes. "First payment" means the first one that still stands.
4. **Can RPNs see their own vendors and commissions in the Field Guide?** *Recommend:* **later**, as a safe read-only RPC. Until then, staff share the printed statement.
5. **Payments made before you set rates:** keep them as 0% "no rate set" lines (recommended), or make no line at all? Either way, **an onboarding commission missed then can't be earned later**, so **set the rates before linking real vendors.**
6. **What should the rates be?** I won't assume. You set them in the Console after the build.
7. **Field force numbers:** what format, and who issues them? *Recommend:* staff type them in the RPN Directory, unique, e.g. "RPN-014". The two existing RPNs need one each before they can link vendors.
8. **Should "Suspend" also end the RPN's current 12-hour sign-in?** *Recommend:* not now. A suspended RPN earns nothing from that moment, and their sign-in expires within 12 hours.
9. **Retire the parked migration 20260926160000?** *Recommend:* yes, superseded by ledger-based commissions. I'd move it to `supabase/parked/` with a note, in a later commit, and only on your say-so.
10. **Wording:** setup step 3 says "Reseller Partner Network". Change it to **Revenue Partner Network**? *Recommend:* yes.

**STOP: waiting for "go RPN-B" and your answers.**
