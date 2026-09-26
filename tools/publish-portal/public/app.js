// Publish Portal page. Everything shown here comes from a vendor's file or
// from staff input, so it is only ever put on the page as text (el() below),
// never as HTML.
"use strict";

const $ = (id)=> document.getElementById(id);
function el(tag, props, ...kids){
  const n = document.createElement(tag);
  for(const [k, v] of Object.entries(props || {})){
    if(v === undefined || v === null || v === false) continue;
    if(k === "class") n.className = v;
    else if(k === "text") n.textContent = v;
    else if(k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if(v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for(const c of kids.flat()) if(c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
let me = null;          // the signed-in staff member: { id, username, name, role, mustChangePassword }
const isAdmin = ()=> !!(me && me.role === "admin");
// The sign-in lives in this variable only — never in a cookie, storage or
// the service worker — so each newly opened window, tab, reload or
// installed-app launch starts signed out.
let session = null;
const authHeaders = ()=> Object.assign({ "X-Portal": "1" }, session ? { "X-Portal-Session": session } : {});

async function api(path, opts){
  opts = opts || {};
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: Object.assign(authHeaders(), opts.json !== undefined ? { "Content-Type": "application/json" } : {}, opts.headers || {}),
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
    credentials: "omit",
    cache: "no-store",
  });
  const data = await res.json().catch(()=> ({}));
  if(res.status === 401 && !["/api/login", "/api/setup"].includes(path)){ showLogin(); throw new Error("Signed out — sign in again."); }
  if(res.status === 403 && data.mustChangePassword){ showPassword(true); throw new Error(data.error); }
  if(!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
const money = (cur, n)=> (cur ? cur + " " : "") + Number(n).toFixed(2);
const qty = (n)=> String(Math.round(Number(n) * 1000) / 1000);
const when = (iso)=> iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
const fmtDate = (d)=> d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
const addDays = (d, n)=>{ const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function showError(id, msg){ const e = $(id); e.textContent = msg || ""; e.hidden = !msg; }
// Photos from an upload need the session header, which an <img src> can't send.
function authImage(img, url){
  fetch(url, { headers: authHeaders(), credentials: "omit", cache: "no-store" })
    .then(r => r.ok ? r.blob() : null)
    .then(b => { if(b){ img.src = URL.createObjectURL(b); img.addEventListener("load", ()=> URL.revokeObjectURL(img.src), { once: true }); } })
    .catch(()=>{});
  return img;
}

// A vendor's token status as a small tag.
function tokenTag(t){
  if(!t) return null;
  if(t.state === "active") return el("span", { class: "tag ok token-tag", text: "token active until " + fmtDate(t.until) });
  if(t.state === "expired") return el("span", { class: "tag bad token-tag", text: "token expired " + fmtDate(t.expiredOn) });
  if(t.state === "future") return el("span", { class: "tag warn token-tag", text: "token starts " + fmtDate(t.startsOn) });
  return el("span", { class: "tag bad token-tag", text: "no token" });
}

// ---------------- views ----------------
const VIEWS = ["login", "setup", "password", "upload", "history", "vendors", "staff"];
let lastView = "upload";
function show(view){
  if(view === "staff" && !isAdmin()) view = "upload";
  VIEWS.forEach(v => { $(v + "View").hidden = v !== view; });
  const signedIn = !["login", "setup"].includes(view);
  $("nav").hidden = !signedIn;
  $("staffTab").hidden = !isAdmin();
  $("whoami").textContent = me ? `${me.name} · ${me.role === "admin" ? "Admin" : "Reviewer"}` : "";
  document.querySelectorAll("#nav .tab").forEach(b => { b.classList.toggle("active", b.dataset.view === view); b.disabled = view === "password" && me && me.mustChangePassword; });
  if(!["login", "setup", "password"].includes(view)) lastView = view;
  if(view === "history") loadHistory();
  if(view === "vendors") loadVendors();
  if(view === "staff") loadStaff();
}
// The next person to sign in starts on Upload, not on the last person's tab.
function showLogin(){ me = null; session = null; batch = null; $("preview").replaceChildren(); lastView = "upload"; show("login"); $("username").focus(); }
function showPassword(forced){
  if(forced && me) me.mustChangePassword = true;
  $("passwordForced").hidden = !forced;
  $("pwCancel").hidden = !!forced;
  showError("passwordError", "");
  show("password");
  $("pwCurrent").focus();
}
const STALE_SERVER = "The portal program that's running is older than this page, so nothing you do would save. Stop the portal (Ctrl+C in its window), start it again, then reload this page.";
function signedIn(r){
  // An older portal signs in with a cookie and hands back no session: every
  // later request would be refused. Stop here and say why.
  if(!r.session){ showLogin(); showError("loginError", STALE_SERVER); showError("setupError", STALE_SERVER); return; }
  session = r.session; const who = r.me; me = who; if(me.mustChangePassword) showPassword(true); else show("upload"); }
document.querySelectorAll("#nav .tab").forEach(b => b.addEventListener("click", ()=> show(b.dataset.view)));

$("loginForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  showError("loginError", "");
  try{
    const r = await api("/api/login", { method: "POST", json: { username: $("username").value, password: $("password").value } });
    $("password").value = "";
    signedIn(r);
  }catch(err){ showError("loginError", err.message); }
});
$("setupForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  showError("setupError", "");
  if($("setupPassword").value !== $("setupPassword2").value) return showError("setupError", "The two passwords don't match.");
  try{
    const r = await api("/api/setup", { method: "POST", json: { setupPassphrase: $("setupPassphrase").value,
      displayName: $("setupName").value, username: $("setupUsername").value, password: $("setupPassword").value } });
    ["setupPassphrase", "setupPassword", "setupPassword2"].forEach(id => { $(id).value = ""; });
    signedIn(r);
  }catch(err){ showError("setupError", err.message); }
});
$("passwordForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  showError("passwordError", "");
  if($("pwNext").value !== $("pwNext2").value) return showError("passwordError", "The two new passwords don't match.");
  try{
    const r = await api("/api/password", { method: "POST", json: { current: $("pwCurrent").value, next: $("pwNext").value } });
    ["pwCurrent", "pwNext", "pwNext2"].forEach(id => { $(id).value = ""; });
    me = r.me;
    show(lastView);
  }catch(err){ showError("passwordError", err.message); }
});
$("pwCancel").addEventListener("click", ()=> show(lastView));
$("passwordBtn").addEventListener("click", ()=> showPassword(false));
$("logoutBtn").addEventListener("click", async ()=>{ try{ await api("/api/logout", { method: "POST", json: {} }); }catch(e){} showLogin(); });

// ---------------- recording a token purchase (Admin) ----------------
// vendor: { installId, businessName }, defaultStart: YYYY-MM-DD
function tokenForm(vendor, defaultStart, onSaved){
  const start = el("input", { type: "date", class: "tk-start", required: true, value: defaultStart });
  const days = el("input", { type: "number", class: "tk-days", min: "1", max: "366", step: "1", required: true, value: "30" });
  const amount = el("input", { type: "number", class: "tk-amount", min: "0", step: "0.01", placeholder: "optional" });
  const currency = el("input", { type: "text", class: "tk-currency", maxlength: "3", value: "USD", size: "4" });
  const via = el("select", { class: "tk-via" }, ["EcoCash", "Cash", "Bank transfer", "WhatsApp arrangement", "Other"].map(o => el("option", { value: o, text: o })));
  const ref = el("input", { type: "text", class: "tk-ref", maxlength: "120", placeholder: "e.g. EcoCash transaction ID" });
  const notes = el("input", { type: "text", class: "tk-notes", maxlength: "500", placeholder: "optional" });
  const covers = el("p", { class: "muted tk-covers" });
  const err = el("p", { class: "error", hidden: true });
  const save = el("button", { type: "submit", class: "primary" }, "Record token");
  const update = ()=>{
    const d = parseInt(days.value, 10);
    covers.textContent = start.value && d >= 1 ? `Covers ${fmtDate(start.value)} to ${fmtDate(addDays(start.value, d - 1))} (${d} day${d === 1 ? "" : "s"}).` : "";
  };
  start.addEventListener("input", update); days.addEventListener("input", update); update();
  const form = el("form", { class: "card token-form" },
    el("h3", { text: `Record a token purchase — ${vendor.businessName || vendor.installId}` }),
    el("div", { class: "grid" },
      el("div", {}, el("label", { text: "Starts on" }), start),
      el("div", {}, el("label", { text: "Days covered" }), days),
      el("div", {}, el("label", { text: "Amount paid" }), el("div", { class: "inline" }, amount, currency)),
      el("div", {}, el("label", { text: "Paid via" }), via),
      el("div", {}, el("label", { text: "Reference" }), ref),
      el("div", {}, el("label", { text: "Notes" }), notes)),
    covers, err, el("div", { class: "actions" }, save));
  form.addEventListener("submit", async (e)=>{
    e.preventDefault();
    err.hidden = true; save.disabled = true;
    try{
      const r = await api(`/api/vendors/${encodeURIComponent(vendor.installId)}/tokens`, { method: "POST", json: {
        startsOn: start.value, days: parseInt(days.value, 10), amount: amount.value, currency: currency.value.trim().toUpperCase(),
        paymentMethod: via.value, reference: ref.value, notes: notes.value } });
      await onSaved(r);
    }catch(ex){ err.textContent = ex.message; err.hidden = false; save.disabled = false; }
  });
  return form;
}

// ---------------- upload + preview ----------------
let batch = null;       // the preview the server returned
const excluded = new Set();

async function upload(file){
  showError("uploadError", "");
  $("preview").replaceChildren(el("p", { class: "muted", text: "Reading " + file.name + "…" }));
  try{
    const text = await file.text();
    batch = await api("/api/batches", { method: "POST", body: text, headers: { "Content-Type": "application/json" } });
    batch.fileName = file.name;
    excluded.clear();
    batch.items.forEach(it => { if(it.problems.length) excluded.add(it.index); });
    renderPreview();
  }catch(err){ $("preview").replaceChildren(); showError("uploadError", err.message); }
  $("fileInput").value = "";
}
// Re-checks the device and token for the file on screen (e.g. after a token is recorded).
async function recheckBatch(){
  const fileName = batch.fileName;
  batch = await api(`/api/batches/${batch.id}`);
  batch.fileName = fileName;
  renderPreview();
}
$("fileInput").addEventListener("change", ()=>{ const f = $("fileInput").files[0]; if(f) upload(f); });
const drop = $("drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if(f) upload(f); });

function renderPreview(){
  const b = batch, v = b.vendor || {}, t = b.token || {};
  const banners = [];
  b.fileProblems.forEach(p => banners.push(el("p", { class: "banner bad", text: p })));
  b.vendorProblems.forEach(p => banners.push(el("p", { class: "banner bad", text: "Vendor: " + p })));
  if(v.install_id && !b.registeredDevice) banners.push(el("p", { class: "banner bad", id: "unregistered",
    text: `Install ID ${v.install_id} doesn't match any registered device (cl_vendors). Publishing is blocked until that's resolved — check the ID with the vendor; their app registers itself when it's online.` }));
  // The token check: only meaningful once the device is registered.
  if(b.registeredDevice && t.state !== "active"){
    const box = el("div", { class: "banner bad", id: "tokenBlock" }, el("span", { text: t.message }));
    if(isAdmin()){
      const btn = el("button", { type: "button", class: "primary", id: "recordTokenBtn" }, "Record a token");
      btn.addEventListener("click", ()=>{
        btn.remove();
        box.after(tokenForm({ installId: v.install_id, businessName: b.registeredDevice.business_name || v.business_name }, t.defaultStart,
          async ()=>{ await recheckBatch(); }));
      });
      box.append(" ", btn);
    } else box.append(el("span", { text: " Ask an Admin to record one." }));
    banners.push(box);
  }
  if(b.registeredDevice && b.registeredDevice.business_name && b.registeredDevice.business_name !== v.business_name)
    banners.push(el("p", { class: "banner warn", text: `The registered device is named "${b.registeredDevice.business_name}", the file says "${v.business_name}". Check it's the same shop.` }));
  if(b.existingVendor) banners.push(el("p", { class: "banner ok", text: "This vendor is already on iTred; publishing updates their details and adds these products." }));

  const vendorCard = el("div", { class: "card", id: "vendorCard" },
    el("h2", { text: "Vendor" }),
    el("dl", {},
      el("dt", { text: "Business" }), el("dd", { text: v.business_name || "—" }),
      el("dt", { text: "Install ID" }), el("dd", {}, el("code", { text: v.install_id || "—" }), " ",
        b.registeredDevice ? el("span", { class: "tag ok", text: "registered device" }) : el("span", { class: "tag bad", text: "not registered" })),
      el("dt", { text: "Token" }), el("dd", { id: "vendorToken" }, b.registeredDevice ? tokenTag(t) : "—"),
      el("dt", { text: "WhatsApp" }), el("dd", { text: v.whatsapp_number || "—" }),
      el("dt", { text: "City" }), el("dd", { text: v.city || "—" }),
      el("dt", { text: "File" }), el("dd", { text: [b.fileName, b.exportNo, when(b.exportedAt)].filter(Boolean).join(" · ") })));

  const rows = b.items.map(it => {
    const blocked = it.problems.length > 0;
    const box = el("input", { type: "checkbox", class: "include", "data-index": String(it.index), "aria-label": "Publish " + (it.name || "item " + (it.index + 1)),
      checked: !excluded.has(it.index), disabled: blocked || !b.canPublish || !!b.result });
    box.addEventListener("change", ()=>{ box.checked ? excluded.delete(it.index) : excluded.add(it.index); tr.classList.toggle("excluded", !box.checked); updateCount(); });
    const photo = it.hasImage ? authImage(el("img", { class: "thumb", alt: it.name || "" }), `/api/batches/${b.id}/images/${it.index}`) : el("div", { class: "nophoto", text: "no photo" });
    const tags = [
      ...it.problems.map(p => el("span", { class: "tag bad", text: p })),
      ...it.notes.map(n => el("span", { class: "tag warn", text: n })),
      it.alreadyLive ? el("span", { class: "tag info", text: "already live — publishing replaces it" }) : null,
    ];
    const tr = el("tr", { class: excluded.has(it.index) ? "excluded" : null, "data-index": String(it.index) },
      el("td", {}, box), el("td", {}, photo),
      el("td", {}, el("div", { class: "pname", text: it.name || "(no name)" }), el("div", { class: "muted", text: it.category || "" })),
      el("td", { class: "num", text: it.price == null || isNaN(it.price) ? "—" : money(it.currency, it.price) }),
      el("td", { class: "num", text: it.stock == null || isNaN(it.stock) ? "—" : qty(it.stock) }),
      el("td", {}, tags),
      el("td", { class: "result" }));
    return tr;
  });
  const publishBtn = el("button", { type: "button", class: "primary", id: "publishBtn", onclick: doPublish, disabled: !b.canPublish || !!b.result }, "Publish");
  const count = el("span", { class: "muted", id: "publishCount" });
  function updateCount(){
    const n = b.items.filter(it => !excluded.has(it.index) && !it.problems.length).length;
    count.textContent = b.canPublish ? `${n} of ${b.items.length} products will be published`
      : b.registeredDevice && b.fileProblems.length === 0 && t.state !== "active" ? t.message
      : "Publishing is blocked for this file";
    publishBtn.disabled = !b.canPublish || !n || !!b.result;
  }
  $("preview").replaceChildren(...banners, vendorCard,
    el("div", { class: "card" }, el("h2", { text: `Products (${b.items.length})` }),
      el("table", { id: "items" },
        el("thead", {}, el("tr", {}, el("th", { text: "" }), el("th", { text: "Photo" }), el("th", { text: "Product" }),
          el("th", { class: "num", text: "Price" }), el("th", { class: "num", text: "Stock" }), el("th", { text: "Checks" }), el("th", { text: "Result" }))),
        el("tbody", {}, rows)),
      el("div", { class: "actions" }, count, publishBtn)),
    el("div", { id: "publishSummary" }));
  updateCount();
  if(b.result) showResult(b.result);
}

async function doPublish(){
  const b = batch;
  const include = b.items.filter(it => !excluded.has(it.index) && !it.problems.length).map(it => it.index);
  if(!include.length) return;
  if(!confirm(`Publish ${include.length} product${include.length === 1 ? "" : "s"} from ${b.vendor.business_name} to the iTred Market Place?`)) return;
  const btn = $("publishBtn");
  btn.disabled = true; btn.textContent = "Publishing…";
  document.querySelectorAll("#items .include").forEach(c => { c.disabled = true; });
  try{
    b.result = await api(`/api/batches/${b.id}/publish`, { method: "POST", json: { include } });
    showResult(b.result);
    btn.textContent = "Published";
  }catch(err){
    btn.textContent = "Publish"; btn.disabled = false;
    document.querySelectorAll("#items .include").forEach(c => { c.disabled = false; });
    $("publishSummary").replaceChildren(el("p", { class: "banner bad", text: "Nothing was published: " + err.message }));
  }
}
function showResult(result){
  const ok = result.results.filter(r => r.ok).length, n = result.results.length;
  for(const r of result.results){
    const cell = document.querySelector(`#items tr[data-index="${r.index}"] td.result`);
    if(!cell) continue;
    cell.replaceChildren(r.ok
      ? el("span", { class: "tag ok", text: "published" + (r.superseded ? " (replaced " + r.superseded + " older)" : "") + (r.imageUrl ? "" : " · no photo") })
      : el("span", { class: "tag bad", text: `failed at ${r.step}: ${r.error}` }));
  }
  $("publishSummary").replaceChildren(el("p", { class: "banner " + (ok === n ? "ok" : ok ? "warn" : "bad"), id: "resultBanner",
    text: `${ok} of ${n} published at ${when(result.publishedAt)}.` + (ok < n ? " The failed ones are marked above; fix and upload again to retry them." : " Live on iTred for 7 days.") }));
}

// ---------------- history ----------------
async function loadHistory(){
  showError("historyError", "");
  $("history").replaceChildren(el("p", { class: "muted", text: "Loading…" }));
  try{
    const { groups } = await api("/api/history");
    if(!groups.length){ $("history").replaceChildren(el("p", { class: "muted", text: "Nothing has been published yet." })); return; }
    $("history").replaceChildren(...groups.map(g => el("details", { class: "group" },
      el("summary", {}, el("b", { text: g.vendor }), ` · ${when(g.publishedAt)} · ${g.count} product${g.count === 1 ? "" : "s"}, `,
        el("span", { class: g.live ? "tag ok" : "tag warn", text: `${g.live} live` }), " ", tokenTag(g.token)),
      el("table", {}, el("tbody", {}, g.listings.map(l => el("tr", { "data-listing": l.id },
        el("td", {}, l.imageUrl ? el("img", { class: "thumb", src: l.imageUrl, alt: l.name, loading: "lazy" }) : el("div", { class: "nophoto", text: "no photo" })),
        el("td", { text: l.name }),
        el("td", { class: "num", text: money(l.currency, l.price) }),
        el("td", { class: "num", text: qty(l.stock) }),
        el("td", {}, el("span", { class: "tag " + (l.status === "live" ? "ok" : "warn"), text: l.status === "pending_review" ? "unpublished" : l.status })),
        el("td", {}, l.status === "live" ? el("button", { type: "button", class: "danger unpublish", onclick: ()=> unpublish(l) }, "Unpublish") : null))))))));
  }catch(err){ $("history").replaceChildren(); showError("historyError", err.message); }
}
async function unpublish(l){
  if(!confirm(`Take "${l.name}" off the iTred Market Place? Customers stop seeing it straight away.`)) return;
  try{ await api(`/api/listings/${l.id}/unpublish`, { method: "POST", json: {} }); await loadHistory(); }
  catch(err){ showError("historyError", err.message); }
}
$("refreshHistory").addEventListener("click", loadHistory);

// ---------------- vendors & tokens ----------------
const openVendors = new Set();   // install IDs expanded, kept across reloads of the list
async function loadVendors(){
  showError("vendorsError", "");
  try{
    const { vendors } = await api("/api/vendors");
    if(!vendors.length){ $("vendors").replaceChildren(el("p", { class: "muted", text: "No registered devices yet." })); return; }
    $("vendors").replaceChildren(...vendors.map(v => {
      const d = el("details", { class: "group vendor", "data-install": v.installId, open: openVendors.has(v.installId) },
        el("summary", {}, el("b", { text: v.businessName || "(no name)" }), " · ", el("code", { text: v.installId }), " ", tokenTag(v.token)),
        el("div", { class: "vendor-body" },
          v.tokens.length ? el("table", { class: "tokens" },
            el("thead", {}, el("tr", {}, ["Covers", "Days", "Paid", "Via / reference", "Recorded", ""].map(h => el("th", { text: h })))),
            el("tbody", {}, v.tokens.map(tk => el("tr", { class: tk.voidedAt ? "voided" : null, "data-token": tk.id },
              el("td", { text: `${fmtDate(tk.startsOn)} – ${fmtDate(tk.endsOn)}` }),
              el("td", { class: "num", text: String(tk.days) }),
              el("td", { class: "num", text: tk.amount == null ? "—" : money(tk.currency, tk.amount) }),
              el("td", { text: [tk.paymentMethod, tk.reference].filter(Boolean).join(" · ") + (tk.notes ? ` (${tk.notes})` : "") }),
              el("td", { text: `${tk.recordedBy}, ${when(tk.recordedAt)}` }),
              el("td", {}, tk.voidedAt ? el("span", { class: "tag warn", text: `voided by ${tk.voidedBy}: ${tk.voidReason}` })
                : isAdmin() ? el("button", { type: "button", class: "danger void", onclick: ()=> voidToken(tk) }, "Void") : null)))))
            : el("p", { class: "muted", text: "No tokens recorded yet." }),
          isAdmin() ? tokenForm(v, v.defaultStart, async ()=>{ openVendors.add(v.installId); await loadVendors(); }) : null));
      d.addEventListener("toggle", ()=>{ d.open ? openVendors.add(v.installId) : openVendors.delete(v.installId); });
      return d;
    }));
  }catch(err){ showError("vendorsError", err.message); }
}
async function voidToken(tk){
  const reason = prompt(`Void the token covering ${fmtDate(tk.startsOn)} – ${fmtDate(tk.endsOn)}? It stays on record, marked void. Why?`);
  if(reason === null) return;
  try{ await api(`/api/tokens/${tk.id}/void`, { method: "POST", json: { reason } }); await loadVendors(); }
  catch(err){ showError("vendorsError", err.message); }
}
$("refreshVendors").addEventListener("click", loadVendors);

// ---------------- staff (Admin) ----------------
async function loadStaff(){
  showError("staffError", "");
  try{
    const { staff } = await api("/api/staff");
    $("staffList").replaceChildren(el("table", { class: "card staff" },
      el("thead", {}, el("tr", {}, ["Name", "Username", "Role", "Status", "Last sign-in", ""].map(h => el("th", { text: h })))),
      el("tbody", {}, staff.map(s => {
        const self = me && s.id === me.id;
        const role = el("select", { class: "role", disabled: self || !s.active, "aria-label": "Role for " + s.username },
          el("option", { value: "reviewer", text: "Reviewer", selected: s.role === "reviewer" }),
          el("option", { value: "admin", text: "Admin", selected: s.role === "admin" }));
        role.addEventListener("change", ()=> staffAction(s, { action: "role", role: role.value }));
        const status = [s.active ? null : el("span", { class: "tag warn", text: "deactivated" }),
          s.locked ? el("span", { class: "tag bad", text: "locked until " + new Date(s.lockedUntil).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) }) : null,
          s.mustChangePassword ? el("span", { class: "tag info", text: "temporary password" }) : null,
          s.active && !s.locked && !s.mustChangePassword ? el("span", { class: "tag ok", text: "active" }) : null];
        const actions = [
          s.locked ? el("button", { type: "button", class: "unlock", onclick: ()=> staffAction(s, { action: "unlock" }) }, "Unlock") : null,
          !self ? el("button", { type: "button", class: "reset", onclick: ()=>{
            const pw = prompt(`New temporary password for ${s.name} (10+ characters). They'll choose their own at next sign-in.`);
            if(pw !== null) staffAction(s, { action: "reset-password", password: pw });
          } }, "Reset password") : null,
          !self ? (s.active
            ? el("button", { type: "button", class: "danger deactivate", onclick: ()=>{ if(confirm(`Deactivate ${s.name}? They're signed out and can't sign in until reactivated.`)) staffAction(s, { action: "deactivate" }); } }, "Deactivate")
            : el("button", { type: "button", class: "activate", onclick: ()=> staffAction(s, { action: "activate" }) }, "Reactivate")) : el("span", { class: "muted", text: "you" }),
        ];
        return el("tr", { "data-username": s.username }, el("td", { text: s.name }), el("td", {}, el("code", { text: s.username })),
          el("td", {}, role), el("td", {}, status), el("td", { text: s.lastLoginAt ? when(s.lastLoginAt) : "never" }), el("td", { class: "row-actions" }, actions));
      }))));
  }catch(err){ showError("staffError", err.message); }
}
async function staffAction(s, body){
  showError("staffError", "");
  try{ await api(`/api/staff/${s.id}`, { method: "POST", json: body }); }
  catch(err){ showError("staffError", err.message); }
  await loadStaff();
}
$("addStaffForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  showError("addStaffError", "");
  try{
    await api("/api/staff", { method: "POST", json: { displayName: $("newName").value, username: $("newUsername").value,
      role: $("newRole").value, password: $("newPassword").value } });
    ["newName", "newUsername", "newPassword"].forEach(id => { $(id).value = ""; });
    await loadStaff();
  }catch(err){ showError("addStaffError", err.message); }
});

// ---------------- start ----------------
// A freshly opened page never has a session: it's either first-run setup or the sign-in form.
api("/api/session").then(s => {
  if(s.setupNeeded){ show("setup"); if(!s.setupAvailable) showError("setupError", "Set PORTAL_PASSPHRASE in .env and restart the portal to create the first Admin."); return; }
  showLogin();
}).catch(()=> showLogin());

// Closing or reloading the window (or the installed app) ends the session
// on the server too, not just in this page's memory.
addEventListener("pagehide", ()=>{
  if(!session) return;
  // A beacon is what browsers reliably send while a page is going away.
  navigator.sendBeacon("/api/end-session", new Blob([JSON.stringify({ session })], { type: "text/plain" }));
  session = null;
});

// Installable app (sw.js caches the page shell only — never /api).
if("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(()=>{});
// A page brought back from the back/forward cache comes back signed out too.
addEventListener("pageshow", (e)=>{ if(e.persisted && !session) showLogin(); });
