// Run: node --no-warnings test/returns.test.js
// Sales returns & credit notes (multi-terminal Phase 3c, src/returns.js),
// design: docs/multi-terminal/phase3c-returns-design.md (owner decisions §4).
// Real app source over SQLite (test/harness.js), TZ=Africa/Harare and a
// pinned app clock. The shared-stock section at the end runs the REAL
// server SQL (live stub + Phase 1, 2, 3a, 3b) in an in-memory PGlite.
"use strict";
process.env.TZ = "Africa/Harare";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,6).join("\n       ")); }
}
const plain = (x)=>JSON.parse(JSON.stringify(x));
const at = (s)=> Date.parse(s+":00+02:00");

// ---- a shop: Admin "Owner" (9999), Rice $10 (cost 6), Oil $20 (cost 12), Soap $5 (cost 3) ----
function shop(o){
  o = o||{};
  const A = makeApp(Object.assign({ setup_complete:"1", shop_name:"Gentronix", branch_name:"Harare", branch_type:"main", currency:"$" }, o.settings||{}));
  vm.runInContext(`(function(){ const R = Date; globalThis.__now = R.now();
    class D extends R { constructor(...a){ if(a.length) super(...a); else super(globalThis.__now); } static now(){ return globalThis.__now; } }
    Date = D; })()`, A.ctx);
  A.clock = (s)=>{ A.ctx.__now = at(s); };
  A.clock(o.now || "2026-10-07T09:00");
  if(o.admin!==false) A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999',?,1,'x')",[A.api.currentBranch()]);
  [["Rice",10,6,"RICE"],["Oil",20,12,"OIL"],["Soap",5,3,"SOAP"]].forEach(([n,p,c,s])=>
    A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,50,3,?,?,'',?,'2026-01-01','')",[n,p,s,A.api.currentBranch(),c]));
  A.api.migrate(A.db);                                                     // opening balances for the ledger
  A.alerts = [];
  A.hook("printReceipt", ()=>{}); A.hook("alert", (m)=>{ A.alerts.push(String(m)); }); A.hook("confirm", ()=>true);
  if(o.shift!==false) A.api.startShift("100");
  return A;
}
const P = (A, sku)=> A.api.one("SELECT * FROM products WHERE sku=? AND branch=?",[sku, A.api.currentBranch()]);
// a sale: lines [[sku, qty, lineDiscount]], method "Cash" | payments [{method, amount, currency}]
function sell(A, lines, method, f){
  f = f||{};
  A.api.setCart(lines.map(([sku,qty,disc])=>{ const p = P(A,sku); return { product_id:p.id, name:p.name, price:p.price, qty, stock:p.stock, discount:disc||0 }; }));
  ["custName","custPhone","paymentRef","discountReason","docRef"].forEach(k=>A.setField(k, ""));
  if(f.cust) A.setField("custName", f.cust);
  if(f.phone) A.setField("custPhone", f.phone);
  if(f.ref) A.setField("paymentRef", f.ref);
  if(lines.some(l=>l[2])) A.setField("discountReason", "Promo");
  if(f.voucher) vm.runInContext(`appliedVoucher = ${JSON.stringify(f.voucher)};`, A.ctx);
  A.alerts.length = 0;
  if(Array.isArray(method)) A.api.completeSale(null, method); else A.api.completeSale(method);
  assert.deepStrictEqual(A.alerts, [], "the sale went through");
  return A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
}
const lineOf = (A, sale, sku)=> A.api.one("SELECT si.* FROM sale_items si JOIN products p ON p.id=si.product_id WHERE si.sale_id=? AND p.sku=?",[sale.id, sku]);
const picks = (A, sale, arr)=> arr.map(([sku,qty,condition])=>({ saleItemId:lineOf(A,sale,sku).id, qty, condition:condition||"restock" }));
function plan(A, sale, arr, method, o){ return A.api.planCreditNote(sale.id, picks(A,sale,arr), method||"same", Object.assign({ reason:"Changed mind" }, o||{})); }
function doReturn(A, sale, arr, method, o){
  const p = plan(A, sale, arr, method, o);
  const r = A.api.commitCreditNote(p, { passcode:(o&&o.passcode)||"9999" });
  return Object.assign(r, { cn: A.api.one("SELECT * FROM credit_notes WHERE id=?",[r.id]), refunds: plain(A.api.all("SELECT method,amount,currency,tendered_amount,ref FROM credit_note_refunds WHERE cn_id=? ORDER BY id",[r.id])) });
}
const money = (rs)=> rs.map(r=>r.method+" "+r.amount.toFixed(2)+(r.currency&&r.currency!=="BASE"? " "+r.currency+" "+r.tendered_amount.toFixed(2) : ""));
const eod = (A)=> A.api.eodTotalsFor("Harare", A.api.oldestOpenShift("Harare").date, 100);
const ledgerOk = (A)=> assert.deepStrictEqual(plain(A.api.stockLedgerCheck().mismatches), [], "Diagnostics: stock = sum of movements");

