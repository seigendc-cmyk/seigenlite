// node supabase/tests/chipo-merge-fix-test.js
//
// Tests supabase/data-fixes/20261021_chipo_merge.sql in an in-memory PGlite
// (the live shape + 20261021120000_billing_b), never the live database: the
// Chipo Clothing state as on live is rebuilt (two businesses, one till each,
// Business plan, Sothleapark's 3 catalogue products), the file's ids are
// swapped for this database's, and the file is run exactly as
// tools/db/run-data-fix.js runs it. Then: its self-checks refuse when live
// differs (and change nothing), and a second run is refused.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FIX = READ(path.join(ROOT, 'data-fixes', '20261021_chipo_merge.sql'));
const UNDO = READ(path.join(ROOT, 'data-fixes', '20261021_chipo_merge_undo.sql'));
const MIG = READ(path.join(ROOT, 'migrations', '20261021120000_billing_b.sql'));
const LINKS = READ(path.join(ROOT, 'migrations', '20261022120000_catalogue_merge_links.sql'));
const LIVE = { into: '95f0ba44-4041-4e6e-ac52-3516902d20e0', from: '7c47d0ea-ced3-4297-9c38-1c15fb24ac07',
  sbr: '07930efd-f41f-461d-a227-897c58956b46', hbr: 'f1a153a3-9e3c-4021-a41d-a0ba46b235b1' };

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat(['20261021120000_billing_b.sql', '20261022120000_catalogue_merge_links.sql', '20261023120000_admin_passcode_from_main.sql', '20261023180000_update_app_first_message.sql', '20261024120000_branch_stock.sql', '20261025120000_min_app_build.sql', '20261105120000_itred_order_fulfilment.sql', '20261106120000_branch_views.sql', '20261107120000_shop_roles.sql', '20261108120000_shop_managers_everywhere.sql', '20261109120000_office_seats.sql', '20261110120000_staff_first_owner.sql', '20261112120000_builtin_customers.sql', '20261113120000_sales_sync.sql', '20261113180000_removed_devices.sql', '20261114120000_roles_everywhere.sql', '20261115120000_stock_control.sql', '20261116120000_vendor_register_status.sql']) });   // just before Billing-B (it is on live now)
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const run = async (sql) => { try { const res = await pg.exec(sql); return { ok: true, res }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };

  let r = await run(FIX);
  ok('before Billing-B is applied, the fix refuses and changes nothing', /billing_b is not applied/.test(r.e || ''), JSON.stringify(r).slice(0, 300));

  // Chipo Clothing as on live (registered before Billing-B existed)
  const KEY = {}; const key = (i) => (KEY[i] = KEY[i] || crypto.randomBytes(16).toString('hex'));
  const reg = async (iid, branch) => {
    await pg.exec('set role anon');
    try { return (await q(`select public.cl_branch_register($1, 'Chipo Phrase', $2, 'Chipo Clothing', $3, $4) j`, [iid, key(iid), branch, 'B-' + (iid + 'XXXXXXXX').slice(0, 8)]))[0].j; }
    finally { await pg.exec('reset role'); }
  };
  const h = await reg('HG58', 'Harare CBD'), s = await reg('2KBZ', 'Sothleapark');
  const sys = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), 'Sys', 'x', true, true, now()) returning id`))[0].id;
  for (const b of [h.business_id, s.business_id]) await q(`insert into cl_plan_assignments (business_id, plan_code, reason, set_by) values ($1, 'business', 'test', $2)`, [b, sys]);
  const product = (biz, code) => q(`insert into cl_catalogue_products (business_id, product_uid, code, name, price, cost, low_threshold, active, change_seq, last_op_id, updated_ts)
    values ($1, replace(gen_random_uuid()::text, '-', ''), $2, $2, 5, 2, 0, true, nextval('cl_catalogue_seq'), 'test-op', now())`, [biz, code]);
  await product(h.business_id, 'pnt001');
  for (const c of ['kds003', 'lmd001', 'mb005']) await product(s.business_id, c);
  // as on live: Kids Sneaker has a picture (and, to test it too, a Sothleapark branch price on lmd001)
  const uidOf = async (code) => (await q(`select product_uid from cl_catalogue_products where business_id = $1 and code = $2`, [s.business_id, code]))[0].product_uid;
  const PIC = 'data:image/jpeg;base64,' + 'A'.repeat(40);
  await q(`insert into cl_catalogue_images (business_id, product_uid, image_hash, data) values ($1, $2, $3, $4)`, [s.business_id, await uidOf('kds003'), 'a'.repeat(64), PIC]);
  await q(`insert into cl_branch_prices (business_id, branch_id, product_uid, price, change_seq, last_op_id) values ($1, $2, $3, 7.5, nextval('cl_catalogue_seq'), 'test-op')`, [s.business_id, s.branch_id, await uidOf('lmd001')]);
  await pg.exec(MIG);
  // what live did on 2026-10-13: without 20261022120000 the picture stops the merge
  r = await run(`begin; select public.cl_business_merge_core('${s.business_id}', '${h.business_id}', 'as on live, 2026-10-13', true, null); commit;`);
  ok('without 20261022120000 (as live on 2026-10-13): a product with a picture can\'t move; refused by the picture\'s key',
    /violates foreign key constraint "cl_catalogue_images_business_id_product_uid_fkey"/.test(r.e || '') && (await q(`select archived_at from cl_businesses where id = $1`, [s.business_id]))[0].archived_at === null, r.e);
  const local0 = FIX.split(LIVE.into).join(h.business_id).split(LIVE.from).join(s.business_id).split(LIVE.sbr).join(s.branch_id).split(LIVE.hbr).join(h.branch_id);
  r = await run(local0);
  ok('... and the data fix now says so itself, changing nothing', /20261022120000_catalogue_merge_links is not applied/.test(r.e || ''), r.e);
  await pg.exec(LINKS);
  const local =FIX.split(LIVE.into).join(h.business_id).split(LIVE.from).join(s.business_id).split(LIVE.sbr).join(s.branch_id).split(LIVE.hbr).join(h.branch_id);
  ok('the file names exactly the 4 live ids it was written for', [LIVE.into, LIVE.from, LIVE.sbr, LIVE.hbr].every((id) => FIX.includes(id)) && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(local.split(h.business_id).join('').split(s.business_id).join('').split(s.branch_id).join('').split(h.branch_id).join('')));

  // live differs: an extra catalogue product at Sothleapark -> refused, nothing changed
  await product(s.business_id, 'xx999');
  r = await run(local);
  ok('if live differs from the design (4 products, not 3), it refuses and changes nothing',
    /expected 3 catalogue products at Sothleapark \(found 4\)/.test(r.e || '') && (await q(`select archived_at from cl_businesses where id = $1`, [s.business_id]))[0].archived_at === null, r.e);
  await q(`delete from cl_catalogue_products where business_id = $1 and code = 'xx999'`, [s.business_id]);

  r = await run(local);
  ok('as designed: it runs', r.ok, r.e);
  ok('the picture and the branch price moved with their products',
    (await q(`select count(*)::int c from cl_catalogue_images where business_id = $1 and data = $2`, [h.business_id, PIC]))[0].c === 1 &&
    (await q(`select count(*)::int c from cl_branch_prices where business_id = $1 and branch_id = $2 and price = 7.5`, [h.business_id, s.branch_id]))[0].c === 1 &&
    (await q(`select count(*)::int c from cl_catalogue_images where business_id = $1`, [s.business_id]))[0].c === 0);
  const br = await q(`select name, is_main, business_id from cl_branches where business_id = $1 order by is_main desc`, [h.business_id]);
  ok('one business: Harare CBD (main) and Sothleapark (branch)', br.length === 2 && br[0].name === 'Harare CBD' && br[0].is_main && br[1].name === 'Sothleapark' && !br[1].is_main, JSON.stringify(br));
  const price = (await q(`select public.cl_plan_price(null, '2KBZ', 30) j`))[0].j;
  ok('Sothleapark\'s till is priced as a branch (USD 7)', price.till_role === 'branch' && Number(price.unit_fee) === 7, JSON.stringify(price));
  ok('the duplicate is archived; 4 catalogue products in the kept business',
    (await q(`select archived_at from cl_businesses where id = $1`, [s.business_id]))[0].archived_at !== null && (await q(`select count(*)::int c from cl_catalogue_products where business_id = $1`, [h.business_id]))[0].c === 4);
  ok('logged as business_merged (by the data fix: no staff)', (await q(`select count(*)::int c from cl_activity_log where action = 'business_merged' and staff_id is null`))[0].c === 1);
  r = await run(local);
  ok('a second run is refused (the duplicate is archived now) and changes nothing', /expected both Chipo Clothing businesses, not archived \(found 1\)/.test(r.e || ''), r.e);

  // ---- the undo file (20261021_chipo_merge_undo.sql) ----
  const undo = UNDO.split(LIVE.into).join(h.business_id).split(LIVE.from).join(s.business_id).split(LIVE.sbr).join(s.branch_id).split(LIVE.hbr).join(h.branch_id);
  ok('the undo file names the same 4 live ids', [LIVE.into, LIVE.from, LIVE.sbr, LIVE.hbr].every((id) => UNDO.includes(id)));
  // a customer written since the merge ties them together: refused, nothing changed
  await q(`insert into cl_customers (business_id, customer_uid, name, phone, phone_norm, change_seq)
    values ($1, 'since-the-merge-1', 'Since the merge', '0771234567', '263771234567', 1)`, [h.business_id]).catch((e) => console.log('    (insert: ' + e.message + ')'));
  const nCust = (await q(`select count(*)::int c from cl_customers where business_id = $1`, [h.business_id]))[0].c;
  if (nCust) {
    r = await run(undo);
    ok('undo: with a customer written since the merge, it refuses and changes nothing',
      /since the merge, Chipo Clothing has 1 customers/.test(r.e || '') && (await q(`select archived_at from cl_businesses where id = $1`, [s.business_id]))[0].archived_at !== null, r.e);
    await q(`delete from cl_customers where business_id = $1`, [h.business_id]);
  } else ok('undo: (a customer row could be written for the refusal check)', false, 'insert into cl_customers failed');
  const seqBefore = (await q(`select max(change_seq)::bigint m from cl_catalogue_products`))[0].m;
  r = await run(undo);
  ok('undo: it runs', r.ok, r.e);
  const after = await q(`select b.name, b.is_main, b.business_id = $1 as kept from cl_branches b where b.id in ($2, $3) order by b.name`, [h.business_id, h.branch_id, s.branch_id]);
  ok('undo: two businesses again, each with its own main branch',
    after.length === 2 && after[0].name === 'Harare CBD' && after[0].is_main && after[0].kept && after[1].name === 'Sothleapark' && after[1].is_main && !after[1].kept, JSON.stringify(after));
  ok('undo: the duplicate is no longer archived; its till and device row are back',
    (await q(`select archived_at from cl_businesses where id = $1`, [s.business_id]))[0].archived_at === null &&
    (await q(`select count(*)::int c from cl_terminals t join cl_vendors v on v.id = t.vendor_id where t.business_id = $1 and v.business_id = $1 and t.install_id = '2KBZ'`, [s.business_id]))[0].c === 1);
  const cats = await q(`select business_id = $1 as back, lower(code) code, change_seq::bigint s from cl_catalogue_products order by code`, [s.business_id]);
  ok('undo: the 3 products are back at Sothleapark with new change numbers; pnt001 stays at Harare CBD',
    cats.filter((c) => c.back).map((c) => c.code).join() === 'kds003,lmd001,mb005' && cats.filter((c) => c.back).every((c) => Number(c.s) > Number(seqBefore)) &&
    cats.filter((c) => !c.back).map((c) => c.code).join() === 'pnt001', JSON.stringify(cats));
  ok('undo: the picture and the branch price went back with their products',
    (await q(`select count(*)::int c from cl_catalogue_images where business_id = $1 and data = $2`, [s.business_id, PIC]))[0].c === 1 &&
    (await q(`select count(*)::int c from cl_branch_prices where business_id = $1 and price = 7.5`, [s.business_id]))[0].c === 1);
  const p2 = (await q(`select public.cl_plan_price(null, '2KBZ', 30) j`))[0].j;
  ok('undo: Sothleapark\'s till is priced as a main till again (USD 15), logged as business_unmerged',
    p2.till_role === 'main' && Number(p2.unit_fee) === 15 && (await q(`select count(*)::int c from cl_activity_log where action = 'business_unmerged'`))[0].c === 1, JSON.stringify(p2));
  r = await run(undo);
  ok('undo: a second run is refused and changes nothing', /isn't archived by the merge/.test(r.e || ''), r.e);
  r = await run(local);
  ok('after the undo, the merge file can run again', r.ok, r.e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
