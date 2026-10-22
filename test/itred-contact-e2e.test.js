// Run: node --no-warnings test/itred-contact-e2e.test.js
// (build first: node build.js --itred)
// Batch 6A Part 1 on the built iTred site (dist-itred, scrambled), in Chromium:
//   * Contact Us shows seiGEN's desks and numbers from the contact directory
//     (cl_contact_directory, decision 10), in order, with Call / WhatsApp as
//     set per number and a Copy number button; no number is hard-coded there;
//   * a copy is kept, so after one visit online the page shows them offline;
//     before any, it says so (and the form still works);
//   * content protection (decision 9) in a real browser: no right-click menu
//     or text selection on the page (inputs keep both), F12 / Ctrl+U /
//     Ctrl+Shift+I blocked, everyday keys not.
// Supabase is the in-test fake (test/itred-fake-supabase.js).
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){ console.log("Playwright is not installed — skipping."); console.log("0 passed, 0 failed (skipped)"); process.exit(0); }
const { createFakeSupabase } = require("./itred-fake-supabase");
const { serveItred } = require("./itred-serve");
const DIST = path.join(__dirname, "..", "dist-itred", "index.html");
if(!fs.existsSync(DIST)){ console.log("Missing dist-itred/index.html — run: node build.js --itred"); process.exit(1); }
let passed = 0, failed = 0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 8).join("\n       ")); }
}