(async()=>{
  // ================= the basics =================
  await t("full return, cash: refunded the same way, stock back, EOD expected cash down, CN0001, audit names everyone", async ()=>{
    const A = shop();
    const s = sell(A, [["RICE",2]], "Cash");
    assert.strictEqual(eod(A).expected, 120);
    const r = doReturn(A, s, [["RICE",2]], "same", { reason:"Faulty / damaged", note:"torn bag" });
    assert.strictEqual(r.text, "CN0001", "unregistered device: plain sequence");
    assert.deepStrictEqual(money(r.refunds), ["Cash 20.00"]);
    assert.strictEqual(P(A,"RICE").stock, 50);
    const e = eod(A);
    assert.strictEqual(e.expected, 100, "float 100 + cash 20 - cash refund 20");
    assert.strictEqual(e.refunds.cash, 20); assert.strictEqual(e.refunds.total, 20); assert.strictEqual(e.netSales, 0);
    assert.strictEqual(r.cn.sale_receipt, "#"+s.id); assert.strictEqual(r.cn.approved_by, "Owner"); assert.strictEqual(r.cn.started_by, "Tester");
    const log = A.api.one("SELECT * FROM audit_log WHERE action='Credit note'");
    for(const bit of ["CN0001","receipt #"+s.id,"reason: Faulty / damaged (torn bag)","started by Tester","authorised by Owner","2 restocked, 0 written off"])
      assert.ok(log.details.includes(bit), "audit has "+bit+": "+log.details);
    ledgerOk(A);
    // the original sale is never edited
    assert.deepStrictEqual(plain(A.api.one("SELECT total, method FROM sales WHERE id=?",[s.id])), { total:20, method:"Cash" });
  });

  await t("partial returns: never more than sold minus returned, across credit notes; then fully returned", async ()=>{
    const A = shop();
    const s = sell(A, [["RICE",3]], "Cash");
    doReturn(A, s, [["RICE",1]]);
    assert.throws(()=>plan(A, s, [["RICE",3]]), /Only 2 Rice can still be returned \(sold 3, already returned 1\)/);
    doReturn(A, s, [["RICE",2]]);
    assert.throws(()=>plan(A, s, [["RICE",1]]), /Rice has already been returned in full/);
    assert.match(A.api.findReturnSale("#"+s.id).error, /Everything on receipt #\d+ has already been returned \(CN0001, CN0002\)/);
    assert.throws(()=>plan(A, s, []), /Choose at least one item/);
    // the limit is checked again inside the transaction: a stale plan can't overspend
    const s2 = sell(A, [["OIL",1]], "Cash");
    const stale = plan(A, s2, [["OIL",1]]);
    A.api.commitCreditNote(plan(A, s2, [["OIL",1]]), { passcode:"9999" });
    assert.throws(()=>A.api.commitCreditNote(stale, { passcode:"9999" }), /already been returned in full/);
    assert.strictEqual(A.api.one("SELECT COUNT(*) c FROM credit_notes WHERE sale_id=?",[s2.id]).c, 1, "nothing half-saved");
  });

  await t("price actually paid: line discount; an old cart discount shared by value; last units get exactly what's left", async ()=>{
    const A = shop();
    const s = sell(A, [["RICE",3,3],["SOAP",1]], "Cash");                       // 27 + 5 = 32
    assert.strictEqual(s.total, 32);
    assert.strictEqual(doReturn(A, s, [["RICE",1]]).goods, 9);
    // an old sale with a cart-level discount (sales.discount 5 = line 3 + cart 2): goods 30
    A.api.run("INSERT INTO sales(ts,subtotal,discount,total,method,branch,voucher_amount) VALUES(?,35,5,30,'Cash','Harare',0)",[new Date(at("2026-10-07T08:00")).toISOString()]);
    const old = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    A.api.run("INSERT INTO sale_items(sale_id,product_id,name,price,qty,cost,discount) VALUES(?,?,'Rice',10,3,6,3)",[old.id, P(A,"RICE").id]);
    A.api.run("INSERT INTO sale_items(sale_id,product_id,name,price,qty,cost,discount) VALUES(?,?,'Soap',5,1,3,0)",[old.id, P(A,"SOAP").id]);
    A.api.run("INSERT INTO sale_payments(sale_id,method,amount,currency,rate,tendered_amount) VALUES(?,'Cash',30,'BASE',1,30)",[old.id]);
    const st = A.api.saleReturnState(old);
    assert.deepStrictEqual(plain(st.lines.map(l=>l.value)), [25.31, 4.69], "30 shared 27:5 to the cent");
    assert.strictEqual(doReturn(A, old, [["RICE",1]]).goods, 8.44, "25.3125 / 3");
    assert.strictEqual(doReturn(A, old, [["RICE",2]]).goods, 16.87, "the rest of the line: 25.31 - 8.44");
    assert.strictEqual(doReturn(A, old, [["SOAP",1]]).goods, 4.69);
    assert.strictEqual(A.api.one("SELECT ROUND(SUM(goods_total),2) g FROM credit_notes WHERE sale_id=?",[old.id]).g, 30, "never more than was paid");
  });

  await t("split tender: shared over the tenders by what's left on each; EcoCash needs a reference; totals exact", async ()=>{
    const A = shop();
    const s = sell(A, [["RICE",2]], [{ method:"Cash", amount:12 }, { method:"EcoCash", amount:8 }], { ref:"MP1" });
    assert.throws(()=>plan(A, s, [["RICE",1]]), /Enter the reference of the EcoCash\/Bank refund/);
    const r1 = doReturn(A, s, [["RICE",1]], "same", { ref:"RF-1" });
    assert.deepStrictEqual(money(r1.refunds), ["Cash 6.00","EcoCash 4.00"]);
    assert.strictEqual(r1.refunds[1].ref, "RF-1");
    const r2 = doReturn(A, s, [["RICE",1]], "same", { ref:"RF-2" });
    assert.deepStrictEqual(money(r2.refunds), ["Cash 6.00","EcoCash 4.00"]);
    const e = eod(A);
    assert.strictEqual(e.expected, 100, "float + cash 12 - cash refunds 12");
    assert.strictEqual(e.refunds.ecocash, 8);
  });

  await t("multi-currency: refunded in the sale's currency at the sale's own rate, even after the rate changed", async ()=>{
    const A = shop();
    A.api.saveCurrency({ code:"ZWL", name:"Zimbabwe Gold", symbol:"ZiG", rate:13000 });
    const s = sell(A, [["RICE",2]], [{ method:"Cash", amount:260000, currency:"ZWL" }]);
    A.api.run("UPDATE currencies SET rate=15000 WHERE code='ZWL'");
    const r1 = doReturn(A, s, [["RICE",1]]);
    assert.deepStrictEqual(money(r1.refunds), ["Cash 10.00 ZWL 130000.00"]);
    const r2 = doReturn(A, s, [["RICE",1]]);
    assert.deepStrictEqual(money(r2.refunds), ["Cash 10.00 ZWL 130000.00"], "the last refund returns exactly what's left");
    const e = eod(A);
    assert.deepStrictEqual(plain(e.refunds.cashByCurrency).map(c=>[c.currency,c.tendered]), [["ZWL",260000]]);
    assert.ok(A.api.eodReturnsLines(e).some(([a,b])=>/ZWL cash/.test(a) && /260000\.00/.test(b)));
  });

  await t("voucher-paid share comes back as a store-credit voucher only, never cash (owner Q2)", async ()=>{
    const A = shop();
    A.api.run("INSERT INTO customers(name,phone,branch) VALUES('Rudo','0771','Harare')");
    const cid = A.api.one("SELECT id FROM customers WHERE name='Rudo'").id;
    A.api.run("INSERT INTO vouchers(customer_id,amount,branch,earned_ts,status) VALUES(?,5,'Harare','x','Available')",[cid]);
    const v = A.api.one("SELECT * FROM vouchers");
    const s = sell(A, [["RICE",2]], "Cash", { cust:"Rudo", phone:"0771", voucher:{ id:v.id, amount:5, customerId:cid } });
    assert.strictEqual(s.total, 15); assert.strictEqual(s.voucher_amount, 5);
    const r1 = doReturn(A, s, [["RICE",1]]);
    assert.deepStrictEqual(money(r1.refunds), ["Cash 7.50","Voucher 2.50"]);
    const r2 = doReturn(A, s, [["RICE",1]]);
    assert.deepStrictEqual(money(r2.refunds), ["Cash 7.50","Voucher 2.50"]);
    const sc = A.api.all("SELECT * FROM vouchers WHERE kind='store_credit' ORDER BY id");
    assert.deepStrictEqual(plain(sc.map(x=>[x.customer_id, x.amount, x.status])), [[cid,2.5,"Available"],[cid,2.5,"Available"]]);
  });

  await t("store credit for a walk-in: name and phone required, customer created in the same save; drawer cash unchanged", async ()=>{
    const A = shop();
    const s = sell(A, [["OIL",1]], "Cash");
    assert.throws(()=>plan(A, s, [["OIL",1]], "voucher"), /Store credit needs the customer's name and phone/);
    assert.throws(()=>plan(A, s, [["OIL",1]], "voucher", { customerName:"Chipo" }), /name and phone/);
    const r = doReturn(A, s, [["OIL",1]], "voucher", { customerName:"Chipo", customerPhone:"0772" });
    assert.deepStrictEqual(money(r.refunds), ["Voucher 20.00"]);
    const c = A.api.one("SELECT * FROM customers WHERE name='Chipo'");
    assert.ok(c && c.phone==="0772");
    assert.strictEqual(r.cn.customer_id, c.id);
    assert.deepStrictEqual(plain(A.api.one("SELECT customer_id, amount, kind, source_cn_id FROM vouchers")), { customer_id:c.id, amount:20, kind:"store_credit", source_cn_id:r.id });
    assert.strictEqual(eod(A).expected, 120, "no cash left the drawer");
    assert.strictEqual(eod(A).refunds.voucher, 20);
  });

  await t("store credit used on a smaller sale keeps the rest (owner Q9); loyalty vouchers unchanged and not blocked", async ()=>{
    const A = shop();
    A.api.setSetting("freq_voucher_amount","3"); A.api.setSetting("freq_purchases_needed","1");
    A.api.run("INSERT INTO customers(name,phone,branch) VALUES('Rudo','0771','Harare')");
    const cid = A.api.one("SELECT id FROM customers WHERE name='Rudo'").id;
    A.api.run("INSERT INTO vouchers(customer_id,amount,branch,earned_ts,status,kind) VALUES(?,20,'Harare','x','Available','store_credit')",[cid]);
    const sc = A.api.one("SELECT * FROM vouchers");
    sell(A, [["RICE",1]], "Cash", { cust:"Rudo", phone:"0771", voucher:{ id:sc.id, amount:20, customerId:cid } });
    const after = plain(A.api.all("SELECT kind, amount, status FROM vouchers ORDER BY id").map(v=>v.kind+" "+v.amount+" "+v.status));
    assert.deepStrictEqual(after, ["store_credit 20 Redeemed","store_credit 10 Available","loyalty 3 Available"],
      "10 of store credit left; holding store credit didn't stop the loyalty voucher");
    // a loyalty voucher is used up as before (the rest is not kept)
    const lv = A.api.one("SELECT * FROM vouchers WHERE kind='loyalty'");
    sell(A, [["SOAP",1]], "Cash", { cust:"Rudo", phone:"0771", voucher:{ id:lv.id, amount:3, customerId:cid } });
    assert.strictEqual(A.api.one("SELECT COUNT(*) c FROM vouchers WHERE kind='loyalty' AND status='Available' AND amount<3").c, 0, "no loyalty remainder voucher");
  });

  await t("debtor: the credit part lowers the balance; not offered for a cash sale; part-paid: to zero, rest store credit (owner Q8)", async ()=>{
    const A = shop();
    const s = sell(A, [["RICE",3]], "Credit", { cust:"Tendai", phone:"0773" });
    const cid = s.customer_id;
    assert.strictEqual(A.api.customerBalance(cid), 30);
    const r = doReturn(A, s, [["RICE",1]]);
    assert.deepStrictEqual(money(r.refunds), ["Debtor 10.00"]);
    assert.strictEqual(A.api.customerBalance(cid), 20);
    assert.strictEqual(doReturn(A, s, [["RICE",1]], "debtor").refunds[0].method, "Debtor");
    const cashSale = sell(A, [["SOAP",1]], "Cash");
    assert.throws(()=>plan(A, cashSale, [["SOAP",1]], "debtor"), /This sale wasn't on credit, so the debtor balance can't be reduced/);
    // part-paid: Oil x2 on credit (40), paid 35 -> owes 5 (+10 left from above)
    const s2 = sell(A, [["OIL",2]], "Credit", { cust:"Tendai", phone:"0773" });
    A.api.run("INSERT INTO credit_payments(customer_id,ts,amount,note,branch) VALUES(?,?,45,'','Harare')",[cid, new Date(at("2026-10-07T09:30")).toISOString()]);
    assert.strictEqual(A.api.customerBalance(cid), 5);
    const r2 = doReturn(A, s2, [["OIL",2]]);
    assert.deepStrictEqual(money(r2.refunds), ["Debtor 5.00","Voucher 35.00"]);
    assert.strictEqual(A.api.customerBalance(cid), 0);
  });

  // ================= exchange =================
  await t("exchange, dearer: the credit pays part of the new sale, the customer pays the rest; one save", async ()=>{
    const A = shop();
    const s = sell(A, [["SOAP",1]], "Cash");
    assert.throws(()=>A.api.startExchange(s.id, picks(A,s,[["SOAP",1]]), { reason:"Wrong item", passcode:"0000" }), /Incorrect Admin passcode/);
    assert.strictEqual(A.api.exchangePending(), null);
    A.api.startExchange(s.id, picks(A,s,[["SOAP",1]]), { reason:"Wrong item", passcode:"9999" });
    A.api.setCart([{ product_id:P(A,"OIL").id, name:"Oil", price:20, qty:1, stock:50 }]);
    assert.deepStrictEqual([A.api.cartTotals().total, A.api.cartTotals().exchange, A.api.cartTotal()], [20, 5, 15]);
    A.alerts.length = 0; A.api.completeSale("Cash"); assert.deepStrictEqual(A.alerts, []);
    const ns = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual(ns.total, 20);
    assert.deepStrictEqual(plain(A.api.salePayments(ns.id).map(p=>p.method+" "+p.amount)), ["Cash 15","Exchange 5"]);
    const cn = A.api.one("SELECT * FROM credit_notes");
    assert.strictEqual(cn.exchange_sale_id, ns.id);
    assert.deepStrictEqual(plain(A.api.all("SELECT method, amount FROM credit_note_refunds").map(r=>r.method+" "+r.amount)), ["Exchange 5"]);
    assert.strictEqual(A.api.exchangePending(), null);
    assert.deepStrictEqual([P(A,"SOAP").stock, P(A,"OIL").stock], [50, 49]);
    const e = eod(A);
    assert.deepStrictEqual([e.expected, e.totalSales, e.refunds.total, e.netSales], [120, 25, 5, 20], "cash 5+15 in; sales 5 + 20; returns 5");
    ledgerOk(A);
  });

  await t("exchange, cheaper: the credit covers the sale; the difference goes back the same way; cancelling saves nothing", async ()=>{
    const A = shop();
    const s = sell(A, [["OIL",1]], "Cash");
    A.api.startExchange(s.id, picks(A,s,[["OIL",1]]), { reason:"Changed mind", passcode:"9999" });
    A.api.cancelExchange();
    assert.strictEqual(A.api.one("SELECT COUNT(*) c FROM credit_notes").c, 0);
    A.api.startExchange(s.id, picks(A,s,[["OIL",1]]), { reason:"Changed mind", passcode:"9999" });
    A.api.setCart([{ product_id:P(A,"SOAP").id, name:"Soap", price:5, qty:1, stock:50 }]);
    assert.strictEqual(A.api.cartTotal(), 0);
    A.alerts.length = 0; A.api.completeSale("Exchange"); assert.deepStrictEqual(A.alerts, []);
    const ns = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.deepStrictEqual(plain(A.api.salePayments(ns.id).map(p=>p.method+" "+p.amount)), ["Exchange 5"]);
    assert.deepStrictEqual(plain(A.api.all("SELECT method, amount FROM credit_note_refunds ORDER BY id").map(r=>r.method+" "+r.amount)), ["Exchange 5","Cash 15"]);
    assert.strictEqual(eod(A).expected, 105, "float 100 + cash 20 - cash back 15");
  });

  // ================= stock =================
  await t("restock vs write-off: only good goods become sellable; the ledger shows both; Diagnostics balances", async ()=>{
    const A = shop();
    const s = sell(A, [["RICE",2]], "Cash");
    doReturn(A, s, [["RICE",1,"restock"]]);
    doReturn(A, s, [["RICE",1,"writeoff"]], "same", { reason:"Faulty / damaged" });
    assert.strictEqual(P(A,"RICE").stock, 49, "50 - 2 sold + 1 back; the damaged one never sellable");
    const kinds = plain(A.api.all("SELECT kind, qty_delta, doc_no FROM stock_movements WHERE product_id=? ORDER BY id",[P(A,"RICE").id]).map(m=>m.kind+" "+m.qty_delta+" "+m.doc_no));
    assert.deepStrictEqual(kinds.slice(1), ["sale -2 #"+s.id, "return 1 CN0001", "return_damaged 1 CN0002", "return_writeoff -1 CN0002"]);
    ledgerOk(A);
    const cn2 = A.api.one("SELECT * FROM credit_notes WHERE cn_no=2");
    assert.strictEqual(cn2.cost_reversed, 0, "a write-off keeps its cost");
    assert.strictEqual(A.api.one("SELECT cost_reversed FROM credit_notes WHERE cn_no=1").cost_reversed, 6);
  });

  await t("deactivated or deleted product: the money is refunded, the line is write-off only (owner Q14)", async ()=>{
    const A = shop();
    const s = sell(A, [["RICE",1],["SOAP",1]], "Cash");
    A.api.run("UPDATE products SET active=0 WHERE sku='RICE'");
    assert.throws(()=>plan(A, s, [["RICE",1,"restock"]]), /Rice is no longer a product here, so it can only be written off/);
    assert.strictEqual(doReturn(A, s, [["RICE",1,"writeoff"]]).goods, 10);
    const soapLine = lineOf(A, s, "SOAP");
    A.api.run("DELETE FROM products WHERE sku='SOAP'");
    const st = A.api.saleReturnState(s);
    assert.strictEqual(st.lines.find(l=>l.id===soapLine.id).canRestock, false);
    const p = A.api.planCreditNote(s.id, [{ saleItemId:soapLine.id, qty:1, condition:"writeoff" }], "same", { reason:"Other", note:"discontinued" });
    assert.strictEqual(A.api.commitCreditNote(p, { passcode:"9999" }).goods, 5, "refunded with no product left");
  });

  // ================= approval, shift, reasons =================
  await t("Admin passcode required (nothing saved without it); no Admin passcode set up; a shift must be open", async ()=>{
    const A = shop();
    const s = sell(A, [["RICE",1]], "Cash");
    assert.throws(()=>A.api.commitCreditNote(plan(A, s, [["RICE",1]]), { passcode:"0000" }), /Incorrect Admin passcode. Nothing was saved/);
    assert.throws(()=>A.api.commitCreditNote(plan(A, s, [["RICE",1]]), { passcode:"" }), /Incorrect Admin passcode/);
    assert.strictEqual(A.api.one("SELECT COUNT(*) c FROM credit_notes").c, 0);
    assert.strictEqual(A.api.one("SELECT last_no FROM doc_counters WHERE doc_type='CN'"), null, "no CN number used");
    assert.strictEqual(P(A,"RICE").stock, 49);
    const B = shop({ admin:false });
    const s2 = sell(B, [["RICE",1]], "Cash");
    assert.throws(()=>B.api.commitCreditNote(plan(B, s2, [["RICE",1]]), { passcode:"9999" }), /Set an Admin passcode in Settings first/);
    const C = shop();
    const s3 = sell(C, [["RICE",1]], "Cash");
    C.api.completeEOD("110");
    assert.throws(()=>C.api.commitCreditNote(plan(C, s3, [["RICE",1]]), { passcode:"9999" }), /Start a shift/);
    // the cashier who starts it must be signed in: the credit note and audit line name them
    const D = shop();
    const s4 = sell(D, [["RICE",1]], "Cash");
    vm.runInContext(`sessionUser = "";`, D.ctx);
    assert.throws(()=>D.api.commitCreditNote(plan(D, s4, [["RICE",1]]), { passcode:"9999" }), /Enter your name first \(tap your name at the top\), so the return is recorded against you\./);
    assert.strictEqual(D.api.one("SELECT COUNT(*) c FROM credit_notes").c, 0);
  });

  await t("reasons: a fixed list; a note is required for Other", async ()=>{
    const A = shop();
    const s = sell(A, [["RICE",1]], "Cash");
    assert.deepStrictEqual(plain(A.api.RETURN_REASONS), ["Wrong item","Faulty / damaged","Changed mind","Other"]);
    assert.throws(()=>plan(A, s, [["RICE",1]], "same", { reason:"" }), /Choose the reason/);
    assert.throws(()=>plan(A, s, [["RICE",1]], "same", { reason:"Other" }), /short note for "Other"/);
    assert.ok(plan(A, s, [["RICE",1]], "same", { reason:"Other", note:"wrong colour" }));
  });

  // ================= finding the receipt (owner Q4) =================
  await t("receipts: old #45 and new T1-0001; another till's, a merged, another branch's sale refused", async ()=>{
    const A = shop();
    const old = sell(A, [["RICE",1]], "Cash");                                     // before registration: #id
    A.api.setSetting("till_code","T1"); A.api.setSetting("terminal_id","11111111-1111-1111-1111-111111111111");
    const s = sell(A, [["RICE",1]], "Cash");
    assert.strictEqual(s.receipt_no, "T1-0001");
    assert.strictEqual(A.api.findReturnSale("#"+old.id).sale.id, old.id, "#id of a sale made here before registration");
    assert.strictEqual(A.api.findReturnSale(String(old.id)).sale.id, old.id);
    assert.strictEqual(A.api.findReturnSale("t1-1").sale.id, s.id, "T1-1 = T1-0001");
    const TEXT = "This receipt was made on another till. Return it on that till.";
    assert.strictEqual(A.api.findReturnSale("T2-0001").error, TEXT);
    assert.match(A.api.findReturnSale("T1-0099").error, /Receipt T1-0099 wasn't found on this till/);
    assert.match(A.api.findReturnSale("hello").error, /e\.g\. T1-0045 or #45/);
    A.api.run("UPDATE sales SET terminal_id='22222222-2222-2222-2222-222222222222' WHERE id=?",[s.id]);
    assert.strictEqual(A.api.findReturnSale("T1-0001").error, TEXT, "another terminal's stamp");
    assert.throws(()=>plan(A, A.api.one("SELECT * FROM sales WHERE id=?",[s.id]), [["RICE",1]]), /made on another till/);
    A.api.run("UPDATE sales SET merged_ts='2026-10-07T07:00:00.000Z' WHERE id=?",[old.id]);
    assert.strictEqual(A.api.findReturnSale("#"+old.id).error, TEXT, "a merged sale");
  });

  await t("merge: a same-branch-named device's sales arrive stamped and can't be returned here; credit notes reach main", async ()=>{
    const R = shop({ settings:{ branch_name:"Boka", branch_type:"remote" } });
    const s = sell(R, [["RICE",2]], "Cash");
    doReturn(R, s, [["RICE",1,"writeoff"]], "same", { reason:"Faulty / damaged" });
    const M = shop();
    await M.api.mergeDatabase({ __db:R.db });
    const ms = M.api.one("SELECT * FROM sales WHERE branch='Boka'");
    assert.ok(ms.merged_ts, "stamped as merged");
    assert.strictEqual(M.api.findReturnSale("#"+ms.id).error, "This receipt was made on another till. Return it on that till.");
    const cn = M.api.one("SELECT * FROM credit_notes WHERE branch='Boka'");
    assert.ok(cn && cn.sale_id===ms.id && cn.goods_total===10, JSON.stringify(cn));
    assert.deepStrictEqual(plain(M.api.all("SELECT condition, qty FROM credit_note_items WHERE cn_id=?",[cn.id]).map(i=>i.condition+" "+i.qty)), ["writeoff 1"]);
    assert.strictEqual(M.api.all("SELECT * FROM credit_note_refunds WHERE cn_id=?",[cn.id]).length, 1);
    await M.api.mergeDatabase({ __db:R.db });
    assert.strictEqual(M.api.one("SELECT COUNT(*) c FROM credit_notes").c, 1, "merging again adds nothing");
    // two devices with the same branch name: the other one's sales are merged, never returnable
    const H2 = shop();
    const s2 = sell(H2, [["OIL",1]], "Cash");
    const H1 = shop();
    await H1.api.mergeDatabase({ __db:H2.db });
    const m2 = H1.api.one("SELECT * FROM sales WHERE ts=?",[s2.ts]);
    assert.strictEqual(H1.api.returnOriginProblem(m2), "This receipt was made on another till. Return it on that till.");
  });

  await t("time limit: 30 days by business date; the cut-off counts; Admin passcode to change it, logged", async ()=>{
    const A = shop({ now:"2026-09-02T01:30" });
    const s = sell(A, [["RICE",1]], "Cash");                                       // 2 Sep 01:30 local
    A.api.completeEOD("110");
    A.clock("2026-10-02T09:00"); A.api.startShift("0");                           // 30 days later
    assert.ok(A.api.findReturnSale("#"+s.id).sale, "day 30: allowed");
    A.api.setSetting("business_day_cutoff","3");                                  // the sale's business date becomes 1 Sep
    assert.match(A.api.findReturnSale("#"+s.id).error, /is from 2026-09-01, past the 30-day return limit/);
    assert.throws(()=>A.api.setReturnDaysLimit(45, "0000"), /Incorrect Admin passcode/);
    assert.throws(()=>A.api.setReturnDaysLimit(0, "9999"), /from 1 to 365/);
    A.api.setReturnDaysLimit(45, "9999");
    assert.ok(A.api.findReturnSale("#"+s.id).sale);
    assert.match(A.api.one("SELECT details FROM audit_log WHERE action='Return limit changed'").details, /30 → 45 days/);
  });

  // ================= the slip and the reports =================
  await t("credit note slip and WhatsApp text: number, receipt, lines, conditions, refund, both names", async ()=>{
    const A = shop();
    A.api.saveCurrency({ code:"ZWL", name:"Zimbabwe Gold", symbol:"ZiG", rate:13000 });
    const s = sell(A, [["RICE",1],["SOAP",1]], [{ method:"Cash", amount:5 }, { method:"Cash", amount:130000, currency:"ZWL" }]);
    const r = doReturn(A, s, [["RICE",1,"restock"],["SOAP",1,"writeoff"]], "same", { reason:"Faulty / damaged", note:"leaking" });
    const L = A.api.creditNoteLines(r.id, 32);
    const all_ = [].concat(L.head, L.itemLines, L.totalLines, L.foot).join("\n");
    for(const bit of ["CREDIT NOTE CN0001","Original receipt #"+s.id,"1 x Rice","(back to stock)","1 x Soap","(written off)","TOTAL CREDIT","Cash refunded",
      "Cash refunded ZWL","ZiG","Reason: Faulty / damaged - leaking","Started by Tester","Authorised by Owner"]) assert.ok(all_.includes(bit), "slip has "+bit+"\n"+all_);
    assert.ok(L.itemLines.every(l=>l.length<=32), "fits 58mm");
    const wa = A.api.creditNoteWhatsAppText(r.id);
    assert.ok(wa.includes("Credit note CN0001") && wa.includes("Authorised by Owner") && wa.startsWith("```"));
  });

  await t("reports: Sales gross/returns/net; payment methods with refunds; margin; Sales Trend net of returns; Returns report; Item Ledger", async ()=>{
    const A = shop();
    const s = sell(A, [["RICE",3]], "Cash");                                         // 30, cost 18
    sell(A, [["OIL",1]], "Credit", { cust:"Tendai", phone:"0773" });                 // 20
    doReturn(A, s, [["RICE",1,"restock"]]);
    doReturn(A, s, [["RICE",1,"writeoff"]], "same", { reason:"Faulty / damaged" });
    const cfg = (id)=>A.api.REPORT_CONFIGS.find(c=>c.id===id);
    const range = vm.runInContext(`businessRange("2026-10-07","2026-10-07")`, A.ctx);
    const sales = plain(cfg("sales").fetch(null, range.fromTs, range.toTs));
    assert.strictEqual(sales.footer, "Gross sales: $50.00 · Returns: -$20.00 · Net sales: $30.00");
    assert.strictEqual(sales.rows.filter(x=>x[3]==="Return").length, 2);
    const pay = plain(vm.runInContext(`paymentBreakdownWithRefunds(paymentMethodTotals(null, "${range.fromTs}", "${range.toTs}"), null, "${range.fromTs}", "${range.toTs}")`, A.ctx));
    assert.deepStrictEqual(pay.map(p=>[p.method,p.total,p.refunds,p.net]), [["Cash",30,20,10],["Credit",20,0,20]]);
    const margin = plain(cfg("margin").fetch(null, range.fromTs, range.toTs));
    const rice = margin.rows.find(x=>/Rice/.test(x[0]));
    assert.deepStrictEqual(rice.slice(1,5), [1, "$10.00", "$12.00", "$-2.00"], "qty 3-2; revenue 30-20; cost 18-6 (restocked only)");
    const trend = plain(cfg("salestrend").fetch(null, range.fromTs, range.toTs, "day"));
    assert.strictEqual(cfg("salestrend").label, "Sales Trend (net of returns)");
    assert.deepStrictEqual(trend.rows, [["2026-10-07","$30.00","$50.00","-$20.00"]]);
    const ret = plain(cfg("returns").fetch(null, range.fromTs, range.toTs, null, null, { filters:{} }));
    assert.strictEqual(ret.rows.length, 2);
    assert.match(ret.footer, /2 credit notes · \$20\.00 · Cash \$20\.00 · 1 unit\(s\) back to stock, 1 written off/);
    assert.strictEqual(plain(cfg("returns").fetch(null, range.fromTs, range.toTs, null, null, { filters:{ condition:"writeoff" } })).rows.length, 1);
    assert.strictEqual(plain(cfg("returns").fetch(null, range.fromTs, range.toTs, null, null, { filters:{ reason:"Wrong item" } })).rows.length, 0);
    const led = plain(cfg("itemledger").fetch(null, range.fromTs, range.toTs, null, null, { filters:{ product:String(P(A,"RICE").id) } }));
    assert.deepStrictEqual(led.rows.map(x=>[x[1],x[3],x[4]]), [["Opening balance","+50","50"],["Sale","-3","47"],["Return (back to stock)","+1","48"],["Return (damaged)","+1","49"],["Written off (damaged return)","-1","48"]]);
    assert.match(led.footer, /RICE Rice · opening 0 · in \+52 · out -4 · closing 48/);
    // no returns: the reports read exactly as before
    const B = shop(); sell(B, [["RICE",1]], "Cash");
    assert.strictEqual(plain(B.api.REPORT_CONFIGS.find(c=>c.id==="sales").fetch(null, range.fromTs, range.toTs)).footer, "Grand Total: $10.00");
  });

  // ================= shared branch stock (Phase 3b): restock via the branch, write-off never =================
  await t("shared-stock branch: restock queued for the branch (sellable after sync, online and offline); write-off makes no server change", async ()=>{
    const { LIVE_STUB } = require("../supabase/tests/live-stub");
    const { PGlite } = await import("@electric-sql/pglite");
    const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
    const pg = new PGlite({ extensions:{ pgcrypto } });
    await pg.exec(LIVE_STUB);
    for(const f of ["20261004120000_multi_terminal_identity","20261004180000_multi_terminal_phase2","20261006120000_catalogue_sync","20261007120000_shared_stock"])
      await pg.exec(fs.readFileSync(path.join(__dirname,"..","supabase","migrations",f+".sql"),"utf8"));
    let OFF = false;
    const CASTS = { p_rows:"::jsonb", p_lines:"::jsonb", p_moves:"::jsonb", p_sales:"::jsonb", p_counts:"::jsonb", p_uids:"::text[]", p_branch_id:"::uuid", p_cursor:"::bigint", p_limit:"::integer" };
    const JSONB = ["p_rows","p_lines","p_moves","p_sales","p_counts"];
    const rpc = async (name, body)=>{
      if(OFF) return { ok:false, reason:"offline" };
      const keys = Object.keys(body);
      const vals = keys.map(k=> JSONB.includes(k)? JSON.stringify(body[k]) : k==="p_uids"? "{"+body[k].join(",")+"}" : body[k]);
      await pg.exec("set role anon");
      try{ const data = (await pg.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}${CASTS[k]||""}`).join(",")})::json j`, vals)).rows[0].j;
        return (data && data.error)? { ok:false, reason:"refused", code:data.error, data } : { ok:true, data }; }
      catch(e){ return { ok:false, reason:"rejected", message:e.message }; }
      finally{ await pg.exec("reset role"); }
    };
    const dev = (install)=>{ const A = shop({ settings:{ install_id:install, secret_phrase:"Gold Leaf 42" } }); A.hook("terminalRpc", rpc); A.hook("getThumb", async ()=>null); A.hook("downloadDb", ()=>{}); return A; };
    const T1 = dev("TIL1");
    const reg = (await T1.api.registerMainBranch("Front")).data;
    await T1.api.catalogueSyncNow({}); await T1.api.catApplyBaseline({}); await T1.api.catalogueSyncNow({});
    const T2 = dev("TIL2");
    T2.api.run("UPDATE products SET stock=0"); T2.api.run("DELETE FROM stock_movements");
    const code = (await T1.api.issueJoinCode({ branchId:reg.branch_id })).data.code;
    const j = await T2.api.joinBusiness({ phrase:"Gold Leaf 42", code, label:"till", devicePhrase:"Gold Leaf 42", expectedBranchName:null });
    assert.ok(j.ok, JSON.stringify(j));
    T2.api.setSetting("branch_name", j.data.branch_name); T2.api.setSetting("branch_type", "main");
    await T2.api.catalogueSyncNow({}); await T2.api.catApplyBaseline({}); await T2.api.catalogueSyncNow({});
    await T1.api.stockSyncNow({});
    const st = await T1.api.sharedStockStart("9999");
    assert.ok(st.ok, JSON.stringify(st));
    await T2.api.stockSyncNow({});
    assert.strictEqual(T1.api.sharedStockTill(), true);
    const branch = async ()=> (await pg.query(`select bs.total, bs.available from cl_branch_stock bs join cl_catalogue_products c on c.product_uid=bs.product_uid where c.code='RICE'`)).rows[0];
    const before = await branch();
    // T1 sells 3 rice online, then returns 1 good and 1 damaged
    const p = P(T1,"RICE");
    T1.api.setCart([{ product_id:p.id, name:p.name, price:10, qty:3, stock:T1.api.sellableNow(p) }]); T1.setField("paymentRef","");
    await T1.api.completeSale("Cash");
    const s = T1.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
    assert.strictEqual((await branch()).total, before.total - 3);
    const ledgerBefore = T1.api.stockLedgerCheck().mismatches.length;
    doReturn(T1, s, [["RICE",1,"restock"]]);
    assert.strictEqual(P(T1,"RICE").stock_pending_in, 1, "queued for the branch: '+1 pending'");
    assert.deepStrictEqual(plain(T1.api.ssPending()).map(r=>JSON.parse(r.payload_json)).map(m=>m.kind+" "+m.delta), ["return 1"]);
    doReturn(T1, s, [["RICE",1,"writeoff"]], "same", { reason:"Faulty / damaged" });
    assert.strictEqual(T1.api.ssPending().length, 1, "the write-off queues nothing");
    assert.strictEqual(T1.api.stockLedgerCheck().mismatches.length, ledgerBefore, "the till's ledger still balances");
    await T1.api.stockSyncNow({});
    assert.strictEqual((await branch()).total, before.total - 3 + 1, "online: the good one is branch stock after the sync; the damaged one never");
    assert.strictEqual(P(T1,"RICE").stock_pending_in, 0);
    // offline: the return waits until the till reconnects
    const s2 = T1.api.one("SELECT * FROM sales WHERE id=?",[s.id]);
    OFF = true; T1.ctx.navigator.onLine = false;
    T1.api.setCart([]);
    const s3p = P(T1,"RICE");
    doReturn(T1, s2, [["RICE",1,"restock"]]);
    assert.strictEqual(P(T1,"RICE").stock_pending_in, 1);
    assert.strictEqual(P(T1,"RICE").stock, s3p.stock, "not sellable on this till while offline");
    assert.strictEqual((await branch()).total, before.total - 2, "the server hasn't heard yet");
    OFF = false; T1.ctx.navigator.onLine = true; T1.api.setSetting("stock_reach","ok");
    await T1.api.stockSyncNow({});
    assert.strictEqual((await branch()).total, before.total - 1, "after sync: in branch stock");
    const bal = await T1.api.sharedStockBalance();
    assert.ok(bal.ok && bal.data.mismatches.length===0, "Diagnostics: branch stock balances "+JSON.stringify(bal.data && bal.data.mismatches));
    ledgerOk(T1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
