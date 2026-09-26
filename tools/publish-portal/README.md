# Digital Commerce Publish Portal

Internal tool for Digital Commerce only. Vendors never see it, and neither app links to it.

A vendor sends their `.scl` marketing export on WhatsApp. You review it here, then publish the products you approve to the iTred Market Place.

## Run it

1. Copy `.env.example` (repo root) to `.env` and fill in:
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase → Project Settings → API → `service_role`.
   - `PORTAL_PASSPHRASE`: at least 12 characters. It's only used once, to create the first Admin.
2. The database needs `supabase/migrations/20260925150000_publish_portal_staff_tokens.sql` applied (the `portal_staff` and `vendor_tokens` tables).
3. Start the portal:
   ```
   node tools/publish-portal/server.js
   ```
4. Open http://127.0.0.1:8787/.

There's nothing to install: it only uses Node's built-in modules (Node 18+). The portal listens on `127.0.0.1` only, so no other machine can reach it.

## Hosting it (Render)

`render.yaml` at the repo root is a Render Blueprint for the portal as a web service. The portal switches to **hosted mode** when `PORTAL_PUBLIC_ORIGIN` is set (for example `https://dc-publish-portal.onrender.com`). In hosted mode it:

- listens on `0.0.0.0` on the `PORT` Render gives it;
- answers only that host name, redirects plain HTTP to HTTPS, and sends HSTS;
- uses a `Secure`, `__Host-` session cookie;
- refuses any write whose `Origin` isn't the portal itself;
- limits wrong sign-ins per client IP (10 per 5 minutes), with a higher overall ceiling, so one person can't pause sign-in for all staff;
- turns first-run setup off (set `PORTAL_ALLOW_SETUP=1` to allow it). Create the first Admin on the local portal instead: it uses the same database.

Set only these in Render's dashboard:
- `SUPABASE_URL`;
- `SUPABASE_SERVICE_ROLE_KEY`;
- `PORTAL_PUBLIC_ORIGIN`.

The portal doesn't use `SUPABASE_DB_URL`, `SUPABASE_ANON_KEY` or `PORTAL_PASSPHRASE`, so don't put them on a public server. Health check: `/healthz`.

Everywhere, locally and hosted:
- `/robots.txt` disallows everything;
- every response carries `X-Robots-Tag: noindex`.

Sessions and uploaded files live in memory, so a restart or redeploy signs everyone out and clears uploads that haven't been published.

## Staff accounts

- **First run:** with no staff accounts yet, the page asks for the setup passphrase (`PORTAL_PASSPHRASE`) and then your name, username and password. That makes you the first Admin and signs you in. Setup then closes for good.
- **Everyone else:** an Admin adds them under **Staff** with a name, username, role and a temporary password. They must choose their own password the first time they sign in.
- **Roles:**
  - **Admin**: everything, including recording and voiding vendor tokens and managing staff.
  - **Reviewer**: upload, review, publish and unpublish listings, and see token status.
- **Lockout:** 5 wrong passwords in a row lock that account for 15 minutes. An Admin can unlock it sooner under **Staff**. The lock is stored on the account, so restarting the portal doesn't clear it. Separately, 20 wrong sign-ins across all accounts within 5 minutes pause sign-in for everyone for a few minutes.
- An Admin can also reset someone's password (to a new temporary one), change their role, or deactivate them. Deactivating or resetting signs them out straight away. There is always at least one active Admin, and you can't change your own role or deactivate yourself.

## Vendor tokens

A token is a vendor's listing rights for a period: 30 days by default, or whatever was agreed. Vendors pay informally (EcoCash, cash, …) and an Admin records each purchase under **Vendors & tokens**. A purchase has:

- a start date, and the number of days it covers;
- optionally, the amount, how they paid, and a reference.

Dates are in Harare time. A token bought before the current one ends starts the day after it by default, so the two run on without a gap. A wrong entry is **voided** (with a reason), never deleted.

A vendor's status is shown wherever their listings appear: on the uploaded file, in History, and under Vendors & tokens. It reads either "token active until …", "token expired …", "token starts …" or "no token".

## Using it

- **Upload**: drop the `.scl` file, or choose it. The portal checks it and shows:
  - the vendor (name, install ID, token status, WhatsApp, city);
  - every product with its photo, price, stock and any problems.

  Nothing is written to Supabase at this stage.
  - **Blocked files**: the file won't publish if:
    - it was changed after the app made it (checksum), or is damaged;
    - its **install ID doesn't match a registered device** (`cl_vendors`). No vendor is created for an unknown device.
    - the vendor has **no active token**. The message says why, for example "No active token — expired on 30 Aug 2026. Record a new one to continue." An Admin gets a **Record a token** button right there. Once it's saved, the same file can be published without uploading it again.
  - **Blocked products**: a product with a problem (no name, negative price, bad currency, repeated ID) can't be ticked. A bad or missing photo is a note, not a block: the product goes live without a photo.
- **Publish**: untick anything you don't want, then press Publish. The device and token are checked again at this moment. The portal:
  1. creates or updates the vendor in `vendors`, matched by `install_id`;
  2. uploads each ticked product's photo to the public `listing-images` bucket;
  3. adds each product to `vendor_listings` as `published`, with `image_url` set to that photo's link. It's live for 7 days, as set by the database.

  If the product was already live, the older listing is set to `expired`, so customers see it once. Each product gets its own result: one failure doesn't stop the rest.
- **History**: each publish (vendor, time, product count, how many are still live, token status).
  - **Unpublish** takes one listing off the Market Place straight away. Its status goes back to `pending_review`, and the row is kept.
  - To correct a listing, have the vendor send a fixed file and publish that.

## Security

- The `service_role` key bypasses row-level security. It stays in this server process: the page never receives it, and the tests check that no response contains it.
- `portal_staff` and `vendor_tokens` have RLS on with no policies and no grants to `anon`/`authenticated`, so only this portal (service_role) can reach them. service_role can't delete from them either.
- Passwords are stored as scrypt hashes, and no hash is ever sent to the page. A wrong username takes as long to refuse as a wrong password.
- Sessions last 12 hours (an HttpOnly, SameSite=Strict cookie), and the account is re-read on every request, so role changes and deactivation apply at once.
  - Every write request must carry an `X-Portal` header.
  - Requests using any host name other than `127.0.0.1` or `localhost` are refused.
- Everything from a vendor's file or typed by staff is shown as text, never as HTML.

Tests:
- `node --no-warnings test/publish-portal.test.js`: the server and the page in a real browser, against a fake Supabase. The `.scl` files are made with the app's own export code.
- `node supabase/tests/portal-schema-test.js pglite` (or `live`): the migration.
