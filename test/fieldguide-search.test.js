// Run: node --no-warnings test/fieldguide-search.test.js
// The RPN Field Guide's search (src/fieldguide/search.js) under plain Node:
// word order, filler words, plurals, typos, synonyms, ranking, honest
// no-match, the source registry, and that every answer it shows is quoted
// word for word from the manual's source HTML.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const CONTENT = path.join(ROOT, "src", "fieldguide", "content");
const read = (f) => JSON.parse(fs.readFileSync(path.join(CONTENT, f), "utf8"));
const MANUAL = read("manual.json");
const WORDS = read("synonyms.json");

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 6).join("\n       ")); }
}

function load() {
  const ctx = { MANUAL, COACH_LINES: read("coach-lines.json"), SEARCH_WORDS: WORDS };
  vm.createContext(ctx);
  const code = ["coach-engine.js", "search.js"].map((f) => fs.readFileSync(path.join(ROOT, "src", "fieldguide", f), "utf8")).join("\n");
  return vm.runInContext(code + "\n;({ buildSearchIndex, runSearch, searchWords, searchQueryWords, registerSearchSource, searchExamples, SEARCH_FIELD_WEIGHT, questionOf, conceptOf })", ctx);
}
const S = load();
const index = S.buildSearchIndex();
const plain = (x) => JSON.parse(JSON.stringify(x));
const search = (q, opts) => plain(S.runSearch(index, q, opts));
const answerOf = (q) => { const r = search(q); return r.state === "answer" ? r.answer : null; };
const chapterOfAnswer = (q) => { const a = answerOf(q); return a ? a.chapterId : "nomatch"; };

// The source HTML, block by block, for the verbatim check.
const SOURCE_TEXT = (function () {
  const { JSDOM } = require("jsdom");
  const doc = new JSDOM(fs.readFileSync(path.join(CONTENT, MANUAL.source.file), "utf8")).window.document;
  const map = new Map();
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  [...doc.querySelectorAll("section.section[id^=ch]")].forEach((sec, i) => {
    const els = [...sec.children].filter((el) => !/chapter-head|quiz|reflection/.test(el.className));
    els.forEach((el, j) => map.set(MANUAL.chapters[i].blocks[j].id, norm(el.textContent)));
  });
  return map;
})();
function assertVerbatim(answer, label) {
  const source = SOURCE_TEXT.get(answer.block);
  assert.ok(source, label + ": no source block " + answer.block);
  for (const line of answer.lines) {
    // a table row is quoted as "cell — cell"; a gap between sentences as "…"
    for (const piece of line.split(/ — | … /)) {
      assert.ok(source.includes(piece), label + ": not verbatim in " + answer.block + ":\n         " + piece);
    }
  }
}

// ---------------- words ----------------
t("filler words are dropped; content words are kept", () => {
  assert.deepStrictEqual(plain(S.searchWords("How do I start a stocktake?")), ["start", "stocktake"]);
  assert.deepStrictEqual(plain(S.searchWords("What is the day rate")), ["day", "price"]);
  assert.deepStrictEqual(chapterOfAnswer("what is the day rate"), chapterOfAnswer("day rate"));
});

t("any word order gives the same answer", () => {
  for (const [a, b] of [["day rate", "rate day"], ["remote branch main", "main remote branch"], ["worker stocktake pays who", "who pays the stocktake worker"]]) {
    const x = answerOf(a), y = answerOf(b);
    assert.ok(x && y, a);
    assert.deepStrictEqual([x.block, x.parts], [y.block, y.parts], a + " vs " + b);
  }
});

