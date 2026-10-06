  // ---------------- Dispatch documents: numbering + file naming (Phase 1) ----------------
  // DN = Delivery Note (numbered per DISPATCHING branch), GRV = Goods Received
  // Voucher (numbered per RECEIVING branch). Two branches will both produce
  // DN0001, so a dispatch is identified by (dispatching branch_id + DN number),
  // never by the number alone. branch_id is a stable id stored in settings, so
  // renaming a branch in Settings can't make an old DN look new.
  //
  // The first block below is pure (no DB, no DOM, no dependencies) so
  // test/docnum.test.js can load and exercise it under plain Node.

  // DN files are self-contained JSON (see dnfile.js). GRV files (Phase 3) share it.
  const DOC_FILE_EXT = ".json";
  const DOC_TYPES = ["DN","GRV","ADJ","CXL","EXP","LOG","ITM","MKT","RCT"];
  // Multi-terminal Phase 2: documents numbered per till once the device has a
  // till code (Settings → Business & Terminals). The counter itself stays per
  // device (doc_counters, keyed by getBranchId(), which is already per
  // device), so (dispatch_branch_id, dn_no) stays unique; only the displayed
  // number gains the till code. Export file numbers (EXP/LOG/ITM/MKT) don't.
  const TILL_DOC_TYPES = ["DN","GRV","ADJ","CXL","RCT"];
  const TILL_CODE_RE = /^T[0-9]{1,3}$/;
  const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // 4-digit zero-padded; past 9999 the number simply grows (DN10000) rather
  // than wrapping or truncating, so numbers stay unique.
  function formatDocNo(prefix, n){
    if(!Number.isInteger(n) || n<0) throw new Error("Document number must be a non-negative integer");
    return prefix + String(n).padStart(4,"0");
  }
  // The number as shown, printed and put in file names. No till code (an
  // unregistered device, or a document from before tills) = today's format
  // exactly: DN0012, GRV0007. With one: DN-T1-0012, GRV-T2-0007, ADJ-T1-0003,
  // CXL-T1-0002, and receipts T2-0045 (no prefix, short for a 58mm receipt).
  function docDisplay(type, n, tillCode){
    if(!tillCode) return formatDocNo(type, n);
    if(!Number.isInteger(n) || n<0) throw new Error("Document number must be a non-negative integer");
    const num = String(n).padStart(4,"0");
    return type==="RCT"? tillCode+"-"+num : type+"-"+tillCode+"-"+num;
  }
  // A shop's own optional reference on a DN or GRV ("Internal ref."): free
  // text, not required, not unique. Cleaned like the cart's Doc Ref (pos.js
  // cleanDocRef): control characters dropped, whitespace collapsed, trimmed,
  // capped. It never takes part in matching, quantities or variance checks.
  const INTERNAL_REF_MAX = 30;
  function cleanInternalRef(s){
    return String(s==null?"":s).replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0, INTERNAL_REF_MAX).trim();
  }
  // "Harare CBD" -> "HarareCBD"; accents folded ("Zürich" -> "Zurich");
  // everything except A-Z a-z 0-9 dropped; capped at 24 chars; never empty.
  function sanitizeBranchName(name){
    const s = String(name==null?"":name).normalize("NFKD").replace(/[^A-Za-z0-9]/g,"").slice(0,24);
    return s || "Branch";
  }
  // "Is this the same branch?" — compares sanitised names, case-insensitively, so
  // spacing and punctuation differences don't matter. Used by catalogue and receiving.
  function sameBranchName(a, b){
    return sanitizeBranchName(a).toLowerCase()===sanitizeBranchName(b).toLowerCase();
  }
  function fileDatePart(d){
    return String(d.getDate()).padStart(2,"0") + MONTH_ABBR[d.getMonth()] + String(d.getFullYear()%100).padStart(2,"0");
  }
  function fileTimePart(d){
    const h = d.getHours();
    return String(h%12||12).padStart(2,"0") + String(d.getMinutes()).padStart(2,"0") + (h<12?"AM":"PM");
  }
  // Uses the device's local date/time.
  // tillCode (optional) = the till that numbered the document: DN-T1-0012-HarareCBD-…
  function dnFileBase(dnNo, dispatchBranchName, date, tillCode){
    return docDisplay("DN",dnNo,tillCode)+"-"+sanitizeBranchName(dispatchBranchName)+"-"+fileDatePart(date)+"-"+fileTimePart(date);
  }
  // GRV file carries the DISPATCHING branch's name, with the date/time received.
  function grvFileBase(grvNo, dispatchBranchName, receivedDate, tillCode){
    return docDisplay("GRV",grvNo,tillCode)+"-"+sanitizeBranchName(dispatchBranchName)+"-"+fileDatePart(receivedDate)+"-"+fileTimePart(receivedDate);
  }
  function dnFileName(dnNo, dispatchBranchName, date, tillCode){ return dnFileBase(dnNo,dispatchBranchName,date,tillCode)+DOC_FILE_EXT; }
  function grvFileName(grvNo, dispatchBranchName, receivedDate, tillCode){ return grvFileBase(grvNo,dispatchBranchName,receivedDate,tillCode)+DOC_FILE_EXT; }

  // ---- database-backed part ----
  function getBranchId(){
    let id = getSetting("branch_id","");
    if(!id){ id = "B-"+uid4()+uid4(); setSetting("branch_id", id); }
    return id;
  }
  // Increment-and-read is one synchronous block (sql.js is single-threaded), so
  // two rapid taps always get different numbers. The number is consumed in
  // memory before persist() resolves and is never rolled back, so a failed or
  // interrupted save can at worst SKIP a number, never reuse one. Callers must
  // await this before building the file.
  // reserveDocNumber is the synchronous half: callers that must write the
  // document rows in the SAME synchronous step as the number (the dispatch
  // confirm) use it directly and await persist() once afterwards, so the
  // counter and the document are saved together.
  function reserveDocNumber(type){
    if(!DOC_TYPES.includes(type)) throw new Error("Unknown document type: "+type);
    const branchId = getBranchId();
    run(`INSERT INTO doc_counters(branch_id,doc_type,last_no) VALUES(?,?,1)
         ON CONFLICT(branch_id,doc_type) DO UPDATE SET last_no=last_no+1`,[branchId,type]);
    const n = one("SELECT last_no FROM doc_counters WHERE branch_id=? AND doc_type=?",[branchId,type]).last_no;
    // till = this device's till code for the per-till document types ("" when
    // unregistered); callers store it with the document so it displays the
    // same way forever.
    const till = TILL_DOC_TYPES.includes(type)? currentTillCode() : "";
    return { n, text: docDisplay(type,n,till), till };
  }
  // This device's till code from multi-terminal registration (terminal.js), or "".
  // A DN's display number when only its key is at hand: the till code comes
  // from whichever local row knows it (a header, else an event), else from
  // fallbackTill (a replacement is numbered on the same device as the DN it
  // replaces), else none: today's format.
  function dnTillFor(branchId, dnNo){
    if(dnNo==null) return "";
    const r = one("SELECT till_code AS t FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=? AND COALESCE(till_code,'')<>'' LIMIT 1",[branchId,dnNo])
           || one("SELECT dn_till_code AS t FROM dn_events WHERE dn_branch_id=? AND dn_no=? AND COALESCE(dn_till_code,'')<>'' LIMIT 1",[branchId,dnNo]);
    return r? r.t : "";
  }
  function dnDisplayFor(branchId, dnNo, fallbackTill){ return docDisplay("DN", dnNo, dnTillFor(branchId, dnNo) || fallbackTill || ""); }
  function ownDnDisplay(dnNo){ return dnDisplayFor(getBranchId(), dnNo); }
  // What the history search boxes match a DN header row against: the number
  // in both formats (DN0012 and DN-T1-0012), its GRV likewise, both branch
  // names and both internal refs.
  function dnSearchText(h){
    const p = [formatDocNo("DN",h.dn_no), docDisplay("DN",h.dn_no,h.till_code), h.dispatch_branch_name, h.receive_branch_name, h.internal_ref, h.grv_internal_ref];
    if(h.grv_no!=null) p.push(formatDocNo("GRV",h.grv_no), docDisplay("GRV",h.grv_no,h.grv_till_code));
    return p.filter(Boolean).join(" ");
  }
  function currentTillCode(){
    const t = String(getSetting("till_code","")||"").trim();
    return TILL_CODE_RE.test(t)? t : "";
  }
  async function nextDocNumber(type){
    const r = reserveDocNumber(type);
    await persist();
    return r;
  }
  const nextDNNumber = ()=>nextDocNumber("DN");
  const nextGRVNumber = ()=>nextDocNumber("GRV");

  // Identity of a dispatch = (dispatch_branch_id, dn_no). Recorded on the sender
  // when it creates a DN (direction 'sent') and on the receiver when it merges
  // one (direction 'received'). Returns false, recording nothing, if the pair
  // already exists — that is the duplicate rejection Phase 3 relies on.
  // insertDispatchDoc is the synchronous half (no persist); direction 'out'
  // is a DN this device issued, 'in' one it received (Phase 3).
  function insertDispatchDoc(d){
    if(hasDispatchDoc(d.dispatchBranchId, d.dnNo)) return false;
    run(`INSERT INTO dispatch_docs(dispatch_branch_id,dispatch_branch_name,dn_no,receive_branch_name,direction,grv_no,created_ts,
           status,file_name,line_count,unit_total,created_iso,till_code,internal_ref)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.dispatchBranchId,d.dispatchBranchName||"",d.dnNo,d.receiveBranchName||"",d.direction||"out",d.grvNo==null?null:d.grvNo,
       d.createdTs||new Date().toISOString(),d.status||"dispatched",d.fileName||"",d.lineCount||0,d.unitTotal||0,d.createdIso||"",
       d.tillCode||null,d.internalRef||null]);
    return true;
  }
  async function recordDispatchDoc(d){
    if(!insertDispatchDoc(d)) return false;
    await persist();
    return true;
  }
  // A brand-new identity. Used at Setup, and after Replace when the imported file
  // came from a different device: branch_id is never adopted from imported data.
  function resetBranchId(){
    const id = "B-"+uid4()+uid4(); setSetting("branch_id", id); return id;
  }

  // ---- DN events (Phase 4) ----
  // One row per fact about a DN: 'dispatched', 'received', 'variance'. They only
  // ever get ADDED; the merge carries them between devices. event_key makes a
  // fact unique: dispatched/received once per DN (the receiver's copy and the
  // dispatcher's GRV import are the same fact), variance once per report time.
  function dnEventKey(dnBranchId, dnNo, type, ts){
    return dnBranchId+"|"+dnNo+"|"+type+(type==="variance"? "|"+ts : "");
  }
  // e: { dnBranchId, dnNo, type, actorBranchId, actorName, fromName, toName, ts, grvNo, detail, uid?, dnTill?, grvTill? }
  // dnTill / grvTill: the till codes the DN and GRV were numbered under (Phase 2), so
  // the Stock Movements view shows DN-T1-0012 without looking anything up.
  // uid is passed only by the merge (a fact arriving from another device keeps
  // its uid); otherwise the dn_events_uid_ins trigger (db.js) makes one.
  // Synchronous (no persist). Returns true when a new row was written.
  function recordDnEvent(e){
    const before = one("SELECT COUNT(*) AS c FROM dn_events").c;
    run(`INSERT OR IGNORE INTO dn_events(event_key,dn_branch_id,dn_no,event_type,actor_branch_id,actor_branch_name,dn_from_name,dn_to_name,event_ts,grv_no,detail_json,uid,dn_till_code,grv_till_code)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [dnEventKey(e.dnBranchId,e.dnNo,e.type,e.ts), e.dnBranchId, e.dnNo, e.type, e.actorBranchId||"", e.actorName||"", e.fromName||"", e.toName||"",
       e.ts, e.grvNo==null?null:e.grvNo, typeof e.detail==="string"? e.detail : (e.detail? JSON.stringify(e.detail) : ""), e.uid||null,
       e.dnTill||null, e.grvTill||null]);
    return one("SELECT COUNT(*) AS c FROM dn_events").c > before;
  }
  function hasDispatchDoc(dispatchBranchId, dnNo){
    return !!one("SELECT 1 AS x FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=?",[dispatchBranchId,dnNo]);
  }
