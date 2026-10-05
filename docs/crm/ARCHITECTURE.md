# Kakauma CRM — arquitetura orientada a eventos

```
B4YOU ──► /api/webhooks/b4you ──► crm.events (bruto, imutável, idempotente)
                                      │
                                      ▼
                     normalizador vN (TS, puro, versionado)
                                      │  evento normalizado
                                      ▼
                     crm.process_event (1 transação por evento)
                       ├─ identity resolution ──► customers / customer_identities
                       ├─ catálogo ──────────────► products / offers / coupons / affiliates
                       ├─ atribuição ────────────► attributions
                       ├─ pedidos/cobranças ─────► orders / transactions / financial_events
                       ├─ assinaturas ───────────► subscriptions / subscription_charges
                       ├─ reembolsos ────────────► refunds
                       ├─ logística ─────────────► fulfillments / fulfillment_events
                       ├─ fatos de negócio ──────► customer_events  (alimenta lifecycle/automação)
                       └─ agregados do cliente ──► customers (receita, LTV base, tipo)
                     falha → retry com backoff (cron) → dead_letter_events
```

Filosofia: **EVENTS → FACTS → STATE → CUSTOMER → ACTION → OUTCOME**. Cada webhook é uma evidência;
todo estado é derivado e pode ser reconstruído reprocessando `crm.events`.

## Onde está cada coisa

| Camada                                                            | Arquivo                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Schema (tabelas, imutabilidade, auditoria, segurança)             | `drizzle/migrations/0008_crm_event_store.sql`                                              |
| Motor (ingestão, retries, DLQ, engines, agregados)                | `drizzle/migrations/0009_crm_event_engine.sql`                                             |
| Contrato do evento normalizado                                    | `src/server/crm/types.ts`                                                                  |
| Normalizador B4you v1                                             | `src/server/crm/normalize/b4you.ts`                                                        |
| Remoção de dados de cartão                                        | `src/server/crm/redact.ts`                                                                 |
| Pipeline (webhook → store → normalize → engine)                   | `src/server/crm/pipeline.ts`                                                               |
| Endpoint do webhook                                               | `src/routes/api/webhooks/b4you.ts`                                                         |
| Worker de retry / backfill                                        | `src/routes/api/cron/crm-process.ts`                                                       |
| State engine (lifecycle, risco, qualidade, LTV, CX, Customer 360) | `drizzle/migrations/0010_crm_state_engine.sql`                                             |
| Segmentação + automação                                           | `drizzle/migrations/0011_crm_segments_automations.sql`, `src/server/crm/automation.ts`     |
| Analytics                                                         | `drizzle/migrations/0012_crm_analytics.sql`                                                |
| Acesso (RBAC), auditoria por usuário, funções das telas           | `drizzle/migrations/0013_crm_app_access.sql`                                               |
| Login, sessão por cookie, gateway de RPC                          | `src/server/crm/auth.server.ts`, `gateway.ts`, `src/routes/api/crm/*`                      |
| Telas do CRM                                                      | `src/routes/{crm,customers.*,recovery,segments,automations,insights,operations,login}.tsx` |
| Instalação local                                                  | `docs/crm/LOCAL_SETUP.md`, `scripts/crm-migrate.mjs`, `scripts/crm-create-admin.mjs`       |
| Testes (71)                                                       | `tests/crm/*.test.ts`                                                                      |

O schema `crm` é **privado**: RLS ligado, sem acesso para `anon`/`authenticated`. O app só fala com ele
por funções `public.crm_*` (SECURITY DEFINER) liberadas apenas para `service_role`.

## Regras críticas → onde são garantidas

| #   | Regra                                     | Garantia                                                                    |
| --- | ----------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `subscription_id` identifica a assinatura | PK de `crm.subscriptions`                                                   |
| 2   | `charge_id` identifica a cobrança         | PK de `subscription_charges`, `transactions.transaction_key`                |
| 3   | `sale_id` identifica a venda              | `orders.sale_id` único; nunca usado como assinatura                         |
| 4   | Renovação não cria assinatura             | `apply_paid_charge` cria só nova `subscription_charge` + ciclo              |
| 5   | Refund não apaga compra                   | `apply_refund` grava `refunds` + `financial_events`; pedido só muda status  |
| 6   | Cancelamento ≠ refund                     | handlers separados; teste `refund does not cancel`                          |
| 7   | Late ≠ cancelamento                       | `SUBSCRIPTION_LATE` mexe em `payment_state`/`risk_state`                    |
| 8   | Expiring ≠ cancelamento                   | `SUBSCRIPTION_EXPIRING` mexe só em `lifecycle_state`/`expiring_at`          |
| 9   | Tracking ≠ compra                         | `apply_tracking` só toca `fulfillments`                                     |
| 10  | PIX gerado ≠ pago                         | `PAYMENT_PENDING` nunca marca pago, mesmo com `status=paid`                 |
| 11  | UTM nula em renovação ≠ orgânico          | atribuição `inherited` aponta para a aquisição                              |
| 12  | `original_price` ≠ receita                | receita só de `charges[].amount`; sem valor → dead letter                   |
| 13  | Estado não vem do `event_name`            | status vem de `subscription.status` confirmado e mais recente               |
| 14  | Evento bruto preservado                   | trigger `events_immutable` bloqueia UPDATE de payload e DELETE              |
| 15  | Idempotência                              | `(source, idempotency_key)` no bruto + `dedupe_key` em todo fato financeiro |

