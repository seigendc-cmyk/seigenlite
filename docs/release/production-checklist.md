# Production release checklist

Production (mobilepos, desktoppos) serves **v10** (checked 2026-10-14). The previews carry everything since. This list collects what must be true, or done, when the next build goes to production. Add to it as rules come up; tick items off in the release report.

## Before the deploy

- [ ] **v21 or later must be on production before any shop needs to add a till** (owner, 2026-10-14).
  - Since `20261023120000_admin_passcode_from_main` (applied on live 2026-10-13, 19:21 UTC), a v10 till can neither issue a join code (UPDATE_MAIN_FIRST) nor join (APP_UPDATE_NEEDED).
  - Selling, check-in, catalogue and dispatch on v10 are unaffected.
  - If a production shop must add a till before the release, the fallback is rolling back `20261023120000` (tested; it reopens the Admin-passcode gap).
- [ ] Every migration the release's app build needs is applied on live (check `supabase_migrations.schema_migrations`).

## After the deploy

- [ ] Each till picks up the new build. Until the update-flow fix is built, a till that stays open does **not** check for updates on its own, and the first reopen still runs the old build: open the app online and tap **Reload** on "A new version is available", or close it fully and open it again.
- [ ] Check on live that the tills report the new build at check-in (`cl_terminals.app_build`).
