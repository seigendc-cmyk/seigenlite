// node tools/cf/wrangler.js <wrangler args...>
// Runs `npx wrangler` with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
// loaded from .env into the CHILD's environment only. Nothing else from
// .env is passed. Both values are redacted from everything wrangler prints,
// so they can't reach a terminal, log or report.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const KEYS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
const env = {};
for(const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)){
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if(m && KEYS.includes(m[1])) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const missing = KEYS.filter(k => !env[k]);
if(missing.length){ console.error("Missing in .env: " + missing.join(", ")); process.exit(2); }
const secrets = KEYS.map(k => env[k]).filter(v => v.length >= 6);
const redact = (s) => secrets.reduce((acc, v) => acc.split(v).join("[REDACTED]"), s);

// npx needs a shell on Windows, so quote every argument for it (a --message
// with spaces must stay one argument).
const q = (a) => /^[A-Za-z0-9_\-.\/:=@]+$/.test(a) ? a : '"' + String(a).replace(/"/g, '\\"') + '"';
const child = spawn("npx", ["--yes", "wrangler", ...process.argv.slice(2)].map(q), {
  cwd: process.cwd(), shell: true,
  env: Object.assign({}, process.env, env, { WRANGLER_SEND_METRICS: "false", CI: "true" }),
});
child.stdout.on("data", d => process.stdout.write(redact(d.toString())));
child.stderr.on("data", d => process.stderr.write(redact(d.toString())));
child.on("close", code => process.exit(code));
