-- =====================================================================
-- Publish Portal — vendor tokens: record the RPN, require payment
--
-- Scoped to public.vendor_tokens (the portal's own table). cl_rpn,
-- cl_vendors, cl_ledger_entries and their RLS / grants are untouched; the
-- portal only reads cl_rpn and cl_vendors.
--
--   1. vendor_tokens.rpn_id -> cl_rpn(id): the RPN a payment is credited
--      to, recorded on the token itself (the portal pre-fills it from
--      cl_vendors.rpn_id). Reports group by this column, so history stays
--      right if a vendor is later moved to another RPN. Nullable: "No RPN".
--      The foreign key means an RPN that has tokens can't be deleted from
--      cl_rpn (deactivating it is unaffected).
--   2. New tokens must carry a payment: amount > 0, a 3-letter currency and
--      a payment method. Enforced by a BEFORE INSERT trigger, so it applies
--      to new records only: the tokens recorded before this (two have no
--      amount) are left exactly as they are and can still be voided.
--      reference stays optional (cash has none).
--
-- Additive, one transaction; the preflight stops on a name clash.
-- =====================================================================

do $$
declare
  conflicts text;
begin
  if to_regclass('public.vendor_tokens') is null or to_regclass('public.cl_rpn') is null then
    raise exception 'vendor_tokens_rpn_and_payment aborted: vendor_tokens or cl_rpn not found. Nothing was changed.';
  end if;
  select string_agg(n, ', ') into conflicts from (
    select 'column vendor_tokens.rpn_id' n from information_schema.columns
     where table_schema = 'public' and table_name = 'vendor_tokens' and column_name = 'rpn_id'
    union all
    select 'function vendor_tokens_require_payment()' where to_regprocedure('public.vendor_tokens_require_payment()') is not null
    union all
    select 'index vendor_tokens_rpn_id_idx' where to_regclass('public.vendor_tokens_rpn_id_idx') is not null
  ) x;
  if conflicts is not null then
    raise exception 'vendor_tokens_rpn_and_payment aborted: already exists: %. Nothing was changed.', conflicts;
  end if;
end $$;


-- 1. The RPN on each token.
alter table public.vendor_tokens
  add column rpn_id uuid constraint vendor_tokens_rpn_id_fkey references public.cl_rpn(id);

create index vendor_tokens_rpn_id_idx on public.vendor_tokens (rpn_id);


-- 2. Payment required on every new token.
create function public.vendor_tokens_require_payment()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.amount is null or new.amount <= 0 then
    raise exception 'A token needs the amount paid (more than 0).' using errcode = 'check_violation';
  end if;
  if new.currency is null or new.currency !~ '^[A-Z]{3}$' then
    raise exception 'A token needs the currency of the payment (3-letter code, e.g. USD).' using errcode = 'check_violation';
  end if;
  if new.payment_method is null or btrim(new.payment_method) = '' then
    raise exception 'A token needs the payment method.' using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.vendor_tokens_require_payment() from public, anon, authenticated;

create trigger vendor_tokens_require_payment
  before insert on public.vendor_tokens
  for each row execute function public.vendor_tokens_require_payment();
