// node tools/cf/deploy-app.js <preview|production> <mobile|desktop|itred> [--message "..."] [--check-only]
//
// The one way to deploy the hosted app to its Cloudflare Worker:
//   preview    mobile  -> mobilepos-preview   (from dist-pwa)
//   preview    desktop -> desktoppos-preview  (from dist-tauri)
//   preview    itred   -> itred-preview       (from dist-itred: iTred Market Place)
//   production mobile  -> mobilepos           (needs --production as well)
//   production desktop -> desktoppos          (needs --production as well)
//   production itred   -> itredvpd            (needs --production as well, and a
//                         build made with --itred-base=https://itredvpd.seigendc.workers.dev/)
// iTred is served as a single-page app (wrangler config
// assets.not_found_handling = "single-page-application"): any path that
// isn't a file gets index.html, so clean addresses like /orders work.
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
  "preview:itred": { worker: "itred-preview", build: "dist-itred", compat: "2026-10-14", itred: true },
  "production:itred": { worker: "itredvpd", build: "dist-itred", compat: "2026-10-14", itred: true },
};
const REQUIRED = ["index.html", "sw.js", "manifest.json", "market.html", "icon-192.png", "icon-512.png"];
const ITRED_REQUIRED = ["index.html", "sw.js", "manifest.webmanifest", "apps.json", "itred-icon-192.png", "itred-icon-512.png",
  "itred-maskable-512.png", "apple-touch-icon.png", "og-image.png", "supabase-2.117.1.js", "jspdf-4.2.1.umd.min.js"];
const BASE = (worker) => "https://" + worker + ".seigendc.workers.dev/";

// iTred: every file there, page and sw.js from one build, and the link
// previews (og:url) built for the site it's going to.
function checkItredFolder(dir, worker) {
  const problems = [];
  for (const f of ITRED_REQUIRED) if (!fs.existsSync(path.join(dir, f))) problems.push("missing " + f);
  if (problems.length) return problems;
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const sw = fs.readFileSync(path.join(dir, "sw.js"), "utf8");
  const swBuild = (/\/\/ build: i(\d+)/.exec(sw) || [])[1], pageBuild = (/const ITRED_BUILD = (\d+);/.exec(html) || [])[1];
  if (!swBuild || swBuild !== pageBuild) problems.push("index.html is build i" + pageBuild + " but sw.js is i" + swBuild + " (rebuild)");
  if (/@@[A-Z_]+@@/.test(html)) problems.push("index.html still has a build token (copied from src/, not built)");
  const ogUrl = (/<meta property="og:url" content="([^"]+)">/.exec(html) || [])[1];
  if (ogUrl !== BASE(worker)) problems.push("built for " + ogUrl + ", not " + BASE(worker) + " (node build.js --itred --itred-base=" + BASE(worker) + ")");
  try { JSON.parse(fs.readFileSync(path.join(dir, "apps.json"), "utf8")); } catch (e) { problems.push("apps.json isn't valid JSON"); }
  return problems;
}

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
  if (!t) { console.error("usage: node tools/cf/deploy-app.js <preview|production> <mobile|desktop|itred> [--message \"...\"]"); return 2; }
  if (envName === "production" && !argv.includes("--production")) {
    console.error("Production deploys need --production as well (and only after the owner's \"go production\").");
    return 2;
  }
  const src = path.join(ROOT, t.build);
  const problems = t.itred ? checkItredFolder(src, t.worker) : checkFolder(src);
  if (problems.length) {
    console.error("REFUSED: " + t.build + "/ is not deployable: " + problems.join("; ") + ". Nothing was deployed.");
    console.error("Build it with: node build.js " + (t.itred ? "--itred" + (envName === "production" ? " --itred-base=" + BASE(t.worker) : "") : t.build === "dist-pwa" ? "--pwa" : "--tauri"));
    return 1;
  }
  console.log(t.build + "/ checks passed: " + (t.itred ? ITRED_REQUIRED : REQUIRED).join(", ") + ", matching builds.");
  if (argv.includes("--check-only")) return 0;

  // A clean copy, so nothing left over from an older deploy rides along.
  const dest = path.join(ROOT, "deploy", envName, kind);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const assets = t.itred ? path.join(dest, "site") : dest;
  fs.mkdirSync(assets, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(assets, f));

  const mi = argv.indexOf("--message");
  const message = mi !== -1 ? argv[mi + 1] : t.build;
  let args = ["deploy", "--name", t.worker, "--assets", dest, "--compatibility-date", t.compat, "--message", message];
  if (t.itred) {
    const config = path.join(dest, "wrangler.json");
    fs.writeFileSync(config, JSON.stringify({ name: t.worker, compatibility_date: t.compat,
      assets: { directory: "./site", not_found_handling: "single-page-application" } }, null, 2));
    args = ["deploy", "--config", config, "--message", message];
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, "wrangler.js"), ...args], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) { console.error("Deploy failed (exit " + r.status + ")."); return 1; }
  return 0;
}

// iTred: the page, sw.js of this build, the manifest, apps.json, and a
// clean address (/orders) answered with the page (single-page app).
async function verifyItred(worker, dir) {
  const swWant = (/\/\/ build: (i\d+)/.exec(fs.readFileSync(path.join(dir, "site", "sw.js"), "utf8")) || [])[1];
  let bad = 0;
  for (const p of ["", "sw.js", "manifest.webmanifest", "apps.json", "orders"]) {
    let res = null, body = "", ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      if (i) await new Promise((r) => setTimeout(r, 5000));
      res = await fetch(BASE(worker) + p + "?v=" + Date.now(), { cache: "no-store" }).catch(() => null);
      body = res && res.ok ? await res.text() : "";
      ok = !!(res && res.ok) && (p === "sw.js" ? body.includes("// build: " + swWant) : p === "" || p === "orders" ? /const ITRED_BUILD = /.test(body) : true);
    }
    console.log((ok ? "  ok   " : "  FAIL ") + "/" + p + " " + (res ? res.status : "no answer"));
    if (!ok) bad++;
  }
  if (bad) console.error("CHECK FAILED: the live site is missing files or serves another build. Fix before telling anyone it's deployed.");
  return bad ? 1 : 0;
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

module.exports = { checkFolder, checkItredFolder, REQUIRED, ITRED_REQUIRED, TARGETS };
if (require.main === module) {
  const argv = process.argv.slice(2);
  const code = main(argv);
  if (code !== 0 || argv.includes("--check-only")) process.exit(code);
  const t = TARGETS[argv[0] + ":" + argv[1]];
  console.log("Checking " + BASE(t.worker) + " ...");
  (t.itred ? verifyItred : verify)(t.worker, path.join(ROOT, "deploy", argv[0], argv[1])).then((c) => process.exit(c));
}
