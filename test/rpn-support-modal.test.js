// Run: node --no-warnings test/rpn-support-modal.test.js
// RPN linkage + Support handoff (src/rpn.js) and the Sync Reminder Modal
// (src/sync.js), over the REAL app source via the same harness the other
// suites use. rpn_link and support_task are PAUSED since multi-terminal
// Phase 1 (their Supabase tables don't exist; docs/multi-terminal/
// phase1-plan.md §1E): saving and Support still work locally, nothing is
// queued, and the old backlog is set aside. The modal still reads
// pendingSyncCount()/pendingSyncRows() rather than a second query.
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
  await t("save (paused outbox): saved in settings, nothing queued — rpn_link stays registered but paused", ()=>{
    const A = rig();
    A.api.saveRpnLink(RPN);
    assert.strictEqual(A.api.getSetting("rpn_code",""),"RPN-014");
    assert.ok(A.api.getSetting("rpn_updated_ts",""), "still timestamped locally");
    assert.strictEqual(A.api.pendingSyncRows("rpn_link").length,0);
    assert.strictEqual(A.api.one("SELECT COUNT(*) c FROM sync_queue").c,0,"sync_queue doesn't grow");
    assert.strictEqual(A.api.syncTableFor("rpn_link"),"rpn_link","registerSyncType was still called");
    assert.strictEqual(A.api.enqueueSync("rpn_link",{x:1}),null,"enqueueSync on a paused type returns null");
  });
  await t("an existing rpn_link/support_task backlog is set aside as 'paused' (kept, not deleted, out of every count)", ()=>{
    const A = rig();
    const ins = (type,status)=> A.api.run("INSERT INTO sync_queue(record_type,record_key,tenant_id,payload_json,status,attempts,next_attempt_ts,created_ts,updated_ts) VALUES(?,'','t','{}',?,0,'','now','now')",[type,status]);
    ins("rpn_link","pending"); ins("support_task","failed"); ins("sync_health_check","pending"); ins("rpn_link","synced");
    A.api.migrate(A.api.getDb());
    assert.deepStrictEqual(JSON.parse(JSON.stringify(A.api.all("SELECT record_type,status FROM sync_queue ORDER BY id"))),
      [{record_type:"rpn_link",status:"paused"},{record_type:"support_task",status:"paused"},{record_type:"sync_health_check",status:"pending"},{record_type:"rpn_link",status:"synced"}]);
    assert.strictEqual(A.api.pendingSyncCount(),1,"only the deliverable row is still counted");
  });
  await t("persists offline: saving/editing RPN details doesn't touch the network and always succeeds locally", ()=>{
    const A = rig();
    A.ctx.navigator.onLine = false;
    A.api.saveRpnLink(RPN);
    assert.strictEqual(A.api.getRpnLink().rpn_name,"Tendai Moyo");
    assert.strictEqual(A.api.pendingSyncCount("rpn_link"),0,"paused: nothing queued, offline or not");
  });
  await t("edit: a later Save updates the local record (Part A.5)", ()=>{
    const A = rig();
    A.api.saveRpnLink(RPN);
    const edited = A.api.saveRpnLink(Object.assign({}, RPN, { rpn_code:"RPN-099", city_area:"Bulawayo" }));
    assert.strictEqual(edited.rpn_code,"RPN-099"); assert.strictEqual(edited.city_area,"Bulawayo");
    assert.strictEqual(A.api.getRpnLink().rpn_code,"RPN-099","local record updated");
    assert.strictEqual(A.api.pendingSyncRows("rpn_link").length,0,"paused: nothing queued");
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
  await t("support tap (paused outbox): nothing queued; a local audit_log line records it, with the RPN reference", ()=>{
    const A = rig();
    A.api.saveRpnLink(RPN);
    A.hook("openExternalUrl",()=>{});
    A.api.openSupportHandoff();
    assert.strictEqual(A.api.pendingSyncRows("support_task").length,0);
    assert.strictEqual(A.api.syncTableFor("support_task"),"support_task","registerSyncType was still called for this type");
    const log = A.api.all("SELECT * FROM audit_log WHERE action='Support requested'");
    assert.strictEqual(log.length,1);
    assert.ok(/Tendai Moyo/.test(log[0].details) && /RPN-014/.test(log[0].details), log[0].details);
    assert.strictEqual(log[0].branch,"Boka");
  });
  await t("each Support tap writes its own audit line (two taps -> two lines)", ()=>{
    const A = rig();
    A.api.saveRpnLink(RPN);
    A.hook("openExternalUrl",()=>{});
    A.api.openSupportHandoff();
    A.api.openSupportHandoff();
    assert.strictEqual(A.api.one("SELECT COUNT(*) c FROM audit_log WHERE action='Support requested'").c,2);
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
    A.api.enqueueSync("sync_health_check",{});
    A.api.enqueueSync("some_future_type",{});
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
