// node tools/icons/verify-manifest.js
// For dist-pwa and dist-tauri served over http: Chromium's own manifest
// parse (DevTools Page.getAppManifest: errors + parsed icons), every icon
// fetched and decoded at its declared size, the head's favicon links, and
// the service worker precache list resolving. Prints JSON; exits 1 on a problem.
"use strict";
const fs = require("fs"), path = require("path"), http = require("http");
const { chromium } = require("playwright");
const ROOT = path.join(__dirname, "..", "..");

function serve(dir){
  const types = { ".html":"text/html", ".js":"text/javascript", ".json":"application/manifest+json", ".png":"image/png", ".ico":"image/x-icon", ".svg":"image/svg+xml" };
  const server = http.createServer((req, res)=>{
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(dir, rel);
    if(!file.startsWith(dir) || !fs.existsSync(file)){ res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r=> server.listen(0, "127.0.0.1", ()=> r({ server, base: "http://127.0.0.1:"+server.address().port+"/" })));
}

(async()=>{
  const browser = await chromium.launch();
  const results = {}; let bad = false;
  for(const build of ["dist-pwa", "dist-tauri"]){
    const { server, base } = await serve(path.join(ROOT, build));
    const page = await browser.newPage();
    await page.goto(base);
    const cdp = await page.context().newCDPSession(page);
    const man = await cdp.send("Page.getAppManifest");
    const parsed = JSON.parse(man.data || "{}");
    const icons = await page.evaluate(async (list)=> Promise.all(list.map(async (ic)=>{
      const img = new Image(); img.src = ic.src;
      try{ await img.decode(); }catch(e){ return { src: ic.src, ok:false }; }
      const [w, h] = ic.sizes.split("x").map(Number);
      return { src: ic.src, purpose: ic.purpose, declared: ic.sizes, actual: img.naturalWidth+"x"+img.naturalHeight, ok: img.naturalWidth===w && img.naturalHeight===h };
    })), parsed.icons||[]);
    const links = await page.evaluate(async ()=> Promise.all([...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')].map(async l=>{
      const r = await fetch(l.href); return { rel: l.rel, href: l.getAttribute("href"), status: r.status, type: r.headers.get("content-type") };
    })));
    const sw = fs.readFileSync(path.join(ROOT, build, "sw.js"), "utf8");
    const local = [...sw.matchAll(/"\.\/([^"]+)"/g)].map(m=>m[1]).filter(f=>f && f!=="market.html");
    const missing = local.filter(f=> !fs.existsSync(path.join(ROOT, build, f)));
    const cacheName = (sw.match(/CACHE_NAME = "([^"]+)"/)||[])[1];
    results[build] = { manifestErrors: man.errors, theme_color: parsed.theme_color, background_color: parsed.background_color, icons, links, sw: { cacheName, precacheLocal: local, missing } };
    if(man.errors.length || icons.some(i=>!i.ok) || links.some(l=>l.status!==200) || missing.length) bad = true;
    await page.close(); server.close();
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 1));
  process.exit(bad? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
