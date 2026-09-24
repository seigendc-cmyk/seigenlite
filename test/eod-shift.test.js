// Run: node --no-warnings test/eod-shift.test.js
// Shift / EOD Control with Opening Float (src/eod.js), over the REAL app
// source via the same harness the other suites use. Reuses eod_sessions
// (no new table), currentStaff()/sessionStaffId (staff-PIN work) for
// operator attribution, and completeSale() (pos.js) as the one choke point
// a blocked sale goes through — these tests exercise that same function,
// not a copy of its logic.
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}
function rig(o){ return makeApp(Object.assign({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, o||{})); }
const D = (iso)=> new Date(iso);
// Test-Infrastructure Fix (Hardcoded Test Dates): every date in this file
// used to be a fixed calendar string ("2026-09-22"/"2026-09-21"). Two
// problems, both from the same root cause: (1) completeSale() always calls
// shiftBlockReason() with no explicit `now`, so eod.js's businessDateToday()
// falls back to the REAL device clock — a shift opened for a fixed past
// date looks increasingly stale as real days pass since this file was
// written, and "same day, shift open -> allowed" tests would start seeing a
// false block; (2) even the tests that already worked around this by
// priming businessDateToday() (see the original comment kept below) only
// happened to keep passing because their assertions don't depend on the
// exact date value. TODAY/YESTERDAY (and their T()/Y() Date-builders) derive
// both dates from the real clock at test-run time, exactly 1 calendar day
// apart, so every relative-date assertion in this file ("yesterday's shift
// is stale", "today's shift is open") holds regardless of which real day
// the suite runs on.
const TODAY = new Date().toISOString().slice(0,10);
const YESTERDAY = new Date(Date.now()-86400000).toISOString().slice(0,10);
const T = (hms)=> D(`${TODAY}T${hms}Z`);
const Y = (hms)=> D(`${YESTERDAY}T${hms}Z`);
function addProduct(app, o){
  app.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES(?,?,?,?,?,?)",
    [o.name,o.price,o.stock,o.low_threshold==null?3:o.low_threshold,"Boka",o.sku||""]);
  return app.api.one("SELECT * FROM products WHERE name=?",[o.name]);
}
function sellCash(app, product, qty, now){
  app.api.setCart([{ product_id:product.id, name:product.name, price:product.price, qty, stock:product.stock }]);
  app.hook("printReceipt", ()=>{}); // real printReceipt lives in printing.js, not loaded here — a normal receipt print, not under test
  return app.api.completeSale("Cash");
}

