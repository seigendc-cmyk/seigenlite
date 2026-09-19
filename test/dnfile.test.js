// Run: node --no-warnings test/dnfile.test.js
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert"), nodeCrypto = require("crypto");
const src = (f)=>fs.readFileSync(path.join(__dirname,"..","src",f),"utf8");

const ctx = { crypto: nodeCrypto.webcrypto, TextEncoder };
vm.createContext(ctx);
vm.runInContext(src("docnum.js")+"\n"+src("dnfile.js")+`
this.api={ buildDN, validateDN, verifyChecksum, parseDN, serializeDN, sha256Hex, sha256HexPure, localIso,
           DN_FORMAT, DN_FORMAT_VERSION, dnFileName, DOC_FILE_EXT };`, ctx);
const api = ctx.api;
const clone = (x)=>JSON.parse(JSON.stringify(x));
const nodeSha = (s)=>nodeCrypto.createHash("sha256").update(s,"utf8").digest("hex");
const THUMB = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,3).join("\n       ")); }
}
const input = ()=>({ dnNo:12, fromBranchId:"B-ABCD1234", fromName:"Boka", toName:"Harare CBD", createdIso:"2026-09-04T08:00:00+02:00",
  items:[ {code:"SK1",name:"Rice 2kg",qty:3,thumb:THUMB}, {code:"SK2",name:"Sugar 1kg",qty:2}, {code:"",name:"Loose item",qty:1} ] });
const good = async()=>clone(await api.buildDN(input()));
const rejects = async(mutate, re)=>{
  const d = await good(); mutate(d);
  const r = await api.validateDN(d);
  assert.strictEqual(r.ok,false,"should be rejected");
  assert.ok(r.errors.some(m=>re.test(m)), "expected "+re+" in: "+r.errors.join(" | "));
};