t("plurals and simple spelling mistakes still find the words", () => {
  assert.deepStrictEqual(plain(S.searchWords("vendors batches stocktakes reports")), ["vendor", "batch", "stocktake", "report"]);
  const typos = plain(S.searchQueryWords(index, "stoktake hesitent spredsheet"));
  assert.deepStrictEqual(typos.map((w) => w.word), ["stocktake", "hesitant", "spreadsheet"]);
  assert.strictEqual(chapterOfAnswer("stoktake in batches"), "ch11");
  assert.strictEqual(chapterOfAnswer("the vendor is hesitent"), "ch5");
  // while typing, an unfinished last word matches a word it starts
  assert.strictEqual(search("hesit", { typing: true }).answer.chapterId, "ch5");
  assert.strictEqual(search("hesit").state, "nomatch", "not once typing has finished");
});

t("synonyms: everyday variants read as one word, phrases included", () => {
  assert.deepStrictEqual(plain(S.searchWords("stock take")), ["stocktake"]);
  assert.deepStrictEqual(plain(S.searchWords("stock-take counting")), ["stocktake"].concat(["stocktake"]));
  assert.deepStrictEqual(plain(S.searchWords("how much is a visit")), ["price", "visit"]);
  assert.deepStrictEqual(plain(S.searchWords("cell phone not working")), ["phone", "problem"]);
  assert.strictEqual(chapterOfAnswer("how much is a visit"), chapterOfAnswer("visit price"));
});

t("synonyms.json: no word in two groups, nothing that isn't wording", () => {
  const seen = new Map();
  for (const group of WORDS.synonyms) {
    for (const v of group) {
      const key = plain(S.searchWords(v)).join(" ") || v;
      assert.ok(!seen.has(v.toLowerCase()), "'" + v + "' is in two groups");
      seen.set(v.toLowerCase(), group[0]);
    }
    assert.ok(group.every((v) => !/\d/.test(v) && v.length <= 20), "group " + group[0] + " looks like more than a word variant");
  }
  for (const f of WORDS.filler) assert.ok(/^[a-z]+$/.test(f), "filler: " + f);
});

// ---------------- ranking ----------------
t("ranking: title > chapter title > section text > question text", () => {
  const w = S.SEARCH_FIELD_WEIGHT;
  assert.ok(w.title > w.chapter && w.chapter > w.text && w.text > w.question);
  // a section titled with the words beats sections that only mention them
  const a = answerOf("reading hesitation");
  assert.strictEqual(S.conceptOf(a.conceptId).title, "Reading hesitation");
  const b = answerOf("main remote branch");
  assert.strictEqual(S.conceptOf(b.conceptId).title, "Main vs Remote branch — decide by role, not by device");
  // "who pays the stocktake worker" is also, almost word for word, quiz
  // question ch11.q4; the answer is still the manual section, and the
  // question is offered underneath, under "Questions"
  const r = search("who pays the stocktake worker");
  assert.strictEqual(r.answer.conceptId, S.questionOf("ch11.q4").concept);
  assert.ok(r.more.some((d) => d.kind === "question" && d.id === "ch11.q4"));
  assert.ok(r.more.length <= 5);
  // a word found in a section's text outranks the same word in a question:
  // "batches" is in ch11's section and in quiz question ch11.q7
  const batch = search("batches");
  assert.strictEqual(batch.answer.chapterId, "ch11");
  assert.ok(batch.more.findIndex((d) => d.kind === "question") === -1 || batch.more.findIndex((d) => d.kind === "question") >= batch.more.filter((d) => d.kind === "section").length);
});

t("words found together in one passage beat words scattered across a section", () => {
  const a = answerOf("what should I wear to a visit");
  assert.ok(a.lines[0].includes("dress"), a.lines[0]);
  assert.notStrictEqual(a.chapterId, "ch2", "not the manual's table of contents");
});

// ---------------- answers ----------------
t("no match: says so, never answers, offers the nearest lessons", () => {
  const none = search("what is the refund policy");
  assert.strictEqual(none.state, "nomatch");
  assert.strictEqual(none.partial, false);
  assert.ok(!("answer" in none));
  const near = search("how do I fix a cracked phone screen");
  assert.strictEqual(near.state, "nomatch");
  assert.ok(near.partial && near.nearest.length <= 3 && near.nearest.includes("ch10"), JSON.stringify(near.nearest));
  assert.strictEqual(search("   the of and   ").state, "empty");
});

