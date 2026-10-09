// Run: node test/market-deploy.test.js   (build first: node build.js --pwa && node build.js --tauri)
// The Marketing add-on can't be left out of a deploy again (from 4 Oct every
// deploy of dist-pwa / dist-tauri dropped market.html and Marketing showed
// "not installed" on every site):
//   * both hosted builds carry market.html, the current add-on
//   * tools/cf/deploy-app.js refuses a folder without it, or with an
//     index.html and sw.js from different builds, and accepts the real builds
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkFolder, REQUIRED } = require("../tools/cf/deploy-app.js");

const ROOT = path.join(__dirname, "..");
let passed = 0, failed = 0;
function t(name, fn){
  try{ fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + e.message); }
}
function copyOf(dir){
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-deploy-"));
  for(const f of fs.readdirSync(path.join(ROOT, dir))) fs.copyFileSync(path.join(ROOT, dir, f), path.join(tmp, f));
  return tmp;
}

for(const dir of ["dist-pwa", "dist-tauri"]){
  t(dir + " carries market.html, the same add-on as dist-market", ()=>{
    const f = path.join(ROOT, dir, "market.html");
    assert.ok(fs.existsSync(f), dir + "/market.html is missing");
    assert.strictEqual(fs.readFileSync(f, "utf8"), fs.readFileSync(path.join(ROOT, "dist-market", "market.html"), "utf8"));
  });
  t(dir + " passes the deploy checks", ()=>{
    assert.deepStrictEqual(checkFolder(path.join(ROOT, dir)), []);
  });
  t(dir + " without market.html is refused", ()=>{
    const tmp = copyOf(dir);
    fs.rmSync(path.join(tmp, "market.html"));
    assert.deepStrictEqual(checkFolder(tmp), ["missing market.html"]);
  });
  t(dir + " with sw.js from another build is refused", ()=>{
    const tmp = copyOf(dir);
    const sw = path.join(tmp, "sw.js");
    fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace(/\/\/ build: v(\d+)/, (m, n)=> "// build: v" + (Number(n) + 1)));
    assert.match(checkFolder(tmp).join(";"), /index\.html is build v\d+ but sw\.js is v\d+/);
  });
}
t("every required file is checked", ()=>{
  assert.deepStrictEqual(REQUIRED.slice(0, 4), ["index.html", "sw.js", "manifest.json", "market.html"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
