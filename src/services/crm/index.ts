import { buildSeed, SEED_VERSION } from "./seed";
import {
  CONTACT_STATUS_LABEL,
  DEAL_STAGE_LABEL,
  RECOVERY_REASON_LABEL,
  RECOVERY_STATUS_LABEL,
  type Activity,
  type ActivityType,
  type Contact,
  type ContactStatus,
  type CrmDb,
  type Deal,
  type DealStage,
  type Recovery,
  type RecoveryReason,
  type RecoveryStatus,
  type Task,
} from "./types";

export * from "./types";

/**
 * Single data-access layer for the CRM.
 *
 * Front-end phase: data lives in the browser (localStorage) on top of a demo
 * seed. Every screen goes through these async functions only, so wiring the
 * backend later means re-implementing this file — the UI stays untouched.
 */

const STORAGE_KEY = "kakauma-crm:db";
const CURRENT_USER = "Felipe";

let db: CrmDb | null = null;

function load(): CrmDb {
  if (db) return db;
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CrmDb;
        if (parsed.version === SEED_VERSION) return (db = parsed);
      }
    } catch {
      // Corrupt or blocked storage: fall back to the seed.
    }
  }
  db = buildSeed();
  save();
  return db;
}

function save() {
  if (typeof window === "undefined" || !db) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // Storage full or blocked: keep working in memory.
  }
}

