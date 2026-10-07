# Licence signing keys: where they live, backup, loss, rotation

Activation v2 licences are signed with an Ed25519 key that only seiGEN holds. The app carries the matching **public** key (`LICENCE_PUBLIC_KEYS` in `src/activation.js`), so it can check a licence offline but can't make one.

## Where things are

| What | Where | Secret? |
|---|---|---|
| Private key, key ID 1 | `C:\seigen-keys\licence-signing-key-1.json` (folder restricted to the owner's Windows user) | **Yes.** Never commit, paste, email or upload it. |
| Same private key, in use | Supabase Edge Function secret `LICENCE_SIGNING_KEY` (set by `tools/licence/deploy-function.js`) | Yes |
| Public key, key ID 1 | `src/activation.js`, `LICENCE_PUBLIC_KEYS[1]` | No |

`tools/licence/keygen.js` made the pair. It prints only the key ID and the public key, and refuses to overwrite an existing key file.

## Back it up now (two offline copies)

1. Plug in the USB backup drive (the one used for `C:\seigen-backups`). Say it is `E:`.
2. In PowerShell:
   ```powershell
   New-Item -ItemType Directory -Force E:\seigen-keys | Out-Null
   Copy-Item C:\seigen-keys\licence-signing-key-1.json E:\seigen-keys\
   (Get-FileHash C:\seigen-keys\licence-signing-key-1.json).Hash -eq (Get-FileHash E:\seigen-keys\licence-signing-key-1.json).Hash
   ```
   The last line must print `True`.
3. Make a second copy on another drive, kept somewhere else (not in the same bag as the laptop). Don't put it in cloud storage, email or WhatsApp.
4. Never open the file in a shared screen or paste it into a chat, including with Claude.

## If the private key is lost

Licences already issued keep working until they expire: the app checks them offline with the public key.

**No new licences can be issued** until a new key exists *and* an app release carrying its public key reaches the shops. Until then, shops whose licence runs out lock (they keep Download backup and read-only Reports).

Recovery:
1. `node tools/licence/keygen.js` makes key ID 2.
2. Add `2: "<public key>"` to `LICENCE_PUBLIC_KEYS`, build, release.
3. `node tools/licence/deploy-function.js --secrets-only --kid 2` switches the Edge Function to key 2.
4. Issue new licences once devices run the new release.

## If it leaks (someone else may have it)

Anyone holding it can make licences. Make key 2 as above. In the same release, **remove** key 1 from `LICENCE_PUBLIC_KEYS`, then re-issue licences to every paying shop with key 2. Licences signed with key 1 stop working on devices that update.

## Rotating on purpose

Same steps as a loss, but keep key 1 in `LICENCE_PUBLIC_KEYS` until every licence signed with it has expired (365 days at most). Then remove it.

## Deploying the Edge Function

Needs a Supabase personal access token:
1. Go to <https://supabase.com/dashboard/account/tokens>, then **Generate new token**. Name it `seigen-licence-deploy`.
2. Add it to `.env` as `SUPABASE_PAT=sbp_…`. `.env` is git-ignored.
3. `node tools/licence/deploy-function.js` deploys `supabase/functions/issue-licence` and sets `LICENCE_SIGNING_KEY` and `LICENCE_KEY_ID`. It runs `npx supabase functions deploy` and `npx supabase secrets set`, and never prints the token or the key.
