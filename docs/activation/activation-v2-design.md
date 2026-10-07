# Activation v2: signed licences (design, Stage A)

Status (2026-10-07): **approved ("go Activation-B"); being built on `activation-v2`.** Where this doc and "Owner decisions" below disagree, **Owner decisions wins.**

The goal: activation codes that only seiGEN can create, even though the app's source is public, while activation keeps working for offline-first shops.

---

## Owner decisions (2026-10-07; these override the rest of this document)

- **Q1 Delivery:** one WhatsApp message carries the link, the long code (both work offline) and a short code (needs the till online). Registered tills can also receive licences automatically at check-in.
- **Q2 Who issues:** permission-based, through the "Activation Codes" permission, held by seiGEN staff by default. The owner can grant it to RPNs later in Staff Access. Every issue is logged with who issued it.
  - *Implementation note:* the Console already has a module with key `activation_codes` and label "Activation Codes" (live `cl_modules`). Issuing checks that module, or sysadmin, exactly as `cl_issue_activation_code` does; no second module with the same name is created.
  - RPN accounts (`cl_rpn`) can't hold modules today. Staff Access grants modules to `cl_staff` only, so granting to RPNs needs a later Console change.
- **Q3 Duration:** set per licence, 30, 90 or 365 days. Default 30.
- **Q4:** one licence per till, issued and billed per business.
- **Q5 Cutoff:** old-format codes are accepted until 30 days after v11 reaches production, then refused with a plain message.
- **Q6 After expiry:** selling is locked. The lock screen keeps Download backup, activation (link / paste / short code) and **read-only Reports**.
- **Q7 Revocation:** later, through check-in. The existing remote lock covers it for now.
- **Q8 Trial:** keep the offline trial, flag repeat installs in the Console, **and** close the reinstall + restore loophole. The trial counts from the **earliest business data in the database** (first sale, stock movement or product created), not only the install date. Restoring a backup with more than 30 days of history gives no new trial.
- **Q9 Number:** +263789487287 everywhere (activation screen, lock screen, Help). It replaces +263774479121 wherever that appears.
- **Q10 Key:** held as an Edge Function secret.
- **Q11:** the free trial stays unsigned, with the Q8 rule.
- **Q12:** remove the formula comment in v11. Nothing else in the repo may explain the old formula beyond what's needed to keep accepting old codes until the cutoff.
- **Q13:** re-check expiry every hour and when the app returns to the foreground.
- **Backup fix:** a restore keeps the device's own identity, licence and the higher clock watermark.
- **Orange note:** as designed (section 9).
- **Console:** its source isn't available. Build the command-line issuing tool now, plus a spec for the Console screen (`docs/activation/console-screen-spec.md`).
- **Security** (the repo is public):
  - **The private key** is written only to `C:\seigen-keys\`, restricted to the owner's Windows user. It is never printed, logged or committed. Key IDs support rotation.
  - **Issuing** requires an authenticated staff member with the permission; anonymous calls are refused.
  - **Redemption** is device-authenticated, single-use and rate-limited.
  - **The CLI** holds no key.
  - **Deployment** uses `SUPABASE_PAT` from `.env`, never printed.

---

## 1. What exists today (inspected)

### 1.1 The app (`src/activation.js` and friends)

| What | Where | Finding |
|---|---|---|
| The formula | `src/activation.js:1-7` | `computeActivationCode(deviceCode, phrase)`: a 32-bit string hash (`hash*31 + char`) of `DEVICECODE\|PHRASE`, in base 36, last 6 characters. |
| The formula, published | `src/state.js:8-19` | A header comment prints the formula with "Give this + the device code … + the shop's secret phrase to any Claude chat to get the 6-character unlock code." It ships in every build. |
| The phrase | `src/setup.js:96,118,187`, `src/settings.js:83,150` | The shop's "activation secret phrase" is typed at setup and editable in Settings. **The shop owner knows it**, so anyone with the formula and their own phrase can make their own codes. A joined till holds the *business* phrase (`setup.js:118`). The server stores it in clear text in `cl_vendors.shop_secret_phrase`. |
| Install ID | `src/terminal.js:21-22`, `src/db.js:653-657` | `uid4()`: 4 characters from a 32-letter alphabet (about 1 million values), made with `Math.random`. `LONG_INSTALL_ID = false`. |
| Device key | `src/terminal.js:25-34` | 16 random bytes from `crypto.getRandomValues`, made once per install, never shown. Sent with check-in and every terminal RPC. Stored on the server in `cl_vendors.device_key`. |
| Device code | `src/activation.js:23-28` | `<installId>-C<cycle>`, where cycle = `floor(days since install_date / 30) + 1`, using `trustedNow()`. |
| Trial | `src/setup.js:122-126` (join), `:198-203` (main/remote) | Setup sets `install_date` and `activated_until = now + 30 days`. |
| Expiry check | `src/activation.js:15-22` | `ok` while `trustedNow() <= activated_until`, otherwise `locked`. Only `activated_until` matters. |
| Unlock | `src/activation.js:67-84` | If the typed code equals the formula's output, `activated_until = trustedNow() + 30 days`. Nothing records which code was used, so a code can be reused for as long as its cycle number holds. |
| Trusted clock | `src/eod.js:176-276` | `trusted_time_hwm` is a watermark that never moves backwards. A rollback of more than 5 minutes, or an uncorroborated jump forward of more than 45 days, freezes time at the watermark. A server `Date` header is used when it can be read (usually not, because of CORS: `eod.js:221-226`). It is evaluated **once per session** (`eod.js:254-271`), so an app left open past expiry keeps working until it is restarted. |
| When expired | `src/main.js:27-29`, `src/router.js:41`, `src/activation.js:46-85` | Boot routes to `renderLock()`, which **replaces the whole app**: no sales, no reports, no backup. It shows a clock-anomaly notice if there is one (`activation.js:35-45`). |
| Where the screen lives | `src/activation.js` (only) | One screen, shared by both builds. `build.js:100-102` loads it into the phone (`dist`, `dist-pwa`) and desktop (`dist-tauri`) bundles alike. The WhatsApp number there is **+263774479121** (`activation.js:55,65`, `help.js:58`, `setup.js:85`). |
| Help text | `src/help.js:58` | "The app locks every 30 days. Call or WhatsApp +263774479121 …" |
| Existing tests | `test/license-clock-guard.test.js` (14 cases), `test/license-lock-screen-e2e.test.js` | They cover the watermark, rollback, forward jump and the lock screen DOM. |

**A second hole: restoring a backup rolls the clock watermark back.** `src/backup.js:154-170` (Replace) swaps the *whole* database for the file's, settings included. Only `branch_id` and the document counters are kept (`keepDeviceIdentity`, `:179-186`). So:
- `trusted_time_hwm`, `activated_until` and `install_date` come back from the old file. Roll the clock back, restore an old backup, and an expired device is unlocked again. That bypasses the trusted-clock rule.
- `install_id` and `device_key` come back too, so restoring device A's backup on device B clones A's identity and its activation.

**A third hole: reinstalling gives a fresh 30-day trial.** Clearing the app's data and running setup again makes a new install with a new trial (`setup.js:194-203`). That is unavoidable offline; section 5 covers it.

### 1.2 Who makes codes today

- **The Console** (Commerce Console, same Supabase project) is **not in this repository** or anywhere on this machine (`C:\seigen-*` checked). **UNVERIFIED:** its screens. From the database (live, read-only):
  - `cl_issue_activation_code(p_vendor_id, p_device_code, p_computed_code, p_cycle_number, p_valid_from, p_valid_to)`, `SECURITY DEFINER`, requires a staff token with the sysadmin flag or the `activation_codes` module. It stores `p_computed_code`, which **the caller computes**, so the Console runs the public formula in the staff member's browser. It also writes an automatic ledger charge from `cl_activation_pricing` and an activity-log row, which includes the code.
  - `cl_set_activation_rate(p_amount, p_currency)` is for sysadmins only.
- **`cl_activation_codes` has 0 rows**: the Console has never been used to issue a code. Codes are made by hand from the formula, as the `state.js` comment suggests.
- **The seiGEN Activator:** nothing by that name in this repo or on this machine. UNVERIFIED whether one exists elsewhere.
- **"Activate RPN"** (`cl_rpn_activate`) is the RPN *account* sign-up (name + verification code + passcode). It has nothing to do with device activation.

Live structure (read-only, 2026-10-07, no values read from the activation tables):

| Table | Columns | Rows |
|---|---|---|
| `cl_activation_codes` | id, vendor_id, device_code, computed_code, cycle_number, valid_from, valid_to, issued_by, issued_at | 0 |
| `cl_activation_pricing` | id, amount, currency, effective_from, set_by, created_at | 2 |
| `cl_vendors` | one row per install: install_id, device_key, shop_secret_phrase, business_id, lock_cart, lock_add_product, lock_reason … | 67 (52 with no business) |
| `cl_businesses` / `cl_branches` / `cl_terminals` | registered businesses / branches / tills | 6 / 7 / 15 |

The Console's permission modules (`cl_modules.key`): staff_access, vendors, activation_codes, rpn_directory, collections_ledger, billing_reminders, cashbook, chart_of_accounts, payment_vouchers, staff_activity_log.

### 1.3 Activation and registration

- **Activation is per install, not per business.** Every till, registered or not, has its own install ID, device code, trial and code (`docs/multi-terminal/phase1-plan.md:182`). A registered till still needs its own code. Tills of one business don't share an activation.
- **Check-in can already lock a device remotely.** `cl_device_checkin` returns `lock_cart`, `lock_add_product` and `lock_reason` from `cl_vendors` (`src/devicecheckin.js:133-136`). That is an online-only channel the server already controls.
- **The server knows a device's `device_key`** once it has checked in (`cl_vendors.device_key`) or registered (`cl_terminals.install_id` + the vendor's `device_key`).

### 1.4 Crypto available offline

- **WebCrypto Ed25519** is only in recent browsers: Chrome 137+ (mid-2025), Safari 17, Firefox 129 (ASSUMED from public release notes, not tested here). Shops on Android 7–9 phones run Chrome versions that stopped updating before 137, so **WebCrypto can't be relied on**. `crypto.subtle` also needs a secure context; the app's plain-file mode (`file://`, `src/state.js:3-6`) may not have one.
- **Recommended verifier:** **TweetNaCl-js 1.0.3** (`nacl.sign.detached.verify`). Pure ES5, no dependencies, no BigInt, no WebCrypto, includes SHA-512, public domain (Unlicense), and audited by Cure53 (2017). It is about 30 KB unminified and would be vendored into `src/vendor/` with its checksum pinned, **never loaded from a CDN**. An alternative is `@noble/ed25519`, which is smaller and also audited but needs BigInt (Chrome 67+) and a SHA-512 source. Versions and audit details are ASSUMED until checked against npm in Stage B.
- `package.json` has only dev dependencies (javascript-obfuscator, jsdom, playwright). No Ed25519 library is present; `jose` in `node_modules` is a transitive dev dependency. Nothing has been added.
- **Note:** the app already loads sql.js from cdnjs on first run (`src/db.js:643`). The verifier must not follow that pattern.

