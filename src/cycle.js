  // ================== Cycle stocktake: "Count now" (v37, owner decision 52) ==================
  // docs/stock-control/v37-design.md §1. A short daily list chosen by risk, counted
  // blind, every difference approved before stock moves (stock-ctl.js applies it).
  //   * class: value sold at cost over 90 days (sales minus returns, qty × cost now):
  //     the top 80% of value = A, the next 15% = B, the rest (and nothing sold) = C.
  //     Due every 7 / 30 / 90 days (Settings → Count now).
  //   * red flags, counted first: negative stock; a difference at the last count;
  //     3+ units returned in 30 days; a sale while the stock showed 0 or less;
  //     an adjustment or write-off of 10+ units or over 10% of stock in 30 days;
  //     received in the last 60 days and not sold since.
  //   * the list: red flags, then the most overdue (A first), about 20 a day;
  //     a manager adds items or a whole shelf. Fixed for the business day.
  //   * the difference is fixed when counted (counted − stock at that moment), so
  //     selling never stops: approval moves stock by that difference.

  const CYCLE_DEFAULTS = { a:7, b:30, c:90, size:20 };
  const CYCLE_DAY = 86400000;

  // ---- pure part (test/cycle-count.test.js) ----
  // values: { key: value sold at cost } -> { key: "A"|"B"|"C" }
  function cycleClasses(values){
    const keys = Object.keys(values), out = {};
    const pos = keys.filter(k=> Number(values[k])>0).sort((a,b)=> values[b]-values[a] || String(a).localeCompare(String(b)));
    const total = pos.reduce((s,k)=> s+Number(values[k]), 0);
    let before = 0;
    pos.forEach(k=>{
      const share = before/total;              // the share of value ranked above this item
      out[k] = share < 0.80? "A" : share < 0.95? "B" : "C";
      before += Number(values[k]);
    });
    keys.forEach(k=>{ if(!out[k]) out[k] = "C"; });
    return out;
  }
  function cycleSettings(get){
    get = get || ((k, d)=> getSetting(k, d));
    const n = (k, d)=>{ const v = parseInt(get(k, ""), 10); return v>0? v : d; };
    return { a:n("cycle_days_a", CYCLE_DEFAULTS.a), b:n("cycle_days_b", CYCLE_DEFAULTS.b), c:n("cycle_days_c", CYCLE_DEFAULTS.c), size:n("cycle_size", CYCLE_DEFAULTS.size) };
  }
  // f: the facts of one product (see cycleFacts) -> the red flags, in plain words
  function cycleFlags(f){
    const out = [];
    if(f.stock<0) out.push("Negative stock");
    if(f.lastDiff) out.push("Difference at the last count");
    if(f.returned30>=3) out.push(f.returned30+" returned in 30 days");
    if(f.soldAtZero) out.push("Sold while showing 0");
    if(f.bigAdjust) out.push("Large adjustment or write-off");
    if(f.receivedNotSold) out.push("Received, not sold since");
    return out;
  }
  // products: [{ key, ... }], facts: { key: facts }, classes: { key: A|B|C }, now: ms, set: cycleSettings()
  // -> [{ key, cls, flags, overdueDays, reason }], red flags first, then the most overdue (A first); at most set.size
  function cycleChoose(products, facts, classes, now, set){
    const due = { A:set.a, B:set.b, C:set.c }, rows = [];
    products.forEach(p=>{
      const f = facts[p.key] || {}, cls = classes[p.key] || "C", flags = cycleFlags(f);
      const last = f.lastCountMs || null;
      const overdueDays = last==null? Infinity : Math.floor((now - last)/CYCLE_DAY) - due[cls];
      if(!flags.length && overdueDays<0) return;
      const reason = flags.length? flags.join(", ") : last==null? "Class "+cls+", never counted" : "Class "+cls+", not counted for "+Math.floor((now-last)/CYCLE_DAY)+" days";
      rows.push({ key:p.key, cls, flags, overdueDays, reason });
    });
    const rank = { A:0, B:1, C:2 };
    rows.sort((x,y)=> (y.flags.length>0) - (x.flags.length>0)
      || (x.flags.length && y.flags.length? y.flags.length - x.flags.length : 0)
      || (y.overdueDays===x.overdueDays? 0 : y.overdueDays===Infinity? 1 : x.overdueDays===Infinity? -1 : y.overdueDays - x.overdueDays)
      || rank[x.cls] - rank[y.cls] || String(x.key).localeCompare(String(y.key)));
    return rows.slice(0, set.size);
  }
  // movements of one product, oldest first ({ qty_delta, kind, ts }), and its stock now ->
  // true when a sale took the running figure below 0 since sinceMs
  function cycleSoldAtZero(moves, stockNow, sinceMs){
    let bal = stockNow;
    for(let i=moves.length-1; i>=0; i--){
      const m = moves[i];
      if(Date.parse(m.ts) < sinceMs) break;
      if(m.kind==="sale" && bal<0) return true;   // the balance right after this sale
      bal -= m.qty_delta;
    }
    return false;
  }
  // Group a list by shelf (no shelf: by name, at the end)
  function cycleGroupByShelf(items){
    const groups = new Map();
    items.slice().sort((a,b)=> (a.shelf? 0 : 1) - (b.shelf? 0 : 1) || String(a.shelf||"").localeCompare(String(b.shelf||""), undefined, { numeric:true }) || String(a.name).localeCompare(String(b.name)))
      .forEach(i=>{ const k = i.shelf || ""; if(!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
    return [...groups.entries()].map(([shelf, rows])=>({ shelf, rows }));
  }
  // Shrinkage (decision 52): approved differences -> totals by item, shelf, week; units, and value when costs show
  function cycleShrinkage(rows, withValue){
    const by = (keyOf)=>{ const m = new Map(); rows.forEach(r=>{ const k = keyOf(r); const x = m.get(k) || { key:k, units:0, value:0, counts:0 }; x.units += r.diff; x.value += r.diff*(r.unit_cost||0); x.counts++; m.set(k, x); }); return [...m.values()]; };
    const weekOf = (ts)=>{ const d = new Date(ts); const day = (d.getDay()+6)%7; d.setDate(d.getDate()-day); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
    const strip = (xs)=> xs.map(x=> withValue? Object.assign(x, { value:Math.round(x.value*100)/100 }) : Object.assign({}, x, { value:undefined }));
    const items = strip(by(r=> r.name)).sort((a,b)=> a.units - b.units || (b.value||0) - (a.value||0));
    return { items, top10:items.filter(x=>x.units<0).slice(0,10), shelves:strip(by(r=> r.shelf||"(no shelf)")).sort((a,b)=> a.units-b.units),
      weeks:strip(by(r=> weekOf(r.counted_ts))).sort((a,b)=> a.key<b.key? -1 : 1),
      staff:strip(by(r=> r.staff||"")).filter(x=>x.key).sort((a,b)=> a.units-b.units),
      units:rows.reduce((s,r)=>s+r.diff,0), value:withValue? Math.round(rows.reduce((s,r)=>s+r.diff*(r.unit_cost||0),0)*100)/100 : undefined };
  }

  // ---- this branch's facts ----
  function cycleFacts(now){
    now = now || Date.now();
    const branch = currentBranch(), since90 = new Date(now-90*CYCLE_DAY).toISOString(), since60 = new Date(now-60*CYCLE_DAY).toISOString(), since30 = new Date(now-30*CYCLE_DAY).toISOString();
    const products = all("SELECT * FROM products WHERE branch=? AND COALESCE(active,1)=1 ORDER BY name",[branch]);
    const byId = {}; products.forEach(p=>{ byId[p.id] = p; });
    const keyOf = (p)=> scProductKey(p) || ("id:"+p.id);
    const values = {}, facts = {};
    products.forEach(p=>{ values[keyOf(p)] = 0; facts[keyOf(p)] = { stock:p.stock }; });
    all(`SELECT si.product_id AS id, SUM(si.qty) AS q FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.ts>=? GROUP BY si.product_id`,[since90])
      .forEach(r=>{ const p = byId[r.id]; if(p) values[keyOf(p)] += (Number(r.q)||0)*(Number(p.cost)||0); });
    try{ all(`SELECT ci.product_id AS id, SUM(ci.qty) AS q FROM credit_note_items ci JOIN credit_notes c ON c.id=ci.cn_id WHERE c.ts>=? GROUP BY ci.product_id`,[since90])
      .forEach(r=>{ const p = byId[r.id]; if(p) values[keyOf(p)] -= (Number(r.q)||0)*(Number(p.cost)||0); }); }catch(e){}
    try{ all(`SELECT ci.product_id AS id, SUM(ci.qty) AS q FROM credit_note_items ci JOIN credit_notes c ON c.id=ci.cn_id WHERE c.ts>=? GROUP BY ci.product_id`,[since30])
      .forEach(r=>{ const p = byId[r.id]; if(p) facts[keyOf(p)].returned30 = Number(r.q)||0; }); }catch(e){}
    // the last count: a cycle count (any till of the branch) or a full stocktake on this till
    all("SELECT product_key, counted_ts, diff, status FROM sc_counts WHERE status<>'recount' ORDER BY counted_ts").forEach(c=>{
      const f = facts[c.product_key]; if(!f) return;
      f.lastCountMs = Date.parse(c.counted_ts); f.lastDiff = c.diff!=null && c.diff!==0;
    });
    try{ all(`SELECT sc.product_id AS id, MAX(sc.counted_ts) AS ts FROM stocktake_counts sc JOIN stocktakes s ON s.id=sc.stocktake_id WHERE s.branch=? GROUP BY sc.product_id`,[branch])
      .forEach(r=>{ const p = byId[r.id]; if(!p) return; const f = facts[keyOf(p)], ms = Date.parse(r.ts); if(ms && !(f.lastCountMs>=ms)){ f.lastCountMs = ms; f.lastDiff = false; } }); }catch(e){}
    // the ledger: sales at or below 0, big adjustments, received and not sold since (60 days)
    const moves = all(`SELECT product_id, qty_delta, kind, ts FROM stock_movements WHERE branch=? AND ts>=? ORDER BY id`,[branch, since60]);
    const per = {}; moves.forEach(m=>{ (per[m.product_id] = per[m.product_id] || []).push(m); });
    Object.keys(per).forEach(id=>{
      const p = byId[id]; if(!p) return;
      const f = facts[keyOf(p)], ms = per[id];
      f.soldAtZero = cycleSoldAtZero(ms, p.stock, now-30*CYCLE_DAY);
      f.bigAdjust = ms.some(m=> (m.kind==="adjustment" || m.kind==="write_off") && m.ts>=since30 && (Math.abs(m.qty_delta)>=10 || Math.abs(m.qty_delta) > 0.1*Math.max(1, Math.abs(p.stock))));
      const lastIn = ms.filter(m=> m.kind==="receive" || m.kind==="supplier_grv").map(m=>m.ts).sort().pop();
      f.receivedNotSold = !!lastIn && !ms.some(m=> m.kind==="sale" && m.ts>lastIn);
    });
    return { products:products.map(p=> Object.assign({}, p, { key:keyOf(p) })), values, facts };
  }

  // ---- today's list (fixed for the business day; a manager's additions kept) ----
  function cycleToday(){ return businessDateOf(); }
  function cycleListState(){ return scJson(getSetting("cycle_list",""), null); }
  function cycleList(){
    const today = cycleToday();
    let st = cycleListState();
    if(!st || st.day!==today){
      const { products, values, facts } = cycleFacts();
      const chosen = cycleChoose(products, facts, cycleClasses(values), Date.now(), cycleSettings());
      st = { day:today, items:chosen.map(c=>({ key:c.key, cls:c.cls, reason:c.reason, flags:c.flags.length })) };
      setSetting("cycle_list", JSON.stringify(st));
    }
    // recounts asked for (by anyone) come first, flagged with who must not count them
    const recounts = all(`SELECT * FROM sc_counts c WHERE c.status='recount' AND NOT EXISTS (SELECT 1 FROM sc_counts n WHERE n.recount_of=c.id)`)
      .map(c=>({ key:c.product_key, reason:"Recount: not by "+(c.counted_by||"the first counter"), recountOf:c.id, notBy:c.counted_by||"" }));
    const seen = new Set(recounts.map(r=>r.key));
    const items = recounts.concat(st.items.filter(i=>!seen.has(i.key)));
    return items.map(i=>{
      const p = scProductByKey(i.key) || (String(i.key).startsWith("id:")? one("SELECT * FROM products WHERE id=?",[Number(String(i.key).slice(3))]) : null);
      if(!p) return null;
      const done = one("SELECT * FROM sc_counts WHERE product_key=? AND mine=1 AND counted_ts>=? ORDER BY counted_ts DESC LIMIT 1",[i.key, new Date(businessDayStartMs(today)).toISOString()]);
      return Object.assign({}, i, { product:p, name:p.name, code:p.sku||"", shelf:p.shelf||"", done:i.recountOf? one("SELECT * FROM sc_counts WHERE recount_of=?",[i.recountOf]) : done });
    }).filter(Boolean);
  }
  function cycleAdd(keys, why){
    const st = cycleListState() || { day:cycleToday(), items:[] };
    if(st.day!==cycleToday()){ cycleList(); return cycleAdd(keys, why); }
    keys.forEach(k=>{ if(!st.items.some(i=>i.key===k)) st.items.push({ key:k, cls:"", reason:why||"Added by a manager", flags:0 }); });
    setSetting("cycle_list", JSON.stringify(st));
  }

  // ---- counting (blind) ----
  // -> { ok, id, status } | { ok:false, message }
  function cycleSaveCount(item, raw, countedBy){
    const s = String(raw==null? "" : raw).trim();
    if(!/^\d+$/.test(s)) return { ok:false, message:"Type the number you counted (a whole number, 0 or more)." };
    const qty = Number(s), who = String(countedBy||"").trim() || scWho();
    if(item.recountOf && item.notBy && who.toLowerCase()===String(item.notBy).toLowerCase() && who!=="single operator")
      return { ok:false, message:"This recount must be by someone other than "+item.notBy+"." };
    const p = one("SELECT * FROM products WHERE id=?",[item.product.id]);
    if(!p) return { ok:false, message:"That product isn't on this till." };
    const id = scNewUid(), ts = new Date().toISOString(), sys = p.stock, diff = qty - sys;
    const status = diff===0? "closed" : "waiting";
    db.run("BEGIN");
    try{
      run(`INSERT INTO sc_counts(id,branch_id,terminal_id,product_key,product_id,code,name,shelf,reason,recount_of,recount_not_by,counted_qty,system_qty,diff,counted_ts,counted_by,staff_id,status,mine)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        [id, scMyBranch(), scMyTerminal(), item.key, p.id, p.sku||"", p.name, p.shelf||"", item.reason||"", item.recountOf||"", item.notBy||"", qty, sys, diff, ts, who, scStaffId()||"", status]);
      if(scRegistered()) scQueue("count", { id, product_key:item.key, code:p.sku||"", name:p.name, shelf:p.shelf||"", reason:item.reason||"", recount_of:item.recountOf||null,
        counted_qty:qty, system_qty:sys, counted_ts:ts, counted_by:who, staff_id:scStaffId() }, id);
      logAudit("Cycle count", p.name, (p.sku||"no code")+": counted "+qty+(item.recountOf? " (recount)" : "")+" by "+who);
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} return { ok:false, message:String(e.message||e) }; }
    return { ok:true, id, status };
  }

  // ---- approval (approve_counts: the Admin passcode, or the signed-in holder's own PIN) ----
  function cycleWaiting(){ return all("SELECT * FROM sc_counts WHERE status='waiting' ORDER BY counted_ts"); }
  // action: approve | recount | reject -> { ok, adj? } | { ok:false, message }
  function cycleDecide(id, action, passcode, note){
    if(!["approve","recount","reject"].includes(action)) return { ok:false, message:"Approve, recount or reject." };
    const c = one("SELECT * FROM sc_counts WHERE id=?",[id]);
    if(!c || c.status!=="waiting") return { ok:false, message:"That count isn't waiting for approval any more." };
    if(typeof hasAdminPasscode==="function" && !hasAdminPasscode()) return { ok:false, message:NO_ADMIN_PASSCODE_MSG };
    const approver = findApprover(passcode, "approve_counts");
    if(!approver) return { ok:false, message:"Incorrect Admin passcode (or your PIN, when you hold Approve count differences)." };
    if(action==="reject" && !String(note||"").trim()) return { ok:false, message:"Say why it's rejected." };
    const by = approver.name || scWho(), status = action==="approve"? "approved" : action==="recount"? "recount" : "rejected", ts = new Date().toISOString();
    db.run("BEGIN");
    try{
      run("UPDATE sc_counts SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?",[status, by, ts, String(note||"").trim(), id]);
      if(scRegistered()) scQueue("count_decide", { id, action, note:String(note||"").trim(), by }, id);
      logAudit("Cycle count "+status, c.name, (c.code||"no code")+": difference "+(c.diff>0?"+":"")+c.diff+", counted by "+(c.counted_by||"?")+", "+status+" by "+by);
      db.run("COMMIT");
    }catch(e){ try{ db.run("ROLLBACK"); }catch(_){} return { ok:false, message:String(e.message||e) }; }
    // this till's own count moves its stock now; another till's moves when that till pulls the decision
    const applied = action==="approve"? scApplyApproved() : [];
    return { ok:true, applied };
  }

  // ---- shrinkage rows (approved differences on this branch + full stocktakes on this device) ----
  function cycleShrinkRows(fromTs, toTs){
    const rows = all(`SELECT * FROM sc_counts WHERE status='approved' AND diff<>0 AND counted_ts>=? AND counted_ts<=? ORDER BY counted_ts`,[fromTs, toTs]).map(c=>{
      const p = scProductByKey(c.product_key);
      return { name:c.name, code:c.code, shelf:c.shelf || (p && p.shelf) || "", diff:c.diff, unit_cost:c.unit_cost!=null? c.unit_cost : Number(p && p.cost)||0,
        counted_ts:c.counted_ts, counted_by:c.counted_by, staff:cycleOnDuty(c.counted_ts, c.counted_by), how:"Cycle count" };
    });
    try{ all(`SELECT m.*, p.cost AS cost, p.shelf AS shelf FROM stock_movements m LEFT JOIN products p ON p.id=m.product_id
               WHERE m.kind='stocktake' AND m.branch=? AND m.ts>=? AND m.ts<=? ORDER BY m.ts`,[currentBranch(), fromTs, toTs])
      .forEach(m=> rows.push({ name:m.product_name, code:m.product_code, shelf:m.shelf||"", diff:m.qty_delta, unit_cost:Number(m.cost)||0, counted_ts:m.ts,
        counted_by:m.user||"", staff:cycleOnDuty(m.ts, m.user), how:"Full stocktake" })); }catch(e){}
    return rows;
  }
  // Staff on duty: who sold on this till that business day, plus the counter
  function cycleOnDuty(ts, counter){
    const day = businessDateOf(ts), t = Date.parse(ts), names = new Set();
    try{ all("SELECT user, ts FROM sales WHERE ts>=? AND ts<=?",[new Date(t-2*CYCLE_DAY).toISOString(), new Date(t+2*CYCLE_DAY).toISOString()])
      .forEach(r=>{ if(String(r.user||"").trim() && businessDateOf(r.ts)===day) names.add(String(r.user).trim()); }); }catch(e){}
    if(String(counter||"").trim()) names.add(String(counter).trim());
    return [...names].sort().join(", ");
  }
  // Counts done vs due (this branch, the period)
  function cycleDoneVsDue(fromTs, toTs){
    const done = Number(one("SELECT COUNT(*) AS n FROM sc_counts WHERE counted_ts>=? AND counted_ts<=? AND status<>'recount'",[fromTs, toTs]).n)||0;
    const days = Math.max(1, Math.round((Date.parse(toTs) - Date.parse(fromTs))/CYCLE_DAY));
    return { done, due:days*cycleSettings().size };
  }
