#!/usr/bin/env node
// Reassembles src/ into either dist/index.html — the offline, double-click-
// to-open single file the app has always shipped as — or, with --pwa,
// dist-pwa/ — the same app shell packaged for static hosting so shop/branch
// staff can install it from a URL. Same src/ files, same content, either
// way: the only difference is packaging and (for --pwa) a service worker
// that precaches its CDN dependencies for real offline use after install.
// No dependencies, no bundler: this just concatenates files in a fixed
// order and inlines the CSS.
"use strict";
const fs = require("fs");
const path = require("path");
// Build-time only — invoked here in build.js (a Node script that never
// ships), never required from anything under src/. The shipped output
// stays a single self-contained HTML file: obfuscation transforms the JS
// TEXT before it's spliced into that file, it doesn't add a script tag,
// an external file, or any dependency the browser has to fetch at runtime.
const JavaScriptObfuscator = require("javascript-obfuscator");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const SHELL = path.join(ROOT, "shell");
const DIST = path.join(ROOT, "dist");
const DIST_PWA = path.join(ROOT, "dist-pwa");
const DIST_TAURI = path.join(ROOT, "dist-tauri");
const DIST_MARKET = path.join(ROOT, "dist-market");
const DIST_ITRED = path.join(ROOT, "dist-itred");
const DIST_RPN = path.join(ROOT, "dist-rpn");

// Applied to dist-pwa/ and dist-tauri/ only, as a final pass after each
// target's own HTML is fully assembled — never to dist/ (the single-file
// build meant to be forwarded/read as-is) and never to anything in src/.
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: false, // keep off — bloats output size significantly for limited benefit
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false, // false — avoid breaking anything that relies on global scope (e.g. window.XLSX, sql.js globals)
  selfDefending: true,
  sourceMap: false, // explicitly no source map — a source map would completely defeat the purpose
};
function obfuscateJS(code) {
  return JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_OPTIONS).getObfuscatedCode();
}
function logObfuscationSize(before, after) {
  const pct = (((after - before) / before) * 100).toFixed(0);
  console.log(
    "  JS obfuscated: " + before + " -> " + after + " bytes (+" + (after - before) + ", +" + pct + "%)."
  );
}

// The one source of truth for "what build is this" — edited by hand
// before each release, read fresh on every build, and unrelated to
// activation.js's per-device install_id/device_code/30-day cycle.
function readVersion() {
  return fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
}

// Explicit load order. Everything below is concatenated into one IIFE, so
// only two things actually matter for correctness: state.js must come
// first (it opens the IIFE) and main.js must come last (it closes it and
// calls boot()). Everything in between is grouped by concern, not by any
// runtime dependency — functions are hoisted, so call order never matters.
const SCRIPT_ORDER = [
  "state.js",
  "db.js",
  "activation.js",
  "pos.js",
  "printing.js",
  "utils.js",
  "router.js",
  "products.js",
  "dispatch.js",
  "docnum.js",
  "dnstatus.js",
  "dnfile.js",
  "dn-browser.js",
  "dispatch-out.js",
  "catalogue.js",
  "catalogue-app.js",
  "grvfile.js",
  "dnreceive.js",
  "dncancel.js",
  "receive-in.js",
  "adjust.js",
  "dn-cancel.js",
  "grv-import.js",
  "import.js",
  "credit.js",
  "currencies.js",
  "eod.js",
  "reports.js",
  "stocktake.js",
  "requests.js",
  "purchasing.js",
  "report-writer.js",
  "help.js",
  "backup.js",
  "sync.js",
  "devicecheckin.js",
  "terminal.js",
  "rpn.js",
  "marketing.js",
  "staff.js",
  "scanner.js",
  "drawer.js",
  "settings.js",
  "setup.js",
  "main.js",
];

// Appended only for --pwa, after main.js's closing })(); — this is plain
// top-level code outside the app's own IIFE (install prompt + update
// banner; see src/pwa-extras.js for why it has to live outside help.js/
// router.js/main.js). The single-file build's SCRIPT_ORDER above never
// includes it, so dist/index.html is completely unaffected.
const PWA_EXTRA_SCRIPTS = ["pwa-extras.js"];

