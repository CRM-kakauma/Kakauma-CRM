-- =====================================================================
-- KAKAUMA CRM — opening a WhatsApp conversation from the customer page
--
--   The number of the customer may be saved with the 9th digit while WhatsApp
--   uses it without (or the other way round): the conversation that already
--   exists for any of the two forms is reused, instead of a second one.
-- =====================================================================

create or replace function public.crm_wa_open_chat(p_instance text, p_remote_jid text, p_phone text, p_name text default null)
returns uuid
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v uuid;
begin
  insert into crm.wa_instances (name, label) values (p_instance, p_instance) on conflict (name) do nothing;
  select chat_id into v from crm.wa_chats
   where instance = p_instance
     and (remote_jid = p_remote_jid or phone = any(crm.wa_phone_variants(p_phone)))
   order by last_message_at desc nulls last
   limit 1;
  if v is not null then
    update crm.wa_chats set archived = false, updated_at = now() where chat_id = v;
    return v;
  end if;
  insert into crm.wa_chats as c (instance, remote_jid, phone, name, customer_id, last_message_at)
  values (p_instance, p_remote_jid, p_phone, nullif(btrim(p_name), ''), crm.wa_customer_for(p_phone), now())
  on conflict (instance, remote_jid) do update set archived = false, updated_at = now()
  returning chat_id into v;
  return v;
end;
$$;
