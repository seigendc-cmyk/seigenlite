// node tools/licence/keygen.js [--kid <1-255>]
//
// Makes a new Ed25519 licence-signing key pair (activation v2,
// docs/activation/activation-v2-design.md).
//   * The PRIVATE key is written ONLY to C:\seigen-keys\licence-signing-key-<kid>.json
//     (outside the repo). The folder is restricted to the current Windows user
//     (icacls, inheritance removed), like C:\seigen-backups. An existing key
//     file is never overwritten.
//   * Only the key ID and the PUBLIC key are printed; the public key goes into
//     LICENCE_PUBLIC_KEYS in src/activation.js.
// The private key is never printed, logged or committed. Back the file up
// offline (see docs/activation/licence-keys.md).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const KEY_DIR = process.env.SEIGEN_KEY_DIR || 'C:\\seigen-keys';
const ROOT = path.resolve(__dirname, '..', '..');

function arg(name) { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; }

function restrictFolder(dir) {
  if (process.platform !== 'win32') { fs.chmodSync(dir, 0o700); return 'chmod 700'; }
  const user = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
  execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', user + ':(OI)(CI)F', '/T'], { stdio: 'ignore' });
  return execFileSync('icacls', [dir], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
}

(function main() {
  if (path.resolve(KEY_DIR).toLowerCase().startsWith(ROOT.toLowerCase())) throw new Error('the key folder must be outside the repo');
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const acl = restrictFolder(KEY_DIR);

  const existing = fs.readdirSync(KEY_DIR).map((f) => /^licence-signing-key-(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
  const kid = arg('--kid') ? Number(arg('--kid')) : (existing.length ? Math.max(...existing) + 1 : 1);
  if (!Number.isInteger(kid) || kid < 1 || kid > 255) throw new Error('--kid must be 1..255');
  const file = path.join(KEY_DIR, 'licence-signing-key-' + kid + '.json');
  if (fs.existsSync(file)) throw new Error('key ' + kid + ' already exists; refusing to overwrite it');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);   // raw 32-byte key at the end of the SPKI
  const record = {
    kid, alg: 'Ed25519', created_at: new Date().toISOString(),
    public_key_b64: pub.toString('base64'),
    private_pkcs8_b64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    note: 'seiGEN Commerce Lite licence signing key. SECRET: never share, upload or commit. Backup: docs/activation/licence-keys.md',
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 1), { flag: 'wx' });

  // sanity: the saved key signs and the printed public key verifies
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const priv = crypto.createPrivateKey({ key: Buffer.from(saved.private_pkcs8_b64, 'base64'), format: 'der', type: 'pkcs8' });
  const msg = crypto.randomBytes(32);
  const sig = crypto.sign(null, msg, priv);
  const pubObj = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
  if (!crypto.verify(null, msg, pubObj, sig)) throw new Error('self-check failed');

  console.log('Key ID:      ' + kid);
  console.log('Public key:  ' + pub.toString('base64'));
  console.log('Private key: written to ' + file + ' (not shown)');
  console.log('Folder ACL:  ' + acl);
  console.log('\nAdd to LICENCE_PUBLIC_KEYS in src/activation.js:\n  ' + kid + ': "' + pub.toString('base64') + '",');
})();
