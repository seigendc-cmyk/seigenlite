// Run: node --no-warnings test/fieldguide-onboarding-record-e2e.test.js
// (build first: node build.js --rpn)
// The full vendor onboarding form in a real browser, against a FAKE Console:
// every request to the Console's Supabase URL is answered here with the
// database's rules (supabase/migrations/20261009160000_rpn_onboarding_records.sql);
// anything else to that host is aborted and fails the run. The live project
// is never contacted.
//   * Field: "+ Start vendor onboarding" -> start blank -> Section 1
//   * missing and bad input marked, said once at the top, first one focused
//   * Section 1 saved -> draft at the Console; Lite with 2 branches refused
//   * Section 2: a failed device asks why; add / remove a device; printer
//     asks for the test print
//   * typing kept through offline/online and a reload
//   * Section 3 and 4, then Submit -> confirm -> "With the office"; locked
//   * the office returns it -> reload -> "Returned to you" + the reason;
//     editable again; resubmitted
//   * offline: a new onboarding saves on the phone, sent when back online
//   * the screens at 360x640 and 412x915
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

let chromium;
try { ({ chromium } = require("playwright")); }
catch (e) {
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist-rpn");
if (!fs.existsSync(path.join(DIST, "index.html"))) { console.log("Missing dist-rpn/ — run: node build.js --rpn"); process.exit(1); }
const CONSOLE_URL = fs.readFileSync(path.join(ROOT, "src", "devicecheckin.js"), "utf8").match(/const DC_SUPABASE_URL = "([^"]+)";/)[1];
const SHOTS = process.env.RPN_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "rpn-onboarding-record-shots-"));
fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 8).join("\n       ")); }
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
function deploy() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port + "/" })));
}

// ---------------- the fake Console ----------------
const RPN_A = "11111111-1111-4111-8111-111111111111";
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
function fakeConsole() {
  const c = { rows: new Map(), saves: 0, unexpected: [] };
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
  c.handle = async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body: body === undefined ? "" : JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (u.pathname === "/rest/v1/rpc/cl_login") {
      const { p_name, p_passcode } = JSON.parse(req.postData());
      if (p_name !== "Tendai Moyo" || p_passcode !== "1234") return json(400, { code: "P0001", message: "Invalid name or passcode" });
      const now = Math.floor(Date.now() / 1000);
      return json(200, { token: b64url({ alg: "HS256", typ: "JWT" }) + "." + b64url({ role: "authenticated", sub: RPN_A, user_type: "rpn", full_name: p_name, iat: now, exp: now + 12 * 3600 }) + ".sig", full_name: p_name });
    }
    const token = (req.headers()["authorization"] || "").replace("Bearer ", "");
    let claims; try { claims = claimsOf(token); } catch (e) { return json(401, { code: "PGRST301", message: "JWT invalid" }); }
    if (u.pathname === "/rest/v1/rpn_onboarding_records" && req.method() === "GET") {
      return json(200, [...c.rows.values()].filter((r) => r.rpn_id === claims.sub).map((r) => ({ id: r.id, status: r.status, office_reason: r.office_reason || null, verified_at: null })));
    }
    if (u.pathname === "/rest/v1/rpc/cl_rpn_save_onboarding") {
      c.saves++;
      const p = JSON.parse(req.postData());
      const cur = c.rows.get(p.p_id);
      const out = (r, result) => json(200, { id: r.id, status: r.status, result, office_reason: r.office_reason || null, verified_at: null });
      if (cur) {
        if (p.p_client_saved_at <= cur.client_saved_at) return out(cur, "unchanged");
        if (!["draft", "returned"].includes(cur.status)) return json(400, { code: "55000", message: "This onboarding is " + cur.status + " and can no longer be changed" });
      }
      if (!/^\+?[0-9][0-9 ]{6,19}$/.test(p.p_phone)) return json(400, { code: "23514", message: "phone_check" });
      if (p.p_plan === "lite" && p.p_branches > 1) return json(400, { code: "23514", message: "lite_one_branch" });
      if (p.p_submit) {
        const tr = p.p_sections.training || {};
        if (p.p_plan == null || p.p_branches == null || p.p_tills == null || p.p_subscription_amount == null || tr.vendor_confirms !== true || tr.rpn_declares !== true) return json(400, { code: "23514", message: "incomplete submit" });
      }
      const row = Object.assign({}, cur || { rpn_id: claims.sub, status: "draft" }, { id: p.p_id, client_saved_at: p.p_client_saved_at, params: p });
      if (p.p_submit) row.status = "submitted";
      c.rows.set(p.p_id, row);
      return out(row, p.p_submit ? "submitted" : "saved");
    }
    c.unexpected.push(req.method() + " " + u.pathname);
    return route.abort("blockedbyclient");
  };
  return c;
}