### 1.5 Where the private key could live (live project, read-only)

| Option | What's there | Verdict |
|---|---|---|
| **Postgres signs** | `pgsodium` 3.1.8 is *available*, not installed, and has `crypto_sign_detached`. Vault is installed (it already holds `cl_jwt_secret`). `pgjwt` only does HMAC JWTs. | Works, and could be deployed by migration. But Supabase has marked pgsodium as pending deprecation (ASSUMED from Supabase's docs), and the key would sit in the database, readable by anyone with SQL editor or service access. |
| **Supabase Edge Function** | Deno's WebCrypto signs Ed25519. The key is held as a function secret, outside the database. | **Recommended.** Staff call it with their `cl_login` token, the function checks permission through an RPC, then signs. **BLOCKED for me to deploy**: there is no Supabase CLI here and no `sbp_` access token. You would paste the function into Dashboard → Edge Functions (the code would be in the repo, without any key). |
| **Console signs in the staff browser** | The key would be shipped to every staff member's browser. | **No.** Anyone with Console access could copy the key and mint codes forever. |
| Offline signer on seiGEN's PC | A Node script and a key file on one PC. | A fallback only: one person, one machine, and no way for RPNs or remote staff to issue. |

---

## 2. The signed licence

### 2.1 Payload (binary, then base64url)

| Field | Bytes | Notes |
|---|---|---|
| format version | 1 | `2` |
| key ID | 1 | Which public key verifies it. The app ships a small list of public keys, so a new key can be added later without breaking old licences. |
| serial | 4 | Unique, from the server's `cl_licences` table. |
| install ID | 8 | ASCII, padded. Fits 4- and 8-character IDs. |
| device tag | 4 | The first 32 bits of SHA-512(device_key). |
| issued (day) | 2 | Days since 2026-01-01. |
| valid until (day) | 2 | Days since 2026-01-01, inclusive (until the end of that day, shop time). |
| plan | 1 | 0 = standard. Reserved for billing. |
| feature flags | 2 | All 0 now. Reserved for add-ons. |
| business ID | 0 or 16 | Present only for registered tills (flag bit), so the licence also names the business. |
| **signature** | 64 | Ed25519 over everything above. |

That comes to 89 bytes unregistered (about 119 characters) or 105 bytes registered (about 140 characters). The licence string is `SL2.` + base64url. It is fine to tap or paste, but not to type.

### 2.2 How the app checks it (all offline)

1. Parse it and check the version and key ID.
2. Verify the signature with the bundled public key (TweetNaCl).
3. The install ID must equal this device's, and the device tag must equal SHA-512(this device's `device_key`). Otherwise: "This licence is for another device."
4. `trustedNow()` must be ≤ the end of `valid until`. Otherwise: "This licence has expired."
5. The serial must not already be on this device's used list. A licence older than the one in use is refused, so you can't go backwards.
6. On success, the app stores the **licence string itself** (`licence` setting). Its expiry is derived from the signed payload on every boot, never from a plain date that could be edited. It also writes `activated_until` = the licence's expiry, so rolling the app back to v10 still honours it (section 10, Rollback).
7. **A signed issue date is a trusted time.** On activation, the watermark moves forward to at least `issued`. A fresh licence also corrects a clock that was rolled back.

