-- =====================================================================
-- KAKAUMA CRM — event processing engine (phase 1)
--
-- Pipeline (one database transaction per event):
--   ingest_raw → claim → apply_event(normalized) → facts/state → refresh_customer
--
-- Normalization (provider payload → normalized event) runs in the app
-- (src/server/crm/normalize), versioned by schema_version. This file only
-- ever sees the normalized contract documented in docs/crm/normalized-event.md.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------

create function crm.norm_email(p text) returns text
language sql immutable as $$
  select nullif(lower(btrim(p)), '')
$$;

-- Brazilian phone → digits with country code (55...).
create function crm.norm_phone(p text) returns text
language sql immutable as $$
  select case
    when d is null or length(d) < 10 then null
    when length(d) in (10, 11) then '55' || d
    else d
  end
  from (select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') as d) x
$$;

create function crm.norm_doc(p text) returns text
language sql immutable as $$
  select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '')
$$;

create function crm.jts(p jsonb, k text) returns timestamptz
language sql stable as $$
  select nullif(p ->> k, '')::timestamptz
$$;

create function crm.jnum(p jsonb, k text) returns numeric
language sql immutable as $$
  select nullif(p ->> k, '')::numeric
$$;

create function crm.has_values(p jsonb) returns boolean
language sql immutable as $$
  select coalesce(jsonb_typeof(p) = 'object' and (
    exists (select 1 from jsonb_each(p) e
            where e.key <> 'extra' and e.value <> 'null'::jsonb and e.value <> '""'::jsonb)
    or coalesce(p -> 'extra', '{}'::jsonb) <> '{}'::jsonb), false)
$$;

-- Monotonic status progressions: a late, older event never moves state back.
create function crm.tx_rank(s text) returns int
language sql immutable as $$
  select case s
    when 'PENDING' then 1 when 'FAILED' then 2 when 'PAID' then 3
    when 'PARTIALLY_REFUNDED' then 4 when 'REFUNDED' then 5 when 'CHARGEBACK' then 6
    else 0 end
$$;

create function crm.order_rank(s text) returns int
language sql immutable as $$
  select case s
    when 'PENDING' then 1 when 'FAILED' then 2 when 'CANCELLED' then 2 when 'PAID' then 3
    when 'PARTIALLY_REFUNDED' then 4 when 'REFUNDED' then 5 when 'CHARGEBACK' then 6
    else 0 end
$$;

create function crm.dq(p_raw uuid, p_code text, p_message text, p_context jsonb default '{}', p_severity text default 'warning')
returns void language sql as $$
  insert into crm.data_quality_issues (raw_event_id, code, severity, message, context)
  values (p_raw, p_code, p_severity, p_message, coalesce(p_context, '{}'));
$$;

create function crm.add_fact(
  p_dedupe text, p_type text, p_customer uuid, p_ev jsonb, p_occurred timestamptz,
  p_raw uuid, p_data jsonb default '{}'
) returns boolean language plpgsql as $$
declare inserted boolean;
begin
  insert into crm.customer_events (dedupe_key, fact_type, customer_id, subscription_id, sale_id, charge_id,
                                   occurred_at, data, raw_event_id)
  values (p_dedupe, p_type, p_customer, p_ev ->> 'subscription_id', p_ev ->> 'sale_id', p_ev ->> 'charge_id',
          p_occurred, coalesce(p_data, '{}'), p_raw)
  on conflict (dedupe_key) do nothing
  returning true into inserted;
  return coalesce(inserted, false);
end;
$$;

create function crm.add_financial(
  p_dedupe text, p_type text, p_customer uuid, p_ev jsonb, p_tx uuid, p_amount numeric,
  p_fee numeric, p_occurred timestamptz, p_raw uuid
) returns boolean language plpgsql as $$
declare inserted boolean;
begin
  insert into crm.financial_events (dedupe_key, event_type, customer_id, sale_id, charge_id, transaction_id,
                                    subscription_id, amount, platform_fee, currency, occurred_at, raw_event_id)
  values (p_dedupe, p_type, p_customer, p_ev ->> 'sale_id', p_ev ->> 'charge_id', p_tx,
          p_ev ->> 'subscription_id', coalesce(p_amount, 0), p_fee, coalesce(p_ev ->> 'currency', 'BRL'),
          p_occurred, p_raw)
  on conflict (dedupe_key) do nothing
  returning true into inserted;
  return coalesce(inserted, false);
end;
$$;

-- ---------------------------------------------------------------------
-- RAW STORE: ingest / claim / complete / fail
-- ---------------------------------------------------------------------

-- Stores the payload exactly once per (source, idempotency key).
-- Idempotency key = provider event id when available, otherwise the sha256
-- of the payload (which already contains event name, sale, subscription,
-- charge and timestamps). Computed here so app ingest and SQL backfill agree.
create function crm.ingest_raw(
  p_source text, p_event_name text, p_source_event_id text, p_payload jsonb,
  p_schema_version text default 'v1', p_redacted text[] default '{}',
  p_received_at timestamptz default now()
) returns table (id uuid, event_id text, duplicate boolean, processing_status text)
language plpgsql as $$
#variable_conflict use_column
declare
  v_hash text := encode(digest(p_payload::text, 'sha256'), 'hex');
  v_key text := case when nullif(p_source_event_id, '') is not null
                     then 'src:' || p_source_event_id else 'sha256:' || v_hash end;
  v_id uuid;
begin
  insert into crm.events (source, event_name, source_event_id, idempotency_key, payload, payload_hash,
                          redacted_fields, schema_version, received_at)
  values (p_source, p_event_name, nullif(p_source_event_id, ''), v_key, p_payload, v_hash,
          coalesce(p_redacted, '{}'), coalesce(p_schema_version, 'v1'), coalesce(p_received_at, now()))
  on conflict (source, idempotency_key) do nothing
  returning crm.events.id into v_id;

  if v_id is not null then
    return query select e.id, e.event_id, false, e.processing_status from crm.events e where e.id = v_id;
  else
    return query select e.id, e.event_id, true, e.processing_status
      from crm.events e where e.source = p_source and e.idempotency_key = v_key;
  end if;
end;
$$;

-- Locks events for processing. Retries use exponential backoff; events stuck
-- in PROCESSING (crashed worker) are picked up again after 10 minutes.
create function crm.claim_events(p_limit int default 50, p_id uuid default null)
returns table (id uuid, event_id text, source text, event_name text, payload jsonb,
               schema_version text, retry_count int, received_at timestamptz)
language plpgsql as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select e.id from crm.events e
    where (p_id is null or e.id = p_id)
      and (e.processing_status = 'RECEIVED'
           or (e.processing_status = 'FAILED' and coalesce(e.next_retry_at, now()) <= now())
           or (e.processing_status = 'PROCESSING' and e.processed_at is null
               and e.next_retry_at is not null and e.next_retry_at <= now()))
    order by coalesce(e.occurred_at, e.received_at), e.received_at
    for update skip locked
    limit greatest(p_limit, 1)
  )
  update crm.events e
     set processing_status = 'PROCESSING',
         next_retry_at = now() + interval '10 minutes'
    from picked
   where e.id = picked.id
  returning e.id, e.event_id, e.source, e.event_name, e.payload, e.schema_version, e.retry_count, e.received_at;
end;
$$;

-- Marks a failure. Non-fatal failures retry with backoff (1, 2, 4, 8 min...);
-- fatal ones (invalid event) or exhausted retries go to the dead-letter queue.
-- The raw event is never lost.
create function crm.fail_event(p_raw uuid, p_error text, p_fatal boolean default false,
                               p_started timestamptz default null, p_max_retries int default 5)
returns text language plpgsql as $$
declare
  v_retries int;
  v_status text;
begin
  update crm.events
     set retry_count = retry_count + 1,
         processing_error = p_error
   where id = p_raw
  returning retry_count into v_retries;

  v_status := case when p_fatal or v_retries >= p_max_retries then 'DEAD_LETTER' else 'FAILED' end;

  update crm.events
     set processing_status = v_status,
         next_retry_at = case when v_status = 'FAILED'
                              then now() + make_interval(mins => power(2, v_retries - 1)::int) end
   where id = p_raw;

  if v_status = 'DEAD_LETTER' then
    insert into crm.dead_letter_events (raw_event_id, source, reason, error)
    select id, source, case when p_fatal then 'invalid_event' else 'max_retries_exceeded' end, p_error
      from crm.events where id = p_raw;
  end if;

  insert into crm.event_processing_logs (raw_event_id, processing_started, processing_finished, processing_status,
                                         processing_duration_ms, error, retry_count)
  values (p_raw, coalesce(p_started, clock_timestamp()), clock_timestamp(), v_status,
          (extract(epoch from clock_timestamp() - coalesce(p_started, clock_timestamp())) * 1000)::int,
          p_error, v_retries);
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------
-- IDENTITY RESOLUTION
-- Priority: B4you customer.id → subscription_id → sale_id → email → whatsapp → document.
-- Never merges automatically: conflicting identifiers are reported as data quality issues.
-- ---------------------------------------------------------------------

