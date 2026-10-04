// Run: node --no-warnings test/fieldguide-engine.test.js
// The RPN Field Guide's content and coach engine, under plain Node:
//   * manual.json says exactly what the source manual says: every block,
//     quiz question and reflection prompt is compared with the source HTML
//     (whitespace ignored), so nothing was rewritten, dropped or invented
//   * every quiz explanation points at real text; the "no source" ones are
//     listed, and counted
//   * the engine's rules: spaced repetition, choice re-ordering, weak spots,
//     daily practice and streaks, the lesson loop, "I don't understand",
//     right/wrong/streak/stuck reactions
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const CONTENT = path.join(ROOT, "src", "fieldguide", "content");
const MANUAL = JSON.parse(fs.readFileSync(path.join(CONTENT, "manual.json"), "utf8"));
const LINES = JSON.parse(fs.readFileSync(path.join(CONTENT, "coach-lines.json"), "utf8"));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}

// The engine, loaded the way build.js inlines it (MANUAL/COACH_LINES as consts).
function loadEngine() {
  const ctx = { MANUAL, COACH_LINES: LINES };
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(ROOT, "src", "fieldguide", "coach-engine.js"), "utf8");
  return vm.runInContext(code + "\n;({ COACH, newProgress, optionOrder, grade, conceptMastery, weakQuestions, dailyQuestions, dailyDoneToday, recordDaily, dayKey, lessonProgress, suggestNext, ideaBlocks, simplerOptions, nearestConcept, startLesson, startReview, startDaily, answer, cont, simpler, sourceQuote, quoteParts, blockOf, questionOf, conceptOf, BOX_DAYS, DAY_MS })", ctx);
}
const E = loadEngine();
const plain = (x) => JSON.parse(JSON.stringify(x)); // values from the vm realm
const squash = (s) => String(s).replace(/\s+/g, "");
const NOW = new Date(2026, 9, 3, 10, 0, 0).getTime();

// ---------------- content ----------------
t("manual.json matches the source manual block for block (no words changed)", () => {
  const { JSDOM } = require("jsdom");
  const html = fs.readFileSync(path.join(CONTENT, MANUAL.source.file), "utf8");
  assert.strictEqual(require("crypto").createHash("sha256").update(html).digest("hex"), MANUAL.source.sha256, "source file changed since conversion");
  const doc = new JSDOM(html).window.document;
  const sections = [...doc.querySelectorAll("section.section[id^=ch]")];
  assert.strictEqual(sections.length, MANUAL.chapters.length);
  sections.forEach((sec, i) => {
    const ch = MANUAL.chapters[i];
    assert.strictEqual(squash(sec.querySelector(".chapter-head h1").textContent), squash(ch.title));
    const els = [...sec.children].filter((el) => !el.classList.contains("chapter-head") && !el.classList.contains("quiz") && !el.classList.contains("reflection"));
    assert.strictEqual(els.length, ch.blocks.length, ch.id + " block count");
    els.forEach((el, j) => {
      const b = ch.blocks[j];
      const ours = (b.label || "") + (b.head || []).join("") + b.parts.map((p) => (Array.isArray(p) ? p.join("") : p)).join("");
      assert.strictEqual(squash(ours), squash(el.textContent), b.id);
    });
  });
});

t("quiz questions and reflection prompts are the manual's, in its order", () => {
  const { JSDOM } = require("jsdom");
  const html = fs.readFileSync(path.join(CONTENT, MANUAL.source.file), "utf8");
  const win = new JSDOM("").window;
  const decode = (s) => { const el = win.document.createElement("textarea"); el.innerHTML = s; return el.value; };
  const grab = (name) => JSON.parse(html.match(new RegExp("var " + name + " = (\\{.*?\\});\\s*\\n"))[1]);
  const quiz = grab("QUIZ_DATA"), refl = grab("REFLECTION_DATA");
  for (const ch of MANUAL.chapters) {
    const src = quiz[String(ch.n)];
    assert.strictEqual(ch.questions.length, src.length, ch.id);
    ch.questions.forEach((q, i) => {
      assert.strictEqual(q.q, decode(src[i].q));
      assert.deepStrictEqual(q.opts, src[i].opts.map(decode));
      assert.strictEqual(q.correct, src[i].correct);
    });
    assert.deepStrictEqual(ch.reflections, refl[String(ch.n)].map(decode));
  }
});

