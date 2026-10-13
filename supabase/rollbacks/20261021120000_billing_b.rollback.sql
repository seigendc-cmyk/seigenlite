-- Rollback of 20261021120000_billing_b.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- cl_branch_register goes back to 20261004180000's body (no duplicate check);
-- the warnings and merge functions are dropped. A merge already run is DATA
-- and is not undone here (see docs/billing/chipo-merge-design.md).

begin;

drop function if exists public.cl_business_merge(uuid, uuid, text, boolean);
drop function if exists public.cl_business_merge_core(uuid, uuid, text, boolean, uuid);
drop function if exists public.cl_licence_link_warnings(text);
drop function if exists public.cl_business_name_twins(uuid);

-- 20261004180000's body, as it was
create or replace function public.cl_branch_register(
  p_install_id text, p_secret_phrase text, p_device_key text,
  p_business_name text, p_branch_name text, p_legacy_branch_id text default null,
  p_label text default null, p_device_code text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v cl_vendors%rowtype; t cl_terminals%rowtype; biz uuid; br uuid;
begin
  v := cl_install_vendor(p_install_id, p_secret_phrase, p_device_key, true, p_business_name, p_device_code);

  select * into t from cl_terminals where vendor_id = v.id;
  if found then
    if not t.active then return json_build_object('error', 'TERMINAL_INACTIVE'); end if;   -- Phase 2
    if not (select is_main from cl_branches where id = t.branch_id) then
      raise exception 'This device already belongs to a branch that is not the main branch' using errcode = 'P0001';
    end if;
    return cl_terminal_json(t.id);
  end if;
  if v.business_id is not null then
    raise exception 'This device is already linked to a business' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_branch_name,''))) = 0 then raise exception 'Branch name is required'; end if;

  insert into cl_businesses (name, secret_phrase_hash, created_by_vendor_id)
  values (coalesce(nullif(btrim(coalesce(p_business_name,'')), ''), v.business_name),
          extensions.crypt(cl_norm_phrase(p_secret_phrase), extensions.gen_salt('bf')), v.id)
  returning id into biz;
  insert into cl_branches (business_id, name, is_main, legacy_branch_id)
  values (biz, btrim(p_branch_name), true, nullif(p_legacy_branch_id, '')) returning id into br;
  update cl_vendors set business_id = biz where id = v.id;
  insert into cl_terminals (business_id, branch_id, vendor_id, install_id, till_code, label, last_seen_ts)
  values (biz, br, v.id, v.install_id, 'T1', nullif(btrim(coalesce(p_label,'')), ''), now()) returning * into t;
  return cl_terminal_json(t.id);
end $fn$;

commit;
