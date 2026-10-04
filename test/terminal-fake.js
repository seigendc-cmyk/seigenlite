// Playwright fake of Digital Commerce's multi-terminal RPCs, so browser
// tests never reach the live project. Same idea as test/dc-fake.js (which it
// replaces for suites that need registration): it answers
// cl_device_checkin, cl_branch_register, cl_branch_issue_join_code,
// cl_terminal_join and cl_branch_list from in-memory state that mirrors the
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
        cycle_start_date:null, messages:[], business_id: v.business, terminal_id: t? t.id : null };
    },
    cl_branch_register(b){
      vendor(b, true);
      const have = state.terminals.find(x=>x.install===b.p_install_id);
      if(have) return termJson(have);
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
      let br = b.p_branch_id? state.branches.find(x=>x.id===b.p_branch_id)
        : state.branches.find(x=>x.business===me.business && key(x.name)===key(b.p_new_branch_name));
      if(!br){ br = { id:id("br"), business:me.business, name:b.p_new_branch_name, is_main:false }; state.branches.push(br); }
      const code = "TEST" + String(1000 + state.codes.length).slice(-4).replace(/[01]/g,"7");
      state.codes.push({ code, branch:br.id, used:false });
      return { code: code.slice(0,4)+"-"+code.slice(4), branch_id:br.id, branch_name:br.name, expires_ts:new Date(Date.now()+86400000).toISOString() };
    },
    cl_terminal_join(b){
      const c = state.codes.find(x=>x.code===String(b.p_join_code||"").toUpperCase().replace(/[^A-Z0-9]/g,""));
      if(!c) return { error:"JOIN_CODE_INVALID" };
      const br = state.branches.find(x=>x.id===c.branch), bz = state.businesses.find(x=>x.id===br.business);
      if(norm(b.p_secret_phrase)!==bz.phrase) return { error:"PHRASE_MISMATCH" };
      const have = state.terminals.find(x=>x.install===b.p_install_id);
      if(have) return have.branch===br.id? termJson(have) : { error:"ALREADY_JOINED" };
      if(c.used) return { error:"JOIN_CODE_USED" };
      if(b.p_expected_branch_name && key(b.p_expected_branch_name)!==key(br.name)) return { error:"BRANCH_NAME_MISMATCH", branch_name:br.name };
      const v = vendor({ p_install_id:b.p_install_id, p_secret_phrase:b.p_device_phrase||b.p_secret_phrase, p_device_key:b.p_device_key }, true);
      const t = { id:id("term"), business:bz.id, branch:br.id, install:b.p_install_id, till:nextTill(br.id), label:b.p_label||null };
      state.terminals.push(t); c.used = true; v.business = bz.id;
      return termJson(t);
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
          .map(t=>({ id:t.id, till_code:t.till, label:t.label, active:true, registered_ts:new Date().toISOString(), last_seen_ts:null })) : null })) };
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

function newTerminalState(){ return { businesses:[], branches:[], terminals:[], codes:[], vendors:{}, seq:0 }; }
module.exports = { stubTerminals, newTerminalState };
