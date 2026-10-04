// Staff passwords and vendor-token dates for the Publish Portal. Pure
// helpers (no Supabase, no HTTP) so the rules are easy to test directly.
"use strict";
const crypto = require("crypto");

// ---------------- passwords ----------------
// scrypt from Node's crypto: "scrypt$N$r$p$salt$hash" (base64url parts).
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MIN_PASSWORD = 10;

function hashPassword(password){
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}
function verifyPassword(password, stored){
  const parts = String(stored || "").split("$");
  if(parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64url"), want = Buffer.from(parts[5], "base64url");
  const got = crypto.scryptSync(String(password), salt, want.length, { N, r, p });
  return crypto.timingSafeEqual(got, want);
}
// Checked for unknown usernames too, so a wrong name takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));

function passwordProblem(password, username){
  const p = String(password || "");
  if(p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if(p.length > 200) return "That password is too long.";
  if(username && p.toLowerCase().includes(String(username).toLowerCase())) return "Don't include your username in the password.";
  return "";
}
function normalizeUsername(u){ return String(u || "").trim().toLowerCase(); }
function usernameProblem(u){
  return /^[a-z0-9._@-]{3,64}$/.test(u) ? "" : "Usernames are 3–64 characters: lower-case letters, digits, and . _ @ -";
}
const ROLES = ["admin", "reviewer"];

// ---------------- dates ----------------
// Token dates are calendar dates in Digital Commerce's own time zone.
const TIME_ZONE = "Africa/Harare";
function todayLocal(now){
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now || new Date());
}
function isDate(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s; }
function addDays(date, n){ const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function lastDay(startsOn, days){ return addDays(startsOn, days - 1); }

// A vendor's token status on a given day, from their (non-voided) tokens.
// Back-to-back or overlapping tokens count as one run, so a renewal bought
// early shows as "active until" the end of the renewal.
//   { state: "active", until }            covered today
//   { state: "expired", expiredOn }       last token ended before today (expiredOn = its last day)
//   { state: "future", startsOn }         nothing today, but one starts later
//   { state: "none" }                     never had one
function tokenStatus(tokens, today){
  const live = (tokens || []).filter(t => !t.voided_at)
    .map(t => ({ start: t.starts_on, end: t.ends_on || lastDay(t.starts_on, t.days) }))
    .sort((a, b) => a.start.localeCompare(b.start));
  if(!live.length) return { state: "none" };
  const covering = live.filter(t => t.start <= today && t.end >= today);
  if(covering.length){
    let until = covering.reduce((m, t) => t.end > m ? t.end : m, covering[0].end);
    for(const t of live) if(t.start <= addDays(until, 1) && t.end > until) until = t.end;
    return { state: "active", until };
  }
  const next = live.find(t => t.start > today);
  const past = live.filter(t => t.end < today);
  const expiredOn = past.length ? past.reduce((m, t) => t.end > m ? t.end : m, past[0].end) : null;
  if(next) return { state: "future", startsOn: next.start, expiredOn };
  return { state: "expired", expiredOn };
}
// Where a new purchase should start by default: straight after the current
// run if there is one, otherwise today.
function defaultStart(status, today){
  return status && status.state === "active" ? addDays(status.until, 1) : today;
}
function fmtDate(d){
  if(!d) return "";
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
// The message the Publish button shows when it's blocked for want of a token.
function tokenBlockMessage(status){
  if(!status || status.state === "active") return "";
  if(status.state === "expired") return `No active token — expired on ${fmtDate(status.expiredOn)}. Record a new one to continue.`;
  if(status.state === "future") return `No active token — the next one starts on ${fmtDate(status.startsOn)}. Record one covering today to publish now.`;
  return "No active token — none has been recorded for this vendor. Record one to continue.";
}

// ---------------- reports ----------------
// Money collected from token purchases, grouped by the RPN recorded on each
// token, then by period (month "YYYY-MM" or year "YYYY" of the day it was
// recorded, in Harare) and currency. Currencies are never added together.
//   tokens: vendor_tokens rows; opts: { year, month (1-12), rpn ("all" |
//   "none" | an RPN id), by ("month" | "year") }; rpnName(id) -> label.
// Voided tokens don't count. A token with no amount (only ones recorded
// before payment was required) counts as 0 and is counted in noAmount.
// Amounts are summed in cents.
function reportTotals(tokens, opts, rpnName){
  opts = opts || {};
  const by = opts.by === "year" ? "year" : "month";
  const rpnFilter = opts.rpn || "all";
  const year = opts.year ? String(opts.year) : "";
  const month = opts.month ? String(opts.month).padStart(2, "0") : "";
  const cents = (a)=> a == null ? 0 : Math.round(Number(a) * 100);
  const groups = new Map(), grand = new Map();
  let count = 0, noAmount = 0;
  for(const t of tokens || []){
    if(t.voided_at) continue;
    const day = todayLocal(new Date(t.recorded_at));
    if(year && day.slice(0, 4) !== year) continue;
    if(month && day.slice(5, 7) !== month) continue;
    const rpn = t.rpn_id || null;
    if(rpnFilter === "none" ? rpn !== null : rpnFilter !== "all" && rpn !== rpnFilter) continue;
    const period = by === "year" ? day.slice(0, 4) : day.slice(0, 7);
    const currency = t.currency || "";
    const key = [rpn || "", period, currency].join("|");
    if(!groups.has(key)) groups.set(key, { rpnId: rpn, rpnName: rpn ? rpnName(rpn) : "No RPN", period, currency, count: 0, noAmount: 0, cents: 0 });
    const g = groups.get(key);
    g.count++; count++;
    if(t.amount == null){ g.noAmount++; noAmount++; }
    g.cents += cents(t.amount);
    if(currency) grand.set(currency, (grand.get(currency) || 0) + cents(t.amount));
  }
  const rows = [...groups.values()].sort((a, b)=>
    (a.rpnId ? 0 : 1) - (b.rpnId ? 0 : 1) || a.rpnName.localeCompare(b.rpnName) || a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency));
  // Subtotal per RPN per currency.
  const byRpn = new Map();
  for(const r of rows){
    const k = r.rpnId || "";
    if(!byRpn.has(k)) byRpn.set(k, { rpnId: r.rpnId, rpnName: r.rpnName, count: 0, noAmount: 0, totals: new Map() });
    const s = byRpn.get(k); s.count += r.count; s.noAmount += r.noAmount;
    if(r.currency) s.totals.set(r.currency, (s.totals.get(r.currency) || 0) + r.cents);
  }
  const money = (m)=> [...m.entries()].sort((a, b)=> a[0].localeCompare(b[0])).map(([currency, c])=> ({ currency, total: c / 100 }));
  return {
    by, filter: { year: year || null, month: month ? Number(month) : null, rpn: rpnFilter },
    rows: rows.map(r => ({ rpnId: r.rpnId, rpnName: r.rpnName, period: r.period, currency: r.currency || null, count: r.count, noAmount: r.noAmount, total: r.cents / 100 })),
    rpns: [...byRpn.values()].map(s => ({ rpnId: s.rpnId, rpnName: s.rpnName, count: s.count, noAmount: s.noAmount, totals: money(s.totals) })),
    grand: { count, noAmount, totals: money(grand) },
  };
}

module.exports = { reportTotals, hashPassword, verifyPassword, DUMMY_HASH, passwordProblem, normalizeUsername, usernameProblem, ROLES,
  MIN_PASSWORD, todayLocal, isDate, addDays, lastDay, tokenStatus, defaultStart, fmtDate, tokenBlockMessage, TIME_ZONE };
