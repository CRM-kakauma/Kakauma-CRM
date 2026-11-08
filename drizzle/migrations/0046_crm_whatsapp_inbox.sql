-- =====================================================================
-- KAKAUMA CRM — WhatsApp inbox (atendimento, X1)
--
--   Any number of WhatsApp numbers (Evolution API instances) answered from
--   the CRM. The Evolution webhook stores every 1:1 conversation of every
--   instance (messages from the customer, from the phone and from the CRM);
--   the screen reads them here and sends through Evolution.
--
--   crm.wa_instances  the numbers (Evolution instance name, label, color)
--   crm.wa_chats      one per instance + contact (remote jid)
--   crm.wa_messages   the messages; media is fetched from Evolution on demand
-- =====================================================================

create table if not exists crm.wa_instances (
  name text primary key,                 -- Evolution instance name
  label text not null,                   -- shown in the screen ("Atendimento 1")
  color text not null default '#25D366',
  number text,
  profile_name text,
  state text,                            -- open | close | connecting (last known)
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm.wa_chats (
  chat_id uuid primary key default gen_random_uuid(),
  instance text not null,
  remote_jid text not null,              -- 5531999999999@s.whatsapp.net (or …@lid)
  phone text,                            -- digits with 55, when known
  name text,                             -- WhatsApp profile name of the contact
  customer_id uuid references crm.customers(customer_id),
  last_message_at timestamptz,
  last_preview text,
  last_from_me boolean,
  last_status text,
  unread int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (instance, remote_jid)
);
create index if not exists wa_chats_list_idx on crm.wa_chats (instance, last_message_at desc nulls last);
create index if not exists wa_chats_phone_idx on crm.wa_chats (phone);

create table if not exists crm.wa_messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references crm.wa_chats(chat_id) on delete cascade,
  instance text not null,
  wa_id text not null,                   -- WhatsApp message id
  from_me boolean not null,
  type text not null,                    -- text | image | video | audio | document | sticker | location | contact | other
  body text,
  media jsonb,                           -- { mimetype, file_name, seconds, ptt, quoted, lat, lng }
  status text,                           -- pending | sent | delivered | read | failed (own messages)
  sent_by text,                          -- CRM user who sent it from the screen
  at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (instance, wa_id)
);
create index if not exists wa_messages_chat_idx on crm.wa_messages (chat_id, at desc);

do $$
declare t text;
begin
  foreach t in array array['wa_instances','wa_chats','wa_messages'] loop
    execute format('alter table crm.%I enable row level security', t);
    execute format('revoke all on crm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on crm.%I to service_role', t);
  end loop;
end;
$$;

-- Brazilian numbers come with or without the 9th digit in WhatsApp: both are tried.
create or replace function crm.wa_phone_variants(p_digits text) returns text[]
language sql immutable as $$
  select case
    when p_digits is null or p_digits = '' then array[]::text[]
    when p_digits ~ '^55\d{2}9\d{8}$' then array[p_digits, substr(p_digits, 1, 4) || substr(p_digits, 6)]
    when p_digits ~ '^55\d{2}[6-9]\d{7}$' then array[p_digits, substr(p_digits, 1, 4) || '9' || substr(p_digits, 5)]
    else array[p_digits]
  end
$$;

create or replace function crm.wa_customer_for(p_phone text) returns uuid
language sql stable as $$
  select ci.customer_id from crm.customer_identities ci
   where ci.kind = 'whatsapp' and ci.value = any(crm.wa_phone_variants(p_phone))
   limit 1
$$;

-- Webhook / history items → chats and messages.
--   p_messages: [{ wa_id, remote_jid, phone, from_me, push_name, type, body, media, status, at }]
--   p_statuses: [{ wa_id, status }]
create or replace function public.crm_wa_ingest(p_instance text, p_messages jsonb default '[]',
                                                p_statuses jsonb default '[]', p_state text default null,
                                                p_history boolean default false)
returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  m jsonb;
  s jsonb;
  v_chat uuid;
  v_at timestamptz;
  v_inserted boolean;
  v_rank jsonb := '{"pending":0,"sent":1,"delivered":2,"read":3,"failed":4}';
