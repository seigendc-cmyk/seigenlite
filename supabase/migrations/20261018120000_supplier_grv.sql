-- =====================================================================
-- Dispatch & GRV through Supabase, B2: suppliers and the supplier GRV
-- (owner: "go Dispatch-B" / "finish go Dispatch-B", 2026-10-09, with the
-- Stage A recommendations accepted). Applied live only after the owner has
-- seen this file and said "apply". Needs 20261017120000_dispatch_grv.
-- Design: docs/dispatch/dispatch-grv-supabase-design.md §15-16
-- Rollback: supabase/rollbacks/20261018120000_supplier_grv.rollback.sql
-- Tested in PGlite: supabase/tests/supplier-grv-test.js
--
-- 1. cl_suppliers: ONE list per business (name unique per business, phone,
--    notes, active), kept by main-branch tills, pulled by every till.
-- 2. cl_supplier_grvs (+ lines): goods received from a supplier, MAIN BRANCH
--    tills only (costs stay off remote branches). The invoice number is
--    required; the same supplier + invoice number twice in a business is
--    refused ("Invoice INV-123 from Acme was already received as GRV-T1-0004
--    on 08 Oct 2026"). Idempotent by the GRV uid; (till, GRV number) unique.
--    Delivery cost and the landed unit cost of each line are kept; a
--    selling-price change made at the GRV is recorded on its line (old -> new,
--    who); the price itself travels by the catalogue sync as today.
-- 3. As in B1 the server never moves stock: the till moves its own, once per
--    GRV uid, and puts back a GRV a restored backup lost.
-- 4. Console: read-only list (module "dispatches").
-- 5. The business delete guard also counts suppliers and supplier GRVs.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into conflicts from (
    select 'table cl_suppliers' n where to_regclass('public.cl_suppliers') is not null
    union all select 'table cl_supplier_grvs' where to_regclass('public.cl_supplier_grvs') is not null
  ) x;
  if conflicts is not null then raise exception 'supplier_grv aborted: already there: %. Nothing was changed.', conflicts; end if;
  select string_agg(n, ', ') into missing from (
    select 'table cl_dispatches (20261017120000)' n where to_regclass('public.cl_dispatches') is null
    union all select 'function cl_dispatch_caller (20261017120000)' where to_regprocedure('public.cl_dispatch_caller(text,text,text)') is null
    union all select 'module dispatches (20261017120000)' where not exists (select 1 from cl_modules where key = 'dispatches')
  ) x;
  if missing is not null then raise exception 'supplier_grv aborted: missing %. Nothing was changed.', missing; end if;
end $$;

-- 1. Tables ---------------------------------------------------------------
create table public.cl_suppliers (
  id                uuid primary key,                         -- made on the till that added it
  business_id       uuid not null references public.cl_businesses(id),
  name              text not null check (length(btrim(name)) between 1 and 80),
  phone             text check (phone is null or length(phone) <= 40),
  notes             text check (notes is null or length(notes) <= 200),
  active            boolean not null default true,
  created_terminal  uuid references public.cl_terminals(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index cl_suppliers_name_uidx on public.cl_suppliers (business_id, lower(btrim(name)));

-- The invoice number as compared: letters and digits only, upper case ("inv 123" = "INV-123").
create function public.cl_invoice_key(p text) returns text
language sql immutable as $$ select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

create table public.cl_supplier_grvs (
  id                uuid primary key,                         -- the GRV uid made on the till
  business_id       uuid not null references public.cl_businesses(id),
  branch_id         uuid not null references public.cl_branches(id),
  terminal_id       uuid not null references public.cl_terminals(id),
  supplier_id       uuid not null references public.cl_suppliers(id),
  invoice_no        text not null check (length(btrim(invoice_no)) between 1 and 40),
  invoice_key       text not null check (invoice_key <> ''),
  grv_no            integer not null check (grv_no > 0),
  grv_display       text not null check (length(grv_display) between 1 and 40),
  received_by       text check (received_by is null or length(received_by) <= 80),
  delivery_cost     numeric(12,2) not null default 0 check (delivery_cost >= 0 and delivery_cost <= 10000000),
  delivery_currency text check (delivery_currency is null or delivery_currency ~ '^[A-Z]{3}$'),
  note              text check (note is null or length(note) <= 200),
  created_iso       text check (created_iso is null or length(created_iso) <= 40),
  posted_at         timestamptz not null default now(),
  unique (business_id, supplier_id, invoice_key),
  unique (terminal_id, grv_no),
  check ((delivery_cost = 0) or delivery_currency is not null)
);
create table public.cl_supplier_grv_lines (
  grv_id      uuid not null references public.cl_supplier_grvs(id) on delete cascade,
  line_no     integer not null check (line_no between 1 and 500),
  cat_uid     text check (cat_uid is null or length(cat_uid) <= 64),
  code        text check (code is null or length(code) <= 64),
  name        text not null check (length(btrim(name)) between 1 and 120),
  qty         integer not null check (qty between 1 and 1000000),
  unit_cost   numeric(14,4) not null check (unit_cost >= 0),
  landed_cost numeric(14,4) check (landed_cost is null or landed_cost >= 0),
  old_price   numeric(14,2),
  new_price   numeric(14,2) check (new_price is null or new_price >= 0),
  price_by    text check (price_by is null or length(price_by) <= 80),
  primary key (grv_id, line_no)
);

-- 2. Helpers --------------------------------------------------------------
create function public.cl_supplier_json(s public.cl_suppliers) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'phone', s.phone, 'notes', s.notes, 'active', s.active, 'updated_at', s.updated_at)
$$;
create function public.cl_supplier_grv_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', g.id, 'business_id', g.business_id, 'branch', b.name, 'till', t.till_code, 'terminal_id', g.terminal_id,
    'supplier_id', g.supplier_id, 'supplier', s.name, 'invoice_no', g.invoice_no, 'grv_no', g.grv_no, 'grv_display', g.grv_display,
    'received_by', g.received_by, 'delivery_cost', g.delivery_cost, 'delivery_currency', g.delivery_currency, 'note', g.note,
    'created_iso', g.created_iso, 'posted_at', g.posted_at,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'cat_uid', l.cat_uid, 'code', l.code, 'name', l.name, 'qty', l.qty,
        'unit_cost', l.unit_cost, 'landed_cost', l.landed_cost, 'old_price', l.old_price, 'new_price', l.new_price, 'price_by', l.price_by) order by l.line_no)
      from cl_supplier_grv_lines l where l.grv_id = g.id), '[]'::jsonb))
  from cl_supplier_grvs g join cl_branches b on b.id = g.branch_id join cl_terminals t on t.id = g.terminal_id join cl_suppliers s on s.id = g.supplier_id
  where g.id = p_id
