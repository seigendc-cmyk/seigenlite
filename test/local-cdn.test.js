// Run: node test/local-cdn.test.js
// The browser tests' local copies of the cdnjs files (test/local-cdn.js) are
// byte-for-byte the files the app names, and every browser test uses them.
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { RE, DIR } = require("./local-cdn");

let passed = 0, failed = 0;
function t(name, fn){
  try{ fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + e.message.split("\n").join("\n       ")); }
}
const ROOT = path.join(__dirname, "..");
// sha256 of the cdnjs files, downloaded 27 Oct 2026
const SHA = {
  "sql.js/1.10.3/sql-wasm.js":   "558a72c3ab3415d0e6d243cfd23f9d61543600d59054b4b7b8da3cd65f6b9fd4",
  "sql.js/1.10.3/sql-wasm.wasm": "d7e61b828523001f26ce0b3f88dabcf6c12e5e6edf80eb4f08b26ac7b946ff88",
  "xlsx/0.18.5/xlsx.full.min.js": "c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99",
};

t("the three local copies are byte for byte the cdnjs files", ()=>{
  for(const [rel, sha] of Object.entries(SHA)){
    const got = crypto.createHash("sha256").update(fs.readFileSync(path.join(DIR, rel))).digest("hex");
    assert.strictEqual(got, sha, rel);
  }
});

t("every cdnjs file the builds name has a local copy", ()=>{
  const names = new Set();
  for(const f of ["dist/index.html", "dist-pwa/index.html", "dist-pwa/sw.js", "dist-tauri/index.html", "dist-tauri/sw.js"]){
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    for(const m of s.matchAll(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/[\w.-]+\/[\d.]+\/[\w.-]+\.(?:js|wasm)/g)) names.add(m[0]);
  }
  // the app builds the .wasm address from the sql.js folder (locateFile)
  names.add("https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm");
  assert.ok(names.size >= 3, "found " + [...names].join(", "));
  for(const u of names){
    assert.ok(RE.test(u), u + " is not answered locally");
    assert.ok(fs.existsSync(path.join(DIR, RE.exec(u)[1])), u + " has no file in test/cdn/");
  }
});

t("every browser test requires ./local-cdn before playwright", ()=>{
  const missing = fs.readdirSync(__dirname).filter((f)=> f.endsWith(".js") && f !== "local-cdn.js")
    .filter((f)=>{ const s = fs.readFileSync(path.join(__dirname, f), "utf8"); const p = s.indexOf('require("playwright")');
      return p >= 0 && !(s.indexOf('require("./local-cdn")') >= 0 && s.indexOf('require("./local-cdn")') < p); });
  assert.deepStrictEqual(missing, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
