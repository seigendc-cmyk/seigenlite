# Multi-terminal sync — Phase 1 plan (revised after Phase 0)

Status (2026-10-04): **built, tested, and the migration is applied to the live project** (urbopdsubwawtybwrxjd, 09:26:41 UTC, one transaction). Committed on branch `phase1-multi-terminal-identity`. Not pushed, not deployed; the owner tests on two real devices first. `LONG_INSTALL_ID` stays off until the Console check is confirmed.

## Applied to live (2026-10-04)

1. **Backup first (read-only):** `docs/multi-terminal/live-backup-2026-10-04T09-25-57-177Z/` holds the live `cl_device_checkin` definition, all 21 `cl_vendors` rows as CSV, and a manifest with sha256s. The folder is gitignored and never committed: it contains secret phrases. The live function body was identical to the one the rollback restores.
2. **Applied** `supabase/migrations/20261004120000_multi_terminal_identity.sql` in one transaction (0.7 s).
3. **Verified afterwards.** Catalog checks were read-only. Behaviour checks ran as `anon` inside a transaction that was rolled back, so nothing they wrote persisted.
   - The 5 new tables have RLS on, 0 policies, and no select/insert for anon or authenticated. Reading them as anon gives "permission denied".
   - `cl_vendors.business_id` (uuid) and `device_key` (text) were added, both nullable.
   - The 5 device RPCs are SECURITY DEFINER and executable by anon.
   - `cl_vendor_clear_device_key` is executable by authenticated only, not anon.
   - The 7 internal helpers aren't executable by anon or authenticated. Calling `cl_install_vendor` as anon gives "permission denied".
   - The only `cl_device_checkin` left is the new 10-argument one.
   - An existing vendor (install 8FJM) checking in with today's app call shape (no `p_device_key`) **succeeded**, returning the old keys plus `business_id: null, terminal_id: null`.
   - The same check-in with the phrase in lower case and padded with spaces also succeeded. A wrong phrase is still refused.
   - Its `device_key` stayed null, and after the rollback its `last_checkin_at` was unchanged.
   - Counts afterwards: 21 vendors, 0 businesses, 0 terminals, 0 keys recorded. Nothing changed for existing shops.
4. **Rollback, if ever needed:** `supabase/rollbacks/20261004120000_multi_terminal_identity.rollback.sql`.

## Follow-ups

- **(a) Deactivate a till.** An RPC (main-branch tills only, same phrase + device_key check), e.g. `cl_terminal_set_active(install, phrase, key, terminal_id, active)`, that sets `cl_terminals.active`. Plus a Settings action on each till in the Terminals list (main only). An inactive till should be refused by the terminal RPCs, and later by sync. Check-in keeps working, because licensing is per install.
- **(b) Server-side branch-name normalisation matching the app.** `cl_branch_key()` currently keeps letters and digits only, case-insensitive. The app's `sanitizeBranchName()` (`src/docnum.js`) also folds accents (NFKD) and caps at 24 characters. Make the server do the same (e.g. `unaccent` or a translate table, plus `left(…, 24)`), so names that differ only by accents or past character 24 are one branch on both sides. This needs a migration that rebuilds `cl_branches_name_uidx` and checks for existing collisions first.

## Owner decisions, round 2 (2026-10-04)

| # | Decision |
|---|---|
| 1 | **Approved:** device_key instead of the device-code rule, **plus** a way to clear a vendor's recorded key so a legitimate device that lost it can be re-admitted. See "Re-admitting a device that lost its key" below. |
| 2 | **Approved:** branch-name check on join. The refusal says the branch name doesn't match and asks main to check the name; the code stays usable. |
| 3 | **Approved:** `audit_log` gets a uid, and merge carries it. |
| 4 | **Approved:** tapping Support writes a local audit_log line. |
| — | **Approved:** pause `rpn_link` and `support_task` as recommended. |
| — | **Console check:** the answer came back as the unfilled template (`[RESULT: …]`), so it's treated as **not confirmed**. `LONG_INSTALL_ID` stays **false** (`src/terminal.js`); new installs keep 4-character install IDs. Flip that one constant once the Console shows `AR9W21` for `ABCD2345-C1` / `TEST`. |

