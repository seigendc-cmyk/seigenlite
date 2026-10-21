// node tools/build-all.js
//
// Rebuilds the three app bundles from the current source, in this order:
// dist/ (node build.js), dist-pwa/ (--pwa), dist-tauri/ (--tauri), plus
// dist-market/market.html (--market), which the browser tests also load.
// Then runs tools/check-dist-fresh.js. Owner's standing rule (2026-10-20):
// run this right before the full suite, any browser test, every commit and
// every deploy. Exit 0 only if every build and the check pass.
"use strict";
const path = require("path");
const { spawnSync } = require("child_process");
const { checkDistFresh } = require("./check-dist-fresh");

const ROOT = path.join(__dirname, "..");
for (const flag of [null, "--pwa", "--tauri", "--market"]) {
  const args = [path.join(ROOT, "build.js")].concat(flag ? [flag] : []);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) { console.error("Build failed: node build.js " + (flag || "") + " (exit " + r.status + ")."); process.exit(1); }
}
const problems = checkDistFresh();
if (problems.length) { console.error("Still stale after the build:\n  " + problems.join("\n  ")); process.exit(1); }
console.log("All bundles rebuilt and fresh.");
