// Digital Commerce Publish Portal — internal tool, run on Digital
// Commerce's own machine: `node tools/publish-portal/server.js`.
//
// A vendor's .scl marketing export arrives on WhatsApp; this is where it's
// reviewed and the chosen products are published to vendor_listings (and
// their photos to the listing-images bucket), so they show on the iTred
// site. Nothing in either app links here, and vendors never see it.
//
// Listens on 127.0.0.1 only. Each staff member signs in with their own
// username and password (portal_staff); an account locks for 15 minutes
// after 5 wrong passwords. Two roles:
//   admin     everything, including vendor tokens and staff accounts
//   reviewer  review, publish and unpublish listings
// Publishing needs a registered device AND an active vendor token
// (vendor_tokens). PORTAL_PASSPHRASE is only used once, to create the first
// Admin when there are no staff yet.
// The Supabase service_role key is read from the environment / .env and is
// only ever used server-side (supabase.js); the browser never receives it.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseScl } = require("./scl");
const { createSupabase } = require("./supabase");
const A = require("./accounts");

const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_HOURS = 12;
const MAX_BODY = 45 * 1024 * 1024;
const BATCH_TTL_MS = 6 * 60 * 60 * 1000;
const LOCK_AFTER = 5;          // wrong passwords in a row
const LOCK_MINUTES = 15;
const GLOBAL_FAILS = 20;       // wrong sign-ins across all accounts...
const GLOBAL_WINDOW_MS = 5 * 60 * 1000;   // ...in this window pause sign-in for everyone
const IP_FAILS = 10;           // hosted: wrong sign-ins from one client IP in that window

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

