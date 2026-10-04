// Run: node --no-warnings test/fieldguide-field.test.js
// The RPN Field Guide's onboarding notes, under plain Node (no browser,
// no network): the form's checks against the database's, phone numbers,
// the backoff (compared with the shop app's own sync.js), how every Console
// answer is sorted, and the outbox itself on the in-memory store with a
// fake Console: offline, sign-in, sent, duplicate retry, expired token,
// failures and retries, another RPN on the same phone.
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

// A fake Console: cl_login + rpn_onboarding_notes, with the database's
// rules (primary key, own rows only, token expiry) and switches to fail.
function fakeConsole(clock) {
  const rows = new Map();
  const c = { rows, posts: 0, failNext: 0, failMode: null, loseAnswer: 0, accounts: { "Tendai Moyo": ["1234", RPN_A, "rpn"], "Rudo Banda": ["5678", RPN_B, "rpn"], "Office Clerk": ["9999", "33333333-3333-4333-8333-333333333333", "staff"] }, tokenLife: 12 * 3600 };
  c.fetch = async (url, opts) => {
    const u = new URL(url);
    const reply = (status, body) => ({ status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
    if (c.failMode === "network") throw new TypeError("Failed to fetch");
    if (u.pathname === "/rest/v1/rpc/cl_login") {
      const { p_name, p_passcode } = JSON.parse(opts.body);
      const acct = c.accounts[p_name];
      if (!acct || acct[0] !== p_passcode) return reply(400, { code: "P0001", message: "Invalid name or passcode" });
      const now = Math.floor(clock.now / 1000);
      return reply(200, { token: jwt({ role: "authenticated", sub: acct[1], user_type: acct[2], full_name: p_name, iat: now, exp: now + c.tokenLife }), user_type: acct[2], id: acct[1], full_name: p_name });
    }
    if (u.pathname === "/rest/v1/rpn_onboarding_notes") {
      const auth = (opts.headers.Authorization || "").replace("Bearer ", "");
      const claims = JSON.parse(Buffer.from(auth.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
      if (claims.exp * 1000 <= clock.now) return reply(401, { code: "PGRST301", message: "JWT expired" });
      if (opts.method === "GET") {
        const id = u.searchParams.get("id").replace("eq.", "");
        const row = rows.get(id);
        return reply(200, row && row.rpn_id === claims.sub ? [{ id }] : []);
      }
      c.posts++;
      if (c.failNext > 0) { c.failNext--; return reply(503, { message: "Service Unavailable" }); }
      const body = JSON.parse(opts.body);
      if ("rpn_id" in body) return reply(400, { message: "rpn_id must not be sent" });
      if (claims.user_type !== "rpn") return reply(403, { code: "42501", message: "new row violates row-level security policy" });
      if (!/^\+?[0-9][0-9 ]{6,19}$/.test(body.phone)) return reply(400, { code: "23514", message: "violates check constraint rpn_onboarding_notes_phone_check" });
      if (rows.has(body.id)) return reply(409, { code: "23505", message: "duplicate key value violates unique constraint" });
      rows.set(body.id, Object.assign({ rpn_id: claims.sub }, body));
      if (c.loseAnswer > 0) { c.loseAnswer--; throw new TypeError("connection dropped after the insert"); }
      return reply(201);
    }
    return reply(404, { message: "not found" });
  };
  return c;
}

function load() {
  const clock = { now: new Date(2026, 9, 3, 9, 0, 0).getTime() };
  const fake = fakeConsole(clock);
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock.now])); }
    static now() { return clock.now; }
  }
  const timers = [];
  const ctx = {
    CONSOLE_URL: "https://console.example", CONSOLE_ANON_KEY: "anon-key",
    fetch: (...a) => fake.fetch(...a), atob: (s) => Buffer.from(s, "base64").toString("binary"),
    navigator: { onLine: true }, crypto: require("crypto").webcrypto, Date: FakeDate, JSON, Math, Promise, Map, Set, Array, Object, String, Number, RegExp, Uint8Array, URL, encodeURIComponent, decodeURIComponent, isNaN, console,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    refreshFieldScreens: () => {}, AbortController,
    state: { tab: "coach", sub: [] }, render: () => {}, // the app shell, not under test here
  };
  vm.createContext(ctx);
  const code = ["store.js", "console-api.js", "outbox.js"].map((f) => fs.readFileSync(path.join(FG, f), "utf8")).join("\n");
  const api = vm.runInContext(code + "\n;({ field, storeInit, storeGetAll, storeGet, fieldInit, saveNote, signIn, signOut, kickOutbox, outboxIdle, retryNote, validateNote, normalizePhone, emptyNoteFields, outboxBackoffMs, consoleSendNote, consoleSignIn, noteRow, NOTE_FIELDS, storeMode: () => storeMode })", ctx);
  return { api, ctx, clock, fake, timers };
}
const plain = (x) => JSON.parse(JSON.stringify(x));
// Let any run in progress finish, then ask for one more and wait for it
// (the app itself only ever starts runs through kickOutbox).
const pass = async (a) => { await a.outboxIdle(); await a.kickOutbox(); };
const GOOD = { business_name: "Mai Tendai Grocers", owner_name: "T. Mapfumo", phone: "0789 012 231", city: "Harare", location: "Mbare", visit_date: "2026-10-03", business_type: "", record_keeping: "", approx_products: "120", devices: "", plan_interest: "Monthly", stocktake_needed: "yes", notes: "Wants to start next week" };

