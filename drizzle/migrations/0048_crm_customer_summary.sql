-- =====================================================================
-- KAKAUMA CRM — what the attendant sees about a customer (replaces the
-- Bronze / Prata / Ouro levels of 0047)
--
--   Summary: total spent, paid orders, pots bought, average ticket, first and
--   last purchase (and what), days since the last purchase.
--   Temperature: Quente / Morno / Frio, from the last purchase and the recent
--   buying signals (abandoned cart, Pix/boleto generated, payment refused);
--   the days and the tip of each one are in crm.settings
--   'customer_temperature' (editable by the admin).
--   History: everything the customer did, newest first.
-- =====================================================================

insert into crm.settings (key, value, description) values
  ('customer_temperature', '{
     "hot_purchase_days": 30, "warm_purchase_days": 90,
     "hot_signal_days": 7, "warm_signal_days": 30,
     "quente": {"label": "Quente", "tip": "Momento de fechar: responda rápido, tire a última dúvida e mande o link de compra."},
     "morno": {"label": "Morno", "tip": "Já conhece a marca: lembre dos benefícios e ofereça a reposição ou um kit maior."},
     "frio": {"label": "Frio", "tip": "Está parado: puxe conversa, entenda o motivo e reative com uma condição especial."}
   }'::jsonb,
   'Temperatura do cliente no atendimento: dias desde a última compra (quente/morno) e dias de sinais de compra (carrinho, Pix, recusa); dica de cada temperatura')
on conflict (key) do nothing;

drop function if exists public.crm_customer_tiers_config();
drop function if exists public.crm_save_customer_tiers(jsonb, text);
delete from crm.settings where key = 'customer_tiers';

-- Pots of an order: the number in the offer name ("Kit 3 potes", "2 un", "Leve 5 frascos"),
-- else the units of the offer, else 1; times the units bought when they differ from the offer's.
create or replace function crm.order_pots(p_offer_name text, p_product_name text, p_offer_qty numeric, p_order_qty numeric)
returns numeric
language sql immutable as $$
  select coalesce(
           (regexp_match(lower(coalesce(p_offer_name, '') || ' ' || coalesce(p_product_name, '')),
                         '(\d+)\s*(potes?|un\b|unid|unidades?|frascos?|caixas?|latas?)'))[1]::numeric,
           nullif(p_offer_qty, 0),
           1)
       * case when coalesce(p_order_qty, 0) > 0 and p_order_qty is distinct from p_offer_qty then p_order_qty else 1 end
$$;

create or replace function crm.days_ago_text(p_at timestamptz) returns text
language sql stable as $$
  select case floor(extract(epoch from now() - p_at) / 86400)::int
    when 0 then 'hoje' when 1 then 'ontem'
    else format('há %s dias', floor(extract(epoch from now() - p_at) / 86400)::int) end
$$;

-- Last buying signal (cart, Pix/boleto, refused payment) without a purchase after it.
create or replace function crm.last_buying_signal(p_customer uuid) returns timestamptz
language sql stable as $$
  select max(e.occurred_at) from crm.customer_events e
   where e.customer_id = p_customer
     and e.fact_type in ('CHECKOUT_ABANDONED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_EXPIRED')
     and e.occurred_at > now() - interval '120 days'
     and not exists (select 1 from crm.customer_events p where p.customer_id = p_customer
                      and p.fact_type = 'PURCHASE_PAID' and p.occurred_at > e.occurred_at)
$$;

create or replace function crm.customer_temperature(p_last_purchase timestamptz, p_signal timestamptz)
returns text
language sql stable as $$
  select case
    when p_last_purchase > now() - make_interval(days => coalesce((v ->> 'hot_purchase_days')::int, 30))
      or p_signal > now() - make_interval(days => coalesce((v ->> 'hot_signal_days')::int, 7)) then 'quente'
    when p_last_purchase > now() - make_interval(days => coalesce((v ->> 'warm_purchase_days')::int, 90))
      or p_signal > now() - make_interval(days => coalesce((v ->> 'warm_signal_days')::int, 30)) then 'morno'
    else 'frio' end
  from (select coalesce((select value from crm.settings where key = 'customer_temperature'), '{}'::jsonb) as v) t
