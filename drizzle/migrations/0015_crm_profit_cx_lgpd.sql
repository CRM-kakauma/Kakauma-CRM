-- =====================================================================
-- KAKAUMA CRM — profit per customer (COGS + taxes), CX score, LTV curve,
-- retention up to C12 and LGPD anonymization.
--
-- Profit is never guessed: while a paid sale has no registered product cost
-- or the tax rate is not set, profit stays NULL ("incomplete") and the screens
-- say what is missing.
-- =====================================================================

-- ---------------------------------------------------------------------
-- COSTS
-- ---------------------------------------------------------------------

-- Cost of goods per sale. An offer cost (e.g. a kit) wins over the product
-- cost; a product cost is multiplied by the offer quantity.
create table crm.product_costs (
  id bigint generated always as identity primary key,
  product_id text references crm.products(product_id),
  offer_id text references crm.offers(offer_id),
  unit_cost numeric(14,2) not null check (unit_cost >= 0),
  note text,
  updated_at timestamptz not null default now(),
  check ((product_id is null) <> (offer_id is null))
);
create unique index product_costs_product_uq on crm.product_costs (product_id) where product_id is not null;
create unique index product_costs_offer_uq on crm.product_costs (offer_id) where offer_id is not null;

alter table crm.product_costs enable row level security;
revoke all on crm.product_costs from public, anon, authenticated;
grant select, insert, update, delete on crm.product_costs to service_role;

create trigger product_costs_audit
after update on crm.product_costs
for each row execute function crm.audit_changes('id', 'unit_cost');
create trigger product_costs_audit_insert
after insert on crm.product_costs
for each row execute function crm.audit_insert('id', 'unit_cost');

insert into crm.settings (key, value, description) values
  ('tax_rate_pct', 'null', 'Impostos sobre a receita líquida (%). Enquanto não for definido, o lucro fica "incompleto".'),
  ('cx_weights', '{
     "base": 80,
     "per_reorder": 5, "max_reorder_bonus": 20,
     "per_delivery_delay": -10, "max_delay_penalty": -30,
     "per_delivery_failure": -25, "max_failure_penalty": -50,
     "per_refund": -20, "max_refund_penalty": -40,
     "per_chargeback": -40,
     "per_late_payment": -5, "max_late_penalty": -15,
     "per_cancellation": -10, "max_cancellation_penalty": -20
   }', 'Pesos do CX score (0–100): experiência de entrega, reembolsos e atritos. Heurística inicial, ajustável.');

-- Every paid charge with what it cost (NULL = cost not registered).
create view crm.sale_costs as
select
  fe.financial_event_id, fe.customer_id, fe.occurred_at, fe.amount, fe.sale_id,
  coalesce(o.product_id, s.product_id) as product_id,
  coalesce(o.offer_id, s.offer_id) as offer_id,
  coalesce(oc.unit_cost, pc.unit_cost * coalesce(nullif(of.quantity, 0), 1)) as cost
from crm.financial_events fe
left join crm.orders o on o.sale_id = fe.sale_id
left join crm.subscriptions s on s.subscription_id = fe.subscription_id
left join crm.offers of on of.offer_id = coalesce(o.offer_id, s.offer_id)
left join crm.product_costs oc on oc.offer_id = coalesce(o.offer_id, s.offer_id)
left join crm.product_costs pc on pc.product_id = coalesce(o.product_id, s.product_id)
where fe.event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT');

revoke all on crm.sale_costs from public, anon, authenticated;
grant select on crm.sale_costs to service_role;

alter table crm.customers
  add column total_cogs numeric(14,2) not null default 0,
  add column cogs_missing_sales int not null default 0,
  add column total_taxes numeric(14,2),
  add column profit_ltv numeric(14,2),
  add column cx_score numeric,
  add column anonymized_at timestamptz;

-- ---------------------------------------------------------------------
-- CX SCORE
-- ---------------------------------------------------------------------

create function crm.cx_weight(p_key text) returns numeric
language sql stable as $$
  select coalesce((value ->> p_key)::numeric, 0) from crm.settings where key = 'cx_weights'
$$;

-- capped contribution: count × per-unit weight, never beyond the cap (same sign)
create function crm.capped(p_count numeric, p_per text, p_cap text) returns numeric
language sql stable as $$
  select case when crm.cx_weight(p_per) >= 0
              then least(coalesce(p_count, 0) * crm.cx_weight(p_per), coalesce(nullif(crm.cx_weight(p_cap), 0), 1e9))
              else greatest(coalesce(p_count, 0) * crm.cx_weight(p_per), coalesce(nullif(crm.cx_weight(p_cap), 0), -1e9)) end
