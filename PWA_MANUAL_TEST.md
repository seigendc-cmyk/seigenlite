# Manual test: dist-pwa/ on a real Android phone

Everything else about `dist-pwa/` (installability, offline boot, install
button logic, update-banner logic) was verified automatically. The five
things below can only be confirmed on a real device with a real install,
so run this once `dist-pwa/` is deployed somewhere real (any https static
host — GitHub Pages, Netlify, etc.).

Needs: an Android phone with Chrome, and the deployed `dist-pwa/` URL.

## 1. See the Install button

1. Open the deployed URL in Chrome on the phone.
2. Complete the first-run setup wizard (shop name, branch, etc.) if this
   is a fresh install of the app data.
3. Go to **More → About** (tap **More** in the bottom nav, then pick
   **About** from the dropdown at the top).
4. **Expect:** an **⬇️ Install App** button, styled like the outline
   buttons elsewhere in the app, appears below the WhatsApp contact
   buttons. (If it doesn't appear within a few seconds, Chrome's install
   eligibility heuristics may not have fired yet — try browsing a couple
   more screens, or reloading once, then check About again.)

## 2. Tap it and confirm the icon lands on the home screen

1. Tap **Install App**.
2. **Expect:** Chrome's own install confirmation sheet appears (app name,
   icon, an Install/Cancel choice — this part is entirely Chrome's own
   UI, not the app's).
3. Tap **Install**.
4. **Expect:** the button disappears from the About screen (it's single-use
   once a choice is made), and a seiGEN Commerce Lite icon appears on the
   phone's home screen shortly after (Android sometimes takes a few
   seconds, or lands it in the app drawer first depending on OS version/
   launcher).

## 3. Open from the home screen icon — should be standalone

1. Tap the newly-installed home screen icon (not the browser tab you were
   just using — close that tab first to make sure you're testing the
   installed copy).
2. **Expect:** the app opens in its own window with **no browser
   chrome** — no address bar, no tabs, no Chrome menu button. Just the
   app's own top bar and bottom nav. (This is the `display: standalone`
   manifest setting taking effect.)
3. Go to **More → About** again.
4. **Expect:** the Install button does **not** appear at all this time —
   the app can tell it's already running installed/standalone.

## 4. Simulate an update

This step needs you (or whoever has deploy access) to publish a trivial
change and re-deploy `dist-pwa/` to the same URL — e.g. add a harmless
comment to any `src/` file, run `node build.js --pwa` again, and push the
new `dist-pwa/` contents to the host.

1. With the app already installed from step 2-3 (still on the phone,
   already opened at least once so it has a service worker registered),
   deploy the changed version.
2. Fully close the app (swipe it away from recent apps, not just switch
   away) and reopen it from the home screen icon.
3. **Expect:** the app opens and works normally on the *old* cached
   version first (that's correct — it's serving from cache while it
   checks for updates in the background).
4. Within a few seconds, **expect a dismissible bar at the bottom** of
   the screen saying **"A new version is available."** with a **Reload**
   button and a **✕** dismiss button.
5. Tap **Reload**.
6. **Expect:** the app reloads itself (you'll briefly see the loading
   screen) and comes back up running the new version — no browser prompt,
   no manual refresh needed, and nothing lost mid-flow (don't do this
   test mid-sale on a real shop device, only on a test install — same as
   you wouldn't force-close the app mid-sale).
7. Optional: repeat step 2 without deploying anything new in between —
   confirm the banner does **not** reappear when there's nothing new to
   update to.

## Report back

For each of the 4 sections above, note pass/fail and anything that looked
off (timing, wording, a button that didn't respond, etc.) — that's enough
detail to act on.
