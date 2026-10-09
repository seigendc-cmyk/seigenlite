  // ================== Suppliers & the supplier GRV (Dispatch & GRV B2) ==================
  // docs/dispatch/dispatch-grv-supabase-design.md §15-16; server side:
  // supabase/migrations/20261018120000_supplier_grv.sql.
  //
  // Main branch only (costs stay off remote branches), as Purchasing always was.
  //   * One supplier list per business, kept by main-branch tills, pulled by all.
  //   * A supplier GRV: supplier, invoice number (required; the same invoice
  //     twice is refused, here and across the business), lines with unit
  //     cost, an optional delivery cost landed on the lines by value, an
  //     optional new selling price per line (Admin passcode).
  //   * Stock comes in at once, tied to the GRV uid (works offline). The GRV
  //     then goes to seiGEN; if another till got the same invoice in first,
  //     this till takes its receipt back out (kind supplier_grv_reversed) and
  //     says so. A GRV a restored backup lost is put back from seiGEN, once.
  //   * A new selling price on main is main's own price: the catalogue sync
  //     takes it to the other tills, and branches that follow main follow it.
  // Unregistered and shared-stock tills keep everything on the device.

  const sgSyncOn = ()=> typeof dsEnabled==="function" && dsEnabled();
  const sgInvoiceKey = (s)=> String(s||"").replace(/[^A-Za-z0-9]/g,"").toUpperCase();
  function sgSuppliers(includeInactive){
    return all("SELECT * FROM suppliers"+(includeInactive? "" : " WHERE COALESCE(active,1)=1")+" ORDER BY lower(name)");
  }
  function sgSupplier(uid){ return one("SELECT * FROM suppliers WHERE uid=?",[uid]); }

  // ---- the supplier list ----
  // o: { uid?, name, phone?, notes?, active? } -> the saved row. Main branch only.
  function sgSaveSupplier(o){
    if(isRemote()) throw new Error("Suppliers are kept on the main branch.");
    const name = String(o.name||"").trim().replace(/\s+/g," ");
    if(!name || name.length>80) throw new Error("Give the supplier's name (up to 80 characters).");
    const uid = o.uid || dsNewUid();
    const same = one("SELECT * FROM suppliers WHERE lower(name)=lower(?) AND uid<>?",[name, uid]);
    if(same) throw new Error("\""+same.name+"\" is already in the supplier list.");
    const ts = new Date().toISOString(), active = o.active===false? 0 : 1;
    run(`INSERT INTO suppliers(uid,name,phone,notes,active,srv,updated_ts) VALUES(?,?,?,?,?,0,?)
         ON CONFLICT(uid) DO UPDATE SET name=excluded.name, phone=excluded.phone, notes=excluded.notes, active=excluded.active, srv=0, updated_ts=excluded.updated_ts`,
      [uid, name, String(o.phone||"").trim(), String(o.notes||"").trim(), active, ts]);
    if(sgSyncOn()) dsSetPending("sup:"+uid, "supplier", { id:dsUuid(uid), name, phone:String(o.phone||"").trim()||null, notes:String(o.notes||"").trim()||null, active:!!active });
    logAudit("Supplier saved", "", name);
    return sgSupplier(uid);
  }

  // ---- landed cost: the delivery cost spread over the lines by value (by units when nothing has a cost) ----
  function sgLanded(lines, deliveryCost){
    const dc = Number(deliveryCost)||0;
    const total = lines.reduce((s,l)=>s+l.qty*l.unitCost,0), units = lines.reduce((s,l)=>s+l.qty,0);
    return lines.map(l=>{
      const share = !dc? 0 : (total>0? dc*(l.qty*l.unitCost)/total : dc*l.qty/units);
      return Math.round((l.unitCost + share/l.qty)*10000)/10000;
    });
  }

  // ---- posting ----
  // o: { supplierUid, invoiceNo, note?, delivery:{ cost, currency }, passcode?,
  //      lines:[{ product (row) | null, name (when new), qty, unitCost, newPrice? }] }
  // -> { grv, lines, warning? }. Throws a plain message, changing nothing, on any refusal.
  async function sgPostGrv(o){
    requireSignedIn();
    if(isRemote()) throw new Error("Goods from suppliers are received on the main branch.");
    const sup = sgSupplier(o.supplierUid);
    if(!sup) throw new Error("Choose the supplier.");
    const invoice = String(o.invoiceNo||"").trim();
    if(!sgInvoiceKey(invoice) || invoice.length>40) throw new Error("Enter the supplier's invoice number.");
    const dc = Math.round((Number(o.delivery && o.delivery.cost)||0)*100)/100;
    const cur = String((o.delivery && o.delivery.currency)||"").trim().toUpperCase();
    if(dc<0) throw new Error("The delivery cost must be 0 or more.");
    if(dc>0 && !/^[A-Z]{3}$/.test(cur)) throw new Error("Give the delivery cost's currency (3 letters, e.g. USD).");
    if(!o.lines || !o.lines.length) throw new Error("Add at least one line.");
    o.lines.forEach((l,i)=>{
      if(!l.product && !String(l.name||"").trim()) throw new Error("Line "+(i+1)+": enter or choose a product.");
      if(!Number.isInteger(l.qty) || l.qty<1) throw new Error("Line "+(i+1)+": the quantity must be a whole number of 1 or more.");
      if(!(l.unitCost>=0)) throw new Error("Line "+(i+1)+": enter the unit cost (0 or more).");
      if(l.newPrice!=null && !(l.newPrice>=0)) throw new Error("Line "+(i+1)+": the new selling price must be 0 or more.");
    });
    let admin = null;
    if(o.lines.some(l=>l.newPrice!=null)){
      if(!hasAdminPasscode()) throw new Error(NO_ADMIN_PASSCODE_MSG);
      admin = findAdmin(o.passcode);
      if(!admin) throw new Error("A new selling price needs the Admin passcode. Incorrect Admin passcode.");
    }
    // the same invoice twice: this till first, then the business (when online)
    const dup = all("SELECT grv_no,grv_till,ts,invoice_no FROM purchases WHERE supplier_uid=? AND COALESCE(srv_status,'')<>'reversed' AND invoice_no IS NOT NULL",[sup.uid])
      .find(p=>sgInvoiceKey(p.invoice_no)===sgInvoiceKey(invoice));
    if(dup) throw new Error("Invoice "+dup.invoice_no+" from "+sup.name+" was already received as "+docDisplay("GRV",dup.grv_no,dup.grv_till)+" on "+new Date(dup.ts).toLocaleDateString()+". Nothing was added.");
    if(sgSyncOn() && isOnline()){
      await sgSendPending();
      const r = await terminalRpc("cl_device_supplier_invoice_check", Object.assign(terminalAuth(), { p_supplier_id:dsUuid(sup.uid), p_invoice_no:invoice }));
      if(r.ok && r.data && r.data.found) throw new Error("Invoice "+invoice+" from "+sup.name+" was already received as "+r.data.grv_display+" on till "+r.data.till+" ("+new Date(r.data.posted_at).toLocaleDateString()+"). Nothing was added.");
    }
    const landed = sgLanded(o.lines, dc);
    const now = new Date(), ts = now.toISOString(), branch = currentBranch(), grvUid = dsNewUid();
    let grv;
    const out = dsTx(()=>{
      grv = reserveDocNumber("GRV");
      const sent = [];
      o.lines.forEach((l,i)=>{
        let prod = l.product? one("SELECT * FROM products WHERE id=? AND branch=?",[l.product.id, branch]) : null;
        const created = !prod;
        if(created){
          const nm = String(l.name).trim();
          prod = one("SELECT * FROM products WHERE branch=? AND lower(sku)=lower(?)",[branch,nm]) || one("SELECT * FROM products WHERE branch=? AND lower(name)=lower(?)",[branch,nm]);
        }
        if(!prod){
          run("INSERT INTO products(name,price,stock,low_threshold,sku,branch,image,cost,created_ts,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [String(l.name).trim(), l.newPrice!=null? l.newPrice : 0, 0, 5, "", branch, "", landed[i], ts, ""]);
          prod = one("SELECT * FROM products WHERE id=last_insert_rowid()");
        }
        const oldPrice = Number(prod.price)||0;
        run("UPDATE products SET cost=? WHERE id=?",[landed[i], prod.id]);
        if(l.newPrice!=null && Math.round(l.newPrice*100)!==Math.round(oldPrice*100)){
          run("UPDATE products SET price=? WHERE id=?",[l.newPrice, prod.id]);
          logAudit("Price change", prod.name, (prod.sku||"no code")+": "+oldPrice.toFixed(2)+" -> "+Number(l.newPrice).toFixed(2)+" at "+grv.text+" (authorised by "+admin.name+")");
        }
        run(`INSERT INTO purchases(ts,branch,user,supplier,product_id,product_name,sku,qty,unit_cost,total_cost,note,invoice_no,grv_no,grv_till,grv_uid,supplier_uid,landed_cost,delivery_cost,srv_status)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ts, branch, String(sessionUser||""), sup.name, prod.id, prod.name, prod.sku||"", l.qty, l.unitCost, l.qty*l.unitCost, String(o.note||"").trim(),
           invoice, grv.n, grv.till||null, grvUid, sup.uid, landed[i], i===0? dc : 0, sgSyncOn()? "queued" : ""]);
        moveStock({ productId:prod.id, delta:l.qty, kind:"supplier_grv", docType:"grv", docUid:grvUid, docNo:grv.text, ts, note:"From "+sup.name+", invoice "+invoice });
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user,grv_no,till_code) VALUES(?,?,?,?,?,?,?,?,?)",
          [ts, prod.id, prod.name, l.qty, grv.text+" from "+sup.name+" (invoice "+invoice+")", branch, String(sessionUser||""), grv.n, grv.till||null]);
        sent.push({ cat_uid:prod.cat_uid||null, code:prod.sku||"", name:prod.name, qty:l.qty, unit_cost:l.unitCost, landed_cost:landed[i],
          old_price: l.newPrice!=null? oldPrice : null, new_price: l.newPrice!=null? l.newPrice : null, price_by: l.newPrice!=null? admin.name : null, created });
      });
      logAudit("Supplier GRV", "", grv.text+": "+o.lines.length+" line"+(o.lines.length===1?"":"s")+" from "+sup.name+", invoice "+invoice+(dc>0? ", delivery "+cur+" "+dc.toFixed(2) : ""));
      if(sgSyncOn()) dsSetPending("sgrv:"+grvUid, "supplier_grv", { id:dsUuid(grvUid), supplier_id:dsUuid(sup.uid), invoice_no:invoice, grv_no:grv.n, grv_display:grv.text,
        received_by:String(sessionUser||""), delivery:{ cost:dc, currency:dc>0? cur : null }, note:String(o.note||"").trim()||null, created_iso:localIso(now),
        lines: sent.map(s=>{ const c = Object.assign({}, s); delete c.created; return c; }) });
      return sent;
    });
    await persist();
    let warning = "";
    if(sgSyncOn()){ await sgSendPending(); const p = one("SELECT srv_status FROM purchases WHERE grv_uid=? LIMIT 1",[grvUid]); if(p && p.srv_status==="reversed") warning = dsProblems().map(x=>x.text).filter(t=>t.indexOf(grv.text)!==-1).join(" "); }
    return { grv, grvUid, lines:out, warning };
  }
  // Another till got the same invoice in first: this till's receipt comes back out, once.
  function sgReverse(grvUid, why){
    dsTx(()=>{
      if(dsApplied(grvUid+":reversed")) return;
      const ts = new Date().toISOString();
      all("SELECT * FROM purchases WHERE grv_uid=?",[grvUid]).forEach(p=>{
        const prod = one("SELECT * FROM products WHERE id=?",[p.product_id]);
        if(!prod) return;
        moveStock({ productId:prod.id, delta:-p.qty, kind:"supplier_grv_reversed", docType:"grv", docUid:grvUid+":reversed", docNo:docDisplay("GRV",p.grv_no,p.grv_till), ts, note:why });
        run("INSERT INTO stock_received(ts,product_id,name,qty,note,branch,user,grv_no,till_code) VALUES(?,?,?,?,?,?,?,?,?)",
          [ts, prod.id, prod.name, -p.qty, docDisplay("GRV",p.grv_no,p.grv_till)+" taken back: "+why, currentBranch(), String(sessionUser||""), p.grv_no, p.grv_till||null]);
      });
      run("UPDATE purchases SET srv_status='reversed' WHERE grv_uid=?",[grvUid]);
      logAudit("Supplier GRV taken back", "", why);
    });
  }

  // ---- seiGEN ----
  let _sgSending = null;
  function sgSendPending(){
    if(_sgSending) return _sgSending;
    _sgSending = (async ()=>{
      if(!sgSyncOn() || !isOnline()) return;
      for(const p of dsPending("supplier")){
        const r = await terminalRpc("cl_device_supplier_save", Object.assign(terminalAuth(), { p_supplier:p.payload }));
        if(!r.ok && (r.reason==="offline" || r.reason==="network")) return;
        const uid = dsHex(p.payload.id);
        if(r.ok){ run("DELETE FROM srv_pending WHERE key=?",[p.key]); run("UPDATE suppliers SET srv=1 WHERE uid=?",[uid]); continue; }
        if(r.code==="DUPLICATE_SUPPLIER" && r.data && r.data.supplier){
          // the business already has it (another till added it first): use theirs
          const theirs = dsHex(r.data.supplier.id);
          dsTx(()=>{
            run("DELETE FROM suppliers WHERE uid=?",[uid]);
            run("INSERT OR REPLACE INTO suppliers(uid,name,phone,notes,active,srv,updated_ts) VALUES(?,?,?,?,?,1,?)",
              [theirs, r.data.supplier.name, r.data.supplier.phone||"", r.data.supplier.notes||"", r.data.supplier.active?1:0, new Date().toISOString()]);
            run("UPDATE purchases SET supplier_uid=? WHERE supplier_uid=?",[theirs, uid]);
            dsPending("supplier_grv").filter(g=>g.payload.supplier_id===p.payload.id).forEach(g=>{ g.payload.supplier_id = r.data.supplier.id; dsSetPending(g.key, "supplier_grv", g.payload); });
            run("DELETE FROM srv_pending WHERE key=?",[p.key]);
          });
          continue;
        }
        run("UPDATE srv_pending SET tries=tries+1, error=? WHERE key=?",[(r.data&&r.data.message)||r.message||r.code||"", p.key]);
      }
      for(const p of dsPending("supplier_grv")){
        const r = await terminalRpc("cl_device_supplier_grv_post", Object.assign(terminalAuth(), { p_grv:p.payload }), { timeoutMs:20000 });
        if(!r.ok && (r.reason==="offline" || r.reason==="network")) return;
        const uid = dsHex(p.payload.id);
        if(r.ok){ run("DELETE FROM srv_pending WHERE key=?",[p.key]); run("UPDATE purchases SET srv_status='sent' WHERE grv_uid=?",[uid]); continue; }
        if(r.code==="DUPLICATE_INVOICE"){
          const msg = p.payload.grv_display+": "+((r.data&&r.data.message)||"that invoice was already received")+" This till's receipt was taken back out.";
          sgReverse(uid, (r.data&&r.data.message)||"Invoice already received");
          dsAddProblem("sgrv:"+uid, msg);
          run("DELETE FROM srv_pending WHERE key=?",[p.key]);
          continue;
        }
        if(r.code==="NO_SUCH_SUPPLIER"){ run("UPDATE srv_pending SET tries=tries+1, error=? WHERE key=?",[r.data.message, p.key]); continue; }   // the supplier goes first; tried again
        run("UPDATE srv_pending SET tries=tries+1, error=? WHERE key=?",[(r.data&&r.data.message)||r.message||r.code||"", p.key]);
        run("UPDATE purchases SET srv_status='error' WHERE grv_uid=?",[uid]);
      }
    })().then(()=>persist()).finally(()=>{ _sgSending = null; });
    return _sgSending;
  }
  async function sgPull(){
    if(!sgSyncOn() || !isOnline()) return { ok:false };
    await sgSendPending();
    const r = await terminalRpc("cl_device_suppliers_pull", terminalAuth(), { timeoutMs:20000 });
    if(!r.ok) return { ok:false, message:r.message||r.code||r.reason };
    const pending = new Set(dsPending("supplier").map(p=>dsHex(p.payload.id)));
    (r.data.suppliers||[]).forEach(s=>{
      const uid = dsHex(s.id);
      if(pending.has(uid)) return;                       // a change made here that isn't sent yet wins
      run(`INSERT INTO suppliers(uid,name,phone,notes,active,srv,updated_ts) VALUES(?,?,?,?,?,1,?)
           ON CONFLICT(uid) DO UPDATE SET name=excluded.name, phone=excluded.phone, notes=excluded.notes, active=excluded.active, srv=1, updated_ts=excluded.updated_ts`,
        [uid, s.name, s.phone||"", s.notes||"", s.active?1:0, s.updated_at||""]);
    });
    if(typeof dsBumpCounter==="function") dsBumpCounter("GRV", r.data.max_grv_no);
    (r.data.my_grvs||[]).forEach(g=>{ try{ sgReconcileOne(g); }catch(e){ dsAddProblem("sgrv:"+dsHex(g.id), g.grv_display+": "+(e.message||e)); } });
    await persist();
    return { ok:true };
  }
  // A supplier GRV seiGEN holds from this till, missing here (a restored backup): put back once.
  function sgReconcileOne(g){
    const uid = dsHex(g.id);
    if(dsApplied(uid) || one("SELECT 1 AS x FROM purchases WHERE grv_uid=?",[uid])) return;
    const missing = (g.lines||[]).filter(l=>!dsFindProduct(l));
    if(missing.length){ dsAddProblem("sgrv:"+uid, g.grv_display+": "+missing.map(l=>l.name).join(", ")+" isn't in this branch, so the receipt can't be put back. Add the product, then sync."); return; }
    const ts = new Date().toISOString(), branch = currentBranch();
    dsTx(()=>{
      (g.lines||[]).forEach((l,i)=>{
        const prod = dsFindProduct(l);
        run(`INSERT INTO purchases(ts,branch,user,supplier,product_id,product_name,sku,qty,unit_cost,total_cost,note,invoice_no,grv_no,grv_till,grv_uid,supplier_uid,landed_cost,delivery_cost,srv_status)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'sent')`,
          [g.posted_at||ts, branch, g.received_by||"", g.supplier, prod.id, prod.name, prod.sku||"", l.qty, Number(l.unit_cost), l.qty*Number(l.unit_cost), "Put back from seiGEN",
           g.invoice_no, g.grv_no, g.till||null, uid, dsHex(g.supplier_id), l.landed_cost==null? null : Number(l.landed_cost), i===0? Number(g.delivery_cost)||0 : 0]);
        moveStock({ productId:prod.id, delta:l.qty, kind:"supplier_grv", docType:"grv", docUid:uid, docNo:g.grv_display, ts, note:"From "+g.supplier+", invoice "+g.invoice_no+" (put back from seiGEN)" });
      });
      dsClearProblem("sgrv:"+uid);
    });
  }
  function sgAfterCheckin(){ return sgSyncOn()? sgPull().catch(()=>{}) : Promise.resolve(); }
  if(typeof window!=="undefined" && window.addEventListener) window.addEventListener("online", ()=>{ if(sgSyncOn()) sgSendPending().catch(()=>{}); });
