/**
 * Help center content (pt-BR). Each screen links here through PageHeader's
 * "Como funciona?". Text supports **bold**; blocks are rendered by /help/$slug.
 */

export type HelpBlock =
  | string
  | { list: string[] }
  | { steps: string[] }
  | { tip: string }
  | { warn: string }
  | { table: string[][]; head: string[] }
  | { links: { to: string; label: string }[] };

export interface HelpArticle {
  slug: string;
  title: string;
  summary: string;
  category: "Comece aqui" | "Relacionamento" | "Dados e análises" | "Administração";
  screen?: { to: string; label: string };
  sections: { heading?: string; blocks: HelpBlock[] }[];
}

export const HELP: HelpArticle[] = [
  {
    slug: "como-funciona",
    title: "Como o CRM funciona",
    summary: "Do evento da B4you até a mensagem para o cliente: o caminho dos dados em 5 passos.",
    category: "Comece aqui",
    sections: [
      {
        blocks: [
          "O CRM é **orientado a eventos**: tudo começa com algo que aconteceu de verdade — uma compra, um PIX gerado, uma renovação, uma entrega. Nada é digitado à mão nem estimado.",
        ],
      },
      {
        heading: "O caminho",
        blocks: [
          {
            steps: [
              "**Evento chega** — a B4you avisa o CRM (webhook). O evento original fica guardado para sempre, sem alteração, e repetições são ignoradas (idempotência).",
              "**Vira fatos** — o evento é traduzido em pedido, transação, assinatura, entrega e em um **fato** do cliente (ex.: “Compra aprovada”, “Pagamento atrasado”).",
              "**Cliente é atualizado** — LTV, etapa do ciclo de vida, risco, qualidade da assinatura, CX score e segmentos são recalculados.",
              "**Ações** — fatos disparam **fluxos** (jornadas com várias etapas) e **automações simples** (uma mensagem). As condições são conferidas na hora, com o estado atual do cliente.",
              "**Análise** — painel, insights e Cliente 360 mostram o resultado: receita, retenção, recuperação, lucro e o efeito das ações.",
            ],
          },
          {
            tip: "Enquanto nenhum canal de envio estiver conectado, as mensagens ficam como **Simulação**: o texto final aparece no CRM, mas nada é enviado.",
          },
        ],
      },
      {
        heading: "Onde ir para…",
        blocks: [
          {
            table: [
              ["Ver um cliente por completo", "Clientes → abrir o cliente (Cliente 360)"],
              ["Agir em quem precisa agora", "Recuperação"],
              ["Agrupar clientes por regra", "Segmentos"],
              ["Montar uma jornada com várias mensagens", "Fluxos"],
              ["Escrever e-mail, SMS, WhatsApp ou RCS", "Mensagens"],
              ["Entender o resultado do negócio", "Painel e Insights"],
              ["Ver se os dados estão chegando bem", "Operação"],
            ],
            head: ["Quero…", "Tela"],
          },
        ],
      },
    ],
  },
  {
    slug: "fluxos",
    title: "Fluxos (jornadas)",
    summary:
      "Monte jornadas com envio, espera, condição, teste A/B e meta — e simule antes de publicar.",
    category: "Relacionamento",
    screen: { to: "/flows", label: "Abrir Fluxos" },
    sections: [
      {
        blocks: [
          "Um fluxo é uma **jornada automática**: um fato coloca o cliente no fluxo e ele percorre as etapas — recebe mensagens, espera, é dividido por regras — até o fim ou até atingir a **meta**.",
          "Exemplo: “Pagamento atrasado” → WhatsApp → espera o pagamento por 2 dias → se não pagou e é cliente de alto valor, alerta a equipe; senão, manda um SMS. Meta: “Pagamento recuperado”.",
        ],
      },
      {
        heading: "As etapas",
        blocks: [
          {
            table: [
              ["Início", "O gatilho (fato), quem pode entrar (regra) e a meta. Há sempre um."],
              [
                "Enviar mensagem",
                "Envia um modelo de Mensagens (e-mail, SMS, WhatsApp, RCS) com os dados do cliente.",
              ],
              ["Esperar", "Pausa por minutos, horas ou dias."],
              [
                "Aguardar evento",
                "Espera o cliente fazer algo até um prazo. Duas saídas: “Aconteceu” e “Não aconteceu”.",
              ],
              ["Condição", "Regra sobre o cliente agora (ex.: LTV ≥ 500). Saídas “Sim” e “Não”."],
              [
                "Teste A/B",
                "Sorteia o caminho pelas porcentagens (2 a 4). Sorteio fixo por cliente.",
              ],
              ["Alertar equipe", "Cria um alerta interno (ex.: ligar para um VIP)."],
              ["Sair do fluxo", "Encerra ali. Caminho sem próxima etapa também termina."],
            ],
            head: ["Etapa", "O que faz"],
          },
        ],
      },
      {
        heading: "Montando",
        blocks: [
          {
            steps: [
              "Em **Fluxos → Novo fluxo**, dê um nome e clique em **Início** para escolher o gatilho.",
              "Use o **+** entre as etapas para inserir. Clique numa etapa para configurar no painel à direita.",
              "Etapas com problema ficam com borda vermelha; a lista abaixo do desenho diz o que falta.",
              "Clique em **Simular**, escolha um cliente real e veja o caminho, os tempos e as mensagens prontas. Marque “E se o cliente…” para testar as saídas de “Aguardar evento”.",
              "**Salvar rascunho** guarda sem ligar. **Publicar** liga o fluxo.",
            ],
          },
        ],
      },
      {
        heading: "Regras importantes",
        blocks: [
          {
            list: [
              "**Um cliente por vez**: quem já está no fluxo não entra de novo até sair. Em “Só uma vez na vida”, nunca mais entra.",
              "**Versões**: editar um fluxo publicado não muda nada até você publicar de novo. Quem já estava dentro termina na versão em que entrou.",
              "**Pausar** congela: ninguém entra e ninguém avança. **Arquivar** tira todo mundo do fluxo.",
              "**Fatos antigos não disparam** (padrão: 72 h), para importações de histórico não mandarem mensagens.",
              "**Meta**: ao acontecer, o cliente sai como “meta atingida” e não recebe as próximas mensagens. A taxa de meta aparece no resumo do fluxo.",
              "Mensagens de marketing respeitam **descadastro**, **horário de envio** (8h–21h, ajustável) e o **limite diário** por cliente.",
            ],
          },
          {
            tip: "Para medir o efeito real, use um Teste A/B com um caminho vazio (grupo de controle). Com uma meta definida, o rótulo de cada caminho no desenho mostra quantos passaram e a % que atingiu a meta.",
          },
        ],
      },
      {
        heading: "Fluxos × automações simples",
        blocks: [
          "**Automações simples** (menu “Automações simples”) mandam **uma** mensagem quando um fato acontece. **Fluxos** fazem jornadas com várias etapas, esperas, condições, testes e meta. Para coisas novas, prefira fluxos.",
        ],
      },
    ],
  },
  {
    slug: "mensagens",
    title: "Mensagens: e-mail, SMS, WhatsApp e RCS",
    summary:
      "Como criar modelos, usar variáveis, entender limites de cada canal e o que o simulador mostra.",
    category: "Relacionamento",
    screen: { to: "/messages", label: "Abrir Mensagens" },
    sections: [
      {
        blocks: [
          "Uma **mensagem** é um modelo reutilizável. Os fluxos escolhem qual enviar. O simulador ao lado do editor usa exatamente o mesmo código do envio: o que você vê é o que o cliente recebe.",
        ],
      },
      {
        heading: "Qual canal usar",
        blocks: [
          {
            table: [
              [
                "E-mail",
                "Conteúdo longo, imagens, vários links",
                "Barato; lido com menos frequência",
              ],
              [
                "SMS",
                "Lembretes curtos e urgentes",
                "160 caracteres por parte (70 com acento/emoji); cobrado por parte",
              ],
              [
                "WhatsApp",
                "Maior leitura; conversa",
                "Fora de uma conversa aberta, só modelos aprovados pela Meta",
              ],
              [
                "RCS",
                "Visual no Android: cartões, carrossel, botões",
                "Quem não tem RCS (iPhone) recebe o SMS alternativo",
              ],
            ],
            head: ["Canal", "Bom para", "Atenção"],
          },
        ],
      },
      {
        heading: "Variáveis",
        blocks: [
          "Clique num campo de texto e depois numa variável (ex.: `{{first_name}}`) para inserir. No envio, ela é trocada pelo dado do cliente; se o cliente não tiver o dado, fica vazia — escreva frases que funcionem nos dois casos.",
          "Em **Ver como**, busque um cliente real para conferir a mensagem com os dados dele.",
        ],
      },
      {
        heading: "Marketing × transacional",
        blocks: [
          {
            list: [
              "**Marketing** (ofertas, novidades, reativação): não vai para quem pediu para não receber naquele canal, só sai no horário de envio e conta no limite diário.",
              "**Transacional** (pagamento, pedido, entrega): é sobre algo que o cliente fez, então vai mesmo com descadastro de marketing.",
            ],
          },
          {
            warn: "Não marque como transacional uma mensagem que é promoção. Além de irritar o cliente, fere a LGPD e as regras do WhatsApp.",
          },
        ],
      },
      {
        heading: "Dicas por canal",
        blocks: [
          {
            list: [
              "**E-mail**: assunto com até ~50 caracteres; use o pré-cabeçalho; um botão principal; rodapé dizendo quem envia e como sair da lista.",
              "**SMS**: comece com “Kakauma:”; evite acentos para caber em 1 parte; o medidor mostra partes e codificação.",
              "**WhatsApp**: categoria “Utilidade” para pagamento/entrega (mais barata), “Marketing” para ofertas; até 3 botões; *negrito* e _itálico_ funcionam.",
              "**RCS**: escolha texto, cartão ou carrossel; até 4 sugestões; sempre escreva o SMS alternativo.",
            ],
          },
        ],
      },
      {
        heading: "Envio de verdade",
        blocks: [
          "**SMS e RCS de texto** saem pela Pushfy quando ela está conectada e o envio real está ligado (veja em Operação → Canais de envio). Antes disso, e para WhatsApp, RCS com cartão e e-mail, os envios aparecem como **Simulação** (com o conteúdo final) no fluxo e no Cliente 360. Em cada SMS ou RCS salvo há **Enviar teste de verdade**, para conferir no seu celular. Falhas temporárias são tentadas de novo automaticamente; número inválido ou mensagem recusada não são repetidos.",
        ],
      },
    ],
  },
  {
    slug: "clientes",
    title: "Clientes e Cliente 360",
    summary:
      "Etapas do ciclo de vida, risco, tipos de cliente e tudo o que aparece na ficha do cliente.",
    category: "Relacionamento",
    screen: { to: "/customers", label: "Abrir Clientes" },
    sections: [
      {
        blocks: [
          "O **Cliente 360** junta identidade, aquisição (origem, campanha, criativo, afiliado), pedidos, assinaturas e cobranças, entregas, finanças, experiência, segmentos, fluxos, mensagens e a linha do tempo de fatos.",
          "Um mesmo cliente é reconhecido pelo id da B4you, e-mail, WhatsApp ou documento — compras com dados diferentes se juntam no mesmo cadastro.",
          "Em **Clientes**, alterne entre **Lista** e **Kanban**. No Kanban, escolha as colunas (etapa do ciclo de vida, risco, tipo ou faixa de valor) e a ordem (maior LTV ou compra mais recente). As colunas são calculadas pelos eventos — o cliente muda de coluna sozinho quando compra, paga, atrasa ou cancela — por isso os cartões não são arrastados. “Ver todos” abre a lista já filtrada.",
        ],
      },
      {
        heading: "Risco",
        blocks: [
          {
            table: [
              ["Saudável", "Nada pedindo atenção."],
              ["Em risco", "Sinais de atrito (atraso de entrega, pedido de cancelamento…)."],
              ["Risco de pagamento", "Cobrança atrasada ou recusada."],
              ["Risco de churn", "Muito tempo sem comprar (ajustável em Operação)."],
              ["Alto valor em risco", "Qualquer risco em cliente com LTV líquido alto."],
            ],
            head: ["Risco", "Quando"],
          },
        ],
      },
      {
        heading: "Descadastro (opt-out)",
        blocks: [
          "Na seção **Mensagens** do Cliente 360, desmarque os canais em que a pessoa não quer receber marketing. Fica registrado na auditoria.",
        ],
      },
    ],
  },
  {
    slug: "segmentos",
    title: "Segmentos e regras",
    summary: "Grupos dinâmicos de clientes por regra — usados em filtros, fluxos e automações.",
    category: "Relacionamento",
    screen: { to: "/segments", label: "Abrir Segmentos" },
    sections: [
      {
        blocks: [
          "Um segmento é uma **regra** (ex.: “LTV líquido > 300 E tem assinatura ativa”). A participação é recalculada a cada evento e periodicamente, e entrar/sair de um segmento vira um fato que pode disparar um fluxo.",
          "No construtor, combine condições com **E** (todas) ou **OU** (qualquer). A contagem “Agora: X de Y clientes” mostra o efeito na hora. Regras mais complexas (grupos aninhados) podem ser editadas em JSON.",
        ],
      },
      {
        blocks: [
          { tip: "As mesmas regras são usadas em “Quem pode entrar” e “Condição” dos fluxos." },
        ],
      },
    ],
  },
  {
    slug: "recuperacao",
    title: "Recuperação",
    summary:
      "A fila de quem precisa de uma ação agora: checkout abandonado, PIX/boleto pendente, pagamento atrasado, cancelamento.",
    category: "Relacionamento",
    screen: { to: "/recovery", label: "Abrir Recuperação" },
    sections: [
      {
        blocks: [
          "Só aparecem situações **abertas e reais**: assim que o cliente paga, renova ou desiste do cancelamento, ele sai da fila. Comece pelos casos de maior valor.",
          {
            tip: "Para recuperar em escala, use o fluxo “Recuperação de pagamento” e deixe a fila para os casos que pedem contato humano.",
          },
        ],
      },
    ],
  },
  {
    slug: "glossario",
    title: "Glossário de métricas",
    summary:
      "LTV bruto, líquido, de contribuição e lucro; CAC; retenção C1–C12; cohorts; CX score; score de qualidade.",
    category: "Dados e análises",
    sections: [
      {
        blocks: [
          {
            table: [
              ["LTV bruto", "Tudo que o cliente pagou."],
              ["LTV líquido", "Bruto − reembolsos − chargebacks."],
              [
                "LTV de contribuição",
                "Líquido − taxas da plataforma − frete − comissões de afiliado.",
              ],
              [
                "Lucro do cliente",
                "Contribuição − custo do produto (CMV) − impostos. Fica “incompleto” se faltar custo ou alíquota.",
              ],
              [
                "CAC",
                "Investimento em mídia ÷ clientes adquiridos no período (precisa do investimento importado em Operação).",
              ],
              ["LTV/CAC", "Quantas vezes o cliente devolve o custo de aquisição."],
              [
                "Retenção C1…C12",
                "% das assinaturas que pagaram cada ciclo, contando só as que já tiveram tempo de chegar nele.",
              ],
              ["Cohort", "Grupo de clientes que começaram juntos (mês, campanha, origem…)."],
              [
                "Curva de LTV",
                "Receita líquida acumulada por cliente mês a mês desde a 1ª compra, sem projeção.",
              ],
              [
                "CX score",
                "0–100: começa em 80, sobe com recompras, cai com atrasos, falhas de entrega, reembolsos e atritos.",
              ],
              [
                "Score de qualidade",
                "0–100 para assinaturas: ciclos pagos, atrasos, falhas, reembolsos, pedido de cancelamento.",
              ],
              ["Taxa de meta", "Dos que terminaram um fluxo, quantos atingiram a meta."],
            ],
            head: ["Métrica", "O que é"],
          },
          "“—” nas telas significa **sem base** (não há dado suficiente), nunca zero.",
        ],
      },
    ],
  },
  {
    slug: "painel",
    title: "Painel e Insights",
    summary:
      "O que cada número do painel mede e como ler funil, campanhas, cohorts, retenção e curva de LTV.",
    category: "Dados e análises",
    screen: { to: "/crm", label: "Abrir Painel" },
    sections: [
      {
        blocks: [
          "O **período** (canto superior) vale para tudo que é fluxo de dinheiro e aquisição. Números de “agora” (assinantes ativos, LTV médio) não dependem do período.",
          "**Ao longo do tempo** mostra receita, pedidos e novos clientes, assinaturas (novas, renovações, canceladas) e reembolsos por dia, semana ou mês. O botão **Tabela** mostra os números exatos de cada ponto. O último ponto pode estar incompleto se o período ainda não terminou.",
          {
            list: [
              "**Funil**: de checkout a compra, por etapa.",
              "**Campanhas**: receita, LTV, reembolso e CAC por origem/campanha/criativo.",
              "**Cohorts** e **Retenção**: como cada grupo se comporta com o tempo.",
              "**Curva de LTV**: quanto um cliente vale mês a mês.",
              "**Reembolsos**: taxa de reembolso por produto, oferta, campanha e método de pagamento.",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "operacao",
    title: "Operação",
    summary:
      "Saúde da ingestão, fila de erros, custos e impostos, investimento em mídia e regras do sistema.",
    category: "Administração",
    screen: { to: "/operations", label: "Abrir Operação" },
    sections: [
      {
        blocks: [
          {
            list: [
              "**Eventos por status**: se algo está parado em “Com erro”, o sistema tenta de novo sozinho; depois de 5 falhas vai para a **fila de erros**.",
              "**Fila de erros**: o evento original está guardado. Corrija a causa e use **Reprocessar**.",
              "**Custos e impostos**: custo por produto/oferta e alíquota — necessários para o lucro por cliente.",
              "**Investimento em mídia**: importe CSV para ter CAC e LTV/CAC.",
              "**Regras e limites**: janelas de churn, limite diário de mensagens, horário de envio, pesos dos scores. Toda alteração vai para a auditoria.",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "lgpd",
    title: "LGPD: descadastro e anonimização",
    summary:
      "Como respeitar quem não quer receber mensagens e como atender um pedido de exclusão de dados.",
    category: "Administração",
    sections: [
      {
        heading: "Descadastro",
        blocks: [
          "No Cliente 360 → Mensagens, desmarque os canais. Mensagens de marketing deixam de ir por eles; transacionais continuam.",
        ],
      },
      {
        heading: "Anonimização",
        blocks: [
          "Administradores podem **anonimizar** um cliente no Cliente 360 (com motivo/protocolo). Nome, contatos, documento, endereço, links de pagamento, rastreio e mensagens são apagados — inclusive dentro dos eventos originais. Valores e histórico continuam nos relatórios, sem identificar a pessoa.",
          { warn: "Não dá para desfazer. Se a pessoa comprar de novo, vira um cliente novo." },
        ],
      },
    ],
  },
  {
    slug: "administracao",
    title: "Usuários, papéis e auditoria",
    summary: "Quem pode fazer o quê e onde ver o histórico de alterações.",
    category: "Administração",
    screen: { to: "/admin", label: "Abrir Administração" },
    sections: [
      {
        blocks: [
          {
            table: [
              ["Leitura", "Vê tudo, não altera nada."],
              ["Operador", "Edita segmentos, mensagens, fluxos, automações e descadastros."],
              [
                "Administrador",
                "Tudo, mais usuários, regras do sistema, custos, reprocessamento, anonimização e auditoria.",
              ],
            ],
            head: ["Papel", "Pode"],
          },
          "A **Auditoria** mostra quem mudou o quê e quando — inclusive mudanças feitas automaticamente pelos eventos.",
        ],
      },
    ],
  },
];

export const helpBySlug = (slug: string) => HELP.find((a) => a.slug === slug);
