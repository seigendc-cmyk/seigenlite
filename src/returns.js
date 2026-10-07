  // ================== Sales returns & credit notes (multi-terminal Phase 3c) ==================
  // Design: docs/multi-terminal/phase3c-returns-design.md (owner decisions §4).
  //   * The original receipt is required, and only a sale made on THIS till
  //     can be returned here (returnOriginProblem): never one merged in from
  //     another device, another till or another branch.
  //   * A line returns at the price actually paid (its line discount, an old
  //     cart discount and any voucher shared out by value), never more than
  //     sold minus already returned. Checked again and written in one
  //     transaction (commitCreditNote), so nothing is half-saved.
  //   * The money goes back the same way it was paid (each tender, a foreign
  //     currency at the sale's own rate; the Credit part lowers the debtor
  //     balance), or as store credit, or towards an exchange. A voucher-paid
  //     share only ever comes back as a voucher (owner Q2).
  //   * Good goods go back to stock (moveStock 'return', so a shared-stock
  //     till queues it for the branch: sellable after sync). Damaged goods
  //     are recorded and written off at once; sellable stock never changes.
  //   * The cashier starts it; an Admin approves with the passcode (the stock
  //     adjustment pattern, adjust.js), and a shift must be open (owner Q11).

  const RETURN_REASONS = ["Wrong item","Faulty / damaged","Changed mind","Other"];
  const RETURN_DAYS_DEFAULT = 30;
  const RETURN_OTHER_TILL_TEXT = "This receipt was made on another till. Return it on that till.";
  const RETURN_METHODS = ["same","voucher","debtor","exchange"];
  const RETURN_METHOD_LABEL = { same:"Same way they paid", voucher:"Store credit voucher", debtor:"Reduce debtor balance", exchange:"Exchange" };
  const REFUND_LABEL = { Cash:"Cash refunded", EcoCash:"EcoCash refunded", Bank:"Bank refunded", Debtor:"Debtor balance reduced",
    Voucher:"Store credit voucher", Exchange:"Exchange" };
  const CONDITION_LABEL = { restock:"back to stock", writeoff:"written off" };

  // ---- settings: how long after the sale (owner Q1) ----
  function returnDaysLimit(){
    const n = parseInt(getSetting("return_days",""),10);
    return (n>=1 && n<=365)? n : RETURN_DAYS_DEFAULT;
  }
  function setReturnDaysLimit(days, passcode){
    const n = Number(days);
    if(!Number.isInteger(n) || n<1 || n>365) throw new Error("Enter a number of days from 1 to 365.");
    if(!hasAdminPasscode()) throw new Error(NO_ADMIN_PASSCODE_MSG);
    if(!findAdmin(passcode)) throw new Error("Incorrect Admin passcode. The return limit was not changed.");
    const old = returnDaysLimit();
    if(n===old) return { changed:false };
    setSetting("return_days", String(n));
    logAudit("Return limit changed", "", old+" → "+n+" days");
    persist();
    return { changed:true };
  }
  // the cashier who starts the return goes on the credit note and the audit line
  function returnRequireSignedIn(){
    if(!String(sessionUser||"").trim()) throw new Error("Enter your name first (tap your name at the top), so the return is recorded against you.");
  }
  function cnDisplay(cn){ return docDisplay("CN", cn.cn_no, cn.till_code||""); }

  // ---- finding the original receipt (owner Q4) ----
  // "T1-45" / "t1-0045" -> { receiptNo:"T1-0045" }; "#45" / "45" -> { saleId:45 }
  function parseReceiptQuery(text){
    const t = String(text==null?"":text).trim().toUpperCase().replace(/\s+/g,"");
    let m = /^#?(\d{1,9})$/.exec(t);
    if(m) return { saleId:Number(m[1]) };
    m = /^(T\d{1,3})-(\d{1,9})$/.exec(t);
    if(m) return { receiptNo: m[1]+"-"+String(Number(m[2])).padStart(4,"0") };
    return null;
  }
  // "" when this sale was made on this device, in this branch. The rule
  // (design §4, owner Q4): same branch, never merged in (merged_ts, stamped
  // by mergeDatabase from 3c on), and no other till's terminal stamp.
  function returnOriginProblem(sale){
    if(!sale) return "Receipt not found.";
    if(String(sale.branch||"")!==currentBranch()) return RETURN_OTHER_TILL_TEXT;
    if(sale.merged_ts) return RETURN_OTHER_TILL_TEXT;
    if(sale.terminal_id && sale.terminal_id!==getSetting("terminal_id","")) return RETURN_OTHER_TILL_TEXT;
    return "";
  }
  function businessDaysBetween(a, b){
    const d = (s)=>{ const [y,m,dd] = String(s).split("-").map(Number); return Date.UTC(y,m-1,dd); };
    return Math.round((d(b)-d(a))/86400000);
  }
  function returnAgeProblem(sale, now){
    const limit = returnDaysLimit();
    const days = businessDaysBetween(businessDateOf(sale.ts), businessDateOf(now||new Date()));
    return days>limit? "Receipt "+receiptDisplay(sale)+" is from "+businessDateOf(sale.ts)+", past the "+limit+"-day return limit." : "";
  }
  // -> { sale } | { error, sale? }
  function findReturnSale(text, now){
    const q = parseReceiptQuery(text);
    if(!q) return { error:"Type the receipt number as printed, e.g. T1-0045 or #45." };
    const label = q.receiptNo || "#"+q.saleId;
    const cands = q.saleId!=null? all("SELECT * FROM sales WHERE id=? AND COALESCE(receipt_no,'')=''",[q.saleId])
                                : all("SELECT * FROM sales WHERE upper(receipt_no)=? ORDER BY id",[q.receiptNo]);
    if(!cands.length){
      if(q.receiptNo && currentTillCode() && q.receiptNo.split("-")[0]!==currentTillCode()) return { error:RETURN_OTHER_TILL_TEXT };
      return { error:"Receipt "+label+" wasn't found on this till." };
    }
    const sale = cands.find(s=>!returnOriginProblem(s));
    if(!sale) return { error:returnOriginProblem(cands[0]) };
    const age = returnAgeProblem(sale, now);
    if(age) return { error:age, sale };
    if(saleReturnState(sale).lines.every(l=>l.returnable<=0)){
      const cns = all("SELECT * FROM credit_notes WHERE sale_id=? ORDER BY id",[sale.id]).map(cnDisplay).join(", ");
      return { error:"Everything on receipt "+receiptDisplay(sale)+" has already been returned"+(cns? " ("+cns+")" : "")+".", sale };
    }
    return { sale };
  }

  // ---- the maths ----
  // Splits `total` (money) over `weights` to the cent, largest remainder
  // first, so the parts always add up to exactly `total`.
  function allocateCents(total, weights){
    const cents = Math.round((total||0)*100), W = weights.reduce((s,w)=>s+w,0);
    if(!(W>0) || cents<=0) return weights.map(()=>0);
    const raw = weights.map(w=>cents*w/W), base = raw.map(Math.floor);
    let left = cents - base.reduce((s,x)=>s+x,0);
    raw.map((x,i)=>[x-base[i], i]).sort((a,b)=>b[0]-a[0] || a[1]-b[1]).forEach(([,i])=>{ if(left>0){ base[i]++; left--; } });
    return base.map(c=>c/100);
  }
  // A sale's lines with what each one was really paid, and what's left to return.
  //   B (goodsValue) = sales.total + sales.voucher_amount: the goods after every
  //   discount (line discounts, an old cart-level discount, old markup).
  //   A line's value = B shared by its net (price × qty − line discount).
  function saleReturnState(sale){
    const items = all("SELECT * FROM sale_items WHERE sale_id=? ORDER BY id",[sale.id]);
    const done = new Map(all(`SELECT i.sale_item_id AS id, SUM(i.qty) AS q, SUM(i.amount) AS a FROM credit_note_items i
      JOIN credit_notes c ON c.id=i.cn_id WHERE c.sale_id=? GROUP BY i.sale_item_id`,[sale.id]).map(r=>[r.id, r]));
    const B = roundMoney((sale.total||0) + (sale.voucher_amount||0));
    const values = allocateCents(B, items.map(i=>Math.max(0, i.price*i.qty - (i.discount||0))));
    const lines = items.map((i,k)=>{
      const d = done.get(i.id) || { q:0, a:0 };
      const p = i.product_id? one("SELECT id,uid,sku,name,branch,COALESCE(active,1) AS active FROM products WHERE id=?",[i.product_id]) : null;
      return { id:i.id, uid:i.uid||null, productId:p? p.id : null, productUid:p? (p.uid||null) : null, code:p? (p.sku||"") : "",
        name:i.name, qty:i.qty, price:i.price, discount:i.discount||0, cost:i.cost||0, value:values[k],
        returned:d.q||0, refunded:roundMoney(d.a||0), returnable:i.qty-(d.q||0),
        canRestock: !!(p && p.active===1 && p.branch===currentBranch()) };            // owner Q14: otherwise write-off only
    });
    const payments = salePayments(sale.id).map(p=>{
      const r = one("SELECT COALESCE(SUM(amount),0) AS a, COALESCE(SUM(tendered_amount),0) AS t FROM credit_note_refunds WHERE sale_payment_id=?",[p.id]);
      return Object.assign({}, p, { refunded:roundMoney(r.a), refundedTendered:roundMoney(r.t) });
    });
    const prev = one("SELECT COALESCE(SUM(goods_total),0) AS g, COALESCE(SUM(voucher_part),0) AS v FROM credit_notes WHERE sale_id=?",[sale.id]);
    return { sale, lines, payments, goodsValue:B, goodsRefunded:roundMoney(prev.g), voucherRefunded:roundMoney(prev.v) };
  }
  // picks: [{ saleItemId, qty, condition:'restock'|'writeoff' }] -> the refund for them.
  // The last units of a line get exactly what's left of it, so rounding never refunds more than was paid.
  function computeReturn(state, picks){
    const lines = [];
    for(const p of (picks||[])){
      const l = state.lines.find(x=>x.id===p.saleItemId);
      if(!l) throw new Error("That item isn't on receipt "+receiptDisplay(state.sale)+".");
      const q = Number(p.qty);
      if(!Number.isInteger(q) || q<0) throw new Error("Quantities are whole numbers.");
      if(q===0) continue;
      if(q>l.returnable) throw new Error(l.returnable>0? "Only "+l.returnable+" "+l.name+" can still be returned (sold "+l.qty+", already returned "+l.returned+")."
                                                       : l.name+" has already been returned in full.");
      const condition = p.condition==="writeoff"? "writeoff" : "restock";
      if(condition==="restock" && !l.canRestock) throw new Error(l.name+" is no longer a product here, so it can only be written off.");
      const amount = q===l.returnable? roundMoney(l.value - l.refunded) : roundMoney(l.value*q/l.qty);
      lines.push({ line:l, qty:q, condition, amount, unitRefund: roundMoney(amount/q) });
    }
    if(!lines.length) throw new Error("Choose at least one item to return.");
    const goods = roundMoney(lines.reduce((s,x)=>s+x.amount,0));
    const V = state.sale.voucher_amount||0, B = state.goodsValue;
    const complete = state.lines.every(l=>{ const x = lines.find(y=>y.line.id===l.id); return l.returned + (x? x.qty : 0) >= l.qty; });
    const voucherLeft = Math.max(0, roundMoney(V - state.voucherRefunded));
    let voucherPart = complete? voucherLeft : (B>0? Math.min(voucherLeft, roundMoney(goods*V/B)) : 0);
    voucherPart = Math.max(0, Math.min(voucherPart, goods));
    return { lines, goods, voucherPart, tenderPart:roundMoney(goods - voucherPart), complete,
      costReversed: roundMoney(lines.filter(x=>x.condition==="restock").reduce((s,x)=>s+x.qty*x.line.cost,0)) };
  }
  // Shares `amount` over the sale's tenders by what's left to refund on each,
  // never more on a tender than it took. -> [{ payment, amount, full }]
  function allocateTender(state, amount){
    const pays = state.payments.map(p=>({ p, cap:roundMoney(p.amount - p.refunded) })).filter(x=>x.cap>0);
    if(!(amount>0)) return [];
    const capTotal = roundMoney(pays.reduce((s,x)=>s+x.cap,0));
    if(amount > capTotal + 0.001) throw new Error("This is more than is left to refund on receipt "+receiptDisplay(state.sale)+".");
    const shares = allocateCents(amount, pays.map(x=>x.cap));
    return pays.map((x,i)=>({ payment:x.p, amount:shares[i], full: Math.abs(shares[i]-x.cap)<0.001 })).filter(x=>x.amount>0);
  }
  // Where each part of the money goes. -> [{ method, amount, currency, rate, tendered, salePaymentId }]
  //   same:     each tender back on itself (foreign currency at the sale's rate);
  //   voucher:  all as store credit;  debtor: all off the debtor balance;
  //   exchange: o.applied towards the new sale, the difference the same way.
  // In every case the Credit tender's share lowers the debtor balance (no cash
  // or voucher for goods not paid for), down to zero, the rest as store
  // credit (owner Q8); the voucher-paid share is store credit (owner Q2).
  function planRefunds(state, calc, method, o){
    o = o||{};
    const out = [], sale = state.sale;
    const isCreditSale = state.payments.some(p=>p.method==="Credit") && !!sale.customer_id;
    if(method==="debtor" && !isCreditSale) throw new Error("This sale wasn't on credit, so the debtor balance can't be reduced.");
    const voucherRow = (amount, pid)=>({ method:"Voucher", amount, currency:BASE_CURRENCY_CODE, rate:1, tendered:amount, salePaymentId:pid||null });
    let tender = calc.tenderPart, voucherShare = calc.voucherPart;
    if(method==="exchange"){
      const applied = roundMoney(o.applied||0);
      if(applied>0) out.push({ method:"Exchange", amount:applied, currency:BASE_CURRENCY_CODE, rate:1, tendered:applied, salePaymentId:null });
      tender = roundMoney(o.tenderAmount||0); voucherShare = roundMoney(o.voucherAmount||0);
    }
    allocateTender(state, tender).forEach(a=>{
      const p = a.payment;
      if(p.method==="Credit" || method==="debtor"){ out.push({ method:"Debtor", amount:a.amount, currency:BASE_CURRENCY_CODE, rate:1, tendered:a.amount, salePaymentId:p.id }); return; }
      if(method==="voucher" || p.method==="Exchange"){ out.push(voucherRow(a.amount, p.id)); return; }   // an exchange credit comes back as store credit
      const code = p.currency || BASE_CURRENCY_CODE, foreign = code!==BASE_CURRENCY_CODE;
      const left = roundMoney((p.tendered_amount==null? p.amount : p.tendered_amount) - p.refundedTendered);
      out.push({ method:p.method, amount:a.amount, currency:code, rate:p.rate||1, salePaymentId:p.id,
        tendered: !foreign? a.amount : (a.full? left : roundMoney(a.amount*(p.rate||1))) });
    });
    // the debtor balance only goes down to zero; the rest is store credit
    let room = sale.customer_id? Math.max(0, roundMoney(customerBalance(sale.customer_id))) : 0;
    out.slice().forEach(r=>{
      if(r.method!=="Debtor") return;
      const keep = Math.min(r.amount, room); room = roundMoney(room - keep);
      const extra = roundMoney(r.amount - keep);
      if(extra>0){ r.amount = roundMoney(keep); r.tendered = r.amount; out.push(voucherRow(extra, r.salePaymentId)); }
    });
    if(voucherShare>0) out.push(voucherRow(voucherShare, null));
    return out.filter(r=>r.amount>0);
  }
  function refundSum(refunds, method){ return roundMoney(refunds.filter(r=>r.method===method).reduce((s,r)=>s+r.amount,0)); }

  // The whole credit note, checked, nothing written. Throws a plain message.
  // o: { reason, note, customerName, customerPhone, ref, now, applied, tenderAmount, voucherAmount }
  function planCreditNote(saleId, picks, method, o){
    o = o||{};
    const sale = one("SELECT * FROM sales WHERE id=?",[saleId]);
    const origin = returnOriginProblem(sale);
    if(origin) throw new Error(origin);
    const age = returnAgeProblem(sale, o.now);
    if(age) throw new Error(age);
    if(!RETURN_METHODS.includes(method)) throw new Error("Choose how the money goes back.");
    const state = saleReturnState(sale);
    const calc = computeReturn(state, picks);
    if(!RETURN_REASONS.includes(o.reason)) throw new Error("Choose the reason for the return.");
    const note = String(o.note||"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,120);
    if(o.reason==="Other" && !note) throw new Error("Write a short note for \"Other\".");
    // the exchange's own refunds are known only at checkout (exchangePlanForSale)
    const refunds = (method==="exchange" && o.applied==null)? [] : planRefunds(state, calc, method, o);
    const voucherTotal = refundSum(refunds, "Voucher");
    const customer = { name:String(o.customerName||"").trim(), phone:String(o.customerPhone||"").trim() };
    const needsCustomer = (voucherTotal>0 || method==="voucher") && !sale.customer_id;
    if(needsCustomer && (!customer.name || !customer.phone)) throw new Error("Store credit needs the customer's name and phone.");
    const ref = String(o.ref||"").trim().slice(0,60);
    const needsRef = refunds.some(r=>r.method==="EcoCash" || r.method==="Bank");
    if(needsRef && !ref) throw new Error("Enter the reference of the EcoCash/Bank refund.");
    return { sale, state, calc, method, refunds, reason:o.reason, note, customer, needsCustomer, ref, needsRef,
      voucherTotal, debtorTotal:refundSum(refunds, "Debtor"), picks:(picks||[]).map(p=>({ saleItemId:p.saleItemId, qty:Number(p.qty)||0, condition:p.condition })), opts:o };
  }

  // ---- saving: one transaction (owner: Admin passcode, open shift) ----
  // o: { passcode | admin (an exchange approved earlier), now, inTx, exchangeSaleId, startedBy }
  // -> { id, text, goods, refunds }. Any throw rolls everything back, the CN number included.
  function commitCreditNote(plan, o){
    o = o||{};
    returnRequireSignedIn();
    let admin = o.admin || null;
    if(!admin){
      if(!hasAdminPasscode()) throw new Error(NO_ADMIN_PASSCODE_MSG);
      admin = findAdmin(o.passcode);
      if(!admin) throw new Error("Incorrect Admin passcode. Nothing was saved.");
    }
    const now = o.now || new Date(), ts = now.toISOString();
    const block = shiftBlockReason(now);
    if(block) throw new Error(block);
    if(!o.inTx) run("BEGIN");
    try{
      // the rules again inside the transaction: the limits are never taken on trust
      const p = planCreditNote(plan.sale.id, plan.picks, plan.method, Object.assign({}, plan.opts, { now }));
      const branch = currentBranch(), shift = oldestOpenShift(branch);
      let customerId = p.sale.customer_id || null;
      if(!customerId && p.needsCustomer) customerId = findOrCreateCustomer(p.customer.name, p.customer.phone);
      const startedBy = o.startedBy || eodOperatorName();
      const cn = reserveDocNumber("CN");
      run(`INSERT INTO credit_notes(branch,cn_branch_id,cn_no,till_code,sale_id,sale_uid,sale_receipt,customer_id,ts,eod_session_id,reason,reason_note,
            started_by,started_staff_id,approved_by,approved_staff_id,goods_total,voucher_part,cost_reversed,exchange_sale_id,status)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted')`,
        [branch, getBranchId(), cn.n, cn.till||null, p.sale.id, p.sale.uid||null, receiptDisplay(p.sale), customerId, ts, shift? shift.id : null,
         p.reason, p.note, startedBy, o.startedStaffId!==undefined? o.startedStaffId : eodOperatorStaffId(), admin.name, admin.id||null,
         p.calc.goods, p.calc.voucherPart, p.calc.costReversed, o.exchangeSaleId||null]);
      const row = one("SELECT * FROM credit_notes WHERE cn_branch_id=? AND cn_no=?",[getBranchId(), cn.n]);
      p.calc.lines.forEach(x=>{
        run(`INSERT INTO credit_note_items(cn_id,sale_item_id,sale_item_uid,product_id,product_uid,product_code,name,qty,unit_refund,amount,unit_cost,condition)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [row.id, x.line.id, x.line.uid, x.line.productId, x.line.productUid, x.line.code, x.line.name, x.qty, x.unitRefund, x.amount, x.line.cost, x.condition]);
      });
      let voucherId = null;
      if(p.voucherTotal>0){
        run("INSERT INTO vouchers(customer_id,amount,branch,earned_ts,status,kind,source_cn_id,source_sale_id) VALUES(?,?,?,?,'Available','store_credit',?,?)",
          [customerId, p.voucherTotal, branch, ts, row.id, p.sale.id]);
        voucherId = one("SELECT last_insert_rowid() AS id").id;
      }
      p.refunds.forEach(r=>{
        run(`INSERT INTO credit_note_refunds(cn_id,method,amount,currency,rate,tendered_amount,sale_payment_id,voucher_id,exchange_sale_id,ref)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [row.id, r.method, r.amount, r.currency, r.rate, r.tendered, r.salePaymentId, r.method==="Voucher"? voucherId : null,
           r.method==="Exchange"? (o.exchangeSaleId||null) : null, (r.method==="EcoCash"||r.method==="Bank")? p.ref : ""]);
      });
      // stock: restock through moveStock (shared-stock till: queued for the
      // branch, sellable after sync); a write-off is in and straight out
      // again on this till only, so sellable stock never goes up.
      p.calc.lines.forEach(x=>{
        if(!x.line.productId) return;
        const m = { productId:x.line.productId, docType:"cn", docUid:row.uid||null, docNo:cn.text, ts };
        if(x.condition==="restock") moveStock(Object.assign({}, m, { delta:x.qty, kind:"return", note:"Returned (receipt "+receiptDisplay(p.sale)+")" }));
        else {
          moveStock(Object.assign({}, m, { delta:x.qty, kind:"return_damaged", ssLocal:true, note:"Returned damaged (receipt "+receiptDisplay(p.sale)+")" }));
          moveStock(Object.assign({}, m, { delta:-x.qty, kind:"return_writeoff", ssLocal:true, note:"Written off: "+p.reason }));
        }
      });
      const names = p.calc.lines.map(x=>x.line.name);
      const nR = p.calc.lines.filter(x=>x.condition==="restock").reduce((s,x)=>s+x.qty,0), nW = p.calc.lines.filter(x=>x.condition==="writeoff").reduce((s,x)=>s+x.qty,0);
      const how = [...new Set(p.refunds.map(r=>r.method))].join("+") || RETURN_METHOD_LABEL[p.method];
      logAudit("Credit note", names.length<=3? names.join(", ") : names[0]+" +"+(names.length-1)+" more",
        cn.text+" for receipt "+receiptDisplay(p.sale)+" · "+currency+p.calc.goods.toFixed(2)+" · "+how+" · "+nR+" restocked, "+nW+" written off"
        +" · reason: "+p.reason+(p.note? " ("+p.note+")" : "")+" · started by "+startedBy+", authorised by "+admin.name);
      if(!o.inTx) run("COMMIT");
      return { id:row.id, text:cn.text, goods:p.calc.goods, refunds:p.refunds };
    }catch(e){
      if(!o.inTx){ try{ run("ROLLBACK"); }catch(_){} }
      throw e;
    }
  }

  // ---- exchange (owner Q5): the credit goes into the cart, saved with the new sale ----
  let pendingExchange = null;
  function startExchange(saleId, picks, o){
    o = o||{};
    const plan = planCreditNote(saleId, picks, "exchange", o);
    returnRequireSignedIn();
    if(!hasAdminPasscode()) throw new Error(NO_ADMIN_PASSCODE_MSG);
    const admin = findAdmin(o.passcode);
    if(!admin) throw new Error("Incorrect Admin passcode. Nothing was saved.");
    const block = shiftBlockReason(o.now);
    if(block) throw new Error(block);
    pendingExchange = { saleId, picks:plan.picks, reason:plan.reason, note:plan.note, admin:{ id:admin.id, name:admin.name },
      startedBy:eodOperatorName(), startedStaffId:eodOperatorStaffId(), goods:plan.calc.goods, voucherPart:plan.calc.voucherPart,
      receipt:receiptDisplay(plan.sale) };
    return pendingExchange;
  }
  function exchangePending(){ return pendingExchange; }
  function cancelExchange(){ pendingExchange = null; }
  function exchangeApplied(total){ return pendingExchange? Math.max(0, Math.min(pendingExchange.goods, roundMoney(total))) : 0; }
  // Called by completeSale before anything is written. A cheaper exchange's
  // difference goes back the same way they paid; its voucher-paid share as
  // store credit. ref = the cart's payment reference (an EcoCash/Bank refund).
  function exchangePlanForSale(applied, ref){
    if(!pendingExchange) return null;
    const x = pendingExchange, diff = Math.max(0, roundMoney(x.goods - applied));
    const voucherAmount = (diff>0 && x.goods>0)? roundMoney(x.voucherPart*diff/x.goods) : 0;
    return planCreditNote(x.saleId, x.picks, "exchange", { reason:x.reason, note:x.note, applied, voucherAmount, tenderAmount:roundMoney(diff - voucherAmount), ref });
  }
  function commitExchangeCreditNote(plan, saleId, saleLabel, ts){
    const x = pendingExchange;
    const r = commitCreditNote(plan, { admin:x.admin, inTx:true, exchangeSaleId:saleId, now:new Date(ts), startedBy:x.startedBy, startedStaffId:x.startedStaffId });
    pendingExchange = null;
    return r;
  }
  function exchangeCartHtml(){
    if(!pendingExchange) return "";
    const x = pendingExchange, t = cartTotals();
    const back = roundMoney(x.goods - t.exchange);
    return `<div class="box exchange-box" style="margin:6px 0 8px;padding:8px 10px;border:1px solid var(--orange,#e8590c);border-radius:8px;background:#fff8f0">
      <div class="subline" style="font-weight:700"><span>Exchange credit (receipt ${escapeHtml(x.receipt)})</span><span>−${currency}${t.exchange.toFixed(2)}</span></div>
      <div class="muted" style="font-size:12px">${cart.length===0? "Add the new items to the cart." : back>0? currency+back.toFixed(2)+" goes back the same way they paid." : t.due>0? "The customer pays the rest below." : "The credit covers the new items."}</div>
      <button type="button" class="btn btn-ghost btn-sm" id="cancelExchangeBtn" style="margin-top:6px">Cancel exchange</button>
    </div>`;
  }
  function wireExchangeCart(scope, refresh){
    const b = scope.querySelector("#cancelExchangeBtn");
    if(b) b.onclick = ()=>{ if(confirm("Cancel this exchange? Nothing has been saved.")){ cancelExchange(); refresh(); } };
    const done = scope.querySelector("#payExchange");
    if(done) done.onclick = ()=>{ completeSale("Exchange"); };
  }

  // ---- reading credit notes (reports, EOD, slips) ----
  function creditNoteFull(cnId){
    const cn = one("SELECT * FROM credit_notes WHERE id=?",[cnId]);
    if(!cn) return null;
    return { cn, items:all("SELECT * FROM credit_note_items WHERE cn_id=? ORDER BY id",[cnId]), refunds:all("SELECT * FROM credit_note_refunds WHERE cn_id=? ORDER BY id",[cnId]),
      customer: cn.customer_id? one("SELECT * FROM customers WHERE id=?",[cn.customer_id]) : null,
      exchangeSale: cn.exchange_sale_id? one("SELECT * FROM sales WHERE id=?",[cn.exchange_sale_id]) : null, text:cnDisplay(cn) };
  }
  function creditNotesIn(branch, fromTs, toTs){
    return branch? all("SELECT * FROM credit_notes WHERE branch=? AND ts>=? AND ts<=? ORDER BY ts",[branch,fromTs,toTs])
                 : all("SELECT * FROM credit_notes WHERE ts>=? AND ts<=? ORDER BY ts",[fromTs,toTs]);
  }
  function refundsFor(cns){
    if(!cns.length) return [];
    return all(`SELECT * FROM credit_note_refunds WHERE cn_id IN (${cns.map(()=>"?").join(",")})`, cns.map(c=>c.id));
  }
  // Refunds in the payment-method terms of the Sales Report: Debtor is
  // money off Credit; a store-credit voucher is its own row.
  const REFUND_AS_METHOD = { Debtor:"Credit", Voucher:"Store credit" };
  function refundMethodTotals(branch, fromTs, toTs){
    const m = {};
    refundsFor(creditNotesIn(branch, fromTs, toTs)).forEach(r=>{ const k = REFUND_AS_METHOD[r.method]||r.method; m[k] = roundMoney((m[k]||0) + r.amount); });
    return m;
  }
  function refundCurrencyTotals(branch, fromTs, toTs){
    const m = {};
    refundsFor(creditNotesIn(branch, fromTs, toTs)).forEach(r=>{
      if(REFUND_AS_METHOD[r.method] || r.method==="Exchange") return;
      const k = r.method+"|"+(r.currency||BASE_CURRENCY_CODE);
      if(!m[k]) m[k] = { total:0, tendered:0 };
      m[k].total = roundMoney(m[k].total + r.amount);
      m[k].tendered = roundMoney(m[k].tendered + (r.tendered_amount==null? r.amount : r.tendered_amount));
    });
    return m;
  }
  // name -> { qty, amount, restockCost } for the Margin report
  function returnsByItem(branch, fromTs, toTs){
    const cns = creditNotesIn(branch, fromTs, toTs), m = {};
    if(!cns.length) return m;
    all(`SELECT * FROM credit_note_items WHERE cn_id IN (${cns.map(()=>"?").join(",")})`, cns.map(c=>c.id)).forEach(i=>{
      if(!m[i.name]) m[i.name] = { qty:0, amount:0, restockCost:0 };
      m[i.name].qty += i.qty; m[i.name].amount = roundMoney(m[i.name].amount + i.amount);
      if(i.condition==="restock") m[i.name].restockCost = roundMoney(m[i.name].restockCost + i.qty*(i.unit_cost||0));
    });
    return m;
  }
  function creditNoteMethodsText(refunds){
    const by = {};
    refunds.forEach(r=>{ const k = r.method; by[k] = roundMoney((by[k]||0) + r.amount); });
    return Object.keys(by).map(k=>(REFUND_LABEL[k]||k).replace(" refunded","")+" "+currency+by[k].toFixed(2)).join(", ");
  }

  // ---- the slip: 58/80mm (ESC/POS or the print dialog), PDF, WhatsApp ----
  function creditNoteLines(cnId, w){
    const f = creditNoteFull(cnId);
    if(!f) return null;
    const { cn, items, refunds } = f;
    const head = [new Date(cn.ts).toLocaleString(), "CREDIT NOTE "+f.text, "Original receipt "+cn.sale_receipt];
    if(f.customer) head.push("Customer: "+f.customer.name);
    const itemLines = [];
    items.forEach(i=>{ itemLines.push(padLine(i.qty+" x "+i.name, "-"+currency+i.amount.toFixed(2), w)); itemLines.push("  ("+CONDITION_LABEL[i.condition]+")"); });
    const totalLines = [padLine("TOTAL CREDIT", currency+cn.goods_total.toFixed(2), w)];
    const by = {};
    refunds.forEach(r=>{
      const k = r.method+"|"+(r.currency||BASE_CURRENCY_CODE);
      if(!by[k]) by[k] = { r, amount:0, tendered:0 };
      by[k].amount = roundMoney(by[k].amount + r.amount);
      by[k].tendered = roundMoney(by[k].tendered + (r.tendered_amount==null? r.amount : r.tendered_amount));
    });
    Object.values(by).forEach(({ r, amount, tendered })=>{
      const code = r.currency||BASE_CURRENCY_CODE;
      let label = REFUND_LABEL[r.method]||r.method;
      if(r.method==="Exchange" && f.exchangeSale) label += " (receipt "+receiptDisplay(f.exchangeSale)+")";
      const value = code!==BASE_CURRENCY_CODE? currencySymbolFor(code)+tendered.toFixed(2)+" (= "+currency+amount.toFixed(2)+")" : currency+amount.toFixed(2);
      totalLines.push(padLine(label+(code!==BASE_CURRENCY_CODE? " "+code : ""), value, w));
      if((r.method==="EcoCash"||r.method==="Bank") && r.ref) totalLines.push("  Ref: "+r.ref);
    });
    const foot = ["Reason: "+cn.reason+(cn.reason_note? " - "+cn.reason_note : ""), "Started by "+(cn.started_by||"-"), "Authorised by "+(cn.approved_by||"-")];
    if(refunds.some(r=>r.method==="Voucher")) foot.push("Store credit: use it at this till.");
    return { title:"Credit note "+f.text, head, itemLines, totalLines, foot, f };
  }
  function buildCreditNoteBytes(cnId){
    const w = escposColWidth(), L = creditNoteLines(cnId, w);
    const shop = getSetting("shop_name","My Shop"), branch = getSetting("branch_name","");
    const parts = [ escposInit(), escposFontB(), escposNormalSize(), escposAlign("center"), escposBold(true), escposTextBytes(shop+"\n"), escposBold(false) ];
    if(branch) parts.push(escposTextBytes(branch+"\n"));
    parts.push(escposAlign("left"), escposLine(w));
    L.head.forEach((t,i)=>{ if(i===1) parts.push(escposBold(true)); parts.push(escposTextBytes(t+"\n")); if(i===1) parts.push(escposBold(false)); });
    parts.push(escposLine(w));
    L.itemLines.forEach(t=>parts.push(escposTextBytes(t+"\n")));
    parts.push(escposLine(w));
    L.totalLines.forEach((t,i)=>{ if(i===0) parts.push(escposBold(true)); parts.push(escposTextBytes(t+"\n")); if(i===0) parts.push(escposBold(false)); });
    parts.push(escposLine(w));
    L.foot.forEach(t=>parts.push(escposTextBytes(t+"\n")));
    parts.push(escposCut());
    return concatBytes(parts);
  }
  function creditNoteHtml(cnId, a4){
    const L = creditNoteLines(cnId, 40);
    const shop = getSetting("shop_name","My Shop"), branch = getSetting("branch_name","");
    const line = (t)=>{ const m = /^(.*?)\s{2,}(\S.*)$/.exec(t); return m? `<div class="line"><span>${escapeHtml(m[1])}</span><span>${escapeHtml(m[2])}</span></div>` : `<div>${escapeHtml(t)}</div>`; };
    return `<div class="${a4? "report-print" : "receipt"} cn-slip">
      <h3>${escapeHtml(shop)}</h3>${branch? `<div style="text-align:center">${escapeHtml(branch)}</div>` : ""}<hr>
      ${L.head.map((t,i)=> i===1? `<div><b>${escapeHtml(t)}</b></div>` : `<div>${escapeHtml(t)}</div>`).join("")}<hr>
      ${L.itemLines.map(line).join("")}<hr>
      ${L.totalLines.map((t,i)=> i===0? `<div class="line"><b>${escapeHtml(t.replace(/\s{2,}\S.*$/,""))}</b><b>${escapeHtml(t.replace(/^.*?\s{2,}/,""))}</b></div>` : line(t)).join("")}<hr>
      ${L.foot.map(t=>`<div>${escapeHtml(t)}</div>`).join("")}
    </div>`;
  }
  async function printCreditNote(cnId){
    const L = creditNoteLines(cnId, escposColWidth());
    if(!L) return;
    if(await sendDirect(buildCreditNoteBytes(cnId), L.title)) return;
    document.getElementById("printArea").innerHTML = creditNoteHtml(cnId, false);
    printNow(paperWidth());
  }
  function printCreditNotePdf(cnId){
    document.getElementById("printArea").innerHTML = creditNoteHtml(cnId, true);
    printNow(null);
  }
  function creditNoteWhatsAppText(cnId){
    const L = creditNoteLines(cnId);
    return receiptText(getSetting("shop_name","")+" — "+L.title, L.head.slice(0,1).concat(L.head.slice(2), [""], L.itemLines), L.totalLines.concat([""], L.foot));
  }

  // ---- screens ----
  // Reports → Returns card, and Sale Detail's "Return / Credit note".
  function returnsCardHtml(){
    return `<div class="card" data-report-name="Returns Credit note Refund Exchange">
      <h3>Returns</h3>
      <p class="muted">Return items from a receipt made on this till. An Admin approves it with the passcode.</p>
      <div class="row"><input class="field" id="rtFindInput" placeholder="Receipt number, e.g. T1-0045 or #45" autocomplete="off">
        <button class="btn btn-primary" id="rtFindBtn" style="flex:none;width:auto">Find receipt</button></div>
      <div id="rtFindMsg" class="rt-msg" style="color:var(--danger,#b42318);font-weight:600;margin-top:6px"></div>
    </div>`;
  }
  function wireReturnsCard(){
    const btn = document.getElementById("rtFindBtn");
    if(!btn) return;
    const go = ()=>{
      const r = findReturnSale(document.getElementById("rtFindInput").value);
      const msg = document.getElementById("rtFindMsg");
      if(r.error){ msg.textContent = r.error; return; }
      msg.textContent = "";
      openReturnFlow(r.sale.id);
    };
    btn.onclick = go;
    document.getElementById("rtFindInput").onkeydown = (e)=>{ if(e.key==="Enter") go(); };
  }
  function saleDetailReturnHtml(sale){
    const cns = all("SELECT * FROM credit_notes WHERE sale_id=? ORDER BY id",[sale.id]);
    const list = cns.length? `<div class="muted" style="margin-top:8px">Returned on: ${cns.map(c=>`<a href="#" data-open-cn="${c.id}">${escapeHtml(cnDisplay(c))}</a>`).join(", ")}</div>` : "";
    const can = !returnOriginProblem(sale) && !returnAgeProblem(sale) && saleReturnState(sale).lines.some(l=>l.returnable>0);
    return list + (can? `<button class="btn btn-primary" id="saleReturnBtn" style="margin-top:8px">↩ Return / Credit note</button>` : "");
  }
  function wireSaleDetailReturn(wrap, sale){
    const b = wrap.querySelector("#saleReturnBtn");
    if(b) b.onclick = ()=>{ wrap.remove(); openReturnFlow(sale.id); };
    wrap.querySelectorAll("[data-open-cn]").forEach(a=>a.onclick = (e)=>{ e.preventDefault(); openCreditNoteModal(+a.dataset.openCn); });
  }
  function openCreditNoteModal(cnId){
    const f = creditNoteFull(cnId);
    if(!f) return;
    const wrap = openModal("Credit note "+f.text, `${creditNoteHtml(cnId, false)}
      <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
        <button class="btn btn-outline" id="cnPrint">🖨️ Print slip</button><button class="btn btn-outline" id="cnPdf">📄 PDF</button><button class="btn btn-ghost" id="cnWa">📲 WhatsApp</button>
      </div>`);
    wrap.querySelector("#cnPrint").onclick = ()=>printCreditNote(cnId);
    wrap.querySelector("#cnPdf").onclick = ()=>printCreditNotePdf(cnId);
    wrap.querySelector("#cnWa").onclick = ()=>shareWhatsApp(creditNoteWhatsAppText(cnId), f.customer && f.customer.phone);
    return wrap;
  }

  // The return, step by step: items → refund → approve → done.
  function openReturnFlow(saleId){
    try{ returnRequireSignedIn(); }catch(e){ alert(e.message); return; }
    const sale = one("SELECT * FROM sales WHERE id=?",[saleId]);
    const bad = returnOriginProblem(sale) || returnAgeProblem(sale);
    if(bad){ alert(bad); return; }
    const S = { step:"items", sale, picks:new Map(), method:"same", customerName:"", customerPhone:"", ref:"", reason:"", note:"", done:null };
    saleReturnState(sale).lines.forEach(l=>S.picks.set(l.id, { qty:0, condition: l.canRestock? "restock" : "writeoff" }));
    const wrap = openModal("Return · receipt "+receiptDisplay(sale), "");
    wrap.classList.add("return-flow");
    const body = wrap.querySelector(".modal-body");
    const $ = (s)=>body.querySelector(s);
    const picksArr = ()=>[...S.picks.entries()].map(([id,p])=>({ saleItemId:id, qty:p.qty, condition:p.condition }));
    const opts = ()=>({ reason:S.reason, note:S.note, customerName:S.customerName, customerPhone:S.customerPhone, ref:S.ref });
    // the preview: the money only, before the reason, customer or reference are typed
    const tryPlan = (method)=>{ try{ return { plan:planCreditNote(sale.id, picksArr(), method||S.method, Object.assign(opts(),
      { reason:"Wrong item", note:"", customerName:S.customerName||"-", customerPhone:S.customerPhone||"-", ref:S.ref||"-" })) }; }catch(e){ return { error:e.message||String(e) }; } };
    const steps = ["items","refund","approve","done"];
    const stepper = ()=>`<div class="rt-steps">${["Items","Refund","Approve","Done"].map((t,i)=>`<span class="${steps.indexOf(S.step)>=i? "on" : ""}">${i+1}. ${t}</span>`).join("")}</div>`;
    const saleHead = ()=>`<div class="muted" style="margin-bottom:8px">${escapeHtml(new Date(sale.ts).toLocaleString())} · ${currency}${sale.total.toFixed(2)} · ${escapeHtml(sale.method)}${sale.customer_id? " · "+escapeHtml((one("SELECT name FROM customers WHERE id=?",[sale.customer_id])||{}).name||"") : ""}</div>`;
    function draw(){
      const state = saleReturnState(sale);
      if(S.step==="items"){
        let calcErr = "", calc = null;
        try{ calc = computeReturn(state, picksArr()); }catch(e){ calcErr = e.message; }
        body.innerHTML = stepper() + saleHead() + state.lines.map(l=>{
          const p = S.picks.get(l.id), each = l.qty? roundMoney(l.value/l.qty) : 0;
          return `<div class="rt-line card" style="padding:8px 10px;margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;gap:8px"><b>${escapeHtml(l.name)}</b><span class="muted">${currency}${each.toFixed(2)} each paid</span></div>
            <div class="muted" style="font-size:12px">Sold ${l.qty} · returned ${l.returned} · can return ${l.returnable}</div>
            ${l.returnable>0? `<div class="row" style="margin-top:6px;align-items:center;gap:8px;flex-wrap:wrap">
              <div class="qty-ctl" style="flex:none"><button type="button" data-rt-dec="${l.id}">−</button><span data-rt-qty="${l.id}">${p.qty}</span><button type="button" data-rt-inc="${l.id}">+</button></div>
              <select class="field" data-rt-cond="${l.id}" style="flex:1;min-width:180px" ${l.canRestock? "" : "disabled"}>
                <option value="restock" ${p.condition==="restock"?"selected":""}>Good — back to stock</option>
                <option value="writeoff" ${p.condition==="writeoff"?"selected":""}>Damaged or faulty — write off</option>
              </select></div>
              ${l.canRestock? "" : `<div class="muted" style="font-size:12px">No longer a product here: the money is refunded, the item is written off.</div>`}` : `<div class="pill" style="margin-top:4px">Returned in full</div>`}
          </div>`;
        }).join("") + `<div class="total-line"><span>Refund</span><span id="rtTotal">${currency}${(calc? calc.goods : 0).toFixed(2)}</span></div>
          <div class="rt-msg" style="color:var(--danger,#b42318);min-height:18px">${calc || picksArr().every(p=>!p.qty)? "" : escapeHtml(calcErr)}</div>
          <button class="btn btn-primary" id="rtNext" ${calc? "" : "disabled"}>Next: refund</button>`;
        body.querySelectorAll("[data-rt-inc]").forEach(b=>b.onclick=()=>{ const l = state.lines.find(x=>x.id===+b.dataset.rtInc), p = S.picks.get(l.id); if(p.qty<l.returnable){ p.qty++; draw(); } });
        body.querySelectorAll("[data-rt-dec]").forEach(b=>b.onclick=()=>{ const p = S.picks.get(+b.dataset.rtDec); if(p.qty>0){ p.qty--; draw(); } });
        body.querySelectorAll("[data-rt-cond]").forEach(s=>s.onchange=()=>{ S.picks.get(+s.dataset.rtCond).condition = s.value; draw(); });
        $("#rtNext").onclick = ()=>{ S.step = "refund"; draw(); };
        return;
      }
      if(S.step==="refund"){
        const isCredit = state.payments.some(p=>p.method==="Credit") && !!sale.customer_id;
        const methods = RETURN_METHODS.map(m=>{
          const off = m==="debtor" && !isCredit? "Only for a sale on credit." : "";
          const hint = { same:"Each payment back on itself: cash, EcoCash, Bank, in the currency and at the rate of the sale. The credit part lowers what they owe.",
            voucher:"The whole refund as a store credit voucher for the customer.", debtor:"The refund comes off what the customer owes, down to zero; the rest as store credit.",
            exchange:"The credit goes into the cart; the customer takes new items and pays any difference." }[m];
          return `<label class="rt-method ${off? "off" : ""}" style="display:block;padding:8px 10px;border:1px solid var(--line,#ddd);border-radius:8px;margin-bottom:6px;${off? "opacity:.55" : ""}">
            <input type="radio" name="rtMethod" value="${m}" ${S.method===m?"checked":""} ${off?"disabled":""}> <b>${RETURN_METHOD_LABEL[m]}</b>
            <div class="muted" style="font-size:12px">${escapeHtml(off||hint)}</div></label>`;
        }).join("");
        const pv = tryPlan();
        const plan = pv.plan;
        const preview = !plan? "" : S.method==="exchange"? `<p class="muted" style="margin:4px 0">Credit of <b>${currency}${plan.calc.goods.toFixed(2)}</b> goes towards the new items. If they cost less, the difference goes back the same way they paid.</p>`
          : plan.refunds.map(r=>`<div class="subline"><span>${escapeHtml(REFUND_LABEL[r.method]||r.method)}${r.currency&&r.currency!==BASE_CURRENCY_CODE? " ("+escapeHtml(r.currency)+")" : ""}</span><span>${r.currency&&r.currency!==BASE_CURRENCY_CODE? escapeHtml(currencySymbolFor(r.currency))+r.tendered.toFixed(2)+" ≈ " : ""}${currency}${r.amount.toFixed(2)}</span></div>`).join("");
        const needCust = plan && !sale.customer_id && (S.method==="voucher" || plan.refunds.some(r=>r.method==="Voucher"));
        const needRef = plan && plan.refunds.some(r=>r.method==="EcoCash"||r.method==="Bank");
        body.innerHTML = stepper() + saleHead() + methods + `<div class="card" style="padding:8px 10px;margin:8px 0">${preview || `<span class="muted">${escapeHtml(pv.error||"")}</span>`}</div>
          ${needCust? `<label>Customer name (for the store credit)</label><input class="field" id="rtCust" value="${escapeHtml(S.customerName)}" placeholder="e.g. Tendai Moyo">
            <label>Customer phone</label><input class="field" id="rtPhone" value="${escapeHtml(S.customerPhone)}" placeholder="e.g. 077xxxxxxx">` : ""}
          ${needRef? `<label>Reference of the EcoCash/Bank refund</label><input class="field" id="rtRef" value="${escapeHtml(S.ref)}" placeholder="Transaction reference">` : ""}
          <label>Reason</label><select class="field" id="rtReason"><option value="">Choose…</option>${RETURN_REASONS.map(r=>`<option ${S.reason===r?"selected":""}>${escapeHtml(r)}</option>`).join("")}</select>
          <label>Note ${S.reason==="Other"? "(required)" : "(optional)"}</label><input class="field" id="rtNote" maxlength="120" value="${escapeHtml(S.note)}">
          <div class="rt-msg" id="rtErr" style="color:var(--danger,#b42318);min-height:18px;margin-top:6px"></div>
          <div class="row" style="gap:8px"><button class="btn btn-outline" id="rtBack">Back</button><button class="btn btn-primary" id="rtNext">Next: approve</button></div>`;
        body.querySelectorAll("[name=rtMethod]").forEach(r=>r.onchange=()=>{ S.method = r.value; draw(); });
        const keep = ()=>{ const v = (s)=>{ const el = $(s); return el? el.value : null; };
          if(v("#rtCust")!==null) S.customerName = v("#rtCust"); if(v("#rtPhone")!==null) S.customerPhone = v("#rtPhone");
          if(v("#rtRef")!==null) S.ref = v("#rtRef"); S.reason = v("#rtReason"); S.note = v("#rtNote"); };
        $("#rtReason").onchange = ()=>{ keep(); draw(); };
        $("#rtBack").onclick = ()=>{ keep(); S.step = "items"; draw(); };
        $("#rtNext").onclick = ()=>{
          keep();
          try{ planCreditNote(sale.id, picksArr(), S.method, opts()); S.step = "approve"; draw(); }
          catch(e){ $("#rtErr").textContent = e.message||String(e); }
        };
        return;
      }
      if(S.step==="approve"){
        const plan = planCreditNote(sale.id, picksArr(), S.method, opts());
        const stock = plan.calc.lines.map(x=>`<div class="subline"><span>${x.qty} x ${escapeHtml(x.line.name)} <span class="muted">(${CONDITION_LABEL[x.condition]})</span></span><span>−${currency}${x.amount.toFixed(2)}</span></div>`).join("");
        const money = S.method==="exchange"? `<div class="subline"><span>Exchange credit</span><span>${currency}${plan.calc.goods.toFixed(2)}</span></div>`
          : plan.refunds.map(r=>`<div class="subline"><span>${escapeHtml(REFUND_LABEL[r.method]||r.method)}${r.currency&&r.currency!==BASE_CURRENCY_CODE? " ("+escapeHtml(r.currency)+")" : ""}</span><span>${r.currency&&r.currency!==BASE_CURRENCY_CODE? escapeHtml(currencySymbolFor(r.currency))+r.tendered.toFixed(2)+" ≈ " : ""}${currency}${r.amount.toFixed(2)}</span></div>`).join("");
        const shared = typeof sharedStockTill==="function" && sharedStockTill() && plan.calc.lines.some(x=>x.condition==="restock");
        body.innerHTML = stepper() + saleHead() + `<div class="card" style="padding:8px 10px">${stock}<div class="hr" style="margin:6px 0"></div>${money}
            <div class="total-line"><span>Total credit</span><span>${currency}${plan.calc.goods.toFixed(2)}</span></div>
            <div class="muted" style="font-size:12px;margin-top:4px">Reason: ${escapeHtml(plan.reason)}${plan.note? " — "+escapeHtml(plan.note) : ""} · started by ${escapeHtml(eodOperatorName()||"—")}</div>
            ${shared? `<div class="muted" style="font-size:12px">Goods back to stock go to the branch's shared stock: sellable once it syncs.</div>` : ""}</div>
          <label>Admin passcode</label><input class="field" id="rtPass" type="password" inputmode="numeric" autocomplete="off" placeholder="An Admin approves every return">
          <div class="rt-msg" id="rtErr" style="color:var(--danger,#b42318);min-height:18px;margin-top:6px"></div>
          <div class="row" style="gap:8px"><button class="btn btn-outline" id="rtBack">Back</button>
            <button class="btn btn-primary" id="rtSave">${S.method==="exchange"? "Approve and go to cart" : "Save credit note"}</button></div>`;
        $("#rtBack").onclick = ()=>{ S.step = "refund"; draw(); };
        let busy = false;
        $("#rtSave").onclick = async ()=>{
          if(busy) return; busy = true;
          try{
            if(S.method==="exchange"){
              startExchange(sale.id, picksArr(), Object.assign(opts(), { passcode:$("#rtPass").value }));
              wrap.remove(); route = "pos"; drawerOpen = !isDesktopBuild(); render(); return;   // the desktop cart is always on screen
            }
            S.done = commitCreditNote(plan, { passcode:$("#rtPass").value });
          }catch(e){ $("#rtErr").textContent = e.message||String(e); busy = false; return; }
          try{ await persist(); }catch(e){}
          if(typeof sharedStockTill==="function" && sharedStockTill() && typeof isOnline==="function" && isOnline()) stockSyncNow({}).then(()=>render()).catch(()=>{});
          S.step = "done"; draw();
        };
        return;
      }
      // done
      const f = creditNoteFull(S.done.id);
      body.innerHTML = stepper() + `<p style="font-weight:700;margin:4px 0 8px">Credit note ${escapeHtml(f.text)} saved.</p>
        <div class="muted" style="margin-bottom:8px">${escapeHtml(creditNoteMethodsText(f.refunds))}</div>
        ${creditNoteHtml(S.done.id, false)}
        <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
          <button class="btn btn-primary" id="cnPrint">🖨️ Print slip</button><button class="btn btn-outline" id="cnPdf">📄 PDF</button>
          <button class="btn btn-ghost" id="cnWa">📲 WhatsApp</button><button class="btn btn-outline" id="rtClose">Done</button></div>`;
      $("#cnPrint").onclick = ()=>printCreditNote(S.done.id);
      $("#cnPdf").onclick = ()=>printCreditNotePdf(S.done.id);
      $("#cnWa").onclick = ()=>shareWhatsApp(creditNoteWhatsAppText(S.done.id), f.customer && f.customer.phone);
      $("#rtClose").onclick = ()=>{ wrap.remove(); render(); };
    }
    draw();
    return wrap;
  }

  // ---- reports (owner: Sales gross/returns/net, payment methods, profit,
  // Sales Trend net of returns, a Returns report, the Item Ledger). With no
  // returns in the range every report reads exactly as before.
  // Sales Report rows for the credit notes in a range, in the given columns.
  function salesReportReturnRows(branch, fromTs, toTs){
    return creditNotesIn(branch, fromTs, toTs).map(c=>({ cn:c, text:cnDisplay(c), ts:c.ts, branch:c.branch, amount:-(c.goods_total||0),
      label:"Return "+cnDisplay(c)+" (receipt "+c.sale_receipt+")" }));
  }
  function salesReturnsFooter(gross, returnRows){
    const ret = roundMoney(returnRows.reduce((s,r)=>s-r.amount,0));
    return `Gross sales: ${currency}${gross.toFixed(2)} · Returns: -${currency}${ret.toFixed(2)} · Net sales: ${currency}${roundMoney(gross-ret).toFixed(2)}`;
  }
  // paymentMethodTotals rows -> with Refunds and Net (store credit issued is its own row)
  function paymentBreakdownWithRefunds(rows, branch, fromTs, toTs){
    const ref = refundMethodTotals(branch, fromTs, toTs);
    const out = rows.map(r=>({ method:r.method, total:r.total, refunds:ref[r.method]||0 }));
    Object.keys(ref).forEach(m=>{ if(!out.some(r=>r.method===m)) out.push({ method:m, total:0, refunds:ref[m] }); });
    return out.map(r=>Object.assign(r, { net:roundMoney(r.total - r.refunds) }));
  }
  // Margin: revenue less what was refunded; cost less RESTOCKED lines only (a write-off stays a cost).
  function applyReturnsToMargin(byName, branch, fromTs, toTs){
    const ret = returnsByItem(branch, fromTs, toTs);
    Object.keys(ret).forEach(n=>{
      if(!byName[n]) byName[n] = { qty:0, revenue:0, cost:0 };
      byName[n].qty -= ret[n].qty; byName[n].revenue -= ret[n].amount; byName[n].cost -= ret[n].restockCost;
    });
    return byName;
  }

  // Returns report (Report Writer): every credit note in the range.
  const RETURN_REFUND_FILTER = [["","All methods"],["Cash","Cash"],["EcoCash","EcoCash"],["Bank","Bank"],["Debtor","Debtor balance"],["Voucher","Store credit"],["Exchange","Exchange"]];
  function returnsReportData(branch, fromTs, toTs, f){
    f = f||{};
    const rows = [], totals = {}, cond = { restock:0, writeoff:0 };
    let sum = 0;
    creditNotesIn(branch, fromTs, toTs).forEach(c=>{
      const full = creditNoteFull(c.id);
      if(f.reason && c.reason!==f.reason) return;
      if(f.method && !full.refunds.some(r=>r.method===f.method)) return;
      if(f.condition && !full.items.some(i=>i.condition===f.condition)) return;
      sum = roundMoney(sum + c.goods_total);
      full.refunds.forEach(r=>{ totals[r.method] = roundMoney((totals[r.method]||0) + r.amount); });
      full.items.forEach(i=>{ cond[i.condition] = (cond[i.condition]||0) + i.qty; });
      rows.push({ c, full });
    });
    return { rows, total:sum, totals, cond };
  }
  function returnsReportTable(branch, fromTs, toTs, f){
    const d = returnsReportData(branch, fromTs, toTs, f);
    const rows = d.rows.map(({ c, full })=>[
      `<button type="button" class="btn btn-outline btn-sm" data-view-cn="${c.id}" style="padding:4px 10px;font-size:12px">${escapeHtml(full.text)}</button>`,
      escapeHtml(new Date(c.ts).toLocaleString()), escapeHtml(c.till_code||"—"), escapeHtml(c.sale_receipt), escapeHtml(full.customer? full.customer.name : ""),
      full.items.map(i=>escapeHtml(i.qty+" x "+i.name)+` <span class="muted">(${CONDITION_LABEL[i.condition]})</span>`).join("<br>"),
      currency+c.goods_total.toFixed(2), escapeHtml(creditNoteMethodsText(full.refunds)), escapeHtml(c.reason+(c.reason_note? " — "+c.reason_note : "")),
      escapeHtml((c.started_by||"")+" / "+(c.approved_by||""))]);
    const byMethod = Object.keys(d.totals).map(m=>(REFUND_LABEL[m]||m).replace(" refunded","")+" "+currency+d.totals[m].toFixed(2)).join(" · ");
    return { headers:["Credit note","Date/Time","Till","Receipt","Customer","Items","Amount","Refund","Reason","Started / Approved"], rows,
      footer:`${d.rows.length} credit note${d.rows.length===1?"":"s"} · ${currency}${d.total.toFixed(2)}${byMethod? " · "+byMethod : ""} · ${d.cond.restock||0} unit(s) back to stock, ${d.cond.writeoff||0} written off` };
  }

  // Item Ledger (owner Q12): one product, every stock movement, running balance. Read-only.
  const LEDGER_KIND_LABEL = { opening:"Opening balance", product_created:"Product created", sale:"Sale", return:"Return (back to stock)",
    return_damaged:"Return (damaged)", return_writeoff:"Written off (damaged return)", adjustment:"Adjustment", receive:"Received",
    dispatch:"Dispatched", stocktake:"Stocktake", import:"Import", purchase:"Purchase", restock:"Restock", allowance:"Till allowance (shared stock)",
    shared_opening:"Handed to branch (shared stock)", merge_out:"Added to branch (shared stock)", other:"Other" };
  function itemLedgerData(productId, fromTs, toTs){
    const p = one("SELECT * FROM products WHERE id=?",[productId]);
    if(!p) return null;
    const opening = one("SELECT COALESCE(SUM(qty_delta),0) AS s FROM stock_movements WHERE product_id=? AND ts<?",[productId, fromTs]).s;
    let bal = opening, inQ = 0, outQ = 0;
    const rows = all("SELECT * FROM stock_movements WHERE product_id=? AND ts>=? AND ts<=? ORDER BY ts, id",[productId, fromTs, toTs]).map(m=>{
      bal += m.qty_delta; if(m.qty_delta>0) inQ += m.qty_delta; else outQ -= m.qty_delta;
      return Object.assign({}, m, { balance:bal });
    });
    return { product:p, opening, rows, closing:bal, inQ, outQ };
  }
  function itemLedgerTable(branch, fromTs, toTs, f){
    const pid = Number((f||{}).product)||0;
    if(!pid) return { headers:["Date/Time","Movement","Document","Change","Balance","By","Note"], rows:[], footer:"Choose a product." };
    const d = itemLedgerData(pid, fromTs, toTs);
    if(!d) return { headers:[], rows:[], footer:"That product no longer exists." };
    const rows = d.rows.map(m=>[escapeHtml(new Date(m.ts).toLocaleString()), escapeHtml(LEDGER_KIND_LABEL[m.kind]||m.kind), escapeHtml(m.doc_no||""),
      (m.qty_delta>0?"+":"")+m.qty_delta, String(m.balance), escapeHtml(m.user||""), escapeHtml(m.note||"")]);
    return { headers:["Date/Time","Movement","Document","Change","Balance","By","Note"], rows,
      footer:`${d.product.sku? d.product.sku+" " : ""}${d.product.name} · opening ${d.opening} · in +${d.inQ} · out -${d.outQ} · closing ${d.closing}` };
  }
  function itemLedgerProductOptions(branch){
    const b = branch || currentBranch();
    return [["","Choose a product…"]].concat(all("SELECT id, sku, name FROM products WHERE branch=? ORDER BY name",[b]).map(p=>[String(p.id), (p.sku? p.sku+" · " : "")+p.name]));
  }
