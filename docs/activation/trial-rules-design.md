# Trial rules: no anonymous trials (Stage A design)

Status: **Stage A, design only. Nothing has been built or applied.** Stage B starts on "go Trial-B".
Date: 2026-10-10. Branch: `activation-v2`.

## Owner decisions (2026-10-10)

These override activation-v2-design.md Q8 and Q11 where they differ.

1. **No anonymous trials.** The unsigned offline trial is removed.
2. **A trial is granted only at setup, and only when all three of these hold:**
   - the device is online and checks in;
   - an active RPN links the shop (field force number + PIN);
   - the owner's phone number (required) has never had a trial.
3. **One trial per phone number, ever.** Numbers are normalised before comparing.
4. **The server issues the trial as a signed Ed25519 licence** (30 days, marked as a trial). The app then trusts it offline.
5. **The Q8 rule stays:** restoring a backup whose business history is older than 30 days gives no trial.

Evidence labels in this document:
- **VERIFIED**: I read the code or ran a read-only query.
- **ASSUMED**: my inference; it needs confirming.
- **UNVERIFIED**: not checked.

---

## 1. What exists today (inspection)

### 1.1 The unsigned trial in the app (VERIFIED)

- **Where it's described:** [src/activation.js:8-10](../../src/activation.js#L8-L10). The trial is "30 days from the EARLIEST of: install date, first sale, first stock movement, first product created … Never signed."
- **`TRIAL_DAYS = 30`:** [activation.js:26](../../src/activation.js#L26).
- **The Q8 rule** ([activation.js:149-174](../../src/activation.js#L149-L174)):
  - `earliestBusinessDataMs()` takes the minimum of `sales.ts`, `stock_movements.ts`, `stock_received.ts`, `stock_adjustments.ts` and `products.created_ts`. It ignores anything before 2024.
  - `trialStartMs()` is the earlier of the install date and that minimum.
  - `trialEndMs()` is that start + 30 days.
- **Where it's created:** setup writes `install_date` with `trustedNow()`.
  - New shop: [src/setup.js:217-223](../../src/setup.js#L217-L223).
  - Joined till: [setup.js:127-132](../../src/setup.js#L127-L132).
  - Both also write `activated_until` with `_src = "setup"`. This is only a mirror for rolling back to v10; `licenceState` ignores it ([activation.js:215-219](../../src/activation.js#L215-L219)).
- **Where it's checked:** `licenceState()` ([activation.js:208-230](../../src/activation.js#L208-L230)).
  - The trial is one of three ways to be valid, alongside a licence and a legacy code ([activation.js:222](../../src/activation.js#L222)).
  - The status is `no_setup`, `ok` or `locked`. There is no "set up but never licensed" state.
- **Gating:**
  - `refreshLicenceLock()` / `licenceLocked()` ([activation.js:236-237](../../src/activation.js#L236-L237)).
  - Boot: [src/main.js:28-36](../../src/main.js#L28-L36).
  - Every render: [src/router.js:43-45](../../src/router.js#L43-L45).
  - The hourly and foreground re-check: [activation.js:358-367](../../src/activation.js#L358-L367).
  - The re-check after a restore: [src/backup.js:175](../../src/backup.js#L175).
  - A restore keeps the device's own identity, licence and `install_date` (`DEVICE_OWN_SETTINGS`, [backup.js:185-186](../../src/backup.js#L185-L186)).
- **What the trial says on screen:**
  - Lock reason: "Your 30-day free trial ended on …" ([activation.js:400](../../src/activation.js#L400)).
  - More → About: "Free trial until …" ([activation.js:527](../../src/activation.js#L527)).
  - Setup confirm step: "You get 30 days free use from today" ([setup.js:88](../../src/setup.js#L88)).

### 1.2 The lock screen (VERIFIED)

`renderLock()` ([activation.js:440-461](../../src/activation.js#L440-L461)) shows:
- the reason;
- the device code, WhatsApp/Call seiGEN and one "Licence or code" box;
- read-only Reports ([activation.js:507-521](../../src/activation.js#L507-L521));
- Download backup.

While locked, nothing else is reachable.

The cart has a **separate** gate that is not the licence: Digital Commerce's `dc_lock_cart` (`dcLockCartReason()`).
- It's checked at the cart button and in the cart drawer ([router.js:75](../../src/router.js#L75), [router.js:120](../../src/router.js#L120)) and on the desktop Sales screen ([src/desktop/sales-desktop.js:114](../../src/desktop/sales-desktop.js#L114), [:218](../../src/desktop/sales-desktop.js#L218)).
- Adding a product is gated the same way ([src/products.js:73](../../src/products.js#L73)).
- `completeSale()` ([src/pos.js:474](../../src/pos.js#L474)) has no gate of its own; only the UI gates it.

### 1.3 How setup collects the phone number today (VERIFIED)

- Step 2 has "Contact / WhatsApp number" ([setup.js:46-47](../../src/setup.js#L46-L47)). It is **optional**: not validated, and empty is accepted ([setup.js:169-178](../../src/setup.js#L169-L178)).
- It is saved as `contact_phone` ([setup.js:207](../../src/setup.js#L207)). It then:
  - prints on receipts ([src/printing.js:425](../../src/printing.js#L425), 578, 616);
  - goes to Marketing ([src/marketing.js:267](../../src/marketing.js#L267));
  - goes to the check-in as `p_phone` ([src/devicecheckin.js:117](../../src/devicecheckin.js#L117)).
- The check-in stores it in `cl_vendors.phone` and only ever overwrites it with a non-empty value ([20261008140000_shared_stock_checkin_lock.sql:74-84](../../supabase/migrations/20261008140000_shared_stock_checkin_lock.sql#L74-L84)).
- **There is no owner-phone field**, and nothing normalises numbers anywhere.
- **On live (read-only, VERIFIED today):**
  - 47 vendor rows. 22 have a phone, but only **9 distinct numbers** (test data reuses them).
  - Formats: 20 are `+2637xxxxxxxx` and 2 are `07xxxxxxxx`. Both formats are in use, so normalising matters.

### 1.4 Check-in, RPN link and licence issuing (VERIFIED)

**Check-in:** `cl_device_checkin` ([20261008140000…sql:49](../../supabase/migrations/20261008140000_shared_stock_checkin_lock.sql#L49)).
- It creates the `cl_vendors` row on first contact, through `cl_install_vendor(…, p_create=true)` ([20261004120000_multi_terminal_identity.sql:159-209](../../supabase/migrations/20261004120000_multi_terminal_identity.sql#L159-L209)).
- That function is the shared install ID + phrase + device key check that every device RPC uses.
- On the app side, setup calls `deviceCheckin()` *after* "Finish setup" ([setup.js:242](../../src/setup.js#L242)), fire-and-forget.
- After a successful check-in, the app:
  - pulls any pending licence (`licencePullPending`, only for a registered till: [devicecheckin.js:147-148](../../src/devicecheckin.js#L147-L148));
  - sends a waiting RPN link ([devicecheckin.js:150](../../src/devicecheckin.js#L150)).

**The business** (`cl_businesses`) is **not** created at setup. It is created later by Settings → Business & Terminals → register (`cl_branch_register`, [20261004180000…sql:117-152](../../supabase/migrations/20261004180000_multi_terminal_phase2.sql#L117-L152)), or reached by joining with a join code (`cl_terminal_join`). So at setup time a new shop is a vendor row only.

**RPN link:** `cl_device_link_rpn` ([20261015120000_rpn_commissions.sql:157-200](../../supabase/migrations/20261015120000_rpn_commissions.sql#L157-L200)).
- It checks the field force number and PIN (bcrypt), with 5 failures per install per hour.
- If the RPN is suspended it answers `RPN_SUSPENDED`.
- It links the business's RPN (or the device's), and raises `RPN_CONFLICT` if another RPN is already there.
- In setup, the RPN step is **optional** ([setup.js:65-70](../../src/setup.js#L65-L70)). The pair waits in settings and is sent after check-in ([src/rpn.js:94-150](../../src/rpn.js#L94-L150)).
- On live: 2 RPNs, both active, both with a field force number, but **only 1 has a PIN**.

**Licences:** the `issue-licence` Edge Function ([supabase/functions/issue-licence/handler.mjs:40-45](../../supabase/functions/issue-licence/handler.mjs#L40-L45)) is **staff-only**. It refuses no token and any non-staff token, and never uses the service-role key.
- It calls `cl_licence_prepare`, which:
  - builds the payload in SQL ([20261013120000_price_plans.sql:492-620](../../supabase/migrations/20261013120000_price_plans.sql#L492-L620));
  - prices it with the price plan.
- Then it calls `cl_licence_attach` ([price_plans.sql:624-670](../../supabase/migrations/20261013120000_price_plans.sql#L624-L670)), which:
  - requires the same staff member who prepared it;
  - **posts a ledger charge** when the amount is above 0.
- `cl_licences.issued_by` is `not null references cl_staff` ([20261010120000_activation_licences.sql:76](../../supabase/migrations/20261010120000_activation_licences.sql#L76)), and `days in (30, 90, 365)` ([:68](../../supabase/migrations/20261010120000_activation_licences.sql#L68)).
- Devices get licences in two ways:
  - `cl_licence_redeem` (short code);
  - `cl_licence_pending` (the latest licence issued for this install, at check-in) ([activation_licences.sql:358-410](../../supabase/migrations/20261010120000_activation_licences.sql#L358-L410)).
- **Payload flags byte** (byte 27):
  - bit 1 = strong binding;
  - bit 2 = business ID attached ([activation.js:104](../../src/activation.js#L104)).
  - Other bits are ignored by today's app.

### 1.5 What `cl_vendor_repeat_installs` detects (VERIFIED)

[activation_licences.sql:339-356](../../supabase/migrations/20261010120000_activation_licences.sql#L339-L356):
- **What it does:** groups `cl_vendors` by normalised shop secret phrase and lists groups with more than one install (install IDs, business names, first and last install).
- **Where it shows:** Console → Activation Codes → "Possible reinstalls" tab (SCL Console `index.html:1511`, 1696-1724).
- **What it doesn't see:**
  - phone numbers;
  - RPNs;
  - devices that never check in.

### 1.6 Commission (VERIFIED)

The accrual trigger fires only on `cl_ledger_entries` rows of type `payment` / `payment_reversal` ([rpn_commissions.sql:468-469](../../supabase/migrations/20261015120000_rpn_commissions.sql#L468-L469)).

---

## 2. The design

### 2.1 Setup flow (new shop)

| Step | Today | New |
|---|---|---|
| 1 | Shop, branch, phrase, Main/Remote/Join | unchanged |
| 2 | Contact (optional), currency, logo | **Owner's phone (required)**, contact for receipts (optional; defaults to the owner's phone), currency, logo |
| 3 | RPN (optional) | **RPN field force number + PIN, typed by the RPN.** Can be skipped, but then no trial: "Without your RPN there's no free trial. You can add products now; selling starts with a licence." |
| 4 | Confirm → Finish | Confirm → **Finish** saves the shop locally (as today), then **starts the free trial**, which: (a) needs the internet; (b) checks in (registers the device); (c) asks seiGEN for the trial (§2.3); (d) stores the signed licence |
| 5 | none | **Result screen.** Success: "Your free trial runs until 9 Nov 2026." Refusal: the plain message, plus **Try again** and **Continue without the trial** (products and stock only, §2.2) |

- **Owner's phone:**
  - It is checked as it's typed. Zimbabwe mobiles are accepted in any common shape (`07x…`, `+263 7x…`, `2637x…`, `002637x…`), and so is any other number written with its `+country` code.
  - It is stored in a new setting, `owner_phone`.
  - `contact_phone` keeps its receipt and marketing role. ASSUMED: owners want the shop's number on receipts, not necessarily their own.
- **The trial can also be started later,** from:
  - a "Start your free trial" banner on every screen during the pre-trial state;
  - More → About.

  Both use the same form: owner's phone (prefilled) and RPN number + PIN (typed by the RPN).
- **Joined till** (Join with a code): joining already needs the internet. Right after joining, the till asks for **cover** (§2.4) with no phone and no RPN.

**Refusal messages** (plain; one per server code):

| Code | Message |
|---|---|
| (app) offline | "Connect to the internet to start your free trial." |
| (app) no RPN entered | "Your RPN types their field force number and PIN here to start your free trial." |
| `RPN_NO_MATCH` | existing: "That field force number and PIN don't match. Check them with your RPN." |
| `RPN_TOO_MANY_TRIES` | existing: "Too many tries. Wait an hour, or ask Digital Commerce." |
| `RPN_SUSPENDED` | "That RPN isn't active at the moment, so the free trial can't start. Ask Digital Commerce." |
| `RPN_CONFLICT` | existing: "This business already has an RPN. Digital Commerce will check it." |
| `PHONE_INVALID` | "Enter the owner's phone number, e.g. 07x xxx xxxx or +263 7x xxx xxxx." |
| `PHONE_USED` | "This phone number has already used its free trial. Ask your RPN about a licence." |
| `TRIAL_OLD_DATA` | "This shop has sales from 3 Aug 2026, more than 30 days ago, so a free trial can't start. Ask your RPN about a licence." |
| `BUSINESS_TRIAL_ENDED` (joined till) | "This business's free trial ended on 9 Nov 2026. Ask your RPN about a licence for this till." |
| `NO_BUSINESS_TRIAL` (joined till) | "Your main branch hasn't started its free trial yet. Start it on the main till first." |
| check-in refused | the existing `dcCheckinProblemText()` messages ([devicecheckin.js:182-192](../../src/devicecheckin.js#L182-L192)) |
| anything else | "seiGEN couldn't start the trial right now. Try again in a minute." |

### 2.2 Before the trial or a licence: what's allowed (recommendation)

**I recommend your leaning:** setup and preparation are allowed; trading is locked. This needs a new app state, `pretrial`: set up, and never had a licence, trial or legacy code on this device. It is not the lock screen; the app opens normally.

| Allowed | Locked (with the banner "Start your free trial to sell") |
|---|---|
| Products: add, edit, import, prices, photos | Cart and checkout (all payment methods), held sales |
| Stock in: supplier GRV, receive, stocktake, adjustments | Returns and refunds |
| Settings, staff and PINs, terminals and join codes, RPN, backup and restore | Receipts and reprints, End of Day, credit payments |
| Help, About | Reports (there is nothing to report yet) |
| | Dispatch out to branches, market publishing |

- **How:** the same gates as `dcLockCartReason()` (cart button, drawer, desktop Sales), plus a guard **inside `completeSale()`** as belt and braces, since today only the UI gates it.
- **After a trial or licence ends:** the state is `locked`, and the lock screen behaves as today. The lock screen also gets the "Start your free trial" form when this device has never had a trial; that covers an upgraded test install.

### 2.3 The server: granting a trial

**Signing.** A device can't call `issue-licence`, which is staff-only by design, and the private key must never sit in the database. **I recommend a sibling Edge Function, `issue-trial`,** rather than changing `issue-licence`:
- the staff path stays exactly as it is and tested;
- the trial path has its own, smaller attack surface.

It shares the `LICENCE_SIGNING_KEY` / `LICENCE_KEY_ID` secrets, which are project-wide.

```
app ──POST issue-trial {install_id, phrase, device_key, owner_phone, ff, pin, earliest_sale}   (anon key)
  issue-trial ──rpc cl_trial_request(...)            (anon key = device-authenticated, ONE transaction)
              ◄─ {payload_hex, serial} | {error code}
  issue-trial  signs the payload, verifies its own signature with the public key
  issue-trial ──rpc cl_trial_attach(serial, sig)     (service-role key: execute granted to service_role ONLY)
  ◄─ {licence "SL2.…", valid_to}
app  applyLicence(licence, "trial")  →  works offline from here on
```

**`cl_trial_request`** (device RPC, `security definer`, one transaction):

1. **Device check:** `cl_install_vendor(install, phrase, device_key, false)`. The device must have checked in, and it must have a device key, so the licence binding is strong.
2. **Rate limits** (failures kept as answers, like `cl_device_link_rpn`):
   - 5 per install per hour (shared with the RPN link);
   - **new:** 10 per field force number per hour across all installs, which closes PIN guessing by reinstalling;
   - **new:** 5 per normalised phone per hour.
3. **Idempotent first:** if this install already has a trial, return the same one. That is the pending payload if it isn't signed yet, or the signed licence. It is never a second trial.
4. **Joined till** (its vendor belongs to a business that already has a trial): go to cover (§2.4). No phone or RPN is needed.
5. **Phone:** `cl_norm_phone(p_phone)` → `PHONE_INVALID` if it doesn't parse.
6. **RPN:** the field force number + PIN check and the active check, with the same logic and messages as `cl_device_link_rpn`. Then link the shop if it isn't linked; a different RPN already on it → `RPN_CONFLICT`.
7. **Q8 (§2.6):** `p_earliest_sale` more than 30 days ago → `TRIAL_OLD_DATA`.
8. **One per phone:** a trial row with this normalised phone already exists → `PHONE_USED`, unless an unused SysAdmin exception for this phone or install exists (§2.7).
9. **One per business:** this vendor's business (`cl_vendor_business()`) already had a trial → `PHONE_USED`-style refusal with the business wording.
10. **Record and prepare:**
    - insert into `cl_trials` (phone_norm, vendor_id, install_id, rpn_id, business at the time, started_on, ends_on = today + 30, kind = 'standard' | 'exception', exception_id, flags);
    - insert into `cl_licences` (kind = 'trial', trial_id, issued_by = null, amount 0, **no ledger entry**) with the payload. Payload flags: **new bit 4 = trial**.
11. **Every refusal** in steps 5-9 inserts into `cl_trial_refusals` (install, vendor, phone_norm, rpn_id when known, code, ts).

**`cl_trial_attach(serial, sig)`:**
- callable only by `service_role`;
- only for a `kind='trial'` row in `pending`;
- sets the licence text and status `issued`;
- writes to `cl_activity_log`.

**Lost answers:**
- If the function dies after the request but before attach, the retry gets the same payload (step 3) and signs it.
- If the app loses the response, `cl_licence_pending` at the next check-in delivers the licence. It already returns the latest licence for the install, and trial rows are in the same table.

**Normalising phones: `cl_norm_phone(text)`**, with the same rule in the app:
1. Keep digits only. A leading `+` means international; drop a leading `00`.
2. 10 digits starting `07` → `263` + the last 9.
3. 9 digits starting `7` → `263` + those 9.
4. Zimbabwe result must match `^2637[1378][0-9]{7}$`.
5. Other countries: 8–15 digits, and only if typed with `+` or `00`.

So `07x…`, `+2637x…`, `2637x…` and `002637x…` all become the same `2637xxxxxxxx`. Reports and screens show it masked, e.g. `+26377•••7198`.

**Schema changes:**
- **New tables:** `cl_trials`, `cl_trial_refusals`, `cl_trial_exceptions`.
  - All have RLS on and no direct grants, like `cl_licences`.
  - `cl_trials` has a unique partial index on `phone_norm where kind = 'standard'` and a unique index on `install_id`.
- **`cl_licences`:**
  - new columns `kind` ('paid' | 'trial', default 'paid') and `trial_id`;
  - `issued_by` becomes nullable, with a check that it is not null when `kind = 'paid'`.
  - Existing rows are unchanged (all 6 are 'paid').
- **Delete guards:** the vendor and business delete guards count `cl_trials`.

### 2.4 Multi-till businesses (recommendation)

**I recommend your leaning: one trial per business, covering its tills, ending on the same date.**

- **Join during the trial:** a till joining during the trial gets a **cover licence**, which is:
  - its own signed trial licence, bound to that till;
  - `valid_to` = the business trial's end date;
  - linked to the same `trial_id`.

  The same `issue-trial` call does it, with no phone or RPN. The joined till asks right after joining, and check-in picks up anything missed.
- **The trial on the main till:** the main till's trial is recorded against its vendor row. The business is found through `cl_vendor_business()` at request time, so registering the business later (`cl_branch_register`) needs **no change** to that function.
- **Consequence:**
  - **Change from today:** a till added **after** the trial has ended gets no free days and needs a paid licence before it can sell. Today every new till gets its own 30 days. Please confirm.
  - A till joining on the trial's last day is refused ("the trial ends today"), because a licence must end after it starts.

### 2.5 Phone-number honesty (recommendation)

Without a code sent to the phone, a vendor can type someone else's number. **I recommend relying on the RPN's accountability now, and flags instead of hard blocks:**

- **The RPN is accountable:**
  - every trial records the RPN who typed the PIN;
  - the Console shows trials per RPN, how many converted to paid, and refusals per RPN.

  An RPN whose shops keep "new" phones and never convert is visible.
- **Flags** on each trial row in the Console. They are **not** refusals; a legitimate shop can match one.
  - **Same phrase:** the shop secret phrase was already used by an earlier trial. This is the strongest signal of a reinstall, and the phrase is what `cl_vendor_repeat_installs` already groups.
  - **Same name:** same normalised shop name as an earlier trial (lower case, letters and digits only).
  - **Same device:** same device key as an earlier trial. This mostly catches the desktop app; ASSUMED a PWA reinstall makes a new key.
  - **Busy RPN:** 3 or more trials by the same RPN within 7 days with none converted. The threshold is ASSUMED; you can change it.
- **A verification code** (WhatsApp or SMS) would be a later step (out of scope now). **Estimate:**
  - About 3–4 days to build: code table and rate limit, sending from an Edge Function, an app step, a Console view.
  - It needs a WhatsApp Business (Meta) account and an approved authentication template, or an SMS provider account. Setup lead time is often 1–2 weeks (ASSUMED).
  - Running cost: a few US cents per code (UNVERIFIED; check current Meta and SMS rates for Zimbabwe).
  - My recommendation: add it only if the flags show abuse.

### 2.6 The Q8 rule under signed trials (recommendation; ambiguous today)

- **The conflict:** today Q8 counts **products and stock** too ([activation.js:153-167](../../src/activation.js#L153-L167)). With §2.2, product and stock entry is *allowed before the trial*, so a shop that spent a week loading products while offline would lose that week. In the worst case it would be refused.
- **Recommendation: "business history" means sales.**
  - Sales are impossible before a trial, so legitimate shops are never affected.
  - A restored backup from a trading shop always has them.
- **How it works:**
  - **At request:** the app sends `earliest_sale`. Sales more than 30 days old → `TRIAL_OLD_DATA`, and no trial is recorded, so the phone isn't used up.
  - **In the app (offline, after a later restore):** a trial licence is honoured until the **earlier** of its signed end and *earliest sale + 30 days*. This keeps today's "a restore can end the trial" behaviour ([backup.js:175](../../src/backup.js#L175)).
  - **Paid licences** are never capped.

### 2.7 The Console (SCL Console, Activation Codes page)

New tabs next to Licences / Possible reinstalls / Old-style codes (`index.html:1511`):

- **Trials:**
  - Columns: shop (business or vendor name), owner phone (masked), RPN, started, ends, tills covered, **converted to paid** (yes once a paid licence or a ledger payment exists for that vendor or business after the start), flags.
  - Filters: running, ended, converted, flagged.
  - Permission: Activation Codes, as today.
- **Refused trials:**
  - The latest attempts: when, shop, phone (masked), RPN, reason.
  - A summary of **counts per RPN by reason**.
- **SysAdmin only: "Grant exception trial"**, for a phone or an install, with a **reason (required)** and days (default 30; 1–30).
  - It creates an *allowance* in `cl_trial_exceptions`, which the device's next trial request uses up (§2.3 step 8). So the Console never signs anything, and there is still one path that issues trials.
  - The grant and its use are both logged in `cl_activity_log`.
  - Typical case: a lost phone.
- **RPN Directory:** a "Trials" count beside each RPN's portfolio (trials, converted, refused). It comes from a new read-only function, so `cl_rpn_portfolio` is not changed.

### 2.8 RPN commission

- **No change, and trials earn nothing.** A trial writes no ledger entry: amount 0 and no `charge` row. Commission accrues only on `payment` / `payment_reversal` (§1.6).
- **The first real payment after a trial** still earns the *onboarding* rate, because it is the account's first standing payment.
- A Stage B test will prove that no commission line appears.

### 2.9 Removing the unsigned trial

- **Code that goes:**
  - `trialStartMs` / `trialEndMs` as a source of validity, and the `"trial"` branch at [activation.js:222](../../src/activation.js#L222);
  - the "You get 30 days free" line ([setup.js:88](../../src/setup.js#L88));
  - the setup-time `activated_until` mirror ([setup.js:220-222](../../src/setup.js#L220-L222), [:130-131](../../src/setup.js#L130-L131)).

  The Q8 function stays, but only as the cap in §2.6.
- **Existing test installs** (all test data; on live, 41 of 47 vendors have no licence):
  - On v17, a device with no licence and no legacy code enters **pretrial**. It is not "trial ended". It sees "Start your free trial" and can request one through the same flow.
  - A device whose licence has expired stays locked, as today.
  - Legacy old-style codes keep their horizon.
- **No backfill:** past unsigned trials leave no server record, so every test phone can get one trial. Because the test data reuses 9 numbers across 22 vendors, your tests will hit `PHONE_USED` early. That is expected.
- **Before testing:** set a PIN for the second RPN (only 1 of 2 has one).
- **Old builds:** an offline device still on v16 keeps its unsigned trial until it updates.
  - The PWA updates from our Workers.
  - Whether the desktop app updates itself is UNVERIFIED.
  - I don't propose a server-side build lock for this (no real shops yet).

### 2.10 Rollout order (each step waits for your word)

1. **Migration:** backup, SQL shown, then **"apply"**.
2. **Edge Function `issue-trial`:** deploy on **"go"**. It needs `SUPABASE_SERVICE_ROLE_KEY`, which Supabase provides to functions, plus the existing signing secrets.
3. **App v17:** to the previews (`tools/cf/deploy-app.js`).
4. **Console:** to sclconsole-preview.

The app ships last: an app that asks before the server can answer would say "couldn't start the trial right now".

---

## 3. Tests (Stage B)

**PGlite (`supabase/tests/trial-rules-test.js`), real SQL:**
- Phone normalising: `07…`, `+263 7…`, `2637…`, `00263…` and spaces or dashes all give the same value; junk is refused.
- Refusals:
  - no RPN, wrong PIN, suspended RPN;
  - the per-RPN-number limit after 10 failures across installs;
  - `PHONE_USED` on a second install with the same phone, including `07…` versus `+263…`;
  - `TRIAL_OLD_DATA`.
- **The same install twice:** one trial and one licence row, with the same payload before signing and the same licence after.
- **Joined till:** cover to the same end date; refused after the end; refused when the main has no trial yet.
- **Exceptions:** an exception allowance lets exactly one more trial through; only SysAdmin can grant one; both steps are logged.
- **Money and history:** no ledger row and no commission line for a trial; existing paid licences and their charges unchanged; `cl_licence_pending` delivers a trial licence.
- **Grants:** anon can't call `cl_trial_attach`, and staff and the device can't either; anon can't read the new tables.
- **Rollback:** refuses while trials exist, and otherwise restores the exact catalogue.

**Node and end-to-end (the real app code against the real SQL, plus the Edge Function handler with a test key, as in `test/licence-e2e.test.js`):**
- **Setup:** offline setup gives no trial and the plain message; then online plus RPN gives a trial.
- **Offline afterwards:** the trial licence works offline and expires on its date (faked clock).
- **Reinstall:** a new install with the same phone is refused.
- **Pretrial lock:** cart, checkout, `completeSale`, returns, EOD and reports are locked; products, GRV and stocktake are allowed.
- **Q8 cap:** restoring a backup with 40-day-old sales ends the trial; a restore with only products doesn't.
- **Multi-till:** two tills (main plus joined) end on the same date.

**Existing tests:**
- About 55 test files finish setup and then sell; they would hit the pretrial lock. One harness helper will give a test device a trial licence signed with a test key (the method `test/licence.test.js` already uses to inject a key). Expect a large but mechanical change.
- Full suite, all three builds, the service worker's build line bumped to v17, screenshots at 390 and 1280 px, and a two-device checklist.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| A fake phone number (someone else's) | RPN accountability, flags, refusals per RPN; verification code later if abused |
| PIN guessing by reinstalling (new install ID, fresh 5 tries) | New per-field-force-number limit (10 per hour across installs) |
| A collusive RPN | Trials and conversions per RPN in the Console; no commission on trials |
| Service-role key in the new function | Used for one RPC only (`cl_trial_attach`), which only touches pending trial rows; nothing else is granted to it |
| The signing key | Unchanged: an Edge Function secret, never in the database, never logged |
| Old builds offline | Bounded: one unsigned trial per old install, until it updates |
| A large test churn | One harness helper; run the full suite before anything ships |
| Trial plus paid overlap | A paid licence bought during the trial starts on its issue day (today's behaviour); the unused trial days are lost. Out of scope; see the questions |

## 5. Rollback

- **SQL:** `supabase/rollbacks/<version>_trial_rules.rollback.sql`.
  - It drops the new tables and functions, removes `kind` / `trial_id`, and restores `issued_by not null`.
  - It **refuses while any trial row exists.** This is test data: delete those rows first on purpose, as with B2.
- **Edge Function:** undeploy `issue-trial`. `issue-licence` is untouched.
- **App:** redeploy v16 to the previews, which brings the unsigned trial back. Trial licences already issued keep working in v16, because it ignores the trial bit and treats them as normal licences until they end.

## 6. Questions for you (with my recommendation)

1. **Product entry before the trial:** allowed, with selling locked?
   **Recommend yes**, as in the §2.2 table. Products, stock in, stocktake and settings are allowed. Selling, returns, receipts, EOD, credit payments, reports, dispatch and market publishing are locked.
2. **One trial per business, or per till?**
   **Recommend per business, covering its tills to the same end date.**
   Please confirm the consequence: a till added after the trial ends needs a paid licence before selling. Today it would get 30 free days.
3. **SysAdmin exception trial with a reason?**
   **Recommend yes,** as a logged allowance (phone or install, reason, 1–30 days) that the device then uses through the normal flow.
4. **Phone verification code later?**
   **Recommend not now.** Add WhatsApp first if the Console flags show abuse (about 3–4 days of work plus the provider setup, §2.5).
5. **Ambiguities in today's code:**
   - **a. Q8 "business history":** today it includes products and stock. **Recommend sales only** (§2.6), so that entering products before the trial costs nothing.
   - **b. Standalone "Remote Branch" at setup** ([setup.js:38](../../src/setup.js#L38)): an owner's second branch set up this way would use the same phone and be refused. **Recommend** steering remote branches to "Join an existing branch", which gives cover. A standalone remote install counts as its own shop.
   - **c. Owner's phone versus the receipt contact:** **Recommend a separate required `owner_phone`.** The receipt contact defaults to it but stays editable.
   - **d. A paid licence bought during the trial** starts on its issue day, as today. Should it start when the trial ends instead? **Recommend leaving it as is for now** (out of scope).
   - **e. Which numbers count:** **Recommend** Zimbabwe mobiles plus any `+country` number. Landlines are refused, because the number must be a phone that can receive WhatsApp later.
6. **Not yet done:** the prompt says to run this after the POS fixes (cart, customers, wholesale prices, stocktake search). I found no record of those in this repo's reports or recent commits. Stage A is read-only, so I went ahead. **Stage B should wait until those fixes are finished, or you say to go ahead.**
