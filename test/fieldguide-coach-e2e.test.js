// Run: node --no-warnings test/fieldguide-coach-e2e.test.js
// (build first: node build.js --rpn)
// The RPN Field Guide's Coach tab in a real browser, served over http from
// its own origin (see test/rpn-shell-e2e.test.js for the shell itself):
//   * a first learner; a lesson: idea, "I don't understand", a right
//     answer (quoted from the manual, with a link that opens the manual at
//     that passage and comes back to the conversation), a wrong answer
//     (correct answer shown), the end-of-lesson quiz, score, next step,
//     a written reflection saved as you type
//   * weak-spot review: the missed question comes back, choices reordered
//   * learners: a second learner sees none of the first one's progress,
//     switching back finds it all, and it survives a reload (IndexedDB);
//     rename and remove go through the app's own dialog
//   * offline: after a reload with the network cut, a lesson still runs
//   * coach screens at 360x640 and 412x915: no sideways scroll, 48px
//     answer buttons. Screenshots go to RPN_SHOTS_DIR.
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
const MANUAL = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "fieldguide", "content", "manual.json"), "utf8"));
const QUESTIONS = new Map(MANUAL.chapters.flatMap((ch)=> ch.questions.map((q)=> [q.id, q])));
const SHOTS = process.env.RPN_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "rpn-coach-shots-"));
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
const h1 = async (page)=> (await page.textContent("#fgMain .fg-h1")).trim();
// The hash changes first; the screen is drawn on the hashchange after it.
const heading = (page, text)=> page.waitForFunction((x)=>{ const e = document.querySelector("#fgMain .fg-h1"); return e && e.textContent.trim() === x; }, text);
const msgCount = (page)=> page.$$eval(".fg-chat .fg-msg", (els)=> els.length);

async function createLearner(page, name){
  await page.waitForSelector("#fgNewName");
  await page.fill("#fgNewName", name);
  await page.click("form[data-act=create-profile] button[type=submit]");
  await page.waitForFunction((n)=> document.querySelector("#fgMain .fg-lead") && document.querySelector("#fgMain .fg-lead").textContent.includes(n), name);
}
// The open question on screen (the newest one: a quick-check question
// comes back in the quiz, so the same qid can be on screen twice).
async function openQuestion(page){
  return page.evaluate(()=>{
    const qs = [...document.querySelectorAll(".fg-chat .fg-msg")].filter((m)=> m.querySelector(".fg-q"));
    const msg = qs[qs.length-1];
    if(!msg) return null;
    const btns = [...msg.querySelectorAll(".fg-opt")];
    if(!btns.length || btns[0].disabled) return null;
    return { msg: msg.dataset.i, qid: msg.querySelector(".fg-q").dataset.qid, order: btns.map((b)=> Number(b.dataset.i)) };
  });
}
async function answer(page, right){
  const open = await openQuestion(page);
  assert.ok(open, "a question is waiting for an answer");
  const q = QUESTIONS.get(open.qid);
  const pick = right ? q.correct : (q.correct + 1) % q.opts.length;
  const before = await msgCount(page);
  await page.click('.fg-msg[data-i="'+open.msg+'"] .fg-opt[data-i="'+pick+'"]');
  await page.waitForFunction((n)=> document.querySelectorAll(".fg-chat .fg-msg").length > n, before);
  return open;
}
async function cont(page){
  const before = await msgCount(page);
  await page.click("[data-act=continue]");
  await page.waitForFunction((n)=> document.querySelectorAll(".fg-chat .fg-msg").length > n, before);
}
const waiting = (page)=> page.evaluate(()=> document.querySelector("[data-act=continue]") ? "continue" : document.querySelector(".fg-opt:not([disabled])") ? "answer" : "done");
// Through the rest of a lesson: every answer right except the qids listed.
async function finishLesson(page, missQids){
  for(let guard=0; guard<200; guard++){
    const w = await waiting(page);
    if(w === "done") return;
    if(w === "continue") await cont(page);
    else {
      const open = await openQuestion(page);
      await answer(page, !(missQids||[]).includes(open.qid));
    }
  }
  throw new Error("lesson never finished");
}
const lessonSub = (page, ch)=> page.textContent('[data-act=open-lesson][data-ch="'+ch+'"] .fg-lesson-sub');