$$;

create or replace view crm.customer_experience as
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
  c.cx_score
from crm.customers c;

-- Profit and CX of one customer (runs after the state refresh).
create function crm.refresh_customer_economics(p_customer uuid) returns void
language plpgsql as $$
declare
  c crm.customers;
  x crm.customer_experience;
  v_cogs numeric; v_missing int; v_tax_rate numeric; v_taxes numeric; v_cb int; v_cx numeric;
begin
  select * into c from crm.customers where customer_id = p_customer;
  if not found then return; end if;

  select coalesce(sum(cost), 0), count(*) filter (where cost is null)
    into v_cogs, v_missing
    from crm.sale_costs where customer_id = p_customer;
  v_tax_rate := crm.setting_num('tax_rate_pct');
  v_taxes := case when v_tax_rate is not null then round(greatest(c.net_ltv, 0) * v_tax_rate / 100, 2) end;

  if c.total_paid_orders > 0 then
    select * into x from crm.customer_experience where customer_id = p_customer;
    select count(*) into v_cb from crm.refunds where customer_id = p_customer and kind = 'CHARGEBACK';
    v_cx := crm.cx_weight('base')
          + crm.capped(x.reorders, 'per_reorder', 'max_reorder_bonus')
          + crm.capped(x.delivery_delays, 'per_delivery_delay', 'max_delay_penalty')
          + crm.capped(x.delivery_failures, 'per_delivery_failure', 'max_failure_penalty')
          + crm.capped(x.refunds, 'per_refund', 'max_refund_penalty')
          + v_cb * crm.cx_weight('per_chargeback')
          + crm.capped(x.subscription_late_events, 'per_late_payment', 'max_late_penalty')
          + crm.capped(x.cancellations, 'per_cancellation', 'max_cancellation_penalty');
    v_cx := greatest(0, least(100, round(v_cx)));
  end if;

  update crm.customers set
    total_cogs = v_cogs,
    cogs_missing_sales = v_missing,
    total_taxes = v_taxes,
    profit_ltv = case when v_missing = 0 and v_taxes is not null then contribution_ltv - v_cogs - v_taxes end,
    cx_score = v_cx
  where customer_id = p_customer
    and (total_cogs, cogs_missing_sales, total_taxes, profit_ltv, cx_score)
        is distinct from (v_cogs, v_missing, v_taxes,
                          case when v_missing = 0 and v_taxes is not null then contribution_ltv - v_cogs - v_taxes end, v_cx);
end;
$$;

create or replace function crm.refresh_customer(p_customer uuid) returns void
language plpgsql as $$
begin
  perform crm.refresh_customer_state(p_customer);
  perform crm.refresh_customer_economics(p_customer);
  perform crm.refresh_customer_segments(p_customer);
end;
$$;

-- ---------------------------------------------------------------------
-- FEATURES: profit and CX become rule fields (columns appended).
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
  c.cx_score
from crm.customers c
left join crm.attributions a on a.attribution_id = c.acquisition_attribution_id
left join lateral (
  select * from crm.subscriptions s
   where s.customer_id = c.customer_id
   order by (s.status not in ('CANCELLED','INACTIVE','EXPIRED')) desc, coalesce(s.last_charge_at, s.start_date) desc nulls last
   limit 1
) s on true;

-- ---------------------------------------------------------------------
-- CUSTOMER 360 and DASHBOARD: profit fields.
-- ---------------------------------------------------------------------

alter function crm.customer_360(uuid) rename to customer_360_segments;

create function crm.customer_360(p_customer uuid) returns jsonb
language sql stable as $$
  select case when b is null then null else
    jsonb_set(jsonb_set(b,
      '{financial}', (b -> 'financial') || (select jsonb_build_object(
          'cogs', c.total_cogs, 'cogs_missing_sales', c.cogs_missing_sales, 'taxes', c.total_taxes,
          'tax_rate_pct', crm.setting_num('tax_rate_pct'), 'profit_ltv', c.profit_ltv)
        from crm.customers c where c.customer_id = p_customer)),
      '{identity,anonymized_at}', coalesce((select to_jsonb(anonymized_at) from crm.customers where customer_id = p_customer), 'null'))
  end
  from (select crm.customer_360_segments(p_customer) as b) x
