// Run: node tools/perf/pbkdf2-webcrypto-bench.js .
// Web Crypto PBKDF2-SHA-256 (150,000) in Chromium, file:// page, at 1x/4x/6x; same bytes as passcode-check.js?
const fs=require("fs"), path=require("path"), vm=require("vm");
const ROOT=path.resolve(process.argv[2]||".");
const { chromium } = require(path.join(ROOT,"node_modules/playwright"));
const pc=vm.createContext({TextEncoder,crypto:require("crypto").webcrypto}); vm.runInContext(fs.readFileSync(path.join(ROOT,"src/passcode-check.js"),"utf8")+";this.make=adminCheckMake;",pc);
const salt="00112233445566778899aabbccddeeff", want=pc.make("1234",salt).check;
const f=path.join(require("os").tmpdir(),"seigen-pbkdf2-wc.html"); fs.writeFileSync(f,"<!doctype html><p>wc</p>");
(async()=>{
  const b=await chromium.launch(); const p=await b.newPage(); await p.goto("file:///"+f.split(path.sep).join("/"));
  const cdp=await p.context().newCDPSession(p);
  console.log("file:// isSecureContext:", await p.evaluate(()=>isSecureContext), "| crypto.subtle:", await p.evaluate(()=>!!(crypto&&crypto.subtle)));
  for(const rate of [1,4,6]){
    await cdp.send("Emulation.setCPUThrottlingRate",{rate});
    const r=await p.evaluate(async (salt)=>{
      const hex=(s)=>new Uint8Array(s.match(/../g).map(x=>parseInt(x,16)));
      const t=performance.now();
      const key=await crypto.subtle.importKey("raw",new TextEncoder().encode("1234"),"PBKDF2",false,["deriveBits"]);
      const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:hex(salt),iterations:150000},key,256);
      return { ms: performance.now()-t, hex: Array.from(new Uint8Array(bits),x=>x.toString(16).padStart(2,"0")).join("") };
    }, salt);
    console.log(`${rate}x webcrypto 150000: ${r.ms.toFixed(0)} ms, same as passcode-check.js: ${r.hex===want}`);
  }
  await b.close();
})();
