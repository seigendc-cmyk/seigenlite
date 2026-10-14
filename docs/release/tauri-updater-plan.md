# Windows program (Tauri): auto-updater plan (later; not built)

Date: 2026-10-14. Owner: "Plan a Tauri auto-updater for later."

## Where things stand

- **The Windows program carries its files inside it.** A newer build only arrives with a new installer, which today is sent by hand.
- **From the 2026-10-14 installer on:**
  - the program uses no service worker (`src-tauri/sw-off.js` removes one an older build left; v23's `src/main.js` no longer registers one);
  - so a new installer's build shows at its first open (VERIFIED with the real program, builds 22 → 23).
- **v23:** About says "a newer build comes as a new installer from seiGEN". seiGEN's minimum build shows a red bar: "Ask seiGEN for the new Windows installer."
- **The data stays across installs.** It lives in `%LOCALAPPDATA%\com.seigendc.seigenlite\EBWebView` (origin `http://tauri.localhost`, identifier unchanged since 19 Sep). An install over the old program doesn't touch it. The uninstaller deletes it only if "Delete the application data" is ticked.

## The plan

1. **Plugins:** `tauri-plugin-updater` and `tauri-plugin-process` (to restart). Capabilities: `updater:default`, `process:allow-restart`.
2. **Signing key for updates** (not the same as a Windows code-signing certificate):
   - make it with `cargo tauri signer generate`;
   - the public key goes in `tauri.conf.json` (`plugins.updater.pubkey`);
   - the private key and its password stay off the repo and off reports: the owner's password manager plus one offline copy;
   - **if the private key is lost, installed programs can't take updates any more**; each one would need a manual install.
3. **Build:** `bundle.createUpdaterArtifacts: true`. Each NSIS installer then comes with a `.sig` file. Version: `1.9.<build>` (the build number from `sw-pwa.js`).
4. **Hosting:**
   - a small `latest.json` (version, notes, date, and the Windows download URL plus signature) next to the installer on Cloudflare;
   - one for previews and one for production, like the web builds;
   - the program's `endpoints` point at the right one.
5. **In the app:** the same rules as the web update flow (v23):
   - check at start, every 30 minutes, and when the internet comes back;
   - download in the background;
   - install by itself only when the till is idle with an empty cart, or straight away on **Update now** in the bar;
   - NSIS in passive mode, then restart;
   - the shop's data isn't touched.
6. **Tests:**
   - a local `latest.json` and installer;
   - an update from build N to N+1 on a scratch WebView2 data folder (as on 2026-10-14);
   - a bad signature is refused;
   - offline means no update and no error on screen.

**Optional:** a Windows code-signing certificate, so SmartScreen stops warning "Windows protected your PC" on each installer. It's a yearly cost and a separate decision.

**Effort:** about a day, including tests. It needs the signing key made and stored first, by the owner.
