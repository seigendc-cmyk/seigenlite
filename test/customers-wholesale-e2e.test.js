// Run: node --no-warnings test/customers-wholesale-e2e.test.js
//
// POS fixes (docs/pos/pos-fixes-design.md §2-3), driven through the REAL
// rendered cart (phone drawer and desktop cart):
//   - the customer combo: search by name or phone, pick, clear
//   - "+ Add new customer": the Create customers permission, the Admin
//     passcode when nobody signed in with a PIN, a duplicate phone refused
//     with "Select <name>"
//   - no silent customer creation from a typed name; Credit needs a customer
//   - wholesale prices by customer type: re-pricing with a notice, discounts
//     capped on the new line total, the price level on the sale, its lines
//     and the receipt, and the Sales Report filter
//   - the credit limit: warns against this till's balance, the Admin
//     passcode lets the sale continue (and is logged)
//   - privacy: national ID / address never on the receipt, and hidden from
//     staff without the permission
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

function makeDomApp(desktop){
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
  `;
  const files = ["db.js","utils.js","pos.js","customers.js","credit.js","printing.js","drawer.js","currencies.js","staff.js","eod.js","devicecheckin.js","router.js","report-writer.js","reports.js"];
  if(desktop) files.push("desktop/sales-desktop.js");
  vm.runInContext(prelude + files.map(src).join("\n"), ctx, { filename: "app-sources" });
  vm.runInContext(`persist = async function(){}; db.run(SCHEMA); migrate(db);`, ctx);
  const settings = { branch_name:"Boka", branch_type:"main", setup_complete:"1", shop_name:"Test Shop" };
  Object.entries(settings).forEach(([k,v])=> vm.runInContext(`setSetting(${JSON.stringify(k)}, ${JSON.stringify(v)});`, ctx));
  const app = {
    ctx, document, alerts, window,
    run(sql, params){ return vm.runInContext(`run(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    one(sql, params){ return vm.runInContext(`one(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    all(sql, params){ return vm.runInContext(`all(${JSON.stringify(sql)}, ${JSON.stringify(params||[])})`, ctx); },
    exec(js){ return vm.runInContext(js, ctx); },
    $(id){ return document.getElementById(id); },
  };
  app.exec(`startShift("0", new Date());`);
  // An Admin (passcode 4321), a cashier without the permission, one with it.
  app.run("INSERT INTO staff(name,role,passcode,branch,active) VALUES('Boss','Admin','4321','Boka',1)");
  app.run("INSERT INTO staff(name,role,passcode,branch,active,can_create_customers) VALUES('Rudo','Cashier','','Boka',1,0)");
  app.run("INSERT INTO staff(name,role,passcode,branch,active,can_create_customers) VALUES('Farai','Cashier','','Boka',1,1)");
  // Paint has a wholesale price, Rice doesn't.
  app.run("INSERT INTO products(name,price,wholesale_price,stock,low_threshold,branch,sku) VALUES('Paint DURAN 5lt',10,8,50,3,'Boka','PD5')");
  app.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Rice 2kg',4,50,3,'Boka','R2')");
  app.run("INSERT INTO customers(name,phone,phone_norm,branch,customer_type,credit_limit,address,national_id) VALUES('Tendai Moyo','0771234567','263771234567','Boka','retail',NULL,'12 Baker St','63-123456-X-42')");
  app.run("INSERT INTO customers(name,phone,phone_norm,branch,customer_type,credit_limit) VALUES('Chipo Traders','0782223333','263782223333','Boka','wholesale',15)");
  app.render = ()=>{ app.exec(desktop? "render();" : "drawerOpen=true; render();"); };
  app.add = (name)=>{ app.exec(`addToCart(one("SELECT * FROM products WHERE name=?",[${JSON.stringify(name)}]));`); app.render(); };
  app.staff = (name)=>{ const s = app.one("SELECT id FROM staff WHERE name=?",[name]); app.exec(`sessionStaffId=${s? s.id : "null"};`); };
  app.type = (id, val)=>{ const el = app.$(id); assert.ok(el, "#"+id+" is rendered"); el.value = val; el.oninput({ target: el }); };
  app.pay = (m)=>{ app.$((desktop? "dsPay" : "pay")+m).onclick(); };
  app.modal = ()=> document.querySelector(".modalOverlay:last-of-type");
  return app;
}

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const tick = ()=> new Promise(r=>setTimeout(r,0));
const lines = (app)=> JSON.parse(app.exec("JSON.stringify(cart)"));

function suite(label, desktop){
  return (async()=>{
    await t(`[${label}] the combo finds customers by name (word start) or phone, in any spelling; picking shows a chip`, ()=>{
      const app = makeDomApp(desktop);
      app.add("Rice 2kg");
      assert.strictEqual(app.$("custPhone"), null, "the separate phone box is gone");
      app.type("custName", "ten");
      let opts = [...app.document.querySelectorAll("#custList [data-cust-pick]")].map(b=>b.textContent.replace(/\s+/g," ").trim());
      assert.deepStrictEqual(opts.length, 1); assert.ok(/Tendai Moyo/.test(opts[0]) && /Retail/.test(opts[0]));
      app.type("custName", "endai");
      assert.strictEqual(app.document.querySelectorAll("#custList [data-cust-pick]").length, 0, "inside a word doesn't match");
      app.type("custName", "+263 78 222");
      opts = [...app.document.querySelectorAll("#custList [data-cust-pick]")].map(b=>b.textContent);
      assert.ok(opts.length===1 && /Chipo Traders/.test(opts[0]), "phone digits match: "+opts);
      app.type("custName", "0771234567");
      app.document.querySelector("#custList [data-cust-pick]").onclick();
      assert.ok(app.$("custChip") && /Tendai Moyo/.test(app.$("custChip").textContent));
      assert.strictEqual(app.exec("cartCustomer.name"), "Tendai Moyo");
      app.$("custClear").onclick();
      assert.strictEqual(app.exec("cartCustomer"), null);
      assert.ok(app.$("custName"), "back to the search box");
    });

    await t(`[${label}] "+ Add new customer": disabled without the permission, the Admin passcode without PIN sign-in, saved and selected`, ()=>{
      const app = makeDomApp(desktop);
      app.add("Rice 2kg");
      app.staff("Rudo");
      app.type("custName", "Nyasha");
      let add = app.document.querySelector("#custList .cust-add");
      assert.ok(add.disabled && /Ask an admin to add customers/.test(add.textContent), "disabled for a cashier without it");
      app.staff("Farai");
      app.type("custName", "Nyasha");
      add = app.document.querySelector("#custList [data-cust-add]");
      assert.ok(add && !add.disabled && /Nyasha/.test(add.textContent), "enabled with Create customers");
      app.staff(null);
      app.type("custName", "Nyasha Dube");
      app.document.querySelector("#custList [data-cust-add]").onclick();
      const m = app.modal();
      assert.strictEqual(m.querySelector("#cuName").value, "Nyasha Dube", "prefilled with what was typed");
      assert.ok(m.querySelector("#cuPass"), "nobody signed in with a PIN: asks for the Admin passcode");
      m.querySelector("#cuPhone").value = "077 555 0001";
      m.querySelector('[data-cu-type="wholesale"]').onclick();
      m.querySelector("#cuLimit").value = "50";
      m.querySelector("#cuNid").value = "08-765432-Z-08";
      m.querySelector("#cuPass").value = "0000";
      m.querySelector("#cuSave").onclick();
      assert.ok(/Admin passcode/.test(m.querySelector("#cuMsg").textContent), "wrong passcode refused");
      assert.strictEqual(app.one("SELECT COUNT(*) n FROM customers WHERE name='Nyasha Dube'").n, 0);
      m.querySelector("#cuPass").value = "4321";
      m.querySelector("#cuSave").onclick();
      const c = app.one("SELECT * FROM customers WHERE name='Nyasha Dube'");
      assert.ok(c, "saved");
      assert.strictEqual(c.phone_norm, "263775550001");
      assert.strictEqual(c.customer_type, "wholesale");
      assert.strictEqual(c.credit_limit, 50);
      assert.strictEqual(c.national_id, "08-765432-Z-08");
      assert.strictEqual(c.srv_status, "queued", "queued for the business's list");
      assert.strictEqual(app.exec("cartCustomer && cartCustomer.id"), c.id, "selected in the cart");
      assert.ok(/Prices changed to Wholesale/.test(app.$("custNotice").textContent), "and re-priced");
      assert.ok(app.one("SELECT * FROM audit_log WHERE action='Add customer' AND details LIKE '%by Boss%'"), "logged with the Admin's name");
    });

    await t(`[${label}] a duplicate phone (any spelling) is refused with "Select <name>"`, ()=>{
      const app = makeDomApp(desktop);
      app.add("Rice 2kg");
      app.staff("Farai");
      app.type("custName", "T Moyo");
      app.document.querySelector("#custList [data-cust-add]").onclick();
      const m = app.modal();
      m.querySelector("#cuPhone").value = "+263 77 123 4567";
      m.querySelector("#cuSave").onclick();
      const msg = m.querySelector("#cuMsg");
      assert.ok(/A customer with this phone already exists: Tendai Moyo\./.test(msg.textContent), msg.textContent);
      const sel = msg.querySelector("button");
      assert.strictEqual(sel.textContent, "Select Tendai Moyo");
      sel.onclick();
      assert.strictEqual(app.exec("cartCustomer.name"), "Tendai Moyo");
      assert.strictEqual(app.one("SELECT COUNT(*) n FROM customers").n, 2, "nothing added");
    });

    await t(`[${label}] a typed name is a walk-in (no customer created); Credit needs a picked customer`, async ()=>{
      const app = makeDomApp(desktop);
      app.add("Rice 2kg");
      app.type("custName", "Someone New");
      app.pay("Cash"); await tick();
      const s = app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
      assert.strictEqual(s.customer_id, null);
      assert.strictEqual(app.one("SELECT COUNT(*) n FROM customers").n, 2, "no silent customer");
      app.add("Rice 2kg");
      app.type("custName", "Someone New");
      app.pay("Credit"); await tick();
      assert.deepStrictEqual(app.alerts, ["Pick the customer, or add them, for a credit sale."]);
      assert.strictEqual(app.one("SELECT COUNT(*) n FROM sales").n, 1);
    });

    await t(`[${label}] a Wholesale customer re-prices every line (retail where there is no wholesale price); clearing goes back`, ()=>{
      const app = makeDomApp(desktop);
      app.add("Paint DURAN 5lt"); app.add("Paint DURAN 5lt"); app.add("Rice 2kg");
      assert.strictEqual(app.exec("cartTotal()"), 24);
      app.type("custName", "chipo");
      app.document.querySelector("#custList [data-cust-pick]").onclick();
      const l = lines(app);
      assert.deepStrictEqual(l.map(x=>[x.name, x.price, x.level]), [["Paint DURAN 5lt",8,"wholesale"],["Rice 2kg",4,"retail"]]);
      assert.strictEqual(app.exec("cartTotal()"), 20);
      assert.ok(/Prices changed to Wholesale\./.test(app.$("custNotice").textContent));
      assert.ok(/Wholesale prices/.test(app.$(desktop? "dsTotal" : "drawerTotal").parentNode.textContent), "the total says so");
      app.add("Paint DURAN 5lt");
      assert.strictEqual(lines(app)[0].qty, 3); assert.strictEqual(lines(app)[0].price, 8, "more of a line keeps its level");
      app.$("custClear").onclick();
      assert.deepStrictEqual(lines(app).map(x=>x.price), [10,4]);
      assert.ok(/Prices changed to Retail\./.test(app.$("custNotice").textContent));
      // a line added while the customer is picked gets the level price straight away
      app.exec("cart=[];"); app.type("custName", "chipo"); app.document.querySelector("#custList [data-cust-pick]").onclick();
      app.add("Paint DURAN 5lt");
      assert.strictEqual(lines(app)[0].price, 8);
    });

    await t(`[${label}] a line discount stays on top of the level price, capped at the new line total`, ()=>{
      const app = makeDomApp(desktop);
      app.add("Paint DURAN 5lt");
      const inp = app.document.querySelector("[data-line-discount]");
      inp.value = "9"; inp.oninput({ target: inp });
      assert.strictEqual(app.exec("cartTotal()"), 1);
      app.type("custName", "chipo");
      app.document.querySelector("#custList [data-cust-pick]").onclick();
      assert.ok(/a discount was reduced to its line total/.test(app.$("custNotice").textContent));
      assert.strictEqual(app.exec("cartDiscountTotal()"), 8, "capped at 8, the wholesale line");
      assert.strictEqual(app.exec("cartTotal()"), 0);
    });

    await t(`[${label}] a wholesale sale records its level on the sale and lines, and the receipt says "Wholesale prices" (no ID or address)`, async ()=>{
      const app = makeDomApp(desktop);
      app.run("UPDATE customers SET credit_limit=NULL, address='9 Hidden Rd', national_id='SECRET-ID' WHERE name='Chipo Traders'");
      app.add("Paint DURAN 5lt"); app.add("Rice 2kg");
      app.type("custName", "chipo");
      app.document.querySelector("#custList [data-cust-pick]").onclick();
      app.pay("Cash"); await tick();
      const s = app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
      assert.strictEqual(s.price_level, "wholesale");
      assert.strictEqual(s.total, 12);
      assert.strictEqual(s.customer_id, app.one("SELECT id FROM customers WHERE name='Chipo Traders'").id);
      const items = app.all("SELECT name,price,price_level,retail_price FROM sale_items WHERE sale_id=? ORDER BY id",[s.id]);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(items.map(i=>[i.name,i.price,i.price_level,i.retail_price]))), [["Paint DURAN 5lt",8,"wholesale",10],["Rice 2kg",4,"retail",4]]);
      const html = app.$("printArea").innerHTML;
      assert.ok(html.includes("<div>Wholesale prices</div>"), "checkout receipt");
      assert.ok(!/SECRET-ID|Hidden Rd/.test(html), "never the ID or address");
      app.exec(`printSaleCopy(${s.id})`); await tick();
      assert.ok(app.$("printArea").innerHTML.includes("Wholesale prices"), "reprint copy");
      const bytes = app.exec(`new TextDecoder().decode(buildSaleCopyBytes(one("SELECT * FROM sales WHERE id=?",[${s.id}]), all("SELECT * FROM sale_items WHERE sale_id=?",[${s.id}]), salePayments(${s.id})))`);
      assert.ok(bytes.includes("Wholesale prices\n") && !bytes.includes("SECRET-ID"), "ESC/POS copy");
      assert.strictEqual(app.exec("cartCustomer"), null, "the next sale starts as a walk-in");
    });

    await t(`[${label}] over the credit limit (this till): warns, the Admin passcode continues the sale and is logged`, async ()=>{
      const app = makeDomApp(desktop);
      app.add("Paint DURAN 5lt"); app.add("Paint DURAN 5lt"); app.add("Paint DURAN 5lt");
      app.type("custName", "chipo");
      app.document.querySelector("#custList [data-cust-pick]").onclick();
      assert.strictEqual(app.exec("cartTotal()"), 24);
      app.pay("Credit"); await tick();
      assert.strictEqual(app.one("SELECT COUNT(*) n FROM sales").n, 0, "not sold yet");
      const m = app.modal();
      const text = m.querySelector("#clText").textContent;
      assert.ok(/Chipo Traders would owe \$24\.00 on this till, over their credit limit of \$15\.00/.test(text) && /this till's credit sales only/.test(text), text);
      m.querySelector("#clPass").value = "1111"; m.querySelector("#clGo").onclick();
      assert.ok(/Incorrect Admin passcode/.test(m.querySelector("#clMsg").textContent));
      assert.strictEqual(app.one("SELECT COUNT(*) n FROM sales").n, 0);
      m.querySelector("#clPass").value = "4321"; m.querySelector("#clGo").onclick(); await tick();
      const s = app.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
      assert.ok(s && s.method==="Credit" && s.total===24, "sold on credit");
      assert.ok(app.one("SELECT * FROM audit_log WHERE action='Credit limit override' AND details LIKE '%approved by Boss%'"));
      // under the limit: no warning
      app.add("Rice 2kg");
      app.type("custName", "tendai"); app.document.querySelector("#custList [data-cust-pick]").onclick();
      app.pay("Credit"); await tick();
      assert.strictEqual(app.one("SELECT COUNT(*) n FROM sales").n, 2, "no limit set: sold straight away");
    });
  })();
}

(async()=>{
  await suite("mobile", false);
  await suite("desktop", true);

  await t("the Sales Report filters by price level and shows the Prices column", async ()=>{
    const app = makeDomApp(false);
    app.add("Rice 2kg"); app.pay("Cash"); await tick();
    app.add("Paint DURAN 5lt");
    app.type("custName", "chipo"); app.document.querySelector("#custList [data-cust-pick]").onclick();
    app.pay("Cash"); await tick();
    const main = app.document.createElement("main"); main.id="main"; app.document.body.appendChild(main);
    app.exec(`renderReports(document.getElementById("main"))`);
    const s = app.one("SELECT ts FROM sales LIMIT 1"), d = new Date(s.ts);
    const day = new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
    app.$("salesFrom").value = day; app.$("salesTo").value = day;
    app.$("salesLevel").value = "wholesale";
    app.$("genSales").onclick(); await tick();
    let rep = app.$("printArea").innerHTML;
    assert.ok(rep.includes("<th>Prices</th>") && rep.includes("Wholesale prices only"));
    assert.ok(rep.includes("<td>Wholesale</td>") && !rep.includes("<td>Retail</td>"), "only the wholesale sale");
    app.$("salesLevel").value = "";
    app.$("genSales").onclick(); await tick();
    rep = app.$("printArea").innerHTML;
    assert.ok(rep.includes("<td>Wholesale</td>") && rep.includes("<td>Retail</td>"), "all sales");
  });

  await t("privacy: staff without Create customers don't see ID, address or limit in the Directory; the full export needs the Admin passcode", async ()=>{
    const app = makeDomApp(false);
    const main = app.document.createElement("main"); main.id="dirMain"; app.document.body.appendChild(main);
    app.staff("Rudo");
    app.exec(`renderDirectory(document.getElementById("dirMain"))`);
    let html = main.innerHTML;
    assert.ok(/Tendai Moyo/.test(html) && /Retail/.test(html) && /Wholesale/.test(html), "name and type");
    assert.ok(!/63-123456-X-42|12 Baker St|Limit/.test(html), "no ID, address or limit");
    assert.ok(app.$("openNewCustomer").disabled, "+ New Customer disabled");
    app.staff("Farai");
    app.exec(`renderDirectory(document.getElementById("dirMain"))`);
    html = main.innerHTML;
    assert.ok(/63-123456-X-42/.test(html) && /12 Baker St/.test(html) && /Limit \$15\.00/.test(html), "shown with the permission");
    let err = null;
    try{ await app.exec(`exportCustomersFull("0000")`); }catch(e){ err = e; }
    assert.ok(err && /Incorrect Admin passcode/.test(err.message), "full export refused without the Admin passcode");
    // the ordinary customer reports carry name, phone and balance only
    const rw = app.exec(`JSON.stringify(REPORT_CONFIGS.filter(c=>/customer|credit|debtor/i.test(c.id+" "+(c.title||""))).map(c=>{ try{ return c.fetch(null, "2000-01-01", "2100-01-01"); }catch(e){ return {headers:[],rows:[]}; } }))`);
    assert.ok(!/63-123456-X-42|12 Baker St|National ID|Address/i.test(rw), "no ID or address in Report Writer");
  });

  await t("customer and cashier edits: only Create customers staff (or the Admin passcode) may change or delete", ()=>{
    const app = makeDomApp(false);
    app.staff("Rudo");
    let err = null;
    try{ app.exec(`saveCustomer(one("SELECT * FROM customers WHERE name='Tendai Moyo'"), { name:"Tendai M", phone:"0771234567" })`); }catch(e){ err = e; }
    assert.ok(err && /Ask an admin/.test(err.message));
    app.staff("Farai");
    app.exec(`saveCustomer(one("SELECT * FROM customers WHERE name='Tendai Moyo'"), { name:"Tendai M", phone:"0771234567", customer_type:"wholesale", credit_limit:"" })`);
    const c = app.one("SELECT * FROM customers WHERE phone_norm='263771234567'");
    assert.strictEqual(c.name, "Tendai M"); assert.strictEqual(c.customer_type, "wholesale"); assert.strictEqual(c.credit_limit, null);
  });

  await t("the business list: sends new customers, adopts another till's record for the same phone, holds a legacy clash for an Admin, pulls the rest", async ()=>{
    const app = makeDomApp(false);
    app.exec(`setSetting("terminal_id","T1");
      var rpcCalls = [];
      function terminalAuth(){ return { p_install_id:"i", p_secret_phrase:"p", p_device_key:"k" }; }
      var serverRows = [{ uid:"srv-1", name:"Mai Ruva", phone:"0713334444", phone_norm:"263713334444", customer_type:"wholesale", credit_limit:30, address:"", national_id:"", updated_at:"2026-10-10T08:00:00Z" },
                        { uid:"srv-2", name:"Tendai Moyo (main)", phone:"+263771234567", phone_norm:"263771234567", customer_type:"retail", credit_limit:null, address:"", national_id:"", updated_at:"2026-10-10T08:00:00Z" }];
      async function terminalRpc(name, body){
        rpcCalls.push(name);
        if(name==="cl_device_customer_save"){
          const c = body.p_customer, n = normPhone(c.phone), dup = serverRows.find(r=> r.phone_norm===n && r.uid!==c.uid);
          if(dup) return { ok:false, reason:"refused", code:"DUPLICATE_PHONE", data:{ ok:false, error:"DUPLICATE_PHONE", existing:dup } };
          return { ok:true, data:{ ok:true } };
        }
        if(name==="cl_device_customers_pull") return { ok:true, data:{ customers: body.p_cursor? [] : serverRows, cursor: 2, more:false } };
        return { ok:false, reason:"offline" };
      }`);
    // Tendai and Chipo are from before the shared list (legacy); a new one added here offline has Mai's phone
    app.staff("Farai");
    app.exec(`saveCustomer(null, { name:"Mai R", phone:"071 333 4444" })`);
    const maiLocal = app.one("SELECT id FROM customers WHERE name='Mai R'").id;
    app.run("INSERT INTO sales(ts,subtotal,discount,total,method,customer_id,branch) VALUES('2026-10-10T07:00:00Z',5,0,5,'Credit',?, 'Boka')",[app.one("SELECT id FROM customers WHERE name='Tendai Moyo'").id]);
    app.run("INSERT INTO sale_payments(sale_id,method,amount) VALUES(1,'Credit',5)");
    await app.exec("custAfterCheckin()");
    const rows = app.all("SELECT name, uid, srv_status, customer_type FROM customers ORDER BY id");
    const by = (n)=> rows.find(r=>r.name===n);
    assert.strictEqual(by("Chipo Traders").srv_status, "sent", "a legacy customer with a new phone is sent");
    assert.strictEqual(by("Tendai Moyo").srv_status, "clash", "a legacy phone clash waits for an Admin");
    const mai = app.one("SELECT * FROM customers WHERE id=?",[maiLocal]);
    assert.ok(mai.uid==="srv-1" && mai.name==="Mai Ruva" && mai.customer_type==="wholesale" && mai.srv_status==="sent", "added here offline: takes the other till's record (same local id)");
    assert.ok(by("Tendai Moyo (main)") && by("Tendai Moyo (main)").srv_status==="sent", "the business's record is pulled");
    assert.strictEqual(app.one("SELECT COUNT(*) n FROM customers WHERE uid='srv-1'").n, 1, "no duplicate from the pull");
    assert.strictEqual(app.exec("getSetting('cust_cursor','0')"), "2");
    // the Admin merges: the till's sales move to the business's record
    let err = null; try{ app.exec(`resolveCustomerClash(${app.one("SELECT id FROM customers WHERE name='Tendai Moyo'").id}, "merge", "0000")`); }catch(e){ err = e; }
    assert.ok(err && /Incorrect Admin passcode/.test(err.message));
    const target = app.one("SELECT id FROM customers WHERE uid='srv-2'").id;
    app.exec(`resolveCustomerClash(${app.one("SELECT id FROM customers WHERE name='Tendai Moyo'").id}, "merge", "4321")`);
    assert.strictEqual(app.one("SELECT COUNT(*) n FROM customers WHERE name='Tendai Moyo'").n, 0);
    assert.strictEqual(app.one("SELECT customer_id FROM sales LIMIT 1").customer_id, target);
    assert.strictEqual(app.exec("customerBalance("+target+")"), 5, "the balance moved with it");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
