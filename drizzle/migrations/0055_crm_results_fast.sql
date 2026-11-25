-- =====================================================================
-- Resultados: the same numbers, much faster ("canceling statement due to
-- statement timeout" with many messages and orders).
--   * the last message before each order: one hash join instead of a scan
--     of every sent message per order
--   * orders, short-link context, clicked campaigns: computed once
--   * slugs of flows/templates computed per flow, not per message
--   * indexes for the period filters (sent messages, paid orders)
-- =====================================================================

create index if not exists messages_sent_at_idx on crm.messages (executed_at) where status = 'SENT';
create index if not exists orders_paid_at_idx on crm.orders (paid_at) where paid_at is not null;

create or replace function public.crm_results(p_from timestamptz, p_to timestamptz, p_window_days int default 7)
returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  with par as (
    select p_from as since, p_to as until, crm.report_tz() as tz,
           make_interval(days => least(greatest(p_window_days, 1), 30)) as win
  ),
  flows as materialized (select flow_id, crm.utm_slug(name) as slug, name from crm.flows),
  tpls as materialized (select template_id, key, crm.utm_slug(name) as slug, name from crm.message_templates),
  sent as materialized (
    -- the channel that actually went out: an RCS replaced by its "SMS alternativo" counts as SMS
    select m.message_id, m.customer_id,
           case when m.channel = 'rcs' and m.result ->> 'sent_as' = 'sms_fallback' then 'sms' else m.channel end as channel,
           m.executed_at, m.clicked_at, m.opened_at, m.delivered_at,
           -- same as the previous version: crm.utm_slug(null) = '' (no flow / no template → blank)
           coalesce(f.slug, '') as campaign,
           coalesce(t.slug, '') as content
      from crm.messages m
      left join flows f on f.flow_id = m.flow_id
      left join tpls t on t.template_id = m.template_id
      left join crm.flow_enrollments e on e.enrollment_id = m.enrollment_id
      cross join par
     where m.status = 'SENT' and m.channel <> 'team' and e.is_test is not true
       and m.executed_at >= par.since - par.win and m.executed_at < par.until  -- earlier ones can influence orders in the period
  ),
  -- paid orders of the period (scanned once)
  paid as materialized (
    select o.order_id, o.customer_id, o.paid_at, coalesce(o.gross_amount, 0) as amount,
           lower(a.utm_medium) = 'crm' as crm_utm,
           coalesce(nullif(a.utm_campaign, ''), '(sem campanha)') as utm_campaign,
           nullif(a.utm_content, '') as utm_content, crm.utm_channel(a.utm_source) as utm_channel
      from crm.orders o left join crm.attributions a on a.attribution_id = o.attribution_id, par
     where o.paid_at >= par.since and o.paid_at < par.until and o.status in ('PAID','PARTIALLY_REFUNDED')
  ),
  -- the last message each buyer received in the window before paying (a hash join, not a scan per order)
  last_msg as materialized (
    select distinct on (p.order_id) p.order_id, p.customer_id, p.paid_at, p.amount, s.campaign, s.content, s.channel
      from paid p join sent s on s.customer_id = p.customer_id, par
     where s.executed_at <= p.paid_at and s.executed_at > p.paid_at - par.win
     order by p.order_id, s.executed_at desc
  ),
  -- short links clicked in the period: the flow / message of each link is looked up once per link
  link_ctx as materialized (
    select l.code, coalesce(x.campaign, crm.url_param(l.url, 'utm_campaign'), '(sem fluxo)') as campaign,
           coalesce(x.content, crm.url_param(l.url, 'utm_content')) as content,
           coalesce(x.channel, crm.utm_channel(crm.url_param(l.url, 'utm_source'))) as channel
      from (select distinct c.code from crm.short_link_clicks c, par
             where c.clicked_at >= par.since and c.clicked_at < par.until) d
      join crm.short_links l using (code)
      left join lateral crm.short_link_context(l.code) x on true
  ),
  clicked as materialized (select distinct customer_id, campaign from sent where clicked_at is not null),
  -- message events, summed per flow / message / channel / day (a few thousand rows, not one per message)
  msg_facts as materialized (
    select kind, campaign, content, channel, (at at time zone par.tz)::date as day, count(*) as n
      from par, (
        -- messages sent in the period
        select 'sent' as kind, campaign, content, channel, executed_at as at
          from sent, par where executed_at >= par.since and executed_at < par.until
        union all
        -- clicks on CRM short links (their UTMs say flow, message and channel)
        select 'click', x.campaign, x.content, x.channel, c.clicked_at
          from crm.short_link_clicks c join link_ctx x using (code), par
         where c.clicked_at >= par.since and c.clicked_at < par.until
        union all
        -- RCS clicks reported by Pushfy
        select 'click', s.campaign, s.content, s.channel, s.clicked_at
          from sent s, par where s.clicked_at >= par.since and s.clicked_at < par.until
        union all
        -- e-mails opened (Resend), once per message
        select 'open', s.campaign, s.content, s.channel, s.opened_at
          from sent s, par where s.opened_at >= par.since and s.opened_at < par.until
        union all
        -- delivered: of the messages sent in the period (never more than "sent")
        select 'delivered', s.campaign, s.content, s.channel, s.executed_at
          from sent s, par
         where s.executed_at >= par.since and s.executed_at < par.until and s.delivered_at is not null
      ) x
     group by 1, 2, 3, 4, 5
  ),
  facts as materialized (
    select kind, campaign, content, channel, day, n, 0::numeric as revenue from msg_facts
    union all
    -- a purchase with the CRM's UTMs proves a click, also on links the CRM did not track
    -- (messages sent before click tracking); not counted again when that click was tracked
    select 'click', p.utm_campaign, p.utm_content, p.utm_channel, (p.paid_at at time zone par.tz)::date, 1, 0
      from paid p, par
     where p.crm_utm
       and not exists (select 1 from clicked k where k.customer_id = p.customer_id and k.campaign = p.utm_campaign)
    union all
    -- orders paid within the window after the last message the customer received
    select 'influenced', l.campaign, l.content, l.channel, (l.paid_at at time zone par.tz)::date, 1, l.amount
      from last_msg l, par
    union all
    -- orders whose checkout carried the CRM's UTMs
    select 'utm', p.utm_campaign, p.utm_content, p.utm_channel, (p.paid_at at time zone par.tz)::date, 1, p.amount
      from paid p, par where p.crm_utm
  ),
  -- distinct customers reached, per grouping
  reach as materialized (
    select grouping(campaign, content, channel) as g, campaign, content, channel, count(distinct customer_id) as reached
      from sent, par where executed_at >= par.since and executed_at < par.until
     group by grouping sets ((campaign), (channel), (campaign, content, channel), ())
  ),
  agg0 as (
    -- g: 7 = everything, 3 = per flow, 6 = per channel, 0 = per flow + message + channel
    select grouping(campaign, content, channel) as g, campaign, content, channel,
           coalesce(sum(n) filter (where kind = 'sent'), 0)::bigint as sent,
           coalesce(sum(n) filter (where kind = 'click'), 0)::bigint as clicks,
           coalesce(sum(n) filter (where kind = 'open'), 0)::bigint as opens,
           coalesce(sum(n) filter (where kind = 'delivered'), 0)::bigint as delivered,
           coalesce(sum(n) filter (where kind = 'influenced'), 0)::bigint as infl_orders,
           coalesce(sum(revenue) filter (where kind = 'influenced'), 0) as infl_revenue,
           coalesce(sum(n) filter (where kind = 'utm'), 0)::bigint as utm_orders,
           coalesce(sum(revenue) filter (where kind = 'utm'), 0) as utm_revenue
      from facts group by grouping sets ((campaign), (channel), (campaign, content, channel), ())
  ),
  agg as materialized (
    select a.g, a.campaign, a.content, a.channel, a.sent, coalesce(r.reached, 0) as reached, a.clicks, a.opens,
           a.delivered, a.infl_orders, a.infl_revenue, a.utm_orders, a.utm_revenue
      from agg0 a left join reach r
        on r.g = a.g and r.campaign is not distinct from a.campaign
       and r.content is not distinct from a.content and r.channel is not distinct from a.channel
  )
  select jsonb_build_object(
    'since', (select since from par), 'until', (select until from par),
    'window_days', least(greatest(p_window_days, 1), 30),
    'totals', (select to_jsonb(a) - 'g' - 'campaign' - 'content' - 'channel' from agg a where g = 7),
    'by_flow', (select coalesce(jsonb_agg(to_jsonb(a) - 'g' - 'content' - 'channel'
                   || jsonb_build_object('name', coalesce((select name from flows where slug = a.campaign limit 1), a.campaign))
                   order by a.infl_revenue + a.utm_revenue desc, a.sent desc), '[]')
                  from agg a where g = 3),
    'by_channel', (select coalesce(jsonb_agg(to_jsonb(a) - 'g' - 'campaign' - 'content' order by a.sent desc), '[]')
                     from agg a where g = 6),
    'by_message', (select coalesce(jsonb_agg(to_jsonb(a) - 'g'
                     || jsonb_build_object(
                          'flow_name', coalesce((select name from flows where slug = a.campaign limit 1), a.campaign),
                          'message_name', coalesce((select name from tpls where slug = a.content or key = a.content limit 1), a.content))
                     order by a.infl_revenue + a.utm_revenue desc, a.sent desc), '[]')
                     from agg a where g = 0),
    'daily', (select coalesce(jsonb_agg(d order by d.day), '[]') from (
                select to_char(day, 'YYYY-MM-DD') as day,
                       coalesce(sum(n) filter (where kind = 'sent' and channel = 'email'), 0)::bigint as sent_email,
                       coalesce(sum(n) filter (where kind = 'sent' and channel = 'sms'), 0)::bigint as sent_sms,
                       coalesce(sum(n) filter (where kind = 'sent' and channel = 'rcs'), 0)::bigint as sent_rcs,
                       coalesce(sum(n) filter (where kind = 'click'), 0)::bigint as clicks,
                       coalesce(sum(n) filter (where kind = 'open'), 0)::bigint as opens,
                       coalesce(sum(revenue) filter (where kind = 'influenced'), 0) as infl_revenue,
                       coalesce(sum(revenue) filter (where kind = 'utm'), 0) as utm_revenue
                  from facts group by day) d)
  )
$$;

revoke all on function public.crm_results(timestamptz, timestamptz, int) from public, anon, authenticated;
grant execute on function public.crm_results(timestamptz, timestamptz, int) to service_role;
