-- =====================================================================
-- KAKAUMA CRM — "Aguardar evento" sees an event that already happened
--
--   When a customer reaches "Aguardar evento", an event of that kind that
--   happened since they entered the flow counts (e.g. "Envio criado" that
--   arrived while an earlier step was still pending): they follow
--   "Aconteceu" right away instead of waiting for a new one.
--   Events from before entering the flow (an older order) and the event that
--   started the flow never count.
-- =====================================================================

create or replace function crm.flow_tick(p_limit int default 200, p_max_steps int default 30) returns int
language plpgsql as $$
declare
  en record; g jsonb; n jsonb; c jsonb; v_next text; v_out text; v_steps int; v_count int := 0; v_tpl uuid;
  v_msg record; v_deadline timestamptz; v_watch uuid;
begin
  for en in
    select e.*, f.status as flow_status, f.entry_rule, f.key as flow_key
      from crm.flow_enrollments e join crm.flows f using (flow_id)
     where e.status in ('ACTIVE','WAITING') and e.next_run_at <= now()
       and (f.status in ('ACTIVE','ARCHIVED') or e.is_test)   -- a test runs even if the flow is not live
     order by e.next_run_at
     for update of e skip locked
     limit greatest(p_limit, 1)
  loop
    v_count := v_count + 1;
    if en.flow_status = 'ARCHIVED' then
      update crm.flow_enrollments set status = 'EXITED', exit_reason = 'flow_archived', finished_at = now(),
             next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
      continue;
    end if;
    select graph into g from crm.flow_versions where flow_id = en.flow_id and version = en.version;
    if en.status = 'WAITING' then  -- the awaited event did not come in time
      perform crm.flow_step(en.enrollment_id, jsonb_build_object('id', 'timeout', 'type', 'wait_event'), 'timeout');
    end if;
    v_next := en.current_node;
    v_steps := 0;

    loop
      if v_next is null then
        update crm.flow_enrollments set status = 'COMPLETED', current_node = null, next_run_at = null, finished_at = now(),
               wait_fact = null, wait_filter = null, wait_event_node = null, updated_at = now()
         where enrollment_id = en.enrollment_id;
        exit;
      end if;
      v_steps := v_steps + 1;
      if v_steps > p_max_steps then  -- safety net; graphs are validated acyclic
        update crm.flow_enrollments set status = 'FAILED', exit_reason = 'too_many_steps', finished_at = now(),
               next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
        exit;
      end if;
      n := crm.flow_node(g, v_next);
      if n is null then
        update crm.flow_enrollments set status = 'FAILED', exit_reason = 'missing_node:' || v_next, finished_at = now(),
               next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
        exit;
      end if;
      c := coalesce(n -> 'config', '{}');

      case n ->> 'type'
      when 'trigger' then
        -- a test is fired by hand for chosen contacts: the entry rule does not apply
        if not en.is_test and not crm.eval_rule(en.entry_rule, crm.features(en.customer_id)) then
          perform crm.flow_step(en.enrollment_id, n, 'entry_rule_not_met');
          update crm.flow_enrollments set status = 'EXITED', exit_reason = 'entry_rule_not_met', finished_at = now(),
                 next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
          exit;
        end if;
        perform crm.flow_step(en.enrollment_id, n, 'entered', case when en.is_test then '{"test":true}'::jsonb end);
        v_next := crm.flow_next(g, n ->> 'id');

      when 'send' then
        select template_id into v_tpl from crm.message_templates where key = c ->> 'template_key';
        insert into crm.messages (customer_id, channel, template_id, template_key, flow_id, enrollment_id, node_id)
        select en.customer_id, t.channel, t.template_id, t.key, en.flow_id, en.enrollment_id, n ->> 'id'
          from crm.message_templates t where t.template_id = v_tpl
        on conflict (enrollment_id, node_id) do nothing;
        perform crm.flow_step(en.enrollment_id, n, case when v_tpl is null then 'template_missing' else 'queued' end,
                              jsonb_build_object('template', c ->> 'template_key'));
        v_next := crm.flow_next(g, n ->> 'id');

      when 'alert_team' then
        insert into crm.messages (customer_id, channel, team_text, flow_id, enrollment_id, node_id)
        values (en.customer_id, 'team', c ->> 'message', en.flow_id, en.enrollment_id, n ->> 'id')
        on conflict (enrollment_id, node_id) do nothing;
        perform crm.flow_step(en.enrollment_id, n, 'queued');
        v_next := crm.flow_next(g, n ->> 'id');

      when 'wait' then
        if en.skip_waits then
          perform crm.flow_step(en.enrollment_id, n, 'test_skipped');
          v_next := crm.flow_next(g, n ->> 'id');
        else
          perform crm.flow_step(en.enrollment_id, n, 'waiting', jsonb_build_object('until', now() + crm.wait_interval(c)));
          update crm.flow_enrollments set status = 'ACTIVE', current_node = crm.flow_next(g, n ->> 'id'),
                 next_run_at = now() + crm.wait_interval(c), updated_at = now()
           where enrollment_id = en.enrollment_id;
          exit;
        end if;

      when 'wait_event' then
        if en.skip_waits then  -- fast test: behave as if the event did not come
          perform crm.flow_step(en.enrollment_id, n, 'timeout', '{"test":true}'::jsonb);
          v_next := crm.flow_next(g, n ->> 'id', 'timeout');
        elsif exists (select 1 from crm.customer_events ce
                       where ce.customer_id = en.customer_id and ce.fact_type = c ->> 'fact'
                         and ce.data @> coalesce(c -> 'filter', '{}')
                         and ce.occurred_at >= en.entered_at - interval '1 minute'
                         and ce.id is distinct from en.trigger_event_id) then
          -- it already happened while the customer was in the flow (e.g. tracking before this step)
          perform crm.flow_step(en.enrollment_id, n, 'event', jsonb_build_object('fact', c ->> 'fact', 'already', true));
          v_next := crm.flow_next(g, n ->> 'id', 'event');
        else
          perform crm.flow_step(en.enrollment_id, n, 'waiting', jsonb_build_object('fact', c ->> 'fact'));
          update crm.flow_enrollments set status = 'WAITING',
                 current_node = crm.flow_next(g, n ->> 'id', 'timeout'),
                 wait_event_node = crm.flow_next(g, n ->> 'id', 'event'),
                 wait_fact = c ->> 'fact', wait_filter = coalesce(c -> 'filter', '{}'), wait_started_at = now(),
                 next_run_at = now() + make_interval(hours => (c ->> 'timeout_hours')::int), updated_at = now()
           where enrollment_id = en.enrollment_id;
          exit;
        end if;

      when 'wait_delivery' then
        -- the message to watch: the last one this enrollment sent (fixed when the step is reached)
        if en.wait_fact = '__delivery' and en.current_node = n ->> 'id' then
          v_watch := (en.wait_filter ->> 'message_id')::uuid;
          v_deadline := en.wait_started_at + make_interval(hours => coalesce((c ->> 'timeout_hours')::int, 24));
        else
          select m.message_id into v_watch from crm.messages m
           where m.enrollment_id = en.enrollment_id and m.channel <> 'team'
           order by (select max(st.id) from crm.flow_steps st
                      where st.enrollment_id = m.enrollment_id and st.node_id = m.node_id) desc nulls last,
                    m.created_at desc
           limit 1;
          v_deadline := now() + make_interval(hours => coalesce((c ->> 'timeout_hours')::int, 24));
        end if;
        select * into v_msg from crm.messages where message_id = v_watch;
        v_out := case
          when v_msg.message_id is null then 'failed'
          when v_msg.status in ('FAILED','SKIPPED')
            or v_msg.provider_status in ('Undelivered','Rejected','Invalid','Blocked','Expired','No credits') then 'failed'
          when v_msg.provider_status in ('Delivered','Clicked') or v_msg.status = 'DRY_RUN' then 'delivered'
          when now() >= v_deadline then coalesce(c ->> 'on_timeout', 'delivered')
          else null end;
        if v_out is null then  -- still waiting: the result of the send or the operator's report wakes it up
          if not (en.wait_fact = '__delivery' and en.current_node = n ->> 'id') then
            perform crm.flow_step(en.enrollment_id, n, 'waiting', jsonb_build_object('message_id', v_watch));
          end if;
          update crm.flow_enrollments set status = 'ACTIVE', current_node = n ->> 'id', next_run_at = v_deadline,
                 wait_fact = '__delivery', wait_filter = jsonb_build_object('message_id', v_watch),
                 wait_started_at = coalesce(case when wait_fact = '__delivery' and current_node = n ->> 'id'
                                                 then wait_started_at end, now()),
                 updated_at = now()
           where enrollment_id = en.enrollment_id;
          exit;
        end if;
        perform crm.flow_step(en.enrollment_id, n, v_out,
                              jsonb_build_object('message_id', v_watch, 'status', v_msg.status,
                                                 'provider_status', v_msg.provider_status,
                                                 'timeout', now() >= v_deadline));
        update crm.flow_enrollments set wait_fact = null, wait_filter = null, wait_started_at = null, updated_at = now()
         where enrollment_id = en.enrollment_id and wait_fact = '__delivery';
        en.wait_fact := null;
        v_next := crm.flow_next(g, n ->> 'id', v_out);

      when 'condition' then
        v_out := case when crm.eval_rule(c -> 'rule', crm.features(en.customer_id)) then 'yes' else 'no' end;
        perform crm.flow_step(en.enrollment_id, n, v_out);
        v_next := crm.flow_next(g, n ->> 'id', v_out);

      when 'split' then
        v_out := crm.split_branch(n, en.enrollment_id::text || (n ->> 'id'));
        perform crm.flow_step(en.enrollment_id, n, v_out);
        v_next := crm.flow_next(g, n ->> 'id', v_out);

      when 'exit' then
        perform crm.flow_step(en.enrollment_id, n, 'exit');
        update crm.flow_enrollments set status = 'EXITED', exit_reason = 'exit_step', current_node = null,
               finished_at = now(), next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
        exit;

      else
        update crm.flow_enrollments set status = 'FAILED', exit_reason = 'unknown_step:' || (n ->> 'type'),
               finished_at = now(), next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
        exit;
      end case;
    end loop;
  end loop;
  return v_count;
end;
$$;
