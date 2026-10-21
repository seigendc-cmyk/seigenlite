// node tools/run-suite.js [--no-build] [pattern]
//
// The full suite: rebuilds every bundle from the current source first
// (tools/build-all.js, owner's standing rule of 2026-10-20), then runs every
// test/*.test.js and supabase/tests/*-test.js one at a time, each with its
// own log in reports/suite/ (gitignored) and a summary there.
//   --no-build  skip the rebuild; the freshness check still runs and stops the
//               suite if a bundle is stale.
//   pattern     only the files whose path contains it (e.g. e2e).
// Exit 0 only when every file passes.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { checkDistFresh, REBUILD } = require("./check-dist-fresh");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const pattern = args.find((a) => !a.startsWith("--")) || "";

if (!args.includes("--no-build")) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "build-all.js")], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) { console.error("Rebuild failed: no tests run."); process.exit(1); }
}
const stale = checkDistFresh();
if (stale.length) { console.error("STALE BUILD: rebuild with `" + REBUILD + "`. No tests run.\n  " + stale.join("\n  ")); process.exit(1); }

const list = (dir, re) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).sort().map((f) => dir + "/" + f);
const files = list("test", /\.test\.js$/).concat(list("supabase/tests", /-test\.js$/)).filter((f) => f.includes(pattern));
const OUT = path.join(ROOT, "reports", "suite");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "logs"), { recursive: true });

const start = Date.now(), lines = [];
let pass = 0, fail = 0;
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [f], { cwd: ROOT, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || "") + (r.stderr || "") + (r.error ? "\n" + r.error.message : "");
  fs.writeFileSync(path.join(OUT, "logs", f.replace(/\//g, "_") + ".log"), out);
  const ok = r.status === 0;
  ok ? pass++ : fail++;
  const last = out.trim().split("\n").pop() || "";
  const line = (ok ? "PASS " : "FAIL(" + (r.status === null ? r.signal || "timeout" : r.status) + ") ") + f + " " + Math.round((Date.now() - t0) / 1000) + "s  " + last.trim();
  lines.push(line);
  console.log(line);
}
const total = "TOTAL " + pass + " of " + files.length + " files passed, " + fail + " failed, " + Math.round((Date.now() - start) / 1000) + " s";
lines.push(total);
fs.writeFileSync(path.join(OUT, "summary.txt"), lines.join("\n") + "\n");
console.log(total);
process.exit(fail ? 1 : 0);
