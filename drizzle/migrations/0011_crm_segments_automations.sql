-- =====================================================================
-- KAKAUMA CRM — phase 3: segmentation + automation engine
--
-- CUSTOMER → ACTION → OUTCOME
--
--   fact (customer_events) ──► automation match (trigger + filter, max age)
--                               └─► run QUEUED (delay) ──► worker claims it:
--                                     conditions re-checked on fresh state,
--                                     cooldown + daily cap ──► SKIPPED
--                                     otherwise ──► connector ──► SENT / DRY_RUN / FAILED(retry)
--
-- Segments and automation conditions share one JSON rule language evaluated
-- over crm.customer_features. Unknown fields are rejected when saved.
-- No channel is connected yet: without a webhook URL every action is a DRY_RUN
-- that stores the rendered message.
-- =====================================================================

insert into crm.settings (key, value, description) values
  ('value_tiers', '{"high": 500, "medium": 150}', 'LTV líquido mínimo (R$) para os segmentos de valor alto e médio'),
  ('max_actions_per_customer_per_day', '3', 'Limite de ações de automação por cliente em 24h (proteção contra excesso de mensagens)'),
  ('high_frequency_orders_90d', '3', 'Pedidos pagos em 90 dias para o segmento high_frequency');

-- ---------------------------------------------------------------------
-- FEATURES: one flat row per customer — the only fields rules may use.
-- ---------------------------------------------------------------------

create view crm.customer_features as
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
  coalesce(c.whatsapp, c.phone) is not null as has_whatsapp
from crm.customers c
left join crm.attributions a on a.attribution_id = c.acquisition_attribution_id
left join lateral (
  select * from crm.subscriptions s
   where s.customer_id = c.customer_id
   order by (s.status not in ('CANCELLED','INACTIVE','EXPIRED')) desc, coalesce(s.last_charge_at, s.start_date) desc nulls last
   limit 1
) s on true;

revoke all on crm.customer_features from public, anon, authenticated;
grant select on crm.customer_features to service_role;

create function crm.features(p_customer uuid) returns jsonb
language sql stable as $$
  select to_jsonb(f) from crm.customer_features f where f.customer_id = p_customer
$$;

-- ---------------------------------------------------------------------
-- RULE LANGUAGE
--   {"all": [rule...]} | {"any": [rule...]} | {"not": rule}
--   {"field": "<customer_features column>", "op": "=", "value": ...}
--   ops: = != > >= < <= in not_in contains is_null is_not_null is_true is_false
-- ---------------------------------------------------------------------

create function crm.rule_fields() returns text[]
language sql stable as $$
  select array_agg(attname::text) from pg_attribute
   where attrelid = 'crm.customer_features'::regclass and attnum > 0 and not attisdropped
$$;

create function crm.validate_rule(p_rule jsonb) returns void
language plpgsql stable as $$
declare r jsonb; op text;
begin
  if p_rule is null or p_rule = '{}'::jsonb then return; end if;
  if jsonb_typeof(p_rule) <> 'object' then raise exception 'invalid rule: %', p_rule; end if;
  if p_rule ? 'all' or p_rule ? 'any' then
    for r in select * from jsonb_array_elements(coalesce(p_rule -> 'all', p_rule -> 'any')) loop
      perform crm.validate_rule(r);
    end loop;
  elsif p_rule ? 'not' then
    perform crm.validate_rule(p_rule -> 'not');
  elsif p_rule ? 'field' then
    if not (p_rule ->> 'field') = any (crm.rule_fields()) then
      raise exception 'unknown rule field "%" (allowed: %)', p_rule ->> 'field', array_to_string(crm.rule_fields(), ', ');
    end if;
    op := coalesce(p_rule ->> 'op', '=');
    if op not in ('=','!=','>','>=','<','<=','in','not_in','contains','is_null','is_not_null','is_true','is_false') then
      raise exception 'unknown rule operator "%"', op;
    end if;
    if op in ('in','not_in') and jsonb_typeof(p_rule -> 'value') <> 'array' then
      raise exception 'operator % needs an array value', op;
    end if;
  else
    raise exception 'invalid rule: %', p_rule;
  end if;
end;
$$;

create function crm.eval_rule(p_rule jsonb, f jsonb) returns boolean
language plpgsql stable as $$
declare
  r jsonb;
  op text;
  v jsonb;
  x jsonb;