### 2.3 The device code shown to the shop

New format: `ABCD-K7Q2` = install ID + a **device tag** (the first 4 characters, in the same 32-letter alphabet, of SHA-512(device_key)). The `-C<cycle>` part goes; it only existed for the old formula.
- The tag ties a licence to the device's private random key, so **a licence only works on the device it was made for.** Two installs that happen to share a 4-character install ID still get different tags.
- **`LONG_INSTALL_ID` is no longer needed for activation.** The device tag removes the collision problem the Console check was meant to clear (`AR9W21`). Registration already tells devices apart by `device_key`. I recommend leaving it off and dropping the pending Console check. (It can still be switched on later for other reasons; nothing here depends on it.)
- **A wrinkle:** the shop reads the tag from the screen and staff type it, so a typo means a licence for no device. The Console should validate the format, and for **registered** devices it should fill both parts in itself from `cl_vendors` / `cl_terminals`, which already hold `install_id` and `device_key`.

---

## 3. Delivery (the length problem)

| | How | Offline at the moment of activating? | Notes |
|---|---|---|---|
| **(a) Link** | WhatsApp message with `https://mobilepos.seigendc.workers.dev/#lic=SL2.…` (or `desktoppos…`) | **Yes**, once the app is installed and cached: the service worker serves it, and the licence is checked locally. | The `#…` part never reaches the server. On Android, an installed PWA (WebAPK) usually catches links in its scope. If it opens in a Chrome tab instead, it's the same origin and the same storage, so it still activates. **Fails** if the link opens in another browser (Samsung Internet), in WhatsApp's in-app viewer, or in the Tauri app, which has a separate store and no deep-link plugin. The app then shows "Open this link in the seiGEN app, or copy the code". It never starts setup from a link. On desktop, the link opens in the default browser, so it works only if that's the browser the app lives in. UNVERIFIED on real devices; to test in Stage B. |
| **(b) Short code, redeemed online** | `K7Q2-9XMB-3H` (10 characters, about 50 bits) typed in the app, sent with install ID, phrase and device key to `cl_licence_redeem` | **No**, the till must be online. | The easiest option when WhatsApp is on the owner's phone but the till is a desktop. The server checks the code (stored only as a hash), checks it's for this device, marks it redeemed and returns the signed licence. Failed attempts are counted and limited per install, like `cl_join_failures`. |
| **(c) Paste** | The same `SL2.…` text, pasted into the box | **Yes** | The universal fallback, and the only one for Tauri. |
| **(d) Automatic, for registered tills** | Check-in returns any licence issued for this device that it doesn't yet have. | Delivered at the next online check-in. | No action from the shop. It suits per-business billing (section 6). It reuses the existing check-in. |

