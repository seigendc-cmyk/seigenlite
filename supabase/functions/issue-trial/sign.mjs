// Ed25519 signing for activation v2 licences, with WebCrypto only (no
// dependencies), so the same file runs in the Edge Function (Deno) and in
// the Node tests (supabase/tests/activation-licences-test.js).
// The private key arrives as PKCS#8 DER, base64 (the LICENCE_SIGNING_KEY
// function secret, made by tools/licence/keygen.js). It is never logged.

export function hexToBytes(hex) {
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export function bytesToHex(b) {
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
}
function b64ToBytes(b64) {
  const s = atob(String(b64).trim());
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function b64urlToB64(s) { return s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4); }

// -> { key (CryptoKey, sign only), publicKeyB64 (raw 32 bytes, base64) }
export async function importSigningKey(pkcs8B64) {
  const der = b64ToBytes(pkcs8B64);
  const jwkKey = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', jwkKey);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  return { key, publicKeyB64: btoa(String.fromCharCode(...b64ToBytes(b64urlToB64(jwk.x)))) };
}

// payload (hex, built by cl_licence_prepare) -> signature (hex, 64 bytes)
export async function signPayloadHex(key, payloadHex) {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, hexToBytes(payloadHex));
  return bytesToHex(sig);
}
