// Supabase Edge Function: issue-licence (activation v2).
// docs/activation/activation-v2-design.md, "Owner decisions".
//
// POST { device_code: "ABCD-K7Q2" } or { business_id: "<uuid>" },
//      optional days (30 | 90 | 365, default 30), plan, note.
// Authorization: Bearer <cl_login staff token>.
//
// Auth (handler.mjs): no token -> 401; a token that isn't a staff token
// (the anon key, an RPN) -> 403; then the database decides: every RPC runs
// with the caller's own token, and cl_licence_prepare / cl_licence_attach
// refuse anyone who isn't an active staff member with the "Activation
// Codes" module (or sysadmin). Anon may not execute them at all (grants).
//
// Secrets: LICENCE_SIGNING_KEY (PKCS#8 base64 from tools/licence/keygen.js,
// set with `supabase secrets set`, never logged) and LICENCE_KEY_ID (which
// public key in the app matches it). SUPABASE_URL and SUPABASE_ANON_KEY are
// provided by Supabase.
import { makeHandler } from "./handler.mjs";

Deno.serve(makeHandler({
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  signingKey: Deno.env.get("LICENCE_SIGNING_KEY") ?? "",
  keyId: Number(Deno.env.get("LICENCE_KEY_ID") ?? "1"),
}));
