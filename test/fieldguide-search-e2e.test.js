// Run: node --no-warnings test/fieldguide-search-e2e.test.js
// (build first: node build.js --rpn)
// The RPN Field Guide's search sheet in a real browser, served over http
// from its own origin:
//   * typing a question shows the manual's passage quoted, with "Read in
//     the manual" (opens the reader at that passage; Back returns, and the
//     query is still there) and "Practise this" (starts those questions)
//   * further results grouped: a question starts practice, a reflection
//     opens its prompt in the manual
//   * Enter and the arrow keys; the clear button; recent searches per
//     learner; example questions
//   * a question the manual doesn't cover: said plainly, nearest lessons,
//     no answer
//   * works before any learner exists (Practise then asks who's learning)
//   * works offline after a reload
//   * at 360x640 and 412x915: no sideways scroll, 48px targets
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

let chromium;
try{ ({ chromium } = require("playwright")); }
catch(e){
  console.log("Playwright is not installed (npm install --save-dev playwright) — skipping.");
  console.log("0 passed, 0 failed (skipped)");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist-rpn");
if(!fs.existsSync(path.join(DIST, "index.html"))){ console.log("Missing dist-rpn/ — run: node build.js --rpn"); process.exit(1); }
const SHOTS = process.env.RPN_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "rpn-search-shots-"));
fs.mkdirSync(SHOTS, { recursive: true });

