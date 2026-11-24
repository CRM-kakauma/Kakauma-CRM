-- =====================================================================
-- KAKAUMA CRM — Disparos (scheduled flows for a segment)
--
--   Fluxos are split in two tabs:
--     Jornadas  flows started by a fact (trigger), as before;
--     Disparos  flows started by the clock, for everyone in a segment.
--   A disparo is a flow with trigger_fact = 'BROADCAST' (no fact ever has that
--   type, so no event starts it) and crm.flows.broadcast =
--     { segment: <segment key>,
--       schedule: { mode: 'once', at: 'YYYY-MM-DDTHH:MI' }            -- one date and time
--               | { mode: 'daily', time: 'HH:MI', days: [0..6]? },     -- every day (or those weekdays, 0 = domingo)
--       audience: 'once_ever'        -- each customer receives it once in life
--               | 'once_per_journey' -- once per journey: again only after starting a new journey (flow) }
--   Times are in Brasília (crm.report_tz()). At each run every member of the
--   segment enters the flow (a real enrollment: waits, entry rule, send window,
--   daily limit and LIVE switches apply), except who already received it under
--   the audience rule or is still inside this disparo.
--   A run that was due more than 3 hours ago (paused, platform down) is not
--   fired late: it is recorded as missed and the next one is scheduled.
-- =====================================================================

alter table crm.flows add column if not exists broadcast jsonb;
alter table crm.flows add column if not exists next_run_at timestamptz;
alter table crm.flows add column if not exists last_run_at timestamptz;

create table if not exists crm.broadcast_runs (
  run_id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references crm.flows(flow_id) on delete cascade,
  scheduled_for timestamptz not null,
  ran_at timestamptz not null default now(),
  status text not null check (status in ('DONE','MISSED','EMPTY')),
  audience int not null default 0,
  enrolled int not null default 0,
  already_received int not null default 0,
  still_in_flow int not null default 0,
  manual boolean not null default false
);
create index if not exists broadcast_runs_flow_idx on crm.broadcast_runs (flow_id, ran_at desc);