// Appended only for --tauri, alongside DESKTOP_EXTRA_CSS below — the
// desktop-only Sales screen and its styles. Not part of SCRIPT_ORDER, so
// dist/ and dist-pwa/ never see renderPOSDesktop and router.js's
// feature-detect falls through to the untouched mobile renderPOS.
const DESKTOP_EXTRA_SCRIPTS = ["desktop/sales-desktop.js"];
const DESKTOP_EXTRA_CSS = ["desktop/desktop-sales.css"];

// Same concatenation logic for every build target, just a different
// script (and, for --tauri, extra CSS) list — each target is not a
// different app, just a different package of the exact same shell.
//
// opts.obfuscate (dist-pwa/dist-tauri only, see OBFUSCATOR_OPTIONS above)
// runs the fully-assembled JS text through javascript-obfuscator as the
// LAST step before it's spliced into the HTML — reads from src/ still
// happen first and are untouched; only the in-memory string handed to
// fs.writeFileSync ever gets transformed. Returns the JS byte lengths
// before/after so callers can report the size cost.
function buildHTML(scriptOrder, extraCssFiles, opts) {
  const obfuscate = !!(opts && opts.obfuscate);
  const headTop = fs.readFileSync(path.join(SHELL, "head-top.html"), "utf8");
  const headMid = fs.readFileSync(path.join(SHELL, "head-mid.html"), "utf8");
  const foot = fs.readFileSync(path.join(SHELL, "foot.html"), "utf8");
  const css = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
  const extraCss = (extraCssFiles || [])
    .map((name) => fs.readFileSync(path.join(SRC, name), "utf8"))
    .join("\n");
  const scriptParts = scriptOrder.map((name) =>
    fs.readFileSync(path.join(SRC, name), "utf8")
  );

  // Declared here, generated straight from VERSION, rather than as a
  // placeholder inside any shell/src file — no find-and-replace step,
  // just plain JS text built into the same concatenation as everything
  // else. It sits in headMid's <script> tag ahead of state.js's IIFE, so
  // every function inside that IIFE (renderAbout, renderSettings, ...)
  // can read it as a normal outer-scope variable.
  const versionDecl = "const APP_VERSION = " + JSON.stringify(readVersion()) + ";\n";

  let appJS = versionDecl + scriptParts.join("\n");
  const jsBytesBefore = Buffer.byteLength(appJS, "utf8");
  let jsBytesAfter = jsBytesBefore;
  if (obfuscate) {
    appJS = obfuscateJS(appJS);
    jsBytesAfter = Buffer.byteLength(appJS, "utf8");
  }

  const html =
    headTop +
    "<style>\n" +
    css +
    (extraCss ? "\n" + extraCss : "") +
    "</style>\n" +
    headMid +
    appJS +
    foot;

  return { html, jsBytesBefore, jsBytesAfter };
}

// Phase 1 output — unchanged. A fully self-contained file: open it straight
// from disk (file://) or forward it via WhatsApp/USB/email and it works,
// no sibling files required. manifest.json/sw.js/icons are copied alongside
// only for the case where this same file is also served over http(s).
function buildSingleFile() {
  const { html } = buildHTML(SCRIPT_ORDER); // never obfuscated — see OBFUSCATOR_OPTIONS comment above

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, "index.html"), html);

  for (const f of ["manifest.json", "sw.js", "icon.ico", "icon-192.png", "icon-512.png"]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
  }

  console.log("Built dist/index.html (" + html.length + " bytes) from " + SCRIPT_ORDER.length + " src files.");
}

