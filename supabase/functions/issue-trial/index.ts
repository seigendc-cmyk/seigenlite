// Supabase Edge Function: issue-trial (trial rules).
// docs/activation/trial-rules-design.md §2.3.
//
// POST { install_id, phrase, device_key, owner_phone, field_force_no, pin, earliest_sale }
// Authorization: Bearer <the app's anon key> (a device, like every device RPC).
//
// The database decides everything (cl_trial_request, anon key, one
// transaction); this function only signs the payload it prepares and stores
// the signature with cl_trial_attach, which only service_role may execute.
//
// Secrets: LICENCE_SIGNING_KEY and LICENCE_KEY_ID, the same project-wide
// secrets issue-licence uses (never logged). SUPABASE_URL, SUPABASE_ANON_KEY
// and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { makeHandler } from "./handler.mjs";

Deno.serve(makeHandler({
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  signingKey: Deno.env.get("LICENCE_SIGNING_KEY") ?? "",
  keyId: Number(Deno.env.get("LICENCE_KEY_ID") ?? "1"),
}));
