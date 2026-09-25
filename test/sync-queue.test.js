// Run: node --no-warnings test/sync-queue.test.js
// Supabase Foundation (src/sync.js), over the REAL app source via the same
// harness the other suites use. A tiny local HTTP server stands in for
// Supabase's PostgREST endpoint so the "successfully syncs when reachable"
// case is a genuine over-the-wire fetch(), not a mocked assertion.
"use strict";
const assert = require("assert");
const http = require("http");
const { makeApp } = require("./harness");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,5).join("\n       ")); }
}
function rig(o){ return makeApp(Object.assign({ branch_name:"Boka", branch_type:"main", setup_complete:"1" }, o||{})); }
function configure(app, url, key){
  app.api.setSetting("supabase_url", url===undefined? "http://127.0.0.1:1" : url);
  app.api.setSetting("supabase_anon_key", key===undefined? "test-anon-key" : key);
}

// Minimal mock of a Supabase PostgREST insert endpoint: POST /rest/v1/<table>
// -> 201 and records the row, unless told to fail the next N requests.
function startMockSupabase(){
  const received = [];
  let failNext = 0;
  const server = http.createServer((req,res)=>{
    let body="";
    req.on("data",c=>body+=c);
    req.on("end",()=>{
      if(req.method!=="POST"){ res.writeHead(405); return res.end(); }
      if(failNext>0){ failNext--; res.writeHead(500,{"Content-Type":"application/json"}); return res.end(JSON.stringify({message:"simulated failure"})); }
      received.push({ url:req.url, headers:req.headers, body: body? JSON.parse(body) : null });
      res.writeHead(201,{"Content-Type":"application/json"});
      res.end("[]");
    });
  });
  return new Promise(resolve=>{
    server.listen(0,"127.0.0.1",()=>{
      const port = server.address().port;
      resolve({
        url:`http://127.0.0.1:${port}`, received,
        failNextN:(n)=>{ failNext=n; },
        close:()=>new Promise(r=>server.close(r)),
      });
    });
  });
}

