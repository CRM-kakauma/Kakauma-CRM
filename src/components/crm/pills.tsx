import { cn } from "@/lib/utils";
import {
  CONTACT_STATUS_LABEL,
  DEAL_STAGE_LABEL,
  RECOVERY_REASON_LABEL,
  RECOVERY_STATUS_LABEL,
  TASK_PRIORITY_LABEL,
  type ContactStatus,
  type DealStage,
  type RecoveryReason,
  type RecoveryStatus,
  type TaskPriority,
} from "@/services/crm";

type Tone = "primary" | "success" | "warning" | "danger" | "muted";

const TONE: Record<Tone, string> = {
  primary: "bg-primary-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning-foreground",
  danger: "bg-danger-soft text-danger",
  muted: "bg-muted text-muted-foreground",
};

export function Pill({
  tone = "muted",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const CONTACT_TONE: Record<ContactStatus, Tone> = {
  lead: "primary",
  cliente: "success",
  inativo: "muted",
};
export function ContactStatusPill({ status }: { status: ContactStatus }) {
  return <Pill tone={CONTACT_TONE[status]}>{CONTACT_STATUS_LABEL[status]}</Pill>;
}

const STAGE_TONE: Record<DealStage, Tone> = {
  novo: "muted",
  contato: "primary",
  proposta: "primary",
  negociacao: "warning",
  ganho: "success",
  perdido: "danger",
};
export function StagePill({ stage }: { stage: DealStage }) {
  return <Pill tone={STAGE_TONE[stage]}>{DEAL_STAGE_LABEL[stage]}</Pill>;
}

const RECOVERY_TONE: Record<RecoveryStatus, Tone> = {
  pendente: "warning",
  contatado: "primary",
  recuperado: "success",
  perdido: "muted",
};
export function RecoveryStatusPill({ status }: { status: RecoveryStatus }) {
  return <Pill tone={RECOVERY_TONE[status]}>{RECOVERY_STATUS_LABEL[status]}</Pill>;
}

const REASON_TONE: Record<RecoveryReason, Tone> = {
  CART_ABANDONED: "muted",
  PIX_EXPIRED: "danger",
  BOLETO_GENERATED: "warning",
  PURCHASE_DECLINED: "danger",
};
export function ReasonPill({ reason }: { reason: RecoveryReason }) {
  return <Pill tone={REASON_TONE[reason]}>{RECOVERY_REASON_LABEL[reason]}</Pill>;
}

const PRIORITY_TONE: Record<TaskPriority, Tone> = {
  baixa: "muted",
  media: "primary",
  alta: "danger",
};
export function PriorityPill({ priority }: { priority: TaskPriority }) {
  return <Pill tone={PRIORITY_TONE[priority]}>{TASK_PRIORITY_LABEL[priority]}</Pill>;
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  return (
    <span
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary",
        className,
      )}
    >
      {initials}
    </span>
  );
}

/** Opens a WhatsApp chat for a Brazilian phone number, or null when the number is unusable. */
export function whatsappLink(phone: string | null, text?: string) {
  const digits = phone?.replace(/\D/g, "");
  if (!digits || digits.length < 10) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}
