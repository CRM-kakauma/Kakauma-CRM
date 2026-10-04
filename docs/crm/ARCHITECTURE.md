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

| Camada | Arquivo |
| --- | --- |
| Schema (tabelas, imutabilidade, auditoria, segurança) | `drizzle/migrations/0008_crm_event_store.sql` |
| Motor (ingestão, retries, DLQ, engines, agregados) | `drizzle/migrations/0009_crm_event_engine.sql` |
| Contrato do evento normalizado | `src/server/crm/types.ts` |
| Normalizador B4you v1 | `src/server/crm/normalize/b4you.ts` |
| Remoção de dados de cartão | `src/server/crm/redact.ts` |
| Pipeline (webhook → store → normalize → engine) | `src/server/crm/pipeline.ts` |
| Endpoint do webhook | `src/routes/api/webhooks/b4you.ts` |
| Worker de retry / backfill | `src/routes/api/cron/crm-process.ts` |
| Testes (33) | `tests/crm/*.test.ts` |

O schema `crm` é **privado**: RLS ligado, sem acesso para `anon`/`authenticated`. O app só fala com ele
por funções `public.crm_*` (SECURITY DEFINER) liberadas apenas para `service_role`.

## Regras críticas → onde são garantidas

| # | Regra | Garantia |
| --- | --- | --- |
| 1 | `subscription_id` identifica a assinatura | PK de `crm.subscriptions` |
| 2 | `charge_id` identifica a cobrança | PK de `subscription_charges`, `transactions.transaction_key` |
| 3 | `sale_id` identifica a venda | `orders.sale_id` único; nunca usado como assinatura |
| 4 | Renovação não cria assinatura | `apply_paid_charge` cria só nova `subscription_charge` + ciclo |
| 5 | Refund não apaga compra | `apply_refund` grava `refunds` + `financial_events`; pedido só muda status |
| 6 | Cancelamento ≠ refund | handlers separados; teste `refund does not cancel` |
| 7 | Late ≠ cancelamento | `SUBSCRIPTION_LATE` mexe em `payment_state`/`risk_state` |
| 8 | Expiring ≠ cancelamento | `SUBSCRIPTION_EXPIRING` mexe só em `lifecycle_state`/`expiring_at` |
| 9 | Tracking ≠ compra | `apply_tracking` só toca `fulfillments` |
| 10 | PIX gerado ≠ pago | `PAYMENT_PENDING` nunca marca pago, mesmo com `status=paid` |
| 11 | UTM nula em renovação ≠ orgânico | atribuição `inherited` aponta para a aquisição |
| 12 | `original_price` ≠ receita | receita só de `charges[].amount`; sem valor → dead letter |
| 13 | Estado não vem do `event_name` | status vem de `subscription.status` confirmado e mais recente |
| 14 | Evento bruto preservado | trigger `events_immutable` bloqueia UPDATE de payload e DELETE |
| 15 | Idempotência | `(source, idempotency_key)` no bruto + `dedupe_key` em todo fato financeiro |

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

## Próximas fases (ordem da especificação)

- **Fase 2 — Customer 360 + State/Lifecycle/Risk**: views do Customer 360, lifecycle do cliente
  (LEAD → … → REPEAT_CUSTOMER), risk engine (HIGH_VALUE_AT_RISK, CHURN_RISK), score de qualidade do
  assinante, CX (tempo e atraso de entrega).
- **Fase 3 — Segmentação + Automação**: segmentos dinâmicos; regras `evento → condições → segmento → ação`
  consumindo `crm.customer_events`; log de execuções.
- **Fase 4 — Analytics**: LTV bruto/líquido/contribuição, cohorts C1→C5, refund rate por
  produto/oferta/campanha/afiliado/método, qualidade de campanha, CAC (requer custo de mídia).
- **Fase 5 — UI**: trocar os dados de demonstração do front (`src/services/crm`) pelos dados reais.
