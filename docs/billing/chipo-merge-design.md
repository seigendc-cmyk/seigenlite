# Chipo Clothing: merging two businesses into one (Billing-B)

Status: **designed and tested, NOT run on live.** It waits for the owner's "apply" (first the migration `20261021120000_billing_b.sql`, then the data fix `supabase/data-fixes/20261021_chipo_merge.sql`).

## The problem

On 2026-10-09 both Chipo Clothing devices registered "Chipo Clothing" with the same phrase, 0.55 seconds apart. seiGEN therefore holds **two businesses**:

| | Kept: Harare CBD | Merged in: Sothleapark |
|---|---|---|
| Business | `95f0ba44-4041-4e6e-ac52-3516902d20e0` | `7c47d0ea-ced3-4297-9c38-1c15fb24ac07` |
| Branch | `f1a153a3-…` Harare CBD, main | `07930efd-…` Sothleapark, main |
| Tills | T1 (build 17, last seen 10 Oct) | T1 (build 15, last seen 9 Oct) |
| Plan | Business | Business |
| Catalogue | 1 product (pnt001) | 3 products (kds003, lmd001, mb005): no shared codes |
| Customers, suppliers, supplier GRVs, dispatches, shared stock | none | none |
| History | licence 1006, RPN, 3 commissions, 2 token purchases and uses, 3 market packs | licence 1005, the same RPN, 3 commissions, 2 tokens, 1 market pack |

What that causes:
- Sothleapark's till is priced as a **main till (USD 15)**, not a branch (USD 7).
- Harare CBD's Delivery Notes to Sothleapark can only go **by file**.

## The result after the merge

**One business, Chipo Clothing (`95f0ba44…`):**
- **Harare CBD** stays the main branch.
- **Sothleapark** becomes a **remote (non-main) branch**. It keeps its branch ID, and its till keeps its till code (T1 of Sothleapark).
- Its next licence is priced as **a branch's first till (USD 7)**.
- One catalogue of 4 products. The 3 moved products get new change numbers, so both tills pull them.

**The duplicate business (`7c47d0ea…`)** is **archived**, never deleted, with the reason "Merged into Chipo Clothing (…): …".

**History stays where it was written:**
- licences (the signed payload names the old business ID);
- the RPN assignment and commissions;
- tokens, the market pack and the plan assignment.

**Logging and join codes:**
- The merge is logged in `cl_activity_log` as `business_merged`.
- Sothleapark's unused join code is expired.

## How it runs

1. **"apply" for the migration.** `node tools/db/apply-migration.js apply supabase/migrations/20261021120000_billing_b.sql`. It adds:
   - the duplicate refusal in `cl_branch_register`;
   - `cl_licence_link_warnings` for the Console;
   - `cl_business_merge_core` (no grants: data-fix files only), and `cl_business_merge` (SysAdmin, for a Console button later).
2. **A fresh read-only backup.**
3. **"apply" for the data fix.** `node tools/db/run-data-fix.js apply supabase/data-fixes/20261021_chipo_merge.sql`.
   - **It first checks** that live is still what this design was made from: both businesses not archived, one main branch and one till each, the Business plan, exactly 3 products at Sothleapark.
   - **If anything differs, it raises and changes nothing.**
   - It prints the price before and after.
   - **The merge's own refusals also apply:** customers, suppliers, dispatches, shared stock, a branch name or product code used on both sides, and the plan's branch limit.
   - A second run is refused.

## On the devices (app v20)

- **Sothleapark's till:**
  - At its next check-in, seiGEN reports the kept business. The till then reads its new identity from the branch list (`terminalFollowBusiness`, src/terminal.js).
  - Its branch is no longer main, so the till becomes a **remote branch** (no adding or editing products, no costs).
  - It pulls the whole catalogue again.
  - This is logged as "Business changed on seiGEN".
  - **It needs v20.** Today it is on build 15 (last seen 9 Oct). An older build keeps showing its old identity, and the server refuses it main-branch actions.
- **Harare CBD's till** sees Sothleapark as a seiGEN destination the next time it refreshes its branch list (every 6 hours, or on opening Dispatch after the next check-in). From then on, Delivery Notes to Sothleapark go through seiGEN.
- **Delivery Notes made before the merge stay file-only.** They are received with the file, as before (see the 2026-10-13 dispatch diagnosis).

## Money

The licences already issued stay as they are:
- **1005** was issued and charged as a main till (USD 15).
- **1006** is unchanged.

The merge doesn't refund or re-charge anything. Sothleapark's **next** licence is priced as a branch (USD 7). If the owner wants the difference on 1005 credited, that is a separate ledger credit, decided by the owner.

## Undo

The data fix is not reversible by a rollback file. To split them again, a SysAdmin would unarchive the old business and move the branch, till and vendor back. That would be written as its own data fix if ever needed.

The schema rollback (`supabase/rollbacks/20261021120000_billing_b.rollback.sql`) removes the functions only.

## Tests

- `supabase/tests/billing-b-test.js` (54): the migration, the refusal, the warnings, the merge and everything that blocks it, the tills' view after it, the Lite limit, grants and rollback.
- `supabase/tests/chipo-merge-fix-test.js` (9): this exact data-fix file on a rebuilt Chipo state.
- `test/billing-b.test.js` (7): the real app on both Chipo tills, before and after the merge.
