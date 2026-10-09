# Vendor-delete guard: design (Part B1)

Status: **design only, nothing built.** Waiting for "go Guard-B".
Date: 2026-10-09. All facts below were read from live, read-only, or from the repo.

## Why

On 8 Oct, deleting Weldone Ent in the Supabase dashboard silently deleted its **10 ledger rows and 7 activation codes**. The links were `ON DELETE CASCADE`. Its Cashbook rows stayed behind as orphans, with nothing pointing back at them.

After the financial reset (9 Oct), every money table is empty. That makes now the moment to stop it happening to real money.

## What deletes what today (live, read-only)

The tables that matter, linked to `cl_vendors`, `cl_businesses`, `cl_branches` and `cl_terminals`:

| Child row | Parent | On delete today | Proposed |
|---|---|---|---|
| `cl_ledger_entries.vendor_id` | vendor | **CASCADE** (money deleted) | **RESTRICT** |
| `cl_activation_codes.vendor_id` | vendor | **CASCADE** | **RESTRICT** |
| `cl_vendor_messages.vendor_id` (billing reminders) | vendor | **CASCADE** | **RESTRICT** |
| `cl_licences.vendor_id` | vendor | SET NULL (licence loses its owner) | **RESTRICT** |
| `cl_licences.business_id` | business | SET NULL | **RESTRICT** |
| `cl_licences.terminal_id` | terminal | SET NULL | **RESTRICT** |
| `cl_plan_assignments.vendor_id` / `business_id` | vendor / business | RESTRICT | unchanged |
| `cl_terminals.vendor_id` / `install_id` | vendor | NO ACTION (blocks) | unchanged |
| `cl_businesses.created_by_vendor_id` | vendor | NO ACTION (blocks) | unchanged |
| `cl_branches`, `cl_terminals`, catalogue, stock | business / branch / terminal | NO ACTION (blocks) | unchanged |
| `rpn_onboarding_notes.vendor_id` | vendor | SET NULL | unchanged (notes, not money); the RPN commissions work revisits it |
| `cl_vendors.business_id` | business | SET NULL | unchanged (a business delete is already blocked by its branches and tills) |
| `vendors.install_id` (iTred) | vendor | RESTRICT | unchanged |
| `vendor_listings.vendor_id` → `vendors` (iTred) | iTred vendor | CASCADE | out of scope (the Publish Portal work, Part 2) |

- **The Cashbook** has no foreign key to vendors: `source_id` points by value only. Payments are protected through the ledger. With the ledger restricted, a vendor with payments can't be deleted, so its Cashbook rows can't become orphans.
- **Counts today:**
  - 34 vendors (up from 30: new check-ins from preview and test devices);
  - 7 businesses;
  - 8 branches;
  - 16 terminals.

## The design

### 1. Foreign keys: RESTRICT

Change the six rows marked **RESTRICT** above:
- drop each constraint and add it again with `ON DELETE RESTRICT`;
- use `NOT VALID` then `VALIDATE`, so the check doesn't hold a long lock.

### 2. A plain message before Postgres's own error (`cl_vendor_delete_guard`)

**A BEFORE DELETE trigger on `cl_vendors`.** It runs before the foreign-key check, and it also works in the Supabase dashboard. It counts what the vendor still has (ledger rows, licences, activation codes, reminders, tills, a plan, a business) and raises:

> **Can't delete "Weldone Ent": it has 10 ledger entries, 7 activation codes and 2 licences. Archive it instead (Console → Vendors → Archive). Nothing was deleted.**

**The same kind of trigger on `cl_businesses`:**
> Can't delete "<business>": it has 3 branches, 5 tills and 1 licence. Archive it instead.

**A vendor with no history can still be deleted.** Examples: a duplicate check-in, or a test install that never had a code, licence or payment.

### 3. Archive instead of delete

**New columns** on `cl_vendors` and `cl_businesses`:
- `archived_at timestamptz`
- `archived_by uuid references cl_staff(id)`
- `archive_reason text`

**New staff functions** (security definer; staff token checked; Vendors Register permission or sysadmin):
- `cl_vendor_archive(p_vendor_id, p_reason)` and `cl_vendor_unarchive(p_vendor_id, p_reason)`. The reason is required, 3 to 300 characters.
- `cl_business_archive` and `cl_business_unarchive`, the same.
- **A plain error for each case:**
  - already archived;
  - not archived;
  - not found;
  - no permission.

**Archiving never changes billing records, licences or the device.** An archived vendor:
- is hidden from the Vendors Register by default;
- is left out of the "Plan not set: review" list and the billing reminder lists;
- **can still check in**, so the device keeps working. The Console flags it: "archived, but still checking in (last seen …)". See question 2.

### 4. Every delete and archive is logged