**Recommendation (Q1): a combination.** Each issued licence has a link, a long code and a short code, and the WhatsApp message carries all three. The activation screen has one box that accepts any of them, plus the link. Registered tills also receive licences automatically at check-in (d). (a) and (c) work offline; (b) and (d) need the till online.

The app's WhatsApp prefill gets the device code, shop name and **which app** ("phone app" / "desktop app"), so staff send the right link.

---

## 4. Issuing, records, audit, revocation

- **Where:** a new Console screen, **"Issue licence"**, behind the existing `activation_codes` module, plus sysadmin. The Console calls the Edge Function `issue-licence` with the staff token. The function asks a DB RPC (`cl_licence_prepare`, which checks permission, reserves a serial and records the row), signs, then stores the signed string (`cl_licence_attach`). It returns the link, the long code and the short code.
  - **Before the Console is updated:** a small CLI in this repo (`tools/licence/issue.js`) calls the same function with a staff sign-in, so licences can be issued, and the whole chain tested, without the Console. It holds no key.
- **Record:** a new table, `cl_licences`, rather than reshaping `cl_activation_codes` (0 rows, kept as history). It holds:
  - serial (identity) and key ID;
  - vendor_id, business_id, terminal_id, install_id and device_tag;
  - plan, flags, valid_from and valid_to;
  - the licence string (not a secret: it only works on its own device) and the short code's hash only;
  - status (issued / redeemed / revoked), issued_by / issued_at, redeemed_at / redeemed_device_key, revoked_at / revoked_by / reason.
  - Issuing writes `cl_activity_log` and the same automatic `cl_ledger_entries` charge `cl_issue_activation_code` writes today, without the code itself.
