  // ---------------- Catalogue file for remote branches ----------------
  // "seigen-catalogue": main's product list for ONE destination branch, as a
  // self-contained JSON file (same style and checksum scheme as the DN file).
  // Pure — no DOM, no database — so test/catalogue.test.js loads it under
  // plain Node together with docnum.js and dnfile.js (it reuses their SHA-256,
  // key-order and name/date helpers).
  //
  // Per product it carries ONLY what a shop needs to sell the item: code,
  // name, selling price (effective for that destination), a small picture and
  // the hidden search keywords. Never cost, stock, shelf, reorder level or any
  // supplier data. It also carries the price policy for the destination, the
  // management WhatsApp number, and the destination register (names and
  // numbers) so a remote can pick dispatch destinations without ever
  // receiving main's SQLite export.
  const CAT_FORMAT = "seigen-catalogue";
  const CAT_FORMAT_VERSION = 1;
  const CAT_PRICE_MODES = ["follow_main","main_sets","branch_edits"];
  const CAT_MAX_PRICE = 1000000000;

  function catalogueFileBase(destName, date){
    return "CAT-"+sanitizeBranchName(destName)+"-"+fileDatePart(date)+"-"+fileTimePart(date);
  }
  function catalogueFileName(destName, date){ return catalogueFileBase(destName,date)+DOC_FILE_EXT; }

  const catCode = (c)=> String(c==null?"":c).trim().toLowerCase();
  const catRound = (n)=> Math.round(n*100)/100;

  // Non-negative number, at most 2 decimals kept. Accepts a number or text.
  // -> { ok, value, error }
  function parsePriceInput(v){
    if(v===null || v===undefined || (typeof v==="string" && v.trim()==="")) return { ok:false, error:"Enter a price." };
    const n = typeof v==="number" ? v : Number(String(v).trim().replace(/,/g,"."));
    if(!Number.isFinite(n)) return { ok:false, error:"Price must be a number." };
    if(n<0) return { ok:false, error:"Price cannot be negative." };
    if(n>CAT_MAX_PRICE) return { ok:false, error:"Price is unrealistically large." };
    return { ok:true, value:catRound(n) };
  }
  // The price a destination should see: a branch price only counts in
  // 'main_sets' mode; a missing branch price falls back to main's.
  function effectivePrice(mainPrice, branchPrice, mode){
    if(mode==="main_sets" && branchPrice!==null && branchPrice!==undefined) return catRound(Number(branchPrice));
    return catRound(Number(mainPrice)||0);
  }

  // Products that cannot go in a catalogue: empty code, or a code shared with
  // another product (compared trimmed and case-insensitively). Every member
  // of a duplicate group is listed.
  // -> [{ product, reason:"empty"|"duplicate", other? }]
  function checkCatalogueProducts(products){
    const problems = [], byCode = new Map();
    products.forEach(p=>{
      const k = catCode(p.sku);
      if(!k){ problems.push({ product:p, reason:"empty" }); return; }
      if(!byCode.has(k)) byCode.set(k,[]);
      byCode.get(k).push(p);
    });
    byCode.forEach(group=>{
      if(group.length>1) group.forEach(p=>problems.push({ product:p, reason:"duplicate", other:group.filter(x=>x!==p).map(x=>x.name).join(", ") }));
    });
    return problems;
  }
  function catalogueProblemText(pr){
    const n = pr.product.name;
    return pr.reason==="empty" ? "Add a code to "+n+" in Products first."
      : n+" shares its code ("+pr.product.sku+") with "+pr.other+" — give each product its own code in Products first.";
  }

  // Detects "did the prices main would send change since the last catalogue".
  // Order-independent hash over code:price of every coded item.
  function priceFingerprint(items){
    const rows = items.map(i=>[catCode(i.code), catRound(Number(i.price))]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
    return sha256HexPure(JSON.stringify(rows));
  }

  function canonicalCatalogue(d, withChecksum){
    const out = {
      format: d.format,
      format_version: d.format_version,
      from: { branch_id: d.from && d.from.branch_id, name: d.from && d.from.name },
      to: { name: d.to && d.to.name },
      created_iso: d.created_iso,
      price_mode: d.price_mode,
      management_whatsapp: d.management_whatsapp,
      register: (d.register||[]).map(r=>({ name:r.name, whatsapp:r.whatsapp })),
      items: (d.items||[]).map(it=>{
        const o = { code:it.code, name:it.name, price:it.price };
        if(it.description) o.description = it.description;
        if(it.thumb) o.thumb = it.thumb;
        return o;
      }),
      totals: { items: d.totals && d.totals.items }
    };
    if(withChecksum) out.checksum = d.checksum;
    return out;
  }
  async function catalogueChecksum(d, hashFn){
    return await (hashFn||sha256Hex)(JSON.stringify(canonicalCatalogue(d,false)));
  }
  // input: { fromBranchId, fromName, toName, createdIso, priceMode, managementWhatsapp,
  //          register:[{name,whatsapp}], items:[{code,name,price,description?,thumb?}] }
  // Throws on anything that could never be a valid catalogue, so a bad file is never written.
  async function buildCatalogue(input, hashFn){
    const items = (input.items||[]).map(it=>({
      code: String(it.code==null?"":it.code).trim(),
      name: String(it.name==null?"":it.name).trim(),
      price: catRound(Number(it.price)),
      description: it.description? String(it.description) : undefined,
      thumb: it.thumb||undefined
    }));
    const doc = {
      format: CAT_FORMAT, format_version: CAT_FORMAT_VERSION,
      from: { branch_id: input.fromBranchId, name: input.fromName },
      to: { name: input.toName },
      created_iso: input.createdIso,
      price_mode: input.priceMode,
      management_whatsapp: String(input.managementWhatsapp||""),
      register: (input.register||[]).map(r=>({ name:String(r.name||"").trim(), whatsapp:String(r.whatsapp||"") })),
      items,
      totals: { items: items.length }
    };
    const errs = catalogueStructureErrors(doc);
    if(errs.length) throw new Error("Cannot build catalogue: "+errs.join("; "));
    const out = canonicalCatalogue(doc,false);
    out.checksum = await catalogueChecksum(doc, hashFn);
    return out;
  }
  function serializeCatalogue(doc){ return JSON.stringify(canonicalCatalogue(doc,true)); }

  const CAT_TOP_KEYS = ["format","format_version","from","to","created_iso","price_mode","management_whatsapp","register","items","totals","checksum"];
  function catalogueStructureErrors(d){
    const e = [];
    if(!isObj(d)) return ["This is not a catalogue file."];
    if(d.format!==CAT_FORMAT) return ["This is not a seiGEN catalogue (wrong file type)."];
    if(d.format_version!==CAT_FORMAT_VERSION)
      return [newerAppMessage("catalogue", d.format_version, CAT_FORMAT_VERSION)];
    Object.keys(d).forEach(k=>{ if(!CAT_TOP_KEYS.includes(k)) e.push("Unexpected field \""+k+"\" in the catalogue."); });
    if(!isObj(d.from) || !isNonEmptyStr(d.from.branch_id) || !isNonEmptyStr(d.from.name)) e.push("The sending branch (id and name) is missing.");
    if(!isObj(d.to) || !isNonEmptyStr(d.to.name)) e.push("The destination branch is missing.");
    if(!isNonEmptyStr(d.created_iso) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/.test(d.created_iso)) e.push("The date and time the catalogue was made is missing or invalid.");
    if(!CAT_PRICE_MODES.includes(d.price_mode)) e.push("The price policy is missing or unknown.");
    if(typeof d.management_whatsapp!=="string") e.push("The management number field is missing.");
    if(!Array.isArray(d.register)) e.push("The branch list is missing.");
    else d.register.forEach((r,i)=>{
      if(!isObj(r) || !isNonEmptyStr(r.name) || typeof r.whatsapp!=="string") e.push("Branch "+(i+1)+" in the branch list is not valid.");
    });
    if(!Array.isArray(d.items) || d.items.length===0) e.push("The catalogue has no products.");
    else {
      const seen = new Set();
      d.items.forEach((it,i)=>{
        const n = i+1;
        if(!isObj(it)){ e.push("Product "+n+" is not valid."); return; }
        if(!isNonEmptyStr(it.code)) e.push("Product "+n+" has no code.");
        if(!isNonEmptyStr(it.name)) e.push("Product "+n+" has no name.");
        if(typeof it.price!=="number" || !Number.isFinite(it.price) || it.price<0 || it.price>CAT_MAX_PRICE) e.push("Product "+n+" ("+(it.name||it.code||"?")+") has an invalid price.");
        if(it.description!==undefined && typeof it.description!=="string") e.push("Product "+n+" has an invalid description.");
        if(it.thumb!==undefined && (typeof it.thumb!=="string" || !/^data:image\/(webp|jpeg|png);base64,/.test(it.thumb))) e.push("Product "+n+" has an invalid picture.");
        Object.keys(it).forEach(k=>{ if(!["code","name","price","description","thumb"].includes(k)) e.push("Product "+n+" has an unexpected field \""+k+"\"."); });
        const key = catCode(it.code);
        if(key && seen.has(key)) e.push("Code "+it.code+" appears more than once in this catalogue.");
        seen.add(key);
      });
    }
    if(!isObj(d.totals)) e.push("The totals are missing.");
    else if(Array.isArray(d.items) && d.totals.items!==d.items.length) e.push("The totals do not match the products listed.");
    return e;
  }
  async function verifyCatalogueChecksum(d, hashFn){
    if(!isObj(d) || typeof d.checksum!=="string" || !/^[0-9a-f]{64}$/.test(d.checksum)) return false;
    return (await catalogueChecksum(d, hashFn)) === d.checksum;
  }
  async function validateCatalogue(d, hashFn){
    const errors = catalogueStructureErrors(d);
    if(errors.length===0){
      if(typeof d.checksum!=="string" || !/^[0-9a-f]{64}$/.test(d.checksum)) errors.push("The file has no valid checksum — it may be incomplete.");
      else if(!(await verifyCatalogueChecksum(d,hashFn))) errors.push("The file's checksum does not match — it was changed or damaged after it was created. Ask main to send it again.");
    }
    return { ok: errors.length===0, errors };
  }
  async function parseCatalogue(text, hashFn){
    let d;
    try{ d = JSON.parse(String(text).replace(/^﻿/,"")); }
    catch(e){ return { ok:false, errors:["This file is not a readable catalogue (it is not valid JSON, or was cut off)."], doc:null }; }
    const r = await validateCatalogue(d, hashFn);
    return { ok:r.ok, errors:r.errors, doc: r.ok? d : null };
  }
  function isCatalogueFileBytes(bytes){ return sniffJsonFormat(bytes)===CAT_FORMAT; }

  // What importing this catalogue would do, WITHOUT doing it.
  //   localProducts: this branch's own product rows [{id,name,sku,price,image}]
  //   priceMode:     the mode carried by the catalogue
  // Rules
  //   new code               -> insert (catalogue price, no stock, no cost)
  //   existing code          -> name and image update; price overwritten only
  //                             in follow_main / main_sets, never in branch_edits
  //   stock, cost, deletes   -> never
  //   local duplicate codes  -> ambiguous: the import is blocked
  function planCatalogueImport(doc, localProducts, priceMode){
    const mode = priceMode || doc.price_mode;
    const overwrite = mode==="follow_main" || mode==="main_sets";
    const byCode = new Map(), ambiguous = [];
    localProducts.forEach(p=>{
      const k = catCode(p.sku); if(!k) return;
      if(!byCode.has(k)) byCode.set(k,[]);
      byCode.get(k).push(p);
    });
    byCode.forEach((g,k)=>{ if(g.length>1) ambiguous.push({ code:k, names:g.map(p=>p.name) }); });
    const plan = { inserts:[], updates:[], priceChanges:[], nameChanges:0, imageChanges:0, unchanged:0, ambiguous, overwritesPrices:overwrite };
    doc.items.forEach(it=>{
      const g = byCode.get(catCode(it.code));
      if(!g){ plan.inserts.push(it); return; }
      if(g.length>1) return;                              // reported in `ambiguous`
      const p = g[0], u = { id:p.id, code:it.code };
      let changed = false;
      if(it.name!==p.name){ u.name = it.name; plan.nameChanges++; changed = true; }
      if(it.thumb && it.thumb!==p.image){ u.image = it.thumb; plan.imageChanges++; changed = true; }
      if(overwrite && catRound(Number(p.price)||0)!==catRound(it.price)){
        u.price = it.price; changed = true;
        plan.priceChanges.push({ code:it.code, name:it.name, old:catRound(Number(p.price)||0), new:catRound(it.price) });
      }
      if(changed) plan.updates.push(u); else plan.unchanged++;
    });
    return plan;
  }
  // Text for the import preview: "CODE name: old to new", first `max` only.
  function priceChangeLines(changes, max){
    max = max||10;
    const lines = changes.slice(0,max).map(c=>c.code+" "+c.name+": "+c.old.toFixed(2)+" to "+c.new.toFixed(2));
    if(changes.length>max) lines.push("+"+(changes.length-max)+" more");
    return lines;
  }
  // Warning shown when the policy changes AND applying it would overwrite prices.
  // oldMode is "" on a first import.
  function priceModeWarning(oldMode, newMode, plan){
    if(!oldMode || oldMode===newMode) return "";
    if((newMode==="follow_main" || newMode==="main_sets") && plan.priceChanges.length>0)
      return "Main has changed how prices work for this branch (from "+priceModeLabel(oldMode)+" to "+priceModeLabel(newMode)+"). Applying this catalogue will replace "+plan.priceChanges.length+" price"+(plan.priceChanges.length===1?"":"s")+" with main's.";
    return "";
  }
  function priceModeLabel(m){
    return m==="main_sets" ? "main sets each branch's prices" : m==="branch_edits" ? "this branch edits its own prices" : "prices follow main";
  }
  // "Set all to main +X%": rows [{code, main}] -> [{code, main, new}] (rounded, never negative).
  function bulkAdjustPrices(rows, pct){
    if(typeof pct!=="number" || !Number.isFinite(pct) || pct<=-100) throw new Error("Enter a percentage above -100.");
    return rows.map(r=>({ code:r.code, name:r.name, main:r.main, new: Math.max(0, catRound(r.main*(1+pct/100))) }));
  }
  // Information for main after merging a branch's data file: products whose
  // price at the branch differs from main's, matched by code. Changes nothing.
  // -> [{ code, name, main, branch }] sorted by code
  function priceDifferences(mainProducts, branchProducts){
    const main = new Map();
    mainProducts.forEach(p=>{ const k = catCode(p.sku); if(k && !main.has(k)) main.set(k,p); });
    const out = [];
    branchProducts.forEach(b=>{
      const k = catCode(b.sku); if(!k) return;
      const m = main.get(k); if(!m) return;
      const mp = catRound(Number(m.price)||0), bp = catRound(Number(b.price)||0);
      if(mp!==bp) out.push({ code:m.sku, name:m.name, main:mp, branch:bp });
    });
    return out.sort((a,b)=>catCode(a.code)<catCode(b.code)?-1:catCode(a.code)>catCode(b.code)?1:0);
  }
