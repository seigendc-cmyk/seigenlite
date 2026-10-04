#!/usr/bin/env node
// Converts the RPN Field Manual (the interactive HTML training guide) into
// src/fieldguide/content/manual.json, the data the Field Guide's coach
// runs on. Build-time only (uses jsdom from devDependencies); build.js
// reads the JSON this writes and never runs this script.
//
//   node tools/fieldguide-content/convert-manual.js              write manual.json
//   node tools/fieldguide-content/convert-manual.js --candidates  list likely source
//        passages for every quiz question (to help edit question-sources.json)
//
// Nothing is rewritten. Every chapter, paragraph, table, list, tip and quiz
// question is copied as text, in order, from the source file (kept next to
// the JSON in content/source/ so the conversion can be re-run and checked).
// Inline formatting (bold/italic) is dropped; the words are not changed.
//
// Each block gets a stable id ("ch4.b07") and its text split into parts:
// sentences for a paragraph, rows for a table, items for a list, lines
// for a tip or "say this" box. A question's explanation is not written
// anywhere: it is a reference to the exact parts it came from, kept in
// question-sources.json, and the app quotes those parts. A question with
// no matching passage is marked "none" there and the app shows only the
// correct answer.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..", "..");
const CONTENT = path.join(ROOT, "src", "fieldguide", "content");
const SOURCE_NAME = "rpn-field-manual-interactive-2026-09-25.html";
const SOURCE = path.join(CONTENT, "source", SOURCE_NAME);
const SOURCES_MAP = path.join(CONTENT, "question-sources.json");
const OUT = path.join(CONTENT, "manual.json");

// Learning areas the manual doesn't cover yet. Empty on purpose: their
// lessons are added here as data later (same shape as a chapter), once the
// content has been supplied and reviewed. The app hides a track with no
// lessons, so these never show as placeholders.
const RESERVED_TRACKS = [
  { id: "licensing", title: "Licensing" },
  { id: "receipts-payments", title: "Receipts and payments" },
  { id: "staff-training", title: "Staff training" },
];

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

