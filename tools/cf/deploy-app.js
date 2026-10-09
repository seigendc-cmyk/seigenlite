// node tools/cf/deploy-app.js <preview|production> <mobile|desktop> [--message "..."] [--check-only]
//
// The one way to deploy the hosted app to its Cloudflare Worker:
//   preview    mobile  -> mobilepos-preview   (from dist-pwa)
//   preview    desktop -> desktoppos-preview  (from dist-tauri)
//   production mobile  -> mobilepos           (needs --production as well)
//   production desktop -> desktoppos          (needs --production as well)
// A deploy replaces the WHOLE site with the folder it's given. From 4 Oct
// every deploy of dist-pwa / dist-tauri silently dropped market.html (the
// Marketing add-on), so this refuses to deploy a folder that is missing any
// of the files the app needs, or whose index.html and sw.js are from
// different builds. After deploying it fetches /, /sw.js and /market.html
// from the live URL and fails loudly if any isn't there.
// --check-only runs the folder checks and stops (used by the tests).
// Credentials: tools/cf/wrangler.js (from .env, redacted, never printed).
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const TARGETS = {
  "preview:mobile": { worker: "mobilepos-preview", build: "dist-pwa", compat: "2026-10-02" },
  "preview:desktop": { worker: "desktoppos-preview", build: "dist-tauri", compat: "2026-10-03" },
  "production:mobile": { worker: "mobilepos", build: "dist-pwa", compat: "2026-10-02" },
  "production:desktop": { worker: "desktoppos", build: "dist-tauri", compat: "2026-10-03" },
};
const REQUIRED = ["index.html", "sw.js", "manifest.json", "market.html", "icon-192.png", "icon-512.png"];
const BASE = (worker) => "https://" + worker + ".seigendc.workers.dev/";

// The folder checks, on their own so the tests can call them.
function checkFolder(dir) {
  const problems = [];
  for (const f of REQUIRED) if (!fs.existsSync(path.join(dir, f))) problems.push("missing " + f);
  if (!problems.length) {
    const sw = fs.readFileSync(path.join(dir, "sw.js"), "utf8");
    const swBuild = (/\/\/ build: (v\d+)/.exec(sw) || [])[1];
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    // build.js puts APP_BUILD in as a number; the obfuscator may write it in hex (APP_BUILD=0xc)
    const m = /APP_BUILD\s*=\s*(0x[0-9a-fA-F]+|\d+)/.exec(html);
    const appBuild = m ? "v" + Number(m[1]) : null;
    if (!swBuild) problems.push("sw.js has no '// build: vN' line");
    else if (!appBuild) problems.push("index.html has no APP_BUILD");
    else if (appBuild !== swBuild) problems.push("index.html is build " + appBuild + " but sw.js is " + swBuild + " (rebuild both)");
    const market = fs.readFileSync(path.join(dir, "market.html"), "utf8");
    if (!/id="market"/.test(market)) problems.push("market.html isn't the Marketing add-on");
  }
  return problems;
}

function main(argv) {
  const [envName, kind] = argv;
  const t = TARGETS[envName + ":" + kind];
  if (!t) { console.error("usage: node tools/cf/deploy-app.js <preview|production> <mobile|desktop> [--message \"...\"]"); return 2; }
  if (envName === "production" && !argv.includes("--production")) {
    console.error("Production deploys need --production as well (and only after the owner's \"go production\").");
    return 2;
  }
  const src = path.join(ROOT, t.build);
  const problems = checkFolder(src);
  if (problems.length) {
    console.error("REFUSED: " + t.build + "/ is not deployable: " + problems.join("; ") + ". Nothing was deployed.");
    console.error("Build it with: node build.js " + (t.build === "dist-pwa" ? "--pwa" : "--tauri"));
    return 1;
  }
  console.log(t.build + "/ checks passed: " + REQUIRED.join(", ") + ", matching builds.");
  if (argv.includes("--check-only")) return 0;

  // A clean copy, so nothing left over from an older deploy rides along.
  const dest = path.join(ROOT, "deploy", envName, kind);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dest, f));

  const mi = argv.indexOf("--message");
  const message = mi !== -1 ? argv[mi + 1] : t.build;
  const r = spawnSync(process.execPath, [path.join(__dirname, "wrangler.js"), "deploy", "--name", t.worker,
    "--assets", dest, "--compatibility-date", t.compat, "--message", message], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) { console.error("Deploy failed (exit " + r.status + ")."); return 1; }
  return 0;
}

async function verify(worker, dir) {
  const want = fs.readFileSync(path.join(dir, "market.html"), "utf8");
  const swWant = (/\/\/ build: (v\d+)/.exec(fs.readFileSync(path.join(dir, "sw.js"), "utf8")) || [])[1];
  let bad = 0;
  for (const p of ["", "sw.js", "manifest.json", "market.html"]) {
    let res = null, body = "";
    // the new version can take a few seconds to reach every edge
    for (let i = 0; i < 6; i++) {
      res = await fetch(BASE(worker) + p + "?v=" + Date.now(), { cache: "no-store" }).catch(() => null);
      body = res && res.ok ? await res.text() : "";
      const fresh = p === "sw.js" ? body.includes("// build: " + swWant) : p === "market.html" ? body === want : res && res.ok;
      if (fresh) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    const ok = res && res.ok && (p !== "market.html" || body === want) && (p !== "sw.js" || body.includes("// build: " + swWant));
    console.log((ok ? "  ok   " : "  FAIL ") + "/" + p + " " + (res ? res.status : "no answer"));
    if (!ok) bad++;
  }
  if (bad) console.error("CHECK FAILED: the live site is missing files or serves another build. Fix before telling anyone it's deployed.");
  return bad ? 1 : 0;
}

module.exports = { checkFolder, REQUIRED, TARGETS };
if (require.main === module) {
  const argv = process.argv.slice(2);
  const code = main(argv);
  if (code !== 0 || argv.includes("--check-only")) process.exit(code);
  const t = TARGETS[argv[0] + ":" + argv[1]];
  console.log("Checking " + BASE(t.worker) + " ...");
  verify(t.worker, path.join(ROOT, "deploy", argv[0], argv[1])).then((c) => process.exit(c));
}
