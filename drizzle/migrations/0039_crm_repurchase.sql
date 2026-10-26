-- =====================================================================
-- KAKAUMA CRM — repurchase: second purchase, within 30 / 60 / 90 days, LTV
--
--   A purchase is a paid checkout: main product, upsell and order-bump of the
--   same checkout (same group_id) are ONE purchase. Refunded / chargeback
--   orders do not count. Subscription renewals are not a repurchase unless
--   asked (p_include_renewals).
--   Customers whose first known purchase is a renewal started before the
--   history the CRM has: they are left out (their real first purchase is
--   unknown).
--   "Within N days" only counts customers whose first purchase is at least N
--   days old (otherwise the window is not over yet).
--   The Cohorts tab's "Recompra" uses the same definition from now on.
-- =====================================================================

create or replace function crm.purchases(p_include_renewals boolean default false)
returns table (customer_id uuid, purchase_key text, purchased_at timestamptz, amount numeric, is_renewal boolean)
language sql stable as $$
  select o.customer_id, coalesce(nullif(o.group_id, ''), o.sale_id), min(o.paid_at), sum(coalesce(o.gross_amount, 0)),
         bool_or(r.is_renewal)
    from crm.orders o
    cross join lateral (
      select exists (select 1 from crm.financial_events f
                      where f.sale_id = o.sale_id and f.event_type = 'RENEWAL_PAYMENT') as is_renewal
    ) r
   where o.paid_at is not null and o.status in ('PAID','PARTIALLY_REFUNDED')
     and (p_include_renewals or not r.is_renewal)
   group by 1, 2
$$;

create or replace function public.crm_repurchase(p_dimension text, p_from timestamptz, p_to timestamptz,
                                                 p_include_renewals boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = crm, public, extensions as $$
declare v jsonb;
begin
  if p_dimension <> 'total' then
    perform crm.check_dimension(p_dimension, array['first_purchase_month','source','campaign','creative','product',
      'offer','funnel','affiliate','state','payment_method']);
  end if;
  with p as (select * from crm.purchases(p_include_renewals)),
  -- every paid order (with renewals) tells whether the history starts with a renewal
  started as (
    select distinct on (customer_id) customer_id, is_renewal as starts_with_renewal
      from crm.purchases(true) order by customer_id, purchased_at
  ),
  seq as (
    select p.*, row_number() over (partition by p.customer_id order by p.purchased_at, p.purchase_key) as n,
           count(*) over (partition by p.customer_id) as total
      from p
  ),
  cust as (
    select f.customer_id, f.purchased_at as first_at, f.amount as first_amount, f.total as purchases,
           s.purchased_at as second_at, s.amount as second_amount,
           extract(epoch from s.purchased_at - f.purchased_at) / 86400 as days_to_second
      from seq f
      left join seq s on s.customer_id = f.customer_id and s.n = 2
      join started st on st.customer_id = f.customer_id and not st.starts_with_renewal
     where f.n = 1 and f.purchased_at >= p_from and f.purchased_at < p_to
  ),
  base as (
    select case when p_dimension = 'total' then 'Todos'
                when p_dimension = 'first_purchase_month' then crm.month_of(c.first_at)
                else crm.dim(d, p_dimension) end as cohort,
           c.*, cu.net_ltv
      from cust c
      join crm.customers cu on cu.customer_id = c.customer_id
      left join crm.customer_dimensions d on d.customer_id = c.customer_id
  ),
  agg as (
    select cohort,
      count(*) as customers,
      count(*) filter (where second_at is not null) as repeat_customers,
      crm.pct(count(*) filter (where second_at is not null), count(*)) as repeat_rate,
      count(*) filter (where first_at <= now() - interval '30 days') as base_30,
      crm.pct(count(*) filter (where first_at <= now() - interval '30 days' and days_to_second <= 30),
              count(*) filter (where first_at <= now() - interval '30 days')) as repeat_30,
      count(*) filter (where first_at <= now() - interval '60 days') as base_60,
      crm.pct(count(*) filter (where first_at <= now() - interval '60 days' and days_to_second <= 60),
              count(*) filter (where first_at <= now() - interval '60 days')) as repeat_60,
      count(*) filter (where first_at <= now() - interval '90 days') as base_90,
      crm.pct(count(*) filter (where first_at <= now() - interval '90 days' and days_to_second <= 90),
              count(*) filter (where first_at <= now() - interval '90 days')) as repeat_90,
      round((percentile_cont(0.5) within group (order by days_to_second))::numeric, 1) as median_days_to_second,
      round(avg(days_to_second)::numeric, 1) as avg_days_to_second,
      round(avg(purchases), 2) as avg_purchases,
      round(avg(first_amount), 2) as avg_first_amount,
      round(avg(second_amount), 2) as avg_second_amount,
      round(avg(net_ltv), 2) as avg_ltv,
      round(avg(net_ltv) filter (where second_at is not null), 2) as avg_ltv_repeat,
      round(avg(net_ltv) filter (where second_at is null), 2) as avg_ltv_one_time,
      sum(net_ltv) as total_ltv
    from base group by cohort
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(a) order by a.customers desc, a.cohort) from agg a), '[]'),
    'include_renewals', p_include_renewals,
    -- the oldest purchase the CRM knows: before it, "first purchase" may be a second one
    'history_since', (select min(purchased_at) from crm.purchases(true)),
    'left_out', (select count(*) from started where starts_with_renewal)
  ) into v;
  return v;
