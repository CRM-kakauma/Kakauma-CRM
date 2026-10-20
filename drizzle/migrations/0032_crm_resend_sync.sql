-- =====================================================================
-- KAKAUMA CRM — e-mail status from the Resend API (history + safety net)
--
--   Webhooks only bring what happens after they are created, and a delivery
--   can be lost. The worker asks Resend for the last event of recent e-mails
--   (GET /emails/<id> → last_event) a few at a time, and applies it through
--   crm_resend_event, so the same rules and the same dedupe apply. Each
--   e-mail is checked at most every 12 hours, for 14 days after sending,
--   until it was clicked (the last state that matters).
-- =====================================================================

alter table crm.messages add column if not exists provider_checked_at timestamptz;

create or replace function public.crm_resend_sync_batch(p_limit int default 25)
returns table (message_id uuid, email_id text, executed_at timestamptz)
language sql security definer set search_path = crm, public, extensions as $$
  with c as (
    select m.message_id
      from crm.messages m
     where m.channel = 'email' and m.status = 'SENT'
       and m.result #>> '{response,id}' is not null
       and m.executed_at > now() - interval '14 days'
       and m.provider_status is distinct from 'Clicked'
       and m.provider_status is distinct from 'Bounced'
       and m.provider_status is distinct from 'Complained'
       and (m.provider_checked_at is null or m.provider_checked_at < now() - interval '12 hours')
     order by m.provider_checked_at nulls first, m.executed_at desc
     for update of m skip locked
     limit least(greatest(p_limit, 1), 100)
  )
  update crm.messages m set provider_checked_at = now()
    from c where m.message_id = c.message_id
  returning m.message_id, m.result #>> '{response,id}', m.executed_at
$$;

revoke all on function public.crm_resend_sync_batch(int) from public, anon, authenticated;
grant execute on function public.crm_resend_sync_batch(int) to service_role;
