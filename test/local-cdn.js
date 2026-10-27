// require("./local-cdn") before require("playwright") in every browser test:
// the cdnjs files the app loads (sql.js 1.10.3 and xlsx 0.18.5) are answered
// from test/cdn/ instead of the internet, for pages and service workers alike.
// On a slow line sql-wasm.wasm took 12-48 s from cdnjs (27 Oct), longer than
// the tests' 15 s waits, so setup and the update banner timed out. Harness
// only: the app itself still loads them from cdnjs (owner, 27 Oct; A14 moves
// them to the app's own address in v37). The route is added when a context is
// made, so a test's own later route for the same file (sw-precache-timeout's
// stalled wasm) still runs first. Byte-for-byte copies: test/local-cdn.test.js
// checks their sha256.
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "cdn");
const RE = /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/(sql\.js\/1\.10\.3\/sql-wasm\.(?:js|wasm)|xlsx\/0\.18\.5\/xlsx\.full\.min\.js)(?:[?#].*)?$/;
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm" };

// service-worker requests go through the context's routes too
if (!process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS) process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

function answer(route) {
  const rel = RE.exec(route.request().url())[1];
  return route.fulfill({ status: 200, contentType: TYPES[path.extname(rel)],
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=31536000" },
    body: fs.readFileSync(path.join(DIR, rel)) });
}
const routed = new WeakSet();
async function hook(ctx) {
  if (routed.has(ctx)) return ctx;
  routed.add(ctx);
  await ctx.route(RE, answer);
  return ctx;
}
function wrapBrowser(browser) {
  const newContext = browser.newContext.bind(browser), newPage = browser.newPage.bind(browser);
  browser.newContext = async (...a) => hook(await newContext(...a));
  browser.newPage = async (...a) => { const p = await newPage(...a); await hook(p.context()); return p; };
  return browser;
}

let pw = null;
try { pw = require("playwright"); } catch (e) { /* the test itself says Playwright is missing and skips */ }
if (pw && !pw.chromium.__localCdn) {
  const { chromium } = pw;
  const launch = chromium.launch.bind(chromium), persistent = chromium.launchPersistentContext.bind(chromium);
  chromium.launch = async (...a) => wrapBrowser(await launch(...a));
  chromium.launchPersistentContext = async (...a) => hook(await persistent(...a));
  chromium.__localCdn = true;
}

module.exports = { RE, DIR };
