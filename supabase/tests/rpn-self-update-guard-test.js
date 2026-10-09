// node supabase/tests/rpn-self-update-guard-test.js
// Tests supabase/migrations/20261009150000_rpn_self_update_guard.sql and its
// rollback in an in-memory PGlite shaped like the live Console (never the
// live database).
'use strict';
const fs = require('fs');
const { freshConsole, counter, RPN_A, RPN_B, ROOT } = require('./rpn-console-stub');

const MIGRATION = fs.readFileSync(`${ROOT}/migrations/20261009150000_rpn_self_update_guard.sql`, 'utf8');
const ROLLBACK = fs.readFileSync(`${ROOT}/rollbacks/20261009150000_rpn_self_update_guard.rollback.sql`, 'utf8');

(async () => {
  const t = counter();
  const { pg, q, as } = await freshConsole();

  // Before: the hole is there.
  let r = await as('rpnA', () => q(`update public.cl_rpn set active = false, verification_code = 'MINE' where id = '${RPN_A}' returning id`));
  t.ok('before the fix: an RPN CAN change their own active / verification_code (the hole)', !r.e && r.r.length === 1, r.e && r.e.message);

  await pg.exec(MIGRATION);
  t.ok('the migration applies', true);
  r = await (async () => { try { await pg.exec(MIGRATION); return null; } catch (e) { return e; } })();
  t.ok('applying it twice stops at the preflight', r && /already exists/.test(r.message), r && r.message);

  for (const [col, val] of [['active', 'false'], ['verification_code', "'MINE'"], ['verification_used', 'true'], ['passcode_hash', "'x2'"], ['full_name', "'Someone Else'"], ['created_by', `'${RPN_B}'::uuid`], ['created_at', "now() - interval '1 day'"]]) {
    r = await as('rpnA', () => q(`update public.cl_rpn set ${col} = ${val} where id = '${RPN_A}' returning id`));
    t.ok(`RPN cannot change their own ${col}`, r.e && /only change their own phone and city/.test(r.e.message), r.e ? r.e.message : 'updated');
  }
  r = await as('rpnA', () => q(`update public.cl_rpn set phone = '+263771000111', city = 'Bulawayo' where id = '${RPN_A}' returning phone, city`));
  t.ok('RPN can still change their own phone and city', !r.e && r.r[0].city === 'Bulawayo', r.e && r.e.message);
  r = await as('rpnA', () => q(`update public.cl_rpn set city = 'Gweru' where id = '${RPN_B}' returning id`));
  t.ok("RPN still cannot touch another RPN's row (RLS: no rows)", !r.e && r.r.length === 0, r.e && r.e.message);
  r = await as('rpnDesk', () => q(`update public.cl_rpn set active = false, verification_code = 'NEW' where id = '${RPN_A}' returning active`));
  t.ok('staff with RPN Directory can still deactivate an RPN and change codes', !r.e && r.r[0].active === false, r.e && r.e.message);
  r = await as('anon', () => q(`select public.cl_rpn_activate('Rudo Banda', 'V-B', '1234') as ok`));
  t.ok('cl_rpn_activate (SECURITY DEFINER, no token) still works', !r.e && r.r[0].ok === true, r.e && r.e.message);
  r = await as('rpnA', () => q(`select public.cl_rpn_activate('Rudo Banda', 'V-B', '9999') as ok`));
  t.ok('a SECURITY DEFINER function called with an RPN token is not blocked by the guard', !r.e, r.e && r.e.message);

  await pg.exec(ROLLBACK);
  r = await as('rpnA', () => q(`update public.cl_rpn set active = false where id = '${RPN_A}' returning id`));
  t.ok('rollback removes the guard (back to the old behaviour)', !r.e && r.r.length === 1, r.e && r.e.message);
  await pg.exec(MIGRATION);
  t.ok('the migration applies again after the rollback', true);

  t.done();
})().catch((e) => { console.error(e); process.exit(1); });