// Phase 2 output — same shell, packaged for static hosting (GitHub Pages,
// Netlify, etc.) and installed to a phone home screen from that URL. The
// functional differences from dist/ are: sw-pwa.js, which precaches the
// app shell and CDN dependencies (sql.js, XLSX) at install time instead of
// only caching them reactively, so "works fully offline after first load"
// is guaranteed rather than incidental; and pwa-extras.js, which adds a
// visible Install button and an update-available banner.
function buildPWA() {
  const scriptOrder = SCRIPT_ORDER.concat(PWA_EXTRA_SCRIPTS);
  const { html, jsBytesBefore, jsBytesAfter } = buildHTML(scriptOrder, null, { obfuscate: true });

  fs.mkdirSync(DIST_PWA, { recursive: true });
  fs.writeFileSync(path.join(DIST_PWA, "index.html"), html);

  for (const f of ["manifest.json", "icon.ico", "icon-192.png", "icon-512.png"]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIST_PWA, f));
  }
  fs.copyFileSync(path.join(ROOT, "sw-pwa.js"), path.join(DIST_PWA, "sw.js"));

  console.log("Built dist-pwa/index.html (" + html.length + " bytes) from " + scriptOrder.length + " src files.");
  logObfuscationSize(jsBytesBefore, jsBytesAfter);
}

// Phase 3 output — the desktop (Tauri) admin/shop-owner build. Same shell
// and cart/checkout logic as dist/ and dist-pwa/; the only functional
// difference is the Sales screen, which router.js swaps to
// SalesDesktop's renderPOSDesktop purely because that function exists in
// this bundle (see DESKTOP_EXTRA_SCRIPTS above).
//
// This same dist-tauri/index.html is used two ways: wrapped natively by
// `tauri build` into a real .exe/.msi (that packaging is a later phase —
// this just produces the HTML it wraps, and never needs manifest.json/
// sw.js for that path), and, separately, hosted and opened in an ordinary
// desktop browser so it can ALSO be installed the PWA way (the browser's
// own install icon, or pwa-extras.js's in-app Install button) — so it
// gets the same manifest.json + precaching sw.js + install/update-banner
// script as dist-pwa/, on top of its desktop-only Sales screen.
function buildTauri() {
  // Unlike PWA_EXTRA_SCRIPTS (deliberately appended after main.js, outside
  // the app's IIFE), renderPOSDesktop needs to run inside it — it calls
  // escapeHtml/cart/searchProducts etc., which are private to that
  // closure. So this splices in before main.js rather than concatenating
  // after the full order.
  const mainIdx = SCRIPT_ORDER.indexOf("main.js");
  const scriptOrder = SCRIPT_ORDER.slice(0, mainIdx)
    .concat(DESKTOP_EXTRA_SCRIPTS, SCRIPT_ORDER.slice(mainIdx))
    .concat(PWA_EXTRA_SCRIPTS);
  const { html, jsBytesBefore, jsBytesAfter } = buildHTML(scriptOrder, DESKTOP_EXTRA_CSS, { obfuscate: true });

  fs.mkdirSync(DIST_TAURI, { recursive: true });
  fs.writeFileSync(path.join(DIST_TAURI, "index.html"), html);

  for (const f of ["manifest.json", "icon.ico", "icon-192.png", "icon-512.png"]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIST_TAURI, f));
  }
  fs.copyFileSync(path.join(ROOT, "sw-pwa.js"), path.join(DIST_TAURI, "sw.js"));

  console.log("Built dist-tauri/index.html (" + html.length + " bytes) from " + scriptOrder.length + " src files.");
  logObfuscationSize(jsBytesBefore, jsBytesAfter);
}

