// node test/content-protection.test.js
//
// Owner decision 9 (content protection): src/protect/protect.js and
// protect.css, as build.js puts them into every app page.
//   - the right-click / long-press menu is blocked except inside inputs;
//   - F12, Ctrl+Shift+I/J/C/L, Ctrl+U, Ctrl+S and the Mac equivalents are
//     blocked, and the other F-keys too unless the page allows them;
//     everyday keys (copy, paste, undo, select all, find, typing) are not;
//   - no text selection outside inputs and .selectable;
//   - every built page has it exactly once, in its head; a page can't get it twice.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { protectPage, PROTECT_MARK } = require("../build.js");

const ROOT = path.join(__dirname, "..");
const JS = fs.readFileSync(path.join(ROOT, "src", "protect", "protect.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "src", "protect", "protect.css"), "utf8");
let passed = 0, failed = 0;
function t(name, fn){ try{ fn(); passed++; console.log("  ok   " + name); } catch(e){ failed++; console.log("  FAIL " + name + "\n       " + e.message); } }

function page(allowed){
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div id="d">Some text</div><p class="selectable" id="s">PO-1234</p>
    <input id="i"><textarea id="ta"></textarea><div contenteditable="true" id="ce">edit</div></body></html>`, { runScripts: "outside-only" });
  if(allowed) dom.window.SEIGEN_ALLOWED_KEYS = allowed;
  dom.window.eval(JS);
  return dom.window;
}
function key(w, o, target){
  const e = new w.KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, o));
  (target || w.document.body).dispatchEvent(e);
  return e.defaultPrevented;
}
const KEY = (letter)=> ({ key: letter.toLowerCase(), code: "Key" + letter });

t("F12 and the other F-keys are blocked (F5 too), unless the page allows them", ()=>{
  const w = page();
  for(const f of ["F12", "F1", "F5", "F11"]) assert.strictEqual(key(w, { key: f, code: f }), true, f);
  const w2 = page(["F2"]);
  assert.strictEqual(key(w2, { key: "F2", code: "F2" }), false, "F2 is the page's own");
  assert.strictEqual(key(w2, { key: "F12", code: "F12" }), true);
});

t("Ctrl+Shift+I / J / C / L, Ctrl+U and Ctrl+S are blocked", ()=>{
  const w = page();
  for(const l of ["I", "J", "C", "L"]) assert.strictEqual(key(w, Object.assign({ ctrlKey: true, shiftKey: true }, KEY(l), { key: l })), true, "Ctrl+Shift+" + l);
  assert.strictEqual(key(w, Object.assign({ ctrlKey: true }, KEY("U"))), true, "Ctrl+U");
  assert.strictEqual(key(w, Object.assign({ ctrlKey: true }, KEY("S"))), true, "Ctrl+S");
});

t("on a Mac: Cmd+Opt+I / J / C / U, Cmd+Shift+C, Cmd+U and Cmd+S are blocked", ()=>{
  const w = page();
  for(const l of ["I", "J", "C", "U"]) assert.strictEqual(key(w, Object.assign({ metaKey: true, altKey: true }, KEY(l), { key: "ˆ" })), true, "Cmd+Opt+" + l);
  assert.strictEqual(key(w, Object.assign({ metaKey: true, shiftKey: true }, KEY("C"))), true, "Cmd+Shift+C");
  assert.strictEqual(key(w, Object.assign({ metaKey: true }, KEY("U"))), true, "Cmd+U");
  assert.strictEqual(key(w, Object.assign({ metaKey: true }, KEY("S"))), true, "Cmd+S");
});

t("everyday keys still work: copy, paste, cut, undo, select all, find, print, typing, Enter, Escape, Tab", ()=>{
  const w = page(), input = w.document.getElementById("i");
  for(const l of ["C", "V", "X", "Z", "A", "F", "P"]) {
    assert.strictEqual(key(w, Object.assign({ ctrlKey: true }, KEY(l)), input), false, "Ctrl+" + l);
    assert.strictEqual(key(w, Object.assign({ metaKey: true }, KEY(l)), input), false, "Cmd+" + l);
  }
  for(const k of [{ key: "a", code: "KeyA" }, { key: "S", code: "KeyS", shiftKey: true }, { key: "Enter", code: "Enter" }, { key: "Escape", code: "Escape" }, { key: "Tab", code: "Tab" }, { key: "1", code: "Digit1" }])
    assert.strictEqual(key(w, k, input), false, k.key);
});

t("the right-click / long-press menu is blocked on the page, not inside inputs, text areas, editable text or .selectable", ()=>{
  const w = page(), d = w.document;
  const menu = (el)=>{ const e = new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
  assert.strictEqual(menu(d.getElementById("d")), true, "page text");
  assert.strictEqual(menu(d.body), true, "the page");
  for(const id of ["i", "ta", "ce", "s"]) assert.strictEqual(menu(d.getElementById(id)), false, id);
});

t("text selection is blocked on the page, not inside inputs or .selectable", ()=>{
  const w = page(), d = w.document;
  const sel = (node)=>{ const e = new w.Event("selectstart", { bubbles: true, cancelable: true }); node.dispatchEvent(e); return e.defaultPrevented; };
  assert.strictEqual(sel(d.getElementById("d").firstChild), true, "a text node of the page");
  assert.strictEqual(sel(d.getElementById("s").firstChild), false, ".selectable");
  assert.strictEqual(sel(d.getElementById("ce").firstChild), false, "editable");
  assert.match(CSS, /html \{[^}]*user-select: none/);
  assert.match(CSS, /input, textarea, select, \[contenteditable\][^{]*\.selectable[^{]*\{[^}]*user-select: text/);
});

t("loaded twice, it runs once (no double handlers)", ()=>{
  const w = page();
  w.eval(JS);
  assert.strictEqual(w.__seigenProtect, true);
});

t("no DevTools detection tricks (no debugger statements, no window-size or timing checks)", ()=>{
  assert.ok(!/\bdebugger\b|outerWidth|outerHeight|performance\.now|setInterval/.test(JS));
});

t("protectPage: just before the first </head>, once; a second time is refused", ()=>{
  const html = protectPage("<html><head><title>x</title></head><body><script>var a='</head>';</script></body></html>", "test");
  assert.ok(html.indexOf(PROTECT_MARK) < html.indexOf("</head>") && html.indexOf(PROTECT_MARK) > html.indexOf("<title>"));
  assert.throws(()=> protectPage(html, "test"), /already protected/);
});

t("every built app page has it once, in the head (dist, dist-pwa, dist-tauri, market.html, iTred)", ()=>{
  for(const f of ["dist/index.html", "dist-pwa/index.html", "dist-pwa/market.html", "dist-tauri/index.html", "dist-tauri/market.html", "dist-market/market.html", "dist-itred/index.html"]){
    const html = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.strictEqual(html.split(PROTECT_MARK).length - 1, 1, f);
    assert.ok(html.indexOf(PROTECT_MARK) < html.indexOf("</head>"), f + ": in the head");
  }
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
