-- =====================================================================
-- B4: sales sync (v35; owner decisions 3, 28, 30, 31, 35-38 of 23 Oct 2026).
-- Applied live only after the owner has seen this file and said "apply".
-- Design: docs/sync/b4-sales-sync-design.md
-- Rollback: supabase/rollbacks/20261113120000_sales_sync.rollback.sql
-- Tested in PGlite: supabase/tests/sales-sync-test.js (and the app's
-- test/b4-sales-sync.test.js against this SQL)
--
-- Every till sends its sales and money events to seiGEN, so that credit
-- limits work across the business (decision 37), other branches' sales are
-- visible by right (decision 38), and Finance (F-1) can post from them later.
--  1. One table per kind of document. Lines, payments and refunds are kept
--     as jsonb inside their document (one row per document). Every row
--     carries the business, branch and terminal of the till that SENT it
--     (never what the payload claims), its uid (one per event: a retry is
--     stored once) and history = true for the 90 days before the till's
--     first B4 check-in (decision 35: reports and the dashboard only, never
--     the books).
--  2. cl_device_b4_push: up to 100 events per call, each answered on its own
--     (stored / duplicate / refused with a code). An Office seat sends price
--     changes only (with "Edit prices"); its money events are refused.
--  3. Credit across the business (decision 37): a customer's balance = all
--     synced credit sales - credit payments - returns refunded to the debtor
--     account + balances brought forward (a till's balance from before the
--     90-day window, and amounts carried by retention). cl_device_credit_check
--     decides before a credit sale is committed, under a per-customer lock,
--     counting the other tills' holds still in flight; cl_device_credit_balances
--     gives the tills the balances for the offline rule (decision 3).
--  4. Daily summaries per branch and till (cl_sales_daily), kept for good;
--     full detail kept 13 months (decision 36): at most once a day per
--     business a push removes older detail, after carrying its effect on each
--     customer's balance into a brought-forward row (no balance changes).
--  5. cl_device_branch_report: as 20261107120000_shop_roles plus the kinds
--     'sales' and 'payouts' (decision 38; costs only with "View costs").
-- RLS on every new table; no table grants to anon/authenticated. Nothing
-- else changes: no existing table, and no existing function except
-- cl_device_branch_report.
-- =====================================================================

begin;

-- 0. Preflight ----------------------------------------------------------
do $$
declare missing text; conflicts text;
begin
  select string_agg(n, ', ') into missing from (
    select 'function cl_dispatch_caller (20261017120000)' n where to_regprocedure('public.cl_dispatch_caller(text,text,text)') is null
    union all select 'function cl_staff_has (20261107120000)' where to_regprocedure('public.cl_staff_has(text,uuid,text)') is null
    union all select 'function cl_seat_need (20261109120000)' where to_regprocedure('public.cl_seat_need(text)') is null
    union all select 'function cl_device_branch_report (20261107120000)' where to_regprocedure('public.cl_device_branch_report(text,text,text,text,text,uuid,timestamptz,timestamptz)') is null
    union all select 'column cl_terminals.device_kind (20261109120000)' where not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cl_terminals' and column_name = 'device_kind')
    union all select 'table cl_customers (20261018180000)' where to_regclass('public.cl_customers') is null
  ) x;
  if missing is not null then raise exception 'sales_sync aborted: missing %. Nothing was changed.', missing; end if;
  if position('supplier_grvs' in pg_get_functiondef('public.cl_device_branch_report(text,text,text,text,text,uuid,timestamptz,timestamptz)'::regprocedure)) = 0
     or position('''payouts''' in pg_get_functiondef('public.cl_device_branch_report(text,text,text,text,text,uuid,timestamptz,timestamptz)'::regprocedure)) > 0 then
    raise exception 'sales_sync aborted: cl_device_branch_report is not the 20261107120000_shop_roles version. Nothing was changed.';
  end if;
  select string_agg(n, ', ') into conflicts from (
    select 'table ' || t n from unnest(array['cl_sales', 'cl_sale_returns', 'cl_credit_payments', 'cl_payouts', 'cl_eod_closes', 'cl_credit_overrides',
      'cl_price_change_log', 'cl_voucher_events', 'cl_credit_bf', 'cl_credit_holds', 'cl_sales_daily', 'cl_b4_runs']) t where to_regclass('public.' || t) is not null
    union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cl_b4_txt', 'cl_b4_num', 'cl_b4_uid_ok', 'cl_b4_methods_add', 'cl_b4_daily', 'cl_b4_balance', 'cl_b4_store', 'cl_b4_retention',
                      'cl_device_b4_push', 'cl_device_credit_check', 'cl_device_credit_balances')
  ) x;
  if conflicts is not null then raise exception 'sales_sync aborted: already exists: %. Nothing was changed.', conflicts; end if;
end $$;

-- 1. Tables ---------------------------------------------------------------
-- Common: business_id (on delete restrict: a business with synced sales can't be
-- deleted by accident), uid, branch_id + terminal_id (the till that sent it),
-- history, received_at.
create table public.cl_sales (
  business_id     uuid not null references public.cl_businesses(id) on delete restrict,
  uid             text not null check (uid ~ '^[A-Za-z0-9-]{8,80}$'),
  branch_id       uuid not null references public.cl_branches(id),
  terminal_id     uuid not null references public.cl_terminals(id),
  receipt_no      text check (receipt_no is null or length(receipt_no) <= 40),
  sold_at         timestamptz not null,
  bday            date not null,
  operator        text check (operator is null or length(operator) <= 80),
  staff_id        uuid,
  customer_uid    text check (customer_uid is null or customer_uid ~ '^[A-Za-z0-9-]{8,64}$'),
  price_level     text check (price_level is null or price_level in ('retail', 'wholesale')),
  base_symbol     text check (base_symbol is null or length(base_symbol) <= 8),
  subtotal        numeric(14,2),
  discount        numeric(14,2),
  total           numeric(14,2) not null,
  voucher_amount  numeric(14,2),
  credit_amount   numeric(14,2) not null default 0,
  credit_check    text check (credit_check is null or credit_check in ('online', 'offline')),
  credit_scope    text check (credit_scope is null or credit_scope in ('till', 'business', 'last_sync')),
  credit_before   numeric(14,2),
  credit_after    numeric(14,2),
  credit_limit_at numeric(14,2),
  credit_override text check (credit_override is null or length(credit_override) <= 160),
  credit_override_mode text check (credit_override_mode is null or length(credit_override_mode) <= 40),
  payment_ref     text check (payment_ref is null or length(payment_ref) <= 80),
  doc_ref         text check (doc_ref is null or length(doc_ref) <= 80),
  cost_total      numeric(14,2),
  lines           jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) <= 500),
  payments        jsonb not null check (jsonb_typeof(payments) = 'array' and jsonb_array_length(payments) <= 20),
  history         boolean not null default false,
  received_at     timestamptz not null default now(),
  primary key (business_id, uid)
);
create index cl_sales_branch_idx on public.cl_sales (business_id, branch_id, sold_at);
create index cl_sales_customer_idx on public.cl_sales (business_id, customer_uid) where credit_amount <> 0;
create index cl_sales_age_idx on public.cl_sales (sold_at);

