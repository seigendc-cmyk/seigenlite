// node supabase/tests/catalogue-merge-links-test.js
//
// Tests supabase/migrations/20261022120000_catalogue_merge_links.sql (and its
// rollback) in an in-memory PGlite built from the repo (the live shape),
// never the live database: the three product keys follow a product when its
// business changes, a delete is still refused while anything points at it,
// a second run is refused, and the rollback puts the keys back exactly.
'use strict';
const path = require('path');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');

const ROOT = path.join(__dirname, '..');
const FILE = '20261022120000_catalogue_merge_links.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', '20261022120000_catalogue_merge_links.rollback.sql'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 400) : '')); }
}

(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261023120000_admin_passcode_from_main.sql', '20261023180000_update_app_first_message.sql', '20261024120000_branch_stock.sql', '20261025120000_min_app_build.sql', '20261105120000_itred_order_fulfilment.sql', '20261106120000_branch_views.sql', '20261107120000_shop_roles.sql']) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const run = async (sql) => { try { await pg.exec(sql); return { ok: true }; } catch (e) { await pg.exec('rollback').catch(() => {}); return { e: e.message }; } };
  const keys = async () => (await q(`select conname, confupdtype, confdeltype, pg_get_constraintdef(oid) def from pg_constraint
     where contype = 'f' and confrelid = 'public.cl_catalogue_products'::regclass order by conname`));
  const before = fingerprint(await snapshot(q));
  const keysBefore = JSON.stringify(await keys());

  // two businesses and a product with a picture
  const biz = async (n) => { const v = (await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status) values ($1, $2, 'p', md5($1), 'onboarding') returning id`, [n, n.slice(-1) + 'LNK']))[0].id;
    return (await q(`insert into cl_businesses (name, secret_phrase_hash, created_by_vendor_id) values ($1, 'x', $2) returning id`, [n, v]))[0].id; };
  const A = await biz('Links A'), B = await biz('Links B');
  await q(`insert into cl_catalogue_products (business_id, product_uid, code, name, price, cost, low_threshold, active, change_seq, last_op_id, updated_ts)
           values ($1, '0123456789abcdef0123456789abcdef', 'K1', 'Kids', 5, 2, 0, true, nextval('cl_catalogue_seq'), 'op', now())`, [A]);
  await q(`insert into cl_catalogue_images (business_id, product_uid, image_hash, data) values ($1, '0123456789abcdef0123456789abcdef', $2, 'data:image/png;base64,AA')`, [A, 'b'.repeat(64)]);
  let r = await run(`update cl_catalogue_products set business_id = '${B}' where product_uid = '0123456789abcdef0123456789abcdef'`);
  ok('before: a product with a picture can\'t change business (the live refusal)', /cl_catalogue_images_business_id_product_uid_fkey/.test(r.e || ''), r.e);

  r = await run(MIG);
  ok('it applies', r.ok, r.e);
  const k = await keys();
  ok('the 3 keys follow the product (ON UPDATE CASCADE); deletes still refused (NO ACTION)',
    k.length === 3 && k.every((x) => x.confupdtype === 'c' && x.confdeltype === 'a'), JSON.stringify(k));
  r = await run(`update cl_catalogue_products set business_id = '${B}' where product_uid = '0123456789abcdef0123456789abcdef'`);
  ok('now the product moves and its picture follows', r.ok && (await q(`select business_id from cl_catalogue_images where product_uid = '0123456789abcdef0123456789abcdef'`))[0].business_id === B, r.e);
  r = await run(`delete from cl_catalogue_products where product_uid = '0123456789abcdef0123456789abcdef'`);
  ok('deleting a product with a picture is still refused', /cl_catalogue_images_business_id_product_uid_fkey/.test(r.e || ''), r.e);
  r = await run(MIG);
  ok('a second run is refused and changes nothing', /expected the 3 product keys without ON UPDATE \(found 0\)/.test(r.e || ''), r.e);

  await q(`delete from cl_catalogue_images where product_uid = '0123456789abcdef0123456789abcdef'`);
  await q(`delete from cl_catalogue_products where product_uid = '0123456789abcdef0123456789abcdef'`);
  await q(`delete from cl_businesses where id in ($1, $2)`, [A, B]);
  await q(`delete from cl_vendors where install_id in ('ALNK', 'BLNK')`);
  r = await run(RB);
  ok('the rollback applies', r.ok, r.e);
  ok('after the rollback the keys are exactly as before', JSON.stringify(await keys()) === keysBefore, JSON.stringify(await keys()));
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('after the rollback the whole catalogue equals the one before', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 400));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
