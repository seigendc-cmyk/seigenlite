// require("./dist-fresh") at the top of every browser test that loads dist/,
// dist-pwa/, dist-tauri/ or dist-market/: the test stops before opening a
// browser when a bundle is older than its source (tools/check-dist-fresh.js;
// owner's standing rule, 2026-10-20). Rebuild with: node tools/build-all.js
"use strict";
const { checkDistFresh, REBUILD } = require("../tools/check-dist-fresh");

const problems = checkDistFresh();
if (problems.length) {
  console.log("STALE BUILD: rebuild with `" + REBUILD + "` before running browser tests.\n  " + problems.join("\n  "));
  console.log("0 passed, 1 failed");
  process.exit(1);
}
