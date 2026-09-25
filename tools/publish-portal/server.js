// Digital Commerce Publish Portal — internal tool, run on Digital
// Commerce's own machine: `node tools/publish-portal/server.js`.
//
// A vendor's .scl marketing export arrives on WhatsApp; this is where it's
// reviewed and the chosen products are published to vendor_listings (and
// their photos to the listing-images bucket), so they show on the iTred
// site. Nothing in either app links here, and vendors never see it.
//
// Listens on 127.0.0.1 only. One passphrase (PORTAL_PASSPHRASE) signs in.
// The Supabase service_role key is read from the environment / .env and is
// only ever used server-side (supabase.js); the browser never receives it.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseScl } = require("./scl");
const { createSupabase } = require("./supabase");

const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_HOURS = 12;
const MAX_BODY = 45 * 1024 * 1024;
const BATCH_TTL_MS = 6 * 60 * 60 * 1000;

// Minimal .env reader (KEY=value lines, # comments); the environment wins.
function loadEnvFile(file){
  const out = {};
  if(!fs.existsSync(file)) return out;
  for(const line of fs.readFileSync(file, "utf8").split(/\r?\n/)){
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if(!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function createPortal(opts){
  const passphrase = String(opts.passphrase || "");
  if(passphrase.length < 12) throw new Error("PORTAL_PASSPHRASE must be at least 12 characters.");
  const supa = opts.supabase || createSupabase({ url: opts.supabaseUrl, serviceKey: opts.serviceKey });
  const passHash = crypto.createHash("sha256").update(passphrase).digest();
  const sessions = new Map();   // token -> expiry ms
  const batches = new Map();    // id -> { parsed, created, device, vendorRow, result }
  const failures = [];          // timestamps of failed sign-ins (last minute)
  const log = opts.log || ((...a)=> console.log(new Date().toISOString(), ...a));
  // History shows the published photos straight from the Storage bucket.
  const imageOrigin = new URL(opts.imageOrigin || opts.supabaseUrl).origin;

  const signedIn = (req)=>{
    const m = (req.headers.cookie || "").match(/(?:^|;\s*)portal_session=([A-Za-z0-9_-]+)/);
    const exp = m && sessions.get(m[1]);
    if(!exp) return false;
    if(exp < Date.now()){ sessions.delete(m[1]); return false; }
    return true;
  };
  const sweep = ()=>{ const now = Date.now(); for(const [id, b] of batches) if(now - b.created > BATCH_TTL_MS) batches.delete(id); };

  function send(res, status, body, headers){
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, Object.assign({
      "Content-Type": isBuf ? "application/octet-stream" : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'self'; img-src 'self' ${imageOrigin}; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    }, headers || {}));
    res.end(isBuf ? body : JSON.stringify(body));
  }
  function readBody(req){
    return new Promise((resolve, reject)=>{
      const chunks = []; let size = 0;
      req.on("data", c => { size += c.length; if(size > MAX_BODY){ reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on("end", ()=> resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }
  const json = (text)=>{ try{ return JSON.parse(text || "{}"); }catch(e){ return null; } };

  // What the page shows for a parsed file (no photo data — photos load from
  // /api/batches/:id/images/:n so they stay out of the JSON).
  function preview(id, b){
    const p = b.parsed;
    const live = new Set((b.live || []).map(r => r.source_product_id));
    return {
      id, exportNo: p.exportNo, exportedAt: p.exportedAt, createdIso: p.createdIso,
      fileProblems: p.fileProblems, vendorProblems: p.vendorProblems,
      vendor: p.vendor,
      registeredDevice: b.device,                // null = install ID not registered: blocks publishing
      existingVendor: b.vendorRow ? { business_name: b.vendorRow.business_name, whatsapp_number: b.vendorRow.whatsapp_number, city: b.vendorRow.city } : null,
      canPublish: p.ok && !!b.device,
      items: p.items.map(it => ({
        index: it.index,
        name: it.row && it.row.product_name, sourceProductId: it.row && it.row.source_product_id,
        price: it.row && it.row.price, currency: it.row && it.row.currency, category: it.row && it.row.category,
        stock: it.row && it.row.stock_quantity, hasImage: !!it.image, imageBytes: it.image ? it.image.length : 0,
        problems: it.problems, notes: it.notes, alreadyLive: !!(it.row && live.has(it.row.source_product_id)),
      })),
      result: b.result || null,
    };
  }

  async function publish(b, include){
    const p = b.parsed;
    const vendorRow = await supa.upsertVendor(p.vendor);
    b.vendorRow = vendorRow;
    const publishedAt = new Date().toISOString();   // one moment for the batch: it's how History groups it
    const results = [];
    for(const it of p.items){
      if(!include.has(it.index)) continue;
      const r = { index: it.index, name: it.row && it.row.product_name };
      if(it.problems.length){ results.push(Object.assign(r, { ok: false, step: "check", error: it.problems.join("; ") })); continue; }
      let step = "photo";
      try{
        const image_url = it.image ? await supa.uploadImage(p.vendor.install_id, it.row.source_product_id, it.image) : null;
        step = "listing";
        const row = await supa.insertListing(Object.assign({}, it.row, {
          vendor_id: vendorRow.id, image_url, published_at: publishedAt, status: "published",
        }));
        step = "replace older listing";
        const superseded = await supa.supersede(vendorRow.id, it.row.source_product_id, row.id);
        results.push(Object.assign(r, { ok: true, listingId: row.id, imageUrl: image_url, expiresAt: row.expires_at, superseded }));
      }catch(e){
        results.push(Object.assign(r, { ok: false, step, error: e.message }));
      }
    }
    b.result = { publishedAt, vendorId: vendorRow.id, results };
    log("publish", p.vendor.install_id, p.exportNo, results.filter(r => r.ok).length + "/" + results.length + " ok");
    return b.result;
  }

  // History from vendor_listings itself (no separate log table): one entry
  // per vendor per publish moment.
  function groupHistory(rows){
    const now = Date.now(), groups = new Map();
    for(const r of rows || []){
      const key = r.vendor_id + "|" + String(r.published_at).slice(0, 19);
      if(!groups.has(key)) groups.set(key, {
        vendorId: r.vendor_id, vendor: (r.vendors && r.vendors.business_name) || "(unknown vendor)",
        installId: r.vendors && r.vendors.install_id, publishedAt: r.published_at, listings: [] });
      const live = r.status === "published" && Date.parse(r.expires_at) > now;
      groups.get(key).listings.push({ id: r.id, name: r.product_name, price: r.price, currency: r.currency, stock: r.stock_quantity,
        category: r.category, imageUrl: r.image_url, status: live ? "live" : r.status === "published" ? "expired" : r.status, expiresAt: r.expires_at });
    }
    return [...groups.values()].map(g => Object.assign(g, {
      count: g.listings.length, live: g.listings.filter(l => l.status === "live").length }));
  }

  async function handle(req, res){
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;
    const method = req.method;
    // Only this machine's own names (blocks DNS-rebinding pages).
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "")) return send(res, 421, { error: "wrong host" });

    // Static files: the page itself is public (it's just the sign-in form
    // until the API says otherwise); everything under /api needs a session.
    if(method === "GET" && !route.startsWith("/api/")){
      const file = route === "/" ? "index.html" : route.slice(1);
      if(!/^[a-z0-9-]+\.(html|js|css)$/.test(file)) return send(res, 404, { error: "not found" });
      const full = path.join(PUBLIC_DIR, file);
      if(!fs.existsSync(full)) return send(res, 404, { error: "not found" });
      const type = { html: "text/html", js: "text/javascript", css: "text/css" }[file.split(".").pop()] + "; charset=utf-8";
      return send(res, 200, fs.readFileSync(full), { "Content-Type": type });
    }
    // Every API write needs this header: a plain cross-site form can't set it.
    if(method !== "GET" && req.headers["x-portal"] !== "1") return send(res, 403, { error: "missing X-Portal header" });

    if(route === "/api/login" && method === "POST"){
      const now = Date.now();
      while(failures.length && now - failures[0] > 60000) failures.shift();
      if(failures.length >= 5) return send(res, 429, { error: "Too many wrong passphrases. Wait a minute and try again." });
      const body = json(await readBody(req)) || {};
      const given = crypto.createHash("sha256").update(String(body.passphrase || "")).digest();
      if(!crypto.timingSafeEqual(given, passHash)){ failures.push(now); return send(res, 401, { error: "Wrong passphrase." }); }
      const token = crypto.randomBytes(32).toString("base64url");
      sessions.set(token, now + SESSION_HOURS * 3600 * 1000);
      return send(res, 200, { ok: true }, { "Set-Cookie": `portal_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}` });
    }
    if(route === "/api/session" && method === "GET") return send(res, 200, { signedIn: signedIn(req) });
    if(!signedIn(req)) return send(res, 401, { error: "Sign in first." });

    if(route === "/api/logout" && method === "POST"){
      const m = (req.headers.cookie || "").match(/portal_session=([A-Za-z0-9_-]+)/);
      if(m) sessions.delete(m[1]);
      return send(res, 200, { ok: true }, { "Set-Cookie": "portal_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    }

    // Upload: the .scl text as the body. Parsed and checked here; nothing
    // is written to Supabase until Publish.
    if(route === "/api/batches" && method === "POST"){
      sweep();
      const parsed = parseScl(await readBody(req));
      const id = crypto.randomBytes(12).toString("base64url");
      const b = { parsed, created: Date.now(), device: null, vendorRow: null, live: [] };
      if(parsed.vendor && parsed.vendor.install_id){
        b.device = await supa.registeredDevice(parsed.vendor.install_id);
        b.vendorRow = await supa.vendorByInstallId(parsed.vendor.install_id);
        if(b.vendorRow) b.live = await supa.liveListings(b.vendorRow.id);
      }
      batches.set(id, b);
      return send(res, 200, preview(id, b));
    }
    let m = route.match(/^\/api\/batches\/([A-Za-z0-9_-]+)\/images\/(\d+)$/);
    if(m && method === "GET"){
      const b = batches.get(m[1]);
      const it = b && b.parsed.items[Number(m[2])];
      if(!it || !it.image) return send(res, 404, { error: "no photo" });
      return send(res, 200, it.image, { "Content-Type": "image/webp", "Cache-Control": "private, max-age=3600" });
    }
    m = route.match(/^\/api\/batches\/([A-Za-z0-9_-]+)\/publish$/);
    if(m && method === "POST"){
      const b = batches.get(m[1]);
      if(!b) return send(res, 404, { error: "That upload has expired. Upload the file again." });
      if(!b.parsed.ok) return send(res, 409, { error: "This file has problems that stop it being published." });
      // Re-checked at publish time: an install ID must belong to a registered device.
      b.device = await supa.registeredDevice(b.parsed.vendor.install_id);
      if(!b.device) return send(res, 409, { error: "The install ID in this file doesn't match any registered device, so nothing was published." });
      if(b.publishing) return send(res, 409, { error: "Already publishing this file." });
      const body = json(await readBody(req)) || {};
      const include = new Set((Array.isArray(body.include) ? body.include : []).filter(n => Number.isInteger(n)));
      if(!include.size) return send(res, 400, { error: "Tick at least one product to publish." });
      b.publishing = true;
      try{ return send(res, 200, await publish(b, include)); }
      finally{ b.publishing = false; }
    }
    if(route === "/api/history" && method === "GET") return send(res, 200, { groups: groupHistory(await supa.recentListings(2000)) });
    m = route.match(/^\/api\/listings\/([0-9a-f-]{36})\/unpublish$/);
    if(m && method === "POST"){
      const row = await supa.unpublish(m[1]);
      if(!row) return send(res, 409, { error: "That listing isn't published (it may already be unpublished or expired)." });
      log("unpublish", m[1]);
      return send(res, 200, { ok: true, id: row.id, status: row.status });
    }
    return send(res, 404, { error: "not found" });
  }

  const server = http.createServer((req, res)=>{
    handle(req, res).catch(e => {
      log("error", req.method, req.url, e.message);
      if(!res.headersSent) send(res, e.status === 413 ? 413 : 502, { error: e.status === 413 ? "That file is too large." : "Supabase error: " + e.message });
    });
  });
  return { server, sessions, batches };
}

if(require.main === module){
  const env = Object.assign(loadEnvFile(path.join(__dirname, "..", "..", ".env")), process.env);
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PORTAL_PASSPHRASE"].filter(k => !env[k]);
  if(missing.length){ console.error("Missing in .env: " + missing.join(", ") + " (see .env.example)"); process.exit(1); }
  const port = Number(env.PORTAL_PORT || 8787);
  const { server } = createPortal({ supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, passphrase: env.PORTAL_PASSPHRASE });
  server.listen(port, "127.0.0.1", ()=> console.log(`Publish portal: http://127.0.0.1:${port}/  (this machine only)`));
}

module.exports = { createPortal, loadEnvFile };
