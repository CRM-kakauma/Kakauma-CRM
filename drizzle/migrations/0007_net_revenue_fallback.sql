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
      coalesce(sum(coalesce(net_value, value - coalesce(affiliate_value, 0))) filter (where status = 'approved' or approved_at is not null), 0)::numeric as net_revenue,
      coalesce(sum(affiliate_value) filter (where status = 'approved' or approved_at is not null), 0)::numeric as affiliate_cost
    from public.transactions
    where coalesce(approved_at, created_at) >= p_from and coalesce(approved_at, created_at) < p_to
  )
  select
    agg.revenue, money.net_revenue, money.affiliate_cost, agg.approved_purchases, agg.refunds,
    agg.chargebacks, agg.failed_payments, agg.funnel_users, agg.converted_users,
    case when agg.funnel_users > 0 then round(agg.converted_users::numeric * 100 / agg.funnel_users, 1) else 0 end,
    case when agg.approved_purchases > 0 then round(agg.refunds::numeric * 100 / agg.approved_purchases, 1) else 0 end,
    case when agg.approved_purchases > 0 then round(agg.chargebacks::numeric * 100 / agg.approved_purchases, 1) else 0 end,
    agg.unique_users, agg.transactions_count, agg.payment_attempts, agg.events_count
  from agg, money;
$$;

grant execute on function public.metrics_block(timestamptz, timestamptz) to anon, authenticated, service_role;