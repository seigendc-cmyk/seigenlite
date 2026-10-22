// node supabase/tests/branch-stock-test.js
//
// Tests supabase/migrations/20261024120000_branch_stock.sql (and its
// rollback) in an in-memory PGlite built from the repo (the live shape),
// never the live database:
//   - only a business with 2+ active tills stores anything;
//   - a branch's stock = the SUM of its active tills (owner's option 1);
//     main-branch callers also get each till's figure, remote callers don't;
//   - absolute figures: a retry or a late (older) push changes nothing;
//     a full push removes the till's products it no longer has;
//   - a deactivated till is left out (and refused); a shared-stock branch
//     answers with its seiGEN figure and stores nothing from its tills;
//   - NO cost anywhere in what devices get (stock, dispatches);
//   - another business sees nothing; grants; the rollback restores the
//     whole catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ, v21AdminSeed } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261024120000_branch_stock.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261024120000_branch_stock.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const hex = () => crypto.randomBytes(16).toString('hex');
const uuidOf = (h) => h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261106120000_branch_views.sql', '20261107120000_shop_roles.sql', '20261108120000_shop_managers_everywhere.sql', '20261109120000_office_seats.sql', '20261110120000_staff_first_owner.sql', '20261112120000_builtin_customers.sql']) });   // the shape just before it (both are on live now)
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
    await pg.exec('set role anon');
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  const auth = (iid, phrase) => ({ p_install_id: iid, p_secret_phrase: phrase || 'Mandie Phrase', p_device_key: key(iid) });
  const code = async (iid, o) => { const s = v21AdminSeed('admin-pass-1'); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j.code; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 21 })).j;

  let r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('it applies', r.ok, r.e);

  // Mandie Babyware: Harare (main) T1, then T2; Murehwa T1. Another shop: one till.
  r = await anon('cl_branch_register', { ...auth('HA01'), p_business_name: 'Mandie Babyware', p_branch_name: 'Harare' });
  ok('Harare registers (T1)', r.j && r.j.till_code === 'T1', JSON.stringify(r));
  const HARARE = r.j.branch_id;
  await anon('cl_branch_register', { ...auth('SOLO', 'Solo Phrase'), p_business_name: 'Solo Shop', p_branch_name: 'Mbare' });

  const CAT_A = hex(), CAT_B = hex(), LOCAL_X = 'local:' + hex();
  const push = (iid, asOf, full, rows, phrase) => anon('cl_device_stock_levels_push', { ...auth(iid, phrase), p_as_of: asOf, p_full: full, p_rows: rows });
  const stock = (iid, branch) => anon('cl_device_branch_stock', { ...auth(iid), ...(branch ? { p_branch_id: branch } : {}) });

  r = await push('HA01', '2026-10-13T08:00:00Z', true, [{ k: CAT_A, cat_uid: CAT_A, code: 'BIB1', name: 'Bib', qty: 10, low: 3 }]);
  ok('one till in the business: not enabled, nothing stored', r.j && r.j.ok && r.j.enabled === false && (await q(`select count(*)::int c from cl_till_stock_levels`))[0].c === 0, JSON.stringify(r));
  r = await push('SOLO', '2026-10-13T08:00:00Z', true, [{ k: CAT_A, name: 'Bread', qty: 1 }], 'Solo Phrase');
  ok('a single-till shop: not enabled either', r.j && r.j.enabled === false, JSON.stringify(r));

  ok('Harare T2 joins', (await join('HA02', await code('HA01', { p_branch_id: HARARE }))).till_code === 'T2');
  const mj = await join('MU01', await code('HA01', { p_new_branch_name: 'Murehwa' }));
  ok('Murehwa T1 joins', mj && mj.till_code === 'T1', JSON.stringify(mj));
  const MUREHWA = mj.branch_id;

  r = await push('HA01', '2026-10-13T08:00:00Z', true, [
    { k: CAT_A, cat_uid: CAT_A, code: 'BIB1', name: 'Bib', qty: 10, low: 3 },
    { k: CAT_B, cat_uid: CAT_B, code: 'CAP1', name: 'Cap', qty: 0 },
    { k: LOCAL_X, code: 'OWN1', name: 'Harare-only rattle', qty: 3 }]);
  ok('3 tills now: Harare T1 sends all its products', r.j && r.j.enabled === true && r.j.received === 3 && r.j.products === 3, JSON.stringify(r));
  r = await push('HA02', '2026-10-13T08:05:00Z', true, [{ k: CAT_A, cat_uid: CAT_A, code: 'BIB1', name: 'Bib', qty: 4 }, { k: CAT_B, cat_uid: CAT_B, code: 'CAP1', name: 'Cap', qty: -2 }]);
  ok('Harare T2 sends its own (a negative older figure is accepted as it is)', r.j && r.j.products === 2, JSON.stringify(r));
  r = await push('MU01', '2026-10-13T08:10:00Z', true, [{ k: CAT_A, cat_uid: CAT_A, code: 'BIB1', name: 'Bib', qty: 7, low: 2 }]);
  ok('Murehwa T1 sends its own', r.j && r.j.products === 1, JSON.stringify(r));

  const branchOf = (j, id) => (j.branches || []).find((b) => b.id === id);
  const rowOf = (b, k) => (b.rows || []).find((x) => x.k === k);
  r = await stock('HA01');
  const hM = branchOf(r.j, HARARE), mM = branchOf(r.j, MUREHWA);
  ok('main sees every branch of the business, main first', r.j && r.j.is_main === true && r.j.enabled === true && r.j.branches.length === 2 && r.j.branches[0].id === HARARE, JSON.stringify(r).slice(0, 400));
  ok('Harare\'s Bib = T1 10 + T2 4 = 14, with each till\'s own figure', rowOf(hM, CAT_A).qty === 14 && rowOf(hM, CAT_A).t.T1 === 10 && rowOf(hM, CAT_A).t.T2 === 4, JSON.stringify(rowOf(hM, CAT_A)));
  ok('Cap = 0 + (-2) = -2; the Harare-only product shows as Harare\'s', rowOf(hM, CAT_B).qty === -2 && rowOf(hM, LOCAL_X).qty === 3 && rowOf(hM, LOCAL_X).code === 'OWN1');
  ok('Murehwa\'s Bib = 7; low threshold and code travel', rowOf(mM, CAT_A).qty === 7 && rowOf(mM, CAT_A).low === 2 && rowOf(mM, CAT_A).code === 'BIB1');
  ok('main gets each till\'s times (last updated)', hM.tills.length === 2 && hM.tills.every((t) => t.pushed_at && t.as_of) && hM.updated_at && hM.active_tills === 2, JSON.stringify(hM.tills));
  r = await stock('MU01');
  const hR = branchOf(r.j, HARARE);
  ok('a remote till sees the branch totals', r.j && r.j.is_main === false && rowOf(hR, CAT_A).qty === 14, JSON.stringify(r).slice(0, 300));
  ok('... but not each till\'s figure, nor the till list', rowOf(hR, CAT_A).t === null && hR.tills === null, JSON.stringify(hR).slice(0, 300));
  r = await stock('HA01', MUREHWA);
  ok('one branch only, when asked', r.j.branches.length === 1 && r.j.branches[0].id === MUREHWA);

  // never a cost: put costs where they exist and look for them in every answer
  await q(`insert into cl_catalogue_products (business_id, product_uid, code, name, price, cost, change_seq, last_op_id) values ((select business_id from cl_branches where id = $1), $2, 'BIB1', 'Bib', 5, 3.21, 1, 'op1')`, [HARARE, CAT_A]);
  const DID = hex();
  r = await anon('cl_device_dispatch_send', { ...auth('HA01'), p_dispatch: { id: uuidOf(DID), to_branch_id: MUREHWA, dn_no: 1, dn_display: 'DN-T1-0001', lines: [{ cat_uid: CAT_A, code: 'BIB1', name: 'Bib', qty: 2, unit_cost: 3.21 }], delivery: { cost: 4.56, currency: 'USD' } } });
  ok('(a dispatch with a unit cost and a delivery cost)', r.j && r.j.ok, JSON.stringify(r));
  const asText = async (iid) => JSON.stringify((await stock(iid)).j) + JSON.stringify((await anon('cl_device_business_dispatches', { ...auth(iid) })).j);
  for (const iid of ['HA01', 'MU01']) {
    const t = await asText(iid);
    ok('no cost in anything ' + (iid === 'HA01' ? 'main' : 'a remote') + ' gets (no "cost", "charge", 3.21 or 4.56)', !/cost|charge|3\.21|4\.56/i.test(t), t.slice(0, 300));
  }
  r = await anon('cl_device_business_dispatches', { ...auth('MU01') });
  const dd = r.j && r.j.dispatches && r.j.dispatches[0];
  ok('a remote sees the business\'s dispatches: number, branches, status, lines', dd && dd.dn_display === 'DN-T1-0001' && dd.from_branch === 'Harare' && dd.to_branch === 'Murehwa' && dd.status === 'sent' && dd.lines[0].qty === 2 && dd.open_issues === 0, JSON.stringify(r).slice(0, 400));
  r = await anon('cl_device_business_dispatches', { ...auth('SOLO', 'Solo Phrase') });
  ok('another business sees none of them', r.j && r.j.dispatches.length === 0, JSON.stringify(r));
  r = await anon('cl_device_branch_stock', { ...auth('SOLO', 'Solo Phrase') });
  ok('... nor Mandie\'s stock (only its own branch, with no figures)', r.j && r.j.enabled === false && r.j.branches.length === 1 && r.j.branches[0].name === 'Mbare' && r.j.branches[0].rows.length === 0, JSON.stringify(r));

  // absolute figures, never twice
  r = await push('HA01', '2026-10-13T09:00:00Z', false, [{ k: CAT_A, cat_uid: CAT_A, code: 'BIB1', name: 'Bib', qty: 9, low: 3 }]);
  ok('a change: only that product is sent (the others stay)', r.j && r.j.received === 1 && r.j.products === 3, JSON.stringify(r));
  r = await push('HA01', '2026-10-13T09:00:00Z', false, [{ k: CAT_A, cat_uid: CAT_A, code: 'BIB1', name: 'Bib', qty: 9, low: 3 }]);
  ok('the same push again (a retry) changes nothing', rowOf(branchOf((await stock('HA01')).j, HARARE), CAT_A).qty === 13);
  r = await push('HA01', '2026-10-13T08:30:00Z', false, [{ k: CAT_A, cat_uid: CAT_A, code: 'BIB1', name: 'Bib', qty: 100 }]);
  ok('a late, OLDER push is ignored', r.j && r.j.stale === true && rowOf(branchOf((await stock('HA01')).j, HARARE), CAT_A).qty === 13, JSON.stringify(r));
  r = await push('HA01', '2026-10-13T10:00:00Z', true, [{ k: CAT_A, cat_uid: CAT_A, code: 'BIB1', name: 'Bib', qty: 9 }, { k: CAT_B, cat_uid: CAT_B, code: 'CAP1', name: 'Cap', qty: 1 }]);
  ok('a full push without the rattle removes it from Harare T1', r.j && r.j.products === 2 && !rowOf(branchOf((await stock('HA01')).j, HARARE), LOCAL_X), JSON.stringify(r));

  // refusals
  r = await push('HA01', '2026-10-13T11:00:00Z', false, [{ k: CAT_A, name: 'Bib', qty: 'x' }]);
  ok('a quantity that isn\'t a whole number is refused (nothing changes)', /whole number/.test(r.e || '') && rowOf(branchOf((await stock('HA01')).j, HARARE), CAT_A).qty === 13, JSON.stringify(r));
  r = await push('HA01', '2026-10-13T11:00:00Z', false, [{ k: 'bad key!', name: 'Bib', qty: 1 }]);
  ok('a malformed product key is refused', /key is missing or malformed/.test(r.e || ''), JSON.stringify(r));
  r = await push('HA01', 'yesterday', false, []);
  ok('a push without a valid time is refused', /time of the stock figures/.test(r.e || ''), JSON.stringify(r));
  r = await push('NOPE', '2026-10-13T11:00:00Z', false, []);
  ok('a device that isn\'t a till is refused', !!r.e, JSON.stringify(r));

  // a deactivated till is left out
  await q(`update cl_terminals set active = false where install_id = 'HA02'`);
  r = await stock('HA01');
  ok('Harare T2 switched off: Harare\'s Bib = T1 only (9)', rowOf(branchOf(r.j, HARARE), CAT_A).qty === 9 && rowOf(branchOf(r.j, HARARE), CAT_A).t.T2 === undefined, JSON.stringify(rowOf(branchOf(r.j, HARARE), CAT_A)));
  r = await push('HA02', '2026-10-13T12:00:00Z', false, [{ k: CAT_A, name: 'Bib', qty: 50 }]);
  ok('... and its pushes are refused as data', r.j && r.j.error === 'TERMINAL_INACTIVE', JSON.stringify(r));
  await q(`update cl_terminals set active = true where install_id = 'HA02'`);

  // a shared-stock branch: seiGEN's figure
  await q(`update cl_branches set stock_mode = 'shared' where id = $1`, [MUREHWA]);
  await q(`insert into cl_branch_stock (branch_id, product_uid, business_id, total, available, change_seq) values ($1, $2, (select business_id from cl_branches where id = $1), 21, 21, 1)`, [MUREHWA, CAT_A]);
  r = await stock('HA01', MUREHWA);
  ok('a shared-stock branch answers with its seiGEN figure (21), named from the catalogue', r.j.branches[0].stock_mode === 'shared' && rowOf(r.j.branches[0], CAT_A).qty === 21 && rowOf(r.j.branches[0], CAT_A).name === 'Bib', JSON.stringify(r.j.branches[0]).slice(0, 300));
  r = await push('MU01', '2026-10-13T12:00:00Z', true, [{ k: CAT_A, name: 'Bib', qty: 1 }]);
  ok('... and its tills\' pushes store nothing', r.j && r.j.enabled === false && r.j.shared === true, JSON.stringify(r));

  // grants
  const can = async (role, fn) => (await q(`select has_function_privilege($1, $2, 'execute') x`, [role, fn]))[0].x;
  ok('devices (anon) may call the three device functions',
    await can('anon', 'public.cl_device_stock_levels_push(text,text,text,text,boolean,jsonb)') && await can('anon', 'public.cl_device_branch_stock(text,text,text,uuid)') &&
    await can('anon', 'public.cl_device_business_dispatches(text,text,text,integer)'));
  ok('cl_bs_enabled is internal', !(await can('anon', 'public.cl_bs_enabled(uuid)')) && !(await can('authenticated', 'public.cl_bs_enabled(uuid)')));
  for (const t of ['cl_till_stock_levels', 'cl_till_stock_push']) {
    ok(t + ': RLS on, nothing granted to anon or authenticated',
      (await q(`select relrowsecurity r from pg_class where oid = $1::regclass`, ['public.' + t]))[0].r &&
      !(await q(`select has_table_privilege('anon', $1, 'select') x`, ['public.' + t]))[0].x &&
      !(await q(`select has_table_privilege('authenticated', $1, 'select') x`, ['public.' + t]))[0].x);
  }

  r = await (async () => { try { await pg.exec(MIG); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('a second run is refused and changes nothing', /already exists/.test(r.e || ''), r.e);

  // a deleted till takes its figures with it (they are copies)
  r = await (async () => { try { await pg.exec(RB); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } })();
  ok('the rollback applies (the figures are only copies the tills send again)', r.ok, r.e);
  // the test's own data rows (dispatch, catalogue, shared stock) aren't part of the catalogue fingerprint
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
