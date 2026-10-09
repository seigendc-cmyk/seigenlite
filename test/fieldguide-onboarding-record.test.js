// Run: node --no-warnings test/fieldguide-onboarding-record.test.js
// The RPN Field Guide's full vendor onboarding record (src/fieldguide/
// onboarding.js) under plain Node (no browser, no network): the four
// sections' checks, what is sent to cl_rpn_save_onboarding, and the sending
// itself on the in-memory store with a FAKE Console that follows the
// database's rules (supabase/migrations/20261009160000_rpn_onboarding_records.sql):
// drafts, retries, older copies, submit, locked, returned by the office,
// sign-in, another RPN's record.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const FG = path.join(ROOT, "src", "fieldguide");
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}

const RPN_A = "11111111-1111-4111-8111-111111111111";
const RPN_B = "22222222-2222-4222-8222-222222222222";
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims) => b64url({ alg: "HS256", typ: "JWT" }) + "." + b64url(claims) + ".sig";

// The fake Console: cl_login, the save RPC and the own-rows read, with the
// database's rules.
function fakeConsole(clock) {
  const rows = new Map();
  const c = { rows, calls: 0, failNext: 0, network: false, loseAnswer: 0, accounts: { "Tendai Moyo": ["1234", RPN_A, "rpn"], "Rudo Banda": ["5678", RPN_B, "rpn"] } };
  c.fetch = async (url, opts) => {
    const u = new URL(url);
    const reply = (status, body) => ({ status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
    if (c.network) throw new TypeError("Failed to fetch");
    if (u.pathname === "/rest/v1/rpc/cl_login") {
      const { p_name, p_passcode } = JSON.parse(opts.body);
      const acct = c.accounts[p_name];
      if (!acct || acct[0] !== p_passcode) return reply(400, { code: "P0001", message: "Invalid name or passcode" });
      const now = Math.floor(clock.now / 1000);
      return reply(200, { token: jwt({ role: "authenticated", sub: acct[1], user_type: acct[2], full_name: p_name, iat: now, exp: now + 12 * 3600 }), full_name: p_name });
    }
    const auth = (opts.headers.Authorization || "").replace("Bearer ", "");
    const claims = JSON.parse(Buffer.from(auth.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (claims.exp * 1000 <= clock.now) return reply(401, { code: "PGRST301", message: "JWT expired" });
    if (u.pathname === "/rest/v1/rpn_onboarding_records" && opts.method === "GET") {
      return reply(200, [...rows.values()].filter((r) => r.rpn_id === claims.sub).map((r) => ({ id: r.id, status: r.status, office_reason: r.office_reason || null, verified_at: r.verified_at || null })));
    }
    if (u.pathname === "/rest/v1/rpn_onboarding_notes" && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      c.notes = c.notes || new Map();
      c.notes.set(body.id, Object.assign({ rpn_id: claims.sub }, body));
      return reply(201);
    }
    if (u.pathname === "/rest/v1/rpc/cl_rpn_save_onboarding") {
      c.calls++;
      if (c.failNext > 0) { c.failNext--; return reply(503, { message: "Service Unavailable" }); }
      const p = JSON.parse(opts.body);
      if (claims.user_type !== "rpn") return reply(403, { code: "42501", message: "Not authorized" });
      const cur = rows.get(p.p_id);
      const out = (r, result) => reply(200, { id: r.id, status: r.status, result, office_reason: r.office_reason || null, verified_at: r.verified_at || null });
      if (cur) {
        if (cur.rpn_id !== claims.sub) return reply(403, { code: "42501", message: "Not authorized" });
        if (p.p_client_saved_at <= cur.client_saved_at) return out(cur, "unchanged");
        if (!["draft", "returned"].includes(cur.status)) return reply(400, { code: "55000", message: "This onboarding is " + cur.status + " and can no longer be changed" });
      }
      if (!/^\+?[0-9][0-9 ]{6,19}$/.test(p.p_phone)) return reply(400, { code: "23514", message: "violates check constraint rpn_onboarding_records_phone_check" });
      if (p.p_plan === "lite" && p.p_branches > 1) return reply(400, { code: "23514", message: "lite_one_branch" });
      if (p.p_submit) {
        const tr = p.p_sections.training || {};
        if (p.p_plan == null || p.p_branches == null || p.p_tills == null || p.p_subscription_amount == null) return reply(400, { code: "23514", message: "To submit, the plan, branches, tills and monthly amount are needed" });
        if (tr.vendor_confirms !== true || tr.rpn_declares !== true || !tr.vendor_full_name) return reply(400, { code: "23514", message: "To submit, the vendor's acceptance and your declaration are needed" });
      }
      const row = Object.assign({}, cur || { rpn_id: claims.sub, status: "draft" }, { id: p.p_id, client_saved_at: p.p_client_saved_at, params: p });
      if (p.p_submit) row.status = "submitted";
      rows.set(p.p_id, row);
      if (c.loseAnswer > 0) { c.loseAnswer--; throw new TypeError("connection dropped after the save"); }
      return out(row, p.p_submit ? "submitted" : "saved");
    }
    return reply(404, { message: "not found" });
  };
  return c;
}

function load() {
  const clock = { now: new Date(2026, 9, 9, 9, 0, 0).getTime() };
  const fake = fakeConsole(clock);
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock.now])); }
    static now() { return clock.now; }
  }
  const ctx = {
    CONSOLE_URL: "https://console.example", CONSOLE_ANON_KEY: "anon-key",
    fetch: (...a) => fake.fetch(...a), atob: (s) => Buffer.from(s, "base64").toString("binary"),
    navigator: { onLine: true }, crypto: require("crypto").webcrypto, Date: FakeDate, JSON, Math, Promise, Map, Set, Array, Object, String, Number, RegExp, Uint8Array, URL, encodeURIComponent, decodeURIComponent, isNaN, console,
    setTimeout: () => 0, clearTimeout: () => {},
    refreshFieldScreens: () => {}, AbortController,
    state: { tab: "coach", sub: [] }, render: () => {},
  };
  vm.createContext(ctx);
  const code = ["store.js", "console-api.js", "outbox.js", "onboarding.js"].map((f) => fs.readFileSync(path.join(FG, f), "utf8")).join("\n");
  const api = vm.runInContext(code + `
;({ field, ob, storeInit, storeGetAll, fieldInit, obInit, signIn, signOut, kickOutbox, outboxIdle, saveNote, validateNote,
    obCreate, obSetValue, obAddItem, obRemoveItem, obSaveSection, obSubmit, obRetry, obPull, obStatus, obEditable,
    obCheckSection, obAllDone, obSectionProgress, obRpcParams, obCanSendDraft, OB_SECTIONS, OB_MODULES, obFlush })`, ctx);
  return { api, ctx, clock, fake };
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const pass = async (a) => { await a.outboxIdle(); await a.kickOutbox(); await a.outboxIdle(); };