begin
  if p_instance is null or p_instance = '' then raise exception 'instance required'; end if;
  insert into crm.wa_instances (name, label) values (p_instance, p_instance) on conflict (name) do nothing;
  if p_state is not null then
    update crm.wa_instances set state = p_state, updated_at = now() where name = p_instance;
  end if;

  for m in select * from jsonb_array_elements(coalesce(p_messages, '[]')) loop
    continue when nullif(m ->> 'wa_id', '') is null or nullif(m ->> 'remote_jid', '') is null;
    v_at := coalesce((m ->> 'at')::timestamptz, now());
    insert into crm.wa_chats as c (instance, remote_jid, phone, name, customer_id)
    values (p_instance, m ->> 'remote_jid', nullif(m ->> 'phone', ''),
            case when not coalesce((m ->> 'from_me')::boolean, false) then nullif(m ->> 'push_name', '') end,
            crm.wa_customer_for(nullif(m ->> 'phone', '')))
    on conflict (instance, remote_jid) do update set
      phone = coalesce(c.phone, excluded.phone),
      name = coalesce(excluded.name, c.name),
      customer_id = coalesce(c.customer_id, excluded.customer_id),
      updated_at = now()
    returning chat_id into v_chat;

    insert into crm.wa_messages (chat_id, instance, wa_id, from_me, type, body, media, status, sent_by, at)
    values (v_chat, p_instance, m ->> 'wa_id', coalesce((m ->> 'from_me')::boolean, false),
            coalesce(nullif(m ->> 'type', ''), 'text'), m ->> 'body', nullif(m -> 'media', 'null'::jsonb),
            nullif(m ->> 'status', ''), nullif(m ->> 'sent_by', ''), v_at)
    on conflict (instance, wa_id) do update set
      sent_by = coalesce(crm.wa_messages.sent_by, excluded.sent_by),
      body = coalesce(crm.wa_messages.body, excluded.body),
      media = coalesce(crm.wa_messages.media, excluded.media)
    returning (xmax = 0) into v_inserted;
    -- the same message again (webhook retry, history): the chat is already up to date
    continue when not v_inserted;

    update crm.wa_chats c set
      last_message_at = greatest(coalesce(c.last_message_at, v_at), v_at),
      last_preview = case when v_at >= coalesce(c.last_message_at, '-infinity') then
                       left(coalesce(nullif(m ->> 'body', ''), case m ->> 'type'
                         when 'image' then '📷 Foto' when 'video' then '🎥 Vídeo' when 'audio' then '🎤 Áudio'
                         when 'document' then '📄 Documento' when 'sticker' then 'Figurinha'
                         when 'location' then '📍 Localização' when 'contact' then '👤 Contato'
                         else 'Mensagem' end), 160) else c.last_preview end,
      last_from_me = case when v_at >= coalesce(c.last_message_at, '-infinity')
                          then coalesce((m ->> 'from_me')::boolean, false) else c.last_from_me end,
      last_status = case when v_at >= coalesce(c.last_message_at, '-infinity')
                         then nullif(m ->> 'status', '') else c.last_status end,
      -- a new message from the customer is unread; an answer (CRM or phone) reads the chat
      unread = case when p_history then c.unread
                    when coalesce((m ->> 'from_me')::boolean, false) then 0
                    else c.unread + 1 end,
      archived = case when not coalesce((m ->> 'from_me')::boolean, false) and not p_history then false else c.archived end,
      updated_at = now()
     where c.chat_id = v_chat;
  end loop;

  for s in select * from jsonb_array_elements(coalesce(p_statuses, '[]')) loop
    -- statuses only move forward (a late "delivered" never hides "read")
    update crm.wa_messages w set status = s ->> 'status'
     where w.instance = p_instance and w.wa_id = s ->> 'wa_id'
       and coalesce((v_rank ->> (s ->> 'status'))::int, -1) > coalesce((v_rank ->> w.status)::int, -1);
    update crm.wa_chats c set last_status = w.status
      from crm.wa_messages w
     where w.instance = p_instance and w.wa_id = s ->> 'wa_id' and c.chat_id = w.chat_id
       and c.last_from_me and c.last_message_at = w.at;
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.crm_wa_instances() returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select coalesce(jsonb_agg(to_jsonb(i) || jsonb_build_object(
           'unread', (select coalesce(sum(c.unread), 0) from crm.wa_chats c where c.instance = i.name and not c.archived),
           'chats', (select count(*) from crm.wa_chats c where c.instance = i.name))
         order by i.created_at, i.name), '[]')
    from crm.wa_instances i
$$;

create or replace function public.crm_wa_save_instance(p_name text, p_label text, p_color text default null,
                                                       p_number text default null, p_profile text default null,
                                                       p_state text default null, p_actor text default null)
returns void
language sql security definer set search_path = crm, public, extensions as $$
  insert into crm.wa_instances (name, label, color, number, profile_name, state, created_by)
  values (p_name, coalesce(nullif(btrim(p_label), ''), p_name), coalesce(p_color, '#25D366'), p_number, p_profile, p_state, p_actor)
  on conflict (name) do update set
    label = coalesce(nullif(btrim(p_label), ''), crm.wa_instances.label),
    color = coalesce(p_color, crm.wa_instances.color),
    number = coalesce(p_number, crm.wa_instances.number),
    profile_name = coalesce(p_profile, crm.wa_instances.profile_name),
    state = coalesce(p_state, crm.wa_instances.state),
    updated_at = now()
