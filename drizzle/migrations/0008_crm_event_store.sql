-- =====================================================================
-- KAKAUMA CRM — event-driven data model (phase 1)
--
-- EVENTS → FACTS → STATE → CUSTOMER
--
-- * crm.events is the immutable raw event store (every webhook, as received).
-- * Every other table is derived from it and can be rebuilt by replaying events.
-- * Fact tables carry unique dedupe keys, so re-processing the same evidence
--   never duplicates a purchase, charge, revenue, refund or renewal.
-- * The schema is private: no anon/authenticated access. The app reaches it
--   only through SECURITY DEFINER functions granted to service_role.
-- =====================================================================

create schema if not exists crm;
revoke all on schema crm from public;
grant usage on schema crm to service_role;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- RAW EVENT STORE
-- ---------------------------------------------------------------------

create table crm.events (
  id uuid primary key default gen_random_uuid(),
  -- Internal, human-readable id.
  event_id text not null unique default ('evt_' || replace(gen_random_uuid()::text, '-', '')),
  source text not null,
  event_name text,                       -- provider event name, as received
  event_type text,                       -- normalized internal type (set on processing)
  source_event_id text,                  -- provider event id, when the provider sends one
  idempotency_key text not null,         -- source_event_id, or a content hash
  received_at timestamptz not null default now(),
  occurred_at timestamptz,
  processed_at timestamptz,
  customer_id uuid,
  sale_id text,
  group_id text,
  subscription_id text,
  charge_id text,
  product_id text,
  offer_id text,
  payload jsonb not null,                -- original payload, never modified
  payload_hash text not null,            -- sha256 of the original payload
  redacted_fields text[] not null default '{}', -- card data removed before storage
  schema_version text not null default 'v1',
  normalized jsonb,                      -- last normalized form (re-derivable)
  processing_status text not null default 'RECEIVED'
    check (processing_status in ('RECEIVED','PROCESSING','PROCESSED','IGNORED','FAILED','DEAD_LETTER')),
  processing_error text,
  processing_warnings jsonb not null default '[]',
  retry_count int not null default 0,
  next_retry_at timestamptz,
  unique (source, idempotency_key)
);

create index events_status_idx on crm.events (processing_status, next_retry_at);
create index events_occurred_idx on crm.events (occurred_at);
create index events_customer_idx on crm.events (customer_id, occurred_at);
create index events_sale_idx on crm.events (sale_id);
create index events_subscription_idx on crm.events (subscription_id);
create index events_type_idx on crm.events (event_type, occurred_at);

-- The original evidence is append-only: payload can never change and rows
-- can never be deleted.
create function crm.protect_raw_event() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'crm.events is append-only (event %)', old.event_id;
  end if;
  if new.payload is distinct from old.payload
     or new.payload_hash is distinct from old.payload_hash
     or new.idempotency_key is distinct from old.idempotency_key
     or new.source is distinct from old.source
     or new.received_at is distinct from old.received_at then
    raise exception 'raw payload of event % is immutable', old.event_id;
  end if;
  return new;
end;
$$;

create trigger events_immutable
before update or delete on crm.events
for each row execute function crm.protect_raw_event();

create table crm.event_processing_logs (
  id bigint generated always as identity primary key,
  raw_event_id uuid not null references crm.events(id),
  processing_started timestamptz not null,
  processing_finished timestamptz,
  processing_status text not null,
  processing_duration_ms int,
  error text,
  retry_count int not null default 0
);
create index processing_logs_event_idx on crm.event_processing_logs (raw_event_id);

create table crm.dead_letter_events (
  id bigint generated always as identity primary key,
  raw_event_id uuid references crm.events(id),
  source text not null,
  reason text not null,
  error text,
  payload jsonb,          -- only for requests that could not even be stored as events
  raw_body text,          -- e.g. invalid JSON
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text
);
create index dead_letter_open_idx on crm.dead_letter_events (created_at) where resolved_at is null;

