// Run: node --no-warnings test/phase3b-shared-stock.test.js
// Multi-terminal Phase 3b (docs/multi-terminal/phase3b-design.md): shared
// branch stock + offline allowance, end to end. Each device is the REAL app
// source over SQLite (test/harness.js); "Digital Commerce" is the REAL server
// SQL (live stub + Phase 1 + 2 + 3a + 3b) in an in-memory PGlite, called as
// role anon exactly as PostgREST would. Nothing reaches the live project.
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
const MIG = (f)=>fs.readFileSync(path.join(__dirname,"..","supabase",f),"utf8");

// ---- the server ----
let pg, OFFLINE_ = false, LOSE_ANSWER = null;
const APPS = [];
// offline = the network is down for every device (navigator.onLine) and the server is unreachable
const offline = (on)=>{ OFFLINE_ = on; APPS.forEach(a=>{ a.ctx.navigator.onLine = !on; if(!on) a.api.setSetting("stock_reach","ok"); }); };      // LOSE_ANSWER: an RPC name whose answer never arrives (the server still runs it)
const CASTS = { p_rows:"::jsonb", p_lines:"::jsonb", p_moves:"::jsonb", p_sales:"::jsonb", p_counts:"::jsonb", p_uids:"::text[]", p_branch_id:"::uuid",
  p_terminal_id:"::uuid", p_cursor:"::bigint", p_limit:"::integer", p_active:"::boolean" };
