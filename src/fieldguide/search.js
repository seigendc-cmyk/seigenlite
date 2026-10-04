  // ================== RPN Field Guide — search (Phase 3) ==================
  // Rules only, offline, no LLM. Matches the words of a question against an
  // index of the manual, in any order, and answers by quoting the manual:
  // nothing here writes an answer, it only picks which passage to quote.
  //
  // Not the core app's cart search (utils.js searchTokens/rankProductsBySearch):
  // that is a plain lower-case substring match with no filler words, plurals,
  // typos or synonyms, and reusing it would have meant changing core code.
  // This keeps its two rules (words in any order; rank by how many words
  // matched, title hits first) and adds the rest:
  //   * lower-case, punctuation and apostrophes dropped, simple plurals
  //     removed ("vendors" -> "vendor")
  //   * SEARCH_WORDS (content/synonyms.json): filler words dropped, and each
  //     group of everyday variants read as one word ("stock take" -> stocktake)
  //   * a word the manual doesn't contain is read as the manual word one or
  //     two letters away (typos), or, while typing, the word it starts
  //   * rarer words count for more (inverse document frequency), and where
  //     a word is found counts: section title 3 > chapter title 2.5 >
  //     section text 2 > question or reflection text 1
  //
  // The index is a list of documents from SEARCH_SOURCES. Each source is
  // plain data in, documents out, so later phases can add forms help, the
  // RPN's tasks or receipts with registerSearchSource() and no matcher change.

  const SEARCH_FIELD_WEIGHT = { title: 3, chapter: 2.5, text: 2, question: 1, prompt: 1 };
  const SEARCH_GOOD = 0.6; // share of the question's (weighted) words a result must cover to count as an answer
  const SEARCH_MORE = 5; // further results under the answer

  // ---------------- words ----------------
  function searchStem(w) {
    if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.length > 4 && /(xes|ches|shes|sses)$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function searchRawTokens(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[’'`]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .map(searchStem);
  }
  // Phrase and word variants -> one canonical word, longest phrase first.
  const SEARCH_LEXICON = (function () {
    const phrases = new Map(); // first token -> [{tokens, canon}]
    for (const group of SEARCH_WORDS.synonyms) {
      const canon = searchRawTokens(group[0]).join(" ");
      for (const variant of group) {
        const tokens = searchRawTokens(variant);
        if (!tokens.length) continue;
        if (!phrases.has(tokens[0])) phrases.set(tokens[0], []);
        phrases.get(tokens[0]).push({ tokens, canon });
      }
    }
    for (const list of phrases.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
    const filler = new Set(SEARCH_WORDS.filler.map((w) => searchRawTokens(w).join(" ")));
    return { phrases, filler };
  })();
  function searchWords(text) {
    const raw = searchRawTokens(text);
    const out = [];
    for (let i = 0; i < raw.length; ) {
      const options = SEARCH_LEXICON.phrases.get(raw[i]);
      const hit = options && options.find((o) => o.tokens.every((t, k) => raw[i + k] === t));
      if (hit) { out.push(hit.canon); i += hit.tokens.length; continue; }
      if (!SEARCH_LEXICON.filler.has(raw[i])) out.push(raw[i]);
      i++;
    }
    return out;
  }

  // ---------------- sources -> documents ----------------
  // A document: {id, kind, group, fields: {fieldName: text}, ...what to open}.
  const SEARCH_SOURCES = [];
  function registerSearchSource(kind, group, buildDocs) {
    SEARCH_SOURCES.push({ kind, group, buildDocs });
  }
  function conceptText(c) {
    return c.blocks.map(blockOf).filter((b) => b.type !== "h2")
      .map((b) => (b.label ? b.label + " " : "") + b.parts.map((p) => (Array.isArray(p) ? p.join(" ") : p)).join(" "))
      .join(" ");
  }
  // A section that is only a list of the manual's chapters ("1 – Our
  // Ecosystem", "6–7 – Onboarding & Setup") is a table of contents: it
  // mentions everything and answers nothing, so it isn't searched. The
  // chapter titles it lists are indexed in their own right.
  function isContentsSection(c) {
    const blocks = c.blocks.map(blockOf).filter((b) => b.type !== "h2");
    return blocks.length > 0 && blocks.every((b) => b.type === "table" && b.parts.every((row) => /^\d+(\s*[–-]\s*\d+)?\s+[–-]\s/.test(row[0])));
  }
  registerSearchSource("section", "Lessons", () => {
    const docs = [];
    for (const ch of MANUAL.chapters) {
      const track = MANUAL.tracks.find((t) => t.id === ch.track);
      for (const c of ch.concepts) {
        if (isContentsSection(c)) continue;
        docs.push({
          id: c.id, kind: "section", chapterId: ch.id, conceptId: c.id,
          fields: { title: c.title, chapter: ch.title + " " + (track ? track.title : ""), text: conceptText(c) },
        });
      }
    }
    return docs;
  });
  registerSearchSource("question", "Questions", () =>
    MANUAL.chapters.flatMap((ch) => ch.questions.map((q) => ({
      id: q.id, kind: "question", chapterId: ch.id, conceptId: q.concept, qid: q.id,
      fields: { question: q.q + " " + q.opts[q.correct] },
    }))));
  registerSearchSource("reflection", "Reflections", () =>
    MANUAL.chapters.flatMap((ch) => ch.reflections.map((prompt, i) => ({
      id: ch.id + ".r" + i, kind: "reflection", chapterId: ch.id, prompt: i,
      fields: { prompt },
    }))));

  function buildSearchIndex() {
    const docs = [];
    const groups = {};
    for (const src of SEARCH_SOURCES) {
      groups[src.kind] = src.group;
      for (const d of src.buildDocs()) {
        d.group = src.group;
        d.words = {};
        d.all = new Set();
        for (const f of Object.keys(d.fields)) {
          d.words[f] = new Set(searchWords(d.fields[f]));
          for (const w of d.words[f]) d.all.add(w);
        }
        docs.push(d);
      }
    }
    const df = new Map();
    for (const d of docs) for (const w of d.all) df.set(w, (df.get(w) || 0) + 1);
    return { docs, df, groups, n: docs.length };
  }

  // ---------------- query -> words the manual knows ----------------
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    let prev2 = null;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1); // swapped letters
        cur.push(v);
        if (v < best) best = v;
      }
      if (best > max) return max + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }
  // Each query word, as the word to look for: itself if the manual has it;
  // else a near spelling (1 letter off from 4 letters, 2 from 8); else, for
  // the word still being typed, the commonest manual word it starts.
  function searchQueryWords(index, query, typing) {
    const words = [...new Set(searchWords(query))];
    return words.map((w, i) => {
      if (index.df.has(w)) return { typed: w, word: w };
      let best = null, bestDf = 0;
      if (w.length >= 4) {
        const max = w.length >= 8 ? 2 : 1;
        for (const [cand, n] of index.df) {
          if (n > bestDf && cand.indexOf(" ") === -1 && editDistance(w, cand, max) <= max) { best = cand; bestDf = n; }
        }
      }
      if (!best && typing && i === words.length - 1 && w.length >= 3) {
        for (const [cand, n] of index.df) if (n > bestDf && cand.startsWith(w)) { best = cand; bestDf = n; }
      }
      return { typed: w, word: best }; // word null: the manual has nothing like it
    });
  }

  // ---------------- scoring ----------------
  function idf(index, w) { return Math.log(1 + index.n / (index.df.get(w) || index.n)); }
  function scoreDoc(index, doc, qwords) {
    let got = 0, total = 0, weighted = 0, hits = 0;
    for (const q of qwords) {
      // A word the manual doesn't have at all counts twice its rarest
      // word: if the manual never mentions it, the manual probably doesn't
      // cover the question ("fix a cracked phone screen" is not the
      // manual's "blank screen").
      const weight = q.word ? idf(index, q.word) : 2 * Math.log(1 + index.n);
      total += weight;
      if (!q.word) continue;
      let best = 0;
      for (const f of Object.keys(doc.words)) if (doc.words[f].has(q.word)) best = Math.max(best, SEARCH_FIELD_WEIGHT[f]);
      if (best) { got += weight; weighted += weight * best; hits++; }
    }
    return { coverage: total ? got / total : 0, weighted, hits };
  }

  // The part of a section that best answers: the sentence, table row, list
  // item or tip line holding the most (and rarest) of the question's words.
  // When the section's own title already holds at least as many of them
  // ("How to end a visit"), the title is the match and the section's
  // opening is the answer. A short sentence brings the next one along.
  // Returned as the same {block, parts} reference the coach uses, so it
  // quotes the same way. score = how much of the question one part holds.
  function bestPassage(index, conceptId, qwords) {
    const c = conceptOf(conceptId);
    const holds = (text) => {
      const words = new Set(searchWords(text));
      let score = 0;
      for (const q of qwords) if (q.word && words.has(q.word)) score += idf(index, q.word);
      return score;
    };
    let best = null, opening = null;
    for (const b of c.blocks.map(blockOf)) {
      if (b.type === "h2") continue;
      b.parts.forEach((part, i) => {
        if (!opening) opening = { block: b.id, i, score: 0 };
        const score = holds(Array.isArray(part) ? part.join(" ") : part);
        if (!best || score > best.score) best = { block: b.id, i, score };
      });
    }
    const titleScore = c.title !== chapterOfConcept(conceptId).title ? holds(c.title) : 0;
    const pick = titleScore > 0 && titleScore >= best.score ? opening : best;
    const b = blockOf(pick.block);
    const parts = [pick.i];
    const text = b.parts[pick.i];
    if (b.type === "p" && typeof text === "string" && text.length < 70 && pick.i + 1 < b.parts.length) parts.push(pick.i + 1);
    return { block: b.id, parts, lines: quoteParts(b, parts), score: Math.max(best.score, titleScore) };
  }

  // Questions to practise for an answer: the ones testing that section,
  // else the rest of its chapter.
  function relatedQuestions(conceptId) {
    const own = (COACH.conceptQuestions.get(conceptId) || []).slice();
    if (own.length) return own;
    return chapterOfConcept(conceptId).questions.map((q) => q.id);
  }

  // query -> {state, answer, more, nearest, words}
  //   state "empty"   : nothing typed (after filler words)
  //   state "answer"  : answer = {conceptId, chapterId, block, parts, lines, practice}
  //   state "nomatch" : nearest = up to 3 chapter ids, partial = some words matched
  function runSearch(index, query, opts) {
    const qwords = searchQueryWords(index, query, opts && opts.typing);
    if (!qwords.length) return { state: "empty", words: [] };
    const scored = index.docs
      .map((doc) => Object.assign({ doc }, scoreDoc(index, doc, qwords)))
      .filter((r) => r.hits > 0)
      .sort((a, b) => b.coverage - a.coverage || b.weighted - a.weighted || a.doc.id.localeCompare(b.doc.id, undefined, { numeric: true }));
    // Among results that cover the question, words found together in one
    // passage (or in the section's title) beat the same words scattered
    // across a long section.
    const good = scored.filter((r) => r.coverage >= SEARCH_GOOD);
    for (const r of good) {
      r.passage = r.doc.kind === "section" ? bestPassage(index, r.doc.conceptId, qwords) : null;
      r.final = r.weighted + (r.passage ? 1.5 * r.passage.score : 0);
    }
    good.sort((a, b) => b.final - a.final || b.coverage - a.coverage || a.doc.id.localeCompare(b.doc.id, undefined, { numeric: true }));
    const words = qwords.map((q) => ({ typed: q.typed, word: q.word }));

    let lead = good.find((r) => r.doc.kind === "section");
    let answer = null;
    if (lead) {
      const p = lead.passage;
      answer = { conceptId: lead.doc.conceptId, chapterId: lead.doc.chapterId, block: p.block, parts: p.parts, lines: p.lines };
    } else {
      // No section covers it, but a question with a source might.
      lead = good.find((r) => r.doc.kind === "question" && questionOf(r.doc.qid).source);
      if (lead) {
        const q = questionOf(lead.doc.qid);
        const b = blockOf(q.source.block);
        answer = { conceptId: q.concept, chapterId: chapterOfBlock(b.id).id, block: b.id, parts: q.source.parts.slice(), lines: quoteParts(b, q.source.parts) };
      }
    }
    if (!answer) {
      const byChapter = new Map();
      for (const r of scored) {
        const s = r.coverage * 10 + r.weighted;
        if (!byChapter.has(r.doc.chapterId) || byChapter.get(r.doc.chapterId) < s) byChapter.set(r.doc.chapterId, s);
      }
      const nearest = [...byChapter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
      // No manual passage to quote, but other results may still match well
      // (a question with no source; later, the RPN's own tasks): list them.
      return { state: "nomatch", partial: nearest.length > 0, nearest, more: good.slice(0, SEARCH_MORE).map((r) => r.doc), words };
    }
    answer.practice = relatedQuestions(answer.conceptId);
    const more = good
      .filter((r) => r !== lead && !(r.doc.kind === "section" && r.doc.conceptId === answer.conceptId))
      .slice(0, SEARCH_MORE)
      .map((r) => r.doc);
    return { state: "answer", answer, more, words };
  }

  // A few real section titles to try, changing day by day.
  function searchExamples(dayNumber, count) {
    const titles = [];
    for (const ch of MANUAL.chapters) for (const c of ch.concepts) if (c.title !== ch.title) titles.push(c.title);
    const out = [];
    const step = 7;
    for (let k = 0; out.length < Math.min(count, titles.length); k++) {
      const t = titles[(dayNumber * 3 + k * step) % titles.length];
      if (out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }
