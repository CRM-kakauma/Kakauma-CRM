-- =====================================================================
-- KAKAUMA CRM — test contacts, manual segments and "fire the flow now"
--
--   * crm.customers.is_test: contacts added by hand to check the channels
--     (they never came from the B4you).
--   * crm.segments.kind = 'manual': membership is a list kept by people,
--     never recalculated by the rule engine. A "Teste" segment ships empty.
--   * crm_launch_flow_test: puts every member of a manual segment into a flow
--     right now, using the flow as it is saved (published or not, active or
--     not). Test enrollments skip the entry rule, can skip waits, ignore the
--     daily cap and the send window, and are kept out of the flow's numbers.
--     Opt-outs are still respected.
-- =====================================================================

alter table crm.customers add column is_test boolean not null default false;

alter table crm.segments add column kind text not null default 'rule' check (kind in ('rule','manual'));

alter table crm.flow_enrollments
  add column is_test boolean not null default false,
  add column skip_waits boolean not null default false;

-- Test snapshots of a flow are stored as negative versions (published ones are 1, 2, 3…).
alter table crm.flow_versions add column is_test boolean not null default false;

-- ---------------------------------------------------------------------
-- Manual segments are left alone by the rule engine.
-- ---------------------------------------------------------------------

create or replace function crm.refresh_customer_segments(p_customer uuid) returns void
language plpgsql as $$
declare
  f jsonb := crm.features(p_customer);
  s record;
  v_in boolean;
  v_was boolean;
begin
  if f is null then return; end if;
  for s in select segment_id, key, definition, active from crm.segments where kind = 'rule' loop
    v_in := s.active and crm.eval_rule(s.definition, f);
    v_was := exists (select 1 from crm.segment_members where segment_id = s.segment_id and customer_id = p_customer);
    if v_in and not v_was then
      insert into crm.segment_members (segment_id, customer_id) values (s.segment_id, p_customer);
      insert into crm.customer_events (dedupe_key, fact_type, customer_id, occurred_at, data)
      values ('segment_in:' || s.key || ':' || p_customer || ':' || clock_timestamp()::text, 'SEGMENT_ENTERED',
              p_customer, now(), jsonb_build_object('segment', s.key));
    elsif v_was and not v_in then
      delete from crm.segment_members where segment_id = s.segment_id and customer_id = p_customer;
      insert into crm.customer_events (dedupe_key, fact_type, customer_id, occurred_at, data)
      values ('segment_out:' || s.key || ':' || p_customer || ':' || clock_timestamp()::text, 'SEGMENT_EXITED',
              p_customer, now(), jsonb_build_object('segment', s.key));
    end if;
  end loop;
end;
$$;

create or replace function crm.rebuild_segment(p_segment uuid) returns int
language plpgsql as $$
declare v_count int;
begin
  if (select kind from crm.segments where segment_id = p_segment) = 'manual' then
    return (select count(*) from crm.segment_members where segment_id = p_segment);
  end if;
  delete from crm.segment_members where segment_id = p_segment;
  insert into crm.segment_members (segment_id, customer_id)
  select s.segment_id, f.customer_id
    from crm.segments s, crm.customer_features f
   where s.segment_id = p_segment and s.active and crm.eval_rule(s.definition, to_jsonb(f));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- system: cannot be deleted or turned into a rule; its contacts are managed in the app