create function crm.resolve_customer(p_ev jsonb, p_raw uuid, p_occurred timestamptz)
returns uuid language plpgsql as $$
declare
  c jsonb := coalesce(p_ev -> 'customer', '{}');
  cand text[][] := array[
    array['b4you_customer_id', nullif(p_ev ->> 'external_customer_id', '')],
    array['subscription_id',   nullif(p_ev ->> 'subscription_id', '')],
    array['sale_id',           nullif(p_ev ->> 'sale_id', '')],
    array['email',             crm.norm_email(c ->> 'email')],
    array['whatsapp',          crm.norm_phone(coalesce(c ->> 'whatsapp', c ->> 'phone'))],
    array['document',          crm.norm_doc(c ->> 'document_number')]
  ];
  i int;
  v_found uuid;
  v_other uuid;
  v_customer uuid;
  v_newer boolean;
begin
  -- Serialize concurrent events of the same person (locks taken in a stable order).
  for i in 1 .. array_length(cand, 1) loop
    if cand[i][2] is not null then
      perform pg_advisory_xact_lock(hashtext('crm:identity:' || cand[i][1] || ':' || cand[i][2]));
    end if;
  end loop;

  for i in 1 .. array_length(cand, 1) loop
    continue when cand[i][2] is null;
    select customer_id into v_other from crm.customer_identities where kind = cand[i][1] and value = cand[i][2];
    if v_other is null and cand[i][1] = 'subscription_id' then
      select customer_id into v_other from crm.subscriptions where subscription_id = cand[i][2];
    elsif v_other is null and cand[i][1] = 'sale_id' then
      select customer_id into v_other from crm.orders where sale_id = cand[i][2];
    end if;
    if v_other is not null then
      if v_found is null then
        v_found := v_other;
      elsif v_other <> v_found then
        perform crm.dq(p_raw, 'identity_conflict',
          format('%s=%s belongs to another customer', cand[i][1], cand[i][2]),
          jsonb_build_object('resolved_customer', v_found, 'other_customer', v_other, 'kind', cand[i][1]));
      end if;
    end if;
    v_other := null;
  end loop;

  if v_found is null then
    insert into crm.customers (external_customer_id, first_seen_at, last_seen_at)
    values (nullif(p_ev ->> 'external_customer_id', ''), p_occurred, p_occurred)
    on conflict (external_customer_id) do nothing
    returning customer_id into v_customer;
    if v_customer is null then
      select customer_id into v_customer from crm.customers
       where external_customer_id = p_ev ->> 'external_customer_id';
    end if;
  else
    v_customer := v_found;
  end if;

  for i in 1 .. array_length(cand, 1) loop
    continue when cand[i][2] is null;
    insert into crm.customer_identities (kind, value, customer_id, raw_event_id)
    values (cand[i][1], cand[i][2], v_customer, p_raw)
    on conflict do nothing;
  end loop;

  -- Profile: newer evidence wins; older evidence only fills gaps.
  select p_occurred >= coalesce(last_seen_at, '-infinity'::timestamptz) into v_newer
    from crm.customers where customer_id = v_customer;

  update crm.customers cu set
    external_customer_id = coalesce(cu.external_customer_id,
      case when not exists (select 1 from crm.customers x where x.external_customer_id = p_ev ->> 'external_customer_id')
           then nullif(p_ev ->> 'external_customer_id', '') end),
    full_name       = case when v_newer then coalesce(nullif(c ->> 'full_name', ''), cu.full_name) else coalesce(cu.full_name, nullif(c ->> 'full_name', '')) end,
    email           = case when v_newer then coalesce(crm.norm_email(c ->> 'email'), cu.email) else coalesce(cu.email, crm.norm_email(c ->> 'email')) end,
    phone           = case when v_newer then coalesce(nullif(c ->> 'phone', ''), cu.phone) else coalesce(cu.phone, nullif(c ->> 'phone', '')) end,
    whatsapp        = case when v_newer then coalesce(nullif(c ->> 'whatsapp', ''), cu.whatsapp) else coalesce(cu.whatsapp, nullif(c ->> 'whatsapp', '')) end,
    document_number = coalesce(crm.norm_doc(c ->> 'document_number'), cu.document_number),
    birth_date      = coalesce(nullif(c ->> 'birth_date', '')::date, cu.birth_date),
    address         = case when v_newer and jsonb_typeof(c -> 'address') = 'object' then c -> 'address' else coalesce(cu.address, case when jsonb_typeof(c -> 'address') = 'object' then c -> 'address' end) end,
    city            = case when v_newer then coalesce(nullif(c ->> 'city', ''), cu.city) else coalesce(cu.city, nullif(c ->> 'city', '')) end,
    state           = case when v_newer then coalesce(nullif(c ->> 'state', ''), cu.state) else coalesce(cu.state, nullif(c ->> 'state', '')) end,
    zipcode         = case when v_newer then coalesce(nullif(c ->> 'zipcode', ''), cu.zipcode) else coalesce(cu.zipcode, nullif(c ->> 'zipcode', '')) end,
    neighborhood    = case when v_newer then coalesce(nullif(c ->> 'neighborhood', ''), cu.neighborhood) else coalesce(cu.neighborhood, nullif(c ->> 'neighborhood', '')) end,
    first_seen_at   = least(coalesce(cu.first_seen_at, p_occurred), p_occurred),
    last_seen_at    = greatest(coalesce(cu.last_seen_at, p_occurred), p_occurred),
    updated_at      = now()
  where cu.customer_id = v_customer;

  return v_customer;
end;
$$;

-- ---------------------------------------------------------------------
-- CATALOG / AFFILIATES
-- ---------------------------------------------------------------------

create function crm.upsert_catalog(p_ev jsonb) returns uuid
language plpgsql as $$
declare
  p jsonb := p_ev -> 'product';
  o jsonb := p_ev -> 'offer';
  cp jsonb := p_ev -> 'coupon';
  a jsonb := p_ev -> 'affiliate';
  v_aff uuid;
begin
  if nullif(p ->> 'id', '') is not null then
    insert into crm.products (product_id, name, type, product_type, cover, logo)
    values (p ->> 'id', p ->> 'name', p ->> 'type', p ->> 'product_type', p ->> 'cover', p ->> 'logo')
    on conflict (product_id) do update set
      name = coalesce(excluded.name, crm.products.name),
      type = coalesce(excluded.type, crm.products.type),
      product_type = coalesce(excluded.product_type, crm.products.product_type),
      cover = coalesce(excluded.cover, crm.products.cover),
      logo = coalesce(excluded.logo, crm.products.logo),
      updated_at = now();
  end if;

  if nullif(o ->> 'id', '') is not null then
    insert into crm.offers (offer_id, product_id, name, quantity, original_price)
    values (o ->> 'id', nullif(p ->> 'id', ''), o ->> 'name', crm.jnum(o, 'quantity'), crm.jnum(o, 'original_price'))
    on conflict (offer_id) do update set
      product_id = coalesce(excluded.product_id, crm.offers.product_id),
      name = coalesce(excluded.name, crm.offers.name),
      quantity = coalesce(excluded.quantity, crm.offers.quantity),
      original_price = coalesce(excluded.original_price, crm.offers.original_price),
      updated_at = now();
  end if;

  -- Coupons are stored as-is, even with amount = 0. No meaning is inferred.
  if nullif(cp ->> 'code', '') is not null then
    insert into crm.coupons (coupon_code, type, amount)
    values (cp ->> 'code', cp ->> 'type', crm.jnum(cp, 'amount'))
    on conflict (coupon_code) do update set
      type = coalesce(excluded.type, crm.coupons.type),
      amount = coalesce(excluded.amount, crm.coupons.amount),
      updated_at = now();
  end if;

  if nullif(a ->> 'id', '') is not null or crm.norm_email(a ->> 'email') is not null then
    select affiliate_id into v_aff from crm.affiliates
     where external_affiliate_id = nullif(a ->> 'id', '') or email = crm.norm_email(a ->> 'email')
     order by (external_affiliate_id = nullif(a ->> 'id', '')) desc nulls last
     limit 1;
    if v_aff is null then
      insert into crm.affiliates (external_affiliate_id, email, name, b4f)
      values (nullif(a ->> 'id', ''), crm.norm_email(a ->> 'email'), a ->> 'name', a ->> 'b4f')
      returning affiliate_id into v_aff;
    else
      update crm.affiliates set
        external_affiliate_id = coalesce(external_affiliate_id, nullif(a ->> 'id', '')),
        email = coalesce(email, crm.norm_email(a ->> 'email')),
        name = coalesce(nullif(a ->> 'name', ''), name),
        b4f = coalesce(nullif(a ->> 'b4f', ''), b4f),
        updated_at = now()
      where affiliate_id = v_aff;
    end if;
  end if;
  return v_aff;
