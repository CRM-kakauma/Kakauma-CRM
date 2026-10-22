-- =====================================================================
-- KAKAUMA CRM — importing old webhooks (history from before the CRM)
--
--   Operação → "Importar arquivo de webhooks": each payload is stored with
--   the time it originally arrived (received_at) and processed by the same
--   engine as a live webhook, but inside a "backfill" transaction: flows and
--   simple automations ignore every fact created there, whatever their
--   "idade máxima do gatilho" — importing history never messages customers.
--   Same idempotency as live webhooks: importing again changes nothing.
-- =====================================================================

create or replace function crm.flows_on_fact() returns trigger
language plpgsql as $$
begin
  -- history being imported (Operação → Importar arquivo): old facts never move flows
  if current_setting('crm.backfill', true) = 'on' then return null; end if;
  -- 1. goal reached
  with done as (
    update crm.flow_enrollments en set status = 'GOAL', exit_reason = 'goal:' || new.fact_type,
           finished_at = now(), next_run_at = null, updated_at = now()
      from crm.flows f
     where f.flow_id = en.flow_id and en.customer_id = new.customer_id and en.status in ('ACTIVE','WAITING')
       and f.goal_fact = new.fact_type and new.occurred_at >= en.entered_at - interval '1 minute'
    returning en.enrollment_id
  )
  insert into crm.flow_steps (enrollment_id, node_id, node_type, outcome, detail)
  select enrollment_id, 'goal', 'goal', 'GOAL', jsonb_build_object('fact', new.fact_type) from done;

  -- 2. the event a "wait for event" step was waiting for
  update crm.flow_enrollments set status = 'ACTIVE', current_node = wait_event_node, next_run_at = now(),
         wait_fact = null, wait_filter = null, wait_event_node = null, updated_at = now()
   where customer_id = new.customer_id and status = 'WAITING' and wait_fact = new.fact_type
     and new.data @> coalesce(wait_filter, '{}') and new.occurred_at >= wait_started_at - interval '1 minute';

  -- 3. new enrollments (entry rule is checked when the flow starts, on fresh state)
  insert into crm.flow_enrollments (flow_id, version, customer_id, trigger_event_id, current_node, next_run_at)
  select f.flow_id, f.version, new.customer_id, new.id,
         (select n ->> 'id' from jsonb_array_elements(v.graph -> 'nodes') n where n ->> 'type' = 'trigger'), now()
    from crm.flows f join crm.flow_versions v on v.flow_id = f.flow_id and v.version = f.version
   where f.status = 'ACTIVE' and f.trigger_fact = new.fact_type
     and new.data @> f.trigger_filter
     and new.occurred_at > now() - make_interval(hours => f.max_trigger_age_hours)
     and not exists (select 1 from crm.flow_enrollments x where x.flow_id = f.flow_id and x.customer_id = new.customer_id
                       and (x.status in ('ACTIVE','WAITING') or f.reentry = 'once'))
  on conflict do nothing;
  return null;
end;
$$;

create or replace function crm.match_automations() returns trigger
language plpgsql as $$
begin
  if current_setting('crm.backfill', true) = 'on' then return null; end if;
  insert into crm.automation_runs (automation_id, customer_id, trigger_event_id, scheduled_for)
  select a.automation_id, new.customer_id, new.id,
         greatest(new.occurred_at + make_interval(mins => a.delay_minutes), now())
    from crm.automations a
   where a.active
     and a.trigger_fact = new.fact_type
     and new.data @> a.trigger_filter
     and new.occurred_at > now() - make_interval(hours => a.max_trigger_age_hours)
  on conflict (automation_id, trigger_event_id) do nothing;
  return null;
end;
$$;

create or replace function public.crm_ingest_backfill(p_source text, p_event_name text, p_source_event_id text,
                                                      p_payload jsonb, p_redacted text[], p_received_at timestamptz)
returns table (id uuid, event_id text, duplicate boolean, processing_status text)
language sql security definer set search_path = crm, public, extensions as $$
  select * from crm.ingest_raw(p_source, p_event_name, p_source_event_id, p_payload, 'v1', p_redacted,
                               least(coalesce(p_received_at, now()), now()))
$$;

create or replace function public.crm_process_event_backfill(p_raw_event_id uuid, p_normalized jsonb) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform set_config('crm.backfill', 'on', true);  -- this transaction only
  return crm.process_event(p_raw_event_id, p_normalized);
end;
$$;

revoke all on function public.crm_ingest_backfill(text, text, text, jsonb, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.crm_process_event_backfill(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.crm_ingest_backfill(text, text, text, jsonb, text[], timestamptz) to service_role;
grant execute on function public.crm_process_event_backfill(uuid, jsonb) to service_role;