t("an answer carries the questions to practise: that section's, else its chapter's", () => {
  const a = answerOf("who pays the stocktake worker");
  assert.ok(a.practice.length >= 1 && a.practice.every((id) => S.questionOf(id)));
  assert.ok(a.practice.includes("ch11.q4"));
});

const REALISTIC = [
  "how do I start a stocktake", "what is the day rate", "vendor can't print", "who pays the stocktake worker",
  "main or remote branch", "the app shows a blank screen", "vendor lost their data", "activation code not accepted",
  "what should I wear to a visit", "how do I end a visit", "the vendor is hesitant", "what are search words",
  "do I count the stock myself", "difference between credit and directory", "who uploads the spreadsheet",
  "does the app work offline", "how much is a visit", "what do I report to my manager", "stoktake in batches",
  "explain EOD to a vendor", "vendor wants more customers", "how do I add products quickly",
  "what is the refund policy", "how do I fix a cracked phone screen", "can the vendor give discounts",
];

t("every answer shown is quoted word for word from the manual's source", () => {
  const queries = REALISTIC.slice();
  for (const ch of MANUAL.chapters) {
    for (const c of ch.concepts) queries.push(c.title);
    for (const q of ch.questions) queries.push(q.q);
    for (const r of ch.reflections) queries.push(r);
  }
  let answered = 0;
  for (const q of queries) {
    for (const typing of [false, true]) {
      const a = search(q, { typing }).answer;
      if (!a) continue;
      answered++;
      assertVerbatim(a, q);
    }
  }
  assert.ok(answered > queries.length, "most queries answered (" + answered + ")");
});

t("realistic questions land in the right chapter (the ones that should)", () => {
  const expect = {
    "what is the day rate": "ch11", "vendor can't print": "ch9", "who pays the stocktake worker": "ch11",
    "main or remote branch": "ch7", "the app shows a blank screen": "ch10", "vendor lost their data": "ch10",
    "activation code not accepted": "ch10", "what should I wear to a visit": "ch4", "how do I end a visit": "ch4",
    "the vendor is hesitant": "ch5", "what are search words": "ch11", "do I count the stock myself": "ch11",
    "difference between credit and directory": "ch8", "how much is a visit": "ch12", "what do I report to my manager": "ch12",
    "stoktake in batches": "ch11", "explain EOD to a vendor": "ch8", "what is the refund policy": "nomatch",
    "how do I fix a cracked phone screen": "nomatch",
  };
  for (const [q, ch] of Object.entries(expect)) assert.strictEqual(chapterOfAnswer(q), ch, q);
});

// ---------------- sources ----------------
t("new kinds of content plug in as a source, with no change to the matcher", () => {
  const S2 = load();
  S2.registerSearchSource("task", "Your tasks", () => [{ id: "t1", kind: "task", chapterId: "ch10", fields: { title: "Follow up printer for Mai Tendai Grocers" } }]);
  const idx = S2.buildSearchIndex();
  assert.strictEqual(idx.groups.task, "Your tasks");
  const hit = idx.docs.find((d) => d.id === "t1");
  assert.ok(hit.all.has("print"), "indexed through the same words pipeline (printer -> print)");
  // The manual has no passage about this, so there is no quoted answer, but
  // the task itself is listed under its own group.
  const r = plain(S2.runSearch(idx, "follow up printer grocers"));
  assert.strictEqual(r.state, "nomatch");
  assert.ok(!("answer" in r));
  assert.deepStrictEqual(r.more.map((d) => d.id), ["t1"]);
});

t("example questions are real section titles", () => {
  const titles = new Set(MANUAL.chapters.flatMap((ch) => ch.concepts.map((c) => c.title)));
  for (let day = 0; day < 10; day++) {
    const ex = plain(S.searchExamples(day, 4));
    assert.strictEqual(ex.length, 4);
    assert.ok(ex.every((x) => titles.has(x)));
  }
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