## Re-admitting a device that lost its key

A device is refused with "This install ID is already registered to another device" when Digital Commerce has a `device_key` recorded for its install ID and the device sends a different one, or none. This is legitimate when the app's data was cleared and then restored from a backup made before Phase 1, or when the install ID was typed back in by hand.

**Option A, in the Console (staff with the Vendors module, or a sysadmin), signed in with cl_login:**
```sql
select public.cl_vendor_clear_device_key('<vendor uuid>', 'phone reset, confirmed with owner by phone');
```
- It refuses anon and staff without the Vendors module.
- It logs to `cl_activity_log` (`action = 'vendor_device_key_cleared'`, with the install ID and the reason).

**Option B, in the Supabase SQL editor (owner / service role), when the Console isn't available:**
```sql
update public.cl_vendors set device_key = null where install_id = '<INSTALL ID>';
```
- Nothing is logged with this option. Note who did it and why somewhere you keep records.

**Either way:** the device's next check-in (at launch, on reconnect, or Settings → Save phrase) records its current key again. **Check with the shop first** that the device asking is really theirs: clearing the key lets whichever device checks in next claim that install ID.
Inputs: [phase0-report.md](phase0-report.md) and the owner's answers of 2026-10-04 (recorded in phase0-report.md §8).
Draft SQL for review: [phase1-migration-draft.sql](phase1-migration-draft.sql), [phase1-rollback-draft.sql](phase1-rollback-draft.sql).
Draft check: [phase1-draft-smoke.mjs](phase1-draft-smoke.mjs) runs both against in-memory PGlite (never live): **34 passed, 0 failed**.

**Goal (unchanged):** every device knows its business, branch and terminal; every syncable row has a stable uid; a second terminal can join a branch. Selling, stock, numbering, EOD and the existing file exchanges behave exactly as before. Nothing new syncs yet.

---

## Needs your OK before I start (4 items)

1. **Q3 device-code guard, done a different way.** You asked check-in to refuse "when the install_id matches but the device code differs". The device code is `install_id-C<cycle>` (`src/activation.js:23-28`), and check-in overwrites the stored code on every call. So that rule would lock every shop out each time its 30-day cycle rolls over (C1 → C2). And two colliding devices share the same prefix, so it wouldn't catch them either.
   - **Proposed instead:** each install makes a random `device_key` once, and sends it with check-in and every new RPC. The server records it the first time it sees it and refuses a different (or missing) key for that install_id afterwards.
   - The draft tests show this refuses another device, accepts the same device at its next cycle, and leaves old app versions working until their key is recorded.
2. **`p_expected_branch_name` on join.** An existing remote device's branch name is locked locally because DN keys carry it. If main typed the branch differently when issuing the code, the join is refused with `BRANCH_NAME_MISMATCH` and the code stays usable. Server branch names are compared the way `sameBranchName()` does: letters and digits only, case-insensitive.
3. **Add `uid` to `audit_log` too.** It's merged between devices like the other tables (`src/backup.js:444-448`). Say no and I leave it out.
4. **A local audit line when Support is tapped**, since the paused outbox no longer records it (see 1E). Say no and I drop it.

## Still unverified: the Console's activation-code tool and longer device codes (Q3)

- **Server side, VERIFIED (read-only, live):**
  - `cl_issue_activation_code(p_vendor_id uuid, p_device_code text, p_computed_code text, …)` stores `device_code` as plain `text`, with no length or format check.
  - `cl_activation_codes` has no CHECK constraints or triggers, and holds **0 rows**: no code has ever been issued through the Console.
  - The only CHECK constraint touching `install_id`/`device_code` anywhere is `vendor_tokens.install_id` being non-empty.
  - All 21 live `cl_vendors.device_code` values have the 4-character shape `XXXX-C<n>`.
