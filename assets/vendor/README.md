# Libraries served from the app's own address (A14, owner 27 Oct 2026)

Byte-for-byte copies of the cdnjs files (test/local-cdn.test.js checks the sha256):

- `sql-wasm.js`, `sql-wasm.wasm`: sql.js 1.10.3 (MIT)
- `xlsx.full.min.js`: SheetJS xlsx 0.18.5 (Apache 2.0)

build.js copies them into dist-pwa/vendor/ and dist-tauri/vendor/ and points
the app there. The single file dist/index.html keeps the cdnjs addresses,
because a browser can't fetch a wasm next to a file it opened from disk.