$$;

create or replace function crm.customer_summary(p_customer uuid) returns jsonb
language sql stable as $$
  with o as (
    select o.*, crm.order_pots(o.offer_name, o.product_name, f.quantity, o.quantity) as pots
      from crm.orders o left join crm.offers f using (offer_id)
     where o.customer_id = p_customer and o.status in ('PAID','PARTIALLY_REFUNDED') and o.paid_at is not null
  ), last as (select * from o order by paid_at desc limit 1)
  select jsonb_build_object(
    'orders', (select count(*) from o),
    'pots', (select coalesce(sum(pots), 0) from o),
    'spent', coalesce((select total_net_revenue from crm.customers where customer_id = p_customer), 0),
    'gross', (select coalesce(sum(gross_amount), 0) from o),
    'avg_ticket', (select round(avg(gross_amount), 2) from o),
    'first_purchase_at', (select min(paid_at) from o),
    'last_purchase_at', (select paid_at from last),
    'last_product', (select coalesce(offer_name, product_name) from last),
    'last_pots', (select pots from last),
    'days_since_purchase', (select floor(extract(epoch from now() - paid_at) / 86400)::int from last),
    'refunds', coalesce((select total_refunds from crm.customers where customer_id = p_customer), 0),
    'products', (select coalesce(jsonb_agg(x order by x.n desc), '[]') from (
                   select coalesce(product_name, offer_name, 'Produto') as name, sum(pots) as pots, count(*) as n
                     from o group by 1) x)
  )
$$;

-- badges: summary + temperature + automatic and manual tags (no more levels)
create or replace function crm.customer_badges(p_customer uuid, p_chat_tags text[] default '{}') returns jsonb
language plpgsql stable as $$
declare
  c crm.customers;
  cfg jsonb := coalesce((select value from crm.settings where key = 'customer_temperature'), '{}');
  v_sum jsonb := '{}';
  v_signal timestamptz;
  v_temp text;
  v_reason text;
  v_tags jsonb := '[]';
  v_f record;
  v_days int;
begin
  if p_customer is not null then
    select * into c from crm.customers where customer_id = p_customer;
    v_sum := crm.customer_summary(p_customer);
    v_signal := crm.last_buying_signal(p_customer);
  end if;
  v_temp := crm.customer_temperature((v_sum ->> 'last_purchase_at')::timestamptz, v_signal);
  v_days := (v_sum ->> 'days_since_purchase')::int;
  v_reason := case
    when v_signal is not null and v_signal > coalesce((v_sum ->> 'last_purchase_at')::timestamptz, '-infinity')
         and v_signal > now() - make_interval(days => coalesce((cfg ->> 'warm_signal_days')::int, 30))
      then format('Tentou comprar %s e não finalizou', crm.days_ago_text(v_signal))
    when v_days is not null then format('Última compra %s', crm.days_ago_text((v_sum ->> 'last_purchase_at')::timestamptz))
    else 'Nunca comprou' end;

  if c.customer_id is not null then
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
                  'hint', 'Já teve reembolso: atenção à satisfação antes de oferecer algo novo.');
    end if;
    if coalesce(c.total_chargeback_amount, 0) > 0 then
      v_tags := v_tags || jsonb_build_object('key', 'chargeback', 'label', 'Chargeback', 'tone', 'danger',
                  'hint', 'Já contestou uma compra no cartão: prefira Pix.');
    end if;
  end if;

  return jsonb_build_object(
    'temperature', v_temp,
    'temperature_label', coalesce(cfg -> v_temp ->> 'label', initcap(v_temp)),
    'temperature_reason', v_reason,
    'tip', cfg -> v_temp ->> 'tip',
    'summary', v_sum,
    'auto', v_tags,
    'manual', coalesce((select jsonb_agg(t.tag order by t.created_at) from crm.customer_tags t where t.customer_id = c.customer_id), '[]'::jsonb)
              || coalesce(to_jsonb(p_chat_tags), '[]'::jsonb)
  );
