-- =====================================================================
-- KAKAUMA CRM — management: automation editor, rule preview, segment
-- deletion, single-event reprocessing, users and audit log screens.
-- =====================================================================

-- Facts the engine emits (valid automation triggers).
create function crm.trigger_facts() returns text[]
language sql immutable as $$
  select array[
    'CHECKOUT_ABANDONED','PAYMENT_PENDING','PURCHASE_PAID','RENEWAL_PAID','PAYMENT_FAILED',
    'REFUND_ISSUED','CHARGEBACK_RECEIVED',
    'SUBSCRIPTION_CREATED','SUBSCRIPTION_RENEWED','SUBSCRIPTION_PAYMENT_LATE','SUBSCRIPTION_PAYMENT_RECOVERED',
    'SUBSCRIPTION_CANCELLATION_REQUESTED','SUBSCRIPTION_CANCELLED','SUBSCRIPTION_SAVED','SUBSCRIPTION_EXPIRING_SOON',
    'SUBSCRIPTION_EXPIRED','SUBSCRIPTION_REACTIVATED',
    'FULFILLMENT_FULFILLMENT_CREATED','FULFILLMENT_SHIPPED','FULFILLMENT_IN_TRANSIT','FULFILLMENT_OUT_FOR_DELIVERY',
    'FULFILLMENT_DELIVERED','FULFILLMENT_DELIVERY_DELAYED','FULFILLMENT_DELIVERY_FAILED',
    'FULFILLMENT_DELIVERY_RETURNED','FULFILLMENT_DELIVERY_LOST',
    'LIFECYCLE_CHANGED','RISK_CHANGED','SEGMENT_ENTERED','SEGMENT_EXITED'
  ]
$$;

-- Creation of segments/automations also goes to the audit log.
create trigger segments_audit_insert after insert on crm.segments
for each row execute function crm.audit_insert('key', 'name');
create trigger automations_audit_insert after insert on crm.automations
for each row execute function crm.audit_insert('key', 'name');

-- ---------------------------------------------------------------------
-- Automations
-- ---------------------------------------------------------------------

drop function public.crm_list_automations();
create function public.crm_list_automations()
returns table (key text, name text, description text, trigger_fact text, trigger_filter jsonb, conditions jsonb,
               action_type text, action_config jsonb, delay_minutes int, cooldown_hours int,
               max_trigger_age_hours int, priority int, active boolean,
               queued bigint, sent bigint, dry_run bigint, skipped bigint, failed bigint)
language sql stable security definer set search_path = crm, public, extensions as $$
  select a.key, a.name, a.description, a.trigger_fact, a.trigger_filter, a.conditions, a.action_type, a.action_config,
         a.delay_minutes, a.cooldown_hours, a.max_trigger_age_hours, a.priority, a.active,
         count(r.*) filter (where r.status in ('QUEUED','PROCESSING')),
         count(r.*) filter (where r.status = 'SENT'),
         count(r.*) filter (where r.status = 'DRY_RUN'),
         count(r.*) filter (where r.status = 'SKIPPED'),
         count(r.*) filter (where r.status = 'FAILED')
    from crm.automations a left join crm.automation_runs r using (automation_id)
   group by a.automation_id order by a.priority, a.key
$$;

create function public.crm_upsert_automation(
  p_key text, p_name text, p_trigger_fact text, p_conditions jsonb, p_action_config jsonb,
  p_action_type text default 'message', p_trigger_filter jsonb default '{}', p_description text default null,
  p_delay_minutes int default 0, p_cooldown_hours int default 24, p_max_trigger_age_hours int default 72,
  p_priority int default 100, p_active boolean default true, p_actor text default null
) returns text
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  if p_key !~ '^[a-z0-9_]{3,60}$' then
    raise exception 'automation key must be 3-60 chars of a-z, 0-9 or _';
  end if;
  if nullif(btrim(p_name), '') is null then raise exception 'name is required'; end if;
  if not p_trigger_fact = any (crm.trigger_facts()) then
    raise exception 'unknown trigger "%"', p_trigger_fact;
  end if;
  if p_action_type not in ('message','internal_alert') then raise exception 'invalid action type'; end if;
  if coalesce(p_action_config ->> 'channel', '') not in ('whatsapp','email','team') then
    raise exception 'channel must be whatsapp, email or team';
  end if;
  if nullif(btrim(p_action_config ->> 'message'), '') is null then raise exception 'message is required'; end if;
  if jsonb_typeof(coalesce(p_trigger_filter, '{}')) <> 'object' then raise exception 'trigger filter must be an object'; end if;
  if p_delay_minutes < 0 or p_cooldown_hours < 0 or p_max_trigger_age_hours < 1 then
    raise exception 'delay/cooldown must be >= 0 and max trigger age >= 1';
  end if;

  insert into crm.automations (key, name, description, trigger_fact, trigger_filter, conditions, action_type, action_config,
                               delay_minutes, cooldown_hours, max_trigger_age_hours, priority, active)
  values (p_key, p_name, p_description, p_trigger_fact, coalesce(p_trigger_filter, '{}'), coalesce(p_conditions, '{}'),
          p_action_type, p_action_config, p_delay_minutes, p_cooldown_hours, p_max_trigger_age_hours, p_priority, p_active)
  on conflict (key) do update set
    name = excluded.name, description = excluded.description, trigger_fact = excluded.trigger_fact,
    trigger_filter = excluded.trigger_filter, conditions = excluded.conditions, action_type = excluded.action_type,
    action_config = excluded.action_config, delay_minutes = excluded.delay_minutes,
    cooldown_hours = excluded.cooldown_hours, max_trigger_age_hours = excluded.max_trigger_age_hours,
    priority = excluded.priority, active = excluded.active, updated_at = now();
  return p_key;
