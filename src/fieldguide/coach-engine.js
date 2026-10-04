  // ================== RPN Field Guide — coach engine (Phase 2) ==================
  // Rules only: no network, no LLM, no randomness the tests can't repeat.
  // Works on MANUAL (content/manual.json) and COACH_LINES
  // (content/coach-lines.json), both inlined by build.js, and on one plain
  // progress record per learner (newProgress below). Nothing in this file
  // touches the DOM or storage, so test/fieldguide-engine.test.js runs it
  // under Node.
  //
  // What the coach teaches is only ever the manual's own text: an "idea" is
  // a section of a chapter (its blocks, by id), and an explanation is the
  // exact sentences a question's source points at. The coach's own lines
  // (COACH_LINES) are encouragement and directions, never facts.
  //
  // Spaced repetition is a five-box scheme per question: right moves a
  // question up a box, wrong drops it to box 0, and each box sets how many
  // days until it comes back (BOX_DAYS). A question the learner has seen
  // before always comes back with its choices in a different order.

  const DAY_MS = 86400000;
  const BOX_DAYS = [0, 1, 3, 7, 21];
  const MAX_BOX = BOX_DAYS.length - 1;
  const WEAK_LIMIT = 8;
  const DAILY_SIZE = 5;
  const STREAK_MARKS = [3, 5, 8, 12, 20];
  const STUCK_WRONGS = 2; // the same question missed this many times in all
  const STUCK_RUN = 3; // or this many misses in a row in one session

  // ---------------- indexes over the manual ----------------
  const COACH = (function buildIndex() {
    const chapters = new Map(), blocks = new Map(), concepts = new Map(), questions = new Map();
    const conceptQuestions = new Map();
    for (const ch of MANUAL.chapters) {
      chapters.set(ch.id, ch);
      for (const b of ch.blocks) blocks.set(b.id, { block: b, chapter: ch });
      for (const c of ch.concepts) {
        concepts.set(c.id, { concept: c, chapter: ch });
        conceptQuestions.set(c.id, []);
      }
    }
    for (const ch of MANUAL.chapters) {
      for (const q of ch.questions) {
        questions.set(q.id, { question: q, chapter: ch });
        conceptQuestions.get(q.concept).push(q.id);
      }
    }
    const order = MANUAL.chapters.map((ch) => ch.id);
    return { chapters, blocks, concepts, questions, conceptQuestions, order };
  })();

  function chapterOf(id) { return COACH.chapters.get(id); }
  function blockOf(id) { const hit = COACH.blocks.get(id); return hit ? hit.block : null; }
  function chapterOfBlock(id) { const hit = COACH.blocks.get(id); return hit ? hit.chapter : null; }
  function conceptOf(id) { const hit = COACH.concepts.get(id); return hit ? hit.concept : null; }
  function chapterOfConcept(id) { const hit = COACH.concepts.get(id); return hit ? hit.chapter : null; }
  function questionOf(id) { const hit = COACH.questions.get(id); return hit ? hit.question : null; }
  function chapterOfQuestion(id) { const hit = COACH.questions.get(id); return hit ? hit.chapter : null; }
  function conceptOfBlock(id) {
    const ch = chapterOfBlock(id);
    return ch ? ch.concepts.find((c) => c.blocks.includes(id)) : null;
  }
  // Tracks shown to the learner: reserved ones (no lessons yet) are left out.
  function visibleTracks() { return MANUAL.tracks.filter((t) => t.lessons.length); }

  // ---------------- progress record ----------------
  function newProgress(profileId) {
    return {
      profileId,
      v: 1,
      q: {}, // questionId -> {box, due, right, wrong, last, order}
      lessons: {}, // chapterId -> {started, done, best, last, total, missed}
      reflections: {}, // chapterId -> {promptIndex: text}
      read: {}, // conceptId -> time first shown in a lesson
      daily: { last: "", streak: 0, best: 0 },
      recent: [], // recent searches, newest first (search-ui.js)
    };
  }
  function qState(p, qid) {
    if (!p.q[qid]) p.q[qid] = { box: 0, due: 0, right: 0, wrong: 0, last: 0, order: null };
    return p.q[qid];
  }
  const timesSeen = (p, qid) => (p.q[qid] ? p.q[qid].right + p.q[qid].wrong : 0);

  // ---------------- choice order (variations) ----------------
  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h >>> 0;
  }
  function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // First time: the manual's own order. After that: shuffled, and never the
  // same order as the last time it was shown.
  function optionOrder(p, qid) {
    const q = questionOf(qid);
    const base = q.opts.map((_, i) => i);
    const seen = timesSeen(p, qid);
    if (!seen) return base;
    const rand = seededRandom(hashString(qid) + seen * 7919);
    const out = base.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = out[i]; out[i] = out[j]; out[j] = t;
    }
    const prev = (p.q[qid] && p.q[qid].order) || base;
    if (out.length > 1 && out.every((v, i) => v === prev[i])) out.push(out.shift());
    return out;
  }

  // ---------------- grading + scheduling ----------------
  function grade(p, qid, chosen, order, now) {
    const q = questionOf(qid);
    const s = qState(p, qid);
    const correct = chosen === q.correct;
    if (correct) { s.right++; s.box = Math.min(MAX_BOX, s.box + 1); }
    else { s.wrong++; s.box = 0; }
    s.due = now + BOX_DAYS[s.box] * DAY_MS;
    s.last = now;
    s.order = order.slice();
    return correct;
  }

  // 0..1, or null when none of the idea's questions has been answered.
  function conceptMastery(p, conceptId) {
    const qids = (COACH.conceptQuestions.get(conceptId) || []).filter((id) => p.q[id]);
    if (!qids.length) return null;
    return qids.reduce((sum, id) => sum + p.q[id].box, 0) / (qids.length * MAX_BOX);
  }

  // Missed at least once and not yet answered right since.
  function weakQuestions(p, chapterId) {
    return Object.keys(p.q)
      .filter((id) => COACH.questions.has(id))
      .filter((id) => p.q[id].wrong > 0 && p.q[id].box === 0)
      .filter((id) => !chapterId || chapterOfQuestion(id).id === chapterId)
      .sort((a, b) => p.q[b].wrong - p.q[a].wrong || p.q[a].due - p.q[b].due || a.localeCompare(b))
      .slice(0, WEAK_LIMIT);
  }

  function dayKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  // Today's practice: questions that are due, then ones not yet seen from
  // lessons already started, in manual order. Empty until a lesson starts.
  function dailyQuestions(p, now) {
    const started = COACH.order.filter((id) => p.lessons[id]);
    if (!started.length) return [];
    const due = Object.keys(p.q)
      .filter((id) => COACH.questions.has(id) && p.q[id].due <= now)
      .sort((a, b) => p.q[a].due - p.q[b].due || a.localeCompare(b));
    const unseen = [];
    for (const chId of started) for (const q of chapterOf(chId).questions) if (!p.q[q.id]) unseen.push(q.id);
    return due.concat(unseen.filter((id) => due.indexOf(id) === -1)).slice(0, DAILY_SIZE);
  }
  function dailyDoneToday(p, now) { return p.daily.last === dayKey(now); }
  function recordDaily(p, now) {
    const today = dayKey(now);
    if (p.daily.last === today) return;
    p.daily.streak = p.daily.last === dayKey(now - DAY_MS) ? p.daily.streak + 1 : 1;
    p.daily.best = Math.max(p.daily.best, p.daily.streak);
    p.daily.last = today;
  }

  // 0..1 for a lesson's ring: the best quiz score once it's done, otherwise
  // how much of it has been read.
  function lessonProgress(p, chapterId) {
    const ch = chapterOf(chapterId);
    const L = p.lessons[chapterId];
    if (L && L.done && L.total) return L.best / L.total;
    const read = ch.concepts.filter((c) => p.read[c.id]).length;
    return ch.concepts.length ? Math.min(0.99, read / ch.concepts.length) * (L ? 1 : 0) : 0;
  }

  // What the home screen suggests next.
  function suggestNext(p) {
    const lastDone = COACH.order
      .map((id) => ({ id, L: p.lessons[id] }))
      .filter((x) => x.L && x.L.done)
      .sort((a, b) => b.L.done - a.L.done)[0];
    if (lastDone && lastDone.L.missed.length && weakQuestions(p).length) return { kind: "review" };
    const next = COACH.order.find((id) => !(p.lessons[id] && p.lessons[id].done));
    if (next) return { kind: "lesson", chapterId: next, started: !!p.lessons[next] };
    return { kind: "daily" };
  }

  // ---------------- teaching content ----------------
  // An idea is shown as its section's blocks, minus the heading (shown as
  // the card title) and minus tips, which are held back as the first
  // "another way" for "I don't understand". A section that is only tips
  // shows them.
  function ideaBlocks(conceptId) {
    const c = conceptOf(conceptId);
    const blocks = c.blocks.map(blockOf).filter((b) => b.type !== "h2");
    const main = blocks.filter((b) => b.type !== "tip");
    return (main.length ? main : blocks).map((b) => b.id);
  }

  // "I don't understand", in order: (1) each tip from the same section not
  // already shown, (2) the section's shortest full sentence. Both are the
  // manual's own words. After that there is nothing simpler in the manual,
  // and the coach says so and points at the nearest other section.
  function simplerOptions(conceptId) {
    const c = conceptOf(conceptId);
    const shown = new Set(ideaBlocks(conceptId));
    const blocks = c.blocks.map(blockOf);
    const out = blocks
      .filter((b) => b.type === "tip" && !shown.has(b.id))
      .map((b) => ({ kind: "tip", block: b.id, parts: b.parts.map((_, i) => i) }));
    const sentences = [];
    for (const b of blocks) {
      if (b.type !== "p") continue;
      b.parts.forEach((s, i) => {
        if (s.length >= 30 && !/:$/.test(s)) sentences.push({ block: b.id, i, s });
      });
    }
    if (sentences.length > 1) {
      const best = sentences.reduce((a, b) => (b.s.length < a.s.length ? b : a));
      out.push({ kind: "line", block: best.block, parts: [best.i] });
    }
    return out;
  }

  const COACH_STOP = new Set("that this with your they their them what when which from have been will would should could about into than then there these those only also just more most much very does doesn while where after before because being other some every each such over under onto upon youre dont isnt thats its".split(" "));
  const conceptWordCache = new Map();
  function conceptWords(conceptId) {
    if (!conceptWordCache.has(conceptId)) {
      const text = conceptOf(conceptId).blocks.map(blockOf)
        .map((b) => b.parts.map((p) => (Array.isArray(p) ? p.join(" ") : p)).join(" ")).join(" ");
      const words = (text.toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]{4,}/g) || []).filter((w) => !COACH_STOP.has(w));
      conceptWordCache.set(conceptId, new Set(words));
    }
    return conceptWordCache.get(conceptId);
  }
  // The other section sharing the most words with this one (at least 3),
  // or null.
  function nearestConcept(conceptId) {
    const mine = conceptWords(conceptId);
    let best = null, bestScore = 2;
    for (const id of COACH.concepts.keys()) {
      if (id === conceptId) continue;
      let score = 0;
      for (const w of conceptWords(id)) if (mine.has(w)) score++;
      if (score > bestScore) { best = id; bestScore = score; }
    }
    return best;
  }

  // ---------------- coach lines ----------------
  function fillLine(text, vars) {
    return text.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));
  }
  function coachLine(session, key, vars) {
    const list = COACH_LINES[key];
    const i = session.lineTurns[key] || 0;
    session.lineTurns[key] = i + 1;
    return fillLine(list[i % list.length], vars);
  }
  function lessonLabel(chapterId) {
    const ch = chapterOf(chapterId);
    return "Chapter " + ch.n + ", " + ch.title;
  }
  function conceptLabel(conceptId) {
    const ch = chapterOfConcept(conceptId);
    const c = conceptOf(conceptId);
    return c.title === ch.title ? lessonLabel(ch.id) : lessonLabel(ch.id) + ": " + c.title;
  }

  // ---------------- sessions ----------------
  // A session is the conversation on screen: a list of steps to work
  // through, and a log of what has been said so far. The UI renders the log
  // and offers what `await` says is next: "continue", "answer" or "done".
  function lessonSteps(chapterId) {
    const ch = chapterOf(chapterId);
    const steps = [];
    const asked = new Set();
    for (const c of ch.concepts) {
      steps.push({ kind: "idea", conceptId: c.id });
      const q = ch.questions.find((x) => x.concept === c.id && !asked.has(x.id));
      if (q) { asked.add(q.id); steps.push({ kind: "check", qid: q.id }); }
    }
    steps.push({ kind: "quizIntro" });
    for (const q of ch.questions) steps.push({ kind: "quiz", qid: q.id });
    steps.push({ kind: "finish" });
    return steps;
  }

  function newSession(kind, chapterId) {
    return {
      kind, // "lesson" | "review" | "daily"
      chapterId: chapterId || null,
      steps: [],
      pos: -1,
      log: [],
      await: null,
      current: null, // {conceptId, qid?} the idea "I don't understand" is about
      runRight: 0,
      runWrong: 0,
      results: {}, // qid -> true/false, for the quiz (lesson) or the whole session
      simplerTurns: {},
      lineTurns: {},
    };
  }

  function startLesson(p, chapterId, now) {
    const s = newSession("lesson", chapterId);
    s.steps = lessonSteps(chapterId);
    const L = p.lessons[chapterId] || (p.lessons[chapterId] = { started: now, done: null, best: null, last: null, total: 0, missed: [] });
    if (!L.started) L.started = now;
    s.log.push({ type: "coach", text: coachLine(s, "open", { title: chapterOf(chapterId).title }) });
    advance(s, p, now);
    return s;
  }
  function startReview(p, chapterId, now) {
    const s = newSession("review", chapterId);
    const qids = weakQuestions(p, chapterId);
    s.steps = qids.map((qid) => ({ kind: "review", qid })).concat([{ kind: "finish" }]);
    s.log.push({ type: "coach", text: coachLine(s, qids.length ? "reviewStart" : "reviewEmpty") });
    if (qids.length) advance(s, p, now);
    else s.await = "done";
    return s;
  }
  function startDaily(p, now) {
    const s = newSession("daily");
    const qids = dailyQuestions(p, now);
    s.steps = qids.map((qid) => ({ kind: "daily", qid })).concat([{ kind: "finish" }]);
    const anyStarted = COACH.order.some((id) => p.lessons[id]);
    const opening = qids.length ? "dailyStart" : anyStarted ? "dailyNothingDue" : "dailyEmpty";
    s.log.push({ type: "coach", text: coachLine(s, opening, { n: qids.length }) });
    if (qids.length) advance(s, p, now);
    else s.await = "done";
    return s;
  }

  // A short run of chosen questions (search's "Practise this").
  function startPractice(p, qids, now) {
    const s = newSession("practice");
    const list = qids.filter((id) => COACH.questions.has(id));
    s.steps = list.map((qid) => ({ kind: "practice", qid })).concat([{ kind: "finish" }]);
    s.log.push({ type: "coach", text: coachLine(s, "practiceStart", { n: list.length }) });
    if (list.length) advance(s, p, now);
    else s.await = "done";
    return s;
  }

  function advance(s, p, now) {
    s.pos++;
    const step = s.steps[s.pos];
    if (!step) { s.await = "done"; return; }
    if (step.kind === "idea") {
      if (s.pos > 0) s.log.push({ type: "coach", text: coachLine(s, "idea") });
      s.log.push({ type: "idea", conceptId: step.conceptId, blocks: ideaBlocks(step.conceptId) });
      if (!p.read[step.conceptId]) p.read[step.conceptId] = now;
      s.current = { conceptId: step.conceptId };
      s.await = "continue";
      return;
    }
    if (step.kind === "quizIntro") {
      s.log.push({ type: "coach", text: coachLine(s, "quizStart", { n: chapterOf(s.chapterId).questions.length }) });
      advance(s, p, now);
      return;
    }
    if (step.kind === "finish") { finish(s, p, now); return; }
    // a question: check / quiz / review / daily
    if (step.kind === "check") s.log.push({ type: "coach", text: coachLine(s, "check") });
    s.log.push({ type: "question", qid: step.qid, mode: step.kind, order: optionOrder(p, step.qid), chosen: null });
    s.current = { conceptId: questionOf(step.qid).concept, qid: step.qid };
    s.await = "answer";
  }

  // chosen = the option's index in the manual (not its position on screen).
  function answer(s, p, chosen, now) {
    if (s.await !== "answer") return null;
    const msg = s.log[s.log.length - 1];
    const q = questionOf(msg.qid);
    if (!(chosen >= 0 && chosen < q.opts.length)) return null;
    msg.chosen = chosen;
    const correct = grade(p, msg.qid, chosen, msg.order, now);
    if (msg.mode !== "check") s.results[msg.qid] = correct;
    s.log.push({ type: "me", text: q.opts[chosen] });
    let line;
    if (correct) {
      s.runRight++; s.runWrong = 0;
      line = coachLine(s, "right");
      if (STREAK_MARKS.indexOf(s.runRight) !== -1) line += " " + coachLine(s, "streak", { n: s.runRight });
    } else {
      s.runWrong++; s.runRight = 0;
      line = coachLine(s, "wrong");
    }
    s.log.push({ type: "why", qid: msg.qid, correct, text: line });
    if (!correct && (p.q[msg.qid].wrong >= STUCK_WRONGS || s.runWrong >= STUCK_RUN)) {
      s.log.push({ type: "coach", stuck: true, text: coachLine(s, "stuck") });
    }
    s.await = "continue";
    return correct;
  }

  function cont(s, p, now) {
    if (s.await !== "continue") return;
    advance(s, p, now);
  }

  // "I don't understand" about whatever idea is current.
  function simpler(s) {
    if (!s.current || s.await === "done") return null;
    const cid = s.current.conceptId;
    const options = simplerOptions(cid);
    const turn = s.simplerTurns[cid] || 0;
    s.simplerTurns[cid] = turn + 1;
    let msg;
    if (turn < options.length) {
      const o = options[turn];
      msg = { type: "simpler", conceptId: cid, block: o.block, parts: o.parts, text: coachLine(s, o.kind === "tip" ? "simplerTip" : "simplerLine") };
    } else {
      const near = nearestConcept(cid);
      msg = near
        ? { type: "nearest", conceptId: near, text: coachLine(s, "simplerNearest", { lesson: conceptLabel(near) }) }
        : { type: "coach", text: coachLine(s, "simplerNone") };
    }
    s.log.push(msg);
    return msg;
  }

  function finish(s, p, now) {
    const qids = Object.keys(s.results);
    const score = qids.filter((id) => s.results[id]).length;
    if (s.kind === "lesson") {
      const ch = chapterOf(s.chapterId);
      const total = ch.questions.length;
      const missed = ch.questions.filter((q) => s.results[q.id] === false).map((q) => q.id);
      const L = p.lessons[s.chapterId];
      L.done = now; L.last = score; L.total = total; L.missed = missed;
      L.best = Math.max(L.best || 0, score);
      const key = score === total ? "quizPerfect" : score * 2 >= total ? "quizGood" : "quizLow";
      s.log.push({ type: "result", score, total, text: coachLine(s, key, { score, total }) });
      if (missed.length) {
        const topics = [];
        for (const id of missed) {
          const t = conceptOf(questionOf(id).concept).title;
          if (topics.indexOf(t) === -1) topics.push(t);
        }
        s.log.push({ type: "next", action: "review", chapterId: s.chapterId, text: coachLine(s, "nextReview", { topics: topics.slice(0, 3).join("; ") }) });
      } else {
        const next = COACH.order.find((id) => id !== s.chapterId && !(p.lessons[id] && p.lessons[id].done));
        s.log.push(next
          ? { type: "next", action: "lesson", chapterId: next, text: coachLine(s, "nextLesson", { lesson: lessonLabel(next) }) }
          : { type: "next", action: "daily", text: coachLine(s, "nextAllDone") });
      }
      if (ch.reflections.length) s.log.push({ type: "reflect", chapterId: ch.id });
    } else {
      if (s.kind === "daily") recordDaily(p, now);
      const key = s.kind === "daily" ? "dailyDone" : s.kind === "practice" ? "practiceDone" : "reviewDone";
      s.log.push({ type: "result", score, total: qids.length, text: coachLine(s, key, { score, total: qids.length }) });
    }
    s.current = null;
    s.await = "done";
  }

  // The words of a question's explanation: its source parts, as quoted
  // text, or null for a question marked "no source".
  function sourceQuote(q) {
    if (!q.source) return null;
    const b = blockOf(q.source.block);
    return { block: b.id, chapterId: chapterOfBlock(b.id).id, conceptId: conceptOfBlock(b.id).id, lines: quoteParts(b, q.source.parts) };
  }
  function quoteParts(block, parts) {
    const pick = parts.map((i) => block.parts[i]);
    if (block.type === "p") {
      // Sentences that aren't next to each other in the manual get "…"
      // between them, so a quote never reads as one continuous passage.
      return [pick.reduce((out, s, k) => (k === 0 ? s : out + (parts[k] === parts[k - 1] + 1 ? " " : " … ") + s), "")];
    }
    if (block.type === "table") return pick.map((row) => row.join(" — "));
    return pick;
  }