$$;
-- The calling till, which must be an active till of the MAIN branch. -> null when it isn't.
create function public.cl_supplier_till(p_install_id text, p_secret_phrase text, p_device_key text)
returns public.cl_terminals
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active or not exists (select 1 from cl_branches where id = me.branch_id and is_main) then return null; end if;
  return me;
end $fn$;

-- 3. Suppliers ---------------------------------------------------------------
-- Every till of the business: the list, and this till's own supplier GRVs (60 days) for putting back after a restore.
create function public.cl_device_suppliers_pull(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  return json_build_object(
    'suppliers', coalesce((select json_agg(cl_supplier_json(s) order by lower(s.name)) from cl_suppliers s where s.business_id = me.business_id), '[]'::json),
    'my_grvs', coalesce((select json_agg(cl_supplier_grv_json(g.id) order by g.posted_at) from cl_supplier_grvs g
       where g.terminal_id = me.id and g.posted_at > now() - interval '60 days'), '[]'::json),
    'max_grv_no', (select max(n) from (select max(grv_no) n from cl_supplier_grvs where terminal_id = me.id
                                       union all select max(grv_no) from cl_dispatches where grv_terminal_id = me.id) x));
end $fn$;

-- Main-branch tills: add or change a supplier (idempotent by id). p_supplier: { id, name, phone, notes, active }
create function public.cl_device_supplier_save(p_install_id text, p_secret_phrase text, p_device_key text, p_supplier jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_id uuid; v_name text := btrim(coalesce(p_supplier->>'name', '')); s cl_suppliers%rowtype;
begin
  me := cl_supplier_till(p_install_id, p_secret_phrase, p_device_key);
  if me.id is null then return json_build_object('error', 'MAIN_ONLY', 'message', 'Suppliers are kept on the main branch.'); end if;
  begin v_id := (p_supplier->>'id')::uuid; exception when others then v_id := null; end;
  if v_id is null then raise exception 'The supplier needs its id' using errcode = 'P0001'; end if;
  if length(v_name) not between 1 and 80 then raise exception 'Give the supplier''s name (up to 80 characters)' using errcode = 'P0001'; end if;
  select * into s from cl_suppliers where business_id = me.business_id and lower(btrim(name)) = lower(v_name) and id <> v_id;
  if found then return json_build_object('error', 'DUPLICATE_SUPPLIER', 'message', '"' || s.name || '" is already in the supplier list.', 'supplier', cl_supplier_json(s)); end if;
  select * into s from cl_suppliers where id = v_id;
  if found and s.business_id <> me.business_id then raise exception 'That supplier id belongs to another business' using errcode = 'P0001'; end if;
  insert into cl_suppliers (id, business_id, name, phone, notes, active, created_terminal)
  values (v_id, me.business_id, v_name, nullif(btrim(coalesce(p_supplier->>'phone', '')), ''), nullif(btrim(coalesce(p_supplier->>'notes', '')), ''),
          coalesce((p_supplier->>'active')::boolean, true), me.id)
  on conflict (id) do update set name = excluded.name, phone = excluded.phone, notes = excluded.notes, active = excluded.active, updated_at = now()
  returning * into s;
  return json_build_object('ok', true, 'supplier', cl_supplier_json(s));
end $fn$;

-- 4. The supplier GRV (main-branch tills) -----------------------------------
-- Before posting: has this invoice been received already? -> { found, grv_display, posted_at }
create function public.cl_device_supplier_invoice_check(p_install_id text, p_secret_phrase text, p_device_key text, p_supplier_id uuid, p_invoice_no text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; g cl_supplier_grvs%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  select * into g from cl_supplier_grvs where business_id = me.business_id and supplier_id = p_supplier_id and invoice_key = cl_invoice_key(p_invoice_no);
  if not found then return json_build_object('found', false); end if;
  return json_build_object('found', true, 'id', g.id, 'grv_display', g.grv_display, 'posted_at', g.posted_at, 'till', (select till_code from cl_terminals where id = g.terminal_id));
end $fn$;

-- p_grv: { id, supplier_id, invoice_no, grv_no, grv_display, received_by, delivery:{ cost, currency }, note, created_iso,
--          lines: [{ cat_uid, code, name, qty, unit_cost, landed_cost, old_price, new_price, price_by }] }
create function public.cl_device_supplier_grv_post(p_install_id text, p_secret_phrase text, p_device_key text, p_grv jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; v_id uuid; g cl_supplier_grvs%rowtype; s cl_suppliers%rowtype; l jsonb; n integer := 0;
        v_cost numeric; v_cur text; v_key text;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  begin v_id := (p_grv->>'id')::uuid; exception when others then v_id := null; end;
  if v_id is null then raise exception 'The GRV needs its id' using errcode = 'P0001'; end if;
  select * into g from cl_supplier_grvs where id = v_id;
  if found then
    if g.terminal_id <> me.id then raise exception 'That GRV id belongs to another till' using errcode = 'P0001'; end if;
    return json_build_object('ok', true, 'already', true, 'grv', cl_supplier_grv_json(v_id));
  end if;
  me := cl_supplier_till(p_install_id, p_secret_phrase, p_device_key);
  if me.id is null then return json_build_object('error', 'MAIN_ONLY', 'message', 'Goods from suppliers are received on the main branch.'); end if;
  begin select * into s from cl_suppliers where id = (p_grv->>'supplier_id')::uuid; exception when others then s := null; end;
  if s.id is null or s.business_id <> me.business_id then return json_build_object('error', 'NO_SUCH_SUPPLIER', 'message', 'That supplier isn''t in the business''s list yet.'); end if;
  v_key := cl_invoice_key(p_grv->>'invoice_no');
  if v_key = '' or length(btrim(p_grv->>'invoice_no')) > 40 then raise exception 'Give the supplier''s invoice number' using errcode = 'P0001'; end if;
  select * into g from cl_supplier_grvs where business_id = me.business_id and supplier_id = s.id and invoice_key = v_key;
  if found then
    return json_build_object('error', 'DUPLICATE_INVOICE', 'grv_display', g.grv_display,
      'message', 'Invoice ' || g.invoice_no || ' from ' || s.name || ' was already received as ' || g.grv_display || ' on ' || to_char(g.posted_at at time zone 'Africa/Harare', 'DD Mon YYYY') || '. Nothing was added.');
  end if;
  if coalesce(p_grv->>'grv_no', '') !~ '^[0-9]{1,9}$' or (p_grv->>'grv_no')::integer < 1 then raise exception 'The GRV needs its number' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_grv->'lines') is distinct from 'array' or jsonb_array_length(p_grv->'lines') not between 1 and 500 then
    raise exception 'Send between 1 and 500 lines' using errcode = 'P0001';
  end if;
  v_cost := coalesce(nullif(p_grv->'delivery'->>'cost', '')::numeric, 0);
  v_cur := upper(nullif(btrim(coalesce(p_grv->'delivery'->>'currency', '')), ''));
  if v_cost < 0 or v_cost > 10000000 then raise exception 'The delivery cost must be between 0 and 10 000 000' using errcode = 'P0001'; end if;
  if v_cost > 0 and (v_cur is null or v_cur !~ '^[A-Z]{3}$') then raise exception 'The delivery cost needs its currency (3 letters, e.g. USD)' using errcode = 'P0001'; end if;

  insert into cl_supplier_grvs (id, business_id, branch_id, terminal_id, supplier_id, invoice_no, invoice_key, grv_no, grv_display, received_by,
                                delivery_cost, delivery_currency, note, created_iso)
  values (v_id, me.business_id, me.branch_id, me.id, s.id, btrim(p_grv->>'invoice_no'), v_key, (p_grv->>'grv_no')::integer,
          coalesce(cl_dispatch_name(p_grv->>'grv_display', 40), 'GRV-' || (p_grv->>'grv_no')), cl_dispatch_name(p_grv->>'received_by', 80),
          v_cost, case when v_cost > 0 then v_cur end, cl_dispatch_name(p_grv->>'note', 200), cl_dispatch_name(p_grv->>'created_iso', 40));
  for l in select value from jsonb_array_elements(p_grv->'lines') loop
    n := n + 1;
    if coalesce(l->>'qty', '') !~ '^[0-9]{1,7}$' or (l->>'qty')::integer not between 1 and 1000000 then
      raise exception 'Line %: the quantity must be a whole number of 1 or more', n using errcode = 'P0001';
    end if;
    if cl_dispatch_name(l->>'name', 120) is null then raise exception 'Line %: the product name is missing', n using errcode = 'P0001'; end if;
    if nullif(l->>'unit_cost', '') is null or (l->>'unit_cost')::numeric < 0 then raise exception 'Line %: give the unit cost (0 or more)', n using errcode = 'P0001'; end if;
    insert into cl_supplier_grv_lines (grv_id, line_no, cat_uid, code, name, qty, unit_cost, landed_cost, old_price, new_price, price_by)
    values (v_id, n, cl_dispatch_name(l->>'cat_uid', 64), cl_dispatch_name(l->>'code', 64), cl_dispatch_name(l->>'name', 120), (l->>'qty')::integer,
            (l->>'unit_cost')::numeric, nullif(l->>'landed_cost', '')::numeric, nullif(l->>'old_price', '')::numeric, nullif(l->>'new_price', '')::numeric,
            case when nullif(l->>'new_price', '') is not null then cl_dispatch_name(l->>'price_by', 80) end);
  end loop;
  return json_build_object('ok', true, 'grv', cl_supplier_grv_json(v_id));
exception when unique_violation then
  if exists (select 1 from cl_supplier_grvs where business_id = me.business_id and supplier_id = s.id and invoice_key = v_key) then
    return json_build_object('error', 'DUPLICATE_INVOICE', 'message', 'Invoice ' || btrim(p_grv->>'invoice_no') || ' from ' || s.name || ' was just received on another till. Nothing was added.');
  end if;
  return json_build_object('error', 'GRV_NUMBER_USED', 'message', 'This till already used that GRV number. Check the date and time on this device, and its backups.');
end $fn$;

-- 5. Console: read-only ---------------------------------------------------------
create function public.cl_supplier_grvs_list(p_business_id uuid, p_limit integer)
returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  perform cl_rpn_staff(array['dispatches']);
  return coalesce((select json_agg(cl_supplier_grv_json(g.id) || jsonb_build_object('business', bz.name,
             'value', (select coalesce(sum(l.qty * l.unit_cost), 0) from cl_supplier_grv_lines l where l.grv_id = g.id)) order by g.posted_at desc)
    from (select * from cl_supplier_grvs where p_business_id is null or business_id = p_business_id order by posted_at desc
          limit least(greatest(coalesce(p_limit, 200), 1), 1000)) g
    join cl_businesses bz on bz.id = g.business_id), '[]'::json);
end $fn$;

-- 6. The business delete guard also counts suppliers and supplier GRVs -------------
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
  if array_length(parts, 1) > 0 then
    raise exception 'Can''t delete "%": it has %. Archive it instead. Nothing was deleted.',
      old.name, array_to_string(parts, ', ') using errcode = '23503';
  end if;
  return old;
end $fn$;

-- 7. Grants ---------------------------------------------------------------------
alter table public.cl_suppliers enable row level security;
alter table public.cl_supplier_grvs enable row level security;
alter table public.cl_supplier_grv_lines enable row level security;
revoke all on table public.cl_suppliers, public.cl_supplier_grvs, public.cl_supplier_grv_lines from public, anon, authenticated;
revoke all on function public.cl_invoice_key(text), public.cl_supplier_json(public.cl_suppliers), public.cl_supplier_grv_json(uuid),
  public.cl_supplier_till(text, text, text) from public, anon, authenticated;
revoke all on function public.cl_device_suppliers_pull(text, text, text), public.cl_device_supplier_save(text, text, text, jsonb),
  public.cl_device_supplier_invoice_check(text, text, text, uuid, text), public.cl_device_supplier_grv_post(text, text, text, jsonb) from public;
grant execute on function public.cl_device_suppliers_pull(text, text, text), public.cl_device_supplier_save(text, text, text, jsonb),
  public.cl_device_supplier_invoice_check(text, text, text, uuid, text), public.cl_device_supplier_grv_post(text, text, text, jsonb) to anon, authenticated;
revoke all on function public.cl_supplier_grvs_list(uuid, integer) from public, anon, authenticated;
grant execute on function public.cl_supplier_grvs_list(uuid, integer) to authenticated;

commit;
