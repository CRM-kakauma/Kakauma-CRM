-- =====================================================================
-- KAKAUMA CRM — WhatsApp oficial (Cloud API da Meta)
--
--   POST /api/webhooks/whatsapp (signed with the app secret) → crm_whatsapp_event,
--   once per status or received message:
--     · status sent / delivered / read / failed → the message (found by the wamid
--       saved when it was sent, or by biz_opaque_callback_data = message_id);
--       read = opened; failed = not delivered (with Meta's reason);
--     · a message from the customer: PARAR / SAIR… (or the "Parar promoções"
--       button) opts them out of WhatsApp.
--   A WhatsApp message can be linked to an approved template (content.meta):
--   its rules then check the template's variables, not the free-text limits.
--   "Aguardar entrega" now also counts as delivered a message already read or
--   opened (an e-mail opened before the step ran counted as not delivered).
-- =====================================================================

create index if not exists messages_wamid_idx on crm.messages ((result ->> 'wamid'))
  where channel = 'whatsapp';

create or replace function public.crm_whatsapp_event(p_kind text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  v_id text := nullif(p_payload ->> 'id', '');
  v_status text := lower(coalesce(p_payload ->> 'status', ''));
  v_ref text := nullif(p_payload ->> 'biz_opaque_callback_data', '');
  v_phone text := coalesce(p_payload ->> 'recipient_id', p_payload ->> 'from');
  v_at timestamptz;
  v_key text;
  v_msg crm.messages;
  v_new text;
  v_text text;
  v_customers int := 0;
begin
  if jsonb_typeof(p_payload) <> 'object' or p_kind not in ('status','reply') then
    raise exception 'payload must be a WhatsApp status or message';
  end if;
  begin
    v_at := coalesce(to_timestamp(nullif(p_payload ->> 'timestamp', '')::bigint), now());
  exception when others then
    v_at := now();
  end;
  v_key := 'whatsapp:' || p_kind || ':' || coalesce(v_id, md5(p_payload::text)) || ':' || v_status;
  insert into crm.provider_events (provider, kind, dedupe_key, ext_id, phone, payload)
  values ('whatsapp', p_kind, v_key, v_id, v_phone, p_payload)
  on conflict (dedupe_key) do nothing;
  if not found then return jsonb_build_object('ok', true, 'duplicate', true); end if;

  if p_kind = 'reply' then
    v_text := upper(btrim(coalesce(p_payload #>> '{text,body}', p_payload #>> '{button,text}',
                                   p_payload #>> '{interactive,button_reply,title}', '')));
    if v_text in ('SAIR','PARAR','PARE','CANCELAR','REMOVER','STOP','DESCADASTRAR')
       or v_text like 'PARAR PROMO%' then
      with hits as (
        select c.customer_id from crm.customers c
         where length(crm.phone_key(v_phone)) >= 10
           and crm.phone_key(v_phone) in (crm.phone_key(c.phone), crm.phone_key(c.whatsapp))
      ), ins as (
        insert into crm.channel_optouts (customer_id, channel, source)
        select customer_id, 'whatsapp', left('whatsapp: resposta ' || v_text, 200) from hits
        on conflict do nothing returning customer_id
      )
      select count(*) into v_customers from ins;
    end if;
    return jsonb_build_object('ok', true, 'kind', 'reply', 'message_matched', false, 'optout', v_customers);
  end if;

  if v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_msg from crm.messages where message_id = v_ref::uuid and channel = 'whatsapp';
  end if;
  if v_msg.message_id is null and v_id is not null then
    select * into v_msg from crm.messages where channel = 'whatsapp' and result ->> 'wamid' = v_id limit 1;
  end if;
  if v_msg.message_id is null then
    return jsonb_build_object('ok', true, 'kind', 'status', 'message_matched', false);
  end if;
  update crm.provider_events set message_id = v_msg.message_id where dedupe_key = v_key;

  v_new := case v_status
    when 'sent' then 'Sent' when 'delivered' then 'Delivered' when 'read' then 'Read'
    when 'failed' then 'Undelivered' end;
  if v_new is null then
    return jsonb_build_object('ok', true, 'kind', 'status', 'message_matched', true);
  end if;
  update crm.messages set
    -- statuses can arrive out of order: "sent"/"delivered" never hide "read"
    provider_status = case
      when v_new in ('Sent','Delivered') and provider_status in ('Read','Clicked') then provider_status
      when v_new = 'Sent' and provider_status = 'Delivered' then provider_status
      else v_new end,
    provider_status_at = now(),
    delivered_at = case when v_new in ('Delivered','Read') then coalesce(delivered_at, v_at) else delivered_at end,
    opened_at = case when v_new = 'Read' then coalesce(opened_at, v_at) else opened_at end,
    error = case when v_new = 'Undelivered'
                 then left(coalesce(p_payload #>> '{errors,0,error_data,details}', p_payload #>> '{errors,0,title}',
                                    p_payload #>> '{errors,0,message}', 'não entregue') ||
                           coalesce(' (' || (p_payload #>> '{errors,0,code}') || ')', ''), 500)
                 else error end,
    updated_at = now()
   where message_id = v_msg.message_id;
  return jsonb_build_object('ok', true, 'kind', 'status', 'message_matched', true, 'status', v_new);
end;
$$;

revoke all on function public.crm_whatsapp_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.crm_whatsapp_event(text, jsonb) to service_role;

-- Message rules: a WhatsApp message linked to an approved Meta template.
create or replace function crm.template_errors(p_channel text, c jsonb) returns text[]
language plpgsql immutable as $$
declare
  e text[] := '{}';
  b jsonb;
  url_ok text := '^(https?://|\{\{\s*\w+\s*\}\})';
  n_url int; n_phone int; k text; idx int;
begin
  if c is null or jsonb_typeof(c) <> 'object' then return array['Conteúdo inválido']; end if;
  if p_channel = 'email' then
    if coalesce(btrim(c ->> 'subject'), '') = '' then e := array_append(e, 'Assunto é obrigatório'); end if;
    if length(c ->> 'subject') > 150 then e := array_append(e, 'Assunto com mais de 150 caracteres'); end if;
    if length(c ->> 'preheader') > 200 then e := array_append(e, 'Pré-cabeçalho com mais de 200 caracteres'); end if;
    if coalesce(c ->> 'format', 'blocks') not in ('blocks','html') then
      e := array_append(e, 'Formato do e-mail deve ser blocos ou HTML');
    elsif c ->> 'format' = 'html' then
      if coalesce(btrim(c ->> 'html'), '') = '' then
        e := array_append(e, 'Cole ou escreva o HTML do e-mail');
      elsif length(c ->> 'html') > 100000 then
        e := array_append(e, 'HTML com mais de 100 mil caracteres (o Gmail corta e-mails grandes)');
      elsif c ->> 'html' ~* '<script' then
        e := array_append(e, 'O HTML não pode ter <script> (e-mails não executam scripts)');
      elsif c ->> 'html' ~* '<(form|iframe|object|embed)\M' then
        e := array_append(e, 'O HTML não pode ter formulários, iframes ou objetos incorporados');
      end if;
    elsif jsonb_typeof(c -> 'blocks') is distinct from 'array' or jsonb_array_length(c -> 'blocks') = 0 then
      e := array_append(e, 'Adicione pelo menos um bloco ao e-mail');
    elsif jsonb_array_length(c -> 'blocks') > 40 then
      e := array_append(e, 'Máximo de 40 blocos');
    else
      for b in select * from jsonb_array_elements(c -> 'blocks') loop
        if coalesce(b ->> 'type', '') not in ('heading','text','button','image','divider','spacer') then
          e := array_append(e, format('Bloco desconhecido: %s', b ->> 'type'));
        elsif b ->> 'type' in ('heading','text','button') and coalesce(btrim(b ->> 'text'), '') = '' then
          e := array_append(e, format('Bloco "%s" sem texto', b ->> 'type'));
        elsif b ->> 'type' in ('button','image') and coalesce(b ->> 'url', '') !~ url_ok then
          e := array_append(e, format('Bloco "%s": o link deve começar com https://', b ->> 'type'));
        end if;
      end loop;
    end if;
  elsif p_channel = 'sms' then
    if coalesce(btrim(c ->> 'text'), '') = '' then e := array_append(e, 'Texto do SMS é obrigatório'); end if;
    if length(c ->> 'text') > 670 then e := array_append(e, 'SMS com mais de 670 caracteres (muitas partes)'); end if;
  elsif p_channel = 'whatsapp' then
    if coalesce(btrim(c #>> '{meta,name}'), '') <> '' then
      -- linked to a template approved in Meta: texts are Meta's, the CRM fills the variables
      if coalesce(btrim(c #>> '{meta,language}'), '') = '' then e := array_append(e, 'Modelo da Meta sem idioma'); end if;
      if coalesce(btrim(c ->> 'body'), '') = '' then e := array_append(e, 'Modelo da Meta sem texto'); end if;
      if coalesce(c #>> '{header,type}', 'none') not in ('none','text','image','video','document') then
        e := array_append(e, 'Cabeçalho inválido');
      elsif c #>> '{header,type}' in ('image','video','document') and coalesce(c #>> '{header,url}', '') !~ url_ok then
        e := array_append(e, 'Cabeçalho do modelo: coloque o link (https://) da mídia');
      end if;
      if coalesce(c #>> '{meta,format}', 'positional') = 'positional' then
        for k in select (regexp_matches(coalesce(c ->> 'body', '') || ' ' || coalesce(c #>> '{header,text}', ''),
                                        '\{\{\s*(\w+)\s*\}\}', 'g'))[1] loop
          if coalesce(btrim(c #>> array['meta','params',k]), '') = ''
             and coalesce(btrim(c #>> array['meta','header_params',k]), '') = '' then
            e := array_append(e, format('Preencha a variável {{%s}} do modelo', k));
          end if;
        end loop;
      end if;
      if jsonb_typeof(c -> 'buttons') = 'array' then
        if jsonb_array_length(c -> 'buttons') > 10 then e := array_append(e, 'Máximo de 10 botões'); end if;
        for b, idx in select x, (o - 1)::int from jsonb_array_elements(c -> 'buttons') with ordinality t(x, o) loop
          if coalesce(b ->> 'type', '') not in ('quick_reply','url','phone','copy_code') then
            e := array_append(e, 'Tipo de botão inválido');
          elsif b ->> 'type' = 'url' and coalesce(b ->> 'url', '') ~ '\{\{'
                and coalesce(btrim(c #>> array['meta','button_params',idx::text]), '') = '' then
            e := array_append(e, format('Botão "%s": preencha o final do link', b ->> 'text'));
          elsif b ->> 'type' = 'copy_code' and coalesce(btrim(c #>> array['meta','button_params',idx::text]), '') = '' then
            e := array_append(e, format('Botão "%s": preencha o código do cupom', b ->> 'text'));
          end if;
        end loop;
      end if;
    else
      if coalesce(btrim(c ->> 'body'), '') = '' then e := array_append(e, 'Corpo da mensagem é obrigatório'); end if;
      if length(c ->> 'body') > 1024 then e := array_append(e, 'Corpo com mais de 1024 caracteres'); end if;
      if coalesce(c #>> '{header,type}', 'none') not in ('none','text','image') then
        e := array_append(e, 'Cabeçalho inválido');
      elsif c #>> '{header,type}' = 'text' and (coalesce(btrim(c #>> '{header,text}'), '') = '' or length(c #>> '{header,text}') > 60) then
        e := array_append(e, 'Cabeçalho de texto: 1 a 60 caracteres');
      elsif c #>> '{header,type}' = 'image' and coalesce(c #>> '{header,url}', '') !~ url_ok then
        e := array_append(e, 'Cabeçalho de imagem: o link deve começar com https://');
      end if;
      if length(c ->> 'footer') > 60 then e := array_append(e, 'Rodapé com mais de 60 caracteres'); end if;
      if coalesce(c ->> 'category', 'marketing') not in ('marketing','utility') then
        e := array_append(e, 'Categoria deve ser marketing ou utilidade');
      end if;
      if jsonb_typeof(c -> 'buttons') = 'array' then
        if jsonb_array_length(c -> 'buttons') > 3 then e := array_append(e, 'Máximo de 3 botões'); end if;
        select count(*) filter (where x ->> 'type' = 'url'), count(*) filter (where x ->> 'type' = 'phone')
          into n_url, n_phone from jsonb_array_elements(c -> 'buttons') x;
        if n_url > 2 then e := array_append(e, 'Máximo de 2 botões de link'); end if;
        if n_phone > 1 then e := array_append(e, 'Máximo de 1 botão de ligação'); end if;
        for b in select * from jsonb_array_elements(c -> 'buttons') loop
          if coalesce(b ->> 'type', '') not in ('quick_reply','url','phone') then
            e := array_append(e, 'Tipo de botão inválido');
          elsif coalesce(btrim(b ->> 'text'), '') = '' or length(b ->> 'text') > 25 then
            e := array_append(e, 'Texto do botão: 1 a 25 caracteres');
          elsif b ->> 'type' = 'url' and coalesce(b ->> 'url', '') !~ url_ok then
            e := array_append(e, 'Botão de link: deve começar com https://');
          elsif b ->> 'type' = 'phone' and coalesce(b ->> 'phone', '') !~ '^\+?[0-9 ()-]{10,20}$' then
            e := array_append(e, 'Botão de ligação: telefone inválido');
          end if;
        end loop;
      end if;
    end if;
  elsif p_channel = 'rcs' then
    if coalesce(c ->> 'kind', '') not in ('text','card','carousel') then
      e := array_append(e, 'Tipo de RCS deve ser texto, cartão ou carrossel');
    elsif c ->> 'kind' = 'text' and (coalesce(btrim(c ->> 'text'), '') = '' or length(c ->> 'text') > 2000) then
      e := array_append(e, 'Texto: 1 a 2000 caracteres');
    elsif c ->> 'kind' in ('card','carousel') then
      if jsonb_typeof(c -> 'cards') is distinct from 'array' or jsonb_array_length(c -> 'cards') = 0 then
        e := array_append(e, 'Adicione um cartão');
      elsif c ->> 'kind' = 'carousel' and jsonb_array_length(c -> 'cards') not between 2 and 10 then
        e := array_append(e, 'Carrossel: de 2 a 10 cartões');
      else
        for b in select * from jsonb_array_elements(c -> 'cards') loop
          if coalesce(btrim(b ->> 'title'), '') = '' or length(b ->> 'title') > 200 then
            e := array_append(e, 'Título do cartão: 1 a 200 caracteres');
          end if;
          if length(b ->> 'description') > 2000 then e := array_append(e, 'Descrição do cartão: até 2000 caracteres'); end if;
          if coalesce(b ->> 'media_url', '') <> '' and b ->> 'media_url' !~ url_ok then
            e := array_append(e, 'Imagem do cartão: o link deve começar com https://');
          end if;
        end loop;
      end if;
    end if;
    if jsonb_typeof(c -> 'suggestions') = 'array' then
      if jsonb_array_length(c -> 'suggestions') > 4 then e := array_append(e, 'Máximo de 4 sugestões'); end if;
      for b in select * from jsonb_array_elements(c -> 'suggestions') loop
        if coalesce(b ->> 'type', '') not in ('reply','url','dial') then
          e := array_append(e, 'Tipo de sugestão inválido');
        elsif coalesce(btrim(b ->> 'text'), '') = '' or length(b ->> 'text') > 25 then
          e := array_append(e, 'Texto da sugestão: 1 a 25 caracteres');
        elsif b ->> 'type' = 'url' and coalesce(b ->> 'url', '') !~ url_ok then
          e := array_append(e, 'Sugestão de link: deve começar com https://');
        elsif b ->> 'type' = 'dial' and coalesce(b ->> 'phone', '') !~ '^\+?[0-9 ()-]{10,20}$' then
          e := array_append(e, 'Sugestão de ligação: telefone inválido');
        end if;
      end loop;
    end if;
    if coalesce(btrim(c ->> 'fallback_sms'), '') = '' then
      e := array_append(e, 'Texto de SMS alternativo é obrigatório (para aparelhos sem RCS)');
    end if;
  else
    e := array_append(e, 'Canal inválido');
  end if;
  return e;
end;
$$;

create or replace function crm.flow_tick(p_limit int default 200, p_max_steps int default 30) returns int
language plpgsql as $$
declare
  en record; g jsonb; n jsonb; c jsonb; v_next text; v_out text; v_steps int; v_count int := 0; v_tpl uuid;
  v_msg record; v_deadline timestamptz; v_watch uuid;
begin
  for en in
    select e.*, f.status as flow_status, f.entry_rule, f.key as flow_key
      from crm.flow_enrollments e join crm.flows f using (flow_id)
     where e.status in ('ACTIVE','WAITING') and e.next_run_at <= now()
       and (f.status in ('ACTIVE','ARCHIVED') or e.is_test)   -- a test runs even if the flow is not live
     order by e.next_run_at
     for update of e skip locked
     limit greatest(p_limit, 1)
  loop
    v_count := v_count + 1;
    if en.flow_status = 'ARCHIVED' then
      update crm.flow_enrollments set status = 'EXITED', exit_reason = 'flow_archived', finished_at = now(),
             next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
      continue;
    end if;
    select graph into g from crm.flow_versions where flow_id = en.flow_id and version = en.version;
    if en.status = 'WAITING' then  -- the awaited event did not come in time
      perform crm.flow_step(en.enrollment_id, jsonb_build_object('id', 'timeout', 'type', 'wait_event'), 'timeout');
    end if;
    v_next := en.current_node;
    v_steps := 0;

    loop
      if v_next is null then
        update crm.flow_enrollments set status = 'COMPLETED', current_node = null, next_run_at = null, finished_at = now(),
               wait_fact = null, wait_filter = null, wait_event_node = null, updated_at = now()
         where enrollment_id = en.enrollment_id;
        exit;
      end if;
      v_steps := v_steps + 1;
      if v_steps > p_max_steps then  -- safety net; graphs are validated acyclic
        update crm.flow_enrollments set status = 'FAILED', exit_reason = 'too_many_steps', finished_at = now(),
               next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
        exit;
      end if;
      n := crm.flow_node(g, v_next);
      if n is null then
        update crm.flow_enrollments set status = 'FAILED', exit_reason = 'missing_node:' || v_next, finished_at = now(),
               next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
        exit;
      end if;
      c := coalesce(n -> 'config', '{}');

      case n ->> 'type'
      when 'trigger' then
        -- a test is fired by hand for chosen contacts: the entry rule does not apply
        if not en.is_test and not crm.eval_rule(en.entry_rule, crm.features(en.customer_id)) then
          perform crm.flow_step(en.enrollment_id, n, 'entry_rule_not_met');
          update crm.flow_enrollments set status = 'EXITED', exit_reason = 'entry_rule_not_met', finished_at = now(),
                 next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
          exit;
        end if;
        perform crm.flow_step(en.enrollment_id, n, 'entered', case when en.is_test then '{"test":true}'::jsonb end);
        v_next := crm.flow_next(g, n ->> 'id');

      when 'send' then
        select template_id into v_tpl from crm.message_templates where key = c ->> 'template_key';
        insert into crm.messages (customer_id, channel, template_id, template_key, flow_id, enrollment_id, node_id)
        select en.customer_id, t.channel, t.template_id, t.key, en.flow_id, en.enrollment_id, n ->> 'id'
          from crm.message_templates t where t.template_id = v_tpl
        on conflict (enrollment_id, node_id) do nothing;
        perform crm.flow_step(en.enrollment_id, n, case when v_tpl is null then 'template_missing' else 'queued' end,
                              jsonb_build_object('template', c ->> 'template_key'));
        v_next := crm.flow_next(g, n ->> 'id');

      when 'alert_team' then
        insert into crm.messages (customer_id, channel, team_text, flow_id, enrollment_id, node_id)
        values (en.customer_id, 'team', c ->> 'message', en.flow_id, en.enrollment_id, n ->> 'id')
        on conflict (enrollment_id, node_id) do nothing;
        perform crm.flow_step(en.enrollment_id, n, 'queued');
        v_next := crm.flow_next(g, n ->> 'id');

      when 'wait' then
        if en.skip_waits then
          perform crm.flow_step(en.enrollment_id, n, 'test_skipped');
          v_next := crm.flow_next(g, n ->> 'id');
        else
          perform crm.flow_step(en.enrollment_id, n, 'waiting', jsonb_build_object('until', now() + crm.wait_interval(c)));
          update crm.flow_enrollments set status = 'ACTIVE', current_node = crm.flow_next(g, n ->> 'id'),
                 next_run_at = now() + crm.wait_interval(c), updated_at = now()
           where enrollment_id = en.enrollment_id;
          exit;
        end if;

      when 'wait_event' then
        if en.skip_waits then  -- fast test: behave as if the event did not come
          perform crm.flow_step(en.enrollment_id, n, 'timeout', '{"test":true}'::jsonb);
          v_next := crm.flow_next(g, n ->> 'id', 'timeout');
        elsif exists (select 1 from crm.customer_events ce
                       where ce.customer_id = en.customer_id and ce.fact_type = c ->> 'fact'
                         and ce.data @> coalesce(c -> 'filter', '{}')
                         and ce.occurred_at >= en.entered_at - interval '1 minute'
                         and ce.id is distinct from en.trigger_event_id) then
          -- it already happened while the customer was in the flow (e.g. tracking before this step)
          perform crm.flow_step(en.enrollment_id, n, 'event', jsonb_build_object('fact', c ->> 'fact', 'already', true));
          v_next := crm.flow_next(g, n ->> 'id', 'event');
        else
          perform crm.flow_step(en.enrollment_id, n, 'waiting', jsonb_build_object('fact', c ->> 'fact'));
          update crm.flow_enrollments set status = 'WAITING',
                 current_node = crm.flow_next(g, n ->> 'id', 'timeout'),
                 wait_event_node = crm.flow_next(g, n ->> 'id', 'event'),
                 wait_fact = c ->> 'fact', wait_filter = coalesce(c -> 'filter', '{}'), wait_started_at = now(),
                 next_run_at = now() + make_interval(hours => (c ->> 'timeout_hours')::int), updated_at = now()
           where enrollment_id = en.enrollment_id;
          exit;
        end if;

      when 'wait_delivery' then
        -- the message to watch: the last one this enrollment sent (fixed when the step is reached)
        if en.wait_fact = '__delivery' and en.current_node = n ->> 'id' then
          v_watch := (en.wait_filter ->> 'message_id')::uuid;
          v_deadline := en.wait_started_at + make_interval(hours => coalesce((c ->> 'timeout_hours')::int, 24));
        else
          select m.message_id into v_watch from crm.messages m
           where m.enrollment_id = en.enrollment_id and m.channel <> 'team'
           order by (select max(st.id) from crm.flow_steps st
                      where st.enrollment_id = m.enrollment_id and st.node_id = m.node_id) desc nulls last,
                    m.created_at desc
           limit 1;
          v_deadline := now() + make_interval(hours => coalesce((c ->> 'timeout_hours')::int, 24));
        end if;
        select * into v_msg from crm.messages where message_id = v_watch;
        v_out := case
          when v_msg.message_id is null then 'failed'
          when v_msg.status in ('FAILED','SKIPPED')
            or v_msg.provider_status in ('Undelivered','Rejected','Invalid','Blocked','Expired','No credits') then 'failed'
          when v_msg.provider_status in ('Delivered','Opened','Read','Clicked') or v_msg.delivered_at is not null
            or v_msg.status = 'DRY_RUN' then 'delivered'
          when now() >= v_deadline then coalesce(c ->> 'on_timeout', 'delivered')
          else null end;
        if v_out is null then  -- still waiting: the result of the send or the operator's report wakes it up
          if not (en.wait_fact = '__delivery' and en.current_node = n ->> 'id') then
            perform crm.flow_step(en.enrollment_id, n, 'waiting', jsonb_build_object('message_id', v_watch));
          end if;
          update crm.flow_enrollments set status = 'ACTIVE', current_node = n ->> 'id', next_run_at = v_deadline,
                 wait_fact = '__delivery', wait_filter = jsonb_build_object('message_id', v_watch),
                 wait_started_at = coalesce(case when wait_fact = '__delivery' and current_node = n ->> 'id'
                                                 then wait_started_at end, now()),
                 updated_at = now()
           where enrollment_id = en.enrollment_id;
          exit;
        end if;
        perform crm.flow_step(en.enrollment_id, n, v_out,
                              jsonb_build_object('message_id', v_watch, 'status', v_msg.status,
                                                 'provider_status', v_msg.provider_status,
                                                 'timeout', now() >= v_deadline));
        update crm.flow_enrollments set wait_fact = null, wait_filter = null, wait_started_at = null, updated_at = now()
         where enrollment_id = en.enrollment_id and wait_fact = '__delivery';
        en.wait_fact := null;
        v_next := crm.flow_next(g, n ->> 'id', v_out);

      when 'condition' then
        v_out := case when crm.eval_rule(c -> 'rule', crm.features(en.customer_id)) then 'yes' else 'no' end;
        perform crm.flow_step(en.enrollment_id, n, v_out);
        v_next := crm.flow_next(g, n ->> 'id', v_out);

      when 'split' then
        v_out := crm.split_branch(n, en.enrollment_id::text || (n ->> 'id'));
        perform crm.flow_step(en.enrollment_id, n, v_out);
        v_next := crm.flow_next(g, n ->> 'id', v_out);

      when 'exit' then
        perform crm.flow_step(en.enrollment_id, n, 'exit');
        update crm.flow_enrollments set status = 'EXITED', exit_reason = 'exit_step', current_node = null,
               finished_at = now(), next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
        exit;

      else
        update crm.flow_enrollments set status = 'FAILED', exit_reason = 'unknown_step:' || (n ->> 'type'),
               finished_at = now(), next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
        exit;
      end case;
    end loop;
  end loop;
  return v_count;
end;
$$;