(async()=>{
  // ================= enqueue / read =================
  await t("enqueue: a pending row is created, stamped with this device's tenant id", ()=>{
    const A = rig();
    const row = A.api.enqueueSync("sync_health_check",{ note:"hello" });
    assert.strictEqual(row.record_type,"sync_health_check");
    assert.strictEqual(row.status,"pending");
    assert.strictEqual(row.attempts,0);
    const payload = JSON.parse(row.payload_json);
    assert.strictEqual(payload.note,"hello");
    assert.strictEqual(payload.tenant_id, A.api.tenantId());
    assert.strictEqual(payload.tenant_id, A.api.getBranchId(), "tenant id reuses the existing branch identity");
  });
  await t("enqueue: an explicit tenant_id in the payload is left alone, not overwritten", ()=>{
    const A = rig();
    const row = A.api.enqueueSync("sync_health_check",{ tenant_id:"OVERRIDE" });
    assert.strictEqual(JSON.parse(row.payload_json).tenant_id,"OVERRIDE");
  });
  await t("pendingSyncRows/pendingSyncCount: grows as records are queued, filterable by type", ()=>{
    const A = rig();
    A.api.enqueueSync("sync_health_check",{a:1});
    A.api.enqueueSync("rpn_link",{b:2});
    assert.strictEqual(A.api.pendingSyncCount(),2);
    assert.strictEqual(A.api.pendingSyncCount("rpn_link"),1);
    assert.strictEqual(A.api.pendingSyncRows("sync_health_check").length,1);
  });
  await t("registry: an unregistered type still queues and defaults to its own name as the table", ()=>{
    const A = rig();
    assert.strictEqual(A.api.syncTableFor("some_future_type"),"some_future_type");
    A.api.registerSyncType("rpn_link",{ table:"rpn_link" });
    assert.strictEqual(A.api.syncTableFor("rpn_link"),"rpn_link");
  });
  await t("tenant scoping: two different devices/branches get different tenant ids", ()=>{
    const A = rig({ branch_name:"Boka" }), B = rig({ branch_name:"CBD" });
    assert.notStrictEqual(A.api.tenantId(), B.api.tenantId());
  });

  // ================= configuration / offline =================
  await t("unconfigured: supabaseConfigured() is false, and the worker no-ops without touching the queue", async ()=>{
    const A = rig();
    assert.strictEqual(A.api.supabaseConfigured(),false);
    A.api.enqueueSync("sync_health_check",{x:1});
    const res = await A.api.runSyncWorker();
    assert.strictEqual(res.reason,"not configured");
    assert.strictEqual(A.api.pendingSyncCount(),1,"nothing was consumed");
  });
  await t("offline: the queue grows and the worker no-ops, without crashing, while navigator.onLine is false", async ()=>{
    const A = rig();
    configure(A);
    A.ctx.navigator.onLine = false;
    A.api.enqueueSync("sync_health_check",{x:1});
    A.api.enqueueSync("sync_health_check",{x:2});
    A.api.enqueueSync("sync_health_check",{x:3});
    const res = await A.api.runSyncWorker();
    assert.strictEqual(res.reason,"offline");
    assert.strictEqual(A.api.pendingSyncCount(),3,"the queue kept growing and nothing was lost");
  });
  await t("the app's ordinary local operations are unaffected by Supabase being unreachable/unconfigured", async ()=>{
    const A = rig();
    // no configure() at all — simulates "entirely unreachable/unconfigured"
    A.api.run("INSERT INTO products(name,price,stock,low_threshold,branch) VALUES('Rice',5,10,3,'Boka')");
    const p = A.api.one("SELECT * FROM products WHERE name='Rice'");
    assert.strictEqual(p.stock,10);
    await assert.doesNotReject(()=>A.api.runSyncWorker());
  });

  // ================= success against a real local server =================
  await t("a queued record successfully syncs when a Supabase-shaped endpoint is reachable", async ()=>{
    const mock = await startMockSupabase();
    try{
      const A = rig();
      configure(A, mock.url, "anon-key-123");
      const row = A.api.enqueueSync("sync_health_check",{ note:"proof of pipeline" });
      const res = await A.api.runSyncWorker();
      assert.strictEqual(res.attempted,1); assert.strictEqual(res.synced,1);
      assert.strictEqual(mock.received.length,1);
      assert.strictEqual(mock.received[0].url,"/rest/v1/sync_health_check");
      assert.strictEqual(mock.received[0].headers.apikey,"anon-key-123");
      assert.strictEqual(mock.received[0].headers.authorization,"Bearer anon-key-123");
      assert.strictEqual(mock.received[0].body.note,"proof of pipeline");
      assert.strictEqual(mock.received[0].body.tenant_id, A.api.tenantId());
      const stored = A.api.one("SELECT * FROM sync_queue WHERE id=?",[row.id]);
      assert.strictEqual(stored.status,"synced"); assert.ok(stored.synced_ts);
      assert.strictEqual(A.api.pendingSyncCount(),0);
    } finally { await mock.close(); }
  });
  await t("a registered type's table mapping is what's actually POSTed to", async ()=>{
    const mock = await startMockSupabase();
    try{
      const A = rig();
      configure(A, mock.url);
      A.api.registerSyncType("rpn_link",{ table:"rpn_link_v2" });
      A.api.enqueueSync("rpn_link",{ rpn_code:"X1" });
      await A.api.runSyncWorker();
      assert.strictEqual(mock.received[0].url,"/rest/v1/rpn_link_v2");
    } finally { await mock.close(); }
  });

  // ================= failure / retry / backoff =================
  await t("a failed push is marked failed, keeps its data, and schedules a later retry (backoff)", async ()=>{
    const mock = await startMockSupabase();
    try{
      const A = rig();
      configure(A, mock.url);
      mock.failNextN(1);
      const row = A.api.enqueueSync("sync_health_check",{ note:"will fail once" });
      const res = await A.api.runSyncWorker();
      assert.strictEqual(res.synced,0);
      const stored = A.api.one("SELECT * FROM sync_queue WHERE id=?",[row.id]);
      assert.strictEqual(stored.status,"failed");
      assert.strictEqual(stored.attempts,1);
      assert.ok(/Supabase 500/.test(stored.last_error));
      assert.ok(new Date(stored.next_attempt_ts) > new Date(), "next attempt is scheduled in the future");
      assert.strictEqual(A.api.pendingSyncCount(),1,"failed rows still count as pending work");
    } finally { await mock.close(); }
  });
  await t("backoff grows with attempts and is capped", ()=>{
    const A = rig();
    const d1 = A.api.syncBackoffMs(1), d2 = A.api.syncBackoffMs(2), d3 = A.api.syncBackoffMs(3);
    assert.ok(d2>d1 && d3>d2);
    assert.strictEqual(A.api.syncBackoffMs(30), A.api.SYNC_MAX_DELAY_MS, "capped, not unbounded");
  });
  await t("a retry is NOT attempted before its backoff window arrives", async ()=>{
    const mock = await startMockSupabase();
    try{
      const A = rig();
      configure(A, mock.url);
      mock.failNextN(1);
      const row = A.api.enqueueSync("sync_health_check",{});
      await A.api.runSyncWorker(); // fails, schedules a future retry
      const before = mock.received.length;
      const res = await A.api.runSyncWorker(); // ticks again immediately — too soon
      assert.strictEqual(res.attempted,0, "the row isn't due yet");
      assert.strictEqual(mock.received.length, before);
      assert.strictEqual(A.api.one("SELECT status FROM sync_queue WHERE id=?",[row.id]).status,"failed");
    } finally { await mock.close(); }
  });
  await t("once its backoff window has passed, a failed record retries and can succeed", async ()=>{
    const mock = await startMockSupabase();
    try{
      const A = rig();
      configure(A, mock.url);
      mock.failNextN(1);
      const row = A.api.enqueueSync("sync_health_check",{ note:"eventually" });
      await A.api.runSyncWorker(); // fails once
      assert.strictEqual(A.api.one("SELECT attempts FROM sync_queue WHERE id=?",[row.id]).attempts,1);
      // simulate the backoff window having elapsed
      A.api.run("UPDATE sync_queue SET next_attempt_ts=? WHERE id=?",[new Date(Date.now()-1000).toISOString(), row.id]);
      const res = await A.api.runSyncWorker();
      assert.strictEqual(res.synced,1);
      assert.strictEqual(A.api.one("SELECT status FROM sync_queue WHERE id=?",[row.id]).status,"synced");
    } finally { await mock.close(); }
  });
  await t("a hard network failure (no server at all) fails the same way as an HTTP error — nothing throws", async ()=>{
    const A = rig();
    configure(A, "http://127.0.0.1:1"); // nothing listens on port 1
    const row = A.api.enqueueSync("sync_health_check",{});
    const res = await A.api.runSyncWorker();
    assert.strictEqual(res.synced,0);
    assert.strictEqual(A.api.one("SELECT status FROM sync_queue WHERE id=?",[row.id]).status,"failed");
  });

  // ================= worker mechanics =================
  await t("overlapping ticks: a second call while one is in flight is refused, not queued up", async ()=>{
    const A = rig();
    configure(A);
    A.api.enqueueSync("sync_health_check",{});
    let releaseFetch;
    const gate = new Promise(res=>{ releaseFetch=res; });
    A.hook("fetch", async ()=>{ await gate; return { ok:true, text:async()=>"" }; });
    const p1 = A.api.runSyncWorker();
    const r2 = await A.api.runSyncWorker();
    assert.strictEqual(r2.reason,"already running");
    releaseFetch();
    const r1 = await p1;
    assert.strictEqual(r1.synced,1);
  });
  await t("a successful sync clears any earlier failure on that same row on its next success", async ()=>{
    const mock = await startMockSupabase();
    try{
      const A = rig();
      configure(A, mock.url);
      mock.failNextN(1);
      const row = A.api.enqueueSync("sync_health_check",{});
      await A.api.runSyncWorker();
      A.api.run("UPDATE sync_queue SET next_attempt_ts=? WHERE id=?",[new Date(Date.now()-1000).toISOString(), row.id]);
      await A.api.runSyncWorker();
      const stored = A.api.one("SELECT * FROM sync_queue WHERE id=?",[row.id]);
      assert.strictEqual(stored.status,"synced"); assert.strictEqual(stored.last_error,"");
    } finally { await mock.close(); }
  });

  // ================= built-in project (no per-shop configuration) =================
  await t("the real config is Digital Commerce's project — the same constants device check-in uses — whatever old settings say", ()=>{
    const A = rig();
    configure(A, "https://someone-elses.supabase.co", "old-key"); // left over from an older version
    const cfg = A.api.getSupabaseConfig(); // the real function, not the harness's test seam
    assert.strictEqual(cfg.url, A.api.DC_SUPABASE_URL);
    assert.strictEqual(cfg.anonKey, A.api.DC_ANON_KEY);
    assert.strictEqual(cfg.url, "https://urbopdsubwawtybwrxjd.supabase.co");
  });
  await t("Settings card: no URL/key fields or Save — just status, and Sync now only while something is waiting", ()=>{
    const A = rig();
    let html = A.api.cloudSyncSectionHtml();
    assert.ok(/<h3>Cloud sync<\/h3>/.test(html));
    assert.ok(!/sSupabaseUrl|sSupabaseKey|saveCloudSync|<input/.test(html), "nothing for the shop to type");
    assert.ok(/nothing to set up/.test(html));
    assert.ok(/Everything is synced\./.test(html));
    assert.ok(!/syncNowBtn/.test(html), "no Sync now when there's nothing to send");
    A.api.enqueueSync("sync_health_check",{});
    html = A.api.cloudSyncSectionHtml();
    assert.ok(/1 record\(s\) waiting to sync\./.test(html));
    assert.ok(/syncNowBtn/.test(html));
  });
  await t("Settings card status: offline and retrying states read plainly", ()=>{
    const A = rig();
    const row = A.api.enqueueSync("sync_health_check",{});
    A.api.run("UPDATE sync_queue SET status='failed', attempts=2 WHERE id=?",[row.id]);
    assert.strictEqual(A.api.cloudSyncStatusText(), "1 record(s) waiting to sync. 1 couldn't be sent yet and will be retried automatically.");
    A.ctx.navigator.onLine = false;
    assert.strictEqual(A.api.cloudSyncStatusText(), "You're offline — 1 record(s) saved on this device will sync when you reconnect.");
  });

  console.log("\n"+passed+" passed, "+failed+" failed");
  process.exit(failed?1:0);
})();
