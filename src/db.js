  function idbOpen(){
    return new Promise((res,rej)=>{
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = ()=> r.result.createObjectStore(IDB_STORE);
      r.onsuccess = ()=> res(r.result);
      r.onerror = ()=> rej(r.error);
    });
  }
  async function idbGet(){
    const conn = await idbOpen();
    return new Promise((res,rej)=>{
      const tx = conn.transaction(IDB_STORE,"readonly");
      const rq = tx.objectStore(IDB_STORE).get(IDB_KEY);
      rq.onsuccess=()=>res(rq.result||null);
      rq.onerror=()=>rej(rq.error);
    });
  }
  async function idbSet(bytes){
    const conn = await idbOpen();
    return new Promise((res,rej)=>{
      const tx = conn.transaction(IDB_STORE,"readwrite");
      tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
      tx.oncomplete=()=>res(true);
      tx.onerror=()=>rej(tx.error);
    });
  }
  async function persist(){ await idbSet(db.export()); }

  // ---- generic (multi-db-capable) helpers ----
  function allX(t, sql, params=[]){
    const stmt = t.prepare(sql);
    stmt.bind(params);
    const out=[];
    while(stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }
  function oneX(t, sql, params=[]){ const r = allX(t, sql, params); return r.length? r[0]: null; }
  function runX(t, sql, params=[]){ t.run(sql, params); }
  function all(sql, params=[]){ return allX(db, sql, params); }
  function one(sql, params=[]){ return oneX(db, sql, params); }
  function run(sql, params=[]){ return runX(db, sql, params); }

  function getSettingX(t, key, fallback=""){ const r = oneX(t,"SELECT value FROM settings WHERE key=?",[key]); return r? r.value: fallback; }
  function setSetting(key, value){
    run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key,String(value)]);
  }
  function getSetting(key, fallback=""){ return getSettingX(db, key, fallback); }
  function currentBranch(){ return getSetting("branch_name","") || getSetting("shop_name","") || "Main"; }
  function isRemote(){ return getSetting("branch_type","main")==="remote"; }
  function logAudit(action, productName, details){
    run("INSERT INTO audit_log(ts,branch,user,action,product_name,details) VALUES(?,?,?,?,?,?)",
      [new Date().toISOString(), currentBranch(), sessionUser||"Unknown", action, productName||"", details||""]);
  }

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS products(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0,
      low_threshold INTEGER NOT NULL DEFAULT 5
    );
    CREATE TABLE IF NOT EXISTS sales(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, subtotal REAL DEFAULT 0,
      discount REAL DEFAULT 0, total REAL, method TEXT, customer_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS sale_items(
      id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER,
      product_id INTEGER, name TEXT, price REAL, qty INTEGER
    );
    CREATE TABLE IF NOT EXISTS eod_sessions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT,
      expected_cash REAL, counted_cash REAL, variance REAL, notes TEXT
    );
    CREATE TABLE IF NOT EXISTS customers(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT
    );
    CREATE TABLE IF NOT EXISTS payouts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, amount REAL, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS credit_payments(
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, ts TEXT, amount REAL, note TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_received(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, product_id INTEGER, name TEXT, qty INTEGER, note TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, branch TEXT, user TEXT, action TEXT, product_name TEXT, details TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_requests(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, branch TEXT, user TEXT,
      item_requested TEXT, customer_name TEXT, customer_phone TEXT, qty_wanted INTEGER, notes TEXT, fulfilled INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS stock_transfers(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, from_branch TEXT, to_branch TEXT,
      product_name TEXT, sku TEXT, qty INTEGER, note TEXT, user TEXT,
      status TEXT DEFAULT 'Dispatched', received_ts TEXT, received_user TEXT
    );
    CREATE TABLE IF NOT EXISTS stocktakes(
      id INTEGER PRIMARY KEY AUTOINCREMENT, branch TEXT, team_names TEXT,
      start_date TEXT, end_date TEXT, status TEXT DEFAULT 'Open',
      cutoff_ts TEXT, created_by TEXT, created_ts TEXT
    );
    CREATE TABLE IF NOT EXISTS stocktake_counts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, stocktake_id INTEGER, product_id INTEGER,
      product_name TEXT, sku TEXT, system_qty INTEGER, counted_qty INTEGER,
      counted_ts TEXT, counted_by TEXT
    );
    CREATE TABLE IF NOT EXISTS purchases(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, branch TEXT, user TEXT,
      supplier TEXT, product_id INTEGER, product_name TEXT, sku TEXT,
      qty INTEGER, unit_cost REAL, total_cost REAL, note TEXT
    );
    CREATE TABLE IF NOT EXISTS staff(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, role TEXT DEFAULT 'Cashier',
      passcode TEXT, branch TEXT, active INTEGER DEFAULT 1, created_ts TEXT
    );
    CREATE TABLE IF NOT EXISTS vouchers(
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, amount REAL,
      branch TEXT, earned_ts TEXT, status TEXT DEFAULT 'Available',
      redeemed_ts TEXT, redeemed_sale_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS doc_counters(
      branch_id TEXT, doc_type TEXT, last_no INTEGER DEFAULT 0, PRIMARY KEY(branch_id, doc_type)
    );
    CREATE TABLE IF NOT EXISTS dispatch_docs(
      dispatch_branch_id TEXT, dn_no INTEGER, dispatch_branch_name TEXT, receive_branch_name TEXT,
      direction TEXT, grv_no INTEGER, created_ts TEXT, PRIMARY KEY(dispatch_branch_id, dn_no)
    );
    CREATE TABLE IF NOT EXISTS dn_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
      dn_branch_id TEXT NOT NULL, dn_no INTEGER NOT NULL, event_type TEXT NOT NULL,
      actor_branch_id TEXT DEFAULT '', actor_branch_name TEXT DEFAULT '', dn_from_name TEXT DEFAULT '', dn_to_name TEXT DEFAULT '',
      event_ts TEXT NOT NULL, grv_no INTEGER, detail_json TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stock_adjustments(
      id INTEGER PRIMARY KEY AUTOINCREMENT, branch TEXT, branch_id TEXT, adj_no INTEGER,
      product_code TEXT DEFAULT '', product_name TEXT, qty_delta INTEGER, reason TEXT, note TEXT,
      by_user TEXT, authorised_by TEXT, ts TEXT, dn_branch_id TEXT, dn_no INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_adjustments ON stock_adjustments(branch_id, adj_no);
    CREATE TABLE IF NOT EXISTS dn_cases(
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_no INTEGER, dn_branch_id TEXT, dn_no INTEGER,
      kind TEXT, state TEXT DEFAULT 'pending', nonce TEXT, plan_json TEXT, replaced_by INTEGER,
      override INTEGER DEFAULT 0, note TEXT, started_ts TEXT, started_by TEXT, authorised_by TEXT,
      posted_ts TEXT, posted_via TEXT, acked_ts TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_dn_cases ON dn_cases(dn_branch_id, case_no);
    CREATE TABLE IF NOT EXISTS branch_register(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, whatsapp TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS branch_prices(
      dest_branch_name TEXT NOT NULL COLLATE NOCASE, code TEXT NOT NULL COLLATE NOCASE, price REAL NOT NULL, updated_ts TEXT,
      PRIMARY KEY(dest_branch_name, code)
    );
  `;
  function migrate(t){
    const alters = [
      "ALTER TABLE sales ADD COLUMN subtotal REAL DEFAULT 0",
      "ALTER TABLE sales ADD COLUMN discount REAL DEFAULT 0",
      "ALTER TABLE sales ADD COLUMN customer_id INTEGER",
      "ALTER TABLE sales ADD COLUMN branch TEXT DEFAULT ''",
      "ALTER TABLE sales ADD COLUMN discount_reason TEXT DEFAULT ''",
      "ALTER TABLE sales ADD COLUMN discount_approved_by TEXT DEFAULT ''",
      "ALTER TABLE sales ADD COLUMN discount_status TEXT DEFAULT ''",
      "ALTER TABLE sales ADD COLUMN markup REAL DEFAULT 0",
      "ALTER TABLE sales ADD COLUMN markup_reason TEXT DEFAULT ''",
      "ALTER TABLE sales ADD COLUMN voucher_amount REAL DEFAULT 0",
      "ALTER TABLE sales ADD COLUMN payment_ref TEXT DEFAULT ''",
      "ALTER TABLE sales ADD COLUMN user TEXT DEFAULT ''",
      "ALTER TABLE sale_items ADD COLUMN cost REAL DEFAULT 0",
      "ALTER TABLE products ADD COLUMN sku TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN image TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN branch TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN cost REAL DEFAULT 0",
      "ALTER TABLE products ADD COLUMN description TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN created_ts TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN shelf TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN category TEXT DEFAULT ''",
      "ALTER TABLE payouts ADD COLUMN branch TEXT DEFAULT ''",
      "ALTER TABLE payouts ADD COLUMN user TEXT DEFAULT ''",
      "ALTER TABLE stock_received ADD COLUMN branch TEXT DEFAULT ''",
      "ALTER TABLE stock_received ADD COLUMN user TEXT DEFAULT ''",
      "ALTER TABLE eod_sessions ADD COLUMN branch TEXT DEFAULT ''",
      "ALTER TABLE eod_sessions ADD COLUMN ts TEXT DEFAULT ''",
      "ALTER TABLE credit_payments ADD COLUMN branch TEXT DEFAULT ''",
      "ALTER TABLE credit_payments ADD COLUMN user TEXT DEFAULT ''",
      "ALTER TABLE customers ADD COLUMN branch TEXT DEFAULT ''",
      "ALTER TABLE customers ADD COLUMN address TEXT DEFAULT ''",
      "ALTER TABLE customers ADD COLUMN town_city TEXT DEFAULT ''",
      "ALTER TABLE customers ADD COLUMN suburb TEXT DEFAULT ''",
      "ALTER TABLE stock_transfers ADD COLUMN dn_no INTEGER",
      "ALTER TABLE stock_received ADD COLUMN dn_branch_id TEXT",
      "ALTER TABLE stock_received ADD COLUMN dn_no INTEGER",
      "ALTER TABLE stock_received ADD COLUMN grv_no INTEGER",
      "ALTER TABLE dispatch_docs ADD COLUMN imported_ts TEXT DEFAULT ''",
      "ALTER TABLE dispatch_docs ADD COLUMN received_ts TEXT DEFAULT ''",
      "ALTER TABLE dispatch_docs ADD COLUMN received_iso TEXT DEFAULT ''",
      "ALTER TABLE dispatch_docs ADD COLUMN received_by TEXT DEFAULT ''",
      "ALTER TABLE dispatch_docs ADD COLUMN variance_json TEXT DEFAULT ''",
      "ALTER TABLE dispatch_docs ADD COLUMN variance_ts TEXT DEFAULT ''",
      "ALTER TABLE branch_register ADD COLUMN price_mode TEXT DEFAULT 'follow_main'",
      "ALTER TABLE branch_register ADD COLUMN catalogue_ts TEXT DEFAULT ''",
      "ALTER TABLE branch_register ADD COLUMN catalogue_fp TEXT DEFAULT ''",
      "ALTER TABLE branch_register ADD COLUMN catalogue_mode TEXT DEFAULT ''",
      "ALTER TABLE dispatch_docs ADD COLUMN status TEXT DEFAULT 'dispatched'",
      "ALTER TABLE dispatch_docs ADD COLUMN file_name TEXT DEFAULT ''",
      "ALTER TABLE dispatch_docs ADD COLUMN line_count INTEGER DEFAULT 0",
      "ALTER TABLE dispatch_docs ADD COLUMN unit_total INTEGER DEFAULT 0",
      "ALTER TABLE dispatch_docs ADD COLUMN created_iso TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN price_ts TEXT DEFAULT ''",
      "ALTER TABLE branch_register ADD COLUMN prices_ts TEXT DEFAULT ''",
      "ALTER TABLE stock_transfers ADD COLUMN dn_branch_id TEXT",
      "ALTER TABLE stock_received ADD COLUMN adj_branch_id TEXT",
      "ALTER TABLE stock_received ADD COLUMN adj_no INTEGER",
      "ALTER TABLE branch_register ADD COLUMN catalogue_first_ts TEXT DEFAULT ''",
      "ALTER TABLE dispatch_docs ADD COLUMN cancel_no INTEGER",
      "ALTER TABLE dispatch_docs ADD COLUMN cancelled_ts TEXT DEFAULT ''",
      "ALTER TABLE dispatch_docs ADD COLUMN replaces_dn_no INTEGER",
      "ALTER TABLE dispatch_docs ADD COLUMN replaced_by INTEGER",
      "ALTER TABLE dispatch_docs ADD COLUMN cancel_kind TEXT DEFAULT ''",
      "ALTER TABLE dispatch_docs ADD COLUMN stock_posted INTEGER DEFAULT 1",
      "ALTER TABLE dispatch_docs ADD COLUMN cancel_nonce TEXT DEFAULT ''"
    ];
    alters.forEach(sql=>{ try{ t.run(sql); }catch(e){} });
    try{ t.run("UPDATE products SET created_ts=? WHERE created_ts IS NULL OR created_ts=''", [new Date().toISOString()]); }catch(e){}
    // products.price_ts = when the selling price last changed. Triggers (rather than
    // edits at every price-changing screen) so no path can forget: manual edit,
    // Excel import, catalogue import and the remote price edit all set it.
    // Created here, after the column exists, and only ever set from real changes.
    try{ t.run("UPDATE products SET price_ts=COALESCE(NULLIF(created_ts,''),?) WHERE price_ts IS NULL OR price_ts=''", [new Date().toISOString()]); }catch(e){}
    try{ t.run(`CREATE TRIGGER IF NOT EXISTS products_price_ts_upd AFTER UPDATE OF price ON products
      WHEN NEW.price IS NOT OLD.price
      BEGIN UPDATE products SET price_ts=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END`); }catch(e){}
    try{ t.run(`CREATE TRIGGER IF NOT EXISTS products_price_ts_ins AFTER INSERT ON products
      WHEN NEW.price_ts IS NULL OR NEW.price_ts=''
      BEGIN UPDATE products SET price_ts=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END`); }catch(e){}
    backfillDnLinks(t);
    // When the FIRST catalogue was generated for a destination (locks its name). Existing rows only
    // know their latest build, which is the best available stand-in.
    try{ t.run("UPDATE branch_register SET catalogue_first_ts=catalogue_ts WHERE (catalogue_first_ts IS NULL OR catalogue_first_ts='') AND catalogue_ts IS NOT NULL AND catalogue_ts<>''"); }catch(e){}
  }
  // Phase 4: DN lines learn which branch id issued them (so a status can be joined
  // on (branch id, dn_no) instead of a name), and dn_events is filled in for
  // dispatches made before it existed. Additive and safe to repeat.
  function backfillDnLinks(t){
    try{ t.run(`UPDATE stock_transfers SET dn_branch_id=(SELECT d.dispatch_branch_id FROM dispatch_docs d
        WHERE d.dn_no=stock_transfers.dn_no AND d.dispatch_branch_name=stock_transfers.from_branch AND d.direction='out')
        WHERE dn_no IS NOT NULL AND (dn_branch_id IS NULL OR dn_branch_id='')`); }catch(e){}
    const ins = `INSERT OR IGNORE INTO dn_events(event_key,dn_branch_id,dn_no,event_type,actor_branch_id,actor_branch_name,dn_from_name,dn_to_name,event_ts,grv_no,detail_json) `;
    const own = `COALESCE((SELECT value FROM settings WHERE key='branch_id'),'')`;
    try{ t.run(ins+`SELECT dispatch_branch_id||'|'||dn_no||'|dispatched', dispatch_branch_id, dn_no, 'dispatched', dispatch_branch_id, dispatch_branch_name,
        dispatch_branch_name, receive_branch_name, created_ts, NULL, '' FROM dispatch_docs WHERE direction='out' AND created_ts IS NOT NULL AND created_ts<>''`); }catch(e){}
    try{ t.run(ins+`SELECT dispatch_branch_id||'|'||dn_no||'|received', dispatch_branch_id, dn_no, 'received', ${own}, receive_branch_name,
        dispatch_branch_name, receive_branch_name, COALESCE(NULLIF(received_iso,''),received_ts), grv_no, '' FROM dispatch_docs
        WHERE status='received' AND COALESCE(NULLIF(received_iso,''),received_ts) IS NOT NULL AND COALESCE(NULLIF(received_iso,''),received_ts)<>''`); }catch(e){}
    try{ t.run(ins+`SELECT dispatch_branch_id||'|'||dn_no||'|variance|'||variance_ts, dispatch_branch_id, dn_no, 'variance', ${own}, receive_branch_name,
        dispatch_branch_name, receive_branch_name, variance_ts, NULL, variance_json FROM dispatch_docs
        WHERE direction='in' AND variance_json IS NOT NULL AND variance_json<>'' AND variance_ts IS NOT NULL AND variance_ts<>''`); }catch(e){}
  }
  function backfillBranch(t, branchName){
    ["products","sales","payouts","stock_received","eod_sessions","credit_payments","customers","stock_requests"].forEach(tbl=>{
      try{ t.run(`UPDATE ${tbl} SET branch=? WHERE branch IS NULL OR branch=''`, [branchName]); }catch(e){}
    });
  }

  async function initDB(){
    SQL = await initSqlJs({ locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}` });
    const existing = await idbGet();
    if(existing){ db = new SQL.Database(new Uint8Array(existing)); }
    else { db = new SQL.Database(); db.run(SCHEMA); await persist(); }
    db.run(SCHEMA);
    migrate(db);
    currency = getSetting("currency","$");
    if(getSetting("setup_complete")==="1"){ backfillBranch(db, currentBranch()); await persist(); }
  }

  function uid4(){
    const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s="";
    for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)];
    return s;
  }
