// node tools/cf/inspect.js <worker> [<worker>...]
// READ-ONLY look at Cloudflare Workers through the API (GET requests only):
// workers.dev subdomain + whether each script is on it, script settings
// (compatibility date/flags, bindings incl. static assets), Worker custom
// domains, and Worker routes on every zone the token can see.
// Credentials come from .env (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)
// and are redacted from all output.
"use strict";
const fs = require("fs"), path = require("path");
const env = {};
for(const line of fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8").split(/\r?\n/)){
  const m = /^\s*(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=\s*(.*)\s*$/.exec(line);
  if(m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const TOKEN = env.CLOUDFLARE_API_TOKEN, ACC = env.CLOUDFLARE_ACCOUNT_ID;
if(!TOKEN || !ACC){ console.error("Missing CLOUDFLARE_* in .env"); process.exit(2); }
const redact = (s)=> String(s).split(TOKEN).join("[REDACTED]").split(ACC).join("[ACCOUNT]");
async function get(p){
  const r = await fetch("https://api.cloudflare.com/client/v4" + p.replace("{acc}", ACC), { headers: { Authorization: "Bearer " + TOKEN } });
  const j = await r.json().catch(()=>({}));
  return { status: r.status, success: j.success, errors: (j.errors||[]).map(e=>e.code+": "+e.message), result: j.result };
}
(async()=>{
  const names = process.argv.slice(2);
  const out = {};
  const sub = await get("/accounts/{acc}/workers/subdomain");
  out.workersDevSubdomain = sub.success? sub.result.subdomain : sub;
  const scripts = await get("/accounts/{acc}/workers/scripts");
  out.scriptsOnAccount = scripts.success? scripts.result.map(s=>({ id: s.id, modified_on: s.modified_on, has_assets: s.has_assets, has_modules: s.has_modules, compatibility_date: s.compatibility_date })) : scripts;
  for(const n of names){
    const o = out[n] = {};
    const s = await get("/accounts/{acc}/workers/scripts/" + n + "/subdomain"); o.workersDev = s.success? s.result : s;
    const st = await get("/accounts/{acc}/workers/scripts/" + n + "/settings"); o.settings = st.success? st.result : st;
  }
  const doms = await get("/accounts/{acc}/workers/domains");
  out.customDomains = doms.success? doms.result.map(d=>({ hostname: d.hostname, service: d.service, environment: d.environment, zone_name: d.zone_name })) : doms;
  const zones = await get("/zones?per_page=50");
  out.zones = zones.success? zones.result.map(z=>({ name: z.name, status: z.status })) : zones;
  out.routes = [];
  if(zones.success) for(const z of zones.result){
    const r = await get("/zones/" + z.id + "/workers/routes");
    out.routes.push({ zone: z.name, routes: r.success? r.result.map(x=>({ pattern: x.pattern, script: x.script })) : r });
  }
  console.log(redact(JSON.stringify(out, null, 1)));
})().catch(e=>{ console.error(redact(e && e.stack || e)); process.exit(1); });
