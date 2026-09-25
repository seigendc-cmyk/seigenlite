-- =====================================================================
-- Publish Portal — staff logins and vendor tokens
--
-- Two NEW tables for the Digital Commerce Publish Portal
-- (tools/publish-portal). Nothing existing is altered: vendors,
-- vendor_listings, cl_vendors and their RLS are untouched, and neither
-- table has a foreign key into them (a foreign key would add triggers to
-- the referenced table).
--
--   portal_staff   one row per staff login. Password hashes only (scrypt,
--                  made by the portal); failed_attempts / locked_until
--                  drive the lockout, and survive a portal restart.
--   vendor_tokens  listing rights a vendor has paid for: one row per
--                  purchase, recorded by an Admin. Keyed by the device's
--                  install_id (as in cl_vendors and vendors), so a token
--                  can be recorded before the vendor's first publish.
--                  A mistaken entry is voided, never deleted.
--
-- Only the portal reads or writes these, with the service_role key:
-- RLS is on with no policies, and anon/authenticated have no grants.
--
-- Additive, one transaction, same rules as the other migrations: no
-- IF NOT EXISTS / OR REPLACE; the preflight stops on any name clash.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------
do $$
declare
  conflicts text;
begin
  select string_agg(n, ', ') into conflicts
  from (
    select 'public.' || c.relname as n
      from pg_class c join pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'public'
       and c.relname in ('portal_staff', 'vendor_tokens',
                         'portal_staff_username_key', 'vendor_tokens_install_id_starts_on_idx')
  ) c;

  if conflicts is not null then
    raise exception 'Publish Portal migration aborted: these objects already exist: %. '
      'Nothing was changed.', conflicts;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 1. Staff logins
-- ---------------------------------------------------------------------
create table public.portal_staff (
  id                    uuid primary key default gen_random_uuid(),
  username              text not null,
  display_name          text not null,
  role                  text not null,
  password_hash         text not null,
  must_change_password  boolean not null default false,
  active                boolean not null default true,
  failed_attempts       integer not null default 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz not null default now(),
  created_by            uuid references public.portal_staff(id),
  updated_at            timestamptz not null default now(),

  constraint portal_staff_username_key unique (username),
  constraint portal_staff_username_format check (username ~ '^[a-z0-9._@-]{3,64}$'),
  constraint portal_staff_display_name_len check (length(btrim(display_name)) between 1 and 80),
  constraint portal_staff_role_check check (role in ('admin', 'reviewer')),
  constraint portal_staff_password_hash_format check (password_hash like 'scrypt$%'),
  constraint portal_staff_failed_attempts_check check (failed_attempts >= 0)
);


-- ---------------------------------------------------------------------
-- 2. Vendor tokens (listing rights for a period)
-- ends_on is the last day covered: a 30-day token starting 1 Oct covers
-- 1 Oct to 30 Oct. Dates are the portal's local (Africa/Harare) dates.
-- ---------------------------------------------------------------------
create table public.vendor_tokens (
  id               uuid primary key default gen_random_uuid(),
  install_id       text not null,
  business_name    text,
  starts_on        date not null,
  days             integer not null,
  ends_on          date generated always as (starts_on + days - 1) stored,
  amount           numeric(12,2),
  currency         text,
  payment_method   text,
  reference        text,
  notes            text,
  recorded_by      uuid not null references public.portal_staff(id),
  recorded_at      timestamptz not null default now(),
  voided_at        timestamptz,
  voided_by        uuid references public.portal_staff(id),
  void_reason      text,

  constraint vendor_tokens_install_id_check check (length(btrim(install_id)) > 0),
  constraint vendor_tokens_days_check check (days between 1 and 366),
  constraint vendor_tokens_amount_check check (amount is null or amount >= 0),
  constraint vendor_tokens_currency_check check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint vendor_tokens_payment_method_len check (payment_method is null or length(payment_method) <= 40),
  constraint vendor_tokens_reference_len check (reference is null or length(reference) <= 120),
  constraint vendor_tokens_notes_len check (notes is null or length(notes) <= 500),
  constraint vendor_tokens_void_consistent check (
    (voided_at is null and voided_by is null and void_reason is null)
    or (voided_at is not null and voided_by is not null and length(btrim(coalesce(void_reason, ''))) > 0))
);

create index vendor_tokens_install_id_starts_on_idx on public.vendor_tokens (install_id, starts_on);


-- ---------------------------------------------------------------------
-- 3. Access: the portal's service_role only
-- ---------------------------------------------------------------------
alter table public.portal_staff  enable row level security;
alter table public.vendor_tokens enable row level security;

revoke all on table public.portal_staff, public.vendor_tokens from public, anon, authenticated;
grant select, insert, update on table public.portal_staff, public.vendor_tokens to service_role;
-- Staff are deactivated and tokens voided, never deleted: keep the record.
revoke delete, truncate on table public.portal_staff, public.vendor_tokens from service_role;
