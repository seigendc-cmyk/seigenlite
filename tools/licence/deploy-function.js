// node tools/licence/deploy-function.js [--kid 1] [--secrets-only | --deploy-only]
//
// Deploys the issue-licence Edge Function (supabase/functions/issue-licence)
// and sets its secrets LICENCE_SIGNING_KEY + LICENCE_KEY_ID, with the
// Supabase CLI (`npx supabase functions deploy`, `npx supabase secrets set`).
//   * SUPABASE_PAT (a personal access token, sbp_...) is read from .env and
//     handed to the CLI's environment only (as SUPABASE_ACCESS_TOKEN).
//   * The private key is read from C:\seigen-keys\licence-signing-key-<kid>.json
//     and passed through a temporary env file INSIDE C:\seigen-keys (the
//     folder only the owner's user can read), deleted straight after.
//   * Neither value is ever printed: everything the CLI prints is redacted.
// The gateway's JWT check stays ON (the default): the caller must send a
// valid JWT, and the function + database then require a staff token with
// the Activation Codes permission.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const KEY_DIR = process.env.SEIGEN_KEY_DIR || 'C:\\seigen-keys';
const PROJECT_REF = 'urbopdsubwawtybwrxjd';
const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };

function dotenv(key) {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '');
  }
  return '';
}

function run(args, secrets, env) {
  const redact = (s) => secrets.filter((v) => v && v.length >= 6).reduce((acc, v) => acc.split(v).join('[REDACTED]'), s);
  const q = (a) => /^[A-Za-z0-9_\-.\/:=@\\]+$/.test(a) ? a : '"' + String(a).replace(/"/g, '\\"') + '"';
  // SUPABASE_CLI=<path to supabase(.exe)> uses that binary directly (e.g. when
  // npx can't fetch the platform package); otherwise npx supabase.
  const direct = process.env.SUPABASE_CLI;
  return new Promise((resolve) => {
    const child = direct
      ? spawn(direct, args, { cwd: ROOT, env: Object.assign({}, process.env, env, { SUPABASE_TELEMETRY_DISABLED: '1' }) })
      : spawn('npx', ['--yes', 'supabase@latest', ...args].map(q), { cwd: ROOT, shell: true,
      env: Object.assign({}, process.env, env, { SUPABASE_TELEMETRY_DISABLED: '1' }) });
    child.stdout.on('data', (d) => process.stdout.write(redact(d.toString())));
    child.stderr.on('data', (d) => process.stderr.write(redact(d.toString())));
    child.on('close', resolve);
  });
}

(async function main() {
  const pat = dotenv('SUPABASE_PAT');
  if (!/^sbp_/.test(pat)) {
    console.error('SUPABASE_PAT (starting sbp_) is not in .env yet. Create one at https://supabase.com/dashboard/account/tokens and add it as SUPABASE_PAT=...');
    process.exitCode = 2; return;
  }
  const kid = Number(arg('--kid') || 1);
  const env = { SUPABASE_ACCESS_TOKEN: pat };

  if (!process.argv.includes('--secrets-only')) {
    console.log('Deploying issue-licence to project ' + PROJECT_REF + ' ...');
    const code = await run(['functions', 'deploy', 'issue-licence', '--project-ref', PROJECT_REF, '--use-api'], [pat], env);
    if (code !== 0) { console.error('Deploy failed (exit ' + code + ').'); process.exitCode = 1; return; }
  }
  if (!process.argv.includes('--deploy-only')) {
    const keyFile = path.join(KEY_DIR, 'licence-signing-key-' + kid + '.json');
    const rec = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    const tmp = path.join(KEY_DIR, '.secrets-' + crypto.randomBytes(6).toString('hex') + '.env');
    fs.writeFileSync(tmp, 'LICENCE_SIGNING_KEY=' + rec.private_pkcs8_b64 + '\nLICENCE_KEY_ID=' + kid + '\n', { mode: 0o600, flag: 'wx' });
    try {
      console.log('Setting the function secrets LICENCE_SIGNING_KEY (key ' + kid + ', not shown) and LICENCE_KEY_ID ...');
      const code = await run(['secrets', 'set', '--env-file', tmp, '--project-ref', PROJECT_REF], [pat, rec.private_pkcs8_b64], env);
      if (code !== 0) { console.error('Setting the secrets failed (exit ' + code + ').'); process.exitCode = 1; }
    } finally { fs.rmSync(tmp, { force: true }); }
  }
})().catch((e) => { console.error('Failed: ' + (e && e.message ? e.message : e)); process.exitCode = 1; });
