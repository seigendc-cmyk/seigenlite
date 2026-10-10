// node supabase/tests/market-publishing-test.js
//
// Tests supabase/migrations/20261016120000_market_publishing.sql (and its
// rollback) in an in-memory PGlite built from the repo in the live shape,
// never the live database: the owner's first token price, selling tokens
// (one ledger charge, price snapshot, double taps, tills refused), "paid"
// oldest charges first (an older unpaid licence holds up newer tokens), a
// credit cancelling a sale, RPN commission on a token payment, packs sent by
// a device (phone check, damaged header / photo, wrong device, limits,
// resume, never twice, a newer pack replacing an undecided one, a business's
// tills), review (open, thumbnails, problems, reject with a reason), the hand
// upload, publishing (refused without paid days, days used, expires_at =
// publish + days, one iTred vendor per business, the public read), republish
// carrying days over, extend, unpublish giving back whole days, expiry,
// welcome days, the 7-day default for the old portal, who may do what, the
// delete guards, and the rollback.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { snapshot, fingerprint, diff } = require('../../tools/db/catalog');
const { NOT_ON_LIVE_FILES, newPglite, buildFromRepo, READ } = require('./rebuild-helpers');

const ROOT = path.join(__dirname, '..');
const FILE = '20261016120000_market_publishing.sql';
const MIG = READ(path.join(ROOT, 'migrations', FILE));
const RB = READ(path.join(ROOT, 'rollbacks', FILE.replace('.sql', '.rollback.sql')));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + String(extra).slice(0, 600) : '')); }
}
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
// a small but real WebP header: RIFF <size> WEBP VP8L ...
const webp = (seed, pad) => 'data:image/webp;base64,' + Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8L'), crypto.createHash('md5').update(String(seed)).digest(), Buffer.alloc(pad || 0)]).toString('base64');

