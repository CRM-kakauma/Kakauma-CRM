-- =====================================================================
-- KAKAUMA CRM — "Pix/boleto expirado" (PAYMENT_EXPIRED) apart from
-- "Pagamento recusado" (PAYMENT_FAILED)
--
--   B4you "pix-expired"/"expired-pix" were normalized as PAYMENT_FAILED, so
--   the "Pagamento recusado" flows also fired when a Pix simply expired.
--   The order/financial side stays the same (the charge did fail); only the
--   customer fact becomes PAYMENT_EXPIRED, which is a trigger of its own.
--   Every PAYMENT_FAILED fact now carries data.reason = 'declined' | 'expired'.
-- =====================================================================

create or replace function crm.trigger_facts() returns text[]
language sql immutable as $$
  select array[
    'CHECKOUT_ABANDONED','PAYMENT_PENDING','PURCHASE_PAID','RENEWAL_PAID','PAYMENT_FAILED','PAYMENT_EXPIRED',
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

-- An expiry, judged by the event name B4you sent (pix.expired, expired-pix…).
create or replace function crm.is_expiry_event(p_raw uuid) returns boolean
language sql stable as $$
  select coalesce((select lower(coalesce(event_name, '')) ~ 'expir' from crm.events where id = p_raw), false)
$$;

-- Runs before the AFTER triggers (flows, automations), so they see the right type.
create or replace function crm.customer_events_payment_reason() returns trigger
language plpgsql as $$
begin
  if new.fact_type = 'PAYMENT_FAILED' then
    if crm.is_expiry_event(new.raw_event_id) then
      new.fact_type := 'PAYMENT_EXPIRED';
      new.data := coalesce(new.data, '{}') || '{"reason":"expired"}';
    else
      new.data := coalesce(new.data, '{}') || '{"reason":"declined"}';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists customer_events_payment_reason on crm.customer_events;
create trigger customer_events_payment_reason before insert on crm.customer_events
  for each row execute function crm.customer_events_payment_reason();

-- History: expiries already stored as PAYMENT_FAILED.
update crm.customer_events
   set fact_type = 'PAYMENT_EXPIRED', data = data || '{"reason":"expired"}'
 where fact_type = 'PAYMENT_FAILED' and crm.is_expiry_event(raw_event_id);

-- People still inside a "Pagamento recusado" flow only because a Pix expired leave it.
update crm.flow_enrollments en
   set status = 'EXITED', exit_reason = 'trigger_reclassified:PAYMENT_EXPIRED',
       current_node = null, next_run_at = null, finished_at = now(), updated_at = now()
  from crm.customer_events ce, crm.flows f
 where ce.id = en.trigger_event_id and f.flow_id = en.flow_id
   and en.status in ('ACTIVE','WAITING')
   and ce.fact_type = 'PAYMENT_EXPIRED' and f.trigger_fact = 'PAYMENT_FAILED';

-- Their queued, not-yet-sent messages from that flow are skipped.
update crm.messages m
   set status = 'SKIPPED', skip_reason = 'trigger_reclassified:PAYMENT_EXPIRED', executed_at = now(), updated_at = now()
  from crm.flow_enrollments en
 where m.enrollment_id = en.enrollment_id
   and en.exit_reason = 'trigger_reclassified:PAYMENT_EXPIRED'
   and m.status = 'QUEUED';
