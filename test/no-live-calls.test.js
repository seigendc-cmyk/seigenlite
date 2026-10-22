// Run: node test/no-live-calls.test.js
// Every browser test must answer or block the network itself, so a test run
// never reaches the live seiGEN. returns-e2e didn't, and each full suite run
// left 2 "Gentronix" vendor rows on live (100 of the 152 vendor rows removed by
// the test-data purge of 2026-10-22). Static check: each test file that
// launches Chromium uses one of the ways the suite stubs or blocks requests.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const STUBS = [/\.route\(/, /\.setOffline\(/, /offline:\s*true/, /stubDigitalCommerce\(/, /stubTerminals\(/, /fake-supabase/];

let passed = 0, failed = 0;
function t(name, fn){
  try{ fn(); passed++; console.log("  ok   " + name); }
  catch(e){ failed++; console.log("  FAIL " + name + "\n       " + e.message.split("\n").join("\n       ")); }
}

const browserTests = fs.readdirSync(DIR).filter((f)=> f.endsWith(".js"))
  .filter((f)=> /chromium\.launch\(/.test(fs.readFileSync(path.join(DIR, f), "utf8")));

t("there are browser tests to check", ()=> assert.ok(browserTests.length > 10, "found " + browserTests.length));
t("every browser test stubs or blocks the network (no request reaches the live seiGEN)", ()=>{
  const open = browserTests.filter((f)=> !STUBS.some((re)=> re.test(fs.readFileSync(path.join(DIR, f), "utf8"))));
  assert.deepStrictEqual(open, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
