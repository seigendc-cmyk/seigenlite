  // ---------------- Admin passcode check values (Admin passcode from the main branch) ----------------
  // A joined device's Admin passcode is set on a main-branch till; only a
  // check value travels through seiGEN, never the passcode:
  //   PBKDF2-HMAC-SHA-256(passcode, 16-byte salt, 150,000 rounds) -> 32 bytes (hex).
  // Pure JavaScript and synchronous, so every Admin check in the app
  // (findAdmin, staff.js) stays as it is, and it works the same in the phone
  // app, the desktop app and the file app (no WebCrypto needed). It takes
  // about a second on a phone: it runs only when an Admin passcode is typed.
  // Design: docs/multi-terminal/admin-passcode-on-join-design.md
  const ADMIN_CHECK_ROUNDS = 150000;
  const ADMIN_SEED_PASSCODE_MIN = 6;                  // owner 2026-10-13: 6 characters for passcodes set this way

  const PC_K = new Int32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
    0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const PC_IV = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  // One SHA-256 compression of the 16 words w[0..15] (w has room for 64) into h (8 words).
  function pcCompress(h, w){
    for(let i=16;i<64;i++){
      const a = w[i-15], b = w[i-2];
      const s0 = ((a>>>7)|(a<<25)) ^ ((a>>>18)|(a<<14)) ^ (a>>>3);
      const s1 = ((b>>>17)|(b<<15)) ^ ((b>>>19)|(b<<13)) ^ (b>>>10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1)|0;
    }
    let A=h[0],B=h[1],C=h[2],D=h[3],E=h[4],F=h[5],G=h[6],H=h[7];
    for(let i=0;i<64;i++){
      const S1 = ((E>>>6)|(E<<26)) ^ ((E>>>11)|(E<<21)) ^ ((E>>>25)|(E<<7));
      const t1 = (H + S1 + ((E&F)^(~E&G)) + PC_K[i] + w[i])|0;
      const S0 = ((A>>>2)|(A<<30)) ^ ((A>>>13)|(A<<19)) ^ ((A>>>22)|(A<<10));
      const t2 = (S0 + ((A&B)^(A&C)^(B&C)))|0;
      H=G; G=F; F=E; E=(D+t1)|0; D=C; C=B; B=A; A=(t1+t2)|0;
    }
    h[0]=(h[0]+A)|0; h[1]=(h[1]+B)|0; h[2]=(h[2]+C)|0; h[3]=(h[3]+D)|0; h[4]=(h[4]+E)|0; h[5]=(h[5]+F)|0; h[6]=(h[6]+G)|0; h[7]=(h[7]+H)|0;
  }
  // SHA-256 of bytes -> Int32Array(8)
  function pcSha256(bytes){
    const n = bytes.length, total = ((n + 9 + 63) >> 6) << 6, buf = new Uint8Array(total);
    buf.set(bytes); buf[n] = 0x80;
    const bits = n * 8;
    buf[total-4] = (bits>>>24)&255; buf[total-3] = (bits>>>16)&255; buf[total-2] = (bits>>>8)&255; buf[total-1] = bits&255;
    buf[total-5] = Math.floor(bits / 4294967296)&255;
    const h = Int32Array.from(PC_IV), w = new Int32Array(64);
    for(let o=0;o<total;o+=64){
      for(let i=0;i<16;i++) w[i] = (buf[o+4*i]<<24)|(buf[o+4*i+1]<<16)|(buf[o+4*i+2]<<8)|buf[o+4*i+3];
      pcCompress(h, w);
    }
    return h;
  }
  const pcUtf8 = (s)=> new TextEncoder().encode(String(s));
  function pcHexToBytes(hex){ const b = new Uint8Array(hex.length/2); for(let i=0;i<b.length;i++) b[i] = parseInt(hex.substr(2*i,2),16); return b; }
  function pcWordsToHex(h){ let s = ""; for(let i=0;i<h.length;i++) s += (h[i]>>>0).toString(16).padStart(8,"0"); return s; }
  // PBKDF2-HMAC-SHA-256, one 32-byte block (dkLen 32), synchronous.
  function pbkdf2Sha256Hex(passwordBytes, saltBytes, rounds){
    let key = passwordBytes;
    if(key.length > 64){ const k = pcSha256(key), kb = new Uint8Array(32); for(let i=0;i<8;i++){ kb[4*i]=k[i]>>>24; kb[4*i+1]=(k[i]>>>16)&255; kb[4*i+2]=(k[i]>>>8)&255; kb[4*i+3]=k[i]&255; } key = kb; }
    const ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for(let i=0;i<64;i++){ const k = i<key.length? key[i] : 0; ipad[i] = k^0x36; opad[i] = k^0x5c; }
    // the inner and outer states after their pad block, computed once
    const w = new Int32Array(64);
    const padState = (pad)=>{ const h = Int32Array.from(PC_IV); for(let i=0;i<16;i++) w[i] = (pad[4*i]<<24)|(pad[4*i+1]<<16)|(pad[4*i+2]<<8)|pad[4*i+3]; pcCompress(h, w); return h; };
    const inner = padState(ipad), outer = padState(opad);
    // U1 = HMAC(salt || INT(1))
    const first = new Uint8Array(64 + saltBytes.length + 4);
    first.set(ipad); first.set(saltBytes, 64); first[first.length-1] = 1;
    const ih = pcSha256(first);                                     // inner hash over ipad||salt||1
    const hmacOuter = (innerWords)=>{                                // outer hash over opad||inner (one block from the outer state)
      const h = Int32Array.from(outer);
      for(let i=0;i<8;i++) w[i] = innerWords[i];
      w[8] = 0x80000000; for(let i=9;i<15;i++) w[i] = 0; w[15] = (64+32)*8;
      pcCompress(h, w); return h;
    };
    let u = hmacOuter(ih);
    const t = Int32Array.from(u);
    for(let r=1;r<rounds;r++){
      const h = Int32Array.from(inner);                              // inner hash over ipad||u (one block from the inner state)
      for(let i=0;i<8;i++) w[i] = u[i];
      w[8] = 0x80000000; for(let i=9;i<15;i++) w[i] = 0; w[15] = (64+32)*8;
      pcCompress(h, w);
      u = hmacOuter(h);
      for(let i=0;i<8;i++) t[i] ^= u[i];
    }
    return pcWordsToHex(t);
  }
  function pcRandomHex(n){
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return Array.from(b, x=>x.toString(16).padStart(2,"0")).join("");
  }
  // "" = fine, otherwise the plain reason (passcodes set for another device).
  function adminSeedPasscodeProblem(passcode, confirmText){
    const p = String(passcode==null?"":passcode).trim();
    if(p.length < ADMIN_SEED_PASSCODE_MIN) return "The Admin passcode must be at least "+ADMIN_SEED_PASSCODE_MIN+" characters.";
    if(p !== String(confirmText==null?"":confirmText).trim()) return "The two passcodes don't match.";
    return "";
  }
  // The check value for a passcode: { salt, check, rounds } (what seiGEN stores).
  function adminCheckMake(passcode, saltHex){
    const salt = saltHex || pcRandomHex(16);
    return { salt, check: pbkdf2Sha256Hex(pcUtf8(String(passcode).trim()), pcHexToBytes(salt), ADMIN_CHECK_ROUNDS), rounds: ADMIN_CHECK_ROUNDS };
  }
  // Does this passcode match a stored check value? (rounds as stored, so a later change of the default still reads old ones)
  function adminCheckMatches(passcode, salt, check, rounds){
    const p = String(passcode==null?"":passcode).trim();
    if(!p || !/^[0-9a-f]{32}$/.test(String(salt||"")) || !/^[0-9a-f]{64}$/.test(String(check||""))) return false;
    const n = Number(rounds)||ADMIN_CHECK_ROUNDS;
    if(n < 1000 || n > 2000000) return false;
    return pbkdf2Sha256Hex(pcUtf8(p), pcHexToBytes(salt), n) === check;
  }
