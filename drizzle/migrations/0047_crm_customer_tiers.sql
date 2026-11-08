-- =====================================================================
-- KAKAUMA CRM — customer level (Sem compra / Bronze / Prata / Ouro) and
-- sales tags for the WhatsApp attendance
--
--   The level comes from the paid orders and the net revenue (thresholds in
--   crm.settings 'customer_tiers', editable). Each level carries a sales tip
--   for the attendant. Automatic tags point at an opportunity or a care:
--   abandoned cart, Pix pending, payment refused, time to buy again, order
--   on its way, delivered recently, refund, chargeback, subscription.
--   Manual tags: written by the attendant, on the customer (or on the chat
--   when the contact is not a customer yet).
-- =====================================================================

insert into crm.settings (key, value, description) values
  ('customer_tiers', '{
     "sem_compra": {"label": "Sem compra", "tip": "Ainda não comprou: tire as dúvidas, mostre os benefícios e ofereça o cupom de primeira compra."},
     "bronze": {"label": "Bronze", "orders": 1, "revenue": 0, "tip": "Comprou 1 vez: pergunte como está sendo a experiência e ofereça o kit para continuar o tratamento."},
     "prata": {"label": "Prata", "orders": 2, "revenue": 450, "tip": "Cliente que voltou a comprar: ofereça o kit maior ou a assinatura com desconto."},
     "ouro": {"label": "Ouro", "orders": 4, "revenue": 900, "tip": "Cliente fiel: atendimento prioritário, condições exclusivas e lançamentos em primeira mão."},
     "repurchase_days": 30,
     "inactive_days": 90
   }'::jsonb,
   'Níveis do cliente no atendimento: Prata/Ouro a partir de N pedidos pagos OU R$ gastos (líquido); dica de venda de cada nível; dias para "hora da recompra" e "sumido"')
on conflict (key) do nothing;

create table if not exists crm.customer_tags (
  customer_id uuid not null references crm.customers(customer_id) on delete cascade,
  tag text not null check (length(btrim(tag)) between 1 and 40),
  created_by text,
  created_at timestamptz not null default now(),
  primary key (customer_id, tag)
);
alter table crm.customer_tags enable row level security;
revoke all on crm.customer_tags from public, anon, authenticated;
grant select, insert, update, delete on crm.customer_tags to service_role;

alter table crm.wa_chats add column if not exists tags text[] not null default '{}';

-- Level by paid orders / net revenue (Ouro and Prata: either one reaches it).
create or replace function crm.customer_tier(p_orders int, p_revenue numeric) returns text
language sql stable as $$
  select case
    when coalesce(p_orders, 0) <= 0 then 'sem_compra'
    when p_orders >= coalesce((v -> 'ouro' ->> 'orders')::int, 4)
      or coalesce(p_revenue, 0) >= coalesce((v -> 'ouro' ->> 'revenue')::numeric, 900) then 'ouro'
    when p_orders >= coalesce((v -> 'prata' ->> 'orders')::int, 2)
      or coalesce(p_revenue, 0) >= coalesce((v -> 'prata' ->> 'revenue')::numeric, 450) then 'prata'
    else 'bronze' end
  from (select coalesce((select value from crm.settings where key = 'customer_tiers'), '{}'::jsonb) as v) t
$$;

-- What the attendant sees about a contact: level, tip, automatic and manual tags.
create or replace function crm.customer_badges(p_customer uuid, p_chat_tags text[] default '{}') returns jsonb
language plpgsql stable as $$
declare
  c crm.customers;
  cfg jsonb := coalesce((select value from crm.settings where key = 'customer_tiers'), '{}');
  v_tier text;
  v_days int;
  v_last_paid timestamptz;
  v_tags jsonb := '[]';
  v_f record;
  v_rep int := coalesce((cfg ->> 'repurchase_days')::int, 30);
  v_inactive int := coalesce((cfg ->> 'inactive_days')::int, 90);
  tag jsonb;
