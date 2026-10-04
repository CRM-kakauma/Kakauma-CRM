import {
  DEAL_STAGES,
  OWNERS,
  type Activity,
  type Contact,
  type CrmDb,
  type Deal,
  type Recovery,
  type RecoveryReason,
  type RecoveryStatus,
  type Task,
  type TaskPriority,
  type TaskType,
} from "./types";

/**
 * Demo dataset for the front-end phase. Deterministic (seeded PRNG) so every
 * browser sees the same base, with dates relative to "now" so it always looks fresh.
 */

export const SEED_VERSION = 1;

const FIRST = [
  "Ana",
  "Bruna",
  "Camila",
  "Daniela",
  "Eduarda",
  "Fernanda",
  "Gabriela",
  "Helena",
  "Isabela",
  "Juliana",
  "Larissa",
  "Mariana",
  "Natália",
  "Patrícia",
  "Renata",
  "Sofia",
  "Tatiane",
  "Vanessa",
  "Bruno",
  "Carlos",
  "Diego",
  "Felipe",
  "Gustavo",
  "Henrique",
  "Igor",
  "João",
  "Lucas",
  "Marcos",
  "Pedro",
  "Rafael",
];
const LAST = [
  "Silva",
  "Santos",
  "Oliveira",
  "Souza",
  "Lima",
  "Pereira",
  "Costa",
  "Rodrigues",
  "Almeida",
  "Nascimento",
  "Ferreira",
  "Araújo",
  "Carvalho",
  "Gomes",
  "Martins",
  "Rocha",
  "Ribeiro",
  "Barbosa",
  "Mendes",
  "Teixeira",
];
const CITIES: [string, string][] = [
  ["São Paulo", "SP"],
  ["Rio de Janeiro", "RJ"],
  ["Belo Horizonte", "MG"],
  ["Curitiba", "PR"],
  ["Porto Alegre", "RS"],
  ["Salvador", "BA"],
  ["Recife", "PE"],
  ["Fortaleza", "CE"],
  ["Goiânia", "GO"],
  ["Campinas", "SP"],
  ["Florianópolis", "SC"],
  ["Brasília", "DF"],
];
const SOURCES = ["instagram", "facebook", "google", "tiktok", "email", "afiliado", null];
const TAGS = [
  "VIP",
  "Recorrente",
  "Indicação",
  "Primeira compra",
  "Assinante",
  "Atacado",
  "Black Friday",
];
export const PRODUCTS: { name: string; price: number }[] = [
  { name: "Kit Essencial", price: 197 },
  { name: "Kit Completo", price: 397 },
  { name: "Assinatura Mensal", price: 89.9 },
  { name: "Combo 3 meses", price: 247 },
  { name: "Order Bump — Guia", price: 37 },
];

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function slug(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function buildSeed(now = new Date()): CrmDb {
  const rand = mulberry32(42);
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]!;
  const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
  const ago = (days: number, hours = 0) =>
    new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
  const ahead = (days: number, hours = 0) =>
    new Date(now.getTime() + days * 86_400_000 + hours * 3_600_000).toISOString();

  const contacts: Contact[] = [];
  const deals: Deal[] = [];
  const recoveries: Recovery[] = [];
  const tasks: Task[] = [];
  const activities: Activity[] = [];
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${(++seq).toString(36).padStart(4, "0")}`;

  for (let i = 0; i < 64; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const [city, state] = pick(CITIES);
    const roll = rand();
    const status = roll < 0.45 ? "cliente" : roll < 0.85 ? "lead" : "inativo";
    const orders = status === "lead" ? 0 : int(1, 6);
    const avg = pick(PRODUCTS).price;
    const createdDays = int(3, 180);
    const tags = Array.from(new Set(Array.from({ length: int(0, 2) }, () => pick(TAGS))));
    if (orders >= 4 && !tags.includes("VIP")) tags.push("VIP");

    const contact: Contact = {
      id: id("ct"),
      name: `${first} ${last}`,
      email: `${slug(first)}.${slug(last)}${i}@exemplo.com.br`,
      phone: rand() < 0.85 ? `+55 ${int(11, 99)} 9${int(1000, 9999)}-${int(1000, 9999)}` : null,
      city,
      state,
      status,
      tags,
      owner: pick(OWNERS),
      source: pick(SOURCES),
      total_spent: Math.round(orders * avg * 100) / 100,
      orders,
      last_purchase_at: orders > 0 ? ago(int(0, Math.min(createdDays, 120))) : null,
      created_at: ago(createdDays),
    };
    contacts.push(contact);

    activities.push({
      id: id("ac"),
      contact_id: contact.id,
      type: "created",
      text: `Contato criado${contact.source ? ` via ${contact.source}` : ""}`,
      author: "Sistema",
      created_at: contact.created_at,
    });
    if (contact.last_purchase_at) {
      activities.push({
        id: id("ac"),
        contact_id: contact.id,
        type: "purchase",
        text: `Compra aprovada — ${pick(PRODUCTS).name}`,
        author: "B4you",
        created_at: contact.last_purchase_at,
      });
    }

    if (status !== "inativo" && rand() < 0.55) {
      const product = pick(PRODUCTS);
      const stage = pick(DEAL_STAGES).key;
      const created = int(1, 40);
      deals.push({
        id: id("dl"),
        contact_id: contact.id,
        title: `${product.name} — ${first}`,
        value: product.price * int(1, 3),
        stage,
        product: product.name,
        owner: contact.owner,
        created_at: ago(created),
        updated_at: ago(int(0, created)),
      });
    }

    if (rand() < 0.4) {
      const reasons: RecoveryReason[] = [
        "CART_ABANDONED",
        "PIX_EXPIRED",
        "BOLETO_GENERATED",
        "PURCHASE_DECLINED",
      ];
      const statuses: RecoveryStatus[] = [
        "pendente",
        "pendente",
        "pendente",
        "contatado",
        "recuperado",
        "perdido",
      ];
      const product = pick(PRODUCTS);
      const st = pick(statuses);
      const created = int(0, 14);
      recoveries.push({
        id: id("rc"),
        contact_id: contact.id,
        reason: pick(reasons),
        product: product.name,
        value: product.price,
        status: st,
        attempts: st === "pendente" ? 0 : int(1, 3),
        created_at: ago(created, int(0, 20)),
        updated_at: ago(Math.max(0, created - 1)),
      });
    }

    if (rand() < 0.35) {
      const types: TaskType[] = ["ligacao", "whatsapp", "email", "followup"];
      const priorities: TaskPriority[] = ["baixa", "media", "alta"];
      const type = pick(types);
      const offset = int(-3, 7);
      tasks.push({
        id: id("tk"),
        title: {
          ligacao: `Ligar para ${first}`,
          whatsapp: `Mandar WhatsApp para ${first}`,
          email: `Enviar proposta por e-mail para ${first}`,
          followup: `Follow-up com ${first}`,
        }[type],
        type,
        priority: pick(priorities),
        contact_id: contact.id,
        due_at: offset < 0 ? ago(-offset) : ahead(offset, int(1, 8)),
        done: offset < -1 && rand() < 0.5,
        owner: contact.owner,
        created_at: ago(int(1, 10)),
      });
    }
  }

  return { version: SEED_VERSION, contacts, deals, recoveries, tasks, activities };
}
