-- =====================================================================
-- KAKAUMA CRM — flow step "Aguardar entrega" (wait_delivery)
--
--   Put after a send: waits for the result of the last message this
--   enrollment sent and follows "delivered" or "failed".
--     failed    = not sent (FAILED / SKIPPED: opt-out, no contact, invalid number…)
--                 or the operator reported Undelivered / Rejected / Invalid /
--                 Blocked / Expired / No credits (Pushfy webhook)
--     delivered = Delivered / Clicked (webhook), or a simulation (DRY_RUN)
--   Without a report within the deadline, config.on_timeout decides
--   (default "delivered": no news is taken as sent).
--   Typical use: RCS → Aguardar entrega → not delivered → SMS.
--   The enrollment wakes up as soon as the message changes (trigger below).
-- =====================================================================

create or replace function crm.flow_handles(p_node jsonb) returns text[]
language sql immutable as $$
  select case p_node ->> 'type'
    when 'wait_event' then array['event','timeout']
    when 'condition' then array['yes','no']
    when 'wait_delivery' then array['delivered','failed']
    when 'split' then (select coalesce(array_agg(b ->> 'key'), '{}') from jsonb_array_elements(p_node #> '{config,branches}') b)
    when 'exit' then '{}'::text[]
    else array['next'] end
$$;

create or replace function crm.flow_graph_errors(p_graph jsonb) returns text[]
language plpgsql stable as $$
declare
  e text[] := '{}';
  n jsonb; ed jsonb;
  v_ids text[]; v_type text; c jsonb; t record;
  v_sum int; v_count int;
  v_seen text[]; v_frontier text[]; v_indeg jsonb := '{}'; v_left int;
begin
  if jsonb_typeof(p_graph -> 'nodes') is distinct from 'array' or jsonb_typeof(p_graph -> 'edges') is distinct from 'array' then
    return array['Fluxo inválido'];
  end if;
  if jsonb_array_length(p_graph -> 'nodes') > 100 then e := array_append(e, 'Máximo de 100 etapas'); end if;
  select array_agg(x ->> 'id') into v_ids from jsonb_array_elements(p_graph -> 'nodes') x;
  if (select count(distinct v) from unnest(v_ids) v) <> cardinality(v_ids) then e := array_append(e, 'Etapas com id repetido'); end if;
  if (select count(*) from jsonb_array_elements(p_graph -> 'nodes') x where x ->> 'type' = 'trigger') <> 1 then
    e := array_append(e, 'O fluxo precisa de exatamente um início');
  end if;

  for n in select * from jsonb_array_elements(p_graph -> 'nodes') loop
    v_type := n ->> 'type'; c := coalesce(n -> 'config', '{}');
    if coalesce(n ->> 'id', '') !~ '^[A-Za-z0-9_-]{1,40}$' then e := array_append(e, 'Id de etapa inválido'); end if;
    if v_type = 'send' then
      select * into t from crm.message_templates where key = c ->> 'template_key';
      if not found then e := array_append(e, format('Envio "%s": escolha uma mensagem', coalesce(n ->> 'id', '?')));
      elsif t.archived then e := array_append(e, format('Envio: a mensagem "%s" está arquivada', t.name));
      end if;
    elsif v_type = 'wait' then
      if coalesce(c ->> 'amount', '') !~ '^[0-9]+$' or (c ->> 'amount')::int < 1
         or coalesce(c ->> 'unit', 'hours') not in ('minutes','hours','days')
         or crm.wait_interval(c) > interval '365 days' then
        e := array_append(e, 'Espera: informe uma duração entre 1 minuto e 365 dias');
      end if;
    elsif v_type = 'wait_event' then
      if not coalesce(c ->> 'fact', '') = any (crm.trigger_facts()) then e := array_append(e, 'Aguardar evento: escolha o evento'); end if;
      if coalesce(c ->> 'timeout_hours', '') !~ '^[0-9]+$' or (c ->> 'timeout_hours')::int not between 1 and 2160 then
        e := array_append(e, 'Aguardar evento: prazo entre 1 hora e 90 dias');
      end if;
    elsif v_type = 'wait_delivery' then
      if coalesce(c ->> 'timeout_hours', '') !~ '^[0-9]+$' or (c ->> 'timeout_hours')::int not between 1 and 168 then
        e := array_append(e, 'Aguardar entrega: prazo entre 1 hora e 7 dias');
      end if;
      if coalesce(c ->> 'on_timeout', 'delivered') not in ('delivered','failed') then
        e := array_append(e, 'Aguardar entrega: escolha o que fazer sem confirmação');
      end if;
    elsif v_type = 'condition' then
      begin
        perform crm.validate_rule(coalesce(c -> 'rule', '{}'));
        if coalesce(c -> 'rule', '{}') = '{}'::jsonb then e := array_append(e, 'Condição: defina a regra'); end if;
      exception when others then
        e := array_append(e, 'Condição: ' || sqlerrm);
      end;
    elsif v_type = 'split' then
      select count(*), coalesce(sum((b ->> 'percent')::int), 0) into v_count, v_sum
        from jsonb_array_elements(case when jsonb_typeof(c -> 'branches') = 'array' then c -> 'branches' else '[]' end) b
       where coalesce(b ->> 'percent', '') ~ '^[0-9]+$' and coalesce(b ->> 'key', '') ~ '^[a-z]$';
      if v_count not between 2 and 4 or v_count <> jsonb_array_length(coalesce(c -> 'branches', '[]')) then
        e := array_append(e, 'Teste A/B: de 2 a 4 caminhos');
      elsif v_sum <> 100 then
        e := array_append(e, format('Teste A/B: as porcentagens somam %s%%, precisam somar 100%%', v_sum));
      end if;
    elsif v_type = 'alert_team' then
      if coalesce(btrim(c ->> 'message'), '') = '' then e := array_append(e, 'Alerta para a equipe: escreva a mensagem'); end if;
    elsif v_type not in ('trigger','exit') then
      e := array_append(e, format('Tipo de etapa desconhecido: %s', v_type));
    end if;
  end loop;

  for ed in select * from jsonb_array_elements(p_graph -> 'edges') loop
    n := crm.flow_node(p_graph, ed ->> 'source');
    if n is null or crm.flow_node(p_graph, ed ->> 'target') is null then
      e := array_append(e, 'Ligação para uma etapa que não existe');
    elsif not coalesce(ed ->> 'handle', 'next') = any (crm.flow_handles(n)) then
      e := array_append(e, format('Saída "%s" inválida para a etapa %s', coalesce(ed ->> 'handle', 'next'), n ->> 'id'));
    elsif crm.flow_node(p_graph, ed ->> 'target') ->> 'type' = 'trigger' then
      e := array_append(e, 'Nenhuma etapa pode voltar para o início');
    end if;
  end loop;
  if (select count(*) from (select x ->> 'source' as src, coalesce(x ->> 'handle', 'next') as h
                              from jsonb_array_elements(p_graph -> 'edges') x group by 1, 2 having count(*) > 1) d) > 0 then
    e := array_append(e, 'Uma saída está ligada a mais de uma etapa');
  end if;
  if cardinality(e) > 0 then return e; end if;

  -- Reachability from the start and no cycles (Kahn over the reachable part).
  select array[x ->> 'id'] into v_frontier from jsonb_array_elements(p_graph -> 'nodes') x where x ->> 'type' = 'trigger';
  v_seen := v_frontier;
  while cardinality(v_frontier) > 0 loop
    select coalesce(array_agg(distinct x ->> 'target'), '{}') into v_frontier
      from jsonb_array_elements(p_graph -> 'edges') x
     where x ->> 'source' = any (v_frontier) and not (x ->> 'target' = any (v_seen));
    v_seen := v_seen || v_frontier;
  end loop;
  if cardinality(v_seen) < cardinality(v_ids) then
    e := array_append(e, format('%s etapa(s) solta(s), sem ligação a partir do início', cardinality(v_ids) - cardinality(v_seen)));
  end if;
  v_left := cardinality(v_ids);
  v_frontier := array(select x ->> 'id' from jsonb_array_elements(p_graph -> 'nodes') x
                       where not exists (select 1 from jsonb_array_elements(p_graph -> 'edges') y where y ->> 'target' = x ->> 'id'));
  v_seen := '{}';
  while cardinality(v_frontier) > 0 loop
    v_seen := v_seen || v_frontier;
    v_frontier := array(
      select distinct x ->> 'id' from jsonb_array_elements(p_graph -> 'nodes') x
       where not (x ->> 'id' = any (v_seen))
         and not exists (select 1 from jsonb_array_elements(p_graph -> 'edges') y
                          where y ->> 'target' = x ->> 'id' and not (y ->> 'source' = any (v_seen))));
  end loop;
  if cardinality(v_seen) < v_left then e := array_append(e, 'O fluxo tem um ciclo (uma etapa volta para trás)'); end if;
  return e;
end;
$$;

create or replace function crm.simulate_flow(p_graph jsonb, p_entry_rule jsonb, p_customer uuid, p_events text[] default '{}')
returns jsonb language plpgsql stable as $$
declare
  f jsonb := crm.features(p_customer);
  v_next text; n jsonb; c jsonb; v_out text; v_offset interval := '0'; v_path jsonb := '[]'; v_steps int := 0;
begin
  if f is null then raise exception 'customer % not found', p_customer; end if;
  select x ->> 'id' into v_next from jsonb_array_elements(p_graph -> 'nodes') x where x ->> 'type' = 'trigger';
  while v_next is not null and v_steps < 50 loop
    v_steps := v_steps + 1;
    n := crm.flow_node(p_graph, v_next);
    exit when n is null;
    c := coalesce(n -> 'config', '{}');
    v_out := 'next';
    case n ->> 'type'
      when 'trigger' then
        if not crm.eval_rule(coalesce(p_entry_rule, '{}'), f) then
          v_path := v_path || jsonb_build_object('node_id', n ->> 'id', 'type', 'trigger', 'outcome', 'entry_rule_not_met',
                                                 'after_minutes', 0);
          return jsonb_build_object('path', v_path, 'result', 'EXITED');
        end if;
      when 'wait' then v_offset := v_offset + crm.wait_interval(c);
      when 'wait_event' then
        if c ->> 'fact' = any (coalesce(p_events, '{}')) then v_out := 'event';
        else v_out := 'timeout'; v_offset := v_offset + make_interval(hours => coalesce((c ->> 'timeout_hours')::int, 0)); end if;
      -- a simulation assumes delivery unless asked "what if it is not delivered"
      when 'wait_delivery' then
        v_out := case when 'DELIVERY_FAILED' = any (coalesce(p_events, '{}')) then 'failed' else 'delivered' end;
      when 'condition' then v_out := case when crm.eval_rule(c -> 'rule', f) then 'yes' else 'no' end;
      when 'split' then v_out := coalesce(crm.split_branch(n, p_customer::text || (n ->> 'id')), 'next');
      else null;
    end case;
    v_path := v_path || jsonb_build_object('node_id', n ->> 'id', 'type', n ->> 'type', 'outcome', v_out,
                                           'after_minutes', (extract(epoch from v_offset) / 60)::int,
                                           'template_key', c ->> 'template_key');
    exit when n ->> 'type' = 'exit';
    v_next := crm.flow_next(p_graph, n ->> 'id', v_out);
  end loop;
  return jsonb_build_object('path', v_path, 'result', 'COMPLETED', 'customer', crm.message_customer(p_customer));
end;
$$;

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

-- A change on a watched message wakes the enrollment waiting for it.
create function crm.wake_delivery_wait() returns trigger
language plpgsql as $$
begin
  update crm.flow_enrollments set next_run_at = now(), updated_at = now()
   where enrollment_id = new.enrollment_id and status = 'ACTIVE' and wait_fact = '__delivery'
     and wait_filter ->> 'message_id' = new.message_id::text and next_run_at > now();
  return null;
end;
$$;

create trigger messages_wake_delivery after update of status, provider_status on crm.messages
for each row when (new.enrollment_id is not null
                   and (old.status is distinct from new.status or old.provider_status is distinct from new.provider_status))
execute function crm.wake_delivery_wait();