function newId(prefix: string) {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rnd}`;
}

function nowIso() {
  return new Date().toISOString();
}

function logActivity(contactId: string, type: ActivityType, text: string, author = CURRENT_USER) {
  const a: Activity = {
    id: newId("ac"),
    contact_id: contactId,
    type,
    text,
    author,
    created_at: nowIso(),
  };
  load().activities.push(a);
  return a;
}

function contactOrThrow(id: string) {
  const c = load().contacts.find((x) => x.id === id);
  if (!c) throw new Error("Contato não encontrado");
  return c;
}

const byDateDesc =
  <T>(key: keyof T) =>
  (a: T, b: T) =>
    String(b[key]).localeCompare(String(a[key]));

// ---------------------------------------------------------------- contacts

export interface ContactFilters {
  q?: string;
  status?: ContactStatus | "all";
  tag?: string | "all";
  owner?: string | "all";
}

export async function listContacts(f: ContactFilters = {}): Promise<Contact[]> {
  const q = f.q?.trim().toLowerCase();
  return load()
    .contacts.filter((c) => {
      if (f.status && f.status !== "all" && c.status !== f.status) return false;
      if (f.tag && f.tag !== "all" && !c.tags.includes(f.tag)) return false;
      if (f.owner && f.owner !== "all" && c.owner !== f.owner) return false;
      if (q && !`${c.name} ${c.email} ${c.phone ?? ""} ${c.city ?? ""}`.toLowerCase().includes(q))
        return false;
      return true;
    })
    .sort(byDateDesc("created_at"));
}

export async function listTags(): Promise<string[]> {
  return Array.from(new Set(load().contacts.flatMap((c) => c.tags))).sort((a, b) =>
    a.localeCompare(b, "pt-BR"),
  );
}

export interface ContactDetail {
  contact: Contact;
  deals: Deal[];
  recoveries: Recovery[];
  tasks: Task[];
  activities: Activity[];
}

export async function getContact(id: string): Promise<ContactDetail> {
  const d = load();
  return {
    contact: contactOrThrow(id),
    deals: d.deals.filter((x) => x.contact_id === id).sort(byDateDesc("updated_at")),
    recoveries: d.recoveries.filter((x) => x.contact_id === id).sort(byDateDesc("created_at")),
    tasks: d.tasks
      .filter((x) => x.contact_id === id)
      .sort((a, b) => a.due_at.localeCompare(b.due_at)),
    activities: d.activities.filter((x) => x.contact_id === id).sort(byDateDesc("created_at")),
  };
}

export type ContactInput = Pick<
  Contact,
  "name" | "email" | "phone" | "city" | "state" | "status" | "tags" | "owner" | "source"
>;

export async function createContact(input: ContactInput): Promise<Contact> {
  const d = load();
  const email = input.email.trim().toLowerCase();
  if (d.contacts.some((c) => c.email.toLowerCase() === email)) {
    throw new Error("Já existe um contato com este e-mail");
  }
  const c: Contact = {
    ...input,
    email,
    id: newId("ct"),
    total_spent: 0,
    orders: 0,
    last_purchase_at: null,
    created_at: nowIso(),
  };
  d.contacts.push(c);
  logActivity(c.id, "created", "Contato criado manualmente");
  save();
  return c;
}

export async function updateContact(id: string, patch: Partial<ContactInput>): Promise<Contact> {
  const c = contactOrThrow(id);
  if (patch.status && patch.status !== c.status) {
    logActivity(
      id,
      "status_change",
      `Status alterado de ${CONTACT_STATUS_LABEL[c.status]} para ${CONTACT_STATUS_LABEL[patch.status]}`,
    );
  }
  Object.assign(c, patch);
  save();
  return c;
}

export async function addNote(contactId: string, body: string): Promise<Activity> {
  contactOrThrow(contactId);
  const a = logActivity(contactId, "note", body.trim());
  save();
  return a;
}

// ---------------------------------------------------------------- deals

export interface DealWithContact extends Deal {
  contact: Pick<Contact, "id" | "name" | "email">;
}

export async function listDeals(): Promise<DealWithContact[]> {
  const d = load();
  const map = new Map(d.contacts.map((c) => [c.id, c]));
  return d.deals
    .map((x) => {
      const c = map.get(x.contact_id);
      return { ...x, contact: { id: x.contact_id, name: c?.name ?? "—", email: c?.email ?? "" } };
    })
    .sort(byDateDesc("updated_at"));
}

export async function moveDeal(id: string, stage: DealStage): Promise<Deal> {
  const deal = load().deals.find((x) => x.id === id);
  if (!deal) throw new Error("Negócio não encontrado");
  if (deal.stage === stage) return deal;
  logActivity(
    deal.contact_id,
    "stage_change",
    `${deal.title}: ${DEAL_STAGE_LABEL[deal.stage]} → ${DEAL_STAGE_LABEL[stage]}`,
  );
  deal.stage = stage;
  deal.updated_at = nowIso();
  save();
  return deal;
}

export type DealInput = Pick<
  Deal,
  "contact_id" | "title" | "value" | "product" | "stage" | "owner"
>;

export async function createDeal(input: DealInput): Promise<Deal> {
  contactOrThrow(input.contact_id);
  const deal: Deal = { ...input, id: newId("dl"), created_at: nowIso(), updated_at: nowIso() };
  load().deals.push(deal);
  logActivity(
    input.contact_id,
    "stage_change",
    `Negócio criado: ${deal.title} (${DEAL_STAGE_LABEL[deal.stage]})`,
  );
  save();
  return deal;
}

// ---------------------------------------------------------------- recovery

export interface RecoveryWithContact extends Recovery {
  contact: Pick<Contact, "id" | "name" | "email" | "phone">;
}

export async function listRecoveries(
  f: { status?: RecoveryStatus | "all"; reason?: RecoveryReason | "all" } = {},
) {
  const d = load();
  const map = new Map(d.contacts.map((c) => [c.id, c]));
  return d.recoveries
    .filter(
      (r) =>
        (!f.status || f.status === "all" || r.status === f.status) &&
        (!f.reason || f.reason === "all" || r.reason === f.reason),
    )
    .map<RecoveryWithContact>((r) => {
      const c = map.get(r.contact_id);
      return {
        ...r,
        contact: {
          id: r.contact_id,
          name: c?.name ?? "—",
          email: c?.email ?? "",
          phone: c?.phone ?? null,
        },
      };
    })
    .sort(byDateDesc("created_at"));
}

export async function updateRecovery(id: string, status: RecoveryStatus): Promise<Recovery> {
  const d = load();
  const r = d.recoveries.find((x) => x.id === id);
  if (!r) throw new Error("Recuperação não encontrada");
  if (status === "contatado") r.attempts += 1;
  if (status === "recuperado" && r.status !== "recuperado") {
    const c = contactOrThrow(r.contact_id);
    c.total_spent = Math.round((c.total_spent + r.value) * 100) / 100;
    c.orders += 1;
    c.last_purchase_at = nowIso();
    if (c.status !== "cliente") c.status = "cliente";
  }
  logActivity(
    r.contact_id,
    "recovery",
    `${RECOVERY_REASON_LABEL[r.reason]} (${r.product}): ${RECOVERY_STATUS_LABEL[status]}`,
  );
  r.status = status;
  r.updated_at = nowIso();
  save();
  return r;
}

// ---------------------------------------------------------------- tasks

export interface TaskWithContact extends Task {
  contact: Pick<Contact, "id" | "name"> | null;
}

export async function listTasks(): Promise<TaskWithContact[]> {
  const d = load();
  const map = new Map(d.contacts.map((c) => [c.id, c]));
  return d.tasks
    .map((t) => {
      const c = t.contact_id ? map.get(t.contact_id) : undefined;
      return { ...t, contact: c ? { id: c.id, name: c.name } : null };
    })
    .sort((a, b) => a.due_at.localeCompare(b.due_at));
}

export type TaskInput = Pick<
  Task,
  "title" | "type" | "priority" | "contact_id" | "due_at" | "owner"
>;

export async function createTask(input: TaskInput): Promise<Task> {
  const t: Task = { ...input, id: newId("tk"), done: false, created_at: nowIso() };
  load().tasks.push(t);
  save();
  return t;
}

export async function toggleTask(id: string): Promise<Task> {
  const t = load().tasks.find((x) => x.id === id);
  if (!t) throw new Error("Tarefa não encontrada");
  t.done = !t.done;
  if (t.done && t.contact_id)
    logActivity(t.contact_id, "task_done", `Tarefa concluída: ${t.title}`);
  save();
  return t;
}

// ---------------------------------------------------------------- dashboard

export interface CrmSummary {
  contacts: number;
  leads: number;
  customers: number;
  newContacts7d: number;
  pipelineValue: number;
  openDeals: number;
  wonValue: number;
  winRate: number;
  recoveryPending: number;
  recoveryPendingValue: number;
  recoveredValue: number;
  recoveryRate: number;
  tasksOverdue: number;
  tasksToday: number;
  stages: { key: DealStage; count: number; value: number }[];
}

export async function crmSummary(): Promise<CrmSummary> {
  const d = load();
  const now = Date.now();
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const open = d.deals.filter((x) => x.stage !== "ganho" && x.stage !== "perdido");
  const won = d.deals.filter((x) => x.stage === "ganho");
  const lost = d.deals.filter((x) => x.stage === "perdido");
  const pending = d.recoveries.filter((r) => r.status === "pendente" || r.status === "contatado");
  const recovered = d.recoveries.filter((r) => r.status === "recuperado");
  const closedRec = recovered.length + d.recoveries.filter((r) => r.status === "perdido").length;
  const openTasks = d.tasks.filter((t) => !t.done);
  const sum = (xs: { value: number }[]) => xs.reduce((s, x) => s + x.value, 0);

  return {
    contacts: d.contacts.length,
    leads: d.contacts.filter((c) => c.status === "lead").length,
    customers: d.contacts.filter((c) => c.status === "cliente").length,
    newContacts7d: d.contacts.filter((c) => now - new Date(c.created_at).getTime() < 7 * 86_400_000)
      .length,
    pipelineValue: sum(open),
    openDeals: open.length,
    wonValue: sum(won),
    winRate: won.length + lost.length ? (won.length * 100) / (won.length + lost.length) : 0,
    recoveryPending: pending.length,
    recoveryPendingValue: sum(pending),
    recoveredValue: sum(recovered),
    recoveryRate: closedRec ? (recovered.length * 100) / closedRec : 0,
    tasksOverdue: openTasks.filter((t) => new Date(t.due_at).getTime() < now).length,
    tasksToday: openTasks.filter((t) => {
      const due = new Date(t.due_at).getTime();
      return due >= now && due <= endOfToday.getTime();
    }).length,
    stages: (["novo", "contato", "proposta", "negociacao", "ganho", "perdido"] as DealStage[]).map(
      (key) => {
        const xs = d.deals.filter((x) => x.stage === key);
        return { key, count: xs.length, value: sum(xs) };
      },
    ),
  };
}

export async function resetDemoData(): Promise<void> {
  db = buildSeed();
  save();
}
