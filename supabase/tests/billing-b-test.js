// node supabase/tests/billing-b-test.js
//
// Tests supabase/migrations/20261021120000_billing_b.sql (and its rollback)
// in an in-memory PGlite built from the repo (the live shape), never the live
// database: the duplicate-business refusal (same name + same phrase only, any
// spelling of the name, archived ones don't count, the 0.5-second race), the
// Console's link warnings, and the Chipo Clothing merge as it is on live
// (two businesses, same phrase, Sothleapark with 3 catalogue products and an
// unused join code): what blocks it, what moves, what stays, the price after
// it (branch, not main), the tills' view after it (branch list, catalogue,
// check-in, a dispatch Harare CBD -> Sothleapark through seiGEN), the Lite
// plan limit, grants and the rollback.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261021120000_billing_b.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261022120000_catalogue_merge_links.sql', '20261023120000_admin_passcode_from_main.sql', '20261023180000_update_app_first_message.sql', '20261024120000_branch_stock.sql', '20261025120000_min_app_build.sql', '20261105120000_itred_order_fulfilment.sql', '20261106120000_branch_views.sql', '20261107120000_shop_roles.sql', '20261108120000_shop_managers_everywhere.sql', '20261109120000_office_seats.sql', '20261110120000_staff_first_owner.sql']) });   // the live shape, just before this migration
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const one = async (sql, p) => (await q(sql, p))[0];
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p, role) {
    await pg.exec('set role ' + (role || (claims ? 'authenticated' : 'anon')));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }
  const staff = {};
  for (const [k, sys] of [['SYS', true], ['ACT', false], ['NONE', false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, true, now()) returning id`, ['Staff ' + k, sys]))[0].id;
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });
  const modId = async (k) => ((await q(`select id from cl_modules where key = $1`, [k]))[0] || {}).id ||
    (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [k]))[0].id;
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff.ACT, await modId('activation_codes')]);

  // device calls, as anon (what the app does)
  const KEY = {}; const key = (iid) => (KEY[iid] = KEY[iid] || crypto.randomBytes(16).toString('hex'));
  const PH = {};
  const call = async (iid, fn, args, phrase) => {
    const names = Object.keys(args || {});
    const sql = `select public.${fn}(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3${names.map((n, i) => `, ${n}=>$${i + 4}`).join('')}) j`;
    const x = await as(null, sql, [iid, phrase || PH[iid], key(iid), ...names.map((n) => args[n])]);
    return x.e ? { raised: x.e } : x.r[0].j;
  };
  const register = (iid, phrase, name, branch) => { PH[iid] = phrase; return call(iid, 'cl_branch_register', { p_business_name: name, p_branch_name: branch, p_legacy_branch_id: 'B-' + (iid + 'XXXXXXXX').slice(0, 8) }); };
  const checkin = async (iid, phrase, name) => { PH[iid] = phrase;
    const x = await as(null, `select public.cl_device_checkin(p_install_id=>$1, p_shop_secret_phrase=>$2, p_device_code=>$1, p_business_name=>$3, p_device_key=>$4) j`, [iid, phrase, name, key(iid)]);
    return x.e ? { raised: x.e } : x.r[0].j; };
  const product = (biz, code, name) => q(`insert into cl_catalogue_products (business_id, product_uid, code, name, price, cost, low_threshold, active, change_seq, last_op_id, updated_ts)
    values ($1, replace(gen_random_uuid()::text, '-', ''), $2, $3, 5, 2, 0, true, nextval('cl_catalogue_seq'), 'test-op', now())`, [biz, code, name]);
  const planSet = (biz, code) => q(`insert into cl_plan_assignments (business_id, plan_code, reason, set_by) values ($1, $2, 'test', $3)`, [biz, code, staff.SYS]);

  // ---- before the migration: Chipo Clothing as it is on live ----
  const CP = 'Chipo Phrase';
  const hg = await register('HG58', CP, 'Chipo Clothing', 'Harare CBD');
  const so = await register('2KBZ', CP, 'Chipo Clothing', 'Sothleapark');
  ok('before: the same name and phrase made two businesses (the live Chipo case)', hg.business_id && so.business_id && hg.business_id !== so.business_id, JSON.stringify([hg, so]));
  const HBIZ = hg.business_id, SBIZ = so.business_id, SBR = so.branch_id;
  await planSet(HBIZ, 'business'); await planSet(SBIZ, 'business');
  await product(HBIZ, 'pnt001', 'Pants');
  for (const [c, n] of [['kds003', 'Kids dress'], ['lmd001', 'Ladies top'], ['mb005', 'Men belt']]) await product(SBIZ, c, n);
  const jcode = await call('2KBZ', 'cl_branch_issue_join_code', { p_branch_id: SBR, p_new_branch_name: null });
  ok('before: Sothleapark has an unused join code', !!(jcode && jcode.code), JSON.stringify(jcode));
  const hgPull0 = await call('HG58', 'cl_catalogue_pull', { p_cursor: 0 });
  const hgCursor = hgPull0.cursor;

  // ---- apply ----
  let e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('the migration applies on the live shape', !e, e);
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /billing_b aborted: already there/.test(e || ''), e);

  // ---- 1. the duplicate-business refusal ----
  const nBiz = async () => (await one(`select count(*)::int c from cl_businesses`)).c;
  let n0 = await nBiz();
  let r = await register('CH03', CP, '  chipo   CLOTHING ', 'Avondale');
  ok('same name (any spelling) + same phrase: DUPLICATE_BUSINESS, naming the business and its main branch (the oldest)',
    r.error === 'DUPLICATE_BUSINESS' && r.business_name === 'Chipo Clothing' && r.main_branch === 'Harare CBD' && /join code/.test(r.message), JSON.stringify(r));
  ok('... and no business, branch or till was made', (await nBiz()) === n0 && !(await one(`select 1 x from cl_terminals where install_id = 'CH03'`)));
  r = await register('CH04', 'Another Phrase', 'Chipo Clothing', 'Mbare');
  ok('same name, another phrase: allowed (another shop with the same name)', !!r.business_id && !r.error, JSON.stringify(r));
  r = await register('CH05', CP, 'Tendai Hardware', 'Harare');
  ok('same phrase, another name: allowed (a common phrase is shared by many shops)', !!r.business_id && !r.error, JSON.stringify(r));
  r = await register('HG58', CP, 'Chipo Clothing', 'Harare CBD');
  ok('a main till registering again still gets its own till back (idempotent)', r.terminal_id === hg.terminal_id && !r.error, JSON.stringify(r));
  await q(`update cl_businesses set archived_at = now(), archive_reason = 'test' where id = $1`, [(await one(`select business_id b from cl_terminals where install_id = 'CH05'`)).b]);
  r = await register('CH06', CP, 'Tendai Hardware', 'Harare');
  ok('an archived business doesn\'t block its name', !!r.business_id && !r.error, JSON.stringify(r));
  const [r1, r2] = await Promise.all([register('RC01', 'Race Phrase', 'Race Shop', 'One'), register('RC02', 'Race Phrase', 'Race Shop', 'Two')]);
  ok('two devices registering the same business at once: one business, one refusal', [r1, r2].filter((x) => x.business_id).length === 1 && [r1, r2].filter((x) => x.error === 'DUPLICATE_BUSINESS').length === 1, JSON.stringify([r1, r2]));

  // ---- 2. the Console's warnings ----
  const warn = async (k, code) => { const x = await as(k ? tok(k) : null, `select public.cl_licence_link_warnings($1) j`, [code]); return x.e ? { raised: x.e } : x.r[0].j; };
  r = await warn('ACT', 'HG58-AAAA');
  ok('T1 of a business another business shares its name with: duplicate_business, listing the other (Sothleapark, 1 till)',
    r.length === 1 && r[0].kind === 'duplicate_business' && r[0].others.some((o) => o.id === SBIZ && o.main_branch === 'Sothleapark' && o.tills === 1), JSON.stringify(r));
  await checkin('CH07', CP, 'Chipo Clothing');
  r = await warn('ACT', 'CH07-AAAA');
  ok('a device that isn\'t a till while a business with its shop\'s name exists: not_linked', r.length === 1 && r[0].kind === 'not_linked' && r[0].others.length >= 2, JSON.stringify(r));
  await checkin('ZZ01', 'Zed Phrase', 'Zed Stores');
  r = await warn('ACT', 'ZZ01-AAAA');
  ok('a single shop of its own: no warning', Array.isArray(r) && r.length === 0, JSON.stringify(r));
  r = await warn('SYS', 'zz01'); ok('a SysAdmin may ask too (and any spelling of the code)', Array.isArray(r) && r.length === 0, JSON.stringify(r));
  r = await warn('NONE', 'HG58-AAAA'); ok('staff without Activation Codes: not authorized', /Not authorized/.test(r.raised || ''), JSON.stringify(r));
  r = await warn(null, 'HG58-AAAA'); ok('a device (anon) can\'t call it', /permission denied/.test(r.raised || ''), JSON.stringify(r));

  // ---- 3. the merge: who may ----
  const merge = async (k, from, into, reason, move) => {
    const x = await as(k ? tok(k) : null, `select public.cl_business_merge($1, $2, $3, $4) j`, [from, into, reason, move]);
    return x.e ? { raised: x.e } : x.r[0].j;
  };
  r = await merge('ACT', SBIZ, HBIZ, 'Sothleapark is a branch of Chipo', true);
  ok('only a SysAdmin may merge (Activation Codes staff are refused)', /only a SysAdmin/.test(r.raised || ''), JSON.stringify(r));
  r = await merge(null, SBIZ, HBIZ, 'x', true); ok('a device (anon) can\'t merge', /permission denied/.test(r.raised || ''), JSON.stringify(r));
  r = await as(tok('SYS'), `select public.cl_business_merge_core($1, $2, 'x', true, null) j`, [SBIZ, HBIZ]);
  ok('the core function has no grants (owner-only, for data-fix files)', /permission denied/.test(r.e || ''), JSON.stringify(r));

  // ---- 4. what blocks a merge (and changes nothing) ----
  const snapRows = async () => JSON.stringify(await q(`select (select json_agg(b order by id) from cl_branches b where business_id in ($1, $2)) br,
      (select json_agg(t order by id) from cl_terminals t where business_id in ($1, $2)) te,
      (select json_agg(c.business_id order by product_uid) from cl_catalogue_products c where business_id in ($1, $2)) ca,
      (select json_agg(z.archived_at) from cl_businesses z where id in ($1, $2)) ar`, [SBIZ, HBIZ]));
  const s0 = await snapRows();
  r = await merge('SYS', SBIZ, HBIZ, 'Sothleapark is a branch of Chipo', false);
  ok('Sothleapark has 3 catalogue products: refused without "move the catalogue"', /MERGE_CATALOGUE: Chipo Clothing has 3 catalogue products/.test(r.raised || ''), JSON.stringify(r));
  r = await merge('SYS', SBIZ, HBIZ, 'ok', true);
  ok('a reason of under 3 characters is refused', /Give a reason/.test(r.raised || ''), JSON.stringify(r));
  r = await merge('SYS', SBIZ, SBIZ, 'Sothleapark is a branch of Chipo', true);
  ok('merging a business into itself is refused', /MERGE_SAME/.test(r.raised || ''), JSON.stringify(r));
  await product(SBIZ, 'PNT001 ', 'Pants (Sothleapark)');
  r = await merge('SYS', SBIZ, HBIZ, 'Sothleapark is a branch of Chipo', true);
  ok('a product code both catalogues use is named and refused', /MERGE_CATALOGUE_CODES: Both catalogues use the code\(s\) PNT001/.test(r.raised || ''), JSON.stringify(r));
  await q(`delete from cl_catalogue_products where business_id = $1 and code = 'PNT001 '`, [SBIZ]);
  await q(`insert into cl_customers (business_id, customer_uid, name, phone, phone_norm, customer_type, credit_limit, active, change_seq, created_at, updated_at)
           values ($1, 'cust-0001', 'A customer', '0772000000', '263772000000', 'retail', 0, true, 1, now(), now())`, [SBIZ]).catch((x) => ok('customer fixture', false, x.message));
  r = await merge('SYS', SBIZ, HBIZ, 'Sothleapark is a branch of Chipo', true);
  ok('customers on the duplicate: refused, saying what is in the way', /MERGE_BLOCKED: Chipo Clothing can't be merged yet: it has 1 customers/.test(r.raised || ''), JSON.stringify(r));
  await q(`delete from cl_customers where business_id = $1`, [SBIZ]);
  ok('none of the refusals changed anything', (await snapRows()) === s0);

  // ---- 5. the Chipo merge ----
  const priceBefore = await one(`select public.cl_plan_price(null, '2KBZ', 30) j`);
  ok('before: Sothleapark\'s till is priced as a main till (USD 15)', priceBefore.j.till_role === 'main' && Number(priceBefore.j.unit_fee) === 15, JSON.stringify(priceBefore.j));
  const maxSeq = (await one(`select max(change_seq)::bigint m from cl_catalogue_products`)).m;
  r = await merge('SYS', SBIZ, HBIZ, 'Sothleapark is a branch of Chipo Clothing (owner, 2026-10-13)', true);
  ok('SysAdmin merges Sothleapark\'s business into Harare CBD\'s, moving its catalogue', r.ok === true && r.into === HBIZ && r.moved.branches === 1 && r.moved.tills === 1 && r.moved.vendors === 1 && r.moved.catalogue_products === 3 && r.branches_now === 'Harare CBD, Sothleapark', JSON.stringify(r));
  const br = await q(`select name, is_main, business_id from cl_branches where business_id = $1 order by is_main desc`, [HBIZ]);
  ok('Harare CBD stays the main branch; Sothleapark is a (non-main) branch of the same business, same branch id',
    br.length === 2 && br[0].name === 'Harare CBD' && br[0].is_main && br[1].name === 'Sothleapark' && !br[1].is_main && (await one(`select business_id b from cl_branches where id = $1`, [SBR])).b === HBIZ);
  const te = await one(`select business_id, branch_id, till_code from cl_terminals where install_id = '2KBZ'`);
  ok('Sothleapark\'s till moves with it and keeps its till code (T1 of Sothleapark)', te.business_id === HBIZ && te.branch_id === SBR && te.till_code === 'T1');
  ok('its vendor row now points at the kept business', (await one(`select business_id b from cl_vendors where install_id = '2KBZ'`)).b === HBIZ);
  const cat = await q(`select code, change_seq::bigint s from cl_catalogue_products where business_id = $1 order by code`, [HBIZ]);
  ok('one catalogue of 4 products; the moved 3 have new change numbers (so every till pulls them)',
    cat.map((c) => c.code).join(',') === 'kds003,lmd001,mb005,pnt001' && cat.filter((c) => c.code !== 'pnt001').every((c) => BigInt(c.s) > BigInt(maxSeq)), JSON.stringify(cat));
  const arch = await one(`select archived_at, archive_reason from cl_businesses where id = $1`, [SBIZ]);
  ok('the duplicate is archived, not deleted: "Merged into Chipo Clothing (...): reason"', !!arch.archived_at && /^Merged into Chipo Clothing \(.+\): Sothleapark is a branch/.test(arch.archive_reason), JSON.stringify(arch));
  ok('Sothleapark\'s unused join code is expired', (await one(`select count(*)::int c from cl_branch_join_codes where branch_id = $1 and used_ts is null and expires_ts > now()`, [SBR])).c === 0);
  ok('history stays with the old business: its plan assignment', (await one(`select count(*)::int c from cl_plan_assignments where business_id = $1`, [SBIZ])).c === 1);
  const log = await one(`select staff_id, detail from cl_activity_log where action = 'business_merged' order by created_at desc limit 1`);
  ok('logged: who, from, into, reason and counts', log && log.staff_id === staff.SYS && log.detail.from === SBIZ && log.detail.into === HBIZ && log.detail.catalogue_products === 3, JSON.stringify(log));
  const priceAfter = await one(`select public.cl_plan_price(null, '2KBZ', 30) j`);
  ok('after: Sothleapark\'s till is priced as a branch\'s first till (USD 7); Harare CBD\'s stays main (15)',
    priceAfter.j.till_role === 'branch' && Number(priceAfter.j.unit_fee) === 7 && (await one(`select public.cl_plan_price(null, 'HG58', 30) j`)).j.till_role === 'main', JSON.stringify(priceAfter.j));
  r = await merge('SYS', SBIZ, HBIZ, 'Sothleapark is a branch of Chipo', true);
  ok('merging the archived business again is refused', /MERGE_ARCHIVED/.test(r.raised || ''), JSON.stringify(r));
  r = await warn('ACT', 'HG58-AAAA');
  ok('the archived duplicate drops out of the Console warning (only the other-phrase shop of the same name, Mbare, is left)', r.length === 1 && r[0].others.length === 1 && r[0].others[0].main_branch === 'Mbare' && !r[0].others.some((o) => o.id === SBIZ), JSON.stringify(r));

  // ---- 6. the tills after the merge ----
  r = await call('2KBZ', 'cl_branch_list', {});
  ok('Sothleapark\'s till sees its new business and both branches (its own not main)', r.business_id === HBIZ && r.branches.length === 2 && r.branches.find((b) => b.id === SBR).is_main === false, JSON.stringify(r));
  r = await checkin('2KBZ', CP, 'Chipo Clothing');
  ok('its check-in returns the kept business (the app adopts it: terminal.js)', r.business_id === HBIZ, JSON.stringify(r));
  r = await call('2KBZ', 'cl_catalogue_pull', { p_cursor: 0 });
  ok('its full catalogue pull now has all 4 products and says it isn\'t main', r.products.length === 4 && r.is_main === false, JSON.stringify(r).slice(0, 300));
  r = await call('HG58', 'cl_catalogue_pull', { p_cursor: hgCursor });
  ok('Harare CBD\'s next pull (from its old cursor) brings the 3 moved products', r.products.length === 3, JSON.stringify(r).slice(0, 300));
  r = await call('2KBZ', 'cl_catalogue_push', { p_rows: JSON.stringify([]) });
  ok('Sothleapark can no longer change the catalogue (not main)', r.error === 'NOT_MAIN', JSON.stringify(r));
  const D = crypto.randomUUID();
  r = await call('HG58', 'cl_device_dispatch_send', { p_dispatch: JSON.stringify({ id: D, to_branch_id: SBR, dn_no: 5, dn_display: 'DN-T1-0005', created_iso: '2026-10-13T10:00:00',
    sent_by: 'Chipo', from_legacy_branch_id: 'B-HG58XXXX', delivery: { cost: 0 }, lines: [{ name: 'Pants', code: 'pnt001', qty: 2 }] }) });
  ok('a dispatch Harare CBD -> Sothleapark now goes through seiGEN', r.ok === true && r.status === 'sent', JSON.stringify(r));
  r = await call('2KBZ', 'cl_device_dispatch_pull', {});
  ok('... and waits in Sothleapark\'s Incoming', (r.incoming || []).some((d) => d.id === D), JSON.stringify(r).slice(0, 300));

  // ---- 7. other refusals ----
  const a = await register('LT01', 'Lite Phrase', 'Lite One', 'Market'); const b = await register('LT02', 'Lite Phrase 2', 'Lite Two', 'Square');
  await planSet(a.business_id, 'lite'); await planSet(b.business_id, 'lite');
  r = await merge('SYS', b.business_id, a.business_id, 'Lite Two is a branch of Lite One', false);
  ok('into a Lite business (one branch): refused with the plan message, nothing moved',
    /PLAN_BRANCH_LIMIT: Your plan allows one branch/.test(r.raised || '') && (await one(`select business_id b from cl_branches where id = $1`, [b.branch_id])).b === b.business_id
    && !(await one(`select archived_at a from cl_businesses where id = $1`, [b.business_id])).a, JSON.stringify(r));
  const c1 = await register('NM01', 'Name Phrase 1', 'Name One', 'Harare'); const c2 = await register('NM02', 'Name Phrase 2', 'Name Two', 'harare');
  r = await merge('SYS', c2.business_id, c1.business_id, 'Name Two is a branch of Name One', false);
  ok('both have a branch called Harare: refused, saying so', /both have a branch called harare/.test(r.raised || ''), JSON.stringify(r));

  // ---- grants and shape ----
  const g = async (fn, role) => (await one(`select has_function_privilege($2, $1::regprocedure, 'execute') p`, [fn, role])).p;
  ok('grants: warnings and merge for signed-in staff only; the core and the name helper for nobody',
    (await g('public.cl_licence_link_warnings(text)', 'authenticated')) && !(await g('public.cl_licence_link_warnings(text)', 'anon'))
    && (await g('public.cl_business_merge(uuid,uuid,text,boolean)', 'authenticated')) && !(await g('public.cl_business_merge(uuid,uuid,text,boolean)', 'anon'))
    && !(await g('public.cl_business_merge_core(uuid,uuid,text,boolean,uuid)', 'authenticated')) && !(await g('public.cl_business_merge_core(uuid,uuid,text,boolean,uuid)', 'service_role'))
    && !(await g('public.cl_business_name_twins(uuid)', 'anon')) && !(await g('public.cl_business_name_twins(uuid)', 'authenticated')));
  ok('cl_branch_register keeps its grants (devices call it as anon)', await g('public.cl_branch_register(text,text,text,text,text,text,text,text)', 'anon'));

  const d1 = diff(before, fingerprint(await snapshot(q)));
  ok('the migration adds the 4 functions (and their grants) and changes only cl_branch_register',
    !d1.onlyA.length && d1.changed.length === 1 && /cl_branch_register/.test(d1.changed[0].key || d1.changed[0]) && d1.onlyB.every((k) => /cl_licence_link_warnings|cl_business_merge|cl_business_name_twins/.test(k)), JSON.stringify({ changed: d1.changed, onlyA: d1.onlyA, notOurs: d1.onlyB.filter((k) => !/cl_licence_link_warnings|cl_business_merge|cl_business_name_twins/.test(k)) }));

  // ---- rollback ----
  await pg.exec(RB);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('the rollback restores the exact pre-migration catalogue', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  r = await register('CH08', CP, 'Chipo Clothing', 'Belvedere');
  ok('after the rollback, a same-name same-phrase register makes a business again (the old behaviour)', !!r.business_id && !r.error, JSON.stringify(r));
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('and the migration applies again after a rollback', !e, e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