(async () => {
  const { api } = load();
  const NOW = new Date(2026, 9, 3, 9, 0, 0).getTime();

  // ---------------- the form ----------------
  await t("13 fields; the 5 required are business, owner, phone, city, visit date", () => {
    assert.strictEqual(api.NOTE_FIELDS.length, 13);
    assert.deepStrictEqual(plain(api.NOTE_FIELDS.filter((f) => f.required).map((f) => f.name)), ["business_name", "owner_name", "phone", "city", "visit_date"]);
    const fresh = plain(api.emptyNoteFields(NOW));
    assert.strictEqual(fresh.visit_date, "2026-10-03", "visit date defaults to today");
  });
  await t("required fields, lengths, numbers, dates and choices are checked like the database", () => {
    const empty = plain(api.validateNote({}, NOW).errors);
    assert.deepStrictEqual(Object.keys(empty).sort(), ["business_name", "city", "owner_name", "phone", "visit_date"]);
    const bad = plain(api.validateNote(Object.assign({}, GOOD, { business_name: "x".repeat(121), approx_products: "12.5", visit_date: "2026-10-04", stocktake_needed: "maybe" }), NOW).errors);
    assert.deepStrictEqual(Object.keys(bad).sort(), ["approx_products", "business_name", "stocktake_needed", "visit_date"]);
    assert.match(bad.visit_date, /future/);
    const ok = api.validateNote(Object.assign({}, GOOD, { business_name: "  Mai  Tendai   Grocers " }), NOW);
    assert.deepStrictEqual(plain(ok.errors), {});
    assert.strictEqual(ok.fields.business_name, "Mai Tendai Grocers", "spaces tidied");
  });
  await t("phone numbers: Zimbabwe by default, always in the database's format", () => {
    const rule = /^\+?[0-9][0-9 ]{6,19}$/;
    for (const [input, want] of [["0771 234 567", "+263771234567"], ["771234567", "+263771234567"], ["+263 77 123 4567", "+263771234567"], ["263771234567", "+263771234567"], ["+27 82 555 0101", "+27825550101"]]) {
      assert.strictEqual(api.normalizePhone(input), want, input);
      assert.ok(rule.test(want));
    }
    assert.ok(api.validateNote(Object.assign({}, GOOD, { phone: "call me" }), NOW).errors.phone);
    assert.ok(api.validateNote(Object.assign({}, GOOD, { phone: "12" }), NOW).errors.phone);
  });
  await t("what is sent: the note's columns, never rpn_id (the database takes it from the sign-in)", () => {
    const row = plain(api.noteRow({ id: "x", savedAt: NOW, fields: api.validateNote(GOOD, NOW).fields }));
    assert.ok(!("rpn_id" in row));
    assert.strictEqual(row.approx_products, 120);
    assert.strictEqual(row.business_type, null, "blank optional fields are sent as null");
    assert.strictEqual(row.captured_at, new Date(NOW).toISOString());
  });

  // ---------------- backoff = the shop app's sync.js ----------------
  await t("retry delays are the shop app's sync.js backoff, exactly", () => {
    const ctx = { registerSyncType: null };
    vm.createContext(ctx);
    const sync = vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "sync.js"), "utf8") + "\n;({ syncBackoffMs })", ctx);
    for (let n = 0; n <= 14; n++) assert.strictEqual(api.outboxBackoffMs(n), sync.syncBackoffMs(n), "attempt " + n);
    assert.strictEqual(api.outboxBackoffMs(1), 5000);
    assert.strictEqual(api.outboxBackoffMs(20), 30 * 60 * 1000);
  });

  // ---------------- sign-in ----------------
  await t("sign-in: wrong passcode, a staff account and no connection are each told apart", async () => {
    const { api: a, fake } = load();
    assert.strictEqual((await a.consoleSignIn("Tendai Moyo", "0000")).reason, "invalid");
    assert.strictEqual((await a.consoleSignIn("Office Clerk", "9999")).reason, "not_rpn");
    fake.failMode = "network";
    assert.strictEqual((await a.consoleSignIn("Tendai Moyo", "1234")).reason, "network");
    fake.failMode = null;
    const ok = await a.consoleSignIn("Tendai Moyo", "1234");
    assert.ok(ok.ok && ok.session.rpnId === RPN_A && ok.session.exp === NOW + 12 * 3600 * 1000);
  });

  // ---------------- the outbox ----------------
  async function freshOutbox() {
    const env = load();
    await env.api.fieldInit();
    assert.strictEqual(env.api.storeMode(), "memory");
    return env;
  }
  const statusOf = (api, id) => api.field.notes.find((n) => n.id === id).status;

  await t("saved offline stays 'Saved on phone'; online and signed in, it is sent", async () => {
    const { api: a, ctx, fake } = await freshOutbox();
    await a.signIn("Tendai Moyo", "1234");
    ctx.navigator.onLine = false;
    const note = await a.saveNote(a.validateNote(GOOD, NOW).fields);
    await pass(a);
    assert.strictEqual(statusOf(a, note.id), "saved");
    assert.strictEqual(fake.posts, 0, "nothing tried while offline");
    ctx.navigator.onLine = true;
    await pass(a);
    assert.strictEqual(statusOf(a, note.id), "sent");
    assert.strictEqual(fake.rows.get(note.id).rpn_id, RPN_A);
    const stored = (await a.storeGetAll("notes")).find((n) => n.id === note.id);
    assert.strictEqual(stored.status, "sent", "the status is kept on the phone too");
  });

  await t("a retry after a lost answer doesn't insert twice; it is recognised as sent", async () => {
    const { api: a, fake, clock } = await freshOutbox();
    await a.signIn("Tendai Moyo", "1234");
    fake.loseAnswer = 1; // the insert lands, the reply never arrives
    const note = await a.saveNote(a.validateNote(GOOD, NOW).fields);
    await pass(a);
    const first = a.field.notes.find((n) => n.id === note.id);
    assert.strictEqual(first.status, "failed");
    assert.strictEqual(first.nextAttemptAt, clock.now + 5000, "next try after 5 s, like sync.js");
    clock.now += 5000;
    await pass(a);
    assert.strictEqual(statusOf(a, note.id), "sent");
    assert.strictEqual(fake.rows.size, 1, "exactly one row in the Console");
    assert.strictEqual(fake.posts, 2);
  });

  await t("server trouble: failed with the reason, retried on the backoff, never dropped", async () => {
    const { api: a, fake, clock } = await freshOutbox();
    await a.signIn("Tendai Moyo", "1234");
    fake.failNext = 3;
    const note = await a.saveNote(a.validateNote(GOOD, NOW).fields);
    const delays = [];
    for (let i = 0; i < 3; i++) {
      await pass(a);
      const n = a.field.notes.find((x) => x.id === note.id);
      assert.strictEqual(n.status, "failed");
      assert.match(n.lastError, /503/);
      delays.push(n.nextAttemptAt - clock.now);
      await pass(a); // not due yet: no new request
      clock.now = n.nextAttemptAt;
    }
    assert.deepStrictEqual(delays, [5000, 10000, 20000]);
    assert.strictEqual(fake.posts, 3);
    await pass(a);
    assert.strictEqual(statusOf(a, note.id), "sent");
  });

  await t("a note the Console refuses: failed, not retried on its own, Retry sends it again", async () => {
    const { api: a, fake, clock } = await freshOutbox();
    await a.signIn("Tendai Moyo", "1234");
    const note = await a.saveNote(Object.assign(a.validateNote(GOOD, NOW).fields, { phone: "bad phone" })); // got past the form somehow
    await pass(a);
    const n = a.field.notes.find((x) => x.id === note.id);
    assert.strictEqual(n.status, "failed");
    assert.ok(n.permanent && /refused/.test(n.lastError));
    clock.now += 60 * 60 * 1000;
    await pass(a);
    assert.strictEqual(fake.posts, 1, "not retried by itself");
    await a.retryNote(note.id);
    await pass(a);
    assert.strictEqual(fake.posts, 2, "Retry sends it again");
  });

  await t("no sign-in, or a sign-in that has run out: 'Sign in to send', sent after signing in", async () => {
    const { api: a, fake, clock } = await freshOutbox();
    await a.signIn("Tendai Moyo", "1234");
    clock.now += 13 * 3600 * 1000; // past the 12 hours
    const note = await a.saveNote(a.validateNote(GOOD, NOW).fields);
    await pass(a);
    assert.strictEqual(statusOf(a, note.id), "signin");
    assert.strictEqual(fake.posts, 0, "not even tried with an expired token");
    await a.signIn("Tendai Moyo", "1234");
    await pass(a);
    assert.strictEqual(statusOf(a, note.id), "sent");
  });

  await t("the Console turns the token down mid-way: 'Sign in to send', the sign-in is forgotten", async () => {
    const { api: a, fake } = await freshOutbox();
    await a.signIn("Tendai Moyo", "1234");
    // The phone thinks the sign-in has hours left, but the token the
    // server sees has run out (e.g. the phone's clock is wrong).
    const [, payload] = a.field.session.token.split(".");
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    claims.exp = Math.floor(NOW / 1000) - 10;
    a.field.session.token = jwt(claims);
    const note = await a.saveNote(a.validateNote(GOOD, NOW).fields);
    await pass(a);
    assert.strictEqual(statusOf(a, note.id), "signin");
    assert.strictEqual(a.field.session, null);
    assert.ok(a.field.identity, "who the RPN is is kept");
    assert.strictEqual((await a.storeGet("meta", "consoleSession")), undefined);
    assert.strictEqual(fake.rows.size, 0);
  });

  await t("another RPN signs in on the same phone: the first RPN's notes wait for them", async () => {
    const { api: a, ctx, fake } = await freshOutbox();
    ctx.navigator.onLine = false; // both notes written offline
    await a.signIn("Tendai Moyo", "1234");
    const mine = await a.saveNote(a.validateNote(GOOD, NOW).fields);
    a.field.session = null; // Tendai's sign-in gone before it was sent
    await a.signIn("Rudo Banda", "5678");
    const hers = await a.saveNote(a.validateNote(Object.assign({}, GOOD, { business_name: "Rudo's vendor" }), NOW).fields);
    ctx.navigator.onLine = true;
    await pass(a);
    assert.strictEqual(statusOf(a, hers.id), "sent");
    assert.strictEqual(fake.rows.get(hers.id).rpn_id, RPN_B);
    assert.strictEqual(statusOf(a, mine.id), "signin", "not sent under Rudo's sign-in");
    assert.ok(!fake.rows.has(mine.id));
    await a.signIn("Tendai Moyo", "1234");
    await pass(a);
    assert.strictEqual(fake.rows.get(mine.id).rpn_id, RPN_A);
  });

  await t("no connection: failed with the reason, tried again later, the rest wait their turn", async () => {
    const { api: a, ctx, fake, clock } = await freshOutbox();
    await a.signIn("Tendai Moyo", "1234");
    ctx.navigator.onLine = false;
    const one = await a.saveNote(a.validateNote(GOOD, NOW).fields);
    clock.now += 1;
    const two = await a.saveNote(a.validateNote(Object.assign({}, GOOD, { business_name: "Second" }), NOW).fields);
    // The phone says it's online, but the Console can't be reached.
    ctx.navigator.onLine = true;
    fake.failMode = "network";
    await pass(a);
    const n1 = a.field.notes.find((n) => n.id === one.id);
    assert.strictEqual(n1.status, "failed");
    assert.match(n1.lastError, /No connection/);
    assert.strictEqual(statusOf(a, two.id), "saved", "the second waits rather than failing too");
    fake.failMode = null;
    clock.now = n1.nextAttemptAt;
    await pass(a);
    assert.strictEqual(statusOf(a, one.id), "sent");
    assert.strictEqual(statusOf(a, two.id), "sent");
  });

  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