end;
$$;

-- ---------------------------------------------------------------------
-- ATTRIBUTION
-- The first attributed touch becomes the customer's acquisition and stays.
-- A paid event without UTMs inherits the acquisition — it is NOT organic.
-- ---------------------------------------------------------------------

create function crm.record_attribution(p_ev jsonb, p_customer uuid, p_raw uuid, p_occurred timestamptz, p_revenue_event boolean)
returns uuid language plpgsql as $$
declare
  a jsonb := p_ev -> 'attribution';
  v_acq uuid;
  v_sub_acq uuid;
  v_id uuid;
begin
  select acquisition_attribution_id into v_acq from crm.customers where customer_id = p_customer;
  if nullif(p_ev ->> 'subscription_id', '') is not null then
    select acquisition_attribution_id into v_sub_acq from crm.subscriptions where subscription_id = p_ev ->> 'subscription_id';
  end if;

  if crm.has_values(a) then
    insert into crm.attributions (customer_id, raw_event_id, sale_id, subscription_id, touch_type, occurred_at,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, fbclid, gclid, ttclid, fbc, fbp,
      b1, b2, b3, sck, src, funnel_name, funnel_instance_id, extra)
    values (p_customer, p_raw, p_ev ->> 'sale_id', p_ev ->> 'subscription_id',
      case when v_acq is null then 'acquisition' else 'touch' end, p_occurred,
      a ->> 'utm_source', a ->> 'utm_medium', a ->> 'utm_campaign', a ->> 'utm_content', a ->> 'utm_term',
      a ->> 'utm_id', a ->> 'fbclid', a ->> 'gclid', a ->> 'ttclid', a ->> 'fbc', a ->> 'fbp',
      a ->> 'b1', a ->> 'b2', a ->> 'b3', a ->> 'sck', a ->> 'src', a ->> 'funnel_name', a ->> 'funnel_instance_id',
      coalesce(a -> 'extra', '{}'))
    on conflict (raw_event_id) do update set touch_type = crm.attributions.touch_type
    returning attribution_id into v_id;

    if v_acq is null then
      update crm.customers set
        acquisition_attribution_id = v_id,
        acquisition_source = coalesce(nullif(a ->> 'utm_source', ''), nullif(a ->> 'funnel_name', ''), nullif(a ->> 'src', ''))
      where customer_id = p_customer;
    end if;
    return v_id;
  end if;

  if p_revenue_event and coalesce(v_sub_acq, v_acq) is not null then
    insert into crm.attributions (customer_id, raw_event_id, sale_id, subscription_id, touch_type, inherited_from, occurred_at)
    values (p_customer, p_raw, p_ev ->> 'sale_id', p_ev ->> 'subscription_id', 'inherited', coalesce(v_sub_acq, v_acq), p_occurred)
    on conflict (raw_event_id) do update set touch_type = crm.attributions.touch_type
    returning attribution_id into v_id;
    return v_id;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- ORDERS / TRANSACTIONS
-- ---------------------------------------------------------------------

create function crm.tx_key(p_ev jsonb) returns text
language sql stable as $$
  select coalesce(
    nullif(p_ev ->> 'charge_id', ''),
    case when p_ev ->> 'event_type' = 'SUBSCRIPTION_RENEWED' and nullif(p_ev ->> 'subscription_id', '') is not null
         then 'sub:' || (p_ev ->> 'subscription_id') || ':' || to_char((p_ev ->> 'occurred_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD') end,
    case when nullif(p_ev ->> 'sale_id', '') is not null then 'sale:' || (p_ev ->> 'sale_id') end
  )
$$;

create function crm.upsert_order(p_ev jsonb, p_customer uuid, p_status text, p_occurred timestamptz,
                                 p_affiliate uuid, p_attribution uuid)
returns uuid language plpgsql as $$
declare
  v_id uuid;
  pay jsonb := coalesce(p_ev -> 'payment', '{}');
begin
  if nullif(p_ev ->> 'sale_id', '') is null then
    return null;
  end if;
  insert into crm.orders as o (sale_id, customer_id, group_id, subscription_id, product_id, offer_id, product_name,
    offer_name, quantity, currency, payment_method, installments, coupon_code, affiliate_id, attribution_id,
    status, created_at, paid_at)
  values (p_ev ->> 'sale_id', p_customer, p_ev ->> 'group_id', p_ev ->> 'subscription_id',
    nullif(p_ev -> 'product' ->> 'id', ''), nullif(p_ev -> 'offer' ->> 'id', ''),
    p_ev -> 'product' ->> 'name', p_ev -> 'offer' ->> 'name',
    coalesce(crm.jnum(p_ev, 'quantity'), crm.jnum(p_ev -> 'offer', 'quantity')),
    coalesce(p_ev ->> 'currency', 'BRL'), pay ->> 'method', (pay ->> 'installments')::int,
    nullif(p_ev -> 'coupon' ->> 'code', ''), p_affiliate, p_attribution,
    p_status, coalesce(crm.jts(pay, 'created_at'), p_occurred),
    case when p_status = 'PAID' then coalesce(crm.jts(pay, 'paid_at'), p_occurred) end)
  on conflict (sale_id) do update set
    group_id = coalesce(o.group_id, excluded.group_id),
    subscription_id = coalesce(o.subscription_id, excluded.subscription_id),
    product_id = coalesce(o.product_id, excluded.product_id),
    offer_id = coalesce(o.offer_id, excluded.offer_id),
    product_name = coalesce(o.product_name, excluded.product_name),
    offer_name = coalesce(o.offer_name, excluded.offer_name),
    quantity = coalesce(o.quantity, excluded.quantity),
    payment_method = coalesce(excluded.payment_method, o.payment_method),
    installments = coalesce(excluded.installments, o.installments),
    coupon_code = coalesce(o.coupon_code, excluded.coupon_code),
    affiliate_id = coalesce(o.affiliate_id, excluded.affiliate_id),
    attribution_id = coalesce(o.attribution_id, excluded.attribution_id),
    created_at = least(o.created_at, excluded.created_at),
    status = case when crm.order_rank(excluded.status) > crm.order_rank(o.status) then excluded.status else o.status end,
    paid_at = coalesce(o.paid_at, excluded.paid_at),
    updated_at = now()
  returning order_id into v_id;
  return v_id;
end;
$$;

create function crm.upsert_transaction(p_ev jsonb, p_customer uuid, p_order uuid, p_status text, p_occurred timestamptz)
returns uuid language plpgsql as $$
declare
  v_key text := crm.tx_key(p_ev);
  pay jsonb := coalesce(p_ev -> 'payment', '{}');
  sp jsonb := p_ev -> 'splits';
  v_id uuid;
begin
  if v_key is null then
    return null;
  end if;
  insert into crm.transactions as t (transaction_key, charge_id, sale_id, customer_id, subscription_id, order_id,
    amount, currency, status, payment_method, card_brand, card_last_four, installments, pix_url, pix_code,
    billet_url, billet_code, platform_fee, my_commission, affiliate_commission, released, release_date, splits,
    created_at, paid_at, failed_at)
  values (v_key, nullif(p_ev ->> 'charge_id', ''), nullif(p_ev ->> 'sale_id', ''), p_customer,
    nullif(p_ev ->> 'subscription_id', ''), p_order,
    crm.jnum(p_ev, 'amount'), coalesce(p_ev ->> 'currency', 'BRL'), p_status,
    coalesce(pay ->> 'method', 'unknown'), pay ->> 'card_brand', pay ->> 'card_last_four',
    (pay ->> 'installments')::int, pay ->> 'pix_url', pay ->> 'pix_code', pay ->> 'billet_url', pay ->> 'billet_code',
    crm.jnum(sp, 'fee'), crm.jnum(sp, 'my_commission'), crm.jnum(sp, 'affiliate_commission'),
    (sp ->> 'released')::boolean, crm.jts(sp, 'release_date'), sp -> 'raw',
    coalesce(crm.jts(pay, 'created_at'), p_occurred),
    case when p_status = 'PAID' then coalesce(crm.jts(pay, 'paid_at'), p_occurred) end,
    case when p_status = 'FAILED' then p_occurred end)
  on conflict (transaction_key) do update set
    order_id = coalesce(t.order_id, excluded.order_id),
    sale_id = coalesce(t.sale_id, excluded.sale_id),
    subscription_id = coalesce(t.subscription_id, excluded.subscription_id),
    amount = coalesce(excluded.amount, t.amount),
    payment_method = case when excluded.payment_method <> 'unknown' then excluded.payment_method else t.payment_method end,
    card_brand = coalesce(excluded.card_brand, t.card_brand),
    card_last_four = coalesce(excluded.card_last_four, t.card_last_four),
    installments = coalesce(excluded.installments, t.installments),
    pix_url = coalesce(excluded.pix_url, t.pix_url),
    pix_code = coalesce(excluded.pix_code, t.pix_code),
    billet_url = coalesce(excluded.billet_url, t.billet_url),
    billet_code = coalesce(excluded.billet_code, t.billet_code),
    platform_fee = coalesce(excluded.platform_fee, t.platform_fee),
    my_commission = coalesce(excluded.my_commission, t.my_commission),
    affiliate_commission = coalesce(excluded.affiliate_commission, t.affiliate_commission),
    released = coalesce(excluded.released, t.released),
    release_date = coalesce(excluded.release_date, t.release_date),
    splits = coalesce(excluded.splits, t.splits),
    status = case when crm.tx_rank(excluded.status) > crm.tx_rank(t.status) then excluded.status else t.status end,
    paid_at = coalesce(t.paid_at, excluded.paid_at),
    failed_at = coalesce(excluded.failed_at, t.failed_at),
    updated_at = now()
  returning transaction_id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- SUBSCRIPTIONS
-- Status is derived from the provider's CONFIRMED status (normalized
-- subscription.status), never from the event name alone.
-- ---------------------------------------------------------------------

