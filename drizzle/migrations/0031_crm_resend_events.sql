-- =====================================================================
-- KAKAUMA CRM — Resend webhooks: delivered, opened, clicked, bounced, spam
--
--   POST /api/webhooks/resend (signed by Resend/Svix) → crm_resend_event.
--   The message is found by the message_id tag sent with the e-mail, or by
--   the Resend e-mail id saved when it was sent. Opens and clicks are kept
--   once per message (first time); a spam complaint opts the customer out of
--   e-mail. "Resultados" gains opens and deliveries.
-- =====================================================================

alter table crm.messages add column if not exists opened_at timestamptz;
create index if not exists messages_resend_id_idx on crm.messages ((result #>> '{response,id}'))
  where channel = 'email';

create or replace function public.crm_resend_event(p_event_id text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  v_type text := p_payload ->> 'type';
  v_email_id text := nullif(p_payload #>> '{data,email_id}', '');
  v_tags jsonb := p_payload #> '{data,tags}';
  v_tag text;
  v_at timestamptz;
  v_key text;
  v_msg crm.messages;
  v_status text;
begin
  if jsonb_typeof(p_payload) <> 'object' or v_type is null then
    raise exception 'payload must be a Resend event';
  end if;
  -- tags come as {"message_id": "..."} or [{"name": "message_id", "value": "..."}]
  v_tag := case jsonb_typeof(v_tags)
    when 'object' then v_tags ->> 'message_id'
    when 'array' then (select t ->> 'value' from jsonb_array_elements(v_tags) t
                        where t ->> 'name' = 'message_id' limit 1)
    end;
  begin
    v_at := coalesce(nullif(p_payload ->> 'created_at', '')::timestamptz, now());
  exception when others then
    v_at := now();
  end;
  v_key := 'resend:' || coalesce(nullif(p_event_id, ''), md5(p_payload::text));
  insert into crm.provider_events (provider, kind, dedupe_key, ext_id, payload)
  values ('resend', 'status', v_key, coalesce(v_email_id, v_tag), p_payload)
  on conflict (dedupe_key) do nothing;
  if not found then return jsonb_build_object('ok', true, 'duplicate', true); end if;

  if v_tag ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_msg from crm.messages where message_id = v_tag::uuid and channel = 'email';
  end if;
  if v_msg.message_id is null and v_email_id is not null then
    select * into v_msg from crm.messages
     where channel = 'email' and result #>> '{response,id}' = v_email_id limit 1;
  end if;
  if v_msg.message_id is null then
    return jsonb_build_object('ok', true, 'type', v_type, 'message_matched', false);
  end if;
  update crm.provider_events set message_id = v_msg.message_id where dedupe_key = v_key;

  v_status := case v_type
    when 'email.delivered' then 'Delivered'
    when 'email.opened' then 'Opened'
    when 'email.clicked' then 'Clicked'
    when 'email.bounced' then 'Bounced'
    when 'email.complained' then 'Complained'
    when 'email.delivery_delayed' then 'Delayed'
    when 'email.failed' then 'Undelivered'
    end;
  if v_status is null then
    return jsonb_build_object('ok', true, 'type', v_type, 'message_matched', true);
  end if;

  update crm.messages set
    -- a later "delivered"/"opened" never hides a click (nor "delivered" an open)
    provider_status = case
      when v_status in ('Delivered','Opened','Delayed') and provider_status = 'Clicked' then provider_status
      when v_status in ('Delivered','Delayed') and provider_status = 'Opened' then provider_status
      else v_status end,
    provider_status_at = now(),
    delivered_at = case when v_status in ('Delivered','Opened','Clicked') then coalesce(delivered_at, v_at) else delivered_at end,
    opened_at = case when v_status in ('Opened','Clicked') then coalesce(opened_at, v_at) else opened_at end,
    clicked_at = case when v_status = 'Clicked' then coalesce(clicked_at, v_at) else clicked_at end,
    updated_at = now()
   where message_id = v_msg.message_id;

  if v_status = 'Complained' then
    insert into crm.channel_optouts (customer_id, channel, source)
    values (v_msg.customer_id, 'email', 'resend: marcado como spam')
    on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true, 'type', v_type, 'message_matched', true, 'status', v_status);
end;
$$;

revoke all on function public.crm_resend_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.crm_resend_event(text, jsonb) to service_role;

-- Results with opens and deliveries.
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
