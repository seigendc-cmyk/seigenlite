// Loads the REAL app source (state prelude + db/utils/pos/dispatch/backup/docnum/
// dnfile/dispatch-out) into a vm context, over an in-memory node:sqlite
// database wrapped to look like sql.js. Lets tests exercise the actual
// migrate(), dispatch commit, old receive path and merge — not copies of them.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const { DatabaseSync } = require("node:sqlite");

const src = (f)=>fs.readFileSync(path.join(__dirname,"..","src",f),"utf8");
// build.js declares APP_BUILD from sw-pwa.js's "// build: vN" line; same here.
const APP_BUILD = Number(/^\/\/ build: v(\d+)\b/m.exec(fs.readFileSync(path.join(__dirname,"..","sw-pwa.js"),"utf8"))[1]);

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

// The vendored TweetNaCl (activation.js's licence verifier), run INSIDE the
// context the way build.js ships it, so it sees the app's own Uint8Array
// (a require()d copy would reject the context's arrays as foreign).
const NACL_SRC = fs.readFileSync(path.join(__dirname,"..","src","vendor","tweetnacl-fast.min.js"),"utf8");
function loadVendorNacl(ctx){
  vm.runInContext("var module = { exports: {} };\n" + NACL_SRC + "\nvar nacl = module.exports; module = undefined;", ctx, { filename:"tweetnacl-fast.min.js" });
}

