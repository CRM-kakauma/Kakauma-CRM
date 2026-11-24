-- =====================================================================
-- Listas importadas: a spreadsheet (name, e-mail, phone) becomes a manual
-- segment, which a Disparo can target like any other segment.
--   * crm_create_list: a new manual segment (category 'list')
--   * crm_import_list_contacts: adds rows to a manual segment. A person who is
--     already a customer (same e-mail or WhatsApp) is reused; otherwise a real
--     (not test) contact is created. Opt-outs and LGPD deletions are respected.
-- =====================================================================

create or replace function public.crm_create_list(p_name text, p_description text default null,
                                                  p_actor text default null) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_base text;
  v_key text;
  n int := 1;
begin
  perform crm.set_actor(p_actor);
  if v_name = '' then raise exception 'Dê um nome para a lista'; end if;
  if exists (select 1 from crm.segments where lower(name) = lower(v_name)) then
    raise exception 'Já existe um segmento chamado "%"', v_name;
  end if;
  v_base := 'lista_' || left(trim(both '_' from regexp_replace(translate(lower(v_name), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'), '[^a-z0-9]+', '_', 'g')), 40);
  v_key := v_base;
  while exists (select 1 from crm.segments where key = v_key) loop
    n := n + 1;
    v_key := v_base || '_' || n;
  end loop;
  insert into crm.segments (key, name, category, description, definition, kind, is_system)
  values (v_key, v_name, 'list', coalesce(nullif(btrim(p_description), ''), 'Lista importada de planilha.'),
          '{}', 'manual', false);
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('segments', v_key, 'created_list', null, v_name, crm.current_actor());
  return jsonb_build_object('key', v_key, 'name', v_name);
end;
$$;

-- p_rows: [{"line": 2, "name": "...", "email": "...", "phone": "..."}, ...] (up to 1000 per call)
create or replace function public.crm_import_list_contacts(p_segment text, p_rows jsonb, p_actor text default null)
returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  v_seg crm.segments;
  r jsonb;
  v_line int;
  v_name text;
  v_email text;
  v_digits text;
  v_phone text;
  v_id uuid;
  v_anon timestamptz;
  n_total int := 0; n_added int := 0; n_already int := 0; n_created int := 0; n_matched int := 0;
  v_invalid jsonb := '[]';
  n_invalid int := 0;
  v_reason text;
begin
  perform crm.set_actor(p_actor);
  select * into v_seg from crm.segments where key = p_segment;
  if not found then raise exception 'Lista % não encontrada', p_segment; end if;
  if v_seg.kind <> 'manual' then raise exception 'Só dá para importar contatos numa lista manual'; end if;
  if v_seg.is_system then raise exception 'A lista % é só para contatos de teste: crie uma lista nova', v_seg.name; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Formato inválido'; end if;
  if jsonb_array_length(p_rows) > 1000 then raise exception 'Envie no máximo 1000 linhas por vez'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    n_total := n_total + 1;
    v_line := coalesce((r ->> 'line')::int, n_total);
    v_name := nullif(left(btrim(coalesce(r ->> 'name', '')), 200), '');
    v_email := crm.norm_email(r ->> 'email');
    v_digits := regexp_replace(coalesce(r ->> 'phone', ''), '\D', '', 'g');
    v_phone := null;
    v_reason := null;

    if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      v_email := null;
      v_reason := 'e-mail inválido';
    end if;
    if v_digits <> '' then
      if length(v_digits) in (12, 13) and v_digits like '55%' then v_digits := substr(v_digits, 3); end if;
      if length(v_digits) in (10, 11) then
        v_phone := crm.norm_phone(v_digits);
      else
        v_digits := '';
        v_reason := coalesce(v_reason || ' e ', '') || 'telefone inválido (use DDD + número)';
      end if;
    end if;
    if v_email is null and v_phone is null then
      n_invalid := n_invalid + 1;
      if n_invalid <= 200 then
        v_invalid := v_invalid || jsonb_build_object('line', v_line,
                       'reason', coalesce(v_reason, 'sem e-mail nem telefone'));
      end if;
      continue;
    end if;

    v_id := null;
    select customer_id into v_id from crm.customer_identities
     where (kind = 'email' and value = v_email) or (kind = 'whatsapp' and value = v_phone)
     order by (kind = 'email') desc limit 1;
    if v_id is null and v_email is not null then
      select customer_id into v_id from crm.customers where lower(email) = v_email limit 1;
    end if;

    if v_id is not null then
      select anonymized_at into v_anon from crm.customers where customer_id = v_id;
      if v_anon is not null then
        n_invalid := n_invalid + 1;
        if n_invalid <= 200 then
          v_invalid := v_invalid || jsonb_build_object('line', v_line, 'reason', 'pediu exclusão dos dados (LGPD)');
        end if;
        continue;
      end if;
      n_matched := n_matched + 1;
      -- fills what the customer is missing, never overwrites
      update crm.customers set
        full_name = coalesce(full_name, v_name),
        email = coalesce(email, v_email),
        phone = coalesce(nullif(phone, ''), nullif(v_digits, '')),
        whatsapp = coalesce(nullif(whatsapp, ''), nullif(v_digits, '')),
        updated_at = now()
       where customer_id = v_id
         and (full_name is null or email is null or coalesce(phone, '') = '' or coalesce(whatsapp, '') = '');
    else
      insert into crm.customers (full_name, email, phone, whatsapp, is_test, first_seen_at, last_seen_at)
      values (v_name, v_email, nullif(v_digits, ''), nullif(v_digits, ''), false, now(), now())
      returning customer_id into v_id;
      n_created := n_created + 1;
      perform crm.refresh_customer(v_id);
    end if;
    insert into crm.customer_identities (kind, value, customer_id)
    select k, v, v_id from (values ('email', v_email), ('whatsapp', v_phone)) x(k, v)
     where v is not null
    on conflict do nothing;

    insert into crm.segment_members (segment_id, customer_id) values (v_seg.segment_id, v_id)
    on conflict do nothing;
    if found then n_added := n_added + 1; else n_already := n_already + 1; end if;
  end loop;

  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('segments', p_segment, 'list_import', null,
          jsonb_build_object('rows', n_total, 'added', n_added, 'created', n_created, 'invalid', n_invalid)::text,
          crm.current_actor());
  return jsonb_build_object('total', n_total, 'added', n_added, 'already_in_list', n_already,
                            'created', n_created, 'matched', n_matched, 'invalid', n_invalid,
                            'invalid_rows', v_invalid);
end;
$$;

do $$
declare fn text;
begin
  foreach fn in array array['crm_create_list(text,text,text)', 'crm_import_list_contacts(text,jsonb,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;
