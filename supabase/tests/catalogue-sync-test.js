// node supabase/tests/catalogue-sync-test.js
//
// Tests supabase/migrations/20261006120000_catalogue_sync.sql (and its
// rollback) in an in-memory PGlite — never against the live database.
// The database is first brought to the live state: the shared live stub,
// then the Phase 1 and Phase 2 migrations (live since 2026-10-04/06).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LIVE_STUB } = require('./live-stub');

const ROOT = path.join(__dirname, '..');
const P1 = fs.readFileSync(`${ROOT}/migrations/20261004120000_multi_terminal_identity.sql`, 'utf8');
const P2 = fs.readFileSync(`${ROOT}/migrations/20261004180000_multi_terminal_phase2.sql`, 'utf8');
const MIG = fs.readFileSync(`${ROOT}/migrations/20261006120000_catalogue_sync.sql`, 'utf8');
const RB = fs.readFileSync(`${ROOT}/rollbacks/20261006120000_catalogue_sync.rollback.sql`, 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}
const hex = (n) => crypto.randomBytes(n).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const IMG = 'data:image/webp;base64,' + Buffer.from('fake-webp-bytes-' + 'x'.repeat(200)).toString('base64');

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const q0 = async (pg, sql, p) => (await pg.query(sql, p)).rows;
  async function liveDb() {
    const pg = new PGlite({ extensions: { pgcrypto } });
    await pg.exec(LIVE_STUB); await pg.exec(P1); await pg.exec(P2);
    return pg;
  }
  const pg = await liveDb();
  const q = (sql, p) => q0(pg, sql, p);
  async function anon(sql, p) {
    await pg.exec('set role anon');
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); }
  }
  const dev = async (sql, p) => { const x = await anon(sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };

  // ---- live-like state: business A (main T1, main T2, remote branch R with T1), business X (main) ----
  const reg = await dev(`select public.cl_branch_register('MAIN1234','Biz Phrase','K-MAIN','Gentronix','Harare CBD','B-ABCD2345','Front till') j`);
  const code = await dev(`select public.cl_branch_issue_join_code('MAIN1234','Biz Phrase','K-MAIN',$1::uuid) j`, [reg.branch_id]);
  const t2 = await dev(`select public.cl_terminal_join('TERM0002','Biz Phrase','K-T2',$1,'Back till') j`, [code.code]);
  const rc = await dev(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN1234',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-MAIN',p_new_branch_name=>'Murehwa') j`);
  const rt = await dev(`select public.cl_terminal_join('REMOTE01','Biz Phrase','K-R',$1) j`, [rc.code]);
  const rc2 = await dev(`select public.cl_branch_issue_join_code(p_install_id=>'MAIN1234',p_secret_phrase=>'Biz Phrase',p_device_key=>'K-MAIN',p_new_branch_name=>'Mutare') j`);
  const xr = await dev(`select public.cl_branch_register('XMAIN001','Other Phrase','K-X','Other Biz','Bulawayo') j`);
  ok('setup: business A (T1, T2 at main, T1 at Murehwa) and business X', reg.till_code === 'T1' && t2.till_code === 'T2' && rt.till_code === 'T1' && !!xr.business_id);

  const A = { main: ['MAIN1234', 'Biz Phrase', 'K-MAIN'], t2: ['TERM0002', 'Biz Phrase', 'K-T2'], rem: ['REMOTE01', 'Biz Phrase', 'K-R'], x: ['XMAIN001', 'Other Phrase', 'K-X'] };
  const push = (who, rows) => dev(`select public.cl_catalogue_push($1,$2,$3,$4::jsonb) j`, [...who, JSON.stringify(rows)]);
  const pull = (who, cursor, limit) => dev(`select public.cl_catalogue_pull($1,$2,$3,$4,$5) j`, [...who, cursor, limit || 500]);
  const bpush = (who, rows) => dev(`select public.cl_branch_price_push($1,$2,$3,$4::jsonb) j`, [...who, JSON.stringify(rows)]);
  const mode = (who, branch, m) => dev(`select public.cl_branch_set_price_mode($1,$2,$3,$4::uuid,$5) j`, [...who, branch, m]);
  const pics = (who, uids) => dev(`select public.cl_catalogue_images_pull($1,$2,$3,$4::text[]) j`, [...who, uids]);
  const prod = (o) => Object.assign({ uid: hex(16), op_id: hex(16), code: 'SK' + hex(2), name: 'Item ' + hex(2), price: 5, cost: 3, low_threshold: 5, active: true, image_hash: null }, o);

  // ---- preflight ----
  {
    const other = await liveDb();
    await other.exec(MIG);
    let e = null; try { await other.exec(MIG); } catch (x) { e = x.message; await other.exec('rollback'); }
    ok('applying twice aborts in the preflight, naming what exists', /already exists: .*cl_catalogue_products/.test(e || ''), e);
    await other.close();
    const bare = new PGlite({ extensions: { pgcrypto } });
    await bare.exec(LIVE_STUB); await bare.exec(P1);
    e = null; try { await bare.exec(MIG); } catch (x) { e = x.message; await bare.exec('rollback'); }
    ok('a database without Phase 2 aborts in the preflight', /missing .*cl_terminal_set_active/.test(e || ''), e);
    await bare.close();
  }

  await pg.exec(MIG);
  ok('migration applies to the live (Phase 2) state', true);

  // ---- access ----
  for (const t of ['cl_catalogue_products', 'cl_catalogue_images', 'cl_branch_prices']) {
    ok(`anon cannot read ${t}`, /permission denied/.test((await anon(`select * from public.${t}`)).e || ''));
    ok(`RLS is on for ${t}`, (await q(`select relrowsecurity r from pg_class where relname=$1`, [t]))[0].r === true);
  }
  ok('anon cannot call cl_catalogue_caller', /permission denied/.test((await anon(`select public.cl_catalogue_caller('MAIN1234','Biz Phrase','K-MAIN')`)).e || ''));
  ok('anon cannot use the sequence', /permission denied/.test((await anon(`select nextval('public.cl_catalogue_seq')`)).e || ''));
  ok('existing branches default to follow_main', (await q(`select bool_and(price_mode='follow_main') b from cl_branches`))[0].b === true);

  // ---- push ----
  const p1 = prod({ code: 'RICE2', name: 'Rice 2kg', price: 10.5, cost: 7.25 });
  const p2 = prod({ code: 'SUG1', name: 'Sugar 1kg', price: 4 });
  const p3 = prod({ code: '', name: 'Loose sweets', price: 0.5 });
  let r = await push(A.main, [p1, p2, p3]);
  ok('main pushes 3 products: all applied with rising seqs', r.results.length === 3 && r.results.every(x => x.status === 'applied')
    && r.results[0].seq < r.results[1].seq && r.results[1].seq < r.results[2].seq, JSON.stringify(r));
  const seqP1 = r.results[0].seq;
  r = await push(A.main, [p1]);
  ok('a replay of the same op_id is a duplicate: nothing changes', r.results[0].status === 'duplicate' && r.results[0].seq === seqP1);
  ok('... and the server row still has its first seq', (await q(`select change_seq s from cl_catalogue_products where product_uid=$1`, [p1.uid]))[0].s == seqP1);
  r = await push(A.t2, [prod({ uid: p2.uid, code: 'SUG1', name: 'Sugar 1kg', price: 4.5 })]);
  ok('T2 (also at main) can push', r.results[0].status === 'applied');
  ok('a remote till cannot push products (refused by the server)', (await push(A.rem, [prod()])).error === 'NOT_MAIN');
  ok('a wrong phrase is refused', /does not match/.test((await anon(`select public.cl_catalogue_push('MAIN1234','Wrong','K-MAIN','[]'::jsonb)`)).e || ''));
  ok('a wrong device key is refused', /another device/.test((await anon(`select public.cl_catalogue_push('MAIN1234','Biz Phrase','K-OTHER','[]'::jsonb)`)).e || ''));
  ok('an unknown install is refused', /not registered/.test((await anon(`select public.cl_catalogue_pull('NOPE0001','x','k',0,10)`)).e || ''));
  ok('an empty batch is refused', /between 1 and 100/.test((await anon(`select public.cl_catalogue_push('MAIN1234','Biz Phrase','K-MAIN','[]'::jsonb)`)).e || ''));
  ok('101 rows are refused', /between 1 and 100/.test((await anon(`select public.cl_catalogue_push('MAIN1234','Biz Phrase','K-MAIN',$1::jsonb)`, [JSON.stringify(Array.from({ length: 101 }, () => prod()))])).e || ''));

  r = await push(A.main, [prod({ code: ' rice2 ', name: 'Other rice' }), prod({ code: 'OK1', name: '' }), { uid: 'bad', op_id: hex(16), name: 'x', price: 1 }]);
  ok('a second active product with the same code (trim/case) is refused DUPLICATE_CODE', r.results[0].status === 'refused' && r.results[0].reason === 'DUPLICATE_CODE');
  ok('a nameless product and a bad uid are refused BAD_ROW, without stopping the batch', r.results[1].reason === 'BAD_ROW' && r.results[2].reason === 'BAD_ROW');
  r = await push(A.main, [Object.assign({}, p1, { op_id: hex(16), active: false })]);
  ok('deactivating a product is a push like any other (soft delete)', r.results[0].status === 'applied'
    && (await q(`select active from cl_catalogue_products where product_uid=$1`, [p1.uid]))[0].active === false);
  r = await push(A.main, [prod({ code: 'RICE2', name: 'New rice' })]);
  ok('... and frees its code for another active product', r.results[0].status === 'applied');
  const p4uid = JSON.parse(JSON.stringify(r.results[0])).uid;
  r = await push(A.main, [Object.assign({}, p1, { op_id: hex(16), active: true })]);
  ok('reactivating the old one while the code is taken is refused', r.results[0].reason === 'DUPLICATE_CODE');

  // ---- conflict: last arrival wins, overwrote flagged ----
  const seqNow = (await q(`select change_seq s from cl_catalogue_products where product_uid=$1`, [p2.uid]))[0].s;
  r = await push(A.main, [prod({ uid: p2.uid, code: 'SUG1', name: 'Sugar 1kg (T1)', price: 4.75, base_seq: 1 })]);
  ok('T1 pushing over T2\'s newer change wins and is told it overwrote', r.results[0].status === 'applied' && r.results[0].overwrote === true
    && (await q(`select name from cl_catalogue_products where product_uid=$1`, [p2.uid]))[0].name === 'Sugar 1kg (T1)');
  r = await push(A.main, [prod({ uid: p2.uid, code: 'SUG1', name: 'Sugar 1kg', price: 4.75, base_seq: Number(r.results[0].seq) })]);
  ok('a push based on the latest seq is not an overwrite', r.results[0].overwrote === false);
  ok('seqs only ever grow', Number(seqNow) < Number(r.results[0].seq));

  // ---- pictures ----
  const h = sha(IMG);
  r = await push(A.main, [prod({ uid: p2.uid, code: 'SUG1', name: 'Sugar 1kg', price: 4.75, image_hash: h })]);
  ok('a picture hash without the picture (server lacks it) is refused NEED_IMAGE', r.results[0].reason === 'NEED_IMAGE');
  r = await push(A.main, [prod({ uid: p2.uid, code: 'SUG1', name: 'Sugar 1kg', price: 4.75, image_hash: sha('other'), image: IMG })]);
  ok('a picture that does not match its hash is refused BAD_IMAGE', r.results[0].reason === 'BAD_IMAGE');
  r = await push(A.main, [prod({ uid: p2.uid, code: 'SUG1', name: 'Sugar 1kg', price: 4.75, image_hash: h, image: IMG })]);
  ok('picture + matching hash is applied; image_bytes recorded', r.results[0].status === 'applied'
    && (await q(`select image_bytes b from cl_catalogue_products where product_uid=$1`, [p2.uid]))[0].b === IMG.length);
  r = await push(A.main, [prod({ uid: p2.uid, code: 'SUG1', name: 'Sugar 1 kg', price: 4.75, image_hash: h })]);
  ok('later pushes with the same hash need not resend the picture', r.results[0].status === 'applied'
    && (await q(`select image_bytes b from cl_catalogue_products where product_uid=$1`, [p2.uid]))[0].b === IMG.length);
  let ip = await pics(A.rem, [p2.uid, p3.uid]);
  ok('any till of the business pulls pictures by uid', ip.images.length === 1 && ip.images[0].data === IMG && ip.images[0].image_hash === h);
  ok('another business cannot pull them', (await pics(A.x, [p2.uid])).images.length === 0);
  ok('more than 50 at once is refused', /between 1 and 50/.test((await anon(`select public.cl_catalogue_images_pull('REMOTE01','Biz Phrase','K-R',$1::text[])`, [Array.from({ length: 51 }, () => hex(16))])).e || ''));

  // ---- pull ----
  let all = [], cur = 0, pages = 0, last;
  do { last = await pull(A.rem, cur, 2); all = all.concat(last.products); cur = last.cursor; pages++; } while (last.more && pages < 20);
  const byUid = Object.fromEntries(all.map(p => [p.uid, p]));
  ok('a remote till pulls the catalogue in pages, cursor rising, until more=false', pages >= 2 && last.more === false);
  ok('... every product, including the deactivated one and the uncoded one', !!byUid[p1.uid] && byUid[p1.uid].active === false && !!byUid[p3.uid] && byUid[p3.uid].code === '');
  ok('... with the picture hash and size, but not the picture', byUid[p2.uid].image_hash === h && byUid[p2.uid].image_bytes === IMG.length && byUid[p2.uid].data === undefined);
  ok('a remote till never receives cost', all.every(p => p.cost === null));
  const mp = await pull(A.t2, 0, 500);
  ok('a main-branch till receives cost', mp.products.find(p => p.uid === p3.uid).cost !== null && Number(mp.products.find(p => p.uid === p2.uid).cost) === 3);
  ok('pull reports the branch and its policy', last.price_mode === 'follow_main' && last.branch_id === rc.branch_id && last.is_main === false);
  ok('nothing new after the cursor', (await pull(A.rem, cur, 500)).products.length === 0);
  ok('another business sees none of it', (await pull(A.x, 0, 500)).products.length === 0);
  ok('limit is capped at 500', (await pull(A.rem, 0, 100000)).products.length <= 500);

  // ---- branch prices + policy ----
  ok('a remote till cannot set a branch policy', (await mode(A.rem, rc.branch_id, 'branch_edits')).error === 'NOT_MAIN');
  r = await bpush(A.rem, [{ branch_id: rc.branch_id, product_uid: p2.uid, price: 6, op_id: hex(16) }]);
  ok('a remote till cannot set its own price under follow_main', r.results[0].reason === 'NOT_ALLOWED');
  r = await bpush(A.main, [{ branch_id: rc.branch_id, product_uid: p2.uid, price: 5.5, op_id: hex(16) },
                           { branch_id: xr.branch_id, product_uid: p2.uid, price: 1, op_id: hex(16) },
                           { branch_id: rc.branch_id, product_uid: hex(16), price: 1, op_id: hex(16) }]);
  ok('main sets a price for Murehwa', r.results[0].status === 'applied');
  ok('... not for another business\'s branch', r.results[1].reason === 'UNKNOWN_BRANCH');
  ok('... nor for a product not in the catalogue', r.results[2].reason === 'UNKNOWN_PRODUCT');
  let rp = await pull(A.rem, cur, 500);
  ok('Murehwa\'s pull carries its price', rp.prices.length === 1 && Number(rp.prices[0].price) === 5.5 && rp.prices[0].uid === p2.uid);
  cur = rp.cursor;
  const mutare = await q(`select id from cl_branches where name='Mutare'`);
  ok('other branches never see it (main\'s own pull has no Murehwa prices)', (await pull(A.t2, 0, 500)).prices.length === 0);
  let m = await mode(A.main, rc.branch_id, 'branch_edits');
  ok('main sets Murehwa to branch_edits', m.price_mode === 'branch_edits' && m.seq > 0);
  ok('setting the same policy again changes nothing', (await mode(A.main, rc.branch_id, 'branch_edits')).unchanged === true);
  ok('an unknown policy is refused', /Unknown price policy/.test((await anon(`select public.cl_branch_set_price_mode('MAIN1234','Biz Phrase','K-MAIN',$1::uuid,'whatever')`, [rc.branch_id])).e || ''));
  ok('pull reports the new policy', (await pull(A.rem, cur, 500)).price_mode === 'branch_edits');
  const op = hex(16);
  r = await bpush(A.rem, [{ branch_id: rc.branch_id, product_uid: p2.uid, price: 6.25, op_id: op },
                          { branch_id: mutare[0].id, product_uid: p2.uid, price: 9, op_id: hex(16) }]);
  ok('under branch_edits the remote till sets its own branch price', r.results[0].status === 'applied');
  ok('... but never another branch\'s', r.results[1].reason === 'NOT_ALLOWED');
  ok('a replayed price push is a duplicate', (await bpush(A.rem, [{ branch_id: rc.branch_id, product_uid: p2.uid, price: 6.25, op_id: op }])).results[0].status === 'duplicate');
  r = await bpush(A.main, [{ branch_id: rc.branch_id, product_uid: p2.uid, price: null, op_id: hex(16) }]);
  rp = await pull(A.rem, cur, 500);
  ok('removing a branch price (null) reaches the till as null', r.results[0].status === 'applied' && rp.prices.length === 1 && rp.prices[0].price === null);

  // ---- inactive till ----
  await dev(`select public.cl_terminal_set_active('MAIN1234','Biz Phrase','K-MAIN',$1::uuid,false) j`, [t2.terminal_id]);
  ok('a deactivated till cannot push', (await push(A.t2, [prod()])).error === 'TERMINAL_INACTIVE');
  ok('... nor pull', (await pull(A.t2, 0, 10)).error === 'TERMINAL_INACTIVE');
  ok('... nor pull pictures', (await pics(A.t2, [p2.uid])).error === 'TERMINAL_INACTIVE');
  await dev(`select public.cl_terminal_set_active('MAIN1234','Biz Phrase','K-MAIN',$1::uuid,true) j`, [t2.terminal_id]);
  ok('reactivated, it pulls again', Array.isArray((await pull(A.t2, 0, 10)).products));

  // ---- a 600-product catalogue: 6 pushes of 100, pulled as 2 pages ----
  {
    const big = Array.from({ length: 600 }, (_, i) => prod({ code: 'B' + i, name: 'Bulk ' + i }));
    for (let i = 0; i < 600; i += 100) await push(A.main, big.slice(i, i + 100));
    let n = 0, c = 0, pg_ = 0, l;
    do { l = await pull(A.rem, c, 500); n += l.products.length; c = l.cursor; pg_++; } while (l.more);
    ok('600 more products: 6 pushes of 100, pulled from 0 in 2 pages of up to 500', pg_ === 2 && n >= 600, `${pg_} pages, ${n} rows`);
  }

  // ---- rollback ----
  await pg.exec(RB);
  ok('rollback: tables, sequence and functions gone', (await q(`select count(*)::int n from pg_class where relname in ('cl_catalogue_products','cl_catalogue_images','cl_branch_prices','cl_catalogue_seq')`))[0].n === 0
    && (await q(`select count(*)::int n from pg_proc where proname like 'cl_catalogue%' or proname in ('cl_branch_price_push','cl_branch_set_price_mode')`))[0].n === 0);
  ok('rollback: cl_branches has no price_mode columns', (await q(`select count(*)::int n from information_schema.columns where table_name='cl_branches' and column_name like 'price_mode%'`))[0].n === 0);
  ok('rollback: Phase 1/2 still work (check-in)', (await dev(`select public.cl_device_checkin(p_install_id=>'REMOTE01', p_shop_secret_phrase=>'Biz Phrase', p_device_code=>'X', p_business_name=>'X', p_device_key=>'K-R') j`)).terminal_active === true);
  await pg.exec(MIG);
  ok('the migration applies again after a rollback', (await pull(A.rem, 0, 10)).products.length === 0);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
