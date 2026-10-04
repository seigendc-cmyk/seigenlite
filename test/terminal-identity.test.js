// Run: node --no-warnings test/terminal-identity.test.js
// Multi-terminal Phase 1 over the REAL app source (test/harness.js):
//   * uid backfill on every syncable table, unique, idempotent
//   * AFTER INSERT triggers stamp uid + terminal_id/branch_uuid; the receipt
//     number (sales.id from last_insert_rowid) is exactly as before
//   * mergeDatabase carries uid and terminal stamps; merged rows are never
//     stamped with the receiving device's terminal; repeat merges add nothing;
//     a file from before this version arrives with uids
//   * deviceKey / newInstallId, and the terminal RPC client against a fake
//     server (never Digital Commerce's live project)
"use strict";
const assert = require("assert");
const { makeApp, Compat, src } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
const plain = (x)=> JSON.parse(JSON.stringify(x));   // vm-realm objects -> this realm
function rig(o){ return makeApp(Object.assign({ branch_name:"Boka", shop_name:"Boka General", branch_type:"main", setup_complete:"1",
  install_id:"ABCD", secret_phrase:"Biz Phrase", install_date:new Date().toISOString() }, o||{})); }
function addProduct(app, name, stock){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES(?,?,?,?,?,?)",[name,10,stock==null?50:stock,3,app.api.currentBranch(),""]);
  return app.api.one("SELECT * FROM products WHERE name=?",[name]);
}
function sell(app, product, qty){
  app.api.setCart([{ product_id:product.id, name:product.name, price:product.price, qty:qty||1, stock:product.stock }]);
  app.hook("printReceipt", ()=>{});
  app.api.completeSale("Cash");
  return app.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
}
// A fake Digital Commerce answering the terminal RPCs from a script.
function fakeServer(app, answers){
  const calls = [];
  app.hook("fetch", async (url, opts)=>{
    const name = String(url).split("/rpc/")[1];
    const body = JSON.parse(opts.body);
    calls.push({ name, body });
    const a = typeof answers[name]==="function"? answers[name](body) : answers[name];
    if(!a) return { ok:false, status:404, text: async()=>JSON.stringify({ message:"no such function" }) };
    return { ok: a.status? a.status<400 : true, status: a.status||200, text: async()=>JSON.stringify(a.body) };
  });
  return calls;
}
const REG = { business_id:"b-1", business_name:"Boka General", branch_id:"br-1", branch_name:"Boka", is_main:true, terminal_id:"t-1", till_code:"T1", label:null };