Idempotência em duas camadas:

1. **Bruto**: chave = id do evento do provedor, ou `sha256(payload)`. O payload já contém event_name,
   sale_id, subscription_id, charge_id e timestamps, então equivale ao hash da especificação.
2. **Fatos**: `paid:<charge>`, `refund:<id>`… Se a B4you reenviar o mesmo fato com payload diferente
   (ex.: `updated_at` mudou), o bruto é guardado como nova evidência, mas a receita não duplica.
   `approved-payment` e `renewed-subscription` da mesma cobrança contam uma vez.

## Contrato do evento normalizado (v1)

Ver `NormalizedEvent` em `src/server/crm/types.ts`. Campos ausentes são `null` — nunca inventados.
Novos formatos de payload ganham um novo normalizador (`v2`) registrado em `normalize/index.ts`;
eventos antigos continuam reprocessáveis com a versão em que foram gravados.

Tipos internos: `CHECKOUT_ABANDONED`, `PAYMENT_PENDING`, `PAYMENT_APPROVED`, `PAYMENT_FAILED`, `REFUND`,
`CHARGEBACK`, `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_LATE`, `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_EXPIRING`,
`TRACKING`, `AFFILIATION`, `UNKNOWN`. Eventos `UNKNOWN` ficam guardados como `IGNORED` e podem ser
reprocessados quando ganharem handler — sem mudar a arquitetura.

## Operação

1. **Aplicar migrações** 0008 e 0009 no Supabase (via Lovable ou `drizzle-kit migrate`).
2. **Webhook**: apontar a B4you para `https://<app>/api/webhooks/b4you?token=<B4YOU_WEBHOOK_TOKEN>`
   e definir o segredo `B4YOU_WEBHOOK_TOKEN`. Enquanto a B4you ainda postar em `/api/public/events`,
   esse endpoint espelha os webhooks para o CRM (idempotente).
3. **Worker**: agendar `POST /api/cron/crm-process` (Authorization: `Bearer LOVABLE_CRON_SECRET`) a cada
   1–5 min. Ele reprocessa falhas com backoff (1, 2, 4, 8 min; 5 tentativas → dead letter).
4. **Backfill**: `POST /api/cron/crm-process` com `{"backfill": true, "limit": 1000}` copia os payloads
   B4you já guardados no analytics legado (`public.events.metadata.raw_payload`) e os processa em ordem.
5. **Dead letters**: `select * from crm.dead_letter_events where resolved_at is null`. Depois de corrigir
   o normalizador: `select public.crm_requeue_dead_letters('missing_amount')`.
6. **Qualidade de dados**: `select code, count(*) from crm.data_quality_issues group by 1`.

Testes: `scripts/crm-test-db.sh crm_test` (Postgres local) e
`CRM_TEST_DATABASE_URL=postgres://… npm run test:crm`.

## Premissas que dependem de payloads reais

Os formatos dos webhooks foram inferidos do adaptador legado e da especificação. Precisam de
confirmação com payloads reais (anonimizados) de cada evento:

- onde vem o id da cobrança (`charges[].id`?) e se renovações trazem `sale_id` próprio;
- se `splits` é objeto (`fee`, `my_commission`, `released`) ou lista por tipo — os dois são aceitos;
- campos de `tracking` (código, transportadora, URL, custo de frete) e status logísticos;
- campos de `refund` (id, valor parcial, motivo) e se existe evento de chargeback;
- valores possíveis de `subscription.status`;
- se a B4you envia um id único por webhook (melhor chave de idempotência que o hash).

Sem `charge_id`, cobranças são deduplicadas por `sale_id` (ou `assinatura + dia` em renovações) e o caso é
registrado em `crm.data_quality_issues` (`missing_charge_id`).

## Fase 2 — State engine

Tudo é **recalculado a partir dos fatos** depois de cada evento e periodicamente (o worker chama
`crm_refresh_customers`), porque alguns estados dependem só do tempo passar.

**Lifecycle do cliente** (`customers.current_lifecycle_stage`):

