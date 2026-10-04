-- =====================================================================
-- KAKAUMA CRM — phase 2: state engine
--
-- FACTS → STATE: lifecycle, risk, subscription quality, LTV and customer
-- experience are recomputed from stored facts (never incremented blindly),
-- after every event and periodically for time-based transitions
-- (e.g. a customer who stops buying drifts to CHURN_RISK, then CHURNED).
-- Thresholds live in crm.settings, not in code.
-- =====================================================================

-- ---------------------------------------------------------------------
-- SETTINGS
-- ---------------------------------------------------------------------

create table crm.settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);
alter table crm.settings enable row level security;
revoke all on crm.settings from public, anon, authenticated;
grant select, insert, update on crm.settings to service_role;

insert into crm.settings (key, value, description) values
  ('activity_window_days', '90', 'Dias sem comprar até um cliente avulso entrar em CHURN_RISK'),
  ('churn_after_days', '180', 'Dias sem comprar até um cliente avulso ser considerado CHURNED'),
  ('recent_days', '30', 'Janela de "recente": entrega recente, renovação/recuperação recente, problemas recentes'),
  ('high_value_net_ltv', '500', 'LTV líquido (R$) a partir do qual um cliente em risco vira HIGH_VALUE_AT_RISK'),
  ('due_grace_days', '1', 'Dias após next_charge sem pagamento até a assinatura ficar DUE'),
  ('quality_weights', '{
     "base": 50,
     "per_paid_cycle": 8, "max_cycles_bonus": 40,
     "per_late_event": -10, "max_late_penalty": -30,
     "per_failed_payment": -10, "max_failed_penalty": -30,
     "per_refund": -20, "max_refund_penalty": -40,
     "cancellation_requested": -15,
     "high_value_bonus": 10,
     "per_delivery_problem": -10, "max_delivery_penalty": -20,
     "high_quality_min": 70, "medium_quality_min": 40
   }', 'Pesos do Subscription Quality Score (0–100). Heurística inicial, ajustável.');

