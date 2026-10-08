# Publicar o Kakauma CRM na Vercel

Objetivo: ter um endereço público (`https://<seu-projeto>.vercel.app`) para a B4you mandar os webhooks em
tempo real. Leva uns 20 minutos. O projeto já está pronto para a Vercel (`vercel.json` no repositório).

> O Lovable continua funcionando como antes: a Vercel é um segundo lugar onde o mesmo código roda.

## Antes: o Supabase do CRM

Se ainda não fez, siga os passos 1 a 5 de [LOCAL_SETUP.md](LOCAL_SETUP.md) no seu computador:

1. criar o projeto Supabase do CRM (região **São Paulo**);
2. pegar as chaves;
3. colocar no `.env` local;
4. `npm run crm:migrate` (cria as tabelas no Supabase);
5. `npm run crm:create-admin -- seu@email.com.br "uma-senha-forte-com-10+"` (cria o seu login).

Na Vercel o **login é obrigatório** (o "sem login" só existe rodando no seu computador).

## 1. Gerar dois segredos

São senhas longas que só o servidor conhece. Gere duas (no terminal):

```bash
openssl rand -hex 24   # use como B4YOU_WEBHOOK_TOKEN
openssl rand -hex 24   # use como CRON_SECRET
```

## 2. Importar o projeto na Vercel

1. <https://vercel.com/new> → **Import Git Repository** → `CRM-kakauma/Kakauma-CRM`.
2. **Framework Preset**: deixe como está (o `vercel.json` define instalação e build).
3. **Root Directory**: `./`.
4. Em **Environment Variables**, adicione (Production e Preview):

| Nome | Valor |
|---|---|
| `CRM_SUPABASE_URL` | Project URL do Supabase do CRM |
| `CRM_SUPABASE_ANON_KEY` | chave anon / publishable |
| `CRM_SUPABASE_SERVICE_ROLE_KEY` | chave service_role / secret (**só aqui, nunca no código**) |
| `B4YOU_WEBHOOK_TOKEN` | o 1º segredo |
| `CRON_SECRET` | o 2º segredo |

Opcional, só se quiser as telas do analytics antigo também na Vercel: `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
(do projeto antigo). Sem elas, o menu "Analytics (legado)" some e `/` abre o Painel do CRM.

5. **Deploy**. Depois de pronto, abra o endereço e entre com o e-mail e senha criados no passo 5 acima.

6. **Branch**: em *Settings → Git → Production Branch*, escolha a branch que deve ir para produção
   (hoje o CRM está em `claude/amazing-johnson-l94x8l`; quando fizer o merge, troque para `main`).

7. **Região** (recomendado): *Settings → Functions → Function Region* = **São Paulo (gru1)**, a mesma
   região do Supabase — cada tela faz várias consultas ao banco e a distância soma.

## 2b. Ligar os e-mails de convite do Supabase ao CRM

Para convidar pessoas pelo Supabase (*Authentication → Users → Add user → Send invitation*) ou mandar
"troca de senha", o link do e-mail precisa abrir o CRM:

1. Supabase → **Authentication → URL Configuration**.
2. **Site URL**: `https://<seu-projeto>.vercel.app` (troque o `http://localhost:3000` que vem por padrão).
3. **Redirect URLs** → *Add URL*: `https://<seu-projeto>.vercel.app/**`.

Quem recebe o convite abre o link, cai na página **Definir senha** do CRM, cria a senha e entra. Se ainda não
tiver acesso liberado, a página avisa; o administrador libera em **Administração** (ou com
`select public.crm_grant_access(id, email, 'admin') from auth.users where lower(email) = lower('…');` no
SQL Editor) e a pessoa entra pela tela de login.

## 3. Apontar a B4you para o CRM

Na B4you, cadastre o webhook (todos os eventos) com esta URL:

```
https://<seu-projeto>.vercel.app/api/webhooks/b4you?token=<B4YOU_WEBHOOK_TOKEN>
```

Teste: faça uma ação de teste na B4you (ou espere a próxima venda) e veja em **Operação → Eventos por status**
o contador "Processados" subir. Sem o token certo a resposta é `401`; sem o token configurado na Vercel, `503`.

