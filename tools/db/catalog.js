// Catalogue snapshot of the objects we own in a Postgres database (the live
// Supabase project or a PGlite rebuild), in a few bulk queries, plus a
// normalised fingerprint for comparing two databases.
//
//   const { snapshot, fingerprint } = require('./catalog');
//   const snap = await snapshot(q);   // q(sql) -> rows; read-only queries only
//
// "Ours" = schema public, plus triggers we put on Supabase-managed tables.
// Objects that belong to an extension (pg_depend deptype 'e') are left out.
// No table data is read.
'use strict';
const crypto = require('crypto');

const ROLES = ['public', 'anon', 'authenticated', 'service_role'];   // grantees we manage
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
const crlf = (s) => (s == null ? s : String(s).replace(/\r\n?/g, '\n'));

// Privileges as [{p: privilege, g: grantee ('public' for PUBLIC), o: grant option}];
// a NULL acl means the built-in default for that object kind and owner.
const ACL = (col, kindExpr, ownerExpr) => `(select coalesce(json_agg(json_build_object('p', a.privilege_type, 'g', case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end, 'o', a.is_grantable) order by a.privilege_type, a.grantee), '[]')
  from aclexplode(coalesce(${col}, acldefault((${kindExpr})::"char", ${ownerExpr}))) a)`;

async function snapshot(q) {
  const s = {};
  s.server = (await q(`select current_setting('server_version') v`))[0].v;
  s.schemas = await q(`select n.nspname, pg_get_userbyid(n.nspowner) owner from pg_namespace n
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' order by 1`);
  s.extensions = await q(`select e.extname, e.extversion, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1`);

  s.relations = await q(`select c.relname, c.relkind::text kind, pg_get_userbyid(c.relowner) owner, c.relrowsecurity rls, c.relforcerowsecurity force_rls,
      obj_description(c.oid, 'pg_class') comment, c.reloptions,
      ${ACL('c.relacl', "case when c.relkind = 'S' then 's' else 'r' end", 'c.relowner')} acl,
      case when c.relkind in ('v','m') then pg_get_viewdef(c.oid) end viewdef
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','S','f')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
    order by 1`);

  s.columns = await q(`select c.relname tbl, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) type, a.attnotnull as not_null,
      pg_get_expr(ad.adbin, ad.adrelid) "default", a.attidentity::text ident, a.attgenerated::text gen,
      case when a.attcollation <> t.typcollation then (select collname from pg_collation where oid = a.attcollation) end collation,
      col_description(c.oid, a.attnum) comment,
      (select coalesce(json_agg(json_build_object('p', x.privilege_type, 'g', case when x.grantee = 0 then 'public' else pg_get_userbyid(x.grantee) end, 'o', x.is_grantable) order by x.privilege_type, x.grantee), '[]')
         from aclexplode(a.attacl) x) acl
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_type t on t.oid = a.atttypid
      left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped
    order by 1, 2`);

  s.constraints = await q(`select c.relname tbl, k.conname, k.contype::text type, pg_get_constraintdef(k.oid) def,
      case when k.confrelid <> 0 then k.confrelid::regclass::text end refs, obj_description(k.oid, 'pg_constraint') comment
    from pg_constraint k join pg_class c on c.oid = k.conrelid
    where c.relnamespace = 'public'::regnamespace
      and k.contype <> 'n'   -- Postgres 18 lists NOT NULL here too; columns.not_null already has it
    order by 1, 2`);

  s.indexes = await q(`select t.relname tbl, i.relname, pg_get_indexdef(x.indexrelid) def,
      exists (select 1 from pg_constraint k where k.conindid = x.indexrelid) constraint_backed, obj_description(i.oid, 'pg_class') comment
    from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class t on t.oid = x.indrelid
    where t.relnamespace = 'public'::regnamespace order by 1, 2`);

  s.sequences = await q(`select c.relname, format_type(s.seqtypid, null) type, s.seqstart start, s.seqincrement inc, s.seqmin min, s.seqmax max,
      s.seqcache cache, s.seqcycle cycle,
      (select t.relname || '.' || a.attname from pg_depend d join pg_class t on t.oid = d.refobjid
         join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
       where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a','i')) owned_by
    from pg_sequence s join pg_class c on c.oid = s.seqrelid where c.relnamespace = 'public'::regnamespace order by 1`);

  s.types = await q(`select t.typname, t.typtype::text kind,
      (select array_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) labels,
      case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end base,
      case when t.typtype = 'c' then (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
        from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0) end attrs,
      obj_description(t.oid, 'pg_type') comment
    from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype in ('e','d','c','r')
      and (t.typtype <> 'c' or (select relkind from pg_class where oid = t.typrelid) = 'c')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
    order by 1`);

  s.functions = await q(`select p.proname, pg_get_function_identity_arguments(p.oid) args, p.oid::regprocedure::text sig,
      pg_get_function_result(p.oid) result, p.prokind::text kind, l.lanname lang, p.prosecdef secdef, p.provolatile::text volatile,
      p.proconfig config, pg_get_userbyid(p.proowner) owner, p.prosrc src, pg_get_functiondef(p.oid) def,
      obj_description(p.oid, 'pg_proc') comment,
      ${ACL('p.proacl', "'f'", 'p.proowner')} acl
    from pg_proc p join pg_language l on l.oid = p.prolang
    where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p','w')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    order by 1, 2`);

  s.triggers = await q(`select n.nspname schema, c.relname tbl, t.tgname, pg_get_triggerdef(t.oid) def, t.tgenabled::text enabled,
      t.tgfoid::regprocedure::text func
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_proc f on f.oid = t.tgfoid
    where not t.tgisinternal and (n.nspname = 'public' or f.pronamespace = 'public'::regnamespace)
    order by 1, 2, 3`);

  s.policies = await q(`select tablename tbl, policyname, permissive, roles::text[] roles, cmd, qual, with_check
    from pg_policies where schemaname = 'public' order by 1, 2`);

  // Supabase-managed things that point at ours (reported, never recreated)
  s.foreignRefs = await q(`select c.relname tbl, k.conname, k.confrelid::regclass::text refs
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_class r on r.oid = k.confrelid
    where c.relnamespace = 'public'::regnamespace and r.relnamespace <> 'public'::regnamespace order by 1, 2`);
  s.publications = await q(`select p.pubname, c.relname from pg_publication p join pg_publication_rel pr on pr.prpubid = p.oid
    join pg_class c on c.oid = pr.prrelid where c.relnamespace = 'public'::regnamespace order by 1, 2`);
  s.defaultAcl = await q(`select pg_get_userbyid(d.defaclrole) role, coalesce(n.nspname, '*') schema, d.defaclobjtype::text objtype, d.defaclacl::text acl
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by 1, 2, 3`);
  // A column label that is a keyword (e.g. NOTNULL) silently becomes "?column?": refuse it.
  for (const [k, rows] of Object.entries(s)) {
    if (Array.isArray(rows) && rows.some((r) => '?column?' in r)) throw new Error('catalog query "' + k + '" has an unnamed column');
  }
  return s;
}