create table public.cl_sale_returns (
  business_id    uuid not null references public.cl_businesses(id) on delete restrict,
  uid            text not null check (uid ~ '^[A-Za-z0-9-]{8,80}$'),
  branch_id      uuid not null references public.cl_branches(id),
  terminal_id    uuid not null references public.cl_terminals(id),
  cn_display     text check (cn_display is null or length(cn_display) <= 40),
  sale_uid       text check (sale_uid is null or length(sale_uid) <= 80),
  sale_receipt   text check (sale_receipt is null or length(sale_receipt) <= 40),
  returned_at    timestamptz not null,
  bday           date not null,
  customer_uid   text check (customer_uid is null or customer_uid ~ '^[A-Za-z0-9-]{8,64}$'),
  reason         text check (reason is null or length(reason) <= 80),
  reason_note    text check (reason_note is null or length(reason_note) <= 200),
  started_by     text check (started_by is null or length(started_by) <= 80),
  approved_by    text check (approved_by is null or length(approved_by) <= 80),
  goods_total    numeric(14,2) not null,
  cost_reversed  numeric(14,2),
  debtor_amount  numeric(14,2) not null default 0,
  lines          jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) <= 500),
  refunds        jsonb not null check (jsonb_typeof(refunds) = 'array' and jsonb_array_length(refunds) <= 20),
  history        boolean not null default false,
  received_at    timestamptz not null default now(),
  primary key (business_id, uid)
);
create index cl_sale_returns_branch_idx on public.cl_sale_returns (business_id, branch_id, returned_at);
create index cl_sale_returns_customer_idx on public.cl_sale_returns (business_id, customer_uid) where debtor_amount <> 0;
create index cl_sale_returns_age_idx on public.cl_sale_returns (returned_at);

create table public.cl_credit_payments (
  business_id   uuid not null references public.cl_businesses(id) on delete restrict,
  uid           text not null check (uid ~ '^[A-Za-z0-9-]{8,80}$'),
  branch_id     uuid not null references public.cl_branches(id),
  terminal_id   uuid not null references public.cl_terminals(id),
  customer_uid  text not null check (customer_uid ~ '^[A-Za-z0-9-]{8,64}$'),
  paid_at       timestamptz not null,
  bday          date not null,
  amount        numeric(14,2) not null,
  method        text check (method is null or length(method) <= 40),       -- not recorded by the tills yet (design §2)
  reference     text check (reference is null or length(reference) <= 200),
  operator      text check (operator is null or length(operator) <= 80),
  staff_id      uuid,
  history       boolean not null default false,
  received_at   timestamptz not null default now(),
  primary key (business_id, uid)
);
create index cl_credit_payments_customer_idx on public.cl_credit_payments (business_id, customer_uid);
create index cl_credit_payments_age_idx on public.cl_credit_payments (paid_at);

create table public.cl_payouts (
  business_id   uuid not null references public.cl_businesses(id) on delete restrict,
  uid           text not null check (uid ~ '^[A-Za-z0-9-]{8,80}$'),
  branch_id     uuid not null references public.cl_branches(id),
  terminal_id   uuid not null references public.cl_terminals(id),
  paid_at       timestamptz not null,
  bday          date not null,
  amount        numeric(14,2) not null,
  currency      text check (currency is null or length(currency) <= 8),
  account_tag   text check (account_tag is null or length(account_tag) <= 60),   -- the chart of accounts comes with F-1 (design §2)
  reason        text check (reason is null or length(reason) <= 200),
  operator      text check (operator is null or length(operator) <= 80),
  staff_id      uuid,
  approved_by   text check (approved_by is null or length(approved_by) <= 80),
  source        text check (source is null or length(source) <= 40),
  history       boolean not null default false,
  received_at   timestamptz not null default now(),
  primary key (business_id, uid)
);
create index cl_payouts_branch_idx on public.cl_payouts (business_id, branch_id, paid_at);
create index cl_payouts_age_idx on public.cl_payouts (paid_at);

create table public.cl_eod_closes (
  business_id    uuid not null references public.cl_businesses(id) on delete restrict,
  uid            text not null check (uid ~ '^[A-Za-z0-9-]{8,80}$'),
  branch_id      uuid not null references public.cl_branches(id),
  terminal_id    uuid not null references public.cl_terminals(id),
  bday           date not null,
  opened_at      timestamptz,
  closed_at      timestamptz not null,
  opening_float  numeric(14,2),
  expected_cash  numeric(14,2),
  counted_cash   numeric(14,2),
  variance       numeric(14,2),
  notes          text check (notes is null or length(notes) <= 500),
  by_currency    jsonb not null default '[]'::jsonb check (jsonb_typeof(by_currency) = 'array' and jsonb_array_length(by_currency) <= 20),
  totals         jsonb not null default '{}'::jsonb check (jsonb_typeof(totals) = 'object'),
  opened_by      text check (opened_by is null or length(opened_by) <= 80),
  closed_by      text check (closed_by is null or length(closed_by) <= 80),
  history        boolean not null default false,
  received_at    timestamptz not null default now(),
  primary key (business_id, uid)
);
create index cl_eod_closes_branch_idx on public.cl_eod_closes (business_id, branch_id, bday);
create index cl_eod_closes_age_idx on public.cl_eod_closes (closed_at);

