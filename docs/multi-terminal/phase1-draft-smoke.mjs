// Smoke test of the Phase 1 DRAFT SQL in in-memory PGlite. Never touches the live project.
// Run: node docs/multi-terminal/phase1-draft-smoke.mjs   (becomes supabase/tests/multi-terminal-identity-test.js in Phase 1)
import fs from "fs";
import { PGlite } from "file:///C:/seigen-commerce-lite-refactor/node_modules/@electric-sql/pglite/dist/index.js";
import { pgcrypto } from "file:///C:/seigen-commerce-lite-refactor/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js";

const DOCS = "C:/seigen-commerce-lite-refactor/docs/multi-terminal/";
const MIG = fs.readFileSync(DOCS + "phase1-migration-draft.sql", "utf8");
const RB = fs.readFileSync(DOCS + "phase1-rollback-draft.sql", "utf8");
// old live check-in body = the one the rollback restores (between its drop and its grant)
const rbText = RB;
const OLD_CHECKIN = rbText.slice(rbText.indexOf("CREATE OR REPLACE FUNCTION public.cl_device_checkin"), rbText.indexOf("drop function if exists public.cl_branch_list"));

const STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema extensions; create extension pgcrypto schema extensions;
create table public.cl_vendors (
  id uuid primary key default gen_random_uuid(), business_name text not null, owner_name text, phone text, city text,
  rpn_id uuid, device_code text, shop_secret_phrase text, cycle_start_date date,
  status text not null default 'onboarding', onboarded_at timestamptz default now(), notes text, created_by uuid,
  created_at timestamptz not null default now(), install_id text, location text, app_registered_at timestamptz,
  last_checkin_at timestamptz, lock_cart boolean not null default false, lock_add_product boolean not null default false, lock_reason text,
  constraint cl_vendors_install_id_key unique (install_id));
create table public.cl_vendor_messages (id uuid primary key default gen_random_uuid(), vendor_id uuid not null references public.cl_vendors(id) on delete cascade,
  title text not null, body text not null, channel text not null, status text not null default 'pending', created_by uuid,
  created_at timestamptz not null default now(), delivered_at timestamptz);
