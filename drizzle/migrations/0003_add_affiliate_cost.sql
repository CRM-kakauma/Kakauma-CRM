ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS affiliate_value numeric;

DROP FUNCTION IF EXISTS public.analytics_overview(timestamp with time zone, timestamp with time zone);
DROP FUNCTION IF EXISTS public.metrics_block(timestamp with time zone, timestamp with time zone);

CREATE FUNCTION public.metrics_block(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(revenue numeric, net_revenue numeric, affiliate_cost numeric, approved_purchases bigint, refunds bigint, chargebacks bigint, failed_payments bigint, funnel_users bigint, converted_users bigint, conversion_rate numeric, refund_rate numeric, chargeback_rate numeric, unique_users bigint, transactions_count bigint, payment_attempts bigint, events_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      coalesce(sum(case when status = 'approved' then coalesce(net_value, value) end), 0)::numeric as net_revenue,
      coalesce(sum(case when status = 'approved' then affiliate_value end), 0)::numeric as affiliate_cost,
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
    agg.net_revenue,
    agg.affiliate_cost,
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
$function$;

CREATE FUNCTION public.analytics_overview(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'current', to_jsonb(c),
    'previous', to_jsonb(p),
    'from', p_from,
    'to', p_to
  )
  from public.metrics_block(p_from, p_to) c,
       public.metrics_block(p_from - (p_to - p_from), p_from) p;
$function$;

GRANT EXECUTE ON FUNCTION public.metrics_block(timestamp with time zone, timestamp with time zone) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analytics_overview(timestamp with time zone, timestamp with time zone) TO anon, authenticated, service_role;

-- Backfill affiliate_value from events metadata for already-ingested B4you sales
UPDATE public.transactions t
SET affiliate_value = (e.metadata->'affiliate_split'->>'amount')::numeric
FROM public.events e
WHERE e.transaction_id = t.id
  AND e.event_type = 'PURCHASE_APPROVED'
  AND e.metadata->'affiliate_split'->>'amount' IS NOT NULL
  AND t.affiliate_value IS NULL;