create table public.cl_credit_overrides (
  business_id     uuid not null references public.cl_businesses(id) on delete restrict,
  uid             text not null check (uid ~ '^[A-Za-z0-9-]{8,80}$'),
  branch_id       uuid not null references public.cl_branches(id),
  terminal_id     uuid not null references public.cl_terminals(id),
  sale_uid        text not null check (length(sale_uid) <= 80),
  customer_uid    text check (customer_uid is null or customer_uid ~ '^[A-Za-z0-9-]{8,64}$'),
  at              timestamptz not null,
  amount_over     numeric(14,2),
  credit_limit    numeric(14,2),
  balance_before  numeric(14,2),
  balance_after   numeric(14,2),
  by_name         text check (by_name is null or length(by_name) <= 160),
  mode            text check (mode is null or length(mode) <= 40),
  right_held      boolean,
  single_operator boolean not null default false,
  checked         text check (checked is null or checked in ('online', 'offline')),
  history         boolean not null default false,
  received_at     timestamptz not null default now(),
  primary key (business_id, uid)
);
create index cl_credit_overrides_branch_idx on public.cl_credit_overrides (business_id, branch_id, at);
create index cl_credit_overrides_age_idx on public.cl_credit_overrides (at);

create table public.cl_price_change_log (
  business_id   uuid not null references public.cl_businesses(id) on delete restrict,
  uid           text not null check (uid ~ '^[A-Za-z0-9-]{8,80}$'),
  branch_id     uuid not null references public.cl_branches(id),
  terminal_id   uuid not null references public.cl_terminals(id),
  changed_at    timestamptz not null,
  product_uid   text check (product_uid is null or length(product_uid) <= 64),
  cat_uid       text check (cat_uid is null or length(cat_uid) <= 64),
  code          text check (code is null or length(code) <= 64),
  name          text check (name is null or length(name) <= 120),
  old_price     numeric(14,2),
  new_price     numeric(14,2),
  cost          numeric(14,2),
  below_cost    boolean not null default false,
  by_name       text check (by_name is null or length(by_name) <= 80),
  how           text check (how is null or length(how) <= 40),
  history       boolean not null default false,
  received_at   timestamptz not null default now(),
  primary key (business_id, uid)
);
create index cl_price_change_log_branch_idx on public.cl_price_change_log (business_id, branch_id, changed_at);
create index cl_price_change_log_age_idx on public.cl_price_change_log (changed_at);

create table public.cl_voucher_events (
  business_id   uuid not null references public.cl_businesses(id) on delete restrict,
  uid           text not null check (uid ~ '^[A-Za-z0-9-]{8,80}$'),
  branch_id     uuid not null references public.cl_branches(id),
  terminal_id   uuid not null references public.cl_terminals(id),
  at            timestamptz not null,
  kind          text not null check (kind in ('issue', 'use')),
  voucher_uid   text not null check (length(voucher_uid) <= 80),
  voucher_kind  text check (voucher_kind is null or length(voucher_kind) <= 20),
  customer_uid  text check (customer_uid is null or customer_uid ~ '^[A-Za-z0-9-]{8,64}$'),
  amount        numeric(14,2),
  sale_uid      text check (sale_uid is null or length(sale_uid) <= 80),
  cn_uid        text check (cn_uid is null or length(cn_uid) <= 80),
  history       boolean not null default false,
  received_at   timestamptz not null default now(),
  primary key (business_id, uid)
);
create index cl_voucher_events_age_idx on public.cl_voucher_events (at);

-- Balances brought forward: a till's balance for a customer from before its
-- 90-day history window (source 'till', one per till and customer), and what
-- retention carried when it removed old detail (source 'retention', one per customer).
create table public.cl_credit_bf (
  business_id   uuid not null references public.cl_businesses(id) on delete restrict,
  uid           text not null check (uid ~ '^[A-Za-z0-9-]{8,160}$'),
  terminal_id   uuid references public.cl_terminals(id),
  customer_uid  text not null check (customer_uid ~ '^[A-Za-z0-9-]{8,64}$'),
  amount        numeric(14,2) not null,
  as_of         timestamptz not null,
  source        text not null check (source in ('till', 'retention')),
  received_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (business_id, uid)
);
create index cl_credit_bf_customer_idx on public.cl_credit_bf (business_id, customer_uid);

-- A credit sale checked online but not arrived yet (decision 37: two tills at
-- once can't both use the same available credit). Ends when the sale arrives,
-- or after 24 hours (a safety net for a sale that was never finished).
create table public.cl_credit_holds (
  business_id   uuid not null references public.cl_businesses(id) on delete cascade,
  sale_uid      text not null check (sale_uid ~ '^[A-Za-z0-9-]{8,80}$'),
  customer_uid  text not null check (customer_uid ~ '^[A-Za-z0-9-]{8,64}$'),
  terminal_id   uuid not null references public.cl_terminals(id) on delete cascade,
  amount        numeric(14,2) not null check (amount > 0),
  override      boolean not null default false,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '24 hours',
  primary key (business_id, sale_uid)
);
create index cl_credit_holds_customer_idx on public.cl_credit_holds (business_id, customer_uid, expires_at);

-- Daily summary per business day, branch and till (decision 36: kept for good).
create table public.cl_sales_daily (
  business_id     uuid not null references public.cl_businesses(id) on delete restrict,
  terminal_id     uuid not null references public.cl_terminals(id),
  bday            date not null,
  branch_id       uuid not null references public.cl_branches(id),
  sales_count     integer not null default 0,
  sales_total     numeric(16,2) not null default 0,
  discount_total  numeric(16,2) not null default 0,
  cost_total      numeric(16,2) not null default 0,
  credit_total    numeric(16,2) not null default 0,
  returns_count   integer not null default 0,
  returns_total   numeric(16,2) not null default 0,
  payouts_count   integer not null default 0,
  payouts_total   numeric(16,2) not null default 0,
  by_method       jsonb not null default '{}'::jsonb,
  history         boolean not null default false,          -- true while every event of the day was history
  updated_at      timestamptz not null default now(),
  primary key (business_id, terminal_id, bday)
);
create index cl_sales_daily_branch_idx on public.cl_sales_daily (business_id, branch_id, bday);

create table public.cl_b4_runs (
  business_id     uuid primary key references public.cl_businesses(id) on delete cascade,
  retention_on    date not null
);

alter table public.cl_sales enable row level security;
alter table public.cl_sale_returns enable row level security;
alter table public.cl_credit_payments enable row level security;
alter table public.cl_payouts enable row level security;
alter table public.cl_eod_closes enable row level security;
alter table public.cl_credit_overrides enable row level security;
alter table public.cl_price_change_log enable row level security;
alter table public.cl_voucher_events enable row level security;
alter table public.cl_credit_bf enable row level security;
alter table public.cl_credit_holds enable row level security;
alter table public.cl_sales_daily enable row level security;
alter table public.cl_b4_runs enable row level security;
revoke all on table public.cl_sales, public.cl_sale_returns, public.cl_credit_payments, public.cl_payouts, public.cl_eod_closes,
  public.cl_credit_overrides, public.cl_price_change_log, public.cl_voucher_events, public.cl_credit_bf, public.cl_credit_holds,
  public.cl_sales_daily, public.cl_b4_runs from public, anon, authenticated;

-- 2. Helpers (internal) ---------------------------------------------------------------
create function public.cl_b4_txt(p jsonb, k text, n integer) returns text
language sql immutable as $$ select left(nullif(btrim(coalesce(p->>k, '')), ''), n) $$;
create function public.cl_b4_num(p jsonb, k text) returns numeric
language sql immutable as $$ select round(nullif(btrim(coalesce(p->>k, '')), '')::numeric, 2) $$;
create function public.cl_b4_uid_ok(u text) returns text
language sql immutable as $$ select case when u ~ '^[A-Za-z0-9-]{8,64}$' then u end $$;

-- A day's payment methods: old totals + (or -) a document's payment lines.
create function public.cl_b4_methods_add(p_old jsonb, p_lines jsonb, p_sign numeric) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, round(v, 2)), '{}'::jsonb) from (
    select k, sum(v) v from (
      select key k, value::numeric v from jsonb_each_text(coalesce(p_old, '{}'::jsonb))
      union all
      select left(coalesce(nullif(e->>'method', ''), '?'), 40), p_sign * coalesce(nullif(e->>'amount', '')::numeric, 0)
        from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
    ) x group by k) y