// One app instance = one branch's device.
// opts.dom: a real (JSDOM) document, so a test can open the app's own screens
// (openModal, innerHTML, buttons) and read what they say: A.dom, A.File(text, name).
function makeApp(settings, opts){
  const db = new Compat();
  const sqlCtor = function(x){ return x && x.__db ? x.__db : new Compat(); };
  // __fields simulates the handful of checkout-form inputs completeSale()
  // (pos.js) reads directly by id (custName, paymentRef, ...): unset ids
  // still resolve to null exactly as before (every existing test relies on
  // that), so this only changes behavior for ids a test explicitly sets via
  // app.setField().
  const fields = {};
  const ctx = {
    console, TextDecoder, TextEncoder, document:{ getElementById:(id)=> (id in fields)? {value:fields[id]} : null }, window:{ addEventListener:()=>{}, open:()=>{} }, alert:()=>{}, confirm:()=>true, __h:{},
    FileReader: class { readAsArrayBuffer(f){ Promise.resolve().then(()=>{ const b=f.bytes; this.result=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength); this.onload&&this.onload(); }); } },
    // sync.js: navigator.onLine is a plain data object tests flip directly
    // (app.ctx.navigator.onLine = false); fetch defaults to Node's real
    // fetch (Node 18+) so a test can point supabase_url at a local http
    // server for a genuine over-the-wire proof, or override it via
    // app.hook("fetch", fn) to simulate specific failures without a server.
    navigator: { onLine:true },
    crypto: globalThis.crypto,   // terminal.js deviceKey(): crypto.getRandomValues, as in a browser
    fetch: (...args)=> globalThis.fetch(...args),
    setInterval: ()=>0, clearInterval: ()=>{},
    // License anti-rollback (eod.js's fetchNetworkTime): a real setTimeout/
    // clearTimeout/AbortController so its network-probe timeout guard works
    // exactly as it does in a real browser; tests never need to wait out
    // the real NETWORK_TIME_TIMEOUT_MS since app.hook("fetch", fn) resolves
    // synchronously-fast mocks instead of a real pending request.
    setTimeout: (...args)=> setTimeout(...args), clearTimeout: (...args)=> clearTimeout(...args),
    AbortController: (typeof AbortController!=="undefined")? AbortController : undefined,
    escapeHtmlStub:null, SQLctor:sqlCtor, __db:db, persistCount:0,
  };
  let dom = null;
  if(opts && opts.dom){
    const { JSDOM } = require("jsdom");
    dom = new JSDOM(`<!DOCTYPE html><body><div id="app"></div><div id="printArea"></div></body>`, { url:"http://localhost/" });
    Object.assign(ctx, { document:dom.window.document, window:dom.window, FileReader:dom.window.FileReader });
  }
  vm.createContext(ctx);
  loadVendorNacl(ctx);
  const prelude = `const APP_BUILD = ${APP_BUILD};
    let SQL={Database:SQLctor}, db=__db, sessionUser="Tester", currency="$";
    const IDB_NAME="x",IDB_STORE="x",IDB_KEY="x"; let route="", cart=[];
    let sessionStaffId=null, accessStep=1, accessSelectedStaffId=null, accessPinDigits="", accessError="";
    let moreTab="help", settingsUnlocked=false, drawerOpen=false, appliedVoucher=null;
    let stocktakeReportId=null, stocktakeQuery="", plistQuery="", plistBranch="", creditQuery="", directoryQuery="";
    function render(){} async function persist(){ persistCount++; }
    function uid4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
    function printNow(){}
  `;
  const files = ["db.js","activation.js","utils.js","pos.js","customers.js","products.js","dispatch.js","backup.js","docnum.js","dnstatus.js","dnfile.js","dn-browser.js","dispatch-out.js","catalogue.js","catalogue-app.js","grvfile.js","dnreceive.js","dncancel.js","receive-in.js","grv-import.js","adjust.js","dn-cancel.js","staff.js","roles.js","report-writer.js","sync.js","devicecheckin.js","terminal.js","catalogue-sync.js","shared-stock.js","rpn.js","trial.js","dispatch-srv.js","supplier-grv.js","purchasing.js","currencies.js","eod.js","returns.js","stocktake.js","import.js","marketing.js","passcode-check.js","settings.js","branch-stock.js","branch-views.js","credit.js","itred-orders.js"];
  // db.js defines persist/uid4 itself; drop the prelude's copies by loading db.js FIRST is not possible
  // (prelude vars come first), so strip the duplicates from the prelude instead.
  const code = prelude.replace(/async function persist[^\n]*\n/, "").replace(/function uid4[^\n]*\n/, "")
    + files.map(src).join("\n")
    + `\n;this.api={ SCHEMA, migrate, run, one, all, allX, getSetting, setSetting, currentBranch, getBranchId, reserveDocNumber,
        dnCommitDispatch, pendingTransfersCount, receiveTransfer, mergeDatabase, buildDN, validateDN, parseDN, serializeDN,
        sha256Hex, sha256HexPure, localIso, isDNFileBytes, openBranchPricesScreen, openPriceEditModal, showBranchPriceDifferences, hasAdminPasscode, productsTableHtml, productModal, wireProductRowButtons, priceModeOf, getBranchPrices, buildGRV, parseGRV, validateGRV, serializeGRV, checkIncomingDN, resolveLines, buildVarianceReport, varianceMessage, unmatchedMessage, receiveCheckBytes, commitReceive, commitVariance, incomingHeader, grvGetRecord, buildGRVFromCommit, grvFileName, grvVoucherHtml, openManagementWhatsApp, requireSignedIn, isoDateText, dnBuildFromDb, dnHeaderFor, sniffJsonFormat, buildCatalogue, parseCatalogue, validateCatalogue, verifyCatalogueChecksum, serializeCatalogue, checkCatalogueProducts, planCatalogueImport, priceDifferences, setBranchPriceMode, setBranchPrice, branchPriceRows, applyBulkBranchPrices, bulkAdjustPrices, catalogueStatus, buildCatalogueFor, catalogueImportPreflight, commitCatalogueImport, applyCatalogueImport, applyRemotePriceEdit, remotePriceEditable, effectivePrice, priceModeWarning, parsePriceInput, dnDestinationAllowed, dnProductCodeProblem, registerRow, catalogueFileName, catalogueProblemText, priceChangeLines, priceFingerprint, remotePriceNote, onMergePicked, onReplacePicked, dnFileName, insertDispatchDoc, hasDispatchDoc, branchDestinations, ensureSelfInRegister,
        recordDnEvent, dnMovementRows, dnStatusMap, buildMovements, filterMovements, computeDnStatus, awaitingDaysFrom, checkIncomingGRV, commitGrvImport, grvImportCheckBytes, compareGrvLines, mainFileProblem, keepDeviceIdentity, resetBranchId, createDeviceAdmin, adminPasscodeProblem, REPORT_CONFIGS, grvSendText, grvSendLabel, grvShare, dnPhoneFor, dnHeaderFor, dnStoredLines, branchRegisterCardHtml, branchNameLocked, branchNameToSave, destinationNameLocked, destinationLock, destinationLockText, renameRegisterBranch, replaceNameProblem, ADJ_REASONS, ADJ_REDUCE_ONLY, adjustmentProblem, adjustPreviewText, parseAdjustQty, commitAdjustment, adjustmentReport, adjustmentReportData, findAdmin, adjustmentValue, openAdjustStockModal, openAdjustmentsHistory, varianceText, chainText, dnNeedsAttention, backfillDnLinks, DN_CANCELLED_STATUSES, ADJ_SYSTEM_REASONS, ADJ_WRITEOFF_REASONS, writeAdjustment, CANCEL_FORMAT, ACK_FORMAT, CANCEL_KINDS, buildCancel, parseCancel, serializeCancel, buildAck, parseAck, serializeAck, checkIncomingCancel, checkIncomingAck, normalizeCancelPlan, cancelPlanSummary, newCancelNonce, cancelEnabled, startCancelCase, overridePendingCase, postCaseSync, ackCheckBytes, commitAckImport, cancelNoticeFor, cancelNoticeFileName, shareCancelNotice, dnCaseByNo, pendingCaseFor, derivedDnStatus, commitCancelNotice, commitReplacementClose, tombstoneDN, buildAckFromRow, cancelAckShare, commitConflictGrv, dnGetRecord, openCancelWizard, openPendingCancelModal, newerAppMessage, DN_FORMAT_VERSION_REPLACES, DN_STATUS_LABEL,
        pinProblem, hashPinSync, pinTakenByOther, singleOperatorMode, activeStaffWithPin, currentStaff, saveStaffMember, attemptPinLogin, PIN_MAX_ATTEMPTS, PIN_LOCKOUT_MINUTES,
        tenantId, getSupabaseConfig, supabaseConfigured, isOnline, registerSyncType, syncTableFor, enqueueSync, pendingSyncRows, pendingSyncCount,
        syncBackoffMs, supabaseInsert, pushOneSyncRow, runSyncWorker, startSyncWorker, syncTick, cloudSyncSectionHtml, SYNC_BASE_DELAY_MS, SYNC_MAX_DELAY_MS, SYNC_POLL_MS,
        syncReminderShouldShow, syncReminderVisible, dismissSyncReminder, checkSyncReminderModal,
        DC_SUPABASE_URL, DC_ANON_KEY, cloudSyncStatusText,
        deviceCheckin, startDeviceCheckin, dcIsRegistered, dcRegistration, dcCheckinProblemText, marketRegistrationHtml, dcLockCartReason, dcLockAddProductReason, dcMessages, dcPendingMessages, dcMergeMessages, dcDismissMessage, dcMessagesBannerHtml,
        newInstallId, deviceKey, terminalIdentity, isTerminalRegistered, storeTerminal, terminalRpc, registerMainBranch, joinBusiness, issueJoinCode, fetchBusinessBranches, terminalFollowBusiness, terminalProblemText, formatJoinCode, LONG_INSTALL_ID, SYNC_UID_TABLES, TERMINAL_STAMP_TABLES,
        catalogueSyncNow, catPull, catPushProducts, catPushOutbox, catApplyBaseline, catPrepareBaseline, catBaselinePlan, catalogueSyncStatus, catStatusLine,
        catQueuePrice, catPicsEnabled, catPicsNeeded, catDownloadPictures, catPicHtml, catPicLoadKeys, catPicClear, catPicGet, catProductsWithoutCode, catEffectivePrice,
        catProblemText, getCatState:()=>catState, tillStockPending, tillStockNoteHtml, setBranchPrice, setBranchPriceMode, applyRemotePriceEdit, catalogueImportPreflight, catalogueSyncCardHtml,
        catBranchOnServer, catalogueRegisterExtras, changeQty, searchProducts,
        APP_BUILD, sharedStockTill, sellableNow, stockLineText, allowanceValid, allowanceValidUntil, stockSyncNow, sharedStockCheckout, sharedStockStart, sharedStockMerge,
        sharedStockPreApply, sharedStockDone, sharedStockUndo, sharedStockStocktake, sharedStockBalance, branchOnlyProducts, sharedStockStatusHtml, sharedStockOfflineBadgeHtml,
        ssPending:()=>ssPending(), ssPendingTakes:()=>Object.fromEntries(ssPendingTakes()),
        moveStock, recordStockMovement, stockLedgerCheck, docDisplay, formatDocNo, currentTillCode, cleanInternalRef, INTERNAL_REF_MAX, receiptLabel, receiptDisplay,
        dnSearchText, dnDisplayFor, ownDnDisplay, dnTillFor, cancelAckFileName, dnVoucherHtml, setTerminalActive, isTerminalInactive, noteTerminalRefusal, TERMINAL_INACTIVE_TEXT,
        receiveTransfer, startCancelCase, commitAckImport, ackCheckBytes, buildAckFromRow, cancelNoticeFor, dnCaseByNo, dnBuildFromDb, grvImportCheckBytes, commitGrvImport,
        storeAdminSeed, adminComesFromMain, setTerminalAdmin, openAddTerminalModal, openSetTerminalAdminModal, adminCheckMake, adminCheckMatches, ADMIN_FROM_MAIN_TEXT, renderSettings, loadTerminalList,
        GRV_IMPORT_HINT, grvImportDnFileMessage, openGrvImportScreen, openReceiveScreen, openDispatchHistory, dnReceivedLabel, DN_RECEIVED_NOTE, rcDeviceText, rcMovedLines,
        getRpnLink, hasRpnLink, saveRpnLink, rpnFieldsHtml, rpnFieldsFromInputs, rpnSectionHtml, wireRpnSection, rpnLinkState, requestRpnLink, trySendRpnLink, refreshRpnStatus, rpnAfterCheckin, rpnOnboardedByText, rpnVerifyFieldsHtml, rpnLinkStatusHtml, licenceStatusCardHtml,
        supportSectionHtml, wireSupportSection, openSupportHandoff, openExternalUrl, waLink, isTauriApp,
        businessDateToday, oldestOpenShift, openShiftForDate, eodOperatorName, eodOperatorStaffId, shiftBlockReason,
        startShift, eodTotalsFor, completeEOD, markEodPrinted, eodPrintSummary, eodWhatsAppText,
        computeActivationCode, activationStatus, currentDeviceCode,
        LICENCE_PUBLIC_KEYS, LICENCE_EPOCH_MS, licenceState, licenceDeviceCode, deviceTag, deviceKeyHash, parseLicence, verifyLicence, currentLicence,
        applyLicence, enterLegacyCode, redeemShortCode, activateFromInput, classifyActivationInput, licenceProblemText, licencePullPending,
        earliestSaleMs, trialCapMs, licenceUntilMs, licencePretrial, requestTrial, trialAfterCheckin, trialEarliestSaleDate, pretrialBlocked, legacyCutoffMs, legacyHorizonMs, refreshLicenceLock, licenceLocked, noteTrustedTime,
        captureDeviceSettings, restoreDeviceSettings, DEVICE_OWN_SETTINGS, tillStockNoteText,
        trustedTimeHwm, establishTrustedTime, trustedNow, lastClockAnomaly, evaluateTrustedTime, fetchNetworkTime,
        RETURN_REASONS, RETURN_OTHER_TILL_TEXT, returnDaysLimit, setReturnDaysLimit, parseReceiptQuery, returnOriginProblem, findReturnSale, saleReturnState,
        computeReturn, allocateCents, planCreditNote, commitCreditNote, startExchange, cancelExchange, exchangePending:()=>exchangePending(), exchangeApplied,
        creditNoteFull, creditNoteLines, creditNoteWhatsAppText, refundMethodTotals, refundCurrencyTotals, returnsByItem, cnDisplay, eodReturnsLines,
        completeSale, addToCart, cartTotals, cartTotal, customerBalance, salePayments, saleHasPaymentMethod, paymentMethodTotals,
        paymentMethodCurrencyTotals, BASE_CURRENCY_CODE, saveCurrency, activeCurrencies, allCurrencies, getCurrencyByCode,
        quickTapPayments, setQuickTapCurrency:(c)=>{ quickTapCurrency=c; },
        currencyAccepted, currencySymbolFor, currencyNameFor,
        setDb:(d)=>{ db=d; }, getDb:()=>db, setSessionStaffId:(id)=>{ sessionStaffId=id; },
        setRoute:(r)=>{ route=r; }, setDrawerOpen:(v)=>{ drawerOpen=v; }, getMoreTab:()=>moreTab, getSettingsUnlocked:()=>settingsUnlocked,
        setCart:(arr)=>{ cart=arr; }, getCart:()=>cart, getLastReceipt:()=>window._lastReceipt,
        productSearch, productMatches, matchesAnyOrder, searchTokens,
        renderStocktake, renderStocktakeCounting, renderStocktakeCountingListOnly, computeStocktakeVariance,
        setStocktakeQuery:(q)=>{ stocktakeQuery=q; }, getStocktakeQuery:()=>stocktakeQuery,
        parseImportRows, findImportMatch, classifyImportRows, runImport, IMPORT_COLUMN_MAP,
        marketProductRows, marketCleanSelection, marketAddToSelection, marketSavedSelection, MARKET_OPS, MARKET_MAX_PRODUCTS,
        dsUuid, dsHex, dsEnabled, dsBranches, dsRefreshBranches, dsBranchFor, dsFileOnlyReason, dsDestinationNames, dsCached, dsCachedOne, dsPending, dsSendPending, dsPull, dsAfterCheckin, dsPostGrv, dsCancel, dsWriteOff, dsResolveExtra, dsRedispatch, dsReconcile, dsIncomingWaiting, dsOpenIssues, dsInTransit, dsFileCheck, dsLandedCosts, dsCountProblems, dsCreateProduct, dsFindProduct, dsProblems, dsStatusText,
        sgSuppliers, sgSupplier, sgSaveSupplier, sgLanded, sgPostGrv, sgSendPending, sgPull, sgAfterCheckin, sgInvoiceKey, groupPurchases,
        bsPush, bsPull, bsPullDispatches, bsDispatches, bsBranches, bsOtherBranches, bsOtherQty, bsRowFor, bsCopies, bsValueAtCost, bsUpdatedText, bsShowOtherColumn, bsTabAvailable,
        itredAvailable, itredPull, itredSendPending, itredAfterCheckin, itredSetLines, itredMarkComplete, itredReply, itredMarkRead, itredMarkSeen, itredDiscard,
        itredOrders, itredOrderView, itredRow, itredOutbox, itredNewCount, itredUnreadCount, itredWaitingCount, itredGroup, itredStatusHtml,
        renderItredOrders, renderItredFeedback, openItredOrder, itredBannerHtml, itredMoreLabel, renderItredMoreTab,
        bsJoinedOnlyBranchNames, bsBranchByName, bsLocalRows, bsAfterCheckin, bsSoon, renderBranchStock, openBsProductModal, renderProductList,
        setPlistBranch:(b)=>{ plistBranch=b; }, setPlistQuery:(q)=>{ plistQuery=q; }, plistResults,
        textMatches, searchDateWords, fileCopyDate, dnSearchFields, dnLineWords, customerSearch,
        bsBranchQty, bsGroupProducts, bsProductListView, bsFileCopyNames, bsSellLineText, bsShowThisBranchColumn, bsLocalMatch, bsDispatchSearchFields,
        stocktakeCountingTableHtml, stocktakeIsOwnBranch, renderStocktakeReport, productsTableHtml, productListHtml,
        openDnCard, openItemLedger, bvFetchDnCard, bvFetchLedger, bvBranchStockReport, bvDnCardHtml, bvOnOpen, wireItemLedgerOpeners,
        custOtherBranch, custCrossBranchAskNeeded, custCrossBranchAcknowledge, crossBranchCreditCheck, approveCrossBranchCredit, setCartCustomer, getCartCustomer:()=>cartCustomer,
        custPull, custSendPending, saveCustomer, renderDirectory, directoryListHtml, directorySuppliersHtml, customerComboHtml, wireCustomerCombo, custListHtml, renderReportWriter, reportWriterConfigs, runReportWriter,
        can, canStrict, currentRights, navAllowed, moreTabAllowed, firstAllowedRoute, reportCardAllowed, findApprover, rolesSynced, shopRoles, shopRole, shopStaff, shopStaffAll, shopStaffHere,
        staffPull, staffUploadLegacy, attemptShopSignin, staffSession, staffToken, staffEnsureToken, staffSignOut, saveShopStaff, saveShopRole, staffBranchReport, staffDispatchCosts,
        shopStaffSectionHtml, wireShopStaffSection, openRoleModal, openShopStaffModal, signinChoices, rwRunRemote, rwOtherBranches, ROLE_DEFAULTS, ROLE_MENU_RIGHTS, ROLE_ACTION_RIGHTS, staffSectionHtml, saveStaffMember,
        setSessionUser:(n)=>{ sessionUser=n; }, canCreateCustomers, getSessionUser:()=>sessionUser,
        marketFileName, marketBuildDoc, marketValidImage, marketChecksum, MARKET_WHATSAPP };`;
  // getSupabaseConfig() is hardwired to Digital Commerce's live project.
  // Tests must never reach it, so every app instance instead reads the old
  // supabase_url/supabase_anon_key settings (blank = "not configured"),
  // which is how the suites point the worker at a local server.
  // api.getSupabaseConfig is still the real function, for tests of the
  // built-in config itself.
  const testSupabaseConfig = `getSupabaseConfig = function(){ return { url: getSetting("supabase_url",""), anonKey: getSetting("supabase_anon_key","") }; };`;
  vm.runInContext(code + "\npersist = async function(){ persistCount++; };\n" + testSupabaseConfig, ctx, { filename:"app-sources" });
  const api = ctx.api;
  db.run(api.SCHEMA); api.migrate(db);
  Object.entries(settings||{}).forEach(([k,v])=>api.setSetting(k,v));
  // Replace a function/binding inside the app (e.g. spy on downloadDb).
  const hook = (name, fn)=>{ ctx.__h[name]=fn; vm.runInContext(name+" = __h."+name+";", ctx); };
  const setField = (id, value)=>{ fields[id]=value; };
  const File = dom? (text, name)=> new dom.window.File([text], name||"file.json") : null;
  return { api, ctx, db, hook, setField, dom, File };
}

// A fixed test clock for one app: its realm's Date (new Date(), Date.now())
// reads `iso` instead of the machine's clock, so tests about "today", shifts
// and the business day pass at any hour (including after midnight).
// A.setNow(iso) moves it; A.now() is that instant as a Date of this realm.
// Dates built from explicit values are untouched.
function fixedClock(A, iso){
  vm.runInContext(`(function(){ const R = Date; globalThis.__now = R.parse(${JSON.stringify(iso)});
    class D extends R { constructor(...a){ if(a.length) super(...a); else super(globalThis.__now); } static now(){ return globalThis.__now; } }
    Date = D; })()`, A.ctx);
  A.setNow = (s)=>{ A.ctx.__now = Date.parse(s); };
  A.now = ()=> new Date(A.ctx.__now);
  return A;
}

module.exports = { makeApp, Compat, src, loadVendorNacl, fixedClock };
