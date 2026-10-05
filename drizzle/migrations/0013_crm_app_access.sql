-- =====================================================================
-- KAKAUMA CRM — phase 5: app access (RBAC) and functions for the UI
--
-- * crm.app_users maps Supabase Auth users to a CRM role (admin / operator / viewer).
-- * Mutating entry points take p_actor (the logged-in user's e-mail) so the
--   audit log records WHO changed segments, automations and settings.
-- * Read models the screens need: recovery queue, automation runs,
--   operations overview, settings, rule fields.
-- =====================================================================

create table crm.app_users (
  user_id uuid primary key,              -- auth.users.id of the Supabase project
  email text not null unique,
  role text not null default 'viewer' check (role in ('admin','operator','viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
alter table crm.app_users enable row level security;
revoke all on crm.app_users from public, anon, authenticated;
grant select, insert, update on crm.app_users to service_role;

create trigger app_users_audit after update on crm.app_users
for each row execute function crm.audit_changes('email', 'role', 'active');

create trigger settings_audit after update on crm.settings
for each row execute function crm.audit_changes('key', 'value');

create function crm.set_actor(p_actor text) returns void
language sql as $$
  select set_config('crm.actor', case when nullif(p_actor, '') is null then 'system' else 'user:' || p_actor end, true)
$$;

-- ---------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------

create function public.crm_user_role(p_user_id uuid, p_email text) returns text
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v_role text;
begin
  select role into v_role from crm.app_users where active and (user_id = p_user_id or lower(email) = lower(p_email))
   order by (user_id = p_user_id) desc limit 1;
  if v_role is not null then
    update crm.app_users set last_login_at = now() where user_id = p_user_id or lower(email) = lower(p_email);
  end if;
  return v_role;
end;
$$;

create function public.crm_grant_access(p_user_id uuid, p_email text, p_role text) returns void
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  insert into crm.app_users (user_id, email, role) values (p_user_id, lower(p_email), p_role)
  on conflict (user_id) do update set email = excluded.email, role = excluded.role, active = true;
end;
$$;

-- ---------------------------------------------------------------------
-- Mutations with actor (replace phase-3/4 signatures)
-- ---------------------------------------------------------------------

drop function public.crm_set_automation_active(text, boolean);
create function public.crm_set_automation_active(p_key text, p_active boolean, p_actor text default null) returns boolean
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v boolean;
begin
  perform crm.set_actor(p_actor);
  update crm.automations set active = p_active, updated_at = now() where key = p_key returning active into v;
  if v is null then raise exception 'unknown automation "%"', p_key; end if;
  return v;
end;
$$;

drop function public.crm_upsert_segment(text, text, jsonb, text, text, boolean);
create function public.crm_upsert_segment(p_key text, p_name text, p_definition jsonb, p_category text default 'custom',
                                          p_description text default null, p_active boolean default true,
                                          p_actor text default null)
returns bigint language plpgsql security definer set search_path = crm, public, extensions as $$
declare v_id uuid;
begin
  perform crm.set_actor(p_actor);
  if exists (select 1 from crm.segments where key = p_key and is_system) then
    raise exception 'system segment "%" cannot be edited; create a custom one', p_key;
  end if;
  if p_key !~ '^[a-z0-9_]{3,60}$' then
    raise exception 'segment key must be 3-60 chars of a-z, 0-9 or _';
  end if;
  insert into crm.segments (key, name, category, description, definition, active)
  values (p_key, p_name, coalesce(p_category, 'custom'), p_description, p_definition, p_active)
  on conflict (key) do update set name = excluded.name, category = excluded.category, description = excluded.description,
    definition = excluded.definition, active = excluded.active, updated_at = now()
  returning segment_id into v_id;
  return (select count(*) from crm.segment_members where segment_id = v_id);
end;
$$;

drop function public.crm_requeue_dead_letters(text);
create function public.crm_requeue_dead_letters(p_error_prefix text default null, p_actor text default null) returns int
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  return crm.requeue_dead_letters(p_error_prefix);
end;
$$;

create function public.crm_update_setting(p_key text, p_value jsonb, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v jsonb;
begin
  perform crm.set_actor(p_actor);
  if p_key = 'quality_weights' and jsonb_typeof(p_value) <> 'object' then
    raise exception 'quality_weights must be an object';
  elsif p_key not in ('quality_weights','value_tiers','report_timezone') and jsonb_typeof(p_value) <> 'number' then
    raise exception 'setting % must be a number', p_key;
  end if;
  update crm.settings set value = p_value, updated_at = now() where key = p_key returning value into v;
  if v is null then raise exception 'unknown setting "%"', p_key; end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- Read models for the screens
-- ---------------------------------------------------------------------

drop function public.crm_search_customers(text, text, text, text, int, int);
create function public.crm_search_customers(p_query text default null, p_lifecycle text default null,
                                            p_risk text default null, p_type text default null,
                                            p_limit int default 50, p_offset int default 0,
                                            p_segment text default null)
returns table (customer_id uuid, full_name text, email text, whatsapp text, customer_type text, lifecycle text,
               risk text, net_ltv numeric, last_purchase_at timestamptz, last_seen_at timestamptz)
language sql stable security definer set search_path = crm, public, extensions as $$
  select s.* from crm.search_customers(p_query, p_lifecycle, p_risk, p_type, 100000, 0) s
   where p_segment is null or exists (
     select 1 from crm.segment_members m join crm.segments g using (segment_id)
      where g.key = p_segment and m.customer_id = s.customer_id)
   order by s.last_seen_at desc nulls last
   limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0)
$$;

-- Who needs a recovery action now (only real, open situations).
create function public.crm_recovery_queue(p_limit int default 200)
returns table (kind text, customer_id uuid, full_name text, email text, whatsapp text, amount numeric,
               since timestamptz, detail text, net_ltv numeric, risk text)
language sql stable security definer set search_path = crm, public, extensions as $$
  select * from (
    -- abandoned checkouts not converted (last 30 days)
    select 'CHECKOUT_ABANDONED', c.customer_id, c.full_name, c.email, coalesce(c.whatsapp, c.phone),
           ck.amount, ck.abandoned_at, coalesce(p.name, o.name, ck.offer_id, ck.product_id), c.net_ltv, c.current_risk_state
      from crm.checkouts ck join crm.customers c using (customer_id)
      left join crm.products p on p.product_id = ck.product_id
      left join crm.offers o on o.offer_id = ck.offer_id
     where ck.status = 'ABANDONED' and ck.abandoned_at > now() - interval '30 days'
       and not exists (select 1 from crm.orders x where x.customer_id = ck.customer_id and x.paid_at > ck.abandoned_at)
    union all
    -- generated PIX / boleto still unpaid (last 7 days)
    select 'PAYMENT_PENDING', c.customer_id, c.full_name, c.email, coalesce(c.whatsapp, c.phone),
           t.amount, t.created_at, upper(t.payment_method), c.net_ltv, c.current_risk_state
      from crm.transactions t join crm.customers c using (customer_id)
     where t.status = 'PENDING' and t.created_at > now() - interval '7 days'
    union all
    -- subscriptions late / failed / due
    select 'SUBSCRIPTION_' || s.payment_state, c.customer_id, c.full_name, c.email, coalesce(c.whatsapp, c.phone),
           (select sc.amount from crm.subscription_charges sc where sc.subscription_id = s.subscription_id
             order by sc.cycle_number desc nulls last limit 1),
           coalesce(s.late_at, s.next_charge_at), coalesce(s.plan_name, s.subscription_id) || ' · ciclo ' || s.current_cycle,
           c.net_ltv, c.current_risk_state
      from crm.subscriptions s join crm.customers c using (customer_id)
     where s.status not in ('CANCELLED','INACTIVE','EXPIRED') and s.payment_state in ('LATE','FAILED','DUE')
    union all
    -- asked to cancel, still active
    select 'CANCELLATION_REQUESTED', c.customer_id, c.full_name, c.email, coalesce(c.whatsapp, c.phone),
           s.net_revenue, s.cancellation_requested_at, coalesce(s.plan_name, s.subscription_id) || ' · ciclo ' || s.current_cycle,
           c.net_ltv, c.current_risk_state
      from crm.subscriptions s join crm.customers c using (customer_id)
     where s.cancellation_requested and s.status not in ('CANCELLED','INACTIVE','EXPIRED')
  ) q (kind, customer_id, full_name, email, whatsapp, amount, since, detail, net_ltv, risk)
  order by since desc nulls last
  limit least(greatest(p_limit, 1), 1000)
$$;

create function public.crm_list_automation_runs(p_key text default null, p_status text default null, p_limit int default 100)
returns table (run_id uuid, automation text, automation_name text, customer_id uuid, customer_name text, status text,
               skip_reason text, channel text, message text, scheduled_for timestamptz, executed_at timestamptz, error text)
language sql stable security definer set search_path = crm, public, extensions as $$
  select r.run_id, a.key, a.name, r.customer_id, c.full_name, r.status, r.skip_reason, r.channel, r.rendered_message,
         r.scheduled_for, r.executed_at, r.error
    from crm.automation_runs r
    join crm.automations a using (automation_id)
    join crm.customers c on c.customer_id = r.customer_id
   where (p_key is null or a.key = p_key) and (p_status is null or r.status = p_status)
   order by coalesce(r.executed_at, r.scheduled_for) desc
   limit least(greatest(p_limit, 1), 500)
$$;

create function public.crm_ops_overview() returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select jsonb_build_object(
    'events', (select coalesce(jsonb_object_agg(processing_status, n), '{}') from (
                 select processing_status, count(*) n from crm.events group by 1) x),
    'last_event_at', (select max(received_at) from crm.events),
    'events_24h', (select count(*) from crm.events where received_at > now() - interval '24 hours'),
    'event_types', (select coalesce(jsonb_object_agg(coalesce(event_type, '(não processado)'), n), '{}') from (
                 select event_type, count(*) n from crm.events group by 1) x),
    'dead_letters', (select coalesce(jsonb_agg(jsonb_build_object(
                         'id', d.id, 'reason', d.reason, 'error', left(d.error, 300), 'created_at', d.created_at,
                         'event_name', e.event_name, 'event_id', e.event_id) order by d.created_at desc), '[]')
                       from (select * from crm.dead_letter_events where resolved_at is null order by created_at desc limit 50) d
                       left join crm.events e on e.id = d.raw_event_id),
    'dead_letters_open', (select count(*) from crm.dead_letter_events where resolved_at is null),
    'data_quality', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'count', n, 'last_at', last_at) order by n desc), '[]')
                       from (select code, count(*) n, max(created_at) last_at from crm.data_quality_issues
                              where resolved_at is null group by code) x),
    'automation_runs', (select coalesce(jsonb_object_agg(status, n), '{}') from (
                 select status, count(*) n from crm.automation_runs group by 1) x),
    'totals', jsonb_build_object(
       'customers', (select count(*) from crm.customers),
       'orders', (select count(*) from crm.orders),
       'subscriptions', (select count(*) from crm.subscriptions),
       'marketing_spend_rows', (select count(*) from crm.marketing_spend)))
$$;

create function public.crm_list_settings()
returns table (key text, value jsonb, description text, updated_at timestamptz)
language sql stable security definer set search_path = crm, public, extensions as $$
  select key, value, description, updated_at from crm.settings order by key
$$;

create function public.crm_rule_fields() returns text[]
language sql stable security definer set search_path = crm, public, extensions as $$
  select array(select unnest(crm.rule_fields()) order by 1)
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'crm_user_role(uuid,text)',
    'crm_grant_access(uuid,text,text)',
    'crm_set_automation_active(text,boolean,text)',
    'crm_upsert_segment(text,text,jsonb,text,text,boolean,text)',
    'crm_requeue_dead_letters(text,text)',
    'crm_update_setting(text,jsonb,text)',
    'crm_search_customers(text,text,text,text,int,int,text)',
    'crm_recovery_queue(int)',
    'crm_list_automation_runs(text,text,int)',
    'crm_ops_overview()',
    'crm_list_settings()',
    'crm_rule_fields()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
