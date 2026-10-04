export type ContactStatus = "lead" | "cliente" | "inativo";

export type DealStage = "novo" | "contato" | "proposta" | "negociacao" | "ganho" | "perdido";

export type RecoveryReason =
  "CART_ABANDONED" | "PIX_EXPIRED" | "BOLETO_GENERATED" | "PURCHASE_DECLINED";

export type RecoveryStatus = "pendente" | "contatado" | "recuperado" | "perdido";

export type TaskType = "ligacao" | "whatsapp" | "email" | "followup";

export type TaskPriority = "baixa" | "media" | "alta";

export type ActivityType =
  "note" | "stage_change" | "status_change" | "task_done" | "recovery" | "purchase" | "created";

export interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  city: string | null;
  state: string | null;
  status: ContactStatus;
  tags: string[];
  owner: string;
  source: string | null;
  total_spent: number;
  orders: number;
  last_purchase_at: string | null;
  created_at: string;
}

export interface Deal {
  id: string;
  contact_id: string;
  title: string;
  value: number;
  stage: DealStage;
  product: string;
  owner: string;
  created_at: string;
  updated_at: string;
}

export interface Recovery {
  id: string;
  contact_id: string;
  reason: RecoveryReason;
  product: string;
  value: number;
  status: RecoveryStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  title: string;
  type: TaskType;
  priority: TaskPriority;
  contact_id: string | null;
  due_at: string;
  done: boolean;
  owner: string;
  created_at: string;
}

export interface Activity {
  id: string;
  contact_id: string;
  type: ActivityType;
  text: string;
  author: string;
  created_at: string;
}

export interface CrmDb {
  version: number;
  contacts: Contact[];
  deals: Deal[];
  recoveries: Recovery[];
  tasks: Task[];
  activities: Activity[];
}

export const DEAL_STAGES: { key: DealStage; label: string }[] = [
  { key: "novo", label: "Novo lead" },
  { key: "contato", label: "Em contato" },
  { key: "proposta", label: "Proposta enviada" },
  { key: "negociacao", label: "Negociação" },
  { key: "ganho", label: "Ganho" },
  { key: "perdido", label: "Perdido" },
];

export const DEAL_STAGE_LABEL = Object.fromEntries(
  DEAL_STAGES.map((s) => [s.key, s.label]),
) as Record<DealStage, string>;

export const CONTACT_STATUS_LABEL: Record<ContactStatus, string> = {
  lead: "Lead",
  cliente: "Cliente",
  inativo: "Inativo",
};

export const RECOVERY_REASON_LABEL: Record<RecoveryReason, string> = {
  CART_ABANDONED: "Carrinho abandonado",
  PIX_EXPIRED: "PIX expirado",
  BOLETO_GENERATED: "Boleto em aberto",
  PURCHASE_DECLINED: "Pagamento recusado",
};

export const RECOVERY_STATUS_LABEL: Record<RecoveryStatus, string> = {
  pendente: "Pendente",
  contatado: "Contatado",
  recuperado: "Recuperado",
  perdido: "Perdido",
};

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  ligacao: "Ligação",
  whatsapp: "WhatsApp",
  email: "E-mail",
  followup: "Follow-up",
};

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

export const OWNERS = ["Felipe", "Ana", "Bruno"] as const;