$$;

-- Adds one stored document to its day's summary.
create function public.cl_b4_daily(me public.cl_terminals, p_bday date, p_history boolean, p_kind text, p_amount numeric,
                                   p_discount numeric, p_cost numeric, p_credit numeric, p_lines jsonb) returns void
language plpgsql security definer set search_path = public as $fn$
begin
  insert into cl_sales_daily as d (business_id, terminal_id, bday, branch_id, history)
  values (me.business_id, me.id, p_bday, me.branch_id, p_history)
  on conflict (business_id, terminal_id, bday) do update set history = d.history and excluded.history;
  update cl_sales_daily d set
    sales_count    = d.sales_count + case when p_kind = 'sale' then 1 else 0 end,
    sales_total    = d.sales_total + case when p_kind = 'sale' then coalesce(p_amount, 0) else 0 end,
    discount_total = d.discount_total + case when p_kind = 'sale' then coalesce(p_discount, 0) else 0 end,
    cost_total     = d.cost_total + case when p_kind = 'sale' then coalesce(p_cost, 0) when p_kind = 'return' then -coalesce(p_cost, 0) else 0 end,
    credit_total   = d.credit_total + case when p_kind = 'sale' then coalesce(p_credit, 0) else 0 end,
    returns_count  = d.returns_count + case when p_kind = 'return' then 1 else 0 end,
    returns_total  = d.returns_total + case when p_kind = 'return' then coalesce(p_amount, 0) else 0 end,
    payouts_count  = d.payouts_count + case when p_kind = 'payout' then 1 else 0 end,
    payouts_total  = d.payouts_total + case when p_kind = 'payout' then coalesce(p_amount, 0) else 0 end,
    by_method      = case when p_kind = 'sale' then cl_b4_methods_add(d.by_method, p_lines, 1)
                          when p_kind = 'return' then cl_b4_methods_add(d.by_method, p_lines, -1) else d.by_method end,
    updated_at     = now()
   where d.business_id = me.business_id and d.terminal_id = me.id and d.bday = p_bday;
end $fn$;

-- A customer's balance for the whole business (decision 37): the same formula
-- as the till's own (src/pos.js customerBalance), over every till, plus what was brought forward.
create function public.cl_b4_balance(p_business uuid, p_customer text) returns numeric
language sql stable security definer set search_path = public as $$
  select round(
      coalesce((select sum(credit_amount) from cl_sales where business_id = p_business and customer_uid = p_customer and credit_amount <> 0), 0)
    - coalesce((select sum(amount) from cl_credit_payments where business_id = p_business and customer_uid = p_customer), 0)
    - coalesce((select sum(debtor_amount) from cl_sale_returns where business_id = p_business and customer_uid = p_customer and debtor_amount <> 0), 0)
    + coalesce((select sum(amount) from cl_credit_bf where business_id = p_business and customer_uid = p_customer), 0), 2)
$$;

-- Stores one event for the calling till: 'stored' | 'duplicate'; raises on bad data.
create function public.cl_b4_store(me public.cl_terminals, e jsonb) returns text
language plpgsql security definer set search_path = public as $fn$
declare v_uid text := btrim(coalesce(e->>'uid', '')); v_kind text := coalesce(e->>'kind', ''); d jsonb := coalesce(e->'data', '{}'::jsonb);
        v_hist boolean := coalesce((e->>'history')::boolean, false); v_ts timestamptz; v_bday date; v_n integer := 0;
        v_lines jsonb; v_pay jsonb; v_credit numeric; v_cost numeric; v_debtor numeric;
begin
  v_ts := nullif(e->>'ts', '')::timestamptz;
  if v_ts is null then raise exception 'BAD_EVENT: the event has no time' using errcode = 'P0001'; end if;
  v_bday := coalesce(nullif(e->>'bday', '')::date, v_ts::date);
  if v_kind = 'sale' then
    v_lines := coalesce(d->'lines', '[]'::jsonb); v_pay := coalesce(d->'payments', '[]'::jsonb);
    if jsonb_typeof(v_lines) <> 'array' or jsonb_typeof(v_pay) <> 'array' then raise exception 'BAD_EVENT: a sale''s lines and payments are lists' using errcode = 'P0001'; end if;
    v_credit := coalesce((select sum(nullif(x->>'amount', '')::numeric) from jsonb_array_elements(v_pay) x where x->>'method' = 'Credit'), 0);
    v_cost := (select sum(coalesce(nullif(x->>'cost', '')::numeric, 0) * coalesce(nullif(x->>'qty', '')::numeric, 0)) from jsonb_array_elements(v_lines) x);
    insert into cl_sales (business_id, uid, branch_id, terminal_id, receipt_no, sold_at, bday, operator, staff_id, customer_uid, price_level, base_symbol,
                          subtotal, discount, total, voucher_amount, credit_amount, credit_check, credit_scope, credit_before, credit_after, credit_limit_at,
                          credit_override, credit_override_mode, payment_ref, doc_ref, cost_total, lines, payments, history)
    values (me.business_id, v_uid, me.branch_id, me.id, cl_b4_txt(d, 'receipt_no', 40), v_ts, v_bday, cl_b4_txt(d, 'operator', 80),
            nullif(d->>'staff_id', '')::uuid, cl_b4_uid_ok(d->>'customer_uid'), nullif(d->>'price_level', ''), cl_b4_txt(d, 'base_symbol', 8),
            cl_b4_num(d, 'subtotal'), cl_b4_num(d, 'discount'), coalesce(cl_b4_num(d, 'total'), 0), cl_b4_num(d, 'voucher_amount'), round(v_credit, 2),
            nullif(d->>'credit_check', ''), nullif(d->>'credit_scope', ''), cl_b4_num(d, 'credit_before'), cl_b4_num(d, 'credit_after'), cl_b4_num(d, 'credit_limit_at'),
            cl_b4_txt(d, 'credit_override', 160), cl_b4_txt(d, 'credit_override_mode', 40), cl_b4_txt(d, 'payment_ref', 80), cl_b4_txt(d, 'doc_ref', 80),
            round(v_cost, 2), v_lines, v_pay, v_hist)
    on conflict (business_id, uid) do nothing;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      delete from cl_credit_holds where business_id = me.business_id and sale_uid in (v_uid, coalesce(d->>'hold_uid', ''));   -- the hold becomes the sale itself
      perform cl_b4_daily(me, v_bday, v_hist, 'sale', cl_b4_num(d, 'total'), cl_b4_num(d, 'discount'), v_cost, v_credit, v_pay);
    end if;
  elsif v_kind = 'return' then
    v_lines := coalesce(d->'lines', '[]'::jsonb); v_pay := coalesce(d->'refunds', '[]'::jsonb);
    if jsonb_typeof(v_lines) <> 'array' or jsonb_typeof(v_pay) <> 'array' then raise exception 'BAD_EVENT: a return''s lines and refunds are lists' using errcode = 'P0001'; end if;
    v_debtor := coalesce((select sum(nullif(x->>'amount', '')::numeric) from jsonb_array_elements(v_pay) x where x->>'method' = 'Debtor'), 0);
    insert into cl_sale_returns (business_id, uid, branch_id, terminal_id, cn_display, sale_uid, sale_receipt, returned_at, bday, customer_uid, reason, reason_note,
                                 started_by, approved_by, goods_total, cost_reversed, debtor_amount, lines, refunds, history)
    values (me.business_id, v_uid, me.branch_id, me.id, cl_b4_txt(d, 'cn_display', 40), cl_b4_txt(d, 'sale_uid', 80), cl_b4_txt(d, 'sale_receipt', 40), v_ts, v_bday,
            cl_b4_uid_ok(d->>'customer_uid'), cl_b4_txt(d, 'reason', 80), cl_b4_txt(d, 'reason_note', 200), cl_b4_txt(d, 'started_by', 80), cl_b4_txt(d, 'approved_by', 80),
            coalesce(cl_b4_num(d, 'goods_total'), 0), cl_b4_num(d, 'cost_reversed'), round(v_debtor, 2), v_lines, v_pay, v_hist)
    on conflict (business_id, uid) do nothing;
    get diagnostics v_n = row_count;
    if v_n > 0 then perform cl_b4_daily(me, v_bday, v_hist, 'return', cl_b4_num(d, 'goods_total'), 0, cl_b4_num(d, 'cost_reversed'), 0, v_pay); end if;
  elsif v_kind = 'credit_payment' then
    if cl_b4_uid_ok(d->>'customer_uid') is null then raise exception 'BAD_EVENT: a credit payment needs its customer' using errcode = 'P0001'; end if;
    insert into cl_credit_payments (business_id, uid, branch_id, terminal_id, customer_uid, paid_at, bday, amount, method, reference, operator, staff_id, history)
    values (me.business_id, v_uid, me.branch_id, me.id, d->>'customer_uid', v_ts, v_bday, coalesce(cl_b4_num(d, 'amount'), 0), cl_b4_txt(d, 'method', 40),
            cl_b4_txt(d, 'reference', 200), cl_b4_txt(d, 'operator', 80), nullif(d->>'staff_id', '')::uuid, v_hist)
    on conflict (business_id, uid) do nothing;
    get diagnostics v_n = row_count;
  elsif v_kind = 'payout' then
    insert into cl_payouts (business_id, uid, branch_id, terminal_id, paid_at, bday, amount, currency, account_tag, reason, operator, staff_id, approved_by, source, history)
    values (me.business_id, v_uid, me.branch_id, me.id, v_ts, v_bday, coalesce(cl_b4_num(d, 'amount'), 0), cl_b4_txt(d, 'currency', 8), cl_b4_txt(d, 'account_tag', 60),
            cl_b4_txt(d, 'reason', 200), cl_b4_txt(d, 'operator', 80), nullif(d->>'staff_id', '')::uuid, cl_b4_txt(d, 'approved_by', 80), cl_b4_txt(d, 'source', 40), v_hist)
    on conflict (business_id, uid) do nothing;
    get diagnostics v_n = row_count;
    if v_n > 0 then perform cl_b4_daily(me, v_bday, v_hist, 'payout', cl_b4_num(d, 'amount'), 0, 0, 0, null); end if;
  elsif v_kind = 'eod' then
    insert into cl_eod_closes (business_id, uid, branch_id, terminal_id, bday, opened_at, closed_at, opening_float, expected_cash, counted_cash, variance, notes,
                               by_currency, totals, opened_by, closed_by, history)
    values (me.business_id, v_uid, me.branch_id, me.id, v_bday, nullif(d->>'opened_at', '')::timestamptz, v_ts, cl_b4_num(d, 'opening_float'),
            cl_b4_num(d, 'expected_cash'), cl_b4_num(d, 'counted_cash'), cl_b4_num(d, 'variance'), cl_b4_txt(d, 'notes', 500),
            case when jsonb_typeof(d->'by_currency') = 'array' then d->'by_currency' else '[]'::jsonb end,
            case when jsonb_typeof(d->'totals') = 'object' then d->'totals' else '{}'::jsonb end,
            cl_b4_txt(d, 'opened_by', 80), cl_b4_txt(d, 'closed_by', 80), v_hist)
    on conflict (business_id, uid) do nothing;
    get diagnostics v_n = row_count;
  elsif v_kind = 'credit_override' then
    insert into cl_credit_overrides (business_id, uid, branch_id, terminal_id, sale_uid, customer_uid, at, amount_over, credit_limit, balance_before, balance_after,
                                     by_name, mode, right_held, single_operator, checked, history)
    values (me.business_id, v_uid, me.branch_id, me.id, coalesce(cl_b4_txt(d, 'sale_uid', 80), ''), cl_b4_uid_ok(d->>'customer_uid'), v_ts, cl_b4_num(d, 'amount_over'),
            cl_b4_num(d, 'credit_limit'), cl_b4_num(d, 'balance_before'), cl_b4_num(d, 'balance_after'), cl_b4_txt(d, 'by_name', 160), cl_b4_txt(d, 'mode', 40),
            (d->>'right_held')::boolean, coalesce((d->>'single_operator')::boolean, false), nullif(d->>'checked', ''), v_hist)
    on conflict (business_id, uid) do nothing;
    get diagnostics v_n = row_count;
  elsif v_kind = 'price_change' then
    insert into cl_price_change_log (business_id, uid, branch_id, terminal_id, changed_at, product_uid, cat_uid, code, name, old_price, new_price, cost, below_cost,
                                     by_name, how, history)
    values (me.business_id, v_uid, me.branch_id, me.id, v_ts, cl_b4_txt(d, 'product_uid', 64), cl_b4_txt(d, 'cat_uid', 64), cl_b4_txt(d, 'code', 64), cl_b4_txt(d, 'name', 120),
            cl_b4_num(d, 'old_price'), cl_b4_num(d, 'new_price'), cl_b4_num(d, 'cost'),
            coalesce(cl_b4_num(d, 'cost'), 0) > 0 and coalesce(cl_b4_num(d, 'new_price'), 0) < cl_b4_num(d, 'cost'),
            cl_b4_txt(d, 'by_name', 80), cl_b4_txt(d, 'how', 40), v_hist)
    on conflict (business_id, uid) do nothing;
    get diagnostics v_n = row_count;
  elsif v_kind in ('voucher_issue', 'voucher_use') then
    insert into cl_voucher_events (business_id, uid, branch_id, terminal_id, at, kind, voucher_uid, voucher_kind, customer_uid, amount, sale_uid, cn_uid, history)
    values (me.business_id, v_uid, me.branch_id, me.id, v_ts, case when v_kind = 'voucher_use' then 'use' else 'issue' end, coalesce(cl_b4_txt(d, 'voucher_uid', 80), v_uid),
            cl_b4_txt(d, 'voucher_kind', 20), cl_b4_uid_ok(d->>'customer_uid'), cl_b4_num(d, 'amount'), cl_b4_txt(d, 'sale_uid', 80), cl_b4_txt(d, 'cn_uid', 80), v_hist)
    on conflict (business_id, uid) do nothing;
    get diagnostics v_n = row_count;
  elsif v_kind = 'credit_bf' then
    if cl_b4_uid_ok(d->>'customer_uid') is null then raise exception 'BAD_EVENT: a balance brought forward needs its customer' using errcode = 'P0001'; end if;
    insert into cl_credit_bf (business_id, uid, terminal_id, customer_uid, amount, as_of, source)
    values (me.business_id, v_uid, me.id, d->>'customer_uid', coalesce(cl_b4_num(d, 'amount'), 0), v_ts, 'till')
    on conflict (business_id, uid) do nothing;
    get diagnostics v_n = row_count;
  else
    raise exception 'BAD_EVENT: unknown kind %', left(v_kind, 40) using errcode = 'P0001';
  end if;
  return case when v_n > 0 then 'stored' else 'duplicate' end;