Se a B4you ainda manda para o endereço antigo do Lovable (`/api/events`), pode deixar os dois cadastrados
durante a transição: o CRM ignora repetições (o mesmo evento é guardado uma vez só).

## 4. Trazer o histórico

Se tiver vendas antigas no analytics do Lovable: no seu computador (com o `.env` apontando para os dois
Supabase), rode o app e use **Operação → Importar histórico**. Isso grava os webhooks antigos no Supabase do
CRM; a Vercel passa a mostrá-los na hora.

## 5. Tarefas agendadas (worker)

O endereço `/api/cron/crm-process` refaz eventos com erro, atualiza estados que mudam com o tempo (assinatura
vencendo, cliente sumido), avança os fluxos (esperas) e entrega mensagens.

- O `vercel.json` já agenda **uma vez por dia** (limite do plano gratuito da Vercel).
- Para os fluxos andarem no horário certo, rode **a cada 5 minutos**. Duas opções:
  - **Plano Pro da Vercel**: troque `"schedule"` no `vercel.json` para `"*/5 * * * *"`.
  - **Grátis**: em <https://cron-job.org>, crie um job a cada 5 minutos para
    `https://<seu-projeto>.vercel.app/api/cron/crm-process`, com o cabeçalho
    `Authorization: Bearer <CRON_SECRET>`.

## 6. SMS e RCS pela Pushfy

1. No portal da Pushfy: **API & Integrações → API & Tokens → + Novo token** (nome `Kakauma CRM`). Use um
   token adicional — o token principal não pode ser bloqueado se vazar.
2. Na Vercel, adicione `PUSHFY_API_TOKEN` (o token novo) e, se quiser, `PUSHFY_SMS_FROM` (nome do remetente).
   **Ainda não** coloque `PUSHFY_LIVE`. Redeploy.
3. No CRM: **Operação → Canais de envio** mostra "conectado · envio real desligado" e o saldo. Em
   **Mensagens**, abra um SMS salvo → **Enviar teste de verdade** para o seu celular.
4. Funcionou? Adicione `PUSHFY_LIVE` = `true` e faça Redeploy. A partir daí os fluxos **publicados** enviam
   SMS e RCS de texto de verdade.

Descadastros: quem responde PARAR/SAIR é bloqueado pela própria Pushfy e o worker traz essa lista para o CRM
(botão "Sincronizar descadastros" em Operação traz tudo de uma vez). RCS com cartão/carrossel e WhatsApp
continuam em simulação até a documentação desses formatos.

## Conferência rápida

| O quê | Como |
|---|---|
| Site no ar | abrir `https://<seu-projeto>.vercel.app` → tela de login |
| Webhook protegido | `curl -X POST https://<seu-projeto>.vercel.app/api/webhooks/b4you -d '{}'` → `401` |
| Worker | `curl -H "Authorization: Bearer <CRON_SECRET>" https://<seu-projeto>.vercel.app/api/cron/crm-process` → `{"ok":true,…}` |
| Eventos chegando | Operação → Eventos por status |

## Problemas comuns

- **"Configuração do CRM incompleta"**: falta alguma variável `CRM_SUPABASE_*` na Vercel (depois de
  adicionar, faça *Redeploy*).
- **Login não entra**: o usuário precisa existir no Supabase do CRM e ter acesso (`npm run crm:create-admin`).
- **Tabelas não existem**: rode `npm run crm:migrate` com o `CRM_DATABASE_URL` do projeto certo.
- **Mudou variável e nada mudou**: variáveis só valem depois de um novo deploy.
- **Deploy com "Error" em 1–2 segundos** (sem log de build): no plano **Hobby** com repositório privado, a
  Vercel só publica commits cujo **autor** é o dono da conta (o e-mail ligado ao GitHub da Vercel). Commits
  com outro autor são bloqueados antes do build. Saídas: commits com o autor da conta, um *Deploy Hook*
  (Settings → Git → Deploy Hooks) ou o plano Pro.
