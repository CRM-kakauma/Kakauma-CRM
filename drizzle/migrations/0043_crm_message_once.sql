-- =====================================================================
-- KAKAUMA CRM — a message never goes out twice
--
--   1. A send cut midway (the webhook that ran it gave up and the platform
--      stopped the request after the provider got the message, before the
--      CRM wrote the result) used to be picked up again after 15 minutes and
--      sent a second time. Now it is closed as FAILED ("Envio interrompido"):
--      it may have reached the customer, so it is not repeated.
--   2. The same marketing message (same template) to the same customer twice
--      within 24 hours is skipped (repeated_24h), e.g. two abandoned carts in
--      a row that start the flow twice.
--   3. crm_release_messages: messages claimed but not sent (the sender ran
--      out of time) go back to the queue right away.
-- =====================================================================

create or replace function crm.claim_messages(p_limit int default 100)
returns table (message_id uuid, channel text, purpose text, template_key text, content jsonb, team_text text,
               customer jsonb, flow_key text, is_test boolean)
language plpgsql as $$
#variable_conflict use_column
declare
  m record; v_reason text; v_cust jsonb; v_when timestamptz;
  v_cap int := coalesce(crm.setting_num('max_actions_per_customer_per_day'), 3)::int;
begin
  for m in
    select ms.*, t.purpose, t.content, t.archived, f.key as fkey, coalesce(en.is_test, false) as test
      from crm.messages ms
      left join crm.message_templates t using (template_id)
      left join crm.flows f on f.flow_id = ms.flow_id
      left join crm.flow_enrollments en on en.enrollment_id = ms.enrollment_id
     where (ms.status = 'QUEUED' and ms.scheduled_for <= now())
        or (ms.status = 'PROCESSING' and ms.updated_at < now() - interval '15 minutes')
     order by ms.scheduled_for
     for update of ms skip locked
     limit greatest(p_limit, 1)
  loop
    -- a send interrupted midway (the request was cut after the provider got it, before the CRM
    -- wrote the result) may have reached the customer: never sent again, so nobody gets it twice
    if m.status = 'PROCESSING' and m.channel <> 'team' then
      update crm.messages set status = 'FAILED', executed_at = now(), updated_at = now(),
             error = 'Envio interrompido no meio: pode ter chegado ao cliente, por isso não foi reenviado'
       where message_id = m.message_id;
      continue;
    end if;
    v_cust := crm.message_customer(m.customer_id);
    v_reason := null;
    if m.channel <> 'team' then
      if m.content is null then v_reason := 'template_missing';
      elsif m.purpose = 'marketing' and exists (select 1 from crm.channel_optouts o where o.customer_id = m.customer_id
                                                   and o.channel in (m.channel, 'all')) then
        v_reason := 'opt_out';
      elsif (m.channel = 'email' and v_cust ->> 'email' is null)
         or (m.channel in ('sms','rcs','whatsapp') and v_cust ->> 'phone' is null) then
        v_reason := 'no_contact_for_' || m.channel;
      elsif m.purpose = 'marketing' and not m.test and m.template_key is not null and exists (
              select 1 from crm.messages x where x.customer_id = m.customer_id and x.message_id <> m.message_id
                 and x.template_key = m.template_key and x.status in ('SENT','PROCESSING')
                 and coalesce(x.executed_at, x.updated_at) > now() - interval '24 hours') then
        -- the same marketing message twice in a day (e.g. two abandoned carts in a row)
        v_reason := 'repeated_24h';
      elsif m.purpose = 'marketing' and not m.test and
            (select count(*) from crm.messages x where x.customer_id = m.customer_id and x.message_id <> m.message_id
                and x.channel <> 'team' and x.status in ('SENT','DRY_RUN','PROCESSING')
                and coalesce(x.executed_at, x.updated_at) > now() - interval '24 hours')
          + (select count(*) from crm.automation_runs x where x.customer_id = m.customer_id
                and x.status in ('SENT','DRY_RUN','PROCESSING')
                and coalesce(x.executed_at, x.updated_at) > now() - interval '24 hours') >= v_cap then
        v_reason := 'daily_cap';
      elsif m.purpose = 'marketing' and not m.test then
        v_when := crm.next_send_time(now());
        if v_when > now() then
          update crm.messages set scheduled_for = v_when, status = 'QUEUED', updated_at = now() where message_id = m.message_id;
          continue;
        end if;
      end if;
    end if;

    if v_reason is not null then
      update crm.messages set status = 'SKIPPED', skip_reason = v_reason, executed_at = now(), updated_at = now()
       where message_id = m.message_id;
      continue;
    end if;
    update crm.messages set status = 'PROCESSING', attempts = attempts + 1, updated_at = now() where message_id = m.message_id;
    return query select m.message_id, m.channel, coalesce(m.purpose, 'transactional'), m.template_key, m.content,
                        m.team_text, v_cust, m.fkey, m.test;
  end loop;
end;
$$;

create or replace function public.crm_release_messages(p_ids text[]) returns int
language sql security definer set search_path = crm, public, extensions as $$
  with r as (
    update crm.messages set status = 'QUEUED', attempts = greatest(attempts - 1, 0), updated_at = now()
     where message_id = any(p_ids::uuid[]) and status = 'PROCESSING'
    returning 1
  )
  select count(*)::int from r
$$;
revoke all on function public.crm_release_messages(text[]) from public, anon, authenticated;
grant execute on function public.crm_release_messages(text[]) to service_role;
