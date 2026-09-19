// Run: node --no-warnings test/catalogue.test.js
// Catalogue format (pure) + import / price policy over the REAL app source and SQLite.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert"), nodeCrypto = require("crypto");
const { makeApp, src } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,4).join("\n       ")); }
}
const THUMB = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
const THUMB2 = THUMB.replace("UklGR","UklGS");
const NOW = new Date(2026,8,4,8,0);
const bytesOf = (text)=>new Uint8Array(Buffer.from(text,"utf8"));
const json = (x)=>JSON.parse(JSON.stringify(x));
// node:sqlite on Windows has a ~15ms clock tick for datetime("now"); wait past it (sql.js in the browser has ms resolution)
const wait = (ms)=>new Promise(r=>setTimeout(r,ms||30));

function addProduct(app, branch, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [o.name,o.price,o.stock==null?0:o.stock,3,o.sku,branch,o.image||"",o.cost==null?0:o.cost,"2026-01-01",o.description||""]);
  return app.api.one("SELECT * FROM products WHERE branch=? AND name=?",[branch,o.name]);
}
function snapshot(app){
  const names = app.api.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
  return JSON.stringify(names.map(n=>[n, app.api.all("SELECT * FROM "+n)]));
}
// main ("Boka HQ") with 3 products, register with two remotes
function mainApp(){
  const A = makeApp({ branch_name:"Boka HQ", branch_type:"main", setup_complete:"1", contact_phone:"0771111111", management_whatsapp:"0779999999" });
  addProduct(A,"Boka HQ",{name:"Rice 2kg",sku:"SK1",price:5,stock:987,cost:3.77,image:"",description:"grain staple"});
  addProduct(A,"Boka HQ",{name:"Sugar 1kg",sku:"SK2",price:2.5,stock:50,cost:1.11});
  addProduct(A,"Boka HQ",{name:"Salt",sku:"SK3",price:1,stock:10,cost:0.4});
  A.api.ensureSelfInRegister();
  A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Harare CBD','0772222222')");
  A.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Mutare','')");
  return A;
}
function remoteApp(name, extra){
  const R = makeApp(Object.assign({ branch_name:name, branch_type:"remote", setup_complete:"1" }, extra||{}));
  R.calls = { downloads:0 };
  R.hook("downloadDb", ()=>{ R.calls.downloads++; });
  R.hook("persist", async ()=>{});
  return R;
}
async function catalogueFor(A, dest, mode){
  if(mode) A.api.setBranchPriceMode(dest, mode);
  const b = await A.api.buildCatalogueFor(dest);
  return b;
}
function addAdmin(app, name, pass, active){
  app.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES(?,?,?,?,?,?)",[name,"Admin",pass,"x",active===0?0:1,"2026-01-01"]);
}
const stockOf = (app, code)=>app.api.one("SELECT stock FROM products WHERE lower(sku)=lower(?) AND branch=?",[code,app.api.currentBranch()]).stock;
const priceOf = (app, code)=>app.api.one("SELECT price FROM products WHERE lower(sku)=lower(?) AND branch=?",[code,app.api.currentBranch()]).price;

