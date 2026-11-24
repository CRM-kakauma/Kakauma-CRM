-- =====================================================================
-- Busca em Fluxos:
--   * crm_search_flows: flows whose name / description or whose messages
--     (the templates used by their send steps, team alerts) contain the text.
--     Answers "which flow uses this copy?".
--   * crm_search_messages: the sent messages of a flow, by customer
--     (name, e-mail, phone) or by the text that was sent.
-- Case and accents are ignored.
-- =====================================================================

create or replace function crm.fold(p text) returns text
language sql immutable as $$
  select translate(lower(coalesce(p, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')
$$;

-- every string inside a json value (texts of a template, a node config)
create or replace function crm.json_strings(p jsonb) returns setof text
language sql immutable as $$
  select v #>> '{}' from jsonb_path_query(coalesce(p, 'null'), 'strict $.**') v where jsonb_typeof(v) = 'string'
$$;

create or replace function public.crm_search_flows(p_query text)
returns table (key text, name text, matches jsonb)
language sql stable security definer set search_path = crm, public, extensions as $$
  with q as (select '%' || crm.fold(btrim(p_query)) || '%' as pat where length(btrim(coalesce(p_query, ''))) >= 2),
  steps as (
    select f.flow_id, n ->> 'id' as node_id, n ->> 'type' as node_type, n -> 'config' as config
      from crm.flows f, jsonb_array_elements(f.graph -> 'nodes') n
     where f.status <> 'ARCHIVED' and n ->> 'type' in ('send', 'alert_team')
  ),
  hits as (
    -- send steps: the template's texts (and its name)
    select s.flow_id, s.node_id, t.channel, t.key as template_key, t.name as template_name, x.txt
      from steps s join crm.message_templates t on t.key = s.config ->> 'template_key', q,
           lateral (select v as txt from crm.json_strings(t.content) v
                     union all select t.name) x
     where s.node_type = 'send' and crm.fold(x.txt) like q.pat
    union all
    -- team alerts: the text written in the step
    select s.flow_id, s.node_id, 'team', null, null, x.txt
      from steps s, q, lateral crm.json_strings(s.config) x(txt)
     where s.node_type = 'alert_team' and crm.fold(x.txt) like q.pat
  ),
  per_step as (
    select distinct on (h.flow_id, h.node_id) h.*
      from hits h order by h.flow_id, h.node_id, length(h.txt) desc
  )
  select f.key, f.name,
         coalesce((select jsonb_agg(jsonb_build_object('node_id', p.node_id, 'channel', p.channel,
                                                       'template_key', p.template_key,
                                                       'template_name', p.template_name,
                                                       'text', left(p.txt, 2000)) order by p.node_id)
                     from per_step p where p.flow_id = f.flow_id), '[]')
    from crm.flows f, q
   where f.status <> 'ARCHIVED'
     and (crm.fold(f.name) like q.pat or crm.fold(f.description) like q.pat or crm.fold(f.key) like q.pat
          or exists (select 1 from per_step p where p.flow_id = f.flow_id))
   order by f.name
$$;

create or replace function public.crm_search_messages(p_flow_key text, p_query text, p_limit int default 200)
returns table (message_id uuid, customer_id uuid, full_name text, channel text, template text, flow text, status text,
               skip_reason text, recipient text, rendered jsonb, error text, at timestamptz,
               provider_status text, sent_as text)
language sql stable security definer set search_path = crm, public, extensions as $$
  with q as (select '%' || crm.fold(btrim(p_query)) || '%' as pat,
                    nullif(regexp_replace(p_query, '\D', '', 'g'), '') as digits)
  select m.message_id, m.customer_id, c.full_name, m.channel, m.template_key, f.name, m.status, m.skip_reason,
         m.recipient, m.rendered, m.error, coalesce(m.executed_at, m.scheduled_for),
         m.provider_status, m.result ->> 'sent_as'
    from crm.messages m join crm.customers c using (customer_id) join crm.flows f using (flow_id), q
   where f.key = p_flow_key
     and (crm.fold(c.full_name) like q.pat or crm.fold(c.email) like q.pat or crm.fold(m.recipient) like q.pat
          or (length(q.digits) >= 4 and (regexp_replace(coalesce(m.recipient, ''), '\D', '', 'g') like '%' || q.digits || '%'
               or regexp_replace(coalesce(c.whatsapp, c.phone, ''), '\D', '', 'g') like '%' || q.digits || '%'))
          or crm.fold(m.error) like q.pat
          or exists (select 1 from crm.json_strings(m.rendered) v where crm.fold(v) like q.pat))
   order by m.created_at desc limit least(greatest(p_limit, 1), 500)
$$;

do $$
declare fn text;
begin
  foreach fn in array array['crm_search_flows(text)', 'crm_search_messages(text,text,int)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;
