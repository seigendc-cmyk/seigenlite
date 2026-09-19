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
  const DOC_TYPES = ["DN","GRV","ADJ","CXL","EXP","LOG","ITM"];
  const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // 4-digit zero-padded; past 9999 the number simply grows (DN10000) rather
  // than wrapping or truncating, so numbers stay unique.
  function formatDocNo(prefix, n){
    if(!Number.isInteger(n) || n<0) throw new Error("Document number must be a non-negative integer");
    return prefix + String(n).padStart(4,"0");
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
  function dnFileBase(dnNo, dispatchBranchName, date){
    return formatDocNo("DN",dnNo)+"-"+sanitizeBranchName(dispatchBranchName)+"-"+fileDatePart(date)+"-"+fileTimePart(date);
  }
  // GRV file carries the DISPATCHING branch's name, with the date/time received.
  function grvFileBase(grvNo, dispatchBranchName, receivedDate){
    return formatDocNo("GRV",grvNo)+"-"+sanitizeBranchName(dispatchBranchName)+"-"+fileDatePart(receivedDate)+"-"+fileTimePart(receivedDate);
  }
  function dnFileName(dnNo, dispatchBranchName, date){ return dnFileBase(dnNo,dispatchBranchName,date)+DOC_FILE_EXT; }
  function grvFileName(grvNo, dispatchBranchName, receivedDate){ return grvFileBase(grvNo,dispatchBranchName,receivedDate)+DOC_FILE_EXT; }

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
    return { n, text: formatDocNo(type,n) };
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
           status,file_name,line_count,unit_total,created_iso)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.dispatchBranchId,d.dispatchBranchName||"",d.dnNo,d.receiveBranchName||"",d.direction||"out",d.grvNo==null?null:d.grvNo,
       d.createdTs||new Date().toISOString(),d.status||"dispatched",d.fileName||"",d.lineCount||0,d.unitTotal||0,d.createdIso||""]);
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
  // e: { dnBranchId, dnNo, type, actorBranchId, actorName, fromName, toName, ts, grvNo, detail }
  // Synchronous (no persist). Returns true when a new row was written.
  function recordDnEvent(e){
    const before = one("SELECT COUNT(*) AS c FROM dn_events").c;
    run(`INSERT OR IGNORE INTO dn_events(event_key,dn_branch_id,dn_no,event_type,actor_branch_id,actor_branch_name,dn_from_name,dn_to_name,event_ts,grv_no,detail_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [dnEventKey(e.dnBranchId,e.dnNo,e.type,e.ts), e.dnBranchId, e.dnNo, e.type, e.actorBranchId||"", e.actorName||"", e.fromName||"", e.toName||"",
       e.ts, e.grvNo==null?null:e.grvNo, typeof e.detail==="string"? e.detail : (e.detail? JSON.stringify(e.detail) : "")]);
    return one("SELECT COUNT(*) AS c FROM dn_events").c > before;
  }
  function hasDispatchDoc(dispatchBranchId, dnNo){
    return !!one("SELECT 1 AS x FROM dispatch_docs WHERE dispatch_branch_id=? AND dn_no=?",[dispatchBranchId,dnNo]);
  }
