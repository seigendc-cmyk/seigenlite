  // ================== B4: sales sync (v35) ==================
  // docs/sync/b4-sales-sync-design.md (owner decisions 3, 28, 30, 31, 35-38);
  // seiGEN: supabase/migrations/20261113120000_sales_sync.sql.
  //   * Every sale and money event this till makes is queued in b4_outbox and
  //     sent in the background (cl_device_b4_push), in small batches, most
  //     important first. Selling never waits for it, except a credit sale's
  //     check (decision 37), which has a short timeout and then the offline rule.
  //   * One event per uid: an event is marked sent only when seiGEN answers for
  //     its uid; a retry, an offline blip or a restart mid-send just sends it
  //     again, and seiGEN stores it once.
  //   * Queuing reads each table past a cursor, so no write path can be missed.
  //     Only this till's own rows go (not rows merged in from another device).
  //   * The first B4 check-in sets b4_start and queues the 90 days before it,
  //     marked history (decision 35), plus each customer's balance from before
  //     those 90 days (credit_bf), so no balance is lost.
  //   * Credit across the business (decision 37): seiGEN's answer online; offline
  //     the balance at the last sync plus this till's credit sales not in it (decision 3).
  // Local only: mergeDatabase never reads b4_outbox or b4_balances.

  const B4_HISTORY_DAYS = 90;                       // decision 35
  const B4_SCAN_LIMIT = 200;                        // rows queued per table per step, so a big backlog never holds the screen
  const B4_HISTORY_STEP = 40;                       // history rows per table per step (a few hundred ms at most on a slow phone)
  // Saving the database is the costly part on a big shop (seconds on a slow phone): B4 saves at most
  // every 5 minutes on its own; otherwise its marks ride on the app's next save (a sale, a payment).
  // A mark lost to a crash only means an event is sent again, and seiGEN keeps it once.
  const B4_PERSIST_EVERY_MS = 5*60*1000;
  const B4_BATCH_MAX = 25, B4_BATCH_BYTES = 48000;  // one send: at most this many events / about this many bytes
  const B4_BASE_DELAY_MS = 5000, B4_MAX_DELAY_MS = 15*60*1000;
  const B4_PUSH_TIMEOUT_MS = 20000, B4_CREDIT_TIMEOUT_MS = 4000;
  const B4_BUSY_POLL_MS = 20000, B4_IDLE_POLL_MS = 60000, B4_SOON_MS = 2000;
  const B4_BALANCES_EVERY_MS = 60000;
  // priority 1: money; 2: price changes and history; 3: everything else
  const B4_PRIORITY = { sale:1, "return":1, credit_payment:1, payout:1, eod:1, credit_override:1, credit_bf:1, price_change:2, voucher_issue:3, voucher_use:3 };
  // refusals that never get better by trying again
  const B4_FINAL_CODES = ["BAD_EVENT","TOO_OLD","SEAT_NO_SELLING","INVALID"];

  function migrateB4(t){
    try{ t.run(`CREATE TABLE IF NOT EXISTS b4_outbox(
      uid TEXT PRIMARY KEY, kind TEXT NOT NULL, priority INTEGER NOT NULL, history INTEGER NOT NULL DEFAULT 0,
      ref_table TEXT DEFAULT '', ref_id INTEGER, customer_id INTEGER, payload_json TEXT NOT NULL, created_ts TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, next_ts TEXT DEFAULT '', sent_ts TEXT DEFAULT '',
      code TEXT DEFAULT '', error TEXT DEFAULT '')`); }catch(e){}
    try{ t.run("CREATE INDEX IF NOT EXISTS ix_b4_outbox_due ON b4_outbox(status, priority, created_ts)"); }catch(e){}
    try{ t.run("CREATE TABLE IF NOT EXISTS b4_balances(customer_uid TEXT PRIMARY KEY, balance REAL NOT NULL)"); }catch(e){}
    // price changes: a uid, and how the change was made (the catalogue pull sets cat_applying)
    try{ t.run("ALTER TABLE price_changes ADD COLUMN uid TEXT"); }catch(e){}
    try{ t.run("ALTER TABLE price_changes ADD COLUMN how TEXT DEFAULT ''"); }catch(e){}
    try{ t.run("UPDATE price_changes SET uid=lower(hex(randomblob(16))) WHERE uid IS NULL"); }catch(e){}
    try{ t.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_price_changes_uid ON price_changes(uid) WHERE uid IS NOT NULL"); }catch(e){}
    try{ t.run(`CREATE TRIGGER IF NOT EXISTS price_changes_b4 AFTER INSERT ON price_changes WHEN NEW.uid IS NULL
      BEGIN UPDATE price_changes SET uid=lower(hex(randomblob(16))),
        how=CASE WHEN COALESCE((SELECT value FROM settings WHERE key='cat_applying'),'')='1' THEN 'catalogue sync' ELSE 'on this till' END
      WHERE id=NEW.id; END`); }catch(e){}
  }

  // ---- state ----
  function b4Registered(){ return !!getSetting("terminal_id","") && typeof terminalRpc==="function"; }
  function b4Started(){ return b4Registered() && !!getSetting("b4_start",""); }
  function b4Seat(){ return typeof isSeat==="function" && isSeat(); }
  function b4StaffId(){
    const s = typeof staffSession==="function"? staffSession() : null;
    return s && /^[0-9a-f-]{36}$/i.test(String(s.id||""))? String(s.id) : "";
  }
  // The signed-in person's seiGEN id on the row just written (empty in single operator mode).
  function b4StampStaff(table, id){
    const sid = b4StaffId();
    if(sid && id) try{ run(`UPDATE ${table} SET staff_id=? WHERE id=?`,[sid, id]); }catch(e){}
  }
  function b4WindowStart(){
    const start = getSetting("b4_start","");
    return start? businessDateOf(new Date(Date.parse(start) - B4_HISTORY_DAYS*86400000)) : "";
  }

  // ---- this till's own rows ----
  // Written here (stamped with this terminal), or from before registration on this
  // branch and not merged in from another device.
  function b4OwnSql(alias, opts){
    const a = alias? alias+"." : "";
    const term = opts && opts.noTerminal? "" : `${a}terminal_id=? OR (${a}terminal_id IS NULL AND `;
    const close = opts && opts.noTerminal? "" : ")";
    return `(${term}COALESCE(${a}branch,'') IN ('',?)${opts && opts.merged? ` AND COALESCE(${a}merged_ts,'')=''` : ""}${close})`;
  }
  function b4OwnArgs(opts){ return opts && opts.noTerminal? [currentBranch()] : [getSetting("terminal_id",""), currentBranch()]; }
  const B4_TABLES = {
    sales:          { kind:"sale", own:{ merged:true } },
    credit_notes:   { kind:"return", own:{} },
    credit_payments:{ kind:"credit_payment", own:{} },
    payouts:        { kind:"payout", own:{} },
    price_changes:  { kind:"price_change", own:{ noTerminal:true } },
    vouchers:       { kind:"voucher_issue", own:{ noTerminal:true } },
  };

  // ---- payloads (from the till's rows; a customer's uid is filled in when sending) ----
  function b4Bday(ts){ return businessDateOf(ts); }
  function b4CustUid(customerId){
    if(!customerId) return null;
    const c = one("SELECT uid FROM customers WHERE id=?",[customerId]);
    return c && c.uid? c.uid : null;
  }
  function b4SaleEvents(s){
    const items = all(`SELECT si.*, p.uid AS p_uid, p.cat_uid AS p_cat, p.sku AS p_sku FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=? ORDER BY si.id`,[s.id]);
    const pays = all("SELECT * FROM sale_payments WHERE sale_id=? ORDER BY id",[s.id]);
    const lines = items.map(i=>({ product_uid:i.p_uid||null, cat_uid:i.p_cat||null, code:i.p_sku||"", name:i.name||"", qty:i.qty, unit_price:i.price,
      discount:i.discount||0, line_total:roundMoney((i.price||0)*(i.qty||0) - (i.discount||0)), cost:i.cost||0, price_level:i.price_level||"retail" }));
    const payments = pays.map(p=>({ method:p.method, amount:p.amount, currency:p.currency||BASE_CURRENCY_CODE, rate:p.rate==null? 1 : p.rate,
      tendered:p.tendered_amount==null? p.amount : p.tendered_amount, ref:(p.method==="EcoCash"||p.method==="Bank")? (s.payment_ref||"") : "" }));
    const data = { receipt_no:receiptLabel(s.id, s.receipt_no), operator:s.user||"", staff_id:s.staff_id||null, price_level:s.price_level||"retail",
      base_symbol:currency, subtotal:s.subtotal, discount:s.discount, total:s.total, voucher_amount:s.voucher_amount||0,
      credit_check:s.credit_check||null, credit_scope:s.credit_scope||null, credit_before:s.credit_before, credit_after:s.credit_after,
      credit_limit_at:s.credit_limit_at, credit_override:s.credit_override||null, credit_override_mode:s.credit_override_mode||null,
      payment_ref:s.payment_ref||"", doc_ref:s.doc_ref||"", hold_uid:s.b4_hold_uid||null, lines, payments };
    const out = [{ uid:s.uid, kind:"sale", ts:s.ts, ref_table:"sales", ref_id:s.id, customer_id:s.customer_id||null, data }];
    if(s.credit_override){
      const single = s.credit_override_mode==="single operator";
      out.push({ uid:"ovr-"+s.uid, kind:"credit_override", ts:s.ts, ref_table:"sales", ref_id:s.id, customer_id:s.customer_id||null,
        data:{ sale_uid:s.uid, amount_over: s.credit_limit_at==null? null : roundMoney((s.credit_after||0) - s.credit_limit_at), credit_limit:s.credit_limit_at,
          balance_before:s.credit_before, balance_after:s.credit_after, by_name:s.credit_override, mode:s.credit_override_mode||"",
          right_held: !single, single_operator: single, checked:s.credit_check||null } });
    }
    return out;
  }
  function b4ReturnEvent(c){
    const lines = all("SELECT * FROM credit_note_items WHERE cn_id=? ORDER BY id",[c.id]).map(i=>({ product_uid:i.product_uid||null, code:i.product_code||"", name:i.name||"",
      qty:i.qty, unit_refund:i.unit_refund, amount:i.amount, unit_cost:i.unit_cost, condition:i.condition, sale_item_uid:i.sale_item_uid||null }));
    const refunds = all("SELECT * FROM credit_note_refunds WHERE cn_id=? ORDER BY id",[c.id]).map(r=>({ method:r.method, amount:r.amount, currency:r.currency||BASE_CURRENCY_CODE,
      rate:r.rate==null? 1 : r.rate, tendered:r.tendered_amount==null? r.amount : r.tendered_amount, ref:r.ref||"" }));
    return { uid:c.uid, kind:"return", ts:c.ts, ref_table:"credit_notes", ref_id:c.id, customer_id:c.customer_id||null,
      data:{ cn_display:typeof cnDisplay==="function"? cnDisplay(c) : String(c.cn_no||""), sale_uid:c.sale_uid||null, sale_receipt:c.sale_receipt||"", reason:c.reason||"",
        reason_note:c.reason_note||"", started_by:c.started_by||"", approved_by:c.approved_by||"", goods_total:c.goods_total||0, cost_reversed:c.cost_reversed||0, lines, refunds } };
  }
  function b4PaymentEvent(p){
    return { uid:p.uid, kind:"credit_payment", ts:p.ts, ref_table:"credit_payments", ref_id:p.id, customer_id:p.customer_id||null,
      data:{ amount:p.amount, method:null, reference:p.note||"", operator:p.user||"", staff_id:p.staff_id||null } };   // the till records no method yet (design §2)
  }
  function b4PayoutEvent(p){
    return { uid:p.uid, kind:"payout", ts:p.ts, ref_table:"payouts", ref_id:p.id,
      data:{ amount:p.amount, currency, account_tag:null, reason:p.reason||"", operator:p.user||"", staff_id:p.staff_id||null, approved_by:null, source:"till cash" } };
  }
  function b4EodEvent(e){
    let totals = null;
    try{ totals = eodTotalsFor(e.branch||currentBranch(), e.date, e.opening_float||0); }catch(x){ totals = null; }
    return { uid:e.uid, kind:"eod", ts:e.closed_ts||e.ts, bday:e.date, ref_table:"eod_sessions", ref_id:e.id,
      data:{ opened_at:e.started_ts||null, opening_float:e.opening_float||0, expected_cash:e.expected_cash, counted_cash:e.counted_cash, variance:e.variance, notes:e.notes||"",
        opened_by:e.started_by||"", closed_by:e.closed_by||"",
        by_currency: totals? (totals.cashByCurrency||[]).map(c=>({ currency:c.currency, tendered:c.tendered, amount:c.amount })) : [],
        totals: totals? { cash:roundMoney(totals.cash), ecocash:roundMoney(totals.ecocash), bank:roundMoney(totals.bank), credit:roundMoney(totals.credit),
          exchange:roundMoney(totals.exchangeIn), discounts:roundMoney(totals.discounts), total_sales:roundMoney(totals.totalSales), payouts:roundMoney(totals.payoutsTotal),
          refunds_cash:roundMoney(totals.refunds && totals.refunds.cash), net_sales:roundMoney(totals.netSales) } : {} } };
  }
  function b4PriceEvent(r){
    const p = r.product_id? one("SELECT uid, cat_uid FROM products WHERE id=?",[r.product_id]) : null;
    // who: the activity log line of the same change, when there is one (the trigger can't see who is signed in)
    const t = Date.parse(r.ts);
    const a = one("SELECT user FROM audit_log WHERE product_name=? AND ts>=? AND ts<=? ORDER BY ts DESC LIMIT 1",
      [r.product_name||"", new Date(t-5000).toISOString(), new Date(t+5000).toISOString()]);
    return { uid:r.uid, kind:"price_change", ts:r.ts, ref_table:"price_changes", ref_id:r.id,
      data:{ product_uid:p? p.uid : null, cat_uid:p? p.cat_uid : null, code:r.sku||"", name:r.product_name||"", old_price:r.old_price, new_price:r.new_price,
        cost:r.cost, by_name:a? a.user : null, how:r.how||"" } };
  }
  function b4VoucherIssue(v){
    const sale = v.source_sale_id? one("SELECT uid FROM sales WHERE id=?",[v.source_sale_id]) : null, cn = v.source_cn_id? one("SELECT uid FROM credit_notes WHERE id=?",[v.source_cn_id]) : null;
    return { uid:v.uid, kind:"voucher_issue", ts:v.earned_ts, ref_table:"vouchers", ref_id:v.id, customer_id:v.customer_id||null,
      data:{ voucher_uid:v.uid, voucher_kind:v.kind||"loyalty", amount:v.amount, sale_uid:sale? sale.uid : null, cn_uid:cn? cn.uid : null } };
  }
  function b4VoucherUse(v){
    const sale = v.redeemed_sale_id? one("SELECT uid FROM sales WHERE id=?",[v.redeemed_sale_id]) : null;
    return { uid:"use-"+v.uid, kind:"voucher_use", ts:v.redeemed_ts, ref_table:"vouchers", ref_id:v.id, customer_id:v.customer_id||null,
      data:{ voucher_uid:v.uid, voucher_kind:v.kind||"loyalty", amount:v.amount, sale_uid:sale? sale.uid : null } };
  }
  function b4RowEvents(table, row){
    if(table==="sales") return b4SaleEvents(row);
    if(table==="credit_notes") return [b4ReturnEvent(row)];
    if(table==="credit_payments") return [b4PaymentEvent(row)];
    if(table==="payouts") return [b4PayoutEvent(row)];
    if(table==="price_changes") return [b4PriceEvent(row)];
    if(table==="vouchers") return [b4VoucherIssue(row)];
    return [];
  }

  // ---- queuing ----
  function b4Enqueue(ev, history){
    if(!ev || !ev.uid || !ev.ts) return false;
    const kind = ev.kind, prio = history && kind!=="credit_bf"? 2 : (B4_PRIORITY[kind]||3);
    const payload = { uid:ev.uid, kind, ts:ev.ts, bday:ev.bday || b4Bday(ev.ts), history:!!history, data:ev.data||{} };
    run(`INSERT OR IGNORE INTO b4_outbox(uid,kind,priority,history,ref_table,ref_id,customer_id,payload_json,created_ts)
         VALUES(?,?,?,?,?,?,?,?,?)`, [ev.uid, kind, prio, history?1:0, ev.ref_table||"", ev.ref_id||null, ev.customer_id||null, JSON.stringify(payload), new Date().toISOString()]);
    return true;
  }
  function b4Cursor(table){ return Number(getSetting("b4_cur_"+table,"0"))||0; }
  // Live events: each table past its cursor, a few hundred rows a step.
  function b4ScanLive(){
    if(!b4Started()) return 0;
    let n = 0;
    for(const table of Object.keys(B4_TABLES)){
      const cfg = B4_TABLES[table], cur = b4Cursor(table);
      const rows = all(`SELECT * FROM ${table} WHERE id>? ORDER BY id LIMIT ?`,[cur, B4_SCAN_LIMIT]);
      if(!rows.length) continue;
      const own = new Set(all(`SELECT id FROM ${table} WHERE id>? AND id<=? AND ${b4OwnSql("", cfg.own)}`, [cur, rows[rows.length-1].id].concat(b4OwnArgs(cfg.own))).map(r=>r.id));
      for(const r of rows){ if(own.has(r.id) && r.uid) b4RowEvents(table, r).forEach(ev=>{ if(b4Enqueue(ev, false)) n++; }); }
      setSetting("b4_cur_"+table, String(rows[rows.length-1].id));
    }
    // updates, not inserts: an End of Day closed, a voucher redeemed (since B4 started)
    const start = getSetting("b4_start","");
    all(`SELECT * FROM eod_sessions WHERE status='closed' AND COALESCE(closed_ts,'')>=? AND ${b4OwnSql("", {})}
         AND uid IS NOT NULL AND uid NOT IN (SELECT uid FROM b4_outbox) LIMIT ?`, [start].concat(b4OwnArgs({}), [B4_SCAN_LIMIT]))
      .forEach(e=>{ if(b4Enqueue(b4EodEvent(e), false)) n++; });
    all(`SELECT * FROM vouchers WHERE status='Redeemed' AND COALESCE(redeemed_ts,'')>=? AND ${b4OwnSql("", { noTerminal:true })}
         AND uid IS NOT NULL AND ('use-'||uid) NOT IN (SELECT uid FROM b4_outbox) LIMIT ?`, [start].concat(b4OwnArgs({ noTerminal:true }), [B4_SCAN_LIMIT]))
      .forEach(v=>{ if(b4Enqueue(b4VoucherUse(v), false)) n++; });
    return n;
  }
  // The first B4 check-in (decision 35): b4_start once; the cursors start at what
  // is here now, so everything older is history (the last 90 days) or brought forward.
  function b4Begin(now){
    if(!b4Registered() || getSetting("b4_start","")) return false;
    const ts = (now||new Date()).toISOString();
    run("BEGIN");
    try{
      Object.keys(B4_TABLES).forEach(table=>{
        const m = one(`SELECT COALESCE(MAX(id),0) AS m FROM ${table}`);
        setSetting("b4_cur_"+table, String(m? m.m : 0));
        setSetting("b4_hist_"+table, String(m? m.m : 0));   // history goes up to here
      });
      setSetting("b4_start", ts);
      run("COMMIT");
    }catch(e){ try{ run("ROLLBACK"); }catch(_){} throw e; }
    return true;
  }
  // History, a step at a time (rows older than the window are never sent).
  function b4QueueHistoryStep(){
    if(!b4Started() || getSetting("b4_history_done","")==="1") return { done:true, n:0 };
    const from = b4WindowStart(), start = getSetting("b4_start","");
    const fromTs = businessRange(from, from).fromTs;
    let n = 0, more = false;
    for(const table of Object.keys(B4_TABLES)){
      const cfg = B4_TABLES[table], top = Number(getSetting("b4_hist_"+table,"0"))||0, cur = Number(getSetting("b4_hcur_"+table,"0"))||0;
      if(cur>=top) continue;
      const tsCol = table==="vouchers"? "earned_ts" : "ts";
      const rows = all(`SELECT * FROM ${table} WHERE id>? AND id<=? ORDER BY id LIMIT ?`,[cur, top, B4_HISTORY_STEP]);
      const own = rows.length? new Set(all(`SELECT id FROM ${table} WHERE id>? AND id<=? AND ${tsCol}>=? AND ${b4OwnSql("", cfg.own)}`,
        [cur, rows[rows.length-1].id, fromTs].concat(b4OwnArgs(cfg.own))).map(r=>r.id)) : new Set();
      for(const r of rows){ if(own.has(r.id) && r.uid) b4RowEvents(table, r).forEach(ev=>{ if(b4Enqueue(ev, true)) n++; }); }
      const last = rows.length? rows[rows.length-1].id : top;
      setSetting("b4_hcur_"+table, String(last));
      if(last<top) more = true;
    }
    if(more) return { done:false, n };
    // closed End of Day sessions and redeemed vouchers of the window (updates, not inserts)
    all(`SELECT * FROM eod_sessions WHERE status='closed' AND date>=? AND COALESCE(closed_ts,'')<? AND ${b4OwnSql("", {})} AND uid IS NOT NULL`, [from, start].concat(b4OwnArgs({})))
      .forEach(e=>{ if(b4Enqueue(b4EodEvent(e), true)) n++; });
    all(`SELECT * FROM vouchers WHERE status='Redeemed' AND COALESCE(redeemed_ts,'')>=? AND COALESCE(redeemed_ts,'')<? AND ${b4OwnSql("", { noTerminal:true })} AND uid IS NOT NULL`,
      [fromTs, start].concat(b4OwnArgs({ noTerminal:true }))).forEach(v=>{ if(b4Enqueue(b4VoucherUse(v), true)) n++; });
    n += b4QueueBroughtForward(fromTs);
    setSetting("b4_history_done", "1");
    return { done:true, n };
  }
  // Each customer's balance at this till from before the window (credit sales -
  // payments - returns to the debtor account, as customerBalance), so seiGEN's
  // business balance keeps it without the older detail.
  function b4QueueBroughtForward(fromTs){
    const args = b4OwnArgs({}), own = (a, o)=> b4OwnSql(a, o||{});
    const rows = all(`SELECT cid, ROUND(SUM(amt),2) AS amt FROM (
        SELECT s.customer_id AS cid, sp.amount AS amt FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id
          WHERE sp.method='Credit' AND s.customer_id IS NOT NULL AND s.ts<? AND ${own("s", { merged:true })}
        UNION ALL SELECT customer_id, -amount FROM credit_payments WHERE customer_id IS NOT NULL AND ts<? AND ${own("")}
        UNION ALL SELECT c.customer_id, -r.amount FROM credit_note_refunds r JOIN credit_notes c ON c.id=r.cn_id
          WHERE r.method='Debtor' AND c.customer_id IS NOT NULL AND c.ts<? AND ${own("c")}
      ) GROUP BY cid HAVING ROUND(SUM(amt),2)<>0`, [fromTs].concat(args, [fromTs], args, [fromTs], args));
    let n = 0;
    const tid = getSetting("terminal_id","");
    rows.forEach(r=>{
      if(b4Enqueue({ uid:"bf-"+tid+"-"+r.cid, kind:"credit_bf", ts:fromTs, ref_table:"customers", ref_id:r.cid, customer_id:r.cid, data:{ amount:r.amt } }, true)) n++;
    });
    return n;
  }

  // ---- sending ----
  // A customer seiGEN doesn't have yet: their credit events wait (their uid can still change).
  function b4CustomerWaiting(customerId){
    if(!customerId) return false;
    const c = one("SELECT srv_status, phone_norm FROM customers WHERE id=?",[customerId]);
    if(!c) return false;
    const st = c.srv_status||"";
    return st==="queued" || st==="legacy" || st==="clash" || (st==="" && !!c.phone_norm && typeof custRegistered==="function" && custRegistered());
  }
  function b4CreditAffecting(row, p){
    const d = p.data||{};
    if(row.kind==="credit_payment" || row.kind==="credit_bf" || row.kind==="credit_override") return true;
    if(row.kind==="sale") return (d.payments||[]).some(x=>x.method==="Credit");
    if(row.kind==="return") return (d.refunds||[]).some(x=>x.method==="Debtor");
    return false;
  }
  function b4Due(now){
    return all("SELECT * FROM b4_outbox WHERE status='queued' AND (next_ts='' OR next_ts<=?) ORDER BY priority, created_ts, uid LIMIT 400",[now]);
  }
  function b4BuildBatch(now){
    const size = Math.max(1, Math.min(B4_BATCH_MAX, Number(getSetting("b4_batch", String(B4_BATCH_MAX)))||B4_BATCH_MAX));
    const out = []; let bytes = 0;
    for(const row of b4Due(now)){
      const p = JSON.parse(row.payload_json);
      if(row.customer_id){
        if(b4CreditAffecting(row, p) && b4CustomerWaiting(row.customer_id)) continue;   // waits for the customer (design §4)
        const cu = b4CustUid(row.customer_id);
        if(cu) p.data.customer_uid = cu;
        else if(row.kind==="credit_payment" || row.kind==="credit_bf") continue;        // a deleted customer: nothing to count it against yet
      }
      const len = JSON.stringify(p).length;
      if(out.length && bytes+len > B4_BATCH_BYTES) break;
      out.push({ row, p }); bytes += len;
      if(out.length>=size) break;
    }
    return out;
  }
  function b4Backoff(attempts){
    const full = Math.min(B4_MAX_DELAY_MS, B4_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts-1)));
    return Math.round(full * (0.5 + Math.random()*0.5));   // jitter: tills that lost the signal together don't all come back at once
  }
  function b4Retry(rows, err, code){
    const now = Date.now();
    rows.forEach(({ row })=>{
      const a = (row.attempts||0)+1;
      run("UPDATE b4_outbox SET attempts=?, next_ts=?, error=?, code=? WHERE uid=?",[a, new Date(now+b4Backoff(a)).toISOString(), String(err||"").slice(0,200), code||"", row.uid]);
    });
  }
  let _b4Sending = null;
  // One send round: batches until nothing is due, the network fails, or the time is up.
  function b4SendNow(o){
    if(_b4Sending) return _b4Sending;
    _b4Sending = (async ()=>{
      const res = { sent:0, refused:0, batches:0, reason:"" };
      if(!b4Started()){ res.reason = "not started"; return res; }
      const until = Date.now() + ((o && o.budgetMs) || 60000);
      for(let i=0; i<40 && Date.now()<until; i++){
        if(!isOnline()){ res.reason = "offline"; break; }
        const batch = b4BuildBatch(new Date().toISOString());
        if(!batch.length) break;
        res.batches++;
        const r = await terminalRpc("cl_device_b4_push", Object.assign(terminalAuth(), { p_events: batch.map(b=>b.p) }), { timeoutMs:B4_PUSH_TIMEOUT_MS });
        if(!r.ok || !r.data || !Array.isArray(r.data.results)){
          // a timeout or a dropped line: smaller batches next time (2G), back off with jitter
          if(r.reason==="network") setSetting("b4_batch", String(Math.max(1, Math.floor(batch.length/2))));
          b4Retry(batch, r.message || r.code || r.reason, r.code || r.reason);
          setSetting("b4_last_error", String(r.message || r.code || r.reason || "").slice(0,200));
          res.reason = r.reason || "error";
          break;
        }
        const now = new Date().toISOString(), byUid = {};
        r.data.results.forEach(x=>{ byUid[x.uid] = x; });
        const again = [];
        batch.forEach(b=>{
          const x = byUid[b.row.uid];
          if(x && (x.status==="stored" || x.status==="duplicate")){ run("UPDATE b4_outbox SET status='sent', sent_ts=?, code=?, error='' WHERE uid=?",[now, x.status, b.row.uid]); res.sent++; }
          else if(x && x.status==="refused" && B4_FINAL_CODES.includes(x.code)){ run("UPDATE b4_outbox SET status='refused', sent_ts=?, code=?, error=? WHERE uid=?",[now, x.code, String(x.message||"").slice(0,200), b.row.uid]); res.refused++; }
          else again.push(b);
        });
        if(again.length) b4Retry(again, (byUid[again[0].row.uid]||{}).message || "not answered", (byUid[again[0].row.uid]||{}).code || "");
        setSetting("b4_batch", String(Math.min(B4_BATCH_MAX, batch.length*2)));
        setSetting("b4_last_sent_ts", now);
        setSetting("b4_last_error", "");
        if(again.length===batch.length) break;
      }
      b4Persist();
      return res;
    })().finally(()=>{ _b4Sending = null; });
    return _b4Sending;
  }

  // ---- balances (the offline rule) ----
  async function b4PullBalances(){
    if(!b4Started() || !isOnline()) return { ok:false, reason:"offline" };
    const asked = new Date().toISOString();
    const r = await terminalRpc("cl_device_credit_balances", terminalAuth(), { timeoutMs:B4_PUSH_TIMEOUT_MS });
    if(!r.ok || !r.data || !Array.isArray(r.data.balances)) return { ok:false, reason:r.reason||"error" };
    run("BEGIN");
    try{
      run("DELETE FROM b4_balances");
      r.data.balances.forEach(b=>{ if(b && b.uid) run("INSERT OR REPLACE INTO b4_balances(customer_uid,balance) VALUES(?,?)",[b.uid, Number(b.balance)||0]); });
      setSetting("b4_bal_ts", asked);   // events sent before this moment are in these balances
      run("COMMIT");
    }catch(e){ try{ run("ROLLBACK"); }catch(_){} throw e; }
    b4Persist();
    return { ok:true, n:r.data.balances.length };
  }
  function b4BalancesReady(){ return b4Started() && !!getSetting("b4_bal_ts",""); }
  // This till's credit not in the last pulled balances: its credit sales (and
  // brought-forward amounts) not sent before that pull (decision 3).
  function b4UnsyncedCredit(customerId){
    const asOf = getSetting("b4_bal_ts",""), fromTs = businessRange(b4WindowStart(), b4WindowStart()).fromTs;
    const args = b4OwnArgs({});
    const sales = one(`SELECT COALESCE(SUM(sp.amount),0) AS t FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id
        WHERE sp.method='Credit' AND s.customer_id=? AND s.ts>=? AND ${b4OwnSql("s", { merged:true })}
          AND NOT EXISTS (SELECT 1 FROM b4_outbox o WHERE o.uid=s.uid AND o.status='sent' AND o.sent_ts<=?)`, [customerId, fromTs].concat(args, [asOf])).t;
    const bf = all("SELECT payload_json FROM b4_outbox WHERE kind='credit_bf' AND customer_id=? AND NOT (status='sent' AND sent_ts<=?)", [customerId, asOf])
      .reduce((t, r)=>{ let a = 0; try{ a = Number(JSON.parse(r.payload_json).data.amount)||0; }catch(e){} return t + Math.max(0, a); }, 0);
    return roundMoney(sales + bf);
  }
  function b4SnapshotBalance(customer){
    const r = customer && customer.uid? one("SELECT balance FROM b4_balances WHERE customer_uid=?",[customer.uid]) : null;
    return roundMoney((r? r.balance : 0) + b4UnsyncedCredit(customer.id));
  }
  function b4LastSyncText(){
    const t = getSetting("b4_bal_ts","");
    return t? new Date(t).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }) : "";
  }

  // ---- credit across the business (decision 37) ----
  // The answer seiGEN gave for the sale being finished: { customerId, amount, saleUid, at, online, data }.
  let b4CreditAnswer = null;
  let _b4Checking = false;
  function b4CreditActive(customer){ return !!customer && !(typeof isBuiltinCustomer==="function" && isBuiltinCustomer(customer)) && b4BalancesReady() && !b4Seat(); }
  function b4NewUid(){
    const a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.from(a, x=> x.toString(16).padStart(2,"0")).join("");
  }
  // Before a credit sale (pos.js completeSale): ask seiGEN, then finish the sale.
  // -> "waiting" (the sale goes on by itself when the answer comes) | null (go on now).
  function b4CreditPrecheck(customer, creditAmount, retry){
    if(!(creditAmount>0) || !b4CreditActive(customer)) return null;
    if(customer.credit_limit==null || customer.credit_limit==="") return null;   // no limit: nothing to check (as v34)
    const a = b4CreditAnswer;
    if(a && a.customerId===customer.id && a.amount===roundMoney(creditAmount) && Date.now()-a.at < 120000) return null;
    const saleUid = b4NewUid();
    if(!isOnline()){ b4CreditAnswer = { customerId:customer.id, amount:roundMoney(creditAmount), saleUid, at:Date.now(), online:false }; return null; }
    if(_b4Checking) return "waiting";
    _b4Checking = true;
    if(typeof window!=="undefined") window._b4Checking = true;
    b4CheckingNote(true);
    (async ()=>{
      let r = null;
      try{
        r = await terminalRpc("cl_device_credit_check", Object.assign(terminalAuth(), { p_customer_uid:customer.uid, p_sale_uid:saleUid,
          p_amount:roundMoney(creditAmount), p_limit:Number(customer.credit_limit), p_override:false }), { timeoutMs:B4_CREDIT_TIMEOUT_MS });
      }catch(e){ r = null; }
      const online = !!(r && r.ok && r.data && r.data.ok);
      b4CreditAnswer = { customerId:customer.id, amount:roundMoney(creditAmount), saleUid, at:Date.now(), online, data: online? r.data : null };
    })().finally(()=>{ _b4Checking = false; if(typeof window!=="undefined") window._b4Checking = false; b4CheckingNote(false); retry(); });
    return "waiting";
  }
  function b4CheckingNote(on){
    if(typeof document==="undefined" || typeof document.getElementById!=="function" || typeof document.createElement!=="function" || !document.body) return;
    let el = document.getElementById("b4CreditNote");
    if(!on){ if(el) el.remove(); return; }
    if(!el){ el = document.createElement("div"); el.id = "b4CreditNote"; el.className = "sync-toast show"; el.setAttribute("role","status");
      el.innerHTML = `<span class="sync-toast-dot"></span><span>Checking the customer's credit with seiGEN…</span>`; document.body.appendChild(el); }
  }
  // What the credit limit check (pos.js creditLimitCheck) counts against, or null for the v34 rule (this till).
  // -> { balance, limit, scope:'business'|'last_sync', label, offline }
  function b4CreditBasis(customer, creditAmount){
    if(!(creditAmount>0) || !b4CreditActive(customer)) return null;
    const a = b4CreditAnswer;
    if(a && a.customerId===customer.id && a.amount===roundMoney(creditAmount) && a.online && a.data)
      return { balance: roundMoney(Number(a.data.balance||0) + Number(a.data.held||0)), limit: a.data.limit==null? null : Number(a.data.limit),
        scope:"business", label:"Balance (business)", offline:false, allowed:!!a.data.allowed };
    return { balance: b4SnapshotBalance(customer), limit:null, scope:"last_sync", label:"Balance (as of last sync"+(b4LastSyncText()? " "+b4LastSyncText() : "")+")", offline:true };
  }
  // seiGEN answered with the business balance for this sale (the Q5 note isn't needed then).
  function b4CreditBusinessAnswered(customer, creditAmount){ const b = b4CreditBasis(customer, creditAmount); return !!(b && b.scope==="business"); }
  // After the sale is written (pos.js): the sale keeps the hold's uid (so seiGEN ends the
  // hold), and an override online is held too (decision 30: the sale goes through).
  function b4AfterCreditSale(saleId, customer, creditAmount, overridden){
    const a = b4CreditAnswer;
    b4CreditAnswer = null;
    if(!a || !customer || a.customerId!==customer.id) return;
    try{ run("UPDATE sales SET b4_hold_uid=? WHERE id=?",[a.saleUid, saleId]); }catch(e){}
    if(overridden && isOnline() && b4CreditActive(customer))
      terminalRpc("cl_device_credit_check", Object.assign(terminalAuth(), { p_customer_uid:customer.uid, p_sale_uid:a.saleUid,
        p_amount:roundMoney(creditAmount), p_limit:customer.credit_limit==null? null : Number(customer.credit_limit), p_override:true }), { timeoutMs:B4_CREDIT_TIMEOUT_MS }).catch(()=>{});
  }
  function b4ClearCreditAnswer(){ b4CreditAnswer = null; }

  // ---- the worker ----
  let _b4LastPersist = Date.now();
  function b4Persist(){
    if(Date.now() - _b4LastPersist < B4_PERSIST_EVERY_MS) return;
    _b4LastPersist = Date.now();
    persist();
  }
  let _b4Timer = null, _b4SoonTimer = null, _b4LastBalances = 0;
  async function b4Tick(){
    if(!b4Registered()) return { skipped:"not registered" };
    if(!b4Started()) return { skipped:"not started" };
    // a sale in progress (the cart open): not now, in a moment (selling never waits for B4)
    if(typeof drawerOpen!=="undefined" && drawerOpen){ b4Soon(); return { skipped:"sale in progress" }; }
    try{
      const h = b4QueueHistoryStep();
      b4ScanLive();
      if(!h.done) setTimeout(()=>{ b4Soon(); }, 50);   // the rest of the history in the next step, without holding the screen
      const res = await b4SendNow();
      if(isOnline() && !b4Seat() && (Date.now()-_b4LastBalances > B4_BALANCES_EVERY_MS || res.sent>0)){
        _b4LastBalances = Date.now();
        await b4PullBalances().catch(()=>{});
      }
      b4RefreshIndicator();
      return res;
    }catch(e){ return { error:String(e && e.message || e) }; }
  }
  function b4Soon(){
    if(_b4SoonTimer) return;
    _b4SoonTimer = setTimeout(()=>{ _b4SoonTimer = null; b4Tick(); }, B4_SOON_MS);
  }
  function b4Schedule(){
    if(_b4Timer) clearTimeout(_b4Timer);
    const busy = b4Started() && b4WaitingCount()>0;
    _b4Timer = setTimeout(async ()=>{ _b4Timer = null; await b4Tick(); b4Schedule(); }, busy? B4_BUSY_POLL_MS : B4_IDLE_POLL_MS);
  }
  // Called once at boot (main.js); a no-op until the till is registered and has checked in.
  function startB4Worker(){
    // the first look 5 s after boot (what waited from the last session goes soon), then the usual rhythm
    if(_b4Timer) clearTimeout(_b4Timer);
    _b4Timer = setTimeout(async ()=>{ _b4Timer = null; await b4Tick(); b4Schedule(); }, 5000);
    if(typeof window!=="undefined" && window.addEventListener) window.addEventListener("online", ()=>{ setSetting("b4_batch", String(B4_BATCH_MAX));
      run("UPDATE b4_outbox SET next_ts='' WHERE status='queued'"); b4Tick(); });
  }
  // After every successful check-in (devicecheckin.js): the first one starts B4.
  function b4AfterCheckin(){
    if(!b4Registered()) return Promise.resolve();
    if(b4Begin()) persist();
    return b4Tick();
  }

  // ---- the indicator ----
  function b4WaitingCount(){ try{ return one("SELECT COUNT(*) AS n FROM b4_outbox WHERE status='queued'").n; }catch(e){ return 0; } }
  function b4StatusText(){
    const n = b4WaitingCount(), t = getSetting("b4_last_sent_ts","");
    const when = t? new Date(t).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }) : "";
    return (n? n+" waiting to send" : "All sent") + (when? " · last sent "+when : "");
  }
  function b4IndicatorHtml(){
    if(!b4Started()) return "";
    const n = b4WaitingCount();
    return `<button type="button" class="b4-sync${n? " b4-waiting" : ""}" id="b4SyncInd" title="Sales sync with seiGEN" style="display:block;width:100%;text-align:left;background:none;border:0;padding:2px 2px 6px;font-size:12px;color:var(--ink-soft,#667);cursor:pointer">
      <span aria-hidden="true">${n? "⏳" : "✓"}</span> <span id="b4SyncText">${escapeHtml(b4StatusText())}</span></button>`;
  }
  function b4WireIndicator(){
    const b = typeof document!=="undefined" && document.getElementById? document.getElementById("b4SyncInd") : null;
    if(b) b.onclick = ()=> openB4Details();
  }
  function b4RefreshIndicator(){
    const el = typeof document!=="undefined" && document.getElementById? document.getElementById("b4SyncText") : null;
    if(el) el.textContent = b4StatusText();
  }
  const B4_KIND_LABEL = { sale:"Sales", "return":"Returns", credit_payment:"Credit payments", payout:"Payouts", eod:"End of Day", credit_override:"Credit overrides",
    credit_bf:"Balances brought forward", price_change:"Price changes", voucher_issue:"Vouchers issued", voucher_use:"Vouchers used" };
  function b4Details(){
    const rows = all("SELECT kind, history, COUNT(*) AS n FROM b4_outbox WHERE status='queued' GROUP BY kind, history ORDER BY MIN(priority), kind");
    const waiting = all("SELECT * FROM b4_outbox WHERE status='queued' AND customer_id IS NOT NULL").filter(r=>{ try{ return b4CreditAffecting(r, JSON.parse(r.payload_json)) && b4CustomerWaiting(r.customer_id); }catch(e){ return false; } }).length;
    const refused = one("SELECT COUNT(*) AS n FROM b4_outbox WHERE status='refused'").n;
    return { rows, waiting, refused, error:getSetting("b4_last_error",""), status:b4StatusText(), sent: one("SELECT COUNT(*) AS n FROM b4_outbox WHERE status='sent'").n };
  }
  function openB4Details(){
    const d = b4Details();
    const wrap = openModal("Sales sync", `
      <p style="font-weight:600" id="b4dStatus">${escapeHtml(d.status)}</p>
      ${d.rows.length? `<table class="simple">${d.rows.map(r=>`<tr><td>${escapeHtml(B4_KIND_LABEL[r.kind]||r.kind)}${r.history? " (history)" : ""}</td><td>${r.n}</td></tr>`).join("")}</table>`
        : `<p class="muted">Nothing waiting. Every sale and money event of this till is on seiGEN.</p>`}
      ${d.waiting? `<p class="muted" id="b4dCust">${d.waiting} credit event${d.waiting===1?"":"s"} wait${d.waiting===1?"s":""} until the customer is on seiGEN (Customers to check, or the next sync).</p>` : ""}
      ${d.refused? `<p class="muted">${d.refused} event${d.refused===1?"":"s"} seiGEN didn't take (kept on this till).</p>` : ""}
      ${d.error && !isOnline()? "" : d.error? `<p class="muted" id="b4dErr">Last problem: ${escapeHtml(d.error)}</p>` : ""}
      ${!isOnline()? `<p class="muted">You're offline: selling goes on, and everything is sent when the signal is back.</p>` : ""}
      <p class="muted" style="font-size:12px">${d.sent} sent so far. Selling never waits for this.</p>
      <button class="btn btn-outline" id="b4dNow" style="margin-top:8px">Send now</button>`);
    const btn = wrap.querySelector("#b4dNow");
    btn.onclick = async ()=>{ btn.disabled = true; btn.textContent = "Sending…"; run("UPDATE b4_outbox SET next_ts='' WHERE status='queued'"); await b4Tick(); wrap.remove(); render(); };
    return wrap;
  }
  function b4SettingsHtml(){
    if(!b4Started()) return "";
    return `<p class="muted" id="b4SettingsLine" style="font-size:12px;margin-top:6px">Sales sync: ${escapeHtml(b4StatusText())}</p>`;
  }
