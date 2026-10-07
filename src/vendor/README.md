# Vendored third-party code

Shipped inside the app bundles by build.js (outside the obfuscated app code), never loaded from a CDN.

| File | From | sha256 |
|---|---|---|
| `tweetnacl-fast.min.js` | npm `tweetnacl@1.0.3`, `nacl-fast.min.js` (registry integrity `sha512-6rt+RN7aOi1nGMyC4Xa5DdYiukl2UWCbcJft7YhxReBGQD7OAM8Pbxw6YMo4r2diNEA8FEmu32YOn9rhaiE5yw==`) | `3ec535c004aeeb225785d8e93fb33bf99f52e399bd7dfc01969b5629baea5131` |
| `tweetnacl-LICENSE` | the same package (Unlicense, public domain) | `88d9b4eb60579c191ec391ca04c16130572d7eedc4a86daa58bf28c6e14c9bcd` |

TweetNaCl-js is used only to verify activation licences (Ed25519 signatures, `nacl.sign.detached.verify`) and for SHA-512 (`nacl.hash`). It is pure ES5 with no dependencies, so it works on old Android Chrome and in Tauri. `test/licence.test.js` checks the file's sha256 against this table.