const JSONB = ["p_rows","p_lines","p_moves","p_sales","p_counts"];
async function serverRpc(name, body){
  if(OFFLINE_) return { ok:false, reason:"offline" };
  const keys = Object.keys(body);
  const vals = keys.map(k=> JSONB.includes(k)? JSON.stringify(body[k]) : k==="p_uids"? "{"+body[k].join(",")+"}" : body[k]);
  const sql = `select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}${CASTS[k]||""}`).join(",")})::json j`;
  await pg.exec("set role anon");
  let out;
  try{
    const data = (await pg.query(sql, vals)).rows[0].j;
    out = (data && data.error)? { ok:false, reason:"refused", code:data.error, data } : { ok:true, data };
  }catch(e){ out = { ok:false, reason:"rejected", message:e.message }; }
  finally{ await pg.exec("reset role"); }
  if(LOSE_ANSWER===name){ LOSE_ANSWER = null; return { ok:false, reason:"network" }; }
  return out;
}
const sq = async (sql, p)=> (await pg.query(sql, p)).rows;

// ---- devices ----
const ALERTS = [];
function device(o){
  const A = makeApp(Object.assign({ setup_complete:"1", shop_name:"Gentronix", secret_phrase:"Gold Leaf 42", currency:"$" }, o));
  A.hook("terminalRpc", serverRpc);
  A.hook("getThumb", async ()=>null);
  A.hook("downloadDb", ()=>{});
  A.hook("alert", (m)=>{ ALERTS.push(String(m)); });
  A.hook("printReceipt", ()=>{});
  A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999',?,1,'x')",[o.branch_name||""]);
  APPS.push(A);
  return A;
}
function addProduct(app, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [o.name, o.price==null?5:o.price, o.stock==null?10:o.stock, 3, o.sku||"", app.api.currentBranch(), "", 2, "2026-01-01", ""]);
}
const P = (app, sku)=> app.api.one("SELECT * FROM products WHERE lower(sku)=lower(?) AND branch=?",[sku, app.api.currentBranch()]);
async function join(app, code){
  const r = await app.api.joinBusiness({ phrase:"Gold Leaf 42", code, label:"till", devicePhrase:app.api.getSetting("secret_phrase",""), expectedBranchName:app.api.getSetting("branch_name","")||null });
  assert.ok(r.ok, JSON.stringify(r));
  app.api.setSetting("branch_name", r.data.branch_name); app.api.setSetting("branch_type", r.data.is_main? "main" : "remote");
  return r.data;
}
async function sell(app, sku, qty){
  const p = P(app, sku);
  app.api.setCart([{ product_id:p.id, name:p.name, price:p.price, qty, stock:app.api.sellableNow(p) }]);
  ALERTS.length = 0;
  const r = await app.api.completeSale("Cash");
  return r;
}
const server = async (sku)=> (await sq(`select bs.total, bs.available from cl_branch_stock bs join cl_catalogue_products c on c.product_uid=bs.product_uid and c.business_id=bs.business_id where c.code=$1`,[sku]))[0];
const allowanceOf = async (app, sku)=> ((await sq(`select a.qty from cl_till_allowance a join cl_catalogue_products c on c.product_uid=a.product_uid where c.code=$1 and a.terminal_id=$2`,[sku, app.api.getSetting("terminal_id")]))[0]||{qty:0}).qty;
const salesCount = (app)=> app.api.one("SELECT COUNT(*) c FROM sales").c;

(async()=>{
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  pg = new PGlite({ extensions:{ pgcrypto } });
  await pg.exec(LIVE_STUB);
  for(const f of ["20261004120000_multi_terminal_identity","20261004180000_multi_terminal_phase2","20261006120000_catalogue_sync","20261007120000_shared_stock"])
    await pg.exec(MIG("migrations/"+f+".sql"));

  // Main T1 (holds the branch's stock), then T2 and T3 join the same branch.
  const M1 = device({ branch_name:"Harare", branch_type:"main", install_id:"TIL1" });
  addProduct(M1,{ name:"Rice 2kg", sku:"RICE", stock:30 });
  addProduct(M1,{ name:"Sugar 1kg", sku:"SUG", stock:1 });
  addProduct(M1,{ name:"Oil 2L", sku:"OIL", stock:8 });
  M1.api.migrate(M1.db);
  const reg = (await M1.api.registerMainBranch("Front")).data;
  await M1.api.catalogueSyncNow({}); await M1.api.catApplyBaseline({}); await M1.api.catalogueSyncNow({});
  let M2, M3;

  await t("unregistered shops are unchanged: no stock RPC, synchronous sale, zero block", async ()=>{
    const U = makeApp({ branch_name:"Solo", branch_type:"main", setup_complete:"1" });
    U.hook("terminalRpc", async ()=>{ throw new Error("must not be called"); }); U.hook("printReceipt", ()=>{});
    addProduct(U,{ name:"Bread", sku:"B", stock:1 });
    assert.strictEqual(U.api.sharedStockTill(), false);
    U.api.startShift("0", new Date(`${TODAY}T06:00:00Z`));
    const p = P(U,"B"); U.api.setCart([{ product_id:p.id, name:p.name, price:p.price, qty:1, stock:p.stock }]);
    const r = U.api.completeSale("Cash");
    assert.strictEqual(r, undefined, "not a promise: the sale is written at once");
    assert.strictEqual(P(U,"B").stock, 0);
    U.api.addToCart(P(U,"B")); assert.strictEqual(U.api.getCart().length, 0, "zero block");
    assert.strictEqual(await U.api.stockSyncNow({}).then(x=>x.ok), false);
  });

  await t("a second till joins: the branch is still local; only the holder (T1) has stock; T2 shows the note", async ()=>{
    const code = (await M1.api.issueJoinCode({ branchId:reg.branch_id })).data.code;
    M2 = device({ branch_name:"", branch_type:"main", install_id:"TIL2" });
    await join(M2, code);
    await M2.api.catalogueSyncNow({});
    assert.strictEqual(M2.api.getSetting("stock_mode"), "local");
    assert.strictEqual(M2.api.getSetting("stock_holder"), "");
    assert.strictEqual(M2.api.tillStockPending(), true);
    await M1.api.stockSyncNow({});
    assert.strictEqual(M1.api.getSetting("stock_holder"), "1"); assert.strictEqual(M1.api.tillStockPending(), false);
    assert.match(M1.api.sharedStockStatusHtml(), /Start shared stock/);
    assert.ok(!/Start shared stock/.test(M2.api.sharedStockStatusHtml()), "only the holder is offered the start");
  });

  await t("start shared stock (Admin, on the holder): T1's stock becomes the branch's opening stock, once", async ()=>{
    await assert.rejects(()=>M1.api.sharedStockStart("0000"), /Incorrect Admin passcode/);
    const r = await M1.api.sharedStockStart("9999");
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(await server("RICE"), { total:30, available:27 }, "T1 keeps 3 (10%) as its allowance");
    assert.strictEqual(P(M1,"RICE").stock, 3, "T1's own stock is now its allowance");
    assert.strictEqual(P(M1,"RICE").branch_total, 30);
    assert.strictEqual(P(M1,"SUG").stock, 0, "sugar (1 < 2 x 2 tills): online-only");
    assert.deepStrictEqual(plain(M1.api.stockLedgerCheck().mismatches), [], "the till's ledger stays exact");
    assert.strictEqual(M1.api.sharedStockTill(), true);
    await M2.api.stockSyncNow({});
    assert.strictEqual(M2.api.sharedStockTill(), true); assert.strictEqual(M2.api.tillStockPending(), false, "the note is gone");
    assert.strictEqual(P(M2,"RICE").stock, 3);
    assert.strictEqual((await sq(`select count(*)::int n from cl_stock_events where kind='opening'`))[0].n, 3, "no double count");
  });

  await t("online sale: the server takes it from available first; the till's allowance is untouched; counted once", async ()=>{
    M2.api.startShift("0", new Date(`${TODAY}T06:00:00Z`));
    const r = await sell(M2, "RICE", 5);
    assert.ok(r && r.ok, JSON.stringify(r)+ALERTS.join("|"));
    assert.strictEqual(salesCount(M2), 1);
    assert.deepStrictEqual(await server("RICE"), { total:25, available:19 });
    assert.strictEqual(P(M2,"RICE").stock, 3, "came from the branch, not this till's allowance");
    const uid = M2.api.one("SELECT uid FROM sales").uid;
    assert.strictEqual((await sq(`select count(*)::int n from cl_stock_events where ref_uid=$1`,["sale:"+uid]))[0].n, 1, "the server knows the sale by the till's uid");
    assert.match(M2.api.stockLineText(P(M2,"RICE")), /^25 in branch · 3 on this till$/);
  });

  await t("the last unit: the first till gets it, the second is refused with how many are left, cart kept", async ()=>{
    M1.api.startShift("0", new Date(`${TODAY}T06:00:00Z`));
    assert.ok((await sell(M1, "SUG", 1)).ok);
    const r = await sell(M2, "SUG", 1);
    assert.strictEqual(r.ok, false);
    assert.match(ALERTS.join("|"), /Sugar 1kg is sold out at this branch\.\nNothing was sold/);
    assert.strictEqual(M2.api.getCart().length, 1, "the cart is kept");
    assert.strictEqual(salesCount(M2), 1, "no sale written");
    assert.deepStrictEqual(await server("SUG"), { total:0, available:0 });
  });

  await t("a timeout where the server actually succeeded: sold from the allowance, reported, never counted twice", async ()=>{
    M2.api.setCart([]);
    LOSE_ANSWER = "cl_stock_sale";
    const before = (await server("RICE")).total;
    const r = await sell(M2, "RICE", 2);
    assert.ok(r.ok && r.offline, JSON.stringify(r));
    assert.strictEqual((await server("RICE")).total, before - 2, "the server ran it once");
    assert.strictEqual(P(M2,"RICE").stock, 1, "the till took it from its allowance meanwhile");
    assert.strictEqual(M2.api.ssPending().length, 1);
    M2.api.setSetting("stock_reach","ok");
    await M2.api.stockSyncNow({});
    assert.strictEqual((await server("RICE")).total, before - 2, "reporting it again changed nothing");
    assert.strictEqual(M2.api.ssPending().length, 0);
    assert.strictEqual(P(M2,"RICE").stock, await allowanceOf(M2,"RICE"), "the till's allowance matches the server again");
    assert.deepStrictEqual(plain(M2.api.stockLedgerCheck().mismatches), []);
  });

  await t("offline: sells within its allowance; beyond it is blocked with the exact message; reported on reconnect", async ()=>{
    await M2.api.stockSyncNow({});
    const allow = P(M2,"RICE").stock;
    offline(true);
    assert.strictEqual(M2.api.sellableNow(P(M2,"RICE")), allow, "offline: only the allowance");
    let r = await sell(M2, "RICE", allow + 1);
    assert.strictEqual(r.ok, false);
    assert.match(ALERTS.join("|"), new RegExp(`Can't reach the server and this till can sell only ${allow} Rice 2kg while offline\\. Sell fewer, or try again when connected\\.`));
    r = await sell(M2, "RICE", allow);
    assert.ok(r.ok && r.offline);
    assert.strictEqual(P(M2,"RICE").stock, 0);
    assert.match(M2.api.sharedStockOfflineBadgeHtml(), /Offline · selling from this till's allowance/);
    const totalBefore = (await server("RICE")).total;
    offline(false);
    await M2.api.stockSyncNow({});
    assert.strictEqual((await server("RICE")).total, totalBefore - allow, "the offline sale is counted on reconnect");
    assert.strictEqual(M2.api.ssPending().length, 0);
  });

  await t("the allowance expires on the till after 72 h (trusted clock): offline selling stops", async ()=>{
    await M2.api.stockSyncNow({});
    assert.ok(P(M2,"RICE").stock > 0);
    M2.api.setSetting("stock_allow_local_ts", new Date(Date.now() - 73*3600*1000).toISOString());
    offline(true);
    assert.strictEqual(M2.api.allowanceValid(), false);
    assert.strictEqual(M2.api.sellableNow(P(M2,"RICE")), 0);
    const r = await sell(M2, "RICE", 1);
    assert.strictEqual(r.ok, false);
    assert.match(ALERTS.join("|"), /offline allowance has expired\. Connect to get a fresh allowance/);
    offline(false);
    await M2.api.stockSyncNow({});
    assert.strictEqual(M2.api.allowanceValid(), true, "a sync grants a fresh allowance");
  });

  await t("stock received at a shared till is pending until synced, then sellable from the branch", async ()=>{
    const oil = P(M2,"OIL"), before = (await server("OIL")).total;
    offline(true);
    M2.api.moveStock({ productId:oil.id, delta:5, kind:"receive", note:"GRV" });
    assert.strictEqual(P(M2,"OIL").stock, oil.stock, "the till's allowance doesn't change");
    assert.strictEqual(P(M2,"OIL").stock_pending_in, 5);
    assert.match(M2.api.stockLineText(P(M2,"OIL")), /\+5 pending/);
    offline(false);
    await M2.api.stockSyncNow({});
    assert.strictEqual((await server("OIL")).total, before + 5);
    assert.strictEqual(P(M2,"OIL").stock_pending_in, 0);
  });

  await t("dispatch / adjustment ask the server first: decremented once; refused when the branch doesn't have it", async ()=>{
    const rice = P(M1,"RICE"), before = (await server("RICE")).total;
    let pre = await M1.api.sharedStockPreApply([{ product:rice, delta:-4, kind:"dispatch" }]);
    assert.ok(pre.ok, JSON.stringify(pre));
    M1.api.moveStock({ productId:rice.id, delta:-4, kind:"dispatch", note:"To CBD" });          // the local DN write
    M1.api.sharedStockDone(pre);
    assert.strictEqual((await server("RICE")).total, before - 4);
    assert.strictEqual(M1.api.ssPending().length, 0, "nothing queued: the server already has it");
    pre = await M1.api.sharedStockPreApply([{ product:P(M1,"SUG"), delta:-1, kind:"adjust" }]);
    assert.strictEqual(pre.ok, false); assert.match(pre.message, /Only 0 Sugar 1kg left in the branch\. Nothing was changed\./);
    offline(true);
    pre = await M1.api.sharedStockPreApply([{ product:rice, delta:-1, kind:"dispatch" }]);
    assert.strictEqual(pre.ok, false); assert.match(pre.message, /needs a connection at a shared-stock branch/);
    offline(false);
    assert.deepStrictEqual(plain(M1.api.stockLedgerCheck().mismatches), []);
  });

  await t("Excel import 'apply qty' is refused at a shared-stock branch", ()=>{
    ALERTS.length = 0;
    const wrap = { querySelector:()=>({}) };
    M1.api.runImport(wrap, { toApply:[], duplicates:[], skipped:[], totalRead:0 }, true);
    assert.match(ALERTS.join("|"), /quantities are set by a stocktake/);
  });

  await t("stocktake: refused while another till holds stock offline (names it); posted once nobody else does", async ()=>{
    await M2.api.stockSyncNow({}); await M1.api.stockSyncNow({});
    let r = await M1.api.sharedStockStocktake([{ product:P(M1,"RICE"), counted:40 }]);
    assert.strictEqual(r.ok, false); assert.match(r.message, /Till T2 still holds stock to sell offline/);
    await sq(`update cl_till_stock_state set last_sync_ts = now() - interval '73 hours' where terminal_id<>$1`,[M1.api.getSetting("terminal_id")]);
    await M1.api.stockSyncNow({});
    r = await M1.api.sharedStockStocktake([{ product:P(M1,"RICE"), counted:40 }]);
    assert.ok(r.ok, r.message);
    M1.api.moveStock({ productId:P(M1,"RICE").id, setTo:40, kind:"stocktake", note:"count" });
    M1.api.sharedStockDone(r);
    assert.deepStrictEqual(await server("RICE"), { total:40, available:40 });
    await M1.api.stockSyncNow({});
    assert.strictEqual(P(M1,"RICE").branch_total, 40);
  });

  await t("a deactivated till: its allowance returns; its offline sales are still accepted later", async ()=>{
    await sq(`update cl_till_stock_state set last_sync_ts = now()`);
    await M2.api.stockSyncNow({});
    const held = await allowanceOf(M2,"RICE");
    assert.ok(held>0);
    offline(true);
    assert.ok((await sell(M2, "RICE", 1)).ok, "offline sale from its allowance");
    offline(false);
    const availBefore = (await server("RICE")).available;
    await serverRpc("cl_terminal_set_active", { p_install_id:"TIL1", p_secret_phrase:"Gold Leaf 42", p_device_key:M1.api.deviceKey(), p_terminal_id:M2.api.getSetting("terminal_id"), p_active:false });
    assert.strictEqual(await allowanceOf(M2,"RICE"), 0);
    assert.strictEqual((await server("RICE")).available, availBefore + held);
    const total = (await server("RICE")).total;
    M2.api.setSetting("stock_reach","ok");
    await M2.api.stockSyncNow({});                                    // sync is refused, but the report goes through first
    assert.strictEqual((await server("RICE")).total, total - 1, "its offline sale was accepted");
    assert.strictEqual(M2.api.ssPending().length, 0);
    await serverRpc("cl_terminal_set_active", { p_install_id:"TIL1", p_secret_phrase:"Gold Leaf 42", p_device_key:M1.api.deviceKey(), p_terminal_id:M2.api.getSetting("terminal_id"), p_active:true });
    M2.api.setSetting("terminal_inactive","");
  });

  await t("a third till with stock of its own: an Admin merges it into the branch, once", async ()=>{
    const code = (await M1.api.issueJoinCode({ branchId:reg.branch_id })).data.code;
    M3 = device({ branch_name:"", branch_type:"main", install_id:"TIL3" });
    await join(M3, code);
    await M3.api.catalogueSyncNow({});
    // a till that already held stock of its own when its branch switched to shared stock
    M3.api.setSetting("stock_init","");
    M3.api.all("SELECT id FROM products").forEach(p=>M3.api.moveStock({ productId:p.id, setTo:0, kind:"allowance", ssLocal:true }));
    M3.api.moveStock({ productId:P(M3,"OIL").id, delta:4, kind:"restock" });
    const r = await M3.api.stockSyncNow({});
    assert.strictEqual(r.needsMerge, true); assert.strictEqual(M3.api.tillStockPending(), true);
    assert.match(M3.api.sharedStockStatusHtml(), /Add this till's stock to the branch/);
    const before = (await server("OIL")).total;
    await M3.api.sharedStockMerge("9999");
    assert.strictEqual((await server("OIL")).total, before + 4);
    assert.strictEqual(M3.api.sharedStockTill(), true); assert.strictEqual(M3.api.tillStockPending(), false);
    assert.deepStrictEqual(plain(M3.api.stockLedgerCheck().mismatches), []);
  });

  await t("Diagnostics: the branch balances (total = available + allowances = history)", async ()=>{
    const r = await M1.api.sharedStockBalance();
    assert.ok(r.ok);
    assert.deepStrictEqual(plain(r.data.mismatches), []);
    assert.strictEqual(r.data.products, 3);
    assert.ok((await sq(`select bool_and(total>=0 and available>=0) b from cl_branch_stock`))[0].b, "never negative");
  });

  await t("branch-only products (Q8): a remote till reports them; main lists them", async ()=>{
    const code = (await M1.api.issueJoinCode({ newBranchName:"Murehwa" })).data.code;
    const R = device({ branch_name:"Murehwa", branch_type:"remote", install_id:"MURE" });
    addProduct(R,{ name:"Local bread", sku:"BRD", stock:9 });
    R.api.migrate(R.db);
    await join(R, code);
    await R.api.catalogueSyncNow({}); await R.api.catApplyBaseline({});
    await R.api.stockSyncNow({});
    assert.strictEqual(R.api.getSetting("stock_mode"), "local"); assert.strictEqual(R.api.tillStockPending(), false, "a single-till branch keeps its stock");
    const list = await M1.api.branchOnlyProducts();
    assert.deepStrictEqual(plain(list.data.products.map(p=>[p.branch, p.code, p.name])), [["Murehwa","BRD","Local bread"]]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})();
