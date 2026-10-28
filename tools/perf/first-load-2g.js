// A14 (owner 27 Oct): first load of a built app on a throttled 2G line, empty cache.
// Run: node tools/perf/first-load-2g.js <folder: dist-pwa | dist-tauri | dist-itred | a copy> <shop|itred> [label] [runs]
// Serves the folder over http://127.0.0.1 (as the Cloudflare Worker serves it, gzip included), opens it in a fresh
// Chromium profile with CDP network throttling on every request, page and service worker alike:
//   2G = 280 kbit/s down, 256 kbit/s up, 800 ms round trip (WebPageTest's "2G" profile).
// Ready: shop app = past "Starting…": the database engine (sql.js + its wasm) loaded and the first screen drawn;
//        iTred    = the page drawn and its fonts loaded (document.fonts.ready).
// Other addresses (cdnjs, Google Fonts) go to the internet as in real use; seiGEN (supabase.co) is
// blocked, so nothing touches the live project. Prints one JSON line per run and the median.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), zlib = require("zlib");
const [DIR_ARG, KIND = "shop", LABEL = "", RUNS_S = "3"] = process.argv.slice(2);
const DIR = path.resolve(DIR_ARG || "dist-pwa"), RUNS = Math.max(1, Number(RUNS_S) || 3);
const { chromium } = require(path.join(__dirname, "..", "..", "node_modules", "playwright"));
const PROFILE = { offline: false, downloadThroughput: 280 * 1024 / 8, uploadThroughput: 256 * 1024 / 8, latency: 800 };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".json": "application/json", ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };

function serve(dir) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(dir, p === "/" ? "index.html" : p);
    const ok = file.startsWith(dir) && fs.existsSync(file) && fs.statSync(file).isFile();
    const f = ok ? file : path.join(dir, "index.html");
    const type = TYPES[path.extname(f)] || "application/octet-stream", body = fs.readFileSync(f);
    // compressed as Cloudflare serves it (text, scripts and wasm), so the numbers match real use
    if (/gzip/.test(req.headers["accept-encoding"] || "") && /html|javascript|json|wasm|svg|manifest/.test(type)) {
      res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip" }); res.end(zlib.gzipSync(body)); return;
    }
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port + "/" })));
}

async function once(base) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "a14-2g-"));
  const ctx = await chromium.launchPersistentContext(prof, { headless: true, serviceWorkers: "allow" });
  const byHost = {};
  try {
    await ctx.route(/supabase\.co/, (r) => r.abort());
    const page = ctx.pages()[0] || await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", PROFILE);
    cdp.on("Network.loadingFinished", (e) => { byHost.__bytes = (byHost.__bytes || 0) + e.encodedDataLength; });
    page.on("requestfinished", async (req) => {
      const host = new URL(req.url()).host;
      const s = await req.sizes().catch(() => null);
      const b = byHost[host] || (byHost[host] = { requests: 0, bytes: 0 });
      b.requests++; b.bytes += s ? s.responseBodySize + s.responseHeadersSize : 0;
    });
    const t0 = Date.now();
    await page.goto(base, { waitUntil: "commit", timeout: 900000 });
    if (KIND === "itred") {
      await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: 600000, polling: 100 });
      await page.evaluate(() => document.fonts.ready);
    } else {
      // past "Starting…" (initDB done: sql.js and its wasm loaded); "Couldn't start" fails the run
      await page.waitForFunction(() => { const a = document.querySelector("#app"); const t = a ? a.innerText.trim() : ""; return t && !/^Starting/.test(t); },
        null, { timeout: 900000, polling: 100 });
      const t = await page.evaluate(() => document.querySelector("#app").innerText.trim().slice(0, 40));
      if (/^Couldn't start/.test(t)) throw new Error("the app said Couldn't start");
    }
    const ms = Date.now() - t0;
    const fonts = KIND === "itred" ? await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, ""))) : undefined;
    delete byHost.__bytes;
    return { ms, hosts: byHost, fonts: fonts && [...new Set(fonts)] };
  } finally {
    await ctx.close();
    // Windows: Chrome can hold its profile for a moment after closing; a leftover temp folder is harmless
    try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { /* left in temp */ }
  }
}

(async () => {
  const { server, base } = await serve(DIR);
  const runs = [];
  try {
    for (let i = 0; i < RUNS; i++) {
      const r = await once(base);
      runs.push(r);
      console.log(JSON.stringify({ label: LABEL, run: i + 1, ms: r.ms, hosts: r.hosts, fonts: r.fonts }));
    }
  } finally { server.close(); }
  const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(JSON.stringify({ label: LABEL, kind: KIND, profile: "2G 280/256 kbit/s, 800 ms", runs: RUNS, median_ms: sorted[Math.floor(sorted.length / 2)], all_ms: runs.map((r) => r.ms) }));
})().catch((e) => { console.error(e); process.exit(1); });