(async()=>{
  // ================= schema =================
  await t("every syncable table has uid; the 7 transaction tables also have terminal_id and branch_uuid", ()=>{
    const A = rig();
    const cols = (tbl)=> A.api.all(`PRAGMA table_info(${tbl})`).map(c=>c.name);
    assert.strictEqual(A.api.SYNC_UID_TABLES.length, 21);
    assert.ok(A.api.SYNC_UID_TABLES.includes("audit_log"), "audit_log included (approved)");
    A.api.SYNC_UID_TABLES.forEach(tbl=> assert.ok(cols(tbl).includes("uid"), tbl+".uid"));
    A.api.TERMINAL_STAMP_TABLES.forEach(tbl=>{ assert.ok(cols(tbl).includes("terminal_id"), tbl); assert.ok(cols(tbl).includes("branch_uuid"), tbl); });
    assert.ok(!cols("sale_items").includes("terminal_id"), "line tables are not stamped (they hang off their sale)");
  });

  await t("uid backfill: every existing row in every table gets a unique 32-hex uid; running migrate twice changes nothing", ()=>{
    // A database from before this version: base schema only, rows in every syncable table.
    const A = rig();
    const old = new Compat();
    old.run(A.api.SCHEMA);
    const ins = {
      sales:"INSERT INTO sales(ts,total,method) VALUES('2026-01-01T00:00:00Z',1,'Cash')",
      sale_items:"INSERT INTO sale_items(sale_id,name,price,qty) VALUES(1,'x',1,1)",
      sale_payments:"INSERT INTO sale_payments(sale_id,method,amount) VALUES(1,'Cash',1)",
      products:"INSERT INTO products(name,price,stock) VALUES('p',1,1)",
      customers:"INSERT INTO customers(name) VALUES('c')",
      payouts:"INSERT INTO payouts(ts,amount,reason) VALUES('t',1,'r')",
      credit_payments:"INSERT INTO credit_payments(customer_id,ts,amount) VALUES(1,'t',1)",
      stock_received:"INSERT INTO stock_received(ts,product_id,name,qty) VALUES('t',1,'p',1)",
      stock_adjustments:"INSERT INTO stock_adjustments(branch_id,adj_no,qty_delta,ts) VALUES('B-X',#,1,'t')",
      stock_transfers:"INSERT INTO stock_transfers(ts,from_branch,to_branch,product_name,qty) VALUES('t','a','b','p',1)",
      purchases:"INSERT INTO purchases(ts,product_name,qty) VALUES('t','p',1)",
      eod_sessions:"INSERT INTO eod_sessions(date) VALUES('2026-01-01')",
      staff:"INSERT INTO staff(name) VALUES('s')",
      vouchers:"INSERT INTO vouchers(customer_id,amount) VALUES(1,1)",
      stock_requests:"INSERT INTO stock_requests(ts,item_requested) VALUES('t','i')",
      stocktakes:"INSERT INTO stocktakes(branch) VALUES('b')",
      stocktake_counts:"INSERT INTO stocktake_counts(stocktake_id,product_id) VALUES(1,1)",
      dispatch_docs:"INSERT INTO dispatch_docs(dispatch_branch_id,dn_no) VALUES('B-X',#)",
      dn_events:"INSERT INTO dn_events(event_key,dn_branch_id,dn_no,event_type,event_ts) VALUES('k#','B-X',#,'dispatched','t')",
      dn_cases:"INSERT INTO dn_cases(case_no,dn_branch_id,dn_no) VALUES(#,'B-X',1)",
      audit_log:"INSERT INTO audit_log(ts,action) VALUES('t','a')",
    };
    assert.deepStrictEqual(Object.keys(ins).sort(), plain(A.api.SYNC_UID_TABLES).sort(), "the test covers every table");
    Object.values(ins).forEach(sql=>{ old.run(sql.split("#").join("1")); old.run(sql.split("#").join("2")); });   // two rows each (# = a key that must differ)
    A.api.setDb(old);
    A.api.migrate(old);
    const snapshot = {};
    A.api.SYNC_UID_TABLES.forEach(tbl=>{
      const uids = A.api.all(`SELECT uid FROM ${tbl}`).map(r=>r.uid);
      assert.ok(uids.length >= 2, tbl);   // sale_payments gains one more: the existing split-tender backfill gives sale 2 its payment row
      uids.forEach(u=> assert.match(u, /^[0-9a-f]{32}$/, tbl));
      assert.strictEqual(new Set(uids).size, uids.length, tbl+": unique");
      snapshot[tbl] = uids;
    });
    const all = Object.values(snapshot).flat();
    assert.strictEqual(new Set(all).size, all.length, "unique across tables too");
    A.api.migrate(old);
    A.api.SYNC_UID_TABLES.forEach(tbl=> assert.deepStrictEqual(plain(A.api.all(`SELECT uid FROM ${tbl}`).map(r=>r.uid)), plain(snapshot[tbl]), tbl+" unchanged by a second migrate"));
    assert.strictEqual(A.api.one("SELECT terminal_id FROM sales LIMIT 1").terminal_id, null, "pre-terminal rows stay NULL");
  });

  // ================= stamping =================
  await t("a new sale before registration: uid stamped, terminal_id/branch_uuid NULL; receipt # is sales.id as before", ()=>{
    const A = rig();
    A.api.startShift("0");
    const s1 = sell(A, addProduct(A,"Rice"));
    assert.match(s1.uid, /^[0-9a-f]{32}$/);
    assert.strictEqual(s1.terminal_id, null); assert.strictEqual(s1.branch_uuid, null);
    assert.strictEqual(A.api.getLastReceipt().saleId, s1.id, "receipt number = sales.id");
    assert.strictEqual(s1.id, 1);
    A.api.salePayments(s1.id).forEach(p=> assert.match(p.uid, /^[0-9a-f]{32}$/));
    assert.match(A.api.one("SELECT uid FROM sale_items WHERE sale_id=?",[s1.id]).uid, /^[0-9a-f]{32}$/);
  });

  await t("a new sale after registration: stamped with this till's terminal_id and branch_uuid; receipt numbers still run 1, 2, 3", ()=>{
    const A = rig();
    A.api.storeTerminal(REG);
    A.api.startShift("0");
    const p = addProduct(A,"Rice");
    const ids = [sell(A,p), sell(A,p), sell(A,p)];
    assert.deepStrictEqual(ids.map(s=>s.id), [1,2,3]);
    assert.deepStrictEqual(ids.map(s=>A.api.getLastReceipt() && s.terminal_id), ["t-1","t-1","t-1"]);
    assert.ok(ids.every(s=>s.branch_uuid==="br-1"));
    assert.strictEqual(A.api.getLastReceipt().saleId, 3);
    assert.strictEqual(new Set(ids.map(s=>s.uid)).size, 3);
    const shift = A.api.one("SELECT * FROM eod_sessions ORDER BY id DESC LIMIT 1");
    assert.strictEqual(shift.terminal_id, "t-1", "the shift row is stamped too");
    assert.strictEqual(A.api.one("SELECT stock FROM products WHERE id=?",[p.id]).stock, 47, "stock moves exactly as before");
  });

  // ================= merge =================
  await t("merge carries uid and the source till's stamps; merged rows are NOT stamped with the receiving till", async ()=>{
    const R = rig({ branch_name:"Bulawayo", branch_type:"remote" });
    R.api.storeTerminal(Object.assign({}, REG, { branch_id:"br-R", branch_name:"Bulawayo", is_main:false, terminal_id:"t-R" }));
    R.api.startShift("0");
    const rs = sell(R, addProduct(R,"Soap"));
    R.api.run("INSERT INTO payouts(ts,amount,reason,branch) VALUES(?,?,?,?)",[new Date().toISOString(),5,"Bread","Bulawayo"]);
    const M = rig();
    M.api.storeTerminal(REG);
    await M.api.mergeDatabase({ __db:R.db });
    const ms = M.api.one("SELECT * FROM sales WHERE uid=?",[rs.uid]);
    assert.ok(ms, "the merged sale kept its uid");
    assert.strictEqual(ms.terminal_id, "t-R"); assert.strictEqual(ms.branch_uuid, "br-R");
    const mp = M.api.one("SELECT * FROM payouts WHERE reason='Bread'");
    assert.strictEqual(mp.uid, R.api.one("SELECT uid FROM payouts").uid);
    assert.strictEqual(mp.terminal_id, "t-R", "not t-1");
    const rItems = R.api.all("SELECT uid FROM sale_items").map(r=>r.uid).sort();
    assert.deepStrictEqual(plain(M.api.all("SELECT uid FROM sale_items WHERE sale_id=?",[ms.id]).map(r=>r.uid).sort()), plain(rItems));
    assert.strictEqual(M.api.one("SELECT uid FROM audit_log WHERE action='Sale' AND branch='Bulawayo'").uid,
                       R.api.one("SELECT uid FROM audit_log WHERE action='Sale'").uid, "audit_log uid carried (approved)");
    assert.strictEqual(M.api.one("SELECT uid FROM eod_sessions WHERE branch='Bulawayo'").uid, R.api.one("SELECT uid FROM eod_sessions").uid);
  });

  await t("a repeat merge of the same file adds nothing", async ()=>{
    const R = rig({ branch_name:"Bulawayo", branch_type:"remote" });
    R.api.startShift("0"); sell(R, addProduct(R,"Soap")); sell(R, R.api.one("SELECT * FROM products"));
    const M = rig();
    await M.api.mergeDatabase({ __db:R.db });
    const count = ()=> A_counts(M);
    const before = count();
    await M.api.mergeDatabase({ __db:R.db });
    assert.deepStrictEqual(count(), before);
  });
  function A_counts(app){ const o={}; app.api.SYNC_UID_TABLES.forEach(tbl=> o[tbl]=app.api.one(`SELECT COUNT(*) c FROM ${tbl}`).c); return o; }

  await t("a row whose uid is already here is skipped even if its natural key changed", async ()=>{
    const R = rig({ branch_name:"Bulawayo", branch_type:"remote" });
    R.api.run("INSERT INTO stock_requests(ts,branch,item_requested) VALUES('2026-01-01T00:00:00Z','Bulawayo','Sugar')");
    const M = rig();
    await M.api.mergeDatabase({ __db:R.db });
    R.api.run("UPDATE stock_requests SET ts='2026-01-02T00:00:00Z'");     // same row, different (branch, ts) key
    await M.api.mergeDatabase({ __db:R.db });
    assert.strictEqual(M.api.one("SELECT COUNT(*) c FROM stock_requests").c, 1);
  });

  await t("a file from before this version merges as before, and its rows arrive with uids", async ()=>{
    const M = rig();
    const old = new Compat();
    old.run(M.api.SCHEMA);                                // no uid columns, no triggers
    old.run("INSERT INTO settings(key,value) VALUES('branch_name','Mutare'),('branch_type','remote')");
    old.run("INSERT INTO sales(ts,total,method) VALUES('2026-02-01T10:00:00Z',12,'Cash')");
    old.run("INSERT INTO sale_items(sale_id,name,price,qty) VALUES(1,'Tea',12,1)");
    await M.api.mergeDatabase({ __db:old });
    const s = M.api.one("SELECT * FROM sales WHERE branch='Mutare'");
    assert.ok(s && s.total===12, "merged");
    assert.match(s.uid, /^[0-9a-f]{32}$/);
    assert.strictEqual(s.terminal_id, null);
    assert.match(M.api.one("SELECT uid FROM sale_items WHERE sale_id=?",[s.id]).uid, /^[0-9a-f]{32}$/);
  });

  await t("dn_events merged from another device keep their uid", async ()=>{
    const R = rig({ branch_name:"Bulawayo", branch_type:"remote" });
    R.api.recordDnEvent({ dnBranchId:"B-AAAA1111", dnNo:7, type:"received", actorBranchId:R.api.getBranchId(), actorName:"Bulawayo", fromName:"Boka", toName:"Bulawayo", ts:"2026-03-01T10:00:00", grvNo:1 });
    const M = rig();
    await M.api.mergeDatabase({ __db:R.db });
    assert.strictEqual(M.api.one("SELECT uid FROM dn_events WHERE dn_no=7").uid, R.api.one("SELECT uid FROM dn_events WHERE dn_no=7").uid);
  });

  // ================= identity =================
  await t("deviceKey: 32 hex, made once and reused; newInstallId stays 4 characters while LONG_INSTALL_ID is off", ()=>{
    const A = rig();
    const k = A.api.deviceKey();
    assert.match(k, /^[0-9a-f]{32}$/);
    assert.strictEqual(A.api.deviceKey(), k);
    assert.strictEqual(A.api.getSetting("device_key",""), k);
    assert.strictEqual(A.api.LONG_INSTALL_ID, false);
    assert.strictEqual(A.api.newInstallId().length, 4);
    assert.notStrictEqual(rig().api.deviceKey(), k, "each install its own key");
  });

  await t("register (main): calls cl_branch_register with install, phrase, device key, shop and locked branch name, legacy branch id; stores the ids", async ()=>{
    const A = rig();
    const calls = fakeServer(A, { cl_branch_register: { body: REG } });
    const r = await A.api.registerMainBranch("Front");
    assert.ok(r.ok);
    const b = calls[0].body;
    assert.strictEqual(calls[0].name, "cl_branch_register");
    assert.strictEqual(b.p_install_id, "ABCD"); assert.strictEqual(b.p_secret_phrase, "Biz Phrase");
    assert.strictEqual(b.p_device_key, A.api.deviceKey());
    assert.strictEqual(b.p_business_name, "Boka General"); assert.strictEqual(b.p_branch_name, "Boka");
    assert.strictEqual(b.p_legacy_branch_id, A.api.getBranchId()); assert.strictEqual(b.p_label, "Front");
    assert.deepStrictEqual(plain(A.api.terminalIdentity()), { businessId:"b-1", businessName:"Boka General", branchUuid:"br-1", branchName:"Boka",
      isMain:true, terminalId:"t-1", tillCode:"T1", label:"" });
    assert.strictEqual(A.api.isTerminalRegistered(), true);
    assert.strictEqual(A.api.getSetting("branch_id",""), b.p_legacy_branch_id, "branch_id unchanged");
    assert.strictEqual(A.api.getSetting("install_id",""), "ABCD", "install_id unchanged");
  });

  await t("join (existing remote): sends business phrase, own phrase, expected branch name; a refusal stores nothing", async ()=>{
    const A = rig({ branch_name:"Bulawayo", branch_type:"remote", secret_phrase:"Own Phrase" });
    const calls = fakeServer(A, { cl_terminal_join: { body: { error:"BRANCH_NAME_MISMATCH", branch_name:"Mutare" } } });
    const r = await A.api.joinBusiness({ phrase:"Biz Phrase", code:"ABCD-EFGH", expectedBranchName:"Bulawayo", devicePhrase:"Own Phrase", legacyBranchId:A.api.getBranchId() });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, "BRANCH_NAME_MISMATCH");
    const b = calls[0].body;
    assert.strictEqual(b.p_secret_phrase, "Biz Phrase"); assert.strictEqual(b.p_device_phrase, "Own Phrase");
    assert.strictEqual(b.p_expected_branch_name, "Bulawayo"); assert.strictEqual(b.p_join_code, "ABCD-EFGH");
    assert.strictEqual(A.api.isTerminalRegistered(), false, "nothing stored");
    const msg = A.api.terminalProblemText(r, { ownBranchName:"Bulawayo" });
    assert.ok(/branch name doesn't match/i.test(msg), msg);
    assert.ok(/Mutare/.test(msg) && /Bulawayo/.test(msg), msg);
    assert.ok(/ask your main branch to check the branch name/i.test(msg), msg);
    assert.ok(/code can still be used/i.test(msg), msg);
  });

  await t("join success stores the ids; offline makes no call", async ()=>{
    const A = rig({ branch_type:"remote", branch_name:"Bulawayo" });
    A.ctx.navigator.onLine = false;
    let called = false; A.hook("fetch", async ()=>{ called = true; });
    const off = await A.api.joinBusiness({ phrase:"x", code:"ABCDEFGH" });
    assert.strictEqual(off.reason, "offline"); assert.strictEqual(called, false);
    assert.ok(/Connect to the internet once/.test(A.api.terminalProblemText(off)));
    A.ctx.navigator.onLine = true;
    fakeServer(A, { cl_terminal_join: { body: Object.assign({}, REG, { branch_name:"Bulawayo", is_main:false, terminal_id:"t-9", till_code:"T2" }) } });
    const ok = await A.api.joinBusiness({ phrase:"Biz Phrase", code:"ABCDEFGH", label:"Till 2" });
    assert.ok(ok.ok);
    assert.strictEqual(A.api.getSetting("till_code",""), "T2"); assert.strictEqual(A.api.getSetting("terminal_is_main",""), "");
  });

  await t("every server refusal has a plain-English line", ()=>{
    const A = rig();
    const lines = ["JOIN_CODE_INVALID","JOIN_CODE_USED","JOIN_CODE_EXPIRED","PHRASE_MISMATCH","ALREADY_JOINED","OTHER_BUSINESS"]
      .map(code=> A.api.terminalProblemText({ reason:"refused", code }));
    lines.forEach(l=> assert.ok(l && !/unknown reason/.test(l), l));
    assert.strictEqual(new Set(lines).size, lines.length);
    assert.ok(/Too many wrong codes/.test(A.api.terminalProblemText({ reason:"rejected", message:"JOIN_LOCKED: Too many" })));
    assert.ok(/another device/.test(A.api.terminalProblemText({ reason:"rejected", message:"This install ID is already registered to another device" })));
    assert.ok(/main branch/.test(A.api.terminalProblemText({ reason:"rejected", message:"Only a main-branch terminal can add terminals" })));
    assert.strictEqual(A.api.formatJoinCode(" abcd efgh "), "ABCD-EFGH");
  });

  await t("check-in stores business_id/terminal_id from its reply when present, never clears them; sends the device key", async ()=>{
    const A = rig();
    let body = null;
    A.hook("fetch", async (url, opts)=>{ body = JSON.parse(opts.body); return { ok:true, json: async()=>({ vendor_id:"v", status:"onboarding", lock_cart:false, lock_add_product:false, messages:[], business_id:"b-1", terminal_id:"t-1" }) }; });
    await A.api.deviceCheckin();
    assert.strictEqual(body.p_device_key, A.api.deviceKey());
    assert.strictEqual(A.api.getSetting("terminal_id",""), "t-1");
    A.hook("fetch", async ()=>({ ok:true, json: async()=>({ vendor_id:"v", status:"onboarding", messages:[], business_id:null, terminal_id:null }) }));
    await A.api.deviceCheckin();
    assert.strictEqual(A.api.getSetting("terminal_id",""), "t-1", "not cleared by a reply without it");
  });

  await t("check-in refused for another device's key: says so plainly", ()=>{
    const A = rig();
    assert.ok(/registered to another device/.test(A.api.dcCheckinProblemText({ reason:"rejected", message:"This install ID is already registered to another device" })));
  });

  await t("sources: terminal.js is in the build order before settings.js and setup.js", ()=>{
    const build = require("fs").readFileSync(require("path").join(__dirname,"..","build.js"),"utf8");
    const i = build.indexOf('"terminal.js"');
    assert.ok(i>0 && i < build.indexOf('"settings.js"') && i < build.indexOf('"setup.js"'));
    assert.ok(src("terminal.js").includes("const LONG_INSTALL_ID = false;"));
  });

  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
