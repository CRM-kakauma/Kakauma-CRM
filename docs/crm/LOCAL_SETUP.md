# Rodar o Kakauma CRM no seu computador

## Jeito rápido: modo demonstração (dados fictícios)

Sem configurar nada:

```bash
git pull origin claude/amazing-johnson-l94x8l
npm install
npm run dev
```

Abra <http://localhost:8080/crm>. Sem o Supabase do CRM no `.env`, o app roda num banco em memória com
**webhooks fictícios** (~140 clientes, compras, assinaturas, entregas, reembolsos, campanhas e gasto de mídia),
processados pelo motor real — todas as telas funcionam. A faixa "Dados fictícios · demonstração" fica no
topo. A primeira carga leva ~15 s; os dados são recriados a cada vez que o servidor sobe.

Quando quiser usar seus **dados reais**, siga os passos abaixo.

Leva uns 15 minutos. Você vai: criar um projeto Supabase só para o CRM, colocar as chaves no `.env`,
criar as tabelas e importar o histórico de webhooks que o analytics antigo já guardou.

## 1. Criar o projeto Supabase do CRM

1. Entre em <https://supabase.com/dashboard> → **New project**.
2. Nome: `kakauma-crm`. Região: **South America (São Paulo)**. Defina uma **senha do banco** e guarde-a.
3. Espere o projeto ficar pronto (~2 min).

## 2. Pegar as chaves

No projeto novo:

- **Project Settings → API** (ou _API Keys_):
  - `Project URL` → `CRM_SUPABASE_URL`
  - `anon` / _publishable_ key → `CRM_SUPABASE_ANON_KEY`
  - `service_role` / _secret_ key → `CRM_SUPABASE_SERVICE_ROLE_KEY` (**nunca compartilhe nem commite**)
- Botão **Connect** (topo da página) → **Session pooler** → copie a URI e troque `[YOUR-PASSWORD]` pela senha
  do banco → `CRM_DATABASE_URL`

## 3. Colocar no `.env`

Abra o arquivo `.env` na pasta do projeto (o mesmo que já tem as chaves do analytics antigo — **mantenha as
linhas `VITE_SUPABASE_*`**, elas são usadas para importar o histórico) e adicione no final:

```env
CRM_SUPABASE_URL=https://xxxxxxxx.supabase.co
CRM_SUPABASE_ANON_KEY=eyJ...            # ou sb_publishable_...
CRM_SUPABASE_SERVICE_ROLE_KEY=eyJ...    # ou sb_secret_...
CRM_DATABASE_URL=postgresql://postgres.xxxxxxxx:SUA_SENHA@aws-0-sa-east-1.pooler.supabase.com:5432/postgres
```

O `.env` está no `.gitignore` — ele não vai para o GitHub.

## 4. Atualizar o código e instalar

```bash
cd ~/Downloads/kakauma-analytics
git pull origin claude/amazing-johnson-l94x8l
npm install
```

## 5. Criar as tabelas do CRM

```bash
npm run crm:migrate
```

Deve listar `aplicando 0008… ok` até `0013… ok`. Pode rodar de novo quando quiser: só aplica o que falta.

## 6. Subir

```bash
npm run dev
```

Abra <http://localhost:8080/crm>. **Rodando local, o CRM abre direto, sem login** (o rodapé do menu mostra
"Modo local, sem login"). Não digite nada no Terminal enquanto o servidor estiver rodando; use outra aba
com **Cmd+T**.

## 7. (Opcional) Ligar o login

Quando quiser login também no local:

```bash
npm run crm:create-admin -- seu-email@kakauma.com.br "uma-senha-forte-com-10+"
```

e adicione `CRM_REQUIRE_LOGIN=true` no `.env`. Em produção (app publicado) o login é **sempre** obrigatório,
independentemente dessa variável.

## 8. Trazer os dados reais

Em **Operação → Importar histórico do analytics antigo → Importar**. Ele lê os webhooks da B4you que o
analytics antigo já recebeu e processa tudo no CRM (clientes, pedidos, assinaturas, entregas…). Pode
clicar de novo depois: nada duplica, e eventos antigos não disparam automações.

Se algum evento cair na **Fila de erros**, me mande a mensagem de erro que aparece ali — normalmente é
um formato de payload da B4you que o normalizador ainda não conhece.

## Opcional

- **Worker** (retentativas, estados que mudam com o tempo, automações): coloque
  `LOVABLE_CRON_SECRET=um-segredo-qualquer` no `.env`, reinicie o `npm run dev` e, em outra aba, rode
  `curl -X POST http://localhost:8080/api/cron/crm-process -H "authorization: Bearer um-segredo-qualquer"`.
  Em produção isso vira um agendamento a cada poucos minutos.
- **Investimento em mídia** (para CAC): Operação → colar CSV `date,source,campaign,creative,spend,clicks,impressions`.

## Problemas comuns

| Sintoma                                          | Causa                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| "Configuração do CRM incompleta no .env"         | falta alguma das 3 variáveis `CRM_SUPABASE_*`                          |
| `crm:migrate` → `password authentication failed` | senha errada na `CRM_DATABASE_URL`                                     |
| `crm:migrate` → `ENOTFOUND`/timeout              | use a URI do **Session pooler**, não a "Direct connection"             |
| Login → "não tem acesso ao CRM"                  | rode o passo 6 com o mesmo e-mail                                      |
| Importar → `legacy_not_configured`               | faltam `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` no `.env` |
| `node: bad option: --env-file`                   | Node antigo; instale o Node 20.6+ (`brew install node`)                |

## Localhost × produção

Em localhost a B4you não consegue mandar webhooks para o seu computador — por isso o caminho é importar
o histórico. Para receber eventos em tempo real é preciso publicar o app (Lovable/Vercel/Cloudflare) e
apontar o webhook da B4you para `https://<seu-domínio>/api/webhooks/b4you?token=<B4YOU_WEBHOOK_TOKEN>`.
