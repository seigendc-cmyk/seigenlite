// Run: node --no-warnings test/itred-supabase-e2e.test.js
// (build first: node build.js --itred)
// The iTred site's Supabase wiring in a REAL browser (Playwright/Chromium),
// against dist-itred/index.html:
//   * Market Space: live vendor_listings + vendors, mapped onto the site's
//     cards/list; search on name/vendor/category/city; "near me" explains
//     it can't rank (no coordinates) instead of prompting for location;
//     shop-typed text can't inject markup
//   * #/account: sign up (email confirmation required) -> sign in blocked
//     until confirmed, with resend -> sign in creates the customers row
//     from the sign-up name/phone -> edit profile -> survives a reload ->
//     sign out; wrong password; coming back from the email link (?code=);
//     forgotten password: request a reset link -> back via the link to a
//     new-password form -> signed in; expired link; link opened elsewhere
//   * the static sections (RPN, feedback, highlights, showcase, partners,
//     site products) still never touch Supabase
// Supabase itself is the in-test fake from test/itred-fake-supabase.js
// (network-level, the site is unmodified), so no real accounts or emails.
// The last test is the exception: a read-only check that the site's exact
// listings query is accepted by the LIVE project as the anon role.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createFakeSupabase, listingRow } = require("./itred-fake-supabase");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

const DIST = path.join(__dirname, "..", "dist-itred", "index.html");
if(!fs.existsSync(DIST)){ console.log("Missing dist-itred/index.html — run: node build.js --itred"); process.exit(1); }
const SITE = "file:///" + DIST.replace(/\\/g, "/");

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}

// Tables the site must NOT query this phase.
const STATIC_TABLES = ["listings","verified_partners","market_highlights","vendor_showcase","site_products","rpn_applications","feedback"];

async function open(browser, fake, hash, ctxOpts){
  const context = await browser.newContext(ctxOpts||{});
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e=> errors.push(e.message));
  await fake.install(page);
  await page.goto(SITE + (hash||""));
  await page.waitForSelector(".page.active");
  return { context, page, errors };
}
function assertNoStaticTableRequests(fake){
  const hits = fake.log.filter(r=> STATIC_TABLES.some(tb=> r.path==="/rest/v1/"+tb));
  assert.deepStrictEqual(hits, [], "static sections queried Supabase");
  assert.deepStrictEqual(fake.unexpected, [], "requests the fake doesn't know");
}
const accountNotice = (page)=> page.textContent("#accountNotice");