const BUCKET_URL = 'https://proj.supabase.co/storage/v1/object/public/listing-images/';
(async () => {
  const pg = await newPglite();
  await buildFromRepo(pg, { skip: NOT_ON_LIVE_FILES.concat([FILE, '20261017120000_dispatch_grv.sql', '20261018120000_supplier_grv.sql']) });
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const tryQ = async (sql, p) => { try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; } };
  const before = fingerprint(await snapshot(q));
  async function as(claims, sql, p) {
    await pg.exec('set role ' + (claims ? 'authenticated' : 'anon'));
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
    try { return { r: await q(sql, p) }; } catch (e) { return { e: e.message }; }
    finally { await pg.exec('reset role'); await pg.query(`select set_config('request.jwt.claims', '', false)`); }
  }
  const j = (x) => (x.e ? { e: x.e } : x.r[0].j);

  // ---- staff, accounts, an RPN ----
  const staff = {};
  for (const [k, sys] of [['SYS', true], ['REV', false], ['PUB', false], ['TOK', false], ['LED', false], ['NONE', false]])
    staff[k] = (await q(`insert into cl_staff (id, full_name, passcode_hash, is_sysadmin, active, created_at) values (gen_random_uuid(), $1, 'x', $2, true, now()) returning id`, ['Staff ' + k, sys]))[0].id;
  const modId = async (k) => ((await q(`select id from cl_modules where key = $1`, [k]))[0] || {}).id ||
    (await q(`insert into cl_modules (id, key, label, sort_order) values (gen_random_uuid(), $1, $1, 1) returning id`, [k]))[0].id;
  const grant = async (s, m) => q(`insert into cl_staff_module_access (staff_id, module_id, granted_at) values ($1, $2, now())`, [staff[s], await modId(m)]);
  await grant('LED', 'collections_ledger'); await grant('NONE', 'cashbook');
  const tok = (k) => ({ role: 'authenticated', sub: staff[k], user_type: 'staff', is_sysadmin: k === 'SYS' });
  const coa = (await q(`insert into cl_chart_of_accounts (id, code, name, account_type, active, created_at) values (gen_random_uuid(), '1000', 'Cash on Hand', 'asset', true, now()) returning id`))[0].id;
  const tendai = (await q(`insert into cl_rpn (full_name, passcode_hash, verification_code) values ('Tendai', 'x', 'V-T') returning id`))[0].id;
  await q(`insert into cl_rpn_commission_rates (onboarding_pct, recurring_pct, effective_from) values (10, 5, now() - interval '1 day')`);

  const KEY = {}; const key = (iid) => (KEY[iid] = KEY[iid] || crypto.randomBytes(16).toString('hex'));
  const single = async (iid, name) => (await q(`insert into cl_vendors (business_name, install_id, shop_secret_phrase, device_key, status, rpn_id) values ($1, $2, 'Shop Phrase', $3, 'onboarding', $4) returning id`, [name, iid, key(iid), iid === 'SD01' ? tendai : null]))[0].id;
  const sd1 = await single('SD01', 'Single One'), sd2 = await single('SD02', 'Single Two'), sd3 = await single('SD03', 'Single Three');
  const dev = async (sql, p) => { const x = await as(null, sql, p); if (x.e) throw new Error(x.e); return x.r[0].j; };
  const AP = 'Acme Phrase';
  const acme = await dev(`select public.cl_branch_register($1, $2, $3, 'Acme', 'Harare') j`, ['AC01', AP, key('AC01')]);
  const code = await dev(`select public.cl_branch_issue_join_code(p_install_id=>$1, p_secret_phrase=>$2, p_device_key=>$3, p_branch_id=>$4::uuid, p_new_branch_name=>null) j`, ['AC01', AP, key('AC01'), acme.branch_id]);
  await dev(`select public.cl_terminal_join($1, $2, $3, $4) j`, ['AC02', AP, key('AC02'), code.code]);
  const ac1 = (await q(`select id from cl_vendors where install_id = 'AC01'`))[0].id, ac2 = (await q(`select id from cl_vendors where install_id = 'AC02'`))[0].id;

  // ---- apply ----
  let e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('the migration applies', !e, e);
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('a second run is refused by the preflight, changing nothing', /market_publishing aborted: already there/.test(e || ''), e);
  for (const [s, m] of [['REV', 'market_review'], ['PUB', 'market_publish'], ['TOK', 'token_sales']]) await grant(s, m);
  const price0 = (await q(`select price_per_token::text, days_per_token, currency, welcome_days, note from cl_token_prices`));
  ok('the owner\'s first token price is seeded: 1 token = 1 day, USD 1.00, 0 welcome days', price0.length === 1 && price0[0].price_per_token === '1.00' && price0[0].days_per_token === 1 &&
    price0[0].currency === 'USD' && price0[0].welcome_days === 0 && /Owner decision 2026-10-09/.test(price0[0].note), JSON.stringify(price0));

  // ---- packs ----
  function makePack(install, products, o) {
    o = o || {};
    const images = {}, thumbs = {};
    const listings = products.map((p, i) => {
      const id = p.id || ('P' + i);
      let image_sha256 = null;
      if (p.photo !== false) { images[id] = webp(install + id, p.pad); thumbs[id] = webp('t' + install + id); image_sha256 = sha(images[id]); }
      return { source_product_id: id, product_name: p.name === undefined ? 'Product ' + i : p.name, price: p.price === undefined ? 2.5 : p.price,
        currency: p.currency || 'USD', category: 'Test', stock_quantity: 4, exported_at: new Date().toISOString(), image_sha256 };
    });
    const header = JSON.stringify({ format: 'seigen.market_export', format_version: o.v || 2, export_no: o.no || 'MKT0001',
      vendor: { install_id: o.headerInstall || install, business_name: 'Shop ' + install, whatsapp_number: '0771234567', city: 'Harare' }, listings });
    return { uid: crypto.randomUUID(), header, sha: o.badSha ? sha(header + 'x') : sha(header), images, thumbs };
  }
  const phrase = (iid) => (iid.startsWith('AC') ? AP : 'Shop Phrase');
  const submit = (iid, pk, ph) => as(null, `select public.cl_device_pack_submit($1, $2, $3, $4, $5, $6) j`, [iid, ph || phrase(iid), key(iid), pk.uid, pk.header, pk.sha]).then(j);
  const image = (iid, pk, id, img, th) => as(null, `select public.cl_device_pack_image($1, $2, $3, $4, $5, $6, $7) j`,
    [iid, phrase(iid), key(iid), pk.uid, id, img === undefined ? pk.images[id] : img, th === undefined ? pk.thumbs[id] : th]).then(j);
  const sendAll = async (iid, pk) => { const s = await submit(iid, pk); for (const id of (s.missing || [])) await image(iid, pk, id); return s; };
  const status = (iid) => as(null, `select public.cl_device_pack_status($1, $2, $3) j`, [iid, phrase(iid), key(iid)]).then(j);

  const three = [{ id: 'A1' }, { id: 'A2' }, { id: 'A3', photo: false }];
  ok('a wrong phrase is refused', /Shop secret phrase does not match/.test((await submit('SD01', makePack('SD01', three), 'Wrong')).e || ''));
  ok('a damaged header is refused ("It will be sent again")', /The pack arrived damaged/.test((await submit('SD01', makePack('SD01', three, { badSha: true }))).e || ''));
  ok('a pack made on another device is refused', /The pack belongs to another device/.test((await submit('SD01', makePack('SD01', three, { headerInstall: 'SD02' }))).e || ''));
  ok('more than 200 products is refused', /at most 200 products \(this one has 201\)/.test((await submit('SD01', makePack('SD01', Array.from({ length: 201 }, (x, i) => ({ id: 'X' + i, photo: false }))))).e || ''));
  ok('a product twice is refused', /A product appears twice \(A1\)/.test((await submit('SD01', makePack('SD01', [{ id: 'A1' }, { id: 'A1' }]))).e || ''));
  const p1 = makePack('SD01', three);
  const s1 = await submit('SD01', p1);
  ok('a pack arrives without its photos first: receiving, 2 photos missing', s1.status === 'receiving' && JSON.stringify(s1.missing) === '["A1","A2"]', JSON.stringify(s1));
  ok('a photo that doesn\'t match its checksum is refused', /A photo arrived damaged/.test((await image('SD01', p1, 'A1', p1.images.A2)).e || ''));
  ok('a photo that isn\'t WebP is refused', /isn't a WebP image/.test((await image('SD01', p1, 'A1', 'data:image/png;base64,AAAA')).e || ''));
  ok('a product without a photo in the pack can\'t get one', /has no photo in the pack/.test((await image('SD01', p1, 'A3', p1.images.A1)).e || ''));
  const i1 = await image('SD01', p1, 'A1');
  ok('one photo per call', i1.status === 'receiving' && i1.received === 1 && i1.expected === 2, JSON.stringify(i1));
  const again = await submit('SD01', p1);
  ok('resume: sending the pack again (same uid) asks only for the missing photo; no second pack', JSON.stringify(again.missing) === '["A2"]' &&
    (await q(`select count(*)::int c from cl_market_packs`))[0].c === 1, JSON.stringify(again));
  ok('a photo sent twice is harmless', (await image('SD01', p1, 'A1')).received === 1);
  const done = await image('SD01', p1, 'A2');
  ok('all photos in: received', done.status === 'received', JSON.stringify(done));
  ok('the app sees "received"', (await status('SD01'))[0].status === 'received');
  const p1b = makePack('SD01', three, { no: 'MKT0002' });
  await sendAll('SD01', p1b);
  const photoState = async (uid) => (await q(`select count(*)::int n, count(image_webp)::int with_data, count(thumb_webp)::int with_thumb, count(sha256)::int with_sha from cl_market_pack_images where pack_id = $1`, [uid]))[0];
  ok('a newer pack replaces an undecided one', (await q(`select status from cl_market_packs where id = $1`, [p1.uid]))[0].status === 'replaced' &&
    (await status('SD01'))[1].status === 'replaced');
  // a business: a till sends; the business is the account
  const pb = makePack('AC02', [{ id: 'B1' }, { id: 'B2', currency: 'usd' }]);
  await sendAll('AC02', pb);
  const pbRow = (await q(`select business_id, vendor_id, device_vendor_id from cl_market_packs where id = $1`, [pb.uid]))[0];
  ok('a till\'s pack belongs to its business', pbRow.business_id === acme.business_id && pbRow.vendor_id === null && pbRow.device_vendor_id === ac2);
  ok('the main till sees the business\'s pack too', (await status('AC01'))[0].pack_uid === pb.uid && (await status('AC01'))[0].from_this_device === false);

  // ---- review ----
  const queue = j(await as(tok('REV'), `select public.cl_market_queue(null) j`));
  ok('the queue lists undecided packs with the account, RPN and paid days', queue.length === 2 && queue.some((x) => x.account === 'Single One' && x.rpn === 'Tendai' && x.available_days === 0) &&
    queue.some((x) => x.account === 'Acme' && x.products === 2), JSON.stringify(queue).slice(0, 400));
  ok('the queue: staff without a market module refused', /Not authorized/.test(j(await as(tok('NONE'), `select public.cl_market_queue(null) j`)).e || ''));
  const det = j(await as(tok('REV'), `select public.cl_market_pack_detail($1) j`, [pb.uid]));
  ok('opening a pack puts it in review; problems shown (bad currency)', det.pack.status === 'in_review' && det.items.find((i) => i.source_product_id === 'B2').problem === 'bad currency' &&
    det.items.find((i) => i.source_product_id === 'B1').has_thumb === true, JSON.stringify(det).slice(0, 400));
  const th = j(await as(tok('REV'), `select public.cl_market_pack_thumbs($1, 0, 50) j`, [pb.uid]));
  ok('thumbnails page by page (the thumbnail, not the full photo)', th.length === 2 && th[0].thumb === pb.thumbs.B1, JSON.stringify(th).slice(0, 200));
  const rej = j(await as(tok('REV'), `select public.cl_market_reject($1, 'TEST: blurry photos') j`, [pb.uid]));
  const stB = (await status('AC02'))[0];
  ok('PHOTOS: a replaced pack keeps only its checksums (photo data cleared)', JSON.stringify(await photoState(p1.uid)) === JSON.stringify({ n: 2, with_data: 0, with_thumb: 0, with_sha: 2 }));
  ok('PHOTOS: a rejected pack keeps only its checksums', JSON.stringify(await photoState(pb.uid)) === JSON.stringify({ n: 2, with_data: 0, with_thumb: 0, with_sha: 2 }) &&
    (await q(`select header->'listings'->0->>'image_sha256' s from cl_market_packs where id = $1`, [pb.uid]))[0].s === sha(pb.images.B1));
  ok('reject with a reason: the app sees "rejected" and why', rej.status === 'rejected' && stB.status === 'rejected' && stB.reason === 'TEST: blurry photos', JSON.stringify(stB));
  ok('a decided pack takes no more photos', /That pack was already rejected/.test((await image('AC02', pb, 'B1')).e || ''));
  // hand upload
  const hu = makePack('SD02', [{ id: 'H1' }], { v: 1 });
  const up = j(await as(tok('REV'), `select public.cl_market_upload_pack($1, $2, $3) j`, [hu.uid, hu.header, hu.sha]));
  const upi = j(await as(tok('REV'), `select public.cl_market_upload_image($1, 'H1', $2, null) j`, [hu.uid, hu.images.H1]));
  ok('hand upload of a v1 .scl: same checks, enters the queue as source console', up.status === 'receiving' && upi.status === 'received' &&
    (await q(`select source, format_version from cl_market_packs where id = $1`, [hu.uid]))[0].source === 'console');
  const unknown = makePack('ZZ99', [{ id: 'U1' }]);
  ok('hand upload: an unregistered install ID is refused', /isn't a registered device. Nothing was uploaded./.test(j(await as(tok('REV'), `select public.cl_market_upload_pack($1, $2, $3) j`, [unknown.uid, unknown.header, unknown.sha])).e || ''));

  // ---- tokens ----
  const sell = (k, biz, ven, qty) => as(tok(k), `select public.cl_sell_tokens($1, $2, $3, 'TEST') j`, [biz, ven, qty]).then(j);
  const bal = (biz, ven) => as(tok('TOK'), `select public.cl_token_balance($1, $2) j`, [biz, ven]).then(j);
  ok('selling: other staff refused', /Not authorized/.test((await sell('PUB', null, sd1, 3)).e || ''));
  ok('selling to a till of a business is refused (use the business)', /This device is a till of "Acme". Use the business./.test((await sell('TOK', null, ac2, 3)).e || ''));
  const s3 = await sell('TOK', null, sd1, 3);
  const ch = (await q(`select entry_type, amount::text, currency, notes, vendor_id from cl_ledger_entries where id = $1`, [s3.ledger_entry && s3.ledger_entry.id]))[0];
  ok('selling 3 tokens writes ONE ledger charge of 3 × USD 1.00, with the price snapshot', ch && ch.entry_type === 'charge' && ch.amount === '3.00' && ch.vendor_id === sd1 &&
    /^Tokens: 3 × USD 1\.00 \(3 days of listing\)/.test(ch.notes) && Number(s3.purchase.unit_price) === 1 && s3.purchase.days_per_token === 1, JSON.stringify([ch, s3]));
  ok('a double tap sells once', (await sell('TOK', null, sd1, 3)).duplicate === true && (await q(`select count(*)::int c from cl_token_purchases`))[0].c === 1);
  let b1 = await bal(null, sd1);
  ok('unpaid: 3 bought, 0 usable, "USD 3.00 for tokens unpaid"', b1.bought_tokens === 3 && b1.paid_tokens === 0 && b1.available_days === 0 && b1.blocked_by === 'USD 3.00 for tokens unpaid', JSON.stringify(b1));
  const pay = (vendor, amount) => as(tok('LED'), `select public.cl_record_ledger_payment($1, $2, 'USD', 'cash', null, $3, $4) j`, [vendor, amount, 'TEST ' + amount + ' ' + Math.random(), coa]).then(j);
  const py = await pay(sd1, 3);
  b1 = await bal(null, sd1);
  ok('paid: 3 usable days', b1.paid_tokens === 3 && b1.available_days === 3 && b1.blocked_by === null && b1.purchases[0].state === 'paid', JSON.stringify(b1));
  const com = (await q(`select rpn_id, kind, amount::text from cl_rpn_commissions where ledger_entry_id = $1`, [py.ledger_entry.id]))[0];
  ok('the token payment earns the RPN commission (existing trigger: onboarding 10%)', com && com.rpn_id === tendai && com.kind === 'onboarding' && com.amount === '0.30', JSON.stringify(com));
  // an older unpaid licence holds up newer tokens
  await q(`insert into cl_ledger_entries (vendor_id, entry_type, amount, currency, notes, recorded_by, created_at) values ($1, 'charge', 15, 'USD', 'Auto-charged: licence #1004 (30 days)', $2, now() - interval '1 day')`, [ac1, staff.SYS]);
  await sell('TOK', acme.business_id, null, 3);
  await pay(ac2, 3);
  let bb = await bal(acme.business_id, null);
  ok('oldest charges first: the payment covers the older licence first; "3 bought, 0 usable: USD 15.00 licence unpaid"', bb.bought_tokens === 3 && bb.paid_tokens === 0 &&
    bb.blocked_by === 'USD 15.00 licence unpaid' && bb.account === 'Acme', JSON.stringify(bb));
  await pay(ac1, 15);
  bb = await bal(acme.business_id, null);
  ok('... once the licence is paid too, the tokens are usable (the business\'s tills pay together)', bb.paid_tokens === 3 && bb.available_days === 3 && bb.blocked_by === null, JSON.stringify(bb));
  // price changes don't touch earlier sales; a credit cancels a sale
  ok('token price: SysAdmin only', /only a SysAdmin/.test(j(await as(tok('TOK'), `select public.cl_token_price_set(2, 1, 'USD', 0, null, null) j`)).e || ''));
  const np = j(await as(tok('SYS'), `select public.cl_token_price_set(2, 1, 'usd', 0, null, 'TEST price') j`));
  const s2 = await sell('TOK', null, sd2, 2);
  ok('a new price applies to new sales; earlier sales keep their price', Number(np.price.price_per_token) === 2 && Number(s2.purchase.unit_price) === 2 && Number(s2.purchase.amount) === 4 &&
    (await q(`select unit_price::text from cl_token_purchases where vendor_id = $1`, [sd1]))[0].unit_price === '1.00', JSON.stringify([np, s2]).slice(0, 300));
  await as(tok('LED'), `select public.cl_record_ledger_credit($1, 4, 'USD', 'TEST: sold in error', $2) j`, [sd2, s2.ledger_entry.id]);
  const b2 = await bal(null, sd2);
  ok('a credit for the whole token charge cancels the sale', b2.bought_tokens === 0 && b2.purchases[0].state === 'cancelled', JSON.stringify(b2));
  ok('the prices list shows the history', j(await as(tok('TOK'), `select public.cl_token_prices_list() j`)).prices.length === 2);

  // ---- publish ----
  const p2 = makePack('SD01', [{ id: 'C1' }, { id: 'C2' }, { id: 'C3', price: -1 }], { no: 'MKT0003' });
  await sendAll('SD01', p2);
  const prep = (k, pk, days, items) => as(tok(k), `select public.cl_market_publish_prepare($1, $2, $3) j`, [pk.uid, days, items]).then(j);
  ok('publish: Market Review alone can\'t', /Not authorized/.test((await prep('REV', p2, 3, ['C1'])).e || ''));
  ok('publish: a product with a problem must be unticked', /Untick the products with problems: Product 2 \(bad price\)/.test((await prep('PUB', p2, 3, ['C1', 'C3'])).e || ''));
  ok('publish: more days than are paid is refused, plainly', /Not enough paid listing days: 3 paid and unused, 5 needed\. Sell tokens and record the payment first\./.test((await prep('PUB', p2, 5, ['C1'])).e || ''));
  const pr = await prep('PUB', p2, 3, ['C1', 'C2']);
  ok('prepare: the photos to copy and the iTred identity', pr.photos && pr.photos.length === 2 && pr.itred_install_id === 'SD01' && pr.available_days === 3, JSON.stringify(pr).slice(0, 300));
  const imgData = j(await as(tok('PUB'), `select public.cl_market_pack_image_data($1, 'C1') j`, [p2.uid]));
  ok('the photo data is there for the Edge Function (Market Publishing only)', imgData.image === p2.images.C1 && imgData.thumb === p2.thumbs.C1 &&
    /Not authorized/.test(j(await as(tok('REV'), `select public.cl_market_pack_image_data($1, 'C1') j`, [p2.uid])).e || ''));
  const fileUrl = (pk, id, t) => BUCKET_URL + 'SD01/' + sha(pk.images[id]) + (t ? '-t' : '') + '.webp';
  const urls = { C1: { image_url: fileUrl(p2, 'C1'), thumb_url: fileUrl(p2, 'C1', true) }, C2: { image_url: fileUrl(p2, 'C2'), thumb_url: fileUrl(p2, 'C2', true) } };
  const attach = (k, pk, days, items, u) => as(tok(k), `select public.cl_market_publish_attach($1, $2, $3, $4) j`, [pk.uid, days, items, JSON.stringify(u || urls)]).then(j);
  const t0 = Date.now();
  const at = await attach('PUB', p2, 3, ['C1', 'C2']);
  const exp = Date.parse(at.expires_at);
  ok('published: 2 listings; expires_at = now + 3 days; 3 days used; 0 left', at.published === 2 && Math.abs(exp - (t0 + 3 * 86400000)) < 60000 && at.days_used === 3 && at.available_after === 0, JSON.stringify(at));
  const pubRows = await as(null, `select product_name, image_url, thumb_url, expires_at from vendor_listings where status = 'published' and expires_at > now()`);
  ok('the public (iTred) read sees them, with photo and thumbnail URLs', pubRows.r && pubRows.r.length === 2 && pubRows.r.every((x) => x.thumb_url && x.image_url), JSON.stringify(pubRows).slice(0, 300));
  ok('PHOTOS: once published (the photos are in Storage), the pack keeps only its checksums', JSON.stringify(await photoState(p2.uid)) === JSON.stringify({ n: 3, with_data: 0, with_thumb: 0, with_sha: 3 }) ||
    JSON.stringify(await photoState(p2.uid)) === JSON.stringify({ n: 2, with_data: 0, with_thumb: 0, with_sha: 2 }), JSON.stringify(await photoState(p2.uid)));
  ok('PHOTOS: nothing to delete from the bucket on a first publish', at.photos_to_delete === 0 && (await q(`select count(*)::int c from cl_listing_photo_trash`))[0].c === 0);
  ok('a double click publishes once', (await attach('PUB', p2, 3, ['C1', 'C2'])).duplicate === true && (await q(`select count(*)::int c from vendor_listings where pack_id = $1`, [p2.uid]))[0].c === 2 &&
    (await bal(null, sd1)).used_days === 3);
  const st2 = (await status('SD01'))[0];
  ok('the app sees "published" with the expiry', st2.status === 'published' && st2.published_count === 2 && Math.abs(Date.parse(st2.expires_at) - exp) < 1000, JSON.stringify(st2));
  // republish while live: replaces the listing, keeps the expiry, uses no days
  const p3 = makePack('SD01', [{ id: 'D1' }], { no: 'MKT0004' });
  await sendAll('SD01', p3);
  const at3 = await attach('PUB', p3, 0, ['D1'], { D1: { image_url: urls.C1.image_url, thumb_url: urls.C1.thumb_url } });
  const trash1 = (await q(`select path, reason from cl_listing_photo_trash where done_at is null order by path`)).map((r) => r.path);
  ok('PHOTOS: a replaced listing\'s files are queued for deletion from the bucket, except a file the new listing still uses',
    at3.photos_to_delete === 2 && JSON.stringify(trash1) === JSON.stringify(['SD01/' + sha(p2.images.C2) + '-t.webp', 'SD01/' + sha(p2.images.C2) + '.webp'].sort()), JSON.stringify([at3, trash1]));
  const tl = j(await as(tok('PUB'), `select public.cl_market_photo_trash(100) j`));
  ok('PHOTOS: the Edge Function reads the queue (Market Publishing only) and marks files done', tl.length === 2 &&
    /Not authorized/.test(j(await as(tok('REV'), `select public.cl_market_photo_trash(100) j`)).e || '') &&
    (await as(tok('PUB'), `select public.cl_market_photo_trash_done($1) j`, ['{' + tl.map((x) => x.id).join(',') + '}'])).r[0].j === 2 &&
    j(await as(tok('PUB'), `select public.cl_market_photo_trash(100) j`)).length === 0);
  const live3 = { r: await q(`select l.product_name from vendor_listings l join vendors v on v.id = l.vendor_id where v.install_id = 'SD01' and l.status = 'published' and l.expires_at > now()`) };
  ok('republish while live: the whole listing is replaced, the expiry carries over, no days used', at3.published === 1 && Math.abs(Date.parse(at3.expires_at) - exp) < 1000 && at3.days_used === 0 &&
    live3.r.length === 1 && (await q(`select status from cl_market_packs where id = $1`, [p2.uid]))[0].status === 'replaced', JSON.stringify([at3, live3]));
  // extend, unpublish
  const iv = (await q(`select id from vendors where install_id = 'SD01'`))[0].id;
  ok('extend with no paid days left is refused', /Not enough paid listing days: 0 paid and unused, 2 needed/.test(j(await as(tok('PUB'), `select public.cl_market_extend($1, 2, null) j`, [iv])).e || ''));
  await sell('TOK', null, sd1, 4); await pay(sd1, 8);
  const ex = j(await as(tok('PUB'), `select public.cl_market_extend($1, 2, 'TEST') j`, [iv]));
  ok('extend adds the days to every live row', Math.abs(Date.parse(ex.expires_at) - (exp + 2 * 86400000)) < 1000 &&
    (await q(`select count(*)::int c from vendor_listings where vendor_id = $1 and status = 'published' and abs(extract(epoch from expires_at - $2::timestamptz)) < 1`, [iv, ex.expires_at]))[0].c === 1, JSON.stringify(ex));
  const unp = j(await as(tok('PUB'), `select public.cl_market_unpublish($1, 'TEST: closing for the holidays') j`, [iv]));
  ok('PHOTOS: unpublish queues the listing\'s files for deletion', unp.photos_to_delete === 2 &&
    JSON.stringify((await q(`select path from cl_listing_photo_trash where done_at is null order by path`)).map((r) => r.path)) === JSON.stringify([urls.C1.thumb_url, urls.C1.image_url].map((u) => u.slice(BUCKET_URL.length)).sort()), JSON.stringify(unp));
  const bAfter = await bal(null, sd1);
  ok('unpublish: off the Market Place now, the unused whole days come back (4)', unp.days_back === 4 && bAfter.available_days === 4 + 2 &&
    (await as(null, `select count(*)::int c from vendor_listings where vendor_id = $1`, [iv])).r[0].c === 0 && (await status('SD01'))[0].status === 'unpublished', JSON.stringify([unp, bAfter]));
  // a business publishes under its main till's identity, even when a till sent the pack
  const pb2 = makePack('AC02', [{ id: 'E1' }], { no: 'MKT0009' });
  await sendAll('AC02', pb2);
  const atb = await attach('PUB', pb2, 1, ['E1'], { E1: { image_url: 'https://x/e1.webp', thumb_url: null } });
  ok('one iTred vendor per business: the main till\'s install ID (AC01), named after the business', atb.published === 1 &&
    JSON.stringify(await q(`select install_id, business_name from vendors where id = (select itred_vendor_id from cl_market_packs where id = $1)`, [pb2.uid])) === JSON.stringify([{ install_id: 'AC01', business_name: 'Acme' }]));
  // expiry
  await q(`update vendor_listings set expires_at = now() - interval '1 minute' where pack_id = $1`, [pb2.uid]);
  await q(`update cl_market_packs set expires_at = now() - interval '1 minute' where id = $1`, [pb2.uid]);
  ok('expired: hidden from the public read, and the app says "expired"', (await as(null, `select count(*)::int c from vendor_listings where pack_id = $1`, [pb2.uid])).r[0].c === 0 &&
    (await status('AC02'))[0].status === 'expired');
  // welcome days (off by default; the owner can turn them on)
  const p4 = makePack('SD03', [{ id: 'W1' }]);
  await sendAll('SD03', p4);
  ok('no welcome days by default: an account with no tokens can\'t publish', /Not enough paid listing days: 0 paid and unused, 2 needed/.test((await prep('PUB', p4, 2, ['W1'])).e || ''));
  await new Promise((r) => setTimeout(r, 1100));
  await as(tok('SYS'), `select public.cl_token_price_set(2, 1, 'USD', 2, null, 'TEST welcome') j`);
  const atw = await attach('PUB', p4, 2, ['W1'], { W1: { image_url: 'https://x/w1.webp', thumb_url: null } });
  const bw = await bal(null, sd3);
  ok('with welcome days set to 2, a new account gets them once', atw.published === 1 && bw.used_days === 0 && bw.available_days === 0 &&
    (await q(`select count(*)::int c from cl_token_uses where vendor_id = $1 and kind = 'welcome' and days = -2`, [sd3]))[0].c === 1, JSON.stringify([atw, bw]));
  // the old portal's path still gets 7 days
  const oldRow = (await q(`insert into vendor_listings (vendor_id, product_name, price, exported_at, published_at, status) values ($1, 'Old portal', 1, now(), now(), 'published') returning expires_at - published_at d`, [iv]))[0];
  ok('a publish that gives no expiry (the old portal) still gets 7 days', oldRow.d && (oldRow.d.days === 7 || /7 days/.test(JSON.stringify(oldRow.d))), JSON.stringify(oldRow));

  // undecided over 14 days: closed and cleared at the next send
  const old = makePack('SD02', [{ id: 'O1' }]);
  await sendAll('SD02', old);
  await q(`update cl_market_packs set created_at = now() - interval '15 days' where id = $1`, [old.uid]);
  await submit('SD01', makePack('SD01', [{ id: 'O2', photo: false }], { no: 'MKT0010' }));   // any send runs the clean-up
  const staleRow = (await q(`select status, reason from cl_market_packs where id = $1`, [old.uid]))[0];
  ok('PHOTOS: a pack left undecided over 14 days is closed ("Not reviewed within 14 days") and its photo data cleared',
    staleRow.status === 'rejected' && /Not reviewed within 14 days/.test(staleRow.reason) && (await photoState(old.uid)).with_data === 0, JSON.stringify(staleRow));

  // ---- who may ----
  ok('anonymous calls to staff functions are refused', /permission denied/.test(j(await as(null, `select public.cl_market_queue(null) j`)).e || ''));
  ok('the new tables can\'t be read through the API', /permission denied/.test((await as(tok('SYS'), `select * from cl_market_pack_images`)).e || '') &&
    /permission denied/.test((await as(tok('SYS'), `select * from cl_token_purchases`)).e || ''));
  ok('an RPN token can\'t sell or publish', /Not authorized/.test(j(await as({ role: 'authenticated', sub: tendai, user_type: 'rpn' }, `select public.cl_sell_tokens(null, $1, 1, null) j`, [sd1])).e || ''));

  // ---- delete guards ----
  const dg = await tryQ(`delete from cl_vendors where id = $1`, [sd2]);
  ok('a vendor with a pack or a token purchase can\'t be deleted: plain message', /market pack/.test(dg.e || '') && /token purchase/.test(dg.e || ''), dg.e);

  // ---- rollback ----
  e = null; try { await pg.exec(RB); } catch (x) { e = x.message; } await pg.exec('rollback').catch(() => {});
  ok('the rollback refuses while token purchases or published packs exist, changing nothing', /rollback aborted: token purchases or published packs exist/.test(e || ''), e);
  await q(`delete from vendor_listings where pack_id is not null or product_name = 'Old portal'`);
  await q(`delete from cl_token_uses`); await q(`delete from cl_market_packs`); await q(`delete from cl_token_purchases`);
  await pg.exec(RB);
  const d = diff(before, fingerprint(await snapshot(q)));
  ok('with none, the rollback restores the exact pre-migration catalogue (expiry trigger, delete guards, grants)', !d.onlyA.length && !d.onlyB.length && !d.changed.length, JSON.stringify(d).slice(0, 600));
  e = null; try { await pg.exec(MIG); } catch (x) { e = x.message; }
  ok('and the migration applies again after a rollback', !e, e);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
