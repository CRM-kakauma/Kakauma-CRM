-- =====================================================================
-- KAKAUMA CRM — Pushfy webhooks: delivery status (DLR) and replies (MO)
--
--   POST /api/webhooks/pushfy?token=…  →  public.crm_pushfy_event(payload)
--   * status: matched by ext_id (= crm.messages.message_id) → provider_status,
--     delivered_at / clicked_at. The message stays SENT; the operator's status
--     ("Delivered", "Undelivered", "Clicked"…) is shown next to it.
--   * reply: SAIR / PARAR / CANCELAR… becomes an SMS + RCS opt-out (Pushfy already
--     blocks them; this keeps the CRM in sync right away instead of next day).
--   Every event is kept raw (crm.provider_events) and deduplicated: Pushfy
--   retries on failure, so the same event may come more than once.
-- =====================================================================

alter table crm.messages
  add column provider_status text,
  add column provider_status_at timestamptz,
  add column delivered_at timestamptz,
  add column clicked_at timestamptz;

create table crm.provider_events (
  id bigint generated always as identity primary key,
  provider text not null,
  kind text not null check (kind in ('status','reply','unknown')),
  dedupe_key text not null unique,
  ext_id text,
  phone text,
  payload jsonb not null,
  message_id uuid,
  received_at timestamptz not null default now()
);
create index provider_events_message_idx on crm.provider_events (message_id);
alter table crm.provider_events enable row level security;
revoke all on crm.provider_events from public, anon, authenticated;
grant select, insert, update, delete on crm.provider_events to service_role;

create function public.crm_pushfy_event(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  v_kind text := case when p_payload ? 'reply' then 'reply' when p_payload ? 'status' then 'status' else 'unknown' end;
  v_ext text := nullif(p_payload ->> 'ext_id', '');
  v_status text := nullif(btrim(p_payload ->> 'status'), '');
  v_msg uuid;
  v_key text;
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
      delivered_at = case when v_status in ('Delivered','Clicked') then coalesce(delivered_at, now()) else delivered_at end,
      clicked_at = case when v_status = 'Clicked' then coalesce(clicked_at, now()) else clicked_at end,
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

-- Messages list and test results show what the operator reported.
drop function public.crm_list_messages(text, text, int);
create function public.crm_list_messages(p_flow_key text default null, p_status text default null, p_limit int default 100)
returns table (message_id uuid, customer_id uuid, full_name text, channel text, template text, flow text, status text,
               skip_reason text, recipient text, rendered jsonb, error text, at timestamptz,
               provider_status text, sent_as text)
language sql stable security definer set search_path = crm, public, extensions as $$
  select m.message_id, m.customer_id, c.full_name, m.channel, m.template_key, f.name, m.status, m.skip_reason,
         m.recipient, m.rendered, m.error, coalesce(m.executed_at, m.scheduled_for),
         m.provider_status, m.result ->> 'sent_as'
    from crm.messages m join crm.customers c using (customer_id) left join crm.flows f using (flow_id)
   where (p_flow_key is null or f.key = p_flow_key) and (p_status is null or m.status = p_status)
   order by m.created_at desc limit least(greatest(p_limit, 1), 500)
$$;

create or replace function public.crm_flow_stats(p_key text) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  with f as (select * from crm.flows where key = p_key),
  en as (select e.* from crm.flow_enrollments e join f using (flow_id) where not e.is_test)
  select jsonb_build_object(
    'enrollments', (select jsonb_build_object(
        'total', count(*), 'live', count(*) filter (where status in ('ACTIVE','WAITING')),
        'completed', count(*) filter (where status = 'COMPLETED'), 'goal', count(*) filter (where status = 'GOAL'),
        'exited', count(*) filter (where status = 'EXITED'), 'failed', count(*) filter (where status = 'FAILED'),
        'goal_rate', crm.pct(count(*) filter (where status = 'GOAL'), count(*) filter (where status not in ('ACTIVE','WAITING'))))
      from en),
    'nodes', (select coalesce(jsonb_object_agg(node_id, x), '{}') from (
        select s.node_id, jsonb_build_object('passed', sum(s.n), 'outcomes', jsonb_object_agg(s.outcome, s.n)) as x
          from (select node_id, coalesce(outcome, '?') as outcome, count(distinct enrollment_id) as n
                  from crm.flow_steps where enrollment_id in (select enrollment_id from en)
                 group by 1, 2) s
         group by s.node_id) t),
    'here_now', (select coalesce(jsonb_object_agg(k, n), '{}') from (
        select coalesce((select st.node_id from crm.flow_steps st where st.enrollment_id = e.enrollment_id
                          order by st.id desc limit 1), e.current_node, '?') as k,
               count(*) as n
          from en e where e.status in ('ACTIVE','WAITING') group by 1) t),
    'split_goals', (select coalesce(jsonb_object_agg(node_id || ':' || outcome, jsonb_build_object(
          'finished', finished, 'goal', goal, 'rate', crm.pct(goal, finished))), '{}')
        from (select st.node_id, st.outcome,
                     count(*) filter (where e.status not in ('ACTIVE','WAITING')) as finished,
                     count(*) filter (where e.status = 'GOAL') as goal
                from crm.flow_steps st join en e using (enrollment_id)
               where st.node_type = 'split' group by 1, 2) t),
    'messages', (select jsonb_build_object(
        'queued', count(*) filter (where m.status in ('QUEUED','PROCESSING')),
        'sent', count(*) filter (where m.status = 'SENT'), 'dry_run', count(*) filter (where m.status = 'DRY_RUN'),
        'skipped', count(*) filter (where m.status = 'SKIPPED'), 'failed', count(*) filter (where m.status = 'FAILED'))
      from crm.messages m join en using (enrollment_id)),
    'recent', (select coalesce(jsonb_agg(r order by r.entered_at desc), '[]') from (
        select e.enrollment_id, e.customer_id, c.full_name, e.status, e.current_node, e.exit_reason, e.entered_at,
               e.finished_at, e.next_run_at, e.version
          from en e join crm.customers c using (customer_id) order by e.entered_at desc limit 50) r),
    -- the last test launches, with what happened to each message
    'tests', (select coalesce(jsonb_agg(r order by r.entered_at desc), '[]') from (
        select e.enrollment_id, e.customer_id, c.full_name, e.status, e.exit_reason, e.entered_at, e.finished_at,
               e.skip_waits,
               (select coalesce(jsonb_agg(jsonb_build_object(
                         'channel', m.channel, 'template', m.template_key, 'status', m.status,
                         'skip_reason', m.skip_reason, 'recipient', m.recipient, 'error', m.error,
                         'provider_status', m.provider_status, 'sent_as', m.result ->> 'sent_as',
                         'at', coalesce(m.executed_at, m.scheduled_for))
                         -- in the order of the path (one tick creates them all at the same instant)
                         order by (select min(st.id) from crm.flow_steps st
                                    where st.enrollment_id = m.enrollment_id and st.node_id = m.node_id)), '[]')
                  from crm.messages m where m.enrollment_id = e.enrollment_id) as messages
          from crm.flow_enrollments e join f using (flow_id) join crm.customers c using (customer_id)
         where e.is_test order by e.entered_at desc limit 30) r))
$$;

do $$
declare fn text;
begin
  foreach fn in array array['crm_pushfy_event(jsonb)', 'crm_list_messages(text,text,int)', 'crm_flow_stats(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;