create table if not exists crm.broadcast_deliveries (
  flow_id uuid not null references crm.flows(flow_id) on delete cascade,
  customer_id uuid not null references crm.customers(customer_id) on delete cascade,
  dedupe_key text not null,              -- 'ever', or the journey (enrollment) it was received in
  run_id uuid references crm.broadcast_runs(run_id) on delete set null,
  enrollment_id uuid references crm.flow_enrollments(enrollment_id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (flow_id, customer_id, dedupe_key)
);

do $$
declare t text;
begin
  foreach t in array array['broadcast_runs','broadcast_deliveries'] loop
    execute format('alter table crm.%I enable row level security', t);
    execute format('revoke all on crm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on crm.%I to service_role', t);
  end loop;
end;
$$;

-- Next run strictly after p_after (null = no more runs).
create or replace function crm.broadcast_next_run(p_schedule jsonb, p_after timestamptz) returns timestamptz
language plpgsql stable as $$
declare
  tz text := crm.report_tz();
  v_time time;
  v_days int[];
  v_day date;
  v_at timestamptz;
  i int;
begin
  if p_schedule is null then return null; end if;
  if p_schedule ->> 'mode' = 'once' then
    v_at := (p_schedule ->> 'at')::timestamp at time zone tz;
    return case when v_at > p_after then v_at end;
  elsif p_schedule ->> 'mode' = 'daily' then
    v_time := coalesce(nullif(p_schedule ->> 'time', ''), '10:00')::time;
    v_days := coalesce((select array_agg(x::int) from jsonb_array_elements_text(p_schedule -> 'days') x), '{}');
    v_day := (p_after at time zone tz)::date;
    for i in 0 .. 14 loop
      v_at := (v_day + i + v_time) at time zone tz;
      if v_at > p_after and (cardinality(v_days) = 0 or extract(dow from v_day + i)::int = any (v_days)) then
        return v_at;
      end if;
    end loop;
  end if;
  return null;
end;
$$;

-- the journey a customer is in (or was in last): a disparo "once per journey" comes back with a new one
create or replace function crm.current_journey(p_customer uuid) returns text
language sql stable as $$
  select coalesce((
    select en.enrollment_id::text from crm.flow_enrollments en join crm.flows f using (flow_id)
     where en.customer_id = p_customer and not en.is_test and f.trigger_fact <> 'BROADCAST'
     order by en.entered_at desc limit 1), 'sem_jornada')
$$;

-- Saves segment, schedule and audience of a disparo; schedules the next run.
create or replace function public.crm_set_broadcast(p_key text, p_segment text, p_schedule jsonb, p_audience text,
                                                    p_actor text default null)
returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  f crm.flows;
  v_next timestamptz;
begin
  perform crm.set_actor(p_actor);
  select * into f from crm.flows where key = p_key for update;
  if not found then raise exception 'Disparo não encontrado'; end if;
  if f.trigger_fact <> 'BROADCAST' then raise exception 'Este fluxo é uma jornada, não um disparo'; end if;
  if not exists (select 1 from crm.segments where key = p_segment) then
    raise exception 'Escolha o segmento que vai receber';
  end if;
  if p_audience not in ('once_ever','once_per_journey') then raise exception 'Regra de envio inválida'; end if;
  if p_schedule ->> 'mode' = 'once' then
    if nullif(p_schedule ->> 'at', '') is null then raise exception 'Escolha a data e a hora do disparo'; end if;
    perform (p_schedule ->> 'at')::timestamp;
  elsif p_schedule ->> 'mode' = 'daily' then
    perform coalesce(nullif(p_schedule ->> 'time', ''), '10:00')::time;
  else
    raise exception 'Escolha quando o disparo acontece';
  end if;
  v_next := crm.broadcast_next_run(p_schedule, now());
  update crm.flows set
    broadcast = jsonb_build_object('segment', p_segment, 'schedule', p_schedule, 'audience', p_audience),
    next_run_at = v_next, updated_at = now()
   where flow_id = f.flow_id;
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('flows', p_key, 'broadcast', f.broadcast::text,
          jsonb_build_object('segment', p_segment, 'schedule', p_schedule, 'audience', p_audience)::text,
          crm.current_actor());
  return jsonb_build_object('next_run_at', v_next);
end;
$$;

-- One run of a disparo: everyone in the segment enters, except who already received it.
create or replace function crm.run_broadcast(p_flow uuid, p_manual boolean default false) returns jsonb
language plpgsql as $$
declare
  f crm.flows;
  v_trigger text;
  v_run uuid;
  v_aud text;
  m record;
  v_key text;
  v_en uuid;
  n_aud int := 0; n_in int := 0; n_already int := 0; n_busy int := 0;
begin
  select * into f from crm.flows where flow_id = p_flow;
  v_aud := coalesce(f.broadcast ->> 'audience', 'once_ever');
  v_trigger := (select n ->> 'id' from crm.flow_versions v, jsonb_array_elements(v.graph -> 'nodes') n
                 where v.flow_id = f.flow_id and v.version = f.version and n ->> 'type' = 'trigger' limit 1);
  insert into crm.broadcast_runs (flow_id, scheduled_for, status, manual)
  values (f.flow_id, coalesce(f.next_run_at, now()), 'DONE', p_manual) returning run_id into v_run;

  for m in select sm.customer_id from crm.segment_members sm join crm.segments s using (segment_id)
            join crm.customers c on c.customer_id = sm.customer_id
           where s.key = f.broadcast ->> 'segment' and c.anonymized_at is null loop
    n_aud := n_aud + 1;
    v_key := case when v_aud = 'once_per_journey' then crm.current_journey(m.customer_id) else 'ever' end;
    if exists (select 1 from crm.broadcast_deliveries d
                where d.flow_id = f.flow_id and d.customer_id = m.customer_id and d.dedupe_key = v_key) then
      n_already := n_already + 1;
      continue;
    end if;
    if exists (select 1 from crm.flow_enrollments en where en.flow_id = f.flow_id and en.customer_id = m.customer_id
                and en.status in ('ACTIVE','WAITING')) then
      n_busy := n_busy + 1;
      continue;
    end if;
    insert into crm.flow_enrollments (flow_id, version, customer_id, current_node, next_run_at)
    values (f.flow_id, f.version, m.customer_id, v_trigger, now())
    returning enrollment_id into v_en;
    insert into crm.broadcast_deliveries (flow_id, customer_id, dedupe_key, run_id, enrollment_id)
    values (f.flow_id, m.customer_id, v_key, v_run, v_en);
    n_in := n_in + 1;
  end loop;

  update crm.broadcast_runs set audience = n_aud, enrolled = n_in, already_received = n_already,
         still_in_flow = n_busy, status = case when n_aud = 0 then 'EMPTY' else 'DONE' end
   where run_id = v_run;
  update crm.flows set last_run_at = now(), updated_at = now() where flow_id = f.flow_id;
  return jsonb_build_object('flow', f.key, 'audience', n_aud, 'enrolled', n_in,
                            'already_received', n_already, 'still_in_flow', n_busy);
end;
$$;

-- The cron (every 5 minutes): runs the disparos that are due.
create or replace function public.crm_run_due_broadcasts() returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  f crm.flows;
  out jsonb := '[]';
begin
  for f in select * from crm.flows
            where trigger_fact = 'BROADCAST' and status = 'ACTIVE' and version > 0
              and broadcast is not null and next_run_at is not null and next_run_at <= now()
            order by next_run_at
            for update skip locked loop
    if f.next_run_at < now() - interval '3 hours' then
      -- too late to send (paused, platform down): not fired now, next one scheduled
      insert into crm.broadcast_runs (flow_id, scheduled_for, status) values (f.flow_id, f.next_run_at, 'MISSED');
      out := out || jsonb_build_object('flow', f.key, 'missed', f.next_run_at);
    else
      out := out || crm.run_broadcast(f.flow_id);
    end if;
    update crm.flows set next_run_at = crm.broadcast_next_run(broadcast -> 'schedule', now()) where flow_id = f.flow_id;
  end loop;
  return out;
end;
$$;

-- "Disparar agora": one run outside the schedule (the schedule stays as it is).
create or replace function public.crm_run_broadcast_now(p_key text, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare f crm.flows; r jsonb;
begin
  perform crm.set_actor(p_actor);
  select * into f from crm.flows where key = p_key for update;
  if not found or f.trigger_fact <> 'BROADCAST' then raise exception 'Disparo não encontrado'; end if;
  if f.status <> 'ACTIVE' or f.version <= 0 then raise exception 'Publique e ative o disparo antes'; end if;
  if f.broadcast is null then raise exception 'Escolha o segmento e a agenda do disparo'; end if;
  r := crm.run_broadcast(f.flow_id, true);
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('flows', p_key, 'broadcast_run_now', null, r::text, crm.current_actor());
  return r;
end;
$$;

create or replace function public.crm_broadcast_runs(p_key text) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select coalesce(jsonb_agg(to_jsonb(r) - 'flow_id' order by r.ran_at desc), '[]')
    from (select r.* from crm.broadcast_runs r join crm.flows f using (flow_id)
           where f.key = p_key order by r.ran_at desc limit 50) r
$$;

-- disparos use 'BROADCAST' as their trigger (no event starts them)
create or replace function public.crm_save_flow(p_key text, p_name text, p_trigger_fact text, p_graph jsonb,
                                     p_description text default null, p_trigger_filter jsonb default '{}',
                                     p_entry_rule jsonb default '{}', p_reentry text default 'after_exit',
                                     p_max_trigger_age_hours int default 72, p_goal_fact text default null,
                                     p_actor text default null) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  if p_key !~ '^[a-z0-9_]{3,60}$' then raise exception 'Chave: 3 a 60 caracteres (a-z, 0-9, _)'; end if;
  if nullif(btrim(p_name), '') is null then raise exception 'Nome é obrigatório'; end if;
  if p_trigger_fact <> 'BROADCAST' and not p_trigger_fact = any (crm.trigger_facts()) then
    raise exception 'Gatilho desconhecido: %', p_trigger_fact;
  end if;
  if exists (select 1 from crm.flows where key = p_key and (trigger_fact = 'BROADCAST') <> (p_trigger_fact = 'BROADCAST')) then
    raise exception 'Uma jornada não vira disparo (nem o contrário): crie um novo';
  end if;
  if p_goal_fact is not null and not p_goal_fact = any (crm.trigger_facts()) then raise exception 'Meta desconhecida: %', p_goal_fact; end if;
  if jsonb_typeof(p_graph -> 'nodes') is distinct from 'array' or jsonb_typeof(p_graph -> 'edges') is distinct from 'array' then
    raise exception 'Fluxo inválido';
  end if;
  if jsonb_typeof(coalesce(p_trigger_filter, '{}')) <> 'object' then raise exception 'Filtro do gatilho inválido'; end if;
  if exists (select 1 from crm.flows where key = p_key and status = 'ARCHIVED') then raise exception 'Fluxo arquivado'; end if;
  insert into crm.flows (key, name, description, trigger_fact, trigger_filter, entry_rule, reentry, max_trigger_age_hours,
                         goal_fact, graph)
  values (p_key, p_name, p_description, p_trigger_fact, coalesce(p_trigger_filter, '{}'), coalesce(p_entry_rule, '{}'),
          p_reentry, p_max_trigger_age_hours, p_goal_fact, p_graph)
  on conflict (key) do update set name = excluded.name, description = excluded.description,
    trigger_fact = excluded.trigger_fact, trigger_filter = excluded.trigger_filter, entry_rule = excluded.entry_rule,
    reentry = excluded.reentry, max_trigger_age_hours = excluded.max_trigger_age_hours, goal_fact = excluded.goal_fact,
    graph = excluded.graph, updated_at = now();
  return jsonb_build_object('key', p_key, 'errors', crm.flow_graph_errors(p_graph));
end;
$$;

-- the list carries the disparo's settings, next and last run
drop function if exists public.crm_list_flows();
create function public.crm_list_flows()
returns table (key text, name text, description text, status text, trigger_fact text, goal_fact text, version int,
               published_at timestamptz, updated_at timestamptz, steps int,
               live bigint, completed bigint, goals bigint, exited bigint, entered_30d bigint, messages_30d bigint,
               broadcast jsonb, next_run_at timestamptz, last_run_at timestamptz, segment_name text, last_run jsonb)
language sql stable security definer set search_path = crm, public, extensions as $$
  select f.key, f.name, f.description, f.status, f.trigger_fact, f.goal_fact, f.version, f.published_at, f.updated_at,
         jsonb_array_length(f.graph -> 'nodes'),
         count(e.*) filter (where e.status in ('ACTIVE','WAITING')),
         count(e.*) filter (where e.status = 'COMPLETED'),
         count(e.*) filter (where e.status = 'GOAL'),
         count(e.*) filter (where e.status in ('EXITED','FAILED')),
         count(e.*) filter (where e.entered_at > now() - interval '30 days'),
         (select count(*) from crm.messages m join crm.flow_enrollments x using (enrollment_id)
           where m.flow_id = f.flow_id and not x.is_test and m.status in ('SENT','DRY_RUN')
             and m.executed_at > now() - interval '30 days'),
         f.broadcast, f.next_run_at, f.last_run_at,
         (select s.name from crm.segments s where s.key = f.broadcast ->> 'segment'),
         (select to_jsonb(r) - 'flow_id' from crm.broadcast_runs r where r.flow_id = f.flow_id order by r.ran_at desc limit 1)
    from crm.flows f left join crm.flow_enrollments e on e.flow_id = f.flow_id and not e.is_test
   where f.status <> 'ARCHIVED'
   group by f.flow_id order by (f.status = 'ACTIVE') desc, f.name
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'crm_set_broadcast(text,text,jsonb,text,text)', 'crm_run_due_broadcasts()', 'crm_run_broadcast_now(text,text)',
    'crm_broadcast_runs(text)', 'crm_list_flows()',
    'crm_save_flow(text,text,text,jsonb,text,jsonb,jsonb,text,int,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;