end;
$$;

create function public.crm_trigger_facts() returns text[]
language sql stable security definer set search_path = crm, public, extensions as $$
  select crm.trigger_facts()
$$;

-- How many customers a rule matches right now (+ a small sample), for previews.
create function public.crm_preview_rule(p_rule jsonb, p_limit int default 5) returns jsonb
language plpgsql stable security definer set search_path = crm, public, extensions as $$
declare v jsonb;
begin
  perform crm.validate_rule(p_rule);
  with m as (
    select f.customer_id from crm.customer_features f where crm.eval_rule(p_rule, to_jsonb(f))
  )
  select jsonb_build_object(
    'matches', (select count(*) from m),
    'total', (select count(*) from crm.customers),
    'sample', (select coalesce(jsonb_agg(jsonb_build_object('customer_id', c.customer_id, 'full_name', c.full_name,
                                                            'email', c.email, 'net_ltv', c.net_ltv)), '[]')
                 from (select c.* from m join crm.customers c using (customer_id)
                        order by c.net_ltv desc limit least(greatest(p_limit, 0), 20)) c))
  into v;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- Segments
-- ---------------------------------------------------------------------

create function public.crm_delete_segment(p_key text, p_actor text default null) returns boolean
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  if exists (select 1 from crm.segments where key = p_key and is_system) then
    raise exception 'system segment "%" cannot be deleted', p_key;
  end if;
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  select 'segments', key, 'deleted', name, null, crm.current_actor() from crm.segments where key = p_key;
  delete from crm.segments where key = p_key;
  return found;
end;
$$;

-- ---------------------------------------------------------------------
-- Events: reprocess one
-- ---------------------------------------------------------------------

create function public.crm_requeue_event(p_event_id text, p_actor text default null) returns text
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v_id uuid;
begin
  perform crm.set_actor(p_actor);
  update crm.events set processing_status = 'RECEIVED', retry_count = 0, next_retry_at = null
   where event_id = p_event_id and processing_status in ('DEAD_LETTER','FAILED','IGNORED')
  returning id into v_id;
  if v_id is null then raise exception 'event % not found or not reprocessable', p_event_id; end if;
  update crm.dead_letter_events set resolved_at = now(), resolution = 'requeued by ' || crm.current_actor()
   where raw_event_id = v_id and resolved_at is null;
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('events', p_event_id, 'processing_status', null, 'RECEIVED', crm.current_actor());
  return p_event_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Users and audit log
-- ---------------------------------------------------------------------

create function public.crm_list_app_users()
returns table (user_id uuid, email text, role text, active boolean, created_at timestamptz, last_login_at timestamptz)
language sql stable security definer set search_path = crm, public, extensions as $$
  select user_id, email, role, active, created_at, last_login_at from crm.app_users order by created_at
$$;

create function public.crm_set_user_access(p_email text, p_role text, p_active boolean, p_actor text default null)
returns void language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  if p_role not in ('admin','operator','viewer') then raise exception 'invalid role'; end if;
  if (p_role <> 'admin' or not p_active)
     and exists (select 1 from crm.app_users where lower(email) = lower(p_email) and role = 'admin' and active)
     and (select count(*) from crm.app_users where role = 'admin' and active) <= 1 then
    raise exception 'the last active admin cannot be demoted or deactivated';
  end if;
  update crm.app_users set role = p_role, active = p_active where lower(email) = lower(p_email);
  if not found then raise exception 'user % not found', p_email; end if;
end;
$$;

create function public.crm_list_audit(p_entity text default null, p_limit int default 200)
returns table (id bigint, entity text, entity_id text, field text, old_value text, new_value text, actor text,
               changed_at timestamptz)
language sql stable security definer set search_path = crm, public, extensions as $$
  select id, entity, entity_id, field, old_value, new_value, actor, changed_at
    from crm.audit_logs
   where p_entity is null or entity = p_entity
   order by id desc
   limit least(greatest(p_limit, 1), 1000)
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_list_automations()',
    'crm_upsert_automation(text,text,text,jsonb,jsonb,text,jsonb,text,int,int,int,int,boolean,text)',
    'crm_trigger_facts()',
    'crm_preview_rule(jsonb,int)',
    'crm_delete_segment(text,text)',
    'crm_requeue_event(text,text)',
    'crm_list_app_users()',
    'crm_set_user_access(text,text,boolean,text)',
    'crm_list_audit(text,int)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