t("quiz coverage: 60 questions, 59 with a source, 1 marked no source", () => {
  const all = MANUAL.chapters.flatMap((ch) => ch.questions);
  const none = all.filter((q) => !q.source).map((q) => q.id);
  assert.strictEqual(all.length, 60);
  assert.deepStrictEqual(none, ["ch5.q4"]);
  for (const q of all.filter((x) => x.source)) {
    const quote = plain(E.sourceQuote(q));
    assert.ok(quote.lines.length && quote.lines.every((l) => l.length > 10), q.id);
    // every quoted line is text that is in the source block
    const b = E.blockOf(q.source.block);
    const text = squash(b.parts.map((p) => (Array.isArray(p) ? p.join("") : p)).join(""));
    for (const l of quote.lines) for (const piece of l.split(/ — | … /)) assert.ok(text.includes(squash(piece)), q.id + ": " + piece);
  }
  // a gap in the manual shows as "…" in the quote
  assert.ok(plain(E.sourceQuote(E.questionOf("ch7.q1"))).lines[0].includes(" … "));
  assert.ok(!plain(E.sourceQuote(E.questionOf("ch3.q2"))).lines[0].includes("…"));
  const cross = all.filter((q) => q.source && q.source.crossChapter).map((q) => q.id);
  assert.deepStrictEqual(cross, ["ch6.q4"]);
});

t("tracks: the manual's own chapter groups, plus reserved empty slots", () => {
  const reserved = MANUAL.tracks.filter((tr) => tr.reserved);
  assert.deepStrictEqual(reserved.map((tr) => tr.id), ["licensing", "receipts-payments", "staff-training"]);
  assert.ok(reserved.every((tr) => tr.lessons.length === 0));
  const used = MANUAL.tracks.filter((tr) => !tr.reserved).flatMap((tr) => tr.lessons);
  assert.deepStrictEqual(used, MANUAL.chapters.map((ch) => ch.id));
});

