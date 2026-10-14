# IVO merge: design (Stage A, not run)

Date: 2026-10-14. Made from a read-only look at live (02:30 UTC). Nothing has been changed.
Runs only after the owner says **"apply ivo merge"**.

## What is on live

| | IVO Dist | IVO Motor Spares |
|---|---|---|
| Registered | 6 Oct, 05:21 UTC | 13 Oct, 19:57 UTC |
| Branches | Warehouse (main) | Warehouse (main), Norton, Harare |
| Tills | T1, last seen **7 Oct**, build not recorded (before v8) | Warehouse T1 (build 21), Norton T1 (build 21), Harare T1 (build 21) |
| Catalogue on seiGEN | **none** | 1 product (uploaded by Warehouse T1, 14 Oct 01:14 UTC) |
| Dispatches | none | 2 |
| Customers, suppliers, GRVs, stock by branch | none | none |
| Licences | none | 3 trial licences (30 days, to 11 Nov), not redeemed yet |
| Plan, trial, join codes | none | trial; 3 join codes (2 used: Norton, Harare) |
| Device rows | 2 (28 Sep, an earlier install with no business; 30 Sep, T1) | 3 |

- **Norton and Harare are branches of IVO Motor Spares.** They joined with codes made by IVO Motor Spares' Warehouse T1 (00:32 and 00:39 UTC on 14 Oct).
- **They did not get anything from IVO Dist.** IVO Dist never put a catalogue on seiGEN. The only catalogue Norton and Harare can sync is IVO Motor Spares' (1 product). A catalogue *file* passed from one device to another isn't visible on seiGEN.
- **The two businesses use different activation phrases.** Both have the same phone ending (…198), but so do five other businesses on live, so it proves nothing. **Whether it's the same owner is your call.**

## The plan (recommended): keep IVO Motor Spares, retire IVO Dist

- **IVO Motor Spares stays exactly as it is.** Warehouse stays main; its till, Norton and Harare are not touched.
- **IVO Dist is archived**, with both its device rows. That's a label in the Console:
  - it drops out of the active lists;
  - **nothing is deleted or moved**;
  - if IVO Dist's old device were ever opened again, it could still check in.
- **Products:** none to move (IVO Dist has none on seiGEN). IVO Motor Spares keeps its own.
- **Stock:** none on seiGEN for IVO Dist. Stock kept only on IVO Dist's old device stays on that device.
- **Licences:** IVO Dist has none. IVO Motor Spares' three trial licences are untouched.
- **Billing:** nothing changes. IVO Dist has no plan and no licence, and IVO Motor Spares keeps its trial.

**Why not a full merge** (as with Chipo):
- There is nothing on seiGEN to bring over.
- A merge would bring IVO Dist's dead till over as a fourth branch (a branch till in billing).
- The merge would also be refused as things stand, because both mains are called "Warehouse". It would first need a rename.

**If IVO Dist was a different business** (e.g. a separate distribution arm, not a second registration): say so, and nothing is done.

## What runs

`supabase/data-fixes/20261025_ivo_merge.sql`, with `node tools/db/run-data-fix.js apply ...`. It is one transaction that:
1. **checks live is still as above**, or refuses and changes nothing. In particular it refuses if:
   - IVO Dist's till has checked in since 7 Oct;
   - IVO Dist now has products, stock, history, licences, a plan, a trial or join codes;
   - either business was renamed or archived;
2. archives IVO Dist and its two device rows, with the reason "IVO merge (owner, 2026-10-14): ..." (the archive log records each one);
3. checks the result.

**Tested:** `supabase/tests/ivo-merge-fix-test.js`, 17/17, in a copy built from the repo (never live). It covers:
- the refusals;
- IVO Motor Spares left byte-for-byte as it was;
- the log;
- check-in still working after the archive;
- the second-run refusal;
- the undo, and running it again after an undo.

## Undo

`supabase/data-fixes/20261025_ivo_merge_undo.sql` takes the three archive labels off again (after its own "apply"). Since nothing was moved or deleted, that is the whole undo.

## Before "apply ivo merge" (optional, 1 minute)

To be sure which device IVO Dist's T1 was, open **More → About** on the device you think it is and read the **Device code** (like ABCD-K7Q2). I can match its first part against IVO Dist's till without showing anyone the full ID.
