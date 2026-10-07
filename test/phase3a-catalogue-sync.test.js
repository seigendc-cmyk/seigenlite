// Run: node --no-warnings test/phase3a-catalogue-sync.test.js
// Multi-terminal Phase 3a (docs/multi-terminal/phase3a-design.md): product
// catalogue sync, end to end. Each device is the REAL app source over SQLite
// (test/harness.js); "Digital Commerce" is the REAL server SQL (live stub +
// Phase 1 + Phase 2 + the catalogue migration) in an in-memory PGlite, called
// as role anon exactly as PostgREST would. Nothing reaches the live project.
"use strict";
process.env.TZ = "UTC";   // dates here are built as UTC (TODAY = toISOString); test/business-day.test.js covers a real time zone
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeApp } = require("./harness");
const { LIVE_STUB } = require("../supabase/tests/live-stub");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
const plain = (x)=>JSON.parse(JSON.stringify(x));
const TODAY = new Date().toISOString().slice(0,10);
const PIC = "data:image/webp;base64,"+Buffer.from("thumb-"+"y".repeat(300)).toString("base64");
const PIC2 = "data:image/webp;base64,"+Buffer.from("thumb2-"+"z".repeat(500)).toString("base64");
const MIG = (f)=>fs.readFileSync(path.join(__dirname,"..","supabase",f),"utf8");

