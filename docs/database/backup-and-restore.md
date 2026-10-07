# Database backup and restore

The live Supabase project (`urbopdsubwawtybwrxjd`) holds the shops' registrations, branches, tills, catalogue, shared stock, the back office (staff, RPNs, ledger, vouchers) and the iTred marketplace. This page covers how to copy it and how it could be rebuilt.

## 1. Take our own backup (read-only)

```
node tools/db/live-backup.js
```

Requirements: `SUPABASE_DB_URL` in `.env` (it is never printed) and the `pg` package (`npm install --no-save pg` if `node_modules/pg` is missing). The script runs one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction, so every table comes from the same moment, and it ends in `ROLLBACK`. It writes nothing to the database. It takes about a minute.

It writes `docs/database/live-backup-<timestamp>/`:

| File | Contents |
|---|---|
| `schema.sql` | DDL for every object in schema `public`: tables, functions, constraints, indexes, triggers, RLS and policies, grants, comments (from `tools/db/catalog.js` + `tools/db/ddl.js`) |
| `catalog.json` | The catalogue snapshot the DDL was made from |
| `data/<table>.json` | Every row of every table in `public`, as a JSON array |
| `manifest.json` | Time, server version, row count per table, size and sha256 per file |

> **The backup folder holds secrets:** shop secret phrases, device keys, passcode hashes, RPN verification codes and customer details. It is gitignored (`docs/database/live-backup-*/`). Never commit, share or upload it. Keep a copy offline (an encrypted USB drive, for example) and delete old copies you no longer need.

Take one by hand before every live migration. The nightly task (1a) takes one every evening.

`--out <folder>` writes `<folder>/<timestamp>/` instead, for example outside the repo.

## 1a. Nightly backup (this Windows PC)

The Task Scheduler task **"seiGEN nightly DB backup"** runs `tools/db/nightly-backup.ps1` every day at 20:00, as the logged-on user only, with no stored password and not elevated. If the PC was off at 20:00, it runs as soon as possible afterwards. It has a 15-minute limit and at most one retry after 10 minutes.

