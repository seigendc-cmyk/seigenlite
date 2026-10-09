# RPN Vendor Onboarding Form — build report (2026-10-09)

Branch: `rpn-onboarding-form` (from `main` @ `4f4a75a`). Built in a cloud copy of the repo, not on the owner's PC.
Decisions applied: **D1** new table · **D2** RPN logs the monthly amount from the features taken, office confirms · **D3** built here, pushed to a branch · **D4** RPN self-update hole fixed first.

## Not done yet — needs you

1. **Neither migration is applied to the live database.** No database access from this session. Apply in this order, from your PC:
   1. `supabase/migrations/20261009150000_rpn_self_update_guard.sql`
   2. `supabase/migrations/20261009160000_rpn_onboarding_records.sql`
   Until (2) is applied, the new form saves on the phone but every send fails ("The Console refused this…" / 404).
2. **Console office-verification page (Section 5 screen) is not built.** The Console source is not in this repo. The database side is ready: `cl_list_onboarding_records()` and `cl_verify_onboarding()`.
3. **dist-rpn is not deployed.** Pushing the branch does not publish it; deploy `dist-rpn/` the way you normally do after merging.

## Inspected

`src/fieldguide/*` (app, field-ui, outbox, console-api, store, CSS), `build.js` (buildRpn), `shell/rpn-head.html` via build, `supabase/migrations/20260923000000_baseline.sql` (cl_vendors, cl_rpn + policies, cl_ledger_entries, cl_activity_log, cl_modules), `20261003120000_rpn_onboarding_notes.sql` + its PGlite test, existing Field Guide unit and Playwright tests, Commerce Lite `src/` for the feature inventory (Phase 0 report).

## Changed

| File | Why |
|---|---|
| `supabase/migrations/20261009150000_rpn_self_update_guard.sql` (+ rollback) | D4: trigger so an RPN updating their own `cl_rpn` row through the API can change only `phone` and `city`. Staff and SECURITY DEFINER functions unaffected. |
| `supabase/migrations/20261009160000_rpn_onboarding_records.sql` (+ rollback) | D1: table `rpn_onboarding_records`, RLS read-own, no direct writes; `cl_rpn_save_onboarding` (RPN), `cl_list_onboarding_records` + `cl_verify_onboarding` (staff, `vendors` module). Does not change `cl_vendors`, ledger, billing, commission. |
| `src/fieldguide/onboarding.js` (new) | Form definition (4 sections), checks, offline record store, sending, office-answer pull. |
| `src/fieldguide/onboarding-ui.js` (new) | Screens: start, record overview, section forms, submit. |
| `src/fieldguide/console-api.js` | `consoleSaveOnboarding`, `consoleFetchOnboardingStatus`. |
| `src/fieldguide/outbox.js` | Three guarded hooks: records sent in the same run after notes, wake-up times, resume after sign-in. |
| `src/fieldguide/store.js` | IndexedDB v3: adds a `records` store (upgrade only adds). |
| `src/fieldguide/field-ui.js` | Field list shows the "Vendor onboarding" block; `#/field/ob/…` routes; background redraw never touches the forms. "New onboarding note" button is now the outline style under its own heading. |
| `src/fieldguide/app.js` | Routes `o-…` clicks/submits and `ob-field` typing; boots `obInit()`. |
| `src/fieldguide/fieldguide.css` | Styles for the new screens. |
| `build.js` | Adds the two new files to `RPN_SCRIPTS`. |
| `dist-rpn/index.html`, `dist-rpn/sw.js` | Rebuilt (`node build.js --rpn`). Also picks up shop-app `styles.css` changes that the committed dist-rpn was missing. |
| `supabase/tests/rpn-console-stub.js`, `…/rpn-self-update-guard-test.js`, `…/onboarding-records-test.js` | PGlite tests (never the live DB). |
| `test/fieldguide-onboarding-record.test.js`, `test/fieldguide-onboarding-record-e2e.test.js` | Node and Playwright tests for the form. |

No file under `src/` outside `src/fieldguide/`, and nothing in `dist-pwa/`, `dist-tauri/`, `src/activation.js` was changed (`git status`).

## The form (what the RPN fills in)

1. **Vendor & plan** — business, owner, phone, city, area, type, plan (Business / Lite), branches (Lite = 1), tills (≥ branches), features taken, **monthly subscription (USD)**, first visit date. Can start from an onboarding note (details copied; linked if the note was sent).
2. **Installation & activation** — devices (type, installed as, branch, till, result; reason if failed; add/remove), secret phrase set (yes/no only), join codes used, activation requested (+ date), printer (none/USB/Bluetooth; test print if a printer). No phrases or codes are stored.
3. **Implementation & stocktake** — product source, products loaded, issues, stocktake done (+ date, lines, variances), staff set up, single-operator mode, first shift/EOD, backup explained, debtors' balances.
4. **Training & handover** — sessions (date, minutes, staff), 15 modules each Not covered / Needs help / OK / Confident, support contacts, still to do, follow-up date, vendor's full name + confirmation tick + date, RPN declaration tick.
5. **Office (Console)** — approve (needs a Vendors Register link; optional first payment = an existing `payment` ledger entry of that vendor ⇒ "commission eligible"), return (reason), reject (reason). Logged in `cl_activity_log`.

Statuses the RPN sees: Saved on phone · Sending… · Draft sent · Failed - retry · Sign in to send · Submit waiting · With the office · Returned to you (with the reason; editable again) · Verified · Rejected.

