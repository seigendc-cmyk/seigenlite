// node tools/licence/issue.js --device ABCD-K7Q2 [--days 30|90|365] [--app phone|desktop] [--preview] [--note "..."]
// node tools/licence/issue.js --business <business uuid> [--days ...]      one licence per active till
// node tools/licence/issue.js --list [--device ABCD | --business <uuid>]    licences already issued
// node tools/licence/issue.js --repeat-installs                             installs sharing a shop phrase (Q8)
// node tools/licence/issue.js --revoke <serial> --reason "..."              stops its short code / check-in delivery
//
// Issues activation v2 licences (docs/activation/activation-v2-design.md)
// as a signed-in seiGEN staff member. This tool holds NO key: it signs in
// with cl_login (staff name + passcode), then calls the issue-licence Edge
// Function with that staff token; the function signs with the key it holds
// as a secret. The database refuses anyone without the "Activation Codes"
// permission, and logs who issued what.
//
// Credentials: SEIGEN_STAFF_NAME / SEIGEN_STAFF_PASSCODE from .env (or the
// environment), otherwise asked for at a prompt (the passcode isn't echoed).
// The passcode and the staff token are never printed or written anywhere.
// SUPABASE_URL and SUPABASE_ANON_KEY come from .env too.
// Output: per licence, the WhatsApp message to send (link + long code +
// short code). The short code is shown only at issue time (the server keeps
// only its hash).
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..', '..');
const APPS = {
  phone: { live: 'https://mobilepos.seigendc.workers.dev/', preview: 'https://mobilepos-preview.seigendc.workers.dev/' },
  desktop: { live: 'https://desktoppos.seigendc.workers.dev/', preview: 'https://desktoppos-preview.seigendc.workers.dev/' },
};

function arg(name) { const i = process.argv.indexOf(name); return i === -1 ? null : (process.argv[i + 1] || ''); }
const flag = (name) => process.argv.includes(name);

// .env values for the keys we use; the environment wins.
function config() {
  const keys = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SEIGEN_STAFF_NAME', 'SEIGEN_STAFF_PASSCODE', 'LICENCE_FUNCTION_URL'];
  const out = {};
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && keys.includes(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const k of keys) if (process.env[k]) out[k] = process.env[k];
  return out;
}

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
    if (hidden) rl._writeToOutput = () => {};   // after the prompt is shown: typed characters aren't echoed
  });
}

async function postJson(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { data = null; }
  return { ok: r.ok, status: r.status, data, text };
}
const errText = (r) => String((r.data && (r.data.error || r.data.message)) || r.text || ('HTTP ' + r.status)).slice(0, 300);