(async ()=>{
  const browser = await chromium.launch();
  const srv = await serveItred();
  async function open(context, fake, route){
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err)=> errors.push(err.message));
    await fake.install(page);
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r)=> r.abort());
    await page.goto(srv.base + route);
    await page.waitForSelector(".page.active");
    return { page, errors };
  }
  const desks = (page)=> page.$$eval("#contactDesks .contact-desk", (els)=> els.map((d)=> ({
    desk: d.querySelector("h3").textContent,
    numbers: [...d.querySelectorAll(".contact-number")].map((n)=> ({ text: n.querySelector("p").textContent.trim(),
      call: (n.querySelector('a[href^="tel:"]') || {}).href || null, wa: (n.querySelector('a[href^="https://wa.me/"]') || {}).href || null,
      copy: (n.querySelector("[data-copy]") || { dataset:{} }).dataset.copy || null })) })));

  await t("Contact Us: the directory's desks in order, Call and WhatsApp per number, Copy number", async ()=>{
    const context = await browser.newContext({ serviceWorkers: "block" });
    const fake = createFakeSupabase({ contacts: [
      { desk: "Queries Desk", numbers: [{ label: "Main line", phone: "+263774479121", call: true, whatsapp: true }] },
      { desk: "Sales", numbers: [{ label: "Main line", phone: "+263789487287", call: true, whatsapp: true }, { label: "WhatsApp only", phone: "+263719990000", call: false, whatsapp: true }] },
    ] });
    const { page, errors } = await open(context, fake, "/contact");
    await page.waitForSelector("#contactDesks .contact-desk");
    const d = await desks(page);
    assert.deepStrictEqual(d.map((x)=> x.desk), ["Queries Desk", "Sales"]);
    assert.deepStrictEqual(d[0].numbers[0], { text: "Main line · +263 77 447 9121", call: "tel:+263774479121",
      wa: "https://wa.me/263774479121?text=Hi%2C%20I%27m%20reaching%20out%20from%20the%20iTred%20Market%20Place%20website.", copy: "+263774479121" });
    assert.deepStrictEqual(d[1].numbers.map((n)=> [n.text, !!n.call, !!n.wa]), [["Main line · +263 78 948 7287", true, true], ["WhatsApp only · +263 71 999 0000", false, true]]);
    const html = await page.$eval("#page-\\/contact", (el)=> el.innerHTML.replace(/<div id="contactDesks"[\s\S]*$/, ""));
    assert.ok(!/263\s?78|wa\.me/.test(html), "no number hard-coded on the Contact page");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("Copy number puts the number on the clipboard and says Copied", async ()=>{
    const context = await browser.newContext({ serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
    const { page } = await open(context, createFakeSupabase(), "/contact");
    await page.waitForSelector("#contactDesks [data-copy]");
    const b = page.locator("#contactDesks [data-copy]").first();
    await b.click();
    await page.waitForFunction(()=> document.querySelector("#contactDesks [data-copy]").textContent === "Copied");
    assert.strictEqual(await page.evaluate(()=> navigator.clipboard.readText()), "+263774479121");
    await context.close();
  });

  await t("after one visit online, the numbers show without seiGEN (the kept copy); a change replaces it", async ()=>{
    const context = await browser.newContext({ serviceWorkers: "block" });
    const fake = createFakeSupabase();
    let { page } = await open(context, fake, "/contact");
    await page.waitForSelector("#contactDesks .contact-desk");
    await page.close();
    fake.contactsDown = true;
    ({ page } = await open(context, fake, "/contact"));
    await page.waitForFunction(()=> !document.querySelector("#contactDesks").textContent.includes("Loading"));
    assert.deepStrictEqual((await desks(page)).map((x)=> x.desk), ["Queries Desk", "Sales", "Support"], "from the kept copy");
    await page.close();
    fake.contactsDown = false;
    fake.contacts = [{ desk: "Support", numbers: [{ label: "Help line", phone: "+263771112222", call: true, whatsapp: false }] }];
    ({ page } = await open(context, fake, "/contact"));
    await page.waitForFunction(()=> document.querySelectorAll("#contactDesks .contact-desk").length === 1);
    assert.deepStrictEqual((await desks(page))[0].numbers[0].text, "Help line · +263 77 111 2222");
    await context.close();
  });

  await t("before any copy, when the directory can't be read: it says so, and the form is still there", async ()=>{
    const context = await browser.newContext({ serviceWorkers: "block" });
    const fake = createFakeSupabase(); fake.contactsDown = true;
    const { page, errors } = await open(context, fake, "/contact");
    await page.waitForFunction(()=> /couldn't load/.test(document.querySelector("#contactDesks").textContent));
    assert.ok(await page.$("#contactForm #cMessage"));
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await t("content protection in Chromium: no menu or selection on page text (inputs keep both); DevTools keys blocked, everyday keys not", async ()=>{
    const context = await browser.newContext({ serviceWorkers: "block" });
    const { page, errors } = await open(context, createFakeSupabase(), "/contact");
    const r = await page.evaluate(()=>{
      const fire = (el, type, init)=>{ const e = type === "keydown" ? new KeyboardEvent(type, Object.assign({ bubbles: true, cancelable: true }, init)) : new MouseEvent(type, { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
      const h1 = document.querySelector("#page-\\/contact h1"), input = document.getElementById("cName");
      return {
        menuText: fire(h1, "contextmenu"), menuInput: fire(input, "contextmenu"),
        selText: getComputedStyle(h1).userSelect, selInput: getComputedStyle(input).userSelect,
        f12: fire(document.body, "keydown", { key: "F12", code: "F12" }),
        ctrlU: fire(document.body, "keydown", { key: "u", code: "KeyU", ctrlKey: true }),
        devtools: fire(document.body, "keydown", { key: "I", code: "KeyI", ctrlKey: true, shiftKey: true }),
        copyKey: fire(input, "keydown", { key: "c", code: "KeyC", ctrlKey: true }),
        typing: fire(input, "keydown", { key: "a", code: "KeyA" }),
      };
    });
    assert.deepStrictEqual(r, { menuText: true, menuInput: false, selText: "none", selInput: "text", f12: true, ctrlU: true, devtools: true, copyKey: false, typing: false });
    await page.fill("#cName", "Tendai");
    assert.strictEqual(await page.inputValue("#cName"), "Tendai", "typing in a field works");
    assert.deepStrictEqual(errors, []);
    await context.close();
  });

  await srv.close();
  await browser.close();
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e)=>{ console.error(e); process.exit(1); });
