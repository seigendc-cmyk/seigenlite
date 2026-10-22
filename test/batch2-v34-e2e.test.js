// Run: node --no-warnings test/batch2-v34-e2e.test.js
//
// Batch 2 (v34), selling and credit, driven through the REAL rendered cart
// (owner decisions 1-4 and 30-33, docs/decisions/post-build-29-decisions.md):
//   - over the credit limit the sale is blocked; the override needs the
//     "Credit sales over limit" right AND the Admin passcode; single operator
//     mode: the Admin passcode alone, logged as "single operator" (30)
//   - "Balance at this till" in the cart, on the receipt and in the check (31);
//     a check made offline is marked "offline" (3)
//   - the built-in Cash Sale and Wholesale customers: on every till, locked,
//     no credit, never sent to seiGEN (4)
//   - the receipt upgrade; the logo on screen/PDF receipts only, thermal
//     prints the business name in bold (33)
//   - the 4 Batch 2 reports (32)
//   - the phone Sell list shows the category (1); the held Sell list sees edits
"use strict";
const assert = require("assert");
const { JSDOM } = require("jsdom");
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");

class Compat {
  constructor(){ this.h = new DatabaseSync(":memory:"); }
  run(sql, params){ if(params && params.length) this.h.prepare(sql).run(...params); else this.h.exec(sql); }
  prepare(sql){
    const st = this.h.prepare(sql); let rows=null, i=0, p=[];
    return { bind:(x)=>{ p=x||[]; }, step(){ if(rows===null) rows=st.all(...p); return i<rows.length; },
             getAsObject(){ return {...rows[i++]}; }, free(){} };
  }
}