create function crm.upsert_subscription(p_ev jsonb, p_customer uuid, p_raw uuid, p_occurred timestamptz,
                                        p_affiliate uuid, p_attribution uuid)
returns crm.subscriptions language plpgsql as $$
declare
  s jsonb := coalesce(p_ev -> 'subscription', '{}');
  v_id text := nullif(p_ev ->> 'subscription_id', '');
  v_status text := nullif(s ->> 'status', '');
  v_old crm.subscriptions;
  v_new crm.subscriptions;
  v_fresh boolean;
begin
  if v_id is null then
    return null;
  end if;

  select * into v_old from crm.subscriptions where subscription_id = v_id for update;

  if not found then
    insert into crm.subscriptions (subscription_id, customer_id, product_id, offer_id, plan_id, plan_name, frequency,
      status, provider_status, status_observed_at, start_date, next_charge_at, acquisition_attribution_id, affiliate_id)
    values (v_id, p_customer, nullif(p_ev -> 'product' ->> 'id', ''), nullif(p_ev -> 'offer' ->> 'id', ''),
      s ->> 'plan_id', s ->> 'plan_name', s ->> 'frequency',
      case when v_status in ('CANCELLED','INACTIVE','EXPIRED') then v_status else coalesce(v_status, 'ACTIVE') end,
      s ->> 'status_raw', case when v_status is not null then p_occurred end,
      coalesce(crm.jts(s, 'start_date'), p_occurred), crm.jts(s, 'next_charge_at'),
      (select acquisition_attribution_id from crm.customers where customer_id = p_customer), p_affiliate)
    returning * into v_new;

    perform crm.add_fact('sub_created:' || v_id, 'SUBSCRIPTION_CREATED', p_customer, p_ev, p_occurred, p_raw,
      jsonb_build_object('plan', s ->> 'plan_name', 'provider_status', s ->> 'status_raw'));
    update crm.customers set
      first_subscription_at = least(coalesce(first_subscription_at, p_occurred), p_occurred),
      last_subscription_at = greatest(coalesce(last_subscription_at, p_occurred), p_occurred)
    where customer_id = p_customer;
    v_old := v_new;
    v_old.status := null;  -- so the transition logic below sees "new"
  end if;

  v_fresh := p_occurred >= coalesce(v_old.status_observed_at, '-infinity'::timestamptz);

  update crm.subscriptions set
    plan_id = coalesce(s ->> 'plan_id', plan_id),
    plan_name = coalesce(s ->> 'plan_name', plan_name),
    frequency = coalesce(s ->> 'frequency', frequency),
    product_id = coalesce(product_id, nullif(p_ev -> 'product' ->> 'id', '')),
    offer_id = coalesce(offer_id, nullif(p_ev -> 'offer' ->> 'id', '')),
    next_charge_at = case when v_fresh then coalesce(crm.jts(s, 'next_charge_at'), next_charge_at) else next_charge_at end,
    provider_status = case when v_fresh and v_status is not null then s ->> 'status_raw' else provider_status end,
    status_observed_at = case when v_fresh and v_status is not null then p_occurred else status_observed_at end,
    affiliate_id = coalesce(affiliate_id, p_affiliate),
    updated_at = now()
  where subscription_id = v_id;

  -- Confirmed state transitions (only from fresh evidence).
  if v_fresh and v_status is not null then
    if v_status in ('CANCELLED','INACTIVE') and coalesce(v_old.status, '') not in ('CANCELLED','INACTIVE') then
      update crm.subscriptions set
        status = v_status, lifecycle_state = 'CANCELLED', risk_state = 'HEALTHY',
        cancelled_at = coalesce(crm.jts(s, 'cancelled_at'), p_occurred),
        cancellation_requested = false
      where subscription_id = v_id;
      perform crm.add_fact('sub_cancelled:' || v_id || ':' || p_occurred::text, 'SUBSCRIPTION_CANCELLED', p_customer, p_ev,
        p_occurred, p_raw, jsonb_build_object('requested_at', v_old.cancellation_requested_at));
    elsif v_status = 'EXPIRED' and coalesce(v_old.status, '') <> 'EXPIRED' then
      update crm.subscriptions set
        status = 'EXPIRED', lifecycle_state = 'CHURNED',
        expired_at = coalesce(crm.jts(s, 'expired_at'), p_occurred), cancellation_requested = false
      where subscription_id = v_id;
      perform crm.add_fact('sub_expired:' || v_id || ':' || p_occurred::text, 'SUBSCRIPTION_EXPIRED', p_customer, p_ev,
        p_occurred, p_raw);
    elsif v_status in ('ACTIVE','TRIAL') and v_old.status in ('CANCELLED','INACTIVE','EXPIRED') then
      update crm.subscriptions set
        status = 'REACTIVATED', lifecycle_state = 'REACTIVATED', reactivated_at = p_occurred,
        cancellation_requested = false, risk_state = 'HEALTHY'
      where subscription_id = v_id;
      perform crm.add_fact('sub_reactivated:' || v_id || ':' || p_occurred::text, 'SUBSCRIPTION_REACTIVATED', p_customer,
        p_ev, p_occurred, p_raw);
    elsif v_status in ('ACTIVE','TRIAL','PAUSED','PAYMENT_PENDING','PAYMENT_FAILED')
          and coalesce(v_old.status, '') not in ('CANCELLED','INACTIVE','EXPIRED') then
      update crm.subscriptions set
        status = case when v_status = 'ACTIVE' and status = 'REACTIVATED' then status else v_status end,
        lifecycle_state = case when lifecycle_state = 'NEW' and v_old.status is not null then 'ACTIVE' else lifecycle_state end
      where subscription_id = v_id;
    end if;
  end if;

  select * into v_new from crm.subscriptions where subscription_id = v_id;
  return v_new;
end;
$$;

-- A paid charge (first purchase or renewal). Idempotent per transaction key:
-- approved-payment and renewed-subscription for the same charge count once.
create function crm.apply_paid_charge(p_ev jsonb, p_customer uuid, p_raw uuid, p_occurred timestamptz,
                                      p_affiliate uuid, p_attribution uuid, p_is_renewal_event boolean)
returns void language plpgsql as $$
declare
  v_amount numeric := crm.jnum(p_ev, 'amount');
  v_key text := crm.tx_key(p_ev);
  v_order uuid;
  v_tx uuid;
  v_sub crm.subscriptions;
  v_cycle int;
  v_type text := 'PAYMENT_APPROVED';
  v_new_charge boolean := false;
  v_inserted boolean;
