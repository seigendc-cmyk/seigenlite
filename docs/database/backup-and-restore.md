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

Take one before every live migration, and on a regular schedule (for example weekly) as long as Supabase's own backups are limited (see 3).

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

**Status: not yet confirmed.** The token in `.env` (`SUPABASE_ACCESS_TOKEN`) is not a Management API personal access token (those start with `sbp_`), so the API answered 401. Check in the dashboard: **Project → Database → Backups**, and note:

- **Scheduled backups:** are daily backups listed? What is the date of the newest, and how many days back do they go?
- **Point in Time Recovery:** is it enabled? It is a paid add-on.
- **The plan** (Organization → Billing): Free, Pro, Team or Enterprise.

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