- Avulso: `LEAD → PROSPECT → CHECKOUT_STARTED → PURCHASED → DELIVERING → DELIVERED → ACTIVE_CUSTOMER → REPEAT_CUSTOMER`, e `CHURNED` após `churn_after_days` sem comprar.
- Assinante (pela assinatura mais relevante): `NEW_SUBSCRIBER`, `ACTIVE_SUBSCRIBER`, `EXPIRING`, `RENEWED`,
  `LATE`, `RECOVERED`, `CANCELLATION_REQUESTED`, `CANCELLED`, `REACTIVATED`, `CHURNED` (expirada).
- Cada mudança gera um fato `LIFECYCLE_CHANGED` / `RISK_CHANGED` em `customer_events` (gatilho para automações).

**Risco** (assinatura e cliente): `CHURN_RISK` (pediu cancelamento / inativo), `PAYMENT_RISK` (falhou),
`AT_RISK` (atrasado, `DUE`, reembolso ou problema de entrega recente) e `HIGH_VALUE_AT_RISK` quando o
cliente em risco tem LTV líquido ≥ `high_value_net_ltv`. `DUE` é inferido quando a data de cobrança passa
sem pagamento — nunca vira atraso ou cancelamento sem evidência da B4you.

**Subscription Quality Score** (0–100, `subscriptions.quality_score/quality_class/quality_factors`):
base 50, +8 por ciclo pago (até +40), −10 por atraso, −10 por falha, −20 por reembolso, −15 se pediu
cancelamento, +10 se alto valor, −10 por problema de entrega. Classes: `HIGH_QUALITY` (≥70),
`MEDIUM_QUALITY` (≥40), `LOW_QUALITY`, `AT_RISK`, `HIGH_VALUE_AT_RISK`. Os fatores ficam gravados, então
todo score é explicável. Pesos ajustáveis em `crm.settings` (`quality_weights`).

**LTV**: `gross_ltv`, `net_ltv` (− reembolsos − chargebacks) e `contribution_ltv`
(− taxas da plataforma − frete − comissões de afiliado). COGS, impostos e CAC entram quando houver fonte.

**CX** (`crm.customer_experience`): tempo médio de entrega, atrasos, falhas, reembolsos, atrasos de
assinatura, cancelamentos, recompras. `complaints` e `cx_score` ficam `null` até existir fonte.

**Customer 360**: `public.crm_customer_360(customer_id)` devolve identidade, aquisição, compras,
assinaturas (com cobranças por ciclo e score), financeiro, logística, experiência, estado de CRM e a
linha do tempo. Busca: `public.crm_search_customers(texto, lifecycle, risco, tipo)`.

**Configuração** (`crm.settings`): `activity_window_days` (90), `churn_after_days` (180), `recent_days` (30),
`high_value_net_ltv` (500), `due_grace_days` (1), `quality_weights`.

## Fase 4 — Analytics

Calculado sob demanda a partir dos fatos (nada de agregados que desatualizam). Regras:

- **Taxa sem base é `null`**, nunca 0 nem estimativa (ex.: churn sem assinaturas ativas no início do período).
- **Retenção só conta quem teve tempo**: uma assinatura é elegível para o ciclo _n_ quando já passaram
  (n−1) ciclos + carência desde o início. Cohorts jovens não aparecem como churn. Duração do ciclo vem de
  `subscription.frequency` (mensal 30, bimestral 60, trimestral 90…; desconhecida → `default_cycle_days`).
- **Taxa de renovação** = renovações devidas no período (cobrança anterior + ciclo, já fora da carência)
  que foram pagas.
- **CAC só com gasto importado** (`crm.marketing_spend` via `crm_import_marketing_spend`). Sem gasto → `null`.
- Meses de cohort no fuso `report_timezone` (America/Sao_Paulo).

