/**
 * Flow graphs: node catalog (labels, outputs, explanations) and the edits the
 * builder makes. The graph is a list of nodes and edges; the builder keeps it
 * a tree (each step has one way in), which the server validates as acyclic.
 */
import { FACT_LABEL, label } from "./crm-api.ts";
import { CHANNEL_LABEL, type Channel } from "./crm-messages.ts";

export type NodeType =
  "trigger" | "send" | "wait" | "wait_event" | "condition" | "split" | "alert_team" | "exit";

export interface FlowNode {
  id: string;
  type: NodeType;
  config: Record<string, unknown>;
}
export interface FlowEdge {
  source: string;
  target: string;
  handle: string;
}
export interface Graph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}
export interface SplitBranch {
  key: string;
  label: string;
  percent: number;
}

export const NODE_META: Record<
  NodeType,
  { label: string; tone: string; what: string; when: string; handles?: Record<string, string> }
> = {
  trigger: {
    label: "Início",
    tone: "bg-primary text-primary-foreground",
    what: "O fato que coloca o cliente no fluxo (ex.: compra aprovada, pagamento atrasado). A regra de entrada é conferida no estado atual do cliente.",
    when: "Sempre há exatamente um. Clique para escolher o gatilho, a regra de entrada e a meta.",
  },
  send: {
    label: "Enviar mensagem",
    tone: "bg-[oklch(0.62_0.1_296)] text-white",
    what: "Envia um modelo de e-mail, SMS, WhatsApp ou RCS criado em Mensagens, com as variáveis do cliente preenchidas.",
    when: "Mensagens de marketing respeitam descadastro, horário de envio e o limite diário por cliente.",
  },
  wait: {
    label: "Esperar",
    tone: "bg-[oklch(0.75_0.12_78)] text-neutral-900",
    what: "Pausa o cliente por um tempo antes do próximo passo.",
    when: "Use para espaçar mensagens (ex.: 3 dias depois da compra).",
  },
  wait_event: {
    label: "Aguardar evento",
    tone: "bg-[oklch(0.75_0.12_78)] text-neutral-900",
    what: "Espera o cliente fazer algo (ex.: pagar) até um prazo. Se acontecer, segue por “Aconteceu”; se o prazo acabar, por “Não aconteceu”.",
    when: "Ideal para recuperação: só manda o lembrete seguinte para quem ainda não resolveu.",
    handles: { event: "Aconteceu", timeout: "Não aconteceu" },
  },
  condition: {
    label: "Condição",
    tone: "bg-[oklch(0.6_0.13_158)] text-white",
    what: "Divide em dois caminhos conforme uma regra sobre o cliente agora (ex.: LTV ≥ R$ 500, tem assinatura ativa).",
    when: "Use para tratar diferente quem vale mais, quem já comprou de novo etc.",
    handles: { yes: "Sim", no: "Não" },
  },
  split: {
    label: "Teste A/B",
    tone: "bg-[oklch(0.58_0.18_25)] text-white",
    what: "Sorteia o caminho de cada cliente pelas porcentagens (2 a 4 caminhos). O sorteio é fixo por cliente.",
    when: "Compare mensagens ou canais. Deixe um caminho vazio como grupo de controle para medir o efeito real.",
  },
  alert_team: {
    label: "Alertar equipe",
    tone: "bg-neutral-700 text-white",
    what: "Cria um alerta para o time (ex.: ligar para um cliente VIP). Não vai para o cliente.",
    when: "Use em casos que pedem contato humano.",
  },
  exit: {
    label: "Sair do fluxo",
    tone: "bg-neutral-300 text-neutral-900",
    what: "Encerra o fluxo para o cliente neste ponto.",
    when: "Um caminho sem próximo passo também termina; use “Sair” para deixar explícito.",
  },
};

export const ADDABLE: NodeType[] = [
  "send",
  "wait",
  "wait_event",
  "condition",
  "split",
  "alert_team",
  "exit",
];