- **App side, VERIFIED:**
  - `computeActivationCode` accepts any length (`src/activation.js:1-7`).
  - The publish portal accepts install IDs up to 100 characters (`tools/publish-portal/scl.js:53`).
  - iTred `vendors.install_id` is unconstrained `text`.
- **UNVERIFIED: the Console's own screen.** The Console computes `p_computed_code` in its browser code, and that code isn't in this repository or anywhere I searched on this machine. I can't see whether its input field limits length or pattern-matches `XXXX-C<n>`. To close this, either point me at the Console source, or issue a test code in the Console for a made-up device code such as `ABCD2345-C1` with the secret phrase `TEST`. The app's formula gives `computeActivationCode("ABCD2345-C1","TEST")` = **`AR9W21`**. If the Console accepts the input and shows `AR9W21`, the longer codes work end to end.
- Until that's confirmed, **step 1B-4 (longer install_id for new installs) stays switched off** behind one constant, and everything else ships.

---

## 1A. Supabase migration (draft attached; applied only after you approve the SQL)

Implements Q1/Q2/Q3 exactly as answered.

- **`cl_businesses`**: id, name, `secret_phrase_hash` (bcrypt of `upper(btrim(phrase))`), `created_by_vendor_id` (unique: one business per main install), created_ts.
- **`cl_vendors` gets two nullable columns:**
  - `business_id` → cl_businesses.
  - `device_key` (the collision guard).
  - Still one row per install. Nothing is deleted or merged, and billing and activation rows are untouched.
- **`cl_branches`**: business_id, name, is_main, `legacy_branch_id` (format `B-XXXXXXXX`), created_ts. Branch names are unique per business, compared by the `sameBranchName` rule. At most one main branch per business.
- **`cl_terminals`**: business_id, branch_id, `vendor_id` (this install's own row, unique), `install_id` (unique), `till_code` (T1, T2, … assigned server-side in order, unique per branch), label, registered_ts, last_seen_ts, active.
- **`cl_branch_join_codes`**: 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no I/L/O/0/1), shown as `XXXX-XXXX`. Stored as sha256, single-use, expires after 24 h (1–72 h allowed).
- **`cl_join_failures`**: after 10 wrong codes in an hour from one install, that install is refused for the rest of the hour.
- **Locked down:**
  - RLS is on, with no policies.
  - Access to the new tables is **explicitly revoked** from public/anon/authenticated, because this project's default privileges grant everything to anon (VERIFIED, `pg_default_acl`).
  - Internal helpers have EXECUTE revoked.

**RPCs** (SECURITY DEFINER; every one goes through one shared check, `cl_install_vendor`, which check-in now uses too):