$$;

create or replace function public.crm_wa_delete_instance(p_name text) returns void
language sql security definer set search_path = crm, public, extensions as $$
  delete from crm.wa_messages where instance = p_name;
  delete from crm.wa_chats where instance = p_name;
  delete from crm.wa_instances where name = p_name;
$$;

-- Conversation list. p_filter: all | unread | archived
create or replace function public.crm_wa_chats(p_instance text, p_search text default null,
                                               p_filter text default 'all', p_limit int default 200)
returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select coalesce(jsonb_agg(x order by x.last_message_at desc nulls last), '[]') from (
    select c.chat_id, c.instance, c.remote_jid, c.phone, c.name, c.customer_id, cu.full_name as customer_name,
           c.last_message_at, c.last_preview, c.last_from_me, c.last_status, c.unread, c.archived
      from crm.wa_chats c left join crm.customers cu using (customer_id)
     where c.instance = p_instance
       and (case coalesce(p_filter, 'all') when 'archived' then c.archived when 'unread' then c.unread > 0 and not c.archived
            else not c.archived end)
       and (nullif(btrim(p_search), '') is null
            or coalesce(c.name, '') ilike '%' || btrim(p_search) || '%'
            or coalesce(cu.full_name, '') ilike '%' || btrim(p_search) || '%'
            or coalesce(c.phone, '') like '%' || regexp_replace(btrim(p_search), '\D', '', 'g') || '%'
               and regexp_replace(btrim(p_search), '\D', '', 'g') <> '')
     order by c.last_message_at desc nulls last
     limit least(greatest(p_limit, 1), 500)
  ) x
$$;

create or replace function public.crm_wa_chat(p_chat uuid) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select to_jsonb(x) from (
    select c.*, cu.full_name as customer_name, cu.email as customer_email,
           cu.current_lifecycle_stage as lifecycle_stage, cu.current_customer_type as customer_type,
           cu.total_net_revenue, cu.total_paid_orders, cu.last_purchase_at,
           i.label as instance_label, i.color as instance_color
      from crm.wa_chats c left join crm.customers cu using (customer_id)
      left join crm.wa_instances i on i.name = c.instance
     where c.chat_id = p_chat
  ) x
$$;

-- Messages of a chat, newest page first (returned oldest → newest).
create or replace function public.crm_wa_messages(p_chat uuid, p_before timestamptz default null, p_limit int default 60)
returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select coalesce(jsonb_agg(x order by x.at, x.id), '[]') from (
    select w.id, w.wa_id, w.from_me, w.type, w.body, w.media, w.status, w.sent_by, w.at
      from crm.wa_messages w
     where w.chat_id = p_chat and (p_before is null or w.at < p_before)
     order by w.at desc, w.id desc
     limit least(greatest(p_limit, 1), 200)
  ) x
$$;

create or replace function public.crm_wa_open_chat(p_instance text, p_remote_jid text, p_phone text, p_name text default null)
returns uuid
language plpgsql security definer set search_path = crm, public, extensions as $$
declare v uuid;
begin
  insert into crm.wa_instances (name, label) values (p_instance, p_instance) on conflict (name) do nothing;
  insert into crm.wa_chats as c (instance, remote_jid, phone, name, customer_id, last_message_at)
  values (p_instance, p_remote_jid, p_phone, nullif(btrim(p_name), ''), crm.wa_customer_for(p_phone), now())
  on conflict (instance, remote_jid) do update set archived = false, updated_at = now()
  returning chat_id into v;
  return v;
end;
$$;

create or replace function public.crm_wa_update_chat(p_chat uuid, p_unread int default null, p_archived boolean default null)
returns void
language sql security definer set search_path = crm, public, extensions as $$
  update crm.wa_chats set unread = coalesce(p_unread, unread), archived = coalesce(p_archived, archived), updated_at = now()
   where chat_id = p_chat
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_wa_ingest(text,jsonb,jsonb,text,boolean)', 'crm_wa_instances()',
    'crm_wa_save_instance(text,text,text,text,text,text,text)', 'crm_wa_delete_instance(text)',
    'crm_wa_chats(text,text,text,int)', 'crm_wa_chat(uuid)', 'crm_wa_messages(uuid,timestamptz,int)',
    'crm_wa_open_chat(text,text,text,text)', 'crm_wa_update_chat(uuid,int,boolean)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
