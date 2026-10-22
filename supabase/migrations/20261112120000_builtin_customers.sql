-- =====================================================================
-- Built-in customers locked on seiGEN (owner decision 4, 20 Oct 2026; v34, Batch 2).
-- Applied live only after the owner has seen this file and said "apply".
-- Rollback: supabase/rollbacks/20261112120000_builtin_customers.rollback.sql
-- Tested in PGlite: supabase/tests/builtin-customers-test.js
--
-- Every till (v34) has the same two built-in customers, "Cash Sale"
-- (uid b1170000000000000000000000000001) and "Wholesale" (uid b1170000000000000000000000000002): locked,
-- no edit, no delete, no credit. The tills never send them to the
-- business's customer list. This makes seiGEN refuse them too:
-- cl_device_customer_save returns {ok:false, error:'BUILTIN_LOCKED'} for
-- those two uids, so no till (an old one, or a changed one) can
-- create or change a customer under those uids.
-- The function is as in 20261109120000_office_seats.sql plus the lines
-- marked "v34". No table, grant or data changes.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
begin
  if to_regprocedure('public.cl_device_customer_save(text,text,text,jsonb)') is null then
    raise exception 'builtin_customers aborted: missing function cl_device_customer_save. Nothing was changed.';
  end if;
  if position('cl_seat_need(''create_customers'')' in pg_get_functiondef('public.cl_device_customer_save(text,text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'builtin_customers aborted: cl_device_customer_save is not the 20261109120000_office_seats version. Nothing was changed.';
  end if;
  if position('BUILTIN_LOCKED' in pg_get_functiondef('public.cl_device_customer_save(text,text,text,jsonb)'::regprocedure)) > 0 then
    raise exception 'builtin_customers aborted: already there. Nothing was changed.';
  end if;
end $$;

-- 1. The save refuses the built-in uids ------------------------------------
create or replace function public.cl_device_customer_save(p_install_id text, p_secret_phrase text, p_device_key text, p_customer jsonb) returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; cur cl_customers%rowtype; dup cl_customers%rowtype; c cl_customers%rowtype;
        v_uid text := btrim(coalesce(p_customer->>'uid', '')); v_name text := btrim(coalesce(p_customer->>'name', ''));
        v_phone text := btrim(coalesce(p_customer->>'phone', '')); v_norm text; v_type text := coalesce(nullif(p_customer->>'customer_type', ''), 'retail');
        v_limit numeric;
begin
  me := cl_customer_till(p_install_id, p_secret_phrase, p_device_key);
  perform cl_seat_need('create_customers');                                  -- office seats
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;
  perform 1 from cl_businesses where id = me.business_id for update;      -- one save at a time per business: phones stay unique, seq ordered
  if v_uid !~ '^[A-Za-z0-9-]{8,64}$' then raise exception 'A customer needs its uid' using errcode = 'P0001'; end if;
  if v_uid in ('b1170000000000000000000000000001', 'b1170000000000000000000000000002') then                                          -- v34 (decision 4): Cash Sale and Wholesale are built in
    return json_build_object('ok', false, 'error', 'BUILTIN_LOCKED',
      'message', 'Cash Sale and Wholesale are built in on every till. They can''t be saved, changed or deleted.');
  end if;
  if v_name = '' then raise exception 'A customer needs a name' using errcode = 'P0001'; end if;
  v_norm := cl_norm_phone(v_phone);
  if v_norm is null then raise exception 'A customer needs a valid phone number (e.g. 07x xxx xxxx)' using errcode = 'P0001'; end if;
  if v_type not in ('retail', 'wholesale') then raise exception 'Customer type is retail or wholesale' using errcode = 'P0001'; end if;
  v_limit := nullif(p_customer->>'credit_limit', '')::numeric;
  select * into dup from cl_customers where business_id = me.business_id and phone_norm = v_norm and customer_uid <> v_uid;
  if found then
    return json_build_object('ok', false, 'error', 'DUPLICATE_PHONE',
      'message', 'A customer with this phone already exists: ' || dup.name || '.', 'existing', cl_customer_json(dup));
  end if;
  select * into cur from cl_customers where business_id = me.business_id and customer_uid = v_uid for update;
  insert into cl_customers as x (business_id, customer_uid, name, phone, phone_norm, customer_type, credit_limit, address, national_id,
                                 active, change_seq, created_terminal, updated_terminal)
  values (me.business_id, v_uid, v_name, v_phone, v_norm, v_type, v_limit, nullif(btrim(coalesce(p_customer->>'address', '')), ''),
          nullif(btrim(coalesce(p_customer->>'national_id', '')), ''), coalesce((p_customer->>'active')::boolean, true),
          nextval('cl_customers_seq'), me.id, me.id)
  on conflict (business_id, customer_uid) do update set
    name = excluded.name, phone = excluded.phone, phone_norm = excluded.phone_norm, customer_type = excluded.customer_type,
    credit_limit = excluded.credit_limit, address = excluded.address, national_id = excluded.national_id, active = excluded.active,
    change_seq = excluded.change_seq, updated_terminal = excluded.updated_terminal, updated_at = now()
  returning * into c;
  return json_build_object('ok', true, 'customer', cl_customer_json(c), 'created', cur.customer_uid is null);
end $fn$;

commit;
