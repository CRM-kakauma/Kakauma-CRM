CREATE OR REPLACE FUNCTION public.analytics_breakdown(p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  with sales as (
    select distinct on (e.transaction_id)
      coalesce(nullif(e.metadata->'utm'->>'source',''), '(sem origem)') as utm_source,
      coalesce(nullif(e.metadata->'utm'->>'campaign',''), '(sem campanha)') as utm_campaign,
      coalesce(nullif(e.metadata->>'offer_name',''), nullif(e.metadata->>'product_name',''), coalesce(e.product_id,'(sem produto)')) as offer,
      coalesce(t.value, e.value, 0) as value,
      coalesce(t.net_value, t.value, e.value, 0) as net_value,
      coalesce(t.affiliate_value, 0) as affiliate_value,
      coalesce((e.metadata->>'quantity')::numeric, 1) as qty
    from public.events e left join public.transactions t on t.id = e.transaction_id
    where e.event_type = 'PURCHASE_APPROVED' and e."timestamp" >= p_from and e."timestamp" < p_to
    order by e.transaction_id, e."timestamp"
  ),
  g as (
    select jsonb_agg(jsonb_build_object('key', k, 'sales', n, 'revenue', r, 'net_revenue', nr, 'affiliate_cost', ac, 'units', u) order by r desc) as j, dim
    from (
      select 'source' dim, utm_source k, count(*) n, sum(value) r, sum(net_value) nr, sum(affiliate_value) ac, sum(qty) u from sales group by 2
      union all
      select 'campaign', utm_source || ' · ' || utm_campaign, count(*), sum(value), sum(net_value), sum(affiliate_value), sum(qty) from sales group by 2
      union all
      select 'offer', offer, count(*), sum(value), sum(net_value), sum(affiliate_value), sum(qty) from sales group by 2
    ) x group by dim
  )
  select jsonb_build_object(
    'sources', coalesce((select j from g where dim='source'), '[]'::jsonb),
    'campaigns', coalesce((select j from g where dim='campaign'), '[]'::jsonb),
    'offers', coalesce((select j from g where dim='offer'), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.customer_profile(p_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select jsonb_build_object(
    'latest', (select e.metadata from public.events e where e.user_id = p_user_id and e.metadata ? 'provider' order by e."timestamp" desc limit 1),
    'first_touch', (select e.metadata->'utm' from public.events e where e.user_id = p_user_id and e.metadata ? 'utm' order by e."timestamp" asc limit 1),
    'offers', (select coalesce(jsonb_agg(distinct e.metadata->>'offer_name') filter (where e.metadata->>'offer_name' is not null), '[]'::jsonb) from public.events e where e.user_id = p_user_id),
    'transactions', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'external_transaction_id', t.external_transaction_id, 'value', t.value, 'net_value', t.net_value, 'affiliate_value', t.affiliate_value, 'status', t.status, 'payment_method', t.payment_method, 'created_at', t.created_at) order by t.created_at desc), '[]'::jsonb) from public.transactions t where t.user_id = p_user_id)
  );
$$;

GRANT EXECUTE ON FUNCTION public.analytics_breakdown(timestamptz, timestamptz) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_profile(uuid) TO anon, authenticated;