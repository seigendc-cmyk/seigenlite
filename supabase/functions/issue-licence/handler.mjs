// The issue-licence Edge Function's request handling, with no Deno APIs, so
// the same code runs in the function (index.ts) and in the Node tests
// (test/licence-e2e.test.js drives it against the real SQL in PGlite).
//
// Who may issue is decided by the DATABASE: every call goes to the RPCs
// with the caller's OWN token, and cl_licence_prepare / cl_licence_attach
// refuse anyone who isn't an active staff member with the "Activation
// Codes" module (or sysadmin). This function adds two refusals of its own
// before anything else: no bearer token at all, and a token that isn't a
// staff token (anon key, an RPN). It never uses the service-role key.
//
// The private key (env.signingKey, PKCS#8 base64) is only ever passed to
// importSigningKey; it is never logged, echoed or returned.
import { importSigningKey, signPayloadHex } from "./sign.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const message = (text) => {
  try { const j = JSON.parse(text); return String(j.message || j.error || text).slice(0, 300); } catch { return String(text).slice(0, 300); }
};
// The token's claims, NOT verified here (the database verifies the
// signature on every RPC); used only to refuse early and say why.
function claimsOf(token) {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "===".slice((p.length + 3) % 4)));
  } catch { return null; }
}
export const NOT_STAFF = "Not authorized: sign in as seiGEN staff with the Activation Codes permission.";

// env: { supabaseUrl, anonKey, signingKey, keyId }; fetchImpl: fetch (tests pass a fake)
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
    if (!env.signingKey || !env.supabaseUrl || !env.anonKey) return json(500, { error: "Licence signing is not configured on the server." });

    let body;
    try { body = await req.json(); } catch { return json(400, { error: "Send JSON." }); }

    const rpc = (name, args) => doFetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: env.anonKey, Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });

    const prep = await rpc("cl_licence_prepare", {
      p_device_code: body.device_code ?? null, p_business_id: body.business_id ?? null,
      p_days: body.days ?? 30, p_plan: body.plan ?? 0, p_key_id: env.keyId, p_note: body.note ?? null,
    });
    const prepText = await prep.text();
    if (!prep.ok) {
      const msg = message(prepText);
      const denied = prep.status === 401 || prep.status === 403 || /not authorized|permission denied|JWT/i.test(msg);
      return json(denied ? 403 : 400, { error: denied ? NOT_STAFF : msg });
    }
    const prepared = JSON.parse(prepText);

    let signer;
    try { signer = await importSigningKey(env.signingKey); }
    catch { return json(500, { error: "The licence signing key on the server can't be read." }); }

    const licences = [];
    for (const l of prepared.licences || []) {
      const sig = await signPayloadHex(signer.key, l.payload_hex);
      const att = await rpc("cl_licence_attach", { p_serial: l.serial, p_signature_hex: sig });
      const attText = await att.text();
      if (!att.ok) return json(500, { error: message(attText), licences, failed_serial: l.serial });
      const a = JSON.parse(attText);
      licences.push({
        serial: l.serial, device_code: l.device_code, install_id: l.install_id, strong_binding: l.strong_binding,
        business_name: l.business_name, branch: l.branch, till_code: l.till_code,
        days: l.days, valid_from: l.valid_from, valid_to: a.valid_to, short_code: l.short_code, licence: a.licence,
      });
    }
    return json(200, { key_id: env.keyId, public_key: signer.publicKeyB64, licences, skipped: prepared.skipped || [] });
  };
}