function untilText(isoDate) {
  return new Date(isoDate + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function whatsappMessage(l, appKind, preview) {
  const base = APPS[appKind][preview ? 'preview' : 'live'];
  const who = [l.business_name, l.branch, l.till_code].filter(Boolean).join(' · ');
  return [
    'seiGEN licence for device ' + l.device_code + (who ? ' (' + who + ')' : '') + ', ' + appKind + ' app.',
    'Valid until ' + untilText(l.valid_to) + ' (licence #' + l.serial + ').',
    '',
    '1) Tap this link on that device (works offline):',
    base + '#lic=' + l.licence,
    '',
    '2) Or copy this long code into the activation screen (works offline):',
    l.licence,
    '',
    '3) Or type this short code there (the device must be online):',
    l.short_code,
  ].join('\n');
}

(async function main() {
  const device = arg('--device'), business = arg('--business');
  const list = flag('--list'), repeat = flag('--repeat-installs'), revoke = arg('--revoke');
  const appKind = (arg('--app') || 'phone').toLowerCase();
  const days = arg('--days') ? Number(arg('--days')) : 30;
  if (!list && !repeat && !revoke && !device && !business) {
    console.error('Give --device ABCD-K7Q2 or --business <uuid> (or --list / --repeat-installs / --revoke). See the top of this file.');
    return void (process.exitCode = 2);
  }
  if (!APPS[appKind]) { console.error('--app must be phone or desktop'); return void (process.exitCode = 2); }
  if (![30, 90, 365].includes(days)) { console.error('--days must be 30, 90 or 365'); return void (process.exitCode = 2); }

  const cfg = config();
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) { console.error('SUPABASE_URL and SUPABASE_ANON_KEY are needed in .env'); return void (process.exitCode = 2); }
  const name = cfg.SEIGEN_STAFF_NAME || await ask('Staff name: ');
  const passcode = cfg.SEIGEN_STAFF_PASSCODE || await ask('Passcode: ', true);

  // 1. Sign in as staff (the same cl_login the Console uses).
  const login = await postJson(cfg.SUPABASE_URL + '/rest/v1/rpc/cl_login', { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + cfg.SUPABASE_ANON_KEY },
    { p_name: name, p_passcode: passcode });
  if (!login.ok || !login.data || !login.data.token) { console.error('Sign-in failed: ' + errText(login)); return void (process.exitCode = 1); }
  if (login.data.user_type !== 'staff') { console.error('Sign-in failed: this account is not a seiGEN staff account.'); return void (process.exitCode = 1); }
  const token = login.data.token;
  console.log('Signed in as ' + login.data.full_name + '.');
  const staffRpc = (fn, body) => postJson(cfg.SUPABASE_URL + '/rest/v1/rpc/' + fn, { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }, body);

  if (list) {
    const r = await staffRpc('cl_licence_list', { p_install_id: device ? device.split('-')[0] : null, p_business_id: business || null, p_limit: 50 });
    if (!r.ok) { console.error('Refused: ' + errText(r)); return void (process.exitCode = 1); }
    for (const l of r.data) {
      console.log(['#' + l.serial, l.install_id + '-' + l.device_tag, l.status, l.days + ' days', 'until ' + l.valid_to,
        'by ' + (l.issued_by || '?'), l.business_name || '', l.till_code || ''].filter(Boolean).join('  '));
    }
    if (!r.data.length) console.log('No licences.');
    return;
  }
  if (repeat) {
    const r = await staffRpc('cl_vendor_repeat_installs', { p_days: 90 });
    if (!r.ok) { console.error('Refused: ' + errText(r)); return void (process.exitCode = 1); }
    for (const g of r.data) console.log('phrase group ' + g.phrase_group + ': ' + g.installs + ' installs (' + g.recent_installs + ' in 90 days): ' + g.install_ids.join(', '));
    if (!r.data.length) console.log('No shop phrase is shared by more than one install.');
    return;
  }
  if (revoke) {
    const reason = arg('--reason');
    if (!reason) { console.error('--reason "..." is required'); return void (process.exitCode = 2); }
    const r = await staffRpc('cl_licence_revoke', { p_serial: Number(revoke), p_reason: reason });
    if (!r.ok) { console.error('Refused: ' + errText(r)); return void (process.exitCode = 1); }
    console.log('Licence #' + r.data.serial + ' revoked. Its short code and check-in delivery stop working; a device that already holds it keeps it until it expires.');
    return;
  }

  // 2. Issue through the Edge Function (it holds the signing key; this tool doesn't).
  const fnUrl = cfg.LICENCE_FUNCTION_URL || (cfg.SUPABASE_URL + '/functions/v1/issue-licence');
  const r = await postJson(fnUrl, { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
    { device_code: device || null, business_id: business || null, days, note: arg('--note') || null });
  if (!r.ok) { console.error('Refused (' + r.status + '): ' + errText(r)); return void (process.exitCode = 1); }
  console.log('Key ID ' + r.data.key_id + '. ' + r.data.licences.length + ' licence(s) issued.\n');
  for (const l of r.data.licences) {
    console.log('----- WhatsApp message for ' + l.device_code + ' -----');
    console.log(whatsappMessage(l, appKind, flag('--preview')));
    console.log('');
  }
  for (const s of r.data.skipped || []) {
    console.log('Skipped ' + [s.branch, s.till_code, s.install_id].filter(Boolean).join(' / ') + ': ' +
      (s.reason === 'NO_DEVICE_KEY' ? 'the server has no device key for it yet (it must check in once)' : s.reason));
  }
})().catch((e) => { console.error('Failed: ' + (e && e.message ? e.message : e)); process.exitCode = 1; });