end $fn$;

-- Retention (decision 36): at most once a day per business. Detail older than
-- 13 months goes; each customer's balance is carried first, so it doesn't change.
create function public.cl_b4_retention(p_business uuid) returns integer
language plpgsql security definer set search_path = public as $fn$
declare v_cut timestamptz := now() - interval '13 months'; n integer := 0; m integer;
begin
  insert into cl_b4_runs as r (business_id, retention_on) values (p_business, current_date)
  on conflict (business_id) do update set retention_on = current_date where r.retention_on < current_date;
  get diagnostics m = row_count;
  if m = 0 then return 0; end if;
  insert into cl_credit_bf as b (business_id, uid, terminal_id, customer_uid, amount, as_of, source)
  select p_business, 'cf-' || x.customer_uid, null, x.customer_uid, round(sum(x.amt), 2), v_cut, 'retention'
    from (select customer_uid, credit_amount amt from cl_sales where business_id = p_business and sold_at < v_cut and credit_amount <> 0 and customer_uid is not null
          union all select customer_uid, -amount from cl_credit_payments where business_id = p_business and paid_at < v_cut
          union all select customer_uid, -debtor_amount from cl_sale_returns where business_id = p_business and returned_at < v_cut and debtor_amount <> 0 and customer_uid is not null) x
   group by x.customer_uid having round(sum(x.amt), 2) <> 0
  on conflict (business_id, uid) do update set amount = b.amount + excluded.amount, as_of = excluded.as_of, updated_at = now();
  delete from cl_sales where business_id = p_business and sold_at < v_cut;              get diagnostics m = row_count; n := n + m;
  delete from cl_sale_returns where business_id = p_business and returned_at < v_cut;   get diagnostics m = row_count; n := n + m;
  delete from cl_credit_payments where business_id = p_business and paid_at < v_cut;    get diagnostics m = row_count; n := n + m;
  delete from cl_payouts where business_id = p_business and paid_at < v_cut;            get diagnostics m = row_count; n := n + m;
  delete from cl_eod_closes where business_id = p_business and closed_at < v_cut;       get diagnostics m = row_count; n := n + m;
  delete from cl_credit_overrides where business_id = p_business and at < v_cut;        get diagnostics m = row_count; n := n + m;
  delete from cl_price_change_log where business_id = p_business and changed_at < v_cut; get diagnostics m = row_count; n := n + m;
  delete from cl_voucher_events where business_id = p_business and at < v_cut;          get diagnostics m = row_count; n := n + m;
  delete from cl_credit_holds where business_id = p_business and expires_at < now();
  return n;