// Hosted mode (opts.publicOrigin, e.g. https://publish.example.com): the
// portal sits behind a TLS-terminating proxy (Render) on a public URL, so:
//   * only that host name is answered (instead of 127.0.0.1 / localhost)
//   * plain HTTP is redirected to HTTPS, and HSTS is sent
//   * every write must come from that origin (Origin header)
//   * wrong sign-ins are limited per client IP, so one person on the
//     internet can't pause sign-in for all staff (a much higher global
//     ceiling stays as a backstop)
//   * first-run setup is off unless allowSetup: create the first Admin
//     on the local portal, which uses the same database
function createPortal(opts){
  const setupPassphrase = String(opts.setupPassphrase || opts.passphrase || "");
  if(setupPassphrase && setupPassphrase.length < 12) throw new Error("PORTAL_PASSPHRASE must be at least 12 characters.");
  const publicOrigin = opts.publicOrigin ? new URL(opts.publicOrigin) : null;
  if(publicOrigin && (publicOrigin.protocol !== "https:" || publicOrigin.pathname !== "/" || publicOrigin.search))
    throw new Error("PORTAL_PUBLIC_ORIGIN must be an https:// origin with no path, e.g. https://publish.example.com");
  const hosted = !!publicOrigin;
  const setupAllowed = !hosted || !!opts.allowSetup;
  const hostOk = (h)=> hosted ? h === publicOrigin.host : /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h);
  const ipFailures = new Map();   // hosted: client IP -> timestamps of failed sign-ins
  const supa = opts.supabase || createSupabase({ url: opts.supabaseUrl, serviceKey: opts.serviceKey });
  const clock = opts.clock || (()=> new Date());
  const setupHash = setupPassphrase ? crypto.createHash("sha256").update(setupPassphrase).digest() : null;
  const sessions = new Map();   // token -> { staffId, exp }
  const batches = new Map();    // id -> { parsed, created, device, vendorRow, live, tokens, result }
  const failures = [];          // timestamps of failed sign-ins / setup attempts, all accounts
  const log = opts.log || ((...a)=> console.log(new Date().toISOString(), ...a));
  // History shows the published photos straight from the Storage bucket.
  const imageOrigin = new URL(opts.imageOrigin || opts.supabaseUrl).origin;

  // The session travels in an X-Portal-Session header, never a cookie. The
  // page keeps it in memory only, so every newly opened window, tab,
  // reload or installed-app launch has to sign in again: nothing the
  // browser stores (cookies, storage, the service worker's cache) can
  // carry a sign-in over. It also means no request is ever authenticated
  // just because the browser attached something automatically.
  const sessionToken = (req)=>{
    const t = String(req.headers["x-portal-session"] || "");
    return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
  };
  // Behind Render's proxy the client is the first X-Forwarded-For entry. It
  // can be spoofed, which only lets someone dodge the per-IP limit; the
  // per-account lockout and the global ceiling still apply.
  const clientIp = (req)=> hosted ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
  // The signed-in staff member, read fresh each time so a deactivation or
  // role change takes effect on the very next request.
  async function currentStaff(req){
    const tok = sessionToken(req);
    const s = tok && sessions.get(tok);
    if(!s) return null;
    if(s.exp < Date.now()){ sessions.delete(tok); return null; }
    const staff = await supa.staffById(s.staffId);
    if(!staff || !staff.active){ sessions.delete(tok); return null; }
    return staff;
  }
  function startSession(staff){
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, { staffId: staff.id, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
    return token;
  }
  function endSessionsOf(staffId){ for(const [t, s] of sessions) if(s.staffId === staffId) sessions.delete(t); }
  const me = (s)=> s && ({ id: s.id, username: s.username, name: s.display_name, role: s.role, mustChangePassword: !!s.must_change_password });
  // Local: 20 wrong sign-ins in 5 minutes pause everyone. Hosted: 10 per
  // client IP, and 200 in total as a backstop against guessing from many IPs.
  const prune = (list)=>{ const now = Date.now(); while(list.length && now - list[0] > GLOBAL_WINDOW_MS) list.shift(); return list; };
  const tooManyFailures = (req)=>{
    if(!hosted) return prune(failures).length >= GLOBAL_FAILS;
    const mine = ipFailures.get(clientIp(req));
    return prune(failures).length >= GLOBAL_FAILS * 10 || (!!mine && prune(mine).length >= IP_FAILS);
  };
  const recordFailure = (req)=>{
    failures.push(Date.now());
    if(!hosted) return;
    const ip = clientIp(req);
    if(!ipFailures.has(ip)){ if(ipFailures.size > 10000) ipFailures.clear(); ipFailures.set(ip, []); }
    ipFailures.get(ip).push(Date.now());
  };
  const clockTime = (d)=> new Intl.DateTimeFormat("en-GB", { timeZone: A.TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(d);

  const sweep = ()=>{ const now = Date.now(); for(const [id, b] of batches) if(now - b.created > BATCH_TTL_MS) batches.delete(id); };

  function send(res, status, body, headers){
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, Object.assign({
      "Content-Type": isBuf ? "application/octet-stream" : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'self'; img-src 'self' blob: ${imageOrigin}; manifest-src 'self'; worker-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    }, hosted ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}, headers || {}));
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
  const str = (v, max)=>{ const s = String(v == null ? "" : v).trim(); return s ? s.slice(0, max) : null; };

  // ---------------- tokens ----------------
  const today = ()=> A.todayLocal(clock());
  function tokenInfo(tokens){
    const t = today(), status = A.tokenStatus(tokens, t);
    return Object.assign({ message: A.tokenBlockMessage(status), defaultStart: A.defaultStart(status, t) }, status);
  }
  async function refreshBatch(b){
    const inst = b.parsed.vendor && b.parsed.vendor.install_id;
    if(!inst) return;
    b.device = await supa.registeredDevice(inst);
    b.vendorRow = await supa.vendorByInstallId(inst);
    b.live = b.vendorRow ? await supa.liveListings(b.vendorRow.id) : [];
    b.tokens = await supa.tokens(inst);
  }

  // What the page shows for a parsed file (no photo data — photos load from
  // /api/batches/:id/images/:n so they stay out of the JSON).
  function preview(id, b){
    const p = b.parsed;
    const live = new Set((b.live || []).map(r => r.source_product_id));
    const token = tokenInfo(b.tokens);
    return {
      id, exportNo: p.exportNo, exportedAt: p.exportedAt, createdIso: p.createdIso,
      fileProblems: p.fileProblems, vendorProblems: p.vendorProblems,
      vendor: p.vendor,
      registeredDevice: b.device,                // null = install ID not registered: blocks publishing
      existingVendor: b.vendorRow ? { business_name: b.vendorRow.business_name, whatsapp_number: b.vendorRow.whatsapp_number, city: b.vendorRow.city } : null,
      token,                                     // not active = blocks publishing
      canPublish: p.ok && !!b.device && token.state === "active",
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

  async function publish(b, include, staff){
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
    log("publish", staff.username, p.vendor.install_id, p.exportNo, results.filter(r => r.ok).length + "/" + results.length + " ok");
    return b.result;
  }

  // History from vendor_listings itself (no separate log table): one entry
  // per vendor per publish moment, with the vendor's token status.
  function groupHistory(rows, tokensByInstall){
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
      count: g.listings.length, live: g.listings.filter(l => l.status === "live").length,
      token: tokenInfo(tokensByInstall.get(g.installId) || []) }));
  }
  const byInstall = (tokens)=>{ const m = new Map(); for(const t of tokens || []){ if(!m.has(t.install_id)) m.set(t.install_id, []); m.get(t.install_id).push(t); } return m; };

  function tokenView(t, names){
    return { id: t.id, startsOn: t.starts_on, endsOn: t.ends_on, days: t.days, amount: t.amount == null ? null : Number(t.amount),
      currency: t.currency, paymentMethod: t.payment_method, reference: t.reference, notes: t.notes,
      recordedBy: names.get(t.recorded_by) || "(unknown)", recordedAt: t.recorded_at,
      voidedAt: t.voided_at, voidedBy: t.voided_by ? names.get(t.voided_by) || "(unknown)" : null, voidReason: t.void_reason };
  }
  async function staffNames(){ return new Map((await supa.listStaff()).map(s => [s.id, s.display_name])); }

  // Checks a token purchase from the form; returns [row, problem].
  function tokenRow(body){
    const startsOn = String(body.startsOn || "");
    if(!A.isDate(startsOn)) return [null, "Choose the date the token starts."];
    const days = Number(body.days);
    if(!Number.isInteger(days) || days < 1 || days > 366) return [null, "The token must cover 1 to 366 days."];
    let amount = null;
    if(body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== ""){
      amount = Number(body.amount);
      if(!isFinite(amount) || amount < 0) return [null, "The amount paid must be a number, 0 or more."];
      amount = Math.round(amount * 100) / 100;
    }
    const currency = str(body.currency, 3);
    if(currency && !/^[A-Z]{3}$/.test(currency)) return [null, "Currency is a 3-letter code, e.g. USD."];
    if(amount !== null && !currency) return [null, "Give the currency of the amount paid."];
    return [{ starts_on: startsOn, days, amount, currency: amount === null ? null : currency,
      payment_method: str(body.paymentMethod, 40), reference: str(body.reference, 120), notes: str(body.notes, 500) }, ""];
  }

  function staffView(s){
    const locked = !!(s.locked_until && Date.parse(s.locked_until) > clock().getTime());
    return { id: s.id, username: s.username, name: s.display_name, role: s.role, active: s.active,
      mustChangePassword: s.must_change_password, locked, lockedUntil: locked ? s.locked_until : null, lastLoginAt: s.last_login_at, createdAt: s.created_at };
  }
  async function activeAdmins(){ return (await supa.listStaff()).filter(s => s.active && s.role === "admin"); }

  async function handle(req, res){
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;
    const method = req.method;
    // For the host's health check: says nothing, touches nothing.
    if(route === "/healthz" && method === "GET") return send(res, 200, { ok: true });
    // Only this portal's own name: 127.0.0.1/localhost locally (blocks
    // DNS-rebinding pages), the public host name when hosted.
    if(!hostOk(req.headers.host || "")) return send(res, 421, { error: "wrong host" });
    if(hosted && req.headers["x-forwarded-proto"] !== "https"){
      if(method === "GET" || method === "HEAD"){ res.writeHead(308, { Location: publicOrigin.origin + req.url }); return res.end(); }
      return send(res, 403, { error: "Use https." });
    }
    // Sent by the page as it closes or reloads (navigator.sendBeacon, which
    // can't add headers): ends the session whose token is in the body.
    // Knowing a token is the only way to use it, so this needs nothing else.
    if(method === "POST" && route === "/api/end-session"){
      const t = String((json(await readBody(req)) || {}).session || "");
      if(/^[A-Za-z0-9_-]{43}$/.test(t)) sessions.delete(t);
      res.writeHead(204, { "Cache-Control": "no-store" }); return res.end();
    }
    if(method === "GET" && route === "/robots.txt")
      return send(res, 200, Buffer.from("User-agent: *\nDisallow: /\n"), { "Content-Type": "text/plain; charset=utf-8" });
    // Hosted: every write must come from the portal's own page.
    if(hosted && method !== "GET" && req.headers.origin !== publicOrigin.origin) return send(res, 403, { error: "wrong origin" });

    // Static files: the page itself is public (it's just the sign-in form
    // until the API says otherwise); everything under /api needs a session.
    if(method === "GET" && !route.startsWith("/api/")){
      const file = route === "/" ? "index.html" : route.slice(1);
      if(!/^[a-z0-9-]+\.(html|js|css|webmanifest|png)$/.test(file)) return send(res, 404, { error: "not found" });
      const full = path.join(PUBLIC_DIR, file);
      if(!fs.existsSync(full)) return send(res, 404, { error: "not found" });
      const type = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
        webmanifest: "application/manifest+json; charset=utf-8", png: "image/png" }[file.split(".").pop()];
      return send(res, 200, fs.readFileSync(full), { "Content-Type": type });
    }
    // Every API write needs this header: a plain cross-site form can't set it.
    if(method !== "GET" && req.headers["x-portal"] !== "1") return send(res, 403, { error: "missing X-Portal header" });

    if(route === "/api/session" && method === "GET"){
      const staff = await currentStaff(req);
      const setupNeeded = !staff && (await supa.staffCount()) === 0;
      return send(res, 200, { signedIn: !!staff, me: me(staff), setupNeeded, setupAvailable: !!setupHash && setupAllowed });
    }

    // First run only: create the first Admin, proven by PORTAL_PASSPHRASE.
    if(route === "/api/setup" && method === "POST"){
      if(tooManyFailures(req)) return send(res, 429, { error: "Too many wrong tries. Wait a few minutes and try again." });
      if((await supa.staffCount()) > 0) return send(res, 409, { error: "Setup is already done. Sign in with your username and password." });
      if(!setupAllowed) return send(res, 403, { error: "Setup is off on the hosted portal. Create the first Admin on the local portal (same database), then sign in here." });
      if(!setupHash) return send(res, 503, { error: "Set PORTAL_PASSPHRASE in .env, restart the portal, then try again." });
      const body = json(await readBody(req)) || {};
      const given = crypto.createHash("sha256").update(String(body.setupPassphrase || "")).digest();
      if(!crypto.timingSafeEqual(given, setupHash)){ recordFailure(req); return send(res, 401, { error: "That isn't the setup passphrase (PORTAL_PASSPHRASE in .env)." }); }
      const username = A.normalizeUsername(body.username);
      const problem = A.usernameProblem(username) || (str(body.displayName, 80) ? "" : "Enter your name.") || A.passwordProblem(body.password, username);
      if(problem) return send(res, 400, { error: problem });
      const staff = await supa.insertStaff({ username, display_name: str(body.displayName, 80), role: "admin", password_hash: A.hashPassword(body.password), last_login_at: clock().toISOString() });
      log("setup: first admin", username);
      return send(res, 200, { ok: true, me: me(staff), session: startSession(staff) });
    }

    if(route === "/api/login" && method === "POST"){
      if(tooManyFailures(req)) return send(res, 429, { error: "Too many wrong sign-ins on this portal. Wait a few minutes and try again." });
      const body = json(await readBody(req)) || {};
      const username = A.normalizeUsername(body.username);
      const password = String(body.password || "");
      const staff = username ? await supa.staffByUsername(username) : null;
      if(!staff || !staff.active){
        A.verifyPassword(password, A.DUMMY_HASH);   // same time as a real check
        recordFailure(req);
        return send(res, 401, { error: "Wrong username or password." });
      }
      const now = clock();
      if(staff.locked_until && Date.parse(staff.locked_until) > now.getTime())
        return send(res, 423, { error: `This account is locked after ${LOCK_AFTER} wrong passwords. Try again after ${clockTime(new Date(staff.locked_until))}, or ask an Admin to unlock it.` });
      if(!A.verifyPassword(password, staff.password_hash)){
        recordFailure(req);
        const n = (staff.failed_attempts || 0) + 1;
        if(n >= LOCK_AFTER){
          const until = new Date(now.getTime() + LOCK_MINUTES * 60000);
          await supa.updateStaff(staff.id, { failed_attempts: 0, locked_until: until.toISOString() });
          log("locked", username);
          return send(res, 423, { error: `Wrong password. After ${LOCK_AFTER} wrong tries this account is locked until ${clockTime(until)}; an Admin can unlock it sooner.` });
        }
        await supa.updateStaff(staff.id, { failed_attempts: n });
        return send(res, 401, { error: "Wrong username or password." });
      }
      await supa.updateStaff(staff.id, { failed_attempts: 0, locked_until: null, last_login_at: now.toISOString() });
      log("login", username);
      return send(res, 200, { ok: true, me: me(staff), session: startSession(staff) });
    }

    const staff = await currentStaff(req);
    if(!staff) return send(res, 401, { error: "Sign in first." });
    const isAdmin = staff.role === "admin";
    const adminOnly = (what)=> send(res, 403, { error: `Only an Admin can ${what}.` });

    if(route === "/api/logout" && method === "POST"){
      sessions.delete(sessionToken(req));
      return send(res, 200, { ok: true });
    }
    if(route === "/api/password" && method === "POST"){
      const body = json(await readBody(req)) || {};
      if(!A.verifyPassword(String(body.current || ""), staff.password_hash)) return send(res, 400, { error: "Your current password isn't right." });
      const problem = A.passwordProblem(body.next, staff.username) || (body.next === body.current ? "Choose a password different from the current one." : "");
      if(problem) return send(res, 400, { error: problem });
      const row = await supa.updateStaff(staff.id, { password_hash: A.hashPassword(body.next), must_change_password: false });
      // Other sign-ins with the old password end; this one carries on.
      const keep = sessionToken(req);
      for(const [t, s] of sessions) if(s.staffId === staff.id && t !== keep) sessions.delete(t);
      log("password changed", staff.username);
      return send(res, 200, { ok: true, me: me(row) });
    }
    // A temporary password (new account, or reset by an Admin) must be changed first.
    if(staff.must_change_password) return send(res, 403, { error: "Choose a new password first.", mustChangePassword: true });

    // Upload: the .scl text as the body. Parsed and checked here; nothing
    // is written to Supabase until Publish.
    if(route === "/api/batches" && method === "POST"){
      sweep();
      const parsed = parseScl(await readBody(req));
      const id = crypto.randomBytes(12).toString("base64url");
      const b = { parsed, created: Date.now(), device: null, vendorRow: null, live: [], tokens: [] };
      await refreshBatch(b);
      batches.set(id, b);
      return send(res, 200, preview(id, b));
    }
    let m = route.match(/^\/api\/batches\/([A-Za-z0-9_-]+)$/);
    if(m && method === "GET"){
      // Checked again (device, token): e.g. after an Admin records a token.
      const b = batches.get(m[1]);
      if(!b) return send(res, 404, { error: "That upload has expired. Upload the file again." });
      await refreshBatch(b);
      return send(res, 200, preview(m[1], b));
    }
    m = route.match(/^\/api\/batches\/([A-Za-z0-9_-]+)\/images\/(\d+)$/);
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
      // Re-checked at publish time: a registered device, and an active token.
      await refreshBatch(b);
      if(!b.device) return send(res, 409, { error: "The install ID in this file doesn't match any registered device, so nothing was published." });
      const token = tokenInfo(b.tokens);
      if(token.state !== "active") return send(res, 409, { error: token.message + " Nothing was published.", token });
      if(b.publishing) return send(res, 409, { error: "Already publishing this file." });
      const body = json(await readBody(req)) || {};
      const include = new Set((Array.isArray(body.include) ? body.include : []).filter(n => Number.isInteger(n)));
      if(!include.size) return send(res, 400, { error: "Tick at least one product to publish." });
      b.publishing = true;
      try{ return send(res, 200, await publish(b, include, staff)); }
      finally{ b.publishing = false; }
    }
    if(route === "/api/history" && method === "GET"){
      const [rows, tokens] = await Promise.all([supa.recentListings(2000), supa.tokens()]);
      return send(res, 200, { groups: groupHistory(rows, byInstall(tokens)) });
    }
    m = route.match(/^\/api\/listings\/([0-9a-f-]{36})\/unpublish$/);
    if(m && method === "POST"){
      const row = await supa.unpublish(m[1]);
      if(!row) return send(res, 409, { error: "That listing isn't published (it may already be unpublished or expired)." });
      log("unpublish", staff.username, m[1]);
      return send(res, 200, { ok: true, id: row.id, status: row.status });
    }

    // ---- vendors (registered devices) and their tokens ----
    if(route === "/api/vendors" && method === "GET"){
      const [devices, tokens, names] = await Promise.all([supa.registeredDevices(), supa.tokens(), staffNames()]);
      const tb = byInstall(tokens), t = today();
      return send(res, 200, { today: t, vendors: devices.map(d => {
        const list = tb.get(d.install_id) || [];
        const token = tokenInfo(list);
        return { installId: d.install_id, businessName: d.business_name, deviceStatus: d.status, token,
          defaultStart: A.defaultStart(token, t), tokens: list.slice().reverse().map(x => tokenView(x, names)) };
      }) });
    }
    m = route.match(/^\/api\/vendors\/([^/]+)\/tokens$/);
    if(m && method === "POST"){
      if(!isAdmin) return adminOnly("record token purchases");
      const installId = decodeURIComponent(m[1]);
      const device = await supa.registeredDevice(installId);
      if(!device) return send(res, 404, { error: "No registered device has that install ID." });
      const [row, problem] = tokenRow(json(await readBody(req)) || {});
      if(problem) return send(res, 400, { error: problem });
      const saved = await supa.insertToken(Object.assign(row, { install_id: installId, business_name: device.business_name, recorded_by: staff.id }));
      log("token recorded", staff.username, installId, saved.starts_on, saved.days + "d");
      const token = tokenInfo(await supa.tokens(installId));
      return send(res, 200, { ok: true, token, recorded: tokenView(saved, new Map([[staff.id, staff.display_name]])) });
    }
    m = route.match(/^\/api\/tokens\/([0-9a-f-]{36})\/void$/);
    if(m && method === "POST"){
      if(!isAdmin) return adminOnly("void token purchases");
      const reason = str((json(await readBody(req)) || {}).reason, 200);
      if(!reason) return send(res, 400, { error: "Say why this token is being voided." });
      const row = await supa.voidToken(m[1], { voided_at: clock().toISOString(), voided_by: staff.id, void_reason: reason });
      if(!row) return send(res, 409, { error: "That token doesn't exist or is already voided." });
      log("token voided", staff.username, m[1], reason);
      return send(res, 200, { ok: true });
    }

    // ---- staff accounts (Admin only) ----
    if(route === "/api/staff" && method === "GET"){
      if(!isAdmin) return adminOnly("manage staff accounts");
      return send(res, 200, { staff: (await supa.listStaff()).map(staffView) });
    }
    if(route === "/api/staff" && method === "POST"){
      if(!isAdmin) return adminOnly("manage staff accounts");
      const body = json(await readBody(req)) || {};
      const username = A.normalizeUsername(body.username);
      const problem = A.usernameProblem(username) || (str(body.displayName, 80) ? "" : "Enter their name.")
        || (A.ROLES.includes(body.role) ? "" : "Choose Admin or Reviewer.") || A.passwordProblem(body.password, username);
      if(problem) return send(res, 400, { error: problem });
      if(await supa.staffByUsername(username)) return send(res, 409, { error: `The username "${username}" is already taken.` });
      // The password is temporary: they choose their own at first sign-in.
      const row = await supa.insertStaff({ username, display_name: str(body.displayName, 80), role: body.role,
        password_hash: A.hashPassword(body.password), must_change_password: true, created_by: staff.id });
      log("staff added", staff.username, username, body.role);
      return send(res, 200, { ok: true, staff: staffView(row) });
    }
    m = route.match(/^\/api\/staff\/([0-9a-f-]{36})$/);
    if(m && method === "POST"){
      if(!isAdmin) return adminOnly("manage staff accounts");
      const target = await supa.staffById(m[1]);
      if(!target) return send(res, 404, { error: "No such staff account." });
      const body = json(await readBody(req)) || {};
      const self = target.id === staff.id;
      const lastAdmin = target.role === "admin" && target.active && (await activeAdmins()).length <= 1;
      let patch;
      if(body.action === "role"){
        if(!A.ROLES.includes(body.role)) return send(res, 400, { error: "Choose Admin or Reviewer." });
        if(self) return send(res, 400, { error: "You can't change your own role. Ask another Admin." });
        if(body.role !== "admin" && lastAdmin) return send(res, 400, { error: "There must always be at least one active Admin." });
        patch = { role: body.role };
      } else if(body.action === "deactivate"){
        if(self) return send(res, 400, { error: "You can't deactivate your own account." });
        if(lastAdmin) return send(res, 400, { error: "There must always be at least one active Admin." });
        patch = { active: false };
      } else if(body.action === "activate"){
        patch = { active: true };
      } else if(body.action === "unlock"){
        patch = { failed_attempts: 0, locked_until: null };
      } else if(body.action === "reset-password"){
        const problem = A.passwordProblem(body.password, target.username);
        if(problem) return send(res, 400, { error: problem });
        patch = { password_hash: A.hashPassword(body.password), must_change_password: true, failed_attempts: 0, locked_until: null };
      } else return send(res, 400, { error: "Unknown change." });
      const row = await supa.updateStaff(target.id, patch);
      if(patch.active === false || patch.password_hash) endSessionsOf(target.id);
      log("staff " + body.action, staff.username, target.username, body.role || "");
      return send(res, 200, { ok: true, staff: staffView(row) });
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
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(k => !env[k]);
  if(missing.length){ console.error("Missing in .env: " + missing.join(", ") + " (see .env.example)"); process.exit(1); }
  // Hosted (Render): PORTAL_PUBLIC_ORIGIN set, listen on all interfaces on
  // the PORT the host gives. Locally: 127.0.0.1 only.
  const publicOrigin = env.PORTAL_PUBLIC_ORIGIN || "";
  const port = Number(env.PORT || env.PORTAL_PORT || 8787);
  const bind = publicOrigin ? "0.0.0.0" : "127.0.0.1";
  const { server } = createPortal({ supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, setupPassphrase: env.PORTAL_PASSPHRASE,
    publicOrigin, allowSetup: env.PORTAL_ALLOW_SETUP === "1" });
  server.listen(port, bind, ()=> console.log(publicOrigin
    ? `Publish portal (hosted): ${publicOrigin}/  listening on ${bind}:${port}`
    : `Publish portal: http://127.0.0.1:${port}/  (this machine only)`));
}

module.exports = { createPortal, loadEnvFile, LOCK_AFTER, LOCK_MINUTES };
