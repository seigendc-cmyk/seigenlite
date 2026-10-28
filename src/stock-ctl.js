  // ================== Stock control: sync with seiGEN (v37) ==================
  // docs/stock-control/v37-design.md (owner decisions 48, 52-55);
  // seiGEN: supabase/migrations/20261115120000_stock_control.sql.
  //   * Counts, decisions, stock requests, recalls and this branch's shelves are
  //     queued in sc_outbox and sent in the background (cl_device_stock_ctl_push),
  //     one answer per uid, so a retry never stores anything twice. Offline they
  //     wait. seiGEN checks the right of each one (decision 48).
  //   * One pull (cl_device_stock_ctl_pull) with a cursor brings what changed:
  //     shelves, counts, requests, recalls, the market feed, plus a title-only
  //     list of this branch's DNs and new iTred orders for the bell (bell.js).
  //   * A count approved anywhere moves stock only on the till that counted, once
  //     (sc_counts.applied_local, in the same transaction as the ADJ), by the
  //     difference fixed when it was counted (moveStock delta, never "set to").
  // Local only: mergeDatabase never reads these tables.

  const SC_BATCH_MAX = 25;
  const SC_PUSH_TIMEOUT_MS = 20000;
  const SC_BASE_DELAY_MS = 5000, SC_MAX_DELAY_MS = 15*60*1000;
  // refusals that never get better by trying again (a missing DN, a sign-in or a right can come later)
  const SC_FINAL_CODES = ["BAD_EVENT","ALREADY_DECIDED","WRONG_STATUS","IS_MAIN","NOT_MAIN","WRONG_BRANCH","WRONG_DEVICE","SAME_COUNTER","INVALID","NO_MAIN","GUEST_SEAT"];

  function migrateStockCtl(t){
    try{ t.run(`CREATE TABLE IF NOT EXISTS sc_outbox(
      uid TEXT PRIMARY KEY, type TEXT NOT NULL, doc_id TEXT DEFAULT '', payload_json TEXT NOT NULL, created_ts TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, next_ts TEXT DEFAULT '', sent_ts TEXT DEFAULT '',
      code TEXT DEFAULT '', error TEXT DEFAULT '')`); }catch(e){}
    try{ t.run("CREATE INDEX IF NOT EXISTS ix_sc_outbox_due ON sc_outbox(status, created_ts)"); }catch(e){}
    try{ t.run(`CREATE TABLE IF NOT EXISTS sc_counts(
      id TEXT PRIMARY KEY, branch_id TEXT DEFAULT '', terminal_id TEXT DEFAULT '', product_key TEXT NOT NULL, product_id INTEGER,
      code TEXT DEFAULT '', name TEXT DEFAULT '', shelf TEXT DEFAULT '', reason TEXT DEFAULT '', recount_of TEXT DEFAULT '', recount_not_by TEXT DEFAULT '',
      counted_qty INTEGER, system_qty INTEGER, diff INTEGER, counted_ts TEXT, counted_by TEXT DEFAULT '', staff_id TEXT DEFAULT '',
      status TEXT NOT NULL, decided_by TEXT DEFAULT '', decided_at TEXT DEFAULT '', decision_note TEXT DEFAULT '',
      applied_at TEXT DEFAULT '', adj_display TEXT DEFAULT '', unit_cost REAL, mine INTEGER DEFAULT 0, applied_local INTEGER DEFAULT 0,
      conflict TEXT DEFAULT '', seq INTEGER DEFAULT 0)`); }catch(e){}
    try{ t.run("CREATE INDEX IF NOT EXISTS ix_sc_counts_product ON sc_counts(product_key, counted_ts)"); }catch(e){}
    try{ t.run(`CREATE TABLE IF NOT EXISTS sc_requests(id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT, from_branch_id TEXT, created_ts TEXT, seq INTEGER DEFAULT 0, local INTEGER DEFAULT 0)`); }catch(e){}
    try{ t.run(`CREATE TABLE IF NOT EXISTS sc_recalls(id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT, branch_id TEXT, created_ts TEXT, seq INTEGER DEFAULT 0, local INTEGER DEFAULT 0)`); }catch(e){}
    // this branch's own shelves (decision 52): set here or pulled; the catalogue never overwrites them
    try{ t.run(`CREATE TABLE IF NOT EXISTS sc_shelves(product_key TEXT PRIMARY KEY, shelf TEXT DEFAULT '', set_ts TEXT, sent INTEGER DEFAULT 0)`); }catch(e){}
    // a shelf typed in Products or brought by an import, on this branch's own products (not a catalogue apply, not a pulled shelf)
    const notApplying = `COALESCE((SELECT value FROM settings WHERE key='cat_applying'),'')<>'1' AND COALESCE((SELECT value FROM settings WHERE key='sc_applying'),'')<>'1'
      AND COALESCE(NEW.branch,'')=COALESCE(NULLIF((SELECT value FROM settings WHERE key='branch_name'),''),(SELECT value FROM settings WHERE key='shop_name'),'Main')`;
    try{ t.run(`CREATE TRIGGER IF NOT EXISTS products_sc_shelf_upd AFTER UPDATE OF shelf ON products
      WHEN COALESCE(OLD.shelf,'') IS NOT COALESCE(NEW.shelf,'') AND COALESCE(NEW.cat_uid,NEW.uid) IS NOT NULL AND ${notApplying}
      BEGIN INSERT OR REPLACE INTO sc_shelves(product_key, shelf, set_ts, sent) VALUES(COALESCE(NEW.cat_uid,NEW.uid), COALESCE(NEW.shelf,''), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0); END`); }catch(e){}
    try{ t.run(`CREATE TRIGGER IF NOT EXISTS products_sc_shelf_ins AFTER INSERT ON products
      WHEN COALESCE(NEW.shelf,'')<>'' AND ${notApplying}
      BEGIN INSERT OR REPLACE INTO sc_shelves(product_key, shelf, set_ts, sent)
        SELECT COALESCE(cat_uid,uid), shelf, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0 FROM products WHERE id=NEW.id AND COALESCE(cat_uid,uid) IS NOT NULL; END`); }catch(e){}
  }

  // ---- state ----
  function scRegistered(){ return typeof isTerminalRegistered==="function" && isTerminalRegistered() && typeof terminalRpc==="function"; }
  function scGuest(){ return getSetting("seat_guest","")==="1"; }
  // Requests, recalls and counts need a till or seat on seiGEN (never a Guest's seat)
  function scAvailable(){ return scRegistered() && !scGuest() && !(typeof isTerminalInactive==="function" && isTerminalInactive()); }
  function scMyTerminal(){ return getSetting("terminal_id",""); }
  function scMyBranch(){ return getSetting("branch_uuid",""); }
  function scMainBranch(){ return getSetting("sc_main_branch_id",""); }
  function scIsMain(){ return scMainBranch()? scMainBranch()===scMyBranch() : !isRemote(); }
  function scBranches(){ try{ return JSON.parse(getSetting("sc_branches","[]"))||[]; }catch(e){ return []; } }
  function scBranchName(id){ const b = scBranches().find(x=>x.id===id); return b? b.name : ""; }
  function scJson(s, d){ try{ const v = JSON.parse(s||""); return v==null? d : v; }catch(e){ return d; } }
  function scNewUid(){
    if(typeof crypto!=="undefined" && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = Array.from(b, x=> x.toString(16).padStart(2,"0")).join("");
    return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);
  }
  // Who did it: the signed-in person, else the session name, else "single operator".
  function scWho(){
    const s = typeof staffSession==="function"? staffSession() : null;
    return (s && s.name) || String(sessionUser||"").trim() || "single operator";
  }
  function scStaffId(){
    const s = typeof staffSession==="function"? staffSession() : null;
    return s && /^[0-9a-f-]{36}$/i.test(String(s.id||""))? String(s.id) : null;
  }
  // A product's key across tills of a branch: its catalogue uid, or a branch-only product's own uid.
  function scProductKey(p){ return (p && (p.cat_uid || p.uid)) || ""; }
  function scProductByKey(key){
    if(!key) return null;
    return one("SELECT * FROM products WHERE branch=? AND (cat_uid=? OR (cat_uid IS NULL AND uid=?)) ORDER BY id LIMIT 1",[currentBranch(), key, key]);
  }

  // ---- the outbox ----
  function scQueue(type, payload, docId){
    const uid = type+":"+(payload.id || scNewUid())+":"+scNewUid().slice(0,8);
    run("INSERT INTO sc_outbox(uid,type,doc_id,payload_json,created_ts) VALUES(?,?,?,?,?)",
      [uid, type, docId || payload.id || "", JSON.stringify(Object.assign({ uid, type, ts:new Date().toISOString(), by:scWho() }, payload)), new Date().toISOString()]);
    return uid;
  }
  function scWaitingCount(){ try{ return Number(one("SELECT COUNT(*) AS n FROM sc_outbox WHERE status='queued'").n)||0; }catch(e){ return 0; }}
  // Events of a document still waiting to send (its screen shows "Waiting to send").
  function scWaitingFor(docId){ try{ return all("SELECT * FROM sc_outbox WHERE status='queued' AND doc_id=? ORDER BY created_ts",[docId]); }catch(e){ return []; } }
  function scRefusedFor(docId){ try{ return all("SELECT * FROM sc_outbox WHERE status='refused' AND doc_id=? ORDER BY created_ts",[docId]); }catch(e){ return []; } }
  function scBackoff(attempts){
    const full = Math.min(SC_MAX_DELAY_MS, SC_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts-1)));
    return Math.round(full * (0.5 + Math.random()*0.5));
  }
  // the shelves this branch set and hasn't sent yet go as events (newest wins on seiGEN)
  function scQueueShelves(){
    const rows = all("SELECT * FROM sc_shelves WHERE sent=0 LIMIT 200");
    rows.forEach(r=>{
      run("DELETE FROM sc_outbox WHERE status='queued' AND type='shelf' AND doc_id=?",[r.product_key]);   // only the latest of a product goes
      scQueue("shelf", { product_key:r.product_key, shelf:r.shelf||"", ts:r.set_ts }, r.product_key);
      run("UPDATE sc_shelves SET sent=1 WHERE product_key=?",[r.product_key]);
    });
    return rows.length;
  }
  let _scSending = null;
  function scSendNow(){
    if(_scSending) return _scSending;
    _scSending = (async ()=>{
      const res = { sent:0, refused:0, reason:"" };
      if(!scAvailable()){ res.reason = "not registered"; return res; }
      if(scRegistered() && typeof isSeat==="function" && !isSeat()) scQueueShelves();
      for(let i=0; i<20; i++){
        if(!isOnline()){ res.reason = "offline"; break; }
        const now = new Date().toISOString();
        const due = all("SELECT * FROM sc_outbox WHERE status='queued' AND (next_ts='' OR next_ts<=?) ORDER BY created_ts, uid LIMIT ?",[now, SC_BATCH_MAX]);
        if(!due.length) break;
        const r = await terminalRpc("cl_device_stock_ctl_push", Object.assign(terminalAuth(), { p_events: due.map(d=>JSON.parse(d.payload_json)) }), { timeoutMs:SC_PUSH_TIMEOUT_MS });
        if(!r.ok || !r.data || !Array.isArray(r.data.results)){
          const msg = String((r.data && r.data.message) || r.message || r.code || r.reason || "").slice(0,200);
          due.forEach(d=>{ const a = (d.attempts||0)+1; run("UPDATE sc_outbox SET attempts=?, next_ts=?, error=?, code=? WHERE uid=?",[a, new Date(Date.now()+scBackoff(a)).toISOString(), msg, r.code||r.reason||"", d.uid]); });
          res.reason = r.reason || "error";
          break;
        }
        const byUid = {}; r.data.results.forEach(x=>{ byUid[x.uid] = x; });
        let moved = 0;
        due.forEach(d=>{
          const x = byUid[d.uid];
          if(x && (x.status==="stored" || x.status==="duplicate")){ run("UPDATE sc_outbox SET status='sent', sent_ts=?, code=?, error='' WHERE uid=?",[now, x.status, d.uid]); res.sent++; moved++; scAfterSent(d); }
          else if(x && x.status==="refused" && SC_FINAL_CODES.includes(x.code)){
            run("UPDATE sc_outbox SET status='refused', sent_ts=?, code=?, error=? WHERE uid=?",[now, x.code, String(x.message||"").slice(0,200), d.uid]); res.refused++; moved++;
            scAfterRefused(d, x);
          } else {
            const a = (d.attempts||0)+1;
            run("UPDATE sc_outbox SET attempts=?, next_ts=?, error=?, code=? WHERE uid=?",[a, new Date(Date.now()+scBackoff(a)).toISOString(), String((x&&x.message)||"not answered").slice(0,200), (x&&x.code)||"", d.uid]);
          }
        });
        if(!moved) break;
      }
      return res;
    })().finally(()=>{ _scSending = null; });
    return _scSending;
  }
  // a document made here is on seiGEN now: no longer "local"
  function scAfterSent(d){
    if(d.type==="request_create") run("UPDATE sc_requests SET local=0 WHERE id=?",[d.doc_id]);
    if(d.type==="recall_create") run("UPDATE sc_recalls SET local=0 WHERE id=?",[d.doc_id]);
  }
  // A decision someone else made first: seiGEN's wins at the next pull. A count approved and applied
  // here meanwhile keeps its ADJ and is flagged for a manager (design: two approvers at once).
  function scAfterRefused(d, x){
    if(d.type==="count_decide" && x.code==="ALREADY_DECIDED") run("UPDATE sc_counts SET conflict=? WHERE id=?",[String(x.message||"Decided on another device first.").slice(0,200), d.doc_id]);
  }

  // ---- the pull ----
  let _scPulling = null;
  function scPull(){
    if(_scPulling) return _scPulling;
    _scPulling = (async ()=>{
      if(!scRegistered() || !isOnline()) return { ok:false, offline:!isOnline() };
      const r = await terminalRpc("cl_device_stock_ctl_pull", Object.assign(terminalAuth(),
        { p_cursor:Number(getSetting("sc_cursor","0"))||0, p_itred_after:Number(getSetting("sc_itred_cursor","0"))||0 }), { timeoutMs:20000 });
      if(!r.ok) return { ok:false, message:(r.data && r.data.message) || r.message || r.code || r.reason };
      const d = r.data || {};
      const changes = { requests:[], recalls:[], counts:[], dispatches:d.dispatches||[], itred:d.itred||null, market:d.market||[], guest:!!d.guest, first:!getSetting("sc_cursor","") };
      db.run("BEGIN");
      try{
        if(!d.guest){
          setSetting("sc_main_branch_id", d.main_branch_id||"");
          setSetting("sc_sees_diff", d.sees_diff? "1" : "0");
          if(Array.isArray(d.branches)) setSetting("sc_branches", JSON.stringify(d.branches.map(b=>({ id:b.id, name:b.name, is_main:!!b.is_main }))));
          scApplyShelves(d.shelves||[]);
          (d.counts||[]).forEach(c=>{ const was = one("SELECT status FROM sc_counts WHERE id=?",[c.id]); scStoreCount(c); changes.counts.push({ c, was:was? was.status : null }); });
          (d.requests||[]).forEach(q=>{ const was = one("SELECT status FROM sc_requests WHERE id=?",[q.id]); scStoreDoc("sc_requests", q, q.from_branch_id); changes.requests.push({ q, was:was? was.status : null }); });
          (d.recalls||[]).forEach(q=>{ const was = one("SELECT json FROM sc_recalls WHERE id=?",[q.id]); scStoreDoc("sc_recalls", q, q.branch_id); changes.recalls.push({ q, was:was? scJson(was.json, {}) : null }); });
          setSetting("sc_cursor", String(d.cursor||0));
          if(d.itred_cursor!=null) setSetting("sc_itred_cursor", String(d.itred_cursor||0));
        }
        setSetting("sc_pulled_ts", new Date().toISOString());
        db.run("COMMIT");
      }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
      const applied = scApplyApproved();
      const something = changes.requests.length || changes.recalls.length || changes.counts.length || applied.length;
      return { ok:true, changes, applied, something:!!something };
    })().finally(()=>{ _scPulling = null; });
    return _scPulling;
  }
  function scApplyShelves(rows){
    if(!rows.length) return;
    setSetting("sc_applying","1");
    try{
      rows.forEach(s=>{
        const mine = one("SELECT * FROM sc_shelves WHERE product_key=?",[s.product_key]);
        if(mine && mine.sent===0 && String(mine.set_ts||"") > String(s.set_ts||"")) return;   // a newer local edit waits to be sent
        run("INSERT OR REPLACE INTO sc_shelves(product_key, shelf, set_ts, sent) VALUES(?,?,?,1)",[s.product_key, s.shelf||"", s.set_ts||""]);
        run("UPDATE products SET shelf=? WHERE branch=? AND (cat_uid=? OR (cat_uid IS NULL AND uid=?))",[s.shelf||"", currentBranch(), s.product_key, s.product_key]);
      });
    } finally { setSetting("sc_applying",""); }
  }
  // seiGEN's copy of a count; this till's own figures stay (seiGEN hides them from a counter)
  function scStoreCount(c){
    const cur = one("SELECT * FROM sc_counts WHERE id=?",[c.id]);
    const pendingDecision = cur && one("SELECT 1 AS x FROM sc_outbox WHERE status='queued' AND type='count_decide' AND doc_id=?",[c.id]);
    const sys = c.system_qty!=null? c.system_qty : (cur? cur.system_qty : null), dif = c.diff!=null? c.diff : (cur? cur.diff : null);
    if(!cur){
      run(`INSERT INTO sc_counts(id,branch_id,terminal_id,product_key,code,name,shelf,reason,recount_of,counted_qty,system_qty,diff,counted_ts,counted_by,
             status,decided_by,decided_at,decision_note,applied_at,adj_display,unit_cost,mine,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [c.id, c.branch_id||"", c.terminal_id||"", c.product_key, c.code||"", c.name||"", c.shelf||"", c.reason||"", c.recount_of||"", c.counted_qty, sys, dif,
         c.counted_ts||"", c.counted_by||"", c.status, c.decided_by||"", c.decided_at||"", c.decision_note||"", c.applied_at||"", c.adj_display||"",
         c.unit_cost==null? null : c.unit_cost, c.terminal_id===scMyTerminal()? 1 : 0, c.change_seq||0]);
      return;
    }
    run(`UPDATE sc_counts SET status=?, decided_by=?, decided_at=?, decision_note=?, applied_at=?, adj_display=CASE WHEN ?<>'' THEN ? ELSE adj_display END,
           unit_cost=COALESCE(?,unit_cost), system_qty=?, diff=?, seq=? WHERE id=?`,
      [pendingDecision? cur.status : c.status, pendingDecision? cur.decided_by : (c.decided_by||""), pendingDecision? cur.decided_at : (c.decided_at||""),
       pendingDecision? cur.decision_note : (c.decision_note||""), c.applied_at||cur.applied_at||"", c.adj_display||"", c.adj_display||"",
       c.unit_cost==null? null : c.unit_cost, sys, dif, c.change_seq||0, c.id]);
  }
  function scStoreDoc(table, q, branchId){
    const cur = one(`SELECT * FROM ${table} WHERE id=?`,[q.id]);
    // a decision made here and not sent yet keeps the local status until seiGEN has it
    if(cur && one("SELECT 1 AS x FROM sc_outbox WHERE status='queued' AND doc_id=? AND type IN ('request_decide','request_link','recall_link','recall_cancel')",[q.id])) return;
    run(`INSERT OR REPLACE INTO ${table}(id,json,status,${table==="sc_requests"? "from_branch_id" : "branch_id"},created_ts,seq,local) VALUES(?,?,?,?,?,?,0)`,
      [q.id, JSON.stringify(q), q.status, branchId||"", q.created_ts||q.created_at||"", q.change_seq||0]);
  }
  function scRequests(){ return all("SELECT * FROM sc_requests ORDER BY created_ts DESC").map(r=> Object.assign(scJson(r.json, {}), { _local:r.local===1 })); }
  function scRecalls(){ return all("SELECT * FROM sc_recalls ORDER BY created_ts DESC").map(r=> Object.assign(scJson(r.json, {}), { _local:r.local===1 })); }
  function scRequest(id){ const r = one("SELECT * FROM sc_requests WHERE id=?",[id]); return r? Object.assign(scJson(r.json, {}), { _local:r.local===1 }) : null; }
  function scRecall(id){ const r = one("SELECT * FROM sc_recalls WHERE id=?",[id]); return r? Object.assign(scJson(r.json, {}), { _local:r.local===1 }) : null; }
  function scSaveDoc(table, doc, local){
    run(`INSERT OR REPLACE INTO ${table}(id,json,status,${table==="sc_requests"? "from_branch_id" : "branch_id"},created_ts,seq,local) VALUES(?,?,?,?,?,COALESCE((SELECT seq FROM ${table} WHERE id=?),0),?)`,
      [doc.id, JSON.stringify(doc), doc.status, (table==="sc_requests"? doc.from_branch_id : doc.branch_id)||"", doc.created_ts||"", doc.id, local? 1 : 0]);
  }

  // ---- an approved count moves this till's stock, once (decision 52) ----
  // By the difference fixed at the count, so sales and receipts since the count stay in the stock.
  function scApplyApproved(){
    const me = scMyTerminal(), done = [];
    // this till's own counts (a till not on seiGEN too), or one seiGEN says this terminal counted
    const rows = all("SELECT * FROM sc_counts WHERE status='approved' AND applied_local=0 AND applied_at='' AND (mine=1 OR (terminal_id<>'' AND terminal_id=?))",[me]);
    rows.forEach(c=>{
      try{ const a = scApplyOne(c); if(a) done.push(a); }catch(e){ run("UPDATE sc_counts SET conflict=? WHERE id=?",["Not applied: "+String(e.message||e).slice(0,160), c.id]); }
    });
    return done;
  }
  function scApplyOne(c){
    const p = (c.product_id && one("SELECT * FROM products WHERE id=? AND branch=?",[c.product_id, currentBranch()])) || scProductByKey(c.product_key);
    if(!p) throw new Error("the product isn't on this till");
    if(c.diff==null) throw new Error("the counted difference isn't on this till");
    const ts = new Date().toISOString(), note = "Cycle count, counted by "+(c.counted_by||"?")+", approved by "+(c.decided_by||"?");
    db.run("BEGIN");
    try{
      const again = one("SELECT applied_local FROM sc_counts WHERE id=?",[c.id]);
      if(!again || again.applied_local){ db.run("COMMIT"); return null; }
      let adj = null;
      if(c.diff!==0){
        adj = writeAdjustment({ product:p, delta:c.diff, reason:"Miscount correction", note, admin:c.decided_by||"?", ts });
        logAudit("Cycle count applied", p.name, (p.sku||"no code")+": "+(c.diff>0?"+":"")+c.diff+" ("+adj.text+"), "+note);
      }
      const cost = Number(p.cost)||0;   // the current cost (last cost today; WAC after F-0)
      run("UPDATE sc_counts SET applied_local=1, adj_display=?, unit_cost=?, product_id=? WHERE id=?",[adj? adj.text : "", cost, p.id, c.id]);
      if(scRegistered()) scQueue("count_applied", { id:c.id, adj_display:adj? adj.text : "", unit_cost:cost }, c.id);
      db.run("COMMIT");
      return { id:c.id, adj:adj? adj.text : "", product:p.name, diff:c.diff };
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} throw e; }
  }

  // ---- one round: send, pull, apply (bell.js runs it every 60 s while open and online) ----
  async function scTick(){
    if(!scRegistered()) return { skipped:"not registered" };
    const s = await scSendNow().catch(()=>({}));
    const p = await scPull().catch((e)=>({ ok:false, message:String(e && e.message || e) }));
    if(p.ok && p.applied && p.applied.length) await scSendNow().catch(()=>{});
    if((s && (s.sent || s.refused)) || (p && p.something)) await persist();
    return { send:s, pull:p };
  }
  // Pushes what was just queued (a screen's Save), in the background; offline it waits.
  function scSoon(){ setTimeout(()=>{ scSendNow().then((r)=>{ if(r && (r.sent || r.refused)) persist(); }).catch(()=>{}); }, 50); }

  // ---- the DN made from a request or a recall (dispatch-out.js, inside its transaction) ----
  // link: { type:"request"|"recall", id, lines?:[{line_no, sent_qty, short_qty, short_reason}] }
  function scQueueLink(link, dispatchId){
    if(!link || !dispatchId) return;
    if(link.type==="request"){
      scQueue("request_link", { id:link.id, dispatch_id:dispatchId }, link.id);
      const q = scRequest(link.id);
      if(q){ q.status = "dispatched"; q.dispatch_id = dispatchId; scSaveDoc("sc_requests", q, q._local); }
    } else if(link.type==="recall"){
      scQueue("recall_link", { id:link.id, dispatch_id:dispatchId, lines:link.lines||[] }, link.id);
      const q = scRecall(link.id);
      if(q){
        const short = (link.lines||[]).some(l=>(l.short_qty||0)>0);
        q.status = short? "partly_sent" : "sent"; q.dispatch_id = dispatchId;
        (q.lines||[]).forEach(l=>{ const x = (link.lines||[]).find(y=>y.line_no===l.line_no); if(x){ l.sent_qty = x.sent_qty; l.short_qty = x.short_qty; l.short_reason = x.short_reason||null; } });
        scSaveDoc("sc_recalls", q, q._local);
      }
    }
  }
