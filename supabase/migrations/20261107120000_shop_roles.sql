-- =====================================================================
-- Branches step 3: shop roles and staff (owner, 2026-10-16: "go step 3
-- (Roles). Name the migration 20261107120000_shop_roles"). Applied live only
-- after the owner has seen this file and said "apply".
-- Design: docs/branches/multi-branch-visibility-design.md, addendum §R8
-- (rights, default roles, sync, sign-in, moving existing staff), §R4 (other
-- branches' reports by right), Q1, Q2, Q7.
-- Rollback: supabase/rollbacks/20261107120000_shop_roles.rollback.sql
-- Tested in PGlite: supabase/tests/shop-roles-test.js (and the app's
-- test/shop-roles.test.js against this SQL)
--
-- Shop staff and roles become business-wide, kept on seiGEN and pulled by
-- every till. The names avoid the Console's own cl_staff tables.
--   cl_shop_roles            Owner, Admin, Manager, Stores, Cashier (built in,
--                            made for every business that needs them) and
--                            custom roles; each a list of rights
--   cl_shop_staff            a person: name, role, home branch (+ other
--                            branches), active; the PIN as a bcrypt hash (the
--                            server's own check) and as a PBKDF2 check value
--                            (salt, check, rounds) that the tills of the
--                            person's branches get for signing in offline;
--                            legacy_pins: a till's own old PIN hashes, each
--                            usable only on the till it came from, until the
--                            person signs in there and the PIN is set again
--   cl_shop_staff_sessions   a signed-in person on one till: a random token
--                            (only its SHA-256 kept), 12 hours, revoked at
--                            sign-out or when the person is switched off
--   cl_shop_staff_signin_fails  5 wrong PINs per person in 15 minutes, then wait
--   cl_shop_legacy_uploads   which till has sent its old staff list (once)
--   cl_shop_meta             legacy_cutoff: tills registered after this
--                            migration have no old staff list to send
--
-- Device functions (the till's key as always, plus a staff token where a
-- person's right is needed):
--   cl_device_staff_pull       the roles and the staff; check values only for
--                              the staff allowed at the caller's branch
--   cl_device_staff_upload     a till's old staff list, once (main branch
--                              first): Admin -> Admin, Cashier -> Cashier,
--                              Cashier with "Create customers" -> the custom
--                              role "Cashier + customers"; the same name at the
--                              same branch from another till is one person
--                              whose PINs both keep working on their own tills
--   cl_device_staff_signin     the PIN against seiGEN's copy -> a token
--   cl_device_staff_signout
--   cl_device_staff_set_pin    the person's own PIN (or by a holder of Staff)
--   cl_device_staff_save       add or change a person (needs Staff; the very
--                              first manager of a business may be added on a
--                              main-branch till while nobody holds Staff)
--   cl_device_role_save        add, change or delete a role (needs Staff;
--                              Owner-only: deleting a role, giving or taking
--                              the Owner role; Admins keep these until the
--                              business has an Owner; the last Owner stays)
--   cl_device_branch_report    another branch's inventory, dispatches or
--                              supplier GRVs: needs "View other branches'
--                              reports"; costs only with "View costs"
--   cl_device_dispatch_costs   one DN's unit costs and inter-branch charge:
--                              needs "View costs"
-- Nothing here changes stock, sales or customers. A till that sends no token
-- gets exactly what it got before (quantities, its own branch).
-- The business merge moves the staff and the custom roles (built-in roles
-- map onto the other business's); the business delete guard counts staff.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'function cl_dispatch_caller (20261017120000)' n where to_regprocedure('public.cl_dispatch_caller(text,text,text)') is null
    union all select 'function cl_business_merge_core (20261021120000)' where to_regprocedure('public.cl_business_merge_core(uuid,uuid,text,boolean,uuid)') is null
    union all select 'function cl_business_delete_guard (20261019120000)' where to_regprocedure('public.cl_business_delete_guard()') is null
    union all select 'function cl_device_dispatch_card (20261106120000)' where to_regprocedure('public.cl_device_dispatch_card(text,text,text,uuid)') is null
    union all select 'pgcrypto (extensions.crypt)' where to_regprocedure('extensions.crypt(text,text)') is null
    union all select 'table cl_till_stock_levels (20261024120000)' where to_regclass('public.cl_till_stock_levels') is null
  ) x;
  if missing is not null then raise exception 'shop_roles aborted: missing %. Nothing was changed.', missing; end if;
  select string_agg(n, ', ') into conflicts from (
    select 'table ' || c.relname n from pg_class c where c.relnamespace = 'public'::regnamespace
      and c.relname in ('cl_shop_roles', 'cl_shop_staff', 'cl_shop_staff_sessions', 'cl_shop_staff_signin_fails', 'cl_shop_legacy_uploads', 'cl_shop_meta', 'cl_shop_seq')
    union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace and proname like 'cl\_shop\_%'
    union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cl_staff_has', 'cl_device_staff_pull', 'cl_device_staff_upload', 'cl_device_staff_signin', 'cl_device_staff_signout',
                      'cl_device_staff_set_pin', 'cl_device_staff_save', 'cl_device_role_save', 'cl_device_branch_report', 'cl_device_dispatch_costs')
  ) x;
  if conflicts is not null then raise exception 'shop_roles aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;

-- 1. Tables ---------------------------------------------------------------
create sequence public.cl_shop_seq;

create table public.cl_shop_roles (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.cl_businesses(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 40),
  builtin text check (builtin in ('owner', 'admin', 'manager', 'stores', 'cashier')),
  rights text[] not null default '{}',
  change_seq bigint not null default nextval('public.cl_shop_seq'),
  updated_at timestamptz not null default now(),
  updated_by text
);
create unique index cl_shop_roles_name on public.cl_shop_roles (business_id, lower(btrim(name)));
create unique index cl_shop_roles_builtin on public.cl_shop_roles (business_id, builtin) where builtin is not null;

create table public.cl_shop_staff (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.cl_businesses(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  role_id uuid not null references public.cl_shop_roles(id),
  home_branch_id uuid references public.cl_branches(id) on delete set null,
  other_branches uuid[] not null default '{}',
  active boolean not null default true,
  pin_salt text, pin_check text, pin_rounds integer, pin_bcrypt text, pin_changed_at timestamptz,
  legacy_pins jsonb not null default '[]',
  change_seq bigint not null default nextval('public.cl_shop_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  created_terminal uuid references public.cl_terminals(id) on delete set null
);
create index cl_shop_staff_business on public.cl_shop_staff (business_id);
create index cl_shop_staff_role on public.cl_shop_staff (role_id);

create table public.cl_shop_staff_sessions (
  token_hash text primary key,
  staff_id uuid not null references public.cl_shop_staff(id) on delete cascade,
  terminal_id uuid not null references public.cl_terminals(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index cl_shop_staff_sessions_staff on public.cl_shop_staff_sessions (staff_id);

create table public.cl_shop_staff_signin_fails (
  id bigint generated always as identity primary key,
  staff_id uuid not null references public.cl_shop_staff(id) on delete cascade,
  terminal_id uuid references public.cl_terminals(id) on delete set null,
  at timestamptz not null default now()
);
create index cl_shop_staff_signin_fails_staff on public.cl_shop_staff_signin_fails (staff_id, at);

create table public.cl_shop_legacy_uploads (
  terminal_id uuid primary key references public.cl_terminals(id) on delete cascade,
  uploaded_at timestamptz not null default now(),
  staff integer not null default 0
);

create table public.cl_shop_meta (
  k text primary key,
  v timestamptz not null
);
insert into public.cl_shop_meta (k, v) values ('legacy_cutoff', now());

-- 2. Rights and the built-in roles (§R8, owner 2026-10-14 Q1) ----------------
-- Menus (a menu without its right is hidden) and actions.
create function public.cl_shop_rights_all() returns text[]
language sql immutable as $$
  select array['m.sell', 'm.products', 'm.credit', 'm.reports', 'm.marketing',
               'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming',
               'm.productlist', 'm.stocktake', 'm.requests', 'm.purchasing', 'm.reportwriter', 'm.directory',
               'm.settings', 'm.staff', 'm.terminals', 'm.eod',
               'costs', 'edit_prices', 'create_customers', 'review_requisitions', 'other_branches',
               'approve_writeoffs', 'void_return', 'credit_over_limit', 'sales_reports',
               'owner']::text[]
$$;
create function public.cl_shop_default_rights(p_builtin text) returns text[]
language sql immutable as $$
  select case p_builtin
    when 'owner' then public.cl_shop_rights_all()
    when 'admin' then array_remove(public.cl_shop_rights_all(), 'owner')
    when 'manager' then array['m.sell', 'm.products', 'm.credit', 'm.reports', 'm.marketing', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming',
                              'm.productlist', 'm.stocktake', 'm.requests', 'm.purchasing', 'm.reportwriter', 'm.directory', 'm.eod',
                              'costs', 'edit_prices', 'create_customers', 'review_requisitions', 'other_branches',
                              'approve_writeoffs', 'void_return', 'credit_over_limit', 'sales_reports']::text[]
    when 'stores' then array['m.products', 'm.dispatch', 'm.receive', 'm.adjust', 'm.incoming', 'm.productlist', 'm.stocktake',
                             'm.purchasing', 'm.reports', 'm.reportwriter']::text[]
    when 'cashier' then array['m.sell', 'm.credit', 'm.productlist', 'm.directory', 'm.requests', 'm.reports', 'm.eod', 'sales_reports']::text[]
  end
$$;
create function public.cl_shop_ensure_roles(p_business uuid) returns void
language sql security definer set search_path = public as $$
  insert into cl_shop_roles (business_id, name, builtin, rights, updated_by)
  select p_business, v.n, v.b, cl_shop_default_rights(v.b), 'seiGEN'
    from (values ('Owner', 'owner', 1), ('Admin', 'admin', 2), ('Manager', 'manager', 3), ('Stores', 'stores', 4), ('Cashier', 'cashier', 5)) v(n, b, o)
   where not exists (select 1 from cl_shop_roles r where r.business_id = p_business and r.builtin = v.b)
   order by v.o
  on conflict do nothing
$$;
-- Owner-only items: an Owner; or an Admin while the business has no active Owner (Q2).
create function public.cl_shop_owner_ok(p_business uuid, p_builtin text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_builtin, '') = 'owner'
      or (coalesce(p_builtin, '') = 'admin' and not exists (
            select 1 from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id
             where s.business_id = p_business and s.active and r.builtin = 'owner'))
$$;
create function public.cl_shop_effective_rights(p_role public.cl_shop_roles) returns text[]
language sql stable security definer set search_path = public as $$
  select case when cl_shop_owner_ok(p_role.business_id, p_role.builtin) and not ('owner' = any(p_role.rights))
              then p_role.rights || 'owner'::text else p_role.rights end
$$;

-- 3. Sessions: who is signed in on a till, and what they may do -----------------
create function public.cl_shop_session(p_token text, p_terminal uuid)
returns table (staff_id uuid, business_id uuid, name text, builtin text, rights text[])
language sql stable security definer set search_path = public as $$
  select s.id, s.business_id, s.name, r.builtin, cl_shop_effective_rights(r)
    from cl_shop_staff_sessions x
    join cl_shop_staff s on s.id = x.staff_id
    join cl_shop_roles r on r.id = s.role_id
    join cl_terminals t on t.id = x.terminal_id
   where p_token is not null and length(p_token) between 32 and 128
     and x.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
     and x.terminal_id = p_terminal and x.revoked_at is null and x.expires_at > now()
     and s.active and t.active and t.business_id = s.business_id
     and (t.branch_id = s.home_branch_id or t.branch_id = any(s.other_branches))
$$;
create function public.cl_staff_has(p_token text, p_terminal uuid, p_right text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from cl_shop_session(p_token, p_terminal) s where p_right = any(s.rights))
$$;

-- 4. JSON for the tills ------------------------------------------------------------
create function public.cl_shop_role_json(r public.cl_shop_roles) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('id', r.id, 'name', r.name, 'builtin', r.builtin, 'rights', to_jsonb(r.rights), 'seq', r.change_seq)
$$;
-- p_branch / p_terminal: the caller's. PIN check values only for the staff
-- allowed at the caller's branch; an old PIN only to the till it came from.
create function public.cl_shop_staff_json(s public.cl_shop_staff, p_branch uuid, p_terminal uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'role_id', s.role_id, 'home_branch_id', s.home_branch_id,
           'home_branch', (select b.name from cl_branches b where b.id = s.home_branch_id),
           'other_branches', to_jsonb(s.other_branches), 'active', s.active, 'seq', s.change_seq,
           'has_pin', s.pin_check is not null or jsonb_array_length(s.legacy_pins) > 0,
           'pins_from_tills', jsonb_array_length(s.legacy_pins),
           'here', s.active and (p_branch = s.home_branch_id or p_branch = any(s.other_branches)))
      || case when s.active and (p_branch = s.home_branch_id or p_branch = any(s.other_branches)) then
           jsonb_build_object('pin_salt', s.pin_salt, 'pin_check', s.pin_check, 'pin_rounds', s.pin_rounds,
             'legacy', (select coalesce(jsonb_agg(jsonb_build_object('salt', e->>'salt', 'hash', e->>'hash')), '[]'::jsonb)
                          from jsonb_array_elements(s.legacy_pins) e where e->>'terminal_id' = p_terminal::text))
         else '{}'::jsonb end
$$;

-- 5. The roles and the staff, for every till of the business -----------------------
create function public.cl_device_staff_pull(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_main boolean; v_upload text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select is_main into v_main from cl_branches where id = me.branch_id;
  if coalesce(v_main, false) then perform cl_shop_ensure_roles(me.business_id); end if;   -- a main-branch till makes the built-in roles
  v_upload := case
    when exists (select 1 from cl_shop_legacy_uploads u where u.terminal_id = me.id) then 'done'
    when me.registered_ts > (select v from cl_shop_meta where k = 'legacy_cutoff') then 'not_needed'
    when not exists (select 1 from cl_shop_roles r where r.business_id = me.business_id) and not coalesce(v_main, false) then 'wait_main'
    else 'ready' end;
  return json_build_object('server_time', now(), 'branch_id', me.branch_id, 'terminal_id', me.id, 'is_main', v_main, 'upload', v_upload,
    'branches', coalesce((select json_agg(json_build_object('id', b.id, 'name', b.name, 'is_main', b.is_main) order by b.is_main desc, b.name)
                          from cl_branches b where b.business_id = me.business_id), '[]'::json),
    'roles', coalesce((select json_agg(cl_shop_role_json(r) order by case r.builtin when 'owner' then 1 when 'admin' then 2 when 'manager' then 3
                         when 'stores' then 4 when 'cashier' then 5 else 6 end, lower(r.name))
                       from cl_shop_roles r where r.business_id = me.business_id), '[]'::json),
    'staff', coalesce((select json_agg(cl_shop_staff_json(s, me.branch_id, me.id) order by lower(s.name))
                       from cl_shop_staff s where s.business_id = me.business_id), '[]'::json),
    'has_owner', exists (select 1 from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id
                          where s.business_id = me.business_id and s.active and r.builtin = 'owner'),
    -- nobody can manage staff yet: the first one may be added on a main-branch till (with its Admin passcode)
    'bootstrap', not exists (select 1 from cl_shop_staff s join cl_shop_roles r on r.id = s.role_id
                              where s.business_id = me.business_id and s.active and 'm.staff' = any(r.rights)));
end $fn$;

-- 6. A till's old staff list, once (§R8 "Moving existing staff into roles") ---------
-- p_staff: [{ name, role: 'Admin'|'Cashier', can_create_customers, active, pin_salt, pin_hash }]
-- (pin_hash: the till's own SHA-256 of "salt:PIN"; usable only on that till).
create function public.cl_device_staff_upload(p_install_id text, p_secret_phrase text, p_device_key text, p_staff jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_main boolean; e jsonb; v_name text; v_key text; v_role uuid; v_kind text; v_id uuid;
        v_admin uuid; v_cashier uuid; v_custrole uuid; v_pin jsonb; v_active boolean; n_add int := 0; n_merge int := 0; cur cl_shop_staff%rowtype;
        v_cur_builtin text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  perform 1 from cl_businesses where id = me.business_id for update;   -- one upload at a time per business
  if exists (select 1 from cl_shop_legacy_uploads where terminal_id = me.id) then return json_build_object('ok', true, 'already', true); end if;
  if me.registered_ts > (select v from cl_shop_meta where k = 'legacy_cutoff') then
    return json_build_object('error', 'NOT_NEEDED', 'message', 'This till joined after the staff moved to seiGEN, so it has no old staff list to send.');
  end if;
  select is_main into v_main from cl_branches where id = me.branch_id;
  if not exists (select 1 from cl_shop_roles where business_id = me.business_id) then
    if not coalesce(v_main, false) then
      return json_build_object('error', 'ROLES_NOT_READY', 'message', 'The main branch sends its staff first. This till tries again at its next check-in.');
    end if;
    perform cl_shop_ensure_roles(me.business_id);
  end if;
  if p_staff is null or jsonb_typeof(p_staff) <> 'array' or jsonb_array_length(p_staff) > 200 then
    raise exception 'Send the staff as a list (at most 200)' using errcode = 'P0001';
  end if;
  select id into v_admin from cl_shop_roles where business_id = me.business_id and builtin = 'admin';
  select id into v_cashier from cl_shop_roles where business_id = me.business_id and builtin = 'cashier';
  for e in select * from jsonb_array_elements(p_staff) loop
    v_name := left(btrim(regexp_replace(coalesce(e->>'name', ''), '\s+', ' ', 'g')), 60);
    continue when v_name = '';
    v_key := lower(replace(v_name, ' ', ''));
    v_kind := case when e->>'role' = 'Admin' then 'admin' when coalesce((e->>'can_create_customers')::boolean, false) then 'cust' else 'cashier' end;
    if v_kind = 'cust' then
      select id into v_custrole from cl_shop_roles where business_id = me.business_id and builtin is null and lower(name) = 'cashier + customers';
      if v_custrole is null then
        insert into cl_shop_roles (business_id, name, rights, updated_by)
        values (me.business_id, 'Cashier + customers', cl_shop_default_rights('cashier') || 'create_customers'::text, 'seiGEN')
        returning id into v_custrole;
      end if;
    end if;
    v_role := case v_kind when 'admin' then v_admin when 'cust' then v_custrole else v_cashier end;
    v_active := coalesce((e->>'active')::boolean, true);
    v_pin := case when coalesce(e->>'pin_hash', '') ~ '^[0-9a-f]{64}$' and coalesce(e->>'pin_salt', '') <> '' and length(e->>'pin_salt') <= 64
                  then jsonb_build_object('terminal_id', me.id, 'salt', e->>'pin_salt', 'hash', e->>'pin_hash') end;
    select * into cur from cl_shop_staff
     where business_id = me.business_id and home_branch_id = me.branch_id and lower(replace(name, ' ', '')) = v_key
     order by created_at limit 1;
    if cur.id is null then
      insert into cl_shop_staff (business_id, name, role_id, home_branch_id, active, legacy_pins, created_terminal, updated_by)
      values (me.business_id, v_name, v_role, me.branch_id, v_active, case when v_pin is null then '[]'::jsonb else jsonb_build_array(v_pin) end,
              me.id, 'moved from till ' || me.till_code);
      n_add := n_add + 1;
    else
      -- the same person from another till: both PINs keep working on their own tills; nobody loses access
      select builtin into v_cur_builtin from cl_shop_roles where id = cur.role_id;
      update cl_shop_staff set
        legacy_pins = case when v_pin is null or legacy_pins @> jsonb_build_array(v_pin) then legacy_pins else legacy_pins || jsonb_build_array(v_pin) end,
        active = active or v_active,
        role_id = case when v_kind = 'admin' and coalesce(v_cur_builtin, '') not in ('owner', 'admin') then v_admin
                       when v_kind = 'cust' and v_cur_builtin = 'cashier' then v_custrole else role_id end,
        change_seq = nextval('cl_shop_seq'), updated_at = now(), updated_by = 'moved from till ' || me.till_code
       where id = cur.id;
      n_merge := n_merge + 1;
    end if;
    v_custrole := null;
  end loop;
  insert into cl_shop_legacy_uploads (terminal_id, staff) values (me.id, n_add + n_merge);
  return json_build_object('ok', true, 'added', n_add, 'merged', n_merge);
end $fn$;

-- 7. Sign-in and sign-out ---------------------------------------------------------------
create function public.cl_device_staff_signin(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_id uuid, p_pin text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; s cl_shop_staff%rowtype; r cl_shop_roles%rowtype; n_fail int; v_ok boolean := false; v_legacy boolean := false; v_token text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into s from cl_shop_staff where id = p_staff_id and business_id = me.business_id for update;
  if not found or not s.active then return json_build_object('error', 'NOT_FOUND', 'message', 'That person isn''t active at this business.'); end if;
  if not (me.branch_id = s.home_branch_id or me.branch_id = any(s.other_branches)) then
    return json_build_object('error', 'NOT_HERE', 'message', 'That person doesn''t work at this branch.');
  end if;
  select count(*) into n_fail from cl_shop_staff_signin_fails where staff_id = s.id and at > now() - interval '15 minutes';
  if n_fail >= 5 then return json_build_object('error', 'LOCKED', 'message', 'Too many incorrect PINs. Try again in 15 minutes.'); end if;
  if coalesce(p_pin, '') ~ '^\d{4,6}$' then
    if s.pin_bcrypt is not null and s.pin_bcrypt = extensions.crypt(p_pin, s.pin_bcrypt) then v_ok := true;
    elsif exists (select 1 from jsonb_array_elements(s.legacy_pins) e
                   where e->>'terminal_id' = me.id::text and e->>'hash' = encode(extensions.digest((e->>'salt') || ':' || p_pin, 'sha256'), 'hex')) then
      v_ok := true; v_legacy := true;
    end if;
  end if;
  if not v_ok then
    insert into cl_shop_staff_signin_fails (staff_id, terminal_id) values (s.id, me.id);
    return json_build_object('error', 'BAD_PIN', 'message', 'Incorrect PIN.', 'left', greatest(0, 4 - n_fail));
  end if;
  delete from cl_shop_staff_signin_fails where staff_id = s.id;
  delete from cl_shop_staff_sessions where expires_at < now() - interval '1 day';
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into cl_shop_staff_sessions (token_hash, staff_id, terminal_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), s.id, me.id, now() + interval '12 hours');
  select * into r from cl_shop_roles where id = s.role_id;
  return json_build_object('ok', true, 'token', v_token, 'expires_at', now() + interval '12 hours', 'staff_id', s.id, 'name', s.name,
    'role', r.name, 'builtin', r.builtin, 'rights', to_json(cl_shop_effective_rights(r)), 'legacy', v_legacy);
end $fn$;

create function public.cl_device_staff_signout(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  update cl_shop_staff_sessions set revoked_at = now()
   where token_hash = encode(extensions.digest(coalesce(p_staff_token, ''), 'sha256'), 'hex') and terminal_id = me.id and revoked_at is null;
  return json_build_object('ok', true);
end $fn$;

-- 8. A PIN: the person's own (a signed-in session), or set by a holder of Staff ---------
-- The till sends the PIN (seiGEN keeps a bcrypt hash of it) and the check value
-- it made from the same PIN (PBKDF2, passcode-check.js) for the other tills.
create function public.cl_shop_pin_problem(p_pin text, p_salt text, p_check text, p_rounds integer) returns text
language sql immutable as $$
  select case when coalesce(p_pin, '') !~ '^\d{4,6}$' then 'The PIN must be 4 to 6 digits.'
              when coalesce(p_salt, '') !~ '^[0-9a-f]{32}$' or coalesce(p_check, '') !~ '^[0-9a-f]{64}$'
                   or coalesce(p_rounds, 0) not between 100000 and 2000000 then 'The PIN''s check value is missing or malformed.' end
$$;
create function public.cl_device_staff_set_pin(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text, p_staff_id uuid,
                                               p_pin text, p_pin_salt text, p_pin_check text, p_pin_rounds integer)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; s cl_shop_staff%rowtype; v_tb text; v_problem text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into ses from cl_shop_session(p_staff_token, me.id) limit 1;
  if ses.staff_id is null then return json_build_object('error', 'SIGN_IN', 'message', 'Sign in again (online) first.'); end if;
  select * into s from cl_shop_staff where id = p_staff_id and business_id = me.business_id for update;
  if not found then return json_build_object('error', 'NOT_FOUND', 'message', 'That person isn''t in this business.'); end if;
  select builtin into v_tb from cl_shop_roles where id = s.role_id;
  if ses.staff_id <> s.id and not ('m.staff' = any(ses.rights) and (coalesce(v_tb, '') <> 'owner' or cl_shop_owner_ok(me.business_id, ses.builtin))) then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Only the person, or someone with the Staff right, may set this PIN.');
  end if;
  v_problem := cl_shop_pin_problem(p_pin, p_pin_salt, p_pin_check, p_pin_rounds);
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;
  update cl_shop_staff set pin_bcrypt = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), pin_salt = p_pin_salt, pin_check = p_pin_check,
         pin_rounds = p_pin_rounds, pin_changed_at = now(), legacy_pins = '[]', change_seq = nextval('cl_shop_seq'), updated_at = now(), updated_by = ses.name
   where id = s.id returning * into s;
  return json_build_object('ok', true, 'staff', cl_shop_staff_json(s, me.branch_id, me.id));
end $fn$;

-- 9. Add or change a person ------------------------------------------------------------
-- p_staff: { id?, name, role_id, home_branch_id, other_branches: [uuid], active, pin?, pin_salt?, pin_check?, pin_rounds? }
create function public.cl_device_staff_save(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text, p_staff jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; v_boot boolean; v_main boolean; v_owner_ok boolean; cur cl_shop_staff%rowtype; v_cur_tb text;
        v_role cl_shop_roles%rowtype; v_name text; v_home uuid; v_others uuid[]; v_active boolean; v_id uuid; v_problem text; v_pin text; s cl_shop_staff%rowtype; v_by text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  perform cl_shop_ensure_roles(me.business_id);
  select is_main into v_main from cl_branches where id = me.branch_id;
  select * into ses from cl_shop_session(p_staff_token, me.id) limit 1;
  v_boot := ses.staff_id is null and coalesce(v_main, false) and not exists (
    select 1 from cl_shop_staff st join cl_shop_roles ro on ro.id = st.role_id where st.business_id = me.business_id and st.active and 'm.staff' = any(ro.rights));
  if not v_boot and (ses.staff_id is null or not ('m.staff' = any(ses.rights))) then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Sign in (online) as someone with the Staff right to add or change staff.');
  end if;
  v_owner_ok := v_boot or cl_shop_owner_ok(me.business_id, ses.builtin);
  v_by := coalesce(ses.name, 'Admin passcode on till ' || me.till_code);
  if nullif(p_staff->>'id', '') is not null then
    select * into cur from cl_shop_staff where id = (p_staff->>'id')::uuid and business_id = me.business_id for update;
    if cur.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That person isn''t in this business.'); end if;
    select builtin into v_cur_tb from cl_shop_roles where id = cur.role_id;
  end if;
  v_name := left(btrim(regexp_replace(coalesce(p_staff->>'name', cur.name, ''), '\s+', ' ', 'g')), 60);
  if v_name = '' then raise exception 'Enter the person''s name.' using errcode = 'P0001'; end if;
  select * into v_role from cl_shop_roles where id = coalesce(nullif(p_staff->>'role_id', '')::uuid, cur.role_id) and business_id = me.business_id;
  if v_role.id is null then raise exception 'Choose a role of this business.' using errcode = 'P0001'; end if;
  v_home := coalesce(nullif(p_staff->>'home_branch_id', '')::uuid, cur.home_branch_id, me.branch_id);
  if not exists (select 1 from cl_branches where id = v_home and business_id = me.business_id) then raise exception 'Choose a branch of this business.' using errcode = 'P0001'; end if;
  v_others := case when p_staff ? 'other_branches' then
      array(select distinct b.id from jsonb_array_elements_text(coalesce(p_staff->'other_branches', '[]'::jsonb)) x join cl_branches b on b.id::text = x
             where b.business_id = me.business_id and b.id <> v_home)
    else coalesce(cur.other_branches, '{}') end;
  v_active := coalesce((p_staff->>'active')::boolean, cur.active, true);
  -- Owner-only (Q2): giving or taking the Owner role; changing an Owner
  if (v_role.builtin = 'owner' or v_cur_tb = 'owner') and not v_owner_ok then
    return json_build_object('error', 'OWNER_ONLY', 'message', 'Only an Owner may give, change or take away the Owner role.');
  end if;
  if v_cur_tb = 'owner' and (coalesce(v_role.builtin, '') <> 'owner' or not v_active) and not exists (
       select 1 from cl_shop_staff st join cl_shop_roles ro on ro.id = st.role_id
        where st.business_id = me.business_id and st.active and ro.builtin = 'owner' and st.id <> cur.id) then
    return json_build_object('error', 'LAST_OWNER', 'message', 'The business''s last Owner stays an Owner. Make someone else Owner first.');
  end if;
  v_pin := nullif(p_staff->>'pin', '');
  if cur.id is null and v_pin is null then raise exception 'Give the new person a PIN (4 to 6 digits).' using errcode = 'P0001'; end if;
  if v_pin is not null then
    v_problem := cl_shop_pin_problem(v_pin, p_staff->>'pin_salt', p_staff->>'pin_check', (p_staff->>'pin_rounds')::integer);
    if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;
  end if;
  if cur.id is null then
    insert into cl_shop_staff (business_id, name, role_id, home_branch_id, other_branches, active, pin_bcrypt, pin_salt, pin_check, pin_rounds, pin_changed_at,
                               created_terminal, updated_by)
    values (me.business_id, v_name, v_role.id, v_home, v_others, v_active, extensions.crypt(v_pin, extensions.gen_salt('bf', 8)),
            p_staff->>'pin_salt', p_staff->>'pin_check', (p_staff->>'pin_rounds')::integer, now(), me.id, v_by)
    returning * into s;
  else
    update cl_shop_staff set name = v_name, role_id = v_role.id, home_branch_id = v_home, other_branches = v_others, active = v_active,
           pin_bcrypt = case when v_pin is null then pin_bcrypt else extensions.crypt(v_pin, extensions.gen_salt('bf', 8)) end,
           pin_salt = case when v_pin is null then pin_salt else p_staff->>'pin_salt' end,
           pin_check = case when v_pin is null then pin_check else p_staff->>'pin_check' end,
           pin_rounds = case when v_pin is null then pin_rounds else (p_staff->>'pin_rounds')::integer end,
           pin_changed_at = case when v_pin is null then pin_changed_at else now() end,
           legacy_pins = case when v_pin is null then legacy_pins else '[]'::jsonb end,
           change_seq = nextval('cl_shop_seq'), updated_at = now(), updated_by = v_by
     where id = cur.id returning * into s;
    -- switched off: their sessions end at once (server data stops)
    if not v_active then update cl_shop_staff_sessions set revoked_at = now() where staff_id = s.id and revoked_at is null; end if;
  end if;
  return json_build_object('ok', true, 'staff', cl_shop_staff_json(s, me.branch_id, me.id));
end $fn$;

-- 10. Add, change or delete a role --------------------------------------------------------
-- p_role: { id?, name, rights: [text], delete? }
create function public.cl_device_role_save(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text, p_role jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; ses record; cur cl_shop_roles%rowtype; v_name text; v_rights text[]; r cl_shop_roles%rowtype; v_mine uuid;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into ses from cl_shop_session(p_staff_token, me.id) limit 1;
  if ses.staff_id is null or not ('m.staff' = any(ses.rights)) then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Sign in (online) as someone with the Staff right to change roles.');
  end if;
  perform 1 from cl_businesses where id = me.business_id for update;
  perform cl_shop_ensure_roles(me.business_id);
  if nullif(p_role->>'id', '') is not null then
    select * into cur from cl_shop_roles where id = (p_role->>'id')::uuid and business_id = me.business_id for update;
    if cur.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That role isn''t in this business.'); end if;
    if cur.builtin = 'owner' then return json_build_object('error', 'OWNER_FIXED', 'message', 'The Owner role always has every right.'); end if;
  end if;
  if coalesce((p_role->>'delete')::boolean, false) then
    if cur.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'Say which role to delete.'); end if;
    if not cl_shop_owner_ok(me.business_id, ses.builtin) then return json_build_object('error', 'OWNER_ONLY', 'message', 'Only an Owner may delete a role.'); end if;
    if cur.builtin is not null then return json_build_object('error', 'BUILTIN', 'message', 'A built-in role can be changed but not deleted.'); end if;
    if exists (select 1 from cl_shop_staff where role_id = cur.id) then
      return json_build_object('error', 'IN_USE', 'message', 'Give its staff another role first.');
    end if;
    delete from cl_shop_roles where id = cur.id;
    return json_build_object('ok', true, 'deleted', cur.id);
  end if;
  v_name := left(btrim(regexp_replace(coalesce(p_role->>'name', cur.name, ''), '\s+', ' ', 'g')), 40);
  if v_name = '' then raise exception 'Give the role a name.' using errcode = 'P0001'; end if;
  v_rights := array(select distinct x from jsonb_array_elements_text(coalesce(p_role->'rights', to_jsonb(cur.rights), '[]'::jsonb)) x
                     where x = any(cl_shop_rights_all()) and x <> 'owner' order by x);
  select role_id into v_mine from cl_shop_staff where id = ses.staff_id;
  if cur.id = v_mine and not ('m.staff' = any(v_rights)) then
    return json_build_object('error', 'OWN_ROLE', 'message', 'You''d lose the Staff right yourself. Ask another person with it.');
  end if;
  begin
    if cur.id is null then
      insert into cl_shop_roles (business_id, name, rights, updated_by) values (me.business_id, v_name, v_rights, ses.name) returning * into r;
    else
      update cl_shop_roles set name = v_name, rights = v_rights, change_seq = nextval('cl_shop_seq'), updated_at = now(), updated_by = ses.name
       where id = cur.id returning * into r;
    end if;
  exception when unique_violation then
    return json_build_object('error', 'NAME_TAKEN', 'message', 'Another role already has that name.');
  end;
  return json_build_object('ok', true, 'role', cl_shop_role_json(r));
end $fn$;

-- 11. Other branches' reports, by right (§R4) ---------------------------------------------
-- p_kind: 'inventory' | 'dispatches' | 'supplier_grvs'. Another branch needs
-- "View other branches' reports"; costs only with "View costs" (Q7: sent to the
-- signed-in person for this answer, never stored by the till).
create function public.cl_device_branch_report(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text,
                                               p_kind text, p_branch_id uuid, p_from timestamptz default null, p_to timestamptz default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; b cl_branches%rowtype; v_costs boolean; v_from timestamptz := coalesce(p_from, '-infinity'); v_to timestamptz := coalesce(p_to, 'infinity');
        v_rows json;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into b from cl_branches where id = p_branch_id and business_id = me.business_id;
  if b.id is null then return json_build_object('error', 'NOT_FOUND', 'message', 'That branch isn''t in this business.'); end if;
  if b.id <> me.branch_id and not cl_staff_has(p_staff_token, me.id, 'other_branches') then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Other branches'' reports need a signed-in person with "View other branches'' reports".');
  end if;
  v_costs := cl_staff_has(p_staff_token, me.id, 'costs');
  if p_kind = 'inventory' then
    v_rows := coalesce((select json_agg(x order by x.name) from (
      select g.k, g.cat_uid, g.code, g.name, g.qty, g.low,
             case when v_costs then c.cost end as cost, case when v_costs then round((g.qty * c.cost)::numeric, 2) end as value
        from (select l.product_key k, max(l.cat_uid) cat_uid, max(l.code) code, max(l.name) name, sum(l.qty)::bigint qty, max(l.low_threshold) low
                from cl_till_stock_levels l join cl_terminals t on t.id = l.terminal_id
               where b.stock_mode <> 'shared' and l.branch_id = b.id and t.active and t.branch_id = b.id
               group by l.product_key
              union all
              select s.product_uid, s.product_uid, c2.code, c2.name, s.total::bigint, c2.low_threshold
                from cl_branch_stock s join cl_catalogue_products c2 on c2.business_id = s.business_id and c2.product_uid = s.product_uid
               where b.stock_mode = 'shared' and s.branch_id = b.id) g
        left join cl_catalogue_products c on c.business_id = me.business_id and c.product_uid = coalesce(g.cat_uid, g.k)) x), '[]'::json);
  elsif p_kind = 'dispatches' then
    v_rows := coalesce((select json_agg(x order by x.sent_at desc) from (
      select d.id, d.dn_display, case when d.from_branch_id = b.id then 'out' else 'in' end as direction,
             (select name from cl_branches where id = case when d.from_branch_id = b.id then d.to_branch_id else d.from_branch_id end) as other_branch,
             d.status, d.sent_at, d.sent_by, d.received_at, d.grv_display, d.grv_by, d.internal_ref,
             d.delivery_cost, d.delivery_currency,
             case when v_costs then (select json_build_object('amount', ch.amount, 'currency', ch.currency) from cl_interbranch_charges ch where ch.dispatch_id = d.id limit 1) end as charge,
             (select coalesce(json_agg(json_build_object('line_no', l.line_no, 'code', l.code, 'name', l.name, 'qty', l.qty, 'received', l.received,
                 'short', l.short, 'damaged', l.damaged, 'extra', l.extra, 'unit_cost', case when v_costs then l.unit_cost end) order by l.line_no), '[]'::json)
                from cl_dispatch_lines l where l.dispatch_id = d.id) as lines
        from cl_dispatches d
       where d.business_id = me.business_id and (d.from_branch_id = b.id or d.to_branch_id = b.id) and d.sent_at between v_from and v_to
       order by d.sent_at desc limit 500) x), '[]'::json);
  elsif p_kind = 'supplier_grvs' then
    v_rows := coalesce((select json_agg(x order by x.posted_at desc) from (
      select g.id, g.grv_display, g.posted_at, g.received_by, g.invoice_no, sp.name as supplier, t.till_code as till,
             case when v_costs then g.delivery_cost end as delivery_cost, g.delivery_currency,
             (select coalesce(json_agg(json_build_object('line_no', l.line_no, 'code', l.code, 'name', l.name, 'qty', l.qty,
                 'unit_cost', case when v_costs then l.unit_cost end, 'landed_cost', case when v_costs then l.landed_cost end) order by l.line_no), '[]'::json)
                from cl_supplier_grv_lines l where l.grv_id = g.id) as lines
        from cl_supplier_grvs g join cl_suppliers sp on sp.id = g.supplier_id left join cl_terminals t on t.id = g.terminal_id
       where g.business_id = me.business_id and g.branch_id = b.id and g.posted_at between v_from and v_to
       order by g.posted_at desc limit 500) x), '[]'::json);
  else
    raise exception 'Say which report: inventory, dispatches or supplier_grvs' using errcode = 'P0001';
  end if;
  return json_build_object('server_time', now(), 'kind', p_kind, 'branch_id', b.id, 'branch', b.name, 'costs', v_costs, 'rows', v_rows);
end $fn$;

-- 12. One DN's costs (the DN card), with "View costs" ----------------------------------------
create function public.cl_device_dispatch_costs(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text, p_dispatch_id uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; d cl_dispatches%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  select * into d from cl_dispatches where id = p_dispatch_id and business_id = me.business_id;
  if not found then return json_build_object('error', 'NOT_FOUND', 'message', 'That Delivery Note isn''t on seiGEN for this business.'); end if;
  if not cl_staff_has(p_staff_token, me.id, 'costs') then
    return json_build_object('error', 'NO_RIGHT', 'message', 'Costs need a signed-in person with "View costs".');
  end if;
  return json_build_object('id', d.id,
    'lines', coalesce((select json_agg(json_build_object('line_no', l.line_no, 'unit_cost', l.unit_cost) order by l.line_no) from cl_dispatch_lines l where l.dispatch_id = d.id), '[]'::json),
    'charge', (select json_build_object('amount', ch.amount, 'currency', ch.currency) from cl_interbranch_charges ch where ch.dispatch_id = d.id limit 1));
end $fn$;

-- 13. The business merge moves staff and roles; the delete guard counts staff ---------------
-- As 20261021120000, plus the shop roles and staff block before the archive.
create or replace function public.cl_business_merge_core(p_from uuid, p_into uuid, p_reason text, p_move_catalogue boolean, p_by_staff uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare f cl_businesses%rowtype; i cl_businesses%rowtype; v_reason text := cl_archive_reason(p_reason);
        v_max integer; b record; n_br int; n_te int; n_ve int; n_cat int := 0; n_codes int; v_clash text; v_names text; v_moved uuid[];
        n_staff int := 0;
begin
  if p_from is null or p_into is null or p_from = p_into then raise exception 'MERGE_SAME: Give two different businesses' using errcode = 'P0001'; end if;
  -- lock both, in id order (two merges at once can't deadlock)
  perform 1 from cl_businesses where id in (p_from, p_into) order by id for update;
  select * into f from cl_businesses where id = p_from;
  select * into i from cl_businesses where id = p_into;
  if f.id is null or i.id is null then raise exception 'MERGE_NOT_FOUND: No such business' using errcode = 'P0001'; end if;
  if f.archived_at is not null or i.archived_at is not null then raise exception 'MERGE_ARCHIVED: An archived business can''t be merged' using errcode = 'P0001'; end if;

  -- what can't move (yet): say exactly what is in the way
  select string_agg(x, '; ') into v_clash from (
    select 'it has ' || count(*) || ' customers' x from cl_customers where business_id = f.id having count(*) > 0
    union all select 'it has ' || count(*) || ' suppliers' from cl_suppliers where business_id = f.id having count(*) > 0
    union all select 'it has ' || count(*) || ' supplier GRVs' from cl_supplier_grvs where business_id = f.id having count(*) > 0
    union all select 'it has ' || count(*) || ' dispatches' from cl_dispatches where business_id = f.id having count(*) > 0
    union all select 'branch ' || name || ' uses shared stock' from cl_branches where business_id = f.id and stock_mode = 'shared'
    union all select 'it has branch stock' from cl_branch_stock s join cl_branches br on br.id = s.branch_id where br.business_id = f.id having count(*) > 0
    union all select 'both have a branch called ' || a.name from cl_branches a join cl_branches c on c.business_id = i.id and cl_branch_key(c.name) = cl_branch_key(a.name)
      where a.business_id = f.id) q;
  if v_clash is not null then raise exception 'MERGE_BLOCKED: % can''t be merged yet: %', f.name, v_clash using errcode = 'P0001'; end if;

  select count(*) into n_codes from cl_catalogue_products where business_id = f.id;
  if n_codes > 0 and not coalesce(p_move_catalogue, false) then
    raise exception 'MERGE_CATALOGUE: % has % catalogue products. Merge with "move the catalogue", or the other way round.', f.name, n_codes using errcode = 'P0001';
  end if;
  if n_codes > 0 then
    select string_agg(distinct a.code, ', ') into v_clash from cl_catalogue_products a join cl_catalogue_products c
      on c.business_id = i.id and c.active and a.active and btrim(a.code) <> '' and lower(btrim(c.code)) = lower(btrim(a.code))
     where a.business_id = f.id;
    if v_clash is not null then raise exception 'MERGE_CATALOGUE_CODES: Both catalogues use the code(s) %. Change them on one side first.', v_clash using errcode = 'P0001'; end if;
  end if;

  -- the move (branch ids, till codes and product uids don't change)
  v_moved := array(select id from cl_branches where business_id = f.id);
  update cl_branches set business_id = i.id, is_main = false where business_id = f.id;
  get diagnostics n_br = row_count;
  update cl_terminals set business_id = i.id where business_id = f.id;
  get diagnostics n_te = row_count;
  update cl_vendors set business_id = i.id where business_id = f.id;
  get diagnostics n_ve = row_count;
  if n_codes > 0 then
    -- new change_seq numbers: every till of either side pulls them as new
    update cl_catalogue_products set business_id = i.id, change_seq = nextval('cl_catalogue_seq') where business_id = f.id;
    get diagnostics n_cat = row_count;
  end if;
  update cl_branch_join_codes set expires_ts = now()
   where used_ts is null and expires_ts > now() and branch_id = any(v_moved);

  -- shop roles and staff (20261107120000): the staff move with their branches; a built-in
  -- role maps onto the other business's own; custom roles move (renamed on a clash);
  -- their sessions end (they sign in again)
  if exists (select 1 from cl_shop_roles where business_id = f.id) then
    perform cl_shop_ensure_roles(i.id);
    update cl_shop_staff s set role_id = r2.id from cl_shop_roles r, cl_shop_roles r2
     where s.role_id = r.id and r.business_id = f.id and r.builtin is not null and r2.business_id = i.id and r2.builtin = r.builtin;
    update cl_shop_roles r set name = left(r.name || ' (' || f.name || ')', 40)
     where r.business_id = f.id and r.builtin is null
       and exists (select 1 from cl_shop_roles x where x.business_id = i.id and lower(btrim(x.name)) = lower(btrim(r.name)));
    update cl_shop_roles set business_id = i.id, change_seq = nextval('cl_shop_seq') where business_id = f.id and builtin is null;
    update cl_shop_staff_sessions x set revoked_at = now() from cl_shop_staff s where x.staff_id = s.id and s.business_id = f.id and x.revoked_at is null;
    update cl_shop_staff set business_id = i.id, change_seq = nextval('cl_shop_seq') where business_id = f.id;
    get diagnostics n_staff = row_count;
    delete from cl_shop_roles where business_id = f.id;
  end if;

  -- the other business's plan must allow every branch it now has
  v_max := (cl_plan_version((select pl.plan_code from cl_plan_of(i.id, null) pl))).max_branches;
  for b in select id from cl_branches where business_id = i.id loop
    if not cl_plan_branch_allowed(b.id, v_max) then raise exception '%', cl_plan_branch_limit_text(v_max); end if;
  end loop;

  update cl_businesses set archived_at = now(), archived_by = p_by_staff,
         archive_reason = left('Merged into ' || i.name || ' (' || i.id || '): ' || v_reason, 300)
   where id = f.id;
  select string_agg(name, ', ' order by is_main desc, name) into v_names from cl_branches where business_id = i.id;
  insert into cl_activity_log (staff_id, action, target_table, target_id, detail)
  values (p_by_staff, 'business_merged', 'cl_businesses', f.id,
          jsonb_build_object('from', f.id, 'from_name', f.name, 'into', i.id, 'into_name', i.name, 'reason', v_reason,
                             'branches', n_br, 'tills', n_te, 'vendors', n_ve, 'catalogue_products', n_cat, 'shop_staff', n_staff, 'db_role', current_user));
  return json_build_object('ok', true, 'from', f.id, 'into', i.id, 'into_name', i.name, 'branches_now', v_names,
                           'moved', json_build_object('branches', n_br, 'tills', n_te, 'vendors', n_ve, 'catalogue_products', n_cat, 'shop_staff', n_staff));
end $fn$;

-- As 20261019120000, plus the shop staff.
create or replace function public.cl_business_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare parts text[] := '{}'; n integer;
begin
  select count(*) into n from cl_branches where business_id = old.id;
  if n > 0 then parts := parts || (n || ' branch' || case when n = 1 then '' else 'es' end); end if;
  select count(*) into n from cl_terminals where business_id = old.id;
  if n > 0 then parts := parts || (n || ' till' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_licences where business_id = old.id;
  if n > 0 then parts := parts || (n || ' licence' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_plan_assignments where business_id = old.id;
  if n > 0 then parts := parts || (n || ' price-plan setting' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_catalogue_products where business_id = old.id;
  if n > 0 then parts := parts || (n || ' catalogue product' || case when n = 1 then '' else 's' end); end if;
  -- RPN commissions (20261015120000)
  select count(*) into n from cl_rpn_commissions where business_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN commission line' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_rpn_assignments where business_id = old.id;
  if n > 0 then parts := parts || (n || ' RPN history entr' || case when n = 1 then 'y' else 'ies' end); end if;
  -- Market publishing (20261016120000)
  select count(*) into n from cl_market_packs where business_id = old.id;
  if n > 0 then parts := parts || (n || ' market pack' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_token_purchases where business_id = old.id;
  if n > 0 then parts := parts || (n || ' token purchase' || case when n = 1 then '' else 's' end); end if;
  -- Dispatch & GRV (20261017120000)
  select count(*) into n from cl_dispatches where business_id = old.id;
  if n > 0 then parts := parts || (n || ' dispatch' || case when n = 1 then '' else 'es' end); end if;
  -- Suppliers (20261018120000)
  select count(*) into n from cl_suppliers where business_id = old.id;
  if n > 0 then parts := parts || (n || ' supplier' || case when n = 1 then '' else 's' end); end if;
  select count(*) into n from cl_supplier_grvs where business_id = old.id;
  if n > 0 then parts := parts || (n || ' supplier GRV' || case when n = 1 then '' else 's' end); end if;
  -- Customers (20261018180000)
  select count(*) into n from cl_customers where business_id = old.id;
  if n > 0 then parts := parts || (n || ' customer' || case when n = 1 then '' else 's' end); end if;
  -- Trial rules (20261019120000)
  select count(*) into n from cl_trials where business_id = old.id;
  if n > 0 then parts := parts || (n || ' free trial' || case when n = 1 then '' else 's' end); end if;
  -- Shop roles and staff (20261107120000)
  select count(*) into n from cl_shop_staff where business_id = old.id;
  if n > 0 then parts := parts || (n || ' shop staff'); end if;
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

-- 14. Who may call what ----------------------------------------------------------------
alter table public.cl_shop_roles enable row level security;
alter table public.cl_shop_staff enable row level security;
alter table public.cl_shop_staff_sessions enable row level security;
alter table public.cl_shop_staff_signin_fails enable row level security;
alter table public.cl_shop_legacy_uploads enable row level security;
alter table public.cl_shop_meta enable row level security;
revoke all on table public.cl_shop_roles, public.cl_shop_staff, public.cl_shop_staff_sessions, public.cl_shop_staff_signin_fails,
  public.cl_shop_legacy_uploads, public.cl_shop_meta from public, anon, authenticated;
revoke all on sequence public.cl_shop_seq from public, anon, authenticated;
revoke all on function public.cl_shop_rights_all(), public.cl_shop_default_rights(text), public.cl_shop_ensure_roles(uuid),
  public.cl_shop_owner_ok(uuid, text), public.cl_shop_effective_rights(public.cl_shop_roles), public.cl_shop_session(text, uuid),
  public.cl_staff_has(text, uuid, text), public.cl_shop_role_json(public.cl_shop_roles), public.cl_shop_staff_json(public.cl_shop_staff, uuid, uuid),
  public.cl_shop_pin_problem(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.cl_device_staff_pull(text, text, text), public.cl_device_staff_upload(text, text, text, jsonb),
  public.cl_device_staff_signin(text, text, text, uuid, text), public.cl_device_staff_signout(text, text, text, text),
  public.cl_device_staff_set_pin(text, text, text, text, uuid, text, text, text, integer), public.cl_device_staff_save(text, text, text, text, jsonb),
  public.cl_device_role_save(text, text, text, text, jsonb), public.cl_device_branch_report(text, text, text, text, text, uuid, timestamptz, timestamptz),
  public.cl_device_dispatch_costs(text, text, text, text, uuid) from public;
grant execute on function public.cl_device_staff_pull(text, text, text), public.cl_device_staff_upload(text, text, text, jsonb),
  public.cl_device_staff_signin(text, text, text, uuid, text), public.cl_device_staff_signout(text, text, text, text),
  public.cl_device_staff_set_pin(text, text, text, text, uuid, text, text, text, integer), public.cl_device_staff_save(text, text, text, text, jsonb),
  public.cl_device_role_save(text, text, text, text, jsonb), public.cl_device_branch_report(text, text, text, text, text, uuid, timestamptz, timestamptz),
  public.cl_device_dispatch_costs(text, text, text, text, uuid) to anon, authenticated;

commit;
