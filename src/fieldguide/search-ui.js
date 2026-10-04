  // ================== RPN Field Guide — search sheet (Phase 3) ==================
  // The sheet from Phase 1, now searching the manual (search.js):
  //   typing -> onSearchInput (debounced) -> runSearch -> renderSearchResults
  //   tap or Enter on a result -> onSearchBodyClick -> the reader, a lesson,
  //   practice, or a reflection prompt (coach-ui.js does the opening)
  // States drawn: getting ready (index being built), empty (recent searches
  // + example questions), an answer (quoted passage + more results), and no
  // match (said plainly, with the nearest lessons). Every answer is a quote:
  // this file never writes one.
  //
  // Recent searches are kept per learner, in their progress record, and
  // only when a search was used (a result opened, or Enter pressed).
  const SEARCH_DEBOUNCE_MS = 150;
  const SEARCH_RECENT_MAX = 6;
  const searchUi = { index: null, building: false, timer: null, result: null, returnFocus: null, leadTurn: 0 };

  function searchInputEl() { return document.getElementById("fgSearchInput"); }

  function openSearch() {
    searchUi.returnFocus = document.activeElement;
    document.getElementById("fgSearch").hidden = false;
    const input = searchInputEl();
    input.focus();
    input.select();
    if (!searchUi.index && !searchUi.building) {
      searchUi.building = true;
      // Built after the sheet has drawn, so "Getting the manual ready" shows.
      setTimeout(() => {
        searchUi.index = buildSearchIndex();
        searchUi.building = false;
        runSearchNow(false);
      }, 0);
    }
    runSearchNow(false);
  }
  // restoreFocus false when a result navigates: the new screen takes focus.
  function closeSearch(restoreFocus) {
    clearTimeout(searchUi.timer);
    document.getElementById("fgSearch").hidden = true;
    if (restoreFocus !== false && searchUi.returnFocus && searchUi.returnFocus.focus) searchUi.returnFocus.focus();
  }
  function onSearchInput() {
    document.getElementById("fgSearchClear").hidden = !searchInputEl().value;
    clearTimeout(searchUi.timer);
    searchUi.timer = setTimeout(() => runSearchNow(true), SEARCH_DEBOUNCE_MS);
  }
  function clearSearch() {
    const input = searchInputEl();
    input.value = "";
    runSearchNow(false);
    input.focus();
  }
  // typing: the last word may be unfinished, so it can match a word it starts.
  function runSearchNow(typing) {
    const q = searchInputEl().value;
    document.getElementById("fgSearchClear").hidden = !q;
    if (!searchUi.index) {
      searchUi.result = null;
      renderSearchResults();
      return;
    }
    searchUi.result = q.trim() ? runSearch(searchUi.index, q, { typing }) : { state: "empty" };
    renderSearchResults();
  }

  // ---------------- drawing ----------------
  function srItem(icon, title, sub, attrs) {
    return '<button type="button" class="fg-sr-item" ' + attrs + ">" +
      '<span class="fg-sr-ic">' + icon + '</span><span class="fg-sr-txt"><span class="fg-sr-t">' + esc(title) + "</span>" +
      (sub ? '<span class="fg-sr-s">' + esc(sub) + "</span>" : "") + "</span></button>";
  }
  function docItem(doc) {
    const ch = chapterOf(doc.chapterId);
    if (doc.kind === "section") {
      const c = conceptOf(doc.conceptId);
      return srItem(ICONS.book, c.title, "Chapter " + ch.n + (c.title === ch.title ? "" : " · " + ch.title), 'data-sact="read" data-ch="' + ch.id + '" data-block="' + c.blocks[0] + '"');
    }
    if (doc.kind === "question") {
      return srItem(ICONS.play, questionOf(doc.qid).q, "Practise this question · Chapter " + ch.n, 'data-sact="practise" data-q="' + doc.qid + '"');
    }
    if (doc.kind === "reflection") {
      return srItem(ICONS.pen, doc.fields.prompt, "Write your answer · Chapter " + ch.n, 'data-sact="reflect" data-ch="' + ch.id + '"');
    }
    // A kind added later brings its own way of opening; until then, shown only.
    const first = doc.fields[Object.keys(doc.fields)[0]];
    return '<div class="fg-sr-item"><span class="fg-sr-ic">' + ICONS.search + '</span><span class="fg-sr-txt"><span class="fg-sr-t">' + esc(first) + "</span></span></div>";
  }
  const srStatus = (text) => '<span class="fg-sr-only" role="status">' + esc(text) + "</span>";

  function renderSearchResults() {
    const body = document.getElementById("fgSearchBody");
    const r = searchUi.result;
    body.dataset.q = r ? searchInputEl().value : ""; // which query is on screen (also lets tests wait for it)
    if (!r) {
      body.innerHTML = '<p class="fg-sr-msg">Getting the manual ready…</p>';
      return;
    }
    if (r.state === "empty") {
      let html = "";
      const recent = (coach.progress && coach.progress.recent) || [];
      if (recent.length) {
        html += '<h3 class="fg-sr-h">Recent</h3>' + recent.map((q) => srItem(ICONS.clock, q, "", 'data-sact="query" data-q="' + esc(q) + '"')).join("");
      }
      html += '<h3 class="fg-sr-h">Try asking about</h3>' +
        searchExamples(Math.floor(coachNow() / DAY_MS), 4).map((q) => srItem(ICONS.search, q, "", 'data-sact="query" data-q="' + esc(q) + '"')).join("");
      html += '<p class="fg-sr-msg">Ask in your own words, in any order. Answers are quoted from the RPN Field Manual.</p>';
      body.innerHTML = html;
      return;
    }
    if (r.state === "nomatch") {
      const chapters = r.nearest.length ? r.nearest : COACH.order.slice(0, 3);
      const line = (r.partial ? COACH_LINES.searchNoMatch : COACH_LINES.searchNoWords)[0];
      body.innerHTML = srStatus("No answer in the manual") +
        '<div class="fg-sr-coach fg-sr-none">' + AVATAR + "<p>" + esc(line) + "</p></div>" +
        chapters.map((id) => {
          const ch = chapterOf(id);
          return srItem(chapterIcon(ch), ch.title, "Chapter " + ch.n + " · open the lesson", 'data-sact="lesson" data-ch="' + ch.id + '"');
        }).join("") +
        groupedHtml(r.more);
      return;
    }
    const a = r.answer;
    const ch = chapterOf(a.chapterId);
    const c = conceptOf(a.conceptId);
    const leads = COACH_LINES.searchLead;
    const lead = fillLine(leads[searchUi.leadTurn++ % leads.length], { lesson: conceptLabel(a.conceptId) });
    let html = srStatus("Answer from chapter " + ch.n + ", " + c.title) +
      '<div class="fg-sr-lead ' + trackClass(ch.track) + '">' +
        '<div class="fg-sr-coach">' + AVATAR + "<p>" + esc(lead) + "</p></div>" +
        '<blockquote class="fg-quote">' + a.lines.map((l) => "<p>" + esc(l) + "</p>").join("") + "</blockquote>" +
        '<div class="fg-sr-btns">' +
          '<button type="button" class="btn btn-outline btn-sm" data-sact="read" data-ch="' + ch.id + '" data-block="' + a.block + '">Read in the manual</button>' +
          '<button type="button" class="btn btn-primary btn-sm" data-sact="practise" data-q="' + a.practice.join(",") + '">Practise this (' + a.practice.length + ")</button>" +
        "</div></div>";
    body.innerHTML = html + groupedHtml(r.more);
  }
  // Further results under their group headings, in the order sources were
  // registered (Lessons, Questions, Reflections, then any added later).
  function groupedHtml(docs) {
    let html = "";
    for (const kind of Object.keys(searchUi.index.groups)) {
      const list = (docs || []).filter((d) => d.kind === kind);
      if (list.length) html += '<h3 class="fg-sr-h">' + esc(searchUi.index.groups[kind]) + "</h3>" + list.map(docItem).join("");
    }
    return html;
  }

  // ---------------- acting on a result ----------------
  function recordRecentSearch() {
    const q = searchInputEl().value.replace(/\s+/g, " ").trim();
    if (!q || !coach.progress) return;
    const list = (coach.progress.recent || []).filter((x) => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    coach.progress.recent = list.slice(0, SEARCH_RECENT_MAX);
    saveProgress();
  }
  function onSearchBodyClick(e) {
    const el = e.target.closest("[data-sact]");
    if (!el) return;
    const act = el.dataset.sact;
    if (act === "query") {
      searchInputEl().value = el.dataset.q;
      runSearchNow(false);
      searchInputEl().focus();
      return;
    }
    recordRecentSearch();
    closeSearch(false);
    if (act === "read") location.hash = "#/coach/read/" + el.dataset.ch + "/" + el.dataset.block;
    else if (act === "reflect") location.hash = "#/coach/read/" + el.dataset.ch + "/reflect";
    else if (act === "lesson") location.hash = "#/coach/lesson/" + el.dataset.ch;
    else if (act === "practise") {
      if (!coach.progress) location.hash = "#/coach"; // asks who's learning first
      else startPracticeSession(el.dataset.q.split(","));
    }
  }
  // Enter: the first thing on offer (the answer's "Read in the manual").
  // Arrow keys: move between the input and the results.
  function onSearchKeydown(e) {
    const input = searchInputEl();
    const items = [...document.querySelectorAll("#fgSearchBody [data-sact]")];
    if (e.key === "Enter" && e.target === input) {
      e.preventDefault();
      if (!input.value.trim()) return;
      clearTimeout(searchUi.timer);
      runSearchNow(false);
      const first = document.querySelector("#fgSearchBody [data-sact]");
      if (first && first.dataset.sact !== "query") first.click();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const at = e.target === input ? -1 : items.indexOf(e.target);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    e.preventDefault();
    if (next < 0) input.focus();
    else if (items[next]) items[next].focus();
  }