// Normalised, comparable view: object -> attributes (owners and OIDs left out;
// grants only for the roles we manage).
function fingerprint(s) {
  const f = {};
  const put = (k, v) => { f[k] = typeof v === 'string' ? v : JSON.stringify(v); };
  const acl = (a) => (a || []).filter((x) => ROLES.includes(x.g)).map((x) => x.g + ':' + x.p + (x.o ? '*' : '')).sort();
  for (const r of s.relations) {
    put(`rel ${r.relname}`, { kind: r.kind, rls: r.rls, force_rls: r.force_rls, comment: crlf(r.comment), view: r.viewdef ? md5(crlf(r.viewdef).trim()) : null });
    put(`grant rel ${r.relname}`, acl(r.acl));
  }
  for (const c of s.columns) {
    put(`col ${c.tbl}.${c.attname}`, { type: c.type, not_null: c.not_null, default: c.default, ident: c.ident, gen: c.gen, collation: c.collation, comment: crlf(c.comment) });
    const a = acl(c.acl); if (a.length) put(`grant col ${c.tbl}.${c.attname}`, a);
  }
  for (const k of s.constraints) put(`con ${k.tbl}.${k.conname}`, { type: k.type, def: k.def });
  for (const i of s.indexes) put(`idx ${i.relname}`, { tbl: i.tbl, def: i.def });
  for (const q of s.sequences) put(`seq ${q.relname}`, { type: q.type, start: String(q.start), inc: String(q.inc), owned_by: q.owned_by });
  for (const t of s.types) put(`type ${t.typname}`, { kind: t.kind, labels: t.labels, base: t.base, attrs: t.attrs });
  for (const p of s.functions) {
    put(`fn ${p.proname}(${p.args})`, { result: p.result, kind: p.kind, lang: p.lang, secdef: p.secdef, volatile: p.volatile,
      config: p.config, body_md5: md5(crlf(p.src)), comment: crlf(p.comment) });
    put(`grant fn ${p.proname}(${p.args})`, acl(p.acl));
  }
  for (const t of s.triggers) put(`trg ${t.schema}.${t.tbl}.${t.tgname}`, { def: t.def, enabled: t.enabled });
  for (const p of s.policies) put(`pol ${p.tbl}.${p.policyname}`, { permissive: p.permissive, roles: [...p.roles].sort(), cmd: p.cmd, qual: p.qual, with_check: p.with_check });
  return f;
}

function diff(a, b) {   // a, b: fingerprints -> { onlyA, onlyB, changed }
  const onlyA = [], onlyB = [], changed = [];
  for (const k of Object.keys(a)) if (!(k in b)) onlyA.push(k); else if (a[k] !== b[k]) changed.push({ key: k, a: a[k], b: b[k] });
  for (const k of Object.keys(b)) if (!(k in a)) onlyB.push(k);
  return { onlyA: onlyA.sort(), onlyB: onlyB.sort(), changed };
}

module.exports = { snapshot, fingerprint, diff, ROLES, md5, crlf };