- **Where backups live:** `C:\seigen-backups\supabase\<timestamp>\` (UTC timestamp). This is outside the repo, so a backup can never be committed. Only your Windows user has access (`icacls C:\seigen-backups`).
- **Pruning:** after a successful run, the newest 14 complete backups (folders with `manifest.json`) are kept and older ones are deleted. After a failed run nothing is deleted. A half-written folder from a failed run has no `manifest.json` and is left for you to inspect or delete.
- **The log:** one line per run in `C:\seigen-backups\backup.log`:
  ```powershell
  Get-Content C:\seigen-backups\backup.log -Tail 10
  # 2026-10-07 22:41:41 +02:00 OK folder=C:\seigen-backups\supabase\2026-10-07T20-41-20-737Z size=824KB rows=247 kept=1 pruned=0
  # ... FAILED exit=1 ERROR: <reason> (nothing pruned)
  ```
- **The last run:**
  ```powershell
  Get-ScheduledTaskInfo -TaskName 'seiGEN nightly DB backup' | Select-Object LastRunTime, LastTaskResult, NextRunTime
  ```
  A `LastTaskResult` of `0` means OK. Anything else means it failed; read the log.
- **Run it now:** `schtasks /run /tn "seiGEN nightly DB backup"`, or by hand with `powershell -NoProfile -ExecutionPolicy Bypass -File tools\db\nightly-backup.ps1`.
- **Disable, enable or delete the task:**
  ```powershell
  Disable-ScheduledTask -TaskName 'seiGEN nightly DB backup'
  Enable-ScheduledTask  -TaskName 'seiGEN nightly DB backup'
  Unregister-ScheduledTask -TaskName 'seiGEN nightly DB backup' -Confirm:$false
  ```
  You can also use Task Scheduler (`taskschd.msc`) → Task Scheduler Library.
- **Copy the newest backup to USB** (replace `E:` with the drive letter):
  ```powershell
  $b = Get-ChildItem C:\seigen-backups\supabase -Directory | Where-Object { Test-Path "$($_.FullName)\manifest.json" } | Sort-Object Name | Select-Object -Last 1
  Copy-Item $b.FullName "E:\seigen-backups\$($b.Name)" -Recurse
  ```
  Use an encrypted drive (BitLocker To Go, for example).

> **These folders hold shops' secret phrases, device keys and passcode hashes, and customer details.** Never upload them (no cloud drive, e-mail or chat), never share them, and never copy them into the repo.

## 2. The schema is in the repo

`supabase/migrations/` rebuilds the full schema on an empty database:

1. `20260923000000_baseline.sql`: everything that existed before the migrations folder (the back office, ledger, vouchers, RPNs, staff, activation, `cl_vendors`, `cl_login` ...). It is generated from the live catalogue and contains no data. Its preflight refuses to run if those objects already exist, so it can never touch live. On live it is only recorded as applied.
2. The 13 later files, in order.

Proof: `node supabase/tests/baseline-rebuild-test.js` builds an empty PGlite database from all 14 files and compares its catalogue with live (the committed fingerprint in `supabase/tests/fixtures/`; add `live` to also read live, read-only). Known differences:

- `20260926160000_vendor_tokens_rpn_and_payment`: in the repo, **not applied on live** (parked for the Console billing work). A rebuild has its 6 objects; live doesn't.
- `portal_staff`, `vendor_tokens`: live's `service_role` lacks REFERENCES and TRIGGER, which the file `20260925150000` leaves in place. Live is stricter than the file. It's harmless and is recorded in the test.

### Migration history on live

Live records which files are applied in `supabase_migrations.schema_migrations` (the table the Supabase CLI reads). `tools/db/record-migration-history.js` manages it:

- `node tools/db/record-migration-history.js` prints the SQL and changes nothing;
- `... check` is read-only: it shows what is recorded and which files `supabase db push` would run;
- `... apply` runs the SQL in one transaction and checks that nothing else in the database changed.

`20260926160000` is deliberately not recorded, because it is not applied. **Until it is decided, never run `supabase db push` against live:** push would apply it.

## 3. Supabase's own backups

**Status (2026-10-07): the project is on the Free plan, so Supabase keeps no backups for us.** Our own nightly backup (1a) is the only copy. Recheck **Project → Database → Backups** if the plan changes.

What Supabase backups cover, per Supabase's documentation (confirm against your plan):

- **Free plan:** no downloadable backups. Projects on paid plans get daily backups (Pro keeps 7 days, Team 14, Enterprise up to 30). PITR is an add-on that allows restoring to any second in its window.
- **A dashboard restore replaces the whole project database** with the backup. Everything written after that moment is lost, not merged.
- **Not covered:** Storage objects (files) are not in database backups. A restore needs the project, so it doesn't protect against losing the account or the project. Our own logical backup (1) covers both.

## 4. Restoring into a fresh Supabase project

**Untested here.** This is the procedure, not a rehearsed drill. Rehearse it on a throw-away project before relying on it.

1. Create a new project on the same Postgres major version as live (17).
2. **Schema**, either way:
   - **(a) From the repo:** run `supabase/migrations/*.sql` in filename order in the SQL editor, or with `npx supabase db push --db-url <new project url>`. Decide first about `20260926160000`: skip it to match live.
   - **(b) From the backup:** run `schema.sql`, the exact schema at the moment of the backup.
3. **Data:** insert `data/<table>.json` per table, parents before children (for example `cl_staff`, `cl_modules`, `cl_rpn`, `cl_vendors`, `cl_businesses`, `cl_branches`, `cl_terminals` ... then the rest). For example:
   ```sql
   insert into public.cl_modules select * from json_populate_recordset(null::public.cl_modules, '<file contents>');
   ```
   - Leave out generated columns (`purchase_order_items.fulfillment_status`, `vendor_tokens.ends_on`): name the other columns explicitly.
   - Triggers fire during inserts: `vendor_tokens_require_payment` (if `20260926160000` is applied) and the voucher total trigger. Either load in an order that satisfies them, or ask Supabase support about disabling them for the load.
   - Afterwards, set the sequences past the restored rows: `select setval('public.cl_catalogue_seq', <max change_seq>)` and the same for `public.cl_voucher_no_seq` (voucher numbers).
4. **Things outside `public` that must be set again by hand:**
   - The Vault secret `cl_jwt_secret`, which signs back-office sign-in tokens. It is the new project's JWT secret (Project Settings → API). In the SQL editor:
     `select vault.create_secret('<JWT secret>', 'cl_jwt_secret', 'signs back-office sign-in tokens (cl_login)');`
   - `auth.users` (iTred customer accounts) is not in our backup. `customers` is empty today.
5. **Configuration rows.** A rebuild from the repo alone (2a without step 3) is an empty schema. The back office needs these rows before it works: `cl_modules` (the module keys the permission checks use), `cl_app_settings`, `cl_activation_pricing`, `cl_chart_of_accounts`, and a first `cl_staff` sysadmin (created with `cl_create_staff`). Take their values from a backup, never from the repo.
6. **Point the apps at the new project.** The app's Supabase URL and anon key are built into the shipped app, so a new project means a new app build.
7. **Verify** with `baseline-rebuild-test.js`-style comparison, and spot-check row counts against `manifest.json`.