begin
  if v_amount is null then
    raise exception 'missing_amount: paid event without charges[].amount';
  end if;
  if v_key is null then
    raise exception 'missing_charge_reference: paid event without charge_id, sale_id or subscription_id';
  end if;
  if nullif(p_ev ->> 'charge_id', '') is null then
    perform crm.dq(p_raw, 'missing_charge_id', 'paid event without charge id; deduplicated by ' || v_key);
  end if;

  v_order := crm.upsert_order(p_ev, p_customer, 'PAID', p_occurred, p_affiliate, p_attribution);
  v_tx := crm.upsert_transaction(p_ev, p_customer, v_order, 'PAID', p_occurred);

  v_sub := crm.upsert_subscription(p_ev, p_customer, p_raw, p_occurred, p_affiliate, p_attribution);

  if v_sub.subscription_id is not null then
    if not exists (select 1 from crm.subscription_charges where charge_id = v_key) then
      v_cycle := coalesce((p_ev -> 'subscription' ->> 'cycle')::int, v_sub.current_cycle + 1);
      insert into crm.subscription_charges (charge_id, subscription_id, customer_id, sale_id, transaction_id, amount,
        currency, status, payment_method, due_at, created_at, paid_at, attempt_count, cycle_number)
      values (v_key, v_sub.subscription_id, p_customer, nullif(p_ev ->> 'sale_id', ''), v_tx, v_amount,
        coalesce(p_ev ->> 'currency', 'BRL'), 'PAID', p_ev -> 'payment' ->> 'method',
        crm.jts(p_ev -> 'payment', 'due_at'), p_occurred, p_occurred, 1, v_cycle);
      v_new_charge := true;
    else
      select cycle_number into v_cycle from crm.subscription_charges where charge_id = v_key;
      update crm.subscription_charges set
        status = case when status in ('PENDING','FAILED','LATE') then
                   case when status in ('FAILED','LATE') then 'RECOVERED' else 'PAID' end
                 else status end,
        recovered_at = case when status in ('FAILED','LATE') then p_occurred else recovered_at end,
        paid_at = coalesce(paid_at, p_occurred),
        amount = coalesce(amount, v_amount),
        transaction_id = coalesce(transaction_id, v_tx),
        updated_at = now()
      where charge_id = v_key and status in ('PENDING','FAILED','LATE');
      v_new_charge := found;
    end if;
    if coalesce(v_cycle, 1) > 1 or p_is_renewal_event then
      v_type := 'RENEWAL_PAYMENT';
    end if;
  end if;

  v_inserted := crm.add_financial('paid:' || v_key, v_type, p_customer, p_ev, v_tx, v_amount,
                                  crm.jnum(p_ev -> 'splits', 'fee'), p_occurred, p_raw);

  if v_sub.subscription_id is not null and v_inserted then
    update crm.subscriptions set
      current_cycle = greatest(current_cycle, coalesce(v_cycle, current_cycle + 1)),
      total_cycles = total_cycles + 1,
      total_revenue = total_revenue + v_amount,
      net_revenue = total_revenue + v_amount - total_refunds,
      last_charge_at = greatest(coalesce(last_charge_at, p_occurred), p_occurred),
      renewed_at = case when v_type = 'RENEWAL_PAYMENT' then greatest(coalesce(renewed_at, p_occurred), p_occurred) else renewed_at end,
      payment_state = case when payment_state in ('LATE','FAILED','DUE') then 'RECOVERED' else 'CURRENT' end,
      risk_state = case when risk_state in ('AT_RISK','PAYMENT_RISK','HIGH_VALUE_AT_RISK') then 'HEALTHY' else risk_state end,
      lifecycle_state = case
        when lifecycle_state in ('CANCELLED','CHURNED') then lifecycle_state
        when v_type = 'RENEWAL_PAYMENT' then 'RENEWED'
        when lifecycle_state = 'NEW' then 'NEW'
        else lifecycle_state end,
      -- Paying again after asking to cancel = saved by retention.
      cancellation_requested = case when v_type = 'RENEWAL_PAYMENT' then false else cancellation_requested end,
      expiring_at = null,
      updated_at = now()
    where subscription_id = v_sub.subscription_id;

    if v_sub.payment_state in ('LATE','FAILED','DUE') then
      perform crm.add_fact('recovered:' || v_key, 'SUBSCRIPTION_PAYMENT_RECOVERED', p_customer, p_ev, p_occurred, p_raw,
        jsonb_build_object('previous_payment_state', v_sub.payment_state));
    end if;
    if v_type = 'RENEWAL_PAYMENT' then
      perform crm.add_fact('renewed:' || v_key, 'SUBSCRIPTION_RENEWED', p_customer, p_ev, p_occurred, p_raw,
        jsonb_build_object('cycle', v_cycle, 'amount', v_amount));
      if v_sub.cancellation_requested then
        perform crm.add_fact('saved:' || v_key, 'SUBSCRIPTION_SAVED', p_customer, p_ev, p_occurred, p_raw,
          jsonb_build_object('requested_at', v_sub.cancellation_requested_at));
      end if;
    end if;
  end if;

  if v_inserted then
    perform crm.add_fact('purchase:' || v_key, case when v_type = 'RENEWAL_PAYMENT' then 'RENEWAL_PAID' else 'PURCHASE_PAID' end,
      p_customer, p_ev, p_occurred, p_raw,
      jsonb_build_object('amount', v_amount, 'product_id', p_ev -> 'product' ->> 'id', 'offer_id', p_ev -> 'offer' ->> 'id'));
  end if;

  -- An earlier abandoned checkout of the same customer/offer converted.
  update crm.checkouts set status = 'CONVERTED', converted_at = p_occurred, converted_sale_id = nullif(p_ev ->> 'sale_id', '')
   where customer_id = p_customer and status = 'ABANDONED' and abandoned_at <= p_occurred
     and (offer_id is not distinct from nullif(p_ev -> 'offer' ->> 'id', '')
          or product_id is not distinct from nullif(p_ev -> 'product' ->> 'id', ''));

  -- Order gross = what was actually paid on its transactions.
  if v_order is not null then
    update crm.orders o set gross_amount = (
      select sum(amount) from crm.transactions t where t.order_id = o.order_id and t.paid_at is not null)
    where o.order_id = v_order;
  end if;
end;
$$;

create function crm.apply_refund(p_ev jsonb, p_customer uuid, p_raw uuid, p_occurred timestamptz, p_kind text)
returns void language plpgsql as $$
declare
  r jsonb := coalesce(p_ev -> 'refund', '{}');
  v_key text := crm.tx_key(p_ev);
  v_tx crm.transactions;
  v_amount numeric;
  v_paid numeric;
  v_kind text := p_kind;
  v_dedupe text;
  v_refund uuid;
  v_status text;
  v_aff uuid;