// A record filled in completely (all four sections done).
async function fillAll(a, rec, clock) {
  const set = (sec, p, v) => { clock.now += 1000; a.obSetValue(rec, sec, p, v); };
  const V = { business_name: "Mai Tendai Grocers", owner_name: "T. Mapfumo", phone: "0789 012 231", city: "Harare", plan: "business", branches: "1", tills: "2", features_taken: "Main branch, one extra till", subscription_amount: "18", first_visit_date: "2026-10-02" };
  for (const k of Object.keys(V)) set("vendor", k, V[k]);
  for (const [k, v] of Object.entries({ device_type: "phone", install_type: "pwa", branch: "Main", till: "Till 1", result: "installed" })) set("installation", "devices.0." + k, v);
  for (const [k, v] of Object.entries({ secret_phrase_set: "yes", join_codes_used: "na", activation_requested: "yes", activation_date: "2026-10-08", printer: "bluetooth", test_print: "yes" })) set("installation", k, v);
  for (const [k, v] of Object.entries({ product_source: "excel", products_loaded: "240", stocktake_done: "yes", stocktake_date: "2026-10-08", stocktake_lines: "240", staff_count: "2", single_operator: "no", first_shift_eod: "yes", backup_explained: "yes", debtor_balances: "none" })) set("implementation", k, v);
  for (const [k, v] of Object.entries({ date: "2026-10-08", duration_min: "90", staff_names: "Rudo, Farai" })) set("training", "sessions.0." + k, v);
  set("training", "modules.sell", "confident"); set("training", "modules.shift", "ok");
  for (const [k, v] of Object.entries({ support_contacts_given: "yes", vendor_full_name: "Tendai Mapfumo", vendor_confirms: true, acceptance_date: "2026-10-09", rpn_declares: true })) set("training", k, v);
  await a.obFlush();
}