alter table public.cl_vendors enable row level security;
grant all on public.cl_vendors, public.cl_vendor_messages to anon, authenticated;
` + OLD_CHECKIN;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (x ? " -> " + x : "")); } };
const db = new PGlite({ extensions: { pgcrypto } });
const q = async (s, p) => (await db.query(s, p)).rows;
const err = async (s, p) => { try { await db.query(s, p); return null; } catch (e) { return e.message; } };
const asAnon = async (s, p) => { await db.exec("set role anon"); try { return await q(s, p); } finally { await db.exec("reset role"); } };
const anonErr = async (s, p) => { await db.exec("set role anon"); try { await db.query(s, p); return null; } catch (e) { return e.message; } finally { await db.exec("reset role"); } };

await db.exec(STUB);
// an existing single-device shop from before the migration
await q(`select public.cl_device_checkin('OLD1','Shop Phrase','OLD1-C3','Old Shop')`);
await db.exec(MIG);
ok("migration applies", true);

const ci = (iid, ph, key) => q(`select public.cl_device_checkin(p_install_id=>$1, p_shop_secret_phrase=>$2, p_device_code=>$1||'-C1', p_business_name=>'X', p_device_key=>$3) j`, [iid, ph, key]);
ok("old shop still checks in without a key", (await ci("OLD1", "Shop Phrase", null))[0].j.vendor_id);
ok("phrase now case-insensitive", (await ci("OLD1", "  shop PHRASE ", null))[0].j.vendor_id);
ok("wrong phrase still refused", /does not match/.test(await err(`select public.cl_device_checkin('OLD1','nope','OLD1-C3','Old Shop')`)));
await ci("OLD1", "Shop Phrase", "KEY-OLD1");
ok("key recorded on first use", (await q(`select device_key from cl_vendors where install_id='OLD1'`))[0].device_key === "KEY-OLD1");
ok("other device with same install_id refused", /another device/.test(await err(`select public.cl_device_checkin(p_install_id=>'OLD1',p_shop_secret_phrase=>'Shop Phrase',p_device_code=>'OLD1-C1',p_business_name=>'X',p_device_key=>'KEY-OTHER')`)));
ok("same device at next cycle (device code changed) accepted", (await q(`select public.cl_device_checkin(p_install_id=>'OLD1',p_shop_secret_phrase=>'Shop Phrase',p_device_code=>'OLD1-C4',p_business_name=>'X',p_device_key=>'KEY-OLD1') j`))[0].j.vendor_id);

// main registers
const reg = (await asAnon(`select public.cl_branch_register('MAIN1234','Biz Phrase','K-MAIN','Gentronix','Harare CBD','B-ABCD2345','Front till') j`))[0].j;
ok("main registers: T1 on a main branch", reg.till_code === "T1" && reg.is_main === true && reg.business_id);
const reg2 = (await asAnon(`select public.cl_branch_register('MAIN1234','biz phrase','K-MAIN','Gentronix','Harare CBD') j`))[0].j;
ok("register is idempotent", reg2.terminal_id === reg.terminal_id);
ok("anon can't read new tables", /permission denied/.test(await anonErr(`select * from cl_terminals`)));
ok("anon can't call internal helper", /permission denied/.test(await anonErr(`select cl_new_join_code()`)));

// main issues a code for its own branch, a second terminal joins
const code = (await asAnon(`select public.cl_branch_issue_join_code('MAIN1234','Biz Phrase','K-MAIN',$1::uuid) j`, [reg.branch_id]))[0].j;
ok("code looks like XXXX-XXXX", /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(code.code), code.code);
const j1 = (await asAnon(`select public.cl_terminal_join('NEWTERM1','biz phrase','K-T2',$1,'Back till') j`, [code.code.toLowerCase()]))[0].j;
ok("terminal joins existing business as T2", j1.till_code === "T2" && j1.business_id === reg.business_id, JSON.stringify(j1));
ok("joined install has its own cl_vendors row linked to the business", (await q(`select count(*)::int n from cl_vendors where install_id='NEWTERM1' and business_id=$1`, [reg.business_id]))[0].n === 1);
ok("only one business exists", (await q(`select count(*)::int n from cl_businesses`))[0].n === 1);
const j1b = (await asAnon(`select public.cl_terminal_join('NEWTERM1','biz phrase','K-T2',$1,'Back till') j`, [code.code]))[0].j;
ok("retried join returns the same terminal", j1b.terminal_id === j1.terminal_id);
ok("used code refused for another device", (await asAnon(`select public.cl_terminal_join('NEWTERM2','biz phrase','K-T3',$1) j`, [code.code]))[0].j.error === "JOIN_CODE_USED");
ok("a refused join creates no vendor row", (await q(`select count(*)::int n from cl_vendors where install_id='NEWTERM2'`))[0].n === 0);
ok("expired code refused, nothing created", await (async () => {
  const c2 = (await asAnon(`select public.cl_branch_issue_join_code('MAIN1234','Biz Phrase','K-MAIN',$1::uuid) j`, [reg.branch_id]))[0].j;
  await q(`update cl_branch_join_codes set expires_ts = now() - interval '1 minute' where expires_ts = $1::timestamptz`, [c2.expires_ts]);
  const r = (await asAnon(`select public.cl_terminal_join('NEWTERM3','biz phrase','K-T4',$1) j`, [c2.code]))[0].j;
  return r.error === "JOIN_CODE_EXPIRED" && (await q(`select count(*)::int n from cl_vendors where install_id='NEWTERM3'`))[0].n === 0;
})());
ok("joined terminal checks in to its own row, no new vendor", (await ci("NEWTERM1", "biz phrase", "K-T2"))[0].j.terminal_id === j1.terminal_id
   && (await q(`select count(*)::int n from cl_vendors`))[0].n === 3);

// existing remote device (own vendor row, own phrase) joins a new remote branch
await ci("REMOTE01", "Remote Own Phrase", "K-R");
const rcode = (await asAnon(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN1234',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-MAIN',p_new_branch_name=>'Bulawayo') j`))[0].j;
ok("'Bula wayo' is the same branch as 'Bulawayo' (no duplicate)", (await asAnon(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN1234',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-MAIN',p_new_branch_name=>'Bula wayo') j`))[0].j.branch_id === rcode.branch_id);
const mism = (await asAnon(`select public.cl_terminal_join(p_install_id=>'REMOTE01',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-R',p_join_code=>$1,p_device_phrase=>'Remote Own Phrase',p_expected_branch_name=>'Mutare') j`, [rcode.code]))[0].j;
ok("branch-name mismatch refused, code still usable", mism.error === "BRANCH_NAME_MISMATCH"
   && (await q(`select count(*)::int n from cl_branch_join_codes where used_by_terminal is null and branch_id=$1`, [rcode.branch_id]))[0].n >= 1);
const bad = (await asAnon(`select public.cl_terminal_join('REMOTE01','wrong','K-R',$1) j`, [rcode.code]))[0].j;
ok("wrong business phrase refused", bad.error === "PHRASE_MISMATCH");
const rj = (await asAnon(`select public.cl_terminal_join(p_install_id=>'REMOTE01',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-R',p_join_code=>$1,p_legacy_branch_id=>'B-WXYZ6789',p_device_phrase=>'Remote Own Phrase',p_expected_branch_name=>'BULAWAYO') j`, [rcode.code]))[0].j;
ok("existing remote joins as T1 of new branch", rj.till_code === "T1" && rj.is_main === false && rj.branch_name === "Bulawayo", JSON.stringify(rj));
ok("remote's own vendor row kept, phrase unchanged", (await q(`select shop_secret_phrase p from cl_vendors where install_id='REMOTE01'`))[0].p === "Remote Own Phrase");
ok("legacy branch id recorded", (await q(`select legacy_branch_id l from cl_branches where id=$1`, [rj.branch_id]))[0].l === "B-WXYZ6789");
ok("remote can't issue codes", /main-branch/.test(await anonErr(`select public.cl_branch_issue_join_code('REMOTE01','Remote Own Phrase','K-R',$1::uuid)`, [rj.branch_id])));
const list = (await asAnon(`select public.cl_branch_list('MAIN1234','Biz Phrase','K-MAIN') j`))[0].j;
ok("main's list shows 2 branches with terminals", list.branches.length === 2 && list.branches[0].terminals.length === 2);
const rlist = (await asAnon(`select public.cl_branch_list('REMOTE01','Remote Own Phrase','K-R') j`))[0].j;
ok("remote's list shows branches, no terminals", rlist.branches.length === 2 && rlist.branches.every(b => b.terminals === null));
ok("invalid code counted", (await asAnon(`select public.cl_terminal_join('ZZZZZZZZ','x','k','AAAA-AAAA') j`))[0].j.error === "JOIN_CODE_INVALID"
   && (await q(`select count(*)::int n from cl_join_failures where install_id='ZZZZZZZZ'`))[0].n === 1);
for (let i = 0; i < 9; i++) await asAnon(`select public.cl_terminal_join('ZZZZZZZZ','x','k','AAAA-AAAA')`);
ok("11th wrong code in an hour is locked", /JOIN_LOCKED/.test(await anonErr(`select public.cl_terminal_join('ZZZZZZZZ','x','k','AAAA-AAAA')`)));

await db.exec(RB);
ok("rollback applies", true);
ok("rollback: tables gone, vendors kept", (await q(`select to_regclass('public.cl_terminals') t, (select count(*)::int from cl_vendors) n`))[0].t === null);
ok("rollback: old check-in works again", (await q(`select public.cl_device_checkin('OLD1','Shop Phrase','OLD1-C3','Old Shop') j`))[0].j.vendor_id);
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
