// Run: node --no-warnings test/sw-precache-timeout-e2e.test.js
// (build first: node build.js && node build.js --pwa && node build.js --tauri)
// A stalled CDN download must not stop the service worker taking control.
// Install waits on every precache download; before PRECACHE_TIMEOUT_MS
// (sw-pwa.js / sw.js), one request that never answered kept the worker
// installing — and the page without offline support — indefinitely. That
// is what made marketing-hosted-e2e time out ("service worker never took
// control") on a slow cdnjs day. Here sql-wasm.wasm is held forever on
// purpose; each build's worker must still take control within ~20s.
"use strict";
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");
let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
function serve(dir){
  const types = { ".html":"text/html", ".js":"text/javascript", ".json":"application/json", ".png":"image/png", ".svg":"image/svg+xml", ".ico":"image/x-icon" };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seigen-swto-"));
  for(const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(tmp, f));
  const server = http.createServer((req, res)=>{
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(tmp, rel);
    if(!file.startsWith(tmp) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){ res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r=> server.listen(0, "127.0.0.1", ()=> r({ server, base:"http://127.0.0.1:"+server.address().port+"/" })));
}

(async()=>{
  const browser = await chromium.launch();
  for(const build of ["dist-pwa", "dist-tauri", "dist"]){
    await t(build+": with the CDN wasm download stalled, the service worker still takes control (time-boxed precache)", async ()=>{
      assert.ok(fs.existsSync(path.join(ROOT, build, "sw.js")), "build first");
      assert.match(fs.readFileSync(path.join(ROOT, build, "sw.js"), "utf8"), /PRECACHE_TIMEOUT_MS = 20000/);
      const { server, base } = await serve(path.join(ROOT, build));
      const ctx = await browser.newContext();
      await ctx.route(/sql-wasm\.wasm/, ()=>{});            // never answered
      try{
        const page = await ctx.newPage();
        const t0 = Date.now();
        await page.goto(base);
        let ms = null;
        while(Date.now() - t0 < 32000){
          if(await page.evaluate(()=> !!navigator.serviceWorker.controller)){ ms = Date.now() - t0; break; }
          await page.waitForTimeout(200);
        }
        assert.ok(ms !== null, "no controlling service worker after 32s");
        assert.ok(ms >= 15000, "took control at "+ms+"ms — the stall wasn't in effect?");
        // the files that did download are cached under the current cache name
        const cached = await page.evaluate(async ()=>{ const names = await caches.keys(); const c = await caches.open(names[0]); return { names, index: !!(await c.match("./index.html")), wasm: !!(await c.match("https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm")) }; });
        assert.deepStrictEqual(cached.names, ["seigen-lite-pwa-v2"]);
        assert.strictEqual(cached.index, true, "app shell cached");
        assert.strictEqual(cached.wasm, false, "the stalled file is simply not cached yet");
      } finally { await ctx.close(); server.close(); }
    });
  }
  await browser.close();
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