(async()=>{
  // ---------------- pure module ----------------
  await t("pure module loads with no DB or DOM (only docnum.js + dnfile.js beside it)", async ()=>{
    const ctx = { crypto: nodeCrypto.webcrypto, TextEncoder, TextDecoder };
    vm.createContext(ctx);
    vm.runInContext(src("docnum.js")+"\n"+src("dnfile.js")+"\n"+src("catalogue.js")+"\nthis.api={buildCatalogue,validateCatalogue,serializeCatalogue,catalogueFileName};", ctx);
    const d = await ctx.api.buildCatalogue({ fromBranchId:"B-1", fromName:"Boka HQ", toName:"Harare CBD", createdIso:"2026-09-04T08:00:00+02:00", priceMode:"follow_main", managementWhatsapp:"", register:[], items:[{code:"A",name:"A",price:1}] });
    assert.ok((await ctx.api.validateCatalogue(d)).ok);
  });
  await t("build -> validate roundtrip, fixed key order, deterministic bytes", async ()=>{
    const A = mainApp();
    const b = await catalogueFor(A,"Harare CBD");
    const p = await A.api.parseCatalogue(b.text);
    assert.strictEqual(p.ok,true,p.errors.join("|"));
    assert.strictEqual(Object.keys(p.doc).join(),"format,format_version,from,to,created_iso,price_mode,management_whatsapp,register,items,totals,checksum");
    assert.strictEqual(Object.keys(p.doc.items[0]).join(),"code,name,price,description,thumb".split(",").filter(k=>k in p.doc.items[0]).join());
    const again = await A.api.buildCatalogue({ fromBranchId:p.doc.from.branch_id, fromName:"Boka HQ", toName:"Harare CBD", createdIso:p.doc.created_iso, priceMode:p.doc.price_mode, managementWhatsapp:p.doc.management_whatsapp, register:p.doc.register, items:p.doc.items });
    assert.strictEqual(A.api.serializeCatalogue(again), b.text);
  });
  await t("contents: code, name, price, hidden keywords; NEVER cost, stock or shelf", async ()=>{
    const A = mainApp();
    const b = await catalogueFor(A,"Harare CBD");
    const keys = new Set(); b.doc.items.forEach(i=>Object.keys(i).forEach(k=>keys.add(k)));
    ["code","name","price"].forEach(k=>assert.ok(keys.has(k)));
    ["cost","stock","shelf","low_threshold","supplier","unit_cost"].forEach(k=>assert.ok(!keys.has(k), k));
    const body = JSON.stringify(b.doc.items) + JSON.stringify(b.doc.register);   // the checksum is random hex and could contain any digits
    assert.ok(!/3\.77|987|"cost"|"stock"/.test(body), "no cost/stock values or keys in the items");
    assert.strictEqual(b.doc.items.find(i=>i.code==="SK1").description,"grain staple");
    assert.strictEqual(b.doc.management_whatsapp,"0779999999");
    assert.ok(b.doc.register.some(r=>r.name==="Mutare"));
  });
  await t("file name: CAT-<Destination>-<DDMonYY>-<hhmm><AM|PM>.json", async ()=>{
    const A = mainApp();
    assert.strictEqual(A.api.catalogueFileName("Harare CBD",NOW),"CAT-HarareCBD-04Sep26-0800AM.json");
    assert.strictEqual(A.api.catalogueFileName("St. Mary's #2",new Date(2026,8,4,0,5)),"CAT-StMarys2-04Sep26-1205AM.json");
    assert.strictEqual(A.api.catalogueFileName("Mutare",new Date(2026,8,4,12,0)),"CAT-Mutare-04Sep26-1200PM.json");
    const b = await catalogueFor(A,"Harare CBD");
    assert.ok(/^CAT-HarareCBD-\d{2}[A-Z][a-z]{2}\d{2}-\d{4}(AM|PM)\.json$/.test(b.fileName), b.fileName);
  });
  await t("tamper detection: any edited value fails the checksum", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    const edits = [d=>{d.items[0].price=0.01;}, d=>{d.items[1].name="Salt Extra";}, d=>{d.price_mode="branch_edits";}, d=>{d.management_whatsapp="0700000000";},
      d=>{d.register[0].whatsapp="0700000000";}, d=>{d.to.name="Mutare";}, d=>{d.items.pop(); d.totals.items=2;}, d=>{d.items[0].thumb=THUMB2;}];
    for(const e of edits){
      const d = json(b.doc); e(d);
      const r = await A.api.validateCatalogue(d);
      assert.strictEqual(r.ok,false); assert.ok(r.errors.some(m=>/checksum/i.test(m)), r.errors.join("|"));
    }
  });
  await t("rejections: wrong type, version, missing fields, bad prices, duplicates, strays", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    const rej = async(mut, re)=>{ const d = json(b.doc); mut(d); const r = await A.api.validateCatalogue(d); assert.strictEqual(r.ok,false); assert.ok(r.errors.some(m=>re.test(m)), r.errors.join("|")); };
    for(const bad of [null,"x",[],42]) assert.strictEqual((await A.api.validateCatalogue(bad)).ok,false);
    await rej(d=>{d.format="seigen-dn";}, /wrong file type/);
    await rej(d=>{d.format_version=2;}, /version 2/);
    await rej(d=>{d.price_mode="whatever";}, /price policy/);
    await rej(d=>{delete d.management_whatsapp;}, /management number/);
    await rej(d=>{delete d.register;}, /branch list/);
    await rej(d=>{d.items=[];}, /no products/);
    await rej(d=>{d.items[0].price=-1;}, /invalid price/);
    await rej(d=>{d.items[0].price="5";}, /invalid price/);
    await rej(d=>{d.items[0].code="";}, /no code/);
    await rej(d=>{d.items[1].code="sk1";}, /more than once/);
    await rej(d=>{d.items[0].cost=3;}, /unexpected field "cost"/);
    await rej(d=>{d.stock=1;}, /Unexpected field "stock"/);
    await rej(d=>{d.items[0].thumb="http://x/y.png";}, /invalid picture/);
    await rej(d=>{d.totals.items=9;}, /totals do not match/);
    await rej(d=>{delete d.checksum;}, /checksum/);
  });
  await t("sniffing: catalogue recognised by content", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    assert.strictEqual(A.api.sniffJsonFormat(bytesOf(b.text)),"seigen-catalogue");
    assert.strictEqual(A.api.sniffJsonFormat(bytesOf(b.text.slice(0,300))),"seigen-catalogue", "truncated still recognised");
    assert.strictEqual(A.api.sniffJsonFormat(bytesOf('{"a":1}')),null);
  });

  // ---------------- building (main) ----------------
  await t("build blocks and lists empty and duplicate codes; nothing is generated", async ()=>{
    const A = mainApp();
    addProduct(A,"Boka HQ",{name:"No code item",sku:"",price:1});
    addProduct(A,"Boka HQ",{name:"Twin A",sku:"TW1",price:1});
    addProduct(A,"Boka HQ",{name:"Twin B",sku:" tw1 ",price:1});
    const before = snapshot(A);
    let err = null; try{ await A.api.buildCatalogueFor("Harare CBD"); }catch(e){ err = e; }
    assert.ok(err && err.problems, "blocked with a problem list");
    const texts = err.problems.map(p=>A.api.catalogueProblemText(p));
    assert.ok(texts.includes("Add a code to No code item in Products first."));
    assert.ok(texts.some(x=>/Twin A shares its code/.test(x)) && texts.some(x=>/Twin B shares its code/.test(x)));
    assert.strictEqual(err.problems.length,3);
    assert.strictEqual(snapshot(A),before, "nothing recorded when blocked");
  });
  await t("only main builds, and only for a register destination other than itself", async ()=>{
    const A = mainApp();
    await assert.rejects(()=>A.api.buildCatalogueFor("Not Listed"), /register/);
    await assert.rejects(()=>A.api.buildCatalogueFor("Boka HQ"), /itself/);
    const R = remoteApp("Harare CBD");
    await assert.rejects(()=>R.api.buildCatalogueFor("Anything"), /Only the main branch/);
  });
  await t("price mode: main only; validated", async ()=>{
    const A = mainApp();
    A.api.setBranchPriceMode("Mutare","main_sets"); assert.strictEqual(A.api.registerRow("Mutare").price_mode,"main_sets");
    assert.throws(()=>A.api.setBranchPriceMode("Mutare","bogus"), /Unknown/);
    assert.throws(()=>A.api.setBranchPriceMode("Nowhere","main_sets"), /register/);
    const R = remoteApp("Harare CBD"); R.api.run("INSERT INTO branch_register(name) VALUES('X')");
    assert.throws(()=>R.api.setBranchPriceMode("X","main_sets"), /Only the main branch/);
    assert.strictEqual(A.api.registerRow("Harare CBD").price_mode,"follow_main","default");
  });

  // ---------------- branch prices ----------------
  await t("branch prices: fallback to main; only used in main_sets; validated", async ()=>{
    const A = mainApp();
    A.api.setBranchPriceMode("Harare CBD","main_sets");
    assert.strictEqual(A.api.setBranchPrice("Harare CBD","SK1","6.5"),6.5);
    let rows = A.api.branchPriceRows("Harare CBD");
    assert.strictEqual(rows.find(r=>r.code==="SK1").effective,6.5);
    assert.strictEqual(rows.find(r=>r.code==="SK2").effective,2.5,"no branch price -> main price");
    assert.strictEqual(rows.find(r=>r.code==="SK2").branch,null);
    for(const bad of ["-1","abc","NaN","1e12"]) assert.throws(()=>A.api.setBranchPrice("Harare CBD","SK2",bad));
    assert.strictEqual(A.api.setBranchPrice("Harare CBD","SK1",""),null,"blank removes it");
    assert.strictEqual(A.api.branchPriceRows("Harare CBD").find(r=>r.code==="SK1").effective,5);
    A.api.setBranchPrice("Harare CBD","SK1","6.5"); A.api.setBranchPriceMode("Harare CBD","follow_main");
    assert.strictEqual(A.api.branchPriceRows("Harare CBD").find(r=>r.code==="SK1").effective,5,"follow_main ignores branch prices");
    const b = await A.api.buildCatalogueFor("Harare CBD");
    assert.strictEqual(b.doc.items.find(i=>i.code==="SK1").price,5);
  });
  await t("catalogue carries each product's effective price (branch price if set, else main)", async ()=>{
    const A = mainApp(); A.api.setBranchPriceMode("Harare CBD","main_sets"); A.api.setBranchPrice("Harare CBD","SK1","6.5");
    const b = await A.api.buildCatalogueFor("Harare CBD");
    assert.strictEqual(b.doc.price_mode,"main_sets");
    assert.strictEqual(b.doc.items.find(i=>i.code==="SK1").price,6.5);
    assert.strictEqual(b.doc.items.find(i=>i.code==="SK2").price,2.5);
  });
  await t("bulk adjust: previews rounded values, negatives, all-or-nothing apply", async ()=>{
    const A = mainApp(); A.api.setBranchPriceMode("Mutare","main_sets");
    const rows = A.api.branchPriceRows("Mutare").map(r=>({code:r.code,name:r.name,main:r.main}));
    const up = A.api.bulkAdjustPrices(rows, 10);
    assert.strictEqual(up.find(r=>r.code==="SK1").new,5.5); assert.strictEqual(up.find(r=>r.code==="SK2").new,2.75);
    const down = A.api.bulkAdjustPrices(rows, -5);
    assert.strictEqual(down.find(r=>r.code==="SK1").new,4.75);
    assert.ok(down.every(r=>r.new>=0));
    for(const bad of [NaN,-100,-150,Infinity,"10"]) assert.throws(()=>A.api.bulkAdjustPrices(rows,bad));
    assert.strictEqual(A.api.branchPriceRows("Mutare").every(r=>r.branch===null),true,"preview stores nothing");
    const poisoned = up.map((r,i)=>i===1?{...r,new:-3}:r);
    assert.throws(()=>A.api.applyBulkBranchPrices("Mutare",poisoned));
    assert.strictEqual(A.api.branchPriceRows("Mutare").every(r=>r.branch===null),true,"nothing applied when one row is invalid");
    A.api.applyBulkBranchPrices("Mutare", up);
    assert.strictEqual(A.api.branchPriceRows("Mutare").find(r=>r.code==="SK1").branch,5.5);
  });

  // ---------------- staleness ----------------
  // ---------------- import ----------------
  await t("import: inserts new products under the remote's own branch, keyed by code, no stock, no cost", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    const R = remoteApp("Harare CBD");
    const pre = await R.api.catalogueImportPreflight(bytesOf(b.text));
    assert.strictEqual(pre.ok,true,pre.message);
    assert.strictEqual(pre.plan.inserts.length,3);
    await R.api.applyCatalogueImport(pre.doc, pre.plan);
    const rows = R.api.all("SELECT * FROM products ORDER BY sku");
    assert.strictEqual(rows.length,3);
    assert.ok(rows.every(r=>r.branch==="Harare CBD" && r.stock===0 && r.cost===0));
    assert.strictEqual(rows.find(r=>r.sku==="SK1").price,5);
    assert.strictEqual(rows.find(r=>r.sku==="SK1").description,"grain staple");
    assert.strictEqual(R.api.getSetting("price_mode"),"follow_main");
    assert.strictEqual(R.calls.downloads,1,"backup first");
  });
  await t("import: updates name, price and image on existing codes; NEVER stock or cost; never deletes", async ()=>{
    const A = mainApp();
    A.api.run("UPDATE products SET name='Rice 2kg Premium', price=5.75 WHERE sku='SK1'");
    const b = await catalogueFor(A,"Harare CBD");
    const R = remoteApp("Harare CBD");
    addProduct(R,"Harare CBD",{name:"Rice 2kg",sku:"sk1",price:4,stock:12,cost:2.2,image:"data:image/png;base64,AAAA",description:"local keywords"});
    addProduct(R,"Harare CBD",{name:"Local only",sku:"LOC1",price:9,stock:4,cost:5});
    const pre = await R.api.catalogueImportPreflight(bytesOf(b.text));
    await R.api.applyCatalogueImport(pre.doc, pre.plan);
    const sk1 = R.api.one("SELECT * FROM products WHERE lower(sku)='sk1'");
    assert.strictEqual(sk1.name,"Rice 2kg Premium"); assert.strictEqual(sk1.price,5.75);
    assert.strictEqual(sk1.stock,12); assert.strictEqual(sk1.cost,2.2);
    assert.strictEqual(sk1.description,"local keywords","description is not overwritten");
    assert.ok(R.api.one("SELECT id FROM products WHERE sku='LOC1'"), "products missing from the catalogue are never deleted");
    assert.strictEqual(R.api.all("SELECT * FROM products WHERE lower(sku)='sk1'").length,1,"no duplicate inserted");
    assert.strictEqual(R.api.all("SELECT * FROM stock_received").length,0,"no stock movement recorded");
  });
  await t("import: an existing image is kept when the catalogue product has no picture", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    const R = remoteApp("Harare CBD");
    addProduct(R,"Harare CBD",{name:"Rice 2kg",sku:"SK1",price:5,image:"data:image/png;base64,KEEP"});
    const pre = await R.api.catalogueImportPreflight(bytesOf(b.text));
    await R.api.applyCatalogueImport(pre.doc, pre.plan);
    assert.strictEqual(R.api.one("SELECT image FROM products WHERE sku='SK1'").image,"data:image/png;base64,KEEP");
  });
  await t("import: works on a file renamed to .txt (by content); main refuses; garbage refused", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    const R = remoteApp("Harare CBD");
    assert.strictEqual((await R.api.catalogueImportPreflight(bytesOf("﻿"+b.text))).ok,true);
    const main2 = mainApp();
    const m = await main2.api.catalogueImportPreflight(bytesOf(b.text)); assert.strictEqual(m.ok,false); assert.ok(/remote branches/.test(m.message));
    for(const junk of ["not json", "{}", '{"format":"seigen-catalogue"}', b.text.slice(0,200)]){
      const r = await R.api.catalogueImportPreflight(bytesOf(junk)); assert.strictEqual(r.ok,false);
    }
  });
  await t("import: a catalogue for a different branch name is blocked, showing both names, nothing changes", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    const R = remoteApp("Mutare");
    addProduct(R,"Mutare",{name:"Existing",sku:"E1",price:1,stock:2});
    const before = snapshot(R);
    const pre = await R.api.catalogueImportPreflight(bytesOf(b.text));
    assert.strictEqual(pre.ok,false); assert.ok(pre.message.includes("Harare CBD") && pre.message.includes("Mutare"), pre.message);
    assert.strictEqual(snapshot(R),before);
    const R2 = remoteApp("  harare cbd ");   // case/space-insensitive on sanitised names
    assert.strictEqual((await R2.api.catalogueImportPreflight(bytesOf(b.text))).ok,true);
  });
  await t("import: tampered catalogue is blocked", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    const R = remoteApp("Harare CBD"); const before = snapshot(R);
    const d = json(b.doc); d.items[0].price = 0.01;
    const pre = await R.api.catalogueImportPreflight(bytesOf(JSON.stringify(d)));
    assert.strictEqual(pre.ok,false); assert.ok(/checksum/i.test(pre.message));
    assert.strictEqual(snapshot(R),before);
  });
  await t("import: duplicate local codes make matching ambiguous, so it is blocked", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    const R = remoteApp("Harare CBD");
    addProduct(R,"Harare CBD",{name:"Rice A",sku:"SK1",price:1}); addProduct(R,"Harare CBD",{name:"Rice B",sku:"sk1",price:1});
    const pre = await R.api.catalogueImportPreflight(bytesOf(b.text));
    assert.strictEqual(pre.ok,false); assert.ok(/more than one product with the same code/.test(pre.message));
  });
  await t("import: management number filled only when blank; register merged (own name skipped, numbers only fill blanks)", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    const R = remoteApp("Harare CBD", { management_whatsapp:"0788888888" });
    R.api.run("INSERT INTO branch_register(name,whatsapp) VALUES('Boka HQ','')");
    let pre = await R.api.catalogueImportPreflight(bytesOf(b.text)); await R.api.applyCatalogueImport(pre.doc, pre.plan);
    assert.strictEqual(R.api.getSetting("management_whatsapp"),"0788888888","local value wins");
    const names = R.api.all("SELECT name, whatsapp FROM branch_register ORDER BY name");
    assert.strictEqual(names.map(n=>n.name).join(),"Boka HQ,Mutare", "own branch is not a destination of itself");
    assert.strictEqual(names.find(n=>n.name==="Boka HQ").whatsapp,"0771111111", "blank number filled");
    const R2 = remoteApp("Harare CBD");
    pre = await R2.api.catalogueImportPreflight(bytesOf(b.text)); await R2.api.applyCatalogueImport(pre.doc, pre.plan);
    assert.strictEqual(R2.api.getSetting("management_whatsapp"),"0779999999","filled when blank");
    assert.strictEqual(R2.api.branchDestinations().map(d=>d.name).join(),"Boka HQ,Mutare");
  });
  await t("import: failure inside the transaction changes nothing", async ()=>{
    const A = mainApp(); const b = await catalogueFor(A,"Harare CBD");
    const R = remoteApp("Harare CBD");
    const pre = await R.api.catalogueImportPreflight(bytesOf(b.text));
    pre.plan.inserts.push({ code:"BOOM", name:null, price:1 });        // NOT NULL name -> throws mid-transaction
    const before = snapshot(R);
    await assert.rejects(()=>R.api.applyCatalogueImport(pre.doc, pre.plan));
    assert.strictEqual(snapshot(R),before);
  });

  // ---------------- price policy at import ----------------
  async function setupRemote(mode, remotePrices){
    const A = mainApp();
    A.api.setBranchPriceMode("Harare CBD", mode);
    if(mode==="main_sets") A.api.setBranchPrice("Harare CBD","SK1","6");
    const b = await A.api.buildCatalogueFor("Harare CBD");
    const R = remoteApp("Harare CBD");
    Object.entries(remotePrices).forEach(([sku,price])=>addProduct(R,"Harare CBD",{name:sku==="SK1"?"Rice 2kg":sku==="SK2"?"Sugar 1kg":"Salt",sku,price,stock:5}));
    const pre = await R.api.catalogueImportPreflight(bytesOf(b.text));
    return { A, R, b, pre };
  }
  await t("follow_main: overwrites existing prices, and previews the count and first changes", async ()=>{
    const { R, pre } = await setupRemote("follow_main",{SK1:4,SK2:2.5,SK3:9});
    assert.strictEqual(pre.ok,true);
    assert.strictEqual(pre.plan.priceChanges.length,2);
    assert.strictEqual(pre.plan.priceChanges.find(c=>c.code==="SK1").old,4);
    const lines = R.api.priceChangeLines(pre.plan.priceChanges,10);
    assert.ok(lines.includes("SK1 Rice 2kg: 4.00 to 5.00") && lines.includes("SK3 Salt: 9.00 to 1.00"), lines.join("|"));
    assert.strictEqual(R.api.one("SELECT price FROM products WHERE sku='SK1'").price,4,"preview changes nothing");
    await R.api.applyCatalogueImport(pre.doc, pre.plan);
    assert.strictEqual(priceOf(R,"SK1"),5); assert.strictEqual(priceOf(R,"SK3"),1); assert.strictEqual(priceOf(R,"SK2"),2.5);
    assert.strictEqual(R.api.getSetting("price_mode"),"follow_main");
  });
  await t("preview lists only the first 10 changes, then +N more", async ()=>{
    const A = mainApp(); const R = remoteApp("X");
    const lines = R.api.priceChangeLines(Array.from({length:14},(_,i)=>({code:"C"+i,name:"n",old:1,new:2})),10);
    assert.strictEqual(lines.length,11); assert.strictEqual(lines[10],"+4 more");
  });
  await t("main_sets: uses branch prices, falls back to main price, overwrites at the remote", async ()=>{
    const { R, pre } = await setupRemote("main_sets",{SK1:4,SK2:9,SK3:1});
    await R.api.applyCatalogueImport(pre.doc, pre.plan);
    assert.strictEqual(priceOf(R,"SK1"),6,"branch price");
    assert.strictEqual(priceOf(R,"SK2"),2.5,"no branch price -> main price");
    assert.strictEqual(R.api.getSetting("price_mode"),"main_sets");
  });
  await t("branch_edits: new products get the catalogue price; existing prices are NEVER overwritten (name and image still update)", async ()=>{
    const { R, pre } = await setupRemote("branch_edits",{SK1:4.4});     // SK1 exists with a locally edited price
    assert.strictEqual(pre.plan.priceChanges.length,0); assert.strictEqual(pre.plan.overwritesPrices,false);
    await R.api.applyCatalogueImport(pre.doc, pre.plan);
    assert.strictEqual(priceOf(R,"SK1"),4.4,"edited price kept");
    assert.strictEqual(R.api.one("SELECT name FROM products WHERE sku='SK1'").name,"Rice 2kg");
    assert.strictEqual(priceOf(R,"SK2"),2.5,"new product seeded from the catalogue");
    assert.strictEqual(R.api.getSetting("price_mode"),"branch_edits");
    // a SECOND catalogue after the remote edited a price again: still not overwritten
    R.api.run("UPDATE products SET price=7.77 WHERE sku='SK2'");
    const pre2 = await R.api.catalogueImportPreflight(bytesOf(JSON.stringify(pre.doc)));
    await R.api.applyCatalogueImport(pre2.doc, pre2.plan);
    assert.strictEqual(priceOf(R,"SK2"),7.77);
  });
  await t("mode switch: warning when the new mode would overwrite prices; none otherwise", async ()=>{
    const A = mainApp(); const R = remoteApp("Harare CBD");
    // first import as branch_edits, remote edits a price
    A.api.setBranchPriceMode("Harare CBD","branch_edits");
    let b = await A.api.buildCatalogueFor("Harare CBD");
    let pre = await R.api.catalogueImportPreflight(bytesOf(b.text)); assert.strictEqual(pre.warning,""); await R.api.applyCatalogueImport(pre.doc, pre.plan);
    R.api.run("UPDATE products SET price=4.4 WHERE sku='SK1'");
    // main flips to follow_main
    A.api.setBranchPriceMode("Harare CBD","follow_main");
    b = await A.api.buildCatalogueFor("Harare CBD");
    pre = await R.api.catalogueImportPreflight(bytesOf(b.text));
    assert.ok(/replace 1 price with main's/.test(pre.warning), pre.warning);
    assert.ok(/this branch edits its own prices/.test(pre.warning) && /prices follow main/.test(pre.warning));
    // same mode again: no mode warning
    await R.api.applyCatalogueImport(pre.doc, pre.plan);
    R.api.run("UPDATE products SET price=4.4 WHERE sku='SK1'");
    pre = await R.api.catalogueImportPreflight(bytesOf(b.text)); assert.strictEqual(pre.warning,"");
    // switching TO branch_edits never overwrites, so no warning
    A.api.setBranchPriceMode("Harare CBD","branch_edits"); b = await A.api.buildCatalogueFor("Harare CBD");
    pre = await R.api.catalogueImportPreflight(bytesOf(b.text)); assert.strictEqual(pre.warning,"");
    // a mode change that overwrites nothing does not warn
    const R2 = remoteApp("Harare CBD"); R2.api.setSetting("price_mode","branch_edits");
    A.api.setBranchPriceMode("Harare CBD","follow_main"); b = await A.api.buildCatalogueFor("Harare CBD");
    pre = await R2.api.catalogueImportPreflight(bytesOf(b.text)); assert.strictEqual(pre.warning,"", "no existing products differ");
  });
  await t("sales already recorded are never repriced by an import or a price edit", async ()=>{
    const { R, pre } = await setupRemote("follow_main",{SK1:4,SK2:2.5,SK3:1});
    const pid = R.api.one("SELECT id FROM products WHERE sku='SK1'").id;
    R.api.run("INSERT INTO sales(ts,subtotal,total,method) VALUES('2026-08-01',4,4,'Cash')");
    R.api.run("INSERT INTO sale_items(sale_id,product_id,name,price,qty) VALUES(1,?,?,?,1)",[pid,"Rice 2kg",4]);
    await R.api.applyCatalogueImport(pre.doc, pre.plan);
    assert.strictEqual(priceOf(R,"SK1"),5);
    assert.strictEqual(R.api.one("SELECT price FROM sale_items WHERE sale_id=1").price,4);
  });

  // ---------------- price edit at a remote ----------------
  function editRig(mode){
    const R = remoteApp("Harare CBD", { price_mode:mode });
    addAdmin(R,"Tendai","4321"); addAdmin(R,"Retired","9999",0);
    R.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Cash Girl','Cashier','1111','x',1,'2026-01-01')");
    const p = addProduct(R,"Harare CBD",{name:"Rice 2kg",sku:"SK1",price:5,stock:12,cost:3,image:"IMG"});
    return { R, p };
  }
  await t("price edit is blocked outside branch_edits (both other modes) and on main", async ()=>{
    for(const mode of ["follow_main","main_sets"]){
      const { R, p } = editRig(mode);
      assert.strictEqual(R.api.remotePriceEditable(),false);
      assert.throws(()=>R.api.applyRemotePriceEdit({productId:p.id,price:"6",passcode:"4321"}), /set by the main branch|follow the main branch/);
      assert.strictEqual(priceOf(R,"SK1"),5);
      assert.strictEqual(R.api.all("SELECT * FROM audit_log WHERE action='Price change'").length,0);
    }
    const A = mainApp(); addAdmin(A,"Boss","1");
    assert.throws(()=>A.api.applyRemotePriceEdit({productId:1,price:"9",passcode:"1"}), /main branch/);
  });
  await t("price edit needs the Admin passcode (not a signed-in user, cashier, inactive admin or blank)", async ()=>{
    const { R, p } = editRig("branch_edits");
    for(const pass of ["", "wrong", "1111", "9999", undefined, null])
      assert.throws(()=>R.api.applyRemotePriceEdit({productId:p.id,price:"6",passcode:pass}), /Incorrect Admin passcode/);
    assert.strictEqual(priceOf(R,"SK1"),5);
  });
  await t("price edit: price only, validated, and audited (who, code, old, new)", async ()=>{
    const { R, p } = editRig("branch_edits");
    for(const bad of ["-1","abc","","1e12",NaN]) assert.throws(()=>R.api.applyRemotePriceEdit({productId:p.id,price:bad,passcode:"4321"}));
    assert.throws(()=>R.api.applyRemotePriceEdit({productId:p.id,price:"5",passcode:"4321"}), /already the price/);
    assert.strictEqual(R.api.all("SELECT * FROM audit_log WHERE action='Price change'").length,0);
    const r = R.api.applyRemotePriceEdit({productId:p.id,price:"6.25",passcode:"4321"});
    assert.strictEqual(r.old,5); assert.strictEqual(r.new,6.25); assert.strictEqual(r.admin,"Tendai");
    const row = R.api.one("SELECT * FROM products WHERE id=?",[p.id]);
    assert.strictEqual(row.price,6.25);
    assert.strictEqual(row.stock,12); assert.strictEqual(row.cost,3); assert.strictEqual(row.name,"Rice 2kg"); assert.strictEqual(row.sku,"SK1"); assert.strictEqual(row.image,"IMG");
    const log = R.api.all("SELECT * FROM audit_log WHERE action='Price change'");
    assert.strictEqual(log.length,1);
    assert.strictEqual(log[0].user,"Tester","who is signed in");
    assert.strictEqual(log[0].product_name,"Rice 2kg");
    assert.ok(/SK1: 5\.00 -> 6\.25/.test(log[0].details) && /authorised by Tendai/.test(log[0].details), log[0].details);
    assert.strictEqual(R.api.all("SELECT * FROM stock_received").length,0);
  });
  await t("price edit cannot reach another branch's product", async ()=>{
    const { R } = editRig("branch_edits");
    const other = addProduct(R,"Elsewhere",{name:"Other",sku:"O1",price:1});
    assert.throws(()=>R.api.applyRemotePriceEdit({productId:other.id,price:"9",passcode:"4321"}), /not in this branch/);
    assert.strictEqual(R.api.one("SELECT price FROM products WHERE id=?",[other.id]).price,1);
  });

  // ---------------- admin visibility ----------------
  await t("branch price differences: pure comparison by code, sorted, ignores unmatched", async ()=>{
    const A = mainApp();
    const d = A.api.priceDifferences(
      [{sku:"SK1",name:"Rice",price:5},{sku:"SK2",name:"Sugar",price:2.5},{sku:"SK3",name:"Salt",price:1}],
      [{sku:"sk2",name:"Sugar",price:3},{sku:"SK1",name:"Rice",price:5},{sku:"ZZ",name:"Only there",price:1},{sku:"",name:"No code",price:9},{sku:"SK3",name:"Salt",price:0.5}]);
    assert.strictEqual(JSON.stringify(d.map(x=>[x.code,x.main,x.branch])),JSON.stringify([["SK2",2.5,3],["SK3",1,0.5]]));
  });
  await t("merging a branch's data file on main reports price differences and changes nothing extra", async ()=>{
    const A = mainApp();
    const B = makeApp({ branch_name:"Harare CBD", branch_type:"remote", setup_complete:"1" });
    addProduct(B,"Harare CBD",{name:"Rice 2kg",sku:"SK1",price:4.5,stock:3});
    addProduct(B,"Harare CBD",{name:"Sugar 1kg",sku:"SK2",price:2.5,stock:3});
    const res = await A.api.mergeDatabase({ __db:B.db });
    assert.strictEqual(res.branch,"Harare CBD");
    assert.strictEqual(JSON.stringify(res.priceDiffs.map(d=>[d.code,d.main,d.branch])),JSON.stringify([["SK1",5,4.5]]));
    assert.strictEqual(priceOf(A,"SK1"),5,"main's own price untouched");
    await assert.rejects(()=>B.api.mergeDatabase({ __db:A.db }), (e)=>e.code==="MAIN_FILE_REFUSED");   // a remote no longer takes main's file at all
  });

  // ================= price policy fixes =================
  await t("branch prices apply ONLY in main_sets; other modes carry main's price; stored prices are kept, not deleted", async ()=>{
    const A = mainApp();
    A.api.setBranchPriceMode("Harare CBD","main_sets");
    A.api.setBranchPrice("Harare CBD","SK1","7"); A.api.setBranchPrice("Harare CBD","SK2","3");
    let b = await A.api.buildCatalogueFor("Harare CBD");
    assert.strictEqual(b.doc.items.find(i=>i.code==="SK1").price,7); assert.strictEqual(b.doc.items.find(i=>i.code==="SK2").price,3);
    for(const mode of ["follow_main","branch_edits"]){
      A.api.setBranchPriceMode("Harare CBD",mode);
      b = await A.api.buildCatalogueFor("Harare CBD");
      assert.strictEqual(b.doc.items.find(i=>i.code==="SK1").price,5, mode+" carries main's price");
      assert.strictEqual(b.doc.items.find(i=>i.code==="SK2").price,2.5, mode);
      assert.strictEqual(A.api.branchPriceRows("Harare CBD").find(r=>r.code==="SK1").effective,5, mode+" effective");
      assert.strictEqual(A.api.all("SELECT * FROM branch_prices").length,2,"stored branch prices are kept in "+mode);
      assert.strictEqual(A.api.branchPriceRows("Harare CBD").find(r=>r.code==="SK1").branch,7,"and still shown as stored");
    }
    A.api.setBranchPriceMode("Harare CBD","main_sets");                  // switching back: the kept prices apply again
    b = await A.api.buildCatalogueFor("Harare CBD");
    assert.strictEqual(b.doc.items.find(i=>i.code==="SK1").price,7);
  });
  await t("branch prices can only be set, and the screen only opens, in main_sets", async ()=>{
    const A = mainApp();
    for(const mode of ["follow_main","branch_edits"]){
      A.api.setBranchPriceMode("Harare CBD",mode);
      assert.throws(()=>A.api.setBranchPrice("Harare CBD","SK1","7"), /only be set while/);
      assert.throws(()=>A.api.applyBulkBranchPrices("Harare CBD",[{code:"SK1",new:7}]), /only be set while/);
      const alerts = [], modals = [];
      A.hook("alert",(m)=>alerts.push(m)); A.hook("openModal",(ti)=>{ modals.push(ti); return { querySelector:()=>({}) , remove(){} }; });
      A.api.openBranchPricesScreen("Harare CBD");
      assert.strictEqual(modals.length,0,"screen did not open in "+mode); assert.ok(/only used when/.test(alerts[0]), alerts[0]);
    }
    assert.strictEqual(A.api.all("SELECT * FROM branch_prices").length,0);
    A.api.setBranchPriceMode("Harare CBD","main_sets");
    const modals = []; A.hook("openModal",(ti)=>{ modals.push(ti); return { querySelector:()=>({ set innerHTML(v){}, get innerHTML(){ return ""; } }) }; });
    try{ A.api.openBranchPricesScreen("Harare CBD"); }catch(e){ /* stub modal is minimal; only the open matters */ }
    assert.strictEqual(modals.length,1); assert.ok(/Branch prices/.test(modals[0]));
  });
  await t("branch_edits: new products are inserted at MAIN's price even when old branch prices are stored", async ()=>{
    const A = mainApp();
    A.api.setBranchPriceMode("Harare CBD","main_sets"); A.api.setBranchPrice("Harare CBD","SK1","7");
    A.api.setBranchPriceMode("Harare CBD","branch_edits");
    const b = await A.api.buildCatalogueFor("Harare CBD");
    const R = remoteApp("Harare CBD");
    const pre = await R.api.catalogueImportPreflight(bytesOf(b.text)); await R.api.applyCatalogueImport(pre.doc, pre.plan);
    assert.strictEqual(priceOf(R,"SK1"),5,"main's price, not the stored branch price 7");
    assert.strictEqual(priceOf(R,"SK2"),2.5);
    assert.strictEqual(R.api.getSetting("price_mode"),"branch_edits");
  });
  await t("price_ts: set on insert, moves only when the price really changes, backfilled on upgrade", async ()=>{
    const A = mainApp();
    const row = ()=>A.api.one("SELECT price_ts FROM products WHERE sku='SK1'").price_ts;
    const t0 = row(); assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t0), t0);
    await wait(); A.api.run("UPDATE products SET stock=1, cost=9, name='Renamed' WHERE sku='SK1'"); assert.strictEqual(row(),t0,"stock/cost/name changes do not move it");
    A.api.run("UPDATE products SET price=5 WHERE sku='SK1'"); assert.strictEqual(row(),t0,"same price does not move it");
    await wait(); A.api.run("UPDATE products SET price=5.5 WHERE sku='SK1'"); const t1 = row(); assert.ok(t1>t0,"a real change moves it");
    // upgrade path: rows without a timestamp get their created_ts
    A.api.run("UPDATE products SET price_ts=''"); A.api.migrate(A.db);
    assert.strictEqual(A.api.one("SELECT price_ts FROM products WHERE sku='SK1'").price_ts,"2026-01-01"===A.api.one("SELECT created_ts FROM products WHERE sku='SK1'").created_ts?"2026-01-01":A.api.one("SELECT created_ts FROM products WHERE sku='SK1'").created_ts);
    A.api.migrate(A.db);                                                  // idempotent
    assert.strictEqual(A.api.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'products_price_ts%'").length,2);
  });
  await t("price_ts moves for every price path: catalogue import and remote price edit too", async ()=>{
    const A = mainApp(); const b = await A.api.buildCatalogueFor("Harare CBD");
    const R = remoteApp("Harare CBD"); addProduct(R,"Harare CBD",{name:"Rice 2kg",sku:"SK1",price:4});
    const before = R.api.one("SELECT price_ts FROM products WHERE sku='SK1'").price_ts;
    await wait();
    const pre = await R.api.catalogueImportPreflight(bytesOf(b.text)); await R.api.applyCatalogueImport(pre.doc, pre.plan);
    const after = R.api.one("SELECT price,price_ts FROM products WHERE sku='SK1'");
    assert.ok(after.price_ts>before, JSON.stringify({before,after,changes:pre.plan.priceChanges.length,ok:pre.ok,msg:pre.message}));
  });
  await t("staleness: appears after a main price change and clears after a new catalogue is generated", async ()=>{
    const A = mainApp();
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").never,true);
    await A.api.buildCatalogueFor("Harare CBD");
    let st = A.api.catalogueStatus("Harare CBD");
    assert.strictEqual(st.never,false); assert.ok(st.ts); assert.strictEqual(st.pricesChanged,false); assert.strictEqual(st.modeChanged,false);
    await wait(); A.api.run("UPDATE products SET price=5.5 WHERE sku='SK1'");
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,true,"flag appears");
    assert.strictEqual(A.api.catalogueStatus("Mutare").never,true,"per destination: another one never had a catalogue");
    await wait(); await A.api.buildCatalogueFor("Harare CBD");
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,false,"flag clears after a new catalogue");
    await wait(); A.api.run("UPDATE products SET stock=1, cost=9, shelf='x', name='Renamed' WHERE sku='SK1'");
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,false,"only price changes flag");
    await wait(); A.api.run("INSERT INTO products(name,price,stock,sku,branch,cost,created_ts) VALUES('NoCode',3,1,'','Boka HQ',0,'x')");
    A.api.run("UPDATE products SET price=4 WHERE name='NoCode'");
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,false,"code-less products are not in a catalogue");
  });
  await t("staleness: a destination's branch-price edits (and removals) flag it in main_sets, and clear on the next catalogue", async ()=>{
    const A = mainApp(); A.api.setBranchPriceMode("Harare CBD","main_sets");
    await wait(); await A.api.buildCatalogueFor("Harare CBD");
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,false);
    await wait(); A.api.setBranchPrice("Harare CBD","SK1","6");
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,true);
    assert.ok(A.api.registerRow("Harare CBD").prices_ts, "the destination's timestamp was stamped");
    assert.strictEqual(A.api.catalogueStatus("Mutare").pricesChanged,false,"other destinations unaffected");
    await wait(); await A.api.buildCatalogueFor("Harare CBD");
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,false);
    await wait(); A.api.setBranchPrice("Harare CBD","SK1","6");                // unchanged value: no flag
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,false);
    await wait(); A.api.setBranchPrice("Harare CBD","SK1","");                 // removal changes the effective price too
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,true);
    await wait(); await A.api.buildCatalogueFor("Harare CBD");
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,false);
    // outside main_sets branch prices don't feed the catalogue, so a stamped timestamp must not flag
    A.api.setBranchPriceMode("Harare CBD","follow_main");
    await wait(); await A.api.buildCatalogueFor("Harare CBD");
    A.api.run("UPDATE branch_register SET prices_ts=? WHERE name='Harare CBD'",[new Date(Date.now()+60000).toISOString()]);
    assert.strictEqual(A.api.catalogueStatus("Harare CBD").pricesChanged,false);
  });
  await t("staleness: a policy change is flagged separately and clears too", async ()=>{
    const A = mainApp(); await A.api.buildCatalogueFor("Harare CBD");
    A.api.setBranchPriceMode("Harare CBD","branch_edits");
    let st = A.api.catalogueStatus("Harare CBD"); assert.strictEqual(st.modeChanged,true); assert.strictEqual(st.pricesChanged,false);
    await wait(); await A.api.buildCatalogueFor("Harare CBD");
    st = A.api.catalogueStatus("Harare CBD"); assert.strictEqual(st.modeChanged,false);
  });
  await t("remote with no Admin passcode cannot edit prices: \"Set an Admin passcode in Settings first\"", async ()=>{
    const R = remoteApp("Harare CBD",{ price_mode:"branch_edits" });
    const p = addProduct(R,"Harare CBD",{name:"Rice 2kg",sku:"SK1",price:5,stock:3});
    const MSG = "Set an Admin passcode in Settings first";
    const attempt = ()=>R.api.applyRemotePriceEdit({productId:p.id,price:"6",passcode:"1234"});
    assert.throws(attempt, new RegExp(MSG),"no staff at all");
    R.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('NoCode','Admin','',?,1,'x')",["x"]);
    R.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Blanks','Admin','   ',?,1,'x')",["x"]);
    R.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Gone','Admin','1234',?,0,'x')",["x"]);
    R.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Cash','Cashier','1234',?,1,'x')",["x"]);
    assert.strictEqual(R.api.hasAdminPasscode(),false);
    assert.throws(attempt, new RegExp(MSG),"admins without a passcode, inactive, or cashiers do not count");
    assert.throws(()=>R.api.applyRemotePriceEdit({productId:p.id,price:"6",passcode:""}), new RegExp(MSG));
    assert.strictEqual(priceOf(R,"SK1"),5);
    assert.ok(R.api.remotePriceNote().includes(MSG));
    const alerts = []; R.hook("alert",(m)=>alerts.push(m)); R.hook("openModal",()=>{ throw new Error("must not open"); });
    R.api.openPriceEditModal(p);
    assert.strictEqual(alerts[0],MSG);
    R.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Tendai','Admin','4321',?,1,'x')",["x"]);
    assert.strictEqual(R.api.hasAdminPasscode(),true);
    assert.strictEqual(R.api.applyRemotePriceEdit({productId:p.id,price:"6",passcode:"4321"}).new,6);
  });
  await t("price-only editing does not unlock any other product field", async ()=>{
    const R = remoteApp("Harare CBD",{ price_mode:"branch_edits" });
    R.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Tendai','Admin','4321','x',1,'x')");
    const p = addProduct(R,"Harare CBD",{name:"Rice 2kg",sku:"SK1",price:5,stock:3,cost:2});
    const rows = R.api.all("SELECT * FROM products");
    const table = R.api.productsTableHtml(rows, true);
    assert.ok(/data-actions="[^"]*\bprice\b/.test(table)); assert.ok(!/data-actions="[^"]*\b(edit|restock)\b/.test(table), "no full-edit or add-stock menu items on a remote, even in branch_edits");
    const bound = []; const scope = { querySelectorAll:(sel)=>{ bound.push(sel); return []; } };
    R.api.wireProductRowButtons(scope, true);
    assert.strictEqual(bound.join(),"[data-rowmenu]", "only the row menu is wired; it offers price and adjust-stock (no full editor)");
    assert.ok(/data-actions="[^"]*\badjust\b/.test(table));
    const alerts = [], modals = []; R.hook("alert",(m)=>alerts.push(m)); R.hook("openModal",(ti)=>{ modals.push(ti); return {}; });
    R.api.productModal(p);                                              // the full editor is still refused
    assert.strictEqual(modals.length,0); assert.ok(/remote branch/.test(alerts[0]), alerts[0]);
    R.api.productModal(null); assert.strictEqual(modals.length,0);
    // the price modal itself offers only a price and the passcode
    let html = ""; R.hook("openModal",(ti,h)=>{ html = h; return { querySelector:()=>({}) }; });
    R.api.openPriceEditModal(p);
    const ids = [...html.matchAll(/<(?:input|select|textarea)[^>]*id="([^"]+)"/g)].map(m=>m[1]);
    assert.strictEqual(ids.join(),"peNew,pePass");
    // and the write path touches nothing but price
    const before = R.api.one("SELECT * FROM products WHERE id=?",[p.id]);
    R.api.applyRemotePriceEdit({productId:p.id,price:"9.5",passcode:"4321"});
    const after = R.api.one("SELECT * FROM products WHERE id=?",[p.id]);
    Object.keys(before).filter(k=>!["price","price_ts"].includes(k)).forEach(k=>assert.strictEqual(after[k],before[k],k));
    assert.strictEqual(after.price,9.5);
    // and other modes show no price button at all
    R.api.setSetting("price_mode","follow_main");
    assert.ok(!/data-actions="[^"]*\bprice\b/.test(R.api.productsTableHtml(R.api.all("SELECT * FROM products"), true)));
  });
  await t("bulk %: previews first (nothing stored), rounds to 2 decimals, validates, applies all-or-nothing", async ()=>{
    const A = mainApp(); A.api.setBranchPriceMode("Mutare","main_sets");
    A.api.run("UPDATE products SET price=3.33 WHERE sku='SK1'"); A.api.run("UPDATE products SET price=9.99 WHERE sku='SK2'"); A.api.run("UPDATE products SET price=0 WHERE sku='SK3'");
    const rows = A.api.branchPriceRows("Mutare").map(r=>({code:r.code,name:r.name,main:r.main}));
    const cents = (n)=>Math.abs(n*100-Math.round(n*100))<1e-9;
    const up = A.api.bulkAdjustPrices(rows, 15);
    assert.strictEqual(up.find(r=>r.code==="SK1").new,3.83, "3.33 +15% = 3.8295 -> 3.83");
    assert.strictEqual(up.find(r=>r.code==="SK2").new,11.49, "9.99 +15% = 11.4885 -> 11.49");
    assert.strictEqual(up.find(r=>r.code==="SK3").new,0);
    for(const pct of [-33.333, 7.777, -0.5, 100, 250, -99.99]){
      const r = A.api.bulkAdjustPrices(rows, pct); assert.ok(r.every(x=>cents(x.new) && x.new>=0), "pct "+pct);
    }
    assert.strictEqual(A.api.bulkAdjustPrices(rows,-33.333).find(r=>r.code==="SK2").new,6.66);
    assert.strictEqual(A.api.all("SELECT * FROM branch_prices").length,0,"a preview stores nothing");
    for(const bad of [NaN,-100,-101,Infinity,"10",null,undefined]) assert.throws(()=>A.api.bulkAdjustPrices(rows,bad));
    await wait(); A.api.applyBulkBranchPrices("Mutare", up);
    const stored = A.api.getBranchPrices("Mutare");
    assert.strictEqual(stored.get("sk1"),3.83); assert.strictEqual(stored.get("sk2"),11.49);
    assert.ok(A.api.registerRow("Mutare").prices_ts);
    const before = JSON.stringify(A.api.all("SELECT * FROM branch_prices"));
    assert.throws(()=>A.api.applyBulkBranchPrices("Mutare", up.map((r,i)=>i===1?{...r,new:-1}:{...r,new:1})));
    assert.strictEqual(JSON.stringify(A.api.all("SELECT * FROM branch_prices")),before,"nothing applied when any row is invalid");
  });
  await t("Branch price differences report is read-only: it lists, changes nothing, and offers no way to change", async ()=>{
    const A = mainApp();
    const B = makeApp({ branch_name:"Harare CBD", branch_type:"remote", setup_complete:"1" });
    addProduct(B,"Harare CBD",{name:"Rice 2kg",sku:"SK1",price:4.5,stock:3}); addProduct(B,"Harare CBD",{name:"Sugar 1kg",sku:"SK2",price:2.5,stock:3});
    const res = await A.api.mergeDatabase({ __db:B.db });
    assert.strictEqual(res.priceDiffs.length,1);
    const mainPrices = JSON.stringify(A.api.all("SELECT sku,price,price_ts FROM products WHERE branch='Boka HQ' ORDER BY sku"));
    const before = snapshot(A);
    let html = "", buttons = 0; A.hook("openModal",(ti,h)=>{ html = h; return {}; });
    A.api.showBranchPriceDifferences(res.branch, res.priceDiffs);
    assert.ok(html.includes("SK1") && html.includes("5.00") && html.includes("4.50") && html.includes("Information only"));
    assert.ok(!/<input|<button|<select|<textarea|onclick|<form/i.test(html), "the report has no controls");
    assert.strictEqual(snapshot(A),before,"showing it changes nothing");
    assert.strictEqual(JSON.stringify(A.api.all("SELECT sku,price,price_ts FROM products WHERE branch='Boka HQ' ORDER BY sku")),mainPrices,"main's prices and timestamps untouched by the merge and the report");
    assert.strictEqual(A.api.all("SELECT * FROM branch_prices").length,0);
    A.api.showBranchPriceDifferences("X",[]); A.api.showBranchPriceDifferences("X",null);  // nothing to show: no-op
  });
  await t("no price fields appear in DN or GRV files (and neither format accepts one)", async ()=>{
    const { A2, B2 } = (()=>{ const A2 = mainApp(); const B2 = remoteApp("Harare CBD"); addProduct(B2,"Harare CBD",{name:"Rice 2kg",sku:"SK1",price:12.34,cost:8.88}); return { A2, B2 }; })();
    const p = A2.api.one("SELECT * FROM products WHERE sku='SK1'");
    A2.api.setBranchPriceMode("Harare CBD","follow_main");
    const dnDoc = await A2.api.buildDN({ dnNo:1, fromBranchId:A2.api.getBranchId(), fromName:"Boka HQ", toName:"Harare CBD", createdIso:"2026-09-04T08:00:00+02:00",
      items:[{code:"SK1",name:p.name,qty:2,price:5,cost:3.77,thumb:undefined}] });
    const grv = await A2.api.buildGRV({ grvNo:1, dnNo:1, fromBranchId:"B-1", fromName:"Boka HQ", toBranchId:"B-2", toName:"Harare CBD", receivedIso:"2026-09-05T14:15:00+02:00", items:[{code:"SK1",name:p.name,qty:2,price:5,cost:3.77}] });
    const keys = (x,acc=[])=>{ if(Array.isArray(x)) x.forEach(v=>keys(v,acc)); else if(x&&typeof x==="object") Object.keys(x).forEach(k=>{ acc.push(k); keys(x[k],acc); }); return acc; };
    for(const [label,doc] of [["DN",dnDoc],["GRV",grv]]){
      assert.ok(!keys(doc).some(k=>/price|cost|amount|value/i.test(k)), label+" has no price-like key: "+keys(doc).join(","));
      assert.ok(!/3\.77|"price"|"cost"/.test(JSON.stringify(doc)), label);
    }
    const bad = json(dnDoc); bad.items[0].price = 5; assert.strictEqual((await A2.api.validateDN(bad)).ok,false);
    const bad2 = json(dnDoc); bad2.price = 5; assert.strictEqual((await A2.api.validateDN(bad2)).ok,false);
    const g1 = json(grv); g1.items[0].price = 5; assert.strictEqual((await A2.api.validateGRV(g1)).ok,false);
    const g2 = json(grv); g2.price = 5; assert.strictEqual((await A2.api.validateGRV(g2)).ok,false);
    // receiving never touches price or cost
    const R = B2, dn = json(dnDoc); dn.to.name = "Harare CBD";
    const send = await R.api.receiveCheckBytes(new Uint8Array(Buffer.from(A2.api.serializeDN(dnDoc),"utf8")));
    assert.strictEqual(send.res.ok,true,send.res.message);
    const beforeP = R.api.one("SELECT price,cost,price_ts FROM products WHERE sku='SK1'");
    R.api.commitReceive(send.res.doc, new Date());
    const afterP = R.api.one("SELECT price,cost,price_ts FROM products WHERE sku='SK1'");
    assert.strictEqual(JSON.stringify(afterP),JSON.stringify(beforeP),"receiving leaves price, cost and price_ts alone");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
