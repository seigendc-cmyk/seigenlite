// Run: node test/dist-fresh-check.test.js
// tools/check-dist-fresh.js (owner's standing rule, 2026-10-20): on a temp
// copy of the sources and bundles it
//   * passes when every page is newer than every source and every copy equals its source;
//   * fails when a page is older than an edited source file (the 20 Oct stale dist/index.html);
//   * fails when a copied file (sw.js) differs from its source;
//   * fails when a page is missing.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkDistFresh, GENERATED, COPIED } = require("../tools/check-dist-fresh");

let passed = 0, failed = 0;
function t(name, fn){
  try{ fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}

// A small fake repo: two sources per folder the check walks, the pages, and the copies.
function fakeRepo(){
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dist-fresh-"));
  const put = (rel, text)=>{ const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive:true }); fs.writeFileSync(f, text); return f; };
  const old = new Date(Date.now() - 60000), now = new Date();
  const sources = ["src/main.js", "src/seat.js", "src/desktop/sales-desktop.js", "src/itred/index.html", "src/fieldguide/x.js",
    "shell/head-top.html", "shell/rpn-head.html", "build.js", "sw-pwa.js", "sw.js", "manifest.json", "VERSION"]
    .concat(COPIED.filter(([, s])=>s.startsWith("assets/")).map(([, s])=>s));
  for(const s of new Set(sources)) fs.utimesSync(put(s, "source " + s), old, old);
  for(const [copy, src] of COPIED) fs.copyFileSync(path.join(root, src), put(copy, ""));
  for(const g of GENERATED) fs.utimesSync(put(g, "page " + g), now, now);
  return { root, put };
}

t("fresh: every page newer than every source, every copy equal: no problems", ()=>{
  const { root } = fakeRepo();
  assert.deepStrictEqual(checkDistFresh(root), []);
});

t("a source edited after the build makes every page stale, naming that file", ()=>{
  const { root } = fakeRepo();
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(root, "src/seat.js"), later, later);
  const p = checkDistFresh(root);
  assert.strictEqual(p.length, GENERATED.length, p.join("\n"));
  assert.ok(p.every((x)=>x.includes("older than src/seat.js")), p.join("\n"));
  assert.ok(p.some((x)=>x.startsWith("dist/index.html ")), p.join("\n"));
});

t("an edit in the separate iTred or Field Guide app, or the RPN shell, doesn't count", ()=>{
  const { root } = fakeRepo();
  const later = new Date(Date.now() + 60000);
  for(const f of ["src/itred/index.html", "src/fieldguide/x.js", "shell/rpn-head.html"]) fs.utimesSync(path.join(root, f), later, later);
  assert.deepStrictEqual(checkDistFresh(root), []);
});

t("a copied sw.js that differs from sw-pwa.js is reported, whatever its time", ()=>{
  const { root, put } = fakeRepo();
  put("dist-pwa/sw.js", "an older service worker");
  assert.deepStrictEqual(checkDistFresh(root), ["dist-pwa/sw.js differs from sw-pwa.js"]);
});

t("a missing page is reported", ()=>{
  const { root } = fakeRepo();
  fs.rmSync(path.join(root, "dist-tauri/index.html"));
  assert.deepStrictEqual(checkDistFresh(root), ["dist-tauri/index.html is missing"]);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
