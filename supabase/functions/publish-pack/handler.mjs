// The publish-pack Edge Function's request handling, with no Deno APIs, so
// the same code runs in the function (index.ts) and in the Node tests
// (test/publish-pack.test.js drives it against the real SQL in PGlite and a
// fake Storage).
//
// 1. cl_market_publish_prepare (the staff member's own token): permission,
//    pack state, ticked products, enough PAID listing days. Refusals are
//    passed back as they are.
// 2. Each ticked product's photo and thumbnail (cl_market_pack_image_data,
//    staff token) is stored in the public listing-images bucket under
//    <iTred install ID>/<sha256>.webp (and -t.webp): content-addressed, so
//    a second try overwrites with the same bytes. Only this step uses the
//    service-role key, and only against Storage.
// 3. cl_market_publish_attach (staff token): one transaction — days used,
//    the live listing replaced, logged. A second click answers "already".
// If step 2 fails nothing is published or charged; files already stored
// are harmless and are overwritten next time.
// 4. Old photo files: the database queues the files of a listing that was
//    replaced (or taken off: POST { action: "unpublish", itred_vendor_id,
//    reason }) unless a live listing still uses them (cl_market_photo_trash);
//    this function deletes them from the bucket and marks them done. A file
//    it can't delete stays queued and is tried again next time.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BUCKET = "listing-images";
const PREFIX = "data:image/webp;base64,";
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const message = (text) => {
  try { const j = JSON.parse(text); return String(j.message || j.error || text).slice(0, 400); } catch { return String(text).slice(0, 400); }
};
function claimsOf(token) {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "===".slice((p.length + 3) % 4)));
  } catch { return null; }
}
function bytesOf(dataUri) {
  if (typeof dataUri !== "string" || dataUri.indexOf(PREFIX) !== 0) return null;
  const bin = atob(dataUri.slice(PREFIX.length));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const NOT_STAFF = "Not authorized: sign in as seiGEN staff with the Market Publishing permission.";

// env: { supabaseUrl, anonKey, serviceKey }; fetchImpl: fetch (tests pass a fake)
export function makeHandler(env, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  return async function handle(req) {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json(405, { error: "POST only" });
    const auth = req.headers.get("Authorization") || "";
    const m = /^Bearer\s+(\S+)$/.exec(auth);
    if (!m) return json(401, { error: "Sign in as seiGEN staff first." });
    const claims = claimsOf(m[1]);
    if (!claims || claims.user_type !== "staff") return json(403, { error: NOT_STAFF });
    if (!env.supabaseUrl || !env.anonKey || !env.serviceKey) return json(500, { error: "Publishing isn't configured on the server." });

    let body;
    try { body = await req.json(); } catch { return json(400, { error: "Send JSON." }); }
    const items = Array.isArray(body.items) ? body.items.map(String) : [];
    const days = Number.isInteger(body.days) ? body.days : Number(body.days);

    const rpc = async (name, args) => {
      const r = await doFetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: env.anonKey, Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const text = await r.text();
      if (!r.ok) return { error: message(text), status: r.status };
      try { return { data: JSON.parse(text) }; } catch { return { error: "Unexpected answer from the database." }; }
    };

    // Deletes queued old photo files from the bucket; never fails the request.
    const sweep = async () => {
      let deleted = 0;
      try {
        const t = await rpc("cl_market_photo_trash", { p_limit: 500 });
        const rows = (t.data || []).filter((r) => /^[A-Za-z0-9_-]+\/[0-9a-f]{64}(-t)?\.webp$/.test(r.path));
        if (!rows.length) return 0;
        const r = await doFetch(`${env.supabaseUrl}/storage/v1/object/${BUCKET}`, {
          method: "DELETE",
          headers: { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: rows.map((r) => r.path) }),
        });
        if (!r.ok) return 0;
        const done = await rpc("cl_market_photo_trash_done", { p_ids: rows.map((r) => r.id) });
        deleted = done.error ? 0 : rows.length;
      } catch { /* stays queued */ }
      return deleted;
    };

    if (body.action === "unpublish") {
      const un = await rpc("cl_market_unpublish", { p_itred_vendor_id: body.itred_vendor_id ?? null, p_reason: body.reason ?? null });
      // a refused call by staff with the permission still clears the queue
      if (un.error) { if (un.status !== 401 && un.status !== 403) await sweep(); return json(un.status === 401 || un.status === 403 ? 403 : 400, { error: un.error }); }
      return json(200, Object.assign({}, un.data, { photos_deleted: await sweep() }));
    }

    const prep = await rpc("cl_market_publish_prepare", { p_pack_id: body.pack_id ?? null, p_days: days, p_items: items });
    if (prep.error) return json(prep.status === 401 || prep.status === 403 ? 403 : 400, { error: prep.error });
    const install = String(prep.data.itred_install_id || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (!install) return json(500, { error: "The pack has no iTred identity." });

    const store = async (path, bytes) => {
      const r = await doFetch(`${env.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}`, "Content-Type": "image/webp",
                   "x-upsert": "true", "Cache-Control": "max-age=31536000" },
        body: bytes,
      });
      if (!r.ok) throw new Error("Couldn't store a photo (" + r.status + ")");
      return `${env.supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;
    };
    const urls = {};
    try {
      const photos = prep.data.photos || [];
      for (let i = 0; i < photos.length; i += 4) {
        await Promise.all(photos.slice(i, i + 4).map(async (p) => {
          const d = await rpc("cl_market_pack_image_data", { p_pack_id: body.pack_id, p_source_product_id: p.source_product_id });
          if (d.error || !d.data) throw new Error(d.error || "A photo is missing from the pack");
          const sha = String(p.sha256).replace(/[^0-9a-f]/g, "");
          const full = bytesOf(d.data.image), thumb = d.data.thumb ? bytesOf(d.data.thumb) : null;
          if (!full) throw new Error("A photo isn't a WebP image");
          urls[p.source_product_id] = {
            image_url: await store(`${install}/${sha}.webp`, full),
            thumb_url: thumb ? await store(`${install}/${sha}-t.webp`, thumb) : null,
          };
        }));
      }
    } catch (e) {
      return json(502, { error: "Nothing was published: " + String(e && e.message || e).slice(0, 200) + ". Try again." });
    }

    const att = await rpc("cl_market_publish_attach", { p_pack_id: body.pack_id, p_days: days, p_items: items, p_urls: urls });
    if (att.error) return json(400, { error: att.error });
    return json(200, Object.assign({}, att.data, { photos_deleted: await sweep() }));
  };
}