// ---- the server ----
let pg, OFFLINE = false, calls = [];
const CASTS = { p_rows:"::jsonb", p_uids:"::text[]", p_branch_id:"::uuid", p_terminal_id:"::uuid", p_cursor:"::bigint", p_limit:"::integer", p_active:"::boolean" };
async function serverRpc(name, body){
  calls.push(name);
  if(OFFLINE) return { ok:false, reason:"offline" };
  const keys = Object.keys(body);
  const vals = keys.map(k=> k==="p_rows"? JSON.stringify(body[k]) : k==="p_uids"? "{"+body[k].join(",")+"}" : body[k]);
  const sql = `select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}${CASTS[k]||""}`).join(",")})::json j`;
  await pg.exec("set role anon");
  try{
    const data = (await pg.query(sql, vals)).rows[0].j;
    if(data && data.error) return { ok:false, reason:"refused", code:data.error, data };
    return { ok:true, data };
  }catch(e){ return { ok:false, reason:"rejected", message:e.message }; }
  finally{ await pg.exec("reset role"); }
}
const sq = async (sql, p)=> (await pg.query(sql, p)).rows;

// ---- devices ----
function device(o){
  const A = makeApp(Object.assign({ setup_complete:"1", shop_name:"Gentronix", secret_phrase:"Gold Leaf 42", currency:"$" }, o));
  A.hook("terminalRpc", serverRpc);
  A.hook("getThumb", async (p)=> p && p.image? p.image : null);   // a thumbnail = the picture itself here (no canvas in Node)
  A.hook("downloadDb", ()=>{ A.backups = (A.backups||0)+1; });
  A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999',?,1,'x')",[o.branch_name]);
  return A;
}
function addProduct(app, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [o.name, o.price==null?5:o.price, o.stock==null?10:o.stock, 3, o.sku||"", o.branch||app.api.currentBranch(), o.image||"", o.cost==null?2:o.cost, "2026-01-01", o.description||""]);
  return app.api.one("SELECT * FROM products WHERE name=? AND branch=?",[o.name, o.branch||app.api.currentBranch()]);
}
const P = (app, sku)=> app.api.one("SELECT * FROM products WHERE lower(sku)=lower(?) AND branch=?",[sku, app.api.currentBranch()]);
const stocks = (app)=> JSON.stringify(app.api.all("SELECT id, stock FROM products ORDER BY id"));
async function join(app, code){
  const r = await app.api.joinBusiness({ phrase:"Gold Leaf 42", code, label:"till", devicePhrase:app.api.getSetting("secret_phrase",""), expectedBranchName:app.api.getSetting("branch_name","")||null });
  assert.ok(r.ok, JSON.stringify(r));
  app.api.setSetting("branch_name", r.data.branch_name); app.api.setSetting("branch_type", r.data.is_main? "main" : "remote");
  return r.data;
}
function sell(app, product, qty){
  app.api.setCart([{ product_id:product.id, name:product.name, price:product.price, qty, stock:product.stock }]);
  app.hook("printReceipt", ()=>{});
  app.api.completeSale("Cash");
}

(async()=>{
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  pg = new PGlite({ extensions:{ pgcrypto } });
  await pg.exec(LIVE_STUB);
  await pg.exec(MIG("migrations/20261004120000_multi_terminal_identity.sql"));
  await pg.exec(MIG("migrations/20261004180000_multi_terminal_phase2.sql"));
  await pg.exec(MIG("migrations/20261006120000_catalogue_sync.sql"));

  // Main T1 (Harare CBD) with products; T2 joins main later; Murehwa (remote, has its
  // own products from catalogue files); Mutare (remote, empty); an unregistered shop.
  const M1 = device({ branch_name:"Harare CBD", branch_type:"main", install_id:"MAIN" });
  addProduct(M1,{ name:"Rice 2kg", sku:"RICE2", price:10.5, cost:7, image:PIC });
  addProduct(M1,{ name:"Sugar 1kg", sku:"SUG1", price:4 });
  addProduct(M1,{ name:"Salt 500g", sku:"SALT", price:1.2 });
  addProduct(M1,{ name:"Loose sweets", sku:"", price:0.5 });
  addProduct(M1,{ name:"Bulawayo snapshot", sku:"RICE2", branch:"Bulawayo", price:99 });       // a merged other-branch row
  M1.api.migrate(M1.db);

  await t("unregistered: no sync, nothing called, zero-stock block and hard delete unchanged", async ()=>{
    const U = makeApp({ branch_name:"Solo", branch_type:"main", setup_complete:"1" });
    U.hook("terminalRpc", async ()=>{ throw new Error("must not be called"); });
    const r = await U.api.catalogueSyncNow({});
    assert.strictEqual(r.ok, false); assert.match(r.message, /Register this device first/);
    assert.strictEqual(U.api.tillStockPending(), false);
    const p = addProduct(U,{ name:"Zero", sku:"Z", stock:0 });
    U.api.addToCart(p); assert.strictEqual(U.api.getCart().length, 0, "out of stock can't be added");
    assert.strictEqual(U.api.catalogueSyncCardHtml(), "");
    assert.strictEqual(U.api.catalogueSyncStatus().registered, false);
  });

  let reg;
  await t("main registers; first sync shows a report before anything is sent, listing products with no code", async ()=>{
    const r = await M1.api.registerMainBranch("Front"); assert.ok(r.ok, JSON.stringify(r)); reg = r.data;
    calls = [];
    const s = await M1.api.catalogueSyncNow({});
    assert.strictEqual(s.needsReport, true);
    const p = plain(s.plan);
    assert.strictEqual(p.mainTill, true); assert.strictEqual(p.serverCount, 0); assert.strictEqual(p.upload.length, 4, "own branch only: the Bulawayo snapshot is excluded");
    assert.deepStrictEqual(p.noCode.map(x=>x.name), ["Loose sweets"]);
    assert.deepStrictEqual(plain(M1.api.catProductsWithoutCode()).map(x=>x.name), ["Loose sweets"]);
    assert.ok(!calls.includes("cl_catalogue_push"), "nothing pushed before the report is applied");
    assert.strictEqual((await sq("select count(*)::int n from cl_catalogue_products"))[0].n, 0);
  });

  await t("main applies the first sync: its catalogue (own branch, with the picture) is on the server", async ()=>{
    await M1.api.catApplyBaseline({});
    const s = await M1.api.catalogueSyncNow({});
    assert.ok(s.ok, s.message);
    const rows = await sq("select code, name, price::float price, cost::float cost, image_hash, image_bytes from cl_catalogue_products order by name");
    assert.deepStrictEqual(rows.map(r=>r.name), ["Loose sweets","Rice 2kg","Salt 500g","Sugar 1kg"]);
    const rice = rows.find(r=>r.code==="RICE2");
    assert.strictEqual(rice.price, 10.5); assert.strictEqual(rice.cost, 7); assert.strictEqual(rice.image_bytes, PIC.length);
    assert.strictEqual((await sq("select data from cl_catalogue_images"))[0].data, PIC);
    assert.ok(M1.api.all("SELECT * FROM products WHERE branch='Harare CBD'").every(p=>p.cat_uid===p.uid && p.cat_dirty===0));
    assert.strictEqual(M1.api.one("SELECT cat_uid FROM products WHERE branch='Bulawayo'").cat_uid, null, "the snapshot is never linked");
    assert.match(M1.api.catStatusLine(M1.api.catalogueSyncStatus()), /^Catalogue synced .* · 4 products$/);
    assert.match(M1.api.catalogueSyncCardHtml(), /1 product has no code: <span class="cat-nocode">Loose sweets/);
  });

  let M2;
  await t("a new till at main pulls everything at once (no report: nothing local), stock 0, with cost", async ()=>{
    const code = (await M1.api.issueJoinCode({ branchId:reg.branch_id })).data.code;
    M2 = device({ branch_name:"", branch_type:"main", install_id:"TIL2" });
    await join(M2, code);
    const s = await M2.api.catalogueSyncNow({});
    assert.ok(s.ok, s.message); assert.ok(!s.needsReport);
    const rice = P(M2,"RICE2");
    assert.strictEqual(rice.stock, 0); assert.strictEqual(rice.price, 10.5); assert.strictEqual(rice.cost, 7, "main-branch tills get cost");
    assert.strictEqual(rice.image, "", "pictures are never stored in SQLite");
    assert.strictEqual(M2.api.all("SELECT * FROM products").length, 4);
    assert.strictEqual(M2.api.one("SELECT SUM(qty_delta) s FROM stock_movements").s, null, "no stock movement for pulled products");
  });

  await t("pictures: off on phones by default; the estimate is shown before the first download; stored outside SQLite", async ()=>{
    assert.strictEqual(M2.api.catPicsEnabled(), false, "harness = phone build (no desktop Sales screen)");
    let r = await M2.api.catDownloadPictures(null, false); assert.strictEqual(r.fetched, 0); assert.strictEqual(r.prompt, undefined);
    M2.api.setSetting("cat_pics","1");
    r = await M2.api.catDownloadPictures(null, false);
    assert.deepStrictEqual(plain(r.prompt), { count:1, bytes:PIC.length }, "estimated size before the first download");
    assert.match(M2.api.catalogueSyncCardHtml(), /Download 1 product picture \(about 1 KB\)\?/);
    r = await M2.api.catDownloadPictures(null, true);
    assert.strictEqual(r.fetched, 1);
    const rice = P(M2,"RICE2");
    assert.strictEqual(await M2.api.catPicGet(rice.cat_uid+"|"+rice.image_hash), PIC);
    assert.match(M2.api.catPicHtml(rice, 'class="prod-thumb"', "PH"), /data-cat-pic="[0-9a-f]{32}\|[0-9a-f]{64}"/);
    assert.strictEqual(M2.api.catPicHtml(P(M2,"SUG1"), 'class="x"', "PH"), "PH");
    assert.strictEqual(M2.api.all("SELECT * FROM products WHERE image<>''").length, 0, "still nothing in SQLite");
    r = await M2.api.catDownloadPictures(null, false);
    assert.strictEqual(r.fetched, 0, "only new or changed pictures are downloaded");
  });

  let R, mur;
  await t("an existing remote (own products) gets a first-sync report: matches by code, remote-only kept, nothing changed yet", async ()=>{
    R = device({ branch_name:"Murehwa", branch_type:"remote", install_id:"MURE", price_mode:"follow_main" });
    addProduct(R,{ name:"Rice 2 kg bag", sku:"rice2", price:11, cost:0, stock:6 });       // name and price differ
    addProduct(R,{ name:"Sugar 1kg", sku:"SUG1", price:4, cost:0, stock:3 });
    addProduct(R,{ name:"Local bread", sku:"BRD", price:1, cost:0, stock:9 });           // not at main
    R.api.migrate(R.db);
    const code = (await M1.api.issueJoinCode({ newBranchName:"Murehwa" })).data.code;
    mur = await join(R, code);
    const before = stocks(R);
    const s = await R.api.catalogueSyncNow({});
    assert.strictEqual(s.needsReport, true);
    const p = plain(s.plan);
    assert.strictEqual(p.matched.length, 2);
    assert.deepStrictEqual(p.nameChanges.map(c=>[c.old,c.new]), [["Rice 2 kg bag","Rice 2kg"]]);
    assert.deepStrictEqual(p.priceChanges.map(c=>[c.code,c.old,c.new]), [["RICE2",11,10.5]]);
    assert.deepStrictEqual(p.added.map(a=>a.name).sort(), ["Loose sweets","Salt 500g"]);
    assert.deepStrictEqual(p.localOnly.map(a=>a.name), ["Local bread"]);
    assert.strictEqual(stocks(R), before); assert.strictEqual(P(R,"RICE2").name, "Rice 2 kg bag", "nothing applied before the OK");
  });

  await t("remote applies: backup first; names/prices follow main; remote-only kept unlinked; stock untouched; no cost", async ()=>{
    const before = R.api.all("SELECT name, stock FROM products ORDER BY id");
    await R.api.catApplyBaseline({});
    assert.strictEqual(R.backups||0, 0, "catApplyBaseline itself never downloads; the report screen does (checked in the e2e)");
    const s = await R.api.catalogueSyncNow({}); assert.ok(s.ok, s.message);
    assert.strictEqual(P(R,"RICE2").name, "Rice 2kg"); assert.strictEqual(P(R,"RICE2").price, 10.5);
    assert.strictEqual(P(R,"BRD").cat_uid, null); assert.strictEqual(P(R,"BRD").name, "Local bread");
    assert.deepStrictEqual(plain(R.api.all("SELECT id, stock FROM products WHERE id IN (SELECT id FROM products ORDER BY id LIMIT 3) ORDER BY id")).map(r=>r.stock), plain(before).map(b=>b.stock), "stock of every existing product untouched");
    assert.deepStrictEqual(plain(R.api.all("SELECT sku, stock FROM products WHERE lower(sku) IN ('rice2','sug1','brd') ORDER BY sku")), [{sku:"BRD",stock:9},{sku:"RICE2",stock:6},{sku:"SUG1",stock:3}]);
    assert.strictEqual(P(R,"SALT").stock, 0); assert.strictEqual(P(R,"SALT").cost, 0, "no cost to remote tills");
    assert.strictEqual(R.api.catalogueSyncStatus().baselineDone, true);
    assert.match(R.api.catalogueSyncCardHtml(), /First sync report/);
  });

  await t("edit, re-price and deactivate on main reach the tills after a pull; stock never changes", async ()=>{
    const sugar = P(M1,"SUG1"), salt = P(M1,"SALT");
    M1.api.run("UPDATE products SET name='Sugar 1kg white', price=4.4 WHERE id=?",[sugar.id]);
    M1.api.run("UPDATE products SET active=0 WHERE id=?",[salt.id]);
    M1.api.moveStock({ productId:sugar.id, delta:5, kind:"restock" });                // a stock change is not a catalogue change
    assert.strictEqual(M1.api.one("SELECT COUNT(*) c FROM products WHERE cat_dirty=1").c, 2);
    const r1 = await M1.api.catalogueSyncNow({}); assert.ok(r1.ok); assert.strictEqual(r1.sent, 2);
    const rs = stocks(R), m2s = stocks(M2);
    const r2 = await R.api.catalogueSyncNow({}); assert.ok(r2.ok); assert.ok(r2.changed>=2);
    await M2.api.catalogueSyncNow({});
    assert.strictEqual(P(R,"SUG1").name, "Sugar 1kg white"); assert.strictEqual(P(R,"SUG1").price, 4.4);
    assert.strictEqual(P(R,"SALT").active, 0);
    assert.ok(!R.api.searchProducts("salt").length, "a deactivated product is not offered for sale");
    assert.strictEqual(stocks(R), rs); assert.strictEqual(stocks(M2), m2s);
    assert.strictEqual(P(M2,"SUG1").name, "Sugar 1kg white");
  });

  let MU;
  await t("a branch price (main sets) reaches that branch only; other branches and main keep main's price", async ()=>{
    const code = (await M1.api.issueJoinCode({ newBranchName:"Mutare" })).data.code;
    MU = device({ branch_name:"Mutare", branch_type:"remote", install_id:"MUTA" });
    await join(MU, code);
    await MU.api.catalogueSyncNow({});
    ["Murehwa","Mutare"].forEach(n=>M1.api.run("INSERT OR IGNORE INTO branch_register(name,whatsapp) VALUES(?,'')",[n]));
    M1.api.setBranchPriceMode("Murehwa", "main_sets");
    M1.api.setBranchPrice("Murehwa", "SUG1", "5.25");
    assert.strictEqual(M1.api.one("SELECT COUNT(*) c FROM cat_outbox").c, 2, "a policy and a price queued");
    const r = await M1.api.catalogueSyncNow({}); assert.ok(r.ok, r.message);
    assert.strictEqual(M1.api.one("SELECT COUNT(*) c FROM cat_outbox").c, 0);
    await R.api.catalogueSyncNow({}); await MU.api.catalogueSyncNow({}); await M2.api.catalogueSyncNow({});
    assert.strictEqual(R.api.getSetting("price_mode"), "main_sets");
    assert.strictEqual(P(R,"SUG1").price, 5.25, "Murehwa sells at its branch price");
    assert.strictEqual(P(MU,"SUG1").price, 4.4, "Mutare unaffected");
    assert.strictEqual(P(M2,"SUG1").price, 4.4, "main unaffected");
    assert.strictEqual(P(R,"RICE2").price, 10.5, "products without a branch price keep main's");
    M1.api.run("UPDATE products SET price=4.6 WHERE id=?",[P(M1,"SUG1").id]);
    await M1.api.catalogueSyncNow({}); await R.api.catalogueSyncNow({});
    assert.strictEqual(P(R,"SUG1").price, 5.25, "main's re-price doesn't override Murehwa's branch price");
    M1.api.setBranchPrice("Murehwa", "SUG1", "");
    await M1.api.catalogueSyncNow({}); await R.api.catalogueSyncNow({});
    assert.strictEqual(P(R,"SUG1").price, 4.6, "removing the branch price falls back to main's");
  });

  await t("branch_edits: the branch's Admin sets its own price; it is sent; another branch can't", async ()=>{
    M1.api.setBranchPriceMode("Murehwa", "branch_edits");
    await M1.api.catalogueSyncNow({}); await R.api.catalogueSyncNow({});
    assert.strictEqual(R.api.getSetting("price_mode"), "branch_edits");
    const res = R.api.applyRemotePriceEdit({ productId:P(R,"RICE2").id, price:"12", passcode:"9999" });
    assert.strictEqual(res.new, 12);
    const r = await R.api.catalogueSyncNow({}); assert.ok(r.ok, r.message);
    assert.strictEqual(P(R,"RICE2").price, 12, "kept after the pull");
    const row = (await sq("select price::float p from cl_branch_prices bp join cl_branches b on b.id=bp.branch_id where b.name='Murehwa' and bp.product_uid=$1",[P(R,"RICE2").cat_uid]))[0];
    assert.strictEqual(row.p, 12, "on the server as Murehwa's price");
    const other = await serverRpc("cl_branch_price_push", { p_install_id:"MUTA", p_secret_phrase:"Gold Leaf 42", p_device_key:MU.api.deviceKey(),
      p_rows:[{ branch_id:mur.branch_id, product_uid:P(R,"RICE2").cat_uid, price:0.5, op_id:"b".repeat(32) }] });
    assert.strictEqual(other.data.results[0].reason, "NOT_ALLOWED", "Mutare can't set Murehwa's price");
  });

  await t("a remote till can't push products: refused by the server, not just hidden", async ()=>{
    const rice = P(R,"RICE2");
    const r = await serverRpc("cl_catalogue_push", { p_install_id:"MURE", p_secret_phrase:"Gold Leaf 42", p_device_key:R.api.deviceKey(),
      p_rows:[{ uid:rice.cat_uid, op_id:"a".repeat(32), code:"RICE2", name:"Hacked", price:0.01, active:true }] });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, "NOT_MAIN");
    R.api.run("UPDATE products SET name='Edited at remote' WHERE id=?",[rice.id]);
    assert.strictEqual(R.api.one("SELECT cat_dirty FROM products WHERE id=?",[rice.id]).cat_dirty, 0, "a remote edit is never queued");
    assert.strictEqual((await sq("select name from cl_catalogue_products where product_uid=$1",[rice.cat_uid]))[0].name, "Rice 2kg");
  });

  await t("offline: the till sells from its local catalogue; the queued change goes once online, with no duplicate", async ()=>{
    M1.api.startShift("0", new Date(`${TODAY}T06:00:00Z`));
    const rice = P(M1,"RICE2");
    M1.api.run("UPDATE products SET name='Rice 2kg (new bag)' WHERE id=?",[rice.id]);
    OFFLINE = true;
    const r = await M1.api.catalogueSyncNow({});
    assert.strictEqual(r.ok, false); assert.match(r.message, /You're offline\. .*Selling isn't affected/);
    sell(M1, P(M1,"RICE2"), 1);
    assert.strictEqual(P(M1,"RICE2").cat_dirty, 1, "still waiting");
    OFFLINE = false;
    const op = P(M1,"RICE2").cat_op;
    assert.ok((await M1.api.catalogueSyncNow({})).ok);
    const seq1 = (await sq("select change_seq s from cl_catalogue_products where product_uid=$1",[rice.cat_uid]))[0].s;
    // the answer was "lost": the till sends the same change again
    M1.api.run("UPDATE products SET cat_dirty=1, cat_op=? WHERE id=?",[op, rice.id]);
    const again = await M1.api.catPushProducts();
    assert.strictEqual(again.sent, 1);
    assert.strictEqual((await sq("select change_seq s from cl_catalogue_products where product_uid=$1",[rice.cat_uid]))[0].s, seq1, "a replay changes nothing on the server");
    assert.strictEqual((await sq("select name from cl_catalogue_products where product_uid=$1",[rice.cat_uid]))[0].name, "Rice 2kg (new bag)");
  });

  await t("no till ever sells below zero, registered included; a joined till (T2) shows the stock note", async ()=>{
    M2.api.startShift("0", new Date(`${TODAY}T06:00:00Z`));
    const sugar = P(M2,"SUG1");
    assert.strictEqual(sugar.stock, 0);
    M2.api.setCart([]); M2.api.addToCart(sugar);
    assert.strictEqual(M2.api.getCart().length, 0, "a registered till can't add a product it has no stock of");
    M2.api.moveStock({ productId:sugar.id, delta:1, kind:"restock" });
    M2.api.addToCart(P(M2,"SUG1")); M2.api.changeQty(sugar.id, 1); M2.api.changeQty(sugar.id, 1);
    assert.strictEqual(M2.api.getCart()[0].qty, 1, "capped at the stock it has");
    M2.hook("printReceipt", ()=>{}); M2.api.completeSale("Cash");
    assert.strictEqual(P(M2,"SUG1").stock, 0, "never below zero");
    assert.strictEqual(M2.api.tillStockPending(), true, "T2 at main with no stock left: the no-stock note");
    assert.match(M2.api.tillStockNoteHtml(), /This till has no stock yet\. Receive stock on this till, or ask the main till to start shared stock for the branch\./);
    assert.strictEqual(M1.api.tillStockPending(), false, "T1 keeps its own stock");
    assert.strictEqual(R.api.tillStockPending(), false, "a single-till branch (Murehwa T1) keeps its own stock");
    // the below-zero indicator stays, read-only, for older data
    M2.api.run("UPDATE products SET stock=-2 WHERE id=?",[sugar.id]);
    assert.match(M2.api.productsTableHtml([P(M2,"SUG1")], false), /-2 below zero/);
    M2.api.run("UPDATE products SET stock=0 WHERE id=?",[sugar.id]);
  });

  await t("two main tills: the later arrival wins and the other one is told", async ()=>{
    await M2.api.catalogueSyncNow({});
    M1.api.run("UPDATE products SET price=4.9 WHERE id=?",[P(M1,"SUG1").id]);
    await M1.api.catalogueSyncNow({});
    M2.api.run("UPDATE products SET price=4.8 WHERE id=?",[P(M2,"SUG1").id]);           // based on an older version
    const r = await M2.api.catalogueSyncNow({});
    assert.strictEqual(r.overwrote, 1);
    assert.match(M2.api.catalogueSyncCardHtml(), /Your change to Sugar 1kg white replaced a newer change from another till\./);
    await M1.api.catalogueSyncNow({});
    assert.strictEqual(P(M1,"SUG1").price, 4.8, "everyone converges on the last arrival");
  });

  await t("a pull never overwrites a main till's own unsent edit", async ()=>{
    M1.api.run("UPDATE products SET price=7.77 WHERE id=?",[P(M1,"SALT").id]);
    M2.api.run("UPDATE products SET description='from T2' WHERE id=?",[P(M2,"SALT").id]);
    await M2.api.catalogueSyncNow({});
    OFFLINE = false;
    const page = await M1.api.catPull();
    assert.ok(page.ok); assert.ok(page.total.kept>=1);
    assert.strictEqual(P(M1,"SALT").price, 7.77);
  });

  await t("main: duplicate codes are refused and listed; products without codes keep showing until fixed", async ()=>{
    addProduct(M1,{ name:"Rice again", sku:"rice2", price:3 });
    const r = await M1.api.catalogueSyncNow({});
    assert.strictEqual(r.refused, 1);
    assert.match(M1.api.catalogueSyncCardHtml(), /1 product not sent: Rice again \(code already used\)/);
  });

  await t("registered remote: no catalogue files, no product creation by legacy transfer; main hides Build catalogue for synced branches", async ()=>{
    const pre = await R.api.catalogueImportPreflight(new Uint8Array(Buffer.from("{}")));
    assert.strictEqual(pre.ok, false); assert.match(pre.message, /Use Sync now/);
    R.api.run("INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,sku,qty,note,user,status) VALUES('t','Old','Murehwa','Mystery','MYS',3,'','u','Dispatched')");
    const tid = R.api.one("SELECT id FROM stock_transfers WHERE sku='MYS'").id;
    R.api.receiveTransfer(tid);
    assert.strictEqual(P(R,"MYS"), null, "no product created");
    assert.strictEqual(R.api.one("SELECT status FROM stock_transfers WHERE id=?",[tid]).status, "Dispatched");
    assert.ok(M1.api.catBranchOnServer("Murehwa"));
    assert.ok(!/data-reg-cat=/.test(M1.api.catalogueRegisterExtras(M1.api.registerRow("Murehwa"))));
  });

  await t("a deactivated till is told so and nothing changes", async ()=>{
    await serverRpc("cl_terminal_set_active", { p_install_id:"MAIN", p_secret_phrase:"Gold Leaf 42", p_device_key:M1.api.deviceKey(), p_terminal_id:MU.api.getSetting("terminal_id"), p_active:false });
    const r = await MU.api.catalogueSyncNow({});
    assert.strictEqual(r.ok, false); assert.match(r.message, /deactivated by your main branch/);
    assert.strictEqual(MU.api.getSetting("terminal_inactive"), "1");
    assert.ok(MU.api.searchProducts("").length>0, "it still sells from its local catalogue");
  });

  await t("wrong phrase and server errors are plain English", async ()=>{
    assert.match(R.api.catProblemText({ ok:false, reason:"rejected", message:"Shop secret phrase does not match this install" }), /activation phrase doesn't match/);
    assert.match(R.api.catProblemText({ ok:false, reason:"rejected", message:"boom" }), /couldn't sync the catalogue \(boom\)\. It will try again\./);
    assert.match(R.api.catProblemText({ ok:false, reason:"network" }), /Couldn't reach Digital Commerce/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})();