(async()=>{
  await t("the site's Supabase URL and anon key are exactly the ones Commerce Lite's check-in uses", async ()=>{
    const site = fs.readFileSync(path.join(__dirname, "..", "src", "itred", "index.html"), "utf8");
    const dc = fs.readFileSync(path.join(__dirname, "..", "src", "devicecheckin.js"), "utf8");
    const siteUrl = site.match(/const SUPABASE_URL = '([^']+)'/)[1];
    const siteKey = site.match(/const SUPABASE_ANON_KEY = '([^']+)'/)[1];
    const dcUrl = dc.match(/const DC_SUPABASE_URL = "([^"]+)"/)[1];
    const dcKey = dc.match(/const DC_ANON_KEY = "([^"]+)"/)[1];
    assert.strictEqual(dcUrl, siteUrl);
    assert.strictEqual(siteKey, dcKey);
    const claims = JSON.parse(Buffer.from(siteKey.split(".")[1], "base64url").toString());
    assert.strictEqual(claims.role, "anon", "never a service_role key in a public site");
    assert.strictEqual(claims.ref, new URL(siteUrl).hostname.split(".")[0]);
  });

  const browser = await chromium.launch();

  // ================= Market Space =================
  await t("Market Space shows live listings from vendor_listings + vendors, mapped onto the site's cards", async ()=>{
    const fake = createFakeSupabase({ listings:[
      listingRow({ product_name:"Sugar 2kg", price:3.5, currency:"USD", category:"Groceries", stock_quantity:12,
        image_url:"https://example.com/sugar.webp", vendors:{ business_name:"Boka General Dealer", whatsapp_number:"0771234567", city:"Harare" } }),
      listingRow({ product_name:"Bread", price:1, stock_quantity:0, vendors:{ business_name:"Mbare Bakery", whatsapp_number:null, city:"Harare" } }),
      listingRow({ product_name:"Old Oil", status:"published", expires_at:new Date(Date.now()-60000).toISOString() }),
      listingRow({ product_name:"Pending Rice", status:"pending_review" }),
    ]});
    const { context, page, errors } = await open(browser, fake, "#/market-space");
    await page.waitForSelector("#marketResults .product-card");
    const cards = await page.$$eval("#marketResults .product-card", els=> els.map(e=>({
      name: e.querySelector("h4").textContent, vendor: e.querySelector(".vendor").textContent,
      meta: e.querySelector(".product-meta").textContent.replace(/\s+/g," ").trim(),
      img: e.querySelector("img") && e.querySelector("img").getAttribute("src"),
      noPhoto: !!e.querySelector(".thumb-empty"),
      wa: e.querySelector("a.btn") && e.querySelector("a.btn").getAttribute("href") })));
    assert.deepStrictEqual(cards.map(c=>c.name).sort(), ["Bread","Sugar 2kg"]);
    const sugar = cards.find(c=>c.name==="Sugar 2kg");
    assert.strictEqual(sugar.vendor, "Boka General Dealer");
    assert.match(sugar.meta, /Location: Harare/);
    assert.match(sugar.meta, /Price: USD 3\.50/);
    assert.match(sugar.meta, /Available: 12/);
    assert.ok(!/MOQ/.test(sugar.meta), "no MOQ in the schema");
    assert.strictEqual(sugar.img, "https://example.com/sugar.webp");
    assert.match(sugar.wa, /^https:\/\/wa\.me\/263771234567\?text=/, "local number converted to 263…");
    const bread = cards.find(c=>c.name==="Bread");
    assert.strictEqual(bread.noPhoto, true);
    assert.strictEqual(bread.wa, null, "no WhatsApp button without a number");
    assert.match(bread.meta, /Available: 0/);
    // The request asks for exactly what anonymous visitors may see.
    const req = fake.requests("/rest/v1/vendor_listings")[0];
    const q = new URLSearchParams(req.query);
    assert.match(q.get("select"), /product_name/);
    assert.match(q.get("select"), /vendors\(business_name,\s*whatsapp_number,\s*city\)/);
    assert.strictEqual(q.get("status"), "eq.published");
    assert.match(q.get("expires_at"), /^gt\.\d{4}-\d\d-\d\dT/);
    assert.strictEqual(req.auth, "anon");
    // List view shows the same listings.
    await page.click("#viewListBtn");
    assert.strictEqual(await page.$$eval("#marketResults .product-list-item", els=>els.length), 2);
    assert.deepStrictEqual(errors, []);
    assertNoStaticTableRequests(fake);
    await context.close();
  });

  await t("search matches product name, vendor, category and city (no search keywords in the schema)", async ()=>{
    const fake = createFakeSupabase({ listings:[
      listingRow({ product_name:"Sugar 2kg", category:"Groceries", vendors:{ business_name:"Boka General Dealer", whatsapp_number:"", city:"Harare" } }),
      listingRow({ product_name:"Cement 50kg", category:"Building", vendors:{ business_name:"Byo Hardware", whatsapp_number:"", city:"Bulawayo" } }),
    ]});
    const { context, page } = await open(browser, fake, "#/market-space");
    await page.waitForSelector("#marketResults .product-card");
    const names = ()=> page.$$eval("#marketResults h4", els=> els.map(e=>e.textContent).sort());
    for(const [query, expect] of [["bulawayo",["Cement 50kg"]],["boka",["Sugar 2kg"]],["groceries",["Sugar 2kg"]],["50kg cement",["Cement 50kg"]],["",["Cement 50kg","Sugar 2kg"]]]){
      await page.fill("#marketSearch", query);
      assert.deepStrictEqual(await names(), expect, "query "+JSON.stringify(query));
    }
    await page.fill("#marketSearch", "zzz");
    assert.strictEqual(await page.isVisible("#marketEmpty"), true);
    assert.match(await page.textContent("#marketEmpty h3"), /No matches/);
    await context.close();
  });

  await t("'near me' says it can't rank by distance yet, and never asks for the visitor's location", async ()=>{
    const fake = createFakeSupabase({ listings:[ listingRow({ product_name:"Sugar 2kg", vendors:{ business_name:"Boka", whatsapp_number:"", city:"Harare" } }) ]});
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(()=>{
      window.__geoAsked = 0;
      Object.defineProperty(navigator, "geolocation", { value:{ getCurrentPosition(){ window.__geoAsked++; } } });
    });
    await fake.install(page);
    await page.goto(SITE + "#/market-space");
    await page.waitForSelector("#marketResults .product-card");
    await page.click("#nearMeBtn");
    assert.match(await page.textContent("#nearMeStatus"), /Nearest-first isn't available yet.*city or town/);
    assert.strictEqual(await page.evaluate(()=>window.__geoAsked), 0);
    await context.close();
  });

  await t("text typed by shops can't inject markup into the page", async ()=>{
    const fake = createFakeSupabase({ listings:[
      listingRow({ product_name:'<img src=x onerror="window.__pwned=1">Soap', category:"<b>x</b>",
        image_url:'javascript:alert(1)', vendors:{ business_name:'<script>window.__pwned=2</script>Shop', whatsapp_number:"0771", city:'"><i id=inj>' } }),
    ]});
    const { context, page } = await open(browser, fake, "#/market-space");
    await page.waitForSelector("#marketResults .product-card");
    await page.waitForTimeout(300);
    assert.strictEqual(await page.evaluate(()=>window.__pwned), undefined);
    assert.strictEqual(await page.$("#marketResults img"), null, "non-http image URL is not rendered");
    assert.strictEqual(await page.$("#inj"), null);
    assert.match(await page.textContent("#marketResults h4"), /<img src=x/);
    await context.close();
  });

  await t("with no live listings, Market Space keeps its existing 'being onboarded' empty state", async ()=>{
    const fake = createFakeSupabase({ listings:[] });
    const { context, page } = await open(browser, fake, "#/market-space");
    await page.waitForFunction(()=> true);
    await page.waitForTimeout(300);
    assert.strictEqual(await page.isVisible("#marketEmpty"), true);
    assert.match(await page.textContent("#marketEmpty h3"), /Vendors are being onboarded/);
    await context.close();
  });

  // ================= Accounts =================
  await t("sign up -> 'check your inbox'; sign in before confirming is refused with a resend option; nothing written to customers yet", async ()=>{
    const fake = createFakeSupabase();
    const { context, page, errors } = await open(browser, fake, "#/account");
    assert.strictEqual(await page.textContent("#accountNavLink"), "Sign in");
    await page.click("#tabSignUp");
    await page.fill("#signupName", "Tendai Moyo");
    await page.fill("#signupPhone", "0771234567");
    await page.fill("#authEmail", "tendai@example.com");
    await page.fill("#authPassword", "secret123");
    await page.click("#signUpBtn");
    await page.waitForSelector("#accountNotice");
    assert.match(await accountNotice(page), /Check your inbox at tendai@example\.com/);
    const su = fake.requests("/auth/v1/signup")[0];
    assert.deepStrictEqual(su.body.data, { full_name:"Tendai Moyo", phone:"0771234567" });
    assert.match(su.redirectTo, /index\.html#\/account$/);
    assert.ok(su.body.code_challenge, "PKCE flow");
    // switched to Sign in with the email filled in
    assert.strictEqual(await page.inputValue("#authEmail"), "tendai@example.com");
    await page.fill("#authPassword", "secret123");
    await page.click("#signInBtn");
    await page.waitForFunction(()=> /confirm your email/.test((document.getElementById("accountNotice")||{}).textContent||""));
    await page.click("#resendBtn");
    await page.waitForFunction(()=> /Sent\. Check your inbox/.test((document.getElementById("accountNotice")||{}).textContent||""));
    assert.strictEqual(fake.requests("/auth/v1/resend").length, 1);
    assert.strictEqual(fake.requests("/rest/v1/customers").length, 0);
    assert.strictEqual(fake.customers.size, 0);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("once confirmed: sign in creates the customers row from the sign-up name/phone, profile edits save, session survives a reload, sign out", async ()=>{
    const fake = createFakeSupabase();
    const u = fake.addUser("tendai@example.com", "secret123", { confirmed:true, user_metadata:{ full_name:"Tendai Moyo", phone:"0771234567" } });
    const { context, page, errors } = await open(browser, fake, "#/account");
    await page.fill("#authEmail", "Tendai@Example.com");
    await page.fill("#authPassword", "secret123");
    await page.click("#signInBtn");
    await page.waitForSelector("#accountEmail");
    assert.strictEqual(await page.textContent("#accountNavLink"), "My account");
    assert.strictEqual(await page.inputValue("#profileName"), "Tendai Moyo");
    assert.strictEqual(await page.inputValue("#profilePhone"), "0771234567");
    const row = fake.customers.get(u.id);
    assert.ok(row, "customers row created");
    assert.deepStrictEqual([row.email, row.full_name, row.phone], ["tendai@example.com", "Tendai Moyo", "0771234567"]);
    const inserts = fake.requests("/rest/v1/customers", "POST");
    assert.strictEqual(inserts.length, 1);
    assert.strictEqual(inserts[0].auth, "user", "inserted as the signed-in customer, not anon");

    await page.fill("#profilePhone", "0712000000");
    await page.click("#profileSave");
    await page.waitForFunction(()=> /Saved/.test((document.getElementById("accountNotice")||{}).textContent||""));
    assert.strictEqual(fake.customers.get(u.id).phone, "0712000000");
    const patch = fake.requests("/rest/v1/customers", "PATCH")[0];
    assert.deepStrictEqual(Object.keys(patch.body).sort(), ["full_name","phone"]);

    await page.reload();
    await page.waitForSelector("#accountEmail");
    assert.strictEqual(await page.inputValue("#profilePhone"), "0712000000");
    assert.strictEqual(fake.requests("/rest/v1/customers", "POST").length, 1, "no second insert for an existing profile");

    await page.click("#signOutBtn");
    await page.waitForSelector("#signInForm");
    assert.match(await accountNotice(page), /signed out/);
    assert.strictEqual(await page.textContent("#accountNavLink"), "Sign in");
    assert.deepStrictEqual(errors, []);
    assertNoStaticTableRequests(fake);
    await context.close();
  });

  await t("a wrong password gets a plain message and no profile request", async ()=>{
    const fake = createFakeSupabase();
    fake.addUser("a@example.com", "right-one", { confirmed:true });
    const { context, page } = await open(browser, fake, "#/account");
    await page.fill("#authEmail", "a@example.com");
    await page.fill("#authPassword", "wrong-one");
    await page.click("#signInBtn");
    await page.waitForSelector("#accountNotice");
    assert.strictEqual(await accountNotice(page), "Wrong email or password.");
    assert.strictEqual(await page.$("#resendBtn"), null);
    assert.strictEqual(fake.requests("/rest/v1/customers").length, 0);
    // the email they typed is still there for the next try, and the next try works
    assert.strictEqual(await page.inputValue("#authEmail"), "a@example.com");
    await page.fill("#authPassword", "right-one");
    await page.click("#signInBtn");
    await page.waitForSelector("#accountEmail");
    await context.close();
  });

  await t("a failed sign-up keeps what was typed (except the password)", async ()=>{
    const fake = createFakeSupabase();
    fake.failNextSignup = { status:429, code:"over_email_send_rate_limit", msg:"email rate limit exceeded" };
    const { context, page } = await open(browser, fake, "#/account");
    await page.click("#tabSignUp");
    await page.fill("#signupName", "Tendai Moyo");
    await page.fill("#signupPhone", "0771234567");
    await page.fill("#authEmail", "tendai@example.com");
    await page.fill("#authPassword", "secret123");
    await page.click("#signUpBtn");
    await page.waitForSelector("#accountNotice");
    assert.match(await accountNotice(page), /Too many emails sent just now/);
    assert.deepStrictEqual([await page.inputValue("#signupName"), await page.inputValue("#signupPhone"), await page.inputValue("#authEmail"), await page.inputValue("#authPassword")],
      ["Tendai Moyo", "0771234567", "tendai@example.com", ""]);
    await context.close();
  });

  await t("coming back from the email link (?code=…) signs the customer in, creates the profile and lands on #/account", async ()=>{
    const fake = createFakeSupabase();
    const { context, page, errors } = await open(browser, fake, "#/account");
    await page.click("#tabSignUp");
    await page.fill("#authEmail", "new@example.com");
    await page.fill("#authPassword", "secret123");
    await page.click("#signUpBtn");
    await page.waitForSelector("#accountNotice");
    fake.confirm("new@example.com");
    const code = fake.issueCode("new@example.com");
    await page.goto(SITE.replace(/index\.html$/, "index.html?code="+code) + "#/account");
    await page.waitForSelector("#accountEmail");
    assert.match(await accountNotice(page), /confirmed and you're signed in/);
    assert.strictEqual(new URL(page.url()).search, "", "the ?code= is cleaned off the address");
    assert.match(page.url(), /#\/account$/);
    assert.strictEqual(fake.customers.size, 1);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("an expired or invalid email link shows Supabase's reason on #/account", async ()=>{
    const fake = createFakeSupabase();
    const { context, page } = await open(browser, fake, "");
    await page.goto(SITE.replace(/index\.html$/, "index.html?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired") + "#/");
    await page.waitForFunction(()=> location.hash==="#/account" && !!document.getElementById("accountNotice"));
    assert.match(await accountNotice(page), /Email link is invalid or has expired/);
    await context.close();
  });

  // ================= Password reset =================
  await t("'Forgot password?' asks for the email (pre-filled) and sends a reset link that returns to #/account", async ()=>{
    const fake = createFakeSupabase();
    const { context, page, errors } = await open(browser, fake, "#/account");
    await page.fill("#authEmail", "tendai@example.com");
    await page.click("#forgotLink");
    await page.waitForSelector("#forgotForm");
    assert.strictEqual(await page.inputValue("#authEmail"), "tendai@example.com");
    // Back to sign in and forward again keeps the email.
    await page.click("#forgotBackBtn");
    await page.waitForSelector("#signInForm");
    assert.strictEqual(await page.inputValue("#authEmail"), "tendai@example.com");
    await page.click("#forgotLink");
    await page.click("#forgotBtn");
    await page.waitForSelector("#signInForm #accountNotice, #accountNotice");
    assert.match(await accountNotice(page), /If there's an account for tendai@example\.com, we've emailed it a link/);
    assert.strictEqual(await page.inputValue("#authEmail"), "tendai@example.com", "back on Sign in with the email filled in");
    const rec = fake.requests("/auth/v1/recover")[0];
    assert.strictEqual(rec.body.email, "tendai@example.com");
    assert.ok(rec.body.code_challenge, "PKCE flow, like the confirmation link");
    assert.match(rec.redirectTo, /index\.html\?reset=1#\/account$/);
    assert.strictEqual(fake.requests("/rest/v1/customers").length, 0);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("the reset link returns to a new-password form; after saving, the customer is signed in on the normal account view", async ()=>{
    const fake = createFakeSupabase();
    const u = fake.addUser("tendai@example.com", "old-secret", { confirmed:true, user_metadata:{ full_name:"Tendai Moyo" } });
    const { context, page, errors } = await open(browser, fake, "#/account");
    await page.fill("#authEmail", "tendai@example.com");
    await page.click("#forgotLink");
    await page.click("#forgotBtn");
    await page.waitForSelector("#accountNotice");
    const code = fake.issueCode("tendai@example.com");
    await page.goto(SITE.replace(/index\.html$/, "index.html?reset=1&code="+code) + "#/account");
    await page.waitForSelector("#newPasswordForm");
    assert.match(await accountNotice(page), /Choose a new password/);
    assert.strictEqual(await page.textContent("#resetEmail"), "tendai@example.com");
    assert.strictEqual(new URL(page.url()).search, "", "the ?reset=1&code= is cleaned off the address");
    assert.match(page.url(), /#\/account$/);
    // mismatch -> checked on the page, nothing sent
    await page.fill("#newPassword", "new-secret");
    await page.fill("#newPassword2", "new-secreX");
    await page.click("#newPasswordBtn");
    await page.waitForFunction(()=> /don't match/.test((document.getElementById("accountNotice")||{}).textContent||""));
    assert.strictEqual(fake.requests("/auth/v1/user", "PUT").length, 0);
    // same as the old one -> Supabase's refusal, in the site's words
    await page.fill("#newPassword", "old-secret");
    await page.fill("#newPassword2", "old-secret");
    await page.click("#newPasswordBtn");
    await page.waitForFunction(()=> /different from your old one/.test((document.getElementById("accountNotice")||{}).textContent||""));
    // a good one
    await page.fill("#newPassword", "new-secret");
    await page.fill("#newPassword2", "new-secret");
    await page.click("#newPasswordBtn");
    await page.waitForSelector("#accountEmail");
    assert.match(await accountNotice(page), /Your password has been changed\. You're signed in\./);
    assert.strictEqual(await page.textContent("#accountNavLink"), "My account");
    assert.strictEqual(await page.inputValue("#profileName"), "Tendai Moyo");
    assert.ok(fake.customers.get(u.id), "profile row created as for any first sign-in");
    assert.strictEqual(u.password, "new-secret");
    // the new password works, the old one doesn't
    await page.click("#signOutBtn");
    await page.waitForSelector("#signInForm");
    await page.fill("#authEmail", "tendai@example.com");
    await page.fill("#authPassword", "old-secret");
    await page.click("#signInBtn");
    await page.waitForFunction(()=> /Wrong email or password/.test((document.getElementById("accountNotice")||{}).textContent||""));
    await page.fill("#authPassword", "new-secret");
    await page.click("#signInBtn");
    await page.waitForSelector("#accountEmail");
    assert.deepStrictEqual(errors, []);
    assertNoStaticTableRequests(fake);
    await context.close();
  });

  await t("an expired or invalid reset link shows Supabase's reason, on the reset form so a new link can be requested", async ()=>{
    const fake = createFakeSupabase();
    const { context, page } = await open(browser, fake, "");
    await page.goto(SITE.replace(/index\.html$/, "index.html?reset=1&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired") + "#/account");
    await page.waitForSelector("#forgotForm");
    assert.match(await accountNotice(page), /Email link is invalid or has expired/);
    assert.strictEqual(new URL(page.url()).search, "");
    await context.close();
  });

  await t("a reset link opened in a different browser explains why and offers a new link", async ()=>{
    const fake = createFakeSupabase();
    fake.addUser("tendai@example.com", "old-secret", { confirmed:true });
    const code = fake.issueCode("tendai@example.com");
    const { context, page } = await open(browser, fake, ""); // fresh browser: no PKCE verifier stored
    await page.goto(SITE.replace(/index\.html$/, "index.html?reset=1&code="+code) + "#/account");
    await page.waitForSelector("#forgotForm");
    assert.match(await accountNotice(page), /Open it in the same browser you asked for it from/);
    assert.strictEqual(await page.$("#newPasswordForm"), null);
    await context.close();
  });

  // ================= Static sections stay static =================
  await t("RPN application and feedback still go to WhatsApp only; no static section queries Supabase", async ()=>{
    const fake = createFakeSupabase();
    const { context, page, errors } = await open(browser, fake, "#/");
    // feedback widget
    await page.click("#feedbackToggle");
    await page.fill("#feedbackText", "Nice site");
    const [fb] = await Promise.all([ context.waitForEvent("page"), page.click("#feedbackSend") ]);
    assert.match(fb.url(), /(wa\.me\/|api\.whatsapp\.com\/send\/?\?phone=)263789487287/); // wa.me redirects to api.whatsapp.com
    await fb.close();
    for(const hash of ["#/","#/products","#/rpn","#/help","#/contact"]){
      await page.goto(SITE + hash);
      await page.waitForSelector(".page.active");
    }
    await page.waitForTimeout(400);
    assertNoStaticTableRequests(fake);
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  // ================= LIVE, read-only =================
  await t("LIVE (read-only): the live project accepts the site's listings query as anon", async ()=>{
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e=> errors.push(e.message));
    const respP = page.waitForResponse(r=> /\/rest\/v1\/vendor_listings/.test(r.url()), { timeout:20000 }).catch(()=>null);
    await page.goto(SITE + "#/market-space");
    const resp = await respP;
    if(!resp){ console.log("       (skipped: live project not reachable from here)"); await context.close(); return; }
    assert.strictEqual(resp.status(), 200, await resp.text());
    assert.ok(Array.isArray(await resp.json()));
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed?1:0);
})();
