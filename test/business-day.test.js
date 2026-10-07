// Run: node --no-warnings test/business-day.test.js
// The business day (owner decision 2026-10-07): a moment's business date is
// the local date of (moment − cut-off hours), cut-off 00:00–06:00 set in
// Settings (default 00:00). Reports, Sales Trend buckets, shifts and the
// End of Day cash-up all use it, so they always agree. Stored timestamps
// stay UTC; filtering turns business days into UTC instants.
//
// Pinned: TZ=Africa/Harare (UTC+2, no DST) and the app's clock, at 23:30,
// 00:30, 01:30, 02:30 (and 03:30) local, with cut-off 00:00 and 03:00.
"use strict";
process.env.TZ = "Africa/Harare";   // before any Date is made, here or in the app realm
const assert = require("assert");
const vm = require("vm");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}
const plain = (x)=>JSON.parse(JSON.stringify(x));
// local Harare wall-clock time -> epoch ms
const at = (s)=> Date.parse(s+":00+02:00");

function shop(cutoff){
  const A = makeApp({ setup_complete:"1", shop_name:"Gentronix", branch_name:"Harare", branch_type:"main", currency:"$" });
  // the app's clock: every `new Date()` / Date.now() in the app realm reads __now
  vm.runInContext(`(function(){ const R = Date; globalThis.__now = R.now();
    class D extends R { constructor(...a){ if(a.length) super(...a); else super(globalThis.__now); } static now(){ return globalThis.__now; } }
    Date = D; })()`, A.ctx);
  A.clock = (s)=>{ A.ctx.__now = at(s); };
  A.fn = (name)=> vm.runInContext(`typeof ${name}==="function"? ${name} : undefined`, A.ctx);
  A.call = (name, ...args)=>{ const f = A.fn(name); if(!f) throw new Error(name+"() does not exist"); return f(...args); };
  A.api.run("INSERT INTO staff(name,role,passcode,branch,active,created_ts) VALUES('Owner','Admin','9999','Harare',1,'x')");
  A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES('Rice',1,1000,3,'RICE','Harare','',0.5,'2026-01-01','')");
  A.hook("printReceipt", ()=>{}); A.hook("alert", (m)=>{ A.alerts.push(String(m)); });
  A.alerts = [];
  if(cutoff) A.api.setSetting("business_day_cutoff", String(cutoff));
  return A;
}
// a cash sale of `amount` at local time `when`
function sell(A, when, amount){
  A.clock(when);
  const p = A.api.one("SELECT * FROM products WHERE sku='RICE'");
  A.api.setCart([{ product_id:p.id, name:p.name, price:1, qty:amount, stock:p.stock }]);
  A.alerts.length = 0;
  A.api.completeSale("Cash");
  const s = A.api.one("SELECT * FROM sales ORDER BY id DESC LIMIT 1");
  assert.ok(s && s.total===amount && !A.alerts.length, "sale of "+amount+" at "+when+" went through"+(A.alerts.length? ": "+A.alerts.join(" | ") : ""));
  return s;
}
// the Sales Report and the Sales Trend for business days from..to, through the app's own range
function salesReport(A, from, to){
  const r = A.call("businessRange", from, to);
  const cfg = A.api.REPORT_CONFIGS.find(c=>c.id==="sales");
  return plain(cfg.fetch(null, r.fromTs, r.toTs)).rows.length;
}
function trend(A, from, to, gran){
  const r = A.call("businessRange", from, to);
  const cfg = A.api.REPORT_CONFIGS.find(c=>c.id==="salestrend");
  const d = plain(cfg.fetch(null, r.fromTs, r.toTs, gran));
  return Object.fromEntries(d.rows.map(row=>[row[0], Number(String(row[1]).replace(/[^0-9.]/g,""))]));
}
const total = (A, from, to)=>{ const r = A.call("businessRange", from, to);
  return plain(A.api.paymentMethodTotals(null, r.fromTs, r.toTs)).reduce((s,x)=>s+x.total,0); };