(async()=>{
  await t("SHA-256: pure fallback matches Node for known and awkward inputs", async ()=>{
    for(const s of ["","abc","a".repeat(55),"a".repeat(56),"a".repeat(64),"a".repeat(1000),"Zürich – Café 日本 😀"])
      assert.strictEqual(api.sha256HexPure(s), nodeSha(s), JSON.stringify(s.slice(0,12)));
    assert.strictEqual(api.sha256HexPure("abc"),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  await t("SHA-256: default path (crypto.subtle) agrees with the pure one", async ()=>{
    assert.strictEqual(await api.sha256Hex("hello"), api.sha256HexPure("hello"));
  });
  await t("build then validate roundtrip (in memory and through file text)", async ()=>{
    const d = await api.buildDN(input());
    assert.strictEqual((await api.validateDN(d)).errors.length,0);
    const text = api.serializeDN(d);
    const p = await api.parseDN(text);
    assert.strictEqual(p.ok,true,p.errors.join("|"));
    assert.strictEqual(p.doc.dn_display,"DN0012");
    assert.strictEqual(p.doc.totals.lines,3); assert.strictEqual(p.doc.totals.units,6);
  });
  await t("fixed key order, default unit, thumb omitted when absent", async ()=>{
    const d = await api.buildDN(input());
    assert.strictEqual(Object.keys(d).join(),"format,format_version,dn_no,dn_display,from,to,created_iso,items,totals,checksum");
    assert.strictEqual(Object.keys(d.from).join(),"branch_id,name");
    assert.strictEqual(Object.keys(d.items[0]).join(),"code,name,unit,qty,thumb");
    assert.strictEqual(Object.keys(d.items[1]).join(),"code,name,unit,qty");
    assert.ok(d.items.every(i=>i.unit==="pcs"));
    assert.ok(!/cost|price/i.test(api.serializeDN(d)), "no cost or price in the file");
  });
  await t("deterministic: same inputs -> identical bytes, whichever hash implementation", async ()=>{
    const a = api.serializeDN(await api.buildDN(input()));
    const b = api.serializeDN(await api.buildDN(input()));
    const c = api.serializeDN(await api.buildDN(input(), async s=>api.sha256HexPure(s)));
    assert.strictEqual(a,b); assert.strictEqual(a,c);
    const parsed = JSON.parse(a); const re = {}; Object.keys(parsed).reverse().forEach(k=>re[k]=parsed[k]);
    assert.strictEqual(api.serializeDN(re),a, "key order of a re-serialised file does not matter");
  });
  await t("hash function is injectable", async ()=>{
    const d = await api.buildDN(input(), ()=>"f".repeat(64));
    assert.strictEqual(d.checksum,"f".repeat(64));
    assert.strictEqual(await api.verifyChecksum(d, ()=>"f".repeat(64)),true);
    assert.strictEqual(await api.verifyChecksum(d),false);
  });
  await t("tamper detection: any edited value fails the checksum", async ()=>{
    const edits = [d=>{d.items[0].qty=4; d.totals.units=7;}, d=>{d.items[1].name="Salt";}, d=>{d.to.name="Elsewhere";},
      d=>{d.from.branch_id="B-EVIL0000";}, d=>{d.created_iso="2026-09-05T08:00:00+02:00";}, d=>{d.items[0].thumb=THUMB.replace("UklG","UklH");},
      d=>{d.items[2].code="ZZ9";}, d=>{d.items.pop(); d.totals.lines=2; d.totals.units=5;}];
    for(const e of edits){
      const d = await good(); e(d);
      const r = await api.validateDN(d);
      assert.strictEqual(r.ok,false); assert.ok(r.errors.some(m=>/checksum/i.test(m)), r.errors.join("|"));
    }
  });
  await t("checksum missing or malformed", async ()=>{
    await rejects(d=>{ delete d.checksum; }, /checksum/i);
    await rejects(d=>{ d.checksum="nothex"; }, /checksum/i);
  });
  await t("rejects wrong type / non-objects", async ()=>{
    for(const bad of [null,"x",42,[],undefined]){ const r = await api.validateDN(bad); assert.strictEqual(r.ok,false); assert.ok(/not a Delivery Note/.test(r.errors[0])); }
    await rejects(d=>{ d.format="something-else"; }, /wrong file type/);
  });
  await t("rejects unknown format_version", async ()=>{
    await rejects(d=>{ d.format_version=3; }, /newer version of seiGEN Commerce Lite \(file version 3, this app reads up to 2\).*Nothing was changed/);
    await rejects(d=>{ d.format_version=2; }, /replaces/, "version 2 without a replaces field is invalid");
    await rejects(d=>{ delete d.format_version; }, /version undefined/);
  });
  await t("rejects missing fields", async ()=>{
    await rejects(d=>{ delete d.dn_no; }, /number is missing/);
    await rejects(d=>{ d.from={name:"Boka"}; }, /dispatching branch/);
    await rejects(d=>{ d.from.name=""; }, /dispatching branch/);
    await rejects(d=>{ d.to={}; }, /receiving branch/);
    await rejects(d=>{ delete d.created_iso; }, /date and time/);
    await rejects(d=>{ d.created_iso="04/09/2026"; }, /date and time/);
    await rejects(d=>{ delete d.items; }, /no items/);
    await rejects(d=>{ d.items=[]; }, /no items/);
    await rejects(d=>{ delete d.totals; }, /totals are missing/);
    await rejects(d=>{ delete d.items[0].name; }, /Item 1 has no name/);
    await rejects(d=>{ delete d.items[0].unit; }, /Item 1 has no unit/);
    await rejects(d=>{ delete d.items[0].code; }, /Item 1 has no code/);
  });
  await t("rejects non-positive / non-integer / absurd quantities", async ()=>{
    for(const q of [0,-2,1.5,"3",null,NaN,2e9]) await rejects(d=>{ d.items[0].qty=q; }, /quantity|unrealistic/);
  });
  await t("rejects duplicate codes (and duplicate code-less names)", async ()=>{
    await rejects(d=>{ d.items[1].code="sk1"; }, /more than once/);
    await rejects(d=>{ d.items.push({code:"",name:"loose ITEM",unit:"pcs",qty:1}); d.totals.lines=4; d.totals.units=7; }, /more than once/);
  });
  await t("rejects inconsistent totals, display number, stray fields and bad thumbs", async ()=>{
    await rejects(d=>{ d.totals.units=99; }, /totals do not match/);
    await rejects(d=>{ d.dn_display="DN0013"; }, /does not match its display/);
    await rejects(d=>{ d.extra=1; }, /Unexpected field "extra"/);
    await rejects(d=>{ d.items[0].price=5; }, /unexpected field "price"/);
    await rejects(d=>{ d.items[0].thumb="http://evil/x.png"; }, /invalid picture/);
    await rejects(d=>{ d.items[0].thumb="data:text/html;base64,AAAA"; }, /invalid picture/);
  });
  await t("buildDN refuses input that could never be valid", async ()=>{
    const bad = [i=>{i.dnNo=0;}, i=>{i.dnNo=1.5;}, i=>{i.items=[];}, i=>{i.items[0].qty=0;}, i=>{i.toName="";}, i=>{i.fromBranchId="";}, i=>{i.items[1].code="SK1";}];
    for(const m of bad){ const i = input(); m(i); await assert.rejects(()=>api.buildDN(i), /Cannot build Delivery Note/); }
  });
  await t("parseDN: garbage, truncated, BOM and empty input never throw", async ()=>{
    for(const s of ["","not json","{\"format\":","null","[]"]){ const r = await api.parseDN(s); assert.strictEqual(r.ok,false); assert.strictEqual(r.doc,null); }
    const text = api.serializeDN(await api.buildDN(input()));
    assert.strictEqual((await api.parseDN(text.slice(0,-10))).ok,false);
    assert.strictEqual((await api.parseDN("﻿"+text)).ok,true);
  });
  await t("unicode / awkward names survive the roundtrip", async ()=>{
    const i = input(); i.items[1].name = "Café \"Crème\" – 日本 😀 <b>&"; i.toName = "Zürich/Store #2";
    const p = await api.parseDN(api.serializeDN(await api.buildDN(i)));
    assert.strictEqual(p.ok,true,p.errors.join("|"));
    assert.strictEqual(p.doc.items[1].name,i.items[1].name);
  });
  await t("localIso: local time with offset", ()=>{
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(api.localIso(new Date())));
    assert.strictEqual(api.localIso(new Date(2026,8,4,8,5,9)).slice(0,19),"2026-09-04T08:05:09");
  });
  await t("file name + extension", ()=>{
    assert.strictEqual(api.DOC_FILE_EXT,".json");
    assert.strictEqual(api.dnFileName(12,"Boka",new Date(2026,8,4,8,0)),"DN0012-Boka-04Sep26-0800AM.json");
    assert.strictEqual(api.dnFileName(7,"St. Mary's #2",new Date(2026,8,4,0,5)),"DN0007-StMarys2-04Sep26-1205AM.json");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
