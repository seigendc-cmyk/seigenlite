// The portal's only way into Supabase: PostgREST and Storage over plain
// fetch() with the service_role key. That key bypasses RLS, so it lives in
// this server process only — nothing here ever returns it, and no response
// the portal sends carries it.
"use strict";
const crypto = require("crypto");

const BUCKET = "listing-images";

function createSupabase({ url, serviceKey, fetchImpl }){
  if(!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const base = url.replace(/\/+$/, "");
  const doFetch = fetchImpl || fetch;
  const auth = { apikey: serviceKey, Authorization: "Bearer " + serviceKey };

  // Errors never include the request headers, so the key can't leak through them.
  async function call(method, path, { body, headers, raw } = {}){
    const res = await doFetch(base + path, {
      method,
      headers: Object.assign({}, auth, raw ? {} : { "Content-Type": "application/json" }, headers || {}),
      body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let data = null;
    try{ data = text ? JSON.parse(text) : null; }catch(e){ data = text; }
    if(!res.ok){
      const msg = data && typeof data === "object" ? (data.message || data.error || data.msg || JSON.stringify(data)) : String(data || res.statusText);
      const err = new Error(msg + " (HTTP " + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return data;
  }
  const q = (v)=> encodeURIComponent(v);

  return {
    // Registered devices: never the secret phrase or lock flags.
    async registeredDevice(installId){
      const rows = await call("GET", `/rest/v1/cl_vendors?select=install_id,business_name,status&install_id=eq.${q(installId)}`);
      return rows && rows[0] || null;
    },
    async vendorByInstallId(installId){
      const rows = await call("GET", `/rest/v1/vendors?select=id,install_id,business_name,whatsapp_number,city&install_id=eq.${q(installId)}`);
      return rows && rows[0] || null;
    },
    async upsertVendor(v){
      const rows = await call("POST", "/rest/v1/vendors?on_conflict=install_id", {
        body: [{ install_id: v.install_id, business_name: v.business_name, whatsapp_number: v.whatsapp_number, city: v.city }],
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      });
      return rows[0];
    },
    // Live listings for these products of this vendor (to say "already live").
    async liveListings(vendorId){
      return call("GET", `/rest/v1/vendor_listings?select=id,source_product_id,published_at,expires_at&vendor_id=eq.${q(vendorId)}&status=eq.published&expires_at=gt.${q(new Date().toISOString())}`);
    },
    // Content-addressed path: the same photo re-uploads to the same object.
    async uploadImage(installId, productId, bytes){
      const safe = (s)=> String(s).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "x";
      const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const path = `${safe(installId)}/${safe(productId)}-${hash}.webp`;
      await call("POST", `/storage/v1/object/${BUCKET}/${path}`, {
        body: bytes, raw: true, headers: { "Content-Type": "image/webp", "x-upsert": "true", "Cache-Control": "max-age=31536000" },
      });
      return `${base}/storage/v1/object/public/${BUCKET}/${path}`;
    },
    async insertListing(row){
      const rows = await call("POST", "/rest/v1/vendor_listings", { body: [row], headers: { Prefer: "return=representation" } });
      return rows[0];
    },
    // Older live rows for the same product give way to the new one, so a
    // re-published product shows once, not twice.
    async supersede(vendorId, sourceProductId, keepId){
      const rows = await call("PATCH",
        `/rest/v1/vendor_listings?vendor_id=eq.${q(vendorId)}&source_product_id=eq.${q(sourceProductId)}&status=eq.published&id=neq.${q(keepId)}`,
        { body: { status: "expired" }, headers: { Prefer: "return=representation" } });
      return (rows || []).length;
    },
    async recentListings(limit){
      return call("GET", `/rest/v1/vendor_listings?select=id,vendor_id,source_product_id,product_name,price,currency,stock_quantity,category,image_url,status,published_at,expires_at,vendors(business_name,install_id)&published_at=not.is.null&order=published_at.desc&limit=${limit || 2000}`);
    },
    // Back to pending_review: hidden from customers, still on record.
    async unpublish(id){
      const rows = await call("PATCH", `/rest/v1/vendor_listings?id=eq.${q(id)}&status=eq.published`,
        { body: { status: "pending_review" }, headers: { Prefer: "return=representation" } });
      return rows && rows[0] || null;
    },
  };
}

module.exports = { createSupabase, BUCKET };
