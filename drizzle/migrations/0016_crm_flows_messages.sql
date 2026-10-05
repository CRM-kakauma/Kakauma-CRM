-- =====================================================================
-- KAKAUMA CRM — flows (multi-step journeys) and message templates
--
--   fact ──► enrollment (one live per customer per flow) ──► tick:
--     trigger (entry rule on fresh state) → send / wait / wait for event /
--     condition (yes/no) / A/B split / team alert / exit ... until it waits
--     or ends. A goal fact ends the enrollment as GOAL (conversion).
--
--   send step ──► crm.messages (outbox) ──► worker: opt-out, contact, send
--     window and daily cap checks → render (src/lib/crm-messages.ts) →
--     SENT / DRY_RUN (no channel configured) / SKIPPED / FAILED (retry).
--
-- Published flows are versioned: running enrollments keep the graph they
-- entered with, edits only affect new entries after the next publish.
-- =====================================================================

insert into crm.settings (key, value, description) values
  ('send_window', '{"start_hour": 8, "end_hour": 21}',
   'Janela de envio de mensagens de marketing (horário dos relatórios). Fora dela, a mensagem espera o próximo início.');

-- ---------------------------------------------------------------------
-- MESSAGE TEMPLATES
-- ---------------------------------------------------------------------

create table crm.message_templates (
  template_id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_]{3,60}$'),
  name text not null,
  channel text not null check (channel in ('email','sms','whatsapp','rcs')),
  purpose text not null default 'marketing' check (purpose in ('marketing','transactional')),
  description text,
  content jsonb not null,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger message_templates_audit after update on crm.message_templates
for each row execute function crm.audit_changes('key', 'name', 'purpose', 'archived', 'content');
create trigger message_templates_audit_insert after insert on crm.message_templates
for each row execute function crm.audit_insert('key', 'name');

-- Channel rules, in Portuguese because they are shown to the person editing.
create function crm.template_errors(p_channel text, c jsonb) returns text[]
language plpgsql immutable as $$
declare
  e text[] := '{}';
  b jsonb;
  url_ok text := '^(https?://|\{\{\s*\w+\s*\}\})';
  n_url int; n_phone int;
begin
  if c is null or jsonb_typeof(c) <> 'object' then return array['Conteúdo inválido']; end if;
  if p_channel = 'email' then
    if coalesce(btrim(c ->> 'subject'), '') = '' then e := array_append(e, 'Assunto é obrigatório'); end if;
    if length(c ->> 'subject') > 150 then e := array_append(e, 'Assunto com mais de 150 caracteres'); end if;
    if length(c ->> 'preheader') > 200 then e := array_append(e, 'Pré-cabeçalho com mais de 200 caracteres'); end if;
    if jsonb_typeof(c -> 'blocks') is distinct from 'array' or jsonb_array_length(c -> 'blocks') = 0 then
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

-- ---------------------------------------------------------------------
-- OPT-OUTS (LGPD): marketing messages are never sent on a channel the
-- customer opted out of. Transactional messages (payment, delivery) still go.
-- ---------------------------------------------------------------------

create table crm.channel_optouts (
  customer_id uuid not null references crm.customers(customer_id),
  channel text not null check (channel in ('email','sms','whatsapp','rcs','all')),
  source text,
  created_at timestamptz not null default now(),
  primary key (customer_id, channel)
);

-- ---------------------------------------------------------------------
-- FLOWS
-- ---------------------------------------------------------------------

create table crm.flows (
  flow_id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_]{3,60}$'),
  name text not null,
  description text,
  status text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  trigger_fact text not null,
  trigger_filter jsonb not null default '{}',
  entry_rule jsonb not null default '{}',          -- checked on the customer's state when the flow starts
  reentry text not null default 'after_exit' check (reentry in ('once','after_exit')),
  max_trigger_age_hours int not null default 72 check (max_trigger_age_hours >= 1),
  goal_fact text,                                  -- conversion: ends the enrollment as GOAL
  graph jsonb not null default '{"nodes":[{"id":"start","type":"trigger","config":{}}],"edges":[]}',
  version int not null default 0,                  -- last published version (0 = never)
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger flows_validate before insert or update of entry_rule on crm.flows
for each row execute function crm.check_rule_column('entry_rule');
create trigger flows_audit after update on crm.flows
for each row execute function crm.audit_changes('key', 'name', 'status', 'version', 'trigger_fact', 'entry_rule', 'goal_fact');
create trigger flows_audit_insert after insert on crm.flows
for each row execute function crm.audit_insert('key', 'name');

create table crm.flow_versions (
  flow_id uuid not null references crm.flows(flow_id),
  version int not null,
  graph jsonb not null,
  published_at timestamptz not null default now(),
  published_by text,
  primary key (flow_id, version)
);

create table crm.flow_enrollments (
  enrollment_id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references crm.flows(flow_id),
  version int not null,
  customer_id uuid not null references crm.customers(customer_id),
  trigger_event_id uuid references crm.customer_events(id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','WAITING','COMPLETED','EXITED','GOAL','FAILED')),
  current_node text,                    -- next node to execute (null = end of the path)
  next_run_at timestamptz,
  wait_fact text,                       -- waiting for this fact (wait_event)
  wait_filter jsonb,
  wait_event_node text,                 -- where to continue when it happens
  wait_started_at timestamptz,
  exit_reason text,
  entered_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (flow_id, trigger_event_id)
);
create unique index flow_enrollments_live_uq on crm.flow_enrollments (flow_id, customer_id)
  where status in ('ACTIVE','WAITING');
create index flow_enrollments_due_idx on crm.flow_enrollments (status, next_run_at);
create index flow_enrollments_customer_idx on crm.flow_enrollments (customer_id, status);

create table crm.flow_steps (
  id bigint generated always as identity primary key,
  enrollment_id uuid not null references crm.flow_enrollments(enrollment_id),
  node_id text not null,
  node_type text not null,
  outcome text,
  detail jsonb,
  at timestamptz not null default now()
);
create index flow_steps_enrollment_idx on crm.flow_steps (enrollment_id, id);

-- ---------------------------------------------------------------------
-- MESSAGES (outbox)
-- ---------------------------------------------------------------------

create table crm.messages (
  message_id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references crm.customers(customer_id),
  channel text not null check (channel in ('email','sms','whatsapp','rcs','team')),
  template_id uuid references crm.message_templates(template_id),
  template_key text,
  team_text text,                       -- team alerts (no template)
  flow_id uuid references crm.flows(flow_id),
  enrollment_id uuid references crm.flow_enrollments(enrollment_id),
  node_id text,
  status text not null default 'QUEUED' check (status in ('QUEUED','PROCESSING','SENT','DRY_RUN','SKIPPED','FAILED')),
  skip_reason text,
  scheduled_for timestamptz not null default now(),
  attempts int not null default 0,
  recipient text,
  rendered jsonb,
  result jsonb,
  error text,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrollment_id, node_id)       -- a step never sends twice
);
create index messages_due_idx on crm.messages (status, scheduled_for);
create index messages_customer_idx on crm.messages (customer_id, created_at);
create index messages_flow_idx on crm.messages (flow_id, status);