begin
  if v_key is null then
    raise exception 'missing_charge_reference: refund without charge_id or sale_id';
  end if;

  select * into v_tx from crm.transactions where transaction_key = v_key;
  if not found then
    -- Refund evidence for a payment we never saw: keep the evidence, invent no revenue.
    perform crm.dq(p_raw, 'refund_without_payment', 'refund received for an unknown payment ' || v_key);
    perform crm.upsert_transaction(p_ev, p_customer, crm.upsert_order(p_ev, p_customer, 'PENDING', p_occurred, null, null),
                                   'PENDING', p_occurred);
    select * into v_tx from crm.transactions where transaction_key = v_key;
  end if;

  v_paid := case when v_tx.paid_at is not null then v_tx.amount end;
  v_amount := coalesce(crm.jnum(r, 'amount'), v_tx.amount, crm.jnum(p_ev, 'amount'));
  if v_amount is null then
    raise exception 'missing_amount: refund without amount';
  end if;

  if v_kind = 'REFUND' and v_paid is not null and v_tx.refunded_amount + v_amount < v_paid then
    v_kind := 'PARTIAL_REFUND';
  end if;

  v_dedupe := coalesce('refund:' || nullif(r ->> 'refund_id', ''),
                       lower(p_kind) || ':' || v_key || ':' || v_amount::text);

  select affiliate_id into v_aff from crm.orders where order_id = v_tx.order_id;

  insert into crm.refunds (dedupe_key, external_refund_id, sale_id, charge_id, transaction_id, customer_id,
    subscription_id, affiliate_id, amount, kind, reason, status, raw_event_id, created_at)
  values (v_dedupe, nullif(r ->> 'refund_id', ''), v_tx.sale_id, v_tx.charge_id, v_tx.transaction_id, p_customer,
    coalesce(v_tx.subscription_id, nullif(p_ev ->> 'subscription_id', '')), v_aff, v_amount, v_kind,
    r ->> 'reason', r ->> 'status', p_raw, p_occurred)
  on conflict (dedupe_key) do nothing
  returning refund_id into v_refund;

  if v_refund is null then
    return;  -- same refund already applied
  end if;

  v_status := case
    when v_kind = 'CHARGEBACK' then 'CHARGEBACK'
    when v_kind = 'PARTIAL_REFUND' then 'PARTIALLY_REFUNDED'
    else 'REFUNDED' end;

  update crm.transactions set
    refunded_amount = refunded_amount + v_amount,
    status = case when crm.tx_rank(v_status) > crm.tx_rank(status) then v_status else status end,
    refunded_at = case when v_kind <> 'CHARGEBACK' then coalesce(refunded_at, p_occurred) else refunded_at end,
    chargeback_at = case when v_kind = 'CHARGEBACK' then p_occurred else chargeback_at end,
    updated_at = now()
  where transaction_id = v_tx.transaction_id;

  update crm.orders set
    status = case when crm.order_rank(v_status) > crm.order_rank(status) then v_status else status end,
    refunded_at = coalesce(refunded_at, p_occurred),
    updated_at = now()
  where order_id = v_tx.order_id;

  perform crm.add_financial(v_dedupe, v_kind, p_customer, p_ev, v_tx.transaction_id, v_amount, null, p_occurred, p_raw);

  -- Refund ≠ cancellation: the subscription keeps its status.
  if coalesce(v_tx.subscription_id, nullif(p_ev ->> 'subscription_id', '')) is not null then
    update crm.subscriptions set
      total_refunds = total_refunds + v_amount,
      net_revenue = total_revenue - (total_refunds + v_amount),
      updated_at = now()
    where subscription_id = coalesce(v_tx.subscription_id, p_ev ->> 'subscription_id');
    update crm.subscription_charges set
      status = case when v_kind = 'CHARGEBACK' then 'CHARGEBACK'
                    when v_kind = 'PARTIAL_REFUND' then 'PARTIALLY_REFUNDED' else 'REFUNDED' end,
      updated_at = now()
    where charge_id = v_key;
  end if;

  perform crm.add_fact('fact_' || v_dedupe, case when v_kind = 'CHARGEBACK' then 'CHARGEBACK_RECEIVED' else 'REFUND_ISSUED' end,
    p_customer, p_ev, p_occurred, p_raw, jsonb_build_object('amount', v_amount, 'kind', v_kind, 'reason', r ->> 'reason'));
end;
$$;

-- ---------------------------------------------------------------------
-- FULFILLMENT
-- ---------------------------------------------------------------------

create function crm.apply_tracking(p_ev jsonb, p_customer uuid, p_raw uuid, p_occurred timestamptz)
returns void language plpgsql as $$
declare
  f jsonb := coalesce(p_ev -> 'fulfillment', '{}');
  v_key text := coalesce(nullif(f ->> 'tracking_code', ''),
                         case when nullif(p_ev ->> 'sale_id', '') is not null then 'sale:' || (p_ev ->> 'sale_id') end);
  v_status text := coalesce(nullif(f ->> 'status', ''), 'FULFILLMENT_CREATED');
  v_id uuid;
  v_last timestamptz;
begin
  if v_key is null then
    raise exception 'missing_fulfillment_reference: tracking without tracking_code or sale_id';
  end if;

  select max(fe.occurred_at) into v_last
    from crm.fulfillment_events fe join crm.fulfillments fu using (fulfillment_id)
   where fu.fulfillment_key = v_key;

  insert into crm.fulfillments as fu (fulfillment_key, customer_id, sale_id, order_id, carrier, tracking_code, tracking_url,
    shipping_cost, status, provider_status, created_at, shipped_at, estimated_delivery_at, delivered_at)
  values (v_key, p_customer, nullif(p_ev ->> 'sale_id', ''),
    (select order_id from crm.orders where sale_id = p_ev ->> 'sale_id'),
    f ->> 'carrier', f ->> 'tracking_code', f ->> 'tracking_url', crm.jnum(f, 'shipping_cost'),
    v_status, f ->> 'provider_status', p_occurred,
    coalesce(crm.jts(f, 'shipped_at'), case when v_status in ('SHIPPED','IN_TRANSIT','OUT_FOR_DELIVERY') then p_occurred end),
    crm.jts(f, 'estimated_delivery_at'),
    coalesce(crm.jts(f, 'delivered_at'), case when v_status = 'DELIVERED' then p_occurred end))
  on conflict (fulfillment_key) do update set
    order_id = coalesce(fu.order_id, excluded.order_id),
    carrier = coalesce(excluded.carrier, fu.carrier),
    tracking_url = coalesce(excluded.tracking_url, fu.tracking_url),
    shipping_cost = coalesce(excluded.shipping_cost, fu.shipping_cost),
    status = case when p_occurred >= coalesce(v_last, '-infinity'::timestamptz) then excluded.status else fu.status end,
    provider_status = case when p_occurred >= coalesce(v_last, '-infinity'::timestamptz) then excluded.provider_status else fu.provider_status end,
    shipped_at = coalesce(fu.shipped_at, excluded.shipped_at),
    estimated_delivery_at = coalesce(excluded.estimated_delivery_at, fu.estimated_delivery_at),
    delivered_at = coalesce(fu.delivered_at, excluded.delivered_at),
    updated_at = now()
  returning fulfillment_id into v_id;

  insert into crm.fulfillment_events (fulfillment_id, status, provider_status, occurred_at, raw_event_id)
  values (v_id, v_status, f ->> 'provider_status', p_occurred, p_raw)
  on conflict do nothing;

  perform crm.add_fact('fulfillment:' || v_key || ':' || v_status, 'FULFILLMENT_' || v_status, p_customer, p_ev,
    p_occurred, p_raw, jsonb_build_object('carrier', f ->> 'carrier', 'tracking_code', f ->> 'tracking_code'));
end;
$$;

-- ---------------------------------------------------------------------
-- CUSTOMER AGGREGATES + TYPE (recomputed from facts, never incremented blindly)
-- ---------------------------------------------------------------------

create function crm.refresh_customer(p_customer uuid) returns void
language plpgsql as $$
declare
  v_gross numeric; v_refund numeric; v_cb numeric; v_sub_rev numeric; v_ren_rev numeric; v_fees numeric;
  v_paid_count int; v_sub_paid int; v_first timestamptz; v_last timestamptz;
  v_orders int; v_paid_orders int; v_refunds int; v_ship numeric;
  v_one_time int; v_active_sub boolean; v_ever_sub boolean; v_reactivated boolean;
  v_last_cancel timestamptz; v_last_one_time timestamptz; v_prospect boolean;
  v_type text;
begin
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

  select bool_or(status in ('TRIAL','ACTIVE','PAUSED','PAYMENT_PENDING','PAYMENT_FAILED','REACTIVATED')),
         count(*) > 0,
         bool_or(reactivated_at is not null),
         max(coalesce(cancelled_at, expired_at))
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
    first_purchase_at = v_first,
    last_purchase_at = v_last,
    average_order_value = case when v_paid_count > 0 then round(v_gross / v_paid_count, 2) end,
    average_subscription_cycle_value = case when v_sub_paid > 0 then round(v_sub_rev / v_sub_paid, 2) end,
    current_customer_type = v_type,
    updated_at = now()
  where customer_id = p_customer;
end;
$$;

-- ---------------------------------------------------------------------
-- APPLY ONE NORMALIZED EVENT
-- ---------------------------------------------------------------------

create function crm.apply_event(p_raw uuid, p_ev jsonb) returns jsonb
language plpgsql as $$
declare
  v_type text := p_ev ->> 'event_type';
  v_occurred timestamptz := coalesce(crm.jts(p_ev, 'occurred_at'), now());
  v_customer uuid;
  v_aff uuid;
  v_attr uuid;
  v_sub crm.subscriptions;
  v_status text := 'PROCESSED';
  v_key text;
  v_charge text;
  w jsonb;