## UI wiring (each traced and exercised in the browser test)

- **Start vendor onboarding** → click `[data-act=o-new]` → `obAction` → route `#/field/ob/new` → `obStartHtml` → **Start blank / a note** → `obCreate` → IndexedDB `records` put → Section 1 shown.
- **Typing** → `input` on `#fgMain` → `obInput` → `obSetValue` (record in memory, `savedAt` bumped, stored after 400 ms) → choices that show/hide fields redraw with focus kept. Survives offline/online and reload (tested).
- **Save and continue** → form submit `o-save` → `obSubmitForm` → `obSaveSection` (errors shown, stored, `kickOutbox`) → errors: summary + first field focused; OK: next section. Outbox → `obPass` → `consoleSaveOnboarding` → RPC `cl_rpn_save_onboarding` → status from the reply.
- **Add / Remove device or session** → `o-add` / `o-remove` (+ confirm dialog) → `obAddItem` / `obRemoveItem` → redraw; new item's first field focused.
- **Submit for verification** → `o-submit` → confirm dialog → `obSubmit` (only when all 4 Done) → locked on the phone → RPC with `p_submit=true` → "With the office"; section forms read-only.
- **Office answer** → `obPull` (signed in; at most once a minute, and on every app start) → GET own `rpn_onboarding_records` → `obApplyServer` → "Returned to you" + reason, record unlocked; or Verified / Rejected.
- **Retry** → `o-retry` → `obRetry` → sent again. **Sign in** → existing sign-in → `obSignedInAgain` → waiting records sent.

## Tested (commands run in this session)

| Test | Result |
|---|---|
| `node supabase/tests/rpn-self-update-guard-test.js` (PGlite) | 17 passed, 0 failed |
| `node supabase/tests/onboarding-records-test.js` (PGlite) | 49 passed, 0 failed |
| `node supabase/tests/onboarding-notes-test.js` (existing) | 43 passed, 0 failed |
| `node test/fieldguide-onboarding-record.test.js` | 21 passed, 0 failed |
| `node test/fieldguide-field.test.js` / `-engine` / `-search` (existing) | 14 / 12 / 13 passed, 0 failed |
| Playwright `fieldguide-onboarding-record-e2e` (new) | 15 passed, 0 failed (run 3 times) |
| Playwright `fieldguide-onboarding-e2e`, `-coach-e2e`, `-search-e2e`, `rpn-shell-e2e` (existing) | 14 / 11 / 11 / 12 passed, 0 failed |
| `node build.js --rpn` | built, 11 src files |

Playwright ran on Chromium 153 from the `@sparticuz/chromium` npm package (this session can't reach cdn.playwright.dev), loaded through a test-only preload outside the repo. On your PC the tests run as before with `npx playwright install chromium`.

## Visually verified

Screenshots inspected at **360×640** and **412×915**: Field list, start screen, Section 1 (empty and with errors), Section 2 (failed device and printer fields showing), Section 3, Section 4, record overview (all Done; submitted; returned with the office's reason). Orange branding, no horizontal overflow, input text ≥ 16 px, controls ≥ 36 px, tick-box rows ≥ 48 px (asserted by the test).

## Verified

- The self-update hole was real (test shows the old behaviour) and is closed by the guard; staff, `cl_rpn_activate`, and phone/city edits still work; rollback restores the old behaviour.
- Records: own rows only; table closed to direct writes; older or repeated copies never overwrite newer ones; a submitted/approved record can't be changed by the RPN; submit needs plan, branches, tills, amount, all four sections and both ticks; Lite = 1 branch and tills ≥ branches enforced by the database; office approve needs a vendor link; only a `payment` entry of that vendor can be linked; returning/rejecting needs a reason; verifying doesn't change `cl_vendors.status` or the ledger; both decisions logged.
- Phone flow end to end against a fake Console that follows those rules.

## Not verified

- Anything against the **live** database (migrations not applied there; live schema compared only through the repo's baseline of 2026-09-23 and later migrations).
- The Console page for Section 5 (not built; Console code not in this repo).
- A real Android phone and installed-PWA behaviour of the new screens (tested in headless Chromium with mobile viewport and touch).

## Failures / findings

- None open in the new code.
- **Existing, not changed:** on the Me tab, the "Works offline" check redraws the screen when it finishes, which wipes a half-typed sign-in name/passcode (`app.js` `checkOfflineReady` → `render`). Seen while testing; the new e2e waits for it. Worth a small fix later.
- The committed `dist-rpn/` was older than `src/styles.css`; this rebuild brings it up to date.

## Assumptions

- Currency of the monthly amount is USD (column defaults to `USD`; the form says "(USD)").
- Drafts are sent to the Console as soon as business name, owner, phone and city are valid, so work isn't lost; the office list hides drafts by default (`cl_list_onboarding_records('draft')` shows them).
- Section 4's module list = Commerce Lite screens found in Phase 0 (no Notepad, no Creditors, no .bkp).
- Approving does not move the vendor to Active; the existing status rules stay in charge.

## Risks

- The guard trigger refuses any RPN-token update of `cl_rpn` columns other than phone/city. If the Console (not in this repo) lets RPNs change their own name or passcode by a direct table update, that will now fail — check before applying. SECURITY DEFINER functions are not affected.
- IndexedDB moves to version 3 on first open of the new build (adds a store only; existing notes and progress kept — the existing tests pass on the upgraded store).
