// node tools/check-dist-fresh.js
//
// Owner's standing rule (2026-10-20): the app bundles are rebuilt from the
// current source right before the full suite, any browser test, every commit
// and every deploy (node tools/build-all.js). This check fails when that
// didn't happen:
//   * each file build.js GENERATES (the pages) must be newer than the newest
//     file it is built from (src/ minus the separate iTred and Field Guide
//     apps, shell/, build.js, sw-pwa.js, sw.js, manifest.json, VERSION and the
//     brand icons);
//   * each file build.js COPIES must equal its source byte for byte (a copy
//     keeps its source's time on Windows, so its time says nothing).
// Exit 0 when fresh; 1 with the list of stale files.
// Used by tools/run-suite.js, test/dist-fresh.js (every browser test of these
// bundles), tools/git-hooks/pre-commit and tools/cf/deploy-app.js.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REBUILD = "node tools/build-all.js";

// Pages build.js writes, by bundle.
const GENERATED = [
  "dist/index.html",
  "dist-pwa/index.html", "dist-pwa/market.html",
  "dist-tauri/index.html", "dist-tauri/market.html",
  "dist-market/market.html",
];
// Files build.js copies: [copy, source].
const BRAND = ["icon.ico", "icon-192.png", "icon-512.png", "icon-maskable-192.png", "icon-maskable-512.png",
  "apple-touch-icon.png", "favicon.svg", "favicon-32.png", "favicon-16.png",
  "globe-transparent-512.png", "globe-transparent-1024.png"];
const COPIED = [
  ["dist/sw.js", "sw.js"], ["dist/manifest.json", "manifest.json"],
  ["dist-pwa/sw.js", "sw-pwa.js"], ["dist-pwa/manifest.json", "manifest.json"],
  ["dist-tauri/sw.js", "sw-pwa.js"], ["dist-tauri/manifest.json", "manifest.json"],
].concat(...["dist", "dist-pwa", "dist-tauri"].map((d) => BRAND.map((f) => [d + "/" + f, "assets/brand/generated/" + f])),
  ...["dist-pwa", "dist-tauri"].map((d) => ["sql-wasm.js", "sql-wasm.wasm", "xlsx.full.min.js"].map((f) => [d + "/vendor/" + f, "assets/vendor/" + f])));   // A14

// Everything the pages are built from (a little more than needed is harmless).
const SKIP_DIRS = new Set(["src/itred", "src/fieldguide"]);
const SKIP_FILES = new Set(["shell/rpn-head.html"]);
function walk(root, rel, out) {
  const abs = path.join(root, rel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel + "/" + e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(r)) walk(root, r, out); }
    else if (!SKIP_FILES.has(r)) out.push(r);
  }
  return out;
}
function sources(root) {
  return walk(root, "src", []).concat(walk(root, "shell", []), walk(root, "assets/brand/generated", []),
    ["build.js", "sw-pwa.js", "sw.js", "manifest.json", "VERSION"]);
}

// Returns a list of problems; empty when every bundle file is fresh.
function checkDistFresh(root = ROOT) {
  const problems = [];
  let newest = null;
  for (const f of sources(root)) {
    const t = fs.statSync(path.join(root, f)).mtimeMs;
    if (!newest || t > newest.t) newest = { f, t };
  }
  for (const f of GENERATED) {
    const abs = path.join(root, f);
    if (!fs.existsSync(abs)) { problems.push(f + " is missing"); continue; }
    const t = fs.statSync(abs).mtimeMs;
    if (t < newest.t) problems.push(f + " (built " + new Date(t).toISOString() + ") is older than " + newest.f + " (" + new Date(newest.t).toISOString() + ")");
  }
  for (const [copy, src] of COPIED) {
    const a = path.join(root, copy);
    if (!fs.existsSync(a)) { problems.push(copy + " is missing"); continue; }
    if (!fs.readFileSync(a).equals(fs.readFileSync(path.join(root, src)))) problems.push(copy + " differs from " + src);
  }
  return problems;
}

module.exports = { checkDistFresh, GENERATED, COPIED, REBUILD };

if (require.main === module) {
  const problems = checkDistFresh();
  if (problems.length) {
    console.error("STALE BUILD: rebuild with `" + REBUILD + "` first.\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log("Bundles are fresh: " + GENERATED.length + " pages newer than every source, " + COPIED.length + " copies equal to their sources.");
}
