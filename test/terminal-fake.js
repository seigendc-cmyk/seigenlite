// Playwright fake of Digital Commerce's multi-terminal RPCs, so browser
// tests never reach the live project. Same idea as test/dc-fake.js (which it
// replaces for suites that need registration): it answers
// cl_device_checkin, cl_branch_register, cl_branch_issue_join_code,
// cl_terminal_join, cl_terminal_admin_set (v21) and cl_branch_list from in-memory state that mirrors the
// migration's rules closely enough for the UI (join codes are single-use;
// phrase compared upper(trim()); branch names compared letters/digits only;
// only main-branch tills issue codes).
//
// stubTerminals(target, opts) — target is a Page or BrowserContext.
//   opts.offline — () => boolean: true makes every call fail as unreachable
// Returns { calls, state } — calls: [{ name, body }].
"use strict";
const DC_HOST = /urbopdsubwawtybwrxjd\.supabase\.co/;
const norm = (p)=> String(p||"").trim().toUpperCase();
const key = (n)=> String(n||"").replace(/[^A-Za-z0-9]/g,"").toLowerCase();

async function stubTerminals(target, opts){
  opts = opts || {};
  const calls = [];
  // opts.state: pass the same object to several contexts (separate devices) so they share one "server".
  const state = opts.state || newTerminalState();
  const id = (p)=> p+"-"+(++state.seq);
  const vendor = (b, create)=>{
    let v = state.vendors[b.p_install_id];
    if(!v){ if(!create) throw err("This device is not registered yet"); v = state.vendors[b.p_install_id] = { phrase:b.p_secret_phrase, key:b.p_device_key||null, business:null }; }
    return v;
  };
  const err = (message)=> Object.assign(new Error(message), { rpc:true });
  const termJson = (t)=>{ const br = state.branches.find(x=>x.id===t.branch); const bz = state.businesses.find(x=>x.id===t.business);
    return { business_id:bz.id, business_name:bz.name, branch_id:br.id, branch_name:br.name, is_main:br.is_main, terminal_id:t.id, till_code:t.till, label:t.label }; };
  const nextTill = (branch)=> "T"+(state.terminals.filter(t=>t.branch===branch).length+1);
  const handlers = {
    cl_device_checkin(b){
      const v = vendor({ p_install_id:b.p_install_id, p_secret_phrase:b.p_shop_secret_phrase, p_device_key:b.p_device_key }, true);
      if(norm(v.phrase)!==norm(b.p_shop_secret_phrase)) throw err("Shop secret phrase does not match this install");
      const t = state.terminals.find(x=>x.install===b.p_install_id);
      return { vendor_id:"v-"+b.p_install_id, status:"onboarding", lock_cart:false, lock_add_product:false, lock_reason:null,
        cycle_start_date:null, messages:[], business_id: v.business, terminal_id: t? t.id : null,
        terminal_active: t? t.active!==false : null,   // Phase 2
        admin_seed: (()=>{ const sd = t && state.seeds[t.id]; if(!sd || sd.delivered) return null; sd.delivered = true; return sd.seed; })() };   // v21 (20261023120000)
    },
    cl_branch_register(b){
      vendor(b, true);
      const have = state.terminals.find(x=>x.install===b.p_install_id);
      if(have) return have.active===false? { error:"TERMINAL_INACTIVE" } : termJson(have);   // Phase 2
      // Billing-B (20261021120000): one business per name and phrase
      const dup = state.businesses.find(x=>!x.archived && key(x.name)===key(b.p_business_name) && x.phrase===norm(b.p_secret_phrase));
      if(dup) return { error:"DUPLICATE_BUSINESS", business_name:dup.name, main_branch:(state.branches.find(x=>x.business===dup.id && x.is_main)||{}).name||null };
      const bz = { id:id("biz"), name:b.p_business_name, phrase:norm(b.p_secret_phrase) }; state.businesses.push(bz);
      const br = { id:id("br"), business:bz.id, name:b.p_branch_name, is_main:true }; state.branches.push(br);
      const t = { id:id("term"), business:bz.id, branch:br.id, install:b.p_install_id, till:"T1", label:b.p_label||null }; state.terminals.push(t);
      state.vendors[b.p_install_id].business = bz.id;
      return termJson(t);
    },
    cl_branch_issue_join_code(b){
      vendor(b, false);
      const me = state.terminals.find(x=>x.install===b.p_install_id);
      const myBranch = me && state.branches.find(x=>x.id===me.branch);
      if(!myBranch || !myBranch.is_main) throw err("Only a main-branch terminal can add terminals");
      // v21 (20261023120000): the code carries the new device's Admin check value
      if(!seedOk(b.p_admin_salt, b.p_admin_check, b.p_admin_rounds)) throw err("UPDATE_MAIN_FIRST: This version of the app is too old to add terminals. Update this app, then try again.");
      let br = b.p_branch_id? state.branches.find(x=>x.id===b.p_branch_id)
        : state.branches.find(x=>x.business===me.business && key(x.name)===key(b.p_new_branch_name));
      if(!br){ br = { id:id("br"), business:me.business, name:b.p_new_branch_name, is_main:false }; state.branches.push(br); }
      const code = "TEST" + String(1000 + state.codes.length).slice(-4).replace(/[01]/g,"7");
      state.codes.push({ code, branch:br.id, used:false, seed:{ salt:b.p_admin_salt, check:b.p_admin_check, rounds:b.p_admin_rounds } });
      return { code: code.slice(0,4)+"-"+code.slice(4), branch_id:br.id, branch_name:br.name, expires_ts:new Date(Date.now()+86400000).toISOString() };
    },
    cl_terminal_join(b){
      const c = state.codes.find(x=>x.code===String(b.p_join_code||"").toUpperCase().replace(/[^A-Z0-9]/g,""));
      if(!c) return { error:"JOIN_CODE_INVALID" };
      const br = state.branches.find(x=>x.id===c.branch), bz = state.businesses.find(x=>x.id===br.business);
      if(norm(b.p_secret_phrase)!==bz.phrase) return { error:"PHRASE_MISMATCH" };
      const have = state.terminals.find(x=>x.install===b.p_install_id);
      if(have && have.active===false) return { error:"TERMINAL_INACTIVE" };   // Phase 2
      if(have) return have.branch===br.id? termJson(have) : { error:"ALREADY_JOINED" };
      if(c.used) return { error:"JOIN_CODE_USED" };
      if(!(Number(b.p_app_build) >= 21)) throw err("APP_UPDATE_NEEDED: Update this app first, then join again. Your join code is still valid.");   // v21
      if(!c.seed) return { error:"ADMIN_SEED_MISSING" };
      if(b.p_expected_branch_name && key(b.p_expected_branch_name)!==key(br.name)) return { error:"BRANCH_NAME_MISMATCH", branch_name:br.name };
      const v = vendor({ p_install_id:b.p_install_id, p_secret_phrase:b.p_device_phrase||b.p_secret_phrase, p_device_key:b.p_device_key }, true);
      const t = { id:id("term"), business:bz.id, branch:br.id, install:b.p_install_id, till:nextTill(br.id), label:b.p_label||null };
      state.terminals.push(t); c.used = true; v.business = bz.id;
      return Object.assign(termJson(t), { admin_seed:c.seed });
    },
    // Phase 2: a main-branch till deactivates/reactivates another till (never itself).
    cl_terminal_set_active(b){
      vendor(b, false);
      const me = state.terminals.find(x=>x.install===b.p_install_id && x.active!==false);
      if(!me || !state.branches.find(x=>x.id===me.branch).is_main) throw err("Only a main-branch terminal can change terminals");
      const t = state.terminals.find(x=>x.id===b.p_terminal_id && x.business===me.business);
      if(!t) throw err("Terminal not found in this business");
      if(t.id===me.id && !b.p_active) throw err("A till cannot deactivate itself");
      t.active = !!b.p_active;
      return Object.assign(termJson(t), { active:t.active });
    },
    // v21 (20261023120000): a main-branch till sets another till's Admin check value; its next check-in carries it once
    cl_terminal_admin_set(b){
      vendor(b, false);
      const me = state.terminals.find(x=>x.install===b.p_install_id && x.active!==false);
      if(!me || !state.branches.find(x=>x.id===me.branch).is_main) throw err("Only a main-branch terminal can set a till's Admin passcode");
      if(!seedOk(b.p_admin_salt, b.p_admin_check, b.p_admin_rounds)) throw err("ADMIN_SEED_INVALID: That Admin passcode check value isn't valid");
      const t = state.terminals.find(x=>x.id===b.p_terminal_id && x.business===me.business);
      if(!t) throw err("Terminal not found in this business");
      if(t.id===me.id) throw err("A till sets its own Admin passcode in Settings");
      state.seeds[t.id] = { seed:{ salt:b.p_admin_salt, check:b.p_admin_check, rounds:b.p_admin_rounds }, delivered:false };
      return Object.assign(termJson(t), { admin_set:true });
    },
    cl_branch_list(b){
      vendor(b, false);
      const me = state.terminals.find(x=>x.install===b.p_install_id);
      if(!me) throw err("This device is not a registered terminal");
      const isMain = state.branches.find(x=>x.id===me.branch).is_main;
      const bz = state.businesses.find(x=>x.id===me.business);
      return { business_id:bz.id, business_name:bz.name, branches: state.branches.filter(x=>x.business===bz.id)
        .sort((a,c)=> (c.is_main-a.is_main) || a.name.localeCompare(c.name))
        .map(x=>({ id:x.id, name:x.name, is_main:x.is_main, terminals: isMain? state.terminals.filter(t=>t.branch===x.id)
          .map(t=>({ id:t.id, till_code:t.till, label:t.label, active:t.active!==false, registered_ts:new Date().toISOString(), last_seen_ts:null })) : null })) };
    },
  };
  await target.route(DC_HOST, async route=>{
    const req = route.request();
    const m = /\/rpc\/([a-z_]+)$/.exec(req.url());
    if(!m || !handlers[m[1]]) return route.abort();          // anything else never reaches the live project
    let body = {}; try{ body = JSON.parse(req.postData() || "{}"); }catch(e){}
    calls.push({ name:m[1], body });
    if(opts.offline && opts.offline()) return route.abort("internetdisconnected");
    try{
      return route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify(handlers[m[1]](body)) });
    }catch(e){
      return route.fulfill({ status:400, contentType:"application/json", body: JSON.stringify({ code:"P0001", message:e.message }) });
    }
  });
  return { calls, state };
}

function newTerminalState(){ return { businesses:[], branches:[], terminals:[], codes:[], vendors:{}, seeds:{}, seq:0 }; }
const seedOk = (salt, check, rounds)=> /^[0-9a-f]{32}$/.test(String(salt||"")) && /^[0-9a-f]{64}$/.test(String(check||"")) && Number(rounds) >= 100000 && Number(rounds) <= 2000000;
// The check value a main till would send for this passcode (PBKDF2-SHA-256, as src/passcode-check.js), for codes a test makes by hand.
function testAdminSeed(passcode){
  const crypto = require("crypto"), salt = crypto.randomBytes(16).toString("hex");
  return { salt, check: crypto.pbkdf2Sync(String(passcode), Buffer.from(salt, "hex"), 150000, 32, "sha256").toString("hex"), rounds:150000 };
}
module.exports = { stubTerminals, newTerminalState, testAdminSeed };