| Função (`public.`)                      | O que responde                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crm_dashboard(from, to)`               | Aquisição (clientes adquiridos, gasto, CAC, conversão, receita de campanha), commerce (pedidos, bruto, reembolsos, líquido, taxas, AOV, refund rate, saldo a liberar), assinatura (ativos, novos, renovações, renewal rate, churn, atraso, recuperação, churn pós-atraso, pedidos de cancelamento, conclusão, save rate, reativação), logística (enviados, em trânsito, entregues, atrasados, falhas, prazo médio, frete) e cliente (LTVs médios, alto valor, em risco, reativados) |
| `crm_funnel(from, to)`                  | Checkout → abandono → pagamento → aprovado → entregue, conversões e conversão por método (PIX, cartão, boleto)                                                                                                                                                                                                                                                                                                                                                                      |
| `crm_cohorts(dim, from, to)`            | Por mês da 1ª compra/assinatura, origem, campanha, criativo, produto, oferta, funil, afiliado, UF, método: clientes, LTV bruto/líquido/contribuição médio, refund, recompra, churn, renovação, retenção C1–C5                                                                                                                                                                                                                                                                       |
| `crm_retention(dim, from, to)`          | Assinaturas C1→C5 (elegíveis, atingiram, taxa) e passos C1→C2… C4→C5                                                                                                                                                                                                                                                                                                                                                                                                                |
| `crm_refund_metrics(dim, from, to)`     | Refund count/rate/receita por produto, oferta, campanha, origem, afiliado, método                                                                                                                                                                                                                                                                                                                                                                                                   |
| `crm_campaign_quality(nível, from, to)` | Por origem/campanha/criativo/funil: cliques, checkouts, compras, receita, reembolsos, clientes adquiridos, LTV líquido e de contribuição médio, assinaturas, renovações, churn, gasto, CAC, LTV/CAC e quadrante `HIGH/LOW_SALES × HIGH/LOW_LTV` (vs. mediana)                                                                                                                                                                                                                       |

Limitações conhecidas: a B4you não envia "checkout iniciado" (início do funil = abandono, PIX/boleto gerado
ou compra); cliques e CAC dependem da importação de gasto; COGS e impostos ainda não entram no LTV.

## Fase 5 — Telas e acesso

- **Projeto Supabase próprio do CRM** (`CRM_SUPABASE_*`), separado do analytics legado. Migrações do CRM
  (0008+) aplicadas por `npm run crm:migrate`.
- **Login**: Supabase Auth (e-mail/senha) feito pelo servidor; tokens em cookies `httpOnly` (o navegador
  nunca vê chaves nem tokens). Acesso exige linha ativa em `crm.app_users` com papel `admin`, `operator` ou
  `viewer` (`npm run crm:create-admin`).
- **Gateway** `/api/crm/rpc`: só funções da lista (`gateway.ts`), com papel mínimo; mutações recebem o e-mail do
  usuário como `p_actor` (definido no servidor), e o log de auditoria registra quem mudou segmentos,
  automações e configurações.
- **Telas**: Painel, Clientes + Customer 360, Recuperação (situações abertas reais), Segmentos (criar com regra
  JSON validada), Automações (ligar/desligar, execuções com a mensagem), Insights (funil, campanhas, cohorts,
  retenção, reembolsos) e Operação (saúde da ingestão, fila de erros, qualidade de dados, importação do
  histórico, investimento em mídia, regras e limites).
- As telas de demonstração (contatos, pipeline, tarefas com dados fictícios) foram removidas.
- O analytics antigo continua no menu como "legado", usando o Supabase antigo.

## Gestão (0014)

- **Editor de automações** (fato → filtro → condições → canal/mensagem com prévia) e **construtor visual de
  regras** com contagem ao vivo (`crm_preview_rule`). Papel **operador** edita segmentos e automações.
- **Administração** (`/admin`, só admin): usuários (convite, papel, ativo; o último admin não pode ser
  rebaixado) e auditoria. Na fila de erros dá para **reprocessar um evento** (`crm_requeue_event`).

## Lucro, CX, LTV e LGPD (0015)

- **Lucro por cliente** = LTV de contribuição − CMV − impostos. CMV vem de `crm.product_costs` (custo por
  produto × quantidade da oferta, ou custo da oferta, que tem prioridade), cadastrado em Operação → Custos e
  impostos; impostos = `tax_rate_pct` × receita líquida. **Enquanto faltar custo de alguma venda paga ou a
  alíquota, o lucro fica `null` ("incompleto")** — nada é estimado. Vendas reembolsadas mantêm o CMV
  (premissa conservadora: a mercadoria normalmente não volta).
- **CX score** (0–100): base 80, + recompras, − atrasos/falhas de entrega, reembolsos, chargebacks, atrasos
  de assinatura e cancelamentos; pesos em `cx_weights`. `profit_ltv` e `cx_score` são campos de regra.
- **Curva de LTV**: receita líquida acumulada por cliente, mês 0–12 desde a 1ª compra; cada mês só conta
  clientes que já viveram aquele mês. **Retenção** agora vai de C1 a C12.
- **Anonimização (LGPD)**, só admin, com motivo obrigatório: apaga dados pessoais do cliente e identidades, e
  substitui campos pessoais **dentro dos payloads brutos** (único caminho que pode alterar `crm.events`,
  via `crm.redact_raw_event`), links de pagamento, rastreio, click ids e mensagens renderizadas. Valores e
  histórico continuam nos relatórios; se a pessoa voltar a comprar, vira um cliente novo.

## Próximas fases (ordem da especificação)

- **Publicar** (Lovable/Vercel/Cloudflare) para receber webhooks em tempo real e agendar o worker.
- **Payloads reais da B4you** para confirmar o normalizador.
- **Canal de mensagens** para as automações (hoje: simulação).
- Pipeline comercial e tarefas manuais (removidos da demo) quando houver necessidade real.