// Sentence split for paragraphs: after . ! ? (optionally followed by a
// closing quote), before a capital letter, digit or opening quote.
function sentences(text) {
  return norm(text)
    .split(/(?<=[.!?][”"’)]?)\s+(?=[A-Z0-9“"‘(])/)
    .map(norm)
    .filter(Boolean);
}

function decodeEntities(window, s) {
  const el = window.document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

function readJsonVar(html, name) {
  const m = html.match(new RegExp("var " + name + " = (\\{.*?\\});\\s*\\n"));
  if (!m) throw new Error("Couldn't find " + name + " in the source file");
  return JSON.parse(m[1]);
}

function slug(s) {
  return norm(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function convertBlock(el, id) {
  const tag = el.tagName.toLowerCase();
  const cls = el.className || "";
  if (tag === "p") return { id, type: "p", parts: sentences(el.textContent) };
  if (tag === "h2") return { id, type: "h2", parts: [norm(el.textContent)] };
  if (tag === "ol" || tag === "ul") {
    return { id, type: "list", ordered: tag === "ol", parts: [...el.querySelectorAll(":scope > li")].map((li) => norm(li.textContent)) };
  }
  if (tag === "table") {
    const head = [...el.querySelectorAll("thead th")].map((th) => norm(th.textContent));
    const rows = [...el.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => norm(td.textContent)));
    return { id, type: "table", head, parts: rows };
  }
  if (tag === "div" && /\b(tip|fieldnote|scriptbox)\b/.test(cls)) {
    const label = norm(el.querySelector(".tip-label").textContent);
    const lines = [...el.querySelectorAll("p")].map((p) => norm(p.textContent)).filter(Boolean);
    const type = /scriptbox/.test(cls) ? "say" : /fieldnote/.test(cls) ? "dont" : "tip";
    return { id, type, label, parts: lines };
  }
  if (tag === "div" && /\b(quiz|reflection)\b/.test(cls)) return null; // mounts, filled from the data below
  throw new Error("Unhandled block in " + id + ": <" + tag + " class=\"" + cls + "\">");
}

function convert() {
  const html = fs.readFileSync(SOURCE, "utf8");
  const dom = new JSDOM(html);
  const { window } = dom;
  const doc = window.document;
  const quiz = readJsonVar(html, "QUIZ_DATA");
  const reflections = readJsonVar(html, "REFLECTION_DATA");

  const chapters = [];
  const tracks = [];
  for (const section of doc.querySelectorAll("section.section[id^=ch]")) {
    const n = Number(section.id.slice(2));
    const head = section.querySelector(".chapter-head");
    const title = norm(head.querySelector("h1").textContent);
    const kicker = norm(head.querySelector(".kicker-sm").textContent);
    const iconSvg = head.querySelector(".chapter-icon svg");
    const icon = iconSvg
      ? iconSvg.innerHTML.replace(/#C1550C/gi, "currentColor").replace(/\s*\n\s*/g, "")
      : "";

    const blocks = [];
    const concepts = [{ id: "ch" + n + ".c0", title, blocks: [] }];
    let b = 0;
    for (const el of section.children) {
      if (el === head) continue;
      const block = convertBlock(el, "ch" + n + ".b" + String(++b).padStart(2, "0"));
      if (!block) { b--; continue; }
      if (block.type === "h2") {
        concepts.push({ id: "ch" + n + ".c" + concepts.length, title: block.parts[0], blocks: [] });
      }
      blocks.push(block);
      concepts[concepts.length - 1].blocks.push(block.id);
    }
    // An intro concept with nothing in it (chapter opens straight on a
    // heading) is dropped; ids of the others stay as they are.
    const usedConcepts = concepts.filter((c) => c.blocks.length);

    const questions = (quiz[String(n)] || []).map((item, i) => ({
      id: "ch" + n + ".q" + (i + 1),
      q: decodeEntities(window, item.q),
      opts: item.opts.map((o) => decodeEntities(window, o)),
      correct: item.correct,
    }));

    let track = tracks.find((t) => t.title === kicker);
    if (!track) {
      track = { id: slug(kicker), title: kicker, lessons: [] };
      tracks.push(track);
    }
    track.lessons.push("ch" + n);

    chapters.push({
      id: "ch" + n,
      n,
      title,
      track: track.id,
      icon,
      blocks,
      concepts: usedConcepts,
      questions,
      reflections: (reflections[String(n)] || []).map((p) => decodeEntities(window, p)),
    });
  }
  return { html, chapters, tracks };
}

function blockIndex(chapters) {
  const map = new Map();
  for (const ch of chapters) for (const b of ch.blocks) map.set(b.id, { ch, b });
  return map;
}

function attachSources(chapters) {
  const sources = JSON.parse(fs.readFileSync(SOURCES_MAP, "utf8"));
  const blocks = blockIndex(chapters);
  const problems = [];
  for (const ch of chapters) {
    for (const q of ch.questions) {
      const ref = sources[q.id];
      if (!ref) { problems.push(q.id + ": missing from question-sources.json"); continue; }
      if (ref.none) { q.source = null; q.concept = ch.concepts[0].id; continue; }
      const hit = blocks.get(ref.block);
      if (!hit) { problems.push(q.id + ": unknown block " + ref.block); continue; }
      if (!Array.isArray(ref.parts) || !ref.parts.length) problems.push(q.id + ": no parts listed");
      for (const p of ref.parts || []) {
        if (!(p >= 0 && p < hit.b.parts.length)) problems.push(q.id + ": " + ref.block + " has no part " + p);
      }
      q.source = { block: ref.block, parts: ref.parts };
      if (hit.ch !== ch) q.source.crossChapter = true;
      // The idea the question tests: the section its source passage is in.
      q.concept = hit.ch.concepts.find((c) => c.blocks.includes(ref.block)).id;
    }
  }
  for (const id of Object.keys(sources)) {
    if (id.startsWith("_")) continue;
    if (!chapters.some((ch) => ch.questions.some((q) => q.id === id))) problems.push(id + ": no such question");
  }
  if (problems.length) throw new Error("question-sources.json:\n  " + problems.join("\n  "));
}

// --candidates: for each question, the passages sharing the most words
// with the question and its correct answer. A starting point for a person
// to choose from, never written into the data by itself.
const STOP = new Set("that this with your they their them what when which from have been will would should could about into than then there these those only also just more most much very does doesn while where after before because being other some every each such over under onto upon".split(" "));
const words = (s) => (norm(s).toLowerCase().match(/[a-z0-9']{4,}/g) || []).filter((w) => !STOP.has(w));
function printCandidates(chapters) {
  for (const ch of chapters) {
    for (const q of ch.questions) {
      const want = new Set(words(q.q + " " + q.opts[q.correct]));
      const scored = [];
      for (const b of ch.blocks) {
        b.parts.forEach((part, i) => {
          const text = Array.isArray(part) ? part.join(" — ") : part;
          const got = new Set(words(text));
          let hit = 0;
          for (const w of got) if (want.has(w)) hit++;
          if (hit) scored.push({ ref: b.id + "#" + i, hit, text });
        });
      }
      scored.sort((a, b) => b.hit - a.hit);
      console.log("\n" + q.id + "  " + q.q + "\n   = " + q.opts[q.correct]);
      for (const s of scored.slice(0, 4)) console.log("   " + s.hit + "  " + s.ref + "  " + s.text.slice(0, 150));
    }
  }
}

const { html, chapters, tracks } = convert();
// --dump [ch3 ch5 ...]: every block with numbered parts, to look up ids.
if (process.argv.includes("--dump")) {
  const only = process.argv.slice(process.argv.indexOf("--dump") + 1);
  for (const ch of chapters) {
    if (only.length && !only.includes(ch.id)) continue;
    console.log("\n=== " + ch.id + " " + ch.title + " [" + ch.track + "]");
    for (const b of ch.blocks) {
      console.log(b.id + " " + b.type + (b.label ? " (" + b.label + ")" : ""));
      b.parts.forEach((p, i) => console.log("   #" + i + " " + (Array.isArray(p) ? p.join(" | ") : p)));
    }
  }
  process.exit(0);
}
if (process.argv.includes("--candidates")) {
  printCandidates(chapters);
  process.exit(0);
}
attachSources(chapters);
const questions = chapters.reduce((n, ch) => n + ch.questions.length, 0);
const sourced = chapters.reduce((n, ch) => n + ch.questions.filter((q) => q.source).length, 0);
const manual = {
  schema: 1,
  source: {
    title: "RPN Field Manual (Interactive)",
    file: "source/" + SOURCE_NAME,
    sha256: crypto.createHash("sha256").update(html).digest("hex"),
  },
  tracks: tracks.concat(RESERVED_TRACKS.map((t) => Object.assign({ reserved: true, lessons: [] }, t))),
  chapters,
};
fs.writeFileSync(OUT, JSON.stringify(manual, null, 1) + "\n");
console.log(
  "Wrote " + path.relative(ROOT, OUT) + ": " + chapters.length + " chapters, " +
  chapters.reduce((n, ch) => n + ch.blocks.length, 0) + " blocks, " +
  questions + " questions (" + sourced + " with a source, " + (questions - sourced) + " no source), " +
  chapters.reduce((n, ch) => n + ch.reflections.length, 0) + " reflection prompts."
);