$$;

alter function crm.dashboard(timestamptz, timestamptz) rename to dashboard_base;

create function crm.dashboard(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable as $$
declare
  b jsonb := crm.dashboard_base(p_from, p_to);
  v_tax_rate numeric := crm.setting_num('tax_rate_pct');
  v_cogs numeric; v_missing int; v_aff numeric; v_ship numeric; v_net numeric; v_fees numeric; v_taxes numeric;
begin
  select coalesce(sum(cost), 0), count(*) filter (where cost is null) into v_cogs, v_missing
    from crm.sale_costs where occurred_at >= p_from and occurred_at < p_to;
  select coalesce(sum(affiliate_commission), 0) into v_aff
    from crm.transactions where paid_at >= p_from and paid_at < p_to;
  v_ship := coalesce((b #>> '{fulfillment,shipping_cost}')::numeric, 0);
  v_net := coalesce((b #>> '{commerce,net_revenue}')::numeric, 0);
  v_fees := coalesce((b #>> '{commerce,platform_fees}')::numeric, 0);
  v_taxes := case when v_tax_rate is not null then round(greatest(v_net, 0) * v_tax_rate / 100, 2) end;

  return jsonb_set(jsonb_set(b,
    '{commerce}', (b -> 'commerce') || jsonb_build_object(
      'cogs', v_cogs, 'cogs_missing_sales', v_missing, 'taxes', v_taxes, 'affiliate_commissions', v_aff,
      'profit', case when v_missing = 0 and v_taxes is not null then v_net - v_fees - v_ship - v_aff - v_cogs - v_taxes end)),
    '{customer}', (b -> 'customer') || (select jsonb_build_object(
      'avg_profit_ltv', round(avg(profit_ltv) filter (where total_paid_orders > 0), 2),
      'profit_known_customers', count(*) filter (where total_paid_orders > 0 and profit_ltv is not null),
      'avg_cx_score', round(avg(cx_score), 1))
      from crm.customers));
end;
$$;

-- ---------------------------------------------------------------------
-- LTV CURVE: average cumulative net revenue per customer, month by month
-- since the first purchase. Month m only counts customers old enough to
-- have lived it (no extrapolation).
-- ---------------------------------------------------------------------

create function crm.ltv_curve(p_dimension text, p_from timestamptz, p_to timestamptz, p_months int default 12) returns jsonb
language plpgsql stable as $$
declare v jsonb; v_months int := least(greatest(coalesce(p_months, 12), 1), 24);
begin
  perform crm.check_dimension(p_dimension, array['all','first_purchase_month','source','campaign','creative','funnel',
    'affiliate','state','payment_method','product','offer']);
  with cust as (
    select d.customer_id, c.first_purchase_at,
           case when p_dimension = 'all' then 'Todos' else coalesce(crm.dim(d, p_dimension), '(desconhecido)') end as cohort
      from crm.customer_dimensions d join crm.customers c using (customer_id)
     where c.first_purchase_at >= p_from and c.first_purchase_at < p_to
  ),
  money as (
    select fe.customer_id, fe.occurred_at,
           case when fe.event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT') then fe.amount else -fe.amount end as amount
      from crm.financial_events fe join cust using (customer_id)
     where fe.event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT','REFUND','PARTIAL_REFUND','CHARGEBACK')
  ),
  points as (
    select k.cohort, m,
           count(*) filter (where k.first_purchase_at + make_interval(months => m) <= now()) as eligible,
           avg((select coalesce(sum(amount), 0) from money x
                 where x.customer_id = k.customer_id
                   and x.occurred_at < k.first_purchase_at + make_interval(months => m + 1)))
             filter (where k.first_purchase_at + make_interval(months => m) <= now()) as avg_net_ltv
      from cust k cross join generate_series(0, v_months) m
     group by k.cohort, m
  )
  select coalesce(jsonb_agg(t order by t.customers desc, t.cohort), '[]') into v from (
    select k.cohort, count(*) as customers,
           (select jsonb_agg(jsonb_build_object('month', p.m, 'eligible', p.eligible, 'avg_net_ltv', round(p.avg_net_ltv, 2))
                             order by p.m)
              from points p where p.cohort = k.cohort) as points
      from cust k group by k.cohort
  ) t;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- RETENTION C1 → C12 (same definitions as before, longer horizon)
-- ---------------------------------------------------------------------

create or replace function crm.retention(p_dimension text, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable as $$
declare v jsonb;
begin
  perform crm.check_dimension(p_dimension, array['first_subscription_month','product','offer','plan','source','campaign',
    'creative','funnel','affiliate','state','payment_method']);
  with subs as (
    select sc.*,
      case p_dimension
        when 'first_subscription_month' then crm.month_of(sc.start_date)
        when 'product' then sc.product when 'offer' then sc.offer
        when 'plan' then coalesce(sc.plan_name, '(desconhecido)')
        else crm.dim(d, p_dimension) end as cohort
    from crm.subscription_cycles sc
    join crm.customer_dimensions d on d.customer_id = sc.customer_id
    where sc.start_date >= p_from and sc.start_date < p_to
  ),
  cycles as (
    select s.cohort, n,
      count(*) filter (where crm.eligible_for_cycle(s.start_date, s.cycle_days, n)) as eligible,
      count(*) filter (where crm.eligible_for_cycle(s.start_date, s.cycle_days, n) and s.cycles_paid >= n) as reached,
      count(*) filter (where s.cycles_paid >= n and crm.eligible_for_cycle(s.start_date, s.cycle_days, n + 1)) as step_base,
      count(*) filter (where s.cycles_paid >= n + 1 and crm.eligible_for_cycle(s.start_date, s.cycle_days, n + 1)) as step_reached
    from subs s cross join generate_series(1, 12) n
    group by s.cohort, n
  )
  select coalesce(jsonb_agg(t order by cohort), '[]') into v from (
    select s.cohort,
      count(*) as subscriptions,
      (select jsonb_object_agg('c' || c.n, jsonb_build_object('eligible', c.eligible, 'reached', c.reached,
                                                              'rate', crm.pct(c.reached, c.eligible)) order by c.n)
         from cycles c where c.cohort is not distinct from s.cohort) as cycles,
      (select jsonb_object_agg('c' || c.n || '_c' || (c.n + 1),
                               jsonb_build_object('base', c.step_base, 'retained', c.step_reached,
                                                  'rate', crm.pct(c.step_reached, c.step_base)) order by c.n)
         from cycles c where c.cohort is not distinct from s.cohort and c.n <= 11) as steps
    from subs s group by s.cohort
  ) t;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- LGPD: anonymization
--
-- Removes everything that identifies the person (customer record, identities,
-- personal fields inside the raw payloads, rendered messages, payment links,
-- tracking) and keeps the money and the lifecycle, so reports stay correct.
-- The raw store accepts this one change only through crm.redact_raw_event.
-- ---------------------------------------------------------------------

create or replace function crm.protect_raw_event() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'crm.events is append-only (event %)', old.event_id;
  end if;
  if (new.payload is distinct from old.payload and coalesce(current_setting('crm.lgpd_redaction', true), '') <> 'on')
     or new.payload_hash is distinct from old.payload_hash
     or new.idempotency_key is distinct from old.idempotency_key
     or new.source is distinct from old.source
     or new.received_at is distinct from old.received_at then
    raise exception 'raw payload of event % is immutable', old.event_id;
  end if;
  return new;
end;
$$;

-- Personal fields are replaced wherever they appear; everything inside a
-- customer/address-like object is replaced. Ids, amounts and statuses of the
-- sale stay, so the history can still be audited.
create function crm.redact_pii(p jsonb, p_all boolean default false) returns jsonb
language sql immutable as $$
  select case jsonb_typeof(p)
    when 'object' then coalesce((
      select jsonb_object_agg(k, case
          when p_all or k ~* '^(full_?name|first_?name|last_?name|social_?name|customer_?name|name_?customer|e-?mail|email_?address|customer_?email|phone|phone_?number|customer_?phone|mobile|cell_?phone|cellphone|whatsapp|document|document_?number|customer_?document|cpf|cnpj|rg|birth_?date|birthday|date_?of_?birth|address|street|street_?number|address_?number|complement|neighborhood|neighbourhood|district|zip_?code|zip|cep|postal_?code|ip|ip_?address|user_?agent|pix_?url|pix_?code|qr_?code|billet_?url|billet_?code|barcode|digitable_?line|tracking_?code|tracking_?url|checkout_?url|url)$'
            then crm.redact_pii(v, true)
          when k ~* '^(customer|client|buyer|payer|student|user|address|shipping|shipping_?address|billing|billing_?address|delivery_?address|recipient)$'
            then crm.redact_pii(v, true)
          else crm.redact_pii(v, false) end)
        from jsonb_each(p) e(k, v)), '{}'::jsonb)
    when 'array' then coalesce((
      select jsonb_agg(crm.redact_pii(v, p_all) order by i)
        from jsonb_array_elements(p) with ordinality a(v, i)), '[]'::jsonb)
    when 'string' then case when p_all then to_jsonb('[anonimizado]'::text) else p end
    when 'number' then case when p_all then to_jsonb('[anonimizado]'::text) else p end
    else p end
$$;

create function crm.redact_raw_event(p_id uuid) returns void
language plpgsql as $$
begin
  perform set_config('crm.lgpd_redaction', 'on', true);
  update crm.events set
    payload = crm.redact_pii(payload),
    normalized = case when normalized is null then null else crm.redact_pii(normalized) end,
    redacted_fields = array(select distinct unnest(redacted_fields || array['lgpd']))
   where id = p_id;
  perform set_config('crm.lgpd_redaction', 'off', true);
end;
$$;

create function crm.anonymize_customer(p_customer uuid, p_reason text) returns jsonb
language plpgsql as $$
declare
  v_ev uuid; v_events int := 0;
begin
  if nullif(btrim(p_reason), '') is null then raise exception 'a reason is required (e.g. request protocol)'; end if;
  perform 1 from crm.customers where customer_id = p_customer for update;
  if not found then raise exception 'customer % not found', p_customer; end if;
  if exists (select 1 from crm.customers where customer_id = p_customer and anonymized_at is not null) then
    raise exception 'customer % is already anonymized', p_customer;
  end if;

  -- every raw event that touched this customer
  for v_ev in
    select id from crm.events where customer_id = p_customer
    union select raw_event_id from crm.customer_identities where customer_id = p_customer and raw_event_id is not null
    union select raw_event_id from crm.financial_events where customer_id = p_customer
    union select raw_event_id from crm.customer_events where customer_id = p_customer
    union select raw_event_id from crm.attributions where customer_id = p_customer
    union select raw_event_id from crm.checkouts where customer_id = p_customer
  loop
    perform crm.redact_raw_event(v_ev);
    update crm.dead_letter_events set payload = crm.redact_pii(payload), raw_body = null where raw_event_id = v_ev;
    update crm.data_quality_issues set context = crm.redact_pii(context) where raw_event_id = v_ev;
    v_events := v_events + 1;
  end loop;

  delete from crm.customer_identities where customer_id = p_customer;
  update crm.customers set
    external_customer_id = null, full_name = 'Cliente anonimizado', email = null, phone = null, whatsapp = null,
    document_number = null, birth_date = null, address = null, city = null, zipcode = null, neighborhood = null,
    anonymized_at = now(), updated_at = now()
   where customer_id = p_customer;
  update crm.attributions set fbclid = null, gclid = null, ttclid = null, fbc = null, fbp = null,
    extra = crm.redact_pii(extra) where customer_id = p_customer;
  update crm.checkouts set checkout_url = null where customer_id = p_customer;
  update crm.transactions set pix_url = null, pix_code = null, billet_url = null, billet_code = null
   where customer_id = p_customer;
  update crm.fulfillments set tracking_code = null, tracking_url = null where customer_id = p_customer;
  update crm.customer_events set data = crm.redact_pii(data) where customer_id = p_customer;
  update crm.automation_runs set rendered_message = '[anonimizado]'
   where customer_id = p_customer and rendered_message is not null;

  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('customers', p_customer::text, 'anonymized', null, left(p_reason, 200), crm.current_actor());

  return jsonb_build_object('customer_id', p_customer, 'events_redacted', v_events);
end;
$$;

-- ---------------------------------------------------------------------
-- PUBLIC ENTRY POINTS
-- ---------------------------------------------------------------------

create function public.crm_list_product_costs()
returns table (product_id text, offer_id text, name text, product_name text, offer_quantity numeric,
               unit_cost numeric, note text, updated_at timestamptz, paid_sales bigint)
language sql stable security definer set search_path = crm, public, extensions as $$
  with items as (
    select p.product_id, null::text as offer_id, p.name, p.name as product_name, null::numeric as offer_quantity
      from crm.products p
    union all
    select o.product_id, o.offer_id, o.name, p.name, o.quantity
      from crm.offers o left join crm.products p using (product_id)
  )
  select i.product_id, i.offer_id, i.name, i.product_name, i.offer_quantity, pc.unit_cost, pc.note, pc.updated_at,
         (select count(*) from crm.sale_costs s
           where (i.offer_id is not null and s.offer_id = i.offer_id)
              or (i.offer_id is null and s.product_id = i.product_id))
    from items i
    left join crm.product_costs pc
      on (i.offer_id is not null and pc.offer_id = i.offer_id) or (i.offer_id is null and pc.product_id = i.product_id)
   order by i.product_name nulls last, i.offer_id nulls first
$$;

create function public.crm_set_product_cost(p_product_id text default null, p_offer_id text default null,
                                            p_unit_cost numeric default null, p_note text default null,
                                            p_actor text default null) returns int
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v_id uuid; v_count int := 0;
begin
  perform crm.set_actor(p_actor);
  if (p_product_id is null) = (p_offer_id is null) then raise exception 'give exactly one of product or offer'; end if;
  if p_unit_cost is not null and p_unit_cost < 0 then raise exception 'cost must be >= 0'; end if;
  if p_unit_cost is null then
    delete from crm.product_costs where product_id is not distinct from p_product_id and offer_id is not distinct from p_offer_id
      and (p_product_id is not null or p_offer_id is not null);
    insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
    values ('product_costs', coalesce(p_offer_id, p_product_id), 'deleted', null, null, crm.current_actor());
  elsif p_offer_id is not null then
    insert into crm.product_costs (offer_id, unit_cost, note) values (p_offer_id, p_unit_cost, p_note)
    on conflict (offer_id) where offer_id is not null
    do update set unit_cost = excluded.unit_cost, note = excluded.note, updated_at = now();
  else
    insert into crm.product_costs (product_id, unit_cost, note) values (p_product_id, p_unit_cost, p_note)
    on conflict (product_id) where product_id is not null
    do update set unit_cost = excluded.unit_cost, note = excluded.note, updated_at = now();
  end if;
  -- recompute profit of the customers who bought it
  for v_id in select distinct customer_id from crm.sale_costs
               where (p_offer_id is not null and offer_id = p_offer_id) or (p_offer_id is null and product_id = p_product_id) loop
    perform crm.refresh_customer_economics(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Settings: tax_rate_pct accepts a number or null; changing it or the CX
-- weights recomputes profit/CX of every customer.
create or replace function public.crm_update_setting(p_key text, p_value jsonb, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v jsonb; v_id uuid;
begin
  perform crm.set_actor(p_actor);
  if p_key in ('quality_weights','cx_weights') and jsonb_typeof(p_value) <> 'object' then
    raise exception '% must be an object', p_key;
  elsif p_key = 'tax_rate_pct' and not (jsonb_typeof(p_value) = 'null'
        or (jsonb_typeof(p_value) = 'number' and (p_value #>> '{}')::numeric between 0 and 100)) then
    raise exception 'tax_rate_pct must be a number between 0 and 100 (or null)';
  elsif p_key not in ('quality_weights','cx_weights','value_tiers','report_timezone','tax_rate_pct')
        and jsonb_typeof(p_value) <> 'number' then
    raise exception 'setting % must be a number', p_key;
  end if;
  update crm.settings set value = p_value, updated_at = now() where key = p_key returning value into v;
  if v is null then raise exception 'unknown setting "%"', p_key; end if;
  if p_key in ('tax_rate_pct','cx_weights') then
    for v_id in select customer_id from crm.customers loop
      perform crm.refresh_customer_economics(v_id);
    end loop;
  end if;
  return v;
end;
$$;

create function public.crm_ltv_curve(p_dimension text, p_from timestamptz, p_to timestamptz, p_months int default 12)
returns jsonb language sql stable security definer set search_path = crm, public, extensions as $$
  select crm.ltv_curve(p_dimension, p_from, p_to, p_months)
$$;

create function public.crm_anonymize_customer(p_customer_id uuid, p_reason text, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  return crm.anonymize_customer(p_customer_id, p_reason);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_list_product_costs()',
    'crm_set_product_cost(text,text,numeric,text,text)',
    'crm_update_setting(text,jsonb,text)',
    'crm_ltv_curve(text,timestamptz,timestamptz,int)',
    'crm_anonymize_customer(uuid,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- Existing customers get profit/CX now.
do $$
declare v_id uuid;
begin
  for v_id in select customer_id from crm.customers loop
    perform crm.refresh_customer_economics(v_id);
  end loop;
end;
$$;