function watchErrors(page) {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_(INTERNET_DISCONNECTED|CONNECTION_RESET|BLOCKED)|net::/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
const heading = (page, text) => page.waitForFunction((x) => { const e = document.querySelector("#fgMain .fg-h1"); return e && e.textContent.trim() === x; }, text);
const waitText = (page, sel, re) => page.waitForFunction(([s, src, flags]) => { const e = document.querySelector(s); return !!e && new RegExp(src, flags).test(e.textContent); }, [sel, re.source, re.flags]);
const id = (sec, p) => "#fgOb-" + sec + "-" + p.replace(/\./g, "-");
async function signIn(page) {
  await page.goto(page.url().replace(/#.*$/, "") + "#/me");
  await heading(page, "Me");
  // The Me screen redraws once its "Works offline" check finishes, which
  // would drop half-typed sign-in text (app.js checkOfflineReady -> render;
  // seen 2026-10-09, not part of this change): wait until it says Ready.
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(() => { const e = document.getElementById("fgReady"); return e && /Ready/.test(e.textContent); });
  await page.fill("#fgSigninName", "Tendai Moyo");
  await page.fill("#fgSigninPass", "1234");
  await page.click("#fgSignin button[type=submit]");
  await waitText(page, "#fgSignin", /Signed in as/);
}
async function fill(page, sec, values) {
  for (const [k, v] of Object.entries(values)) {
    const sel = id(sec, k);
    const tag = await page.$eval(sel, (e) => e.tagName + ":" + e.type);
    if (tag.startsWith("SELECT")) await page.selectOption(sel, v);
    else if (tag === "INPUT:checkbox") { if (v) await page.check(sel); else await page.uncheck(sel); }
    else await page.fill(sel, v);
  }
}
const saveSection = (page) => page.click(".fg-ob-form button[type=submit]");
const sectionPills = (page) => page.$$eval("[data-act=o-sec] .pill", (els) => els.map((e) => e.textContent));
const recordPill = (page, name) => page.evaluate((n) => { const row = [...document.querySelectorAll(".fg-ob-list .fg-note-row")].find((r) => r.querySelector(".fg-note-t").textContent === n); return row ? row.querySelector(".pill").textContent : null; }, name);

const SEC1 = { business_name: "Mai Tendai Grocers", owner_name: "T. Mapfumo", phone: "0789 012 231", city: "Harare", plan: "lite", branches: "1", tills: "2", features_taken: "One branch, one extra till", subscription_amount: "9" };
const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

(async () => {
  const browser = await chromium.launch();
  const site = await deploy();
  const fake = fakeConsole();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  await ctx.route(CONSOLE_URL + "/**", fake.handle);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  let recId;

  await t("signed out: 'Start vendor onboarding' is there but off", async () => {
    await page.goto(site.base + "#/field");
    await heading(page, "Field");
    await page.waitForSelector("[data-act=o-new]");
    assert.ok(await page.isDisabled("[data-act=o-new]"));
  });

  await t("signed in: Start -> Start blank opens Section 1 with today's date", async () => {
    await signIn(page);
    await page.click("#fgNav-field");
    await heading(page, "Field");
    await page.click("[data-act=o-new]");
    await heading(page, "Start vendor onboarding");
    await page.click(".fg-ob-blank");
    await heading(page, "1. Vendor & plan");
    recId = page.url().split("/").slice(-2)[0];
    assert.strictEqual(await page.inputValue(id("vendor", "first_visit_date")), today());
    await page.screenshot({ path: path.join(SHOTS, "412-section1-empty.png"), fullPage: true });
  });

  await t("Section 1: missing and bad input marked, said once at the top, first one focused; nothing sent", async () => {
    await saveSection(page);
    await page.waitForSelector(".fg-errsum");
    assert.match(await page.textContent(".fg-errsum"), /9 fields/);
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), "fgOb-vendor-business_name");
    await fill(page, "vendor", Object.assign({}, SEC1, { branches: "2", subscription_amount: "nine" }));
    await saveSection(page);
    await waitText(page, ".fg-errsum", /2 fields/);
    assert.match(await page.textContent("#fgOb-vendor-branches-err"), /Lite is for one branch/);
    assert.match(await page.textContent("#fgOb-vendor-subscription_amount-err"), /amount/);
    await page.screenshot({ path: path.join(SHOTS, "412-section1-errors.png"), fullPage: true });
  });

  await t("Section 1 fixed and saved: on to Section 2; the Console has a draft (Lite with 2 branches never sent as such)", async () => {
    await fill(page, "vendor", { branches: "1", subscription_amount: "9" });
    await saveSection(page);
    await heading(page, "2. Installation & activation");
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && !(fake.rows.get(recId) && fake.rows.get(recId).params.p_branches === 1); i++) await page.waitForTimeout(100);
    const row = fake.rows.get(recId);
    assert.ok(row, "draft reached the Console");
    assert.strictEqual(row.status, "draft");
    assert.strictEqual(row.params.p_phone, "+263789012231");
    assert.strictEqual(row.params.p_subscription_amount, 9);
    for (const r of fake.rows.values()) assert.ok(!(r.params.p_plan === "lite" && r.params.p_branches > 1));
  });

  await t("Section 2: a failed device asks why; printer asks for the test print; add and remove a device", async () => {
    assert.strictEqual(await page.$(id("installation", "devices.0.failure_reason")), null);
    await fill(page, "installation", { "devices.0.device_type": "phone", "devices.0.install_type": "pwa", "devices.0.branch": "Main", "devices.0.result": "failed" });
    await page.waitForSelector(id("installation", "devices.0.failure_reason"));
    assert.strictEqual(await page.inputValue(id("installation", "devices.0.branch")), "Main", "typed text kept through the redraw");
    await fill(page, "installation", { "devices.0.failure_reason": "Old Android, no Chrome", "devices.0.result": "installed" });
    await page.waitForFunction((s) => !document.querySelector(s), id("installation", "devices.0.failure_reason"));
    await page.click("[data-act=o-add][data-list=devices]");
    await page.waitForSelector(id("installation", "devices.1.device_type"));
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), "fgOb-installation-devices-1-device_type", "the new device's first field is focused");
    await fill(page, "installation", { "devices.1.device_type": "laptop", "devices.1.install_type": "desktop", "devices.1.branch": "Main", "devices.1.till": "Till 2", "devices.1.result": "installed" });
    await page.click("[data-act=o-add][data-list=devices]");
    await page.waitForSelector(id("installation", "devices.2.device_type"));
    await page.click("[data-act=o-remove][data-index='2']");
    await page.waitForSelector("#fgModal:not([hidden])");
    await page.click("#fgModalOk");
    await page.waitForFunction((s) => !document.querySelector(s), id("installation", "devices.2.device_type"));
    assert.strictEqual(await page.inputValue(id("installation", "devices.1.till")), "Till 2");
    assert.strictEqual(await page.$(id("installation", "test_print")), null);
    await fill(page, "installation", { secret_phrase_set: "yes", join_codes_used: "yes", activation_requested: "yes", printer: "bluetooth" });
    await page.waitForSelector(id("installation", "test_print"));
    await page.waitForSelector(id("installation", "activation_date"));
    await page.screenshot({ path: path.join(SHOTS, "412-section2.png"), fullPage: true });
  });

  await t("typing is kept through offline/online and a reload", async () => {
    await page.fill(id("installation", "install_issues"), "Bluetooth pairing took two tries");
    await ctx.setOffline(true);
    await ctx.setOffline(false);
    assert.strictEqual(await page.inputValue(id("installation", "install_issues")), "Bluetooth pairing took two tries");
    await page.waitForTimeout(600); // the phone keeps typing after a short pause
    await page.reload();
    await heading(page, "2. Installation & activation");
    await page.waitForSelector(id("installation", "devices.1.till"));
    assert.strictEqual(await page.inputValue(id("installation", "install_issues")), "Bluetooth pairing took two tries");
    assert.strictEqual(await page.inputValue(id("installation", "devices.1.till")), "Till 2");
    await fill(page, "installation", { activation_date: today(), test_print: "yes" });
    await saveSection(page);
    await heading(page, "3. Implementation & stocktake");
  });

  await t("Section 3: stocktake details asked only when a stocktake was done", async () => {
    assert.strictEqual(await page.$(id("implementation", "stocktake_date")), null);
    await fill(page, "implementation", { product_source: "excel", products_loaded: "240", stocktake_done: "yes" });
    await page.waitForSelector(id("implementation", "stocktake_lines"));
    await fill(page, "implementation", { stocktake_date: today(), stocktake_lines: "240", staff_count: "2", single_operator: "no", first_shift_eod: "yes", backup_explained: "yes", debtor_balances: "none" });
    await saveSection(page);
    await heading(page, "4. Training & handover");
  });

  await t("Section 4: a session, modules, both ticks; saved -> the record shows four sections Done", async () => {
    await saveSection(page);
    await page.waitForSelector(".fg-errsum");
    assert.ok(await page.$("#fgOb-training-modules-err"));
    assert.ok(await page.$("#fgOb-training-vendor_confirms-err"));
    await fill(page, "training", { "sessions.0.duration_min": "90", "sessions.0.staff_names": "Rudo, Farai", "modules.sell": "confident", "modules.stocktake": "ok", "modules.shift": "needs_help", support_contacts_given: "yes", vendor_full_name: "Tendai Mapfumo", vendor_confirms: true, acceptance_date: today(), rpn_declares: true });
    await page.screenshot({ path: path.join(SHOTS, "412-section4.png"), fullPage: true });
    await saveSection(page);
    await heading(page, "Mai Tendai Grocers");
    assert.deepStrictEqual(await sectionPills(page), ["Done", "Done", "Done", "Done"]);
    assert.ok(!(await page.isDisabled("[data-act=o-submit]")));
  });

  await t("Submit -> confirm -> 'With the office'; the Console has it submitted with everything", async () => {
    await page.click("[data-act=o-submit]");
    await page.waitForSelector("#fgModal:not([hidden])");
    await page.click("#fgModalOk");
    await page.waitForFunction(() => /With the office/.test(document.querySelector(".fg-subhead .pill").textContent));
    const row = fake.rows.get(recId);
    assert.strictEqual(row.status, "submitted");
    const p = row.params;
    assert.strictEqual(p.p_submit, true);
    assert.strictEqual(p.p_sections.installation.devices.length, 2);
    assert.deepStrictEqual(p.p_sections.training.modules, { sell: "confident", stocktake: "ok", shift: "needs_help" });
    assert.strictEqual(p.p_sections.installation.install_issues, "Bluetooth pairing took two tries");
    assert.strictEqual(await page.$("[data-act=o-submit]"), null, "no Submit once submitted");
    await page.screenshot({ path: path.join(SHOTS, "412-record-submitted.png"), fullPage: true });
  });

  await t("a submitted record can be read but not changed", async () => {
    await page.click("[data-act=o-sec][data-sec=vendor]");
    await heading(page, "1. Vendor & plan");
    assert.ok(await page.isDisabled(id("vendor", "business_name")));
    assert.strictEqual(await page.$(".fg-ob-form button[type=submit]"), null);
    assert.match(await page.textContent("#fgMain .fg-warn"), /submitted/);
  });

  await t("the office returns it: after a reload the RPN sees 'Returned to you' and the reason, fixes it and submits again", async () => {
    Object.assign(fake.rows.get(recId), { status: "returned", office_reason: "Vendor says there are 3 tills" });
    await page.goto(site.base + "#/field");
    await page.reload();
    await page.waitForFunction(() => [...document.querySelectorAll(".fg-ob-list .pill")].some((x) => x.textContent === "Returned to you"));
    await page.click(".fg-ob-list .fg-note-row");
    await waitText(page, ".fg-status", /Vendor says there are 3 tills/);
    await page.screenshot({ path: path.join(SHOTS, "412-record-returned.png"), fullPage: true });
    await page.click("[data-act=o-sec][data-sec=vendor]");
    await heading(page, "1. Vendor & plan");
    assert.ok(!(await page.isDisabled(id("vendor", "tills"))));
    await fill(page, "vendor", { tills: "3", subscription_amount: "12" });
    await saveSection(page);
    await heading(page, "2. Installation & activation");
    await page.click(".fg-back");
    await heading(page, "Mai Tendai Grocers");
    await page.click("[data-act=o-submit]");
    await page.click("#fgModalOk");
    await page.waitForFunction(() => /With the office/.test(document.querySelector(".fg-subhead .pill").textContent));
    assert.strictEqual(fake.rows.get(recId).params.p_tills, 3);
    assert.strictEqual(fake.rows.get(recId).status, "submitted");
  });

  await t("no console errors, and nothing went anywhere but the fake Console", async () => {
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(fake.unexpected, []);
  });
  await ctx.close();

  await t("offline: a new onboarding is kept on the phone, and sent when back online", async () => {
    const c = await browser.newContext({ viewport: { width: 412, height: 915 } });
    await c.route(CONSOLE_URL + "/**", fake.handle);
    const p = await c.newPage();
    const errs = watchErrors(p);
    await p.goto(site.base);
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    await signIn(p);
    await c.setOffline(true);
    await p.goto(site.base + "#/field");
    await p.reload();
    await heading(p, "Field");
    await p.click("[data-act=o-new]");
    await p.click(".fg-ob-blank");
    await heading(p, "1. Vendor & plan");
    await fill(p, "vendor", Object.assign({}, SEC1, { business_name: "Offline Tuckshop" }));
    await saveSection(p);
    await heading(p, "2. Installation & activation");
    await p.click(".fg-back");
    await waitText(p, ".fg-status", /Waiting for internet/);
    const before = fake.saves;
    await p.click(".fg-back");
    await heading(p, "Field");
    assert.strictEqual(await recordPill(p, "Offline Tuckshop"), "Saved on phone");
    await c.setOffline(false);
    await p.waitForFunction(() => [...document.querySelectorAll(".fg-ob-list .fg-note-row")].some((r) => /Offline Tuckshop/.test(r.textContent) && /Draft sent/.test(r.textContent)));
    assert.ok(fake.saves > before);
    assert.deepStrictEqual(errs, []);
    await c.close();
  });

  for (const [w, h] of [[360, 640], [412, 915]]) {
    await t("phone width " + w + "x" + h + ": list, start, record and every section fit; 16px text in boxes; touch-sized controls", async () => {
      const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await c.route(CONSOLE_URL + "/**", fake.handle);
      const p = await c.newPage();
      const errs = watchErrors(p);
      await p.goto(site.base + "#/me");
      await p.waitForSelector("#fgSignin");
      try { await signIn(p); }
      catch (e) { await p.screenshot({ path: path.join(SHOTS, w + "-signin-failed.png"), fullPage: true }); throw new Error("sign-in: " + e.message + " " + JSON.stringify(errs) + " " + (await p.textContent("#fgMain"))); }
      const check = async (name) => {
        const m = await p.evaluate(() => ({
          scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
          boxes: [...document.querySelectorAll("#fgMain input:not([type=hidden]):not([type=checkbox]), #fgMain select, #fgMain textarea, #fgMain button")].filter((e) => e.offsetParent).map((e) => ({ id: e.id || e.textContent.trim().slice(0, 24), h: e.getBoundingClientRect().height, fs: parseFloat(getComputedStyle(e).fontSize), tag: e.tagName })),
          checks: [...document.querySelectorAll(".fg-ob-check label")].map((e) => e.getBoundingClientRect().height),
        }));
        assert.ok(m.scrollW <= m.clientW, name + ": " + m.scrollW + " > " + m.clientW);
        for (const b of m.boxes) {
          if (b.tag !== "BUTTON") assert.ok(b.fs >= 16, name + ": " + b.id + " text " + b.fs + "px (phones zoom in under 16px)");
          assert.ok(b.h >= 36, name + ": " + b.id + " only " + b.h + "px high");
        }
        for (const ch of m.checks) assert.ok(ch >= 48, name + ": a tick box label is only " + ch + "px high");
        await p.screenshot({ path: path.join(SHOTS, w + "-" + name + ".png"), fullPage: true });
      };
      await p.tap("#fgNav-field");
      await heading(p, "Field");
      await check("field-list-empty");
      await p.tap("[data-act=o-new]");
      await heading(p, "Start vendor onboarding");
      await check("start");
      await p.tap(".fg-ob-blank");
      await heading(p, "1. Vendor & plan");
      await check("section1");
      await fill(p, "vendor", Object.assign({}, SEC1, { business_name: "A very long business name that goes on and on, Harare CBD branch" }));
      await p.tap(".fg-ob-form button[type=submit]");
      await heading(p, "2. Installation & activation");
      await fill(p, "installation", { "devices.0.result": "failed", printer: "usb", activation_requested: "yes" });
      await check("section2");
      await p.goto(p.url().replace(/installation$/, "implementation"));
      await heading(p, "3. Implementation & stocktake");
      await fill(p, "implementation", { stocktake_done: "yes" });
      await check("section3");
      await p.goto(p.url().replace(/implementation$/, "training"));
      await heading(p, "4. Training & handover");
      await check("section4");
      await p.goto(p.url().replace(/\/training$/, ""));
      await p.waitForSelector("[data-act=o-sec]");
      await check("record");
      await p.tap(".fg-back");
      await heading(p, "Field");
      await p.waitForSelector(".fg-ob-list .fg-note-row");
      await check("field-list");
      await c.close();
    });
  }

  await browser.close();
  site.server.close();
  console.log("Screenshots: " + SHOTS);
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
