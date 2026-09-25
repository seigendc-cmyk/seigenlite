// A stand-in for the iTred Supabase project, for the browser tests of
// src/itred/index.html. It answers the real supabase-js requests the site
// makes (Auth: signup / password + pkce token / user (get, update) /
// logout / resend / recover;
// REST: vendor_listings, customers, purchase_orders, purchase_order_items)
// at the network level via Playwright's page.route, so the site runs
// unmodified against it. It mirrors the rules that matter to the site —
// email confirmation required, customers rows only for the signed-in user,
// published + unexpired listings only for anyone, orders and their lines
// only for their customer, lines only on a 'sent' order from a live listing
// of that order's vendor (with the listing's name/price snapshotted), only
// the granted columns written, customer-recorded quantity_fulfilled within
// 0..quantity_requested with the order's status following its lines
// — without creating real accounts or sending
// real email. The real
// RLS itself is covered against the live database by
// supabase/tests/itred-live-test.js.
"use strict";
const crypto = require("crypto");

const PROJECT = "https://urbopdsubwawtybwrxjd.supabase.co";

function createFakeSupabase(opts){
  opts = opts || {};
  const state = {
    requireConfirmation: opts.requireConfirmation !== false,
    users: new Map(),       // email -> { id, email, password, confirmed, user_metadata }
    tokens: new Map(),      // access token -> user id
    codes: new Map(),       // pkce auth code -> user id
    customers: new Map(),   // id -> row
    listings: opts.listings || [],
    log: [],                // every request: { method, path, query, body, auth }
    unexpected: [],         // anything this fake doesn't implement
  };
  state.orders = [];  // purchase_orders rows
  state.items = [];   // purchase_order_items rows
  const userById = (id)=> [...state.users.values()].find(u=>u.id===id);
  // The fake has no vendors table: a vendor is whatever its listings embed.
  const vendorById = (id)=>{ const l = state.listings.find(x=> x.vendor_id===id); return l && l.vendors; };
  const publicUser = (u)=>({ id:u.id, aud:"authenticated", role:"authenticated", email:u.email,
    email_confirmed_at: u.confirmed? new Date().toISOString() : null, user_metadata:u.user_metadata||{},
    app_metadata:{ provider:"email", providers:["email"] }, identities:[{ id:u.id, provider:"email" }],
    created_at:new Date().toISOString() });
  function issueSession(u){
    const access_token = "tok-"+crypto.randomBytes(8).toString("hex");
    state.tokens.set(access_token, u.id);
    return { access_token, token_type:"bearer", expires_in:3600, expires_at:Math.floor(Date.now()/1000)+3600,
      refresh_token:"ref-"+crypto.randomBytes(8).toString("hex"), user:publicUser(u) };
  }
  // Test helpers
  state.addUser = (email, password, o)=>{
    const u = { id:crypto.randomUUID(), email, password, confirmed:!!(o&&o.confirmed), user_metadata:(o&&o.user_metadata)||{} };
    state.users.set(email.toLowerCase(), u); return u;
  };
  state.confirm = (email)=>{ const u = state.users.get(email.toLowerCase()); u.confirmed = true; return u; };
  state.issueCode = (email)=>{ const u = state.users.get(email.toLowerCase()); const code = "code-"+crypto.randomBytes(6).toString("hex"); state.codes.set(code, u.id); return code; };
  // The itred_po_sync_status trigger: an order's status follows its lines.
  function syncOrderStatus(orderId){
    const o = state.orders.find(x=> x.id===orderId);
    if(!o || o.status==="closed") return;
    const lines = state.items.filter(i=> i.purchase_order_id===orderId);
    o.status = lines.length && lines.every(i=> i.quantity_fulfilled >= i.quantity_requested)? "fulfilled"
      : lines.some(i=> i.quantity_fulfilled > 0)? "partially_fulfilled" : "sent";
  }
  state.requests = (pathPrefix, method)=> state.log.filter(r=> r.path.startsWith(pathPrefix) && (!method || r.method===method));

  async function handle(route){
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const cors = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"*", "Access-Control-Allow-Methods":"GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Expose-Headers":"*" };
    const send = (status, body, extra)=> route.fulfill({ status, headers:Object.assign({ "Content-Type":"application/json" }, cors, extra||{}), body: body===undefined? "" : JSON.stringify(body) });
    if(method==="OPTIONS") return route.fulfill({ status:204, headers:cors });
    let body = null;
    try{ body = req.postData()? JSON.parse(req.postData()) : null; }catch(e){ body = req.postData(); }
    const bearer = (req.headers()["authorization"]||"").replace(/^Bearer /i,"");
    const userId = state.tokens.get(bearer) || null;
    const entry = { method, path:url.pathname, query:url.search, body, auth: userId? "user" : "anon" };
    state.log.push(entry);
    const q = url.searchParams;
    const wantsObject = /vnd\.pgrst\.object/.test(req.headers()["accept"]||"");
    const authErr = (status, code, msg)=> send(status, { code, error_code:code, msg, message:msg });

    // ---------------- Auth ----------------
    if(url.pathname==="/auth/v1/signup" && method==="POST"){
      const email = String(body.email||"").toLowerCase();
      entry.redirectTo = q.get("redirect_to");
      if(state.failNextSignup){ const f = state.failNextSignup; state.failNextSignup = null; return authErr(f.status, f.code, f.msg); }
      if(String(body.password||"").length < 6) return authErr(422, "weak_password", "Password should be at least 6 characters.");
      let u = state.users.get(email);
      if(!u) u = state.addUser(email, body.password, { user_metadata: body.data||{}, confirmed: !state.requireConfirmation });
      if(!state.requireConfirmation) return send(200, issueSession(u));
      return send(200, Object.assign(publicUser(u), { confirmation_sent_at:new Date().toISOString() }));
    }
    if(url.pathname==="/auth/v1/token" && method==="POST"){
      const grant = q.get("grant_type");
      if(grant==="password"){
        const u = state.users.get(String(body.email||"").toLowerCase());
        if(!u || u.password!==body.password) return authErr(400, "invalid_credentials", "Invalid login credentials");
        if(!u.confirmed) return authErr(400, "email_not_confirmed", "Email not confirmed");
        return send(200, issueSession(u));
      }
      if(grant==="pkce"){
        const id = state.codes.get(body.auth_code);
        if(!id || !body.code_verifier) return authErr(400, "bad_code_verifier", "invalid flow state, no valid flow state found");
        state.codes.delete(body.auth_code);
        return send(200, issueSession(userById(id)));
      }
    }
    if(url.pathname==="/auth/v1/user" && method==="GET"){
      if(!userId) return authErr(401, "bad_jwt", "invalid JWT");
      return send(200, publicUser(userById(userId)));
    }
    if(url.pathname==="/auth/v1/logout" && method==="POST"){
      state.tokens.delete(bearer);
      return route.fulfill({ status:204, headers:cors });
    }
    if(url.pathname==="/auth/v1/resend" && method==="POST"){
      entry.redirectTo = q.get("redirect_to");
      return send(200, {});
    }
    // Password reset email. Like the real one, answers the same whether or
    // not the email has an account.
    if(url.pathname==="/auth/v1/recover" && method==="POST"){
      entry.redirectTo = q.get("redirect_to");
      return send(200, {});
    }
    // Set a new password (signed in, e.g. via the reset link's session).
    if(url.pathname==="/auth/v1/user" && method==="PUT"){
      if(!userId) return authErr(401, "bad_jwt", "invalid JWT");
      const u = userById(userId);
      if(body.password!==undefined){
        if(String(body.password).length < 6) return authErr(422, "weak_password", "Password should be at least 6 characters.");
        if(body.password===u.password) return authErr(422, "same_password", "New password should be different from the old password.");
        u.password = body.password;
      }
      return send(200, publicUser(u));
    }

    // ---------------- REST ----------------
    if(url.pathname==="/rest/v1/vendor_listings" && method==="GET"){
      // anyone: published and not expired (the RLS policy)
      const rows = state.listings.filter(l=> l.status==="published" && new Date(l.expires_at) > new Date())
        .map(({ status, ...rest })=> rest);
      return send(200, rows);
    }
    if(url.pathname==="/rest/v1/customers"){
      if(!userId) return send(401, { code:"42501", message:"permission denied for table customers" });
      const user = userById(userId);
      const idEq = (q.get("id")||"").replace(/^eq\./,"");
      if(method==="GET"){
        const rows = [...state.customers.values()].filter(r=> r.id===userId && (!idEq || r.id===idEq));
        if(wantsObject){
          if(rows.length!==1) return send(406, { code:"PGRST116", message:"JSON object requested, multiple (or no) rows returned" });
          return send(200, rows[0]);
        }
        return send(200, rows);
      }
      if(method==="POST"){
        const row = Array.isArray(body)? body[0] : body;
        if(row.id!==userId || String(row.email||"").toLowerCase()!==user.email.toLowerCase())
          return send(403, { code:"42501", message:"new row violates row-level security policy for table \"customers\"" });
        if(state.customers.has(row.id)) return send(409, { code:"23505", message:"duplicate key value violates unique constraint \"customers_pkey\"" });
        const stored = { id:row.id, email:row.email, full_name:row.full_name??null, phone:row.phone??null, created_at:new Date().toISOString() };
        state.customers.set(row.id, stored);
        return send(201, wantsObject? stored : [stored]);
      }
      if(method==="PATCH"){
        const r = state.customers.get(idEq);
        if(!r || idEq!==userId) return wantsObject? send(406, { code:"PGRST116", message:"no rows" }) : send(200, []);
        for(const k of Object.keys(body)){
          if(!["full_name","phone"].includes(k)) return send(401, { code:"42501", message:"permission denied for table customers" });
          r[k] = body[k];
        }
        return send(200, wantsObject? r : [r]);
      }
    }
    // purchase_orders / purchase_order_items: the migration's column grants,
    // RLS policies and listing-snapshot trigger, as the site meets them.
    const denied = (table)=> send(401, { code:"42501", message:"permission denied for table "+table });
    const rlsFail = (table)=> send(403, { code:"42501", message:"new row violates row-level security policy for table \""+table+"\"" });
    const onlyCols = (row, allowed)=> Object.keys(row).every(k=> allowed.includes(k));
    const eqParam = (name)=> (q.get(name)||"").replace(/^eq\./,"");
    if(url.pathname==="/rest/v1/purchase_orders"){
      if(!userId) return denied("purchase_orders");
      if(method==="POST"){
        const row = Array.isArray(body)? body[0] : body;
        if(!onlyCols(row, ["customer_id","vendor_id"])) return denied("purchase_orders");
        if(state.failNextOrderInsert){ const f = state.failNextOrderInsert; state.failNextOrderInsert = null; return send(f.status, f.body); }
        if(row.customer_id!==userId) return rlsFail("purchase_orders");
        if(!state.customers.has(row.customer_id)) return send(409, { code:"23503", message:"insert or update on table \"purchase_orders\" violates foreign key constraint \"purchase_orders_customer_id_fkey\"" });
        if(!vendorById(row.vendor_id)) return send(409, { code:"23503", message:"insert or update on table \"purchase_orders\" violates foreign key constraint \"purchase_orders_vendor_id_fkey\"" });
        const stored = { id:crypto.randomUUID(), customer_id:row.customer_id, vendor_id:row.vendor_id, status:"sent", pdf_url:null,
          created_at:new Date(Date.now() + state.orders.length).toISOString() };
        state.orders.push(stored);
        return send(201, wantsObject? stored : [stored]);
      }
      if(method==="PATCH"){
        if(!onlyCols(body, ["status"])) return denied("purchase_orders");
        const hits = state.orders.filter(o=> o.id===eqParam("id") && o.customer_id===userId);
        if(hits.length && body.status!=="closed") return rlsFail("purchase_orders");
        hits.forEach(o=> o.status = body.status);
        return send(200, hits);
      }
      if(method==="GET"){
        const select = q.get("select")||"";
        const cust = eqParam("customer_id");
        const rows = state.orders.filter(o=> o.customer_id===userId && (!cust || o.customer_id===cust))
          .sort((a,b)=> b.created_at.localeCompare(a.created_at))
          .map(o=>{
            const r = Object.assign({}, o);
            if(/vendors\(/.test(select)){ const v = vendorById(o.vendor_id); r.vendors = v? { business_name:v.business_name, whatsapp_number:v.whatsapp_number, city:v.city } : null; }
            if(/purchase_order_items\(/.test(select)) r.purchase_order_items = state.items.filter(i=> i.purchase_order_id===o.id);
            return r;
          });
        return send(200, rows);
      }
    }
    if(url.pathname==="/rest/v1/purchase_order_items"){
      if(!userId) return denied("purchase_order_items");
      if(method==="POST"){
        const rows = Array.isArray(body)? body : [body];
        const allowed = ["purchase_order_id","vendor_listing_id","item_name","quantity_requested","is_custom_request"];
        if(!rows.every(r=> onlyCols(r, allowed))) return denied("purchase_order_items");
        if(state.failNextItemsInsert){ const f = state.failNextItemsInsert; state.failNextItemsInsert = null; return send(f.status, f.body); }
        // One statement: every row is checked before any is stored.
        const out = [];
        for(const r of rows){
          const custom = !!r.is_custom_request;
          if(custom !== (r.vendor_listing_id==null))
            return send(400, { code:"23514", message:"new row for relation \"purchase_order_items\" violates check constraint \"purchase_order_items_custom_xor_listing\"" });
          if(!(Number(r.quantity_requested) > 0) || !String(r.item_name||"").trim())
            return send(400, { code:"23514", message:"new row for relation \"purchase_order_items\" violates check constraint" });
          let snap = { item_name:r.item_name, unit_price:null, currency:null };
          if(!custom){
            // the snapshot trigger runs as the customer, so it only sees live listings
            const l = state.listings.find(x=> x.id===r.vendor_listing_id && x.status==="published" && new Date(x.expires_at) > new Date());
            if(!l) return send(400, { code:"P0001", message:"vendor_listing "+r.vendor_listing_id+" not found or not published" });
            snap = { item_name:l.product_name, unit_price:l.price, currency:l.currency };
          }
          const po = state.orders.find(o=> o.id===r.purchase_order_id && o.customer_id===userId && o.status==="sent");
          if(!po) return rlsFail("purchase_order_items");
          if(!custom && state.listings.find(x=> x.id===r.vendor_listing_id).vendor_id!==po.vendor_id) return rlsFail("purchase_order_items");
          out.push({ id:crypto.randomUUID(), purchase_order_id:r.purchase_order_id, vendor_listing_id:custom? null : r.vendor_listing_id,
            item_name:snap.item_name, unit_price:snap.unit_price, currency:snap.currency, quantity_requested:Number(r.quantity_requested),
            quantity_fulfilled:0, is_custom_request:custom, fulfillment_status:"outstanding", created_at:new Date().toISOString() });
        }
        state.items.push(...out);
        return send(201, out);
      }
      if(method==="GET"){
        const mine = new Set(state.orders.filter(o=> o.customer_id===userId).map(o=>o.id));
        return send(200, state.items.filter(i=> mine.has(i.purchase_order_id)));
      }
      // Customer-recorded fulfilment (20260925120000_itred_po_fulfilment.sql):
      // quantity_fulfilled only, own orders only, 0..quantity_requested, and
      // the order's status re-derived from its lines unless it's closed.
      if(method==="PATCH"){
        if(!onlyCols(body, ["quantity_fulfilled"])) return denied("purchase_order_items");
        const mine = new Set(state.orders.filter(o=> o.customer_id===userId).map(o=>o.id));
        const hits = state.items.filter(i=> mine.has(i.purchase_order_id)
          && (!q.get("id") || i.id===eqParam("id"))
          && (!q.get("purchase_order_id") || i.purchase_order_id===eqParam("purchase_order_id")));
        const qf = Number(body.quantity_fulfilled);
        if(hits.length && !(qf >= 0)) return send(400, { code:"23514", message:"new row for relation \"purchase_order_items\" violates check constraint \"purchase_order_items_quantity_fulfilled_check\"" });
        if(hits.some(i=> qf > i.quantity_requested)) return send(400, { code:"23514", message:"new row for relation \"purchase_order_items\" violates check constraint \"purchase_order_items_not_overfulfilled\"" });
        hits.forEach(i=>{
          i.quantity_fulfilled = qf;
          i.fulfillment_status = qf===0? "outstanding" : qf>=i.quantity_requested? "fulfilled" : "partially_fulfilled";
        });
        new Set(hits.map(i=> i.purchase_order_id)).forEach(syncOrderStatus);
        return send(200, hits);
      }
    }

    state.unexpected.push(method+" "+url.pathname+url.search);
    return send(404, { code:"PGRST205", message:"not in the fake" });
  }

  state.install = async (page)=>{ await page.route(PROJECT+"/**", handle); };
  state.__handle = handle; // for tests that route the project themselves
  return state;
}

// A listing row as PostgREST returns it for the site's select (vendor embedded).
function listingRow(o){
  const now = Date.now();
  return Object.assign({
    id: crypto.randomUUID(), vendor_id: crypto.randomUUID(), product_name:"Product", price:1, currency:"USD", category:null, stock_quantity:1,
    image_url:null, published_at:new Date(now - 86400000).toISOString(), expires_at:new Date(now + 6*86400000).toISOString(),
    status:"published", vendors:{ business_name:"Vendor", whatsapp_number:null, city:null },
  }, o||{});
}

module.exports = { createFakeSupabase, listingRow, PROJECT };
