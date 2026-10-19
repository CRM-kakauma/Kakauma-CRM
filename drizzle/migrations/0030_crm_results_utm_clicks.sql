-- =====================================================================
-- KAKAUMA CRM — results: a sale with the CRM's UTMs counts as a click
--
--   Messages sent before click tracking went straight to the store, so their
--   clicks were never seen. A purchase whose checkout carried utm_medium=crm
--   proves one; it is counted unless the CRM already tracked that customer's
--   click in the same flow.
-- =====================================================================

create or replace function public.crm_results(p_from timestamptz, p_to timestamptz, p_window_days int default 7)
returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  with par as (
    select p_from as since, p_to as until,
           make_interval(days => least(greatest(p_window_days, 1), 30)) as win
  ),
  flows as (select crm.utm_slug(name) as slug, name from crm.flows),
  tpls as (select key, crm.utm_slug(name) as slug, name from crm.message_templates),
  sent as (
    select m.message_id, m.customer_id, m.channel, m.executed_at,
           coalesce(crm.utm_slug(f.name), '(sem fluxo)') as campaign,
           coalesce(crm.utm_slug(t.name), m.template_key) as content
      from crm.messages m
      left join crm.flows f on f.flow_id = m.flow_id
      left join crm.message_templates t on t.template_id = m.template_id
      left join crm.flow_enrollments e on e.enrollment_id = m.enrollment_id
      cross join par
     where m.status = 'SENT' and m.channel <> 'team' and not coalesce(e.is_test, false)
       and m.executed_at >= par.since - par.win and m.executed_at < par.until  -- earlier ones can influence orders in the period
  ),
  facts as (
    -- messages sent in the period
    select 'sent' as kind, campaign, content, channel, executed_at as at, customer_id, 0::numeric as revenue
      from sent, par where executed_at >= par.since and executed_at < par.until
    union all
    -- clicks on CRM short links (their UTMs say flow, message and channel)
    select 'click', coalesce(crm.url_param(l.url, 'utm_campaign'), '(sem fluxo)'),
           crm.url_param(l.url, 'utm_content'), coalesce(crm.url_param(l.url, 'utm_source'), '?'),
           c.clicked_at, null, 0
      from crm.short_link_clicks c join crm.short_links l using (code), par
     where c.clicked_at >= par.since and c.clicked_at < par.until
    union all
    -- RCS clicks reported by Pushfy
    select 'click', s.campaign, s.content, s.channel, m.clicked_at, s.customer_id, 0
      from sent s join crm.messages m using (message_id), par
     where m.clicked_at >= par.since and m.clicked_at < par.until
    union all
    -- a purchase with the CRM's UTMs proves a click, also on links the CRM did not track
    -- (messages sent before click tracking); not counted again when that click was tracked
    select 'click', coalesce(nullif(a.utm_campaign, ''), '(sem campanha)'), nullif(a.utm_content, ''),
           crm.utm_channel(a.utm_source), o.paid_at, o.customer_id, 0
      from crm.orders o join crm.attributions a on a.attribution_id = o.attribution_id, par
     where o.paid_at >= par.since and o.paid_at < par.until and o.status in ('PAID','PARTIALLY_REFUNDED')
       and lower(a.utm_medium) = 'crm'
       and not exists (select 1 from sent s join crm.messages m using (message_id)
                        where s.customer_id = o.customer_id and m.clicked_at is not null
                          and s.campaign = coalesce(nullif(a.utm_campaign, ''), '(sem campanha)'))
    union all
    -- orders paid within the window after the last message the customer received
    select 'influenced', s.campaign, s.content, s.channel, o.paid_at, o.customer_id, coalesce(o.gross_amount, 0)
      from crm.orders o cross join par
      join lateral (
        select x.campaign, x.content, x.channel from sent x
         where x.customer_id = o.customer_id and x.executed_at <= o.paid_at
           and x.executed_at > o.paid_at - par.win
         order by x.executed_at desc limit 1
      ) s on true
     where o.paid_at >= par.since and o.paid_at < par.until and o.status in ('PAID','PARTIALLY_REFUNDED')
    union all
    -- orders whose checkout carried the CRM's UTMs
    select 'utm', coalesce(nullif(a.utm_campaign, ''), '(sem campanha)'), nullif(a.utm_content, ''),
           crm.utm_channel(a.utm_source), o.paid_at, o.customer_id, coalesce(o.gross_amount, 0)
      from crm.orders o join crm.attributions a on a.attribution_id = o.attribution_id, par
     where o.paid_at >= par.since and o.paid_at < par.until and o.status in ('PAID','PARTIALLY_REFUNDED')
       and lower(a.utm_medium) = 'crm'
  ),
  agg as (
    -- g: 7 = everything, 3 = per flow, 6 = per channel, 0 = per flow + message + channel
    select grouping(campaign, content, channel) as g, campaign, content, channel,
           count(*) filter (where kind = 'sent') as sent,
           count(distinct customer_id) filter (where kind = 'sent') as reached,
           count(*) filter (where kind = 'click') as clicks,
           count(*) filter (where kind = 'influenced') as infl_orders,
           coalesce(sum(revenue) filter (where kind = 'influenced'), 0) as infl_revenue,
           count(*) filter (where kind = 'utm') as utm_orders,
           coalesce(sum(revenue) filter (where kind = 'utm'), 0) as utm_revenue
      from facts group by grouping sets ((campaign), (channel), (campaign, content, channel), ())
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
                select to_char(date_trunc('day', at at time zone crm.report_tz()), 'YYYY-MM-DD') as day,
                       count(*) filter (where kind = 'sent' and channel = 'email') as sent_email,
                       count(*) filter (where kind = 'sent' and channel = 'sms') as sent_sms,
                       count(*) filter (where kind = 'sent' and channel = 'rcs') as sent_rcs,
                       count(*) filter (where kind = 'click') as clicks,
                       coalesce(sum(revenue) filter (where kind = 'influenced'), 0) as infl_revenue,
                       coalesce(sum(revenue) filter (where kind = 'utm'), 0) as utm_revenue
                  from facts group by 1) d)
  )
$$;
