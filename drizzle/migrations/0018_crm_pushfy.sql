-- =====================================================================
-- KAKAUMA CRM — real channel (Pushfy SMS / RCS)
--   * a failed send can be final (bad number, rejected) instead of retried
--   * opt-outs collected by Pushfy (PARAR, SAIR…) sync into crm.channel_optouts
--   * test sends from the editor are recorded in the audit log
-- =====================================================================

drop function public.crm_complete_message(uuid, text, text, jsonb, jsonb, text);
drop function crm.complete_message(uuid, text, text, jsonb, jsonb, text);

create function crm.complete_message(p_message uuid, p_status text, p_recipient text, p_rendered jsonb,
                                     p_result jsonb, p_error text, p_retry boolean default true) returns text
language plpgsql as $$
declare v_attempts int;
begin
  if p_status not in ('SENT','DRY_RUN','FAILED','SKIPPED') then raise exception 'invalid message status %', p_status; end if;
  select attempts into v_attempts from crm.messages where message_id = p_message;
  if not found then raise exception 'message % not found', p_message; end if;
  -- temporary failures retry with backoff (2, 4, 8, 16 min); permanent ones stop here
  if p_status = 'FAILED' and p_retry and v_attempts < 5 then
    update crm.messages set status = 'QUEUED', scheduled_for = now() + make_interval(mins => power(2, v_attempts)::int),
           error = p_error, result = p_result, updated_at = now() where message_id = p_message;
    return 'QUEUED';
  end if;
  update crm.messages set status = p_status, recipient = p_recipient, rendered = p_rendered, result = p_result,
         error = p_error, skip_reason = case when p_status = 'SKIPPED' then p_error end,
         executed_at = now(), updated_at = now()
   where message_id = p_message;
  return p_status;
end;
$$;

create function public.crm_complete_message(p_message_id uuid, p_status text, p_recipient text default null,
                                            p_rendered jsonb default null, p_result jsonb default null,
                                            p_error text default null, p_retry boolean default true) returns text
language sql security definer set search_path = crm, public, extensions as $$
  select crm.complete_message(p_message_id, p_status, p_recipient, p_rendered, p_result, p_error, p_retry)
$$;

-- Last digits identify a Brazilian mobile regardless of +55 / formatting.
create function crm.phone_key(p text) returns text
language sql immutable as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 11), '')
$$;

-- rows: [{"phone_number":"5511999999999","optout_via":"SMS: PARAR","opted_out_at":"2026-10-06 10:00:00"}]
-- Pushfy opt-outs cover SMS and RCS.
create function public.crm_import_optouts(p_rows jsonb, p_source text default 'pushfy') returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v_added int; v_matched int;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be an array'; end if;
  with rows as (
    select crm.phone_key(r ->> 'phone_number') as k, r ->> 'optout_via' as via
      from jsonb_array_elements(p_rows) r
  ),
  hits as (
    select distinct c.customer_id, r.via
      from rows r join crm.customers c
        on r.k is not null and length(r.k) >= 10
       and r.k in (crm.phone_key(c.phone), crm.phone_key(c.whatsapp))
  ),
  ins as (
    insert into crm.channel_optouts (customer_id, channel, source)
    select h.customer_id, ch, left(p_source || coalesce(': ' || h.via, ''), 200)
      from hits h cross join unnest(array['sms','rcs']) ch
    on conflict do nothing
    returning customer_id
  )
  select (select count(distinct customer_id) from hits), (select count(*) from ins) into v_matched, v_added;
  return jsonb_build_object('received', jsonb_array_length(p_rows), 'customers', v_matched, 'added', v_added);
end;
$$;

create function public.crm_log_test_message(p_template text, p_channel text, p_to text, p_status text,
                                            p_detail text default null, p_actor text default null) returns void
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('message_templates', coalesce(p_template, '(teste)'), 'test_send:' || p_channel,
          -- only the last 4 digits of the number are kept
          '…' || right(regexp_replace(coalesce(p_to, ''), '\D', '', 'g'), 4),
          left(p_status || coalesce(' — ' || p_detail, ''), 300), crm.current_actor());
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_complete_message(uuid,text,text,jsonb,jsonb,text,boolean)',
    'crm_import_optouts(jsonb,text)',
    'crm_log_test_message(text,text,text,text,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
