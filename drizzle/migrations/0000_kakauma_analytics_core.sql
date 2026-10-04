-- ============ ENUM ============
create type public.event_type as enum (
  'PURCHASE_APPROVED','PURCHASE_DECLINED','REFUND','CHARGEBACK','CART_ABANDONED',
  'BOLETO_GENERATED','PIX_GENERATED','SUBSCRIPTION_CANCELLED','SUBSCRIPTION_OVERDUE',
  'SUBSCRIPTION_RENEWED','TRACKING_CREATED','AFFILIATION_REQUESTED','AFFILIATION_APPROVED',
  'AFFILIATION_DECLINED','PIX_EXPIRED','SUBSCRIPTION_EXPIRING'
);

-- ============ TABLES ============
create table public.users (
  id uuid primary key default gen_random_uuid(),
  external_user_id text not null unique,
  name text,
  email text,
  created_at timestamptz not null default now(),
  first_seen_at timestamptz,
  last_seen_at timestamptz
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  external_transaction_id text not null unique,
  user_id uuid references public.users(id) on delete cascade,
  product_id text,
  value numeric(14,2) not null default 0,
  currency text not null default 'BRL',
  status text not null default 'pending',
  payment_method text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  refunded_at timestamptz,
  chargeback_at timestamptz
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  external_subscription_id text not null unique,
  user_id uuid references public.users(id) on delete cascade,
  product_id text,
  status text not null default 'active',
  started_at timestamptz,
  next_billing_at timestamptz,
  renewed_at timestamptz,
  cancelled_at timestamptz
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  user_id uuid references public.users(id) on delete cascade,
  event_type public.event_type not null,
  "timestamp" timestamptz not null default now(),
  transaction_id uuid references public.transactions(id) on delete set null,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  product_id text,
  value numeric(14,2),
  currency text default 'BRL',
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index events_ts_idx on public.events ("timestamp" desc);
create index events_type_ts_idx on public.events (event_type, "timestamp" desc);
create index events_user_idx on public.events (user_id, "timestamp");
create index events_tx_idx on public.events (transaction_id);
create index tx_user_idx on public.transactions (user_id);
create index tx_status_idx on public.transactions (status, approved_at);
create index tx_created_idx on public.transactions (created_at desc);
create index users_email_idx on public.users (lower(email));
create index users_name_idx on public.users (lower(name));
create index subs_user_idx on public.subscriptions (user_id);

-- ============ GRANTS ============
grant select on public.users to anon, authenticated;
grant select on public.events to anon, authenticated;
grant select on public.transactions to anon, authenticated;
grant select on public.subscriptions to anon, authenticated;
grant all on public.users to service_role;
grant all on public.events to service_role;
grant all on public.transactions to service_role;
grant all on public.subscriptions to service_role;

alter table public.users enable row level security;
alter table public.events enable row level security;
alter table public.transactions enable row level security;
alter table public.subscriptions enable row level security;

create policy "public read users" on public.users for select to anon, authenticated using (true);
create policy "public read events" on public.events for select to anon, authenticated using (true);
create policy "public read transactions" on public.transactions for select to anon, authenticated using (true);
create policy "public read subscriptions" on public.subscriptions for select to anon, authenticated using (true);

-- ============ ANALYTICS ENGINE ============
create or replace function public.metrics_block(p_from timestamptz, p_to timestamptz)
returns table (
  revenue numeric,
  approved_purchases bigint,
  refunds bigint,
  chargebacks bigint,
  failed_payments bigint,
  funnel_users bigint,
  converted_users bigint,
  conversion_rate numeric,
  refund_rate numeric,
  chargeback_rate numeric,
  unique_users bigint,
  transactions_count bigint,
  payment_attempts bigint,
  events_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with tx as (
    select * from public.transactions
    where created_at >= p_from and created_at < p_to
  ),
  ev as (
    select * from public.events
    where "timestamp" >= p_from and "timestamp" < p_to
  ),
  agg as (
    select
      coalesce(sum(case when status = 'approved' then value end), 0)::numeric as revenue,
      count(*) filter (where status = 'approved')::bigint as approved_purchases,
      count(*) filter (where refunded_at is not null)::bigint as refunds,
      count(*) filter (where chargeback_at is not null)::bigint as chargebacks,
      count(*)::bigint as transactions_count
    from tx
  ),
  evagg as (
    select
      count(*) filter (where event_type = 'PURCHASE_DECLINED')::bigint as failed_payments,
      count(distinct user_id) filter (
        where event_type in ('CART_ABANDONED','PIX_GENERATED','BOLETO_GENERATED')
      )::bigint as funnel_users,
      count(distinct user_id) filter (where event_type = 'PURCHASE_APPROVED')::bigint as converted_users,
      count(distinct user_id)::bigint as unique_users,
      count(*) filter (where event_type in ('PIX_GENERATED','BOLETO_GENERATED'))::bigint as payment_attempts,
      count(*)::bigint as events_count
    from ev
  )
  select
    agg.revenue,
    agg.approved_purchases,
    agg.refunds,
    agg.chargebacks,
    evagg.failed_payments,
    evagg.funnel_users,
    evagg.converted_users,
    case when evagg.funnel_users > 0
      then round(evagg.converted_users::numeric * 100 / evagg.funnel_users, 2) else 0 end,
    case when agg.approved_purchases > 0
      then round(agg.refunds::numeric * 100 / agg.approved_purchases, 2) else 0 end,
    case when agg.approved_purchases > 0
      then round(agg.chargebacks::numeric * 100 / agg.approved_purchases, 2) else 0 end,
    evagg.unique_users,
    agg.transactions_count,
    evagg.payment_attempts,
    evagg.events_count
  from agg, evagg;
$$;

create or replace function public.analytics_overview(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'current', to_jsonb(c),
    'previous', to_jsonb(p),
    'from', p_from,
    'to', p_to
  )
  from public.metrics_block(p_from, p_to) c,
       public.metrics_block(p_from - (p_to - p_from), p_from) p;
$$;

create or replace function public.analytics_timeseries(
  p_from timestamptz,
  p_to timestamptz,
  p_bucket text default 'day'
)
returns table (bucket timestamptz, revenue numeric, approved_purchases bigint, users bigint, transactions_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  with b as (
    select generate_series(
      date_trunc(case when p_bucket in ('day','week','month') then p_bucket else 'day' end, p_from),
      p_to,
      case p_bucket when 'week' then interval '1 week' when 'month' then interval '1 month' else interval '1 day' end
    ) as bucket
  )
  select
    b.bucket,
    coalesce(sum(t.value) filter (where t.status = 'approved'), 0)::numeric,
    count(t.id) filter (where t.status = 'approved')::bigint,
    (select count(distinct e.user_id) from public.events e
       where e."timestamp" >= b.bucket
         and e."timestamp" < b.bucket + (case p_bucket when 'week' then interval '1 week' when 'month' then interval '1 month' else interval '1 day' end))::bigint,
    count(t.id)::bigint
  from b
  left join public.transactions t
    on t.created_at >= b.bucket
   and t.created_at < b.bucket + (case p_bucket when 'week' then interval '1 week' when 'month' then interval '1 month' else interval '1 day' end)
   and t.created_at >= p_from and t.created_at < p_to
  group by b.bucket
  order by b.bucket;
$$;

create or replace function public.analytics_funnel(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select * from public.events where "timestamp" >= p_from and "timestamp" < p_to
  ),
  stages as (
    select
      count(distinct user_id) filter (where event_type = 'CART_ABANDONED')::bigint as cart_abandoned,
      count(distinct user_id) filter (where event_type in ('PIX_GENERATED','BOLETO_GENERATED'))::bigint as payment_initiated,
      count(distinct user_id) filter (where event_type = 'PURCHASE_APPROVED')::bigint as purchase_approved,
      count(distinct transaction_id) filter (where event_type = 'PIX_GENERATED')::bigint as pix_generated,
      count(distinct transaction_id) filter (where event_type = 'BOLETO_GENERATED')::bigint as boleto_generated,
      count(*) filter (where event_type in ('PIX_GENERATED','BOLETO_GENERATED'))::bigint as payment_attempts
    from ev
  ),
  methods as (
    select
      count(*) filter (where payment_method = 'pix' and status = 'approved')::bigint as pix_approved,
      count(*) filter (where payment_method = 'boleto' and status = 'approved')::bigint as boleto_approved
    from public.transactions
    where created_at >= p_from and created_at < p_to
  ),
  base as (
    select greatest(stages.cart_abandoned, 1) as denom, stages.*, methods.* from stages, methods
  )
  select jsonb_build_object(
    'stages', jsonb_build_array(
      jsonb_build_object('key','cart_abandoned','label','Cart Abandoned','users',cart_abandoned,
        'conversion', 100.0, 'drop_off', 0, 'drop_off_users', 0),
      jsonb_build_object('key','payment_initiated','label','Payment Initiated','users',payment_initiated,
        'conversion', round(payment_initiated::numeric * 100 / denom, 1),
        'drop_off', round(100 - payment_initiated::numeric * 100 / denom, 1),
        'drop_off_users', greatest(cart_abandoned - payment_initiated, 0)),
      jsonb_build_object('key','purchase_approved','label','Purchase Approved','users',purchase_approved,
        'conversion', round(purchase_approved::numeric * 100 / denom, 1),
        'drop_off', round(100 - purchase_approved::numeric * 100 / denom, 1),
        'drop_off_users', greatest(payment_initiated - purchase_approved, 0))
    ),
    'methods', jsonb_build_object(
      'pix', jsonb_build_object('generated', pix_generated, 'approved', pix_approved,
        'conversion', case when pix_generated > 0 then round(pix_approved::numeric * 100 / pix_generated, 1) else 0 end),
      'boleto', jsonb_build_object('generated', boleto_generated, 'approved', boleto_approved,
        'conversion', case when boleto_generated > 0 then round(boleto_approved::numeric * 100 / boleto_generated, 1) else 0 end)
    ),
    'payment_attempts', payment_attempts
  )
  from base;
$$;

create or replace function public.search_users(p_query text, p_limit int default 10)
returns table (id uuid, external_user_id text, name text, email text, last_seen_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.external_user_id, u.name, u.email, u.last_seen_at
  from public.users u
  where p_query is not null and length(trim(p_query)) > 0
    and (u.name ilike '%' || p_query || '%'
      or u.email ilike '%' || p_query || '%'
      or u.external_user_id ilike '%' || p_query || '%')
  order by u.last_seen_at desc nulls last
  limit least(coalesce(p_limit, 10), 50);
$$;

create or replace function public.customer_summary(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'user', (select to_jsonb(u) from public.users u where u.id = p_user_id),
    'metrics', (
      select jsonb_build_object(
        'total_spent', coalesce(sum(value) filter (where status = 'approved'), 0),
        'transactions', count(*),
        'refunds', count(*) filter (where refunded_at is not null),
        'chargebacks', count(*) filter (where chargeback_at is not null)
      ) from public.transactions where user_id = p_user_id
    ),
    'journey', (
      select coalesce(jsonb_agg(x order by x->>'timestamp'), '[]'::jsonb) from (
        select jsonb_build_object(
          'id', e.id, 'event_type', e.event_type, 'timestamp', e."timestamp",
          'value', e.value, 'source', e.source,
          'transaction_id', e.transaction_id,
          'external_transaction_id', t.external_transaction_id
        ) as x
        from public.events e
        left join public.transactions t on t.id = e.transaction_id
        where e.user_id = p_user_id
      ) s
    )
  );
$$;

create or replace function public.transaction_detail(p_transaction_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'transaction', (select to_jsonb(t) from public.transactions t where t.id = p_transaction_id),
    'user', (select jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email, 'external_user_id', u.external_user_id)
             from public.transactions t join public.users u on u.id = t.user_id where t.id = p_transaction_id),
    'timeline', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'event_type', e.event_type, 'timestamp', e."timestamp", 'value', e.value
      ) order by e."timestamp"), '[]'::jsonb)
      from public.events e where e.transaction_id = p_transaction_id
    ),
    'payment_attempts', (
      select count(*) from public.events e
      where e.transaction_id = p_transaction_id
        and e.event_type in ('PIX_GENERATED','BOLETO_GENERATED')
    ),
    'time_to_conversion_minutes', (
      select case when max(a.approved) is null or min(a.first_attempt) is null then null
        else round(extract(epoch from (max(a.approved) - min(a.first_attempt))) / 60) end
      from (
        select
          min(e."timestamp") filter (where e.event_type in ('PIX_GENERATED','BOLETO_GENERATED','CART_ABANDONED')) as first_attempt,
          max(e."timestamp") filter (where e.event_type = 'PURCHASE_APPROVED') as approved
        from public.events e where e.transaction_id = p_transaction_id
      ) a
    )
  );
$$;

grant execute on function public.metrics_block(timestamptz, timestamptz) to anon, authenticated, service_role;
grant execute on function public.analytics_overview(timestamptz, timestamptz) to anon, authenticated, service_role;
grant execute on function public.analytics_timeseries(timestamptz, timestamptz, text) to anon, authenticated, service_role;
grant execute on function public.analytics_funnel(timestamptz, timestamptz) to anon, authenticated, service_role;
grant execute on function public.search_users(text, int) to anon, authenticated, service_role;
grant execute on function public.customer_summary(uuid) to anon, authenticated, service_role;
grant execute on function public.transaction_detail(uuid) to anon, authenticated, service_role;