create function crm.setting_num(p_key text) returns numeric
language sql stable as $$
  select (value #>> '{}')::numeric from crm.settings where key = p_key
$$;

create function crm.weight(p_key text) returns numeric
language sql stable as $$
  select coalesce((value ->> p_key)::numeric, 0) from crm.settings where key = 'quality_weights'
$$;

-- ---------------------------------------------------------------------
-- NEW COLUMNS
-- ---------------------------------------------------------------------

alter table crm.customers
  add column total_affiliate_commissions numeric(14,2) not null default 0,
  add column gross_ltv numeric(14,2) not null default 0,
  add column net_ltv numeric(14,2) not null default 0,
  add column contribution_ltv numeric(14,2) not null default 0,
  add column lifecycle_changed_at timestamptz,
  add column risk_changed_at timestamptz,
  add column state_refreshed_at timestamptz;

create index customers_lifecycle_idx on crm.customers (current_lifecycle_stage);
create index customers_risk_idx on crm.customers (current_risk_state);
create index customers_refresh_idx on crm.customers (state_refreshed_at);

alter table crm.subscriptions
  add column quality_score int,
  add column quality_class text check (quality_class in ('HIGH_QUALITY','MEDIUM_QUALITY','LOW_QUALITY','AT_RISK','HIGH_VALUE_AT_RISK')),
  add column quality_factors jsonb,
  add column state_refreshed_at timestamptz;

-- Facts derived by the state engine (lifecycle/risk changes) have no raw event.
alter table crm.customer_events alter column raw_event_id drop not null;

-- ---------------------------------------------------------------------
-- SUBSCRIPTION STATE: payment due, risk, quality score
-- ---------------------------------------------------------------------

create function crm.risk_rank(s text) returns int
language sql immutable as $$
  select case s when 'HIGH_VALUE_AT_RISK' then 5 when 'CHURN_RISK' then 4 when 'PAYMENT_RISK' then 3
                when 'AT_RISK' then 2 when 'HEALTHY' then 1 else 0 end
$$;

create function crm.refresh_subscription(p_sub text) returns void
language plpgsql as $$
declare
  s crm.subscriptions;
  v_net numeric;
  v_recent interval := make_interval(days => crm.setting_num('recent_days')::int);
  v_cycles int; v_late int; v_failed int; v_renewals int; v_refunds int; v_cancel_req int; v_delivery int;
  v_score numeric; v_class text; v_risk text; v_payment text;
  v_ended boolean;
begin
  select * into s from crm.subscriptions where subscription_id = p_sub for update;
  if not found then return; end if;
  select net_ltv into v_net from crm.customers where customer_id = s.customer_id;
  v_ended := s.status in ('CANCELLED','INACTIVE','EXPIRED');

  -- Payment state: a charge date that passed without payment is DUE (never LATE
  -- or cancelled by inference — those need provider evidence).
  v_payment := s.payment_state;
  if not v_ended and v_payment in ('CURRENT','RECOVERED') and s.next_charge_at is not null
     and s.next_charge_at + make_interval(days => crm.setting_num('due_grace_days')::int) < now()
     and coalesce(s.last_charge_at, '-infinity'::timestamptz) < s.next_charge_at then
    v_payment := 'DUE';
  end if;

  -- Factors (all counted from facts).
  select count(*) into v_cycles from crm.subscription_charges where subscription_id = p_sub and paid_at is not null;
  select count(*) into v_late from crm.customer_events where subscription_id = p_sub and fact_type = 'SUBSCRIPTION_PAYMENT_LATE';
  select count(*) into v_failed from crm.financial_events where subscription_id = p_sub and event_type = 'PAYMENT_FAILED';
  select count(*) into v_renewals from crm.financial_events where subscription_id = p_sub and event_type = 'RENEWAL_PAYMENT';
  select count(*) into v_refunds from crm.refunds where subscription_id = p_sub;
  select count(*) into v_cancel_req from crm.customer_events where subscription_id = p_sub and fact_type = 'SUBSCRIPTION_CANCELLATION_REQUESTED';
  select count(*) into v_delivery from crm.fulfillments
   where customer_id = s.customer_id
     and status in ('DELIVERY_DELAYED','DELIVERY_FAILED','DELIVERY_RETURNED','DELIVERY_LOST');

  -- Risk (derived, not sticky).
  v_risk := case
    when v_ended then 'HEALTHY'
    when s.cancellation_requested then 'CHURN_RISK'
    when v_payment = 'FAILED' then 'PAYMENT_RISK'
    when v_payment in ('LATE','DUE') then 'AT_RISK'
    when exists (select 1 from crm.refunds r where r.subscription_id = p_sub and r.created_at > now() - v_recent) then 'AT_RISK'
    when exists (select 1 from crm.fulfillments f where f.customer_id = s.customer_id and f.updated_at > now() - v_recent
                   and f.status in ('DELIVERY_DELAYED','DELIVERY_FAILED','DELIVERY_RETURNED','DELIVERY_LOST')) then 'AT_RISK'
    else 'HEALTHY' end;
  if v_risk <> 'HEALTHY' and coalesce(v_net, 0) >= crm.setting_num('high_value_net_ltv') then
    v_risk := 'HIGH_VALUE_AT_RISK';
  end if;

  -- Quality score 0–100 (explainable: every factor is stored).
  v_score := crm.weight('base')
    + least(v_cycles * crm.weight('per_paid_cycle'), crm.weight('max_cycles_bonus'))
    + greatest(v_late * crm.weight('per_late_event'), crm.weight('max_late_penalty'))
    + greatest(v_failed * crm.weight('per_failed_payment'), crm.weight('max_failed_penalty'))
    + greatest(v_refunds * crm.weight('per_refund'), crm.weight('max_refund_penalty'))
    + case when v_cancel_req > 0 then crm.weight('cancellation_requested') else 0 end
    + case when coalesce(v_net, 0) >= crm.setting_num('high_value_net_ltv') then crm.weight('high_value_bonus') else 0 end
    + greatest(v_delivery * crm.weight('per_delivery_problem'), crm.weight('max_delivery_penalty'));
  v_score := greatest(0, least(100, v_score));

  v_class := case
    when v_risk = 'HIGH_VALUE_AT_RISK' then 'HIGH_VALUE_AT_RISK'
    when v_risk <> 'HEALTHY' then 'AT_RISK'
    when v_score >= crm.weight('high_quality_min') then 'HIGH_QUALITY'
    when v_score >= crm.weight('medium_quality_min') then 'MEDIUM_QUALITY'
    else 'LOW_QUALITY' end;

  update crm.subscriptions set
    payment_state = v_payment,
    risk_state = v_risk,
    quality_score = v_score::int,
    quality_class = v_class,
    quality_factors = jsonb_build_object(
      'cycles_paid', v_cycles, 'late_events', v_late, 'failed_payments', v_failed, 'renewals', v_renewals,
      'refunds', v_refunds, 'cancellation_requests', v_cancel_req, 'net_ltv', coalesce(v_net, 0),
      'delivery_problems', v_delivery,
      'acquisition_source', (select acquisition_source from crm.customers where customer_id = s.customer_id)),
    state_refreshed_at = now()
  where subscription_id = p_sub;  -- the audit trigger only records fields that actually changed
end;
$$;

-- ---------------------------------------------------------------------
-- CUSTOMER LIFECYCLE
-- ---------------------------------------------------------------------

create function crm.compute_customer_lifecycle(p_customer uuid) returns text
language plpgsql stable as $$
declare
  s crm.subscriptions;
  v_recent interval := make_interval(days => crm.setting_num('recent_days')::int);
  v_churn interval := make_interval(days => crm.setting_num('churn_after_days')::int);
  v_paid int;
  v_last_order crm.orders;
  v_ful crm.fulfillments;
begin
  -- Subscriber path: driven by the most relevant subscription (an active one first).
  select * into s from crm.subscriptions
   where customer_id = p_customer
   order by (status not in ('CANCELLED','INACTIVE','EXPIRED')) desc, coalesce(last_charge_at, start_date) desc nulls last
   limit 1;

  select * into v_last_order from crm.orders
   where customer_id = p_customer and paid_at is not null
   order by paid_at desc limit 1;

  if s.subscription_id is not null then
    if s.status not in ('CANCELLED','INACTIVE','EXPIRED') then
      return case
        when s.cancellation_requested then 'CANCELLATION_REQUESTED'
        when s.payment_state in ('LATE','FAILED') then 'LATE'
        when s.status = 'REACTIVATED' and s.reactivated_at > now() - v_recent then 'REACTIVATED'
        when s.lifecycle_state = 'EXPIRING' then 'EXPIRING'
        when s.payment_state = 'RECOVERED' and s.last_charge_at > now() - v_recent then 'RECOVERED'
        when s.lifecycle_state = 'RENEWED' and s.renewed_at > now() - v_recent then 'RENEWED'
        when s.current_cycle <= 1 then 'NEW_SUBSCRIBER'
        else 'ACTIVE_SUBSCRIBER' end;
    end if;
    -- Ended subscription: unless the customer bought again afterwards, that is the state.
    if v_last_order.order_id is null or v_last_order.paid_at <= coalesce(s.cancelled_at, s.expired_at, '-infinity'::timestamptz) then
      return case when s.status = 'EXPIRED' then 'CHURNED' else 'CANCELLED' end;
    end if;
  end if;

  -- Commerce path.
  select count(*) into v_paid from crm.orders where customer_id = p_customer and paid_at is not null;
  if v_paid = 0 then
    if exists (select 1 from crm.checkouts where customer_id = p_customer)
       or exists (select 1 from crm.transactions where customer_id = p_customer) then
      return 'CHECKOUT_STARTED';
    end if;
    if exists (select 1 from crm.attributions where customer_id = p_customer) then
      return 'PROSPECT';
    end if;
    return 'LEAD';
  end if;

  if v_last_order.paid_at < now() - v_churn then
    return 'CHURNED';
  end if;

  select * into v_ful from crm.fulfillments
   where order_id = v_last_order.order_id or (order_id is null and sale_id = v_last_order.sale_id)
   order by updated_at desc limit 1;

  return case
    when v_ful.status in ('FULFILLMENT_CREATED','SHIPPED','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_DELAYED','DELIVERY_FAILED') then 'DELIVERING'
    when v_paid >= 2 then 'REPEAT_CUSTOMER'
    when v_ful.status = 'DELIVERED' and v_ful.delivered_at > now() - v_recent then 'DELIVERED'
    when v_ful.status = 'DELIVERED' then 'ACTIVE_CUSTOMER'
    when v_ful.fulfillment_id is null and v_last_order.paid_at > now() - v_recent then 'PURCHASED'
    else 'ACTIVE_CUSTOMER' end;
end;
$$;

create function crm.compute_customer_risk(p_customer uuid, p_lifecycle text) returns text
language plpgsql stable as $$
declare
  v_recent interval := make_interval(days => crm.setting_num('recent_days')::int);
  v_window interval := make_interval(days => crm.setting_num('activity_window_days')::int);
  v_risk text;
  v_sub_risk text;
  v_last timestamptz;
  v_net numeric;
begin
  select risk_state into v_sub_risk from crm.subscriptions
   where customer_id = p_customer and status not in ('CANCELLED','INACTIVE','EXPIRED')
   order by crm.risk_rank(risk_state) desc limit 1;
  select last_purchase_at, net_ltv into v_last, v_net from crm.customers where customer_id = p_customer;

  v_risk := case
    when v_sub_risk is not null then v_sub_risk
    when p_lifecycle in ('CHURNED','CANCELLED') then 'CHURN_RISK'
    when v_last is not null and v_last < now() - v_window then 'CHURN_RISK'
    when exists (select 1 from crm.refunds r where r.customer_id = p_customer and r.created_at > now() - v_recent) then 'AT_RISK'
    when exists (select 1 from crm.fulfillments f where f.customer_id = p_customer and f.updated_at > now() - v_recent
                   and f.status in ('DELIVERY_DELAYED','DELIVERY_FAILED','DELIVERY_RETURNED','DELIVERY_LOST')) then 'AT_RISK'
    when v_last is null then null      -- never bought: no risk to speak of
    else 'HEALTHY' end;

  if v_risk in ('AT_RISK','PAYMENT_RISK','CHURN_RISK') and coalesce(v_net, 0) >= crm.setting_num('high_value_net_ltv') then
    v_risk := 'HIGH_VALUE_AT_RISK';
  end if;
  return v_risk;
end;
$$;

-- ---------------------------------------------------------------------
-- REFRESH (replaces phase-1 version): aggregates, LTV, type, lifecycle, risk
-- ---------------------------------------------------------------------

create or replace function crm.refresh_customer(p_customer uuid) returns void
language plpgsql as $$
declare
  c crm.customers;
  v_gross numeric; v_refund numeric; v_cb numeric; v_sub_rev numeric; v_ren_rev numeric; v_fees numeric;
  v_paid_count int; v_sub_paid int; v_first timestamptz; v_last timestamptz;
  v_orders int; v_paid_orders int; v_refunds int; v_ship numeric; v_aff numeric;
  v_one_time int; v_active_sub boolean; v_ever_sub boolean; v_reactivated boolean;
  v_last_cancel timestamptz; v_last_one_time timestamptz; v_prospect boolean;
  v_type text; v_lifecycle text; v_risk text; v_sub text;
begin
  -- Subscription states first: customer state depends on them.
  for v_sub in select subscription_id from crm.subscriptions where customer_id = p_customer loop
    perform crm.refresh_subscription(v_sub);
  end loop;

  select
    coalesce(sum(amount) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT')), 0),
    coalesce(sum(amount) filter (where event_type in ('REFUND','PARTIAL_REFUND')), 0),
    coalesce(sum(amount) filter (where event_type = 'CHARGEBACK'), 0),
    coalesce(sum(amount) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT') and subscription_id is not null), 0),
    coalesce(sum(amount) filter (where event_type = 'RENEWAL_PAYMENT'), 0),
    coalesce(sum(platform_fee) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT')), 0),
    count(*) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT')),
    count(*) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT') and subscription_id is not null),
    min(occurred_at) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT')),
    max(occurred_at) filter (where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT'))
  into v_gross, v_refund, v_cb, v_sub_rev, v_ren_rev, v_fees, v_paid_count, v_sub_paid, v_first, v_last
  from crm.financial_events where customer_id = p_customer;

  select count(*), count(*) filter (where paid_at is not null),
         count(*) filter (where paid_at is not null and subscription_id is null),
         max(paid_at) filter (where subscription_id is null)
    into v_orders, v_paid_orders, v_one_time, v_last_one_time
    from crm.orders where customer_id = p_customer;
  select count(*) into v_refunds from crm.refunds where customer_id = p_customer and kind <> 'CHARGEBACK';
  select coalesce(sum(shipping_cost), 0) into v_ship from crm.fulfillments where customer_id = p_customer;
  select coalesce(sum(affiliate_commission), 0) into v_aff from crm.transactions
   where customer_id = p_customer and paid_at is not null;

  select bool_or(status in ('TRIAL','ACTIVE','PAUSED','PAYMENT_PENDING','PAYMENT_FAILED','REACTIVATED')),
         count(*) > 0, bool_or(reactivated_at is not null), max(coalesce(cancelled_at, expired_at))
    into v_active_sub, v_ever_sub, v_reactivated, v_last_cancel
    from crm.subscriptions where customer_id = p_customer;

  v_prospect := exists (select 1 from crm.checkouts where customer_id = p_customer)
             or exists (select 1 from crm.transactions where customer_id = p_customer);

  v_type := case
    when coalesce(v_active_sub, false) and v_one_time > 0 then 'HYBRID_CUSTOMER'
    when coalesce(v_active_sub, false) and coalesce(v_reactivated, false) then 'REACTIVATED_CUSTOMER'
    when coalesce(v_active_sub, false) then 'SUBSCRIBER'
    when v_ever_sub and v_last_cancel is not null and v_last_one_time > v_last_cancel then 'REACTIVATED_CUSTOMER'
    when v_ever_sub and v_one_time > 0 then 'HYBRID_CUSTOMER'
    when v_ever_sub then 'FORMER_SUBSCRIBER'
    when v_one_time > 0 and v_last < now() - make_interval(days => crm.setting_num('churn_after_days')::int) then 'CHURNED_CUSTOMER'
    when v_one_time > 0 then 'ONE_TIME_CUSTOMER'
    when v_prospect then 'PROSPECT'
    else 'LEAD' end;

  update crm.customers set
    total_orders = v_orders,
    total_paid_orders = v_paid_orders,
    total_refunds = v_refunds,
    total_gross_revenue = v_gross,
    total_refund_amount = v_refund,
    total_chargeback_amount = v_cb,
    total_net_revenue = v_gross - v_refund - v_cb,
    total_subscription_revenue = v_sub_rev,
    total_renewal_revenue = v_ren_rev,
    total_platform_fees = v_fees,
    total_shipping_cost = v_ship,
    total_affiliate_commissions = v_aff,
    gross_ltv = v_gross,
    net_ltv = v_gross - v_refund - v_cb,
    -- Contribution = net − gateway fees − shipping − commissions. COGS, taxes and CAC come later.
    contribution_ltv = v_gross - v_refund - v_cb - v_fees - v_ship - v_aff,
    first_purchase_at = v_first,
    last_purchase_at = v_last,
    average_order_value = case when v_paid_count > 0 then round(v_gross / v_paid_count, 2) end,
    average_subscription_cycle_value = case when v_sub_paid > 0 then round(v_sub_rev / v_sub_paid, 2) end,
    current_customer_type = v_type,
    updated_at = now()
  where customer_id = p_customer;

  -- Subscription risk depends on net LTV, which just changed.
  for v_sub in select subscription_id from crm.subscriptions where customer_id = p_customer loop
    perform crm.refresh_subscription(v_sub);
  end loop;

  select * into c from crm.customers where customer_id = p_customer;
  v_lifecycle := crm.compute_customer_lifecycle(p_customer);
  v_risk := crm.compute_customer_risk(p_customer, v_lifecycle);

  if v_lifecycle is distinct from c.current_lifecycle_stage then
    insert into crm.customer_events (dedupe_key, fact_type, customer_id, occurred_at, data)
    values ('lifecycle:' || p_customer || ':' || clock_timestamp()::text, 'LIFECYCLE_CHANGED', p_customer, now(),
            jsonb_build_object('from', c.current_lifecycle_stage, 'to', v_lifecycle));
  end if;
  if v_risk is distinct from c.current_risk_state then
    insert into crm.customer_events (dedupe_key, fact_type, customer_id, occurred_at, data)
    values ('risk:' || p_customer || ':' || clock_timestamp()::text, 'RISK_CHANGED', p_customer, now(),
            jsonb_build_object('from', c.current_risk_state, 'to', v_risk));
  end if;

  update crm.customers set
    current_lifecycle_stage = v_lifecycle,
    current_risk_state = v_risk,
    lifecycle_changed_at = case when v_lifecycle is distinct from c.current_lifecycle_stage then now() else lifecycle_changed_at end,
    risk_changed_at = case when v_risk is distinct from c.current_risk_state then now() else risk_changed_at end,
    state_refreshed_at = now()
  where customer_id = p_customer;
end;
$$;

-- Time-based transitions (DUE, CHURN_RISK, CHURNED, "recent" windows) happen
-- without new events: the worker refreshes the least recently refreshed customers.
create function crm.refresh_due_customers(p_limit int default 500) returns int
language plpgsql as $$
declare v_id uuid; v_count int := 0;
begin
  for v_id in
    select customer_id from crm.customers
     where state_refreshed_at is null or state_refreshed_at < now() - interval '12 hours'
     order by state_refreshed_at nulls first
     limit p_limit
  loop
    perform set_config('crm.actor', 'system:state-refresh', true);
    perform crm.refresh_customer(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- CUSTOMER EXPERIENCE
-- ---------------------------------------------------------------------

create view crm.customer_experience as
select
  c.customer_id,
  (select round(avg(extract(epoch from (f.delivered_at - coalesce(f.shipped_at, o.paid_at, f.created_at))) / 86400)::numeric, 1)
     from crm.fulfillments f left join crm.orders o on o.order_id = f.order_id
    where f.customer_id = c.customer_id and f.delivered_at is not null) as avg_delivery_days,
  (select count(*) from crm.fulfillments f where f.customer_id = c.customer_id
      and (f.status = 'DELIVERY_DELAYED' or (f.estimated_delivery_at is not null
           and coalesce(f.delivered_at, now()) > f.estimated_delivery_at))) as delivery_delays,
  (select count(*) from crm.fulfillments f where f.customer_id = c.customer_id
      and f.status in ('DELIVERY_FAILED','DELIVERY_RETURNED','DELIVERY_LOST')) as delivery_failures,
  (select count(*) from crm.refunds r where r.customer_id = c.customer_id and r.kind <> 'CHARGEBACK') as refunds,
  null::int as complaints,  -- no complaint source connected yet
  (select count(*) from crm.customer_events e where e.customer_id = c.customer_id and e.fact_type = 'SUBSCRIPTION_PAYMENT_LATE') as subscription_late_events,
  (select count(*) from crm.customer_events e where e.customer_id = c.customer_id
      and e.fact_type in ('SUBSCRIPTION_CANCELLATION_REQUESTED','SUBSCRIPTION_CANCELLED')) as cancellations,
  greatest(c.total_paid_orders - 1, 0) as reorders,
  null::numeric as cx_score  -- reserved: CX_SCORE comes in a later phase
from crm.customers c;

revoke all on crm.customer_experience from public, anon, authenticated;
grant select on crm.customer_experience to service_role;

-- ---------------------------------------------------------------------
-- CUSTOMER 360
-- ---------------------------------------------------------------------

create function crm.customer_360(p_customer uuid) returns jsonb
language sql stable as $$
  with c as (select * from crm.customers where customer_id = p_customer)
  select case when not exists (select 1 from c) then null else jsonb_build_object(
    'identity', (select jsonb_build_object(
        'customer_id', customer_id, 'external_customer_id', external_customer_id, 'full_name', full_name,
        'email', email, 'phone', phone, 'whatsapp', whatsapp, 'document_number', document_number,
        'birth_date', birth_date, 'address', address, 'city', city, 'state', state, 'zipcode', zipcode,
        'first_seen_at', first_seen_at, 'last_seen_at', last_seen_at,
        'identifiers', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'value', value) order by kind), '[]')
                          from crm.customer_identities i where i.customer_id = c.customer_id))
      from c),
    'acquisition', (select jsonb_build_object(
        'source', a.utm_source, 'medium', a.utm_medium, 'campaign', a.utm_campaign, 'content', a.utm_content,
        'term', a.utm_term, 'creative', a.utm_content, 'funnel', a.funnel_name, 'funnel_instance_id', a.funnel_instance_id,
        'src', a.src, 'click_ids', jsonb_strip_nulls(jsonb_build_object('fbclid', a.fbclid, 'gclid', a.gclid, 'ttclid', a.ttclid)),
        'extra', a.extra, 'occurred_at', a.occurred_at,
        'affiliate', (select jsonb_build_object('name', af.name, 'email', af.email)
                        from crm.orders o join crm.affiliates af on af.affiliate_id = o.affiliate_id
                       where o.customer_id = p_customer and o.paid_at is not null order by o.paid_at limit 1))
      from c left join crm.attributions a on a.attribution_id = c.acquisition_attribution_id),
    'commerce', (select jsonb_build_object(
        'total_orders', total_orders, 'paid_orders', total_paid_orders, 'average_order_value', average_order_value,
        'first_purchase_at', first_purchase_at, 'last_purchase_at', last_purchase_at,
        'products', (select coalesce(jsonb_agg(distinct coalesce(o.product_name, o.product_id)) filter (where o.paid_at is not null), '[]')
                       from crm.orders o where o.customer_id = p_customer),
        'offers', (select coalesce(jsonb_agg(distinct coalesce(o.offer_name, o.offer_id)) filter (where o.paid_at is not null), '[]')
                     from crm.orders o where o.customer_id = p_customer),
        'orders', (select coalesce(jsonb_agg(jsonb_build_object(
                      'order_id', o.order_id, 'sale_id', o.sale_id, 'product', o.product_name, 'offer', o.offer_name,
                      'amount', o.gross_amount, 'status', o.status, 'payment_method', o.payment_method,
                      'installments', o.installments, 'coupon', o.coupon_code, 'subscription_id', o.subscription_id,
                      'created_at', o.created_at, 'paid_at', o.paid_at, 'refunded_at', o.refunded_at)
                    order by coalesce(o.paid_at, o.created_at) desc), '[]')
                    from crm.orders o where o.customer_id = p_customer))
      from c),
    'subscriptions', (select coalesce(jsonb_agg(jsonb_build_object(
        'subscription_id', s.subscription_id, 'plan', s.plan_name, 'frequency', s.frequency, 'status', s.status,
        'payment_state', s.payment_state, 'lifecycle_state', s.lifecycle_state, 'risk_state', s.risk_state,
        'cancellation_requested', s.cancellation_requested, 'current_cycle', s.current_cycle,
        'next_charge_at', s.next_charge_at, 'last_charge_at', s.last_charge_at, 'start_date', s.start_date,
        'cancelled_at', s.cancelled_at, 'total_revenue', s.total_revenue, 'net_revenue', s.net_revenue,
        'quality_score', s.quality_score, 'quality_class', s.quality_class, 'quality_factors', s.quality_factors,
        'charges', (select coalesce(jsonb_agg(jsonb_build_object(
                       'charge_id', sc.charge_id, 'cycle', sc.cycle_number, 'amount', sc.amount, 'status', sc.status,
                       'paid_at', sc.paid_at, 'failed_at', sc.failed_at, 'late_at', sc.late_at, 'recovered_at', sc.recovered_at)
                     order by sc.cycle_number nulls last, sc.created_at), '[]')
                     from crm.subscription_charges sc where sc.subscription_id = s.subscription_id))
      order by s.start_date desc), '[]') from crm.subscriptions s where s.customer_id = p_customer),
    'financial', (select jsonb_build_object(
        'gross_revenue', total_gross_revenue, 'refunds', total_refund_amount, 'chargebacks', total_chargeback_amount,
        'net_revenue', total_net_revenue, 'platform_fees', total_platform_fees, 'shipping_cost', total_shipping_cost,
        'affiliate_commissions', total_affiliate_commissions, 'subscription_revenue', total_subscription_revenue,
        'renewal_revenue', total_renewal_revenue, 'gross_ltv', gross_ltv, 'net_ltv', net_ltv,
        'contribution_ltv', contribution_ltv,
        'pending_release', (select coalesce(sum(t.my_commission), 0) from crm.transactions t
                             where t.customer_id = p_customer and t.paid_at is not null and t.released is false),
        'released', (select coalesce(sum(t.my_commission), 0) from crm.transactions t
                      where t.customer_id = p_customer and t.paid_at is not null and t.released is true))
      from c),
    'logistics', (select coalesce(jsonb_agg(jsonb_build_object(
        'sale_id', f.sale_id, 'carrier', f.carrier, 'tracking_code', f.tracking_code, 'tracking_url', f.tracking_url,
        'status', f.status, 'shipping_cost', f.shipping_cost, 'shipped_at', f.shipped_at,
        'estimated_delivery_at', f.estimated_delivery_at, 'delivered_at', f.delivered_at)
      order by f.created_at desc), '[]') from crm.fulfillments f where f.customer_id = p_customer),
    'experience', (select to_jsonb(x) - 'customer_id' from crm.customer_experience x where x.customer_id = p_customer),
    'crm', (select jsonb_build_object(
        'customer_type', current_customer_type, 'lifecycle', current_lifecycle_stage, 'risk', current_risk_state,
        'lifecycle_changed_at', lifecycle_changed_at, 'risk_changed_at', risk_changed_at,
        'segments', '[]'::jsonb, 'automations', '[]'::jsonb, 'communications', '[]'::jsonb)
      from c),
    'timeline', (select coalesce(jsonb_agg(jsonb_build_object(
        'type', e.fact_type, 'occurred_at', e.occurred_at, 'sale_id', e.sale_id, 'subscription_id', e.subscription_id,
        'data', e.data) order by e.occurred_at desc, e.created_at desc), '[]')
      from (select * from crm.customer_events where customer_id = p_customer
            order by occurred_at desc, created_at desc limit 200) e)
  ) end
$$;

create function crm.search_customers(p_query text default null, p_lifecycle text default null, p_risk text default null,
                                     p_type text default null, p_limit int default 50, p_offset int default 0)
returns table (customer_id uuid, full_name text, email text, whatsapp text, customer_type text, lifecycle text,
               risk text, net_ltv numeric, last_purchase_at timestamptz, last_seen_at timestamptz)
language sql stable as $$
  select c.customer_id, c.full_name, c.email, c.whatsapp, c.current_customer_type, c.current_lifecycle_stage,
         c.current_risk_state, c.net_ltv, c.last_purchase_at, c.last_seen_at
    from crm.customers c
   where (p_query is null or p_query = ''
          or c.full_name ilike '%' || p_query || '%' or c.email ilike '%' || p_query || '%'
          -- phone search only for phone-like queries (8+ digits), compared digit to digit
          or (length(regexp_replace(p_query, '\D', '', 'g')) >= 8
              and regexp_replace(coalesce(c.whatsapp, c.phone, ''), '\D', '', 'g') like '%' || regexp_replace(p_query, '\D', '', 'g') || '%')
          or exists (select 1 from crm.customer_identities i where i.customer_id = c.customer_id and i.value = p_query))
     and (p_lifecycle is null or c.current_lifecycle_stage = p_lifecycle)
     and (p_risk is null or c.current_risk_state = p_risk)
     and (p_type is null or c.current_customer_type = p_type)
   order by c.last_seen_at desc nulls last
   limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0)
$$;

-- ---------------------------------------------------------------------
-- PUBLIC ENTRY POINTS (service_role only)
-- ---------------------------------------------------------------------

create function public.crm_customer_360(p_customer_id uuid) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select crm.customer_360(p_customer_id)
$$;

create function public.crm_search_customers(p_query text default null, p_lifecycle text default null,
                                            p_risk text default null, p_type text default null,
                                            p_limit int default 50, p_offset int default 0)
returns table (customer_id uuid, full_name text, email text, whatsapp text, customer_type text, lifecycle text,
               risk text, net_ltv numeric, last_purchase_at timestamptz, last_seen_at timestamptz)
language sql stable security definer set search_path = crm, public, extensions as $$
  select * from crm.search_customers(p_query, p_lifecycle, p_risk, p_type, p_limit, p_offset)
$$;

create function public.crm_refresh_customers(p_limit int default 500) returns int
language sql security definer set search_path = crm, public, extensions as $$
  select crm.refresh_due_customers(p_limit)
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_customer_360(uuid)',
    'crm_search_customers(text,text,text,text,int,int)',
    'crm_refresh_customers(int)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
