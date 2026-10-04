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
  s1 as (
    select distinct user_id from ev where event_type = 'CART_ABANDONED'
  ),
  s2 as (
    select distinct e.user_id from ev e
    join s1 on s1.user_id = e.user_id
    where e.event_type in ('PIX_GENERATED','BOLETO_GENERATED')
  ),
  s3 as (
    select distinct e.user_id from ev e
    join s2 on s2.user_id = e.user_id
    where e.event_type = 'PURCHASE_APPROVED'
  ),
  attempts as (
    select
      count(*) filter (where e.event_type in ('PIX_GENERATED','BOLETO_GENERATED'))::bigint as payment_attempts,
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
      (select count(*) from s1)::bigint as cart_abandoned,
      (select count(*) from s2)::bigint as payment_initiated,
      (select count(*) from s3)::bigint as purchase_approved,
      greatest((select count(*) from s1), 1)::bigint as denom,
      attempts.*, methods.*
    from attempts, methods
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

grant execute on function public.analytics_funnel(timestamptz, timestamptz) to anon, authenticated, service_role;