export function handlesOf(n: FlowNode): string[] {
  switch (n.type) {
    case "wait_event":
      return ["event", "timeout"];
    case "condition":
      return ["yes", "no"];
    case "split":
      return ((n.config["branches"] as SplitBranch[] | undefined) ?? []).map((b) => b.key);
    case "exit":
      return [];
    default:
      return ["next"];
  }
}

export function handleLabel(n: FlowNode, h: string) {
  if (n.type === "split") {
    const b = ((n.config["branches"] as SplitBranch[] | undefined) ?? []).find((x) => x.key === h);
    return b ? `${b.label || h.toUpperCase()} · ${b.percent}%` : h;
  }
  return NODE_META[n.type].handles?.[h] ?? "";
}

export function defaultConfig(t: NodeType): Record<string, unknown> {
  switch (t) {
    case "wait":
      return { amount: 1, unit: "days" };
    case "wait_event":
      return { fact: "PURCHASE_PAID", timeout_hours: 48 };
    case "condition":
      return { rule: {} };
    case "split":
      return {
        branches: [
          { key: "a", label: "A", percent: 50 },
          { key: "b", label: "B", percent: 50 },
        ],
      };
    case "alert_team":
      return { message: "{{full_name}} precisa de atenção." };
    case "send":
      return { template_key: "" };
    default:
      return {};
  }
}

export const child = (g: Graph, id: string, handle: string) =>
  g.edges.find((e) => e.source === id && e.handle === handle)?.target ?? null;

export function newId(g: Graph, t: NodeType) {
  const base = t.replace("_", "");
  let i = 1;
  while (g.nodes.some((n) => n.id === `${base}${i}`)) i++;
  return `${base}${i}`;
}

/** Inserts a step on the output (parent, handle); what was there moves under the new step's first output. */
export function insertNode(
  g: Graph,
  parent: string,
  handle: string,
  t: NodeType,
): { graph: Graph; id: string } {
  const id = newId(g, t);
  const node: FlowNode = { id, type: t, config: defaultConfig(t) };
  const below = child(g, parent, handle);
  const edges = g.edges.filter((e) => !(e.source === parent && e.handle === handle));
  edges.push({ source: parent, target: id, handle });
  const first = handlesOf(node)[0];
  if (below) {
    if (first) edges.push({ source: id, target: below, handle: first });
    else return { graph: removeSubtree({ nodes: [...g.nodes, node], edges }, below), id }; // "exit" ends the path
  }
  return { graph: { nodes: [...g.nodes, node], edges }, id };
}

function subtree(g: Graph, id: string, acc = new Set<string>()) {
  if (acc.has(id)) return acc;
  acc.add(id);
  for (const e of g.edges) if (e.source === id) subtree(g, e.target, acc);
  return acc;
}

function removeSubtree(g: Graph, id: string): Graph {
  const gone = subtree(g, id);
  return {
    nodes: g.nodes.filter((n) => !gone.has(n.id)),
    edges: g.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
  };
}

/** Steps that would disappear with this one (the other branches below a branching step). */
export function removalCost(g: Graph, id: string) {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) return 0;
  const [first, ...rest] = handlesOf(n);
  void first;
  let count = 0;
  for (const h of rest) {
    const c = child(g, id, h);
    if (c) count += subtree(g, c).size;
  }
  return count;
}

/** Removes a step: its first output reconnects to the parent; other branches are dropped. */
export function removeNode(g: Graph, id: string): Graph {
  const n = g.nodes.find((x) => x.id === id);
  if (!n || n.type === "trigger") return g;
  const incoming = g.edges.find((e) => e.target === id);
  const [first, ...rest] = handlesOf(n);
  let next = g;
  for (const h of rest) {
    const c = child(next, id, h);
    if (c) next = removeSubtree(next, c);
  }
  const keep = first ? child(next, id, first) : null;
  const edges = next.edges.filter((e) => e.source !== id && e.target !== id);
  if (incoming && keep)
    edges.push({ source: incoming.source, target: keep, handle: incoming.handle });
  return { nodes: next.nodes.filter((x) => x.id !== id), edges };
}

