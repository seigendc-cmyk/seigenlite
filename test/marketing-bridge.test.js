// Run: node --no-warnings test/marketing-bridge.test.js
// Marketing tab, core side (src/marketing.js), over the REAL app source via
// the shared harness:
//   * what the bridge hands the dist-market layer (this branch's products
//     only, no image data in the list) and the selection rules the core app
//     enforces whatever the layer sends (real ids here, no duplicates, <= 200)
//   * the .scl export file: name, shape (vendor + vendor_listings columns),
//     values taken from the database not the layer, clamping to the
//     vendor_listings CHECKs, photo validation, checksum
//   * status: not_exported -> exported -> sent -> expiring after 7 days
//   * the WhatsApp handoff goes through shareDocFile to +263789487287
// The iframe/postMessage wiring, photo resizing and screens need a real
// browser and live in test/marketing-picker-e2e.test.js.
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
// Arrays built inside the app vm are from another realm: compare plain copies.
const plain = (x)=> JSON.parse(JSON.stringify(x));
const WEBP = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=";

function rig(settings){
  const app = makeApp(Object.assign({ branch_name:"Boka", branch_type:"main", setup_complete:"1",
    shop_name:"Boka General Dealer", install_id:"INST-1234", contact_phone:"0771234567" }, settings||{}));
  // The file store is IndexedDB in the browser; keep it in memory here.
  const files = new Map();
  app.hook("mkfPut", async (k, rec)=>{ files.set(k, rec); return true; });
  app.hook("mkfGet", async (k)=> files.get(k)||null);
  const shares = [];
  app.hook("shareDocFile", async (o)=>{ shares.push(o); return { method:"downloaded" }; });
  const opened = [];
  app.hook("openExternalUrl", (u)=>{ opened.push(u); });
  const add = (name, o)=>{
    o = Object.assign({ price:1, stock:1, sku:"", category:"", image:"", branch:"Boka" }, o||{});
    app.api.run("INSERT INTO products(name,price,stock,sku,category,image,branch) VALUES(?,?,?,?,?,?,?)",
      [name, o.price, o.stock, o.sku, o.category, o.image, o.branch]);
    return app.api.one("SELECT last_insert_rowid() AS id").id;
  };
  return { app, api:app.api, ops:app.api.MARKET_OPS, add, files, shares, opened };
}

