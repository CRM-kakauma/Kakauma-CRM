import {
  AlertTriangle,
  Ban,
  BellRing,
  CheckCircle2,
  CreditCard,
  FileText,
  QrCode,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShoppingCart,
  Timer,
  Truck,
  UserCheck,
  UserPlus,
  UserX,
  XCircle,
  type LucideIcon,
} from "lucide-react";

export const EVENT_TYPES = [
  "PURCHASE_APPROVED",
  "PURCHASE_DECLINED",
  "REFUND",
  "CHARGEBACK",
  "CART_ABANDONED",
  "BOLETO_GENERATED",
  "PIX_GENERATED",
  "SUBSCRIPTION_CANCELLED",
  "SUBSCRIPTION_OVERDUE",
  "SUBSCRIPTION_RENEWED",
  "TRACKING_CREATED",
  "AFFILIATION_REQUESTED",
  "AFFILIATION_APPROVED",
  "AFFILIATION_DECLINED",
  "PIX_EXPIRED",
  "SUBSCRIPTION_EXPIRING",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

type Tone = "primary" | "accent" | "success" | "warning" | "danger" | "muted";

export const EVENT_META: Record<EventType, { label: string; icon: LucideIcon; tone: Tone }> = {
  PURCHASE_APPROVED: { label: "Compra aprovada", icon: CheckCircle2, tone: "success" },
  PURCHASE_DECLINED: { label: "Compra recusada", icon: XCircle, tone: "danger" },
  REFUND: { label: "Reembolso", icon: RotateCcw, tone: "warning" },
  CHARGEBACK: { label: "Chargeback", icon: ShieldAlert, tone: "danger" },
  CART_ABANDONED: { label: "Carrinho abandonado", icon: ShoppingCart, tone: "muted" },
  BOLETO_GENERATED: { label: "Boleto gerado", icon: FileText, tone: "primary" },
  PIX_GENERATED: { label: "Pix gerado", icon: QrCode, tone: "primary" },
  PIX_EXPIRED: { label: "Pix expirado", icon: Timer, tone: "warning" },
  SUBSCRIPTION_CANCELLED: { label: "Assinatura cancelada", icon: Ban, tone: "danger" },
  SUBSCRIPTION_OVERDUE: { label: "Assinatura em atraso", icon: AlertTriangle, tone: "warning" },
  SUBSCRIPTION_RENEWED: { label: "Assinatura renovada", icon: RefreshCw, tone: "success" },
  SUBSCRIPTION_EXPIRING: { label: "Assinatura a vencer", icon: BellRing, tone: "accent" },
  TRACKING_CREATED: { label: "Rastreio criado", icon: Truck, tone: "muted" },
  AFFILIATION_REQUESTED: { label: "Afiliação solicitada", icon: UserPlus, tone: "muted" },
  AFFILIATION_APPROVED: { label: "Afiliação aprovada", icon: UserCheck, tone: "muted" },
  AFFILIATION_DECLINED: { label: "Afiliação recusada", icon: UserX, tone: "muted" },
};

export const PAYMENT_EVENTS: EventType[] = [
  "CART_ABANDONED",
  "PIX_GENERATED",
  "PIX_EXPIRED",
  "BOLETO_GENERATED",
  "PURCHASE_APPROVED",
  "PURCHASE_DECLINED",
  "REFUND",
  "CHARGEBACK",
];

export const SUBSCRIPTION_EVENTS: EventType[] = [
  "SUBSCRIPTION_EXPIRING",
  "SUBSCRIPTION_RENEWED",
  "SUBSCRIPTION_OVERDUE",
  "SUBSCRIPTION_CANCELLED",
];

export const PAYMENT_METHOD_ICON = CreditCard;

export function eventMeta(type: string) {
  return (
    EVENT_META[type as EventType] ?? {
      label: type,
      icon: CreditCard,
      tone: "muted" as Tone,
    }
  );
}

export const TONE_CLASSES: Record<Tone, { bg: string; text: string; dot: string }> = {
  primary: { bg: "bg-primary-soft", text: "text-primary", dot: "bg-primary" },
  accent: { bg: "bg-accent-soft", text: "text-accent", dot: "bg-accent" },
  success: { bg: "bg-success-soft", text: "text-success", dot: "bg-success" },
  warning: { bg: "bg-warning-soft", text: "text-warning", dot: "bg-warning" },
  danger: { bg: "bg-danger-soft", text: "text-danger", dot: "bg-danger" },
  muted: { bg: "bg-muted", text: "text-muted-foreground", dot: "bg-muted-foreground" },
};
