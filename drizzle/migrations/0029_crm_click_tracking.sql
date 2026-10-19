-- =====================================================================
-- KAKAUMA CRM — click tracking on sent messages
--
--   When a message is sent, each store link (already with its UTMs) becomes
--   a CRM link /l/<code> of its own (7 characters; the manual shortener uses
--   6, so codes never collide). A click is logged, marks the message as
--   clicked (messages.clicked_at, which "Resultados" counts) and sends the
--   visitor on to the store link. Only kakauma.com.br links are stored.
--   The results dashboard also reads utm_source values the site extended
--   ("emailXYZ…") as their channel.
-- =====================================================================

create table crm.message_links (
  code text primary key check (code ~ '^[A-Za-z0-9]{7}$'),
  message_id uuid not null references crm.messages(message_id) on delete cascade,
  url text not null
    check (url ~* '^https://([a-z0-9-]+\.)*kakauma\.com\.br(/|\?|#|$)' and length(url) <= 2000),
  clicks bigint not null default 0,
  first_click_at timestamptz,
  last_click_at timestamptz,
  created_at timestamptz not null default now(),
  unique (message_id, url)
);
create table crm.message_link_clicks (
  id bigint generated always as identity primary key,
  code text not null references crm.message_links(code) on delete cascade,
  clicked_at timestamptz not null default now()
);
create index message_link_clicks_at_idx on crm.message_link_clicks (clicked_at);
do $$
declare t text;
begin
  foreach t in array array['message_links','message_link_clicks'] loop
    execute format('alter table crm.%I enable row level security', t);
    execute format('revoke all on crm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on crm.%I to service_role', t);
  end loop;
end;
$$;

-- One code per store link of a message (same link, same code). Returns {url: code}.
create or replace function public.crm_track_links(p_message_id uuid, p_urls jsonb) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  u text;
  v_code text;
  v_out jsonb := '{}';
  v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  i int;
begin
  for u in select distinct btrim(x) from jsonb_array_elements_text(coalesce(p_urls, '[]')) x loop
    continue when u !~* '^https://([a-z0-9-]+\.)*kakauma\.com\.br(/|\?|#|$)' or length(u) > 2000;
    select code into v_code from crm.message_links where message_id = p_message_id and url = u;
    while v_code is null loop
      v_code := '';
      for i in 1..7 loop
        v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
      end loop;
      begin
        insert into crm.message_links (code, message_id, url) values (v_code, p_message_id, u);
      exception when unique_violation then
        select code into v_code from crm.message_links where message_id = p_message_id and url = u;
      end;
    end loop;
    v_out := v_out || jsonb_build_object(u, v_code);
    v_code := null;
  end loop;
  return v_out;
end;
$$;

-- Destination of a short link (manual or of a message), counting the click.
create or replace function public.crm_open_short_link(p_code text) returns text
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v_url text; v_msg uuid;
begin
  update crm.short_links set clicks = clicks + 1, last_click_at = now()
   where code = p_code returning url into v_url;
  if v_url is not null then
    insert into crm.short_link_clicks (code) values (p_code);
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

revoke all on function public.crm_track_links(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.crm_track_links(uuid, jsonb) to service_role;

-- utm_source as the site sent it can carry extra characters ("emailjLj6…"): read the channel.
create or replace function crm.utm_channel(p text) returns text
language sql immutable as $$
  select case
    when p is null or btrim(p) = '' then '?'
    when lower(p) ~ '^e-?mail' then 'email'
    when lower(p) ~ '^sms' then 'sms'
    when lower(p) ~ '^rcs' then 'rcs'
    when lower(p) ~ '^(whatsapp|wpp|wa)' then 'whatsapp'
    else lower(p) end
$$;

-- Results: UTM orders counted under the channel read from utm_source.
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