export function updateConfig(g: Graph, id: string, config: Record<string, unknown>): Graph {
  const edges = g.edges;
  const n = g.nodes.find((x) => x.id === id);
  if (n?.type === "split") {
    // removing a branch drops the steps under it
    const keys = ((config["branches"] as SplitBranch[]) ?? []).map((b) => b.key);
    let next: Graph = g;
    for (const e of g.edges.filter((x) => x.source === id && !keys.includes(x.handle)))
      next = removeSubtree(next, e.target);
    return {
      nodes: next.nodes.map((x) => (x.id === id ? { ...x, config } : x)),
      edges: next.edges.filter((e) => !(e.source === id && !keys.includes(e.handle))),
    };
  }
  return { nodes: g.nodes.map((x) => (x.id === id ? { ...x, config } : x)), edges };
}

const unitPt: Record<string, [string, string]> = {
  minutes: ["minuto", "minutos"],
  hours: ["hora", "horas"],
  days: ["dia", "dias"],
};

export function waitText(amount: number, unit: string) {
  const [one, many] = unitPt[unit] ?? ["hora", "horas"];
  return `${amount} ${amount === 1 ? one : many}`;
}

export function hoursText(h: number) {
  return h % 24 === 0 ? waitText(h / 24, "days") : waitText(h, "hours");
}

/** One-line description of what a step does, for the canvas card. */
export function describe(
  n: FlowNode,
  ctx: { templates: Map<string, { name: string; channel: Channel }>; triggerFact?: string },
): string {
  const c = n.config;
  switch (n.type) {
    case "trigger":
      return ctx.triggerFact
        ? `Quando: ${label(FACT_LABEL, ctx.triggerFact)}`
        : "Escolha o gatilho";
    case "send": {
      const t = ctx.templates.get(String(c["template_key"] ?? ""));
      return t ? `${CHANNEL_LABEL[t.channel]}: ${t.name}` : "Escolha a mensagem";
    }
    case "wait":
      return `Esperar ${waitText(Number(c["amount"] ?? 0), String(c["unit"] ?? "hours"))}`;
    case "wait_event":
      return `Até ${hoursText(Number(c["timeout_hours"] ?? 0))}: ${label(FACT_LABEL, String(c["fact"] ?? ""))}`;
    case "condition": {
      const r = c["rule"] as Record<string, unknown> | undefined;
      if (!r || !Object.keys(r).length) return "Defina a regra";
      const one = (x: Record<string, unknown>) =>
        `${x["field"]} ${x["op"]} ${Array.isArray(x["value"]) ? x["value"].join(", ") : (x["value"] ?? "")}`.trim();
      if ("field" in r) return one(r);
      const list = (r["all"] ?? r["any"]) as Record<string, unknown>[] | undefined;
      return list ? list.map(one).join(r["all"] ? " E " : " OU ") : "Regra avançada";
    }
    case "split":
      return ((c["branches"] as SplitBranch[] | undefined) ?? [])
        .map((b) => `${b.label || b.key} ${b.percent}%`)
        .join(" · ");
    case "alert_team":
      return String(c["message"] ?? "");
    case "exit":
      return "Fim do fluxo para o cliente";
  }
}

/** Problems a step has before saving (shown on the card). */
export function nodeProblem(n: FlowNode, templates: Map<string, unknown>): string | null {
  const c = n.config;
  switch (n.type) {
    case "send":
      return templates.has(String(c["template_key"] ?? "")) ? null : "Escolha uma mensagem";
    case "condition": {
      const r = c["rule"] as Record<string, unknown> | undefined;
      return r && Object.keys(r).length ? null : "Defina a regra";
    }
    case "split": {
      const b = (c["branches"] as SplitBranch[] | undefined) ?? [];
      const sum = b.reduce((a, x) => a + (Number(x.percent) || 0), 0);
      return sum === 100 ? null : `Porcentagens somam ${sum}%`;
    }
    case "wait":
      return Number(c["amount"]) >= 1 ? null : "Informe a duração";
    case "alert_team":
      return String(c["message"] ?? "").trim() ? null : "Escreva o alerta";
    default:
      return null;
  }
}

export const EMPTY_GRAPH: Graph = {
  nodes: [{ id: "start", type: "trigger", config: {} }],
  edges: [],
};
