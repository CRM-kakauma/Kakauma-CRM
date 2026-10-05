-- =====================================================================
-- KAKAUMA CRM — customers as a board (kanban by a computed state) and
-- dashboard time series.
-- =====================================================================

-- Customers grouped into columns by lifecycle, risk, type or value tier.
-- Columns are computed from events (not dragged by hand). Each column has the
-- full count and LTV, plus the first p_per_column cards.
create function crm.customer_board(p_group text, p_query text default null, p_lifecycle text default null,
                                   p_risk text default null, p_type text default null, p_segment text default null,
                                   p_per_column int default 30, p_sort text default 'value') returns jsonb
language plpgsql stable as $$
declare
  v jsonb;
  v_high numeric := ((select value from crm.settings where key = 'value_tiers') ->> 'high')::numeric;
  v_medium numeric := ((select value from crm.settings where key = 'value_tiers') ->> 'medium')::numeric;
begin
  if p_group not in ('lifecycle','risk','customer_type','value_tier') then
    raise exception 'unknown board group "%" (allowed: lifecycle, risk, customer_type, value_tier)', p_group;
  end if;
  if p_sort not in ('value','recent') then raise exception 'unknown sort "%"', p_sort; end if;
  with base as (
    select s.*, c.cx_score, c.total_paid_orders,
           case when c.total_paid_orders = 0 then null
                when c.net_ltv >= v_high then 'high' when c.net_ltv >= v_medium then 'medium' else 'low' end as value_tier
      from crm.search_customers(p_query, p_lifecycle, p_risk, p_type, 100000, 0) s
      join crm.customers c using (customer_id)
     where p_segment is null or exists (
       select 1 from crm.segment_members m join crm.segments g using (segment_id)
        where g.key = p_segment and m.customer_id = s.customer_id)
  ),
  grouped as (
    select b.*,
           case p_group when 'lifecycle' then b.lifecycle when 'risk' then b.risk
                        when 'customer_type' then b.customer_type else b.value_tier end as col
      from base b
  ),
  ranked as (
    select g.*, row_number() over (
             partition by g.col
             order by case when p_sort = 'recent' then g.last_purchase_at end desc nulls last,
                      g.net_ltv desc, g.last_seen_at desc nulls last) as rn
      from grouped g
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', t.col, 'count', t.n, 'net_ltv', t.ltv, 'cards', t.cards) order by t.n desc), '[]')
    into v
    from (
      select col, count(*) as n, coalesce(sum(net_ltv), 0) as ltv,
             coalesce(jsonb_agg(jsonb_build_object(
               'customer_id', customer_id, 'full_name', full_name, 'email', email, 'whatsapp', whatsapp,
               'customer_type', customer_type, 'lifecycle', lifecycle, 'risk', risk, 'net_ltv', net_ltv,
               'paid_orders', total_paid_orders, 'cx_score', cx_score, 'last_purchase_at', last_purchase_at)
               order by rn) filter (where rn <= least(greatest(p_per_column, 1), 200)), '[]') as cards
        from ranked group by col
    ) t;
  return v;
end;
$$;

-- Money, orders, customers and subscriptions per day / week / month
-- (report timezone). Every bucket of the range is present, zero included.
create function crm.timeseries(p_from timestamptz, p_to timestamptz, p_bucket text default 'day') returns jsonb
language plpgsql stable as $$
declare
  v jsonb;
  tz text := crm.report_tz();
  step interval;
begin
  if p_bucket not in ('day','week','month') then raise exception 'unknown bucket "%"', p_bucket; end if;
  if p_to <= p_from then raise exception 'empty period'; end if;
  step := ('1 ' || p_bucket)::interval;
  if (extract(epoch from (p_to - p_from)) / extract(epoch from (case p_bucket when 'day' then interval '1 day'
        when 'week' then interval '7 days' else interval '30 days' end))) > 400 then
    raise exception 'too many points: use a larger bucket';
  end if;

  with buckets as (
    select gs as k
      from generate_series(date_trunc(p_bucket, p_from at time zone tz),
                           date_trunc(p_bucket, (p_to - interval '1 second') at time zone tz), step) gs
  ),
  money as (
    select date_trunc(p_bucket, occurred_at at time zone tz) as k,
           sum(amount) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT')) as gross,
           sum(amount) filter (where event_type in ('REFUND','PARTIAL_REFUND','CHARGEBACK')) as refunds,
           count(*) filter (where event_type = 'RENEWAL_PAYMENT') as renewals
      from crm.financial_events where occurred_at >= p_from and occurred_at < p_to group by 1
  ),
  orders as (
    select date_trunc(p_bucket, paid_at at time zone tz) as k, count(*) as n
      from crm.orders where paid_at >= p_from and paid_at < p_to group by 1
  ),
  new_customers as (
    select date_trunc(p_bucket, first_purchase_at at time zone tz) as k, count(*) as n
      from crm.customers where first_purchase_at >= p_from and first_purchase_at < p_to group by 1
  ),
  subs_new as (
    select date_trunc(p_bucket, start_date at time zone tz) as k, count(*) as n
      from crm.subscriptions where start_date >= p_from and start_date < p_to group by 1
  ),
  subs_end as (
    select date_trunc(p_bucket, coalesce(cancelled_at, expired_at) at time zone tz) as k, count(*) as n
      from crm.subscriptions where coalesce(cancelled_at, expired_at) >= p_from and coalesce(cancelled_at, expired_at) < p_to
     group by 1
  ),
  late as (
    select date_trunc(p_bucket, occurred_at at time zone tz) as k, count(*) as n
      from crm.customer_events where fact_type = 'SUBSCRIPTION_PAYMENT_LATE' and occurred_at >= p_from and occurred_at < p_to
     group by 1
  ),
  spend as (
    select date_trunc(p_bucket, spend_date::timestamp) as k, sum(spend) as n
      from crm.marketing_spend
     where spend_date >= (p_from at time zone tz)::date and spend_date < (p_to at time zone tz)::date
     group by 1
  )
  select jsonb_agg(jsonb_build_object(
           'bucket', to_char(b.k, 'YYYY-MM-DD'),
           'gross_revenue', coalesce(m.gross, 0),
           'refunds', coalesce(m.refunds, 0),
           'net_revenue', coalesce(m.gross, 0) - coalesce(m.refunds, 0),
           'orders', coalesce(o.n, 0),
           'new_customers', coalesce(nc.n, 0),
           'new_subscriptions', coalesce(sn.n, 0),
           'renewals', coalesce(m.renewals, 0),
           'cancellations', coalesce(se.n, 0),
           'late_payments', coalesce(l.n, 0),
           'spend', sp.n) order by b.k)
    into v
    from buckets b
    left join money m using (k) left join orders o using (k) left join new_customers nc using (k)
    left join subs_new sn using (k) left join subs_end se using (k) left join late l using (k)
    left join spend sp using (k);
  return coalesce(v, '[]');
end;
$$;

create function public.crm_customer_board(p_group text, p_query text default null, p_lifecycle text default null,
                                          p_risk text default null, p_type text default null, p_segment text default null,
                                          p_per_column int default 30, p_sort text default 'value') returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select crm.customer_board(p_group, p_query, p_lifecycle, p_risk, p_type, p_segment, p_per_column, p_sort)
$$;

create function public.crm_timeseries(p_from timestamptz, p_to timestamptz, p_bucket text default 'day') returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select crm.timeseries(p_from, p_to, p_bucket)
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_customer_board(text,text,text,text,text,text,int,text)',
    'crm_timeseries(timestamptz,timestamptz,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
