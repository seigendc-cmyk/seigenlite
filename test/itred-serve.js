// A local stand-in for the itred-preview Worker, for the iTred browser
// tests: serves dist-itred/ over http://127.0.0.1 the way Cloudflare's
// static assets do with not_found_handling = "single-page-application"
// (tools/cf/deploy-app.js): a real file is served as itself, any other path
// gets index.html (200), so /orders opens the app straight on Your Orders.
// state.offline = true makes every request fail (a dropped connection), to
// prove the service worker serves the shell.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "dist-itred");
const TYPES = { ".html":"text/html; charset=utf-8", ".js":"application/javascript", ".json":"application/json",
  ".webmanifest":"application/manifest+json", ".png":"image/png" };

function serveItred(){
  const state = { offline:false, requests:[] };
  const server = http.createServer((req, res)=>{
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    state.requests.push(p);
    if(state.offline){ req.socket.destroy(); return; }
    const file = path.join(DIR, p);
    const isFile = file.startsWith(DIR) && p !== "/" && fs.existsSync(file) && fs.statSync(file).isFile();
    const f = isFile ? file : path.join(DIR, "index.html");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control":"no-cache" });
    res.end(fs.readFileSync(f));
  });
  return new Promise((resolve)=> server.listen(0, "127.0.0.1", ()=>{
    state.base = "http://127.0.0.1:" + server.address().port;
    state.close = ()=> new Promise((r)=> { server.closeAllConnections(); server.close(r); });
    resolve(state);
  }));
}

module.exports = { serveItred };
