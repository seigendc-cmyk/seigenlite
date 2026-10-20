# P0 freezes after build 29: sign-in and Remote → Main (Stage A diagnosis)

2026-10-20 · Stage A (the diagnosis, sections 1–7) was written before any change. **Stage B (the v30 fix, its timings and the sale/search measurement) is at the end.** Protocol: [docs/CODING-AGENT-PROTOCOL.md](../CODING-AGENT-PROTOCOL.md). Labels: **VERIFIED** (measured, or read in the code at the file:line given), **UNVERIFIED** (likely, not checked yet), **ASSUMED** (taken as true without evidence).

## 1. Summary

| | Root cause | Evidence |
|---|---|---|
| **A. Sign-in** ("Who's working today?") | **1.** Since v28, every sign-in checks the PIN against a PBKDF2 check value (150,000 rounds, pure JavaScript, synchronous, on the UI thread). **The shipped builds (dist-pwa, dist-tauri) put that code through javascript-obfuscator with control-flow flattening, which makes it about 40× slower.** One sign-in = one hash = 17 s on this PC, 76 s at 4× and 110 s at 6× CPU throttling, in a single frozen task. **2.** With a large shop, the Sell screen drawn right after sign-in adds 5 s (1×) to 50 s (6×): about 4 settings queries per product, for all 5,000 products. | VERIFIED: measured on the build 29 files deployed to the previews, and by CPU profile |
| **B. Remote → Main** (Settings with the Admin passcode) | The same hash. On a till that joined with a join code, the Admin passcode is a PBKDF2 check value set by main (v21). Unlocking Settings runs the same obfuscated 150,000-round hash, once for each Admin check value on the till: 17 s at 1×, 76 s at 4×, 110 s at 6×. **The switch itself (Branch type → Main → Save) takes 0.1–1.5 s.** It doesn't restart the app, sync or reload the catalogue. | VERIFIED: measured, and the code read |

Not causes (each checked): the network, a sync, a check-in, an old staff upload, a role pull, a database transaction held across an await, a timer, a loop of re-renders, saving the database. Details in §5.

**Why "since build 29":** v28 made every sign-in a PBKDF2 check, but v28 was never deployed; v29 was the first preview build with it (VERIFIED: commits 725afbf "not deployed" and f0fa2eb "deployed to mobilepos-preview and desktoppos-preview"). Freeze B is older. It has existed since v21 (2026-10-13, commit 35ed50f) on every till that joined with a join code (VERIFIED from git), but it only shows on such a till.

## 2. Timings before any fix

**How it was measured.** [tools/perf/freeze-e2e.js](../../tools/perf/freeze-e2e.js) runs the real build in Playwright Chromium at 390 px. The steps:

- It sets the shop up and seeds the app's own database:
  - roles and people from seiGEN (PIN check values made by `src/passcode-check.js`);
  - single operator mode off;
  - a remote branch whose Admin passcode came from main as a check value.
- **Large** adds 5,000 products, 10,000 sales with 50,000 lines, 200 customers and 20 staff. The database is 9.6 MB.
- seiGEN is blocked, so the till is unregistered, like a till that is offline at sign-in.
- Each step is timed from the click until the next screen is up. The longest task comes from the Long Tasks API: that is how long the UI was frozen.

The results are in [2026-10-20-stage-a-results.jsonl](2026-10-20-stage-a-results.jsonl).

**Build 29** is the exact build deployed to mobilepos-preview: `deploy/preview/mobile/index.html`, SW_BUILD 29, obfuscated. **Unobfuscated** is the same app in the plain single-file build `dist/index.html`. That file is the current working tree (v30, uncommitted), whose sign-in path is the same as v29's. It shows what the obfuscation costs.

Times are in seconds. "Frozen" is the longest single task.

