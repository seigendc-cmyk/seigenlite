  // ================== RPN Field Guide — Coach tab + learner profiles (Phase 2) ==================
  // Screens (all under #/coach):
  //   #/coach                      home: daily practice, weak spots, suggested next, lessons by track
  //   #/coach/lesson/<ch>          the coach conversation for one chapter
  //   #/coach/read/<ch>[/<block>]  the chapter as written, opened at a block
  //   #/coach/review[/<ch>]        weak-spot review;  #/coach/daily  today's practice
  // plus the "Learners on this phone" card on the Me tab.
  //
  // Every button carries data-act; app.js routes clicks, form submits and
  // typing on #fgMain to coachAction/coachSubmit/coachInput below, so a
  // re-render never needs re-wiring. The conversation itself is the
  // engine's session log (coach-engine.js): this file only draws it.
  //
  // Learners are local to this phone (store.js). They are not the RPN's
  // Console identity; sign-in comes in a later phase.

  const coach = {
    loaded: false,
    profiles: [],
    activeId: null,
    progress: null,
    sessions: new Map(), // "lesson:ch3" | "review" | "daily" -> engine session (this learner only)
    seen: new Map(), // session key -> log length already drawn, to scroll to what's new
    saveChain: Promise.resolve(),
    saveFailed: false,
  };
  const REFLECT_SAVE_MS = 400;
  let reflectTimer = null;

  const coachNow = () => Date.now();

  // ---------------- profiles + progress ----------------
  async function coachInit() {
    await storeInit();
    try {
      coach.profiles = (await storeGetAll("profiles")).sort((a, b) => a.created - b.created);
      const meta = await storeGet("meta", "activeProfileId");
      const active = meta && coach.profiles.find((p) => p.id === meta.value);
      if (active) await activateProfile(active.id, false);
    } catch (e) {
      coach.saveFailed = true;
    }
    coach.loaded = true;
    render(true); // the screen drawn at boot was only "Loading…"
  }
  function activeProfile() { return coach.profiles.find((p) => p.id === coach.activeId) || null; }

  async function activateProfile(id, remember) {
    const stored = await storeGet("progress", id);
    coach.progress = Object.assign(newProgress(id), stored || {});
    coach.activeId = id;
    coach.sessions.clear(); // a conversation belongs to the learner who had it
    coach.seen.clear();
    if (remember !== false) await storePut("meta", { key: "activeProfileId", value: id });
  }
  async function createProfile(name) {
    const profile = { id: "p_" + coachNow().toString(36) + Math.random().toString(36).slice(2, 7), name, created: coachNow() };
    await storePut("profiles", profile);
    coach.profiles.push(profile);
    await activateProfile(profile.id);
    saveProgress();
  }
  function saveProgress() {
    const snapshot = coach.progress;
    coach.saveChain = coach.saveChain
      .then(() => storePut("progress", snapshot))
      .then(() => { coach.saveFailed = false; })
      .catch(() => { coach.saveFailed = true; });
    return coach.saveChain;
  }
  const cleanName = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 40);

  // ---------------- small renderers ----------------
  const esc = escapeHtml;
  function trackClass(trackId) {
    const i = visibleTracks().findIndex((t) => t.id === trackId);
    return "fg-t" + ((i < 0 ? 0 : i) % 5 + 1);
  }
  function chapterIcon(ch) {
    return '<svg class="fg-chicon" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">' + ch.icon + "</svg>";
  }
  function ring(frac, inner, label) {
    const r = 21, c = 2 * Math.PI * r;
    const off = c * (1 - Math.max(0, Math.min(1, frac)));
    return (
      '<span class="fg-ring"' + (label ? ' role="img" aria-label="' + esc(label) + '"' : ' aria-hidden="true"') + ">" +
      '<svg viewBox="0 0 48 48" focusable="false"><circle cx="24" cy="24" r="' + r + '" class="fg-ring-bg"/>' +
      '<circle cx="24" cy="24" r="' + r + '" class="fg-ring-fg" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '" transform="rotate(-90 24 24)"/></svg>' +
      '<span class="fg-ring-in">' + inner + "</span></span>"
    );
  }
  const anchorId = (blockId) => "blk-" + blockId.replace(".", "-");
  function blockHtml(b, withAnchor) {
    const id = withAnchor ? ' id="' + anchorId(b.id) + '"' : "";
    switch (b.type) {
      case "p": return '<p class="fg-mp"' + id + ">" + esc(b.parts.join(" ")) + "</p>";
      case "h2": return '<h3 class="fg-mh"' + id + ">" + esc(b.parts[0]) + "</h3>";
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        return "<" + tag + ' class="fg-mlist"' + id + ">" + b.parts.map((t) => "<li>" + esc(t) + "</li>").join("") + "</" + tag + ">";
      }
      case "table":
        return (
          '<div class="fg-mtable-wrap"' + id + '><table class="fg-mtable">' +
          (b.head.length ? "<thead><tr>" + b.head.map((h) => "<th>" + esc(h) + "</th>").join("") + "</tr></thead>" : "") +
          "<tbody>" + b.parts.map((row) => "<tr>" + row.map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>"
        );
      default: // tip / dont / say
        return (
          '<div class="fg-callout fg-callout-' + b.type + '"' + id + '><div class="fg-callout-label">' + esc(b.label) + "</div>" +
          b.parts.map((t) => "<p>" + esc(t) + "</p>").join("") + "</div>"
        );
    }
  }
  function readLink(chapterId, blockId, label) {
    return '<button type="button" class="fg-link" data-act="read" data-ch="' + chapterId + '"' + (blockId ? ' data-block="' + blockId + '"' : "") + ">" + esc(label) + "</button>";
  }
  function quoteHtml(lines, blockId) {
    const ch = chapterOfBlock(blockId);
    const c = conceptOfBlock(blockId);
    return (
      '<blockquote class="fg-quote">' + lines.map((l) => "<p>" + esc(l) + "</p>").join("") + "</blockquote>" +
      '<div class="fg-quote-src"><span>' + esc("Chapter " + ch.n + (c && c.title !== ch.title ? " · " + c.title : "")) + "</span>" +
      readLink(ch.id, blockId, "Read in the manual") + "</div>"
    );
  }
  const AVATAR = '<span class="fg-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-7A2.5 2.5 0 0 1 6.5 4z"/></svg></span>';
  const coachBubble = (inner, i, extra) => '<div class="fg-msg fg-msg-coach' + (extra || "") + '" data-i="' + i + '">' + AVATAR + '<div class="fg-bubble">' + inner + "</div></div>";

  // ---------------- home ----------------
  function setupCardHtml() {
    return (
      '<h1 class="fg-h1" tabindex="-1">Coach</h1>' +
      '<p class="fg-lead">Short lessons from the RPN Field Manual, a question after each idea, and practice that comes back to what you miss.</p>' +
      '<form class="card fg-setup" data-act="create-profile">' +
        '<h2 class="fg-card-title">Who is learning on this phone?</h2>' +
        '<label class="fg-label" for="fgNewName">Your name</label>' +
        '<input class="field" id="fgNewName" name="name" maxlength="40" autocomplete="name" required>' +
        '<p class="muted" style="margin:8px 0 12px">Progress stays on this phone. You can add other learners later under Me.</p>' +
        '<button type="submit" class="btn btn-primary">Start</button>' +
      "</form>"
    );
  }
  const FLAME = '<svg class="fg-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="fg-ic-fill" d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .3 2 1.3 3 2.5 3.5C12 9 11 6 12 3z"/></svg>';
  const TARGET = '<svg class="fg-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle class="fg-ic-fill" cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6M15 6h3v3"/></svg>';
  const CHEVRON = '<svg class="fg-svg fg-chev" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>';

  function homeHtml() {
    const p = coach.progress;
    const prof = activeProfile();
    const now = coachNow();
    const daily = dailyQuestions(p, now);
    const anyStarted = COACH.order.some((id) => p.lessons[id]);
    const streakAlive = p.daily.streak > 0 && (p.daily.last === dayKey(now) || p.daily.last === dayKey(now - DAY_MS));
    const weak = weakQuestions(p);
    const next = suggestNext(p);

    let html =
      '<h1 class="fg-h1" tabindex="-1">Coach</h1>' +
      '<p class="fg-lead">Hi, ' + esc(prof.name) + '. <button type="button" class="fg-link" data-act="go-me">Not you?</button></p>';
    if (storeMode === "memory" || coach.saveFailed) {
      html += '<div class="fg-warn" role="status">This browser isn\'t keeping progress. It will be lost when the app closes.</div>';
    }
    html += '<div class="fg-grid2">' +
      '<div class="card fg-stat"><div class="fg-stat-ic fg-t1">' + FLAME + "</div>" +
        '<div class="fg-stat-title">Daily practice</div>' +
        '<div class="fg-stat-sub" id="fgStreak">' + (dailyDoneToday(p, now) ? "Done today · " : "") + (streakAlive ? p.daily.streak + "-day streak" : "No streak yet") + "</div>" +
        '<button type="button" class="btn btn-primary btn-sm" data-act="start-daily"' + (daily.length ? "" : " disabled") + ">" +
          (daily.length ? "Practise (" + daily.length + ")" : anyStarted ? "Nothing due" : "Start a lesson first") + "</button>" +
      "</div>" +
      '<div class="card fg-stat"><div class="fg-stat-ic fg-t2">' + TARGET + "</div>" +
        '<div class="fg-stat-title">Weak spots</div>' +
        '<div class="fg-stat-sub">' + (weak.length ? weak.length + " to review" : "Nothing to review") + "</div>" +
        '<button type="button" class="btn btn-outline btn-sm" data-act="start-review"' + (weak.length ? "" : " disabled") + ">Review</button>" +
      "</div></div>";

    if (next.kind === "lesson") {
      const ch = chapterOf(next.chapterId);
      html += '<button type="button" class="card fg-next ' + trackClass(ch.track) + '" data-act="open-lesson" data-ch="' + ch.id + '">' +
        '<span class="fg-next-k">' + (next.started ? "Continue" : "Next lesson") + "</span>" +
        '<span class="fg-next-t">Chapter ' + ch.n + ": " + esc(ch.title) + "</span>" + CHEVRON + "</button>";
    } else if (next.kind === "review") {
      html += '<button type="button" class="card fg-next fg-t2" data-act="start-review"><span class="fg-next-k">Suggested</span><span class="fg-next-t">Review what you missed last time</span>' + CHEVRON + "</button>";
    }

    for (const t of visibleTracks()) {
      html += '<h2 class="fg-track-h"><span class="fg-chip ' + trackClass(t.id) + '">' + esc(t.title) + "</span></h2>";
      for (const chId of t.lessons) {
        const ch = chapterOf(chId);
        const L = p.lessons[chId];
        const frac = lessonProgress(p, chId);
        const status = L && L.done ? "Quiz best " + L.best + " of " + L.total : L ? "In progress" : ch.concepts.length + " parts · " + ch.questions.length + " questions";
        html += '<button type="button" class="fg-lesson ' + trackClass(t.id) + '" data-act="open-lesson" data-ch="' + chId + '">' +
          ring(frac, chapterIcon(ch), Math.round(frac * 100) + "% done") +
          '<span class="fg-lesson-body"><span class="fg-lesson-n">Chapter ' + ch.n + "</span>" +
          '<span class="fg-lesson-title">' + esc(ch.title) + "</span>" +
          '<span class="fg-lesson-sub">' + esc(status) + "</span></span>" + CHEVRON + "</button>";
      }
    }
    return html;
  }

  // ---------------- conversation ----------------
  function sessionKey(sub) {
    if (sub[0] === "lesson") return "lesson:" + sub[1];
    return sub[0] === "review" || sub[0] === "practice" ? sub[0] : "daily";
  }
  const SESSION_ROUTES = ["lesson", "review", "daily", "practice"];
  // Search's "Practise this": a short session of the given questions.
  function startPracticeSession(qids) {
    coach.sessions.set("practice", startPractice(coach.progress, qids, coachNow()));
    coach.seen.set("practice", 0);
    saveProgress();
    if (location.hash === "#/coach/practice") render(true);
    else location.hash = "#/coach/practice";
  }
  function ensureSession(sub, fresh) {
    const key = sessionKey(sub);
    let s = coach.sessions.get(key);
    if (!s || fresh) {
      const now = coachNow();
      s = sub[0] === "lesson" ? startLesson(coach.progress, sub[1], now)
        : sub[0] === "review" ? startReview(coach.progress, sub[1] || null, now)
        : startDaily(coach.progress, now);
      coach.sessions.set(key, s);
      coach.seen.set(key, 0);
      saveProgress();
    }
    return s;
  }

  function questionHtml(m, i, label) {
    const q = questionOf(m.qid);
    const answered = m.chosen !== null;
    const opts = m.order.map((oi, pos) => {
      let cls = "fg-opt";
      if (answered && oi === q.correct) cls += " is-right";
      else if (answered && oi === m.chosen) cls += " is-wrong";
      return '<button type="button" class="' + cls + '" data-act="answer" data-i="' + oi + '"' + (answered ? " disabled" : "") + ">" +
        '<span class="fg-opt-k">' + "ABCDEFG".charAt(pos) + "</span><span>" + esc(q.opts[oi]) + "</span></button>";
    }).join("");
    return '<div class="fg-msg fg-msg-card" data-i="' + i + '"><div class="fg-q" data-qid="' + m.qid + '"><div class="fg-q-label">' + esc(label) + "</div>" +
      '<p class="fg-q-text">' + esc(q.q) + '</p><div class="fg-opts">' + opts + "</div></div></div>";
  }
  function whyHtml(m, i) {
    const q = questionOf(m.qid);
    const quote = sourceQuote(q);
    let inner = '<p class="fg-react">' + esc(m.text) + "</p>";
    if (!m.correct || !quote) inner += '<p class="fg-answer">Correct answer: <strong>' + esc(q.opts[q.correct]) + "</strong></p>";
    if (quote) inner += quoteHtml(quote.lines, quote.block);
    return coachBubble(inner, i, m.correct ? " is-right" : " is-wrong");
  }
  function reflectHtml(chapterId) {
    const ch = chapterOf(chapterId);
    const saved = (coach.progress.reflections[chapterId]) || {};
    return '<div class="card fg-reflect"><div class="fg-callout-label">In your own words</div>' +
      '<p class="muted" style="margin:4px 0 10px">Explain it the way you\'d explain it to a vendor. Saved on this phone as you type.</p>' +
      ch.reflections.map((prompt, pi) =>
        '<label class="fg-label" for="fgRef-' + chapterId + "-" + pi + '">' + (pi + 1) + ". " + esc(prompt) + "</label>" +
        '<textarea class="field fg-ta" id="fgRef-' + chapterId + "-" + pi + '" data-act="reflect" data-ch="' + chapterId + '" data-i="' + pi + '" rows="3">' + esc(saved[pi] || "") + "</textarea>"
      ).join("") +
      '<span class="fg-saved" data-saved="' + chapterId + '" aria-live="polite"></span></div>';
  }
  function logHtml(s) {
    let quizN = 0;
    const quizTotal = s.kind === "lesson" ? chapterOf(s.chapterId).questions.length : 0;
    const totalQs = s.steps.filter((st) => st.qid && st.kind !== "check").length;
    let qN = 0;
    return s.log.map((m, i) => {
      switch (m.type) {
        case "coach": return coachBubble("<p>" + esc(m.text) + "</p>", i, m.stuck ? " is-stuck" : "");
        case "idea": {
          const c = conceptOf(m.conceptId);
          const ch = chapterOfConcept(m.conceptId);
          return '<div class="fg-msg fg-msg-card" data-i="' + i + '"><div class="fg-idea ' + trackClass(ch.track) + '">' +
            '<div class="fg-src">From the manual · Chapter ' + ch.n + "</div>" +
            '<h3 class="fg-idea-t">' + esc(c.title) + "</h3>" +
            m.blocks.map((id) => blockHtml(blockOf(id), false)).join("") +
            '<div class="fg-idea-foot">' + readLink(ch.id, m.blocks[0], "Open in the manual") + "</div></div></div>";
        }
        case "question": {
          let label;
          if (m.mode === "check") label = "Quick check";
          else if (m.mode === "quiz") label = "Quiz · " + (++quizN) + " of " + quizTotal;
          else label = (m.mode === "review" ? "Review · " : "Practice · ") + (++qN) + " of " + totalQs;
          return questionHtml(m, i, label);
        }
        case "me": return '<div class="fg-msg fg-msg-me" data-i="' + i + '"><div class="fg-bubble">' + esc(m.text) + "</div></div>";
        case "why": return whyHtml(m, i);
        case "simpler": {
          const b = blockOf(m.block);
          return coachBubble("<p>" + esc(m.text) + "</p>" + quoteHtml(quoteParts(b, m.parts), b.id), i);
        }
        case "nearest": {
          const ch = chapterOfConcept(m.conceptId);
          const first = conceptOf(m.conceptId).blocks[0];
          return coachBubble("<p>" + esc(m.text) + '</p><button type="button" class="btn btn-outline btn-sm" data-act="read" data-ch="' + ch.id + '" data-block="' + first + '">Open it</button>', i);
        }
        case "result":
          return '<div class="fg-msg fg-msg-card" data-i="' + i + '"><div class="card fg-result">' +
            ring(m.total ? m.score / m.total : 0, '<b class="fg-result-n">' + m.score + "/" + m.total + "</b>", m.score + " out of " + m.total) +
            "<p>" + esc(m.text) + "</p></div></div>";
        case "next": {
          let btn = "";
          if (m.action === "review") btn = '<button type="button" class="btn btn-primary btn-sm" data-act="start-review" data-ch="' + m.chapterId + '">Review weak spots</button>';
          else if (m.action === "lesson") btn = '<button type="button" class="btn btn-primary btn-sm" data-act="open-lesson" data-ch="' + m.chapterId + '">Start it</button>';
          else btn = '<button type="button" class="btn btn-primary btn-sm" data-act="start-daily">Daily practice</button>';
          return coachBubble("<p>" + esc(m.text) + "</p>" + btn, i);
        }
        case "reflect": return '<div class="fg-msg fg-msg-card" data-i="' + i + '">' + reflectHtml(m.chapterId) + "</div>";
        default: return "";
      }
    }).join("");
  }
  function actionsHtml(s) {
    const stuck = s.log.length && s.log[s.log.length - 1].stuck;
    const help = s.current
      ? '<button type="button" class="btn btn-ghost' + (stuck ? " is-stuck" : "") + '" data-act="simpler">I don\'t understand</button>'
      : "";
    if (s.await === "continue") return '<div class="fg-actions">' + help + '<button type="button" class="btn btn-primary" data-act="continue">Continue</button></div>';
    if (s.await === "answer") return '<div class="fg-actions">' + help + "</div>";
    return '<div class="fg-actions"><button type="button" class="btn btn-outline" data-act="home">Back to Coach</button></div>';
  }
  function sessionHtml(sub) {
    const s = ensureSession(sub, false);
    let head, title;
    if (s.kind === "lesson") {
      const ch = chapterOf(s.chapterId);
      title = ch.title;
      head = '<span class="fg-chip ' + trackClass(ch.track) + '">Chapter ' + ch.n + "</span>";
    } else {
      title = s.kind === "review" ? "Weak spots" : s.kind === "practice" ? "Practice" : "Daily practice";
      head = "";
    }
    const frac = s.steps.length ? Math.max(0, s.pos) / s.steps.length : 0;
    return (
      '<div class="fg-subhead"><button type="button" class="fg-back" data-act="home">‹ Coach</button>' + head + "</div>" +
      '<h1 class="fg-h1" tabindex="-1">' + esc(title) + "</h1>" +
      (s.kind === "lesson"
        ? '<div class="fg-subrow">' + readLink(s.chapterId, null, "Read the chapter") + '<button type="button" class="fg-link" data-act="restart-lesson" data-ch="' + s.chapterId + '">Start over</button></div>'
        : "") +
      '<div class="fg-bar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round((s.await === "done" ? 1 : frac) * 100) + '"><span style="width:' + ((s.await === "done" ? 1 : frac) * 100).toFixed(1) + '%"></span></div>' +
      '<div class="fg-chat" aria-live="polite">' + logHtml(s) + "</div>" +
      actionsHtml(s)
    );
  }

  // ---------------- reader ----------------
  function readerHtml(chapterId) {
    const ch = chapterOf(chapterId);
    if (!ch) return homeHtml();
    return (
      '<div class="fg-subhead"><button type="button" class="fg-back" data-act="home">‹ Coach</button><span class="fg-chip ' + trackClass(ch.track) + '">Chapter ' + ch.n + "</span></div>" +
      '<div class="fg-readhead ' + trackClass(ch.track) + '">' + ring(coach.progress ? lessonProgress(coach.progress, ch.id) : 0, chapterIcon(ch)) +
      '<h1 class="fg-h1" tabindex="-1">' + esc(ch.title) + "</h1></div>" +
      '<button type="button" class="btn btn-primary" data-act="open-lesson" data-ch="' + ch.id + '">Learn it with the coach</button>' +
      '<article class="fg-reader">' + ch.blocks.map((b) => blockHtml(b, true)).join("") + "</article>" +
      (ch.reflections.length && coach.progress ? reflectHtml(ch.id) : "") +
      '<p class="muted fg-source-note">From ' + esc(MANUAL.source.title) + ".</p>"
    );
  }

  // ---------------- entry points used by app.js ----------------
  function coachScreen(sub) {
    if (!coach.loaded) return '<h1 class="fg-h1" tabindex="-1">Coach</h1><p class="fg-lead">Loading…</p>';
    if (sub[0] === "read" && chapterOf(sub[1])) return readerHtml(sub[1]); // the manual itself needs no learner
    if (!coach.progress) return setupCardHtml();
    // A practice run only exists once search has started it (not after a reload).
    if (sub[0] === "practice" && !coach.sessions.has("practice")) return homeHtml();
    if ((sub[0] === "lesson" && chapterOf(sub[1])) || sub[0] === "review" || sub[0] === "daily" || sub[0] === "practice") return sessionHtml(sub);
    if (sub[0] === "read") return readerHtml(sub[1]);
    return homeHtml();
  }
  // After drawing: open the reader at its block, or bring the newest part
  // of a conversation into view.
  function coachAfterRender(sub, navigated) {
    if (sub[0] === "read" && sub[2]) {
      const el = sub[2] === "reflect" ? document.querySelector(".fg-reader ~ .fg-reflect") : document.getElementById(anchorId(sub[2]));
      if (el) {
        el.scrollIntoView({ block: "start" });
        el.classList.add("fg-flash");
      }
      return;
    }
    if (!coach.progress || SESSION_ROUTES.indexOf(sub[0]) === -1 || !coach.sessions.has(sessionKey(sub))) return;
    const key = sessionKey(sub);
    const s = coach.sessions.get(key);
    if (!s) return;
    const from = coach.seen.get(key) || 0;
    coach.seen.set(key, s.log.length);
    if (navigated && from === 0) return; // a fresh conversation starts at the top
    const target = document.querySelector('.fg-chat [data-i="' + (navigated ? s.log.length - 1 : from) + '"]');
    if (target) target.scrollIntoView({ block: "start" });
  }

  function currentSub() { return routeParts().slice(1); }

  async function coachAction(act, el) {
    const sub = currentSub();
    const now = coachNow();
    switch (act) {
      case "go-me": location.hash = "#/me"; return;
      case "home": location.hash = "#/coach"; return;
      case "open-lesson": {
        const key = "lesson:" + el.dataset.ch;
        const s = coach.sessions.get(key);
        if (s && s.await === "done") coach.sessions.delete(key); // a finished lesson opens fresh
        location.hash = "#/coach/lesson/" + el.dataset.ch;
        return;
      }
      case "restart-lesson":
        coach.sessions.delete("lesson:" + el.dataset.ch);
        ensureSession(["lesson", el.dataset.ch], true);
        render(true);
        return;
      case "read":
        location.hash = "#/coach/read/" + el.dataset.ch + (el.dataset.block ? "/" + el.dataset.block : "");
        return;
      case "start-review":
        coach.sessions.delete("review");
        ensureSession(["review", el.dataset.ch], true);
        if (location.hash === "#/coach/review") render(true);
        else location.hash = "#/coach/review";
        return;
      case "start-daily":
        coach.sessions.delete("daily");
        ensureSession(["daily"], true);
        if (location.hash === "#/coach/daily") render(true);
        else location.hash = "#/coach/daily";
        return;
      case "answer":
      case "continue":
      case "simpler": {
        const s = coach.sessions.get(sessionKey(sub));
        if (!s) return;
        if (act === "answer") answer(s, coach.progress, Number(el.dataset.i), now);
        else if (act === "continue") cont(s, coach.progress, now);
        else simpler(s);
        saveProgress();
        render(false);
        return;
      }
      case "switch-profile":
        if (el.dataset.id === coach.activeId) return;
        await activateProfile(el.dataset.id);
        render(false);
        return;
      case "rename-profile": {
        const prof = coach.profiles.find((p) => p.id === el.dataset.id);
        const name = cleanName(await fgDialog({ title: "Rename learner", input: prof.name, okLabel: "Save" }));
        if (!name) return;
        prof.name = name;
        await storePut("profiles", prof);
        render(false);
        return;
      }
      case "remove-profile": {
        const prof = coach.profiles.find((p) => p.id === el.dataset.id);
        const ok = await fgDialog({ title: "Remove " + prof.name + "?", text: "Their lessons, quiz scores and written answers on this phone are deleted. This can't be undone.", okLabel: "Remove", danger: true });
        if (!ok) return;
        await storeDelete("profiles", prof.id);
        await storeDelete("progress", prof.id);
        coach.profiles = coach.profiles.filter((p) => p.id !== prof.id);
        if (coach.activeId === prof.id) {
          coach.activeId = null;
          coach.progress = null;
          coach.sessions.clear();
          coach.seen.clear();
          if (coach.profiles.length) await activateProfile(coach.profiles[0].id);
          else await storeDelete("meta", "activeProfileId");
        }
        render(false);
        return;
      }
    }
  }
  async function coachSubmit(act, form) {
    const name = cleanName(form.elements.name.value);
    if (!name) { form.elements.name.focus(); return; }
    if (act === "create-profile" || act === "add-profile") {
      await createProfile(name);
      if (act === "create-profile") render(true);
      else render(false);
    }
  }
  function coachInput(el) {
    if (el.dataset.act !== "reflect" || !coach.progress) return;
    const chId = el.dataset.ch;
    const r = coach.progress.reflections[chId] || (coach.progress.reflections[chId] = {});
    r[el.dataset.i] = el.value;
    clearTimeout(reflectTimer);
    reflectTimer = setTimeout(() => {
      saveProgress().then(() => {
        for (const note of document.querySelectorAll('[data-saved="' + chId + '"]')) note.textContent = coach.saveFailed ? "Not saved" : "Saved";
      });
    }, REFLECT_SAVE_MS);
  }

  // ---------------- Me: learners on this phone ----------------
  function profilesCardHtml() {
    if (!coach.loaded) return "";
    const rows = coach.profiles.map((p) => {
      const active = p.id === coach.activeId;
      return '<div class="fg-prof' + (active ? " is-active" : "") + '">' +
        '<button type="button" class="fg-prof-main" data-act="switch-profile" data-id="' + p.id + '" aria-pressed="' + active + '">' +
          '<span class="fg-prof-dot" aria-hidden="true"></span><span class="fg-prof-name">' + esc(p.name) + "</span>" +
          (active ? '<span class="pill ok">Active</span>' : "") + "</button>" +
        '<button type="button" class="fg-link" data-act="rename-profile" data-id="' + p.id + '">Rename</button>' +
        '<button type="button" class="fg-link fg-danger" data-act="remove-profile" data-id="' + p.id + '">Remove</button></div>';
    }).join("");
    return '<div class="card" id="fgProfiles"><h2 class="fg-card-title">Learners on this phone</h2>' +
      '<p class="muted" style="margin:0 0 10px">Each learner\'s progress is kept apart, on this phone only. Signing in with your Console account comes later.</p>' +
      (rows || '<p class="muted">No learners yet.</p>') +
      '<form class="fg-addprof" data-act="add-profile"><input class="field" name="name" maxlength="40" placeholder="New learner\'s name" aria-label="New learner\'s name" required>' +
      '<button type="submit" class="btn btn-outline btn-sm">Add</button></form></div>';
  }
