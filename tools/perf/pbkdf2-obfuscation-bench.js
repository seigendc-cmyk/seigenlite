// Run: node tools/perf/pbkdf2-obfuscation-bench.js . [full]
// PBKDF2 in Chromium: plain vs build.js-obfuscated passcode-check.js, CPU throttling 1x/4x/6x
const fs=require("fs"), path=require("path");
const ROOT=path.resolve(process.argv[2]||".");
const { chromium } = require(path.join(ROOT,"node_modules/playwright"));
const JO=require(path.join(ROOT,"node_modules/javascript-obfuscator"));
const src=fs.readFileSync(path.join(ROOT,"src/passcode-check.js"),"utf8");
const opts=eval("("+/const OBFUSCATOR_OPTIONS = (\{[\s\S]*?\n\});/.exec(fs.readFileSync(path.join(ROOT,"build.js"),"utf8"))[1]+")");
const wrap=(name,code)=>"(function(){"+code+"\n;window."+name+"=adminCheckMatches;})();";
const html="<!doctype html><script>"+wrap("plain",src)+"</script><script>"+JO.obfuscate(wrap("obf",src),opts).getObfuscatedCode()+"</script>";
const f=path.join(require("os").tmpdir(),"seigen-pbkdf2-micro.html"); fs.writeFileSync(f,html);
const fileUrl=(p)=>"file:///"+p.split(path.sep).join("/");
(async()=>{
  const b=await chromium.launch(); const p=await b.newPage(); await p.goto(fileUrl(f));
  const cdp=await p.context().newCDPSession(p);
  const salt="00112233445566778899aabbccddeeff", chk="0".repeat(64);
  for(const rate of [1,4,6]){
    await cdp.send("Emulation.setCPUThrottlingRate",{rate});
    for(const [fn,rounds] of [["plain",150000],["obf",3000]]){
      const runs=[]; for(let i=0;i<3;i++) runs.push(await p.evaluate(([fn,s,c,n])=>{ const t=performance.now(); window[fn]("1234",s,c,n); return performance.now()-t; },[fn,salt,chk,rounds]));
      const ms=Math.min(...runs); console.log(`${rate}x ${fn.padEnd(5)} ${rounds} rounds: best ${ms.toFixed(0)} ms` + (rounds<150000? ` -> 150000 rounds = ${(ms*150000/rounds/1000).toFixed(0)} s (linear)` : ""));
    }
  }
  if(process.argv[3]==="full"){ await cdp.send("Emulation.setCPUThrottlingRate",{rate:1}); const ms=await p.evaluate(([s,c])=>{ const t=performance.now(); window.obf("1234",s,c,150000); return performance.now()-t; },[salt,chk]); console.log(`1x obf 150000 rounds (measured): ${(ms/1000).toFixed(1)} s`); }
  await b.close();
})();