end $fn$;

-- 3. The tills' calls -------------------------------------------------------------------
-- p_events: [{ uid, kind, ts, bday, history, data }], at most 100.
create function public.cl_device_b4_push(p_install_id text, p_secret_phrase text, p_device_key text, p_events jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; e jsonb; v_res jsonb := '[]'::jsonb; v_uid text; v_kind text; v_status text; v_code text; v_msg text;
        v_cut timestamptz := now() - interval '13 months'; v_ts timestamptz;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then raise exception 'Send a list of events' using errcode = 'P0001'; end if;
  if jsonb_array_length(p_events) > 100 then raise exception 'At most 100 events at a time' using errcode = 'P0001'; end if;
  for e in select x from jsonb_array_elements(p_events) x loop
    v_uid := btrim(coalesce(e->>'uid', '')); v_kind := coalesce(e->>'kind', ''); v_code := null; v_msg := null;
    begin
      if v_uid !~ '^[A-Za-z0-9-]{8,160}$' then
        v_status := 'refused'; v_code := 'BAD_EVENT'; v_msg := 'The event has no uid.';
      elsif v_kind not in ('sale', 'return', 'credit_payment', 'payout', 'eod', 'credit_override', 'price_change', 'voucher_issue', 'voucher_use', 'credit_bf') then
        v_status := 'refused'; v_code := 'BAD_EVENT'; v_msg := 'Unknown kind of event.';
      elsif me.device_kind = 'seat' and v_kind <> 'price_change' then
        v_status := 'refused'; v_code := 'SEAT_NO_SELLING'; v_msg := 'An Office seat can''t sell, take payments or run End of Day.';
      else
        v_ts := nullif(e->>'ts', '')::timestamptz;
        if v_kind <> 'credit_bf' and v_ts is not null and v_ts < v_cut then
          v_status := 'refused'; v_code := 'TOO_OLD'; v_msg := 'Older than the 13 months seiGEN keeps.';
        else
          if me.device_kind = 'seat' then perform cl_seat_need('edit_prices'); end if;   -- a seat's price change needs the signed-in person's right
          v_status := cl_b4_store(me, e);
        end if;
      end if;
    exception when others then
      v_status := 'refused';
      v_code := case when sqlerrm like 'SEAT_NO_RIGHT%' then 'SEAT_NO_RIGHT' when sqlerrm like 'SEAT_SIGN_IN%' then 'SEAT_SIGN_IN' when sqlerrm like 'BAD_EVENT%' then 'BAD_EVENT' else 'INVALID' end;
      v_msg := left(regexp_replace(sqlerrm, '^[A-Z_]+: ', ''), 200);
    end;
    v_res := v_res || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('uid', v_uid, 'kind', v_kind, 'status', v_status, 'code', v_code, 'message', v_msg)));
  end loop;
  perform cl_b4_retention(me.business_id);
  return json_build_object('ok', true, 'server_time', now(), 'results', v_res);
end $fn$;