// The Marketing add-on — NOT another package of the core app. One
// standalone HTML file (dist-market/market.html) that the core app's
// Marketing tab (src/marketing.js) loads in a sandboxed iframe from
// "market.html" next to its own index.html. Present = the tab works;
// absent = the tab shows a "not installed" card. Same no-bundler approach
// as buildHTML: the app's styles.css + the layer's own CSS inlined, then
// its one script. It shares no JS with the core app (it can't — it runs in
// a separate document), so it has its own small shell instead of
// head-top/head-mid, which pull in the manifest and sql.js it doesn't need.
// Not obfuscated, same as dist/: it's loaded into every build, including
// the forward-as-is single file.
const MARKET_SCRIPTS = ["market/market.js"];
const MARKET_CSS = ["market/market.css"];
function buildMarket() {
  const head = fs.readFileSync(path.join(SHELL, "market-head.html"), "utf8");
  const css = [fs.readFileSync(path.join(SRC, "styles.css"), "utf8")]
    .concat(MARKET_CSS.map((name) => fs.readFileSync(path.join(SRC, name), "utf8")))
    .join("\n");
  const js = "const APP_VERSION = " + JSON.stringify(readVersion()) + ";\n" +
    MARKET_SCRIPTS.map((name) => fs.readFileSync(path.join(SRC, name), "utf8")).join("\n");
  const html =
    head +
    "<style>\n" + css + "</style>\n" +
    "</head>\n<body>\n<div id=\"market\"></div>\n<script>\n" + js + "</script>\n</body>\n</html>\n";

  fs.mkdirSync(DIST_MARKET, { recursive: true });
  fs.writeFileSync(path.join(DIST_MARKET, "market.html"), html);
  console.log("Built dist-market/market.html (" + html.length + " bytes) from " + MARKET_SCRIPTS.length + " src file(s).");
}

// The public iTred Market Place site — a separate website for customers,
// not a package of the shop app. It shares no code, styles or shell with
// the app (its own navy/gold branding, fonts, hash router), so it lives in
// its own tree, src/itred/, next to src/market/ and src/desktop/. For now
// that tree is the one self-contained index.html it was written as, and
// the build copies it through unchanged (byte for byte, not obfuscated).
// When the site gains code of its own (Supabase auth, listings, the PO
// cart), split it inside src/itred/ the way buildMarket assembles
// src/market/, rather than changing this into a copy step for more files.
const ITRED_SRC = path.join(SRC, "itred", "index.html");
function buildItred() {
  const html = fs.readFileSync(ITRED_SRC);
  fs.mkdirSync(DIST_ITRED, { recursive: true });
  fs.writeFileSync(path.join(DIST_ITRED, "index.html"), html);
  console.log("Built dist-itred/index.html (" + html.length + " bytes) from src/itred/index.html.");
}

