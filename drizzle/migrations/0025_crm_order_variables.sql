-- =====================================================================
-- KAKAUMA CRM — order variables in messages
--
--   {{order_number}} {{order_date}} {{order_total}} {{product_name}} {{offer_name}}
--   {{quantity}} {{product_image}} {{payment_method}} {{installments}} {{coupon_code}}
--   {{pix_code}} {{pix_url}} {{boleto_url}} {{boleto_code}} {{checkout_url}}
--   {{tracking_code}} {{tracking_url}} {{carrier}} {{plan_name}} {{next_charge_date}}
--
--   Taken from the B4you event that put the customer in the flow (purchase,
--   Pix/boleto generated, abandoned checkout, tracking…). When the flow did not
--   start from an order event (e.g. entered a segment), the customer's latest order.
--   Missing data stays empty. Money as "R$ 1.234,56", dates as DD/MM/YYYY.
-- =====================================================================

create or replace function crm.brl(p numeric) returns text
language sql immutable as $$
  select case when p is null then null
              else 'R$ ' || translate(to_char(p, 'FM999,999,999,990.00'), ',.', '.,') end
$$;

create or replace function crm.order_vars(p_customer uuid, p_trigger uuid default null) returns jsonb
language plpgsql stable set search_path = crm, public, extensions as $$
declare
  ev crm.customer_events;
  n jsonb;
  o crm.orders;
  ck crm.checkouts;
  t crm.transactions;
  s crm.subscriptions;
  f crm.fulfillments;
  pr crm.products;
  ofr crm.offers;
  v_sale text;
  v_method text;
  v_inst int;
  v_qty numeric;
  v_paid timestamptz;
begin
  if p_trigger is not null then
    select * into ev from crm.customer_events where id = p_trigger;
    if ev.raw_event_id is not null then
      select normalized into n from crm.events where id = ev.raw_event_id;
      select * into ck from crm.checkouts where raw_event_id = ev.raw_event_id;
    end if;
  end if;
  v_sale := coalesce(ev.sale_id, nullif(n ->> 'sale_id', ''));
  if v_sale is not null then
    select * into o from crm.orders where sale_id = v_sale;
  end if;
  -- the flow did not start from an order event: the latest order
  if n is null and o.order_id is null then
    select * into o from crm.orders where customer_id = p_customer
     order by coalesce(paid_at, created_at) desc nulls last limit 1;
    v_sale := o.sale_id;
  end if;
  if v_sale is not null then
    select * into t from crm.transactions where sale_id = v_sale
     order by coalesce(paid_at, created_at) desc nulls last limit 1;
    select * into f from crm.fulfillments where sale_id = v_sale order by updated_at desc limit 1;
  end if;
  select * into s from crm.subscriptions
   where subscription_id = coalesce(ev.subscription_id, o.subscription_id, nullif(n ->> 'subscription_id', ''));
  select * into pr from crm.products
   where product_id = coalesce(o.product_id, ck.product_id, n #>> '{product,id}', s.product_id);
  select * into ofr from crm.offers
   where offer_id = coalesce(o.offer_id, ck.offer_id, n #>> '{offer,id}', s.offer_id);

  v_method := coalesce(nullif(t.payment_method, 'unknown'), nullif(o.payment_method, 'unknown'),
                       nullif(n #>> '{payment,method}', 'unknown'));
  v_inst := coalesce(t.installments, o.installments, (n #>> '{payment,installments}')::numeric::int);
  v_qty := coalesce(o.quantity, ofr.quantity, (n ->> 'quantity')::numeric);
  v_paid := coalesce(o.paid_at, o.created_at, t.paid_at, t.created_at, ev.occurred_at);

  return jsonb_strip_nulls(jsonb_build_object(
    'order_number', v_sale,
    'order_date', to_char(v_paid at time zone crm.report_tz(), 'DD/MM/YYYY'),
    'order_total', crm.brl(coalesce(nullif(o.gross_amount, 0), t.amount, ck.amount, (n ->> 'amount')::numeric)),
    'product_name', coalesce(o.product_name, pr.name, n #>> '{product,name}'),
    'offer_name', coalesce(o.offer_name, ofr.name, n #>> '{offer,name}'),
    'quantity', case when v_qty is null then null else trim_scale(v_qty)::text end,
    'product_image', coalesce(pr.cover, pr.logo, n #>> '{product,cover}', n #>> '{product,logo}'),
    'payment_method', case v_method
        when 'pix' then 'Pix'
        when 'billet' then 'Boleto'
        when 'apple_pay' then 'Apple Pay'
        when 'card' then 'Cartão de crédito' || case when v_inst > 1 then ' em ' || v_inst || 'x' else '' end
      end,
    'installments', v_inst,
    'coupon_code', coalesce(o.coupon_code, n #>> '{coupon,code}'),
    'pix_code', coalesce(t.pix_code, n #>> '{payment,pix_code}'),
    'pix_url', coalesce(t.pix_url, n #>> '{payment,pix_url}'),
    'boleto_url', coalesce(t.billet_url, n #>> '{payment,billet_url}'),
    'boleto_code', coalesce(t.billet_code, n #>> '{payment,billet_code}'),
    'checkout_url', coalesce(ck.checkout_url, n ->> 'checkout_url'),
    'tracking_code', f.tracking_code,
    'tracking_url', f.tracking_url,
    'carrier', f.carrier,
    'plan_name', s.plan_name,
    'next_charge_date', to_char(s.next_charge_at at time zone crm.report_tz(), 'DD/MM/YYYY')
  ));
end;
$$;

-- Variables of the order behind each queued message (the app merges them before rendering).
create or replace function public.crm_message_vars(p_message_ids jsonb)
returns table (message_id uuid, vars jsonb)
language sql stable security definer set search_path = crm, public, extensions as $$
  select m.message_id, crm.order_vars(m.customer_id, e.trigger_event_id)
    from crm.messages m left join crm.flow_enrollments e on e.enrollment_id = m.enrollment_id
   where m.message_id in (select x::uuid from jsonb_array_elements_text(p_message_ids) x)
$$;

-- Previews and test sends "as a real customer" show their latest order too.
create or replace function public.crm_message_customer(p_customer_id uuid) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select crm.order_vars(p_customer_id) || crm.message_customer(p_customer_id)
$$;

revoke all on function public.crm_message_vars(jsonb) from public, anon, authenticated;
grant execute on function public.crm_message_vars(jsonb) to service_role;
