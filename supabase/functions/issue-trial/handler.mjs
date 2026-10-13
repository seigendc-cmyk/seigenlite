// The issue-trial Edge Function's request handling, with no Deno APIs, so
// the same code runs in the function (index.ts) and in the Node tests
// (test/trial-e2e.test.js drives it against the real SQL in PGlite).
// docs/activation/trial-rules-design.md §2.3.
//
// A DEVICE calls it (anon key, like every device RPC), never staff:
//   1. cl_trial_request with the anon key: the database checks the device
//      (install ID + phrase + device key), the limits, the phone, the RPN,
//      Q8 and one trial per phone / per business, in ONE transaction, and
//      answers a refusal ({ok:false, code, message}) or a pending payload.
//      It is idempotent per install, so a retry gets the same payload.
//   2. This function signs the payload and checks its own signature.
//   3. cl_trial_attach with the SERVICE ROLE key (execute is granted to
//      service_role only) stores the signature. That is the only thing the
//      service role is used for.
//
// The private key (env.signingKey, PKCS#8 base64) and the service role key
// are never logged, echoed or returned.
import { importSigningKey, signPayloadHex, hexToBytes } from "./sign.mjs";

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
export const TRY_AGAIN = "seiGEN couldn't start the trial right now. Try again in a minute.";
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);

async function verifyOwn(publicKeyB64, payloadHex, sigHex) {
  const raw = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
  const pub = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, pub, hexToBytes(sigHex), hexToBytes(payloadHex));
}

// env: { supabaseUrl, anonKey, serviceRoleKey, signingKey, keyId }; fetchImpl: fetch (tests pass a fake)
export function makeHandler(env, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  return async function handle(req) {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
    if (!env.signingKey || !env.supabaseUrl || !env.anonKey || !env.serviceRoleKey) {
      return json(500, { ok: false, code: "NOT_CONFIGURED", message: TRY_AGAIN });
    }
    let body;
    try { body = await req.json(); } catch { return json(400, { ok: false, code: "BAD_REQUEST", message: TRY_AGAIN }); }
    if (!body || typeof body !== "object") return json(400, { ok: false, code: "BAD_REQUEST", message: TRY_AGAIN });

    const rpc = (name, args, key) => doFetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });

    const earliest = typeof body.earliest_sale === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.earliest_sale) ? body.earliest_sale : null;
    const req1 = await rpc("cl_trial_request", {
      p_install_id: str(body.install_id, 16), p_secret_phrase: str(body.phrase, 200), p_device_key: str(body.device_key, 200),
      p_phone: str(body.owner_phone, 40), p_field_force_no: str(body.field_force_no, 20), p_pin: str(body.pin, 12),
      p_earliest_sale: earliest, p_key_id: env.keyId,
    }, env.anonKey);
    const text1 = await req1.text();
    if (!req1.ok) {
      // the device check raises (not registered, wrong phrase or key): say so plainly.
      // Anything else (the database function missing, a fault) gets the plain try-again.
      const msg = message(text1);
      if (req1.status !== 404 && /registered|phrase|device|install/i.test(msg)) return json(400, { ok: false, code: "DEVICE_REFUSED", message: msg });
      return json(502, { ok: false, code: "SERVER", message: TRY_AGAIN });
    }
    const ans = JSON.parse(text1);
    if (!ans || ans.ok !== true) return json(200, { ok: false, code: (ans && ans.code) || "REFUSED", message: (ans && ans.message) || TRY_AGAIN });

    const reply = (licence, validTo) => json(200, {
      ok: true, kind: ans.kind, serial: ans.serial, valid_from: ans.valid_from, valid_to: validTo || ans.valid_to, licence,
    });
    if (ans.licence) return reply(ans.licence, ans.valid_to);   // signed before (a retry, a lost answer)

    let signer;
    try { signer = await importSigningKey(env.signingKey); }
    catch { return json(500, { ok: false, code: "KEY_UNREADABLE", message: TRY_AGAIN }); }
    const sig = await signPayloadHex(signer.key, ans.payload_hex);
    if (!(await verifyOwn(signer.publicKeyB64, ans.payload_hex, sig))) {
      return json(500, { ok: false, code: "SIGNATURE_CHECK", message: TRY_AGAIN });
    }
    const att = await rpc("cl_trial_attach", { p_serial: ans.serial, p_signature_hex: sig }, env.serviceRoleKey);
    const attText = await att.text();
    if (!att.ok) return json(502, { ok: false, code: "ATTACH_FAILED", message: TRY_AGAIN });
    const a = JSON.parse(attText);
    return reply(a.licence, a.valid_to);
  };
}