- **Revocation:** only online. An issued licence can't be pulled back from an offline device; it stays valid until it expires. Online:
  - check-in returns revoked serials for that device, and the app drops the licence;
  - the existing `lock_cart` flag already locks selling remotely.

  Short licences (30 days) limit the damage from a leak.

---

## 5. Device binding and abuse

| Attack | Result |
|---|---|
| Make your own codes from the public source | **Blocked.** Without seiGEN's private key, nothing verifies. |
| Copy a licence to another device | **Blocked.** The install ID and device tag don't match. |
| Roll the clock back | Blocked by the existing watermark, as today. A new licence also moves the watermark forward to its issue date. |
| Re-enter an old licence | Refused if its serial was used, or if a newer one is in use, and refused once expired. |
| **Restore an old backup to roll the watermark back** (hole in 1.1) | **To fix in Stage B.** Replace keeps the device's own `install_id`, `device_key`, `licence`, `install_date` and the *higher* of the two watermarks, as `keepDeviceIdentity` already does for `branch_id`. |
| Clone a device through a backup | Blocked by the same fix: a restored file doesn't bring its identity with it. |
| **Reinstall for a new 30-day trial** | **Not blocked offline.** A fresh install has nothing to tie it to an earlier one. Options are in Q8. |
| Patch the app's JavaScript (dev tools, local overrides, or host a modified copy of the public repo) | **Possible for a determined, technical person.** The source is public, so anyone can run a copy with the check removed. That is "running our free code", not our product: no seiGEN support, no updates, no registration, Digital Commerce or marketplace (those are server-side and phrase-checked). The licence stops casual and commercial code-selling, which is the realistic goal. |
| Edit the stored settings (IndexedDB) | Harder than today: validity comes from the signed licence, not a date field. The legacy `activated_until` is honoured only until a fixed horizon (section 7). |

---

## 6. Per till or per business

