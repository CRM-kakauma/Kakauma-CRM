ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS net_value numeric;

DROP FUNCTION IF EXISTS public.analytics_overview(timestamp with time zone, timestamp with time zone);
DROP FUNCTION IF EXISTS public.metrics_block(timestamp with time zone, timestamp with time zone);
DROP FUNCTION IF EXISTS public.analytics_timeseries(timestamp with time zone, timestamp with time zone, text);

CREATE FUNCTION public.metrics_block(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(revenue numeric, net_revenue numeric, approved_purchases bigint, refunds bigint, chargebacks bigint, failed_payments bigint, funnel_users bigint, converted_users bigint, conversion_rate numeric, refund_rate numeric, chargeback_rate numeric, unique_users bigint, transactions_count bigint, payment_attempts bigint, events_count bigint)
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

CREATE FUNCTION public.analytics_timeseries(p_from timestamp with time zone, p_to timestamp with time zone, p_bucket text DEFAULT 'day'::text)
 RETURNS TABLE(bucket timestamp with time zone, revenue numeric, net_revenue numeric, approved_purchases bigint, users bigint, transactions_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    coalesce(sum(coalesce(t.net_value, t.value)) filter (where t.status = 'approved'), 0)::numeric,
    count(t.id) filter (where t.status = 'approved')::bigint,
    (select count(distinct e.user_id) from public.events e
       where e."timestamp" >= b.bucket
         and e."timestamp" < b.bucket + (case p_bucket when 'week' then interval '1 week' when 'month' then interval '1 month' else interval '1 day' end))::bigint,
    count(t.id)::bigint
  from b
  left join public.transactions t
    on t.created_at >= b.bucket
   and t.created_at < b.bucket + (case p_bucket when 'week' then interval '1 week' when 'month' then interval '1 month' else interval '1 day' end)
   and t.created_at >= p_from and p_from <= t.created_at and t.created_at < p_to
  group by b.bucket
  order by b.bucket;
$function$;

GRANT EXECUTE ON FUNCTION public.metrics_block(timestamp with time zone, timestamp with time zone) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analytics_overview(timestamp with time zone, timestamp with time zone) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analytics_timeseries(timestamp with time zone, timestamp with time zone, text) TO anon, authenticated, service_role;

-- Backfill net_value from events metadata for already-ingested B4you sales
UPDATE public.transactions t
SET net_value = (e.metadata->'producer_split'->>'amount')::numeric
FROM public.events e
WHERE e.transaction_id = t.id
  AND e.event_type = 'PURCHASE_APPROVED'
  AND e.metadata->'producer_split'->>'amount' IS NOT NULL
  AND t.net_value IS NULL;