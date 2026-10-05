-- =====================================================================
-- KAKAUMA CRM — phase 4: analytics
--
-- Every metric is computed from facts on demand (no stored aggregates to
-- drift). Rates whose denominator is zero are NULL, never 0 or a guess.
-- Retention only counts subscriptions that have had time to reach a cycle
-- ("eligible"), so young cohorts are not reported as churned.
-- CAC needs ad spend, which B4you does not send: it comes from
-- crm.marketing_spend (imported) and is NULL when there is no spend data.
-- =====================================================================

insert into crm.settings (key, value, description) values
  ('report_timezone', '"America/Sao_Paulo"', 'Fuso usado para meses de cohort e períodos'),
  ('default_cycle_days', '30', 'Duração de ciclo quando a frequência da assinatura é desconhecida');

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

create function crm.report_tz() returns text
language sql stable as $$
  select coalesce((select value #>> '{}' from crm.settings where key = 'report_timezone'), 'America/Sao_Paulo')
$$;

create function crm.month_of(p timestamptz) returns text
language sql stable as $$
  select to_char(p at time zone crm.report_tz(), 'YYYY-MM')
$$;

create function crm.pct(p_num numeric, p_den numeric) returns numeric
language sql immutable as $$
  select case when coalesce(p_den, 0) > 0 then round(coalesce(p_num, 0) * 100 / p_den, 1) end
$$;

create function crm.div(p_num numeric, p_den numeric, p_scale int default 2) returns numeric
language sql immutable as $$
  select case when coalesce(p_den, 0) <> 0 and p_num is not null then round(p_num / p_den, p_scale) end
$$;

create function crm.cycle_days(p_frequency text) returns int
language sql stable as $$
  select case
    when p_frequency ~* '(week|seman)' then 7
    when p_frequency ~* '(bimonth|bimestr)' then 60
    when p_frequency ~* '(quarter|trimestr)' then 90
    when p_frequency ~* '(semiann|semestr|half)' then 180
    when p_frequency ~* '(year|annual|anual)' then 365
    when p_frequency ~* '(month|mensal)' then 30
    else coalesce(crm.setting_num('default_cycle_days'), 30)::int end
$$;

create function crm.check_dimension(p_dimension text, p_allowed text[]) returns void
language plpgsql immutable as $$
begin
  if not p_dimension = any (p_allowed) then
    raise exception 'unknown dimension "%" (allowed: %)', p_dimension, array_to_string(p_allowed, ', ');
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- MARKETING SPEND (for CAC, clicks). Imported from ad platforms / sheets.
-- ---------------------------------------------------------------------

create table crm.marketing_spend (
  id bigint generated always as identity primary key,
  spend_date date not null,
  source text not null,              -- lower-case, same vocabulary as utm_source
  campaign text not null default '',
  creative text not null default '', -- same vocabulary as utm_content
  spend numeric(14,2) not null check (spend >= 0),
  clicks int check (clicks >= 0),
  impressions int check (impressions >= 0),
  currency text not null default 'BRL',
  imported_at timestamptz not null default now(),
  unique (spend_date, source, campaign, creative)
);
alter table crm.marketing_spend enable row level security;
revoke all on crm.marketing_spend from public, anon, authenticated;
grant select, insert, update on crm.marketing_spend to service_role;

-- ---------------------------------------------------------------------
-- Per-customer analytical dimensions (acquisition is the customer's first
-- attributed touch; product/offer/payment method/affiliate of the first purchase).
-- Missing values are labelled explicitly, never guessed.
-- ---------------------------------------------------------------------

create view crm.customer_dimensions as
select
  c.customer_id,
  c.first_purchase_at,
  crm.month_of(c.first_purchase_at) as first_purchase_month,
  crm.month_of(fs.first_sub) as first_subscription_month,
  coalesce(lower(a.utm_source), '(sem atribuição)') as source,
  coalesce(a.utm_campaign, '(sem atribuição)') as campaign,
  coalesce(a.utm_content, '(sem atribuição)') as creative,
  coalesce(a.funnel_name, '(sem funil)') as funnel,
  coalesce(af.email, af.name, '(sem afiliado)') as affiliate,
  coalesce(c.state, '(desconhecido)') as state,
  coalesce(fo.payment_method, '(desconhecido)') as payment_method,
  coalesce(fo.product_name, fo.product_id, '(desconhecido)') as product,
  coalesce(fo.offer_name, fo.offer_id, '(desconhecido)') as offer
from crm.customers c
left join crm.attributions a on a.attribution_id = c.acquisition_attribution_id
left join lateral (
  select o.* from crm.orders o where o.customer_id = c.customer_id and o.paid_at is not null order by o.paid_at limit 1
) fo on true
left join crm.affiliates af on af.affiliate_id = fo.affiliate_id
left join lateral (select min(s.start_date) as first_sub from crm.subscriptions s where s.customer_id = c.customer_id) fs on true;

revoke all on crm.customer_dimensions from public, anon, authenticated;
grant select on crm.customer_dimensions to service_role;

create function crm.dim(d crm.customer_dimensions, p_dimension text) returns text
language sql immutable as $$
  select case p_dimension
    when 'first_purchase_month' then d.first_purchase_month
    when 'first_subscription_month' then d.first_subscription_month
    when 'source' then d.source when 'campaign' then d.campaign when 'creative' then d.creative
    when 'funnel' then d.funnel when 'affiliate' then d.affiliate when 'state' then d.state
    when 'payment_method' then d.payment_method when 'product' then d.product when 'offer' then d.offer end
$$;

-- Subscriptions with how many cycles they paid and their cycle length.
create view crm.subscription_cycles as
select
  s.subscription_id, s.customer_id, s.start_date, s.status, s.plan_name,
  coalesce(p.name, s.product_id, '(desconhecido)') as product,
  coalesce(o.name, s.offer_id, '(desconhecido)') as offer,
  crm.cycle_days(s.frequency) as cycle_days,
  (select count(*) from crm.subscription_charges sc where sc.subscription_id = s.subscription_id and sc.paid_at is not null)::int as cycles_paid,
  s.cancelled_at, s.expired_at
from crm.subscriptions s
left join crm.products p on p.product_id = s.product_id
left join crm.offers o on o.offer_id = s.offer_id;

revoke all on crm.subscription_cycles from public, anon, authenticated;
grant select on crm.subscription_cycles to service_role;

-- A subscription is eligible for cycle n once (n−1) full cycles + grace have elapsed since it started.
create function crm.eligible_for_cycle(p_start timestamptz, p_cycle_days int, p_n int) returns boolean
language sql stable as $$
  select p_start < now() - make_interval(days => (p_n - 1) * p_cycle_days + coalesce(crm.setting_num('due_grace_days'), 1)::int)
$$;

-- ---------------------------------------------------------------------
-- SUBSCRIPTION RETENTION  C1 → C5
-- ---------------------------------------------------------------------

create function crm.retention(p_dimension text, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable as $$
declare v jsonb;
begin
  perform crm.check_dimension(p_dimension, array['first_subscription_month','product','offer','plan','source','campaign',
    'creative','funnel','affiliate','state','payment_method']);
  with subs as (
    select sc.*,
      case p_dimension
        when 'first_subscription_month' then crm.month_of(sc.start_date)
        when 'product' then sc.product when 'offer' then sc.offer
        when 'plan' then coalesce(sc.plan_name, '(desconhecido)')
        else crm.dim(d, p_dimension) end as cohort
    from crm.subscription_cycles sc
    join crm.customer_dimensions d on d.customer_id = sc.customer_id
    where sc.start_date >= p_from and sc.start_date < p_to
  ),
  cycles as (
    select s.cohort, n,
      count(*) filter (where crm.eligible_for_cycle(s.start_date, s.cycle_days, n)) as eligible,
      count(*) filter (where crm.eligible_for_cycle(s.start_date, s.cycle_days, n) and s.cycles_paid >= n) as reached,
      -- step n→n+1: of those that paid cycle n and had time to pay n+1, how many did
      count(*) filter (where s.cycles_paid >= n and crm.eligible_for_cycle(s.start_date, s.cycle_days, n + 1)) as step_base,
      count(*) filter (where s.cycles_paid >= n + 1 and crm.eligible_for_cycle(s.start_date, s.cycle_days, n + 1)) as step_reached
    from subs s cross join generate_series(1, 5) n
    group by s.cohort, n
  )
  select coalesce(jsonb_agg(t order by cohort), '[]') into v from (
    select s.cohort,
      count(*) as subscriptions,
      (select jsonb_object_agg('c' || c.n, jsonb_build_object('eligible', c.eligible, 'reached', c.reached,
                                                              'rate', crm.pct(c.reached, c.eligible)) order by c.n)
         from cycles c where c.cohort is not distinct from s.cohort) as cycles,
      (select jsonb_object_agg('c' || c.n || '_c' || (c.n + 1),
                               jsonb_build_object('base', c.step_base, 'retained', c.step_reached,
                                                  'rate', crm.pct(c.step_reached, c.step_base)) order by c.n)
         from cycles c where c.cohort is not distinct from s.cohort and c.n <= 4) as steps
    from subs s group by s.cohort
  ) t;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- COHORTS (customers grouped by when/how they were acquired)
-- ---------------------------------------------------------------------

create function crm.cohorts(p_dimension text, p_from timestamptz, p_to timestamptz) returns jsonb
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
      crm.pct(count(*) filter (where b.total_paid_orders >= 2), count(*)) as repeat_rate,
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

-- ---------------------------------------------------------------------
-- REFUND METRICS by product / offer / campaign / affiliate / payment method
-- (orders paid in the period; refunds counted whenever they happened)
-- ---------------------------------------------------------------------

create function crm.refund_metrics(p_dimension text, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable as $$
declare v jsonb;
begin
  perform crm.check_dimension(p_dimension, array['product','offer','campaign','source','affiliate','payment_method']);
  with o as (
    select ord.*,
      case p_dimension
        when 'product' then coalesce(ord.product_name, ord.product_id, '(desconhecido)')
        when 'offer' then coalesce(ord.offer_name, ord.offer_id, '(desconhecido)')
        when 'campaign' then coalesce(a.utm_campaign, d.campaign)
        when 'source' then coalesce(lower(a.utm_source), d.source)
        when 'affiliate' then coalesce(af.email, af.name, '(sem afiliado)')
        when 'payment_method' then coalesce(ord.payment_method, '(desconhecido)') end as key,
      (select coalesce(sum(r.amount), 0) from crm.refunds r
        join crm.transactions t on t.transaction_id = r.transaction_id
       where t.order_id = ord.order_id) as refund_amount,
      (select count(*) from crm.refunds r
        join crm.transactions t on t.transaction_id = r.transaction_id
       where t.order_id = ord.order_id) as refund_count
    from crm.orders ord
    left join crm.attributions a0 on a0.attribution_id = ord.attribution_id
    left join crm.attributions a on a.attribution_id = coalesce(a0.inherited_from, a0.attribution_id)
    left join crm.customer_dimensions d on d.customer_id = ord.customer_id
    left join crm.affiliates af on af.affiliate_id = ord.affiliate_id
    where ord.paid_at >= p_from and ord.paid_at < p_to
  )
  select coalesce(jsonb_agg(t order by gross_revenue desc nulls last, key), '[]') into v from (
    select key,
      count(*) as orders,
      sum(gross_amount) as gross_revenue,
      count(*) filter (where refund_count > 0) as refunded_orders,
      sum(refund_count) as refund_count,
      sum(refund_amount) as refund_revenue,
      sum(gross_amount) - sum(refund_amount) as net_revenue,
      crm.pct(count(*) filter (where refund_count > 0), count(*)) as refund_rate,
      crm.pct(sum(refund_amount), sum(gross_amount)) as refund_revenue_rate
    from o group by key
  ) t;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- CAMPAIGN QUALITY: high sales/low LTV vs low sales/high LTV
-- ---------------------------------------------------------------------

create function crm.campaign_quality(p_level text, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable as $$
declare v jsonb;
begin
  perform crm.check_dimension(p_level, array['source','campaign','creative','funnel']);
  with
  -- order → acquisition-level key (inherited attributions resolve to the original touch)
  ord as (
    select o.*, d.customer_id as cid,
      case p_level
        when 'source' then coalesce(lower(a.utm_source), '(sem atribuição)')
        when 'campaign' then coalesce(a.utm_campaign, '(sem atribuição)')
        when 'creative' then coalesce(a.utm_content, '(sem atribuição)')
        when 'funnel' then coalesce(a.funnel_name, '(sem funil)') end as key
    from crm.orders o
    join crm.customer_dimensions d on d.customer_id = o.customer_id
    left join crm.attributions a0 on a0.attribution_id = o.attribution_id
    left join crm.attributions a on a.attribution_id = coalesce(a0.inherited_from, a0.attribution_id, (
      select acquisition_attribution_id from crm.customers c where c.customer_id = o.customer_id))
  ),
  chk as (
    select case p_level
        when 'source' then coalesce(lower(a.utm_source), '(sem atribuição)')
        when 'campaign' then coalesce(a.utm_campaign, '(sem atribuição)')
        when 'creative' then coalesce(a.utm_content, '(sem atribuição)')
        when 'funnel' then coalesce(a.funnel_name, '(sem funil)') end as key,
      count(*) as n
    from crm.checkouts ck left join crm.attributions a on a.raw_event_id = ck.raw_event_id
    where ck.abandoned_at >= p_from and ck.abandoned_at < p_to
    group by 1
  ),
  cust as (
    select crm.dim(d, p_level) as key, c.*
    from crm.customer_dimensions d join crm.customers c using (customer_id)
    where d.first_purchase_at >= p_from and d.first_purchase_at < p_to
  ),
  sub as (
    select crm.dim(d, p_level) as key, s.*
    from crm.subscriptions s join crm.customer_dimensions d on d.customer_id = s.customer_id
  ),
  spend as (
    select case p_level
        when 'source' then lower(source) when 'campaign' then campaign
        when 'creative' then creative else null end as key,
      sum(spend) as spend, sum(clicks) as clicks, sum(impressions) as impressions
    from crm.marketing_spend
    where spend_date >= (p_from at time zone crm.report_tz())::date and spend_date < (p_to at time zone crm.report_tz())::date
    group by 1
  ),
  keys as (
    select key from ord where coalesce(paid_at, created_at) >= p_from and coalesce(paid_at, created_at) < p_to
    union select key from chk union select key from cust union select key from spend where key is not null
  ),
  m as (
    select k.key,
      sp.clicks, sp.impressions, sp.spend,
      coalesce(ch.n, 0) + (select count(*) from ord o where o.key = k.key and o.created_at >= p_from and o.created_at < p_to) as checkouts,
      (select count(*) from ord o where o.key = k.key and o.paid_at >= p_from and o.paid_at < p_to) as purchases,
      (select coalesce(sum(o.gross_amount), 0) from ord o where o.key = k.key and o.paid_at >= p_from and o.paid_at < p_to) as revenue,
      (select coalesce(sum(r.amount), 0) from crm.refunds r join crm.transactions t on t.transaction_id = r.transaction_id
         join ord o on o.order_id = t.order_id where o.key = k.key and r.created_at >= p_from and r.created_at < p_to) as refunds,
      (select count(*) from cust c where c.key = k.key) as customers_acquired,
      (select round(avg(c.net_ltv), 2) from cust c where c.key = k.key) as avg_net_ltv,
      (select round(avg(c.contribution_ltv), 2) from cust c where c.key = k.key) as avg_contribution_ltv,
      (select crm.pct(count(*) filter (where c.total_refunds > 0), count(*)) from cust c where c.key = k.key) as customer_refund_rate,
      (select count(*) from sub s where s.key = k.key and s.start_date >= p_from and s.start_date < p_to) as subscriptions,
      (select count(*) from crm.financial_events fe join sub s on s.subscription_id = fe.subscription_id
        where s.key = k.key and fe.event_type = 'RENEWAL_PAYMENT' and fe.occurred_at >= p_from and fe.occurred_at < p_to) as renewals,
      (select count(*) from sub s where s.key = k.key
          and coalesce(s.cancelled_at, s.expired_at) >= p_from and coalesce(s.cancelled_at, s.expired_at) < p_to) as churned_subscriptions
    from keys k
    left join chk ch on ch.key = k.key
    left join spend sp on sp.key = k.key
  ),
  med as (
    select percentile_cont(0.5) within group (order by customers_acquired) as med_customers,
           percentile_cont(0.5) within group (order by avg_net_ltv) as med_ltv,
           count(*) filter (where customers_acquired > 0) as n
    from m where customers_acquired > 0
  )
  select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object(
      'net_revenue', m.revenue - m.refunds,
      'checkout_conversion', crm.pct(m.purchases, m.checkouts),
      'cac', crm.div(m.spend, m.customers_acquired),
      'ltv_cac', crm.div(m.avg_net_ltv, crm.div(m.spend, m.customers_acquired)),
      'quadrant', case when med.n < 2 or m.customers_acquired = 0 then null
                       else (case when m.customers_acquired >= med.med_customers then 'HIGH_SALES' else 'LOW_SALES' end)
                         || '_' || (case when m.avg_net_ltv >= med.med_ltv then 'HIGH_LTV' else 'LOW_LTV' end) end)
    order by m.revenue desc, m.key), '[]')
    into v
    from m cross join med;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- FUNNEL (section 46)
-- ---------------------------------------------------------------------

create function crm.funnel(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable as $$
  with f as (
    select customer_id, fact_type from crm.customer_events
    where occurred_at >= p_from and occurred_at < p_to
      and fact_type in ('CHECKOUT_ABANDONED','PAYMENT_PENDING','PURCHASE_PAID','FULFILLMENT_DELIVERED')
  ),
  s as (
    select
      count(distinct customer_id) filter (where fact_type in ('CHECKOUT_ABANDONED','PAYMENT_PENDING','PURCHASE_PAID')) as started,
      count(distinct customer_id) filter (where fact_type = 'CHECKOUT_ABANDONED') as abandoned,
      count(distinct customer_id) filter (where fact_type in ('PAYMENT_PENDING','PURCHASE_PAID')) as payment_initiated,
      count(distinct customer_id) filter (where fact_type = 'PURCHASE_PAID') as approved,
      count(distinct customer_id) filter (where fact_type = 'FULFILLMENT_DELIVERED') as delivered
    from f
  ),
  abandoned_lost as (
    select count(distinct a.customer_id) as n from f a
    where a.fact_type = 'CHECKOUT_ABANDONED'
      and not exists (select 1 from f p where p.customer_id = a.customer_id and p.fact_type = 'PURCHASE_PAID')
  ),
  methods as (
    select coalesce(payment_method, 'unknown') as method,
      count(*) as transactions,
      count(*) filter (where paid_at is not null) as paid
    from crm.transactions
    where created_at >= p_from and created_at < p_to and transaction_key not like 'sub:%'
    group by 1
  )
  select jsonb_build_object(
    'stages', jsonb_build_object(
      'checkout_started', s.started, 'cart_abandoned', s.abandoned, 'payment_initiated', s.payment_initiated,
      'payment_approved', s.approved, 'delivered', s.delivered),
    'checkout_conversion', crm.pct(s.payment_initiated, s.started),
    'cart_abandonment_rate', crm.pct((select n from abandoned_lost), s.started),
    'payment_conversion', crm.pct(s.approved, s.payment_initiated),
    'purchase_conversion', crm.pct(s.approved, s.started),
    'by_payment_method', (select coalesce(jsonb_object_agg(method, jsonb_build_object(
        'transactions', transactions, 'paid', paid, 'conversion', crm.pct(paid, transactions))), '{}') from methods),
    'pix_conversion', (select crm.pct(paid, transactions) from methods where method = 'pix'),
    'note', 'B4you não envia "checkout iniciado": início = abandono, PIX/boleto gerado ou compra no período.')
  from s
$$;

-- ---------------------------------------------------------------------
-- MAIN DASHBOARD (section 57)
-- ---------------------------------------------------------------------

create function crm.dashboard(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable as $$
declare
  v_grace int := coalesce(crm.setting_num('due_grace_days'), 1)::int;
  v_hv numeric := crm.setting_num('high_value_net_ltv');
  acquisition jsonb; commerce jsonb; subscription jsonb; fulfillment jsonb; customer jsonb;
begin
  -- Acquisition
  select jsonb_build_object(
    'customers_acquired', count(*),
    'spend', (select sum(spend) from crm.marketing_spend
               where spend_date >= (p_from at time zone crm.report_tz())::date and spend_date < (p_to at time zone crm.report_tz())::date),
    'cac', crm.div((select sum(spend) from crm.marketing_spend
               where spend_date >= (p_from at time zone crm.report_tz())::date and spend_date < (p_to at time zone crm.report_tz())::date), count(*)),
    'conversion', (crm.funnel(p_from, p_to) -> 'purchase_conversion'),
    'campaign_revenue', (select coalesce(sum(o.gross_amount), 0) from crm.orders o
        join crm.attributions a on a.attribution_id = o.attribution_id
       where o.paid_at >= p_from and o.paid_at < p_to and a.touch_type in ('acquisition','touch') and a.utm_campaign is not null))
  into acquisition
  from crm.customers where first_purchase_at >= p_from and first_purchase_at < p_to;

  -- Commerce (money flows in the period)
  with fe as (select * from crm.financial_events where occurred_at >= p_from and occurred_at < p_to),
       paid_orders as (select * from crm.orders where paid_at >= p_from and paid_at < p_to)
  select jsonb_build_object(
    'orders', (select count(*) from paid_orders),
    'gross_revenue', coalesce(sum(amount) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT')), 0),
    'refunds', coalesce(sum(amount) filter (where event_type in ('REFUND','PARTIAL_REFUND')), 0),
    'chargebacks', coalesce(sum(amount) filter (where event_type = 'CHARGEBACK'), 0),
    'net_revenue', coalesce(sum(amount) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT')), 0)
                 - coalesce(sum(amount) filter (where event_type in ('REFUND','PARTIAL_REFUND','CHARGEBACK')), 0),
    'platform_fees', coalesce(sum(platform_fee) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT')), 0),
    'aov', crm.div(sum(amount) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT')),
                   count(*) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT'))),
    'refund_rate', crm.pct((select count(*) from paid_orders po where po.status in ('PARTIALLY_REFUNDED','REFUNDED','CHARGEBACK')),
                           (select count(*) from paid_orders)),
    'pending_release', (select coalesce(sum(my_commission), 0) from crm.transactions
                         where paid_at is not null and released is false),
    'released', (select coalesce(sum(my_commission), 0) from crm.transactions
                  where paid_at is not null and released is true and release_date >= p_from and release_date < p_to))
  into commerce from fe;

  -- Subscription
  with subs as (select * from crm.subscription_cycles),
  expected as (  -- renewals that were due in the period (and had their grace period)
    select sc.subscription_id, sc.cycle_number,
           sc.paid_at + make_interval(days => crm.cycle_days(s.frequency)) as due_at,
           exists (select 1 from crm.subscription_charges n where n.subscription_id = sc.subscription_id
                    and n.paid_at is not null and n.cycle_number = sc.cycle_number + 1) as renewed
    from crm.subscription_charges sc join crm.subscriptions s using (subscription_id)
    where sc.paid_at is not null and sc.cycle_number is not null
  ),
  due as (select * from expected where due_at >= p_from and due_at < p_to and due_at < now() - make_interval(days => v_grace)),
  late as (select * from crm.customer_events where fact_type = 'SUBSCRIPTION_PAYMENT_LATE' and occurred_at >= p_from and occurred_at < p_to),
  creq as (select * from crm.customer_events where fact_type = 'SUBSCRIPTION_CANCELLATION_REQUESTED' and occurred_at >= p_from and occurred_at < p_to),
  base as (select count(*) as n from crm.subscriptions
            where start_date < p_from and coalesce(cancelled_at, expired_at, 'infinity'::timestamptz) >= p_from)
  select jsonb_build_object(
    'active_subscribers', (select count(*) from crm.subscriptions where status not in ('CANCELLED','INACTIVE','EXPIRED')),
    'new_subscribers', (select count(*) from crm.subscriptions where start_date >= p_from and start_date < p_to),
    'renewals', (select count(*) from crm.financial_events where event_type = 'RENEWAL_PAYMENT' and occurred_at >= p_from and occurred_at < p_to),
    'renewals_due', (select count(*) from due),
    'renewal_rate', crm.pct((select count(*) from due where renewed), (select count(*) from due)),
    'churned', (select count(*) from crm.subscriptions where coalesce(cancelled_at, expired_at) >= p_from and coalesce(cancelled_at, expired_at) < p_to),
    'churn_rate', crm.pct((select count(*) from crm.subscriptions where start_date < p_from
                             and coalesce(cancelled_at, expired_at) >= p_from and coalesce(cancelled_at, expired_at) < p_to),
                          (select n from base)),
    'late_payments', (select count(*) from late),
    'late_rate', crm.pct((select count(distinct subscription_id) from late),
                         (select count(*) from crm.subscriptions where start_date < p_to
                            and coalesce(cancelled_at, expired_at, 'infinity'::timestamptz) >= p_from)),
    'recovery_rate', crm.pct((select count(*) from late l where exists (
                               select 1 from crm.customer_events r where r.subscription_id = l.subscription_id
                                and r.fact_type = 'SUBSCRIPTION_PAYMENT_RECOVERED' and r.occurred_at >= l.occurred_at)),
                             (select count(*) from late)),
    'churn_after_late_rate', crm.pct((select count(*) from late l where exists (
                               select 1 from crm.subscriptions s where s.subscription_id = l.subscription_id
                                and coalesce(s.cancelled_at, s.expired_at) >= l.occurred_at)),
                             (select count(*) from late)),
    'cancellation_requests', (select count(*) from creq),
    'cancellation_completion_rate', crm.pct((select count(*) from creq c where exists (
                               select 1 from crm.customer_events x where x.subscription_id = c.subscription_id
                                and x.fact_type = 'SUBSCRIPTION_CANCELLED' and x.occurred_at >= c.occurred_at)),
                             (select count(*) from creq)),
    'save_rate', crm.pct((select count(*) from creq c where exists (
                               select 1 from crm.customer_events x where x.subscription_id = c.subscription_id
                                and x.fact_type = 'SUBSCRIPTION_SAVED' and x.occurred_at >= c.occurred_at)),
                             (select count(*) from creq)),
    'post_cancellation_reactivation_rate', crm.pct(
        (select count(*) from crm.subscriptions where reactivated_at is not null
            and coalesce(cancelled_at, expired_at) >= p_from and coalesce(cancelled_at, expired_at) < p_to),
        (select count(*) from crm.subscriptions where coalesce(cancelled_at, expired_at) >= p_from and coalesce(cancelled_at, expired_at) < p_to)))
  into subscription;

  -- Fulfillment (orders whose fulfillment was created in the period, by current status)
  select jsonb_build_object(
    'fulfillments', count(*),
    'shipped', count(*) filter (where status in ('SHIPPED','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_DELAYED')),
    'in_transit', count(*) filter (where status in ('SHIPPED','IN_TRANSIT','OUT_FOR_DELIVERY')),
    'delivered', count(*) filter (where status = 'DELIVERED'),
    'delayed', count(*) filter (where status = 'DELIVERY_DELAYED' or (estimated_delivery_at is not null and coalesce(delivered_at, now()) > estimated_delivery_at)),
    'failed', count(*) filter (where status in ('DELIVERY_FAILED','DELIVERY_RETURNED','DELIVERY_LOST')),
    'avg_delivery_days', round(avg(extract(epoch from delivered_at - coalesce(shipped_at, created_at)) / 86400)::numeric, 1),
    'shipping_cost', coalesce(sum(shipping_cost), 0))
  into fulfillment
  from crm.fulfillments where created_at >= p_from and created_at < p_to;

  -- Customer (current snapshot)
  select jsonb_build_object(
    'customers', count(*) filter (where total_paid_orders > 0),
    'avg_gross_ltv', round(avg(gross_ltv) filter (where total_paid_orders > 0), 2),
    'avg_net_ltv', round(avg(net_ltv) filter (where total_paid_orders > 0), 2),
    'avg_contribution_ltv', round(avg(contribution_ltv) filter (where total_paid_orders > 0), 2),
    'high_value_customers', count(*) filter (where net_ltv >= v_hv),
    'at_risk_customers', count(*) filter (where current_risk_state in ('AT_RISK','PAYMENT_RISK','CHURN_RISK','HIGH_VALUE_AT_RISK')),
    'high_value_at_risk', count(*) filter (where current_risk_state = 'HIGH_VALUE_AT_RISK'),
    'reactivated_customers', count(*) filter (where current_customer_type = 'REACTIVATED_CUSTOMER'))
  into customer
  from crm.customers;

  return jsonb_build_object('period', jsonb_build_object('from', p_from, 'to', p_to),
    'acquisition', acquisition, 'commerce', commerce, 'subscription', subscription,
    'fulfillment', fulfillment, 'customer', customer);
end;
$$;

-- ---------------------------------------------------------------------
-- PUBLIC ENTRY POINTS (service_role only)
-- ---------------------------------------------------------------------

create function public.crm_dashboard(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$ select crm.dashboard(p_from, p_to) $$;

create function public.crm_funnel(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$ select crm.funnel(p_from, p_to) $$;

create function public.crm_cohorts(p_dimension text, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$ select crm.cohorts(p_dimension, p_from, p_to) $$;

create function public.crm_retention(p_dimension text, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$ select crm.retention(p_dimension, p_from, p_to) $$;

create function public.crm_refund_metrics(p_dimension text, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$ select crm.refund_metrics(p_dimension, p_from, p_to) $$;

create function public.crm_campaign_quality(p_level text, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$ select crm.campaign_quality(p_level, p_from, p_to) $$;

-- rows: [{"date":"2026-09-01","source":"facebook","campaign":"x","creative":"y","spend":100,"clicks":50,"impressions":1000}]
create function public.crm_import_marketing_spend(p_rows jsonb) returns int
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v_count int;
begin
  insert into crm.marketing_spend (spend_date, source, campaign, creative, spend, clicks, impressions, currency)
  select (r ->> 'date')::date, lower(btrim(r ->> 'source')), coalesce(r ->> 'campaign', ''), coalesce(r ->> 'creative', ''),
         (r ->> 'spend')::numeric, (r ->> 'clicks')::int, (r ->> 'impressions')::int, coalesce(r ->> 'currency', 'BRL')
    from jsonb_array_elements(p_rows) r
  on conflict (spend_date, source, campaign, creative) do update set
    spend = excluded.spend, clicks = excluded.clicks, impressions = excluded.impressions,
    currency = excluded.currency, imported_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_dashboard(timestamptz,timestamptz)',
    'crm_funnel(timestamptz,timestamptz)',
    'crm_cohorts(text,timestamptz,timestamptz)',
    'crm_retention(text,timestamptz,timestamptz)',
    'crm_refund_metrics(text,timestamptz,timestamptz)',
    'crm_campaign_quality(text,timestamptz,timestamptz)',
    'crm_import_marketing_spend(jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