**AFTER DELETE triggers** on `cl_vendors` and `cl_businesses` write to `cl_activity_log`:
- `action`: `vendor_deleted` or `business_deleted`;
- **who:** the staff member from the Console token, or `staff_id = null` with `detail.db_role = current_user` when deleted from the dashboard;
- **what:** a snapshot of the name, install ID, status, business and created-at. **Never the shop secret phrase.**

An **AFTER UPDATE trigger** logs `vendor_archived` / `vendor_unarchived` and `business_archived` / `business_unarchived`, with the reason.

### 5. Console (branch `console-b`, preview only)

- **Vendor card:**
  - **Archive** (asks for a reason), and **Unarchive** on archived vendors;
  - an "Archived on … by …: reason" banner.
- **Vendors Register:**
  - a **"Show archived"** toggle, off by default;
  - archived rows greyed, with an "Archived" badge.
- **Business view:** the same Archive and Unarchive.
- **Plain messages from the server are shown as they are.** Examples: "Can't delete … archive it instead", "Give a reason (at least 3 characters)".
- The Console has no Delete button for vendors today (checked: nothing in `index.html` deletes a vendor), and **none is added.**

### 6. Hardening found during the inspection

`anon` and `authenticated` hold **TRUNCATE**, **TRIGGER** and **REFERENCES** on 15 `cl_` tables, including:
- `cl_ledger_entries`
- `cl_cashbook_entries`
- `cl_payment_vouchers`
- `cl_staff`
- `cl_activity_log`
- `cl_vendors`

These are the Supabase default grants from the baseline. **TRUNCATE skips row-level security.**

- **How exposed it is:** the REST API (PostgREST) has no TRUNCATE call, so the public key can't use it today. VERIFIED by reasoning, not by trying.
- **Proposed:** revoke TRUNCATE, TRIGGER and REFERENCES from `anon` and `authenticated` on all `cl_` tables. SELECT, INSERT, UPDATE and DELETE stay as they are, still behind row-level security.

### 7. Tests (PGlite, built from the repo)

1. **Deleting a vendor that has history is refused** with the plain message. It is refused for each of these on its own:
   - a ledger row;
   - a licence;
   - an activation code;
   - a reminder;
   - a till.

   Nothing is deleted.
2. **A vendor with no history can be deleted,** and the delete is logged with a snapshot and no phrase.
3. **The same delete rules for businesses.**
4. **Archive and unarchive:**
   - they set and clear the fields;
   - they are logged with the reason;
   - each plain error case (already archived, not archived, not found, no permission) gives its message;
   - staff without permission are refused by the server.
5. **An archived vendor:**
   - still checks in;
   - is left out of the plan review list;
   - its ledger and licences are unchanged.
6. **Licences:** deleting a till or business that has a licence is refused.
7. **Grants:** after the revoke, `anon` has no TRUNCATE on any `cl_` table.
8. **Rollback:** the rollback file restores the old rules byte for byte. It is generated from the live definitions, like the earlier migrations.
9. **The existing suites still pass:** price-plans, ledger-credits, payment-reversal and activation-licences.

### 8. Migration and rollback

- **Migration:** `20261014120000_vendor_delete_guard.sql`, with a rollback file under `supabase/rollbacks/`. It is generated by `tools/db/gen-20261014-migration.js`.
- **Applying it:** backup, then the final SQL shown, then your "apply", via `tools/db/apply-migration.js`. It is recorded in `schema_migrations`.
- 20260926160000 stays unapplied.
- **Risks:**
  - A device check-in never deletes vendors, so nothing on the app side changes.
  - The only behaviour change is that some deletes are refused. Restricting the licence links is a stricter rule for tills and businesses too.
- **Rollback:** restores the CASCADE and SET NULL rules and drops the triggers, functions and columns. Archive data would be lost; the activity log keeps it.

## Questions for you (each with a recommendation)

1. **Archive businesses as well as vendors?** *Recommend yes.* A business's tills are billed together under price plans.
2. **An archived vendor's device checks in again. What happens?** *Recommend:* it keeps working and stays archived, and the Console flags "archived, but still checking in". Unarchiving is a staff decision.
3. **Vendors with no history (duplicate check-ins, test installs): can they still be deleted?** *Recommend yes,* logged. Only the sysadmin should do it, in the dashboard, until a Console "Delete (no history)" action is wanted. Not built here.
4. **Licence links: RESTRICT (refuse) or keep SET NULL?** *Recommend RESTRICT.* A licence without its till or business can't be traced to who paid.
5. **Revoke TRUNCATE, TRIGGER and REFERENCES from the public roles on `cl_` tables (section 6)?** *Recommend yes.* It's in the same migration and needs no app change.

**STOP: waiting for "go Guard-B" and your answers.** Without answers, I'll build the recommendations.
