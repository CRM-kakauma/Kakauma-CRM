-- =====================================================================
-- KAKAUMA CRM — history with the real date frees waits since the flow entry
--
--   Deliveries recovered from the Paylog API carry the real delivery date,
--   which may be before the customer reached "Aguardar evento: Entrega
--   realizada" (e.g. a 3-day wait first, delivery on day 2). Like the wait
--   step does for events already in the CRM (0026), a history fact frees the
--   wait when it happened after the customer entered the flow.
--   crm_waiting_count: how many customers are waiting for an event.
-- =====================================================================

create or replace function crm.flows_on_fact() returns trigger
language plpgsql as $$
begin
  if crm.is_backfill_fact(new.raw_event_id) then
    -- history: only the wait for this very event moves on. With the real date of the event
    -- (e.g. Paylog API), it may come before the wait started: anything since the customer
    -- entered the flow counts, as "Aguardar evento" does for events already in the CRM
    update crm.flow_enrollments set status = 'ACTIVE', current_node = wait_event_node, next_run_at = now(),
           wait_fact = null, wait_filter = null, wait_event_node = null, updated_at = now()
     where customer_id = new.customer_id and status = 'WAITING' and wait_fact = new.fact_type
       and new.data @> coalesce(wait_filter, '{}') and new.occurred_at >= entered_at - interval '1 minute';
    return null;
  end if;
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

create or replace function public.crm_waiting_count(p_fact text) returns int
language sql stable security definer set search_path = crm, public, extensions as $$
  select count(*)::int from crm.flow_enrollments where status = 'WAITING' and wait_fact = p_fact
$$;
revoke all on function public.crm_waiting_count(text) from public, anon, authenticated;
grant execute on function public.crm_waiting_count(text) to service_role;
