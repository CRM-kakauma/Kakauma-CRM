-- =====================================================================
-- KAKAUMA CRM — "Por que não entrou?" (flow page)
--
--   For the flow's trigger in the last N hours: how many customers triggered
--   it, how many entered, and why each of the others stayed out:
--     already went through (flow "only once"), already in the flow, trigger
--     filter not met, fact too old (max_trigger_age_hours), history
--     (import / resend, never starts flows), flow not active; and who entered
--     but left at once because the entry rule was not met.
-- =====================================================================

create or replace function public.crm_flow_entry_diagnosis(p_key text, p_hours int default 24)
returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  with f as (select * from crm.flows where key = p_key),
  facts as (
    select e.id, e.customer_id, e.occurred_at, e.created_at, e.data, e.raw_event_id,
           coalesce(c.full_name, c.email, c.phone, 'Cliente') as who
      from crm.customer_events e join f on e.fact_type = f.trigger_fact
      left join crm.customers c on c.customer_id = e.customer_id
     where e.created_at > now() - make_interval(hours => least(greatest(p_hours, 1), 720))
  ),
  judged as (
    select x.*,
           en.enrollment_id, en.status as en_status, en.exit_reason,
           case
             when en.enrollment_id is not null and en.exit_reason = 'entry_rule_not_met' then 'entry_rule'
             when en.enrollment_id is not null then 'entered'
             when crm.is_backfill_fact(x.raw_event_id) then 'history'
             when not (x.data @> coalesce((select trigger_filter from f), '{}')) then 'filter'
             when x.occurred_at <= x.created_at - make_interval(hours => (select max_trigger_age_hours from f)) then 'too_old'
             when exists (select 1 from crm.flow_enrollments p, f
                           where p.flow_id = f.flow_id and p.customer_id = x.customer_id and not p.is_test
                             and p.entered_at <= x.created_at
                             and (p.finished_at is null or p.finished_at > x.created_at)) then 'busy'
             when (select reentry from f) = 'once' and exists (
                    select 1 from crm.flow_enrollments p, f
                     where p.flow_id = f.flow_id and p.customer_id = x.customer_id and not p.is_test
                       and p.entered_at <= x.created_at) then 'once'
             when (select status from f) <> 'ACTIVE' then 'inactive'
             else 'other' end as result
      from facts x
      left join lateral (
        select en.* from crm.flow_enrollments en, f
         where en.flow_id = f.flow_id and en.trigger_event_id = x.id limit 1) en on true
  )
  select jsonb_build_object(
    'flow', (select name from f), 'status', (select status from f), 'reentry', (select reentry from f),
    'trigger_fact', (select trigger_fact from f), 'max_trigger_age_hours', (select max_trigger_age_hours from f),
    'hours', least(greatest(p_hours, 1), 720),
    'facts', (select count(*) from judged),
    'people', (select count(distinct customer_id) from judged),
    'by_result', (select coalesce(jsonb_object_agg(result, n), '{}') from
                    (select result, count(*) n from judged group by result) r),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('at', occurred_at, 'customer_id', customer_id,
                                                           'who', who, 'result', result) order by occurred_at desc), '[]')
                 from (select * from judged order by occurred_at desc limit 40) j)
  )
$$;
revoke all on function public.crm_flow_entry_diagnosis(text, int) from public, anon, authenticated;
grant execute on function public.crm_flow_entry_diagnosis(text, int) to service_role;
