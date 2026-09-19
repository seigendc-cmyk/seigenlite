// Loads the REAL app source (state prelude + db/utils/pos/dispatch/backup/docnum/
// dnfile/dispatch-out) into a vm context, over an in-memory node:sqlite
// database wrapped to look like sql.js. Lets tests exercise the actual
// migrate(), dispatch commit, old receive path and merge — not copies of them.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const { DatabaseSync } = require("node:sqlite");

const src = (f)=>fs.readFileSync(path.join(__dirname,"..","src",f),"utf8");

// Minimal sql.js-compatible surface used by the app.
class Compat {
  constructor(){ this.h = new DatabaseSync(":memory:"); }
  run(sql, params){ if(params && params.length) this.h.prepare(sql).run(...params); else this.h.exec(sql); }
  prepare(sql){
    const st = this.h.prepare(sql); let rows = null, i = 0, p = [];
    return { bind:(x)=>{ p = x||[]; }, step(){ if(rows===null) rows = st.all(...p); return i<rows.length; },
             getAsObject(){ return {...rows[i++]}; }, free(){} };
  }
}

// One app instance = one branch's device.
function makeApp(settings){
  const db = new Compat();
  const sqlCtor = function(x){ return x && x.__db ? x.__db : new Compat(); };
  const ctx = {
    console, TextDecoder, TextEncoder, document:{ getElementById:()=>null }, window:{}, alert:()=>{}, confirm:()=>true, __h:{},
    FileReader: class { readAsArrayBuffer(f){ Promise.resolve().then(()=>{ const b=f.bytes; this.result=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength); this.onload&&this.onload(); }); } },
    escapeHtmlStub:null, SQLctor:sqlCtor, __db:db, persistCount:0,
  };
  vm.createContext(ctx);
  const prelude = `let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="", cart=[];
    function render(){} async function persist(){ persistCount++; }
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
    function printNow(){}
  `;
  const files = ["db.js","utils.js","pos.js","products.js","dispatch.js","backup.js","docnum.js","dnstatus.js","dnfile.js","dn-browser.js","dispatch-out.js","catalogue.js","catalogue-app.js","grvfile.js","dnreceive.js","dncancel.js","receive-in.js","grv-import.js","adjust.js","dn-cancel.js","staff.js","report-writer.js"];
  // db.js defines persist/uid4 itself; drop the prelude's copies by loading db.js FIRST is not possible
  // (prelude vars come first), so strip the duplicates from the prelude instead.
  const code = prelude.replace(/async function persist[^\n]*\n/, "").replace(/function uid4[^\n]*\n/, "")
    + files.map(src).join("\n")
    + `\n;this.api={ SCHEMA, migrate, run, one, all, allX, getSetting, setSetting, currentBranch, getBranchId, reserveDocNumber,
        dnCommitDispatch, pendingTransfersCount, receiveTransfer, mergeDatabase, buildDN, validateDN, parseDN, serializeDN,
        sha256Hex, sha256HexPure, localIso, isDNFileBytes, openBranchPricesScreen, openPriceEditModal, showBranchPriceDifferences, hasAdminPasscode, productsTableHtml, productModal, wireProductRowButtons, priceModeOf, getBranchPrices, buildGRV, parseGRV, validateGRV, serializeGRV, checkIncomingDN, resolveLines, buildVarianceReport, varianceMessage, unmatchedMessage, receiveCheckBytes, commitReceive, commitVariance, incomingHeader, grvGetRecord, buildGRVFromCommit, grvFileName, grvVoucherHtml, openManagementWhatsApp, requireSignedIn, isoDateText, dnBuildFromDb, dnHeaderFor, sniffJsonFormat, buildCatalogue, parseCatalogue, validateCatalogue, verifyCatalogueChecksum, serializeCatalogue, checkCatalogueProducts, planCatalogueImport, priceDifferences, setBranchPriceMode, setBranchPrice, branchPriceRows, applyBulkBranchPrices, bulkAdjustPrices, catalogueStatus, buildCatalogueFor, catalogueImportPreflight, commitCatalogueImport, applyCatalogueImport, applyRemotePriceEdit, remotePriceEditable, effectivePrice, priceModeWarning, parsePriceInput, dnDestinationAllowed, dnProductCodeProblem, registerRow, catalogueFileName, catalogueProblemText, priceChangeLines, priceFingerprint, remotePriceNote, onMergePicked, onReplacePicked, dnFileName, insertDispatchDoc, hasDispatchDoc, branchDestinations, ensureSelfInRegister,
        recordDnEvent, dnMovementRows, dnStatusMap, buildMovements, filterMovements, computeDnStatus, awaitingDaysFrom, checkIncomingGRV, commitGrvImport, grvImportCheckBytes, compareGrvLines, mainFileProblem, keepDeviceIdentity, resetBranchId, createDeviceAdmin, adminPasscodeProblem, REPORT_CONFIGS, grvSendText, grvSendLabel, grvShare, dnPhoneFor, dnHeaderFor, dnStoredLines, branchRegisterCardHtml, branchNameLocked, branchNameToSave, destinationNameLocked, destinationLock, destinationLockText, renameRegisterBranch, replaceNameProblem, ADJ_REASONS, ADJ_REDUCE_ONLY, adjustmentProblem, adjustPreviewText, parseAdjustQty, commitAdjustment, adjustmentReport, adjustmentReportData, findAdmin, adjustmentValue, openAdjustStockModal, openAdjustmentsHistory, varianceText, chainText, dnNeedsAttention, backfillDnLinks, DN_CANCELLED_STATUSES, ADJ_SYSTEM_REASONS, ADJ_WRITEOFF_REASONS, writeAdjustment, CANCEL_FORMAT, ACK_FORMAT, CANCEL_KINDS, buildCancel, parseCancel, serializeCancel, buildAck, parseAck, serializeAck, checkIncomingCancel, checkIncomingAck, normalizeCancelPlan, cancelPlanSummary, newCancelNonce, cancelEnabled, startCancelCase, overridePendingCase, postCaseSync, ackCheckBytes, commitAckImport, cancelNoticeFor, cancelNoticeFileName, shareCancelNotice, dnCaseByNo, pendingCaseFor, derivedDnStatus, commitCancelNotice, commitReplacementClose, tombstoneDN, buildAckFromRow, cancelAckShare, commitConflictGrv, dnGetRecord, openCancelWizard, openPendingCancelModal, newerAppMessage, DN_FORMAT_VERSION_REPLACES, DN_STATUS_LABEL,
        setDb:(d)=>{ db=d; }, getDb:()=>db };`;
  vm.runInContext(code + "\npersist = async function(){ persistCount++; };", ctx, { filename:"app-sources" });
  const api = ctx.api;
  db.run(api.SCHEMA); api.migrate(db);
  Object.entries(settings||{}).forEach(([k,v])=>api.setSetting(k,v));
  // Replace a function/binding inside the app (e.g. spy on downloadDb).
  const hook = (name, fn)=>{ ctx.__h[name]=fn; vm.runInContext(name+" = __h."+name+";", ctx); };
  return { api, ctx, db, hook };
}

module.exports = { makeApp, Compat, src };
