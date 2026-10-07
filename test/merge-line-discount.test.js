// Run: node --no-warnings test/merge-line-discount.test.js
// mergeDatabase (backup.js) copied sale_items without their line discount,
// so on main a merged sale lost its per-line discounts (the sale-level
// sales.discount always came across, so totals were right). Rows merged
// before the fix keep 0: a re-merge skips them by uid and nothing rewrites them.
"use strict";
process.env.TZ = "UTC";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}
function rig(branch, type){ return makeApp({ branch_name:branch, branch_type:type, setup_complete:"1" }); }
function remoteWithDiscountedSale(){
  const R = rig("Boka","remote");
  R.api.run("INSERT INTO products(name,price,stock,low_threshold,branch,sku) VALUES('Rice',10,50,3,'Boka','RICE')");
  const p = R.api.one("SELECT * FROM products WHERE sku='RICE'");
  R.api.startShift("0");
  R.hook("printReceipt", ()=>{});
  R.api.setCart([{ product_id:p.id, name:p.name, price:10, qty:3, stock:p.stock, discount:4 }]);
  R.setField("discountReason", "Loyal customer");
  R.api.completeSale("Cash");
  return R;
}

(async()=>{
  await t("a merged sale keeps its line discount", async ()=>{
    const R = remoteWithDiscountedSale();
    assert.strictEqual(R.api.one("SELECT discount FROM sale_items").discount, 4);
    const M = rig("Main","main");
    await M.api.mergeDatabase({ __db:R.db });
    const it = M.api.one("SELECT si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.branch='Boka'");
    assert.strictEqual(it.discount, 4, "line discount came across");
    assert.strictEqual(M.api.one("SELECT discount, total FROM sales WHERE branch='Boka'").total, 26);
  });
  await t("a row merged before the fix keeps discount 0; merging again doesn't change it", async ()=>{
    const R = remoteWithDiscountedSale();
    const M = rig("Main","main");
    await M.api.mergeDatabase({ __db:R.db });
    M.api.run("UPDATE sale_items SET discount=0");                 // as an old merge left it
    await M.api.mergeDatabase({ __db:R.db });
    assert.strictEqual(M.api.all("SELECT * FROM sale_items").length, 1, "no duplicate line");
    assert.strictEqual(M.api.one("SELECT discount FROM sale_items").discount, 0, "old merged rows read as before");
    assert.strictEqual(M.api.one("SELECT discount FROM sales WHERE branch='Boka'").discount, 4, "the sale-level discount was always there");
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
