# Kakauma CRM

CRM da Kakauma construído sobre a base do **Kakauma Analytics** (TanStack Start + React + Tailwind + Supabase).

## Módulos

| Área | Rotas | Dados |
| --- | --- | --- |
| Analytics | `/`, `/funnels`, `/sales`, `/journey`, `/events`, `/api` | Supabase (eventos B4you) |
| CRM | `/crm`, `/contacts`, `/pipeline`, `/recovery`, `/tasks` | **Mock local** (`src/services/crm`) — será ligado ao backend |

Os dados do CRM ficam no `localStorage` do navegador nesta fase. Toda leitura/escrita passa por
`src/services/crm/index.ts`; para ligar o backend basta reimplementar essas funções.
O botão "Restaurar dados de exemplo" em Configurações recria a base de demonstração.

## Desenvolvimento

```sh
bun install   # ou npm i
cp .env.example .env   # preencha com as chaves do Supabase (só para as telas de Analytics)
bun run dev
```