begin
  if p_customer is not null then select * into c from crm.customers where customer_id = p_customer; end if;
  v_tier := crm.customer_tier(c.total_paid_orders, c.total_net_revenue);
  v_last_paid := c.last_purchase_at;
  v_days := case when v_last_paid is not null then floor(extract(epoch from now() - v_last_paid) / 86400)::int end;

  if c.customer_id is not null then
    -- hot leads: a cart or a payment that did not finish, without a purchase after it
    if exists (select 1 from crm.customer_events e where e.customer_id = c.customer_id
                and e.fact_type = 'CHECKOUT_ABANDONED' and e.occurred_at > now() - interval '7 days'
                and not exists (select 1 from crm.customer_events p where p.customer_id = c.customer_id
                                 and p.fact_type = 'PURCHASE_PAID' and p.occurred_at > e.occurred_at)) then
      v_tags := v_tags || jsonb_build_object('key', 'carrinho', 'label', 'Carrinho abandonado', 'tone', 'warning',
                  'hint', 'Abandonou o carrinho nos últimos 7 dias: pergunte se ficou alguma dúvida e ajude a finalizar.');
    end if;
    if exists (select 1 from crm.customer_events e where e.customer_id = c.customer_id
                and e.fact_type = 'PAYMENT_PENDING' and e.occurred_at > now() - interval '3 days'
                and not exists (select 1 from crm.customer_events p where p.customer_id = c.customer_id
                                 and p.fact_type = 'PURCHASE_PAID' and p.occurred_at > e.occurred_at)) then
      v_tags := v_tags || jsonb_build_object('key', 'pix', 'label', 'Pix/boleto pendente', 'tone', 'warning',
                  'hint', 'Gerou um Pix ou boleto e ainda não pagou: lembre e reenvie o código se precisar.');
    end if;
    if exists (select 1 from crm.customer_events e where e.customer_id = c.customer_id
                and e.fact_type in ('PAYMENT_FAILED','PAYMENT_EXPIRED') and e.occurred_at > now() - interval '7 days'
                and not exists (select 1 from crm.customer_events p where p.customer_id = c.customer_id
                                 and p.fact_type = 'PURCHASE_PAID' and p.occurred_at > e.occurred_at)) then
      v_tags := v_tags || jsonb_build_object('key', 'recusado', 'label', 'Pagamento não concluído', 'tone', 'warning',
                  'hint', 'Pagamento recusado ou Pix expirado nos últimos 7 dias: ofereça outra forma de pagamento.');
    end if;

    -- after the purchase
    select f.status, coalesce(f.delivered_at, f.updated_at) as at into v_f
      from crm.fulfillments f where f.customer_id = c.customer_id
     order by coalesce(f.updated_at, f.created_at) desc limit 1;
    if v_f.status in ('FULFILLMENT_CREATED','SHIPPED','IN_TRANSIT','OUT_FOR_DELIVERY') then
      v_tags := v_tags || jsonb_build_object('key', 'entrega', 'label',
                  case when v_f.status = 'OUT_FOR_DELIVERY' then 'Saiu para entrega' else 'Pedido a caminho' end,
                  'tone', 'info', 'hint', 'Tem pedido a caminho: confira o rastreio antes de responder.');
    elsif v_f.status = 'DELIVERY_FAILED' then
      v_tags := v_tags || jsonb_build_object('key', 'retirada', 'label', 'Aguardando retirada', 'tone', 'warning',
                  'hint', 'A entrega não foi feita: oriente a retirada na agência antes do prazo.');
    elsif v_f.status = 'DELIVERED' and v_f.at > now() - interval '10 days' then
      v_tags := v_tags || jsonb_build_object('key', 'entregue', 'label', 'Recebeu há pouco', 'tone', 'success',
                  'hint', 'Recebeu o pedido nos últimos 10 dias: pergunte se gostou e peça uma avaliação.');
    end if;

    if v_days is not null and v_days >= v_inactive then
      v_tags := v_tags || jsonb_build_object('key', 'sumido', 'label', format('Sem comprar há %s dias', v_days), 'tone', 'danger',
                  'hint', 'Cliente parado: reative com uma condição especial de retorno.');
    elsif v_days is not null and v_days >= v_rep then
      v_tags := v_tags || jsonb_build_object('key', 'recompra', 'label', 'Hora da recompra', 'tone', 'success',
                  'hint', format('Última compra há %s dias: o produto deve estar acabando, ofereça a reposição.', v_days));
    end if;

    if exists (select 1 from crm.subscriptions s where s.customer_id = c.customer_id
                and s.status in ('ACTIVE','TRIAL','REACTIVATED') and s.payment_state not in ('LATE','FAILED')) then
      v_tags := v_tags || jsonb_build_object('key', 'assinante', 'label', 'Assinante', 'tone', 'info',
                  'hint', 'Tem assinatura ativa: cuide da retenção e ofereça complementos.');
    elsif exists (select 1 from crm.subscriptions s where s.customer_id = c.customer_id
                   and s.status not in ('CANCELLED','EXPIRED','INACTIVE') and s.payment_state in ('LATE','FAILED')) then
      v_tags := v_tags || jsonb_build_object('key', 'assinatura_atrasada', 'label', 'Assinatura atrasada', 'tone', 'danger',
                  'hint', 'A cobrança da assinatura falhou: ajude a atualizar o cartão.');
    end if;
    if c.total_refunds > 0 then
      v_tags := v_tags || jsonb_build_object('key', 'reembolso', 'label', 'Já pediu reembolso', 'tone', 'danger',
                  'hint', 'Já teve reembolso: atenção redobrada à satisfação antes de oferecer algo novo.');
    end if;
    if coalesce(c.total_chargeback_amount, 0) > 0 then
      v_tags := v_tags || jsonb_build_object('key', 'chargeback', 'label', 'Chargeback', 'tone', 'danger',
                  'hint', 'Já contestou uma compra no cartão: prefira Pix.');
    end if;
  end if;

  return jsonb_build_object(
    'tier', v_tier,
    'tier_label', coalesce(cfg -> v_tier ->> 'label', initcap(replace(v_tier, '_', ' '))),
    'tip', cfg -> v_tier ->> 'tip',
    'orders', coalesce(c.total_paid_orders, 0),
    'revenue', coalesce(c.total_net_revenue, 0),
    'days_since_purchase', v_days,
    'auto', v_tags,
    'manual', coalesce((select jsonb_agg(t.tag order by t.created_at) from crm.customer_tags t where t.customer_id = c.customer_id), '[]'::jsonb)
              || coalesce(to_jsonb(p_chat_tags), '[]'::jsonb)
  );