begin
  if v_type is null or v_type = 'UNKNOWN' then
    -- Kept in the store; can be reprocessed once a handler exists.
    return jsonb_build_object('status', 'IGNORED', 'reason', 'unhandled_event_type');
  end if;

  v_aff := crm.upsert_catalog(p_ev);
  v_customer := crm.resolve_customer(p_ev, p_raw, v_occurred);
  v_attr := crm.record_attribution(p_ev, v_customer, p_raw, v_occurred,
                                   v_type in ('PAYMENT_APPROVED','SUBSCRIPTION_RENEWED'));

  for w in select * from jsonb_array_elements(coalesce(p_ev -> 'warnings', '[]')) loop
    perform crm.dq(p_raw, w ->> 'code', w ->> 'message', coalesce(w -> 'context', '{}'));
  end loop;

  case v_type
    when 'CHECKOUT_ABANDONED' then
      -- Never an order, never revenue, never a subscription.
      v_key := 'abandoned:' || v_customer || ':' || coalesce(nullif(p_ev -> 'offer' ->> 'id', ''), nullif(p_ev -> 'product' ->> 'id', ''), '')
               || ':' || to_char(date_trunc('hour', v_occurred at time zone 'UTC'), 'YYYYMMDDHH24');
      if crm.add_fact(v_key, 'CHECKOUT_ABANDONED', v_customer, p_ev, v_occurred, p_raw,
           jsonb_build_object('product_id', p_ev -> 'product' ->> 'id', 'offer_id', p_ev -> 'offer' ->> 'id',
                              'checkout_url', p_ev ->> 'checkout_url')) then
        insert into crm.checkouts (customer_id, raw_event_id, sale_id, product_id, offer_id, abandoned_at, checkout_url, amount)
        values (v_customer, p_raw, nullif(p_ev ->> 'sale_id', ''), nullif(p_ev -> 'product' ->> 'id', ''),
                nullif(p_ev -> 'offer' ->> 'id', ''), v_occurred, p_ev ->> 'checkout_url', crm.jnum(p_ev, 'amount'))
        on conflict (raw_event_id) do nothing;
      end if;

    when 'PAYMENT_PENDING' then
      -- Generated PIX/boleto: pending, never approved — even if the payload says "paid".
      perform crm.upsert_transaction(p_ev, v_customer,
        crm.upsert_order(p_ev, v_customer, 'PENDING', v_occurred, v_aff, v_attr), 'PENDING', v_occurred);
      v_key := crm.tx_key(p_ev);
      if v_key is not null then
        perform crm.add_financial('pending:' || v_key, 'PAYMENT_PENDING', v_customer, p_ev,
          (select transaction_id from crm.transactions where transaction_key = v_key), crm.jnum(p_ev, 'amount'),
          null, v_occurred, p_raw);
      end if;
      perform crm.upsert_subscription(p_ev, v_customer, p_raw, v_occurred, v_aff, v_attr);
      perform crm.add_fact('pending:' || coalesce(v_key, p_raw::text), 'PAYMENT_PENDING', v_customer, p_ev, v_occurred, p_raw,
        jsonb_build_object('method', p_ev -> 'payment' ->> 'method', 'amount', crm.jnum(p_ev, 'amount')));

    when 'PAYMENT_APPROVED' then
      perform crm.apply_paid_charge(p_ev, v_customer, p_raw, v_occurred, v_aff, v_attr, false);

    when 'SUBSCRIPTION_RENEWED' then
      if nullif(p_ev ->> 'subscription_id', '') is null then
        raise exception 'missing_subscription_id: renewal without subscription id';
      end if;
      perform crm.apply_paid_charge(p_ev, v_customer, p_raw, v_occurred, v_aff, v_attr, true);

    when 'PAYMENT_FAILED' then
      v_key := crm.tx_key(p_ev);
      perform crm.upsert_transaction(p_ev, v_customer,
        crm.upsert_order(p_ev, v_customer, 'FAILED', v_occurred, v_aff, v_attr), 'FAILED', v_occurred);
      if v_key is not null then
        perform crm.add_financial('failed:' || v_key || ':' || v_occurred::text, 'PAYMENT_FAILED', v_customer, p_ev,
          (select transaction_id from crm.transactions where transaction_key = v_key), crm.jnum(p_ev, 'amount'),
          null, v_occurred, p_raw);
      end if;
      v_sub := crm.upsert_subscription(p_ev, v_customer, p_raw, v_occurred, v_aff, v_attr);
      if v_sub.subscription_id is not null and v_key is not null then
        insert into crm.subscription_charges as sc (charge_id, subscription_id, customer_id, sale_id, amount, status,
          payment_method, created_at, failed_at, attempt_count)
        values (v_key, v_sub.subscription_id, v_customer, nullif(p_ev ->> 'sale_id', ''), crm.jnum(p_ev, 'amount'),
          'FAILED', p_ev -> 'payment' ->> 'method', v_occurred, v_occurred, 1)
        on conflict (charge_id) do update set
          status = case when sc.status in ('PENDING','LATE','FAILED') then 'FAILED' else sc.status end,
          failed_at = v_occurred, attempt_count = sc.attempt_count + 1, updated_at = now();
        update crm.subscriptions set payment_state = 'FAILED', risk_state = 'PAYMENT_RISK', updated_at = now()
         where subscription_id = v_sub.subscription_id and payment_state <> 'REFUNDED';
      end if;
      perform crm.add_fact('payment_failed:' || coalesce(v_key, p_raw::text) || ':' || v_occurred::text, 'PAYMENT_FAILED',
        v_customer, p_ev, v_occurred, p_raw, jsonb_build_object('method', p_ev -> 'payment' ->> 'method'));

    when 'REFUND' then
      perform crm.apply_refund(p_ev, v_customer, p_raw, v_occurred, 'REFUND');

    when 'CHARGEBACK' then
      perform crm.apply_refund(p_ev, v_customer, p_raw, v_occurred, 'CHARGEBACK');

    when 'SUBSCRIPTION_LATE' then
      -- Late ≠ cancelled: status stays whatever the provider confirms.
      v_sub := crm.upsert_subscription(p_ev, v_customer, p_raw, v_occurred, v_aff, v_attr);
      if v_sub.subscription_id is null then
        raise exception 'missing_subscription_id: late-subscription without subscription id';
      end if;
      v_charge := nullif(p_ev ->> 'charge_id', '');
      if v_charge is not null then
        insert into crm.subscription_charges as sc (charge_id, subscription_id, customer_id, sale_id, amount, status,
          created_at, late_at, due_at)
        values (v_charge, v_sub.subscription_id, v_customer, nullif(p_ev ->> 'sale_id', ''), crm.jnum(p_ev, 'amount'),
          'LATE', v_occurred, v_occurred, crm.jts(p_ev -> 'subscription', 'next_charge_at'))
        on conflict (charge_id) do update set
          status = case when sc.status in ('PENDING','FAILED') then 'LATE' else sc.status end,
          late_at = coalesce(sc.late_at, v_occurred), updated_at = now();
      end if;
      update crm.subscriptions set
        payment_state = 'LATE',
        late_at = v_occurred,
        risk_state = case when risk_state = 'HIGH_VALUE_AT_RISK' then risk_state else 'AT_RISK' end,
        updated_at = now()
      where subscription_id = v_sub.subscription_id and status not in ('CANCELLED','INACTIVE','EXPIRED');
      perform crm.add_fact('late:' || v_sub.subscription_id || ':' || coalesce(v_charge, to_char(v_occurred at time zone 'UTC', 'YYYY-MM-DD')),
        'SUBSCRIPTION_PAYMENT_LATE', v_customer, p_ev, v_occurred, p_raw,
        jsonb_build_object('provider_status', p_ev -> 'subscription' ->> 'status_raw'));

    when 'SUBSCRIPTION_CANCELED' then
      v_sub := crm.upsert_subscription(p_ev, v_customer, p_raw, v_occurred, v_aff, v_attr);
      if v_sub.subscription_id is null then
        raise exception 'missing_subscription_id: canceled-subscription without subscription id';
      end if;
      -- The event name says "canceled", but only a confirmed inactive/cancelled
      -- status ends the subscription (handled in upsert_subscription). If the
      -- provider still reports it active, this is a cancellation REQUEST.
      if v_sub.status not in ('CANCELLED','INACTIVE','EXPIRED') then
        update crm.subscriptions set
          cancellation_requested = true,
          cancellation_requested_at = coalesce(cancellation_requested_at, v_occurred),
          lifecycle_state = 'CANCELLATION_REQUESTED',
          risk_state = 'CHURN_RISK',
          updated_at = now()
        where subscription_id = v_sub.subscription_id;
        perform crm.add_fact('cancel_requested:' || v_sub.subscription_id || ':' || to_char(v_occurred at time zone 'UTC', 'YYYY-MM-DD'),
          'SUBSCRIPTION_CANCELLATION_REQUESTED', v_customer, p_ev, v_occurred, p_raw,
          jsonb_build_object('provider_status', p_ev -> 'subscription' ->> 'status_raw', 'cycle', v_sub.current_cycle));
      end if;

    when 'SUBSCRIPTION_EXPIRING' then
      -- Expiring ≠ cancelled.
      v_sub := crm.upsert_subscription(p_ev, v_customer, p_raw, v_occurred, v_aff, v_attr);
      if v_sub.subscription_id is null then
        raise exception 'missing_subscription_id: expiring event without subscription id';
      end if;
      update crm.subscriptions set
        expiring_at = coalesce(crm.jts(p_ev -> 'subscription', 'next_charge_at'), next_charge_at),
        lifecycle_state = case when lifecycle_state in ('CANCELLATION_REQUESTED','CANCELLED','CHURNED') then lifecycle_state else 'EXPIRING' end,
        updated_at = now()
      where subscription_id = v_sub.subscription_id;
      perform crm.add_fact('expiring:' || v_sub.subscription_id || ':' ||
          coalesce(p_ev -> 'subscription' ->> 'next_charge_at', to_char(v_occurred at time zone 'UTC', 'YYYY-MM-DD')),
        'SUBSCRIPTION_EXPIRING_SOON', v_customer, p_ev, v_occurred, p_raw,
        jsonb_build_object('expiring_at', p_ev -> 'subscription' ->> 'next_charge_at'));

    when 'TRACKING' then
      -- Tracking ≠ new purchase.
      perform crm.apply_tracking(p_ev, v_customer, p_raw, v_occurred);

    when 'AFFILIATION' then
      perform crm.add_fact('affiliation:' || p_raw::text, 'AFFILIATION_' || coalesce(upper(p_ev ->> 'affiliation_status'), 'EVENT'),
        v_customer, p_ev, v_occurred, p_raw);

    else
      return jsonb_build_object('status', 'IGNORED', 'reason', 'unhandled_event_type', 'customer_id', v_customer);
  end case;

  perform crm.refresh_customer(v_customer);
  return jsonb_build_object('status', v_status, 'customer_id', v_customer);
