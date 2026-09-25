// Publish Portal page. Everything shown here comes from a vendor's file,
// so it is only ever put on the page as text (el() below), never as HTML.
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
async function api(path, opts){
  opts = opts || {};
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: Object.assign({ "X-Portal": "1" }, opts.json !== undefined ? { "Content-Type": "application/json" } : {}, opts.headers || {}),
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
    credentials: "same-origin",
  });
  const data = await res.json().catch(()=> ({}));
  if(res.status === 401 && path !== "/api/login"){ showLogin(); throw new Error("Signed out — sign in again."); }
  if(!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
const money = (cur, n)=> (cur ? cur + " " : "") + Number(n).toFixed(2);
const qty = (n)=> String(Math.round(Number(n) * 1000) / 1000);
const when = (iso)=> iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
function showError(id, msg){ const e = $(id); e.textContent = msg || ""; e.hidden = !msg; }

// ---------------- views ----------------
function show(view){
  $("loginView").hidden = view !== "login";
  $("uploadView").hidden = view !== "upload";
  $("historyView").hidden = view !== "history";
  $("nav").hidden = view === "login";
  document.querySelectorAll("#nav .tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  if(view === "history") loadHistory();
}
function showLogin(){ show("login"); $("passphrase").focus(); }
document.querySelectorAll("#nav .tab").forEach(b => b.addEventListener("click", ()=> show(b.dataset.view)));

$("loginForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  showError("loginError", "");
  try{
    await api("/api/login", { method: "POST", json: { passphrase: $("passphrase").value } });
    $("passphrase").value = "";
    show("upload");
  }catch(err){ showError("loginError", err.message); }
});
$("logoutBtn").addEventListener("click", async ()=>{ try{ await api("/api/logout", { method: "POST", json: {} }); }catch(e){} showLogin(); });

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
$("fileInput").addEventListener("change", ()=>{ const f = $("fileInput").files[0]; if(f) upload(f); });
const drop = $("drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if(f) upload(f); });

function renderPreview(){
  const b = batch, v = b.vendor || {};
  const banners = [];
  b.fileProblems.forEach(p => banners.push(el("p", { class: "banner bad", text: p })));
  b.vendorProblems.forEach(p => banners.push(el("p", { class: "banner bad", text: "Vendor: " + p })));
  if(v.install_id && !b.registeredDevice) banners.push(el("p", { class: "banner bad", id: "unregistered",
    text: `Install ID ${v.install_id} doesn't match any registered device (cl_vendors). Publishing is blocked until that's resolved — check the ID with the vendor; their app registers itself when it's online.` }));
  if(b.registeredDevice && b.registeredDevice.business_name && b.registeredDevice.business_name !== v.business_name)
    banners.push(el("p", { class: "banner warn", text: `The registered device is named "${b.registeredDevice.business_name}", the file says "${v.business_name}". Check it's the same shop.` }));
  if(b.existingVendor) banners.push(el("p", { class: "banner ok", text: "This vendor is already on iTred; publishing updates their details and adds these products." }));

  const vendorCard = el("div", { class: "card", id: "vendorCard" },
    el("h2", { text: "Vendor" }),
    el("dl", {},
      el("dt", { text: "Business" }), el("dd", { text: v.business_name || "—" }),
      el("dt", { text: "Install ID" }), el("dd", {}, el("code", { text: v.install_id || "—" }), " ",
        b.registeredDevice ? el("span", { class: "tag ok", text: "registered device" }) : el("span", { class: "tag bad", text: "not registered" })),
      el("dt", { text: "WhatsApp" }), el("dd", { text: v.whatsapp_number || "—" }),
      el("dt", { text: "City" }), el("dd", { text: v.city || "—" }),
      el("dt", { text: "File" }), el("dd", { text: [b.fileName, b.exportNo, when(b.exportedAt)].filter(Boolean).join(" · ") })));

  const rows = b.items.map(it => {
    const blocked = it.problems.length > 0;
    const box = el("input", { type: "checkbox", class: "include", "data-index": String(it.index), "aria-label": "Publish " + (it.name || "item " + (it.index + 1)),
      checked: !excluded.has(it.index), disabled: blocked || !b.canPublish || !!b.result });
    box.addEventListener("change", ()=>{ box.checked ? excluded.delete(it.index) : excluded.add(it.index); tr.classList.toggle("excluded", !box.checked); updateCount(); });
    const photo = it.hasImage ? el("img", { class: "thumb", src: `/api/batches/${b.id}/images/${it.index}`, alt: it.name || "" }) : el("div", { class: "nophoto", text: "no photo" });
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
    count.textContent = b.canPublish ? `${n} of ${b.items.length} products will be published` : "Publishing is blocked for this file";
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
        el("span", { class: g.live ? "tag ok" : "tag warn", text: `${g.live} live` })),
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

// ---------------- start ----------------
api("/api/session").then(s => s.signedIn ? show("upload") : showLogin()).catch(()=> showLogin());