**Recommendation (Q4): a licence per till, issued and billed per business.**
- Each licence is bound to one device, because that's what makes copying fail.
- For a registered business, the Console issues for the business in one action: one licence per active till (it knows each till's install ID and device key), billed as base fee + extra branches/tills + add-ons. The tills receive them automatically at check-in (3d), or by link if offline.
- An unregistered single device is a "business of one", with the same screen.
- The `plan` and `flags` bytes leave room for add-ons without a new format.

---

## 7. Transition for existing shops

- **Shops already activated keep working** until their current `activated_until`. v11 honours it.
- **Old 6-character codes:** accepted only until the **cutoff date**, hard-coded in v11. Afterwards they are refused with: *"This is an old-style code. From <date> seiGEN sends a new licence (a link or a code). WhatsApp +263… with the device code below."*
- **Recommendation (Q5): cutoff = v11's production release + 30 days.** Every shop then passes through one renewal while both work.
- **Legacy horizon:** after cutoff + 30 days, v11 ignores any `activated_until` that isn't backed by a signed licence or the setup trial, which v11 reads from `install_date`. That closes date-field editing once the transition is over.
- **Order:** the Edge Function, table and CLI (or the Console screen) must issue v2 licences **before** v11 reaches production.
- **Remove the formula comment** from `src/state.js`. It stays in git history, but it stops being shipped.

---

## 8. UI

Light orange theme as today (`#E8590C`), one screen shared by phone (390px) and desktop (1280px), in `src/activation.js`:

- **Locked:** "Activation needed".
  - The device code `ABCD-K7Q2`, with a Copy button.
  - "WhatsApp seiGEN" (prefilled message) and "Call seiGEN +263…".
  - One input: "Paste your licence or type your code".
  - An **Activate** button.
  - The clock-anomaly notice, as today.
  - A **Download backup** button (Q6).
- **Status**, in More → Settings → About/Licence:
  - "Licensed until 7 Nov 2026 (licence #1042)" / "Free trial until …" / "Old-style activation until …";
  - the device code;
  - "Enter a new licence" (early renewal).
- **Arriving by link:** "Activating…", then "Activated until 7 Nov 2026". Or the error, with the code left in the box.
- **Errors, in plain English:**
  - "This licence is for another device (ABCD-K7Q2). Ask seiGEN for one for this device."
  - "This licence expired on 3 Oct 2026."
  - "This code isn't valid. Check it, or paste the whole licence from WhatsApp."
  - "This code has already been used on another device."
  - "You're offline. Short codes need the internet: connect and try again, or tap the link / paste the long licence from WhatsApp, which works offline."
  - "This is an old-style code …" (after the cutoff).
- **Number:** you asked for **+263789487287**; the lock screen today uses **+263774479121** (Help shows both). Q9.

---

## 9. The orange note on Products and Sell

**Today** (`src/pos.js:29-40`; shown on Sell `pos.js:650`, desktop Sales `src/desktop/sales-desktop.js:57`, Products `src/products.js:235`): any registered till with code T2+ shows *"Stock for this till isn't set up yet — coming in the next update."*. These cases trigger it:
- before its first stock sync;
- in a **local-stock** branch, whenever it isn't the stock holder;
- in a shared branch before it has joined.

That's wrong in local mode. There, a non-holder till sells its own stock normally (`sellableNow` returns `p.stock`, `src/shared-stock.js:45-50`), and "coming in the next update" has been false since shared stock shipped (v7+).

**Proposed rules:**

| Situation | Note |
|---|---|
| Shared branch, joined (`stock_init=1`) | none |
| Shared branch, not joined (still holds its own stock) | "Your branch uses shared stock. This till still has stock of its own: add it to the branch in More → Settings → Branch stock." |
| Local branch, or no sync yet, and **this till has stock of any product** | none (it sells its own stock) |
| Local branch, or no sync yet, **no stock on this till at all**, T2+ | "This till has no stock yet. Receive stock on this till, or ask the main till to start shared stock for the branch." |
| T1, the holder, or unregistered | none |

Same orange box, same three places. "Coming in the next update" goes.

---

## 10. Tests, risks, rollback, release

### Tests (Stage B)
- **Licence unit tests** (harness):
  - valid → activated;
  - a byte flipped in the payload or the signature → invalid;
  - wrong install ID or wrong device key → "another device";
  - expired → refused;
  - clock rolled back after activating → still expires on time;
  - a used serial or an older licence → refused;
  - an unknown key ID → invalid;
  - a signed `issued` date moves the watermark forward.
- **Old codes:** accepted the day before the cutoff, refused on it, and `activated_until` is ignored after the horizon.
- **Backup Replace** keeps the licence, identity and higher watermark. The rollback-by-restore attack fails.
- **Link:** `#lic=` at boot activates offline, and the hash is cleared from the URL. A link on a device without setup shows "open in the app", never setup.
- **Redemption:** PGlite tests for `cl_licence_redeem`:
  - wrong phrase, wrong device, a used code and too many tries are refused;
  - a good code is returned once.

  An app test with a faked RPC covers offline → the plain message.
- **Check-in delivery:** a new licence for this device is stored; a revoked serial is dropped.
- **Shop shapes:** single-till unregistered, registered T1, registered T2 (per till).
- **Orange note:** every row of the table in section 9.
- **Server:** migration + rollback + PGlite test (`cl_licences`, prepare / attach / redeem / revoke / list, permissions, no secret in any column), and a Deno-free test of the Edge Function's signing logic (same code under Node).
- **Then:** the full suite, all three builds, screenshots at 390 and 1280.

### Risks
- **Lost private key:** no new licences until a new key ships in an app update. Key ID rotation is designed in. **Back the key up offline**, in two places.
- **Leaked private key:** anyone could mint licences. Add a new key ID, stop trusting the old one in the next release, and re-issue.
- **Edge Function down or not deployed:** no new licences. Existing ones keep working offline, and the cutoff must not pass before issuing works.
- **Links on real devices** behave differently by browser. Paste and the short code are the safety nets.
- **Device-code typos:** Console validation, plus auto-fill for registered devices.
- **Shops past the cutoff without a new licence** lock. Give them the full 30 days' notice through check-in messages (`dc_messages` already exists).

### Rollback
- **App:** redeploy v10. v11 mirrors each licence's expiry into `activated_until`, so v10 still honours devices activated with v2. v10 accepts old codes again.
- **Server:** the rollback SQL drops `cl_licences` and the new RPCs. `cl_activation_codes` and `cl_issue_activation_code` are untouched. Undeploy the Edge Function. The key never needs to move.

### Release plan
1. **Key:** you generate the key pair with `tools/licence/keygen.js`. The private key is written to `C:\seigen-keys\` (outside the repo, restricted to your user with `icacls`), and you copy it to two offline places. Only the **public** key is printed and committed.
2. **Server:** back up, show the SQL, wait for "apply", run it. You then deploy the Edge Function from the repo source and set its secret `LICENCE_SIGNING_KEY` in the dashboard (I can't: no CLI or `sbp_` token here).
3. **Issue a test licence** with the CLI for a preview device.
4. **The Console** (in its own codebase, outside this repo):
   - an "Issue licence" screen that calls `issue-licence`;
   - auto-fill for registered devices;
   - a list and revoke screen.

   It must ship **before** v11 goes to production.
5. **App v11 to the preview Workers**, with your two-device checklist.
6. **Production v11**, with the cutoff date set from the release date. Check-in messages announce the change.
7. **Cutoff + 30 days:** the legacy horizon passes. Remove the old-code path in a later release.

---

## 11. Questions (with recommendations)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Delivery: link, short code, paste, or a combination? | **A combination:** link + long code + short code in one WhatsApp message, plus automatic delivery at check-in for registered tills. |
| Q2 | Who issues? | **seiGEN staff** with the `activation_codes` module. RPNs later, through a separate permission and a daily cap, once billing exists. |
| Q3 | Duration? | **Set per licence**, offered as 30 / 90 / 365, defaulting to 30. The payload carries the date anyway. |
| Q4 | Per till or per business? | **Per till, issued and billed per business** (section 6). |
| Q5 | Cutoff for old codes? | **30 days after v11's production release**, hard-coded. |
| Q6 | After expiry? | Keep the full lock for selling, but add **Download backup** on the lock screen, so a shop is never cut off from its own data. A read-only mode with reports is possible later. |
| Q7 | Revocation now? | **Later**, through check-in. For now, `lock_cart` and 30-day durations are enough. |
| Q8 | Trial abuse by reinstalling? | Keep the offline 30-day trial for now (onboarding is RPN-led), but flag in the Console any business or phrase with several installs. Later, optionally require one online check-in at setup so the server grants the trial once per business. |
| Q9 | Which number on the activation screen? | **+263789487287**, as you wrote. Today's screens use +263774479121. Confirm, and I'll change it everywhere the activation screens and Help mention it. |
| Q10 | Where is the signing key held? | **Edge Function secret** (section 1.5). The alternative is pgsodium + Vault in the database, deployable by migration but deprecated and readable from the SQL editor. |
| Q11 | Free trial: unsigned, as today? | **Yes.** The trial is local (`install_date` + 30 days); only paid time needs a signed licence. |
| Q12 | Remove the formula comment from `state.js` now? | **Yes**, in v11. |
| Q13 | Expiry evaluated once per session | Re-check every hour and when the app comes back to the foreground, so a till left open for days still locks on time. |

**Stop here. Nothing is implemented until "go Activation-B".**