end;
$$;

revoke all on function public.crm_repurchase(text, timestamptz, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.crm_repurchase(text, timestamptz, timestamptz, boolean) to service_role;

-- Cohorts: "Recompra" with the same definition.
create or replace function crm.cohorts(p_dimension text, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable as $$
declare v jsonb;
begin
  perform crm.check_dimension(p_dimension, array['first_purchase_month','first_subscription_month','source','campaign',
    'creative','product','offer','funnel','affiliate','state','payment_method']);
  with base as (
    select crm.dim(d, p_dimension) as cohort, c.*
    from crm.customer_dimensions d join crm.customers c using (customer_id)
    where d.first_purchase_at >= p_from and d.first_purchase_at < p_to
  ),
  subs as (
    select b.cohort, sc.*
    from base b join crm.subscription_cycles sc on sc.customer_id = b.customer_id
  ),
  ret as (
    select cohort, jsonb_object_agg('c' || n, rate order by n) as retention
    from (
      select s.cohort, n, crm.pct(
               count(*) filter (where s.cycles_paid >= n and crm.eligible_for_cycle(s.start_date, s.cycle_days, n)),
               count(*) filter (where crm.eligible_for_cycle(s.start_date, s.cycle_days, n))) as rate
      from subs s cross join generate_series(1, 5) n
      group by s.cohort, n
    ) x group by cohort
  ),
  agg as (
    select b.cohort,
      count(*) as customers,
      round(avg(b.gross_ltv), 2) as avg_gross_ltv,
      round(avg(b.net_ltv), 2) as avg_net_ltv,
      round(avg(b.contribution_ltv), 2) as avg_contribution_ltv,
      sum(b.net_ltv) as total_net_revenue,
      crm.pct(count(*) filter (where b.total_refunds > 0), count(*)) as refund_rate,
      -- bought again in another checkout (upsell / order-bump of the same checkout and subscription
      -- renewals are not a repurchase)
      crm.pct(count(*) filter (where (select count(*) from crm.purchases(false) p
                                       where p.customer_id = b.customer_id) >= 2), count(*)) as repeat_rate,
      crm.pct(count(*) filter (where b.current_lifecycle_stage in ('CHURNED','CANCELLED')
                                  or b.current_customer_type in ('CHURNED_CUSTOMER','FORMER_SUBSCRIBER')), count(*)) as churn_rate
    from base b group by b.cohort
  ),
  sub_agg as (
    select cohort, count(*) as subscriptions,
      crm.pct(count(*) filter (where cycles_paid >= 2 and crm.eligible_for_cycle(start_date, cycle_days, 2)),
              count(*) filter (where crm.eligible_for_cycle(start_date, cycle_days, 2))) as renewal_rate
    from subs group by cohort
  )
  select coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object(
           'subscriptions', coalesce(sa.subscriptions, 0),
           'renewal_rate', sa.renewal_rate,
           'retention', r.retention) order by a.cohort), '[]')
    into v
    from agg a
    left join sub_agg sa on sa.cohort is not distinct from a.cohort
    left join ret r on r.cohort is not distinct from a.cohort;
  return v;
end;
$$;