(async()=>{
  // ---------------- the rule itself ----------------
  await t("business date of a moment: cut-off 00:00 = local midnight; 03:00 moves 00:00–02:59 to the day before", async ()=>{
    const A = shop(0), B = shop(3);
    const cases = [["2026-10-06T23:30","2026-10-06","2026-10-06"],["2026-10-07T00:30","2026-10-07","2026-10-06"],
                   ["2026-10-07T01:30","2026-10-07","2026-10-06"],["2026-10-07T02:30","2026-10-07","2026-10-06"],["2026-10-07T03:30","2026-10-07","2026-10-07"]];
    for(const [when, c0, c3] of cases){
      assert.strictEqual(A.call("businessDateOf", new Date(at(when)).toISOString()), c0, "cut-off 00:00 at "+when);
      assert.strictEqual(B.call("businessDateOf", new Date(at(when)).toISOString()), c3, "cut-off 03:00 at "+when);
    }
    A.clock("2026-10-07T00:30");
    assert.strictEqual(A.call("localDateStr", new A.ctx.Date()), "2026-10-07", "localDateStr is the local calendar date");
  });

  await t("a business day as UTC instants: cut-off 00:00 and 03:00 (stored data is UTC)", async ()=>{
    assert.deepStrictEqual(plain(shop(0).call("businessRange", "2026-10-07", "2026-10-07")),
      { fromTs:"2026-10-06T22:00:00.000Z", toTs:"2026-10-07T21:59:59.999Z", from:"2026-10-07", to:"2026-10-07" });
    assert.deepStrictEqual(plain(shop(3).call("businessRange", "2026-10-06", "2026-10-07")),
      { fromTs:"2026-10-06T01:00:00.000Z", toTs:"2026-10-08T00:59:59.999Z", from:"2026-10-06", to:"2026-10-07" });
  });

  // ---------------- cut-off 00:00: midnight closes the day ----------------
  await t("cut-off 00:00: shift, sales, End of Day and reports all split at local midnight", async ()=>{
    const A = shop(0);
    A.clock("2026-10-06T23:00");
    assert.strictEqual(A.api.startShift("0").date, "2026-10-06");
    sell(A, "2026-10-06T23:30", 10);
    A.clock("2026-10-07T00:30");
    assert.strictEqual(A.api.businessDateToday(), "2026-10-07");
    assert.match(A.api.shiftBlockReason(), /2026-10-06's shift hasn't been completed yet/, "after midnight yesterday's shift must be closed first");
    assert.strictEqual(A.api.eodTotalsFor("Harare", "2026-10-06", 0).cash, 10, "6 Oct cash-up: the 23:30 sale only");
    assert.strictEqual(A.api.completeEOD("10").expected_cash, 10);
    assert.strictEqual(A.api.startShift("0").date, "2026-10-07");
    sell(A, "2026-10-07T00:30", 20); sell(A, "2026-10-07T01:30", 30); sell(A, "2026-10-07T02:30", 40);
    assert.strictEqual(A.api.eodTotalsFor("Harare", "2026-10-07", 0).cash, 90, "7 Oct cash-up: 00:30, 01:30, 02:30");
    assert.strictEqual(A.api.completeEOD("90").variance, 0);
    assert.strictEqual(salesReport(A, "2026-10-06", "2026-10-06"), 1, "Sales Report 6 Oct");
    assert.strictEqual(salesReport(A, "2026-10-07", "2026-10-07"), 3, "Sales Report 7 Oct");
    assert.strictEqual(total(A, "2026-10-07", "2026-10-07"), 90, "payment totals 7 Oct");
    assert.deepStrictEqual(trend(A, "2026-10-06", "2026-10-07", "day"), { "2026-10-06":10, "2026-10-07":90 });
  });

  // ---------------- cut-off 03:00: the night belongs to the day before ----------------
  await t("cut-off 03:00: 23:30–02:30 is one business day (6 Oct); 03:30 starts 7 Oct", async ()=>{
    const A = shop(3);
    A.clock("2026-10-06T23:00");
    assert.strictEqual(A.api.startShift("0").date, "2026-10-06");
    sell(A, "2026-10-06T23:30", 10);
    A.clock("2026-10-07T01:30");
    assert.strictEqual(A.api.businessDateToday(), "2026-10-06");
    assert.strictEqual(A.api.shiftBlockReason(), "", "still 6 Oct's shift: selling goes on");
    sell(A, "2026-10-07T00:30", 20); sell(A, "2026-10-07T01:30", 30); sell(A, "2026-10-07T02:30", 40);
    assert.strictEqual(A.api.eodTotalsFor("Harare", "2026-10-06", 0).cash, 100, "6 Oct cash-up takes the whole night");
    A.clock("2026-10-07T02:45");
    assert.strictEqual(A.api.completeEOD("100").expected_cash, 100);
    A.clock("2026-10-07T03:30");
    assert.strictEqual(A.api.startShift("0").date, "2026-10-07");
    sell(A, "2026-10-07T03:30", 50);
    assert.strictEqual(A.api.eodTotalsFor("Harare", "2026-10-07", 0).cash, 50);
    assert.strictEqual(salesReport(A, "2026-10-06", "2026-10-06"), 4, "Sales Report 6 Oct");
    assert.strictEqual(salesReport(A, "2026-10-07", "2026-10-07"), 1, "Sales Report 7 Oct");
    assert.deepStrictEqual(trend(A, "2026-10-06", "2026-10-07", "day"), { "2026-10-06":100, "2026-10-07":50 });
  });

  await t("Sales Trend month and week buckets use the business date", async ()=>{
    for(const [cutoff, month, week] of [[0, "2026-11", "2026-10-12"], [3, "2026-10", "2026-10-05"]]){
      const A = shop(cutoff);
      A.clock("2026-11-01T01:00"); A.api.startShift("0");   // the shift of that moment's business day
      sell(A, "2026-11-01T01:00", 7);                       // 1 Nov 01:00 (Sunday night)
      assert.deepStrictEqual(trend(A, "2026-10-01", "2026-11-30", "month"), { [month]:7 }, "month, cut-off "+cutoff);
      const B = shop(cutoff);
      B.clock("2026-10-12T00:30"); B.api.startShift("0");
      sell(B, "2026-10-12T00:30", 5);                       // Monday 12 Oct 00:30
      assert.deepStrictEqual(trend(B, "2026-10-01", "2026-10-31", "week"), { [week]:5 }, "week, cut-off "+cutoff);
    }
  });

  // ---------------- the setting ----------------
  await t("Settings: Admin passcode, refused while a shift is open, 00:00–06:00 only, logged", async ()=>{
    const A = shop(0);
    const set = (h, pc)=> A.call("setBusinessDayCutoff", h, pc);
    A.clock("2026-10-07T10:00");
    A.api.startShift("0");
    assert.throws(()=>set(3, "9999"), /Complete the open shift \(2026-10-07/, "refused while a shift is open");
    A.api.completeEOD("0");
    assert.throws(()=>set(3, "0000"), /Incorrect Admin passcode/);
    assert.throws(()=>set(7, "9999"), /00:00 to 06:00/);
    assert.strictEqual(A.call("businessCutoffHours"), 0, "nothing changed");
    set(3, "9999");
    assert.strictEqual(A.call("businessCutoffHours"), 3);
    const log = A.api.one("SELECT * FROM audit_log WHERE action='Business day end changed' ORDER BY id DESC LIMIT 1");
    assert.ok(log && /00:00 → 03:00/.test(log.details), JSON.stringify(log));
  });

  await t("Settings: refused between midnight and the later cut-off, when the old and new rules disagree on today", async ()=>{
    const A = shop(0);
    A.clock("2026-10-06T23:00"); A.api.startShift("0"); sell(A, "2026-10-06T23:30", 10);
    A.clock("2026-10-07T00:10"); A.api.completeEOD("10");
    A.clock("2026-10-07T01:30");
    A.api.businessDateToday();                                   // the till has seen 7 Oct
    assert.throws(()=>A.call("setBusinessDayCutoff", 3, "9999"), /Change this after 03:00/);
    assert.strictEqual(A.call("businessCutoffHours"), 0);
    A.clock("2026-10-07T03:30");
    assert.deepStrictEqual(plain(A.call("setBusinessDayCutoff", 3, "9999")), { changed:true });
    const B = shop(3);
    B.clock("2026-10-07T01:30");                                   // business date 6 Oct under 03:00
    assert.throws(()=>B.call("setBusinessDayCutoff", 0, "9999"), /Change this after 03:00/);
  });

  // ---------------- compatibility ----------------
  await t("never goes backwards: a later stored business date wins (e.g. an old UTC-era high-water mark)", async ()=>{
    const A = shop(3);
    A.api.setSetting("business_date_hwm", "2026-10-07");      // written earlier the same night by the old UTC rule
    A.clock("2026-10-07T02:30");                               // cut-off 03:00 says 6 Oct
    assert.strictEqual(A.api.businessDateToday(), "2026-10-07", "the watermark is kept: the business date never goes back");
    A.clock("2026-10-07T09:00");
    assert.strictEqual(A.api.businessDateToday(), "2026-10-07");
  });

  await t("export filenames and defaults use the local date, not UTC", async ()=>{
    const A = shop(0);
    A.clock("2026-10-07T00:30");
    assert.match(A.call("exportFilename", "Backup", "Harare"), /^Backup-Harare-2026-10-07-00-30-00\.sqlite$/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
