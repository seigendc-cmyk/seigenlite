// Run: node --no-warnings test/rpn-support-modal.test.js
// RPN linkage + Support handoff (src/rpn.js) and the Sync Reminder Modal
// (src/sync.js), over the REAL app source via the same harness the other
// suites use. All three feed the existing sync.js foundation — these tests
// assert exactly that: enqueueSync payloads/tenant scoping, and the modal
// reading pendingSyncCount()/pendingSyncRows() rather than a second query.
"use strict";
const assert = require("assert");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}
function rig(o){ return makeApp(Object.assign({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, o||{})); }
const RPN = { rpn_name:"Tendai Moyo", rpn_code:"RPN-014", rpn_whatsapp:"0771234567", city_area:"Harare CBD" };

(async()=>{
  // ================= Part A: RPN linkage =================
  await t("save: the local record is written via the existing settings table (no new table)", ()=>{
    const A = rig();
    const saved = A.api.saveRpnLink(RPN);
    assert.strictEqual(saved.rpn_name,"Tendai Moyo"); assert.strictEqual(saved.rpn_code,"RPN-014");
    assert.strictEqual(saved.rpn_whatsapp,"0771234567"); assert.strictEqual(saved.city_area,"Harare CBD");
    assert.strictEqual(A.api.getSetting("rpn_name",""),"Tendai Moyo","reuses the settings table, not a new one");
    assert.ok(A.api.getRpnLink().rpn_name==="Tendai Moyo");
  });
  await t("save: no validation against any registry — stored exactly as entered, including partial data", ()=>{
    const A = rig();
    const saved = A.api.saveRpnLink({ rpn_name:"", rpn_code:"XYZ", rpn_whatsapp:"", city_area:"" });
    assert.strictEqual(saved.rpn_code,"XYZ"); assert.strictEqual(saved.rpn_name,"");
  });
  await t("save enqueues via the EXISTING sync foundation: enqueueSync/sync_queue, not a parallel mechanism", ()=>{
    const A = rig();
    A.api.saveRpnLink(RPN);
    const rows = A.api.pendingSyncRows("rpn_link");
    assert.strictEqual(rows.length,1);
    assert.strictEqual(rows[0].record_type,"rpn_link");
    assert.strictEqual(A.api.syncTableFor("rpn_link"),"rpn_link","registerSyncType was called");
    const payload = JSON.parse(rows[0].payload_json);
    assert.strictEqual(payload.rpn_name,"Tendai Moyo"); assert.strictEqual(payload.rpn_code,"RPN-014");
    assert.strictEqual(payload.rpn_whatsapp,"0771234567"); assert.strictEqual(payload.city_area,"Harare CBD");
    assert.strictEqual(payload.tenant_id, A.api.tenantId(), "correct tenant on the payload");
    assert.strictEqual(rows[0].tenant_id, A.api.tenantId(), "correct tenant on the queue row itself");
    assert.ok(payload.updated_ts);
  });
  await t("persists offline: saving/editing RPN details doesn't touch the network and always succeeds locally", ()=>{
    const A = rig();
    A.ctx.navigator.onLine = false;
    A.api.saveRpnLink(RPN);
    assert.strictEqual(A.api.getRpnLink().rpn_name,"Tendai Moyo");
    assert.strictEqual(A.api.pendingSyncCount("rpn_link"),1,"queued locally, not lost because offline");
  });
  await t("edit: a later Save updates the local record AND enqueues a fresh sync (Part A.5)", ()=>{
    const A = rig();
    A.api.saveRpnLink(RPN);
    const edited = A.api.saveRpnLink(Object.assign({}, RPN, { rpn_code:"RPN-099", city_area:"Bulawayo" }));
    assert.strictEqual(edited.rpn_code,"RPN-099"); assert.strictEqual(edited.city_area,"Bulawayo");
    assert.strictEqual(A.api.getRpnLink().rpn_code,"RPN-099","local record updated");
    assert.strictEqual(A.api.pendingSyncRows("rpn_link").length,2,"a fresh sync record queued alongside the first");
    const latest = JSON.parse(A.api.pendingSyncRows("rpn_link")[1].payload_json);
    assert.strictEqual(latest.rpn_code,"RPN-099");
  });
  await t("hasRpnLink: false until something is saved, true once any field is set", ()=>{
    const A = rig();
    assert.strictEqual(A.api.hasRpnLink(),false);
    A.api.saveRpnLink({ rpn_code:"X" });
    assert.strictEqual(A.api.hasRpnLink(),true);
  });

  // ================= Part B: Support handoff =================
  await t("support tap with no RPN linked: prompts to complete RPN setup instead of failing silently", ()=>{
    const A = rig();
    let alerted = "";
    A.hook("alert",(m)=>{ alerted=m; });
    A.api.setRoute("more"); // so moreTab/settingsUnlocked land somewhere meaningful
    const result = A.api.openSupportHandoff();
    assert.strictEqual(result,"no_rpn");
    assert.ok(/No RPN is linked/.test(alerted));
    assert.strictEqual(A.api.getMoreTab(),"settings","routed to Settings to complete RPN setup");
    assert.strictEqual(A.api.getSettingsUnlocked(),false);
    assert.strictEqual(A.api.pendingSyncCount("support_task"),0,"nothing queued when there was nothing to send");
  });
  await t("support tap with RPN linked: opens WhatsApp via the existing wa.me mechanism, addressed to the RPN", ()=>{
    const A = rig();
    A.api.saveRpnLink(RPN);
    A.api.setSetting("shop_name","Gentronix"); A.api.setSetting("branch_name","Harare CBD");
    let opened = null;
    A.hook("openExternalUrl",(url)=>{ opened=url; });
    const result = A.api.openSupportHandoff();
    assert.strictEqual(result,"opened");
    assert.ok(opened, "openExternalUrl (the existing external-link mechanism) was used");
    assert.ok(opened.startsWith("https://wa.me/263771234567"), "addressed to the RPN's saved WhatsApp number, normalized");
    assert.ok(decodeURIComponent(opened).includes("Gentronix"), "pre-filled message identifies the tenant/business");
    assert.strictEqual(opened, A.api.waLink("0771234567", decodeURIComponent(opened.split("text=")[1])), "built with the app's existing waLink() helper");
  });
  await t("support tap enqueues a support_task via the existing sync foundation, with tenant id and RPN reference", ()=>{
    const A = rig();
    A.api.saveRpnLink(RPN);
    A.hook("openExternalUrl",()=>{});
    A.api.openSupportHandoff();
    const rows = A.api.pendingSyncRows("support_task");
    assert.strictEqual(rows.length,1);
    assert.strictEqual(A.api.syncTableFor("support_task"),"support_task","registerSyncType was called for this type too");
    const payload = JSON.parse(rows[0].payload_json);
    assert.strictEqual(payload.tenant_id, A.api.tenantId());
    assert.strictEqual(payload.rpn_code,"RPN-014"); assert.strictEqual(payload.rpn_whatsapp,"0771234567");
    assert.ok(payload.ts, "timestamped");
  });
  await t("each Support tap logs its own task record (two taps -> two queued records)", ()=>{
    const A = rig();
    A.api.saveRpnLink(RPN);
    A.hook("openExternalUrl",()=>{});
    A.api.openSupportHandoff();
    A.api.openSupportHandoff();
    assert.strictEqual(A.api.pendingSyncCount("support_task"),2);
  });

  // ================= Part C: Sync Reminder Modal =================
  await t("appears when offline with pending data", ()=>{
    const A = rig();
    A.api.setSetting("supabase_url","http://x"); A.api.setSetting("supabase_anon_key","k");
    A.ctx.navigator.onLine = false;
    A.api.enqueueSync("sync_health_check",{});
    assert.strictEqual(A.api.syncReminderShouldShow(),true);
  });
  await t("appears when unconfigured (even if navigator says online) with pending data", ()=>{
    const A = rig();
    A.api.enqueueSync("sync_health_check",{}); // no supabase config at all
    assert.strictEqual(A.api.syncReminderShouldShow(),true);
  });
  await t("does not appear when there is nothing pending", ()=>{
    const A = rig();
    A.ctx.navigator.onLine = false;
    assert.strictEqual(A.api.syncReminderShouldShow(),false);
  });
  await t("does not appear when online and configured, regardless of a (stale) pending row", ()=>{
    const A = rig();
    A.api.setSetting("supabase_url","http://x"); A.api.setSetting("supabase_anon_key","k");
    A.api.run("INSERT INTO sync_queue(record_type,record_key,tenant_id,payload_json,status,attempts,next_attempt_ts,created_ts,updated_ts) VALUES('x','','t','{}','pending',0,'','now','now')");
    assert.strictEqual(A.api.syncReminderShouldShow(),false);
  });
  await t("reuses the EXISTING pending-count logic (pendingSyncCount), not a duplicate query", ()=>{
    const A = rig();
    A.ctx.navigator.onLine = false;
    A.api.enqueueSync("rpn_link",{});
    A.api.enqueueSync("support_task",{});
    assert.strictEqual(A.api.pendingSyncCount(),2);
    assert.strictEqual(A.api.syncReminderShouldShow(),true);
    // draining the SAME queue the Cloud sync (beta) card reads is what turns it off
    A.api.run("UPDATE sync_queue SET status='synced'");
    assert.strictEqual(A.api.pendingSyncCount(),0);
    assert.strictEqual(A.api.syncReminderShouldShow(),false);
  });
  await t("does not block or interrupt an in-progress sale (cart drawer open)", ()=>{
    const A = rig();
    A.ctx.navigator.onLine = false;
    A.api.enqueueSync("sync_health_check",{});
    assert.strictEqual(A.api.syncReminderShouldShow(),true);
    A.api.setDrawerOpen(true);
    assert.strictEqual(A.api.syncReminderShouldShow(),false,"suppressed mid-sale");
    A.api.setDrawerOpen(false);
    assert.strictEqual(A.api.syncReminderShouldShow(),true,"back once the sale finishes");
  });
  await t("does not appear mid-onboarding (setup screen already shows RPN linkage)", ()=>{
    const A = rig();
    A.ctx.navigator.onLine = false;
    A.api.enqueueSync("sync_health_check",{});
    A.api.setRoute("setup");
    assert.strictEqual(A.api.syncReminderShouldShow(),false);
  });
  await t("checkSyncReminderModal: shows, is dismissible, and reappears on the next check interval while still unsynced", ()=>{
    const A = rig();
    A.ctx.navigator.onLine = false;
    A.api.enqueueSync("sync_health_check",{});
    A.api.checkSyncReminderModal(); // tick 1: should show
    assert.strictEqual(A.api.syncReminderVisible(),true);
    A.api.dismissSyncReminder(); // user closes it
    assert.strictEqual(A.api.syncReminderVisible(),false);
    assert.strictEqual(A.api.pendingSyncCount(),1,"dismissing never touches the queue");
    A.api.checkSyncReminderModal(); // tick 2 (next interval): still unsynced -> reappears
    assert.strictEqual(A.api.syncReminderVisible(),true);
  });
  await t("checkSyncReminderModal: disappears automatically once the queue drains", ()=>{
    const A = rig();
    A.ctx.navigator.onLine = false;
    A.api.enqueueSync("sync_health_check",{});
    A.api.checkSyncReminderModal();
    assert.strictEqual(A.api.syncReminderVisible(),true);
    A.api.run("UPDATE sync_queue SET status='synced'"); // e.g. connectivity restored and the worker drained it
    A.api.checkSyncReminderModal();
    assert.strictEqual(A.api.syncReminderVisible(),false);
  });
  await t("checkSyncReminderModal: the queue draining via the real worker (online-event/retry path) also closes it — no second connectivity check", async ()=>{
    const A = rig();
    A.api.setSetting("supabase_url","http://x"); A.api.setSetting("supabase_anon_key","k");
    A.ctx.navigator.onLine = false;
    A.api.enqueueSync("sync_health_check",{});
    await A.api.syncTick(); // offline: worker no-ops, modal shows
    assert.strictEqual(A.api.syncReminderVisible(),true);
    A.hook("fetch", async ()=>({ ok:true, text: async()=>"" }));
    A.ctx.navigator.onLine = true; // connectivity restored
    await A.api.syncTick(); // same tick drives both the worker and the modal
    assert.strictEqual(A.api.pendingSyncCount(),0,"the worker actually synced it");
    assert.strictEqual(A.api.syncReminderVisible(),false,"and the modal followed, same tick");
  });
  await t("syncTick still runs the worker exactly as before (no behaviour change to the existing sync mechanism)", async ()=>{
    const A = rig();
    A.api.setSetting("supabase_url","http://x"); A.api.setSetting("supabase_anon_key","k");
    A.api.enqueueSync("sync_health_check",{});
    A.hook("fetch", async ()=>({ ok:true, text: async()=>"" }));
    await A.api.syncTick();
    assert.strictEqual(A.api.pendingSyncCount(),0);
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
