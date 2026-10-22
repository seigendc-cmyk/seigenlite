// node test/console-6a.test.js [<console folder>]
//
// Batch 6A Part 1 in the Console (repo D:\SCL Console, default), on the page
// as tools/console/build-console.js builds it for sclconsole-preview
// (scrambled and protected), in JSDOM with a fake Supabase client (no
// network, never the live database):
//   * the page still works scrambled: sign in, the dashboard, pages;
//   * content protection (decision 9) is in its head, once; the source page
//     has none (its own tests and file:// copies are unaffected);
//   * "Contact directory" (decision 10): in the menu only for a SysAdmin or
//     staff with "Manage contact directory"; it lists desks and numbers,
//     saves a change with exactly what was typed, adds a desk and a number;
//     a server refusal is shown; before seiGEN has it, it says so;
//   * Copy chips: install IDs and phone numbers copy (no text selection).
// Skips when the Console folder isn't there.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { buildConsole } = require("../tools/console/build-console.js");
const { PROTECT_MARK } = require("../build.js");

const DIR = path.resolve(process.argv[2] || "D:/SCL Console");
const SRC = path.join(DIR, "index.html");
if(!fs.existsSync(SRC)){ console.log("No Console at " + DIR + " — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }
const SOURCE = fs.readFileSync(SRC, "utf8");
const BUILT = buildConsole(SRC);

let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}
const tick = ()=> new Promise((r)=> setTimeout(r, 15));
async function until(cond, what){ for(let i = 0; i < 300; i++){ if(cond()) return; await tick(); } throw new Error("timed out: " + what); }
const J = (x)=> JSON.stringify(x);

// A stand-in for supabase-js: from(table)... resolves to that table's rows, rpc(fn) to its handler.
function fakeSupabase(world){
  function chain(table){
    const p = new Proxy({}, { get(_, k){
      if(k === "then") return (res, rej)=> Promise.resolve({ data: (world.tables[table] || []).slice(), error: null }).then(res, rej);
      return ()=> p;
    } });
    return p;
  }
  return { createClient(){ return {
    from(t){ world.log.push("from " + t); return chain(t); },
    rpc(fn, args){ world.log.push({ fn, args }); const h = world.rpc[fn];
      return Promise.resolve(h ? h(args) : { data: null, error: { code: "PGRST202", message: "Could not find the function public." + fn } }); },
    auth: { getSession: ()=> Promise.resolve({ data: { session: null } }) },
  }; } };
}
function contactsWorld(){
  const desks = [
    { id: "d1", name: "Queries Desk", sort_order: 10, active: true, numbers: [{ id: "n1", label: "Main line", phone: "+263774479121", call: true, whatsapp: true, sort_order: 10, active: true }] },
    { id: "d2", name: "Sales", sort_order: 20, active: false, numbers: [{ id: "n2", label: "Main line", phone: "+263789487287", call: true, whatsapp: false, sort_order: 10, active: true }] },
  ];
  return {
    log: [], tables: {
      cl_vendors: [{ id: "v1", business_name: "TEST Shop", owner_name: "Tendai", install_id: "AB12", phone: "+263771112222", status: "active" }],
      cl_rpn: [{ id: "r1", full_name: "Rudo", phone: "+263773334444", city: "Harare", active: true, verification_used: true }],
    },
    rpc: {
      cl_login: ()=> ({ data: { token: "tok", user_type: "staff", id: "s1", full_name: "Lovemore", is_sysadmin: true }, error: null }),
      cl_contact_directory_all: ()=> ({ data: JSON.parse(J(desks)), error: null }),
      cl_contact_desk_save: (a)=> a.p_name === "Bad" ? { data: null, error: { message: 'There is already a desk called "Bad"' } } : { data: { ok: true, id: "dx" }, error: null },
      cl_contact_number_save: ()=> ({ data: { ok: true, id: "nx" }, error: null }),
    },
  };
}
async function openConsole(html, world, staff){
  const dom = new JSDOM(html, { url: "https://sclconsole-preview.seigendc.workers.dev/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w){ w.supabase = fakeSupabase(world); w.console.log = ()=>{}; } });
  const w = dom.window, d = w.document;
  if(staff) world.rpc.cl_login = ()=> ({ data: staff, error: null });
  await until(()=> d.getElementById("loginForm"), "the sign-in form");
  d.getElementById("ln_name").value = "Lovemore"; d.getElementById("ln_pass").value = "pass-1234";
  d.getElementById("loginForm").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await until(()=> d.querySelector(".sidebar"), "signed in");
  return { w, d };
}
const nav = (d, view)=> d.querySelector('.nav-item[data-view="' + view + '"]');

(async ()=>{
  await t("the built page: protection once in the head, the script scrambled; the source page has neither", async ()=>{
    assert.strictEqual(BUILT.split(PROTECT_MARK).length - 1, 1);
    assert.ok(BUILT.indexOf(PROTECT_MARK) < BUILT.indexOf("</head>"));
    assert.ok(!SOURCE.includes(PROTECT_MARK), "the source stays as it is");
    assert.ok(SOURCE.includes("function cdDeskCard(d){") && !BUILT.includes("function cdDeskCard(d){"), "scrambled");
  });

  await t("scrambled, it still signs in and draws the dashboard; protection works there (no menu, F12 / Ctrl+U blocked)", async ()=>{
    const world = contactsWorld();
    const { w, d } = await openConsole(BUILT, world);
    assert.ok(d.getElementById("viewTitle") && /Dashboard/.test(d.getElementById("viewTitle").textContent));
    const ev = (el, e)=>{ el.dispatchEvent(e); return e.defaultPrevented; };
    assert.strictEqual(ev(d.querySelector(".sidebar"), new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true })), true);
    assert.strictEqual(ev(d.body, new w.KeyboardEvent("keydown", { key: "F12", code: "F12", bubbles: true, cancelable: true })), true);
    assert.strictEqual(ev(d.body, new w.KeyboardEvent("keydown", { key: "u", code: "KeyU", ctrlKey: true, bubbles: true, cancelable: true })), true);
  });

  await t("Contact directory: in the menu for a SysAdmin; desks and numbers listed, an inactive desk marked", async ()=>{
    const world = contactsWorld();
    const { d } = await openConsole(BUILT, world);
    assert.ok(nav(d, "contact_directory"), "menu item");
    nav(d, "contact_directory").click();
    await until(()=> d.querySelector('[data-cddesk="d1"]'), "the desks");
    assert.strictEqual(d.querySelector('[data-cdd-name="d1"]').value, "Queries Desk");
    assert.strictEqual(d.querySelector('[data-cdn-phone="n1"]').value, "+263774479121");
    assert.strictEqual(d.querySelector('[data-cdn-wa="n2"]').checked, false);
    assert.match(d.querySelector('[data-cddesk="d2"]').textContent, /Off: not shown on iTred/);
    assert.ok(d.querySelector('[data-cddesk="new"]') && d.querySelector('[data-cdn-save="new:d1"]'), "add a desk / add a number rows");
  });

  await t("saving a number sends exactly what was typed; adding a desk and a number; a refusal is shown", async ()=>{
    const world = contactsWorld();
    const { d } = await openConsole(BUILT, world);
    nav(d, "contact_directory").click();
    await until(()=> d.querySelector('[data-cdn-save="n1"]'), "the desks");
    d.querySelector('[data-cdn-phone="n1"]').value = "+263 77 447 9999";
    d.querySelector('[data-cdn-call="n1"]').checked = false;
    d.querySelector('[data-cdn-order="n1"]').value = "5";
    d.querySelector('[data-cdn-save="n1"]').click();
    await until(()=> world.log.some((x)=> x.fn === "cl_contact_number_save"), "the save");
    assert.deepStrictEqual(JSON.parse(J(world.log.find((x)=> x.fn === "cl_contact_number_save").args)),
      { p_number_id: "n1", p_desk_id: "d1", p_label: "Main line", p_phone: "+263 77 447 9999", p_call: false, p_whatsapp: true, p_sort_order: 5, p_active: true });
    await until(()=> world.log.filter((x)=> x.fn === "cl_contact_directory_all").length === 2, "reloaded after the save");
    await until(()=> d.querySelector('[data-cdd-save="new"]'), "redrawn");
    d.querySelector('[data-cdd-name="new"]').value = "Billing"; d.querySelector('[data-cdd-order="new"]').value = "40";
    d.querySelector('[data-cdd-save="new"]').click();
    await until(()=> world.log.some((x)=> x.fn === "cl_contact_desk_save"), "the desk save");
    assert.deepStrictEqual(JSON.parse(J(world.log.find((x)=> x.fn === "cl_contact_desk_save").args)), { p_desk_id: null, p_name: "Billing", p_sort_order: 40, p_active: true });
    await until(()=> world.log.filter((x)=> x.fn === "cl_contact_directory_all").length === 3 && d.querySelector('[data-cdn-save="new:d2"]'), "redrawn");
    d.querySelector('[data-cdn-label="new:d2"]').value = "WhatsApp only"; d.querySelector('[data-cdn-phone="new:d2"]').value = "+263719990000";
    d.querySelector('[data-cdn-call="new:d2"]').checked = false;
    d.querySelector('[data-cdn-save="new:d2"]').click();
    await until(()=> world.log.filter((x)=> x.fn === "cl_contact_number_save").length === 2, "the new number");
    assert.deepStrictEqual(JSON.parse(J(world.log.filter((x)=> x.fn === "cl_contact_number_save")[1].args)),
      { p_number_id: null, p_desk_id: "d2", p_label: "WhatsApp only", p_phone: "+263719990000", p_call: false, p_whatsapp: true, p_sort_order: 10, p_active: true });
    await until(()=> world.log.filter((x)=> x.fn === "cl_contact_directory_all").length === 4 && d.querySelector('[data-cdd-save="new"]'), "redrawn");
    d.querySelector('[data-cdd-name="new"]').value = "Bad";
    d.querySelector('[data-cdd-save="new"]').click();
    await until(()=> /already a desk called "Bad"/.test(d.body.textContent), "the refusal");
  });

  await t("staff without \"Manage contact directory\": no menu item; with it: there", async ()=>{
    const staff = { token: "tok", user_type: "staff", id: "s2", full_name: "Amanda", is_sysadmin: false };
    let world = contactsWorld(); world.tables.cl_staff_module_access = [{ module_id: "m1", cl_modules: { key: "vendors" } }];
    let { d } = await openConsole(BUILT, world, staff);
    assert.ok(!nav(d, "contact_directory"), "no menu item without the right");
    world = contactsWorld(); world.tables.cl_staff_module_access = [{ module_id: "m2", cl_modules: { key: "contact_directory" } }];
    ({ d } = await openConsole(BUILT, world, staff));
    assert.ok(nav(d, "contact_directory"), "with the right");
  });

  await t("before seiGEN has the directory: it says which update is missing", async ()=>{
    const world = contactsWorld(); delete world.rpc.cl_contact_directory_all;
    const { d } = await openConsole(BUILT, world);
    nav(d, "contact_directory").click();
    await until(()=> /isn't on this server yet \(database migration 20261111120000\)/.test(d.getElementById("content").textContent), "the message");
  });

  await t("Copy chips: an install ID and an RPN's phone copy", async ()=>{
    const world = contactsWorld();
    const { w, d } = await openConsole(BUILT, world);
    let copied = []; w.document.execCommand = ()=>{ const ta = w.document.body.lastElementChild; copied.push(ta && ta.value); return true; };
    nav(d, "vendors").click();
    await until(()=> d.querySelector('[data-copy="AB12"]'), "the vendor's install ID chip");
    d.querySelector('[data-copy="AB12"]').click();
    await until(()=> copied.includes("AB12"), "copied");
    nav(d, "rpn_directory").click();
    await until(()=> d.querySelector('[data-copy="+263773334444"]'), "the RPN's phone chip");
    d.querySelector('[data-copy="+263773334444"]').click();
    await until(()=> copied.includes("+263773334444"), "copied");
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
