# Kakauma CRM

CRM da Kakauma construído sobre a base do **Kakauma Analytics** (TanStack Start + React + Tailwind + Supabase).

## Módulos

| Área | Rotas | Dados |
| --- | --- | --- |
| CRM | `/crm`, `/customers`, `/recovery`, `/segments`, `/automations`, `/insights`, `/operations` | Supabase **próprio do CRM** (`CRM_SUPABASE_*`), com login |
| Analytics (legado) | `/`, `/funnels`, `/sales`, `/journey`, `/events`, `/api` | Supabase antigo (`VITE_SUPABASE_*`) |

**Rodar localmente:** `npm install && npm run dev` e abra <http://localhost:8080/crm> — sem configuração, roda em
modo demonstração com dados fictícios. Para dados reais, siga [`docs/crm/LOCAL_SETUP.md`](docs/crm/LOCAL_SETUP.md).

## Backend orientado a eventos

Webhooks da B4you entram em `POST /api/webhooks/b4you`, são guardados intactos em `crm.events`,
deduplicados, normalizados e aplicados ao modelo do CRM (clientes, pedidos, cobranças, assinaturas,
reembolsos, entregas, atribuição). Detalhes, regras e operação: [`docs/crm/ARCHITECTURE.md`](docs/crm/ARCHITECTURE.md).

```sh
scripts/crm-test-db.sh crm_test                                   # Postgres local descartável
CRM_TEST_DATABASE_URL=postgres://user:pass@localhost/crm_test npm run test:crm
```

## Desenvolvimento

```sh
bun install   # ou npm i
cp .env.example .env   # preencha com as chaves do Supabase (só para as telas de Analytics)
bun run dev
```