t("coach lines: every key the engine uses exists, and only known placeholders", () => {
  const code = fs.readFileSync(path.join(ROOT, "src", "fieldguide", "coach-engine.js"), "utf8");
  const used = new Set([...code.matchAll(/coachLine\(s, "(\w+)"/g)].map((m) => m[1]).concat(["simplerTip", "simplerLine", "quizPerfect", "quizGood", "quizLow", "dailyStart", "dailyNothingDue", "dailyEmpty", "reviewStart", "reviewEmpty", "dailyDone", "reviewDone"]));
  for (const k of used) assert.ok(Array.isArray(LINES[k]) && LINES[k].length, "missing line: " + k);
  for (const [k, list] of Object.entries(LINES)) {
    if (k.startsWith("_")) continue;
    for (const line of list) for (const m of line.matchAll(/\{(\w+)\}/g)) assert.ok(["title", "n", "score", "total", "topics", "lesson"].includes(m[1]), k + ": {" + m[1] + "}");
  }
});

// ---------------- engine ----------------
t("choices: manual order the first time, a different order every time after", () => {
  const p = E.newProgress("a");
  const qid = "ch4.q2";
  let order = plain(E.optionOrder(p, qid));
  assert.deepStrictEqual(order, [0, 1, 2]);
  for (let i = 0; i < 6; i++) {
    E.grade(p, qid, 0, order, NOW + i);
    const next = plain(E.optionOrder(p, qid));
    assert.notDeepStrictEqual(next, order, "repeat " + i);
    assert.deepStrictEqual(next.slice().sort(), [0, 1, 2]);
    order = next;
  }
});

t("spaced repetition: right moves up a box (later), wrong drops to box 0 (due now)", () => {
  const p = E.newProgress("a");
  const q = E.questionOf("ch3.q1");
  E.grade(p, "ch3.q1", q.correct, [0, 1, 2], NOW);
  assert.strictEqual(p.q["ch3.q1"].box, 1);
  assert.strictEqual(p.q["ch3.q1"].due, NOW + E.BOX_DAYS[1] * E.DAY_MS);
  E.grade(p, "ch3.q1", q.correct, [0, 1, 2], NOW);
  assert.strictEqual(p.q["ch3.q1"].box, 2);
  E.grade(p, "ch3.q1", (q.correct + 1) % 3, [0, 1, 2], NOW);
  assert.strictEqual(p.q["ch3.q1"].box, 0);
  assert.strictEqual(p.q["ch3.q1"].due, NOW);
  assert.strictEqual(E.conceptMastery(p, q.concept), 0);
});

t("weak spots: a miss is listed until it's answered right", () => {
  const p = E.newProgress("a");
  const q = E.questionOf("ch7.q2");
  E.grade(p, q.id, (q.correct + 1) % q.opts.length, [0, 1, 2], NOW);
  assert.deepStrictEqual(plain(E.weakQuestions(p)), [q.id]);
  assert.deepStrictEqual(plain(E.weakQuestions(p, "ch3")), []);
  const s = E.startReview(p, null, NOW);
  assert.strictEqual(s.await, "answer");
  const shown = s.log[s.log.length - 1];
  assert.notDeepStrictEqual(plain(shown.order), [0, 1, 2], "comes back in a different order");
  E.answer(s, p, q.correct, NOW + 1000);
  assert.deepStrictEqual(plain(E.weakQuestions(p)), []);
  E.cont(s, p, NOW + 2000);
  assert.strictEqual(s.await, "done");
  assert.strictEqual(s.log[s.log.length - 1].type, "result");
});

t("daily practice: empty before any lesson; due first; streak counts days in a row", () => {
  const p = E.newProgress("a");
  assert.deepStrictEqual(plain(E.dailyQuestions(p, NOW)), []);
  const empty = E.startDaily(p, NOW);
  assert.strictEqual(empty.await, "done");
  assert.strictEqual(empty.log[0].text, LINES.dailyEmpty[0]);
  E.startLesson(p, "ch2", NOW);
  const due = E.questionOf("ch9.q1");
  E.grade(p, due.id, (due.correct + 1) % 3, [0, 1, 2], NOW);
  const list = plain(E.dailyQuestions(p, NOW + 1));
  assert.strictEqual(list[0], due.id, "due question first");
  assert.ok(list.length <= 5 && list.slice(1).every((id) => id.startsWith("ch2.")));
  E.recordDaily(p, NOW);
  assert.strictEqual(p.daily.streak, 1);
  E.recordDaily(p, NOW + 3600000);
  assert.strictEqual(p.daily.streak, 1, "same day doesn't count twice");
  E.recordDaily(p, NOW + E.DAY_MS);
  assert.strictEqual(p.daily.streak, 2);
  E.recordDaily(p, NOW + 3 * E.DAY_MS);
  assert.strictEqual(p.daily.streak, 1, "a missed day restarts it");
  assert.strictEqual(p.daily.best, 2);
  assert.ok(E.dailyDoneToday(p, NOW + 3 * E.DAY_MS));
});

t("lesson loop: idea, check per idea, full quiz, score saved, next step from misses", () => {
  const p = E.newProgress("a");
  const ch = E.COACH.chapters.get("ch3");
  const s = E.startLesson(p, "ch3", NOW);
  assert.strictEqual(s.log[0].type, "coach");
  assert.ok(s.log[0].text.includes("Who You Are Out There"));
  assert.strictEqual(s.log[1].type, "idea");
  assert.strictEqual(s.await, "continue");
  let guard = 0, missedOne = false;
  while (s.await !== "done" && guard++ < 100) {
    if (s.await === "continue") { E.cont(s, p, NOW); continue; }
    const m = s.log[s.log.length - 1];
    const q = E.questionOf(m.qid);
    // miss the first quiz question, get everything else right
    const miss = m.mode === "quiz" && !missedOne;
    if (miss) missedOne = true;
    E.answer(s, p, miss ? (q.correct + 1) % q.opts.length : q.correct, NOW);
    const why = s.log.filter((x) => x.type === "why").pop();
    assert.strictEqual(why.correct, !miss);
  }
  assert.strictEqual(s.await, "done");
  const checks = s.log.filter((m) => m.type === "question" && m.mode === "check").length;
  const quiz = s.log.filter((m) => m.type === "question" && m.mode === "quiz").length;
  assert.strictEqual(quiz, ch.questions.length);
  assert.ok(checks >= 1 && checks <= ch.concepts.length);
  const L = p.lessons.ch3;
  assert.strictEqual(L.total, ch.questions.length);
  assert.strictEqual(L.best, ch.questions.length - 1);
  assert.deepStrictEqual(plain(L.missed), [ch.questions[0].id]);
  const next = s.log.find((m) => m.type === "next");
  assert.strictEqual(next.action, "review");
  assert.ok(s.log.some((m) => m.type === "reflect" && m.chapterId === "ch3"));
  assert.strictEqual(plain(E.suggestNext(p)).kind, "review");
  assert.strictEqual(E.lessonProgress(p, "ch3"), L.best / L.total);
});

t("streak and stuck reactions are data-driven lines", () => {
  const p = E.newProgress("a");
  const s = E.startDaily(p, NOW); // empty; use a lesson for questions instead
  const L = E.startLesson(p, "ch4", NOW);
  let rights = 0;
  while (rights < 3) {
    if (L.await === "continue") { E.cont(L, p, NOW); continue; }
    const q = E.questionOf(L.log[L.log.length - 1].qid);
    E.answer(L, p, q.correct, NOW);
    rights++;
  }
  const lastWhy = L.log.filter((m) => m.type === "why").pop();
  assert.ok(LINES.streak.some((l) => lastWhy.text.includes(l.replace("{n}", "3"))), lastWhy.text);
  // the same question missed twice -> stuck
  const p2 = E.newProgress("b");
  const q = E.questionOf("ch10.q1");
  E.grade(p2, q.id, (q.correct + 1) % q.opts.length, [0, 1, 2], NOW);
  const r = E.startReview(p2, null, NOW);
  E.answer(r, p2, (q.correct + 1) % q.opts.length, NOW);
  const stuck = r.log.find((m) => m.stuck);
  assert.ok(stuck && LINES.stuck.includes(stuck.text));
  assert.ok(s);
});

t("I don't understand: the manual's own tip, then its key line, then an honest pointer", () => {
  // ch3's "The line you don't cross" has a tip held back from the idea card
  const cid = E.COACH.chapters.get("ch3").concepts.find((c) => c.title === "The line you don't cross").id;
  const opts = plain(E.simplerOptions(cid));
  assert.strictEqual(opts[0].kind, "tip");
  assert.ok(!plain(E.ideaBlocks(cid)).includes(opts[0].block), "tip not already shown");
  assert.strictEqual(opts[opts.length - 1].kind, "line");
  const p = E.newProgress("a");
  const s = E.startLesson(p, "ch3", NOW);
  while (!(s.current && s.current.conceptId === cid)) {
    if (s.await === "continue") E.cont(s, p, NOW);
    else E.answer(s, p, E.questionOf(s.log[s.log.length - 1].qid).correct, NOW);
  }
  const seen = [];
  for (let i = 0; i < opts.length + 1; i++) seen.push(plain(E.simpler(s)));
  assert.deepStrictEqual(seen.slice(0, opts.length).map((m) => m.block), opts.map((o) => o.block));
  for (const m of seen.slice(0, opts.length)) {
    const text = squash(E.blockOf(m.block).parts.join(""));
    for (const l of plain(E.quoteParts(E.blockOf(m.block), m.parts))) assert.ok(text.includes(squash(l)));
  }
  const last = seen[seen.length - 1];
  assert.ok(last.type === "nearest" || last.type === "coach");
  if (last.type === "nearest") assert.notStrictEqual(last.conceptId, cid);
  else assert.strictEqual(last.text, LINES.simplerNone[0]);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
