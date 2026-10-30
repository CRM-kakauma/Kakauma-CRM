# Deploy na Cloudflare (Workers)

O build do projeto já gera um **Cloudflare Worker** (preset `cloudflare-module` do Nitro): `npm run build` cria
`.output/server/wrangler.json` e `.wrangler/deploy/config.json`, então `npx wrangler deploy` publica sem
configuração extra. Na Vercel o mesmo build detecta a Vercel e gera a saída dela — os dois funcionam.

Testado no runtime da Cloudflare (workerd): páginas, login, chamadas do CRM, webhooks (B4you, Pushfy, Resend,
WhatsApp, Evolution), cron e links curtos.

## 0. Plano

Use o **Workers Paid** (US$ 5/mês). No gratuito o Worker tem 10 ms de CPU e 50 chamadas externas por
requisição: o cron, os webhooks e a importação de histórico fazem dezenas de chamadas ao Supabase e quebram.

## 1. Criar o Worker ligado ao GitHub

Cloudflare → **Workers & Pages → Create → Import a repository** → GitHub → `CRM-kakauma/Kakauma-CRM`.

| Campo | Valor |
|---|---|
| Project name | `crm-kakauma-kakauma-crm` (tem que ser este: é o nome que o build gera) |
| Production branch | `claude/amazing-johnson-l94x8l` — a `main` do GitHub só tem o commit inicial do Lovable |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

Se o campo "Comando da build" ficar vazio na criação, a Cloudflare põe `npx wrangler deploy` nele e o build
falha: corrija em **Configurações → Compilações**. A branch de produção também se troca ali.

**Build variables** (o navegador recebe no build): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` e, se
usar, `VITE_SHORT_LINK_BASE`. Recomendado também `NODE_VERSION` = `22`.

## 2. Variáveis do servidor

Worker → **Settings → Variables and Secrets** → copie as da Vercel, todas como **Secret** (o `wrangler deploy`
apaga variáveis de texto que não estão no arquivo de configuração; segredos ficam).

- Supabase do CRM: `CRM_SUPABASE_URL`, `CRM_SUPABASE_ANON_KEY`, `CRM_SUPABASE_SERVICE_ROLE_KEY`,
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
- Segredos: `CRON_SECRET`, `B4YOU_WEBHOOK_TOKEN`
- Pushfy: `PUSHFY_API_TOKEN`, `PUSHFY_LIVE`, `PUSHFY_SMS_FROM`, `PUSHFY_WEBHOOK_TOKEN`
- E-mail: `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_LIVE`, `RESEND_WEBHOOK_SECRET`
- WhatsApp (Evolution): `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`,
  `EVOLUTION_WEBHOOK_TOKEN`, `EVOLUTION_DELAY_MS`, `WHATSAPP_LIVE`
- Links: `CRM_LINK_BASE`, `CRM_LINK_TRACKING` (se usar)
- **Novo:** `CRM_APP_URL` = o endereço do CRM na Cloudflare (ex.:
  `https://crm-kakauma-kakauma-crm.<sua-conta>.workers.dev`). Na Vercel ele vinha sozinho; sem ele os links
  curtos de SMS, RCS e WhatsApp não contam cliques.

Depois de salvar: **Deployments → Retry/Redeploy** (variável nova só vale em um deploy novo).

## 3. Supabase Auth

Supabase do CRM → **Authentication → URL Configuration**: **Site URL** = endereço novo e, em **Redirect URLs**,
`https://<endereço novo>/**` (convites e "esqueci a senha").

## 4. Trocar os endereços nas integrações

| Onde | Novo endereço |
|---|---|
| B4you (webhook) | `https://<novo>/api/webhooks/b4you?token=<B4YOU_WEBHOOK_TOKEN>` |
| Pushfy (status e respostas) | `https://<novo>/api/webhooks/pushfy` (cabeçalho `x-webhook-token`) |
| Resend (Webhooks) | `https://<novo>/api/webhooks/resend` — o segredo `whsec_` muda se criar outro endpoint |
| Evolution | CRM novo → Operação → **Cadastrar webhook na Evolution** |
| cron-job.org | `https://<novo>/api/cron/crm-process`, mesmo cabeçalho `Authorization: Bearer <CRON_SECRET>` |

## 5. Transição

Deixe o projeto da Vercel no ar por algumas semanas: SMS, RCS e WhatsApp já enviados têm links curtos com o
endereço `vercel.app/l/…`, e eles só funcionam enquanto a Vercel existir (os dois usam o mesmo Supabase).
Depois de trocar as integrações, a Vercel não recebe mais nada além desses cliques.

## 6. Domínio próprio (opcional)

Worker → **Settings → Domains & Routes → Add → Custom domain** (ex.: `crm.kakauma.com.br`). Exige o DNS de
`kakauma.com.br` na Cloudflare. Com domínio próprio, uma mudança futura de hospedagem não exige trocar
nenhuma integração. Troque `CRM_APP_URL` para ele.

## 7. Endereço curto sem domínio próprio

O endereço `…workers.dev` é `<nome do Worker>.<subdomínio da conta>.workers.dev`. Para encurtar:

1. **Subdomínio da conta**: Workers & Pages → subdomínio (lado direito) → **Alterar** (ex.: `andorinha`).
   Vale para todos os Workers da conta.
2. **Nome do Worker**: Worker → **Configurações → Geral → Nome** → ex.: `kakauma`. Ao mesmo tempo, em
   **Configurações → Compilações → Variáveis de build**, crie `CF_WORKER_NAME` = o mesmo nome (o build da
   Cloudflare passa a gerar o Worker com ele; sem a variável, o nome vem do repositório).
3. **Implantações → Tentar compilar novamente**. Endereço novo: `https://kakauma.andorinha.workers.dev`.
4. Troque `CRM_APP_URL`, o Supabase (Site URL e Redirect URLs) e as URLs das integrações.

## Conferência

| O quê | Como |
|---|---|
| Site | abrir o endereço novo → tela de login |
| Webhook protegido | `curl -X POST https://<novo>/api/webhooks/b4you -d '{}'` → `401` |
| Cron | `curl -H "Authorization: Bearer <CRON_SECRET>" https://<novo>/api/cron/crm-process` → `{"ok":true,…}` |
| Logs | Worker → **Observability / Logs** |