begin
  if p_rule is null or p_rule = '{}'::jsonb then return true; end if;
  if p_rule ? 'all' then
    for r in select * from jsonb_array_elements(p_rule -> 'all') loop
      if not crm.eval_rule(r, f) then return false; end if;
    end loop;
    return true;
  elsif p_rule ? 'any' then
    for r in select * from jsonb_array_elements(p_rule -> 'any') loop
      if crm.eval_rule(r, f) then return true; end if;
    end loop;
    return false;
  elsif p_rule ? 'not' then
    return not crm.eval_rule(p_rule -> 'not', f);
  end if;

  op := coalesce(p_rule ->> 'op', '=');
  v := p_rule -> 'value';
  x := f -> (p_rule ->> 'field');
  if x is null then x := 'null'::jsonb; end if;

  if op = 'is_null' then return x = 'null'::jsonb; end if;
  if op = 'is_not_null' then return x <> 'null'::jsonb; end if;
  if op = 'is_true' then return x = 'true'::jsonb; end if;
  if op = 'is_false' then return x = 'false'::jsonb; end if;
  if x = 'null'::jsonb then return false; end if;  -- unknown never matches a comparison

  if op = 'contains' then
    return jsonb_typeof(x) = 'array' and x @> jsonb_build_array(v);
  elsif op = 'in' then
    return exists (select 1 from jsonb_array_elements(v) e where e #>> '{}' = x #>> '{}');
  elsif op = 'not_in' then
    return not exists (select 1 from jsonb_array_elements(v) e where e #>> '{}' = x #>> '{}');
  end if;

  if jsonb_typeof(v) = 'number' and jsonb_typeof(x) = 'number' then
    return case op
      when '=' then x::numeric = v::numeric when '!=' then x::numeric <> v::numeric
      when '>' then x::numeric > v::numeric when '>=' then x::numeric >= v::numeric
      when '<' then x::numeric < v::numeric when '<=' then x::numeric <= v::numeric end;
  end if;
  return case op
    when '=' then x #>> '{}' = v #>> '{}' when '!=' then x #>> '{}' <> v #>> '{}'
    when '>' then x #>> '{}' > v #>> '{}' when '>=' then x #>> '{}' >= v #>> '{}'
    when '<' then x #>> '{}' < v #>> '{}' when '<=' then x #>> '{}' <= v #>> '{}' end;
end;
$$;

-- ---------------------------------------------------------------------
-- SEGMENTS
-- ---------------------------------------------------------------------

create table crm.segments (
  segment_id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  category text,
  description text,
  definition jsonb not null,
  is_system boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table crm.segment_members (
  segment_id uuid not null references crm.segments(segment_id) on delete cascade,
  customer_id uuid not null references crm.customers(customer_id),
  since timestamptz not null default now(),
  primary key (segment_id, customer_id)
);
create index segment_members_customer_idx on crm.segment_members (customer_id);

create function crm.check_rule_column() returns trigger
language plpgsql as $$
begin
  perform crm.validate_rule(to_jsonb(new) -> tg_argv[0]);
  return new;
end;
$$;

create trigger segments_validate before insert or update of definition on crm.segments
for each row execute function crm.check_rule_column('definition');

create trigger segments_audit after update on crm.segments
for each row execute function crm.audit_changes('key', 'definition', 'active', 'name');

-- Membership for one customer across all segments; entering/leaving is a fact.
create function crm.refresh_customer_segments(p_customer uuid) returns void
language plpgsql as $$
declare
  f jsonb := crm.features(p_customer);
  s record;
  v_in boolean;
  v_was boolean;
begin
  if f is null then return; end if;
  for s in select segment_id, key, definition, active from crm.segments loop
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

-- Rebuild one segment for everyone (after its definition changes). Membership
-- changes from a rebuild are not facts: they are re-definitions, not customer behavior.
create function crm.rebuild_segment(p_segment uuid) returns int
language plpgsql as $$
declare v_count int;
begin
  delete from crm.segment_members where segment_id = p_segment;
  insert into crm.segment_members (segment_id, customer_id)
  select s.segment_id, f.customer_id
    from crm.segments s, crm.customer_features f
   where s.segment_id = p_segment and s.active and crm.eval_rule(s.definition, to_jsonb(f));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function crm.on_segment_change() returns trigger
language plpgsql as $$
begin
  perform crm.rebuild_segment(new.segment_id);
  return null;
end;
$$;

create trigger segments_rebuild after insert or update of definition, active on crm.segments
for each row execute function crm.on_segment_change();

-- Segment refresh joins the per-customer refresh.
alter function crm.refresh_customer(uuid) rename to refresh_customer_state;

create function crm.refresh_customer(p_customer uuid) returns void
language plpgsql as $$
begin
  perform crm.refresh_customer_state(p_customer);
  perform crm.refresh_customer_segments(p_customer);
end;
$$;

-- System segments (spec section 51). "organic" requires explicit organic/direct
-- evidence: a customer with no attribution is unknown, not organic.
insert into crm.segments (key, name, category, definition, is_system, description) values
  ('customer_new', 'Clientes novos', 'customer',
   '{"all":[{"field":"paid_orders","op":">=","value":1},{"field":"days_since_first_seen","op":"<=","value":30}]}', true, 'Primeira interação há até 30 dias e já comprou'),
  ('customer_active', 'Clientes ativos', 'customer',
   '{"any":[{"field":"has_active_subscription","op":"is_true"},{"all":[{"field":"paid_orders","op":">=","value":1},{"field":"days_since_last_purchase","op":"<=","value":90}]}]}', true, null),
  ('customer_churned', 'Clientes perdidos', 'customer',
   '{"any":[{"field":"lifecycle","op":"in","value":["CHURNED","CANCELLED"]},{"field":"customer_type","op":"in","value":["CHURNED_CUSTOMER","FORMER_SUBSCRIBER"]}]}', true, null),
  ('customer_reactivated', 'Clientes reativados', 'customer',
   '{"any":[{"field":"customer_type","op":"=","value":"REACTIVATED_CUSTOMER"},{"field":"lifecycle","op":"=","value":"REACTIVATED"}]}', true, null),
  ('value_high', 'Alto valor', 'revenue', '{"field":"value_tier","op":"=","value":"high"}', true, null),
  ('value_medium', 'Valor médio', 'revenue', '{"field":"value_tier","op":"=","value":"medium"}', true, null),
  ('value_low', 'Baixo valor', 'revenue', '{"field":"value_tier","op":"=","value":"low"}', true, null),
  ('subscription_active', 'Assinatura ativa', 'subscription', '{"field":"has_active_subscription","op":"is_true"}', true, null),
  ('subscription_late', 'Assinatura atrasada', 'subscription',
   '{"all":[{"field":"has_active_subscription","op":"is_true"},{"field":"subscription_payment_state","op":"in","value":["LATE","FAILED","DUE"]}]}', true, null),
  ('subscription_expiring', 'Assinatura expirando', 'subscription', '{"field":"subscription_lifecycle","op":"=","value":"EXPIRING"}', true, null),
  ('subscription_cancelled', 'Assinatura cancelada', 'subscription',
   '{"field":"subscription_status","op":"in","value":["CANCELLED","INACTIVE","EXPIRED"]}', true, null),
  ('product_subscription', 'Compra assinatura', 'product', '{"field":"subscription_status","op":"is_not_null"}', true, null),
  ('product_one_shot', 'Compra avulsa', 'product',
   '{"all":[{"field":"paid_orders","op":">=","value":1},{"field":"subscription_status","op":"is_null"}]}', true, null),
  ('acq_facebook', 'Aquisição Facebook', 'acquisition', '{"field":"acquisition_source","op":"in","value":["facebook","fb","meta"]}', true, null),
  ('acq_instagram', 'Aquisição Instagram', 'acquisition', '{"field":"acquisition_source","op":"in","value":["instagram","ig"]}', true, null),
  ('acq_affiliate', 'Aquisição por afiliado', 'acquisition', '{"field":"has_affiliate","op":"is_true"}', true, null),
  ('acq_organic', 'Aquisição orgânica', 'acquisition', '{"field":"acquisition_source","op":"in","value":["organic","organico","direct","(direct)"]}', true, 'Só com evidência explícita de origem orgânica/direta'),
  ('behavior_one_time', 'Comprou uma vez', 'behavior', '{"field":"paid_orders","op":"=","value":1}', true, null),
  ('behavior_repeat', 'Recompra', 'behavior', '{"field":"paid_orders","op":">=","value":2}', true, null),
  ('behavior_high_frequency', 'Alta frequência', 'behavior', '{"field":"paid_orders_90d","op":">=","value":3}', true, null),
  ('behavior_at_risk', 'Em risco', 'behavior',
   '{"field":"risk","op":"in","value":["AT_RISK","PAYMENT_RISK","CHURN_RISK","HIGH_VALUE_AT_RISK"]}', true, null);

-- ---------------------------------------------------------------------
-- AUTOMATIONS
-- ---------------------------------------------------------------------

create table crm.automations (
  automation_id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  trigger_fact text not null,                     -- customer_events.fact_type
  trigger_filter jsonb not null default '{}',     -- must be contained in the fact data
  conditions jsonb not null default '{}',         -- rule over customer_features, checked at execution
  action_type text not null default 'message' check (action_type in ('message','internal_alert')),
  action_config jsonb not null default '{}',      -- {channel, template, message}
  delay_minutes int not null default 0 check (delay_minutes >= 0),
  cooldown_hours int not null default 24 check (cooldown_hours >= 0),
  max_trigger_age_hours int not null default 72,  -- old facts (e.g. backfill) never trigger actions
  priority int not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger automations_validate before insert or update of conditions on crm.automations
for each row execute function crm.check_rule_column('conditions');

create trigger automations_audit after update on crm.automations
for each row execute function crm.audit_changes('key', 'active', 'conditions', 'trigger_fact', 'trigger_filter',
                                                 'action_config', 'delay_minutes', 'cooldown_hours');

create table crm.automation_runs (
  run_id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references crm.automations(automation_id),
  customer_id uuid not null references crm.customers(customer_id),
  trigger_event_id uuid not null references crm.customer_events(id),
  status text not null default 'QUEUED' check (status in (
    'QUEUED','PROCESSING','SENT','DRY_RUN','SKIPPED','FAILED','CANCELLED')),
  skip_reason text,
  scheduled_for timestamptz not null,
  attempts int not null default 0,
  executed_at timestamptz,
  channel text,
  rendered_message text,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (automation_id, trigger_event_id)       -- one run per automation per fact, ever
);
create index automation_runs_due_idx on crm.automation_runs (status, scheduled_for);
create index automation_runs_customer_idx on crm.automation_runs (customer_id, executed_at);

create trigger automation_runs_audit after update on crm.automation_runs
for each row execute function crm.audit_changes('run_id', 'status');

-- New fact → queue matching automations (inside the same transaction as the fact).
create function crm.match_automations() returns trigger
language plpgsql as $$
begin
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

create trigger customer_events_automations after insert on crm.customer_events
for each row execute function crm.match_automations();

-- Worker side: claim due runs. Conditions are re-checked on the customer's
-- CURRENT state (e.g. an abandoned-cart message is skipped if they already
-- bought), then cooldown and the daily cap. Only runs that pass are returned.
create function crm.claim_automation_runs(p_limit int default 50)
returns table (run_id uuid, automation_key text, action_type text, action_config jsonb,
               customer jsonb, trigger jsonb)
language plpgsql as $$
#variable_conflict use_column
declare
  r record;
  f jsonb;
  v_reason text;
  v_cap int := coalesce(crm.setting_num('max_actions_per_customer_per_day'), 3)::int;
begin
  for r in
    select ar.run_id, ar.customer_id, ar.automation_id, ar.trigger_event_id, a.key, a.conditions,
           a.cooldown_hours, a.action_type, a.action_config, a.active
      from crm.automation_runs ar join crm.automations a using (automation_id)
     where ar.status = 'QUEUED' and ar.scheduled_for <= now()
        or (ar.status = 'PROCESSING' and ar.updated_at < now() - interval '15 minutes')
     order by a.priority, ar.scheduled_for
     for update of ar skip locked
     limit greatest(p_limit, 1)
  loop
    f := crm.features(r.customer_id);
    v_reason := case
      when not r.active then 'automation_inactive'
      when not crm.eval_rule(r.conditions, f) then 'conditions_not_met'
      when exists (select 1 from crm.automation_runs x
                    where x.automation_id = r.automation_id and x.customer_id = r.customer_id
                      and x.run_id <> r.run_id and x.status in ('SENT','DRY_RUN','PROCESSING')
                      and coalesce(x.executed_at, x.updated_at) > now() - make_interval(hours => r.cooldown_hours))
        then 'cooldown'
      -- In-flight runs (PROCESSING, possibly claimed in this same batch) count toward the cap.
      when (select count(*) from crm.automation_runs x
             where x.customer_id = r.customer_id and x.run_id <> r.run_id
               and x.status in ('SENT','DRY_RUN','PROCESSING')
               and coalesce(x.executed_at, x.updated_at) > now() - interval '24 hours') >= v_cap
        then 'daily_cap'
    end;

    if v_reason is not null then
      update crm.automation_runs set status = 'SKIPPED', skip_reason = v_reason, executed_at = now(), updated_at = now()
       where run_id = r.run_id;
      continue;
    end if;

    update crm.automation_runs set status = 'PROCESSING', attempts = attempts + 1, updated_at = now()
     where run_id = r.run_id;

    return query
      select r.run_id, r.key, r.action_type, r.action_config,
             jsonb_build_object(
               'customer_id', c.customer_id, 'full_name', c.full_name,
               'first_name', split_part(coalesce(c.full_name, ''), ' ', 1),
               'email', c.email, 'whatsapp', coalesce(c.whatsapp, c.phone),
               'lifecycle', c.current_lifecycle_stage, 'risk', c.current_risk_state,
               'customer_type', c.current_customer_type, 'net_ltv', c.net_ltv) || coalesce(f, '{}'),
             (select jsonb_build_object('fact_type', e.fact_type, 'occurred_at', e.occurred_at, 'sale_id', e.sale_id,
                                        'subscription_id', e.subscription_id, 'data', e.data)
                from crm.customer_events e where e.id = r.trigger_event_id)
        from crm.customers c where c.customer_id = r.customer_id;
  end loop;
end;
$$;

create function crm.complete_automation_run(p_run uuid, p_status text, p_channel text, p_message text,
                                            p_result jsonb, p_error text)
returns text language plpgsql as $$
declare v_attempts int; v_status text := p_status;
begin
  if p_status not in ('SENT','DRY_RUN','FAILED','SKIPPED') then
    raise exception 'invalid run status %', p_status;
  end if;
  select attempts into v_attempts from crm.automation_runs where run_id = p_run;
  -- Delivery failures retry with backoff (2, 4, 8, 16 min), then stay FAILED.
  if p_status = 'FAILED' and v_attempts < 5 then
    update crm.automation_runs set
      status = 'QUEUED', scheduled_for = now() + make_interval(mins => power(2, v_attempts)::int),
      error = p_error, channel = p_channel, rendered_message = p_message, updated_at = now()
    where run_id = p_run;
    return 'QUEUED';
  end if;
  update crm.automation_runs set
    status = v_status, executed_at = now(), channel = p_channel, rendered_message = p_message,
    result = p_result, error = p_error, skip_reason = case when v_status = 'SKIPPED' then coalesce(p_error, skip_reason) end,
    updated_at = now()
  where run_id = p_run;
  return v_status;
end;
$$;

-- Starter automations (spec sections 49–50). Messages are drafts to review
-- before a real channel is connected.
insert into crm.automations (key, name, trigger_fact, trigger_filter, conditions, action_type, action_config, delay_minutes, cooldown_hours, priority) values
  ('onboarding_purchase', 'Onboarding pós-compra', 'PURCHASE_PAID', '{}', '{}', 'message',
   '{"channel":"whatsapp","template":"onboarding_purchase","message":"Oi {{first_name}}! Seu pedido foi confirmado. Assim que for postado, mandamos o rastreio por aqui."}', 0, 24, 100),
  ('checkout_recovery', 'Recuperação de checkout abandonado', 'CHECKOUT_ABANDONED', '{}',
   '{"field":"lifecycle","op":"=","value":"CHECKOUT_STARTED"}', 'message',
   '{"channel":"whatsapp","template":"checkout_recovery_1","message":"Oi {{first_name}}, vi que você não finalizou seu pedido. Posso ajudar com alguma dúvida?"}', 60, 24, 50),
  ('pix_reminder', 'Lembrete de PIX pendente', 'PAYMENT_PENDING', '{"method":"pix"}',
   '{"field":"lifecycle","op":"=","value":"CHECKOUT_STARTED"}', 'message',
   '{"channel":"whatsapp","template":"pix_reminder","message":"Oi {{first_name}}, seu PIX está aguardando pagamento. Se precisar, gero um novo para você."}', 30, 12, 40),
  ('payment_recovery', 'Recuperação de pagamento atrasado', 'SUBSCRIPTION_PAYMENT_LATE', '{}',
   '{"all":[{"field":"subscription_payment_state","op":"in","value":["LATE","FAILED"]},{"field":"net_ltv","op":"<","value":500}]}', 'message',
   '{"channel":"whatsapp","template":"payment_recovery","message":"Oi {{first_name}}, não conseguimos confirmar o pagamento da sua assinatura. Quer que eu envie um novo link?"}', 0, 48, 30),
  ('high_value_recovery', 'Recuperação de alto valor', 'SUBSCRIPTION_PAYMENT_LATE', '{}',
   '{"all":[{"field":"subscription_payment_state","op":"in","value":["LATE","FAILED"]},{"field":"net_ltv","op":">=","value":500}]}', 'internal_alert',
   '{"channel":"team","template":"high_value_recovery","message":"Cliente de alto valor com pagamento atrasado: {{full_name}} (LTV líquido R$ {{net_ltv}}). Contato pessoal recomendado."}', 0, 48, 10),
  ('renewal_reminder', 'Lembrete de renovação', 'SUBSCRIPTION_EXPIRING_SOON', '{}',
   '{"all":[{"field":"cancellation_requested","op":"is_false"},{"field":"has_active_subscription","op":"is_true"}]}', 'message',
   '{"channel":"whatsapp","template":"renewal_reminder","message":"Oi {{first_name}}, sua próxima entrega está chegando! A renovação acontece em breve."}', 0, 72, 60),
  ('retention_offer', 'Oferta de retenção (ciclo ≥ 3)', 'SUBSCRIPTION_CANCELLATION_REQUESTED', '{}',
   '{"all":[{"field":"cancellation_requested","op":"is_true"},{"field":"subscription_cycle","op":">=","value":3}]}', 'message',
   '{"channel":"whatsapp","template":"retention_offer","message":"Oi {{first_name}}, você está com a gente há {{subscription_cycle}} ciclos. Antes de cancelar, temos uma condição especial para você."}', 0, 168, 20),
  ('retention_journey', 'Jornada de retenção', 'SUBSCRIPTION_CANCELLATION_REQUESTED', '{}',
   '{"all":[{"field":"cancellation_requested","op":"is_true"},{"field":"subscription_cycle","op":"<","value":3}]}', 'message',
   '{"channel":"whatsapp","template":"retention_journey","message":"Oi {{first_name}}, recebemos seu pedido de cancelamento. Posso entender o que aconteceu?"}', 0, 168, 20),
  ('loyalty_renewed', 'Reforço de hábito pós-renovação', 'SUBSCRIPTION_RENEWED', '{}', '{}', 'message',
   '{"channel":"whatsapp","template":"loyalty_renewed","message":"{{first_name}}, assinatura renovada! Obrigado por seguir com a gente."}', 0, 24, 90),
  ('product_onboarding', 'Onboarding do produto (entregue)', 'FULFILLMENT_DELIVERED', '{}', '{}', 'message',
   '{"channel":"whatsapp","template":"product_onboarding","message":"Oi {{first_name}}, seu pedido chegou! Aqui vão dicas para aproveitar melhor o produto."}', 120, 24, 80),
  ('high_value_risk_alert', 'Alerta: cliente de alto valor em risco', 'RISK_CHANGED', '{"to":"HIGH_VALUE_AT_RISK"}', '{}', 'internal_alert',
   '{"channel":"team","template":"high_value_risk_alert","message":"{{full_name}} virou HIGH_VALUE_AT_RISK (LTV líquido R$ {{net_ltv}})."}', 0, 72, 5);

-- ---------------------------------------------------------------------
-- CUSTOMER 360: fill segments, automations and communications.
-- ---------------------------------------------------------------------

alter function crm.customer_360(uuid) rename to customer_360_base;

create function crm.customer_360(p_customer uuid) returns jsonb
language sql stable as $$
  select case when b is null then null else
    jsonb_set(jsonb_set(jsonb_set(b,
      '{crm,segments}', (select coalesce(jsonb_agg(jsonb_build_object('key', s.key, 'name', s.name, 'category', s.category,
                                                                       'since', m.since) order by s.category, s.key), '[]')
                           from crm.segment_members m join crm.segments s using (segment_id)
                          where m.customer_id = p_customer)),
      '{crm,automations}', (select coalesce(jsonb_agg(jsonb_build_object('automation', a.key, 'name', a.name,
                                'status', r.status, 'skip_reason', r.skip_reason, 'scheduled_for', r.scheduled_for,
                                'executed_at', r.executed_at) order by r.created_at desc), '[]')
                              from crm.automation_runs r join crm.automations a using (automation_id)
                             where r.customer_id = p_customer)),
      '{crm,communications}', (select coalesce(jsonb_agg(jsonb_build_object('automation', a.key, 'channel', r.channel,
                                   'message', r.rendered_message, 'status', r.status, 'sent_at', r.executed_at)
                                   order by r.executed_at desc), '[]')
                                 from crm.automation_runs r join crm.automations a using (automation_id)
                                where r.customer_id = p_customer and r.status in ('SENT','DRY_RUN')))
  end
  from (select crm.customer_360_base(p_customer) as b) x
$$;

-- ---------------------------------------------------------------------
-- SECURITY + PUBLIC ENTRY POINTS
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['segments','segment_members','automations','automation_runs'] loop
    execute format('alter table crm.%I enable row level security', t);
    execute format('revoke all on crm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update on crm.%I to service_role', t);
  end loop;
end;
$$;

create function public.crm_claim_automation_runs(p_limit int default 50)
returns table (run_id uuid, automation_key text, action_type text, action_config jsonb, customer jsonb, trigger jsonb)
language sql security definer set search_path = crm, public, extensions as $$
  select * from crm.claim_automation_runs(p_limit)
$$;

create function public.crm_complete_automation_run(p_run_id uuid, p_status text, p_channel text default null,
                                                   p_message text default null, p_result jsonb default null,
                                                   p_error text default null)
returns text language sql security definer set search_path = crm, public, extensions as $$
  select crm.complete_automation_run(p_run_id, p_status, p_channel, p_message, p_result, p_error)
$$;

create function public.crm_list_segments()
returns table (key text, name text, category text, description text, active boolean, is_system boolean,
               definition jsonb, members bigint)
language sql stable security definer set search_path = crm, public, extensions as $$
  select s.key, s.name, s.category, s.description, s.active, s.is_system, s.definition,
         (select count(*) from crm.segment_members m where m.segment_id = s.segment_id)
    from crm.segments s order by s.category, s.key
$$;

create function public.crm_upsert_segment(p_key text, p_name text, p_definition jsonb, p_category text default 'custom',
                                          p_description text default null, p_active boolean default true)
returns bigint language plpgsql security definer set search_path = crm, public, extensions as $$
declare v_id uuid;
begin
  insert into crm.segments (key, name, category, description, definition, active)
  values (p_key, p_name, p_category, p_description, p_definition, p_active)
  on conflict (key) do update set name = excluded.name, category = excluded.category, description = excluded.description,
    definition = excluded.definition, active = excluded.active, updated_at = now()
  returning segment_id into v_id;
  return (select count(*) from crm.segment_members where segment_id = v_id);
end;
$$;

create function public.crm_list_automations()
returns table (key text, name text, trigger_fact text, active boolean, delay_minutes int, cooldown_hours int,
               queued bigint, sent bigint, dry_run bigint, skipped bigint, failed bigint)
language sql stable security definer set search_path = crm, public, extensions as $$
  select a.key, a.name, a.trigger_fact, a.active, a.delay_minutes, a.cooldown_hours,
         count(*) filter (where r.status in ('QUEUED','PROCESSING')),
         count(*) filter (where r.status = 'SENT'),
         count(*) filter (where r.status = 'DRY_RUN'),
         count(*) filter (where r.status = 'SKIPPED'),
         count(*) filter (where r.status = 'FAILED')
    from crm.automations a left join crm.automation_runs r using (automation_id)
   group by a.automation_id order by a.priority, a.key
$$;

create function public.crm_set_automation_active(p_key text, p_active boolean) returns boolean
language sql security definer set search_path = crm, public, extensions as $$
  update crm.automations set active = p_active, updated_at = now() where key = p_key returning active
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_claim_automation_runs(int)',
    'crm_complete_automation_run(uuid,text,text,text,jsonb,text)',
    'crm_list_segments()',
    'crm_upsert_segment(text,text,jsonb,text,text,boolean)',
    'crm_list_automations()',
    'crm_set_automation_active(text,boolean)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
