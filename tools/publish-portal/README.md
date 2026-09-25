# Digital Commerce Publish Portal

Internal tool for Digital Commerce only. Vendors never see it, and neither app links to it.

A vendor sends their `.scl` marketing export on WhatsApp. You review it here, then publish the products you approve to the iTred Market Place.

## Run it

1. Copy `.env.example` (repo root) to `.env` and fill in:
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase → Project Settings → API → `service_role`.
   - `PORTAL_PASSPHRASE`: at least 12 characters.
2. Start the portal:
   ```
   node tools/publish-portal/server.js
   ```
3. Open http://127.0.0.1:8787/ and sign in with the passphrase.

There's nothing to install: it only uses Node's built-in modules (Node 18+). The portal listens on `127.0.0.1` only, so no other machine can reach it.

## Using it

- **Upload**: drop the `.scl` file, or choose it. The portal checks it and shows:
  - the vendor (name, install ID, WhatsApp, city);
  - every product with its photo, price, stock and any problems.

  Nothing is written to Supabase at this stage.
  - **Blocked files**: the file won't publish if it was changed after the app made it (checksum), is damaged, or its **install ID doesn't match a registered device** (`cl_vendors`). No vendor is created for an unknown device.
  - **Blocked products**: a product with a problem (no name, negative price, bad currency, repeated ID) can't be ticked. A bad or missing photo is a note, not a block: the product goes live without a photo.
- **Publish**: untick anything you don't want, then press Publish. The portal:
  1. creates or updates the vendor in `vendors`, matched by `install_id`;
  2. uploads each ticked product's photo to the public `listing-images` bucket;
  3. adds each product to `vendor_listings` as `published`, with `image_url` set to that photo's link. It's live for 7 days, as set by the database.

  If the product was already live, the older listing is set to `expired`, so customers see it once. Each product gets its own result: one failure doesn't stop the rest.
- **History**: each publish (vendor, time, product count, how many are still live).
  - **Unpublish** takes one listing off the Market Place straight away. Its status goes back to `pending_review`, and the row is kept.
  - To correct a listing, have the vendor send a fixed file and publish that.

## Security

- The `service_role` key bypasses row-level security. It stays in this server process: the page never receives it, and the tests check that no response contains it.
- Sign-in uses one passphrase, with a 12-hour session (an HttpOnly, SameSite=Strict cookie).
  - Five wrong tries in a minute locks sign-in for that minute.
  - Every write request must carry an `X-Portal` header.
  - Requests using any host name other than `127.0.0.1` or `localhost` are refused.
- Everything from a vendor's file is shown as text, never as HTML.

Tests: `node --no-warnings test/publish-portal.test.js`. They run against a fake Supabase, and the `.scl` files are made with the app's own export code.
