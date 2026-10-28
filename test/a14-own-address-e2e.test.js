// node --no-warnings test/a14-own-address-e2e.test.js
//
// A14 (owner 27 Oct, v37): the hosted apps (dist-pwa, dist-tauri) never depend on
// cdnjs at runtime. Served over http (as the Workers serve them), with every cdnjs
// request blocked, each starts (the database engine loads) from its own vendor/
// files; the PWA's service worker precaches those, not cdnjs; Import's spreadsheet
// library comes from vendor/ too. The single file dist/ keeps cdnjs (file://).
"use strict";
require("./local-cdn");
const assert = require("assert");
const fs = require("fs"), path = require("path"), http = require("http");
require("./dist-fresh");   // stop here if a bundle is older than its source (node tools/build-all.js)

let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}
const TYPES = { ".html":"text/html; charset=utf-8", ".js":"application/javascript", ".json":"application/json", ".wasm":"application/wasm", ".png":"image/png", ".svg":"image/svg+xml", ".ico":"image/x-icon" };
function serve(dir){
  const server = http.createServer((q, r)=>{
    const p = decodeURIComponent(new URL(q.url, "http://x").pathname);
    const f = path.join(dir, p === "/" ? "index.html" : p);
    if(!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()){ r.writeHead(404); r.end(); return; }
    r.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }); r.end(fs.readFileSync(f));
  });
  return new Promise((res)=> server.listen(0, "127.0.0.1", ()=> res({ server, base:"http://127.0.0.1:" + server.address().port + "/" })));
}

(async ()=>{
  let chromium;
  try{ ({ chromium } = require("playwright")); }catch(e){ console.log("  skip (Playwright missing)"); process.exit(0); }
  const ROOT = path.join(__dirname, "..");
  const browser = await chromium.launch();
  for(const kind of ["dist-pwa", "dist-tauri"]){
    await t(kind + ": over http with cdnjs blocked, it starts from its own vendor/ files; nothing asks cdnjs", async ()=>{
      const { server, base } = await serve(path.join(ROOT, kind));
      const ctx = await browser.newContext({ serviceWorkers: kind === "dist-pwa" ? "allow" : "block" });
      const cdn = [], own = [];
      await ctx.route(/cdnjs\.cloudflare\.com/, (r)=>{ cdn.push(r.request().url()); return r.abort(); });   // runs before local-cdn's answer
      await ctx.route(/supabase\.co/, (r)=> r.abort());
      ctx.on("request", (q)=>{ if(/\/vendor\//.test(q.url())) own.push(q.url().replace(base, "")); });
      const page = await ctx.newPage();
      try{
        await page.goto(base);
        await page.waitForSelector("#setShop", { timeout:30000 });
        assert.ok(own.includes("vendor/sql-wasm.js") && own.includes("vendor/sql-wasm.wasm"), JSON.stringify(own));
        if(kind === "dist-pwa"){
          const cached = await page.evaluate(async ()=>{
            const reg = await navigator.serviceWorker.ready;
            for(let i = 0; i < 100; i++){
              const keys = await caches.keys();
              const urls = (await Promise.all(keys.map(async (k)=> (await (await caches.open(k)).keys()).map((r)=> r.url)))).flat();
              if(urls.some((u)=> u.endsWith("/vendor/xlsx.full.min.js"))) return urls;
              await new Promise((r)=> setTimeout(r, 200));
            }
            return (await Promise.all((await caches.keys()).map(async (k)=> (await (await caches.open(k)).keys()).map((r)=> r.url)))).flat();
          });
          for(const f of ["sql-wasm.js", "sql-wasm.wasm", "xlsx.full.min.js"]) assert.ok(cached.some((u)=> u.endsWith("/vendor/" + f)), "precached: " + f + " " + JSON.stringify(cached));
          assert.ok(!cached.some((u)=> /cdnjs/.test(u)), "nothing from cdnjs in the cache");
        }
        assert.deepStrictEqual(cdn, [], "no request to cdnjs");
      } finally { await ctx.close(); server.close(); }
    });
  }
  await t("dist/ (the single file, opened from disk) keeps the cdnjs addresses; the hosted pages carry none in their head", ()=>{
    const one = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
    assert.ok(one.includes("https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js"));
    for(const kind of ["dist-pwa", "dist-tauri"]){
      const html = fs.readFileSync(path.join(ROOT, kind, "index.html"), "utf8");
      assert.ok(html.includes('<script src="vendor/sql-wasm.js"></script>'), kind);
      assert.ok(!/<script src="https:\/\/cdnjs/.test(html), kind);
      for(const f of ["sql-wasm.js", "sql-wasm.wasm", "xlsx.full.min.js"])
        assert.ok(fs.readFileSync(path.join(ROOT, kind, "vendor", f)).equals(fs.readFileSync(path.join(ROOT, "assets", "vendor", f))), kind + "/vendor/" + f);
    }
    const sw = fs.readFileSync(path.join(ROOT, "dist-pwa", "sw.js"), "utf8");
    assert.ok(!/cdnjs\.cloudflare\.com\/ajax/.test(sw.split("PRECACHE_URLS")[1].split("];")[0]), "the worker precaches no cdnjs address");
  });
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