-- Before a credit sale is committed (decision 37). p_limit: the till's limit for a
-- customer seiGEN doesn't know (kept on that till only); seiGEN's own limit wins
-- otherwise. allowed: the sale fits (or p_override: the till's override, decision 30).
-- An allowed sale is held under its uid until it arrives.
create function public.cl_device_credit_check(p_install_id text, p_secret_phrase text, p_device_key text, p_customer_uid text, p_sale_uid text,
                                              p_amount numeric, p_limit numeric default null, p_override boolean default false)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype; c cl_customers%rowtype; v_limit numeric; v_bal numeric; v_held numeric; v_after numeric; v_ok boolean;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if me.device_kind = 'seat' then return json_build_object('error', 'SEAT_NO_SELLING', 'message', 'An Office seat can''t sell, take payments or run End of Day.'); end if;
  if cl_b4_uid_ok(p_customer_uid) is null or coalesce(p_sale_uid, '') !~ '^[A-Za-z0-9-]{8,80}$' then raise exception 'Give the customer and the sale' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 then raise exception 'Give the credit amount' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cl_credit|' || me.business_id::text || '|' || p_customer_uid, 0));   -- one check at a time per customer
  select * into c from cl_customers where business_id = me.business_id and customer_uid = p_customer_uid;
  v_limit := case when c.customer_uid is not null then c.credit_limit else p_limit end;
  v_bal := cl_b4_balance(me.business_id, p_customer_uid);
  v_held := coalesce((select sum(h.amount) from cl_credit_holds h where h.business_id = me.business_id and h.customer_uid = p_customer_uid
                        and h.sale_uid <> p_sale_uid and h.expires_at > now()), 0);
  v_after := round(v_bal + v_held + p_amount, 2);
  v_ok := v_limit is null or v_after <= v_limit or coalesce(p_override, false);
  if v_ok then
    insert into cl_credit_holds as h (business_id, sale_uid, customer_uid, terminal_id, amount, override)
    values (me.business_id, p_sale_uid, p_customer_uid, me.id, round(p_amount, 2), coalesce(p_override, false))
    on conflict (business_id, sale_uid) do update set amount = excluded.amount, override = excluded.override, expires_at = now() + interval '24 hours'
      where h.terminal_id = me.id;
  end if;
  return json_build_object('ok', true, 'allowed', v_ok, 'balance', v_bal, 'held', v_held, 'limit', v_limit, 'after', v_after,
    'available', case when v_limit is null then null else greatest(0, round(v_limit - v_bal - v_held, 2)) end, 'server_time', now());
end $fn$;

-- Every customer's balance for the business (the offline rule, decision 3), non-zero ones only.
create function public.cl_device_credit_balances(p_install_id text, p_secret_phrase text, p_device_key text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare me cl_terminals%rowtype;
begin
  me := cl_dispatch_caller(p_install_id, p_secret_phrase, p_device_key);
  if not me.active then return json_build_object('error', 'TERMINAL_INACTIVE', 'message', 'This till is switched off for the business. Ask the main branch.'); end if;
  if me.device_kind = 'seat' then return json_build_object('error', 'SEAT_NO_SELLING', 'message', 'An Office seat can''t sell, take payments or run End of Day.'); end if;
  return json_build_object('server_time', now(), 'balances', coalesce((select json_agg(json_build_object('uid', y.k, 'balance', y.b) order by y.k) from (select k, round(sum(a), 2) b from (
      select customer_uid k, credit_amount a from cl_sales where business_id = me.business_id and credit_amount <> 0 and customer_uid is not null
      union all select customer_uid, -amount from cl_credit_payments where business_id = me.business_id
      union all select customer_uid, -debtor_amount from cl_sale_returns where business_id = me.business_id and debtor_amount <> 0 and customer_uid is not null
      union all select customer_uid, amount from cl_credit_bf where business_id = me.business_id) x group by k having round(sum(a), 2) <> 0) y), '[]'::json));
end $fn$;

-- 4. Other branches' reports, by right (§R4); B4 adds sales and payouts (decision 38) ---------------------------------------------
-- p_kind: 'inventory' | 'dispatches' | 'supplier_grvs' | 'sales' | 'payouts' (B4). Another branch needs
-- "View other branches' reports"; costs only with "View costs" (Q7: sent to the
-- signed-in person for this answer, never stored by the till).
create or replace function public.cl_device_branch_report(p_install_id text, p_secret_phrase text, p_device_key text, p_staff_token text,
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
  elsif p_kind = 'sales' then                                                  -- B4 (decision 38): sales and returns, costs only with "View costs"
    v_rows := coalesce((select json_agg(x.j order by x.at) from (                 -- B4
      select s.sold_at as at, json_build_object('type', 'sale', 'uid', s.uid, 'doc', s.receipt_no, 'at', s.sold_at, 'till', t.till_code, 'operator', s.operator,   -- B4
             'customer_uid', s.customer_uid, 'customer', case s.customer_uid when 'b1170000000000000000000000000001' then 'Cash Sale' when 'b1170000000000000000000000000002' then 'Wholesale' else c.name end,   -- B4
             'customer_type', case when s.customer_uid in ('b1170000000000000000000000000001', 'b1170000000000000000000000000002') then 'builtin_' || case s.customer_uid when 'b1170000000000000000000000000001' then 'cash_sale' else 'wholesale' end else c.customer_type end,   -- B4
             'price_level', s.price_level, 'subtotal', s.subtotal, 'discount', s.discount, 'total', s.total, 'voucher_amount', s.voucher_amount,   -- B4
             'method', (select string_agg(distinct p->>'method', '+') from jsonb_array_elements(s.payments) p), 'doc_ref', s.doc_ref,   -- B4
             'credit_amount', s.credit_amount, 'credit_check', s.credit_check, 'credit_scope', s.credit_scope, 'credit_before', s.credit_before,   -- B4
             'credit_after', s.credit_after, 'credit_limit_at', s.credit_limit_at, 'credit_override', s.credit_override, 'credit_override_mode', s.credit_override_mode,   -- B4
             'cost', case when v_costs then s.cost_total end, 'history', s.history) as j   -- B4
        from cl_sales s left join cl_customers c on c.business_id = s.business_id and c.customer_uid = s.customer_uid left join cl_terminals t on t.id = s.terminal_id   -- B4
       where s.business_id = me.business_id and s.branch_id = b.id and s.sold_at between v_from and v_to   -- B4
      union all   -- B4
      select r.returned_at, json_build_object('type', 'return', 'uid', r.uid, 'doc', r.cn_display, 'at', r.returned_at, 'till', t.till_code, 'sale_receipt', r.sale_receipt,   -- B4
             'customer_uid', r.customer_uid, 'customer', c.name, 'reason', r.reason, 'approved_by', r.approved_by, 'total', r.goods_total, 'debtor_amount', r.debtor_amount,   -- B4
             'cost', case when v_costs then r.cost_reversed end, 'history', r.history)   -- B4
        from cl_sale_returns r left join cl_customers c on c.business_id = r.business_id and c.customer_uid = r.customer_uid left join cl_terminals t on t.id = r.terminal_id   -- B4
       where r.business_id = me.business_id and r.branch_id = b.id and r.returned_at between v_from and v_to   -- B4
       order by 1 desc limit 3000) x), '[]'::json);   -- B4
  elsif p_kind = 'payouts' then   -- B4
    v_rows := coalesce((select json_agg(x order by x.at) from (   -- B4
      select p.uid, p.paid_at as at, t.till_code as till, p.reason, p.amount, p.currency, p.account_tag, p.operator, p.history   -- B4
        from cl_payouts p left join cl_terminals t on t.id = p.terminal_id   -- B4
       where p.business_id = me.business_id and p.branch_id = b.id and p.paid_at between v_from and v_to   -- B4
       order by p.paid_at desc limit 2000) x), '[]'::json);   -- B4
  else
    raise exception 'Say which report: inventory, dispatches, supplier_grvs, sales or payouts' using errcode = 'P0001';   -- B4
  end if;
  return json_build_object('server_time', now(), 'kind', p_kind, 'branch_id', b.id, 'branch', b.name, 'costs', v_costs, 'rows', v_rows);
end $fn$;

-- 5. Grants ------------------------------------------------------------------------
revoke all on function public.cl_b4_txt(jsonb, text, integer), public.cl_b4_num(jsonb, text), public.cl_b4_uid_ok(text),
  public.cl_b4_methods_add(jsonb, jsonb, numeric), public.cl_b4_daily(public.cl_terminals, date, boolean, text, numeric, numeric, numeric, numeric, jsonb),
  public.cl_b4_balance(uuid, text), public.cl_b4_store(public.cl_terminals, jsonb), public.cl_b4_retention(uuid) from public, anon, authenticated;
revoke all on function public.cl_device_b4_push(text, text, text, jsonb), public.cl_device_credit_check(text, text, text, text, text, numeric, numeric, boolean), public.cl_device_credit_balances(text, text, text) from public;
grant execute on function public.cl_device_b4_push(text, text, text, jsonb), public.cl_device_credit_check(text, text, text, text, text, numeric, numeric, boolean), public.cl_device_credit_balances(text, text, text) to anon, authenticated;

commit;
