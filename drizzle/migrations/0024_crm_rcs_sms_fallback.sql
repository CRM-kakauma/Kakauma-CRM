-- =====================================================================
-- KAKAUMA CRM — RCS falls back to its own "SMS alternativo" by itself
--
--   Refused at send time: the app sends the SMS right away (no SQL needed).
--   Reported later by the operator (Pushfy webhook: Undelivered / Rejected /
--   Invalid / Blocked / Expired): crm_claim_rcs_fallbacks hands the message
--   to the app once (result.fallback marks it), which sends the SMS and
--   records the answer with crm_rcs_fallback_done.
--   No "Aguardar entrega" branch is needed for RCS → SMS anymore.
-- =====================================================================

create or replace function public.crm_claim_rcs_fallbacks(p_limit int default 50)
returns table (message_id uuid, recipient text, fallback_sms text, is_test boolean)
language sql security definer set search_path = crm, public, extensions as $$
  with c as (
    select m.message_id
      from crm.messages m
      left join crm.message_templates t on t.template_id = m.template_id
     where m.channel = 'rcs' and m.status = 'SENT'
       and m.provider_status in ('Undelivered','Rejected','Invalid','Blocked','Expired')
       and m.result -> 'fallback' is null
       and nullif(btrim(m.rendered ->> 'fallback_sms'), '') is not null
       and m.recipient is not null
       and m.provider_status_at > now() - interval '3 days'
       -- an opt-out of SMS still holds for marketing
       and not (coalesce(t.purpose, 'marketing') = 'marketing'
                and exists (select 1 from crm.channel_optouts o
                             where o.customer_id = m.customer_id and o.channel in ('sms','all')))
     order by m.provider_status_at
     for update of m skip locked
     limit least(greatest(p_limit, 1), 500)
  )
  update crm.messages m
     set result = coalesce(m.result, '{}'::jsonb)
                  || jsonb_build_object('fallback', jsonb_build_object('status', 'PROCESSING', 'at', now())),
         updated_at = now()
    from c
   where m.message_id = c.message_id
  returning m.message_id, m.recipient, m.rendered ->> 'fallback_sms',
            coalesce((select e.is_test from crm.flow_enrollments e where e.enrollment_id = m.enrollment_id), false)
$$;

create or replace function public.crm_rcs_fallback_done(p_message_id uuid, p_status text, p_result jsonb default null)
returns void
language sql security definer set search_path = crm, public, extensions as $$
  update crm.messages
     set result = coalesce(result, '{}'::jsonb)
                  || jsonb_build_object('fallback', coalesce(p_result, '{}'::jsonb)
                                                    || jsonb_build_object('status', p_status, 'at', now()))
                  || case when p_status = 'SENT' then jsonb_build_object('sent_as', 'sms_fallback') else '{}'::jsonb end,
         updated_at = now()
   where message_id = p_message_id and channel = 'rcs'
$$;

revoke all on function public.crm_claim_rcs_fallbacks(int) from public, anon, authenticated;
revoke all on function public.crm_rcs_fallback_done(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.crm_claim_rcs_fallbacks(int) to service_role;
grant execute on function public.crm_rcs_fallback_done(uuid, text, jsonb) to service_role;
