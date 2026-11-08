-- =====================================================================
-- KAKAUMA CRM — Resultados: deliveries by channel
--
--   1. An RCS replaced by its "SMS alternativo" (refused RCS, or reported
--      undelivered) counted as RCS sent and delivered. It counts as SMS,
--      the channel that actually reached the customer.
--   2. delivered_at / clicked_at took the time the Pushfy report reached the
--      CRM: with the reports held back for days, old deliveries showed up as
--      deliveries of today. They take the operator's time (date_dlr), never
--      before the send nor after now. Existing messages are corrected from the
--      stored reports.
--   3. "Entregues" counted deliveries of messages sent before the period
--      (could pass "Enviadas"). Now: of the messages sent in the period, how
--      many were delivered. Status names are compared without case
--      ("Delivered", "DELIVERED"); "Read" (RCS) counts as delivered.
-- =====================================================================

-- Pushfy dates: "YYYY-MM-DD HH:MM:SS" in Brasília time, or ISO 8601 with offset
create or replace function crm.pushfy_time(p text) returns timestamptz
language plpgsql stable as $$
declare v timestamptz;
begin
  if p is null or btrim(p) = '' then return null; end if;
  if btrim(p) ~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$' then
    v := (btrim(p))::timestamp at time zone 'America/Sao_Paulo';
  else
    v := btrim(p)::timestamptz;
  end if;
  return v;
exception when others then
  return null;
end;
$$;

create or replace function public.crm_pushfy_event(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  v_kind text := case when p_payload ? 'reply' then 'reply' when p_payload ? 'status' then 'status' else 'unknown' end;
  v_ext text := nullif(p_payload ->> 'ext_id', '');
  v_status text := nullif(btrim(p_payload ->> 'status'), '');
  v_msg uuid;
  v_key text;
  v_lower text := lower(nullif(btrim(p_payload ->> 'status'), ''));
  v_at timestamptz := crm.pushfy_time(p_payload ->> 'date_dlr');
  v_opt jsonb;
begin
  if jsonb_typeof(p_payload) <> 'object' then raise exception 'payload must be an object'; end if;
  v_key := 'pushfy:' || v_kind || ':' || coalesce(p_payload ->> 'id', '') || ':' ||
           coalesce(v_status, p_payload ->> 'reply', '') || ':' ||
           coalesce(p_payload ->> 'date_dlr', p_payload ->> 'received_at', md5(p_payload::text));
  if v_ext ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select message_id into v_msg from crm.messages where message_id = v_ext::uuid;
  end if;
  insert into crm.provider_events (provider, kind, dedupe_key, ext_id, phone, payload, message_id)
  values ('pushfy', v_kind, v_key, v_ext, p_payload ->> 'phone', p_payload, v_msg)
  on conflict (dedupe_key) do nothing;
  if not found then return jsonb_build_object('ok', true, 'duplicate', true); end if;

  if v_kind = 'status' and v_msg is not null and v_status is not null then
    update crm.messages set
      provider_status = case
        -- a later "Delivered"/"Sent" never hides a click
        when provider_status = 'Clicked' and v_status in ('Sent','Delivered') then provider_status
        else v_status end,
      provider_status_at = now(),
      -- the operator's time of the event (date_dlr), not when the report reached the CRM: reports
      -- held back for days must not look like deliveries of today
      delivered_at = case when v_lower in ('delivered','clicked','read')
                          then least(coalesce(delivered_at, 'infinity'),
                                     greatest(coalesce(v_at, now()), coalesce(executed_at, '-infinity')))
                          else delivered_at end,
      clicked_at = case when v_lower = 'clicked'
                        then least(coalesce(clicked_at, 'infinity'),
                                   greatest(coalesce(v_at, now()), coalesce(executed_at, '-infinity')))
                        else clicked_at end,
      updated_at = now()
     where message_id = v_msg;
  elsif v_kind = 'reply'
        and upper(btrim(p_payload ->> 'reply')) in ('SAIR','PARAR','PARE','CANCELAR','REMOVER','STOP','DESCADASTRAR') then
    v_opt := public.crm_import_optouts(
      jsonb_build_array(jsonb_build_object('phone_number', p_payload ->> 'phone',
                                           'optout_via', 'resposta: ' || upper(btrim(p_payload ->> 'reply')))),
      'pushfy');
  end if;
  return jsonb_build_object('ok', true, 'kind', v_kind, 'message_matched', v_msg is not null,
                            'optout', coalesce(v_opt -> 'added', '0'::jsonb));
end;
$$;

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
    -- the channel that actually went out: an RCS replaced by its "SMS alternativo" counts as SMS
    select m.message_id, m.customer_id,
           case when m.channel = 'rcs' and m.result ->> 'sent_as' = 'sms_fallback' then 'sms' else m.channel end as channel,
           m.executed_at,
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
    -- delivered: of the messages sent in the period (never more than "sent")
    select 'delivered', s.campaign, s.content, s.channel, s.executed_at, s.customer_id, 0
      from sent s join crm.messages m using (message_id), par
     where s.executed_at >= par.since and s.executed_at < par.until and m.delivered_at is not null
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

-- existing messages: the operator's time from the stored reports
with ev as (
  select pe.message_id,
         min(crm.pushfy_time(pe.payload ->> 'date_dlr'))
           filter (where lower(pe.payload ->> 'status') in ('delivered','clicked','read')) as delivered,
         min(crm.pushfy_time(pe.payload ->> 'date_dlr'))
           filter (where lower(pe.payload ->> 'status') = 'clicked') as clicked
    from crm.provider_events pe
   where pe.provider = 'pushfy' and pe.kind = 'status' and pe.message_id is not null
   group by pe.message_id
)
update crm.messages m set
  delivered_at = case when ev.delivered is not null
                      then least(greatest(ev.delivered, coalesce(m.executed_at, '-infinity')), now())
                      else m.delivered_at end,
  clicked_at = case when ev.clicked is not null
                    then least(greatest(ev.clicked, coalesce(m.executed_at, '-infinity')), now())
                    else m.clicked_at end
  from ev
 where ev.message_id = m.message_id
   and (ev.delivered is not null or ev.clicked is not null);