create table crm.data_quality_issues (
  id bigint generated always as identity primary key,
  raw_event_id uuid references crm.events(id),
  code text not null,
  severity text not null default 'warning' check (severity in ('info','warning','error')),
  message text,
  context jsonb not null default '{}',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index dq_open_idx on crm.data_quality_issues (code) where resolved_at is null;

-- ---------------------------------------------------------------------
-- CATALOG
-- ---------------------------------------------------------------------

create table crm.products (
  product_id text primary key,
  name text,
  type text,
  product_type text,
  cover text,
  logo text,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table crm.offers (
  offer_id text primary key,
  product_id text references crm.products(product_id),
  name text,
  quantity numeric,
  original_price numeric(14,2),  -- reference price only, never revenue
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table crm.coupons (
  coupon_code text primary key,
  type text,
  amount numeric(14,2),
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table crm.affiliates (
  affiliate_id uuid primary key default gen_random_uuid(),
  external_affiliate_id text unique,
  email text unique,
  name text,
  b4f text,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- CUSTOMER
-- ---------------------------------------------------------------------

create table crm.customers (
  customer_id uuid primary key default gen_random_uuid(),
  external_customer_id text unique,
  full_name text,
  email text,
  phone text,
  whatsapp text,
  document_number text,
  birth_date date,
  address jsonb,
  city text,
  state text,
  zipcode text,
  neighborhood text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  first_purchase_at timestamptz,
  last_purchase_at timestamptz,
  first_subscription_at timestamptz,
  last_subscription_at timestamptz,
  total_orders int not null default 0,
  total_paid_orders int not null default 0,
  total_refunds int not null default 0,
  total_gross_revenue numeric(14,2) not null default 0,
  total_refund_amount numeric(14,2) not null default 0,
  total_chargeback_amount numeric(14,2) not null default 0,
  total_net_revenue numeric(14,2) not null default 0,
  total_subscription_revenue numeric(14,2) not null default 0,
  total_renewal_revenue numeric(14,2) not null default 0,
  total_platform_fees numeric(14,2) not null default 0,
  total_shipping_cost numeric(14,2) not null default 0,
  average_order_value numeric(14,2),
  average_subscription_cycle_value numeric(14,2),
  acquisition_attribution_id uuid,
  acquisition_source text,
  acquisition_affiliate_id uuid references crm.affiliates(affiliate_id),
  current_lifecycle_stage text,
  current_risk_state text,
  current_customer_type text not null default 'LEAD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_email_idx on crm.customers (lower(email));
create index customers_type_idx on crm.customers (current_customer_type);

-- Every identifier ever seen for a customer. Resolution walks these in
-- priority order, so an event without customer.id never creates a duplicate.
create table crm.customer_identities (
  kind text not null check (kind in ('b4you_customer_id','subscription_id','sale_id','email','whatsapp','document')),
  value text not null,
  customer_id uuid not null references crm.customers(customer_id),
  first_seen_at timestamptz not null default now(),
  raw_event_id uuid references crm.events(id),
  primary key (kind, value)
);
create index identities_customer_idx on crm.customer_identities (customer_id);

-- ---------------------------------------------------------------------
-- ATTRIBUTION
-- ---------------------------------------------------------------------

create table crm.attributions (
  attribution_id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references crm.customers(customer_id),
  raw_event_id uuid not null references crm.events(id),
  sale_id text,
  subscription_id text,
  touch_type text not null check (touch_type in ('acquisition','touch','inherited')),
  inherited_from uuid references crm.attributions(attribution_id),
  occurred_at timestamptz,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  utm_id text,
  fbclid text,
  gclid text,
  ttclid text,
  fbc text,
  fbp text,
  b1 text,
  b2 text,
  b3 text,
  sck text,
  src text,
  funnel_name text,
  funnel_instance_id text,
  extra jsonb not null default '{}',   -- unknown parameters are never discarded
  created_at timestamptz not null default now(),
  unique (raw_event_id)
);
create index attributions_customer_idx on crm.attributions (customer_id, occurred_at);
create index attributions_campaign_idx on crm.attributions (utm_source, utm_campaign);

alter table crm.customers
  add constraint customers_acquisition_fk foreign key (acquisition_attribution_id)
  references crm.attributions(attribution_id);

-- ---------------------------------------------------------------------
-- CHECKOUTS (abandoned carts never become orders or revenue)
-- ---------------------------------------------------------------------

create table crm.checkouts (
  checkout_id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references crm.customers(customer_id),
  raw_event_id uuid not null unique references crm.events(id),
  sale_id text,
  product_id text references crm.products(product_id),
  offer_id text references crm.offers(offer_id),
  status text not null default 'ABANDONED' check (status in ('ABANDONED','CONVERTED')),
  abandoned_at timestamptz,
  converted_at timestamptz,
  converted_sale_id text,
  checkout_url text,
  amount numeric(14,2),
  created_at timestamptz not null default now()
);
create index checkouts_customer_idx on crm.checkouts (customer_id, status);

-- ---------------------------------------------------------------------
-- ORDERS / TRANSACTIONS
-- ---------------------------------------------------------------------

create table crm.orders (
  order_id uuid primary key default gen_random_uuid(),
  sale_id text not null unique,           -- the sale of this order; never a subscription id
  customer_id uuid not null references crm.customers(customer_id),
  group_id text,
  subscription_id text,
  product_id text references crm.products(product_id),
  offer_id text references crm.offers(offer_id),
  product_name text,
  offer_name text,
  quantity numeric,
  gross_amount numeric(14,2),             -- sum of paid charges, never original_price
  currency text not null default 'BRL',
  payment_method text,
  installments int,
  coupon_code text references crm.coupons(coupon_code),
  affiliate_id uuid references crm.affiliates(affiliate_id),
  attribution_id uuid references crm.attributions(attribution_id),
  status text not null default 'PENDING'
    check (status in ('PENDING','PAID','FAILED','PARTIALLY_REFUNDED','REFUNDED','CHARGEBACK','CANCELLED')),
  created_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  updated_at timestamptz not null default now()
);
create index orders_customer_idx on crm.orders (customer_id, created_at);

create table crm.transactions (
  transaction_id uuid primary key default gen_random_uuid(),
  transaction_key text not null unique,   -- charge_id, or "sale:<sale_id>" when the provider sends none
  charge_id text,
  sale_id text,
  customer_id uuid not null references crm.customers(customer_id),
  subscription_id text,
  order_id uuid references crm.orders(order_id),
  amount numeric(14,2),
  currency text not null default 'BRL',
  status text not null default 'PENDING'
    check (status in ('PENDING','FAILED','PAID','PARTIALLY_REFUNDED','REFUNDED','CHARGEBACK')),
  payment_method text check (payment_method in ('pix','card','billet','apple_pay','unknown')),
  card_brand text,
  card_last_four text check (card_last_four is null or card_last_four ~ '^[0-9]{4}$'),
  installments int,
  pix_url text,
  pix_code text,
  billet_url text,
  billet_code text,
  platform_fee numeric(14,2),
  my_commission numeric(14,2),
  affiliate_commission numeric(14,2),
  released boolean,
  release_date timestamptz,
  splits jsonb,
  refunded_amount numeric(14,2) not null default 0,
  created_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  refunded_at timestamptz,
  chargeback_at timestamptz,
  updated_at timestamptz not null default now()
);
create index transactions_customer_idx on crm.transactions (customer_id);
create index transactions_sale_idx on crm.transactions (sale_id);
create index transactions_subscription_idx on crm.transactions (subscription_id);

create table crm.financial_events (
  financial_event_id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  event_type text not null check (event_type in (
    'PAYMENT_CREATED','PAYMENT_PENDING','PAYMENT_APPROVED','PAYMENT_FAILED',
    'REFUND','PARTIAL_REFUND','CHARGEBACK','RENEWAL_PAYMENT')),
  customer_id uuid not null references crm.customers(customer_id),
  sale_id text,
  charge_id text,
  transaction_id uuid references crm.transactions(transaction_id),
  subscription_id text,
  amount numeric(14,2) not null default 0,
  platform_fee numeric(14,2),
  currency text not null default 'BRL',
  occurred_at timestamptz not null,
  raw_event_id uuid not null references crm.events(id),
  created_at timestamptz not null default now()
);
create index financial_customer_idx on crm.financial_events (customer_id, occurred_at);
create index financial_type_idx on crm.financial_events (event_type, occurred_at);

-- ---------------------------------------------------------------------
-- SUBSCRIPTIONS
-- ---------------------------------------------------------------------

create table crm.subscriptions (
  subscription_id text primary key,       -- B4you subscription id; renewals never create a new row
  customer_id uuid not null references crm.customers(customer_id),
  product_id text references crm.products(product_id),
  offer_id text references crm.offers(offer_id),
  plan_id text,
  plan_name text,
  frequency text,
  status text not null default 'ACTIVE' check (status in (
    'TRIAL','ACTIVE','PAUSED','PAYMENT_PENDING','PAYMENT_FAILED','CANCELLED','INACTIVE','EXPIRED','REACTIVATED')),
  provider_status text,                   -- confirmed status as last reported by the provider
  status_observed_at timestamptz,         -- occurred_at of the event that set provider_status
  payment_state text not null default 'CURRENT' check (payment_state in (
    'CURRENT','DUE','LATE','FAILED','RECOVERED','REFUNDED')),
  lifecycle_state text not null default 'NEW' check (lifecycle_state in (
    'NEW','ACTIVE','EXPIRING','RENEWED','CANCELLATION_REQUESTED','CANCELLED','REACTIVATED','CHURNED')),
  risk_state text not null default 'HEALTHY' check (risk_state in (
    'HEALTHY','AT_RISK','PAYMENT_RISK','CHURN_RISK','HIGH_VALUE_AT_RISK')),
  cancellation_requested boolean not null default false,
  start_date timestamptz,
  next_charge_at timestamptz,
  expiring_at timestamptz,
  last_charge_at timestamptz,
  late_at timestamptz,
  cancelled_at timestamptz,
  cancellation_requested_at timestamptz,
  expired_at timestamptz,
  renewed_at timestamptz,
  reactivated_at timestamptz,
  current_cycle int not null default 0,
  total_cycles int not null default 0,
  total_revenue numeric(14,2) not null default 0,
  total_refunds numeric(14,2) not null default 0,
  net_revenue numeric(14,2) not null default 0,
  acquisition_attribution_id uuid references crm.attributions(attribution_id),
  affiliate_id uuid references crm.affiliates(affiliate_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_customer_idx on crm.subscriptions (customer_id);
create index subscriptions_state_idx on crm.subscriptions (status, payment_state, risk_state);

create table crm.subscription_charges (
  charge_id text primary key,             -- each recurring charge is independent
  subscription_id text not null references crm.subscriptions(subscription_id),
  customer_id uuid not null references crm.customers(customer_id),
  sale_id text,
  transaction_id uuid references crm.transactions(transaction_id),
  amount numeric(14,2),
  currency text not null default 'BRL',
  status text not null default 'PENDING' check (status in (
    'PENDING','PAID','FAILED','LATE','RECOVERED','REFUNDED','PARTIALLY_REFUNDED','CHARGEBACK')),
  payment_method text,
  due_at timestamptz,
  created_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  late_at timestamptz,
  recovered_at timestamptz,
  attempt_count int not null default 0,
  cycle_number int,
  updated_at timestamptz not null default now()
);
create index subscription_charges_sub_idx on crm.subscription_charges (subscription_id, cycle_number);

-- ---------------------------------------------------------------------
-- REFUNDS (never delete or overwrite the original purchase)
-- ---------------------------------------------------------------------

create table crm.refunds (
  refund_id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  external_refund_id text,
  sale_id text,
  charge_id text,
  transaction_id uuid references crm.transactions(transaction_id),
  customer_id uuid not null references crm.customers(customer_id),
  subscription_id text,
  affiliate_id uuid references crm.affiliates(affiliate_id),
  amount numeric(14,2),
  kind text not null default 'REFUND' check (kind in ('REFUND','PARTIAL_REFUND','CHARGEBACK')),
  reason text,
  status text,
  raw_event_id uuid not null references crm.events(id),
  created_at timestamptz not null
);
create index refunds_customer_idx on crm.refunds (customer_id);

-- ---------------------------------------------------------------------
-- FULFILLMENT
-- ---------------------------------------------------------------------

create table crm.fulfillments (
  fulfillment_id uuid primary key default gen_random_uuid(),
  fulfillment_key text not null unique,    -- tracking_code, or "sale:<sale_id>"
  customer_id uuid not null references crm.customers(customer_id),
  sale_id text,
  order_id uuid references crm.orders(order_id),
  carrier text,
  tracking_code text,
  tracking_url text,
  shipping_cost numeric(14,2),
  status text not null default 'FULFILLMENT_CREATED' check (status in (
    'FULFILLMENT_CREATED','SHIPPED','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED',
    'DELIVERY_DELAYED','DELIVERY_FAILED','DELIVERY_RETURNED','DELIVERY_LOST')),
  provider_status text,
  created_at timestamptz,
  shipped_at timestamptz,
  estimated_delivery_at timestamptz,
  delivered_at timestamptz,
  updated_at timestamptz not null default now()
);
create index fulfillments_customer_idx on crm.fulfillments (customer_id);

create table crm.fulfillment_events (
  id bigint generated always as identity primary key,
  fulfillment_id uuid not null references crm.fulfillments(fulfillment_id),
  status text not null,
  provider_status text,
  occurred_at timestamptz not null,
  raw_event_id uuid not null references crm.events(id),
  unique (fulfillment_id, raw_event_id)
);

-- ---------------------------------------------------------------------
-- BUSINESS FACTS (what happened, derived from raw evidence).
-- This stream feeds lifecycle, segmentation and automations.
-- ---------------------------------------------------------------------

create table crm.customer_events (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  fact_type text not null,  -- e.g. CHECKOUT_ABANDONED, SUBSCRIPTION_CANCELLATION_REQUESTED
  customer_id uuid not null references crm.customers(customer_id),
  subscription_id text,
  sale_id text,
  charge_id text,
  occurred_at timestamptz not null,
  data jsonb not null default '{}',
  raw_event_id uuid not null references crm.events(id),
  created_at timestamptz not null default now()
);
create index customer_events_customer_idx on crm.customer_events (customer_id, occurred_at);
create index customer_events_type_idx on crm.customer_events (fact_type, occurred_at);

-- ---------------------------------------------------------------------
-- AUDIT LOG
-- ---------------------------------------------------------------------

create table crm.audit_logs (
  id bigint generated always as identity primary key,
  entity text not null,
  entity_id text not null,
  field text not null,
  old_value text,
  new_value text,
  actor text not null,       -- who: "event:<event_id>", "user:<id>", "system"
  changed_at timestamptz not null default now()
);
create index audit_entity_idx on crm.audit_logs (entity, entity_id, changed_at);

create function crm.current_actor() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('crm.actor', true), ''), 'system')
$$;

create function crm.audit_changes() returns trigger
language plpgsql as $$
declare
  f text;
  o text;
  n text;
  id_col text := tg_argv[0];
begin
  foreach f in array tg_argv[1:] loop
    execute format('select ($1).%I::text, ($2).%I::text', f, f) into o, n using old, new;
    if o is distinct from n then
      insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
      values (tg_table_name, (to_jsonb(new) ->> id_col), f, o, n, crm.current_actor());
    end if;
  end loop;
  return new;
end;
$$;

create trigger subscriptions_audit
after update on crm.subscriptions
for each row execute function crm.audit_changes(
  'subscription_id', 'status', 'payment_state', 'lifecycle_state', 'risk_state',
  'cancellation_requested', 'cancelled_at', 'current_cycle');

create trigger customers_audit
after update on crm.customers
for each row execute function crm.audit_changes(
  'customer_id', 'current_lifecycle_stage', 'current_customer_type', 'current_risk_state');

create trigger orders_audit
after update on crm.orders
for each row execute function crm.audit_changes('order_id', 'status');

create function crm.audit_insert() returns trigger
language plpgsql as $$
begin
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values (tg_table_name, (to_jsonb(new) ->> tg_argv[0]), 'created', null,
          (to_jsonb(new) ->> tg_argv[1]), crm.current_actor());
  return new;
end;
$$;

create trigger refunds_audit
after insert on crm.refunds
for each row execute function crm.audit_insert('refund_id', 'amount');

-- ---------------------------------------------------------------------
-- SECURITY: private schema, RLS on, service_role only.
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'crm' loop
    execute format('alter table crm.%I enable row level security', t);
    execute format('revoke all on crm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update on crm.%I to service_role', t);
  end loop;
end;
$$;

grant usage on all sequences in schema crm to service_role;
