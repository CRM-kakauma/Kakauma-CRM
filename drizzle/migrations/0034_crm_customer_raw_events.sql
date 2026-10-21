-- =====================================================================
-- KAKAUMA CRM — raw webhooks of a customer ("Eventos recebidos")
--
--   Every event received for the customer (B4you…), newest first, with the
--   original JSON as stored (card data already removed at ingestion), the
--   processing status and any error. Same set of events LGPD anonymization
--   looks at.
-- =====================================================================

create or replace function public.crm_customer_raw_events(p_customer_id uuid, p_limit int default 100)
returns table (id uuid, source text, event_name text, event_type text, received_at timestamptz,
               occurred_at timestamptz, processing_status text, processing_error text, payload jsonb)
language sql stable security definer set search_path = crm, public, extensions as $$
  with ids as (
    select e.id from crm.events e where e.customer_id = p_customer_id
    union select raw_event_id from crm.customer_identities where customer_id = p_customer_id and raw_event_id is not null
    union select raw_event_id from crm.financial_events where customer_id = p_customer_id
    union select raw_event_id from crm.customer_events where customer_id = p_customer_id and raw_event_id is not null
    union select raw_event_id from crm.checkouts where customer_id = p_customer_id
  )
  select e.id, e.source, e.event_name, e.event_type, e.received_at, e.occurred_at,
         e.processing_status, e.processing_error, e.payload
    from crm.events e join ids using (id)
   order by e.received_at desc
   limit least(greatest(p_limit, 1), 500)
$$;

revoke all on function public.crm_customer_raw_events(uuid, int) from public, anon, authenticated;
grant execute on function public.crm_customer_raw_events(uuid, int) to service_role;