end;
$$;

-- the conversation carries the badges; the list carries the level
create or replace function public.crm_wa_chat(p_chat uuid) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select to_jsonb(x) || jsonb_build_object('badges', crm.customer_badges(x.customer_id, x.tags)) from (
    select c.*, cu.full_name as customer_name, cu.email as customer_email,
           cu.current_lifecycle_stage as lifecycle_stage, cu.current_customer_type as customer_type,
           cu.total_net_revenue, cu.total_paid_orders, cu.last_purchase_at,
           i.label as instance_label, i.color as instance_color
      from crm.wa_chats c left join crm.customers cu using (customer_id)
      left join crm.wa_instances i on i.name = c.instance
     where c.chat_id = p_chat
  ) x
$$;

create or replace function public.crm_wa_chats(p_instance text, p_search text default null,
                                               p_filter text default 'all', p_limit int default 200)
returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select coalesce(jsonb_agg(x order by x.last_message_at desc nulls last), '[]') from (
    select c.chat_id, c.instance, c.remote_jid, c.phone, c.name, c.customer_id, cu.full_name as customer_name,
           c.last_message_at, c.last_preview, c.last_from_me, c.last_status, c.unread, c.archived,
           crm.customer_tier(cu.total_paid_orders, cu.total_net_revenue) as tier
      from crm.wa_chats c left join crm.customers cu using (customer_id)
     where c.instance = p_instance
       and (case coalesce(p_filter, 'all') when 'archived' then c.archived when 'unread' then c.unread > 0 and not c.archived
            else not c.archived end)
       and (nullif(btrim(p_search), '') is null
            or coalesce(c.name, '') ilike '%' || btrim(p_search) || '%'
            or coalesce(cu.full_name, '') ilike '%' || btrim(p_search) || '%'
            or coalesce(c.phone, '') like '%' || regexp_replace(btrim(p_search), '\D', '', 'g') || '%'
               and regexp_replace(btrim(p_search), '\D', '', 'g') <> ''
            or exists (select 1 from crm.customer_tags t where t.customer_id = c.customer_id and t.tag ilike btrim(p_search) || '%')
            or exists (select 1 from unnest(c.tags) t where t ilike btrim(p_search) || '%'))
     order by c.last_message_at desc nulls last
     limit least(greatest(p_limit, 1), 500)
  ) x
$$;

-- manual tags: on the customer, or on the chat while the contact is not a customer
create or replace function public.crm_wa_tag(p_chat uuid, p_tag text, p_add boolean, p_actor text default null)
returns void
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  v_customer uuid;
  v_tag text := left(btrim(regexp_replace(coalesce(p_tag, ''), '\s+', ' ', 'g')), 40);
begin
  if v_tag = '' then raise exception 'Tag vazia'; end if;
  select customer_id into v_customer from crm.wa_chats where chat_id = p_chat;
  if not found then raise exception 'Conversa não encontrada'; end if;
  if v_customer is not null then
    if p_add then
      insert into crm.customer_tags (customer_id, tag, created_by) values (v_customer, v_tag, p_actor)
      on conflict do nothing;
    else
      delete from crm.customer_tags where customer_id = v_customer and tag = v_tag;
    end if;
    update crm.wa_chats set tags = array_remove(tags, v_tag) where chat_id = p_chat and not p_add;
  else
    update crm.wa_chats set
      tags = case when p_add then (case when v_tag = any(tags) then tags else tags || v_tag end)
                  else array_remove(tags, v_tag) end,
      updated_at = now()
     where chat_id = p_chat;
  end if;
end;
$$;

-- tags already used (suggestions while typing)
create or replace function public.crm_wa_tag_list() returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select coalesce(jsonb_agg(tag order by n desc, tag), '[]') from (
    select tag, count(*) n from (
      select tag from crm.customer_tags union all select unnest(tags) from crm.wa_chats
    ) x group by tag order by count(*) desc limit 100
  ) y
$$;

create or replace function public.crm_customer_tiers_config() returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select value from crm.settings where key = 'customer_tiers'
$$;

create or replace function public.crm_save_customer_tiers(p_value jsonb, p_actor text default null) returns void
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  if jsonb_typeof(p_value) <> 'object' or not (p_value ? 'prata' and p_value ? 'ouro') then
    raise exception 'Configuração inválida';
  end if;
  update crm.settings set value = p_value, updated_at = now() where key = 'customer_tiers';
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('settings', 'customer_tiers', 'value', null, p_value::text, coalesce(p_actor, 'crm'));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_wa_chat(uuid)', 'crm_wa_chats(text,text,text,int)', 'crm_wa_tag(uuid,text,boolean,text)',
    'crm_wa_tag_list()', 'crm_customer_tiers_config()', 'crm_save_customer_tiers(jsonb,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
