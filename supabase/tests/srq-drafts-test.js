// node supabase/tests/srq-drafts-test.js
//
// Tests supabase/migrations/20261117120000_srq_drafts.sql (and its rollback)
// in PGlite built in the live shape, never the live database:
//   older requests (before v37.1): one approved with its DN sent but never
//     linked (v37's Dispatch screen lost the link) is linked; one with no DN
//     gets its draft, once (decision 63, "at post-check");
//   drafts: approve all / part -> a draft on seiGEN, whoever approved it, with
//     who approved; the first sender takes it (the quantities, never above the
//     approved ones, every change logged); a second sender is told it has been
//     sent; the DN's link; a cancelled DN opens it again; a failed DN releases
//     it; closing needs a reason and Review stock requests or an Owner/Admin
//     (a Cashier is refused), the request becomes "Approved, not dispatched",
//     a closed or sent draft can't be sent or closed again;
//   the reminder timers (decision 64): defaults 8 / 24 in the pull; an Owner or
//     Admin (or a till in single operator mode) changes them, a Manager or a
//     Cashier is refused; out-of-range values are refused; "Don't repeat";
//     every change is logged old -> new;
//   the pull says whether seiGEN takes branch figures (Fix 3);
//   grants; a second run is refused; the rollback is refused while a request
//   is "not dispatched", then restores the catalogue exactly.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261117120000_srq_drafts.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const J = (x) => JSON.stringify(x);
const hex = (n) => crypto.randomBytes(n || 16).toString('hex');
const staffCheck = () => ({ pin_salt: hex(16), pin_check: hex(32), pin_rounds: 150000 });
const uuid = () => crypto.randomUUID();

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE]) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || hex());
  const anon = async (fn, args) => {
    const names = Object.keys(args);
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
    await pg.exec('set role anon');
    try { return { j: (await q(`select to_json(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) j`, vals))[0].j }; }
    catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  };
  const auth = (iid, tok) => ({ p_install_id: iid, p_secret_phrase: 'Mandie Phrase' + (tok ? '|' + tok : ''), p_device_key: key(iid) });
  const call = async (iid, fn, args, tok) => { const r = await anon(fn, { ...auth(iid, tok), ...(args || {}) }); return r.e ? { raised: r.e } : r.j; };
  const seed = () => ({ salt: hex(16), check: hex(32), rounds: 150000 });
  const code = async (iid, o) => { const s = seed(); return (await anon('cl_branch_issue_join_code', { ...auth(iid), ...o, p_admin_salt: s.salt, p_admin_check: s.check, p_admin_rounds: s.rounds })).j; };
  const join = async (iid, c) => (await anon('cl_terminal_join', { ...auth(iid), p_join_code: c, p_app_build: 37 })).j;
  const push = async (iid, events, tok) => { const r = await call(iid, 'cl_device_stock_ctl_push', { p_events: events }, tok); return r.results ? r.results : r; };
  const ev = (type, o) => Object.assign({ uid: type + ':' + uuid(), type, ts: new Date().toISOString(), by: 'Boss' }, o);
  const pull = (iid, tok) => call(iid, 'cl_device_stock_ctl_pull', { p_cursor: 0, p_itred_after: 0 }, tok);
  let dnNo = 0;
  const sendDn = (iid, to, ref, lines) => { const id = uuid(); dnNo++;
    return call(iid, 'cl_device_dispatch_send', { p_dispatch: { id, to_branch_id: to, dn_no: dnNo, dn_display: 'DN-T1-' + String(dnNo).padStart(4, '0'), created_iso: new Date().toISOString(),
      internal_ref: ref, sent_by: 'Boss', delivery: { cost: 0 }, lines: lines || [{ cat_uid: 'cat-bottle', code: 'BOT1', name: 'Baby bottle', qty: 2 }] } }).then((r) => Object.assign({ id }, r)); };
  const request = async (lines, approve) => {
    const id = uuid();
    const r1 = await push('MU01', [ev('request_create', { id, req_no: 'SRQ-T1-' + String(++request.n).padStart(4, '0'), reason: 'Weekend', by: 'Chipo',
      lines: lines.map(([name, qty]) => ({ product_key: 'cat-' + name.toLowerCase(), code: name, name, qty })) })]);
    if (r1[0].status !== 'stored') throw new Error(J(r1));
    if (approve) { const r2 = await push('HA01', [ev('request_decide', Object.assign({ id }, approve))]); if (r2[0].status !== 'stored') throw new Error(J(r2)); }
    return id;
  };
  request.n = 0;

  // ---- the live shape: Harare (main) T1 + T2, Murehwa T1; Boss (Admin), Tendai (Manager), Rudo (Cashier) ----
  let r = await anon('cl_branch_register', { ...auth('HA01'), p_business_name: 'Mandie Babyware', p_branch_name: 'Harare' });
  const HARARE = r.j.branch_id, BIZ = r.j.business_id;
  await join('HA02', (await code('HA01', { p_branch_id: HARARE })).code);
  const MUREHWA = (await join('MU01', (await code('HA01', { p_new_branch_name: 'Murehwa' })).code)).branch_id;
  const roles = Object.fromEntries((await call('HA01', 'cl_device_staff_pull')).roles.map((x) => [x.builtin || x.name, x.id]));
  const ID = {};
  r = await call('HA01', 'cl_device_staff_save', { p_staff_token: null, p_staff: { name: 'Boss', role_id: roles.admin, home_branch_id: HARARE, pin: '1234', ...staffCheck() } });
  ID.Boss = r.staff.id;
  const signin = async (iid, name, pin) => (await call(iid, 'cl_device_staff_signin', { p_staff_id: ID[name], p_pin: pin })).token;
  const bossT = await signin('HA01', 'Boss', '1234');
  for (const [n, role, pin] of [['Tendai', 'manager', '2222'], ['Rudo', 'cashier', '3333']]) {
    r = await call('HA01', 'cl_device_staff_save', { p_staff_token: bossT, p_staff: { name: n, role_id: roles[role], home_branch_id: HARARE, pin, ...staffCheck() } });
    ID[n] = r.staff.id;
  }
  const T = { HA01: (await q(`select t.id from cl_terminals t join cl_vendors v on v.id = t.vendor_id where v.install_id = 'HA01'`))[0].id };

  // ---- before v37.1: three approved requests ----
  const OLD_LINKED = await request([['Bottle', 4]], { action: 'approve', note: null });
  const oldReq = (await q('select req_no from cl_stock_requests where id=$1', [OLD_LINKED]))[0].req_no;
  const oldDn = await sendDn('HA01', MUREHWA, oldReq, [{ cat_uid: 'cat-bottle', code: 'Bottle', name: 'Bottle', qty: 4 }]);
  ok('(v37: a DN for an approved request, sent but never linked)', oldDn.ok && (await q('select dispatch_id from cl_stock_requests where id=$1', [OLD_LINKED]))[0].dispatch_id === null, J(oldDn));
  const OLD_WAITING = await request([['Oil', 3], ['Nappy', 2]], { action: 'part', lines: [{ line_no: 1, approved_qty: 2 }, { line_no: 2, approved_qty: 2 }] });
  const OLD_DISPATCHED = await request([['Rattle', 1]], { action: 'approve' });
  const d0 = await sendDn('HA01', MUREHWA, 'other-ref', [{ cat_uid: 'cat-rattle', code: 'Rattle', name: 'Rattle', qty: 1 }]);
  ok('(v37: a request linked as before)', (await push('HA01', [ev('request_link', { id: OLD_DISPATCHED, dispatch_id: d0.id })]))[0].status === 'stored');
  const before = fingerprint(await snapshot(q));

  // ---- apply ----
  const notices = [];
  pg.onNotice && pg.onNotice((n) => notices.push(n.message));
  let e = null; try { await pg.exec(MIG); } catch (y) { e = y.message; }
  ok('the migration applies on the live shape (with v37 requests on it)', !e, e);
  e = null; try { await pg.exec(MIG); } catch (y) { e = y.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run stops in the preflight, changing nothing', /already there: table cl_srq_drafts/.test(e || ''), e);
  const dr = async (id) => (await q('select * from cl_srq_drafts where request_id=$1', [id]))[0];
  const rq = async (id) => (await q('select * from cl_stock_requests where id=$1', [id]))[0];
  ok('older approved request with a DN sent but not linked: linked to that DN (dispatched), its draft sent', (await rq(OLD_LINKED)).dispatch_id === oldDn.id && (await rq(OLD_LINKED)).status === 'dispatched'
    && (await dr(OLD_LINKED)).status === 'sent', J([await rq(OLD_LINKED), await dr(OLD_LINKED)]));
  ok('older approved request with no DN: its draft, open, from the approval time', (await dr(OLD_WAITING)).status === 'open'
    && +(await dr(OLD_WAITING)).approved_at === +(await rq(OLD_WAITING)).decided_at);
  ok('a request already linked (dispatched) gets no draft', !(await dr(OLD_DISPATCHED)));
  ok('post-check counts: 1 draft made, 1 linked', (await q(`select count(*)::int n from cl_srq_drafts where status='open'`))[0].n === 1
    && (await q(`select count(*)::int n from cl_stock_ctl_log where detail->>'linked_at' = 'v37.1'`))[0].n === 1);

  // ---- drafts: made by seiGEN, whoever approved ----
  const R1 = await request([['Bottle', 10], ['Oil', 4]], null);
  ok('a pending request has no draft', !(await dr(R1)));
  r = await push('HA02', [ev('request_decide', { id: R1, action: 'approve', by: 'Tendai' })], await signin('HA02', 'Tendai', '2222'));
  ok('approved on Harare T2 by Tendai (Manager): stored', r[0].status === 'stored', J(r));
  let d = await dr(R1);
  ok('the draft is on seiGEN, open, with who approved and where', d && d.status === 'open' && d.approved_by === 'Tendai' && d.approved_staff_id === ID.Tendai
    && d.approved_terminal_id === (await q(`select t.id from cl_terminals t join cl_vendors v on v.id=t.vendor_id where v.install_id='HA02'`))[0].id, J(d));
  let p = await pull('MU01');
  let j = p.requests.find((x) => x.id === R1);
  ok('every device pulls it: the draft, the approved quantities, who decided', j.draft.status === 'open' && j.decided_staff_id === ID.Tendai && j.lines.every((l) => l.approved_qty === l.qty && l.sent_qty === null), J(j));
  ok('a draft moves no stock: nothing on any DN', (await q('select count(*)::int n from cl_dispatches where internal_ref=$1', [j.req_no]))[0].n === 0);
  const R2 = await request([['Bottle', 5], ['Nappy', 3]], { action: 'part', lines: [{ line_no: 1, approved_qty: 5 }, { line_no: 2, approved_qty: 1 }] });
  ok('part-approved: a draft too, for the approved quantities', (await dr(R2)).status === 'open'
    && J((await q('select approved_qty from cl_stock_request_lines where request_id=$1 order by line_no', [R2])).map((x) => x.approved_qty)) === '[5,1]');

  // ---- the first sender takes it ----
  const claim = (iid, id, lines, tok, sid) => call(iid, 'cl_device_srq_draft_claim', { p_request_id: id, p_dispatch_id: sid || uuid(), p_by: 'Boss', p_lines: lines }, tok);
  r = await claim('HA01', R1, [{ line_no: 1, sent_qty: 11 }, { line_no: 2, sent_qty: 4 }]);
  ok('more than approved is refused (OVER_APPROVED), nothing taken', r.error === 'OVER_APPROVED' && /Bottle: send 0 to 10/.test(r.message) && (await dr(R1)).status === 'open', J(r));
  r = await claim('HA01', R1, [{ line_no: 1, sent_qty: 0 }, { line_no: 2, sent_qty: 0 }]);
  ok('nothing at all is refused: close it with a reason instead', r.error === 'BAD_EVENT' && /close the draft/.test(r.message), J(r));
  r = await claim('MU01', R1, [{ line_no: 1, sent_qty: 10 }]);
  ok('a branch till can\'t send main\'s draft (NOT_MAIN)', r.error === 'NOT_MAIN', J(r));
  r = await claim('HA01', R1, [{ line_no: 1, sent_qty: 8 }, { line_no: 2, sent_qty: 4 }], await signin('HA01', 'Rudo', '3333'));
  ok('a Cashier (no Dispatch right) is refused by seiGEN', /STAFF_NO_RIGHT/.test(r.raised || ''), J(r));
  const S1 = uuid();
  r = await claim('HA01', R1, [{ line_no: 1, sent_qty: 8 }], null, S1);
  ok('Harare T1 lowers the bottles to 8 and removes the oil: taken', r.ok && J(r.changes.map((c) => [c.line_no, c.name, c.approved, c.sent])) === J([[1, 'Bottle', 10, 8], [2, 'Oil', 4, 0]]), J(r));
  d = await dr(R1);
  ok('the draft is sent, by whom, from which till; the quantities sent kept', d.status === 'sent' && d.sent_by === 'Boss' && d.sent_terminal_id === T.HA01
    && J((await q('select sent_qty from cl_stock_request_lines where request_id=$1 order by line_no', [R1])).map((x) => x.sent_qty)) === '[8,0]', J(d));
  ok('each change is in the request\'s log (approved vs sent, who)', (await q(`select by_name, detail from cl_stock_ctl_log where doc_id=$1 and action='draft_changed'`, [R1]))[0].detail.lines.length === 2);
  r = await claim('HA01', R1, [{ line_no: 1, sent_qty: 8 }], null, S1);
  ok('the same sending again (a retry): ok', r.ok && r.already, J(r));
  r = await claim('HA02', R1, [{ line_no: 1, sent_qty: 10 }, { line_no: 2, sent_qty: 4 }]);
  ok('a second sender (Harare T2) is told it has been sent (DRAFT_SENT), by whom', r.error === 'DRAFT_SENT' && /already been sent by Boss/.test(r.message), J(r));
  // the DN, then its link (as the till sends them)
  const dn1 = await sendDn('HA01', MUREHWA, j.req_no, [{ cat_uid: 'cat-bottle', code: 'Bottle', name: 'Bottle', qty: 8 }]);
  r = await push('HA01', [ev('request_link', { id: R1, dispatch_id: dn1.id, lines: [{ line_no: 1, sent_qty: 8 }, { line_no: 2, sent_qty: 0 }] })]);
  ok('the DN\'s link: stored; the request is Dispatched; the draft carries the DN', r[0].status === 'stored' && (await rq(R1)).status === 'dispatched' && (await dr(R1)).dispatch_id === dn1.id, J(r));
  const dn2 = await sendDn('HA02', MUREHWA, j.req_no);
  r = await push('HA02', [ev('request_link', { id: R1, dispatch_id: dn2.id })]);
  ok('a second DN can\'t be linked to a sent draft (refused)', r[0].status === 'refused' && ['DRAFT_SENT', 'WRONG_STATUS'].includes(r[0].code), J(r));
  r = await push('HA01', [ev('request_link', { id: R2, dispatch_id: dn2.id, lines: [{ line_no: 1, sent_qty: 6 }] })]);
  ok('a link above the approved quantity is refused (OVER_APPROVED)', r[0].status === 'refused' && r[0].code === 'OVER_APPROVED', J(r));
  // a cancelled DN: the request back to approved (v37), the draft open again
  r = await call('HA01', 'cl_device_dispatch_cancel', { p_dispatch_id: dn1.id, p_reason: 'wrong truck', p_by: 'Boss' });
  d = await dr(R1);
  ok('the DN cancelled: request Approved again, the draft open, nothing sent', (await rq(R1)).status === 'approved' && d.status === 'open' && d.dispatch_id === null
    && (await q('select count(*)::int n from cl_stock_request_lines where request_id=$1 and sent_qty is not null', [R1]))[0].n === 0, J([r, d]));
  // a DN that couldn't be made: the claim is released
  const S2 = uuid();
  ok('(claimed again by T1)', (await claim('HA01', R1, [{ line_no: 1, sent_qty: 10 }, { line_no: 2, sent_qty: 4 }], null, S2)).ok);
  ok('released by another till: no', (await call('HA02', 'cl_device_srq_draft_release', { p_request_id: R1, p_dispatch_id: S2 })).released === false);
  r = await call('HA01', 'cl_device_srq_draft_release', { p_request_id: R1, p_dispatch_id: S2 });
  ok('released by the claiming till, its DN never made: open again', r.released === true && (await dr(R1)).status === 'open', J(r));

  // ---- closing ----
  const close = (iid, id, note, tok) => push(iid, [ev('draft_close', { id, note })], tok).then((x) => x[0]);
  r = await close('HA01', R1, '', null);
  ok('closing without a reason is refused', r.status === 'refused' && r.code === 'BAD_EVENT', J(r));
  r = await close('HA01', R1, 'Branch found stock', await signin('HA01', 'Rudo', '3333'));
  ok('a Cashier (no Review stock requests, not Owner/Admin) is refused by seiGEN', r.status === 'refused' && r.code === 'STAFF_NO_RIGHT', J(r));
  r = await close('HA01', R1, 'Branch found stock', bossT);
  ok('an Admin closes it with a reason: stored', r.status === 'stored', J(r));
  d = await dr(R1);
  ok('the draft is closed (who, why, when); the request is "not_dispatched"; never deleted', d.status === 'closed' && d.closed_by === 'Boss' && d.closed_staff_id === ID.Boss
    && d.close_reason === 'Branch found stock' && (await rq(R1)).status === 'not_dispatched', J(d));
  j = (await pull('MU01')).requests.find((x) => x.id === R1);
  ok('the requesting branch sees it, with the reason', j && j.status === 'not_dispatched' && j.draft.close_reason === 'Branch found stock' && j.log.some((g) => g.action === 'not_dispatched'), J(j));
  ok('closing again: duplicate', (await close('HA01', R1, 'again', bossT)).status === 'duplicate');
  r = await claim('HA01', R1, [{ line_no: 1, sent_qty: 1 }]);
  ok('a closed draft can\'t be sent (DRAFT_CLOSED, with the reason)', r.error === 'DRAFT_CLOSED' && /Branch found stock/.test(r.message), J(r));
  ok('(R2 sent by T1)', (await claim('HA01', R2, [{ line_no: 1, sent_qty: 5 }, { line_no: 2, sent_qty: 1 }])).ok);
  r = await close('HA01', R2, 'too late', bossT);
  ok('a sent draft can\'t be closed (DRAFT_SENT)', r.status === 'refused' && r.code === 'DRAFT_SENT', J(r));
  r = await close('HA02', OLD_WAITING, 'not needed', await signin('HA02', 'Tendai', '2222'));
  ok('a Manager (Review stock requests) may close one', r.status === 'stored', J(r));

  // ---- the reminder timers (decision 64) ----
  p = await pull('HA01');
  ok('the pull carries the timers: the defaults 8 h, repeat 24 h', p.srq_settings.delay_hours === 8 && p.srq_settings.repeat_hours === 24, J(p.srq_settings));
  const set = (iid, d1, r1, tok) => call(iid, 'cl_device_srq_settings_set', { p_delay_hours: d1, p_repeat_hours: r1, p_by: 'Boss' }, tok);
  r = await set('HA01', 2, 6, await signin('HA01', 'Tendai', '2222'));
  ok('a Manager is refused by seiGEN', r.error === 'NOT_OWNER_ADMIN', J(r));
  r = await set('HA01', 2, 6, await signin('HA01', 'Rudo', '3333'));
  ok('a Cashier is refused by seiGEN', r.error === 'NOT_OWNER_ADMIN' || /STAFF_NO_RIGHT/.test(r.raised || ''), J(r));
  for (const [a, b] of [[0, 24], [73, 24], [2.5, 24], [8, 3], [8, 73]]) {
    r = await set('HA01', a, b, bossT);
    ok('out of range refused: ' + a + ' / ' + b, r.error === 'BAD_VALUE' || /invalid input/.test(r.raised || ''), J(r));
  }
  r = await set('HA01', 2, 6, bossT);
  ok('an Admin sets 2 h, repeat 6 h', r.ok && r.settings.delay_hours === 2 && r.settings.repeat_hours === 6, J(r));
  ok('every device gets them (Murehwa\'s pull)', (await pull('MU01')).srq_settings.delay_hours === 2);
  r = await set('HA01', 4, null);
  ok('a till in single operator mode (nobody signed in) may: "Don\'t repeat"', r.ok && r.settings.repeat_hours === null, J(r));
  const log = await q('select by_name, staff_id, old_value, new_value from cl_srq_settings_log where business_id=$1 order by id', [BIZ]);
  ok('every change logged: who, old -> new', log.length === 2 && log[0].old_value.delay_hours === 8 && log[0].old_value.repeat_hours === 24 && log[0].new_value.delay_hours === 2 && log[0].new_value.repeat_hours === 6
    && log[0].staff_id === ID.Boss && log[1].new_value.delay_hours === 4 && log[1].new_value.repeat_hours === null, J(log));
  ok('the same values again: unchanged, not logged', (await set('HA01', 4, null)).unchanged === true && (await q('select count(*)::int n from cl_srq_settings_log'))[0].n === 2);

  // ---- branch figures (Fix 3) ----
  ok('the pull says seiGEN takes branch figures (3 active tills)', p.bs_enabled === true);
  r = await anon('cl_branch_register', { ...auth('SOLO'), p_business_name: 'Solo Shop', p_branch_name: 'Main' });
  ok('a single-till business: bs_enabled false', (await call('SOLO', 'cl_device_stock_ctl_pull', { p_cursor: 0, p_itred_after: 0 })).bs_enabled === false);

  // ---- grants ----
  for (const t of ['cl_srq_drafts', 'cl_srq_settings', 'cl_srq_settings_log']) {
    await pg.exec('set role anon'); let x = null; try { await pg.query(`select count(*) from ${t}`); } catch (y) { x = y.message; } await pg.exec('reset role');
    ok(t + ': no API access', /permission denied/.test(x || ''), x);
  }
  ok('internal helpers aren\'t callable through the API', /permission denied/.test((await anon('cl_srq_settings_of', { p_business: BIZ })).e || '')
    && /permission denied/.test((await anon('cl_stock_ctl_event_v37', { me: null, e: {} })).e || ''));

  // ---- rollback ----
  e = null; try { await pg.exec(RB); } catch (y) { e = y.message; } await pg.exec('rollback').catch(() => {});
  ok('the rollback is refused while a request is "not dispatched"', /rollback refused: 2 request/.test(e || ''), e);
  await q(`update cl_stock_requests set status = 'approved' where status = 'not_dispatched'`);
  e = null; try { await pg.exec(RB); } catch (y) { e = y.message; }
  ok('then it runs', !e, e);
  const dd = diff(before, fingerprint(await snapshot(q)));
  ok('the rollback restores the exact pre-migration catalogue', !dd.onlyA.length && !dd.onlyB.length && !dd.changed.length, J(dd).slice(0, 600));
  e = null; try { await pg.exec(MIG); } catch (y) { e = y.message; }
  ok('the migration applies again after a rollback', !e, e);

  console.log((fail ? 'FAILED ' : 'PASSED ') + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
