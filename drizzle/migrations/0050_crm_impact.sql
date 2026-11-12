-- =====================================================================
-- KAKAUMA CRM — "Desde o início, o CRM trouxe R$ X" (aba Resultados)
--
--   Since the first real CRM send (tests left out), every paid order is put in
--   one bucket at most, the first that applies:
--     recovered   a cart / Pix-boleto / refused payment in the 7 days before
--                 paying, and a CRM message after it and before paying
--     clicked     the checkout came with the CRM's UTM (utm_medium = crm)
--     influenced  a CRM message in the 7 days before paying
--   Value: amount paid (gross_amount). Refunded orders stay out.
-- =====================================================================

create or replace function public.crm_impact() returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  with sent as (
    select m.customer_id, m.executed_at, coalesce(f.name, '(sem fluxo)') as fluxo,
           case when m.channel = 'rcs' and m.result ->> 'sent_as' = 'sms_fallback' then 'sms' else m.channel end as canal
      from crm.messages m
      left join crm.flows f on f.flow_id = m.flow_id
      left join crm.flow_enrollments e on e.enrollment_id = m.enrollment_id
     where m.status = 'SENT' and m.channel <> 'team' and not coalesce(e.is_test, false)
  ),
  inicio as (select min(executed_at) as desde from sent),
  pedidos as (
    select o.customer_id, o.paid_at, coalesce(o.gross_amount, 0) as valor,
           lower(coalesce(a.utm_medium, '')) = 'crm' as utm_crm, nullif(a.utm_campaign, '') as utm_campanha,
           crm.utm_channel(a.utm_source) as utm_canal
      from crm.orders o left join crm.attributions a on a.attribution_id = o.attribution_id
     where o.status in ('PAID','PARTIALLY_REFUNDED') and o.paid_at >= (select desde from inicio)
  ),
  c as (
    select p.*,
           (select max(e.occurred_at) from crm.customer_events e
             where e.customer_id = p.customer_id
               and e.fact_type in ('CHECKOUT_ABANDONED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_EXPIRED')
               and e.occurred_at < p.paid_at and e.occurred_at > p.paid_at - interval '7 days') as sinal,
           last.executed_at as msg_em, last.fluxo, last.canal
      from pedidos p
      left join lateral (
        select s.executed_at, s.fluxo, s.canal from sent s
         where s.customer_id = p.customer_id and s.executed_at <= p.paid_at
           and s.executed_at > p.paid_at - interval '7 days'
         order by s.executed_at desc limit 1) last on true
  ),
  k as (
    select c.*,
           case when c.sinal is not null and c.msg_em > c.sinal then 'recovered'
                when c.utm_crm then 'clicked'
                when c.msg_em is not null then 'influenced' end as tipo,
           coalesce(c.fluxo, c.utm_campanha, '(sem fluxo)') as fluxo_final,
           coalesce(c.canal, c.utm_canal, 'link') as canal_final
      from c
  ),
  crm as (select * from k where tipo is not null)
  select jsonb_build_object(
    'since', (select desde from inicio),
    'store', jsonb_build_object('orders', (select count(*) from pedidos), 'revenue', (select coalesce(sum(valor), 0) from pedidos)),
    'totals', (select jsonb_object_agg(tipo, jsonb_build_object('orders', n, 'revenue', r))
                 from (select tipo, count(*) n, sum(valor) r from crm group by tipo) t),
    'by_month', (select coalesce(jsonb_agg(x order by x.month), '[]') from (
                   select to_char(paid_at at time zone crm.report_tz(), 'YYYY-MM') as month,
                          coalesce(sum(valor) filter (where tipo = 'recovered'), 0) as recovered,
                          coalesce(sum(valor) filter (where tipo = 'clicked'), 0) as clicked,
                          coalesce(sum(valor) filter (where tipo = 'influenced'), 0) as influenced,
                          count(*) as orders
                     from crm group by 1) x),
    'by_flow', (select coalesce(jsonb_agg(x order by x.revenue desc), '[]') from (
                  select fluxo_final as name, count(*) as orders, sum(valor) as revenue,
                         coalesce(sum(valor) filter (where tipo = 'recovered'), 0) as recovered,
                         coalesce(sum(valor) filter (where tipo = 'clicked'), 0) as clicked,
                         coalesce(sum(valor) filter (where tipo = 'influenced'), 0) as influenced
                    from crm group by 1) x),
    'by_channel', (select coalesce(jsonb_agg(x order by x.revenue desc), '[]') from (
                     select canal_final as channel, count(*) as orders, sum(valor) as revenue,
                            coalesce(sum(valor) filter (where tipo = 'recovered'), 0) as recovered,
                            coalesce(sum(valor) filter (where tipo = 'clicked'), 0) as clicked,
                            coalesce(sum(valor) filter (where tipo = 'influenced'), 0) as influenced
                       from crm group by 1) x)
  )
$$;
revoke all on function public.crm_impact() from public, anon, authenticated;
grant execute on function public.crm_impact() to service_role;