(async ()=>{
  const browser = await chromium.launch();
  const site = await deploy();

  // One browser profile (IndexedDB persists across pages and reloads in it).
  const ctx = await browser.newContext({ viewport:{ width:412, height:915 } });
  const page = await ctx.newPage();
  const errors = watchErrors(page);

  await t("first learner: the Coach asks who's learning, then shows the lessons by track", async ()=>{
    await page.goto(site.base);
    assert.strictEqual(await h1(page), "Coach");
    await createLearner(page, "Tendai");
    const tracks = await page.$$eval(".fg-track-h .fg-chip", (els)=> els.map((e)=> e.textContent));
    assert.deepStrictEqual(tracks, MANUAL.tracks.filter((tr)=> !tr.reserved).map((tr)=> tr.title));
    assert.strictEqual(await page.$$eval(".fg-lesson", (els)=> els.length), 12);
    assert.ok(!tracks.includes("Licensing"), "reserved tracks are not shown");
    assert.ok(await page.isDisabled("[data-act=start-review]"), "nothing to review yet");
    assert.ok(await page.isDisabled("[data-act=start-daily]"), "practice waits for a lesson");
    await page.screenshot({ path: path.join(SHOTS, "412-coach-home-new.png") });
  });

  await t("lesson: idea, I don't understand, right answer quoted from the manual, wrong answer corrected", async ()=>{
    await page.click('[data-act=open-lesson][data-ch="ch3"]');
    await page.waitForFunction(()=> location.hash === "#/coach/lesson/ch3");
    await heading(page, "Who You Are Out There");
    assert.ok((await page.textContent(".fg-chat .fg-msg-coach")).includes("Who You Are Out There"), "coach opens the lesson");
    assert.ok(await page.isVisible(".fg-idea"), "first idea shown");
    // "I don't understand": the intro has no tip, so its key line, quoted
    let before = await msgCount(page);
    await page.click("[data-act=simpler]");
    await page.waitForFunction((n)=> document.querySelectorAll(".fg-chat .fg-msg").length > n, before);
    const simplerText = await page.evaluate(()=> [...document.querySelectorAll(".fg-chat .fg-msg-coach")].pop().textContent);
    assert.ok(simplerText.includes("In one line, the manual says:"), simplerText);
    assert.ok(simplerText.includes("Read in the manual"));
    // on to the first question, answered right
    while(await waiting(page) === "continue") await cont(page);
    const first = await answer(page, true);
    const right = await page.evaluate(()=> { const b = [...document.querySelectorAll(".fg-chat .fg-msg-coach")].pop(); return { cls:b.className, text:b.textContent }; });
    assert.ok(/is-right/.test(right.cls), "marked right");
    assert.ok(right.text.includes("Read in the manual"), "quotes its source");
    const src = QUESTIONS.get(first.qid).source;
    // the link opens the manual at that passage, and Back returns to the same conversation
    const n = await msgCount(page);
    await page.click(".fg-chat .fg-msg-coach.is-right [data-act=read]");
    await page.waitForFunction((b)=> location.hash === "#/coach/read/ch3/"+b, src.block);
    await page.waitForSelector("#blk-"+src.block.replace(".", "-")+".fg-flash");
    const inView = await page.evaluate((id)=>{ const r = document.getElementById(id).getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }, "blk-"+src.block.replace(".", "-"));
    assert.ok(inView, "passage scrolled into view");
    await page.screenshot({ path: path.join(SHOTS, "412-reader-at-passage.png") });
    await page.goBack();
    await page.waitForFunction(()=> location.hash === "#/coach/lesson/ch3");
    assert.strictEqual(await msgCount(page), n, "conversation kept");
    // next question, answered wrong: the correct answer is shown
    while(await waiting(page) === "continue") await cont(page);
    const second = await answer(page, false);
    const wrong = await page.evaluate(()=> { const b = [...document.querySelectorAll(".fg-chat .fg-msg-coach")].filter((x)=> /is-wrong/.test(x.className)).pop(); return b && b.textContent; });
    assert.ok(wrong && wrong.includes("Correct answer: " + QUESTIONS.get(second.qid).opts[QUESTIONS.get(second.qid).correct]), wrong);
    assert.ok(await page.isVisible('.fg-msg[data-i="'+second.msg+'"] .fg-opt.is-wrong'));
    assert.ok(await page.isVisible('.fg-msg[data-i="'+second.msg+'"] .fg-opt.is-right'));
    await page.screenshot({ path: path.join(SHOTS, "412-lesson-wrong.png") });
  });

  let missed;
  await t("lesson: the quiz covers the chapter, the score is saved, the next step follows the misses", async ()=>{
    missed = QUESTIONS.get("ch3.q5").id; // miss this one in the quiz
    await finishLesson(page, [missed]);
    const total = MANUAL.chapters.find((ch)=> ch.id === "ch3").questions.length;
    const quizLabels = await page.$$eval(".fg-q-label", (els)=> els.map((e)=> e.textContent).filter((x)=> x.startsWith("Quiz")));
    assert.strictEqual(quizLabels.length, total);
    assert.strictEqual(await page.textContent(".fg-result-n"), (total-1)+"/"+total);
    const next = await page.evaluate(()=> [...document.querySelectorAll(".fg-chat .fg-msg-coach")].pop().textContent);
    assert.ok(next.includes("You missed questions on"), next);
    assert.ok(await page.isVisible("[data-act=start-review][data-ch=ch3]"));
    // reflection: saved on the phone as you type
    await page.fill("#fgRef-ch3-0", "I help them count; they do the counting.");
    await page.waitForFunction(()=> document.querySelector('[data-saved="ch3"]').textContent === "Saved");
    await page.screenshot({ path: path.join(SHOTS, "412-lesson-done.png") });
    await page.click("[data-act=home]");
    await page.waitForFunction(()=> location.hash === "#/coach");
    assert.strictEqual((await lessonSub(page, "ch3")).trim(), "Quiz best "+(total-1)+" of "+total);
  });

  await t("weak spots: the missed question comes back with its choices reordered", async ()=>{
    assert.ok(!(await page.isDisabled("[data-act=start-review]")));
    await page.click("[data-act=start-review]");
    await page.waitForFunction(()=> location.hash === "#/coach/review");
    await heading(page, "Weak spots");
    const open = await openQuestion(page);
    assert.ok(QUESTIONS.get(open.qid).id.startsWith("ch3."));
    const manualOrder = QUESTIONS.get(open.qid).opts.map((_, i)=> i);
    assert.notDeepStrictEqual(open.order, manualOrder, "choices in a different order");
    await finishLesson(page, []);
    assert.ok(await page.isVisible(".fg-result"));
    await page.click("[data-act=home]");
    await page.waitForFunction(()=> location.hash === "#/coach");
  });

  await t("learners: a second learner starts clean; switching back finds everything; it survives a reload", async ()=>{
    await page.click("#fgNav-me");
    await page.waitForSelector("#fgProfiles");
    assert.ok((await page.textContent("#fgProfiles .fg-prof.is-active")).includes("Tendai"));
    await page.fill("form[data-act=add-profile] input", "Rudo");
    await page.click("form[data-act=add-profile] button");
    await page.waitForFunction(()=> document.querySelector("#fgProfiles .fg-prof.is-active") && document.querySelector("#fgProfiles .fg-prof.is-active").textContent.includes("Rudo"));
    await page.click("#fgNav-coach");
    await page.waitForFunction(()=> /Hi, Rudo/.test(document.querySelector("#fgMain .fg-lead").textContent));
    assert.ok(!(await lessonSub(page, "ch3")).includes("Quiz best"), "Rudo hasn't done ch3");
    assert.ok(await page.isDisabled("[data-act=start-review]"));
    assert.ok(await page.isDisabled("[data-act=start-daily]"));
    await page.goto(site.base+"#/coach/read/ch3");
    assert.strictEqual(await page.inputValue("#fgRef-ch3-0"), "", "Rudo doesn't see Tendai's reflection");
    // back to Tendai
    await page.click("#fgNav-me");
    await page.click("#fgProfiles .fg-prof:not(.is-active) [data-act=switch-profile]");
    await page.waitForFunction(()=> document.querySelector("#fgProfiles .fg-prof.is-active").textContent.includes("Tendai"));
    await page.reload();
    await page.click("#fgNav-coach");
    await page.waitForFunction(()=> /Hi, Tendai/.test(document.querySelector("#fgMain .fg-lead").textContent));
    assert.ok((await lessonSub(page, "ch3")).includes("Quiz best"));
    await page.goto(site.base+"#/coach/read/ch3");
    assert.strictEqual(await page.inputValue("#fgRef-ch3-0"), "I help them count; they do the counting.");
  });

  await t("learners: rename and remove go through the app's dialog", async ()=>{
    await page.goto(site.base+"#/me");
    await page.waitForSelector("#fgProfiles .fg-prof");
    const rudoRow = "#fgProfiles .fg-prof:not(.is-active)";
    await page.click(rudoRow+" [data-act=rename-profile]");
    await page.waitForSelector("#fgModal:not([hidden])");
    assert.strictEqual(await page.inputValue("#fgModalInput"), "Rudo");
    await page.screenshot({ path: path.join(SHOTS, "412-dialog-rename.png") });
    await page.fill("#fgModalInput", "Rudo M");
    await page.click("#fgModalOk");
    await page.waitForFunction(()=> document.querySelector("#fgProfiles").textContent.includes("Rudo M"));
    // Cancel leaves things alone; Remove deletes
    await page.click(rudoRow+" [data-act=remove-profile]");
    await page.waitForSelector("#fgModal:not([hidden])");
    await page.keyboard.press("Escape");
    assert.ok(await page.isHidden("#fgModal"));
    assert.strictEqual(await page.$$eval("#fgProfiles .fg-prof", (els)=> els.length), 2);
    await page.click(rudoRow+" [data-act=remove-profile]");
    await page.click("#fgModalOk");
    await page.waitForFunction(()=> document.querySelectorAll("#fgProfiles .fg-prof").length === 1);
    assert.ok((await page.textContent("#fgProfiles .fg-prof.is-active")).includes("Tendai"));
  });

  await t("daily practice: nothing due until there is; then it runs and starts a streak", async ()=>{
    // Everything Tendai has answered (all of ch3) is scheduled for later.
    await page.goto(site.base+"#/coach");
    await page.waitForSelector("[data-act=start-daily][disabled]");
    assert.strictEqual((await page.textContent("[data-act=start-daily]")).trim(), "Nothing due");
    // Opening chapter 1 makes its unseen questions part of today's practice.
    await page.click('[data-act=open-lesson][data-ch="ch1"]');
    await heading(page, "Our Ecosystem");
    await page.click("[data-act=home]");
    await page.waitForSelector("[data-act=start-daily]:not([disabled])");
    assert.strictEqual((await page.textContent("[data-act=start-daily]")).trim(), "Practise (5)");
    await page.click("[data-act=start-daily]");
    await page.waitForFunction(()=> location.hash === "#/coach/daily");
    await heading(page, "Daily practice");
    await finishLesson(page, []);
    assert.ok(await page.isVisible(".fg-result"));
    await page.click("[data-act=home]");
    await page.waitForFunction(()=>{ const s = document.getElementById("fgStreak"); return s && /Done today · 1-day streak/.test(s.textContent); });
  });

  await t("no console errors through all of the above", async ()=>{
    assert.deepStrictEqual(errors, []);
  });
  await ctx.close();

  await t("offline: after a reload with no network, a lesson still runs", async ()=>{
    const c = await browser.newContext({ viewport:{ width:412, height:915 } });
    const p = await c.newPage();
    const errs = watchErrors(p);
    await p.goto(site.base);
    await p.waitForFunction(()=> !!navigator.serviceWorker.controller);
    await createLearner(p, "Offline Test");
    await c.setOffline(true);
    await p.reload();
    await p.waitForSelector(".fg-lesson");
    await p.click('[data-act=open-lesson][data-ch="ch11"]');
    await p.waitForFunction(()=> location.hash === "#/coach/lesson/ch11");
    await p.waitForSelector(".fg-idea");
    while(await waiting(p) === "continue") await cont(p);
    await answer(p, true);
    assert.ok(await p.isVisible(".fg-msg-coach.is-right"));
    // a reload straight into the lesson, still offline
    await p.reload();
    await p.waitForSelector(".fg-idea");
    assert.strictEqual(await h1(p), "Coordinating Stocktakes");
    assert.deepStrictEqual(errs, []);
    await c.close();
  });

  for(const [w, h] of [[360, 640], [412, 915]]){
    await t("coach screens at "+w+"x"+h+": no sideways scroll, 48px answer buttons", async ()=>{
      const c = await browser.newContext({ viewport:{ width:w, height:h }, deviceScaleFactor:2, isMobile:true, hasTouch:true, colorScheme:"dark" });
      const p = await c.newPage();
      await p.goto(site.base);
      await createLearner(p, "Layout");
      const check = async (name)=>{
        const m = await p.evaluate(()=>({
          scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
          opts: [...document.querySelectorAll(".fg-opt:not([disabled]), .fg-actions .btn, .fg-lesson")].map((e)=> e.getBoundingClientRect().height),
        }));
        assert.ok(m.scrollW <= m.clientW, name+": "+m.scrollW+"px wide in "+m.clientW);
        for(const hgt of m.opts) assert.ok(hgt >= 44, name+": tap target "+hgt+"px high");
        await p.screenshot({ path: path.join(SHOTS, w+"-"+name+".png") });
      };
      await check("coach-home");
      await p.tap('[data-act=open-lesson][data-ch="ch11"]');
      await p.waitForSelector(".fg-idea");
      await check("lesson-idea");
      while(await waiting(p) === "continue") await cont(p);
      await check("lesson-question");
      await answer(p, false);
      await check("lesson-wrong");
      await p.goto(site.base+"#/coach/read/ch11/ch11.b13");
      await p.waitForSelector(".fg-flash");
      await check("reader-table");
      await p.goto(site.base+"#/me");
      await p.waitForSelector("#fgProfiles");
      await check("me-learners");
      await c.close();
    });
  }

  await browser.close();
  site.server.close();
  console.log("Screenshots: "+SHOTS);
  console.log(passed+" passed, "+failed+" failed");
  process.exit(failed? 1 : 0);
})();