end;
$$;

-- Runs apply_event in a sub-transaction: on error, nothing derived is kept,
-- the raw event is marked for retry (or dead-lettered) and the batch goes on.
create function crm.process_event(p_raw uuid, p_normalized jsonb) returns jsonb
language plpgsql as $$
declare
  v_started timestamptz := clock_timestamp();
  v_event crm.events;
  v_result jsonb;
  v_status text;
begin
  select * into v_event from crm.events where id = p_raw;
  if not found then
    raise exception 'unknown raw event %', p_raw;
  end if;
  if v_event.processing_status in ('PROCESSED','IGNORED') then
    return jsonb_build_object('status', v_event.processing_status, 'already_processed', true);
  end if;

  perform set_config('crm.actor', 'event:' || v_event.event_id, true);

  begin
    v_result := crm.apply_event(p_raw, p_normalized);
    v_status := v_result ->> 'status';

    update crm.events set
      processing_status = v_status,
      processed_at = now(),
      processing_error = null,
      next_retry_at = null,
      normalized = p_normalized,
      event_type = p_normalized ->> 'event_type',
      occurred_at = crm.jts(p_normalized, 'occurred_at'),
      customer_id = (v_result ->> 'customer_id')::uuid,
      sale_id = nullif(p_normalized ->> 'sale_id', ''),
      group_id = nullif(p_normalized ->> 'group_id', ''),
      subscription_id = nullif(p_normalized ->> 'subscription_id', ''),
      charge_id = nullif(p_normalized ->> 'charge_id', ''),
      product_id = nullif(p_normalized -> 'product' ->> 'id', ''),
      offer_id = nullif(p_normalized -> 'offer' ->> 'id', ''),
      processing_warnings = coalesce(p_normalized -> 'warnings', '[]')
    where id = p_raw;

    insert into crm.event_processing_logs (raw_event_id, processing_started, processing_finished, processing_status,
                                           processing_duration_ms, retry_count)
    values (p_raw, v_started, clock_timestamp(), v_status,
            (extract(epoch from clock_timestamp() - v_started) * 1000)::int, v_event.retry_count);
    return v_result;
  exception when others then
    update crm.events set
      normalized = p_normalized,
      event_type = p_normalized ->> 'event_type',
      occurred_at = coalesce(crm.jts(p_normalized, 'occurred_at'), occurred_at)
    where id = p_raw;
    v_status := crm.fail_event(p_raw, sqlerrm, sqlerrm like 'missing\_%', v_started);
    return jsonb_build_object('status', v_status, 'error', sqlerrm);
  end;
end;
$$;

-- ---------------------------------------------------------------------
-- BACKFILL from the legacy analytics store (public.events.metadata.raw_payload).
-- Same hash as live ingestion, so dual-written events are never duplicated.
-- ---------------------------------------------------------------------

create function crm.backfill_from_legacy(p_limit int default 5000) returns int
language plpgsql as $$
declare v_count int := 0; r record;
begin
  for r in
    select e.metadata -> 'raw_payload' as payload, e.created_at
      from public.events e
     where e.metadata ->> 'provider' = 'b4you' and jsonb_typeof(e.metadata -> 'raw_payload') = 'object'
       and not exists (select 1 from crm.events c where c.source = 'b4you'
                        and c.payload_hash = encode(digest((e.metadata -> 'raw_payload')::text, 'sha256'), 'hex'))
     order by e."timestamp"
     limit p_limit
  loop
    perform crm.ingest_raw('b4you', r.payload ->> 'event_name', null, r.payload, 'v1', '{}', r.created_at);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Sends dead-lettered events back to the queue (e.g. after a normalizer fix).
-- The raw payload is unchanged; derived data is rebuilt idempotently.
create function crm.requeue_dead_letters(p_error_prefix text default null) returns int
language plpgsql as $$
declare v_count int;
begin
  with q as (
    update crm.events set processing_status = 'RECEIVED', retry_count = 0, next_retry_at = null
     where processing_status = 'DEAD_LETTER'
       and (p_error_prefix is null or processing_error like p_error_prefix || '%')
    returning id
  ), r as (
    update crm.dead_letter_events d set resolved_at = now(), resolution = 'requeued'
      from q where d.raw_event_id = q.id and d.resolved_at is null
    returning 1
  )
  select count(*) into v_count from q;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- PUBLIC ENTRY POINTS (service_role only; the crm schema is not exposed)
-- ---------------------------------------------------------------------

create function public.crm_ingest_event(p_source text, p_event_name text, p_source_event_id text, p_payload jsonb,
                                        p_schema_version text default 'v1', p_redacted text[] default '{}')
returns table (id uuid, event_id text, duplicate boolean, processing_status text)
language sql security definer set search_path = crm, public, extensions as $$
  select * from crm.ingest_raw(p_source, p_event_name, p_source_event_id, p_payload, p_schema_version, p_redacted, now())
$$;

create function public.crm_claim_events(p_limit int default 50, p_id uuid default null)
returns table (id uuid, event_id text, source text, event_name text, payload jsonb,
               schema_version text, retry_count int, received_at timestamptz)
language sql security definer set search_path = crm, public, extensions as $$
  select * from crm.claim_events(p_limit, p_id)
$$;

create function public.crm_process_event(p_raw_event_id uuid, p_normalized jsonb) returns jsonb
language sql security definer set search_path = crm, public, extensions as $$
  select crm.process_event(p_raw_event_id, p_normalized)
$$;

create function public.crm_fail_event(p_raw_event_id uuid, p_error text, p_fatal boolean default false) returns text
language sql security definer set search_path = crm, public, extensions as $$
  select crm.fail_event(p_raw_event_id, p_error, p_fatal)
$$;

create function public.crm_dead_letter_request(p_source text, p_reason text, p_error text, p_raw_body text)
returns void language sql security definer set search_path = crm, public, extensions as $$
  insert into crm.dead_letter_events (source, reason, error, raw_body) values (p_source, p_reason, p_error, left(p_raw_body, 1000000))
$$;

create function public.crm_requeue_dead_letters(p_error_prefix text default null) returns int
language sql security definer set search_path = crm, public, extensions as $$
  select crm.requeue_dead_letters(p_error_prefix)
$$;

create function public.crm_backfill_from_legacy(p_limit int default 5000) returns int
language sql security definer set search_path = crm, public, extensions as $$
  select crm.backfill_from_legacy(p_limit)
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_ingest_event(text,text,text,jsonb,text,text[])',
    'crm_claim_events(int,uuid)',
    'crm_process_event(uuid,jsonb)',
    'crm_fail_event(uuid,text,boolean)',
    'crm_dead_letter_request(text,text,text,text)',
    'crm_backfill_from_legacy(int)',
    'crm_requeue_dead_letters(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