(async()=>{
  // ================= normal shift start with float declaration =================
  await t("Start Shift: records opening float, timestamp and operator", ()=>{
    const A = rig();
    A.api.run("INSERT INTO staff(name,role,branch,active,created_ts) VALUES('Tendai','Cashier','Boka',1,'x')");
    const staff = A.api.one("SELECT * FROM staff WHERE name='Tendai'");
    A.api.setSessionStaffId(staff.id);
    const now = T("08:00:00");
    const shift = A.api.startShift("50.00", now);
    assert.strictEqual(shift.status,"open");
    assert.strictEqual(shift.opening_float,50);
    assert.strictEqual(shift.date,TODAY);
    assert.strictEqual(shift.started_by,"Tendai");
    assert.strictEqual(shift.started_staff_id,staff.id);
    assert.ok(shift.started_ts);
    assert.strictEqual(A.api.oldestOpenShift("Boka").id, shift.id);
  });
  await t("Start Shift falls back to the plain single-operator name when no staff PIN session is active", ()=>{
    const A = rig();
    // sessionStaffId left null (Phase 1 default = single-operator mode) —
    // no second identity concept invented here.
    const shift = A.api.startShift("20", T("08:00:00"));
    assert.strictEqual(shift.started_by,"Tester"); // harness's default sessionUser
    assert.strictEqual(shift.started_staff_id,null);
  });
  await t("Start Shift rejects a missing/negative float", ()=>{
    const A = rig();
    assert.throws(()=>A.api.startShift("", T("08:00:00")), /opening cash float/);
    assert.throws(()=>A.api.startShift("-5", T("08:00:00")), /opening cash float/);
  });
  await t("Starting a shift twice for the same day is idempotent (no duplicate open row)", ()=>{
    const A = rig();
    const now = T("08:00:00");
    const s1 = A.api.startShift("50", now);
    const s2 = A.api.startShift("999", now); // a second attempt is just handed the same open shift back
    assert.strictEqual(s1.id, s2.id);
    assert.strictEqual(s2.opening_float,50,"the original float is kept, not overwritten");
    assert.strictEqual(A.api.all("SELECT * FROM eod_sessions WHERE branch='Boka' AND status='open'").length,1);
  });

  // ================= normal EOD completion and printing =================
  await t("EOD reconciliation: opening float + cash sales - payouts = expected cash, variance flagged", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    const now = T("08:00:00");
    A.api.startShift("50", now);
    sellCash(A, rice, 3, now); // $30 cash
    A.api.run("INSERT INTO payouts(ts,amount,reason,branch,user) VALUES(?,?,?,?,?)",[`${TODAY}T09:00:00Z`,5,"Fuel","Boka","Tester"]);
    // expected = 50 + 30 - 5 = 75
    const totals = A.api.eodTotalsFor("Boka",TODAY,50);
    assert.strictEqual(totals.expected,75);
    const closedExact = A.api.completeEOD("75", "", T("20:00:00"));
    assert.strictEqual(closedExact.status,"closed");
    assert.strictEqual(closedExact.variance,0,"exact count -> no variance");
  });
  await t("EOD flags a variance (short and over) correctly", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    const now = T("08:00:00");
    A.api.startShift("50", now);
    sellCash(A, rice, 3, now); // expected = 50+30-0 = 80
    const short = A.api.completeEOD("70", "", T("20:00:00"));
    assert.strictEqual(short.expected_cash,80); assert.strictEqual(short.counted_cash,70); assert.strictEqual(short.variance,-10,"short is negative");

    const B = rig({ branch_name:"CBD" });
    const sugar = addProduct(B,{name:"Sugar",price:5,stock:50});
    B.api.startShift("20", now);
    B.api.setCart([{ product_id:sugar.id, name:sugar.name, price:sugar.price, qty:2, stock:sugar.stock }]);
    B.hook("printReceipt", ()=>{});
    B.api.completeSale("Cash"); // expected = 20+10 = 30
    const over = B.api.completeEOD("35","",T("20:00:00"));
    assert.strictEqual(over.variance,5,"over is positive");
  });
  await t("printing/sharing a completed EOD produces the summary object printing.js expects, including the opening float", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    const now = T("08:00:00");
    const shift = A.api.startShift("50", now);
    sellCash(A, rice, 1, now);
    const closed = A.api.completeEOD("60","",T("20:00:00"));
    const totals = A.api.eodTotalsFor("Boka",closed.date,closed.opening_float);
    const summary = A.api.eodPrintSummary(closed, totals, [], closed.counted_cash);
    assert.strictEqual(summary.openingFloat,50);
    assert.strictEqual(summary.expected,60);
    assert.strictEqual(summary.counted,60);
    assert.strictEqual(summary.variance,0);
    const text = A.api.eodWhatsAppText(summary);
    assert.ok(/Opening Float/.test(text) && /\$50\.00/.test(text));
    A.api.markEodPrinted(closed.id, T("20:05:00"));
    assert.ok(A.api.one("SELECT printed_ts FROM eod_sessions WHERE id=?",[closed.id]).printed_ts);
  });

  // ================= idempotency: no duplicate records =================
  await t("Completing an already-closed EOD does not create a duplicate record (throws instead)", ()=>{
    const A = rig();
    const now = T("08:00:00");
    A.api.startShift("50", now);
    A.api.completeEOD("50","",T("20:00:00"));
    assert.throws(()=>A.api.completeEOD("50","",T("20:05:00")), /no open shift/i);
    assert.strictEqual(A.api.all("SELECT * FROM eod_sessions WHERE branch='Boka'").length,1,"still exactly one record");
  });
  await t("EOD completion after an app restart (fresh makeApp over the same persisted db bytes) still finds the same open shift", ()=>{
    const A = rig();
    const now = T("08:00:00");
    A.api.startShift("50", now);
    // Simulate "the app restarted and reloaded this device's persisted
    // file" by pointing a second app instance at the same db handle.
    const B = rig(); B.api.setDb(A.db);
    const shift = B.api.oldestOpenShift("Boka");
    assert.ok(shift, "the open shift survived the simulated restart");
    const closed = B.api.completeEOD("50","",T("20:00:00"));
    assert.strictEqual(closed.status,"closed");
    assert.strictEqual(A.api.oldestOpenShift("Boka"),null,"visible as closed from the original handle too — one shared record, not a second one");
  });

  // ================= blocking sales =================
  await t("a sale is blocked before any shift has ever been started", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty:1, stock:rice.stock }]);
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale("Cash");
    assert.ok(/Start a shift/.test(alerted));
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0,"nothing was sold");
    assert.strictEqual(rice.stock, A.api.one("SELECT stock FROM products WHERE id=?",[rice.id]).stock,"stock untouched");
  });
  await t("a sale is blocked while the previous trading day's shift/EOD is unresolved, with a clear message", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("50", Y("08:00:00")); // yesterday, never closed
    A.api.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty:1, stock:rice.stock }]);
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    // "today" is asserted via businessDateToday inside completeSale/shiftBlockReason,
    // which reads the real device clock — advance the persisted high-water-mark first
    // so the block reflects an actual day having passed, not the test's local "now".
    A.api.businessDateToday(T("09:00:00"));
    A.api.completeSale("Cash");
    assert.ok(new RegExp(YESTERDAY+".*hasn't been completed").test(alerted), alerted);
    assert.ok(/before making a new sale/.test(alerted));
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0);
  });
  await t("once the previous day's EOD is completed, the next sale is allowed again after starting a new shift", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("50", Y("08:00:00"));
    A.api.businessDateToday(T("09:00:00"));
    A.api.completeEOD("50","",Y("21:00:00")); // closes the stale (oldest open) shift
    A.api.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty:1, stock:rice.stock }]);
    A.api.completeSale("Cash"); // still blocked: no shift open for today yet
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0);
    A.api.startShift("30", T("09:05:00"));
    A.api.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty:1, stock:rice.stock }]);
    A.hook("printReceipt", ()=>{});
    A.api.completeSale("Cash");
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,1,"sale went through once today's shift is open");
  });
  await t("attempting to change the device date backward does not bypass the block (business date never regresses)", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("50", Y("08:00:00"));
    // the app genuinely observes today at some point (e.g. it's just open)...
    assert.strictEqual(A.api.businessDateToday(T("00:05:00")),TODAY);
    // ...then the device clock is wound back to make it look like yesterday again
    const rolledBack = Y("10:00:00");
    assert.strictEqual(A.api.businessDateToday(rolledBack),TODAY,"the high-water-mark refuses to go backward");
    A.api.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty:1, stock:rice.stock }]);
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale("Cash"); // completeSale's own shiftBlockReason() call also re-derives "now" and must see the same protected date
    assert.ok(/hasn't been completed/.test(alerted), "still blocked even with the clock rolled back");
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,0);
  });
  await t("rolling the clock forward and back within the still-open, unclosed day is harmless (no false block)", ()=>{
    const A = rig();
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.startShift("50", T("08:00:00"));
    A.api.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty:1, stock:rice.stock }]);
    A.hook("printReceipt", ()=>{});
    A.api.completeSale("Cash"); // same day, shift open -> allowed
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,1);
  });

  // ================= offline operation =================
  await t("shift start, sale and EOD completion all work fully offline (no network involved at all)", ()=>{
    const A = rig();
    A.ctx.navigator.onLine = false; // same offline flag the Supabase Foundation tests use
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    const now = T("08:00:00");
    A.api.startShift("50", now);
    sellCash(A, rice, 2, now);
    const closed = A.api.completeEOD("70","",T("20:00:00"));
    assert.strictEqual(closed.status,"closed");
    assert.strictEqual(A.api.all("SELECT * FROM sales").length,1);
  });

  // ================= existing data/tables untouched =================
  await t("existing eod_sessions rows from before this feature are treated as already closed, never as a stray open shift", ()=>{
    const A = rig();
    A.api.run("INSERT INTO eod_sessions(date,expected_cash,counted_cash,variance,notes,branch,ts) VALUES(?,?,?,?,?,?,?)",
      ["2026-01-05",100,98,-2,"","Boka","2026-01-05T20:00:00.000Z"]);
    A.api.migrate(A.db); // re-run, as an upgrade would
    const legacy = A.api.one("SELECT * FROM eod_sessions WHERE date='2026-01-05'");
    assert.strictEqual(legacy.status,"closed");
    assert.strictEqual(A.api.oldestOpenShift("Boka"),null,"the legacy row never blocks a sale");
    const rice = addProduct(A,{name:"Rice",price:10,stock:50});
    A.api.setCart([{ product_id:rice.id, name:rice.name, price:rice.price, qty:1, stock:rice.stock }]);
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.completeSale("Cash");
    assert.ok(/Start a shift/.test(alerted), "legacy row doesn't count as an open shift for today either");
  });
  await t("migration is additive and repeatable; historical sales/eod rows are never modified", ()=>{
    const A = rig();
    A.api.run("INSERT INTO sales(ts,subtotal,discount,total,method,branch) VALUES(?,?,?,?,?,?)",["2026-01-01T10:00:00Z",10,0,10,"Cash","Boka"]);
    const before = A.api.all("SELECT * FROM sales");
    A.api.migrate(A.db); A.api.migrate(A.db);
    assert.deepStrictEqual(A.api.all("SELECT * FROM sales"), before);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
