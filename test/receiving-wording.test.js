// node test/receiving-wording.test.js
//
// "Received at the other branch, but no quantity added" (owner test,
// 2026-10-13; diagnosis reports/2026-10-13-1034-received-no-qty.md): no
// stock bug, but the words were too close. The REAL app screens (test/harness.js
// with a JSDOM document), on two devices, Harare CBD -> Sothleapark by file:
//   - Receive stock says which device the stock goes to, and after Accept
//     shows each line before -> after ("Pants: 4 -> 7");
//   - Import GRV / reply carries the hint "... never changes stock ... use
//     Receive stock";
//   - a Delivery Note file given to Import GRV says which button, on which
//     branch's device, and changes nothing (on the receiver and on the sender);
//   - the sender's Dispatch history says "Received at Sothleapark (their
//     GRV-...)" and "Stock went up on their device, not here.", and the
//     sender's own stock doesn't move.
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}
async function waitFor(cond, what){
  const end = Date.now() + 5000;
  while(Date.now() < end){ const v = cond(); if(v) return v; await new Promise((r)=> setTimeout(r, 10)); }
  throw new Error("timed out waiting for " + what);
}

(async ()=>{
  const device = (branch, till)=> makeApp({ setup_complete:"1", shop_name:"Chipo Clothing", branch_name:branch, branch_id:"B-" + branch.replace(/\W/g, "").toUpperCase().slice(0, 8), till_code:till, install_date:"2026-09-01", branch_type:"main" }, { dom:true });
  const H = device("Harare CBD", "T1"), S = device("Sothleapark", "T1");
  const addProduct = (A, sku, name, stock)=>{
    A.api.run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,cost,created_ts) VALUES(?,?,?,?,?,?,?,?)", [name, 5, stock, 1, sku, A.api.currentBranch(), 2, new Date().toISOString()]);
  };
  const P = (A, sku)=> A.api.one("SELECT * FROM products WHERE sku=? AND branch=?", [sku, A.api.currentBranch()]);
  addProduct(H, "PNT001", "Pants", 20);
  addProduct(S, "PNT001", "Pants", 4);
  H.api.run("INSERT INTO branch_register(name) VALUES('Sothleapark')");
  const dispatch = async (qty)=>{
    const dn = H.api.dnCommitDispatch({ branch:"Harare CBD", toBranch:"Sothleapark", now:new Date(), lines:[{ product:P(H, "PNT001"), qty }], srv:null });
    return { n:dn.n, text:(await H.api.dnBuildFromDb(H.api.dnHeaderFor(dn.n))).text };
  };
  const modal = (A)=> A.dom.window.document.querySelector(".modalOverlay:last-of-type .modal-body");
  const closeModals = (A)=> A.dom.window.document.querySelectorAll(".modalOverlay").forEach((m)=> m.remove());
  const text = (el)=> (el && el.textContent || "").replace(/\s+/g, " ").trim();

  const dn1 = await dispatch(3);

  await t("Receive stock says which device the stock goes to, before the file and on the review", async ()=>{
    S.api.openReceiveScreen(null);
    const d = S.dom.window.document.getElementById("rcDevice");
    assert.strictEqual(text(d), "This device: Sothleapark T1 (phone app). Stock is added on this device only.");
    closeModals(S);
  });

  await t("Accept shows each line before -> after (Pants: 4 -> 7), and the stock really is 7", async ()=>{
    S.api.openReceiveScreen(S.File(dn1.text, "DN.json"));
    await waitFor(()=> S.dom.window.document.getElementById("rcAccept"), "the review");
    assert.match(text(S.dom.window.document.getElementById("rcReviewDevice")), /^This device: Sothleapark T1 \(phone app\)\./);
    S.dom.window.document.getElementById("rcAccept").onclick();
    await S.dom.window.document.getElementById("rcYes").onclick();
    const moved = await waitFor(()=> S.dom.window.document.getElementById("rvMoved"), "the voucher");
    assert.strictEqual(text(moved), "Pants: 4 → 7");
    assert.strictEqual(P(S, "PNT001").stock, 7);
    closeModals(S);
  });

  await t("rcMovedLines: a shared-stock till (stock moves when the branch syncs) says +qty instead", async ()=>{
    assert.deepStrictEqual(JSON.parse(JSON.stringify(S.api.rcMovedLines([{ name:"Rice", qty:2, before:5, after:5 }]))), ["Rice: +2 (added to the branch's stock when it syncs)"]);
  });

  await t("Import GRV / reply carries the hint (sender's Dispatch history and the Import screen)", async ()=>{
    H.api.openDispatchHistory();
    assert.strictEqual(text(H.dom.window.document.getElementById("dhImportHint")), H.api.GRV_IMPORT_HINT);
    assert.match(H.api.GRV_IMPORT_HINT, /It never changes stock\. To take in goods sent TO this branch, use Receive stock on Products\./);
    closeModals(H);
    H.api.openGrvImportScreen(null);
    assert.strictEqual(text(H.dom.window.document.getElementById("giHint")), H.api.GRV_IMPORT_HINT);
    closeModals(H);
  });

  await t("a Delivery Note file given to Import GRV on the RECEIVER: names Receive stock on a Sothleapark device; nothing changes", async ()=>{
    const before = JSON.stringify(S.api.all("SELECT * FROM dispatch_docs ORDER BY dn_no")), stock = P(S, "PNT001").stock;
    S.api.openGrvImportScreen(S.File(dn1.text, "DN.json"), ()=>{});
    const b = await waitFor(()=> { const m = modal(S); return m && /Delivery Note/.test(m.textContent) && m; }, "the message");
    assert.match(text(b), /^This is a Delivery Note for Sothleapark \(DN-T1-0001 from Harare CBD\): open it with Receive stock \(Products\) on a Sothleapark device\. Import GRV is only for the voucher the other branch sends back\. Nothing was changed\./);
    assert.strictEqual(JSON.stringify(S.api.all("SELECT * FROM dispatch_docs ORDER BY dn_no")), before);
    assert.strictEqual(P(S, "PNT001").stock, stock);
    closeModals(S);
  });

  await t("... and on the SENDER: 'the Delivery Note this branch sent to Sothleapark ... send it to them'; nothing changes", async ()=>{
    const h = JSON.stringify(H.api.dnHeaderFor(dn1.n)), stock = P(H, "PNT001").stock;
    H.api.openGrvImportScreen(H.File(dn1.text, "DN.json"), ()=>{});
    const b = await waitFor(()=> { const m = modal(H); return m && /Delivery Note/.test(m.textContent) && m; }, "the message");
    assert.match(text(b), /^This is DN-T1-0001, the Delivery Note this branch sent to Sothleapark\. Send it to Sothleapark: they take it in with Receive stock on a Sothleapark device\. Import GRV is for the voucher they send back\. Nothing was changed\./);
    assert.strictEqual(JSON.stringify(H.api.dnHeaderFor(dn1.n)), h);
    assert.strictEqual(P(H, "PNT001").stock, stock);
    closeModals(H);
  });

  await t("the sender's Dispatch history after the GRV comes back: 'Received at Sothleapark (their GRV-T1-0001)', 'Stock went up on their device, not here.'; its own stock doesn't move", async ()=>{
    // Sothleapark's GRV for DN-T1-0001, as its Accept built it (the same functions)
    const rec = S.api.incomingHeader(H.api.getBranchId(), dn1.n);
    assert.strictEqual(rec.status, "received");
    const grvDoc = await S.api.buildGRVFromCommit(JSON.parse(dn1.text), { grv:{ n:rec.grv_no, till:rec.grv_till_code }, header:rec, receivedIso:rec.received_iso, internalRef:rec.grv_internal_ref });
    const grvText = S.api.serializeGRV(grvDoc);
    const stock = P(H, "PNT001").stock;
    H.api.openGrvImportScreen(H.File(grvText, "GRV.json"), ()=>{});
    await waitFor(()=> { const m = modal(H); return m && /confirmed/.test(m.textContent) && m; }, "the GRV import");
    closeModals(H);
    H.api.openDispatchHistory();
    const status = text(H.dom.window.document.querySelector(".dh-status"));
    assert.match(status, /^Received at Sothleapark \(their GRV-T1-0001\)$/);
    assert.match(text(H.dom.window.document.querySelector(".dh-received")), /Stock went up on their device, not here\.$/);
    assert.strictEqual(P(H, "PNT001").stock, stock, "the sender's stock went down at dispatch only");
    assert.strictEqual(stock, 17);
    closeModals(H);
  });

  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
