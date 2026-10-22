// node tools/console/build-console.js [<console folder>] [--out <file>]
//
// Builds the Console's deployable page (owner decision 9) from its source,
// default D:\SCL Console\index.html -> D:\SCL Console\deploy\preview\index.html
// (that folder is gitignored in the Console repo and is what sclconsole-preview
// serves): the page's one inline script scrambled (build.js's light options:
// no control-flow flattening, so nothing slows down), and the content
// protection (src/protect/) put into its head. The source page stays as it is,
// so the Console's own tests and a local file:// copy are unaffected.
"use strict";
const fs = require("fs");
const path = require("path");
const { protectPage, scrambleInlineScript } = require("../../build.js");

function buildConsole(srcFile) {
  const html = fs.readFileSync(srcFile, "utf8");
  return protectPage(scrambleInlineScript(html, "Console"), "Console");
}

module.exports = { buildConsole };
if (require.main !== module) return;

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const dir = path.resolve(args.find((a, i) => !a.startsWith("--") && i !== outAt + 1) || "D:/SCL Console");
const src = path.join(dir, "index.html");
const out = outAt !== -1 ? path.resolve(args[outAt + 1]) : path.join(dir, "deploy", "preview", "index.html");
const built = buildConsole(src);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, built);
console.log("Built " + out + " (" + built.length + " bytes) from " + src + " (" + fs.statSync(src).size + " bytes): scrambled and protected.");