do $$
declare t text;
begin
  foreach t in array array['message_templates','channel_optouts','flows','flow_versions','flow_enrollments',
                           'flow_steps','messages'] loop
    execute format('alter table crm.%I enable row level security', t);
    execute format('revoke all on crm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on crm.%I to service_role', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- GRAPH
--   {"nodes":[{"id","type","config"}], "edges":[{"source","target","handle"}]}
--   types/handles: trigger(next) send(next) wait(next) wait_event(event|timeout)
--                  condition(yes|no) split(<branch keys>) alert_team(next) exit()
-- ---------------------------------------------------------------------

create function crm.flow_node(p_graph jsonb, p_id text) returns jsonb
language sql immutable as $$
  select n from jsonb_array_elements(p_graph -> 'nodes') n where n ->> 'id' = p_id limit 1
$$;

create function crm.flow_next(p_graph jsonb, p_id text, p_handle text default 'next') returns text
language sql immutable as $$
  select e ->> 'target' from jsonb_array_elements(p_graph -> 'edges') e
   where e ->> 'source' = p_id and coalesce(e ->> 'handle', 'next') = p_handle limit 1
$$;

create function crm.flow_handles(p_node jsonb) returns text[]
language sql immutable as $$
  select case p_node ->> 'type'
    when 'wait_event' then array['event','timeout']
    when 'condition' then array['yes','no']
    when 'split' then (select coalesce(array_agg(b ->> 'key'), '{}') from jsonb_array_elements(p_node #> '{config,branches}') b)
    when 'exit' then '{}'::text[]
    else array['next'] end
$$;

create function crm.wait_interval(p_config jsonb) returns interval
language sql immutable as $$
  select case coalesce(p_config ->> 'unit', 'hours')
    when 'minutes' then make_interval(mins => (p_config ->> 'amount')::int)
    when 'days' then make_interval(days => (p_config ->> 'amount')::int)
    else make_interval(hours => (p_config ->> 'amount')::int) end
$$;

-- Everything wrong with a graph, in Portuguese (empty = publishable).
create function crm.flow_graph_errors(p_graph jsonb) returns text[]
language plpgsql stable as $$
declare
  e text[] := '{}';
  n jsonb; ed jsonb;
  v_ids text[]; v_type text; c jsonb; t record;
  v_sum int; v_count int;
  v_seen text[]; v_frontier text[]; v_indeg jsonb := '{}'; v_left int;
begin
  if jsonb_typeof(p_graph -> 'nodes') is distinct from 'array' or jsonb_typeof(p_graph -> 'edges') is distinct from 'array' then
    return array['Fluxo inválido'];
  end if;
  if jsonb_array_length(p_graph -> 'nodes') > 100 then e := array_append(e, 'Máximo de 100 etapas'); end if;
  select array_agg(x ->> 'id') into v_ids from jsonb_array_elements(p_graph -> 'nodes') x;
  if (select count(distinct v) from unnest(v_ids) v) <> cardinality(v_ids) then e := array_append(e, 'Etapas com id repetido'); end if;
  if (select count(*) from jsonb_array_elements(p_graph -> 'nodes') x where x ->> 'type' = 'trigger') <> 1 then
    e := array_append(e, 'O fluxo precisa de exatamente um início');
  end if;

  for n in select * from jsonb_array_elements(p_graph -> 'nodes') loop
    v_type := n ->> 'type'; c := coalesce(n -> 'config', '{}');
    if coalesce(n ->> 'id', '') !~ '^[A-Za-z0-9_-]{1,40}$' then e := array_append(e, 'Id de etapa inválido'); end if;
    if v_type = 'send' then
      select * into t from crm.message_templates where key = c ->> 'template_key';
      if not found then e := array_append(e, format('Envio "%s": escolha uma mensagem', coalesce(n ->> 'id', '?')));
      elsif t.archived then e := array_append(e, format('Envio: a mensagem "%s" está arquivada', t.name));
      end if;
    elsif v_type = 'wait' then
      if coalesce(c ->> 'amount', '') !~ '^[0-9]+$' or (c ->> 'amount')::int < 1
         or coalesce(c ->> 'unit', 'hours') not in ('minutes','hours','days')
         or crm.wait_interval(c) > interval '365 days' then
        e := array_append(e, 'Espera: informe uma duração entre 1 minuto e 365 dias');
      end if;
    elsif v_type = 'wait_event' then
      if not coalesce(c ->> 'fact', '') = any (crm.trigger_facts()) then e := array_append(e, 'Aguardar evento: escolha o evento'); end if;
      if coalesce(c ->> 'timeout_hours', '') !~ '^[0-9]+$' or (c ->> 'timeout_hours')::int not between 1 and 2160 then
        e := array_append(e, 'Aguardar evento: prazo entre 1 hora e 90 dias');
      end if;
    elsif v_type = 'condition' then
      begin
        perform crm.validate_rule(coalesce(c -> 'rule', '{}'));
        if coalesce(c -> 'rule', '{}') = '{}'::jsonb then e := array_append(e, 'Condição: defina a regra'); end if;
      exception when others then
        e := array_append(e, 'Condição: ' || sqlerrm);
      end;
    elsif v_type = 'split' then
      select count(*), coalesce(sum((b ->> 'percent')::int), 0) into v_count, v_sum
        from jsonb_array_elements(case when jsonb_typeof(c -> 'branches') = 'array' then c -> 'branches' else '[]' end) b
       where coalesce(b ->> 'percent', '') ~ '^[0-9]+$' and coalesce(b ->> 'key', '') ~ '^[a-z]$';
      if v_count not between 2 and 4 or v_count <> jsonb_array_length(coalesce(c -> 'branches', '[]')) then
        e := array_append(e, 'Teste A/B: de 2 a 4 caminhos');
      elsif v_sum <> 100 then
        e := array_append(e, format('Teste A/B: as porcentagens somam %s%%, precisam somar 100%%', v_sum));
      end if;
    elsif v_type = 'alert_team' then
      if coalesce(btrim(c ->> 'message'), '') = '' then e := array_append(e, 'Alerta para a equipe: escreva a mensagem'); end if;
    elsif v_type not in ('trigger','exit') then
      e := array_append(e, format('Tipo de etapa desconhecido: %s', v_type));
    end if;
  end loop;

  for ed in select * from jsonb_array_elements(p_graph -> 'edges') loop
    n := crm.flow_node(p_graph, ed ->> 'source');
    if n is null or crm.flow_node(p_graph, ed ->> 'target') is null then
      e := array_append(e, 'Ligação para uma etapa que não existe');
    elsif not coalesce(ed ->> 'handle', 'next') = any (crm.flow_handles(n)) then
      e := array_append(e, format('Saída "%s" inválida para a etapa %s', coalesce(ed ->> 'handle', 'next'), n ->> 'id'));
    elsif crm.flow_node(p_graph, ed ->> 'target') ->> 'type' = 'trigger' then
      e := array_append(e, 'Nenhuma etapa pode voltar para o início');
    end if;
  end loop;
  if (select count(*) from (select x ->> 'source' as src, coalesce(x ->> 'handle', 'next') as h
                              from jsonb_array_elements(p_graph -> 'edges') x group by 1, 2 having count(*) > 1) d) > 0 then
    e := array_append(e, 'Uma saída está ligada a mais de uma etapa');
  end if;
  if cardinality(e) > 0 then return e; end if;

  -- Reachability from the start and no cycles (Kahn over the reachable part).
  select array[x ->> 'id'] into v_frontier from jsonb_array_elements(p_graph -> 'nodes') x where x ->> 'type' = 'trigger';
  v_seen := v_frontier;
  while cardinality(v_frontier) > 0 loop
    select coalesce(array_agg(distinct x ->> 'target'), '{}') into v_frontier
      from jsonb_array_elements(p_graph -> 'edges') x
     where x ->> 'source' = any (v_frontier) and not (x ->> 'target' = any (v_seen));
    v_seen := v_seen || v_frontier;
  end loop;
  if cardinality(v_seen) < cardinality(v_ids) then
    e := array_append(e, format('%s etapa(s) solta(s), sem ligação a partir do início', cardinality(v_ids) - cardinality(v_seen)));
  end if;
  v_left := cardinality(v_ids);
  v_frontier := array(select x ->> 'id' from jsonb_array_elements(p_graph -> 'nodes') x
                       where not exists (select 1 from jsonb_array_elements(p_graph -> 'edges') y where y ->> 'target' = x ->> 'id'));
  v_seen := '{}';
  while cardinality(v_frontier) > 0 loop
    v_seen := v_seen || v_frontier;
    v_frontier := array(
      select distinct x ->> 'id' from jsonb_array_elements(p_graph -> 'nodes') x
       where not (x ->> 'id' = any (v_seen))
         and not exists (select 1 from jsonb_array_elements(p_graph -> 'edges') y
                          where y ->> 'target' = x ->> 'id' and not (y ->> 'source' = any (v_seen))));
  end loop;
  if cardinality(v_seen) < v_left then e := array_append(e, 'O fluxo tem um ciclo (uma etapa volta para trás)'); end if;
  return e;
end;
$$;

-- ---------------------------------------------------------------------
-- ENGINE
-- ---------------------------------------------------------------------

-- New fact: goals, waiting enrollments, new enrollments (same transaction as the fact).
create function crm.flows_on_fact() returns trigger
language plpgsql as $$
begin
  -- 1. goal reached
  with done as (
    update crm.flow_enrollments en set status = 'GOAL', exit_reason = 'goal:' || new.fact_type,
           finished_at = now(), next_run_at = null, updated_at = now()
      from crm.flows f
     where f.flow_id = en.flow_id and en.customer_id = new.customer_id and en.status in ('ACTIVE','WAITING')
       and f.goal_fact = new.fact_type and new.occurred_at >= en.entered_at - interval '1 minute'
    returning en.enrollment_id
  )
  insert into crm.flow_steps (enrollment_id, node_id, node_type, outcome, detail)
  select enrollment_id, 'goal', 'goal', 'GOAL', jsonb_build_object('fact', new.fact_type) from done;

  -- 2. the event a "wait for event" step was waiting for
  update crm.flow_enrollments set status = 'ACTIVE', current_node = wait_event_node, next_run_at = now(),
         wait_fact = null, wait_filter = null, wait_event_node = null, updated_at = now()
   where customer_id = new.customer_id and status = 'WAITING' and wait_fact = new.fact_type
     and new.data @> coalesce(wait_filter, '{}') and new.occurred_at >= wait_started_at - interval '1 minute';

  -- 3. new enrollments (entry rule is checked when the flow starts, on fresh state)
  insert into crm.flow_enrollments (flow_id, version, customer_id, trigger_event_id, current_node, next_run_at)
  select f.flow_id, f.version, new.customer_id, new.id,
         (select n ->> 'id' from jsonb_array_elements(v.graph -> 'nodes') n where n ->> 'type' = 'trigger'), now()
    from crm.flows f join crm.flow_versions v on v.flow_id = f.flow_id and v.version = f.version
   where f.status = 'ACTIVE' and f.trigger_fact = new.fact_type
     and new.data @> f.trigger_filter
     and new.occurred_at > now() - make_interval(hours => f.max_trigger_age_hours)
     and not exists (select 1 from crm.flow_enrollments x where x.flow_id = f.flow_id and x.customer_id = new.customer_id
                       and (x.status in ('ACTIVE','WAITING') or f.reentry = 'once'))
  on conflict do nothing;
  return null;
end;
$$;

create trigger customer_events_flows after insert on crm.customer_events
for each row execute function crm.flows_on_fact();

create function crm.flow_step(p_enrollment uuid, p_node jsonb, p_outcome text, p_detail jsonb default null) returns void
language sql as $$
  insert into crm.flow_steps (enrollment_id, node_id, node_type, outcome, detail)
  values (p_enrollment, coalesce(p_node ->> 'id', '?'), coalesce(p_node ->> 'type', '?'), p_outcome, p_detail)
$$;

-- Deterministic A/B choice (same enrollment → same branch).
create function crm.split_branch(p_node jsonb, p_seed text) returns text
language sql immutable as $$
  with b as (
    select x ->> 'key' as key, (x ->> 'percent')::int as pct, ord
      from jsonb_array_elements(p_node #> '{config,branches}') with ordinality t(x, ord)
  ), roll as (select ('x' || substr(md5(p_seed), 1, 7))::bit(28)::int % 100 as r)
  select key from (select key, sum(pct) over (order by ord) as upto from b) s, roll
   where roll.r < s.upto order by s.upto limit 1
$$;

-- Advance due enrollments until each one waits or ends.
create function crm.flow_tick(p_limit int default 200, p_max_steps int default 30) returns int
language plpgsql as $$
declare
  en record; g jsonb; n jsonb; c jsonb; v_next text; v_out text; v_steps int; v_count int := 0; v_tpl uuid;
begin
  for en in
    select e.*, f.status as flow_status, f.entry_rule, f.key as flow_key
      from crm.flow_enrollments e join crm.flows f using (flow_id)
     where e.status in ('ACTIVE','WAITING') and e.next_run_at <= now() and f.status in ('ACTIVE','ARCHIVED')
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
        if not crm.eval_rule(en.entry_rule, crm.features(en.customer_id)) then
          perform crm.flow_step(en.enrollment_id, n, 'entry_rule_not_met');
          update crm.flow_enrollments set status = 'EXITED', exit_reason = 'entry_rule_not_met', finished_at = now(),
                 next_run_at = null, updated_at = now() where enrollment_id = en.enrollment_id;
          exit;
        end if;
        perform crm.flow_step(en.enrollment_id, n, 'entered');
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
        perform crm.flow_step(en.enrollment_id, n, 'waiting', jsonb_build_object('until', now() + crm.wait_interval(c)));
        update crm.flow_enrollments set status = 'ACTIVE', current_node = crm.flow_next(g, n ->> 'id'),
               next_run_at = now() + crm.wait_interval(c), updated_at = now()
         where enrollment_id = en.enrollment_id;
        exit;

      when 'wait_event' then
        perform crm.flow_step(en.enrollment_id, n, 'waiting', jsonb_build_object('fact', c ->> 'fact'));
        update crm.flow_enrollments set status = 'WAITING',
               current_node = crm.flow_next(g, n ->> 'id', 'timeout'),
               wait_event_node = crm.flow_next(g, n ->> 'id', 'event'),
               wait_fact = c ->> 'fact', wait_filter = coalesce(c -> 'filter', '{}'), wait_started_at = now(),
               next_run_at = now() + make_interval(hours => (c ->> 'timeout_hours')::int), updated_at = now()
         where enrollment_id = en.enrollment_id;
        exit;

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

-- What a flow would do for one customer right now (no side effects).
-- Waits are summed; "wait for event" follows the event path only for the facts in p_events.
create function crm.simulate_flow(p_graph jsonb, p_entry_rule jsonb, p_customer uuid, p_events text[] default '{}')
returns jsonb language plpgsql stable as $$
declare
  f jsonb := crm.features(p_customer);
  v_next text; n jsonb; c jsonb; v_out text; v_offset interval := '0'; v_path jsonb := '[]'; v_steps int := 0;
begin
  if f is null then raise exception 'customer % not found', p_customer; end if;
  select x ->> 'id' into v_next from jsonb_array_elements(p_graph -> 'nodes') x where x ->> 'type' = 'trigger';
  while v_next is not null and v_steps < 50 loop
    v_steps := v_steps + 1;
    n := crm.flow_node(p_graph, v_next);
    exit when n is null;
    c := coalesce(n -> 'config', '{}');
    v_out := 'next';
    case n ->> 'type'
      when 'trigger' then
        if not crm.eval_rule(coalesce(p_entry_rule, '{}'), f) then
          v_path := v_path || jsonb_build_object('node_id', n ->> 'id', 'type', 'trigger', 'outcome', 'entry_rule_not_met',
                                                 'after_minutes', 0);
          return jsonb_build_object('path', v_path, 'result', 'EXITED');
        end if;
      when 'wait' then v_offset := v_offset + crm.wait_interval(c);
      when 'wait_event' then
        if c ->> 'fact' = any (coalesce(p_events, '{}')) then v_out := 'event';
        else v_out := 'timeout'; v_offset := v_offset + make_interval(hours => coalesce((c ->> 'timeout_hours')::int, 0)); end if;
      when 'condition' then v_out := case when crm.eval_rule(c -> 'rule', f) then 'yes' else 'no' end;
      when 'split' then v_out := coalesce(crm.split_branch(n, p_customer::text || (n ->> 'id')), 'next');
      else null;
    end case;
    v_path := v_path || jsonb_build_object('node_id', n ->> 'id', 'type', n ->> 'type', 'outcome', v_out,
                                           'after_minutes', (extract(epoch from v_offset) / 60)::int,
                                           'template_key', c ->> 'template_key');
    exit when n ->> 'type' = 'exit';
    v_next := crm.flow_next(p_graph, n ->> 'id', v_out);
  end loop;
  return jsonb_build_object('path', v_path, 'result', 'COMPLETED', 'customer', crm.message_customer(p_customer));
end;
$$;

-- ---------------------------------------------------------------------
-- MESSAGE WORKER (SQL side)
-- ---------------------------------------------------------------------

create function crm.message_customer(p_customer uuid) returns jsonb
language sql stable as $$
  select coalesce(crm.features(c.customer_id), '{}') || jsonb_build_object(
           'customer_id', c.customer_id, 'full_name', c.full_name,
           'first_name', nullif(split_part(coalesce(c.full_name, ''), ' ', 1), ''),
           'email', c.email, 'phone', coalesce(c.phone, c.whatsapp), 'whatsapp', coalesce(c.whatsapp, c.phone),
           'city', c.city)
    from crm.customers c where c.customer_id = p_customer
$$;

-- Next moment inside the send window (report timezone).
create function crm.next_send_time(p_at timestamptz) returns timestamptz
language plpgsql stable as $$
declare
  w jsonb := (select value from crm.settings where key = 'send_window');
  v_start int := coalesce((w ->> 'start_hour')::int, 0);
  v_end int := coalesce((w ->> 'end_hour')::int, 24);
  v_local timestamp := p_at at time zone crm.report_tz();
  v_hour int := extract(hour from v_local);
begin
  if v_start >= v_end or (v_hour >= v_start and v_hour < v_end) then return p_at; end if;
  if v_hour >= v_end then v_local := date_trunc('day', v_local) + interval '1 day' + make_interval(hours => v_start);
  else v_local := date_trunc('day', v_local) + make_interval(hours => v_start); end if;
  return v_local at time zone crm.report_tz();
end;
$$;

create function crm.claim_messages(p_limit int default 100)
returns table (message_id uuid, channel text, purpose text, template_key text, content jsonb, team_text text,
               customer jsonb, flow_key text)
language plpgsql as $$
#variable_conflict use_column
declare
  m record; v_reason text; v_cust jsonb; v_when timestamptz;
  v_cap int := coalesce(crm.setting_num('max_actions_per_customer_per_day'), 3)::int;
begin
  for m in
    select ms.*, t.purpose, t.content, t.archived, f.key as fkey
      from crm.messages ms
      left join crm.message_templates t using (template_id)
      left join crm.flows f on f.flow_id = ms.flow_id
     where (ms.status = 'QUEUED' and ms.scheduled_for <= now())
        or (ms.status = 'PROCESSING' and ms.updated_at < now() - interval '15 minutes')
     order by ms.scheduled_for
     for update of ms skip locked
     limit greatest(p_limit, 1)
  loop
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
      elsif m.purpose = 'marketing' and
            (select count(*) from crm.messages x where x.customer_id = m.customer_id and x.message_id <> m.message_id
                and x.channel <> 'team' and x.status in ('SENT','DRY_RUN','PROCESSING')
                and coalesce(x.executed_at, x.updated_at) > now() - interval '24 hours')
          + (select count(*) from crm.automation_runs x where x.customer_id = m.customer_id
                and x.status in ('SENT','DRY_RUN','PROCESSING')
                and coalesce(x.executed_at, x.updated_at) > now() - interval '24 hours') >= v_cap then
        v_reason := 'daily_cap';
      elsif m.purpose = 'marketing' then
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
                        m.team_text, v_cust, m.fkey;
  end loop;
end;
$$;

create function crm.complete_message(p_message uuid, p_status text, p_recipient text, p_rendered jsonb,
                                     p_result jsonb, p_error text) returns text
language plpgsql as $$
declare v_attempts int;
begin
  if p_status not in ('SENT','DRY_RUN','FAILED','SKIPPED') then raise exception 'invalid message status %', p_status; end if;
  select attempts into v_attempts from crm.messages where message_id = p_message;
  if not found then raise exception 'message % not found', p_message; end if;
  if p_status = 'FAILED' and v_attempts < 5 then
    update crm.messages set status = 'QUEUED', scheduled_for = now() + make_interval(mins => power(2, v_attempts)::int),
           error = p_error, updated_at = now() where message_id = p_message;
    return 'QUEUED';
  end if;
  update crm.messages set status = p_status, recipient = p_recipient, rendered = p_rendered, result = p_result,
         error = p_error, skip_reason = case when p_status = 'SKIPPED' then p_error end,
         executed_at = now(), updated_at = now()
   where message_id = p_message;
  return p_status;
end;
$$;

-- ---------------------------------------------------------------------
-- CUSTOMER 360 + LGPD
-- ---------------------------------------------------------------------

alter function crm.customer_360(uuid) rename to customer_360_profit;

create function crm.customer_360(p_customer uuid) returns jsonb
language sql stable as $$
  select case when b is null then null else
    jsonb_set(jsonb_set(jsonb_set(b,
      '{crm,flows}', (select coalesce(jsonb_agg(jsonb_build_object(
          'flow', f.key, 'name', f.name, 'status', e.status, 'current_node', e.current_node,
          'exit_reason', e.exit_reason, 'entered_at', e.entered_at, 'finished_at', e.finished_at,
          'next_run_at', e.next_run_at) order by e.entered_at desc), '[]')
        from crm.flow_enrollments e join crm.flows f using (flow_id) where e.customer_id = p_customer)),
      '{crm,messages}', (select coalesce(jsonb_agg(jsonb_build_object(
          'message_id', m.message_id, 'channel', m.channel, 'template', m.template_key, 'flow', f.name,
          'status', m.status, 'skip_reason', m.skip_reason, 'rendered', m.rendered,
          'at', coalesce(m.executed_at, m.scheduled_for)) order by m.created_at desc), '[]')
        from (select * from crm.messages where customer_id = p_customer order by created_at desc limit 50) m
        left join crm.flows f using (flow_id))),
      '{crm,optouts}', (select coalesce(jsonb_agg(channel order by channel), '[]')
        from crm.channel_optouts where customer_id = p_customer))
  end
  from (select crm.customer_360_profit(p_customer) as b) x
$$;

alter function crm.anonymize_customer(uuid, text) rename to anonymize_customer_core;

create function crm.anonymize_customer(p_customer uuid, p_reason text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  v := crm.anonymize_customer_core(p_customer, p_reason);
  update crm.messages set rendered = '{"anonimizado": true}', recipient = null where customer_id = p_customer;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- PUBLIC ENTRY POINTS
-- ---------------------------------------------------------------------

-- Templates
create function public.crm_list_templates(p_channel text default null, p_include_archived boolean default false)
returns table (key text, name text, channel text, purpose text, description text, content jsonb, archived boolean,
               updated_at timestamptz, used_in_flows bigint, sent_30d bigint)
language sql stable security definer set search_path = crm, public, extensions as $$
  select t.key, t.name, t.channel, t.purpose, t.description, t.content, t.archived, t.updated_at,
         (select count(*) from crm.flows f where f.status <> 'ARCHIVED'
             and exists (select 1 from jsonb_array_elements(f.graph -> 'nodes') n where n #>> '{config,template_key}' = t.key)),
         (select count(*) from crm.messages m where m.template_id = t.template_id and m.status in ('SENT','DRY_RUN')
             and m.executed_at > now() - interval '30 days')
    from crm.message_templates t
   where (p_channel is null or t.channel = p_channel) and (p_include_archived or not t.archived)
   order by t.channel, t.name
$$;

create function public.crm_template_errors(p_channel text, p_content jsonb) returns text[]
language sql stable security definer set search_path = crm, public, extensions as $$
  select crm.template_errors(p_channel, p_content)
$$;

create function public.crm_upsert_template(p_key text, p_name text, p_channel text, p_content jsonb,
                                           p_purpose text default 'marketing', p_description text default null,
                                           p_actor text default null) returns text
language plpgsql security definer set search_path = crm, public, extensions as $$
declare e text[];
begin
  perform crm.set_actor(p_actor);
  if p_key !~ '^[a-z0-9_]{3,60}$' then raise exception 'Chave: 3 a 60 caracteres (a-z, 0-9, _)'; end if;
  if nullif(btrim(p_name), '') is null then raise exception 'Nome é obrigatório'; end if;
  if p_purpose not in ('marketing','transactional') then raise exception 'Finalidade inválida'; end if;
  e := crm.template_errors(p_channel, p_content);
  if cardinality(e) > 0 then raise exception '%', array_to_string(e, '; '); end if;
  if exists (select 1 from crm.message_templates where key = p_key and channel <> p_channel) then
    raise exception 'Já existe uma mensagem com essa chave em outro canal';
  end if;
  insert into crm.message_templates (key, name, channel, purpose, description, content)
  values (p_key, p_name, p_channel, p_purpose, p_description, p_content)
  on conflict (key) do update set name = excluded.name, purpose = excluded.purpose,
    description = excluded.description, content = excluded.content, archived = false, updated_at = now();
  return p_key;
end;
$$;

create function public.crm_archive_template(p_key text, p_archived boolean default true, p_actor text default null)
returns boolean language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  if p_archived and exists (select 1 from crm.flows f where f.status in ('ACTIVE','PAUSED')
       and exists (select 1 from crm.flow_versions v, jsonb_array_elements(v.graph -> 'nodes') n
                    where v.flow_id = f.flow_id and v.version = f.version and n #>> '{config,template_key}' = p_key)) then
    raise exception 'Mensagem em uso por um fluxo publicado: tire-a do fluxo antes de arquivar';
  end if;
  update crm.message_templates set archived = p_archived, updated_at = now() where key = p_key;
  return found;
end;
$$;

-- Flows
create function public.crm_list_flows()
returns table (key text, name text, description text, status text, trigger_fact text, goal_fact text, version int,
               published_at timestamptz, updated_at timestamptz, steps int,
               live bigint, completed bigint, goals bigint, exited bigint, entered_30d bigint, messages_30d bigint)
language sql stable security definer set search_path = crm, public, extensions as $$
  select f.key, f.name, f.description, f.status, f.trigger_fact, f.goal_fact, f.version, f.published_at, f.updated_at,
         jsonb_array_length(f.graph -> 'nodes'),
         count(e.*) filter (where e.status in ('ACTIVE','WAITING')),
         count(e.*) filter (where e.status = 'COMPLETED'),
         count(e.*) filter (where e.status = 'GOAL'),
         count(e.*) filter (where e.status in ('EXITED','FAILED')),
         count(e.*) filter (where e.entered_at > now() - interval '30 days'),
         (select count(*) from crm.messages m where m.flow_id = f.flow_id and m.status in ('SENT','DRY_RUN')
             and m.executed_at > now() - interval '30 days')
    from crm.flows f left join crm.flow_enrollments e using (flow_id)
   where f.status <> 'ARCHIVED'
   group by f.flow_id order by (f.status = 'ACTIVE') desc, f.name
$$;

create function public.crm_get_flow(p_key text) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select to_jsonb(f) - 'flow_id' || jsonb_build_object(
           'errors', crm.flow_graph_errors(f.graph),
           'published_graph', (select v.graph from crm.flow_versions v where v.flow_id = f.flow_id and v.version = f.version),
           'has_unpublished_changes', f.version = 0 or f.graph is distinct from
               (select v.graph from crm.flow_versions v where v.flow_id = f.flow_id and v.version = f.version))
    from crm.flows f where f.key = p_key
$$;

create function public.crm_flow_graph_errors(p_graph jsonb) returns text[]
language sql stable security definer set search_path = crm, public, extensions as $$
  select crm.flow_graph_errors(p_graph)
$$;

create function public.crm_save_flow(p_key text, p_name text, p_trigger_fact text, p_graph jsonb,
                                     p_description text default null, p_trigger_filter jsonb default '{}',
                                     p_entry_rule jsonb default '{}', p_reentry text default 'after_exit',
                                     p_max_trigger_age_hours int default 72, p_goal_fact text default null,
                                     p_actor text default null) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  if p_key !~ '^[a-z0-9_]{3,60}$' then raise exception 'Chave: 3 a 60 caracteres (a-z, 0-9, _)'; end if;
  if nullif(btrim(p_name), '') is null then raise exception 'Nome é obrigatório'; end if;
  if not p_trigger_fact = any (crm.trigger_facts()) then raise exception 'Gatilho desconhecido: %', p_trigger_fact; end if;
  if p_goal_fact is not null and not p_goal_fact = any (crm.trigger_facts()) then raise exception 'Meta desconhecida: %', p_goal_fact; end if;
  if jsonb_typeof(p_graph -> 'nodes') is distinct from 'array' or jsonb_typeof(p_graph -> 'edges') is distinct from 'array' then
    raise exception 'Fluxo inválido';
  end if;
  if jsonb_typeof(coalesce(p_trigger_filter, '{}')) <> 'object' then raise exception 'Filtro do gatilho inválido'; end if;
  if exists (select 1 from crm.flows where key = p_key and status = 'ARCHIVED') then raise exception 'Fluxo arquivado'; end if;
  insert into crm.flows (key, name, description, trigger_fact, trigger_filter, entry_rule, reentry, max_trigger_age_hours,
                         goal_fact, graph)
  values (p_key, p_name, p_description, p_trigger_fact, coalesce(p_trigger_filter, '{}'), coalesce(p_entry_rule, '{}'),
          p_reentry, p_max_trigger_age_hours, p_goal_fact, p_graph)
  on conflict (key) do update set name = excluded.name, description = excluded.description,
    trigger_fact = excluded.trigger_fact, trigger_filter = excluded.trigger_filter, entry_rule = excluded.entry_rule,
    reentry = excluded.reentry, max_trigger_age_hours = excluded.max_trigger_age_hours, goal_fact = excluded.goal_fact,
    graph = excluded.graph, updated_at = now();
  return jsonb_build_object('key', p_key, 'errors', crm.flow_graph_errors(p_graph));
end;
$$;

create function public.crm_publish_flow(p_key text, p_actor text default null) returns int
language plpgsql security definer set search_path = crm, public, extensions as $$
declare f crm.flows; e text[];
begin
  perform crm.set_actor(p_actor);
  select * into f from crm.flows where key = p_key for update;
  if not found then raise exception 'Fluxo % não encontrado', p_key; end if;
  if f.status = 'ARCHIVED' then raise exception 'Fluxo arquivado'; end if;
  e := crm.flow_graph_errors(f.graph);
  if cardinality(e) > 0 then raise exception 'Corrija antes de publicar: %', array_to_string(e, '; '); end if;
  insert into crm.flow_versions (flow_id, version, graph, published_by)
  values (f.flow_id, f.version + 1, f.graph, crm.current_actor());
  update crm.flows set version = f.version + 1, status = 'ACTIVE', published_at = now(), updated_at = now()
   where flow_id = f.flow_id;
  return f.version + 1;
end;
$$;

create function public.crm_set_flow_status(p_key text, p_status text, p_actor text default null) returns text
language plpgsql security definer set search_path = crm, public, extensions as $$
declare f crm.flows;
begin
  perform crm.set_actor(p_actor);
  select * into f from crm.flows where key = p_key for update;
  if not found then raise exception 'Fluxo % não encontrado', p_key; end if;
  if p_status not in ('ACTIVE','PAUSED','ARCHIVED') then raise exception 'Status inválido'; end if;
  if p_status = 'ACTIVE' and f.version = 0 then raise exception 'Publique o fluxo antes de ativar'; end if;
  if f.status = 'ARCHIVED' then raise exception 'Fluxo arquivado'; end if;
  update crm.flows set status = p_status, updated_at = now() where flow_id = f.flow_id;
  if p_status = 'ARCHIVED' then  -- nobody stays inside an archived flow
    update crm.flow_enrollments set status = 'EXITED', exit_reason = 'flow_archived', finished_at = now(),
           next_run_at = null, updated_at = now()
     where flow_id = f.flow_id and status in ('ACTIVE','WAITING');
  end if;
  return p_status;
end;
$$;

-- Per-step numbers for the builder: how many passed, by outcome, and how many are there now.
create function public.crm_flow_stats(p_key text) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  with f as (select * from crm.flows where key = p_key),
  en as (select e.* from crm.flow_enrollments e join f using (flow_id))
  select jsonb_build_object(
    'enrollments', (select jsonb_build_object(
        'total', count(*), 'live', count(*) filter (where status in ('ACTIVE','WAITING')),
        'completed', count(*) filter (where status = 'COMPLETED'), 'goal', count(*) filter (where status = 'GOAL'),
        'exited', count(*) filter (where status = 'EXITED'), 'failed', count(*) filter (where status = 'FAILED'),
        'goal_rate', crm.pct(count(*) filter (where status = 'GOAL'), count(*) filter (where status not in ('ACTIVE','WAITING'))))
      from en),
    'nodes', (select coalesce(jsonb_object_agg(node_id, x), '{}') from (
        select s.node_id, jsonb_build_object('passed', sum(s.n), 'outcomes', jsonb_object_agg(s.outcome, s.n)) as x
          from (select node_id, coalesce(outcome, '?') as outcome, count(distinct enrollment_id) as n
                  from crm.flow_steps where enrollment_id in (select enrollment_id from en)
                 group by 1, 2) s
         group by s.node_id) t),
    -- where live customers are now: the last step they went through (a wait shows its waiting customers)
    'here_now', (select coalesce(jsonb_object_agg(k, n), '{}') from (
        select coalesce((select st.node_id from crm.flow_steps st where st.enrollment_id = e.enrollment_id
                          order by st.id desc limit 1), e.current_node, '?') as k,
               count(*) as n
          from en e where e.status in ('ACTIVE','WAITING') group by 1) t),
    -- A/B: conversion of each path (only finished enrollments count)
    'split_goals', (select coalesce(jsonb_object_agg(node_id || ':' || outcome, jsonb_build_object(
          'finished', finished, 'goal', goal, 'rate', crm.pct(goal, finished))), '{}')
        from (select st.node_id, st.outcome,
                     count(*) filter (where e.status not in ('ACTIVE','WAITING')) as finished,
                     count(*) filter (where e.status = 'GOAL') as goal
                from crm.flow_steps st join en e using (enrollment_id)
               where st.node_type = 'split' group by 1, 2) t),
    'messages', (select jsonb_build_object(
        'queued', count(*) filter (where m.status in ('QUEUED','PROCESSING')),
        'sent', count(*) filter (where m.status = 'SENT'), 'dry_run', count(*) filter (where m.status = 'DRY_RUN'),
        'skipped', count(*) filter (where m.status = 'SKIPPED'), 'failed', count(*) filter (where m.status = 'FAILED'))
      from crm.messages m join f using (flow_id)),
    'recent', (select coalesce(jsonb_agg(r order by r.entered_at desc), '[]') from (
        select e.enrollment_id, e.customer_id, c.full_name, e.status, e.current_node, e.exit_reason, e.entered_at,
               e.finished_at, e.next_run_at, e.version
          from en e join crm.customers c using (customer_id) order by e.entered_at desc limit 50) r))
$$;

create function public.crm_simulate_flow(p_customer_id uuid, p_graph jsonb, p_entry_rule jsonb default '{}',
                                         p_events text[] default '{}') returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select crm.simulate_flow(p_graph, p_entry_rule, p_customer_id, p_events)
$$;

create function public.crm_message_customer(p_customer_id uuid) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select crm.message_customer(p_customer_id)
$$;

create function public.crm_list_messages(p_flow_key text default null, p_status text default null, p_limit int default 100)
returns table (message_id uuid, customer_id uuid, full_name text, channel text, template text, flow text, status text,
               skip_reason text, recipient text, rendered jsonb, error text, at timestamptz)
language sql stable security definer set search_path = crm, public, extensions as $$
  select m.message_id, m.customer_id, c.full_name, m.channel, m.template_key, f.name, m.status, m.skip_reason,
         m.recipient, m.rendered, m.error, coalesce(m.executed_at, m.scheduled_for)
    from crm.messages m join crm.customers c using (customer_id) left join crm.flows f using (flow_id)
   where (p_flow_key is null or f.key = p_flow_key) and (p_status is null or m.status = p_status)
   order by m.created_at desc limit least(greatest(p_limit, 1), 500)
$$;

create function public.crm_set_optout(p_customer_id uuid, p_channel text, p_opt_out boolean, p_actor text default null)
returns void language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  if p_channel not in ('email','sms','whatsapp','rcs','all') then raise exception 'Canal inválido'; end if;
  if p_opt_out then
    insert into crm.channel_optouts (customer_id, channel, source) values (p_customer_id, p_channel, crm.current_actor())
    on conflict do nothing;
  else
    delete from crm.channel_optouts where customer_id = p_customer_id and channel = p_channel;
  end if;
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('customers', p_customer_id::text, 'opt_out:' || p_channel, null, p_opt_out::text, crm.current_actor());
end;
$$;

-- Worker
create function public.crm_flow_tick(p_limit int default 200) returns int
language sql security definer set search_path = crm, public, extensions as $$ select crm.flow_tick(p_limit) $$;

create function public.crm_claim_messages(p_limit int default 100)
returns table (message_id uuid, channel text, purpose text, template_key text, content jsonb, team_text text,
               customer jsonb, flow_key text)
language sql security definer set search_path = crm, public, extensions as $$ select * from crm.claim_messages(p_limit) $$;

create function public.crm_complete_message(p_message_id uuid, p_status text, p_recipient text default null,
                                            p_rendered jsonb default null, p_result jsonb default null,
                                            p_error text default null) returns text
language sql security definer set search_path = crm, public, extensions as $$
  select crm.complete_message(p_message_id, p_status, p_recipient, p_rendered, p_result, p_error)
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_list_templates(text,boolean)', 'crm_template_errors(text,jsonb)',
    'crm_upsert_template(text,text,text,jsonb,text,text,text)', 'crm_archive_template(text,boolean,text)',
    'crm_list_flows()', 'crm_get_flow(text)', 'crm_flow_graph_errors(jsonb)',
    'crm_save_flow(text,text,text,jsonb,text,jsonb,jsonb,text,int,text,text)', 'crm_publish_flow(text,text)',
    'crm_set_flow_status(text,text,text)', 'crm_flow_stats(text)', 'crm_simulate_flow(uuid,jsonb,jsonb,text[])',
    'crm_message_customer(uuid)', 'crm_list_messages(text,text,int)', 'crm_set_optout(uuid,text,boolean,text)',
    'crm_flow_tick(int)', 'crm_claim_messages(int)', 'crm_complete_message(uuid,text,text,jsonb,jsonb,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- STARTERS: a few message templates and two draft flows to edit.
-- Nothing runs until someone publishes a flow.
-- ---------------------------------------------------------------------

insert into crm.message_templates (key, name, channel, purpose, description, content) values
  ('boas_vindas_email', 'Boas-vindas (e-mail)', 'email', 'transactional', 'Primeira compra confirmada',
   '{"subject":"{{first_name}}, seu pedido foi confirmado!","preheader":"Veja o que acontece agora","from_name":"Kakauma",
     "blocks":[{"type":"heading","text":"Que bom ter você aqui, {{first_name}}!"},
               {"type":"text","text":"Seu pedido foi confirmado. Assim que ele for postado, mandamos o código de rastreio."},
               {"type":"button","text":"Acompanhar pedido","url":"https://kakauma.com.br"},
               {"type":"divider"},
               {"type":"text","text":"Qualquer dúvida, é só responder este e-mail."}]}'),
  ('pagamento_atrasado_whatsapp', 'Pagamento atrasado (WhatsApp)', 'whatsapp', 'transactional',
   'Assinatura com cobrança não confirmada',
   '{"category":"utility","header":{"type":"text","text":"Pagamento da assinatura"},
     "body":"Oi {{first_name}}, não conseguimos confirmar o pagamento do seu ciclo {{subscription_cycle}}. Quer que a gente envie um novo link?",
     "footer":"Kakauma","buttons":[{"type":"quick_reply","text":"Quero o link"},{"type":"quick_reply","text":"Falar com alguém"}]}'),
  ('pagamento_atrasado_sms', 'Pagamento atrasado (SMS)', 'sms', 'transactional', 'Lembrete curto por SMS',
   '{"text":"Kakauma: {{first_name}}, o pagamento da sua assinatura nao foi confirmado. Responda LINK para receber um novo."}'),
  ('reativacao_rcs', 'Volte para a Kakauma (RCS)', 'rcs', 'marketing', 'Reativação com cartão e botões',
   '{"kind":"card","cards":[{"title":"Sentimos sua falta, {{first_name}}","description":"Seu sono merece. Volte com condição especial nesta semana.",
     "media_url":"https://kakauma.com.br/assets/kakauma-logo-CFkJSghB.png","media_height":"medium"}],
     "suggestions":[{"type":"url","text":"Ver oferta","url":"https://kakauma.com.br"},{"type":"reply","text":"Não tenho interesse"}],
     "fallback_sms":"Kakauma: {{first_name}}, sentimos sua falta! Volte com condicao especial: kakauma.com.br"}');

insert into crm.flows (key, name, description, trigger_fact, entry_rule, goal_fact, graph) values
  ('recuperacao_pagamento', 'Recuperação de pagamento', 'Assinante com pagamento atrasado: WhatsApp, espera o pagamento por 2 dias, depois SMS ou alerta para a equipe se for alto valor.',
   'SUBSCRIPTION_PAYMENT_LATE', '{"field":"has_active_subscription","op":"is_true"}', 'SUBSCRIPTION_PAYMENT_RECOVERED',
   '{"nodes":[
      {"id":"start","type":"trigger","config":{}},
      {"id":"wa1","type":"send","config":{"template_key":"pagamento_atrasado_whatsapp"}},
      {"id":"wait_pay","type":"wait_event","config":{"fact":"SUBSCRIPTION_PAYMENT_RECOVERED","timeout_hours":48}},
      {"id":"thanks","type":"exit","config":{}},
      {"id":"is_vip","type":"condition","config":{"rule":{"field":"net_ltv","op":">=","value":500}}},
      {"id":"team","type":"alert_team","config":{"message":"{{full_name}} (LTV R$ {{net_ltv}}) segue com pagamento atrasado após WhatsApp. Ligar."}},
      {"id":"sms1","type":"send","config":{"template_key":"pagamento_atrasado_sms"}}],
     "edges":[
      {"source":"start","target":"wa1","handle":"next"},
      {"source":"wa1","target":"wait_pay","handle":"next"},
      {"source":"wait_pay","target":"thanks","handle":"event"},
      {"source":"wait_pay","target":"is_vip","handle":"timeout"},
      {"source":"is_vip","target":"team","handle":"yes"},
      {"source":"is_vip","target":"sms1","handle":"no"}]}'),
  ('boas_vindas', 'Boas-vindas do primeiro pedido', 'E-mail de boas-vindas e, 3 dias depois, teste A/B entre RCS e nada (controle) para medir recompra.',
   'PURCHASE_PAID', '{"field":"paid_orders","op":"=","value":1}', null,
   '{"nodes":[
      {"id":"start","type":"trigger","config":{}},
      {"id":"email1","type":"send","config":{"template_key":"boas_vindas_email"}},
      {"id":"wait3","type":"wait","config":{"amount":3,"unit":"days"}},
      {"id":"ab","type":"split","config":{"branches":[{"key":"a","label":"RCS","percent":50},{"key":"b","label":"Controle","percent":50}]}},
      {"id":"rcs1","type":"send","config":{"template_key":"reativacao_rcs"}}],
     "edges":[
      {"source":"start","target":"email1","handle":"next"},
      {"source":"email1","target":"wait3","handle":"next"},
      {"source":"wait3","target":"ab","handle":"next"},
      {"source":"ab","target":"rcs1","handle":"a"}]}');
