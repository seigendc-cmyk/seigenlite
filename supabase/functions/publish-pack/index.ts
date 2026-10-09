// Supabase Edge Function: publish-pack (market publishing, 20261016120000).
// docs/marketing/market-publishing-design.md, A2 §3.
//
// POST { pack_id, days, items: [source_product_id, ...] }
// Authorization: Bearer <cl_login staff token>.
//
// The database decides who may publish: every RPC runs with the caller's
// OWN token (cl_market_publish_prepare / _attach refuse anyone without the
// Market Publishing module, or SysAdmin, and check the paid listing days).
// This function only copies the ticked photos into the public
// listing-images bucket, which needs the service-role key: Supabase gives
// it to the function as SUPABASE_SERVICE_ROLE_KEY. It never leaves this
// function: not in a response, not in a log.
import { makeHandler } from "./handler.mjs";

Deno.serve(makeHandler({
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
}));