insert into crm.segments (key, name, category, description, definition, kind, is_system)
values ('teste', 'Teste', 'test',
        'Contatos internos para testar fluxos e mensagens. Lista manual: só entra quem for adicionado aqui.',
        '{}', 'manual', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- FEATURES: is_test becomes a rule field (column appended).
-- ---------------------------------------------------------------------

create or replace view crm.customer_features as
select
  c.customer_id,
  c.current_customer_type as customer_type,
  c.current_lifecycle_stage as lifecycle,
  c.current_risk_state as risk,
  c.net_ltv,
  c.gross_ltv,
  c.contribution_ltv,
  c.total_paid_orders as paid_orders,
  (select count(*) from crm.orders o where o.customer_id = c.customer_id and o.paid_at > now() - interval '90 days')::int as paid_orders_90d,
  (extract(epoch from now() - c.last_purchase_at) / 86400)::int as days_since_last_purchase,
  (extract(epoch from now() - c.first_seen_at) / 86400)::int as days_since_first_seen,
  case
    when c.total_paid_orders = 0 then null
    when c.net_ltv >= ((select value from crm.settings where key = 'value_tiers') ->> 'high')::numeric then 'high'
    when c.net_ltv >= ((select value from crm.settings where key = 'value_tiers') ->> 'medium')::numeric then 'medium'
    else 'low' end as value_tier,
  lower(a.utm_source) as acquisition_source,
  lower(a.utm_medium) as acquisition_medium,
  a.utm_campaign as acquisition_campaign,
  a.utm_content as acquisition_creative,
  a.funnel_name as acquisition_funnel,
  (c.acquisition_affiliate_id is not null
   or exists (select 1 from crm.orders o where o.customer_id = c.customer_id and o.affiliate_id is not null)) as has_affiliate,
  c.state,
  s.subscription_id is not null and s.status not in ('CANCELLED','INACTIVE','EXPIRED') as has_active_subscription,
  s.status as subscription_status,
  s.payment_state as subscription_payment_state,
  s.lifecycle_state as subscription_lifecycle,
  s.current_cycle as subscription_cycle,
  s.quality_class as subscription_quality_class,
  s.quality_score as subscription_quality_score,
  coalesce(s.cancellation_requested, false) as cancellation_requested,
  (select coalesce(array_agg(distinct o.product_id) filter (where o.product_id is not null), '{}')
     from crm.orders o where o.customer_id = c.customer_id and o.paid_at is not null) as product_ids,
  (select coalesce(array_agg(distinct o.offer_id) filter (where o.offer_id is not null), '{}')
     from crm.orders o where o.customer_id = c.customer_id and o.paid_at is not null) as offer_ids,
  c.total_refunds as refunds,
  (select count(*) from crm.fulfillments f where f.customer_id = c.customer_id
      and f.status in ('DELIVERY_DELAYED','DELIVERY_FAILED','DELIVERY_RETURNED','DELIVERY_LOST'))::int as delivery_problems,
  c.email is not null as has_email,
  coalesce(c.whatsapp, c.phone) is not null as has_whatsapp,
  c.profit_ltv,
  c.cx_score,
  c.is_test
from crm.customers c
left join crm.attributions a on a.attribution_id = c.acquisition_attribution_id
left join lateral (
  select * from crm.subscriptions s
   where s.customer_id = c.customer_id
   order by (s.status not in ('CANCELLED','INACTIVE','EXPIRED')) desc, coalesce(s.last_charge_at, s.start_date) desc nulls last
   limit 1
) s on true;

-- ---------------------------------------------------------------------
-- ENGINE: test enrollments
-- ---------------------------------------------------------------------

create or replace function crm.flow_tick(p_limit int default 200, p_max_steps int default 30) returns int
language plpgsql as $$
declare
  en record; g jsonb; n jsonb; c jsonb; v_next text; v_out text; v_steps int; v_count int := 0; v_tpl uuid;
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

-- Messages of a test go out now: no daily cap, no send window (opt-out still applies).
-- is_test is returned so the worker sends them even before the channel is set live.
drop function public.crm_claim_messages(int);
drop function crm.claim_messages(int);

create function crm.claim_messages(p_limit int default 100)
returns table (message_id uuid, channel text, purpose text, template_key text, content jsonb, team_text text,
               customer jsonb, flow_key text, is_test boolean)
language plpgsql as $$
#variable_conflict use_column
declare
  m record; v_reason text; v_cust jsonb; v_when timestamptz;
  v_cap int := coalesce(crm.setting_num('max_actions_per_customer_per_day'), 3)::int;
begin
  for m in
    select ms.*, t.purpose, t.content, t.archived, f.key as fkey, coalesce(en.is_test, false) as test
      from crm.messages ms
      left join crm.message_templates t using (template_id)
      left join crm.flows f on f.flow_id = ms.flow_id
      left join crm.flow_enrollments en on en.enrollment_id = ms.enrollment_id
     where (ms.status = 'QUEUED' and ms.scheduled_for <= now())
        or (ms.status = 'PROCESSING' and ms.updated_at < now() - interval '15 minutes')
     order by ms.scheduled_for
     for update of ms skip locked
     limit greatest(p_limit, 1)
  loop
    v_cust := crm.message_customer(m.customer_id);
    v_reason := null;
    if m.channel <> 'team' then
      if m.content is null then v_reason := 'template_missing';
      elsif m.purpose = 'marketing' and exists (select 1 from crm.channel_optouts o where o.customer_id = m.customer_id
                                                   and o.channel in (m.channel, 'all')) then
        v_reason := 'opt_out';
      elsif (m.channel = 'email' and v_cust ->> 'email' is null)
         or (m.channel in ('sms','rcs','whatsapp') and v_cust ->> 'phone' is null) then
        v_reason := 'no_contact_for_' || m.channel;
      elsif m.purpose = 'marketing' and not m.test and
            (select count(*) from crm.messages x where x.customer_id = m.customer_id and x.message_id <> m.message_id
                and x.channel <> 'team' and x.status in ('SENT','DRY_RUN','PROCESSING')
                and coalesce(x.executed_at, x.updated_at) > now() - interval '24 hours')
          + (select count(*) from crm.automation_runs x where x.customer_id = m.customer_id
                and x.status in ('SENT','DRY_RUN','PROCESSING')
                and coalesce(x.executed_at, x.updated_at) > now() - interval '24 hours') >= v_cap then
        v_reason := 'daily_cap';
      elsif m.purpose = 'marketing' and not m.test then
        v_when := crm.next_send_time(now());
        if v_when > now() then
          update crm.messages set scheduled_for = v_when, status = 'QUEUED', updated_at = now() where message_id = m.message_id;
          continue;
        end if;
      end if;
    end if;

    if v_reason is not null then
      update crm.messages set status = 'SKIPPED', skip_reason = v_reason, executed_at = now(), updated_at = now()
       where message_id = m.message_id;
      continue;
    end if;
    update crm.messages set status = 'PROCESSING', attempts = attempts + 1, updated_at = now() where message_id = m.message_id;
    return query select m.message_id, m.channel, coalesce(m.purpose, 'transactional'), m.template_key, m.content,
                        m.team_text, v_cust, m.fkey, m.test;
  end loop;
end;
$$;

create function public.crm_claim_messages(p_limit int default 100)
returns table (message_id uuid, channel text, purpose text, template_key text, content jsonb, team_text text,
               customer jsonb, flow_key text, is_test boolean)
language sql security definer set search_path = crm, public, extensions as $$ select * from crm.claim_messages(p_limit) $$;

-- ---------------------------------------------------------------------
-- PUBLIC ENTRY POINTS
-- ---------------------------------------------------------------------

drop function public.crm_list_segments();
create function public.crm_list_segments()
returns table (key text, name text, category text, description text, active boolean, is_system boolean,
               definition jsonb, members bigint, kind text)
language sql stable security definer set search_path = crm, public, extensions as $$
  select s.key, s.name, s.category, s.description, s.active, s.is_system, s.definition,
         (select count(*) from crm.segment_members m where m.segment_id = s.segment_id), s.kind
    from crm.segments s order by (s.kind = 'manual') desc, s.category, s.key
$$;

-- Members of a manual segment, with what the channels need.
create function public.crm_segment_contacts(p_segment text)
returns table (customer_id uuid, full_name text, email text, phone text, is_test boolean, since timestamptz)
language sql stable security definer set search_path = crm, public, extensions as $$
  select c.customer_id, c.full_name, c.email, coalesce(c.whatsapp, c.phone), c.is_test, m.since
    from crm.segments s join crm.segment_members m using (segment_id) join crm.customers c using (customer_id)
   where s.key = p_segment order by m.since
$$;

-- Adds a person to a manual segment. An existing customer (same e-mail or phone) is reused as is;
-- otherwise a test contact is created.
create function public.crm_add_test_contact(p_name text, p_email text, p_phone text, p_segment text default 'teste',
                                            p_actor text default null) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  v_seg crm.segments;
  v_email text := crm.norm_email(p_email);
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_phone text;
  v_id uuid;
  v_created boolean := false;
begin
  perform crm.set_actor(p_actor);
  select * into v_seg from crm.segments where key = p_segment;
  if not found then raise exception 'Segmento % não encontrado', p_segment; end if;
  if v_seg.kind <> 'manual' then raise exception 'Só dá para adicionar contatos a um segmento manual'; end if;
  if v_digits <> '' then
    if length(v_digits) in (12, 13) and v_digits like '55%' then v_digits := substr(v_digits, 3); end if;
    if length(v_digits) not in (10, 11) then
      raise exception 'Celular inválido: use DDD + número (ex.: 11 91234-5678)';
    end if;
    v_phone := crm.norm_phone(v_digits);
  end if;
  if v_email is null and v_phone is null then raise exception 'Informe e-mail ou celular'; end if;

  select customer_id into v_id from crm.customer_identities
   where (kind = 'email' and value = v_email) or (kind = 'whatsapp' and value = v_phone)
   order by (kind = 'email') desc limit 1;
  if v_id is null and v_email is not null then
    select customer_id into v_id from crm.customers where lower(email) = v_email limit 1;
  end if;

  if v_id is null then
    insert into crm.customers (full_name, email, phone, whatsapp, is_test, first_seen_at, last_seen_at)
    values (nullif(btrim(p_name), ''), v_email, v_digits, v_digits, true, now(), now())
    returning customer_id into v_id;
    insert into crm.customer_identities (kind, value, customer_id)
    select k, v, v_id from (values ('email', v_email), ('whatsapp', v_phone)) x(k, v)
     where v is not null
    on conflict do nothing;
    v_created := true;
    perform crm.refresh_customer(v_id);
  end if;

  insert into crm.segment_members (segment_id, customer_id) values (v_seg.segment_id, v_id)
  on conflict do nothing;
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('segments', p_segment, 'member_added', null, v_id::text, crm.current_actor());
  return jsonb_build_object('customer_id', v_id, 'created', v_created);
end;
$$;

create function public.crm_remove_segment_contact(p_segment text, p_customer_id uuid, p_actor text default null)
returns boolean language plpgsql security definer set search_path = crm, public, extensions as $$
declare v_seg crm.segments;
begin
  perform crm.set_actor(p_actor);
  select * into v_seg from crm.segments where key = p_segment;
  if not found or v_seg.kind <> 'manual' then raise exception 'Segmento manual % não encontrado', p_segment; end if;
  delete from crm.segment_members where segment_id = v_seg.segment_id and customer_id = p_customer_id;
  if not found then return false; end if;
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('segments', p_segment, 'member_removed', p_customer_id::text, null, crm.current_actor());
  return true;
end;
$$;

-- Fires a flow now for every member of a manual segment, with the flow as saved.
create function public.crm_launch_flow_test(p_key text, p_segment text default 'teste', p_skip_waits boolean default true,
                                            p_actor text default null) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  f crm.flows; v_seg crm.segments; e text[]; v_version int; v_trigger text;
  v_enrolled int := 0; v_busy int := 0; m record;
begin
  perform crm.set_actor(p_actor);
  select * into f from crm.flows where key = p_key for update;
  if not found then raise exception 'Fluxo % não encontrado', p_key; end if;
  if f.status = 'ARCHIVED' then raise exception 'Fluxo arquivado'; end if;
  e := crm.flow_graph_errors(f.graph);
  if cardinality(e) > 0 then raise exception 'Corrija o fluxo antes de testar: %', array_to_string(e, '; '); end if;
  select * into v_seg from crm.segments where key = p_segment;
  if not found then raise exception 'Segmento % não encontrado', p_segment; end if;
  if v_seg.kind <> 'manual' then
    raise exception 'O teste só dispara para um segmento manual (como "Teste"), nunca para clientes por regra';
  end if;
  if not exists (select 1 from crm.segment_members where segment_id = v_seg.segment_id) then
    raise exception 'O segmento "%" está vazio: adicione contatos primeiro', v_seg.name;
  end if;

  v_version := least(coalesce((select min(version) from crm.flow_versions where flow_id = f.flow_id), 0), 0) - 1;
  insert into crm.flow_versions (flow_id, version, graph, published_by, is_test)
  values (f.flow_id, v_version, f.graph, crm.current_actor(), true);
  v_trigger := (select n ->> 'id' from jsonb_array_elements(f.graph -> 'nodes') n where n ->> 'type' = 'trigger' limit 1);

  for m in select customer_id from crm.segment_members where segment_id = v_seg.segment_id loop
    -- a previous test of this flow for the same person is replaced
    update crm.flow_enrollments set status = 'EXITED', exit_reason = 'test_relaunched', finished_at = now(),
           next_run_at = null, updated_at = now()
     where flow_id = f.flow_id and customer_id = m.customer_id and is_test and status in ('ACTIVE','WAITING');
    -- someone really inside the flow is never disturbed by a test
    if exists (select 1 from crm.flow_enrollments where flow_id = f.flow_id and customer_id = m.customer_id
                 and status in ('ACTIVE','WAITING')) then
      v_busy := v_busy + 1;
      continue;
    end if;
    insert into crm.flow_enrollments (flow_id, version, customer_id, current_node, next_run_at, is_test, skip_waits)
    values (f.flow_id, v_version, m.customer_id, v_trigger, now(), true, coalesce(p_skip_waits, true));
    v_enrolled := v_enrolled + 1;
  end loop;

  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('flows', p_key, 'test_launch', p_segment, v_enrolled::text, crm.current_actor());
  return jsonb_build_object('enrolled', v_enrolled, 'already_in_flow', v_busy, 'version', v_version);
end;
$$;

-- Test enrollments stay out of the flow's numbers; the builder lists them apart.
drop function public.crm_list_flows();
create function public.crm_list_flows()
returns table (key text, name text, description text, status text, trigger_fact text, goal_fact text, version int,
               published_at timestamptz, updated_at timestamptz, steps int,
               live bigint, completed bigint, goals bigint, exited bigint, entered_30d bigint, messages_30d bigint)
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
             and m.executed_at > now() - interval '30 days')
    from crm.flows f left join crm.flow_enrollments e on e.flow_id = f.flow_id and not e.is_test
   where f.status <> 'ARCHIVED'
   group by f.flow_id order by (f.status = 'ACTIVE') desc, f.name
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
  foreach fn in array array[
    'crm_claim_messages(int)', 'crm_list_segments()', 'crm_segment_contacts(text)',
    'crm_add_test_contact(text,text,text,text,text)', 'crm_remove_segment_contact(text,uuid,text)',
    'crm_launch_flow_test(text,text,boolean,text)', 'crm_list_flows()', 'crm_flow_stats(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;