function makeDomApp(){
  const dom = new JSDOM(
    `<!DOCTYPE html><body><div id="app"></div><div id="drawer"></div><div id="overlay"></div>
     <div id="reqOverlay"></div><div id="reqDrawer"></div><div id="printArea"></div></body>`,
    { url: "http://localhost/" }
  );
  const window = dom.window;
  const document = window.document;
  const db = new Compat();
  const sqlCtor = function(x){ return x && x.__db ? x.__db : new Compat(); };
  const alerts = [];
  let online = true;
  Object.defineProperty(window.navigator, "onLine", { get: ()=> online, configurable: true });
  const ctx = vm.createContext(Object.assign(window, {
    console, SQLctor: sqlCtor, __db: db,
    alert: (m)=>{ alerts.push(m); }, confirm: ()=>true, print: ()=>{},
    $app: document.getElementById("app"),
  }));
  const prelude = `
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="pos", cart=[];
    let sessionStaffId=null, accessStep=1, accessSelectedStaffId=null, accessPinDigits="", accessError="";
    let moreTab="help", settingsUnlocked=false, drawerOpen=true, appliedVoucher=null;
    let searchQuery="", reportsQuery="", creditQuery="", reqDrawerOpen=false;
    let splitTender=false, splitLines=[], fxPreviewCurrency="", quickTapCurrency="";
    async function persist(){}
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
    function renderRequestsDrawer(){}
    function printNow(){}
  `;
  const files = ["db.js","utils.js","pos.js","customers.js","credit.js","printing.js","drawer.js","currencies.js","staff.js","roles.js","eod.js","devicecheckin.js","sync.js","router.js","report-writer.js","reports.js"];
  vm.runInContext(prelude + files.map(src).join("\n"), ctx, { filename: "app-sources" });
  vm.runInContext(`persist = async function(){}; printNow = function(){}; db.run(SCHEMA); migrate(db);`, ctx);
  const settings = { branch_name:"Boka", branch_type:"main", setup_complete:"1", shop_name:"Test Shop" };
  Object.entries(settings).forEach(([k,v])=> vm.runInContext(`setSetting(${JSON.stringify(k)}, ${JSON.stringify(v)});`, ctx));
  const app = {
    ctx, document, alerts, window,
    run(sql, params){ return vm.runInContext(`run(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    one(sql, params){ return vm.runInContext(`one(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    all(sql, params){ return vm.runInContext(`all(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    exec(js){ return vm.runInContext(js, ctx); },
    $(id){ return document.getElementById(id); },
    offline(){ online = false; },
  };
  app.exec(`startShift("0", new Date());`);
  // An Admin (passcode 4321) and a cashier.
  app.run("INSERT INTO staff(name,role,passcode,branch,active) VALUES('Boss','Admin','4321','Boka',1)");
  app.run("INSERT INTO staff(name,role,passcode,branch,active) VALUES('Rudo','Cashier','','Boka',1)");
  app.run("INSERT INTO products(name,price,cost,stock,low_threshold,branch,sku,category) VALUES('Paint DURAN 5lt',8,5,50,3,'Boka','PD5','Paint')");
  app.run("INSERT INTO products(name,price,cost,stock,low_threshold,branch,sku) VALUES('Rice 2kg',4,3,50,3,'Boka','R2')");
  app.run("INSERT INTO customers(name,phone,phone_norm,branch,customer_type,credit_limit) VALUES('Chipo Traders','0782223333','263782223333','Boka','wholesale',15)");
  app.render = ()=>{ app.exec("drawerOpen=true; render();"); };
  app.add = (name)=>{ app.exec(`addToCart(one("SELECT * FROM products WHERE name=?",[${JSON.stringify(name)}]));`); app.render(); };
  app.staff = (name)=>{ const s = app.one("SELECT id FROM staff WHERE name=?",[name]); app.exec(`sessionStaffId=${s? s.id : "null"};`); };
  app.type = (id, val)=>{ const el = app.$(id); assert.ok(el, "#"+id+" is rendered"); el.value = val; el.oninput({ target: el }); };
  app.pick = (q)=>{ app.type("custName", q); const b = document.querySelector("#custList [data-cust-pick]"); assert.ok(b, "a customer matches "+q); b.onclick(); };
  app.pay = (m)=>{ app.$("pay"+m).onclick(); };
  app.modal = ()=> document.querySelector(".modalOverlay:last-of-type");
  app.count = ()=> app.one("SELECT COUNT(*) n FROM sales").n;
  return app;
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const tick = (ms)=> new Promise(r=>setTimeout(r, ms||0));
const overLimit = (app)=>{ app.add("Paint DURAN 5lt"); app.add("Paint DURAN 5lt"); app.add("Paint DURAN 5lt"); app.pick("chipo"); };
const decode = (app, expr)=> app.exec(`new TextDecoder().decode(${expr})`);

(async()=>{
  await t("single operator: over the limit is blocked; the Admin passcode alone overrides, logged as \"single operator\"", async ()=>{
    const app = makeDomApp();
    overLimit(app);
    assert.ok(/Balance at this till: \$0\.00 · limit \$15\.00 · available \$15\.00/.test(app.$("custBalance").textContent), app.$("custBalance").textContent);
    app.pay("Credit"); await tick();
    assert.strictEqual(app.count(), 0, "blocked");
    const m = app.modal(), text = m.querySelector("#clText").textContent;
    assert.ok(/Chipo Traders would owe \$24\.00, over their credit limit of \$15\.00/.test(text) && /Balance at this till: \$0\.00/.test(text) && /blocked/.test(text) && /single operator/.test(text), text);
    assert.strictEqual(m.querySelector("#clOffline"), null, "checked online");
    m.querySelector("#clPass").value = "1111"; await m.querySelector("#clGo").onclick();
    assert.ok(/Incorrect Admin passcode/.test(m.querySelector("#clMsg").textContent));
    assert.strictEqual(app.count(), 0);
    m.querySelector("#clPass").value = "4321"; await m.querySelector("#clGo").onclick(); await tick();
    const s = app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.ok(s && s.method==="Credit" && s.total===24, "sold on credit");
    assert.strictEqual(s.credit_override_mode, "single operator");
    assert.strictEqual(s.credit_override, "Boss");
    assert.strictEqual(s.credit_check, "online");
    assert.strictEqual(s.credit_before, 0); assert.strictEqual(s.credit_after, 24);
    assert.ok(app.one("SELECT * FROM audit_log WHERE action='Credit limit override' AND details LIKE '%single operator, Admin passcode (Boss)%'"));
  });

  await t("signed in without \"Credit sales over limit\": blocked, no override offered (not even the Admin passcode)", async ()=>{
    const app = makeDomApp();
    app.staff("Rudo");
    overLimit(app);
    app.pay("Credit"); await tick();
    const m = app.modal();
    assert.ok(/Only someone with "Credit sales over limit" can override it/.test(m.querySelector("#clText").textContent));
    assert.strictEqual(m.querySelector("#clPass"), null); assert.strictEqual(m.querySelector("#clGo"), null);
    let err = null; try{ app.exec(`approveCreditLimit(creditLimitCheck(cartCustomer, 24), "4321")`); }catch(e){ err = e; }
    assert.ok(err && /Only someone with "Credit sales over limit"/.test(err.message), "the action itself refuses too");
    assert.strictEqual(app.count(), 0);
    assert.strictEqual(app.one("SELECT COUNT(*) n FROM audit_log WHERE action='Credit limit override'").n, 0);
  });

  await t("signed in with the right: the Admin passcode overrides, logged with who did it", async ()=>{
    const app = makeDomApp();
    app.staff("Boss");
    overLimit(app);
    app.pay("Credit"); await tick();
    const m = app.modal();
    assert.ok(/You hold "Credit sales over limit"/.test(m.querySelector("#clText").textContent));
    m.querySelector("#clPass").value = "4321"; await m.querySelector("#clGo").onclick(); await tick();
    const s = app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.ok(s && s.total===24);
    assert.strictEqual(s.credit_override_mode, "right + Admin passcode");
    assert.ok(/Admin passcode: Boss/.test(s.credit_override), s.credit_override);
  });

  await t("offline: the same check against this till's balance, marked \"checked offline\"; the Offline Credit Sales and Overrides reports list it", async ()=>{
    const app = makeDomApp();
    app.offline();
    overLimit(app);
    app.pay("Credit"); await tick();
    const m = app.modal();
    assert.ok(m.querySelector("#clOffline") && /Checked offline/.test(m.querySelector("#clOffline").textContent));
    m.querySelector("#clPass").value = "4321"; await m.querySelector("#clGo").onclick(); await tick();
    assert.strictEqual(app.one("SELECT credit_check FROM sales ORDER BY id DESC LIMIT 1").credit_check, "offline");
    const from = "2000-01-01T00:00:00Z", to = "2999-01-01T00:00:00Z";
    const off = JSON.parse(app.exec(`JSON.stringify(REPORT_CONFIGS.find(c=>c.id==="offlinecredit").fetch(null, ${JSON.stringify(from)}, ${JSON.stringify(to)}))`));
    assert.strictEqual(off.rows.length, 1); assert.ok(/Chipo Traders/.test(off.rows[0][3]) && off.rows[0][5]==="$24.00", JSON.stringify(off.rows[0]));
    const ov = JSON.parse(app.exec(`JSON.stringify(REPORT_CONFIGS.find(c=>c.id==="creditoverrides").fetch(null, ${JSON.stringify(from)}, ${JSON.stringify(to)}))`));
    assert.strictEqual(ov.rows.length, 1); assert.strictEqual(ov.rows[0][8], "Single operator"); assert.strictEqual(ov.rows[0][9], "Offline");
  });

  await t("built-in Cash Sale and Wholesale: on every till once, locked, no credit, never queued for seiGEN", async ()=>{
    const app = makeDomApp();
    app.exec("migrate(db); migrate(db);");
    const b = app.all("SELECT name, uid, builtin, srv_status, customer_type, credit_limit FROM customers WHERE builtin<>'' ORDER BY uid");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b.map(x=>[x.name, x.uid, x.builtin, x.srv_status, x.customer_type, x.credit_limit]))),
      [["Cash Sale","b1170000000000000000000000000001","cash_sale","builtin","retail",null], ["Wholesale","b1170000000000000000000000000002","wholesale","builtin","wholesale",null]]);
    let err = null; try{ app.exec(`saveCustomer(one("SELECT * FROM customers WHERE uid='b1170000000000000000000000000002'"), { name:"Wholesale X", phone:"0771112222", customer_type:"wholesale", credit_limit:"50" })`); }catch(e){ err = e; }
    assert.ok(err && /built in/.test(err.message));
    assert.strictEqual(app.one("SELECT name FROM customers WHERE uid='b1170000000000000000000000000002'").name, "Wholesale");
    // credit refused, cash fine
    app.add("Rice 2kg"); app.pick("cash sale");
    app.pay("Credit"); await tick();
    assert.strictEqual(app.count(), 0); assert.ok(app.alerts.some(a=>/Cash Sale can't buy on credit/.test(a)), app.alerts.join(" | "));
    app.pay("Cash"); await tick();
    assert.strictEqual(app.count(), 1);
    // the Directory shows them with a lock and no Edit
    // the Directory: a lock, no Edit button
    const html = app.exec(`directoryListHtml(all("SELECT * FROM customers WHERE builtin<>''"), "")`);
    assert.ok(/cust-lock/.test(html) && /Built in · no credit/.test(html) && !/data-editcust/.test(html), html);
    // the custSendPending queue never picks them up
    app.exec(`run("UPDATE customers SET srv_status='legacy' WHERE COALESCE(srv_status,'')='' AND COALESCE(phone_norm,'')<>''")`);
    assert.strictEqual(app.one("SELECT COUNT(*) n FROM customers WHERE builtin<>'' AND srv_status IN ('queued','legacy')").n, 0);
  });

  await t("receipt: address, phones, customer, who served, payment ref, credit before/after, message, powered by; thermal has no logo and prints the name in bold", async ()=>{
    const app = makeDomApp();
    app.exec(`saveReceiptSettings({ address:"Shop 4, Main St", phones:"077 000 1111", message:"See you soon", logo:"data:image/png;base64,iVBORw0KGgo=" })`);
    app.add("Rice 2kg"); app.pick("chipo"); app.pay("Credit"); await tick();
    const s = app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(s.credit_before, 0); assert.strictEqual(s.credit_after, 4);
    const items = JSON.stringify([{ name:"Rice 2kg", price:4, qty:1, discount:0 }]), pays = `[{method:"Credit",amount:4,currency:"BASE",tendered_amount:4}]`;
    const text = decode(app, `buildReceiptBytes(${s.id}, ${JSON.stringify(s.ts)}, 4, 0, 0, 0, 4, "Credit", ${items}, ${pays})`);
    for(const re of [/\x1bE\x01Test Shop\n\x1bE\x00/, /Shop 4, Main St/, /077 000 1111/, /Customer: Chipo Traders/, /Served by: Tester/, /Balance before \(this till\)\s+\$0\.00/, /Balance after \(this till\)\s+\$4\.00/, /See you soon/, /powered by seiGEN Commerce/])
      assert.ok(re.test(text), "thermal has "+re);
    assert.ok(!/data:image|iVBOR/.test(text), "no logo on thermal");
    await app.exec(`printReceipt(${s.id}, ${JSON.stringify(s.ts)}, 4, 0, 0, 0, 4, "Credit", ${items}, ${pays})`);
    const pa = app.$("printArea");
    assert.ok(pa.querySelector("img.receipt-logo"), "logo on the screen/PDF receipt");
    assert.ok(/powered by seiGEN Commerce/.test(pa.querySelector(".receipt-powered").textContent));
    assert.ok(/Customer: Chipo Traders/.test(pa.textContent) && /Balance after \(this till\)/.test(pa.textContent));
  });

  await t("Price Changes report: every price change with the cost, below-cost highlighted; Sales by Customer Type", async ()=>{
    const app = makeDomApp();
    app.run("UPDATE products SET price=9 WHERE sku='PD5'");
    app.run("UPDATE products SET price=4.5 WHERE sku='PD5'");
    app.run("UPDATE products SET stock=7 WHERE sku='PD5'");   // not a price change
    const from = "2000-01-01T00:00:00Z", to = "2999-01-01T00:00:00Z";
    const pc = JSON.parse(app.exec(`JSON.stringify(REPORT_CONFIGS.find(c=>c.id==="pricechanges").fetch(null, ${JSON.stringify(from)}, ${JSON.stringify(to)}))`));
    assert.strictEqual(pc.rows.length, 2);
    const below = pc.rows.find(r=>/4\.50/.test(r[4]));
    assert.ok(/rw-below-cost/.test(below[4]) && /BELOW COST/.test(below[7]), JSON.stringify(below));
    assert.ok(!pc.rows.find(r=>/9\.00/.test(r[4]))[7], "9.00 is above cost");
    assert.ok(/1 below cost/.test(pc.footer));
    app.add("Rice 2kg"); app.pay("Cash"); await tick();
    app.add("Rice 2kg"); app.pick("cash sale"); app.pay("Cash"); await tick();
    app.add("Rice 2kg"); app.pick("chipo"); app.pay("Cash"); await tick();
    const ct = JSON.parse(app.exec(`JSON.stringify(REPORT_CONFIGS.find(c=>c.id==="customertype").fetch(null, ${JSON.stringify(from)}, ${JSON.stringify(to)}))`));
    assert.deepStrictEqual(ct.rows.map(r=>[r[0], r[1]]), [["Walk-in (no customer)",1],["Cash Sale",1],["Wholesale customers",1]]);
  });

  await t("Sell: the phone list shows the category; the held list sees a price edit; search waits for a pause in typing", async ()=>{
    const app = makeDomApp();
    app.exec(`route="pos"; drawerOpen=false; render();`);
    assert.ok(/Paint/.test([...app.document.querySelectorAll(".pcat")].map(e=>e.textContent).join(" ")), "category under the name");
    assert.strictEqual(app.exec(`searchProducts("paint")[0].price`), 8);
    app.run("UPDATE products SET price=11 WHERE sku='PD5'");
    assert.strictEqual(app.exec(`searchProducts("paint")[0].price`), 11, "an edit is seen at once");
    const input = app.$("searchInput");
    input.value = "rice"; input.oninput({ target: input });
    assert.strictEqual(app.exec("searchQuery"), "rice");
    await tick(400);
    const names = [...app.document.querySelectorAll(".pname")].map(e=>e.textContent);
    assert.deepStrictEqual(names, ["Rice 2kg"], names.join(","));
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