| Build | Data | CPU | Cold start | Sign-in (cold) · frozen | Sign-in (warm) | Settings unlock (Admin passcode) · frozen | Save Main |
|---|---|---|---|---|---|---|---|
| **Build 29 (preview)** | small | 1× | 0.8 | **16.7** · 16.6 | 16.8 | **17.2** · 17.1 | 0.11 |
| Build 29 | small | 4× | 3.1 | **75.9** · 75.7 | 75.7 | **75.9** · 75.8 | 0.62 |
| Build 29 | small | 6× | 4.7 | **110.4** · 110.2 | 106.8 | **109.6** · 109.5 | 0.91 |
| Build 29 | large | 1× | 1.2 | **21.6** · 21.5 | 21.6 | **16.7** · 16.6 | 0.17 |
| Build 29 | large | 6× | 6.7 | **160.5** · 159.6 | 158.2 | **104.6** · 104.5 | 1.51 |
| Build 29, desktop preview file | small | 1× | 0.8 | **17.5** · 17.5 | not measured | not measured (the script's phone navigation) | not measured |
| Unobfuscated | small | 1× | 1.1 | 0.43 · 0.38 | 0.31 | 0.41 · 0.36 | 0.12 |
| Unobfuscated | small | 4× | 1.7 | 1.75 · 1.67 | 1.36 | 1.74 · 1.66 | 0.53 |
| Unobfuscated | small | 6× | 2.5 | 2.80 · 2.68 | 1.95 | 2.74 · 2.65 | 0.85 |
| Unobfuscated | large | 1× | 0.9 | **5.7** · 5.6 | 5.0 | 0.43 · 0.37 | 0.20 |
| Unobfuscated | large | 6× | 4.9 | **55.5** · 54.7 | 50.3 | 3.70 · 3.57 | 1.24 |

**The hash on its own** ([tools/perf/pbkdf2-obfuscation-bench.js](../../tools/perf/pbkdf2-obfuscation-bench.js), Chromium; 150,000 rounds = one PIN or Admin passcode check):

| | 1× | 4× | 6× |
|---|---|---|---|
| passcode-check.js as written | 0.30 s | 1.19 s | 1.57 s |
| the same, obfuscated with build.js's options | **11.5 s** (measured) | ≈ 52 s (3,000 rounds × 50) | ≈ 79 s (3,000 rounds × 50) |
| Web Crypto `crypto.subtle` PBKDF2, same inputs | 0.085 s | 0.049 s | 0.052 s |

- **VERIFIED:** Web Crypto gives the same 32 bytes as passcode-check.js.
- **VERIFIED:** Web Crypto is available on a `file://` page (`isSecureContext` true).
- **Caveat:** Web Crypto runs off the UI thread, so CPU throttling doesn't apply to it. Its phone figure is **UNVERIFIED**; it is ASSUMED to be well under a second.

**About the CPU levels.** 4× and 6× are slowdowns of this PC. They stand in for a cheap phone (ASSUMED). The owner's report of more than 3 minutes matches the build 29 6× column. One hash is about 110 s. A second tap while the screen is frozen probably adds another hash (§3.3).

**Builds 27 and 28 by code (VERIFIED by reading, not measured):**

- **v27:** the PIN sign-in was `attemptPinLogin`: one SHA-256 of salt and PIN (`hashPinSync`, staff.js), which takes microseconds. The remote's Admin passcode unlock was already PBKDF2 (v21), so freeze B was already there.
- **v28:** brought the PBKDF2 sign-in (roles.js). It was not deployed.
- **v29:** adds only the "set your seiGEN PIN" step after an old PIN. That step runs one more PBKDF2, when the PIN is saved.

## 3. Root cause A: sign-in

### 3.1 The hash (VERIFIED)
- [src/staff.js:299](../../src/staff.js#L299): Unlock calls `attemptShopSignin(id, pin)` synchronously in the click handler.
- [src/roles.js:116](../../src/roles.js#L116): `staffPinMatches` calls `adminCheckMatches(p, salt, check, rounds)`.
- [src/passcode-check.js:57](../../src/passcode-check.js#L57): `pbkdf2Sha256Hex` does 150,000 rounds ([line 10](../../src/passcode-check.js#L10)). Its algorithm is PBKDF2-HMAC-SHA-256. It is pure JavaScript, synchronous, on the UI thread, with no library and no worker.
- It runs **once** per sign-in, for the chosen person only. It doesn't try every staff hash. A wrong PIN costs the same. A person with only old till PINs gets the fast SHA-256 path, unless they also have a seiGEN check value: then PBKDF2 runs first.

### 3.2 Why it is 40× slower in the shipped builds (VERIFIED)
- [build.js:33-45](../../build.js#L33): dist-pwa and dist-tauri are obfuscated with `controlFlowFlattening: true` (0.75), `stringArray` with base64 encoding, and `selfDefending`. `passcode-check.js` is part of the obfuscated app code ([build.js:153](../../build.js#L153)).
- The build already keeps the vendored crypto library (tweetnacl) out of the obfuscation, "the obfuscator would slow the crypto down for nothing" ([build.js:221](../../build.js#L221)). passcode-check.js was not given the same treatment.
- **Isolated in Node:** 2,000 rounds take 12 ms as written, 4,472 ms with build.js's options, and 23 ms with only control-flow flattening switched off. So control-flow flattening is the cause.
- **The plain single-file build `dist/index.html` is not obfuscated.** That is why the staff-deadlock e2e test passes on the phone build quickly.

### 3.3 Other sign-in findings
- **No double-submit guard (VERIFIED):** the Unlock button is never disabled ([staff.js:299](../../src/staff.js#L299)). Taps made during a 2-minute freeze are queued by the browser and delivered afterwards. **UNVERIFIED:** whether they repeat the hash or land on the Sell screen that replaced the PIN screen; not measured.
- **The Sell screen drawn after sign-in (VERIFIED by CPU profile, unobfuscated build, large data, 1×):**
  - The sign-in click took 6.4 s. `renderPOS` took 5.7 s of that; the hash took about 0.3 s.
  - Inside `renderPOS`, `productListHtml` ([src/pos.js:833](../../src/pos.js#L833)) draws **all 5,000 products**. For each one it calls `sellable(p)` twice and `stockLineText(p)` twice. Each call reaches `sharedStockTill()` → `ssRegistered()` → `getSetting()`, which is a SQLite query each time ([src/shared-stock.js:29-50](../../src/shared-stock.js#L29)).
  - That is over 20,000 SQL queries per draw, more on a registered shared-stock till.
  - This code dates from Phase 3b (commit 44fd72b, 2026-10-06), so it isn't new in 29. It happens after any sign-in, and whenever Sell is drawn, on a shop with many products.
  - **UNVERIFIED:** the same cost after a single-operator "Continue". My profiling run for that path failed (the seeded till had single operator mode off).
- **Not causes (VERIFIED):**
  - **Network:** sign-in doesn't wait for it. `staffEnsureToken()` (seiGEN's own PIN check and token) is started and not awaited ([roles.js:145](../../src/roles.js#L145)), with a 20 s timeout and no retries. There are 0 seiGEN calls before the screen closes.
  - **Staff list:** no staff pull or old-staff upload at sign-in. These run after a check-in ([devicecheckin.js:184](../../src/devicecheckin.js#L184)) and after "Sign in to manage staff" only.
  - **Database:** no transaction in the sign-in path. Saving the 9.6 MB database (`db.export()`) took 4–8 ms.
  - **Timers:** none started, apart from the 30 s idle check in "manage staff" mode, which is cleared on sign-out.

## 4. Root cause B: Remote → Main

- [src/settings.js:28](../../src/settings.js#L28): Unlock calls `findAdmin(code)` synchronously.
  - [src/staff.js:413-424](../../src/staff.js#L413): `findAdmin` first tries a plain passcode. On a joined till there isn't one: the main branch sets the Admin passcode as a check value (v21).
  - It then runs the 150,000-round PBKDF2 **for every active Admin row with a check value, on every branch in this till's database**, until one matches. A correct passcode is remembered for the session; a wrong one runs every row again.
  - On a till with one such row, that is one obfuscated hash: 17 s / 76 s / 110 s (VERIFIED, table above). A till with merged backups holding more Admin check values pays once per row for a wrong passcode (VERIFIED by code; not measured).
- [src/settings.js:121-140](../../src/settings.js#L121): Save writes the settings, including `branch_type`, then `persist()` and `render()`, and nothing else.
  - **VERIFIED, by code and by measurement (0.11–1.51 s):** no restart, no sync, no check-in, no catalogue or stock reload.
  - Most of that time is the Settings screen drawing itself again, including its Diagnostics card's stock-ledger check over every product.
- **The same slow hash is in ~29 other Admin passcode checks** (`findAdmin` / `findApprover`: price edits, adjustments, EOD, returns, credit over the limit, deleting a customer, cancel and reissue…). On a joined till, each one freezes for the same time. `findApprover` with the holder's own PIN runs `findAdmin` first, so 2 or more hashes (VERIFIED by code).

## 5. Checklist results

| Asked to check | Result |
|---|---|
| bcrypt/PBKDF2 on the main thread, high cost, more than once | **Yes:** PBKDF2-SHA-256, 150,000 rounds, pure JS, main thread, made ~40× slower by obfuscation. Once per sign-in; once per Admin check row in `findAdmin`. VERIFIED |
| Sign-in waits for a network call, check-in or sync | No ([roles.js:145](../../src/roles.js#L145), not awaited). VERIFIED |
| SQLite transaction open across an `await` | No (sql.js in memory; no BEGIN in either path). VERIFIED |
| Old staff upload / role pull on every sign-in | No (after check-in and manage-staff sign-in only). VERIFIED |
| Branch switch restarts init / full sync / catalogue reload | No (settings write, persist, render). VERIFIED |
| Unresolved promises, recursive state updates, repeated timer | None found in either path. The longest-task measurements show one long task per action, not a loop. VERIFIED (measured) |
| Re-renders and duplicate handlers | Sign-in renders once. The Sell list costs about 4 settings queries per product (§3.3). VERIFIED |

## 6. Proposed fix (Freeze-B): smallest safe change

Nothing is weakened. The PIN and passcode check values, their 150,000 rounds, the 5-tries / 5-minute lockout, and seiGEN's own PIN check and rights checks all stay exactly as they are. The same bytes are computed, only faster and off the UI thread. **No database change** on the till or on seiGEN: the stored values and the algorithm don't change.

1. **Stop obfuscating the hash** (1 file):
   - Wrap `src/passcode-check.js` in `// javascript-obfuscator:disable` / `// javascript-obfuscator:enable`, as the build already does for tweetnacl.
   - **VERIFIED on its own:** same check values; its time returns to the unobfuscated time (377 ms vs 495 ms in Node); the rest of the app stays obfuscated.
   - Obfuscating a public algorithm protects nothing; the passcode is not in the code.
   - This alone fixes all ~30 Admin passcode checks too: 0.3 s at 1×, 1.6 s at 6×.
2. **Hash off the UI thread** (passcode-check.js, roles.js, staff.js, settings.js):
   - Add `adminCheckMatchesAsync` and `adminCheckMakeAsync`, using Web Crypto `crypto.subtle` PBKDF2 (VERIFIED identical bytes, ~50–85 ms, off the main thread). The pure-JS version stays as the fallback when Web Crypto is missing.
   - Use them on the two P0 screens: the PIN sign-in (`attemptShopSigninAsync`) and the Settings unlock (`findAdminAsync`), plus "Sign in to manage staff" and setting a PIN.
   - The other ~25 `findAdmin` callers keep the sync check, now fast thanks to step 1. Moving them later is a follow-up.
3. **A clear state, no double submit** (staff.js, settings.js, roles.js):
   - Unlock is disabled and reads "Checking…" while the check runs. Then the next screen opens, or an inline message appears (wrong PIN or passcode, attempts left, locked).
   - The fail count is re-read after the await, so the lockout still counts every wrong try.
4. **Sell after sign-in** (pos.js, shared-stock.js):
   - Work out `sharedStockTill()` once per list instead of 4 times per product, and each row's `sellable` / `stockLineText` once. The screen looks the same; it is only fewer queries.
   - **Owner's choice:** also show the first 200 products with "type to search for the rest". Without this cap, a 5,000-product shop at 6× will probably still miss the 2 s target, because drawing 5,000 rows itself costs time (UNVERIFIED until measured after step 4).
5. **Remote → Main switch:**
   - **Right to the destination:**
     - The passcode check stays: the Admin passcode, via step 2.
     - The switch only changes this till's local Branch type. It doesn't move the till to another branch on seiGEN: `branch_uuid` and `terminal_is_main` are untouched (VERIFIED).
     - **Owner question:** should a till registered as a remote be allowed to switch to Main locally at all?
   - **All or nothing:** Save's settings writes go in one transaction (`BEGIN … COMMIT`, `ROLLBACK` on any error), then one persist. If it fails, the till stays on its current branch type and an alert says "Nothing was changed".
   - **Stale data:** nothing is keyed by branch type, and the branch name is unchanged, so there is no old-branch data to clear (VERIFIED). The Settings lock is kept as it is.
   - **Pending sales:** the switch never touches `sync_queue`, sales or the outbox (VERIFIED). A test will count them before and after an offline switch.
   - **No full reinitialization:** already true. The redraw stays as it is.
6. **Tests:**
   - Correct and wrong PIN and passcode, and lockout after 5 wrong tries, on the async path.
   - Same bytes from the async and the sync hash.
   - The obfuscated build hashes in under 1 s at 1× (a guard so this can't come back).
   - [tools/perf/freeze-e2e.js](../../tools/perf/freeze-e2e.js) on the obfuscated build: large data at 6×, cold and warm, for the before-and-after table.
   - An authorized and an unauthorized switch.
   - An offline switch with queued sales (nothing lost).
   - No double submit; no duplicate token or sync calls.
   - The roles, shop-roles(-e2e), staff-deadlock(-e2e) and staff-pin tests, then the full suite.

**Risks:**
- **Web Crypto async:** a person could tap twice during the 50 ms. Covered by step 3. A till without Web Crypto falls back to the step 1 speed.
- **Excluding one file from obfuscation:** the hash code becomes readable in the shipped build. It is a published standard, and no secret is in it.
- **Step 4** touches the Sell list: it is covered by the POS search and cart e2e tests.

**Expected after the fix (UNVERIFIED until Stage B measures it):**
- Sign-in and unlock: about 0.1–0.5 s on small data at 6×.
- Large data at 6×: depends on step 4 and the cap decision.

## 7. Before Stage B: two decisions for the owner

1. **Build number.** v30 is already used by the uncommitted "staff managers everywhere" work in the working tree (src/roles.js, sw-pwa.js, the new migration 20261108120000, tests). Choose:
   - (a) The freeze fix goes on top as **v31**, previews only, and the v30 work ships with it while its migration stays unapplied (the v30 code falls back to v29 behaviour before the migration).
   - (b) Or the v30 work is set aside and the freeze fix ships alone as **v30**.
2. **The Sell list cap** (step 4): yes or no.

---

# Stage B: the fix (v30, 2026-10-20)

The owner's decisions:
- The freeze fix ships **alone as v30**. The "staff managers everywhere" work is on the branch `wip/staff-managers-everywhere`; its migration is not applied.
- Sell shows **the first 200 products**.
- A till registered with seiGEN as a remote **may not switch itself to Main**.

## What changed

**PIN and Admin passcode checks**
- `src/passcode-check.js`
  - The whole file is between `// javascript-obfuscator:disable` and `// javascript-obfuscator:enable`, so the shipped builds keep the hash as written.
  - New `adminCheckMatchesAsync` / `adminCheckMakeAsync`: Web Crypto PBKDF2, off the UI thread, with the file's own code as the fallback. Same rounds, same bytes.
- `src/roles.js`
  - Sign-in: `attemptShopSigninAsync`, one check at a time. The person's row is read again after the check, so wrong tries made meanwhile still count toward the lockout.
  - "Sign in to manage staff": `staffManageSigninAsync`.
  - Setting a PIN (`adminCheckMakeAsync`).
  - The first-manager rule: `findAdminAsync`.
- `src/staff.js`
  - New `findAdminAsync`.
  - The PIN screen shows "Checking…". Unlock, Back and Cancel are disabled while the check runs; a second tap does nothing.
- `src/settings.js`: Unlock shows "Checking…" (`findAdminAsync`) and is disabled meanwhile; a wrong passcode re-enables it.

**Remote → Main (`src/settings.js`)**
- Save writes every setting of the card in one transaction: all of them or none, with "Nothing was changed" on a failure.
- The branch type change is written to the audit log.
- A registered remote can't pick Main (details below).

**Sell list (`src/pos.js`, `src/shared-stock.js`)**
- The first 200 products, then "Showing 200 of N — search, or Show more" (+200 each tap). A new search starts again at 200.
- The shared-stock settings are read once per list (`ssListState`).
- Search and barcode are unchanged.

**Version:** `sw-pwa.js` build v30.

## The "registered remote can't make itself Main" rule: every place it touches

The rule applies when the till is registered with seiGEN (it has a `terminal_id`) and its branch isn't the business's main branch on seiGEN (`terminal_is_main` isn't "1").

| Place | What happens |
|---|---|
| Settings → Shop details → Branch type (`src/settings.js`) | **Changed:** Main can't be picked, and the screen says "🔒 Branch type is set for the whole business. Ask the Owner, or seiGEN support." |
| The same card's Save (`src/settings.js`) | **Changed:** if Main is forced anyway, the same message plus "Nothing was changed."; no setting of the card is saved |
| First setup (`src/setup.js:209`) | Unchanged: the till isn't registered yet |
| Joining with a join code (`src/setup.js:127`) | Unchanged: the type comes from seiGEN (main or not) |
| seiGEN moves the till's business (`src/terminal.js:145-146`) | Unchanged: seiGEN's own decision |
| Backup → Replace (`src/backup.js`) | Unchanged, and already safe: a remote refuses any data file that isn't from a remote, so a Replace can't make it Main |
| Backup → Merge (`src/backup.js`) | Unchanged: a merge never copies settings |
| Unregistered (offline-only) tills | Unchanged: they switch as before |

## Timings before and after

Same scripts, same PC. Times are in seconds; the longest single task (the frozen time) is in brackets.

| Build | Data | CPU | Sign-in (cold) | Sign-in (warm) | Settings unlock | Save Main |
|---|---|---|---|---|---|---|
| Build 29 (preview) | small | 1× | 16.7 (16.6) | 16.8 | 17.2 (17.1) | 0.11 |
| **v30 phone build (obfuscated)** | small | 1× | **0.27 (0.14)** | **0.13 (0)** | **0.20 (0)** | 0.18 |
| Build 29 | small | 4× | 75.9 (75.7) | 75.7 | 75.9 (75.8) | 0.62 |
| **v30** | small | 4× | **0.78 (0.54)** | **0.25** | **0.57 (0.20)** | 0.70 |
| Build 29 | small | 6× | 110.4 (110.2) | 106.8 | 109.6 (109.5) | 0.91 |
| **v30** | small | 6× | **1.10 (0.92)** | **0.24** | **1.05 (0.50)** | 1.08 |
| Build 29 | large | 1× | 21.6 (21.5) | 21.6 | 16.7 (16.6) | 0.17 |
| **v30** | large | 1× | **0.44 (0.29)** | **0.41** | **0.20 (0.08)** | 0.25 |
| Build 29 | large | 6× | 160.5 (159.6) | 158.2 | 104.6 (104.5) | 1.51 |
| **v30** | large | 6× | **3.22 (2.77)** | **2.25** | **0.92 (0.61)** | 1.37 |
| Build 29, desktop file | small | 1× | 17.5 | – | – | – |
| **v30 desktop build** | small | 1× | **0.19 (0.11)** | – | – | – |

The raw results are in `2026-10-20-stage-a-results.jsonl` (before) and `2026-10-20-stage-b-after.jsonl` (after).

- **Target met everywhere except one case.** Sign-in and switching take ≤ 2 s on this PC with local data, small and large, and up to 6× slower on the small shop.
- **The one miss:** large shop, 6×, cold sign-in: **3.2 s, about 2.8 s of it frozen.**
  - What's left is drawing the Sell screen. Searching the products still reads all 5,000 rows on every draw (`searchProducts`, `src/pos.js`).
  - **UNVERIFIED:** the split between that read and drawing the 200 rows; not profiled after the fix.
  - A follow-up could make the product query return only the rows needed. It is not in this fix.

## Does the obfuscator slow the sale or the search? (measure only, nothing changed)

`tools/perf/sale-search-e2e.js` runs the same v30 code in two builds: `dist/index.html` (plain) and `dist-pwa/index.html` (obfuscated). It measures:
- **Search:** each keystroke of "prod 42", total and slowest.
- **Sale:** Add → Cart → Cash until the sale is saved, median of 5.

| Data | CPU | Search total, plain / obfuscated (s) | Slowest key (s) | Sale commit median (s) |
|---|---|---|---|---|
| small | 1× | 0.046 / 0.050 | 0.010 / 0.009 | 0.059 / 0.068 |
| small | 6× | 0.47 / 0.48 | 0.11 / 0.10 | 0.51 / 0.45 |
| large | 1× | 1.19 / 1.43 | 0.19 / 0.26 | 0.27 / 0.27 |
| large | 6× | 10.3 / 10.9 | 1.70 / 1.74 | 1.93 / 2.06 |

Raw results: `2026-10-20-sale-search.jsonl`.

- **Control-flow flattening doesn't noticeably slow the search or the sale:**
  - **Large data:** 0–20% slower, within run-to-run noise.
  - **Small data at 6×:** the obfuscated build was even faster in the sale.
  - That is unlike the hash, which was 40× slower. The search and the sale spend their time in SQLite (WebAssembly, never obfuscated) and the DOM, not in tight JavaScript loops.
- **A separate finding: search is slow on a 5,000-product shop with a slow CPU (1.4–1.7 s per key at 6×), whatever the build.**
  - Each keystroke reads every product and filters them in JavaScript.
  - Not changed here; a candidate for its own fix.