// The RPN Field Guide — a separate installable app for RPN agents, not a
// package of the shop app. Built the way buildMarket builds dist-market:
// the app's styles.css plus the layer's own CSS inlined, then its own
// script, inside its own small shell (shell/rpn-head.html). Its source
// lives in src/fieldguide/. It is hosted on its own subdomain, so it has
// its own service worker (scope = its own origin), manifest and icons, and
// its own cache name (seigen-rpn-v1, inside sw-rpn.js). Not obfuscated.
//
// sw.js gets a BUILD_ID line on top: a hash of everything the worker
// precaches. Any change to the app changes sw.js's bytes, so installed
// copies notice the update and show their "new version" banner, with no
// hand-bumped comment to forget.
// One IIFE, in this order (app.js last: it boots). The content files are
// declared ahead of the scripts as plain consts, so the app carries the
// whole manual inside index.html and works offline from the first load.
const RPN_SCRIPTS = [
  "fieldguide/store.js", "fieldguide/coach-engine.js", "fieldguide/search.js",
  "fieldguide/console-api.js", "fieldguide/outbox.js",
  "fieldguide/coach-ui.js", "fieldguide/search-ui.js", "fieldguide/field-ui.js", "fieldguide/app.js",
];
const RPN_DATA = {
  MANUAL: "fieldguide/content/manual.json",
  COACH_LINES: "fieldguide/content/coach-lines.json",
  SEARCH_WORDS: "fieldguide/content/synonyms.json",
};
const RPN_CSS = ["fieldguide/fieldguide.css"];
// [published name, source under src/fieldguide/]
const RPN_FILES = [
  ["manifest.webmanifest", "manifest.webmanifest"],
  ["icon.svg", "icons/icon.svg"],
  ["icon-192.png", "icons/icon-192.png"],
  ["icon-512.png", "icons/icon-512.png"],
  ["icon-maskable-512.png", "icons/icon-maskable-512.png"],
  ["apple-touch-icon.png", "icons/apple-touch-icon.png"],
];
function buildRpn() {
  const crypto = require("crypto");
  const RPN_SRC = path.join(SRC, "fieldguide");
  const head = fs.readFileSync(path.join(SHELL, "rpn-head.html"), "utf8");
  const css = [fs.readFileSync(path.join(SRC, "styles.css"), "utf8")]
    .concat(RPN_CSS.map((name) => fs.readFileSync(path.join(SRC, name), "utf8")))
    .join("\n");
  // The Console's Supabase project: the same URL and publishable anon key
  // the shop app uses for device check-in, read from src/devicecheckin.js
  // so there is one copy of them. The anon key is public by design; what an
  // RPN may do is decided by RLS on their cl_login token.
  const checkin = fs.readFileSync(path.join(SRC, "devicecheckin.js"), "utf8");
  const consoleUrl = checkin.match(/const DC_SUPABASE_URL = "([^"]+)";/);
  const consoleKey = checkin.match(/const DC_ANON_KEY = "([^"]+)";/);
  if (!consoleUrl || !consoleKey) throw new Error("build --rpn: DC_SUPABASE_URL / DC_ANON_KEY not found in src/devicecheckin.js");
  // "<" escaped so no text in the data can ever close the <script> tag.
  const data = "const CONSOLE_URL = " + JSON.stringify(consoleUrl[1]) + ";\nconst CONSOLE_ANON_KEY = " + JSON.stringify(consoleKey[1]) + ";\n" + Object.keys(RPN_DATA)
    .map((name) => {
      const value = JSON.parse(fs.readFileSync(path.join(SRC, RPN_DATA[name]), "utf8"));
      return "const " + name + " = " + JSON.stringify(value).replace(/</g, "\\u003c") + ";\n";
    })
    .join("");
  const js = "const APP_VERSION = " + JSON.stringify(readVersion()) + ";\n" +
    "(function () {\n\"use strict\";\n" + data +
    RPN_SCRIPTS.map((name) => fs.readFileSync(path.join(SRC, name), "utf8")).join("\n") +
    "\n})();\n";
  const html =
    head +
    "<style>\n" + css + "</style>\n" +
    "</head>\n<body>\n<div id=\"fg\"></div>\n<script>\n" + js + "</script>\n</body>\n</html>\n";

  fs.mkdirSync(DIST_RPN, { recursive: true });
  fs.writeFileSync(path.join(DIST_RPN, "index.html"), html);
  const hash = crypto.createHash("sha256").update(html);
  for (const [out, from] of RPN_FILES) {
    const bytes = fs.readFileSync(path.join(RPN_SRC, from));
    hash.update(bytes);
    fs.writeFileSync(path.join(DIST_RPN, out), bytes);
  }
  const buildId = readVersion() + "-" + hash.digest("hex").slice(0, 12);
  const sw = "// build: " + buildId + "\n" + fs.readFileSync(path.join(RPN_SRC, "sw-rpn.js"), "utf8");
  fs.writeFileSync(path.join(DIST_RPN, "sw.js"), sw);
  console.log("Built dist-rpn/ (index.html " + html.length + " bytes, build " + buildId + ") from " + RPN_SCRIPTS.length + " src file(s).");
}

const mode = process.argv.includes("--rpn") ? "rpn" : process.argv.includes("--itred") ? "itred" : process.argv.includes("--market") ? "market" : process.argv.includes("--tauri") ? "tauri" : process.argv.includes("--pwa") ? "pwa" : "single";
if (mode === "pwa") buildPWA();
else if (mode === "tauri") buildTauri();
else if (mode === "market") buildMarket();
else if (mode === "itred") buildItred();
else if (mode === "rpn") buildRpn();
else buildSingleFile();