(async()=>{
  // ---------------- products + selection ----------------
  await t("listProducts returns only this branch's products, with the picker's fields", async ()=>{
    const { ops, add } = rig();
    add("Sugar 2kg", { price:3.5, stock:12, sku:"SUG2", category:"Groceries", image:WEBP });
    add("Bread", { price:1, stock:0 });
    add("Other branch item", { branch:"Harare" });
    const rows = ops.listProducts();
    assert.deepStrictEqual(plain(rows.map(r=>r.name)), ["Bread","Sugar 2kg"]);
    const sugar = rows.find(r=>r.name==="Sugar 2kg");
    assert.deepStrictEqual(plain(Object.keys(sugar).sort()), ["category","hasImage","id","name","price","sku","stock"]);
    assert.strictEqual(sugar.hasImage, true);
    assert.strictEqual(rows.find(r=>r.name==="Bread").hasImage, false);
  });

  await t("listProducts never sends image data to the layer", async ()=>{
    const { ops, add } = rig();
    add("Pic", { image:"data:image/webp;base64,"+"A".repeat(5000) });
    assert.ok(!JSON.stringify(ops.listProducts()).includes("AAAA"));
  });

  await t("setSelection keeps only real ids at this branch, de-duplicated, in order, and saves them", async ()=>{
    const { api, ops, add } = rig();
    const a = add("A"), b = add("B"), elsewhere = add("C", { branch:"Harare" });
    const out = await ops.setSelection({ ids:[b, "x", a, b, 99999, elsewhere, 1.5, String(a)] });
    assert.deepStrictEqual(plain(out), [b, a]);
    assert.deepStrictEqual(plain(ops.getSelection()), [b, a]);
    assert.strictEqual(api.getSetting("market_selection"), JSON.stringify([b, a]));
  });

  await t("setSelection caps at 200 even if the layer sends more", async ()=>{
    const { api, ops, add } = rig();
    const ids = [];
    for(let i=0;i<205;i++) ids.push(add("P"+i));
    assert.strictEqual(api.MARKET_MAX_PRODUCTS, 200);
    const out = await ops.setSelection({ ids });
    assert.strictEqual(out.length, 200);
    assert.deepStrictEqual(plain(out), ids.slice(0,200));
  });

  await t("setSelection rejects a non-list", async ()=>{
    const { ops } = rig();
    await assert.rejects(()=>ops.setSelection({ ids:"1,2,3" }), /list of product ids/);
    await assert.rejects(()=>ops.setSelection(null), /list of product ids/);
  });

  await t("getSelection drops products deleted since they were picked", async ()=>{
    const { api, ops, add } = rig();
    const a = add("A"), b = add("B");
    await ops.setSelection({ ids:[a,b] });
    api.run("DELETE FROM products WHERE id=?",[a]);
    assert.deepStrictEqual(plain(ops.getSelection()), [b]);
  });

  // ---------------- Products → "Add to Marketing" ----------------
  await t("Add to Marketing adds the checked products after what's already selected, without duplicates", async ()=>{
    const { api, ops, add } = rig();
    const a = add("A"), b = add("B"), c = add("C");
    await ops.setSelection({ ids:[b] });
    const r = await api.marketAddToSelection([c, b, a]);
    assert.deepStrictEqual(plain(r.selection), [b, c, a]);
    assert.strictEqual(r.added, 2, "b was already there");
    assert.deepStrictEqual(plain(r.notAdded), []);
    assert.deepStrictEqual(plain(ops.getSelection()), [b, c, a], "saved, so the picker opens with them ticked");
  });

  await t("Add to Marketing ignores other branches' and deleted products, and reports what didn't fit under 200", async ()=>{
    const { api, ops, add } = rig();
    const other = add("Elsewhere", { branch:"CBD" });
    const ids = []; for(let i=0; i<199; i++) ids.push(add("P"+i));
    await ops.setSelection({ ids });
    const x = add("X"), y = add("Y");
    const r = await api.marketAddToSelection([other, 999999, x, y]);
    assert.strictEqual(r.selection.length, 200);
    assert.strictEqual(r.selection[199], x);
    assert.strictEqual(r.added, 1);
    assert.deepStrictEqual(plain(r.notAdded), [y]);
  });

  await t("getProductImage only hands out photos of selected products", async ()=>{
    const { ops, add } = rig();
    const a = add("A", { image:WEBP }), b = add("B", { image:WEBP }), c = add("C");
    await ops.setSelection({ ids:[a, c] });
    assert.strictEqual(ops.getProductImage({ id:a }), WEBP);
    assert.strictEqual(ops.getProductImage({ id:c }), "");
    assert.throws(()=>ops.getProductImage({ id:b }), /isn't selected/);
  });

  // ---------------- export file ----------------
  await t("file name: MKT number, shop name, date, time, .scl", async ()=>{
    const { api } = rig();
    const d = new Date(2026, 8, 24, 15, 5);
    assert.strictEqual(api.marketFileName(1, "Boka General Dealer", d), "MKT0001-BokaGeneralDealer-24Sep26-0305PM.scl");
    assert.strictEqual(api.marketFileName(12, "Zürich & Co.", d), "MKT0012-ZurichCo-24Sep26-0305PM.scl");
  });

  await t("export setup reports identity, contact_phone as the WhatsApp number, and USD by default", async ()=>{
    const { ops } = rig();
    const s = ops.getExportSetup();
    assert.strictEqual(s.installId, "INST-1234");
    assert.strictEqual(s.businessName, "Boka General Dealer");
    assert.strictEqual(s.whatsappNumber, "0771234567");
    assert.strictEqual(s.city, "");
    assert.strictEqual(s.currency, "USD");
    assert.strictEqual(s.currencySet, false);
    assert.strictEqual(s.marketWhatsApp, "+263789487287");
  });

  await t("buildExport writes a .scl file shaped for vendors + vendor_listings, values from the database", async ()=>{
    const { api, ops, add, files } = rig();
    const sugar = add("Sugar 2kg", { price:3.456, stock:12, category:"Groceries", image:WEBP });
    const bread = add("  Bread  ", { price:1, stock:2.5 });
    await ops.setSelection({ ids:[sugar, bread] });
    const st = await ops.buildExport({ city:"  Harare ", currency:"usd", images:{ [sugar]:WEBP } });
    assert.strictEqual(st.state, "exported");
    assert.strictEqual(st.exportNo, "MKT0001");
    assert.match(st.fileName, /^MKT0001-BokaGeneralDealer-\d{2}[A-Z][a-z]{2}\d{2}-\d{4}[AP]M\.scl$/);
    const rec = files.get("Boka");
    assert.strictEqual(rec.fileName, st.fileName);
    const doc = JSON.parse(rec.text);
    assert.deepStrictEqual(Object.keys(doc), ["format","format_version","export_no","created_iso","exported_at","vendor","listings","totals","checksum"]);
    assert.strictEqual(doc.format, "seigen.market_export");
    assert.strictEqual(doc.format_version, 1);
    assert.deepStrictEqual(doc.vendor, { install_id:"INST-1234", business_name:"Boka General Dealer", whatsapp_number:"0771234567", city:"Harare" });
    assert.deepStrictEqual(doc.listings.map(l=>Object.keys(l)), [
      ["source_product_id","product_name","price","currency","category","stock_quantity","exported_at","image_webp"],
      ["source_product_id","product_name","price","currency","category","stock_quantity","exported_at","image_webp"]]);
    const [l1, l2] = doc.listings;
    assert.deepStrictEqual(l1, { source_product_id:String(sugar), product_name:"Sugar 2kg", price:3.46, currency:"USD",
      category:"Groceries", stock_quantity:12, exported_at:doc.exported_at, image_webp:WEBP });
    assert.deepStrictEqual(l2, { source_product_id:String(bread), product_name:"Bread", price:1, currency:"USD",
      category:null, stock_quantity:2.5, exported_at:doc.exported_at, image_webp:null });
    assert.deepStrictEqual(doc.totals, { listings:2, with_image:1 });
    assert.ok(!isNaN(Date.parse(doc.exported_at)));
    // city + currency are saved for next time
    assert.strictEqual(api.getSetting("market_city"), "Harare");
    assert.strictEqual(api.getSetting("market_currency"), "USD");
    assert.strictEqual(ops.getExportSetup().currencySet, true);
  });

  await t("checksum covers everything else in the file", async ()=>{
    const { api, ops, add, files } = rig();
    const a = add("A", { price:2 });
    await ops.setSelection({ ids:[a] });
    await ops.buildExport({ city:"Harare", currency:"USD", images:{} });
    const doc = JSON.parse(files.get("Boka").text);
    const { checksum, ...rest } = doc;
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.strictEqual(await api.marketChecksum(rest), checksum);
    rest.listings[0].price = 0.01;
    assert.notStrictEqual(await api.marketChecksum(rest), checksum);
  });

  await t("negative stock and price are clamped to 0 (vendor_listings CHECKs)", async ()=>{
    const { ops, add, files } = rig();
    const a = add("Oversold", { price:-5, stock:-3 });
    await ops.setSelection({ ids:[a] });
    await ops.buildExport({ city:"Harare", currency:"USD", images:{} });
    const l = JSON.parse(files.get("Boka").text).listings[0];
    assert.strictEqual(l.price, 0);
    assert.strictEqual(l.stock_quantity, 0);
  });

  await t("the layer can't change names, prices or add products: only photos of selected products get in", async ()=>{
    const { ops, add, files } = rig();
    const a = add("A", { price:5 }), b = add("B", { price:9 });
    await ops.setSelection({ ids:[a] });
    await ops.buildExport({ city:"Harare", currency:"USD",
      images:{ [a]:WEBP, [b]:WEBP }, listings:[{ product_name:"Hacked", price:0 }], price:0 });
    const doc = JSON.parse(files.get("Boka").text);
    assert.deepStrictEqual(doc.listings.map(l=>[l.product_name, l.price]), [["A", 5]]);
    assert.strictEqual(doc.listings[0].image_webp, WEBP);
  });

  await t("photos that aren't small base64 WebP data URIs are dropped, not exported", async ()=>{
    const { api, ops, add, files } = rig();
    const ids = [add("png"), add("js"), add("huge"), add("junk"), add("ok")];
    await ops.setSelection({ ids });
    await ops.buildExport({ city:"Harare", currency:"USD", images:{
      [ids[0]]:"data:image/png;base64,iVBORw0KGgo=",
      [ids[1]]:"javascript:alert(1)",
      [ids[2]]:"data:image/webp;base64,"+"A".repeat(200000),
      [ids[3]]:"data:image/webp;base64,<script>",
      [ids[4]]:WEBP } });
    const doc = JSON.parse(files.get("Boka").text);
    assert.deepStrictEqual(doc.listings.map(l=>!!l.image_webp), [false,false,false,false,true]);
    assert.strictEqual(api.marketValidImage(WEBP), true);
  });

  await t("buildExport refuses bad city/currency, empty selection, missing identity — without using an MKT number", async ()=>{
    const { api, ops, add } = rig();
    const a = add("A");
    await assert.rejects(()=>ops.buildExport({ city:"Harare", currency:"USD" }), /Choose at least one product/);
    await ops.setSelection({ ids:[a] });
    await assert.rejects(()=>ops.buildExport({ city:"", currency:"USD" }), /city or town/);
    await assert.rejects(()=>ops.buildExport({ city:"Harare", currency:"US$" }), /3-letter code/);
    await assert.rejects(()=>ops.buildExport({ city:"Harare", currency:"DOLLARS" }), /3-letter code/);
    api.setSetting("install_id","");
    await assert.rejects(()=>ops.buildExport({ city:"Harare", currency:"USD" }), /install ID/);
    api.setSetting("install_id","X"); api.setSetting("shop_name","");
    await assert.rejects(()=>ops.buildExport({ city:"Harare", currency:"USD" }), /shop name/);
    api.setSetting("shop_name","Boka");
    const st = await ops.buildExport({ city:"Harare", currency:"USD" });
    assert.strictEqual(st.exportNo, "MKT0001");
  });

  await t("each export gets the next MKT number", async ()=>{
    const { ops, add } = rig();
    await ops.setSelection({ ids:[add("A")] });
    assert.strictEqual((await ops.buildExport({ city:"Harare", currency:"USD" })).exportNo, "MKT0001");
    assert.strictEqual((await ops.buildExport({ city:"Harare", currency:"USD" })).exportNo, "MKT0002");
  });

  // ---------------- status ----------------
  await t("status: not_exported -> exported (timestamp) -> sent (timestamp) -> new export starts over", async ()=>{
    const { ops, add } = rig();
    assert.deepStrictEqual(plain(ops.getStatus()), { state:"not_exported" });
    await assert.rejects(()=>ops.markSent(), /no exported file/);
    await ops.setSelection({ ids:[add("A", { image:WEBP }), add("B")] });
    const ex = await ops.buildExport({ city:"Harare", currency:"USD", images:{} });
    assert.strictEqual(ex.state, "exported");
    assert.ok(!isNaN(Date.parse(ex.exportedTs)));
    assert.strictEqual(ex.sentTs, "");
    assert.strictEqual(ex.productCount, 2);
    const sent = await ops.markSent();
    assert.strictEqual(sent.state, "sent");
    assert.ok(!isNaN(Date.parse(sent.sentTs)));
    assert.strictEqual(Date.parse(sent.expiresTs) - Date.parse(sent.sentTs), 7*86400000);
    assert.strictEqual(sent.expiring, false);
    const again = await ops.markSent(); // idempotent: the first sent time stands
    assert.strictEqual(again.sentTs, sent.sentTs);
    const next = await ops.buildExport({ city:"Harare", currency:"USD" });
    assert.strictEqual(next.state, "exported");
    assert.strictEqual(next.exportNo, "MKT0002");
  });

  await t("7 days after it was marked sent, status reports expiring", async ()=>{
    const { api, ops, add } = rig();
    await ops.setSelection({ ids:[add("A")] });
    await ops.buildExport({ city:"Harare", currency:"USD" });
    await ops.markSent();
    const day = 86400000;
    api.run("UPDATE market_exports SET sent_ts=?", [new Date(Date.now() - 7*day + 60000).toISOString()]);
    assert.strictEqual(ops.getStatus().expiring, false);
    api.run("UPDATE market_exports SET sent_ts=?", [new Date(Date.now() - 7*day).toISOString()]);
    assert.strictEqual(ops.getStatus().expiring, true);
  });

  await t("status is per branch", async ()=>{
    const { api, ops, add } = rig();
    await ops.setSelection({ ids:[add("A")] });
    await ops.buildExport({ city:"Harare", currency:"USD" });
    api.setSetting("branch_name","Harare");
    assert.strictEqual(ops.getStatus().state, "not_exported");
  });

  // ---------------- WhatsApp handoff ----------------
  await t("shareExport sends the stored .scl through shareDocFile to Digital Commerce's number", async ()=>{
    const { ops, add, shares, files } = rig();
    await assert.rejects(()=>ops.shareExport(), /Prepare the file first/);
    await ops.setSelection({ ids:[add("A")] });
    const st = await ops.buildExport({ city:"Harare", currency:"USD" });
    const r = await ops.shareExport();
    assert.deepStrictEqual(plain(r), { method:"downloaded", path:"" });
    assert.strictEqual(shares.length, 1);
    const o = shares[0];
    assert.strictEqual(o.fileName, st.fileName);
    assert.strictEqual(o.text, files.get("Boka").text);
    assert.strictEqual(o.folder, "Marketing");
    assert.strictEqual(o.phone, "+263789487287");
    assert.match(o.shareText, /MKT0001/);
    assert.strictEqual(ops.getStatus().state, "exported", "sharing alone never marks it sent");
  });

  await t("shareExport refuses a file that's no longer on the device", async ()=>{
    const { ops, add, files } = rig();
    await ops.setSelection({ ids:[add("A")] });
    await ops.buildExport({ city:"Harare", currency:"USD" });
    files.clear();
    await assert.rejects(()=>ops.shareExport(), /isn't on this device any more/);
  });

  await t("openWhatsAppChat opens a wa.me chat with Digital Commerce", async ()=>{
    const { ops, add, opened } = rig();
    await ops.setSelection({ ids:[add("A")] });
    await ops.buildExport({ city:"Harare", currency:"USD" });
    ops.openWhatsAppChat();
    assert.strictEqual(opened.length, 1);
    assert.match(opened[0], /^https:\/\/wa\.me\/263789487287\?text=/);
    assert.match(decodeURIComponent(opened[0]), /MKT0001/);
  });

  await t("the bridge has no op that writes products or talks to the network", async ()=>{
    const { ops } = rig();
    assert.deepStrictEqual(plain(Object.keys(ops).sort()), ["buildExport","context","getExportSetup","getProductImage","getSelection",
      "getStatus","listProducts","markSent","openWhatsAppChat","setSelection","shareExport"]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed?1:0);
})();
