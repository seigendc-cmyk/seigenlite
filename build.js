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
  "eod.js",
  "reports.js",
  "stocktake.js",
  "requests.js",
  "purchasing.js",
  "report-writer.js",
  "help.js",
  "backup.js",
  "staff.js",
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

const mode = process.argv.includes("--tauri") ? "tauri" : process.argv.includes("--pwa") ? "pwa" : "single";
if (mode === "pwa") buildPWA();
else if (mode === "tauri") buildTauri();
else buildSingleFile();