end;
$$;

drop function if exists crm.customer_tier(int, numeric);

create or replace function public.crm_wa_chats(p_instance text, p_search text default null,
                                               p_filter text default 'all', p_limit int default 200)
returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select coalesce(jsonb_agg(x order by x.last_message_at desc nulls last), '[]') from (
    select c.chat_id, c.instance, c.remote_jid, c.phone, c.name, c.customer_id, cu.full_name as customer_name,
           c.last_message_at, c.last_preview, c.last_from_me, c.last_status, c.unread, c.archived,
           crm.customer_temperature(
             (select max(o.paid_at) from crm.orders o
               where o.customer_id = cu.customer_id and o.status in ('PAID','PARTIALLY_REFUNDED')),
             case when cu.customer_id is not null then crm.last_buying_signal(cu.customer_id) end) as temperature
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

-- Everything the customer did, newest first: purchases (what, pots, value), carts, Pix,
-- refused payments, refunds, deliveries, subscription changes.
create or replace function public.crm_wa_history(p_chat uuid, p_limit int default 60) returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  with cu as (select customer_id from crm.wa_chats where chat_id = p_chat and customer_id is not null),
  ev as (
    select e.occurred_at as at, e.fact_type as kind, e.sale_id,
           o.offer_name, o.product_name, o.gross_amount, o.status as order_status, o.payment_method,
           case when e.fact_type = 'PURCHASE_PAID' then crm.order_pots(o.offer_name, o.product_name, f.quantity, o.quantity) end as pots,
           e.data
      from crm.customer_events e join cu using (customer_id)
      left join crm.orders o on o.sale_id = e.sale_id
      left join crm.offers f on f.offer_id = o.offer_id
     where e.fact_type in ('PURCHASE_PAID','RENEWAL_PAID','CHECKOUT_ABANDONED','PAYMENT_PENDING','PAYMENT_FAILED',
                           'PAYMENT_EXPIRED','REFUND_ISSUED','CHARGEBACK_RECEIVED','FULFILLMENT_SHIPPED',
                           'FULFILLMENT_IN_TRANSIT','FULFILLMENT_OUT_FOR_DELIVERY','FULFILLMENT_DELIVERED',
                           'FULFILLMENT_DELIVERY_FAILED','FULFILLMENT_DELIVERY_RETURNED','SUBSCRIPTION_CREATED',
                           'SUBSCRIPTION_RENEWED','SUBSCRIPTION_PAYMENT_LATE','SUBSCRIPTION_CANCELLATION_REQUESTED',
                           'SUBSCRIPTION_CANCELLED')
     order by e.occurred_at desc
     limit least(greatest(p_limit, 1), 200)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'at', at, 'kind', kind, 'product', coalesce(offer_name, product_name),
           'amount', gross_amount, 'pots', pots, 'order_status', order_status, 'payment_method', payment_method,
           'carrier', data ->> 'carrier', 'tracking_code', data ->> 'tracking_code')
         order by at desc), '[]')
    from ev
$$;

create or replace function public.crm_customer_temperature_config() returns jsonb
language sql stable security definer set search_path = crm, public, extensions as $$
  select value from crm.settings where key = 'customer_temperature'
$$;

create or replace function public.crm_save_customer_temperature(p_value jsonb, p_actor text default null) returns void
language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  if jsonb_typeof(p_value) <> 'object' or not (p_value ? 'quente' and p_value ? 'morno' and p_value ? 'frio') then
    raise exception 'Configuração inválida';
  end if;
  update crm.settings set value = p_value, updated_at = now() where key = 'customer_temperature';
  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('settings', 'customer_temperature', 'value', null, p_value::text, coalesce(p_actor, 'crm'));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'crm_wa_chats(text,text,text,int)', 'crm_wa_history(uuid,int)',
    'crm_customer_temperature_config()', 'crm_save_customer_temperature(jsonb,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
