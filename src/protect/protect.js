// Content protection (owner decision 9, 20 Oct 2026). build.js puts this, with
// protect.css, into the head of every app page it builds (Commerce Lite's
// dist, dist-pwa, dist-tauri, market.html; iTred; the RPN Field Guide) and
// tools/console/build-console.js into the Console's. Never in src/ pages.
//   - the right-click / long-press menu is blocked, so "Inspect" isn't
//     offered; it still works inside inputs;
//   - F12, Ctrl+Shift+I/J/C/L, Ctrl+U, Ctrl+S (and Cmd+Opt+I/J/C/U, Cmd+U,
//     Cmd+S on a Mac) are blocked, and so are the other F-keys, except a
//     page's own shortcuts (window.SEIGEN_ALLOWED_KEYS, e.g. ["F2"]; none today);
//   - no page text selection (protect.css; inputs and .selectable keep it):
//     the pages have Copy buttons where people need a value.
// No DevTools detection. Honest limit: DevTools still opens from the
// browser's own menu, so real security stays on the server.
(function () {
  "use strict";
  if (window.__seigenProtect) return;
  window.__seigenProtect = true;
  var EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .selectable';
  function editable(t) {
    var el = t && t.nodeType === 3 ? t.parentElement : t;
    return !!(el && el.closest && el.closest(EDITABLE));
  }
  function blockedKey(e) {
    var k = e.key || "";
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) return (window.SEIGEN_ALLOWED_KEYS || []).indexOf(k) === -1;
    if (!e.ctrlKey && !e.metaKey) return false;
    var m = /^Key([A-Z])$/.exec(e.code || ""), letter = m ? m[1] : (k.length === 1 ? k.toUpperCase() : "");
    if (!letter) return false;
    if (e.shiftKey && "IJCL".indexOf(letter) !== -1) return true;                // DevTools, console, element picker; Ctrl+Shift+L
    if (e.metaKey && e.altKey && "IJCU".indexOf(letter) !== -1) return true;     // Mac: Cmd+Opt+I/J/C, view source
    if (!e.shiftKey && !e.altKey && (letter === "U" || letter === "S")) return true;   // view source, save the page
    return false;
  }
  window.addEventListener("keydown", function (e) {
    if (blockedKey(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener("contextmenu", function (e) {
    if (!editable(e.target)) e.preventDefault();
  }, true);
  document.addEventListener("selectstart", function (e) {
    if (!editable(e.target)) e.preventDefault();
  }, true);
})();
