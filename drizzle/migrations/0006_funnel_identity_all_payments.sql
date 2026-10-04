create or replace function public.analytics_funnel(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select e.*, coalesce(nullif(lower(u.email), ''), u.external_user_id, e.user_id::text) as identity
    from public.events e
    left join public.users u on u.id = e.user_id
    where e."timestamp" >= p_from and e."timestamp" < p_to
  ),
  s1 as (
    select distinct identity from ev
    where event_type in ('CART_ABANDONED','PIX_GENERATED','BOLETO_GENERATED','PURCHASE_APPROVED','PURCHASE_DECLINED')
      and identity is not null
  ),
  s2 as (
    select distinct identity from ev
    where event_type in ('PIX_GENERATED','BOLETO_GENERATED','PURCHASE_APPROVED','PURCHASE_DECLINED')
      and identity is not null
  ),
  s3 as (
    select distinct identity from ev
    where event_type = 'PURCHASE_APPROVED' and identity is not null
  ),
  attempts as (
    select
      count(*) filter (where e.event_type in ('PIX_GENERATED','BOLETO_GENERATED','PURCHASE_APPROVED','PURCHASE_DECLINED'))::bigint as payment_attempts,
      count(distinct e.transaction_id) filter (where e.event_type = 'PIX_GENERATED')::bigint as pix_generated,
      count(distinct e.transaction_id) filter (where e.event_type = 'BOLETO_GENERATED')::bigint as boleto_generated
    from ev e
  ),
  methods as (
    select
      count(*) filter (where payment_method = 'pix' and status = 'approved')::bigint as pix_approved,
      count(*) filter (where payment_method = 'boleto' and status = 'approved')::bigint as boleto_approved
    from public.transactions
    where created_at >= p_from and created_at < p_to
  ),
  base as (
    select
      (select count(*) from s1)::bigint as checkout,
      (select count(*) from s2)::bigint as payment_initiated,
      (select count(*) from s3)::bigint as purchase_approved,
      attempts.*, methods.*
    from attempts, methods
  )
  select jsonb_build_object(
    'stages', jsonb_build_array(
      jsonb_build_object('key','checkout','label','Checkout Iniciado','users',checkout,
        'conversion', 100.0, 'drop_off', 0, 'drop_off_users', 0),
      jsonb_build_object('key','payment_initiated','label','Pagamento Iniciado','users',payment_initiated,
        'conversion', case when checkout > 0 then round(payment_initiated::numeric * 100 / checkout, 1) else 0 end,
        'drop_off', case when checkout > 0 then round(100 - payment_initiated::numeric * 100 / checkout, 1) else 0 end,
        'drop_off_users', greatest(checkout - payment_initiated, 0)),
      jsonb_build_object('key','purchase_approved','label','Compra Aprovada','users',purchase_approved,
        'conversion', case when payment_initiated > 0 then round(purchase_approved::numeric * 100 / payment_initiated, 1) else 0 end,
        'drop_off', case when payment_initiated > 0 then round(100 - purchase_approved::numeric * 100 / payment_initiated, 1) else 0 end,
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

grant execute on function public.analytics_funnel(timestamptz, timestamptz) to anon, authenticated, service_role;

create or replace function public.metrics_block(p_from timestamptz, p_to timestamptz)
returns table(
  revenue numeric, net_revenue numeric, affiliate_cost numeric, approved_purchases bigint,
  refunds bigint, chargebacks bigint, failed_payments bigint, funnel_users bigint,
  converted_users bigint, conversion_rate numeric, refund_rate numeric, chargeback_rate numeric,
  unique_users bigint, transactions_count bigint, payment_attempts bigint, events_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select e.*, coalesce(nullif(lower(u.email), ''), u.external_user_id, e.user_id::text) as identity
    from public.events e
    left join public.users u on u.id = e.user_id
    where e."timestamp" >= p_from and e."timestamp" < p_to
  ),
  agg as (
    select
      coalesce(sum(value) filter (where event_type = 'PURCHASE_APPROVED'), 0)::numeric as revenue,
      count(*) filter (where event_type = 'PURCHASE_APPROVED')::bigint as approved_purchases,
      count(*) filter (where event_type = 'REFUND')::bigint as refunds,
      count(*) filter (where event_type = 'CHARGEBACK')::bigint as chargebacks,
      count(*) filter (where event_type = 'PURCHASE_DECLINED')::bigint as failed_payments,
      count(distinct identity)::bigint as unique_users,
      count(distinct transaction_id)::bigint as transactions_count,
      count(*) filter (where event_type in ('PIX_GENERATED','BOLETO_GENERATED','PURCHASE_APPROVED','PURCHASE_DECLINED'))::bigint as payment_attempts,
      count(*)::bigint as events_count,
      count(distinct identity) filter (where event_type in ('CART_ABANDONED','PIX_GENERATED','BOLETO_GENERATED','PURCHASE_APPROVED','PURCHASE_DECLINED'))::bigint as funnel_users,
      count(distinct identity) filter (where event_type = 'PURCHASE_APPROVED')::bigint as converted_users
    from ev
  ),
  money as (
    select
      coalesce(sum(net_value) filter (where status = 'approved' or approved_at is not null), 0)::numeric as net_revenue,
      coalesce(sum(affiliate_value) filter (where status = 'approved' or approved_at is not null), 0)::numeric as affiliate_cost
    from public.transactions
    where coalesce(approved_at, created_at) >= p_from and coalesce(approved_at, created_at) < p_to
  )
  select
    agg.revenue,
    money.net_revenue,
    money.affiliate_cost,
    agg.approved_purchases,
    agg.refunds,
    agg.chargebacks,
    agg.failed_payments,
    agg.funnel_users,
    agg.converted_users,
    case when agg.funnel_users > 0 then round(agg.converted_users::numeric * 100 / agg.funnel_users, 1) else 0 end,
    case when agg.approved_purchases > 0 then round(agg.refunds::numeric * 100 / agg.approved_purchases, 1) else 0 end,
    case when agg.approved_purchases > 0 then round(agg.chargebacks::numeric * 100 / agg.approved_purchases, 1) else 0 end,
    agg.unique_users,
    agg.transactions_count,
    agg.payment_attempts,
    agg.events_count
  from agg, money;
$$;

grant execute on function public.metrics_block(timestamptz, timestamptz) to anon, authenticated, service_role;