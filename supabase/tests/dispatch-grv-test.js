// node supabase/tests/dispatch-grv-test.js
//
// Tests supabase/migrations/20261017120000_dispatch_grv.sql (and its
// rollback) in an in-memory PGlite built from the repo in the live shape,
// never the live database: sending a dispatch between two branches of one
// business (phone check, never twice, DN numbers, other businesses and own
// branch refused, delivery cost), the pull (incoming / outgoing, nothing of
// another business), the GRV (counts, differences, first till wins, retries,
// bad counts, the inter-branch charge), cancel (only the sender, only before
// the GRV), resolving differences (write-off, re-dispatch, extra confirm /
// dispute, a cancelled re-dispatch reopens its shortage), the file lookup,
// the read-only Console view, grants, the delete guard, and the rollback.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261017120000_dispatch_grv.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const uuid = () => crypto.randomUUID();

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261018120000_supplier_grv.sql']) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p) {
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }

  // ---- staff ----
  const staff = {};
  for (const [k, sys] of [['SYS', true], ['DSP', false], ['NONE', false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, true, now()) returning id`, ['Staff ' + k, sys]))[0].id;
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });

  // ---- two businesses: Acme (Harare: T1, T2; Murehwa: T1) and Beta ----
  const KEY = {}; const key = (iid) => (KEY[iid] = KEY[iid] || crypto.randomBytes(16).toString('hex'));
  const devRaw = async (sql, p) => { const x = await as(null, sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };
  const AP = 'Acme Phrase', BP = 'Beta Phrase';
  const acme = await devRaw(`select public.cl_branch_register($1, $2, $3, 'Acme', 'Harare', 'B-HARARE01') j`, ['AC01', AP, key('AC01')]);
  const c2 = await devRaw(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>$4::uuid, p_new_branch_name=>null) j`, ['AC01', AP, key('AC01'), acme.branch_id]);
  await devRaw(`select public.cl_terminal_join($1, $2, $3, $4) j`, ['AC02', AP, key('AC02'), c2.code]);
  const c3 = await devRaw(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>null, p_new_branch_name=>'Murehwa') j`, ['AC01', AP, key('AC01')]);
  const mu = await devRaw(`select public.cl_terminal_join($1, $2, $3, $4) j`, ['MU01', AP, key('MU01'), c3.code]);
  const beta = await devRaw(`select public.cl_branch_register($1, $2, $3, 'Beta', 'Gweru', 'B-GWERU001') j`, ['BE01', BP, key('BE01')]);
  const HARARE = acme.branch_id, MUREHWA = mu.branch_id, GWERU = beta.branch_id;
  const PH = { AC01: AP, AC02: AP, MU01: AP, BE01: BP };

  // ---- apply ----
  let e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('the migration applies', !e, e);
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /dispatch_grv aborted: already there/.test(e || ''), e);
  const modId = (await q(`select id from cl_modules where key = 'dispatches'`))[0].id;
  await q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff.DSP, modId]);

  // device calls, as anon (what the app does)
  const call = async (iid, fn, args, phrase) => {
    const names = Object.keys(args);
    const sql = `select public.${fn}(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3${names.map((n, i) => `, ${n}=>$${i + 4}`).join('')}) j`;
    const x = await as(null, sql, [iid, phrase || PH[iid], key(iid), ...names.map((n) => args[n])]);
    return x.e ? { raised: x.e } : x.r[0].j;
  };
  const send = (iid, d) => call(iid, 'cl_device_dispatch_send', { p_dispatch: JSON.stringify(d) });
  const pull = (iid) => call(iid, 'cl_device_dispatch_pull', {});
  const grv = (iid, id, g) => call(iid, 'cl_device_grv_post', { p_dispatch_id: id, p_grv: JSON.stringify(g) });
  const cancel = (iid, id, reason) => call(iid, 'cl_device_dispatch_cancel', { p_dispatch_id: id, p_reason: reason, p_by: 'Rudo' });
  const resolve = (iid, issue, action, note, adj) => call(iid, 'cl_device_dispatch_resolve', { p_issue_id: issue, p_action: action, p_by: 'Rudo', p_note: note || null, p_adj_display: adj || null });

  const lines = [{ cat_uid: 'cat-sugar', code: 'SUG2', name: 'Sugar 2kg', unit: 'pcs', qty: 10, unit_cost: 1.5 },
                 { cat_uid: null, code: 'RIC5', name: 'Rice 5kg', unit: 'pcs', qty: 5, unit_cost: 4 }];
  const D1 = uuid();
  const d1 = { id: D1, to_branch_id: MUREHWA, dn_no: 12, dn_display: 'DN-T1-0012', created_iso: '2026-10-09T15:00:00+02:00', internal_ref: 'PO-7',
    sent_by: 'Rudo', from_legacy_branch_id: 'B-HARARE01', delivery: { cost: 12, currency: 'usd', carrier: 'Kombi', ref: 'K-55' }, lines };

  // ---- send ----
  let r = await send('AC01', d1);
  ok('the dispatching till sends a dispatch to another branch of its business', r.ok === true && r.status === 'sent', JSON.stringify(r));
  r = await send('AC01', d1);
  ok('sending it again (retry, double tap) answers "already", nothing new', r.ok && r.already === true && (await q(`select count(*)::int c from cl_dispatches`))[0].c === 1, JSON.stringify(r));
  r = await send('AC02', d1);
  ok('another till sending the same dispatch id is refused', /belongs to another till/.test(r.raised || ''), JSON.stringify(r));
  r = await send('AC01', Object.assign({}, d1, { id: uuid() }));
  ok('a second dispatch with the same DN number from the same till is refused (DN_NUMBER_USED)', r.error === 'DN_NUMBER_USED', JSON.stringify(r));
  r = await send('AC01', Object.assign({}, d1, { id: uuid(), dn_no: 13, to_branch_id: GWERU }));
  ok('a branch of another business is refused with the plain message', r.error === 'NOT_OWN_BUSINESS' && /only dispatch to branches of your own business/.test(r.message), JSON.stringify(r));
  r = await send('AC01', Object.assign({}, d1, { id: uuid(), dn_no: 13, to_branch_id: HARARE }));
  ok('its own branch is refused', r.error === 'OWN_BRANCH', JSON.stringify(r));
  r = await call('AC01', 'cl_device_dispatch_send', { p_dispatch: JSON.stringify(Object.assign({}, d1, { id: uuid(), dn_no: 13 })) }, 'Wrong Phrase');
  ok('a wrong phrase is refused', /phrase does not match/.test(r.raised || ''), JSON.stringify(r));
  r = await send('AC01', Object.assign({}, d1, { id: uuid(), dn_no: 13, delivery: { cost: 5 } }));
  ok('a delivery cost without its currency is refused', /needs its currency/.test(r.raised || ''), JSON.stringify(r));
  r = await send('AC01', Object.assign({}, d1, { id: uuid(), dn_no: 13, lines: [{ name: 'X', qty: 0 }] }));
  ok('a line with quantity 0 is refused', /quantity must be a whole number/.test(r.raised || ''), JSON.stringify(r));
  r = await send('AC01', Object.assign({}, d1, { id: uuid(), dn_no: 13, lines: [] }));
  ok('no lines is refused', /between 1 and 500 lines/.test(r.raised || ''), JSON.stringify(r));
  const row = (await q(`select delivery_cost::text, delivery_currency, carrier, delivery_ref, from_legacy_branch_id, internal_ref, status from cl_dispatches where id = $1`, [D1]))[0];
  ok('the delivery cost (currency upper-cased), carrier, reference, internal ref. and the DN-file branch key are kept',
    row.delivery_cost === '12.00' && row.delivery_currency === 'USD' && row.carrier === 'Kombi' && row.delivery_ref === 'K-55' && row.from_legacy_branch_id === 'B-HARARE01' && row.internal_ref === 'PO-7', JSON.stringify(row));

  // ---- pull ----
  const pm = await pull('MU01'), ph = await pull('AC02'), pb = await pull('BE01');
  const inc = (pm.incoming || []).find((x) => x.id === D1);
  ok('the receiving branch sees it in Incoming, with its lines, unit costs and delivery cost', inc && inc.lines.length === 2 && Number(inc.lines[0].unit_cost) === 1.5 &&
    inc.from_branch === 'Harare' && inc.to_branch === 'Murehwa' && inc.from_till === 'T1' && Number(inc.delivery_cost) === 12, JSON.stringify(pm).slice(0, 400));
  ok('every till of the sending branch sees it in Outgoing; Incoming is empty there', (ph.outgoing || []).some((x) => x.id === D1) && (ph.incoming || []).length === 0 && ph.is_main === true);
  ok('another business sees none of it', (pb.incoming || []).length === 0 && (pb.outgoing || []).length === 0);
  ok('the pull gives the till its highest DN number on the server (for a restored device)', (await pull('AC01')).max_dn_no === 12);

  // ---- GRV ----
  const G1 = uuid();
  const g1 = { grv_id: G1, grv_no: 7, grv_display: 'GRV-T1-0007', by: 'Tafadzwa', internal_ref: 'MU-1', note: 'one bag torn',
    lines: [{ line_no: 1, received: 8, damaged: 1, extra: 0 }, { line_no: 2, received: 5, damaged: 0, extra: 2, note: '2 more in the box' }] };
  r = await grv('AC02', D1, g1);
  ok('a till of the sending branch can\'t post the GRV', r.error === 'NOT_YOUR_BRANCH', JSON.stringify(r));
  r = await grv('BE01', D1, g1);
  ok('another business can\'t post it', r.error === 'NO_SUCH_DISPATCH', JSON.stringify(r));
  r = await grv('MU01', D1, Object.assign({}, g1, { lines: [g1.lines[0]] }));
  ok('a GRV that leaves out a line is refused', /Count every line/.test(r.raised || ''), JSON.stringify(r));
  r = await grv('MU01', D1, Object.assign({}, g1, { lines: [{ line_no: 1, received: 10, damaged: 1 }, g1.lines[1]] }));
  ok('received + damaged more than sent is refused', /add up to more than the 10 sent/.test(r.raised || ''), JSON.stringify(r));
  r = await grv('MU01', D1, Object.assign({}, g1, { lines: [{ line_no: 1, received: 8, damaged: 0, extra: 1 }, g1.lines[1]] }));
  ok('extra while the line is short is refused', /extra only when the full 10 sent arrived/.test(r.raised || ''), JSON.stringify(r));
  ok('after refused GRVs nothing changed', (await q(`select status from cl_dispatches where id = $1`, [D1]))[0].status === 'sent' && (await q(`select count(*)::int c from cl_dispatch_issues`))[0].c === 0);
  r = await grv('MU01', D1, g1);
  const dj = r.dispatch || {};
  const iss = dj.issues || [];
  ok('the receiver posts the GRV: received with differences, the counts kept, short = sent - received - damaged',
    r.ok && dj.status === 'received_diff' && dj.grv_display === 'GRV-T1-0007' && dj.grv_by === 'Tafadzwa' && dj.lines[0].short === 1 && dj.lines[0].damaged === 1 && dj.lines[1].extra === 2, JSON.stringify(r).slice(0, 500));
  ok('the differences become issues: short 1, damaged 1, extra 2', iss.length === 3 && iss.some((i) => i.kind === 'short' && i.qty === 1) && iss.some((i) => i.kind === 'damaged' && i.qty === 1) && iss.some((i) => i.kind === 'extra' && i.qty === 2), JSON.stringify(iss));
  const ch = (await q(`select amount::text, currency, owed_by_branch_id, owed_to_branch_id from cl_interbranch_charges where dispatch_id = $1`, [D1]))[0];
  ok('the delivery cost is recorded once as an inter-branch charge: Murehwa owes Harare USD 12.00', ch && ch.amount === '12.00' && ch.currency === 'USD' && ch.owed_by_branch_id === MUREHWA && ch.owed_to_branch_id === HARARE, JSON.stringify(ch));
  r = await grv('MU01', D1, g1);
  ok('posting the same GRV again answers "already", nothing new', r.ok && r.already === true && (await q(`select count(*)::int c from cl_dispatch_issues`))[0].c === 3 && (await q(`select count(*)::int c from cl_interbranch_charges`))[0].c === 1);
  r = await grv('MU01', D1, Object.assign({}, g1, { grv_id: uuid(), grv_no: 8 }));
  ok('a second GRV for the same dispatch (another till, or a new number) is refused: the first wins', r.error === 'ALREADY_RECEIVED' && /already received as GRV-T1-0007 on till T1 by Tafadzwa/.test(r.message), JSON.stringify(r));

  // ---- cancel ----
  r = await cancel('AC01', D1, 'wrong branch');
  ok('cancel after the GRV is refused with the plain message', r.error === 'ALREADY_RECEIVED' && /return dispatch/.test(r.message), JSON.stringify(r));
  const D2 = uuid();
  await send('AC01', { id: D2, to_branch_id: MUREHWA, dn_no: 13, dn_display: 'DN-T1-0013', sent_by: 'Rudo', from_legacy_branch_id: 'B-HARARE01', lines: [{ code: 'SUG2', name: 'Sugar 2kg', qty: 3 }] });
  r = await cancel('AC02', D2, 'wrong branch');
  ok('only the dispatching till may cancel', r.error === 'NOT_SENDER' && /\(T1\)/.test(r.message), JSON.stringify(r));
  r = await cancel('AC01', D2, 'x');
  ok('a cancel needs a reason', /Give a reason/.test(r.raised || ''), JSON.stringify(r));
  r = await cancel('AC01', D2, 'Sent to the wrong branch');
  ok('the dispatching till cancels before the GRV', r.ok && r.dispatch.status === 'cancelled' && r.dispatch.cancel_reason === 'Sent to the wrong branch', JSON.stringify(r).slice(0, 300));
  r = await cancel('AC01', D2, 'Sent to the wrong branch');
  ok('cancelling again answers "already"', r.ok && r.already === true);
  r = await grv('MU01', D2, { grv_id: uuid(), grv_no: 9, lines: [{ line_no: 1, received: 3 }] });
  ok('a GRV on a cancelled dispatch is refused: nothing received', r.error === 'CANCELLED' && /was cancelled by Harare/.test(r.message), JSON.stringify(r));

  // ---- differences ----
  const short = iss.find((i) => i.kind === 'short'), damaged = iss.find((i) => i.kind === 'damaged'), extra = iss.find((i) => i.kind === 'extra');
  r = await resolve('AC02', short.id, 'write_off', 'lost in transit', 'ADJ-T2-0001');
  ok('only the dispatching till resolves a difference', r.error === 'NOT_SENDER', JSON.stringify(r));
  r = await resolve('AC01', short.id, 'write_off', 'lost in transit', null);
  ok('a write-off needs its ADJ number', /needs its ADJ number/.test(r.raised || ''), JSON.stringify(r));
  r = await resolve('AC01', short.id, 'confirm', null, null);
  ok('"confirm" doesn\'t fit a shortage', /doesn't fit a short difference/.test(r.raised || ''), JSON.stringify(r));
  r = await resolve('AC01', short.id, 'write_off', 'lost in transit', 'ADJ-T1-0003');
  ok('the shortage is written off with its ADJ number', r.ok && r.dispatch.issues.find((i) => i.id === short.id).status === 'written_off' && r.dispatch.issues.find((i) => i.id === short.id).adj_display === 'ADJ-T1-0003', JSON.stringify(r).slice(0, 300));
  r = await resolve('AC01', short.id, 'write_off', 'lost in transit', 'ADJ-T1-0003');
  ok('writing it off again answers "already"', r.ok && r.already === true);
  r = await resolve('AC01', extra.id, 'dispute', 'we never had 7', null);
  ok('an extra can be disputed', r.ok && r.dispatch.issues.find((i) => i.id === extra.id).status === 'disputed');
  r = await resolve('AC01', extra.id, 'confirm', null, null);
  ok('a disputed extra can then be confirmed', r.ok && r.dispatch.issues.find((i) => i.id === extra.id).status === 'confirmed');
  r = await resolve('AC01', extra.id, 'dispute', 'again', null);
  ok('a confirmed extra can\'t be disputed again', r.error === 'ALREADY_RESOLVED', JSON.stringify(r));
  const D3 = uuid();
  r = await send('AC02', { id: D3, to_branch_id: MUREHWA, dn_no: 1, dn_display: 'DN-T2-0001', replaces_issue_id: damaged.id, lines: [{ code: 'SUG2', name: 'Sugar 2kg', qty: 1 }] });
  ok('only the dispatching till can re-dispatch a difference', r.error === 'NOT_SENDER', JSON.stringify(r));
  r = await send('AC01', { id: D3, to_branch_id: MUREHWA, dn_no: 14, dn_display: 'DN-T1-0014', sent_by: 'Rudo', replaces_issue_id: damaged.id, lines: [{ code: 'SUG2', name: 'Sugar 2kg', qty: 1 }] });
  let di = (await q(`select status, redispatch_id from cl_dispatch_issues where id = $1`, [damaged.id]))[0];
  ok('the damaged unit is re-dispatched: the issue is closed and points at the new dispatch', r.ok && di.status === 'redispatched' && di.redispatch_id === D3, JSON.stringify(di));
  r = await send('AC01', { id: uuid(), to_branch_id: MUREHWA, dn_no: 15, dn_display: 'DN-T1-0015', replaces_issue_id: damaged.id, lines: [{ name: 'Sugar 2kg', qty: 1 }] });
  ok('it can\'t be re-dispatched twice', r.error === 'ALREADY_RESOLVED', JSON.stringify(r));
  await cancel('AC01', D3, 'Driver did not come');
  di = (await q(`select status, redispatch_id from cl_dispatch_issues where id = $1`, [damaged.id]))[0];
  ok('cancelling the re-dispatch opens the difference again', di.status === 'open' && di.redispatch_id === null, JSON.stringify(di));
  const po = await pull('AC02');
  ok('a dispatch with an open difference stays in Outgoing', (po.outgoing || []).some((x) => x.id === D1 && x.issues.some((i) => i.status === 'open')));

  // GRV number per till
  const D4 = uuid();
  await send('AC01', { id: D4, to_branch_id: MUREHWA, dn_no: 16, dn_display: 'DN-T1-0016', lines: [{ name: 'Salt', qty: 1 }] });
  r = await grv('MU01', D4, { grv_id: uuid(), grv_no: 7, lines: [{ line_no: 1, received: 1 }] });
  ok('a GRV number already used by this till is refused (GRV_NUMBER_USED), nothing changed', r.error === 'GRV_NUMBER_USED' && (await q(`select status from cl_dispatches where id = $1`, [D4]))[0].status === 'sent', JSON.stringify(r));
  r = await grv('MU01', D4, { grv_id: uuid(), grv_no: 10, lines: [{ line_no: 1, received: 1 }] });
  ok('received in full: status "received", no issues, no charge without a delivery cost', r.ok && r.dispatch.status === 'received' && r.dispatch.issues.length === 0 && !r.dispatch.charge, JSON.stringify(r).slice(0, 300));

  // ---- inactive till ----
  await q(`update cl_terminals set active = false where install_id = 'AC02'`);
  r = await send('AC02', { id: uuid(), to_branch_id: MUREHWA, dn_no: 2, dn_display: 'DN-T2-0002', lines: [{ name: 'Salt', qty: 1 }] });
  ok('a switched-off till can\'t send', r.error === 'TERMINAL_INACTIVE', JSON.stringify(r));
  await q(`update cl_terminals set active = true where install_id = 'AC02'`);

  // ---- file lookup ----
  r = await call('MU01', 'cl_device_dispatch_lookup', { p_dispatch_id: D1, p_from_legacy_branch_id: null, p_dn_no: null });
  ok('a DN file for a dispatch the server holds is found by its uid', r.found && r.status === 'received_diff' && r.grv_display === 'GRV-T1-0007');
  r = await call('MU01', 'cl_device_dispatch_lookup', { p_dispatch_id: null, p_from_legacy_branch_id: 'B-HARARE01', p_dn_no: 13 });
  ok('an older file is found by the sending branch key + DN number', r.found && r.status === 'cancelled');
  r = await call('BE01', 'cl_device_dispatch_lookup', { p_dispatch_id: D1, p_from_legacy_branch_id: 'B-HARARE01', p_dn_no: 12 });
  ok('another business finds nothing', r.found === false);

  // ---- Console (read-only) ----
  let x = await as(tok('NONE'), `select public.cl_dispatches_list(null, null, null) j`);
  ok('staff without the Dispatches module can\'t list', /Not authorized/.test(x.e || ''), x.e);
  x = await as(null, `select public.cl_dispatches_list(null, null, null) j`);
  ok('anon can\'t list', /permission denied/.test(x.e || ''), x.e);
  x = await as(tok('DSP'), `select public.cl_dispatches_list(null, null, null) j`);
  const lst = x.r && x.r[0].j;
  ok('staff with the Dispatches module list every dispatch with lines, units and open differences', lst && lst.length === 4 && lst.find((d) => d.id === D1).open_issues === 1 && lst.find((d) => d.id === D1).units === 15 && lst.find((d) => d.id === D1).business === 'Acme', JSON.stringify(x).slice(0, 300));
  x = await as(tok('SYS'), `select public.cl_dispatches_list(null, 'open_issues', null) j`);
  ok('filter: with open differences', x.r && x.r[0].j.length === 1 && x.r[0].j[0].id === D1);
  x = await as(tok('DSP'), `select public.cl_dispatch_detail($1) j`, [D1]);
  const det = x.r && x.r[0].j;
  ok('the detail has lines, issues, the charge and the log', det && det.lines.length === 2 && det.issues.length === 3 && det.charge && det.log.map((l) => l.action).join(',') === 'sent,received,issue_written_off,issue_disputed,issue_confirmed,issue_redispatched,issue_reopened', JSON.stringify(det && det.log.map((l) => l.action)));

  // ---- grants ----
  for (const t of ['cl_dispatches', 'cl_dispatch_lines', 'cl_dispatch_issues', 'cl_interbranch_charges', 'cl_dispatch_log']) {
    const a = await as(null, `select count(*) from ${t}`), b = await as(tok('SYS'), `select count(*) from ${t}`);
    ok(t + ': no API access (anon or staff)', /permission denied/.test(a.e || '') && /permission denied/.test(b.e || ''), (a.e || 'anon read') + ' / ' + (b.e || 'staff read'));
  }
  x = await as(null, `select public.cl_dispatch_json($1) j`, [D1]);
  ok('the helpers can\'t be called from the API', /permission denied/.test(x.e || ''), x.e);
  x = await as(tok('SYS'), `select public.cl_device_dispatch_pull('AC01', 'Acme Phrase', 'nope') j`);
  ok('a device call with the wrong device key is refused', /already registered to another device/.test(x.e || ''), x.e);

  // ---- delete guard ----
  x = await as(null, 'select 1'); // reset
  e = null; try { await q(`delete from cl_businesses where name = 'Acme'`); } catch (y) { e = y.message; }
  ok('the business delete guard counts dispatches', /4 dispatches/.test(e || ''), e);

  // ---- rollback ----
  e = null; try { await pg.exec(RB); } catch (y) { e = y.message; } await pg.exec('rollback').catch(() => {});
  ok('the rollback refuses while dispatches exist, changing nothing', /rollback aborted: dispatches exist/.test(e || '') && (await q(`select count(*)::int c from cl_dispatches`))[0].c === 4, e);
  await q(`delete from cl_dispatch_log`); await q(`delete from cl_interbranch_charges`);
  await q(`update cl_dispatches set replaces_issue_id = null`); await q(`update cl_dispatch_issues set redispatch_id = null`);
  await q(`delete from cl_dispatch_issues`); await q(`delete from cl_dispatches`);
  await pg.exec(RB);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('with none, the rollback restores the exact pre-migration catalogue (delete guard, modules, grants)', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  e = null; try { await pg.exec(MIG); } catch (y) { e = y.message; }
  ok('and the migration applies again after a rollback', !e, e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