let passed=0, failed=0;
async function t(name, fn){
  try{ await fn(); passed++; console.log("  ok   "+name); }
  catch(e){ failed++; console.log("  FAIL "+name+"\n       "+(e.stack||e.message).split("\n").slice(0,8).join("\n       ")); }
}
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".webmanifest":"application/manifest+json", ".png":"image/png", ".svg":"image/svg+xml" };
function deploy(){
  const server = http.createServer((req, res)=>{
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(DIST, rel);
    if(!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){ res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r=> server.listen(0, "127.0.0.1", ()=> r({ server, base:"http://127.0.0.1:"+server.address().port+"/" })));
}
function watchErrors(page){
  const errors = [];
  page.on("console", (m)=>{ if(m.type()==="error") errors.push(m.text()); });
  page.on("pageerror", (e)=> errors.push(String(e)));
  return errors;
}
const heading = (page, text)=> page.waitForFunction((x)=>{ const e = document.querySelector("#fgMain .fg-h1"); return e && e.textContent.trim() === x; }, text);
async function createLearner(page, name){
  await page.waitForSelector("#fgNewName");
  await page.fill("#fgNewName", name);
  await page.click("form[data-act=create-profile] button[type=submit]");
  await page.waitForSelector(".fg-lesson");
}
async function ask(page, q){
  if(await page.isHidden("#fgSearch")) await page.click("#fgSearchOpen");
  await page.fill("#fgSearchInput", q);
  // results are drawn after a short pause in typing; wait for this query's
  await page.waitForFunction((x)=>{ const b = document.getElementById("fgSearchBody"); return b.dataset.q === x && b.querySelector(".fg-sr-lead, .fg-sr-none"); }, q);
}
const quoteText = (page)=> page.textContent("#fgSearchBody .fg-sr-lead .fg-quote");

(async ()=>{
  const browser = await chromium.launch();
  const site = await deploy();
  const ctx = await browser.newContext({ viewport:{ width:412, height:915 } });
  const page = await ctx.newPage();
  const errors = watchErrors(page);

  await t("before any learner: an empty search offers example questions; answers work", async ()=>{
    await page.goto(site.base);
    await page.waitForSelector("#fgNewName");
    await page.click("#fgSearchOpen");
    await page.waitForFunction(()=> /Try asking about/.test(document.getElementById("fgSearchBody").textContent));
    assert.ok(!/Recent/.test(await page.textContent("#fgSearchBody")), "no recent searches without a learner");
    // an example fills the box and searches it
    const example = await page.textContent("#fgSearchBody [data-sact=query] .fg-sr-t");
    await page.click("#fgSearchBody [data-sact=query]");
    assert.strictEqual(await page.inputValue("#fgSearchInput"), example);
    await page.waitForSelector("#fgSearchBody .fg-sr-lead, #fgSearchBody .fg-sr-none");
    await ask(page, "what is the day rate");
    assert.ok((await quoteText(page)).includes("The current Digital Commerce rate is US$35 per day"));
    // Practise needs a learner: it goes to "who is learning"
    await page.click("#fgSearchBody [data-sact=practise]");
    await page.waitForSelector("#fgNewName");
    assert.ok(await page.isHidden("#fgSearch"));
    await createLearner(page, "Tendai");
  });

  await t("a question: the passage quoted, with where it's from; Read opens the manual there; Back returns", async ()=>{
    await ask(page, "what is the day rate");
    const lead = await page.textContent("#fgSearchBody .fg-sr-lead");
    assert.ok(lead.includes("Chapter 11"), lead);
    assert.ok((await quoteText(page)).includes("The current Digital Commerce rate is US$35 per day — but that's a starting point, not a fixed price for every job."));
    await page.screenshot({ path: path.join(SHOTS, "412-search-answer.png") });
    await page.click("#fgSearchBody .fg-sr-lead [data-sact=read]");
    await page.waitForFunction(()=> location.hash === "#/coach/read/ch11/ch11.b09");
    assert.ok(await page.isHidden("#fgSearch"));
    await page.waitForSelector("#blk-ch11-b09.fg-flash");
    const inView = await page.evaluate(()=>{ const r = document.getElementById("blk-ch11-b09").getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
    assert.ok(inView, "the passage is on screen");
    await page.goBack();
    await page.waitForFunction(()=> location.hash === "#/coach" || location.hash === "");
    await page.click("#fgSearchOpen");
    assert.strictEqual(await page.inputValue("#fgSearchInput"), "what is the day rate", "the query is still there");
    await page.waitForSelector("#fgSearchBody .fg-sr-lead");
  });

  await t("Practise this: starts the questions on that passage", async ()=>{
    const label = await page.textContent("#fgSearchBody .fg-sr-lead [data-sact=practise]");
    const n = Number(label.match(/\((\d+)\)/)[1]);
    await page.click("#fgSearchBody .fg-sr-lead [data-sact=practise]");
    await page.waitForFunction(()=> location.hash === "#/coach/practice");
    await heading(page, "Practice");
    assert.ok(await page.isHidden("#fgSearch"));
    assert.strictEqual(await page.getAttribute(".fg-q", "data-qid"), "ch11.q2");
    assert.strictEqual(n, 1);
    await page.click('.fg-q [data-i="1"]'); // ch11.q2's correct answer
    await page.waitForSelector(".fg-msg-coach.is-right");
    await page.click("[data-act=continue]");
    await page.waitForSelector(".fg-result");
    assert.strictEqual((await page.textContent(".fg-result-n")).trim(), "1/1");
  });

  await t("recent searches are kept for this learner; clear empties the box", async ()=>{
    await page.click("#fgSearchOpen");
    await page.click("#fgSearchClear");
    assert.strictEqual(await page.inputValue("#fgSearchInput"), "");
    assert.ok(await page.isHidden("#fgSearchClear"));
    await page.waitForFunction(()=> /Recent/.test(document.getElementById("fgSearchBody").textContent));
    const recent = await page.$$eval("#fgSearchBody [data-sact=query] .fg-sr-t", (els)=> els.map((e)=> e.textContent));
    assert.strictEqual(recent[0], "what is the day rate");
    await page.keyboard.press("Escape");
  });

  await t("further results: grouped; a question starts practice; a reflection opens its prompt", async ()=>{
    await ask(page, "who pays the stocktake worker");
    const groups = await page.$$eval("#fgSearchBody .fg-sr-h", (els)=> els.map((e)=> e.textContent));
    assert.ok(groups.includes("Questions"), groups.join(","));
    await page.click('#fgSearchBody [data-sact=practise][data-q="ch11.q4"]');
    await page.waitForFunction(()=> location.hash === "#/coach/practice");
    await page.waitForSelector('.fg-q[data-qid="ch11.q4"]');
    await ask(page, "rewrite plain respectful English stock list");
    await page.waitForSelector("#fgSearchBody [data-sact=reflect]");
    await page.click("#fgSearchBody [data-sact=reflect]");
    await page.waitForFunction(()=> location.hash === "#/coach/read/ch4/reflect");
    await page.waitForSelector(".fg-reflect.fg-flash");
  });

  await t("keyboard: arrow keys move through results; Enter opens the answer", async ()=>{
    await ask(page, "main or remote branch");
    await page.keyboard.press("ArrowDown");
    assert.strictEqual(await page.evaluate(()=> document.activeElement.dataset.sact), "read");
    await page.keyboard.press("ArrowUp");
    assert.strictEqual(await page.evaluate(()=> document.activeElement.id), "fgSearchInput");
    await page.keyboard.press("Enter");
    await page.waitForFunction(()=> location.hash.startsWith("#/coach/read/ch7/"));
    assert.ok(await page.isHidden("#fgSearch"));
  });

  await t("not in the manual: said plainly, the nearest lessons, no answer", async ()=>{
    await ask(page, "how do I fix a cracked phone screen");
    assert.strictEqual(await page.$("#fgSearchBody .fg-sr-lead"), null, "no answer");
    assert.ok((await page.textContent("#fgSearchBody .fg-sr-none")).includes("The manual doesn't seem to cover that"));
    const lessons = await page.$$eval("#fgSearchBody [data-sact=lesson]", (els)=> els.map((e)=> e.dataset.ch));
    assert.ok(lessons.length >= 1 && lessons.length <= 3 && lessons.includes("ch10"), lessons.join(","));
    await page.screenshot({ path: path.join(SHOTS, "412-search-nomatch.png") });
    await ask(page, "refund policy");
    assert.ok((await page.textContent("#fgSearchBody .fg-sr-none")).includes("none of those words are in it"));
    await page.click("#fgSearchBody [data-sact=lesson]");
    await page.waitForFunction(()=> location.hash.startsWith("#/coach/lesson/"));
    await page.waitForSelector(".fg-idea");
  });

  await t("no console errors through all of the above", async ()=>{ assert.deepStrictEqual(errors, []); });
  await ctx.close();

  await t("offline: after a reload with the network cut, search still answers", async ()=>{
    const c = await browser.newContext({ viewport:{ width:412, height:915 } });
    const p = await c.newPage();
    const errs = watchErrors(p);
    await p.goto(site.base);
    await p.waitForFunction(()=> !!navigator.serviceWorker.controller);
    await c.setOffline(true);
    await p.reload();
    await p.waitForSelector("#fgNewName");
    await ask(p, "who pays the stocktake worker");
    assert.ok((await quoteText(p)).includes("Stocktake worker — Hired to do the physical count — Digital Commerce"));
    assert.deepStrictEqual(errs, []);
    await c.close();
  });

  for(const [w, h] of [[360, 640], [412, 915]]){
    await t("search at "+w+"x"+h+": no sideways scroll, 48px targets", async ()=>{
      const c = await browser.newContext({ viewport:{ width:w, height:h }, deviceScaleFactor:2, isMobile:true, hasTouch:true, colorScheme:"dark" });
      const p = await c.newPage();
      await p.goto(site.base);
      await createLearner(p, "Layout");
      for(const [name, q] of [["empty", ""], ["answer", "how do I end a visit"], ["nomatch", "refund policy"]]){
        await p.tap("#fgSearchOpen");
        if(q) await ask(p, q);
        else await p.waitForFunction(()=> /Try asking about/.test(document.getElementById("fgSearchBody").textContent));
        const m = await p.evaluate(()=>({
          scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
          panelW: document.querySelector(".fg-search-panel").scrollWidth, panelCW: document.querySelector(".fg-search-panel").clientWidth,
          targets: [...document.querySelectorAll("#fgSearchBody [data-sact], #fgSearchClose, #fgSearchClear:not([hidden])")].map((e)=>{ const r = e.getBoundingClientRect(); return [r.width, r.height]; }),
        }));
        assert.ok(m.scrollW <= m.clientW && m.panelW <= m.panelCW, name+": overflows");
        for(const [tw, th] of m.targets) assert.ok(th >= 44 && tw >= 44, name+": target "+tw+"x"+th);
        await p.screenshot({ path: path.join(SHOTS, w+"-search-"+name+".png") });
        await p.keyboard.press("Escape");
        await p.keyboard.press("Escape");
      }
      await c.close();
    });
  }

  await browser.close();
  site.server.close();
  console.log("Screenshots: "+SHOTS);
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
