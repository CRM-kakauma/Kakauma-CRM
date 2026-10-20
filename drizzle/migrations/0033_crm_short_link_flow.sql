-- =====================================================================
-- KAKAUMA CRM — manual short links count for the flow that sends them
--
--   A link made with "Encurtar" while its message was in no flow carries
--   utm_campaign=nome_do_fluxo. The flow is found from where the link is
--   written: the message (template) whose content has /l/<code>, and the
--   flow that sends that message. "Resultados" counts the click there, and
--   the redirect sends the visitor with the right utm_campaign / utm_content
--   (so Analytics and the B4you sale get them too).
-- =====================================================================

-- Flow, message and channel of a manual short link, from the message that contains it.
create or replace function crm.short_link_context(p_code text)
returns table (campaign text, content text, channel text)
language sql stable set search_path = crm, public, extensions as $$
  select crm.utm_slug(f.name), crm.utm_slug(t.name), t.channel
    from crm.message_templates t
    join crm.flows f on f.status <> 'ARCHIVED'
     and exists (select 1 from jsonb_array_elements(coalesce(f.graph -> 'nodes', '[]')) n
                  where n #>> '{config,template_key}' = t.key)
   where not t.archived and strpos(t.content::text, '/l/' || p_code) > 0
     and t.content::text !~ ('/l/' || p_code || '[A-Za-z0-9]')
   order by (f.status = 'ACTIVE') desc, f.updated_at desc
   limit 1
$$;

-- The URL with utm_campaign / utm_content / utm_source set (added when missing).
create or replace function crm.url_with_utm(p_url text, p_campaign text, p_content text, p_source text)
returns text language plpgsql immutable as $$
declare
  v text := p_url;
  k text;
  val text;
  frag text := coalesce(substring(p_url from '#.*$'), '');
begin
  v := regexp_replace(v, '#.*$', '');
  foreach k in array array['utm_campaign','utm_content','utm_source'] loop
    val := case k when 'utm_campaign' then p_campaign when 'utm_content' then p_content else p_source end;
    continue when val is null or val = '';
    if v ~ ('[?&]' || k || '=') then
      v := regexp_replace(v, '([?&])' || k || '=[^&]*', '\1' || k || '=' || val);
    else
      v := v || case when v ~ '\?' then '&' else '?' end || k || '=' || val;
    end if;
  end loop;
  return v || frag;
end;
$$;

create or replace function public.crm_open_short_link(p_code text) returns text
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v_url text; v_msg uuid; x record;
begin
  update crm.short_links set clicks = clicks + 1, last_click_at = now()
   where code = p_code returning url into v_url;
  if v_url is not null then
    insert into crm.short_link_clicks (code) values (p_code);
    -- a link shortened outside any flow takes the flow/message that sends it
    if coalesce(crm.url_param(v_url, 'utm_campaign'), 'nome_do_fluxo') = 'nome_do_fluxo' then
      select * into x from crm.short_link_context(p_code);
      if x.campaign is not null then
        v_url := crm.url_with_utm(v_url, x.campaign, x.content, x.channel);
      end if;
    end if;
    return v_url;
  end if;
  update crm.message_links set clicks = clicks + 1, last_click_at = now(),
         first_click_at = coalesce(first_click_at, now())
   where code = p_code returning url, message_id into v_url, v_msg;
  if v_url is not null then
    insert into crm.message_link_clicks (code) values (p_code);
    update crm.messages set clicked_at = coalesce(clicked_at, now()), updated_at = now()
     where message_id = v_msg;
  end if;
  return v_url;
end;
$$;

-- Results: manual short link clicks under the flow that sends the link.
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
    select 'click', coalesce(x.campaign, crm.url_param(l.url, 'utm_campaign'), '(sem fluxo)'),
           coalesce(x.content, crm.url_param(l.url, 'utm_content')),
           coalesce(x.channel, crm.utm_channel(crm.url_param(l.url, 'utm_source'))),
           c.clicked_at, null, 0
      from crm.short_link_clicks c join crm.short_links l using (code)
      left join lateral crm.short_link_context(l.code) x on true, par
     where c.clicked_at >= par.since and c.clicked_at < par.until
    union all
    -- RCS clicks reported by Pushfy
    select 'click', s.campaign, s.content, s.channel, m.clicked_at, s.customer_id, 0
      from sent s join crm.messages m using (message_id), par
     where m.clicked_at >= par.since and m.clicked_at < par.until
    union all
    -- e-mails opened (Resend) and messages delivered (Resend / Pushfy), once per message
    select 'open', s.campaign, s.content, s.channel, m.opened_at, s.customer_id, 0
      from sent s join crm.messages m using (message_id), par
     where m.opened_at >= par.since and m.opened_at < par.until
    union all
    select 'delivered', s.campaign, s.content, s.channel, m.delivered_at, s.customer_id, 0
      from sent s join crm.messages m using (message_id), par
     where m.delivered_at >= par.since and m.delivered_at < par.until
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
           count(*) filter (where kind = 'open') as opens,
           count(*) filter (where kind = 'delivered') as delivered,
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
                       count(*) filter (where kind = 'open') as opens,
                       coalesce(sum(revenue) filter (where kind = 'influenced'), 0) as infl_revenue,
                       coalesce(sum(revenue) filter (where kind = 'utm'), 0) as utm_revenue
                  from facts group by 1) d)
  )
$$;