| RPC | Who | What |
|---|---|---|
| `cl_branch_register(install, phrase, key, business_name, branch_name, legacy_branch_id, label, device_code)` | the main install | Creates the business, its main branch and its own T1. Idempotent. `p_is_main` from the original brief is dropped: per Q1 only main registers, and everyone else joins. |
| `cl_branch_issue_join_code(install, phrase, key, branch_id \| new_branch_name, valid_hours)` | main-branch terminals only (decided on the server) | Code for an existing branch (another till for main, or another till for a remote), or for a new remote branch by name (from main's branch register). Returns the plain code once. |
| `cl_terminal_join(install, business_phrase, key, code, label, legacy_branch_id, device_phrase, device_code, business_name, expected_branch_name)` | new terminals and existing remote devices | Links this install to the code's business and branch. Creates this install's own `cl_vendors` row only if it has none, never a business. An existing remote device keeps its own vendor row and its own phrase (`p_device_phrase`). Every refusal happens before anything is written. Refusals come back as `{error: JOIN_CODE_INVALID \| JOIN_CODE_USED \| JOIN_CODE_EXPIRED \| PHRASE_MISMATCH \| BRANCH_NAME_MISMATCH \| ALREADY_JOINED \| OTHER_BUSINESS}`, so the failure counter survives. Too many failures raise `JOIN_LOCKED`. |
| `cl_branch_list(install, phrase, key)` | any terminal of the business | Branches of the business (decision 4). Each branch's terminals are included only for main-branch callers. |

**`cl_device_checkin` changes** (full before/after in the two draft files):
- Phrase is compared with `upper(btrim())` (Q2).
- Takes an optional `p_device_key` (Q3 as proposed above).
- Updates `cl_terminals.last_seen_ts`.
- Two new keys in the reply: `business_id` and `terminal_id`. The app ignores keys it doesn't know.
- The old 9-argument function is **dropped and recreated** with a 10th, defaulted argument. PostgREST can't choose between overloads that differ only by a defaulted argument. Old app versions keep working because they don't send the 10th argument.
- Data check: making the comparison case-insensitive doesn't newly refuse or newly accept any live row. The 21 rows have 9 distinct phrases case-insensitively, and each row is only ever compared with itself.

**Applying:**
1. You approve the SQL.
2. It goes to `supabase/migrations/2026100X120000_multi_terminal_identity.sql`, with the rollback in `supabase/rollbacks/` and the PGlite test in `supabase/tests/multi-terminal-identity-test.js` (grown from the smoke test, following the stub style of `onboarding-notes-test.js`).
3. The test passes in PGlite.
4. You (or I, on your word) run it once in the SQL editor, in one transaction. The project has no migration history table (VERIFIED).
5. A read-only check afterwards confirms the objects and grants.

## 1B. Local schema and identity (`src/db.js`, additive only)

1. **`uid TEXT`** on: sales, sale_items, sale_payments, products, customers, payouts, credit_payments, stock_received, stock_adjustments, stock_transfers, purchases, eod_sessions, staff, vouchers, stock_requests, stocktakes, stocktake_counts, dispatch_docs, dn_events, dn_cases (+ audit_log if item 3 is OK'd).
   - Added with the existing try/catch `ALTER` pattern.
   - Backfilled once with `UPDATE t SET uid=lower(hex(randomblob(16))) WHERE uid IS NULL`. Each row gets its own value (proved in node:sqlite), and re-running changes nothing.
   - A partial unique index on `uid` per table.
2. **Stamped by `AFTER INSERT` triggers created in `migrate()`**, as you decided, so it also works on databases opened during merge or replace. This follows the `products_price_ts_*` precedent at `src/db.js:362-367`. One trigger per table:
   - Fires `WHEN NEW.uid IS NULL`.
   - Sets `uid=lower(hex(randomblob(16)))`.
   - On the 7 transaction tables it also sets `terminal_id` and `branch_uuid` from `settings`, both NULL until the device is registered.
   - **Rows inserted with a uid already set (that is, merged rows) are never stamped with this device's terminal.**
   - Proved in node:sqlite: per-row values, carried uid left alone, composite-key table (`dispatch_docs`) works through its rowid.
   - Phase 1 tests also prove `last_insert_rowid()` (the receipt number, `src/pos.js:522`) is unchanged by the trigger.
   - With triggers there's no `newUid()` JS helper and none of the ~60 insert call sites change.
   - The uid is 32 hex characters, not dashed. Postgres `uuid` accepts that form unchanged (VERIFIED in PGlite).
3. **`terminal_id TEXT`, `branch_uuid TEXT`** on sales, payouts, credit_payments, stock_received, stock_adjustments, eod_sessions, purchases. Old rows stay NULL, meaning "pre-terminal".
4. **New settings:**
   - `business_id`, `business_name`, `branch_uuid`, `terminal_id`, `till_code`, `terminal_label`, `device_key` (32 hex characters from `crypto.getRandomValues`, made once, on first need).
   - **New installs:** `install_id = uid4()+uid4()` (8 characters, 2^40 values), behind one constant. It stays at 4 characters until the Console check above is closed.
   - **Unchanged:** `getBranchId()`, `branch_id`, `tenantId()`, existing `install_id` values and `src/activation.js`.
5. **`mergeDatabase` carries uid (Q4)**, plus `terminal_id`/`branch_uuid` where present, on all 13 merged tables.
   - A row whose uid already exists locally is skipped. This check runs before the existing natural-key rules, which stay exactly as they are.
   - Files from older versions get uids when they're opened (the merge already runs `migrate()` on the imported database, `src/backup.js:322`), so their rows arrive with a uid too.
   - Limit: those uids are made on the receiving device, so they won't equal the ones the origin device later gives the same rows. The natural-key rules still prevent duplicates. Phase 3/6 baseline uploads must reconcile by natural key for pre-upgrade rows.
6. **Replace stays as it is.** It already adopts the file's `install_id`; `device_key` and the terminal ids travel with it as a pair. Changing that would break "restore my backup onto a new phone".

## 1C. UI

**Settings → "Business & Terminals"** (main and remote; remote sees it inside the unlocked Settings, like the other cards). It reuses the existing card, button, `openModal` and alert patterns and the orange theme.

| State | Shows |
|---|---|
| not registered, main device | "Register this branch" → `cl_branch_register` with the shop name, the locked branch name and the legacy `branch_id` |
| not registered, remote device | "Join your business": business phrase + code from main → `cl_terminal_join` with `p_device_phrase`, `p_expected_branch_name` = this device's locked branch name, and the legacy `branch_id` |
| registered | business, branch, till code, terminal ID, "Registered" / last checked |
| registered, main branch | **"Add a terminal"**: pick this branch, a branch from the register, or type a new branch name → the code shown large as `XXXX-XXXX` with its expiry, plus **Copy** and **Share on WhatsApp** (text only, the code, never a file) |
| registered, main branch | terminals list from `cl_branch_list` (till, label, last seen) |
| offline | "Connect to the internet once to register this terminal." All offline selling still works. |
| loading / wrong phrase / used, expired or invalid code / name mismatch / locked out / server error | plain-English line for each `error` value |

**Setup:** a third button next to Main Branch / Remote Branch: **"Join an existing branch"**.
- Fields: shop's secret phrase, join code, a name for this till (e.g. "Till 2").
- Setup creates the install the usual way, with the same 30-day activation as today (1D), then calls `cl_terminal_join`.
- On success it stores the returned ids, `shop_name` = business name, `branch_name` = branch name, `branch_type` = main or remote from `is_main`, and `secret_phrase` = the typed phrase. It then finishes setup with no product step.
- On screen: "This till starts with no products. Sharing products between tills comes in a later update." (A till on a remote branch can still use the existing Get catalogue.)
- Join needs the internet; offline, the step says so and stays put.

**Check-in** sends `p_device_key`, and stores `business_id`/`terminal_id` from the reply when present. The new refusal "already registered to another device" gets its own line in `dcCheckinProblemText`.

## 1D. Licensing — unchanged

Each terminal is still its own install with its own device code and 30-day activation. `src/activation.js` is not touched. The only licensing-visible change is the longer device code for **new** installs, and only once the Console check is closed.

## 1E. Stop the dead outbox: **pause** `rpn_link` and `support_task` (recommended over RPCs)

Evidence:
- **Nothing on the server can receive or read them.** VERIFIED live: the tables `rpn_link`, `support_task` and `sync_health_check` don't exist. No live function and no file under `supabase/`, `tools/` or `src/fieldguide/` mentions them.
- **The server already models the RPN link properly**, and differently: `cl_vendors.rpn_id` → `cl_rpn`, set by Console staff (`cl_onboarding_note_to_vendor`) or by check-in's `p_rpn_hint_id` (sent as `null` today, `src/devicecheckin.js:120`). `rpn_link` is free text typed by the shop (`src/rpn.js:33-47`) with no lookup.
- **Support never depended on the queue.** The Support button opens WhatsApp to the RPN (`src/rpn.js:107-131`); the queued `support_task` is only a log nobody reads.
- RPCs would mean building write-only tables that nobody reads, just to drain a queue.

Change:
1. `registerSyncType(…, { paused:true })` for both types; `enqueueSync` on a paused type returns `null` and writes nothing, so `sync_queue` stops growing.
2. A one-time `migrate()` step marks existing pending/failed rows of those two types `status='paused'`. The rows are kept, not deleted. All existing queue readers filter `status IN ('pending','failed')` (`src/sync.js:103-109,177`), so the backlog leaves the Cloud sync card and the offline toast immediately.
3. RPN details are still saved in settings and editable; Support still opens WhatsApp; plus a local audit line (item 4).
4. Tests whose assertions change, listed up front: `test/rpn-support-modal.test.js:37-62, 98-117, 147-148` and `test/sync-queue.test.js:71-73`. They will assert "paused: nothing queued, settings saved, WhatsApp opened" instead. Every other sync-queue behaviour stays covered through `sync_health_check`.

Later (not Phase 1): send the RPN code through check-in so the server can resolve it to `cl_rpn.id`.

## 1F. Out of scope (unchanged from the brief)

Per-till numbering, stock ledger, pushing or pulling data, per-till EOD, cross-branch stock view, retiring file exchange, first-sync baseline, licence changes, **and the zero-stock sale block** (left alone as decided; Phase 4 removes it).

## 1G. Verification before I report done

- `node build.js --pwa` and `node build.js --tauri` succeed, and both `dist-pwa/` and `dist-tauri/` are regenerated (they're committed, so the diff will be large and non-deterministic).
- **Baseline:** all 51 `test/` suites, expecting 51/51 in the main checkout. The suites listed in 1E change on purpose. The 3 existing `supabase/tests` keep passing in PGlite.
- **New tests**, following `test/harness.js`, `test/dc-fake.js` and a fake Supabase, never production:
  - **uid backfill:** every row gets a unique uid, and running `migrate()` twice changes nothing.
  - **Trigger:** a new sale gets a uid plus `terminal_id`/`branch_uuid` from settings, and the receipt number equals `last_insert_rowid()` exactly as before.
  - **Merge:** uid carried, merged rows not stamped with the local terminal, a second merge of the same file adds nothing, and an old-version file gets uids.
  - **Paused outbox:** no rows are added; the existing backlog becomes `paused` and drops out of the counts.
  - **Playwright join flow:** Setup → Join an existing branch → success. Also: wrong code, used code, expired code, offline, name mismatch.
  - **Playwright, Settings:** "Register this branch" (main); "Add a terminal" shows a `XXXX-XXXX` code; the terminals list; a remote device joining.
  - **Regressions:** `.sqlite` export, merge, replace, DN dispatch, receive, GRV import and cancel/reissue behave exactly as before (the existing suites, plus a uid-aware merge round-trip).
  - **`supabase/tests/multi-terminal-identity-test.js`** in PGlite, covering every refusal and the rollback.
- **Visual check:** open both builds, screenshot the Business & Terminals card in each state and the new Setup choice, and report what I actually saw (including the 8-character device code on the lock screen at phone width, once enabled).
- The final report uses the protocol format: Inspected / Changed / UI Wiring / Tested / Visually Verified / Verified / Not Verified / Failures / Assumptions / Risks.

## Risks still open

- **The Console's activation screen and longer device codes:** unverified (see top).
- **Join codes are bearer secrets for 24 h.** Anyone holding a code plus the business phrase can add a till. Mitigations: single use, expiry, per-install failure limit, and main sees every till in its list. There's no "deactivate till" button in Phase 1; that's a one-line follow-up RPC if you want it now.
- **Replacing one device's data with another live device's file** (same branch name) makes the two devices share an install and terminal identity. That already happens today with install_id. Not changed in Phase 1.
- **Server branch names ignore accents and the 24-character cap** that the app applies; names differing only that way would be two branches on the server.
- **Phrases stay in plain text** in `cl_vendors.shop_secret_phrase`, as today. Only the new business phrase is hashed.