(async () => {
  // ---------------- the sections' checks ----------------
  {
    const { api, clock } = load();
    const NOW = clock.now;
    await t("four sections, in order: vendor, installation, implementation, training", () => {
      assert.deepStrictEqual(plain(api.OB_SECTIONS.map((s) => s.key)), ["vendor", "installation", "implementation", "training"]);
    });
    await t("an empty section: every required field reported, nothing started", () => {
      const c = api.obCheckSection("vendor", {}, NOW);
      assert.strictEqual(c.complete, false);
      assert.strictEqual(c.started, false);
      assert.deepStrictEqual(Object.keys(plain(c.errors)).sort(), ["branches", "business_name", "city", "features_taken", "first_visit_date", "owner_name", "phone", "plan", "subscription_amount", "tills"]);
    });
    await t("Lite is one branch; tills cover branches; amount is money; dates not in the future", () => {
      const base = { business_name: "X", owner_name: "Y", phone: "0771234567", city: "Harare", plan: "lite", branches: "2", tills: "2", features_taken: "f", subscription_amount: "6", first_visit_date: "2026-10-09" };
      let e = plain(api.obCheckSection("vendor", base, NOW).errors);
      assert.match(e.branches, /Lite is for one branch/);
      e = plain(api.obCheckSection("vendor", Object.assign({}, base, { plan: "business", branches: "3", tills: "2" }), NOW).errors);
      assert.match(e.tills, /one till per branch/);
      e = plain(api.obCheckSection("vendor", Object.assign({}, base, { plan: "business", subscription_amount: "18.555" }), NOW).errors);
      assert.match(e.subscription_amount, /amount/);
      e = plain(api.obCheckSection("vendor", Object.assign({}, base, { plan: "business", first_visit_date: "2026-10-10" }), NOW).errors);
      assert.match(e.first_visit_date, /future/);
      assert.ok(api.obCheckSection("vendor", Object.assign({}, base, { plan: "lite", branches: "1", tills: "3", subscription_amount: "12.50" }), NOW).complete);
    });
    await t("fields that depend on an answer: asked only then (failed device, activation, printer, stocktake)", () => {
      const inst = { devices: [{ device_type: "phone", install_type: "pwa", branch: "Main", till: "", result: "failed", failure_reason: "" }], secret_phrase_set: "yes", join_codes_used: "na", activation_requested: "yes", activation_date: "", printer: "usb", test_print: "", install_issues: "" };
      const e = plain(api.obCheckSection("installation", inst, NOW).errors);
      assert.deepStrictEqual(Object.keys(e).sort(), ["activation_date", "devices.0.failure_reason", "test_print"]);
      const ok = Object.assign({}, inst, { devices: [Object.assign({}, inst.devices[0], { result: "installed" })], activation_requested: "no", printer: "none" });
      assert.ok(api.obCheckSection("installation", ok, NOW).complete, JSON.stringify(plain(api.obCheckSection("installation", ok, NOW).errors)));
      const impl = { product_source: "excel", products_loaded: "10", stocktake_done: "yes", staff_count: "1", single_operator: "yes", first_shift_eod: "yes", backup_explained: "no", debtor_balances: "none" };
      assert.deepStrictEqual(Object.keys(plain(api.obCheckSection("implementation", impl, NOW).errors)).sort(), ["stocktake_date", "stocktake_lines"]);
      assert.ok(api.obCheckSection("implementation", Object.assign({}, impl, { stocktake_done: "no" }), NOW).complete);
    });
    await t("training: a session, at least one module covered, and both ticks", () => {
      const tr = { sessions: [], modules: {}, support_contacts_given: "yes", vendor_full_name: "T", vendor_confirms: false, acceptance_date: "2026-10-09", rpn_declares: false };
      const e = plain(api.obCheckSection("training", tr, NOW).errors);
      assert.deepStrictEqual(Object.keys(e).sort(), ["modules", "rpn_declares", "sessions", "vendor_confirms"]);
    });
    await t("the module list is the Commerce Lite screens that exist (Phase 0 inventory)", () => {
      assert.deepStrictEqual(plain(api.OB_MODULES.map((m) => m[0])), ["sell", "products", "credit", "reports", "reportwriter", "stocktake", "purchasing", "requests", "directory", "staff", "shift", "printing", "whatsapp", "backup", "marketing"]);
    });
  }

  // ---------------- sending ----------------
  {
    const { api, clock, fake } = load();
    await api.fieldInit();
    await api.obInit();
    await api.signIn("Tendai Moyo", "1234");
    let rec;
    await t("a new record waits on the phone until the vendor's details are filled in", async () => {
      rec = await api.obCreate(null);
      await pass(api);
      assert.strictEqual(fake.calls, 0);
      assert.strictEqual(api.obStatus(rec).text, "Saved on phone");
      assert.strictEqual(api.obCanSendDraft(rec, clock.now), false);
    });
    await t("with the identity filled in, saving a section sends a draft; the Console has it", async () => {
      for (const [k, v] of [["business_name", "Mai Tendai Grocers"], ["owner_name", "T. Mapfumo"], ["phone", "0789 012 231"], ["city", "Harare"], ["plan", "lite"], ["branches", "3"]]) { clock.now += 1000; api.obSetValue(rec, "vendor", k, v); }
      await api.obSaveSection(rec, "vendor");
      await api.outboxIdle();
      assert.strictEqual(fake.calls, 1);
      const row = fake.rows.get(rec.id);
      assert.strictEqual(row.status, "draft");
      assert.strictEqual(row.params.p_phone, "+263789012231", "phone in the database's format");
      assert.strictEqual(row.params.p_branches, null, "an invalid typed value (Lite with 3 branches) goes as null, so the draft is accepted");
      assert.strictEqual(row.params.p_submit, false);
      assert.ok(!("p_rpn_id" in row.params), "the RPN comes from the token");
      assert.strictEqual(api.obStatus(rec).text, "Draft sent");
    });
    await t("no new change: nothing is sent again", async () => {
      await pass(api);
      assert.strictEqual(fake.calls, 1);
    });
    await t("a lost answer: retried, and the Console keeps one row ('unchanged')", async () => {
      clock.now += 1000; api.obSetValue(rec, "vendor", "branches", "1");
      fake.loseAnswer = 1;
      await api.obSaveSection(rec, "vendor"); await api.outboxIdle();
      assert.strictEqual(api.obStatus(rec).text, "Failed - retry");
      clock.now += 60 * 1000;
      await pass(api);
      assert.strictEqual(api.obStatus(rec).text, "Draft sent");
      assert.strictEqual(fake.rows.size, 1);
    });
    await t("no connection: failed with the reason, sent later on the backoff", async () => {
      clock.now += 1000; api.obSetValue(rec, "vendor", "location", "Mbare");
      fake.network = true;
      await api.obSaveSection(rec, "vendor"); await api.outboxIdle();
      assert.strictEqual(rec.sync, "failed");
      assert.match(rec.lastError, /No connection/);
      fake.network = false;
      clock.now += 10 * 1000;
      await pass(api);
      assert.strictEqual(fake.rows.get(rec.id).params.p_sections.vendor.location, "Mbare");
    });
    await t("submit is refused on the phone until all four sections are done", async () => {
      assert.strictEqual(await api.obSubmit(rec), false);
      assert.strictEqual(api.obEditable(rec), true);
    });
    await t("all four done: Submit locks it, sends p_submit, and it shows 'With the office'", async () => {
      await fillAll(api, rec, clock);
      for (const s of api.OB_SECTIONS) assert.strictEqual(api.obSectionProgress(rec, s.key, clock.now), "done", s.key + ": " + JSON.stringify(plain(api.obCheckSection(s.key, rec.data[s.key], clock.now).errors)));
      assert.strictEqual(await api.obSubmit(rec), true);
      assert.strictEqual(api.obEditable(rec), false, "locked on the phone at once");
      await api.outboxIdle();
      const row = fake.rows.get(rec.id);
      assert.strictEqual(row.status, "submitted");
      assert.strictEqual(row.params.p_submit, true);
      assert.strictEqual(row.params.p_subscription_amount, 18);
      assert.strictEqual(row.params.p_sections.training.vendor_confirms, true);
      assert.ok(!("failure_reason" in row.params.p_sections.installation.devices[0]), "hidden fields are left out");
      assert.strictEqual(api.obStatus(rec).text, "With the office");
    });
    await t("typing into a submitted record changes nothing", async () => {
      const before = rec.savedAt;
      api.obSetValue(rec, "vendor", "city", "Changed");
      assert.strictEqual(rec.data.vendor.city, "Harare");
      assert.strictEqual(rec.savedAt, before);
    });
    await t("the office returns it: the RPN sees the reason and can edit again", async () => {
      Object.assign(fake.rows.get(rec.id), { status: "returned", office_reason: "Stocktake date missing" });
      await api.obPull(true);
      assert.strictEqual(api.obStatus(rec).text, "Returned to you");
      assert.strictEqual(rec.officeReason, "Stocktake date missing");
      assert.strictEqual(api.obEditable(rec), true);
      clock.now += 1000; api.obSetValue(rec, "implementation", "variance_notes", "None");
      assert.strictEqual(await api.obSubmit(rec), true);
      await api.outboxIdle();
      assert.strictEqual(fake.rows.get(rec.id).status, "submitted");
    });
    await t("approved by the office: 'Verified', and it stays locked", async () => {
      Object.assign(fake.rows.get(rec.id), { status: "approved", office_reason: null, verified_at: "2026-10-09T12:00:00Z" });
      await api.obPull(true);
      assert.strictEqual(api.obStatus(rec).text, "Verified");
      assert.strictEqual(api.obEditable(rec), false);
    });
    await t("a refused submit gives the record back to the RPN with the reason", async () => {
      const r2 = await api.obCreate(null);
      await fillAll(api, r2, clock);
      // The Console refuses (pretend the declaration didn't arrive).
      const orig = fake.fetch;
      fake.fetch = async (url, opts) => {
        if (/cl_rpn_save_onboarding/.test(url) && JSON.parse(opts.body).p_submit) return { status: 400, text: async () => JSON.stringify({ code: "23514", message: "To submit, the vendor's acceptance and your declaration are needed" }) };
        return orig(url, opts);
      };
      await api.obSubmit(r2);
      await api.outboxIdle();
      fake.fetch = orig;
      assert.strictEqual(r2.sync, "failed");
      assert.strictEqual(r2.permanent, true);
      assert.strictEqual(api.obEditable(r2), true, "editable again");
      assert.match(r2.lastError, /acceptance/);
    });
    await t("sign-in runs out: 'Sign in to send'; signing in again sends it", async () => {
      const r3 = await api.obCreate(null);
      for (const [k, v] of [["business_name", "Gogo Store"], ["owner_name", "G. Ncube"], ["phone", "0771 555 000"], ["city", "Gweru"]]) { clock.now += 1000; api.obSetValue(r3, "vendor", k, v); }
      clock.now += 13 * 3600 * 1000; // the 12-hour token is gone
      await api.obSaveSection(r3, "vendor"); await api.outboxIdle();
      assert.strictEqual(api.obStatus(r3).text, "Sign in to send");
      await api.signIn("Tendai Moyo", "1234");
      await api.outboxIdle();
      assert.ok(fake.rows.has(r3.id));
    });
    await t("another RPN on the same phone: the first RPN's record waits for them", async () => {
      const r4 = await api.obCreate(null);
      for (const [k, v] of [["business_name", "Shop Four"], ["owner_name", "F. Four"], ["phone", "0771 444 444"], ["city", "Mutare"]]) { clock.now += 1000; api.obSetValue(r4, "vendor", k, v); }
      await api.obFlush();
      await api.signOut();
      await api.signIn("Rudo Banda", "5678");
      await api.obSaveSection(r4, "vendor"); await api.outboxIdle();
      assert.ok(!fake.rows.has(r4.id));
      assert.strictEqual(api.obStatus(r4).text, "Sign in to send");
    });
    await t("records are kept on the phone (records store) and come back after a restart", async () => {
      const kept = plain(await api.storeGetAll("records"));
      assert.strictEqual(kept.length, api.ob.records.length);
      const first = kept.find((r) => r.data.vendor.business_name === "Mai Tendai Grocers");
      assert.strictEqual(first.serverStatus, "approved");
    });
  }
  {
    const { api, clock } = load();
    await api.fieldInit(); await api.obInit(); await api.signIn("Tendai Moyo", "1234");
    await t("starting from an onboarding note copies its details, and links it only once the note is sent", async () => {
      const fields = api.validateNote({ business_name: "Note Shop", owner_name: "N. Owner", phone: "0771 222 333", city: "Kadoma", location: "Market", visit_date: "2026-10-08", business_type: "Hardware", record_keeping: "", approx_products: "", devices: "", plan_interest: "", stocktake_needed: "", notes: "" }, clock.now).fields;
      const note = await api.saveNote(fields);
      await api.outboxIdle();
      assert.strictEqual(note.status, "sent");
      const rec = await api.obCreate(note.id);
      assert.strictEqual(rec.noteId, note.id);
      assert.strictEqual(rec.data.vendor.business_name, "Note Shop");
      assert.strictEqual(rec.data.vendor.first_visit_date, "2026-10-08");
      assert.strictEqual(rec.data.vendor.business_type, "Hardware");
    });
  }

  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
